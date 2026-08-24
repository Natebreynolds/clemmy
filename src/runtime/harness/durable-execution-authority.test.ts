/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/durable-execution-authority.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-durable-auth-'));

const { appendEvent, closeEventLog, createSession, listEvents, openEventLog, resetEventLog, HARNESS_DB_PATH } = await import('./eventlog.js');
const { mintResolvedCallAuthority, callAuthorityDigestOf } = await import('./resolved-call-authority.js');
const { attachSemanticContract, capabilityManifestDigest } = await import('./capability-manifest.js');
const { beginPhysicalDispatch, beginTypedPhysicalDispatch } = await import('./dispatch-ledger.js');
const { acquireCanonicalGraphNodeLease } = await import('./canonical-graph-node-lease.fixture.js');
const { derivePhysicalDispatchId } = await import('./physical-crossing-identity.js');
const { independentlyObserveCapability, registerIndependentCapabilityObservation } = await import('./independent-capability-observation.js');
const { requireAcceptedTaskAuthority } = await import('./accepted-task-authority.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const { compileSealedProviderArgs, installProductionTransport, invokeForSealedManifest } = await import('./production-capability-adapters.js');
const { productionCapabilityManifests } = await import('./production-capability-catalog.js');
const { sealGraphNodeInvocationEnvelope } = await import('./graph-node-envelope.js');
const {
  createHostCapabilityCatalogFactory,
  freezeCatalogSnapshotForSource,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
} = await import('./host-capability-catalog-factory.js');
const { createCapabilityManifestStore, installCapabilityManifestStore, peekCapabilityManifestStore } = await import('./capability-manifest-store.js');
const {
  configureTypedExecutionRuntime,
  refreshTypedExecutionReadiness,
} = await import('../semantic-boundary/configure-typed-execution-runtime.js');
const { registerShippedTestPort } = await import('./isolated-attested-transport.fixture.js');
const { dispatchAdmittedSource } = await import('../semantic-boundary/typed-source-dispatch.js');
const { recordSemanticParticipation } = await import('../semantic-boundary/semantic-disposition.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');
const { canonicalLogicalToolName } = await import('./logical-call-contract.js');

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

test('schema version includes the reconstructable authority payload migration', () => {
  assert.ok(HARNESS_SCHEMA_VERSION >= 49);
  const db = openEventLog();
  const columns = (db.prepare('PRAGMA table_info(physical_dispatches)').all() as Array<{ name: string }>)
    .map((column) => column.name);
  assert.ok(columns.includes('authority_digest'));
  assert.ok(columns.includes('provider_argument_digest'));
  const payload = db.prepare(
    `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'physical_dispatch_authority_payload'`,
  ).get() as { ok: number } | undefined;
  assert.equal(payload?.ok, 1);
  const sealed = db.prepare(
    `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'physical_dispatch_authority_sealed'`,
  ).get() as { ok: number } | undefined;
  assert.equal(sealed?.ok, 1);
  const authorityColumns = (db.prepare('PRAGMA table_info(physical_dispatch_authority)').all() as Array<{ name: string }>)
    .map((column) => column.name);
  assert.ok(authorityColumns.includes('authority_json'));
});

test('minted authority is recursively immutable and digest-bound', () => {
  const minted = mintResolvedCallAuthority({ ...mintBase, manifest: writeManifest() });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.throws(() => {
    (minted.authority as { nodeId: string }).nodeId = 'forged';
  }, TypeError);
  assert.equal(minted.authority.authorityDigest, callAuthorityDigestOf(minted.authority));
  const changed = mintResolvedCallAuthority({
    ...mintBase,
    manifest: writeManifest(),
    nodeId: 'op-other',
  });
  assert.equal(changed.ok, true);
  if (!changed.ok) return;
  assert.notEqual(changed.authority.authorityDigest, minted.authority.authorityDigest);
});

test('uppercase provider operation and lowercase logical identity stay in their domains', () => {
  const raw = 'GOOGLESHEETS_SHEET_FROM_JSON';
  const logical = canonicalLogicalToolName(raw);
  assert.equal(raw, raw.toUpperCase());
  assert.equal(logical, logical.toLowerCase());
  assert.notEqual(raw, logical);
});

test('host_only compile never produces a provider transport payload', () => {
  const transform = productionCapabilityManifests().find((entry) => entry.effect === 'host_only');
  assert.ok(transform);
  const args = compileSealedProviderArgs(transform, undefined, [{ title: 'a' }]);
  assert.equal(args.compiler, transform.argumentCompiler.id);
  assert.equal('sheet_json' in args, false);
});

test('host_only invoke never touches a registered production transport', async () => {
  const transform = productionCapabilityManifests().find((entry) => entry.effect === 'host_only');
  assert.ok(transform);
  let calls = 0;
  installProductionTransport(async () => {
    calls += 1;
    return {};
  });
  const result = await invokeForSealedManifest(transform)({
    nodeId: 'op-transform',
    role: 'transform',
    payload: [{ title: 'a' }],
    identity: { sessionId: 's', sourceUserSeq: 1, acceptedTaskId: 't' },
    binding: {
      capabilityId: transform.manifestId,
      toolName: transform.operationId,
      schemaVersion: transform.operationVersion,
      schemaDigest: transform.definitionFingerprint,
      args: {},
      effect: 'host_only',
      invoke: async () => ({}),
    },
  });
  assert.deepEqual(result, [{ title: 'a' }]);
  assert.equal(calls, 0);
  installProductionTransport(null);
});

test('changing role cannot switch the sealed provider operation', async () => {
  const source = productionCapabilityManifests().find((entry) => entry.purpose === 'locate_source');
  assert.ok(source);
  const seen: string[] = [];
  installProductionTransport(async (call) => {
    seen.push(call.operationId);
    return { locator: 'loc-1', query: 'q' };
  });
  const envelope = sealGraphNodeInvocationEnvelope({
    version: 1,
    identity: { sessionId: 's', sourceUserSeq: 1, acceptedTaskId: 't' },
    goal: { objective: 'find rows', revision: 0, criteria: [] },
    node: { id: 'op-source', role: 'collection' },
    cardinality: { count: 1, fields: ['title'] },
    predecessors: [],
    expectedOutput: { kind: 'locator' },
    binding: {
      capabilityId: source.manifestId,
      manifestDigest: capabilityManifestDigest(source),
      schemaDigest: source.definitionFingerprint,
      account: source.accountId,
      effect: 'read',
    },
  });
  await invokeForSealedManifest(source)({
    nodeId: 'op-source',
    role: 'collection',
    payload: null,
    envelope,
    identity: { sessionId: 's', sourceUserSeq: 1, acceptedTaskId: 't' },
    binding: {
      capabilityId: source.manifestId,
      toolName: source.operationId,
      schemaVersion: source.operationVersion,
      schemaDigest: source.definitionFingerprint,
      args: {},
      account: source.accountId,
      effect: 'read',
      invoke: async () => ({}),
    },
  });
  assert.deepEqual(seen, [source.operationId]);
  installProductionTransport(null);
});

test('unparticipated sources dispatch as conversation, not an untyped action loop', async () => {
  resetEventLog();
  createSession({ id: 'sess-legacy', kind: 'chat' });
  appendEvent({
    sessionId: 'sess-legacy',
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'hello' },
  });
  const dispatched = await dispatchAdmittedSource({
    sessionId: 'sess-legacy',
    turn: 1,
    sourceUserSeq: 1,
  });
  assert.equal(dispatched.kind, 'conversation');
});

