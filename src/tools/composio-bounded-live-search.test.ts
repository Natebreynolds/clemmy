import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-composio-bounded-search-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.COMPOSIO_BACKEND = 'sdk';

const composio = await import('../integrations/composio/client.js');
const providerSources = await import('./tool-search-provider-sources.js');
const capabilityIndex = await import('../memory/capability-index.js');
const schemaCache = await import('./composio-schema-cache.js');
const { CandidateSourceUnavailableError } = await import('./tool-search-tool.js');

const SOURCE_SCHEMA = {
  type: 'object',
  required: ['location'],
  properties: { location: { type: 'string' } },
};
const DESTINATION_SCHEMA = {
  type: 'object',
  required: ['rows'],
  properties: { rows: { type: 'array' } },
};
const DISTRACTOR_SCHEMA = {
  type: 'object',
  properties: { opaque: { type: 'string' } },
};

after(() => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  composio.__test__.setConnectedAccountsLoader(null);
  composio.__test__.setComposioApiKeyOverride(null);
  composio.resetComposioClient();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('cold Composio discovery uses one bounded SDK search and treats the index as ranking-only', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('bounded-search-key');
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: 'connection-mega',
    status: 'ACTIVE',
    user_id: 'bounded-search-user',
    toolkit: { slug: 'mega' },
  }]);

  const sourceSlug = 'MEGA_ZEPHYRQUARTZ_ARCLIGHT_READ_TAIL';
  const destinationSlug = 'MEGA_ZEPHYRQUARTZ_ARCLIGHT_WRITE_TAIL';
  const poisonSlug = 'MEGA_ZEPHYRQUARTZ_ARCLIGHT_MEMORY_ONLY';
  capabilityIndex.recordCapabilityOperations([{
    identifier: poisonSlug,
    carrierKind: 'composio',
    carrier: 'mega',
    displayName: 'Zephyrquartz arclight memory result',
    description: 'zephyrquartz arclight sentinel',
    effectClass: 'read',
    effectProvenance: 'inferred',
  }]);

  let rawSearchCalls = 0;
  let definitionsLoaded = 0;
  let exactInput: Record<string, unknown> | null = null;
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        rawSearchCalls += 1;
        exactInput = input;
        assert.equal(input.search, 'zephyrquartz arclight sentinel');
        assert.deepEqual(input.toolkits, ['mega']);
        assert.equal(input.limit, 16);
        const rows = [
          ...Array.from({ length: 10 }, (_, index) => ({
            slug: `MEGA_OPAQUE_${index}`,
            name: `Opaque operation ${index}`,
            description: 'unrelated operation',
            toolkit: { slug: 'mega' },
            inputParameters: DISTRACTOR_SCHEMA,
          })),
          {
            slug: sourceSlug,
            name: 'Zephyrquartz arclight source sentinel',
            description: 'Read the zephyrquartz arclight sentinel.',
            toolkit: { slug: 'mega' },
            inputParameters: SOURCE_SCHEMA,
          },
          {
            slug: destinationSlug,
            name: 'Zephyrquartz arclight destination sentinel',
            description: 'Write the zephyrquartz arclight sentinel.',
            toolkit: { slug: 'mega' },
            inputParameters: DESTINATION_SCHEMA,
          },
          // A disconnected hit and duplicate may be returned by a fuzzy
          // provider query; neither can widen the connected result universe.
          {
            slug: 'OTHER_ZEPHYRQUARTZ_ARCLIGHT_SENTINEL',
            name: 'Disconnected result',
            toolkit: { slug: 'other' },
            inputParameters: SOURCE_SCHEMA,
          },
          {
            slug: sourceSlug,
            name: 'Duplicate source',
            toolkit: { slug: 'mega' },
            inputParameters: SOURCE_SCHEMA,
          },
          ...Array.from({ length: 2 }, (_, index) => ({
            slug: `MEGA_OPAQUE_TAIL_${index}`,
            name: `Opaque tail ${index}`,
            description: 'unrelated operation',
            toolkit: { slug: 'mega' },
            inputParameters: DISTRACTOR_SCHEMA,
          })),
        ];
        definitionsLoaded += rows.length;
        return rows;
      },
    },
  });

  const sources = providerSources.buildAuthorizedToolSearchCandidateSources({
    reason: 'bounded live search proof',
    authority: 'catalog',
    allowedServerSlugs: [],
    toolPatterns: [],
    maxTools: 0,
  } as never, { sessionId: 'planning-proof', sourceUserSeq: 1 });
  const source = sources.find((candidate) => candidate.kind === 'authorized_composio');
  assert.ok(source);
  const found = await source!.search({
    query: 'zephyrquartz arclight sentinel',
    limit: 8,
  });

  assert.equal(rawSearchCalls, 1, 'the advisory index cannot suppress or duplicate live search');
  assert.deepEqual(exactInput, {
    toolkits: ['mega'],
    search: 'zephyrquartz arclight sentinel',
    limit: 16,
  });
  assert.equal(definitionsLoaded, 16);
  assert.equal(found.length, 2,
    'a <=16-row provider response containing irrelevant rows is relevance-filtered to the live matches');
  assert.deepEqual(
    found.filter((candidate) => [sourceSlug, destinationSlug].includes(candidate.name))
      .map((candidate) => candidate.name)
      .sort(),
    [destinationSlug, sourceSlug].sort(),
  );
  assert.equal(found.some((candidate) => candidate.name === poisonSlug), false,
    'an index-only identifier never enters the live result universe');
  assert.equal(found.some((candidate) => candidate.name.startsWith('OTHER_')), false,
    'a result outside the connected toolkit set is filtered');
  assert.equal(found.filter((candidate) => candidate.name === sourceSlug).length, 1,
    'provider duplicates are collapsed by exact slug');
  assert.ok(found.every((candidate) => candidate.schema && typeof candidate.schema === 'object'));
  assert.ok(Buffer.byteLength(JSON.stringify(found), 'utf8') < 32 * 1024);
});

