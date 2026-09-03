/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/attempt-settlement.test.ts
 *
 * Settlement signal extraction — what a payload is allowed to prove about
 * itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// "A string payload never settles success" is right about PROSE and wrong about
// a serialized envelope. negativeStringEnvelope already parsed a JSON string to
// settle successful:false, so an envelope claiming failure was trusted while the
// byte-identical one claiming success was not.
//
// Live 2026-09-03: thirteen consecutive provider calls returned
// {"error": null, "successful": true, ...} with real data and a billed cost,
// crossed the carrier as rendered text, and every one settled
// unknown/execution_failed. The provider was fine; the model was told its tool
// was down and the paid results were discarded.
test('a serialized envelope that states its own success is recognized', async () => {
  const { positiveStringEnvelope } = await import('./attempt-settlement.js');
  assert.equal(positiveStringEnvelope(JSON.stringify({
    data: { cost: 0.024036, status_code: 20000, status_message: 'Ok.' },
    error: null,
    successful: true,
    logId: 'log_7JtHarc2G6EL',
  })), true);
  // Same tolerance for a one-level wrapper as the other string markers.
  assert.equal(positiveStringEnvelope({ output: '{"successful":true,"error":null}' }), true);
});

test('prose settles nothing, and a contradicted envelope is not a success', async () => {
  const { positiveStringEnvelope } = await import('./attempt-settlement.js');
  // The 2026-08-26 gauntlet shape (~249 calls settling succeeded off bare
  // strings) is why the blanket rule exists; it must stay closed.
  assert.equal(positiveStringEnvelope('Ok. Everything worked.'), false);
  assert.equal(positiveStringEnvelope('{"partial": '), false, 'unparseable is not an envelope');
  assert.equal(positiveStringEnvelope('[{"successful":true}]'), false, 'an array is not an envelope');
  // Truthy is not true.
  assert.equal(positiveStringEnvelope('{"successful":"yes"}'), false);
  assert.equal(positiveStringEnvelope('{"successful":1}'), false);
  // An envelope that contradicts itself is not a success.
  assert.equal(positiveStringEnvelope('{"successful":true,"error":"rate limited"}'), false);
  // And an explicit failure is never read as success.
  assert.equal(positiveStringEnvelope('{"successful":false,"error":"nope"}'), false);
});
