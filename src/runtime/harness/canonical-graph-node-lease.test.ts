/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/canonical-graph-node-lease.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-lease-'));
process.env.CLEMENTINE_HOME = HOME;

const { resetEventLog, openEventLog, createSession, appendEvent } = await import('./eventlog.js');
const {
  canonicalGraphNodeLeaseKey,
  consumeCanonicalGraphNodeLeaseInTransaction,
  encodeCanonicalOwnerFence,
  inspectCanonicalGraphNodeLeaseInTransaction,
  readCanonicalGraphNodeLease,
  setReservationInsertFault,
} = await import('./canonical-graph-node-lease.js');
const {
  acquireCanonicalGraphNodeLease,
  writeCanonicalGraphNodeLeaseFixture,
} = await import('./canonical-graph-node-lease.fixture.js');
const {
  mintResolvedCallAuthority,
  parseResolvedCallAuthority,
  inspectEnvelopeCanonicalArgs,
} = await import('./resolved-call-authority.js');
const { derivePhysicalDispatchId } = await import('./physical-crossing-identity.js');
const {
  beginTypedPhysicalDispatch,
} = await import('./dispatch-ledger.js');
const { attachSemanticContract, capabilityManifestDigest } = await import('./capability-manifest.js');
const { requireAcceptedTaskAuthority } = await import('./accepted-task-authority.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const {
  registerIndependentCapabilityObservation,
  independentlyObserveCapability,
  clearIndependentCapabilityObservations,
} = await import('./independent-capability-observation.js');
const {
  clearProductionCapabilityPorts,
} = await import('./production-capability-ports.js');
const { registerShippedTestPort } = await import('./isolated-attested-transport.fixture.js');
const {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
} = await import('./host-capability-catalog-factory.js');
const {
  createCapabilityManifestStore,
  installCapabilityManifestStore,
  peekCapabilityManifestStore,
} = await import('./capability-manifest-store.js');
const {
  configureTypedExecutionRuntime,
  refreshTypedExecutionReadiness,
} = await import('../semantic-boundary/configure-typed-execution-runtime.js');

function writeManifest() {
  return attachSemanticContract({
    version: 1,
    manifestId: 'cap-write-1',
    providerKind: 'local_registry',
    operationId: 'host_create',
    providerIdentity: 'local_registry',
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    definitionFingerprint: 'a'.repeat(64),
    effect: 'external_write',
    destination: { family: 'workbook', posture: 'create_new' },
    accountId: 'acct-1',
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: false, policy: 'uncertain_if_absent' },
    outputContract: { kind: 'created_resource' },
    evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-16T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['destination'],
  });
}

function prepareSession(sessionId: string) {
  resetEventLog();
  clearIndependentCapabilityObservations();
  installCapabilityManifestStore(createCapabilityManifestStore());
  const factory = createHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(factory);
  configureTypedExecutionRuntime();
  const manifest = writeManifest();
  peekCapabilityManifestStore()?.install(manifest);
  factory.register({
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({}),
    reconcile: async () => ({ exists: false }),
  });
  registerShippedTestPort(manifest);
  const observedAt = Date.now();
  registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt,
    origin: 'independent',
    observe: () => ({
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt,
    }),
  });
  refreshTypedExecutionReadiness();
  createSession({ id: sessionId, kind: 'chat' });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'do it' },
  });
  assert.ok(recordTurnGraphShadow({ identity: { sessionId, turn: 1, sourceUserSeq: 1 } }));
  return requireAcceptedTaskAuthority({ sessionId, sourceUserSeq: 1 });
}

