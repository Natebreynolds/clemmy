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

test('a mutation the provider answered with its own refusal stays uncertain without replay, and is told apart from a dropped acknowledgement', async () => {
  const { classifyAttemptOutcome, providerAnsweredWithRefusal } = await import('./attempt-outcome.js');
  // Live 2026-10-07: Slack answered a reminder delete with `not_found` on a
  // delivered 200; the owner must hear words after a readback, not a block.
  const answered = classifyAttemptOutcome({ mutating: true, httpStatus: 200, envelopeSuccessful: false });
  assert.equal(answered.kind, 'uncertain_write');
  assert.equal(answered.detail, 'provider_refused_envelope');
  assert.equal(answered.directive.retrySameCandidate, false, 'provider bytes never earn a replay');
  assert.equal(answered.directive.requiresReconciliation, true, 'the ledger still owes reconciliation; the turn readers key on the detail');
  assert.equal(classifyAttemptOutcome({ mutating: true, acknowledged: false }).directive.requiresReconciliation, true, 'the dark still stops the turn');
  assert.equal(providerAnsweredWithRefusal(answered), true);
  const noStatus = classifyAttemptOutcome({ mutating: true, envelopeSuccessful: false });
  assert.equal(providerAnsweredWithRefusal(noStatus), true, 'an envelope without a transport status still answered');
  const dropped = classifyAttemptOutcome({ mutating: true, acknowledged: false });
  assert.equal(dropped.detail, 'unacknowledged_mutation');
  assert.equal(providerAnsweredWithRefusal(dropped), false);
  const serverError = classifyAttemptOutcome({ mutating: true, httpStatus: 502, envelopeSuccessful: false });
  assert.equal(serverError.detail, 'unacknowledged_mutation', 'a failed transport is the dark, not an answer');
  // Live 2026-10-09: a draft whose attachment the provider rejected came
  // back as a returned envelope carrying status 400; it was read as the dark
  // and the turn ended on a reconciliation block three times. A refusal
  // status is an answer: still uncertain, still no replay, but read.
  for (const status of [400, 404, 409, 422]) {
    const rejected = classifyAttemptOutcome({ mutating: true, httpStatus: status, envelopeSuccessful: false });
    assert.equal(rejected.kind, 'uncertain_write', `${status}`);
    assert.equal(rejected.detail, 'provider_refused_envelope', `a returned ${status} refusal is an answer`);
    assert.equal(rejected.directive.retrySameCandidate, false, `${status} earns no replay`);
  }
  assert.equal(classifyAttemptOutcome({ mutating: true, httpStatus: 400 }).detail, 'provider_refused_envelope', 'a refusal status with no success flag still answered');
  for (const status of [408, 429, 500, 503]) {
    assert.equal(classifyAttemptOutcome({ mutating: true, httpStatus: status, envelopeSuccessful: false }).detail, 'unacknowledged_mutation', `${status} is a failure or a transient, the dark`);
  }
  assert.equal(classifyAttemptOutcome({ mutating: true, httpStatus: 400, acknowledged: false }).detail, 'unacknowledged_mutation', 'a dropped acknowledgement outranks any status');
  // Every lane's own answered-failure facts read the same way: an MCP error
  // flag on a returned result, a completed command's non-zero exit.
  assert.equal(classifyAttemptOutcome({ mutating: true, providerReportedError: true }).detail, 'provider_refused_envelope', 'MCP isError on a write');
  assert.equal(classifyAttemptOutcome({ mutating: true, providerAnsweredFailure: true, executionFailed: true }).detail, 'provider_refused_envelope', 'a completed command that exited non-zero');
  assert.equal(classifyAttemptOutcome({ mutating: false, providerReportedError: true }).kind, 'unknown', 'a read keeps its own reading');
  const proven = classifyAttemptOutcome({ mutating: true, providerRejectedBeforeEffect: true });
  assert.equal(providerAnsweredWithRefusal(proven), false, 'a trusted pre-effect proof is a different, stronger reading');
});
