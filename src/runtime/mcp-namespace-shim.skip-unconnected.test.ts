/**
 * Run: npx tsx --test src/runtime/mcp-namespace-shim.skip-unconnected.test.ts
 *
 * Bounded-connect attach regression: the Agents SDK awaits the shim's
 * listTools() BEFORE the first model request, and buildFlattenedTools used to
 * `await ensureConnected(server)` with the FULL 30s connect timeout — so one
 * server still mid-connect (or starved by the daemon's synchronous DB work)
 * stalled the whole turn. With MCP_ATTACH_CONNECTED_ONLY=on (default), a
 * not-yet-connected server gets only a SHORT budget to finish its handshake this
 * turn: a fast/idle server attaches its real tools immediately; a cold/starved
 * one keeps warming in the BACKGROUND and surfaces a stub instead of blocking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpNamespaceShim, listMcpServerHealth } from './mcp-namespace-shim.js';

type Opts = { connect: 'fast' | 'slow' | 'hang' | 'fail'; connectMs?: number; tools?: { name: string }[] };

// Hanging connects are released at file teardown so no promise leaks (which
// makes node:test abort with "event loop resolved while pending"); a keepalive
// interval keeps the loop alive for the whole file while hangs are pending.
const hangReleasers: Array<() => void> = [];
const keepAlive = setInterval(() => { /* keep loop alive while hangs pend */ }, 100_000);
test.after(() => { clearInterval(keepAlive); hangReleasers.forEach((r) => r()); });

/** Minimal fake MCPServer. `hang` does not resolve connect until teardown. */
function fakeServer(name: string, opts: Opts): any {
  let connected = false;
  return {
    name,
    cacheToolsList: true,
    async connect() {
      if (opts.connect === 'fast') { connected = true; return; }
      if (opts.connect === 'fail') { throw new Error(`${name} connect refused`); }
      if (opts.connect === 'slow') { await new Promise((r) => setTimeout(r, opts.connectMs ?? 400)); connected = true; return; }
      await new Promise<void>((resolve) => hangReleasers.push(() => { connected = true; resolve(); }));
    },
    async close() {},
    async listTools() {
      if (!connected) throw new Error(`${name} not connected`);
      return (opts.tools ?? []).map((t) => ({ name: t.name, description: `tool ${t.name}`, inputSchema: { type: 'object', properties: {} } }));
    },
    async callTool() { return []; },
    async invalidateToolsCache() {},
  };
}

test('a HANGING server does not block the turn; a fast server still attaches its real tools', async () => {
  process.env.MCP_ATTACH_CONNECTED_ONLY = 'on';
  process.env.MCP_ATTACH_CONNECT_BUDGET_MS = '200';
  const fast = fakeServer('fast', { connect: 'fast', tools: [{ name: 'do' }] });
  const hang = fakeServer('hang', { connect: 'hang' });
  const shim = createMcpNamespaceShim({ servers: [fast, hang] });

  const t0 = Date.now();
  const tools1 = await shim.listTools();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1500, `turn proceeded near the budget, not the 30s connect timeout (~${elapsed}ms)`);
  assert.ok(tools1.some((t: any) => t.name === 'fast__do'), 'fast server attaches its real tool this turn');
  assert.ok(tools1.some((t: any) => t.name === 'hang__unavailable'), 'hanging server surfaces a stub, did not block');
  delete process.env.MCP_ATTACH_CONNECT_BUDGET_MS;
});

test('budget-exceeded server self-heals: real tools appear once the background connect finishes', async () => {
  process.env.MCP_ATTACH_CONNECTED_ONLY = 'on';
  process.env.MCP_ATTACH_CONNECT_BUDGET_MS = '120';
  const slow = fakeServer('slow', { connect: 'slow', connectMs: 350, tools: [{ name: 'q' }] });
  const shim = createMcpNamespaceShim({ servers: [slow] });

  const tools1 = await shim.listTools();              // budget 120ms < connect 350ms → stub
  assert.ok(tools1.some((t: any) => t.name === 'slow__unavailable'), 'turn 1: stub (still warming)');
  await new Promise((r) => setTimeout(r, 400));        // let the background connect finish
  const tools2 = await shim.listTools();              // now connected → real tools (no stale cache)
  assert.ok(tools2.some((t: any) => t.name === 'slow__q'), 'turn 2: real tool surfaced after warm');
  assert.ok(!tools2.some((t: any) => t.name.endsWith('__unavailable')), 'no stub once connected');
  delete process.env.MCP_ATTACH_CONNECT_BUDGET_MS;
});

