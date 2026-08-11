/**
 * A6 pins: contract-store hygiene — case-twin healing and lastUsedAt recency.
 *
 * Live facts these pin: COMPOSIO_SEARCH_TOOLS and composio_search_tools
 * existed as two on-disk files with identical schemas (raw-identifier digest
 * keying); ToolContract.lastUsedAt was declared, preserved on every merge
 * branch, and NEVER SET by any code path (all 44 live records had none).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'contract-hygiene-test-'));

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  _clearToolContractsForTests,
  loadToolContract,
  saveToolContract,
  saveToolContractExample,
  touchToolContract,
} = await import('./tool-contract-store.js');
const { getCachedToolSchema, _clearToolSchemaCacheForTest } = await import('./composio-schema-cache.js');

test.beforeEach(() => {
  _clearToolContractsForTests();
  _clearToolSchemaCacheForTest();
});

test('case-twin healing: a lowercased slug variant loads the canonical contract', () => {
  saveToolContract({
    identifier: 'COMPOSIO_SEARCH_TOOLS',
    schema: { type: 'object', required: ['queries'], properties: {} },
  });
  const viaTwin = loadToolContract('composio_search_tools');
  assert.ok(viaTwin, 'the lowercase variant must heal to the canonical record');
  assert.equal(viaTwin.identifier, 'COMPOSIO_SEARCH_TOOLS');
});

test('case-sensitive identities never alias: MCP __ names and CLI commands stay distinct', () => {
  saveToolContract({
    identifier: 'DATAFORSEO__SERP_ORGANIC_LIVE_ADVANCED',
    schema: { type: 'object', properties: {} },
  });
  assert.equal(
    loadToolContract('dataforseo__serp_organic_live_advanced'),
    null,
    'external MCP identities are case-sensitive — no twin folding across __ names',
  );
  saveToolContract({ identifier: 'SF DATA QUERY', schema: { type: 'object', properties: {} } });
  assert.equal(loadToolContract('sf data query'), null, 'CLI identities never fold');
});

test('lastUsedAt: touch stamps it; save paths never do', () => {
  saveToolContract({
    identifier: 'OUTLOOK_CREATE_DRAFT',
    schema: { type: 'object', required: ['subject'], properties: {} },
  });
  saveToolContractExample({ identifier: 'OUTLOOK_CREATE_DRAFT', exampleArgs: { subject: 'x' } });
  let record = loadToolContract('OUTLOOK_CREATE_DRAFT');
  assert.ok(record);
  assert.equal(record.lastUsedAt, undefined, 'a write is not a use');

  touchToolContract('OUTLOOK_CREATE_DRAFT');
  record = loadToolContract('OUTLOOK_CREATE_DRAFT');
  assert.ok(record?.lastUsedAt, 'touch must stamp recency');
  assert.ok(Number.isFinite(Date.parse(record.lastUsedAt!)));
});

test('touch through the twin stamps the canonical record, not a new file', () => {
  saveToolContract({
    identifier: 'COMPOSIO_SEARCH_TOOLS',
    schema: { type: 'object', properties: {} },
  });
  touchToolContract('composio_search_tools');
  const canonical = loadToolContract('COMPOSIO_SEARCH_TOOLS');
  assert.ok(canonical?.lastUsedAt, 'twin touch lands on the canonical record');
});

test('CONNECTION pin: the dispatch-path durable promotion stamps recency', () => {
  saveToolContract({
    identifier: 'GOOGLESHEETS_VALUES_UPDATE',
    schema: { type: 'object', required: ['spreadsheet_id'], properties: {} },
  });
  const schema = getCachedToolSchema('GOOGLESHEETS_VALUES_UPDATE');
  assert.ok(schema, 'durable contract promotes into the session cache');
  const record = loadToolContract('GOOGLESHEETS_VALUES_UPDATE');
  assert.ok(
    record?.lastUsedAt,
    'a dispatch-path read is a use — getCachedToolSchema must touch (this is who calls it)',
  );
});

test.after(() => {
  rmSync(process.env.CLEMENTINE_HOME!, { recursive: true, force: true });
});
