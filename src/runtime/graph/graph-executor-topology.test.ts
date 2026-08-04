/**
 * Run: npx tsx --test src/runtime/graph/graph-executor-topology.test.ts
 *
 * Dynamic topology: the charter's fan-out rule made executable. A planner node
 * emits one identity-bound sibling per item AFTER the canonical item manifest
 * exists — never cloned from an estimated count — plus a reducer that joins
 * them. The patch is validated, authority-checked, budget-debited, and durable
 * before any child starts; an emission that cannot be admitted fails the
 * EMITTER as node logic so recovery is expressible as topology; and a resumed
 * run reconstructs the grown graph from the journal alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { admitGraph, type AdmittedBudget, type GraphAdmission } from './graph-admission.js';
import type { GraphJournalEntry } from './graph-journal.js';
import {
  runGraph,
  type ExecutableEdge,
  type ExecutableGraph,
  type ExecutableNode,
  type NodeRunner,
} from './graph-executor.js';

/** planner → (emits N workers + reducer at runtime) */
const PLANNER_GRAPH: ExecutableGraph = {
  graphId: 'fanout',
  nodes: [{ id: 'manifest', kind: 'step' }, { id: 'planner', kind: 'planner' }],
  edges: [{ id: 'e1', source: 'manifest', target: 'planner' }],
};

const BUDGET: AdmittedBudget = {
  maxNodes: 5_000, maxWaves: 100, maxConcurrency: 8, maxElapsedMs: 600_000, maxExpansions: 2,
};

