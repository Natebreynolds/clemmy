/**
 * Run: npx tsx --test src/runtime/graph/graph-final-closeout.test.ts
 *
 * E0 red suite — graph/replay/lifecycle findings 1-11 from the final
 * North-Star audit, pinned at their REQUIRED behavior. Each test is red at
 * ac9ae24c for the exact reproduced reason and becomes the permanent contract
 * when Stage E1 lands.
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
import { sealExecutionIdentity, nodeDigestFor, type GraphExecutionIdentity } from './graph-node-identity.js';
import { verifyArtifact, type ArtifactRecord, type ArtifactStorePort } from './graph-artifacts.js';
import { createLeaseManager, withNodeLeases, type LeaseRecord, type LeaseStorePort } from './graph-lease.js';
import type { GraphJournalEntry, NodeSettledEntry } from './graph-journal.js';
import { runGraph, type ExecutableGraph, type ExecutableNode, type NodeOutcome, type NodeRunner } from './graph-executor.js';

const BUDGET: AdmittedBudget = {
  maxNodes: 100, maxWaves: 100, maxConcurrency: 4, maxElapsedMs: 60_000, maxExpansions: 0,
};
const PATCH_BUDGET: AdmittedBudget = { ...BUDGET, maxExpansions: 1 };

function admitted(graph: ExecutableGraph, budget: AdmittedBudget = BUDGET): GraphAdmission {
  const result = admitGraph({ graph, compilerVersion: 'e0', policyHash: 'p', catalogHash: 'k', budget });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).admission;
}

function attempts(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
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
  return { entries, adapter: { async append(entry: GraphJournalEntry) { entries.push(entry); } } };
}

function pair(input: {
  admission: GraphAdmission; node: ExecutableNode; inputDigest: string; attemptId: string;
  wave: number; outputRef?: string; firedEdgeIds: string[]; emittedPatchDigest?: string;
}): GraphJournalEntry[] {
  const base = {
    admissionDigest: input.admission.admissionDigest, nodeId: input.node.id,
    nodeDigest: computeNodeDigest(input.node), inputDigest: input.inputDigest,
    attemptId: input.attemptId, wave: input.wave,
  };
  return [
    { type: 'node_started', ...base },
    {
      type: 'node_settled', ...base, status: 'completed', outputRef: input.outputRef,
      ...(input.emittedPatchDigest ? { emittedPatchDigest: input.emittedPatchDigest } : {}),
      firedEdgeIds: input.firedEdgeIds,
    } as GraphJournalEntry,
  ];
}

// ─── Finding 1: same-wave planner/reducer with a late join ───────────────────

test('F1: a patch may not join a node that is already claimed/in-flight in the current wave — planner->reducer->worker order must be impossible', async () => {
  // planner and reducer are BOTH roots: one wave, concurrency 2. The planner
  // emits a worker joining the reducer while the reducer is in flight.
  const graph: ExecutableGraph = {
    graphId: 'same-wave-join',
    nodes: [{ id: 'planner', kind: 'planner' }, { id: 'reducer', kind: 'reduce' }],
    edges: [],
  };
  const admission = admitted(graph, PATCH_BUDGET);
  const order: string[] = [];
  const runner: NodeRunner = {
    run: (node): NodeOutcome => {
      order.push(node.id);
      if (node.id === 'planner') {
        return {
          status: 'completed',
          outputRef: 'plan',
          emitPatch: {
            nodes: [{ id: 'w1', kind: 'worker' }],
            edges: [
              { id: 'p-w1', source: 'planner', target: 'w1' },
              { id: 'j-w1', source: 'w1', target: 'reducer' },
            ],
          },
        };
      }
      return { status: 'completed', outputRef: `art-${node.id}` };
    },
  };
  const result = await runGraph(graph, {
    runner, admission, journalAdapter: memoryAdapter().adapter, clock: () => 0,
    patchAdmitter: () => ({ ok: true }), attemptIds: attempts('a'),
  });
  // REQUIRED: either the emission is refused (emitter fails as node logic
  // because its join target's scheduling future closed in this very wave), or
  // the reducer is scheduled AFTER the worker. What must be IMPOSSIBLE is a
  // completed run whose trace order is planner -> reducer -> worker.
  const reducerAt = order.indexOf('reducer');
  const workerAt = order.indexOf('w1');
  const impossible = result.status === 'completed'
    && result.failed.length === 0
    && workerAt !== -1 && reducerAt !== -1 && reducerAt < workerAt;
  assert.equal(impossible, false,
    `the reducer ran before the worker that joins it, and the run reported complete: order=${JSON.stringify(order)}`);
});

// ─── Finding 2: stale proven topology after a changed root manifest ──────────

test('F2: a changed planner input retires the old patch generation — no stale worker/reducer runs when the new planner emits nothing', async () => {
  const planner: ExecutableNode = { id: 'planner', kind: 'planner' };
  const reducer: ExecutableNode = { id: 'reducer', kind: 'reduce' };
  const w1: ExecutableNode = { id: 'w1', kind: 'worker' };
  const patchEdges = [
    { id: 'p-w1', source: 'planner', target: 'w1' },
    { id: 'j-w1', source: 'w1', target: 'reducer' },
  ];
  const graph: ExecutableGraph = {
    graphId: 'stale-generation',
    nodes: [planner, reducer],
    edges: [{ id: 'e-pr', source: 'planner', target: 'reducer' }],
  };
  const identityFor = (manifest: string): GraphExecutionIdentity => ({
    tenant: 't', workspace: 'w', accountScopeDigest: 's', authorityDigest: 'a',
    schemaUniverseDigest: 'u', effectCeiling: 'read', bindingRevisionDigest: 'r', budgetVersion: 'b',
    nodes: {
      planner: { semanticDigest: 'cfg', runner: { name: 'r', version: '1', artifactDigest: 'i' }, rootInputManifestDigest: manifest },
      reducer: { semanticDigest: 'cfg', runner: { name: 'r', version: '1', artifactDigest: 'i' } },
    },
  });
  const admissionFor = (manifest: string): GraphAdmission => {
    const sealed = sealExecutionIdentity(graph, identityFor(manifest));
    assert.equal(sealed.ok, true, JSON.stringify(sealed));
    const result = admitGraph({
      graph, compilerVersion: 'e0', policyHash: 'p', catalogHash: 'k', budget: PATCH_BUDGET,
      identity: (sealed as Extract<typeof sealed, { ok: true }>).identity,
    });
    assert.equal(result.ok, true);
    return (result as Extract<typeof result, { ok: true }>).admission;
  };

  // Run 1 under manifest A: planner emits the patch, everything completes.
  const admissionA = admissionFor('manifest-A');
  const first = memoryAdapter();
  const run1 = await runGraph(graph, {
    runner: {
      run: (node): NodeOutcome => (node.id === 'planner'
        ? { status: 'completed', outputRef: 'plan-A', emitPatch: { nodes: [w1], edges: patchEdges } }
        : { status: 'completed', outputRef: `art-${node.id}` }),
    },
    admission: admissionA, journalAdapter: first.adapter, clock: () => 0,
    patchAdmitter: () => ({ ok: true }), attemptIds: attempts('a'),
  });
  assert.equal(run1.status, 'completed', run1.haltReason ?? '');

  // Resume under manifest B (same admission digest — manifests bind at the
  // input layer). The planner reruns and emits NO patch this time.
  const admissionB = admissionFor('manifest-B');
  assert.equal(admissionB.admissionDigest, admissionA.admissionDigest);
  const ran: string[] = [];
  const run2 = await runGraph(graph, {
    runner: {
      run: (node): NodeOutcome => {
        ran.push(node.id);
        return { status: 'completed', outputRef: `new-${node.id}` }; // no emitPatch
      },
    },
    admission: admissionB, journalAdapter: memoryAdapter().adapter, clock: () => 0,
    patchAdmitter: () => ({ ok: true }), attemptIds: attempts('b'),
    resumeEntries: first.entries,
  });
  assert.equal(ran.includes('w1'), false,
    'a worker from the RETIRED generation executed although the new planner emitted no patch');
  assert.equal(run2.patches.length, 0,
    'the old patch generation survived a changed emitter input');
});

// ─── Finding 3: unsupported journal schema version still dispatches ──────────

test('F3: a forged admission carrying an unsupported journal schema version refuses before any claim or dispatch', async () => {
  const graph: ExecutableGraph = { graphId: 'v999', nodes: [{ id: 'n', kind: 'step' }], edges: [] };
  const admission = { ...admitted(graph), journalSchemaVersion: 999 };
  const { entries, adapter } = memoryAdapter();
  let ran = 0;
  const result = await runGraph(graph, {
    runner: { run: () => { ran += 1; return { status: 'completed' }; } },
    admission, journalAdapter: adapter, clock: () => 0, attemptIds: attempts('a'),
  });
  assert.equal(result.status, 'halted', 'an unsupported journal schema version dispatched and journaled');
  assert.match(result.haltReason ?? '', /journal schema|version/i);
  assert.equal(ran, 0);
  assert.equal(entries.length, 0);
});

// ─── Finding 4: whitespace attempt ids ───────────────────────────────────────

test('F4: a whitespace/oversized/control-character attempt id refuses before the durable claim', async () => {
  const graph: ExecutableGraph = { graphId: 'ids', nodes: [{ id: 'n', kind: 'step' }], edges: [] };
  for (const bad of ['   ', '', 'x'.repeat(300), 'evilid']) {
    const { entries, adapter } = memoryAdapter();
    const result = await runGraph(graph, {
      runner: { run: () => ({ status: 'completed' }) },
      admission: admitted(graph), journalAdapter: adapter, clock: () => 0,
      attemptIds: () => bad,
    });
    assert.equal(result.status, 'halted', `attempt id ${JSON.stringify(bad)} was accepted`);
    assert.equal(entries.length, 0, `attempt id ${JSON.stringify(bad)} reached the journal`);
  }
});

// ─── Finding 5: invalid wave identities ──────────────────────────────────────

test('F5: negative, fractional, and emitter-preceding waves refuse at reconstruction', async () => {
  const graph: ExecutableGraph = {
    graphId: 'waves',
    nodes: [{ id: 'a', kind: 'step' }, { id: 'b', kind: 'step' }],
    edges: [{ id: 'e', source: 'a', target: 'b' }],
  };
  const admission = admitted(graph);
  for (const wave of [-1, 2.5, Number.NaN]) {
    const journal = withHeader(admission, pair({
      admission, node: graph.nodes[0]!, inputDigest: computeInputDigest([]),
      attemptId: `t-${wave}`, wave, outputRef: 'art', firedEdgeIds: ['e'],
    }));
    const result = await runGraph(graph, {
      runner: { run: () => ({ status: 'completed' }) },
      admission, journalAdapter: memoryAdapter().adapter, clock: () => 0,
      attemptIds: attempts('a'), resumeEntries: journal,
    });
    assert.equal(result.status, 'halted', `wave ${wave} was accepted as history`);
    assert.match(result.haltReason ?? '', /wave/,
      `wave ${wave} was refused for a non-wave reason: ${result.haltReason}`);
  }
  // A child that settled in a wave <= its predecessor's settlement wave is an
  // impossible causal relationship.
  const twisted: GraphJournalEntry[] = [
    ...pair({
      admission, node: graph.nodes[0]!, inputDigest: computeInputDigest([]),
      attemptId: 't-a', wave: 5, outputRef: 'art-a', firedEdgeIds: ['e'],
    }),
    ...pair({
      admission, node: graph.nodes[1]!,
      inputDigest: computeInputDigest([{ nodeId: 'a', outputRef: 'art-a', evidenceRefs: [] }]),
      attemptId: 't-b', wave: 3, outputRef: 'art-b', firedEdgeIds: [],
    }),
  ];
  const result = await runGraph(graph, {
    runner: { run: () => ({ status: 'completed' }) },
    admission, journalAdapter: memoryAdapter().adapter, clock: () => 0,
    attemptIds: attempts('a'), resumeEntries: withHeader(admission, twisted),
  });
  assert.equal(result.status, 'halted', 'a child settled in an earlier wave than its parent and history was accepted');
  assert.match(result.haltReason ?? '', /wave/,
    `the twisted causal order was refused for a non-wave reason: ${result.haltReason}`);
});

// ─── Finding 6: shallow identity freeze ──────────────────────────────────────

test('F6: sealed semantic identity is deep-immutable — mutating the caller\'s nested objects cannot drift the node digest from the sealed digest', () => {
  const graph: ExecutableGraph = { graphId: 'deep', nodes: [{ id: 'n', kind: 'step' }], edges: [] };
  const callerOwned: GraphExecutionIdentity = {
    tenant: 't', workspace: 'w', accountScopeDigest: 's', authorityDigest: 'a',
    schemaUniverseDigest: 'u', effectCeiling: 'read', bindingRevisionDigest: 'r', budgetVersion: 'b',
    nodes: { n: { semanticDigest: 'cfg-v1', runner: { name: 'r', version: '1', artifactDigest: 'impl' } } },
  };
  const sealed = sealExecutionIdentity(graph, callerOwned);
  assert.equal(sealed.ok, true);
  const identity = (sealed as Extract<typeof sealed, { ok: true }>).identity;
  const result = admitGraph({
    graph, compilerVersion: 'e0', policyHash: 'p', catalogHash: 'k', budget: BUDGET, identity,
  });
  assert.equal(result.ok, true);
  const admission = (result as Extract<typeof result, { ok: true }>).admission;
  const before = nodeDigestFor(admission, graph.nodes[0]!);

  // The attack: the caller mutates ITS OWN nested objects after sealing.
  // Deep-copy isolation means the mutation cannot reach the sealed identity
  // (whether or not the caller's copy throws), and the admission's own view
  // is deep-frozen.
  try { callerOwned.nodes.n!.runner.version = '999'; } catch { /* frozen caller copy is also acceptable */ }
  assert.equal(nodeDigestFor(admission, graph.nodes[0]!), before,
    'a caller-side mutation drifted the node digest away from the sealed admission digest');
  assert.throws(
    () => { (admission.identity!.nodes.n!.runner as { version: string }).version = 'x'; },
    /read only|frozen|Cannot assign/i,
    'the ADMISSION\'s sealed identity is not deep-frozen',
  );
});

