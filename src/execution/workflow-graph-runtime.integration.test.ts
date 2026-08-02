/**
 * Run:
 *   npx tsx --test src/execution/workflow-graph-runtime.integration.test.ts
 *
 * RED-FIRST release contract: a persisted read-only graph node must survive a
 * daemon restart, materialize as a real workflow step, execute, and contribute
 * to the terminal output. This intentionally drives processWorkflowRuns rather
 * than a readiness/helper-only seam.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-graph-runtime-integration-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_WATCHER_JUDGE = 'off';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.WORKFLOW_USE_HARNESS = 'off';
process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';

const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const {
  materializeWorkflowGraphSteps,
  finalizeStepOutput,
  processWorkflowRuns,
  runCreationTest,
  _setBeforeWorkflowGraphFinalizationForTests,
  _setWorkflowHarnessLoopImplsForTests,
} = await import('./workflow-runner.js');
const { appendWorkflowEvent, readWorkflowEvents } = await import('./workflow-events.js');
const {
  readWorkspaceManifest,
  recordStepOutput,
  runWorkspaceDir,
} = await import('./workflow-run-workspace.js');
const { reshapeWorkflowGraph } = await import('./workflow-graph-reshape.js');
const {
  applyWorkflowGraphPatch,
  compileWorkflowStepsToGraph,
  workflowSubgraphSpecialistNodeId,
  WORKFLOW_GRAPH_ALLOWED_TOOLS,
} = await import('./workflow-graph.js');
const { persistWorkflowGraphSnapshot } = await import('./workflow-graph-store.js');
const { createWorkflowRunDefinitionSnapshot } = await import('./workflow-run-definition.js');

test.after(() => {
  _setBeforeWorkflowGraphFinalizationForTests(null);
  _setWorkflowHarnessLoopImplsForTests();
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('persisted graph snapshots cannot bypass dynamic runtime node-id safety', () => {
  const authoredSteps = [{ id: 'seed', prompt: 'Return the seed.', sideEffect: 'read' as const }];
  const graph = compileWorkflowStepsToGraph(authoredSteps);
  graph.nodes.push({
    id: '__proto__',
    stepId: '__proto__',
    type: 'step',
    prompt: 'Try to collide with the runtime output object.',
    sideEffect: 'read',
  });

  const materialized = materializeWorkflowGraphSteps(authoredSteps, graph);
  assert.equal(materialized.ok, false);
  assert.match(materialized.errors.join(' '), /reserved by the workflow runtime/i);
  assert.deepEqual(materialized.steps, authoredSteps, 'unsafe persisted nodes never become executable steps');
});

test('materializeWorkflowGraphSteps locks compiled specialists and reducer to result-only authority', () => {
  const authoredSteps = [
    { id: 'source', prompt: 'Return source evidence.', sideEffect: 'read' as const },
    {
      id: 'analyze',
      prompt: 'Join the specialist evidence.',
      dependsOn: ['source'],
      sideEffect: 'read' as const,
      allowedTools: ['composio_execute_tool', 'run_shell_command'],
      call: { tool: 'GMAIL_SEND_EMAIL', args: { to: 'unsafe@example.com' } },
      requiresApproval: true,
      usesSkill: 'unsafe-skill-authority',
      subgraph: {
        mode: 'read_parallel_v1' as const,
        specialists: [
          { id: 'facts', prompt: 'Check the facts.' },
          { id: 'risks', prompt: 'Check the risks.' },
        ],
      },
    },
  ];
  const materialized = materializeWorkflowGraphSteps(
    authoredSteps,
    compileWorkflowStepsToGraph(authoredSteps),
  );
  assert.equal(materialized.ok, true, materialized.errors.join('; '));

  const factsId = workflowSubgraphSpecialistNodeId('analyze', 'facts');
  const risksId = workflowSubgraphSpecialistNodeId('analyze', 'risks');
  const reducer = materialized.steps.find((step) => step.id === 'analyze') as Record<string, unknown> | undefined;
  const facts = materialized.steps.find((step) => step.id === factsId) as Record<string, unknown> | undefined;
  assert.deepEqual(reducer?.dependsOn, ['source', factsId, risksId]);
  assert.deepEqual(reducer?.allowedTools, WORKFLOW_GRAPH_ALLOWED_TOOLS);
  assert.equal(reducer?.subgraph, undefined, 'the executable reducer cannot recursively expand its authoring macro');
  assert.equal(reducer?.call, undefined, 'even a hand-edited invalid call is physically removed');
  assert.equal(reducer?.requiresApproval, false);
  assert.equal(reducer?.usesSkill, undefined);
  assert.equal(reducer?.__graphRuntimeRole, 'reducer');
  assert.deepEqual(facts?.dependsOn, ['source']);
  assert.deepEqual(facts?.allowedTools, WORKFLOW_GRAPH_ALLOWED_TOOLS);
  assert.equal(facts?.__graphRuntimeRole, 'specialist');
});

test('creation test certifies the compiled specialist graph rather than the flat reducer', async () => {
  const workflowSlug = 'compiled-specialist-creation-test';
  const runId = 'compiled-specialist-creation-test-run';
  const factsId = workflowSubgraphSpecialistNodeId('analyze', 'facts');
  const risksId = workflowSubgraphSpecialistNodeId('analyze', 'risks');
  const workflow = {
    name: 'Compiled Specialist Creation Test',
    description: 'Creation test topology parity.',
    enabled: false,
    trigger: { manual: true as const },
    steps: [{
      id: 'analyze',
      prompt: 'Join the specialist evidence.',
      sideEffect: 'read' as const,
      maxTurns: 4,
      subgraph: {
        mode: 'read_parallel_v1' as const,
        specialists: [
          { id: 'facts', prompt: 'Check the facts.', maxTurns: 3 },
          { id: 'risks', prompt: 'Check the risks.' },
        ],
      },
    }],
  };
  writeWorkflow(workflowSlug, workflow);
  const exactCreationMarker = 'CREATION-TEST-SLUG-SCOPED-ARTIFACT';
  finalizeStepOutput(
    workflowSlug,
    runId,
    { id: 'creation_seed', prompt: 'Persist exact creation-test context.', sideEffect: 'read' },
    { rows: [{ value: exactCreationMarker }] },
  );
  const creationSeedArtifact = readWorkspaceManifest(workflowSlug, runId)
    .find((entry) => entry.tool === 'step-output' && entry.agent === 'creation_seed');
  assert.ok(creationSeedArtifact);
  const creationSeedPath = path.join(
    runWorkspaceDir(workflowSlug, runId),
    creationSeedArtifact.path,
  );
  const started: string[] = [];
  const reducerPrompts: string[] = [];
  const artifactQueries: string[] = [];
  const maxTurnsBySession = new Map<string, number | undefined>();
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: {
      input?: string;
      sessionId?: string;
      maxTurns?: number;
      agent?: {
        tools?: Array<{
          name?: string;
          invoke?: (ctx: unknown, input: string, details?: unknown) => Promise<unknown>;
        }>;
      };
    }) => {
      const sessionId = String(request.sessionId ?? '');
      started.push(sessionId);
      maxTurnsBySession.set(sessionId, request.maxTurns);
      if (sessionId.endsWith(`:${factsId}`) || sessionId.endsWith(`:${risksId}`)) {
        const queryTool = (request.agent?.tools ?? [])
          .find((toolRef) => toolRef.name === 'workspace_artifact_query');
        assert.ok(queryTool?.invoke);
        const queried = await queryTool.invoke(
          { context: { sessionId } },
          JSON.stringify({ path: creationSeedPath, json_path: 'rows', offset: 0, limit: 1 }),
          { toolCall: { callId: `creation-query-${sessionId}` } },
        );
        artifactQueries.push(String(queried));
      }
      if (sessionId.endsWith(`:${factsId}`)) {
        return {
          sessionId,
          status: 'completed',
          steps: 1,
          lastTurn: 1,
          lastDecision: { summary: 'CREATION-FACTS' },
        };
      }
      if (sessionId.endsWith(`:${risksId}`)) {
        return {
          sessionId,
          status: 'completed',
          steps: 1,
          lastTurn: 1,
          lastDecision: { summary: 'CREATION-RISKS' },
        };
      }
      reducerPrompts.push(String(request.input ?? ''));
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'CREATION-JOINED' },
      };
    }) as never,
  });
  try {
    const result = await runCreationTest(
      workflow,
      workflowSlug,
      runId,
      {},
      { respond: async () => ({ text: 'legacy path must not run' }) } as never,
    );
    assert.equal(result.pass, true, JSON.stringify(result.steps));
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  assert.deepEqual(new Set(started), new Set([
    `workflow:${runId}:${factsId}`,
    `workflow:${runId}:${risksId}`,
    `workflow:${runId}:analyze`,
  ]));
  assert.match(reducerPrompts[0] ?? '', /CREATION-FACTS/);
  assert.match(reducerPrompts[0] ?? '', /CREATION-RISKS/);
  assert.equal(artifactQueries.length, 2);
  assert.ok(
    artifactQueries.every((result) => /refused.*not rendered into the active workflow step context/i.test(result)),
    'creation-test specialists cannot read an unrelated artifact merely because it shares the run workspace',
  );
  assert.equal(maxTurnsBySession.get(`workflow:${runId}:${factsId}`), 3);
  assert.equal(maxTurnsBySession.get(`workflow:${runId}:${risksId}`), undefined);
  assert.equal(maxTurnsBySession.get(`workflow:${runId}:analyze`), 4);
});

test('read_parallel_v1 executes real specialist nodes concurrently, joins them, and emits worker lifecycle events', async () => {
  const workflowSlug = 'compiled-specialist-graph';
  const workflowName = 'Compiled Specialist Graph';
  const runId = 'compiled-specialist-graph-run';
  const factsId = workflowSubgraphSpecialistNodeId('analyze', 'facts');
  const risksId = workflowSubgraphSpecialistNodeId('analyze', 'risks');

  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'analyze',
      prompt: 'Join every specialist result into one concise answer.',
      sideEffect: 'read',
      subgraph: {
        mode: 'read_parallel_v1',
        specialists: [
          { id: 'facts', prompt: 'Check factual support.' },
          { id: 'risks', prompt: 'Check risks and contradictions.' },
        ],
      },
    }],
  });

  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');

  let activeSpecialists = 0;
  let maxActiveSpecialists = 0;
  let specialistStarts = 0;
  let releaseSpecialists = (): void => {};
  const bothStarted = new Promise<void>((resolve) => { releaseSpecialists = resolve; });
  const fallback = setTimeout(releaseSpecialists, 1_000);
  const reducerPrompts: string[] = [];
  const toolSurfaces = new Map<string, string[]>();

  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: {
      input?: string;
      sessionId?: string;
      agent?: { tools?: Array<{ name?: string }> };
    }) => {
      const sessionId = String(request.sessionId ?? '');
      toolSurfaces.set(sessionId, (request.agent?.tools ?? []).map((toolRef) => String(toolRef.name ?? '')));
      if (sessionId.endsWith(`:${factsId}`) || sessionId.endsWith(`:${risksId}`)) {
        activeSpecialists += 1;
        specialistStarts += 1;
        maxActiveSpecialists = Math.max(maxActiveSpecialists, activeSpecialists);
        if (specialistStarts === 2) releaseSpecialists();
        await bothStarted;
        activeSpecialists -= 1;
        const marker = sessionId.endsWith(`:${factsId}`) ? 'FACTS-BRANCH' : 'RISKS-BRANCH';
        return {
          sessionId,
          status: 'completed',
          steps: 1,
          lastTurn: 1,
          lastDecision: { summary: marker },
        };
      }
      assert.ok(sessionId.endsWith(':analyze'), `unexpected graph session ${sessionId}`);
      reducerPrompts.push(String(request.input ?? ''));
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'JOINED-SPECIALIST-RESULT' },
      };
    }) as never,
  });
  try {
    await processWorkflowRuns({ respond: async () => ({ text: 'legacy path must not run' }) } as never);
  } finally {
    clearTimeout(fallback);
    _setWorkflowHarnessLoopImplsForTests();
  }

  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as {
    status?: string;
    output?: string;
    reportBack?: { detail?: string };
  };
  assert.equal(terminal.status, 'completed');
  assert.equal(specialistStarts, 2);
  assert.equal(maxActiveSpecialists, 2, 'both specialist nodes overlap in the scheduler wave');
  assert.ok(reducerPrompts[0]?.includes('FACTS-BRANCH'));
  assert.ok(reducerPrompts[0]?.includes('RISKS-BRANCH'));
  assert.match(terminal.output ?? '', /JOINED-SPECIALIST-RESULT/);
  assert.doesNotMatch(terminal.output ?? '', /FACTS-BRANCH|RISKS-BRANCH/, 'private branch outputs are not published twice');

  for (const stepId of [factsId, risksId, 'analyze']) {
    assert.deepEqual(
      toolSurfaces.get(`workflow:${runId}:${stepId}`),
      ['workflow_step_result', 'workspace_artifact_query'],
      `${stepId} is physically result-only`,
    );
  }
  const { listEvents } = await import('../runtime/harness/eventlog.js');
  for (const stepId of [factsId, risksId]) {
    const events = listEvents(`workflow:${runId}:${stepId}`);
    assert.equal(events.filter((event) => event.type === 'worker_started').length, 1);
    assert.equal(events.filter((event) => event.type === 'worker_result').length, 1);
    assert.equal(events.find((event) => event.type === 'worker_result')?.data?.ok, true);
  }
  const workflowEvents = readWorkflowEvents(workflowSlug, runId);
  assert.ok(workflowEvents.some((event) =>
    event.kind === 'workflow_node_ready'
    && event.stepId === factsId
    && event.meta?.parallel === true
    && event.meta?.readyWidth === 2));
  assert.ok(workflowEvents.some((event) => event.kind === 'step_completed' && event.stepId === 'analyze'));
});

test('read_parallel_v1 uses the admitted workflow worker pin after the saved definition changes', async () => {
  const workflowSlug = 'compiled-specialist-model-snapshot';
  const workflowName = 'Compiled Specialist Model Snapshot';
  const runId = 'compiled-specialist-model-snapshot-run';
  const factsId = workflowSubgraphSpecialistNodeId('analyze', 'facts');
  const risksId = workflowSubgraphSpecialistNodeId('analyze', 'risks');
  const admittedWorkflow = {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true as const },
    models: { worker: 'gpt-5.2-codex' },
    steps: [{
      id: 'analyze',
      prompt: 'Join every specialist result.',
      sideEffect: 'read' as const,
      subgraph: {
        mode: 'read_parallel_v1' as const,
        specialists: [
          { id: 'facts', prompt: 'Check facts.' },
          { id: 'risks', prompt: 'Check risks.' },
        ],
      },
    }],
  };
  const definitionSnapshot = createWorkflowRunDefinitionSnapshot(
    workflowSlug,
    admittedWorkflow,
    '2026-08-01T12:00:00.000Z',
  );
  writeWorkflow(workflowSlug, {
    ...admittedWorkflow,
    models: { worker: 'gpt-5.3-codex' },
  });

  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    workflowDefinitionSnapshot: definitionSnapshot,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');

  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string }) => ({
      sessionId: request.sessionId,
      status: 'completed',
      steps: 1,
      lastTurn: 1,
      lastDecision: {
        summary: String(request.sessionId ?? '').endsWith(':analyze') ? 'SNAPSHOT-JOINED' : 'SNAPSHOT-BRANCH',
      },
    })) as never,
  });
  try {
    await processWorkflowRuns({ respond: async () => ({ text: 'legacy path must not run' }) } as never);
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string };
  assert.equal(terminal.status, 'completed');
  const { listEvents } = await import('../runtime/harness/eventlog.js');
  for (const specialistId of [factsId, risksId]) {
    const started = listEvents(`workflow:${runId}:${specialistId}`)
      .find((event) => event.type === 'worker_started');
    assert.equal(started?.data?.model, 'gpt-5.2-codex');
  }
});

test('read_parallel_v1 restart reuses a completed specialist artifact and runs only the missing branch', async () => {
  const workflowSlug = 'compiled-specialist-resume';
  const workflowName = 'Compiled Specialist Resume';
  const runId = 'compiled-specialist-resume-run';
  const factsId = workflowSubgraphSpecialistNodeId('analyze', 'facts');
  const risksId = workflowSubgraphSpecialistNodeId('analyze', 'risks');
  const authoredSteps = [{
    id: 'analyze',
    prompt: 'Join every specialist result.',
    sideEffect: 'read' as const,
    subgraph: {
      mode: 'read_parallel_v1' as const,
      specialists: [
        { id: 'facts', prompt: 'Check facts.' },
        { id: 'risks', prompt: 'Check risks.' },
      ],
    },
  }];
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: authoredSteps,
  });
  const graph = compileWorkflowStepsToGraph(authoredSteps, {
    id: `${workflowSlug}:${runId}`,
    name: workflowName,
  });
  persistWorkflowGraphSnapshot({ workflowName: workflowSlug, runId, graph });
  const materialized = materializeWorkflowGraphSteps(authoredSteps, graph);
  assert.equal(materialized.ok, true, materialized.errors.join('; '));
  const factsStep = materialized.steps.find((step) => step.id === factsId);
  assert.ok(factsStep);

  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'running',
    inputs: {},
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  }), 'utf-8');
  appendWorkflowEvent(workflowSlug, runId, { kind: 'run_started', meta: { source: 'pre-crash-process' } });
  finalizeStepOutput(workflowSlug, runId, factsStep!, 'FACTS-FROM-BEFORE-RESTART');

  const startedSessions: string[] = [];
  const reducerPrompts: string[] = [];
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { input?: string; sessionId?: string }) => {
      const sessionId = String(request.sessionId ?? '');
      startedSessions.push(sessionId);
      assert.ok(!sessionId.endsWith(`:${factsId}`), 'completed specialist must not dispatch again');
      if (sessionId.endsWith(`:${risksId}`)) {
        return {
          sessionId,
          status: 'completed',
          steps: 1,
          lastTurn: 1,
          lastDecision: { summary: 'RISKS-AFTER-RESTART' },
        };
      }
      reducerPrompts.push(String(request.input ?? ''));
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'JOINED-AFTER-RESTART' },
      };
    }) as never,
  });
  try {
    await processWorkflowRuns({ respond: async () => ({ text: 'legacy path must not run' }) } as never);
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  assert.deepEqual(startedSessions, [`workflow:${runId}:${risksId}`, `workflow:${runId}:analyze`]);
  assert.ok(reducerPrompts[0]?.includes('FACTS-FROM-BEFORE-RESTART'));
  assert.ok(reducerPrompts[0]?.includes('RISKS-AFTER-RESTART'));
  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string; output?: string };
  assert.equal(terminal.status, 'completed');
  assert.match(terminal.output ?? '', /JOINED-AFTER-RESTART/);
  assert.equal(
    readWorkflowEvents(workflowSlug, runId)
      .filter((event) => event.kind === 'step_completed' && event.stepId === factsId).length,
    1,
    'the pre-restart completion remains exactly once',
  );
});

test('Platform-49-derived scan pages 500 opaque records, finds a final-page delta, and publishes only the reducer', async () => {
  // Sanitized characterization of the recurring Platform 49 shape: a large
  // channel scan is already durable when the daemon resumes, two read-only
  // specialists inspect it in parallel, and only their reducer is public.
  // IDs deliberately look numeric but remain opaque strings end-to-end.
  const workflowSlug = 'platform-49-sanitized-characterization';
  const workflowName = 'Platform 49 Sanitized Characterization';
  const runId = 'platform-49-sanitized-characterization-run';
  const pageAuditId = workflowSubgraphSpecialistNodeId('reconcile', 'page_audit');
  const deltaAuditId = workflowSubgraphSpecialistNodeId('reconcile', 'delta_audit');
  const finalOpaqueId = '1785000000.000499';
  const publicResult = 'Platform 49 scan complete: 500 records checked; 1 changed record.';
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const records = Array.from({ length: 500 }, (_, index) => ({
    id: `1785000000.${String(index).padStart(6, '0')}`,
    baseline: 'queued',
    observed: index === 499 ? 'reviewed' : 'queued',
    label: `sanitized-message-${String(index).padStart(4, '0')}`,
    padding: 'x'.repeat(48),
  }));
  assert.equal(records.at(-1)?.id, finalOpaqueId);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ records }), 'utf-8') > 32 * 1024,
    'fixture must be large enough to require the exact run artifact after restart',
  );

  const authoredSteps = [
    {
      id: 'inventory',
      prompt: 'Return the complete sanitized channel inventory.',
      sideEffect: 'read' as const,
    },
    {
      id: 'reconcile',
      prompt: 'Reduce the scan evidence to a concise public change count.',
      sideEffect: 'read' as const,
      dependsOn: ['inventory'],
      subgraph: {
        mode: 'read_parallel_v1' as const,
        specialists: [
          { id: 'page_audit', prompt: 'Page through every inventory record and report the exact count.' },
          { id: 'delta_audit', prompt: 'Inspect the final page for baseline-to-observed changes.' },
        ],
      },
    },
  ];
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'Sanitized recurring-scan characterization fixture.',
    enabled: true,
    trigger: { manual: true, schedule: '0 */2 * * *', timezone: 'America/Los_Angeles' },
    goal: {
      objective: 'Complete the sanitized recurring scan and retain its durable run checkpoint.',
      successCriteria: [`The durable run checkpoint exists at ${runFile}.`],
      maxAttempts: 1,
    },
    steps: authoredSteps,
  });
  const graph = compileWorkflowStepsToGraph(authoredSteps, {
    id: `${workflowSlug}:${runId}`,
    name: workflowName,
  });
  persistWorkflowGraphSnapshot({ workflowName: workflowSlug, runId, graph });

  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'running',
    inputs: {},
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  }), 'utf-8');
  appendWorkflowEvent(workflowSlug, runId, { kind: 'run_started', meta: { source: 'pre-restart-process' } });
  finalizeStepOutput(workflowSlug, runId, authoredSteps[0], { records });
  const inventoryArtifact = readWorkspaceManifest(workflowSlug, runId)
    .find((entry) => entry.tool === 'step-output' && entry.agent === 'inventory');
  assert.ok(inventoryArtifact, 'the pre-restart inventory has a durable exact artifact');
  const inventoryPath = path.join(runWorkspaceDir(workflowSlug, runId), inventoryArtifact.path);

  let activeSpecialists = 0;
  let maxActiveSpecialists = 0;
  let specialistStarts = 0;
  let conversationCalls = 0;
  let releaseSpecialists = (): void => {};
  const bothStarted = new Promise<void>((resolve) => { releaseSpecialists = resolve; });
  const fallback = setTimeout(releaseSpecialists, 1_000);
  const pagedOffsets: number[] = [];
  const specialistPrompts: string[] = [];
  const reducerPrompts: string[] = [];

  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: {
      input?: string;
      sessionId?: string;
      agent?: {
        tools?: Array<{
          name?: string;
          invoke?: (ctx: unknown, input: string, details?: unknown) => Promise<unknown>;
        }>;
      };
    }) => {
      conversationCalls += 1;
      const sessionId = String(request.sessionId ?? '');
      assert.ok(!sessionId.endsWith(':inventory'), 'the completed pre-restart inventory must not run again');
      const isPageAudit = sessionId.endsWith(`:${pageAuditId}`);
      const isDeltaAudit = sessionId.endsWith(`:${deltaAuditId}`);
      const tools = request.agent?.tools ?? [];

      if (isPageAudit || isDeltaAudit) {
        specialistPrompts.push(String(request.input ?? ''));
        assert.deepEqual(
          tools.map((toolRef) => toolRef.name),
          ['workflow_step_result', 'workspace_artifact_query'],
          'each specialist remains result-only with one run-scoped exact-data reader',
        );
        const queryTool = tools.find((toolRef) => toolRef.name === 'workspace_artifact_query');
        assert.ok(queryTool?.invoke);
        const invocationContext = { context: { sessionId } };
        activeSpecialists += 1;
        specialistStarts += 1;
        maxActiveSpecialists = Math.max(maxActiveSpecialists, activeSpecialists);
        if (specialistStarts === 2) releaseSpecialists();
        await bothStarted;

        let summary: string;
        if (isPageAudit) {
          for (const offset of [0, 100, 200, 300, 400]) {
            const page = String(await queryTool.invoke(
              invocationContext,
              JSON.stringify({
                path: inventoryPath,
                json_path: 'records',
                fields: ['id', 'baseline', 'observed'],
                offset,
                limit: 100,
              }),
              { toolCall: { callId: `platform49-page-${offset}` } },
            ));
            assert.ok(
              page.includes(`showing 100 record(s) [${offset}-${offset + 100}] of 500`),
              `page ${offset / 100 + 1} must preserve exact pagination metadata`,
            );
            pagedOffsets.push(offset);
          }
          summary = 'PRIVATE-PAGE-AUDIT:500-EXACT';
        } else {
          const tail = String(await queryTool.invoke(
            invocationContext,
            JSON.stringify({
              path: inventoryPath,
              json_path: 'records',
              fields: ['id', 'baseline', 'observed'],
              offset: 499,
              limit: 1,
            }),
            { toolCall: { callId: 'platform49-final-page-delta' } },
          ));
          assert.ok(tail.includes(finalOpaqueId), 'the decimal-like ID survives as an exact opaque string');
          assert.ok(tail.includes('"baseline": "queued"'));
          assert.ok(tail.includes('"observed": "reviewed"'));
          summary = `PRIVATE-FINAL-PAGE-DELTA:${finalOpaqueId}:queued->reviewed`;
        }
        activeSpecialists -= 1;
        return {
          sessionId,
          status: 'completed',
          steps: 1,
          lastTurn: 1,
          lastDecision: { summary },
        };
      }

      assert.ok(sessionId.endsWith(':reconcile'), `unexpected graph session ${sessionId}`);
      const reducerPrompt = String(request.input ?? '');
      reducerPrompts.push(reducerPrompt);
      assert.ok(reducerPrompt.includes('PRIVATE-PAGE-AUDIT:500-EXACT'));
      assert.ok(reducerPrompt.includes(`PRIVATE-FINAL-PAGE-DELTA:${finalOpaqueId}:queued->reviewed`));
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: publicResult },
      };
    }) as never,
  });
  try {
    await processWorkflowRuns({ respond: async () => ({ text: 'legacy path must not run' }) } as never);
    const callsAfterCompletion = conversationCalls;
    await processWorkflowRuns({ respond: async () => ({ text: 'legacy path must not run' }) } as never);
    assert.equal(conversationCalls, callsAfterCompletion, 'a completed recurring run is an exact no-op on the next poll');
  } finally {
    clearTimeout(fallback);
    _setWorkflowHarnessLoopImplsForTests();
  }

  assert.equal(specialistStarts, 2);
  assert.equal(maxActiveSpecialists, 2, 'the two scan specialists overlap in one scheduler wave');
  assert.deepEqual(pagedOffsets, [0, 100, 200, 300, 400]);
  assert.equal(reducerPrompts.length, 1, 'the reducer owns the one public synthesis');
  assert.ok(
    specialistPrompts.every((prompt) => prompt.includes('__clementine_context_ref')),
    'both specialists receive the exact durable inventory reference rather than an inline truncation',
  );

  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as {
    status?: string;
    output?: string;
    reportBack?: { detail?: string };
  };
  assert.equal(terminal.status, 'completed');
  assert.match(terminal.output ?? '', /Platform 49 scan complete: 500 records checked; 1 changed record\./);
  assert.doesNotMatch(
    terminal.output ?? '',
    /PRIVATE-PAGE-AUDIT|PRIVATE-FINAL-PAGE-DELTA|1785000000\.000499/,
    'specialist evidence remains private and is not narrated into the final output',
  );
  assert.match(terminal.reportBack?.detail ?? '', /Platform 49 scan complete: 500 records checked; 1 changed record\./);
  assert.doesNotMatch(
    terminal.reportBack?.detail ?? '',
    /PRIVATE-PAGE-AUDIT|PRIVATE-FINAL-PAGE-DELTA|1785000000\.000499/,
    'notification and report-back use the same reducer-only public projection',
  );

  const events = readWorkflowEvents(workflowSlug, runId);
  for (const stepId of ['inventory', pageAuditId, deltaAuditId, 'reconcile']) {
    assert.equal(
      events.filter((event) => event.kind === 'step_completed' && event.stepId === stepId).length,
      1,
      `${stepId} completes exactly once across restart and the no-op poll`,
    );
  }
  const { listEvents } = await import('../runtime/harness/eventlog.js');
  for (const stepId of [pageAuditId, deltaAuditId]) {
    const workerEvents = listEvents(`workflow:${runId}:${stepId}`);
    assert.equal(workerEvents.filter((event) => event.type === 'worker_started').length, 1);
    assert.equal(workerEvents.filter((event) => event.type === 'worker_result').length, 1);
  }
});

