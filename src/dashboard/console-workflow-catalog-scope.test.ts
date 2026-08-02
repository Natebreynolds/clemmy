import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clementine-workflow-catalog-scope-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(testHome, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { appendWorkflowEvent } = await import('../execution/workflow-events.js');
const { workflowDefinitionHash } = await import('../execution/workflow-run-definition.js');
const { compileProjectPlan } = await import('../execution/project-compiler.js');
const { canonicalProjectPlan } = await import('../execution/project-plan-ir.js');
const { ExecutionStore } = await import('../execution/store.js');
const { appendEvent, createSession } = await import('../runtime/harness/eventlog.js');
const { queueCompiledWorkflowRun } = await import('../tools/workflow-run-queue.js');
const { recordStepOutput, readWorkspaceCheckerReport } = await import('../execution/workflow-run-workspace.js');
const { recordSubagentRun } = await import('../agents/subagent-runs.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

test.after(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => true, {
    getRuntime: () => ({ listPendingApprovals: () => [] }),
  } as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function seedCompiledControlRun(label: string): {
  runId: string;
  workflowSlug: string;
  workflowName: string;
} {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `session-${suffix}`;
  createSession({ id: sessionId, kind: 'chat', title: `Project ${label}` });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Build project ${label}.`, source: 'desktop' },
  });
  const plan = canonicalProjectPlan({
    planId: `control-${createHash('sha256').update(suffix).digest('hex').slice(0, 20)}`,
    objective: `Private project objective ${suffix}`,
    nodes: [{
      id: 'research',
      executor: {
        kind: 'model',
        instruction: `Private project prompt ${suffix}`,
        allowedTools: ['workspace_artifact_query'],
      },
      effect: 'read',
      maxTurns: 8,
      evidence: { type: 'object', requiredKeys: ['summary'], nonEmpty: ['summary'] },
    }],
  });
  const compiled = compileProjectPlan(plan);
  const workflowName = compiled.definition.name;
  const definition = compiled.definition;
  new ExecutionStore().createOrGetForSource({
    sessionId,
    sourceUserSeq: source.seq,
    title: `Project ${label}`,
    objective: 'Produce a verified result.',
    reason: 'This accepted source requires durable work.',
    startedFromMessage: `Build project ${label}.`,
    confidence: 0.95,
    reasons: ['durable multi-step work'],
    admission: {
      compiledPlan: {
        version: 2,
        compilerId: 'project_graph_v2',
        planHash: compiled.planHash,
        definitionHash: workflowDefinitionHash(definition),
        plan,
        definition,
        inputs: {},
      },
    },
  });
  const queued = queueCompiledWorkflowRun({ sessionId, sourceUserSeq: source.seq });
  assert.equal(queued.status, 'queued');
  assert.ok(queued.id);
  const raw = JSON.parse(
    readFileSync(path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`), 'utf-8'),
  ) as { workflowSlug: string };
  return { runId: queued.id, workflowSlug: raw.workflowSlug, workflowName };
}

