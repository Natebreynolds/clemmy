/**
 * Run: npx tsx --test src/runtime/graph/graph-executor-contract.test.ts
 *
 * The durable-contract pins from the charter's sixteen-gap review. The pure
 * walker's behavior is pinned in graph-executor.test.ts; THIS file pins what
 * an ADMITTED run must additionally guarantee: identity-bound reuse, a durable
 * claim before dispatch, settlement durability before dependents advance,
 * typed infrastructure semantics, cancellation, injected time, deterministic
 * wave parking, and a terminal verdict that is never inferred from quiescence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { admitGraph, computeNodeDigest, type AdmittedBudget, type GraphAdmission } from './graph-admission.js';
import type { GraphJournalEntry, NodeSettledEntry } from './graph-journal.js';
import {
  runGraph,
  type ExecutableGraph,
  type NodeOutcome,
  type NodeRunner,
} from './graph-executor.js';

const CHAIN: ExecutableGraph = {
  graphId: 'chain',
  nodes: [{ id: 'a', kind: 'step' }, { id: 'b', kind: 'step' }, { id: 'c', kind: 'step' }],
  edges: [
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'b', target: 'c' },
  ],
};

const BUDGET: AdmittedBudget = {
  maxNodes: 100, maxWaves: 100, maxConcurrency: 4, maxElapsedMs: 60_000, maxExpansions: 0,
};

function admitted(graph: ExecutableGraph = CHAIN, budget: AdmittedBudget = BUDGET): GraphAdmission {
  const result = admitGraph({
    graph, compilerVersion: 'c1', policyHash: 'p1', catalogHash: 'k1', budget,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).admission;
}

/** In-memory adapter that records everything and can fail on command. */
function memoryAdapter(failOn?: (entry: GraphJournalEntry) => boolean) {
  const entries: GraphJournalEntry[] = [];
  const sequence: string[] = [];
  return {
    entries,
    sequence,
    adapter: {
      async append(entry: GraphJournalEntry): Promise<void> {
        if (failOn?.(entry)) throw new Error('durable store unavailable');
        entries.push(entry);
        sequence.push(`journal:${entry.type}:${'nodeId' in entry ? entry.nodeId : entry.emittedBy}`);
      },
    },
  };
}

function completingRunner(sequence: string[], outcomes: Record<string, NodeOutcome> = {}): NodeRunner {
  return {
    run: (node) => {
      sequence.push(`run:${node.id}`);
      return outcomes[node.id] ?? { status: 'completed', outputRef: `art-${node.id}` };
    },
  };
}

const CLOCK = () => 1_000; // frozen injected time; the executor never reads one

// ── durability ordering ──────────────────────────────────────────────────────

