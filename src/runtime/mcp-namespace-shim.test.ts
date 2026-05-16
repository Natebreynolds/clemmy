/**
 * Run: npx tsx --test src/runtime/mcp-namespace-shim.test.ts
 *
 * Covers the four contract guarantees the shim has to keep:
 *   1) Collision avoidance — two underlying servers exposing the same
 *      tool name end up with distinct `<server>__<tool>` names so the
 *      Agents SDK never trips its duplicate-name check.
 *   2) Dispatch — calling a namespaced tool routes to the original
 *      server with the ORIGINAL tool name and the original args.
 *   3) listTools flattening — listTools() concatenates every
 *      underlying server's tools, in stable order.
 *   4) Lifecycle — connect() reaches every server, close() reaches
 *      every server, and one server failing does not break the rest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MCPServer } from '@openai/agents';
import {
  createMcpNamespaceShim,
  namespaceToolName,
  parseNamespacedTool,
  slugifyServerName,
} from './mcp-namespace-shim.js';

/**
 * Minimal MCPServer-shaped fake. We don't extend the SDK's classes
 * because they expect a real transport — for unit tests we just need
 * the shape the shim consumes.
 */
type FakeTool = { name: string; description?: string; inputSchema?: unknown };

function makeFakeServer(opts: {
  name: string;
  tools: FakeTool[];
  /** Throw from listTools to simulate a broken server. */
  failListTools?: boolean;
  /** Throw from connect to simulate a server that can't be reached. */
  failConnect?: boolean;
  /** Throw from close to verify the shim swallows close errors. */
  failClose?: boolean;
}): MCPServer & {
  _calls: { tool: string; args: Record<string, unknown> | null }[];
  _connected: number;
  _closed: number;
} {
  const state = { connected: 0, closed: 0, calls: [] as { tool: string; args: Record<string, unknown> | null }[] };
  const server: MCPServer = {
    name: opts.name,
    cacheToolsList: false,
    toolFilter: undefined,
    async connect() {
      if (opts.failConnect) throw new Error(`${opts.name}: connect failed`);
      state.connected++;
    },
    async close() {
      if (opts.failClose) throw new Error(`${opts.name}: close failed`);
      state.closed++;
    },
    async listTools() {
      if (opts.failListTools) throw new Error(`${opts.name}: listTools failed`);
      return opts.tools as any;
    },
    async callTool(toolName, args) {
      state.calls.push({ tool: toolName, args });
      return { content: [{ type: 'text', text: `${opts.name}:${toolName}` }] } as any;
    },
    async invalidateToolsCache() {},
  };
  // Attach test-inspection handles. Define as getters on the server
  // itself so each access reads live state — Object.assign would
  // snapshot getter values at copy time, hiding mutations.
  Object.defineProperties(server, {
    _calls: { get: () => state.calls, enumerable: true },
    _connected: { get: () => state.connected, enumerable: true },
    _closed: { get: () => state.closed, enumerable: true },
  });
  return server as any;
}

// --------------------------------------------------------------------
// slugifyServerName

test('slugifyServerName: lowercases and substitutes unsafe chars', () => {
  assert.equal(slugifyServerName('Bright Data'), 'bright_data');
  assert.equal(slugifyServerName('ElevenLabs'), 'elevenlabs');
  assert.equal(slugifyServerName('hostinger-mcp'), 'hostinger-mcp');
  assert.equal(slugifyServerName('  weird   name  '), 'weird_name');
  assert.equal(slugifyServerName(''), 'server');
});

// --------------------------------------------------------------------
// namespaceToolName / parseNamespacedTool

test('namespaceToolName + parseNamespacedTool: round-trip preserves both halves', () => {
  const ns = namespaceToolName('dataforseo', 'serp_organic_live_advanced');
  assert.equal(ns, 'dataforseo__serp_organic_live_advanced');
  const parsed = parseNamespacedTool(ns);
  assert.deepEqual(parsed, { serverSlug: 'dataforseo', toolName: 'serp_organic_live_advanced' });
});

test('parseNamespacedTool: returns null on malformed input', () => {
  assert.equal(parseNamespacedTool('no_separator_here'), null);
  assert.equal(parseNamespacedTool('__leading'), null);
  assert.equal(parseNamespacedTool('trailing__'), null);
  assert.equal(parseNamespacedTool(''), null);
});

