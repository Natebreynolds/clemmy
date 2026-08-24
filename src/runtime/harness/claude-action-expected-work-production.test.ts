import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MCPServer } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-claude-action-work-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.AUTH_MODE = 'claude_oauth';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
process.env.CLEMMY_CLAUDE_SDK_INPROCESS_MCP = 'on';
process.env.CLEMMY_CLAUDE_TOOL_SEARCH = 'on';
process.env.CLEMMY_CLAUDE_SDK_REFLECTION = 'off';
process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
process.env.CLEMMY_CLAUDE_SDK_SESSION_HISTORY = 'off';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_INTERACTIVE_TOOL_ECONOMY = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const acceptedAuthority = await import('./accepted-task-authority.js');
const expectedWork = await import('./expected-work-contract.js');
const actionBoundary = await import('./action-expected-work-boundary.js');
const actionAdmission = await import('./expected-work-admission.js');
const discovery = await import('./discovery-governor.js');
const mcpConfig = await import('../mcp-config.js');
const mcpServers = await import('../mcp-servers.js');
const localMcpServer = await import('../../tools/mcp-server.js');
const sdk = await import('./claude-agent-sdk.js');
const claudeLocalCorrelation = await import('./claude-local-tool-correlation.js');
const brain = await import('./claude-agent-brain.js');
const terminalRepair = await import('./terminal-presentation-repair.js');
const nestedDispatch = await import('../../tools/inner-dispatch.js');

function writeClaudeToken(): void {
  writeFileSync(path.join(TMP_HOME, 'state', 'claude-auth.json'), JSON.stringify({
    accessToken: 'sk-ant-oat01-action-work-test',
    refreshToken: 'refresh-action-work-test',
    expiresAt: Date.now() + 60 * 60 * 1000,
    scopes: ['user:inference'],
  }), 'utf8');
}

function queryFromMessages(messages: SDKMessage[]): Query {
  const generator = (async function* () {
    for (const message of messages) yield message;
  })();
  return Object.assign(generator, {
    close() {},
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    streamInput: async () => {},
    stopTask: async () => false,
    backgroundTasks: async () => false,
  }) as Query;
}

function successMessages(tools: string[]): SDKMessage[] {
  return [
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
      session_id: 'sdk-action-work',
      uuid: 'sdk-action-work-init',
      apiKeySource: 'none',
      claude_code_version: '2.1.181',
      cwd: process.cwd(),
      tools,
      mcp_servers: [{ name: 'clementine-local', status: 'connected' }],
      permissionMode: 'default',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
    } as SDKMessage,
    {
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-action-work',
      uuid: 'sdk-action-work-result',
      result: 'Still working from verified evidence.',
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
      permission_denials: [],
    } as SDKMessage,
  ];
}

function prepareExactTask(text: string, activateAction = true): {
  sessionId: string;
  sourceUserSeq: number;
  route: 'direct_reply' | 'retrieve' | 'act';
} {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const recorded = shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, turn: 1, sourceUserSeq: source.seq },
    surface: 'home',
  });
  assert.ok(recorded);
  const graph = shadow.turnGraphFromShadowEvent(recorded);
  assert.ok(graph);
  acceptedAuthority.requireAcceptedTaskAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  const known = expectedWork.requireKnownExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  if (
    activateAction
    && (
      known.status === 'action_deferred'
      || (known.status === 'bound' && graph.classification.route === 'act')
    )
  ) {
    actionBoundary.requireActionExpectedWorkActivation({
      sessionId: session.id,
      sourceUserSeq: source.seq,
    });
  }
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    route: graph.classification.route,
  };
}

beforeEach(() => {
  writeClaudeToken();
  eventlog.resetEventLog();
  sdk.setClaudeAgentSdkQueryForTest(null);
  brain.setClaudeAgentSdkBrainRunForTest(null);
  brain.setClaudeAgentSdkBrainPostTurnHooksForTest(null);
  brain.setClaudeAgentSdkBrainJudgeForTest(null);
  brain.setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest(null);
  nestedDispatch._setInnerDispatchToolsForTests(null);
  brain.setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => ({
    objective: query,
    hits: [],
    perStore: {},
    answerability: 'insufficient',
    diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
  }));
});

