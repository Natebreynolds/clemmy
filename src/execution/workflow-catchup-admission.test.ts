import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-catchup-admission-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
const {
  processWorkflowRuns,
  _testOnly_selectWorkflowDrainCandidates: selectWorkflowDrainCandidates,
  _testOnly_isLegacyScheduledCatchupSafeToHold: isLegacyScheduledCatchupSafeToHold,
  _testOnly_migrateLegacyScheduledCatchupToHold: migrateLegacyScheduledCatchupToHold,
} = await import('./workflow-runner.js') as unknown as {
  processWorkflowRuns: (assistant: object) => Promise<void>;
  _testOnly_selectWorkflowDrainCandidates: (
    runs: Array<{
      id: string;
      status?: string;
      catchupFire?: boolean;
      catchupOccurrenceAtMs?: number;
      catchupDisposition?: string;
      createdAt?: string;
    }>,
    catchupSlotOccupied?: boolean,
  ) => Array<{ id: string }>;
  _testOnly_isLegacyScheduledCatchupSafeToHold: (
    run: Record<string, unknown>,
    runArtifactsExist?: boolean,
  ) => boolean;
  _testOnly_migrateLegacyScheduledCatchupToHold: (
    filePath: string,
    run: Record<string, unknown>,
  ) => Record<string, unknown>;
};
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { loadNotifications } = await import('../runtime/notifications.js');
const { createWorkflowRunDefinitionSnapshot } = await import('./workflow-run-definition.js');
const { listHeldWorkflowCatchupRuns } = await import('./workflow-catchup-decision.js');

test.beforeEach(() => {
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  rmSync(path.join(TMP_HOME, 'state', 'notifications.json'), { force: true });
  rmSync(path.join(TMP_HOME, 'state', 'notification-delivery-queue.json'), { force: true });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
});

test('the drain admits normal work plus only the oldest executable catch-up', () => {
  const selected = selectWorkflowDrainCandidates([
    { id: 'catchup-new', status: 'queued', catchupFire: true, catchupOccurrenceAtMs: 300 },
    { id: 'normal-a', status: 'queued' },
    { id: 'catchup-old', status: 'running', catchupFire: true, catchupOccurrenceAtMs: 100 },
    { id: 'normal-b', status: 'finalizing' },
    { id: 'catchup-middle', status: 'queued', catchupFire: true, catchupOccurrenceAtMs: 200 },
  ]);

  assert.deepEqual(
    selected.map((run) => run.id),
    ['normal-a', 'catchup-old', 'normal-b'],
    'normal runs keep their slots while catch-up execution stays globally single-flight',
  );
});

test('an already executing catch-up blocks catch-ups in a later drain, not normal work', () => {
  const selected = selectWorkflowDrainCandidates([
    { id: 'normal', status: 'queued' },
    { id: 'catchup', status: 'queued', catchupFire: true, catchupOccurrenceAtMs: 100 },
  ], true);

  assert.deepEqual(selected.map((run) => run.id), ['normal']);
});

test('a resumed catch-up must reacquire the slot using its original occurrence age', () => {
  const selected = selectWorkflowDrainCandidates([
    {
      id: 'resumed-older',
      status: 'running',
      catchupFire: true,
      catchupOccurrenceAtMs: 100,
      createdAt: '2026-07-30T10:00:00.000Z',
    },
    {
      id: 'queued-newer',
      status: 'queued',
      catchupFire: true,
      catchupOccurrenceAtMs: 200,
      createdAt: '2026-07-30T09:00:00.000Z',
    },
  ]);

  assert.deepEqual(selected.map((run) => run.id), ['resumed-older']);
});

test('a held catch-up never enters or occupies executable admission', () => {
  const selected = selectWorkflowDrainCandidates([
    {
      id: 'held-oldest',
      status: 'awaiting_catchup_decision',
      catchupFire: true,
      catchupDisposition: 'held',
      catchupOccurrenceAtMs: 1,
    },
    { id: 'normal', status: 'queued' },
    {
      id: 'resumed',
      status: 'queued',
      catchupFire: true,
      catchupDisposition: 'resumed',
      catchupOccurrenceAtMs: 2,
    },
  ]);

  assert.deepEqual(selected.map((run) => run.id), ['normal', 'resumed']);
});

