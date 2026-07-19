/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-facts npx tsx --test src/memory/facts.test.ts
 *
 * Tests use an isolated temp CLEMENTINE_HOME so they don't pollute the
 * user's real vault.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

// CLEMENTINE_HOME must be set BEFORE importing config/db modules.
// node:test runs before/beforeEach after imports, so we set the env
// var at module-init time here.
const TEST_HOME = '/tmp/clemmy-test-facts';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const { resetMemoryDb, openMemoryDb } = await import('./db.js');
// eslint-disable-next-line import/first
const {
  decayAndEvictFacts,
  demoteRolledUpSource,
  findSimilarFactsScored,
  forgetFact,
  getFact,
  lexicalRelevance,
  listActiveFacts,
  listAllFacts,
  listPinnedFacts,
  reactivateFact,
  rememberFact,
  renderFactsForInstructions,
  reviewStandingInstructions,
  searchFacts,
  searchFactsByText,
  setFactPinned,
  setTurnQueryVector,
  clearTurnQueryVector,
  touchFactAccess,
  recordFactImpression,
} = await import('./facts.js');
const { vectorToBuffer, _setEmbeddingProviderForTest } = await import('./embeddings.js');

const DAY_MS = 24 * 60 * 60 * 1000;

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  resetMemoryDb();
  _setEmbeddingProviderForTest(undefined);
  // Touch DB so subsequent ops succeed.
  openMemoryDb();
});

function factContentHash(id: number): string {
  const row = openMemoryDb().prepare('SELECT content_hash FROM consolidated_facts WHERE id = ?').get(id) as { content_hash: string };
  return row.content_hash;
}

test('searchFactsByText: a freshly-remembered fact is the top hit despite a stop-word-heavy query', () => {
  // The fresh-fact recall fix: the per-turn primer searches consolidated_facts
  // lexically. A query full of stop-words ("what is my ... just the ...") must
  // not drown the relevant fact (the bug: common words matched thousands of
  // facts and evicted it before ranking). Stop-word filtering + recency order.
  for (let i = 0; i < 30; i++) {
    rememberFact({ kind: 'user', content: `Just the noise: Alexander did thing number ${i} for the project.` });
  }
  rememberFact({ kind: 'user', content: 'Alex\'s ship marker is VECTOR-1241.' });
  const hits = searchFactsByText('What is my ship marker? Just the marker.', 5);
  assert.ok(hits.length > 0, 'returns hits');
  assert.match(hits[0].content, /VECTOR-1241/, 'the relevant fresh fact ranks first');
});

test('searchFactsByText: a query with only stop-words returns nothing (no false matches)', () => {
  rememberFact({ kind: 'user', content: 'Alexander prefers concise replies.' });
  assert.deepEqual(searchFactsByText('what is the just', 5), []);
});

test('rememberFact inserts a new row', () => {
  const fact = rememberFact({ kind: 'user', content: 'Alexander prefers concise replies.' });
  assert.equal(fact.kind, 'user');
  assert.equal(fact.content, 'Alexander prefers concise replies.');
  assert.equal(fact.active, true);
  assert.ok(fact.id > 0);
  assert.ok(fact.score >= 1);
});

test('rememberFact dedups on normalized content (same kind)', () => {
  const a = rememberFact({ kind: 'user', content: 'Alexander likes action.' });
  const b = rememberFact({ kind: 'user', content: 'Alexander   likes    action.' });  // extra whitespace
  const c = rememberFact({ kind: 'user', content: 'ALEXANDER LIKES ACTION.' });     // different case
  assert.equal(a.id, b.id, 'whitespace-normalized dedup');
  assert.equal(a.id, c.id, 'case-normalized dedup');
  // Score bumped by 0.1 each repeat.
  assert.ok(c.score > a.score, `score should bump (${a.score} → ${c.score})`);
});

test('different kinds with same content are distinct', () => {
  const u = rememberFact({ kind: 'user', content: 'Use markdown for everything.' });
  const f = rememberFact({ kind: 'feedback', content: 'Use markdown for everything.' });
  assert.notEqual(u.id, f.id);
});

test('forgetFact soft-deletes by default', () => {
  const fact = rememberFact({ kind: 'project', content: 'Clemmy is in beta.' });
  assert.equal(forgetFact(fact.id), true);

  const reloaded = getFact(fact.id);
  assert.ok(reloaded, 'row survives soft delete');
  assert.equal(reloaded!.active, false);

  // Not in active list.
  assert.equal(listActiveFacts({ limit: 100 }).find((f) => f.id === fact.id), undefined);
  // Still in full list.
  assert.ok(listAllFacts(100).find((f) => f.id === fact.id), 'still in listAllFacts');
});

test('forgetFact hard delete drops the row', () => {
  const fact = rememberFact({ kind: 'reference', content: 'https://example.com' });
  assert.equal(forgetFact(fact.id, { hard: true }), true);
  assert.equal(getFact(fact.id), null);
  assert.equal(forgetFact(fact.id), false, 'second delete returns false');
});

