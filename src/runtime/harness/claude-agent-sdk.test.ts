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
const operationalTelemetry = await import('../operational-telemetry.js');
const eventlog = await import('./eventlog.js');
const artifactLedger = await import('./artifact-ledger.js');
const toolEconomy = await import('./tool-economy.js');
const capabilityHealth = await import('./capability-health.js');
const { toolCallCorrelationFingerprint } = await import('./tool-correlation.js');
const { formatAutoResolvedAskUserQuestionOutput } = await import('./terminal-tool.js');
const {
  CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS,
  CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS,
  ClaudeAgentSdkApprovalBoundaryError,
  ClaudeAgentSdkToolSurfaceError,
  buildAllowOnlyToolsPermission,
  buildClaudeAgentSdkLocalMcpServers,
  buildScopedNativeMcpServers,
  defaultClaudeAgentSdkAllowedLocalTools,
  runClaudeAgentSdk,
  resolveClaudeAgentSdkTrackerScope,
  setClaudeAgentSdkQueryForTest,
  setClaudeAgentSdkReflectionForTest,
  ClaudeSdkAuthExpiredError,
} = mod;
const { isAuthRecoverableError } = await import('../../execution/transient-error.js');

// The default posture is now 'yolo' (Autonomous, 2026-07-20) which auto-approves
// reversible/local + CRM writes. The park-mode / approval-gate tests below verify
// the GATE holds mutating actions for approval, so pin the Supervised posture.
// Irreversible sends are held regardless of posture.
const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
saveProactivityPolicy({ autoApproveScope: 'strict' });

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

test('native artifact replay with one durable run scope binds once and blocks a restarted retry', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const trackerScopeId = `${session.id}::brain:external-run-42`;
  artifactLedger._resetArtifactLedgerForTests();
  let queryCount = 0;
  let providerDispatches = 0;
  const permissionVerdicts: string[] = [];
  const previousReflection = process.env.CLEMMY_CLAUDE_SDK_REFLECTION;
  process.env.CLEMMY_CLAUDE_SDK_REFLECTION = 'off';

  setClaudeAgentSdkQueryForTest(((params: any) => {
    queryCount += 1;
    const callId = `toolu_create_${queryCount}`;
    const gen = (async function* () {
      yield {
        type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: `sdk-${queryCount}`,
        uuid: `init-${queryCount}`, apiKeySource: 'none', claude_code_version: '2.1.181', cwd: process.cwd(),
        tools: ['mcp__googledocs__create_document'], mcp_servers: [{ name: 'googledocs', status: 'connected' }],
        permissionMode: 'default', slash_commands: [], output_style: 'default', skills: [], plugins: [],
      } as any;
      const verdict = await params.options.canUseTool(
        'mcp__googledocs__create_document',
        { title: 'Firm brief' },
        { signal: new AbortController().signal, toolUseID: callId },
      );
      permissionVerdicts.push(verdict.behavior);
      if (verdict.behavior === 'allow') {
        providerDispatches += 1;
        yield {
          type: 'assistant', session_id: `sdk-${queryCount}`, uuid: `assistant-${queryCount}`,
          parent_tool_use_id: null,
          message: { content: [{ type: 'tool_use', id: callId, name: 'mcp__googledocs__create_document', input: { title: 'Firm brief' } }] },
        } as any;
        yield {
          type: 'user', session_id: `sdk-${queryCount}`, uuid: `result-${queryCount}`,
          parent_tool_use_id: null,
          message: { content: [{ type: 'tool_result', tool_use_id: callId, content: '{"documentId":"doc_durable_123456789"}' }] },
        } as any;
      }
      yield {
        type: 'result', subtype: 'success', session_id: `sdk-${queryCount}`, uuid: `done-${queryCount}`,
        result: verdict.behavior === 'allow' ? 'Created the document.' : 'Reused the existing document.',
        duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, stop_reason: 'end_turn',
        total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
      } as any;
    })();
    return Object.assign(gen, {
      close() {}, interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }), streamInput: async () => {},
      stopTask: async () => false, backgroundTasks: async () => false,
    }) as Query;
  }) as any);

  const options = {
    prompt: 'Create a Google Doc about the firm.',
    sessionId: session.id,
    modelId: 'claude-sonnet-4-6',
    trackerScopeId,
    allowedLocalMcpTools: ['mcp__googledocs__create_document'],
  };
  try {
    await runClaudeAgentSdk(options);
    // A second SDK process/query is the replay boundary. No in-memory claim is
    // shared; only the durable run scope + SQLite artifact row can stop it.
    await runClaudeAgentSdk(options);
    assert.deepEqual(permissionVerdicts, ['allow', 'deny']);
    assert.equal(providerDispatches, 1, 'the replay never crosses the provider boundary');
    assert.equal(artifactLedger.listRunArtifacts(session.id, trackerScopeId)[0]?.status, 'bound');
    assert.equal(eventlog.listEvents(session.id, { types: ['external_write'] }).length, 1, 'native mutation is durable before dispatch');
  } finally {
    if (previousReflection === undefined) delete process.env.CLEMMY_CLAUDE_SDK_REFLECTION;
    else process.env.CLEMMY_CLAUDE_SDK_REFLECTION = previousReflection;
  }
});

