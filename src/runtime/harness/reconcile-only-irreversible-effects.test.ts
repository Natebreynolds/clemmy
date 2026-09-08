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
