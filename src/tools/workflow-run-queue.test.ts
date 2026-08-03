/**
 * Run: npx tsx --test src/tools/workflow-run-queue.test.ts
 *
 * Deterministic core of ask-then-resume: queueWorkflowRun (queue + dedupe) and
 * resumeWorkflowRun (lookup + validate missing inputs + queue). No model calls.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-queue-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const {
  queueCompiledWorkflowRun,
  reconcileAwaitingCompiledWorkflowRunBindings,
  queueWorkflowRun,
  queueWorkflowDryRun,
  resumeWorkflowRun,
  requeueWorkflowFromRun,
  requeueWorkflowFailedItemsFromRun,
  queueWorkflowCreationTest,
  createWorkflowChatDispatchPreparedReceipt,
  createWorkflowOriginGroupCloseAuthority,
  createWorkflowOriginGroupClosedBatchReceipt,
  finalizeWorkflowOriginGroupClosedBatch,
  recordWorkflowChatDispatchPreparation,
  recordWorkflowOriginGroupClosedBatch,
  readWorkflowTriggerReceiptAcceptance,
  readWorkflowRunOriginRecords,
  readWorkflowRunOriginSessionIds,
  readPendingWorkflowChatDispatchOwnership,
  workflowRunOriginObserverId,
  WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
} = await import('./workflow-run-queue.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { ExecutionStore } = await import('../execution/store.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');
const {
  createCompiledWorkflowRunDefinitionSnapshot,
  workflowDefinitionHash,
} = await import('../execution/workflow-run-definition.js');
const { compiledWorkflowRunContractHash } = await import('../execution/compiled-project-run-contract.js');
const { compileProjectPlan } = await import('../execution/project-compiler.js');
const { appendWorkflowEvent } = await import('../execution/workflow-events.js');
const {
  executeWorkflowCallMutation,
  WorkflowCallMutationAmbiguousError,
  WorkflowCallMutationProvenFailureError,
} = await import('../execution/workflow-call-receipts.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('./shared.js');
const { resolveWorkflowRunDefinitionSnapshot } = await import('../execution/workflow-run-definition.js');

function writeAuditWorkflow(enabled = true): void {
  writeWorkflow('audit-brief', {
    name: 'audit-brief',
    description: 'Audit a site from a URL.',
    enabled,
    trigger: { manual: true },
    steps: [
      { id: 'normalize', prompt: 'Normalize the prospect: {{input.url}}.' },
      { id: 'blast', prompt: 'Analyze this prospect.', dependsOn: ['normalize'], forEach: 'normalize', sideEffect: 'read' },
      { id: 'blast_one', prompt: 'Run the first read-only analysis.', dependsOn: ['normalize'], forEach: 'normalize', sideEffect: 'read' },
      { id: 'blast_two', prompt: 'Run the second read-only analysis.', dependsOn: ['normalize'], forEach: 'normalize', sideEffect: 'read' },
    ],
  });
}

function compiledProjectAdmissionInput(input: {
  sessionId: string;
  sourceUserSeq: number;
  label: string;
  variant?: string;
  inputs?: Record<string, string>;
  requiredTopic?: boolean;
  omitAllowedTools?: boolean;
  allowedTools?: string[];
}): Record<string, unknown> {
  const variant = input.variant ?? 'winner';
  const safeLabel = input.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const instruction = input.requiredTopic
    ? `Perform bounded ${variant} work for {{input.topic}}.`
    : `Perform bounded ${variant} work.`;
  const plan = {
    planId: `compiled-project-${safeLabel}`,
    objective: 'Produce a durable verified deliverable.',
    nodes: [{
      id: 'work',
      executor: {
        kind: 'model' as const,
        instruction,
        ...(!input.omitAllowedTools
          ? { allowedTools: input.allowedTools ?? ['workspace_artifact_query'] }
          : {}),
      },
      effect: 'read' as const,
      maxTurns: 8,
      evidence: { type: 'object' as const, requiredKeys: ['summary'] },
    }],
  };
  const compiled = compileProjectPlan(plan);
  return {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    title: 'Durable project',
    objective: 'Produce a durable verified deliverable.',
    reason: 'Accepted as a long-horizon project.',
    startedFromMessage: 'Build the durable project.',
    confidence: 0.95,
    reasons: ['multi-step durable work'],
    admission: {
      compiledPlan: {
        version: 2,
        compilerId: 'project_graph_v2',
        planHash: compiled.planHash,
        definitionHash: workflowDefinitionHash(compiled.definition),
        plan,
        definition: compiled.definition,
        inputs: input.inputs ?? {},
      },
    },
  };
}

function seedCompiledProject(input: {
  label: string;
  variant?: string;
  inputs?: Record<string, string>;
  requiredTopic?: boolean;
  omitAllowedTools?: boolean;
  allowedTools?: string[];
}) {
  resetEventLog();
  const sessionId = `sess-compiled-${input.label}-${Math.random().toString(36).slice(2, 8)}`;
  createSession({ id: sessionId, kind: 'chat', title: input.label });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Build the durable project.', source: 'desktop' },
  });
  const sourceUserSeq = source.seq;
  const admissionInput = compiledProjectAdmissionInput({
    sessionId,
    sourceUserSeq,
    ...input,
  });
  const store = new ExecutionStore();
  const admitted = store.createOrGetForSource(admissionInput as never);
  return { sessionId, sourceUserSeq, admissionInput, store, admitted };
}

function runFiles(): string[] {
  try { return readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith('.json')); }
  catch { return []; }
}

let preparedEventSeq = 50_000;
const durablePreparationReceipts = new Map<
  string,
  ReturnType<typeof createWorkflowChatDispatchPreparedReceipt>
>();
function durablePreparationCallback() {
  return (authority: Parameters<typeof createWorkflowChatDispatchPreparedReceipt>[0]) => {
    const existing = durablePreparationReceipts.get(authority.preparationDigest);
    if (existing) return recordWorkflowChatDispatchPreparation(existing);
    preparedEventSeq += 1;
    const receipt = recordWorkflowChatDispatchPreparation(createWorkflowChatDispatchPreparedReceipt(authority, {
      eventId: `queue-prepared-${preparedEventSeq}`,
      eventSeq: preparedEventSeq,
      preparedAt: new Date(1_800_000_000_000 + preparedEventSeq).toISOString(),
    }));
    durablePreparationReceipts.set(authority.preparationDigest, receipt);
    return receipt;
  };
}

function closeAndActivateQueueGroup(
  preparations: NonNullable<ReturnType<typeof queueWorkflowRun>['chatDispatchPreparation']>[],
) {
  preparedEventSeq += 1;
  const authority = createWorkflowOriginGroupCloseAuthority(preparations);
  const receipt = createWorkflowOriginGroupClosedBatchReceipt(authority, {
    eventId: `queue-close-${preparedEventSeq}`,
    eventSeq: preparedEventSeq,
    closedAt: new Date(1_800_100_000_000 + preparedEventSeq).toISOString(),
  });
  recordWorkflowOriginGroupClosedBatch({ receipt, preparedReceipts: preparations });
  return finalizeWorkflowOriginGroupClosedBatch(authority.sourceGroupId, {
    beforeMemberRelease: () => {},
  });
}

function completedCompiledRecord(record: Record<string, any>): Record<string, any> {
  return {
    ...record,
    status: 'completed',
    terminalOutcome: 'succeeded',
    finishedAt: new Date().toISOString(),
    reportBack: {
      version: 1,
      workflowName: record.workflow,
      outcome: 'done',
      detail: 'The exact compiled project completed.',
      acknowledgedOriginSessionIds: [],
    },
  };
}

async function waitForPath(file: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const QUEUE_MODULE_URL = pathToFileURL(path.join(process.cwd(), 'src/tools/workflow-run-queue.ts')).href;

function launchQueueChild(
  url: string,
  resultFile: string,
  extraEnv: Record<string, string> = {},
) {
  const childCode = `
    import { writeFileSync } from 'node:fs';
    const mod = await import(process.env.CLEM_QUEUE_MODULE_URL);
    try {
      const result = mod.queueWorkflowRun('audit-brief', { url: process.env.CLEM_QUEUE_URL }, {
        ...(process.env.CLEM_QUEUE_ORIGIN ? { originSessionId: process.env.CLEM_QUEUE_ORIGIN } : {}),
        ...(process.env.CLEM_QUEUE_RECEIPT ? { triggerReceiptId: process.env.CLEM_QUEUE_RECEIPT } : {}),
      });
      writeFileSync(process.env.CLEM_QUEUE_RESULT, JSON.stringify(result));
    } catch (error) {
      writeFileSync(process.env.CLEM_QUEUE_RESULT, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childCode], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEM_QUEUE_MODULE_URL: QUEUE_MODULE_URL,
      CLEM_QUEUE_URL: url,
      CLEM_QUEUE_RESULT: resultFile,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function launchCompiledQueueChild(
  sessionId: string,
  sourceUserSeq: number,
  resultFile: string,
) {
  const childCode = `
    import { writeFileSync } from 'node:fs';
    const mod = await import(process.env.CLEM_QUEUE_MODULE_URL);
    try {
      const result = mod.queueCompiledWorkflowRun({
        sessionId: process.env.CLEM_COMPILED_SESSION,
        sourceUserSeq: Number(process.env.CLEM_COMPILED_SOURCE_SEQ),
      });
      writeFileSync(process.env.CLEM_QUEUE_RESULT, JSON.stringify(result));
    } catch (error) {
      writeFileSync(process.env.CLEM_QUEUE_RESULT, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childCode], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEM_QUEUE_MODULE_URL: QUEUE_MODULE_URL,
      CLEM_COMPILED_SESSION: sessionId,
      CLEM_COMPILED_SOURCE_SEQ: String(sourceUserSeq),
      CLEM_QUEUE_RESULT: resultFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function launchReaperChild(
  resultFile: string,
  beforeLockReady: string,
  beforeLockRelease: string,
) {
  const schedulerModuleUrl = pathToFileURL(path.join(process.cwd(), 'src/execution/workflow-scheduler.ts')).href;
  const childCode = `
    import { existsSync, writeFileSync } from 'node:fs';
    const mod = await import(process.env.CLEM_SCHEDULER_MODULE_URL);
    const wait = new Int32Array(new SharedArrayBuffer(4));
    mod._setWorkflowRunReaperBeforeLockForTests(() => {
      writeFileSync(process.env.CLEM_REAPER_BEFORE_LOCK_READY, 'ready', 'utf-8');
      while (!existsSync(process.env.CLEM_REAPER_BEFORE_LOCK_RELEASE)) Atomics.wait(wait, 0, 0, 10);
    });
    try {
      writeFileSync(process.env.CLEM_REAPER_RESULT, JSON.stringify(mod.reapStaleWorkflowRuns()), 'utf-8');
    } catch (error) {
      writeFileSync(process.env.CLEM_REAPER_RESULT, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), 'utf-8');
    }
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childCode], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEM_SCHEDULER_MODULE_URL: schedulerModuleUrl,
      CLEM_REAPER_RESULT: resultFile,
      CLEM_REAPER_BEFORE_LOCK_READY: beforeLockReady,
      CLEM_REAPER_BEFORE_LOCK_RELEASE: beforeLockRelease,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

beforeEach(() => {
  durablePreparationReceipts.clear();
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  rmSync(path.join(TMP_HOME, 'state', 'executions.json'), { force: true });
});

test('queueCompiledWorkflowRun: requires the immutable ExecutionStore admission', () => {
  assert.throws(
    () => queueCompiledWorkflowRun({ sessionId: 'fabricated-session', sourceUserSeq: 1 }),
    /No durable project graph is admitted/i,
  );
  assert.deepEqual(runFiles(), []);
});

test('queueCompiledWorkflowRun: queues the persisted first winner without creating a catalog workflow', () => {
  const seeded = seedCompiledProject({ label: 'first-winner' });
  const queued = queueCompiledWorkflowRun({
    sessionId: seeded.sessionId,
    sourceUserSeq: seeded.sourceUserSeq,
  });
  assert.equal(queued.status, 'queued');
  assert.ok(queued.id);
  assert.equal(runFiles().length, 1);

  const record = JSON.parse(
    readFileSync(path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`), 'utf-8'),
  ) as Record<string, any>;
  assert.equal(record.status, 'queued');
  assert.equal(record.source, 'project_graph');
  assert.equal(record.sourceExecutionId, seeded.admitted.execution.id);
  assert.equal(record.sourceUserSeq, seeded.sourceUserSeq);
  assert.equal(record.originSessionId, seeded.sessionId);
  assert.equal(record.mutationReceiptProtocolVersion, WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION);
  const resolved = resolveWorkflowRunDefinitionSnapshot(record.workflowDefinitionSnapshot);
  assert.equal(resolved.status, 'valid');
  if (resolved.status === 'valid') assert.equal(resolved.snapshot.version, 3);
  assert.equal(
    seeded.store.getForSource(seeded.sessionId, seeded.sourceUserSeq)?.graphAdmission?.rootWorkflowRunId,
    queued.id,
  );
  assert.equal(
    existsSync(path.join(WORKFLOWS_DIR, String(record.workflowSlug), 'SKILL.md')),
    false,
  );

  const replay = queueCompiledWorkflowRun({
    sessionId: seeded.sessionId,
    sourceUserSeq: seeded.sourceUserSeq,
  });
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.id, queued.id);
  assert.equal(runFiles().length, 1);
  assert.equal(
    seeded.store.getForSource(seeded.sessionId, seeded.sourceUserSeq)?.workflowBindings
      ?.filter((binding) => binding.runId === queued.id).length,
    1,
  );
});

test('queueCompiledWorkflowRun: a losing planner cannot dispatch its own bytes', () => {
  const seeded = seedCompiledProject({ label: 'planner-race', variant: 'winner' });
  const losingInput = compiledProjectAdmissionInput({
    sessionId: seeded.sessionId,
    sourceUserSeq: seeded.sourceUserSeq,
    label: 'planner-race',
    variant: 'loser',
  });
  const losing = seeded.store.createOrGetForSource(losingInput as never);
  assert.equal(losing.plannerConflict, true);

  const queued = queueCompiledWorkflowRun({
    sessionId: seeded.sessionId,
    sourceUserSeq: seeded.sourceUserSeq,
  });
  const record = JSON.parse(
    readFileSync(path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`), 'utf-8'),
  ) as Record<string, any>;
  assert.match(record.workflowDefinitionSnapshot.definition.steps[0].prompt, /winner/);
  assert.doesNotMatch(record.workflowDefinitionSnapshot.definition.steps[0].prompt, /loser/);
});

test('queueCompiledWorkflowRun: exact replay fails closed after run-contract tampering', () => {
  const seeded = seedCompiledProject({ label: 'tampered-run' });
  const queued = queueCompiledWorkflowRun({
    sessionId: seeded.sessionId,
    sourceUserSeq: seeded.sourceUserSeq,
  });
  const file = path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`);
  const original = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, any>;
  writeFileSync(file, JSON.stringify({ ...original, inputs: { topic: 'tampered' } }), 'utf-8');
  assert.throws(
    () => queueCompiledWorkflowRun({
      sessionId: seeded.sessionId,
      sourceUserSeq: seeded.sourceUserSeq,
    }),
    /different run bytes/i,
  );
});

test('queueCompiledWorkflowRun: implicit capability defaults are explicit while wildcard plans fail before admission', () => {
  const defaulted = seedCompiledProject({ label: 'implicit-kernel', omitAllowedTools: true });
  const queued = queueCompiledWorkflowRun({
    sessionId: defaulted.sessionId,
    sourceUserSeq: defaulted.sourceUserSeq,
  });
  assert.equal(queued.status, 'queued');
  const record = JSON.parse(
    readFileSync(path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`), 'utf-8'),
  ) as Record<string, any>;
  assert.ok(record.workflowDefinitionSnapshot.definition.steps[0].allowedTools.length > 0);
  assert.equal(record.workflowDefinitionSnapshot.definition.steps[0].allowedTools.includes('*'), false);

  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  assert.throws(
    () => seedCompiledProject({ label: 'prefix-wildcard', allowedTools: ['composio_*'] }),
    /unknown tool|exact|wildcard/i,
  );
  assert.deepEqual(runFiles(), []);
});

test('queueCompiledWorkflowRun: catalog identity collision fails before root admission', () => {
  const seeded = seedCompiledProject({ label: 'catalog-collision' });
  const definition = seeded.admitted.execution.graphAdmission!.compiledPlan.definition;
  writeWorkflow(definition.name, {
    ...definition,
    description: 'Authored catalog workflow with the same identity.',
  });
  assert.throws(
    () => queueCompiledWorkflowRun({
      sessionId: seeded.sessionId,
      sourceUserSeq: seeded.sourceUserSeq,
    }),
    /collides with catalog workflow/i,
  );
  assert.deepEqual(runFiles(), []);
  assert.equal(
    seeded.store.getForSource(seeded.sessionId, seeded.sourceUserSeq)?.graphAdmission?.rootWorkflowRunId,
    undefined,
  );
});

test('queueCompiledWorkflowRun: recovers the crash window between run install, receipt, binding, and activation', () => {
  const seeded = seedCompiledProject({ label: 'crash-recovery' });
  const queued = queueCompiledWorkflowRun({
    sessionId: seeded.sessionId,
    sourceUserSeq: seeded.sourceUserSeq,
  });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`);
  const record = JSON.parse(readFileSync(runFile, 'utf-8')) as Record<string, unknown>;
  writeFileSync(runFile, JSON.stringify({ ...record, status: 'awaiting_project_bind' }), 'utf-8');
  rmSync(path.join(WORKFLOW_RUNS_DIR, '.trigger-receipts'), { recursive: true, force: true });

  const executionsFile = path.join(TMP_HOME, 'state', 'executions.json');
  const executions = JSON.parse(readFileSync(executionsFile, 'utf-8')) as Array<Record<string, any>>;
  const sourceExecution = executions.find((entry) => entry.id === seeded.admitted.execution.id)!;
  delete sourceExecution.graphAdmission.rootWorkflowRunId;
  sourceExecution.workflowBindings = [];
  writeFileSync(executionsFile, JSON.stringify(executions, null, 2), 'utf-8');

  const recovered = queueCompiledWorkflowRun({
    sessionId: seeded.sessionId,
    sourceUserSeq: seeded.sourceUserSeq,
  });
  assert.equal(recovered.status, 'duplicate');
  assert.equal(recovered.id, queued.id);
  assert.equal(
    (JSON.parse(readFileSync(runFile, 'utf-8')) as { status: string }).status,
    'queued',
  );
  assert.equal(
    seeded.store.getForSource(seeded.sessionId, seeded.sourceUserSeq)?.graphAdmission?.rootWorkflowRunId,
    queued.id,
  );
});

test('compiled project binding reconciler heals an interrupted admission without a user-request replay', () => {
  const seeded = seedCompiledProject({ label: 'boot-binding-recovery' });
  const queued = queueCompiledWorkflowRun({
    sessionId: seeded.sessionId,
    sourceUserSeq: seeded.sourceUserSeq,
  });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`);
  const record = JSON.parse(readFileSync(runFile, 'utf-8')) as Record<string, unknown>;
  writeFileSync(runFile, JSON.stringify({ ...record, status: 'awaiting_project_bind' }), 'utf-8');

  const executionsFile = path.join(TMP_HOME, 'state', 'executions.json');
  const executions = JSON.parse(readFileSync(executionsFile, 'utf-8')) as Array<Record<string, any>>;
  const sourceExecution = executions.find((entry) => entry.id === seeded.admitted.execution.id)!;
  delete sourceExecution.graphAdmission.rootWorkflowRunId;
  sourceExecution.workflowBindings = [];
  writeFileSync(executionsFile, JSON.stringify(executions, null, 2), 'utf-8');

  assert.deepEqual(reconcileAwaitingCompiledWorkflowRunBindings(), {
    scanned: 1,
    activated: 1,
    blockedReadiness: 0,
    rejected: 0,
  });
  assert.equal(
    (JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string }).status,
    'queued',
  );
  assert.equal(
    seeded.store.getForSource(seeded.sessionId, seeded.sourceUserSeq)?.graphAdmission?.rootWorkflowRunId,
    queued.id,
  );
});

test('compiled project binding reconciler installs an admitted root when no run directory survived', () => {
  const seeded = seedCompiledProject({ label: 'pre-run-crash-recovery' });
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });

  assert.equal(
    seeded.store.getForSource(seeded.sessionId, seeded.sourceUserSeq)?.graphAdmission?.rootWorkflowRunId,
    undefined,
  );
  assert.deepEqual(reconcileAwaitingCompiledWorkflowRunBindings(), {
    scanned: 1,
    activated: 1,
    blockedReadiness: 0,
    rejected: 0,
  });

  const rebound = seeded.store.getForSource(seeded.sessionId, seeded.sourceUserSeq);
  assert.equal(typeof rebound?.graphAdmission?.rootWorkflowRunId, 'string');
  const runFile = path.join(
    WORKFLOW_RUNS_DIR,
    `${rebound?.graphAdmission?.rootWorkflowRunId}.json`,
  );
  assert.equal(existsSync(runFile), true);
  assert.equal(
    (JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string }).status,
    'queued',
  );
});

test('compiled project recovery fails closed without starving the ordinary run lane when its ledger is corrupt', () => {
  const executionsFile = path.join(TMP_HOME, 'state', 'executions.json');
  mkdirSync(path.dirname(executionsFile), { recursive: true });
  const corruptBytes = '{ "graphAdmission": [';
  writeFileSync(executionsFile, corruptBytes, 'utf-8');

  assert.deepEqual(reconcileAwaitingCompiledWorkflowRunBindings(), {
    scanned: 0,
    activated: 0,
    blockedReadiness: 0,
    rejected: 1,
  });
  assert.equal(readFileSync(executionsFile, 'utf-8'), corruptBytes);
});

test('compiled project binding reconciler never activates a parked record without store authority', () => {
  const runId = 'forged-awaiting-project-bind';
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    status: 'awaiting_project_bind',
    source: 'project_graph',
    originSessionId: 'no-admitted-source',
    sourceUserSeq: 999_999,
  }), 'utf-8');

  assert.deepEqual(reconcileAwaitingCompiledWorkflowRunBindings(), {
    scanned: 1,
    activated: 0,
    blockedReadiness: 0,
    rejected: 1,
  });
  assert.equal(
    (JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string }).status,
    'awaiting_project_bind',
  );
});

test('compiled project terminal recovery rejects a self-consistent V3 snapshot forged after admission', () => {
  const seeded = seedCompiledProject({ label: 'forged-terminal-definition' });
  const queued = queueCompiledWorkflowRun({
    sessionId: seeded.sessionId,
    sourceUserSeq: seeded.sourceUserSeq,
  });
  const file = path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`);
  const admittedRun = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, any>;
  const admittedSnapshot = admittedRun.workflowDefinitionSnapshot;
  const forgedSnapshot = createCompiledWorkflowRunDefinitionSnapshot({
    workflowSlug: admittedSnapshot.workflowSlug,
    sourceTurnKeyHash: admittedSnapshot.sourceTurnKeyHash,
    admittedAt: admittedSnapshot.admittedAt,
    definition: {
      ...admittedSnapshot.definition,
      steps: admittedSnapshot.definition.steps.map((step: Record<string, unknown>, index: number) =>
        index === 0 ? { ...step, prompt: 'Run attacker-selected replacement work.' } : step),
    },
  });
  const forgedContractHash = compiledWorkflowRunContractHash({
    sourceExecutionId: admittedRun.sourceExecutionId,
    sourceUserSeq: admittedRun.sourceUserSeq,
    sourceTurnKeyHash: forgedSnapshot.sourceTurnKeyHash,
    originSessionId: admittedRun.originSessionId,
    workflowSlug: forgedSnapshot.workflowSlug,
    snapshot: forgedSnapshot,
    inputs: admittedRun.inputs,
  });
  writeFileSync(file, JSON.stringify(completedCompiledRecord({
    ...admittedRun,
    workflowDefinitionSnapshot: forgedSnapshot,
    compiledContractHash: forgedContractHash,
  }), null, 2), 'utf-8');

  const recovery = reconcileAwaitingCompiledWorkflowRunBindings();
  assert.equal(recovery.rejected, 1);
  assert.equal(
    seeded.store.getForSource(seeded.sessionId, seeded.sourceUserSeq)
      ?.graphAdmission?.rootWorkflowTerminal,
    undefined,
  );
  assert.equal(
    (JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>).projectExecutionSettlement,
    undefined,
  );
});

test('compiled project terminal recovery rejects a valid terminal copied under the wrong filename', () => {
  const seeded = seedCompiledProject({ label: 'copied-terminal-filename' });
  const queued = queueCompiledWorkflowRun({
    sessionId: seeded.sessionId,
    sourceUserSeq: seeded.sourceUserSeq,
  });
  const canonicalFile = path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`);
  const terminal = completedCompiledRecord(
    JSON.parse(readFileSync(canonicalFile, 'utf-8')) as Record<string, any>,
  );
  const copiedFile = path.join(WORKFLOW_RUNS_DIR, `copied-${queued.id}.json`);
  writeFileSync(copiedFile, JSON.stringify(terminal, null, 2), 'utf-8');

  const recovery = reconcileAwaitingCompiledWorkflowRunBindings();
  assert.equal(recovery.rejected, 1);
  assert.equal(
    seeded.store.getForSource(seeded.sessionId, seeded.sourceUserSeq)
      ?.graphAdmission?.rootWorkflowTerminal,
    undefined,
  );
  assert.equal(
    (JSON.parse(readFileSync(copiedFile, 'utf-8')) as Record<string, unknown>).projectExecutionSettlement,
    undefined,
  );
});

test('compiled project recovery skips a valid settlement marker without reopening ExecutionStore', () => {
  const seeded = seedCompiledProject({ label: 'settlement-marker-short-circuit' });
  const queued = queueCompiledWorkflowRun({
    sessionId: seeded.sessionId,
    sourceUserSeq: seeded.sourceUserSeq,
  });
  const file = path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`);
  const terminal = completedCompiledRecord(
    JSON.parse(readFileSync(file, 'utf-8')) as Record<string, any>,
  );
  writeFileSync(file, JSON.stringify(terminal, null, 2), 'utf-8');
  assert.equal(reconcileAwaitingCompiledWorkflowRunBindings().rejected, 0);
  assert.equal(
    typeof (JSON.parse(readFileSync(file, 'utf-8')) as Record<string, any>)
      .projectExecutionSettlement?.terminalDigest,
    'string',
  );

  // If recovery re-entered settlement, this deliberately absent source would
  // fail. The authenticated marker makes the second scan a store-free no-op.
  writeFileSync(path.join(TMP_HOME, 'state', 'executions.json'), '[]', 'utf-8');
  assert.deepEqual(reconcileAwaitingCompiledWorkflowRunBindings(), {
    scanned: 0,
    activated: 0,
    blockedReadiness: 0,
    rejected: 0,
  });
});

test('queueCompiledWorkflowRun: a V3 tombstone is authoritative only after the execution ledger was bound', () => {
  const seeded = seedCompiledProject({ label: 'retained-tombstone' });
  const queued = queueCompiledWorkflowRun({
    sessionId: seeded.sessionId,
    sourceUserSeq: seeded.sourceUserSeq,
  });
  rmSync(path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`), { force: true });

  const retainedReplay = queueCompiledWorkflowRun({
    sessionId: seeded.sessionId,
    sourceUserSeq: seeded.sourceUserSeq,
  });
  assert.equal(retainedReplay.status, 'duplicate');
  assert.equal(retainedReplay.id, queued.id);

  const executionsFile = path.join(TMP_HOME, 'state', 'executions.json');
  const executions = JSON.parse(readFileSync(executionsFile, 'utf-8')) as Array<Record<string, any>>;
  delete executions.find((entry) => entry.id === seeded.admitted.execution.id)!.graphAdmission.rootWorkflowRunId;
  writeFileSync(executionsFile, JSON.stringify(executions, null, 2), 'utf-8');
  assert.throws(
    () => queueCompiledWorkflowRun({
      sessionId: seeded.sessionId,
      sourceUserSeq: seeded.sourceUserSeq,
    }),
    /no retained run and was never bound/i,
  );
});

test('queueCompiledWorkflowRun: concurrent same-source callers converge on one bound root', async () => {
  const seeded = seedCompiledProject({ label: 'concurrent-source' });
  const resultA = path.join(TMP_HOME, `compiled-a-${Date.now()}.json`);
  const resultB = path.join(TMP_HOME, `compiled-b-${Date.now()}.json`);
  const children = [
    launchCompiledQueueChild(seeded.sessionId, seeded.sourceUserSeq, resultA),
    launchCompiledQueueChild(seeded.sessionId, seeded.sourceUserSeq, resultB),
  ];
  const exits = await Promise.all(children.map((child) => once(child, 'close')));
  assert.deepEqual(exits.map(([code]) => code), [0, 0]);
  const results = [resultA, resultB].map((file) =>
    JSON.parse(readFileSync(file, 'utf-8')) as { status?: string; id?: string; error?: string });
  assert.deepEqual(results.map((result) => result.error), [undefined, undefined]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['duplicate', 'queued']);
  assert.equal(results[0].id, results[1].id);
  assert.equal(runFiles().length, 1);
  const persisted = seeded.store.getForSource(seeded.sessionId, seeded.sourceUserSeq);
  assert.equal(persisted?.graphAdmission?.rootWorkflowRunId, results[0].id);
  assert.equal(
    persisted?.workflowBindings?.filter((binding) => binding.runId === results[0].id).length,
    1,
  );
  rmSync(resultA, { force: true });
  rmSync(resultB, { force: true });
});

test('queueWorkflowRun: cannot preempt the durable project source namespace', () => {
  assert.throws(
    () => queueWorkflowRun('audit-brief', {}, { source: 'project_graph' }),
    /queueCompiledWorkflowRun/,
  );
  assert.throws(
    () => queueWorkflowRun('audit-brief', {}, { triggerReceiptId: `project-turn:v2:${'a'.repeat(64)}` }),
    /queueCompiledWorkflowRun/,
  );
  assert.throws(
    () => queueWorkflowRun('audit-brief', {}, { triggerReceiptId: `project-turn:v1:${'a'.repeat(64)}` }),
    /queueCompiledWorkflowRun/,
  );
  assert.deepEqual(runFiles(), []);
});

test('queueWorkflowRun: writes a queued run and dedupes identical inputs', () => {
  const first = queueWorkflowRun('audit-brief', { url: 'https://site.example' });
  assert.equal(first.status, 'queued');
  // Fire-and-forget hand-off wording (A): names the workflow + says background + report-back.
  assert.match(first.message, /Queued "audit-brief"/);
  assert.match(first.message, /BACKGROUND/);
  assert.match(first.message, /report back/i);
  assert.match(first.message, /do NOT (wait|poll)/i);
  assert.equal(runFiles().length, 1);
  const record = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8')) as {
    mutationReceiptProtocolVersion?: unknown;
  };
  assert.equal(record.mutationReceiptProtocolVersion, WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION);

  const second = queueWorkflowRun('audit-brief', { url: 'https://site.example' });
  assert.equal(second.status, 'duplicate');
  assert.match(second.message, /No duplicate was queued/);
  assert.match(second.message, /running in the background/i);
  assert.equal(runFiles().length, 1);
});

test('queueWorkflowRun: finalizing remains active and cannot be queued twice', () => {
  const first = queueWorkflowRun('audit-brief', { url: 'https://finalizing.example' });
  assert.equal(first.status, 'queued');
  const file = path.join(WORKFLOW_RUNS_DIR, `${first.id}.json`);
  const record = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...record, status: 'finalizing' }), 'utf-8');

  const duplicate = queueWorkflowRun('audit-brief', { url: 'https://finalizing.example' });
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.id, first.id);
  assert.match(duplicate.message, /already finalizing/i);
  assert.equal(runFiles().length, 1, 'the terminal-judge window must not duplicate external effects');
});

test('every resolvable queue lane pins the exact content-hashed workflow definition', () => {
  writeAuditWorkflow(false);
  const queued = [
    queueWorkflowRun('audit-brief', { url: 'https://production.example' }, { dedupe: false }),
    queueWorkflowDryRun('audit-brief', { url: 'https://dry.example' }),
    queueWorkflowCreationTest('audit-brief', { url: 'https://creation.example' }),
  ];
  assert.ok(queued.every((result) => result.status === 'queued'));

  const records = runFiles().map((file) =>
    JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as {
      workflowDefinitionSnapshot?: unknown;
    });
  assert.equal(records.length, 3);
  for (const record of records) {
    const resolved = resolveWorkflowRunDefinitionSnapshot(record.workflowDefinitionSnapshot);
    assert.equal(resolved.status, 'valid');
    if (resolved.status !== 'valid') continue;
    assert.equal(resolved.snapshot.workflowSlug, 'audit-brief');
    assert.equal(resolved.snapshot.definition.enabled, false);
    assert.equal(resolved.snapshot.definition.steps[0].prompt, 'Normalize the prospect: {{input.url}}.');
  }
});

test('queue writers use create-only installs and never replace a colliding canonical run id', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const cases: Array<{ forcedId: string; queue: () => { status: string; id?: string } }> = [
    {
      forcedId: 'forced-production-collision',
      queue: () => queueWorkflowRun('audit-brief', { url: 'https://collision-production.test' }, { dedupe: false }),
    },
    {
      forcedId: 'forced-dry-run-collision',
      queue: () => queueWorkflowDryRun('audit-brief', { url: 'https://collision-dry.test' }),
    },
    {
      forcedId: 'forced-creation-test-collision',
      queue: () => queueWorkflowCreationTest('audit-brief', { url: 'https://collision-creation.test' }),
    },
  ];

  for (const { forcedId, queue } of cases) {
    const sentinel = {
      id: forcedId,
      workflow: 'do-not-replace',
      status: 'completed',
      sentinel: `${forcedId}-original`,
    };
    const sentinelFile = path.join(WORKFLOW_RUNS_DIR, `${forcedId}.json`);
    writeFileSync(sentinelFile, JSON.stringify(sentinel), 'utf-8');
    process.env.CLEMENTINE_TEST_QUEUE_RUN_ID_ONCE = forcedId;
    let result: { status: string; id?: string };
    try {
      result = queue();
    } finally {
      delete process.env.CLEMENTINE_TEST_QUEUE_RUN_ID_ONCE;
    }
    assert.equal(result.status, 'queued');
    assert.notEqual(result.id, forcedId);
    assert.deepEqual(JSON.parse(readFileSync(sentinelFile, 'utf-8')), sentinel);
  }
  assert.equal(runFiles().length, 6);
});

test('queueWorkflowRun: a paused creator cannot enter a replacement lock generation (cross-process ABA)', async () => {
  writeAuditWorkflow();
  const prefix = path.join(TMP_HOME, 'dedupe-aba');
  const aReady = `${prefix}-a-mkdir`;
  const aRelease = `${prefix}-a-release`;
  const aLost = `${prefix}-a-lost`;
  const aResult = `${prefix}-a-result`;
  const bOwned = `${prefix}-b-owned`;
  const bRelease = `${prefix}-b-release`;
  const bResult = `${prefix}-b-result`;
  for (const file of [aReady, aRelease, aLost, aResult, bOwned, bRelease, bResult]) rmSync(file, { force: true });
  const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/tools/workflow-run-queue.ts')).href;
  const childCode = `
    import { writeFileSync } from 'node:fs';
    const mod = await import(process.env.CLEM_QUEUE_MODULE_URL);
    const result = mod.queueWorkflowRun('audit-brief', { url: 'https://aba.test' });
    writeFileSync(process.env.CLEM_QUEUE_RESULT, JSON.stringify(result));
  `;
  const launch = (result: string, extraEnv: Record<string, string>) => spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', childCode],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLEMENTINE_HOME: TMP_HOME,
        HOME: TMP_HOME,
        CLEM_QUEUE_MODULE_URL: moduleUrl,
        CLEM_QUEUE_RESULT: result,
        // This test deliberately pauses a lock creator while replacing its
        // directory generation. Keep that pause outside the production 10s
        // acquisition deadline so scheduler load cannot turn fail-closed into
        // a false assertion failure.
        CLEMENTINE_TEST_DEDUPE_LOCK_TIMEOUT_MS: '120000',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const a = launch(aResult, {
    CLEMENTINE_TEST_DEDUPE_LOCK_MKDIR_READY: aReady,
    CLEMENTINE_TEST_DEDUPE_LOCK_MKDIR_RELEASE: aRelease,
    CLEMENTINE_TEST_DEDUPE_LOCK_GENERATION_LOST: aLost,
  });
  await waitForPath(aReady);
  const lockRoot = path.join(WORKFLOW_RUNS_DIR, '.dedupe-locks');
  const [oldGeneration] = readdirSync(lockRoot);
  assert.ok(oldGeneration);
  utimesSync(path.join(lockRoot, oldGeneration), new Date(0), new Date(0));

  const b = launch(bResult, {
    CLEMENTINE_TEST_DEDUPE_LOCK_OWNED_READY: bOwned,
    CLEMENTINE_TEST_DEDUPE_LOCK_OWNED_RELEASE: bRelease,
  });
  await waitForPath(bOwned);
  writeFileSync(aRelease, 'go');
  await waitForPath(aLost);
  writeFileSync(bRelease, 'go');

  const [[aCode], [bCode]] = await Promise.all([once(a, 'close'), once(b, 'close')]) as [[number | null], [number | null]];
  assert.equal(aCode, 0);
  assert.equal(bCode, 0);
  const outcomes = [aResult, bResult]
    .map((file) => JSON.parse(readFileSync(file, 'utf-8')) as { status: string });
  assert.deepEqual(outcomes.map((entry) => entry.status).sort(), ['duplicate', 'queued']);
  assert.equal(runFiles().length, 1);
});

test('queueWorkflowRun: corrupt live-owner evidence fails closed instead of being age-reclaimed', async (t) => {
  writeAuditWorkflow();
  const prefix = path.join(TMP_HOME, 'dedupe-corrupt-live');
  const ownerReady = `${prefix}-owned`;
  const ownerRelease = `${prefix}-release`;
  const ownerResult = `${prefix}-owner-result`;
  const contenderResult = `${prefix}-contender-result`;
  const url = 'https://corrupt-live-owner.test';
  const owner = launchQueueChild(url, ownerResult, {
    CLEMENTINE_TEST_DEDUPE_LOCK_OWNED_READY: ownerReady,
    CLEMENTINE_TEST_DEDUPE_LOCK_OWNED_RELEASE: ownerRelease,
  });
  t.after(() => {
    try { writeFileSync(ownerRelease, 'release'); } catch { /* best-effort child cleanup */ }
    if (owner.exitCode === null) owner.kill('SIGKILL');
  });
  const ownerClosed = once(owner, 'close');
  await waitForPath(ownerReady);

  const lockRoot = path.join(WORKFLOW_RUNS_DIR, '.dedupe-locks');
  const [lockName] = readdirSync(lockRoot);
  assert.ok(lockName);
  const lockDir = path.join(lockRoot, lockName);
  const [ownerName] = readdirSync(lockDir).filter((entry) => entry.startsWith('owner-'));
  assert.ok(ownerName);
  const ownerFile = path.join(lockDir, ownerName);
  writeFileSync(ownerFile, '{', 'utf-8');
  utimesSync(lockDir, new Date(0), new Date(0));

  const contender = launchQueueChild(url, contenderResult, {
    CLEMENTINE_TEST_DEDUPE_LOCK_TIMEOUT_MS: '250',
  });
  const contenderClosed = once(contender, 'close');
  await waitForPath(contenderResult);
  await contenderClosed;
  const contenderOutcome = JSON.parse(readFileSync(contenderResult, 'utf-8')) as { error?: string };
  assert.match(contenderOutcome.error ?? '', /unreadable owner record|refusing to reclaim/i);
  assert.equal(existsSync(ownerFile), true, 'contender did not unlink corrupt evidence owned by a live holder');
  assert.equal(runFiles().length, 0);

  writeFileSync(ownerRelease, 'release');
  await waitForPath(ownerResult);
  await ownerClosed;
  assert.equal((JSON.parse(readFileSync(ownerResult, 'utf-8')) as { status?: string }).status, 'queued');
  assert.equal(runFiles().length, 1);
  assert.equal(existsSync(ownerFile), true, 'holder release also leaves replaced/corrupt owner evidence fail-closed');
});

