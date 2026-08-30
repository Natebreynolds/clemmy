/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/cross-turn-citable-capability.test.ts
 *
 * A prior proof is useful on the next accepted source only when the current
 * request independently nominates the same exact operation and the installed
 * provider-neutral adapter can reopen its durable manifest, observation, and
 * invocation port. Historical discovery never replays directly as authority.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-cross-turn-citable-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const eventlog = await import('./eventlog.js');
const capabilityIndex = await import('../../memory/capability-index.js');
const manifests = await import('./capability-manifest.js');
const manifestStores = await import('./capability-manifest-store.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const observations = await import('./independent-capability-observation.js');
const ports = await import('./production-capability-ports.js');
const adapters = await import('./production-capability-adapter.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const toolChoices = await import('../../memory/tool-choice-store.js');
const attempts = await import('./attempt-identity.js');

const OPERATION = 'learned_records__query_aurora_dossiers';
const ACCOUNT_ID = 'native_mcp:learned-records:config-v1';
const REQUEST = 'Retrieve the newest aurora dossier records';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const DEFINITION_FINGERPRINT = digest(`${OPERATION}:${ACCOUNT_ID}:definition-v1`);
const CAPABILITY_ID = `cap:live:mcp:v1:${digest(`${OPERATION}:${ACCOUNT_ID}`).slice(0, 24)}:${DEFINITION_FINGERPRINT}`;

const manifest = manifests.attachSemanticContract({
  version: 1,
  manifestId: CAPABILITY_ID,
  providerKind: 'native_mcp',
  operationId: OPERATION,
  providerIdentity: 'mcp-config:learned-records:config-v1',
  providerVersion: 'provider-v1',
  operationVersion: 'operation-v1',
  definitionFingerprint: DEFINITION_FINGERPRINT,
  effect: 'read',
  accountId: ACCOUNT_ID,
  idempotency: { required: false, policy: 'none' },
  reconciliation: { supported: false, policy: 'none' },
  outputContract: { kind: 'records' },
  purpose: 'query_records',
  acceptedInputKinds: ['query'],
  producedOutputKinds: ['records'],
  applicableDeliverableKinds: ['records'],
  evidenceContract: { kinds: ['payload'], readbackRequired: false },
  provenance: {
    issuer: 'cross-turn-citable-test',
    issuedAt: '2026-08-27T00:00:00.000Z',
    trusted: true,
  },
  lifecycle: { state: 'current' },
  advisoryRoles: ['query', 'source'],
});

capabilityIndex.recordCapabilityOperations([{
  identifier: OPERATION,
  carrierKind: 'mcp',
  carrier: 'learned-records',
  displayName: 'Aurora dossier records query',
  description: 'Retrieve the newest aurora dossier records.',
  effectClass: 'read',
  effectProvenance: 'declared',
  accountIdentity: ACCOUNT_ID,
}]);

function priorResolution(input: {
  sessionId: string;
  accountIdentity?: string;
}): number {
  const source = eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: REQUEST },
  });
  const accountIdentity = input.accountIdentity ?? ACCOUNT_ID;
  const attemptId = `attempt:${input.sessionId}`;
  const evidenceDigest = digest(`evidence:${input.sessionId}`).slice(0, 24);
  const receiptId = `rr_${digest(`receipt:${input.sessionId}`).slice(0, 32)}`;
  eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: 1,
    role: 'system',
    type: 'tool_attempt_settled',
    data: {
      sourceUserSeq: source.seq,
      acceptedTaskId: attempts.acceptedTaskIdFor(input.sessionId, source.seq),
      attemptId,
      tool: OPERATION,
      kind: 'succeeded',
      dispatchState: 'dispatched',
      mutating: false,
    },
  });
  eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: 0,
    role: 'system',
    type: 'read_receipt',
    data: {
      record: {
        receiptId,
        at: '2026-08-27T00:00:01.000Z',
        provider: 'learned-records',
        operation: 'query_aurora_dossiers',
        effectClass: 'read',
        identifier: OPERATION,
        schemaFingerprint: manifest.definitionFingerprint,
        scope: {
          tenant: 'test-machine',
          workspace: TEST_HOME,
          accountIdentity,
        },
        dispatchOutcome: 'succeeded',
        source: {
          sessionId: input.sessionId,
          sourceUserSeq: source.seq,
          attemptId,
        },
        readEvidenceRef: `evt:${evidenceDigest}`,
      },
    },
  });
  const verifiedReadOrigin = {
    version: 1 as const,
    sessionId: input.sessionId,
    sourceUserSeq: source.seq,
    receiptId,
    evidenceDigest,
  };
  toolChoices.rememberToolChoice({
    intent: 'aurora.dossier.query',
    description: REQUEST,
    choice: {
      kind: 'mcp',
      identifier: OPERATION,
      verifiedReadOrigin,
    },
    aliasSource: 'verified_read',
    schemaFingerprint: manifest.definitionFingerprint,
  });
  eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: 1,
    role: 'system',
    type: 'capability_resolution',
    data: {
      sourceUserSeq: source.seq,
      authoritativeForTask: true,
      entries: [{
        intent: 'retrieve the source-backed records',
        kind: 'mcp',
        identifier: OPERATION,
        status: 'proven',
        connection: 'active',
        accountIdentity,
        effectClass: 'read',
        verifiedReadOrigin,
      }],
    },
  });
  return source.seq;
}

