import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpServerMatchesQuery } from './mcp-status-tools.js';
import type { ManagedMcpServer } from '../types.js';

const dataForSeoServer: ManagedMcpServer = {
  name: 'dataforseo',
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'dataforseo-mcp-server'],
  env: {
    DATAFORSEO_USERNAME: 'redacted',
    DATAFORSEO_PASSWORD: 'redacted',
  },
  description: 'DataForSEO SEO, SERP, keyword, backlink, domain, and on-page audit data',
  enabled: true,
  source: 'auto-detected',
};

test('mcpServerMatchesQuery matches multi-word queries regardless of term order', () => {
  assert.equal(mcpServerMatchesQuery(dataForSeoServer, 'seo dataforseo'), true);
  assert.equal(mcpServerMatchesQuery(dataForSeoServer, 'Data for SEO'), true);
  assert.equal(mcpServerMatchesQuery(dataForSeoServer, 'keyword audit'), true);
});

test('mcpServerMatchesQuery rejects queries whose terms are absent', () => {
  assert.equal(mcpServerMatchesQuery(dataForSeoServer, 'salesforce seo'), false);
});
