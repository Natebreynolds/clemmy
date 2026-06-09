/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-memory-apply npx tsx --test src/autoresearch/memory-apply.test.ts
 *
 * Covers the auto-research P1 apply path: autoCleanSafeMemory soft-deletes ONLY
 * the provably-synthetic smoke-test pollution class (exact-signature match),
 * leaving real user knowledge — and even self-tool noise — untouched. Plus the
 * four safety invariants: soft (recoverable), pinned-exempt, capped, dry-run.
 * Fully offline; embeddings stay off (no key in the fresh test home).
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-memory-apply';
process.env.CLEMENTINE_HOME = TEST_HOME;
delete process.env.CLEMMY_MEMORY_AUTOCLEAN; // default-ON path

// eslint-disable-next-line import/first
const { resetMemoryDb, openMemoryDb } = await import('../memory/db.js');
// eslint-disable-next-line import/first
const { rememberFact, getFact, reactivateFact, setFactPinned } = await import('../memory/facts.js');
// eslint-disable-next-line import/first
const { autoCleanSafeMemory } = await import('./memory-apply.js');
// eslint-disable-next-line import/first
const { detectSyntheticJunk, matchSyntheticJunk, computeMemoryRefinements } = await import('./memory-detectors.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  resetMemoryDb();
  openMemoryDb();
});

/** Seed a representative mix: junk + real knowledge + a lookalike. */
function seed() {
  const junkA = rememberFact({ kind: 'project', content: 'Clementine requirement: Workflow: zz-smoke-hard Step: facts Item: Tokyo write one true fact' });
  const junkB = rememberFact({ kind: 'feedback', content: 'Standing product feedback: Workflow: zz-smoke-target-judge Step: write_haiku' });
  const junkC = rememberFact({ kind: 'project', content: 'native-compaction-proof run produced a long string' });
  const real1 = rememberFact({ kind: 'user', content: 'Nathan prefers concise, strategic answers over band-aids.' });
  const real2 = rememberFact({ kind: 'project', content: 'The console redesign lives on feat/console-web-redesign behind CLEMENTINE_CONSOLE_NEXT.' });
  // A legitimate fact that merely mentions "smoke test" as an English phrase —
  // must NOT be pruned (we exclude broad terms by design).
  const lookalike = rememberFact({ kind: 'project', content: 'Always run the smoke test before tagging a release.' });
  return { junkA, junkB, junkC, real1, real2, lookalike };
}

test('matchSyntheticJunk: matches test signatures, ignores real knowledge', () => {
  assert.equal(matchSyntheticJunk('Workflow: zz-smoke-hard Step: facts'), 'zz-smoke');
  assert.equal(matchSyntheticJunk('native-compaction-proof'), 'native-compaction-proof');
  assert.equal(matchSyntheticJunk('Always run the smoke test before release'), null);
  assert.equal(matchSyntheticJunk('Nathan prefers concise answers'), null);
  assert.equal(matchSyntheticJunk(null), null);
  assert.equal(matchSyntheticJunk(''), null);
});

test('detectSyntheticJunk: counts only the synthetic class', () => {
  seed();
  const r = detectSyntheticJunk();
  assert.equal(r.count, 3, 'three synthetic facts (zz-smoke x2 + native-compaction-proof)');
  assert.ok(r.examples.length > 0);
});

test('autoCleanSafeMemory: soft-deletes only synthetic junk, keeps real + lookalike', () => {
  const { junkA, junkB, junkC, real1, real2, lookalike } = seed();
  const res = autoCleanSafeMemory();
  assert.equal(res.ran, true);
  assert.equal(res.dryRun, false);
  assert.equal(res.pruned, 3);
  assert.deepEqual([...res.ids].sort((a, b) => a - b), [junkA.id, junkB.id, junkC.id].sort((a, b) => a - b));
  // Junk is soft-deleted (active=0)...
  assert.equal(getFact(junkA.id)?.active, false);
  assert.equal(getFact(junkB.id)?.active, false);
  assert.equal(getFact(junkC.id)?.active, false);
  // ...real knowledge + the "smoke test" lookalike are untouched.
  assert.equal(getFact(real1.id)?.active, true);
  assert.equal(getFact(real2.id)?.active, true);
  assert.equal(getFact(lookalike.id)?.active, true);
});

test('soft + reversible: a pruned fact can be restored', () => {
  const { junkA } = seed();
  autoCleanSafeMemory();
  assert.equal(getFact(junkA.id)?.active, false);
  assert.equal(reactivateFact(junkA.id), true);
  assert.equal(getFact(junkA.id)?.active, true);
});

test('pinned-exempt: a pinned synthetic fact is never pruned', () => {
  const { junkA } = seed();
  assert.equal(setFactPinned(junkA.id, true), true);
  const res = autoCleanSafeMemory();
  assert.equal(getFact(junkA.id)?.active, true, 'pinned junk survives');
  assert.ok(!res.ids.includes(junkA.id));
});

test('capped: respects maxPrune', () => {
  seed();
  const res = autoCleanSafeMemory({ maxPrune: 1 });
  assert.equal(res.cap, 1);
  assert.equal(res.pruned, 1, 'only one pruned this run');
  // The remaining synthetic facts are still active and would be caught next run.
  assert.equal(detectSyntheticJunk().count, 2);
});

test('dryRun: previews without mutating', () => {
  const { junkA } = seed();
  const res = autoCleanSafeMemory({ dryRun: true });
  assert.equal(res.dryRun, true);
  assert.equal(res.pruned, 3);
  assert.equal(getFact(junkA.id)?.active, true, 'dry run does not mutate');
});

test('idempotent: a second pass on a clean store is a no-op', () => {
  seed();
  assert.equal(autoCleanSafeMemory().pruned, 3);
  assert.equal(autoCleanSafeMemory().pruned, 0);
});

test('kill-switch: CLEMMY_MEMORY_AUTOCLEAN=off disables it', () => {
  const { junkA } = seed();
  process.env.CLEMMY_MEMORY_AUTOCLEAN = 'off';
  try {
    const res = autoCleanSafeMemory();
    assert.equal(res.ran, false);
    assert.equal(res.reason, 'disabled');
    assert.equal(getFact(junkA.id)?.active, true);
  } finally {
    delete process.env.CLEMMY_MEMORY_AUTOCLEAN;
  }
});

test('computeMemoryRefinements: surfaces syntheticJunk in the bundle', () => {
  seed();
  const mr = computeMemoryRefinements('2026-06-08T00:00:00.000Z');
  assert.equal(mr.syntheticJunk.count, 3);
  assert.ok(mr.totalCandidates >= 3);
  assert.equal(mr.generatedAt, '2026-06-08T00:00:00.000Z');
});
