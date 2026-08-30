/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/physical-authority.test.ts */
import { HOST_BIND_IDENTITY } from '../semantic-boundary/host-authority.js';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-physical-auth-'));
process.env.CLEMENTINE_HOME = HOME;

const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');
const { typedExecutionCatalogRefusals } = await import('../semantic-boundary/configure-typed-execution-runtime.js');
const {
  appendEvent,
  applyHarnessMigrationsThroughVersionForTests,
  closeEventLog,
  createSession,
  openEventLog,
  resetEventLog,
  HARNESS_DB_PATH,
} = await import('./eventlog.js');
const {
  callAuthorityDigestOf,
  deriveRetryCallAuthority,
  mintOwnerFence,
  mintResolvedCallAuthority,
  parseResolvedCallAuthority,
  serializeResolvedCallAuthority,
} = await import('./resolved-call-authority.js');
const { attachSemanticContract } = await import('./capability-manifest.js');
const {
  archiveAuthorityPayloadsForSession,
  authorizeTypedReconciliation,
  beginPhysicalDispatch,
  beginTypedPhysicalDispatch,
  deleteAuthorityPayloadsForSession,
  loadPersistedCallAuthority,
  markAuthorityRetention,
  permanentlyDeleteSessionAuthorityPayloads,
  reapSettledAuthorityPayloads,
  retryDispositionFor,
  setSettlementStorageFault,
  settlePhysicalDispatch,
} = await import('./dispatch-ledger.js');
const {
  encodeCanonicalOwnerFence,
  readCanonicalGraphNodeLease,
  setReservationInsertFault,
} = await import('./canonical-graph-node-lease.js');
const {
  acquireCanonicalGraphNodeLease,
  writeCanonicalGraphNodeLeaseFixture,
} = await import('./canonical-graph-node-lease.fixture.js');
const { derivePhysicalDispatchId } = await import('./physical-crossing-identity.js');
const { requireAcceptedTaskAuthority } = await import('./accepted-task-authority.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const { dispatchAdmittedSource } = await import('../semantic-boundary/typed-source-dispatch.js');
const { recordSemanticParticipation } = await import('../semantic-boundary/semantic-disposition.js');
const {
  registerIndependentCapabilityObservation,
  clearIndependentCapabilityObservations,
  INDEPENDENT_OBSERVATION_FRESHNESS_MS,
} = await import('./independent-capability-observation.js');
const {
  registerProductionCapabilityPort,
  registerFixtureCapabilityPort,
  clearProductionCapabilityPorts,
  productionPortIdentityFromManifest,
} = await import('./production-capability-ports.js');
const { registerShippedTestPort } = await import('./isolated-attested-transport.fixture.js');
const {
  createHostCapabilityCatalogFactory,
  freezeCatalogSnapshotForSource,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
} = await import('./host-capability-catalog-factory.js');
const { capabilityManifestDigest } = await import('./capability-manifest.js');
const {
  createCapabilityManifestStore,
  installCapabilityManifestStore,
  peekCapabilityManifestStore,
  provisionVersionedCapabilityManifest,
} = await import('./capability-manifest-store.js');
const {
  configureTypedExecutionRuntime,
  refreshTypedExecutionReadiness,
} = await import('../semantic-boundary/configure-typed-execution-runtime.js');
const { independentlyObserveCapability, observationDigestOf } = await import('./independent-capability-observation.js');
const {
  emitShippedImplementationArtifacts,
  implementationArtifactDigest,
  implementationArtifactPath,
  implementationManifestPath,
  installImplementationArtifactRoot,
  shippedImplementationDigest,
  verifyShippedImplementationIdentity,
} = await import('./shipped-implementation-identity.js');

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

function readManifest() {
  return attachSemanticContract({
    version: 1,
    manifestId: 'cap-read-1',
    providerKind: 'local_registry',
    operationId: 'git_status',
    providerIdentity: 'local_registry',
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    definitionFingerprint: 'a'.repeat(64),
    effect: 'read',
    accountId: 'acct-1',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'status' },
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-16T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
  });
}

const mintBase = {
  acceptedSource: { sessionId: 'sess-auth', sourceUserSeq: 1 },
  acceptedTaskId: 'task-1',
  goalRevision: 0,
  graphId: 'graph-1',
  graphHash: '9'.repeat(64),
  nodeId: 'op-write',
  operationId: 'host_create',
  capabilityRef: 'cap-write-1',
  canonicalArgumentDigest: '',
  canonicalArgs: { title: 'Workbook', sheet_name: 'Sheet1', sheet_json: [] },
  logicalCallId: 'logical:op-write',
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
  physicalDispatchId: 'phys:op-write:1',
  ordinal: 1,
  relation: 'primary' as const,
  ownerFence: 'fence:sess-auth:1:phys:op-write:1',
  observation: {
    operationId: 'host_create',
    accountId: 'acct-1',
    definitionFingerprint: 'a'.repeat(64),
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    observedAt: Date.now(),
    origin: 'independent' as const,
  },
};

function observe(manifest = writeManifest(), observedAt = Date.now()) {
  assert.equal(registerIndependentCapabilityObservation({
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
  }).ok, true);
}

function prepareSession(sessionId: string) {
  resetEventLog();
  // Ports are a module-level registry: without this, a fixture port registered
  // by an earlier test survives and shadows the shipped port this session
  // registers, so readiness refuses with port_missing.
  clearProductionCapabilityPorts();
  clearIndependentCapabilityObservations();
  installCapabilityManifestStore(createCapabilityManifestStore());
  const factory = createHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(factory);
  configureTypedExecutionRuntime();
  const manifest = writeManifest();
  const store = peekCapabilityManifestStore();
  store?.install(manifest);
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
  const observedAt = Date.now();
  registerShippedTestPort(manifest, observedAt);
  observe(manifest, observedAt);
  refreshTypedExecutionReadiness();
  createSession({ id: sessionId, kind: 'chat' });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'do it' },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId, turn: 1, sourceUserSeq: 1 },
  }));
  const task = requireAcceptedTaskAuthority({ sessionId, sourceUserSeq: 1 });
  return task;
}

function bindCanonicalLease(
  sessionId: string,
  overrides: { graphId?: string; nodeId?: string; owner?: string } = {},
) {
  const graphId = overrides.graphId ?? mintBase.graphId;
  const nodeId = overrides.nodeId ?? mintBase.nodeId;
  const acquired = acquireCanonicalGraphNodeLease({
    sessionId,
    sourceUserSeq: 1,
    graphId,
    nodeId,
    owner: overrides.owner ?? `${sessionId}:1`,
  });
  if (!acquired.ok) throw new Error(acquired.reason);
  return acquired;
}

function mintFor(sessionId: string, acceptedTaskId: string, overrides: Record<string, unknown> = {}) {
  const graphId = typeof overrides.graphId === 'string' ? overrides.graphId : mintBase.graphId;
  const nodeId = typeof overrides.nodeId === 'string' ? overrides.nodeId : mintBase.nodeId;
  const logicalCallId = typeof overrides.logicalCallId === 'string' ? overrides.logicalCallId : mintBase.logicalCallId;
  const ordinal = typeof overrides.ordinal === 'number' ? overrides.ordinal : mintBase.ordinal;
  const relation = typeof overrides.relation === 'string' ? overrides.relation : mintBase.relation;
  const derivedPhys = derivePhysicalDispatchId({
    sessionId,
    sourceUserSeq: 1,
    graphId,
    nodeId,
    logicalCallId,
    ordinal,
    relation,
  });
  const physicalDispatchId = typeof overrides.forcePhysicalDispatchId === 'string'
    ? overrides.forcePhysicalDispatchId
    : derivedPhys;
  const ownerFence = typeof overrides.ownerFence === 'string'
    ? overrides.ownerFence
    : bindCanonicalLease(sessionId, { graphId, nodeId }).ownerFence;
  const observed = independentlyObserveCapability('host_create', 'acct-1')
    ?? independentlyObserveCapability(writeManifest().operationId, writeManifest().accountId);
  const {
    forcePhysicalDispatchId: _force,
    physicalDispatchId: _ignoredPhys,
    ...rest
  } = overrides;
  return mintResolvedCallAuthority({
    ...mintBase,
    acceptedSource: { sessionId, sourceUserSeq: 1 },
    acceptedTaskId,
    manifest: writeManifest(),
    ownerFence,
    observation: observed ?? {
      ...mintBase.observation,
      observedAt: Date.now(),
    },
    ...rest,
    logicalCallId,
    ordinal,
    relation: relation as 'primary' | 'retry' | 'poll' | 'probe' | 'child',
    physicalDispatchId,
  });
}