test('native duplicate admission is replay-safe and leaves economy, ceiling, approval, and grind untouched', async () => {
  const saved = {
    CLEMMY_SDK_TOOL_CEILING: process.env.CLEMMY_SDK_TOOL_CEILING,
    CLEMMY_SDK_MUTATING_CALL_CEILING: process.env.CLEMMY_SDK_MUTATING_CALL_CEILING,
    CLEMMY_CLAUDE_SDK_REFLECTION: process.env.CLEMMY_CLAUDE_SDK_REFLECTION,
  };
  process.env.CLEMMY_SDK_TOOL_CEILING = 'on';
  process.env.CLEMMY_SDK_MUTATING_CALL_CEILING = '1';
  process.env.CLEMMY_CLAUDE_SDK_REFLECTION = 'off';
  const approvalRegistry = await import('./approval-registry.js');
  const toolGuardrail = await import('./tool-guardrail.js');
  const session = eventlog.createSession({ kind: 'chat' });
  const trackerScopeId = `${session.id}::native-duplicate-admission`;
  const intent = {
    kind: 'google_doc',
    provider: 'Google Docs',
    slotKey: 'google_doc:primary',
    title: 'Existing brief',
    createShape: 'GOOGLEDOCS_CREATE_DOCUMENT',
  } as const;
  const seeded = artifactLedger.claimArtifactSlot(session.id, intent, 'seed-existing-doc', trackerScopeId);
  artifactLedger.bindClaimedArtifact(seeded.artifact.id, 'seed-existing-doc', {
    resourceId: 'doc_existing_provider_123456',
    uri: 'https://docs.google.com/document/d/doc_existing_provider_123456/edit',
  });
  toolGuardrail._resetAllTrackersForTests();
  const economyState = toolEconomy.createToolEconomyState({
    kind: 'single_deliverable', softLimit: 10, hardLimit: 15,
  });
  const duplicateVerdicts: Array<{ behavior?: string; message?: string }> = [];
  let sendVerdict: { behavior?: string; message?: string; interrupt?: boolean } | undefined;

  setClaudeAgentSdkQueryForTest(((params: any) => stubsFor((async function* () {
    yield initOnlyMessage();
    const canUse = params.options.canUseTool as (
      name: string,
      input: unknown,
      options: { signal: AbortSignal; toolUseID: string },
    ) => Promise<{ behavior?: string; message?: string; interrupt?: boolean }>;
    const duplicateInput = { title: 'Existing brief' };
    // The SDK may replay a permission callback while the first one is still in
    // flight, then replay it again after resolution. All three are one provider
    // call and must share one denial without touching downstream accounting.
    const duplicateOptions = { signal: new AbortController().signal, toolUseID: 'toolu_duplicate_existing_doc' };
    duplicateVerdicts.push(...await Promise.all([
      canUse('mcp__googledocs__create_document', duplicateInput, duplicateOptions),
      canUse('mcp__googledocs__create_document', duplicateInput, duplicateOptions),
    ]));
    duplicateVerdicts.push(await canUse(
      'mcp__googledocs__create_document', duplicateInput, duplicateOptions,
    ));
    assert.equal(
      approvalRegistry.listPending({ sessionId: session.id, status: 'any' }).length,
      0,
      'artifact reuse never surfaces an approval card',
    );

    // With a mutating ceiling of one, this distinct send reaches the approval
    // boundary only if the duplicate consumed zero ceiling slots.
    sendVerdict = await canUse(
      'mcp__outlook__send_email',
      { to: 'client@example.com', subject: 'Hello', body: 'Test' },
      { signal: new AbortController().signal, toolUseID: 'toolu_distinct_send' },
    );
    yield successResultMessage('permission checks complete');
  })())) as any);

  try {
    await assert.rejects(
      runClaudeAgentSdk({
        prompt: 'Reuse the existing document, then send the separate approved note.',
        sessionId: session.id,
        modelId: 'claude-sonnet-4-6',
        trackerScopeId,
        artifactRunScopeId: trackerScopeId,
        artifactObjective: 'Create one Google Doc named Existing brief.',
        agentic: true,
        approvalMode: 'park',
        allowedLocalMcpTools: ['read_file', 'memory_search'],
        readFanoutGuard: true,
        toolEconomyState: economyState,
      }),
      ClaudeAgentSdkApprovalBoundaryError,
      'the distinct send reaches its real approval boundary instead of tripping a ceiling inflated by the duplicate',
    );
    assert.equal(duplicateVerdicts.length, 3);
    for (const verdict of duplicateVerdicts) {
      assert.equal(verdict.behavior, 'deny');
      assert.match(verdict.message ?? '', /already bound|do not create another/i);
    }
    assert.equal(sendVerdict?.behavior, 'deny');
    assert.match(sendVerdict?.message ?? '', /Approval .* pending/i);
    assert.doesNotMatch(sendVerdict?.message ?? '', /stopped myself/i);
    assert.equal(economyState.attempts, 1, 'only the distinct send is a canonical economy attempt');
    assert.equal(economyState.allowed, 1);
    assert.equal(economyState.callDecisions.size, 1, 'duplicate callback/replays mint no economy decisions');
    assert.equal(
      toolGuardrail._peekTracker(trackerScopeId).recentCount,
      1,
      'only the distinct send enters grind tracking',
    );
    const approvals = approvalRegistry.listPending({ sessionId: session.id, status: 'any' });
    assert.equal(approvals.length, 1, 'only the distinct send creates an approval');
    assert.match(approvals[0]?.tool ?? '', /send_email/i);
    assert.equal(eventlog.listEvents(session.id, { types: ['external_write'] }).length, 0, 'neither denied action is recorded as dispatched');
    assert.equal(artifactLedger.listRunArtifacts(session.id, trackerScopeId).length, 1, 'the existing artifact remains the only slot');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('native artifact admission releases an exact pending claim when a later approval gate denies', async () => {
  const previousReflection = process.env.CLEMMY_CLAUDE_SDK_REFLECTION;
  process.env.CLEMMY_CLAUDE_SDK_REFLECTION = 'off';
  const session = eventlog.createSession({ kind: 'chat' });
  const trackerScopeId = `${session.id}::native-release-before-dispatch`;
  const toolName = 'mcp__googledocs__create_document';
  const input = { title: 'Approval-gated brief' };
  let phase: 'denied' | 'allowed' = 'denied';
  let firstVerdict: { behavior?: string; message?: string } | undefined;
  let retryVerdict: { behavior?: string; message?: string } | undefined;

  setClaudeAgentSdkQueryForTest(((params: any) => stubsFor((async function* () {
    yield initOnlyMessage();
    const canUse = params.options.canUseTool as (
      name: string,
      args: unknown,
      options: { signal: AbortSignal; toolUseID: string },
    ) => Promise<{ behavior?: string; message?: string }>;
    if (phase === 'denied') {
      firstVerdict = await canUse(toolName, input, {
        signal: new AbortController().signal,
        toolUseID: 'toolu_create_denied_before_dispatch',
      });
      yield successResultMessage('approval parked');
      return;
    }
    retryVerdict = await canUse(toolName, input, {
      signal: new AbortController().signal,
      toolUseID: 'toolu_create_authorized_retry',
    });
    if (retryVerdict.behavior === 'allow') {
      yield {
        type: 'assistant', session_id: 's', uuid: 'use-authorized-retry', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'toolu_create_authorized_retry', name: toolName, input }] },
      } as any;
      yield {
        type: 'user', session_id: 's', uuid: 'result-authorized-retry', parent_tool_use_id: null,
        message: { content: [{
          type: 'tool_result', tool_use_id: 'toolu_create_authorized_retry', is_error: false,
          content: JSON.stringify({ documentId: 'doc_authorized_retry_123456' }),
        }] },
      } as any;
    }
    yield successResultMessage('authorized retry complete');
  })())) as any);

  const shared = {
    prompt: 'Create one Google Doc named Approval-gated brief.',
    sessionId: session.id,
    modelId: 'claude-sonnet-4-6',
    trackerScopeId,
    artifactRunScopeId: trackerScopeId,
    artifactObjective: 'Create one Google Doc named Approval-gated brief.',
  };
  try {
    await assert.rejects(
      runClaudeAgentSdk({
        ...shared,
        agentic: true,
        approvalMode: 'park',
        allowedLocalMcpTools: ['read_file'],
      }),
      ClaudeAgentSdkApprovalBoundaryError,
    );
    assert.equal(firstVerdict?.behavior, 'deny');
    assert.match(firstVerdict?.message ?? '', /Approval .* pending/i);
    assert.equal(
      artifactLedger.listRunArtifacts(session.id, trackerScopeId).length,
      0,
      'a provider-denied call leaves no stranded pending artifact row',
    );

    phase = 'allowed';
    await runClaudeAgentSdk({
      ...shared,
      allowedLocalMcpTools: [toolName],
    });
    assert.equal(retryVerdict?.behavior, 'allow', 'the authorized retry reacquires the released slot');
    const [artifact] = artifactLedger.listRunArtifacts(session.id, trackerScopeId);
    assert.equal(artifact?.status, 'bound');
    assert.equal(artifact?.resourceId, 'doc_authorized_retry_123456');
    assert.equal(eventlog.listEvents(session.id, { types: ['external_write'] }).length, 1);
  } finally {
    if (previousReflection === undefined) delete process.env.CLEMMY_CLAUDE_SDK_REFLECTION;
    else process.env.CLEMMY_CLAUDE_SDK_REFLECTION = previousReflection;
  }
});

