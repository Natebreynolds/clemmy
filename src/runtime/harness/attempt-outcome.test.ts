import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAttemptOutcome } from './attempt-outcome.js';

test('a mutation that succeeded with an empty body is acknowledged work, never an empty answer to shop around', () => {
  // Live 2026-10-06: OUTLOOK_DELETE_MESSAGE answered { data: {}, successful: true }
  // and settled as empty_result → try_sibling_candidate; Clem then asked the
  // owner to check Outlook by hand for a draft she had verified was gone.
  const envelope = classifyAttemptOutcome({ envelopeSuccessful: true, emptyResult: true, mutating: true });
  assert.equal(envelope.kind, 'succeeded');
  assert.equal(envelope.detail, 'envelope_acknowledged_empty');
  const http = classifyAttemptOutcome({ httpStatus: 204, emptyResult: true, mutating: true });
  assert.equal(http.kind, 'succeeded');
  // A read that came back empty is still an empty answer.
  assert.equal(classifyAttemptOutcome({ envelopeSuccessful: true, emptyResult: true }).kind, 'empty_result');
  assert.equal(classifyAttemptOutcome({ httpStatus: 200, emptyResult: true, mutating: false }).kind, 'empty_result');
});

test('a mutation the provider refused with a 2xx underneath is a repairable rejection, not an uncertain write', () => {
  // Live 2026-10-06: SLACK_DELETE_REMINDER answered { successful: false,
  // error: 'Slack API error: not_found', data: { status_code: 200 } } for a
  // reminder that was already gone; the turn stopped "uncertain".
  const refused = classifyAttemptOutcome({ httpStatus: 200, envelopeSuccessful: false, mutating: true, acknowledged: false });
  assert.equal(refused.kind, 'invalid_arguments');
  assert.equal(refused.detail, 'envelope_rejected');
  assert.equal(refused.directive.action, 'repair_arguments');
  assert.equal(refused.directive.requiresReconciliation, false);
  // Without a transport status, or with a 5xx, the write may have landed.
  assert.equal(classifyAttemptOutcome({ envelopeSuccessful: false, mutating: true, acknowledged: false }).kind, 'uncertain_write');
  assert.equal(classifyAttemptOutcome({ httpStatus: 500, envelopeSuccessful: false, mutating: true, acknowledged: false }).kind, 'uncertain_write');
  // A 2xx that the provider calls successful is still a success.
  assert.equal(classifyAttemptOutcome({ httpStatus: 200, envelopeSuccessful: true, mutating: true }).kind, 'succeeded');
});
