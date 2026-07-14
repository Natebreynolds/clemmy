/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-fact-embed npx tsx --test src/memory/fact-embeddings.test.ts
 *
 * Covers the v0.5.x fact-embedding work: facts get the same Float32-BLOB
 * semantic treatment as vault chunks, so the conflict resolver's
 * findSimilarFacts surfaces paraphrased contradictions (no shared tokens)
 * that the old LIKE-token ranker missed. Network is stubbed via a fake
 * `fetch` that maps text to deterministic topic vectors — no real OpenAI
 * call, fully offline + deterministic (per the reproduce-locally-first
 * discipline).
 */
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-fact-embed';
process.env.CLEMENTINE_HOME = TEST_HOME;
// Env wins over the (absent) file vault in a fresh test home, so this
// flips isEmbeddingsEnabled() on.
process.env.OPENAI_API_KEY = 'sk-test-fact-embeddings';
// Determinism: cross-family judging is DEFAULT ON (2026-07-13); this suite tests
// fact-derivation precedence, not judge routing. Pin =off so the dev-machine
// ~/.claude credential fallback can't resolve a LIVE judge (see loop.test.ts note).
process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';

// eslint-disable-next-line import/first
const { resetMemoryDb, openMemoryDb } = await import('./db.js');
// eslint-disable-next-line import/first
const { rememberFact, updateFact, findSimilarFacts, findSimilarFactsScored, getFact, listActiveFacts } = await import('./facts.js');
// eslint-disable-next-line import/first
const { embedMissingFacts, loadFactEmbeddings, isEmbeddingsEnabled } = await import('./embeddings.js');
// eslint-disable-next-line import/first
const { consolidateActiveFacts, consolidateFact, triggerEmbedAtWrite, _resetEmbedAtWriteForTest } = await import('./reflection.js');

/**
 * Deterministic 4-dim "topic" embedding. Semantically-related text maps
 * to the same axis regardless of surface tokens — that's the whole point:
 * a "Wednesday" query lands near a "Tuesday meeting" fact even with zero
 * shared words.
 */
function topicVector(text: string): number[] {
  const t = text.toLowerCase();
  if (/meet|session|standup|sync|week|midweek|tuesday|wednesday|calendar|recurring|planning/.test(t)) {
    return [1, 0, 0, 0.05];
  }
  if (/api|key|secret|keychain|token|credential|password/.test(t)) {
    return [0, 1, 0, 0.05];
  }
  return [0, 0, 0, 1];
}