test('read_parallel_v1 fails closed when one specialist fails and never dispatches the reducer', async () => {
  const workflowSlug = 'compiled-specialist-failure';
  const workflowName = 'Compiled Specialist Failure';
  const runId = 'compiled-specialist-failure-run';
  const factsId = workflowSubgraphSpecialistNodeId('analyze', 'facts');
  const risksId = workflowSubgraphSpecialistNodeId('analyze', 'risks');
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'analyze',
      prompt: 'Join every specialist result.',
      sideEffect: 'read',
      subgraph: {
        mode: 'read_parallel_v1',
        specialists: [
          { id: 'facts', prompt: 'Check facts.' },
          { id: 'risks', prompt: 'Check risks.' },
        ],
      },
    }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');

  let reducerStarted = false;
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string }) => {
      const sessionId = String(request.sessionId ?? '');
      if (sessionId.endsWith(`:${risksId}`)) throw new Error('specialist evidence source unavailable');
      if (sessionId.endsWith(':analyze')) reducerStarted = true;
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'FACTS-ONLY' },
      };
    }) as never,
  });
  try {
    await processWorkflowRuns({ respond: async () => ({ text: 'legacy path must not run' }) } as never);
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  assert.equal(reducerStarted, false);
  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string };
  assert.equal(terminal.status, 'error');
  const events = readWorkflowEvents(workflowSlug, runId);
  assert.ok(events.some((event) => event.kind === 'step_completed' && event.stepId === factsId));
  assert.ok(!events.some((event) => event.kind === 'step_started' && event.stepId === 'analyze'));
  const { listEvents } = await import('../runtime/harness/eventlog.js');
  const failedWorker = listEvents(`workflow:${runId}:${risksId}`)
    .find((event) => event.type === 'worker_result');
  assert.equal(failedWorker?.data?.ok, false);
});

