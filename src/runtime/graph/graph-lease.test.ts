/**
 * Run: npx tsx --test src/runtime/graph/graph-lease.test.ts
 *
 * R1B/B3 biting suite: leases, fencing, and active cancellation. Exactly one
 * owner dispatches a node at a time; a reclaim after proven expiry carries a
 * strictly higher fence; a settlement from a superseded fence is rejected at
 * the durable boundary; the active runner receives a real AbortSignal and a
 * post-abort outcome settles as a typed durable cancellation; budget parking
 * releases every held lease.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { admitGraph, type AdmittedBudget, type GraphAdmission } from './graph-admission.js';
import {
  createLeaseManager,
  withNodeLeases,
  type LeaseRecord,
  type LeaseStorePort,
} from './graph-lease.js';
import type { GraphJournalEntry, NodeSettledEntry } from './graph-journal.js';
import { runGraph, type ExecutableGraph, type NodeOutcome, type NodeRunner } from './graph-executor.js';

const BUDGET: AdmittedBudget = {
  maxNodes: 100, maxWaves: 100, maxConcurrency: 4, maxElapsedMs: 60_000, maxExpansions: 0,
};

const AB: ExecutableGraph = {
  graphId: 'leased',
  nodes: [{ id: 'a', kind: 'step' }, { id: 'b', kind: 'step' }],
  edges: [{ id: 'e-ab', source: 'a', target: 'b' }],
};

function admitted(graph: ExecutableGraph = AB, budget: AdmittedBudget = BUDGET): GraphAdmission {
  const result = admitGraph({
    graph, compilerVersion: 'c1', policyHash: 'p1', catalogHash: 'k1', budget,
  });
  assert.equal(result.ok, true);
  return (result as Extract<typeof result, { ok: true }>).admission;
}

/** In-memory CAS lease store — atomic within one event loop, like a real CAS. */
function memoryLeaseStore(): LeaseStorePort & { dump(): Map<string, LeaseRecord> } {
  const records = new Map<string, LeaseRecord>();
  return {
    async read(key) { return records.get(key); },
    async cas(key, expected, next) {
      const current = records.get(key);
      if (expected === undefined
        ? current !== undefined
        : current?.fence !== expected.fence || current?.revision !== expected.revision) {
        return false;
      }
      records.set(key, next);
      return true;
    },
    dump() { return records; },
  };
}

