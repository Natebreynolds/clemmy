/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/indexed-capability-catalog.prime-guard.test.ts
 *
 * Prime keeps a byte-exact catalog row; it never rebuilds one in a different shape.
 *
 * One manifest has two legitimate registration shapes: the direct
 * proof-provisioned row (carries sourceSchemaFingerprint, no
 * implementationDigest) and the adapter row (the inverse). Both are honest
 * projections of the same installed manifest, but the frozen accepted-source
 * snapshot compares identity bytes exactly. Live 2026-08-31 (hard-cut resume):
 * PID B's recovery rehydrated the direct shape byte-exactly, then the resumed
 * turn's planning prime forgot the row and let the adapter re-register it in
 * the other shape — the next freeze refused with `identity_mismatch`, recovery
 * kept ownership, and zero work happened. These pins hold the seam: a row
 * that already matches its installed manifest is kept as-is; rows that are
 * absent or drift are still rebuilt; revocation still evicts.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-prime-guard-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const eventlog = await import('./eventlog.js');
const manifests = await import('./capability-manifest.js');
const manifestStores = await import('./capability-manifest-store.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const observations = await import('./independent-capability-observation.js');
const ports = await import('./production-capability-ports.js');
const adapters = await import('./production-capability-adapter.js');
const indexed = await import('./indexed-capability-catalog.js');
const toolChoices = await import('../../memory/tool-choice-store.js');
const attempts = await import('./attempt-identity.js');
const { digestSchema } = await import('../../tools/tool-contract-store.js');
import type { RegisteredHostCapability } from './host-capability-catalog-factory.js';

const OPERATION = 'learned_news__search_recent_articles';
const ACCOUNT_ID = 'native_mcp:learned-news:config-v1';
const REQUEST = 'Search the newest local model inference articles for the calendar';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const INPUT_SCHEMA = {
  type: 'object',
  required: ['query'],
  properties: { query: { type: 'string' }, limit: { type: 'integer' } },
};
const DEFINITION_FINGERPRINT = digest(`${OPERATION}:${ACCOUNT_ID}:definition-v1`);
const SOURCE_SCHEMA_FINGERPRINT = digest(`${OPERATION}:source-schema-v1`);
const CAPABILITY_ID = `cap:live:mcp:v1:${digest(`${OPERATION}:${ACCOUNT_ID}`).slice(0, 24)}:${DEFINITION_FINGERPRINT}`;

const manifest = manifests.attachSemanticContract({
  version: 1,
  manifestId: CAPABILITY_ID,
  providerKind: 'native_mcp',
  operationId: OPERATION,
  providerIdentity: 'mcp-config:learned-news:config-v1',
  providerVersion: 'provider-v1',
  operationVersion: 'operation-v1',
  definitionFingerprint: DEFINITION_FINGERPRINT,
  externalDefinition: {
    version: 1,
    providerInputSchemaDigest: digestSchema(INPUT_SCHEMA),
    providerOutputSchemaObserved: true,
    semanticName: OPERATION,
    behaviorHints: { readOnly: true, destructive: false, idempotent: null, openWorld: null },
  },
  effect: 'read',
  accountId: ACCOUNT_ID,
  idempotency: { required: false, policy: 'none' },
  reconciliation: { supported: false, policy: 'none' },
  outputContract: { kind: 'records' },
  purpose: 'collect_records',
  acceptedInputKinds: ['evidence'],
  producedOutputKinds: ['evidence', 'records'],
  applicableDeliverableKinds: ['evidence'],
  evidenceContract: { kinds: ['payload'], readbackRequired: false },
  provenance: {
    issuer: 'prime-guard-test',
    issuedAt: '2026-08-31T00:00:00.000Z',
    trusted: true,
  },
  lifecycle: { state: 'current' },
  advisoryRoles: ['source', 'collection'],
});

/** A settled verified read for this exact operation, owned by `sessionId`. */
function verifiedReadProof(sessionId: string): { sourceUserSeq: number } {
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: REQUEST },
  });
  const attemptId = `attempt:${sessionId}`;
  const evidenceDigest = digest(`evidence:${sessionId}`).slice(0, 24);
  const receiptId = `rr_${digest(`receipt:${sessionId}`).slice(0, 32)}`;
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'tool_attempt_settled',
    data: {
      sourceUserSeq: source.seq,
      acceptedTaskId: attempts.acceptedTaskIdFor(sessionId, source.seq),
      attemptId,
      tool: OPERATION,
      kind: 'succeeded',
      dispatchState: 'dispatched',
      mutating: false,
    },
  });
  eventlog.appendEvent({
    sessionId,
    turn: 0,
    role: 'system',
    type: 'read_receipt',
    data: {
      record: {
        receiptId,
        at: '2026-08-31T00:00:01.000Z',
        provider: 'learned-news',
        operation: 'search_recent_articles',
        effectClass: 'read',
        identifier: OPERATION,
        schemaFingerprint: manifest.definitionFingerprint,
        scope: { tenant: 'test-machine', workspace: TEST_HOME, accountIdentity: ACCOUNT_ID },
        dispatchOutcome: 'succeeded',
        source: { sessionId, sourceUserSeq: source.seq, attemptId },
        readEvidenceRef: `evt:${evidenceDigest}`,
      },
    },
  });
  const verifiedReadOrigin = {
    version: 1 as const,
    sessionId,
    sourceUserSeq: source.seq,
    receiptId,
    evidenceDigest,
  };
  toolChoices.rememberToolChoice({
    intent: 'news.recent.search',
    description: REQUEST,
    choice: { kind: 'mcp', identifier: OPERATION, verifiedReadOrigin },
    aliasSource: 'verified_read',
    schemaFingerprint: manifest.definitionFingerprint,
  });
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'capability_resolution',
    data: {
      sourceUserSeq: source.seq,
      authoritativeForTask: true,
      entries: [{
        intent: 'collect the recent articles',
        kind: 'mcp',
        identifier: OPERATION,
        status: 'proven',
        connection: 'active',
        accountIdentity: ACCOUNT_ID,
        effectClass: 'read',
        verifiedReadOrigin,
      }],
    },
  });
  return { sourceUserSeq: source.seq };
}

