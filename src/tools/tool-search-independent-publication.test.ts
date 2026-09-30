import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-independent-discovery-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const eventlog = await import('../runtime/harness/eventlog.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifests = await import('../runtime/harness/capability-manifest-store.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const production = await import('../runtime/harness/production-capability-adapters.js');
const semantic = await import('../runtime/semantic-boundary/admit-and-compile-accepted-source.js');
const semanticPorts = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
const provisioning = await import('../runtime/harness/proof-provisioned-catalog.js');
const schemas = await import('./composio-schema-cache.js');
const contracts = await import('./tool-contract-store.js');
const composio = await import('../integrations/composio/client.js');
const sources = await import('./tool-search-provider-sources.js');
const search = await import('./tool-search-tool.js');
const routing = await import('./source-account-routing.js');
const resolution = await import('../runtime/harness/capability-resolution.js');

const TARGET = 'OUTLOOK_GET_MESSAGE';
// Exact live discovery order from source132468. The requested operation was
// third; its unrelated neighbors must not become a selected-plan dependency.
const OPERATIONS = [
  'OUTLOOK_GET_ME_MAIL_FOLDER_MESSAGE_ATTACHMENT',
  'OUTLOOK_GET_MAIL_FOLDER_MESSAGE', TARGET,
  'OUTLOOK_GET_USER_CHILD_FOLDER_MESSAGE',
  'OUTLOOK_LIST_MESSAGES', 'OUTLOOK_GET_MAIL_DELTA',
];
const INPUT = { type: 'object', required: ['message_id'], properties: {
  message_id: { type: 'string' }, user_id: { type: 'string', default: 'me' },
  select: { type: 'array', items: { type: 'string' } },
} };
const OUTPUT = { type: 'object', properties: { id: { type: 'string' }, subject: { type: 'string' } } };
const EMAIL = 'owner@selected.invalid';
const ACCOUNT = 'fixture-selected-outlook';
let businessCalls = 0;
let serial = 0;

function source(text: string, sessionId?: string) {
  const session = sessionId ? eventlog.getSession(sessionId)!
    : eventlog.createSession({ id: `independent-discovery-${++serial}`, kind: 'chat', userId: 'fixture-owner' });
  const event = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  return { sessionId: session.id, sourceUserSeq: event.seq };
}

function setup() {
  schemas.resetToolSchemaCache();
  contracts._clearToolContractsForTests();
  observations.clearIndependentCapabilityObservations();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  production.installProductionTransport(async () => { businessCalls += 1; throw new Error('no business calls in discovery'); });
  composio.__test__.setComposioApiKeyOverride('fixture-only');
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: ACCOUNT, status: 'ACTIVE', user_id: 'fixture-owner', toolkit: { slug: 'outlook' },
    data: { user_info: { email: EMAIL } },
  }]);
  semanticPorts.installTurnSemanticModelPort({
    async interpret() { throw new Error('no hidden work plan'); },
    async judgeAccountSelection(call) {
      return { verdict: call.mode === 'current_source_default' ? 'default_compatible' : 'entailed',
        proposalDigest: call.proposalDigest, modelIdentity: 'fixture-account-judge' };
    },
  });
}

function definition() {
  return { inputParameters: INPUT, outputParameters: OUTPUT,
    providerObservedAt: Date.now(), providerOperationVersion: '20260903_00' };
}

