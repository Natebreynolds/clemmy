/**
 * Run: npx tsx --test src/runtime/mcp-tool-scope.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterMcpToolsForScope } from './mcp-tool-filter.js';
import { resolveMcpToolScope, resolveMcpToolScopeWithContinuity, resolveMcpToolScopeWithRecall, isToolScopeContinuation, type McpToolScope } from './mcp-tool-scope.js';
import type { StepToolChoiceMatch } from '../memory/tool-choice-store.js';

function mcpMatch(identifier: string, tier: 'high' | 'medium' = 'high'): StepToolChoiceMatch {
  return {
    intent: `objective — ${identifier}`,
    kind: 'mcp',
    identifier,
    score: 1,
    tier,
    matched: [],
    alreadyBound: false,
    autoBindable: true,
    family: [identifier],
    command: identifier,
  };
}

function tool(name: string, description = ''): any {
  return { name, description, inputSchema: { type: 'object', properties: {} } };
}

// ── Continuity-aware scope (the "chatbot feel" fix) ──────────────────────────

test('isToolScopeContinuation: confirmations/go-aheads are continuations; fresh topics are not', () => {
  for (const c of ["let's get them ready", 'go ahead', 'do it', "yes that's perfect", 'make that thing happen', 'show me', 'now go off and get all the data and make it happen']) {
    assert.equal(isToolScopeContinuation(c), true, `should be continuation: ${c}`);
  }
  for (const f of ['what is the weather tomorrow', 'summarize our chat', 'who won the game']) {
    assert.equal(isToolScopeContinuation(f), false, `should NOT be continuation: ${f}`);
  }
});

test('resolveMcpToolScopeWithContinuity: a bare confirmation inherits the prior turn\'s tool scope (the incident)', () => {
  // On main, "let's get them ready" → maxTools:0 (no keyword). With the prior
  // turn's Outlook-intent input available, it inherits the Outlook scope.
  const inherited = resolveMcpToolScopeWithContinuity({
    userInput: "let's get them ready",
    priorUserInputs: ['draft the outlook emails to the 44 contacts'],
  });
  assert.ok((inherited.maxTools ?? 0) > 0, 'inherits a concrete tool scope');
  assert.ok((inherited.allowedServerSlugs ?? []).some((s) => /outlook|microsoft/.test(s)), 'inherits Outlook servers');
  assert.match(inherited.reason, /continuity/);
  // Proof continuity (not fail-open) supplied the PRECISE scope: the direct
  // resolve of the bare confirmation is only the broad fail-open fallback — it
  // carries no Outlook slugs of its own, so the Outlook surface above came from
  // inheriting the prior turn.
  const direct = resolveMcpToolScope({ userInput: "let's get them ready" });
  assert.equal(direct.failOpenCandidate, true);
  assert.ok(!(direct.allowedServerSlugs ?? []).some((s) => /outlook|microsoft/.test(s)));
});

test('resolveMcpToolScopeWithContinuity: a FRESH-intent turn ignores prior scope (no over-inherit)', () => {
  const scope = resolveMcpToolScopeWithContinuity({
    userInput: 'run a fresh SEO audit of acme.com',
    priorUserInputs: ['draft the outlook emails'],
  });
  // Current turn has its own intent → SEO scope, NOT the inherited Outlook one.
  assert.ok((scope.allowedServerSlugs ?? []).includes('dataforseo'));
  assert.ok(!(scope.allowedServerSlugs ?? []).some((s) => /outlook/.test(s)));
});

test('resolveMcpToolScopeWithContinuity: a non-continuation keyword-less turn does NOT inherit the prior scope (falls back to fail-open)', () => {
  const scope = resolveMcpToolScopeWithContinuity({
    userInput: 'summarize what we discussed',
    priorUserInputs: ['draft the outlook emails'],
  });
  // Not a continuation → must NOT inherit the precise Outlook scope...
  assert.ok(!(scope.allowedServerSlugs ?? []).some((s) => /outlook|microsoft/.test(s)));
  // ...and reach is no longer silently zero — it fails open to the user's own servers.
  assert.equal(scope.failOpenCandidate, true);
  assert.ok((scope.maxTools ?? 0) > 0);
});

test('resolveMcpToolScopeWithContinuity: a continuation with no concrete prior to inherit falls back to fail-open (not empty)', () => {
  const scope = resolveMcpToolScopeWithContinuity({
    userInput: 'go ahead',
    priorUserInputs: ['just chatting', 'thanks'],
  });
  assert.equal(scope.failOpenCandidate, true);
  assert.ok((scope.maxTools ?? 0) > 0);
});

test('resolveMcpToolScope: local/file prompts do not inject external MCP tools', () => {
  const scope = resolveMcpToolScope({ userInput: 'write a local markdown file with a project checklist' });
  assert.equal(scope.allowAll, undefined);
  assert.deepEqual(scope.allowedServerSlugs, []);
  assert.equal(scope.maxTools, 0);
  // A DELIBERATE local/no-tool turn must NOT fail open (token discipline).
  assert.ok(!scope.failOpenCandidate);
});

// ── Fail-open per class (CANON-REACH-FAILOPEN) ───────────────────────────────

test('resolveMcpToolScope: an unrecognized-intent turn FAILS OPEN so connected apps outside the keyword families are reachable', () => {
  // "create a page in my Notion workspace…" matches no keyword family. Old
  // behavior: maxTools:0 → Notion invisible → false "not connected". Now: bounded
  // fail-open. (Avoid words like "lead"/"account"/"email" that trip a family.)
  const scope = resolveMcpToolScope({ userInput: 'create a page in my Notion workspace about Q3 planning' });
  assert.equal(scope.failOpenCandidate, true);
  assert.ok((scope.maxTools ?? 0) > 0);
  assert.equal(scope.allowAll, undefined); // bounded — NOT the full legacy surface
});

test('resolveMcpToolScope: the fail-open kill-switch restores the prior maxTools:0 behavior', () => {
  const prev = process.env.CLEMMY_MCP_SCOPE_FAILOPEN;
  try {
    process.env.CLEMMY_MCP_SCOPE_FAILOPEN = 'off';
    const scope = resolveMcpToolScope({ userInput: 'add a row to my Notion database' });
    assert.ok(!scope.failOpenCandidate);
    assert.equal(scope.maxTools, 0);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_MCP_SCOPE_FAILOPEN;
    else process.env.CLEMMY_MCP_SCOPE_FAILOPEN = prev;
  }
});

// ── Recall-aware scope (CANON-RECALL-NATIVE part a) ──────────────────────────

test('resolveMcpToolScopeWithRecall: a proven MCP server promotes a fail-open turn to a PRECISE scope', () => {
  // Keyword-less prompt → base is fail-open. A HIGH-tier learned mcp choice for
  // this intent targets the proven server precisely (drops failOpenCandidate).
  const scope = resolveMcpToolScopeWithRecall({
    userInput: 'create a page in my Notion workspace',
    learnedMatches: [mcpMatch('notion__create_page')],
  });
  assert.ok(!scope.failOpenCandidate, 'precise recall replaces the broad fail-open surface');
  assert.ok((scope.allowedServerSlugs ?? []).includes('notion'));
  assert.ok((scope.maxTools ?? 0) > 0);
  assert.match(scope.reason, /recall/);
});

test('resolveMcpToolScopeWithRecall: a learned MCP server WIDENS an existing keyword scope', () => {
  const scope = resolveMcpToolScopeWithRecall({
    userInput: 'do an seo audit on https://example.com',
    learnedMatches: [mcpMatch('airtable__create_record')],
  });
  assert.ok((scope.allowedServerSlugs ?? []).includes('dataforseo'), 'keeps the keyword scope');
  assert.ok((scope.allowedServerSlugs ?? []).includes('airtable'), 'adds the learned server');
});

test('resolveMcpToolScopeWithRecall: no learned matches → base scope unchanged', () => {
  const scope = resolveMcpToolScopeWithRecall({
    userInput: 'create a page in my Notion workspace',
    learnedMatches: [],
  });
  assert.equal(scope.failOpenCandidate, true, 'falls back to plain fail-open when nothing learned');
});

test('resolveMcpToolScopeWithRecall: a DELIBERATE no-tool turn is NOT widened by recall', () => {
  const scope = resolveMcpToolScopeWithRecall({
    userInput: 'append a section to the local markdown report from context, do not run a fresh audit',
    learnedMatches: [mcpMatch('notion__create_page')],
  });
  assert.equal(scope.maxTools, 0);
  assert.deepEqual(scope.allowedServerSlugs, []);
});

test('resolveMcpToolScopeWithRecall: medium-tier or non-mcp matches are ignored', () => {
  const scope = resolveMcpToolScopeWithRecall({
    userInput: 'create a page in my Notion workspace',
    learnedMatches: [mcpMatch('notion__create_page', 'medium')],
  });
  assert.equal(scope.failOpenCandidate, true, 'only HIGH-tier mcp matches widen');
});

test('resolveMcpToolScopeWithRecall: the kill-switch returns the base scope untouched', () => {
  const prev = process.env.CLEMMY_SCOPE_FROM_RECALL;
  try {
    process.env.CLEMMY_SCOPE_FROM_RECALL = 'off';
    const scope = resolveMcpToolScopeWithRecall({
      userInput: 'create a page in my Notion workspace',
      learnedMatches: [mcpMatch('notion__create_page')],
    });
    assert.equal(scope.failOpenCandidate, true);
    assert.ok(!(scope.allowedServerSlugs ?? []).includes('notion'));
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_SCOPE_FROM_RECALL;
    else process.env.CLEMMY_SCOPE_FROM_RECALL = prev;
  }
});

test('filterMcpToolsForScope: a fail-open scope spans ALL servers, capped, de-prioritizing __unavailable stubs', () => {
  const scope: McpToolScope = { reason: 'failopen test', failOpenCandidate: true, maxTools: 3 };
  const filtered = filterMcpToolsForScope([
    tool('airtable__unavailable', 'server unavailable stub'),
    tool('notion__create_page', 'Create a Notion page'),
    tool('slack__post_message', 'Post a Slack message'),
    tool('airtable__list_records', 'List Airtable records'),
  ], scope).map((t) => t.name);
  assert.equal(filtered.length, 3, 'global cap applied');
  assert.ok(!filtered.includes('airtable__unavailable'), 'stub de-prioritized out under the cap');
  assert.ok(filtered.includes('notion__create_page'));
  assert.ok(filtered.includes('slack__post_message'));
  assert.ok(filtered.includes('airtable__list_records'));
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
