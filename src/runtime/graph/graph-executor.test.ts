/**
 * Run: npx tsx --test src/runtime/graph/graph-executor.test.ts
 *
 * The acceptance test for the executor is not "it runs a graph" — it is that it
 * schedules IDENTICALLY to the engine it is meant to replace. The differential
 * oracle below drives real compiled workflow graphs through both the executor
 * and `getReadyWorkflowGraphNodes`, and requires the same waves in the same
 * order. Anything else is a behavior change wearing an extraction's clothes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileWorkflowStepsToGraph,
  getReadyWorkflowGraphNodes,
  workflowSubgraphSpecialistNodeId,
  type WorkflowGraphDefinition,
} from '../../execution/workflow-graph.js';
import {
  formatGraphTrace,
  runGraph,
  type ExecutableGraph,
  type GraphTraceEntry,
  type NodeOutcome,
  type NodeRunner,
} from './graph-executor.js';

/**
 * Adapt a compiled workflow graph. Lives in the test, not in source: the
 * executor ships with zero production callers, so nothing in the running
 * system imports it yet.
 *
 * Every edge maps to `success` because the current engine ignores edge type
 * entirely — it requires only that the source completed. Only `dependency`
 * edges are ever compiled today, so this loses nothing.
 */
function adapt(graph: WorkflowGraphDefinition): ExecutableGraph {
  return {
    graphId: `${graph.name ?? 'graph'}:${graph.version ?? 0}`,
    nodes: graph.nodes.map((node) => ({ id: node.id, kind: node.type })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      when: 'success' as const,
      disabled: edge.disabled,
    })),
  };
}

const ALWAYS_COMPLETES: NodeRunner = { run: () => ({ status: 'completed' }) };

/**
 * Group a trace into waves. Order WITHIN a wave is preserved, not sorted — the
 * executor emits graph order, which is what the existing engine returns, so the
 * comparison below is exact rather than set-equality.
 */
function waves(trace: readonly GraphTraceEntry[]): string[][] {
  const byWave = new Map<number, string[]>();
  for (const entry of trace) {
    const bucket = byWave.get(entry.wave) ?? [];
    bucket.push(entry.nodeId);
    byWave.set(entry.wave, bucket);
  }
  return [...byWave.keys()].sort((a, b) => a - b).map((w) => byWave.get(w)!);
}

/** The reference driver: what the existing engine does, expressed minimally. */
function referenceWaves(graph: WorkflowGraphDefinition): string[][] {
  const completed: string[] = [];
  const out: string[][] = [];
  for (;;) {
    const ready = getReadyWorkflowGraphNodes(graph, completed).map((n) => n.id);
    if (ready.length === 0) return out;
    out.push(ready);
    completed.push(...ready);
  }
}

// ── the acceptance criterion ─────────────────────────────────────────────────

test('the executor schedules identically to the engine it replaces', async () => {
  const fixtures: Array<[string, WorkflowGraphDefinition]> = [
    ['linear', compileWorkflowStepsToGraph([
      { id: 'pull', prompt: 'Pull.', sideEffect: 'read' },
      { id: 'shape', prompt: 'Shape.', dependsOn: ['pull'], sideEffect: 'read' },
      { id: 'send', prompt: 'Send.', dependsOn: ['shape'], sideEffect: 'send' },
    ], { name: 'linear', version: 1 })],

    ['diamond', compileWorkflowStepsToGraph([
      { id: 'source', prompt: 'Source.', sideEffect: 'read' },
      { id: 'left', prompt: 'Left.', dependsOn: ['source'], sideEffect: 'read' },
      { id: 'right', prompt: 'Right.', dependsOn: ['source'], sideEffect: 'read' },
      { id: 'join', prompt: 'Join.', dependsOn: ['left', 'right'], sideEffect: 'read' },
    ], { name: 'diamond', version: 1 })],

    ['two independent roots', compileWorkflowStepsToGraph([
      { id: 'alpha', prompt: 'Alpha.', sideEffect: 'read' },
      { id: 'beta', prompt: 'Beta.', sideEffect: 'read' },
      { id: 'merge', prompt: 'Merge.', dependsOn: ['alpha', 'beta'], sideEffect: 'read' },
    ], { name: 'roots', version: 1 })],

    // The shape the whole workflow lane runs on today.
    ['read_parallel_v1', compileWorkflowStepsToGraph([
      { id: 'source', prompt: 'Return source evidence.', sideEffect: 'read' },
      {
        id: 'analyze',
        prompt: 'Reduce the specialist evidence.',
        dependsOn: ['source'],
        sideEffect: 'read',
        subgraph: {
          mode: 'read_parallel_v1',
          specialists: [
            { id: 'facts', prompt: 'Check factual support.' },
            { id: 'risks', prompt: 'Check risks.' },
            { id: 'freshness', prompt: 'Check freshness.' },
          ],
        },
      },
      { id: 'publish', prompt: 'Publish.', dependsOn: ['analyze'], sideEffect: 'write' },
    ], { name: 'read-parallel', version: 1 })],
  ];

  for (const [label, graph] of fixtures) {
    const result = await runGraph(adapt(graph), {
      runner: ALWAYS_COMPLETES,
      budget: { maxConcurrency: 8 },
    });
    assert.equal(result.status, 'completed', `${label}: ${result.stalledDetail ?? ''}`);
    assert.deepEqual(waves(result.trace), referenceWaves(graph),
      `${label}: the executor scheduled a different wave order than the current engine`);
    assert.equal(result.completed.length, graph.nodes.length, `${label}: not every node ran`);
    assert.deepEqual(result.unreached, [], `${label}: nodes were left unreached`);
  }
});