test.after(() => {
  production.installProductionTransport(null);
  semanticPorts.installTurnSemanticModelPort(null);
  schemas._setToolSchemaLoaderForTests(null);
  composio.__test__.setConnectedAccountsLoader(null);
  composio.__test__.setComposioApiKeyOverride(null);
  composio.resetComposioClient();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('live six-choice order discloses the completed exact read while slow neighbors expire without late authority', async () => {
  setup();
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  schemas._setToolSchemaLoaderForTests(async (operation) => {
    if (operation !== TARGET) await slow;
    return definition();
  });
  const identity = source('Read back those three exact saved drafts using their returned IDs.');
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true);
  if (!primed.ok) throw new Error(primed.reason);
  let handler!: (input: unknown) => Promise<{ content: Array<{ text: string }> }>;
  search.registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) {
    handler = callback;
  } } as never, {
    allowedNames: new Set(), dispatchCarrier: 'work_call',
    candidateSources: [{ kind: 'authorized_composio', async search() {
      return OPERATIONS.map((name, index) => ({ name, summary: 'Retrieve an Outlook message by id.',
        score: 1 - index / 10, carrier: 'work_call' as const, schema: INPUT,
        invocation: { name: 'composio_execute_tool', fixedArgs: { tool_slug: name }, payloadField: 'arguments' },
      }));
    } }],
    async discloseForPlanning(candidates, control) {
      const staged = await sources.stageDisclosedPlanningProviderCandidates({ ...identity, candidates,
        signal: control?.signal, deadlineAt: Date.now() + 1_500 });
      const refs = await semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority,
        candidates, signal: control?.signal, deadlineAt: control?.deadlineAt });
      return { version: 1, refs, blockers: staged.blockers };
    },
  });
  const result = await handler({ query: 'get outlook message by id', limit: 8, cursor: null });
  const body = JSON.parse(result.content[0]!.text);
  const target = body.results.find((row: { name: string }) => row.name === TARGET);
  assert.match(target?.capabilityRef ?? '', /^cap:resolved:outlook_get_message/,
    'the actual model-facing search result must contain the executable read ref');
  assert.match(body.hint, /Use a result with a capabilityRef/);
  assert.match(body.hint, /Only if you select an unresolved result/);
  assert.doesNotMatch(body.hint, /Ask the user which exact connected account/);
  const factory = catalogs.peekHostCapabilityCatalogFactory()!;
  assert.equal(factory.get(target.capabilityRef)?.manifest?.accountId, ACCOUNT);
  for (const operation of OPERATIONS.filter(name => name !== TARGET)) {
    const row = body.results.find((entry: { name: string }) => entry.name === operation);
    assert.equal(row?.capabilityRef, undefined);
    assert.equal(row?.planningRefStatus, 'materialization_unavailable');
    assert.match(row?.materializationNextStep ?? '', /exact operation/);
    assert.equal(row?.materializationReason, 'proof_publication_expired');
    assert.equal(row?.example, undefined, 'an unfinished proof must not invite a raw work_call');
    assert.equal(typeof row.materializationNextStep, 'string',
      'each unavailable choice retains its own recovery step without overriding a usable neighbor');
  }
  const before = factory.snapshot().map(entry => entry.capabilityId).sort();
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(factory.snapshot().map(entry => entry.capabilityId).sort(), before);
  assert.equal(manifests.peekCapabilityManifestStore()!.revoke(target.capabilityRef), true);
  assert.equal(catalogs.resolveProvenLiveCatalogEntry({ capabilityId: target.capabilityRef,
    effectiveName: TARGET, accountIdentity: ACCOUNT }), null,
  'a published read ref stops resolving when its exact manifest is revoked');
  assert.equal(businessCalls, 0);
});

test('an invalid exact discovery choice does not suppress its valid neighbor or become callable', async () => {
  setup();
  const bad = OPERATIONS[0]!;
  schemas._setToolSchemaLoaderForTests(async operation => operation === bad
    ? { ...definition(), inputParameters: { type: 'object', required: ['different'], properties: { different: { type: 'number' } } } }
    : definition());
  const identity = source('Read the exact saved message.');
  const staged = await sources.stageDisclosedPlanningProviderCandidates({ ...identity,
    candidates: [bad, TARGET].map(name => ({ name, sourceKind: 'authorized_composio', carrier: 'work_call', schema: INPUT })) });
  assert.equal(staged.blockers[bad]?.reason, 'selected_definition_schema_drift');
  assert.equal(staged.blockers[TARGET], undefined);
  const entries = catalogs.peekHostCapabilityCatalogFactory()!.snapshot();
  assert.equal(entries.some(entry => entry.toolName === TARGET), true);
  assert.equal(entries.some(entry => entry.toolName === bad), false);
});

test('simultaneous searches preserve both source proofs and disclose both exact refs', async () => {
  setup();
  schemas._setToolSchemaLoaderForTests(async () => definition());
  const identity = source('Read both exact sources.');
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.ok(primed.ok);
  if (!primed.ok) throw new Error(primed.reason);
  const candidates = [TARGET, OPERATIONS[0]!].map(name => ({
    name, sourceKind: 'authorized_composio' as const, carrier: 'work_call' as const, schema: INPUT,
  }));
  await Promise.all(candidates.map(candidate => sources.stageDisclosedPlanningProviderCandidates({
    ...identity, candidates: [candidate],
  })));
  const proof = resolution.provenCapabilityEntriesForTurn(identity);
  assert.deepEqual(proof.map(entry => entry.identifier).sort(), candidates.map(candidate => candidate.name).sort());
  const refs = await semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority, candidates });
  assert.deepEqual(Object.keys(refs).sort(), candidates.map(candidate => candidate.name).sort());
  assert.equal(businessCalls, 0);
});