test('queueWorkflowRun: an old lock with malformed filename evidence is not mistaken for an empty pre-owner crash', async () => {
  writeAuditWorkflow();
  const prefix = path.join(TMP_HOME, 'dedupe-malformed-filename');
  const ready = `${prefix}-ready`;
  const release = `${prefix}-release-never`;
  const ownerResult = `${prefix}-owner-result-never`;
  const contenderResult = `${prefix}-contender-result`;
  const url = 'https://malformed-owner-filename.test';
  const creator = launchQueueChild(url, ownerResult, {
    CLEMENTINE_TEST_DEDUPE_LOCK_MKDIR_READY: ready,
    CLEMENTINE_TEST_DEDUPE_LOCK_MKDIR_RELEASE: release,
  });
  const creatorClosed = once(creator, 'close');
  await waitForPath(ready);
  const lockRoot = path.join(WORKFLOW_RUNS_DIR, '.dedupe-locks');
  const [lockName] = readdirSync(lockRoot);
  assert.ok(lockName);
  const lockDir = path.join(lockRoot, lockName);
  const malformedEvidence = path.join(lockDir, 'unexpected-owner-evidence.json');
  writeFileSync(malformedEvidence, JSON.stringify({ pid: creator.pid }), 'utf-8');
  creator.kill('SIGKILL');
  await creatorClosed;
  utimesSync(lockDir, new Date(0), new Date(0));

  const contender = launchQueueChild(url, contenderResult, {
    CLEMENTINE_TEST_DEDUPE_LOCK_TIMEOUT_MS: '250',
  });
  const contenderClosed = once(contender, 'close');
  await waitForPath(contenderResult);
  await contenderClosed;
  const outcome = JSON.parse(readFileSync(contenderResult, 'utf-8')) as { error?: string };
  assert.match(outcome.error ?? '', /invalid owner record|refusing to reclaim/i);
  assert.equal(existsSync(malformedEvidence), true);
  assert.equal(runFiles().length, 0);
});

