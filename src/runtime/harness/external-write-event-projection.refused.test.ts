/**
 * A write the provider refused at its own layer (2xx + "not successful") is
 * a known failure in the write ledger, never an orphaned/uncertain write.
 * Live 2026-10-06: a Slack reminder delete answered not_found and the turn
 * after it read "an irreversible write that hasn't been reconciled".
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/external-write-event-projection.refused.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAttemptOutcome } from './attempt-outcome.js';
import { externalWriteTerminalForAttemptOutcome } from './external-write-event-projection.js';

test('a provider-refused mutation projects as a failed write, not an orphaned one', () => {
  const refused = classifyAttemptOutcome({ httpStatus: 200, envelopeSuccessful: false, mutating: true, acknowledged: false });
  assert.equal(refused.detail, 'envelope_rejected');
  assert.equal(externalWriteTerminalForAttemptOutcome(refused, 'returned', { hasDurableResultHandle: false }), 'external_write_failed');
  // Without a transport status the fate is unknown and stays orphaned.
  const unknown = classifyAttemptOutcome({ envelopeSuccessful: false, mutating: true, acknowledged: false });
  assert.equal(externalWriteTerminalForAttemptOutcome(unknown, 'returned', { hasDurableResultHandle: false }), 'external_write_orphaned');
  // A 404 still proves rejection before effect, as before.
  const notFound = classifyAttemptOutcome({ httpStatus: 404, mutating: true, acknowledged: false });
  assert.equal(externalWriteTerminalForAttemptOutcome(notFound, 'returned', { hasDurableResultHandle: false }), 'external_write_failed');
});
