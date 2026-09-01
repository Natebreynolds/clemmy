/**
 * Run: npx tsx --test src/integrations/composio/provider-keyword-relaxation.test.ts
 *
 * A connected carrier must never answer an ordinary request with silence.
 *
 * Measured live 2026-08-26 against the real account (19 connected toolkits,
 * Google Sheets among them, every manifest installed and 'current'): the
 * provider's `search` filter is a KEYWORD match that narrows as terms are
 * added, not a semantic one. The role text the model actually sends —
 * "create a Google Sheet and write a header row" — returned ZERO rows, while
 * "sheet header" returned three and one salient term returned the full page.
 *
 * Discovery handed that English sentence straight to the filter, so a request
 * phrased as a sentence discovered nothing, disclosed nothing, and was refused
 * ten times over as "cites a capability that was not disclosed to this source"
 * — with the toolkit connected the entire time. The user's standard is the
 * pin: a reasonable ask must not fail when the tools are attached.
 *
 * These pins hold the ladder at the provider seam. Nothing here names a real
 * provider, toolkit, or operation: the fake carrier below matches terms the
 * way the live one was measured to, so the contract is about ASKING WELL, not
 * about anyone's catalog.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-keyword-relaxation-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.COMPOSIO_BACKEND = 'sdk';

const composio = await import('./client.js');
const composioBroker = await import('../../tools/composio-tools.js');
const providerSources = await import('../../tools/tool-search-provider-sources.js');
const toolSearch = await import('../../tools/tool-search-tool.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

const TOOLKIT = 'quarrystone';
const TARGET = 'QUARRYSTONE_LEDGER_APPEND_HEADER_ROW';
const SCHEMA = { type: 'object', properties: { value: { type: 'string' } } };

/** The operation the request is actually about, plus enough same-carrier
 * neighbours that one broad term fills the provider's whole bounded page. */
const CATALOG = [
  { slug: TARGET, name: 'Append header row', description: 'Append a header row to a ledger' },
  { slug: 'QUARRYSTONE_LEDGER_CREATE', name: 'Create ledger', description: 'Create a new ledger' },
  ...Array.from({ length: 20 }, (_, index) => ({
    slug: `QUARRYSTONE_LEDGER_UNRELATED_${index}`,
    name: `Unrelated ledger operation ${index}`,
    description: 'An unrelated ledger operation',
  })),
].map((row) => ({ ...row, toolkit: { slug: TOOLKIT }, inputParameters: SCHEMA }));

let searches: (string | undefined)[] = [];

/** Mirrors the measured provider: every term must appear, so each added term
 * narrows the match and a full sentence matches nothing. */
function installCarrier(): void {
  searches = [];
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('relaxation-key');
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        const search = input.search as string | undefined;
        searches.push(search);
        const terms = (search ?? '').toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
        return CATALOG
          .filter((row) => {
            const haystack = `${row.slug} ${row.name} ${row.description}`.toLowerCase();
            return terms.every((term) => haystack.includes(term));
          })
          .slice(0, 16);
      },
    },
  } as never);
}