test('queueWorkflowRun: an old empty generation from a pre-owner crash remains reclaimable', async () => {
  writeAuditWorkflow();
  const prefix = path.join(TMP_HOME, 'dedupe-empty-crash');
  const ready = `${prefix}-ready`;
  const release = `${prefix}-release-never`;
  const resultFile = `${prefix}-result-never`;
  const url = 'https://empty-owner-crash.test';
  const creator = launchQueueChild(url, resultFile, {
    CLEMENTINE_TEST_DEDUPE_LOCK_MKDIR_READY: ready,
    CLEMENTINE_TEST_DEDUPE_LOCK_MKDIR_RELEASE: release,
  });
  const creatorClosed = once(creator, 'close');
  await waitForPath(ready);
  creator.kill('SIGKILL');
  await creatorClosed;

  const lockRoot = path.join(WORKFLOW_RUNS_DIR, '.dedupe-locks');
  const [lockName] = readdirSync(lockRoot);
  assert.ok(lockName);
  const lockDir = path.join(lockRoot, lockName);
  assert.deepEqual(readdirSync(lockDir), []);
  utimesSync(lockDir, new Date(0), new Date(0));

  const recovered = queueWorkflowRun('audit-brief', { url });
  assert.equal(recovered.status, 'queued');
  assert.equal(runFiles().length, 1);
});

