/**
 * Run: npx tsx --test src/runtime/graph/graph-replay-closeout.test.ts
 *
 * Stage A of the v3.8.0 prompt: the seven independently audited R1A closeout
 * defects (A1–A7), reproduced against ee4b132e and pinned at their REQUIRED
 * behavior. Every test here asserts the invariant, not the fixture, so this
 * file is red on the predecessor and green on the fix:
 *
 *   A1  the runtime graph must BE the admitted graph — zero appends, zero
 *       runner calls on mismatch;
 *   A2  built-in route completeness — a completion cannot silently delete its
 *       success routes, a node failure cannot delete its failure routes,
 *       opaque labels stay optional historical verdicts;
 *   A3  journal order is causality — a start must have been READY given only
 *       the journal prefix at its position; a future route cannot authorize a
 *       past start;
 *   A4  an orphan patch becomes real only through a settlement that proves the
 *       exact digest; a completion that ignores its orphan refuses; historical
 *       re-emission never consults today's patch admitter;
 *   A5  every unique durable patch admission debits one expansion unit,
 *       applied or orphaned; reconciliation never debits twice;
 *   A6  admitted attempt identity is injected and collision-checked — the
 *       per-activation default counter is for the pure walker only;
 *   A7  a journaled start/settlement must carry the structural node digest of
 *       the definition at its journal position — a forged matching pair
 *       authorizes nothing.
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
import { reconstructAdmittedResume } from './graph-resume.js';
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
    graph, compilerVersion: 'a', policyHash: 'p', catalogHash: 'k', budget,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).admission;
}

let headerSeq = 0;
function withHeader(admission: GraphAdmission, entries: GraphJournalEntry[]): GraphJournalEntry[] {
  if (entries[0]?.type === 'run_header') return entries;
  return [{
    type: 'run_header', admissionDigest: admission.admissionDigest,
    journalSchemaVersion: admission.journalSchemaVersion,
    activationId: `hdr-${(headerSeq += 1)}`,
  } as GraphJournalEntry, ...entries];
}

function memoryAdapter() {
  const entries: GraphJournalEntry[] = [];
  return {
    entries,
    adapter: { async append(entry: GraphJournalEntry): Promise<void> { entries.push(entry); } },
  };
}

/** Deterministic injected attempt ids, unique per source. */
function attemptSource(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

function pair(input: {
  admission: GraphAdmission;
  node: ExecutableNode;
  inputDigest?: string;
  attemptId: string;
  wave: number;
  firedEdgeIds: string[];
  nodeDigest?: string;
  settle?: Partial<NodeSettledEntry>;
}): GraphJournalEntry[] {
  const base = {
    admissionDigest: input.admission.admissionDigest,
    nodeId: input.node.id,
    nodeDigest: input.nodeDigest ?? computeNodeDigest(input.node),
    inputDigest: input.inputDigest ?? computeInputDigest([]),
    attemptId: input.attemptId,
    wave: input.wave,
  };
  return [
    { type: 'node_started', ...base },
    {
      type: 'node_settled',
      status: 'completed',
      firedEdgeIds: input.firedEdgeIds,
      ...input.settle,
      ...base,
    } as GraphJournalEntry,
  ];
}

// ─── A1: the runtime graph must BE the admitted graph ────────────────────────

test('A1: a runtime graph that is not the admitted graph refuses with zero appends and zero runner calls', async () => {
  const admittedGraph: ExecutableGraph = {
    graphId: 'one', nodes: [{ id: 'n1', kind: 'step' }], edges: [],
  };
  const runtimeGraph: ExecutableGraph = {
    graphId: 'one',
    nodes: [{ id: 'n1', kind: 'step' }, { id: 'rogue', kind: 'step' }],
    edges: [],
  };
  const admission = admitted(admittedGraph);
  const { adapter, entries } = memoryAdapter();
  let runnerCalls = 0;
  const result = await runGraph(runtimeGraph, {
    runner: { run: () => { runnerCalls += 1; return { status: 'completed' }; } },
    admission,
    journalAdapter: adapter,
    clock: () => 0,
    attemptIds: attemptSource('a1'),
  });
  assert.equal(result.status, 'halted', 'an unadmitted node was allowed to schedule under the admission');
  assert.match(result.haltReason ?? '', /admitted graph/);
  assert.equal(runnerCalls, 0, 'a runner ran under an admission that never admitted its graph');
  assert.equal(entries.length, 0, 'a durable row was written for an unadmitted graph');
});

// ─── A2: built-in route completeness ─────────────────────────────────────────

const AB: ExecutableGraph = {
  graphId: 'ab',
  nodes: [{ id: 'a', kind: 'step' }, { id: 'b', kind: 'step' }],
  edges: [{ id: 'e-ab', source: 'a', target: 'b' }],
};

test('A2: a completed settlement omitting an enabled success route refuses — silence is deleted work', () => {
  const admission = admitted(AB);
  const result = reconstructAdmittedResume(AB, admission, withHeader(admission, pair({
    admission, node: AB.nodes[0]!, attemptId: 't-a', wave: 0, firedEdgeIds: [],
    settle: { outputRef: 'art-a' },
  })));
  assert.equal(result.ok, false, 'a completion that silently deleted its successor was accepted');
  assert.ok(
    (result as Extract<typeof result, { ok: false }>).errors.some((e) => /omits enabled success route/.test(e)),
    JSON.stringify(result),
  );
});

test('A2: a node-class failure omitting an enabled failure route refuses', () => {
  const graph: ExecutableGraph = {
    graphId: 'recover',
    nodes: [{ id: 'src', kind: 'step' }, { id: 'rec', kind: 'step' }],
    edges: [{ id: 'e-f', source: 'src', target: 'rec', when: 'failure' }],
  };
  const admission = admitted(graph);
  const result = reconstructAdmittedResume(graph, admission, withHeader(admission, pair({
    admission, node: graph.nodes[0]!, attemptId: 't-s', wave: 0, firedEdgeIds: [],
    settle: { status: 'failed', reason: 'refused', settlementClass: 'node' },
  })));
  assert.equal(result.ok, false, 'a failure that silently deleted its recovery route was accepted');
  assert.ok(
    (result as Extract<typeof result, { ok: false }>).errors.some((e) => /omits enabled failure route/.test(e)),
    JSON.stringify(result),
  );
});

test('A2: opaque labels are optional historical verdicts — fired and unfired mirrors both reconstruct', () => {
  const graph: ExecutableGraph = {
    graphId: 'opaque',
    nodes: [{ id: 'x', kind: 'step' }, { id: 'y', kind: 'step' }],
    edges: [{ id: 'e-v', source: 'x', target: 'y', when: 'verified' }],
  };
  const admission = admitted(graph);
  for (const fired of [['e-v'], []] as string[][]) {
    const result = reconstructAdmittedResume(graph, admission, withHeader(admission, pair({
      admission, node: graph.nodes[0]!, attemptId: 't-x', wave: 0, firedEdgeIds: fired,
      settle: { outputRef: 'art-x' },
    })));
    assert.equal(result.ok, true,
      `an opaque route with fired=${JSON.stringify(fired)} was treated as a route omission: ${JSON.stringify(result)}`);
  }
});

// ─── A3: journal order is causality ──────────────────────────────────────────

test('A3: a child settled before its parent refuses — a future route cannot authorize a past start', () => {
  const admission = admitted(AB);
  const entries: GraphJournalEntry[] = [
    ...pair({
      admission, node: AB.nodes[1]!, attemptId: 't-b', wave: 1,
      inputDigest: computeInputDigest([{ nodeId: 'a', outputRef: 'art-a', evidenceRefs: [] }]),
      firedEdgeIds: [],
    }),
    ...pair({
      admission, node: AB.nodes[0]!, attemptId: 't-a', wave: 0,
      firedEdgeIds: ['e-ab'], settle: { outputRef: 'art-a' },
    }),
  ];
  const result = reconstructAdmittedResume(AB, admission, withHeader(admission, entries));
  assert.equal(result.ok, false, 'a start that preceded its only route was blessed by a later settlement');
  assert.ok(
    (result as Extract<typeof result, { ok: false }>).errors.some((e) => /not ready at its journal position/.test(e)),
    JSON.stringify(result),
  );
});

test('A3: an any-join child before its FIRST fired input refuses', () => {
  const graph: ExecutableGraph = {
    graphId: 'fork',
    nodes: [
      { id: 'src', kind: 'step' },
      { id: 'ok', kind: 'step' },
      { id: 'merge', kind: 'reduce', joinMode: 'any' },
    ],
    edges: [
      { id: 'f-ok', source: 'src', target: 'ok' },
      { id: 'm-ok', source: 'ok', target: 'merge' },
    ],
  };
  const admission = admitted(graph);
  const entries: GraphJournalEntry[] = [
    ...pair({
      admission, node: graph.nodes[0]!, attemptId: 't-s', wave: 0,
      firedEdgeIds: ['f-ok'], settle: { outputRef: 's' },
    }),
    // merge settles BEFORE ok ever fired m-ok — impossible under any-join.
    ...pair({
      admission, node: graph.nodes[2]!, attemptId: 't-m', wave: 2,
      inputDigest: computeInputDigest([{ nodeId: 'ok', outputRef: 'o', evidenceRefs: [] }]),
      firedEdgeIds: [],
    }),
    ...pair({
      admission, node: graph.nodes[1]!, attemptId: 't-o', wave: 1,
      inputDigest: computeInputDigest([{ nodeId: 'src', outputRef: 's', evidenceRefs: [] }]),
      firedEdgeIds: ['m-ok'], settle: { outputRef: 'o' },
    }),
  ];
  const result = reconstructAdmittedResume(graph, admission, withHeader(admission, entries));
  assert.equal(result.ok, false, 'an any-join settled before any input route fired');
  assert.ok(
    (result as Extract<typeof result, { ok: false }>).errors.some((e) => /not ready at its journal position/.test(e)),
    JSON.stringify(result),
  );
});

test('A3: same-wave sibling roots interleaved as one dispatch slice remain legal', () => {
  const graph: ExecutableGraph = {
    graphId: 'sibs',
    nodes: [{ id: 'r1', kind: 'step' }, { id: 'r2', kind: 'step' }],
    edges: [],
  };
  const admission = admitted(graph);
  const [s1, d1] = pair({ admission, node: graph.nodes[0]!, attemptId: 't-1', wave: 0, firedEdgeIds: [] });
  const [s2, d2] = pair({ admission, node: graph.nodes[1]!, attemptId: 't-2', wave: 0, firedEdgeIds: [] });
  // The executor's slice order: claims first, then settlements.
  const result = reconstructAdmittedResume(graph, admission, withHeader(admission, [s1!, s2!, d1!, d2!]));
  assert.equal(result.ok, true, JSON.stringify(result));
});

// ─── A4 + A5: orphan patches, reconciliation, and expansion debit ────────────

/** planner root; its patch adds a ROOT worker (no edges) — the audit shape in
 *  which a promoted orphan executes work nobody re-authorized. */
function orphanRootFixture() {
  const planner: ExecutableNode = { id: 'planner', kind: 'planner' };
  const w1: ExecutableNode = { id: 'w1', kind: 'worker' };
  const graph: ExecutableGraph = { graphId: 'orphan-root', nodes: [planner], edges: [] };
  const admission = admitted(graph, { ...BUDGET, maxExpansions: 1 });
  const validated = validateGraphPatch(graph, { emittedBy: 'planner', nodes: [w1], edges: [] });
  assert.equal(validated.ok, true, JSON.stringify(validated));
  const patchDigest = (validated as Extract<typeof validated, { ok: true }>).patchDigest;
  const crashJournal: GraphJournalEntry[] = [
    {
      type: 'node_started', admissionDigest: admission.admissionDigest, nodeId: 'planner',
      nodeDigest: computeNodeDigest(planner), inputDigest: computeInputDigest([]),
      attemptId: 'boot-1', wave: 0,
    },
    {
      type: 'patch_admitted', admissionDigest: admission.admissionDigest,
      emittedBy: 'planner', emitterAttemptId: 'boot-1', patchDigest,
      nodes: [w1], edges: [],
    } as GraphJournalEntry,
  ];
  return { graph, admission, planner, w1, patchDigest, crashJournal };
}

test('A4: an orphan-bearing emitter that completes WITHOUT reproducing its patch fails as node logic', async () => {
  const { graph, admission, crashJournal } = orphanRootFixture();
  const { adapter } = memoryAdapter();
  const ran: string[] = [];
  const result = await runGraph(graph, {
    runner: { run: (node): NodeOutcome => { ran.push(node.id); return { status: 'completed', outputRef: 'plan' }; } },
    admission, journalAdapter: adapter, clock: () => 0,
    resumeEntries: withHeader(admission, crashJournal),
    patchAdmitter: () => ({ ok: true }),
    attemptIds: attemptSource('r1'),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual(result.failed, ['planner'],
    'a completion that abandoned its durably admitted patch was accepted');
  assert.match(result.trace.find((t) => t.nodeId === 'planner')?.reason ?? '', /reproduce/);
  assert.deepEqual(ran, ['planner'], 'orphan topology became eligible');
});

test('A4: a later completion WITHOUT the exact patch digest never promotes the orphan on the next restart', async () => {
  const { graph, admission, crashJournal, planner } = orphanRootFixture();
  // The forged second-restart journal the audit produced: an ordinary
  // completion by the same node, carrying no patch identity at all.
  const secondRestart: GraphJournalEntry[] = [
    ...crashJournal,
    ...pair({ admission, node: planner, attemptId: 'boot-2', wave: 0, firedEdgeIds: [], settle: { outputRef: 'plan' } }),
  ];
  const { adapter } = memoryAdapter();
  const ran: string[] = [];
  const result = await runGraph(graph, {
    runner: { run: (node): NodeOutcome => { ran.push(node.id); return { status: 'completed' }; } },
    admission, journalAdapter: adapter, clock: () => 0,
    resumeEntries: withHeader(admission, secondRestart),
    patchAdmitter: () => ({ ok: true }),
    attemptIds: attemptSource('r2'),
  });
  assert.equal(ran.includes('w1'), false,
    'the orphan worker executed on the second restart without any attempt proving its digest');
  assert.equal(result.status, 'halted',
    'a history in which a completion silently ignored its durable orphan patch was accepted');
  assert.match(result.haltReason ?? '', /orphan|reproduce/);
});

test('A4: exact reconciliation binds the digest to the settlement and never consults today\'s patch admitter', async () => {
  const { graph, admission, crashJournal, w1, patchDigest } = orphanRootFixture();
  const { adapter, entries } = memoryAdapter();
  let admitterCalls = 0;
  const ran: string[] = [];
  const result = await runGraph(graph, {
    runner: {
      run: (node): NodeOutcome => {
        ran.push(node.id);
        if (node.id === 'planner') {
          return { status: 'completed', outputRef: 'plan', emitPatch: { nodes: [w1], edges: [] } };
        }
        return { status: 'completed', outputRef: `art-${node.id}` };
      },
    },
    admission, journalAdapter: adapter, clock: () => 0,
    resumeEntries: withHeader(admission, crashJournal),
    // The audit case: authority policy has CHANGED since the durable
    // admission. Historical reconciliation must not re-ask it.
    patchAdmitter: () => { admitterCalls += 1; return { ok: false, reason: 'policy changed' }; },
    attemptIds: attemptSource('r3'),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual(ran, ['planner', 'w1'], 'reconciliation did not make the admitted child real');
  assert.equal(admitterCalls, 0,
    'a historically admitted patch was re-judged by today\'s ambient authority');
  assert.equal(entries.filter((e) => e.type === 'patch_admitted').length, 0,
    'reconciliation journaled the patch a second time');
  const settledPlanner = entries.find(
    (e): e is NodeSettledEntry => e.type === 'node_settled' && e.nodeId === 'planner',
  );
  assert.equal((settledPlanner as { emittedPatchDigest?: string } | undefined)?.emittedPatchDigest, patchDigest,
    'the reconciling settlement does not carry the exact patch digest — the next restart cannot prove promotion');
});

test('A4: after exact reconciliation, the NEXT restart promotes the patch and reuses the worker', async () => {
  const { graph, admission, crashJournal, planner, w1, patchDigest } = orphanRootFixture();
  const w1Input = computeInputDigest([]);
  const reconciled: GraphJournalEntry[] = [
    ...crashJournal,
    ...pair({
      admission, node: planner, attemptId: 'boot-2', wave: 0, firedEdgeIds: [],
      settle: { outputRef: 'plan', emittedPatchDigest: patchDigest } as Partial<NodeSettledEntry>,
    }),
    ...pair({
      admission, node: w1, attemptId: 'boot-3', wave: 1, inputDigest: w1Input,
      firedEdgeIds: [], settle: { outputRef: 'art-w1' },
    }),
  ];
  const { adapter } = memoryAdapter();
  const ran: string[] = [];
  const result = await runGraph(graph, {
    runner: { run: (node): NodeOutcome => { ran.push(node.id); return { status: 'completed' }; } },
    admission, journalAdapter: adapter, clock: () => 0,
    resumeEntries: withHeader(admission, reconciled),
    patchAdmitter: () => ({ ok: false, reason: 'policy changed' }),
    attemptIds: attemptSource('r4'),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual(ran, [], 'a fully reconciled history re-dispatched settled work');
  assert.equal(result.trace.filter((t) => t.reused).length, 2);
  assert.deepEqual(result.patches, [patchDigest]);
});

test('A5: unique durable patch admissions debit expansions whether applied or orphaned', () => {
  // Two emitters, each with a durable orphan admission; the budget allows one
  // expansion. History with two admissions cannot belong to this admission.
  const e1: ExecutableNode = { id: 'e1', kind: 'planner' };
  const e2: ExecutableNode = { id: 'e2', kind: 'planner' };
  const graph: ExecutableGraph = { graphId: 'debit', nodes: [e1, e2], edges: [] };
  const admission = admitted(graph, { ...BUDGET, maxExpansions: 1 });
  const patchFor = (emitter: string, workerId: string) => {
    const validated = validateGraphPatch(graph, {
      emittedBy: emitter, nodes: [{ id: workerId, kind: 'worker' }], edges: [],
    });
    assert.equal(validated.ok, true);
    return (validated as Extract<typeof validated, { ok: true }>).patchDigest;
  };
  const start = (node: ExecutableNode, attemptId: string): GraphJournalEntry => ({
    type: 'node_started', admissionDigest: admission.admissionDigest, nodeId: node.id,
    nodeDigest: computeNodeDigest(node), inputDigest: computeInputDigest([]), attemptId, wave: 0,
  });
  const entries: GraphJournalEntry[] = [
    start(e1, 'a-1'),
    { type: 'patch_admitted', admissionDigest: admission.admissionDigest, emittedBy: 'e1', emitterAttemptId: 'a-1', patchDigest: patchFor('e1', 'w1'), nodes: [{ id: 'w1', kind: 'worker' }], edges: [] } as GraphJournalEntry,
    start(e2, 'a-2'),
    { type: 'patch_admitted', admissionDigest: admission.admissionDigest, emittedBy: 'e2', emitterAttemptId: 'a-2', patchDigest: patchFor('e2', 'w2'), nodes: [{ id: 'w2', kind: 'worker' }], edges: [] } as GraphJournalEntry,
  ];
  const result = reconstructAdmittedResume(graph, admission, withHeader(admission, entries));
  assert.equal(result.ok, false,
    'orphaned admissions vanished from the expansion debit — the restored budget lies');
  assert.ok(
    (result as Extract<typeof result, { ok: false }>).errors.some((e) => /expansion|admissions/.test(e)),
    JSON.stringify(result),
  );
});

test('A5: exact reconciliation at the expansion ceiling is not charged as new growth', async () => {
  const { graph, admission, crashJournal, w1 } = orphanRootFixture(); // maxExpansions: 1, one orphan
  const { adapter } = memoryAdapter();
  const ran: string[] = [];
  const result = await runGraph(graph, {
    runner: {
      run: (node): NodeOutcome => {
        ran.push(node.id);
        if (node.id === 'planner') {
          return { status: 'completed', outputRef: 'plan', emitPatch: { nodes: [w1], edges: [] } };
        }
        return { status: 'completed' };
      },
    },
    admission, journalAdapter: adapter, clock: () => 0,
    resumeEntries: withHeader(admission, crashJournal),
    patchAdmitter: () => ({ ok: true }),
    attemptIds: attemptSource('r5'),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.equal(result.failed.length, 0,
    'reconciling the only admitted expansion was double-debited and refused at the ceiling');
  assert.deepEqual(ran, ['planner', 'w1']);
});

// ─── A6: attempt identity must be injected and collision-free ────────────────

test('A6: an admitted run without an injected attempt-id source refuses before dispatch', async () => {
  const admission = admitted(AB);
  const { adapter, entries } = memoryAdapter();
  let runnerCalls = 0;
  const result = await runGraph(AB, {
    runner: { run: () => { runnerCalls += 1; return { status: 'completed' }; } },
    admission, journalAdapter: adapter, clock: () => 0,
    // no attemptIds: the per-activation default counter restarts on every
    // resume and rewrites history's attempt ids.
  });
  assert.equal(result.status, 'halted',
    'the per-activation default counter was accepted as admitted attempt identity');
  assert.match(result.haltReason ?? '', /attempt/);
  assert.equal(runnerCalls, 0);
  assert.equal(entries.length, 0);
});

test('A6: an injected source that collides with journaled history halts before the colliding claim', async () => {
  const admission = admitted(AB);
  const a = AB.nodes[0]!;
  const journal: GraphJournalEntry[] = [
    {
      type: 'node_started', admissionDigest: admission.admissionDigest, nodeId: 'a',
      nodeDigest: computeNodeDigest(a), inputDigest: computeInputDigest([]),
      attemptId: 'attempt-1', wave: 0,
    },
    // interrupted — a legal crash. The node must rerun under a NEW attempt.
  ];
  const { adapter, entries } = memoryAdapter();
  const result = await runGraph(AB, {
    runner: { run: () => ({ status: 'completed' }) },
    admission, journalAdapter: adapter, clock: () => 0,
    resumeEntries: withHeader(admission, journal),
    attemptIds: () => 'attempt-1', // deliberately colliding
  });
  assert.equal(result.status, 'halted',
    'a reused attempt id was written — the next replay would refuse its own history');
  assert.match(result.haltReason ?? '', /attempt .*already|collid/i);
  assert.equal(entries.some((e) => e.type === 'node_started' && e.attemptId === 'attempt-1'), false,
    'the colliding claim reached the journal');
});

// ─── A7: journaled identity must match the admitted definition ───────────────

test('A7: a forged internally-consistent pair with a wrong node digest refuses — it authorizes nothing', () => {
  const admission = admitted(AB);
  const forgedDigest = computeNodeDigest({ id: 'a', kind: 'something-else' });
  const result = reconstructAdmittedResume(AB, admission, withHeader(admission, pair({
    admission, node: AB.nodes[0]!, attemptId: 't-a', wave: 0,
    nodeDigest: forgedDigest, firedEdgeIds: ['e-ab'], settle: { outputRef: 'art-a' },
  })));
  assert.equal(result.ok, false,
    'a pair whose digest never described the admitted topology was trusted');
  assert.ok(
    (result as Extract<typeof result, { ok: false }>).errors.some((e) => /node digest|definition at/.test(e)),
    JSON.stringify(result),
  );
});

test('A7: a wrong-digest emitter start cannot anchor patch causality', () => {
  const planner: ExecutableNode = { id: 'planner', kind: 'planner' };
  const graph: ExecutableGraph = { graphId: 'anchor', nodes: [planner], edges: [] };
  const admission = admitted(graph, { ...BUDGET, maxExpansions: 1 });
  const validated = validateGraphPatch(graph, {
    emittedBy: 'planner', nodes: [{ id: 'w1', kind: 'worker' }], edges: [],
  });
  assert.equal(validated.ok, true);
  const entries: GraphJournalEntry[] = [
    {
      type: 'node_started', admissionDigest: admission.admissionDigest, nodeId: 'planner',
      nodeDigest: computeNodeDigest({ id: 'planner', kind: 'forged' }),
      inputDigest: computeInputDigest([]), attemptId: 'x-1', wave: 0,
    },
    {
      type: 'patch_admitted', admissionDigest: admission.admissionDigest,
      emittedBy: 'planner', emitterAttemptId: 'x-1',
      patchDigest: (validated as Extract<typeof validated, { ok: true }>).patchDigest,
      nodes: [{ id: 'w1', kind: 'worker' }], edges: [],
    } as GraphJournalEntry,
  ];
  const result = reconstructAdmittedResume(graph, admission, withHeader(admission, entries));
  assert.equal(result.ok, false, 'a patch anchored to an identity the graph never admitted was accepted');
});

test('A7: a patch-added node\'s journaled identity validates against the patch definition and reconstructs', async () => {
  const { graph, admission, crashJournal, planner, w1, patchDigest } = orphanRootFixture();
  const reconciled: GraphJournalEntry[] = [
    ...crashJournal,
    ...pair({
      admission, node: planner, attemptId: 'boot-2', wave: 0, firedEdgeIds: [],
      settle: { outputRef: 'plan', emittedPatchDigest: patchDigest } as Partial<NodeSettledEntry>,
    }),
    ...pair({ admission, node: w1, attemptId: 'boot-3', wave: 1, firedEdgeIds: [], settle: { outputRef: 'art-w1' } }),
  ];
  const result = reconstructAdmittedResume(graph, admission, withHeader(admission, reconciled));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((result as Extract<typeof result, { ok: true }>).trusted.get('w1')?.outputRef, 'art-w1');
});
