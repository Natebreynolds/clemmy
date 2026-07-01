import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-agent-sdk-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const mod = await import('./claude-agent-sdk.js');
const usageLog = await import('../usage-log.js');
const {
  CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS,
  CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS,
  ClaudeAgentSdkToolSurfaceError,
  buildAllowOnlyToolsPermission,
  buildClaudeAgentSdkLocalMcpServers,
  defaultClaudeAgentSdkAllowedLocalTools,
  runClaudeAgentSdk,
  setClaudeAgentSdkQueryForTest,
  setClaudeAgentSdkReflectionForTest,
} = mod;

const STATE_DIR = path.join(TMP_HOME, 'state');
const CLAUDE_AUTH_FILE = path.join(STATE_DIR, 'claude-auth.json');
mkdirSync(STATE_DIR, { recursive: true });

function writeClaudeToken(): void {
  writeFileSync(
    CLAUDE_AUTH_FILE,
    JSON.stringify({
      accessToken: 'sk-ant-oat01-sdk-test-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ['user:inference'],
    }),
    'utf-8',
  );
}

test.beforeEach(() => {
  writeClaudeToken();
  setClaudeAgentSdkQueryForTest(null);
  setClaudeAgentSdkReflectionForTest(null);
});

test.after(() => {
  setClaudeAgentSdkQueryForTest(null);
  setClaudeAgentSdkReflectionForTest(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('defaultClaudeAgentSdkAllowedLocalTools is conservative unless explicitly overridden', () => {
  const original = process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS;
  try {
    delete process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS;
    const defaults = defaultClaudeAgentSdkAllowedLocalTools();
    assert.ok(defaults.includes('memory_search'));
    assert.ok(defaults.includes('memory_remember'));
    assert.ok(defaults.includes('read_file'));
    assert.equal(defaults.includes('run_shell_command'), false);
    assert.equal(defaults.includes('write_file'), false);
    assert.equal(defaults.includes('composio_execute_tool'), false);
    assert.equal(defaults.includes('workflow_create'), false);
    assert.deepEqual(defaults, [...CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS]);

    const authoring = defaultClaudeAgentSdkAllowedLocalTools('local_authoring');
    assert.ok(authoring.includes('workflow_create'));
    assert.ok(authoring.includes('workflow_run'));
    assert.ok(authoring.includes('set_model_role'));
    assert.ok(authoring.includes('memory_remember'));
    assert.equal(authoring.includes('run_shell_command'), false);
    assert.equal(authoring.includes('write_file'), false);
    assert.equal(authoring.includes('composio_execute_tool'), false);
    assert.deepEqual(authoring, [...new Set(CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS)]);

    process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS = 'ping, memory_search';
    assert.deepEqual(defaultClaudeAgentSdkAllowedLocalTools(), ['ping', 'memory_search']);
  } finally {
    if (original === undefined) delete process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS;
    else process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS = original;
  }
});

test('buildClaudeAgentSdkLocalMcpServers exposes the local Clementine MCP stdio server', () => {
  const servers = buildClaudeAgentSdkLocalMcpServers('brain-session-1');
  const local = servers['clementine-local'] as any;
  assert.equal(local.type, 'stdio');
  assert.ok(local.command === 'npx' || local.command.length > 0);
  assert.equal(local.alwaysLoad, true);
  assert.equal(local.env.CLEMENTINE_HOME, TMP_HOME);
  assert.equal(local.env.CLEMENTINE_MCP_SESSION_ID, 'brain-session-1');
  assert.ok(Array.isArray(local.args));
  assert.ok(local.args.some((arg: string) => arg.includes('mcp-server')));
});

test('buildAllowOnlyToolsPermission allows exact/tail matches and denies everything else', async () => {
  const canUse = buildAllowOnlyToolsPermission(['ping']);
  assert.deepEqual(
    await canUse('mcp__clementine-local__ping', {}, { signal: new AbortController().signal, toolUseID: 'a' }),
    { behavior: 'allow' },
  );
  const denied = await canUse('mcp__clementine-local__workflow_create', {}, { signal: new AbortController().signal, toolUseID: 'b' });
  assert.equal(denied.behavior, 'deny');
  assert.match((denied as { message: string }).message, /did not allow/);
});

function queryFromMessages(messages: SDKMessage[], capture: { params?: any }): Query {
  const gen = (async function* () {
    for (const message of messages) yield message;
  })();
  const q = Object.assign(gen, {
    close() {},
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    streamInput: async () => {},
    stopTask: async () => false,
    backgroundTasks: async () => false,
  }) as Query;
  capture.params = q;
  return q;
}

test('runClaudeAgentSdk wires subscription env, MCP, permissions, and aggregates result/tool uses', async () => {
  const capture: { call?: any } = {};
  setClaudeAgentSdkQueryForTest(((params: any) => {
    capture.call = params;
    return queryFromMessages([
      {
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-6',
        session_id: 'sdk-session',
        uuid: 'u1',
        apiKeySource: 'none',
        claude_code_version: '2.1.181',
        cwd: process.cwd(),
        tools: ['mcp__clementine-local__ping'],
        mcp_servers: [{ name: 'clementine-local', status: 'connected' }],
        permissionMode: 'dontAsk',
        slash_commands: [],
        output_style: 'default',
        skills: [],
        plugins: [],
      } as any,
      {
        type: 'assistant',
        session_id: 'sdk-session',
        uuid: 'u2',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', name: 'mcp__clementine-local__ping' }] },
      } as any,
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-session',
        uuid: 'u3',
        result: 'ok',
        structured_output: { ok: true },
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
      } as any,
    ], {});
  }) as any);

  const result = await runClaudeAgentSdk({
    prompt: 'Call ping.',
    sessionId: 'sdk-clementine-session',
    modelId: 'claude-sonnet-4-6',
    allowedLocalMcpTools: ['ping'],
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  });

  assert.equal(capture.call.prompt, 'Call ping.');
  assert.equal(capture.call.options.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-sdk-test-token');
  assert.equal(capture.call.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(capture.call.options.model, 'sonnet');
  assert.equal(capture.call.options.permissionMode, 'dontAsk');
  assert.equal(capture.call.options.mcpServers['clementine-local'].env.CLEMENTINE_HOME, TMP_HOME);
  assert.equal(capture.call.options.mcpServers['clementine-local'].env.CLEMENTINE_MCP_SESSION_ID, 'sdk-clementine-session');
  assert.equal(result.text, 'ok');
  assert.deepEqual(result.structuredOutput, { ok: true });
  assert.deepEqual(result.toolUses, ['mcp__clementine-local__ping']);
});

test('runClaudeAgentSdk fails before model work when required local MCP tools are absent from SDK init', async () => {
  setClaudeAgentSdkQueryForTest(((_params: any) => queryFromMessages([
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
      session_id: 'sdk-session',
      uuid: 'u1',
      apiKeySource: 'none',
      claude_code_version: '2.1.181',
      cwd: process.cwd(),
      tools: ['mcp__clementine-local__ping'],
      mcp_servers: [{ name: 'clementine-local', status: 'connected' }],
      permissionMode: 'default',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
    } as any,
    {
      type: 'assistant',
      session_id: 'sdk-session',
      uuid: 'u2',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'I should never get to work.' }] },
    } as any,
  ], {})) as any);

  await assert.rejects(
    () => runClaudeAgentSdk({
      prompt: 'Run sf data query.',
      sessionId: 'workflow:run:main',
      modelId: 'claude-sonnet-4-6',
      agentic: true,
      requiredLocalMcpTools: ['run_shell_command'],
    }),
    (err: unknown) => {
      assert.ok(err instanceof ClaudeAgentSdkToolSurfaceError);
      assert.deepEqual(err.missingTools, ['run_shell_command']);
      assert.match(err.message, /missing required tool/);
      return true;
    },
  );
});