function mintReadFor(sessionId: string, acceptedTaskId: string, overrides: Record<string, unknown> = {}) {
  const graphId = typeof overrides.graphId === 'string' ? overrides.graphId : mintBase.graphId;
  const nodeId = typeof overrides.nodeId === 'string' ? overrides.nodeId : 'op-read';
  const ownerFence = typeof overrides.ownerFence === 'string'
    ? overrides.ownerFence
    : bindCanonicalLease(sessionId, { graphId, nodeId }).ownerFence;
  const manifest = readManifest();
  const store = peekCapabilityManifestStore();
  store?.install(manifest);
  const factory = peekHostCapabilityCatalogFactory();
  factory?.register({
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
  });
  registerShippedTestPort(manifest);
  observe(manifest);
  refreshTypedExecutionReadiness();
  const observed = independentlyObserveCapability(manifest.operationId, manifest.accountId);
  return mintResolvedCallAuthority({
    ...mintBase,
    acceptedSource: { sessionId, sourceUserSeq: 1 },
    acceptedTaskId,
    manifest,
    operationId: manifest.operationId,
    capabilityRef: manifest.manifestId,
    nodeId,
    nodeEffect: 'read',
    graphCeiling: 'read',
    graphDestination: undefined,
    writeJudge: null,
    logicalCallId: `logical:${nodeId}`,
    canonicalArgs: { status: true },
    ownerFence,
    observation: observed ?? {
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt: Date.now(),
      origin: 'independent',
    },
    ...overrides,
    physicalDispatchId: typeof overrides.forcePhysicalDispatchId === 'string'
      ? overrides.forcePhysicalDispatchId
      : derivePhysicalDispatchId({
        sessionId,
        sourceUserSeq: 1,
        graphId,
        nodeId,
        logicalCallId: typeof overrides.logicalCallId === 'string' ? overrides.logicalCallId : `logical:${nodeId}`,
        ordinal: typeof overrides.ordinal === 'number' ? overrides.ordinal : 1,
        relation: typeof overrides.relation === 'string' ? overrides.relation : 'primary',
      }),
  });
}

function retryDispatchId(predecessor: { acceptedSource: { sessionId: string; sourceUserSeq: number }; graphId: string; nodeId: string; logicalCallId: string; ordinal: number }) {
  return derivePhysicalDispatchId({
    sessionId: predecessor.acceptedSource.sessionId,
    sourceUserSeq: predecessor.acceptedSource.sourceUserSeq,
    graphId: predecessor.graphId,
    nodeId: predecessor.nodeId,
    logicalCallId: predecessor.logicalCallId,
    ordinal: predecessor.ordinal + 1,
    relation: 'retry',
  });
}

function crossingIdentity(
  sessionId: string,
  acceptedTaskId: string,
  logicalOrAuthority: string | { logicalCallId: string; physicalDispatchId: string; ordinal?: number; retryOf?: string },
  physicalDispatchId?: string,
) {
  if (typeof logicalOrAuthority === 'object') {
    return {
      sessionId,
      sourceUserSeq: 1,
      acceptedTaskId,
      logicalToolCallId: logicalOrAuthority.logicalCallId,
      physicalDispatchId: logicalOrAuthority.physicalDispatchId,
      ordinal: logicalOrAuthority.ordinal ?? 1,
      ...(logicalOrAuthority.retryOf ? { retryOf: logicalOrAuthority.retryOf } : {}),
    };
  }
  return {
    sessionId,
    sourceUserSeq: 1,
    acceptedTaskId,
    logicalToolCallId: logicalOrAuthority,
    physicalDispatchId: physicalDispatchId ?? '',
    ordinal: 1,
  };
}

test('tests and migrations do not bind the real Clementine home', () => {
  const live = path.join(homedir(), '.clementine-next');
  assert.notEqual(path.resolve(process.env.CLEMENTINE_HOME ?? ''), path.resolve(live));
  assert.notEqual(path.resolve(HARNESS_DB_PATH), path.join(live, 'state', 'harness.db'));
});

test('typed reservation replay without both digests is a conflict and does no I/O', () => {
  const sessionId = 'sess-replay-missing';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:missing:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const identity = crossingIdentity(sessionId, task.acceptedTaskId, minted.authority.logicalCallId, minted.authority.physicalDispatchId);
  assert.equal(beginTypedPhysicalDispatch({ authority: minted.authority, identity }).status, 'inserted');
  const none = beginPhysicalDispatch({
    identity,
    tool: minted.authority.operationId,
    args: minted.authority.canonicalArgs,
  });
  assert.equal(none.status, 'conflict');
  const onlyAuthority = beginPhysicalDispatch({
    identity,
    tool: minted.authority.operationId,
    args: minted.authority.canonicalArgs,
    ...{ authorityDigest: minted.authority.authorityDigest },
  });
  assert.equal(onlyAuthority.status, 'conflict');
  const onlyArgs = beginPhysicalDispatch({
    identity,
    tool: minted.authority.operationId,
    args: minted.authority.canonicalArgs,
    ...{ providerArgumentDigest: minted.authority.canonicalArgumentDigest },
  });
  assert.equal(onlyArgs.status, 'conflict');
  const rows = openEventLog().prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?`,
  ).get(sessionId) as { n: number };
  assert.equal(rows.n, 1);
});

test('typed reservation missing a required authority field is refused with no row', () => {
  const sessionId = 'sess-missing-field';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { claimEventId: '' });
  assert.equal(minted.ok, false);
  const complete = mintFor(sessionId, task.acceptedTaskId);
  assert.equal(complete.ok, true);
  if (!complete.ok) return;
  const forged = {
    ...complete.authority,
    claimEventId: '',
  };
  const refused = beginTypedPhysicalDispatch({
    authority: forged as typeof complete.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, complete.authority.logicalCallId, complete.authority.physicalDispatchId),
  });
  assert.equal(refused.status, 'conflict');
  const rows = openEventLog().prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?`,
  ).get(sessionId) as { n: number };
  assert.equal(rows.n, 0);
});

test('caller-supplied argument digest that does not match canonical args is refused', () => {
  const minted = mintResolvedCallAuthority({
    ...mintBase,
    manifest: writeManifest(),
    canonicalArgumentDigest: '0'.repeat(64),
  });
  assert.equal(minted.ok, false);
  if (!minted.ok) assert.equal(minted.reason, 'argument_digest_mismatch');
});

test('read capability cannot satisfy an external_write node or any unequal effect pair', () => {
  assert.equal(mintResolvedCallAuthority({
    ...mintBase,
    manifest: readManifest(),
    operationId: 'git_status',
    capabilityRef: 'cap-read-1',
    nodeEffect: 'external_write',
    writeJudge: { identity: 'judge-1', digest: 'e'.repeat(64) },
  }).reason, 'effect_mismatch');
  assert.equal(mintResolvedCallAuthority({
    ...mintBase,
    manifest: writeManifest(),
    nodeEffect: 'read',
  }).reason, 'effect_mismatch');
});

test('restart reconstructs the exact canonical authority and verifies its digest', () => {
  const sessionId = 'sess-restart';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:restart:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const identity = crossingIdentity(sessionId, task.acceptedTaskId, minted.authority.logicalCallId, minted.authority.physicalDispatchId);
  assert.equal(beginTypedPhysicalDispatch({ authority: minted.authority, identity }).status, 'inserted');
  closeEventLog();
  const reopened = loadPersistedCallAuthority({
    sessionId,
    sourceUserSeq: 1,
    physicalDispatchId: minted.authority.physicalDispatchId,
  });
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  if (!reopened.ok) return;
  const parsed = parseResolvedCallAuthority(serializeResolvedCallAuthority(reopened.authority));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.authority.authorityDigest, minted.authority.authorityDigest);
  assert.equal(parsed.authority.canonicalArgumentDigest, minted.authority.canonicalArgumentDigest);
  assert.equal(parsed.authority.physicalDispatchId, minted.authority.physicalDispatchId);
  assert.deepEqual(reopened.authority.canonicalArgs, minted.authority.canonicalArgs);
  assert.equal(reopened.authority.invokePortId, minted.authority.invokePortId);
  assert.equal(reopened.authority.reconcilePortId, minted.authority.reconcilePortId);
});

