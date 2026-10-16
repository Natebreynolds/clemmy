/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-run-inventory.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-run-inventory-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const inventory = await import('./workflow-run-inventory.js');

test.after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

function write(id: string, record: Record<string, unknown>): void {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${id}.json`), JSON.stringify({ id, ...record }));
}

test('the inventory keeps light fields, newest first, and a run that finishes changes its workflow\'s signature', () => {
  inventory._resetWorkflowRunInventoryForTests();
  write('run-a', { workflow: 'flow', status: 'running', createdAt: '2026-10-16T01:00:00.000Z',
    stepOutputs: { gather: 'x'.repeat(50_000) }, workflowDefinitionSnapshot: { version: 1, definitionHash: 'h1', definition: { steps: [] } },
    output: 'big', reportBack: { outcome: 'done', detail: 'long' } });
  write('run-b', { workflow: 'other', status: 'completed', createdAt: '2026-10-16T02:00:00.000Z' });

  const entries = inventory.workflowRunInventory();
  assert.deepEqual(entries.map((entry) => entry.record.id), ['run-b', 'run-a']);
  const a = entries.find((entry) => entry.record.id === 'run-a')!.record;
  assert.equal(a.stepOutputs, undefined);
  assert.equal(a.output, undefined);
  assert.deepEqual(a.stepOutputKeys, ['gather']);
  assert.deepEqual(a.workflowDefinitionSnapshot, { version: 1, definitionHash: 'h1' });
  assert.deepEqual(a.reportBack, { outcome: 'done' });

  const before = inventory.workflowRunInventorySignature(['flow']);
  const otherBefore = inventory.workflowRunInventorySignature(['other']);
  write('run-a', { workflow: 'flow', status: 'completed', finishedAt: '2026-10-16T01:05:00.000Z', createdAt: '2026-10-16T01:00:00.000Z' });
  assert.notEqual(inventory.workflowRunInventorySignature(['flow']), before, 'an existing run finishing is a change');
  assert.equal(inventory.workflowRunInventorySignature(['other']), otherBefore, 'another workflow\'s signature is untouched');
  assert.equal(inventory.workflowRunInventory().find((entry) => entry.record.id === 'run-a')!.record.status, 'completed');

  unlinkSync(path.join(WORKFLOW_RUNS_DIR, 'run-b.json'));
  assert.deepEqual(inventory.workflowRunInventory().map((entry) => entry.record.id), ['run-a']);
});
