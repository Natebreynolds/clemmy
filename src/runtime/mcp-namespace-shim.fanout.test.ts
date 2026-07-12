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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { MCPServer } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mcp-fanout-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-mcp-fanout-test\n', 'utf-8');
// The shim now registers calls with the tool-guardrail (read-fanout block mount);
// synthetic session ids have no sessions row, so skip sqlite write-through.
process.env.CLEMMY_GUARDRAIL_PERSIST = 'off';

const { createMcpNamespaceShim, namespaceToolName, slugifyServerName } = await import('./mcp-namespace-shim.js');
const { _resetAllTrackersForTests } = await import('./harness/tool-guardrail.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('./harness/brackets.js');
type HarnessRunContext = import('./harness/brackets.js').HarnessRunContext;

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
  // A READ tool (like the other tests): the forEach-vs-run_worker choice keys on
  // the session being a workflow step, NOT on the tool. Using a write-classified
  // tool here would hit the approval gate under the default (strict/balanced)
  // policy in CI and throw before the advisory runs — the gate is orthogonal to
  // what this test checks.
  const slug = 'dataforseo';
  const tool = 'serp_organic_live_advanced';
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

// ─── READ-FANOUT HARD BLOCK at the shim mount (2026-07-12) ──────────────────
// Native MCP dispatches bypass wrapToolForHarness, so the deterministic block
// lives HERE too. These integration tests drive the REAL shim -> guardrail
// path: a genuine serial batch (6+ distinct entities) is refused with the
// standing-turn-rule recovery message and the server is NOT contacted; the
// entity gate, code-mode/certified-batch exemptions, and the default-off
// kill-switch each keep legitimate shapes untouched.

/** Fake server that counts dispatches, so a refusal is provably pre-dispatch. */
function makeCountingServer(name: string, toolName: string): { server: MCPServer; calls: () => number } {
  let n = 0;
  const server = {
    name,
    cacheToolsList: false,
    toolFilter: undefined,
    async connect() {},
    async close() {},
    async listTools() {
      return [{ name: toolName, description: 'read', inputSchema: { type: 'object' } }] as unknown as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool(_toolName: string, _args: Record<string, unknown> | null) {
      n += 1;
      return [{ type: 'text', text: 'serp rank 4, volume 320' }] as unknown as Awaited<ReturnType<MCPServer['callTool']>>;
    },
    async invalidateToolsCache() {},
  } as unknown as MCPServer;
  return { server, calls: () => n };
}

test('shim block: 6 distinct-entity serial reads → 6th REFUSED pre-dispatch with the program recovery', async () => {
  _resetAllTrackersForTests();
  process.env.CLEMMY_GUARDRAIL_FANOUT_BLOCK = 'on';
  try {
    const { server, calls } = makeCountingServer('dataforseo', 'serp_organic_live_advanced');
    const shim = createMcpNamespaceShim({ servers: [server] });
    const namespaced = namespaceToolName(slugifyServerName('dataforseo'), 'serp_organic_live_advanced');
    await withHarnessRunContext(ctx('sess-shimblock-batch'), async () => {
      await shim.listTools();
      for (let i = 1; i <= 5; i += 1) {
        const r = JSON.stringify(await shim.callTool(namespaced, { target: `firm-${i}-aaaa.com` }));
        assert.ok(!/REFUSED/.test(r), `read #${i} (< threshold) dispatches normally`);
      }
      assert.equal(calls(), 5, 'first five reads reached the server');
      const r6 = JSON.stringify(await shim.callTool(namespaced, { target: 'firm-6-zzzz.com' }));
      assert.ok(/REFUSED/.test(r6), '6th distinct entity → refused');
      assert.ok(/run_tool_program/.test(r6), 'refusal carries the program recovery skeleton');
      assert.equal(calls(), 5, 'the refused read NEVER reached the server');
    });
  } finally {
    delete process.env.CLEMMY_GUARDRAIL_FANOUT_BLOCK;
  }
});

test('shim block entity gate: re-reading ONE entity 8 ways (pagination/refinement) never refuses', async () => {
  _resetAllTrackersForTests();
  process.env.CLEMMY_GUARDRAIL_FANOUT_BLOCK = 'on';
  try {
    const { server, calls } = makeCountingServer('dataforseo', 'serp_organic_live_advanced');
    const shim = createMcpNamespaceShim({ servers: [server] });
    const namespaced = namespaceToolName(slugifyServerName('dataforseo'), 'serp_organic_live_advanced');
    await withHarnessRunContext(ctx('sess-shimblock-refine'), async () => {
      await shim.listTools();
      for (let i = 1; i <= 8; i += 1) {
        const r = JSON.stringify(await shim.callTool(namespaced, { target: 'same-firm.com', depth: i * 10 }));
        assert.ok(!/REFUSED/.test(r), `refinement read #${i} on ONE entity must not be refused`);
      }
      assert.equal(calls(), 8, 'all refinement reads dispatched');
    });
  } finally {
    delete process.env.CLEMMY_GUARDRAIL_FANOUT_BLOCK;
  }
});

test('shim block exemptions: code-mode program reads and certified-batch items are never refused', async () => {
  process.env.CLEMMY_GUARDRAIL_FANOUT_BLOCK = 'on';
  try {
    for (const [label, extra] of [
      ['codeMode', { codeMode: true }],
      ['certifiedBatch', { certifiedBatch: { batchId: 'b1', payloadHash: 'h1' } }],
    ] as const) {
      _resetAllTrackersForTests();
      const { server, calls } = makeCountingServer('dataforseo', 'serp_organic_live_advanced');
      const shim = createMcpNamespaceShim({ servers: [server] });
      const namespaced = namespaceToolName(slugifyServerName('dataforseo'), 'serp_organic_live_advanced');
      await withHarnessRunContext({ ...ctx(`sess-shimblock-${label}`), ...extra }, async () => {
        await shim.listTools();
        for (let i = 1; i <= 8; i += 1) {
          const r = JSON.stringify(await shim.callTool(namespaced, { target: `firm-${i}-${label}.com` }));
          assert.ok(!/REFUSED/.test(r), `${label}: read #${i} exempt from the block`);
        }
        assert.equal(calls(), 8, `${label}: all 8 reads dispatched`);
      });
    }
  } finally {
    delete process.env.CLEMMY_GUARDRAIL_FANOUT_BLOCK;
  }
});

test('shim block A: exempt program reads do NOT poison the orchestrator scope — the next DIRECT read is not refused', async () => {
  _resetAllTrackersForTests();
  process.env.CLEMMY_GUARDRAIL_FANOUT_BLOCK = 'on';
  try {
    const { server, calls } = makeCountingServer('dataforseo', 'serp_organic_live_advanced');
    const shim = createMcpNamespaceShim({ servers: [server] });
    const namespaced = namespaceToolName(slugifyServerName('dataforseo'), 'serp_organic_live_advanced');
    // Phase 1: a code-mode PROGRAM reads 6 distinct entities (exempt — the sanctioned
    // batched execution). Under the fix these register in the program's OWN window.
    await withHarnessRunContext({ ...ctx('sess-poison'), codeMode: true }, async () => {
      await shim.listTools();
      for (let i = 1; i <= 6; i += 1)
        await shim.callTool(namespaced, { target: `firm-${i}-aaaa.com` });
    });
    assert.equal(calls(), 6, 'all 6 exempt program reads dispatched');
    // Phase 2: the ORCHESTRATOR makes ONE direct read of the SAME tool. Before the
    // fix this was refused (the 6 exempt reads inflated the shared session ceiling).
    let directResult = '';
    await withHarnessRunContext(ctx('sess-poison'), async () => {
      directResult = JSON.stringify(await shim.callTool(namespaced, { target: 'single-followup.com' }));
    });
    assert.ok(!/REFUSED/.test(directResult), 'the first DIRECT read must NOT be refused — exempt reads live in their own window');
    assert.equal(calls(), 7, 'the direct read dispatched normally');
  } finally { delete process.env.CLEMMY_GUARDRAIL_FANOUT_BLOCK; }
});

test('shim block kill-switch: OFF → 10 distinct-entity serial reads all dispatch (byte-identical)', async () => {
  _resetAllTrackersForTests();
  process.env.CLEMMY_GUARDRAIL_FANOUT_BLOCK = 'off';
  try {
    const { server, calls } = makeCountingServer('dataforseo', 'serp_organic_live_advanced');
    const shim = createMcpNamespaceShim({ servers: [server] });
    const namespaced = namespaceToolName(slugifyServerName('dataforseo'), 'serp_organic_live_advanced');
    await withHarnessRunContext(ctx('sess-shimblock-off'), async () => {
      await shim.listTools();
      for (let i = 1; i <= 10; i += 1) {
        const r = JSON.stringify(await shim.callTool(namespaced, { target: `firm-${i}-off.com` }));
        assert.ok(!/REFUSED/.test(r), `switch off: read #${i} never refused`);
      }
      assert.equal(calls(), 10, 'switch off: every read dispatched');
    });
  } finally {
    delete process.env.CLEMMY_GUARDRAIL_FANOUT_BLOCK;
  }
});

after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});
