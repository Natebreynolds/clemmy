import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-reaper-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const {
  _setWorkflowRunReaperBeforeLockForTests,
  reapStaleWorkflowRuns,
} = await import('./workflow-scheduler.js');

const OLD_FINISHED_AT = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString();

function runFile(runId: string): string {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  return path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
}

function writeRun(runId: string, record: Record<string, unknown>): string {
  const file = runFile(runId);
  writeFileSync(file, JSON.stringify({
    id: runId,
    workflow: 'Retention Workflow',
    status: 'completed',
    finishedAt: OLD_FINISHED_AT,
    ...record,
  }), 'utf-8');
  return file;
}

beforeEach(() => {
  _setWorkflowRunReaperBeforeLockForTests();
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
});

test.after(() => {
  _setWorkflowRunReaperBeforeLockForTests();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('reaper preserves pending and quarantined terminal report-back evidence', () => {
  const file = writeRun('pending-report-back', {
    originSessionId: 'origin-pending',
    reportBack: {
      version: 1,
      workflowName: 'Retention Workflow',
      outcome: 'done',
      detail: 'Exact terminal result',
      acknowledgedOriginSessionIds: [],
    },
    reportBackRetry: {
      version: 1,
      kind: 'corrupt_evidence',
      failureCount: 3,
      lastFailureAt: OLD_FINISHED_AT,
      lastError: 'origin evidence is corrupt',
      quarantinedAt: OLD_FINISHED_AT,
    },
  });

  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 1, deleted: 0 });
  assert.equal(existsSync(file), true);
});

test('reaper revalidates under the record lock after a terminal scan races pending report-back', () => {
  const runId = 'fresh-lock-read';
  const file = writeRun(runId, {});
  let seamCalls = 0;
  _setWorkflowRunReaperBeforeLockForTests((candidate) => {
    if (candidate !== file) return;
    seamCalls += 1;
    // Simulate the report-back coordinator committing durable pending evidence
    // after the directory scan selected this filename but before reaping reaches
    // its linearization point.
    writeFileSync(file, JSON.stringify({
      id: runId,
      workflow: 'Retention Workflow',
      status: 'completed',
      finishedAt: OLD_FINISHED_AT,
      originSessionId: 'late-origin',
      reportBack: {
        version: 1,
        workflowName: 'Retention Workflow',
        outcome: 'done',
        detail: 'Must survive retention',
        acknowledgedOriginSessionIds: [],
      },
    }), 'utf-8');
  });

  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 1, deleted: 0 });
  assert.equal(seamCalls, 1);
  assert.equal(existsSync(file), true);
});

test('reaper still removes an old terminal record whose report-back is fully acknowledged', () => {
  const file = writeRun('acknowledged-report-back', {
    originSessionId: 'origin-done',
    notifiedAt: OLD_FINISHED_AT,
    reportBack: {
      version: 1,
      workflowName: 'Retention Workflow',
      outcome: 'done',
      detail: 'Delivered terminal result',
      acknowledgedOriginSessionIds: ['origin-done'],
    },
  });

  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 1, deleted: 1 });
  assert.equal(existsSync(file), false);
});
