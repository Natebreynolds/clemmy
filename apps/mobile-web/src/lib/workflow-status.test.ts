import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowRowStatus } from './workflow-status.js';

const row = (over: Partial<Parameters<typeof workflowRowStatus>[0]>) => ({ enabled: true, lastRunOutcome: null, lastRunStatus: null, lastRunGoalOutcome: null, ...over });

test('engine statuses and outcomes land in the six product words', () => {
  assert.deepEqual(workflowRowStatus(row({ enabled: false })), { key: 'off', label: 'Off' });
  assert.equal(workflowRowStatus(row({ lastRunOutcome: 'succeeded' })).label, 'Done');
  assert.equal(workflowRowStatus(row({ lastRunOutcome: 'blocked' })).label, 'Needs you');
  assert.equal(workflowRowStatus(row({ lastRunStatus: 'blocked_readiness' })).label, 'Needs you');
  assert.equal(workflowRowStatus(row({ lastRunStatus: 'awaiting_input' })).label, 'Needs you');
  assert.equal(workflowRowStatus(row({ lastRunStatus: 'running' })).label, 'Working');
  assert.equal(workflowRowStatus(row({ lastRunStatus: 'paused_budget' })).label, 'Paused');
  assert.equal(workflowRowStatus(row({ lastRunOutcome: 'failed' })).label, 'Failed');
  assert.equal(workflowRowStatus(row({ lastRunStatus: 'error' })).label, 'Failed');
  assert.equal(workflowRowStatus(row({ lastRunGoalOutcome: 'gap', lastRunOutcome: 'succeeded' })).label, 'Done, with a gap');
});

test('a workflow that never ran is Scheduled when it has a schedule and Ready when it waits for you', () => {
  assert.equal(workflowRowStatus({ ...row({}), schedule: { kind: 'cron' } }).label, 'Scheduled');
  assert.equal(workflowRowStatus(row({})).label, 'Ready');
  assert.equal(workflowRowStatus(row({ lastRunStatus: 'creation_test' })).label, 'Ready', 'an unknown engine word is never shown raw');
});
