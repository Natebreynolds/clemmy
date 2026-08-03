import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
  compiledWorkflowRunContractHash,
  compiledWorkflowRunInputsHash,
  compiledProjectRootTerminalDigest,
} = await import('./compiled-project-run-contract.js');
const {
  _setWorkflowRunReaperAfterCanonicalUnlinkForTests,
  _setWorkflowRunReaperBeforeLockForTests,
  reapStaleWorkflowRuns,
} = await import('./workflow-scheduler.js');
const {
  createWorkflowChatDispatchPreparationAuthority,
  createWorkflowChatDispatchPreparedReceipt,
  createWorkflowOriginGroupCloseAuthority,
  createWorkflowOriginGroupClosedBatchReceipt,
  finalizeWorkflowOriginGroupClosedBatch,
  recordWorkflowChatDispatchAdmission,
  recordWorkflowChatDispatchPreparation,
  recordWorkflowOriginGroupClosedBatch,
  workflowChatDispatchQueueRequestDigest,
  workflowRunHasPendingChatDispatchPreparation,
} = await import('./workflow-origin-group.js');
const { recordAndAttemptWorkflowRunReportBack } = await import('./workflow-run-report-back.js');
const { appendEvent, createSession } = await import('../runtime/harness/eventlog.js');

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

let exactPreparationSeq = 20_000;

