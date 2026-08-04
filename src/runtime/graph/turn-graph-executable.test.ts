/**
 * Run: npx tsx --test src/runtime/graph/turn-graph-executable.test.ts
 *
 * Can the executor drive the CHAT topology, and what would happen if it did?
 *
 * The compiled chat graph is a PATH by design: fan-out is not compiled from an
 * estimated count, because an estimate manufactures work that may not exist.
 * Instead the `fanout` node is a PLANNER under a runtime-topology contract
 * (G5a): at execution it produces the canonical item manifest and emits one
 * identity-bound worker per REAL item as a graph patch joined at the reducer.
 * The tests below prove both halves — the compiled path stays honest, and
 * under the executor a twelve-item manifest becomes twelve real siblings in
 * one scheduling wave.
 *
 * The adapter lives in this test rather than in source: production chat does
 * not execute through the graph yet (G5b), and an adapter with no caller is
 * speculation.
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
    nodes: graph.nodes.map((node) => ({ id: node.id, kind: node.kind, ...(node.joinMode ? { joinMode: node.joinMode } : {}) })),
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

test('the compiled graph never manufactures workers from an estimate', () => {
  // The charter's fan-out rule: an estimated count is diagnostic, never
  // executable shape. Twelve estimated items compile to ZERO worker clones —
  // the planner's contract, not a guess, decides the real count at runtime.
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
  assert.equal(graph.nodes.filter((node) => node.kind === 'execute').length, 0,
    'a worker clone was compiled from an estimated count');
  const fanout = graph.nodes.find((node) => node.kind === 'fanout');
  const reduce = graph.nodes.find((node) => node.kind === 'reduce');
  assert.equal(fanout?.emitsTopology?.kind, 'per_item_siblings');
  assert.equal(fanout?.emitsTopology?.joinNodeId, reduce?.id);
});

test('under the executor, the chat fan-out becomes REAL siblings — the demo-gap shape, closed', async () => {
  // The 2026 client-demo failure shape: "research these N firms" ran as one
  // loop with zero workers. Here the same compiled chat graph, driven by the
  // executor, turns a twelve-item manifest into twelve identity-bound workers
  // in ONE scheduling wave, joined by the compiled reducer, finishing through
  // the compiled verify → compose_reply → publish chain.
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
  const fanout = graph.nodes.find((node) => node.kind === 'fanout')!;
  const contract = fanout.emitsTopology!;
  // The manifest the planner "produced" at runtime. Note: ELEVEN items, not
  // the estimated twelve — the real manifest wins, which is the whole point.
  const manifest = Array.from({ length: 11 }, (_, i) => `firm-${i}`);

  const result = await runGraph(adapt(graph), {
    runner: {
      run: (node) => {
        if (node.id === fanout.id) {
          return {
            status: 'completed',
            emitPatch: {
              nodes: manifest.map((item) => ({ id: `worker:${item}`, kind: 'worker' })),
              edges: [
                ...manifest.map((item) => ({
                  id: `spawn:${item}`, source: fanout.id, target: `worker:${item}`,
                })),
                ...manifest.map((item) => ({
                  id: `join:${item}`, source: `worker:${item}`, target: contract.joinNodeId,
                })),
              ],
            },
          };
        }
        return { status: 'completed' };
      },
      edgeSatisfied: () => true,
    },
    budget: { maxConcurrency: contract.maxConcurrency },
  });

  assert.equal(result.status, 'completed', result.stalledDetail ?? '');
  const workers = result.trace.filter((entry) => entry.kind === 'worker');
  assert.equal(workers.length, 11, 'the manifest did not decide the worker count');
  assert.equal(new Set(workers.map((entry) => entry.wave)).size, 1,
    'workers did not share one scheduling wave');
  const reduceEntry = result.trace.find((entry) => entry.kind === 'reduce')!;
  assert.ok(reduceEntry.wave > workers[0]!.wave, 'the reducer did not wait for the workers');
  const publish = result.trace.find((entry) => entry.kind === 'publish');
  assert.equal(publish?.status, 'completed', 'the turn did not reach its publish terminal');
  assert.equal(result.unreached.length, 0);
});