test('renderFactsForInstructions groups by kind in fixed order', () => {
  rememberFact({ kind: 'feedback', content: 'Cite file:line when relevant.' });
  rememberFact({ kind: 'user', content: 'Alexander is the project owner.' });
  rememberFact({ kind: 'project', content: 'Clemmy is on the OpenAI Agents SDK.' });
  rememberFact({ kind: 'reference', content: 'See https://example.com/docs' });

  const rendered = renderFactsForInstructions();
  const userIdx = rendered.indexOf('About the user');
  const projectIdx = rendered.indexOf('Project context');
  const feedbackIdx = rendered.indexOf('Standing feedback');
  const referenceIdx = rendered.indexOf('References');

  assert.ok(userIdx >= 0 && projectIdx > userIdx, 'user before project');
  assert.ok(projectIdx < feedbackIdx, 'project before feedback');
  assert.ok(feedbackIdx < referenceIdx, 'feedback before reference');
});

test('renderFactsForInstructions returns empty string when no active facts', () => {
  assert.equal(renderFactsForInstructions(), '');
});

test('listActiveFacts orders by score descending then updatedAt desc', () => {
  const a = rememberFact({ kind: 'user', content: 'Fact A.' });
  const b = rememberFact({ kind: 'user', content: 'Fact B.' });
  // Bump A's score by re-remembering it.
  rememberFact({ kind: 'user', content: 'Fact A.' });

  const active = listActiveFacts({ limit: 10 });
  // A should now be first (higher score).
  assert.equal(active[0].id, a.id, `expected A first, got order: ${active.map((f) => f.id).join(',')}`);
  assert.equal(active[1].id, b.id);
});

// ---- Move 1: objective-scoped recall ----

test('lexicalRelevance: token overlap normalized by fact tokens, stopwords ignored', () => {
  // All significant fact tokens appear in the objective → 1.0
  assert.equal(lexicalRelevance('legal contract review for client', 'legal contract'), 1);
  // No overlap → 0
  assert.equal(lexicalRelevance('legal contract review', 'home services plumbing'), 0);
  // Empty objective → 0 (no scoping signal)
  assert.equal(lexicalRelevance('', 'legal contract'), 0);
  // Stopwords don't manufacture relevance
  assert.equal(lexicalRelevance('the and for with', 'the and for with'), 0);
});

test('characterization: no objective → ranking identical to plain Stanford order', () => {
  // Seed a mix; capture the global order, then assert passing undefined
  // objective yields byte-identical output (no-regression guarantee).
  rememberFact({ kind: 'project', content: 'Home services plumbing lead funnel.', importance: 9 });
  rememberFact({ kind: 'user', content: 'Alexander runs a legal practice.', importance: 6 });
  rememberFact({ kind: 'feedback', content: 'Prefer concise replies.', importance: 5 });

  const baseline = renderFactsForInstructions(12, 1600);
  const withUndefined = renderFactsForInstructions(12, 1600, undefined);
  const withEmpty = renderFactsForInstructions(12, 1600, '   ');
  assert.equal(withUndefined, baseline, 'undefined objective must not change output');
  assert.equal(withEmpty, baseline, 'blank objective must not change output');
});

test('leak repro: an off-objective high-importance fact is demoted out of the slots', () => {
  // The incident: legal session, but a high-importance home-services
  // fact leaks into the prompt. With scoping, legal facts win the slots.
  const home = rememberFact({
    kind: 'project',
    content: 'Home services: emphasize plumbing and HVAC emergency response.',
    importance: 10,
  });
  const legal1 = rememberFact({
    kind: 'project',
    content: 'Legal practice: focus on contract litigation and compliance.',
    importance: 5,
  });
  const legal2 = rememberFact({
    kind: 'user',
    content: 'Client legal matters require careful contract review.',
    importance: 5,
  });

  // Only one slot available → without scoping the high-importance home
  // fact wins; with a legal objective, a legal fact must win instead.
  const objective = 'Draft legal contract emails for the litigation client';

  const unscoped = listActiveFacts({ limit: 1, ranking: 'stanford' });
  assert.equal(unscoped[0].id, home.id, 'baseline: home-services fact dominates by importance');

  const scoped = listActiveFacts({ limit: 1, ranking: 'stanford', objective });
  assert.ok(
    scoped[0].id === legal1.id || scoped[0].id === legal2.id,
    `scoped recall must surface a legal fact, got #${scoped[0].id} (home=${home.id})`,
  );

  // And the home-services fact must not appear in a small scoped window
  // alongside the two on-objective facts.
  const scopedTop2 = listActiveFacts({ limit: 2, ranking: 'stanford', objective });
  assert.ok(
    !scopedTop2.some((f) => f.id === home.id),
    'off-objective fact must be demoted below on-objective facts',
  );
});

// ---- Move 4: review standing instructions for in-loop pruning ----

test('reviewStandingInstructions: returns ids + provenance, least-relevant first', () => {
  const home = rememberFact({ kind: 'project', content: 'Home services: emphasize plumbing and HVAC.', importance: 9 });
  const legal = rememberFact({ kind: 'project', content: 'Legal practice: contract litigation focus.', importance: 5 });

  const review = reviewStandingInstructions('Draft legal contract emails for the client');
  // Every item carries an id and a source hint the user can act on.
  for (const item of review) {
    assert.ok(item.id > 0);
    assert.equal(typeof item.sourceHint, 'string');
    assert.ok(item.sourceHint.length > 0);
  }
  const ids = review.map((r) => r.id);
  assert.ok(ids.includes(home.id) && ids.includes(legal.id), 'both standing instructions are listed');
  // Least-relevant first: the off-objective home-services rule sorts
  // ahead of the on-objective legal one, so a stale rule is easy to spot.
  assert.ok(
    ids.indexOf(home.id) < ids.indexOf(legal.id),
    `off-objective instruction should sort first: ${ids.join(',')}`,
  );
});

