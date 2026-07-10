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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { MCPServer } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mcp-shim-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-mcp-shim-test\n', 'utf-8');

const {
  createMcpNamespaceShim,
  namespaceToolName,
  parseNamespacedTool,
  slugifyServerName,
  listMcpServerHealth,
  classifyMcpIntegrityScope,
} = await import('./mcp-namespace-shim.js');

test('MCP integrity classification separates reversible network writes from irreversible sends', () => {
  assert.deepEqual(
    classifyMcpIntegrityScope('browser__request', 'write', {
      method: 'PATCH',
      url: 'https://example.test/records/1',
      body: { status: 'reviewed' },
    }),
    {
      isIrreversibleSend: false,
      needsIntegrityChecks: true,
      shapeKey: 'mcp:http_mutation',
    },
  );
  assert.deepEqual(
    classifyMcpIntegrityScope('slack__postMessage', 'write', { channel: 'C1', text: 'hello' }),
    {
      isIrreversibleSend: true,
      needsIntegrityChecks: true,
      shapeKey: 'slack__postMessage',
    },
  );
});

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
  /** Return a custom callTool payload to exercise result-shape boundaries. */
  callToolResult?: unknown | ((toolName: string, args: Record<string, unknown> | null) => unknown | Promise<unknown>);
  /** Throw from callTool to simulate SDK/server invocation failures. */
  failCallTool?: Error;
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
      if (opts.failCallTool) throw opts.failCallTool;
      if ('callToolResult' in opts) {
        return typeof opts.callToolResult === 'function'
          ? await opts.callToolResult(toolName, args)
          : opts.callToolResult as any;
      }
      return [{ type: 'text', text: `${opts.name}:${toolName}` }] as any;
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
  // Tool name has to classify as read by decideToolApproval — bare 'search'
  // falls through to the conservative 'write' default and trips the approval
  // guard, which has nothing to do with routing.
  const a = makeFakeServer({ name: 'alpha', tools: [{ name: 'get_thing' }] });
  const b = makeFakeServer({ name: 'beta', tools: [{ name: 'get_thing' }] });
  const shim = createMcpNamespaceShim({ servers: [a, b], cacheToolsList: false });
  await shim.listTools(); // populate routing map
  await shim.callTool('beta__get_thing', { q: 'pinecone' });
  assert.deepEqual(a._calls, []);
  assert.deepEqual(b._calls, [{ tool: 'get_thing', args: { q: 'pinecone' } }]);
});

test('shim: normalizes malformed MCP text blocks into model-readable failure results', async () => {
  const dfs = makeFakeServer({
    name: 'dataforseo',
    tools: [{ name: 'get_page_content' }],
    callToolResult: [{ type: 'text' }],
  });
  const shim = createMcpNamespaceShim({ servers: [dfs], cacheToolsList: false });
  await shim.listTools();

  const result = await shim.callTool('dataforseo__get_page_content', { url: 'https://example.com' });

  assert.equal(Array.isArray(result), true);
  assert.equal((result as any).isError, true);
  const text = ((result as any[])[0] as { text?: string }).text ?? '';
  assert.match(text, /MCP_RESULT_INVALID/);
  assert.match(text, /text block without a string text field/);
});

test('shim: SDK invalid tools/call result validation errors become tool results instead of thrown run failures', async () => {
  const validationError = new Error(
    'MCP error -32602: Invalid tools/call result: [{"code":"invalid_union","errors":[[{"expected":"string","code":"invalid_type","path":["text"],"message":"Invalid input: expected string, received undefined"}]]}]',
  );
  const dfs = makeFakeServer({
    name: 'dataforseo',
    tools: [{ name: 'get_page_content' }],
    failCallTool: validationError,
  });
  const shim = createMcpNamespaceShim({ servers: [dfs], cacheToolsList: false });
  await shim.listTools();

  const result = await shim.callTool('dataforseo__get_page_content', { url: 'https://example.com' });

  assert.equal(Array.isArray(result), true);
  assert.equal((result as any).isError, true);
  const text = ((result as any[])[0] as { text?: string }).text ?? '';
  assert.match(text, /MCP_RESULT_INVALID/);
  assert.match(text, /Invalid tools\/call result/);
});

test('shim: MCP isError metadata gets self-correcting failure guidance', async () => {
  const prev = process.env.CLEMMY_MCP_ERROR_CORRECTIVE;
  process.env.CLEMMY_MCP_ERROR_CORRECTIVE = 'on';
  try {
    const content = [{ type: 'text', text: 'plain MCP failure body' }] as any;
    content.isError = true;
    const server = makeFakeServer({
      name: 'plainerr',
      tools: [{ name: 'get_failure_probe' }],
      callToolResult: content,
    });
    const shim = createMcpNamespaceShim({ servers: [server], cacheToolsList: false });
    await shim.listTools();

    const result = await shim.callTool('plainerr__get_failure_probe', {});
    const text = (result as any[])
      .map((block) => (typeof block?.text === 'string' ? block.text : ''))
      .join('\n');

    assert.match(text, /plainerr__get_failure_probe FAILED: plain MCP failure body/);
    assert.match(text, /Do ONE of these instead/);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_MCP_ERROR_CORRECTIVE;
    else process.env.CLEMMY_MCP_ERROR_CORRECTIVE = prev;
  }
});

