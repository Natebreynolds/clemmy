import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterMcpToolsForScope } from '../runtime/mcp-tool-filter.js';
import {
  externalMcpScopeFromExactToolNames,
  externalMcpScopeFromResolvedTools,
  intersectExternalMcpToolScopes,
  workerPacketMcpToolScope,
} from './external-mcp-scope-lock.js';

const tool = (name: string, description = '') => ({ name, description }) as never;

test('worker scope intersection narrows both server and tool pattern', () => {
  const scope = intersectExternalMcpToolScopes(
    {
      reason: 'parent Salesforce opportunity authority',
      allowedServerSlugs: ['salesforce-mcp'],
      toolPatterns: ['opportunit'],
      maxTools: 8,
      serverMaxTools: { salesforce: 5 },
    },
    {
      reason: 'packet exact query',
      allowedServerSlugs: ['salesforce'],
      toolPatterns: ['query'],
      maxTools: 3,
      serverMaxTools: { 'salesforce-mcp': 2 },
    },
  );

  assert.ok(scope);
  assert.deepEqual(scope.allowedServerSlugs, ['salesforce']);
  assert.equal(scope.maxTools, 3);
  assert.deepEqual(scope.serverMaxTools, { salesforce: 2 });
  const filtered = filterMcpToolsForScope([
    tool('salesforce__query_opportunities'),
    tool('salesforce__delete_opportunity'),
    tool('salesforce__query_accounts'),
    tool('airtable__query_opportunities'),
  ], scope);
  assert.deepEqual(filtered.map((item) => item.name), ['salesforce__query_opportunities']);
});

test('disjoint parent and packet servers collapse to local-only authority', () => {
  assert.equal(intersectExternalMcpToolScopes(
    { reason: 'parent', allowedServerSlugs: ['salesforce'] },
    { reason: 'packet', allowedServerSlugs: ['airtable'] },
  ), null);
});

test('broad parent yields to exact packet while retaining the tighter cap', () => {
  const scope = intersectExternalMcpToolScopes(
    { reason: 'bounded fail-open parent', failOpenCandidate: true, maxTools: 2 },
    { reason: 'packet', allowedServerSlugs: ['notion'], toolPatterns: ['create'] },
  );
  assert.ok(scope);
  assert.equal(scope.failOpenCandidate, undefined);
  assert.deepEqual(scope.allowedServerSlugs, ['notion']);
  assert.deepEqual(scope.toolPatterns, ['create']);
  assert.equal(scope.maxTools, 2);
});

test('explicit local-only authority wins on either side', () => {
  const concrete = { reason: 'packet', allowedServerSlugs: ['notion'] };
  assert.equal(intersectExternalMcpToolScopes(null, concrete), null);
  assert.equal(intersectExternalMcpToolScopes(concrete, null), null);
});

test('resolved worker packet leases every exact compatible tool, not the parent selection subset', () => {
  const packet = externalMcpScopeFromResolvedTools([
    'Use these exact tools:',
    'dataforseo__dataforseo_labs_google_domain_rank_overview',
    'dataforseo__dataforseo_labs_google_ranked_keywords',
    'dataforseo__on_page_instant_pages',
    'Ignore the local label internal__scratch.',
  ].join(' '), ['dataforseo']);
  const scope = intersectExternalMcpToolScopes(
    {
      // Exact shape durably recorded by the failed live turn: the parent
      // admitted the DataForSEO family, while the worker packet named the
      // three exact tools needed for each item.
      reason: 'seo/web-audit intent',
      allowedServerSlugs: ['dataforseo'],
      maxTools: 8,
    },
    packet,
  );
  assert.ok(scope);
  assert.deepEqual(scope.allowedToolNames, [
    'dataforseo__dataforseo_labs_google_domain_rank_overview',
    'dataforseo__dataforseo_labs_google_ranked_keywords',
    'dataforseo__on_page_instant_pages',
  ]);
  const selected = filterMcpToolsForScope([
    tool('dataforseo__dataforseo_labs_google_domain_rank_overview'),
    tool('dataforseo__dataforseo_labs_google_ranked_keywords'),
    tool('dataforseo__on_page_instant_pages'),
    tool('dataforseo__archive_dataforseo_labs_google_ranked_keywords_history'),
    tool('dataforseo__unrelated_archive', 'Archive for dataforseo_labs_google_ranked_keywords'),
    tool('dataforseo__backlinks_bulk_ranks'),
    tool('firecrawl__scrape'),
  ], scope);
  assert.deepEqual(selected.map((entry) => entry.name), [
    'dataforseo__dataforseo_labs_google_domain_rank_overview',
    'dataforseo__dataforseo_labs_google_ranked_keywords',
    'dataforseo__on_page_instant_pages',
  ]);
});

