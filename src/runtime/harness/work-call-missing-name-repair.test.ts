/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/work-call-missing-name-repair.test.ts
 *
 * A work_call that left out its own `name` while its requirement_id selects
 * one local operation is told exactly which name to set, not sent to discovery.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-work-call-name-repair-'));
const { carrierMissingNameRepair, carrierTargetShapeRepair } = await import('./host-turn-runner.js');

test('a work_call without its own name is told the local operation its requirement selects', () => {
  const args = {
    requirement_id: 'cap:local:workflow_edit_step:reversible',
    args_json: '{"name":"fixture-workflow","step_id":"extract","patch":"{}"}',
  };
  const repair = carrierMissingNameRepair('work_call', args);
  assert.match(repair ?? '', /`name` is missing\. Set name to "workflow_edit_step"/);
  assert.match(repair ?? '', /keep args_json to that operation's own arguments/);
  assert.match(repair ?? '', /No local or external mutation was attempted/);
});

test('it says nothing when the name is present, the carrier differs, or the requirement is not one local operation', () => {
  const requirement_id = 'cap:local:workflow_edit_step:reversible';
  assert.equal(carrierMissingNameRepair('work_call', { requirement_id, name: 'workflow_edit_step', args_json: '{}' }), null);
  assert.equal(carrierMissingNameRepair('call_tool', { requirement_id, args_json: '{}' }), null);
  assert.equal(carrierMissingNameRepair('work_call', { requirement_id: 'cap:resolved:gmail_send_email', args_json: '{}' }), null);
  assert.equal(carrierMissingNameRepair('work_call', { requirement_id: 'cap:local:bad name:x', args_json: '{}' }), null);
  assert.equal(carrierMissingNameRepair('work_call', null), null);
});

// Live 2026-10-24: a memory correction's first two shapes, both refused
// effect_unknown with no repair before the third try ran.
test('a call_tool with no name is told its name is missing', () => {
  const repair = carrierTargetShapeRepair('call_tool', {
    args_json: { kind: 'project', content: 'Fixture project "Lilac Kite": the color is COPPER.' },
  });
  assert.match(repair ?? '', /`name` is missing\. Set name to the tool these arguments are for/);
  assert.match(repair ?? '', /No local or external mutation was attempted/);
});

test('a carrier whose args_json is a whole second call is told to send that call directly', () => {
  const nested = JSON.stringify({ name: 'memory_remember', args_json: { kind: 'project', content: 'Fixture.' } });
  for (const carrier of ['work_call', 'call_tool'] as const) {
    const repair = carrierTargetShapeRepair(carrier, { name: 'tool_call', args_json: nested });
    assert.match(repair ?? '', /args_json holds a whole second call/);
    assert.match(repair ?? '', /Send that inner call directly/);
    assert.doesNotMatch(repair ?? '', /memory_remember/, 'no tool is named from the model\'s text');
  }
});

test('the shape repair says nothing for a well-formed carrier or a non-carrier', () => {
  assert.equal(carrierTargetShapeRepair('call_tool', { name: 'memory_remember', args_json: '{"kind":"project","content":"x"}' }), null);
  assert.equal(carrierTargetShapeRepair('work_call', { requirement_id: 'cap:local:x:y', args_json: '{}' }), null,
    'a nameless work_call keeps its own requirement-based repair');
  assert.equal(carrierTargetShapeRepair('memory_remember', { args_json: '{}' }), null);
  assert.equal(carrierTargetShapeRepair('call_tool', 'not an object'), null);
});