test('the fan-out shape really does fan out — specialists share one wave', async () => {
  const graph = compileWorkflowStepsToGraph([
    { id: 'source', prompt: 'Source.', sideEffect: 'read' },
    {
      id: 'analyze',
      prompt: 'Reduce.',
      dependsOn: ['source'],
      sideEffect: 'read',
      subgraph: {
        mode: 'read_parallel_v1',
        specialists: [{ id: 'facts', prompt: 'Facts.' }, { id: 'risks', prompt: 'Risks.' }],
      },
    },
  ], { name: 'fanout', version: 1 });

  const result = await runGraph(adapt(graph), { runner: ALWAYS_COMPLETES, budget: { maxConcurrency: 4 } });
  const grouped = waves(result.trace);
  assert.deepEqual(grouped[0], ['source']);
  assert.deepEqual(grouped[1], [
    workflowSubgraphSpecialistNodeId('analyze', 'facts'),
    workflowSubgraphSpecialistNodeId('analyze', 'risks'),
  ], 'specialists did not become one parallel wave in declaration order');
  assert.deepEqual(grouped[2], ['analyze'], 'the reducer did not wait for every specialist');
});

// ── restart reuse ────────────────────────────────────────────────────────────

test('a journaled node is reused, never re-dispatched', async () => {
  const graph: ExecutableGraph = {
    graphId: 'reuse',
    nodes: [{ id: 'a', kind: 'step' }, { id: 'b', kind: 'step' }, { id: 'c', kind: 'step' }],
    edges: [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ],
  };
  const dispatched: string[] = [];
  const result = await runGraph(graph, {
    runner: { run: (node) => { dispatched.push(node.id); return { status: 'completed' }; } },
    journal: ['a', 'b'],
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(dispatched, ['c'], 'a journaled node was executed again');
  assert.deepEqual(result.completed.sort(), ['a', 'b', 'c']);
  const reused = result.trace.filter((entry) => entry.reused).map((entry) => entry.nodeId);
  assert.deepEqual(reused, ['a', 'b'], 'reuse was not recorded in the trace');
});

test('a pause halts the run and the resume completes it without redoing work', async () => {
  const graph: ExecutableGraph = {
    graphId: 'pause',
    nodes: [{ id: 'gather', kind: 'step' }, { id: 'approve', kind: 'approval' }, { id: 'send', kind: 'step' }],
    edges: [
      { id: 'e1', source: 'gather', target: 'approve' },
      { id: 'e2', source: 'approve', target: 'send' },
    ],
  };

  const firstDispatch: string[] = [];
  const first = await runGraph(graph, {
    runner: {
      run: (node) => {
        firstDispatch.push(node.id);
        return node.id === 'approve'
          ? { status: 'paused', reason: 'awaiting approval' }
          : { status: 'completed' };
      },
    },
  });
  assert.equal(first.status, 'paused');
  assert.deepEqual(first.paused, ['approve']);
  assert.deepEqual(firstDispatch, ['gather', 'approve'], 'the run continued past a pause');
  assert.equal(first.completed.includes('send'), false, 'work past the pause was performed');

  // Resume: approval granted, so the journal now contains it.
  const secondDispatch: string[] = [];
  const second = await runGraph(graph, {
    runner: { run: (node) => { secondDispatch.push(node.id); return { status: 'completed' }; } },
    journal: ['gather', 'approve'],
  });
  assert.equal(second.status, 'completed');
  assert.deepEqual(secondDispatch, ['send'], 'resume re-ran work the journal already had');
});

// ── failure is an edge ───────────────────────────────────────────────────────

test('a failed node routes along its failure edge', async () => {
  const graph: ExecutableGraph = {
    graphId: 'recover',
    nodes: [
      { id: 'attempt', kind: 'step' },
      { id: 'recover', kind: 'step' },
      { id: 'proceed', kind: 'step' },
    ],
    edges: [
      { id: 'ok', source: 'attempt', target: 'proceed', when: 'success' },
      { id: 'bad', source: 'attempt', target: 'recover', when: 'failure' },
    ],
  };
  const result = await runGraph(graph, {
    runner: {
      run: (node) => (node.id === 'attempt'
        ? { status: 'failed', reason: 'provider 500' }
        : { status: 'completed' }),
    },
  });

  assert.deepEqual(result.failed, ['attempt']);
  assert.deepEqual(result.completed, ['recover'], 'the recovery branch did not run');
  assert.deepEqual(result.unreached, ['proceed'], 'the success branch ran despite a failure');
  // A branch that legitimately did not fire is not a stall.
  assert.equal(result.status, 'completed');
});

test('a failure with no failure edge leaves the branch unreached, not stalled', async () => {
  const graph: ExecutableGraph = {
    graphId: 'dead-end',
    nodes: [{ id: 'attempt', kind: 'step' }, { id: 'next', kind: 'step' }],
    edges: [{ id: 'e1', source: 'attempt', target: 'next' }],
  };
  const result = await runGraph(graph, {
    runner: { run: () => ({ status: 'failed', reason: 'nope' }) },
  });
  assert.equal(result.status, 'completed', 'a settled failure was reported as a structural stall');
  assert.deepEqual(result.unreached, ['next']);
  assert.equal(result.stalledDetail, undefined);
});

test('a blocked node never routes, even along a failure edge', async () => {
  // Blocked means "could not run at all" — missing authority is not a result,
  // so it must not drive recovery topology as though the work was attempted.
  const graph: ExecutableGraph = {
    graphId: 'blocked',
    nodes: [{ id: 'write', kind: 'step' }, { id: 'recover', kind: 'step' }],
    edges: [{ id: 'bad', source: 'write', target: 'recover', when: 'failure' }],
  };
  const result = await runGraph(graph, {
    runner: { run: () => ({ status: 'blocked', reason: 'no authority' }) },
  });
  assert.deepEqual(result.blocked, ['write']);
  assert.deepEqual(result.unreached, ['recover']);
});

// ── the harness is never the ceiling ─────────────────────────────────────────

test('an unknown node kind runs — the executor does not enumerate capability', async () => {
  // If adding a capability required editing the executor, the harness would be
  // the ceiling. Kinds are opaque strings; only the runner interprets them.
  const graph: ExecutableGraph = {
    graphId: 'novel',
    nodes: [
      { id: 'n1', kind: 'a_kind_invented_after_this_file_was_written' },
      { id: 'n2', kind: 'another_one' },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  };
  const seen: string[] = [];
  const result = await runGraph(graph, {
    runner: { run: (node) => { seen.push(node.kind); return { status: 'completed' }; } },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(seen, ['a_kind_invented_after_this_file_was_written', 'another_one']);
});

test('an opaque edge condition fails closed', async () => {
  const graph: ExecutableGraph = {
    graphId: 'opaque',
    nodes: [{ id: 'a', kind: 'step' }, { id: 'b', kind: 'step' }],
    edges: [{ id: 'e1', source: 'a', target: 'b', when: 'evidence_sufficient' }],
  };

  // No runner opinion → the edge must not fire. A condition nobody can evaluate
  // behaving like an unconditional edge is how a gate silently disappears.
  const closed = await runGraph(graph, { runner: ALWAYS_COMPLETES });
  assert.deepEqual(closed.unreached, ['b'], 'an unevaluated condition behaved as unconditional');

  // With an opinion, it fires.
  const open = await runGraph(graph, {
    runner: { ...ALWAYS_COMPLETES, edgeSatisfied: (edge) => edge.when === 'evidence_sufficient' },
  });
  assert.deepEqual(open.completed.sort(), ['a', 'b']);
});

// ── stalls, budgets, determinism ─────────────────────────────────────────────

test('a graph that cannot progress stalls with what it is waiting on', async () => {
  const graph: ExecutableGraph = {
    graphId: 'cycle',
    nodes: [{ id: 'a', kind: 'step' }, { id: 'b', kind: 'step' }],
    edges: [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'a' },
    ],
  };
  const result = await runGraph(graph, { runner: ALWAYS_COMPLETES });
  assert.equal(result.status, 'stalled', 'a cycle spun or threw instead of stalling');
  assert.match(result.stalledDetail ?? '', /a waits for b/);
  assert.match(result.stalledDetail ?? '', /b waits for a/);
});

test('disabling the last route into a node removes it rather than promoting it', async () => {
  const graph: ExecutableGraph = {
    graphId: 'disabled',
    nodes: [{ id: 'a', kind: 'step' }, { id: 'b', kind: 'step' }],
    edges: [{ id: 'e1', source: 'a', target: 'b', disabled: true }],
  };
  const result = await runGraph(graph, { runner: ALWAYS_COMPLETES });
  assert.deepEqual(result.completed, ['a']);
  assert.deepEqual(result.unreached, ['b'], 'a node whose only route was disabled became a root');
});

test('a budget ceiling halts a runaway graph', async () => {
  const nodes = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, kind: 'step' }));
  const edges = nodes.slice(1).map((node, i) => ({
    id: `e${i}`, source: `n${i}`, target: node.id,
  }));
  const result = await runGraph({ graphId: 'long', nodes, edges }, {
    runner: ALWAYS_COMPLETES,
    budget: { maxNodes: 4 },
  });
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.completed.length, 4, 'the ceiling did not bound dispatch');
});