test('queueWorkflowRun: a valid dead owner is reclaimed without treating it as corruption', async () => {
  writeAuditWorkflow();
  const prefix = path.join(TMP_HOME, 'dedupe-dead-owner');
  const ready = `${prefix}-owned`;
  const release = `${prefix}-release-never`;
  const resultFile = `${prefix}-result-never`;
  const url = 'https://dead-owner.test';
  const creator = launchQueueChild(url, resultFile, {
    CLEMENTINE_TEST_DEDUPE_LOCK_OWNED_READY: ready,
    CLEMENTINE_TEST_DEDUPE_LOCK_OWNED_RELEASE: release,
  });
  const creatorClosed = once(creator, 'close');
  await waitForPath(ready);
  creator.kill('SIGKILL');
  await creatorClosed;

  const lockRoot = path.join(WORKFLOW_RUNS_DIR, '.dedupe-locks');
  const [lockName] = readdirSync(lockRoot);
  assert.ok(lockName);
  assert.equal(readdirSync(path.join(lockRoot, lockName)).filter((entry) => entry.startsWith('owner-')).length, 1);

  const recovered = queueWorkflowRun('audit-brief', { url });
  assert.equal(recovered.status, 'queued');
  assert.equal(runFiles().length, 1);
});

test('queueWorkflowRun: writes originSessionId when provided (Gap E)', () => {
  const r = queueWorkflowRun('audit-brief', { url: 'https://site.example' }, { originSessionId: 'sess-chat-1' });
  assert.equal(r.status, 'queued');
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.equal(rec.originSessionId, 'sess-chat-1');
});

test('queueWorkflowRun: exact origin is held without legacy authority until its group activates', () => {
  const identity = {
    sessionId: 'sess-chat-exact',
    sourceUserSeq: 41,
    replyTarget: { type: 'origin_chat' as const },
  };
  const queued = queueWorkflowRun('audit-brief', { url: 'https://exact-source.example' }, {
    originSessionId: identity.sessionId,
    originObserver: identity,
    prepareChatDispatch: durablePreparationCallback(),
  });
  assert.equal(queued.status, 'held');
  assert.ok(queued.chatDispatchPreparation);

  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.equal(rec.status, 'awaiting_chat_dispatch_seal');
  assert.ok(!('originSessionId' in rec), 'exact source is never projected into inline legacy authority');
  assert.deepEqual(readWorkflowRunOriginRecords(queued.id!), [], 'prepared authority remains private');
  assert.deepEqual(readPendingWorkflowChatDispatchOwnership(identity), {
    sourceGroupId: queued.chatDispatchPreparation!.sourceGroupId,
    originSessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    phase: 'prepared',
    runIds: [queued.id],
    runStatuses: { [queued.id!]: 'awaiting_chat_dispatch_seal' },
  });

  const { sealed } = closeAndActivateQueueGroup([queued.chatDispatchPreparation!]);
  assert.equal(
    readPendingWorkflowChatDispatchOwnership(identity),
    null,
    'durable activation transfers ownership away from the coarse foreground marker',
  );
  const exact = readWorkflowRunOriginRecords(queued.id!)[0];
  assert.equal(exact?.version, 2);
  if (exact?.version !== 2) assert.fail('exact observer record was not persisted as v2');
  assert.equal(exact.runId, queued.id);
  assert.equal(exact.observerId, workflowRunOriginObserverId(identity));
  assert.equal(exact.originSessionId, identity.sessionId);
  assert.equal(exact.sourceUserSeq, identity.sourceUserSeq);
  assert.deepEqual(exact.replyTarget, identity.replyTarget);
  assert.match(exact.replyTargetDigest, /^[a-f0-9]{64}$/);
  assert.equal(exact.sourceGroupId, sealed.sourceGroupId);
  assert.equal(exact.sourceGroupDigest, sealed.sourceGroupDigest);
  assert.ok(Date.parse(exact.recordedAt) > 0);
  assert.equal(JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8')).status, 'queued');
});

test('queueWorkflowRun: preparation failure leaves a fresh exact run non-executable with no observer', () => {
  const identity = {
    sessionId: 'sess-preparation-failure',
    sourceUserSeq: 44,
    replyTarget: { type: 'origin_chat' as const },
  };
  assert.throws(() => queueWorkflowRun('audit-brief', { url: 'https://prepare-failure.example' }, {
    originSessionId: identity.sessionId,
    originObserver: identity,
    prepareChatDispatch: () => {
      throw new Error('injected event fsync failure');
    },
  }), /injected event fsync failure/);
  const [file] = runFiles();
  const held = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8'));
  assert.equal(held.status, 'awaiting_chat_dispatch_seal');
  assert.ok(!('originSessionId' in held));
  assert.deepEqual(readWorkflowRunOriginRecords(held.id), []);
  assert.deepEqual(readPendingWorkflowChatDispatchOwnership(identity), {
    sourceGroupId: held.chatDispatchSourceGroupId,
    originSessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    phase: 'prepared',
    runIds: [held.id],
    runStatuses: { [held.id]: 'awaiting_chat_dispatch_seal' },
  }, 'the pre-prepared-event crash window still has recoverable queue ownership');

  const retry = queueWorkflowRun('audit-brief', { url: 'https://prepare-failure.example' }, {
    originSessionId: identity.sessionId,
    originObserver: identity,
    prepareChatDispatch: durablePreparationCallback(),
  });
  assert.equal(retry.status, 'duplicate');
  assert.equal(retry.id, held.id);
  assert.ok(retry.chatDispatchPreparation);
  assert.equal(readWorkflowRunOriginRecords(held.id).length, 0);
});

test('queueWorkflowRun: a returned event receipt without its run pin cannot claim preparation', () => {
  const identity = {
    sessionId: 'sess-preparation-missing-pin',
    sourceUserSeq: 144,
    replyTarget: { type: 'origin_chat' as const },
  };
  assert.throws(() => queueWorkflowRun('audit-brief', { url: 'https://prepare-missing-pin.example' }, {
    originSessionId: identity.sessionId,
    originObserver: identity,
    prepareChatDispatch: (authority) => createWorkflowChatDispatchPreparedReceipt(authority, {
      eventId: 'event-without-pin',
      eventSeq: 144_001,
      preparedAt: new Date(1_800_000_144_001).toISOString(),
    }),
  }), /before its durable run preparation pin was installed/);
  const [file] = runFiles();
  const held = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8'));
  assert.equal(held.status, 'awaiting_chat_dispatch_seal');
  assert.deepEqual(readWorkflowRunOriginRecords(held.id), []);
});

test('queueWorkflowRun: preparation failure cannot attach an observer to a duplicate live run', () => {
  const original = queueWorkflowRun('audit-brief', { url: 'https://duplicate-prepare-failure.example' });
  assert.equal(original.status, 'queued');
  assert.throws(() => queueWorkflowRun('audit-brief', { url: 'https://duplicate-prepare-failure.example' }, {
    originSessionId: 'sess-duplicate-prepare-failure',
    originObserver: {
      sessionId: 'sess-duplicate-prepare-failure',
      sourceUserSeq: 46,
      replyTarget: { type: 'origin_chat' },
    },
    prepareChatDispatch: () => {
      throw new Error('duplicate preparation fsync failed');
    },
  }), /duplicate preparation fsync failed/);
  assert.deepEqual(readWorkflowRunOriginRecords(original.id!), []);
  const record = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${original.id}.json`), 'utf-8'));
  assert.equal(record.status, 'queued');
  assert.ok(!('originSessionId' in record));
});

test('queueWorkflowRun: a legacy caller does not inherit an orphan exact-source hold', () => {
  const inputs = { url: 'https://orphan-exact-hold.example' };
  assert.throws(() => queueWorkflowRun('audit-brief', inputs, {
    originSessionId: 'sess-orphan-exact-hold',
    originObserver: {
      sessionId: 'sess-orphan-exact-hold',
      sourceUserSeq: 47,
      replyTarget: { type: 'origin_chat' },
    },
    prepareChatDispatch: () => {
      throw new Error('orphaned before preparation receipt');
    },
  }), /orphaned before preparation receipt/);
  const heldFile = runFiles()[0];
  const held = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, heldFile), 'utf-8'));
  assert.equal(held.status, 'awaiting_chat_dispatch_seal');

  const legacy = queueWorkflowRun('audit-brief', inputs, { originSessionId: 'sess-legacy' });
  assert.equal(legacy.status, 'queued');
  assert.notEqual(legacy.id, held.id);
});

test('queueWorkflowRun: an admitted source target is immutable at group seal', () => {
  const sessionId = 'sess-target-immutable';
  const inputs = { url: 'https://immutable-target.example' };
  const admitted = queueWorkflowRun('audit-brief', inputs, {
    originSessionId: sessionId,
    originObserver: {
      sessionId,
      sourceUserSeq: 45,
      replyTarget: { type: 'discord_channel', channelId: 'channel-a' },
    },
    prepareChatDispatch: durablePreparationCallback(),
  });
  assert.equal(admitted.status, 'held');
  closeAndActivateQueueGroup([admitted.chatDispatchPreparation!]);
  assert.throws(() => queueWorkflowRun('audit-brief', inputs, {
    originSessionId: sessionId,
    originObserver: {
      sessionId,
      sourceUserSeq: 45,
      replyTarget: { type: 'discord_channel', channelId: 'channel-b' },
    },
    prepareChatDispatch: durablePreparationCallback(),
  }), /closed to a different immutable reply target/);
});

test('queueWorkflowRun: two exact runs for one source activate as one ordered group and replay dedupes', () => {
  const sessionId = 'sess-chat-two-intents';
  const identity = {
    sessionId,
    sourceUserSeq: 51,
    replyTarget: { type: 'discord_channel' as const, channelId: 'channel-at-admission' },
  };
  const first = queueWorkflowRun('audit-brief', { url: 'https://two-intents-a.example' }, {
    originSessionId: sessionId,
    originObserver: identity,
    prepareChatDispatch: durablePreparationCallback(),
  });
  const second = queueWorkflowRun('audit-brief', { url: 'https://two-intents-b.example' }, {
    originSessionId: sessionId,
    originObserver: identity,
    prepareChatDispatch: durablePreparationCallback(),
  });
  assert.equal(first.status, 'held');
  assert.equal(second.status, 'held');
  assert.notEqual(first.id, second.id);
  const { sealed } = closeAndActivateQueueGroup([
    first.chatDispatchPreparation!,
    second.chatDispatchPreparation!,
  ]);
  assert.deepEqual(sealed.members.map((member) => member.runId), [first.id, second.id]);
  assert.equal(readWorkflowRunOriginRecords(first.id!).length, 1);
  assert.equal(readWorkflowRunOriginRecords(second.id!).length, 1);

  const firstFile = path.join(WORKFLOW_RUNS_DIR, `${first.id}.json`);
  const firstTerminal = JSON.parse(readFileSync(firstFile, 'utf-8'));
  writeFileSync(firstFile, JSON.stringify({ ...firstTerminal, status: 'completed' }), 'utf-8');

  const replay = queueWorkflowRun('audit-brief', { url: 'https://two-intents-a.example' }, {
    originSessionId: sessionId,
    originObserver: identity,
    prepareChatDispatch: () => {
      assert.fail('a closed source-group replay must reuse its durable preparation');
    },
  });
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.id, first.id);
  assert.equal(readWorkflowRunOriginRecords(first.id!).length, 1, 'same exact observer installs once');
});

test('queueWorkflowRun: duplicate attaches the current origin so report-back can still land here', () => {
  const first = queueWorkflowRun('audit-brief', { url: 'https://site.example' });
  assert.equal(first.status, 'queued');

  const second = queueWorkflowRun('audit-brief', { url: 'https://site.example' }, { originSessionId: 'sess-chat-dup' });
  assert.equal(second.status, 'duplicate');

  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.ok(!('originSessionId' in rec), 'live run record is not rewritten by a duplicate observer');
  assert.deepEqual(readWorkflowRunOriginSessionIds(first.id!), ['sess-chat-dup']);
  assert.deepEqual(readWorkflowRunOriginRecords(first.id!).map((record) => ({
    version: record.version,
    originSessionId: record.originSessionId,
  })), [{ version: 1, originSessionId: 'sess-chat-dup' }], 'legacy session-only markers remain readable');
});

test('queueWorkflowRun: duplicate preserves primary origin and adds secondary origin observers', () => {
  const first = queueWorkflowRun('audit-brief', { url: 'https://site.example' }, { originSessionId: 'sess-chat-a' });
  assert.equal(first.status, 'queued');

  const second = queueWorkflowRun('audit-brief', { url: 'https://site.example' }, { originSessionId: 'sess-chat-b' });
  assert.equal(second.status, 'duplicate');

  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.equal(rec.originSessionId, 'sess-chat-a');
  assert.ok(!('originSessionIds' in rec), 'the runner-owned record remains immutable');
  assert.deepEqual(readWorkflowRunOriginSessionIds(first.id!), ['sess-chat-b']);

  queueWorkflowRun('audit-brief', { url: 'https://site.example' }, { originSessionId: 'sess-chat-b' });
  assert.deepEqual(readWorkflowRunOriginSessionIds(first.id!), ['sess-chat-b'], 'duplicate observer is not repeated');
});

test('queueWorkflowRun: late observer installation wins its record lock before retention can reap the acknowledged run', async () => {
  writeAuditWorkflow();
  const receiptId = 'receipt-late-observer-reaper-race';
  const first = queueWorkflowRun('audit-brief', { url: 'https://late-observer.test' }, {
    triggerReceiptId: receiptId,
    originSessionId: 'sess-original',
  });
  assert.equal(first.status, 'queued');
  const file = path.join(WORKFLOW_RUNS_DIR, `${first.id}.json`);
  const oldFinishedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString();
  const queued = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({
    ...queued,
    status: 'completed',
    finishedAt: oldFinishedAt,
    notifiedAt: oldFinishedAt,
    reportBackAcknowledgedAt: oldFinishedAt,
    reportBack: {
      version: 1,
      workflowName: 'audit-brief',
      outcome: 'done',
      detail: 'Original terminal result',
      acknowledgedOriginSessionIds: ['sess-original'],
    },
  }), 'utf-8');

  const prefix = path.join(TMP_HOME, 'late-observer-reaper-race');
  const attachOwned = `${prefix}-attach-owned`;
  const attachRelease = `${prefix}-attach-release`;
  const attachResult = `${prefix}-attach-result`;
  const reaperBeforeLock = `${prefix}-reaper-before-lock`;
  const reaperRelease = `${prefix}-reaper-release`;
  const reaperResult = `${prefix}-reaper-result`;
  const observer = launchQueueChild('https://late-observer.test', attachResult, {
    CLEM_QUEUE_ORIGIN: 'sess-late',
    CLEM_QUEUE_RECEIPT: receiptId,
    CLEMENTINE_TEST_RUN_RECORD_LOCK_OWNED_READY: attachOwned,
    CLEMENTINE_TEST_RUN_RECORD_LOCK_OWNED_RELEASE: attachRelease,
  });
  const observerClosed = once(observer, 'close') as Promise<[number | null]>;
  let reaper: ReturnType<typeof launchReaperChild> | undefined;
  try {
    await waitForPath(attachOwned);
    reaper = launchReaperChild(reaperResult, reaperBeforeLock, reaperRelease);
    const reaperClosed = once(reaper, 'close') as Promise<[number | null]>;
    await waitForPath(reaperBeforeLock);
    // The reaper has selected the old terminal record. Let it approach the
    // linearization lock while the observer owns that lock but has not yet
    // installed its sidecar, then release the observer to commit first.
    writeFileSync(reaperRelease, 'continue', 'utf-8');
    writeFileSync(attachRelease, 'continue', 'utf-8');
    const [[observerCode], [reaperCode]] = await Promise.all([
      observerClosed,
      reaperClosed,
    ]);
    assert.equal(observerCode, 0);
    assert.equal(reaperCode, 0);
    assert.equal((JSON.parse(readFileSync(attachResult, 'utf-8')) as { status?: string }).status, 'duplicate');
    assert.deepEqual(JSON.parse(readFileSync(reaperResult, 'utf-8')), { scanned: 1, deleted: 0 });
    assert.equal(existsSync(file), true, 'retention preserves the record until the late observer is acknowledged');
    assert.deepEqual(readWorkflowRunOriginSessionIds(first.id!), ['sess-late']);
  } finally {
    if (observer.exitCode === null) observer.kill('SIGKILL');
    if (reaper?.exitCode === null) reaper.kill('SIGKILL');
  }
});

test('queueWorkflowRun: distinct durable trigger receipts each own a run; same receipt retries do not duplicate', () => {
  const first = queueWorkflowRun('audit-brief', { url: 'https://site.example' }, { triggerReceiptId: 'receipt-a' });
  assert.equal(first.status, 'queued');

  const second = queueWorkflowRun('audit-brief', { url: 'https://site.example' }, { triggerReceiptId: 'receipt-b' });
  assert.equal(second.status, 'queued');

  assert.equal(readWorkflowTriggerReceiptAcceptance('receipt-a'), first.id);
  assert.equal(readWorkflowTriggerReceiptAcceptance('receipt-b'), second.id);
  assert.equal(runFiles().length, 2, 'distinct events are not silently coalesced merely because mapped inputs match');

  const retry = queueWorkflowRun('audit-brief', { url: 'https://site.example' }, { triggerReceiptId: 'receipt-a' });
  assert.equal(retry.status, 'duplicate');
  assert.equal(retry.id, first.id);
  assert.equal(runFiles().length, 2);
});

test('queueWorkflowRun: v2 trigger acceptance survives normal terminal run-file retention', () => {
  const queued = queueWorkflowRun('audit-brief', { url: 'https://site.example' }, { triggerReceiptId: 'receipt-retained-proof' });
  assert.equal(queued.status, 'queued');
  unlinkSync(path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`));
  assert.equal(
    readWorkflowTriggerReceiptAcceptance('receipt-retained-proof'),
    queued.id,
    'post-run marker remains terminal acceptance after the run record is reaped',
  );
});

