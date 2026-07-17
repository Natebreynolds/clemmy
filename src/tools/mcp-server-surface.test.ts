import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mcp-surface-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { createClementineMcpServer } = await import('./mcp-server.js');
const { harnessRunContextStorage } = await import('../runtime/harness/brackets.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('MCP tool_search is scoped to tools the active server actually registered', async () => {
  const server = createClementineMcpServer({
    sessionId: 'mcp-surface-test',
    allowedTools: ['memory_recall_all', 'tool_search'],
  });
  const registered = (server as any)._registeredTools as Record<string, {
    handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }>;

  assert.ok(registered.memory_recall_all);
  assert.ok(registered.tool_search);
  assert.ok(registered.ping, 'the health floor remains available');
  assert.equal(registered.workflow_update, undefined);

  const result = await registered.tool_search.handler({ query: 'update a workflow', limit: 20 });
  const body = JSON.parse(result.content[0].text) as { results: Array<{ name: string }> };
  const actualRegisteredCatalogNames = new Set(['memory_recall_all', 'ping', 'tool_search']);
  assert.ok(
    body.results.every((hit) => actualRegisteredCatalogNames.has(hit.name)),
    `unexpected search results: ${JSON.stringify(body.results)}`,
  );
  assert.equal(body.results.some((hit) => hit.name === 'workflow_update'), false);
});

test('MCP always-load metadata is additive and leaves unselected tools deferred', () => {
  const server = createClementineMcpServer({
    sessionId: 'mcp-deferral-test',
    alwaysLoadTools: ['memory_recall_all', 'tool_search'],
  });
  const registered = (server as any)._registeredTools as Record<string, { _meta?: Record<string, unknown> }>;

  assert.equal(registered.memory_recall_all?._meta?.['anthropic/alwaysLoad'], true);
  assert.equal(registered.tool_search?._meta?.['anthropic/alwaysLoad'], true);
  assert.equal(registered.workflow_update?._meta?.['anthropic/alwaysLoad'], undefined);
});

test('in-process MCP handlers inherit the exact SDK source turn', async () => {
  const server = createClementineMcpServer({
    sessionId: 'mcp-source-authority-test',
    sourceUserSeq: 91,
    allowedTools: ['source_authority_probe'],
  });
  server.tool(
    'source_authority_probe',
    'test-only source authority probe',
    {},
    async () => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ sourceUserSeq: harnessRunContextStorage.getStore()?.sourceUserSeq ?? null }),
      }],
    }),
  );
  const registered = (server as any)._registeredTools as Record<string, {
    handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }>;
  const result = await registered.source_authority_probe.handler({});
  assert.deepEqual(JSON.parse(result.content[0].text), { sourceUserSeq: 91 });
});
