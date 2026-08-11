import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpToolAllowedByScope } from './mcp-tool-authority.js';

test('MCP authority honours the user decision and ignores the context budget', () => {
  const tool = 'dataforseo__serp_organic_live';
  assert.equal(mcpToolAllowedByScope(tool, undefined), true, 'undefined is legacy allow');
  assert.equal(mcpToolAllowedByScope(tool, null), false, 'null is explicit deny');

  // The user said no. That is an authority decision and it holds.
  assert.equal(mcpToolAllowedByScope(tool, {
    reason: 'local only',
    authority: 'none',
    allowedServerSlugs: [],
    maxTools: 0,
  }), false, 'an explicit prohibition denies');
  assert.equal(mcpToolAllowedByScope(tool, {
    reason: 'user declined the prior task',
    authority: 'none',
    allowedToolNames: [],
    maxTools: 0,
  }), false, 'a decline denies even with an empty exact list');

  assert.equal(mcpToolAllowedByScope(tool, {
    reason: 'legacy escape hatch',
    allowAll: true,
  }), true);

  // A cap is a context budget. Spending it says nothing about permission, so
  // it can no longer be the reason a connected tool is refused — this is the
  // "not selected for this turn" class, removed at the root.
  assert.equal(mcpToolAllowedByScope(tool, {
    reason: 'zero-width budget, no prohibition',
    allowAll: true,
    maxTools: 0,
  }), true, 'a zero cap is a budget, never an authority boundary');
  assert.equal(mcpToolAllowedByScope(tool, {
    reason: 'bounded fail-open',
    failOpenCandidate: true,
    maxTools: 8,
  }), true);
  assert.equal(mcpToolAllowedByScope(tool, {
    reason: 'zero-width fail-open',
    failOpenCandidate: true,
    maxTools: 0,
  }), true, 'advertising nothing still leaves the catalog reachable');
  assert.equal(mcpToolAllowedByScope(tool, {
    reason: 'token discipline on a local follow-up',
    authority: 'catalog',
    allowedServerSlugs: [],
    maxTools: 0,
  }), true, 'an empty advertised surface is not a prohibition');
});

test('a relevance scope orders the surface; it does not withdraw authority', () => {
  // Keyword families are a guess about which of the user's OWN connected
  // systems matter this turn. Guessing wrong must cost ranking, not reach.
  const scope = {
    reason: 'SEO reads only',
    authority: 'catalog' as const,
    allowedServerSlugs: ['dataforseo'],
    toolPatterns: ['serp|keyword'],
    maxTools: 8,
  };
  assert.equal(mcpToolAllowedByScope('dataforseo__serp_organic_live', scope), true);
  assert.equal(mcpToolAllowedByScope('dataforseo__keyword_suggestions', scope), true);
  assert.equal(
    mcpToolAllowedByScope('dataforseo__delete_task', scope),
    true,
    'an off-pattern tool on an authorized server is reachable; its EFFECT is what gates it',
  );
  assert.equal(
    mcpToolAllowedByScope('salesforce__serp_report', scope),
    true,
    'a sibling authorized system is not forbidden for being off-topic a moment ago',
  );
  // Catalog membership — including alias-confusion defence — is enforced at
  // acquisition/routing against the CONFIGURED servers, which is the only
  // place that actually knows what the user connected. See
  // mcp-servers.test.ts "acquisition refuses a name outside the catalog".
});

test('an exact lease still admits exactly one capability', () => {
  const scope = {
    reason: 'typed worker packet',
    authority: 'exact' as const,
    allowedServerSlugs: ['dataforseo'],
    allowedToolNames: ['dataforseo__serp_organic_live'],
  };
  assert.equal(mcpToolAllowedByScope('dataforseo__serp_organic_live', scope), true);
  assert.equal(
    mcpToolAllowedByScope('dataforseo__serp_organic_live_advanced', scope),
    false,
    'a substring sibling never satisfies an exact lease',
  );
  assert.equal(mcpToolAllowedByScope('dataforseo__delete_task', scope), false);
  assert.equal(
    mcpToolAllowedByScope('evil_dataforseo_proxy__serp_organic_live', scope),
    false,
    'a confusable server alias never satisfies an exact lease',
  );
  assert.equal(
    mcpToolAllowedByScope('mcp__dataforseo__serp_organic_live', scope),
    true,
    'the mcp__ carrier is transport, not identity',
  );
});

test('exact MCP authority never admits a substring sibling', () => {
  const scope = {
    reason: 'compiled worker packet',
    allowedServerSlugs: ['dataforseo'],
    allowedToolNames: ['dataforseo__dataforseo_labs_google_ranked_keywords'],
    maxTools: 8,
  };
  assert.equal(
    mcpToolAllowedByScope('dataforseo__dataforseo_labs_google_ranked_keywords', scope),
    true,
  );
  assert.equal(
    mcpToolAllowedByScope('dataforseo__archive_dataforseo_labs_google_ranked_keywords_history', scope),
    false,
  );
  assert.equal(mcpToolAllowedByScope('mcp__dataforseo__dataforseo_labs_google_ranked_keywords', scope), true);
  assert.equal(mcpToolAllowedByScope('mcp__dataforseo__archive_dataforseo_labs_google_ranked_keywords_history', scope), false);
});

test('an explicitly empty exact MCP allowlist denies the whole admitted server', () => {
  assert.equal(mcpToolAllowedByScope('dataforseo__delete_everything', {
    reason: 'typed packet says no external tools',
    allowedServerSlugs: ['dataforseo'],
    allowedToolNames: [],
    maxTools: 8,
  }), false);
});

test('exact MCP authority does not collapse distinct configured namespace aliases', () => {
  const scope = {
    reason: 'compiled exact Notion server lease',
    allowedServerSlugs: ['notion-mcp'],
    allowedToolNames: ['notion-mcp__read_page'],
    maxTools: 1,
  };
  assert.equal(mcpToolAllowedByScope('mcp__notion-mcp__read_page', scope), true);
  assert.equal(
    mcpToolAllowedByScope('mcp__notion-server__read_page', scope),
    false,
    'generic -mcp/-server lookup aliases are not exact capability identity',
  );
});