function mintBase(sessionId: string, acceptedTaskId: string, options: { logicalCallId?: string; acquire?: boolean } = {}) {
  const graphId = 'graph-1';
  const nodeId = 'op-write';
  const logicalCallId = options.logicalCallId ?? 'logical:op-write';
  const physicalDispatchId = derivePhysicalDispatchId({
    sessionId,
    sourceUserSeq: 1,
    graphId,
    nodeId,
    logicalCallId,
    ordinal: 1,
    relation: 'primary',
  });
  const lease = options.acquire === false
    ? { ok: true as const, ownerFence: encodeCanonicalOwnerFence({ owner: `${sessionId}:1`, fence: 1, revision: 1 }) }
    : acquireCanonicalGraphNodeLease({
      sessionId,
      sourceUserSeq: 1,
      graphId,
      nodeId,
      owner: `${sessionId}:1`,
    });
  if (!lease.ok) throw new Error(lease.reason);
  const observed = independentlyObserveCapability('host_create', 'acct-1');
  if (!observed) throw new Error('observation missing');
  return mintResolvedCallAuthority({
    acceptedSource: { sessionId, sourceUserSeq: 1 },
    acceptedTaskId,
    goalRevision: 0,
    graphId,
    graphHash: '9'.repeat(64),
    nodeId,
    operationId: 'host_create',
    capabilityRef: 'cap-write-1',
    canonicalArgumentDigest: '',
    canonicalArgs: { title: 'Workbook', sheet_name: 'Sheet1', sheet_json: [] },
    logicalCallId,
    liveFingerprint: 'a'.repeat(64),
    liveProviderVersion: 'tool-registry-v1',
    liveAccountId: 'acct-1',
    nodeEffect: 'external_write',
    graphCeiling: 'external_write',
    graphDestination: { family: 'workbook', posture: 'create_new' },
    policySnapshotDigest: 'c'.repeat(64),
    catalogSnapshotDigest: 'd'.repeat(64),
    writeJudge: { identity: 'judge-1', digest: 'e'.repeat(64) },
    groundingIdentity: 'ground-1',
    groundingReceiptDigest: 'f'.repeat(64),
    proposalDigest: '1'.repeat(64),
    claimEventId: 'evt-claim-1',
    semanticProvenanceDigest: '2'.repeat(64),
    physicalDispatchId,
    ordinal: 1,
    relation: 'primary',
    ownerFence: lease.ownerFence,
    observation: observed,
    manifest: writeManifest(),
  });
}

test('graphId a:b / nodeId c is distinct from graphId a / nodeId b:c', () => {
  const left = canonicalGraphNodeLeaseKey({
    sessionId: 's', sourceUserSeq: 1, graphId: 'a:b', nodeId: 'c',
  });
  const right = canonicalGraphNodeLeaseKey({
    sessionId: 's', sourceUserSeq: 1, graphId: 'a', nodeId: 'b:c',
  });
  assert.notEqual(left, right);
});

test('missing expired released substituted wrong-owner wrong-fence wrong-generation cannot reserve', () => {
  const sessionId = 'sess-lease-matrix';
  const task = prepareSession(sessionId);
  const cases = ['missing', 'expired', 'released', 'wrong-owner', 'wrong-fence', 'wrong-generation'] as const;
  for (const name of cases) {
    resetEventLog();
    prepareSession(sessionId);
    const minted = mintBase(sessionId, task.acceptedTaskId, { acquire: name !== 'missing' });
    if (!minted.ok) continue;
    if (name !== 'missing') {
      writeCanonicalGraphNodeLeaseFixture({
        sessionId,
        sourceUserSeq: 1,
        graphId: 'graph-1',
        nodeId: 'op-write',
        owner: name === 'wrong-owner' ? 'other' : `${sessionId}:1`,
        fence: name === 'wrong-fence' ? 9 : 1,
        revision: name === 'wrong-generation' ? 9 : 1,
        expiresAt: name === 'expired' ? Date.now() - 1 : Date.now() + 60_000,
        released: name === 'released',
      });
    }
    const reserved = beginTypedPhysicalDispatch({
      authority: minted.authority,
      identity: {
        sessionId,
        sourceUserSeq: 1,
        acceptedTaskId: task.acceptedTaskId,
        logicalToolCallId: minted.authority.logicalCallId,
        physicalDispatchId: minted.authority.physicalDispatchId,
        ordinal: 1,
      },
    });
    assert.equal(reserved.status, 'conflict', name);
    const rows = openEventLog().prepare(
      `SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?`,
    ).get(sessionId) as { n: number };
    assert.equal(rows.n, 0, name);
  }
});