function installRuntime(): {
  factory: ReturnType<typeof catalogs.createHostCapabilityCatalogFactory>;
  store: ReturnType<typeof manifestStores.createCapabilityManifestStore>;
  adapter: ReturnType<typeof adapters.createProductionCapabilityAdapter>;
  counts: { observe: number; invoke: number };
} {
  const store = manifestStores.createCapabilityManifestStore([manifest]);
  manifestStores.installCapabilityManifestStore(store);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  const counts = { observe: 0, invoke: 0 };
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(manifest),
    {
      observe: () => {
        counts.observe += 1;
        return {
          definitionFingerprint: manifest.definitionFingerprint,
          providerVersion: manifest.providerVersion,
          operationVersion: manifest.operationVersion,
          accountId: manifest.accountId,
          observedAt: Date.now(),
        };
      },
      invoke: async () => {
        counts.invoke += 1;
        return { data: [] };
      },
    },
  ).ok, true);
  const adapter = adapters.createProductionCapabilityAdapter({ factory, store });
  adapters.installProductionCapabilityAdapter(adapter);
  return { factory, store, adapter, counts };
}

/** The direct proof-provisioned registration shape: sourceSchemaFingerprint
 * present, no implementationDigest / invokeImplementationDigest. Exactly what
 * tool_search / plan_task provisioning and the recovery reproof register. */
function directShapeRow(overrides: Partial<RegisteredHostCapability> = {}): RegisteredHostCapability {
  return {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    providerInputSchemaDigest: manifest.externalDefinition!.providerInputSchemaDigest,
    sourceSchemaFingerprint: SOURCE_SCHEMA_FINGERPRINT,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    account: manifest.accountId,
    invoke: async () => ({ data: [] }),
    ...overrides,
  };
}

function freshIndependentObservation(): void {
  assert.deepEqual(observations.registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt: Date.now(),
    origin: 'independent',
  }), { ok: true });
}