test('queueWorkflowRun: a verified legacy v1 marker is promoted before its run can be reaped', () => {
  const receiptId = 'legacy-v1-receipt';
  const queued = queueWorkflowRun('audit-brief', { url: 'https://site.example' }, { triggerReceiptId: receiptId });
  assert.equal(queued.status, 'queued');
  const markerFile = path.join(
    WORKFLOW_RUNS_DIR,
    '.trigger-receipts',
    `${createHash('sha256').update(receiptId).digest('hex')}.json`,
  );
  const marker = JSON.parse(readFileSync(markerFile, 'utf-8')) as Record<string, unknown>;
  writeFileSync(markerFile, JSON.stringify({ ...marker, version: 1 }), 'utf-8');

  assert.equal(readWorkflowTriggerReceiptAcceptance(receiptId), queued.id);
  assert.equal((JSON.parse(readFileSync(markerFile, 'utf-8')) as { version: number }).version, 2);
  unlinkSync(path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`));
  assert.equal(readWorkflowTriggerReceiptAcceptance(receiptId), queued.id);
});

test('queueWorkflowRun: omits originSessionId when absent for notification-only runs (Gap E)', () => {
  queueWorkflowRun('audit-brief', { url: 'https://personal.example' });
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.ok(!('originSessionId' in rec), 'no origin → field is not written (notification-only run)');
});

test('queueWorkflowRun: source and targetStepId metadata do not collide with full-run dedupe', () => {
  const full = queueWorkflowRun('audit-brief', { url: 'https://site.example' });
  assert.equal(full.status, 'queued');

  const stepTry = queueWorkflowRun('audit-brief', { url: 'https://site.example' }, {
    source: 'console',
    targetStepId: 'normalize',
  });
  assert.equal(stepTry.status, 'queued');
  assert.equal(runFiles().length, 2, 'a TRY run is distinct from a full run with the same inputs');

  const duplicateTry = queueWorkflowRun('audit-brief', { url: 'https://site.example' }, {
    source: 'console',
    targetStepId: 'normalize',
  });
  assert.equal(duplicateTry.status, 'duplicate');
  assert.equal(runFiles().length, 2);

  const records = runFiles().map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>);
  const tryRecord = records.find((record) => record.targetStepId === 'normalize');
  assert.equal(tryRecord?.source, 'console');
  assert.deepEqual(tryRecord?.recoveryIntent, {
    kind: 'step_try',
    createdAt: tryRecord?.createdAt,
    sourceStepId: 'normalize',
    requestedFrom: 'console',
    reason: 'single-step try run',
  });
});

test('queueWorkflowRun: dedupe false queues fresh scheduled-style records with a prefix', () => {
  const first = queueWorkflowRun('audit-brief', {}, { source: 'schedule', idPrefix: 'sched', dedupe: false });
  const second = queueWorkflowRun('audit-brief', {}, { source: 'schedule', idPrefix: 'sched', dedupe: false });
  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'queued');
  assert.equal(runFiles().length, 2);

  const records = runFiles().map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>);
  assert.ok(records.every((record) => typeof record.id === 'string' && record.id.startsWith('sched-')));
  assert.ok(records.every((record) => record.source === 'schedule'));
});

test('queueWorkflowRun: persists execution optimization recovery intent', () => {
  const result = queueWorkflowRun('audit-brief', { url: 'https://site.example' }, {
    source: 'board',
    dedupe: false,
    recoveryIntent: {
      kind: 'execution_optimize',
      sourceRunId: 'source-run',
      sourceStepId: 'process_each',
      requestedFrom: 'graph_execution_drift',
      reason: 'graph execution optimization rerun: fanout_underused',
    },
  });
  assert.equal(result.status, 'queued');
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8')) as {
    createdAt?: string;
    recoveryIntent?: {
      kind?: string;
      createdAt?: string;
      sourceRunId?: string;
      sourceStepId?: string;
      requestedFrom?: string;
      reason?: string;
    };
  };
  assert.deepEqual(rec.recoveryIntent, {
    kind: 'execution_optimize',
    createdAt: rec.createdAt,
    sourceRunId: 'source-run',
    sourceStepId: 'process_each',
    requestedFrom: 'graph_execution_drift',
    reason: 'graph execution optimization rerun: fanout_underused',
  });
});

test('queueWorkflowRun: blocks production runs when required workflow capabilities are missing', () => {
  writeWorkflow('missing-script-flow', {
    name: 'missing-script-flow',
    description: 'Needs a deterministic helper.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'merge', prompt: 'Merge evidence.', deterministic: { runner: 'missing.py' } }],
  });

  const result = queueWorkflowRun('missing-script-flow', {});
  assert.equal(result.status, 'blocked_readiness');
  assert.match(result.message, /missing\.py/);
  assert.equal(runFiles().length, 0);
  assert.equal(result.readiness?.ok, false);
  assert.equal(result.readiness?.blockers[0]?.kind, 'script');
  assert.equal(result.readiness?.blockers[0]?.name, 'missing.py');
});

test('queueWorkflowRun: readiness-blocked trigger receipts remain unbound and later each recover exactly once', () => {
  writeWorkflow('pending-trigger-flow', {
    name: 'pending-trigger-flow',
    description: 'Waits for its deterministic helper.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'merge', prompt: 'Merge evidence.', deterministic: { runner: 'missing.py' } }],
  });

  const blockedA = queueWorkflowRun('pending-trigger-flow', {}, { triggerReceiptId: 'pending-receipt-a' });
  const blockedB = queueWorkflowRun('pending-trigger-flow', {}, { triggerReceiptId: 'pending-receipt-b' });
  assert.equal(blockedA.status, 'blocked_readiness');
  assert.equal(blockedB.status, 'blocked_readiness');
  assert.equal(readWorkflowTriggerReceiptAcceptance('pending-receipt-a'), null);
  assert.equal(readWorkflowTriggerReceiptAcceptance('pending-receipt-b'), null);
  assert.equal(runFiles().length, 0);

  const scriptsDir = path.join(WORKFLOWS_DIR, 'pending-trigger-flow', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(path.join(scriptsDir, 'missing.py'), 'print("ready")\n', 'utf-8');

  const first = queueWorkflowRun('pending-trigger-flow', {}, { triggerReceiptId: 'pending-receipt-a' });
  const second = queueWorkflowRun('pending-trigger-flow', {}, { triggerReceiptId: 'pending-receipt-b' });
  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'queued');
  assert.equal(runFiles().length, 2);
  assert.equal(readWorkflowTriggerReceiptAcceptance('pending-receipt-a'), first.id);
  assert.equal(readWorkflowTriggerReceiptAcceptance('pending-receipt-b'), second.id);
});

test('queueWorkflowRun: scheduler catch-up hold is atomic, receipt-bound, and remains skippable when readiness is blocked', () => {
  writeWorkflow('held-missing-script', {
    name: 'Held Missing Script',
    description: 'A missed scheduled workflow with a currently missing helper.',
    enabled: true,
    trigger: { schedule: '0 9 * * *' },
    steps: [{ id: 'merge', prompt: 'Merge evidence.', deterministic: { runner: 'missing.py' } }],
  });
  const firstDueAtMs = 1_800_000;
  const scheduledAtMs = 3_600_000;
  const receiptId = `workflow-schedule:v1:held-missing-script:${scheduledAtMs}`;
  const held = queueWorkflowRun('Held Missing Script', {}, {
    source: 'schedule',
    catchupFire: true,
    catchupOccurrenceAtMs: firstDueAtMs,
    holdForCatchupDecision: true,
    workflowSlug: 'held-missing-script',
    catchupFirstDueAtMs: firstDueAtMs,
    catchupMissedCount: 4,
    triggerReceiptId: receiptId,
    idPrefix: 'sched',
    dedupe: false,
  });

  assert.equal(held.status, 'held');
  assert.equal(held.readiness?.ok, false, 'red readiness is stored instead of hiding the Skip decision');
  assert.match(held.message, /no workflow step will run/i);
  assert.equal(readWorkflowTriggerReceiptAcceptance(receiptId), held.id);
  assert.equal(runFiles().length, 1);
  const record = JSON.parse(
    readFileSync(path.join(WORKFLOW_RUNS_DIR, `${held.id}.json`), 'utf-8'),
  ) as Record<string, unknown>;
  assert.equal(record.status, 'awaiting_catchup_decision', 'the first durable record is held, never briefly queued');
  assert.equal(record.source, 'schedule');
  assert.equal(record.catchupFire, true);
  assert.equal(record.catchupDisposition, 'held');
  assert.equal(record.workflowSlug, 'held-missing-script');
  assert.equal(record.catchupOccurrenceAtMs, firstDueAtMs);
  assert.equal(record.catchupFirstDueAtMs, firstDueAtMs);
  assert.equal(record.catchupScheduledAtMs, scheduledAtMs);
  assert.equal(record.catchupMissedCount, 4, 'count means total collapsed missed occurrences');
  assert.equal(record.catchupHeldAt, record.createdAt);
  assert.equal((record.readiness as { ok?: unknown }).ok, false);

  const replay = queueWorkflowRun('Held Missing Script', {}, {
    source: 'schedule',
    catchupFire: true,
    catchupOccurrenceAtMs: firstDueAtMs,
    holdForCatchupDecision: true,
    workflowSlug: 'held-missing-script',
    catchupFirstDueAtMs: firstDueAtMs,
    catchupMissedCount: 4,
    triggerReceiptId: receiptId,
    idPrefix: 'sched',
    dedupe: false,
  });
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.id, held.id);
  assert.equal(runFiles().length, 1);
  assert.equal(
    (JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${held.id}.json`), 'utf-8')) as Record<string, unknown>).status,
    'awaiting_catchup_decision',
  );
});

