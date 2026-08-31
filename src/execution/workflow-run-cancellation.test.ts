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
const { addNotification, getNotification } = await import('../runtime/notifications.js');

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

test('cancelling an ambiguous mutation preserves unresolved external truth without claiming no effect', () => {
  const runId = 'run-blocked-mutation-cancel';
  const file = writeRun(runId, {
    status: 'blocked_mutation',
    stepOutputs: { prepared: 'durable prior completion' },
    mutationBlock: {
      stepId: 'send-update',
      itemKey: 'channel:C123',
      tool: 'slack_send_message',
      fingerprint: 'b'.repeat(64),
      blockedAt: '2026-08-13T16:00:00.000Z',
      state: 'awaiting_reconciliation',
      providerRedispatched: false,
    },
  });

  const result = cancelWorkflowRunAtBoundary({
    runId,
    reason: 'Stop this workflow.',
    source: 'test-dashboard',
  });
  assert.equal(result.status, 'cancelled');
  assert.match(result.request.reason, /stopped this local run only/i);
  assert.match(result.request.reason, /may already have committed/i);
  assert.match(result.request.reason, /does not undo it/i);

  const canonical = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, any>;
  assert.equal(canonical.status, 'cancelled');
  assert.equal(canonical.error, result.request.reason);
  assert.equal(canonical.reportBack.detail, result.request.reason);
  assert.deepEqual(canonical.stepOutputs, { prepared: 'durable prior completion' });
  assert.equal(canonical.mutationBlock.stepId, 'send-update');
  assert.equal(canonical.mutationBlock.itemKey, 'channel:C123');
  assert.equal(canonical.mutationBlock.fingerprint, 'b'.repeat(64));
  assert.equal(canonical.mutationBlock.providerRedispatched, false);
  assert.equal(canonical.mutationBlock.state, 'cancelled_unreconciled');
  assert.equal(canonical.mutationBlock.cancelledAt, result.request.requestedAt);
  assert.doesNotMatch(canonical.error, /was not (performed|sent|written)/i);
});

test('terminal cancellation retires only the stable capability Needs You carrier', () => {
  const runId = 'run-capability-cancelled';
  writeRun(runId, {
    status: 'blocked_capability',
    capabilityBlock: {
      state: 'blocked',
      stepId: 'read',
      tool: 'GOOGLEDRIVE_LIST_FILES',
      toolkit: 'googledrive',
      reason: 'not-connected',
      retryCount: 1,
      provenNoDispatch: true,
    },
  });
  const gateId = `workflow-${runId}-capability-googledrive`;
  const resultId = `workflow-${runId}-terminal`;
  addNotification({
    id: gateId, kind: 'workflow', title: 'Workflow needs you — connect Google Drive', body: 'Connect.',
    createdAt: new Date().toISOString(), read: false,
    metadata: { runId, status: 'blocked_capability', needsAttention: true },
  });
  addNotification({
    id: resultId, kind: 'workflow', title: 'Workflow result', body: 'Terminal carrier.',
    createdAt: new Date().toISOString(), read: false,
    metadata: { runId, status: 'failed' },
  });

  const result = cancelWorkflowRunAtBoundary({
    runId,
    reason: 'Stopped by the user.',
    source: 'test-dashboard',
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(getNotification(gateId)?.read, true);
  assert.equal(getNotification(gateId)?.metadata?.needsAttention, false);
  assert.equal(getNotification(gateId)?.metadata?.terminalStatus, 'cancelled');
  assert.equal(getNotification(resultId)?.read, false, 'terminal/result notifications remain independent');
});

// Break-scenario C: the lifecycle-cleanup predicate + boundary contract that
// delete/disable rely on to stop in-flight runs (console-routes glue).
const { isTerminalWorkflowRunStatus } = await import('./workflow-run-cancellation.js');

test('isTerminalWorkflowRunStatus: only genuinely-finished states are terminal', () => {
  for (const s of ['completed', 'completed_with_errors', 'blocked', 'error', 'failed', 'cancelled', 'dry_run', 'creation_test']) {
    assert.equal(isTerminalWorkflowRunStatus(s), true, `${s} is terminal`);
  }
  for (const s of ['running', 'queued', 'pending', 'parked', 'blocked_mutation', undefined, null, 'weird']) {
    assert.equal(isTerminalWorkflowRunStatus(s), false, `${String(s)} is NOT terminal — a lifecycle cleanup must cancel it`);
  }
});

test('delete/disable cleanup: a non-terminal run cancels at the boundary; an already-terminal one is left alone', () => {
  const live = writeRun('lifecycle-live', { status: 'running', workflow: 'wf-x' });
  const done = writeRun('lifecycle-done', { status: 'completed', workflow: 'wf-x' });

  // The cleanup only calls cancelWorkflowRunAtBoundary on non-terminal runs.
  assert.equal(isTerminalWorkflowRunStatus('running'), false);
  const r1 = cancelWorkflowRunAtBoundary({ runId: 'lifecycle-live', reason: 'Workflow was deleted; its in-flight run was cancelled.', source: 'workflow-lifecycle-cleanup', expectedWorkflow: 'wf-x' });
  assert.equal(r1.status, 'cancelled');
  assert.equal(JSON.parse(readFileSync(live, 'utf-8')).status, 'cancelled');

  // A completed run is skipped by the predicate; if cancel were called anyway
  // it would report already_terminal (the race-safe path).
  assert.equal(isTerminalWorkflowRunStatus('completed'), true);
  const r2 = cancelWorkflowRunAtBoundary({ runId: 'lifecycle-done', reason: 'x', source: 'workflow-lifecycle-cleanup', expectedWorkflow: 'wf-x' });
  assert.equal(r2.status, 'already_terminal');
  assert.equal(JSON.parse(readFileSync(done, 'utf-8')).status, 'completed', 'a finished run is never rewritten');
});
