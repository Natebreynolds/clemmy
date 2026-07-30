import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-catchup-admission-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
const {
  _testOnly_selectWorkflowDrainCandidates: selectWorkflowDrainCandidates,
  _testOnly_isLegacyScheduledCatchupSafeToHold: isLegacyScheduledCatchupSafeToHold,
  _testOnly_migrateLegacyScheduledCatchupToHold: migrateLegacyScheduledCatchupToHold,
} = await import('./workflow-runner.js') as unknown as {
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

function legacyRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sched-legacy',
    workflow: 'Legacy Schedule',
    status: 'queued',
    source: 'schedule',
    catchupFire: true,
    catchupOccurrenceAtMs: 100,
    triggerReceiptId: 'workflow-schedule:v1:legacy-schedule:200',
    createdAt: '2026-07-29T10:00:00.000Z',
    ...overrides,
  };
}

test('only a pristine original legacy scheduled catch-up is safe to hold', () => {
  assert.equal(isLegacyScheduledCatchupSafeToHold(legacyRun()), true);
  assert.equal(isLegacyScheduledCatchupSafeToHold(legacyRun(), true), false, 'run-local artifacts prove execution may have begun');
  assert.equal(isLegacyScheduledCatchupSafeToHold(legacyRun({ status: 'running' })), false);
  assert.equal(isLegacyScheduledCatchupSafeToHold(legacyRun({ startedAt: '2026-07-29T10:00:01.000Z' })), false);
  assert.equal(isLegacyScheduledCatchupSafeToHold(legacyRun({ requeuedFromRunId: 'prior' })), false);
  assert.equal(isLegacyScheduledCatchupSafeToHold(legacyRun({ source: 'workflow-self-heal' })), false);
  assert.equal(isLegacyScheduledCatchupSafeToHold(legacyRun({ catchupDisposition: 'resumed' })), false);
  assert.equal(isLegacyScheduledCatchupSafeToHold(legacyRun({ triggerReceiptId: 'not-a-schedule-receipt' })), false);
});

test('legacy queued catch-up migrates durably to the same held decision contract', () => {
  const run = legacyRun();
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${run.id}.json`);
  writeFileSync(filePath, JSON.stringify(run, null, 2), 'utf-8');

  const migrated = migrateLegacyScheduledCatchupToHold(filePath, run);
  assert.equal(migrated.status, 'awaiting_catchup_decision');
  assert.equal(migrated.catchupDisposition, 'held');
  assert.equal(migrated.workflowSlug, 'legacy-schedule');
  assert.equal(migrated.catchupFirstDueAtMs, 100);
  assert.equal(migrated.catchupScheduledAtMs, 200);
  assert.equal(migrated.catchupMissedCount, 1);
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf-8')), migrated);

  // A scheduler-state replay may call the migration seam again with its stale
  // snapshot. The run-id-stable notification stays one-time and tells the user
  // exactly where the zero-execution Resume/Skip decision lives.
  migrateLegacyScheduledCatchupToHold(filePath, run);
  const notices = loadNotifications().filter((notification) =>
    notification.id === 'system-workflow-catchup-held-sched-legacy');
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /no workflow steps have run/i);
  assert.match(notices[0].body, /Open Tasks/i);
  assert.match(notices[0].body, /Resume or Skip/i);
});

test('legacy migration fails closed when execution artifacts or a requeue lineage exist', () => {
  const withArtifacts = legacyRun({ id: 'sched-artifacts' });
  const artifactsPath = path.join(WORKFLOWS_DIR, 'legacy-schedule', 'runs', String(withArtifacts.id));
  mkdirSync(artifactsPath, { recursive: true });
  const artifactsFile = path.join(WORKFLOW_RUNS_DIR, `${withArtifacts.id}.json`);
  writeFileSync(artifactsFile, JSON.stringify(withArtifacts), 'utf-8');
  assert.equal(migrateLegacyScheduledCatchupToHold(artifactsFile, withArtifacts).status, 'queued');

  const descendant = legacyRun({ id: 'sched-descendant', requeuedFromRunId: 'prior' });
  const descendantFile = path.join(WORKFLOW_RUNS_DIR, `${descendant.id}.json`);
  writeFileSync(descendantFile, JSON.stringify(descendant), 'utf-8');
  assert.equal(migrateLegacyScheduledCatchupToHold(descendantFile, descendant).status, 'queued');
});
