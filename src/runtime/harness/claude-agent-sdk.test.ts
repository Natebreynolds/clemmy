import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-agent-sdk-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Query, SDKAPIRetryMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const mod = await import('./claude-agent-sdk.js');
const usageLog = await import('../usage-log.js');
const operationalTelemetry = await import('../operational-telemetry.js');
const eventlog = await import('./eventlog.js');
const artifactLedger = await import('./artifact-ledger.js');
const toolEconomy = await import('./tool-economy.js');
const capabilityHealth = await import('./capability-health.js');
const dispatchLease = await import('./dispatch-lease.js');
const { toolCallCorrelationFingerprint } = await import('./tool-correlation.js');
const claudeLocalCorrelation = await import('./claude-local-tool-correlation.js');
const settledReadRepeat = await import('./settled-read-repeat.js');
const currentCapabilityFixtures = await import('./current-capability-manifest.fixture.js');
const { formatAutoResolvedAskUserQuestionOutput } = await import('./terminal-tool.js');
const {
  CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS,
  CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS,
  ClaudeAgentSdkApprovalBoundaryError,
  ClaudeAgentSdkToolSurfaceError,
  buildAllowOnlyToolsPermission,
  buildClaudeAgentSdkLocalMcpServers,
  buildScopedNativeMcpServers,
  claudeAgentSdkUsageLane,
  defaultClaudeAgentSdkAllowedLocalTools,
  runClaudeAgentSdk,
  resolveClaudeAgentSdkTrackerScope,
  setClaudeAgentSdkQueryForTest,
  setClaudeAgentSdkReflectionForTest,
  ClaudeSdkAuthExpiredError,
  ClaudeSdkCapacityExhaustedError,
} = mod;
const { isAuthRecoverableError } = await import('../../execution/transient-error.js');
const { _withHostLocalWriteCommitFactsForTest } = await import('./host-local-write-commit.js');
const withLocalWriteCommitFixture = (_tool: string, result: string) =>
  _withHostLocalWriteCommitFactsForTest({
    createdId: 'daily-digest',
    handle: 'vault/00-System/workflows/daily-digest/SKILL.md',
    contentDigest: 'a'.repeat(64),
    result,
  });

// The default posture is now 'yolo' (Autonomous, 2026-07-20) which auto-approves
// reversible/local + CRM writes. The park-mode / approval-gate tests below verify
// the GATE holds mutating actions for approval, so pin the Supervised posture.
// Irreversible sends are held regardless of posture.
const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
saveProactivityPolicy({ autoApproveScope: 'strict' });

test('Claude SDK usage lane uses only explicit caller-owned role identity', () => {
  assert.equal(claudeAgentSdkUsageLane({ workerScope: true, directOrchestrator: true }), 'worker');
  assert.equal(claudeAgentSdkUsageLane({ directOrchestrator: true }), 'brain');
  assert.equal(claudeAgentSdkUsageLane({ workflowRunId: 'run-1', stepId: 'write' }), 'workflow_step');
  assert.equal(claudeAgentSdkUsageLane({ sessionId: 'workflow:run-2:review' }), 'workflow_step');
  assert.equal(
    claudeAgentSdkUsageLane({ sessionId: 'background:bg-1' }),
    'unattributed',
    'session/model shape never invents a role',
  );
});

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
  capabilityHealth._resetHarnessCapabilityHealthForTest();
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
    assert.ok(defaults.includes('team_list'));
    assert.ok(defaults.includes('team_pending_requests'));
    assert.ok(defaults.includes('check_delegation'));
    assert.ok(defaults.includes('pending_action_list'));
    assert.ok(defaults.includes('pending_action_get'));
    assert.equal(defaults.includes('run_shell_command'), false);
    assert.equal(defaults.includes('write_file'), false);
    assert.equal(defaults.includes('composio_execute_tool'), false);
    assert.equal(defaults.includes('workflow_create'), false);
    assert.equal(defaults.includes('create_agent'), false);
    assert.deepEqual(defaults, [...CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS]);

    const authoring = defaultClaudeAgentSdkAllowedLocalTools('local_authoring');
    assert.ok(authoring.includes('workflow_create'));
    assert.ok(authoring.includes('workflow_run'));
    assert.ok(authoring.includes('set_model_role'));
    assert.ok(authoring.includes('memory_remember'));
    assert.ok(authoring.includes('create_agent'));
    assert.ok(authoring.includes('team_request'));
    assert.ok(authoring.includes('delegate_task'));
    assert.ok(authoring.includes('pending_action_queue'));
    assert.ok(authoring.includes('pending_action_record_result'));
    assert.equal(authoring.includes('run_shell_command'), false);
    assert.equal(authoring.includes('write_file'), false);
    assert.equal(authoring.includes('composio_execute_tool'), false);
    assert.equal(authoring.includes('delete_agent'), false);
    assert.deepEqual(authoring, [...new Set(CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS)]);

    process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS = 'ping, memory_search';
    assert.deepEqual(defaultClaudeAgentSdkAllowedLocalTools(), ['ping', 'memory_search']);
  } finally {
    if (original === undefined) delete process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS;
    else process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS = original;
  }
});

test('SDK tracker scopes are stable across retry/resume and rotate on a new chat turn', () => {
  const session = eventlog.createSession({ kind: 'chat' });
  eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'first' } });
  const first = resolveClaudeAgentSdkTrackerScope({ sessionId: session.id });
  assert.equal(first, resolveClaudeAgentSdkTrackerScope({ sessionId: session.id }), 'same logical turn keeps its scope');
  eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'second' } });
  assert.notEqual(resolveClaudeAgentSdkTrackerScope({ sessionId: session.id }), first, 'new durable user turn rotates scope');
  assert.equal(
    resolveClaudeAgentSdkTrackerScope({ sessionId: session.id, workflowRunId: 'wf-run-1', stepId: 'draft' }),
    `${session.id}::workflow:wf-run-1:draft`,
  );
  assert.equal(
    resolveClaudeAgentSdkTrackerScope({ sessionId: session.id, trackerScopeId: 'explicit-worker-scope' }),
    'explicit-worker-scope',
  );
});

test('ordinary SDK turns do not persist artifact lineage', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Summarize the current status.' },
  });
  const candidate = `${session.id}::brain:ordinary-read`;
  setClaudeAgentSdkQueryForTest(((_params: any) => successQuery('Here is the status.')) as any);

  const result = await runClaudeAgentSdk({
    prompt: 'Summarize the current status.',
    sessionId: session.id,
    sourceUserSeq: source.seq,
    trackerScopeId: candidate,
    artifactRunScopeId: candidate,
    modelId: 'claude-sonnet-4-6',
    allowedLocalMcpTools: ['memory_search'],
  });

  assert.equal(result.artifactRunScopeId, undefined);
  assert.equal(artifactLedger.getArtifactRunScope(session.id, candidate), null);
  assert.equal(artifactLedger.getArtifactRootForSourceUserSeq(session.id, source.seq), null);
});

test('foreign MCP namespaces are denied before direct provider execution while clementine-local remains callable', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const trackerScopeId = `${session.id}::foreign-mcp-denial`;
  const foreignNames = [
    'mcp__googledocs__create_document',
    'mcp__outlook__send_email',
    'mcp__foreign__ping',
    'mcp__clement-data-provider__read_record',
    'mcp__clementine-local-shadow__ping',
  ];
  const verdicts: Array<{ name: string; behavior?: string; interrupt?: boolean; message?: string }> = [];
  let localVerdict: { behavior?: string; updatedInput?: unknown } | undefined;
  let simulatedProviderBodies = 0;
  let finalQueryMcpKeys: string[] = [];

  setClaudeAgentSdkQueryForTest(((params: any) => {
    finalQueryMcpKeys = Object.keys(params.options.mcpServers ?? {}).sort();
    const query = (async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-6',
        session_id: 'sdk-foreign-mcp-denial',
        uuid: 'foreign-init',
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
      } as any;
      for (const [index, name] of foreignNames.entries()) {
        const verdict = await params.options.canUseTool(
          name,
          name.includes('send_email')
            ? { to: 'client@example.com', subject: 'Hello', body: 'Test' }
            : { probe: index },
          {
            signal: new AbortController().signal,
            toolUseID: `toolu_foreign_${index}`,
          },
        );
        verdicts.push({ name, ...verdict });
        if (verdict.behavior === 'allow') simulatedProviderBodies += 1;
      }
      localVerdict = await params.options.canUseTool(
        'mcp__clementine-local__ping',
        { probe: 'local' },
        {
          signal: new AbortController().signal,
          toolUseID: 'toolu_local_ping',
        },
      );
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-foreign-mcp-denial',
        uuid: 'foreign-result',
        result: 'Foreign MCP denied.',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
      } as any;
    })();
    return Object.assign(query, {
      close() {},
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
      streamInput: async () => {},
      stopTask: async () => false,
      backgroundTasks: async () => false,
    }) as Query;
  }) as any);

  await runClaudeAgentSdk({
    prompt: 'Attempt foreign MCP calls, then use the local ping.',
    sessionId: session.id,
    modelId: 'claude-sonnet-4-6',
    trackerScopeId,
    agentic: true,
    allowedLocalMcpTools: ['ping'],
    nativeMcpToolScope: {
      reason: 'even an explicit legacy native scope cannot reopen SDK execution',
      authority: 'exact',
      allowedToolNames: foreignNames,
      maxTools: foreignNames.length,
    },
  });

  assert.deepEqual(finalQueryMcpKeys, ['clementine-local']);
  assert.equal(simulatedProviderBodies, 0, 'foreign permission denial keeps every direct provider body at zero');
  assert.equal(verdicts.length, foreignNames.length);
  for (const verdict of verdicts) {
    assert.equal(verdict.behavior, 'deny', verdict.name);
    assert.equal(verdict.interrupt, false, verdict.name);
    assert.match(verdict.message ?? '', /FOREIGN_MCP_DIRECT_EXECUTION_DENIED/);
    assert.match(verdict.message ?? '', /call_tool\/work_call carrier/);
  }
  assert.equal(localVerdict?.behavior, 'allow', 'the owned local Clementine proxy remains callable');
  assert.deepEqual(localVerdict?.updatedInput, { probe: 'local' });
  assert.equal(eventlog.listEvents(session.id, { types: ['external_write'] }).length, 0);
  assert.equal(eventlog.listEvents(session.id, { types: ['external_write_succeeded'] }).length, 0);
  assert.equal(eventlog.listEvents(session.id, { types: ['external_write_failed'] }).length, 0);
  assert.equal(artifactLedger.listRunArtifacts(session.id, trackerScopeId).length, 0);
});

test('buildClaudeAgentSdkLocalMcpServers exposes the local Clementine MCP in-process SDK server by default', () => {
  const servers = buildClaudeAgentSdkLocalMcpServers('brain-session-1');
  const local = servers['clementine-local'] as any;
  assert.equal(local.type, 'sdk');
  assert.equal(local.name, 'clementine-local');
  assert.ok(local.instance, 'in-process MCP server instance should be present');
});

test('buildClaudeAgentSdkLocalMcpServers preserves an explicit empty authority boundary', () => {
  assert.deepEqual(
    buildClaudeAgentSdkLocalMcpServers('brain-session-decision-only', true, []),
    {},
    '[] means zero local MCP tools; only undefined may select the default surface',
  );
});

test('buildClaudeAgentSdkLocalMcpServers marks only the selected local tools always-load for native deferral', () => {
  const servers = buildClaudeAgentSdkLocalMcpServers(
    'brain-session-deferred',
    true,
    undefined,
    undefined,
    { alwaysLoadTools: ['memory_recall_all', 'tool_search'], deferUnlistedTools: true },
  );
  const local = servers['clementine-local'] as any;
  const registered = local.instance?._registeredTools as Record<string, { _meta?: Record<string, unknown> }>;
  assert.equal(registered.memory_recall_all?._meta?.['anthropic/alwaysLoad'], true);
  assert.equal(registered.tool_search?._meta?.['anthropic/alwaysLoad'], true);
  assert.equal(registered.workflow_update?._meta?.['anthropic/alwaysLoad'], undefined);
});

test('buildClaudeAgentSdkLocalMcpServers can fall back to the local Clementine MCP stdio server', () => {
  const original = process.env.CLEMMY_CLAUDE_SDK_INPROCESS_MCP;
  try {
    process.env.CLEMMY_CLAUDE_SDK_INPROCESS_MCP = 'off';
    const servers = buildClaudeAgentSdkLocalMcpServers(
      'brain-session-1',
      false,
      undefined,
      {
        sourceUserSeq: 123,
        directOrchestrator: true,
        dispatchLease: {
          sessionId: 'brain-session-1',
          scopeId: 'brain-session-1::sdk',
          leaseId: 'lease-123',
        },
      },
    );
    const local = servers['clementine-local'] as any;
    assert.equal(local.type, 'stdio');
    assert.ok(local.command === 'npx' || local.command.length > 0);
    assert.equal(local.alwaysLoad, true);
    assert.equal(local.env.CLEMENTINE_HOME, TMP_HOME);
    assert.equal(local.env.CLEMENTINE_MCP_SESSION_ID, 'brain-session-1');
    assert.equal(local.env.CLEMENTINE_MCP_SOURCE_USER_SEQ, '123');
    assert.equal(local.env.CLEMENTINE_MCP_DIRECT_ORCHESTRATOR, 'on');
    assert.deepEqual(
      JSON.parse(local.env.CLEMENTINE_MCP_DISPATCH_LEASE_JSON),
      {
        sessionId: 'brain-session-1',
        scopeId: 'brain-session-1::sdk',
        leaseId: 'lease-123',
      },
    );
    assert.ok(Array.isArray(local.args));
    assert.ok(local.args.some((arg: string) => arg.includes('mcp-server')));

    const workerServers = buildClaudeAgentSdkLocalMcpServers(
      'worker-session-stdio',
      true,
      undefined,
      { directOrchestrator: false, workerScope: true },
    );
    const workerLocal = workerServers['clementine-local'] as any;
    assert.equal(workerLocal.env.CLEMENTINE_MCP_DIRECT_ORCHESTRATOR, 'off');
    assert.equal(workerLocal.env.CLEMENTINE_MCP_WORKER_SCOPE, 'on', 'stdio workers preserve compose-only authority');

    const deferred = buildClaudeAgentSdkLocalMcpServers(
      'brain-session-deferred-stdio',
      true,
      undefined,
      undefined,
      {
        alwaysLoadTools: ['memory_recall_all'],
        deferUnlistedTools: true,
        deferredTools: ['workflow_update'],
      },
    )['clementine-local'] as any;
    assert.equal(deferred.alwaysLoad, false);
    assert.equal(deferred.env.CLEMENTINE_MCP_ALWAYS_LOAD_TOOLS, 'memory_recall_all');
    assert.equal(deferred.env.CLEMENTINE_MCP_DEFERRED_TOOLS, 'workflow_update');
  } finally {
    if (original === undefined) delete process.env.CLEMMY_CLAUDE_SDK_INPROCESS_MCP;
    else process.env.CLEMMY_CLAUDE_SDK_INPROCESS_MCP = original;
  }
});