after(() => {
  sdk.setClaudeAgentSdkQueryForTest(null);
  brain.setClaudeAgentSdkBrainRunForTest(null);
  brain.setClaudeAgentSdkBrainPostTurnHooksForTest(null);
  brain.setClaudeAgentSdkBrainJudgeForTest(null);
  brain.setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest(null);
  brain.setClaudeAgentSdkBrainUnifiedPrimerForTest(null);
  nestedDispatch._setInnerDispatchToolsForTests(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('Claude brain activates the exact act source before entering model construction', async () => {
  const sessionId = 'claude-action-activation-production';
  eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'desktop' });
  let modelEntries = 0;
  brain.setClaudeAgentSdkBrainRunForTest(async (options) => {
    modelEntries += 1;
    assert.ok(options.sourceUserSeq);
    assert.equal(actionAdmission.actionExpectedWorkState({
      sessionId,
      sourceUserSeq: options.sourceUserSeq!,
    }).status, 'required');
    throw new Error('intentional-stop-after-model-construction');
  });

  await assert.rejects(
    brain.respondViaClaudeAgentSdkBrain('home', {
      message: 'Read the alpha source and write every record into a new report.',
      sessionId,
      channel: 'desktop',
    }),
    /intentional-stop-after-model-construction/,
  );
  assert.equal(modelEntries, 1);
});

test('connected Claude brain accepts the work_call action surface without requiring call_tool', async () => {
  const sessionId = 'claude-action-work-call-sentinel';
  let queries = 0;
  let brokerCoverage = '';
  sdk.setClaudeAgentSdkQueryForTest(((params: any) => {
    queries += 1;
    const registered = params.options.mcpServers['clementine-local']
      .instance._registeredTools as Record<string, unknown>;
    assert.ok(registered.memory_recall_all);
    assert.ok(registered.tool_search);
    assert.ok(registered.work_call);
    // work_call stays the sole BUSINESS-WRITE carrier; call_tool mounts in
    // control+read-only mode (lane parity with Codex, 2026-08-20) so deferred
    // control/read tools have a direct door instead of proposal grammar.
    assert.ok(registered.call_tool,
      'the control/read-only dispatcher mounts beside the bound carrier');
    const messages = successMessages([
      'mcp__clementine-local__memory_recall_all',
      'mcp__clementine-local__tool_search',
      'mcp__clementine-local__work_call',
    ]);
    const stream = (async function* () {
      yield messages[0]!;
      const searched = await (registered.tool_search as any).handler({
        query: 'memory_recall',
        limit: 1,
      });
      brokerCoverage = JSON.parse(searched.content[0].text).brokerCoverage;
      yield messages[1]!;
    })();
    return Object.assign(stream, {
      close() {},
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
      streamInput: async () => {},
      stopTask: async () => false,
      backgroundTasks: async () => false,
    }) as Query;
  }) as never);

  // Final doctrine 2026-08-18: a precise named job is its own approval —
  // the plan line informs, execution proceeds in the same turn.
  const response = await brain.respondViaClaudeAgentSdkBrain('home', {
    message: 'Read the alpha source, then write every record into a new report.',
    sessionId,
    channel: 'desktop',
  });

  assert.equal(queries, 1, 'the connected brain reached the SDK query');
  assert.equal(response.sessionId, sessionId);
  assert.equal(brokerCoverage, 'authorized_external_v1');
  const source = eventlog.listEvents(sessionId, { types: ['user_input_received'] }).at(-1);
  assert.ok(source);
  const state = discovery.discoveryGovernor.getTaskState({
    sessionId,
    sourceUserSeq: source.seq,
  });
  assert.equal(state?.policy.roleScoped, true, 'the connected Claude action freezes discovery roles');
  assert.equal(state?.roles.length, 2, 'the compound request retains one role per semantic clause');
  assert.ok(state?.roles.every((role) => !role.resolved));
});

test('an action carrier registration failure aborts the MCP surface instead of exposing call_tool', () => {
  const registered: string[] = [];
  assert.throws(() => localMcpServer.createClementineMcpServer({
    sessionId: 'missing-action-authority',
    sourceUserSeq: 1,
    runScopeId: 'missing-action-authority::run',
    directOrchestrator: true,
    actionExpectedWork: true,
    allowedTools: ['mcp_list_tools', 'work_call'],
    deferredTools: ['run_shell_command'],
    onToolRegistered: (name) => registered.push(name),
  }), /ACTION_EXPECTED_WORK_CARRIER_UNAVAILABLE/);
  assert.equal(registered.includes('call_tool'), false,
    'an action registration race cannot silently install the unbound carrier');
});

test('exact Claude act surface exposes work_call as its sole generic business carrier', async () => {
  const task = prepareExactTask('Read the alpha source and write every record into a new report.');
  assert.equal(task.route, 'act');
  const capture: { params?: any } = {};
  sdk.setClaudeAgentSdkQueryForTest(((params: any) => {
    capture.params = params;
    return queryFromMessages(successMessages([
      'mcp__clementine-local__tool_search',
      'mcp__clementine-local__mcp_list_tools',
      'mcp__clementine-local__work_call',
    ]));
  }) as never);

  await sdk.runClaudeAgentSdk({
    prompt: 'Read the alpha source and write every record into a new report.',
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    trackerScopeId: `${task.sessionId}::claude-action`,
    modelId: 'claude-sonnet-4-6',
    agentic: true,
    directOrchestrator: true,
    allowedLocalMcpTools: ['memory_search', 'mcp_list_tools', 'run_shell_command'],
    mcpToolAllowlist: ['memory_search', 'mcp_list_tools', 'run_shell_command'],
    localMcpToolUniverse: ['memory_search', 'mcp_list_tools', 'run_shell_command', 'workflow_get'],
    nativeMcpToolScope: {
      authority: 'none', reason: 'test', allowedServerSlugs: [], maxTools: 0,
    },
  });

  const servers = capture.params.options.mcpServers as Record<string, any>;
  assert.deepEqual(Object.keys(servers), ['clementine-local'], 'act does not expose a second native business surface');
  const registered = servers['clementine-local'].instance._registeredTools as Record<string, any>;
  assert.ok(registered.work_call);
  assert.equal(registered.run_tool_program, undefined, 'the subtracted program surface never mounts');
  assert.ok(registered.tool_search);
  assert.ok(registered.mcp_list_tools, 'control/discovery remains first-class');
  // Lane parity (2026-08-20): the Codex action lane always had a control-only
  // dispatcher; the Claude lane did not, so deferred CONTROL/READ tools had no
  // direct door and every read paid work_call proposal grammar (live mobile
  // dashboard turn). call_tool now mounts in control+read-only mode — business
  // WRITES are still refused by the dispatcher and belong to work_call.
  assert.ok(registered.call_tool, 'the control/read-only dispatcher mounts beside the bound carrier');
  assert.match(
    String(registered.call_tool.description ?? ''),
    /cannot invoke business\/provider WRITES/,
    'the mounted dispatcher is the control+read-only carrier, not a second business surface',
  );
  // memory_search is a harness-STATE read (control role since 320b5947):
  // local recall must never burn work_call carrier attempts, so control
  // reads are first-class on act. World compute/writes remain business and
  // stay inner calls behind the bound carrier.
  assert.ok(registered.memory_search, 'control-role harness-state reads are first-class on act');
  assert.equal(registered.run_shell_command, undefined, 'business compute/writes are inner calls, not an unbound bypass');

  const searchedRead = await registered.tool_search.handler({ query: 'workflow_get', limit: 1 });
  const readSearchBody = JSON.parse(searchedRead.content[0].text) as {
    results: Array<{ name: string; carrier?: string }>;
    hint: string;
  };
  assert.equal(readSearchBody.results[0]?.name, 'workflow_get');
  assert.equal(
    readSearchBody.results[0]?.carrier,
    'call_tool',
    'Claude action discovery routes a registry read through the direct read/control carrier',
  );
  assert.match(readSearchBody.hint, /call_tool\(name, args_json\)/);

  const searched = await registered.tool_search.handler({ query: 'run_shell_command', limit: 1 });
  const searchBody = JSON.parse(searched.content[0].text) as {
    results: Array<{ name: string; carrier?: string }>;
    hint: string;
    brokerCoverage: string;
  };
  assert.equal(searchBody.results[0]?.carrier, 'work_call');
  assert.match(searchBody.hint, /inner name\/args_json of work_call/);
  assert.equal(searchBody.brokerCoverage, 'builtins_only',
    'an explicitly denied external scope cannot arm provider-backed role discovery');

  const workInput = {
    proposal: null,
    requirement_id: 'read-source',
    universe_item_id: null,
    universe_selector: null,
    name: 'run_shell_command',
    args_json: JSON.stringify({ command: 'echo gentle-work-needs-no-plan' }),
  };
  const uncorrelated = await registered.work_call.handler(workInput);
  assert.equal(uncorrelated.isError, true, 'handler entry without exact SDK admission fails closed');
  const uncorrelatedBody = JSON.parse(uncorrelated.content[0].text) as { error: string; dispatch_state: string };
  assert.equal(uncorrelatedBody.error, 'work_authority_unavailable');
  assert.equal(uncorrelatedBody.dispatch_state, 'not_started');

  const permission = await capture.params.options.canUseTool(
    'mcp__clementine-local__work_call',
    workInput,
    { signal: new AbortController().signal, toolUseID: 'toolu-semantic-work-refusal' },
  );
  assert.equal(permission.behavior, 'allow');
  // A MISSING PLAN NO LONGER BLOCKS GENTLE WORK. The frozen contract is
  // required where once-ness cannot be corrected — an irreversible effect —
  // and a reversible shell read is not that (the wall's remaining jurisdiction
  // is pinned in approved-mandate-admission.test.ts). Three live fan-out
  // workers spent whole budgets being refused for contract grammar and made
  // zero business calls before this boundary moved (2026-08-12).
  const admitted = await registered.work_call.handler(workInput);
  const admittedText = String(admitted.content[0].text ?? '');
  assert.doesNotMatch(admittedText, /work_contract_required/,
    'a gentle inner call is not refused for lacking a plan');
  const db = eventlog.openEventLog();
  const settlements = db.prepare(`
    SELECT outcome_kind, execution_kind FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
  `).all(task.sessionId, task.sourceUserSeq) as Array<{ outcome_kind: string; execution_kind: string }>;
  assert.equal(
    settlements.some((row) => row.execution_kind === 'refused_pre_dispatch'
      && row.outcome_kind === 'invalid_arguments'),
    false,
    'the contract grammar no longer produces a pre-dispatch refusal for gentle work',
  );
});

test('Claude accepted action reconciles background status and continues to work_call', async () => {
  const task = prepareExactTask(
    'Pull the top 5 Ventura restaurants, create a new Google Sheet, and email me the link.',
  );
  assert.equal(task.route, 'act');
  let interrupts = 0;
  sdk.setClaudeAgentSdkQueryForTest((() => {
    const messages: SDKMessage[] = [
      {
        type: 'system', subtype: 'init', model: 'claude-sonnet-4-6',
        session_id: 'sdk-action-status', uuid: 'sdk-action-status-init', apiKeySource: 'none',
        claude_code_version: '2.1.181', cwd: process.cwd(),
        tools: [
          'mcp__clementine-local__background_task_status',
          'mcp__clementine-local__work_call',
        ],
        mcp_servers: [{ name: 'clementine-local', status: 'connected' }],
        permissionMode: 'default', slash_commands: [], output_style: 'default', skills: [], plugins: [],
      } as SDKMessage,
      {
        type: 'assistant', session_id: 'sdk-action-status', uuid: 'sdk-action-status-assistant-1',
        parent_tool_use_id: null,
        message: { content: [{
          type: 'tool_use', id: 'toolu-stale-status',
          name: 'mcp__clementine-local__background_task_status',
          input: { id: 'bg-stale' },
        }] },
      } as SDKMessage,
      {
        type: 'user', session_id: 'sdk-action-status', uuid: 'sdk-action-status-result-1',
        parent_tool_use_id: null,
        message: { content: [{
          type: 'tool_result', tool_use_id: 'toolu-stale-status',
          content: '{"ok":true,"taskId":"bg-stale","status":"awaiting_input"}',
        }] },
      } as SDKMessage,
      {
        type: 'assistant', session_id: 'sdk-action-status', uuid: 'sdk-action-status-assistant-2',
        parent_tool_use_id: null,
        message: { content: [{
          type: 'tool_use', id: 'toolu-action-work',
          name: 'mcp__clementine-local__work_call',
          input: {
            proposal: null, requirement_id: 'source-restaurants', universe_item_id: null,
            universe_selector: null, name: 'APIFY_GET_DATASET_ITEMS', args_json: '{}',
          },
        }] },
      } as SDKMessage,
      {
        type: 'user', session_id: 'sdk-action-status', uuid: 'sdk-action-status-result-2',
        parent_tool_use_id: null,
        message: { content: [{
          type: 'tool_result', tool_use_id: 'toolu-action-work',
          content: '{"successful":true,"data":{"items":[{"name":"Restaurant A"}]}}',
        }] },
      } as SDKMessage,
      {
        type: 'result', subtype: 'success', session_id: 'sdk-action-status',
        uuid: 'sdk-action-status-done', result: 'Continued the accepted action after reconciliation.',
        duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 2,
        stop_reason: 'end_turn', total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
      } as SDKMessage,
    ];
    const query = queryFromMessages(messages);
    return Object.assign(query, { interrupt: async () => { interrupts += 1; } });
  }) as never);

  const result = await sdk.runClaudeAgentSdk({
    prompt: 'Pull the top 5 Ventura restaurants, create a new Google Sheet, and email me the link.',
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    trackerScopeId: `${task.sessionId}::claude-status-reconcile`,
    modelId: 'claude-sonnet-4-6',
    agentic: true,
    directOrchestrator: true,
    allowedLocalMcpTools: ['background_task_status', 'work_call'],
    mcpToolAllowlist: ['background_task_status', 'work_call'],
    localMcpToolUniverse: ['background_task_status', 'work_call'],
    nativeMcpToolScope: {
      authority: 'none', reason: 'test', allowedServerSlugs: [], maxTools: 0,
    },
  });

  assert.equal(interrupts, 0, 'status reconciliation cannot interrupt an accepted action');
  assert.deepEqual(result.toolUses, [
    'mcp__clementine-local__background_task_status',
    'mcp__clementine-local__work_call',
  ]);
  assert.equal(result.text, 'Continued the accepted action after reconciliation.');
});

test('Claude work_call resolves an exact authorized external MCP schema and lets the host read outrank binding-plan ambiguity', async () => {
  const mcpDir = path.join(TMP_HOME, 'mcp');
  const mcpFile = path.join(mcpDir, 'servers.json');
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(mcpFile, JSON.stringify({
    alpha: { type: 'stdio', command: 'never-spawned', enabled: true },
  }), 'utf8');
  mcpConfig.invalidateMcpServerDiscoveryCache();
  mcpServers.mcpServersTestHooks.resetCachesForTests();
  let providerCrossings = 0;
  const external: MCPServer = {
    name: 'alpha-exact-schema',
    cacheToolsList: false,
    async connect() {},
    async close() {},
    async invalidateToolsCache() {},
    async listTools() {
      return [{
        name: 'alpha__list_records',
        description: 'Read an exact accepted set.',
        inputSchema: {
          type: 'object',
          properties: {
            first: { type: 'array', items: { type: 'string' } },
            second: { type: 'array', items: { type: 'string' } },
          },
          required: ['first', 'second'],
        },
      }] as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool() {
      providerCrossings += 1;
      return [{ type: 'text', text: '{"never":"reached"}' }] as Awaited<ReturnType<MCPServer['callTool']>>;
    },
  } as MCPServer;
  const restore = mcpServers.mcpServersTestHooks.setServerShimResolverForTests(() => external);
  try {
    const objective = [
      'Read each of these records, then write every result into a new report:',
      '1. alpha',
      '2. beta',
      '3. gamma',
    ].join('\n');
    const task = prepareExactTask(objective);
    assert.equal(task.route, 'act');
    const capture: { params?: any } = {};
    sdk.setClaudeAgentSdkQueryForTest(((params: any) => {
      capture.params = params;
      return queryFromMessages(successMessages(['mcp__clementine-local__work_call']));
    }) as never);
    await sdk.runClaudeAgentSdk({
      prompt: objective,
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      trackerScopeId: `${task.sessionId}::external-schema`,
      agentic: true,
      directOrchestrator: true,
      allowedLocalMcpTools: ['mcp_list_tools'],
      localMcpToolUniverse: ['mcp_list_tools'],
      nativeMcpToolScope: {
        authority: 'server_set',
        reason: 'exact test server authority',
        allowedServerSlugs: ['alpha'],
        // Deliberately advertise zero tools. Exact named authority must still
        // resolve the callable schema from the connected server catalog.
        maxTools: 0,
      },
    });
    const registered = (capture.params.options.mcpServers['clementine-local']
      .instance._registeredTools) as Record<string, any>;
    const input = {
      proposal: {
        version: 1,
        operations: [
          {
            id: 'read-source',
            effect: 'read',
            coverage: 'accepted_set',
            dependsOn: [],
            dataFrom: [],
            cardinality: { kind: 'set', universeId: 'requested' },
          },
          {
            id: 'write-report',
            effect: 'external_write',
            coverage: null,
            dependsOn: ['read-source'],
            dataFrom: ['read-source'],
            cardinality: { kind: 'once' },
          },
        ],
        universes: [{ id: 'requested', seal: 'accepted_input', members: ['alpha', 'beta', 'gamma'] }],
      },
      requirement_id: 'read-source',
      universe_item_id: null,
      universe_selector: { argument_pointer: '/first', member_id_pointer: null },
      name: 'alpha__list_records',
      args_json: JSON.stringify({
        first: ['alpha', 'beta', 'gamma'],
        second: ['alpha', 'beta', 'gamma'],
      }),
    };
    const permission = await capture.params.options.canUseTool(
      'mcp__clementine-local__work_call',
      input,
      { signal: new AbortController().signal, toolUseID: 'toolu-exact-external-schema' },
    );
    assert.equal(permission.behavior, 'allow');
    const result = await registered.work_call.handler(input);
    const body = String(result.content[0].text ?? '');
    assert.match(body, /never.*reached/,
      'the exact uncapped external schema resolved and the host-classified read reached its provider');
    assert.doesNotMatch(body, /work_cardinality_mismatch|finite_selector_is_ambiguous/,
      'binding-plan ambiguity cannot veto an objectively non-mutating host call');
    assert.equal(providerCrossings, 1);
    const db = eventlog.openEventLog();
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM expected_work_call_bindings WHERE session_id = ? AND source_user_seq = ?`)
      .get(task.sessionId, task.sourceUserSeq) as { n: number }).n, 0,
    'the read dispatched without fabricating a binding from the ambiguous plan');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM logical_call_settlements WHERE session_id = ? AND source_user_seq = ?`)
      .get(task.sessionId, task.sourceUserSeq) as { n: number }).n, 1);
  } finally {
    restore();
    rmSync(mcpFile, { force: true });
    mcpConfig.invalidateMcpServerDiscoveryCache();
    mcpServers.mcpServersTestHooks.resetCachesForTests();
  }
});

