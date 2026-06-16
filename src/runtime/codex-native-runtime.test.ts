/**
 * Run: npx tsx --test src/runtime/codex-native-runtime.test.ts
 *
 * Contract for the v0.2.9 `multi_tool_use.parallel` expander. GPT
 * models periodically emit a SYNTHETIC tool call with that name (or
 * just `parallel`) when they want to run several tools in one turn —
 * the arguments object embeds the real intended calls. Our runtime
 * detects + expands the synthetic envelope into N real CodexFunctionCall
 * items BEFORE any dispatch happens, preserving the model's parallel
 * intent without losing a round trip to the unknown-tool error path.
 *
 * Tests the failure-resilience too — bad JSON, missing fields,
 * malformed entries should all fall through, never throw.
 */
// Pin the MCP attach path to deterministic legacy (blocking-connect) mode for
// the catalog-comparison tests below. With the default bounded-connect
// (MCP_ATTACH_CONNECTED_ONLY=on), two rapid createCodexToolDefinitions() calls
// can land in the connect WARM-UP window and return different surfaces (a stub
// vs the real tools) — correct self-healing behavior in production, but it makes
// "empty exclude list is a no-op" (catalog-size equality) non-deterministic
// under parallel-test load. These tests verify exclude-list logic, not MCP
// warm-up, so a stable catalog is the right fixture. attachConnectedOnly() is
// read per-call, so setting it here governs every listTools in this file.
process.env.MCP_ATTACH_CONNECTED_ONLY = 'off';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexToolDefinitions, expandParallelHallucination, isWallClockAbort, trimNativeInputForRetry, parseCodexUsage, type CodexFunctionCall } from './codex-native-runtime.js';
import { invalidateConfiguredMcpServers } from './mcp-servers.js';
import { AgentRuntimeCancelledError } from './provider.js';

test.after(async () => {
  await invalidateConfiguredMcpServers();
});

// ─── P0-A wall-clock recovery helpers ────────────────────────────────────────

test('isWallClockAbort: recognizes the per-call wall-clock abort by message, rejects others', () => {
  assert.equal(
    isWallClockAbort(new Error("Clementine's model backend exceeded the wall-clock budget of 120000ms and was aborted mid-stream.")),
    true,
    'wall-clock message → true',
  );
  assert.equal(isWallClockAbort(new AgentRuntimeCancelledError()), false, 'a user cancel is not a wall-clock abort');
  assert.equal(isWallClockAbort(new Error('Clementine\'s model backend failed with HTTP 503')), false, '5xx is not a wall-clock abort');
  assert.equal(isWallClockAbort('exceeded the wall-clock budget'), false, 'a non-Error value → false');
  assert.equal(isWallClockAbort(undefined), false, 'undefined → false');
});

