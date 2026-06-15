/**
 * Run: npx tsx --test src/runtime/mcp-namespace-shim.recall.test.ts
 *
 * Native MCP tool results used to land RAW in chat history (they bypass
 * wrapToolForHarness), so a large dump could blow the context window with no
 * recall path. This proves the shim now routes results through the shared
 * formatRecallableToolText primitive: a LARGE result is clipped + parked for
 * recall_tool_result; a SMALL one is byte-identical.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mcp-recall-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MCPServer } from '@openai/agents';

const { createMcpNamespaceShim, namespaceToolName, slugifyServerName } = await import('./mcp-namespace-shim.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('./harness/brackets.js');
const { getToolOutput, createSession } = await import('./harness/eventlog.js');
const { saveProactivityPolicy } = await import('../agents/proactivity-policy.js');

// The clip path is what's under test, not approval — auto-approve so the fresh
// test home's strict default doesn't gate the (write-classified) MCP call.
saveProactivityPolicy({ autoApproveScope: 'yolo' });

function makeServer(name: string, toolName: string, text: string): MCPServer {
  return {
    name,
    cacheToolsList: false,
    toolFilter: undefined,
    async connect() {},
    async close() {},
    async listTools() {
      return [{ name: toolName, description: 'dump', inputSchema: { type: 'object' } }] as unknown as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool() {
      return [{ type: 'text', text }] as unknown as Awaited<ReturnType<MCPServer['callTool']>>;
    },
    async invalidateToolsCache() {},
  } as unknown as MCPServer;
}

test('MCP shim clips + parks a LARGE native result for recall (context-blowup fix)', async () => {
  const big = `RESULT_START ${'x'.repeat(40000)} RESULT_END`; // > DEFAULT_TOOL_RESULT_MAX_CHARS (12000)
  const slug = 'bigserver';
  const tool = 'serp_organic_live_advanced';
  const shim = createMcpNamespaceShim({ servers: [makeServer(slug, tool, big)] });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sess = createSession({ kind: 'chat' });

  await withHarnessRunContext({ sessionId: sess.id, counter: new ToolCallsCounter(100) }, async () => {
    await shim.listTools();
    const res = await shim.callTool(namespaced, {});
    const text = (res as Array<{ text?: string }>).map((b) => b.text || '').join('\n');
    assert.ok(text.length < big.length, 'large result was clipped, not returned raw');
    const m = text.match(/mcp_[A-Za-z0-9_]+_\d+/);
    assert.ok(m, 'the clip surfaces a recall callId');
    const parked = getToolOutput(sess.id, m![0]);
    assert.ok(parked && parked.output.includes('RESULT_END'), 'the FULL output is parked for recall_tool_result');
  });
});

test('MCP shim leaves a SMALL native result byte-identical (no recall overhead)', async () => {
  const small = 'serp rank 4, volume 320';
  const slug = 'smallserver';
  const tool = 'serp_organic_live_advanced';
  const shim = createMcpNamespaceShim({ servers: [makeServer(slug, tool, small)] });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sess = createSession({ kind: 'chat' });

  await withHarnessRunContext({ sessionId: sess.id, counter: new ToolCallsCounter(100) }, async () => {
    await shim.listTools();
    const res = await shim.callTool(namespaced, {});
    const text = (res as Array<{ text?: string }>).map((b) => b.text || '').join('\n');
    assert.equal(text, small, 'small result passes through unchanged');
    assert.ok(!/recall_tool_result/.test(text), 'no recall note on a small result');
  });
});