function activateExactOriginGroup(
  runIds: readonly string[],
  originSessionId: string,
  sourceUserSeq: number,
): void {
  const receipts = runIds.map((runId) => {
    const authority = createWorkflowChatDispatchPreparationAuthority({
      runId,
      observer: {
        sessionId: originSessionId,
        sourceUserSeq,
        replyTarget: { type: 'origin_chat' },
      },
      queueRequestDigest: workflowChatDispatchQueueRequestDigest({
        workflowName: 'Retention Workflow',
        normalizedInputs: { runId },
      }),
    });
    exactPreparationSeq += 1;
    return recordWorkflowChatDispatchPreparation(createWorkflowChatDispatchPreparedReceipt(authority, {
      eventId: `reaper-prepared-${exactPreparationSeq}`,
      eventSeq: exactPreparationSeq,
      preparedAt: new Date(1_800_000_000_000 + exactPreparationSeq).toISOString(),
    }));
  });
  const closeAuthority = createWorkflowOriginGroupCloseAuthority(receipts);
  exactPreparationSeq += 1;
  recordWorkflowOriginGroupClosedBatch({
    receipt: createWorkflowOriginGroupClosedBatchReceipt(closeAuthority, {
      eventId: `reaper-closed-${exactPreparationSeq}`,
      eventSeq: exactPreparationSeq,
      closedAt: new Date(1_800_000_000_000 + exactPreparationSeq).toISOString(),
    }),
    preparedReceipts: receipts,
  });
  finalizeWorkflowOriginGroupClosedBatch(closeAuthority.sourceGroupId, {
    beforeMemberRelease: () => {},
  });
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

function writeCompiledRun(label: string, record: Record<string, unknown> = {}): {
  runId: string;
  file: string;
  workflowSlug: string;
  runDir: string;
} {
  const sourceTurnKeyHash = createHash('sha256').update(`turn:${label}`).digest('hex');
  const workflowSlug = `compiled-${sourceTurnKeyHash.slice(0, 32)}`;
  const rootWorkflowReceiptId = `project-turn:v2:${sourceTurnKeyHash}`;
  const runId = `trigger-${createHash('sha256').update(rootWorkflowReceiptId).digest('hex').slice(0, 32)}`;
  const sourceExecutionId = `exec-project-${sourceTurnKeyHash.slice(0, 32)}`;
  const sessionId = `session-${label}`;
  const definition = {
    name: `project-${createHash('sha256').update(label).digest('hex').slice(0, 16)}`,
    description: 'Retention hygiene test project',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'work', prompt: 'Do the work', sideEffect: 'read' as const }],
  };
  const workflowDefinitionSnapshot = createCompiledWorkflowRunDefinitionSnapshot({
    workflowSlug,
    sourceTurnKeyHash,
    definition,
    admittedAt: OLD_FINISHED_AT,
  });
  const inputs: Record<string, string> = {};
  const compiledContractHash = compiledWorkflowRunContractHash({
    sourceExecutionId,
    sourceUserSeq: 1,
    sourceTurnKeyHash,
    originSessionId: sessionId,
    workflowSlug,
    snapshot: workflowDefinitionSnapshot,
    inputs,
  });
  const suppliedReportBack = record.reportBack;
  const { reportBack: _ignoredReportBack, ...recordOverrides } = record;
  const reportBack = suppliedReportBack && typeof suppliedReportBack === 'object'
    ? {
      ...(suppliedReportBack as {
        version: 1;
        workflowName: string;
        outcome: 'done' | 'blocked' | 'failed';
        detail: string;
        acknowledgedOriginSessionIds: string[];
      }),
      workflowName: definition.name,
    }
    : {
      version: 1 as const,
      workflowName: definition.name,
      outcome: 'done' as const,
      detail: 'Delivered terminal result',
      acknowledgedOriginSessionIds: [sessionId, 'observer'],
    };
  const terminalDigest = compiledProjectRootTerminalDigest({
      id: runId,
      workflow: definition.name,
      workflowSlug,
      sourceExecutionId,
      sourceTurnKeyHash,
      sessionId,
      sourceUserSeq: 1,
      rootWorkflowReceiptId,
      status: 'completed',
      terminalOutcome: 'succeeded',
      finishedAt: OLD_FINISHED_AT,
      snapshotDefinitionHash: workflowDefinitionSnapshot.definitionHash,
      snapshotAdmissionHash: workflowDefinitionSnapshot.admissionHash,
      snapshotAdmittedAt: workflowDefinitionSnapshot.admittedAt,
      compiledContractHash,
      normalizedInputsHash: compiledWorkflowRunInputsHash(inputs),
      mutationReceiptProtocolVersion: 1,
      reportBack: {
        version: reportBack.version,
        workflowName: reportBack.workflowName,
        outcome: reportBack.outcome,
        detail: reportBack.detail,
      },
  });
  return {
    file: writeRun(runId, {
      workflow: definition.name,
      workflowSlug,
      source: 'project_graph',
      sourceExecutionId,
      sourceUserSeq: 1,
      originSessionId: sessionId,
      triggerReceiptId: rootWorkflowReceiptId,
      inputs,
      compiledContractHash,
      mutationReceiptProtocolVersion: 1,
      terminalOutcome: 'succeeded',
      workflowDefinitionSnapshot,
      reportBack,
      notifiedAt: OLD_FINISHED_AT,
      reportBackAcknowledgedAt: OLD_FINISHED_AT,
      projectExecutionSettlement: {
        version: 1,
        executionId: sourceExecutionId,
        terminalDigest,
        settledAt: OLD_FINISHED_AT,
      },
      ...recordOverrides,
    }),
    runId,
    workflowSlug,
    runDir: path.join(WORKFLOWS_DIR, workflowSlug, 'runs', runId),
  };
}

beforeEach(() => {
  _setWorkflowRunReaperAfterCanonicalUnlinkForTests();
  _setWorkflowRunReaperBeforeLockForTests();
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
});

