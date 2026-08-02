import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { appendWorkflowEvent } = await import('./workflow-events.js');
const { compileWorkflowStepsToGraph } = await import('./workflow-graph.js');
const {
  loadWorkflowGraphSnapshotByRunId,
  persistWorkflowGraphSnapshot,
} = await import('./workflow-graph-store.js');
const { createCompiledWorkflowRunDefinitionSnapshot } = await import('./workflow-run-definition.js');
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

function sidecarKey(runId: string): string {
  return createHash('sha256').update(runId).digest('hex');
}

function writeRunSidecars(runId: string): {
  originDir: string;
  cancellationFile: string;
  triggerReceiptFile: string;
} {
  const key = sidecarKey(runId);
  const originDir = path.join(WORKFLOW_RUNS_DIR, '.run-origins', key);
  const cancellationFile = path.join(WORKFLOW_RUNS_DIR, '.cancellations', `${key}.json`);
  const triggerReceiptFile = path.join(WORKFLOW_RUNS_DIR, '.trigger-receipts', `${key}.json`);
  mkdirSync(originDir, { recursive: true });
  mkdirSync(path.dirname(cancellationFile), { recursive: true });
  mkdirSync(path.dirname(triggerReceiptFile), { recursive: true });
  writeFileSync(path.join(originDir, 'observer.json'), JSON.stringify({
    version: 1,
    runId,
    originSessionId: 'observer',
    recordedAt: OLD_FINISHED_AT,
  }), 'utf-8');
  writeFileSync(cancellationFile, '{"requested":true}', 'utf-8');
  writeFileSync(triggerReceiptFile, '{"accepted":true}', 'utf-8');
  return { originDir, cancellationFile, triggerReceiptFile };
}

function compiledWorkflowSlug(runId: string): string {
  return `compiled-${createHash('sha256').update(runId).digest('hex').slice(0, 32)}`;
}

function writeCompiledRun(runId: string, record: Record<string, unknown> = {}): {
  file: string;
  workflowSlug: string;
  runDir: string;
} {
  const workflowSlug = compiledWorkflowSlug(runId);
  const definition = {
    name: `project-${runId}`,
    description: 'Retention hygiene test project',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'work', prompt: 'Do the work', sideEffect: 'read' as const }],
  };
  const workflowDefinitionSnapshot = createCompiledWorkflowRunDefinitionSnapshot({
    workflowSlug,
    sourceTurnKeyHash: createHash('sha256').update(`turn:${runId}`).digest('hex'),
    definition,
    admittedAt: OLD_FINISHED_AT,
  });
  return {
    file: writeRun(runId, {
      workflow: definition.name,
      workflowDefinitionSnapshot,
      ...record,
    }),
    workflowSlug,
    runDir: path.join(WORKFLOWS_DIR, workflowSlug, 'runs', runId),
  };
}

beforeEach(() => {
  _setWorkflowRunReaperBeforeLockForTests();
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
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

test('reaper preserves a run when its admitted canonical owner evidence is corrupt', () => {
  const file = writeRun('corrupt-canonical-owner', {
    workflowDefinitionSnapshot: {
      version: 1,
      workflowSlug: 'canonical-owner',
      definitionHash: 'not-a-valid-hash',
    },
  });

  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 1, deleted: 0 });
  assert.equal(existsSync(file), true, 'the sole ownership record remains available for repair');
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

test('reaper removes terminal run sidecars and an empty catalogless compiled owner but preserves trigger receipts', () => {
  const runId = 'compiled-retention-hygiene';
  const { file, runDir, workflowSlug } = writeCompiledRun(runId, {
    originSessionId: 'origin-done',
    notifiedAt: OLD_FINISHED_AT,
    reportBack: {
      version: 1,
      workflowName: 'Compiled retention hygiene',
      outcome: 'done',
      detail: 'Delivered terminal result',
      acknowledgedOriginSessionIds: ['origin-done', 'observer'],
    },
  });
  appendWorkflowEvent(workflowSlug, runId, {
    kind: 'step_completed',
    stepId: 'work',
    output: 'durable result',
  });
  const sidecars = writeRunSidecars(runId);

  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 1, deleted: 1 });

  assert.equal(existsSync(file), false);
  assert.equal(existsSync(runDir), false);
  assert.equal(existsSync(path.join(WORKFLOWS_DIR, workflowSlug, 'runs')), false);
  assert.equal(existsSync(path.join(WORKFLOWS_DIR, workflowSlug)), false);
  assert.equal(existsSync(sidecars.originDir), false);
  assert.equal(existsSync(sidecars.cancellationFile), false);
  assert.equal(existsSync(sidecars.triggerReceiptFile), true, 'admission dedupe receipts have an independent lifecycle');
});