test('buildAllowOnlyToolsPermission allows exact/tail matches and denies everything else', async () => {
  const canUse = buildAllowOnlyToolsPermission(['ping']);
  // The CLI's control protocol REQUIRES updatedInput on allow — a bare allow
  // fails its Zod parse and the tool call dies (2026-07-02 task_hygiene).
  assert.deepEqual(
    await canUse('mcp__clementine-local__ping', { probe: 1 }, { signal: new AbortController().signal, toolUseID: 'a' }),
    { behavior: 'allow', updatedInput: { probe: 1 } },
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

function hangingQuery(onClose: () => void): Query {
  const q = {
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise<IteratorResult<SDKMessage>>(() => {}); },
    close() { onClose(); },
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    streamInput: async () => {},
    stopTask: async () => false,
    backgroundTasks: async () => false,
  } as unknown as Query;
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
        total_cost_usd: 0.004,
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
  assert.equal(capture.call.options.model, 'claude-sonnet-4-6');
  assert.deepEqual(capture.call.options.allowedTools, []);
  assert.equal(capture.call.options.permissionMode, 'default');
  const canUse = capture.call.options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<any>;
  assert.equal((await canUse('mcp__clementine-local__ping', {}, {})).behavior, 'allow');
  assert.equal(capture.call.options.mcpServers['clementine-local'].type, 'sdk');
  assert.equal(capture.call.options.mcpServers['clementine-local'].name, 'clementine-local');
  assert.ok(capture.call.options.mcpServers['clementine-local'].instance);
  assert.equal(result.text, 'ok');
  assert.deepEqual(result.structuredOutput, { ok: true });
  assert.deepEqual(result.toolUses, ['mcp__clementine-local__ping']);
  assert.deepEqual(result.modelRouteUsage, {
    inputTokens: 1,
    cachedTokens: 0,
    outputTokens: 1,
    totalTokens: 2,
    costUsd: 0.004,
  });
});

test('byte-identical replayed assistant frames contribute one returned tool use', async () => {
  const toolUse = {
    type: 'tool_use',
    id: 'toolu_replayed_frame',
    name: 'mcp__clementine-local__ping',
    input: { probe: true },
  };
  setClaudeAgentSdkQueryForTest((() => queryFromMessages([
    {
      type: 'system', subtype: 'init', model: 'claude-sonnet-4-6',
      session_id: 'sdk-frame-replay', uuid: 'frame-init', apiKeySource: 'none',
      claude_code_version: '2.1.181', cwd: process.cwd(),
      tools: ['mcp__clementine-local__ping'],
      mcp_servers: [{ name: 'clementine-local', status: 'connected' }],
      permissionMode: 'default', slash_commands: [], output_style: 'default', skills: [], plugins: [],
    } as any,
    {
      type: 'assistant', session_id: 'sdk-frame-replay', uuid: 'frame-assistant-1',
      parent_tool_use_id: null, message: { content: [toolUse] },
    } as any,
    {
      type: 'assistant', session_id: 'sdk-frame-replay', uuid: 'frame-assistant-replay',
      parent_tool_use_id: null,
      message: { content: [toolUse] },
    } as any,
    {
      type: 'result', subtype: 'success', session_id: 'sdk-frame-replay', uuid: 'frame-done',
      result: 'ok', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1,
      stop_reason: 'end_turn', total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
    } as any,
  ], {})) as any);

  const result = await runClaudeAgentSdk({
    prompt: 'Ping once.',
    sessionId: 'sdk-frame-replay',
    modelId: 'claude-sonnet-4-6',
    allowedLocalMcpTools: ['ping'],
  });

  assert.deepEqual(result.toolUses, ['mcp__clementine-local__ping']);
  assert.equal(result.toolCallLedger?.length, 1, 'canonical event/call accounting remains one row');
  assert.equal(result.toolCallLedger?.[0]?.name, 'ping', 'a replay cannot replace canonical call metadata');
});

test('agentic schema-on-demand registers only the hot kernel while keeping deferred tools callable', async () => {
  const capture: { call?: any } = {};
  setClaudeAgentSdkQueryForTest(((params: any) => {
    capture.call = params;
    return queryFromMessages([
      {
        type: 'system', subtype: 'init', model: 'claude-sonnet-4-6',
        session_id: 'sdk-deferred-local', uuid: 'deferred-init', apiKeySource: 'none',
        claude_code_version: '2.1.181', cwd: process.cwd(),
        tools: ['mcp__clementine-local__memory_recall_all', 'mcp__clementine-local__tool_search'],
        mcp_servers: [{ name: 'clementine-local', status: 'connected' }],
        permissionMode: 'default', slash_commands: [], output_style: 'default', skills: [], plugins: [],
      } as any,
      {
        type: 'result', subtype: 'success', session_id: 'sdk-deferred-local', uuid: 'deferred-result',
        result: 'ok', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1,
        stop_reason: 'end_turn', total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
      } as any,
    ], {});
  }) as any);

  await runClaudeAgentSdk({
    prompt: 'Recall, then continue.',
    sessionId: 'sdk-deferred-local-clem',
    agentic: true,
    allowedLocalMcpTools: ['memory_recall_all', 'tool_search'],
    mcpToolAllowlist: ['memory_recall_all', 'tool_search'],
    localMcpToolUniverse: ['memory_recall_all', 'tool_search', 'workflow_update'],
    requiredLocalMcpTools: ['memory_recall_all'],
  });

  const local = capture.call.options.mcpServers['clementine-local'] as any;
  const registered = local.instance._registeredTools as Record<string, { _meta?: Record<string, unknown> }>;
  assert.ok(registered.memory_recall_all);
  assert.ok(registered.tool_search);
  assert.ok(registered.call_tool, 'generic same-turn dispatcher is first-class');
  assert.equal(registered.workflow_update, undefined, 'deferred schemas are not registered or billed');
});

test('agentic schema-on-demand keeps local-runtime-only tools deferred even when explicitly selected', async () => {
  const capture: { call?: any } = {};
  setClaudeAgentSdkQueryForTest(((params: any) => {
    capture.call = params;
    return queryFromMessages([
      {
        type: 'system', subtype: 'init', model: 'claude-sonnet-4-6',
        session_id: 'sdk-runtime-only', uuid: 'runtime-only-init', apiKeySource: 'none',
        claude_code_version: '2.1.181', cwd: process.cwd(),
        tools: ['mcp__clementine-local__tool_search', 'mcp__clementine-local__call_tool'],
        mcp_servers: [{ name: 'clementine-local', status: 'connected' }],
        permissionMode: 'default', slash_commands: [], output_style: 'default', skills: [], plugins: [],
      } as any,
      {
        type: 'result', subtype: 'success', session_id: 'sdk-runtime-only', uuid: 'runtime-only-result',
        result: 'ok', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1,
        stop_reason: 'end_turn', total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
      } as any,
    ], {});
  }) as any);

  await runClaudeAgentSdk({
    prompt: 'Use workspace_roots.',
    sessionId: 'sdk-runtime-only-clem',
    agentic: true,
    allowedLocalMcpTools: ['workspace_roots', 'tool_search'],
    mcpToolAllowlist: ['workspace_roots', 'tool_search'],
    localMcpToolUniverse: ['workspace_roots', 'tool_search'],
    requiredLocalMcpTools: ['tool_search', 'call_tool'],
  });

  const local = capture.call.options.mcpServers['clementine-local'] as any;
  const registered = local.instance._registeredTools as Record<string, unknown>;
  assert.equal(registered.workspace_roots, undefined, 'no nonexistent first-class MCP adapter is promised');
  assert.ok(registered.tool_search);
  assert.ok(registered.call_tool);
  const searched = await (registered.tool_search as any).handler({
    query: 'list configured workspace root paths',
    limit: 8,
  });
  const body = JSON.parse(searched.content[0].text) as { results: Array<{ name: string }> };
  assert.ok(body.results.some((result) => result.name === 'workspace_roots'));

  const {
    boundClementineMcpCapabilityEnvelope,
    boundClementineMcpCapabilityRevision,
  } = await import('../../tools/mcp-server.js');
  const envelope = await boundClementineMcpCapabilityEnvelope(local.instance);
  const initial = await boundClementineMcpCapabilityRevision(local.instance);
  assert.ok(envelope?.capabilities.some((capability) => capability.name === 'workspace_roots'),
    'Claude deferred authority was not in the sealed per-query universe');
  assert.equal(initial?.revision, 1);
  assert.equal(initial?.bound.includes('workspace_roots'), false);

  const called = await (registered.call_tool as any).handler({
    name: 'workspace_roots',
    args_json: '{}',
  });
  assert.doesNotMatch(called.content[0].text, /requires_readmission|not_reachable/i);
  const acquired = await boundClementineMcpCapabilityRevision(local.instance);
  assert.equal(acquired?.revision, 2);
  assert.equal(acquired?.bound.includes('workspace_roots'), true);
});

test('Claude direct discovery denies same-id replay, admits a settled continuation, and denies its unexecuted replay after restart', async () => {
  const { discoveryGovernor } = await import('./discovery-governor.js');
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Find the right built-in workspace inspection capability.' },
  });
  const verdicts: Array<{ id: string; behavior: string; message?: string }> = [];
  let simulatedProviderBodies = 0;
  setClaudeAgentSdkQueryForTest(((params: any) => {
    const firstId = 'toolu_discovery_first';
    const secondId = 'toolu_discovery_second';
    const firstInput = { query: 'find a tool that can inspect configured workspace roots' };
    const secondInput = { query: 'find another tool that can inspect repository roots' };
    const gen = (async function* () {
      yield {
        type: 'system', subtype: 'init', model: 'claude-sonnet-4-6',
        session_id: 'sdk-discovery-budget', uuid: 'discovery-init', apiKeySource: 'none',
        claude_code_version: '2.1.181', cwd: process.cwd(),
        tools: ['mcp__clementine-local__tool_search'],
        mcp_servers: [{ name: 'clementine-local', status: 'connected' }],
        permissionMode: 'default', slash_commands: [], output_style: 'default', skills: [], plugins: [],
      } as any;
      const firstPermission = params.options.canUseTool(
        'mcp__clementine-local__tool_search',
        firstInput,
        { signal: new AbortController().signal, toolUseID: firstId },
      );
      const concurrentReplayPermission = params.options.canUseTool(
        'mcp__clementine-local__tool_search',
        firstInput,
        { signal: new AbortController().signal, toolUseID: firstId },
      );
      const [first, concurrentReplay] = await Promise.all([
        firstPermission,
        concurrentReplayPermission,
      ]);
      verdicts.push({ id: firstId, behavior: first.behavior, message: first.message });
      verdicts.push({
        id: firstId,
        behavior: concurrentReplay.behavior,
        message: concurrentReplay.message,
      });
      if (first.behavior === 'allow') {
        simulatedProviderBodies += 1;
        yield {
          type: 'assistant', session_id: 'sdk-discovery-budget', uuid: 'discovery-use',
          parent_tool_use_id: null,
          message: { content: [{
            type: 'tool_use', id: firstId,
            name: 'mcp__clementine-local__tool_search', input: firstInput,
          }] },
        } as any;
        yield {
          type: 'user', session_id: 'sdk-discovery-budget', uuid: 'discovery-result',
          parent_tool_use_id: null,
          message: { content: [{
            type: 'tool_result', tool_use_id: firstId,
            content: '{"results":[{"name":"workspace_roots"}]}',
          }] },
        } as any;
      }
      const exactReplay = await params.options.canUseTool(
        'mcp__clementine-local__tool_search',
        firstInput,
        { signal: new AbortController().signal, toolUseID: firstId },
      );
      verdicts.push({ id: firstId, behavior: exactReplay.behavior, message: exactReplay.message });
      if (exactReplay.behavior === 'allow') simulatedProviderBodies += 1;
      const second = await params.options.canUseTool(
        'mcp__clementine-local__tool_search',
        secondInput,
        { signal: new AbortController().signal, toolUseID: secondId },
      );
      verdicts.push({ id: secondId, behavior: second.behavior, message: second.message });
      yield {
        type: 'result', subtype: 'success', session_id: 'sdk-discovery-budget',
        uuid: 'discovery-done', result: 'Found the workspace tool.',
        duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1,
        stop_reason: 'end_turn', total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
      } as any;
    })();
    return Object.assign(gen, {
      close() {}, interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }), streamInput: async () => {},
      stopTask: async () => false, backgroundTasks: async () => false,
    }) as Query;
  }) as any);

  const runOptions = {
    prompt: 'Find the correct workspace inspection capability.',
    sessionId: session.id,
    sourceUserSeq: source.seq,
    modelId: 'claude-sonnet-4-6',
    agentic: true,
    allowedLocalMcpTools: ['tool_search'],
    mcpToolAllowlist: ['tool_search'],
    localMcpToolUniverse: ['tool_search', 'workspace_roots'],
  };
  await runClaudeAgentSdk(runOptions);
  // A fresh SDK query owns fresh in-memory permission maps, so this is the
  // restart boundary for the wrapper. Durable governor state must still keep
  // every replay at zero provider bodies.
  await runClaudeAgentSdk(runOptions);

  assert.deepEqual(
    verdicts.map((verdict) => verdict.behavior),
    ['allow', 'deny', 'deny', 'allow', 'deny', 'deny', 'deny', 'deny'],
  );
  assert.match(verdicts[1]?.message ?? '', /same_call_replay/);
  assert.match(verdicts[2]?.message ?? '', /same_call_replay/);
  assert.match(verdicts[4]?.message ?? '', /new_call_requires_retry_epoch/);
  assert.match(verdicts[7]?.message ?? '', /same_call_replay/);
  assert.equal(
    simulatedProviderBodies,
    1,
    'only the permission the fixture actually executes reaches its simulated provider body',
  );
  const state = discoveryGovernor.getTaskState({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(state?.claims.broad_discovery?.callId, 'toolu_discovery_second');
  assert.equal(
    state?.claims.broad_discovery?.outcome,
    'failed',
    'the admitted continuation that never produced a tool result is settled failed at the SDK boundary',
  );
  assert.equal(
    eventlog.listEvents(session.id, { types: ['discovery_governor_decision'] }).length,
    4,
    'the same-id permission-cache denial does not pretend to be a second governor occurrence',
  );
  const decisions = eventlog.listEvents(session.id, { types: ['discovery_governor_decision'] });
  assert.equal(decisions.filter((event) => event.data.decision === 'admitted').length, 2);
  const outcomes = eventlog.listEvents(session.id, { types: ['discovery_governor_outcome'] });
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0]?.data.callId, 'toolu_discovery_first');
  assert.equal(outcomes[0]?.data.recorded, true, 'the executed provider body settles exactly');
  assert.equal(outcomes[1]?.data.callId, 'toolu_discovery_second');
  assert.equal(outcomes[1]?.data.outcome, 'failed');
  assert.equal(
    outcomes[1]?.data.recorded,
    true,
    'the admitted continuation with no returned tool result is durably closed as failed',
  );
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
  const health = capabilityHealth.readHarnessCapabilityHealth('claude_sdk_local_mcp_surface');
  assert.ok(health, 'missing required tool should be persisted as harness capability health');
  assert.equal(health!.state, 'degraded');
  assert.match(health!.reason ?? '', /run_shell_command/);
  assert.deepEqual((health!.details as { missingTools?: unknown }).missingTools, ['run_shell_command']);
  assert.deepEqual((health!.details as { availableTools?: unknown }).availableTools, ['mcp__clementine-local__ping']);
});

