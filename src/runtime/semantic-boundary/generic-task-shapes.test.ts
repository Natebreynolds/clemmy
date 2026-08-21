/** Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/generic-task-shapes.test.ts
 *
 * Two provider-neutral shapes. Names are opaque kit slugs, never a vendor or
 * user recipe. Empty proposal operations must host-bind exactly (SELECT-1).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-generic-shapes-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-generic-shapes\n', 'utf8');

const { appendEvent, createSession, closeEventLog, listEvents } = await import('../harness/eventlog.js');
const { commitTurnOutcome } = await import('../harness/delivery-committer.js');
const { turnOutcomeId } = await import('../harness/turn-outcome.js');
const {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
} = await import('../harness/host-capability-catalog-factory.js');
const {
  createCapabilityManifestStore,
  installCapabilityManifestStore,
  peekCapabilityManifestStore,
} = await import('../harness/capability-manifest-store.js');
const { catalogEntriesForAcceptedSource } = await import('../harness/indexed-capability-catalog.js');
const { synthesizeCollectionReadOperations, synthesizeConstructOperations } = await import('./host-bind-operations.js');
const { compileProofProviderArgs } = await import('../harness/proof-provider-args.js');
const { advisoryRolesForProofEntry } = await import('../harness/proof-provisioned-catalog.js');
const { admitAndCompileAcceptedSource } = await import('./admit-and-compile-accepted-source.js');
const { dispatchAdmittedSource } = await import('./typed-source-dispatch.js');
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
const { registerShippedTestPort, installIsolatedAttestedTransport } = await import('../harness/isolated-attested-transport.fixture.js');
const { configureTypedExecutionRuntime } = await import('./configure-typed-execution-runtime.js');
const { clearIndependentCapabilityObservations } = await import('../harness/independent-capability-observation.js');
const { clearProductionCapabilityPorts } = await import('../harness/production-capability-ports.js');
const { physicalCrossingsFor } = await import('../harness/dispatch-ledger.js');
const { issueCollectionReceipt } = await import('../harness/evidence-receipts.js');
const { setAdmittedGraphRunFault } = await import('../harness/admitted-construct-run.js');
const { readCanonicalGraphNodeLease } = await import('../harness/canonical-graph-node-lease.js');
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

const OBJECTIVE = 'Collect four requested records and inspect them.';
const COLLECT_SLUG = 'KITX_QUERY_BATCH';
const TRANSFORM_SLUG = 'HOST_NORMALIZE';
const COLLECT_ID = `cap:resolved:${COLLECT_SLUG.toLowerCase()}`;
const TRANSFORM_ID = `cap:resolved:${TRANSFORM_SLUG.toLowerCase()}`;
const ROWS = [
  { id: 'r1' }, { id: 'r2' }, { id: 'r3' }, { id: 'r4' },
];

function registerAttested(input: {
  slug: string;
  effect: ManifestEffect;
  roles: readonly string[];
  invoke?: RegisteredHostCapability['invoke'];
  providerKind?: 'composio' | 'local_registry' | 'reviewed_cli';
  destination?: { family: string; posture: string };
  reconcile?: RegisteredHostCapability['reconcile'];
  acceptedInputKinds?: readonly string[];
  producedOutputKinds?: readonly string[];
}): void {
  const factory = peekHostCapabilityCatalogFactory() ?? createHostCapabilityCatalogFactory();
  if (!peekHostCapabilityCatalogFactory()) installHostCapabilityCatalogFactory(factory);
  const fingerprint = createHash('sha256').update(`attested:${input.slug}`).digest('hex');
  const write = input.effect === 'external_write' || input.effect === 'local_write';
  const hostOnly = input.effect === 'host_only';
  const providerKind = input.providerKind
    ?? (hostOnly ? 'local_registry' : 'composio');
  const manifest = attachSemanticContract({
    version: 1,
    manifestId: `cap:resolved:${input.slug.toLowerCase()}`,
    providerKind,
    operationId: input.slug,
    providerIdentity: providerKind === 'reviewed_cli' ? '/usr/bin/kitx-lookup' : providerKind,
    providerVersion: providerKind === 'reviewed_cli' ? fingerprint : 'v1',
    operationVersion: '1',
    definitionFingerprint: fingerprint,
    effect: input.effect,
    ...(input.destination ? { destination: input.destination } : {}),
    accountId: providerKind === 'composio' ? 'acct:connected:v1' : 'host:runtime',
    idempotency: { required: write, policy: write ? 'key_before_dispatch' : 'none' },
    reconciliation: { supported: write, policy: write ? 'exact_artifact' : 'none' },
    outputContract: { kind: write ? 'created_resource' : 'records' },
    evidenceContract: { kinds: write ? ['receipt', 'readback'] : ['payload'], readbackRequired: write },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-21T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: [...input.roles],
    ...(input.acceptedInputKinds ? { acceptedInputKinds: [...input.acceptedInputKinds] } : {}),
    ...(input.producedOutputKinds ? { producedOutputKinds: [...input.producedOutputKinds] } : {}),
  });
  factory.register({
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    destination: manifest.destination ?? input.destination,
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: input.invoke ?? (async () => ({ records: ROWS })),
    ...(input.reconcile ? { reconcile: input.reconcile } : {}),
  });
}

function resetCatalog(): void {
  installConnectedRegistryPort(null);
  installCapabilityManifestStore(createCapabilityManifestStore());
  installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory());
}

function freshSource(text: string) {
  const session = createSession({ kind: 'chat', userId: 'shape-user' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
}

test('a unique collection read plus unique inspect binds the collection shape', () => {
  resetCatalog();
  registerAttested({ slug: COLLECT_SLUG, effect: 'read', roles: ['collection'] });
  registerAttested({ slug: TRANSFORM_SLUG, effect: 'host_only', roles: ['transform'] });
  const identity = freshSource(OBJECTIVE);
  recordAdmissionCapabilityResolution({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    acceptedInput: OBJECTIVE,
    entries: [{
      intent: 'collect the requested records',
      kind: 'composio',
      identifier: COLLECT_SLUG,
      status: 'proven',
      connection: 'active',
      effectClass: 'read',
    }],
  });
  const bound = synthesizeCollectionReadOperations({
    construct: 'single_act',
    route: 'act',
    effectCeiling: 'read',
    objective: OBJECTIVE,
    count: 4,
    identity,
  });
  assert.ok(bound);
  assert.equal(bound.find((op) => op.role === 'collection')?.capabilityRef, COLLECT_ID);
  assert.equal(bound.find((op) => op.role === 'transform')?.capabilityRef, TRANSFORM_ID);
});

test('two collection reads refuse to bind (SELECT-1)', () => {
  resetCatalog();
  registerAttested({ slug: COLLECT_SLUG, effect: 'read', roles: ['collection'] });
  registerAttested({ slug: 'KITX_SEARCH_BATCH', effect: 'read', roles: ['collection'] });
  const identity = freshSource(OBJECTIVE);
  recordAdmissionCapabilityResolution({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    acceptedInput: OBJECTIVE,
    entries: [
      {
        intent: 'collect',
        kind: 'composio',
        identifier: COLLECT_SLUG,
        status: 'proven',
        connection: 'active',
        effectClass: 'read',
      },
      {
        intent: 'collect other',
        kind: 'composio',
        identifier: 'KITX_SEARCH_BATCH',
        status: 'proven',
        connection: 'active',
        effectClass: 'read',
      },
    ],
  });
  assert.equal(catalogEntriesForAcceptedSource({ ...identity, objective: OBJECTIVE })
    .filter((entry) => entry.effect === 'read').length, 2);
  assert.equal(synthesizeCollectionReadOperations({
    construct: 'single_act',
    effectCeiling: 'read',
    objective: OBJECTIVE,
    count: 4,
    identity,
  }), null);
});

test('a unique collection still binds when a lookup is also attested', () => {
  resetCatalog();
  registerAttested({ slug: COLLECT_SLUG, effect: 'read', roles: ['collection'] });
  registerAttested({ slug: 'KITX_LOOKUP', effect: 'read', roles: ['lookup'] });
  const identity = freshSource(OBJECTIVE);
  recordAdmissionCapabilityResolution({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    acceptedInput: OBJECTIVE,
    entries: [
      {
        intent: 'collect',
        kind: 'composio',
        identifier: COLLECT_SLUG,
        status: 'proven',
        connection: 'active',
        effectClass: 'read',
      },
      {
        intent: 'lookup',
        kind: 'composio',
        identifier: 'KITX_LOOKUP',
        status: 'proven',
        connection: 'active',
        effectClass: 'read',
      },
    ],
  });
  const bound = synthesizeCollectionReadOperations({
    construct: 'single_act',
    effectCeiling: 'read',
    objective: OBJECTIVE,
    count: 4,
    identity,
  });
  assert.ok(bound);
  assert.equal(bound.find((op) => op.role === 'collection')?.capabilityRef, COLLECT_ID);
});

test('a repair interpret names the exact attested contract when unique bind misses', async () => {
  clearProductionCapabilityPorts();
  clearIndependentCapabilityObservations();
  resetCatalog();
  configureTypedExecutionRuntime();
  const otherSlug = 'KITX_SEARCH_BATCH';
  rememberToolSchema(COLLECT_SLUG, READ_SCHEMA);
  rememberToolSchema(otherSlug, READ_SCHEMA);
  registerAttested({
    slug: COLLECT_SLUG,
    effect: 'read',
    roles: ['collection'],
    invoke: async () => ({ records: ROWS }),
  });
  registerAttested({
    slug: otherSlug,
    effect: 'read',
    roles: ['collection'],
    invoke: async () => ({ records: ROWS }),
  });
  const collect = peekHostCapabilityCatalogFactory()?.get(COLLECT_ID);
  assert.ok(collect?.manifest);
  peekCapabilityManifestStore()?.install(collect.manifest);
  registerShippedTestPort(collect.manifest);
  installIsolatedAttestedTransport(async (call) => {
    assert.equal(call.operationId, COLLECT_SLUG);
    return { records: ROWS };
  });
  let interpretCalls = 0;
  installTurnSemanticModelPort({
    async interpret(call) {
      interpretCalls += 1;
      const named = Boolean(call.repairHint);
      return {
        raw: fakeSemanticProposal({
          relation: 'new_goal',
          goal: {
            objective: OBJECTIVE,
            criteria: [{ id: 'c-set', statement: 'Four requested records are returned.' }],
            openSlots: [],
            candidates: [],
          },
          work: {
            construct: 'single_act',
            cardinality: { count: 4, fields: ['id'] },
            destination: null,
            requestedEffect: 'read',
            operations: named
              ? [{
                  id: 'op-collect',
                  role: 'collection',
                  requestedEffect: 'read',
                  capabilityRef: COLLECT_ID,
                  dependsOn: [],
                  evidence: ['collection'],
                }]
              : [],
            deliverables: [{ id: 'result', kind: 'records' }],
            evidenceRequirements: ['collection'],
          },
        }, call.host),
        modelIdentity: 'fake-semantic/bind-repair',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgeSourceEffect(call) {
      return entailedSourceEffectJudge(call, 'fake-semantic/bind-repair-judge');
    },
    async judgePlanGrounding(call) {
      return entailedPlanGroundingJudge(call, 'fake-semantic/bind-repair-grounding');
    },
  });
  const identity = freshSource(OBJECTIVE);
  recordAdmissionCapabilityResolution({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    acceptedInput: OBJECTIVE,
    entries: [
      {
        intent: 'collect',
        kind: 'composio',
        identifier: COLLECT_SLUG,
        status: 'proven',
        connection: 'active',
        effectClass: 'read',
      },
      {
        intent: 'collect other',
        kind: 'composio',
        identifier: otherSlug,
        status: 'proven',
        connection: 'active',
        effectClass: 'read',
      },
    ],
  });
  const admitted = await admitAndCompileAcceptedSource({ identity, surface: 'direct' });
  assert.equal(admitted.ok, true, JSON.stringify(admitted).slice(0, 300));
  assert.equal(interpretCalls, 2, 'host bind miss must ask the model to name an attested contract');
  if (!admitted.ok) return;
  const dispatched = await dispatchAdmittedSource(identity);
  assert.equal(dispatched.kind, 'typed', JSON.stringify(dispatched).slice(0, 400));
  if (dispatched.kind !== 'typed') return;
  assert.equal(dispatched.result.status, 'success', dispatched.result.error);
});

test('a named contract that grounding does not entail still gets one repair interpret', async () => {
  clearProductionCapabilityPorts();
  clearIndependentCapabilityObservations();
  resetCatalog();
  configureTypedExecutionRuntime();
  rememberToolSchema(COLLECT_SLUG, READ_SCHEMA);
  registerAttested({
    slug: COLLECT_SLUG,
    effect: 'read',
    roles: ['collection'],
    invoke: async () => ({ records: ROWS }),
  });
  const collect = peekHostCapabilityCatalogFactory()?.get(COLLECT_ID);
  assert.ok(collect?.manifest);
  peekCapabilityManifestStore()?.install(collect.manifest);
  registerShippedTestPort(collect.manifest);
  installIsolatedAttestedTransport(async (call) => {
    assert.equal(call.operationId, COLLECT_SLUG);
    return { records: ROWS };
  });
  let interpretCalls = 0;
  let groundingCalls = 0;
  installTurnSemanticModelPort({
    async interpret(call) {
      interpretCalls += 1;
      return {
        raw: fakeSemanticProposal({
          relation: 'new_goal',
          goal: {
            objective: OBJECTIVE,
            criteria: [{ id: 'c-set', statement: 'Four requested records are returned.' }],
            openSlots: [],
            candidates: [],
          },
          work: {
            construct: 'single_act',
            cardinality: { count: 4, fields: ['id'] },
            destination: null,
            requestedEffect: 'read',
            operations: [{
              id: 'op-collect',
              role: 'collection',
              requestedEffect: 'read',
              capabilityRef: COLLECT_ID,
              dependsOn: [],
              evidence: ['collection'],
            }],
            deliverables: [{ id: 'result', kind: 'records' }],
            evidenceRequirements: ['collection'],
          },
        }, call.host),
        modelIdentity: 'fake-semantic/ground-repair',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgeSourceEffect(call) {
      return entailedSourceEffectJudge(call, 'fake-semantic/ground-repair-judge');
    },
    async judgePlanGrounding(call) {
      groundingCalls += 1;
      if (groundingCalls === 1) {
        return {
          verdict: 'uncertain',
          operations: call.dag.operations.map((operation) => ({
            operationId: operation.id,
            verdict: 'uncertain' as const,
            rationale: 'Role fit is sound: the named contract produces records.',
          })),
          modelIdentity: 'fake-semantic/ground-repair',
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
        };
      }
      return entailedPlanGroundingJudge(call, 'fake-semantic/ground-repair');
    },
  });
  const identity = freshSource(OBJECTIVE);
  recordAdmissionCapabilityResolution({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    acceptedInput: OBJECTIVE,
    entries: [{
      intent: 'collect',
      kind: 'composio',
      identifier: COLLECT_SLUG,
      status: 'proven',
      connection: 'active',
      effectClass: 'read',
    }],
  });
  const admitted = await admitAndCompileAcceptedSource({ identity, surface: 'direct' });
  assert.equal(admitted.ok, true, JSON.stringify(admitted).slice(0, 300));
  assert.equal(interpretCalls, 2, 'grounding miss must ask the model to name the attested contract again');
  assert.equal(groundingCalls, 2);
  if (!admitted.ok) return;
  const dispatched = await dispatchAdmittedSource(identity);
  assert.equal(dispatched.kind, 'typed', JSON.stringify(dispatched).slice(0, 400));
  if (dispatched.kind !== 'typed') return;
  assert.equal(dispatched.result.status, 'success', dispatched.result.error);
});

test('a sibling write in the same toolkit does not collapse reads to readback-only', () => {
  const listRoles = advisoryRolesForProofEntry({
    effect: 'read',
    schema: {
      type: 'object',
      required: ['q'],
      properties: { q: { type: 'string' }, limit: { type: 'integer' } },
    },
    siblingWriteInToolkit: true,
  });
  assert.ok(listRoles.includes('collection'), JSON.stringify(listRoles));
  assert.ok(listRoles.includes('lookup'), JSON.stringify(listRoles));
  const writeRoles = advisoryRolesForProofEntry({
    effect: 'external_write',
    schema: {
      type: 'object',
      required: ['body'],
      properties: { body: { type: 'string' } },
    },
    siblingWriteInToolkit: true,
  });
  assert.deepEqual(writeRoles, ['create', 'destination']);
});

test('bounded collection read compiles exact operations and stays off conversation', async () => {
  clearProductionCapabilityPorts();
  clearIndependentCapabilityObservations();
  resetCatalog();
  configureTypedExecutionRuntime();
  rememberToolSchema(COLLECT_SLUG, READ_SCHEMA);
  registerAttested({
    slug: COLLECT_SLUG,
    effect: 'read',
    roles: ['collection'],
    invoke: async () => ({ records: ROWS }),
  });
  registerAttested({
    slug: TRANSFORM_SLUG,
    effect: 'host_only',
    roles: ['transform'],
    invoke: async (input) => input.payload ?? { records: ROWS },
  });
  const collect = peekHostCapabilityCatalogFactory()?.get(COLLECT_ID);
  const transform = peekHostCapabilityCatalogFactory()?.get(TRANSFORM_ID);
  assert.ok(collect?.manifest && transform?.manifest);
  peekCapabilityManifestStore()?.install(collect.manifest);
  peekCapabilityManifestStore()?.install(transform.manifest);
  registerShippedTestPort(collect.manifest);
  registerShippedTestPort(transform.manifest);
  installIsolatedAttestedTransport(async (call) => {
    if (call.operationId === COLLECT_SLUG) return { records: ROWS };
    if (call.operationId === TRANSFORM_SLUG) return { records: ROWS };
    throw new Error(`unexpected ${call.operationId}`);
  });
  installConnectedRegistryPort(() => ({
    connectedToolkits: ['kitx'],
    tools: [{ slug: COLLECT_SLUG, schema: READ_SCHEMA }],
  }));
  installTurnSemanticModelPort({
    async interpret(call) {
      return {
        raw: fakeSemanticProposal({
          relation: 'new_goal',
          goal: {
            objective: OBJECTIVE,
            criteria: [{ id: 'c-set', statement: 'Four requested records are returned.' }],
            openSlots: [],
            candidates: [],
          },
          work: {
            construct: 'single_act',
            cardinality: { count: 4, fields: ['id'] },
            destination: null,
            requestedEffect: 'read',
            operations: [],
            deliverables: [{ id: 'result', kind: 'records' }],
            evidenceRequirements: ['collection'],
          },
        }, call.host),
        modelIdentity: 'fake-semantic/collection-shape',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgeSourceEffect(call) {
      return entailedSourceEffectJudge(call, 'fake-semantic/collection-judge');
    },
    async judgePlanGrounding(call) {
      return entailedPlanGroundingJudge(call, 'fake-semantic/collection-grounding');
    },
  });

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
  const work = graph.nodes.filter((node) => Boolean(node.operationId));
  assert.ok(work.some((node) => node.operationId === 'op-collect'));
  assert.ok(work.some((node) => node.operationId === 'op-transform'));
  const collectNode = graph.nodes.find((node) => node.operationId === 'op-collect');
  assert.equal(collectNode?.cardinality, 4, 'bounded collection count must compile onto the collect node');
  const dispatched = await dispatchAdmittedSource(identity);
  assert.equal(dispatched.kind, 'typed', JSON.stringify(dispatched).slice(0, 400));
  if (dispatched.kind !== 'typed') return;
  assert.equal(dispatched.result.status, 'success', dispatched.result.error);
  const follow = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: 'Want me to also sort those records?' },
  });
  assert.equal(follow.presentation.status, 'done', 'optional follow-up must not reopen a completed read');
  const terminals = listEvents(identity.sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.filter((event) => event.data.sourceUserSeq === identity.sourceUserSeq).length, 1);
});

const CREATE_SCHEMA = {
  type: 'object',
  required: ['title', 'records_json'],
  properties: {
    title: { type: 'string' },
    records_json: { type: 'string' },
  },
};
const READBACK_SCHEMA = {
  type: 'object',
  required: ['resource_id'],
  properties: { resource_id: { type: 'string' } },
};
const CREATE_SLUG = 'KITX_RECORD_FROM_JSON';
const READBACK_SLUG = 'KITX_RESOURCE_GET';

test('collect-construct binds exact generic operations without catalog-order picks', () => {
  resetCatalog();
  rememberToolSchema(COLLECT_SLUG, READ_SCHEMA);
  rememberToolSchema(CREATE_SLUG, CREATE_SCHEMA);
  rememberToolSchema(READBACK_SLUG, READBACK_SCHEMA);
  registerAttested({ slug: COLLECT_SLUG, effect: 'read', roles: ['source', 'collection'] });
  registerAttested({
    slug: CREATE_SLUG,
    effect: 'external_write',
    roles: ['create', 'destination'],
  });
  registerAttested({ slug: READBACK_SLUG, effect: 'read', roles: ['readback'] });
  registerAttested({ slug: TRANSFORM_SLUG, effect: 'host_only', roles: ['transform'] });
  const identity = freshSource('Collect four records and persist them to a new artifact.');
  recordAdmissionCapabilityResolution({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    acceptedInput: 'Collect four records and persist them to a new artifact.',
    entries: [
      {
        intent: 'collect',
        kind: 'composio',
        identifier: COLLECT_SLUG,
        status: 'proven',
        connection: 'active',
        effectClass: 'read',
      },
      {
        intent: 'create',
        kind: 'composio',
        identifier: CREATE_SLUG,
        status: 'proven',
        connection: 'active',
        effectClass: 'write',
      },
      {
        intent: 'readback',
        kind: 'composio',
        identifier: READBACK_SLUG,
        status: 'proven',
        connection: 'active',
        effectClass: 'read',
      },
    ],
  });
  const bound = synthesizeConstructOperations({
    construct: 'collect_then_construct',
    objective: 'Collect four records and persist them to a new artifact.',
    destinationFamily: 'artifact',
    effectCeiling: 'external_write',
    count: 4,
    identity,
  });
  assert.ok(bound, 'generic attested contracts must bind the construct shape');
  assert.equal(bound.find((op) => op.role === 'source')?.capabilityRef, COLLECT_ID);
  assert.equal(bound.find((op) => op.role === 'destination')?.capabilityRef, `cap:resolved:${CREATE_SLUG.toLowerCase()}`);
  assert.equal(bound.find((op) => op.role === 'readback')?.capabilityRef, `cap:resolved:${READBACK_SLUG.toLowerCase()}`);
  assert.equal(bound.find((op) => op.role === 'transform')?.capabilityRef, TRANSFORM_ID);
});

test('a retrieve with two required string fields fills both from the objective', () => {
  const args = compileProofProviderArgs({
    schema: {
      type: 'object',
      required: ['needle', 'scope'],
      properties: {
        needle: { type: 'string' },
        scope: { type: 'string' },
        created_at: { type: 'string' },
      },
    },
    role: 'lookup',
    effect: 'read',
    payload: undefined,
    envelope: {
      version: 1,
      identity: { sessionId: 's', sourceUserSeq: 1, acceptedTaskId: 't' },
      goal: { objective: 'the requested source window', revision: 0, criteria: [] },
      node: { id: 'n', role: 'lookup' },
      cardinality: null,
      predecessors: [],
      expectedOutput: { kind: 'evidence' },
      binding: { capabilityId: 'cap', manifestDigest: 'm', schemaDigest: 's', effect: 'read' },
    } as never,
  });
  assert.ok(args);
  assert.equal(args.needle, 'the requested source window');
  assert.equal(args.scope, 'the requested source window');
  assert.equal('created_at' in args, false);
});

test('time-scoped reads fill the schema required field, not a sibling timestamp', () => {
  const schema = {
    type: 'object',
    required: ['occurred_at'],
    properties: {
      occurred_at: { type: 'string' },
      created_at: { type: 'string' },
    },
  };
  const args = compileProofProviderArgs({
    schema,
    role: 'collection',
    effect: 'read',
    payload: undefined,
    envelope: {
      version: 1,
      identity: { sessionId: 's', sourceUserSeq: 1, acceptedTaskId: 't' },
      goal: { objective: 'records that occurred this week', revision: 0, criteria: [] },
      node: { id: 'n', role: 'collection' },
      cardinality: { count: 4, fields: ['id'] },
      predecessors: [],
      expectedOutput: { kind: 'evidence' },
      binding: { capabilityId: 'cap', manifestDigest: 'm', schemaDigest: 's', effect: 'read' },
    } as never,
  });
  assert.ok(args);
  assert.equal(args.occurred_at, 'records that occurred this week');
  assert.equal('created_at' in args, false);
});

test('empty memory does not grant collection bind without attested selection', () => {
  resetCatalog();
  registerAttested({ slug: COLLECT_SLUG, effect: 'read', roles: ['collection'] });
  const identity = freshSource(OBJECTIVE);
  assert.equal(catalogEntriesForAcceptedSource({ ...identity, objective: OBJECTIVE })
    .filter((entry) => entry.effect === 'read').length, 0);
  assert.equal(synthesizeCollectionReadOperations({
    construct: 'single_act',
    effectCeiling: 'read',
    objective: OBJECTIVE,
    count: 4,
    identity,
  }), null);
});

test('a renamed unique collection slug still binds (discovery is not a recipe)', () => {
  resetCatalog();
  const renamed = 'KITX_QUERY_BATCH_RENAMED';
  registerAttested({ slug: renamed, effect: 'read', roles: ['collection'] });
  const identity = freshSource(OBJECTIVE);
  recordAdmissionCapabilityResolution({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    acceptedInput: OBJECTIVE,
    entries: [{
      intent: 'collect',
      kind: 'composio',
      identifier: renamed,
      status: 'proven',
      connection: 'active',
      effectClass: 'read',
    }],
  });
  const bound = synthesizeCollectionReadOperations({
    construct: 'single_act',
    effectCeiling: 'read',
    objective: OBJECTIVE,
    count: 4,
    identity,
  });
  assert.ok(bound);
  assert.equal(bound[0]?.capabilityRef, `cap:resolved:${renamed.toLowerCase()}`);
});

test('an unsupported participated shape stops instead of falling through', async () => {
  const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
  const { recordSemanticParticipation } = await import('./semantic-disposition.js');
  const identity = freshSource('fan this work out across independent sinks then join them');
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, turn: 1 },
  }));
  recordSemanticParticipation(identity.sessionId, identity.sourceUserSeq, 'participated');
  const dispatched = await dispatchAdmittedSource(identity);
  assert.notEqual(dispatched.kind, 'conversation', JSON.stringify(dispatched).slice(0, 300));
  assert.ok(
    dispatched.kind === 'blocked' || dispatched.kind === 'needs_input',
    JSON.stringify(dispatched).slice(0, 300),
  );
});

function emptyCollectConstructPort() {
  return {
    async interpret(call: { host: Parameters<typeof fakeSemanticProposal>[1] }) {
      return {
        raw: fakeSemanticProposal({
          relation: 'new_goal',
          goal: {
            objective: 'Collect four records, normalize them, persist a new artifact, and read it back.',
            criteria: [
              { id: 'c-set', statement: 'Four records are collected.' },
              { id: 'c-dest', statement: 'A new artifact holds them.' },
            ],
            openSlots: [],
            candidates: [],
          },
          work: {
            construct: 'collect_then_construct',
            cardinality: { count: 4, fields: ['id'] },
            destination: { posture: 'create_new', family: 'artifact', handleRequired: true },
            requestedEffect: 'external_write',
            operations: [],
            deliverables: [{ id: 'artifact', kind: 'artifact' }],
            evidenceRequirements: ['collection', 'create-receipt', 'readback'],
          },
        }, call.host),
        modelIdentity: 'fake-semantic/construct-shape',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgeSourceEffect(call: Parameters<typeof entailedSourceEffectJudge>[0]) {
      return entailedSourceEffectJudge(call, 'fake-semantic/construct-judge');
    },
    async judgePlanGrounding(call: Parameters<typeof entailedPlanGroundingJudge>[0]) {
      return entailedPlanGroundingJudge(call, 'fake-semantic/construct-grounding');
    },
  };
}

async function admitConstructTurn(creates: { count: number }) {
  clearProductionCapabilityPorts();
  clearIndependentCapabilityObservations();
  resetCatalog();
  configureTypedExecutionRuntime();
  rememberToolSchema(COLLECT_SLUG, READ_SCHEMA);
  rememberToolSchema(CREATE_SLUG, CREATE_SCHEMA);
  rememberToolSchema(READBACK_SLUG, READBACK_SCHEMA);
  const artifact = {
    id: 'art-1',
    handle: 'https://example.invalid/artifact',
    receipt: 'prov-receipt-art-1',
    content: ROWS,
  };
  registerAttested({
    slug: COLLECT_SLUG,
    effect: 'read',
    roles: ['source', 'collection'],
    acceptedInputKinds: ['query', 'locator', 'evidence'],
    producedOutputKinds: ['locator', 'records', 'evidence'],
    invoke: async () => ({ records: ROWS }),
  });
  registerAttested({
    slug: TRANSFORM_SLUG,
    effect: 'host_only',
    roles: ['transform'],
    acceptedInputKinds: ['records', 'evidence'],
    producedOutputKinds: ['records', 'evidence'],
    invoke: async (input) => {
      const payload = input.payload;
      const records = Array.isArray(payload)
        ? payload
        : payload && typeof payload === 'object' && Array.isArray((payload as { records?: unknown }).records)
          ? (payload as { records: unknown[] }).records
          : ROWS;
      return { records };
    },
  });
  registerAttested({
    slug: CREATE_SLUG,
    effect: 'external_write',
    roles: ['create', 'destination'],
    destination: { family: 'artifact', posture: 'create_new' },
    acceptedInputKinds: ['records', 'evidence'],
    producedOutputKinds: ['created_resource', 'evidence'],
    invoke: async () => {
      creates.count += 1;
      return { id: artifact.id, handle: artifact.handle, receipt: artifact.receipt };
    },
    reconcile: async () => ({
      exists: true,
      id: artifact.id,
      handle: artifact.handle,
      receipt: artifact.receipt,
      content: artifact.content,
    }),
  });
  registerAttested({
    slug: READBACK_SLUG,
    effect: 'read',
    roles: ['readback'],
    acceptedInputKinds: ['created_resource', 'evidence'],
    producedOutputKinds: ['records', 'evidence'],
    invoke: async () => ({ id: artifact.id, handle: artifact.handle, content: artifact.content }),
  });
  const factory = peekHostCapabilityCatalogFactory();
  for (const id of [COLLECT_ID, TRANSFORM_ID, `cap:resolved:${CREATE_SLUG.toLowerCase()}`, `cap:resolved:${READBACK_SLUG.toLowerCase()}`]) {
    const entry = factory?.get(id);
    assert.ok(entry?.manifest, id);
    peekCapabilityManifestStore()?.install(entry.manifest);
    registerShippedTestPort(entry.manifest);
  }
  installIsolatedAttestedTransport(async (call) => {
    if (call.operationId === COLLECT_SLUG) return { records: ROWS };
    if (call.operationId === TRANSFORM_SLUG) return { records: ROWS };
    if (call.operationId === CREATE_SLUG) {
      creates.count += 1;
      return { id: artifact.id, spreadsheet_id: artifact.id, handle: artifact.handle, receipt: artifact.receipt };
    }
    if (call.operationId === READBACK_SLUG) {
      return { id: artifact.id, handle: artifact.handle, content: artifact.content };
    }
    throw new Error(`unexpected ${call.operationId}`);
  });
  installConnectedRegistryPort(() => ({
    connectedToolkits: ['kitx'],
    tools: [
      { slug: COLLECT_SLUG, schema: READ_SCHEMA },
      { slug: CREATE_SLUG, schema: CREATE_SCHEMA },
      { slug: READBACK_SLUG, schema: READBACK_SCHEMA },
    ],
  }));
  installTurnSemanticModelPort(emptyCollectConstructPort());
  const identity = freshSource('Collect four records, normalize them, persist a new artifact, and read it back.');
  await recordConnectedGoalCatalog({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    objective: 'Collect four records, normalize them, persist a new artifact, and read it back.',
  });
  const admitted = await admitAndCompileAcceptedSource({ identity, surface: 'direct' });
  return { identity, admitted };
}

test('collect → analyze → construct → readback finishes typed done with one create', async () => {
  const creates = { count: 0 };
  const { identity, admitted } = await admitConstructTurn(creates);
  assert.equal(admitted.ok, true, JSON.stringify(admitted).slice(0, 400));
  if (!admitted.ok) return;
  const graph = turnGraphFromShadowEvent(getTurnGraphEventForSource(identity.sessionId, identity.sourceUserSeq));
  assert.ok(graph);
  const roles = graph.nodes.map((node) => node.capabilityRole).filter(Boolean);
  assert.ok(roles.includes('collection') || roles.includes('source'));
  assert.ok(roles.includes('transform'));
  assert.ok(roles.includes('destination') || roles.includes('create'));
  assert.ok(roles.includes('readback'));
  const dispatched = await dispatchAdmittedSource(identity);
  assert.equal(dispatched.kind, 'typed', JSON.stringify(dispatched).slice(0, 400));
  if (dispatched.kind !== 'typed') return;
  assert.equal(dispatched.result.status, 'success', dispatched.result.error);
  assert.equal(creates.count, 1, 'exactly-once create');
  const crossings = physicalCrossingsFor(identity.sessionId, identity.sourceUserSeq);
  assert.ok(crossings.length > 0, 'construct must pay a physical crossing');
  assert.ok(crossings.every((crossing) => crossing.settled), JSON.stringify(crossings));
  if (graph) {
    for (const node of graph.nodes.filter((entry) => Boolean(entry.operationId))) {
      const lease = readCanonicalGraphNodeLease({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        graphId: graph.graphId,
        nodeId: node.id,
      });
      if (lease) assert.equal(lease.released, true, node.id);
    }
  }
});

test('a crashed construct does not recreate the first write on resume', async () => {
  const creates = { count: 0 };
  const { identity, admitted } = await admitConstructTurn(creates);
  assert.equal(admitted.ok, true, JSON.stringify(admitted).slice(0, 300));
  if (!admitted.ok) return;
  setAdmittedGraphRunFault('before_publication');
  const crashed = await dispatchAdmittedSource(identity);
  setAdmittedGraphRunFault(null);
  assert.notEqual(crashed.kind === 'typed' && crashed.result.status === 'success', true);
  const firstCreates = creates.count;
  assert.ok(firstCreates >= 1, 'the first write committed before the crash');
  const finish = await dispatchAdmittedSource(identity);
  assert.equal(finish.kind, 'typed', JSON.stringify(finish).slice(0, 400));
  if (finish.kind !== 'typed') return;
  assert.equal(finish.result.status, 'success', finish.result.error);
  assert.equal(creates.count, firstCreates, 'resume must not pay the create again');
});

test('a networked CLI lookup uses the same crossing kernel', async () => {
  clearProductionCapabilityPorts();
  clearIndependentCapabilityObservations();
  resetCatalog();
  configureTypedExecutionRuntime();
  const slug = 'CLI_LOOKUP';
  const capId = `cap:resolved:${slug.toLowerCase()}`;
  rememberToolSchema(slug, READ_SCHEMA);
  registerAttested({
    slug,
    effect: 'read',
    roles: ['lookup'],
    providerKind: 'reviewed_cli',
    invoke: async () => ({ locator: `payload:${slug}` }),
  });
  const entry = peekHostCapabilityCatalogFactory()?.get(capId);
  assert.ok(entry?.manifest);
  peekCapabilityManifestStore()?.install(entry.manifest);
  registerShippedTestPort(entry.manifest);
  installIsolatedAttestedTransport(async (call) => {
    assert.equal(call.operationId, slug);
    return { locator: `payload:${slug}` };
  });
  installTurnSemanticModelPort({
    async interpret(call) {
      return {
        raw: fakeSemanticProposal({
          relation: 'new_goal',
          goal: {
            objective: 'Retrieve the requested source.',
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
        modelIdentity: 'fake-semantic/cli-lookup',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgeSourceEffect(call) {
      return entailedSourceEffectJudge(call, 'fake-semantic/cli-judge');
    },
    async judgePlanGrounding(call) {
      return entailedPlanGroundingJudge(call, 'fake-semantic/cli-grounding');
    },
  });
  const identity = freshSource('Retrieve the requested source.');
  recordAdmissionCapabilityResolution({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    acceptedInput: 'Retrieve the requested source.',
    entries: [{
      intent: 'lookup',
      kind: 'cli',
      identifier: slug,
      status: 'proven',
      connection: 'active',
      effectClass: 'read',
    }],
  });
  const admitted = await admitAndCompileAcceptedSource({ identity, surface: 'direct' });
  assert.equal(admitted.ok, true, JSON.stringify(admitted).slice(0, 300));
  if (!admitted.ok) return;
  const dispatched = await dispatchAdmittedSource(identity);
  assert.equal(dispatched.kind, 'typed', JSON.stringify(dispatched).slice(0, 400));
  if (dispatched.kind !== 'typed') return;
  assert.equal(dispatched.result.status, 'success', dispatched.result.error);
  const crossings = physicalCrossingsFor(identity.sessionId, identity.sourceUserSeq);
  assert.ok(crossings.length > 0, `CLI must cross the same physical kernel: ${JSON.stringify(crossings)}`);
  assert.ok(crossings.every((crossing) => crossing.settled), JSON.stringify(crossings));
});

test('incomplete collection evidence cannot certify all or none', () => {
  const identity = {
    sessionId: 'sess-incomplete',
    sourceUserSeq: 1,
    physicalAttemptId: 'phys-incomplete',
    callId: 'call-incomplete',
    tool: 'KITX_QUERY_BATCH',
    effect: 'read' as const,
  };
  const paged = issueCollectionReceipt({
    identity,
    recordIdentities: ['r1'],
    continuationOutstanding: true,
  });
  assert.equal('error' in paged, true, JSON.stringify(paged));
  if ('error' in paged) {
    assert.match(paged.error, /outstanding continuation|not complete/i);
  }
});