test('processWorkflowRuns resumes from the persisted live graph and includes its added prompt node in final output', async () => {
  const workflowSlug = 'live-graph-resume';
  const workflowName = 'Live Graph Resume';
  const runId = 'live-graph-resume-run';
  const marker = 'LIVE-GRAPH-RESUME-NODE-EXECUTED';
  const deepRowMarker = 'EXACT-ROW-420-SURVIVED-RESTART';
  const largeSeedOutput = {
    rows: Array.from({ length: 500 }, (_, index) => ({
      index,
      value: `${'x'.repeat(90)}${index === 420 ? deepRowMarker : ''}`,
    })),
  };
  const authoredSteps = [{
    id: 'seed',
    prompt: 'Return the seed value.',
    sideEffect: 'read' as const,
  }];

  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: authoredSteps,
  });

  const compiled = compileWorkflowStepsToGraph(authoredSteps, {
    id: `${workflowSlug}:${runId}`,
    name: workflowName,
  });
  const patched = applyWorkflowGraphPatch(compiled, {
    reason: 'Add one read-only prompt after the seed step.',
    operations: [
      {
        op: 'add_node',
        node: {
          id: 'restart_probe',
          stepId: 'restart_probe',
          type: 'step',
          prompt: `Return exactly ${marker}.`,
          sideEffect: 'read',
        },
      },
      {
        op: 'add_edge',
        edge: {
          id: 'dependency:seed->restart_probe',
          source: 'seed',
          target: 'restart_probe',
          type: 'dependency',
        },
      },
    ],
  });
  assert.equal(patched.ok, true, patched.errors.join('; '));
  persistWorkflowGraphSnapshot({
    workflowName: workflowSlug,
    runId,
    graph: patched.graph,
  });

  // This is the durable state a new daemon process sees after the authored
  // seed completed and the old process died before the graph-added node ran.
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'running',
    inputs: {},
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  }), 'utf-8');
  appendWorkflowEvent(workflowSlug, runId, {
    kind: 'run_started',
    meta: { source: 'pre-restart-process' },
  });
  finalizeStepOutput(workflowSlug, runId, authoredSteps[0], largeSeedOutput);
  const seedArtifact = readWorkspaceManifest(workflowSlug, runId)
    .find((entry) => entry.tool === 'step-output' && entry.agent === 'seed');
  assert.ok(seedArtifact, 'the pre-restart process committed an exact seed artifact');
  const exactSeedPath = path.join(runWorkspaceDir(workflowSlug, runId), seedArtifact.path);
  const orphanSeed = recordStepOutput({
    workflowName: workflowSlug,
    runId,
    stepId: 'seed',
    output: { rows: [{ index: 999, value: 'ORPHAN-NOT-AUTHORIZED' }] },
    nowIso: new Date().toISOString(),
  });
  const orphanSeedPath = path.join(runWorkspaceDir(workflowSlug, runId), orphanSeed.path);

  const prompts: string[] = [];
  const visibleToolSurfaces: string[][] = [];
  const queryResults: string[] = [];
  const outsideRunResults: string[] = [];
  const orphanResults: string[] = [];
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: {
      input?: string;
      sessionId?: string;
      agent?: {
        tools?: Array<{
          name?: string;
          invoke?: (ctx: unknown, input: string, details?: unknown) => Promise<unknown>;
        }>;
      };
    }) => {
      prompts.push(String(request.input ?? ''));
      visibleToolSurfaces.push((request.agent?.tools ?? []).map((toolRef) => String(toolRef.name ?? '')));
      const queryTool = (request.agent?.tools ?? [])
        .find((toolRef) => toolRef.name === 'workspace_artifact_query');
      assert.ok(queryTool?.invoke, 'graph node receives its scoped artifact query');
      const invocationContext = { context: { sessionId: request.sessionId ?? 'graph-test' } };
      const queried = await queryTool.invoke(
        invocationContext,
        JSON.stringify({
          path: exactSeedPath,
          json_path: 'rows',
          offset: 420,
          limit: 1,
          fields: ['index', 'value'],
        }),
        { toolCall: { callId: 'graph-exact-row' } },
      );
      queryResults.push(String(queried));
      const refused = await queryTool.invoke(
        invocationContext,
        JSON.stringify({ path: runFile, limit: 1 }),
        { toolCall: { callId: 'graph-outside-run' } },
      );
      outsideRunResults.push(String(refused));
      const orphanRefused = await queryTool.invoke(
        invocationContext,
        JSON.stringify({ path: orphanSeedPath, limit: 1 }),
        { toolCall: { callId: 'graph-orphan-artifact' } },
      );
      orphanResults.push(String(orphanRefused));
      return {
        sessionId: request.sessionId ?? `workflow:${runId}:restart_probe`,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: marker },
      };
    }) as never,
  });
  try {
    await processWorkflowRuns({ respond: async () => ({ text: marker }) } as never);
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  const events = readWorkflowEvents(workflowSlug, runId);
  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as {
    status?: string;
    output?: string;
    stepOutputs?: Record<string, string>;
  };

  assert.equal(terminal.status, 'completed');
  assert.ok(
    events.some((event) =>
      event.kind === 'step_completed'
      && event.stepId === 'restart_probe'
      && event.output === marker),
    'the graph-added node must execute and record a durable completion after restart',
  );
  assert.ok(
    prompts.some((prompt) => prompt.includes(`Return exactly ${marker}.`)),
    'the graph node prompt must be materialized into the real execution lane',
  );
  assert.ok(
    prompts.some((prompt) =>
      prompt.includes('__clementine_context_ref')
      && prompt.includes(exactSeedPath)),
    'the graph node receives an exact run-artifact ref instead of a truncated dependency preview',
  );
  assert.deepEqual(
    visibleToolSurfaces,
    [['workflow_step_result', 'workspace_artifact_query']],
    'the materialized graph node has only its return channel and run-scoped exact-data query',
  );
  assert.ok(
    queryResults.some((result) => result.includes(deepRowMarker)),
    'a row beyond the first page remains queryable after restart',
  );
  assert.ok(
    outsideRunResults.every((result) => /refused.*this run workspace/i.test(result)),
    'the graph query cannot read a path outside its owning run workspace',
  );
  assert.ok(
    orphanResults.every((result) => /refused.*not rendered into the active workflow step context/i.test(result)),
    'the graph query cannot read an orphan artifact that was not bound into this node context',
  );
  assert.equal(terminal.stepOutputs?.restart_probe, marker);
  assert.match(
    terminal.output ?? '',
    new RegExp(marker),
    'the final user-facing output must include the graph-added node',
  );
});