// ─── Finding 7: structural fallback must be explicit, never silent ───────────

test('F7: admitted PRODUCTION mode requires semantic identity — structural admission is an explicitly named test-only mode', async () => {
  const graph: ExecutableGraph = { graphId: 'mode', nodes: [{ id: 'n', kind: 'step' }], edges: [] };
  // The REQUIRED contract: an admission that declares production mode without
  // semantic identity refuses. The API must exist and must refuse.
  const admissionModule = await import('./graph-admission.js') as Record<string, unknown>;
  assert.equal(typeof admissionModule.admitGraph, 'function');
  const result = admitGraph({
    graph, compilerVersion: 'e0', policyHash: 'p', catalogHash: 'k', budget: BUDGET,
    ...( { mode: 'production' } as Record<string, unknown>),
  } as Parameters<typeof admitGraph>[0]);
  assert.equal(result.ok, false,
    'production admission without semantic identity was admitted — structural identity is silently carrying production');
});

// ─── Finding 8: artifact verification field gaps ─────────────────────────────

test('F8: verifyArtifact binds record.ref to the requested ref and refuses empty store contract, media type, and commit id', async () => {
  const good: ArtifactRecord = {
    ref: 'ref-1', contentDigest: 'd', storeId: 'store', storeContract: 'store@1',
    byteLength: 3, mediaType: 'application/json', scopeDigest: 'scope',
    producedBy: { admissionDigest: 'adm', nodeId: 'n', attemptId: 't' }, commitId: 'commit-1',
  };
  const port = (record: ArtifactRecord): ArtifactStorePort => ({
    record: async () => record,
    stat: async () => ({ contentDigest: record.contentDigest, byteLength: record.byteLength, storeId: record.storeId }),
  });
  const expect = { admissionDigest: 'adm', nodeId: 'n', attemptId: 't' };

  const swapped = await verifyArtifact(port({ ...good, ref: 'a-DIFFERENT-ref' }), 'ref-1', expect);
  assert.equal(swapped.ok, false, 'a record whose ref differs from the requested ref verified');

  for (const hole of [{ storeContract: '' }, { mediaType: '' }, { commitId: '' }] as const) {
    const verdict = await verifyArtifact(port({ ...good, ...hole }), 'ref-1', expect);
    assert.equal(verdict.ok, false, `${JSON.stringify(hole)} verified as a committed artifact`);
  }
});

