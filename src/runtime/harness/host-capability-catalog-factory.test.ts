/** Run: npx tsx --test src/runtime/harness/host-capability-catalog-factory.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-catalog-snapshot-'));
process.env.CLEMENTINE_HOME = HOME;

const {
  canonicalCatalogIdentityOf,
  catalogIdentitiesEqual,
  catalogSnapshotDigestOf,
  createHostCapabilityCatalogFactory,
  freezeCatalogSnapshotForSource,
  installHostCapabilityCatalogFactory,
  isCurrentCallableCatalogEntry,
  resolveProvenLiveReadCatalogEntry,
} = await import('./host-capability-catalog-factory.js');
const { attachSemanticContract, capabilityManifestDigest } = await import('./capability-manifest.js');
const {
  createCapabilityManifestStore,
  installCapabilityManifestStore,
} = await import('./capability-manifest-store.js');
const {
  createProductionCapabilityAdapter,
} = await import('./production-capability-adapter.js');
const { resetEventLog, createSession, appendEvent, openEventLog } = await import('./eventlog.js');
import type { CapabilityManifestV1 } from './capability-manifest.js';
import type { RegisteredHostCapability } from './host-capability-catalog-factory.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sheetManifest(fingerprint = sha256('live:sheet_create')): CapabilityManifestV1 {
  return attachSemanticContract({
    version: 1,
    manifestId: 'cap:sheet-create',
    providerKind: 'local_registry',
    operationId: 'sheet_create',
    providerIdentity: 'local_registry',
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    definitionFingerprint: fingerprint,
    effect: 'external_write',
    destination: { family: 'created_resource', posture: 'create_new' },
    accountId: 'acct-sheets',
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'created_resource' },
    evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-15T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['destination'],
  });
}

function asRegistered(
  manifest: CapabilityManifestV1,
  sourceSchemaFingerprint?: string,
): RegisteredHostCapability {
  return {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    destination: manifest.destination,
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    ...(sourceSchemaFingerprint ? { sourceSchemaFingerprint } : {}),
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({}),
  };
}

test('a mixed-generation proof compiler entry without a foreground validator remains callable', async () => {
  const manifest = attachSemanticContract({
    version: 1,
    manifestId: 'cap:fixture:existing-proof-operation',
    providerKind: 'composio',
    operationId: 'OP_EXISTING_LOOKUP',
    providerIdentity: 'composio',
    providerVersion: 'fixture-provider-v1',
    operationVersion: '1',
    definitionFingerprint: sha256('fixture:existing-proof-operation'),
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: sha256('fixture:existing-proof-operation:schema'),
      providerOutputSchemaObserved: true,
      semanticName: 'existing proof operation',
      behaviorHints: {
        readOnly: true,
        destructive: false,
        idempotent: null,
        openWorld: null,
      },
    },
    effect: 'read',
    purpose: 'invoke_live_read',
    accountId: 'account:fixture:existing-proof-operation',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-31T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['lookup'],
    argumentCompiler: { id: 'compile:proof-schema:v1', version: '1' },
  });
  let bodies = 0;
  const entry: RegisteredHostCapability = {
    ...asRegistered(manifest),
    invoke: async () => {
      bodies += 1;
      return { records: [{ id: 'record-42' }] };
    },
  };
  const factory = createHostCapabilityCatalogFactory([entry]);
  const current = factory.get(entry.capabilityId);
  assert.ok(current);
  assert.equal(current?.validateForegroundPayload, undefined,
    'a durable pre-validator registration remains a valid mixed-generation row');
  assert.equal(isCurrentCallableCatalogEntry(current!), true);
  const result = await current!.invoke({
    nodeId: 'node-existing-proof-operation',
    role: 'foreground',
    payload: { record_key: 'record-42' },
    identity: { sessionId: 'session-fixture', sourceUserSeq: 1, acceptedTaskId: 'task-fixture' },
    binding: {
      capabilityId: entry.capabilityId,
      toolName: entry.toolName,
      schemaVersion: entry.schemaVersion,
      schemaDigest: entry.schemaDigest,
      args: { record_key: 'record-42' },
      account: entry.account,
      effect: entry.effect,
      manifestDigest: entry.manifestDigest,
      providerKind: entry.providerKind,
      liveFingerprint: entry.liveFingerprint,
      manifest,
      invoke: entry.invoke,
    },
  });
  assert.deepEqual(result, { records: [{ id: 'record-42' }] });
  assert.equal(bodies, 1);
});

test('current-callable attestation refuses post-registration provider, port, and compiler drift', () => {
  for (const drift of [
    (manifest: CapabilityManifestV1): CapabilityManifestV1 => ({
      ...manifest,
      providerVersion: 'tool-registry-v2',
    }),
    (manifest: CapabilityManifestV1): CapabilityManifestV1 => ({
      ...manifest,
      invokePortId: 'invoke:stale-port:v2',
    }),
    (manifest: CapabilityManifestV1): CapabilityManifestV1 => ({
      ...manifest,
      argumentCompiler: { id: 'compile:stale:v2', version: '2' },
    }),
  ]) {
    const entry = asRegistered(sheetManifest());
    const factory = createHostCapabilityCatalogFactory([entry]);
    assert.equal(isCurrentCallableCatalogEntry(factory.get(entry.capabilityId)!), true);
    const driftedManifest = drift(entry.manifest!);
    entry.manifest = driftedManifest;
    entry.manifestDigest = capabilityManifestDigest(driftedManifest);
    assert.equal(
      isCurrentCallableCatalogEntry(entry),
      false,
      'a callable row cannot restamp manifest-only call-surface bytes after registration',
    );
  }
});

test('catalog snapshot persists canonical identities and refuses same-ID drift', () => {
  resetEventLog();
  const factory = createHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(factory);
  const original = asRegistered(sheetManifest());
  factory.register(original);
  const session = createSession({ kind: 'chat', userId: 'user-1' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'unused' },
  });
  const first = freezeCatalogSnapshotForSource({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const identity = canonicalCatalogIdentityOf(original);
  assert.ok(identity);
  assert.equal(first.digest, catalogSnapshotDigestOf([identity]));

  const drifted = asRegistered(sheetManifest(sha256('live:sheet_create:drifted')));
  factory.register(drifted);
  assert.equal(catalogIdentitiesEqual(identity!, canonicalCatalogIdentityOf(drifted)!), false);
  const replay = freezeCatalogSnapshotForSource({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.reason, 'identity_mismatch');
});

test('catalog snapshot refuses selector-schema drift even when every workflow identity byte is unchanged', () => {
  resetEventLog();
  const factory = createHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(factory);
  const manifest = sheetManifest();
  const original = asRegistered(manifest, 'a'.repeat(32));
  factory.register(original);
  const session = createSession({ kind: 'chat', userId: 'user-source-schema' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'unused' },
  });
  assert.equal(freezeCatalogSnapshotForSource({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  }).ok, true);

  const drifted = asRegistered(manifest, 'b'.repeat(32));
  assert.equal(
    catalogIdentitiesEqual(canonicalCatalogIdentityOf(original)!, canonicalCatalogIdentityOf(drifted)!),
    false,
  );
  factory.register(drifted);
  const replay = freezeCatalogSnapshotForSource({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.reason, 'identity_mismatch');
});

test('corrupt persisted snapshot digest cannot reconstruct adapters', () => {
  resetEventLog();
  const factory = createHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(factory);
  factory.register(asRegistered(sheetManifest()));
  const session = createSession({ kind: 'chat', userId: 'user-1' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'unused' },
  });
  const first = freezeCatalogSnapshotForSource({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(first.ok, true);
  openEventLog().prepare(
    `UPDATE accepted_source_catalog_snapshots SET snapshot_digest = ? WHERE session_id = ? AND source_user_seq = ?`,
  ).run('0'.repeat(64), session.id, source.seq);
  const replay = freezeCatalogSnapshotForSource({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.reason, 'corrupt_snapshot');
});

test('durable hydration refuses digest mismatch and untrusted rows', async () => {
  resetEventLog();
  const { createCapabilityManifestStore } = await import('./capability-manifest-store.js');
  const { capabilityManifestDigest } = await import('./capability-manifest.js');
  const current = sheetManifest();
  const digest = capabilityManifestDigest(current);
  openEventLog().prepare(
    `INSERT INTO capability_manifests (manifest_id, digest, manifest_json, lifecycle, installed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(current.manifestId, '0'.repeat(64), JSON.stringify(current), 'current', current.provenance.issuedAt);
  openEventLog().prepare(
    `INSERT INTO capability_manifests (manifest_id, digest, manifest_json, lifecycle, installed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    'cap-untrusted',
    digest,
    JSON.stringify({ ...current, manifestId: 'cap-untrusted', provenance: { ...current.provenance, trusted: false } }),
    'current',
    current.provenance.issuedAt,
  );
  const hydrated = createCapabilityManifestStore([], { durable: true });
  assert.equal(hydrated.get(current.manifestId), undefined);
  assert.equal(hydrated.get('cap-untrusted'), undefined);
  assert.equal(hydrated.install(current).reason, 'identity_mismatch');
});

function batchGetRead(
  manifestId: string,
  operationId: string,
  accountId = 'acct-google-1',
): RegisteredHostCapability {
  const fingerprint = sha256(`read:${manifestId}:${operationId}`);
  const manifest = attachSemanticContract({
    version: 1,
    manifestId,
    providerKind: 'composio',
    operationId,
    providerIdentity: 'composio:googlesheets',
    providerVersion: sha256('composio'),
    operationVersion: sha256(operationId),
    definitionFingerprint: fingerprint,
    effect: 'read',
    accountId,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'collect_records',
    acceptedInputKinds: ['query'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-29T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
  });
  return asRegistered(manifest);
}

test('NEGATIVE: a proven Sheets read still resolves when two current spellings share an account', () => {
  const successor = batchGetRead(
    'cap:resolved:googlesheets_batch_get:definition:aaaaaaaaaaaaaaaaaaaaaaaa',
    'GOOGLESHEETS_BATCH_GET',
  );
  const native = batchGetRead('cap:resolved:google_sheets_batch_get', 'google_sheets__batch_get');
  const factory = createHostCapabilityCatalogFactory();
  factory.register(successor);
  factory.register(native);
  installHostCapabilityCatalogFactory(factory);
  const resolved = resolveProvenLiveReadCatalogEntry({
    capabilityId: 'cap:resolved:googlesheets_batch_get',
    effectiveName: 'GOOGLESHEETS_BATCH_GET',
    accountIdentity: 'acct-google-1',
  });
  assert.ok(resolved, 'duplicate transports of one account must not hide the proven read');
  assert.equal(resolved?.effect, 'read');
  assert.ok(
    resolved!.capabilityId === successor.capabilityId
    || resolved!.capabilityId === native.capabilityId,
  );
  installHostCapabilityCatalogFactory(null);
});

test('account-bound direct read resolution never transplants a legacy base from A to B', () => {
  const operationId = 'FIXTURE_LIST_RESOURCES';
  const baseId = 'cap:resolved:fixture_list_resources';
  const a = batchGetRead(baseId, operationId, 'acct-a');
  const b = batchGetRead(`${baseId}:definition:account-b`, operationId, 'acct-b');
  const factory = createHostCapabilityCatalogFactory([a, b]);
  installHostCapabilityCatalogFactory(factory);
  const resolved = resolveProvenLiveReadCatalogEntry({
    capabilityId: baseId,
    effectiveName: operationId,
    accountIdentity: 'acct-b',
  });
  assert.equal(resolved?.capabilityId, b.capabilityId);
  assert.equal(resolved?.account, 'acct-b');
  installHostCapabilityCatalogFactory(null);
});

test('duplicate current identities in one exact account lineage fail closed', () => {
  const operationId = 'FIXTURE_LIST_DUPLICATES';
  const baseId = 'cap:resolved:fixture_list_duplicates';
  const first = batchGetRead(baseId, operationId, 'acct-one');
  const duplicate = batchGetRead(`${baseId}:definition:duplicate`, operationId, 'acct-one');
  const factory = createHostCapabilityCatalogFactory([first, duplicate]);
  installHostCapabilityCatalogFactory(factory);
  assert.equal(resolveProvenLiveReadCatalogEntry({
    capabilityId: baseId,
    effectiveName: operationId,
    accountIdentity: 'acct-one',
  }), null);
  installHostCapabilityCatalogFactory(null);
});

test('a superseded base with an uncallable successor cannot resolve or bind through its stale copy', () => {
  const operationId = 'FIXTURE_LIST_STALE';
  const baseId = 'cap:resolved:fixture_list_stale';
  const base = batchGetRead(baseId, operationId, 'acct-stale');
  const successor = batchGetRead(`${baseId}:definition:current`, operationId, 'acct-stale');
  const store = createCapabilityManifestStore([base.manifest!]);
  assert.equal(store.supersede(baseId, successor.manifest!).ok, true);
  const factory = createHostCapabilityCatalogFactory([base]);
  installCapabilityManifestStore(store);
  installHostCapabilityCatalogFactory(factory);
  assert.equal(resolveProvenLiveReadCatalogEntry({
    capabilityId: baseId,
    effectiveName: operationId,
    accountIdentity: 'acct-stale',
  }), null);
  assert.equal(factory.catalog().bind({
    node: {
      id: 'read-stale',
      kind: 'retrieve',
      capabilityRole: 'source',
      effect: { kind: 'read' },
      capabilities: [{ kind: 'tool', resolution: 'explicit', names: [baseId] }],
    },
    graph: { effectCeiling: 'read' } as never,
    acceptedText: 'read the fixture',
  }), null);
  installHostCapabilityCatalogFactory(null);
  installCapabilityManifestStore(null);
});

test('adapter refresh evicts revoked read and write rows before frozen replay or binding', () => {
  resetEventLog();
  const read = batchGetRead('cap:fixture:revoked-read', 'FIXTURE_REVOKED_READ', 'acct-revoked');
  const writeManifest = attachSemanticContract({
    ...read.manifest!,
    manifestId: 'cap:fixture:revoked-write',
    operationId: 'FIXTURE_REVOKED_WRITE',
    effect: 'external_write',
    destination: { family: 'fixture', posture: 'create_new' },
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
  });
  const write = asRegistered(writeManifest);
  const store = createCapabilityManifestStore([read.manifest!, writeManifest]);
  const factory = createHostCapabilityCatalogFactory();
  const adapter = createProductionCapabilityAdapter({
    store,
    factory,
    observe: {
      composio: (manifest) => ({
        definitionFingerprint: manifest.definitionFingerprint,
        providerVersion: manifest.providerVersion,
        operationVersion: manifest.operationVersion,
        accountId: manifest.accountId,
        observedAt: Date.now(),
      }),
    },
    invokePorts: () => ({
      invoke: async () => ({}),
      reconcile: async () => ({ exists: false }),
    }),
  });
  assert.equal(adapter.refresh().registered, 2);
  installCapabilityManifestStore(store);
  installHostCapabilityCatalogFactory(factory);
  const session = createSession({ kind: 'chat', userId: 'revoked-fixture' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'read the fixture' },
  });
  assert.equal(freezeCatalogSnapshotForSource({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  }).ok, true);
  assert.equal(store.revoke(read.capabilityId), true);
  assert.equal(store.revoke(write.capabilityId), true);
  const refreshed = adapter.refresh();
  assert.ok(refreshed.refused.some((entry) => entry.reason === 'revoked'));
  assert.equal(factory.get(read.capabilityId), undefined);
  assert.equal(factory.get(write.capabilityId), undefined);
  assert.deepEqual(freezeCatalogSnapshotForSource({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  }), { ok: false, reason: 'identity_mismatch' });
  assert.equal(factory.catalog().bind({
    node: {
      id: 'read-revoked',
      kind: 'retrieve',
      capabilityRole: 'source',
      effect: { kind: 'read' },
      capabilities: [{ kind: 'tool', resolution: 'explicit', names: [read.capabilityId] }],
    },
    graph: { effectCeiling: 'read' } as never,
    acceptedText: 'read the fixture',
  }), null);
  installHostCapabilityCatalogFactory(null);
  installCapabilityManifestStore(null);
});
