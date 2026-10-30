import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowRowStatus } from './workflow-status.js';

const row = (over: Partial<Parameters<typeof workflowRowStatus>[0]>) => ({ enabled: true, lastRunOutcome: null, lastRunStatus: null, lastRunGoalOutcome: null, ...over });

test('an automation reads as on or off, running, or needing you; never how its last run went', () => {
  assert.deepEqual(workflowRowStatus(row({ enabled: false })), { key: 'off', label: 'Off' });
  assert.equal(workflowRowStatus({ ...row({ lastRunOutcome: 'succeeded' }), schedule: '0 8 * * 1-5' }).label, 'On', 'a repeating automation that ran fine is simply on');
  assert.equal(workflowRowStatus(row({ lastRunGoalOutcome: 'gap', lastRunOutcome: 'succeeded' })).label, 'On demand');
  assert.equal(workflowRowStatus(row({ lastRunOutcome: 'blocked' })).label, 'Needs you');
  assert.equal(workflowRowStatus(row({ lastRunStatus: 'blocked_readiness' })).label, 'Needs you');
  assert.equal(workflowRowStatus(row({ lastRunStatus: 'awaiting_input' })).label, 'Needs you');
  assert.equal(workflowRowStatus(row({ lastRunStatus: 'running' })).label, 'Running');
  assert.equal(workflowRowStatus(row({ lastRunStatus: 'paused_budget' })).label, 'Paused');
  assert.equal(workflowRowStatus(row({ lastRunOutcome: 'failed' })).label, 'Didn’t finish');
  assert.equal(workflowRowStatus(row({ lastRunStatus: 'error' })).label, 'Didn’t finish');
});

test('an automation that never ran is On with a schedule and On demand without one', () => {
  assert.equal(workflowRowStatus({ ...row({}), schedule: { kind: 'cron' } }).label, 'On');
  assert.equal(workflowRowStatus(row({})).label, 'On demand');
  assert.equal(workflowRowStatus(row({ lastRunStatus: 'creation_test' })).label, 'On demand', 'an unknown engine word is never shown raw');
});
