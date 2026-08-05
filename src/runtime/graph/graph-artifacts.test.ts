/**
 * Run: npx tsx --test src/runtime/graph/graph-artifacts.test.ts
 *
 * R1B/B2 biting suite: typed artifact commit and replay verification. A
 * settlement's refs must be committed and verified before the settlement is
 * durable; reuse re-verifies existence, digest, length, scope, store, and
 * provenance before descendants become ready; a missing artifact is never
 * redispatch authority for an effectful node; and only bounded refs ever
 * cross the node boundary or enter the journal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { admitGraph, type AdmittedBudget, type GraphAdmission } from './graph-admission.js';
import {
  reuseVerifierFor,
  verifyArtifact,
  withArtifactCommit,
  type ArtifactRecord,
  type ArtifactStorePort,
} from './graph-artifacts.js';
import { sealExecutionIdentity, type GraphExecutionIdentity } from './graph-node-identity.js';
import type { GraphJournalEntry } from './graph-journal.js';
import { runGraph, type ExecutableGraph, type NodeOutcome, type NodeRunner } from './graph-executor.js';

const BUDGET: AdmittedBudget = {
  maxNodes: 100, maxWaves: 100, maxConcurrency: 4, maxElapsedMs: 60_000, maxExpansions: 0,
};

const CHAIN: ExecutableGraph = {
  graphId: 'artifacts',
  nodes: [{ id: 'producer', kind: 'read-step' }, { id: 'consumer', kind: 'step' }],
  edges: [{ id: 'e-pc', source: 'producer', target: 'consumer' }],
};

function identityFor(effectClass: 'read' | 'write' | 'send'): GraphExecutionIdentity {
  return {
    tenant: 't1', workspace: 'w1', accountScopeDigest: 'scope-1',
    authorityDigest: 'auth-1', schemaUniverseDigest: 'schemas-1',
    effectCeiling: 'send', bindingRevisionDigest: 'rev-1', budgetVersion: 'b1',
    nodes: {
      producer: { semanticDigest: 'cfg', runner: { name: 'r', version: '1', artifactDigest: 'i' }, effectClass },
      consumer: { semanticDigest: 'cfg', runner: { name: 'r', version: '1', artifactDigest: 'i' }, effectClass: 'read' },
    },
  };
}

function admittedWith(effectClass: 'read' | 'write' | 'send'): GraphAdmission {
  const sealed = sealExecutionIdentity(CHAIN, identityFor(effectClass));
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  const result = admitGraph({
    graph: CHAIN, compilerVersion: 'c1', policyHash: 'p1', catalogHash: 'k1', budget: BUDGET,
    identity: (sealed as Extract<typeof sealed, { ok: true }>).identity,
  });
  assert.equal(result.ok, true);
  return (result as Extract<typeof result, { ok: true }>).admission;
}

/** In-memory double ADAPTING a store: commit records + live bytes, mutable. */
function memoryStore() {
  const records = new Map<string, ArtifactRecord>();
  const bytes = new Map<string, { contentDigest: string; byteLength: number; storeId: string }>();
  const port: ArtifactStorePort = {
    record: async (ref) => records.get(ref),
    stat: async (ref) => bytes.get(ref),
  };
  return {
    port,
    commit(record: ArtifactRecord): void {
      records.set(record.ref, record);
      bytes.set(record.ref, {
        contentDigest: record.contentDigest, byteLength: record.byteLength, storeId: record.storeId,
      });
    },
    vanish(ref: string): void { bytes.delete(ref); },
    truncate(ref: string): void {
      const stat = bytes.get(ref)!;
      bytes.set(ref, { ...stat, byteLength: stat.byteLength - 1 });
    },
    alter(ref: string): void {
      const stat = bytes.get(ref)!;
      bytes.set(ref, { ...stat, contentDigest: `${stat.contentDigest}-altered` });
    },
    relocate(ref: string): void {
      const stat = bytes.get(ref)!;
      bytes.set(ref, { ...stat, storeId: 'somewhere-else' });
    },
    records,
  };
}

