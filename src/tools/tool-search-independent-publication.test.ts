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
