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
    message: `No current capability is registered for "${operationId}". Connect it, then retry. (1 durable manifest(s), 0 registered, refused: missing)`,
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

test('one account registered more than once is one account: nothing is asked and the last issued is used', () => {
  const operationId = 'GENERIC_REPEATED_QUERY';
  // The same operation for the same account, disclosed three times.
  const manifests = ['2026-08-27T00:00:00.000Z', '2026-08-29T00:00:00.000Z', '2026-08-28T00:00:00.000Z'].map((issuedAt, index) => ({
    ...manifestFor({ operationId, manifestId: `cap:generic-repeated-query:seen-${index}`, accountId: 'host-account' }),
    provenance: { issuer: 'workflow-catalog-handoff-test', issuedAt, trusted: true },
  }));
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
      { observe, invoke: async () => ({ data: { value: [] } }) },
    ).ok, true);
  }
  adapters.installProductionCapabilityAdapter(adapters.createProductionCapabilityAdapter({ factory, store }));

  const result = compiler.compileLiveCatalogWorkflowCallPlan({
    ownerId: 'scheduled-workflow',
    nodeId: 'read_records',
    operationId,
    args: { scope: 'newest' },
    expectedEffect: 'read',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) assert.fail(result.message);
  assert.equal(factory.snapshot().length, 3, 'all three were current candidates');
  assert.equal(result.identity.account, 'host-account');
  assert.equal(result.identity.capabilityId, 'cap:generic-repeated-query:seen-1', 'the one issued last, whatever order they were registered in');
  assert.equal(result.plan.binding.accountId, 'host-account');
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
  assert.equal(dependent?.status, 'not_run', `a required step that never ran is said so, not failed: ${JSON.stringify(dependent)}`);
  assert.equal(result.steps.some((step) => step.status === 'error' || step.status === 'failed'), false,
    `nothing is reported broken: ${JSON.stringify(result.steps)}`);
});

test('a step naming an app this setup has not connected is a dependency to connect, not a question or a broken step', async (t) => {
  runner._setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    prepareExternalCatalog: async () => ({
      status: 'refused', reason: 'exact_operation_provisioning_refused', operationId: 'ACMECRM_LIST_LEADS', detail: 'toolkit_not_connected',
    }) as never,
    runConversation: (async () => { throw new Error('a step that cannot be provisioned never reaches its model'); }) as never,
  });
  t.after(() => runner._setWorkflowHarnessLoopImplsForTests());
  const saved = workflows.writeWorkflow('connection-dependency-canary', {
    name: 'Connection dependency canary', description: 'Reads leads from an app this setup has not connected.',
    enabled: false, trigger: { manual: true },
    steps: [
      { id: 'pull_leads', prompt: 'List the newest leads with ACMECRM_LIST_LEADS.', sideEffect: 'read', allowedTools: ['ACMECRM_LIST_LEADS'] },
      { id: 'summarize', prompt: 'Summarize the leads.', sideEffect: 'read', dependsOn: ['pull_leads'] },
    ],
  });
  const result = await runner.runCreationTest(saved.data, saved.name, 'creation-connection-dependency', {},
    { respond: async () => { throw new Error('legacy responder must not execute'); } } as never);
  assert.equal(result.pass, false, 'it stays off until the app is connected');
  const pull = result.steps.find((step) => step.stepId === 'pull_leads');
  assert.equal(pull?.status, 'needs_connection', JSON.stringify(result.steps));
  assert.match(pull?.detail ?? '', /connected here/);
  assert.equal(result.steps.find((step) => step.stepId === 'summarize')?.status, 'not_run');
  const lines = runner.creationTestStepLines(result.steps).join('\n');
  assert.doesNotMatch(lines, /needs your answer|hit an error|failed/);
  assert.match(lines, /connected here/);
});

test('a rehearsal checks a previewed write step\'s filled-in arguments the way the run will, without making the change', async () => {
  const broken = workflows.writeWorkflow('rehearsed-write-arguments', {
    name: 'Rehearsed write arguments', description: 'Saves a note to a path that is not text.',
    enabled: false, trigger: { manual: true },
    steps: [
      { id: 'save_note', sideEffect: 'write', call: { tool: 'write_file', args: { path: { not: 'a path' }, content: 'hello', mode: 'overwrite' } } },
    ],
  });
  const refused = await runner.runCreationTest(broken.data, broken.name, 'creation-rehearsed-write-args', {},
    { respond: async () => { throw new Error('no model runs in this rehearsal'); } } as never);
  assert.equal(refused.pass, false, 'a write the run would refuse is found before it is turned on');
  const save = refused.steps.find((step) => step.stepId === 'save_note');
  assert.equal(save?.status, 'error', JSON.stringify(refused.steps));
  assert.match(save?.detail ?? '', /run would stop here/);
  assert.match(save?.detail ?? '', /path/);

  const fine = workflows.writeWorkflow('rehearsed-write-arguments-ok', {
    name: 'Rehearsed write arguments ok', description: 'Saves a note.',
    enabled: false, trigger: { manual: true },
    steps: [
      { id: 'save_note', sideEffect: 'write', call: { tool: 'write_file', args: { path: 'notes/rehearsal-canary.md', content: 'hello', mode: 'overwrite' } } },
    ],
  });
  const previewed = await runner.runCreationTest(fine.data, fine.name, 'creation-rehearsed-write-args-ok', {},
    { respond: async () => { throw new Error('no model runs in this rehearsal'); } } as never);
  assert.equal(previewed.steps.find((step) => step.stepId === 'save_note')?.status, 'previewed', JSON.stringify(previewed.steps));
});