test('runClaudeAgentSdk retries once when the local MCP surface is temporarily empty', async () => {
  let calls = 0;
  setClaudeAgentSdkQueryForTest(((_params: any) => {
    calls += 1;
    if (calls === 1) {
      return queryFromMessages([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude-sonnet-4-6',
          session_id: 'sdk-empty-surface-1',
          uuid: 'u-empty',
          apiKeySource: 'none',
          claude_code_version: '2.1.181',
          cwd: process.cwd(),
          tools: [],
          mcp_servers: [{ name: 'clementine-local', status: 'connected' }],
          permissionMode: 'default',
          slash_commands: [],
          output_style: 'default',
          skills: [],
          plugins: [],
        } as any,
      ], {});
    }
    return queryFromMessages([
      {
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-6',
        session_id: 'sdk-empty-surface-2',
        uuid: 'u-ready',
        apiKeySource: 'none',
        claude_code_version: '2.1.181',
        cwd: process.cwd(),
        tools: ['mcp__clementine-local__memory_recall'],
        mcp_servers: [{ name: 'clementine-local', status: 'connected' }],
        permissionMode: 'default',
        slash_commands: [],
        output_style: 'default',
        skills: [],
        plugins: [],
      } as any,
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-empty-surface-2',
        uuid: 'u-result',
        result: 'ready',
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

  const originalRetries = process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_RETRIES;
  const originalBackoff = process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_BACKOFF_MS;
  try {
    process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_RETRIES = '1';
    process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_BACKOFF_MS = '0';
    const result = await runClaudeAgentSdk({
      prompt: 'Use memory.',
      sessionId: 'sdk-empty-surface-session',
      modelId: 'claude-sonnet-4-6',
      agentic: true,
      requiredLocalMcpTools: ['memory_recall'],
    });

    assert.equal(calls, 2);
    assert.equal(result.text, 'ready');
    const health = capabilityHealth.readHarnessCapabilityHealth('claude_sdk_local_mcp_surface');
    assert.ok(health);
    assert.equal(health!.state, 'healthy');
    assert.equal((health!.details as { availableToolCount?: unknown }).availableToolCount, 1);
  } finally {
    if (originalRetries === undefined) delete process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_RETRIES;
    else process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_RETRIES = originalRetries;
    if (originalBackoff === undefined) delete process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_BACKOFF_MS;
    else process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_BACKOFF_MS = originalBackoff;
  }
});

test('runClaudeAgentSdk default empty-surface retry window survives repeated cold-start empty inits', async () => {
  let calls = 0;
  setClaudeAgentSdkQueryForTest(((_params: any) => {
    calls += 1;
    if (calls <= 2) {
      return queryFromMessages([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude-sonnet-4-6',
          session_id: `sdk-empty-surface-${calls}`,
          uuid: `u-empty-${calls}`,
          apiKeySource: 'none',
          claude_code_version: '2.1.181',
          cwd: process.cwd(),
          tools: [],
          mcp_servers: [{ name: 'clementine-local', status: 'connected' }],
          permissionMode: 'default',
          slash_commands: [],
          output_style: 'default',
          skills: [],
          plugins: [],
        } as any,
      ], {});
    }
    return queryFromMessages([
      {
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-6',
        session_id: 'sdk-empty-surface-ready',
        uuid: 'u-ready',
        apiKeySource: 'none',
        claude_code_version: '2.1.181',
        cwd: process.cwd(),
        tools: ['mcp__clementine-local__memory_recall'],
        mcp_servers: [{ name: 'clementine-local', status: 'connected' }],
        permissionMode: 'default',
        slash_commands: [],
        output_style: 'default',
        skills: [],
        plugins: [],
      } as any,
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-empty-surface-ready',
        uuid: 'u-result',
        result: 'ready after cold start',
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

  const originalRetries = process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_RETRIES;
  const originalBackoff = process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_BACKOFF_MS;
  try {
    delete process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_RETRIES;
    process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_BACKOFF_MS = '0';
    const result = await runClaudeAgentSdk({
      prompt: 'Use memory.',
      sessionId: 'sdk-repeated-empty-surface-session',
      modelId: 'claude-sonnet-4-6',
      agentic: true,
      requiredLocalMcpTools: ['memory_recall'],
    });

    assert.equal(calls, 3);
    assert.equal(result.text, 'ready after cold start');
  } finally {
    if (originalRetries === undefined) delete process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_RETRIES;
    else process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_RETRIES = originalRetries;
    if (originalBackoff === undefined) delete process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_BACKOFF_MS;
    else process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_BACKOFF_MS = originalBackoff;
  }
});

test('runClaudeAgentSdk retries a required local MCP startup that never emits init before falling through', async () => {
  let calls = 0;
  let closed = 0;
  setClaudeAgentSdkQueryForTest(((_params: any) => {
    calls += 1;
    if (calls === 1) return hangingQuery(() => { closed += 1; });
    return queryFromMessages([
      {
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-6',
        session_id: 'sdk-startup-timeout-ready',
        uuid: 'u-ready',
        apiKeySource: 'none',
        claude_code_version: '2.1.181',
        cwd: process.cwd(),
        tools: ['mcp__clementine-local__memory_recall'],
        mcp_servers: [{ name: 'clementine-local', status: 'connected' }],
        permissionMode: 'default',
        slash_commands: [],
        output_style: 'default',
        skills: [],
        plugins: [],
      } as any,
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-startup-timeout-ready',
        uuid: 'u-result',
        result: 'ready after no-init retry',
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

  const originalStartupMs = process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_FIRST_MESSAGE_MS;
  const originalStartupRetries = process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_STARTUP_RETRIES;
  const originalBackoff = process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_BACKOFF_MS;
  try {
    process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_FIRST_MESSAGE_MS = '5';
    process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_STARTUP_RETRIES = '1';
    process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_BACKOFF_MS = '0';
    const result = await runClaudeAgentSdk({
      prompt: 'Use memory.',
      sessionId: 'sdk-startup-timeout-session',
      modelId: 'claude-sonnet-4-6',
      agentic: true,
      requiredLocalMcpTools: ['memory_recall'],
    });

    assert.equal(calls, 2);
    assert.ok(closed >= 1, 'timed-out SDK stream was closed before retrying');
    assert.equal(result.text, 'ready after no-init retry');
  } finally {
    if (originalStartupMs === undefined) delete process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_FIRST_MESSAGE_MS;
    else process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_FIRST_MESSAGE_MS = originalStartupMs;
    if (originalStartupRetries === undefined) delete process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_STARTUP_RETRIES;
    else process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_STARTUP_RETRIES = originalStartupRetries;
    if (originalBackoff === undefined) delete process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_BACKOFF_MS;
    else process.env.CLEMMY_CLAUDE_SDK_TOOL_SURFACE_BACKOFF_MS = originalBackoff;
  }
});

test('runClaudeAgentSdk records raw cache creation and explicit role for usage diagnostics', async () => {
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
      type: 'assistant',
      session_id: 'sdk-session-usage',
      uuid: 'usage-assistant-1',
      parent_tool_use_id: null,
      message: {
        id: 'usage-assistant-message-1',
        model: 'claude-opus-4-8',
        role: 'assistant',
        stop_reason: 'end_turn',
        stop_sequence: null,
        content: [{ type: 'text', text: 'ok' }],
        // Deliberately different from the aggregate result below: healthy
        // turns must keep the result frame authoritative, not double-count the
        // assistant-frame fallback.
        usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 50 },
      },
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

  await runClaudeAgentSdk({
    prompt: 'hi',
    sessionId,
    modelId: 'claude-opus-4-8',
    workerScope: true,
  });

  const events = usageLog.readUsageEventsForDate().filter((e) => e.source === sessionId);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'other');
  assert.equal(events[0].model, 'claude-opus-4-8');
  assert.equal(events[0].inputTokens, 20);
  assert.equal(events[0].cachedInputTokens, 7);
  assert.equal(events[0].cacheCreationInputTokens, 3);
  assert.equal(events[0].outputTokens, 5);
  assert.equal(events[0].totalTokens, 25);
  assert.equal(events[0].durationMs, 17);
  assert.equal(events[0].providerApiDurationMs, 12);
  assert.equal(events[0].responseId, 'usage-result-1');
  assert.equal(events[0].trace?.lane, 'worker');
  assert.equal(events[0].promptComponents?.currentMessage, 1);
  assert.equal(events[0].promptComponents?.providerAndToolOverhead, 19);

  const operationalEvents = operationalTelemetry.listOperationalEvents({
    source: 'model',
    type: 'model_call_completed',
    sessionId,
    limit: 10,
  });
  assert.equal(operationalEvents.length, 1);
  assert.equal(operationalEvents[0].payload.durationMs, 17);
  assert.equal(operationalEvents[0].payload.providerApiDurationMs, 12);
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
  assert.deepEqual(capture.call.options.allowedTools, []);
  assert.equal(capture.call.options.permissionMode, 'default');
  const canUse = capture.call.options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<any>;
  assert.equal((await canUse('mcp__clementine-local__memory_search', {}, {})).behavior, 'allow');
  assert.equal((await canUse('mcp__clementine-local__run_shell_command', { command: 'echo hi' }, {})).behavior, 'deny');
  assert.equal((await canUse('mcp__clementine-local__composio_execute_tool', {}, {})).behavior, 'deny');
});

test('agentic SDK runs leave allowedTools empty so canUseTool is the permission authority', async () => {
  const capture: { call?: any } = {};
  setClaudeAgentSdkQueryForTest(((params: any) => {
    capture.call = params;
    return successQuery('ok');
  }) as any);

  await runClaudeAgentSdk({
    prompt: 'Read a file safely.',
    sessionId: 'sdk-agentic-permission-authority',
    modelId: 'claude-sonnet-4-6',
    agentic: true,
    allowedLocalMcpTools: ['read_file', 'memory_search', 'run_shell_command'],
  });

  assert.deepEqual(capture.call.options.allowedTools, []);
  assert.equal(capture.call.options.permissionMode, 'default');
  const canUse = capture.call.options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<any>;
  const verdict = await canUse('mcp__clementine-local__read_file', { path: '/tmp/example.txt' }, {
    signal: new AbortController().signal,
    toolUseID: 'toolu_read',
    requestId: 'req_read',
  });
  assert.equal(verdict.behavior, 'allow');
  assert.deepEqual(verdict.updatedInput, { path: '/tmp/example.txt' });
});

test('Claude native canUseTool interrupts a superseded physical attempt', async () => {
  const {
    activateDispatchLease,
    revokeDispatchLease,
  } = await import('./dispatch-lease.js');
  const session = eventlog.createSession({ kind: 'chat' });
  const dispatchLease = activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::sdk`,
  });
  const capture: { call?: any } = {};
  setClaudeAgentSdkQueryForTest(((params: any) => {
    capture.call = params;
    return successQuery('ok');
  }) as any);

  await runClaudeAgentSdk({
    prompt: 'Read a file safely.',
    sessionId: session.id,
    modelId: 'claude-sonnet-4-6',
    agentic: true,
    dispatchLease,
    allowedLocalMcpTools: ['read_file'],
  });

  const canUse = capture.call.options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<any>;
  revokeDispatchLease(dispatchLease);
  const verdict = await canUse(
    'mcp__clementine-local__read_file',
    { path: '/tmp/example.txt' },
    {
      signal: new AbortController().signal,
      toolUseID: 'toolu_stale_read',
      requestId: 'req_stale_read',
    },
  );
  assert.equal(verdict.behavior, 'deny');
  assert.equal(verdict.interrupt, true);
  assert.match(verdict.message, /no longer authoritative/i);
});

// Brain continuity: a Claude Agent SDK turn must feed its tool returns into the
// SAME reflection pipeline the Codex loop uses, so Clementine learns from Claude
// turns instead of going amnesiac. The Agent SDK runs its tool loop outside the
// @openai/agents RunHooks, so this is sourced from the SDK message stream.
const LONG_SALESFORCE_TOOL_INPUT = {
  tool_slug: 'SALESFORCE_QUERY',
  arguments: { query: 'private-query-fragment '.repeat(30) },
};

function streamWithToolReturn(): SDKMessage[] {
  return [
    { type: 'system', subtype: 'init', model: 'claude-opus-4-8', session_id: 'sdk-session', uuid: 'u1', apiKeySource: 'none', claude_code_version: '2.1.181', cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'default', slash_commands: [], output_style: 'default', skills: [], plugins: [] } as any,
    { type: 'assistant', session_id: 'sdk-session', uuid: 'u2', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_42', name: 'mcp__clementine-local__composio_execute_tool', input: LONG_SALESFORCE_TOOL_INPUT }] } } as any,
    { type: 'user', session_id: 'sdk-session', uuid: 'u3', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_42', content: 'Acme Corp has 3 open opportunities worth $45,000 total.' }] } } as any,
    { type: 'result', subtype: 'success', session_id: 'sdk-session', uuid: 'u4', result: 'done', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [] } as any,
  ];
}

function sdkLocalToolReturnStream(input: {
  callId: string;
  toolName: string;
  toolInput: unknown;
  output: string;
  isError?: boolean;
}): SDKMessage[] {
  return [
    initOnlyMessage(),
    {
      type: 'assistant',
      session_id: 'sdk-session',
      uuid: `${input.callId}-use`,
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: input.callId,
          name: input.toolName,
          input: input.toolInput,
        }],
      },
    } as any,
    {
      type: 'user',
      session_id: 'sdk-session',
      uuid: `${input.callId}-return`,
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: input.callId,
          content: input.output,
          ...(input.isError ? { is_error: true } : {}),
        }],
      },
    } as any,
    successResultMessage('done'),
  ];
}

test('standalone Claude preserves the bounded full workflow_get result but never an error result', async () => {
  const metadataResult =
    'Workflow metadata (step prompts and workflow body omitted):\n'
    + JSON.stringify({
      name: 'SDK Metadata Parity',
      description: 'bounded metadata '.repeat(35),
      enabled: true,
      trigger: {
        schedule: '0 8,12,16 * * 1-5',
        timezone: 'America/Los_Angeles',
        manual: false,
      },
      step_count: 1,
      steps: [{ id: 'review', executor: { kind: 'model' } }],
    }, null, 2);
  assert.ok(metadataResult.length > 400, 'fixture must exceed the generic SDK preview');
  assert.ok(metadataResult.length < 4_000, 'fixture stays inside workflow_get metadata bounds');

  const runCase = async (
    label: string,
    output: string,
    isError = false,
    section: 'metadata' | 'full' = 'metadata',
    toolName = 'mcp__clementine-local__workflow_get',
  ) => {
    const session = eventlog.createSession({ id: `sdk-workflow-get-result-${label}`, kind: 'chat' });
    const source = eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Read the SDK Metadata Parity workflow metadata.' },
    });
    setClaudeAgentSdkQueryForTest(((_params: any) => queryFromMessages(sdkLocalToolReturnStream({
      callId: `toolu_workflow_get_${label}`,
      toolName,
      toolInput: { name: 'SDK Metadata Parity', section },
      output,
      isError,
    }), {})) as any);
    setClaudeAgentSdkReflectionForTest((() => {}) as any);
    await runClaudeAgentSdk({
      prompt: 'Read the SDK Metadata Parity workflow metadata.',
      sessionId: session.id,
      sourceUserSeq: source.seq,
      agentic: true,
      directOrchestrator: true,
      allowedLocalMcpTools: ['workflow_get'],
    });
    const returned = eventlog.listEvents(session.id, { types: ['tool_returned'] });
    assert.equal(returned.length, 1);
    assert.equal(returned[0]!.data.tool, 'workflow_get');
    assert.equal(returned[0]!.data.accounting, 'top_level');
    return returned[0]!;
  };

  const successful = await runCase('success', metadataResult);
  assert.equal(successful.data.result, metadataResult, 'full bounded metadata survives beyond the 400-char preview');
  assert.equal(String(successful.data.preview).length, 400);

  const failed = await runCase(
    'error',
    JSON.stringify({ isError: true, content: [{ type: 'text', text: metadataResult }] }),
  );
  assert.equal(failed.data.ok, true, 'the transport itself returned normally');
  assert.equal(failed.data.result, undefined, 'an SDK error envelope never becomes terminal result authority');

  const contradicted = await runCase(
    'contradicted-success',
    JSON.stringify({ success: false, content: [{ type: 'text', text: metadataResult }] }),
  );
  assert.equal(contradicted.data.ok, true, 'the transport itself returned normally');
  assert.equal(
    contradicted.data.result,
    undefined,
    'a returned structured failure cannot borrow the successful transport result field',
  );

  const fullDefinition = await runCase('full-definition', metadataResult, false, 'full');
  assert.equal(
    fullDefinition.data.result,
    undefined,
    'only the producer-bounded metadata mode receives full-result event storage',
  );

  const externalSameTail = await runCase(
    'external-same-tail',
    metadataResult,
    false,
    'metadata',
    'mcp__other-server__workflow_get',
  );
  assert.equal(
    externalSameTail.data.result,
    undefined,
    'an external server cannot borrow the local workflow_get full-result surface by tail name',
  );
});

test('runClaudeAgentSdk retains canonical tool results without per-return learning', async () => {
  setClaudeAgentSdkQueryForTest(((_params: any) => queryFromMessages(streamWithToolReturn(), {})) as any);
  const reflected: Array<{ sessionId: string; callId: string; tool: string | null; output: string }> = [];
  setClaudeAgentSdkReflectionForTest(((input: any) => { reflected.push(input); }) as any);
  const sess = eventlog.createSession({ id: 'clem-sess-1', kind: 'chat' });

  const previousCapabilityCatalog = currentCapabilityFixtures.installCurrentCapabilityManifestFixtures([{
    operationId: 'SALESFORCE_QUERY',
    providerKind: 'composio',
    effect: 'read',
  }]);
  try {
    await runClaudeAgentSdk({ prompt: 'Look up Acme.', sessionId: sess.id, agentic: true });
  } finally {
    currentCapabilityFixtures.restoreCurrentCapabilityManifestFixtures(previousCapabilityCatalog);
  }

  assert.equal(reflected.length, 0, 'terminal-batch intake is the sole learning owner');

  const returned = eventlog.listEvents(sess.id, { types: ['tool_returned'] });
  const called = eventlog.listEvents(sess.id, { types: ['tool_called'] });
  assert.equal(called.length, 1);
  assert.equal(called[0].data.callId, 'toolu_42');
  assert.equal(called[0].data.canonicalCallId, 'toolu_42');
  assert.equal(called[0].data.accounting, 'top_level');
  assert.equal(
    called[0].data.correlationFingerprint,
    toolCallCorrelationFingerprint('composio_execute_tool', LONG_SALESFORCE_TOOL_INPUT),
    'canonical correlation uses the full >500-char input before its event preview is bounded',
  );
  assert.doesNotMatch(String(called[0].data.correlationFingerprint), /private-query-fragment/);
  assert.equal(called[0].data.toolSlug, 'SALESFORCE_QUERY');
  assert.equal(called[0].data.effect, 'read');
  assert.equal(returned.length, 1);
  assert.equal(returned[0].data.callId, 'toolu_42');
  assert.equal(returned[0].data.tool, 'composio_execute_tool');
  assert.equal(returned[0].data.canonicalCallId, 'toolu_42');
  assert.equal(returned[0].data.accounting, 'top_level');
  assert.equal(returned[0].data.toolSlug, 'SALESFORCE_QUERY');
  assert.equal(returned[0].data.effect, 'read');
  assert.equal(returned[0].data.topologyRole, 'business');
  assert.equal(
    returned[0].data.successfulBusinessResult,
    true,
    'the exact SDK return boundary—not a later tool-use summary—records successful business work',
  );
  assert.match(String(returned[0].data.preview ?? ''), /Acme Corp has 3 open opportunities/);
});

test('the canonical SDK return emits authoring evidence only for a successful registry-authorized workflow creation', async () => {
  const runCase = async (input: {
    label: string;
    toolName: string;
    toolInput: unknown;
    output: string;
    isError?: boolean;
  }) => {
    const session = eventlog.createSession({ id: `sdk-authoring-evidence-${input.label}`, kind: 'chat' });
    const source = eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Create a daily digest workflow.' },
    });
    setClaudeAgentSdkQueryForTest(((_params: any) => queryFromMessages(sdkLocalToolReturnStream({
      callId: `toolu_${input.label}`,
      toolName: input.toolName,
      toolInput: input.toolInput,
      output: input.output,
      isError: input.isError,
    }), {})) as any);
    await runClaudeAgentSdk({
      prompt: 'Create a daily digest workflow.',
      sessionId: session.id,
      sourceUserSeq: source.seq,
      directOrchestrator: true,
      toolProfile: 'local_authoring',
      allowedLocalMcpTools: ['workflow_create', 'call_tool', 'pending_action_queue'],
    });
    const returned = eventlog.listEvents(session.id, { types: ['tool_returned'] });
    assert.equal(returned.length, 1);
    assert.equal(returned[0]!.data.accounting, 'top_level');
    assert.equal(returned[0]!.data.sourceUserSeq, source.seq);
    return returned[0]!;
  };

  const direct = await runCase({
    label: 'direct-workflow-create',
    toolName: 'mcp__clementine-local__workflow_create',
    toolInput: { name: 'daily_digest', description: 'Daily digest' },
    output: withLocalWriteCommitFixture(
      'workflow_create',
      'Created workflow "daily_digest".',
    ),
  });
  assert.equal(direct.data.successfulAuthoringResult, true);
  assert.equal(direct.data.successfulBusinessResult, false);

  const acquired = await runCase({
    label: 'call-tool-workflow-create',
    toolName: 'mcp__clementine-local__call_tool',
    toolInput: {
      name: 'workflow_create',
      args_json: JSON.stringify({ name: 'daily_digest', description: 'Daily digest' }),
    },
    output: withLocalWriteCommitFixture(
      'workflow_create',
      'Created workflow "daily_digest".',
    ),
  });
  assert.equal(acquired.data.effectiveTool, 'workflow_create');
  assert.equal(acquired.data.successfulAuthoringResult, true);

  const unrelated = await runCase({
    label: 'pending-action-control',
    toolName: 'mcp__clementine-local__pending_action_queue',
    toolInput: { tool: 'OUTLOOK_SEND_EMAIL' },
    output: 'Pending action queued.',
  });
  assert.equal(
    unrelated.data.successfulAuthoringResult,
    undefined,
    'a successful authoring-profile/lifecycle control is not terminal authoring evidence',
  );

  const failed = await runCase({
    label: 'unstamped-workflow-create-refusal',
    toolName: 'mcp__clementine-local__workflow_create',
    toolInput: { name: 'daily_digest', description: 'Daily digest' },
    // workflow_create historically returned validation/refusal text through an
    // ordinary isError:false MCP envelope. Registry membership alone must not
    // turn this successful-looking transport into terminal evidence.
    output: 'Workflow "daily_digest" was NOT created — fix validation first.',
  });
  assert.equal(
    failed.data.successfulAuthoringResult,
    undefined,
    'registry membership cannot turn an unstamped host refusal into evidence',
  );
});

test('Claude local settled-read replay reuses the handler-authored outer occurrence without minting authority or learning', async () => {
  const previousReflection = process.env.CLEMMY_CLAUDE_SDK_REFLECTION;
  const previousGuardrail = process.env.CLEMMY_TOOL_GUARDRAIL;
  const previousSettled = process.env.CLEMMY_SETTLED_READ_REPEAT;
  process.env.CLEMMY_CLAUDE_SDK_REFLECTION = 'on';
  process.env.CLEMMY_TOOL_GUARDRAIL = 'warn';
  process.env.CLEMMY_SETTLED_READ_REPEAT = 'on';
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read the proof queue once and summarize it.' },
  });
  const trackerScopeId = `${session.id}::brain:settled-read`;
  const sdkToolName = 'mcp__clementine-local__composio_execute_tool';
  const input = { tool_slug: 'PROOF_LIST_TASKS', arguments: '{}' };
  const providerOutput = JSON.stringify({
    successful: true,
    data: {
      sourceMarker: 'CLAUDE_SDK_SETTLED_LOCAL_ONLY',
      items: [{ id: 'proof-1', status: 'done' }],
    },
  });
  const firstModelFacing = `${providerOutput}\n\n[harness settled-read] Fresh PROOF_LIST_TASKS data for this accepted request is above. Use it for the next step or answer naturally; do not issue this exact call again unless a write changes the source or the user starts a new request.`;
  const firstCallId = 'toolu_claude_read_first';
  const replayCallId = 'toolu_claude_read_replay';
  let simulatedProviderDispatches = 0;
  const reflected: Array<{ callId: string; tool: string | null; output: string }> = [];
  setClaudeAgentSdkReflectionForTest(((record: any) => { reflected.push(record); }) as any);

  setClaudeAgentSdkQueryForTest(((params: any) => stubsFor((async function* () {
    yield initOnlyMessage();
    const canUse = params.options.canUseTool as (
      name: string,
      args: Record<string, unknown>,
      opts: { signal: AbortSignal; toolUseID: string; requestId: string },
    ) => Promise<{ behavior: string }>;

    const firstVerdict = await canUse(sdkToolName, input, {
      signal: new AbortController().signal,
      toolUseID: firstCallId,
      requestId: 'permission-first-read',
    });
    assert.equal(firstVerdict.behavior, 'allow');
    // Exercise the real stream-first race: the SDK consumer authors the outer
    // lifecycle from tool_use before the local handler enters and claims it.
    yield {
      type: 'assistant', session_id: 'sdk-settled', uuid: 'use-first', parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: firstCallId, name: sdkToolName, input }] },
    } as any;
    const firstClaim = claudeLocalCorrelation.claimClaudeLocalPermissionAdmission({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      runScopeId: trackerScopeId,
      toolName: 'composio_execute_tool',
      rawInput: input,
      directOrchestrator: true,
    });
    assert.equal(firstClaim?.providerCallId, firstCallId);
    simulatedProviderDispatches += 1;
    eventlog.writeToolOutput({
      sessionId: session.id,
      callId: firstCallId,
      tool: 'composio_execute_tool',
      output: providerOutput,
      invocationNonce: 'claude-local-inner-first-invocation',
    });
    yield {
      type: 'user', session_id: 'sdk-settled', uuid: 'result-first', parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: firstCallId, content: firstModelFacing }] },
    } as any;

    const replayVerdict = await canUse(sdkToolName, input, {
      signal: new AbortController().signal,
      toolUseID: replayCallId,
      requestId: 'permission-replay-read',
    });
    assert.equal(replayVerdict.behavior, 'allow');
    yield {
      type: 'assistant', session_id: 'sdk-settled', uuid: 'use-replay', parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: replayCallId, name: sdkToolName, input }] },
    } as any;
    const replayClaim = claudeLocalCorrelation.claimClaudeLocalPermissionAdmission({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      runScopeId: trackerScopeId,
      toolName: 'composio_execute_tool',
      rawInput: input,
      directOrchestrator: true,
    });
    assert.equal(replayClaim?.providerCallId, replayCallId);
    const replay = settledReadRepeat.resolveSettledReadRepeat({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      currentCallId: replayCallId,
      toolName: 'composio_execute_tool',
      args: input,
      currentBehaviorScopeId: trackerScopeId,
    });
    assert.ok(replay);
    eventlog.appendEvent({
      sessionId: session.id,
      turn: 0,
      role: 'system',
      type: 'guardrail_tripped',
      data: settledReadRepeat.settledReadRepeatReplayMarker({
        replayCallId,
        replayCalledEventId: replay!.currentCalledEventId,
        sourceCallId: replay!.sourceCallId,
        sourceUserSeq: source.seq,
        toolSlug: replay!.toolSlug,
        sourceBehaviorScopeId: replay!.sourceBehaviorScopeId,
        replayBehaviorScopeId: trackerScopeId,
      }),
    });
    const replayModelFacing = `${replay!.output}\n\n${settledReadRepeat.formatSettledReadRepeatAdvisory({
      toolSlug: replay!.toolSlug,
      sourceCallId: replay!.sourceCallId,
      recoveredAcrossBehaviorScope: replay!.recoveredAcrossBehaviorScope,
    })}`;
    yield {
      type: 'user', session_id: 'sdk-settled', uuid: 'result-replay', parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: replayCallId, content: replayModelFacing }] },
    } as any;
    yield successResultMessage('Summarized the proof queue.');
  })())) as any);

  const previousCapabilityCatalog = currentCapabilityFixtures.installCurrentCapabilityManifestFixtures([{
    operationId: 'PROOF_LIST_TASKS',
    providerKind: 'composio',
    effect: 'read',
  }]);
  try {
    await runClaudeAgentSdk({
      prompt: 'Read the proof queue once and summarize it.',
      sessionId: session.id,
      sourceUserSeq: source.seq,
      trackerScopeId,
      modelId: 'claude-sonnet-4-6',
      agentic: true,
      directOrchestrator: true,
      allowedLocalMcpTools: ['composio_execute_tool'],
      mcpToolAllowlist: ['composio_execute_tool'],
    });

    assert.equal(simulatedProviderDispatches, 1, 'only the first read crosses the simulated provider boundary');
    const topLevelCalled = eventlog.listEvents(session.id, { types: ['tool_called'] })
      .filter((event) => event.data.accounting === 'top_level');
    assert.deepEqual(topLevelCalled.map((event) => event.data.callId), [firstCallId, replayCallId]);
    assert.equal(
      eventlog.listEvents(session.id, { types: ['claude_local_permission_claimed'] }).length,
      2,
      'each stream-first SDK canonical is consumed once by its later local handler',
    );
    assert.ok(topLevelCalled.every((event) => event.data.tool === 'composio_execute_tool'),
      'the exact SDK hook name is namespaced, but canonical lifecycle identity is normalized to the local tool tail');
    const topLevelReturned = eventlog.listEvents(session.id, { types: ['tool_returned'] })
      .filter((event) => event.data.accounting === 'top_level');
    assert.equal(topLevelReturned.length, 2);
    assert.equal(topLevelReturned[0]?.parentEventId, topLevelCalled[0]?.id);
    assert.equal(topLevelReturned[1]?.parentEventId, topLevelCalled[1]?.id);
    assert.equal(topLevelReturned[1]?.data.providerDispatched, false);
    assert.equal(topLevelReturned[1]?.data.replayedFromCallId, firstCallId);

    const firstAuthority = eventlog.getToolOutput(session.id, firstCallId);
    assert.equal(firstAuthority?.output, providerOutput, 'first-success steering is stripped before authority parking');
    const firstInvocations = eventlog.listToolOutputInvocations(session.id, firstCallId);
    assert.equal(firstInvocations.length, 1, 'the SDK stream reuses the local bracket invocation instead of parking it twice');
    assert.equal(firstInvocations[0]?.invocationNonce, 'claude-local-inner-first-invocation');
    assert.equal(eventlog.getToolOutput(session.id, replayCallId), null, 'recovered bytes never mint replay authority');
    assert.deepEqual(reflected, [], 'neither physical nor replayed returns schedule live learning');
  } finally {
    currentCapabilityFixtures.restoreCurrentCapabilityManifestFixtures(previousCapabilityCatalog);
    if (previousReflection === undefined) delete process.env.CLEMMY_CLAUDE_SDK_REFLECTION;
    else process.env.CLEMMY_CLAUDE_SDK_REFLECTION = previousReflection;
    if (previousGuardrail === undefined) delete process.env.CLEMMY_TOOL_GUARDRAIL;
    else process.env.CLEMMY_TOOL_GUARDRAIL = previousGuardrail;
    if (previousSettled === undefined) delete process.env.CLEMMY_SETTLED_READ_REPEAT;
    else process.env.CLEMMY_SETTLED_READ_REPEAT = previousSettled;
  }
});

test('Claude reflection unwraps deferred call_tool to the real inner capability', async () => {
  setClaudeAgentSdkQueryForTest(((_params: any) => queryFromMessages([
    {
      type: 'system', subtype: 'init', model: 'claude-opus-4-8',
      session_id: 'sdk-deferred-reflect', uuid: 'u1', apiKeySource: 'none',
      claude_code_version: '2.1.181', cwd: process.cwd(), tools: [],
      mcp_servers: [], permissionMode: 'default', slash_commands: [],
      output_style: 'default', skills: [], plugins: [],
    } as any,
    {
      type: 'assistant', session_id: 'sdk-deferred-reflect', uuid: 'u2',
      parent_tool_use_id: null,
      message: { content: [{
        type: 'tool_use',
        id: 'toolu_deferred_reflect',
        name: 'mcp__clementine-local__call_tool',
        input: {
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: 'SALESFORCE_QUERY',
            arguments: { query: 'SELECT Name FROM Account' },
          }),
        },
      }] },
    } as any,
    {
      type: 'user', session_id: 'sdk-deferred-reflect', uuid: 'u3',
      parent_tool_use_id: null,
      message: { content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_deferred_reflect',
        content: 'Acme Corp is active.',
      }] },
    } as any,
    {
      type: 'result', subtype: 'success', session_id: 'sdk-deferred-reflect',
      uuid: 'u4', result: 'done', duration_ms: 1, duration_api_ms: 1,
      is_error: false, num_turns: 1, stop_reason: 'end_turn',
      total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {}, permission_denials: [],
    } as any,
  ], {})) as any);
  const reflected: Array<{ tool: string | null }> = [];
  setClaudeAgentSdkReflectionForTest(((input: any) => { reflected.push(input); }) as any);

  await runClaudeAgentSdk({
    prompt: 'Look up Acme.',
    sessionId: eventlog.createSession({ id: 'sdk-deferred-reflect-parent', kind: 'chat' }).id,
    agentic: true,
  });

  assert.equal(reflected.length, 0, 'deferred carriers also wait for terminal-batch intake');
});

test('Claude lifecycle preserves effective call_tool identity before an oversized input preview is clipped', async () => {
  const largeCarrierInput = {
    name: 'workflow_run',
    args_json: JSON.stringify({
      name: 'large-sdk-workflow',
      inputs: { brief: 'x'.repeat(9_000) },
    }),
  };
  setClaudeAgentSdkQueryForTest(((_params: any) => queryFromMessages([
    {
      type: 'system', subtype: 'init', model: 'claude-opus-4-8',
      session_id: 'sdk-large-carrier', uuid: 'large-u1', apiKeySource: 'none',
      claude_code_version: '2.1.181', cwd: process.cwd(), tools: [],
      mcp_servers: [], permissionMode: 'default', slash_commands: [],
      output_style: 'default', skills: [], plugins: [],
    } as any,
    {
      type: 'assistant', session_id: 'sdk-large-carrier', uuid: 'large-u2',
      parent_tool_use_id: null,
      message: { content: [{
        type: 'tool_use',
        id: 'toolu_large_workflow_carrier',
        name: 'mcp__clementine-local__call_tool',
        input: largeCarrierInput,
      }] },
    } as any,
    {
      type: 'user', session_id: 'sdk-large-carrier', uuid: 'large-u3',
      parent_tool_use_id: null,
      message: { content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_large_workflow_carrier',
        content: 'Queued "large-sdk-workflow" — it is now running in the BACKGROUND.',
      }] },
    } as any,
    {
      type: 'result', subtype: 'success', session_id: 'sdk-large-carrier',
      uuid: 'large-u4', result: 'Queued the workflow.', duration_ms: 1,
      duration_api_ms: 1, is_error: false, num_turns: 1,
      stop_reason: 'end_turn', total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {},
      permission_denials: [],
    } as any,
  ], {})) as any);
  setClaudeAgentSdkReflectionForTest((() => {}) as any);
  const sess = eventlog.createSession({ id: 'sdk-large-carrier-parent', kind: 'chat' });

  await runClaudeAgentSdk({
    prompt: 'Run the prepared workflow.',
    sessionId: sess.id,
    agentic: true,
    allowedLocalMcpTools: ['call_tool'],
  });

  const called = eventlog.listEvents(sess.id, { types: ['tool_called'] });
  const returned = eventlog.listEvents(sess.id, { types: ['tool_returned'] });
  assert.equal(called.length, 1);
  assert.equal(returned.length, 1);
  assert.equal(called[0].data.effectiveTool, 'workflow_run');
  assert.equal(returned[0].data.effectiveTool, 'workflow_run');
  assert.equal(String(called[0].data.arguments).length, 8_000, 'preview stays bounded');
  assert.throws(() => JSON.parse(String(called[0].data.arguments)), 'bounded preview is not reparsed');
});

test('shared SDK stream emits one canonical call for repeated tool_use frames on allow-only lanes', async () => {
  const sess = eventlog.createSession({ id: 'sdk-canonical-allow-only', kind: 'workflow' });
  const toolUse = {
    type: 'assistant', session_id: 's', uuid: 'tool-frame', parent_tool_use_id: null,
    message: { content: [{
      type: 'tool_use', id: 'toolu_dedup_1', name: 'mcp__clementine-local__composio_execute_tool',
      input: { tool_slug: 'HUBSPOT_FIND_OR_CREATE_CONTACT', arguments: '{}' },
    }] },
  } as any;
  const toolResult = {
    type: 'user', session_id: 's', uuid: 'result-frame', parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_dedup_1', content: '{"id":"contact-1"}' }] },
  } as any;
  setClaudeAgentSdkQueryForTest(((_params: any) => queryFromMessages([
    toolUse,
    toolUse,
    toolResult,
    toolResult,
    {
      type: 'result', subtype: 'success', session_id: 's', uuid: 'done', result: 'done',
      duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1,
      stop_reason: 'end_turn', total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
    } as any,
  ], {})) as any);
  setClaudeAgentSdkReflectionForTest((() => {}) as any);

  await runClaudeAgentSdk({
    prompt: 'Find or create the contact.',
    sessionId: sess.id,
    allowedLocalMcpTools: ['composio_execute_tool'],
  });

  const called = eventlog.listEvents(sess.id, { types: ['tool_called'] });
  const returned = eventlog.listEvents(sess.id, { types: ['tool_returned'] });
  assert.equal(called.length, 1);
  assert.equal(returned.length, 1);
  assert.equal(called[0].data.canonicalCallId, 'toolu_dedup_1');
  assert.equal(called[0].data.accounting, 'top_level');
  assert.equal(called[0].data.toolSlug, 'HUBSPOT_FIND_OR_CREATE_CONTACT');
  assert.equal(called[0].data.effect, 'external_write');
  assert.equal(returned[0].data.canonicalCallId, 'toolu_dedup_1');
  assert.equal(returned[0].data.accounting, 'top_level');
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
function sdkRetryThenThrowQuery(msg: string): Query {
  return stubsFor((async function* () {
    yield {
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-5',
      session_id: 's',
      uuid: 'i',
      apiKeySource: 'none',
      claude_code_version: '2.1.220',
      cwd: process.cwd(),
      tools: [],
      mcp_servers: [],
      permissionMode: 'dontAsk',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
    } as any;
    yield {
      type: 'system',
      subtype: 'api_retry',
      attempt: 3,
      max_retries: 3,
      retry_delay_ms: 8_000,
      error_status: 500,
      error: 'server_error',
      uuid: 'retry-1',
      session_id: 's',
    } satisfies SDKAPIRetryMessage;
    yield {
      type: 'assistant',
      session_id: 's',
      uuid: 'assistant-error',
      parent_tool_use_id: null,
      error: 'server_error',
      message: { content: [] },
    } as any;
    throw new Error(msg);
  })());
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

test('an SDK-exhausted API retry is observed once and never replayed by the outer legacy retry', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  let calls = 0;
  let caught: { name?: string; committed?: boolean } | null = null;
  setClaudeAgentSdkQueryForTest(((_p: any) => {
    calls += 1;
    return sdkRetryThenThrowQuery('Claude Code returned an error result: API Error: 500 Internal Server Error');
  }) as any);

  await assert.rejects(
    runClaudeAgentSdk({
      prompt: 'What is my project access code?',
      sessionId: session.id,
      modelId: 'claude-sonnet-5',
    }),
    (err: unknown) => {
      caught = err as { name?: string; committed?: boolean };
      return caught.name === 'ClaudeSdkProviderOverloadError';
    },
  );

  assert.equal(calls, 1, 'the SDK already spent its retry budget, so the outer query is not replayed');
  assert.equal(caught?.committed, false, 'the existing cross-brain fallback may safely own the replay');
  const retries = eventlog.listEvents(session.id, { types: ['sdk_api_retry'] });
  assert.equal(retries.length, 1);
  assert.deepEqual(retries[0]?.data, {
    attempt: 3,
    maxRetries: 3,
    retryDelayMs: 8_000,
    errorStatus: 500,
    error: 'server_error',
    outerAttempt: 0,
  });
  assert.equal(
    eventlog.listEvents(session.id, { types: ['sdk_first_model_activity'] }).length,
    0,
    'SDK init/retry control frames are not model activity',
  );
});

test('a legacy outer retry stops when its next physical query reports an SDK-owned retry', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  let calls = 0;
  setClaudeAgentSdkQueryForTest(((_p: any) => {
    calls += 1;
    return calls === 1
      ? throwingQuery('Claude Code returned an error result: API Error: 529 Overloaded')
      : sdkRetryThenThrowQuery('Claude Code returned an error result: API Error: 500 Internal Server Error');
  }) as any);

  await assert.rejects(
    runClaudeAgentSdk({
      prompt: 'Recover this turn.',
      sessionId: session.id,
      modelId: 'claude-sonnet-5',
    }),
    (err: unknown) => (err as { name?: string; committed?: boolean }).name === 'ClaudeSdkProviderOverloadError'
      && (err as { committed?: boolean }).committed === false,
  );

  assert.equal(calls, 2, 'one legacy retry is allowed, then the SDK-owned cycle stops outer replay');
  const retries = eventlog.listEvents(session.id, { types: ['sdk_api_retry'] });
  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.data.outerAttempt, 1);
});

test('first model activity is measured separately from SDK process initialization', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  setClaudeAgentSdkQueryForTest(((_p: any) => successQuery('recalled')) as any);

  await runClaudeAgentSdk({
    prompt: 'What is my project access code?',
    sessionId: session.id,
    modelId: 'claude-sonnet-5',
  });

  const initialized = eventlog.listEvents(session.id, { types: ['sdk_first_byte'] });
  const activity = eventlog.listEvents(session.id, { types: ['sdk_first_model_activity'] });
  assert.equal(initialized.length, 1);
  assert.equal(activity.length, 1);
  assert.equal(activity[0]?.data.kind, 'result');
  assert.equal(typeof activity[0]?.data.firstModelActivityMs, 'number');
});

test('internal query retries rotate subordinate leases before close/backoff and preserve the parent', async () => {
  const priorInProcess = process.env.CLEMMY_CLAUDE_SDK_INPROCESS_MCP;
  process.env.CLEMMY_CLAUDE_SDK_INPROCESS_MCP = 'off';
  const session = eventlog.createSession({ kind: 'chat' });
  const runAttempt = eventlog.beginRunAttempt(session.id, { runId: 'sdk-query-child-retry' });
  const parent = dispatchLease.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::outer-sdk`,
    runAttemptId: runAttempt.attemptId,
  });
  const queryLeases: dispatchLease.DispatchLeaseRef[] = [];
  const currentInsideClose: boolean[] = [];
  let calls = 0;
  setClaudeAgentSdkQueryForTest(((params: any) => {
    calls += 1;
    const local = params.options.mcpServers['clementine-local'];
    const child = dispatchLease.parseDispatchLease(
      local?.env?.CLEMENTINE_MCP_DISPATCH_LEASE_JSON,
    ) as dispatchLease.DispatchLeaseRef;
    queryLeases.push(child);
    const generator = calls === 1
      ? (async function* () {
          throw new Error('Claude Code returned an error result: API Error: 529 Overloaded');
        })()
      : (async function* () {
          yield initOnlyMessage();
          yield successResultMessage('recovered under child generation two');
        })();
    return Object.assign(generator, {
      close() {
        currentInsideClose.push(dispatchLease.isDispatchLeaseCurrent(child));
      },
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
      streamInput: async () => {},
      stopTask: async () => false,
      backgroundTasks: async () => false,
    }) as Query;
  }) as any);

  try {
    const result = await runClaudeAgentSdk({
      prompt: 'recover once',
      sessionId: session.id,
      modelId: 'claude-sonnet-4-6',
      dispatchLease: parent,
    });
    assert.equal(result.text, 'recovered under child generation two');
    assert.equal(calls, 2);
    assert.equal(new Set(queryLeases.map((lease) => lease.leaseId)).size, 2);
    assert.ok(queryLeases.every(
      (lease) =>
        lease.parentScopeId === parent.scopeId
        && lease.parentLeaseId === parent.leaseId,
    ));
    assert.deepEqual(
      currentInsideClose,
      [false, false],
      'each generation is stale inside close(), including before internal retry backoff',
    );
    assert.equal(
      dispatchLease.isDispatchLeaseCurrent(parent),
      true,
      'a healthy SDK worker/query return never revokes borrowed parent authority',
    );
  } finally {
    dispatchLease.revokeDispatchLease(parent);
    eventlog.finishRunAttempt(runAttempt, 'completed');
    if (priorInProcess === undefined) delete process.env.CLEMMY_CLAUDE_SDK_INPROCESS_MCP;
    else process.env.CLEMMY_CLAUDE_SDK_INPROCESS_MCP = priorInProcess;
  }
});

test('wall-clock interrupt observes its query child already stale', async () => {
  const priorInProcess = process.env.CLEMMY_CLAUDE_SDK_INPROCESS_MCP;
  process.env.CLEMMY_CLAUDE_SDK_INPROCESS_MCP = 'off';
  const session = eventlog.createSession({ kind: 'chat' });
  const runAttempt = eventlog.beginRunAttempt(session.id, { runId: 'sdk-query-child-interrupt' });
  const parent = dispatchLease.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::outer-sdk`,
    runAttemptId: runAttempt.attemptId,
  });
  let currentInsideInterrupt: boolean | undefined;
  let currentInsideClose: boolean | undefined;
  setClaudeAgentSdkQueryForTest(((params: any) => {
    const local = params.options.mcpServers['clementine-local'];
    const child = dispatchLease.parseDispatchLease(
      local?.env?.CLEMENTINE_MCP_DISPATCH_LEASE_JSON,
    ) as dispatchLease.DispatchLeaseRef;
    let yieldedInit = false;
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (!yieldedInit) {
          yieldedInit = true;
          return { done: false, value: initOnlyMessage() };
        }
        return new Promise<IteratorResult<SDKMessage>>(() => {});
      },
      async interrupt() {
        currentInsideInterrupt = dispatchLease.isDispatchLeaseCurrent(child);
      },
      close() {
        currentInsideClose = dispatchLease.isDispatchLeaseCurrent(child);
      },
      setPermissionMode: async () => {},
      setModel: async () => {},
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
      streamInput: async () => {},
      stopTask: async () => false,
      backgroundTasks: async () => false,
    } as unknown as Query;
  }) as any);

  try {
    const result = await runClaudeAgentSdk({
      prompt: 'stop at wall clock',
      sessionId: session.id,
      modelId: 'claude-sonnet-4-6',
      dispatchLease: parent,
      maxWallClockMs: 25,
      livenessHeartbeatMs: 5,
    });
    assert.equal(result.limitHit, true);
    assert.equal(currentInsideInterrupt, false);
    assert.equal(currentInsideClose, false);
    assert.equal(dispatchLease.isDispatchLeaseCurrent(parent), true);
  } finally {
    dispatchLease.revokeDispatchLease(parent);
    eventlog.finishRunAttempt(runAttempt, 'completed');
    if (priorInProcess === undefined) delete process.env.CLEMMY_CLAUDE_SDK_INPROCESS_MCP;
    else process.env.CLEMMY_CLAUDE_SDK_INPROCESS_MCP = priorInProcess;
  }
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

test('an EXPIRED Claude token throws a TYPED, auth-recoverable error (so a caller can switch brains)', async () => {
  // Regression (2026-07-20): an expired claude_oauth token surfaced as a GENERIC
  // Error, which no fallover branch acted on — the turn/step hard-failed even with
  // other brains connected. It must now be a typed ClaudeSdkAuthExpiredError that
  // the shared isAuthRecoverableError classifies, and NOT be pointlessly retried
  // (re-running the same dead token can't succeed).
  let calls = 0;
  setClaudeAgentSdkQueryForTest(((_p: any) => {
    calls++;
    return throwingQuery('Claude Code returned an error result: API Error: 401 Unauthorized — OAuth token has expired. Please re-authenticate.');
  }) as any);
  await assert.rejects(
    runClaudeAgentSdk({ prompt: 'hi', modelId: 'claude-sonnet-4-6' }),
    (err: unknown) => {
      assert.ok(err instanceof ClaudeSdkAuthExpiredError, 'typed as ClaudeSdkAuthExpiredError');
      assert.equal((err as ClaudeSdkAuthExpiredError).committed, false, 'nothing committed → safe to re-dispatch on another brain');
      assert.ok(isAuthRecoverableError(err), 'the shared classifier recognizes it as auth-recoverable');
      return true;
    },
  );
  assert.equal(calls, 1, 'a dead token is not retried in-lane');
});

test('model-scoped extra-usage exhaustion is typed and never retried in-lane', async () => {
  let calls = 0;
  setClaudeAgentSdkQueryForTest(((_p: any) => {
    calls++;
    return throwingQuery("Claude Code returned an error result: You're out of extra usage. Add more at claude.ai/settings/usage and keep going.");
  }) as any);
  await assert.rejects(
    runClaudeAgentSdk({ prompt: 'hi', modelId: 'claude-sonnet-5' }),
    (err: unknown) => {
      assert.ok(err instanceof ClaudeSdkCapacityExhaustedError);
      assert.equal((err as InstanceType<typeof ClaudeSdkCapacityExhaustedError>).committed, false);
      return true;
    },
  );
  assert.equal(calls, 1, 'an exhausted model is not retried before cross-brain fallover');
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

test('dispatch_background_task is terminal in the SDK lane', async () => {
  let interrupted = false;
  setClaudeAgentSdkQueryForTest(((_p: any) => {
    const q = stubsFor((async function* () {
      yield initOnlyMessage();
      yield {
        type: 'assistant',
        session_id: 's',
        uuid: 'a',
        parent_tool_use_id: null,
        message: {
          content: [{
            type: 'tool_use',
            id: 'toolu_bg',
            name: 'mcp__clementine-local__dispatch_background_task',
            input: { objective: 'Count markdown files' },
          }],
        },
      } as any;
      yield {
        type: 'user',
        session_id: 's',
        uuid: 'u',
        parent_tool_use_id: null,
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_bg',
            content: 'Dispatched "Count markdown files" to the background (task bg-test) with a goal contract.',
          }],
        },
      } as any;
      yield successResultMessage('wrong foreground answer');
    })());
    return Object.assign(q, { interrupt: async () => { interrupted = true; } });
  }) as any);

  const r = await runClaudeAgentSdk({
    prompt: 'please background this',
    sessionId: 'sdk-dispatch-terminal',
    modelId: 'claude-sonnet-4-6',
    allowedLocalMcpTools: ['dispatch_background_task'],
  });

  assert.equal(interrupted, true);
  assert.equal(r.limitHit, false);
  assert.deepEqual(r.toolUses, ['mcp__clementine-local__dispatch_background_task']);
  assert.match(r.text, /Started "Count markdown files" in the background \(bg-test\)/);
  assert.doesNotMatch(r.text, /wrong foreground answer/);
});

test('ask_user_question is terminal in the SDK lane — the question surfaces inline, run stops', async () => {
  let interrupted = false;
  setClaudeAgentSdkQueryForTest(((_p: any) => {
    const q = stubsFor((async function* () {
      yield initOnlyMessage();
      yield {
        type: 'assistant', session_id: 's', uuid: 'a', parent_tool_use_id: null,
        message: { content: [{
          type: 'tool_use', id: 'toolu_ask',
          name: 'mcp__clementine-local__ask_user_question',
          input: { agentSlug: 'clementine', question: 'New topic, or resume the Salesforce work? And Airtable or the Google Sheet for the 5 firms?' },
        }] },
      } as any;
      yield {
        type: 'user', session_id: 's', uuid: 'u', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'Check-in created: ci-123. The user has been notified.' }] },
      } as any;
      yield successResultMessage('should not run the task before the answer');
    })());
    return Object.assign(q, { interrupt: async () => { interrupted = true; } });
  }) as any);

  const r = await runClaudeAgentSdk({
    prompt: 'scrape 5 firms',
    sessionId: 'sdk-ask-terminal',
    modelId: 'claude-sonnet-5',
    allowedLocalMcpTools: ['ask_user_question'],
  });

  assert.equal(interrupted, true, 'the run stopped on the question');
  assert.equal(r.limitHit, false);
  assert.equal(r.stoppedReason, 'awaiting-input');
  // The QUESTION (from the tool input) is the reply — not the check-in receipt, not the
  // premature task answer.
  assert.match(r.text, /New topic, or resume the Salesforce work\?/);
  assert.doesNotMatch(r.text, /Check-in created/);
  assert.doesNotMatch(r.text, /should not run the task/);
});

test('parallel ask_user_question results become one natural bundled question without dropping returns or usage', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const firstQuestion = 'Which environment should I use: staging or production?';
  const secondQuestion = 'Should the report go to Slack or stay in the project folder?';
  let interruptCalls = 0;
  setClaudeAgentSdkQueryForTest(((_p: any) => {
    const query = stubsFor((async function* () {
      yield { ...initOnlyMessage(), model: 'claude-sonnet-5' } as any;
      yield {
        type: 'assistant',
        session_id: 'sdk-parallel-asks-provider-session',
        uuid: 'assistant-parallel-asks',
        parent_tool_use_id: null,
        message: {
          id: 'msg-parallel-asks',
          model: 'claude-sonnet-5',
          role: 'assistant',
          stop_reason: 'tool_use',
          stop_sequence: null,
          content: [
            {
              type: 'tool_use',
              id: 'toolu_ask_environment',
              name: 'mcp__clementine-local__ask_user_question',
              input: { question: firstQuestion },
            },
            {
              type: 'tool_use',
              id: 'toolu_ask_destination',
              name: 'mcp__clementine-local__ask_user_question',
              input: { question: secondQuestion },
            },
          ],
          usage: {
            input_tokens: 12,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 6,
          },
        },
      } as any;
      yield {
        type: 'user',
        session_id: 'sdk-parallel-asks-provider-session',
        uuid: 'user-parallel-asks',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_ask_destination',
              content: 'Check-in created: ci-destination. The user has been notified.',
            },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_ask_environment',
              content: 'Check-in created: ci-environment. The user has been notified.',
            },
          ],
        },
      } as any;
      yield successResultMessage('must not continue after the questions');
    })());
    return Object.assign(query, {
      interrupt: async () => { interruptCalls += 1; },
    });
  }) as any);

  const result = await runClaudeAgentSdk({
    prompt: 'Prepare the release report once the two blocking details are known.',
    sessionId: session.id,
    modelId: 'claude-sonnet-5',
    allowedLocalMcpTools: ['ask_user_question'],
  });

  assert.equal(interruptCalls, 1, 'the completed result frame interrupts exactly once');
  assert.equal(result.stoppedReason, 'awaiting-input');
  assert.equal(
    result.text,
    `Before I continue, could you answer these together?\n\n1. ${firstQuestion}\n2. ${secondQuestion}`,
  );
  assert.deepEqual(result.toolUses, [
    'mcp__clementine-local__ask_user_question',
    'mcp__clementine-local__ask_user_question',
  ]);
  assert.deepEqual(result.successfulToolUses, ['ask_user_question', 'ask_user_question']);
  assert.doesNotMatch(result.text, /Check-in created|must not continue/);

  assert.equal(eventlog.listEvents(session.id, { types: ['tool_called'] }).length, 2);
  assert.equal(eventlog.listEvents(session.id, { types: ['tool_returned'] }).length, 2);
  const usage = usageLog.readUsageEventsForDate().filter((event) => event.source === session.id);
  assert.equal(usage.length, 1, 'one assistant frame produces one terminal usage row');
  assert.equal(usage[0]?.inputTokens, 17);
  assert.equal(usage[0]?.cachedInputTokens, 3);
  assert.equal(usage[0]?.outputTokens, 6);
  assert.equal(usage[0]?.totalTokens, 23);
  assert.equal(usage[0]?.responseId, 'assistant-parallel-asks');
});

test('parallel ask_user_question never reports a question whose tool result failed', async () => {
  const postedQuestion = 'Which environment should I use?';
  const failedQuestion = 'Which destination should receive the report?';
  let interrupted = false;
  setClaudeAgentSdkQueryForTest(((_p: any) => {
    const query = stubsFor((async function* () {
      yield initOnlyMessage();
      yield {
        type: 'assistant', session_id: 's', uuid: 'parallel-ask-failure-use', parent_tool_use_id: null,
        message: { content: [
          {
            type: 'tool_use', id: 'toolu_ask_posted',
            name: 'mcp__clementine-local__ask_user_question', input: { question: postedQuestion },
          },
          {
            type: 'tool_use', id: 'toolu_ask_failed',
            name: 'mcp__clementine-local__ask_user_question', input: { question: failedQuestion },
          },
        ] },
      } as any;
      yield {
        type: 'user', session_id: 's', uuid: 'parallel-ask-failure-results', parent_tool_use_id: null,
        message: { content: [
          {
            type: 'tool_result', tool_use_id: 'toolu_ask_posted',
            content: 'Check-in created: ci-posted. The user has been notified.',
          },
          {
            // The local MCP tool reports a rejected question as an ordinary
            // text result, so truth cannot rely on the SDK envelope's is_error
            // bit alone.
            type: 'tool_result', tool_use_id: 'toolu_ask_failed',
            content: 'Question rejected: ask one concrete question tied to the task.',
          },
        ] },
      } as any;
      yield successResultMessage('must not continue after the posted question');
    })());
    return Object.assign(query, { interrupt: async () => { interrupted = true; } });
  }) as any);

  const result = await runClaudeAgentSdk({
    prompt: 'Ask for the blocking details.',
    sessionId: 'sdk-parallel-ask-failure',
    modelId: 'claude-sonnet-5',
    allowedLocalMcpTools: ['ask_user_question'],
  });

  assert.equal(interrupted, true);
  assert.equal(result.stoppedReason, 'awaiting-input');
  assert.equal(result.text, postedQuestion, 'one durable ask preserves the exact single-question behavior');
  assert.doesNotMatch(result.text, new RegExp(failedQuestion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(result.successfulToolUses, ['ask_user_question']);
});

test('result-less terminal tool records assistant-frame usage with exact turn attribution', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const runAttempt = eventlog.beginRunAttempt(session.id, { runId: 'sdk-terminal-usage' });
  const source = eventlog.recordRunAttemptUserInput(runAttempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Ask the exact blocking question.' },
  });
  const parentLease = dispatchLease.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::terminal-usage`,
    runAttemptId: runAttempt.attemptId,
  });
  let interrupted = false;
  setClaudeAgentSdkQueryForTest(((_p: any) => {
    const query = stubsFor((async function* () {
      yield { ...initOnlyMessage(), model: 'claude-sonnet-5' } as any;
      yield {
        type: 'assistant',
        session_id: 'sdk-terminal-usage-provider-session',
        uuid: 'assistant-terminal-usage',
        parent_tool_use_id: null,
        message: {
          id: 'msg-terminal-usage',
          model: 'claude-sonnet-5',
          role: 'assistant',
          stop_reason: 'tool_use',
          stop_sequence: null,
          content: [{
            type: 'tool_use',
            id: 'toolu_ask_usage',
            name: 'mcp__clementine-local__ask_user_question',
            input: { question: 'Please reconnect Railway, then reply continue.' },
          }],
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 7,
            output_tokens: 5,
          },
        },
      } as any;
      yield {
        type: 'user',
        session_id: 'sdk-terminal-usage-provider-session',
        uuid: 'user-terminal-usage',
        parent_tool_use_id: null,
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_ask_usage',
            content: 'Check-in created: ci-terminal-usage. The user has been notified.',
          }],
        },
      } as any;
      // The terminal-tool boundary interrupts before this aggregate result can
      // be observed, matching the live blocked-auth run.
      yield successResultMessage('must not continue after the question');
    })());
    return Object.assign(query, {
      interrupt: async () => { interrupted = true; },
    });
  }) as any);

  try {
    const result = await runClaudeAgentSdk({
      prompt: 'Ask the exact blocking question.',
      sessionId: session.id,
      sourceUserSeq: source.seq,
      modelId: 'claude-sonnet-5',
      allowedLocalMcpTools: ['ask_user_question'],
      dispatchLease: parentLease,
    });

    assert.equal(interrupted, true);
    assert.equal(result.stoppedReason, 'awaiting-input');
    const usage = usageLog.readUsageEventsForDate().filter((event) => event.source === session.id);
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.model, 'claude-sonnet-5');
    assert.equal(usage[0]?.inputTokens, 20);
    assert.equal(usage[0]?.cachedInputTokens, 7);
    assert.equal(usage[0]?.cacheCreationInputTokens, 3);
    assert.equal(usage[0]?.outputTokens, 5);
    assert.equal(usage[0]?.totalTokens, 25);
    assert.equal(usage[0]?.responseId, 'assistant-terminal-usage');
    assert.equal(usage[0]?.durationMs, undefined, 'missing provider duration is not fabricated as zero latency');
    assert.equal(usage[0]?.trace?.acceptedSource, `${session.id}:${source.seq}`);
    assert.equal(usage[0]?.trace?.logicalTurnId, `turn:${source.seq}`);
    assert.equal(usage[0]?.trace?.attemptId, runAttempt.attemptId);
    assert.equal(usage[0]?.trace?.modelCallId, 'assistant-terminal-usage');
    assert.equal(usage[0]?.trace?.lane, 'unattributed');

    const cache = eventlog.listEvents(session.id, { types: ['sdk_cache'] });
    assert.equal(cache.length, 1);
    assert.equal(cache[0]?.data.inputTokens, 20);
    assert.equal(cache[0]?.data.cachedInputTokens, 7);
    assert.equal(cache[0]?.data.cacheHitRatio, 0.35);
    assert.equal(cache[0]?.data.sourceUserSeq, source.seq);
    assert.equal(cache[0]?.data.attemptId, runAttempt.attemptId);
    const composition = eventlog.listEvents(session.id, { types: ['prompt_composition'] });
    assert.equal(composition.length, 1);
    assert.equal(composition[0]?.data.sourceUserSeq, source.seq);
    const lifecycle = eventlog.listEvents(session.id, { types: ['tool_called', 'tool_returned'] });
    assert.equal(lifecycle.length, 2);
    assert.ok(lifecycle.every((event) => event.data.attemptId === runAttempt.attemptId));
  } finally {
    dispatchLease.revokeDispatchLease(parentLease);
    eventlog.finishRunAttempt(runAttempt, 'completed');
  }
});

test('ask_user_question approval auto-resolve is non-terminal in the SDK lane', async () => {
  let interrupted = false;
  setClaudeAgentSdkQueryForTest(((_p: any) => {
    const q = stubsFor((async function* () {
      yield initOnlyMessage();
      yield {
        type: 'assistant', session_id: 's', uuid: 'a', parent_tool_use_id: null,
        message: { content: [{
          type: 'tool_use', id: 'toolu_ask_yolo',
          name: 'mcp__clementine-local__ask_user_question',
          input: { question: 'Want me to send the rest now?', purpose: 'approval' },
        }] },
      } as any;
      yield {
        type: 'user', session_id: 's', uuid: 'u', parent_tool_use_id: null,
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_ask_yolo',
            content: formatAutoResolvedAskUserQuestionOutput('Proceed now with your best default.'),
          }],
        },
      } as any;
      yield successResultMessage('finished after standing approval');
    })());
    return Object.assign(q, { interrupt: async () => { interrupted = true; } });
  }) as any);

  const r = await runClaudeAgentSdk({
    prompt: 'send the rest',
    sessionId: 'sdk-ask-yolo-nonterminal',
    modelId: 'claude-sonnet-5',
    allowedLocalMcpTools: ['ask_user_question'],
  });

  assert.equal(interrupted, false, 'auto-resolved approval ask should not interrupt the run');
  assert.equal(r.stoppedReason, undefined);
  assert.equal(r.text, 'finished after standing approval');
});