function admitted(graph: ExecutableGraph = PLANNER_GRAPH, budget: AdmittedBudget = BUDGET): GraphAdmission {
  const result = admitGraph({
    graph, compilerVersion: 'c1', policyHash: 'p1', catalogHash: 'k1', budget,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).admission;
}

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

/** Emits `count` per-item workers plus one reducer joining them. */
function fanoutPatch(count: number): { nodes: ExecutableNode[]; edges: ExecutableEdge[] } {
  const workers = Array.from({ length: count }, (_, i) => ({ id: `item-${i}`, kind: 'worker' }));
  const nodes: ExecutableNode[] = [...workers, { id: 'reduce', kind: 'reduce' }];
  const edges: ExecutableEdge[] = [
    ...workers.map((w) => ({ id: `spawn-${w.id}`, source: 'planner', target: w.id })),
    ...workers.map((w) => ({ id: `join-${w.id}`, source: w.id, target: 'reduce' })),
  ];
  return { nodes, edges };
}

function planningRunner(sequence: string[], count: number): NodeRunner {
  return {
    run: (node) => {
      sequence.push(`run:${node.id}`);
      if (node.id === 'planner') {
        // The manifest EXISTS (the predecessor produced it); the planner emits
        // one sibling per actual item — never a clone of an estimate.
        return { status: 'completed', emitPatch: fanoutPatch(count) };
      }
      return { status: 'completed', outputRef: `art-${node.id}` };
    },
  };
}

const CLOCK = () => 0;
const ALLOW_ALL = () => ({ ok: true as const });

// ── the fan-out the goal describes ──────────────────────────────────────────

test('a planner emits per-item siblings and a reducer joins them', async () => {
  const { adapter, sequence } = memoryAdapter();
  const result = await runGraph(PLANNER_GRAPH, {
    runner: planningRunner(sequence, 12),
    admission: admitted(),
    journalAdapter: adapter,
    clock: CLOCK,
    patchAdmitter: ALLOW_ALL,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.completed.length, 2 + 12 + 1, 'not every emitted node ran');
  assert.equal(result.patches.length, 1);

  // The twelve workers share ONE wave — this is the topology the chat
  // compiler's multiplicity metadata could never produce.
  const workerWaves = new Set(
    result.trace.filter((t) => t.kind === 'worker').map((t) => t.wave),
  );
  assert.equal(workerWaves.size, 1, 'workers did not fan out into one wave');
  const reduceEntry = result.trace.find((t) => t.nodeId === 'reduce');
  assert.ok((reduceEntry?.wave ?? 0) > [...workerWaves][0]!, 'the reducer did not wait for the workers');
});

test('the patch is durable BEFORE any child starts', async () => {
  const { adapter, sequence } = memoryAdapter();
  await runGraph(PLANNER_GRAPH, {
    runner: planningRunner(sequence, 3),
    admission: admitted(),
    journalAdapter: adapter,
    clock: CLOCK,
    patchAdmitter: ALLOW_ALL,
  });
  const patchAt = sequence.indexOf('journal:patch_admitted:planner');
  const firstChildStart = sequence.findIndex((s) => s.startsWith('journal:node_started:item-'));
  assert.ok(patchAt >= 0, 'the patch was never journaled');
  assert.ok(firstChildStart > patchAt, 'a child was claimed before its patch was durable');
});

test('a failed patch append halts before any child exists', async () => {
  const { adapter, sequence } = memoryAdapter((entry) => entry.type === 'patch_admitted');
  const result = await runGraph(PLANNER_GRAPH, {
    runner: planningRunner(sequence, 3),
    admission: admitted(),
    journalAdapter: adapter,
    clock: CLOCK,
    patchAdmitter: ALLOW_ALL,
  });
  assert.equal(result.status, 'halted');
  assert.equal(sequence.some((s) => s.includes('item-')), false,
    'a child ran although its patch never became durable');
});

// ── refusals fail the emitter as node logic ─────────────────────────────────

test('an invalid emission fails the EMITTER and can route recovery topology', async () => {
  const graph: ExecutableGraph = {
    graphId: 'bad-emit',
    nodes: [{ id: 'planner', kind: 'planner' }, { id: 'replan', kind: 'step' }],
    edges: [{ id: 'r1', source: 'planner', target: 'replan', when: 'failure' }],
  };
  const result = await runGraph(graph, {
    runner: {
      run: (node) => (node.id === 'planner'
        ? {
            status: 'completed',
            // Redefines an existing node — structurally invalid.
            emitPatch: { nodes: [{ id: 'replan', kind: 'step' }], edges: [] },
          }
        : { status: 'completed' }),
    },
  });
  assert.deepEqual(result.failed, ['planner'], 'an invalid emission did not fail the emitter');
  assert.deepEqual(result.completed, ['replan'], 'the failure edge did not route recovery');
  assert.equal(result.patches.length, 0);
});

test('the expansion budget debits, and exhaustion refuses further growth', async () => {
  const graph: ExecutableGraph = {
    graphId: 'greedy',
    nodes: [{ id: 'p1', kind: 'planner' }, { id: 'p2', kind: 'planner' }],
    edges: [],
  };
  const result = await runGraph(graph, {
    runner: {
      run: (node) => (node.kind === 'planner'
        ? {
            status: 'completed',
            emitPatch: {
              nodes: [{ id: `child-of-${node.id}`, kind: 'worker' }],
              edges: [{ id: `spawn-${node.id}`, source: node.id, target: `child-of-${node.id}` }],
            },
          }
        : { status: 'completed' }),
    },
    admission: admitted(graph, { ...BUDGET, maxExpansions: 1 }),
    journalAdapter: memoryAdapter().adapter,
    clock: CLOCK,
    patchAdmitter: ALLOW_ALL,
  });
  assert.equal(result.patches.length, 1, 'the expansion budget did not debit');
  assert.deepEqual(result.failed, ['p2'], 'a beyond-budget emission did not fail its emitter');
  assert.match(
    result.trace.find((t) => t.nodeId === 'p2')?.reason ?? '',
    /expansion budget exhausted/,
  );
});

test('the injected admitter can veto — authority is not the executor to decide', async () => {
  const { adapter, entries } = memoryAdapter();
  const result = await runGraph(PLANNER_GRAPH, {
    runner: planningRunner([], 3),
    admission: admitted(),
    journalAdapter: adapter,
    clock: CLOCK,
    patchAdmitter: () => ({ ok: false, reason: 'workers would widen the write class' }),
  });
  assert.deepEqual(result.failed, ['planner']);
  assert.equal(entries.some((entry) => entry.type === 'patch_admitted'), false,
    'a vetoed patch was journaled as admitted');
});

test('an admitted run that allows expansions must supply an admitter', async () => {
  const result = await runGraph(PLANNER_GRAPH, {
    runner: planningRunner([], 3),
    admission: admitted(),
    journalAdapter: memoryAdapter().adapter,
    clock: CLOCK,
    // no patchAdmitter
  });
  assert.equal(result.status, 'halted');
  assert.match(result.haltReason ?? '', /patch admitter/);
});

// ── resume reconstructs the grown graph from the journal alone ──────────────

test('resume replays the patch and reuses completed children', async () => {
  const admission = admitted();
  const first = memoryAdapter(
    // Crash while settling item-2: its start is journaled, settlement is not.
    (entry) => entry.type === 'node_settled' && entry.nodeId === 'item-2',
  );
  const firstRun = await runGraph(PLANNER_GRAPH, {
    runner: planningRunner(first.sequence, 3),
    admission,
    journalAdapter: first.adapter,
    clock: CLOCK,
    patchAdmitter: ALLOW_ALL,
  });
  assert.equal(firstRun.status, 'halted');

  const second = memoryAdapter();
  const resumedSequence: string[] = [];
  const resumed = await runGraph(PLANNER_GRAPH, {
    runner: planningRunner(resumedSequence, 3),
    admission,
    journalAdapter: second.adapter,
    clock: CLOCK,
    patchAdmitter: ALLOW_ALL,
    resumeEntries: first.entries,
  });
  assert.equal(resumed.status, 'completed', resumed.haltReason ?? '');
  assert.equal(resumed.completed.length, 2 + 3 + 1);
  // The planner and the settled children are reused; only the crashed child
  // and the reducer actually run.
  assert.deepEqual(resumedSequence, ['run:item-2', 'run:reduce'],
    'resume re-ran work the journal already proved');
  assert.equal(resumed.patches.length, 1, 'the journaled patch did not replay');
});

test('a tampered journaled patch refuses resume', async () => {
  const admission = admitted();
  const store = memoryAdapter();
  await runGraph(PLANNER_GRAPH, {
    runner: planningRunner([], 3),
    admission,
    journalAdapter: store.adapter,
    clock: CLOCK,
    patchAdmitter: ALLOW_ALL,
  });
  const tampered = store.entries.map((entry) => (
    entry.type === 'patch_admitted'
      ? { ...entry, nodes: [...entry.nodes, { id: 'smuggled', kind: 'worker' }] }
      : entry
  ));
  const resumed = await runGraph(PLANNER_GRAPH, {
    runner: planningRunner([], 3),
    admission,
    journalAdapter: memoryAdapter().adapter,
    clock: CLOCK,
    patchAdmitter: ALLOW_ALL,
    resumeEntries: tampered,
  });
  assert.equal(resumed.status, 'halted', 'tampered patch content was replayed');
  assert.match(resumed.haltReason ?? '', /does not match its digest/);
});

// ── scale: the harness is not the ceiling ───────────────────────────────────

test('a 1,000-item fan-out runs under bounded concurrency', async () => {
  const { adapter } = memoryAdapter();
  const result = await runGraph(PLANNER_GRAPH, {
    runner: planningRunner([], 1_000),
    admission: admitted(PLANNER_GRAPH, { ...BUDGET, maxNodes: 2_000 }),
    journalAdapter: adapter,
    clock: CLOCK,
    patchAdmitter: ALLOW_ALL,
  });
  assert.equal(result.status, 'completed', result.haltReason ?? result.stalledDetail ?? '');
  assert.equal(result.completed.length, 2 + 1_000 + 1,
    'the topology was capped somewhere below the admitted budget');
  // Concurrency bounds PACING, never the amount of work: every worker ran.
  const workerCount = result.trace.filter((t) => t.kind === 'worker').length;
  assert.equal(workerCount, 1_000);
});