test('all-connected surface IS cached (fast path) — no per-turn re-list once stable', async () => {
  process.env.MCP_ATTACH_CONNECTED_ONLY = 'on';
  let listCalls = 0;
  const a = fakeServer('a', { connect: 'fast', tools: [{ name: 'x' }] });
  const origList = a.listTools.bind(a);
  a.listTools = async () => { listCalls += 1; return origList(); };
  const shim = createMcpNamespaceShim({ servers: [a] });

  await shim.listTools();  // turn 1: connects within budget → real tools → cached
  const afterFirst = listCalls;
  await shim.listTools();  // turn 2: served from cache, no new child listTools
  assert.equal(listCalls, afterFirst, 'all-connected surface cached; child not re-queried');
});

test('legacy mode (MCP_ATTACH_CONNECTED_ONLY=off): a hanging connect DOES block inline up to the timeout', async () => {
  process.env.MCP_ATTACH_CONNECTED_ONLY = 'off';
  process.env.MCP_CONNECT_TIMEOUT_MS = '300'; // short so the blocking path is observable
  const hang = fakeServer('hang', { connect: 'hang' });
  const shim = createMcpNamespaceShim({ servers: [hang] });
  const t0 = Date.now();
  const tools = await shim.listTools(); // legacy: awaits full ensureConnected → times out at 300ms → stub
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 250, `legacy path blocked on the connect (~${elapsed}ms)`);
  assert.ok(tools.some((t: any) => t.name === 'hang__unavailable'), 'emits a stub after the timeout');
  delete process.env.MCP_CONNECT_TIMEOUT_MS;
  process.env.MCP_ATTACH_CONNECTED_ONLY = 'on';
});

test('a connect FAILURE is marked exactly once (no double markServerFailed)', async () => {
  process.env.MCP_ATTACH_CONNECTED_ONLY = 'on';
  const slug = 'failonce' + Date.now();
  const bad = fakeServer(slug, { connect: 'fail' });
  const shim = createMcpNamespaceShim({ servers: [bad] });
  await shim.listTools(); // connect fails once
  const health = listMcpServerHealth().find((h) => h.slug === slug);
  assert.ok(health, 'health recorded');
  assert.equal(health!.failureCount, 1, 'single failure → failureCount 1, not 2 (no double-mark)');
});

test('stub flavor: a still-WARMING server says CONNECTING; a FAILED server says UNAVAILABLE', async () => {
  process.env.MCP_ATTACH_CONNECTED_ONLY = 'on';
  process.env.MCP_ATTACH_CONNECT_BUDGET_MS = '100';
  const warming = fakeServer('warming' + Date.now(), { connect: 'hang' });
  const failed = fakeServer('failed' + Date.now(), { connect: 'fail' });
  const shim = createMcpNamespaceShim({ servers: [warming, failed] });
  const tools = await shim.listTools();
  const warmStub = tools.find((t: any) => t.name.startsWith('warming') && t.name.endsWith('__unavailable'));
  const failStub = tools.find((t: any) => t.name.startsWith('failed') && t.name.endsWith('__unavailable'));
  assert.match(warmStub.description, /CONNECTING/, 'warming server → connecting stub');
  assert.match(failStub.description, /UNAVAILABLE/, 'failed server → unavailable stub');
  delete process.env.MCP_ATTACH_CONNECT_BUDGET_MS;
});

test('prewarm() reports allConnected and connects servers for later turns', async () => {
  process.env.MCP_ATTACH_CONNECTED_ONLY = 'on';
  const a = fakeServer('a', { connect: 'fast', tools: [{ name: 'x' }] });
  const b = fakeServer('b', { connect: 'fail' });
  const shim = createMcpNamespaceShim({ servers: [a, b] });
  const allOk = await (shim as any).prewarm();
  assert.equal(allOk, false, 'one server failed → not all connected');
  const tools = await shim.listTools();
  assert.ok(tools.some((t: any) => t.name === 'a__x'), 'pre-warmed server attaches real tools');
});

// ── Discovery waits; the stub names that door; reconnect is per server ───────
// Live 2026-10-13: the first search after an install met a server still
// spawning (npx + remote handshake, well past the 2.5s attach budget), was
// handed the connecting stub, reconnected the server (which dropped every
// connection) and searched four more times: nine discovery calls and ninety
// seconds before one delete. A search is the model asking for the tools now.

