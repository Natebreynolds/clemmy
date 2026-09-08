import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-deferred-provider-page-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.COMPOSIO_BACKEND = 'sdk';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const events = await import('../runtime/harness/eventlog.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifests = await import('../runtime/harness/capability-manifest-store.js');
const production = await import('../runtime/harness/production-capability-adapters.js');
const semantic = await import('../runtime/semantic-boundary/admit-and-compile-accepted-source.js');
const ports = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
const schemas = await import('./composio-schema-cache.js');
const contracts = await import('./tool-contract-store.js');
const composio = await import('../integrations/composio/client.js');
const providers = await import('./tool-search-provider-sources.js');
const search = await import('./tool-search-tool.js');
const index = await import('../memory/capability-index.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const OPERATION = 'OUTLOOK_GET_MESSAGE';
const INPUT = { type: 'object', required: ['message_id'], properties: { message_id: { type: 'string' } } };
const OUTPUT = { type: 'object', properties: { id: { type: 'string' } } };
const QUERY = 'create a static Space with HTML content';
const ACCOUNT = 'fixture-page-account';
let serial = 0;

test.after(() => {
  production.installProductionTransport(null);
  ports.installTurnSemanticModelPort(null);
  schemas._setToolSchemaLoaderForTests(null);
  composio.__test__.setConnectedAccountsLoader(null);
  composio.__test__.setComposioApiKeyOverride(null);
  composio.resetComposioClient();
  index._resetCapabilityIndexForTest();
  events.closeEventLog();
  rmSync(fixtureHome, { recursive: true, force: true });
});

async function fixture(operation = OPERATION) {
  schemas.resetToolSchemaCache();
  contracts._clearToolContractsForTests();
  index._resetCapabilityIndexForTest();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  const counts = { fuzzy: 0, exact: 0, accountReviews: 0, business: 0 };
  production.installProductionTransport(async () => { counts.business += 1; throw new Error('no business calls'); });
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('fixture-only');
  let currentAccount = ACCOUNT;
  const loadAccounts = async () => [{ id: currentAccount, status: 'ACTIVE',
    user_id: 'fixture-owner', toolkit: { slug: 'outlook' } }];
  composio.__test__.setConnectedAccountsLoader(loadAccounts);
  composio.__test__.setComposioClient({ tools: {
    async getRawComposioTools(input: { tools?: string[] }) {
      if (!input.tools?.length) { counts.fuzzy += 1; return []; }
      counts.exact += 1;
      return input.tools.filter((name) => name === operation).map((slug) => ({ slug,
        name: 'Read a message', description: 'Read an Outlook message containing HTML content.',
        toolkit: { slug: 'outlook' }, inputParameters: INPUT, outputParameters: OUTPUT, version: 'fixture-page-v1' }));
    },
    async execute() { counts.business += 1; throw new Error('no business calls'); },
  } } as never);
  schemas._setToolSchemaLoaderForTests(async () => ({ inputParameters: INPUT, outputParameters: OUTPUT,
    providerObservedAt: Date.now(), providerOperationVersion: 'fixture-page-v1' }));
  ports.installTurnSemanticModelPort({
    async interpret() { throw new Error('no hidden plan'); },
    async judgeAccountSelection(call) { counts.accountReviews += 1; return {
      verdict: call.mode === 'current_source_default' ? 'default_compatible' : 'entailed',
      proposalDigest: call.proposalDigest, modelIdentity: 'fixture-account-judge',
    }; },
  });
  const session = events.createSession({ id: `deferred-provider-${++serial}`, kind: 'chat', userId: 'fixture-owner' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: `Create the Space. If I later select Outlook, use account ${ACCOUNT}.` } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.ok(primed.ok);
  if (!primed.ok) throw new Error(primed.reason);
  index.deactivateCapabilityCarrier('composio', 'outlook');
  index.recordCapabilityOperations([{ identifier: operation, carrierKind: 'composio', carrier: 'outlook',
    displayName: 'Read a message', description: 'Read an Outlook message containing HTML content.',
    effectClass: operation === OPERATION ? 'read' : 'write', effectProvenance: 'declared' }]);
  function broker(query = QUERY) {
    let handler!: (input: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    search.registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) {
      handler = callback;
    } } as never, {
      allowedNames: new Set(['space_save']), dispatchCarrier: 'work_call',
      candidateSources: providers.buildAuthorizedToolSearchCandidateSources({ reason: 'page fixture', authority: 'catalog',
        allowedServerSlugs: [], toolPatterns: [], maxTools: 0 } as never, identity)
        .filter((candidate) => candidate.kind === 'authorized_composio'),
      async discloseForPlanning(candidates, control) {
        const staged = await providers.stageDisclosedPlanningProviderCandidates({ ...identity, candidates,
          signal: control?.signal, deadlineAt: control?.deadlineAt, accountSelection: control?.accountSelection });
        const refs = await semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority,
          candidates, signal: control?.signal, deadlineAt: control?.deadlineAt });
        return { version: 1, refs, blockers: staged.blockers };
      },
    });
    return async (cursor?: string, sessionId = identity.sessionId) => {
      const result = await withToolOutputContext({ ...identity, sessionId }, () => handler({
        query, role_key: null, limit: 1, cursor: cursor ?? null,
        account_selection: { toolkit: 'outlook', identity: ACCOUNT, source_quote: `use account ${ACCOUNT}` },
      }));
      return { ...result, body: JSON.parse(result.content[0]!.text) };
    };
  }
  return { broker, counts, identity, replaceAccount: () => {
    currentAccount = 'fixture-replacement-account';
    composio.__test__.setConnectedAccountsLoader(loadAccounts);
  } };
}

