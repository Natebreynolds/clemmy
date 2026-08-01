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
    userInput: 'run a fresh SEO audit of acme.example',
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

test('resolveMcpToolScope: explicit local-memory diagnostics cannot be misread as Outlook intent', () => {
  const scope = resolveMcpToolScope({
    userInput: 'This is a live diagnostic. Use only Clementine\'s local memory. Do not call any external connector. Identify the eight active people on my team. Return names only, no emails.',
  });
  assert.deepEqual(scope.allowedServerSlugs, []);
  assert.equal(scope.maxTools, 0);
  assert.ok(!scope.failOpenCandidate);
  assert.match(scope.reason, /local-only\/no-external-tools/i);
});

test('resolveMcpToolScope: an email column in a Sheet is structured data, not Outlook intent', () => {
  const scope = resolveMcpToolScope({
    userInput: 'Create a Google Sheet with columns company and email. Beacon has email missing; validate every row before writing.',
  });
  assert.ok(scope.allowedServerSlugs?.includes('googlesheets'));
  assert.ok(!(scope.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)));
  assert.equal(scope.reason, 'google-sheets intent');

  const mixed = resolveMcpToolScope({
    userInput: 'Create a Google Sheet with columns company and email, then email the completed sheet to Bob.',
  });
  assert.ok(mixed.allowedServerSlugs?.includes('googlesheets'));
  assert.ok((mixed.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)));
});

test('resolveMcpToolScope: a social content calendar is an artifact, not Outlook intent', () => {
  for (const userInput of [
    'Build a social media command center with a seven-day content calendar, campaign status, channel, owner, assets, and approvals.',
    'Create an editorial calendar in Airtable.',
    'Build a release calendar and a deployment heatmap.',
    'Show a calendar heatmap of website traffic.',
    'Create a crop calendar for the community garden.',
  ]) {
    const scope = resolveMcpToolScope({ userInput });
    assert.ok(
      !(scope.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)),
      `artifact calendar must not preload Outlook: ${userInput}`,
    );
  }

  const mixed = resolveMcpToolScope({
    userInput: 'Build a social media content calendar, then add a review meeting to my Outlook calendar.',
  });
  assert.ok(
    (mixed.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)),
    'a separate operational Outlook request remains reachable',
  );
});

test('resolveMcpToolScope: creative drafts are artifacts, not Outlook mail drafts', () => {
  for (const userInput of [
    'Draft a local blog post.',
    'Create three social post drafts for approval.',
    'Review the contract draft.',
    'Make a first draft of the landing page.',
  ]) {
    const scope = resolveMcpToolScope({ userInput });
    assert.ok(
      !(scope.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)),
      `creative draft must not preload Outlook: ${userInput}`,
    );
  }

  for (const userInput of [
    'Draft an email to Bob.',
    'List my Outlook drafts.',
    "What's on my calendar today?",
    'Add dinners to my calendar.',
    'Create a meeting invite for Friday.',
  ]) {
    const scope = resolveMcpToolScope({ userInput });
    assert.ok(
      (scope.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)),
      `operational Outlook/calendar request must remain reachable: ${userInput}`,
    );
  }
});

test('resolveMcpToolScope: a compact Sheet matrix containing email data does not preload Outlook', () => {
  const scope = resolveMcpToolScope({
    userInput: 'Read Google Sheets range A1:B4 and compare these cells exactly: company,email; Acme,acme@example.com; Beacon,beacon@example.com.',
  });
  assert.ok(scope.allowedServerSlugs?.includes('googlesheets'));
  assert.ok(!(scope.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)));
  assert.equal(scope.reason, 'google-sheets intent');

  const mixed = resolveMcpToolScope({
    userInput: 'Read Google Sheets range A1:B4 with headers company,email; then email the verified result to Bob.',
  });
  assert.ok(mixed.allowedServerSlugs?.includes('googlesheets'));
  assert.ok((mixed.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)));
});

test('resolveMcpToolScope: a negated Outlook boundary plus email-shaped Sheet data does not widen connector scope', () => {
  const scope = resolveMcpToolScope({
    userInput: [
      'Write this matrix to an existing disposable Google Sheet.',
      'Do not send email or use Outlook; the email-shaped strings below are inert cell data.',
      'company,email; Acme,alpha@example.invalid',
    ].join(' '),
  });
  assert.ok(scope.allowedServerSlugs?.includes('googlesheets'));
  assert.ok(!(scope.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)));
  assert.equal(scope.reason, 'google-sheets intent');

  const mixed = resolveMcpToolScope({
    userInput: 'Do not send the result yet; draft an Outlook email to Bob with the verified Google Sheet link.',
  });
  assert.ok(mixed.allowedServerSlugs?.includes('googlesheets'));
  assert.ok((mixed.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)));
});