test('participated source without a durable graph parks instead of keeping conversation tools', async () => {
  resetEventLog();
  createSession({ id: 'sess-block', kind: 'chat' });
  appendEvent({
    sessionId: 'sess-block',
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'hello' },
  });
  recordSemanticParticipation('sess-block', 1, 'participated');
  const dispatched = await dispatchAdmittedSource({
    sessionId: 'sess-block',
    turn: 1,
    sourceUserSeq: 1,
  });
  assert.notEqual(dispatched.kind, 'conversation', JSON.stringify(dispatched).slice(0, 200));
  assert.ok(
    dispatched.kind === 'blocked' || dispatched.kind === 'needs_input',
    JSON.stringify(dispatched).slice(0, 200),
  );
});

test('frozen catalog copies are immune to mutating the original entry', () => {
  resetEventLog();
  createSession({ id: 'sess-cat', kind: 'chat' });
  const factory = createHostCapabilityCatalogFactory();
  const store = createCapabilityManifestStore();
  const manifest = writeManifest();
  store.install(manifest);
  let invokes = 0;
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
    invoke: async () => {
      invokes += 1;
      return { ok: true };
    },
  });
  installHostCapabilityCatalogFactory(factory);
  const frozen = freezeCatalogSnapshotForSource({ sessionId: 'sess-cat', sourceUserSeq: 1 });
  assert.equal(frozen.ok, true);
  const original = factory.get(manifest.manifestId);
  assert.ok(original);
  original.invoke = async () => {
    throw new Error('mutated original');
  };
  assert.ok(frozen.ok && frozen.entries[0]);
  assert.notEqual(frozen.entries[0]!.invoke, original.invoke);
});

