/**
 * Run: npx tsx --test src/runtime/graph/graph-replay-truth.test.ts
 *
 * R1A biting suite: admitted journal and replay truth.
 *
 * The original three reproductions were executed against f2f34778 and FAILED
 * there: stale dependent reuse after only a nodeDigest check, a temporal-dead-
 * zone crash replaying a journaled patch that joined an existing reducer, and
 * a legitimate `joinMode: 'any'` history refused because closure demanded
 * every structural predecessor. Each test asserts the REQUIRED behavior, so
 * this file is the permanent pin that the replay contract stays true.
 *
 * The Stage A closeout (graph-replay-closeout.test.ts) hardened identity so
 * far that the original forcing device — changing a node's definition under
 * the same admission — is now IMPOSSIBLE HISTORY (A1 binds the runtime graph
 * to the admission; A7 binds every journaled digest to the admitted
 * definition). The stale-evidence scenarios here therefore use the shape that
 * remains legal: an interrupted sibling whose rerun feeds an any-join, so a
 * dependent's journaled inputs genuinely diverge from what this run's
 * predecessors produce.
 *
 * Beyond the reproductions, this file carries the executor-level R1A suites:
 * A (dependency-cone reuse decided independently per descendant), B (patch
 * restart and the patch-before-emitter-settlement crash window), C (durably
 * fired conditional routes, both directions), D (opaque edge verdicts are
 * history — a changed closure cannot rewrite them). The pure refusal matrix
 * (suite E) lives in graph-resume.test.ts; A1–A7 in the closeout suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  admitGraph,
  computeInputDigest,
  computeNodeDigest,
  validateGraphPatch,
  type AdmittedBudget,
  type GraphAdmission,
} from './graph-admission.js';
import type { GraphJournalEntry, NodeSettledEntry } from './graph-journal.js';
import {
  runGraph,
  type ExecutableEdge,
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

/** A6: admitted attempt identity is injected, never the default counter. */
function attempts(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

/** Author one exact start/settlement pair in the current journal shape. */
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
  emittedPatchDigest?: string;
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
      ...(input.emittedPatchDigest ? { emittedPatchDigest: input.emittedPatchDigest } : {}),
      firedEdgeIds: input.firedEdgeIds,
    } as GraphJournalEntry,
  ];
}

// ─── Bite 1: stale dependent reuse ───────────────────────────────────────────

/**
 * a and b are roots into an any-join m. Historically b was only STARTED
 * (interrupted), so m completed with inputs from a alone. On resume b's rerun
 * settles before m is scheduled — m's journaled input digest names history
 * that no longer matches this run's fired predecessors.
 */
function staleFixture() {
  const a: ExecutableNode = { id: 'a', kind: 'step' };
  const b: ExecutableNode = { id: 'b', kind: 'step' };
  const m: ExecutableNode = { id: 'm', kind: 'reduce', joinMode: 'any' };
  const graph: ExecutableGraph = {
    graphId: 'stale-reuse',
    nodes: [a, b, m],
    edges: [
      { id: 'e-am', source: 'a', target: 'm' },
      { id: 'e-bm', source: 'b', target: 'm' },
    ],
  };
  const admission = admitted(graph);
  const journal: GraphJournalEntry[] = [
    ...settledPair({
      admission, node: a, inputDigest: computeInputDigest([]),
      attemptId: 'old-a', wave: 0, outputRef: 'art-a', firedEdgeIds: ['e-am'],
    }),
    {
      type: 'node_started', admissionDigest: admission.admissionDigest, nodeId: 'b',
      nodeDigest: computeNodeDigest(b), inputDigest: computeInputDigest([]),
      attemptId: 'old-b', wave: 0,
    },
    ...settledPair({
      admission, node: m,
      inputDigest: computeInputDigest([{ nodeId: 'a', outputRef: 'art-a', evidenceRefs: [] }]),
      attemptId: 'old-m', wave: 1, outputRef: 'art-m', firedEdgeIds: [],
    }),
  ];
  return { graph, admission, journal };
}