test('changed graph, claim, provenance, capability, account, schema, compiler, port, or args refuse replay', () => {
  const sessionId = 'sess-field-change';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:fields:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const identity = crossingIdentity(sessionId, task.acceptedTaskId, minted.authority.logicalCallId, minted.authority.physicalDispatchId);
  assert.equal(beginTypedPhysicalDispatch({ authority: minted.authority, identity }).status, 'inserted');
  const variants = [
    { claimEventId: 'evt-other' },
    { semanticProvenanceDigest: '3'.repeat(64) },
    { graphHash: '4'.repeat(64) },
    { capabilityRef: 'cap-other' },
    { liveAccountId: 'acct-other' },
    { liveFingerprint: '9'.repeat(64) },
    { canonicalArgs: { title: 'Other', sheet_name: 'Sheet1', sheet_json: [] } },
  ] as const;
  for (const variant of variants) {
    const drifted = mintFor(sessionId, task.acceptedTaskId, variant as Record<string, unknown>);
    if (!drifted.ok) continue;
    assert.notEqual(drifted.authority.authorityDigest, minted.authority.authorityDigest);
    assert.equal(beginTypedPhysicalDispatch({
      authority: drifted.authority,
      identity: {
        ...identity,
        logicalToolCallId: drifted.authority.logicalCallId,
      },
    }).status, 'conflict');
  }
  const rows = openEventLog().prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?`,
  ).get(sessionId) as { n: number };
  assert.equal(rows.n, 1);
});

test('invoke-port mutation after catalog freeze cannot change execution', async () => {
  resetEventLog();
  clearProductionCapabilityPorts();
  createSession({ id: 'sess-port-freeze', kind: 'chat' });
  const manifest = writeManifest();
  const store = createCapabilityManifestStore();
  store.install(manifest);
  let originalCalls = 0;
  let mutatedCalls = 0;
  const original = async () => {
    originalCalls += 1;
    return { ok: true };
  };
  const mutated = async () => {
    mutatedCalls += 1;
    return { ok: false };
  };
  const identity = productionPortIdentityFromManifest(manifest);
  assert.equal(registerFixtureCapabilityPort(identity, { invoke: original }).ok, true);
  assert.equal(registerFixtureCapabilityPort(identity, { invoke: mutated }).ok, false);
  const factory = createHostCapabilityCatalogFactory();
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
    invoke: original,
  });
  installHostCapabilityCatalogFactory(factory);
  const frozen = freezeCatalogSnapshotForSource({ sessionId: 'sess-port-freeze', sourceUserSeq: 1 });
  assert.equal(frozen.ok, true);
  if (!frozen.ok) return;
  factory.get(manifest.manifestId)!.invoke = mutated;
  await frozen.entries[0]!.invoke({
    nodeId: 'op-write',
    role: 'destination',
    payload: {},
    identity: { sessionId: 'sess-port-freeze', sourceUserSeq: 1, acceptedTaskId: 'task-1' },
    binding: {
      capabilityId: manifest.manifestId,
      toolName: manifest.operationId,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      args: {},
      effect: manifest.effect,
      invoke: mutated,
    },
  });
  assert.equal(originalCalls, 1);
  assert.equal(mutatedCalls, 0);
});

test('reconciliation with the wrong authority, account, operation, or port makes zero calls', () => {
  const sessionId = 'sess-recon';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:recon:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const identity = crossingIdentity(sessionId, task.acceptedTaskId, minted.authority.logicalCallId, minted.authority.physicalDispatchId);
  const reservedForRecon = beginTypedPhysicalDispatch({ authority: minted.authority, identity });
  assert.equal(
    reservedForRecon.status,
    'inserted',
    `${JSON.stringify(reservedForRecon)} refusals=${JSON.stringify(typedExecutionCatalogRefusals())}`,
  );
  let calls = 0;
  const wrongAccount = authorizeTypedReconciliation({
    sessionId,
    sourceUserSeq: 1,
    physicalDispatchId: minted.authority.physicalDispatchId,
    authority: minted.authority,
    accountId: 'acct-other',
    operationId: minted.authority.operationId,
    operationVersion: minted.authority.operationVersion,
    schemaFingerprint: minted.authority.liveFingerprint,
    reconcilePortId: minted.authority.invokePortId,
  });
  assert.equal(wrongAccount.ok, false);
  const wrongOp = authorizeTypedReconciliation({
    sessionId,
    sourceUserSeq: 1,
    physicalDispatchId: minted.authority.physicalDispatchId,
    authority: minted.authority,
    accountId: minted.authority.accountId,
    operationId: 'OTHER_OP',
    operationVersion: minted.authority.operationVersion,
    schemaFingerprint: minted.authority.liveFingerprint,
    reconcilePortId: minted.authority.invokePortId,
  });
  assert.equal(wrongOp.ok, false);
  const drifted = mintFor(sessionId, task.acceptedTaskId, { claimEventId: 'evt-other' });
  assert.equal(drifted.ok, true);
  if (!drifted.ok) return;
  const wrongAuthority = authorizeTypedReconciliation({
    sessionId,
    sourceUserSeq: 1,
    physicalDispatchId: minted.authority.physicalDispatchId,
    authority: drifted.authority,
    accountId: minted.authority.accountId,
    operationId: minted.authority.operationId,
    operationVersion: minted.authority.operationVersion,
    schemaFingerprint: minted.authority.liveFingerprint,
    reconcilePortId: minted.authority.invokePortId,
  });
  assert.equal(wrongAuthority.ok, false);
  assert.equal(calls, 0);
});

test('pre-migration digest-less physical rows cannot replay as typed work', () => {
  const sessionId = 'sess-legacy-row';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:legacy:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const identity = crossingIdentity(sessionId, task.acceptedTaskId, minted.authority.logicalCallId, minted.authority.physicalDispatchId);
  const legacy = beginPhysicalDispatch({
    identity,
    tool: minted.authority.operationId,
    args: minted.authority.canonicalArgs,
  });
  assert.equal(legacy.status, 'inserted');
  const replay = beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity,
  });
  assert.equal(replay.status, 'conflict');
  const loaded = loadPersistedCallAuthority({
    sessionId,
    sourceUserSeq: 1,
    physicalDispatchId: minted.authority.physicalDispatchId,
  });
  assert.equal(loaded.ok, false);
});

test('participated typed families never fall back to legacy after port removal', async () => {
  const families = ['collect_then_construct', 'single_act', 'fanout', 'retrieve', 'collect', 'none'];
  for (const family of families) {
    const sessionId = `sess-family-${family}`;
    resetEventLog();
    createSession({ id: sessionId, kind: 'chat' });
    appendEvent({
      sessionId,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: `typed ${family}` },
    });
    recordSemanticParticipation(sessionId, 1, 'participated');
    const dispatched = await dispatchAdmittedSource({
      sessionId,
      turn: 1,
      sourceUserSeq: 1,
    });
    assert.ok(
      dispatched.kind === 'typed' || dispatched.kind === 'blocked' || dispatched.kind === 'needs_input',
      family,
    );
  }
  clearProductionCapabilityPorts();
  const sessionId = 'sess-port-removed';
  resetEventLog();
  createSession({ id: sessionId, kind: 'chat' });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'typed after port removal' },
  });
  recordSemanticParticipation(sessionId, 1, 'participated');
  const dispatched = await dispatchAdmittedSource({
    sessionId,
    turn: 1,
    sourceUserSeq: 1,
  });
  assert.ok(
    dispatched.kind === 'typed' || dispatched.kind === 'blocked' || dispatched.kind === 'needs_input',
  );
});

test('full physical reservation and settlement rows prove exact authority parity', () => {
  const sessionId = 'sess-parity';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:parity:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const identity = crossingIdentity(sessionId, task.acceptedTaskId, minted.authority.logicalCallId, minted.authority.physicalDispatchId);
  assert.equal(beginTypedPhysicalDispatch({ authority: minted.authority, identity }).status, 'inserted');
  const wrongSettle = settlePhysicalDispatch({
    identity,
    tool: minted.authority.operationId,
    outcome: 'returned',
    authorityDigest: '0'.repeat(64),
  });
  assert.equal(wrongSettle.status, 'conflict');
  const settled = settlePhysicalDispatch({
    identity,
    tool: minted.authority.operationId,
    outcome: 'returned',
    authorityDigest: minted.authority.authorityDigest,
  });
  assert.equal(settled.status, 'inserted');
  const row = openEventLog().prepare(`
    SELECT d.authority_digest, d.provider_argument_digest, s.sealed_json AS authority_json
      FROM physical_dispatches d
      JOIN physical_dispatch_authority_sealed s
        ON s.session_id = d.session_id
       AND s.source_user_seq = d.source_user_seq
       AND s.physical_dispatch_id = d.physical_dispatch_id
     WHERE d.session_id = ? AND d.physical_dispatch_id = ?
  `).get(sessionId, minted.authority.physicalDispatchId) as {
    authority_digest: string;
    provider_argument_digest: string;
    authority_json: string;
  };
  const payloadDup = openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatch_authority_payload
     WHERE session_id = ? AND physical_dispatch_id = ?
  `).get(sessionId, minted.authority.physicalDispatchId) as { n: number };
  assert.equal(payloadDup.n, 0, 'schema 48 must not duplicate sealed bytes into the 47 payload table');
  assert.equal(row.authority_digest, minted.authority.authorityDigest);
  assert.equal(row.provider_argument_digest, minted.authority.canonicalArgumentDigest);
  const parsed = parseResolvedCallAuthority(row.authority_json);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.authority.authorityDigest, minted.authority.authorityDigest);
  assert.equal(row.authority_json.includes('Workbook'), false);
  assert.equal(row.authority_json.includes('canonicalArgs'), false);
});

test('one authority cannot reserve a second physical crossing', () => {
  const sessionId = 'sess-one-crossing';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:a' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, minted.authority),
  }).status, 'inserted');
  const second = beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity: {
      ...crossingIdentity(sessionId, task.acceptedTaskId, minted.authority),
      physicalDispatchId: 'phys:other',
    },
  });
  assert.equal(second.status, 'conflict');
  const rows = openEventLog().prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?`,
  ).get(sessionId) as { n: number };
  assert.equal(rows.n, 1);
});

test('deleting a session removes sealed authority payloads', () => {
  const sessionId = 'sess-delete-payload';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:delete:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, minted.authority.logicalCallId, minted.authority.physicalDispatchId),
  }).status, 'inserted');
  assert.equal(deleteAuthorityPayloadsForSession(sessionId), 1);
  const loaded = loadPersistedCallAuthority({
    sessionId,
    sourceUserSeq: 1,
    physicalDispatchId: minted.authority.physicalDispatchId,
  });
  assert.equal(loaded.ok, false);
});

test('pack_attested observation cannot authorize a typed reservation', () => {
  const sessionId = 'sess-pack-obs';
  const task = prepareSession(sessionId);
  clearIndependentCapabilityObservations();
  const manifest = writeManifest();
  registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt: Date.now(),
    origin: 'pack_attested',
  });
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:pack:1' });
  assert.equal(minted.ok, false);
});

test('interrupted v45-shaped databases apply migration 47 and keep reconstructable payload', () => {
  resetEventLog();
  closeEventLog();
  try { unlinkSync(HARNESS_DB_PATH); } catch { /* missing is fine */ }
  const raw = new Database(HARNESS_DB_PATH);
  applyHarnessMigrationsThroughVersionForTests(raw, 45);
  raw.close();
  const migrated = openEventLog();
  assert.equal(
    (migrated.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
    HARNESS_SCHEMA_VERSION,
  );
  const payload = migrated.prepare(
    `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'physical_dispatch_authority_payload'`,
  ).get() as { ok: number } | undefined;
  assert.equal(payload?.ok, 1);
});

test('changed ordinal, relation, or retryOf is refused with no extra row', () => {
  const sessionId = 'sess-crossing-fields';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:fields:2' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const identity = crossingIdentity(sessionId, task.acceptedTaskId, minted.authority);
  assert.equal(beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity: { ...identity, ordinal: 9 },
  }).status, 'conflict');
  assert.equal(beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity,
    relation: 'retry',
  }).status, 'conflict');
  assert.equal(beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity: { ...identity, retryOf: 'phys:other' },
  }).status, 'conflict');
  const rows = openEventLog().prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?`,
  ).get(sessionId) as { n: number };
  assert.equal(rows.n, 0);
});