test.after(() => {
  _setWorkflowRunReaperAfterCanonicalUnlinkForTests();
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

test('reaper revalidates staged ownership after its optimistic scan for an acknowledged shared terminal', () => {
  const runId = 'late-staged-shared-terminal';
  const file = writeRun(runId, {
    originSessionId: 'already-settled-origin',
    notifiedAt: OLD_FINISHED_AT,
    reportBack: {
      version: 1,
      workflowName: 'Retention Workflow',
      outcome: 'done',
      detail: 'The prior observer is fully settled.',
      acknowledgedOriginSessionIds: ['already-settled-origin'],
    },
  });
  const admission = createWorkflowChatDispatchPreparationAuthority({
    runId,
    observer: {
      sessionId: 'new-unresolved-source',
      sourceUserSeq: 4101,
      replyTarget: { type: 'origin_chat' },
    },
    queueRequestDigest: workflowChatDispatchQueueRequestDigest({
      workflowName: 'Retention Workflow',
      normalizedInputs: {},
    }),
  });
  let staged = 0;
  _setWorkflowRunReaperBeforeLockForTests((candidate) => {
    if (candidate !== file) return;
    staged += 1;
    recordWorkflowChatDispatchAdmission(admission);
  });

  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 1, deleted: 0 });
  assert.equal(staged, 1);
  assert.equal(existsSync(file), true);
  const durable = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  assert.equal(
    durable.chatDispatchSourceGroupId,
    undefined,
    'a shared run has no new-source inline field; the dedicated stage is the only hold',
  );
});

test('reaper preserves an old terminal duplicate while its exact chat dispatch is prepared but unsettled', () => {
  const runId = 'prepared-terminal-duplicate';
  const file = writeRun(runId, {});
  const authority = createWorkflowChatDispatchPreparationAuthority({
    runId,
    observer: {
      sessionId: 'prepared-terminal-session',
      sourceUserSeq: 41,
      replyTarget: { type: 'origin_chat' },
    },
    queueRequestDigest: workflowChatDispatchQueueRequestDigest({
      workflowName: 'Retention Workflow',
      normalizedInputs: {},
    }),
  });
  const receipt = createWorkflowChatDispatchPreparedReceipt(authority, {
    eventId: 'prepared-terminal-event',
    eventSeq: 42,
    preparedAt: new Date().toISOString(),
  });
  recordWorkflowChatDispatchPreparation(receipt);

  assert.equal(workflowRunHasPendingChatDispatchPreparation(runId), true);
  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 1, deleted: 0 });
  assert.equal(existsSync(file), true, 'dispatch evidence survives until the exact group terminal is acknowledged');
});

test('reaper retains every settled group member until all per-run projections can compact', () => {
  const originSessionId = 'partial-settlement-retention-origin';
  createSession({
    id: originSessionId,
    kind: 'chat',
    channel: 'desktop',
    metadata: {},
  });
  const source = appendEvent({
    sessionId: originSessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Run both old reviews and report once.' },
  });
  const runA = 'partial-settlement-retention-a';
  const runB = 'partial-settlement-retention-b';
  const fileA = writeRun(runA, { originSessionId });
  const fileB = writeRun(runB, { originSessionId });
  activateExactOriginGroup([runA, runB], originSessionId, source.seq);

  assert.equal(recordAndAttemptWorkflowRunReportBack(fileB, {
    workflowName: 'Retention Workflow B',
    outcome: 'done',
    detail: 'B checkpointed first but has no settlement projection yet.',
  }), false);
  assert.equal(recordAndAttemptWorkflowRunReportBack(fileA, {
    workflowName: 'Retention Workflow A',
    outcome: 'done',
    detail: 'A completed the reducer and projected the shared settlement.',
  }), true);

  assert.equal(
    workflowRunHasPendingChatDispatchPreparation(runA),
    true,
    'bare group settlement is not retention-ready while B lacks its projection',
  );
  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 2, deleted: 0 });
  assert.equal(existsSync(fileA), true, 'the early acknowledged member remains a reducer input');
  assert.equal(existsSync(fileB), true, 'the unprojected member remains retryable');
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
  const { runId, file, runDir, workflowSlug } = writeCompiledRun('compiled-retention-hygiene', {
    notifiedAt: OLD_FINISHED_AT,
    reportBack: {
      version: 1,
      workflowName: 'Compiled retention hygiene',
      outcome: 'done',
      detail: 'Delivered terminal result',
      acknowledgedOriginSessionIds: ['session-compiled-retention-hygiene', 'observer'],
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

test('post-unlink hygiene failure cannot resurrect a canonical run or become a false reap failure', () => {
  const runId = 'durable-unlink-before-hygiene';
  const file = writeRun(runId, {
    originSessionId: 'durable-unlink-origin',
    notifiedAt: OLD_FINISHED_AT,
    reportBack: {
      version: 1,
      workflowName: 'Retention Workflow',
      outcome: 'done',
      detail: 'Already delivered before retention.',
      acknowledgedOriginSessionIds: ['durable-unlink-origin', 'observer'],
    },
  });
  const sidecars = writeRunSidecars(runId);
  let seamCalls = 0;
  _setWorkflowRunReaperAfterCanonicalUnlinkForTests((candidate) => {
    if (candidate !== file) return;
    seamCalls += 1;
    throw new Error('simulated crash before post-unlink hygiene');
  });

  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 1, deleted: 1 });
  assert.equal(seamCalls, 1);
  assert.equal(existsSync(file), false, 'the fsynced canonical deletion remains the reap authority');
  assert.equal(existsSync(sidecars.originDir), true, 'a crash leaves only harmless orphaned exact authority');
  assert.equal(existsSync(sidecars.cancellationFile), true, 'post-unlink hygiene is explicitly best-effort');
  assert.equal(existsSync(sidecars.triggerReceiptFile), true);
});

test('reaper preserves a compiled terminal until exact project-ledger settlement is marked', () => {
  const unmarked = writeCompiledRun('compiled-unsettled', {
    projectExecutionSettlement: undefined,
  });
  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 1, deleted: 0 });
  assert.equal(existsSync(unmarked.file), true);

  rmSync(unmarked.file, { force: true });
  const wrongSource = writeCompiledRun('compiled-wrong-source', {
    source: 'workflow_run',
  });
  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 1, deleted: 0 });
  assert.equal(existsSync(wrongSource.file), true);
});