test('reviewStandingInstructions: no objective → relevance 0, still lists with sources', () => {
  rememberFact({ kind: 'feedback', content: 'Always confirm before sending external emails.' });
  const review = reviewStandingInstructions(undefined);
  assert.ok(review.length >= 1);
  assert.ok(review.every((r) => r.relevance === 0));
});

test('reviewStandingInstructions: excludes soft-deleted (forgotten) facts', () => {
  const stale = rememberFact({ kind: 'project', content: 'Old home-services campaign rule.', importance: 8 });
  forgetFact(stale.id);
  const review = reviewStandingInstructions('legal work');
  assert.ok(!review.some((r) => r.id === stale.id), 'forgotten fact must not resurface in review');
});

// ---- #5: pinned standing instructions are always injected ----

test('a pinned instruction is always rendered even when out-ranked by many newer facts', () => {
  const pinnedFact = rememberFact({ kind: 'feedback', content: 'Never email clients on Fridays.' });
  assert.equal(setFactPinned(pinnedFact.id, true), true);

  // Flood the store with higher-recency facts that would fill the top-N.
  for (let i = 0; i < 20; i += 1) {
    rememberFact({ kind: 'project', content: `Unrelated recent project note number ${i} about scraping.` });
  }

  const rendered = renderFactsForInstructions(5, 4000);
  assert.match(rendered, /Standing preferences/);
  assert.match(rendered, /Never email clients on Fridays/);
});

test('policy overflow is explicit and never claims omitted preferences were applied', () => {
  const pins = [
    'Only ever add events to the Example Coaching calendar, never a personal calendar.',
    'Default sending identity is alex.chen@corp.example for all outbound email.',
    'Never email clients on Fridays or over the weekend without explicit approval.',
    'Always quote prices in USD and state the engagement scope before any number.',
  ];
  for (const content of pins) setFactPinned(rememberFact({ kind: 'feedback', content }).id, true);
  for (let i = 0; i < 6; i += 1) rememberFact({ kind: 'project', content: `Scored project note ${i} about scraping pipelines.` });

  // A cap far smaller than the policy set. The renderer may summarize, but it
  // must report exact coverage instead of silently claiming every pin applied.
  const rendered = renderFactsForInstructions(10, 200);
  assert.match(rendered, /Policy manifest: \d+\/4 shown/);
  assert.match(rendered, /more standing preferences? available/);
});

test('message-scoped recall surfaces a query-relevant fact that global recall buries (the "MY accounts" fix)', () => {
  // The fact that should govern "pull MY priority-account accounts".
  rememberFact({ kind: 'project', content: 'My priority-account accounts are Salesforce accounts owned by Alexander Chen where Priority_Account__c is true.' });
  // Flood with newer, unrelated facts so a small global top-N excludes it.
  for (let i = 0; i < 15; i += 1) {
    rememberFact({ kind: 'project', content: `Unrelated recent note ${i} about calendar scheduling and meeting prep.` });
  }

  // Global recall (no objective): the owner-filter fact is buried.
  const global = renderFactsForInstructions(3, 4000);
  // Message-scoped recall: the query surfaces it.
  const scoped = renderFactsForInstructions(3, 4000, 'pull my priority account accounts');
  assert.match(scoped, /owned by Alexander Chen/, 'message-scoped recall must surface the owner-filter fact');
  assert.ok(
    !/owned by Alexander Chen/.test(global) || /owned by Alexander Chen/.test(scoped),
    'scoped recall should rank the relevant fact at least as well as global',
  );
});

test('listPinnedFacts returns only active pinned facts; unpin removes it', () => {
  const f = rememberFact({ kind: 'user', content: 'Always CC Dana on external email.' });
  setFactPinned(f.id, true);
  assert.ok(listPinnedFacts().some((p) => p.id === f.id));
  assert.equal(setFactPinned(f.id, false), true);
  assert.ok(!listPinnedFacts().some((p) => p.id === f.id));
});

test('rememberFact auto-pins constraint facts; other kinds stay unpinned', () => {
  const constraint = rememberFact({ kind: 'constraint', content: 'Acme sends must use the corp.example connection.' });
  assert.equal(constraint.pinned, true, 'a constraint is born pinned (always-rendered)');
  const plain = rememberFact({ kind: 'user', content: 'Alexander reviews pipeline on Mondays.' });
  assert.equal(plain.pinned, false, 'non-constraint kinds are unaffected');
});

test('constraint dedup-update keeps pinned', () => {
  const first = rememberFact({ kind: 'constraint', content: 'Never email the staging list.' });
  const again = rememberFact({ kind: 'constraint', content: 'Never email the staging list.' });
  assert.equal(again.id, first.id, 'dedup hits the same row');
  assert.equal(again.pinned, true, 'dedup-update path preserves the pin');
});

