/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/live-capability-materializer.test.ts */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CapabilityOperationRow } from '../../memory/capability-index.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-live-materializer-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const index = await import('../../memory/capability-index.js');
const contracts = await import('../../tools/tool-contract-store.js');
const eventlog = await import('./eventlog.js');
const authority = await import('./accepted-turn-call-authority.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifests = await import('./capability-manifest.js');
const manifestStores = await import('./capability-manifest-store.js');
const materializer = await import('./live-capability-materializer.js');
const observations = await import('./independent-capability-observation.js');
const ports = await import('./production-capability-ports.js');
const shipped = await import('./shipped-implementation-identity.js');
const plans = await import('../../memory/workflow-node-invocation-plan.js');
const kernel = await import('./workflow-read-only-call-kernel.js');

test.afterEach(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
});

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function generated(label: string): string {
  return `${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

interface FakeDefinitionState {
  operationId: string;
  accountId: string;
  providerIdentity: string;
  providerVersion: string;
  operationVersion: string;
  effect: string;
  effectAttestation: materializer.LiveCapabilityDefinition['effectAttestation'];
  inputSchema: Record<string, unknown>;
  observedAt: number;
  portId: string;
  compilerId: string;
}

function fakeDefinition(label: string, observedAt = Date.now() - 500): FakeDefinitionState {
  const operationId = generated(`OP_${label}`);
  return {
    operationId,
    accountId: generated(`account.${label}`),
    providerIdentity: generated(`provider.${label}`),
    providerVersion: generated(`provider-version.${label}`),
    operationVersion: '1',
    effect: 'read',
    effectAttestation: 'carrier_declared',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { token: { type: 'string' } },
      required: ['token'],
    },
    observedAt,
    portId: generated(`port.${label}`),
    compilerId: generated(`compiler.${label}`),
  };
}

function createFakeCarrier(input: {
  objective: string;
  definitions: FakeDefinitionState[];
}) {
  const carrierName = generated('carrier').toLowerCase();
  let enumerateCalls = 0;
  let refreshCalls = 0;
  let observeCalls = 0;
  let onRefresh: (() => void) | undefined;
  const state = input.definitions;
  const carrier: materializer.LiveCapabilityCarrier = {
    identity: { kind: 'host', name: carrierName },
    async enumerate() {
      enumerateCalls += 1;
      return state.map((definition) => ({
        identifier: definition.operationId,
        carrierKind: 'host' as const,
        carrier: carrierName,
        displayName: `Read ${input.objective}`,
        description: `Retrieve ${input.objective} values from the current carrier.`,
        // This is deliberately only a shortlist hint. Individual tests change
        // the live effect without changing this value.
        effectClass: 'read' as const,
        effectProvenance: 'inferred' as const,
        accountIdentity: definition.accountId,
      }));
    },
    async refresh() {
      refreshCalls += 1;
      onRefresh?.();
    },
    observe(reference) {
      observeCalls += 1;
      const matched = state.filter((definition) => (
        definition.operationId === reference.identifier
        && definition.accountId === reference.accountId
      ));
      if (matched.length === 0) return 'missing';
      if (matched.length !== 1) return 'ambiguous';
      const definition = matched[0]!;
      return {
        operationId: definition.operationId,
        providerKind: 'local_registry',
        providerIdentity: definition.providerIdentity,
        providerVersion: definition.providerVersion,
        operationVersion: definition.operationVersion,
        accountId: definition.accountId,
        effect: definition.effect,
        effectAttestation: definition.effectAttestation,
        inputSchema: structuredClone(definition.inputSchema),
        observedAt: definition.observedAt,
        invoke: {
          portId: definition.portId,
          argumentCompiler: { id: definition.compilerId, version: definition.operationVersion },
        },
      };
    },
  };
  return {
    carrier,
    state,
    counts: () => ({ enumerateCalls, refreshCalls, observeCalls }),
    setOnRefresh(callback: (() => void) | undefined) { onRefresh = callback; },
  };
}

function isolatedPortRegistrar() {
  const byManifest = new Map<string, ports.ProductionCapabilityPort['invoke']>();
  const calls: Array<{ operationId: string; payload: unknown }> = [];
  let registrations = 0;
  const register: materializer.LiveCapabilityPortRegistrar = ({ manifest, attestation }) => {
    registrations += 1;
    shipped.loadShippedImplementations().registerIsolatedObservation({
      operationId: attestation.reference.identifier,
      accountId: attestation.accountId,
      definitionFingerprint: attestation.definitionFingerprint,
      providerVersion: attestation.providerVersion,
      operationVersion: attestation.operationVersion,
      observedAt: attestation.observedAt,
    });
    let invoke = byManifest.get(manifest.manifestId);
    if (!invoke) {
      invoke = async ({ payload }) => {
        calls.push({ operationId: manifest.operationId, payload: structuredClone(payload) });
        return { result: [{ key: 'generated' }], complete: true };
      };
      byManifest.set(manifest.manifestId, invoke);
    }
    return ports.registerFixtureCapabilityPort(
      ports.productionPortIdentityFromManifest(manifest),
      { invoke },
    );
  };
  return { register, calls, registrations: () => registrations };
}

function emptyAuthoritySurfaces() {
  const store = manifestStores.createCapabilityManifestStore();
  const factory = catalogs.createHostCapabilityCatalogFactory();
  manifestStores.installCapabilityManifestStore(store);
  catalogs.installHostCapabilityCatalogFactory(factory);
  return { store, factory };
}

function invocationPlan(entry: catalogs.RegisteredHostCapability) {
  const identity = catalogs.canonicalCatalogIdentityOf(entry);
  assert.ok(identity);
  return plans.createWorkflowNodeInvocationPlan({
    requirementId: generated('requirement'),
    logicalCapabilityId: generated('logical-capability'),
    binding: {
      capabilityId: identity.capabilityId,
      manifestId: identity.manifestId,
      manifestDigest: identity.manifestDigest,
      operationId: identity.operationId,
      operationVersion: identity.schemaVersion,
      schemaDigest: identity.schemaDigest,
      providerVersion: identity.providerVersion,
      liveFingerprint: identity.liveFingerprint,
      accountId: identity.account,
      effect: 'read',
      invokePortId: identity.invokePortId,
      argumentCompiler: { ...identity.argumentCompiler },
    },
    arguments: {
      token: {
        source: { kind: 'workflow_input', key: 'token' },
        required: true,
        type: 'string',
      },
    },
    evidence: {
      requiredPaths: ['result'],
      nonEmptyPaths: ['result'],
      minItems: { result: 1 },
    },
    completeness: { kind: 'terminal_result', evidencePaths: ['result'] },
    continuation: { kind: 'none' },
  });
}

function armWorkflow(plan: plans.WorkflowNodeInvocationPlanV1, label: string) {
  const session = eventlog.createSession({ id: generated(`session.${label}`), kind: 'workflow' });
  return authority.armWorkflowReadOnlyCallAuthority({
    sessionId: session.id,
    workflowId: generated(`workflow.${label}`),
    workflowRevision: 1,
    workflowDigest: digest(generated(`workflow-digest.${label}`)),
    runId: generated(`run.${label}`),
    runOccurrenceId: generated(`occurrence.${label}`),
    nodeId: generated(`node.${label}`),
    nodeAttempt: 1,
    invocationPlanDigest: plan.bindingDigest,
    bindingSnapshotDigest: digest(generated(`binding.${label}`)),
    controlDigest: digest(generated(`control.${label}`)),
    logicalCallId: generated(`call.${label}`),
  });
}

test('a true blank state discovers, re-observes, materializes, and crosses the shared read kernel', async () => {
  const objective = generated('objective').toLowerCase();
  const definition = fakeDefinition('blank');
  const fake = createFakeCarrier({ objective, definitions: [definition] });
  const registrar = isolatedPortRegistrar();
  const { store, factory } = emptyAuthoritySurfaces();

  assert.equal(index.capabilityIndexStats().operations, 0);
  assert.equal(store.list().length, 0);
  assert.equal(factory.snapshot().length, 0);
  assert.equal(contracts.loadToolContract(definition.operationId), null);

  const outcome = await materializer.materializeLiveReadCapability({
    objective: `retrieve ${objective} values`,
    carrier: fake.carrier,
    registerPort: registrar.register,
    store,
    factory,
  });
  assert.equal(outcome.status, 'installed', JSON.stringify(outcome));
  if (outcome.status !== 'installed') return;
  assert.deepEqual(fake.counts(), { enumerateCalls: 1, refreshCalls: 1, observeCalls: 2 });
  assert.equal(registrar.registrations(), 1);
  assert.equal(store.list().filter((row) => row.manifest.lifecycle.state === 'current').length, 1);
  const entry = factory.get(outcome.manifest.manifestId);
  assert.ok(entry);
  assert.equal(entry.liveFingerprint, outcome.manifest.definitionFingerprint,
    'workflow authority keeps the full definition sha256');
  assert.equal(entry.sourceSchemaFingerprint, outcome.attestation.schemaFingerprint,
    'source selection keeps the distinct selector input-schema fingerprint');
  assert.notEqual(entry.liveFingerprint, entry.sourceSchemaFingerprint,
    'the workflow definition digest must never be reused as selector-schema authority');
  const contract = contracts.loadToolContract(definition.operationId);
  assert.ok(contract);
  assert.equal(contract.fingerprint, outcome.attestation.schemaFingerprint);
  assert.deepEqual(contract.schema, definition.inputSchema);

  const plan = invocationPlan(entry);
  const armed = armWorkflow(plan, 'blank');
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  if (armed.status !== 'armed') return;
  const executed = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: plan,
    args: { token: generated('input') },
  });
  assert.equal(executed.status, 'completed', JSON.stringify(executed));
  assert.equal(registrar.calls.length, 1);
  assert.equal(registrar.calls[0]!.operationId, definition.operationId);
  assert.equal((registrar.calls[0]!.payload as { token?: unknown }).token != null, true);
});

test('rename, schema drift, and removal supersede or revoke the prior exact authority', async () => {
  const objective = generated('objective').toLowerCase();
  const definition = fakeDefinition('lifecycle', Date.now() - 2_000);
  const fake = createFakeCarrier({ objective, definitions: [definition] });
  const registrar = isolatedPortRegistrar();
  const { store, factory } = emptyAuthoritySurfaces();
  const run = () => materializer.materializeLiveReadCapability({
    objective: `retrieve ${objective} values`,
    carrier: fake.carrier,
    registerPort: registrar.register,
    store,
    factory,
  });

  const initial = await run();
  assert.equal(initial.status, 'installed');
  if (initial.status !== 'installed') return;

  definition.operationId = generated('OP_RENAMED');
  definition.portId = generated('port.renamed');
  definition.compilerId = generated('compiler.renamed');
  definition.observedAt += 500;
  const renamed = await run();
  assert.equal(renamed.status, 'installed', JSON.stringify(renamed));
  if (renamed.status !== 'installed') return;
  assert.deepEqual(renamed.replaced, [initial.manifest.manifestId]);
  assert.equal(store.get(initial.manifest.manifestId)?.manifest.lifecycle.state, 'superseded');
  assert.equal(factory.get(initial.manifest.manifestId), undefined);
  assert.ok(factory.get(renamed.manifest.manifestId));

  definition.inputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: { token: { type: 'string' }, page: { type: 'integer' } },
    required: ['token', 'page'],
  };
  definition.operationVersion = '2';
  definition.observedAt += 500;
  const drifted = await run();
  assert.equal(drifted.status, 'installed', JSON.stringify(drifted));
  if (drifted.status !== 'installed') return;
  assert.notEqual(drifted.attestation.definitionFingerprint, renamed.attestation.definitionFingerprint);
  assert.deepEqual(drifted.replaced, [renamed.manifest.manifestId]);
  assert.equal(store.get(renamed.manifest.manifestId)?.manifest.lifecycle.state, 'superseded');
  assert.equal(factory.get(renamed.manifest.manifestId), undefined);
  assert.ok(factory.get(drifted.manifest.manifestId));
  const live = observations.independentlyObserveCapability(
    drifted.manifest.operationId,
    drifted.manifest.accountId,
  );
  assert.equal(live?.definitionFingerprint, drifted.attestation.definitionFingerprint);

  fake.state.splice(0, fake.state.length);
  const removed = await run();
  assert.equal(removed.status, 'blocked');
  if (removed.status !== 'blocked') return;
  assert.equal(removed.reason, 'missing');
  assert.deepEqual(removed.retired, [drifted.manifest.manifestId]);
  assert.equal(store.get(drifted.manifest.manifestId)?.manifest.lifecycle.state, 'revoked');
  assert.equal(factory.get(drifted.manifest.manifestId), undefined);
  assert.equal(factory.snapshot().length, 0);
});

test('ambiguous and untrusted-effect hints install no authority', async (t) => {
  await t.test('ambiguous exact-one selection', async () => {
    const objective = generated('objective').toLowerCase();
    const fake = createFakeCarrier({
      objective,
      definitions: [fakeDefinition('ambiguous-a'), fakeDefinition('ambiguous-b')],
    });
    const registrar = isolatedPortRegistrar();
    const { store, factory } = emptyAuthoritySurfaces();
    const outcome = await materializer.materializeLiveReadCapability({
      objective: `retrieve ${objective} values`,
      carrier: fake.carrier,
      registerPort: registrar.register,
      store,
      factory,
    });
    assert.equal(outcome.status, 'blocked');
    if (outcome.status === 'blocked') assert.equal(outcome.reason, 'ambiguous');
    assert.equal(registrar.registrations(), 0);
    assert.equal(store.list().length, 0);
    assert.equal(factory.snapshot().length, 0);
  });

  for (const effect of [
    { value: 'unknown', attestation: 'none' as const, reason: 'effect_not_read' },
    { value: 'read', attestation: 'none' as const, reason: 'unattested_effect' },
  ]) {
    await t.test(`${effect.value}-${effect.reason}`, async () => {
      const objective = generated('objective').toLowerCase();
      const definition = fakeDefinition(effect.reason);
      definition.effect = effect.value;
      definition.effectAttestation = effect.attestation;
      const fake = createFakeCarrier({ objective, definitions: [definition] });
      const registrar = isolatedPortRegistrar();
      const { store, factory } = emptyAuthoritySurfaces();
      const outcome = await materializer.materializeLiveReadCapability({
        objective: `retrieve ${objective} values`,
        carrier: fake.carrier,
        registerPort: registrar.register,
        store,
        factory,
      });
      assert.equal(outcome.status, 'blocked');
      if (outcome.status === 'blocked') assert.equal(outcome.reason, effect.reason);
      assert.equal(registrar.registrations(), 0);
      assert.equal(store.list().length, 0);
      assert.equal(factory.snapshot().length, 0);
    });
  }
});

test('a definition that changes after port setup leaves the port inert and installs no authority', async () => {
  const objective = generated('objective').toLowerCase();
  const definition = fakeDefinition('midflight', Date.now() - 1_000);
  const fake = createFakeCarrier({ objective, definitions: [definition] });
  const baseRegistrar = isolatedPortRegistrar();
  const { store, factory } = emptyAuthoritySurfaces();
  const register: materializer.LiveCapabilityPortRegistrar = async (input) => {
    const result = await baseRegistrar.register(input);
    definition.inputSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { changed: { type: 'boolean' } },
      required: ['changed'],
    };
    definition.operationVersion = '2';
    definition.observedAt += 100;
    return result;
  };
  const outcome = await materializer.materializeLiveReadCapability({
    objective: `retrieve ${objective} values`,
    carrier: fake.carrier,
    registerPort: register,
    store,
    factory,
  });
  assert.equal(outcome.status, 'blocked');
  if (outcome.status === 'blocked') assert.equal(outcome.reason, 'identity_mismatch');
  assert.equal(baseRegistrar.registrations(), 1, 'the exact port existed before the last-edge drift');
  assert.equal(store.list().length, 0, 'a port alone is not manifest authority');
  assert.equal(factory.snapshot().length, 0, 'a port alone is not catalog authority');
  assert.equal(baseRegistrar.calls.length, 0, 'the inert port body never ran');
});

test('unbounded or executable schema shapes are refused before port registration', async (t) => {
  await t.test('schema accessors are never invoked', async () => {
    const objective = generated('objective').toLowerCase();
    const definition = fakeDefinition('accessor');
    let getterCalls = 0;
    const unsafeSchema: Record<string, unknown> = { type: 'object' };
    Object.defineProperty(unsafeSchema, 'properties', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return {};
      },
    });
    definition.inputSchema = unsafeSchema;
    const fake = createFakeCarrier({ objective, definitions: [definition] });
    const carrier: materializer.LiveCapabilityCarrier = {
      ...fake.carrier,
      observe(reference) {
        if (
          reference.identifier !== definition.operationId
          || reference.accountId !== definition.accountId
        ) return 'missing';
        return {
          operationId: definition.operationId,
          providerKind: 'local_registry',
          providerIdentity: definition.providerIdentity,
          providerVersion: definition.providerVersion,
          operationVersion: definition.operationVersion,
          accountId: definition.accountId,
          effect: definition.effect,
          effectAttestation: definition.effectAttestation,
          inputSchema: unsafeSchema,
          observedAt: definition.observedAt,
          invoke: {
            portId: definition.portId,
            argumentCompiler: { id: definition.compilerId, version: definition.operationVersion },
          },
        };
      },
    };
    const registrar = isolatedPortRegistrar();
    const { store, factory } = emptyAuthoritySurfaces();
    const outcome = await materializer.materializeLiveReadCapability({
      objective: `retrieve ${objective} values`,
      carrier,
      registerPort: registrar.register,
      store,
      factory,
    });
    assert.equal(outcome.status, 'blocked');
    if (outcome.status === 'blocked') assert.equal(outcome.reason, 'invalid_definition');
    assert.equal(getterCalls, 0);
    assert.equal(registrar.registrations(), 0);
    assert.equal(store.list().length, 0);
    assert.equal(factory.snapshot().length, 0);
  });

  await t.test('oversized enumeration is rejected before indexing or refresh', async () => {
    const objective = generated('objective').toLowerCase();
    const definition = fakeDefinition('enumeration');
    const base = createFakeCarrier({ objective, definitions: [definition] });
    let refreshCalls = 0;
    const carrier: materializer.LiveCapabilityCarrier = {
      ...base.carrier,
      async enumerate() {
        const row = (await base.carrier.enumerate())[0]!;
        return Array.from({ length: 10_001 }, (_, indexValue) => ({
          ...row,
          identifier: `${row.identifier}_${indexValue}`,
        }));
      },
      async refresh(reference) {
        refreshCalls += 1;
        await base.carrier.refresh(reference);
      },
    };
    const registrar = isolatedPortRegistrar();
    const { store, factory } = emptyAuthoritySurfaces();
    const outcome = await materializer.materializeLiveReadCapability({
      objective: `retrieve ${objective} values`,
      carrier,
      registerPort: registrar.register,
      store,
      factory,
    });
    assert.equal(outcome.status, 'blocked');
    if (outcome.status === 'blocked') assert.equal(outcome.reason, 'enumeration_unbounded');
    assert.equal(refreshCalls, 0);
    assert.equal(registrar.registrations(), 0);
    assert.equal(store.list().length, 0);
    assert.equal(factory.snapshot().length, 0);
  });

  await t.test('enumeration row accessors are never invoked or indexed', async () => {
    const objective = generated('objective').toLowerCase();
    const definition = fakeDefinition('enumeration-accessor');
    const base = createFakeCarrier({ objective, definitions: [definition] });
    let getterCalls = 0;
    let refreshCalls = 0;
    const unsafeRow: Record<string, unknown> = {
      carrierKind: 'host',
      carrier: base.carrier.identity.name,
      displayName: `Read ${objective}`,
      description: `Retrieve ${objective}.`,
      effectClass: 'read',
      effectProvenance: 'declared',
      accountIdentity: definition.accountId,
    };
    Object.defineProperty(unsafeRow, 'identifier', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return definition.operationId;
      },
    });
    const carrier: materializer.LiveCapabilityCarrier = {
      ...base.carrier,
      async enumerate() {
        return [unsafeRow as unknown as CapabilityOperationRow];
      },
      async refresh(reference) {
        refreshCalls += 1;
        await base.carrier.refresh(reference);
      },
    };
    const registrar = isolatedPortRegistrar();
    const { store, factory } = emptyAuthoritySurfaces();
    const outcome = await materializer.materializeLiveReadCapability({
      objective: `retrieve ${objective} values`,
      carrier,
      registerPort: registrar.register,
      store,
      factory,
    });
    assert.equal(outcome.status, 'blocked');
    if (outcome.status === 'blocked') assert.equal(outcome.reason, 'enumeration_invalid');
    assert.equal(getterCalls, 0);
    assert.equal(refreshCalls, 0);
    assert.equal(registrar.registrations(), 0);
    assert.equal(store.list().length, 0);
    assert.equal(factory.snapshot().length, 0);
  });
});
