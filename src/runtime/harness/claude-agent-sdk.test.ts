import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-agent-sdk-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const mod = await import('./claude-agent-sdk.js');
const {
  CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS,
  CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS,
  buildAllowOnlyToolsPermission,
  buildClaudeAgentSdkLocalMcpServers,
  defaultClaudeAgentSdkAllowedLocalTools,
  runClaudeAgentSdk,
  setClaudeAgentSdkQueryForTest,
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
});

test.after(() => {
  setClaudeAgentSdkQueryForTest(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('defaultClaudeAgentSdkAllowedLocalTools is conservative unless explicitly overridden', () => {
  const original = process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS;
  try {
    delete process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS;
    const defaults = defaultClaudeAgentSdkAllowedLocalTools();
    assert.ok(defaults.includes('memory_search'));
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