test('R1A bite 1: a dependent whose journaled input digest names OLD predecessor evidence reruns — trusted history is never blind reuse', async () => {
  const { graph, admission, journal } = staleFixture();
  const ran: string[] = [];
  const runner: NodeRunner = {
    run(node): NodeOutcome {
      ran.push(node.id);
      return { status: 'completed', outputRef: `art-${node.id}-new` };
    },
  };
  const { adapter } = memoryAdapter();
  const result = await runGraph(graph, {
    runner, admission, journalAdapter: adapter, clock: () => 0,
    resumeEntries: journal, attemptIds: attempts('r'),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual(ran, ['b', 'm'],
    'm MUST rerun: its current fired predecessors include b, which its journaled settlement never saw');
  const mTrace = result.trace.find((entry) => entry.nodeId === 'm');
  assert.equal(mTrace?.reused, undefined, 'm is fresh work, never reused:true on stale evidence');
  assert.equal(result.trace.find((entry) => entry.nodeId === 'a')?.reused, true,
    'a reuses exactly: its identity and inputs are unchanged');
});

test('R1A bite 1b: identical identity and inputs reuse everything at zero dispatch cost', async () => {
  const a: ExecutableNode = { id: 'a', kind: 'step' };
  const b: ExecutableNode = { id: 'b', kind: 'step' };
  const graph: ExecutableGraph = {
    graphId: 'stable-reuse',
    nodes: [a, b],
    edges: [{ id: 'e-ab', source: 'a', target: 'b' }],
  };
  const admission = admitted(graph);
  const journal: GraphJournalEntry[] = [
    ...settledPair({
      admission, node: a, inputDigest: computeInputDigest([]),
      attemptId: 't-a', wave: 0, outputRef: 'art-a', firedEdgeIds: ['e-ab'],
    }),
    ...settledPair({
      admission, node: b,
      inputDigest: computeInputDigest([{ nodeId: 'a', outputRef: 'art-a', evidenceRefs: [] }]),
      attemptId: 't-b', wave: 1, outputRef: 'art-b', firedEdgeIds: [],
    }),
  ];
  const ran: string[] = [];
  const runner: NodeRunner = {
    run(node): NodeOutcome { ran.push(node.id); return { status: 'completed' }; },
  };
  const { adapter } = memoryAdapter();
  const result = await runGraph(graph, {
    runner, admission, journalAdapter: adapter, clock: () => 0,
    resumeEntries: journal, attemptIds: attempts('r'),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual(ran, [], 'identical identity and inputs: everything reuses, nothing dispatches');
  assert.equal(result.trace.filter((entry) => entry.reused).length, 2);
});

// ─── Bite 2: patch replay across a crash ─────────────────────────────────────

test('R1A bite 2: a journaled patch that joins an EXISTING reducer replays without a temporal-dead-zone crash, reuses the settled worker, and reruns the interrupted one', async () => {
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
      emittedPatchDigest: patchDigest,
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
    attemptIds: attempts('live'),
  });

  assert.equal(result.status, 'completed', `resume must not crash or refuse: ${result.haltReason ?? ''}`);
  assert.deepEqual([...ran].sort(), ['reducer', 'w2'], 'exactly the interrupted worker and the reducer run');
  assert.equal(ran.filter((id) => id === 'w2').length, 1, 'the interrupted worker reruns exactly once');
  const w1Trace = result.trace.find((entry) => entry.nodeId === 'w1');
  assert.equal(w1Trace?.reused, true, 'the settled worker is reused exactly, at zero dispatch cost');
  assert.equal(result.patches.length, 1, 'the journaled patch is applied exactly once');
});

// ─── Bite 3: valid any-join history resumes ──────────────────────────────────

function forkGraph(): ExecutableGraph {
  return {
    graphId: 'any-join',
    nodes: [
      { id: 'src', kind: 'step' },
      { id: 'ok_route', kind: 'step' },
      { id: 'fail_route', kind: 'step' },
      { id: 'merge', kind: 'reduce', joinMode: 'any' },
    ],
    edges: [
      { id: 'e-ok', source: 'src', target: 'ok_route', when: 'success' },
      { id: 'e-fail', source: 'src', target: 'fail_route', when: 'failure' },
      { id: 'e-ok-merge', source: 'ok_route', target: 'merge' },
      { id: 'e-fail-merge', source: 'fail_route', target: 'merge' },
    ],
  };
}

test('R1A bite 3: an unfired conditional alternative into a joinMode:any merge is legitimate history — resume succeeds', async () => {
  const graph = forkGraph();
  const admission = admitted(graph);
  const journal: GraphJournalEntry[] = [
    ...settledPair({
      admission, node: graph.nodes[0]!, inputDigest: computeInputDigest([]), attemptId: 't-src',
      wave: 0, outputRef: 'src-out', firedEdgeIds: ['e-ok'],
    }),
    ...settledPair({
      admission, node: graph.nodes[1]!,
      inputDigest: computeInputDigest([{ nodeId: 'src', outputRef: 'src-out', evidenceRefs: [] }]),
      attemptId: 't-ok', wave: 1, outputRef: 'ok-out', firedEdgeIds: ['e-ok-merge'],
    }),
    ...settledPair({
      admission, node: graph.nodes[3]!,
      inputDigest: computeInputDigest([{ nodeId: 'ok_route', outputRef: 'ok-out', evidenceRefs: [] }]),
      attemptId: 't-merge', wave: 2, outputRef: 'merged', firedEdgeIds: [],
    }),
  ];
  const ran: string[] = [];
  const runner: NodeRunner = {
    run(node): NodeOutcome { ran.push(node.id); return { status: 'completed' }; },
  };
  const { adapter } = memoryAdapter();
  const result = await runGraph(graph, {
    runner, admission, journalAdapter: adapter, clock: () => 0,
    resumeEntries: journal, attemptIds: attempts('r'),
  });

  assert.equal(
    result.status, 'completed',
    `legitimate any-join history must resume, not refuse: ${result.haltReason ?? ''}`,
  );
  assert.deepEqual(ran, [], 'nothing reruns: the fired route is fully settled history');
  assert.equal(result.trace.filter((entry) => entry.reused).length, 3);
  assert.ok(result.unreached.includes('fail_route'), 'the unfired alternative stays unreached by design');
});

// ─── Suite A: dependency-cone reuse ──────────────────────────────────────────

/**
 * Roots a and b feed an any-join m, which feeds t. Historically b was only
 * started, so m and t settled on evidence from a alone. On resume b's rerun
 * changes m's inputs, m reruns — and whether t reuses depends ONLY on what m
 * actually produces this time: descendants are decided independently.
 */
function coneFixture() {
  const a: ExecutableNode = { id: 'a', kind: 'step' };
  const b: ExecutableNode = { id: 'b', kind: 'step' };
  const m: ExecutableNode = { id: 'm', kind: 'reduce', joinMode: 'any' };
  const t: ExecutableNode = { id: 't', kind: 'step' };
  const graph: ExecutableGraph = {
    graphId: 'cone',
    nodes: [a, b, m, t],
    edges: [
      { id: 'e-am', source: 'a', target: 'm' },
      { id: 'e-bm', source: 'b', target: 'm' },
      { id: 'e-mt', source: 'm', target: 't' },
    ],
  };
  const admission = admitted(graph);
  const journal: GraphJournalEntry[] = [
    ...settledPair({
      admission, node: a, inputDigest: computeInputDigest([]),
      attemptId: 'old-a', wave: 0, outputRef: 'art-a', firedEdgeIds: ['e-am'],
    }),
    {
      type: 'node_started', admissionDigest: admission.admissionDigest, nodeId: 'b',
      nodeDigest: computeNodeDigest(b), inputDigest: computeInputDigest([]),
      attemptId: 'old-b', wave: 0,
    },
    ...settledPair({
      admission, node: m,
      inputDigest: computeInputDigest([{ nodeId: 'a', outputRef: 'art-a', evidenceRefs: [] }]),
      attemptId: 'old-m', wave: 1, outputRef: 'art-m', firedEdgeIds: ['e-mt'],
    }),
    ...settledPair({
      admission, node: t,
      inputDigest: computeInputDigest([{ nodeId: 'm', outputRef: 'art-m', evidenceRefs: [] }]),
      attemptId: 'old-t', wave: 2, outputRef: 'art-t', firedEdgeIds: [],
    }),
  ];
  return { graph, admission, journal };
}

async function runCone(mOutput: string) {
  const { graph, admission, journal } = coneFixture();
  const ran: string[] = [];
  const runner: NodeRunner = {
    run(node): NodeOutcome {
      ran.push(node.id);
      if (node.id === 'b') return { status: 'completed', outputRef: 'art-b' };
      if (node.id === 'm') return { status: 'completed', outputRef: mOutput };
      return { status: 'completed', outputRef: 'art-t-new' };
    },
  };
  const { adapter } = memoryAdapter();
  const result = await runGraph(graph, {
    runner, admission, journalAdapter: adapter, clock: () => 0,
    resumeEntries: journal, attemptIds: attempts('r'),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  return { ran, result };
}

test('A: a rerun that REPRODUCES the same content-addressed output lets the next descendant reuse', async () => {
  const { ran, result } = await runCone('art-m');
  assert.deepEqual(ran, ['b', 'm'], 't was dispatched despite an identical current input digest');
  assert.equal(result.trace.find((entry) => entry.nodeId === 't')?.reused, true);
});

test('A: a rerun that changes the output invalidates the next descendant too', async () => {
  const { ran, result } = await runCone('art-m-changed');
  assert.deepEqual(ran, ['b', 'm', 't'], 't reused stale evidence after its predecessor changed output');
  assert.equal(result.trace.find((entry) => entry.nodeId === 't')?.reused, undefined);
});

test('A: the reuse refusal is visible on the trace in digests only — never payload bytes', async () => {
  const { result } = await runCone('art-m-changed');
  const mTrace = result.trace.find((entry) => entry.nodeId === 'm');
  assert.match(mTrace?.reuseRefused ?? '', /input digest [0-9a-f]{12}… does not match journaled [0-9a-f]{12}…/);
  assert.equal((mTrace?.reuseRefused ?? '').includes('art-'), false, 'artifact refs leaked into diagnostics');
});

// ─── Suite B5: the patch-before-emitter-settlement crash window ──────────────

function orphanFixture() {
  const planner: ExecutableNode = { id: 'planner', kind: 'planner' };
  const reducer: ExecutableNode = { id: 'reducer', kind: 'reduce' };
  const w1: ExecutableNode = { id: 'w1', kind: 'worker' };
  const patchEdges = [
    { id: 'p-w1', source: 'planner', target: 'w1' },
    { id: 'j-w1', source: 'w1', target: 'reducer' },
  ];
  const graph: ExecutableGraph = {
    graphId: 'orphan-window',
    nodes: [planner, reducer],
    edges: [{ id: 'e-pr', source: 'planner', target: 'reducer' }],
  };
  const admission = admitted(graph, { ...BUDGET, maxExpansions: 1 });
  return { graph, admission, planner, w1, patchEdges };
}

async function runOrphanResume(reEmit: { nodes: ExecutableNode[]; edges: ExecutableEdge[] }) {
  const { graph, admission, planner, w1, patchEdges } = orphanFixture();
  const validated = validateGraphPatch(graph, { emittedBy: 'planner', nodes: [w1], edges: patchEdges });
  assert.equal(validated.ok, true, JSON.stringify(validated));
  const patchDigest = (validated as Extract<typeof validated, { ok: true }>).patchDigest;

  // The crash window: the patch is durable, the emitter settlement is not.
  const journal: GraphJournalEntry[] = [
    {
      type: 'node_started', admissionDigest: admission.admissionDigest, nodeId: 'planner',
      nodeDigest: computeNodeDigest(planner), inputDigest: computeInputDigest([]),
      attemptId: 't-planner-1', wave: 0,
    },
    {
      type: 'patch_admitted', admissionDigest: admission.admissionDigest,
      emittedBy: 'planner', emitterAttemptId: 't-planner-1', patchDigest,
      nodes: [w1], edges: patchEdges,
    } as GraphJournalEntry,
  ];

  const ran: string[] = [];
  const runner: NodeRunner = {
    run(node): NodeOutcome {
      ran.push(node.id);
      if (node.id === 'planner') return { status: 'completed', outputRef: 'plan', emitPatch: reEmit };
      return { status: 'completed', outputRef: `art-${node.id}` };
    },
  };
  const { adapter, entries } = memoryAdapter();
  const result = await runGraph(graph, {
    runner, admission, journalAdapter: adapter, clock: () => 0, resumeEntries: journal,
    patchAdmitter: () => ({ ok: true }),
    attemptIds: attempts('live'),
  });
  return { ran, result, entries, patchDigest };
}

test('B5: an orphan patch makes no child eligible; the re-run emitter reproducing it replays without journaling twice', async () => {
  const fixture = orphanFixture();
  const { ran, result, entries, patchDigest } = await runOrphanResume({
    nodes: [fixture.w1], edges: fixture.patchEdges,
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  // The planner ran FIRST — no worker existed before its re-emission.
  assert.deepEqual(ran, ['planner', 'w1', 'reducer']);
  assert.deepEqual(result.patches, [patchDigest], 'the reproduced patch applies exactly once');
  assert.equal(
    entries.filter((entry) => entry.type === 'patch_admitted').length, 0,
    'a re-emission of a journaled patch was journaled again — the digest would appear twice on the next resume',
  );
  const settledPlanner = entries.find(
    (entry): entry is NodeSettledEntry => entry.type === 'node_settled' && entry.nodeId === 'planner',
  );
  assert.equal(settledPlanner?.emittedPatchDigest, patchDigest,
    'the reconciling settlement must prove the digest for the next restart');
});

test('B5: a re-run emitter that emits a DIFFERENT patch fails as node logic — never two child graphs', async () => {
  const { ran, result } = await runOrphanResume({
    nodes: [{ id: 'w-other', kind: 'worker' }],
    edges: [{ id: 'p-other', source: 'planner', target: 'w-other' }],
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual(result.failed, ['planner']);
  const plannerTrace = result.trace.find((entry) => entry.nodeId === 'planner');
  assert.match(plannerTrace?.reason ?? '', /must reproduce it exactly/);
  assert.deepEqual(ran, ['planner'], 'children ran from a refused divergent emission');
  assert.ok(result.unreached.includes('reducer'), 'the reducer advanced without its planner');
});

// ─── Suite C3: the failure route mirror ──────────────────────────────────────

test('C: a durably fired FAILURE route replays exactly — the failed node is reused as failed, the recovery route reuses, the success alternative stays unreached', async () => {
  const graph = forkGraph();
  const admission = admitted(graph);
  const journal: GraphJournalEntry[] = [
    ...settledPair({
      admission, node: graph.nodes[0]!, inputDigest: computeInputDigest([]), attemptId: 't-src',
      wave: 0, status: 'failed', reason: 'provider refused the request', firedEdgeIds: ['e-fail'],
    }),
    ...settledPair({
      admission, node: graph.nodes[2]!, inputDigest: computeInputDigest([]), attemptId: 't-fr',
      wave: 1, outputRef: 'recovered', firedEdgeIds: ['e-fail-merge'],
    }),
    ...settledPair({
      admission, node: graph.nodes[3]!,
      inputDigest: computeInputDigest([{ nodeId: 'fail_route', outputRef: 'recovered', evidenceRefs: [] }]),
      attemptId: 't-m', wave: 2, outputRef: 'merged', firedEdgeIds: [],
    }),
  ];
  const ran: string[] = [];
  const runner: NodeRunner = {
    run(node): NodeOutcome { ran.push(node.id); return { status: 'completed' }; },
  };
  const { adapter } = memoryAdapter();
  const result = await runGraph(graph, {
    runner, admission, journalAdapter: adapter, clock: () => 0,
    resumeEntries: journal, attemptIds: attempts('r'),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual(ran, [], 'a durably settled failure route was re-dispatched');
  const srcTrace = result.trace.find((entry) => entry.nodeId === 'src');
  assert.equal(srcTrace?.reused, true, 'the failed settlement is trusted history, replayed not re-run');
  assert.equal(srcTrace?.status, 'failed');
  assert.ok(result.unreached.includes('ok_route'), 'the success alternative stays unreached');
});

// ─── Suite D: opaque edge stability ──────────────────────────────────────────

function opaqueFixture(firedEdgeIds: string[], includeY: boolean) {
  const x: ExecutableNode = { id: 'x', kind: 'step' };
  const y: ExecutableNode = { id: 'y', kind: 'step' };
  const graph: ExecutableGraph = {
    graphId: 'opaque',
    nodes: [x, y],
    edges: [{ id: 'e-v', source: 'x', target: 'y', when: 'verified' }],
  };
  const admission = admitted(graph);
  const journal: GraphJournalEntry[] = [
    ...settledPair({
      admission, node: x, inputDigest: computeInputDigest([]), attemptId: 't-x', wave: 0,
      outputRef: 'art-x', firedEdgeIds,
    }),
    ...(includeY
      ? settledPair({
        admission, node: y,
        inputDigest: computeInputDigest([{ nodeId: 'x', outputRef: 'art-x', evidenceRefs: [] }]),
        attemptId: 't-y', wave: 1, outputRef: 'art-y', firedEdgeIds: [],
      })
      : []),
  ];
  return { graph, admission, journal };
}

test('D: a durably fired opaque edge replays even when today\'s closure would say no — and the closure is never consulted for reused work', async () => {
  const { graph, admission, journal } = opaqueFixture(['e-v'], true);
  let closureCalls = 0;
  const ran: string[] = [];
  const runner: NodeRunner = {
    run(node): NodeOutcome { ran.push(node.id); return { status: 'completed' }; },
    edgeSatisfied: () => { closureCalls += 1; return false; },
  };
  const { adapter } = memoryAdapter();
  const result = await runGraph(graph, {
    runner, admission, journalAdapter: adapter, clock: () => 0,
    resumeEntries: journal, attemptIds: attempts('r'),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual(ran, [], 'reused work was re-dispatched');
  assert.equal(result.trace.find((entry) => entry.nodeId === 'y')?.reused, true,
    'the historically fired opaque route did not replay');
  assert.equal(closureCalls, 0, 'a present-day closure was consulted for durable history');
});

test('D: a durably UNFIRED opaque edge stays unfired even when today\'s closure would say yes', async () => {
  const { graph, admission, journal } = opaqueFixture([], false);
  let closureCalls = 0;
  const ran: string[] = [];
  const runner: NodeRunner = {
    run(node): NodeOutcome { ran.push(node.id); return { status: 'completed' }; },
    edgeSatisfied: () => { closureCalls += 1; return true; },
  };
  const { adapter } = memoryAdapter();
  const result = await runGraph(graph, {
    runner, admission, journalAdapter: adapter, clock: () => 0,
    resumeEntries: journal, attemptIds: attempts('r'),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual(ran, [], 'x was re-dispatched or y ran through an edge history says never fired');
  assert.equal(closureCalls, 0, 'a present-day closure was consulted for durable history');
  assert.ok(result.unreached.includes('y'), 'y became reachable through a rewritten verdict');
});
