import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clementine-workflow-scheduler-approval-'));
process.env.CLEMENTINE_HOME = home;

const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { workflowSchedulerInternalsForTest, processWorkflowSchedules } = await import('./workflow-scheduler.js');
const { writeWorkflowAndSyncTriggers } = await import('./workflow-write.js');

function run(id: string, workflow: string, status: string): void {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${id}.json`),
    JSON.stringify({ id, workflow, status }),
    'utf-8',
  );
}

test('scheduled approval backpressure counts a parked run separately from executable queue work', () => {
  run('parked-1', 'daily-standup-email', 'parked');
  run('queued-1', 'daily-standup-email', 'queued');
  run('done-1', 'daily-standup-email', 'completed');
  run('other-1', 'another-workflow', 'parked');

  assert.deepEqual(
    workflowSchedulerInternalsForTest.countActiveRunsFor('daily-standup-email'),
    { pending: 1, parked: 1 },
  );
});

test('a matching schedule does not enqueue another occurrence while approval is parked', async () => {
  writeWorkflowAndSyncTriggers('daily-standup-email', {
    name: 'daily-standup-email',
    description: 'Send a daily standup email.',
    enabled: true,
    trigger: { schedule: '0 8 * * 1-5', timezone: 'America/Los_Angeles' },
    steps: [{ id: 'main', prompt: 'Compose and send the daily standup email.' }],
  });

  const result = await processWorkflowSchedules(new Date('2026-07-15T15:00:00.000Z'));
  assert.deepEqual(result.fired, []);
  assert.deepEqual(result.deduped, ['daily-standup-email']);
});