test('the broker retains provider rank sixteen despite ten thousand advisory decoys', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('rank-sixteen-key');
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: 'connection-mega-rank-sixteen',
    status: 'ACTIVE',
    user_id: 'rank-sixteen-user',
    toolkit: { slug: 'mega' },
  }]);

  capabilityIndex.recordCapabilityOperations(Array.from({ length: 10_000 }, (_, index) => ({
    identifier: `MEGA_ADVISORY_DECOY_${String(index).padStart(5, '0')}`,
    carrierKind: 'composio' as const,
    carrier: 'mega',
    displayName: `Needle boundary advisory decoy ${index}`,
    description: 'needle boundary provider operation',
    effectClass: 'read' as const,
    effectProvenance: 'inferred' as const,
  })));

  const targetSlug = 'MEGA_NEEDLE_BOUNDARY_REQUIRED_OPERATION';
  const providerRows = [
    ...Array.from({ length: 15 }, (_, index) => ({
      slug: `MEGA_NEEDLE_BOUNDARY_PROVIDER_${String(index + 1).padStart(2, '0')}`,
      name: `Needle boundary provider operation ${index + 1}`,
      description: 'needle boundary provider operation',
      toolkit: { slug: 'mega' },
      inputParameters: DISTRACTOR_SCHEMA,
    })),
    {
      slug: targetSlug,
      name: 'Needle boundary required operation',
      description: 'needle boundary provider operation',
      toolkit: { slug: 'mega' },
      inputParameters: SOURCE_SCHEMA,
    },
  ];
  assert.equal(providerRows[15]?.slug, targetSlug, 'fixture pins the correct operation at provider rank sixteen');

  let providerCalls = 0;
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        providerCalls += 1;
        assert.deepEqual(input, {
          toolkits: ['mega'],
          search: 'needle boundary provider operation',
          limit: 16,
        });
        return providerRows;
      },
    },
  });

  const sources = providerSources.buildAuthorizedToolSearchCandidateSources({
    reason: 'rank sixteen production boundary',
    authority: 'catalog',
    allowedServerSlugs: [],
    toolPatterns: [],
    maxTools: 0,
  } as never);
  const source = sources.find((candidate) => candidate.kind === 'authorized_composio');
  assert.ok(source);
  const found = await source!.search({
    query: 'needle boundary provider operation',
    limit: 20,
  });

  assert.equal(providerCalls, 1, 'ten thousand local hints cannot create a provider rescan');
  assert.equal(found.length, 16, 'the whole bounded provider oversample remains locally pageable');
  assert.ok(found.some((candidate) => candidate.name === targetSlug),
    'the exact live rank-sixteen operation survives the former eight-row cliff');
  assert.equal(found.some((candidate) => candidate.name.startsWith('MEGA_ADVISORY_DECOY_')), false,
    'advisory rows can rank exact live members but never join the result universe');
});

test('a filtered SDK failure never falls back to unfiltered toolkit enumeration', async () => {
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('bounded-search-key');
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: 'connection-mega-failure',
    status: 'ACTIVE',
    user_id: 'bounded-search-user',
    toolkit: { slug: 'mega' },
  }]);
  let calls = 0;
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        calls += 1;
        assert.equal(input.search, 'missing sentinel');
        assert.equal(input.limit, 16);
        throw new Error('filtered provider search unavailable');
      },
    },
  });
  const sources = providerSources.buildAuthorizedToolSearchCandidateSources({
    reason: 'no fallback proof',
    authority: 'catalog',
    allowedServerSlugs: [],
    toolPatterns: [],
    maxTools: 0,
  } as never);
  const source = sources.find((candidate) => candidate.kind === 'authorized_composio');
  // A failed filtered search is a failed discovery attempt, not proof nothing
  // matched. Regression pin (2026-08-26): this used to resolve to [], which
  // read to every caller exactly like "Composio has no such capability" —
  // the same silent-empty class as the search-string-relaxation bug, one
  // layer up. It must now surface as a typed, named unavailability instead
  // of being laundered into an empty result, and it must still never trigger
  // an unfiltered toolkit-list fallback.
  await assert.rejects(
    () => source!.search({ query: 'missing sentinel', limit: 8 }),
    (error: unknown) => {
      assert.ok(error instanceof CandidateSourceUnavailableError);
      assert.equal(error.code, 'search_failed');
      assert.match(error.message, /filtered provider search unavailable/);
      return true;
    },
  );
  assert.equal(calls, 1, 'failure must not trigger a 200/250-definition list fallback');
});