function armTypedCatalog(manifest: ReturnType<typeof writeManifest>) {
  configureTypedExecutionRuntime();
  peekCapabilityManifestStore()?.install(manifest);
  const factory = peekHostCapabilityCatalogFactory() ?? createHostCapabilityCatalogFactory();
  if (!peekHostCapabilityCatalogFactory()) installHostCapabilityCatalogFactory(factory);
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
  refreshTypedExecutionReadiness();
}

test('reservation stores authority and provider-argument digests', () => {
  resetEventLog();
  const sessionId = 'sess-reserve';
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
  const manifest = writeManifest();
  armTypedCatalog(manifest);
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
  const liveObservation = independentlyObserveCapability(manifest.operationId, manifest.accountId);
  assert.ok(liveObservation);
  const lease = acquireCanonicalGraphNodeLease({
    sessionId,
    sourceUserSeq: 1,
    graphId: mintBase.graphId,
    nodeId: mintBase.nodeId,
    owner: `${sessionId}:1`,
  });
  assert.equal(lease.ok, true);
  if (!lease.ok) return;
  const minted = mintResolvedCallAuthority({
    ...mintBase,
    acceptedSource: { sessionId, sourceUserSeq: 1 },
    acceptedTaskId: task.acceptedTaskId,
    manifest,
    observation: liveObservation,
    ownerFence: lease.ownerFence,
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
  const identity = {
    sessionId,
    sourceUserSeq: 1,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: minted.authority.logicalCallId,
    physicalDispatchId: minted.authority.physicalDispatchId,
    ordinal: minted.authority.ordinal,
  };
  const crossing = beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity,
  });
  assert.equal(crossing.status, 'inserted', JSON.stringify(crossing));
  const row = openEventLog().prepare(`
    SELECT authority_digest, provider_argument_digest, execution_site FROM physical_dispatches
     WHERE session_id = ? AND physical_dispatch_id = ?
  `).get(sessionId, minted.authority.physicalDispatchId) as {
    authority_digest: string;
    provider_argument_digest: string;
    execution_site: string | null;
  };
  assert.equal(row.authority_digest, minted.authority.authorityDigest);
  assert.equal(row.provider_argument_digest, minted.authority.canonicalArgumentDigest);
  assert.equal(row.execution_site, null);
  const replay = beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity,
  });
  assert.equal(replay.status, 'replayed');
  const compatibility = beginPhysicalDispatch({
    identity,
    tool: minted.authority.operationId,
    args: minted.authority.canonicalArgs,
    ...{
      authorityDigest: minted.authority.authorityDigest,
      providerArgumentDigest: minted.authority.canonicalArgumentDigest,
    },
  });
  assert.equal(compatibility.status, 'conflict');
});