test('concurrency never reorders a trace', async () => {
  const graph = compileWorkflowStepsToGraph([
    { id: 'source', prompt: 'Source.', sideEffect: 'read' },
    { id: 'zulu', prompt: 'Z.', dependsOn: ['source'], sideEffect: 'read' },
    { id: 'alpha', prompt: 'A.', dependsOn: ['source'], sideEffect: 'read' },
    { id: 'mike', prompt: 'M.', dependsOn: ['source'], sideEffect: 'read' },
    { id: 'join', prompt: 'J.', dependsOn: ['zulu', 'alpha', 'mike'], sideEffect: 'read' },
  ], { name: 'order', version: 1 });

  // Resolve in deliberately scrambled wall-clock order.
  const jittered: NodeRunner = {
    run: async (node): Promise<NodeOutcome> => {
      await new Promise((resolve) => setTimeout(resolve, node.id === 'alpha' ? 12 : 1));
      return { status: 'completed' };
    },
  };

  const serial = await runGraph(adapt(graph), { runner: ALWAYS_COMPLETES });
  const parallel = await runGraph(adapt(graph), { runner: jittered, budget: { maxConcurrency: 8 } });
  assert.equal(formatGraphTrace(parallel.trace), formatGraphTrace(serial.trace),
    'completion order leaked into the trace');
});

