/** Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/direct-bound-read.test.ts
 *
 * Phase 4 bound-read: a unique attested read with empty proposal operations
 * host-binds (SELECT-1), compiles an executable retrieve node, and runs
 * through the shared typed kernel. Many matching reads refuse to bind and
 * park instead of falling through to conversation. No vendor, mailbox, or
 * user-shaped pins.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-direct-bound-read-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-direct-bound-read\n', 'utf8');

const { appendEvent, createSession, closeEventLog } = await import('../harness/eventlog.js');
const {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
} = await import('../harness/host-capability-catalog-factory.js');
const { createCapabilityManifestStore, installCapabilityManifestStore, peekCapabilityManifestStore } = await import('../harness/capability-manifest-store.js');
const { catalogEntriesForAcceptedSource } = await import('../harness/indexed-capability-catalog.js');
const { synthesizeRetrieveOperation } = await import('./host-bind-operations.js');
const { admitAndCompileAcceptedSource } = await import('./admit-and-compile-accepted-source.js');
const { dispatchAdmittedSource } = await import('./typed-source-dispatch.js');
const { registerShippedTestPort, installIsolatedAttestedTransport } = await import('../harness/isolated-attested-transport.fixture.js');
const { configureTypedExecutionRuntime } = await import('./configure-typed-execution-runtime.js');
const {
  clearIndependentCapabilityObservations,
} = await import('../harness/independent-capability-observation.js');
const { clearProductionCapabilityPorts } = await import('../harness/production-capability-ports.js');
const { installTurnSemanticModelPort } = await import('./turn-semantic-port-registry.js');
const { entailedPlanGroundingJudge, entailedSourceEffectJudge, fakeSemanticProposal } = await import('./fake-semantic-model.js');
const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
const { rememberToolSchema } = await import('../../tools/composio-schema-cache.js');
const {
  installConnectedRegistryPort,
  recordConnectedGoalCatalog,
} = await import('../harness/connected-goal-catalog.js');
const { recordAdmissionCapabilityResolution } = await import('../harness/capability-resolution.js');
const { attachSemanticContract, capabilityManifestDigest } = await import('../harness/capability-manifest.js');
const { turnGraphFromShadowEvent } = await import('../graph/turn-graph-shadow.js');
const { getTurnGraphEventForSource } = await import('../harness/eventlog.js');
import type { RegisteredHostCapability } from '../harness/host-capability-catalog-factory.js';
import type { ManifestEffect } from '../harness/capability-manifest.js';

saveProactivityPolicy({ autoApproveScope: 'yolo' });

test.after(() => {
  installTurnSemanticModelPort(null);
  installConnectedRegistryPort(null);
  installIsolatedAttestedTransport(null);
  closeEventLog();
});

const READ_SCHEMA = {
  type: 'object',
  required: ['q'],
  properties: { q: { type: 'string' }, limit: { type: 'integer' } },
};

const OBJECTIVE = 'Retrieve the requested source.';
const LOOKUP_SLUG = 'SOURCE_LOOKUP';
const LOOKUP_ID = `cap:resolved:${LOOKUP_SLUG.toLowerCase()}`;

function registerAttested(input: {
  slug: string;
  effect: ManifestEffect;
  roles: readonly string[];
  invoke?: RegisteredHostCapability['invoke'];
}): void {
  const factory = peekHostCapabilityCatalogFactory() ?? createHostCapabilityCatalogFactory();
  if (!peekHostCapabilityCatalogFactory()) installHostCapabilityCatalogFactory(factory);
  const fingerprint = createHash('sha256').update(`attested:${input.slug}`).digest('hex');
  const write = input.effect === 'external_write' || input.effect === 'local_write';
  const manifest = attachSemanticContract({
    version: 1,
    manifestId: `cap:resolved:${input.slug.toLowerCase()}`,
    providerKind: input.effect === 'host_only' ? 'local_registry' : 'composio',
    operationId: input.slug,
    providerIdentity: input.effect === 'host_only' ? 'local_registry' : 'composio',
    providerVersion: 'v1',
    operationVersion: '1',
    definitionFingerprint: fingerprint,
    effect: input.effect,
    accountId: input.effect === 'host_only' ? 'host:runtime' : 'acct:connected:v1',
    idempotency: { required: write, policy: write ? 'key_before_dispatch' : 'none' },
    reconciliation: { supported: write, policy: write ? 'exact_artifact' : 'none' },
    outputContract: { kind: write ? 'created_resource' : 'records' },
    evidenceContract: { kinds: write ? ['receipt', 'readback'] : ['payload'], readbackRequired: write },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-21T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: [...input.roles],
  });
  factory.register({
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
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: input.invoke ?? (async () => ({ handle: `payload:${input.slug}` })),
  });
}

function freshSource(text: string): { sessionId: string; sourceUserSeq: number; turn: number } {
  const session = createSession({ kind: 'chat', userId: 'bound-read-user' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
}

function emptyRetrievePort() {
  return {
    async interpret(call: { host: Parameters<typeof fakeSemanticProposal>[1] }) {
      return {
        raw: fakeSemanticProposal({
          relation: 'new_goal',
          goal: {
            objective: OBJECTIVE,
            criteria: [{ id: 'c-result', statement: 'The requested source is returned.' }],
            openSlots: [],
            candidates: [],
          },
          work: {
            construct: 'none',
            cardinality: null,
            destination: null,
            requestedEffect: 'read',
            operations: [],
            deliverables: [{ id: 'result', kind: 'locator' }],
            evidenceRequirements: ['payload'],
          },
        }, call.host),
        modelIdentity: 'fake-semantic/bound-read',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgeSourceEffect(call: Parameters<typeof entailedSourceEffectJudge>[0]) {
      return entailedSourceEffectJudge(call, 'fake-semantic/bound-read-judge');
    },
    async judgePlanGrounding(call: Parameters<typeof entailedPlanGroundingJudge>[0]) {
      return entailedPlanGroundingJudge(call, 'fake-semantic/bound-read-grounding');
    },
  };
}

function resetCatalog(): void {
  installCapabilityManifestStore(createCapabilityManifestStore());
  installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory());
}

test('a unique attested read synthesizes one retrieve operation', () => {
  resetCatalog();
  registerAttested({ slug: LOOKUP_SLUG, effect: 'read', roles: ['lookup'] });
  const identity = freshSource(OBJECTIVE);
  recordAdmissionCapabilityResolution({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    acceptedInput: OBJECTIVE,
    entries: [{
      intent: 'retrieve the requested source',
      kind: 'composio',
      identifier: LOOKUP_SLUG,
      status: 'proven',
      connection: 'active',
      effectClass: 'read',
    }],
  });
  const catalog = catalogEntriesForAcceptedSource({ ...identity, objective: OBJECTIVE });
  assert.equal(catalog.filter((entry) => entry.effect === 'read').length, 1);

  const bound = synthesizeRetrieveOperation({
    construct: 'none',
    route: 'retrieve',
    effectCeiling: 'read',
    objective: OBJECTIVE,
    identity,
  });
  assert.ok(bound, 'unique attested read must bind');
  assert.equal(bound.length, 1);
  assert.equal(bound[0]?.capabilityRef, LOOKUP_ID);
  assert.equal(bound[0]?.requestedEffect, 'read');
  assert.equal(bound[0]?.id, 'op-retrieve');
});

test('two attested lookups refuse to bind (SELECT-1)', () => {
  resetCatalog();
  registerAttested({ slug: LOOKUP_SLUG, effect: 'read', roles: ['lookup'] });
  registerAttested({ slug: 'SOURCE_LOOKUP_B', effect: 'read', roles: ['lookup'] });
  const identity = freshSource(OBJECTIVE);
  recordAdmissionCapabilityResolution({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    acceptedInput: OBJECTIVE,
    entries: [
      {
        intent: 'retrieve the requested source',
        kind: 'composio',
        identifier: LOOKUP_SLUG,
        status: 'proven',
        connection: 'active',
        effectClass: 'read',
      },
      {
        intent: 'retrieve the other source',
        kind: 'composio',
        identifier: 'SOURCE_LOOKUP_B',
        status: 'proven',
        connection: 'active',
        effectClass: 'read',
      },
    ],
  });
  assert.equal(
    catalogEntriesForAcceptedSource({ ...identity, objective: OBJECTIVE })
      .filter((entry) => entry.effect === 'read').length,
    2,
  );
  assert.equal(synthesizeRetrieveOperation({
    construct: 'none',
    route: 'retrieve',
    effectCeiling: 'read',
    objective: OBJECTIVE,
    identity,
  }), null, 'catalog order must not choose between two lookups');
});

test('a unique lookup still binds when a collection read is also attested', () => {
  resetCatalog();
  registerAttested({ slug: LOOKUP_SLUG, effect: 'read', roles: ['lookup'] });
  registerAttested({ slug: 'SOURCE_BATCH', effect: 'read', roles: ['collection'] });
  const identity = freshSource(OBJECTIVE);
  recordAdmissionCapabilityResolution({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    acceptedInput: OBJECTIVE,
    entries: [
      {
        intent: 'retrieve the requested source',
        kind: 'composio',
        identifier: LOOKUP_SLUG,
        status: 'proven',
        connection: 'active',
        effectClass: 'read',
      },
      {
        intent: 'collect records',
        kind: 'composio',
        identifier: 'SOURCE_BATCH',
        status: 'proven',
        connection: 'active',
        effectClass: 'read',
      },
    ],
  });
  const bound = synthesizeRetrieveOperation({
    construct: 'none',
    route: 'retrieve',
    effectCeiling: 'read',
    objective: OBJECTIVE,
    identity,
  });
  assert.ok(bound);
  assert.equal(bound[0]?.capabilityRef, LOOKUP_ID);
});

test('a write ceiling never synthesizes a retrieve bind', () => {
  resetCatalog();
  registerAttested({ slug: LOOKUP_SLUG, effect: 'read', roles: ['lookup'] });
  const identity = freshSource(OBJECTIVE);
  recordAdmissionCapabilityResolution({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    acceptedInput: OBJECTIVE,
    entries: [{
      intent: 'retrieve the requested source',
      kind: 'composio',
      identifier: LOOKUP_SLUG,
      status: 'proven',
      connection: 'active',
      effectClass: 'read',
    }],
  });
  assert.equal(synthesizeRetrieveOperation({
    construct: 'single_act',
    route: 'act',
    effectCeiling: 'external_write',
    objective: OBJECTIVE,
    identity,
  }), null);
});

test('a unique bound read dispatches typed through the shared kernel', async () => {
  clearProductionCapabilityPorts();
  clearIndependentCapabilityObservations();
  resetCatalog();
  configureTypedExecutionRuntime();
  rememberToolSchema(LOOKUP_SLUG, READ_SCHEMA);
  registerAttested({
    slug: LOOKUP_SLUG,
    effect: 'read',
    roles: ['lookup'],
    invoke: async () => ({ locator: `payload:${LOOKUP_SLUG}` }),
  });
  const entry = peekHostCapabilityCatalogFactory()?.get(LOOKUP_ID);
  assert.ok(entry?.manifest);
  peekCapabilityManifestStore()?.install(entry.manifest);
  registerShippedTestPort(entry.manifest);
  installIsolatedAttestedTransport(async (call) => {
    assert.equal(call.operationId, LOOKUP_SLUG);
    return { locator: `payload:${LOOKUP_SLUG}` };
  });
  installConnectedRegistryPort(() => ({
    connectedToolkits: ['source'],
    tools: [{ slug: LOOKUP_SLUG, schema: READ_SCHEMA }],
  }));
  installTurnSemanticModelPort(emptyRetrievePort());

  const identity = freshSource(OBJECTIVE);
  await recordConnectedGoalCatalog({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    objective: OBJECTIVE,
  });

  const admitted = await admitAndCompileAcceptedSource({ identity, surface: 'direct' });
  assert.equal(admitted.ok, true, JSON.stringify(admitted).slice(0, 300));
  if (!admitted.ok) return;

  const graph = turnGraphFromShadowEvent(getTurnGraphEventForSource(identity.sessionId, identity.sourceUserSeq));
  assert.ok(graph);
  const work = graph.nodes.filter((node) => (
    (node.kind === 'retrieve' || node.kind === 'execute')
    && Boolean(node.operationId)
  ));
  assert.equal(work.length, 1, `expected one executable retrieve, found ${work.length}`);
  assert.equal(work[0]?.operationId, 'op-retrieve');
  assert.deepEqual(work[0]?.capabilities?.[0]?.names, [LOOKUP_ID]);

  const dispatched = await dispatchAdmittedSource(identity);
  assert.equal(dispatched.kind, 'typed', JSON.stringify(dispatched).slice(0, 300));
  if (dispatched.kind !== 'typed') return;
  assert.equal(dispatched.result.status, 'success', dispatched.result.error);
  assert.equal(dispatched.result.providerCalls.sourceRead, 1);
  assert.equal(dispatched.result.published, true);
  const recovered = JSON.stringify({
    handles: dispatched.result.handles,
    artifact: dispatched.result.artifactHandle,
  });
  assert.match(recovered, /payload:SOURCE_LOOKUP|locator|op-retrieve/);
});