test('pinned fact is not double-rendered (excluded from the scored section)', () => {
  const f = rememberFact({ kind: 'feedback', content: 'Quote prices in USD only.' });
  setFactPinned(f.id, true);
  const rendered = renderFactsForInstructions(10, 4000);
  const occurrences = rendered.split('Quote prices in USD only').length - 1;
  assert.equal(occurrences, 1, 'pinned fact should appear exactly once');
});

// ─────────────────────────────────────────────────────────────────
// Tier A2 — decay / eviction (forgetting). No embeddings needed.
// ─────────────────────────────────────────────────────────────────

test('decayAndEvictFacts soft-deletes idle, low-importance, unpinned facts', () => {
  const stale = rememberFact({ kind: 'project', content: 'Old throwaway scratch note about a one-off task.', importance: 2 });
  const future = Date.now() + 90 * DAY_MS; // make `stale` look 90 days idle
  const result = decayAndEvictFacts({ nowMs: future });
  assert.ok(result.deactivated >= 1, 'at least the stale low-importance fact is evicted');
  assert.ok(result.ids.includes(stale.id), 'the stale fact id is in the eviction set');
  const after = getFact(stale.id);
  assert.equal(after?.active, false, 'stale fact is soft-deleted (active=0)');
});

test('decayAndEvictFacts (binary kill-switch path) protects pinned, high-importance, and default-importance facts', () => {
  // The binary path (importanceAware:false, the CLEMMY_DECAY_IMPORTANCE_AWARE=off
  // kill-switch) only ever evicts importance<=4: pinned + high-importance + the
  // 5.0-default tail are all immortal here. (The default path is importance-aware
  // now — see the importance-aware tests below — which DOES retire the idle tail.)
  const pinnedLow = rememberFact({ kind: 'feedback', content: 'Always CC the partner on client emails.', importance: 2 });
  setFactPinned(pinnedLow.id, true);
  const important = rememberFact({ kind: 'project', content: 'Flagship Q3 launch is the top priority.', importance: 9 });
  const defaultImp = rememberFact({ kind: 'user', content: 'Alexander works in the Pacific timezone.' }); // importance defaults to 5.0

  const future = Date.now() + 120 * DAY_MS;
  decayAndEvictFacts({ nowMs: future, importanceAware: false });

  assert.equal(getFact(pinnedLow.id)?.active, true, 'pinned fact survives regardless of importance/idle');
  assert.equal(getFact(important.id)?.active, true, 'high-importance fact survives');
  assert.equal(getFact(defaultImp.id)?.active, true, 'default-importance (5.0) fact is above the ceil (4) and survives');
});

test('demoteRolledUpSource clamps importance down and makes a rolled-up atom decay sooner than a peer', () => {
  // The synthesis→decay composition: a rolled-up atom (importance clamped to 3)
  // becomes decay-eligible at 50 days idle, while an un-demoted importance-5 peer
  // survives (imp3 threshold ≈ 48d < 50d < imp5 threshold 60d).
  const demoted = rememberFact({ kind: 'project', content: 'Rolled-up granular atom alpha.', importance: 5, trustLevel: 0.6 });
  assert.equal(demoteRolledUpSource(demoted.id), true, 'demotion clamps importance down');
  assert.equal(getFact(demoted.id)?.importance, 3, 'importance clamped to 3');
  assert.equal(demoteRolledUpSource(demoted.id), false, 'idempotent — already at/below target');
  const keep = rememberFact({ kind: 'project', content: 'Independent importance-5 fact beta.', importance: 5, trustLevel: 0.6 });

  const future = Date.now() + 50 * DAY_MS;
  const decayed = new Set(decayAndEvictFacts({ nowMs: future }).ids); // importance-aware default
  assert.ok(decayed.has(demoted.id), 'demoted (imp3) atom decays at 50d idle');
  assert.ok(!decayed.has(keep.id), 'un-demoted imp5 peer survives at 50d idle');
});

test('demoteRolledUpSource never demotes a pinned fact', () => {
  const f = rememberFact({ kind: 'project', content: 'Pinned source that got rolled up.', importance: 6, trustLevel: 0.6 });
  setFactPinned(f.id, true);
  assert.equal(demoteRolledUpSource(f.id), false, 'pinned fact is not demoted');
  assert.equal(getFact(f.id)?.importance, 6, 'importance unchanged');
});

test('decayAndEvictFacts does not evict recently-accessed facts', () => {
  const recent = rememberFact({ kind: 'project', content: 'Note touched just now, low importance.', importance: 2 });
  // No future nowMs → "now" is the present, so the fact is not idle.
  const result = decayAndEvictFacts();
  assert.ok(!result.ids.includes(recent.id), 'a fresh fact is not idle and is not evicted');
  assert.equal(getFact(recent.id)?.active, true);
});

test('decayAndEvictFacts honors the maxDeactivate cap', () => {
  for (let i = 0; i < 5; i++) {
    rememberFact({ kind: 'project', content: `Stale low-value note number ${i}.`, importance: 1 });
  }
  const future = Date.now() + 90 * DAY_MS;
  const result = decayAndEvictFacts({ nowMs: future, maxDeactivate: 2 });
  assert.equal(result.deactivated, 2, 'never soft-deletes more than the cap in one pass');
});

// ─── reversibility: the restore/undo path (the load-bearing safety primitive) ──