test('an immutable selected plan still publishes nothing when one selected definition drifts', async () => {
  setup();
  const bad = OPERATIONS[0]!;
  schemas._setToolSchemaLoaderForTests(async operation => operation === bad
    ? { ...definition(), inputParameters: { type: 'object', properties: { drift: { type: 'number' } } } }
    : definition());
  const identity = source('Read both exact sources as one plan.');
  resolution.recordAdmissionCapabilityResolution({ ...identity, acceptedInput: 'Read both exact sources as one plan.',
    entries: [TARGET, bad].map(identifier => ({ intent: 'selected exact read', kind: 'composio', identifier,
      status: 'proven', connection: 'active', accountIdentity: ACCOUNT, effectClass: 'read' })) });
  const result = await provisioning.registerProofProvisionedCapabilities(identity, {
    allowedIdentifiers: [TARGET, bad], expectedSchemaDigests: [TARGET, bad].map(identifier => ({ identifier, schemaDigest: contracts.digestSchema(INPUT) })),
  });
  assert.equal(result.refusal?.code, 'selected_definition_schema_drift');
  assert.deepEqual(result.registered, []);
  assert.equal(catalogs.peekHostCapabilityCatalogFactory()!.snapshot().length, 0);
});

test('a scheduled READ with one connected account provisions without the account reviewer', async () => {
  // Live 2026-09-15: platform-49's Sheets read (one connected account) was
  // routed through the WRITE review because the workflow provisioning path
  // passed no effect; the pinned cross-family reviewer took 20–60 s inside the
  // 30 s provisioning deadline and every run failed "proof_publication_expired".
  // The discovery path already resolves a single-account read directly; the
  // scheduled path now says what it is. A write keeps its review.
  setup();
  semanticPorts.installTurnSemanticModelPort(null); // no reviewer available at all
  const connected = [{ slug: 'outlook', connectionId: ACCOUNT, status: 'ACTIVE', accountEmail: EMAIL }];
  const text = 'Read the exact message named in the schedule.';
  const identity = source(text);
  let published = 0;
  const deps = {
    materializeExact: async () => [{ toolkit: 'outlook', slug: TARGET, name: TARGET, score: 1, inputParameters: INPUT }],
    freshConnections: async () => connected,
    registerProof: async () => { published += 1; return { registered: [`cap:resolved:${TARGET.toLowerCase()}`] }; },
  };
  const result = await sources.provisionExactWorkflowProviderOperations({ ...identity, acceptedInput: text, operationIds: [TARGET] }, deps);
  assert.deepEqual(result, { ok: true }, JSON.stringify(result));
  assert.equal(published, 1);
  const proof = resolution.provenCapabilityEntriesForTurn(identity).find(entry => entry.identifier === TARGET);
  assert.equal(proof?.sourceAccountRouting?.judgeModelIdentity, 'host:read_single_account');

  // NEGATIVE: a scheduled WRITE with one account still needs its review.
  const writeSlug = 'OUTLOOK_CREATE_DRAFT';
  const writeText = 'Create the exact draft named in the schedule.';
  const writeIdentity = source(writeText);
  const writeResult = await sources.provisionExactWorkflowProviderOperations({ ...writeIdentity, acceptedInput: writeText, operationIds: [writeSlug] }, {
    ...deps, materializeExact: async () => [{ toolkit: 'outlook', slug: writeSlug, name: writeSlug, score: 1, inputParameters: INPUT }],
  });
  assert.equal(writeResult.ok, false);
  if (!writeResult.ok) assert.equal(writeResult.code, 'account_selection_required');
});