test('queueWorkflowRun: catch-up hold authority is schedule-only and canonical-receipt-bound', () => {
  writeAuditWorkflow();
  const base = {
    catchupFire: true,
    catchupOccurrenceAtMs: 60_000,
    holdForCatchupDecision: true,
    workflowSlug: 'audit-brief',
    catchupFirstDueAtMs: 60_000,
    catchupMissedCount: 1,
    triggerReceiptId: 'workflow-schedule:v1:audit-brief:120000',
  } as const;

  assert.throws(
    () => queueWorkflowRun('audit-brief', {}, { ...base, source: 'console' }),
    /requires source=schedule/i,
  );
  assert.throws(
    () => queueWorkflowRun('audit-brief', {}, {
      ...base,
      source: 'schedule',
      triggerReceiptId: 'unscoped-receipt',
    }),
    /canonical workflow schedule receipt/i,
  );
  assert.throws(
    () => queueWorkflowRun('audit-brief', {}, {
      ...base,
      source: 'schedule',
      catchupMissedCount: 0,
    }),
    /catch-up metadata/i,
  );
  assert.equal(runFiles().length, 0);
});

test('queueWorkflowRun: allows unknown Composio slugs as warnings when the broker exists', () => {
  writeWorkflow('unknown-composio-flow', {
    name: 'unknown-composio-flow',
    description: 'Uses a connected-app slug resolved at runtime.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'fetch', prompt: 'Fetch CRM records.', call: { tool: 'SALESFORCE_GET_RECORDS', args: {} } }],
  });

  const result = queueWorkflowRun('unknown-composio-flow', {});
  assert.equal(result.status, 'queued');
  assert.equal(result.readiness?.ok, true);
  assert.equal(result.readiness?.warnings[0]?.name, 'SALESFORCE_GET_RECORDS');
  assert.equal(runFiles().length, 1);
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8')) as {
    readiness?: {
      ok?: boolean;
      scope?: string;
      warnings?: Array<{ name?: string; sources?: string[]; evidence?: Array<{ kind?: string; name?: string; status?: string }> }>;
      toolReadiness?: { unknownCount?: number; items?: Array<{ name?: string; status?: string; evidence?: Array<{ kind?: string; name?: string; status?: string }> }> };
    };
  };
  assert.equal(rec.readiness?.ok, true);
  assert.equal(rec.readiness?.scope, 'run');
  assert.equal(rec.readiness?.warnings?.[0]?.name, 'SALESFORCE_GET_RECORDS');
  assert.deepEqual(rec.readiness?.warnings?.[0]?.sources, ['step_call']);
  assert.ok(rec.readiness?.warnings?.[0]?.evidence?.some((entry) => entry.kind === 'composio_broker' && entry.name === 'composio_execute_tool' && entry.status === 'ready'));
  assert.equal(rec.readiness?.toolReadiness?.unknownCount, 1);
});

test('queueWorkflowRun: step TRY readiness only checks the selected step', () => {
  writeWorkflow('try-readiness-flow', {
    name: 'try-readiness-flow',
    description: 'Has one safe step and one missing script.',
    enabled: false,
    trigger: { manual: true },
    steps: [
      { id: 'safe', prompt: 'Read local notes.', allowedTools: ['read_file'] },
      { id: 'broken', prompt: 'Merge evidence.', deterministic: { runner: 'missing.py' } },
    ],
  });

  const safe = queueWorkflowRun('try-readiness-flow', {}, { targetStepId: 'safe', dedupe: false });
  assert.equal(safe.status, 'queued');
  const safeRecord = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8')) as {
    readiness?: { ok?: boolean; scope?: string; targetStepId?: string; blockers?: unknown[]; toolReadiness?: { missingCount?: number } };
  };
  assert.equal(safeRecord.readiness?.ok, true);
  assert.equal(safeRecord.readiness?.scope, 'step');
  assert.equal(safeRecord.readiness?.targetStepId, 'safe');
  assert.deepEqual(safeRecord.readiness?.blockers, []);
  assert.equal(safeRecord.readiness?.toolReadiness?.missingCount, 1, 'full plan evidence is kept even when TRY readiness is scoped');
  const broken = queueWorkflowRun('try-readiness-flow', {}, { targetStepId: 'broken', dedupe: false });
  assert.equal(broken.status, 'blocked_readiness');
  assert.match(broken.message, /missing\.py/);
  assert.equal(runFiles().length, 1);
});

test('queueWorkflowDryRun: writes fresh dry_run records with console metadata', () => {
  const first = queueWorkflowDryRun('audit-brief', { url: 'https://site.example' }, { source: 'console' });
  const second = queueWorkflowDryRun('audit-brief', { url: 'https://site.example' }, { source: 'console' });
  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'queued');
  assert.equal(runFiles().length, 2);

  const records = runFiles().map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>);
  assert.ok(records.every((record) => record.status === 'dry_run'));
  assert.ok(records.every((record) => record.source === 'console'));
  assert.ok(records.every((record) =>
    record.mutationReceiptProtocolVersion === WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION));
});

test('resumeWorkflowRun: carries originSessionId through to the queued run (Gap E ask-then-resume)', () => {
  writeAuditWorkflow();
  const result = resumeWorkflowRun('audit-brief', { url: 'https://evergreen-group.example' }, { originSessionId: 'sess-chat-2' });
  assert.equal(result.status, 'queued');
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.equal(rec.originSessionId, 'sess-chat-2');
});

test('resumeWorkflowRun: missing required input → missing_inputs, no queue', () => {
  writeAuditWorkflow();
  const result = resumeWorkflowRun('audit-brief', {});
  assert.equal(result.status, 'missing_inputs');
  assert.deepEqual(result.missing, ['url']);
  assert.equal(runFiles().length, 0);
});

test('resumeWorkflowRun: all inputs supplied → queues the run', () => {
  writeAuditWorkflow();
  const result = resumeWorkflowRun('audit-brief', { url: 'https://evergreen-group.example' });
  assert.equal(result.status, 'queued');
  assert.match(result.message, /Queued "audit-brief"/);
  assert.equal(runFiles().length, 1);
});

test('resumeWorkflowRun: url alias (website) normalizes to satisfy url', () => {
  writeAuditWorkflow();
  const result = resumeWorkflowRun('audit-brief', { website: 'https://evergreen-group.example' });
  assert.equal(result.status, 'queued');
  assert.equal(runFiles().length, 1);
});

test('resumeWorkflowRun: unknown workflow → not_found', () => {
  const result = resumeWorkflowRun('does-not-exist', { url: 'https://site.example' });
  assert.equal(result.status, 'not_found');
  assert.equal(runFiles().length, 0);
});

test('resumeWorkflowRun: disabled workflow → disabled', () => {
  writeAuditWorkflow(false);
  const result = resumeWorkflowRun('audit-brief', { url: 'https://site.example' });
  assert.equal(result.status, 'disabled');
  assert.equal(runFiles().length, 0);
});

test('requeueWorkflowFromRun re-queues a failed run with its original inputs (build→fix→re-run loop)', () => {
  writeAuditWorkflow();
  // Simulate a prior FAILED run record (terminal → not a dedupe target).
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-failed-run';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({
      id: origId,
      workflow: 'audit-brief',
      inputs: { url: 'https://evergreen-group.example' },
      status: 'error',
      catchupFire: true,
    }),
    'utf-8',
  );
  const rq = requeueWorkflowFromRun(origId);
  assert.equal(rq.status, 'queued');
  // A NEW queued run exists for the same workflow + inputs.
  const queued = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as {
      workflow: string;
      inputs: Record<string, string>;
      status: string;
      createdAt?: string;
      catchupFire?: boolean;
      requeuedFromRunId?: string;
      recoveryIntent?: { kind?: string; createdAt?: string; sourceRunId?: string; reason?: string };
    });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].workflow, 'audit-brief');
  assert.equal(queued[0].inputs.url, 'https://evergreen-group.example');
  assert.equal(queued[0].status, 'queued');
  assert.equal(queued[0].catchupFire, true, 'whole-run/self-heal/goal lineage inherits catch-up admission');
  assert.equal(queued[0].requeuedFromRunId, origId);
  assert.deepEqual(queued[0].recoveryIntent, {
    kind: 'manual_requeue',
    createdAt: queued[0].createdAt,
    sourceRunId: origId,
    reason: 'whole-run requeue',
  });
});

