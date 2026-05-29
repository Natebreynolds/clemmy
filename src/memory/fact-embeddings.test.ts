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

// eslint-disable-next-line import/first
const { resetMemoryDb, openMemoryDb } = await import('./db.js');
// eslint-disable-next-line import/first
const { rememberFact, updateFact, findSimilarFacts } = await import('./facts.js');
// eslint-disable-next-line import/first
const { embedMissingFacts, loadFactEmbeddings, isEmbeddingsEnabled } = await import('./embeddings.js');

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
    const data = body.input.map((text, index) => ({ embedding: topicVector(text), index }));
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

  const stats = await embedMissingFacts({ maxChunks: 50 });
  assert.equal(stats.candidateChunks, 1, 'stale fact is picked up again');
  assert.equal(stats.embedded, 1);
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