test('trimNativeInputForRetry: shrinks OLD large tool outputs, preserves pairing + prompt + recent window', () => {
  const big = 'X'.repeat(5000);
  const input: Record<string, unknown>[] = [
    { role: 'user', content: [{ type: 'input_text', text: 'do the thing' }] },
    { type: 'function_call', call_id: 'c1', name: 't', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: big },     // old → trim
    { type: 'function_call', call_id: 'c2', name: 't', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c2', output: 'short' }, // old but small → keep
    { type: 'function_call', call_id: 'c3', name: 't', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c3', output: big },     // recent → keep
    { type: 'function_call', call_id: 'c4', name: 't', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c4', output: big },     // recent → keep
  ];
  const out = trimNativeInputForRetry(input, { keepRecent: 3, perOutputCap: 100 });

  assert.equal(out.length, input.length, 'no items removed — every call/output pairing is preserved');
  assert.equal(out[0], input[0], 'original prompt is untouched');
  assert.ok((out[2] as Record<string, unknown>).output as string, 'old big output still present');
  assert.ok(((out[2] as Record<string, unknown>).output as string).length < big.length, 'old big output was trimmed');
  assert.ok(/trimmed for wall-clock retry/.test((out[2] as Record<string, unknown>).output as string), 'trim marker added');
  assert.equal((out[4] as Record<string, unknown>).output, 'short', 'small old output kept verbatim');
  assert.equal((out[6] as Record<string, unknown>).output, big, 'recent output (within keepRecent) kept verbatim');
  assert.equal((out[8] as Record<string, unknown>).output, big, 'most recent output kept verbatim');
});

// ─── parseCodexUsage: cached + reasoning tokens were silently read as 0 ──────

test('parseCodexUsage: reads cached tokens from the NESTED Responses-API shape (was always 0)', () => {
  // The real Codex/Responses usage object nests the cache count — the old flat
  // `usage['input_tokens_details.cached_tokens']` read never matched it.
  const u = parseCodexUsage({
    input_tokens: 60000,
    output_tokens: 400,
    total_tokens: 60400,
    input_tokens_details: { cached_tokens: 48000 },
    output_tokens_details: { reasoning_tokens: 120 },
  });
  assert.equal(u.inputTokens, 60000);
  assert.equal(u.cachedInputTokens, 48000, 'nested cached_tokens now captured');
  assert.equal(u.reasoningTokens, 120, 'nested reasoning_tokens now captured');
  assert.equal(u.outputTokens, 400);
  assert.equal(u.totalTokens, 60400);
});

test('parseCodexUsage: handles the chat-completions shape + flat cached_tokens + missing fields', () => {
  const cc = parseCodexUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } });
  assert.equal(cc.inputTokens, 1000);
  assert.equal(cc.cachedInputTokens, 800, 'chat-completions nested cache path');
  assert.equal(cc.totalTokens, 1050, 'total derived when absent');

  const flat = parseCodexUsage({ input_tokens: 10, output_tokens: 2, cached_tokens: 5 });
  assert.equal(flat.cachedInputTokens, 5, 'flat cached_tokens still works');

  const none = parseCodexUsage({ input_tokens: 10, output_tokens: 2 });
  assert.equal(none.cachedInputTokens, undefined, 'no cache info → undefined (not a false 0)');
  assert.equal(parseCodexUsage(undefined).inputTokens, 0, 'undefined usage → zeros, never throws');
});

test('trimNativeInputForRetry: returns the input unchanged when it is at or under keepRecent+1', () => {
  const input: Record<string, unknown>[] = [
    { role: 'user', content: [{ type: 'input_text', text: 'p' }] },
    { type: 'function_call_output', call_id: 'c1', output: 'X'.repeat(9000) },
  ];
  const out = trimNativeInputForRetry(input, { keepRecent: 6 });
  assert.equal(out, input, 'short histories are left alone (nothing to trim safely)');
});

test('expander: pass-through when no synthetic call is present', () => {
  const input: CodexFunctionCall[] = [
    { id: 'a', call_id: 'a', name: 'memory_recall', arguments: '{"query":"x"}' },
    { id: 'b', call_id: 'b', name: 'workspace_list', arguments: '{}' },
  ];
  const out = expandParallelHallucination(input);
  assert.equal(out.length, 2);
  assert.deepEqual(out, input);
});

test("expander: 'multi_tool_use.parallel' expands into its tool_uses entries", () => {
  const input: CodexFunctionCall[] = [
    {
      id: 'call_001',
      call_id: 'call_001',
      name: 'multi_tool_use.parallel',
      arguments: JSON.stringify({
        tool_uses: [
          { recipient_name: 'functions.read_file', parameters: { path: '/a/b.md' } },
          { recipient_name: 'functions.list_files', parameters: { directory: '/tmp' } },
        ],
      }),
    },
  ];
  const out = expandParallelHallucination(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'read_file');
  assert.equal(out[0].id, 'call_001_p0');
  assert.equal(out[0].call_id, 'call_001_p0');
  assert.deepEqual(JSON.parse(out[0].arguments ?? '{}'), { path: '/a/b.md' });
  assert.equal(out[1].name, 'list_files');
  assert.equal(out[1].id, 'call_001_p1');
});

test("expander: bare 'parallel' name also expands (some models drop the namespace)", () => {
  const input: CodexFunctionCall[] = [
    {
      id: 'c1',
      call_id: 'c1',
      name: 'parallel',
      arguments: JSON.stringify({
        tool_uses: [
          { recipient_name: 'functions.ping', parameters: {} },
        ],
      }),
    },
  ];
  const out = expandParallelHallucination(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'ping');
});