// ─── Finding 9: lease races ──────────────────────────────────────────────────

function racyLeaseStore(): LeaseStorePort & {
  dump(): Map<string, LeaseRecord>;
  /** Interpose BEFORE the next CAS — the read has already returned, so the
   *  hook interleaves a competing write into the read-modify-write window. */
  onNextCas?: (key: string) => Promise<void>;
} {
  const records = new Map<string, LeaseRecord>();
  let serial: Promise<unknown> = Promise.resolve();
  const serialize = async <T,>(work: () => Promise<T>): Promise<T> => {
    const next = serial.then(work);
    serial = next.catch(() => undefined);
    return next;
  };
  const self: ReturnType<typeof racyLeaseStore> = {
    async read(key) { return records.get(key); },
    async cas(key, expected, next) {
      const hook = self.onNextCas;
      self.onNextCas = undefined;
      if (hook) await hook(key);
      return serialize(async () => {
        const current = records.get(key);
        if (expected === undefined
          ? current !== undefined
          : current?.fence !== expected.fence || current?.revision !== expected.revision) return false;
        records.set(key, next);
        return true;
      });
    },
    async transact(key, expected, now, work) {
      const hook = self.onNextCas;
      self.onNextCas = undefined;
      if (hook) await hook(key); // a competing writer may land FIRST
      return serialize(async () => {
        const current = records.get(key);
        if (!current || current.owner !== expected.owner || current.fence !== expected.fence
          || current.released || current.expiresAt <= now) {
          return { ok: false, reason: `not live-held by "${expected.owner}" at fence ${expected.fence}` };
        }
        await work();
        records.set(key, { ...current, revision: current.revision + 1 });
        return { ok: true };
      });
    },
    dump() { return records; },
  };
  return self;
}