after(() => {
  composio.__test__.setComposioClient(null as never);
  composio.__test__.setComposioApiKeyOverride(null);
  composio.resetComposioClient();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('a role phrased as a sentence still finds the operation it is about', async () => {
  installCarrier();
  const found = await composio.searchConnectedComposioTools(
    [TOOLKIT],
    'create a quarrystone ledger and append a header row for me',
    16,
  );
  assert.ok(found.length > 0,
    'a connected carrier answered an ordinary request with silence — this is the live defect');
  assert.ok(found.some((tool) => tool.slug === TARGET),
    `the operation the request was about must be discoverable; got ${found.map((t) => t.slug).join(', ')}`);
  assert.ok(searches.length > 1,
    'the exact sentence matched nothing, so discovery must relax and ask again rather than give up');
});

test('every returned row came from a real provider response', async () => {
  installCarrier();
  const found = await composio.searchConnectedComposioTools(
    [TOOLKIT], 'create a quarrystone ledger and append a header row for me', 16);
  const known = new Set(CATALOG.map((row) => row.slug));
  for (const tool of found) {
    assert.ok(known.has(tool.slug),
      'relaxation widens the QUESTION asked of the provider, never the authority granted');
  }
});

test('relevance owns the bounded window, not arrival order', async () => {
  installCarrier();
  const found = await composio.searchConnectedComposioTools(
    [TOOLKIT], 'append a header row to the quarrystone ledger', 16);
  const rank = found.findIndex((tool) => tool.slug === TARGET);
  assert.ok(rank >= 0 && rank < 5,
    `a broad sibling term must not spend the window before the requested operation enters it (rank=${rank})`);
});

test('a request that matches no term still reaches what the connection granted', async () => {
  installCarrier();
  const found = await composio.searchConnectedComposioTools(
    [TOOLKIT], 'zzzz unmatchable phrasing nobody indexed', 16);
  assert.ok(found.length > 0,
    'connecting a carrier grants its catalog; an unresolved role may never be answered with nothing');
});

test('a request the provider answers first time costs exactly one search', async () => {
  installCarrier();
  const found = await composio.searchConnectedComposioTools([TOOLKIT], 'ledger', 16);
  assert.ok(found.length > 0);
  assert.equal(searches.length, 1,
    'relaxation is paid only on a miss; the hit path keeps its single bounded search');
});

test('exact recent-news role promotes a provider-named current successor over a deprecated bounded hit', async () => {
  const deprecated = {
    slug: 'FIRECRAWL_DEEP_RESEARCH',
    name: 'Perform deep research',
    description: 'Initiates an AI-powered deep research operation across multiple web sources. Note: This API is in Alpha and being deprecated after June 30, 2025; prefer FIRECRAWL_SEARCH + FIRECRAWL_EXTRACT or COMPOSIO_SEARCH_WEB for durable workflows. It is slower and more resource-intensive than FIRECRAWL_SEARCH.',
    toolkit: { slug: 'firecrawl' },
    inputParameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    version: '20260826_00',
  };
  const current = {
    slug: 'FIRECRAWL_SEARCH',
    name: 'Search',
    description: 'Performs a web search for a query, scrapes content from the top search results using Firecrawl, and returns details in specified formats.',
    toolkit: { slug: 'firecrawl' },
    inputParameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: "The search query to execute. Can be provided as 'query' or 'q'." },
        limit: { type: 'integer' },
        formats: { type: 'array' },
      },
      required: ['q'],
    },
    version: '20260826_00',
  };
  const distractors = Array.from({ length: 15 }, (_, index) => ({
    slug: `FIRECRAWL_DISTRACTOR_${index}`,
    name: `Unrelated operation ${index}`,
    description: 'An unrelated provider operation.',
    toolkit: { slug: 'firecrawl' },
    inputParameters: SCHEMA,
    version: '20260826_00',
  }));
  const observed: Array<Record<string, unknown>> = [];
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('northstar-live-shape-key');
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        observed.push(input);
        const exact = (input.tools as string[] | undefined)?.[0];
        if (exact === current.slug) return [current];
        if (exact) return [];
        return [deprecated, ...distractors];
      },
    },
  } as never);

  const role = 'search current web news about local LLM processing with dated source records';
  const found = await composio.searchConnectedComposioTools(['firecrawl'], role, 16);
  assert.equal(found[0]?.slug, current.slug,
    'the provider-named current search must be inside the bounded card and rank before unrelated rows');
  assert.equal(found.some((tool) => tool.slug === deprecated.slug), false,
    'a deprecated action is not offered when its exact schema-backed successor is live');
  assert.ok(observed.some((input) =>
    Array.isArray(input.tools)
    && input.tools.includes(current.slug)
    && input.tools.length <= 4
    && input.limit === input.tools.length),
  'successor authority must come from an exact provider lookup, not parsed prose');
  assert.equal(found[0]?.version, '20260826_00');
  assert.deepEqual((found[0]?.inputParameters as { required?: string[] }).required, ['q']);
});

