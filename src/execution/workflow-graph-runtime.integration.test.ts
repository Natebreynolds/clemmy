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
process.env.WORKFLOW_USE_HARNESS = 'off';
process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';

const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const {
  materializeWorkflowGraphSteps,
  finalizeStepOutput,
  processWorkflowRuns,
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
} = await import('./workflow-graph.js');
const { persistWorkflowGraphSnapshot } = await import('./workflow-graph-store.js');

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
    orphanResults.every((result) => /refused.*not owned by a completed event/i.test(result)),
    'the graph query cannot read an orphan artifact from the artifact-before-event crash window',
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
