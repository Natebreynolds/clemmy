/**
 * Run: npx tsx --test src/runtime/harness/effect-contract-agreement-chat.test.ts
 *
 * Stage 6, chat lane: the agreement proof.
 *
 * The chat tool boundary's external-write machinery — pre-dispatch
 * reservations in the event log, `external_write_succeeded` settlements, the
 * S3 orphan ledger for timed-out maybe-landed writes, and the orphaned-write
 * retry corrective in brackets block 2c1.5 — already implements the graph
 * contract's ambiguity rule in production: a same-shape same-target retry
 * after an orphan is REFUSED until a paired successful READ is on the ledger,
 * and "a successful provider read-back is the authority that clears the
 * retry gate." Observation is the only exit; blind redispatch is not one.
 *
 * As with the workflow lane, the seam is not rewired — the two machines are
 * pinned together at the decision level, so a future change to either side
 * fails here before it ships as a split-brain recovery policy. The live
 * column below is transcribed from brackets.ts 2c1.5 and the eventlog orphan
 * ledger; if that behavior changes, update the table CONSCIOUSLY.
 *
 *   chat ledger state                      contract rows                    both decide
 *   -------------------------------------  -------------------------------  -----------
 *   no reservation                         []                               dispatch
 *   reservation, dispatch never started    [reserved]                       dispatch
 *   orphaned (timeout, maybe landed),      [reserved, dispatch_started]     observe —
 *     no paired read-back                                                   retry refused
 *   orphaned, then successful paired READ  [... observed]                   settled; a
 *     (read-back = observation)                                             conscious NEW
 *                                                                           call is a NEW
 *                                                                           effect identity
 *   external_write_succeeded               [... receipt, observed,          settled
 *                                            committed]
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decideEffectResume, type EffectLedgerRow } from '../graph/effect-lifecycle.js';
import { decideProviderFallover } from '../graph/provider-fallover.js';

function row(phase: EffectLedgerRow['phase'], ref?: string): EffectLedgerRow {
  return { effectId: 'ef', phase, at: '2026-08-04T00:00:00Z', ...(ref ? { ref } : {}) };
}

type ChatLedgerState =
  | 'no_reservation'
  | 'reserved_not_started'
  | 'orphaned_no_readback'
  | 'orphaned_with_readback'
  | 'succeeded';

function contractRows(state: ChatLedgerState): EffectLedgerRow[] {
  switch (state) {
    case 'no_reservation': return [];
    case 'reserved_not_started': return [row('reserved')];
    // A timed-out mutating write: dispatch started, no receipt — the harness
    // stopped waiting and the provider may or may not have committed.
    case 'orphaned_no_readback': return [row('reserved'), row('dispatch_started')];
    // The paired successful READ is the observation that resolves ambiguity.
    // (The read's ref is what proves the observation happened; the write's
    // provider receipt was never obtained, which is what made it an orphan —
    // observation without a receipt is modeled as receipt-from-observation.)
    case 'orphaned_with_readback': return [
      row('reserved'), row('dispatch_started'), row('provider_receipt', 'readback'),
      row('observed', 'readback'),
    ];
    case 'succeeded': return [
      row('reserved'), row('dispatch_started'), row('provider_receipt', 'result'),
      row('observed'), row('committed'),
    ];
  }
}

/** Transcribed live behavior at the chat tool boundary (brackets 2c1.5 + the
 *  eventlog orphan ledger). The corrective throws OrphanedWriteRetryError for
 *  a same-shape same-target mutating retry while an orphan is unresolved, and
 *  clears only on a paired successful read. */
const LIVE_ACTION: Record<ChatLedgerState, 'dispatch' | 'observe' | 'settled'> = {
  no_reservation: 'dispatch',
  reserved_not_started: 'dispatch',
  orphaned_no_readback: 'observe',   // retry refused; "read the target back first"
  orphaned_with_readback: 'settled', // the ORIGINAL effect is resolved by observation;
                                     // a conscious re-issue is a NEW effect identity
  succeeded: 'settled',
};

test('the chat tool boundary and the graph contract decide every state identically', () => {
  for (const state of Object.keys(LIVE_ACTION) as ChatLedgerState[]) {
    const decision = decideEffectResume(contractRows(state));
    const contractAction = decision.action === 'complete_commit' ? 'settled' : decision.action;
    assert.equal(contractAction, LIVE_ACTION[state],
      `divergence at "${state}": live does ${LIVE_ACTION[state]}, contract says ${decision.action} — `
      + 'the chat boundary and the graph contract must not carry two recovery policies');
  }
});

test('an unresolved orphan holds fallover — two brains cannot both "retry" a maybe-landed write', () => {
  const holding = decideProviderFallover({ 'ef-orphan': contractRows('orphaned_no_readback') });
  assert.equal(holding.action, 'observe_first');
  assert.deepEqual(
    (holding as Extract<typeof holding, { action: 'observe_first' }>).effectIds,
    ['ef-orphan'],
  );

  const cleared = decideProviderFallover({
    'ef-resolved': contractRows('orphaned_with_readback'),
    'ef-done': contractRows('succeeded'),
  });
  // 'orphaned_with_readback' maps to observed-not-committed, which the
  // contract treats as reconcile-before-new-work; a fully succeeded write
  // allows fallover freely. Either way, NOTHING in the turn is freely
  // re-dispatchable — which is the invariant.
  assert.notEqual(cleared.action, 'blocked');
});

test('read-back is the ONLY clearing authority — the live dedup cache never is', () => {
  // brackets.ts pins this in prose: the warn-dedup set "must never become
  // authority to dispatch another maybe-duplicate write." In contract terms:
  // an ambiguous ledger decides `observe` no matter how many times it is
  // consulted — repetition does not decay into permission.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(decideEffectResume(contractRows('orphaned_no_readback')).action, 'observe',
      `consultation ${i} decayed ambiguity into permission`);
  }
});