test('malformed Claude work_call is denied once, settled once, and never dispatches', async () => {
  const task = prepareExactTask('Read the alpha source and write every record into a new report.');
  let firstPermission: any;
  let replayPermission: any;
  sdk.setClaudeAgentSdkQueryForTest(((params: any) => {
    const generator = (async function* () {
      yield successMessages(['mcp__clementine-local__work_call'])[0]!;
      const malformed = { proposal: null, name: 'run_shell_command', args_json: '{}' };
      const options = { signal: new AbortController().signal, toolUseID: 'toolu-malformed-work-call' };
      firstPermission = await params.options.canUseTool('mcp__clementine-local__work_call', malformed, options);
      replayPermission = await params.options.canUseTool('mcp__clementine-local__work_call', malformed, options);
      yield successMessages(['mcp__clementine-local__work_call'])[1]!;
    })();
    return Object.assign(generator, {
      close() {}, interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }), streamInput: async () => {},
      stopTask: async () => false, backgroundTasks: async () => false,
    }) as Query;
  }) as never);

  await sdk.runClaudeAgentSdk({
    prompt: 'Read the alpha source and write every record into a new report.',
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    trackerScopeId: `${task.sessionId}::malformed`,
    agentic: true,
    directOrchestrator: true,
    allowedLocalMcpTools: ['mcp_list_tools', 'run_shell_command'],
    localMcpToolUniverse: ['mcp_list_tools', 'run_shell_command'],
    nativeMcpToolScope: {
      authority: 'none', reason: 'test', allowedServerSlugs: [], maxTools: 0,
    },
  });

  assert.equal(firstPermission.behavior, 'deny');
  assert.deepEqual(replayPermission, firstPermission, 'repeated SDK permission callback reuses the one denial');
  const corrective = JSON.parse(firstPermission.message) as Record<string, unknown>;
  assert.equal(corrective.isError, true);
  assert.equal(corrective.ok, false);
  assert.equal(corrective.error, 'work_contract_invalid');
  assert.equal(corrective.dispatch_state, 'not_started');
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ? AND source_user_seq = ?`)
    .get(task.sessionId, task.sourceUserSeq) as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ?`)
    .get(task.sessionId, task.sourceUserSeq) as { n: number }).n, 1);
  const rows = db.prepare(`
    SELECT outcome_kind, execution_kind, logical_tool_call_id FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
  `).all(task.sessionId, task.sourceUserSeq) as Array<Record<string, unknown>>;
  assert.deepEqual(rows, [{
    outcome_kind: 'invalid_arguments',
    execution_kind: 'refused_pre_dispatch',
    logical_tool_call_id: 'toolu-malformed-work-call',
  }]);
});