test('Workflow Studio scopes run history to real catalog workflows while generic Tasks retains compiled projects', async () => {
  const workflowSlug = 'catalog-scope-workflow';
  const workflowName = 'Catalog Scope Workflow';
  const catalogRunId = 'catalog-scope-authored-run';
  const compiledSlug = 'compiled-0123456789abcdef0123456789abcdef';
  const compiledRunId = 'catalog-scope-compiled-run';
  const preCutCompiledRunId = 'catalog-scope-pre-cut-compiled-run';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'A saved workflow visible in Studio.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'inspect', prompt: 'Inspect the saved workflow result.', sideEffect: 'read' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${catalogRunId}.json`), JSON.stringify({
    id: catalogRunId,
    workflow: workflowName,
    status: 'blocked_capability',
    createdAt: '2026-08-02T12:00:00.000Z',
    source: 'workflow_run',
    error: 'Reconnect the account.',
    inputs: { privateAccountId: 'must-not-leave-the-run-record' },
    stepOutputs: { inspect: { privateRows: [1, 2, 3] } },
    workflowDefinitionSnapshot: {
      version: 1,
      definition: {
        name: workflowName,
        steps: [{ id: 'inspect', prompt: 'private authored prompt' }],
      },
    },
    capabilityBlock: {
      state: 'blocked',
      stepId: 'inspect',
      tool: 'PRIVATE_LOOKUP_TOOL',
      toolkit: 'private_lookup',
      reason: 'not-connected',
      message: 'Reconnect the private lookup account.',
      retryAt: '2026-08-02T12:05:00.000Z',
      retryCount: 2,
      provenNoDispatch: true,
      privateEvidence: 'must-not-be-projected',
    },
  }, null, 2), 'utf-8');

  // Deliberately reuse the catalog display name: exclusion must come from the
  // V3 compiled admission structure, never a name or prefix heuristic.
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${compiledRunId}.json`), JSON.stringify({
    id: compiledRunId,
    workflow: workflowName,
    workflowSlug: compiledSlug,
    status: 'running',
    createdAt: '2026-08-02T12:01:00.000Z',
    source: 'project_graph',
    inputs: { privateProjectInput: 'never expose this' },
    stepOutputs: { research: { privateFinding: 'never expose this either' } },
    workflowDefinitionSnapshot: {
      version: 3,
      scope: 'compiled',
      compilerId: 'project_graph_v2',
      definition: {
        name: workflowName,
        steps: [{ id: 'research', prompt: 'private compiled project prompt' }],
      },
    },
  }, null, 2), 'utf-8');
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${preCutCompiledRunId}.json`), JSON.stringify({
    id: preCutCompiledRunId,
    workflow: workflowName,
    workflowSlug: compiledSlug,
    status: 'running',
    createdAt: '2026-08-02T11:59:00.000Z',
    source: 'project_graph',
    workflowDefinitionSnapshot: {
      version: 2,
      scope: 'compiled',
      compilerId: 'project_graph_v1',
      definition: { name: workflowName, steps: [] },
    },
  }, null, 2), 'utf-8');
  appendWorkflowEvent(compiledSlug, compiledRunId, { kind: 'run_started' });
  appendWorkflowEvent(compiledSlug, compiledRunId, { kind: 'step_started', stepId: 'research' });
  appendWorkflowEvent(workflowSlug, catalogRunId, { kind: 'run_started' });
  appendWorkflowEvent(workflowSlug, catalogRunId, {
    kind: 'step_completed',
    stepId: 'inspect',
    output: { authoredResult: 'preserved' },
  });

  const server = await boot();
  try {
    const listResponse = await fetch(`${server.url}/api/console/workflows`);
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json() as {
      workflows: Array<{ name: string; lastRunId: string | null }>;
    };
    const listedWorkflow = listBody.workflows.find((workflow) => workflow.name === workflowName);
    assert.equal(listedWorkflow?.lastRunId, catalogRunId, 'compiled project cannot become catalog last-run evidence');

    const homeResponse = await fetch(`${server.url}/api/console/workflows/home`);
    assert.equal(homeResponse.status, 200);
    const home = await homeResponse.json() as {
      counts: { activeRuns: number };
      activeRuns: Array<{ runId: string }>;
      recentRuns: Array<{ id: string }>;
    };
    assert.equal(home.activeRuns.some((run) => run.runId === compiledRunId), false);
    assert.equal(home.activeRuns.some((run) => run.runId === preCutCompiledRunId), false);
    assert.equal(home.recentRuns.some((run) => run.id === compiledRunId), false);
    assert.equal(home.recentRuns.some((run) => run.id === preCutCompiledRunId), false);
    assert.equal(home.recentRuns.some((run) => run.id === catalogRunId), true);

    const runsResponse = await fetch(
      `${server.url}/api/console/workflows/${encodeURIComponent(workflowSlug)}/runs`,
    );
    assert.equal(runsResponse.status, 200);
    const runsBody = await runsResponse.json() as { runs: Array<Record<string, unknown>> };
    assert.equal(runsBody.runs.length, 1);
    const [run] = runsBody.runs;
    assert.equal(run.id, catalogRunId);
    for (const forbidden of ['inputs', 'stepOutputs', 'workflowDefinitionSnapshot', 'output', 'prompt']) {
      assert.equal(forbidden in run, false, `${forbidden} must not cross the run-summary boundary`);
    }
    assert.deepEqual(run.capabilityBlock, {
      stepId: 'inspect',
      tool: 'PRIVATE_LOOKUP_TOOL',
      toolkit: 'private_lookup',
      reason: 'not-connected',
      message: 'Reconnect the private lookup account.',
      retryAt: '2026-08-02T12:05:00.000Z',
      state: 'blocked',
      retryCount: 2,
    });

    const missingResponse = await fetch(
      `${server.url}/api/console/workflows/${encodeURIComponent(compiledSlug)}/runs`,
    );
    assert.equal(missingResponse.status, 404, 'run-scoped compiled identity is not a catalog workflow');

    const boardResponse = await fetch(`${server.url}/api/console/board`);
    assert.equal(boardResponse.status, 200);
    const board = await boardResponse.json() as { cards: Array<{ id: string; sourceKind: string }> };
    assert.ok(
      board.cards.some((card) => card.id === `wf:${compiledSlug}:${compiledRunId}` && card.sourceKind === 'workflow'),
      'generic Tasks retains the in-flight compiled project',
    );

    const authoredTrace = await fetch(
      `${server.url}/api/console/workflows/${encodeURIComponent(workflowSlug)}/runs/${catalogRunId}/events`,
    );
    assert.equal(authoredTrace.status, 200);
    assert.match(await authoredTrace.text(), /authoredResult/,
      'catalog-authored traces retain their existing payload contract');

    const authoredCancel = await fetch(
      `${server.url}/api/console/workflows/${encodeURIComponent(workflowSlug)}/runs/${catalogRunId}/cancel`,
      { method: 'POST' },
    );
    assert.equal(authoredCancel.status, 200);
    const authoredCancelBody = await authoredCancel.json() as { run?: { status?: string; inputs?: unknown } };
    assert.equal(authoredCancelBody.run?.status, 'cancelled');
    assert.ok(authoredCancelBody.run?.inputs,
      'catalog-authored cancellation keeps its pre-existing response shape');

    for (const endpoint of [
      `/api/console/workflows/${encodeURIComponent(compiledSlug)}/runs/${compiledRunId}/events`,
      `/api/console/workflows/${encodeURIComponent(compiledSlug)}/runs/${compiledRunId}/cancel`,
    ]) {
      const rejected = await fetch(`${server.url}${endpoint}`, {
        method: endpoint.endsWith('/cancel') ? 'POST' : 'GET',
      });
      assert.equal(rejected.status, 404, 'a structural V3 label without an immutable root contract fails closed');
    }

    const beforeMutationFiles = readdirSync(WORKFLOW_RUNS_DIR).filter((file) => file.endsWith('.json')).sort();
    for (const endpoint of [
      `/api/console/workflows/${encodeURIComponent(workflowName)}/runs/${compiledRunId}/retry-failed-items`,
      `/api/console/board/workflow/${encodeURIComponent(workflowName)}/runs/${compiledRunId}/resume-safe`,
    ]) {
      const refused = await fetch(`${server.url}${endpoint}`, { method: 'POST' });
      assert.equal(refused.status, 409, 'a corrupt compiled snapshot cannot regain catalog recovery authority');
    }
    assert.deepEqual(
      readdirSync(WORKFLOW_RUNS_DIR).filter((file) => file.endsWith('.json')).sort(),
      beforeMutationFiles,
      'corrupt project lineage creates no replacement run',
    );
  } finally {
    await server.close();
  }
});