// --------------------------------------------------------------------
// 1) Collision avoidance

test('shim: rewrites identical tool names from different servers to unique namespaced names', async () => {
  const a = makeFakeServer({ name: 'alpha', tools: [{ name: 'search', description: 'Alpha search' }] });
  const b = makeFakeServer({ name: 'beta', tools: [{ name: 'search', description: 'Beta search' }] });
  const shim = createMcpNamespaceShim({ servers: [a, b], cacheToolsList: false });
  const tools = await shim.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['alpha__search', 'beta__search']);
  // Descriptions retain origin info so the model can tell them apart.
  const alphaTool = tools.find((t) => t.name === 'alpha__search')!;
  assert.match(alphaTool.description ?? '', /\[alpha\]/);
});

test('shim: collides slugs from differently-spelled-but-same server names get suffixed', async () => {
  // "Foo Bar" → foo_bar, "foo-bar" → foo-bar so these do NOT collide.
  // Construct a true collision: "Foo Bar" and "foo bar".
  const a = makeFakeServer({ name: 'Foo Bar', tools: [{ name: 't' }] });
  const b = makeFakeServer({ name: 'foo bar', tools: [{ name: 't' }] });
  const shim = createMcpNamespaceShim({ servers: [a, b], cacheToolsList: false });
  const tools = await shim.listTools();
  const names = new Set(tools.map((t) => t.name));
  // First wins as foo_bar, second is foo_bar_2. Use a set so we don't
  // depend on Array.sort's lexicographic ordering of '_' vs '2'.
  assert.deepEqual(names, new Set(['foo_bar__t', 'foo_bar_2__t']));
});

// --------------------------------------------------------------------
// 2) Dispatch

test('shim: callTool routes to the right server with the original tool name', async () => {
  const a = makeFakeServer({ name: 'alpha', tools: [{ name: 'search' }] });
  const b = makeFakeServer({ name: 'beta', tools: [{ name: 'search' }] });
  const shim = createMcpNamespaceShim({ servers: [a, b], cacheToolsList: false });
  await shim.listTools(); // populate routing map
  await shim.callTool('beta__search', { q: 'pinecone' });
  assert.deepEqual(a._calls, []);
  assert.deepEqual(b._calls, [{ tool: 'search', args: { q: 'pinecone' } }]);
});

test('shim: callTool throws a clear error for an unknown tool name', async () => {
  const a = makeFakeServer({ name: 'alpha', tools: [{ name: 'search' }] });
  const shim = createMcpNamespaceShim({ servers: [a], cacheToolsList: false });
  await shim.listTools();
  await assert.rejects(
    () => shim.callTool('nope__whatever', null),
    /Unknown MCP tool/,
  );
});

// --------------------------------------------------------------------
// 3) listTools flattening

test('shim: listTools concatenates every server in registration order', async () => {
  const a = makeFakeServer({ name: 'alpha', tools: [{ name: 'a1' }, { name: 'a2' }] });
  const b = makeFakeServer({ name: 'beta', tools: [{ name: 'b1' }] });
  const c = makeFakeServer({ name: 'gamma', tools: [{ name: 'c1' }, { name: 'c2' }, { name: 'c3' }] });
  const shim = createMcpNamespaceShim({ servers: [a, b, c], cacheToolsList: false });
  const tools = await shim.listTools();
  assert.equal(tools.length, 6);
  // Per-server contributions are present.
  for (const expected of ['alpha__a1', 'alpha__a2', 'beta__b1', 'gamma__c1', 'gamma__c2', 'gamma__c3']) {
    assert.ok(tools.find((t) => t.name === expected), `missing ${expected}`);
  }
});

test('shim: one server failing listTools does not poison the others', async () => {
  const a = makeFakeServer({ name: 'alpha', tools: [{ name: 'a1' }] });
  const broken = makeFakeServer({ name: 'broken', tools: [], failListTools: true });
  const c = makeFakeServer({ name: 'gamma', tools: [{ name: 'c1' }] });
  const shim = createMcpNamespaceShim({ servers: [a, broken, c], cacheToolsList: false });
  const tools = await shim.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['alpha__a1', 'gamma__c1']);
});