test('a scheduled step\'s own deadline governs its account review, not the chat search budget', async () => {
  // platform-49, 2026-09-15: the write review (model work, 20–60 s on the
  // pinned reviewer) ran inside the 30 s search budget and expired every run.
  setup();
  semanticPorts.installTurnSemanticModelPort({
    async interpret() { throw new Error('no hidden work plan'); },
    async judgeAccountSelection(call) {
      await new Promise(resolve => setTimeout(resolve, 120));
      return { verdict: 'default_compatible', proposalDigest: call.proposalDigest, modelIdentity: 'slow-fixture-judge' };
    },
  });
  const connected = [{ slug: 'outlook', connectionId: ACCOUNT, status: 'ACTIVE', accountEmail: EMAIL }];
  const writeSlug = 'OUTLOOK_CREATE_DRAFT';
  const text = 'Create the exact draft named in the schedule.';
  const deps = {
    materializeExact: async () => [{ toolkit: 'outlook', slug: writeSlug, name: writeSlug, score: 1, inputParameters: INPUT }],
    freshConnections: async () => connected,
    registerProof: async () => ({ registered: [`cap:resolved:${writeSlug.toLowerCase()}`] }),
    totalDeadlineMs: 40,
  };
  // The scheduled caller names its wall clock: the review completes inside it.
  const scheduled = source(text);
  const ok = await sources.provisionExactWorkflowProviderOperations(
    { ...scheduled, acceptedInput: text, operationIds: [writeSlug], deadlineAt: Date.now() + 5_000 }, deps);
  assert.deepEqual(ok, { ok: true }, JSON.stringify(ok));
  // With no caller deadline the search budget still bounds the whole pass.
  const bare = source(text);
  const expired = await sources.provisionExactWorkflowProviderOperations(
    { ...bare, acceptedInput: text, operationIds: [writeSlug] }, deps);
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.code, 'proof_publication_expired');
});

test('exact JIT read provisioning uses checked conversation account continuity without new nomination', async () => {
  setup();
  const other = { slug: 'outlook', connectionId: 'fixture-other-outlook', status: 'ACTIVE', accountEmail: 'owner@other.invalid' };
  const connected = [{ slug: 'outlook', connectionId: ACCOUNT, status: 'ACTIVE', accountEmail: EMAIL }, other];
  const original = source('Save those exact three drafts in my selected Outlook mailbox.');
  const selected = await routing.resolveSourceAccountRouting({ ...original, toolkit: 'outlook', operation: TARGET,
    connections: connected, nomination: { toolkit: 'outlook', identity: EMAIL, source_quote: 'my selected Outlook mailbox' } });
  assert.equal(selected.kind, 'resolved');
  if (selected.kind !== 'resolved') return;
  resolution.recordAdmissionCapabilityResolution({ ...original, acceptedInput: 'Save those exact three drafts in my selected Outlook mailbox.',
    entries: [{ intent: 'checked selected mailbox', kind: 'composio', identifier: 'OUTLOOK_CREATE_DRAFT', status: 'proven',
      connection: 'active', accountIdentity: ACCOUNT, effectClass: 'write', sourceAccountRouting: selected.evidence }] });
  const text = 'Read back those three exact saved drafts using their returned IDs.';
  const retry = source(text, original.sessionId);
  let published = 0;
  const deps = {
    materializeExact: async () => [{ toolkit: 'outlook', slug: TARGET, name: TARGET, score: 1, inputParameters: INPUT }],
    freshConnections: async () => connected,
    registerProof: async () => { published += 1; return { registered: [`cap:resolved:${TARGET.toLowerCase()}`] }; },
  };
  const result = await sources.provisionExactWorkflowProviderOperations({ ...retry, acceptedInput: text, operationIds: [TARGET] }, deps);
  assert.deepEqual(result, { ok: true });
  const proof = resolution.provenCapabilityEntriesForTurn(retry).find(entry => entry.identifier === TARGET);
  assert.equal(proof?.accountIdentity, ACCOUNT);
  assert.equal(proof?.sourceAccountRouting?.sourceUserSeq, original.sourceUserSeq);
  assert.equal(proof?.sourceAccountRouting?.checkedForSourceUserSeq, retry.sourceUserSeq);
  const unrelated = source(text);
  const blocked = await sources.provisionExactWorkflowProviderOperations({ ...unrelated, acceptedInput: text, operationIds: [TARGET] }, deps);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, 'account_selection_required');
  assert.equal(published, 1, 'another session cannot inherit the first session account choice');
  const otherPrincipal = eventlog.createSession({ id: 'jit-other-principal', kind: 'chat', userId: 'different-owner' });
  const otherSource = source(text, otherPrincipal.id);
  const foreign = await sources.provisionExactWorkflowProviderOperations({ ...otherSource, acceptedInput: text, operationIds: [TARGET] }, deps);
  assert.equal(foreign.ok, false);
  assert.equal(published, 1, 'a different principal cannot inherit account-routing proof');
});

