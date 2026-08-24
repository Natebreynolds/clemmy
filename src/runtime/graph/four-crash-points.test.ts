/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/graph/four-crash-points.test.ts
 *
 * The four crash points that produce essentially all real duplicate effects
 * (blank-state amendments §3). One matrix, one rule: reconcile before
 * redispatch. "Retry once" is not exactly-once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  batchPlanRedispatchesSettledWork,
  decideBatchResume,
  type EffectLedgerRow,
  type EffectPhase,
} from './effect-lifecycle.js';

function row(phase: EffectPhase, ref?: string): EffectLedgerRow {
  return { effectId: 'ef_batch', phase, at: '2026-08-21T00:00:00Z', ...(ref ? { ref } : {}) };
}

const COMMITTED = [
  row('reserved'), row('dispatch_started'), row('provider_receipt', 'rcpt'),
  row('observed'), row('committed'), row('checkpointed'),
];

function chain(...phases: EffectPhase[]): EffectLedgerRow[] {
  return phases.map((phase, index) => (
    phase === 'provider_receipt' ? row(phase, `rcpt-${index}`) : row(phase)
  ));
}

test('after provider commit, before response: OBSERVE — never redispatch that item', () => {
  // The provider accepted the write; the HTTP body never arrived.
  const plan = decideBatchResume([
    { itemId: 'item-0', rows: chain('reserved', 'dispatch_started') },
    { itemId: 'item-1', rows: [] },
  ]);
  assert.deepEqual(plan.observe, ['item-0']);
  assert.deepEqual(plan.dispatch, ['item-1']);
  assert.equal(batchPlanRedispatchesSettledWork(plan), false);
  assert.equal(plan.dispatch.includes('item-0'), false);
});

test('after response, before receipt: a body in memory is not a receipt — still observe', () => {
  // We saw bytes and crashed before the durable receipt row. The ledger still
  // shows dispatch_started, or a receipt row with no reference.
  const lostBody = decideBatchResume([
    { itemId: 'item-0', rows: chain('reserved', 'dispatch_started') },
  ]);
  assert.equal(lostBody.observe[0], 'item-0');
  assert.deepEqual(lostBody.dispatch, []);

  const unreferenced = decideBatchResume([
    { itemId: 'item-0', rows: [row('reserved'), row('dispatch_started'), row('provider_receipt')] },
  ]);
  assert.equal(unreferenced.stop[0]?.itemId, 'item-0');
  assert.deepEqual(unreferenced.dispatch, []);
  assert.equal(batchPlanRedispatchesSettledWork(unreferenced), false);
});

test('mid-batch: settled prefix is free; the crashed item observes; the tail may dispatch once', () => {
  const plan = decideBatchResume([
    { itemId: 'item-0', rows: COMMITTED },
    { itemId: 'item-1', rows: chain('reserved', 'dispatch_started') },
    { itemId: 'item-2', rows: [] },
    { itemId: 'item-3', rows: [] },
  ]);
  assert.deepEqual(plan.settled, ['item-0']);
  assert.deepEqual(plan.observe, ['item-1']);
  assert.deepEqual(plan.dispatch, ['item-2', 'item-3']);
  assert.equal(plan.dispatch.includes('item-0'), false);
  assert.equal(plan.dispatch.includes('item-1'), false);
  assert.equal(batchPlanRedispatchesSettledWork(plan), false);
});

test('after receipt, before checkpoint: complete the local half — no redispatch', () => {
  const plan = decideBatchResume([
    { itemId: 'item-0', rows: chain('reserved', 'dispatch_started', 'provider_receipt') },
    { itemId: 'item-1', rows: [] },
  ]);
  assert.equal(plan.completeCommit.length, 1);
  assert.equal(plan.completeCommit[0]?.itemId, 'item-0');
  assert.ok(plan.completeCommit[0]?.receiptRef);
  assert.deepEqual(plan.dispatch, ['item-1']);
  assert.equal(plan.dispatch.includes('item-0'), false);
  assert.equal(batchPlanRedispatchesSettledWork(plan), false);
});

test('duplicate item identity cannot mint a second dispatch', () => {
  const plan = decideBatchResume([
    { itemId: 'item-0', rows: [] },
    { itemId: 'item-0', rows: [] },
  ]);
  assert.deepEqual(plan.dispatch, []);
  assert.equal(plan.stop[0]?.itemId, 'item-0');
  assert.equal(batchPlanRedispatchesSettledWork(plan), false);
});