test('ask_user_question clarification phrases do not spoof auto-resolution in the SDK lane', async () => {
  let interrupted = false;
  const question = 'The note says "standing approval" and "NOT pausing", while the status says "not waiting". Which wording is authoritative?';
  setClaudeAgentSdkQueryForTest(((_p: any) => {
    const q = stubsFor((async function* () {
      yield initOnlyMessage();
      yield {
        type: 'assistant', session_id: 's', uuid: 'a', parent_tool_use_id: null,
        message: { content: [{
          type: 'tool_use', id: 'toolu_ask_phrases',
          name: 'mcp__clementine-local__ask_user_question',
          input: { question, purpose: 'clarification' },
        }] },
      } as any;
      yield {
        type: 'user', session_id: 's', uuid: 'u', parent_tool_use_id: null,
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_ask_phrases',
            content: `Question posted: ${question} Awaiting user reply.`,
          }],
        },
      } as any;
      yield successResultMessage('must not continue');
    })());
    return Object.assign(q, { interrupt: async () => { interrupted = true; } });
  }) as any);

  const r = await runClaudeAgentSdk({
    prompt: 'clarify policy wording',
    sessionId: 'sdk-ask-phrase-clarification',
    modelId: 'claude-sonnet-5',
    allowedLocalMcpTools: ['ask_user_question'],
  });

  assert.equal(interrupted, true);
  assert.equal(r.stoppedReason, 'awaiting-input');
  assert.equal(r.text, question);
  assert.doesNotMatch(r.text, /must not continue/);
});