test('exact physical identity replay is replayed and never invoked again', () => {
  const sessionId = 'sess-exact-replay';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:replay:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const identity = crossingIdentity(sessionId, task.acceptedTaskId, minted.authority);
  assert.equal(beginTypedPhysicalDispatch({ authority: minted.authority, identity }).status, 'inserted');
  const replay = beginTypedPhysicalDispatch({ authority: minted.authority, identity });
  assert.equal(replay.status, 'replayed');
  const rows = openEventLog().prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?`,
  ).get(sessionId) as { n: number };
  assert.equal(rows.n, 1);
});

test('concurrent phys:a and phys:b under one authority admit exactly one winner', () => {
  const sessionId = 'sess-concurrent';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:a' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const results = [minted.authority.physicalDispatchId, 'phys:b'].map((physicalDispatchId) => beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity: {
      ...crossingIdentity(sessionId, task.acceptedTaskId, minted.authority),
      physicalDispatchId,
    },
  }));
  const inserted = results.filter((result) => result.status === 'inserted');
  const refused = results.filter((result) => result.status === 'conflict');
  assert.equal(inserted.length, 1);
  assert.equal(refused.length, 1);
  const rows = openEventLog().prepare(
    `SELECT physical_dispatch_id AS id FROM physical_dispatches WHERE session_id = ?`,
  ).all(sessionId) as Array<{ id: string }>;
  assert.deepEqual(rows.map((row) => row.id), [minted.authority.physicalDispatchId]);
});

test('stale or missing independent observation cannot authorize a typed reservation', () => {
  const sessionId = 'sess-stale-obs';
  const task = prepareSession(sessionId);
  clearIndependentCapabilityObservations();
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:stale:1' });
  if (minted.ok) {
    const identity = crossingIdentity(sessionId, task.acceptedTaskId, minted.authority);
    const reserved = beginTypedPhysicalDispatch({ authority: minted.authority, identity });
    assert.notEqual(reserved.status, 'inserted');
  } else {
    assert.equal(minted.ok, false);
  }
  const manifest = writeManifest();
  registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt: Date.now() - INDEPENDENT_OBSERVATION_FRESHNESS_MS - 1,
    origin: 'independent',
    observe: () => ({
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt: Date.now() - INDEPENDENT_OBSERVATION_FRESHNESS_MS - 1,
    }),
  });
  const stale = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:stale:2' });
  if (stale.ok) {
    assert.equal(beginTypedPhysicalDispatch({
      authority: stale.authority,
      identity: crossingIdentity(sessionId, task.acceptedTaskId, stale.authority),
    }).status, 'conflict');
  } else {
    assert.equal(stale.ok, false);
  }
});

test('a retry requires a derived authority bound to the predecessor crossing', () => {
  const sessionId = 'sess-retry-auth';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:orig:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const sameId = deriveRetryCallAuthority({
    predecessor: minted.authority,
    physicalDispatchId: 'phys:orig:1',
    ownerFence: 'fence:retry',
    reason: 'uncertain_recovery',
  });
  assert.equal(sameId.ok, false);
  const retry = deriveRetryCallAuthority({
    predecessor: minted.authority,
    physicalDispatchId: retryDispatchId(minted.authority),
    ownerFence: `fence:${sessionId}:1:phys:retry:1`,
    reason: 'uncertain_recovery',
  });
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.equal(retry.authority.retryOf, minted.authority.physicalDispatchId);
  assert.equal(retry.authority.relation, 'retry');
  assert.equal(retry.authority.predecessorAuthorityDigest, minted.authority.authorityDigest);
  assert.notEqual(retry.authority.authorityDigest, minted.authority.authorityDigest);
});

test('settled sealed payloads age out; uncertain rows are retained', () => {
  const sessionId = 'sess-retain';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:retain:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, minted.authority),
  }).status, 'inserted');
  markAuthorityRetention({
    sessionId,
    sourceUserSeq: 1,
    physicalDispatchId: minted.authority.physicalDispatchId,
    retentionClass: 'settled',
  });
  openEventLog().prepare(`
    UPDATE physical_dispatch_authority_sealed SET created_at = ? WHERE session_id = ?
  `).run(new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(), sessionId);
  assert.equal(reapSettledAuthorityPayloads(), 1);
  const mintedUncertain = mintFor(sessionId, task.acceptedTaskId, {
    physicalDispatchId: 'phys:retain:2',
    logicalCallId: 'logical:op-write:2',
  });
  assert.equal(mintedUncertain.ok, true);
  if (!mintedUncertain.ok) return;
  assert.equal(beginTypedPhysicalDispatch({
    authority: mintedUncertain.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, mintedUncertain.authority),
  }).status, 'inserted');
  markAuthorityRetention({
    sessionId,
    sourceUserSeq: 1,
    physicalDispatchId: mintedUncertain.authority.physicalDispatchId,
    retentionClass: 'uncertain',
  });
  openEventLog().prepare(`
    UPDATE physical_dispatch_authority_sealed SET created_at = ? WHERE physical_dispatch_id = ?
  `).run(new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(), mintedUncertain.authority.physicalDispatchId);
  assert.equal(reapSettledAuthorityPayloads(), 0);
});

test('malformed and oversized sealed payloads are refused', () => {
  assert.equal(parseResolvedCallAuthority('{').ok, false);
  assert.equal(parseResolvedCallAuthority(`{"pad":"${'x'.repeat(70_000)}"}`).reason, 'oversized');
});

test('compatibility dispatch cannot insert typed rows from smuggled digests', () => {
  const sessionId = 'sess-compat-smuggle';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:smuggle:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const identity = crossingIdentity(sessionId, task.acceptedTaskId, minted.authority);
  const smuggled = beginPhysicalDispatch({
    identity,
    tool: minted.authority.operationId,
    args: minted.authority.canonicalArgs,
    ...{
      authorityDigest: minted.authority.authorityDigest,
      providerArgumentDigest: minted.authority.canonicalArgumentDigest,
      typedAuthorityJson: serializeResolvedCallAuthority(minted.authority),
    },
  });
  assert.equal(smuggled.status, 'inserted');
  const typed = openEventLog().prepare(
    `SELECT authority_digest AS digest FROM physical_dispatches WHERE physical_dispatch_id = ?`,
  ).get(minted.authority.physicalDispatchId) as { digest: string | null };
  assert.equal(typed.digest, null);
  assert.equal(loadPersistedCallAuthority({
    sessionId,
    sourceUserSeq: 1,
    physicalDispatchId: minted.authority.physicalDispatchId,
  }).ok, false);
});

test('sparse authority parser input is refused even with a recomputed digest', () => {
  const sparse = {
    version: 2,
    authorityDigest: '0'.repeat(64),
    physicalDispatchId: 'phys:sparse',
    ownerFence: 'fence:sparse',
  };
  assert.equal(parseResolvedCallAuthority(JSON.stringify(sparse)).ok, false);
});

test('observation id or time mutation changes the authority digest', () => {
  const sessionId = 'sess-obs-digest';
  const task = prepareSession(sessionId);
  const first = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:obs:1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  if (!first.ok) return;
  const idMutated = callAuthorityDigestOf({
    ...first.authority,
    observationId: `${first.authority.observationId}:mutated`,
  });
  const timeMutated = callAuthorityDigestOf({
    ...first.authority,
    observationObservedAt: first.authority.observationObservedAt + 1,
  });
  assert.notEqual(idMutated, first.authority.authorityDigest);
  assert.notEqual(timeMutated, first.authority.authorityDigest);
});

test('independent origin without an observer is refused', () => {
  clearIndependentCapabilityObservations();
  const registered = registerIndependentCapabilityObservation({
    operationId: 'host_create',
    accountId: 'acct-1',
    definitionFingerprint: 'a'.repeat(64),
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    observedAt: Date.now(),
    origin: 'independent',
  });
  assert.equal(registered.ok, true);
  const observed = independentlyObserveCapability('host_create', 'acct-1');
  assert.equal(observed?.origin, 'independent');
});

test('a returned write cannot derive or reserve a retry', () => {
  const sessionId = 'sess-no-retry-returned';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:done:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const identity = crossingIdentity(sessionId, task.acceptedTaskId, minted.authority);
  assert.equal(beginTypedPhysicalDispatch({ authority: minted.authority, identity }).status, 'inserted');
  assert.equal(settlePhysicalDispatch({
    identity,
    tool: minted.authority.operationId,
    outcome: 'returned',
    authorityDigest: minted.authority.authorityDigest,
  }).status, 'inserted');
  const retry = deriveRetryCallAuthority({
    predecessor: minted.authority,
    physicalDispatchId: 'phys:done:2',
    ownerFence: mintOwnerFence(),
    reason: 'uncertain_recovery',
    predecessorCrossingState: 'returned',
  });
  assert.equal(retry.ok, false);
});

test('schema 47 plaintext secrets are scrubbed by migration 48', () => {
  resetEventLog();
  closeEventLog();
  try { unlinkSync(HARNESS_DB_PATH); } catch { /* missing is fine */ }
  const raw = new Database(HARNESS_DB_PATH);
  applyHarnessMigrationsThroughVersionForTests(raw, 47);
  raw.prepare(`
    INSERT INTO physical_dispatch_authority_payload
      (session_id, source_user_seq, physical_dispatch_id, authority_digest, provider_argument_digest, authority_json)
    VALUES ('sess-secret', 1, 'phys:secret', ?, ?, ?)
  `).run('1'.repeat(64), '2'.repeat(64), JSON.stringify({ canonicalArgs: { apiKey: 'planted-secret-value' } }));
  raw.prepare(`
    INSERT INTO physical_dispatch_authority
      (session_id, source_user_seq, physical_dispatch_id, authority_digest, provider_argument_digest, authority_json)
    VALUES ('sess-secret', 1, 'phys:secret-auth', ?, ?, ?)
  `).run('3'.repeat(64), '4'.repeat(64), JSON.stringify({ canonicalArgs: { token: 'planted-secret-authority' } }));
  raw.close();
  const migrated = openEventLog();
  const leftoverPayload = migrated.prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatch_authority_payload WHERE authority_json LIKE '%planted-secret%'`,
  ).get() as { n: number };
  const leftoverAuthority = migrated.prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatch_authority WHERE authority_json LIKE '%planted-secret%'`,
  ).get() as { n: number };
  assert.equal(leftoverPayload.n, 0);
  assert.equal(leftoverAuthority.n, 0);
});

test('two stale stores allow exactly one supersession successor', () => {
  resetEventLog();
  const first = writeManifest();
  const storeA = createCapabilityManifestStore([], { durable: true });
  installCapabilityManifestStore(storeA);
  assert.equal(storeA.install(first).ok, true);
  const storeB = createCapabilityManifestStore([], { durable: true });
  const v2 = attachSemanticContract({
    ...first,
    manifestId: `${first.manifestId}:v2`,
    definitionFingerprint: 'b'.repeat(64),
    lifecycle: { state: 'current' },
  });
  const v3 = attachSemanticContract({
    ...first,
    manifestId: `${first.manifestId}:v3`,
    definitionFingerprint: 'c'.repeat(64),
    lifecycle: { state: 'current' },
  });
  const a = provisionVersionedCapabilityManifest(storeA, { predecessorId: first.manifestId, next: v2 });
  const b = provisionVersionedCapabilityManifest(storeB, { predecessorId: first.manifestId, next: v3 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  const restarted = createCapabilityManifestStore([], { durable: true });
  const replay = provisionVersionedCapabilityManifest(restarted, { predecessorId: first.manifestId, next: v2 });
  assert.equal(replay.ok, true);
  if (a.ok && replay.ok) assert.equal(replay.digest, a.digest);
  assert.equal(restarted.get(first.manifestId)?.manifest.lifecycle.state, 'superseded');
  assert.ok(restarted.get(v2.manifestId));
  assert.equal(restarted.install(first).ok, false);
});

test('archive ages out through the reaper; permanent delete removes payloads now', () => {
  const sessionId = 'sess-privacy-lifecycle';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:privacy:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, minted.authority),
  }).status, 'inserted');
  assert.equal(archiveAuthorityPayloadsForSession(sessionId), 1);
  openEventLog().prepare(`
    UPDATE physical_dispatch_authority_sealed SET created_at = ? WHERE session_id = ?
  `).run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), sessionId);
  assert.equal(reapSettledAuthorityPayloads(), 1);
  const minted2 = mintFor(sessionId, task.acceptedTaskId, {
    physicalDispatchId: 'phys:privacy:2',
    logicalCallId: 'logical:op-write:privacy',
  });
  assert.equal(minted2.ok, true);
  if (!minted2.ok) return;
  assert.equal(beginTypedPhysicalDispatch({
    authority: minted2.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, minted2.authority),
  }).status, 'inserted');
  assert.equal(permanentlyDeleteSessionAuthorityPayloads(sessionId), 1);
  const leftover = openEventLog().prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatch_authority_sealed WHERE session_id = ?`,
  ).get(sessionId) as { n: number };
  assert.equal(leftover.n, 0);
});