test('reaper fail-closes malformed project lineage even when the compiled snapshot is missing', () => {
  const markers: Array<Record<string, unknown>> = [
    { sourceExecutionId: 'exec-project-partial' },
    { compiledContractHash: 'corrupt-contract' },
    { triggerReceiptId: `project-turn:v1:${'a'.repeat(64)}` },
    { workflowSlug: `compiled-${'d'.repeat(32)}` },
    { projectBoundAt: OLD_FINISHED_AT },
    { projectExecutionSettlement: { version: 1 } },
  ];
  const files = markers.map((marker, index) => writeRun(`partial-project-${index}`, marker));

  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: markers.length, deleted: 0 });
  for (const file of files) {
    assert.equal(existsSync(file), true, 'reserved crash evidence remains available for quarantine or repair');
  }
});

test('reaper never treats a symlinked project record as canonical settlement authority', () => {
  const compiled = writeCompiledRun('symlinked-project-root');
  const external = path.join(TMP_HOME, 'outside-project-root.json');
  writeFileSync(external, readFileSync(compiled.file));
  unlinkSync(compiled.file);
  symlinkSync(external, compiled.file);

  assert.deepEqual(reapStaleWorkflowRuns(), { scanned: 1, deleted: 0 });
  assert.equal(existsSync(compiled.file), true);
  assert.equal(existsSync(external), true);
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
  const { runId, file, runDir } = writeCompiledRun('compiled-mutation-retention');
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
    const { runId, file, runDir, workflowSlug } = writeCompiledRun(`compiled-catalog-${marker}`);
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

  assert.equal(existsSync(file), false, 'the canonical record disappears after run-owned graph cleanup');
  assert.equal(loadWorkflowGraphSnapshotByRunId(runId), null, 'the graph snapshot shares the run retention lifecycle');
  assert.equal(existsSync(path.join(runDir, 'events.jsonl')), false);
  assert.equal(existsSync(path.join(runDir, 'workspace')), false, 'large workspace artifacts do not leak past retention');
  assert.equal(existsSync(receipt), true, 'duplicate-prevention mutation receipts remain auditable');
});