test('packet lease is exact and runtime local-only cannot inherit build authority', () => {
  const buildScope = {
    reason: 'seo/web-audit intent',
    allowedServerSlugs: ['dataforseo'],
    maxTools: 8,
  };
  const resolvedTools = 'dataforseo__dataforseo_labs_google_ranked_keywords';
  const leased = workerPacketMcpToolScope({
    buildScope,
    runtimeScope: undefined,
    resolvedTools,
    serverNames: ['dataforseo'],
  });
  assert.ok(leased);
  const selected = filterMcpToolsForScope([
    tool('dataforseo__dataforseo_labs_google_ranked_keywords'),
    tool('dataforseo__archive_dataforseo_labs_google_ranked_keywords_history'),
  ], leased);
  assert.deepEqual(selected.map((entry) => entry.name), [
    'dataforseo__dataforseo_labs_google_ranked_keywords',
  ]);
  assert.equal(workerPacketMcpToolScope({
    buildScope,
    runtimeScope: null,
    resolvedTools,
    serverNames: ['dataforseo'],
  }), null);
});

test('mcp__ carrier spelling still leases only the exact server tool', () => {
  const scope = externalMcpScopeFromResolvedTools(
    'mcp__firecrawl__scrape',
    ['firecrawl'],
  );
  assert.deepEqual(scope?.allowedToolNames, ['firecrawl__scrape']);
  const selected = filterMcpToolsForScope([
    tool('firecrawl__scrape'),
    tool('firecrawl__scrape_all_private_data'),
  ], scope!);
  assert.deepEqual(selected.map((entry) => entry.name), ['firecrawl__scrape']);
});

test('typed exact lease binds one configured namespace and ambiguous generic aliases fail closed', () => {
  const configured = ['notion-mcp', 'notion-server'];
  const exact = externalMcpScopeFromExactToolNames(
    ['mcp__notion-mcp__read_page'],
    configured,
  );
  assert.deepEqual(exact, {
    reason: 'worker typed exact external MCP lease',
    allowedServerSlugs: ['notion-mcp'],
    allowedToolNames: ['notion-mcp__read_page'],
    maxTools: 1,
  });
  assert.deepEqual(filterMcpToolsForScope([
    // Put the alias-confusable sibling first: catalog order must never let it
    // hijack the one-slot exact lease.
    tool('notion-server__read_page'),
    tool('notion-mcp__read_page'),
  ], exact!).map((entry) => entry.name), ['notion-mcp__read_page']);

  assert.equal(
    externalMcpScopeFromExactToolNames(['notion__read_page'], configured),
    null,
    'a friendly alias shared by two live namespaces is not dispatch authority',
  );
});

test('legacy wildcard remains server-wide while an explicit empty typed lease denies external tools', () => {
  const wildcard = externalMcpScopeFromResolvedTools('Use `firecrawl__*`', ['firecrawl']);
  assert.ok(wildcard);
  assert.equal(wildcard.allowedToolNames, undefined);
  assert.deepEqual(filterMcpToolsForScope([
    tool('firecrawl__scrape'),
    tool('firecrawl__crawl'),
  ], wildcard).map((entry) => entry.name), ['firecrawl__scrape', 'firecrawl__crawl']);

  assert.equal(workerPacketMcpToolScope({
    buildScope: { reason: 'web parent', allowedServerSlugs: ['firecrawl'], maxTools: 8 },
    runtimeScope: undefined,
    resolvedTools: 'firecrawl__scrape',
    externalMcpToolNames: [],
    serverNames: ['firecrawl'],
  }), null);
});

test('an exact lease preserves only its server diagnostic sentinel', () => {
  const scope = externalMcpScopeFromResolvedTools('firecrawl__scrape', ['firecrawl']);
  assert.deepEqual(filterMcpToolsForScope([
    tool('firecrawl__scrape'),
    tool('firecrawl__unavailable'),
    tool('dataforseo__unavailable'),
  ], scope!).map((entry) => entry.name), [
    'firecrawl__scrape',
    'firecrawl__unavailable',
  ]);
});

test('typed packet lease ignores forbidden tool names in resolvedTools prose', () => {
  const scope = workerPacketMcpToolScope({
    buildScope: { reason: 'SEO parent', allowedServerSlugs: ['dataforseo'], maxTools: 8 },
    runtimeScope: undefined,
    resolvedTools: 'Do not use dataforseo__delete_everything. Example only: dataforseo__archive_all.',
    externalMcpToolNames: ['dataforseo__ranked_keywords'],
    serverNames: ['dataforseo'],
  });
  assert.deepEqual(scope?.allowedToolNames, ['dataforseo__ranked_keywords']);
  assert.deepEqual(filterMcpToolsForScope([
    tool('dataforseo__ranked_keywords'),
    tool('dataforseo__delete_everything'),
    tool('dataforseo__archive_all'),
  ], scope!).map((entry) => entry.name), ['dataforseo__ranked_keywords']);
});

test('intersection preserves an explicit-empty parent exact authority as deny', () => {
  assert.equal(intersectExternalMcpToolScopes(
    {
      reason: 'parent exact deny',
      allowedServerSlugs: ['dataforseo'],
      allowedToolNames: [],
      maxTools: 8,
    },
    {
      reason: 'child request',
      allowedServerSlugs: ['dataforseo'],
      allowedToolNames: ['dataforseo__ranked_keywords'],
      maxTools: 1,
    },
  ), null);
});