test('changed authority field refuses replay without a second reservation', () => {
  resetEventLog();
  const sessionId = 'sess-auth-field';
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
  const manifest = writeManifest();
  armTypedCatalog(manifest);
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
  const liveObservation = independentlyObserveCapability(manifest.operationId, manifest.accountId);
  assert.ok(liveObservation);
  const lease = acquireCanonicalGraphNodeLease({
    sessionId,
    sourceUserSeq: 1,
    graphId: mintBase.graphId,
    nodeId: mintBase.nodeId,
    owner: `${sessionId}:1`,
  });
  assert.equal(lease.ok, true);
  if (!lease.ok) return;
  const minted = mintResolvedCallAuthority({
    ...mintBase,
    acceptedSource: { sessionId, sourceUserSeq: 1 },
    acceptedTaskId: task.acceptedTaskId,
    manifest,
    physicalDispatchId: derivePhysicalDispatchId({
      sessionId,
      sourceUserSeq: 1,
      graphId: mintBase.graphId,
      nodeId: mintBase.nodeId,
      logicalCallId: mintBase.logicalCallId,
      ordinal: 1,
      relation: 'primary',
    }),
    ownerFence: lease.ownerFence,
    observation: liveObservation,
  });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const identity = {
    sessionId,
    sourceUserSeq: 1,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: minted.authority.logicalCallId,
    physicalDispatchId: minted.authority.physicalDispatchId,
    ordinal: minted.authority.ordinal,
  };
  assert.equal(beginTypedPhysicalDispatch({
    authority: minted.authority,
    identity,
  }).status, 'inserted');
  const drifted = mintResolvedCallAuthority({
    ...mintBase,
    acceptedSource: { sessionId, sourceUserSeq: 1 },
    acceptedTaskId: task.acceptedTaskId,
    manifest,
    physicalDispatchId: minted.authority.physicalDispatchId,
    ownerFence: lease.ownerFence,
    observation: { ...mintBase.observation, observedAt: Date.now() },
    claimEventId: 'evt-other-claim',
  });
  assert.equal(drifted.ok, true);
  if (!drifted.ok) return;
  assert.notEqual(drifted.authority.authorityDigest, minted.authority.authorityDigest);
  assert.equal(beginTypedPhysicalDispatch({
    authority: drifted.authority,
    identity: { ...identity, logicalToolCallId: drifted.authority.logicalCallId },
  }).status, 'conflict');
  const rows = openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND physical_dispatch_id = ?
  `).get(sessionId, minted.authority.physicalDispatchId) as { n: number };
  assert.equal(rows.n, 1);
});

test('mint refuses invoke-port and compiler drift', () => {
  const missingPort = writeManifest();
  (missingPort as { invokePortId?: string }).invokePortId = '';
  assert.equal(mintResolvedCallAuthority({
    ...mintBase,
    manifest: missingPort,
  }).ok, false);
  const missingCompiler = writeManifest();
  (missingCompiler as { argumentCompiler?: { id: string; version: string } }).argumentCompiler = { id: '', version: '1' };
  assert.equal(mintResolvedCallAuthority({
    ...mintBase,
    manifest: missingCompiler,
  }).ok, false);
});

test('nested canonical args cannot be mutated after mint', () => {
  const minted = mintResolvedCallAuthority({
    ...mintBase,
    manifest: writeManifest(),
    canonicalArgs: { sheet_json: [{ title: 'a', n: 1 }] },
  });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.throws(() => {
    (minted.authority.canonicalArgs.sheet_json as Array<{ title: string }>)[0]!.title = 'forged';
  }, TypeError);
});

test('interrupted v46 mid-ALTER completes on reopen', () => {
  resetEventLog();
  closeEventLog();
  try { unlinkSync(HARNESS_DB_PATH); } catch { /* missing is fine */ }
  const raw = new Database(HARNESS_DB_PATH);
  raw.exec(`
    CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_version (version, applied_at) VALUES (45, '2026-08-16T00:00:00.000Z');
    CREATE TABLE physical_dispatches (
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      accepted_task_id TEXT NOT NULL,
      logical_tool_call_id TEXT NOT NULL,
      physical_dispatch_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      relation TEXT NOT NULL,
      retry_of TEXT,
      tool_name TEXT NOT NULL,
      argument_digest TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'started',
      started_at TEXT NOT NULL,
      settled_at TEXT,
      start_event_id TEXT,
      settle_event_id TEXT,
      authority_digest TEXT,
      PRIMARY KEY (session_id, source_user_seq, physical_dispatch_id)
    );
  `);
  raw.close();

  const migrated = openEventLog();
  assert.equal(
    (migrated.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
    HARNESS_SCHEMA_VERSION,
  );
  const columns = (migrated.prepare('PRAGMA table_info(physical_dispatches)').all() as Array<{ name: string }>)
    .map((column) => column.name);
  assert.ok(columns.includes('authority_digest'));
  assert.ok(columns.includes('provider_argument_digest'));
  const table = migrated.prepare(
    `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'physical_dispatch_authority'`,
  ).get() as { ok: number } | undefined;
  assert.equal(table?.ok, 1);
  const payload = migrated.prepare(
    `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'physical_dispatch_authority_payload'`,
  ).get() as { ok: number } | undefined;
  assert.equal(payload?.ok, 1);
  const authorityColumns = (migrated.prepare('PRAGMA table_info(physical_dispatch_authority)').all() as Array<{ name: string }>)
    .map((column) => column.name);
  assert.ok(authorityColumns.includes('authority_json'));
});