test('native MCP mutations emit durable failed and orphan truth keyed by provider call id', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  let run = 0;
  setClaudeAgentSdkQueryForTest(((params: any) => {
    run += 1;
    const callId = run === 1 ? 'toolu_native_failed' : 'toolu_native_orphan';
    const gen = (async function* () {
      yield {
        type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: `sdk-write-${run}`,
        uuid: `init-write-${run}`, apiKeySource: 'none', claude_code_version: '2.1.181', cwd: process.cwd(),
        tools: ['mcp__outlook__send_email'], mcp_servers: [{ name: 'outlook', status: 'connected' }],
        permissionMode: 'default', slash_commands: [], output_style: 'default', skills: [], plugins: [],
      } as any;
      const input = { to: 'client@example.com', subject: 'Hello', body: 'Test' };
      const verdict = await params.options.canUseTool(
        'mcp__outlook__send_email', input,
        { signal: new AbortController().signal, toolUseID: callId },
      );
      assert.equal(verdict.behavior, 'allow');
      if (run === 1) {
        yield {
          type: 'assistant', session_id: `sdk-write-${run}`, uuid: 'use-failed', parent_tool_use_id: null,
          message: { content: [{ type: 'tool_use', id: callId, name: 'mcp__outlook__send_email', input }] },
        } as any;
        yield {
          type: 'user', session_id: `sdk-write-${run}`, uuid: 'result-failed', parent_tool_use_id: null,
          message: { content: [{ type: 'tool_result', tool_use_id: callId, is_error: true, content: 'provider rejected payload' }] },
        } as any;
      }
      yield {
        type: 'result', subtype: 'success', session_id: `sdk-write-${run}`, uuid: `done-write-${run}`,
        result: 'done', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1,
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

  const options = {
    prompt: 'Send the email.', sessionId: session.id, modelId: 'claude-sonnet-4-6',
    trackerScopeId: 'native-write-truth', allowedLocalMcpTools: ['mcp__outlook__send_email'],
  };
  await runClaudeAgentSdk(options);
  await runClaudeAgentSdk(options);
  const writes = eventlog.listEvents(session.id, { types: ['external_write'] });
  const failed = eventlog.listEvents(session.id, { types: ['external_write_failed'] });
  const orphaned = eventlog.listEvents(session.id, { types: ['external_write_orphaned'] });
  assert.deepEqual(writes.map((event) => (event.data as any).callId), ['toolu_native_failed', 'toolu_native_orphan']);
  assert.equal((failed[0]?.data as any)?.callId, 'toolu_native_failed');
  assert.equal((orphaned[0]?.data as any)?.callId, 'toolu_native_orphan');
});

test('explicit multi-document objective permits distinct native creates and settles reversed results by call id', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const trackerScopeId = `${session.id}::multi-doc-root`;
  const calls = [
    { id: 'toolu_client_brief', title: 'Client brief', documentId: 'doc_client_brief_123456' },
    { id: 'toolu_appendix', title: 'Technical appendix', documentId: 'doc_appendix_123456' },
  ];
  const verdicts: string[] = [];
  setClaudeAgentSdkQueryForTest(((params: any) => {
    const gen = (async function* () {
      yield {
        type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: 'sdk-multi-doc',
        uuid: 'init-multi-doc', apiKeySource: 'none', claude_code_version: '2.1.181', cwd: process.cwd(),
        tools: ['mcp__googledocs__create_document'], mcp_servers: [{ name: 'googledocs', status: 'connected' }],
        permissionMode: 'default', slash_commands: [], output_style: 'default', skills: [], plugins: [],
      } as any;
      for (const call of calls) {
        const verdict = await params.options.canUseTool(
          'mcp__googledocs__create_document', { title: call.title },
          { signal: new AbortController().signal, toolUseID: call.id },
        );
        verdicts.push(verdict.behavior);
      }
      yield {
        type: 'assistant', session_id: 'sdk-multi-doc', uuid: 'uses-multi-doc', parent_tool_use_id: null,
        message: { content: calls.map((call) => ({
          type: 'tool_use', id: call.id, name: 'mcp__googledocs__create_document', input: { title: call.title },
        })) },
      } as any;
      yield {
        type: 'user', session_id: 'sdk-multi-doc', uuid: 'results-multi-doc', parent_tool_use_id: null,
        message: { content: [...calls].reverse().map((call) => ({
          type: 'tool_result', tool_use_id: call.id, is_error: false,
          content: JSON.stringify({ documentId: call.documentId }),
        })) },
      } as any;
      yield {
        type: 'result', subtype: 'success', session_id: 'sdk-multi-doc', uuid: 'done-multi-doc',
        result: 'Created both documents.', duration_ms: 1, duration_api_ms: 1, is_error: false,
        num_turns: 1, stop_reason: 'end_turn', total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
      } as any;
    })();
    return Object.assign(gen, {
      close() {}, interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }), streamInput: async () => {},
      stopTask: async () => false, backgroundTasks: async () => false,
    }) as Query;
  }) as any);
  await runClaudeAgentSdk({
    prompt: 'Create two separate Google Docs: a client brief and a technical appendix.',
    artifactObjective: 'Create two separate Google Docs: a client brief and a technical appendix.',
    sessionId: session.id,
    trackerScopeId,
    artifactRunScopeId: trackerScopeId,
    modelId: 'claude-sonnet-4-6',
    allowedLocalMcpTools: ['mcp__googledocs__create_document'],
  });
  assert.deepEqual(verdicts, ['allow', 'allow']);
  const artifacts = artifactLedger.listRunArtifacts(session.id, trackerScopeId);
  assert.deepEqual(
    artifacts.map((artifact) => [artifact.slotKey, artifact.resourceId]),
    [
      ['google_doc:client-brief', 'doc_client_brief_123456'],
      ['google_doc:technical-appendix', 'doc_appendix_123456'],
    ],
  );
});

test('artifact verification repair gate enforces exact-id read-back and denies every mutation/exploration call', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const documentId = 'doc_enforced_verify_123456789';
  const verdicts: string[] = [];
  setClaudeAgentSdkQueryForTest(((params: any) => {
    const gen = (async function* () {
      yield {
        type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: 'sdk-verify-gate',
        uuid: 'init-verify-gate', apiKeySource: 'none', claude_code_version: '2.1.181', cwd: process.cwd(),
        tools: [], mcp_servers: [], permissionMode: 'default', slash_commands: [], output_style: 'default', skills: [], plugins: [],
      } as any;
      const calls = [
        ['mcp__googledocs__create_document', { title: 'Duplicate' }, 'create'],
        ['mcp__googledocs__search_documents', { query: 'Firm' }, 'search'],
        ['mcp__googledocs__get_document', { document_id: 'wrong-doc' }, 'wrong'],
        ['mcp__googledocs__get_document', { document_id: documentId }, 'exact'],
      ] as const;
      for (const [name, input, id] of calls) {
        const verdict = await params.options.canUseTool(name, input, {
          signal: new AbortController().signal, toolUseID: `toolu_${id}`,
        });
        verdicts.push(verdict.behavior);
      }
      yield {
        type: 'result', subtype: 'success', session_id: 'sdk-verify-gate', uuid: 'done-verify-gate',
        result: 'checked', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1,
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
  await runClaudeAgentSdk({
    prompt: 'Verify only.', sessionId: session.id, modelId: 'claude-sonnet-4-6',
    allowedLocalMcpTools: ['mcp__googledocs__get_document'],
    artifactVerificationOnly: [{ kind: 'google_doc', resourceId: documentId }],
  });
  assert.deepEqual(verdicts, ['deny', 'deny', 'deny', 'allow']);
  assert.equal(eventlog.listEvents(session.id, { types: ['external_write'] }).length, 0);
});

test('native MCP getter result independently verifies the exact bound Google Doc', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const trackerScopeId = `${session.id}::brain:verify-native-doc`;
  const documentId = 'doc_native_verify_123456789';
  const intent = {
    kind: 'google_doc', provider: 'Google Docs', slotKey: 'google_doc:primary',
    title: 'Native brief', createShape: 'GOOGLEDOCS_CREATE_DOCUMENT',
  } as const;
  artifactLedger.claimArtifactSlot(session.id, intent, 'native-create', trackerScopeId);
  artifactLedger.bindArtifactSlot(session.id, intent.slotKey, {
    resourceId: documentId,
    uri: `https://docs.google.com/document/d/${documentId}/edit`,
  }, 'native-create', trackerScopeId);

  const messages: SDKMessage[] = [
    {
      type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: 'sdk-native-verify',
      uuid: 'init-native-verify', apiKeySource: 'none', claude_code_version: '2.1.181', cwd: process.cwd(),
      tools: ['mcp__googledocs__get_document'], mcp_servers: [{ name: 'googledocs', status: 'connected' }],
      permissionMode: 'default', slash_commands: [], output_style: 'default', skills: [], plugins: [],
    } as any,
    {
      type: 'assistant', session_id: 'sdk-native-verify', uuid: 'use-native-verify', parent_tool_use_id: null,
      message: { content: [{
        type: 'tool_use', id: 'toolu_native_readback', name: 'mcp__googledocs__get_document',
        input: { document_id: documentId },
      }] },
    } as any,
    {
      type: 'user', session_id: 'sdk-native-verify', uuid: 'result-native-verify', parent_tool_use_id: null,
      message: { content: [{
        type: 'tool_result', tool_use_id: 'toolu_native_readback', is_error: false,
        content: JSON.stringify({ data: {
          document_id: documentId,
          display_url: `https://docs.google.com/document/d/${documentId}/edit`,
          plain_text: 'Verified brief',
        } }),
      }] },
    } as any,
    {
      type: 'result', subtype: 'success', session_id: 'sdk-native-verify', uuid: 'done-native-verify',
      result: 'Verified the document.', duration_ms: 1, duration_api_ms: 1, is_error: false,
      num_turns: 1, stop_reason: 'end_turn', total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
    } as any,
  ];
  const previousReflection = process.env.CLEMMY_CLAUDE_SDK_REFLECTION;
  process.env.CLEMMY_CLAUDE_SDK_REFLECTION = 'off';
  setClaudeAgentSdkQueryForTest((() => queryFromMessages(messages, {})) as any);
  try {
    await runClaudeAgentSdk({
      prompt: 'Verify the document.', sessionId: session.id, trackerScopeId,
      modelId: 'claude-sonnet-4-6', allowedLocalMcpTools: [],
    });
    const [verified] = artifactLedger.listRunArtifacts(session.id, trackerScopeId);
    assert.ok(verified?.bindingVerifiedAt);
    assert.equal(verified?.verificationCallId, 'toolu_native_readback');
    assert.equal(verified?.verificationShape, 'GOOGLEDOCS_GET_DOCUMENT');
  } finally {
    if (previousReflection === undefined) delete process.env.CLEMMY_CLAUDE_SDK_REFLECTION;
    else process.env.CLEMMY_CLAUDE_SDK_REFLECTION = previousReflection;
  }
});

test('buildClaudeAgentSdkLocalMcpServers exposes the local Clementine MCP in-process SDK server by default', () => {
  const servers = buildClaudeAgentSdkLocalMcpServers('brain-session-1');
  const local = servers['clementine-local'] as any;
  assert.equal(local.type, 'sdk');
  assert.equal(local.name, 'clementine-local');
  assert.ok(local.instance, 'in-process MCP server instance should be present');
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
      { sourceUserSeq: 123 },
    );
    const local = servers['clementine-local'] as any;
    assert.equal(local.type, 'stdio');
    assert.ok(local.command === 'npx' || local.command.length > 0);
    assert.equal(local.alwaysLoad, true);
    assert.equal(local.env.CLEMENTINE_HOME, TMP_HOME);
    assert.equal(local.env.CLEMENTINE_MCP_SESSION_ID, 'brain-session-1');
    assert.equal(local.env.CLEMENTINE_MCP_SOURCE_USER_SEQ, '123');
    assert.ok(Array.isArray(local.args));
    assert.ok(local.args.some((arg: string) => arg.includes('mcp-server')));

    const deferred = buildClaudeAgentSdkLocalMcpServers(
      'brain-session-deferred-stdio',
      true,
      undefined,
      undefined,
      { alwaysLoadTools: ['memory_recall_all'], deferUnlistedTools: true },
    )['clementine-local'] as any;
    assert.equal(deferred.alwaysLoad, false);
    assert.equal(deferred.env.CLEMENTINE_MCP_ALWAYS_LOAD_TOOLS, 'memory_recall_all');
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
});

test('replayed assistant frames contribute one returned tool use per provider call id', async () => {
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
      message: { content: [{ ...toolUse, name: 'mcp__clementine-local__write_file', input: { path: '/tmp/altered' } }] },
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

test('agentic JIT keeps its selected local tools first-class while registering the rest for same-turn acquisition', async () => {
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
    requiredLocalMcpTools: ['memory_recall_all'],
  });

  const local = capture.call.options.mcpServers['clementine-local'] as any;
  const registered = local.instance._registeredTools as Record<string, { _meta?: Record<string, unknown> }>;
  assert.equal(registered.memory_recall_all?._meta?.['anthropic/alwaysLoad'], true);
  assert.equal(registered.tool_search?._meta?.['anthropic/alwaysLoad'], true);
  assert.ok(registered.workflow_update, 'a non-JIT tool stays registered for native acquisition');
  assert.equal(registered.workflow_update?._meta?.['anthropic/alwaysLoad'], undefined);
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
  assert.equal(events[0].providerApiDurationMs, 12);
  assert.equal(events[0].responseId, 'usage-result-1');

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

test('runClaudeAgentSdk reflects each tool return into the learning pipeline (brain continuity)', async () => {
  setClaudeAgentSdkQueryForTest(((_params: any) => queryFromMessages(streamWithToolReturn(), {})) as any);
  const reflected: Array<{ sessionId: string; callId: string; tool: string | null; output: string }> = [];
  setClaudeAgentSdkReflectionForTest(((input: any) => { reflected.push(input); }) as any);
  const sess = eventlog.createSession({ id: 'clem-sess-1', kind: 'chat' });

  await runClaudeAgentSdk({ prompt: 'Look up Acme.', sessionId: sess.id, agentic: true });

  assert.equal(reflected.length, 1);
  assert.equal(reflected[0].sessionId, sess.id);
  assert.equal(reflected[0].callId, 'toolu_42');
  // The MCP-namespaced Composio wrapper is unwrapped to the real action slug
  // for source-trust parity with the Codex RunHooks path.
  assert.equal(reflected[0].tool, 'SALESFORCE_QUERY');
  assert.match(reflected[0].output, /Acme Corp has 3 open opportunities/);

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
  assert.match(String(returned[0].data.preview ?? ''), /Acme Corp has 3 open opportunities/);
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
  assert.match(result.text, /continue/i);
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
        // A behaviorally mutating shell command registers an approval and
        // AWAITS a human. Resolve it ~150ms later (a "slow human").
        // That 150ms is spent INSIDE canUseTool → pausedMs, so it must NOT count
        // toward the 40ms wall clock.
        const callP = canUse('mcp__clementine-local__run_shell_command', { command: 'git push origin main' }, { signal: new AbortController().signal });
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
      // Force the silent-iterator ticker to inspect the wall clock repeatedly
      // while canUseTool is still waiting. The regression used to pass only
      // because the default 60s heartbeat never observed the live wait.
      livenessHeartbeatMs: 5,
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
    // 24ms/6ms was a coin flip (failed 8/9 solo). 1000ms/100ms leaves ≥800ms
    // of tick headroom even after slow setup: the ≥2 liveness bound needs
    // only 200ms of ticking; the ≤11 bound is the rate limit
    // (wallClock/cadence + 1) — a mis-rate-limited loop would blow past it.
    maxWallClockMs: 1_000,
    livenessHeartbeatMs: 100,
  });
  assert.equal(r.limitHit, true);
  const beats = eventlog.listEvents(sid, { types: ['heartbeat'] })
    .filter((event) => event.data.kind === 'progress_check_in');
  assert.ok(beats.length >= 2, 'the user/operator sees progress while iterator.next() is silent');
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

test('buildScopedNativeMcpServers: an SEO turn attaches the native dataforseo MCP (scoped), kill-switch off yields none', async () => {
  const { invalidateMcpServerDiscoveryCache } = await import('../mcp-config.js');
  const mcpDir = path.join(TMP_HOME, 'mcp');
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(path.join(mcpDir, 'servers.json'), JSON.stringify({
    dataforseo: { type: 'stdio', command: 'npx', args: ['dataforseo-mcp-server'], env: { DATAFORSEO_USERNAME: 'x', DATAFORSEO_PASSWORD: 'y' }, description: 'SEO', enabled: true },
    supabase: { type: 'stdio', command: 'npx', args: ['supabase-mcp'], description: 'db', enabled: true },
  }), 'utf-8');
  invalidateMcpServerDiscoveryCache();

  const prev = process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP;
  const prevScope = process.env.CLEMMY_SCOPED_MCP_TOOLS;
  try {
    delete process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP; // default on
    process.env.CLEMMY_SCOPED_MCP_TOOLS = 'on'; // ensure scoping engages
    const seo = buildScopedNativeMcpServers('get google organic SEO keyword rankings for a domain');
    assert.ok(seo.dataforseo, 'the dataforseo native MCP attaches for an SEO turn');
    assert.equal((seo.dataforseo as any).type, 'stdio');
    assert.equal((seo.dataforseo as any).command, 'npx');
    assert.ok((seo.dataforseo as any).env.DATAFORSEO_USERNAME, 'the server env is carried through');
    assert.equal(seo.supabase, undefined, 'an unrelated native server is scoped OUT of an SEO turn');

    process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP = 'off';
    assert.deepEqual(buildScopedNativeMcpServers('get SEO rankings'), {}, 'kill-switch off ⇒ no native attach');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP; else process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP = prev;
    if (prevScope === undefined) delete process.env.CLEMMY_SCOPED_MCP_TOOLS; else process.env.CLEMMY_SCOPED_MCP_TOOLS = prevScope;
    invalidateMcpServerDiscoveryCache();
  }
});

test('buildScopedNativeMcpServers: tool-search DEFAULT-ON defers external servers (alwaysLoad:false); =off keeps them loaded', async () => {
  const { invalidateMcpServerDiscoveryCache } = await import('../mcp-config.js');
  const mcpDir = path.join(TMP_HOME, 'mcp');
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(path.join(mcpDir, 'servers.json'), JSON.stringify({
    dataforseo: { type: 'stdio', command: 'npx', args: ['dataforseo-mcp-server'], env: { DATAFORSEO_USERNAME: 'x', DATAFORSEO_PASSWORD: 'y' }, description: 'SEO', enabled: true },
  }), 'utf-8');
  invalidateMcpServerDiscoveryCache();

  const prev = process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP;
  const prevScope = process.env.CLEMMY_SCOPED_MCP_TOOLS;
  const prevTS = process.env.CLEMMY_CLAUDE_TOOL_SEARCH;
  try {
    delete process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP;
    process.env.CLEMMY_SCOPED_MCP_TOOLS = 'on';

    // DEFAULT (v1.0 = ON): the external server is deferred behind tool search
    // (surfaced by name, schema on demand) — still attaches, discoverable.
    delete process.env.CLEMMY_CLAUDE_TOOL_SEARCH;
    const deferred = buildScopedNativeMcpServers('get google organic SEO keyword rankings for a domain');
    assert.ok(deferred.dataforseo, 'still attaches (discoverable by name)');
    assert.equal((deferred.dataforseo as any).alwaysLoad, false, 'default-on ⇒ schema deferred / loaded on demand');
    assert.equal((deferred.dataforseo as any).command, 'npx', 'the rest of the config is preserved');

    // Kill-switch =off: external server loads normally (no forced defer).
    process.env.CLEMMY_CLAUDE_TOOL_SEARCH = 'off';
    const loaded = buildScopedNativeMcpServers('get google organic SEO keyword rankings for a domain');
    assert.ok(loaded.dataforseo, 'attaches for an SEO turn');
    assert.equal((loaded.dataforseo as any).alwaysLoad, undefined, '=off ⇒ not forced to defer');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP; else process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP = prev;
    if (prevScope === undefined) delete process.env.CLEMMY_SCOPED_MCP_TOOLS; else process.env.CLEMMY_SCOPED_MCP_TOOLS = prevScope;
    if (prevTS === undefined) delete process.env.CLEMMY_CLAUDE_TOOL_SEARCH; else process.env.CLEMMY_CLAUDE_TOOL_SEARCH = prevTS;
    invalidateMcpServerDiscoveryCache();
  }
});

test('buildScopedNativeMcpServers: an EMPTY scope attaches NO external servers (no allowAll over-attach)', async () => {
  const { invalidateMcpServerDiscoveryCache } = await import('../mcp-config.js');
  const mcpDir = path.join(TMP_HOME, 'mcp');
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(path.join(mcpDir, 'servers.json'), JSON.stringify({
    dataforseo: { type: 'stdio', command: 'npx', args: ['dataforseo-mcp-server'], env: { DATAFORSEO_USERNAME: 'x', DATAFORSEO_PASSWORD: 'y' }, description: 'SEO', enabled: true },
    supabase: { type: 'stdio', command: 'npx', args: ['supabase-mcp'], description: 'db', enabled: true },
  }), 'utf-8');
  invalidateMcpServerDiscoveryCache();

  const prev = process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP;
  const prevScope = process.env.CLEMMY_SCOPED_MCP_TOOLS;
  try {
    delete process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP; // default on
    process.env.CLEMMY_SCOPED_MCP_TOOLS = 'on';
    // The regression this guards: an unscoped native-lane call (run_worker /
    // workflow-step used to pass nothing) must NOT fall through to allowAll and
    // cold-start every external MCP child. Empty, whitespace, and undefined all
    // yield {} — a concrete scope still attaches its server (asserted above).
    assert.deepEqual(buildScopedNativeMcpServers(''), {}, 'empty string ⇒ no external servers');
    assert.deepEqual(buildScopedNativeMcpServers('   '), {}, 'whitespace ⇒ no external servers');
    assert.deepEqual(buildScopedNativeMcpServers(undefined), {}, 'undefined ⇒ no external servers');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP; else process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP = prev;
    if (prevScope === undefined) delete process.env.CLEMMY_SCOPED_MCP_TOOLS; else process.env.CLEMMY_SCOPED_MCP_TOOLS = prevScope;
    invalidateMcpServerDiscoveryCache();
  }
});

test('buildScopedNativeMcpServers: resolved_tools mode never fail-opens worker packets', async () => {
  const { invalidateMcpServerDiscoveryCache } = await import('../mcp-config.js');
  const mcpDir = path.join(TMP_HOME, 'mcp');
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(path.join(mcpDir, 'servers.json'), JSON.stringify({
    dataforseo: { type: 'stdio', command: 'npx', args: ['dataforseo-mcp-server'], env: { DATAFORSEO_USERNAME: 'x', DATAFORSEO_PASSWORD: 'y' }, description: 'SEO', enabled: true },
    supabase: { type: 'stdio', command: 'npx', args: ['supabase-mcp'], description: 'db', enabled: true },
  }), 'utf-8');
  invalidateMcpServerDiscoveryCache();

  const prev = process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP;
  const prevScope = process.env.CLEMMY_SCOPED_MCP_TOOLS;
  try {
    delete process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP;
    process.env.CLEMMY_SCOPED_MCP_TOOLS = 'on';

    assert.deepEqual(buildScopedNativeMcpServers('none needed', { mode: 'resolved_tools' }), {});
    assert.deepEqual(buildScopedNativeMcpServers('skill_read read_file', { mode: 'resolved_tools' }), {});
    assert.deepEqual(
      buildScopedNativeMcpServers('DATAFORSEO_GET_GOOGLE_HIST_BULK_TRAFFIC_EST_LIVE', { mode: 'resolved_tools' }),
      {},
      'Composio tool slugs stay on composio_execute_tool, not native MCP',
    );

    const exact = buildScopedNativeMcpServers('dataforseo__serp_organic_live_advanced', { mode: 'resolved_tools' });
    assert.ok(exact.dataforseo, 'exact native MCP tool slug attaches its server');
    assert.equal(exact.supabase, undefined, 'resolved_tools mode does not attach unrelated servers');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP; else process.env.CLEMMY_CLAUDE_SDK_NATIVE_MCP = prev;
    if (prevScope === undefined) delete process.env.CLEMMY_SCOPED_MCP_TOOLS; else process.env.CLEMMY_SCOPED_MCP_TOOLS = prevScope;
    invalidateMcpServerDiscoveryCache();
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
