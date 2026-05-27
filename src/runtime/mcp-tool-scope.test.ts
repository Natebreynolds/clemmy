/**
 * Run: npx tsx --test src/runtime/mcp-tool-scope.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterMcpToolsForScope } from './mcp-tool-filter.js';
import { resolveMcpToolScope } from './mcp-tool-scope.js';

function tool(name: string, description = ''): any {
  return { name, description, inputSchema: { type: 'object', properties: {} } };
}

test('resolveMcpToolScope: local/file prompts do not inject external MCP tools', () => {
  const scope = resolveMcpToolScope({ userInput: 'write a local markdown file with a project checklist' });
  assert.equal(scope.allowAll, undefined);
  assert.deepEqual(scope.allowedServerSlugs, []);
  assert.equal(scope.maxTools, 0);
});

test('resolveMcpToolScope: SEO audit prompts select a capped DataForSEO subset', () => {
  const scope = resolveMcpToolScope({
    userInput: 'hey can you do an SEO audit on https://example.com and suggest changes',
  });
  assert.equal(scope.allowAll, undefined);
  assert.ok(scope.allowedServerSlugs?.includes('dataforseo'));
  assert.ok((scope.maxTools ?? 0) > 0);
  assert.match(scope.reason, /seo/i);
});

test('resolveMcpToolScope: local SEO follow-ups do not inject DataForSEO', () => {
  const scope = resolveMcpToolScope({
    userInput: 'Before doing anything new, tell me the SEO findings you remember from the audit we just ran. Then append a section to the local markdown report.',
  });
  assert.equal(scope.allowAll, undefined);
  assert.deepEqual(scope.allowedServerSlugs, []);
  assert.equal(scope.maxTools, 0);
  assert.match(scope.reason, /local context/i);
});

test('resolveMcpToolScope: negative fresh-audit instructions suppress DataForSEO for local follow-ups', () => {
  const scope = resolveMcpToolScope({
    userInput:
      'In this same Scorpion audit thread, append a Compaction replay check 2 section to the local report. Do not run a fresh SEO audit or DataForSEO lookup unless you truly need it.',
  });
  assert.equal(scope.allowAll, undefined);
  assert.deepEqual(scope.allowedServerSlugs, []);
  assert.equal(scope.maxTools, 0);
  assert.match(scope.reason, /local context/i);
});

test('resolveMcpToolScope: without-running wording suppresses external tools for replay checks', () => {
  const scope = resolveMcpToolScope({
    userInput:
      'Continue this exact Scorpion audit thread. Without running a fresh SEO audit, DataForSEO lookup, crawl, scrape, or web search, append a new section titled "Compaction replay check 3" to /Users/nathan.reynolds/scorpion-co-seo-audit-2026-05-27.md. In that section, summarize from memory/context: 1. the audit target, 2. the strongest technical SEO issue, 3. the main organic-visibility issue, 4. the file path you updated. Use append mode only.',
  });
  assert.equal(scope.allowAll, undefined);
  assert.deepEqual(scope.allowedServerSlugs, []);
  assert.equal(scope.maxTools, 0);
  assert.match(scope.reason, /local context/i);
});

test('resolveMcpToolScope: without-running-any wording suppresses comma-list external tools', () => {
  const scope = resolveMcpToolScope({
    userInput:
      "Continue this exact Scorpion audit thread. Without running any fresh web, DataForSEO, SEO, or external MCP lookups, append a new section titled 'Compaction replay check 5' to /Users/nathan.reynolds/scorpion-co-seo-audit-2026-05-27.md.",
  });
  assert.equal(scope.allowAll, undefined);
  assert.deepEqual(scope.allowedServerSlugs, []);
  assert.equal(scope.maxTools, 0);
  assert.match(scope.reason, /local context/i);
});

test('resolveMcpToolScope: fresh SEO follow-ups can still request DataForSEO', () => {
  const scope = resolveMcpToolScope({
    userInput: 'Rerun a fresh SEO audit with DataForSEO for https://example.com and update the report.',
  });
  assert.ok(scope.allowedServerSlugs?.includes('dataforseo'));
  assert.ok((scope.maxTools ?? 0) > 0);
});

test('resolveMcpToolScope: named external systems override local-context wording', () => {
  const scope = resolveMcpToolScope({
    userInput:
      'Find 8 law firm accounts from Salesforce that fit our Market Leader lane and have not been touched recently. For each one, gather one concrete SEO signal, then create unsent Outlook drafts. Keep enough state that I can ask follow-up questions after the workflow finishes.',
  });
  assert.ok(scope.allowedServerSlugs?.includes('salesforce'));
  assert.ok(scope.allowedServerSlugs?.includes('dataforseo'));
  assert.ok(scope.allowedServerSlugs?.some((slug) => slug.includes('outlook') || slug === 'microsoft'));
  assert.equal(scope.maxTools, 24);
  assert.equal(scope.serverMaxTools?.dataforseo, 8);
  assert.equal(scope.serverMaxTools?.salesforce, 8);
  assert.equal(scope.serverMaxTools?.outlook, 8);
  assert.doesNotMatch(scope.reason, /local context/i);
});

test('resolveMcpToolScope: append-to-sheet prompts still include Google Sheets tools', () => {
  const scope = resolveMcpToolScope({
    userInput: 'Append the accounts we already found to a new Google Sheet with notes from context.',
  });
  assert.ok(scope.allowedServerSlugs?.includes('googlesheets'));
  assert.ok((scope.maxTools ?? 0) > 0);
});

test('filterMcpToolsForScope: SEO scope excludes unrelated tools and keeps high-priority audit tools', () => {
  const scope = resolveMcpToolScope({
    userInput: 'do an seo audit on this site https://example.com',
  });
  const filtered = filterMcpToolsForScope([
    tool('dataforseo__dataforseo_labs_google_ranked_keywords', 'Ranked keywords for a domain'),
    tool('dataforseo__backlinks_summary', 'Backlinks summary for the target domain'),
    tool('dataforseo__dataforseo_labs_google_bulk_traffic_estimation', 'Bulk traffic estimation'),
    tool('dataforseo__content_generation_paraphrase', 'Rewrite text'),
    tool('github__search_issues', 'Search GitHub issues'),
  ], scope);

  const names = filtered.map((t) => t.name);
  assert.ok(names.includes('dataforseo__dataforseo_labs_google_ranked_keywords'));
  assert.ok(names.includes('dataforseo__backlinks_summary'));
  assert.ok(names.includes('dataforseo__dataforseo_labs_google_bulk_traffic_estimation'));
  assert.equal(names.includes('dataforseo__content_generation_paraphrase'), false);
  assert.equal(names.includes('github__search_issues'), false);
});

test('filterMcpToolsForScope: maxTools keeps the most relevant matches first', () => {
  const filtered = filterMcpToolsForScope([
    tool('dataforseo__generic_summary', 'Generic summary'),
    tool('dataforseo__on_page_lighthouse', 'Lighthouse on page audit'),
    tool('dataforseo__ranked_keywords', 'Ranked keywords'),
  ], {
    reason: 'test',
    allowedServerSlugs: ['dataforseo'],
    toolPatterns: ['summary', 'on[_-]?page', 'ranked[_-]?keywords?'],
    priorityKeywords: ['on_page', 'ranked_keywords'],
    maxTools: 2,
  });

  assert.deepEqual(filtered.map((t) => t.name), [
    'dataforseo__on_page_lighthouse',
    'dataforseo__ranked_keywords',
  ]);
});

test('filterMcpToolsForScope: per-server caps keep multi-system tools available', () => {
  const scope = resolveMcpToolScope({
    userInput:
      'Find 8 law firm accounts from Salesforce, gather one concrete SEO signal, then create Outlook drafts.',
  });
  const dataforseoTools = Array.from({ length: 20 }, (_, index) =>
    tool(`dataforseo__ranked_keywords_${index}`, `Ranked keywords ${index}`),
  );
  const filtered = filterMcpToolsForScope([
    ...dataforseoTools,
    tool('salesforce__query_accounts', 'Query Salesforce accounts'),
    tool('salesforce__get_account', 'Get Salesforce account'),
    tool('outlook__create_draft', 'Create Outlook draft email'),
    tool('outlook__send_message', 'Send Outlook message'),
  ], scope);

  const names = filtered.map((t) => t.name);
  assert.equal(names.filter((name) => name.startsWith('dataforseo__')).length, 8);
  assert.ok(names.includes('salesforce__query_accounts'));
  assert.ok(names.includes('salesforce__get_account'));
  assert.ok(names.includes('outlook__create_draft'));
  assert.ok(names.includes('outlook__send_message'));
});
