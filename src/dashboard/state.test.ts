/**
 * Run: npx tsx --test src/dashboard/state.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-dashboard-state-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { loadWorkflows } = await import('./state.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('loadWorkflows reads directory-format workflow-store entries', () => {
  writeWorkflow('dashboard-state-flow', {
    name: 'Dashboard State Flow',
    description: 'Directory-format workflow visible to dashboard state.',
    enabled: true,
    trigger: { manual: true, schedule: '0 9 * * *' },
    steps: [{ id: 'brief', prompt: 'Build the brief.' }],
  });

  const workflows = loadWorkflows();
  const row = workflows.find((workflow) => workflow.name === 'Dashboard State Flow');
  assert.ok(row, 'directory-format workflow is listed');
  assert.equal(row!.description, 'Directory-format workflow visible to dashboard state.');
  assert.equal(row!.enabled, true);
  assert.deepEqual(row!.trigger, { manual: true, schedule: '0 9 * * *' });
  assert.deepEqual(row!.steps, [{ id: 'brief', prompt: 'Build the brief.' }]);
});