test('resolveMcpToolScope: a JSON-quoted email header in a precision Sheet replay remains cell data', () => {
  const scope = resolveMcpToolScope({
    userInput: [
      'External-write smoke test against the existing disposable Google Sheet.',
      'Target: https://docs.google.com/spreadsheets/d/fixture/edit. Modify only Sheet1!E1:G5.',
      'Write exactly this matrix:',
      '[["company","email","qualified"],["Clem Smoke Alpha","alpha@example.invalid","TRUE"],["Clem Smoke Beta","beta@example.invalid","FALSE"]]',
      'Perform exactly one Google Sheets value write and one read-back.',
      'Do not send email or use Outlook. Do not retry an ambiguous or failed write.',
      'Report PASS only if every read-back cell is exact; otherwise report FAIL or BLOCKED.',
    ].join('\n'),
  });
  assert.deepEqual(scope.allowedServerSlugs, ['googlesheets', 'google_sheets', 'google']);
  assert.equal(scope.reason, 'google-sheets intent');
  assert.equal(scope.maxTools, 8);
});

test('resolveMcpToolScope: a local Netlify deploy does not preload Salesforce or GitHub from generic nouns', () => {
  const scope = resolveMcpToolScope({
    userInput: 'Deploy the validated site to Netlify, report the account slug and commit SHA, then verify the production URL.',
  });
  assert.deepEqual(scope.allowedServerSlugs, []);
  assert.equal(scope.maxTools, 0);
  assert.match(scope.reason, /local deploy CLI intent/i);

  const mixed = resolveMcpToolScope({
    userInput: 'Deploy the validated site to Netlify, then email the production URL to Bob.',
  });
  assert.ok((mixed.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)));
  assert.ok(!(mixed.allowedServerSlugs ?? []).includes('salesforce'));
  assert.ok(!(mixed.allowedServerSlugs ?? []).includes('github'));
});

test('resolveMcpToolScope: Salesforce requires its name or real CRM context, not a generic account noun', () => {
  const named = resolveMcpToolScope({
    userInput: 'Query the active accounts in Salesforce.',
  });
  assert.ok(named.allowedServerSlugs?.includes('salesforce'));

  const crm = resolveMcpToolScope({
    userInput: 'Query the active accounts in our CRM sales pipeline.',
  });
  assert.ok(crm.allowedServerSlugs?.includes('salesforce'));

  const generic = resolveMcpToolScope({
    userInput: 'Show the current Netlify account and its site settings.',
  });
  assert.ok(!(generic.allowedServerSlugs ?? []).includes('salesforce'));
});

test('resolveMcpToolScope: an explicit external exception remains reachable', () => {
  const scope = resolveMcpToolScope({
    userInput: 'Do not call any external connector except Salesforce; query the active contacts there.',
  });
  assert.ok(scope.allowedServerSlugs?.includes('salesforce'));
  assert.ok((scope.maxTools ?? 0) > 0);
});

test('resolveMcpToolScope: a pinned-calendar label + date shorthand is treated as Outlook calendar intent', () => {
  const scope = resolveMcpToolScope({ userInput: 'Check my acme for tomorrow', pinnedCalendarLabels: ['acme'] });
  assert.ok((scope.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)));
  assert.ok((scope.toolPatterns ?? []).includes('calendar'));
  assert.match(scope.reason, /outlook/i);
  assert.ok(!scope.failOpenCandidate);

  // No pinned calendars → the shorthand never fires; the turn stays generic.
  const generic = resolveMcpToolScope({ userInput: 'Check my acme for tomorrow' });
  assert.ok(!(generic.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)));
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

test('resolveMcpToolScopeWithRecall: unrelated learned MCP does not widen an existing precise scope', () => {
  const scope = resolveMcpToolScopeWithRecall({
    userInput: 'do an seo audit on https://example.com',
    learnedMatches: [mcpMatch('airtable__create_record')],
  });
  assert.ok((scope.allowedServerSlugs ?? []).includes('dataforseo'), 'keeps the keyword scope');
  assert.ok(!(scope.allowedServerSlugs ?? []).includes('airtable'), 'does not add an unrequested learned server');
});

test('resolveMcpToolScopeWithRecall: explicitly named learned MCP widens a precise multi-system request', () => {
  const scope = resolveMcpToolScopeWithRecall({
    userInput: 'do an seo audit on https://example.com; save the findings to Airtable',
    learnedMatches: [mcpMatch('airtable__create_record')],
  });
  assert.ok((scope.allowedServerSlugs ?? []).includes('dataforseo'), 'keeps the keyword scope');
  assert.ok((scope.allowedServerSlugs ?? []).includes('airtable'), 'adds the explicitly requested proven server');
});