test('Claude action worker admits and claims one exact work_call without direct-orchestrator authority', async () => {
  const task = prepareExactTask('Read the alpha source and write every record into a new report.');
  let permission: any;
  let admitted: any;
  let replay: any;
  const input = {
    proposal: null,
    requirement_id: 'read-source',
    universe_item_id: null,
    universe_selector: null,
    name: 'run_shell_command',
    args_json: JSON.stringify({ command: 'echo worker-correlation-admitted' }),
  };
  sdk.setClaudeAgentSdkQueryForTest(((params: any) => {
    const generator = (async function* () {
      yield successMessages(['mcp__clementine-local__work_call'])[0]!;
      permission = await params.options.canUseTool(
        'mcp__clementine-local__work_call',
        input,
        { signal: new AbortController().signal, toolUseID: 'toolu-worker-action-correlation' },
      );
      const registered = params.options.mcpServers['clementine-local']
        .instance._registeredTools as Record<string, any>;
      admitted = await registered.work_call.handler(input);
      yield {
        type: 'assistant', session_id: 'sdk-worker-action-correlation',
        uuid: 'sdk-worker-action-correlation-use', parent_tool_use_id: null,
        message: { content: [{
          type: 'tool_use', id: 'toolu-worker-action-correlation',
          name: 'mcp__clementine-local__work_call', input,
        }] },
      } as SDKMessage;
      yield {
        type: 'user', session_id: 'sdk-worker-action-correlation',
        uuid: 'sdk-worker-action-correlation-result', parent_tool_use_id: null,
        message: { content: [{
          type: 'tool_result', tool_use_id: 'toolu-worker-action-correlation',
          content: String(admitted?.content?.[0]?.text ?? ''),
        }] },
      } as SDKMessage;
      replay = await registered.work_call.handler(input);
      yield successMessages(['mcp__clementine-local__work_call'])[1]!;
    })();
    return Object.assign(generator, {
      close() {}, interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }), streamInput: async () => {},
      stopTask: async () => false, backgroundTasks: async () => false,
    }) as Query;
  }) as never);

  const result = await sdk.runClaudeAgentSdk({
    prompt: 'Read the alpha source and write every record into a new report.',
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    trackerScopeId: `${task.sessionId}::missing-correlation`,
    agentic: true,
    workerScope: true,
    // A worker is not the conversational orchestrator. Its work_call authority
    // comes from the exact persisted action source, not from this lane label.
    directOrchestrator: false,
    allowedLocalMcpTools: ['mcp_list_tools', 'run_shell_command'],
    localMcpToolUniverse: ['mcp_list_tools', 'run_shell_command'],
    nativeMcpToolScope: {
      authority: 'none', reason: 'test', allowedServerSlugs: [], maxTools: 0,
    },
  });

  assert.equal(permission.behavior, 'allow');
  assert.notEqual(admitted?.isError, true, 'the exact admitted worker call reaches its inner read/compute once');
  assert.match(String(admitted?.content?.[0]?.text ?? ''), /worker-correlation-admitted/);
  assert.equal(replay?.isError, true, 'one permission marker cannot authorize a second handler entry');
  const replayBody = JSON.parse(String(replay.content[0].text)) as Record<string, unknown>;
  assert.equal(replayBody.error, 'work_authority_unavailable');
  assert.equal(replayBody.dispatch_state, 'not_started');
  const db = eventlog.openEventLog();
  const admissions = eventlog.listEvents(task.sessionId, { types: ['claude_local_permission_admitted'] });
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0]?.data.actionExpectedWork, true);
  assert.equal(admissions[0]?.data.directOrchestrator, false);
  assert.deepEqual(result.toolUses, ['mcp__clementine-local__work_call']);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['tool_called'] }).filter((event) =>
    event.data.accounting === 'top_level'
    && event.data.callId === 'toolu-worker-action-correlation').length, 1,
  'the later SDK frame reuses the handler-authored canonical occurrence');
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, 'toolu-worker-action-correlation') as { n: number }).n, 1);

  assert.equal(claudeLocalCorrelation.recordClaudeLocalPermissionAdmission({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    runScopeId: `${task.sessionId}::worker:legacy-composio`,
    providerCallId: 'toolu-worker-legacy-composio',
    sdkToolName: 'mcp__clementine-local__composio_execute_tool',
    input: { tool_slug: 'APIFY_ACTOR_RUNS_GET', arguments: '{}' },
    directOrchestrator: false,
    actionExpectedWork: true,
  }), null, 'action authority must not widen the legacy direct-orchestrator-only Composio bridge');
});

