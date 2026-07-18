import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-cancel-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const {
  _setWorkflowRunCancellationBeforeLockForTests,
  cancelWorkflowRunAtBoundary,
  readWorkflowRunCancellation,
  requestWorkflowRunCancellation,
  workflowRunCancellationRequested,
} = await import('./workflow-run-cancellation.js');
const {
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
  writeWorkflowRunRecordDurablyUnlocked,
} = await import('./workflow-run-record.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

beforeEach(() => {
  _setWorkflowRunCancellationBeforeLockForTests();
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
});

function writeRun(runId: string, record: Record<string, unknown>): string {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(file, JSON.stringify({ id: runId, workflow: 'Race Workflow', ...record }), 'utf-8');
  return file;
}

test('workflow cancellation receipt is immutable and first request wins', () => {
  const first = requestWorkflowRunCancellation('run-1', 'Stop before sending.', 'test-a');
  const second = requestWorkflowRunCancellation('run-1', 'Different reason.', 'test-b');

  assert.deepEqual(second, first);
  assert.equal(workflowRunCancellationRequested('run-1'), true);
  assert.equal(readWorkflowRunCancellation('run-1')?.reason, 'Stop before sending.');
});

test('a corrupt cancellation receipt still fails closed', () => {
  requestWorkflowRunCancellation('run-corrupt', 'Stop.', 'test');
  const cancellationDir = path.join(WORKFLOW_RUNS_DIR, '.cancellations');
  const [file] = readdirSync(cancellationDir);
  writeFileSync(path.join(cancellationDir, file), '{', 'utf-8');

  assert.equal(workflowRunCancellationRequested('run-corrupt'), true);
  assert.match(readWorkflowRunCancellation('run-corrupt')?.reason ?? '', /unreadable/);
});

test('completion landing after the dashboard snapshot wins the cancellation boundary', () => {
  const runId = 'run-cancel-completion-race';
  const file = writeRun(runId, { status: 'running', startedAt: new Date().toISOString() });
  _setWorkflowRunCancellationBeforeLockForTests(() => {
    withWorkflowRunRecordLock(file, () => {
      const current = readWorkflowRunRecordUnlocked<Record<string, unknown>>(file);
      assert.ok(current);
      writeWorkflowRunRecordDurablyUnlocked(file, {
        ...current,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        output: 'terminal result',
      });
    });
  });

  const result = cancelWorkflowRunAtBoundary({
    runId,
    reason: 'stale dashboard cancel',
    source: 'test-dashboard',
    expectedWorkflow: 'Race Workflow',
  });
  assert.equal(result.status, 'already_terminal');
  const canonical = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  assert.equal(canonical.status, 'completed');
  assert.equal(canonical.output, 'terminal result');
  assert.equal(workflowRunCancellationRequested(runId), false, 'losing cancellation installs no authority receipt');
});

for (const status of ['dry_run', 'creation_test'] as const) {
  test(`finished ${status} runs are terminal at the cancellation boundary`, () => {
    const runId = `run-finished-${status}`;
    const file = writeRun(runId, { status, finishedAt: new Date().toISOString() });
    const result = cancelWorkflowRunAtBoundary({
      runId,
      reason: 'too late',
      source: 'test-dashboard',
    });
    assert.equal(result.status, 'already_terminal');
    assert.equal((JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>).status, status);
    assert.equal(workflowRunCancellationRequested(runId), false);
  });
}

test('an already-cancelled legacy envelope is adopted instead of split by a later requester reason', () => {
  const runId = 'run-legacy-cancel-adopt';
  const file = writeRun(runId, {
    status: 'cancelled',
    finishedAt: new Date(0).toISOString(),
    error: 'Approval was declined.',
    parked: { parkedAt: new Date(0).toISOString(), parkedSteps: [] },
    reportBack: {
      version: 1,
      workflowName: 'Race Workflow',
      outcome: 'failed',
      detail: 'Approval was declined.',
      acknowledgedOriginSessionIds: [],
    },
  });
  const result = cancelWorkflowRunAtBoundary({
    runId,
    reason: 'Different dashboard reason.',
    source: 'test-dashboard',
  });
  assert.equal(result.status, 'already_cancelled');
  assert.equal(result.request?.reason, 'Approval was declined.');
  assert.equal(readWorkflowRunCancellation(runId)?.reason, 'Approval was declined.');
  const canonical = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, any>;
  assert.equal(canonical.error, 'Approval was declined.');
  assert.equal(canonical.reportBack.detail, 'Approval was declined.');
  assert.equal(canonical.parked, undefined);
});

test('an invalid already-cancelled envelope is left unchanged without installing conflicting authority', () => {
  const runId = 'run-invalid-cancel-envelope';
  const file = writeRun(runId, {
    status: 'cancelled',
    error: 'Existing terminal truth.',
    reportBack: { version: 1, outcome: 'failed', detail: 'invalid missing fields' },
  });
  const before = readFileSync(file, 'utf-8');
  const result = cancelWorkflowRunAtBoundary({
    runId,
    reason: 'New requester reason.',
    source: 'test-dashboard',
  });
  assert.equal(result.status, 'already_cancelled');
  assert.equal(result.request, undefined);
  assert.equal(workflowRunCancellationRequested(runId), false);
  assert.equal(readFileSync(file, 'utf-8'), before);
});