test('runClaudeAgentSdk records usage for the shared usage dashboard and workflow cost joins', async () => {
  const sessionId = `sdk-usage-recording-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  setClaudeAgentSdkQueryForTest(((_params: any) => queryFromMessages([
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-4-8',
      session_id: 'sdk-session-usage',
      uuid: 'u1',
      apiKeySource: 'none',
      claude_code_version: '2.1.181',
      cwd: process.cwd(),
      tools: [],
      mcp_servers: [],
      permissionMode: 'dontAsk',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
    } as any,
    {
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-session-usage',
      uuid: 'usage-result-1',
      result: 'ok',
      duration_ms: 17,
      duration_api_ms: 12,
      is_error: false,
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 10, cache_creation_input_tokens: 3, cache_read_input_tokens: 7, output_tokens: 5 },
      modelUsage: {},
      permission_denials: [],
    } as any,
  ], {})) as any);

  await runClaudeAgentSdk({ prompt: 'hi', sessionId, modelId: 'claude-opus-4-8' });

  const events = usageLog.readUsageEventsForDate().filter((e) => e.source === sessionId);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'other');
  assert.equal(events[0].model, 'claude-opus-4-8');
  assert.equal(events[0].inputTokens, 20);
  assert.equal(events[0].cachedInputTokens, 7);
  assert.equal(events[0].outputTokens, 5);
  assert.equal(events[0].totalTokens, 25);
  assert.equal(events[0].durationMs, 17);
  assert.equal(events[0].responseId, 'usage-result-1');
});

test('runClaudeAgentSdk uses the conservative read-only tool set by default', async () => {
  const capture: { call?: any } = {};
  setClaudeAgentSdkQueryForTest(((params: any) => {
    capture.call = params;
    return queryFromMessages([
      {
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-6',
        session_id: 'sdk-session',
        uuid: 'u1',
        apiKeySource: 'none',
        claude_code_version: '2.1.181',
        cwd: process.cwd(),
        tools: ['mcp__clementine-local__memory_search'],
        mcp_servers: [{ name: 'clementine-local', status: 'connected' }],
        permissionMode: 'dontAsk',
        slash_commands: [],
        output_style: 'default',
        skills: [],
        plugins: [],
      } as any,
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-session',
        uuid: 'u2',
        result: 'ok',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
      } as any,
    ], {});
  }) as any);

  await runClaudeAgentSdk({ prompt: 'Search memory.' });
  assert.ok(capture.call.options.allowedTools.includes('mcp__clementine-local__memory_search'));
  assert.equal(capture.call.options.allowedTools.includes('mcp__clementine-local__run_shell_command'), false);
  assert.equal(capture.call.options.allowedTools.includes('mcp__clementine-local__composio_execute_tool'), false);
});

// Brain continuity: a Claude Agent SDK turn must feed its tool returns into the
// SAME reflection pipeline the Codex loop uses, so Clementine learns from Claude
// turns instead of going amnesiac. The Agent SDK runs its tool loop outside the
// @openai/agents RunHooks, so this is sourced from the SDK message stream.
function streamWithToolReturn(): SDKMessage[] {
  return [
    { type: 'system', subtype: 'init', model: 'claude-opus-4-8', session_id: 'sdk-session', uuid: 'u1', apiKeySource: 'none', claude_code_version: '2.1.181', cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'default', slash_commands: [], output_style: 'default', skills: [], plugins: [] } as any,
    { type: 'assistant', session_id: 'sdk-session', uuid: 'u2', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_42', name: 'mcp__clementine-local__composio_execute_tool', input: { tool_slug: 'SALESFORCE_QUERY' } }] } } as any,
    { type: 'user', session_id: 'sdk-session', uuid: 'u3', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_42', content: 'Acme Corp has 3 open opportunities worth $45,000 total.' }] } } as any,
    { type: 'result', subtype: 'success', session_id: 'sdk-session', uuid: 'u4', result: 'done', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [] } as any,
  ];
}

test('runClaudeAgentSdk reflects each tool return into the learning pipeline (brain continuity)', async () => {
  setClaudeAgentSdkQueryForTest(((_params: any) => queryFromMessages(streamWithToolReturn(), {})) as any);
  const reflected: Array<{ sessionId: string; callId: string; tool: string | null; output: string }> = [];
  setClaudeAgentSdkReflectionForTest(((input: any) => { reflected.push(input); }) as any);

  await runClaudeAgentSdk({ prompt: 'Look up Acme.', sessionId: 'clem-sess-1', agentic: true });

  assert.equal(reflected.length, 1);
  assert.equal(reflected[0].sessionId, 'clem-sess-1');
  assert.equal(reflected[0].callId, 'toolu_42');
  // The MCP-namespaced Composio wrapper is unwrapped to the real action slug
  // for source-trust parity with the Codex RunHooks path.
  assert.equal(reflected[0].tool, 'SALESFORCE_QUERY');
  assert.match(reflected[0].output, /Acme Corp has 3 open opportunities/);
});

test('learning-OUT is skipped without a session id and when kill-switched off', async () => {
  // No session id → nothing to attribute facts to → no reflection.
  setClaudeAgentSdkQueryForTest(((_p: any) => queryFromMessages(streamWithToolReturn(), {})) as any);
  const noSession: unknown[] = [];
  setClaudeAgentSdkReflectionForTest(((input: any) => { noSession.push(input); }) as any);
  await runClaudeAgentSdk({ prompt: 'x' });
  assert.equal(noSession.length, 0);

  // Kill-switch off → legacy behaviour (no learning OUT) even with a session.
  const prior = process.env.CLEMMY_CLAUDE_SDK_REFLECTION;
  try {
    process.env.CLEMMY_CLAUDE_SDK_REFLECTION = 'off';
    setClaudeAgentSdkQueryForTest(((_p: any) => queryFromMessages(streamWithToolReturn(), {})) as any);
    const killed: unknown[] = [];
    setClaudeAgentSdkReflectionForTest(((input: any) => { killed.push(input); }) as any);
    await runClaudeAgentSdk({ prompt: 'x', sessionId: 'clem-sess-2', agentic: true });
    assert.equal(killed.length, 0);
  } finally {
    if (prior === undefined) delete process.env.CLEMMY_CLAUDE_SDK_REFLECTION;
    else process.env.CLEMMY_CLAUDE_SDK_REFLECTION = prior;
  }
});

// --- In-lane provider-overload retry (first-byte-safe) -----------------------

process.env.CLEMMY_CLAUDE_SDK_OVERLOAD_BACKOFF_MS = '1'; // keep retries instant in tests

function stubsFor(gen: AsyncGenerator<SDKMessage>): Query {
  return Object.assign(gen, {
    close() {}, interrupt: async () => {}, setPermissionMode: async () => {},
    setModel: async () => {}, setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    streamInput: async () => {}, stopTask: async () => false, backgroundTasks: async () => false,
  }) as Query;
}
function throwingQuery(msg: string): Query {
  return stubsFor((async function* () { throw new Error(msg); })());
}
function successQuery(text: string): Query {
  return stubsFor((async function* () {
    yield { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: 's', uuid: 'i', apiKeySource: 'none', claude_code_version: '2', cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'dontAsk', slash_commands: [], output_style: 'default', skills: [], plugins: [] } as any;
    yield { type: 'result', subtype: 'success', session_id: 's', uuid: 'r', result: text, duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [] } as any;
  })());
}
function toolThenThrowQuery(msg: string): Query {
  return stubsFor((async function* () {
    yield { type: 'assistant', session_id: 's', uuid: 'a', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'mcp__clementine-local__ping' }] } } as any;
    throw new Error(msg);
  })());
}
function streamedDeltasThenTurnLimitQuery(): Query {
  return stubsFor((async function* () {
    yield { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: 's', uuid: 'i', apiKeySource: 'none', claude_code_version: '2', cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'dontAsk', slash_commands: [], output_style: 'default', skills: [], plugins: [] } as any;
    yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'I finished the first pass' } } } as any;
    yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' and still need one more check.' } } } as any;
    throw new Error('Claude Code returned an error result: Reached maximum number of turns (3)');
  })());
}
function assistantThenStreamedDeltaThenTurnLimitQuery(): Query {
  return stubsFor((async function* () {
    yield { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: 's', uuid: 'i', apiKeySource: 'none', claude_code_version: '2', cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'dontAsk', slash_commands: [], output_style: 'default', skills: [], plugins: [] } as any;
    yield { type: 'assistant', session_id: 's', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Earlier checkpoint.' }] } } as any;
    yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Later streamed checkpoint with more detail.' } } } as any;
    throw new Error('Claude Code returned an error result: Reached maximum number of turns (3)');
  })());
}
function streamedDeltasThenBlankSuccessQuery(): Query {
  return stubsFor((async function* () {
    yield { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: 's', uuid: 'i', apiKeySource: 'none', claude_code_version: '2', cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'dontAsk', slash_commands: [], output_style: 'default', skills: [], plugins: [] } as any;
    yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Here is the completed answer' } } } as any;
    yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' from the SDK stream.' } } } as any;
    yield { type: 'result', subtype: 'success', session_id: 's', uuid: 'r', result: '', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [] } as any;
  })());
}
function assistantSnapshotThenBlankSuccessQuery(): Query {
  return stubsFor((async function* () {
    yield { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: 's', uuid: 'i', apiKeySource: 'none', claude_code_version: '2', cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'dontAsk', slash_commands: [], output_style: 'default', skills: [], plugins: [] } as any;
    yield { type: 'assistant', session_id: 's', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Assistant snapshot answer.' }] } } as any;
    yield { type: 'result', subtype: 'success', session_id: 's', uuid: 'r', result: '', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [] } as any;
  })());
}

test('overload at first byte is retried and then succeeds (no tools ran yet)', async () => {
  let calls = 0;
  setClaudeAgentSdkQueryForTest(((_p: any) => {
    calls++;
    return calls === 1
      ? throwingQuery('Claude Code returned an error result: API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.')
      : successQuery('recovered');
  }) as any);
  const r = await runClaudeAgentSdk({ prompt: 'hi', modelId: 'claude-sonnet-4-6' });
  assert.equal(calls, 2, 'retried once');
  assert.equal(r.text, 'recovered');
});

test('synchronous overload during query startup is retried before surfacing', async () => {
  let calls = 0;
  setClaudeAgentSdkQueryForTest(((_p: any) => {
    calls++;
    if (calls === 1) throw new Error('Claude Code returned an error result: API Error: 529 Overloaded');
    return successQuery('recovered after startup overload');
  }) as any);
  const r = await runClaudeAgentSdk({ prompt: 'hi', modelId: 'claude-sonnet-4-6' });
  assert.equal(calls, 2, 'retried the query startup error');
  assert.equal(r.text, 'recovered after startup overload');
});

test('overload AFTER a tool ran is NOT retried (would double-act) — it throws', async () => {
  let calls = 0;
  setClaudeAgentSdkQueryForTest(((_p: any) => { calls++; return toolThenThrowQuery('API Error: 529 Overloaded'); }) as any);
  await assert.rejects(runClaudeAgentSdk({ prompt: 'hi', modelId: 'claude-sonnet-4-6' }), /529 Overloaded/);
  assert.equal(calls, 1, 'no retry once a tool executed');
});

test('a deterministic (non-overload) error is never retried', async () => {
  let calls = 0;
  setClaudeAgentSdkQueryForTest(((_p: any) => { calls++; return throwingQuery('API Error: 400 Bad Request: invalid schema'); }) as any);
  await assert.rejects(runClaudeAgentSdk({ prompt: 'hi', modelId: 'claude-sonnet-4-6' }), /400/);
  assert.equal(calls, 1, 'no retry on a 4xx');
});

test('thrown max-turns after streamed text returns the visible partial reply, not a generic error', async () => {
  const chunks: string[] = [];
  setClaudeAgentSdkQueryForTest(((_p: any) => streamedDeltasThenTurnLimitQuery()) as any);

  const r = await runClaudeAgentSdk({
    prompt: 'long task',
    sessionId: 'sdk-stream-limit',
    modelId: 'claude-sonnet-4-6',
    onDelta: async (delta) => { chunks.push(delta); },
  });

  assert.equal(r.limitHit, true);
  assert.equal(r.text, 'I finished the first pass and still need one more check.');
  assert.deepEqual(chunks, ['I finished the first pass', ' and still need one more check.']);
});

test('thrown max-turns preserves SDK text deltas even without a caller stream sink', async () => {
  setClaudeAgentSdkQueryForTest(((_p: any) => streamedDeltasThenTurnLimitQuery()) as any);

  const r = await runClaudeAgentSdk({
    prompt: 'long task',
    sessionId: 'sdk-stream-limit-no-sink',
    modelId: 'claude-sonnet-4-6',
  });

  assert.equal(r.limitHit, true);
  assert.equal(r.text, 'I finished the first pass and still need one more check.');
});

test('thrown max-turns prefers later streamed text over an older assistant snapshot', async () => {
  const chunks: string[] = [];
  setClaudeAgentSdkQueryForTest(((_p: any) => assistantThenStreamedDeltaThenTurnLimitQuery()) as any);

  const r = await runClaudeAgentSdk({
    prompt: 'long task',
    sessionId: 'sdk-stream-limit-snapshot',
    modelId: 'claude-sonnet-4-6',
    onDelta: async (delta) => { chunks.push(delta); },
  });

  assert.equal(r.limitHit, true);
  assert.equal(r.text, 'Later streamed checkpoint with more detail.');
  assert.deepEqual(chunks, ['Later streamed checkpoint with more detail.']);
});

// -------- Phase 2: anti-thrash bounding (tool-call ceiling + wall-clock) --------
function initOnlyMessage(): any {
  return { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: 's', uuid: 'i', apiKeySource: 'none', claude_code_version: '2', cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'default', slash_commands: [], output_style: 'default', skills: [], plugins: [] };
}
function successResultMessage(text: string): any {
  return { type: 'result', subtype: 'success', session_id: 's', uuid: 'r', result: text, duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [] };
}
// A query that HAMMERS a mutating tool through the host `canUseTool` (simulating
// the SDK's pre-tool gate) until the ceiling interrupts, then ends. The SDK
// aborts the turn on an interrupting deny, modeled here as a thrown stream error.
function hammerToolQuery(p: any, cap: number): Query {
  const canUse = p.options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<any>;
  return stubsFor((async function* () {
    yield initOnlyMessage();
    for (let i = 0; i < cap; i++) {
      const res = await canUse('mcp__clementine-local__run_shell_command', { command: `echo ${i}` }, {});
      if (res?.behavior === 'deny' && res?.interrupt === true) {
        throw new Error('Claude Code returned an error result: turn interrupted by host');
      }
    }
    yield successResultMessage('done without tripping the ceiling');
  })());
}

test('Phase 2: a mutating thrash trips the SDK tool-call ceiling and stops the turn (interrupt)', async () => {
  const prev = process.env.CLEMMY_SDK_MUTATING_CALL_CEILING;
  process.env.CLEMMY_SDK_MUTATING_CALL_CEILING = '3';
  try {
    setClaudeAgentSdkQueryForTest(((p: any) => hammerToolQuery(p, 50)) as any);
    const r = await runClaudeAgentSdk({
      prompt: 'do a thing',
      sessionId: 'sdk-ceiling-trip',
      modelId: 'claude-sonnet-4-6',
      // read-only allowlist → run_shell_command is NOT fast-allow → counts as mutating
      allowedLocalMcpTools: ['read_file', 'memory_search'],
    });
    assert.equal(r.limitHit, true);
    assert.match(r.text, /stopped myself/i);
    assert.match(r.text, /4 actions/); // trips on the 4th call (> ceiling of 3)
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_SDK_MUTATING_CALL_CEILING;
    else process.env.CLEMMY_SDK_MUTATING_CALL_CEILING = prev;
  }
});

test('Phase 2: the ceiling kill-switch (CLEMMY_SDK_TOOL_CEILING=off) leaves the run unbounded', async () => {
  const prevSwitch = process.env.CLEMMY_SDK_TOOL_CEILING;
  const prevCeil = process.env.CLEMMY_SDK_MUTATING_CALL_CEILING;
  process.env.CLEMMY_SDK_TOOL_CEILING = 'off';
  process.env.CLEMMY_SDK_MUTATING_CALL_CEILING = '3';
  try {
    setClaudeAgentSdkQueryForTest(((p: any) => hammerToolQuery(p, 10)) as any);
    const r = await runClaudeAgentSdk({
      prompt: 'do a thing',
      sessionId: 'sdk-ceiling-off',
      modelId: 'claude-sonnet-4-6',
      allowedLocalMcpTools: ['read_file', 'memory_search'],
    });
    assert.notEqual(r.limitHit, true);
    assert.equal(r.text, 'done without tripping the ceiling');
  } finally {
    if (prevSwitch === undefined) delete process.env.CLEMMY_SDK_TOOL_CEILING; else process.env.CLEMMY_SDK_TOOL_CEILING = prevSwitch;
    if (prevCeil === undefined) delete process.env.CLEMMY_SDK_MUTATING_CALL_CEILING; else process.env.CLEMMY_SDK_MUTATING_CALL_CEILING = prevCeil;
  }
});

test('Phase 3: turnContext rides the USER turn (not the cached system append) so the stable prefix can cache', async () => {
  const capture: { call?: any } = {};
  setClaudeAgentSdkQueryForTest(((params: any) => { capture.call = params; return successQuery('done'); }) as any);

  await runClaudeAgentSdk({
    prompt: 'pull my market leaders',
    sessionId: 'sdk-turn-context',
    modelId: 'claude-sonnet-4-6',
    systemAppend: 'STABLE-SYSTEM-IDENTITY-AND-FACTS',
    turnContext: '# Current State (refreshed this turn)\n\n## Now\nMonday',
    priorTurns: [{ who: 'user', text: 'hi' }, { who: 'assistant', text: 'hello' }],
  });

  // Volatile context is in the user turn, clearly framed and BELOW the prior turns.
  assert.match(capture.call.prompt, /\[CURRENT STATE — refreshed THIS turn/);
  assert.match(capture.call.prompt, /## Now\nMonday/);
  assert.match(capture.call.prompt, /\[Latest message\]\npull my market leaders/);
  assert.ok(capture.call.prompt.indexOf('CONVERSATION SO FAR') < capture.call.prompt.indexOf('CURRENT STATE'));
  // The stable system append is untouched — it must NOT carry the volatile tail
  // (that's the whole point: a stable prefix the API can cache across turns).
  assert.equal(capture.call.options.systemPrompt.append, 'STABLE-SYSTEM-IDENTITY-AND-FACTS');
  assert.doesNotMatch(capture.call.options.systemPrompt.append, /Current State|## Now/);
});

test('Phase 2 fix: the wall clock EXCLUDES human approval-wait — a slow confirm-first approval does NOT self-abort the turn', async () => {
  const prevPoll = process.env.CLEMMY_APPROVAL_POLL_MS;
  process.env.CLEMMY_APPROVAL_POLL_MS = '10'; // fast poll so the test resolves quickly
  const approvalRegistry = await import('./approval-registry.js');
  const { createSession, getSession } = await import('./eventlog.js');
  const sid = 'sdk-approval-wallclock';
  try {
    if (!getSession(sid)) createSession({ id: sid, kind: 'chat', title: 'approval wallclock' });
    setClaudeAgentSdkQueryForTest(((p: any) => {
      const canUse = p.options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<any>;
      return stubsFor((async function* () {
        yield initOnlyMessage();
        // run_shell_command is NOT in the allowlist below → the gate registers an
        // approval and AWAITS a human. Resolve it ~150ms later (a "slow human").
        // That 150ms is spent INSIDE canUseTool → pausedMs, so it must NOT count
        // toward the 40ms wall clock.
        const callP = canUse('mcp__clementine-local__run_shell_command', { command: 'echo hi' }, { signal: new AbortController().signal });
        setTimeout(() => {
          for (const row of approvalRegistry.listPending({ sessionId: sid })) {
            approvalRegistry.resolve(row.approvalId, 'approved', 'test');
          }
        }, 150);
        await callP;
        yield successResultMessage('finished after the slow approval');
      })());
    }) as any);

    const r = await runClaudeAgentSdk({
      prompt: 'do the gated thing',
      sessionId: sid,
      modelId: 'claude-sonnet-4-6',
      agentic: true,
      maxWallClockMs: 40, // far below the ~150ms approval wait
      allowedLocalMcpTools: ['read_file', 'memory_search'],
    });

    // WITHOUT the pausedMs exclusion this would limitHit (150ms > 40ms). WITH it,
    // wall - pausedMs ≈ 0 < 40ms → the turn completes normally after the approval.
    assert.notEqual(r.limitHit, true, 'a long approval wait must not trip the wall clock');
    assert.match(r.text, /finished after the slow approval/);
  } finally {
    if (prevPoll === undefined) delete process.env.CLEMMY_APPROVAL_POLL_MS; else process.env.CLEMMY_APPROVAL_POLL_MS = prevPoll;
  }
});

function slowThenMoreQuery(): Query {
  return stubsFor((async function* () {
    yield initOnlyMessage();
    await new Promise((r) => setTimeout(r, 12));
    yield successResultMessage('should not be reached past the wall clock');
  })());
}

test('Phase 2: the wall-clock backstop ends a stuck turn as a graceful limit, not a hang', async () => {
  setClaudeAgentSdkQueryForTest(((_p: any) => slowThenMoreQuery()) as any);
  const r = await runClaudeAgentSdk({
    prompt: 'stuck turn',
    sessionId: 'sdk-wallclock',
    modelId: 'claude-sonnet-4-6',
    maxWallClockMs: 1,
  });
  assert.equal(r.limitHit, true);
  assert.match(r.text, /time budget/i);
});

test('successful SDK run falls back to streamed deltas when final result text is blank', async () => {
  const chunks: string[] = [];
  setClaudeAgentSdkQueryForTest(((_p: any) => streamedDeltasThenBlankSuccessQuery()) as any);

  const r = await runClaudeAgentSdk({
    prompt: 'stream a final answer',
    sessionId: 'sdk-stream-blank-success',
    modelId: 'claude-sonnet-4-6',
    onDelta: async (delta) => { chunks.push(delta); },
  });

  assert.equal(r.limitHit, undefined);
  assert.equal(r.text, 'Here is the completed answer from the SDK stream.');
  assert.deepEqual(chunks, ['Here is the completed answer', ' from the SDK stream.']);
});

test('successful SDK run falls back to assistant text when final result text is blank', async () => {
  setClaudeAgentSdkQueryForTest(((_p: any) => assistantSnapshotThenBlankSuccessQuery()) as any);

  const r = await runClaudeAgentSdk({
    prompt: 'return an assistant snapshot',
    sessionId: 'sdk-assistant-blank-success',
    modelId: 'claude-sonnet-4-6',
  });

  assert.equal(r.limitHit, undefined);
  assert.equal(r.text, 'Assistant snapshot answer.');
});

test('retries are bounded and then the overload surfaces', async () => {
  let calls = 0;
  setClaudeAgentSdkQueryForTest(((_p: any) => { calls++; return throwingQuery('API Error: 529 Overloaded'); }) as any);
  await assert.rejects(runClaudeAgentSdk({ prompt: 'hi', modelId: 'claude-sonnet-4-6' }), /529/);
  assert.equal(calls, 3, '1 initial + 2 retries (default cap), then throws');
});
