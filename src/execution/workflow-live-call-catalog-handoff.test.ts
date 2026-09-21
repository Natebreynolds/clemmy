/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-live-call-catalog-handoff.test.ts
 *
 * A structured-call workflow is saved in one foreground turn, then its
 * creation test is drained later.  The durable manifest and exact production
 * port survive that handoff; membership in the in-memory host catalog is only
 * a cache.  Losing that cache must trigger one exact, provider-neutral
 * revalidation from the durable current manifests before the workflow is
 * reported as disconnected.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-catalog-handoff-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const capabilityManifests = await import('../runtime/harness/capability-manifest.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const adapters = await import('../runtime/harness/production-capability-adapter.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const workflows = await import('../memory/workflow-store.js');
const compiler = await import('./workflow-live-call-compiler.js');
const runner = await import('./workflow-runner.js');

function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex');
}

function manifestFor(input: {
  operationId: string;
  manifestId: string;
  accountId: string;
  providerKind?: 'composio' | 'native_mcp';
}) {
  const providerKind = input.providerKind ?? 'native_mcp';
  return capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: input.manifestId,
    providerKind,
    operationId: input.operationId,
    providerIdentity: providerKind === 'composio' ? 'composio' : 'native-mcp:test-provider',
    providerVersion: 'provider-v1',
    operationVersion: 'operation-v1',
    definitionFingerprint: digest(`${input.operationId}:${input.accountId}:definition-v1`),
    effect: 'read',
    accountId: input.accountId,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'query_records',
    acceptedInputKinds: ['query'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: {
      issuer: 'workflow-catalog-handoff-test',
      issuedAt: '2026-08-27T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['query'],
  });
}

test.beforeEach(() => {
  adapters.installProductionCapabilityAdapter(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
});

test.after(() => {
  adapters.installProductionCapabilityAdapter(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('creation-test revalidates an exact durable capability after the authoring catalog cache is lost', async () => {
  const operationId = 'GENERIC_RECORDS_QUERY';
  const manifest = manifestFor({
    operationId,
    manifestId: 'cap:generic-records-query:account-a',
    accountId: 'account-a',
    providerKind: 'composio',
  });

  const store = manifestStores.createCapabilityManifestStore([manifest]);
  manifestStores.installCapabilityManifestStore(store);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);

  let providerBodies = 0;
  const observe = () => ({
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    accountId: manifest.accountId,
    observedAt: Date.now(),
  });
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(manifest),
    {
      observe,
      invoke: async ({ binding }) => {
        providerBodies += 1;
        assert.deepEqual(binding.args, { scope: 'newest' });
        return { successful: true, data: { value: [{ id: 'record-1' }] } };
      },
    },
  ).ok, true);
  adapters.installProductionCapabilityAdapter(adapters.createProductionCapabilityAdapter({
    factory,
    store,
  }));

  const saved = workflows.writeWorkflow('catalog-handoff-canary', {
    name: 'Catalog Handoff Canary',
    description: 'One exact read whose live catalog membership is revalidated at execution.',
    enabled: false,
    trigger: { manual: true },
    steps: [{
      id: 'read_records',
      prompt: '',
      sideEffect: 'read',
      call: { tool: operationId, args: { scope: 'newest' } },
    }],
  });

  // This is the live failure: workflow_create finished in the foreground, but
  // the later creation-test drain saw an empty in-memory catalog even though
  // the exact current manifest and invocation port still existed.
  factory.clear();
  assert.equal(factory.snapshot().length, 0);

  const result = await runner.runCreationTest(
    saved.data,
    saved.name,
    'creation-test-catalog-handoff',
    {},
    new Proxy({}, { get: () => { throw new Error('model fallback was consulted'); } }) as never,
  );

  assert.deepEqual(result, {
    pass: true,
    steps: [{ stepId: 'read_records', status: 'ok' }],
  });
  assert.equal(providerBodies, 1, 'revalidation compiles authority; it does not duplicate business I/O');
  assert.equal(factory.snapshot().length, 1);
  assert.equal(factory.snapshot()[0]?.manifest?.manifestId, manifest.manifestId);
});

test('a durable manifest without a current independent observer remains unavailable', () => {
  const operationId = 'GENERIC_UNOBSERVED_QUERY';
  const manifest = manifestFor({
    operationId,
    manifestId: 'cap:generic-unobserved-query:account-a',
    accountId: 'account-a',
  });
  const store = manifestStores.createCapabilityManifestStore([manifest]);
  manifestStores.installCapabilityManifestStore(store);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);

  let providerBodies = 0;
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(manifest),
    {
      invoke: async () => {
        providerBodies += 1;
        return { data: { value: [{ id: 'must-not-run' }] } };
      },
    },
  ).ok, true);
  adapters.installProductionCapabilityAdapter(adapters.createProductionCapabilityAdapter({
    factory,
    store,
  }));

  const result = compiler.compileLiveCatalogWorkflowCallPlan({
    ownerId: 'unobserved-workflow',
    nodeId: 'read_records',
    operationId,
    args: { scope: 'newest' },
    expectedEffect: 'read',
  });

  assert.deepEqual(result, {
    ok: false,
    recoverable: true,
    reason: 'not-connected',
    message: `No current capability is registered for "${operationId}". Connect it, then retry.`,
  });
  assert.equal(factory.snapshot().length, 0, 'durable bytes alone do not materialize authority');
  assert.equal(providerBodies, 0);
});

