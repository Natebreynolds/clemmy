import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowResultSteps } from './workflow-result-steps.js';

test('delivers terminal calculations while retaining independent branch results', () => {
  const steps = [{ id: 'read' }, { id: 'sum', dependsOn: ['read'] }, { id: 'other' }];
  assert.deepEqual(workflowResultSteps(steps, { read: 'raw rows', sum: 0, other: false }).map(s => s.id), ['sum', 'other']);
});

test('incomplete terminal steps preserve available partial results', () => {
  const steps = [{ id: 'read' }, { id: 'sum', dependsOn: ['read'] }];
  assert.deepEqual(workflowResultSteps(steps, { read: 'retained rows' }).map(s => s.id), ['read']);
  assert.deepEqual(workflowResultSteps([{ id: 'a' }, { id: 'b' }], { a: 1, b: 2 }).map(s => s.id), ['a', 'b']);
});
