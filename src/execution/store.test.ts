/**
 * Run: npx tsx --test src/execution/store.test.ts
 *
 * Covers the v0.2.8 durability primitives:
 *
 *   - sweepCrashedExecutions: active execution with a stale
 *     `lastHeartbeatAt` (> 5 min default) is transitioned to
 *     `completed` with a "heartbeat stalled" blocker. Active
 *     executions with a fresh heartbeat are left alone. Active
 *     executions that have NEVER had a heartbeat written are NOT
 *     swept by this function — that's the existing
 *     `sweepStaleExecutions`'s job (60-min activity-based fallback).
 *
 *   - sweepStaleBlockedExecutions: blocked execution whose
 *     `updatedAt` is older than the threshold (6h default) is
 *     transitioned to `completed` with an auto-fail blocker.
 *     Blocked executions with a recent `updatedAt` are left alone.
 *
 *   - Round-trip persistence: the sweepers mutate the JSON file on
 *     disk; a second `loadExecutions()` sees the new state.
 *
 * Per-test temp dir via CLEMENTINE_HOME so we don't trample the
 * user's real ~/.clementine-next state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ExecutionRecord, PlanRecord } from '../types.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-store-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
// The store imports addNotification, which writes to disk. Make sure
// the state dir exists before any code path tries to write.
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  ExecutionStore,
  rootWorkflowReceiptForSource,
  sweepStaleExecutions,
  sweepCrashedExecutions,
  sweepStaleBlockedExecutions,
} = await import('./store.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');
const { TASKS_FILE, ensureTasksFile, parseTasks } = await import('../tools/shared.js');
const {
  createCompiledWorkflowRunDefinitionSnapshot,
  workflowDefinitionHash,
} = await import('./workflow-run-definition.js');
const {
  compiledProjectRootTerminalDigest,
  compiledWorkflowRunContractHash,
  compiledWorkflowRunInputsHash,
} = await import('./compiled-project-run-contract.js');
const { compileProjectPlan } = await import('./project-compiler.js');
const { BoundaryError } = await import('../runtime/boundary-error.js');
const { actionBus } = await import('../runtime/action-bus.js');

const EXECUTIONS_FILE = path.join(TMP_HOME, 'state', 'executions.json');

function nowMinusMinutes(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function seedExecutions(records: Array<Record<string, unknown>>): void {
  writeFileSync(EXECUTIONS_FILE, JSON.stringify(records, null, 2), 'utf-8');
}

function readExecutions(): Array<Record<string, unknown>> {
  if (!existsSync(EXECUTIONS_FILE)) return [];
  return JSON.parse(readFileSync(EXECUTIONS_FILE, 'utf-8')) as Array<Record<string, unknown>>;
}

function baseExecution(overrides: Record<string, unknown>): Record<string, unknown> {
  const iso = new Date().toISOString();
  return {
    id: `exec-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: 'sess-test',
    title: 'test',
    objective: 'test',
    reason: 'test',
    status: 'active',
    createdAt: iso,
    updatedAt: iso,
    lastActivityAt: iso,
    startedFromMessage: 'hi',
    confidence: 0.5,
    reasons: [],
    ...overrides,
  };
}

function acceptedProjectSource(label: string): {
  sessionId: string;
  sourceUserSeq: number;
  sourceId: string;
  sourceTurn: number;
} {
  resetEventLog();
  const sessionId = `sess-project-${label}-${Math.random().toString(36).slice(2, 8)}`;
  createSession({ id: sessionId, kind: 'chat', title: label });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Build the durable project.',
      displayText: 'Build the durable project.',
      source: 'desktop',
    },
  });
  return { sessionId, sourceUserSeq: source.seq, sourceId: source.id, sourceTurn: source.turn };
}

function canonicalTestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalTestValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalTestValue(entry)]));
}

function canonicalTestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalTestValue(value))).digest('hex');
}

function projectExecutionInput(
  sessionId: string,
  sourceUserSeq: number,
  variant = 'winner-a',
): Record<string, unknown> {
  const plan = {
    planId: 'compiled-project-test',
    objective: 'Produce a durable verified deliverable.',
    nodes: [{
      id: 'work',
      executor: {
        kind: 'model' as const,
        instruction: `Perform bounded project work for ${variant}.`,
        allowedTools: ['workspace_artifact_query'],
      },
      effect: 'read' as const,
      maxTurns: 8,
      retries: 1,
      evidence: { type: 'object', requiredKeys: ['summary'] },
    }],
  };
  const compiled = compileProjectPlan(plan);
  return {
    sessionId,
    sourceUserSeq,
    title: 'Durable project',
    objective: 'Produce a durable verified deliverable.',
    reason: 'Accepted as a long-horizon project.',
    startedFromMessage: 'Build the durable project.',
    confidence: 0.95,
    reasons: ['multi-step durable work'],
    nextReviewAt: new Date().toISOString(),
    admission: {
      compiledPlan: {
        version: 2,
        compilerId: 'project_graph_v2',
        planHash: compiled.planHash,
        definitionHash: workflowDefinitionHash(compiled.definition),
        plan,
        definition: compiled.definition,
        inputs: {},
      },
    },
  };
}

function projectRootContract(execution: ExecutionRecord): {
  workflowSlug: string;
  sourceTurnKeyHash: string;
  snapshotDefinitionHash: string;
  snapshotAdmissionHash: string;
  snapshotAdmittedAt: string;
  compiledContractHash: string;
  normalizedInputsHash: string;
  mutationReceiptProtocolVersion: 1;
} {
  const admission = execution.graphAdmission!;
  const sourceUserSeq = execution.sourceUserSeq!;
  const workflowSlug = `compiled-${admission.sourceTurnKeyHash.slice(0, 32)}`;
  const snapshot = createCompiledWorkflowRunDefinitionSnapshot({
    workflowSlug,
    sourceTurnKeyHash: admission.sourceTurnKeyHash,
    definition: admission.compiledPlan.definition,
    admittedAt: admission.admittedAt,
  });
  return {
    workflowSlug,
    sourceTurnKeyHash: admission.sourceTurnKeyHash,
    snapshotDefinitionHash: snapshot.definitionHash,
    snapshotAdmissionHash: snapshot.admissionHash,
    snapshotAdmittedAt: snapshot.admittedAt,
    compiledContractHash: compiledWorkflowRunContractHash({
      sourceExecutionId: execution.id,
      sourceUserSeq,
      sourceTurnKeyHash: admission.sourceTurnKeyHash,
      originSessionId: execution.sessionId,
      workflowSlug,
      snapshot,
      inputs: admission.compiledPlan.inputs,
    }),
    normalizedInputsHash: compiledWorkflowRunInputsHash(admission.compiledPlan.inputs),
    mutationReceiptProtocolVersion: 1,
  };
}

function projectSettlementTerminalDigest(
  input: Omit<Parameters<typeof compiledProjectRootTerminalDigest>[0], 'id'> & {
    runId: string;
    summary?: string;
  },
): string {
  const { runId, summary: _summary, ...terminal } = input;
  return compiledProjectRootTerminalDigest({ id: runId, ...terminal });
}

function preCutProjectSettlementTerminalDigest(
  input: Omit<Parameters<typeof compiledProjectRootTerminalDigest>[0], 'id'> & {
    runId: string;
    summary?: string;
  },
): string {
  const { runId, summary: _summary, ...terminal } = input;
  return createHash('sha256')
    .update('clementine-project-root-terminal:v1', 'utf8')
    .update('\0')
    .update(JSON.stringify({
      id: runId,
      workflow: terminal.workflow,
      workflowSlug: terminal.workflowSlug,
      sourceExecutionId: terminal.sourceExecutionId,
      sourceTurnKeyHash: terminal.sourceTurnKeyHash,
      sessionId: terminal.sessionId,
      sourceUserSeq: terminal.sourceUserSeq,
      rootWorkflowReceiptId: terminal.rootWorkflowReceiptId,
      status: terminal.status,
      terminalOutcome: terminal.terminalOutcome,
      finishedAt: terminal.finishedAt,
      snapshotDefinitionHash: terminal.snapshotDefinitionHash,
      snapshotAdmissionHash: terminal.snapshotAdmissionHash,
      snapshotAdmittedAt: terminal.snapshotAdmittedAt,
      compiledContractHash: terminal.compiledContractHash,
      normalizedInputsHash: terminal.normalizedInputsHash,
      mutationReceiptProtocolVersion: terminal.mutationReceiptProtocolVersion,
      reportBack: terminal.reportBack,
    }), 'utf8')
    .digest('hex');
}

const STORE_MODULE_URL = new URL('./store.ts', import.meta.url).href;
const ADMISSION_CHILD_CODE = String.raw`
  import { writeFileSync } from 'node:fs';
  const mod = await import(process.env.CLEM_STORE_MODULE_URL);
  writeFileSync(process.env.CLEM_STORE_READY, 'ready', 'utf8');
  try {
    const input = JSON.parse(process.env.CLEM_STORE_INPUT);
    const result = new mod.ExecutionStore().createOrGetForSource(input);
    writeFileSync(process.env.CLEM_STORE_RESULT, JSON.stringify({
      created: result.created,
      id: result.execution.id,
      receipt: result.rootWorkflowReceiptId,
      snapshotHash: result.execution.graphAdmission?.compiledPlan?.snapshotHash,
    }));
  } catch (error) {
    writeFileSync(process.env.CLEM_STORE_RESULT, JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
  }
`;

function launchAdmissionChild(input: unknown, readyFile: string, resultFile: string): ChildProcess {
  return spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', ADMISSION_CHILD_CODE],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLEMENTINE_HOME: TMP_HOME,
        CLEM_STORE_MODULE_URL: STORE_MODULE_URL,
        CLEM_STORE_INPUT: JSON.stringify(input),
        CLEM_STORE_READY: readyFile,
        CLEM_STORE_RESULT: resultFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

async function waitForPath(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('createOrGetForSource persists one full immutable compiler winner', () => {
  const { sessionId, sourceUserSeq } = acceptedProjectSource('first-winner');
  seedExecutions([]);
  const store = new ExecutionStore();

  const first = store.createOrGetForSource(
    projectExecutionInput(sessionId, sourceUserSeq, 'winner-a') as never,
  );
  const replay = store.createOrGetForSource(
    projectExecutionInput(sessionId, sourceUserSeq, 'winner-a') as never,
  );
  const losingPlanner = store.createOrGetForSource(
    projectExecutionInput(sessionId, sourceUserSeq, 'loser-b') as never,
  );

  assert.equal(first.created, true);
  assert.equal(first.plannerConflict, false);
  assert.equal(first.execution.autoAdvance, false);
  assert.equal(first.execution.nextReviewAt, undefined);
  assert.equal(store.listDue().some((row) => row.id === first.execution.id), false);
  assert.equal(replay.created, false);
  assert.equal(replay.plannerConflict, false);
  assert.equal(losingPlanner.created, false);
  assert.equal(losingPlanner.plannerConflict, true);
  assert.equal(replay.execution.id, first.execution.id);
  assert.equal(losingPlanner.execution.id, first.execution.id);
  assert.equal(
    losingPlanner.execution.graphAdmission?.compiledPlan.snapshotHash,
    first.execution.graphAdmission?.compiledPlan.snapshotHash,
    'the losing planner receives the persisted winner rather than its own bytes',
  );
  assert.equal(
    losingPlanner.execution.graphAdmission?.compiledPlan.definition.steps[0]?.prompt,
    'Perform bounded project work for winner-a.',
  );
  assert.equal(first.rootWorkflowReceiptId, replay.rootWorkflowReceiptId);
  assert.equal(first.rootWorkflowReceiptId, first.execution.graphAdmission?.rootWorkflowReceiptId);
  assert.equal(
    readExecutions().filter((row) =>
      row.sessionId === sessionId && row.sourceUserSeq === sourceUserSeq
    ).length,
    1,
  );
  assert.equal(
    first.execution.activity?.filter((row) => row.key.startsWith('project-admitted:')).length,
    1,
  );

  const compilerDrift = projectExecutionInput(sessionId, sourceUserSeq, 'winner-a') as {
    admission: {
      compiledPlan: {
        definition: ReturnType<typeof JSON.parse>;
        definitionHash: string;
      };
    };
  };
  compilerDrift.admission.compiledPlan.definition.steps[0].prompt = 'Different compiler output for the same plan.';
  compilerDrift.admission.compiledPlan.definitionHash = workflowDefinitionHash(
    compilerDrift.admission.compiledPlan.definition,
  );
  assert.throws(
    () => store.createOrGetForSource(compilerDrift as never),
    /was not produced by the declared project plan/i,
  );
  assert.match(first.execution.graphAdmission?.acceptedSourceHash ?? '', /^[a-f0-9]{64}$/);
});

test('createOrGetForSource rejects synthetic sources and mismatched compiler bytes', () => {
  resetEventLog();
  const sessionId = `sess-project-synthetic-${Math.random().toString(36).slice(2, 8)}`;
  createSession({ id: sessionId, kind: 'chat', title: 'synthetic project source' });
  const synthetic = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'AUTO_RESUME_DIRECTIVE', synthetic: true },
  });
  seedExecutions([]);
  const input = projectExecutionInput(sessionId, synthetic.seq) as {
    admission: { compiledPlan: { definitionHash: string } };
  };
  assert.throws(
    () => new ExecutionStore().createOrGetForSource(input as never),
    /exact accepted human user turn/i,
  );
  assert.deepEqual(readExecutions(), []);

  const accepted = acceptedProjectSource('tampered-definition');
  const tampered = projectExecutionInput(accepted.sessionId, accepted.sourceUserSeq) as {
    admission: { compiledPlan: { definitionHash: string } };
  };
  tampered.admission.compiledPlan.definitionHash = '0'.repeat(64);
  assert.throws(
    () => new ExecutionStore().createOrGetForSource(tampered as never),
    /definition bytes do not match/i,
  );
  assert.deepEqual(readExecutions(), []);
});

test('pre-cut V1 compiler input and a self-consistent V1 graph admission are quarantined from work', () => {
  const source = acceptedProjectSource('pre-cut-v1');
  seedExecutions([]);
  const store = new ExecutionStore();
  const legacyInput = projectExecutionInput(source.sessionId, source.sourceUserSeq) as Record<string, any>;
  legacyInput.admission.compiledPlan.version = 1;
  legacyInput.admission.compiledPlan.compilerId = 'project_graph_v1';
  assert.throws(
    () => store.createOrGetForSource(legacyInput as never),
    /supported project compiler snapshot/i,
  );
  assert.deepEqual(readExecutions(), [], 'old compiler bytes never mint current graph authority');

  const admitted = store.createOrGetForSource(
    projectExecutionInput(source.sessionId, source.sourceUserSeq) as never,
  );
  const current = structuredClone(admitted.execution) as Record<string, any>;
  const sourceTurnKeyHash = createHash('sha256')
    .update('clementine-project-source:v1', 'utf8')
    .update('\0')
    .update(source.sessionId, 'utf8')
    .update('\0')
    .update(String(source.sourceUserSeq), 'utf8')
    .digest('hex');
  const acceptedSourceHash = createHash('sha256')
    .update('clementine-accepted-project-source:v1', 'utf8')
    .update('\0')
    .update(source.sessionId, 'utf8')
    .update('\0')
    .update(String(source.sourceUserSeq), 'utf8')
    .update('\0')
    .update(source.sourceId, 'utf8')
    .update('\0')
    .update(String(source.sourceTurn), 'utf8')
    .digest('hex');
  const currentPlan = current.graphAdmission.compiledPlan;
  const legacyPlanPayload = {
    version: 1,
    compilerId: 'project_graph_v1',
    planHash: currentPlan.planHash,
    definitionHash: currentPlan.definitionHash,
    plan: currentPlan.plan,
    definition: currentPlan.definition,
    inputs: currentPlan.inputs,
  };
  current.id = `exec-project-${sourceTurnKeyHash.slice(0, 32)}`;
  current.graphAdmission = {
    ...current.graphAdmission,
    version: 1,
    sourceTurnKeyHash,
    acceptedSourceHash,
    compiledPlan: {
      ...legacyPlanPayload,
      snapshotHash: canonicalTestHash(legacyPlanPayload),
    },
    rootWorkflowReceiptId: `project-turn:v1:${sourceTurnKeyHash}`,
  };
  seedExecutions([current]);

  assert.deepEqual(store.listUnboundProjectGraphSources(), { sources: [], rejected: 1 });
  assert.throws(
    () => store.getForSource(source.sessionId, source.sourceUserSeq),
    /source integrity check/i,
  );
});

test('createOrGetForSource never strands a graph on paused or completed legacy state', () => {
  for (const status of ['paused', 'completed'] as const) {
    const { sessionId, sourceUserSeq } = acceptedProjectSource(`legacy-${status}`);
    const legacy = baseExecution({
      id: `legacy-${status}`,
      sessionId,
      sourceUserSeq,
      status,
      ...(status === 'paused' ? { pauseSource: 'user' } : { completedAt: new Date().toISOString() }),
    });
    seedExecutions([legacy]);

    assert.throws(
      () => new ExecutionStore().createOrGetForSource(
        projectExecutionInput(sessionId, sourceUserSeq) as never,
      ),
      /paused or terminal execution/i,
    );
    assert.deepEqual(readExecutions(), [legacy]);
  }
});

test('corrupt executions.json repeatedly fails closed without minting project authority', () => {
  const { sessionId, sourceUserSeq } = acceptedProjectSource('corrupt');
  const input = projectExecutionInput(sessionId, sourceUserSeq);
  const corruptBytes = '{ "id": "torn", "graphAdmission": [';
  writeFileSync(EXECUTIONS_FILE, corruptBytes, 'utf-8');

  for (let retry = 0; retry < 2; retry += 1) {
    assert.throws(
      () => new ExecutionStore().createOrGetForSource(input as never),
      (error: unknown) => error instanceof BoundaryError && error.kind === 'state.read_corrupted',
    );
    assert.equal(readFileSync(EXECUTIONS_FILE, 'utf-8'), corruptBytes);
  }
  assert.equal(
    readdirSync(path.dirname(EXECUTIONS_FILE))
      .some((name) => name.startsWith('executions.json.') && name.endsWith('.tmp')),
    false,
  );
});

test('root workflow binding requires the source receipt and immutable workflow identity', () => {
  const { sessionId, sourceUserSeq } = acceptedProjectSource('root-binding');
  seedExecutions([]);
  const store = new ExecutionStore();
  const admitted = store.createOrGetForSource(
    projectExecutionInput(sessionId, sourceUserSeq) as never,
  );
  const bind = (rootWorkflowReceiptId: string, runId: string, workflow = 'compiled-project-test') =>
    store.bindRootWorkflowRunForSource({
      sessionId,
      sourceUserSeq,
      rootWorkflowReceiptId,
      runId,
      workflow,
    });

  assert.throws(
    () => bind(rootWorkflowReceiptForSource(sessionId, sourceUserSeq + 1), 'run-a'),
    /receipt/i,
  );
  assert.throws(
    () => bind(`project-turn:v1:${'a'.repeat(64)}`, 'run-a'),
    /receipt/i,
  );
  assert.throws(
    () => bind(admitted.rootWorkflowReceiptId, 'run-a', 'another-workflow'),
    /immutable compiled project plan/i,
  );
  assert.equal(store.getForSource(sessionId, sourceUserSeq)?.graphAdmission?.rootWorkflowRunId, undefined);

  const first = bind(admitted.rootWorkflowReceiptId, 'run-a');
  const replay = bind(admitted.rootWorkflowReceiptId, 'run-a');
  assert.equal(first.graphAdmission?.rootWorkflowRunId, 'run-a');
  assert.equal(replay.workflowBindings?.filter((row) => row.runId === 'run-a').length, 1);
  assert.throws(
    () => bind(admitted.rootWorkflowReceiptId, 'run-b'),
    /different root workflow run/i,
  );

  const boundRows = readExecutions();
  const missingBinding = structuredClone(boundRows);
  missingBinding[0].workflowBindings = [];
  seedExecutions(missingBinding);
  assert.throws(
    () => store.getForSource(sessionId, sourceUserSeq),
    /one exact workflow binding/i,
  );

  const terminalBindingWithoutRootTruth = structuredClone(boundRows) as Array<Record<string, any>>;
  terminalBindingWithoutRootTruth[0].workflowBindings[0].status = 'completed';
  terminalBindingWithoutRootTruth[0].workflowBindings[0].terminalOutcome = 'succeeded';
  terminalBindingWithoutRootTruth[0].workflowBindings[0].finishedAt = new Date().toISOString();
  seedExecutions(terminalBindingWithoutRootTruth);
  assert.throws(
    () => store.getForSource(sessionId, sourceUserSeq),
    /without root terminal truth/i,
  );

  seedExecutions(boundRows);

  const duplicateRows = readExecutions();
  duplicateRows.push({ ...duplicateRows[0], id: 'duplicate-source-owner' });
  seedExecutions(duplicateRows);
  assert.throws(
    () => bind(admitted.rootWorkflowReceiptId, 'run-a'),
    /multiple executions claim the same accepted source/i,
  );
});

test('compiled root terminal truth settles its exact project once and rejects conflicts', () => {
  const { sessionId, sourceUserSeq } = acceptedProjectSource('root-settlement');
  seedExecutions([]);
  const store = new ExecutionStore();
  const admitted = store.createOrGetForSource(
    projectExecutionInput(sessionId, sourceUserSeq) as never,
  );
  const runId = 'run-root-settlement';
  store.bindRootWorkflowRunForSource({
    sessionId,
    sourceUserSeq,
    rootWorkflowReceiptId: admitted.rootWorkflowReceiptId,
    runId,
    workflow: 'compiled-project-test',
  });
  const boundRows = readExecutions() as Array<Record<string, any>>;
  boundRows[0].taskBindings = [{
    taskId: 'T-PROJECT-ROOT',
    description: 'Finish the durable project root',
    status: 'pending',
    createdAt: nowMinusMinutes(5),
  }];
  seedExecutions(boundRows);
  ensureTasksFile();
  writeFileSync(
    TASKS_FILE,
    [
      '---',
      'type: tasks',
      '---',
      '',
      '# Tasks',
      '',
      '## Pending',
      '',
      '- [ ] {T-PROJECT-ROOT} Finish the durable project root',
      '',
      '## Completed',
      '',
    ].join('\n'),
    'utf-8',
  );
  const finishedAt = new Date().toISOString();
  const reportDetail = 'The durable project completed with verified evidence.';
  const settlementWithoutDigest = {
    sourceExecutionId: admitted.execution.id,
    sessionId,
    sourceUserSeq,
    rootWorkflowReceiptId: admitted.rootWorkflowReceiptId,
    runId,
    workflow: 'compiled-project-test',
    ...projectRootContract(admitted.execution),
    status: 'completed' as const,
    terminalOutcome: 'succeeded' as const,
    finishedAt,
    reportBack: {
      version: 1 as const,
      workflowName: 'compiled-project-test',
      outcome: 'done' as const,
      detail: reportDetail,
    },
    summary: reportDetail,
  };
  const settlement = {
    ...settlementWithoutDigest,
    terminalDigest: projectSettlementTerminalDigest(settlementWithoutDigest),
  };

  assert.throws(
    () => store.settleProjectRootWorkflowRun({
      ...settlementWithoutDigest,
      terminalDigest: preCutProjectSettlementTerminalDigest(settlementWithoutDigest),
    }),
    /immutable admitted compiler\/run contract/i,
  );
  assert.equal(store.settleProjectRootWorkflowRun(settlement).kind, 'settled');
  assert.equal(store.settleProjectRootWorkflowRun(settlement).kind, 'already_settled');
  const reread = store.getForSource(sessionId, sourceUserSeq)!;
  assert.equal(reread.status, 'completed');
  assert.equal(reread.completedAt, finishedAt);
  assert.equal(reread.blocker, undefined);
  assert.equal(reread.graphAdmission?.rootWorkflowTerminal?.outcome, 'succeeded');
  assert.equal(reread.graphAdmission?.rootWorkflowTerminal?.terminalDigest, settlement.terminalDigest);
  assert.equal(reread.workflowBindings?.[0]?.status, 'completed');
  assert.equal(reread.workflowBindings?.[0]?.terminalOutcome, 'succeeded');
  assert.equal(reread.taskBindings?.[0]?.status, 'completed');
  assert.equal(
    parseTasks(readFileSync(TASKS_FILE, 'utf-8')).find((task) => task.id === 'T-PROJECT-ROOT')?.status,
    undefined,
    'completed execution-owned task rows are compacted out of the human task ledger',
  );
  assert.equal(
    reread.activity?.filter((item) => item.key === `workflow:${runId}:terminal:succeeded`).length,
    1,
  );
  assert.throws(
    () => store.settleProjectRootWorkflowRun({
      ...settlement,
      terminalDigest: 'f'.repeat(64),
    }),
    /immutable admitted compiler\/run contract/i,
  );
  const conflictingSettlement = {
    ...settlementWithoutDigest,
    status: 'failed' as const,
    terminalOutcome: 'failed' as const,
    reportBack: { ...settlement.reportBack, outcome: 'failed' as const },
  };
  assert.throws(
    () => store.settleProjectRootWorkflowRun({
      ...conflictingSettlement,
      terminalDigest: projectSettlementTerminalDigest(conflictingSettlement),
    }),
    /conflicting terminal truth/i,
  );
  assert.throws(
    () => store.settleProjectRootWorkflowRun({
      ...settlement,
      compiledContractHash: '0'.repeat(64),
    }),
    /compiler\/run contract/i,
  );
  assert.throws(
    () => store.update(admitted.execution.id, { status: 'active' }),
    /owned by its root workflow/i,
  );
});

test('project cancellation linearizes against root binding and readiness clears only on a successful bind', () => {
  const first = acceptedProjectSource('cancel-before-bind');
  seedExecutions([]);
  const store = new ExecutionStore();
  const unbound = store.createOrGetForSource(
    projectExecutionInput(first.sessionId, first.sourceUserSeq) as never,
  );
  const cancelled = store.prepareProjectCancellation({
    executionId: unbound.execution.id,
    reason: 'Cancelled before dispatch.',
  });
  assert.equal(cancelled.kind, 'cancelled_unbound');
  const cancelledReadback = store.getForSource(first.sessionId, first.sourceUserSeq);
  assert.equal(cancelledReadback?.graphAdmission?.cancelledBeforeRoot?.version, 1);
  assert.equal(
    cancelledReadback?.graphAdmission?.cancelledBeforeRoot?.finishedAt,
    cancelledReadback?.completedAt,
  );
  assert.equal(
    store.prepareProjectCancellation({
      executionId: unbound.execution.id,
      reason: 'A different replay reason cannot replace terminal truth.',
    }).kind,
    'already_terminal',
  );
  assert.throws(
    () => store.bindRootWorkflowRunForSource({
      sessionId: first.sessionId,
      sourceUserSeq: first.sourceUserSeq,
      rootWorkflowReceiptId: unbound.rootWorkflowReceiptId,
      runId: 'late-root',
      workflow: 'compiled-project-test',
    }),
    /active or readiness-blocked project/i,
  );

  const second = acceptedProjectSource('readiness-then-bind');
  seedExecutions([]);
  const admitted = store.createOrGetForSource(
    projectExecutionInput(second.sessionId, second.sourceUserSeq) as never,
  );
  const blocked = store.markProjectRootWorkflowReadinessBlocked({
    sessionId: second.sessionId,
    sourceUserSeq: second.sourceUserSeq,
    reason: 'Reconnect the exact data source.',
  });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.blocker ?? '', /Reconnect the exact data source/);
  const bound = store.bindRootWorkflowRunForSource({
    sessionId: second.sessionId,
    sourceUserSeq: second.sourceUserSeq,
    rootWorkflowReceiptId: admitted.rootWorkflowReceiptId,
    runId: 'ready-root',
    workflow: 'compiled-project-test',
  });
  assert.equal(bound.status, 'active');
  assert.equal(bound.blocker, undefined);
  const decision = store.prepareProjectCancellation({
    executionId: admitted.execution.id,
    reason: 'Stop the bound project.',
  });
  assert.equal(decision.kind, 'bound_root');
  assert.equal(store.get(admitted.execution.id)?.status, 'active');
});

test('generic update cannot mutate any graph-owned execution state', () => {
  const { sessionId, sourceUserSeq } = acceptedProjectSource('immutable-update');
  seedExecutions([]);
  const store = new ExecutionStore();
  const admitted = store.createOrGetForSource(
    projectExecutionInput(sessionId, sourceUserSeq) as never,
  );
  const originalAdmission = admitted.execution.graphAdmission;

  assert.equal(
    store.getActiveForSession(sessionId),
    undefined,
    'the legacy assistant/controller lane never adopts a graph-owned project',
  );
  const legacy = store.create({
    sessionId,
    title: 'Independent legacy execution',
    objective: 'Exercise the controller lane independently.',
    reason: 'Regression coverage.',
    startedFromMessage: 'Track this separate task.',
    confidence: 0.8,
    reasons: ['legacy lane'],
  });
  assert.equal(store.getActiveForSession(sessionId)?.id, legacy.id);

  const unrelatedFollowUp = appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Do a separate follow-up.', source: 'desktop' },
  });
  assert.throws(
    () => store.bindSourceUserSeq(
      admitted.execution.id,
      sessionId,
      unrelatedFollowUp.seq,
      'execution_update_step',
    ),
    /fixed to its admitted source/i,
  );

  assert.throws(
    () => (store.update as (id: string, patch: Record<string, unknown>) => unknown)(admitted.execution.id, {
      id: 'replacement-id',
      sessionId: 'replacement-session',
      createdAt: '2000-01-01T00:00:00.000Z',
      sourceUserSeq: 999_999,
      sourceUserSeqs: [999_999],
      graphAdmission: undefined,
      nextStep: 'Generic lifecycle mutation.',
    }),
    /owned by its root workflow/i,
  );

  const reread = store.getForSource(sessionId, sourceUserSeq);
  assert.equal(reread?.id, admitted.execution.id);
  assert.equal(reread?.sessionId, sessionId);
  assert.equal(reread?.createdAt, admitted.execution.createdAt);
  assert.equal(reread?.sourceUserSeq, sourceUserSeq);
  assert.deepEqual(reread?.sourceUserSeqs, undefined);
  assert.deepEqual(reread?.graphAdmission, originalAdmission);
  assert.equal(reread?.nextStep, admitted.execution.nextStep);
});

test('createOrGetForSource is linearizable across processes', async () => {
  const { sessionId, sourceUserSeq } = acceptedProjectSource('race');
  const input = projectExecutionInput(sessionId, sourceUserSeq);
  seedExecutions([baseExecution({ id: 'unrelated-sentinel', sessionId: 'sess-unrelated' })]);

  const lockFile = `${EXECUTIONS_FILE}.lock`;
  const readyA = path.join(TMP_HOME, 'admission-a.ready');
  const readyB = path.join(TMP_HOME, 'admission-b.ready');
  const resultA = path.join(TMP_HOME, 'admission-a.json');
  const resultB = path.join(TMP_HOME, 'admission-b.json');
  writeFileSync(lockFile, `${process.pid}:${Date.now()}`, 'utf-8');

  const childA = launchAdmissionChild(input, readyA, resultA);
  const childB = launchAdmissionChild(input, readyB, resultB);
  try {
    await Promise.all([waitForPath(readyA), waitForPath(readyB)]);
    rmSync(lockFile, { force: true });
    const [[codeA], [codeB]] = await Promise.all([
      once(childA, 'close') as Promise<[number | null]>,
      once(childB, 'close') as Promise<[number | null]>,
    ]);
    assert.equal(codeA, 0);
    assert.equal(codeB, 0);

    const outcomes = [resultA, resultB].map((file) =>
      JSON.parse(readFileSync(file, 'utf-8')) as {
        created?: boolean;
        id?: string;
        receipt?: string;
        snapshotHash?: string;
        error?: string;
      }
    );
    assert.deepEqual(outcomes.map((row) => row.created).sort(), [false, true]);
    assert.equal(new Set(outcomes.map((row) => row.id)).size, 1);
    assert.equal(new Set(outcomes.map((row) => row.receipt)).size, 1);
    assert.equal(new Set(outcomes.map((row) => row.snapshotHash)).size, 1);
    assert.ok(outcomes.every((row) => !row.error));

    const persisted = readExecutions();
    assert.equal(
      persisted.filter((row) =>
        row.sessionId === sessionId && row.sourceUserSeq === sourceUserSeq
      ).length,
      1,
    );
    assert.ok(persisted.some((row) => row.id === 'unrelated-sentinel'));
  } finally {
    rmSync(lockFile, { force: true });
    if (childA.exitCode === null) childA.kill('SIGKILL');
    if (childB.exitCode === null) childB.kill('SIGKILL');
  }
});

test('ExecutionStore creates its lock and ledger on a completely fresh home', async () => {
  const freshHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-store-fresh-home-'));
  const resultFile = path.join(freshHome, 'result.json');
  const childCode = String.raw`
    import { writeFileSync } from 'node:fs';
    try {
      const mod = await import(process.env.CLEM_STORE_MODULE_URL);
      const execution = new mod.ExecutionStore().create({
        sessionId: 'fresh-home-session',
        title: 'Fresh home execution',
        objective: 'Prove first-write lock creation.',
        reason: 'test',
        startedFromMessage: 'start',
        confidence: 1,
        reasons: ['test'],
      });
      writeFileSync(process.env.CLEM_STORE_RESULT, JSON.stringify({ id: execution.id }));
    } catch (error) {
      writeFileSync(process.env.CLEM_STORE_RESULT, JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', childCode],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLEMENTINE_HOME: freshHome,
        CLEM_STORE_MODULE_URL: STORE_MODULE_URL,
        CLEM_STORE_RESULT: resultFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    const [code] = await once(child, 'close') as [number | null];
    assert.equal(code, 0);
    const result = JSON.parse(readFileSync(resultFile, 'utf-8')) as { id?: string; error?: string };
    assert.equal(result.error, undefined);
    assert.ok(result.id);
    assert.equal(existsSync(path.join(freshHome, 'state', 'executions.json')), true);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(freshHome, { recursive: true, force: true });
  }
});

test('sweep publishes after persistence so a synchronous listener update is not overwritten', () => {
  seedExecutions([
    baseExecution({
      id: 'listener-reentry',
      sessionId: 'sess-listener-reentry',
      status: 'active',
      lastHeartbeatAt: nowMinusMinutes(10),
      updatedAt: nowMinusMinutes(10),
      lastActivityAt: nowMinusMinutes(10),
      activity: [],
    }),
  ]);
  const store = new ExecutionStore();
  const unsubscribe = actionBus.subscribe((event) => {
    if (event.kind !== 'execution.transitioned' || event.executionId !== 'listener-reentry') return;
    store.addActivity({
      executionId: event.executionId,
      key: 'listener-observed-durable-transition',
      type: 'status',
      message: 'Listener observed the persisted transition.',
    });
  });
  try {
    assert.equal(sweepCrashedExecutions(), 1);
  } finally {
    unsubscribe();
  }
  const reread = store.get('listener-reentry');
  assert.equal(reread?.status, 'completed');
  assert.ok(reread?.activity?.some((row) => row.key.startsWith('sweep-crashed-')));
  assert.ok(reread?.activity?.some((row) => row.key === 'listener-observed-durable-transition'));
});

test('ExecutionStore.update closes linked vault task rows when an execution completes', () => {
  seedExecutions([
    baseExecution({
      id: 'exec-with-task',
      status: 'active',
      taskBindings: [
        {
          taskId: 'T-001',
          description: 'Do the tracked work',
          status: 'pending',
          createdAt: nowMinusMinutes(15),
        },
      ],
      activity: [],
    }),
  ]);
  ensureTasksFile();
  writeFileSync(
    TASKS_FILE,
    [
      '---',
      'type: tasks',
      '---',
      '',
      '# Tasks',
      '',
      '## Pending',
      '',
      '- [ ] {T-001} Do the tracked work !!high',
      '',
      '## Completed',
      '',
    ].join('\n'),
    'utf-8',
  );

  const updated = new ExecutionStore().update('exec-with-task', {
    status: 'completed',
    lastAssistantSummary: 'Work finished.',
  });

  const tasks = parseTasks(readFileSync(TASKS_FILE, 'utf-8'));
  const taskBody = readFileSync(TASKS_FILE, 'utf-8');
  const pendingSection = taskBody.slice(taskBody.indexOf('## Pending'), taskBody.indexOf('## Completed'));
  const completedSection = taskBody.slice(taskBody.indexOf('## Completed'));
  assert.equal(tasks.find((task) => task.id === 'T-001')?.status, 'completed');
  assert.doesNotMatch(pendingSection, /T-001/);
  assert.match(completedSection, /T-001/);
  assert.equal(updated?.taskBindings?.[0]?.status, 'completed');
  assert.ok(updated?.taskBindings?.[0]?.completedAt, 'binding gets completion timestamp');
  assert.ok(updated?.activity?.some((item) => item.type === 'status' && /Closed 1 linked task row/.test(item.message)));
});

test('ExecutionStore reconciles a late orphan before UI reads and never lets a retry erase ambiguity', () => {
  resetEventLog();
  const sessionId = `sess-late-write-${Math.random().toString(36).slice(2, 10)}`;
  createSession({ id: sessionId, kind: 'chat', title: 'late write reconciliation' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send both approved reports.' },
  });
  seedExecutions([]);
  const store = new ExecutionStore();
  const execution = store.create({
    sessionId,
    title: 'Send both reports',
    objective: 'Send both approved reports to their exact recipients',
    reason: 'test',
    startedFromMessage: 'send both reports',
    confidence: 0.9,
    reasons: ['test'],
    successCriteria: 'Both sends have confirmed receipts',
    sourceUserSeq: source.seq,
  } as never);
  ensureTasksFile();
  writeFileSync(
    TASKS_FILE,
    [
      '---',
      'type: tasks',
      '---',
      '',
      '# Tasks',
      '',
      '## Pending',
      '',
      '- [ ] {T-099} Send both approved reports !!high',
      '',
      '## Completed',
      '',
    ].join('\n'),
    'utf-8',
  );
  store.update(execution.id, {
    taskBindings: [{
      taskId: 'T-099',
      description: 'Send both approved reports',
      status: 'pending',
      createdAt: new Date().toISOString(),
    }],
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: {
      callId: 'send-a',
      correlationFingerprint: 'payload:send-a',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: ['a@example.com'],
    },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: {
      callId: 'send-b',
      correlationFingerprint: 'payload:send-b',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: ['b@example.com'],
    },
  });

  assert.equal(
    store.update(execution.id, {
      status: 'completed',
      blocker: undefined,
      lastAssistantSummary: 'Both reports sent.',
    })?.status,
    'completed',
  );
  assert.equal(
    new ExecutionStore().get(execution.id)?.taskBindings?.[0]?.status,
    'completed',
    'clean completion initially closes its linked task',
  );
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write_orphaned',
    data: {
      callId: 'send-b',
      correlationFingerprint: 'payload:send-b',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: ['b@example.com'],
    },
  });

  const uiRecord = new ExecutionStore().list(20).find((item) => item.id === execution.id);
  assert.equal(uiRecord?.status, 'blocked');
  assert.match(uiRecord?.blocker ?? '', /read-only reconciliation/i);
  assert.equal(
    uiRecord?.taskBindings?.[0]?.status,
    'pending',
    'a blocked execution cannot retain a misleading completed task binding',
  );
  const taskBodyAfterReconcile = readFileSync(TASKS_FILE, 'utf-8');
  const pendingAfterReconcile = taskBodyAfterReconcile.slice(
    taskBodyAfterReconcile.indexOf('## Pending'),
    taskBodyAfterReconcile.indexOf('## Completed'),
  );
  const completedAfterReconcile = taskBodyAfterReconcile.slice(
    taskBodyAfterReconcile.indexOf('## Completed'),
  );
  assert.match(pendingAfterReconcile, /\[ \] \{T-099\}/);
  assert.doesNotMatch(completedAfterReconcile, /T-099/);
  assert.equal(
    readExecutions().find((item) => item.id === execution.id)?.status,
    'blocked',
    'read reconciliation is persisted, not merely projected in memory',
  );

  appendEvent({
    sessionId,
    turn: 2,
    role: 'system',
    type: 'external_write',
    data: {
      callId: 'send-b-reconciled',
      retryOfCallId: 'send-b',
      correlationFingerprint: 'payload:send-b',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: ['b@example.com'],
    },
  });
  const retried = store.update(execution.id, {
    status: 'completed',
    blocker: undefined,
    lastAssistantSummary: 'Recipient B was reconciled and the corrected retry now has a receipt.',
  });
  assert.equal(
    retried?.status,
    'blocked',
    'a later send cannot prove the orphan did not already land; read-only reconciliation is still required',
  );
  assert.match(retried?.blocker ?? '', /read-only reconciliation/i);
});

test('exact-tagged late write evidence survives a newer user request and reopens its completed execution', () => {
  resetEventLog();
  const sessionId = `sess-late-tagged-write-${Math.random().toString(36).slice(2, 10)}`;
  createSession({ id: sessionId, kind: 'chat', title: 'late tagged write reconciliation' });
  const sourceA = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the approved North report.' },
  });
  seedExecutions([]);
  const store = new ExecutionStore();
  const execution = store.create({
    sessionId,
    title: 'Send North report',
    objective: 'Send the approved North report to the exact recipient',
    reason: 'test',
    startedFromMessage: 'send north report',
    confidence: 0.9,
    reasons: ['test'],
    successCriteria: 'The North send has a confirmed receipt',
    sourceUserSeq: sourceA.seq,
  } as never);
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: {
      sourceUserSeq: sourceA.seq,
      callId: 'north-send-late-resolution',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: ['north@example.com'],
    },
  });
  assert.equal(store.update(execution.id, {
    status: 'completed',
    blocker: undefined,
    lastAssistantSummary: 'North report sent.',
  })?.status, 'completed');

  appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'While that settles, draft an unrelated South report.' },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write_orphaned',
    data: {
      sourceUserSeq: sourceA.seq,
      callId: 'north-send-late-resolution',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: ['north@example.com'],
    },
  });

  const reconciled = new ExecutionStore().get(execution.id);
  assert.equal(reconciled?.status, 'blocked');
  assert.match(reconciled?.blocker ?? '', /read-only reconciliation/i);
});

test('untagged legacy write evidence remains bounded by the next user request', () => {
  resetEventLog();
  const sessionId = `sess-late-legacy-write-${Math.random().toString(36).slice(2, 10)}`;
  createSession({ id: sessionId, kind: 'chat', title: 'legacy write boundary' });
  const sourceA = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the approved North report.' },
  });
  seedExecutions([]);
  const store = new ExecutionStore();
  const execution = store.create({
    sessionId,
    title: 'Send North report',
    objective: 'Send the approved North report to the exact recipient',
    reason: 'test',
    startedFromMessage: 'send north report',
    confidence: 0.9,
    reasons: ['test'],
    successCriteria: 'The North send has a confirmed receipt',
    sourceUserSeq: sourceA.seq,
  } as never);
  assert.equal(store.update(execution.id, {
    status: 'completed',
    blocker: undefined,
    lastAssistantSummary: 'North report sent.',
  })?.status, 'completed');

  appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Now send an unrelated South report.' },
  });
  appendEvent({
    sessionId,
    turn: 2,
    role: 'system',
    type: 'external_write_failed',
    data: {
      callId: 'legacy-untagged-send',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: ['south@example.com'],
    },
  });

  const reread = new ExecutionStore().get(execution.id);
  assert.equal(reread?.status, 'completed');
  assert.equal(reread?.blocker, undefined);
});

test('an overlapping unrelated user request cannot contaminate a completed execution', () => {
  resetEventLog();
  const sessionId = `sess-write-owner-${Math.random().toString(36).slice(2, 10)}`;
  createSession({ id: sessionId, kind: 'chat', title: 'write ownership boundary' });
  const sourceA = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the approved North report.' },
  });
  seedExecutions([]);
  const store = new ExecutionStore();
  const execution = store.create({
    sessionId,
    title: 'Send North report',
    objective: 'Send the approved North report to the exact recipient',
    reason: 'test',
    startedFromMessage: 'send north report',
    confidence: 0.9,
    reasons: ['test'],
    successCriteria: 'The North send has a confirmed receipt',
    sourceUserSeq: sourceA.seq,
  } as never);
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: {
      sourceUserSeq: sourceA.seq,
      callId: 'north-send',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: ['north@example.com'],
    },
  });
  const sourceB = appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Now send an unrelated South report.' },
  });
  const completed = store.update(execution.id, {
    status: 'completed',
    blocker: undefined,
    lastAssistantSummary: 'North report sent.',
  });
  assert.equal(completed?.status, 'completed');
  assert.ok(completed?.completedAt, 'completion persists an immutable evidence boundary');

  appendEvent({
    sessionId,
    turn: 2,
    role: 'system',
    type: 'external_write_failed',
    data: {
      sourceUserSeq: sourceB.seq,
      callId: 'south-send',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: ['south@example.com'],
    },
  });

  const reread = new ExecutionStore().get(execution.id);
  assert.equal(reread?.status, 'completed');
  assert.equal(reread?.blocker, undefined);
});

test('an explicitly bound auth continuation can repair a proven failed write without borrowing unrelated turns', () => {
  resetEventLog();
  const sessionId = `sess-write-continuation-${Math.random().toString(36).slice(2, 10)}`;
  createSession({ id: sessionId, kind: 'chat', title: 'write continuation lineage' });
  const sourceA = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the approved report after validating the recipient.' },
  });
  seedExecutions([]);
  const store = new ExecutionStore();
  const execution = store.create({
    sessionId,
    title: 'Send approved report',
    objective: 'Send the approved report to the exact validated recipient',
    reason: 'test',
    startedFromMessage: 'send approved report',
    confidence: 0.9,
    reasons: ['test'],
    successCriteria: 'The send has a confirmed provider receipt',
    sourceUserSeq: sourceA.seq,
  } as never);
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: {
      sourceUserSeq: sourceA.seq,
      callId: 'send-before-auth',
      actionKey: 'email:send',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: ['north@example.com'],
    },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write_failed',
    data: {
      sourceUserSeq: sourceA.seq,
      callId: 'send-before-auth',
      actionKey: 'email:send',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: ['north@example.com'],
    },
  });
  assert.equal(store.update(execution.id, {
    status: 'completed',
    blocker: undefined,
    lastAssistantSummary: 'The first send did not dispatch because authentication was missing.',
  })?.status, 'blocked');

  const sourceB = appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Railway and Outlook are authenticated now; continue this execution.' },
  });
  assert.ok(
    store.bindSourceUserSeq(execution.id, sessionId, sourceB.seq, 'execution_update_step'),
    'an exact execution-scoped continuation binds its user row',
  );
  appendEvent({
    sessionId,
    turn: 2,
    role: 'system',
    type: 'external_write',
    data: {
      sourceUserSeq: sourceB.seq,
      callId: 'send-after-auth',
      retryOfCallId: 'send-before-auth',
      actionKey: 'email:send',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: ['north@example.com'],
    },
  });
  const completed = store.update(execution.id, {
    status: 'completed',
    blocker: undefined,
    lastAssistantSummary: 'Authentication was repaired and the exact send returned a receipt.',
  });
  assert.equal(completed?.status, 'completed');
  assert.deepEqual(completed?.sourceUserSeqs, [sourceB.seq]);

  const sourceC = appendEvent({
    sessionId,
    turn: 3,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send an unrelated South report.' },
  });
  appendEvent({
    sessionId,
    turn: 3,
    role: 'system',
    type: 'external_write_failed',
    data: {
      sourceUserSeq: sourceC.seq,
      callId: 'unrelated-south-send',
      actionKey: 'email:send',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: ['south@example.com'],
    },
  });
  assert.equal(new ExecutionStore().get(execution.id)?.status, 'completed');
  assert.equal(
    store.bindSourceUserSeq(execution.id, 'another-session', sourceC.seq, 'execution_update_step'),
    undefined,
    'a foreign session cannot attach evidence to this execution',
  );
});

test('sweepCrashedExecutions: active with stale heartbeat is auto-failed', () => {
  seedExecutions([
    baseExecution({
      id: 'crashed',
      status: 'active',
      lastHeartbeatAt: nowMinusMinutes(10),
      updatedAt: nowMinusMinutes(10),
      lastActivityAt: nowMinusMinutes(10),
    }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 1);
  const after = readExecutions();
  assert.equal(after[0].status, 'completed');
  assert.match(String(after[0].blocker), /Controller heartbeat stalled/);
});

test('sweepCrashedExecutions: stale heartbeat but recent execution activity is left alone', () => {
  seedExecutions([
    baseExecution({
      id: 'recent-activity',
      status: 'active',
      lastHeartbeatAt: nowMinusMinutes(10),
      updatedAt: nowMinusMinutes(1),
      lastActivityAt: nowMinusMinutes(1),
    }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 0);
  const after = readExecutions();
  assert.equal(after[0].status, 'active');
});

test('sweepCrashedExecutions: stale heartbeat but recent harness activity is left alone', () => {
  resetEventLog();
  createSession({ id: 'sess-recent-harness', kind: 'chat', title: 'recent harness' });
  appendEvent({
    sessionId: 'sess-recent-harness',
    turn: 1,
    role: 'assistant',
    type: 'tool_returned',
    data: { tool: 'run_shell_command' },
  });
  seedExecutions([
    baseExecution({
      id: 'recent-harness',
      sessionId: 'sess-recent-harness',
      status: 'active',
      lastHeartbeatAt: nowMinusMinutes(10),
      updatedAt: nowMinusMinutes(10),
      lastActivityAt: nowMinusMinutes(10),
    }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 0);
  const after = readExecutions();
  assert.equal(after[0].status, 'active');
});

test('sweepCrashedExecutions: stale heartbeat but nextReviewAt in the FUTURE is left alone (v0.5.64 schedule-aware)', () => {
  seedExecutions([
    baseExecution({
      id: 'scheduled-future',
      sessionId: 'sess-sched-future',
      status: 'active',
      lastHeartbeatAt: nowMinusMinutes(10),
      updatedAt: nowMinusMinutes(10),
      lastActivityAt: nowMinusMinutes(10),
      // controller scheduled the next review 25 min out — the stale heartbeat
      // is BY DESIGN, not a crash. Must NOT be swept.
      nextReviewAt: new Date(Date.now() + 25 * 60_000).toISOString(),
    }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 0, 'execution waiting for a future-scheduled review must not be swept');
  const after = readExecutions();
  assert.equal(after[0].status, 'active');
});

test('sweepCrashedExecutions: stale heartbeat AND nextReviewAt OVERDUE is still swept (real starvation)', () => {
  seedExecutions([
    baseExecution({
      id: 'scheduled-overdue',
      sessionId: 'sess-sched-overdue',
      status: 'active',
      lastHeartbeatAt: nowMinusMinutes(10),
      updatedAt: nowMinusMinutes(10),
      lastActivityAt: nowMinusMinutes(10),
      // review was due 8 min ago but the controller never ticked it — genuine
      // crash/starvation, still swept.
      nextReviewAt: nowMinusMinutes(8),
    }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 1, 'an overdue-but-stale execution is a real crash signal and is swept');
  const after = readExecutions();
  assert.equal(after[0].status, 'completed');
});

test('sweepCrashedExecutions: CLEMMY_SWEEP_HONOR_NEXT_REVIEW=off reverts to sweeping future-review executions', () => {
  const prev = process.env.CLEMMY_SWEEP_HONOR_NEXT_REVIEW;
  process.env.CLEMMY_SWEEP_HONOR_NEXT_REVIEW = 'off';
  try {
    seedExecutions([
      baseExecution({
        id: 'sched-flag-off',
        sessionId: 'sess-sched-flagoff',
        status: 'active',
        lastHeartbeatAt: nowMinusMinutes(10),
        updatedAt: nowMinusMinutes(10),
        lastActivityAt: nowMinusMinutes(10),
        nextReviewAt: new Date(Date.now() + 25 * 60_000).toISOString(),
      }),
    ]);
    const swept = sweepCrashedExecutions();
    assert.equal(swept, 1, 'kill-switch off => prior behavior (swept regardless of nextReviewAt)');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_SWEEP_HONOR_NEXT_REVIEW;
    else process.env.CLEMMY_SWEEP_HONOR_NEXT_REVIEW = prev;
  }
});

test('sweepCrashedExecutions: stale heartbeat with a MALFORMED nextReviewAt is still swept (NaN must not protect)', () => {
  seedExecutions([
    baseExecution({
      id: 'sched-garbage',
      sessionId: 'sess-sched-garbage',
      status: 'active',
      lastHeartbeatAt: nowMinusMinutes(10),
      updatedAt: nowMinusMinutes(10),
      lastActivityAt: nowMinusMinutes(10),
      nextReviewAt: 'not-a-real-date',
    }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 1, 'an unparseable nextReviewAt (NaN) falls through to the sweep — the conservative outcome');
  const after = readExecutions();
  assert.equal(after[0].status, 'completed');
});

test('sweepCrashedExecutions: active with fresh heartbeat is left alone', () => {
  seedExecutions([
    baseExecution({ id: 'fresh', status: 'active', lastHeartbeatAt: nowMinusMinutes(1) }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 0);
  const after = readExecutions();
  assert.equal(after[0].status, 'active');
});

test('sweepCrashedExecutions: active without ANY heartbeat is left alone (legacy fallback path)', () => {
  seedExecutions([
    baseExecution({ id: 'noheartbeat', status: 'active' }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 0);
  const after = readExecutions();
  assert.equal(after[0].status, 'active');
});

test('sweepCrashedExecutions: blocked execution is NOT swept by the crash reaper', () => {
  seedExecutions([
    baseExecution({ id: 'blocked', status: 'blocked', lastHeartbeatAt: nowMinusMinutes(60) }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 0);
  const after = readExecutions();
  assert.equal(after[0].status, 'blocked');
});

test('sweepCrashedExecutions: custom threshold honored', () => {
  seedExecutions([
    baseExecution({
      id: 'mid',
      status: 'active',
      lastHeartbeatAt: nowMinusMinutes(2),
      updatedAt: nowMinusMinutes(2),
      lastActivityAt: nowMinusMinutes(2),
    }),
  ]);
  // 60s threshold — 2-min-old heartbeat IS stale.
  const swept = sweepCrashedExecutions(60_000);
  assert.equal(swept, 1);
});

test('sweepStaleBlockedExecutions: blocked with stale updatedAt is auto-failed', () => {
  seedExecutions([
    baseExecution({ id: 'stuck', status: 'blocked', updatedAt: nowMinusMinutes(60 * 7) }),
  ]);
  const swept = sweepStaleBlockedExecutions();
  assert.equal(swept, 1);
  const after = readExecutions();
  assert.equal(after[0].status, 'completed');
  assert.match(String(after[0].blocker), /Blocked for \d+h/);
});

test('sweepStaleBlockedExecutions: blocked with recent updatedAt is left alone', () => {
  seedExecutions([
    baseExecution({ id: 'recent-blocked', status: 'blocked', updatedAt: nowMinusMinutes(60) }),
  ]);
  const swept = sweepStaleBlockedExecutions();
  assert.equal(swept, 0);
});

test('sweepStaleBlockedExecutions: active execution is NOT swept by the blocked reaper', () => {
  seedExecutions([
    baseExecution({ id: 'still-active', status: 'active', updatedAt: nowMinusMinutes(60 * 24) }),
  ]);
  const swept = sweepStaleBlockedExecutions();
  assert.equal(swept, 0);
});

test('legacy controller sweepers never manufacture terminal truth for durable project graphs', () => {
  seedExecutions([
    baseExecution({
      id: 'graph-stale-activity',
      graphAdmission: { kind: 'project_graph' },
      status: 'active',
      updatedAt: nowMinusMinutes(120),
      lastActivityAt: nowMinusMinutes(120),
    }),
    baseExecution({
      id: 'graph-stale-heartbeat',
      graphAdmission: { kind: 'project_graph' },
      status: 'active',
      lastHeartbeatAt: nowMinusMinutes(30),
      updatedAt: nowMinusMinutes(30),
      lastActivityAt: nowMinusMinutes(30),
    }),
    baseExecution({
      id: 'graph-stale-blocker',
      graphAdmission: { kind: 'project_graph' },
      status: 'blocked',
      updatedAt: nowMinusMinutes(60 * 12),
      lastActivityAt: nowMinusMinutes(60 * 12),
    }),
  ]);

  assert.equal(sweepStaleExecutions(), 0);
  assert.equal(sweepCrashedExecutions(), 0);
  assert.equal(sweepStaleBlockedExecutions(), 0);
  assert.deepEqual(
    readExecutions().map((row) => [row.id, row.status]),
    [
      ['graph-stale-activity', 'active'],
      ['graph-stale-heartbeat', 'active'],
      ['graph-stale-blocker', 'blocked'],
    ],
  );
});

test('sweepers leave file on disk untouched when there is nothing to sweep', () => {
  seedExecutions([
    baseExecution({ id: 'untouched', status: 'active', lastHeartbeatAt: nowMinusMinutes(1) }),
  ]);
  const before = readFileSync(EXECUTIONS_FILE, 'utf-8');
  sweepCrashedExecutions();
  sweepStaleBlockedExecutions();
  const after = readFileSync(EXECUTIONS_FILE, 'utf-8');
  assert.equal(after, before);
});

test('syncWithPlan does not auto-complete an execution when all plan rows are done', () => {
  seedExecutions([]);
  const store = new ExecutionStore();
  const execution = store.create({
    sessionId: 'sess-plan-sync',
    title: 'Finish report',
    objective: 'Finish the report and send the receipt',
    reason: 'test',
    startedFromMessage: 'finish it',
    confidence: 0.8,
    reasons: ['test'],
    nextStep: 'Draft the report',
    successCriteria: 'Report exists and receipt id is present',
  });
  const iso = new Date().toISOString();
  const plan: PlanRecord = {
    id: 'plan-all-done',
    title: 'Report plan',
    sessionId: execution.sessionId,
    source: 'execution',
    createdAt: iso,
    updatedAt: iso,
    steps: [
      { id: 'draft', text: 'Draft report', status: 'done' },
      { id: 'send', text: 'Send report', status: 'done' },
    ],
  };

  const synced = store.syncWithPlan(execution.id, plan);

  assert.equal(synced?.status, 'active');
  assert.equal(synced?.blocker, undefined);
  assert.match(synced?.nextStep ?? '', /Validate completion evidence/);
  assert.ok(synced?.nextReviewAt, 'finished plans should schedule controller validation');
});