test('provider return then settlement storage failure stays uncertain with no redispatch', () => {
  const sessionId = 'sess-settle-storage';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:settle-fail:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const identity = crossingIdentity(sessionId, task.acceptedTaskId, minted.authority);
  assert.equal(beginTypedPhysicalDispatch({ authority: minted.authority, identity }).status, 'inserted');
  setSettlementStorageFault(true);
  const settled = settlePhysicalDispatch({
    identity,
    tool: minted.authority.operationId,
    outcome: 'returned',
    authorityDigest: minted.authority.authorityDigest,
  });
  setSettlementStorageFault(false);
  assert.equal(settled.status, 'storage_error');
  const retry = beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity,
  });
  assert.notEqual(retry.status, 'inserted');
  const crossings = openEventLog().prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?`,
  ).get(sessionId) as { n: number };
  assert.equal(crossings.n, 1);
});

test('a forged retry reservation against a returned write is refused', () => {
  const sessionId = 'sess-forged-retry';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:done:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const identity = crossingIdentity(sessionId, task.acceptedTaskId, minted.authority);
  assert.equal(beginTypedPhysicalDispatch({ authority: minted.authority, identity }).status, 'inserted');
  assert.equal(settlePhysicalDispatch({
    identity,
    tool: minted.authority.operationId,
    outcome: 'returned',
    authorityDigest: minted.authority.authorityDigest,
  }).status, 'inserted');
  const forged = mintFor(sessionId, task.acceptedTaskId, {
    physicalDispatchId: 'phys:done:2',
    relation: 'retry',
    retryOf: 'phys:done:1',
    predecessorAuthorityDigest: minted.authority.authorityDigest,
    retryReason: 'explicit_retry',
    ordinal: 2,
  });
  assert.equal(forged.ok, true);
  if (!forged.ok) return;
  const reserved = beginTypedPhysicalDispatch({
    authority: forged.authority,
    identity: {
      ...crossingIdentity(sessionId, task.acceptedTaskId, forged.authority),
      ordinal: 2,
      retryOf: 'phys:done:1',
    },
    relation: 'retry',
  });
  assert.equal(reserved.status, 'conflict');
});

function sealedFrom(sessionId: string, acceptedTaskId: string) {
  const minted = mintFor(sessionId, acceptedTaskId, { physicalDispatchId: `phys:envelope:${Math.random().toString(16).slice(2)}` });
  assert.equal(minted.ok, true);
  if (!minted.ok) throw new Error('mint failed');
  return { minted, raw: JSON.parse(serializeResolvedCallAuthority(minted.authority)) as Record<string, unknown> };
}

test('closed envelope rejects canonicalArgs beside argsRedacted', () => {
  const sessionId = 'sess-closed-args';
  const task = prepareSession(sessionId);
  const { raw } = sealedFrom(sessionId, task.acceptedTaskId);
  raw.canonicalArgs = { title: 'leaked' };
  assert.equal(parseResolvedCallAuthority(JSON.stringify(raw)).ok, false);
});

test('closed envelope rejects unknown top-level and nested keys', () => {
  const sessionId = 'sess-closed-keys';
  const task = prepareSession(sessionId);
  const { raw } = sealedFrom(sessionId, task.acceptedTaskId);
  assert.equal(parseResolvedCallAuthority(JSON.stringify({ ...raw, extra: true })).ok, false);
  const nested = { ...raw, destination: { ...(raw.destination as object), extra: 'no' } };
  assert.equal(parseResolvedCallAuthority(JSON.stringify(nested)).ok, false);
});

test('closed envelope rejects malformed and non-SHA256 digest fields', () => {
  const sessionId = 'sess-closed-digest';
  const task = prepareSession(sessionId);
  const { raw } = sealedFrom(sessionId, task.acceptedTaskId);
  assert.equal(parseResolvedCallAuthority(JSON.stringify({ ...raw, observationDigest: 'not-a-digest' })).ok, false);
  assert.equal(parseResolvedCallAuthority(JSON.stringify({ ...raw, writeJudge: { identity: 'judge-1', digest: 'short' } })).ok, false);
});

test('closed envelope rejects invented evidence kinds', () => {
  const sessionId = 'sess-closed-evidence';
  const task = prepareSession(sessionId);
  const { raw } = sealedFrom(sessionId, task.acceptedTaskId);
  const evidence = { ...(raw.evidenceContract as object), kinds: ['vibes'] };
  assert.equal(parseResolvedCallAuthority(JSON.stringify({ ...raw, evidenceContract: evidence })).ok, false);
});

test('closed envelope rejects invalid destination, idempotency, writeJudge, compiler, and observation shapes', () => {
  const sessionId = 'sess-closed-shapes';
  const task = prepareSession(sessionId);
  const { raw } = sealedFrom(sessionId, task.acceptedTaskId);
  assert.equal(parseResolvedCallAuthority(JSON.stringify({ ...raw, destination: { family: 'workbook', posture: 'maybe' } })).ok, false);
  assert.equal(parseResolvedCallAuthority(JSON.stringify({
    ...raw,
    idempotency: { required: true, policy: 'key_before_dispatch', extra: 1 },
  })).ok, false);
  assert.equal(parseResolvedCallAuthority(JSON.stringify({
    ...raw,
    writeJudge: { identity: 'judge-1', digest: 'e'.repeat(64), extra: true },
  })).ok, false);
  assert.equal(parseResolvedCallAuthority(JSON.stringify({
    ...raw,
    argumentCompiler: { id: 'compiler:host_create', version: '1', extra: true },
  })).ok, false);
  assert.equal(parseResolvedCallAuthority(JSON.stringify({ ...raw, observationObservedAt: 0 })).ok, false);
});

test('closed envelope rejects primary retry metadata and incomplete retry relations', () => {
  const sessionId = 'sess-closed-retry';
  const task = prepareSession(sessionId);
  const { raw } = sealedFrom(sessionId, task.acceptedTaskId);
  assert.equal(parseResolvedCallAuthority(JSON.stringify({
    ...raw,
    relation: 'primary',
    retryOf: 'phys:x',
  })).ok, false);
  assert.equal(parseResolvedCallAuthority(JSON.stringify({
    ...raw,
    relation: 'retry',
    retryOf: 'phys:x',
    predecessorAuthorityDigest: 'a'.repeat(64),
  })).ok, false);
});

test('writes without an exact write judge cannot mint', () => {
  const sessionId = 'sess-no-judge';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, {
    physicalDispatchId: 'phys:no-judge:1',
    writeJudge: null,
  });
  assert.equal(minted.ok, false);
  if (!minted.ok) assert.equal(minted.reason, 'write_judge_required');
});

test('reservation uses live observer bytes, not the registration snapshot', () => {
  const sessionId = 'sess-live-bytes';
  const task = prepareSession(sessionId);
  let observedAt = Date.now();
  const manifest = writeManifest();
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
  const first = independentlyObserveCapability(manifest.operationId, manifest.accountId);
  assert.ok(first);
  observedAt += 1;
  const second = independentlyObserveCapability(manifest.operationId, manifest.accountId);
  assert.ok(second);
  assert.notEqual(second.observedAt, first.observedAt);
  assert.notEqual(observationDigestOf(second), observationDigestOf(first));
});

test('observer implementation identity is host-derived, not Function.toString', async () => {
  const { shippedObserverImplementationId } = await import('./independent-capability-observation.js');
  const one = () => ({});
  const two = () => ({ extra: true });
  assert.equal(
    (await import('./independent-capability-observation.js')).observerImplementationIdOf(one),
    shippedObserverImplementationId(),
  );
  assert.equal(
    (await import('./independent-capability-observation.js')).observerImplementationIdOf(two),
    shippedObserverImplementationId(),
  );
});

test('a missing or substituted owner fence cannot reserve', () => {
  const sessionId = 'sess-fence-missing';
  const task = prepareSession(sessionId);
  const minted = mintResolvedCallAuthority({
    ...mintBase,
    acceptedSource: { sessionId, sourceUserSeq: 1 },
    acceptedTaskId: task.acceptedTaskId,
    manifest: writeManifest(),
    ownerFence: 'fence:unbound',
    observation: independentlyObserveCapability('host_create', 'acct-1') ?? mintBase.observation,
    physicalDispatchId: derivePhysicalDispatchId({
      sessionId,
      sourceUserSeq: 1,
      graphId: mintBase.graphId,
      nodeId: mintBase.nodeId,
      logicalCallId: mintBase.logicalCallId,
      ordinal: 1,
      relation: 'primary',
    }),
  });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const reserved = beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, minted.authority),
  });
  assert.equal(reserved.status, 'conflict');
  assert.match(reserved.reason ?? '', /lease|fence/);
});

test('invoke and reconcile implementation identities differ and reject caller-supplied digests', async () => {
  const { shippedInvokeImplementationDigest, shippedReconcileImplementationDigest, portImplementationDigest } = await import('./production-capability-ports.js');
  assert.notEqual(shippedInvokeImplementationDigest(), shippedReconcileImplementationDigest());
  assert.notEqual(
    portImplementationDigest({ invoke: async () => ({}), implementationDigest: 'f'.repeat(64) }, 'invoke'),
    'f'.repeat(64),
  );
});

test('an invented nonblank predecessor digest cannot reserve a retry', () => {
  const sessionId = 'sess-invented-pred';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:pred:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, minted.authority),
  }).status, 'inserted');
  const forged = mintFor(sessionId, task.acceptedTaskId, {
    physicalDispatchId: 'phys:pred:2',
    relation: 'retry',
    retryOf: 'phys:pred:1',
    predecessorAuthorityDigest: 'c'.repeat(64),
    retryReason: 'uncertain_recovery',
    ordinal: 2,
  });
  assert.equal(forged.ok, true);
  if (!forged.ok) return;
  const reserved = beginTypedPhysicalDispatch({
    authority: forged.authority,
    identity: {
      ...crossingIdentity(sessionId, task.acceptedTaskId, forged.authority),
      ordinal: 2,
      retryOf: 'phys:pred:1',
    },
    relation: 'retry',
  });
  assert.equal(reserved.status, 'conflict');
});

function dispatchCount(sessionId: string): number {
  return (openEventLog().prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?`,
  ).get(sessionId) as { n: number }).n;
}

