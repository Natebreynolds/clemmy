import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpToolAllowedByScope } from './mcp-tool-authority.js';

test('MCP authority preserves legacy/escape hatches and denies explicit local-only scope', () => {
  const tool = 'dataforseo__serp_organic_live';
  assert.equal(mcpToolAllowedByScope(tool, undefined), true, 'undefined is legacy allow');
  assert.equal(mcpToolAllowedByScope(tool, null), false, 'null is explicit deny');
  assert.equal(mcpToolAllowedByScope(tool, {
    reason: 'local only',
    allowedServerSlugs: [],
    maxTools: 0,
  }), false);
  assert.equal(mcpToolAllowedByScope(tool, {
    reason: 'legacy escape hatch',
    allowAll: true,
  }), true);
  assert.equal(mcpToolAllowedByScope(tool, {
    reason: 'explicit zero-width escape hatch',
    allowAll: true,
    maxTools: 0,
  }), false, 'a zero cap is a hard authority boundary even with allowAll');
  assert.equal(mcpToolAllowedByScope(tool, {
    reason: 'bounded fail-open',
    failOpenCandidate: true,
    maxTools: 8,
  }), true);
  assert.equal(mcpToolAllowedByScope(tool, {
    reason: 'zero-width fail-open',
    failOpenCandidate: true,
    maxTools: 0,
  }), false);
});

test('MCP authority enforces server and tool-pattern scope on guessed names', () => {
  const scope = {
    reason: 'SEO reads only',
    allowedServerSlugs: ['dataforseo'],
    toolPatterns: ['serp|keyword'],
    maxTools: 8,
  };
  assert.equal(mcpToolAllowedByScope('dataforseo__serp_organic_live', scope), true);
  assert.equal(mcpToolAllowedByScope('dataforseo__keyword_suggestions', scope), true);
  assert.equal(mcpToolAllowedByScope('dataforseo__delete_task', scope), false);
  assert.equal(mcpToolAllowedByScope('salesforce__serp_report', scope), false);
  assert.equal(
    mcpToolAllowedByScope('evil_dataforseo_proxy__serp_report', scope),
    false,
    'a similar substring is not a canonical server alias',
  );
  assert.equal(
    mcpToolAllowedByScope('dataforseo_mcp_server__serp_report', scope),
    true,
    'generic MCP/server suffixes preserve the canonical server identity',
  );
});
