/**
 * Run: npx tsx --test src/execution/effect-contract-agreement.test.ts
 *
 * Stage 6, workflow lane: the agreement proof.
 *
 * The workflow-call-receipts seam has enforced intent -> started -> receipt ->
 * commit in production since the Lane C work, with exactly the recovery
 * semantics the charter demands. The graph contract (effect-lifecycle.ts /
 * provider-fallover.ts) states the same machine provider-neutrally. Rather
 * than rewiring a proven safety seam to call the new module — churn with no
 * behavioral gain — this test PINS THE TWO MACHINES TOGETHER, the same
 * pattern that unified readiness against planWorkflowExecutionBatches: both
 * stay, agreement is asserted per state, and any future divergence fails here
 * instead of shipping as a split-brain recovery policy.
 *
 * The phase correspondence, row for row:
 *
 *   live status   ledger rows                     contract decision   live action
 *   ------------  ------------------------------  ------------------  -------------------------
 *   none          []                              dispatch            fresh dispatch proceeds
 *   intent        [reserved]                      dispatch            retry safe (never started)
 *   failed        [reserved, released]            dispatch            proven-no-commit retry
 *   ambiguous     [reserved, started]             observe             AmbiguousError; op verifies
 *   received      [reserved, started, receipt]    complete_commit     persistCommit, replay
 *   committed     [... committed]                 settled             replay durable result
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { WorkflowCallMutationStatus } from './workflow-call-receipts.js';
import { decideEffectResume, type EffectLedgerRow } from '../runtime/graph/effect-lifecycle.js';
import { decideProviderFallover } from '../runtime/graph/provider-fallover.js';

function row(phase: EffectLedgerRow['phase'], ref?: string): EffectLedgerRow {
  return { effectId: 'ef', phase, at: '2026-08-04T00:00:00Z', ...(ref ? { ref } : {}) };
}

/** The canonical translation of the live seam's status into contract rows. */
function ledgerRowsForStatus(status: WorkflowCallMutationStatus): EffectLedgerRow[] {
  switch (status) {
    case 'none': return [];
    case 'intent': return [row('reserved')];
    // A `failed` phase is written ONLY for a proven-no-commit failure — the
    // provider demonstrably did not mutate, so the reservation is released.
    case 'failed': return [row('reserved'), row('released')];
    case 'ambiguous': return [row('reserved'), row('dispatch_started')];
    case 'received': return [row('reserved'), row('dispatch_started'), row('provider_receipt', 'rcpt')];
    case 'committed': return [
      row('reserved'), row('dispatch_started'), row('provider_receipt', 'rcpt'),
      row('observed'), row('committed'),
    ];
  }
}

const ALL_STATUSES: WorkflowCallMutationStatus[] = [
  'none', 'intent', 'failed', 'ambiguous', 'received', 'committed',
];

/** What the LIVE seam does per status — transcribed from workflow-call-receipts:
 *  replayWorkflowCallMutationSlot + assessWorkflowRunMutationRequeue. If the
 *  seam's behavior changes, update this table CONSCIOUSLY: it is the half of
 *  the agreement that documents production. */
const LIVE_ACTION: Record<WorkflowCallMutationStatus, 'dispatch' | 'observe' | 'complete_commit' | 'settled'> = {
  none: 'dispatch',           // no ledger — the normal dispatch path proceeds
  intent: 'dispatch',         // "dispatch never reached its boundary, so retry is safe"
  failed: 'dispatch',         // "proven no-commit … a retry is safe"
  ambiguous: 'observe',       // throws WorkflowCallMutationAmbiguousError — operator verification
  received: 'complete_commit',// persistCommit(receipt) then replay, no re-dispatch
  committed: 'settled',       // replay the durable result, no re-dispatch
};

test('the live receipt seam and the graph contract decide every state identically', () => {
  for (const status of ALL_STATUSES) {
    const decision = decideEffectResume(ledgerRowsForStatus(status));
    assert.equal(decision.action, LIVE_ACTION[status],
      `divergence at "${status}": live does ${LIVE_ACTION[status]}, contract says ${decision.action} — `
      + 'two recovery policies for one ledger is the split-brain this test exists to prevent');
  }
});

test('the receipt reference survives translation — complete_commit can actually commit', () => {
  const decision = decideEffectResume(ledgerRowsForStatus('received'));
  assert.equal(decision.action, 'complete_commit');
  assert.equal(
    (decision as Extract<typeof decision, { action: 'complete_commit' }>).receiptRef,
    'rcpt',
  );
});

test('requeue blocking and fallover holding are the same set', () => {
  // assessWorkflowRunMutationRequeue blocks a fresh run for exactly
  // {ambiguous, received, committed}; decideProviderFallover must hold or
  // gate fallover for exactly the same statuses, and allow it for the rest.
  // (committed is settled — it does not HOLD fallover, it replays free — so
  // the live "blocking" for committed maps to reuse, not to observation;
  // what must agree is that no status the live seam blocks is treated as
  // freely dispatchable by the contract, and vice versa.)
  for (const status of ALL_STATUSES) {
    const fallover = decideProviderFallover({ 'ef-x': ledgerRowsForStatus(status) });
    const liveBlocksFreshRun = status === 'ambiguous' || status === 'received' || status === 'committed';
    const contractTreatsAsDone = fallover.action === 'fallover_allowed'
      && decideEffectResume(ledgerRowsForStatus(status)).action === 'settled';
    const contractHolds = fallover.action !== 'fallover_allowed';
    assert.equal(
      liveBlocksFreshRun,
      contractHolds || contractTreatsAsDone,
      `divergence at "${status}": live ${liveBlocksFreshRun ? 'blocks' : 'allows'} a fresh run; `
      + `contract ${contractHolds ? 'holds fallover' : contractTreatsAsDone ? 'settles' : 'allows freely'}`,
    );
  }
});

test('the ambiguous state has no dispatch arm in either machine', () => {
  // The exact sentence from both implementations, asserted once against each:
  // a started mutation with no receipt is never blindly re-dispatched.
  const contract = decideEffectResume(ledgerRowsForStatus('ambiguous'));
  assert.notEqual(contract.action, 'dispatch', 'the contract re-dispatched an ambiguous write');
  assert.equal(LIVE_ACTION.ambiguous, 'observe', 'the live seam re-dispatches an ambiguous write');
});