test('catalogless compiled project trace and cancel use immutable run authority without leaking execution bytes', async () => {
  const compiled = seedCompiledControlRun('valid-control');
  appendWorkflowEvent(compiled.workflowSlug, compiled.runId, { kind: 'run_started' });
  appendWorkflowEvent(compiled.workflowSlug, compiled.runId, {
    kind: 'tool_called',
    stepId: 'research',
    output: { privateInput: 'SECRET_INPUT_VALUE' },
    meta: { prompt: 'SECRET_PROMPT_VALUE', arguments: { account: 'SECRET_ACCOUNT_VALUE' } },
  });
  appendWorkflowEvent(compiled.workflowSlug, compiled.runId, {
    kind: 'step_completed',
    stepId: 'research',
    itemKey: 'SECRET_ITEM_KEY',
    output: { privateOutput: 'SECRET_OUTPUT_VALUE' },
  });

  const server = await boot();
  try {
    const trace = await fetch(
      `${server.url}/api/console/workflows/${encodeURIComponent(compiled.workflowSlug)}/runs/${compiled.runId}/events`,
    );
    assert.equal(trace.status, 200);
    const traceBody = await trace.json() as {
      workflow?: string;
      events?: Array<Record<string, unknown>>;
    };
    assert.equal(traceBody.workflow, compiled.workflowName);
    assert.deepEqual(traceBody.events?.map((event) => Object.keys(event).sort()), [
      ['kind', 't'],
      ['kind', 'stepId', 't'],
      ['kind', 'stepId', 't'],
    ]);
    const traceJson = JSON.stringify(traceBody);
    for (const secret of [
      'SECRET_INPUT_VALUE',
      'SECRET_PROMPT_VALUE',
      'SECRET_ACCOUNT_VALUE',
      'SECRET_ITEM_KEY',
      'SECRET_OUTPUT_VALUE',
      'Private project prompt',
      'Private project objective',
    ]) assert.doesNotMatch(traceJson, new RegExp(secret));

    const cancelled = await fetch(
      `${server.url}/api/console/workflows/${encodeURIComponent(compiled.workflowSlug)}/runs/${compiled.runId}/cancel`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Stop this project.' }),
      },
    );
    assert.equal(cancelled.status, 200);
    const cancelBody = await cancelled.json() as { run?: Record<string, unknown> };
    assert.equal(cancelBody.run?.id, compiled.runId);
    assert.equal(cancelBody.run?.status, 'cancelled');
    for (const forbidden of [
      'inputs',
      'stepOutputs',
      'workflowDefinitionSnapshot',
      'compiledContractHash',
      'output',
      'prompt',
    ]) assert.equal(forbidden in (cancelBody.run ?? {}), false);
    const persisted = JSON.parse(
      readFileSync(path.join(WORKFLOW_RUNS_DIR, `${compiled.runId}.json`), 'utf-8'),
    ) as { status?: string; terminalOutcome?: string; projectExecutionSettlement?: { executionId?: string } };
    assert.equal(persisted.status, 'cancelled', 'the workflow cancellation boundary settles the root run');
    assert.equal(persisted.terminalOutcome, 'cancelled');
    const execution = new ExecutionStore().list().find((entry) =>
      entry.graphAdmission?.rootWorkflowRunId === compiled.runId
    );
    assert.equal(execution?.status, 'completed');
    assert.equal(execution?.graphAdmission?.rootWorkflowTerminal?.status, 'cancelled');
    assert.equal(execution?.graphAdmission?.rootWorkflowTerminal?.outcome, 'cancelled');
    assert.equal(persisted.projectExecutionSettlement?.executionId, execution?.id);
  } finally {
    await server.close();
  }
});