test('reactivateFact restores a soft-deleted fact', () => {
  const fact = rememberFact({ kind: 'project', content: 'A fact that gets forgotten then restored.' });
  assert.equal(forgetFact(fact.id), true);
  assert.equal(getFact(fact.id)?.active, false);
  assert.equal(listActiveFacts({ limit: 100 }).some((f) => f.id === fact.id), false, 'gone from active list while forgotten');
  assert.equal(reactivateFact(fact.id), true);
  assert.equal(getFact(fact.id)?.active, true);
  assert.equal(listActiveFacts({ limit: 100 }).some((f) => f.id === fact.id), true, 'back in the active list');
});

test('reactivateFact is idempotent on an already-active fact', () => {
  const fact = rememberFact({ kind: 'user', content: 'An already-active fact.' });
  assert.equal(reactivateFact(fact.id), false, 'no-op on an active fact returns false');
  assert.equal(getFact(fact.id)?.active, true);
});

test('reactivateFact refreshes recency so a restored fact is not immediately re-decayed', () => {
  const fact = rememberFact({ kind: 'project', content: 'Stale low-value note, forgotten then restored.', importance: 2 });
  forgetFact(fact.id);
  reactivateFact(fact.id);
  const result = decayAndEvictFacts(); // "now" → a just-restored fact is not idle
  assert.equal(result.ids.includes(fact.id), false, 'just-restored fact is not re-evicted');
  assert.equal(getFact(fact.id)?.active, true);
});

test('decayAndEvictFacts records a per-eviction reason for the audit log', () => {
  const stale = rememberFact({ kind: 'project', content: 'Stale note for reason capture.', importance: 2 });
  const future = Date.now() + 90 * DAY_MS;
  const result = decayAndEvictFacts({ nowMs: future });
  assert.equal(result.reasons.length, result.deactivated, 'one reason per eviction');
  assert.ok(result.reasons.some((r) => r.includes('#' + stale.id) && r.includes('imp:')), 'reason names the fact id + importance');
});

test('consolidateFact pins the resulting fact when candidate.pin is set (prohibition path)', async () => {
  const { consolidateFact } = await import('./reflection.js');
  await consolidateFact({ kind: 'feedback', text: 'never email the test list', trustLevel: 1.0, pin: true }, {});
  const pinned = listPinnedFacts(12);
  assert.ok(pinned.some((f) => f.content.includes('never email the test list')), 'a pin:true candidate ends up pinned (always-injected)');
});

test('consolidateFact does NOT pin when pin is unset (common path unchanged)', async () => {
  const { consolidateFact } = await import('./reflection.js');
  await consolidateFact({ kind: 'user', text: 'Alexander prefers concise replies.', trustLevel: 1.0 }, {});
  assert.equal(
    listPinnedFacts(12).some((f) => f.content.includes('concise replies')),
    false,
    'a candidate without pin stays unpinned',
  );
});

test('no-regression: a decay pass that evicts nothing leaves the rendered facts byte-identical', () => {
  rememberFact({ kind: 'project', content: 'High-priority launch note.', importance: 9 });
  rememberFact({ kind: 'user', content: 'Alexander is the owner.' }); // default importance 5 > ceil 4
  const before = renderFactsForInstructions(12, 1600);
  const result = decayAndEvictFacts(); // "now" → nothing idle, nothing low enough
  assert.equal(result.deactivated, 0, 'nothing evicted');
  assert.equal(renderFactsForInstructions(12, 1600), before, 'render byte-identical when no fact is retired');
});

// ─────────────────────────────────────────────────────────────────
// Tier B1 / scored similarity — lexical fallback (no embeddings here).
// ─────────────────────────────────────────────────────────────────

test('findSimilarFactsScored reports sim=null on the lexical fallback path', async () => {
  rememberFact({ kind: 'user', content: 'Alexander prefers concise replies in markdown.' });
  const scored = await findSimilarFactsScored('concise markdown replies', { kind: 'user', topK: 5 });
  assert.ok(scored.length >= 1, 'lexical fallback returns a candidate');
  assert.equal(scored[0].sim, null, 'no cosine score available without embeddings');
  assert.ok(scored[0].fact.content.length > 0);
});

test('searchFacts returns relevant facts via lexical fallback', async () => {
  rememberFact({ kind: 'project', content: 'The deployment runs on a nightly cron at 3am.' });
  rememberFact({ kind: 'user', content: 'Alexander likes terse status updates.' });
  const hits = await searchFacts('nightly cron deployment', { topK: 5 });
  assert.ok(hits.some((f) => /cron/i.test(f.content)), 'token-overlap match surfaces');
});

// ─────────────────────────────────────────────────────────────────
// Thread 1 / C1 — source provenance + authoritative trust on the row.
// ─────────────────────────────────────────────────────────────────

test('rememberFact persists sourceApp and an authoritative trust override', () => {
  const fact = rememberFact({
    kind: 'project',
    content: 'Acme renewal closes in Q3.',
    derivedFrom: { sessionId: 's1', tool: 'SALESFORCE_GET_RECORD' },
    trustLevel: 0.9,
    sourceApp: 'Salesforce',
  });
  // trust override beats the derived-fact default of 0.6.
  assert.equal(fact.trustLevel, 0.9, 'authoritative trust persisted');
  assert.equal(fact.sourceApp, 'Salesforce', 'source app persisted');
  const reloaded = getFact(fact.id);
  assert.equal(reloaded?.sourceApp, 'Salesforce');
  assert.equal(reloaded?.trustLevel, 0.9);
});

