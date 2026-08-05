/**
 * Run: npx tsx --test src/runtime/graph/graph-replay-truth.test.ts
 *
 * R1A biting suite: admitted journal and replay truth.
 *
 * The three predecessor reproductions here were executed against f2f34778 and
 * FAIL there (recorded in the R1A handoff): stale dependent reuse after only a
 * nodeDigest check, a temporal-dead-zone crash replaying a journaled patch
 * that joins an existing reducer, and a legitimate `joinMode: 'any'` history
 * refused because closure demanded every structural predecessor. Each test
 * asserts the REQUIRED behavior, so this file is the permanent pin that the
 * replay contract stays true.
 *
 * Journal entries are authored in the v2 shape (exact start/settlement pairs,
 * durable fired-edge verdicts, patch emitter attempts). At the predecessor the
 * extra fields were ignored at runtime, which is exactly why these bite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  admitGraph,
  computeInputDigest,
  computeNodeDigest,
  type AdmittedBudget,
  type GraphAdmission,
} from './graph-admission.js';
import type { GraphJournalEntry } from './graph-journal.js';
import {
  runGraph,
  type ExecutableGraph,
  type ExecutableNode,
  type NodeOutcome,
  type NodeRunner,
} from './graph-executor.js';

const BUDGET: AdmittedBudget = {
  maxNodes: 100, maxWaves: 100, maxConcurrency: 4, maxElapsedMs: 60_000, maxExpansions: 0,
};

function admitted(graph: ExecutableGraph, budget: AdmittedBudget = BUDGET): GraphAdmission {
  const result = admitGraph({
    graph, compilerVersion: 'r1a', policyHash: 'p1', catalogHash: 'k1', budget,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).admission;
}

function memoryAdapter() {
  const entries: GraphJournalEntry[] = [];
  return {
    entries,
    adapter: { async append(entry: GraphJournalEntry): Promise<void> { entries.push(entry); } },
  };
}

/** Author one exact start/settlement pair in the v2 journal shape. */
function settledPair(input: {
  admission: GraphAdmission;
  node: ExecutableNode;
  inputDigest: string;
  attemptId: string;
  wave: number;
  outputRef?: string;
  evidenceRefs?: string[];
  firedEdgeIds: string[];
  status?: 'completed' | 'failed';
  reason?: string;
}): GraphJournalEntry[] {
  const base = {
    admissionDigest: input.admission.admissionDigest,
    nodeId: input.node.id,
    nodeDigest: computeNodeDigest(input.node),
    inputDigest: input.inputDigest,
    attemptId: input.attemptId,
    wave: input.wave,
  };
  return [
    { type: 'node_started', ...base },
    {
      type: 'node_settled',
      ...base,
      status: input.status ?? 'completed',
      ...(input.status === 'failed'
        ? { reason: input.reason ?? 'failed', settlementClass: 'node' as const }
        : { outputRef: input.outputRef, evidenceRefs: input.evidenceRefs }),
      firedEdgeIds: input.firedEdgeIds,
    } as GraphJournalEntry,
  ];
}

// ─── Predecessor defect 1: stale dependent reuse ─────────────────────────────

test('R1A bite 1: a dependent whose journaled input digest names OLD predecessor evidence reruns — nodeDigest alone is never reuse identity', async () => {
  // Admitted chain a -> b. The journal records a completing with art-a-old and
  // b completing with an input digest computed FROM that old reference. The
  // current graph changes a's identity (kind), forcing a to rerun and produce
  // art-a-new. b's journaled completion is now stale evidence.
  const oldA: ExecutableNode = { id: 'a', kind: 'step-v1' };
  const newA: ExecutableNode = { id: 'a', kind: 'step-v2' };
  const b: ExecutableNode = { id: 'b', kind: 'step' };
  const graph: ExecutableGraph = {
    graphId: 'stale-reuse',
    nodes: [newA, b],
    edges: [{ id: 'e-ab', source: 'a', target: 'b' }],
  };
  const admission = admitted(graph);

  const oldARefs = [{ nodeId: 'a', outputRef: 'art-a-old', evidenceRefs: [] as string[] }];
  const journal: GraphJournalEntry[] = [
    ...settledPair({
      admission, node: oldA, inputDigest: computeInputDigest([]),
      attemptId: 'old-a', wave: 0, outputRef: 'art-a-old', firedEdgeIds: ['e-ab'],
    }),
    ...settledPair({
      admission, node: b, inputDigest: computeInputDigest(oldARefs),
      attemptId: 'old-b', wave: 1, outputRef: 'art-b-old', firedEdgeIds: [],
    }),
  ];

  const ran: string[] = [];
  const runner: NodeRunner = {
    run(node): NodeOutcome {
      ran.push(node.id);
      if (node.id === 'a') return { status: 'completed', outputRef: 'art-a-new' };
      return { status: 'completed', outputRef: 'art-b-new' };
    },
  };

  const { adapter } = memoryAdapter();
  const result = await runGraph(graph, {
    runner,
    admission,
    journalAdapter: adapter,
    clock: () => 0,
    resumeEntries: journal,
  });

  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.ok(ran.includes('a'), 'a reruns: its definition changed');
  assert.ok(
    ran.includes('b'),
    'b MUST rerun: its current input digest (art-a-new) does not match its journaled settlement (art-a-old)',
  );
  const bTrace = result.trace.find((entry) => entry.nodeId === 'b');
  assert.equal(bTrace?.reused, undefined, 'b is fresh work, never reused:true on stale evidence');
});