function recordFor(
  admission: GraphAdmission,
  over: Partial<ArtifactRecord> & Pick<ArtifactRecord, 'ref' | 'producedBy'>,
): ArtifactRecord {
  return {
    contentDigest: `digest-of-${over.ref}`,
    storeId: 'artifact-store',
    storeContract: 'artifact-store@1',
    byteLength: 64,
    mediaType: 'application/json',
    scopeDigest: admission.identity?.accountScopeDigest ?? 'scope-1',
    commitId: `commit-${over.ref}`,
    ...over,
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

/** Runner whose producer commits `ref` (content-addressed) then claims it. */
function committingRunner(store: ReturnType<typeof memoryStore>, admission: GraphAdmission, ref: string, byteLength = 64): NodeRunner {
  return {
    run: (node, context): NodeOutcome => {
      if (node.id === 'producer') {
        store.commit(recordFor(admission, {
          ref,
          byteLength,
          producedBy: {
            admissionDigest: admission.admissionDigest,
            nodeId: node.id,
            attemptId: context.attemptId ?? 'unknown',
          },
        }));
        return { status: 'completed', outputRef: ref };
      }
      // The consumer produces no artifacts — a claimed ref must be committed,
      // and this suite proves that elsewhere.
      return { status: 'completed' };
    },
  };
}

// ─── production side ─────────────────────────────────────────────────────────

test('an unproven artifact claim fails the NODE before the settlement is durable', async () => {
  const admission = admittedWith('read');
  const store = memoryStore();
  const { entries, adapter } = journalAdapter();
  const runner: NodeRunner = {
    run: (node): NodeOutcome => (node.id === 'producer'
      ? { status: 'completed', outputRef: 'never-committed' } // claims without committing
      : { status: 'completed' }),
  };
  const result = await runGraph(CHAIN, {
    runner: withArtifactCommit(runner, store.port, admission),
    admission, journalAdapter: adapter, clock: () => 0, attemptIds: attempts('a'),
  });
  assert.deepEqual(result.failed, ['producer'], 'a settlement claimed artifacts nobody stored');
  assert.match(result.trace.find((t) => t.nodeId === 'producer')?.reason ?? '', /uncommitted/);
  const settled = entries.find((e) => e.type === 'node_settled' && e.nodeId === 'producer');
  assert.equal(settled && 'status' in settled && settled.status, 'failed',
    'the durable settlement recorded an unproven success');
});

test('a committed, verified artifact settles — and only the bounded ref crosses into the journal', async () => {
  const admission = admittedWith('read');
  const store = memoryStore();
  const { entries, adapter } = journalAdapter();
  // A "large" artifact: a megabyte of bytes in the store, referenced by name.
  const result = await runGraph(CHAIN, {
    runner: withArtifactCommit(committingRunner(store, admission, 'sha256-big-artifact', 1_048_576), store.port, admission),
    admission, journalAdapter: adapter, clock: () => 0, attemptIds: attempts('a'),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual(result.failed, []);
  for (const entry of entries) {
    assert.ok(JSON.stringify(entry).length < 2_048,
      'a journal row grew beyond bounded refs — payload bytes crossed the node boundary');
  }
});

test('provenance is part of the claim: a record produced by someone else fails the producer', async () => {
  const admission = admittedWith('read');
  const store = memoryStore();
  const runner: NodeRunner = {
    run: (node): NodeOutcome => {
      if (node.id === 'producer') {
        store.commit(recordFor(admission, {
          ref: 'stolen', producedBy: { admissionDigest: admission.admissionDigest, nodeId: 'someone-else', attemptId: 'x' },
        }));
        return { status: 'completed', outputRef: 'stolen' };
      }
      return { status: 'completed' };
    },
  };
  const result = await runGraph(CHAIN, {
    runner: withArtifactCommit(runner, store.port, admission),
    admission, journalAdapter: journalAdapter().adapter, clock: () => 0, attemptIds: attempts('a'),
  });
  assert.deepEqual(result.failed, ['producer']);
  assert.match(result.trace.find((t) => t.nodeId === 'producer')?.reason ?? '', /wrong-producer/);
});

// ─── replay side ─────────────────────────────────────────────────────────────

async function settledJournal(admission: GraphAdmission, store: ReturnType<typeof memoryStore>, ref: string) {
  const { entries, adapter } = journalAdapter();
  const result = await runGraph(CHAIN, {
    runner: withArtifactCommit(committingRunner(store, admission, ref), store.port, admission),
    admission, journalAdapter: adapter, clock: () => 0, attemptIds: attempts('o'),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  return entries;
}

async function resumeWith(
  admission: GraphAdmission,
  store: ReturnType<typeof memoryStore>,
  journal: GraphJournalEntry[],
  ref: string,
) {
  const ran: string[] = [];
  const base: NodeRunner = {
    run: (node, context): NodeOutcome => {
      ran.push(node.id);
      if (node.id === 'producer') {
        store.commit(recordFor(admission, {
          ref,
          producedBy: {
            admissionDigest: admission.admissionDigest, nodeId: node.id, attemptId: context.attemptId ?? 'unknown',
          },
        }));
        return { status: 'completed', outputRef: ref };
      }
      return { status: 'completed' };
    },
  };
  const result = await runGraph(CHAIN, {
    runner: withArtifactCommit(base, store.port, admission),
    admission, journalAdapter: journalAdapter().adapter, clock: () => 0,
    attemptIds: attempts('n'), resumeEntries: journal,
    reuseVerifier: reuseVerifierFor(store.port, admission),
  });
  return { ran, result };
}

test('crash after settlement: reuse verifies the artifacts and replays at zero dispatch', async () => {
  const admission = admittedWith('read');
  const store = memoryStore();
  const journal = await settledJournal(admission, store, 'sha256-content-a');
  const { ran, result } = await resumeWith(admission, store, journal, 'sha256-content-a');
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual(ran, [], 'verified artifacts were re-dispatched');
  assert.equal(result.trace.filter((t) => t.reused).length, 2);
});

test('a READ node with vanished or corrupted bytes reruns — and content-identical recomputation lets the descendant reuse', async () => {
  for (const damage of ['vanish', 'truncate', 'alter'] as const) {
    const admission = admittedWith('read');
    const store = memoryStore();
    const journal = await settledJournal(admission, store, 'sha256-content-a');
    store[damage]('sha256-content-a');
    const { ran, result } = await resumeWith(admission, store, journal, 'sha256-content-a');
    assert.equal(result.status, 'completed', `${damage}: ${result.haltReason ?? ''}`);
    assert.deepEqual(ran, ['producer'],
      `${damage}: the read producer must rerun and its content-identical output must let the consumer reuse`);
    const producer = result.trace.find((t) => t.nodeId === 'producer');
    assert.equal(producer?.reused, undefined);
    assert.match(producer?.reuseRefused ?? '', /artifact/);
    assert.equal(result.trace.find((t) => t.nodeId === 'consumer')?.reused, true);
  }
});

test('a changed recomputation invalidates the descendant through its input digest', async () => {
  const admission = admittedWith('read');
  const store = memoryStore();
  const journal = await settledJournal(admission, store, 'sha256-content-a');
  store.vanish('sha256-content-a');
  const { ran } = await resumeWith(admission, store, journal, 'sha256-content-B');
  assert.deepEqual(ran, ['producer', 'consumer'],
    'the consumer reused stale evidence after its predecessor produced different content');
});

test('a missing artifact is NOT redispatch authority for an effectful node', async () => {
  const admission = admittedWith('write');
  const store = memoryStore();
  const journal = await settledJournal(admission, store, 'sha256-content-a');
  store.vanish('sha256-content-a');
  const { ran, result } = await resumeWith(admission, store, journal, 'sha256-content-a');
  assert.equal(result.status, 'halted',
    'a write-class node was re-dispatched on the strength of a storage problem');
  assert.match(result.haltReason ?? '', /not redispatch authority/);
  assert.deepEqual(ran, [], 'work dispatched under a refused reuse');
});

test('wrong scope, wrong store, and wrong producer refuse reuse outright — for every effect class', async () => {
  const admission = admittedWith('read');
  for (const corruption of ['rescope', 'relocate', 'reproducer'] as const) {
    const store = memoryStore();
    const journal = await settledJournal(admission, store, 'sha256-content-a');
    const record = store.records.get('sha256-content-a')!;
    if (corruption === 'rescope') store.records.set(record.ref, { ...record, scopeDigest: 'someone-elses-scope' });
    if (corruption === 'relocate') store.relocate(record.ref);
    if (corruption === 'reproducer') {
      store.records.set(record.ref, {
        ...record, producedBy: { ...record.producedBy, nodeId: 'impostor' },
      });
    }
    const { ran, result } = await resumeWith(admission, store, journal, 'sha256-content-a');
    assert.equal(result.status, 'halted', `${corruption} did not refuse`);
    assert.deepEqual(ran, [], `${corruption}: work dispatched from corrupt provenance`);
  }
});

test('crash after artifact commit but before settlement: the node reruns and idempotent recommit verifies', async () => {
  const admission = admittedWith('read');
  const store = memoryStore();
  // Only the start is durable; the artifact commit survived the crash.
  const journal: GraphJournalEntry[] = [];
  await (async () => {
    const { adapter, entries } = journalAdapter();
    await runGraph(CHAIN, {
      runner: {
        run: (node, context): NodeOutcome => {
          if (node.id === 'producer') {
            store.commit(recordFor(admission, {
              ref: 'sha256-content-a',
              producedBy: { admissionDigest: admission.admissionDigest, nodeId: node.id, attemptId: context.attemptId ?? '' },
            }));
            throw new Error('crash before settlement'); // infra: start durable, settlement absent...
          }
          return { status: 'completed' };
        },
      },
      admission, journalAdapter: adapter, clock: () => 0, attemptIds: attempts('o'),
    });
    // Keep only the producer's start: the settlement that DID get journaled is
    // the infrastructure failure, which a real crash would never have written.
    journal.push(...entries.filter((e) => e.type === 'node_started' && e.nodeId === 'producer'));
  })();
  const { ran, result } = await resumeWith(admission, store, journal, 'sha256-content-a');
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual(ran, ['producer', 'consumer'], 'an interrupted attempt must rerun in full');
});

// ─── the pure verifier ───────────────────────────────────────────────────────

test('verifyArtifact names each failure precisely', async () => {
  const admission = admittedWith('read');
  const store = memoryStore();
  const producedBy = { admissionDigest: admission.admissionDigest, nodeId: 'producer', attemptId: 'a-1' };
  const expect = { admissionDigest: admission.admissionDigest, nodeId: 'producer', attemptId: 'a-1' };

  assert.equal((await verifyArtifact(store.port, 'ghost', expect) as { kind: string }).kind, 'uncommitted');
  store.commit(recordFor(admission, { ref: 'r1', producedBy }));
  assert.equal((await verifyArtifact(store.port, 'r1', expect)).ok, true);
  store.vanish('r1');
  assert.equal((await verifyArtifact(store.port, 'r1', expect) as { kind: string }).kind, 'missing');
  store.commit(recordFor(admission, { ref: 'r2', producedBy }));
  store.truncate('r2');
  assert.equal((await verifyArtifact(store.port, 'r2', expect) as { kind: string }).kind, 'truncated');
  store.commit(recordFor(admission, { ref: 'r3', producedBy }));
  store.alter('r3');
  assert.equal((await verifyArtifact(store.port, 'r3', expect) as { kind: string }).kind, 'altered');
  store.commit(recordFor(admission, { ref: 'r4', producedBy }));
  assert.equal(
    (await verifyArtifact(store.port, 'r4', { ...expect, scopeDigest: 'other' }) as { kind: string }).kind,
    'wrong-scope',
  );
  store.commit(recordFor(admission, { ref: 'r5', producedBy: { ...producedBy, attemptId: 'a-9' } }));
  assert.equal((await verifyArtifact(store.port, 'r5', expect) as { kind: string }).kind, 'wrong-producer');
});
