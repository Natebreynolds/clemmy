/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/carrier-json.test.ts
 *
 * Windows tester trace 2026-10-19 (fictional fixtures here): an account-blocked
 * send was retried with one more JSON-encoding layer; one reader decoded it,
 * another did not, and recovery named WORK_CALL as the missing operation. Every
 * carrier reader now shares one bounded reading, and recovery never mistakes a
 * carrier for a business operation.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-carrier-json-'));
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const { readCarrierJsonSlot, carrierArgumentsProblem, MAX_CARRIER_JSON_LAYERS } = await import('./carrier-json.js');
const { readModelCarrier } = await import('./carrier-reader.js');
const { unwrapRuntimeEffectiveToolIdentity, providerOperationFromNameForm } = await import('./tool-effect.js');
const { carrierInnerJsonProblem, refusedCallRequestedOperation, hostProvenOperationRepair } = await import('./host-turn-runner.js');

const OPERATION = 'FIXTURE_SEND_NOTE';
const BODY = {
  to: 'dana@fixture.invalid',
  subject: 'TEST FIXTURE follow-up',
  // Text that looks like JSON, quoted words and markup are message content.
  body: '<p>Hi Dana, "quoted" words stay quoted.</p> {"not":"arguments"}',
  note: '"already quoted"',
};
const payload = { tool_slug: OPERATION, arguments: JSON.stringify(BODY) };
/** The gateway payload encoded `times` times (1 is the contract). */
function encoded(times: number): string {
  let value: string = JSON.stringify(payload);
  for (let index = 1; index < times; index += 1) value = JSON.stringify(value);
  return value;
}
function workCall(argsJson: string) {
  return { requirement_id: 'cap:resolved:fixture_send_note:definition:abc123', name: 'composio_execute_tool', args_json: argsJson };
}

test('a carrier slot is read the same by every reader, up to the bound', () => {
  const allowed = MAX_CARRIER_JSON_LAYERS + 1;
  for (let times = 1; times <= allowed + 1; times += 1) {
    const args = workCall(encoded(times));
    const read = readModelCarrier('work_call', args);
    const effective = unwrapRuntimeEffectiveToolIdentity('work_call', args);
    const problem = carrierInnerJsonProblem(args);
    const requested = refusedCallRequestedOperation('work_call', args);
    if (times <= allowed) {
      assert.equal(read.operation, OPERATION, `reader, ${times} encodings`);
      assert.equal(effective.toolName, OPERATION, `effective identity, ${times} encodings`);
      assert.equal(problem, null, `shape check, ${times} encodings`);
      assert.equal(requested, OPERATION, `recovery, ${times} encodings`);
      assert.deepEqual(read.arguments, BODY, `arguments unchanged, ${times} encodings`);
      assert.deepEqual(effective.args, BODY, `effective arguments unchanged, ${times} encodings`);
    } else {
      assert.equal(read.operation, null, 'past the bound no reader names an operation');
      assert.equal(effective.toolName, null);
      assert.match(problem ?? '', new RegExp(`JSON-encoded more than ${allowed} times`));
      assert.equal(requested, '', 'and recovery does not guess one');
    }
  }
});

test('malformed and non-object slots get one precise diagnosis', () => {
  const cases: Array<[string, RegExp]> = [
    ['', /empty string/],
    ['{"tool_slug": "FIXTURE_SEND_NOTE", "arguments": ', /not valid JSON/],
    ['plain words, not JSON', /not valid JSON/],
    ['["FIXTURE_SEND_NOTE"]', /decodes to a list/],
    ['42', /decodes to a single value/],
    [JSON.stringify('just a sentence'), /not valid JSON/],
    [JSON.stringify(JSON.stringify(7)), /decodes to a single value/],
  ];
  for (const [slot, diagnosis] of cases) {
    const args = workCall(slot);
    assert.match(carrierInnerJsonProblem(args) ?? '', diagnosis, slot);
    assert.match(carrierArgumentsProblem(slot) ?? '', diagnosis, slot);
    assert.equal(readModelCarrier('work_call', args).operation, null, slot);
    assert.equal(refusedCallRequestedOperation('work_call', args), '', `${slot}: never WORK_CALL`);
  }
  assert.equal(carrierArgumentsProblem({ tool_slug: OPERATION }), null, 'an object slot is already arguments');
  assert.deepEqual(readCarrierJsonSlot(encoded(2)), { ok: true, value: payload, layers: 2 });
});

test('a carrier, the gateway or a built-in tool is never named as the business operation', () => {
  for (const name of ['work_call', 'WORK_CALL', 'call_tool', 'composio_execute_tool', 'run_shell_command', 'tool_search']) {
    assert.equal(providerOperationFromNameForm(name), null, name);
  }
  assert.equal(providerOperationFromNameForm('FIXTURE_SEND_NOTE'), OPERATION);
  assert.equal(providerOperationFromNameForm('composio:fixture_send_note'), OPERATION);
  assert.equal(refusedCallRequestedOperation('work_call', { requirement_id: 'FIXTURE_SEND_NOTE', name: 'composio_execute_tool', args_json: '{' }),
    OPERATION, 'a slug-shaped requirement id still names the operation');
});

test('the trace sequence: an over-encoded retry of an account-blocked send gets the account question, not rediscovery', () => {
  // First refusal and its retry with one more encoding layer both name the same
  // operation, so the open account blocker explains both.
  const first = refusedCallRequestedOperation('work_call', workCall(encoded(1)));
  const retry = refusedCallRequestedOperation('work_call', workCall(encoded(2)));
  assert.equal(first, OPERATION);
  assert.equal(retry, OPERATION, 'the retry is the same send, not a call to WORK_CALL');
  const guidance = hostProvenOperationRepair({
    requestedOperation: retry, provenOperations: [],
    accountChoices: ['fixture-work@fixture.invalid'], accountChoiceLabels: { 'fixture-work@fixture.invalid': 'Fixture Work' },
    accountSelectionReason: 'not_entailed',
  });
  assert.match(guidance, /FIXTURE_SEND_NOTE is available/);
  assert.match(guidance, /ask_user_question once, offering these connected accounts by name: Fixture Work/);
  assert.match(guidance, /Do not send this call again/);
  assert.doesNotMatch(guidance, /WORK_CALL/);
});