test('R1A bite 1b: when the rerun REPRODUCES the same content-addressed output, the dependent may reuse', async () => {
  // Same shape, but a's identity is unchanged and its journaled completion is
  // trusted — b's current input digest matches its journaled one, so b reuses.
  const a: ExecutableNode = { id: 'a', kind: 'step' };
  const b: ExecutableNode = { id: 'b', kind: 'step' };
  const graph: ExecutableGraph = {
    graphId: 'stable-reuse',
    nodes: [a, b],
    edges: [{ id: 'e-ab', source: 'a', target: 'b' }],
  };
  const admission = admitted(graph);
  const aRefs = [{ nodeId: 'a', outputRef: 'art-a', evidenceRefs: [] as string[] }];
  const journal: GraphJournalEntry[] = [
    ...settledPair({
      admission, node: a, inputDigest: computeInputDigest([]),
      attemptId: 't-a', wave: 0, outputRef: 'art-a', firedEdgeIds: ['e-ab'],
    }),
    ...settledPair({
      admission, node: b, inputDigest: computeInputDigest(aRefs),
      attemptId: 't-b', wave: 1, outputRef: 'art-b', firedEdgeIds: [],
    }),
  ];
  const ran: string[] = [];
  const runner: NodeRunner = {
    run(node): NodeOutcome { ran.push(node.id); return { status: 'completed' }; },
  };
  const { adapter } = memoryAdapter();
  const result = await runGraph(graph, {
    runner, admission, journalAdapter: adapter, clock: () => 0, resumeEntries: journal,
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual(ran, [], 'identical identity and inputs: everything reuses, nothing dispatches');
  assert.equal(result.trace.filter((entry) => entry.reused).length, 2);
});

// ─── Predecessor defect 2: patch replay TDZ crash ────────────────────────────

test('R1A bite 2: a journaled patch that joins an EXISTING reducer replays without a temporal-dead-zone crash, reuses the settled worker, and reruns the interrupted one', async () => {
  // Admitted planner -> reducer. The planner's durable patch added two workers
  // whose join edges target the EXISTING reducer. The crash happened after the
  // patch, planner settlement, and worker-1 settlement, while worker-2 was
  // only started.
  const planner: ExecutableNode = { id: 'planner', kind: 'planner' };
  const reducer: ExecutableNode = { id: 'reducer', kind: 'reduce' };
  const w1: ExecutableNode = { id: 'w1', kind: 'worker' };
  const w2: ExecutableNode = { id: 'w2', kind: 'worker' };
  const patchEdges = [
    { id: 'p-w1', source: 'planner', target: 'w1' },
    { id: 'p-w2', source: 'planner', target: 'w2' },
    { id: 'j-w1', source: 'w1', target: 'reducer' },
    { id: 'j-w2', source: 'w2', target: 'reducer' },
  ];
  const graph: ExecutableGraph = {
    graphId: 'patch-restart',
    nodes: [planner, reducer],
    edges: [],
  };
  const admission = admitted(graph, { ...BUDGET, maxExpansions: 1 });

  // The patch digest must match what validateGraphPatch computes; author the
  // entry through the same canonical shape by replaying the exact content.
  const { validateGraphPatch } = await import('./graph-admission.js');
  const patchContent = { emittedBy: 'planner', nodes: [w1, w2], edges: patchEdges };
  const validated = validateGraphPatch(graph, patchContent);
  assert.equal(validated.ok, true, JSON.stringify(validated));
  const patchDigest = (validated as Extract<typeof validated, { ok: true }>).patchDigest;

  const plannerInput = computeInputDigest([]);
  const w1Input = computeInputDigest([{ nodeId: 'planner', outputRef: 'plan', evidenceRefs: [] }]);
  const journal: GraphJournalEntry[] = [
    { type: 'node_started', admissionDigest: admission.admissionDigest, nodeId: 'planner', nodeDigest: computeNodeDigest(planner), inputDigest: plannerInput, attemptId: 't-planner', wave: 0 },
    {
      type: 'patch_admitted',
      admissionDigest: admission.admissionDigest,
      emittedBy: 'planner',
      emitterAttemptId: 't-planner',
      patchDigest,
      nodes: [w1, w2],
      edges: patchEdges,
    } as GraphJournalEntry,
    {
      type: 'node_settled', admissionDigest: admission.admissionDigest, nodeId: 'planner',
      nodeDigest: computeNodeDigest(planner), inputDigest: plannerInput, attemptId: 't-planner',
      wave: 0, status: 'completed', outputRef: 'plan', firedEdgeIds: ['p-w1', 'p-w2'],
    } as GraphJournalEntry,
    ...settledPair({
      admission, node: w1, inputDigest: w1Input, attemptId: 't-w1', wave: 1,
      outputRef: 'art-w1', firedEdgeIds: ['j-w1'],
    }),
    // w2: interrupted — a durable start with no settlement. Legal history, no reuse.
    { type: 'node_started', admissionDigest: admission.admissionDigest, nodeId: 'w2', nodeDigest: computeNodeDigest(w2), inputDigest: w1Input, attemptId: 't-w2', wave: 1 },
  ];

  const ran: string[] = [];
  const runner: NodeRunner = {
    run(node): NodeOutcome {
      ran.push(node.id);
      if (node.id === 'w2') return { status: 'completed', outputRef: 'art-w2' };
      if (node.id === 'reducer') return { status: 'completed', outputRef: 'reduced' };
      return { status: 'completed', outputRef: 'plan' };
    },
  };
  const { adapter } = memoryAdapter();
  const result = await runGraph(graph, {
    runner,
    admission,
    journalAdapter: adapter,
    clock: () => 0,
    resumeEntries: journal,
    patchAdmitter: () => ({ ok: true }),
  });

  assert.equal(result.status, 'completed', `resume must not crash or refuse: ${result.haltReason ?? ''}`);
  assert.deepEqual([...ran].sort(), ['reducer', 'w2'], 'exactly the interrupted worker and the reducer run');
  assert.equal(ran.filter((id) => id === 'w2').length, 1, 'the interrupted worker reruns exactly once');
  const w1Trace = result.trace.find((entry) => entry.nodeId === 'w1');
  assert.equal(w1Trace?.reused, true, 'the settled worker is reused exactly, at zero dispatch cost');
  assert.equal(result.patches.length, 1, 'the journaled patch is applied exactly once');
});

// ─── Predecessor defect 3: valid any-join history refused ────────────────────

test('R1A bite 3: an unfired conditional alternative into a joinMode:any merge is legitimate history — resume succeeds', async () => {
  // src fires its success route; the failure alternative never starts. The
  // merge is joinMode 'any' and completed via the success route. The journal
  // is complete, honest history.
  const src: ExecutableNode = { id: 'src', kind: 'step' };
  const okRoute: ExecutableNode = { id: 'ok_route', kind: 'step' };
  const failRoute: ExecutableNode = { id: 'fail_route', kind: 'step' };
  const merge: ExecutableNode = { id: 'merge', kind: 'reduce', joinMode: 'any' };
  const graph: ExecutableGraph = {
    graphId: 'any-join',
    nodes: [src, okRoute, failRoute, merge],
    edges: [
      { id: 'e-ok', source: 'src', target: 'ok_route', when: 'success' },
      { id: 'e-fail', source: 'src', target: 'fail_route', when: 'failure' },
      { id: 'e-ok-merge', source: 'ok_route', target: 'merge' },
      { id: 'e-fail-merge', source: 'fail_route', target: 'merge' },
    ],
  };
  const admission = admitted(graph);
  const srcInput = computeInputDigest([]);
  const okInput = computeInputDigest([{ nodeId: 'src', outputRef: 'src-out', evidenceRefs: [] }]);
  const mergeInput = computeInputDigest([{ nodeId: 'ok_route', outputRef: 'ok-out', evidenceRefs: [] }]);
  const journal: GraphJournalEntry[] = [
    ...settledPair({
      admission, node: src, inputDigest: srcInput, attemptId: 't-src', wave: 0,
      outputRef: 'src-out', firedEdgeIds: ['e-ok'],
    }),
    ...settledPair({
      admission, node: okRoute, inputDigest: okInput, attemptId: 't-ok', wave: 1,
      outputRef: 'ok-out', firedEdgeIds: ['e-ok-merge'],
    }),
    ...settledPair({
      admission, node: merge, inputDigest: mergeInput, attemptId: 't-merge', wave: 2,
      outputRef: 'merged', firedEdgeIds: [],
    }),
  ];
  const ran: string[] = [];
  const runner: NodeRunner = {
    run(node): NodeOutcome { ran.push(node.id); return { status: 'completed' }; },
  };
  const { adapter } = memoryAdapter();
  const result = await runGraph(graph, {
    runner, admission, journalAdapter: adapter, clock: () => 0, resumeEntries: journal,
  });

  assert.equal(
    result.status, 'completed',
    `legitimate any-join history must resume, not refuse: ${result.haltReason ?? ''}`,
  );
  assert.deepEqual(ran, [], 'nothing reruns: the fired route is fully settled history');
  assert.equal(result.trace.filter((entry) => entry.reused).length, 3);
  assert.ok(result.unreached.includes('fail_route'), 'the unfired alternative stays unreached by design');
});
