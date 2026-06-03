/**
 * Run: npx tsx --test src/runtime/mcp-namespace-shim.fanout.test.ts
 *
 * INTEGRATION test of the native-MCP fan-out hook. Native MCP tools bypass
 * wrapToolForHarness, so this is the one new live surface the unit tests in
 * fanout-advisory.test.ts don't exercise end-to-end. Here we drive the REAL
 * createMcpNamespaceShim -> callTool -> appendMcpFanoutAdvisory path with the
 * harness run-context installed (exactly how loop.ts runs it), against a fake
 * underlying server — no app, no daemon, no API. This is the "different way"
 * to prove the wiring before the release.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MCPServer } from '@openai/agents';
import { createMcpNamespaceShim, namespaceToolName, slugifyServerName } from './mcp-namespace-shim.js';
import { withHarnessRunContext, ToolCallsCounter, type HarnessRunContext } from './harness/brackets.js';

// Fake underlying server that returns the REAL CallToolResultContent shape
// (a content-block ARRAY), so appendMcpFanoutAdvisory's Array.isArray gate and
// content-append behave exactly as in production.
function makeFakeServer(name: string, toolName: string): MCPServer {
  return {
    name,
    cacheToolsList: false,
    toolFilter: undefined,
    async connect() {},
    async close() {},
    async listTools() {
      return [{ name: toolName, description: 'read', inputSchema: { type: 'object' } }] as unknown as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool(_toolName: string, _args: Record<string, unknown> | null) {
      // A read result that does NOT contain any of the test's target domains,
      // so the independence guard never spuriously suppresses the batch.
      return [{ type: 'text', text: 'serp rank 4, volume 320' }] as unknown as Awaited<ReturnType<MCPServer['callTool']>>;
    },
    async invalidateToolsCache() {},
  } as unknown as MCPServer;
}

function ctx(sessionId: string): HarnessRunContext {
  return { sessionId, counter: new ToolCallsCounter(100) };
}

test('MCP shim appends the run_worker advisory on the 3rd serial same-shape native call', async () => {
  const slug = 'dataforseo';
  const tool = 'serp_organic_live_advanced';
  const shim = createMcpNamespaceShim({ servers: [makeFakeServer(slug, tool)] });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);

  await withHarnessRunContext(ctx('sess-mcp-int-1'), async () => {
    await shim.listTools(); // populate the routing map
    const r1 = JSON.stringify(await shim.callTool(namespaced, { target: 'alpha-firm-one.com' }));
    const r2 = JSON.stringify(await shim.callTool(namespaced, { target: 'beta-firm-twob.com' }));
    const r3 = JSON.stringify(await shim.callTool(namespaced, { target: 'gamma-firm-3xx.com' }));
    assert.ok(!/FAN-OUT NOW/.test(r1), 'call 1: no advisory');
    assert.ok(!/FAN-OUT NOW/.test(r2), 'call 2: no advisory');
    assert.ok(/FAN-OUT NOW/.test(r3) && /run_worker/.test(r3), 'call 3: advisory appended via the real shim path');
    assert.ok(/serp rank 4/.test(r3), 'original MCP result content is preserved alongside the advisory');
  });
});

test('MCP shim emits the forEach variant (not run_worker) when the session is a workflow step', async () => {
  const slug = 'firecrawl';
  const tool = 'scrape';
  const shim = createMcpNamespaceShim({ servers: [makeFakeServer(slug, tool)] });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);

  await withHarnessRunContext(ctx('workflow:run-9:step-enrich'), async () => {
    await shim.listTools();
    await shim.callTool(namespaced, { url: 'one-firm-aaaa.com' });
    await shim.callTool(namespaced, { url: 'two-firm-bbbb.com' });
    const r3 = JSON.stringify(await shim.callTool(namespaced, { url: 'three-firm-cc.com' }));
    assert.ok(/forEach/.test(r3), 'workflow step gets the forEach mechanism');
    assert.ok(!/FAN-OUT NOW/.test(r3), 'workflow step does NOT get the run_worker imperative');
  });
});

test('MCP shim leaves results untouched when there is no harness session context', async () => {
  const slug = 'dataforseo';
  const tool = 'serp_organic_live_advanced';
  const shim = createMcpNamespaceShim({ servers: [makeFakeServer(slug, tool)] });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);

  // No withHarnessRunContext wrapper => getStore() is undefined => no-op.
  await shim.listTools();
  let last = '';
  for (let i = 0; i < 5; i++) {
    last = JSON.stringify(await shim.callTool(namespaced, { target: `firm-${i}-xxxxxx.com` }));
  }
  assert.ok(!/FAN-OUT NOW/.test(last), 'no advisory without a session context (cannot key the bucket)');
});