test('the production broker keeps current web search inside the exact long-role card', async () => {
  const role = 'search current web news about local LLM processing with dated source records';
  const deprecated = {
    slug: 'FIRECRAWL_DEEP_RESEARCH',
    name: 'Perform deep research',
    description: 'Initiates AI-powered research across multiple sources. This API is being deprecated; prefer FIRECRAWL_SEARCH + FIRECRAWL_EXTRACT for durable workflows. It is slower and more resource-intensive than FIRECRAWL_SEARCH.',
    toolkit: { slug: 'firecrawl' },
    inputParameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    version: '20260826_00',
  };
  const current = {
    slug: 'FIRECRAWL_SEARCH',
    name: 'Search',
    description: 'Performs a web search for a query, scrapes content from the top search results using Firecrawl, and returns details in specified formats.',
    toolkit: { slug: 'firecrawl' },
    inputParameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: "The search query to execute. Can be provided as 'query' or 'q'." },
        limit: { type: 'integer' },
        formats: { type: 'array' },
      },
      required: ['q'],
    },
    version: '20260826_00',
  };
  const distractors = Array.from({ length: 15 }, (_, index) => ({
    slug: `DATAFORSEO_LOCAL_LLM_DISTRACTOR_${index}`,
    name: `Local LLM processing record ${index}`,
    description: 'A current local LLM processing record unrelated to web news search.',
    toolkit: { slug: 'dataforseo' },
    inputParameters: SCHEMA,
    version: '20260826_00',
  }));
  let fuzzyCalls = 0;
  let exactCalls = 0;
  let exactRequested: string[] = [];
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('northstar-broker-key');
  composio.__test__.setConnectedAccountsLoader(async () => [
    {
      id: 'connection-firecrawl',
      status: 'ACTIVE',
      user_id: 'northstar-user',
      toolkit: { slug: 'firecrawl' },
    },
    {
      id: 'connection-dataforseo',
      status: 'ACTIVE',
      user_id: 'northstar-user',
      toolkit: { slug: 'dataforseo' },
    },
  ]);
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        if (Array.isArray(input.tools)) {
          exactCalls += 1;
          exactRequested = [...input.tools];
          return input.tools.includes(current.slug) ? [current] : [];
        }
        fuzzyCalls += 1;
        assert.equal(input.search, role);
        return [deprecated, ...distractors];
      },
    },
  } as never);

  const found = await composioBroker.searchComposioBrokerCandidates(role, 8);
  assert.equal(found[0]?.slug, current.slug,
    'a verified current lifecycle successor must survive broker lexical re-ranking');
  assert.equal(found.some((candidate) => candidate.slug === deprecated.slug), false);
  assert.equal(fuzzyCalls, 1, 'the provider-facing natural-role search remains one bounded call');
  assert.equal(exactCalls, 1, 'lifecycle successors are hydrated in one bounded exact batch');
  assert.ok(exactRequested.length <= 4);
  assert.ok(exactRequested.includes(current.slug));
  assert.deepEqual((found[0]?.inputParameters as { required?: string[] }).required, ['q']);
});