test('derived facts without a source keep the 0.6 default and null sourceApp', () => {
  const fact = rememberFact({
    kind: 'project',
    content: 'Inferred: the prospect prefers email over calls.',
    derivedFrom: { sessionId: 's1', tool: 'firecrawl' },
  });
  assert.equal(fact.trustLevel, 0.6, 'unchanged derived default');
  assert.equal(fact.sourceApp ?? null, null);
});

test('listActiveFacts(stanford): a useful high-importance fact beyond the former pool is recalled', () => {
  const db = openMemoryDb();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const insert = db.prepare(`
    INSERT INTO consolidated_facts
      (kind, content, content_hash, score, active, created_at, updated_at, importance, last_used_at, utility_count)
    VALUES (@kind, @content, @hash, 1.0, 1, @created, @updated, @importance, @accessed, @utility)
  `);
  // 120 recently-edited, low-importance fillers — push the target past rank 100
  // by updated_at while keeping their own Stanford score low (importance 1).
  for (let i = 0; i < 120; i++) {
    insert.run({
      kind: 'project',
      content: `filler fact ${i} routine status`,
      hash: `recall-pool-filler-${i}`,
      created: nowIso,
      updated: new Date(now - i * 1000).toISOString(),
      importance: 1,
      accessed: nowIso,
      utility: 0,
    });
  }
  // The target: edited 30 days ago (~rank 121 by updated_at) but ACCESSED today
  // and high-importance — exactly what the Stanford score wants to surface.
  insert.run({
    kind: 'user',
    content: 'Alex default sending identity is alex.chen@legacy.example',
    hash: 'recall-pool-target-high-importance',
    created: new Date(now - 30 * DAY_MS).toISOString(),
    updated: new Date(now - 30 * DAY_MS).toISOString(),
    importance: 8,
    accessed: nowIso,
    utility: 10,
  });

  const hasTarget = (facts: { content: string }[]) =>
    facts.some((f) => f.content.includes('default sending identity'));

  assert.equal(
    hasTarget(listActiveFacts({ ranking: 'stanford', limit: 10 })),
    true,
    'full-pool scoring recalls the useful tail fact',
  );
});

test('listActiveFacts(stanford): a semantically-relevant fact is promoted by the turn query vector (bonus-only)', () => {
  process.env.CLEMMY_SEMANTIC_RECALL = 'on';
  _setEmbeddingProviderForTest({
    name: 'test',
    model: 'test',
    dim: 4,
    async embed(texts) {
      return texts.map(() => new Float32Array(4));
    },
  });
  const db = openMemoryDb();
  const embed = db.prepare(`INSERT INTO fact_embeddings (fact_id, model, dim, vector, content_hash, created_at)
                            VALUES (?, 'test', 4, ?, ?, datetime('now'))`);
  const setVec = (id: number, arr: number[]) => embed.run(id, vectorToBuffer(Float32Array.from(arr)), factContentHash(id));

  // Relevant but LOW importance → loses on base Stanford score.
  const relevant = rememberFact({ kind: 'user', content: 'Alexander default sending identity is acme email.', importance: 3 });
  setVec(relevant.id, [1, 0, 0, 0]);
  // Off-topic but HIGH importance → wins the slot on base score alone.
  const offtopic = rememberFact({ kind: 'project', content: 'Home services plumbing emergency funnel.', importance: 8 });
  setVec(offtopic.id, [0, 1, 0, 0]);

  const rankOf = (id: number, facts: { id: number }[]) => facts.findIndex((f) => f.id === id);

  // No turn vector → base ranking: high-importance off-topic fact wins.
  clearTurnQueryVector();
  const base = listActiveFacts({ ranking: 'stanford', limit: 5 });
  assert.ok(rankOf(offtopic.id, base) < rankOf(relevant.id, base), 'baseline: high-importance off-topic fact outranks the relevant one');

  // Turn vector aligned with the relevant fact → its cosine bonus promotes it.
  setTurnQueryVector('what email do I send from', Float32Array.from([1, 0, 0, 0]));
  const withSem = listActiveFacts({ ranking: 'stanford', limit: 5 });
  assert.ok(rankOf(relevant.id, withSem) < rankOf(offtopic.id, withSem), 'semantic bonus promotes the on-topic fact above the merely-recent/important one');

  clearTurnQueryVector();
  delete process.env.CLEMMY_SEMANTIC_RECALL;
  _setEmbeddingProviderForTest(undefined);
});

