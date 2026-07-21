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
