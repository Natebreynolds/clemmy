import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-report-back-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { SessionStore } = await import('../memory/session-store.js');
const {
  _setWorkflowRunReportBackBeforeCheckpointLockForTests,
  _setWorkflowRunReportBackDeliveryForTests,
  attemptWorkflowRunReportBack,
  checkpointWorkflowRunReportBack,
  recordAndAttemptWorkflowRunReportBack,
  workflowRunReportBackNeedsRetry,
  workflowRunReportBackRetryDue,
} = await import('./workflow-run-report-back.js');
const { cancelWorkflowRunAtBoundary } = await import('./workflow-run-cancellation.js');
const { runWorkflowWatchdog } = await import('./workflow-watchdog.js');

test.after(() => {
  _setWorkflowRunReportBackBeforeCheckpointLockForTests();
  _setWorkflowRunReportBackDeliveryForTests();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const REPORT_MODULE_URL = new URL('./workflow-run-report-back.ts', import.meta.url).href;

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runFile(runId: string): string {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  return path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
}

function writeRun(runId: string, originSessionId?: string): string {
  const file = runFile(runId);
  writeFileSync(file, JSON.stringify({
    id: runId,
    workflow: 'Ack Workflow',
    status: 'completed',
    finishedAt: new Date().toISOString(),
    ...(originSessionId ? { originSessionId } : {}),
  }), 'utf-8');
  return file;
}

function readRun(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, any>;
}

function addLateOrigin(runId: string, originSessionId: string): void {
  const runKey = createHash('sha256').update(runId).digest('hex');
  const originKey = createHash('sha256').update(originSessionId).digest('hex');
  const dir = path.join(WORKFLOW_RUNS_DIR, '.run-origins', runKey);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${originKey}.json`), JSON.stringify({
    version: 1,
    runId,
    originSessionId,
    recordedAt: new Date().toISOString(),
  }), 'utf-8');
}

test('failed origin write stays unacknowledged and a later retry marks notified exactly once', () => {
  const runId = 'report-retry';
  const origin = 'report-retry-origin';
  const file = writeRun(runId, origin);
  _setWorkflowRunReportBackDeliveryForTests(() => ({
    acknowledged: false,
    written: false,
    disposition: 'failed',
  }));

  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'durable result',
  }), false);
  const failed = readRun(file);
  assert.equal(failed.notifiedAt, undefined, 'failed origin write cannot close report-back');
  assert.deepEqual(failed.reportBack.acknowledgedOriginSessionIds, []);
  assert.equal(workflowRunReportBackNeedsRetry(failed), true);

  _setWorkflowRunReportBackDeliveryForTests();
  runWorkflowWatchdog();
  const delivered = readRun(file);
  assert.equal(typeof delivered.reportBackAcknowledgedAt, 'string');
  assert.equal(delivered.notifiedAt, undefined, 'origin acknowledgement is not dashboard notification evidence');
  assert.deepEqual(delivered.reportBack.acknowledgedOriginSessionIds, [origin]);
  assert.equal(workflowRunReportBackNeedsRetry(delivered), false);
  assert.equal(
    new SessionStore().get(origin).turns.filter((turn) => turn.text.startsWith(`[workflow run ${runId} `)).length,
    1,
  );
});

test('crash-after-delivery retry treats the existing idempotent turn as an acknowledgement', () => {
  const runId = 'report-duplicate-ack';
  const origin = 'report-duplicate-origin';
  const file = writeRun(runId, origin);
  const store = new SessionStore();
  store.appendTurn(origin, {
    role: 'user',
    text: `[workflow run ${runId} completed] Ack Workflow\n\nalready delivered`,
    createdAt: new Date().toISOString(),
  });

  assert.equal(checkpointWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'durable result',
  }), true);
  assert.equal(attemptWorkflowRunReportBack(file), true);
  const delivered = readRun(file);
  assert.equal(typeof delivered.reportBackAcknowledgedAt, 'string');
  assert.equal(delivered.notifiedAt, undefined);
  assert.deepEqual(delivered.reportBack.acknowledgedOriginSessionIds, [origin]);
  assert.equal(
    new SessionStore().get(origin).turns.filter((turn) => turn.text.startsWith(`[workflow run ${runId} `)).length,
    1,
    'idempotent acknowledgement does not append a second terminal turn',
  );
});

test('origin completion never impersonates the dashboard notification marker', () => {
  const file = writeRun('report-marker-split');
  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'dashboard card still required',
  }), true);
  const delivered = readRun(file);
  assert.equal(typeof delivered.reportBackAcknowledgedAt, 'string');
  assert.equal(delivered.notifiedAt, undefined);
  assert.equal(workflowRunReportBackNeedsRetry(delivered), false);
});

test('a late observer sidecar reopens the acknowledged generation until that origin is delivered', () => {
  const runId = 'report-late-origin';
  const firstOrigin = 'report-origin-a';
  const lateOrigin = 'report-origin-b';
  const file = writeRun(runId, firstOrigin);
  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'durable result',
  }), true);
  assert.equal(workflowRunReportBackNeedsRetry(readRun(file)), false);

  addLateOrigin(runId, lateOrigin);
  assert.equal(
    workflowRunReportBackNeedsRetry(readRun(file)),
    true,
    'late observer is required even though the earlier origin generation was acknowledged',
  );
  assert.equal(attemptWorkflowRunReportBack(file), true);
  const delivered = readRun(file);
  assert.deepEqual(
    [...delivered.reportBack.acknowledgedOriginSessionIds].sort(),
    [firstOrigin, lateOrigin].sort(),
  );
  for (const origin of [firstOrigin, lateOrigin]) {
    assert.equal(
      new SessionStore().get(origin).turns.filter((turn) => turn.text.startsWith(`[workflow run ${runId} `)).length,
      1,
      `${origin} receives exactly one terminal turn`,
    );
  }
});

test('a corrupt durable report envelope fails closed even when an old notifiedAt marker exists', () => {
  const runId = 'report-corrupt-envelope';
  const file = writeRun(runId, 'report-corrupt-origin');
  const run = readRun(file);
  run.notifiedAt = new Date().toISOString();
  run.reportBack = {
    version: 1,
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'durable result',
    acknowledgedOriginSessionIds: 'not-an-array',
  };
  writeFileSync(file, JSON.stringify(run), 'utf-8');
  assert.equal(workflowRunReportBackNeedsRetry(readRun(file)), true);
  assert.equal(attemptWorkflowRunReportBack(file), false);
});

test('cancellation winning immediately before checkpoint cannot accept a stale success envelope', () => {
  const runId = 'report-cancel-checkpoint-race';
  const file = runFile(runId);
  writeFileSync(file, JSON.stringify({
    id: runId,
    workflow: 'Ack Workflow',
    status: 'running',
  }), 'utf-8');
  _setWorkflowRunReportBackBeforeCheckpointLockForTests(() => {
    const result = cancelWorkflowRunAtBoundary({
      runId,
      reason: 'cancel won boundary',
      source: 'report-race-test',
    });
    assert.equal(result.status, 'cancelled');
  });
  try {
    assert.equal(checkpointWorkflowRunReportBack(file, {
      workflowName: 'Ack Workflow',
      outcome: 'done',
      detail: 'stale success',
    }), false);
  } finally {
    _setWorkflowRunReportBackBeforeCheckpointLockForTests();
  }
  const run = readRun(file);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.reportBack.outcome, 'failed');
  assert.equal(run.reportBack.detail, 'cancel won boundary');
});

test('the first exact terminal envelope is immutable even when another lane is status-compatible', () => {
  const file = writeRun('report-envelope-immutable', 'report-envelope-origin');
  assert.equal(checkpointWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'first exact body',
  }), true);
  assert.equal(checkpointWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'blocked',
    detail: 'different compatible body',
  }), false);
  assert.equal(readRun(file).reportBack.detail, 'first exact body');
  assert.equal(readRun(file).reportBack.outcome, 'done');
});

test('a locked old attempt cannot overwrite or split a competing exact envelope', async () => {
  const runId = 'report-locked-generation';
  const file = writeRun(runId);
  assert.equal(checkpointWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'first exact body',
  }), true);
  const ready = path.join(TMP_HOME, `${runId}.ready`);
  const release = path.join(TMP_HOME, `${runId}.release`);
  const attemptResult = path.join(TMP_HOME, `${runId}.attempt-result`);
  const checkpointResult = path.join(TMP_HOME, `${runId}.checkpoint-result`);
  const childCode = String.raw`
    import { writeFileSync } from 'node:fs';
    const mod = await import(process.env.CLEM_REPORT_MODULE_URL);
    const result = process.env.CLEM_REPORT_OP === 'attempt'
      ? mod.attemptWorkflowRunReportBack(process.env.CLEM_REPORT_FILE)
      : mod.checkpointWorkflowRunReportBack(process.env.CLEM_REPORT_FILE, JSON.parse(process.env.CLEM_REPORT_INPUT));
    writeFileSync(process.env.CLEM_REPORT_RESULT, String(result), 'utf-8');
  `;
  const attempt = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childCode], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEM_REPORT_MODULE_URL: REPORT_MODULE_URL,
      CLEM_REPORT_OP: 'attempt',
      CLEM_REPORT_FILE: file,
      CLEM_REPORT_RESULT: attemptResult,
      CLEMENTINE_TEST_REPORT_BACK_LOCK_READY: ready,
      CLEMENTINE_TEST_REPORT_BACK_LOCK_RELEASE: release,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let checkpoint: ReturnType<typeof spawn> | undefined;
  try {
    await waitForFile(ready);
    checkpoint = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childCode], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLEM_REPORT_MODULE_URL: REPORT_MODULE_URL,
        CLEM_REPORT_OP: 'checkpoint',
        CLEM_REPORT_FILE: file,
        CLEM_REPORT_RESULT: checkpointResult,
        CLEM_REPORT_INPUT: JSON.stringify({
          workflowName: 'Ack Workflow',
          outcome: 'blocked',
          detail: 'competing body',
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(checkpointResult), false, 'checkpoint waits behind the in-flight merge lock');
    writeFileSync(release, 'continue', 'utf-8');
    const [[attemptCode], [checkpointCode]] = await Promise.all([
      once(attempt, 'close') as Promise<[number | null]>,
      once(checkpoint, 'close') as Promise<[number | null]>,
    ]);
    assert.equal(attemptCode, 0);
    assert.equal(checkpointCode, 0);
    assert.equal(readFileSync(attemptResult, 'utf-8'), 'true');
    assert.equal(readFileSync(checkpointResult, 'utf-8'), 'false');
    const final = readRun(file);
    assert.equal(final.reportBack.detail, 'first exact body');
    assert.equal(typeof final.reportBackAcknowledgedAt, 'string');
    assert.equal(final.notifiedAt, undefined);
  } finally {
    if (attempt.exitCode === null) attempt.kill('SIGKILL');
    if (checkpoint?.exitCode === null) checkpoint.kill('SIGKILL');
  }
});

test('corrupt report evidence backs off and then quarantines without clearing pending truth', () => {
  const runId = 'report-corrupt-backoff';
  const file = writeRun(runId, 'report-corrupt-backoff-origin');
  const run = readRun(file);
  run.notifiedAt = new Date(0).toISOString();
  run.reportBack = { version: 1, outcome: 'done', acknowledgedOriginSessionIds: 'invalid' };
  writeFileSync(file, JSON.stringify(run), 'utf-8');

  let now = 1_000_000;
  assert.equal(attemptWorkflowRunReportBack(file, now), false);
  let after = readRun(file);
  assert.equal(after.reportBackRetry.failureCount, 1);
  assert.equal(after.notifiedAt, new Date(0).toISOString(), 'origin retry cannot erase dashboard notification evidence');
  assert.equal(after.reportBackAcknowledgedAt, undefined);
  assert.equal(workflowRunReportBackNeedsRetry(after), true);
  assert.equal(workflowRunReportBackRetryDue(after, now), false);
  const unchanged = readFileSync(file, 'utf-8');
  assert.equal(attemptWorkflowRunReportBack(file, now), false);
  assert.equal(readFileSync(file, 'utf-8'), unchanged, 'not-due timer ticks perform no rewrite/fsync');

  now = Date.parse(after.reportBackRetry.nextAttemptAt);
  assert.equal(attemptWorkflowRunReportBack(file, now), false);
  after = readRun(file);
  assert.equal(after.reportBackRetry.failureCount, 2);
  now = Date.parse(after.reportBackRetry.nextAttemptAt);
  assert.equal(attemptWorkflowRunReportBack(file, now), false);
  after = readRun(file);
  assert.equal(after.reportBackRetry.failureCount, 3);
  assert.equal(typeof after.reportBackRetry.quarantinedAt, 'string');
  assert.equal(workflowRunReportBackNeedsRetry(after), true);
  assert.equal(workflowRunReportBackRetryDue(after, now + 365 * 24 * 60 * 60_000), false);
});
