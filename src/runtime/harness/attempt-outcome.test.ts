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