test('resolveMcpToolScopeWithRecall: structured payload and prohibited tool names cannot widen a Sheet scope', () => {
  const scope = resolveMcpToolScopeWithRecall({
    userInput: [
      'Write this matrix to an existing Google Sheet:',
      '[["company","status"],["Clem Smoke Beta","ready"]]',
      'Perform one read-back. Do not call execution_get or any old receipt tool.',
    ].join('\n'),
    learnedMatches: [mcpMatch('beta__get_thing')],
  });
  assert.deepEqual(scope.allowedServerSlugs, ['googlesheets', 'google_sheets', 'google']);
  assert.equal(scope.reason, 'google-sheets intent');
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

test('filterMcpToolsForScope: semantic scores rank the fail-open surface (T1)', () => {
  const scope: McpToolScope = { reason: 'failopen semantic', failOpenCandidate: true, maxTools: 2 };
  const tools = [
    tool('github__create_issue', 'Open a GitHub issue'),
    tool('slack__post_message', 'Post a Slack message'),
    tool('airtable__list_records', 'List Airtable records'),
  ];
  // Query "add a row to my airtable + ping the team" → airtable + slack most
  // relevant; github least. By index alone the cap of 2 would keep github+slack.
  const semantic = new Map<string, number>([
    ['airtable__list_records', 0.81],
    ['slack__post_message', 0.55],
    ['github__create_issue', 0.05],
  ]);
  const filtered = filterMcpToolsForScope(tools, scope, semantic).map((t) => t.name);
  assert.deepEqual(filtered, ['airtable__list_records', 'slack__post_message'], 'kept the 2 most semantically relevant, in relevance order');
  assert.ok(!filtered.includes('github__create_issue'), 'least-relevant tool dropped under the cap');
});

test('filterMcpToolsForScope: omitting semantic scores is byte-identical to before (no regression)', () => {
  const scope: McpToolScope = { reason: 'failopen', failOpenCandidate: true, maxTools: 2 };
  const tools = [
    tool('a__one', 'first'),
    tool('b__two', 'second'),
    tool('c__three', 'third'),
  ];
  const withoutArg = filterMcpToolsForScope(tools, scope).map((t) => t.name);
  const withUndefined = filterMcpToolsForScope(tools, scope, undefined).map((t) => t.name);
  assert.deepEqual(withoutArg, ['a__one', 'b__two'], 'index order preserved when no semantic signal');
  assert.deepEqual(withUndefined, withoutArg, 'explicit undefined === omitted');
});

test('filterMcpToolsForScope: semantic ranking still loses to the __unavailable penalty', () => {
  const scope: McpToolScope = { reason: 'failopen', failOpenCandidate: true, maxTools: 1 };
  const tools = [
    tool('x__unavailable', 'server unavailable stub'),
    tool('y__do_thing', 'does the thing'),
  ];
  // Even if the stub somehow scored highly, the −50 penalty keeps the real tool first.
  const semantic = new Map<string, number>([['x__unavailable', 0.99], ['y__do_thing', 0.10]]);
  const filtered = filterMcpToolsForScope(tools, scope, semantic).map((t) => t.name);
  assert.deepEqual(filtered, ['y__do_thing'], 'real tool wins the cap over the unavailable stub');
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
      'In this same Acme audit thread, append a Compaction replay check 2 section to the local report. Do not run a fresh SEO audit or DataForSEO lookup unless you truly need it.',
  });
  assert.equal(scope.allowAll, undefined);
  assert.deepEqual(scope.allowedServerSlugs, []);
  assert.equal(scope.maxTools, 0);
  assert.match(scope.reason, /local context/i);
});

test('resolveMcpToolScope: without-running wording suppresses external tools for replay checks', () => {
  const scope = resolveMcpToolScope({
    userInput:
      'Continue this exact Acme audit thread. Without running a fresh SEO audit, DataForSEO lookup, crawl, scrape, or web search, append a new section titled "Compaction replay check 3" to /Users/example/acme-co-seo-audit-2026-05-27.md. In that section, summarize from memory/context: 1. the audit target, 2. the strongest technical SEO issue, 3. the main organic-visibility issue, 4. the file path you updated. Use append mode only.',
  });
  assert.equal(scope.allowAll, undefined);
  assert.deepEqual(scope.allowedServerSlugs, []);
  assert.equal(scope.maxTools, 0);
  assert.match(scope.reason, /local context/i);
});