const realFetch = globalThis.fetch;
let fetchCalls = 0;

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  resetMemoryDb();
  openMemoryDb();
  fetchCalls = 0;
  // Stub the OpenAI embeddings endpoint.
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    fetchCalls++;
    const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
    // Pad the 4-dim topic vector to the OpenAI provider's declared dim (1536)
    // so the stored dim matches provider.dim — otherwise the re-embed-on-
    // provider-change guard (WS3) treats every row as stale. Trailing zeros
    // don't change cosine, so the semantic-similarity assertions are unaffected.
    const data = body.input.map((text, index) => {
      const v = topicVector(text);
      while (v.length < 1536) v.push(0);
      return { embedding: v, index };
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data, model: 'text-embedding-3-small' }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('embeddings are enabled when OPENAI_API_KEY is set', () => {
  assert.equal(isEmbeddingsEnabled(), true);
});

test('embedMissingFacts populates fact_embeddings and is idempotent', async () => {
  rememberFact({ kind: 'user', content: 'Standing planning session is locked to the start of the week.' });
  rememberFact({ kind: 'reference', content: 'The OpenAI API key lives in the macOS keychain.' });

  const first = await embedMissingFacts({ maxChunks: 50 });
  assert.equal(first.embedded, 2, 'both facts embedded on first pass');

  const db = openMemoryDb();
  const count = (db.prepare('SELECT COUNT(*) AS c FROM fact_embeddings').get() as { c: number }).c;
  assert.equal(count, 2, 'two embedding rows stored');

  // Rerun: nothing new to embed.
  const second = await embedMissingFacts({ maxChunks: 50 });
  assert.equal(second.candidateChunks, 0, 'rerun finds no missing facts');
  assert.equal(second.embedded, 0);
});

test('updateFact content change re-embeds on the next backfill (stale hash)', async () => {
  const fact = rememberFact({ kind: 'user', content: 'Weekly sync is on Tuesday.' });
  await embedMissingFacts({ maxChunks: 50 });

  // Change the content → content_hash changes → embedding is now stale.
  updateFact(fact.id, { content: 'Weekly sync moved to a recurring calendar slot.' });
  assert.equal(loadFactEmbeddings([fact.id]).size, 0, 'stale content-hash fact vector is ignored before re-embed');

  const stats = await embedMissingFacts({ maxChunks: 50 });
  assert.equal(stats.candidateChunks, 1, 'stale fact is picked up again');
  assert.equal(stats.embedded, 1);
  assert.equal(loadFactEmbeddings([fact.id]).size, 1, 'fresh content-hash fact vector is visible after re-embed');
});

test('loadFactEmbeddings returns stored vectors by id', async () => {
  const f = rememberFact({ kind: 'user', content: 'Recurring planning meeting each week.' });
  await embedMissingFacts({ maxChunks: 50 });
  const map = loadFactEmbeddings([f.id]);
  assert.equal(map.size, 1);
  assert.ok(map.get(f.id) instanceof Float32Array);
});

test('findSimilarFacts (semantic) surfaces a paraphrased match with NO shared tokens', async () => {
  // Stored fact and the query share the "meetings" topic but no surface
  // tokens — the old LIKE ranker would miss this entirely.
  const meetingFact = rememberFact({
    kind: 'user',
    content: 'Standing planning session is locked to the start of the week.',
  });
  const secretFact = rememberFact({
    kind: 'reference',
    content: 'The API credential is stored in the keychain.',
  });
  await embedMissingFacts({ maxChunks: 50 });

  const query = 'Move standup to midweek please.';
  // Sanity: the query shares no ≥3-char content tokens with the meeting fact.
  const queryTokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const meetingLc = meetingFact.content.toLowerCase();
  assert.ok(
    !queryTokens.some((tok) => meetingLc.includes(tok)),
    'precondition: query has no literal token overlap with the meeting fact',
  );

  const similar = await findSimilarFacts(query, { kind: 'user', topK: 5 });
  assert.ok(similar.length >= 1, 'semantic recall returned a candidate');
  assert.equal(similar[0].id, meetingFact.id, 'meeting fact ranks first by cosine');
  assert.ok(!similar.some((f) => f.id === secretFact.id) || similar[0].id !== secretFact.id,
    'unrelated secret fact does not outrank the topical match');
});

test('findSimilarFacts skips query embedding when the fact pool has no stored vectors yet', async () => {
  rememberFact({ kind: 'user', content: 'Nathan prefers concise replies in markdown.' });

  const similar = await findSimilarFacts('keep replies concise and in markdown', { kind: 'user', topK: 5 });
  assert.ok(similar.length >= 1, 'LIKE fallback returned a candidate');
  assert.equal(fetchCalls, 0, 'no embedding call before stored fact vectors exist');
});

test('findSimilarFacts falls back to LIKE when embeddings are disabled', async () => {
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(isEmbeddingsEnabled(), false);
    rememberFact({ kind: 'user', content: 'Nathan prefers concise replies in markdown.' });
    rememberFact({ kind: 'user', content: 'The deployment runs on a nightly cron.' });

    // Shares the "markdown" + "concise" tokens → LIKE ranker finds it.
    const similar = await findSimilarFacts('keep replies concise and in markdown', { kind: 'user', topK: 5 });
    assert.ok(similar.length >= 1, 'LIKE fallback returned a candidate');
    assert.ok(/markdown/i.test(similar[0].content), 'token-overlap match ranked first');
    assert.equal(fetchCalls, 0, 'no embedding network call when disabled');
  } finally {
    process.env.OPENAI_API_KEY = 'sk-test-fact-embeddings';
  }
});