test('Tasks-board project cancellation stops the exact bound root before closing its execution card', async () => {
  const compiled = seedCompiledControlRun('execution-card-cancel');
  const store = new ExecutionStore();
  const execution = store.list().find((entry) =>
    entry.graphAdmission?.rootWorkflowRunId === compiled.runId
  )!;
  const server = await boot();
  try {
    const resume = await fetch(
      `${server.url}/api/console/board/execution/${encodeURIComponent(execution.id)}/transition`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'active' }),
      },
    );
    assert.equal(resume.status, 409);
    const resumeBody = await resume.json() as { reason?: string };
    assert.match(resumeBody.reason ?? '', /root workflow/i);
    assert.equal(store.get(execution.id)?.status, 'active');

    const response = await fetch(
      `${server.url}/api/console/board/execution/${encodeURIComponent(execution.id)}/transition`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'cancelled' }),
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { execution?: { status?: string } };
    assert.equal(body.execution?.status, 'completed');
    const run = JSON.parse(
      readFileSync(path.join(WORKFLOW_RUNS_DIR, `${compiled.runId}.json`), 'utf-8'),
    ) as { status?: string; terminalOutcome?: string };
    assert.equal(run.status, 'cancelled');
    assert.equal(run.terminalOutcome, 'cancelled');
    const settled = store.get(execution.id);
    assert.equal(settled?.graphAdmission?.rootWorkflowTerminal?.runId, compiled.runId);
    assert.equal(settled?.graphAdmission?.rootWorkflowTerminal?.outcome, 'cancelled');

    const board = await fetch(`${server.url}/api/console/board`);
    assert.equal(board.status, 200);
    const boardBody = await board.json() as { cards?: Array<{ id?: string; status?: string; actions?: string[] }> };
    const card = boardBody.cards?.find((candidate) => candidate.id === execution.id);
    assert.equal(card?.status, 'cancelled', 'the graph outcome, not compatibility status=completed, owns the pill');
    assert.deepEqual(card?.actions, []);
  } finally {
    await server.close();
  }
});