test('the production planning tool_search card resolves the exact long role to current web search', async () => {
  const role = 'search current web news about local LLM processing with dated source records';
  const deprecated = {
    slug: 'FIRECRAWL_DEEP_RESEARCH',
    name: 'Perform deep research',
    description: 'This API is deprecated; prefer FIRECRAWL_SEARCH + FIRECRAWL_EXTRACT for durable workflows.',
    toolkit: { slug: 'firecrawl' },
    inputParameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  };
  const current = {
    slug: 'FIRECRAWL_SEARCH',
    name: 'Search',
    description: 'Performs a web search and returns scraped current source records.',
    toolkit: { slug: 'firecrawl' },
    inputParameters: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        limit: { type: 'integer' },
        formats: { type: 'array' },
      },
      required: ['q'],
    },
    version: '20260826_00',
  };
  const distractors = Array.from({ length: 15 }, (_, index) => ({
    slug: `DATAFORSEO_LOCAL_LLM_DISTRACTOR_${index}`,
    name: `Local LLM processing record ${index}`,
    description: 'A current local LLM processing record unrelated to web news search.',
    toolkit: { slug: 'dataforseo' },
    inputParameters: SCHEMA,
  }));
  let fuzzyCalls = 0;
  let exactCalls = 0;
  let exactRequested: string[] = [];
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('northstar-tool-search-key');
  composio.__test__.setConnectedAccountsLoader(async () => [
    {
      id: 'connection-firecrawl',
      status: 'ACTIVE',
      user_id: 'northstar-user',
      toolkit: { slug: 'firecrawl' },
    },
    {
      id: 'connection-dataforseo',
      status: 'ACTIVE',
      user_id: 'northstar-user',
      toolkit: { slug: 'dataforseo' },
    },
  ]);
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        if (Array.isArray(input.tools)) {
          exactCalls += 1;
          exactRequested = [...input.tools];
          return input.tools.includes(current.slug) ? [current] : [];
        }
        fuzzyCalls += 1;
        assert.equal(input.search, role);
        return [deprecated, ...distractors];
      },
    },
  } as never);

  const server = new McpServer({ name: 'northstar-production-search', version: '1' });
  toolSearch.registerToolSearchTool(server as never, {
    candidateSources: providerSources.buildAuthorizedToolSearchCandidateSources({
      reason: 'northstar production planning regression',
      authority: 'catalog',
      allowedServerSlugs: [],
      maxTools: 0,
    } as never),
    dispatchCarrier: 'work_call',
    // The production planning lane supplies this callback. Its presence owns
    // the provider-vs-local rank tier; this fixture stops before minting refs.
    discloseForPlanning: async () => ({ version: 1, refs: {}, blockers: {} }),
  });
  const handler = (server as never as {
    _registeredTools: Record<string, {
      handler(input: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }>;
    }>;
  })._registeredTools.tool_search.handler;
  const reply = await handler({ query: role, role_key: null, limit: 8, cursor: null });
  const result = JSON.parse(reply.content[0]!.text) as {
    results?: Array<{ name?: string }>;
    schemas?: Record<string, { required?: string[] }>;
  };
  const names = (result.results ?? []).map((row) => row.name);
  assert.equal(names[0], current.slug,
    'the exact natural role must put current web search in the first bounded planning card');
  assert.equal(names.includes(deprecated.slug), false);
  assert.deepEqual(result.schemas?.[current.slug]?.required, ['q']);
  assert.equal(fuzzyCalls, 1, 'planning discovery pays one bounded fuzzy provider call');
  assert.equal(exactCalls, 1, 'all lifecycle validation shares one exact provider call');
  assert.ok(exactRequested.length <= 4);
  assert.ok(exactRequested.includes(current.slug));
});

const LIFECYCLE_SCHEMA = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
};

function lifecycleRow(
  slug: string,
  description: string,
  toolkit = 'firecrawl',
  inputParameters: unknown | null = LIFECYCLE_SCHEMA,
): Record<string, unknown> {
  return {
    slug,
    name: slug,
    description,
    toolkit: { slug: toolkit },
    ...(inputParameters === null ? {} : { inputParameters }),
    version: '20260826_00',
  };
}

test('an unverified prose successor grants nothing and leaves the deprecated fallback visible', async () => {
  const deprecated = lifecycleRow(
    'FIRECRAWL_DEPRECATED_SEARCH',
    'This action is deprecated; prefer FIRECRAWL_CURRENT_SEARCH for durable workflows.',
  );
  const exactRequests: string[] = [];
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('lifecycle-adversarial-key');
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        const exact = input.tools as string[] | undefined;
        if (exact) {
          exactRequests.push(...exact);
          return [];
        }
        return [deprecated];
      },
    },
  } as never);

  const found = await composio.searchConnectedComposioTools(['firecrawl'], 'web search', 16);
  assert.deepEqual(exactRequests, ['FIRECRAWL_CURRENT_SEARCH']);
  assert.deepEqual(found.map((tool) => tool.slug), ['FIRECRAWL_DEPRECATED_SEARCH']);
});