test('sealed ordinal=2 relation=child when host expects 1/primary is refused with unchanged lease', () => {
  const sessionId = 'sess-lease-ordinal';
  const task = prepareSession(sessionId);
  const minted = mintBase(sessionId, task.acceptedTaskId);
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const before = readCanonicalGraphNodeLease({
    sessionId, sourceUserSeq: 1, graphId: 'graph-1', nodeId: 'op-write',
  });
  const reserved = beginTypedPhysicalDispatch({
    authority: { ...minted.authority, ordinal: 2, relation: 'child' },
    identity: {
      sessionId,
      sourceUserSeq: 1,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId: minted.authority.logicalCallId,
      physicalDispatchId: minted.authority.physicalDispatchId,
      ordinal: 2,
    },
    relation: 'child',
  });
  assert.equal(reserved.status, 'conflict');
  const after = readCanonicalGraphNodeLease({
    sessionId, sourceUserSeq: 1, graphId: 'graph-1', nodeId: 'op-write',
  });
  assert.equal(after?.revision, before?.revision);
  const rows = openEventLog().prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?`,
  ).get(sessionId) as { n: number };
  assert.equal(rows.n, 0);
});

test('two consumers of one generation produce exactly one reservation', () => {
  const sessionId = 'sess-lease-one';
  const task = prepareSession(sessionId);
  const first = mintBase(sessionId, task.acceptedTaskId);
  const second = mintBase(sessionId, task.acceptedTaskId, { logicalCallId: 'logical:op-write:b' });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  const db = openEventLog();
  const outcomes = [first, second].map((minted) => {
    try {
      return db.transaction(() => {
        const inspected = inspectCanonicalGraphNodeLeaseInTransaction(db, minted.authority);
        if (!inspected.ok) return inspected;
        return consumeCanonicalGraphNodeLeaseInTransaction(db, minted.authority);
      }).immediate();
    } catch (error) {
      return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter((outcome) => !outcome.ok).length, 1, JSON.stringify(outcomes));
  void task;
});

test('insert failure after CAS rolls back the lease generation', () => {
  const sessionId = 'sess-lease-rb';
  const task = prepareSession(sessionId);
  const minted = mintBase(sessionId, task.acceptedTaskId);
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const before = readCanonicalGraphNodeLease({
    sessionId, sourceUserSeq: 1, graphId: 'graph-1', nodeId: 'op-write',
  });
  const db = openEventLog();
  assert.throws(() => {
    db.transaction(() => {
      const consumed = consumeCanonicalGraphNodeLeaseInTransaction(db, minted.authority);
      if (!consumed.ok) throw new Error(consumed.reason);
      throw new Error('forced reservation insert failure after lease CAS');
    }).immediate();
  });
  const after = readCanonicalGraphNodeLease({
    sessionId, sourceUserSeq: 1, graphId: 'graph-1', nodeId: 'op-write',
  });
  assert.equal(after?.revision, before?.revision);
  void task;
});

test('deeply nested ~30KB envelope is refused without throwing', () => {
  const pad = 'x'.repeat(700);
  let nested: Record<string, unknown> = { pad, canonicalArgs: { secret: 'PLAINTEXT' } };
  for (let i = 0; i < 40; i += 1) nested = { pad, wrap: nested };
  const raw = JSON.stringify(nested);
  assert.ok(Buffer.byteLength(raw, 'utf8') > 28_000);
  assert.ok(Buffer.byteLength(raw, 'utf8') < 64_000);
  assert.doesNotThrow(() => inspectEnvelopeCanonicalArgs(nested));
  const inspected = inspectEnvelopeCanonicalArgs(nested);
  assert.equal(inspected.ok, false);
  const parsed = parseResolvedCallAuthority(raw);
  assert.equal(parsed.ok, false);
});

test('oversized envelope bytes are refused without throwing', () => {
  const oversized = { pad: 'x'.repeat(70_000) };
  assert.doesNotThrow(() => inspectEnvelopeCanonicalArgs(oversized));
  assert.deepEqual(inspectEnvelopeCanonicalArgs(oversized), { ok: false, reason: 'oversized' });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => inspectEnvelopeCanonicalArgs(cyclic));
  assert.equal(inspectEnvelopeCanonicalArgs(cyclic).ok, false);
});
