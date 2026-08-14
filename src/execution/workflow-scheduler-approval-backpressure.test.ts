import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clementine-workflow-scheduler-approval-'));
process.env.CLEMENTINE_HOME = home;

const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { workflowSchedulerInternalsForTest, processWorkflowSchedules } = await import('./workflow-scheduler.js');
const { writeWorkflowAndSyncTriggers } = await import('./workflow-write.js');
const { listOperationalEvents } = await import('../runtime/operational-telemetry.js');

function run(
  id: string,
  workflow: string,
  status: string,
  extra: Record<string, unknown> = {},
): void {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${id}.json`),
    JSON.stringify({ id, workflow, status, ...extra }),
    'utf-8',
  );
}

test('scheduled approval backpressure counts a parked run separately from executable queue work', () => {
  run('parked-1', 'daily-standup-email', 'parked');
  run('queued-1', 'daily-standup-email', 'queued');
  run('finalizing-1', 'daily-standup-email', 'finalizing');
  run('held-1', 'daily-standup-email', 'awaiting_catchup_decision');
  run('done-1', 'daily-standup-email', 'completed');
  run('other-1', 'another-workflow', 'parked');

  assert.deepEqual(
    workflowSchedulerInternalsForTest.countActiveRunsFor('daily-standup-email'),
    { pending: 2, parked: 1, capabilityBlocked: 0, mutationBlocked: 0 },
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

test('an unresolved mutation holds the live occurrence with an exact reconciliation reason', async () => {
  const workflowName = 'daily-mutation-reconciliation';
  writeWorkflowAndSyncTriggers(workflowName, {
    name: workflowName,
    description: 'Send one daily update after external truth is known.',
    enabled: true,
    trigger: { schedule: '0 8 * * 1-5', timezone: 'America/Los_Angeles' },
    steps: [{ id: 'main', prompt: 'Send the exact daily update.' }],
  });
  run('blocked-mutation-1', workflowName, 'blocked_mutation');

  assert.deepEqual(
    workflowSchedulerInternalsForTest.countActiveRunsFor(workflowName),
    { pending: 0, parked: 0, capabilityBlocked: 0, mutationBlocked: 1 },
  );

  const result = await processWorkflowSchedules(new Date('2026-07-15T15:00:00.000Z'));
  assert.equal(result.fired.includes(workflowName), false);
  assert.equal(result.deduped.includes(workflowName), true);
  const workflowRuns = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as {
      workflow?: unknown;
    })
    .filter((record) => record.workflow === workflowName);
  assert.equal(workflowRuns.length, 1, 'the held occurrence must not create a second run');

  const events = listOperationalEvents({ limit: 100 }).filter((event) =>
    event.type === 'workflow_trigger_deduped'
    && (event.payload as { workflowName?: unknown }).workflowName === workflowName);
  assert.equal(events.length, 1);
  assert.equal(
    (events[0].payload as { reason?: unknown }).reason,
    'mutation_awaiting_reconciliation',
  );
});

test('a capability-paused run holds the live occurrence for safe recovery', async () => {
  const workflowName = 'daily-capability-recovery';
  writeWorkflowAndSyncTriggers(workflowName, {
    name: workflowName,
    description: 'Send one update only after the required capability recovers.',
    enabled: true,
    trigger: { schedule: '0 9 * * 1-5', timezone: 'America/Los_Angeles' },
    steps: [{ id: 'main', prompt: 'Send the exact daily update.' }],
  });
  const capabilityBlock = {
    stepId: 'main',
    tool: 'SLACK_SEND_MESSAGE',
    toolkit: 'slack',
    reason: 'not-connected',
    message: 'Reconnect Slack.',
    blockedAt: '2026-07-15T15:59:00.000Z',
    retryAt: '2026-07-15T16:00:00.000Z',
    retryCount: 1,
    provenNoDispatch: true,
    state: 'blocked',
  };
  run('blocked-capability-1', workflowName, 'blocked_capability', { capabilityBlock });

  assert.deepEqual(
    workflowSchedulerInternalsForTest.countActiveRunsFor(workflowName),
    { pending: 0, parked: 0, capabilityBlocked: 1, mutationBlocked: 0 },
  );

  // Reaper readmission must not open a race where the held occurrence queues
  // while the original same-run retry is still executing.
  run('blocked-capability-1', workflowName, 'running', {
    capabilityBlock: { ...capabilityBlock, state: 'retrying' },
  });
  assert.deepEqual(
    workflowSchedulerInternalsForTest.countActiveRunsFor(workflowName),
    { pending: 0, parked: 0, capabilityBlocked: 1, mutationBlocked: 0 },
  );
  run('blocked-capability-1', workflowName, 'running', {
    capabilityBlock: { ...capabilityBlock, state: 'consumed' },
  });
  assert.deepEqual(
    workflowSchedulerInternalsForTest.countActiveRunsFor(workflowName),
    { pending: 0, parked: 0, capabilityBlocked: 1, mutationBlocked: 0 },
  );

  const result = await processWorkflowSchedules(new Date('2026-07-15T16:00:00.000Z'));
  assert.equal(result.fired.includes(workflowName), false);
  assert.equal(result.deduped.includes(workflowName), true);
  const workflowRuns = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as {
      workflow?: unknown;
    })
    .filter((record) => record.workflow === workflowName);
  assert.equal(workflowRuns.length, 1, 'the held occurrence must not create another resumable send');

  const events = listOperationalEvents({ limit: 100 }).filter((event) =>
    event.type === 'workflow_trigger_deduped'
    && (event.payload as { workflowName?: unknown }).workflowName === workflowName);
  assert.equal(events.length, 1);
  assert.equal(
    (events[0].payload as { reason?: unknown }).reason,
    'capability_awaiting_recovery',
  );
});

test('immutable slug backpressure survives a display-name rename', async () => {
  const workflowSlug = 'renamed-capability-recovery';
  const oldDisplayName = 'Old Capability Recovery Display';
  const newDisplayName = 'New Capability Recovery Display';
  writeWorkflowAndSyncTriggers(workflowSlug, {
    name: newDisplayName,
    description: 'Do not overlap a renamed workflow with its existing same-slug recovery.',
    enabled: true,
    trigger: { schedule: '0 11 * * 1-5', timezone: 'America/Los_Angeles' },
    steps: [{ id: 'main', prompt: 'Send the exact daily update.' }],
  });
  run('blocked-capability-renamed', oldDisplayName, 'blocked_capability', {
    workflowSlug,
    capabilityBlock: {
      stepId: 'main',
      tool: 'OPAQUE_SEND',
      toolkit: 'opaque',
      reason: 'not-connected',
      blockedAt: '2026-07-15T17:59:00.000Z',
      retryAt: '2026-07-15T18:00:00.000Z',
      retryCount: 1,
      provenNoDispatch: true,
      state: 'blocked',
    },
  });

  assert.deepEqual(
    workflowSchedulerInternalsForTest.countActiveRunsFor(newDisplayName, workflowSlug),
    { pending: 0, parked: 0, capabilityBlocked: 1, mutationBlocked: 0 },
  );
  const result = await processWorkflowSchedules(new Date('2026-07-15T18:00:00.000Z'));
  assert.equal(result.fired.includes(newDisplayName), false);
  assert.equal(result.deduped.includes(newDisplayName), true);
  const matchingSlugRuns = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as {
      workflowSlug?: unknown;
    })
    .filter((record) => record.workflowSlug === workflowSlug);
  assert.equal(matchingSlugRuns.length, 1, 'display rename must not admit another same-slug occurrence');
});

test('the real scheduler persists immutable slug authority when display name differs', async () => {
  const workflowSlug = 'scheduler-slug-authority';
  const displayName = 'Scheduler Slug Authority Display';
  writeWorkflowAndSyncTriggers(workflowSlug, {
    name: displayName,
    description: 'Bind one real scheduler occurrence to the catalog slug.',
    enabled: true,
    trigger: { schedule: '0 10 * * 1-5', timezone: 'America/Los_Angeles' },
    steps: [{ id: 'main', prompt: 'Read the scheduled occurrence.', sideEffect: 'read' }],
  });

  const result = await processWorkflowSchedules(new Date('2026-07-15T17:00:00.000Z'));
  assert.equal(result.fired.includes(displayName), true);
  const [record] = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as {
      workflow?: unknown;
      workflowSlug?: unknown;
      triggerReceiptId?: unknown;
    })
    .filter((candidate) => candidate.workflow === displayName);
  assert.ok(record);
  assert.equal(record.workflowSlug, workflowSlug);
  assert.match(
    String(record.triggerReceiptId ?? ''),
    new RegExp(`^workflow-schedule:v1:${workflowSlug}:\\d+$`),
  );
});