test('a step\'s whole output saved to a file is written as its JSON text, not refused', async () => {
  const { normalizeReviewedLocalWorkflowArguments } = await import('../runtime/harness/reviewed-local-workflow-capability.js');
  const normalized = normalizeReviewedLocalWorkflowArguments('write_file', {
    path: 'notes/out.md', content: { title: 'Care', tips: ['water', 'light'] }, mode: 'overwrite',
  });
  assert.equal(typeof normalized.content, 'string');
  assert.deepEqual(JSON.parse(String(normalized.content)), { title: 'Care', tips: ['water', 'light'] });
  const fine = workflows.writeWorkflow('rehearsed-write-object-content', {
    name: 'Rehearsed write object content', description: 'Saves a structured note.',
    enabled: false, trigger: { manual: true },
    steps: [
      { id: 'save_note', sideEffect: 'write', call: { tool: 'write_file', args: { path: 'notes/object.md', content: { a: 1 }, mode: 'overwrite' } } },
    ],
  });
  const result = await runner.runCreationTest(fine.data, fine.name, 'creation-rehearsed-object-content', {},
    { respond: async () => { throw new Error('no model runs in this rehearsal'); } } as never);
  assert.equal(result.steps.find((step) => step.stepId === 'save_note')?.status, 'previewed', JSON.stringify(result.steps));
});

test('a field of a step\'s output fills in inside text, and a field the real output lacks is caught by the rehearsal', async () => {
  const filled = runner.renderCallArgs(
    { content: '{{steps.gather.output.title}}: {{steps.gather.output.tips.0}}', whole: '{{steps.gather.output.title}}' },
    {},
    { gather: '{"title":"Care","tips":["water weekly","bright light"]}' },
  );
  assert.equal(filled.content, 'Care: water weekly', 'JSON text output has its fields too, inside text');
  assert.equal(filled.whole, 'Care');

  runner._setWorkflowCallNodeForTests(async (step) => (
    step.id === 'gather' ? { title: 'Care', tips: ['water weekly', 'bright light'] } : { ok: true }
  ));
  try {
    const saved = workflows.writeWorkflow('rehearsed-missing-field', {
      name: 'Rehearsed missing field', description: 'Saves a note from a field the step does not return.',
      enabled: false, trigger: { manual: true },
      steps: [
        { id: 'gather', sideEffect: 'read', call: { tool: 'FIXTURE_TIPS_LIST_TIPS', args: {} } },
        { id: 'save_note', dependsOn: ['gather'], sideEffect: 'write',
          call: { tool: 'write_file', args: { path: 'notes/field.md', content: '{{steps.gather.output.headline}}', mode: 'overwrite' } } },
      ],
    });
    const result = await runner.runCreationTest(saved.data, saved.name, 'creation-rehearsed-missing-field', {},
      { respond: async () => { throw new Error('legacy responder must not execute'); } } as never);
    const save = result.steps.find((step) => step.stepId === 'save_note');
    assert.equal(result.steps.find((step) => step.stepId === 'gather')?.status, 'ok', JSON.stringify(result.steps));
    assert.equal(save?.status, 'error', JSON.stringify(result.steps));
    assert.match(save?.detail ?? '', /steps\.gather\.output\.headline/);
  } finally {
    runner._setWorkflowCallNodeForTests();
  }
});

test('one reference grammar: spaced references fill in inside text, whole references keep their type, and other braces stay', () => {
  const outputs = { gather: { title: 'Care', tips: ['water weekly', 'bright light'], count: 2, empty: '' } };
  const filled = runner.renderCallArgs({
    sentence: 'Title: {{ steps.gather.output.title }} / First: {{steps.gather.output.tips.0}}',
    whole: '{{ steps.gather.output.tips }}',
    number: '{{ steps.gather.output.count }}',
    empty: '{{ steps.gather.output.empty }}',
    merge: 'Hi {{first_name}}, {{ input.greeting }}',
  }, { greeting: 'welcome' }, outputs);
  assert.equal(filled.sentence, 'Title: Care / First: water weekly');
  assert.deepEqual(filled.whole, ['water weekly', 'bright light'], 'a whole reference keeps the value\'s type');
  assert.equal(filled.number, 2);
  assert.equal(filled.empty, '', 'an empty value is data');
  assert.equal(filled.merge, 'Hi {{first_name}}, welcome', 'a form outside the grammar is left as written');
});

