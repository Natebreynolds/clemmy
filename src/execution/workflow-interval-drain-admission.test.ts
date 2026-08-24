import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import type { WorkflowIntervalV1 } from '../shared/workflow-interval.js';
import type { QueuedRunRecord } from './workflow-runner.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clementine-interval-drain-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const {
  _testOnly_runWorkflowDrainAdmissionPass,
  _testOnly_selectWorkflowDrainCandidates,
} = await import('./workflow-runner.js');
const { createWorkflowRunDefinitionSnapshot } = await import('./workflow-run-definition.js');
const { workflowIntervalOccurrenceId } = await import('../shared/workflow-interval.js');

test.after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function recurrence(overrides: Partial<WorkflowIntervalV1> = {}): WorkflowIntervalV1 {
  return {
    version: 1,
    every: 2,
    unit: 'hour',
    anchorAt: '2026-08-22T19:00:00.000Z',
    overlapPolicy: 'queue_one',
    catchUpPolicy: 'run_once',
    ...overrides,
  };
}

function definition(name: string, interval = recurrence()): WorkflowDefinition {
  return {
    name,
    description: `Generated durable workflow ${name}`,
    enabled: true,
    trigger: { interval, manual: true },
    steps: [{ id: 'read', prompt: 'Read the current source.', sideEffect: 'read' }],
  };
}

function intervalRun(input: {
  id: string;
  workflowSlug: string;
  ordinal: number;
  interval?: WorkflowIntervalV1;
  status?: string;
  createdAt?: string;
}): QueuedRunRecord {
  const interval = input.interval ?? recurrence();
  const def = definition(input.workflowSlug, interval);
  return {
    id: input.id,
    workflow: def.name,
    workflowSlug: input.workflowSlug,
    status: input.status ?? 'queued',
    createdAt: input.createdAt ?? '2026-08-22T21:00:00.000Z',
    source: 'schedule',
    triggerReceiptId: workflowIntervalOccurrenceId({
      workflowKey: input.workflowSlug,
      interval,
      ordinal: input.ordinal,
    }),
    workflowDefinitionSnapshot: createWorkflowRunDefinitionSnapshot(
      input.workflowSlug,
      def,
      input.createdAt ?? '2026-08-22T21:00:00.000Z',
    ),
  };
}

test('two due ticks queued before one drain admit only the oldest exact interval occurrence', () => {
  const first = intervalRun({
    id: 'interval-first',
    workflowSlug: 'generated-serial',
    ordinal: 1,
    createdAt: '2026-08-22T21:00:00.000Z',
  });
  const successor = intervalRun({
    id: 'interval-successor',
    workflowSlug: 'generated-serial',
    ordinal: 2,
    createdAt: '2026-08-22T23:00:00.000Z',
  });

  assert.deepEqual(
    _testOnly_selectWorkflowDrainCandidates([successor, first]).map((run) => run.id),
    ['interval-first'],
  );
  assert.equal(successor.status, 'queued', 'the successor remains durable and unstarted');
});

test('a running or finalizing exact interval occurrence keeps its queued successor out across restart', () => {
  for (const status of ['running', 'finalizing'] as const) {
    const active = intervalRun({
      id: `interval-${status}`,
      workflowSlug: `generated-restart-${status}`,
      ordinal: 1,
      status,
      createdAt: '2026-08-22T21:00:00.000Z',
    });
    const successor = intervalRun({
      id: `interval-${status}-successor`,
      workflowSlug: `generated-restart-${status}`,
      ordinal: 2,
      status: 'queued',
      createdAt: '2026-08-22T23:00:00.000Z',
    });

    const beforeRestart = _testOnly_selectWorkflowDrainCandidates([successor, active]);
    assert.deepEqual(beforeRestart.map((run) => run.id), [`interval-${status}`]);
    assert.equal(successor.status, 'queued');

    // A restart reconstructs candidates from durable records. While the first
    // remains active, the same exact selection wins. Once it is terminal and no
    // longer scan-eligible, the untouched successor is admitted.
    const afterRestart = _testOnly_selectWorkflowDrainCandidates([active, successor]);
    assert.deepEqual(afterRestart.map((run) => run.id), [`interval-${status}`]);
    assert.deepEqual(
      _testOnly_selectWorkflowDrainCandidates([successor]).map((run) => run.id),
      [`interval-${status}-successor`],
    );
  }
});