test('a native first page performs zero provider preparation; its durable provider cursor reopens and proves only the selected operation', async () => {
  const f = await fixture();
  const first = await f.broker()();
  assert.equal(first.body.results[0].name, 'space_save');
  assert.equal(first.body.results[0].capabilityRef, 'cap:local:space_save:reversible');
  assert.equal(f.counts.exact, 0);
  assert.equal(f.counts.accountReviews, 0);
  assert.ok(first.body.next_cursor);
  const fuzzy = f.counts.fuzzy;
  const foreign = events.createSession({ id: `foreign-page-${serial}`, kind: 'chat', userId: 'different-principal' });
  const denied = await f.broker()(first.body.next_cursor, foreign.id);
  assert.equal(denied.isError, true);
  assert.equal(f.counts.exact, 0, 'another session cannot prepare retained candidates');
  const second = await f.broker()(first.body.next_cursor);
  assert.equal(second.body.results[0].name, OPERATION);
  assert.equal(second.body.results[0].effect, 'read');
  assert.match(second.body.results[0].capabilityRef, /^cap:resolved:outlook_get_message/);
  assert.deepEqual(second.body.schemas[OPERATION], INPUT);
  assert.equal(f.counts.fuzzy, fuzzy, 'reopening a cursor never repeats broad discovery');
  assert.equal(f.counts.exact, 1);
  assert.equal(f.counts.accountReviews, 1);
  const published = catalogs.peekHostCapabilityCatalogFactory()!.get(second.body.results[0].capabilityRef);
  assert.equal(published?.manifest?.accountId, ACCOUNT);
  assert.equal(f.counts.business, 0);
});

test('a provider write card copies the published effect and distinguishes plan input from execution carrier arguments', async () => {
  const operation = 'OUTLOOK_CREATE_DRAFT';
  const f = await fixture(operation);
  const response = await f.broker(operation)();
  const row = response.body.results[0];
  assert.equal(row.name, operation);
  assert.equal(row.effect, 'external_write');
  const entry = catalogs.peekHostCapabilityCatalogFactory()!.get(row.capabilityRef);
  assert.ok(entry && catalogs.isCurrentCallableCatalogEntry(entry));
  assert.equal(row.effect, entry!.manifest!.effect);
  assert.equal(row.invocation.name, 'composio_execute_tool');
  assert.equal(row.invocation.payloadField, 'arguments');
  assert.match(row.planArgumentsHint, /staticArgumentsJson contains only the direct OUTLOOK_CREATE_DRAFT input fields/);
  assert.match(response.body.hint, /For publish_plan, use its exact effect/);
  assert.match(response.body.guidance[operation], /For publish_plan, staticArgumentsJson contains only the direct/);
  assert.equal(f.counts.business, 0);
});

test('an account removed between pages cannot be replaced by the retained cursor or a sole-account default', async () => {
  const f = await fixture();
  const first = await f.broker()();
  f.replaceAccount();
  const second = await f.broker()(first.body.next_cursor);
  assert.equal(second.body.results[0].name, OPERATION);
  assert.equal(second.body.results[0].capabilityRef, undefined);
  assert.equal(second.body.results[0].planningRefStatus, 'account_selection_required');
  assert.equal(f.counts.accountReviews, 0, 'the absent explicitly selected identity fails before semantic default review');
  assert.equal(f.counts.business, 0);
});