function linkedCurrentSource(priorSessionId: string, suffix: string): {
  sessionId: string;
  sourceUserSeq: number;
} {
  const session = eventlog.createSession({ id: `cross-turn-citable-${suffix}`, kind: 'chat' });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'cross_session_prefix',
    data: { priorSessionIds: [priorSessionId], sessionsIncluded: 1 },
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: REQUEST },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

function installRuntime(input: { observed: boolean }): {
  factory: ReturnType<typeof catalogs.createHostCapabilityCatalogFactory>;
  store: ReturnType<typeof manifestStores.createCapabilityManifestStore>;
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
      ...(input.observed
        ? {
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
          }
        : {}),
      invoke: async () => {
        counts.invoke += 1;
        return { data: [{ id: 'must-not-run-during-planning' }] };
      },
    },
  ).ok, true);
  adapters.installProductionCapabilityAdapter(adapters.createProductionCapabilityAdapter({
    factory,
    store,
  }));
  return { factory, store, counts };
}

function registerLiveDistractor(
  factory: ReturnType<typeof catalogs.createHostCapabilityCatalogFactory>,
  index: number,
): void {
  const operationId = `DISTRACTOR_QUERY_${index}`;
  const definitionFingerprint = digest(`${operationId}:definition`);
  const distractor = manifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:resolved:distractor_query_${index}`,
    providerKind: 'native_mcp',
    operationId,
    providerIdentity: `native-mcp:distractor-${index}`,
    providerVersion: 'provider-v1',
    operationVersion: 'operation-v1',
    definitionFingerprint,
    effect: 'read',
    accountId: `account:distractor-${index}`,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'retrieve newest aurora dossier records',
    acceptedInputKinds: ['query'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: {
      issuer: 'cross-turn-citable-test',
      issuedAt: '2026-08-27T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['query', 'source'],
  });
  factory.register({
    capabilityId: distractor.manifestId,
    toolName: distractor.operationId,
    schemaVersion: distractor.operationVersion,
    schemaDigest: distractor.definitionFingerprint,
    effect: distractor.effect,
    account: distractor.accountId,
    advisoryRoles: distractor.advisoryRoles,
    manifestDigest: manifests.capabilityManifestDigest(distractor),
    providerKind: distractor.providerKind,
    liveFingerprint: distractor.definitionFingerprint,
    manifest: distractor,
    invoke: async () => ({ data: [] }),
  });
}

test.beforeEach(() => {
  adapters.installProductionCapabilityAdapter(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  rmSync(path.join(TEST_HOME, 'memory', 'tool-choices'), { recursive: true, force: true });
  rmSync(path.join(TEST_HOME, 'memory', 'tool-procedures'), { recursive: true, force: true });
  toolChoices._resetToolChoiceParseCacheForTest();
});

test.after(() => {
  adapters.installProductionCapabilityAdapter(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  eventlog.closeEventLog();
  capabilityIndex._resetCapabilityIndexForTest();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('prior proof plus current nomination rehydrates a citable capability before the primary model', async () => {
  const prior = eventlog.createSession({ id: 'cross-turn-citable-prior', kind: 'chat' });
  priorResolution({ sessionId: prior.id });
  const current = linkedCurrentSource(prior.id, 'current');
  const runtime = installRuntime({ observed: true });
  for (let index = 0; index < 12; index += 1) registerLiveDistractor(runtime.factory, index);
  assert.equal(runtime.factory.get(CAPABILITY_ID), undefined, 'learned in-memory membership starts empty');

  const primed = await semantic.primePrimaryModelPlanningCatalog(current);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error(primed.reason);
  assert.ok(
    primed.planning.capabilities.some((descriptor) => descriptor.id === CAPABILITY_ID),
    'the prior proof supplies a citable current identity even beside a saturated live catalog',
  );
  assert.ok(primed.planning.capabilities.length <= 8, 'the ordinary bounded planning card remains bounded');
  assert.equal(runtime.factory.get(CAPABILITY_ID)?.manifest?.manifestId, CAPABILITY_ID);
  assert.equal(runtime.counts.observe, 1, 'one exact adapter observation reopens the durable manifest');
  assert.equal(runtime.counts.invoke, 0, 'planning supply never crosses the business port');
  assert.equal(
    eventlog.listEvents(current.sessionId, { types: ['capability_resolution'] })
      .filter((event) => event.data.sourceUserSeq === current.sourceUserSeq).length,
    0,
    'historical resolution was not copied into a new authority row',
  );
  assert.equal(
    eventlog.listEvents(current.sessionId, { types: ['capability_discovered'] }).length,
    0,
    'historical discovery was not replayed as current-source authority',
  );
});

test('a historical discovery row without proof cannot enter the citable set', async () => {
  const prior = eventlog.createSession({ id: 'cross-turn-discovery-only-prior', kind: 'chat' });
  const priorSource = eventlog.appendEvent({
    sessionId: prior.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: REQUEST },
  });
  eventlog.appendEvent({
    sessionId: prior.id,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: {
      sourceUserSeq: priorSource.seq,
      capabilities: [{ identifier: OPERATION, capabilityRef: CAPABILITY_ID }],
    },
  });
  const current = linkedCurrentSource(prior.id, 'discovery-only');
  const runtime = installRuntime({ observed: true });

  const primed = await semantic.primePrimaryModelPlanningCatalog(current);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error(primed.reason);
  assert.equal(primed.planning.capabilities.some((row) => row.id === CAPABILITY_ID), false);
  assert.equal(runtime.counts.observe, 0);
  assert.equal(runtime.counts.invoke, 0);
});

test('capability discovery from another sourceUserSeq is never replayed into this source', async () => {
  const session = eventlog.createSession({ id: 'cross-turn-same-session-source-filter', kind: 'chat' });
  const first = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: REQUEST },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: {
      sourceUserSeq: first.seq,
      capabilities: [{
        identifier: OPERATION,
        capabilityRef: CAPABILITY_ID,
        providerKind: 'native_mcp',
      }],
    },
  });
  const second = eventlog.appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: REQUEST },
  });
  const runtime = installRuntime({ observed: true });

  const primed = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: second.seq,
  });
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error(primed.reason);
  assert.equal(primed.planning.capabilities.some((row) => row.id === CAPABILITY_ID), false);
  assert.equal(runtime.counts.observe, 0, 'other-source discovery cannot trigger current revalidation');
  assert.equal(runtime.counts.invoke, 0);
});

test('account drift or a missing current observation keeps prior proof non-citable', async () => {
  const accountPrior = eventlog.createSession({ id: 'cross-turn-account-drift-prior', kind: 'chat' });
  priorResolution({ sessionId: accountPrior.id, accountIdentity: 'account:other' });
  const accountCurrent = linkedCurrentSource(accountPrior.id, 'account-drift');
  const accountRuntime = installRuntime({ observed: true });
  const accountPrimed = await semantic.primePrimaryModelPlanningCatalog(accountCurrent);
  assert.equal(accountPrimed.ok, true, accountPrimed.ok ? '' : accountPrimed.reason);
  if (!accountPrimed.ok) throw new Error(accountPrimed.reason);
  assert.equal(accountPrimed.planning.capabilities.some((row) => row.id === CAPABILITY_ID), false);
  assert.equal(accountRuntime.counts.observe, 0, 'account mismatch refuses before adapter refresh');

  adapters.installProductionCapabilityAdapter(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();

  const unobservedPrior = eventlog.createSession({ id: 'cross-turn-unobserved-prior', kind: 'chat' });
  priorResolution({ sessionId: unobservedPrior.id });
  const unobservedCurrent = linkedCurrentSource(unobservedPrior.id, 'unobserved');
  const unobservedRuntime = installRuntime({ observed: false });
  const unobservedPrimed = await semantic.primePrimaryModelPlanningCatalog(unobservedCurrent);
  assert.equal(unobservedPrimed.ok, true, unobservedPrimed.ok ? '' : unobservedPrimed.reason);
  if (!unobservedPrimed.ok) throw new Error(unobservedPrimed.reason);
  assert.equal(unobservedPrimed.planning.capabilities.some((row) => row.id === CAPABILITY_ID), false);
  assert.equal(unobservedRuntime.counts.invoke, 0);
});

test('cross-turn supply rebuilds a stale cache row and refuses ambiguous current manifests', async () => {
  const stalePrior = eventlog.createSession({ id: 'cross-turn-stale-cache-prior', kind: 'chat' });
  priorResolution({ sessionId: stalePrior.id });
  const staleCurrent = linkedCurrentSource(stalePrior.id, 'stale-cache');
  const staleRuntime = installRuntime({ observed: true });
  observations.registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt: Date.now(),
    origin: 'independent',
  });
  staleRuntime.factory.register({
    capabilityId: CAPABILITY_ID,
    toolName: OPERATION,
    schemaVersion: 'stale-operation-version',
    schemaDigest: digest('stale-schema'),
    effect: 'read',
    account: 'native_mcp:wrong-account',
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: digest('stale-live-definition'),
    manifest,
    invoke: async () => ({ stale: true }),
  });

  const stalePrimed = await semantic.primePrimaryModelPlanningCatalog(staleCurrent);
  assert.equal(stalePrimed.ok, true, stalePrimed.ok ? '' : stalePrimed.reason);
  if (!stalePrimed.ok) throw new Error(stalePrimed.reason);
  assert.ok(stalePrimed.planning.capabilities.some((row) => row.id === CAPABILITY_ID));
  assert.equal(staleRuntime.counts.observe, 1, 'supply forces a fresh rebuild instead of reusing stale bytes');
  assert.equal(staleRuntime.factory.get(CAPABILITY_ID)?.schemaVersion, manifest.operationVersion);
  assert.equal(staleRuntime.factory.get(CAPABILITY_ID)?.schemaDigest, manifest.definitionFingerprint);
  assert.equal(staleRuntime.factory.get(CAPABILITY_ID)?.account, manifest.accountId);

  adapters.installProductionCapabilityAdapter(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  rmSync(path.join(TEST_HOME, 'memory', 'tool-choices'), { recursive: true, force: true });
  rmSync(path.join(TEST_HOME, 'memory', 'tool-procedures'), { recursive: true, force: true });
  toolChoices._resetToolChoiceParseCacheForTest();

  const ambiguousPrior = eventlog.createSession({ id: 'cross-turn-ambiguous-manifest-prior', kind: 'chat' });
  priorResolution({ sessionId: ambiguousPrior.id });
  const ambiguousCurrent = linkedCurrentSource(ambiguousPrior.id, 'ambiguous-manifest');
  const ambiguousRuntime = installRuntime({ observed: true });
  const competing = manifests.attachSemanticContract({
    ...manifest,
    manifestId: `${CAPABILITY_ID}:parallel-current`,
    definitionFingerprint: digest('parallel-current-definition'),
    provenance: {
      issuer: 'cross-turn-citable-test-parallel',
      issuedAt: '2026-08-27T00:00:02.000Z',
      trusted: true,
    },
  });
  assert.equal(ambiguousRuntime.store.install(competing).ok, true);
  const ambiguousPrimed = await semantic.primePrimaryModelPlanningCatalog(ambiguousCurrent);
  assert.equal(ambiguousPrimed.ok, true, ambiguousPrimed.ok ? '' : ambiguousPrimed.reason);
  if (!ambiguousPrimed.ok) throw new Error(ambiguousPrimed.reason);
  assert.equal(ambiguousPrimed.planning.capabilities.some((row) => row.id === CAPABILITY_ID), false);
  assert.equal(ambiguousRuntime.counts.observe, 0, 'ambiguous current identities refuse before refresh');
  assert.equal(ambiguousRuntime.counts.invoke, 0);
});