test('overlapping drain passes keep the exact interval successor queued until the active lease releases', async () => {
  const first = intervalRun({
    id: 'interval-overlap-active',
    workflowSlug: 'generated-overlapping-passes',
    ordinal: 1,
    createdAt: '2026-08-22T21:00:00.000Z',
  });
  const successor = intervalRun({
    id: 'interval-overlap-successor',
    workflowSlug: 'generated-overlapping-passes',
    ordinal: 2,
    createdAt: '2026-08-22T23:00:00.000Z',
  });
  let releaseFirst!: () => void;
  let reportFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { reportFirstStarted = resolve; });
  const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const firstPass = _testOnly_runWorkflowDrainAdmissionPass([first], async () => {
    reportFirstStarted();
    await holdFirst;
  });
  await firstStarted;

  let successorStarted = false;
  const overlappingPass = await _testOnly_runWorkflowDrainAdmissionPass([successor], async () => {
    successorStarted = true;
  });
  assert.deepEqual(overlappingPass, []);
  assert.equal(successorStarted, false);
  assert.equal(successor.status, 'queued', 'the losing successor remains durable and untouched');

  releaseFirst();
  assert.deepEqual(await firstPass, ['interval-overlap-active']);
  assert.deepEqual(
    await _testOnly_runWorkflowDrainAdmissionPass([successor], async () => {}),
    ['interval-overlap-successor'],
  );
});

test('different workflow identities retain run-level parallelism', () => {
  const left = intervalRun({ id: 'interval-left', workflowSlug: 'generated-left', ordinal: 1 });
  const right = intervalRun({ id: 'interval-right', workflowSlug: 'generated-right', ordinal: 1 });
  assert.deepEqual(
    _testOnly_selectWorkflowDrainCandidates([left, right]).map((run) => run.id),
    ['interval-left', 'interval-right'],
  );
});

test('cross-pass identity leases do not serialize different workflows or revised intervals', async () => {
  const active = intervalRun({
    id: 'interval-lease-active',
    workflowSlug: 'generated-lease-scope',
    ordinal: 1,
    interval: recurrence({ every: 2 }),
  });
  const independent = intervalRun({
    id: 'interval-lease-independent',
    workflowSlug: 'generated-independent-scope',
    ordinal: 1,
    interval: recurrence({ every: 2 }),
  });
  const revised = intervalRun({
    id: 'interval-lease-revised',
    workflowSlug: 'generated-lease-scope',
    ordinal: 1,
    interval: recurrence({ every: 4 }),
  });
  let releaseActive!: () => void;
  let reportActiveStarted!: () => void;
  const activeStarted = new Promise<void>((resolve) => { reportActiveStarted = resolve; });
  const holdActive = new Promise<void>((resolve) => { releaseActive = resolve; });
  const activePass = _testOnly_runWorkflowDrainAdmissionPass([active], async () => {
    reportActiveStarted();
    await holdActive;
  });
  await activeStarted;

  assert.deepEqual(
    await _testOnly_runWorkflowDrainAdmissionPass([independent], async () => {}),
    ['interval-lease-independent'],
  );
  assert.deepEqual(
    await _testOnly_runWorkflowDrainAdmissionPass([revised], async () => {}),
    ['interval-lease-revised'],
  );

  releaseActive();
  assert.deepEqual(await activePass, ['interval-lease-active']);
});

test('a revised interval contract has a new exact identity and inherits no stale concurrency authority', () => {
  const oldRevision = intervalRun({
    id: 'interval-old-revision',
    workflowSlug: 'generated-revised',
    ordinal: 1,
    interval: recurrence({ every: 2 }),
    status: 'running',
  });
  const newRevision = intervalRun({
    id: 'interval-new-revision',
    workflowSlug: 'generated-revised',
    ordinal: 1,
    interval: recurrence({ every: 4 }),
    status: 'queued',
  });
  assert.deepEqual(
    _testOnly_selectWorkflowDrainCandidates([oldRevision, newRevision]).map((run) => run.id),
    ['interval-old-revision', 'interval-new-revision'],
  );
});

test('manual and cron runs are not serialized by interval admission', () => {
  const manualA: QueuedRunRecord = {
    id: 'manual-a', workflow: 'generated-ordinary', status: 'queued', createdAt: '2026-08-22T21:00:00.000Z',
  };
  const manualB: QueuedRunRecord = {
    id: 'manual-b', workflow: 'generated-ordinary', status: 'queued', createdAt: '2026-08-22T21:01:00.000Z',
  };
  const cronA: QueuedRunRecord = {
    id: 'cron-a', workflow: 'generated-cron', status: 'queued', source: 'schedule',
    triggerReceiptId: 'workflow-schedule:v1:generated-cron:1787432400000',
  };
  const cronB: QueuedRunRecord = {
    id: 'cron-b', workflow: 'generated-cron', status: 'queued', source: 'schedule',
    triggerReceiptId: 'workflow-schedule:v1:generated-cron:1787432460000',
  };
  assert.deepEqual(
    _testOnly_selectWorkflowDrainCandidates([manualA, manualB, cronA, cronB]).map((run) => run.id),
    ['manual-a', 'manual-b', 'cron-a', 'cron-b'],
  );
});
