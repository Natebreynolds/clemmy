/**
 * Run: npx tsx --test src/runtime/harness/claude-agent-sdk.fanout-guard.test.ts
 *
 * withReadFanoutGuard mounts the read-fanout block on the SDK's canUseTool gate —
 * the ONE harness chokepoint for native external MCP tools (they dispatch inside
 * the SDK, bypassing wrapToolForHarness). This is the fix for the live 2026-07-12
 * finding: 8 serial bare-name DataForSEO reads sailed past every other mount.
 */
process.env.CLEMMY_GUARDRAIL_PERSIST = 'off';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withReadFanoutGuard } from './claude-agent-sdk.js';
import { _resetAllTrackersForTests } from './tool-guardrail.js';

type Result = { behavior: string; message?: string };
const allowBase = (async () => ({ behavior: 'allow' })) as never;

test('SDK read-fanout guard: 6 distinct-entity native-MCP reads → 6th DENIED with the program recovery', async () => {
  _resetAllTrackersForTests();
  const guard = withReadFanoutGuard(allowBase, 'sess-sdk-fanout');
  const name = 'mcp__dataforseo__serp_organic_live_advanced'; // SDK qualified form
  for (let i = 1; i <= 5; i += 1) {
    const r = (await guard(name, { keyword: `kw-${i}` }, {} as never)) as Result;
    assert.equal(r.behavior, 'allow', `read #${i} (< threshold) allowed`);
  }
  const r6 = (await guard(name, { keyword: 'kw-6' }, {} as never)) as Result;
  assert.equal(r6.behavior, 'deny', '6th distinct entity → denied');
  assert.match(r6.message ?? '', /run_tool_program/, 'the refusal steers to a program');
  // The recovery names the tool WITHOUT the mcp__ prefix so code mode can dispatch it.
  assert.match(r6.message ?? '', /dataforseo__serp_organic_live_advanced/);
  assert.doesNotMatch(r6.message ?? '', /mcp__dataforseo/, 'the mcp__ prefix is stripped for the code-mode dispatch name');
});

test('SDK read-fanout guard: local/clementine + composio tools are NOT registered here (brackets owns them)', async () => {
  _resetAllTrackersForTests();
  const guard = withReadFanoutGuard(allowBase, 'sess-sdk-local');
  // 10 serial local clementine-server reads → never denied (not native external MCP)
  for (let i = 1; i <= 10; i += 1) {
    const r = (await guard('mcp__clementine-local__memory_search', { query: `q${i}` }, {} as never)) as Result;
    assert.equal(r.behavior, 'allow', `clementine-local read #${i} is not the guard's concern`);
  }
});

test('SDK read-fanout guard: refinement on ONE entity (8 ways) never denies', async () => {
  _resetAllTrackersForTests();
  const guard = withReadFanoutGuard(allowBase, 'sess-sdk-refine');
  const name = 'mcp__dataforseo__serp_organic_live_advanced';
  let last: Result = { behavior: 'allow' };
  for (let i = 1; i <= 8; i += 1)
    last = (await guard(name, { target: 'one-firm.example', depth: i * 10 }, {} as never)) as Result;
  assert.equal(last.behavior, 'allow', 'same-entity refinement is not a batch → never refused');
});

test('SDK read-fanout guard: no sessionId → pass-through (never evaluates)', async () => {
  _resetAllTrackersForTests();
  const guard = withReadFanoutGuard(allowBase, undefined);
  for (let i = 1; i <= 8; i += 1) {
    const r = (await guard('mcp__dataforseo__serp_organic_live_advanced', { keyword: `k${i}` }, {} as never)) as Result;
    assert.equal(r.behavior, 'allow', 'without a session the guard cannot key a bucket — pass through');
  }
});