test('resolveMcpToolScope: without-running-any wording suppresses comma-list external tools', () => {
  const scope = resolveMcpToolScope({
    userInput:
      "Continue this exact Acme audit thread. Without running any fresh web, DataForSEO, SEO, or external MCP lookups, append a new section titled 'Compaction replay check 5' to /Users/example/acme-co-seo-audit-2026-05-27.md.",
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

// A local follow-up that asks for FRESH data from an app OUTSIDE the named
// keyword families used to fall through to maxTools:0 → "not connected on the
// first try". It must now reach tools (bounded fail-open or a matched scope).
test('resolveMcpToolScope: "update the report with the latest Airtable records" is NOT starved to maxTools:0', () => {
  const scope = resolveMcpToolScope({ userInput: 'update the report with the latest Airtable records' });
  assert.ok((scope.maxTools ?? 0) > 0, 'app-data follow-up must reach external tools');
  assert.doesNotMatch(scope.reason, /local context/i);
});

test('resolveMcpToolScope: "the report needs the newest backlinks" reaches the SEO scope', () => {
  const scope = resolveMcpToolScope({ userInput: 'The report needs the newest backlinks added.' });
  assert.ok(scope.allowedServerSlugs?.includes('dataforseo'));
  assert.ok((scope.maxTools ?? 0) > 0);
});

test('resolveMcpToolScope: "pull the current deals into the report" falls open to bounded tools', () => {
  const scope = resolveMcpToolScope({ userInput: 'Pull the current deals into the report.' });
  assert.ok((scope.maxTools ?? 0) > 0);
});

test('resolveMcpToolScope: an EXPLICIT negation still suppresses tools even with the new freshness cues', () => {
  const scope = resolveMcpToolScope({ userInput: 'Append to the local report; do not pull any fresh Airtable records.' });
  assert.equal(scope.maxTools, 0);
  assert.match(scope.reason, /local context/i);
});

test('resolveMcpToolScope: named external systems override local-context wording', () => {
  const scope = resolveMcpToolScope({
    userInput:
      'Find 8 law firm accounts from Salesforce that fit our Priority Account lane and have not been touched recently. For each one, gather one concrete SEO signal, then create unsent Outlook drafts. Keep enough state that I can ask follow-up questions after the workflow finishes.',
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

test('a bare "go" answering Clem\'s question keeps the scope its request earned', () => {
  // Live 2026-07-31 (harness.db seq 1382). The request named Salesforce,
  // Outlook and Google Sheets; the user answered a clarifying question with
  // "go". Because "go" is not in the go-ahead vocabulary, the execution turn —
  // the one that had to do the work — dropped from 24 tools across seven
  // servers to the bounded no-server fail-open surface.
  const priors = ['fully autonomously please: find 20 law firms from my Salesforce (use the sf CLI, read-only), draft a short personalized outreach email for each, then create one Google Sheet'];
  const vocabularyOnly = resolveMcpToolScopeWithContinuity({ userInput: 'go', priorUserInputs: priors });
  assert.equal(vocabularyOnly.failOpenCandidate, true, 'the wording alone does not rescue it');

  const structural = resolveMcpToolScopeWithContinuity({ userInput: 'go', priorUserInputs: priors, awaitingAnswer: true });
  assert.ok((structural.allowedServerSlugs ?? []).includes('salesforce'), 'salesforce survives the go-ahead');
  assert.ok((structural.allowedServerSlugs ?? []).some((slug) => /google_?sheets/.test(slug)), 'sheets survives too');
  assert.match(structural.reason, /answer-to-question/);
});

test('the structural signal covers go-aheads no word list would contain', () => {
  const priors = ['draft the outlook emails to the 20 firms'];
  for (const answer of ['go', 'ok', 'mhm', 'fire away', 'send er', 'aye']) {
    const scope = resolveMcpToolScopeWithContinuity({ userInput: answer, priorUserInputs: priors, awaitingAnswer: true });
    assert.ok(
      (scope.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)),
      `"${answer}" answers a question — the scope must survive it`,
    );
  }
});

test('awaitingAnswer never over-inherits: a fresh topic still wins', () => {
  // The user CAN change the subject while answering. A turn with its own intent
  // keeps that intent, question pending or not.
  const scope = resolveMcpToolScopeWithContinuity({
    userInput: 'actually, run a fresh SEO audit of acme.example instead',
    priorUserInputs: ['draft the outlook emails'],
    awaitingAnswer: true,
  });
  assert.ok((scope.allowedServerSlugs ?? []).includes('dataforseo'));
  assert.ok(!(scope.allowedServerSlugs ?? []).some((slug) => /outlook/.test(slug)));
});
