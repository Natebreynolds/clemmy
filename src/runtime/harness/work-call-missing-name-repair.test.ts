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
const { carrierMissingNameRepair } = await import('./host-turn-runner.js');

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