test('compiled project trace rejects a later catalog collision while exact cancellation remains available', async () => {
  const compiled = seedCompiledControlRun('catalog-collision');
  const privateArtifact = 'PRIVATE_PROJECT_ARTIFACT_COLLISION';
  const privateAgentOutput = 'PRIVATE_PROJECT_SUBAGENT_COLLISION';
  appendWorkflowEvent(compiled.workflowSlug, compiled.runId, { kind: 'run_started' });
  appendWorkflowEvent(compiled.workflowSlug, compiled.runId, {
    kind: 'step_completed',
    stepId: 'research',
    output: { secret: privateArtifact },
  });
  appendWorkflowEvent(compiled.workflowSlug, compiled.runId, {
    kind: 'run_summary',
    meta: {
      because: privateArtifact,
      artifacts: {
        files: [privateArtifact],
        urls: [`https://private.invalid/${privateArtifact}`],
      },
    },
  });
  recordStepOutput({
    workflowName: compiled.workflowSlug,
    runId: compiled.runId,
    stepId: 'research',
    output: { secret: privateArtifact },
    nowIso: new Date().toISOString(),
  });
  assert.ok(recordSubagentRun({
    id: 'private-project-specialist',
    parentRunId: compiled.runId,
    parentKind: 'workflow',
    workflowName: compiled.workflowSlug,
    stepId: 'research',
    provider: 'codex',
    task: 'Private project research',
    status: 'ok',
    output: privateAgentOutput,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  }));
  writeWorkflow(compiled.workflowSlug, {
    name: compiled.workflowName,
    description: 'A catalog identity that makes the project root ambiguous.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'catalog-step', prompt: 'Run the authored workflow.', sideEffect: 'read' }],
  });

  const server = await boot();
  try {
    const receiptDir = path.join(WORKFLOW_RUNS_DIR, '.trigger-receipts');
    const beforeRunFiles = readdirSync(WORKFLOW_RUNS_DIR).filter((file) => file.endsWith('.json')).sort();
    const beforeReceiptFiles = existsSync(receiptDir) ? readdirSync(receiptDir).sort() : [];
    for (const endpoint of [
      `/api/console/workflows/${encodeURIComponent(compiled.workflowName)}/runs/${compiled.runId}/retry-failed-items`,
      `/api/console/workflows/${encodeURIComponent(compiled.workflowName)}/runs/${compiled.runId}/resume-capability`,
      `/api/console/board/workflow/${encodeURIComponent(compiled.workflowName)}/runs/${compiled.runId}/retry-failed-items`,
      `/api/console/board/workflow/${encodeURIComponent(compiled.workflowName)}/runs/${compiled.runId}/resume-safe`,
    ]) {
      const refused = await fetch(`${server.url}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stepId: 'research' }),
      });
      assert.equal(refused.status, 409, `${endpoint} must not reinterpret the project root as the colliding catalog workflow`);
      assert.match(await refused.text(), /durable project root|admitted graph/i);
    }
    assert.deepEqual(
      readdirSync(WORKFLOW_RUNS_DIR).filter((file) => file.endsWith('.json')).sort(),
      beforeRunFiles,
      'no public recovery route creates a second run',
    );
    assert.deepEqual(
      existsSync(receiptDir) ? readdirSync(receiptDir).sort() : [],
      beforeReceiptFiles,
      'no public recovery route creates or changes receipt ownership',
    );
    const unchanged = JSON.parse(
      readFileSync(path.join(WORKFLOW_RUNS_DIR, `${compiled.runId}.json`), 'utf-8'),
    ) as { source?: string; workflowDefinitionSnapshot?: unknown };
    assert.equal(unchanged.source, 'project_graph');
    assert.ok(unchanged.workflowDefinitionSnapshot, 'the original private project record remains the only run');

    for (const endpoint of [
      `/api/console/workflows/${encodeURIComponent(compiled.workflowSlug)}/runs/${compiled.runId}/workspace`,
      `/api/console/workflows/${encodeURIComponent(compiled.workflowSlug)}/runs/${compiled.runId}/agents`,
      `/api/console/workflows/${encodeURIComponent(compiled.workflowSlug)}/runs/${compiled.runId}/agents/private-project-specialist/output`,
      `/api/console/workflows/${encodeURIComponent(compiled.workflowSlug)}/runs/${compiled.runId}/failed-items`,
      `/api/console/workflows/${encodeURIComponent(compiled.workflowSlug)}/runs/${compiled.runId}/graph-overlay`,
      `/api/console/board/run/${encodeURIComponent(compiled.workflowSlug)}/${compiled.runId}/queue`,
    ]) {
      const refused = await fetch(`${server.url}${endpoint}`);
      assert.equal(refused.status, 404, `${endpoint} must stay on the catalog side of the project boundary`);
      const body = await refused.text();
      assert.doesNotMatch(body, new RegExp(privateArtifact));
      assert.doesNotMatch(body, new RegExp(privateAgentOutput));
    }
    assert.equal(readWorkspaceCheckerReport(compiled.workflowSlug, compiled.runId), null);
    const checker = await fetch(
      `${server.url}/api/console/workflows/${encodeURIComponent(compiled.workflowSlug)}/runs/${compiled.runId}/check`,
      { method: 'POST' },
    );
    assert.equal(checker.status, 409);
    assert.equal(
      readWorkspaceCheckerReport(compiled.workflowSlug, compiled.runId),
      null,
      'catalog checker writes no project-owned report',
    );

    const board = await fetch(`${server.url}/api/console/board`);
    assert.equal(board.status, 200);
    const boardBody = await board.json() as {
      cards?: Array<{
        id?: string;
        actions?: string[];
        artifactSummary?: unknown;
        failureSummary?: unknown;
        primaryAction?: string;
      }>;
    };
    const rootCard = boardBody.cards?.find((card) =>
      card.id === `wf:${compiled.workflowSlug}:${compiled.runId}`
    );
    assert.ok(rootCard, 'the minimal live root remains visible on the generic Tasks board');
    assert.deepEqual(rootCard.actions, ['cancel']);
    assert.equal(rootCard.primaryAction, 'none');
    assert.equal(rootCard.artifactSummary, undefined);
    assert.equal(rootCard.failureSummary, undefined);
    assert.doesNotMatch(JSON.stringify(boardBody), new RegExp(privateArtifact));
    assert.doesNotMatch(JSON.stringify(boardBody), new RegExp(privateAgentOutput));

    const trace = await fetch(
      `${server.url}/api/console/workflows/${encodeURIComponent(compiled.workflowSlug)}/runs/${compiled.runId}/events`,
    );
    assert.equal(trace.status, 404);
    const cancel = await fetch(
      `${server.url}/api/console/workflows/${encodeURIComponent(compiled.workflowSlug)}/runs/${compiled.runId}/cancel`,
      { method: 'POST' },
    );
    assert.equal(cancel.status, 200,
      'a later display collision cannot revoke the authority-reducing exact-root cancellation path');
    const persisted = JSON.parse(
      readFileSync(path.join(WORKFLOW_RUNS_DIR, `${compiled.runId}.json`), 'utf-8'),
    ) as { status?: string };
    assert.equal(persisted.status, 'cancelled');
  } finally {
    await server.close();
  }
});