test('a discovery listing holds for a warming server until its deadline and returns the real tools', async () => {
  process.env.MCP_ATTACH_CONNECTED_ONLY = 'on';
  process.env.MCP_ATTACH_CONNECT_BUDGET_MS = '100';
  const slow = fakeServer('slowdisc' + Date.now(), { connect: 'slow', connectMs: 350, tools: [{ name: 'q' }] });
  const shim = createMcpNamespaceShim({ servers: [slow] });
  const started = Date.now();
  const tools = await shim.listToolsWaiting({ deadlineAt: Date.now() + 2_000 });
  assert.ok(tools.some((t: any) => t.name === `${slow.name}__q`), 'the real tool, not the stub');
  assert.ok(!tools.some((t: any) => t.name.endsWith('__unavailable')), 'no connecting stub once it waited');
  assert.ok(Date.now() - started >= 300, 'it waited for the handshake rather than returning at the attach budget');
  delete process.env.MCP_ATTACH_CONNECT_BUDGET_MS;
});

test('the wait ends at the deadline: a hanging server still stubs as connecting, a failed one stubs at once', async () => {
  process.env.MCP_ATTACH_CONNECTED_ONLY = 'on';
  process.env.MCP_ATTACH_CONNECT_BUDGET_MS = '100';
  const hang = fakeServer('hangdisc' + Date.now(), { connect: 'hang' });
  const failed = fakeServer('faildisc' + Date.now(), { connect: 'fail' });
  const shim = createMcpNamespaceShim({ servers: [hang, failed] });
  const started = Date.now();
  const tools = await shim.listToolsWaiting({ deadlineAt: Date.now() + 400 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_500, `bounded by the deadline, not the connect timeout (took ${elapsed}ms)`);
  const hangStub = tools.find((t: any) => t.name === `${hang.name}__unavailable`);
  const failStub = tools.find((t: any) => t.name === `${failed.name}__unavailable`);
  assert.match(hangStub.description, /CONNECTING/);
  assert.match(failStub.description, /UNAVAILABLE/);
  delete process.env.MCP_ATTACH_CONNECT_BUDGET_MS;
});

test('the connecting stub sends the model back to tool_search, never to reconnect or to tell the user it is warming up', async () => {
  process.env.MCP_ATTACH_CONNECTED_ONLY = 'on';
  process.env.MCP_ATTACH_CONNECT_BUDGET_MS = '100';
  const warming = fakeServer('warmdoor' + Date.now(), { connect: 'hang' });
  const shim = createMcpNamespaceShim({ servers: [warming] });
  const tools = await shim.listTools();
  const stub = tools.find((t: any) => t.name === `${warming.name}__unavailable`);
  assert.match(stub.description, /CONNECTING/);
  assert.match(stub.description, /search again .*tool_search/i, 'names the door that waits');
  assert.match(stub.description, /not an outage/i);
  assert.doesNotMatch(stub.description, /tell the user/i, 'no instruction to end the turn on the harness\'s behalf');
  assert.doesNotMatch(stub.description, /within a turn or two/i);
  delete process.env.MCP_ATTACH_CONNECT_BUDGET_MS;
});

test('reconnectServer(slug) drops and restarts only that server; the other keeps its live connection', async () => {
  process.env.MCP_ATTACH_CONNECTED_ONLY = 'on';
  const counting = (name: string) => {
    const counts = { connect: 0, close: 0 };
    let connected = false;
    return {
      counts,
      server: {
        name,
        cacheToolsList: true,
        async connect() { counts.connect += 1; connected = true; },
        async close() { counts.close += 1; connected = false; },
        async listTools() {
          if (!connected) throw new Error(`${name} not connected`);
          return [{ name: 't', description: 'tool t', inputSchema: { type: 'object', properties: {} } }];
        },
        async callTool() { return []; },
        async invalidateToolsCache() {},
      } as any,
    };
  };
  const alpha = counting('alpha' + Date.now());
  const beta = counting('beta' + Date.now());
  const shim = createMcpNamespaceShim({ servers: [alpha.server, beta.server] });
  const first = await shim.listTools();
  assert.ok(first.some((t: any) => t.name === `${alpha.server.name}__t`));
  assert.deepEqual([alpha.counts.connect, beta.counts.connect], [1, 1]);

  assert.equal(await shim.reconnectServer('no-such-server'), false, 'an unknown slug reconnects nothing');
  assert.equal(await shim.reconnectServer(alpha.server.name), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(alpha.counts.close, 1, 'alpha was closed');
  assert.equal(alpha.counts.connect, 2, 'alpha reconnected right away, not on the next use');
  assert.deepEqual([beta.counts.close, beta.counts.connect], [0, 1], 'beta was left alone');
  const again = await shim.listTools();
  assert.ok(again.some((t: any) => t.name === `${alpha.server.name}__t`), 'alpha lists its real tools from the fresh connection');
  assert.ok(again.some((t: any) => t.name === `${beta.server.name}__t`));
  assert.equal(listMcpServerHealth().find((h) => h.slug === alpha.server.name)?.state, 'connected');
});