test('revalidation preserves the existing multiple-account ambiguity refusal', () => {
  const operationId = 'GENERIC_AMBIGUOUS_QUERY';
  const manifests = [
    manifestFor({
      operationId,
      manifestId: 'cap:generic-ambiguous-query:account-a',
      accountId: 'account-a',
    }),
    manifestFor({
      operationId,
      manifestId: 'cap:generic-ambiguous-query:account-b',
      accountId: 'account-b',
    }),
  ];
  const store = manifestStores.createCapabilityManifestStore(manifests);
  manifestStores.installCapabilityManifestStore(store);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  for (const manifest of manifests) {
    const observe = () => ({
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      accountId: manifest.accountId,
      observedAt: Date.now(),
    });
    assert.equal(ports.registerFixtureCapabilityPort(
      ports.productionPortIdentityFromManifest(manifest),
      { observe, invoke: async () => ({ data: { value: [{ id: manifest.accountId }] } }) },
    ).ok, true);
  }
  adapters.installProductionCapabilityAdapter(adapters.createProductionCapabilityAdapter({
    factory,
    store,
  }));

  const result = compiler.compileLiveCatalogWorkflowCallPlan({
    ownerId: 'ambiguous-workflow',
    nodeId: 'read_records',
    operationId,
    args: { scope: 'newest' },
    expectedEffect: 'read',
  });

  assert.equal(result.ok, false);
  if (result.ok || !result.recoverable) assert.fail('expected recoverable exact-account choice gate');
  assert.equal(result.reason, 'ambiguous-account');
  assert.equal(result.message, `2 accounts are registered for "${operationId}"; choose the exact account before this workflow can dispatch.`);
  assert.deepEqual(result.accountChoiceSet?.candidates, [
    { capabilityId: manifests[0]!.manifestId, accountId: 'account-a' },
    { capabilityId: manifests[1]!.manifestId, accountId: 'account-b' },
  ]);
  assert.equal(result.accountChoiceSet?.total, 2);
  assert.equal(result.accountChoiceSet?.truncated, false);
  assert.match(result.accountChoiceSet?.digest ?? '', /^[a-f0-9]{64}$/);
  assert.equal(factory.snapshot().length, 2, 'all exact accounts remain visible to ambiguity enforcement');

  const selectedB = compiler.compileLiveCatalogWorkflowCallPlan({
    ownerId: 'ambiguous-workflow',
    nodeId: 'read_records',
    operationId,
    args: { scope: 'newest' },
    expectedEffect: 'read',
    selectedAccount: {
      capabilityId: manifests[1]!.manifestId,
      accountId: 'account-b',
      choiceSetDigest: result.accountChoiceSet!.digest,
    },
  });
  assert.equal(selectedB.ok, true, JSON.stringify(selectedB));
  if (!selectedB.ok) assert.fail(selectedB.message);
  assert.equal(selectedB.identity.capabilityId, manifests[1]!.manifestId);
  assert.equal(selectedB.identity.account, 'account-b');
  assert.equal(selectedB.plan.binding.accountId, 'account-b');
});