// A query that HAMMERS a mutating tool through the host `canUseTool` (simulating
// the SDK's pre-tool gate) until the ceiling interrupts, then ends. The SDK
// aborts the turn on an interrupting deny, modeled here as a thrown stream error.
function hammerToolQuery(p: any, cap: number): Query {
  const canUse = p.options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<any>;
  return stubsFor((async function* () {
    yield initOnlyMessage();
    for (let i = 0; i < cap; i++) {
      const res = await canUse('mcp__clementine-local__run_shell_command', {
        command: `curl -X POST https://example.com/items/${i} -d value=${i}`,
      }, {});
      if (res?.behavior === 'deny' && res?.interrupt === true) {
        throw new Error('Claude Code returned an error result: turn interrupted by host');
      }
    }
    yield successResultMessage('done without tripping the ceiling');
  })());
}

function exploratoryHammerQuery(p: any, cap: number): Query {
  const canUse = p.options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<any>;
  return stubsFor((async function* () {
    yield initOnlyMessage();
    for (let i = 0; i < cap; i += 1) {
      const res = await canUse(
        'mcp__clementine-local__read_file',
        { path: `/tmp/source-${i}.md` },
        { signal: new AbortController().signal, toolUseID: `toolu_economy_${i}` },
      );
      if (res?.behavior === 'deny' && res?.interrupt === true) {
        throw new Error('Claude Code returned an error result: turn interrupted by host');
      }
    }
    yield successResultMessage('kept exploring');
  })());
}