test('no connected toolkits is a typed unavailability, never a silent empty result', async () => {
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('bounded-search-key');
  composio.__test__.setConnectedAccountsLoader(async () => []);
  const sources = providerSources.buildAuthorizedToolSearchCandidateSources({
    reason: 'no connections proof',
    authority: 'catalog',
    allowedServerSlugs: [],
    toolPatterns: [],
    maxTools: 0,
  } as never);
  const source = sources.find((candidate) => candidate.kind === 'authorized_composio');
  // Nothing connected means the search never meaningfully ran, not that the
  // requested capability does not exist — the honest repair is "connect a
  // toolkit", not "guess a reference" or "conclude this cannot be done".
  await assert.rejects(
    () => source!.search({ query: 'anything', limit: 8 }),
    (error: unknown) => {
      assert.ok(error instanceof CandidateSourceUnavailableError);
      assert.equal(error.code, 'no_connections');
      return true;
    },
  );
});

test('Composio not configured for this install is a typed unavailability, never a silent empty result', async () => {
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride(null);
  const sources = providerSources.buildAuthorizedToolSearchCandidateSources({
    reason: 'not configured proof',
    authority: 'catalog',
    allowedServerSlugs: [],
    toolPatterns: [],
    maxTools: 0,
  } as never);
  const source = sources.find((candidate) => candidate.kind === 'authorized_composio');
  await assert.rejects(
    () => source!.search({ query: 'anything', limit: 8 }),
    (error: unknown) => {
      assert.ok(error instanceof CandidateSourceUnavailableError);
      assert.equal(error.code, 'not_configured');
      return true;
    },
  );
});

test('an SDK response above the 16-definition contract is refused, never truncated locally', async () => {
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('bounded-search-key');
  let calls = 0;
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        calls += 1;
        assert.deepEqual(input, {
          toolkits: ['mega'],
          search: 'overflow sentinel',
          limit: 16,
        });
        return Array.from({ length: 17 }, (_, index) => ({
          slug: `MEGA_OVERFLOW_${index}`,
          name: `Overflow ${index}`,
          toolkit: { slug: 'mega' },
          inputParameters: DISTRACTOR_SCHEMA,
        }));
      },
    },
  });

  await assert.rejects(
    () => composio.searchConnectedComposioTools(['mega'], 'overflow sentinel', 16),
    (error: unknown) => {
      assert.ok(error instanceof composio.ComposioSearchProviderContractError);
      assert.equal(error.code, 'composio_search_provider_contract_refused');
      assert.match(error.message, /exceeded the 16-definition provider contract/i);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('selected metadata uses one exact one-row SDK lookup with no toolkit-list fallback', async () => {
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('bounded-search-key');
  let calls = 0;
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        calls += 1;
        assert.deepEqual(input, {
          tools: ['MEGA_SELECTED_EXACT'],
          limit: 1,
        });
        return [{
          slug: 'MEGA_RENAMED_RELATED_RESULT',
          name: 'Renamed related result',
          toolkit: { slug: 'mega' },
          inputParameters: SOURCE_SCHEMA,
        }];
      },
    },
  });

  assert.equal(await composio.getExactComposioToolBySlug('MEGA_SELECTED_EXACT'), null);
  assert.equal(calls, 1, 'a removed/renamed exact slug cannot trigger a 500-row compatibility list');
});

test('selected-definition refresh bypasses a recent discovery schema exactly once', async () => {
  const slug = 'MEGA_SELECTED_EXACT_SCHEMA';
  schemaCache.resetToolSchemaCache();
  schemaCache.rememberToolSchema(slug, SOURCE_SCHEMA, Date.now() - 1_000);
  assert.deepEqual(schemaCache.getCachedToolSchema(slug), SOURCE_SCHEMA);
  let exactReads = 0;
  schemaCache._setToolSchemaLoaderForTests(async (requested) => {
    exactReads += 1;
    assert.equal(requested, slug);
    return { inputParameters: DESTINATION_SCHEMA, providerObservedAt: Date.now() };
  });
  try {
    const refreshed = await schemaCache.refreshExactComposioSchemaFromProvider(slug);
    assert.equal(exactReads, 1,
      'a recent discovery observation cannot suppress the selection-only exact read');
    assert.deepEqual(refreshed?.schema, DESTINATION_SCHEMA);
    assert.match(refreshed?.fingerprint ?? '', /^[a-f0-9]{32}$/);
  } finally {
    schemaCache._setToolSchemaLoaderForTests(null);
    schemaCache.resetToolSchemaCache();
  }
});
