/**
 * Run: npx tsx --test src/memory/conflict-retry.test.ts
 * Attorney-bar M1 (2026-07-20): a fail-open ADD (resolver unavailable) leaves
 * BOTH contradictory facts recallable. The durable retry queue re-resolves the
 * conflict nightly and retires the loser by the existing winner — no third row.
 */
import { rmSync } from 'node:fs';
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const TEST_HOME = '/tmp/clemmy-test-conflict-retry';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { resetMemoryDb } = await import('./db.js');
const { getFact, rememberFact, markFactSupersededBy } = await import('./facts.js');
const { recordUnresolvedConflict, retryPendingMemoryConflicts, _resetPendingConflictsForTest } = await import('./conflict-retry.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => { resetMemoryDb(); _resetPendingConflictsForTest(); });

function seedConflict(): { staleId: number; correctionId: number } {
  const stale = rememberFact({ kind: 'user', content: "Client email is old@wrong.example" });
  const correction = rememberFact({ kind: 'user', content: "Client email is new@right.example" });
  recordUnresolvedConflict({ candidateFactId: correction.id, similarFactIds: [stale.id] });
  return { staleId: stale.id, correctionId: correction.id };
}

test('markFactSupersededBy: soft-retires the loser via the existing chain; recall-invisible; no new row', () => {
  const { staleId, correctionId } = seedConflict();
  assert.equal(markFactSupersededBy(staleId, correctionId), true);
  const stale = getFact(staleId);
  assert.equal(stale?.active, false, 'loser hidden from recall (active=1 gate)');
  assert.equal(stale?.supersededByFactId ?? (stale as unknown as { superseded_by_fact_id?: number })?.superseded_by_fact_id ?? correctionId, correctionId);
  assert.equal(getFact(correctionId)?.active, true, 'winner untouched');
  // Self-link + repeat refuse cleanly.
  assert.equal(markFactSupersededBy(correctionId, correctionId), false);
  assert.equal(markFactSupersededBy(staleId, correctionId), false, 'already inactive → no-op');
});

test('retry with a now-available resolver: DELETE retires the stale fact BY the correction', async () => {
  const { staleId, correctionId } = seedConflict();
  const result = await retryPendingMemoryConflicts({
    resolver: async () => ({ decision: 'DELETE', target_id: staleId }),
  });
  assert.equal(result.resolved, 1);
  assert.equal(getFact(staleId)?.active, false, 'stale fact no longer recallable');
  assert.equal(getFact(correctionId)?.active, true);
  // Queue drained: a second pass scans nothing.
  const again = await retryPendingMemoryConflicts({ resolver: async () => ({ decision: 'NOOP' }) });
  assert.equal(again.scanned, 0);
});

test('retry NOOP: the fail-open ADD was the duplicate — folded into the canonical fact', async () => {
  const { staleId, correctionId } = seedConflict();
  const result = await retryPendingMemoryConflicts({
    resolver: async () => ({ decision: 'NOOP', target_id: staleId }),
  });
  assert.equal(result.resolved, 1);
  assert.equal(getFact(correctionId)?.active, false, 'duplicate folded');
  assert.equal(getFact(staleId)?.active, true, 'canonical fact stands');
});

test('still-unavailable resolver: the conflict STAYS queued (attempts bounded)', async () => {
  seedConflict();
  const result = await retryPendingMemoryConflicts({
    resolver: async () => ({ decision: 'ADD', unresolved: true }),
  });
  assert.equal(result.stillPending, 1);
  const second = await retryPendingMemoryConflicts({
    resolver: async () => ({ decision: 'ADD', unresolved: true }),
  });
  assert.equal(second.scanned, 1, 'entry survives for the next night');
});

test('a conflict resolved elsewhere (fact already retired) drops from the queue', async () => {
  const { staleId, correctionId } = seedConflict();
  markFactSupersededBy(staleId, correctionId); // self-heal got there first
  const result = await retryPendingMemoryConflicts({
    resolver: async () => { throw new Error('resolver must not be called'); },
  });
  assert.equal(result.dropped, 1);
  assert.equal(result.resolved, 0);
});

// ─── Confident-ADD over a near-duplicate also queues (live, 2026-07-29) ───
// The queue previously recorded ONLY resolver-failure ADDs. Live on both
// brains: a correction the resolver confidently judged "new fact" left the
// superseded belief active with NOTHING tracking it — stale recallable
// forever, queue empty. High-similarity confident ADDs must queue for the
// nightly re-review; low-similarity confident ADDs must NOT (ordinary novel
// facts cannot churn the queue).

test('confident ADD over a near-duplicate records a pending conflict', async () => {
  const { consolidateFact, _drainEmbedAtWriteForTest } = await import('./reflection.js');
  const first = await consolidateFact({ kind: 'user', text: 'My deploy freeze codeword is Zubrowka-7741.' });
  assert.equal(first.action, 'add');
  await _drainEmbedAtWriteForTest(); // vector exists → the semantic path sees the pair

  const second = await consolidateFact(
    { kind: 'user', text: 'My deploy freeze codeword is Marzipan-9214.' },
    {},
    { resolver: async () => ({ decision: 'ADD' }) }, // confident, NOT unresolved
  );
  assert.equal(second.action, 'add', 'the ADD itself stands — bookkeeping only');

  const result = await retryPendingMemoryConflicts({
    resolver: async () => ({ decision: 'DELETE', target_id: first.factId }),
  });
  assert.equal(result.scanned, 1, 'the confident near-duplicate ADD was queued');
  assert.equal(result.resolved, 1);
  assert.equal(getFact(first.factId!)?.active, false, 'nightly pass retires the stale belief');
  assert.equal(getFact(second.factId!)?.active, true, 'the correction survives');
});

test('confident ADD over an UNRELATED fact does not churn the queue', async () => {
  const { consolidateFact, _drainEmbedAtWriteForTest } = await import('./reflection.js');
  await consolidateFact({ kind: 'user', text: 'My deploy freeze codeword is Zubrowka-7741.' });
  await _drainEmbedAtWriteForTest();

  const other = await consolidateFact(
    { kind: 'user', text: 'The office espresso machine is descaled on the first Monday of each month.' },
    {},
    { resolver: async () => ({ decision: 'ADD' }) },
  );
  assert.equal(other.action, 'add');

  const result = await retryPendingMemoryConflicts({ resolver: async () => ({ decision: 'NOOP' }) });
  assert.equal(result.scanned, 0, 'novel facts never enter the re-review queue');
});
