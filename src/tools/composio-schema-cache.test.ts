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
console.log('composio-schema-cache tests passed');
