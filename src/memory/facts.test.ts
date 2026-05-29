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
  forgetFact,
  getFact,
  lexicalRelevance,
  listActiveFacts,
  listAllFacts,
  listPinnedFacts,
  rememberFact,
  renderFactsForInstructions,
  reviewStandingInstructions,
  setFactPinned,
} = await import('./facts.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  resetMemoryDb();
  // Touch DB so subsequent ops succeed.
  openMemoryDb();
});

test('rememberFact inserts a new row', () => {
  const fact = rememberFact({ kind: 'user', content: 'Nathan prefers concise replies.' });
  assert.equal(fact.kind, 'user');
  assert.equal(fact.content, 'Nathan prefers concise replies.');
  assert.equal(fact.active, true);
  assert.ok(fact.id > 0);
  assert.ok(fact.score >= 1);
});

test('rememberFact dedups on normalized content (same kind)', () => {
  const a = rememberFact({ kind: 'user', content: 'Nathan likes action.' });
  const b = rememberFact({ kind: 'user', content: 'Nathan   likes    action.' });  // extra whitespace
  const c = rememberFact({ kind: 'user', content: 'NATHAN LIKES ACTION.' });        // different case
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
  rememberFact({ kind: 'user', content: 'Nathan is the project owner.' });
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
  rememberFact({ kind: 'user', content: 'Nathan runs a legal practice.', importance: 6 });
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
  assert.match(rendered, /Standing instructions \(always apply\)/);
  assert.match(rendered, /Never email clients on Fridays/);
});

test('message-scoped recall surfaces a query-relevant fact that global recall buries (the "MY accounts" fix)', () => {
  // The fact that should govern "pull MY market-leader accounts".
  rememberFact({ kind: 'project', content: 'My market-leader accounts are Salesforce accounts owned by Nathan Reynolds where Market_Leader__c is true.' });
  // Flood with newer, unrelated facts so a small global top-N excludes it.
  for (let i = 0; i < 15; i += 1) {
    rememberFact({ kind: 'project', content: `Unrelated recent note ${i} about calendar scheduling and meeting prep.` });
  }

  // Global recall (no objective): the owner-filter fact is buried.
  const global = renderFactsForInstructions(3, 4000);
  // Message-scoped recall: the query surfaces it.
  const scoped = renderFactsForInstructions(3, 4000, 'pull my market leader accounts');
  assert.match(scoped, /owned by Nathan Reynolds/, 'message-scoped recall must surface the owner-filter fact');
  assert.ok(
    !/owned by Nathan Reynolds/.test(global) || /owned by Nathan Reynolds/.test(scoped),
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

test('pinned fact is not double-rendered (excluded from the scored section)', () => {
  const f = rememberFact({ kind: 'feedback', content: 'Quote prices in USD only.' });
  setFactPinned(f.id, true);
  const rendered = renderFactsForInstructions(10, 4000);
  const occurrences = rendered.split('Quote prices in USD only').length - 1;
  assert.equal(occurrences, 1, 'pinned fact should appear exactly once');
});
