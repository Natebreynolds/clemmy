import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_WORKFLOW_RUN_CONCURRENCY,
  resolveWorkflowRunConcurrency,
} from './workflow-run-concurrency.js';

test('workflow run concurrency has one shared, non-vacuous runtime/console clamp', () => {
  assert.equal(MAX_WORKFLOW_RUN_CONCURRENCY, 4);
  for (const [raw, expected] of [
    ['1', 1],
    ['3', 3],
    ['4', 4],
    ['50', 4],
    ['0', 1],
    ['-3', 1],
    ['nonsense', 1],
    ['', 1],
  ] as const) {
    assert.equal(resolveWorkflowRunConcurrency(raw), expected, `${raw} resolves to ${expected}`);
  }
});
