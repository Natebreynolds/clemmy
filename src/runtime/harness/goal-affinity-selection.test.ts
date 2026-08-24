/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/goal-affinity-selection.test.ts
 *
 * LIVE 59796 REPLAY (2026-08-19 16:57, sess-synthetic-007, claude-sonnet-5 brain):
 * "Find me the top 5 big bear lake restaurants based on Google reviews add
 * them to a Google sheet with the data". The admission catalog's structural
 * probes selected APIFY_GET_LIST_OF_BUILDS as the goal search (name-regex hit
 * on LIST, one fillable required string, alphabetical tie-break over
 * FIRECRAWL_SEARCH) and OUTLOOK_CREATE_CONTACT as the row create (ZERO
 * required fields; an optional `categories` array satisfied the loose rows
 * probe). Semantics received a poisoned candidate list, the proposal
 * validated invalid, and the turn fell to the legacy lane.
 *
 * Schemas below are copied from the live contract store verbatim. The pins:
 *   - goal affinity: the objective's own words outrank fillable impostors —
 *     FIRECRAWL_SEARCH and GOOGLESHEETS_SHEET_FROM_JSON win;
 *   - a construct-create must REQUIRE the collection: a tool whose only
 *     array member is optional is never a row create;
 *   - no goal words in the objective at all → affinity is neutral and the
 *     structural ranks still pick the genuine search name.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-goal-affinity-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-goal-affinity\n', 'utf8');

const { installConnectedRegistryPort, selectGoalCatalog } = await import('./connected-goal-catalog.js');

const LIVE_TEXT = 'Find me the top 5 big bear lake restaurants based on Google reviews add them to a Google sheet with the data';

// Live contract-store schemas, verbatim.
const APIFY_GET_LIST_OF_BUILDS = {
  type: 'object',
  required: ['actorId'],
  properties: {
    desc: { type: 'boolean' }, limit: { type: 'integer' }, offset: { type: 'integer' },
    status: { type: 'string' }, actorId: { type: 'string' }, unnamed: { type: 'boolean' },
    waitForFinish: { type: 'integer' },
  },
};
const OUTLOOK_CREATE_CONTACT = {
  type: 'object',
  properties: {
    notes: { type: 'string' }, userId: { type: 'string' }, surname: { type: 'string' },
    birthday: { type: 'string' }, jobTitle: { type: 'string' }, givenName: { type: 'string' },
    homePhone: { type: 'string' }, categories: { type: 'array' }, department: { type: 'string' },
    companyName: { type: 'string' }, displayName: { type: 'string' }, mobilePhone: { type: 'string' },
    businessPhones: { type: 'array' }, emailAddresses: { type: 'array' }, officeLocation: { type: 'string' },
  },
};
const FIRECRAWL_SEARCH = {
  type: 'object',
  required: ['q'],
  properties: {
    q: { type: 'string' }, lang: { type: 'string' }, limit: { type: 'integer' },
    country: { type: 'string' }, formats: { type: 'array' }, timeout: { type: 'integer' },
  },
};
const GOOGLESHEETS_SHEET_FROM_JSON = {
  type: 'object',
  required: ['title', 'sheet_name', 'sheet_json'],
  properties: { title: { type: 'string' }, sheet_name: { type: 'string' }, sheet_json: { type: 'array' } },
};
const GOOGLESHEETS_BATCH_GET = {
  type: 'object',
  required: ['spreadsheet_id'],
  properties: { spreadsheet_id: { type: 'string' }, ranges: { type: 'array' } },
};

const LIVE_REGISTRY = {
  connectedToolkits: ['apify', 'outlook', 'firecrawl', 'googlesheets'],
  tools: [
    { slug: 'APIFY_GET_LIST_OF_BUILDS', schema: APIFY_GET_LIST_OF_BUILDS },
    { slug: 'OUTLOOK_CREATE_CONTACT', schema: OUTLOOK_CREATE_CONTACT },
    { slug: 'FIRECRAWL_SEARCH', schema: FIRECRAWL_SEARCH },
    { slug: 'GOOGLESHEETS_SHEET_FROM_JSON', schema: GOOGLESHEETS_SHEET_FROM_JSON },
    { slug: 'GOOGLESHEETS_BATCH_GET', schema: GOOGLESHEETS_BATCH_GET },
  ],
};

test('59796 REPLAY: goal words outrank fillable impostors — search is a search, create is the sheet', () => {
  installConnectedRegistryPort(() => LIVE_REGISTRY);
  try {
    const selection = selectGoalCatalog(LIVE_TEXT);
    assert.deepEqual(selection.gaps, []);
    const bySlot = Object.fromEntries(selection.entries.map((entry) => [entry.intent.split(':')[0], entry.identifier]));
    assert.equal(bySlot['goal search'], 'FIRECRAWL_SEARCH', 'the live impostor APIFY_GET_LIST_OF_BUILDS must not win the search slot');
    assert.equal(bySlot['goal construct'], 'GOOGLESHEETS_SHEET_FROM_JSON', 'the live impostor OUTLOOK_CREATE_CONTACT must not win the create slot');
    assert.equal(bySlot['goal readback'], 'GOOGLESHEETS_BATCH_GET');
  } finally {
    installConnectedRegistryPort(null);
  }
});

test('a create whose only array member is OPTIONAL is never a row create', () => {
  installConnectedRegistryPort(() => ({
    connectedToolkits: ['outlook', 'firecrawl'],
    tools: [
      { slug: 'OUTLOOK_CREATE_CONTACT', schema: OUTLOOK_CREATE_CONTACT },
      { slug: 'FIRECRAWL_SEARCH', schema: FIRECRAWL_SEARCH },
    ],
  }));
  try {
    const selection = selectGoalCatalog(LIVE_TEXT);
    assert.ok(selection.gaps.includes('row_create'), 'without a required-collection contract there is NO row create — an honest family gap, not a contact-create');
    assert.ok(!selection.entries.some((entry) => entry.identifier === 'OUTLOOK_CREATE_CONTACT'));
  } finally {
    installConnectedRegistryPort(null);
  }
});

test('objective without provider words: affinity stays neutral and the genuine search name still wins', () => {
  installConnectedRegistryPort(() => ({
    connectedToolkits: ['apify', 'firecrawl', 'googlesheets'],
    tools: [
      { slug: 'APIFY_GET_LIST_OF_BUILDS', schema: APIFY_GET_LIST_OF_BUILDS },
      { slug: 'FIRECRAWL_SEARCH', schema: FIRECRAWL_SEARCH },
      { slug: 'GOOGLESHEETS_SHEET_FROM_JSON', schema: GOOGLESHEETS_SHEET_FROM_JSON },
      { slug: 'GOOGLESHEETS_BATCH_GET', schema: GOOGLESHEETS_BATCH_GET },
    ],
  }));
  try {
    const selection = selectGoalCatalog('collect the eight best coffee roasters in Austin and put them in a spreadsheet');
    const search = selection.entries.find((entry) => entry.intent.startsWith('goal search'));
    assert.equal(search?.identifier, 'FIRECRAWL_SEARCH', 'both slugs are foreign to the objective — the impostor must not win on a tie-break');
  } finally {
    installConnectedRegistryPort(null);
  }
});