function attempts(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

function journalAdapter() {
  const entries: GraphJournalEntry[] = [];
  return { entries, adapter: { async append(entry: GraphJournalEntry) { entries.push(entry); } } };
}

// ─── the manager contract ────────────────────────────────────────────────────

test('two owners, one lease: the loser is told who holds it, and a live lease never transfers', async () => {
  const store = memoryLeaseStore();
  const clock = { now: 1_000 };
  const one = createLeaseManager({ store, owner: 'activation-1', clock: () => clock.now, ttlMs: 5_000 });
  const two = createLeaseManager({ store, owner: 'activation-2', clock: () => clock.now, ttlMs: 5_000 });

  const first = await one.acquire('node:a');
  assert.deepEqual(first, { ok: true, fence: 1 });
  const contested = await two.acquire('node:a');
  assert.equal(contested.ok, false);
  assert.equal((contested as Extract<typeof contested, { ok: false }>).heldBy, 'activation-1');
  // Re-entry by the holder is idempotent at the same fence.
  assert.deepEqual(await one.acquire('node:a'), { ok: true, fence: 1 });
});

test('reclaim only after proven expiry, with a strictly higher fence', async () => {
  const store = memoryLeaseStore();
  const clock = { now: 1_000 };
  const one = createLeaseManager({ store, owner: 'activation-1', clock: () => clock.now, ttlMs: 5_000 });
  const two = createLeaseManager({ store, owner: 'activation-2', clock: () => clock.now, ttlMs: 5_000 });
  await one.acquire('node:a');
  clock.now = 5_999; // not yet expired
  assert.equal((await two.acquire('node:a')).ok, false, 'an unexpired lease was reclaimed');
  clock.now = 6_001; // provably expired
  const reclaimed = await two.acquire('node:a');
  assert.deepEqual(reclaimed, { ok: true, fence: 2 }, 'reclaim must carry a strictly higher fence');
  assert.equal(await one.holds('node:a', 1), false, 'the old owner still believes it holds the lease');
});

test('renewal extends only the exact owner+fence, and a crash-restart preserves one owner', async () => {
  const store = memoryLeaseStore();
  const clock = { now: 0 };
  const one = createLeaseManager({ store, owner: 'activation-1', clock: () => clock.now, ttlMs: 1_000 });
  await one.acquire('node:a');
  clock.now = 900;
  assert.equal((await one.renew('node:a', 1)).ok, true);
  clock.now = 1_800; // inside the renewed window
  assert.equal(await one.holds('node:a', 1), true, 'renewal did not extend the lease');
  assert.equal((await one.renew('node:a', 7)).ok, false, 'a wrong fence renewed');

  // Crash + restart as a NEW activation: reclaim happens only after expiry,
  // and the store never shows two live owners.
  const restarted = createLeaseManager({ store, owner: 'activation-1b', clock: () => clock.now, ttlMs: 1_000 });
  assert.equal((await restarted.acquire('node:a')).ok, false, 'a live lease transferred during restart');
  clock.now = 2_001;
  const reclaimed = await restarted.acquire('node:a');
  assert.deepEqual(reclaimed, { ok: true, fence: 2 });
  const live = [...store.dump().values()].filter((record) => !record.released && record.expiresAt > clock.now);
  assert.equal(live.length, 1, 'two live owners exist');
});

// ─── the durable boundary integration ────────────────────────────────────────

test('a leased run acquires per node, settles, and releases — including patched workers joining a compiled reducer', async () => {
  const planner = { id: 'planner', kind: 'planner' };
  const reducer = { id: 'reducer', kind: 'reduce' };
  const graph: ExecutableGraph = {
    graphId: 'leased-patch', nodes: [planner, reducer],
    edges: [{ id: 'e-pr', source: 'planner', target: 'reducer' }],
  };
  const admission = admitted(graph, { ...BUDGET, maxExpansions: 1 });
  const store = memoryLeaseStore();
  const manager = createLeaseManager({ store, owner: 'activation-1', clock: () => 0, ttlMs: 60_000 });
  const { entries, adapter } = journalAdapter();
  const leased = withNodeLeases(adapter, manager);
  const result = await runGraph(graph, {
    runner: {
      run: (node): NodeOutcome => (node.id === 'planner'
        ? {
            status: 'completed',
            outputRef: 'plan',
            emitPatch: {
              nodes: [{ id: 'w1', kind: 'worker' }],
              edges: [
                { id: 'p-w1', source: 'planner', target: 'w1' },
                { id: 'j-w1', source: 'w1', target: 'reducer' },
              ],
            },
          }
        : { status: 'completed' }),
    },
    admission, journalAdapter: leased, clock: () => 0,
    patchAdmitter: () => ({ ok: true }),
    attemptIds: attempts('a'),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual([...result.completed].sort(), ['planner', 'reducer', 'w1']);
  assert.equal(entries.filter((e) => e.type === 'node_settled').length, 3);
  for (const record of store.dump().values()) {
    assert.equal(record.released, true, 'a settled node still holds its lease');
  }
});

test('two-owner race at the durable boundary: the loser halts before its claim becomes durable', async () => {
  const admission = admitted();
  const store = memoryLeaseStore();
  const clock = { now: 0 };
  const winner = createLeaseManager({ store, owner: 'activation-1', clock: () => clock.now, ttlMs: 60_000 });
  await winner.acquire('node:a'); // the other activation already runs `a`
  const loser = createLeaseManager({ store, owner: 'activation-2', clock: () => clock.now, ttlMs: 60_000 });
  const { entries, adapter } = journalAdapter();
  let ran = 0;
  const result = await runGraph(AB, {
    runner: { run: (): NodeOutcome => { ran += 1; return { status: 'completed' }; } },
    admission, journalAdapter: withNodeLeases(adapter, loser), clock: () => 0,
    attemptIds: attempts('b'),
  });
  assert.equal(result.status, 'halted');
  assert.match(result.haltReason ?? '', /lease unavailable .* live-leased by "activation-1"/s);
  assert.equal(ran, 0, 'the loser dispatched work another owner holds');
  // The losing activation's HEADER may land (it claims nothing); what must
  // never land is a node claim or settlement.
  assert.equal(entries.some((e) => e.type === 'node_started' || e.type === 'node_settled'), false,
    'the losing claim became durable');
});

test('a late settlement from a superseded fence is rejected before it rewrites history', async () => {
  const admission = admitted();
  const store = memoryLeaseStore();
  const clock = { now: 0 };
  const one = createLeaseManager({ store, owner: 'activation-1', clock: () => clock.now, ttlMs: 1_000 });
  const two = createLeaseManager({ store, owner: 'activation-2', clock: () => clock.now, ttlMs: 60_000 });
  const { entries, adapter } = journalAdapter();
  const result = await runGraph(AB, {
    runner: {
      run: async (node): Promise<NodeOutcome> => {
        if (node.id === 'a') {
          // While `a` runs, its lease expires and a new activation reclaims it.
          clock.now = 5_000;
          const reclaimed = await two.acquire('node:a');
          assert.equal(reclaimed.ok, true);
        }
        return { status: 'completed' };
      },
    },
    admission, journalAdapter: withNodeLeases(adapter, one), clock: () => 0,
    attemptIds: attempts('a'),
  });
  assert.equal(result.status, 'halted', 'a late old owner settled after reclaim');
  assert.match(result.haltReason ?? '', /stale fence/);
  assert.equal(entries.some((e) => e.type === 'node_settled'), false,
    'the superseded settlement reached the journal');
});

test('budget parking releases every held lease — a parked run holds nothing', async () => {
  const admission = admitted(AB, { ...BUDGET, maxNodes: 1 });
  const store = memoryLeaseStore();
  const manager = createLeaseManager({ store, owner: 'activation-1', clock: () => 0, ttlMs: 60_000 });
  const leased = withNodeLeases(journalAdapter().adapter, manager);
  const result = await runGraph(AB, {
    runner: { run: (): NodeOutcome => ({ status: 'completed' }) },
    admission, journalAdapter: leased, clock: () => 0, attemptIds: attempts('a'),
  });
  assert.equal(result.status, 'budget_exhausted');
  await leased.releaseAll(); // the caller's park boundary
  const two = createLeaseManager({ store, owner: 'activation-2', clock: () => 0, ttlMs: 60_000 });
  assert.equal((await two.acquire('node:a')).ok, true,
    'a parked run still holds a lease another activation cannot take');
});

// ─── active cancellation ─────────────────────────────────────────────────────

test('the ACTIVE runner receives a real AbortSignal, and the post-abort outcome journals as a typed cancellation', async () => {
  const admission = admitted();
  const controller = new AbortController();
  const { entries, adapter } = journalAdapter();
  let sawSignal: AbortSignal | undefined;
  let abortedDuringRun = false;
  const runner: NodeRunner = {
    run: async (node, context): Promise<NodeOutcome> => {
      sawSignal = context.signal;
      if (node.id === 'a') {
        controller.abort(); // cancellation lands MID-RUN, not between waves
        abortedDuringRun = context.signal?.aborted === true;
      }
      return { status: 'completed', outputRef: 'art' };
    },
  };
  const result = await runGraph(AB, {
    runner, admission, journalAdapter: adapter, clock: () => 0,
    signal: controller.signal, attemptIds: attempts('a'),
  });
  assert.ok(sawSignal instanceof AbortSignal, 'the active runner never received the AbortSignal');
  assert.equal(abortedDuringRun, true, 'the in-flight runner could not observe cancellation');
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.completed, [], 'post-abort work committed success');
  const settled = entries.find(
    (e): e is NodeSettledEntry => e.type === 'node_settled' && e.nodeId === 'a',
  );
  assert.equal(settled?.status, 'cancelled', 'cancellation was not journaled as a first-class status');
  assert.deepEqual(settled?.firedEdgeIds, [], 'a cancelled settlement routed topology');
  assert.ok(result.unreached.includes('b'), 'work advanced past a cancellation');
});