test('expander: mixed synthetic + real calls in one turn — both flow through correctly', () => {
  const input: CodexFunctionCall[] = [
    { id: 'real_1', call_id: 'real_1', name: 'memory_recall', arguments: '{"query":"a"}' },
    {
      id: 'syn_1',
      call_id: 'syn_1',
      name: 'multi_tool_use.parallel',
      arguments: JSON.stringify({
        tool_uses: [
          { recipient_name: 'functions.list_files', parameters: { directory: '/a' } },
          { recipient_name: 'functions.read_file',  parameters: { path: '/a/x' } },
        ],
      }),
    },
    { id: 'real_2', call_id: 'real_2', name: 'workspace_list', arguments: '{}' },
  ];
  const out = expandParallelHallucination(input);
  // 1 real + 2 expanded + 1 real = 4
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((c) => c.name), [
    'memory_recall', 'list_files', 'read_file', 'workspace_list',
  ]);
});

test('expander: handles strings for parameters as well (already-JSON case)', () => {
  const input: CodexFunctionCall[] = [
    {
      id: 'c',
      call_id: 'c',
      name: 'multi_tool_use.parallel',
      arguments: JSON.stringify({
        tool_uses: [
          { recipient_name: 'functions.ping', parameters: '{"raw":true}' },
        ],
      }),
    },
  ];
  const out = expandParallelHallucination(input);
  assert.equal(out.length, 1);
  // String parameters are preserved verbatim — the tool's invoke()
  // will JSON.parse them just like it would for normal calls.
  assert.equal(out[0].arguments, '{"raw":true}');
});

test('expander: bad JSON in synthetic arguments falls through unchanged (never throws)', () => {
  const input: CodexFunctionCall[] = [
    { id: 'x', call_id: 'x', name: 'multi_tool_use.parallel', arguments: 'not json {{{' },
  ];
  const out = expandParallelHallucination(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'multi_tool_use.parallel');
});

test('expander: missing tool_uses array falls through', () => {
  const input: CodexFunctionCall[] = [
    { id: 'x', call_id: 'x', name: 'parallel', arguments: JSON.stringify({ wrong_field: [] }) },
  ];
  const out = expandParallelHallucination(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'parallel');
});

test('expander: tool_uses entries without recipient_name are skipped, others kept', () => {
  const input: CodexFunctionCall[] = [
    {
      id: 'mix',
      call_id: 'mix',
      name: 'multi_tool_use.parallel',
      arguments: JSON.stringify({
        tool_uses: [
          { parameters: { x: 1 } }, // missing recipient_name
          { recipient_name: 'functions.list_files', parameters: { directory: '/' } },
          { recipient_name: '', parameters: {} }, // empty recipient_name
        ],
      }),
    },
  ];
  const out = expandParallelHallucination(input);
  // Only the one valid entry expands; the synthetic call is consumed.
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'list_files');
});

test('expander: all entries malformed → keep the original synthetic call so next-turn path handles it', () => {
  const input: CodexFunctionCall[] = [
    {
      id: 'all_bad',
      call_id: 'all_bad',
      name: 'multi_tool_use.parallel',
      arguments: JSON.stringify({ tool_uses: [{ wrong: true }, null, 42] }),
    },
  ];
  const out = expandParallelHallucination(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'multi_tool_use.parallel');
});

// ─── excludeToolNames contract ────────────────────────────────────
// Per-call tool exclusion (RunRequest.excludeToolNames) is the code-
// level backstop for prompts that ask the model not to use specific
// tools. The Workflow Architect chat relies on it to hide workflow_*
// mutation tools so the model is forced into the diff-card flow.

test('createCodexToolDefinitions exposes workflow_create by default', async () => {
  const tools = await createCodexToolDefinitions();
  const names = new Set(tools.map((t) => t.name));
  assert.ok(names.has('workflow_create'), 'workflow_create should be in the default surface');
});

test('createCodexToolDefinitions hides excluded tool names', async () => {
  const exclude = ['workflow_create', 'workflow_update', 'workflow_set_enabled', 'workflow_delete', 'workflow_run'];
  const tools = await createCodexToolDefinitions(exclude);
  const names = new Set(tools.map((t) => t.name));
  for (const name of exclude) {
    assert.ok(!names.has(name), `${name} should be hidden when excluded`);
  }
  // Read-only workflow tools stay available — the architect can still
  // inspect existing workflows for context.
  assert.ok(names.has('workflow_list'), 'workflow_list (read) should still be available');
  assert.ok(names.has('workflow_get'), 'workflow_get (read) should still be available');
});

test('createCodexToolDefinitions: empty exclude list is a no-op', async () => {
  const a = await createCodexToolDefinitions();
  const b = await createCodexToolDefinitions([]);
  assert.equal(a.length, b.length, 'empty exclude list should not change the catalog size');
});