test('legacy requeue helpers refuse every reserved project marker before a same-name catalog collision can copy inputs', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const markers: Array<Record<string, unknown>> = [
    { source: 'project_graph' },
    { source: 'project_graph', workflowDefinitionSnapshot: 'corrupt-snapshot' },
    { sourceExecutionId: 'exec-project-partial' },
    { compiledContractHash: 'corrupt-contract' },
    { triggerReceiptId: `project-turn:v1:${'b'.repeat(64)}` },
    { workflowSlug: `compiled-${'c'.repeat(32)}` },
    {
      workflowDefinitionSnapshot: {
        version: 2,
        scope: 'compiled',
        compilerId: 'project_graph_v1',
      },
    },
  ];
  const sourceFiles: string[] = [];
  for (const [index, marker] of markers.entries()) {
    const id = `reserved-project-requeue-${index}`;
    sourceFiles.push(`${id}.json`);
    writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${id}.json`), JSON.stringify({
      id,
      workflow: 'audit-brief',
      inputs: { url: `PRIVATE_PROJECT_INPUT_${index}` },
      status: 'completed_with_errors',
      ...marker,
    }), 'utf-8');
  }

  const before = runFiles().sort();
  assert.deepEqual(before, sourceFiles.sort());
  for (const file of sourceFiles) {
    const id = file.slice(0, -'.json'.length);
    const wholeRun = requeueWorkflowFromRun(id);
    const failedItems = requeueWorkflowFailedItemsFromRun(id);
    assert.equal(wholeRun.status, 'project_owned', `${id} whole-run recovery must stay graph-owned`);
    assert.equal(failedItems.status, 'project_owned', `${id} failed-item recovery must stay graph-owned`);
    assert.match(wholeRun.message, /durable project root|admitted graph/i);
  }

  assert.deepEqual(runFiles().sort(), before, 'no fresh catalog run copies the project inputs');
  assert.equal(
    existsSync(path.join(WORKFLOW_RUNS_DIR, '.trigger-receipts')),
    false,
    'refusal happens before any receipt is installed',
  );
});

test('requeueWorkflowFromRun refuses to overlap a source run that is still executing', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-still-running';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://site-alt.example' }, status: 'running' }),
    'utf-8',
  );

  const result = requeueWorkflowFromRun(origId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /not terminal|still dispatch/i);
  assert.deepEqual(runFiles(), [`${origId}.json`]);
});

function writeMutationRequeueFixture(runId: string, receiptProtocol = false): void {
  writeWorkflow('mutation-requeue', {
    name: 'mutation-requeue',
    description: 'Creates a record before downstream work.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'create', prompt: 'Create the record.', sideEffect: 'write', call: { tool: 'AIRTABLE_CREATE_RECORD', args: { table: 'Prospects' } } },
      { id: 'finish', prompt: 'Summarize it.', dependsOn: ['create'] },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'mutation-requeue',
    inputs: {},
    status: 'error',
    ...(receiptProtocol
      ? {
          mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
          mutationContractSnapshot: {
            version: 1,
            steps: { create: 'structured_call_receipt' },
          },
        }
      : {}),
  }), 'utf-8');
}

function mutationReceiptInput(runId: string) {
  return {
    workflowSlug: 'mutation-requeue',
    runId,
    stepId: 'create',
    tool: 'AIRTABLE_CREATE_RECORD',
    account: { connectionId: 'ca-airtable' },
    args: { table: 'Prospects', fields: { name: 'Ada' } },
  };
}

function writeStructuredFanoutRequeueFixture(runId: string, receiptProtocol = false): void {
  writeWorkflow('structured-fanout-requeue', {
    name: 'structured-fanout-requeue',
    description: 'Creates one external record per source item.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'source', prompt: 'Read source items.', sideEffect: 'read' },
      {
        id: 'create_each',
        prompt: 'Create this item.',
        dependsOn: ['source'],
        forEach: 'source',
        sideEffect: 'write',
        call: { tool: 'AIRTABLE_CREATE_RECORD', args: { table: 'Prospects' } },
      },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'structured-fanout-requeue',
    inputs: { batch: runId },
    status: 'completed_with_errors',
    ...(receiptProtocol
      ? {
          mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
          mutationContractSnapshot: {
            version: 1,
            steps: { create_each: 'structured_call_receipt' },
          },
        }
      : {}),
  }), 'utf-8');
  appendWorkflowEvent('structured-fanout-requeue', runId, {
    kind: 'item_failed',
    stepId: 'create_each',
    itemKey: 'item-a',
    error: 'provider response unavailable',
  });
}

function structuredFanoutReceiptInput(runId: string) {
  return {
    workflowSlug: 'structured-fanout-requeue',
    runId,
    stepId: 'create_each',
    itemKey: 'item-a',
    tool: 'AIRTABLE_CREATE_RECORD',
    account: { connectionId: 'ca-airtable' },
    args: { table: 'Prospects', fields: { name: 'Ada' } },
  };
}

test('requeueWorkflowFromRun: current unreceipted mutations fail closed with empty or completed lifecycle telemetry', () => {
  writeWorkflow('unreceipted-mutation-requeue', {
    name: 'unreceipted-mutation-requeue',
    description: 'Mutates through an unstructured prompt step.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'update', prompt: 'Update the CRM record.', sideEffect: 'write' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  for (const runId of ['unreceipted-empty-source', 'unreceipted-completed-source']) {
    writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
      id: runId,
      workflow: 'unreceipted-mutation-requeue',
      inputs: {},
      status: 'error',
      mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
    }), 'utf-8');
  }
  appendWorkflowEvent('unreceipted-mutation-requeue', 'unreceipted-completed-source', {
    kind: 'step_completed',
    stepId: 'update',
    output: { updated: true },
  });

  const empty = requeueWorkflowFromRun('unreceipted-empty-source');
  const completed = requeueWorkflowFromRun('unreceipted-completed-source');

  assert.equal(empty.status, 'ambiguous');
  assert.equal(completed.status, 'ambiguous');
  // The empty-telemetry source carries no step events, so its history cannot
  // bound the run's progress — the reach gate fails closed first because empty
  // telemetry is not proof the unreceipted mutation was never reached (this
  // fires before the downstream snapshot gate; both refuse).
  assert.match(empty.message, /without a structured direct-call receipt|reached that step|repeat/i);
  // The completed source has step-reach evidence (step_completed on the mutating
  // step), so the reach-conditioned unreceipted gate refuses.
  assert.match(completed.message, /without a structured direct-call receipt|reached that step|repeat/i);
  assert.equal(runFiles().length, 2);
});

test('requeueWorkflowFromRun: empty (lost) telemetry on a non-protocol source blocks an unreceipted mutation', () => {
  // The event log is best-effort (appendWorkflowEvent swallows disk failures),
  // so an EMPTY history on a run that actually executed is LOST telemetry, not
  // proof the mutation was never reached. A source with no receipt-protocol
  // marker skips the snapshot gate, so the reach gate must fail closed when the
  // history cannot bound progress at all — absence of telemetry is not proof of
  // absence of effect (2026-07-17 final-wave review P0).
  writeWorkflow('unreceipted-lost-telemetry', {
    name: 'unreceipted-lost-telemetry',
    description: 'Sends via an unstructured prompt step.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'notify', prompt: 'Send the summary email to the client.', sideEffect: 'send' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runId = 'lost-telemetry-source';
  // status:'error' (terminal, so it executed) + NO mutationReceiptProtocolVersion
  // (pre-protocol / legacy) + NO events written at all (empty history).
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'unreceipted-lost-telemetry',
    inputs: {},
    status: 'error',
  }), 'utf-8');

  const rq = requeueWorkflowFromRun(runId);

  assert.equal(rq.status, 'ambiguous', 'lost telemetry must not authorize repeating an unreceipted mutation');
  assert.match(rq.message, /without a structured direct-call receipt|reached that step|repeat/i);
  assert.equal(runFiles().length, 1, 'no fresh run was queued');
});

test('requeueWorkflowFromRun: an unreceipted mutation the prior run never reached does not block the requeue', () => {
  // A read-first workflow whose LATER prompt step is an unreceipted send. The
  // prior run failed at the early read step (step_started only, then step_failed
  // with no completion), so the send never dispatched. The reach-conditioned
  // gate must NOT refuse: a fresh whole-run retry cannot repeat a send that
  // never happened. (Regression: any current unreceipted-mutation step used to
  // block every whole-run requeue regardless of what the prior run reached.)
  writeWorkflow('read-then-send', {
    name: 'read-then-send',
    description: 'Read the inbox, then draft and send the weekly summary email.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'read_inbox', prompt: 'Read the latest inbox items.', sideEffect: 'read' },
      { id: 'send_summary', prompt: 'Draft and send the weekly summary email.', dependsOn: ['read_inbox'], sideEffect: 'send' },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runId = 'read-fail-before-send';
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'read-then-send',
    inputs: {},
    status: 'error',
  }), 'utf-8');
  // Prior run only ever started+failed the read step; the send was never reached.
  appendWorkflowEvent('read-then-send', runId, { kind: 'step_started', stepId: 'read_inbox' });
  appendWorkflowEvent('read-then-send', runId, { kind: 'step_failed', stepId: 'read_inbox', error: 'inbox fetch failed' });

  const rq = requeueWorkflowFromRun(runId);

  assert.equal(rq.status, 'queued');
  const queued = runFiles()
    .filter((f) => f !== `${runId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as { workflow: string; status: string });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].workflow, 'read-then-send');
  assert.equal(queued[0].status, 'queued');
});

test('requeueWorkflowFromRun: an unreceipted mutation the prior run completed still refuses', () => {
  // Same read-then-send shape, but the prior run reached AND completed the send.
  // Reach evidence (step_completed on the mutating step) means a fresh whole-run
  // retry could repeat the send, so the gate fails closed.
  writeWorkflow('read-then-send-done', {
    name: 'read-then-send-done',
    description: 'Read the inbox, then draft and send the weekly summary email.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'read_inbox', prompt: 'Read the latest inbox items.', sideEffect: 'read' },
      { id: 'send_summary', prompt: 'Draft and send the weekly summary email.', dependsOn: ['read_inbox'], sideEffect: 'send' },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runId = 'send-completed-then-failed';
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'read-then-send-done',
    inputs: {},
    status: 'error',
  }), 'utf-8');
  appendWorkflowEvent('read-then-send-done', runId, { kind: 'step_completed', stepId: 'read_inbox', output: { items: 3 } });
  appendWorkflowEvent('read-then-send-done', runId, { kind: 'step_completed', stepId: 'send_summary', output: { sent: true } });

  const rq = requeueWorkflowFromRun(runId);

  assert.equal(rq.status, 'ambiguous');
  assert.match(rq.message, /without a structured direct-call receipt|reached that step/i);
  assert.deepEqual(runFiles(), [`${runId}.json`]);
});

test('requeueWorkflowFromRun: legacy structured mutation with no exact ledger fails closed on an empty lifecycle log', () => {
  const runId = 'mutation-legacy-empty-source';
  writeMutationRequeueFixture(runId);

  const result = requeueWorkflowFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /no matching source mutation contract|empty best-effort lifecycle/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFromRun: positive legacy completion evidence blocks a structured mutation without a ledger', () => {
  const runId = 'mutation-legacy-completed-source';
  writeMutationRequeueFixture(runId);
  appendWorkflowEvent('mutation-requeue', runId, {
    kind: 'step_completed',
    stepId: 'create',
    output: { id: 'legacy-record' },
  });

  const result = requeueWorkflowFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /completed mutating direct-call step|legacy mutation/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFromRun: protocol-marked structured mutation may retry when its exact ledger is empty', () => {
  const runId = 'mutation-protocol-empty-source';
  writeMutationRequeueFixture(runId, true);

  const result = requeueWorkflowFromRun(runId);

  assert.equal(result.status, 'queued');
  assert.equal(runFiles().length, 2);
});

test('requeueWorkflowFromRun: protocol marker without its admission-time contract snapshot fails closed', () => {
  const runId = 'mutation-protocol-missing-snapshot';
  writeMutationRequeueFixture(runId);
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const record = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({
    ...record,
    mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
  }), 'utf-8');

  const result = requeueWorkflowFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /no valid mutation-contract snapshot|protocol marker alone/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFromRun: plain-to-structured definition drift cannot turn a source unreceipted mutation into marker authority', () => {
  writeWorkflow('mutation-drift', {
    name: 'mutation-drift',
    description: 'Current definition uses a structured update.',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'update',
      prompt: 'Update the CRM.',
      sideEffect: 'write',
      call: { tool: 'AIRTABLE_UPDATE_RECORD', args: { table: 'Prospects' } },
    }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runId = 'plain-to-structured-drift';
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'mutation-drift',
    inputs: {},
    status: 'error',
    mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
    mutationContractSnapshot: {
      version: 1,
      steps: { update: 'unreceipted_mutation' },
    },
  }), 'utf-8');

  const result = requeueWorkflowFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /definition drift|unreceipted_mutation/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFromRun: removing a source mutating step does not erase its admission-time risk', () => {
  writeWorkflow('removed-mutation-drift', {
    name: 'removed-mutation-drift',
    description: 'Current definition removed the old external write.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'summarize', prompt: 'Summarize local evidence.', sideEffect: 'read' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runId = 'removed-mutation-source';
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'removed-mutation-drift',
    inputs: {},
    status: 'error',
    mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
    mutationContractSnapshot: {
      version: 1,
      steps: { old_write: 'unreceipted_mutation' },
    },
  }), 'utf-8');

  const result = requeueWorkflowFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /old_write|definition drift/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFromRun: ambiguous external mutation refuses a fresh run id', async () => {
  const runId = 'mutation-ambiguous-source';
  writeMutationRequeueFixture(runId);
  await assert.rejects(
    executeWorkflowCallMutation(mutationReceiptInput(runId), async () => {
      throw new Error('response lost after submit');
    }),
    (err: unknown) => err instanceof WorkflowCallMutationAmbiguousError,
  );

  const result = requeueWorkflowFromRun(runId);
  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /No rerun was queued|no rerun was queued/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFromRun: committed external mutation is not repeated by an apply-fix style rerun', async () => {
  const runId = 'mutation-committed-source';
  writeMutationRequeueFixture(runId);
  await executeWorkflowCallMutation(mutationReceiptInput(runId), async () => ({ id: 'rec-created' }));

  const result = requeueWorkflowFromRun(runId);
  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /committed/);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFromRun: durable proven-no-commit failure may start one fresh attempt', async () => {
  const runId = 'mutation-proven-failure-source';
  writeMutationRequeueFixture(runId);
  await assert.rejects(
    executeWorkflowCallMutation(
      mutationReceiptInput(runId),
      async () => ({ successful: false, error: 'invalid required field' }),
      { classifyFailure: (result) => ({ summary: result.error, provenNoCommit: true }) },
    ),
    (err: unknown) => err instanceof WorkflowCallMutationProvenFailureError,
  );
  // Best-effort lifecycle evidence may disagree after a crash. Exact durable
  // no-commit proof remains authoritative and therefore retryable.
  appendWorkflowEvent('mutation-requeue', runId, {
    kind: 'step_completed',
    stepId: 'create',
    output: { stale: true },
  });

  const result = requeueWorkflowFromRun(runId);
  assert.equal(result.status, 'queued');
  assert.equal(runFiles().length, 2);
});

test('requeueWorkflowFromRun: missing original run → not_found (best-effort, no throw)', () => {
  assert.equal(requeueWorkflowFromRun('does-not-exist').status, 'not_found');
});