test('workflow re-provisioning keeps its selected account when another active account is the default', async () => {
  setup();
  const other = { slug: 'outlook', connectionId: 'fixture-default-outlook', status: 'ACTIVE', accountEmail: 'default@other.invalid' };
  const selected = { slug: 'outlook', connectionId: ACCOUNT, status: 'ACTIVE', accountEmail: EMAIL };
  const connections = [other, selected];
  composio.__test__.setConnectedAccountsLoader(async () => connections.map(row => ({
    id: row.connectionId, status: row.status, user_id: 'fixture-owner', toolkit: { slug: row.slug },
    data: { user_info: { email: row.accountEmail } },
  })));
  const aliases = await import('../memory/account-alias-store.js');
  aliases.rememberAccountAlias({ toolkit: 'outlook', label: routing.READ_DEFAULT_ACCOUNT_LABEL,
    email: other.accountEmail, connectionId: other.connectionId });
  let version = '20260903_00';
  schemas._setToolSchemaLoaderForTests(async () => ({ ...definition(), providerOperationVersion: version }));
  const seedText = `Read ${TARGET} from connection ${ACCOUNT}.`;
  const seed = source(seedText);
  resolution.recordAdmissionCapabilityResolution({ ...seed, acceptedInput: seedText, entries: [{
    intent: 'selected read', kind: 'composio', identifier: TARGET, status: 'proven', connection: 'active',
    accountIdentity: ACCOUNT, effectClass: 'read',
  }] });
  const seeded = await provisioning.registerProofProvisionedCapabilities(seed, {
    allowedIdentifiers: [TARGET], expectedSchemaDigests: [{ identifier: TARGET, schemaDigest: contracts.digestSchema(INPUT) }],
  });
  const predecessor = seeded.registered.find(id => id.startsWith(`cap:resolved:${TARGET.toLowerCase()}`))!;
  assert.ok(predecessor);
  version = '20260922_00';
  const turn = source(seedText);
  const result = await sources.provisionExactWorkflowProviderOperations({
    ...turn, acceptedInput: seedText, operationIds: [TARGET],
    selectedAccounts: [{ operationId: TARGET, accountId: ACCOUNT }],
  }, {
    materializeExact: async () => [{ toolkit: 'outlook', slug: TARGET, name: TARGET, score: 1, inputParameters: INPUT }],
    freshConnections: async () => connections,
  });
  assert.deepEqual(result, { ok: true });
  const proof = resolution.provenCapabilityEntriesForTurn(turn).find(entry => entry.identifier === TARGET);
  assert.equal(proof?.accountIdentity, ACCOUNT, 'refresh must not substitute the remembered default');
  const store = manifests.peekCapabilityManifestStore()!;
  assert.equal(store.list().find(row => row.manifest.manifestId === predecessor)?.manifest.lifecycle.state, 'superseded');
  const current = store.list().filter(row => row.manifest.lifecycle.state === 'current' && row.manifest.operationId === TARGET);
  assert.equal(current.length, 1);
  assert.equal(current[0]!.manifest.accountId, ACCOUNT);
  assert.equal(current[0]!.manifest.operationVersion, version);
  assert.equal(businessCalls, 0);
});