test('listActiveFacts(stanford): semantic recall is a no-op when the flag is off', () => {
  process.env.CLEMMY_SEMANTIC_RECALL = 'off';
  _setEmbeddingProviderForTest({
    name: 'test',
    model: 'test',
    dim: 4,
    async embed(texts) {
      return texts.map(() => new Float32Array(4));
    },
  });
  const db = openMemoryDb();
  const embed = db.prepare(`INSERT INTO fact_embeddings (fact_id, model, dim, vector, content_hash, created_at)
                            VALUES (?, 'test', 4, ?, ?, datetime('now'))`);
  const rel = rememberFact({ kind: 'user', content: 'Low importance but on-topic.', importance: 3 });
  embed.run(rel.id, vectorToBuffer(Float32Array.from([1, 0, 0, 0])), factContentHash(rel.id));
  const off = rememberFact({ kind: 'project', content: 'High importance off-topic.', importance: 8 });
  embed.run(off.id, vectorToBuffer(Float32Array.from([0, 1, 0, 0])), factContentHash(off.id));

  setTurnQueryVector('on-topic query', Float32Array.from([1, 0, 0, 0]));
  const facts = listActiveFacts({ ranking: 'stanford', limit: 5 });
  const ri = facts.findIndex((f) => f.id === rel.id);
  const oi = facts.findIndex((f) => f.id === off.id);
  assert.ok(oi < ri, 'with the flag OFF the vector is ignored — base ranking stands');

  clearTurnQueryVector();
  delete process.env.CLEMMY_SEMANTIC_RECALL;
  _setEmbeddingProviderForTest(undefined);
});

test('lexicalRelevance: a detailed on-point fact is not demoted by its length (short-fact bias fix)', () => {
  const objective = 'travis county permit contact email';
  const detailed = 'The Travis County permit office contact is Jane Doe handling residential building permits';
  const dScore = lexicalRelevance(objective, detailed);
  // Covers 4/5 objective terms → strong relevance via coverage, even though
  // precision (4/11) is low. Old behavior scored this ~0.36 and lost to noise.
  assert.ok(dScore >= 0.6, `detailed on-point fact should score by coverage, got ${dScore}`);
  // A short exact match still scores 1.0 (precision path preserved).
  assert.equal(lexicalRelevance('legal contract', 'legal contract'), 1);
});

test('utility reinforcement: a frequently-used fact outranks an equal-base never-used one', () => {
  process.env.CLEMMY_RECALL_REINFORCEMENT_WEIGHT = '0.1';
  clearTurnQueryVector();
  const db = openMemoryDb();
  const a = rememberFact({ kind: 'user', content: 'Reinforced fact A.', importance: 5 });
  const b = rememberFact({ kind: 'user', content: 'Never-recalled fact B.', importance: 5 });
  // Identical recency anchor + importance for both; A has 50 prior recalls.
  const sameTime = new Date().toISOString();
  db.prepare('UPDATE consolidated_facts SET last_used_at = ?, utility_count = ? WHERE id = ?').run(sameTime, 50, a.id);
  db.prepare('UPDATE consolidated_facts SET last_used_at = ?, utility_count = ? WHERE id = ?').run(sameTime, 0, b.id);
  const ranked = listActiveFacts({ ranking: 'stanford', limit: 5 });
  const ai = ranked.findIndex((f) => f.id === a.id);
  const bi = ranked.findIndex((f) => f.id === b.id);
  assert.ok(ai >= 0 && ai < bi, 'the reinforced fact (50 recalls) ranks above the never-recalled equal');
  delete process.env.CLEMMY_RECALL_REINFORCEMENT_WEIGHT;
});

test('touchFactAccess increments access_count', () => {
  const a = rememberFact({ kind: 'user', content: 'Touch me for reinforcement.' });
  assert.equal(getFact(a.id)?.accessCount ?? 0, 0, 'new fact starts at 0 accesses');
  touchFactAccess(a.id);
  touchFactAccess(a.id);
  assert.equal(getFact(a.id)?.accessCount, 2, 'two touches → access_count 2');
});

test('automatic impressions do not reinforce utility or change the recency anchor', () => {
  const fact = rememberFact({ kind: 'user', content: 'Passive exposure must not self-reinforce.' });
  recordFactImpression(fact.id);
  recordFactImpression(fact.id);
  const reloaded = getFact(fact.id);
  assert.equal(reloaded?.impressionCount, 2);
  assert.equal(reloaded?.utilityCount, 0);
  assert.equal(reloaded?.lastUsedAt, null);
});

test('prompt impressions count only policy facts that are actually rendered', () => {
  const shown = rememberFact({
    kind: 'feedback',
    content: `Prefer the compact response format. ${'a'.repeat(64)}`,
    importance: 9,
  });
  const omitted = rememberFact({
    kind: 'feedback',
    content: `Prefer the expansive response format. ${'b'.repeat(64)}`,
    importance: 1,
  });
  setFactPinned(shown.id, true);
  setFactPinned(omitted.id, true);

  const rendered = renderFactsForInstructions(10, 200, undefined, 'pinned');
  assert.match(rendered, /compact response format/);
  assert.doesNotMatch(rendered, /expansive response format/);
  assert.equal(getFact(shown.id)?.impressionCount, 1);
  assert.equal(getFact(omitted.id)?.impressionCount, 0);
  assert.equal(getFact(shown.id)?.utilityCount, 0);
});