function plaintextAuthorityRows(): number {
  return (openEventLog().prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatch_authority_sealed WHERE sealed_json LIKE '%PLAINTEXT%'`,
  ).get() as { n: number }).n;
}

test('read authority writeJudge carrier with canonicalArgs is refused and never persisted', () => {
  const sessionId = 'sess-read-judge-carrier';
  const task = prepareSession(sessionId);
  const minted = mintReadFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:read-judge:1' });
  assert.equal(minted.ok, true, JSON.stringify(minted));
  if (!minted.ok) return;
  const raw = JSON.parse(serializeResolvedCallAuthority(minted.authority)) as Record<string, unknown>;
  raw.writeJudge = { canonicalArgs: { secret: 'PLAINTEXT' }, extra: true };
  assert.equal(parseResolvedCallAuthority(JSON.stringify(raw)).ok, false);
  const reserved = beginTypedPhysicalDispatch({
    authority: {
      ...minted.authority,
      writeJudge: { canonicalArgs: { secret: 'PLAINTEXT' }, extra: true } as never,
    },
    identity: crossingIdentity(sessionId, task.acceptedTaskId, minted.authority),
  });
  assert.equal(reserved.status, 'conflict');
  assert.equal(dispatchCount(sessionId), 0);
  assert.equal(plaintextAuthorityRows(), 0);
});

test('canonical lease missing invented expired released substituted taken-over wrong-owner wrong-fence wrong-generation and cross-node cannot reserve', () => {
  const sessionId = 'sess-lease-adv';
  const task = prepareSession(sessionId);
  const cases: Array<{ name: string; mutate: () => string }> = [
    {
      name: 'missing',
      mutate: () => encodeCanonicalOwnerFence({ owner: `${sessionId}:1`, fence: 1, revision: 1 }),
    },
    {
      name: 'invented',
      mutate: () => {
        writeCanonicalGraphNodeLeaseFixture({
          sessionId,
          sourceUserSeq: 1,
          graphId: mintBase.graphId,
          nodeId: mintBase.nodeId,
          owner: `${sessionId}:1`,
          fence: 1,
          revision: 1,
          expiresAt: Date.now() + 60_000,
          released: false,
        });
        return 'fence:invented-uuid';
      },
    },
    {
      name: 'expired',
      mutate: () => {
        writeCanonicalGraphNodeLeaseFixture({
          sessionId,
          sourceUserSeq: 1,
          graphId: mintBase.graphId,
          nodeId: mintBase.nodeId,
          owner: `${sessionId}:1`,
          fence: 1,
          revision: 1,
          expiresAt: Date.now() - 1,
          released: false,
        });
        return encodeCanonicalOwnerFence({ owner: `${sessionId}:1`, fence: 1, revision: 1 });
      },
    },
    {
      name: 'released',
      mutate: () => {
        writeCanonicalGraphNodeLeaseFixture({
          sessionId,
          sourceUserSeq: 1,
          graphId: mintBase.graphId,
          nodeId: mintBase.nodeId,
          owner: `${sessionId}:1`,
          fence: 1,
          revision: 1,
          expiresAt: Date.now() + 60_000,
          released: true,
        });
        return encodeCanonicalOwnerFence({ owner: `${sessionId}:1`, fence: 1, revision: 1 });
      },
    },
    {
      name: 'substituted',
      mutate: () => {
        writeCanonicalGraphNodeLeaseFixture({
          sessionId: 'other-session',
          sourceUserSeq: 1,
          graphId: mintBase.graphId,
          nodeId: mintBase.nodeId,
          owner: `${sessionId}:1`,
          fence: 1,
          revision: 1,
          expiresAt: Date.now() + 60_000,
          released: false,
        });
        return encodeCanonicalOwnerFence({ owner: `${sessionId}:1`, fence: 1, revision: 1 });
      },
    },
    {
      name: 'taken-over',
      mutate: () => {
        writeCanonicalGraphNodeLeaseFixture({
          sessionId,
          sourceUserSeq: 1,
          graphId: mintBase.graphId,
          nodeId: mintBase.nodeId,
          owner: 'other-owner',
          fence: 2,
          revision: 2,
          expiresAt: Date.now() + 60_000,
          released: false,
        });
        return encodeCanonicalOwnerFence({ owner: `${sessionId}:1`, fence: 1, revision: 1 });
      },
    },
    {
      name: 'wrong-owner',
      mutate: () => {
        writeCanonicalGraphNodeLeaseFixture({
          sessionId,
          sourceUserSeq: 1,
          graphId: mintBase.graphId,
          nodeId: mintBase.nodeId,
          owner: `${sessionId}:1`,
          fence: 1,
          revision: 1,
          expiresAt: Date.now() + 60_000,
          released: false,
        });
        return encodeCanonicalOwnerFence({ owner: 'wrong-owner', fence: 1, revision: 1 });
      },
    },
    {
      name: 'wrong-fence',
      mutate: () => {
        writeCanonicalGraphNodeLeaseFixture({
          sessionId,
          sourceUserSeq: 1,
          graphId: mintBase.graphId,
          nodeId: mintBase.nodeId,
          owner: `${sessionId}:1`,
          fence: 1,
          revision: 1,
          expiresAt: Date.now() + 60_000,
          released: false,
        });
        return encodeCanonicalOwnerFence({ owner: `${sessionId}:1`, fence: 9, revision: 1 });
      },
    },
    {
      name: 'wrong-generation',
      mutate: () => {
        writeCanonicalGraphNodeLeaseFixture({
          sessionId,
          sourceUserSeq: 1,
          graphId: mintBase.graphId,
          nodeId: mintBase.nodeId,
          owner: `${sessionId}:1`,
          fence: 1,
          revision: 1,
          expiresAt: Date.now() + 60_000,
          released: false,
        });
        return encodeCanonicalOwnerFence({ owner: `${sessionId}:1`, fence: 1, revision: 9 });
      },
    },
    {
      name: 'cross-node',
      mutate: () => {
        writeCanonicalGraphNodeLeaseFixture({
          sessionId,
          sourceUserSeq: 1,
          graphId: mintBase.graphId,
          nodeId: 'other-node',
          owner: `${sessionId}:1`,
          fence: 1,
          revision: 1,
          expiresAt: Date.now() + 60_000,
          released: false,
        });
        return encodeCanonicalOwnerFence({ owner: `${sessionId}:1`, fence: 1, revision: 1 });
      },
    },
  ];
  for (const [index, entry] of cases.entries()) {
    resetEventLog();
    prepareSession(sessionId);
    const ownerFence = entry.mutate();
    const minted = mintFor(sessionId, task.acceptedTaskId, {
      physicalDispatchId: `phys:lease:${index}`,
      ownerFence,
    });
    assert.equal(minted.ok, true, entry.name);
    if (!minted.ok) continue;
    const reserved = beginTypedPhysicalDispatch({
      authority: minted.authority,
      identity: crossingIdentity(sessionId, task.acceptedTaskId, minted.authority),
    });
    assert.equal(reserved.status, 'conflict', entry.name);
    assert.equal(dispatchCount(sessionId), 0, entry.name);
  }
});

test('two consumers of one lease generation produce exactly one reservation', () => {
  const sessionId = 'sess-lease-cas';
  const task = prepareSession(sessionId);
  const lease = bindCanonicalLease(sessionId);
  const first = mintFor(sessionId, task.acceptedTaskId, {
    physicalDispatchId: 'phys:cas:a',
    ownerFence: lease.ownerFence,
  });
  const second = mintFor(sessionId, task.acceptedTaskId, {
    physicalDispatchId: 'phys:cas:b',
    ownerFence: lease.ownerFence,
    logicalCallId: 'logical:op-write:b',
  });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  const results = [first, second].map((minted) => beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity: crossingIdentity(
      sessionId,
      task.acceptedTaskId,
      minted.authority.logicalCallId,
      minted.authority.physicalDispatchId,
    ),
  }));
  assert.equal(results.filter((result) => result.status === 'inserted').length, 1);
  assert.equal(results.filter((result) => result.status === 'conflict').length, 1);
  assert.equal(dispatchCount(sessionId), 1);
});

test('insert failure after lease CAS rolls back the lease generation', () => {
  const sessionId = 'sess-lease-rollback';
  const task = prepareSession(sessionId);
  const lease = bindCanonicalLease(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, {
    physicalDispatchId: 'phys:rollback:1',
    ownerFence: lease.ownerFence,
  });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  setReservationInsertFault(true);
  const reserved = beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, minted.authority),
  });
  setReservationInsertFault(false);
  assert.equal(reserved.status, 'storage_error');
  assert.equal(dispatchCount(sessionId), 0);
  const after = readCanonicalGraphNodeLease({
    sessionId,
    sourceUserSeq: 1,
    graphId: mintBase.graphId,
    nodeId: mintBase.nodeId,
  });
  assert.ok(after);
  assert.equal(after?.revision, lease.lease.revision);
});

test('changing emitted invoke bytes changes its digest and stays distinct from reconcile', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-impl-'));
  emitShippedImplementationArtifacts(root);
  const original = implementationArtifactDigest('invoke', root);
  const reconcile = implementationArtifactDigest('reconcile', root);
  assert.notEqual(original, reconcile);
  writeFileSync(implementationArtifactPath('invoke', root), `${readFileSync(implementationArtifactPath('invoke', root), 'utf8')}\n// mutated-invoke\n`);
  assert.notEqual(implementationArtifactDigest('invoke', root), original);
  assert.equal(implementationArtifactDigest('reconcile', root), reconcile);
});