for (const scenario of ['missing', 'unquoted', 'write-review-unavailable'] as const) {
  test(`selected workflow account cannot silently fall back: ${scenario}`, async () => {
    setup();
    const other = { slug: 'outlook', connectionId: 'fixture-default-outlook', status: 'ACTIVE', accountEmail: 'default@other.invalid' };
    const selected = { slug: 'outlook', connectionId: ACCOUNT, status: 'ACTIVE', accountEmail: EMAIL };
    const aliases = await import('../memory/account-alias-store.js');
    aliases.rememberAccountAlias({ toolkit: 'outlook', label: routing.READ_DEFAULT_ACCOUNT_LABEL,
      email: other.accountEmail, connectionId: other.connectionId });
    if (scenario === 'write-review-unavailable') semanticPorts.installTurnSemanticModelPort(null);
    const operation = scenario === 'write-review-unavailable' ? 'OUTLOOK_CREATE_DRAFT' : TARGET;
    const text = scenario === 'unquoted' ? `Use ${operation}.` : `Use ${operation} with connection ${ACCOUNT}.`;
    const turn = source(text);
    let published = 0;
    const result = await sources.provisionExactWorkflowProviderOperations({
      ...turn, acceptedInput: text, operationIds: [operation],
      selectedAccounts: [{ operationId: operation, accountId: ACCOUNT }],
    }, {
      materializeExact: async () => [{ toolkit: 'outlook', slug: operation, name: operation, score: 1, inputParameters: INPUT }],
      freshConnections: async () => scenario === 'missing' ? [other] : [other, selected],
      registerProof: async () => { published += 1; return { registered: [] }; },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'account_selection_required');
    assert.equal(published, 0);
    assert.equal(businessCalls, 0);
  });
}

for (const scenario of ['cold-pinned', 'warm-unpinned'] as const) {
test(`scheduled Space read re-provisions a moved definition through real source proof without a fabricated chat: ${scenario}`, async () => {
  setup();
  const { spaceStore } = await import('../spaces/store.js');
  const authority = await import('../spaces/space-read-authority.js');
  const external = await import('../execution/workflow-step-external-catalog.js');
  const runner = await import('../spaces/runner.js');
  const slug = `fixture-scheduled-definition-${scenario}`;
  const connections = [
    ...(scenario === 'cold-pinned' ? [{ slug: 'outlook', connectionId: 'fixture-other', status: 'ACTIVE', accountEmail: 'other@invalid.test' }] : []),
    { slug: 'outlook', connectionId: ACCOUNT, status: 'ACTIVE', accountEmail: EMAIL },
  ];
  composio.__test__.setConnectedAccountsLoader(async () => connections.map(row => ({
    id: row.connectionId, status: row.status, user_id: 'fixture-owner', toolkit: { slug: row.slug },
    data: { user_info: { email: row.accountEmail } },
  })));
  let version = '20260903_00';
  schemas._setToolSchemaLoaderForTests(async () => ({ ...definition(), providerOperationVersion: version }));
  const text = `Read ${TARGET} from connection ${ACCOUNT}.`;
  const seed = source(text);
  resolution.recordAdmissionCapabilityResolution({ ...seed, acceptedInput: text, entries: [{
    intent: 'seed definition', kind: 'composio', identifier: TARGET, status: 'proven', connection: 'active',
    accountIdentity: ACCOUNT, effectClass: 'read',
  }] });
  assert.ok((await provisioning.registerProofProvisionedCapabilities(seed, {
    allowedIdentifiers: [TARGET], expectedSchemaDigests: [{ identifier: TARGET, schemaDigest: contracts.digestSchema(INPUT) }],
  })).registered.length);
  version = '20260930_00';
  // Rehearse a cold restart: persisted manifests remain, process catalog and
  // observations are gone, and the provider now reports a successor.
  if (scenario === 'cold-pinned') {
    catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
    observations.clearIndependentCapabilityObservations();
  }
  spaceStore.save({ id: slug, title: 'Framework fixture', dataSources: [{
    id: 'mail', composioSlug: TARGET, ...(scenario === 'cold-pinned' ? { composioAccountId: ACCOUNT } : {}),
    composioArgs: { message_id: 'fixture-message' },
  }] });
  let exactLookups = 0;
  let providerCalls = 0;
  const isolatedTransport = await import('../runtime/harness/isolated-attested-transport.fixture.js');
  isolatedTransport.installIsolatedAttestedTransport(async call => {
    providerCalls += 1;
    assert.equal(call.operationId, TARGET);
    assert.equal(call.accountId, ACCOUNT);
    assert.equal(call.args.message_id, 'fixture-message');
    return { successful: true, data: { id: 'fixture-message', subject: 'Synthetic' } };
  });
  authority._setExactSpaceReadCatalogPreparerForTests(input => external.prepareWorkflowStepExternalCatalog(input, {
    warm: async () => {},
    // This file installs fixture transport/catalog ports rather than booting
    // the daemon readiness controller. Require the real proof's callable
    // entries below; operation/account/schema comparisons still run normally.
    refresh: () => {},
    ready: ids => ids.every(id => Boolean(catalogs.peekHostCapabilityCatalogFactory()?.get(id))),
    provisionExactOperations: data => {
      exactLookups += 1;
      return sources.provisionExactWorkflowProviderOperations(data, {
        materializeExact: async () => [{ toolkit: 'outlook', slug: TARGET, name: TARGET, score: 1, inputParameters: INPUT }],
        freshConnections: async () => connections,
      });
    },
  }));
  try {
    const result = await runner.refreshSpaceData(slug, 'mail', { cause: 'scheduled' });
    assert.equal(result[0]?.ok, true, JSON.stringify(result));
    assert.equal(exactLookups, 1, 'one bounded repair, no discovery loop');
    assert.equal(providerCalls, 1, 'one shared-kernel read after metadata repair');
    const sessionId = `workspace:${slug}`;
    assert.equal(eventlog.listEvents(sessionId, { types: ['user_input_received'] }).length, 0);
    const receipts = eventlog.listEvents(sessionId, { types: ['workspace_read_preparation_started'] });
    assert.equal(receipts.length, 1);
    const proof = resolution.provenCapabilityEntriesForTurn({ sessionId, sourceUserSeq: receipts[0]!.seq });
    assert.equal(proof.find(row => row.identifier === TARGET)?.accountIdentity, ACCOUNT);
    assert.ok(manifests.peekCapabilityManifestStore()!.list().some(row => row.manifest.lifecycle.state === 'current'
      && row.manifest.operationId === TARGET && row.manifest.accountId === ACCOUNT && row.manifest.operationVersion === version));
    eventlog.closeEventLog();
    const { readSpaceReadPreparation } = await import('../spaces/read-preparation-source.js');
    assert.ok(readSpaceReadPreparation(sessionId, receipts[0]!.seq), 'receipt survives reopening the journal');
  } finally {
    authority._setExactSpaceReadCatalogPreparerForTests(null);
    isolatedTransport.installIsolatedAttestedTransport(null);
    spaceStore.archive(slug);
  }
});
}

test('Space read preparation cannot substitute an account, become a write or survive a declaration edit', async () => {
  setup();
  const { spaceStore } = await import('../spaces/store.js');
  const { beginSpaceReadPreparation, readSpaceReadPreparation } = await import('../spaces/read-preparation-source.js');
  const slug = 'fixture-read-preparation-scope';
  const dataSource = { id: 'mail', composioSlug: TARGET, composioAccountId: ACCOUNT, composioArgs: { message_id: 'fixture-message' } };
  spaceStore.save({ id: slug, title: 'Framework fixture', dataSources: [dataSource] });
  try {
    assert.throws(() => beginSpaceReadPreparation({ slug, sourceId: 'mail', toolSlug: TARGET,
      accountId: 'invented', args: dataSource.composioArgs, cause: 'scheduled' }), /changed/);
    const receipt = beginSpaceReadPreparation({ slug, sourceId: 'mail', toolSlug: TARGET,
      accountId: ACCOUNT, args: dataSource.composioArgs, cause: 'scheduled' });
    const connections = [{ slug: 'outlook', connectionId: 'other-only', status: 'ACTIVE', accountEmail: 'other@invalid.test' }];
    const route = await routing.resolveSourceAccountRouting({ ...receipt, toolkit: 'outlook', operation: TARGET, effect: 'read', connections });
    assert.equal(route.kind, 'account_selection_required');
    const write = await routing.resolveSourceAccountRouting({ ...receipt, toolkit: 'outlook', operation: TARGET,
      effect: 'write', connections: [{ ...connections[0]!, connectionId: ACCOUNT }] });
    assert.equal(write.kind, 'account_selection_required');
    let lookups = 0;
    const wrongOperation = await sources.provisionExactWorkflowProviderOperations({ ...receipt,
      operationIds: ['OUTLOOK_CREATE_DRAFT'] }, { materializeExact: async () => { lookups += 1; return []; } });
    assert.equal(wrongOperation.ok, false);
    assert.equal(lookups, 0);
    resolution.recordAdmissionCapabilityResolution({ ...receipt, entries: [{ intent: 'not authorized by read declaration',
      kind: 'composio', identifier: TARGET, status: 'proven', connection: 'active', accountIdentity: ACCOUNT, effectClass: 'write' }] });
    assert.deepEqual(resolution.provenCapabilityEntriesForTurn(receipt), []);
    spaceStore.save({ id: slug, title: 'Framework fixture', dataSources: [{ ...dataSource, composioArgs: { message_id: 'changed' } }] });
    assert.equal(readSpaceReadPreparation(receipt.sessionId, receipt.sourceUserSeq), null);
    const changed = await sources.provisionExactWorkflowProviderOperations({ ...receipt, operationIds: [TARGET] }, {
      materializeExact: async () => { lookups += 1; return []; },
    });
    assert.equal(changed.ok, false);
    assert.equal(lookups, 0);
  } finally { spaceStore.archive(slug); }
});

test('an edit during Space metadata lookup cannot publish proof or call the provider', async () => {
  setup();
  const { spaceStore } = await import('../spaces/store.js');
  const { beginSpaceReadPreparation } = await import('../spaces/read-preparation-source.js');
  const slug = 'fixture-edit-during-preparation';
  const dataSource = { id: 'mail', composioSlug: TARGET, composioAccountId: ACCOUNT, composioArgs: { message_id: 'before' } };
  spaceStore.save({ id: slug, title: 'Framework fixture', dataSources: [dataSource] });
  let publications = 0;
  try {
    const receipt = beginSpaceReadPreparation({ slug, sourceId: 'mail', toolSlug: TARGET,
      accountId: ACCOUNT, args: dataSource.composioArgs, cause: 'scheduled' });
    const result = await sources.provisionExactWorkflowProviderOperations({ ...receipt, operationIds: [TARGET] }, {
      materializeExact: async () => {
        spaceStore.save({ id: slug, title: 'Framework fixture', dataSources: [{ ...dataSource, composioArgs: { message_id: 'after' } }] });
        return [{ toolkit: 'outlook', slug: TARGET, name: TARGET, score: 1, inputParameters: INPUT }];
      },
      freshConnections: async () => [{ slug: 'outlook', connectionId: ACCOUNT, status: 'ACTIVE', accountEmail: EMAIL }],
      registerProof: async () => { publications += 1; return { registered: [] }; },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.detail, 'workspace_source_changed_or_operation_not_read');
    assert.equal(publications, 0);
    assert.equal(eventlog.listEvents(receipt.sessionId, { types: ['capability_resolution'] }).length, 0);
  } finally { spaceStore.archive(slug); }
});

test('a saved source naming a write cannot provision it as a scheduled read', async () => {
  setup();
  const { spaceStore } = await import('../spaces/store.js');
  const { beginSpaceReadPreparation } = await import('../spaces/read-preparation-source.js');
  const slug = 'fixture-write-not-read';
  const operation = 'OUTLOOK_CREATE_DRAFT';
  spaceStore.save({ id: slug, title: 'Framework fixture', dataSources: [{ id: 'mail', composioSlug: operation,
    composioAccountId: ACCOUNT, composioArgs: {} }] });
  let publications = 0;
  try {
    const receipt = beginSpaceReadPreparation({ slug, sourceId: 'mail', toolSlug: operation, accountId: ACCOUNT, args: {}, cause: 'scheduled' });
    const result = await sources.provisionExactWorkflowProviderOperations({ ...receipt, operationIds: [operation] }, {
      materializeExact: async () => [{ toolkit: 'outlook', slug: operation, name: operation, score: 1, inputParameters: INPUT }],
      freshConnections: async () => [{ slug: 'outlook', connectionId: ACCOUNT, status: 'ACTIVE', accountEmail: EMAIL }],
      registerProof: async () => { publications += 1; return { registered: [] }; },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.detail, 'workspace_source_changed_or_operation_not_read');
    assert.equal(publications, 0);
  } finally { spaceStore.archive(slug); }
});

test('an unpinned Space read uses the taught read default without inheriting a sibling source account', async () => {
  setup();
  const { spaceStore } = await import('../spaces/store.js');
  const { beginSpaceReadPreparation } = await import('../spaces/read-preparation-source.js');
  const aliases = await import('../memory/account-alias-store.js');
  const slug = 'fixture-unpinned-read-default';
  const operation = 'SLACK_SEARCH_MESSAGES';
  const connections = [
    { slug: 'slack', connectionId: 'slack-selected', status: 'ACTIVE', accountEmail: 'selected@invalid.test' },
    { slug: 'slack', connectionId: 'slack-other', status: 'ACTIVE', accountEmail: 'other@invalid.test' },
  ];
  spaceStore.save({ id: slug, title: 'Framework fixture', dataSources: [{ id: 'slack', composioSlug: operation, composioArgs: {} }] });
  try {
    const receipt = beginSpaceReadPreparation({ slug, sourceId: 'slack', toolSlug: operation, args: {}, cause: 'scheduled' });
    const input = { ...receipt, toolkit: 'slack', operation, effect: 'read' as const, connections };
    assert.equal((await routing.resolveSourceAccountRouting(input)).kind, 'account_selection_required',
      'several accounts and no taught default are an actual choice');
    aliases.rememberAccountAlias({ toolkit: 'slack', label: routing.READ_DEFAULT_ACCOUNT_LABEL,
      email: connections[0]!.accountEmail, connectionId: connections[0]!.connectionId });
    const resolved = await routing.resolveSourceAccountRouting(input);
    assert.equal(resolved.kind, 'resolved');
    if (resolved.kind === 'resolved') assert.equal(resolved.connection.connectionId, 'slack-selected');
    const conflict = await sources.provisionExactWorkflowProviderOperations({ ...receipt, operationIds: [operation],
      selectedAccounts: [{ operationId: operation, accountId: 'slack-other' }] }, {
      materializeExact: async () => [{ toolkit: 'slack', slug: operation, name: operation, score: 1, inputParameters: { type: 'object' } }],
      freshConnections: async () => connections,
      registerProof: async () => { assert.fail('a taught default cannot switch the predecessor account'); },
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.detail, 'selected_account_changed_during_refresh');
  } finally { spaceStore.archive(slug); }
});