test('deprecated prose cannot promote a successor from another connected toolkit', async () => {
  const deprecated = lifecycleRow(
    'FIRECRAWL_DEPRECATED_SEARCH',
    'This action is deprecated; prefer OUTBOUND_SEND_CAMPAIGN instead.',
  );
  const exactRequests: string[] = [];
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('lifecycle-cross-toolkit-key');
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        const exact = input.tools as string[] | undefined;
        if (exact) {
          exactRequests.push(...exact);
          return exact.map((slug) => lifecycleRow(slug, 'A write action.', 'outbound'));
        }
        return [deprecated];
      },
    },
  } as never);

  const found = await composio.searchConnectedComposioTools(
    ['firecrawl', 'outbound'],
    'web search',
    16,
  );
  assert.deepEqual(exactRequests, [], 'cross-toolkit lifecycle prose must not trigger even an exact lookup');
  assert.deepEqual(found.map((tool) => tool.slug), ['FIRECRAWL_DEPRECATED_SEARCH']);
});

test('an exact successor without an input schema is rejected and the deprecated fallback remains', async () => {
  const deprecated = lifecycleRow(
    'FIRECRAWL_DEPRECATED_SEARCH',
    'This action is deprecated; prefer FIRECRAWL_CURRENT_SEARCH instead.',
  );
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('lifecycle-schema-key');
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        const exact = input.tools as string[] | undefined;
        if (exact) return exact.map((slug) => lifecycleRow(slug, 'Current action.', 'firecrawl', null));
        return [deprecated];
      },
    },
  } as never);

  const found = await composio.searchConnectedComposioTools(['firecrawl'], 'web search', 16);
  assert.deepEqual(found.map((tool) => tool.slug), ['FIRECRAWL_DEPRECATED_SEARCH']);
});

test('an exact lookup returning a different slug cannot satisfy lifecycle authority', async () => {
  const deprecated = lifecycleRow(
    'FIRECRAWL_DEPRECATED_SEARCH',
    'This action is deprecated; prefer FIRECRAWL_CURRENT_SEARCH instead.',
  );
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('lifecycle-identity-key');
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        if (Array.isArray(input.tools)) {
          return [lifecycleRow('FIRECRAWL_RENAMED_SEARCH', 'A different provider row.')];
        }
        return [deprecated];
      },
    },
  } as never);

  const found = await composio.searchConnectedComposioTools(['firecrawl'], 'web search', 16);
  assert.deepEqual(found.map((tool) => tool.slug), ['FIRECRAWL_DEPRECATED_SEARCH']);
  assert.equal(found.some((tool) => tool.slug === 'FIRECRAWL_RENAMED_SEARCH'), false);
});

test('lifecycle hydration is bounded to four exact same-toolkit successors', async () => {
  const successors = Array.from({ length: 5 }, (_, index) => `FIRECRAWL_CURRENT_${index + 1}`);
  const deprecated = lifecycleRow(
    'FIRECRAWL_DEPRECATED_SEARCH',
    `This action is deprecated; prefer ${successors.join(' + ')} + OUTBOUND_CURRENT_1 for durable workflows.`,
  );
  const exactRequests: string[] = [];
  let exactCallCount = 0;
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('lifecycle-bound-key');
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        const exact = input.tools as string[] | undefined;
        if (exact) {
          exactCallCount += 1;
          exactRequests.push(...exact);
          return exact.map((slug) => lifecycleRow(slug, 'Current schema-backed action.'));
        }
        return [deprecated];
      },
    },
  } as never);

  const found = await composio.searchConnectedComposioTools(
    ['firecrawl', 'outbound'],
    'web search',
    16,
  );
  assert.equal(exactCallCount, 1, 'all lifecycle candidates share one exact provider batch');
  assert.deepEqual(exactRequests, successors.slice(0, 4));
  assert.equal(exactRequests.includes(successors[4]), false);
  assert.equal(exactRequests.includes('OUTBOUND_CURRENT_1'), false);
  assert.equal(found.some((tool) => tool.slug === 'FIRECRAWL_DEPRECATED_SEARCH'), false);
});
