/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/carrier-field-lift.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { liftNestedCarrierFields } from './carrier-field-lift.js';

test('the carrier\'s own fields nested in args_json move back out; the target keeps only its own arguments', () => {
  // Live 2026-10-09 shape.
  const live = {
    name: 'run_shell_command', universe_item_id: null, universe_selector: null, seal_amendment: null,
    source_call_ids: null, source_record_ids: null,
    args_json: JSON.stringify({ command: 'curl -sL -o /tmp/a.png https://x.test/a.png', name: 'run_shell_command',
      requirement_id: 'cap:local:run_shell_command:ordinary', seal_amendment: null, source_call_ids: [], source_record_ids: null,
      universe_item_id: null, universe_selector: null }),
  };
  const lifted = liftNestedCarrierFields(JSON.stringify(live))!;
  const outer = JSON.parse(lifted.argumentsJson);
  assert.equal(outer.name, 'run_shell_command');
  assert.equal(outer.requirement_id, 'cap:local:run_shell_command:ordinary', 'an empty carrier field takes the nested value');
  assert.deepEqual(JSON.parse(outer.args_json), { command: 'curl -sL -o /tmp/a.png https://x.test/a.png' });
  assert.equal(lifted.target, 'run_shell_command');
  assert.match(lifted.changes[0]!, /moved requirement_id/);
});

test('a well-formed carrier, a target with its own name parameter, and a conflicting name are left alone', () => {
  const clean = { name: 'run_shell_command', requirement_id: 'cap:local:run_shell_command:ordinary', args_json: JSON.stringify({ command: 'ls' }) };
  assert.equal(liftNestedCarrierFields(JSON.stringify(clean)), null);
  const ownName = { name: 'create_folder', requirement_id: 'x', args_json: JSON.stringify({ name: 'Reports', parent: '/x' }) };
  assert.equal(liftNestedCarrierFields(JSON.stringify(ownName)), null, 'a target\'s own `name` is not a carrier field');
  const conflict = { name: 'a_tool', args_json: JSON.stringify({ name: 'b_tool', requirement_id: 'r' }) };
  assert.equal(liftNestedCarrierFields(JSON.stringify(conflict)), null);
  const keepsOuter = { name: 't', requirement_id: 'outer', args_json: JSON.stringify({ requirement_id: 'inner', q: 1 }) };
  const lifted = JSON.parse(liftNestedCarrierFields(JSON.stringify(keepsOuter))!.argumentsJson);
  assert.equal(lifted.requirement_id, 'outer', 'a field the carrier already set is never overwritten');
  assert.deepEqual(JSON.parse(lifted.args_json), { q: 1 });
  assert.equal(liftNestedCarrierFields('not json'), null);
});

test('args_json sent as the object itself is encoded once instead of refused', () => {
  // Live 2026-10-09 shape: a read through call_tool with its arguments as an object.
  const target = { call_id: 'call_1', path: '/data/pageElements', fields: ['objectId', 'image'], limit: 50,
    where: [{ field: 'objectId', op: 'contains', value: 'SLIDES_API' }] };
  const lifted = liftNestedCarrierFields(JSON.stringify({ name: 'tool_output_query', args_json: target }))!;
  const outer = JSON.parse(lifted.argumentsJson);
  assert.equal(typeof outer.args_json, 'string');
  assert.deepEqual(JSON.parse(outer.args_json), target, 'the document is unchanged, only encoded');
  assert.equal(outer.name, 'tool_output_query');
  assert.equal(lifted.target, 'tool_output_query');
  assert.match(lifted.changes[0]!, /encoded args_json once/);
  const ownName = liftNestedCarrierFields(JSON.stringify({ name: 'create_folder', args_json: { name: 'Reports' } }))!;
  assert.deepEqual(JSON.parse(JSON.parse(ownName.argumentsJson).args_json), { name: 'Reports' }, 'a target\'s own `name` survives');
  const both = JSON.parse(liftNestedCarrierFields(JSON.stringify({ name: 't', args_json: { requirement_id: 'r', q: 1 } }))!.argumentsJson);
  assert.equal(both.requirement_id, 'r');
  assert.deepEqual(JSON.parse(both.args_json), { q: 1 });
  assert.equal(liftNestedCarrierFields(JSON.stringify({ args_json: { q: 1 } })), null, 'no target named: the schema refusal stays');
  assert.equal(liftNestedCarrierFields(JSON.stringify({ name: 't', args_json: [1] })), null, 'an array is not an argument object');
});

test('a field the carrier does not have, sent empty, is dropped; one with a value is left for the schema', () => {
  // Live 2026-10-10 shape: a shell write whose carrier carried `record_ids: null`.
  const live = { name: 'run_shell_command', record_ids: null, requirement_id: 'cap:local:run_shell_command:ordinary',
    seal_amendment: null, source_call_ids: null, source_record_ids: null, universe_item_id: null, universe_selector: null,
    args_json: JSON.stringify({ command: 'ls', cwd: null, timeout_ms: null }) };
  const lifted = liftNestedCarrierFields(JSON.stringify(live))!;
  const outer = JSON.parse(lifted.argumentsJson);
  assert.equal('record_ids' in outer, false);
  assert.deepEqual({ ...outer, record_ids: null }, live, 'nothing else changes');
  assert.equal(lifted.target, 'run_shell_command');
  assert.match(lifted.changes[0]!, /dropped record_ids/);
  for (const empty of [[], '']) {
    assert.equal('extra' in JSON.parse(liftNestedCarrierFields(JSON.stringify({ ...live, record_ids: undefined, extra: empty }))!.argumentsJson), false);
  }
  assert.equal(liftNestedCarrierFields(JSON.stringify({ ...live, record_ids: ['r1'] })), null, 'a stray field with a value is not guessed at');
  const clean = { ...live } as Record<string, unknown>;
  delete clean.record_ids;
  assert.equal(liftNestedCarrierFields(JSON.stringify(clean)), null, 'a well-formed carrier is untouched');
  assert.equal(liftNestedCarrierFields(JSON.stringify({ ...clean, proposal: null })), null, 'proposal is the carrier\'s own field');
});