test('an in-process graph node pages an offloaded upstream result without widening its authority', async () => {
  const workflowSlug = 'graph-in-process-context';
  const workflowName = 'Graph In Process Context';
  const runId = 'graph-in-process-context-run';
  const deepRowMarker = 'IN-PROCESS-ROW-150-EXACT';
  const graphMarker = 'IN-PROCESS-GRAPH-NODE-EXECUTED';
  const seedOutput = {
    rows: Array.from({ length: 220 }, (_, index) => ({
      index,
      value: `${'y'.repeat(90)}${index === 150 ? deepRowMarker : ''}`,
    })),
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(seedOutput), 'utf-8') > 8 * 1024,
    'fixture must cross the in-context offload threshold',
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(seedOutput), 'utf-8') < 32 * 1024,
    'fixture isolates same-process offload from event-log compaction',
  );

  const authoredSteps = [{
    id: 'seed',
    prompt: 'Return the complete seed rows through workflow_step_result.',
    sideEffect: 'read' as const,
    useHarness: true,
  }];
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: authoredSteps,
  });
  const patched = applyWorkflowGraphPatch(
    compileWorkflowStepsToGraph(authoredSteps, {
      id: `${workflowSlug}:${runId}`,
      name: workflowName,
    }),
    {
      reason: 'Inspect an exact later row without loading the whole result.',
      operations: [
        {
          op: 'add_node',
          node: {
            id: 'inspect_later_row',
            type: 'step',
            prompt: `Read row 150 and return exactly ${graphMarker}.`,
            sideEffect: 'read',
          },
        },
        {
          op: 'add_edge',
          edge: {
            id: 'dependency:seed->inspect_later_row',
            source: 'seed',
            target: 'inspect_later_row',
            type: 'dependency',
          },
        },
      ],
    },
  );
  assert.equal(patched.ok, true, patched.errors.join('; '));
  persistWorkflowGraphSnapshot({ workflowName: workflowSlug, runId, graph: patched.graph });

  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'running',
    inputs: {},
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  }), 'utf-8');
  appendWorkflowEvent(workflowSlug, runId, { kind: 'run_started' });

  const graphQueries: string[] = [];
  const graphPrompts: string[] = [];
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: {
      input?: string;
      sessionId?: string;
      agent?: {
        tools?: Array<{
          name?: string;
          invoke?: (ctx: unknown, input: string, details?: unknown) => Promise<unknown>;
        }>;
      };
    }) => {
      const tools = request.agent?.tools ?? [];
      const invocationContext = { context: { sessionId: request.sessionId ?? 'graph-test' } };
      if (String(request.sessionId ?? '').endsWith(':seed')) {
        const resultTool = tools.find((toolRef) => toolRef.name === 'workflow_step_result');
        assert.ok(resultTool?.invoke, 'the authored seed can emit its complete structural result');
        await resultTool.invoke(
          invocationContext,
          JSON.stringify({ data: JSON.stringify(seedOutput) }),
          { toolCall: { callId: 'seed-full-result' } },
        );
        return {
          sessionId: request.sessionId,
          status: 'completed',
          steps: 1,
          lastTurn: 1,
          lastDecision: { summary: 'seed rows emitted' },
        };
      }

      graphPrompts.push(String(request.input ?? ''));
      assert.deepEqual(
        tools.map((toolRef) => toolRef.name),
        ['workflow_step_result', 'workspace_artifact_query'],
      );
      const queryTool = tools.find((toolRef) => toolRef.name === 'workspace_artifact_query');
      assert.ok(queryTool?.invoke);
      const seedArtifact = readWorkspaceManifest(workflowSlug, runId)
        .filter((entry) => entry.tool === 'step-output' && entry.agent === 'seed')
        .at(-1);
      assert.ok(seedArtifact);
      const exactPath = path.join(runWorkspaceDir(workflowSlug, runId), seedArtifact.path);
      const queried = await queryTool.invoke(
        invocationContext,
        JSON.stringify({
          path: exactPath,
          json_path: 'rows',
          offset: 150,
          limit: 1,
        }),
        { toolCall: { callId: 'graph-in-process-exact-row' } },
      );
      graphQueries.push(String(queried));
      return {
        sessionId: request.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: graphMarker },
      };
    }) as never,
  });
  const priorHarnessFlag = process.env.WORKFLOW_USE_HARNESS;
  process.env.WORKFLOW_USE_HARNESS = 'on';
  try {
    await processWorkflowRuns({ respond: async () => ({ text: graphMarker }) } as never);
  } finally {
    if (priorHarnessFlag === undefined) delete process.env.WORKFLOW_USE_HARNESS;
    else process.env.WORKFLOW_USE_HARNESS = priorHarnessFlag;
    _setWorkflowHarnessLoopImplsForTests();
  }

  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as {
    status?: string;
    output?: string;
  };
  assert.equal(terminal.status, 'completed');
  assert.ok(
    graphPrompts.some((prompt) => prompt.includes('__clementine_context_ref')),
    'the >8KB same-process dependency is represented by a scoped exact-data ref',
  );
  assert.ok(
    graphQueries.some((result) => result.includes(deepRowMarker)),
    'the graph node can page a row beyond the default first page in the same process',
  );
  assert.match(terminal.output ?? '', new RegExp(graphMarker));
});