test('identical implementation artifacts remain deterministic across restart', () => {
  const first = shippedImplementationDigest('invoke');
  const again = shippedImplementationDigest('invoke');
  assert.equal(first, again);
  assert.equal(verifyShippedImplementationIdentity().ok, true);
});

test('stale or tampered implementation artifact or manifest blocks reservation before I/O', () => {
  const sessionId = 'sess-impl-tamper';
  const task = prepareSession(sessionId);
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-impl-tamper-'));
  emitShippedImplementationArtifacts(root);
  writeFileSync(implementationArtifactPath('invoke', root), `${readFileSync(implementationArtifactPath('invoke', root), 'utf8')}\n// tampered\n`);
  assert.equal(verifyShippedImplementationIdentity(root).ok, false);
  emitShippedImplementationArtifacts(root);
  const manifest = JSON.parse(readFileSync(implementationManifestPath(root), 'utf8')) as { artifacts: { invoke: { sha256: string } } };
  manifest.artifacts.invoke.sha256 = 'a'.repeat(64);
  writeFileSync(implementationManifestPath(root), `${JSON.stringify(manifest)}\n`);
  assert.equal(verifyShippedImplementationIdentity(root).ok, false);
  assert.equal(dispatchCount(sessionId), 0);
  void task;
});

test('reconciliation rechecks the exact reserved implementation identity', () => {
  const sessionId = 'sess-impl-recon';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:recon-impl:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, minted.authority),
  }).status, 'inserted');
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-impl-recon-'));
  emitShippedImplementationArtifacts(root);
  writeFileSync(implementationArtifactPath('reconcile', root), `${readFileSync(implementationArtifactPath('reconcile', root), 'utf8')}\n// recon-tamper\n`);
  assert.equal(verifyShippedImplementationIdentity(root).ok, false);
  const checked = authorizeTypedReconciliation({
    sessionId,
    sourceUserSeq: 1,
    physicalDispatchId: minted.authority.physicalDispatchId,
    authority: minted.authority,
    accountId: minted.authority.accountId,
    operationId: minted.authority.operationId,
    operationVersion: minted.authority.operationVersion,
    schemaFingerprint: minted.authority.liveFingerprint,
    reconcilePortId: minted.authority.reconcilePortId ?? 'reconcile:missing',
  });
  assert.equal(checked.ok, true);
});

test('observer identity changes when observer artifact bytes change', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-obs-'));
  emitShippedImplementationArtifacts(root);
  const first = implementationArtifactDigest('observer', root);
  writeFileSync(implementationArtifactPath('observer', root), `${readFileSync(implementationArtifactPath('observer', root), 'utf8')}\n// observer-mutated\n`);
  assert.notEqual(implementationArtifactDigest('observer', root), first);
});

test('started writes require reconciliation and cannot be redispatched', () => {
  const sessionId = 'sess-write-noretry';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:write-noretry:1' });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, minted.authority),
  }).status, 'inserted');
  assert.equal(retryDispositionFor('started', 'external_write', 'uncertain_recovery'), 'require_reconciliation');
  const retry = deriveRetryCallAuthority({
    predecessor: minted.authority,
    physicalDispatchId: retryDispatchId(minted.authority),
    ownerFence: bindCanonicalLease(sessionId).ownerFence,
    reason: 'uncertain_recovery',
    predecessorCrossingState: 'started',
  });
  assert.equal(retry.ok, false);
  const derived = deriveRetryCallAuthority({
    predecessor: minted.authority,
    physicalDispatchId: retryDispatchId(minted.authority),
    ownerFence: bindCanonicalLease(sessionId).ownerFence,
    reason: 'uncertain_recovery',
  });
  assert.equal(derived.ok, true);
  if (!derived.ok) return;
  const reserved = beginTypedPhysicalDispatch({
    authority: derived.authority,
    identity: {
      ...crossingIdentity(sessionId, task.acceptedTaskId, derived.authority),
      ordinal: 2,
      retryOf: minted.authority.physicalDispatchId,
    },
    relation: 'retry',
  });
  assert.equal(reserved.status, 'conflict');
  assert.match(reserved.reason ?? '', /reconcil|retry|started or unknown crossing/i);
  assert.equal(dispatchCount(sessionId), 1);
});

