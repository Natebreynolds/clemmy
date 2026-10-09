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