test('the same graph and verdicts always produce the same trace', async () => {
  const graph = compileWorkflowStepsToGraph([
    { id: 'a', prompt: 'A.', sideEffect: 'read' },
    { id: 'b', prompt: 'B.', dependsOn: ['a'], sideEffect: 'read' },
    { id: 'c', prompt: 'C.', dependsOn: ['a'], sideEffect: 'read' },
  ], { name: 'stable', version: 1 });

  const first = formatGraphTrace((await runGraph(adapt(graph), { runner: ALWAYS_COMPLETES })).trace);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(
      formatGraphTrace((await runGraph(adapt(graph), { runner: ALWAYS_COMPLETES })).trace),
      first,
    );
  }
});

test('every step is reported as it happens, for durable event writing', async () => {
  const graph = compileWorkflowStepsToGraph([
    { id: 'a', prompt: 'A.', sideEffect: 'read' },
    { id: 'b', prompt: 'B.', dependsOn: ['a'], sideEffect: 'read' },
  ], { name: 'stream', version: 1 });

  const streamed: string[] = [];
  const result = await runGraph(adapt(graph), {
    runner: ALWAYS_COMPLETES,
    onStep: (entry) => streamed.push(entry.nodeId),
  });
  assert.deepEqual(streamed, result.trace.map((entry) => entry.nodeId));
  assert.deepEqual(streamed, ['a', 'b']);
});

