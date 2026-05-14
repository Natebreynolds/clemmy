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
  listActiveFacts,
  listAllFacts,
  rememberFact,
  renderFactsForInstructions,
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