test('tool-economy replays a denied provider callback as deny without duplicate accounting', async () => {
  eventlog.createSession({ id: 'sdk-tool-economy-deny-replay', kind: 'chat' });
  const state = toolEconomy.createToolEconomyState({
    kind: 'single_deliverable', softLimit: 1, hardLimit: 8,
  });
  const verdicts: Array<{ behavior?: string; interrupt?: boolean }> = [];
  setClaudeAgentSdkQueryForTest(((p: any) => {
    const canUse = p.options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<any>;
    return stubsFor((async function* () {
      yield initOnlyMessage();
      verdicts.push(await canUse(
        'mcp__clementine-local__read_file',
        { path: '/tmp/allowed.md' },
        { signal: new AbortController().signal, toolUseID: 'toolu_allowed_once' },
      ));
      const deniedArgs = { path: '/tmp/denied.md' };
      for (let replay = 0; replay < 2; replay += 1) {
        verdicts.push(await canUse(
          'mcp__clementine-local__read_file',
          deniedArgs,
          { signal: new AbortController().signal, toolUseID: 'toolu_denied_replayed' },
        ));
      }
      yield successResultMessage('finished from existing evidence');
    })());
  }) as any);

  await runClaudeAgentSdk({
    prompt: 'create one document',
    sessionId: 'sdk-tool-economy-deny-replay',
    modelId: 'claude-sonnet-4-6',
    allowedLocalMcpTools: ['read_file'],
    toolEconomyState: state,
  });

  assert.deepEqual(verdicts.map((verdict) => verdict.behavior), ['allow', 'deny', 'deny']);
  assert.deepEqual(verdicts.map((verdict) => verdict.interrupt), [undefined, false, false]);
  assert.equal(state.attempts, 2);
  assert.equal(state.softRefusals, 1);
  const trips = eventlog.listEvents('sdk-tool-economy-deny-replay', { types: ['guardrail_tripped'] });
  assert.equal(
    trips.filter((event) => event.data.kind === 'tool_economy_finish_phase').length,
    1,
    'the replay is enforced but does not create a second canonical guardrail row',
  );
});