// ── the executor stays a scheduler ───────────────────────────────────────────

test('the executor imports only its pure siblings and reaches nowhere', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, 'graph-executor.ts'), 'utf-8');

  // The identity and journal CONTRACTS are pure same-directory modules (crypto
  // digests and validation only — their own tests pin that). Anything else —
  // providers, tools, memory, filesystem, environment, UI — belongs in nodes
  // and adapters, and its appearance here is the executor becoming a runtime.
  assert.deepEqual(
    [...source.matchAll(/^import (?!type ).*?from '([^']+)';$/gms)].map((m) => m[1]).sort(),
    ['./graph-admission.js', './graph-journal.js'],
    'the executor grew a dependency — policy, capability and effects belong in nodes',
  );
  for (const forbidden of ['process.env', 'readFileSync', 'Date.now', 'new Date', 'BASE_DIR', 'fetch(', 'Math.random']) {
    assert.equal(source.includes(forbidden), false, `executor references ${forbidden}`);
  }

  // The ceiling from the plan: if this file has absorbed something that belongs
  // in a node, it will show up here first.
  const lines = source.split('\n').length;
  assert.ok(lines < 800, `the executor is ${lines} lines; it is becoming a runtime`);
});

test('an ANY-join fires on the first satisfied route; the rendezvous default is untouched', async () => {
  // The branch-merge primitive (Clem 4, verify phase 1a): two verdict routes
  // converge on one publish node, exactly one fires per run. Explicit opt-in
  // per node — the default remains the workflow engine's rendezvous, so the
  // differential oracle above keeps holding without modification.
  const graph: ExecutableGraph = {
    graphId: 'branch-merge',
    nodes: [
      { id: 'verify', kind: 'verify' },
      { id: 'ok', kind: 'compose' },
      { id: 'blocked', kind: 'compose' },
      { id: 'publish', kind: 'publish', joinMode: 'any' },
      { id: 'rendezvous', kind: 'join' }, // default all — for contrast
    ],
    edges: [
      { id: 'e1', source: 'verify', target: 'ok', when: 'evidence_sufficient' },
      { id: 'e2', source: 'verify', target: 'blocked', when: 'evidence_insufficient' },
      { id: 'e3', source: 'ok', target: 'publish' },
      { id: 'e4', source: 'blocked', target: 'publish' },
      { id: 'e5', source: 'ok', target: 'rendezvous' },
      { id: 'e6', source: 'blocked', target: 'rendezvous' },
    ],
  };
  const delivered = await runGraph(graph, {
    runner: {
      run: () => ({ status: 'completed' }),
      edgeSatisfied: (edge) => edge.when === 'evidence_sufficient',
    },
  });
  assert.deepEqual(delivered.completed.sort(), ['ok', 'publish', 'verify'],
    'the any-join did not fire from a single route');
  assert.ok(delivered.unreached.includes('blocked'), 'the unfired route ran anyway');
  assert.ok(delivered.unreached.includes('rendezvous'),
    'a DEFAULT join fired on one of two routes — the rendezvous semantics broke');
  // Exactly one publish settlement — the merge cannot double-fire.
  assert.equal(delivered.trace.filter((t) => t.nodeId === 'publish').length, 1);

  const blockedRoute = await runGraph(graph, {
    runner: {
      run: () => ({ status: 'completed' }),
      edgeSatisfied: (edge) => edge.when === 'evidence_insufficient',
    },
  });
  assert.deepEqual(blockedRoute.completed.sort(), ['blocked', 'publish', 'verify'],
    'the blocked route did not reach the shared publish node');
});