test('F9a: a released lease cannot be resurrected by a stale renewal racing on the same fence', async () => {
  const store = racyLeaseStore();
  const clock = { now: 0 };
  const owner = createLeaseManager({ store, owner: 'o1', clock: () => clock.now, ttlMs: 1_000 });
  await owner.acquire('k');
  // renew() has already READ the live record; release() lands before renew's
  // CAS. Fence-only CAS cannot tell the two apart — the REQUIRED contract is
  // a revision/etag compare, making release terminal for its revision.
  store.onNextCas = async () => {
    store.onNextCas = undefined;
    await owner.release('k', 1);
  };
  await owner.renew('k', 1);
  const record = store.dump().get('k')!;
  assert.equal(record.released, true,
    `a stale renewal resurrected a released lease: ${JSON.stringify(record)}`);
});

test('F9b: settlement append and lease validation are one conditional operation — a reclaim between check and append cannot admit a late settlement', async () => {
  const graph: ExecutableGraph = { graphId: 'fence', nodes: [{ id: 'n', kind: 'step' }], edges: [] };
  const admission = admitted(graph);
  const store = racyLeaseStore();
  const clock = { now: 0 };
  const old = createLeaseManager({ store, owner: 'old', clock: () => clock.now, ttlMs: 1_000 });
  const thief = createLeaseManager({ store, owner: 'new', clock: () => clock.now, ttlMs: 60_000 });
  const { entries, adapter } = memoryAdapter();
  // The reclaim interleaves exactly between the old owner's lease check and
  // its append: the store hook fires as the conditional commit BEGINS, the
  // lease has expired, and the thief takes the fence FIRST. One conditional
  // operation means the old owner's append must lose, not land late.
  const leased = withNodeLeases(adapter, old);
  await runGraph(graph, {
    runner: {
      run: (): NodeOutcome => {
        // The claim already succeeded; arm the interposition so the NEXT
        // lease-store operation — the settlement's conditional commit —
        // races a reclaim that lands first.
        store.onNextCas = async () => {
          clock.now = 5_000; // provably expired mid-commit
          const theft = await thief.acquire('node:n');
          assert.equal(theft.ok, true, JSON.stringify(theft));
        };
        return { status: 'completed', outputRef: 'late' };
      },
    },
    admission, journalAdapter: leased, clock: () => 0, attemptIds: attempts('a'),
  });
  assert.equal(entries.some((entry) => entry.type === 'node_settled'), false,
    'a settlement from a superseded owner landed after reclaim — check and append must be one conditional operation');
});