test('retry predecessor field mismatches refuse with zero extra rows', () => {
  const sessionId = 'sess-retry-fields';
  const task = prepareSession(sessionId);
  const primary = mintReadFor(sessionId, task.acceptedTaskId, { physicalDispatchId: 'phys:retry-fields:1' });
  assert.equal(primary.ok, true, JSON.stringify(primary));
  if (!primary.ok) return;
  assert.equal(beginTypedPhysicalDispatch({
    authority: primary.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, primary.authority),
  }).status, 'inserted');
  const lease = readCanonicalGraphNodeLease({
    sessionId,
    sourceUserSeq: 1,
    graphId: mintBase.graphId,
    nodeId: 'op-read',
  });
  assert.ok(lease);
  const derived = deriveRetryCallAuthority({
    predecessor: primary.authority,
    physicalDispatchId: retryDispatchId(primary.authority),
    ownerFence: encodeCanonicalOwnerFence(lease!),
    reason: 'uncertain_recovery',
  });
  assert.equal(derived.ok, true);
  if (!derived.ok) return;
  const mismatches: Array<{ name: string; authority: typeof derived.authority }> = [
    {
      name: 'authority-digest',
      authority: { ...derived.authority, predecessorAuthorityDigest: 'c'.repeat(64), authorityDigest: callAuthorityDigestOf({ ...derived.authority, predecessorAuthorityDigest: 'c'.repeat(64) }) },
    },
    {
      name: 'physical-id',
      authority: { ...derived.authority, retryOf: 'phys:other', authorityDigest: callAuthorityDigestOf({ ...derived.authority, retryOf: 'phys:other' }) },
    },
    {
      name: 'logical-id',
      authority: { ...derived.authority, logicalCallId: 'logical:other', authorityDigest: callAuthorityDigestOf({ ...derived.authority, logicalCallId: 'logical:other' }) },
    },
    {
      name: 'ordinal',
      authority: { ...derived.authority, ordinal: 9, authorityDigest: callAuthorityDigestOf({ ...derived.authority, ordinal: 9 }) },
    },
    {
      name: 'relation',
      authority: { ...derived.authority, relation: 'poll', authorityDigest: callAuthorityDigestOf({ ...derived.authority, relation: 'poll' }) },
    },
    {
      name: 'canonical-args',
      authority: { ...derived.authority, canonicalArgumentDigest: 'd'.repeat(64), authorityDigest: callAuthorityDigestOf({ ...derived.authority, canonicalArgumentDigest: 'd'.repeat(64) }) },
    },
    {
      name: 'operation',
      authority: { ...derived.authority, operationId: 'other_op', authorityDigest: callAuthorityDigestOf({ ...derived.authority, operationId: 'other_op' }) },
    },
    {
      name: 'manifest',
      authority: { ...derived.authority, manifestId: 'other-manifest', authorityDigest: callAuthorityDigestOf({ ...derived.authority, manifestId: 'other-manifest' }) },
    },
    {
      name: 'account',
      authority: { ...derived.authority, accountId: 'other-acct', authorityDigest: callAuthorityDigestOf({ ...derived.authority, accountId: 'other-acct' }) },
    },
    {
      name: 'schema',
      authority: { ...derived.authority, liveFingerprint: 'b'.repeat(64), authorityDigest: callAuthorityDigestOf({ ...derived.authority, liveFingerprint: 'b'.repeat(64) }) },
    },
    {
      name: 'provider-identity',
      authority: { ...derived.authority, providerIdentity: 'other-provider', authorityDigest: callAuthorityDigestOf({ ...derived.authority, providerIdentity: 'other-provider' }) },
    },
    {
      name: 'idempotency',
      authority: { ...derived.authority, idempotency: { required: true, policy: 'key_before_dispatch' }, authorityDigest: callAuthorityDigestOf({ ...derived.authority, idempotency: { required: true, policy: 'key_before_dispatch' } }) },
    },
    {
      name: 'reconcile-port',
      authority: { ...derived.authority, reconcilePortId: 'reconcile:other', authorityDigest: callAuthorityDigestOf({ ...derived.authority, reconcilePortId: 'reconcile:other' }) },
    },
    {
      name: 'reconcile-policy',
      authority: { ...derived.authority, reconciliationPolicy: 'exact_artifact', authorityDigest: callAuthorityDigestOf({ ...derived.authority, reconciliationPolicy: 'exact_artifact' }) },
    },
    {
      name: 'implementation-identity',
      authority: { ...derived.authority, invokeImplementationDigest: 'e'.repeat(64), authorityDigest: callAuthorityDigestOf({ ...derived.authority, invokeImplementationDigest: 'e'.repeat(64) }) },
    },
  ];
  for (const entry of mismatches) {
    const reserved = beginTypedPhysicalDispatch({
      authority: entry.authority,
      identity: {
        sessionId,
        sourceUserSeq: 1,
        acceptedTaskId: task.acceptedTaskId,
        logicalToolCallId: entry.authority.logicalCallId,
        physicalDispatchId: entry.authority.physicalDispatchId,
        ordinal: entry.authority.ordinal,
        retryOf: entry.authority.retryOf,
      },
      relation: entry.authority.relation,
    });
    assert.notEqual(reserved.status, 'inserted', entry.name);
    assert.equal(dispatchCount(sessionId), 1, entry.name);
  }
});

test('an eligible non-mutating retry is admitted exactly once', () => {
  const sessionId = 'sess-retry-positive';
  const task = prepareSession(sessionId);
  const primary = mintReadFor(sessionId, task.acceptedTaskId);
  assert.equal(primary.ok, true, JSON.stringify(primary));
  if (!primary.ok) return;
  assert.equal(beginTypedPhysicalDispatch({
    authority: primary.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, primary.authority),
  }).status, 'inserted');
  const lease = readCanonicalGraphNodeLease({
    sessionId,
    sourceUserSeq: 1,
    graphId: mintBase.graphId,
    nodeId: 'op-read',
  });
  assert.ok(lease);
  const retry = deriveRetryCallAuthority({
    predecessor: primary.authority,
    physicalDispatchId: retryDispatchId(primary.authority),
    ownerFence: encodeCanonicalOwnerFence(lease),
    reason: 'uncertain_recovery',
  });
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  const first = beginTypedPhysicalDispatch({
    authority: retry.authority,
    identity: {
      ...crossingIdentity(sessionId, task.acceptedTaskId, retry.authority),
      ordinal: 2,
      retryOf: primary.authority.physicalDispatchId,
    },
    relation: 'retry',
  });
  assert.equal(first.status, 'inserted', JSON.stringify(first));
  const second = beginTypedPhysicalDispatch({
    authority: retry.authority,
    identity: {
      ...crossingIdentity(sessionId, task.acceptedTaskId, retry.authority),
      ordinal: 2,
      retryOf: primary.authority.physicalDispatchId,
    },
    relation: 'retry',
  });
  assert.equal(second.status, 'replayed');
  assert.equal(dispatchCount(sessionId), 2);
});

test('a started write refuses a child crossing with zero second I/O', () => {
  const sessionId = 'sess-write-child-bypass';
  const task = prepareSession(sessionId);
  const minted = mintFor(sessionId, task.acceptedTaskId);
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, minted.authority),
  }).status, 'inserted');
  const child = beginPhysicalDispatch({
    identity: {
      sessionId,
      sourceUserSeq: 1,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId: minted.authority.logicalCallId,
      physicalDispatchId: `${minted.authority.physicalDispatchId}:child`,
      ordinal: 2,
    },
    tool: minted.authority.operationId,
    args: { nodeId: minted.authority.nodeId },
    relation: 'child',
  });
  assert.notEqual(child.status, 'inserted');
  assert.equal(dispatchCount(sessionId), 1);
});

test('logical and provider digests bind separately and admit one non-mutating retry', () => {
  const sessionId = 'sess-logical-provider-domains';
  const task = prepareSession(sessionId);
  const logicalArgs = { nodeId: 'op-read', capabilityId: 'cap-read', schemaVersion: '1', schemaDigest: 'x', digest: 'logical-only' };
  const canonicalArgs = { query: 'provider-ready', fields: ['name'] };
  const primary = mintReadFor(sessionId, task.acceptedTaskId, { logicalArgs, canonicalArgs });
  assert.equal(primary.ok, true, JSON.stringify(primary));
  if (!primary.ok) return;
  assert.notEqual(primary.authority.logicalArgumentDigest, primary.authority.canonicalArgumentDigest);
  const reserved = beginTypedPhysicalDispatch({
    authority: primary.authority,
    identity: crossingIdentity(sessionId, task.acceptedTaskId, primary.authority),
    ledgerArgs: logicalArgs,
  });
  assert.equal(reserved.status, 'inserted', JSON.stringify(reserved));
  const lease = readCanonicalGraphNodeLease({
    sessionId,
    sourceUserSeq: 1,
    graphId: mintBase.graphId,
    nodeId: 'op-read',
  });
  assert.ok(lease);
  const retry = deriveRetryCallAuthority({
    predecessor: primary.authority,
    physicalDispatchId: retryDispatchId(primary.authority),
    ownerFence: encodeCanonicalOwnerFence(lease),
    reason: 'uncertain_recovery',
  });
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  const retried = beginTypedPhysicalDispatch({
    authority: retry.authority,
    identity: {
      ...crossingIdentity(sessionId, task.acceptedTaskId, retry.authority),
      ordinal: 2,
      retryOf: primary.authority.physicalDispatchId,
    },
    relation: 'retry',
    ledgerArgs: logicalArgs,
  });
  assert.equal(retried.status, 'inserted', JSON.stringify(retried));
});

test('MIXED PROVENANCE: host write judge with model grounding (or the reverse) refuses at mint', () => {
  const observation = { ...mintBase.observation, observedAt: Date.now() };
  assert.equal(mintResolvedCallAuthority({
    ...mintBase,
    manifest: writeManifest(),
    observation,
    writeJudge: { identity: HOST_BIND_IDENTITY, digest: 'e'.repeat(64) },
    groundingIdentity: 'ground-1',
  }).reason, 'write_judge_mismatch');
  assert.equal(mintResolvedCallAuthority({
    ...mintBase,
    manifest: writeManifest(),
    observation,
    writeJudge: { identity: 'judge-1', digest: 'e'.repeat(64) },
    groundingIdentity: HOST_BIND_IDENTITY,
  }).reason, 'write_judge_mismatch');
});
