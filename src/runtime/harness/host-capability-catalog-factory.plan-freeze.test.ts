/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-capability-catalog-factory.plan-freeze.test.ts
 *
 * Regression pins for the 2026-08-26 gauntlet break (B1 feeder d): pre-model
 * preparation persisted an EMPTY accepted-source catalog snapshot (write-once)
 * before foreground tool_search could disclose anything, so every plan
 * admission was refused with "no longer matches the frozen host catalog".
 * Contract under pin:
 *   1. peekCatalogSnapshotForSource reads the accepted-source view without
 *      persisting anything — preparation can never freeze the turn.
 *   2. freezeCatalogSnapshotForPlanAdmission takes the snapshot AT plan
 *      admission, and extends an already-persisted snapshot monotonically
 *      (append-only) with capabilities registered by same-turn disclosure.
 *   3. Nothing persisted is ever removed/replaced: identity drift of a
 *      persisted capability still fails closed exactly as before.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-catalog-plan-freeze-'));
process.env.CLEMENTINE_HOME = HOME;

const {
  canonicalCatalogIdentityOf,
  catalogSnapshotDigestOf,
  createHostCapabilityCatalogFactory,
  freezeCatalogSnapshotForPlanAdmission,
  freezeCatalogSnapshotForSource,
  installHostCapabilityCatalogFactory,
  peekCatalogSnapshotForSource,
} = await import('./host-capability-catalog-factory.js');
const { attachSemanticContract, capabilityManifestDigest } = await import('./capability-manifest.js');
const { resetEventLog, createSession, appendEvent, openEventLog, closeEventLog } = await import('./eventlog.js');
const { catalogEntriesForAcceptedSource } = await import('./indexed-capability-catalog.js');
import type { CapabilityManifestV1 } from './capability-manifest.js';
import type { RegisteredHostCapability } from './host-capability-catalog-factory.js';