// ─────────────────────────────────────────────────────────────────
// Tier A1/A3/B1 — scored similarity, dedup, novelty fast-path.
// All use the deterministic topicVector fetch stub above.
// ─────────────────────────────────────────────────────────────────

test('findSimilarFactsScored returns numeric cosine scores on the semantic path, desc-ordered', async () => {
  const meeting = rememberFact({ kind: 'user', content: 'Standing planning session at the start of the week.' });
  rememberFact({ kind: 'user', content: 'The API credential lives in the keychain.' });
  await embedMissingFacts({ maxChunks: 50 });

  const scored = await findSimilarFactsScored('move the weekly sync to midweek', { kind: 'user', topK: 5 });
  assert.ok(scored.length >= 1);
  assert.equal(typeof scored[0].sim, 'number', 'semantic path yields a cosine score');
  assert.equal(scored[0].fact.id, meeting.id, 'the topical (meeting) fact ranks first');
  // Scores are sorted descending.
  for (let i = 1; i < scored.length; i++) {
    assert.ok((scored[i - 1].sim ?? 0) >= (scored[i].sim ?? 0), 'cosine order is descending');
  }
});

test('consolidateActiveFacts folds near-identical facts and keeps one, leaving unrelated facts', async () => {
  // Two "meeting"-topic facts map to the SAME topic vector → cosine 1.0 → fold.
  const a = rememberFact({ kind: 'user', content: 'Weekly planning session happens midweek.' });
  const b = rememberFact({ kind: 'user', content: 'Recurring sync meeting on the calendar each week.' });
  const unrelated = rememberFact({ kind: 'reference', content: 'The secret token is in the keychain.' });
  await embedMissingFacts({ maxChunks: 50 });

  const result = await consolidateActiveFacts({ simThreshold: 0.95 });
  assert.equal(result.merged, 1, 'exactly one of the two near-identical facts is folded');

  const aActive = getFact(a.id)?.active;
  const bActive = getFact(b.id)?.active;
  assert.ok(aActive !== bActive, 'one of the pair stays active, the other is soft-deleted');
  assert.equal(getFact(unrelated.id)?.active, true, 'the unrelated fact is untouched');
});

test('consolidateActiveFacts is a no-op without embeddings (sim=null path)', async () => {
  delete process.env.OPENAI_API_KEY;
  try {
    rememberFact({ kind: 'user', content: 'Identical-ish note one.' });
    rememberFact({ kind: 'user', content: 'Identical-ish note two.' });
    const result = await consolidateActiveFacts({ simThreshold: 0.95 });
    assert.equal(result.merged, 0, 'no folding without cosine scores');
  } finally {
    process.env.OPENAI_API_KEY = 'sk-test-fact-embeddings';
  }
});

test('ground-truth-wins: an authoritative candidate supersedes a stale low-trust fact (no resolver)', async () => {
  // Stale, low-trust inference about the same topic (cosine ~1.0 vs the
  // authoritative candidate). trust 0.6 = generic derived.
  const stale = rememberFact({
    kind: 'project',
    content: 'Standing planning session is loosely sometime midweek.',
    derivedFrom: { sessionId: 's1', tool: 'firecrawl' }, // → trust 0.6
  });
  await embedMissingFacts({ maxChunks: 50 });

  // Authoritative system-of-record candidate (trust 0.9) that conflicts.
  const outcome = await consolidateFact(
    {
      kind: 'project',
      text: 'Recurring planning meeting is locked to Monday 9am each week.',
      trustLevel: 0.9,
      sourceApp: 'Google Calendar',
    },
    { sessionId: 's2' },
  );

  assert.equal(outcome.updated, 1, 'authoritative candidate UPDATEs the stale fact');
  assert.equal(outcome.written, 0, 'no new duplicate row');
  const after = getFact(stale.id);
  assert.match(after?.content ?? '', /Monday 9am/, 'stale content superseded by ground truth');
  assert.equal(after?.trustLevel, 0.9, 'trust lifted to authoritative');
  assert.equal(after?.sourceApp, 'Google Calendar', 'source app recorded on supersede');
});

