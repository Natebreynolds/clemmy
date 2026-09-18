/**
 * STEP 2, site 2 of docs/SPELLING-IS-NOT-IDENTITY-PLAN-2026-09-18.md.
 *
 * `classifyDiscoveryCall` decides whether a tool_search is an EXACT lookup or a
 * BROAD exploration. A task gets one broad exploration; spending it on a lookup
 * that explored nothing is the cost this classification exists to prevent — the
 * comment in `exactToolIdentifierQuery` says so, for `__`-namespaced names.
 *
 * It recognised an operation named inside prose only when the name was
 * MCP-namespaced. A query naming a reviewed CLI read or a provider operation in
 * a sentence fell through to broad_discovery.
 *
 * Live 2026-09-18: a workflow step searched
 *   "Run authenticated local Salesforce sf CLI SOQL query using
 *    salesforce_sf_soql_query; inspect object mappings and query records"
 * and the boundary recorded `category: "broad_discovery"` — for a query that
 * names its operation outright.
 *
 * Identity now answers it, so every carrier is covered rather than the one
 * whose spelling happened to be anticipated.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/discovery-boundary-named-operation.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-discovery-boundary-identity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-discovery-boundary-identity\n', 'utf8');

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { classifyDiscoveryCall } = await import('./discovery-boundary.js');

/** The query the owner's Friday step actually sent, verbatim from the run. */
const LIVE_QUERY = 'Run authenticated local Salesforce sf CLI SOQL query using salesforce_sf_soql_query; inspect object mappings and query Salesforce records';

const classify = (query: string) => classifyDiscoveryCall('tool_search', { query });

test.after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

test('a query naming a reviewed-CLI read in prose is an exact lookup', () => {
  assert.equal(
    classify(LIVE_QUERY)?.category,
    'exact_schema_refresh',
    'THE REGRESSION: this was broad_discovery, spending the task exploration on a lookup that explored nothing',
  );
});

test('the bare identifier is still exact', () => {
  assert.equal(classify('salesforce_sf_soql_query')?.category, 'exact_schema_refresh');
});

test('an MCP-namespaced name in prose stays exact', () => {
  // The behaviour the original rule already had, preserved.
  assert.equal(classify('get me the schema for alpha__read_rows')?.category, 'exact_schema_refresh');
});

test('genuine exploration is still broad', () => {
  // Identity must not turn every query into an exact lookup: a search that
  // names no operation is real exploration and must still be charged as one.
  assert.equal(classify('what can I use to read my sales pipeline')?.category, 'broad_discovery');
  assert.equal(classify('find me a tool for scraping facebook pages')?.category, 'broad_discovery');
});

test('a query naming TWO operations is exploration, not a lookup', () => {
  // Exactly one named operation is a lookup. Two is a comparison, and the
  // original rule said so for namespaced names; identity keeps that.
  assert.equal(
    classify('compare salesforce_sf_soql_query and salesforce_sf_org_list for this')?.category,
    'broad_discovery',
  );
});
