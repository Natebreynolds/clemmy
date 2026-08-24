/** Run: node scripts/run-tests-isolated.mjs src/integrations/composio/capability-enumeration.test.ts
 *
 * Connect-time enumeration: connecting a toolkit must make its operations
 * retrievable on the NEXT turn, with no prior use or receipt. The index is
 * advisory at retrieval time: one bounded filtered live search still proves
 * current membership and schema. Disconnecting must remove them.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-capability-enum-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-capability-enum\n', 'utf8');

const { indexComposioToolkit, reconcileComposioCapabilityIndex } = await import('./capability-enumeration.js');
const { searchCapabilityOperations, capabilityIndexStats, indexedCapabilityCarriers } =
  await import('../../memory/capability-index.js');

const OPERATIONS = [
  { slug: 'ACMEADS_LIST_CAMPAIGNS', name: 'List campaigns', description: 'List advertising campaigns and their spend.' },
  { slug: 'ACMEADS_GET_CAMPAIGN_METRICS', name: 'Get campaign metrics', description: 'Fetch impressions, clicks and cost for a campaign.' },
  { slug: 'ACMEADS_UPDATE_CAMPAIGN_BUDGET', name: 'Update campaign budget', description: 'Change the daily budget of a campaign.' },
];

test('connecting a toolkit indexes its operations with an effect class and provenance', async () => {
  const recorded = await indexComposioToolkit({
    slug: 'acmeads',
    accountIdentity: 'ads@example.com',
    listOperations: async () => OPERATIONS,
  });
  assert.equal(recorded, 3);

  // Retrievable immediately — no receipt, no alias, no prior successful call.
  const hits = searchCapabilityOperations('campaign spend');
  assert.ok(hits.length >= 1, 'operations are retrievable on the first turn');
  const metrics = searchCapabilityOperations('campaign metrics impressions')
    .find((hit) => hit.identifier === 'ACMEADS_GET_CAMPAIGN_METRICS');
  assert.ok(metrics, 'the specific operation is findable by its description');
  assert.equal(metrics?.effectClass, 'read', 'a GET is classified read');
  assert.equal(metrics?.accountIdentity, 'ads@example.com', 'the account binding is recorded');

  const update = searchCapabilityOperations('update budget')
    .find((hit) => hit.identifier === 'ACMEADS_UPDATE_CAMPAIGN_BUDGET');
  assert.equal(update?.effectClass, 'write', 'an UPDATE is classified write');
  assert.equal(update?.effectProvenance, 'inferred');
});

test('a read role retrieves only reads from a freshly connected toolkit', () => {
  const reads = searchCapabilityOperations('campaign', { effectClass: 'read' });
  assert.ok(reads.length >= 2);
  assert.ok(reads.every((hit) => hit.effectClass === 'read'));
  assert.ok(!reads.some((hit) => hit.identifier === 'ACMEADS_UPDATE_CAMPAIGN_BUDGET'));
});

test('reconcile enumerates NEW carriers, and known ones only while they are decorative', async () => {
  let calls = 0;
  const enumerate = async ({ slug }: { slug: string }): Promise<number> => {
    calls += 1;
    return slug === 'acmecrm' ? 1 : 0;
  };
  // acmeads is already indexed; acmecrm is new. acmeads has no durable
  // contracts yet, so under CAT-8 it is DECORATIVE — catalogued and unbindable
  // — and is worth one re-enumeration. Re-listing a known carrier forever is
  // pure cost; never re-listing one strands every install that was provisioned
  // before enumeration learned to deposit schemas, which is worse.
  const first = await reconcileComposioCapabilityIndex(
    [{ slug: 'acmeads' }, { slug: 'acmecrm' }],
    { enumerate },
  );
  assert.equal(calls, 2, 'the new carrier and the decorative known one are both enumerated');
  assert.equal(first.indexedCarriers, 1, 'only the one that recorded operations counts as indexed');
});

test('a properly provisioned carrier is never re-enumerated', async () => {
  // The cost-control half of the rule, and the reason the trigger is CAT-8's
  // decorative test rather than a timer: a carrier whose operations mostly
  // resolve is being provisioned correctly, so a re-list would buy nothing.
  const { rememberToolSchema } = await import('../../tools/composio-schema-cache.js');
  const schema = { type: 'object', required: ['query'], properties: { query: { type: 'string' } } };
  // A MAJORITY, deliberately. One contract out of many is the signature of a
  // single past live discovery, not of a provisioned carrier — measured on a
  // real install at 1-of-134, 1-of-127, 1-of-92 — and that case must still
  // backfill rather than be mistaken for healthy.
  rememberToolSchema('ACMEADS_LIST_CAMPAIGNS', schema);
  rememberToolSchema('ACMEADS_GET_CAMPAIGN_METRICS', schema);

  let calls = 0;
  await reconcileComposioCapabilityIndex([{ slug: 'acmeads' }], {
    enumerate: async () => { calls += 1; return 0; },
  });
  assert.equal(calls, 0, 'a carrier with a resolvable contract is left alone');
});

test('disconnecting a toolkit removes its operations from retrieval', async () => {
  const before = capabilityIndexStats().operations;
  assert.ok(before >= 3);
  const result = await reconcileComposioCapabilityIndex([], { enumerate: async () => 0 });
  assert.ok(result.deactivatedCarriers >= 1, 'carriers that went away are deactivated');
  assert.deepEqual(searchCapabilityOperations('campaign spend'), []);
  assert.deepEqual(indexedCapabilityCarriers('composio'), []);
});

test('a provider outage during enumeration leaves the index cold, never throws', async () => {
  const recorded = await indexComposioToolkit({
    slug: 'flakytoolkit',
    listOperations: async () => { throw new Error('provider unavailable'); },
  });
  assert.equal(recorded, 0, 'an outage records nothing');
  assert.deepEqual(searchCapabilityOperations('flaky'), [], 'and retrieval degrades to empty');
});

test('tool_search ranks from the index but requires one bounded live provider search', async () => {
  // The blank-install claim, end to end: connect and index a toolkit, then
  // require the broker source to prove the ranked operation against one
  // bounded provider-owned filtered search before returning it.
  const { buildAuthorizedToolSearchCandidateSources } = await import('../../tools/tool-search-provider-sources.js');
  const composioClient = await import('./client.js');
  await indexComposioToolkit({
    slug: 'acmehelpdesk',
    accountIdentity: 'support@example.com',
    listOperations: async () => [
      { slug: 'ACMEHELPDESK_LIST_TICKETS', name: 'List tickets', description: 'List support tickets by status and assignee.' },
      { slug: 'ACMEHELPDESK_CREATE_TICKET', name: 'Create ticket', description: 'Open a new support ticket.' },
    ],
  });

  composioClient.__test__.setComposioApiKeyOverride('capability-enumeration-key');
  composioClient.__test__.setConnectedAccountsLoader(async () => [{
    id: 'connection-acmehelpdesk',
    status: 'ACTIVE',
    user_id: 'capability-enumeration-user',
    toolkit: { slug: 'acmehelpdesk' },
  }]);
  let liveSearchCalls = 0;
  composioClient.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        liveSearchCalls += 1;
        assert.deepEqual(input, {
          toolkits: ['acmehelpdesk'],
          search: 'support tickets by assignee',
          limit: 16,
        });
        return [{
          slug: 'ACMEHELPDESK_LIST_TICKETS',
          name: 'List tickets',
          description: 'List support tickets by status and assignee.',
          toolkit: { slug: 'acmehelpdesk' },
          inputParameters: {
            type: 'object',
            properties: { assignee: { type: 'string' } },
          },
        }];
      },
    },
  });

  try {
    const sources = buildAuthorizedToolSearchCandidateSources({
      reason: 'test',
      authority: 'catalog',
      allowedServerSlugs: [],
      maxTools: 0,
    } as never);
    const composio = sources.find((source) => source.kind === 'authorized_composio');
    assert.ok(composio, 'the composio broker source exists');

    const found = await composio!.search({ query: 'support tickets by assignee', limit: 5 });
    assert.equal(liveSearchCalls, 1, 'the advisory index cannot suppress bounded live proof');
    assert.equal(found.length, 1);
    const ticketRead = found.find((candidate) => candidate.name === 'ACMEHELPDESK_LIST_TICKETS');
    assert.ok(ticketRead, 'the exact live operation is offered');
    assert.equal(ticketRead?.carrier, 'work_call');
    assert.equal(ticketRead?.invocation?.fixedArgs?.tool_slug, 'ACMEHELPDESK_LIST_TICKETS');
    assert.match(String(ticketRead?.guidance ?? ''), /work_call/);
  } finally {
    composioClient.__test__.setConnectedAccountsLoader(null);
    composioClient.__test__.setComposioApiKeyOverride(null);
    composioClient.resetComposioClient();
  }
});

test('one stray contract does not pass as provisioned', async () => {
  // The failure mode this guards: a carrier at 1-of-134 reports connected,
  // never backfills, and leaves 133 operations permanently unbindable.
  const { rememberToolSchema } = await import('../../tools/composio-schema-cache.js');
  rememberToolSchema('LONELY_ONE', { type: 'object', properties: {} });
  await indexComposioToolkit({
    slug: 'lonely',
    listOperations: async () => [
      { slug: 'LONELY_ONE', name: 'One', description: 'a' },
      { slug: 'LONELY_TWO', name: 'Two', description: 'b' },
      { slug: 'LONELY_THREE', name: 'Three', description: 'c' },
    ],
  });
  let calls = 0;
  await reconcileComposioCapabilityIndex([{ slug: 'lonely' }], {
    enumerate: async () => { calls += 1; return 0; },
  });
  assert.equal(calls, 1, 'a carrier with one contract out of three still backfills');
});