test('ground-truth-wins does NOT fire for a user restatement (no sourceApp) — distinct derived fact is preserved', async () => {
  // Regression lock: the deterministic ground-truth overwrite must be gated
  // on the system-of-record marker (candidate.sourceApp), NOT merely on
  // trust ≥ 0.85. The default-on auto-capture path passes user statements at
  // trust 1.0 (which clears 0.85) but never sets sourceApp. Without the gate,
  // a user restatement ≥0.8 cosine-similar to a DERIVED fact would silently
  // overwrite it in place; with the gate it falls through to the LLM resolver
  // (stubbed-absent here → conservative ADD), so the distinct derived fact
  // survives. Same-topic vectors → cosine ~1.0 (well past the 0.8 bar that
  // the old, ungated code would have tripped).
  const derived = rememberFact({
    kind: 'project',
    content: 'Standing planning session is loosely sometime midweek.',
    derivedFrom: { sessionId: 's1', tool: 'firecrawl' }, // → trust 0.6
  });
  await embedMissingFacts({ maxChunks: 50 });

  // User restatement: trust 1.0, NO sourceApp. Same topic → high cosine.
  const outcome = await consolidateFact(
    {
      kind: 'project',
      text: 'Recurring planning meeting happens weekly.',
      trustLevel: 1.0,
      // sourceApp intentionally omitted — this is a user statement, not a
      // system of record.
    },
    { sessionId: 's2' },
  );

  assert.equal(outcome.updated, 0, 'no deterministic ground-truth overwrite for a user restatement');
  const after = getFact(derived.id);
  assert.equal(after?.active, true, 'the derived fact is not deleted');
  assert.match(after?.content ?? '', /midweek/, 'derived content is preserved (not clobbered in place)');
  assert.ok(after?.sourceApp == null, 'no spurious sourceApp written onto the derived fact');
});

// ─────────────────────────────────────────────────────────────────
// M1 — embed-at-write: a just-written fact gets its vector promptly
// (newest-first), instead of waiting for the ~2-min nightly backfill, so
// same-session semantic recall sees what you just told it.
// ─────────────────────────────────────────────────────────────────

test('embedMissingFacts newestFirst embeds the most-recent facts first', async () => {
  const oldest = rememberFact({ kind: 'user', content: 'Oldest planning note about the week.' });
  rememberFact({ kind: 'user', content: 'Middle note about the keychain credential.' });
  const newest = rememberFact({ kind: 'user', content: 'Newest note about the recurring sync.' });

  // Cap of 1 with newestFirst → only the highest-id (newest) fact is embedded.
  const stats = await embedMissingFacts({ maxChunks: 1, newestFirst: true });
  assert.equal(stats.embedded, 1, 'one fact embedded under the cap');
  assert.equal(loadFactEmbeddings([newest.id]).size, 1, 'newest fact got its vector');
  assert.equal(loadFactEmbeddings([oldest.id]).size, 0, 'oldest fact NOT embedded yet (lost the cap to newest)');

  // Default (oldest-first) order embeds the oldest of the remaining.
  const stats2 = await embedMissingFacts({ maxChunks: 1, newestFirst: false });
  assert.equal(stats2.embedded, 1);
  assert.equal(loadFactEmbeddings([oldest.id]).size, 1, 'oldest fact embedded on the default-order pass');
});

test('triggerEmbedAtWrite embeds a just-written fact promptly', async () => {
  _resetEmbedAtWriteForTest();
  const f = rememberFact({ kind: 'user', content: 'Nathan prefers oat milk in his coffee.' });
  assert.equal(loadFactEmbeddings([f.id]).size, 0, 'no vector immediately after write');

  await triggerEmbedAtWrite();
  assert.equal(loadFactEmbeddings([f.id]).size, 1, 'embed-at-write gave the new fact a vector right away');
});

