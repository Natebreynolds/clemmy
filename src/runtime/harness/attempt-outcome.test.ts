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

test('only trusted exact rejection proof turns a returned mutation failure into a repairable rejection', () => {
  // Live 2026-10-06: SLACK_DELETE_REMINDER answered { successful: false,
  // error: 'Slack API error: not_found', data: { status_code: 200 } } for a
  // reminder that was already gone; the turn stopped "uncertain".
  const refused = classifyAttemptOutcome({ httpStatus: 200, envelopeSuccessful: false, mutating: true, acknowledged: false, providerRejectedBeforeEffect: true });
  assert.equal(refused.kind, 'invalid_arguments');
  assert.equal(refused.detail, 'provider_rejected_before_effect');
  assert.equal(refused.directive.action, 'repair_arguments');
  assert.equal(refused.directive.requiresReconciliation, false);
  // Without a transport status, or with a 5xx, the write may have landed.
  assert.equal(classifyAttemptOutcome({ envelopeSuccessful: false, mutating: true, acknowledged: false }).kind, 'uncertain_write');
  assert.equal(classifyAttemptOutcome({ httpStatus: 500, envelopeSuccessful: false, mutating: true, acknowledged: false }).kind, 'uncertain_write');
  for (const status of [200, 400, 401, 403, 404, 405, 422, 501]) {
    assert.equal(classifyAttemptOutcome({ httpStatus: status, envelopeSuccessful: false, mutating: true, acknowledged: false }).kind, 'uncertain_write', `generic ${status} failure may follow a partial commit`);
  }
  assert.equal(classifyAttemptOutcome({ httpStatus: 404, envelopeSuccessful: false, mutating: false }).kind, 'unsupported_capability', 'read error semantics remain intact');
  assert.equal(classifyAttemptOutcome({ providerRejectedBeforeEffect: true, providerEnvelopeContradicted: true, mutating: true }).kind, 'uncertain_write', 'contradictory evidence outranks rejection');
  // A 2xx that the provider calls successful is still a success.
  assert.equal(classifyAttemptOutcome({ httpStatus: 200, envelopeSuccessful: true, mutating: true }).kind, 'succeeded');
});