test('the durable claim precedes dispatch, and settlement precedes dependents', async () => {
  const { adapter, sequence } = memoryAdapter();
  const result = await runGraph(CHAIN, {
    runner: completingRunner(sequence),
    admission: admitted(),
    journalAdapter: adapter,
    clock: CLOCK,
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(sequence, [
    'journal:node_started:a', 'run:a', 'journal:node_settled:a',
    'journal:node_started:b', 'run:b', 'journal:node_settled:b',
    'journal:node_started:c', 'run:c', 'journal:node_settled:c',
  ], 'a runner was dispatched before its durable claim, or a dependent advanced before settlement was durable');
});

test('a failed settle append halts the run — dependents never advance past it', async () => {
  const { adapter, sequence } = memoryAdapter(
    (entry) => entry.type === 'node_settled' && entry.nodeId === 'b',
  );
  const result = await runGraph(CHAIN, {
    runner: completingRunner(sequence),
    admission: admitted(),
    journalAdapter: adapter,
    clock: CLOCK,
  });
  assert.equal(result.status, 'halted');
  assert.match(result.haltReason ?? '', /settling "b"/);
  assert.equal(sequence.includes('run:c'), false,
    'a dependent ran even though its predecessor settlement was never durable');
});

test('a failed claim append halts BEFORE the runner is invoked', async () => {
  const { adapter, sequence } = memoryAdapter(
    (entry) => entry.type === 'node_started' && entry.nodeId === 'b',
  );
  const result = await runGraph(CHAIN, {
    runner: completingRunner(sequence),
    admission: admitted(),
    journalAdapter: adapter,
    clock: CLOCK,
  });
  assert.equal(result.status, 'halted');
  assert.equal(sequence.includes('run:b'), false,
    'the runner ran without a durable claim — a crash there is an untracked side effect');
});

// ── identity-bound reuse ─────────────────────────────────────────────────────

function settledEntry(
  admission: GraphAdmission,
  nodeId: string,
  over: Partial<NodeSettledEntry> = {},
): NodeSettledEntry {
  return {
    type: 'node_settled',
    admissionDigest: admission.admissionDigest,
    nodeId,
    nodeDigest: computeNodeDigest({ id: nodeId, kind: 'step' }),
    inputDigest: 'any',
    attemptId: `prior-${nodeId}`,
    wave: 0,
    status: 'completed',
    ...over,
  };
}

test('a reused node restores its artifact refs at zero dispatch cost', async () => {
  const admission = admitted();
  const { adapter, sequence } = memoryAdapter();
  const seenPredecessors: Record<string, unknown> = {};
  const result = await runGraph(CHAIN, {
    runner: {
      run: (node, context) => {
        sequence.push(`run:${node.id}`);
        seenPredecessors[node.id] = context.predecessors;
        return { status: 'completed' };
      },
    },
    admission,
    journalAdapter: adapter,
    clock: CLOCK,
    resumeEntries: [
      settledEntry(admission, 'a', { outputRef: 'art-a', evidenceRefs: ['ev-a'] }),
    ],
  });
  assert.equal(result.status, 'completed');
  assert.equal(sequence.includes('run:a'), false, 'a journaled completion was re-dispatched');
  // The reused settlement's refs flow to the successor — typed data flow
  // survives restart.
  assert.deepEqual(seenPredecessors.b, [{ nodeId: 'a', outputRef: 'art-a', evidenceRefs: ['ev-a'] }]);
  assert.equal(result.trace.find((t) => t.nodeId === 'a')?.reused, true);
});

test('a changed node definition refuses reuse — same id, different work', async () => {
  const admission = admitted();
  const { adapter, sequence } = memoryAdapter();
  const result = await runGraph(CHAIN, {
    runner: completingRunner(sequence),
    admission,
    journalAdapter: adapter,
    clock: CLOCK,
    resumeEntries: [
      settledEntry(admission, 'a', { nodeDigest: 'digest-of-an-older-definition' }),
    ],
  });
  assert.equal(result.status, 'completed');
  assert.equal(sequence.includes('run:a'), true,
    'a settlement whose node digest does not match the current definition was reused');
});

test('a journal from another admission refuses the whole resume', async () => {
  const admission = admitted();
  const { adapter } = memoryAdapter();
  const foreign = settledEntry(admission, 'a');
  const result = await runGraph(CHAIN, {
    runner: completingRunner([]),
    admission,
    journalAdapter: adapter,
    clock: CLOCK,
    resumeEntries: [{ ...foreign, admissionDigest: 'someone-elses-run' }],
  });
  assert.equal(result.status, 'halted');
  assert.match(result.haltReason ?? '', /resume refused/);
});

test('an admitted run refuses the node-id journal and missing ports', async () => {
  const admission = admitted();
  const { adapter } = memoryAdapter();

  const idJournal = await runGraph(CHAIN, {
    runner: completingRunner([]), admission, journalAdapter: adapter, clock: CLOCK,
    journal: ['a'],
  });
  assert.equal(idJournal.status, 'halted', 'node-id reuse identity was accepted under admission');

  const noAdapter = await runGraph(CHAIN, { runner: completingRunner([]), admission, clock: CLOCK });
  assert.equal(noAdapter.status, 'halted');
  assert.match(noAdapter.haltReason ?? '', /journal adapter/);

  const noClock = await runGraph(CHAIN, { runner: completingRunner([]), admission, journalAdapter: adapter });
  assert.equal(noClock.status, 'halted');
  assert.match(noClock.haltReason ?? '', /clock/);
});

// ── outcome semantics ────────────────────────────────────────────────────────

test('a throwing runner is a typed infrastructure failure, never a torn-down run', async () => {
  const graph: ExecutableGraph = {
    graphId: 'throwing',
    nodes: [{ id: 'boom', kind: 'step' }, { id: 'recover', kind: 'step' }, { id: 'other-root', kind: 'step' }],
    edges: [{ id: 'bad', source: 'boom', target: 'recover', when: 'failure' }],
  };
  const result = await runGraph(graph, {
    runner: {
      run: (node) => {
        if (node.id === 'boom') throw new Error('ECONNRESET');
        return { status: 'completed' };
      },
    },
  });
  assert.equal(result.status, 'completed', 'a runner exception tore down the executor');
  assert.deepEqual(result.failed, ['boom']);
  assert.deepEqual(result.completed, ['other-root'], 'independent work stopped because an unrelated runner threw');
  // Infrastructure is not evidence about the work: the failure edge stays shut.
  assert.deepEqual(result.unreached, ['recover'],
    'an infrastructure failure routed recovery topology as though the node itself had failed');
});

test('a node-logic failure still routes failure edges — the distinction is the class', async () => {
  const graph: ExecutableGraph = {
    graphId: 'node-fail',
    nodes: [{ id: 'attempt', kind: 'step' }, { id: 'recover', kind: 'step' }],
    edges: [{ id: 'bad', source: 'attempt', target: 'recover', when: 'failure' }],
  };
  const result = await runGraph(graph, {
    runner: {
      run: (node) => (node.id === 'attempt'
        ? { status: 'failed', reason: 'validation refused', settlementClass: 'node' }
        : { status: 'completed' }),
    },
  });
  assert.deepEqual(result.completed, ['recover']);
});

test('cancellation stops dispatch at the next boundary and is its own status', async () => {
  const signal = { aborted: false };
  const dispatched: string[] = [];
  const result = await runGraph(CHAIN, {
    runner: {
      run: (node) => {
        dispatched.push(node.id);
        if (node.id === 'a') signal.aborted = true;
        return { status: 'completed' };
      },
    },
    signal,
  });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(dispatched, ['a'], 'dispatch continued after the cancellation signal');
  assert.deepEqual(result.completed, ['a'], 'completed work was not preserved across cancellation');
});

// ── budgets and time ─────────────────────────────────────────────────────────

test('elapsed time is measured by the injected clock, never observed', async () => {
  let now = 0;
  const result = await runGraph(CHAIN, {
    runner: {
      run: () => {
        now += 40_000; // each node "takes" 40s on the injected clock
        return { status: 'completed' };
      },
    },
    admission: admitted(CHAIN, { ...BUDGET, maxElapsedMs: 50_000 }),
    journalAdapter: memoryAdapter().adapter,
    clock: () => now,
  });
  assert.equal(result.status, 'budget_exhausted');
  // The ceiling parks at the next wave boundary: `b` was dispatched at 40s
  // elapsed, legally under the 50s ceiling, and in-flight work is never
  // killed retroactively. What the ceiling guarantees is that NOTHING is
  // dispatched after it is crossed — `c` never runs.
  assert.deepEqual(result.completed, ['a', 'b']);
  assert.deepEqual(result.unreached, ['c'], 'work was dispatched after the elapsed ceiling was crossed');
});

test('a wave that would exceed the node budget parks BEFORE dispatching any of it', async () => {
  const wide: ExecutableGraph = {
    graphId: 'wide',
    nodes: [
      { id: 'root', kind: 'step' },
      { id: 'w1', kind: 'step' }, { id: 'w2', kind: 'step' }, { id: 'w3', kind: 'step' },
    ],
    edges: [
      { id: 'e1', source: 'root', target: 'w1' },
      { id: 'e2', source: 'root', target: 'w2' },
      { id: 'e3', source: 'root', target: 'w3' },
    ],
  };
  const dispatched: string[] = [];
  const result = await runGraph(wide, {
    runner: { run: (node) => { dispatched.push(node.id); return { status: 'completed' }; } },
    budget: { maxNodes: 2, maxConcurrency: 4 },
  });
  assert.equal(result.status, 'budget_exhausted');
  // Deterministic parking: the whole wave waits — no arbitrary half-wave.
  assert.deepEqual(dispatched, ['root'], 'part of a wave was dispatched past the node budget');
});

// ── terminal reduction ───────────────────────────────────────────────────────

test('quiescence is not success: the injected reducer owns the verdict', async () => {
  const graph: ExecutableGraph = {
    graphId: 'verdict',
    nodes: [{ id: 'a', kind: 'step' }, { id: 'b', kind: 'step' }],
    edges: [{ id: 'e1', source: 'a', target: 'b' }],
  };
  const result = await runGraph(graph, {
    runner: { run: () => ({ status: 'failed', reason: 'nope' }) },
    terminalReducer: (run) => (
      run.failed.length > 0
        ? { status: 'failed', reason: `${run.failed.length} node(s) failed` }
        : { status: 'success' }
    ),
  });
  // The scheduler quiesced — and the TERMINAL says failed. No caller can map
  // run.status to public success without going through the reducer.
  assert.equal(result.status, 'completed');
  assert.equal(result.terminal?.status, 'failed');
  assert.match(result.terminal?.reason ?? '', /1 node\(s\) failed/);

  const withoutReducer = await runGraph(graph, {
    runner: { run: () => ({ status: 'failed', reason: 'nope' }) },
  });
  assert.equal(withoutReducer.terminal, undefined, 'a terminal appeared without a reducer to produce it');
});

// ── the journal is complete evidence ─────────────────────────────────────────

test('the journal alone reconstructs the run: claims, settlements, refs, classes', async () => {
  const admission = admitted();
  const { adapter, entries } = memoryAdapter();
  await runGraph(CHAIN, {
    runner: completingRunner([], {
      c: { status: 'failed', reason: 'provider 500', settlementClass: 'node' },
    }),
    admission,
    journalAdapter: adapter,
    clock: CLOCK,
  });
  const started = entries.filter((entry) => entry.type === 'node_started');
  const settledEntries = entries.filter((entry) => entry.type === 'node_settled');
  assert.equal(started.length, 3);
  assert.equal(settledEntries.length, 3);
  for (const entry of settledEntries) {
    assert.equal(entry.admissionDigest, admission.admissionDigest);
    assert.match(entry.attemptId, /^attempt-\d+$/);
  }
  const settledC = settledEntries.find((entry) => entry.type === 'node_settled' && entry.nodeId === 'c');
  assert.equal(settledC?.type === 'node_settled' && settledC.status, 'failed');
  assert.equal(settledC?.type === 'node_settled' && settledC.settlementClass, 'node');
  const settledA = settledEntries.find((entry) => entry.type === 'node_settled' && entry.nodeId === 'a');
  assert.equal(settledA?.type === 'node_settled' && settledA.outputRef, 'art-a',
    'the settled artifact ref was not journaled — restart would lose data flow');
});
