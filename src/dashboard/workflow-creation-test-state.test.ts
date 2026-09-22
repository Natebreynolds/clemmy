/**
 * Run: npx tsx --test src/dashboard/workflow-creation-test-state.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowCreationTestState } from './workflow-creation-test-state.js';

const rows = [
  { id: 'a', body: 'older failed', createdAt: '2026-09-22T08:00:00.000Z', metadata: { creationTest: true, workflow: 'Digest check', runId: 'r1', pass: false } },
  { id: 'b', body: '✅ Creation test passed', createdAt: '2026-09-22T09:00:00.000Z', metadata: { creationTest: true, workflow: 'Digest check', runId: 'r2', pass: true } },
  { id: 'c', body: 'other workflow', createdAt: '2026-09-22T10:00:00.000Z', metadata: { creationTest: true, workflow: 'Other', runId: 'r3', pass: false } },
  { id: 'd', body: 'not a test', createdAt: '2026-09-22T11:00:00.000Z', metadata: { workflow: 'Digest check' } },
];

test('a pending run for this definition is "running" regardless of older reports', () => {
  assert.deepEqual(workflowCreationTestState({ workflowName: 'Digest check', pendingRunId: 'r9', notifications: rows }), { runId: 'r9', status: 'running' });
});

test('the newest settled report for THIS workflow wins, with the daemon\'s own body', () => {
  assert.deepEqual(workflowCreationTestState({ workflowName: 'Digest check', notifications: rows }), {
    runId: 'r2', status: 'passed', body: '✅ Creation test passed', at: '2026-09-22T09:00:00.000Z',
  });
  assert.equal(workflowCreationTestState({ workflowName: 'Other', notifications: rows })?.status, 'needs_review');
  assert.equal(workflowCreationTestState({ workflowName: 'Nothing', notifications: rows }), null);
});
