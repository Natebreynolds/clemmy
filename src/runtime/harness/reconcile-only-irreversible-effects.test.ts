/**
 * The uncertain-effect HARD BLOCK is reserved for the irreversible boundary.
 *
 * Live 2026-09-08: the owner's platform-49 workflow blocked at "main" with
 * "the tool stopped after execution may have begun … its effect must be
 * reconciled" — for space_refresh, a NON-MUTATING rebuild of a LOCAL space
 * view (settled kind: succeeded, mutating: false). A settlement that asks for
 * reconciliation now hard-blocks the turn only when the call's effect is an
 * external write or an admin action — the boundary that can half-land and
 * cannot simply be re-run. Reads, compute, and LOCAL writes (spaces, memory —
 * inside Clem's own home) are correctable in place and never hard-block.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./host-turn-runner.ts', import.meta.url), 'utf8');

test('settlementRequiresReconciliation is gated on the irreversible boundary', () => {
  assert.match(
    SRC,
    /settlementRequiresReconciliation =\s*\n\s*invoked\.settlement\.outcome\.directive\.requiresReconciliation === true\s*\n\s*&& \(effect === 'external_write' \|\| effect === 'admin'\);/,
    'a local write or read that may have started must not hard-block; only external_write/admin reconcile',
  );
});

test('after invocation the immutable settlement owns the crossing disposition; only a proven pre-dispatch refusal with zero crossings is zero-crossing', () => {
  // Live 2026-09-08 first made a failed/cancelled LOCAL write or host-only
  // carrier zero-crossing by effect class alone. Live 2026-09-09 reversed
  // that: an unresolved worker timeout classified as "no effect" disagreed
  // with checkpoint admission (which required reconciliation) and the turn
  // looped on finalization instead of letting the model continue. The effect
  // class does not prove that children drained or that a local write never
  // landed; the settlement does. Cooperative worker parks still return their
  // exact remainder normally (see host-turn-runner.test.ts, "an unresolved
  // worker timeout checkpoints its actual uncertainty once without replay").
  assert.doesNotMatch(
    SRC,
    /const effect = currentFrameEffects\.get\(call\.callId\);\s*\n\s*if \(effect === 'local_write' \|\| effect === 'host_only'\) return 'zero_crossing';/,
    'an effect class must not short-circuit the settlement-owned disposition',
  );
  assert.match(
    SRC,
    /if \(!attempt\.invocationEntered\) return 'zero_crossing';[\s\S]{0,1200}settlement\.executionKind === 'refused_pre_dispatch'\s*\n\s*&& settlement\.physicalCrossingCount === 0\s*\n\s*&& settlement\.hostCrossingCount === 0\s*\n\s*\) return 'zero_crossing';/,
    'before invoke: zero-crossing; after invoke: only an exact refused_pre_dispatch settlement with zero crossings',
  );
});