test('requeueWorkflowFromRun carries originSessionId from the prior run (re-run re-enters the chat)', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-with-origin';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({
      id: origId,
      workflow: 'audit-brief',
      inputs: { url: 'https://site-alt.example' },
      status: 'completed',
      originSessionId: 'sess-abc',
      catchupFire: true,
      catchupOccurrenceAtMs: 456_000,
      workflowSlug: 'audit-brief',
      catchupFirstDueAtMs: 456_000,
      catchupScheduledAtMs: 789_000,
      catchupMissedCount: 3,
      catchupDisposition: 'resumed',
      catchupDecidedAt: '2026-07-29T12:00:00.000Z',
    }),
    'utf-8',
  );
  requeueWorkflowFromRun(origId);
  const fresh = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as {
      originSessionId?: string;
      catchupFire?: boolean;
      catchupOccurrenceAtMs?: number;
      workflowSlug?: string;
      catchupFirstDueAtMs?: number;
      catchupScheduledAtMs?: number;
      catchupMissedCount?: number;
      catchupDisposition?: string;
      catchupDecidedAt?: string;
    });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].originSessionId, 'sess-abc');
  assert.equal(fresh[0].catchupFire, true);
  assert.equal(fresh[0].catchupOccurrenceAtMs, 456_000,
    'whole-run requeues retain the root catch-up occurrence age');
  assert.equal(fresh[0].workflowSlug, 'audit-brief');
  assert.equal(fresh[0].catchupFirstDueAtMs, 456_000);
  assert.equal(fresh[0].catchupScheduledAtMs, 789_000);
  assert.equal(fresh[0].catchupMissedCount, 3);
  assert.equal(fresh[0].catchupDisposition, 'resumed',
    'an executable catch-up descendant keeps explicit resume authority');
  assert.equal(fresh[0].catchupDecidedAt, '2026-07-29T12:00:00.000Z');
});

test('requeueWorkflowFromRun preserves duplicate observer origins from the prior run', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-with-multi-origin';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://site-alt.example' }, status: 'completed', originSessionId: 'sess-a', originSessionIds: ['sess-a', 'sess-b'] }),
    'utf-8',
  );

  requeueWorkflowFromRun(origId);
  const fresh = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as { originSessionId?: string; originSessionIds?: string[] });

  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].originSessionId, 'sess-a');
  assert.deepEqual(fresh[0].originSessionIds, ['sess-a', 'sess-b']);
});

test('requeueWorkflowFailedItemsFromRun queues lineage for only final failed forEach items', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-partial-failure';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({
      id: origId,
      workflow: 'audit-brief',
      inputs: { url: 'https://site-alt.example' },
      status: 'completed_with_errors',
      originSessionId: 'sess-failed-items',
      catchupFire: true,
      catchupOccurrenceAtMs: 123_000,
      workflowSlug: 'audit-brief',
      catchupFirstDueAtMs: 123_000,
      catchupScheduledAtMs: 456_000,
      catchupMissedCount: 2,
      catchupDisposition: 'skipped',
      catchupDecidedAt: '2026-07-29T13:00:00.000Z',
    }),
    'utf-8',
  );
  appendWorkflowEvent('audit-brief', origId, { kind: 'step_completed', stepId: 'normalize', output: ['a', 'b', 'c'] });
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_completed', stepId: 'blast', itemKey: 'a', output: 'done-a' });
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_failed', stepId: 'blast', itemKey: 'b', error: 'temporary b failure' });
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_failed', stepId: 'blast', itemKey: 'c', error: 'temporary c failure' });
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_completed', stepId: 'blast', itemKey: 'c', output: 'recovered-c' });

  const rq = requeueWorkflowFailedItemsFromRun(origId);
  assert.equal(rq.status, 'queued');
  assert.deepEqual(rq.failedItems?.map((item) => item.itemKey), ['b']);
  const fresh = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as {
      createdAt?: string;
      catchupFire?: boolean;
      catchupOccurrenceAtMs?: number;
      workflowSlug?: string;
      catchupFirstDueAtMs?: number;
      catchupScheduledAtMs?: number;
      catchupMissedCount?: number;
      catchupDisposition?: string;
      catchupDecidedAt?: string;
      retryFailedItemsFromRunId?: string;
      retryFailedItemsStepId?: string;
      retryFailedItemKeys?: string[];
      originSessionId?: string;
      recoveryIntent?: { kind?: string; createdAt?: string; sourceRunId?: string; sourceStepId?: string; reason?: string };
    });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].catchupFire, true, 'failed-item recovery remains in the one-active catch-up lineage');
  assert.equal(fresh[0].catchupOccurrenceAtMs, 123_000,
    'failed-item recovery keeps the original occurrence age for fair reacquisition');
  assert.equal(fresh[0].workflowSlug, 'audit-brief');
  assert.equal(fresh[0].catchupFirstDueAtMs, 123_000);
  assert.equal(fresh[0].catchupScheduledAtMs, 456_000);
  assert.equal(fresh[0].catchupMissedCount, 2);
  assert.equal(fresh[0].catchupDisposition, 'resumed',
    'the explicit failed-item requeue is new execution authority, never a propagated skip');
  assert.equal(fresh[0].catchupDecidedAt, undefined,
    'a skipped source decision timestamp is not misrepresented as the new resume decision');
  assert.equal(fresh[0].retryFailedItemsFromRunId, origId);
  assert.equal(fresh[0].retryFailedItemsStepId, 'blast');
  assert.deepEqual(fresh[0].retryFailedItemKeys, ['b']);
  assert.equal(fresh[0].originSessionId, 'sess-failed-items');
  assert.deepEqual(fresh[0].recoveryIntent, {
    kind: 'failed_items',
    createdAt: fresh[0].createdAt,
    sourceRunId: origId,
    sourceStepId: 'blast',
    reason: 'retry final failed forEach items',
  });
});

test('requeueWorkflowFailedItemsFromRun blocks unreceipted mutating fan-out with absent or unreadable external-write telemetry', async (t) => {
  const { HARNESS_DB_PATH, closeEventLog, resetEventLog } = await import('../runtime/harness/eventlog.js');
  t.after(() => {
    closeEventLog();
    rmSync(HARNESS_DB_PATH, { recursive: true, force: true });
    resetEventLog();
  });
  resetEventLog();
  writeWorkflow('unreceipted-fanout-requeue', {
    name: 'unreceipted-fanout-requeue',
    description: 'Mutates each item through an unstructured prompt.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'source', prompt: 'Read source items.', sideEffect: 'read' },
      {
        id: 'update_each',
        prompt: 'Update this CRM record.',
        dependsOn: ['source'],
        forEach: 'source',
        sideEffect: 'write',
      },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const writeSource = (runId: string): void => {
    writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
      id: runId,
      workflow: 'unreceipted-fanout-requeue',
      inputs: { batch: runId },
      status: 'completed_with_errors',
      mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
    }), 'utf-8');
    appendWorkflowEvent('unreceipted-fanout-requeue', runId, {
      kind: 'item_failed',
      stepId: 'update_each',
      itemKey: 'item-a',
      error: 'response unavailable',
    });
  };

  writeSource('unreceipted-fanout-no-telemetry');
  const absent = requeueWorkflowFailedItemsFromRun('unreceipted-fanout-no-telemetry');
  assert.equal(absent.status, 'ambiguous');
  assert.match(absent.message, /without per-item structured direct-call receipts|missing/i);

  writeSource('unreceipted-fanout-unreadable-telemetry');
  closeEventLog();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(HARNESS_DB_PATH + suffix, { recursive: true, force: true });
  }
  mkdirSync(path.dirname(HARNESS_DB_PATH), { recursive: true });
  mkdirSync(HARNESS_DB_PATH);
  const unreadable = requeueWorkflowFailedItemsFromRun('unreceipted-fanout-unreadable-telemetry');
  assert.equal(unreadable.status, 'ambiguous');
  assert.match(unreadable.message, /unreadable external-write telemetry|no retry was queued/i);
  assert.equal(runFiles().length, 2);
});

test('requeueWorkflowFailedItemsFromRun: legacy structured failed item needs an exact ledger', () => {
  const runId = 'structured-fanout-legacy-empty';
  writeStructuredFanoutRequeueFixture(runId);

  const result = requeueWorkflowFailedItemsFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /no matching source mutation contract|no exact ledger/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFailedItemsFromRun: protocol marker makes empty exact item ledger authoritative', () => {
  const runId = 'structured-fanout-protocol-empty';
  writeStructuredFanoutRequeueFixture(runId, true);

  const result = requeueWorkflowFailedItemsFromRun(runId);

  assert.equal(result.status, 'queued');
  assert.deepEqual(result.failedItems?.map((item) => item.itemKey), ['item-a']);
  assert.equal(runFiles().length, 2);
});

test('requeueWorkflowFailedItemsFromRun: legacy exact proven-no-commit item ledger remains retryable', async () => {
  const runId = 'structured-fanout-proven-failure';
  writeStructuredFanoutRequeueFixture(runId);
  await assert.rejects(
    executeWorkflowCallMutation(
      structuredFanoutReceiptInput(runId),
      async () => ({ successful: false, error: 'invalid required field' }),
      { classifyFailure: (result) => ({ summary: result.error, provenNoCommit: true }) },
    ),
    (err: unknown) => err instanceof WorkflowCallMutationProvenFailureError,
  );

  const result = requeueWorkflowFailedItemsFromRun(runId);

  assert.equal(result.status, 'queued');
  assert.equal(runFiles().length, 2);
});

test('requeueWorkflowFailedItemsFromRun: later exact ledger cannot erase a source unreceipted fan-out contract', async () => {
  const runId = 'structured-fanout-source-was-unreceipted';
  writeStructuredFanoutRequeueFixture(runId, true);
  const sourceFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const source = JSON.parse(readFileSync(sourceFile, 'utf-8')) as Record<string, unknown>;
  writeFileSync(sourceFile, JSON.stringify({
    ...source,
    mutationContractSnapshot: {
      version: 1,
      steps: { create_each: 'unreceipted_mutation' },
    },
  }), 'utf-8');
  await assert.rejects(
    executeWorkflowCallMutation(
      structuredFanoutReceiptInput(runId),
      async () => ({ successful: false, error: 'invalid required field' }),
      { classifyFailure: (result) => ({ summary: result.error, provenNoCommit: true }) },
    ),
    (err: unknown) => err instanceof WorkflowCallMutationProvenFailureError,
  );

  const result = requeueWorkflowFailedItemsFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /executed.*as an unreceipted mutation|source agentic mutation/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFailedItemsFromRun: committed exact item receipt blocks inconsistent failed-item telemetry', async () => {
  const runId = 'structured-fanout-committed';
  writeStructuredFanoutRequeueFixture(runId, true);
  await executeWorkflowCallMutation(
    structuredFanoutReceiptInput(runId),
    async () => ({ id: 'rec-created' }),
  );

  const result = requeueWorkflowFailedItemsFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /committed external mutation receipt|may already have committed/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFailedItemsFromRun refuses to overlap a live fan-out', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-live-fanout';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: {}, status: 'running' }),
    'utf-8',
  );
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_failed', stepId: 'blast', itemKey: 'b', error: 'temporary b failure' });

  const result = requeueWorkflowFailedItemsFromRun(origId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /not terminal|still be processing/i);
  assert.deepEqual(runFiles(), [`${origId}.json`]);
});

test('requeueWorkflowFailedItemsFromRun asks for a step when multiple fan-outs failed', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-multi-failure';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://site-alt.example' }, status: 'completed_with_errors' }),
    'utf-8',
  );
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_failed', stepId: 'blast_one', itemKey: 'a', error: 'a failed' });
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_failed', stepId: 'blast_two', itemKey: 'b', error: 'b failed' });

  const ambiguous = requeueWorkflowFailedItemsFromRun(origId);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.match(ambiguous.message, /more than one step/);

  const scoped = requeueWorkflowFailedItemsFromRun(origId, { stepId: 'blast_two' });
  assert.equal(scoped.status, 'queued');
  assert.deepEqual(scoped.failedItems?.map((item) => item.itemKey), ['b']);
});

test('self-heal lineage: requeue bumps + persists selfHealAttempt (bound counter survives run→run)', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-heal';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://site-alt.example' }, status: 'completed' }),
    'utf-8',
  );
  requeueWorkflowFromRun(origId, { selfHealAttempt: 1 });
  const fresh = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as {
      createdAt?: string;
      requeuedFromRunId?: string;
      selfHealAttempt?: number;
      recoveryIntent?: { kind?: string; createdAt?: string; sourceRunId?: string; reason?: string };
    });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].requeuedFromRunId, origId);
  assert.equal(fresh[0].selfHealAttempt, 1);
  assert.deepEqual(fresh[0].recoveryIntent, {
    kind: 'self_heal',
    createdAt: fresh[0].createdAt,
    sourceRunId: origId,
    reason: 'self-heal verification requeue',
  });
});

test('queueWorkflowRun omits selfHealAttempt when 0/absent', () => {
  writeAuditWorkflow();
  queueWorkflowRun('audit-brief', { url: 'https://site-alt.example' });
  const rec = runFiles().map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as Record<string, unknown>)[0];
  assert.equal('selfHealAttempt' in rec, false);
});

test('queueWorkflowCreationTest: writes a creation_test run record (Part B authoring test)', () => {
  const r = queueWorkflowCreationTest('audit-brief', { url: 'https://site.example' }, { originSessionId: 'sess-create' });
  assert.equal(r.status, 'queued');
  assert.match(r.message, /creation test/i);
  assert.match(r.message, /DISABLED/);
  assert.equal(runFiles().length, 1);
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.equal(rec.status, 'creation_test');
  assert.equal(rec.workflow, 'audit-brief');
  assert.equal(rec.inputs.url, 'https://site.example');
  assert.equal(rec.originSessionId, 'sess-create');
  assert.equal(rec.mutationReceiptProtocolVersion, WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION);
});

test('queueWorkflowCreationTest: does NOT dedupe (each authoring test is fresh)', () => {
  queueWorkflowCreationTest('audit-brief', { url: 'https://site.example' });
  queueWorkflowCreationTest('audit-brief', { url: 'https://site.example' });
  assert.equal(runFiles().length, 2);
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});