test('Claude worker cannot register work_call without persisted action authority', async () => {
  const task = prepareExactTask('Read the alpha source and write every record into a new report.', false);
  assert.equal(task.route, 'act');
  assert.notEqual(actionAdmission.actionExpectedWorkState(task).status, 'required');
  await assert.rejects(
    sdk.runClaudeAgentSdk({
      prompt: 'Read the alpha source and write every record into a new report.',
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      trackerScopeId: `${task.sessionId}::worker:no-action-authority`,
      agentic: true,
      workerScope: true,
      directOrchestrator: false,
      allowedLocalMcpTools: ['mcp_list_tools', 'run_shell_command'],
      localMcpToolUniverse: ['mcp_list_tools', 'run_shell_command'],
      nativeMcpToolScope: {
        authority: 'none', reason: 'test', allowedServerSlugs: [], maxTools: 0,
      },
    }),
    /action expected-work activation conflict/,
    'an act-classified source cannot construct any worker business surface before durable activation',
  );
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['claude_local_permission_admitted'] }).length, 0);
});

test('Claude action terminal uses one sealed repair and publishes blocked when exact work remains unverified', async () => {
  const sessionId = 'claude-action-terminal-presentation-repair';
  const request = 'Read the alpha source and write every record into a new report.';
  eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'desktop' });
  let initialCalls = 0;
  brain.setClaudeAgentSdkBrainRunForTest(async (options) => {
    initialCalls += 1;
    assert.ok(options.sourceUserSeq);
    const frozen = expectedWork.freezeActionExpectedWorkContract({
      sessionId,
      sourceUserSeq: options.sourceUserSeq!,
      proposal: {
        version: 1,
        operations: [
          {
            id: 'read-source', effect: 'read', coverage: 'single',
            dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
          },
          {
            id: 'write-report', effect: 'external_write',
            dependsOn: ['read-source'], dataFrom: ['read-source'], cardinality: { kind: 'once' },
          },
        ],
        universes: [],
      },
    });
    assert.ok(
      frozen.status === 'fixed' || frozen.status === 'replayed',
      JSON.stringify(frozen),
    );
    return {
      text: 'Done — the report is ready.',
      sessionId: 'sdk-action-terminal',
      model: 'claude-sonnet-test',
      toolUses: [],
      stoppedReason: 'success',
    };
  });
  let repairCalls = 0;
  let repairPacket: terminalRepair.TerminalPresentationRepairPacketV1 | undefined;
  brain.setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest({
    async render(packet) {
      repairCalls += 1;
      repairPacket = packet;
      return 'I can\'t verify that the report was written yet. I can resume with the source read and report write.';
    },
  });

  const response = await brain.respondViaClaudeAgentSdkBrain('home', {
    message: request,
    sessionId,
    channel: 'desktop',
  });

  assert.equal(initialCalls, 1, 'presentation repair does not re-enter the action SDK surface');
  assert.equal(repairCalls, 1);
  assert.equal(repairPacket?.acceptedRequest, request);
  // NOT 'awaiting-input': a repaired terminal asks the user nothing. Reusing
  // the clarifying-question reason made a background worker park on "I
  // haven't been able to verify the result yet" AS ITS QUESTION — it idled 45
  // minutes and then intercepted the next attempt at the same work (live
  // 2026-08-12). The public terminal stays `blocked`, asserted below.
  assert.equal(response.stoppedReason, 'unverified');
  assert.equal(response.text, 'I can\'t verify that the report was written yet. I can resume with the source read and report write.');
  const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.equal(terminal?.data.turnOutcome?.status, 'blocked');
  assert.equal(terminal?.data.presentation?.status, 'blocked');
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?
  `).get(sessionId) as { n: number }).n, 0, 'repair exposes no tool/provider dispatch surface');
});

test('Claude direct terminal stays byte-identical and spends no presentation repair', async () => {
  const sessionId = 'claude-direct-terminal-no-presentation-repair';
  const reply = 'Hey — it’s genuinely good to hear from you.';
  eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'desktop' });
  let capturedAllowedLocalTools: string[] | undefined;
  let capturedMcpToolAllowlist: string[] | undefined;
  let capturedLocalToolUniverse: string[] | undefined;
  let capturedRequiredLocalTools: string[] | undefined;
  let capturedNativeScope: { maxTools?: number; allowedServerSlugs?: string[] } | undefined;
  brain.setClaudeAgentSdkBrainRunForTest(async (options) => {
    capturedAllowedLocalTools = options.allowedLocalMcpTools;
    capturedMcpToolAllowlist = options.mcpToolAllowlist;
    capturedLocalToolUniverse = options.localMcpToolUniverse;
    capturedRequiredLocalTools = options.requiredLocalMcpTools;
    capturedNativeScope = options.nativeMcpToolScope;
    return {
      text: reply,
      sessionId: 'sdk-direct-terminal',
      model: 'claude-sonnet-test',
      toolUses: [],
      stoppedReason: 'success',
    };
  });
  let repairCalls = 0;
  brain.setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest({
    async render() {
      repairCalls += 1;
      return 'This must never replace a direct conversational response.';
    },
  });

  const response = await brain.respondViaClaudeAgentSdkBrain('home', {
    message: 'Hello Clementine',
    sessionId,
    channel: 'desktop',
  });

  assert.equal(response.text, reply);
  assert.equal(response.stoppedReason, 'success');
  assert.equal(repairCalls, 0);
  assert.deepEqual(capturedAllowedLocalTools, [], 'an admitted direct reply carries no local tool authority');
  assert.deepEqual(capturedMcpToolAllowlist, [], 'an admitted direct reply registers no local schemas');
  assert.deepEqual(capturedLocalToolUniverse, [], 'an admitted direct reply has no deferred dispatcher universe');
  assert.deepEqual(capturedRequiredLocalTools, [], 'an admitted direct reply requires no tool sentinel');
  assert.equal(capturedNativeScope?.maxTools, 0, 'an admitted direct reply carries no native MCP authority');
  assert.deepEqual(capturedNativeScope?.allowedServerSlugs, []);
});

test('direct and retrieve sources do not gain the action carrier', async () => {
  for (const [text, route] of [
    ['Hello', 'direct_reply'],
    ['Summarize the notes about project alpha.', 'retrieve'],
  ] as const) {
    const task = prepareExactTask(text);
    assert.equal(task.route, route);
    assert.equal(sdk.claudeActionExpectedWorkRequired(task), false);
    const servers = sdk.buildClaudeAgentSdkLocalMcpServers(
      task.sessionId,
      true,
      ['memory_search'],
      { sourceUserSeq: task.sourceUserSeq, directOrchestrator: true },
    );
    const registered = (servers['clementine-local'] as any).instance._registeredTools as Record<string, unknown>;
    assert.equal(registered.work_call, undefined);
  }
});