test('reaper keeps all sidecars while terminal report-back remains unacknowledged', () => {
  const runId = 'pending-sidecar-retention';
  const file = writeRun(runId, {
    originSessionId: 'origin-pending',
    reportBack: {
      version: 1,
      workflowName: 'Retention Workflow',
      outcome: 'done',
      detail: 'Still awaiting delivery',
      acknowledgedOriginSessionIds: [],
    },
  });
  const sidecars = writeRunSidecars(runId);

  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 1, deleted: 0 });
  assert.equal(existsSync(file), true);
  assert.equal(existsSync(sidecars.originDir), true);
  assert.equal(existsSync(sidecars.cancellationFile), true);
  assert.equal(existsSync(sidecars.triggerReceiptFile), true);
});

test('reaper preserves compiled owner directories when call-mutation receipts survive', () => {
  const runId = 'compiled-mutation-retention';
  const { file, runDir } = writeCompiledRun(runId);
  const mutationReceipt = path.join(runDir, 'call-mutations', 'work', 'intent.json');
  const transientArtifact = path.join(runDir, 'workspace', 'artifact.json');
  mkdirSync(path.dirname(mutationReceipt), { recursive: true });
  mkdirSync(path.dirname(transientArtifact), { recursive: true });
  writeFileSync(mutationReceipt, '{"state":"committed"}', 'utf-8');
  writeFileSync(transientArtifact, '{"large":true}', 'utf-8');
  const sidecars = writeRunSidecars(runId);

  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 1, deleted: 1 });

  assert.equal(existsSync(file), false);
  assert.equal(existsSync(mutationReceipt), true);
  assert.equal(existsSync(transientArtifact), false);
  assert.equal(existsSync(runDir), true, 'the retained mutation ledger keeps its ownership path reachable');
  assert.equal(existsSync(sidecars.originDir), false);
  assert.equal(existsSync(sidecars.cancellationFile), false);
  assert.equal(existsSync(sidecars.triggerReceiptFile), true);
});

test('reaper never prunes a compiled owner that has catalog evidence', () => {
  for (const marker of ['directory', 'legacy'] as const) {
    const runId = `compiled-catalog-${marker}`;
    const { file, runDir, workflowSlug } = writeCompiledRun(runId);
    appendWorkflowEvent(workflowSlug, runId, {
      kind: 'step_completed',
      stepId: 'work',
      output: 'durable result',
    });
    const ownerDir = path.join(WORKFLOWS_DIR, workflowSlug);
    const catalogFile = marker === 'directory'
      ? path.join(ownerDir, 'SKILL.md')
      : path.join(WORKFLOWS_DIR, `${workflowSlug}.md`);
    mkdirSync(path.dirname(catalogFile), { recursive: true });
    writeFileSync(catalogFile, '# Catalog evidence', 'utf-8');

    assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 1, deleted: 1 });
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(runDir), false);
    assert.equal(existsSync(path.join(ownerDir, 'runs')), true, `${marker} catalog owner keeps its run parent`);
    assert.equal(existsSync(ownerDir), true, `${marker} catalog owner is not retention-pruned`);
  }
});

test('reaper resolves the canonical graph-owner slug and retains only mutation receipts', () => {
  const runId = 'canonical-owner-retention';
  const workflowSlug = 'retention-workflow';
  const displayName = 'Retention Workflow';
  const file = writeRun(runId, { workflow: displayName });
  persistWorkflowGraphSnapshot({
    workflowName: workflowSlug,
    runId,
    graph: compileWorkflowStepsToGraph(
      [{ id: 'pull', prompt: 'pull metrics', sideEffect: 'read' }] as never[],
      { id: `${workflowSlug}:${runId}` },
    ),
  });
  appendWorkflowEvent(workflowSlug, runId, {
    kind: 'step_completed',
    stepId: 'pull',
    output: 'durable result',
  });
  const runDir = path.join(WORKFLOWS_DIR, workflowSlug, 'runs', runId);
  const receipt = path.join(runDir, 'call-mutations', 'pull', 'intent.json');
  const artifact = path.join(runDir, 'workspace', 'artifacts', 'pull.json');
  mkdirSync(path.dirname(receipt), { recursive: true });
  mkdirSync(path.dirname(artifact), { recursive: true });
  writeFileSync(receipt, '{"state":"committed"}', 'utf-8');
  writeFileSync(artifact, '{"rows":120}', 'utf-8');

  assert.ok(loadWorkflowGraphSnapshotByRunId(runId));
  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 1, deleted: 1 });

  assert.equal(existsSync(file), false, 'the terminal run record is reaped last');
  assert.equal(loadWorkflowGraphSnapshotByRunId(runId), null, 'the graph snapshot shares the run retention lifecycle');
  assert.equal(existsSync(path.join(runDir, 'events.jsonl')), false);
  assert.equal(existsSync(path.join(runDir, 'workspace')), false, 'large workspace artifacts do not leak past retention');
  assert.equal(existsSync(receipt), true, 'duplicate-prevention mutation receipts remain auditable');
});
