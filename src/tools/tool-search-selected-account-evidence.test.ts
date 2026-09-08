/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/tools/tool-search-selected-account-evidence.test.ts
 *
 * A resolved catalog row must tell the model which one of the user's current
 * accounts backs it. The evidence is read-only and row-local: discovery must
 * neither execute the provider operation nor reveal sibling accounts.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-selected-account-evidence-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.COMPOSIO_BACKEND = 'sdk';
process.env.EMBEDDINGS_DISABLED = 'true';

const composio = await import('../integrations/composio/client.js');
const aliases = await import('../memory/account-alias-store.js');
const providerSources = await import('./tool-search-provider-sources.js');
const toolSearch = await import('./tool-search-tool.js');
const semantic = await import('../runtime/semantic-boundary/admit-and-compile-accepted-source.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifests = await import('../runtime/harness/capability-manifest-store.js');
const production = await import('../runtime/harness/production-capability-adapters.js');
const schemas = await import('./composio-schema-cache.js');
const semanticPorts = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

const OPERATION = 'OUTLOOK_SEARCH_MESSAGES';
const SCORPION_EMAIL = 'operator@scorpion.invalid';
const BREAKTHROUGH_EMAIL = 'operator@breakthrough.invalid';
let businessExecutions = 0;

function installTwoOutlookAccounts(): void {
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('selected-account-evidence-key');
  composio.__test__.setConnectedAccountsLoader(async () => ([
    {
      id: 'ca_scorpion_private_transport',
      status: 'ACTIVE',
      user_id: 'fixture-user',
      toolkit: { slug: 'outlook' },
      data: { user_info: { email: SCORPION_EMAIL } },
    },
    {
      id: 'ca_breakthrough_private_transport',
      status: 'ACTIVE',
      user_id: 'fixture-user',
      toolkit: { slug: 'outlook' },
      data: { user_info: { email: BREAKTHROUGH_EMAIL } },
    },
  ]));
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        const requested = Array.isArray(input.tools) ? input.tools as string[] : [];
        return requested.includes(OPERATION) ? [{
          slug: OPERATION,
          name: 'Search Outlook messages',
          description: 'Search messages in the selected Outlook mailbox.',
          toolkit: { slug: 'outlook' },
          inputParameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
          outputParameters: {
            type: 'object',
            properties: { value: { type: 'array' } },
          },
          version: 'fixture-outlook-search-v1',
        }] : [];
      },
      async execute() {
        businessExecutions += 1;
        throw new Error('catalog-only discovery must never execute Outlook');
      },
    },
  } as never);
  aliases.rememberAccountAlias({
    toolkit: 'outlook',
    label: 'Scorpion',
    email: SCORPION_EMAIL,
    connectionId: 'ca_scorpion_private_transport',
  });
  aliases.rememberAccountAlias({
    toolkit: 'outlook',
    label: 'Breakthrough',
    email: BREAKTHROUGH_EMAIL,
    connectionId: 'ca_breakthrough_private_transport',
  });
}

test.after(() => {
  semanticPorts.installTurnSemanticModelPort(null);
  production.installProductionTransport(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifests.installCapabilityManifestStore(null);
  schemas._setToolSchemaLoaderForTests(null);
  composio.__test__.setConnectedAccountsLoader(null);
  composio.__test__.setComposioApiKeyOverride(null);
  composio.resetComposioClient();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('production staging exposes Scorpion on a resolved catalog-only row without leaking Breakthrough', async () => {
  installTwoOutlookAccounts();
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  production.installProductionTransport(async () => { businessExecutions += 1; throw new Error('no business dispatch'); });
  schemas._setToolSchemaLoaderForTests(async () => ({
    inputParameters: { type: 'object', properties: { query: { type: 'string' } } },
    outputParameters: { type: 'object', properties: { value: { type: 'array' } } },
    providerObservedAt: Date.now(), providerOperationVersion: 'fixture-outlook-search-v1',
  }));
  const prompt = `Using my Scorpion Outlook account, inspect ${OPERATION} and tell me whether it is ready. Do not read any messages.`;
  const session = eventlog.createSession({ id: 'selected-account-evidence', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: prompt },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  semanticPorts.installTurnSemanticModelPort({
    async interpret() { throw new Error('catalog evidence does not author a plan'); },
    async judgeAccountSelection(call) {
      assert.equal(call.acceptedText, prompt);
      assert.equal(call.accountIdentity, SCORPION_EMAIL);
      return { verdict: 'entailed', proposalDigest: call.proposalDigest, modelIdentity: 'fixture-source-account-judge' };
    },
  });
  const accountSelection = { toolkit: 'outlook', identity: SCORPION_EMAIL, source_quote: prompt };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error(primed.reason);

  const sources = providerSources.buildAuthorizedToolSearchCandidateSources({
    reason: 'selected-account evidence fixture',
    authority: 'catalog',
    allowedServerSlugs: [],
    toolPatterns: [],
    maxTools: 0,
  } as never, identity);
  const server = new McpServer({ name: 'selected-account-evidence', version: '1' });
  toolSearch.registerToolSearchTool(server as never, {
    candidateSources: sources,
    dispatchCarrier: 'work_call',
    discloseForPlanning: async (candidates, control) => {
      const staged = await providerSources.stageDisclosedPlanningProviderCandidates({
        ...identity,
        candidates,
        signal: control?.signal,
        deadlineAt: control?.deadlineAt,
        accountSelection,
      });
      const refs = await semantic.disclosePrimaryModelPlanningCapabilities({
        authority: primed.planning.authority,
        candidates,
        signal: control?.signal,
        deadlineAt: control?.deadlineAt,
      });
      return { version: 1 as const, refs, blockers: staged.blockers };
    },
  });
  const handler = (server as never as {
    _registeredTools: Record<string, {
      handler(input: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }>;
    }>;
  })._registeredTools.tool_search.handler;
  const result = await handler({
    query: prompt,
    account_selection: accountSelection,
    role_key: 'clause-0:read',
    limit: 8,
    cursor: null,
  });
  const raw = result.content[0]!.text;
  const body = JSON.parse(raw) as {
    results: Array<{
      name: string;
      capabilityRef?: string;
      planningProvenance?: string;
      selectedAccount?: {
        toolkit: string;
        accountIdentity: string;
        accountIdentityKind: string;
        email?: string;
        label?: string;
      };
    }>;
  };
  const row = body.results.find((candidate) => candidate.name === OPERATION);
  assert.match(row?.capabilityRef ?? '', /^cap:resolved:/, raw);
  assert.equal(row?.planningProvenance, 'authorized_composio');
  assert.deepEqual(row?.selectedAccount, {
    toolkit: 'outlook',
    accountIdentity: SCORPION_EMAIL,
    accountIdentityKind: 'email',
    email: SCORPION_EMAIL,
    label: 'scorpion',
  });
  assert.doesNotMatch(raw, new RegExp(BREAKTHROUGH_EMAIL, 'i'));
  assert.doesNotMatch(raw, /ca_(?:scorpion|breakthrough)_private_transport/i,
    'known email identities suppress raw provider connection ids');
  assert.equal(businessExecutions, 0);
});
