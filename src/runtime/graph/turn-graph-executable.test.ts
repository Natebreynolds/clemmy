/**
 * Run: npx tsx --test src/runtime/graph/turn-graph-executable.test.ts
 *
 * Can the executor drive the CHAT topology, and what would happen if it did?
 *
 * Two answers, and the second one is the point. Every compiled chat graph is
 * structurally drivable — it reaches quiescence with every node visited and no
 * stall. But every one of them is also a strictly linear PATH: the compiler
 * chains each node to its predecessor, so a "fan-out" over twelve items is one
 * `fanout` node carrying a `multiplicity` field, followed by one `execute`
 * node, in sequence.
 *
 * That matters because wiring the executor into chat would not, by itself,
 * make anything run in parallel. The compiler has to emit real topology first.
 * These tests pin the current shape so that change announces itself here
 * instead of being discovered later in a latency measurement.
 *
 * The adapter lives in this test rather than in source: nothing in the running
 * system consumes it yet, and an adapter with no caller is speculation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { compileTurnGraph, type CompileTurnGraphInput } from './turn-graph-compiler.js';
import type { TurnGraphIR, TurnGraphPolicySnapshot } from './turn-graph-ir.js';
import { runGraph, type ExecutableGraph, type NodeRunner } from './graph-executor.js';

const POLICY: TurnGraphPolicySnapshot = {
  version: 'turn-policy-v1',
  autoApproveScope: 'yolo',
  proactiveWorkAllowed: true,
  allowComposioActions: true,
  allowComputerActions: true,
  requireWorkflowApprovalForExecution: true,
  batchConfirmThreshold: 5,
};

function compile(input: string, overrides: Partial<CompileTurnGraphInput> = {}) {
  return compileTurnGraph({
    identity: { sessionId: 'exec-shape', turn: 1, sourceUserSeq: 41 },
    input,
    sessionKind: 'chat',
    surface: 'home',
    policy: POLICY,
    ...overrides,
  });
}

/**
 * Present a compiled turn graph as the executor's structural contract.
 *
 * The IR's edge conditions are richer than `success` — `evidence_sufficient`,
 * `input_available`, `authority_available`. They are carried through verbatim
 * as opaque conditions, which means a runner must supply an opinion for them
 * to fire. That is the correct default: a gate nobody evaluates must not
 * behave like an unconditional edge.
 */
function adapt(graph: TurnGraphIR): ExecutableGraph {
  return {
    graphId: graph.graphId,
    nodes: graph.nodes.map((node) => ({ id: node.id, kind: node.kind })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      when: edge.when,
    })),
  };
}

/** Completes everything and grants every typed condition. */
const PERMISSIVE: NodeRunner = {
  run: () => ({ status: 'completed' }),
  edgeSatisfied: () => true,
};

const SHAPES: Array<[string, () => ReturnType<typeof compile>]> = [
  ['direct_reply', () => compile('hello')],
  ['single_retrieval', () => compile('What is the current status of the Acme account?')],
  ['single_action', () => compile('Email alex@example.com with the update.')],
  ['fanout_action', () => compile('Research these firms.', {
    signals: {
      intent: { intent: 'action', confidence: 0.99, reasons: ['test'] },
      externalEffect: { requested: false, kinds: [] },
      multiItem: {
        isMultiItem: true,
        itemCount: 12,
        itemKind: 'firms',
        sameShapeWork: true,
        explicitParallelRequest: true,
      },
    },
  })],
];

test('every compiled chat shape is structurally drivable', async () => {
  for (const [label, build] of SHAPES) {
    const { graph, validation } = build();
    assert.equal(validation.ok, true, `${label}: ${validation.errors.join('; ')}`);

    const result = await runGraph(adapt(graph), { runner: PERMISSIVE, budget: { maxConcurrency: 8 } });
    assert.equal(result.status, 'completed', `${label} did not reach quiescence: ${result.stalledDetail ?? ''}`);
    assert.deepEqual(result.unreached, [], `${label} left nodes unreachable`);
    assert.deepEqual(result.failed, [], `${label} produced failures`);
    assert.equal(result.completed.length, graph.nodes.length, `${label} did not visit every node`);
  }
});

test('a typed edge condition nobody evaluates holds the turn — it does not open it', async () => {
  // The chat IR uses evidence_sufficient / input_available / authority_available.
  // A runner with no opinion must leave those closed, or a verification gate
  // would silently become a straight-through edge the moment chat is executed.
  const { graph } = compile('What is the current status of the Acme account?');
  const conditional = graph.edges.filter((edge) => edge.when !== 'success');
  assert.ok(conditional.length > 0, 'this shape no longer exercises a typed condition');

  const silent = await runGraph(adapt(graph), { runner: { run: () => ({ status: 'completed' }) } });
  assert.ok(silent.unreached.length > 0, 'an unevaluated gate behaved as unconditional');
  assert.notEqual(silent.completed.length, graph.nodes.length);
});

test('chat topology is a PATH — wiring the executor in would parallelize nothing', async () => {
  // The gap this file exists to record. Every node chains to its predecessor,
  // so each scheduling wave holds exactly one node. Real fan-out requires the
  // COMPILER to emit sibling nodes; the executor already supports them, as the
  // workflow lane's read_parallel_v1 fixtures demonstrate.
  for (const [label, build] of SHAPES) {
    const { graph } = build();
    const result = await runGraph(adapt(graph), { runner: PERMISSIVE, budget: { maxConcurrency: 8 } });

    const perWave = new Map<number, number>();
    for (const entry of result.trace) perWave.set(entry.wave, (perWave.get(entry.wave) ?? 0) + 1);
    const widest = Math.max(...perWave.values());
    assert.equal(widest, 1, `${label} unexpectedly has parallel topology — update this pin, it is good news`);
    assert.equal(result.waves, graph.nodes.length, `${label} is not a strict path`);
  }
});

test('a twelve-item fan-out compiles to ONE execute node, not twelve', async () => {
  // Stated as sharply as possible, because it is the difference between a
  // planned graph and an executed one. The multiplicity is a NUMBER on a node,
  // not a set of nodes, so there is nothing for a scheduler to spread.
  const { graph } = compile('Research these firms.', {
    signals: {
      intent: { intent: 'action', confidence: 0.99, reasons: ['test'] },
      externalEffect: { requested: false, kinds: [] },
      multiItem: {
        isMultiItem: true, itemCount: 12, itemKind: 'firms',
        sameShapeWork: true, explicitParallelRequest: true,
      },
    },
  });

  const fanout = graph.nodes.find((node) => node.kind === 'fanout');
  assert.equal(fanout?.multiplicity?.estimatedItems, 12);
  assert.equal(fanout?.multiplicity?.maxConcurrency, 8);
  assert.equal(graph.nodes.filter((node) => node.kind === 'execute').length, 1,
    'twelve items still compile to a single execute node');

  const result = await runGraph(adapt(graph), { runner: PERMISSIVE, budget: { maxConcurrency: 8 } });
  const executeSteps = result.trace.filter((entry) => entry.kind === 'execute');
  assert.equal(executeSteps.length, 1, 'the executor cannot spread work the compiler did not express');
});