test('shim: cacheToolsList=true memoizes listTools so underlying servers are queried once', async () => {
  let calls = 0;
  const a: MCPServer = {
    name: 'alpha',
    cacheToolsList: false,
    toolFilter: undefined,
    async connect() {},
    async close() {},
    async listTools() {
      calls++;
      return [{ name: 't1' }] as any;
    },
    async callTool() {
      return { content: [] } as any;
    },
    async invalidateToolsCache() {},
  };
  const shim = createMcpNamespaceShim({ servers: [a], cacheToolsList: true });
  await shim.listTools();
  await shim.listTools();
  await shim.listTools();
  assert.equal(calls, 1);
  // Invalidate forces re-query on next call.
  await shim.invalidateToolsCache!();
  await shim.listTools();
  assert.equal(calls, 2);
});

// --------------------------------------------------------------------
// 4) Lifecycle

test('shim: connect() reaches every underlying server', async () => {
  const a = makeFakeServer({ name: 'alpha', tools: [] });
  const b = makeFakeServer({ name: 'beta', tools: [] });
  const shim = createMcpNamespaceShim({ servers: [a, b], cacheToolsList: false });
  await shim.connect!();
  assert.equal(a._connected, 1);
  assert.equal(b._connected, 1);
});

test('shim: connect() tolerates one server failing', async () => {
  const a = makeFakeServer({ name: 'alpha', tools: [], failConnect: true });
  const b = makeFakeServer({ name: 'beta', tools: [] });
  const shim = createMcpNamespaceShim({ servers: [a, b], cacheToolsList: false });
  // Should not throw — the shim absorbs and logs.
  await shim.connect!();
  assert.equal(b._connected, 1);
});

test('shim: close() reaches every server and swallows close errors', async () => {
  const a = makeFakeServer({ name: 'alpha', tools: [], failClose: true });
  const b = makeFakeServer({ name: 'beta', tools: [] });
  const shim = createMcpNamespaceShim({ servers: [a, b], cacheToolsList: false });
  await shim.close!();
  // b.close ran; a.close threw but did not bubble.
  assert.equal(b._closed, 1);
});

test('shim: repeated connect() calls do NOT respawn underlying servers', async () => {
  // Regression: the OpenAI Agents SDK's MCPServerStdio.connect()
  // unconditionally spawns a fresh child process. Without per-server
  // deduping inside the shim, every shim.connect() (called by the
  // Runner before each run and by the Codex tool-defs builder) would
  // leak N orphan stdio children.
  const a = makeFakeServer({ name: 'alpha', tools: [] });
  const b = makeFakeServer({ name: 'beta', tools: [] });
  const shim = createMcpNamespaceShim({ servers: [a, b], cacheToolsList: false });
  await shim.connect!();
  await shim.connect!();
  await shim.connect!();
  assert.equal(a._connected, 1);
  assert.equal(b._connected, 1);
});

test('shim: listTools() does not re-connect after the initial shim.connect()', async () => {
  const a = makeFakeServer({ name: 'alpha', tools: [{ name: 'one' }] });
  const shim = createMcpNamespaceShim({ servers: [a], cacheToolsList: false });
  await shim.connect!();
  await shim.listTools();
  await shim.listTools();
  // cacheToolsList=false means listTools queries the server every call,
  // but connect() must remain a one-shot.
  assert.equal(a._connected, 1);
});

test('shim: close() then connect() respawns the underlying server', async () => {
  const a = makeFakeServer({ name: 'alpha', tools: [] });
  const shim = createMcpNamespaceShim({ servers: [a], cacheToolsList: false });
  await shim.connect!();
  await shim.close!();
  await shim.connect!();
  assert.equal(a._connected, 2);
});

test('shim: failed connect() does not stick — next call retries', async () => {
  let calls = 0;
  let shouldFail = true;
  const a: MCPServer = {
    name: 'flaky',
    cacheToolsList: false,
    toolFilter: undefined,
    async connect() {
      calls++;
      if (shouldFail) throw new Error('boom');
    },
    async close() {},
    async listTools() { return []; },
    async callTool() { return { content: [] } as any; },
    async invalidateToolsCache() {},
  };
  const shim = createMcpNamespaceShim({ servers: [a], cacheToolsList: false });
  await shim.connect!(); // first attempt fails — shim absorbs + logs
  shouldFail = false;
  await shim.connect!(); // retries because we cleared the cached promise on error
  assert.equal(calls, 2);
});