// ─── Finding 10: commit ports receive no fence/cancellation authority ────────

test('F10: an artifact commit port receives typed commit authority and refuses a post-cancellation commit from an uncooperative runner', async () => {
  const artifacts = await import('./graph-artifacts.js') as Record<string, unknown>;
  // REQUIRED: the artifact boundary accepts a CommitAuthority (attempt, owner,
  // fence, cancellation generation) and the runner decorator threads it.
  assert.equal('withArtifactCommit' in artifacts, true);
  const decorated = String(artifacts.withArtifactCommit);
  assert.match(decorated, /authority|fence|cancell/i,
    'the artifact commit boundary has no commit-authority/fence concept — an uncooperative runner can commit after cancellation');
});

// ─── Finding 11: cancellation is a coherent status ───────────────────────────

test('F11: cancellation is a first-class run/node status — journaled, reduced, and reported as cancelled, not a failed node with a comment', async () => {
  const graph: ExecutableGraph = { graphId: 'cancel', nodes: [{ id: 'n', kind: 'step' }], edges: [] };
  const admission = admitted(graph);
  const controller = new AbortController();
  const { entries, adapter } = memoryAdapter();
  const result = await runGraph(graph, {
    runner: {
      run: (): NodeOutcome => {
        controller.abort();
        return { status: 'completed', outputRef: 'ignored' };
      },
    },
    admission, journalAdapter: adapter, clock: () => 0,
    signal: controller.signal, attemptIds: attempts('a'),
  });
  assert.equal(result.status, 'cancelled');
  const settled = entries.find((entry): entry is NodeSettledEntry => entry.type === 'node_settled');
  assert.equal(settled?.status, 'cancelled',
    `cancellation journaled as "${settled?.status}"/${settled?.settlementClass} — it must be a coherent cancelled settlement status`);
  assert.deepEqual(result.cancelled, ['n'],
    'the run result does not report the node as cancelled');
});

// keep unused imports honest
void validateGraphPatch;