function resetRuntime(): void {
  adapters.installProductionCapabilityAdapter(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  rmSync(path.join(TEST_HOME, 'memory', 'tool-choices'), { recursive: true, force: true });
  rmSync(path.join(TEST_HOME, 'memory', 'tool-procedures'), { recursive: true, force: true });
  toolChoices._resetToolChoiceParseCacheForTest();
}

test.beforeEach(resetRuntime);
test.after(() => {
  resetRuntime();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('a frozen direct-shape row survives the planning prime with the identical snapshot digest', async () => {
  const session = eventlog.createSession({ id: 'prime-guard-frozen-source', kind: 'chat' });
  const { sourceUserSeq } = verifiedReadProof(session.id);
  const runtime = installRuntime();
  freshIndependentObservation();
  runtime.factory.register(directShapeRow());
  const before = catalogs.canonicalCatalogIdentityOf(runtime.factory.get(CAPABILITY_ID)!);
  assert.ok(before);
  assert.ok(before.sourceSchemaFingerprint, 'fixture registers the direct proof-provisioned shape');
  assert.equal(before.implementationDigest, undefined);

  const frozen = catalogs.freezeCatalogSnapshotForSource({ sessionId: session.id, sourceUserSeq });
  assert.equal(frozen.ok, true, frozen.ok ? '' : frozen.reason);
  if (!frozen.ok) return;

  const primed = await indexed.registerIndexedCapabilitiesForTurn({
    sessionId: session.id,
    sourceUserSeq,
    objective: REQUEST,
  });
  assert.deepEqual(primed.registered, [CAPABILITY_ID],
    'the verified read nominates this exact manifest, so prime must supply it');

  // THE CLASS: the snapshot frozen before prime must still reconstruct after it.
  const refrozen = catalogs.freezeCatalogSnapshotForSource({ sessionId: session.id, sourceUserSeq });
  assert.equal(refrozen.ok, true, refrozen.ok ? '' : `frozen source refused after prime: ${refrozen.reason}`);
  if (!refrozen.ok) return;
  assert.equal(refrozen.digest, frozen.digest);

  const after = catalogs.canonicalCatalogIdentityOf(runtime.factory.get(CAPABILITY_ID)!);
  assert.ok(after);
  assert.equal(catalogs.catalogIdentitiesEqual(before, after), true,
    'prime must not rebuild an already-exact row in the other registration shape');
  assert.equal(runtime.counts.observe, 0,
    'a row that already matches its installed manifest byte-for-byte is kept, never forgotten and re-observed');
  assert.equal(runtime.counts.invoke, 0);
});

test('a row that drifted from its installed manifest is still forgotten and rebuilt', async () => {
  const session = eventlog.createSession({ id: 'prime-guard-drifted-row', kind: 'chat' });
  const { sourceUserSeq } = verifiedReadProof(session.id);
  const runtime = installRuntime();
  freshIndependentObservation();
  // Same direct shape, but stale account/version bytes: not the installed manifest.
  runtime.factory.register(directShapeRow({
    schemaVersion: 'stale-operation-version',
    account: 'native_mcp:wrong-account',
  }));
  const before = catalogs.canonicalCatalogIdentityOf(runtime.factory.get(CAPABILITY_ID)!);
  assert.ok(before);

  const primed = await indexed.registerIndexedCapabilitiesForTurn({
    sessionId: session.id,
    sourceUserSeq,
    objective: REQUEST,
  });
  assert.deepEqual(primed.registered, [CAPABILITY_ID]);
  assert.equal(runtime.counts.observe, 1, 'drift forces the exact rebuild from the installed manifest');
  const rebuilt = runtime.factory.get(CAPABILITY_ID);
  assert.equal(rebuilt?.schemaVersion, manifest.operationVersion);
  assert.equal(rebuilt?.account, manifest.accountId);
  const after = catalogs.canonicalCatalogIdentityOf(rebuilt!);
  assert.ok(after);
  assert.equal(catalogs.catalogIdentitiesEqual(before, after), false);
});

test('an absent row is still supplied through the adapter', async () => {
  const session = eventlog.createSession({ id: 'prime-guard-absent-row', kind: 'chat' });
  const { sourceUserSeq } = verifiedReadProof(session.id);
  const runtime = installRuntime();
  assert.equal(runtime.factory.get(CAPABILITY_ID), undefined);

  const primed = await indexed.registerIndexedCapabilitiesForTurn({
    sessionId: session.id,
    sourceUserSeq,
    objective: REQUEST,
  });
  assert.deepEqual(primed.registered, [CAPABILITY_ID]);
  assert.equal(runtime.counts.observe, 1, 'one exact adapter observation reopens the durable manifest');
  assert.equal(runtime.factory.get(CAPABILITY_ID)?.manifest?.manifestId, CAPABILITY_ID);
});

test('a revoked manifest is never counted as supplied and is still evicted by the adapter refresh', async () => {
  const session = eventlog.createSession({ id: 'prime-guard-revoked', kind: 'chat' });
  const { sourceUserSeq } = verifiedReadProof(session.id);
  const runtime = installRuntime();
  freshIndependentObservation();
  runtime.factory.register(directShapeRow());
  const frozen = catalogs.freezeCatalogSnapshotForSource({ sessionId: session.id, sourceUserSeq });
  assert.equal(frozen.ok, true, frozen.ok ? '' : frozen.reason);

  assert.equal(runtime.store.revoke(CAPABILITY_ID), true);
  const primed = await indexed.registerIndexedCapabilitiesForTurn({
    sessionId: session.id,
    sourceUserSeq,
    objective: REQUEST,
  });
  assert.deepEqual(primed.registered, [], 'a manifest without a current lifecycle is not planning supply');
  assert.equal(runtime.counts.observe, 0);

  // Readiness refresh is the eviction owner; the guard must not shadow it.
  assert.deepEqual(runtime.adapter.refresh(new Set([CAPABILITY_ID])), {
    registered: 0,
    refused: [{ manifestId: CAPABILITY_ID, reason: 'revoked' }],
  });
  assert.equal(runtime.factory.get(CAPABILITY_ID), undefined);
  const refrozen = catalogs.freezeCatalogSnapshotForSource({ sessionId: session.id, sourceUserSeq });
  assert.deepEqual(refrozen, { ok: false, reason: 'identity_mismatch' },
    'a frozen source whose row was revoked fails closed instead of binding a retired callable');
});

test('a second session priming the same manifest does not break the first source\'s freeze', async () => {
  const first = eventlog.createSession({ id: 'prime-guard-first-session', kind: 'chat' });
  const { sourceUserSeq } = verifiedReadProof(first.id);
  const runtime = installRuntime();
  freshIndependentObservation();
  runtime.factory.register(directShapeRow());
  const frozen = catalogs.freezeCatalogSnapshotForSource({ sessionId: first.id, sourceUserSeq });
  assert.equal(frozen.ok, true, frozen.ok ? '' : frozen.reason);
  if (!frozen.ok) return;

  const second = eventlog.createSession({ id: 'prime-guard-second-session', kind: 'chat' });
  const secondSource = eventlog.appendEvent({
    sessionId: second.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: REQUEST },
  });
  const primed = await indexed.registerIndexedCapabilitiesForTurn({
    sessionId: second.id,
    sourceUserSeq: secondSource.seq,
    objective: REQUEST,
  });
  assert.deepEqual(primed.registered, [CAPABILITY_ID],
    'the same process-local row is legitimate supply for the second session too');

  const refrozen = catalogs.freezeCatalogSnapshotForSource({ sessionId: first.id, sourceUserSeq });
  assert.equal(refrozen.ok, true, refrozen.ok ? '' : `first source refused after a sibling prime: ${refrozen.reason}`);
  if (!refrozen.ok) return;
  assert.equal(refrozen.digest, frozen.digest);
  assert.equal(runtime.counts.observe, 0, 'the shared exact row is kept, not rebuilt in the other shape');
});
