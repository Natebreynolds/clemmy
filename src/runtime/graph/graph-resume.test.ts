/**
 * Run: npx tsx --test src/runtime/graph/graph-resume.test.ts
 *
 * The corrupt-or-impossible journal matrix (R1A suite E) plus the positive
 * reconstruction contract. Every refusal here is a history the executor could
 * not have produced; reconstruction refuses each one independently, with a
 * precise reason, and repairs nothing. The executor-level replay behavior
 * (input-bound reuse, durable verdicts, opaque stability) is pinned in
 * graph-replay-truth.test.ts; THIS file pins the pure module.
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
import { reconstructAdmittedResume, type ResumeReconstruction } from './graph-resume.js';
import type { ExecutableGraph, ExecutableNode } from './graph-executor.js';

const BUDGET: AdmittedBudget = {
  maxNodes: 100, maxWaves: 100, maxConcurrency: 4, maxElapsedMs: 60_000, maxExpansions: 1,
};

const GRAPH: ExecutableGraph = {
  graphId: 'matrix',
  nodes: [
    { id: 'a', kind: 'step' },
    { id: 'b', kind: 'step' },
    { id: 'recover', kind: 'step' },
    { id: 'off', kind: 'step' },
  ],
  edges: [
    { id: 'e-ab', source: 'a', target: 'b' },
    { id: 'e-fail', source: 'a', target: 'recover', when: 'failure' },
    { id: 'e-off', source: 'a', target: 'off', disabled: true },
  ],
};

function admitted(graph: ExecutableGraph = GRAPH, budget: AdmittedBudget = BUDGET): GraphAdmission {
  const result = admitGraph({
    graph, compilerVersion: 'r1a', policyHash: 'p1', catalogHash: 'k1', budget,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).admission;
}

const ADMISSION = admitted();

function pair(input: {
  node: ExecutableNode;
  inputDigest?: string;
  attemptId: string;
  wave?: number;
  firedEdgeIds?: string[];
  settle?: Partial<NodeSettledEntry>;
  admission?: GraphAdmission;
}): GraphJournalEntry[] {
  const identity = {
    admissionDigest: (input.admission ?? ADMISSION).admissionDigest,
    nodeId: input.node.id,
    nodeDigest: computeNodeDigest(input.node),
    inputDigest: input.inputDigest ?? computeInputDigest([]),
    attemptId: input.attemptId,
    wave: input.wave ?? 0,
  };
  return [
    { type: 'node_started', ...identity },
    {
      type: 'node_settled',
      status: 'completed',
      firedEdgeIds: input.firedEdgeIds ?? [],
      ...input.settle,
      ...identity,
    } as GraphJournalEntry,
  ];
}

function refuses(entries: GraphJournalEntry[], why: RegExp, graph = GRAPH, admission = ADMISSION): void {
  const result = reconstructAdmittedResume(graph, admission, entries);
  assert.equal(result.ok, false, 'an impossible history was accepted');
  const errors = (result as Extract<typeof result, { ok: false }>).errors;
  assert.ok(errors.some((error) => why.test(error)), `no error matched ${why}: ${JSON.stringify(errors)}`);
}

function accepts(entries: GraphJournalEntry[], graph = GRAPH, admission = ADMISSION): ResumeReconstruction {
  const result = reconstructAdmittedResume(graph, admission, entries);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as ResumeReconstruction;
}

const A = GRAPH.nodes[0]!;
const B = GRAPH.nodes[1]!;
const bInput = () => computeInputDigest([{ nodeId: 'a', outputRef: 'art-a', evidenceRefs: [] }]);
const aPair = (over: Partial<Parameters<typeof pair>[0]> = {}) => pair({
  node: A, attemptId: 't-a', firedEdgeIds: ['e-ab'], settle: { outputRef: 'art-a' }, ...over,
});

// ── the positive contract ────────────────────────────────────────────────────

test('an exact paired history reconstructs: trusted settlements, durable routes', () => {
  const resume = accepts([
    ...aPair(),
    ...pair({ node: B, attemptId: 't-b', inputDigest: bInput(), wave: 1, settle: { outputRef: 'art-b' } }),
  ]);
  assert.deepEqual([...resume.trusted.keys()].sort(), ['a', 'b']);
  assert.deepEqual(resume.trusted.get('a')?.firedEdgeIds, ['e-ab']);
  assert.equal(resume.trusted.get('b')?.outputRef, 'art-b');
});

test('a failure-routed history is closed: the failed node fires its failure edge, recovery completes', () => {
  const resume = accepts([
    ...pair({
      node: A, attemptId: 't-a', firedEdgeIds: ['e-fail'],
      settle: { status: 'failed', reason: 'validation refused', settlementClass: 'node' },
    }),
    ...pair({
      node: GRAPH.nodes[2]!, attemptId: 't-r', wave: 1,
      inputDigest: computeInputDigest([]),
    }),
  ]);
  assert.equal(resume.trusted.get('a')?.status, 'failed', 'a node-class failure is trusted history');
  assert.equal(resume.trusted.get('recover')?.status, 'completed');
});

test('an interrupted start is legal history that grants nothing', () => {
  const resume = accepts([
    ...aPair(),
    {
      type: 'node_started', admissionDigest: ADMISSION.admissionDigest, nodeId: 'b',
      nodeDigest: computeNodeDigest(B), inputDigest: bInput(), attemptId: 't-b-crashed', wave: 1,
    },
  ]);
  assert.equal(resume.trusted.has('b'), false, 'a crashed start was treated as done');
});

test('a later settlement supersedes an earlier one for the same node', () => {
  const resume = accepts([
    ...aPair({ settle: { outputRef: 'art-a-old' } }),
    ...aPair({ attemptId: 't-a-2', settle: { outputRef: 'art-a-new' } }),
  ]);
  assert.equal(resume.trusted.get('a')?.outputRef, 'art-a-new', 'stale history outranked the latest settlement');
});

// ── suite E: the corrupt-or-impossible journal matrix ────────────────────────

test('E: a settlement without any start refuses', () => {
  refuses([aPair()[1]!], /no preceding durable start/);
});

test('E: a settlement ORDERED before its start refuses', () => {
  const [started, settled] = aPair();
  refuses([settled!, started!], /no preceding durable start/);
});

test('E: an attempt mismatch between start and settlement refuses', () => {
  const [started] = aPair();
  const [, settled] = aPair({ attemptId: 't-a-other' });
  refuses([started!, settled!], /no preceding durable start/);
});

test('E: node, definition, input, and wave identity must each match the start', () => {
  for (const drift of [
    { nodeDigest: 'someone-else' },
    { inputDigest: 'other-inputs' },
    { wave: 7 },
  ] as const) {
    const [started, settled] = aPair();
    refuses([started!, { ...(settled as NodeSettledEntry), ...drift }], /disagrees with its start/);
  }
  const [started] = aPair();
  const [, settledForB] = pair({ node: B, attemptId: 't-a', firedEdgeIds: [] });
  refuses([started!, settledForB!], /disagrees with its start|no preceding durable start/);
});

test('E: a duplicate start for one attempt refuses — never collapsed', () => {
  const [started] = aPair();
  refuses([started!, started!], /started twice/);
});

test('E: a duplicate settlement for one attempt refuses — never collapsed', () => {
  const [started, settled] = aPair();
  refuses([started!, settled!, settled!], /settled twice/);
});

test('E: fired-edge verdicts must be real — dangling, disabled, foreign-sourced, duplicated', () => {
  refuses([...aPair({ firedEdgeIds: ['no-such-edge'] })], /did not contain/);
  refuses([...aPair({ firedEdgeIds: ['e-off'] })], /disabled/);
  refuses(
    [...aPair(), ...pair({
      node: B, attemptId: 't-b', inputDigest: bInput(), wave: 1, firedEdgeIds: ['e-ab'],
    })],
    /sourced by/,
  );
  refuses([...aPair({ firedEdgeIds: ['e-ab', 'e-ab'] })], /twice/);
});

test('E: routing must agree with status and class', () => {
  // A successful settlement cannot record its failure edge as fired.
  refuses([...aPair({ firedEdgeIds: ['e-fail'] })], /success cannot route recovery/);
  // A failed settlement cannot record a success edge as fired.
  refuses(
    [...aPair({ firedEdgeIds: ['e-ab'], settle: { status: 'failed', reason: 'x', settlementClass: 'node' } })],
    /failed settlement .* recorded success edge/,
  );
  // Infrastructure, policy, blocked, and paused fire nothing.
  for (const settle of [
    { status: 'failed', reason: 'x', settlementClass: 'infrastructure' },
    { status: 'blocked', reason: 'x' },
    { status: 'paused', reason: 'x' },
  ] as const) {
    refuses([...aPair({ firedEdgeIds: ['e-fail'], settle })], /records fired edges/);
  }
});

test('E: a settlement lacking durable edge verdicts (pre-R1A journal) refuses, never all-success', () => {
  const [started, settled] = aPair();
  const legacy = { ...(settled as NodeSettledEntry) } as Record<string, unknown>;
  delete legacy.firedEdgeIds;
  refuses([started!, legacy as unknown as GraphJournalEntry], /no durable edge verdicts/);
});

test('E: an entry from another admission refuses the whole resume', () => {
  refuses(
    aPair().map((entry) => ({ ...entry, admissionDigest: 'someone-elses-run' })),
    /different run/,
  );
});

test('E: a settlement for a node the topology did not yet contain refuses', () => {
  refuses(
    pair({ node: { id: 'ghost', kind: 'step' }, attemptId: 't-g' }),
    /order the executor cannot produce/,
  );
});

// ── suite E, patch rows ──────────────────────────────────────────────────────

const PLANNER: ExecutableNode = { id: 'planner', kind: 'planner' };
const REDUCER: ExecutableNode = { id: 'reducer', kind: 'reduce' };
const W1: ExecutableNode = { id: 'w1', kind: 'worker' };
const PATCH_GRAPH: ExecutableGraph = {
  graphId: 'patchy', nodes: [PLANNER, REDUCER], edges: [],
};
const PATCH_ADMISSION = admitted(PATCH_GRAPH);
const PATCH_EDGES = [
  { id: 'p-w1', source: 'planner', target: 'w1' },
  { id: 'j-w1', source: 'w1', target: 'reducer' },
];

function patchDigestFor(graph: ExecutableGraph): string {
  const validated = validateGraphPatch(graph, { emittedBy: 'planner', nodes: [W1], edges: PATCH_EDGES });
  assert.equal(validated.ok, true, JSON.stringify(validated));
  return (validated as Extract<typeof validated, { ok: true }>).patchDigest;
}

function patchEntry(over: Partial<GraphJournalEntry> = {}): GraphJournalEntry {
  return {
    type: 'patch_admitted',
    admissionDigest: PATCH_ADMISSION.admissionDigest,
    emittedBy: 'planner',
    emitterAttemptId: 't-p',
    patchDigest: patchDigestFor(PATCH_GRAPH),
    nodes: [W1],
    edges: PATCH_EDGES,
    ...over,
  } as GraphJournalEntry;
}

function plannerPair(firedEdgeIds: string[] = ['p-w1']): GraphJournalEntry[] {
  return pair({
    node: PLANNER, attemptId: 't-p', firedEdgeIds,
    settle: { outputRef: 'plan' }, admission: PATCH_ADMISSION,
  });
}

test('E: a patch without a matching emitter start/attempt refuses', () => {
  const [started, settled] = plannerPair();
  refuses([started!, patchEntry({ emitterAttemptId: 't-other' }), settled!],
    /precedes its emitter's durable start/, PATCH_GRAPH, PATCH_ADMISSION);
});

test('E: a patch reordered before its emitter start refuses', () => {
  refuses([patchEntry(), ...plannerPair()],
    /precedes its emitter's durable start/, PATCH_GRAPH, PATCH_ADMISSION);
});

test('E: a patch admitted after its emitter attempt settled refuses', () => {
  // The settlement fires nothing (its patch edges do not exist yet), so the
  // only impossibility is the ordering itself.
  refuses([...plannerPair([]), patchEntry()],
    /after attempt .* settled/, PATCH_GRAPH, PATCH_ADMISSION);
});

test('E: tampered patch content refuses by digest', () => {
  const [started, settled] = plannerPair();
  refuses(
    [started!, patchEntry({ nodes: [{ id: 'w1', kind: 'tampered-worker' }] }), settled!],
    /does not match its digest/, PATCH_GRAPH, PATCH_ADMISSION,
  );
});

test('E: a patch lacking its emitter attempt binding (pre-R1A journal) refuses', () => {
  const [started, settled] = plannerPair();
  const legacy = patchEntry() as unknown as Record<string, unknown>;
  delete legacy.emitterAttemptId;
  refuses([started!, legacy as unknown as GraphJournalEntry, settled!],
    /no emitter attempt binding/, PATCH_GRAPH, PATCH_ADMISSION);
});

test('E: a patch-added settlement before the patch admission refuses', () => {
  const [started, settled] = plannerPair();
  refuses(
    [
      started!,
      ...pair({
        node: W1, attemptId: 't-w1', wave: 1, firedEdgeIds: [],
        admission: PATCH_ADMISSION,
      }),
      patchEntry(),
      settled!,
    ],
    /order the executor cannot produce/, PATCH_GRAPH, PATCH_ADMISSION,
  );
});

test('E: a patch joining a node that had already settled at that position refuses', () => {
  const reducerRoot: ExecutableGraph = {
    graphId: 'patchy', nodes: [PLANNER, REDUCER], edges: [],
  };
  const admission = admitted(reducerRoot);
  const [pStart, pSettle] = pair({
    node: PLANNER, attemptId: 't-p', firedEdgeIds: ['p-w1'],
    settle: { outputRef: 'plan' }, admission,
  });
  const [rStart, rSettle] = pair({ node: REDUCER, attemptId: 't-r', admission });
  refuses(
    [rStart!, rSettle!, pStart!, patchEntry({ admissionDigest: admission.admissionDigest }), pSettle!],
    /already settled at that position/, reducerRoot, admission,
  );
});

test('E: an orphan patch cannot make children eligible, and their history refuses', () => {
  const [started] = plannerPair();
  // Orphan alone: legal, reported, withheld from topology.
  const resume = accepts([started!, patchEntry()], PATCH_GRAPH, PATCH_ADMISSION);
  assert.equal(resume.nodes.some((node) => node.id === 'w1'), false,
    'orphan topology leaked into the resumed graph');
  assert.equal(resume.orphanPatchByEmitter.get('planner'), patchDigestFor(PATCH_GRAPH));
  assert.deepEqual(resume.appliedPatchDigests, [], 'an orphan counted against the expansion history');
  // A child claiming history under an orphan patch: impossible. (Since the
  // Stage A closeout this bites at the earliest possible check — the child's
  // start was never READY, because the orphan's routes never fired.)
  refuses(
    [started!, patchEntry(), ...pair({
      node: W1, attemptId: 't-w1', wave: 1, admission: PATCH_ADMISSION,
    })],
    /orphan|never durably completed|not ready at its journal position/, PATCH_GRAPH, PATCH_ADMISSION,
  );
});

test('E: a duplicate patch digest refuses — re-emission replays, it does not journal again', () => {
  const [started, settled] = plannerPair();
  refuses([started!, patchEntry(), patchEntry(), settled!],
    /appears twice/, PATCH_GRAPH, PATCH_ADMISSION);
});

test('E: more applied patches than the admitted expansion budget refuses', () => {
  const admission = admitted(PATCH_GRAPH, { ...BUDGET, maxExpansions: 0 });
  const [started, settled] = pair({
    node: PLANNER, attemptId: 't-p', firedEdgeIds: ['p-w1'],
    settle: { outputRef: 'plan' }, admission,
  });
  refuses(
    [started!, patchEntry({ admissionDigest: admission.admissionDigest }), settled!],
    /expansion|allows 0/, PATCH_GRAPH, admission,
  );
});

// ── join-aware closure ───────────────────────────────────────────────────────

const FORK: ExecutableGraph = {
  graphId: 'fork',
  nodes: [
    { id: 'src', kind: 'step' },
    { id: 'ok', kind: 'step' },
    { id: 'alt', kind: 'step' },
    { id: 'merge', kind: 'reduce', joinMode: 'any' },
  ],
  edges: [
    { id: 'f-ok', source: 'src', target: 'ok', when: 'success' },
    { id: 'f-alt', source: 'src', target: 'alt', when: 'failure' },
    { id: 'm-ok', source: 'ok', target: 'merge' },
    { id: 'm-alt', source: 'alt', target: 'merge' },
  ],
};

function forkEntries(admission: GraphAdmission, graph: ExecutableGraph): GraphJournalEntry[] {
  return [
    ...pair({
      node: graph.nodes[0]!, attemptId: 't-s', firedEdgeIds: ['f-ok'],
      settle: { outputRef: 's-out' }, admission,
    }),
    ...pair({
      node: graph.nodes[1]!, attemptId: 't-ok', wave: 1, firedEdgeIds: ['m-ok'],
      inputDigest: computeInputDigest([{ nodeId: 'src', outputRef: 's-out', evidenceRefs: [] }]),
      settle: { outputRef: 'ok-out' }, admission,
    }),
    ...pair({
      node: graph.nodes[3]!, attemptId: 't-m', wave: 2,
      inputDigest: computeInputDigest([{ nodeId: 'ok', outputRef: 'ok-out', evidenceRefs: [] }]),
      admission,
    }),
  ];
}

test('closure: one fired route satisfies an any-join; the unfired alternative owes nothing', () => {
  const admission = admitted(FORK);
  const resume = accepts(forkEntries(admission, FORK), FORK, admission);
  assert.equal(resume.trusted.get('merge')?.status, 'completed');
});

test('closure: the equivalent incomplete all-join refuses precisely', () => {
  const allJoin: ExecutableGraph = {
    ...FORK,
    nodes: FORK.nodes.map((node) => (node.id === 'merge' ? { id: 'merge', kind: 'reduce' } : node)),
  };
  const admission = admitted(allJoin);
  refuses(forkEntries(admission, allJoin), /all-join is missing/, allJoin, admission);
});

test('closure: a settled node with no durably fired route refuses — at the earliest check that sees it', () => {
  const admission = admitted(FORK);
  refuses(
    [
      ...pair({
        node: FORK.nodes[0]!, attemptId: 't-s', firedEdgeIds: [],
        settle: { outputRef: 's-out' }, admission,
      }),
      ...pair({
        node: FORK.nodes[1]!, attemptId: 't-ok', wave: 1,
        inputDigest: computeInputDigest([{ nodeId: 'src', outputRef: 's-out', evidenceRefs: [] }]),
        admission,
      }),
    ],
    // Since the Stage A closeout, route-completeness (A2) and ordered
    // readiness (A3) catch this before final closure; closure remains as
    // defense-in-depth behind them.
    /omits enabled success route|not ready at its journal position|not causally closed/, FORK, admission,
  );
});

// ── the module stays pure ────────────────────────────────────────────────────

test('graph-resume imports only pure siblings and observes nothing', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, 'graph-resume.ts'), 'utf-8');
  assert.deepEqual(
    [...source.matchAll(/^import (?!type ).*?from '([^']+)';$/gms)].map((m) => m[1]).sort(),
    ['./graph-admission.js'],
    'reconstruction grew a dependency — replay must stay a pure function of graph, admission, and journal',
  );
  for (const forbidden of ['process.env', 'readFileSync', 'Date.now', 'new Date(', 'fetch(', 'Math.random', 'edgeSatisfied']) {
    assert.equal(source.includes(forbidden), false, `graph-resume references ${forbidden}`);
  }
});