for (const effect of ['read', 'external_write'] as const) {
  test(`a prepared ${effect} catalog does not confuse read creation tests with write grants`, async (t) => {
    let modelEntries = 0;
    let preparations = 0;
    runner._setWorkflowHarnessLoopImplsForTests({
      configureRuntime: (async () => ({ ok: true })) as never,
      buildAgent: (async () => ({})) as never,
      // Replace provider discovery, retaining the real source, attempt,
      // immutable-definition check and workflow execution owner.
      prepareExternalCatalog: async () => {
        preparations++;
        return { status: 'ready', manifestIds: ['cap:fixture'], operationIds: ['RECORDS_LIST_RECENT'],
          catalogIdentities: [{ effect, manifestId: 'cap:fixture', operationId: 'RECORDS_LIST_RECENT' }] as never };
      },
      runConversation: (async (request: { sessionId: string }) => {
        modelEntries++;
        return { sessionId: request.sessionId, status: 'completed', steps: 1, lastTurn: 1,
          lastDecision: { summary: 'Read test reached its model.', reply: 'Read test reached its model.', done: true, nextAction: 'completed' } };
      }) as never,
    });
    t.after(() => runner._setWorkflowHarnessLoopImplsForTests());
    const saved = workflows.writeWorkflow(`prose-catalog-${effect}`, {
      name: `Prose catalog ${effect}`, description: 'Read-only creation test with an external catalog.',
      enabled: false, trigger: { manual: true },
      steps: [{ id: 'inspect', prompt: 'Inspect the recent records.', sideEffect: 'read', allowedTools: ['RECORDS_LIST_RECENT'] }],
    });
    const result = await runner.runCreationTest(saved.data, saved.name, `creation-prose-${effect}`, {},
      { respond: async () => { throw new Error('legacy responder must not execute'); } } as never);
    assert.equal(preparations, 1);
    if (effect === 'read') {
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.equal(modelEntries, 1, 'a read does not owe an authored write grant');
    } else {
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.equal(modelEntries, 0, 'an unbound external write still cannot reach execution');
      assert.match(JSON.stringify(result), /authored write authority refused/);
    }
  });
}

test('an unanswered account choice during authoring is a QUESTION, and its dependents are not reported broken', async () => {
  // Live 2026-09-21: "query_accounts: error — 13 accounts are registered for
  // salesforce_sf_soql_query; choose the exact account" with no list and no way
  // to choose, then "build_batch: failed — query_accounts is blocked with
  // creation-test error", then "Fix the flagged step(s) with workflow_update
  // ... To run it as-is anyway: workflow_set_enabled". One unanswered question
  // read as a broken workflow the owner was told to repair with engine calls.
  const operationId = 'GENERIC_AUTHORING_CHOICE_QUERY';
  const manifests = [
    manifestFor({ operationId, manifestId: 'cap:generic-authoring-choice:account-a', accountId: 'account-a' }),
    manifestFor({ operationId, manifestId: 'cap:generic-authoring-choice:account-b', accountId: 'account-b' }),
  ];
  const store = manifestStores.createCapabilityManifestStore(manifests);
  manifestStores.installCapabilityManifestStore(store);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  for (const manifest of manifests) {
    const observe = () => ({
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      accountId: manifest.accountId,
      observedAt: Date.now(),
    });
    assert.equal(ports.registerFixtureCapabilityPort(
      ports.productionPortIdentityFromManifest(manifest),
      { observe, invoke: async () => ({ data: { value: [{ id: manifest.accountId }] } }) },
    ).ok, true);
  }
  adapters.installProductionCapabilityAdapter(adapters.createProductionCapabilityAdapter({ factory, store }));

  const saved = workflows.writeWorkflow('authoring-choice-canary', {
    name: 'Authoring Choice Canary',
    description: 'A read whose account is ambiguous, and a step that depends on it.',
    enabled: false,
    trigger: { manual: true },
    steps: [
      { id: 'query_accounts', prompt: '', sideEffect: 'read', call: { tool: operationId, args: { scope: 'newest' } } },
      { id: 'build_batch', prompt: '', sideEffect: 'read', dependsOn: ['query_accounts'],
        call: { tool: operationId, args: { scope: 'newest' } } },
    ],
  });

  const result = await runner.runCreationTest(
    saved.data,
    saved.name,
    'creation-test-authoring-choice',
    {},
    new Proxy({}, { get: () => { throw new Error('model fallback was consulted'); } }) as never,
  );

  assert.equal(result.pass, false, 'an unanswered choice still leaves the draft disabled');
  const query = result.steps.find((step) => step.stepId === 'query_accounts');
  assert.equal(query?.status, 'needs_choice', `expected a question, got ${JSON.stringify(query)}`);
  // The owner is given the actual choices, which the old error text withheld.
  assert.match(query?.detail ?? '', /account-a/);
  assert.match(query?.detail ?? '', /account-b/);
  // The dependent stopped because of the question, not because it is broken.
  const dependent = result.steps.find((step) => step.stepId === 'build_batch');
  assert.equal(dependent?.status, 'unverifiable', `expected no cascade failure, got ${JSON.stringify(dependent)}`);
  assert.equal(result.steps.some((step) => step.status === 'error' || step.status === 'failed'), false,
    `nothing is reported broken: ${JSON.stringify(result.steps)}`);
});