const HISTORICAL_CREATED_AT = '2026-07-29T10:00:00.000Z';
const HISTORICAL_CREATED_AT_MS = Date.parse(HISTORICAL_CREATED_AT);
const HISTORICAL_SNAPSHOT = createWorkflowRunDefinitionSnapshot(
  'legacy-schedule',
  {
    name: 'Legacy Schedule',
    description: 'Historical scheduled workflow fixture.',
    enabled: true,
    trigger: { schedule: '0 10 * * *' },
    steps: [{ id: 'read', prompt: 'Read the source.', sideEffect: 'read' }],
  },
  HISTORICAL_CREATED_AT,
);

/** Exact v3.0.1/v3.0.2 scheduler admission shape. Those versions used the
 * sched-<epoch>-<random> id plus source=schedule and an authenticated
 * definition snapshot; they did NOT write catchupFire or triggerReceiptId. */
function historicalScheduledRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `sched-${HISTORICAL_CREATED_AT_MS}-a1b2c3`,
    workflow: 'Legacy Schedule',
    inputs: {},
    status: 'queued',
    source: 'schedule',
    mutationReceiptProtocolVersion: 1,
    workflowDefinitionSnapshot: HISTORICAL_SNAPSHOT,
    createdAt: HISTORICAL_CREATED_AT,
    readiness: {
      ok: true,
      checkedAt: HISTORICAL_CREATED_AT,
      scope: 'run',
      blockers: [],
      warnings: [],
      toolReadiness: [],
    },
    ...overrides,
  };
}

/** Exact final pre-pause anti-stampede shape: it added catchupFire=true, but
 * still had no occurrence receipt or triggerReceiptId. */
function historicalMarkedCatchup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return historicalScheduledRun({ catchupFire: true, ...overrides });
}

test('actual v3.0.1 and later pre-pause scheduler admissions are safe to hold only while pristine', () => {
  assert.equal(isLegacyScheduledCatchupSafeToHold(historicalScheduledRun()), true);
  assert.equal(isLegacyScheduledCatchupSafeToHold(historicalMarkedCatchup()), true);
  assert.equal(
    isLegacyScheduledCatchupSafeToHold(historicalScheduledRun(), true),
    false,
    'run-local artifacts prove execution may have begun',
  );
  assert.equal(isLegacyScheduledCatchupSafeToHold(historicalScheduledRun({ status: 'running' })), false);
  assert.equal(
    isLegacyScheduledCatchupSafeToHold(
      historicalScheduledRun({ startedAt: '2026-07-29T10:00:01.000Z' }),
    ),
    false,
  );
  assert.equal(
    isLegacyScheduledCatchupSafeToHold(historicalScheduledRun({ requeuedFromRunId: 'prior' })),
    false,
  );
  assert.equal(
    isLegacyScheduledCatchupSafeToHold(historicalScheduledRun({ source: 'workflow-self-heal' })),
    false,
  );
  assert.equal(
    isLegacyScheduledCatchupSafeToHold(historicalScheduledRun({ catchupDisposition: 'resumed' })),
    false,
  );
  assert.equal(
    isLegacyScheduledCatchupSafeToHold(historicalScheduledRun({ id: 'manual-run' })),
    false,
    'source=schedule by itself is not historical scheduler authority',
  );
  assert.equal(
    isLegacyScheduledCatchupSafeToHold(historicalScheduledRun({
      id: 'trigger-accepted-live-minute',
      triggerReceiptId: `workflow-schedule:v1:legacy-schedule:${HISTORICAL_CREATED_AT_MS}`,
    })),
    false,
    'a current on-time receipt without catchupFire must keep executing normally',
  );
});