test('a graph patch admitted after the scheduler settles prevents stale terminal publication and executes on the next drain', async () => {
  const workflowSlug = 'graph-terminal-race';
  const workflowName = 'Graph Terminal Race';
  const runId = 'graph-terminal-race-run';
  const marker = 'LATE-GRAPH-NODE-EXECUTED';
  const authoredSteps = [{
    id: 'seed',
    prompt: 'Return the seed value.',
    sideEffect: 'read' as const,
  }];

  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: authoredSteps,
  });
  persistWorkflowGraphSnapshot({
    workflowName: workflowSlug,
    runId,
    graph: compileWorkflowStepsToGraph(authoredSteps, {
      id: `${workflowSlug}:${runId}`,
      name: workflowName,
    }),
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'running',
    inputs: {},
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  }), 'utf-8');
  appendWorkflowEvent(workflowSlug, runId, {
    kind: 'run_started',
    meta: { source: 'race-regression' },
  });

  let hookCalls = 0;
  _setBeforeWorkflowGraphFinalizationForTests(async () => {
    hookCalls += 1;
    _setBeforeWorkflowGraphFinalizationForTests(null);
    const reshaped = reshapeWorkflowGraph({
      workflowName: workflowSlug,
      runId,
      patch: {
        reason: 'admitted exactly at the terminal boundary',
        operations: [
          {
            op: 'add_node',
            node: {
              id: 'late_probe',
              type: 'step',
              prompt: `Return exactly ${marker}.`,
              sideEffect: 'read',
            },
          },
          {
            op: 'add_edge',
            edge: {
              id: 'dependency:seed->late_probe',
              source: 'seed',
              target: 'late_probe',
              type: 'dependency',
            },
          },
        ],
      },
    });
    assert.equal(reshaped.ok, true, reshaped.errors.join('; '));
  });

  const legacyPrompts: string[] = [];
  const graphPrompts: string[] = [];
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { input?: string; sessionId?: string }) => {
      graphPrompts.push(String(request.input ?? ''));
      return {
        sessionId: request.sessionId ?? `workflow:${runId}:late_probe`,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: marker },
      };
    }) as never,
  });
  const assistant = {
    respond: async (request: { message?: string; sessionId?: string }) => {
      legacyPrompts.push(String(request.message ?? ''));
      return {
        text: 'seed completed',
        sessionId: request.sessionId ?? `workflow:${runId}:seed`,
      };
    },
  } as never;

  try {
    await processWorkflowRuns(assistant);
    const afterRace = JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string; finishedAt?: string };
    assert.equal(hookCalls, 1);
    assert.equal(afterRace.status, 'running', 'a newer graph generation keeps the run resumable');
    assert.equal(afterRace.finishedAt, undefined, 'stale execution may not publish terminal truth');
    assert.equal(
      readWorkflowEvents(workflowSlug, runId).some((event) => event.kind === 'run_completed'),
      false,
      'no terminal journal event is emitted from the stale generation',
    );

    // This is the same durable path a restarted daemon takes.
    await processWorkflowRuns(assistant);
  } finally {
    _setBeforeWorkflowGraphFinalizationForTests(null);
    _setWorkflowHarnessLoopImplsForTests();
  }

  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as {
    status?: string;
    output?: string;
    stepOutputs?: Record<string, string>;
  };
  const events = readWorkflowEvents(workflowSlug, runId);
  assert.equal(legacyPrompts.length, 1, 'the completed authored step is not repeated');
  assert.ok(graphPrompts.some((prompt) => prompt.includes(marker)));
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.stepOutputs?.late_probe, marker);
  assert.match(terminal.output ?? '', new RegExp(marker));
  assert.ok(events.some((event) =>
    event.kind === 'step_completed'
    && event.stepId === 'late_probe'
    && event.output === marker));
});