test('preparation tells missing data from empty data and from data only a real run produces', async () => {
  const workflow = {
    name: 'Prep outcomes', description: 'x', enabled: false, trigger: { manual: true as const },
    inputs: { note: { type: 'string', description: 'optional note' } },
    steps: [] as never[],
  };
  const step = (content: string) => ({ id: 'save', sideEffect: 'write' as const,
    call: { tool: 'write_file', args: { path: 'notes/prep.md', content, mode: 'overwrite' } } });
  const prepare = (content: string, stepOutputs: Record<string, unknown>, inputs: Record<string, string> = {}) => (
    runner.prepareWorkflowCallArguments(step(content) as never, { workflow: workflow as never, inputs, stepOutputs }));

  const ready = await prepare('{{ steps.gather.output.title }} {{ input.note }}', { gather: { title: 'Care' } });
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  if (ready.status === 'ready') assert.equal(ready.args.content, 'Care ', 'a declared input left empty is empty, not missing');

  const field = await prepare('{{ steps.gather.output.headline }}', { gather: { title: 'Care' } });
  assert.equal(field.status, 'missing_data');
  if (field.status === 'missing_data') assert.match(field.detail, /"gather"'s output has no "headline"/);

  const noStep = await prepare('{{ steps.never_ran.output }}', {});
  assert.equal(noStep.status, 'missing_data');

  const undeclared = await prepare('{{ input.unknown_key }}', {});
  assert.equal(undeclared.status, 'missing_data');
  if (undeclared.status === 'missing_data') assert.match(undeclared.detail, /no input "unknown_key"/);

  const previewOnly = await prepare('{{ steps.draft.output.id }}', { draft: { previewed: true, reason: 'previewed' } });
  assert.equal(previewOnly.status, 'needs_real_write');

  const refused = await runner.prepareWorkflowCallArguments({ id: 'save', sideEffect: 'write',
    call: { tool: 'write_file', args: { path: { not: 'a path' }, content: 'x', mode: 'overwrite' } } } as never,
  { workflow: workflow as never, inputs: {}, stepOutputs: {} });
  assert.equal(refused.status, 'refused');
});

test('a rehearsal compiles a previewed write call through the run\'s path: an app not connected here is named before the run', async () => {
  const saved = workflows.writeWorkflow('rehearsed-write-unconnected', {
    name: 'Rehearsed write unconnected', description: 'Creates a lead in an app this setup has not connected.',
    enabled: false, trigger: { manual: true },
    steps: [
      { id: 'create_lead', sideEffect: 'write', call: { tool: 'ACMECRM_CREATE_LEAD', args: { name: 'Fixture lead' } } },
    ],
  });
  const result = await runner.runCreationTest(saved.data, saved.name, 'creation-rehearsed-write-unconnected', {},
    { respond: async () => { throw new Error('no model runs in this rehearsal'); } } as never);
  const lead = result.steps.find((step) => step.stepId === 'create_lead');
  assert.notEqual(lead?.status, 'previewed', `a write the run cannot compile is not a clean preview: ${JSON.stringify(result.steps)}`);
  assert.equal(result.pass, false);
});

test('a rehearsal tells a required step that never ran from verification deferred until after a previewed write', async () => {
  const saved = workflows.writeWorkflow('rehearsed-deferred-vs-not-run', {
    name: 'Rehearsed deferred vs not run', description: 'Saves a note, then reads it back.',
    enabled: false, trigger: { manual: true },
    steps: [
      { id: 'save_note', sideEffect: 'write', call: { tool: 'write_file', args: { path: 'notes/deferred.md', content: 'hello', mode: 'overwrite' } } },
      { id: 'read_back', sideEffect: 'read', dependsOn: ['save_note'], call: { tool: 'read_file', args: { path: 'notes/deferred.md' } } },
    ],
  });
  const result = await runner.runCreationTest(saved.data, saved.name, 'creation-deferred-vs-not-run', {},
    { respond: async () => { throw new Error('no model runs in this rehearsal'); } } as never);
  const readBack = result.steps.find((step) => step.stepId === 'read_back');
  assert.equal(readBack?.status, 'unverifiable', JSON.stringify(result.steps));
  assert.equal(result.pass, true, 'verification deferred by design does not fail the rehearsal');
  const lines = runner.creationTestStepLines(result.steps).join('\n');
  assert.match(lines, /Read back — checked on the first real run/i);
  assert.doesNotMatch(lines, /did not run/);
});