test('triggerEmbedAtWrite is a no-op when the kill-switch is off', async () => {
  _resetEmbedAtWriteForTest();
  process.env.CLEMMY_EMBED_AT_WRITE = 'off';
  try {
    const f = rememberFact({ kind: 'user', content: 'A fact written with embed-at-write disabled.' });
    await triggerEmbedAtWrite();
    assert.equal(loadFactEmbeddings([f.id]).size, 0, 'no embedding when CLEMMY_EMBED_AT_WRITE=off');
  } finally {
    delete process.env.CLEMMY_EMBED_AT_WRITE;
  }
});

test('triggerEmbedAtWrite is a no-op when embeddings are disabled', async () => {
  _resetEmbedAtWriteForTest();
  delete process.env.OPENAI_API_KEY;
  try {
    const f = rememberFact({ kind: 'user', content: 'A fact written with embeddings disabled.' });
    await triggerEmbedAtWrite();
    assert.equal(loadFactEmbeddings([f.id]).size, 0, 'no embedding when embeddings are disabled');
    assert.equal(fetchCalls, 0, 'no network call');
  } finally {
    process.env.OPENAI_API_KEY = 'sk-test-fact-embeddings';
  }
});

test('consolidateFact (novelty fast-path) auto-embeds the new fact via embed-at-write', async () => {
  _resetEmbedAtWriteForTest();
  // Seed a "meeting"-topic pool + embed it so the candidate's cosine is low.
  rememberFact({ kind: 'reference', content: 'Standing planning session midweek.' });
  await embedMissingFacts({ maxChunks: 50 });

  // A clearly-novel ("secret" topic) candidate → novelty fast-path ADD (no resolver).
  const outcome = await consolidateFact(
    { kind: 'reference', text: 'The deploy webhook secret is rotated monthly.', trustLevel: 1.0 },
    {},
    { noveltyFastPathSim: 0.6 },
  );
  assert.equal(outcome.written, 1, 'novel candidate ADDed');

  // consolidateFact fires embed-at-write fire-and-forget (which takes the
  // running guard). Reset the guard, then await a clean pass so the assertion
  // is deterministic instead of racing the background trigger. embedMissingFacts
  // is idempotent, so a concurrent background pass is harmless.
  _resetEmbedAtWriteForTest();
  await triggerEmbedAtWrite();
  const newest = listActiveFacts({ kind: 'reference', limit: 100 })
    .sort((a, b) => b.id - a.id)[0];
  assert.match(newest.content, /webhook secret/, 'the new fact is the most recent');
  assert.equal(loadFactEmbeddings([newest.id]).size, 1, 'the just-consolidated fact has a vector same-session');
});

test('consolidateFact novelty fast-path ADDs a clearly-novel candidate without the resolver', async () => {
  // Existing pool is all "meeting" topic; the candidate is "secret" topic →
  // cosine ≈ 0.05, well below the 0.6 bar → fast-path ADD (no resolver call,
  // which would otherwise need a real model and is not stubbed here).
  rememberFact({ kind: 'reference', content: 'Standing planning session midweek.' });
  await embedMissingFacts({ maxChunks: 50 });
  const before = listActiveFacts({ kind: 'reference', limit: 100 }).length;

  const outcome = await consolidateFact(
    { kind: 'reference', text: 'The API secret token is stored in the keychain.', trustLevel: 1.0 },
    {},
    { noveltyFastPathSim: 0.6 },
  );
  assert.equal(outcome.written, 1, 'novel candidate is ADDed');
  assert.equal(outcome.updated, 0);
  assert.equal(outcome.deleted, 0);
  const after = listActiveFacts({ kind: 'reference', limit: 100 }).length;
  assert.equal(after, before + 1, 'exactly one new fact row was added');
});