test('importance-aware decay: low-importance idle fades; high-importance moderately-idle survives; ancient high-importance eventually fades', () => {
  const db = openMemoryDb();
  const daysAgo = (d: number) => new Date(Date.now() - d * DAY_MS).toISOString();
  const setAge = (id: number, days: number, importance: number, access: number) => db.prepare(
    'UPDATE consolidated_facts SET updated_at=?, created_at=?, last_used_at=NULL, importance=?, utility_count=? WHERE id=?'
  ).run(daysAgo(days), daysAgo(days), importance, access, id);

  const lowIdle = rememberFact({ kind: 'project', content: 'Low importance idle fact.' });
  setAge(lowIdle.id, 50, 2, 0);        // threshold ~42d, idle 50 → decays
  const highMod = rememberFact({ kind: 'project', content: 'High importance moderately idle.' });
  setAge(highMod.id, 70, 9, 0);        // threshold ~84d, idle 70 → survives
  const highAncient = rememberFact({ kind: 'project', content: 'High importance unused for months.' });
  setAge(highAncient.id, 200, 9, 0);   // threshold ~84d, idle 200 → fades (tail not immortal)
  const usedOften = rememberFact({ kind: 'project', content: 'Frequently recalled fact.' });
  setAge(usedOften.id, 100, 5, 50);   // threshold ~178d, idle 100 → protected by reinforcement

  const decayed = new Set(decayAndEvictFacts({ importanceAware: true }).ids);
  assert.ok(decayed.has(lowIdle.id), 'low-importance very-idle fact decays');
  assert.ok(!decayed.has(highMod.id), 'high-importance moderately-idle fact survives');
  assert.ok(decayed.has(highAncient.id), 'high-importance fact unused for months eventually fades');
  assert.ok(!decayed.has(usedOften.id), 'a frequently-recalled fact is protected by access reinforcement');
});

test('importance-aware decay: pinned facts are exempt even when ancient', () => {
  const db = openMemoryDb();
  const f = rememberFact({ kind: 'feedback', content: 'Pinned standing rule.' });
  db.prepare('UPDATE consolidated_facts SET updated_at=?, created_at=?, importance=?, pinned=1 WHERE id=?')
    .run(new Date(Date.now() - 300 * DAY_MS).toISOString(), new Date(Date.now() - 300 * DAY_MS).toISOString(), 2, f.id);
  assert.ok(!decayAndEvictFacts({ importanceAware: true }).ids.includes(f.id), 'pinned fact exempt even at 300 days idle');
});

test('importance-aware decay is ON by default — the idle tail fades even for high-importance; the kill-switch reverts to binary (immortal)', () => {
  const db = openMemoryDb();
  const setAncient = (id: number, importance: number) => db.prepare(
    'UPDATE consolidated_facts SET updated_at=?, created_at=?, last_used_at=NULL, importance=? WHERE id=?'
  ).run(new Date(Date.now() - 300 * DAY_MS).toISOString(), new Date(Date.now() - 300 * DAY_MS).toISOString(), importance, id);

  // DEFAULT (no importanceAware option) is now the importance-aware path: a fact
  // unused for ~300 days fades even at importance 9 (threshold ~84d), and the
  // default-5.0 tail (the bulk of the store) finally retires too.
  const ancientHigh = rememberFact({ kind: 'project', content: 'High importance ancient (default path).' });
  setAncient(ancientHigh.id, 9);
  const ancientDefault = rememberFact({ kind: 'project', content: 'Default importance ancient (default path).' });
  setAncient(ancientDefault.id, 5);
  const decayedDefault = new Set(decayAndEvictFacts({}).ids);
  assert.ok(decayedDefault.has(ancientHigh.id), 'default path retires a high-importance fact unused for ~300 days');
  assert.ok(decayedDefault.has(ancientDefault.id), 'default path retires the idle default-5.0 tail');

  // KILL-SWITCH (importanceAware:false) reverts to the binary path: importance>4
  // is immortal regardless of idle age.
  const ancientHigh2 = rememberFact({ kind: 'project', content: 'High importance ancient (kill-switch).' });
  setAncient(ancientHigh2.id, 9);
  assert.ok(!decayAndEvictFacts({ importanceAware: false }).ids.includes(ancientHigh2.id), 'binary kill-switch never evicts a high-importance fact');
});

// ─── 2026-06-12 audit: singleton must survive rogue close + nightly merge ───

test('openMemoryDb self-heals after a direct close of the cached handle', () => {
  const db = openMemoryDb();
  db.close(); // simulate a caller closing the singleton without closeMemoryDb
  const reopened = openMemoryDb();
  assert.equal(reopened.open, true, 'stale closed handle is dropped and reopened');
  // And it actually works:
  const f = rememberFact({ kind: 'project', content: 'Self-heal probe fact.' });
  assert.ok(getFact(f.id), 'reopened handle serves reads/writes');
});

test('mergeParaphrases leaves the shared db connection usable', async () => {
  const { mergeParaphrases } = await import('./memory-merge.js');
  const prevMerge = process.env.CLEMMY_MERGE_ENABLED;
  process.env.CLEMMY_MERGE_ENABLED = 'true';
  try {
    await mergeParaphrases();
    const db = openMemoryDb();
    assert.equal(db.open, true, 'nightly merge must not close the singleton');
    const f = rememberFact({ kind: 'project', content: 'Post-merge write probe.' });
    assert.ok(getFact(f.id), 'memory writes still work after the merge job');
  } finally {
    // Don't leak the flag to memory-merge.test.ts later in the single-process suite.
    if (prevMerge === undefined) delete process.env.CLEMMY_MERGE_ENABLED; else process.env.CLEMMY_MERGE_ENABLED = prevMerge;
  }
});