test('shim: native MCP lifecycle telemetry is scoped to the harness session', async () => {
  const b = makeFakeServer({ name: 'obs', tools: [{ name: 'get_observability_probe' }] });
  const shim = createMcpNamespaceShim({ servers: [b], cacheToolsList: false });
  const { withHarnessRunContext, ToolCallsCounter } = await import('./harness/brackets.js');
  await shim.listTools();

  await withHarnessRunContext(
    { sessionId: 'mcp-observability-sess', counter: new ToolCallsCounter() },
    () => shim.callTool('obs__get_observability_probe', { q: 'session-scope' }),
  );

  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(TMP_HOME, 'state', 'tool-events', `${today}.ndjson`);
  assert.equal(existsSync(logPath), true, 'MCP lifecycle telemetry should be written into the test home');
  const events = readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { sessionId?: string; toolName?: string; phase?: string });
  const scoped = events.filter((event) => event.toolName === 'obs__get_observability_probe');
  assert.deepEqual(scoped.map((event) => event.phase), ['start', 'end']);
  assert.ok(scoped.every((event) => event.sessionId === 'mcp-observability-sess'), 'MCP lifecycle records must carry the active harness session');
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
  // T2.3 change: the broken server's tools no longer vanish silently —
  // it gets a single <slug>__unavailable stub the model can see. The
  // OTHER servers' tools are still present and unaffected.
  assert.deepEqual(names, ['alpha__a1', 'broken__unavailable', 'gamma__c1']);
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

test('shim: connect() returns quickly even when a server connect is slow', async () => {
  const slow: MCPServer = {
    name: 'slow',
    cacheToolsList: false,
    toolFilter: undefined,
    async connect() {
      await new Promise((resolve) => setTimeout(resolve, 250));
    },
    async close() {},
    async listTools() { return []; },
    async callTool() { return { content: [] } as any; },
    async invalidateToolsCache() {},
  };
  const shim = createMcpNamespaceShim({ servers: [slow], cacheToolsList: false });
  const start = Date.now();
  await shim.connect!();
  assert.ok(Date.now() - start < 100, 'non-blocking eager connect should not wait for slow MCP server');
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
  // The shim now backoffs on failure; clear backoff window for this
  // test by waiting past the first-failure 1s ladder step. We use a
  // shorter wait to keep the test fast and rely on the test runner's
  // global timeout to bound it.
  await new Promise((r) => setTimeout(r, 1100));
  await shim.connect!(); // retries because backoff window elapsed
  assert.equal(calls, 2);
});

// ─── T2.3 — server-unavailable surface ─────────────────────────────

test('T2.3: a failed server surfaces a <slug>__unavailable stub tool the model can see', async () => {
  const good = makeFakeServer({
    name: 'good',
    tools: [{ name: 'do_thing', description: 'fine', inputSchema: { type: 'object' } } as any],
  });
  const bad = makeFakeServer({
    name: 'bad-server',
    failConnect: true,
    tools: [],
  });
  const shim = createMcpNamespaceShim({ servers: [good, bad], cacheToolsList: false });
  const tools = await shim.listTools();

  // The good server's tool is present with namespaced name.
  assert.ok(tools.some((t) => t.name === 'good__do_thing'));
  // The bad server gets a single stub tool — NOT silently dropped.
  const stub = tools.find((t) => t.name === 'bad-server__unavailable');
  assert.ok(stub, 'expected an unavailable stub tool for the failed server');
  assert.match(stub!.description!, /UNAVAILABLE/);
  assert.match(stub!.description!, /bad-server/);
});

test('T2.3: callTool on the stub throws BoundaryError(mcp.server_unavailable)', async () => {
  const bad = makeFakeServer({
    name: 'bad-server',
    failConnect: true,
    tools: [],
  });
  const shim = createMcpNamespaceShim({ servers: [bad], cacheToolsList: false });
  await shim.listTools(); // populates routing + marks server unavailable
  await assert.rejects(
    () => shim.callTool('bad-server__unavailable', null),
    (err: Error) => {
      const isBoundary = (err as { kind?: unknown }).kind === 'mcp.server_unavailable';
      const hasUserMessage = typeof (err as { userMessage?: unknown }).userMessage === 'string';
      return isBoundary && hasUserMessage;
    },
  );
});

// --------------------------------------------------------------------
// Reconnect after transport death — "native MCP servers keep
// disconnecting" / stuck "CONNECTING…". A server that connected fine
// and whose transport LATER dies (failure surfaces in listTools, not
// connect) must (a) not appear permanently "connecting", and (b) be
// able to actually reconnect — the connect promise must be cleared on
// failure so ensureConnected re-runs server.connect() and respawns it.

/** Fake server with mutable failure + a live connect counter. */
function makeFlakyServer(name: string) {
  const state = { connects: 0, listShouldFail: false };
  const server: MCPServer = {
    name,
    cacheToolsList: false,
    toolFilter: undefined,
    async connect() { state.connects++; },
    async close() {},
    async listTools() {
      if (state.listShouldFail) throw new Error(`${name}: transport closed`);
      return [{ name: 'ping', description: 'p' }] as any;
    },
    async callTool() { return { content: [] } as any; },
    async invalidateToolsCache() {},
  };
  return { server, state };
}

test('shim: a transport death flips health to degraded — NOT stuck "connecting" (stale connect promise)', async () => {
  const { server, state } = makeFlakyServer('flaky-health-probe');
  const shim = createMcpNamespaceShim({ servers: [server], cacheToolsList: false });

  await shim.listTools();
  assert.equal(state.connects, 1);
  assert.equal(listMcpServerHealth().find((s) => s.slug === 'flaky-health-probe')?.state, 'connected');

  // Transport dies — next listTools surfaces the failure.
  state.listShouldFail = true;
  await shim.listTools();
  const snap = listMcpServerHealth().find((s) => s.slug === 'flaky-health-probe');
  assert.notEqual(snap?.state, 'connecting', 'a failed server must not read as "connecting" (stale in-flight promise)');
  assert.equal(snap?.state, 'degraded'); // 1 failure (< 3) → degraded
});

test('shim: after a transport death + backoff window, the server actually reconnects (connect() re-runs)', async () => {
  const { server, state } = makeFlakyServer('flaky-reconnect-probe');
  const shim = createMcpNamespaceShim({ servers: [server], cacheToolsList: false });

  await shim.listTools();
  assert.equal(state.connects, 1);

  // Kill the transport and let one pass record the failure (failureCount
  // = 1 → 1s backoff). The stale-promise bug would keep connects at 1
  // forever; the fix clears the promise so the post-backoff pass reconnects.
  state.listShouldFail = true;
  await shim.listTools();
  assert.equal(state.connects, 1, 'no reconnect yet — inside the backoff window');

  await new Promise((r) => setTimeout(r, 1100)); // first-failure backoff is 1000ms
  state.listShouldFail = false;
  await shim.listTools();

  assert.equal(state.connects, 2, 'server.connect() must re-run after the backoff window — a real reconnect');
  assert.equal(listMcpServerHealth().find((s) => s.slug === 'flaky-reconnect-probe')?.state, 'connected');
});

test('shim: a native MCP call credits its proven-path memo (closes the 0% MCP coverage)', async () => {
  // Native MCP bypasses wrapToolForHarness, so this shim is the ONLY place an MCP
  // outcome can reach procedural memory. Prove a successful native call scores the
  // matching memo end-to-end (it sat permanently at the 0.5 prior before).
  const prevOutcomes = process.env.CLEMMY_PROCEDURAL_OUTCOMES;
  process.env.CLEMMY_PROCEDURAL_OUTCOMES = 'on';
  const { resetMachineIdCacheForTests } = await import('./machine-id.js');
  resetMachineIdCacheForTests?.();
  const { rememberToolChoice, peekToolChoice } = await import('../memory/tool-choice-store.js');
  const { harnessRunContextStorage, ToolCallsCounter } = await import('./harness/brackets.js');
  try {

  // Unique intent + identifier so this is collision-proof against whatever else
  // lives in the shared store, and assert a DELTA rather than an absolute count.
  const INTENT = 'seo.mcp_credit_probe.unique';
  // `get_`-prefixed so it classifies as a READ (a bare verb falls to the
  // conservative write default and would trip the approval gate, not routing).
  rememberToolChoice({ intent: INTENT, choice: { kind: 'mcp', identifier: 'mcpcredit__get_rank_probe', testEvidence: 'worked' } });
  const before = peekToolChoice(INTENT)!.choice!.successCount ?? 0;

  const b = makeFakeServer({ name: 'mcpcredit', tools: [{ name: 'get_rank_probe' }] });
  const shim = createMcpNamespaceShim({ servers: [b], cacheToolsList: false });
  await shim.listTools();
  await harnessRunContextStorage.run(
    { sessionId: 'mcp-credit-sess', counter: new ToolCallsCounter() },
    () => shim.callTool('mcpcredit__get_rank_probe', { q: 'x' }),
  );
  assert.equal(peekToolChoice(INTENT)!.choice!.successCount ?? 0, before + 1, 'the native MCP call scored the memo (was bypassing the credit boundary entirely)');
  } finally {
    if (prevOutcomes === undefined) delete process.env.CLEMMY_PROCEDURAL_OUTCOMES; else process.env.CLEMMY_PROCEDURAL_OUTCOMES = prevOutcomes;
    resetMachineIdCacheForTests?.();
  }
});

after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});
