import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-toolsearch-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
const { registerToolSearchTool } = await import('./tool-search-tool.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { getHotSet, _resetHotSetForTest } = await import('../agents/tool-hotset.js');

type Handler = (input: { query: string; limit?: number }) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

interface Captured {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: Handler;
}

function captureToolSearch(): Captured {
  let captured: Captured | undefined;
  const fakeServer = {
    tool(name: string, description: string, schema: Record<string, unknown>, handler: Handler): void {
      captured = { name, description, schema, handler };
    },
  };
  registerToolSearchTool(fakeServer as unknown as McpServer);
  assert.ok(captured, 'tool_search should register');
  return captured!;
}

async function runSearch(handler: Handler, query: string, sessionId?: string) {
  const result = await (sessionId
    ? (withToolOutputContext({ sessionId }, () => handler({ query })) as Promise<{ content: Array<{ type: 'text'; text: string }> }>)
    : handler({ query }));
  return JSON.parse(result.content[0].text) as {
    query: string;
    results: Array<{ name: string; summary: string }>;
    schemas: Record<string, unknown>;
  };
}

test('registers as read-only tool_search with a query param', () => {
  const t = captureToolSearch();
  assert.equal(t.name, 'tool_search');
  assert.ok('query' in t.schema, 'schema exposes a query field');
});

test('returns ranked names + summaries and full schemas for the top hits', async () => {
  const t = captureToolSearch();
  const out = await runSearch(t.handler, 'schedule a recurring workflow');
  assert.ok(out.results.length > 0 && out.results.length <= 8, 'returns up to 8 results');
  assert.ok(out.results.every((r) => typeof r.name === 'string'), 'each result has a name');
  // Top hit should be schema-bearing and on-topic.
  const schemaNames = Object.keys(out.schemas);
  assert.ok(schemaNames.length >= 1 && schemaNames.length <= 3, 'schemas for up to 3 top hits');
  assert.ok(out.results.slice(0, 3).some((r) => r.name === 'workflow_schedule'), 'on-topic tool ranks in top 3');
  // A returned schema is a real JSON Schema object.
  const first = out.schemas[schemaNames[0]] as { type?: string; properties?: unknown };
  assert.ok(first && typeof first === 'object' && ('properties' in first || 'type' in first), 'schema looks like JSON Schema');
});

test('records the schema-bearing hits to the session hot-set', async () => {
  _resetHotSetForTest();
  const t = captureToolSearch();
  const sid = 'search-sess-1';
  const out = await runSearch(t.handler, 'read a clipped tool result', sid);
  const schemaNames = Object.keys(out.schemas);
  const hot = getHotSet(sid);
  assert.ok(schemaNames.length > 0);
  for (const n of schemaNames) assert.ok(hot.includes(n), `${n} should be recorded to the LRU`);
});

test('no session context still returns results (recording is a no-op)', async () => {
  const t = captureToolSearch();
  const out = await runSearch(t.handler, 'send an email');
  assert.ok(out.results.length > 0);
});