test.after(() => {
  installHostCapabilityCatalogFactory(null);
  closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function operationManifest(operationId: string, effect: 'read' | 'external_write'): CapabilityManifestV1 {
  const write = effect === 'external_write';
  return attachSemanticContract({
    version: 1,
    manifestId: `cap:resolved:${operationId.toLowerCase()}`,
    providerKind: 'composio',
    operationId,
    providerIdentity: `composio:${operationId.split('_')[0]!.toLowerCase()}`,
    providerVersion: 'fixture-v1',
    operationVersion: '1',
    definitionFingerprint: sha256(`live:${operationId}`),
    effect,
    ...(write ? { destination: { family: 'workbook', posture: 'create_new' as const } } : {}),
    accountId: 'acct-fixture',
    idempotency: { required: write, policy: write ? 'key_before_dispatch' as const : 'none' as const },
    reconciliation: { supported: write, policy: write ? 'exact_artifact' as const : 'none' as const },
    outputContract: { kind: write ? 'created_resource' : 'records' },
    evidenceContract: { kinds: write ? ['receipt', 'readback'] : ['payload'], readbackRequired: write },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-26T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: write ? ['destination'] : ['source'],
  });
}

function asRegistered(manifest: CapabilityManifestV1): RegisteredHostCapability {
  return {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    destination: manifest.destination,
    account: manifest.accountId,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({}),
  };
}

function acceptedSource(label: string): { sessionId: string; sourceUserSeq: number } {
  const session = createSession({ kind: 'chat', userId: `user-${label}` });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `make me a google sheet called ${label}` },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

function persistedRow(key: { sessionId: string; sourceUserSeq: number }) {
  return openEventLog().prepare(`
    SELECT snapshot_digest, snapshot_json FROM accepted_source_catalog_snapshots
     WHERE session_id = ? AND source_user_seq = ?
  `).get(key.sessionId, key.sourceUserSeq) as
    | { snapshot_digest: string; snapshot_json: string }
    | undefined;
}

test('peek reads the live accepted-source view without persisting a snapshot', () => {
  resetEventLog();
  const factory = createHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(factory);
  const key = acceptedSource('peek-no-persist');

  const emptyPeek = peekCatalogSnapshotForSource(key);
  assert.equal(emptyPeek.ok, true);
  if (!emptyPeek.ok) return;
  assert.deepEqual(emptyPeek.entries, []);
  assert.equal(persistedRow(key), undefined,
    'preparation must never durably freeze the accepted-source snapshot');

  const registered = asRegistered(operationManifest('GOOGLESHEETS_SHEET_FROM_JSON', 'external_write'));
  factory.register(registered);
  const laterPeek = peekCatalogSnapshotForSource(key);
  assert.equal(laterPeek.ok, true);
  if (!laterPeek.ok) return;
  assert.deepEqual(laterPeek.entries.map((entry) => entry.capabilityId), [registered.capabilityId],
    'a later peek observes what disclosure registered in the meantime');
  assert.equal(persistedRow(key), undefined, 'peek stays a read at every call');
});

test('the pre-model prep path (catalogEntriesForAcceptedSource) no longer persists the empty snapshot', () => {
  resetEventLog();
  const factory = createHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(factory);
  const key = acceptedSource('prep-path');

  // The live 2026-08-26 killer: interpretation/compile enumerated the catalog
  // before the model turn and durably froze snapshot_json='[]'.
  const prepView = catalogEntriesForAcceptedSource(key);
  assert.deepEqual(prepView, []);
  assert.equal(persistedRow(key), undefined,
    'prep-time enumeration must peek, not freeze');

  // Same-turn disclosure then registers the write capability, and plan
  // admission freezes a snapshot that CONTAINS it.
  const registered = asRegistered(operationManifest('GOOGLESHEETS_VALUES_UPDATE', 'external_write'));
  factory.register(registered);
  const admission = freezeCatalogSnapshotForPlanAdmission(key);
  assert.equal(admission.ok, true);
  if (!admission.ok) return;
  assert.deepEqual(admission.entries.map((entry) => entry.capabilityId), [registered.capabilityId]);
  const row = persistedRow(key);
  assert.ok(row, 'plan admission is the seam that persists');
  assert.equal(row!.snapshot_digest, admission.digest);
});

test('plan admission extends an already-persisted snapshot monotonically with same-turn disclosures', () => {
  resetEventLog();
  const factory = createHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(factory);
  const key = acceptedSource('monotonic-extension');

  const read = asRegistered(operationManifest('GOOGLEDRIVE_FIND_FILE', 'read'));
  factory.register(read);
  const first = freezeCatalogSnapshotForPlanAdmission(key);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.entries.map((entry) => entry.capabilityId), [read.capabilityId]);

  // A repaired proposal later in the same turn cites a capability disclosed
  // AFTER the first attempt's freeze.
  const write = asRegistered(operationManifest('GOOGLESHEETS_VALUES_UPDATE', 'external_write'));
  factory.register(write);
  const second = freezeCatalogSnapshotForPlanAdmission(key);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(
    second.entries.map((entry) => entry.capabilityId).sort(),
    [read.capabilityId, write.capabilityId].sort(),
    'the frozen snapshot absorbed the same-turn disclosure',
  );
  const identities = second.entries
    .map((entry) => canonicalCatalogIdentityOf(entry))
    .filter((identity): identity is NonNullable<typeof identity> => identity !== null);
  assert.equal(second.digest, catalogSnapshotDigestOf(identities));

  // Every later ordinary replay (seal, host surface, construct run) sees the
  // extended snapshot; peek agrees.
  const replay = freezeCatalogSnapshotForSource(key);
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.digest, second.digest);
  assert.deepEqual(
    replay.entries.map((entry) => entry.capabilityId).sort(),
    second.entries.map((entry) => entry.capabilityId).sort(),
  );
  const peeked = peekCatalogSnapshotForSource(key);
  assert.equal(peeked.ok, true);
  if (!peeked.ok) return;
  assert.equal(peeked.digest, second.digest);
});

test('extension is append-only: persisted identity drift still fails closed', () => {
  resetEventLog();
  const factory = createHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(factory);
  const key = acceptedSource('append-only-drift');

  const manifest = operationManifest('GOOGLESHEETS_VALUES_UPDATE', 'external_write');
  factory.register(asRegistered(manifest));
  assert.equal(freezeCatalogSnapshotForPlanAdmission(key).ok, true);

  // Same capabilityId, drifted definition: the persisted identity no longer
  // matches live, and NO reader (plan admission included) accepts the drift.
  const drifted = asRegistered({ ...manifest, definitionFingerprint: sha256('drifted') });
  drifted.schemaDigest = sha256('drifted');
  drifted.liveFingerprint = sha256('drifted');
  factory.register(drifted);
  const admission = freezeCatalogSnapshotForPlanAdmission(key);
  assert.equal(admission.ok, false);
  if (!admission.ok) assert.equal(admission.reason, 'identity_mismatch');
  const peeked = peekCatalogSnapshotForSource(key);
  assert.equal(peeked.ok, false);
  if (!peeked.ok) assert.equal(peeked.reason, 'identity_mismatch');
});