test('logical-run economy enters finish phase and interrupts repeated exploration', async () => {
  eventlog.createSession({ id: 'sdk-tool-economy', kind: 'chat' });
  const state = toolEconomy.createToolEconomyState({
    kind: 'single_deliverable', softLimit: 2, hardLimit: 8,
  });
  setClaudeAgentSdkQueryForTest(((p: any) => exploratoryHammerQuery(p, 40)) as any);
  const result = await runClaudeAgentSdk({
    prompt: 'create one document',
    sessionId: 'sdk-tool-economy',
    modelId: 'claude-sonnet-4-6',
    allowedLocalMcpTools: ['read_file'],
    toolEconomyState: state,
  });
  assert.equal(result.limitHit, true);
  assert.equal(result.selfStopped, true, 'finish-phase refusal is terminal, never auto-continued');
  assert.equal(state.allowed, 2);
  assert.equal(state.attempts, 5, 'three ignored finish steers end the run');
  // The user-visible reply is first-person and actionable — the internal
  // finish-phase steer directive must never leak into the chat (2026-07-21).
  assert.match(result.text, /stopped myself/i);
  // NEVER-RESTING: the copy states the evidence is checkpointed for the next
  // pass; it never asks the user to type `continue`.
  assert.match(result.text, /checkpointed/i);
  assert.doesNotMatch(result.text, /say\s+["“`]?continue/i);
  assert.doesNotMatch(result.text, /finish-phase steer/i);
  const trips = eventlog.listEvents('sdk-tool-economy', { types: ['guardrail_tripped'] });
  assert.equal(trips.filter((event) => String(event.data.kind).startsWith('tool_economy_')).length, 3);
});

test('Phase 2: a mutating thrash trips the SDK tool-call ceiling and stops the turn (interrupt)', async () => {
  const prev = process.env.CLEMMY_SDK_MUTATING_CALL_CEILING;
  process.env.CLEMMY_SDK_MUTATING_CALL_CEILING = '3';
  try {
    setClaudeAgentSdkQueryForTest(((p: any) => hammerToolQuery(p, 50)) as any);
    const r = await runClaudeAgentSdk({
      prompt: 'do a thing',
      sessionId: 'sdk-ceiling-trip',
      modelId: 'claude-sonnet-4-6',
      // Concrete network POST behavior counts as mutating regardless of allowlist.
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
    prompt: 'pull my priority accounts',
    sessionId: 'sdk-turn-context',
    modelId: 'claude-sonnet-4-6',
    systemAppend: 'STABLE-SYSTEM-IDENTITY-AND-FACTS',
    turnContext: '# Current State (refreshed this turn)\n\n## Now\nMonday',
    priorTurns: [{ who: 'user', text: 'hi' }, { who: 'assistant', text: 'hello' }],
  });

  // Volatile context is in the user turn, clearly framed and BELOW the prior turns.
  assert.match(capture.call.prompt, /\[CURRENT STATE — refreshed THIS turn/);
  assert.match(capture.call.prompt, /## Now\nMonday/);
  assert.match(capture.call.prompt, /\[Latest message\]\npull my priority accounts/);
  assert.ok(capture.call.prompt.indexOf('CONVERSATION SO FAR') < capture.call.prompt.indexOf('CURRENT STATE'));
  // The stable system append is untouched — it must NOT carry the volatile tail
  // (that's the whole point: a stable prefix the API can cache across turns).
  assert.equal(capture.call.options.systemPrompt.append, 'STABLE-SYSTEM-IDENTITY-AND-FACTS');
  assert.doesNotMatch(capture.call.options.systemPrompt.append, /Current State|## Now/);
});

test('Phase 2 fix: the wall clock EXCLUDES human approval-wait — a slow confirm-first approval does NOT self-abort the turn', async (t) => {
  const prevPoll = process.env.CLEMMY_APPROVAL_POLL_MS;
  process.env.CLEMMY_APPROVAL_POLL_MS = '10'; // fast poll so the test resolves quickly
  const approvalRegistry = await import('./approval-registry.js');
  const { createSession, getSession } = await import('./eventlog.js');
  const sid = 'sdk-approval-wallclock';
  let logicalNow = Date.now();
  t.mock.method(Date, 'now', () => logicalNow);
  try {
    if (!getSession(sid)) createSession({ id: sid, kind: 'chat', title: 'approval wallclock' });
    setClaudeAgentSdkQueryForTest(((p: any) => {
      const canUse = p.options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<any>;
      return stubsFor((async function* () {
        yield initOnlyMessage();
        // A behaviorally mutating shell command registers an approval and
        // AWAITS a human. Advance logical time well past the active-work wall
        // clock immediately before resolving. Scheduler contention remains real,
        // but cannot consume the assertion's logical budget.
        const callP = canUse('mcp__clementine-local__run_shell_command', { command: 'git push origin main' }, { signal: new AbortController().signal });
        setTimeout(() => {
          logicalNow += 1_200;
          for (const row of approvalRegistry.listPending({ sessionId: sid })) {
            approvalRegistry.resolve(row.approvalId, 'approved', 'test');
          }
        }, 25);
        await callP;
        yield successResultMessage('finished after the slow approval');
      })());
    }) as any);

    const r = await runClaudeAgentSdk({
      prompt: 'do the gated thing',
      sessionId: sid,
      modelId: 'claude-sonnet-4-6',
      agentic: true,
      // Logical approval time exceeds this budget. A regression that counts the
      // paused interval still fails without relying on wall-clock scheduling.
      maxWallClockMs: 500,
      // Force the silent-iterator ticker to inspect the wall clock repeatedly
      // while canUseTool is still waiting. The regression used to pass only
      // because the default 60s heartbeat never observed the live wait.
      livenessHeartbeatMs: 5,
      allowedLocalMcpTools: ['read_file', 'memory_search'],
    });

    // WITHOUT the pausedMs exclusion this would limitHit (1.2s > 500ms). WITH it,
    // logical wall - pausedMs remains below 500ms and the turn completes.
    assert.notEqual(r.limitHit, true, 'a long approval wait must not trip the wall clock');
    assert.match(r.text, /finished after the slow approval/);
  } finally {
    if (prevPoll === undefined) delete process.env.CLEMMY_APPROVAL_POLL_MS; else process.env.CLEMMY_APPROVAL_POLL_MS = prevPoll;
  }
});

test('workflow approval park mode interrupts query() and closes the SDK turn instead of holding it', async () => {
  const approvalRegistry = await import('./approval-registry.js');
  const { createSession, getSession } = await import('./eventlog.js');
  const sid = 'sdk-workflow-approval-park';
  if (!getSession(sid)) createSession({ id: sid, kind: 'workflow', title: 'SDK workflow approval park' });
  let permissionResult: { behavior?: string; interrupt?: boolean } | undefined;
  setClaudeAgentSdkQueryForTest(((p: any) => {
    const canUse = p.options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<any>;
    return stubsFor((async function* () {
      yield initOnlyMessage();
      permissionResult = await canUse(
        'mcp__clementine-local__run_shell_command',
        { command: 'git push origin main' },
        { signal: new AbortController().signal, toolUseID: 'toolu_park_exact' },
      );
      // A real SDK honors interrupt:true and ends here. Ending the fake stream
      // without a result proves runClaudeAgentSdk uses the typed boundary rather
      // than misreporting "finished without a result".
    })());
  }) as any);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = runClaudeAgentSdk({
      prompt: 'perform the exact gated send',
      sessionId: sid,
      modelId: 'claude-sonnet-4-6',
      agentic: true,
      approvalMode: 'park',
      allowedLocalMcpTools: ['read_file', 'memory_search'],
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('SDK workflow approval park did not release query() promptly')), 1000);
    });
    await assert.rejects(
      Promise.race([run, deadline]),
      (err: unknown) => {
        assert.ok(err instanceof ClaudeAgentSdkApprovalBoundaryError);
        assert.equal(err.boundary.state, 'pending');
        assert.equal(err.boundary.sessionId, sid);
        return true;
      },
    );
    assert.deepEqual(permissionResult, {
      behavior: 'deny',
      message: approvalRegistry.listPending({ sessionId: sid })[0]
        ? `Approval ${approvalRegistry.listPending({ sessionId: sid })[0].approvalId} is pending; the workflow run has been parked.`
        : undefined,
      interrupt: true,
    });
    assert.equal(approvalRegistry.listPending({ sessionId: sid }).length, 1);
  } finally {
    if (timer) clearTimeout(timer);
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

test('silent SDK waits emit rate-limited visible heartbeats before the wall-clock stop', async () => {
  const sid = 'sdk-silent-heartbeat';
  eventlog.createSession({ id: sid, kind: 'chat' });
  let closed = 0;
  setClaudeAgentSdkQueryForTest(((_p: any) => hangingQuery(() => { closed += 1; })) as any);
  const r = await runClaudeAgentSdk({
    prompt: 'wait on a long provider operation',
    sessionId: sid,
    modelId: 'claude-sonnet-4-6',
    // DETERMINISTIC MARGINS (sweep-flake fix 2026-07-23): the wall-clock
    // starts BEFORE the SDK setup work, so setup time (variable under load)
    // eats the window before the tick loop even starts — the original
    // 24ms/6ms was a coin flip (failed 8/9 solo). The tick emits before it
    // checks the wall-clock stop, so even a first timer delayed past 1000ms
    // guarantees one visible heartbeat. The ≤11 bound is the rate limit
    // (wallClock/cadence + 1) — a mis-rate-limited loop would blow past it.
    maxWallClockMs: 1_000,
    livenessHeartbeatMs: 100,
  });
  assert.equal(r.limitHit, true);
  const beats = eventlog.listEvents(sid, { types: ['heartbeat'] })
    .filter((event) => event.data.kind === 'progress_check_in');
  assert.ok(beats.length >= 1, 'the user/operator sees progress while iterator.next() is silent');
  assert.ok(beats.length <= 11, 'ticks stay rate-limited to the configured cadence');
  assert.ok(beats.every((event) => event.data.transport === 'claude_agent_sdk'));
  assert.equal(closed, 1);
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

test('buildScopedNativeMcpServers is permanently zero-width for every native MCP scope', () => {
  const scopes = [
    undefined,
    '',
    'get google organic SEO keyword rankings for a domain',
    'dataforseo__serp_organic_live_advanced',
  ];
  for (const scope of scopes) {
    assert.deepEqual(buildScopedNativeMcpServers(scope), {}, String(scope));
    assert.deepEqual(
      buildScopedNativeMcpServers(scope, { mode: 'resolved_tools' }),
      {},
      `resolved:${String(scope)}`,
    );
    assert.deepEqual(
      buildScopedNativeMcpServers(scope, {
        scope: { reason: 'exact', allowedServerSlugs: ['dataforseo'], maxTools: 1 },
      }),
      {},
      `explicit:${String(scope)}`,
    );
  }
});

test('runClaudeAgentSdk surfaces SDK compaction signals + context-window health (A1)', async () => {
  const eventlog = await import('./eventlog.js');
  const session = eventlog.createSession({ kind: 'chat' });
  const sessionId = session.id;
  setClaudeAgentSdkQueryForTest(((_params: any) => queryFromMessages([
    {
      type: 'system', subtype: 'init', model: 'claude-opus-4-8', session_id: 'sdk-compact-1', uuid: 'u1',
      apiKeySource: 'none', claude_code_version: '2.1.181', cwd: process.cwd(), tools: [], mcp_servers: [],
      permissionMode: 'dontAsk', slash_commands: [], output_style: 'default', skills: [], plugins: [],
    } as any,
    // The child process compacted its own context mid-run — previously dropped.
    {
      type: 'system', subtype: 'compact_boundary', session_id: 'sdk-compact-1', uuid: 'cb1',
      compact_metadata: { trigger: 'auto', pre_tokens: 150_000, post_tokens: 40_000, duration_ms: 900 },
    } as any,
    // A FAILED compaction must be visible too (it predicts a context-cliff death).
    {
      type: 'system', subtype: 'status', session_id: 'sdk-compact-1', uuid: 'st1',
      status: null, compact_result: 'failed', compact_error: 'summarizer unavailable',
    } as any,
    {
      type: 'result', subtype: 'success', session_id: 'sdk-compact-1', uuid: 'compact-result-1',
      result: 'ok', duration_ms: 20, duration_api_ms: 12, is_error: false, num_turns: 1,
      stop_reason: 'end_turn', total_cost_usd: 0,
      usage: { input_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 },
      modelUsage: { 'claude-opus-4-8': { inputTokens: 100_000, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 200_000, maxOutputTokens: 32_000 } },
      permission_denials: [],
    } as any,
  ], {})) as any);

  await runClaudeAgentSdk({ prompt: 'long analysis', sessionId, modelId: 'claude-opus-4-8' });

  const events = eventlog.listEvents(sessionId, {});
  const boundary = events.find((e) => e.type === 'sdk_compact_boundary');
  assert.ok(boundary, 'sdk_compact_boundary event appended');
  assert.equal((boundary!.data as any).preTokens, 150_000);
  assert.equal((boundary!.data as any).postTokens, 40_000);
  assert.equal((boundary!.data as any).trigger, 'auto');
  const failed = events.find((e) => e.type === 'sdk_compact_failed');
  assert.ok(failed, 'sdk_compact_failed event appended');
  assert.equal((failed!.data as any).error, 'summarizer unavailable');

  const usage = usageLog.readUsageEventsForDate().filter((e) => e.source === sessionId);
  assert.equal(usage.length, 1);
  assert.equal((usage[0] as any).contextWindowTokens, 200_000);
  assert.equal((usage[0] as any).windowUtilization, 0.5);
});

test('SDK child env gets a real MCP startup window (local server cold boot > default 30s under load)', async () => {
  const capture: { call?: any } = {};
  setClaudeAgentSdkQueryForTest(((params: any) => { capture.call = params; return queryFromMessages([
    { type: 'system', subtype: 'init', model: 'claude-opus-4-8', session_id: 's', uuid: 'u', apiKeySource: 'none', claude_code_version: '2.1.181', cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'dontAsk', slash_commands: [], output_style: 'default', skills: [], plugins: [] } as any,
    { type: 'result', subtype: 'success', session_id: 's', uuid: 'r', result: 'ok', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [] } as any,
  ], {}); }) as any);
  await runClaudeAgentSdk({ prompt: 'hi', sessionId: 'mcp-timeout-check' });
  assert.equal(capture.call.options.env.MCP_TIMEOUT, '120000');
});


// Voice-first handoff (owner feedback, 2026-07-24): the model's own
// handoff_note IS the dispatch reply; the generated line is only the floor.
test('dispatch_background_task terminal reply prefers the model-authored handoff_note', async () => {
  setClaudeAgentSdkQueryForTest(((_p: any) => {
    const q = stubsFor((async function* () {
      yield initOnlyMessage();
      yield {
        type: 'assistant',
        session_id: 's', uuid: 'a2', parent_tool_use_id: null,
        message: {
          content: [{
            type: 'tool_use', id: 'toolu_bg2',
            name: 'mcp__clementine-local__dispatch_background_task',
            input: {
              objective: 'Count markdown files',
              handoff_note: 'Kicking that off now — I\u2019ll count the markdown files in the background and drop the tally here the moment it lands.',
            },
          }],
        },
      } as any;
      yield {
        type: 'user',
        session_id: 's', uuid: 'u2', parent_tool_use_id: null,
        message: {
          content: [{
            type: 'tool_result', tool_use_id: 'toolu_bg2',
            content: 'Dispatched "Count markdown files" to the background (task bg-test-2) with a goal contract.',
          }],
        },
      } as any;
      yield successResultMessage('wrong foreground answer');
    })());
    return Object.assign(q, { interrupt: async () => { /* terminal interrupt */ } });
  }) as any);

  const r = await runClaudeAgentSdk({
    prompt: 'please background this',
    sessionId: 'sdk-dispatch-voice',
    modelId: 'claude-sonnet-4-6',
    allowedLocalMcpTools: ['dispatch_background_task'],
  });
  assert.match(r.text, /Kicking that off now/);
  assert.doesNotMatch(r.text, /it reports back here when it finishes/, 'floor text is not used when the model spoke');
});
