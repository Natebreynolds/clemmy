import { rememberToolSchema, rememberToolSchemas, getCachedToolSchema, resetToolSchemaCache } from './composio-schema-cache.js';

// remember → get round-trip
{
  resetToolSchemaCache();
  const schema = { type: 'object', required: ['spreadsheet_id'], properties: {} };
  rememberToolSchema('GOOGLESHEETS_BATCH_UPDATE_VALUES', schema);
  const got = getCachedToolSchema('GOOGLESHEETS_BATCH_UPDATE_VALUES');
  if (!got || got.required?.toString() !== 'spreadsheet_id') {
    throw new Error('Should return the deposited schema');
  }
}

// unknown slug → null
{
  resetToolSchemaCache();
  if (getCachedToolSchema('NEVER_SEEN_SLUG') !== null) {
    throw new Error('Unknown slug should be a cache miss');
  }
}

// non-object schemas are ignored (cache can only ever make validation
// MORE precise — junk must not poison it)
{
  resetToolSchemaCache();
  rememberToolSchema('JUNK_SLUG', null);
  rememberToolSchema('JUNK_SLUG', 'not a schema');
  rememberToolSchema('JUNK_SLUG', [1, 2, 3]);
  rememberToolSchema('', { type: 'object' });
  if (getCachedToolSchema('JUNK_SLUG') !== null) {
    throw new Error('Non-object schemas must be ignored');
  }
}

// batch helper deposits every valid item
{
  resetToolSchemaCache();
  rememberToolSchemas([
    { slug: 'A_TOOL', inputParameters: { type: 'object', required: ['x'] } },
    { slug: 'B_TOOL', inputParameters: undefined },
    { slug: undefined, inputParameters: { type: 'object' } },
  ]);
  if (!getCachedToolSchema('A_TOOL')) throw new Error('Batch helper should deposit A_TOOL');
  if (getCachedToolSchema('B_TOOL') !== null) throw new Error('Missing inputParameters should be skipped');
}

// newest write wins (a refreshed schema replaces the stale one)
{
  resetToolSchemaCache();
  rememberToolSchema('S', { type: 'object', required: ['old'] });
  rememberToolSchema('S', { type: 'object', required: ['new'] });
  const got = getCachedToolSchema('S');
  if (!got || got.required?.toString() !== 'new') {
    throw new Error('Refreshed schema should replace the previous one');
  }
}

// size cap holds (oldest evicted, hot entries survive via re-insertion)
{
  resetToolSchemaCache();
  for (let i = 0; i < 520; i++) {
    rememberToolSchema(`SLUG_${i}`, { type: 'object', idx: i });
  }
  if (getCachedToolSchema('SLUG_0') !== null) {
    throw new Error('Oldest entry should have been evicted past the cap');
  }
  if (!getCachedToolSchema('SLUG_519')) {
    throw new Error('Newest entry must survive the cap');
  }
}

resetToolSchemaCache();
// ── Schema-FIRST dispatch (live 2026-08-07 scrape) ──
// APIFY_RUN_ACTOR had no cached schema, so a call with no `actorId` fell to
// heuristic validation, reached the provider, and came back as a paid 400 —
// twice. ensureToolSchema loads the real contract once per session so the
// same mistake is refused locally, naming the missing field.
{
  const {
    ensureToolSchema, _setToolSchemaLoaderForTests,
  } = await import('./composio-schema-cache.js');
  const { validateComposioArgs } = await import('./composio-batch-validator.js');

  resetToolSchemaCache();
  let loads = 0;
  _setToolSchemaLoaderForTests(async (slug: string) => {
    loads += 1;
    return slug === 'APIFY_RUN_ACTOR'
      ? { inputParameters: { type: 'object', required: ['actorId'], properties: { actorId: { type: 'string' } } } }
      : null;
  });

  const contract = await ensureToolSchema('APIFY_RUN_ACTOR');
  if (!contract || String(contract.required) !== 'actorId') throw new Error('should load the real contract on first use');
  if (loads !== 1) throw new Error('first use loads exactly once');

  await ensureToolSchema('APIFY_RUN_ACTOR');
  if (loads !== 1) throw new Error('a cached contract must never refetch');
  if (!getCachedToolSchema('APIFY_RUN_ACTOR')) throw new Error('the sync reader sees the loaded contract');

  // An undescribable slug is attempted once, not per dispatch.
  if (await ensureToolSchema('UNKNOWABLE_SLUG') !== null) throw new Error('unknown slug yields null');
  if (await ensureToolSchema('UNKNOWABLE_SLUG') !== null) throw new Error('unknown slug still null');
  if (loads !== 2) throw new Error('no repeated fetches for an undescribable slug');

  // The live failure is now a LOCAL refusal naming the field.
  const missing = validateComposioArgs('APIFY_RUN_ACTOR', { input: { q: 'x' } }, contract);
  if (missing.mode !== 'schema') throw new Error('validated against the real contract');
  if (!missing.error || !/actorId/.test(String(missing.error.field))) throw new Error('missing actorId must be caught pre-dispatch');
  const complete = validateComposioArgs('APIFY_RUN_ACTOR', { actorId: 'a~b', input: {} }, contract);
  if (complete.error) throw new Error('a complete payload still passes');

  // Loader failure is fail-open: no throw, previous behavior preserved.
  _setToolSchemaLoaderForTests(async () => { throw new Error('composio down'); });
  if (await ensureToolSchema('SOME_OTHER_SLUG') !== null) throw new Error('loader failure yields null, never a throw');
  _setToolSchemaLoaderForTests(null);
  resetToolSchemaCache();
}

console.log('composio-schema-cache tests passed');
