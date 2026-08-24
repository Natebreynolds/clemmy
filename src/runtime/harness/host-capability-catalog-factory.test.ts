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
} = await import('./host-capability-catalog-factory.js');
const { attachSemanticContract, capabilityManifestDigest } = await import('./capability-manifest.js');
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