test('v3.0.1 queued scheduled occurrence migrates durably to the held decision contract', () => {
  const run = historicalScheduledRun();
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${run.id}.json`);
  writeFileSync(filePath, JSON.stringify(run, null, 2), 'utf-8');

  const migrated = migrateLegacyScheduledCatchupToHold(filePath, run);
  assert.equal(migrated.status, 'awaiting_catchup_decision');
  assert.equal(migrated.catchupFire, true);
  assert.equal(migrated.catchupDisposition, 'held');
  assert.equal(migrated.workflowSlug, 'legacy-schedule');
  assert.equal(migrated.catchupOccurrenceAtMs, HISTORICAL_CREATED_AT_MS);
  assert.equal(migrated.catchupFirstDueAtMs, HISTORICAL_CREATED_AT_MS);
  assert.equal(migrated.catchupScheduledAtMs, HISTORICAL_CREATED_AT_MS);
  assert.equal(migrated.catchupMissedCount, 1);
  assert.equal(typeof migrated.catchupHeldAt, 'string');
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf-8')), migrated);
  assert.deepEqual(
    listHeldWorkflowCatchupRuns().map((held) => ({
      runId: held.runId,
      workflowSlug: held.workflowSlug,
      missedCount: held.missedCount,
    })),
    [{ runId: run.id, workflowSlug: 'legacy-schedule', missedCount: 1 }],
    'the migrated record is immediately visible to the same Tasks Resume/Skip surface as a new hold',
  );

  // A scheduler-state replay may call the migration seam again with its stale
  // snapshot. The run-id-stable notification stays one-time and tells the user
  // exactly where the zero-execution Resume/Skip decision lives.
  migrateLegacyScheduledCatchupToHold(filePath, run);
  const notices = loadNotifications().filter((notification) =>
    notification.id === `system-workflow-catchup-held-${String(run.id)}`);
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /no workflow steps have run/i);
  assert.match(notices[0].body, /Open Tasks/i);
  assert.match(notices[0].body, /Resume or Skip/i);
});

test('the catchupFire-only pre-pause admission shape also migrates without a fabricated receipt', () => {
  const run = historicalMarkedCatchup({
    id: `sched-${HISTORICAL_CREATED_AT_MS}-f1e2d3`,
  });
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${run.id}.json`);
  writeFileSync(filePath, JSON.stringify(run, null, 2), 'utf-8');

  const migrated = migrateLegacyScheduledCatchupToHold(filePath, run);

  assert.equal(migrated.status, 'awaiting_catchup_decision');
  assert.equal(migrated.catchupFire, true);
  assert.equal(migrated.catchupDisposition, 'held');
  assert.equal(migrated.workflowSlug, 'legacy-schedule');
  assert.equal(migrated.catchupScheduledAtMs, HISTORICAL_CREATED_AT_MS);
});

test('the production drain freezes a pristine v3.0.1 record before any executor can touch it', async () => {
  const run = historicalScheduledRun({ id: `sched-${HISTORICAL_CREATED_AT_MS}-d4e5f6` });
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${run.id}.json`);
  writeFileSync(filePath, JSON.stringify(run, null, 2), 'utf-8');
  const assistantThatMustStayUntouched = new Proxy({}, {
    get() {
      throw new Error('workflow executor was touched before the upgrade hold');
    },
  });

  await processWorkflowRuns(assistantThatMustStayUntouched);

  const held = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  assert.equal(held.status, 'awaiting_catchup_decision');
  assert.equal(held.catchupDisposition, 'held');
  assert.equal(
    existsSync(path.join(WORKFLOWS_DIR, 'legacy-schedule', 'runs', String(run.id))),
    false,
    'no workflow event/artifact directory was created',
  );
});

test('upgrade migration never falsely holds started, artifact-bearing, or requeued historical records', () => {
  const withArtifacts = historicalScheduledRun({
    id: `sched-${HISTORICAL_CREATED_AT_MS}-aaa111`,
  });
  const artifactsPath = path.join(WORKFLOWS_DIR, 'legacy-schedule', 'runs', String(withArtifacts.id));
  mkdirSync(artifactsPath, { recursive: true });
  const artifactsFile = path.join(WORKFLOW_RUNS_DIR, `${withArtifacts.id}.json`);
  writeFileSync(artifactsFile, JSON.stringify(withArtifacts), 'utf-8');
  assert.equal(migrateLegacyScheduledCatchupToHold(artifactsFile, withArtifacts).status, 'queued');

  const started = historicalMarkedCatchup({
    id: `sched-${HISTORICAL_CREATED_AT_MS}-bbb222`,
    startedAt: '2026-07-29T10:00:01.000Z',
    stepOutputs: {},
  });
  const startedFile = path.join(WORKFLOW_RUNS_DIR, `${started.id}.json`);
  writeFileSync(startedFile, JSON.stringify(started), 'utf-8');
  assert.equal(migrateLegacyScheduledCatchupToHold(startedFile, started).status, 'queued');

  const descendant = historicalMarkedCatchup({
    id: `sched-${HISTORICAL_CREATED_AT_MS}-ccc333`,
    requeuedFromRunId: 'prior',
  });
  const descendantFile = path.join(WORKFLOW_RUNS_DIR, `${descendant.id}.json`);
  writeFileSync(descendantFile, JSON.stringify(descendant), 'utf-8');
  assert.equal(migrateLegacyScheduledCatchupToHold(descendantFile, descendant).status, 'queued');
});
