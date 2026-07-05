import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-recovery-lineage-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { buildWorkflowRecoveryLineage } = await import('./workflow-recovery-lineage.js');

function writeRun(id: string, record: Record<string, unknown>): void {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${id}.json`), JSON.stringify({ id, ...record }, null, 2), 'utf-8');
}

beforeEach(() => {
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
});

test('buildWorkflowRecoveryLineage links source run, failed-item retry, and child safe rerun', () => {
  writeRun('run-source', {
    workflow: 'Recovery Lineage Flow',
    status: 'completed_with_errors',
    createdAt: '2026-07-05T10:00:00.000Z',
  });
  writeRun('run-retry-items', {
    workflow: 'Recovery Lineage Flow',
    status: 'failed',
    createdAt: '2026-07-05T10:05:00.000Z',
    retryFailedItemsFromRunId: 'run-source',
    retryFailedItemsStepId: 'send',
    retryFailedItemKeys: ['lead-2'],
    recoveryIntent: {
      kind: 'failed_items',
      createdAt: '2026-07-05T10:05:00.000Z',
      sourceRunId: 'run-source',
      sourceStepId: 'send',
      requestedFrom: 'graph',
      reason: 'graph node retry failed forEach items',
    },
  });
  writeRun('run-safe-rerun', {
    workflow: 'Recovery Lineage Flow',
    status: 'queued',
    createdAt: '2026-07-05T10:10:00.000Z',
    requeuedFromRunId: 'run-retry-items',
    recoveryIntent: {
      kind: 'safe_rerun',
      createdAt: '2026-07-05T10:10:00.000Z',
      sourceRunId: 'run-retry-items',
      sourceStepId: 'send',
      requestedFrom: 'inspector',
      reason: 'operator verified repair and reran safely',
    },
  });

  const lineage = buildWorkflowRecoveryLineage('recovery-lineage-flow', 'Recovery Lineage Flow', 'run-retry-items');
  assert.deepEqual(lineage.map((entry) => entry.runId), ['run-source', 'run-retry-items', 'run-safe-rerun']);
  assert.equal(lineage[0]?.isCurrent, false);
  assert.equal(lineage[1]?.isCurrent, true);
  assert.equal(lineage[1]?.kind, 'failed_items');
  assert.equal(lineage[1]?.sourceRunId, 'run-source');
  assert.equal(lineage[1]?.sourceStepId, 'send');
  assert.equal(lineage[1]?.requestedFrom, 'graph');
  assert.equal(lineage[2]?.kind, 'safe_rerun');
  assert.equal(lineage[2]?.sourceRunId, 'run-retry-items');
  assert.equal(lineage[2]?.requestedFrom, 'inspector');
});

test('buildWorkflowRecoveryLineage stays empty for ordinary unrelated runs', () => {
  writeRun('run-normal', {
    workflow: 'Recovery Lineage Flow',
    status: 'completed',
    createdAt: '2026-07-05T10:00:00.000Z',
  });

  assert.deepEqual(buildWorkflowRecoveryLineage('recovery-lineage-flow', 'Recovery Lineage Flow', 'run-normal'), []);
});

after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});
