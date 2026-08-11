import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tool } from '@openai/agents';
import { z } from 'zod';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-discovery-boundary-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const eventlog = await import('./eventlog.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const { discoveryGovernor } = await import('./discovery-governor.js');
const {
  DiscoveryBudgetDeniedError,
  admitDiscoveryBoundary,
  classifyDiscoveryCall,
  isClaudeParentDiscoverySurface,
  settleDiscoveryBoundary,
} = await import('./discovery-boundary.js');
const {
  ToolCallsCounter,
  withHarnessRunContext,
  wrapToolForHarness,
} = await import('./brackets.js');
const {
  _setExternalMcpToolsForTests,
  dispatchCodeModeTool,
} = await import('../../tools/code-mode-tool.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function acceptedTask(label: string, knownCapability = false): { sessionId: string; sourceUserSeq: number } {
  const session = eventlog.createSession({ id: `boundary-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: label },
  });
  // The settlement spine refuses wrapped dispatch without an accepted source
  // AND a persisted turn graph — anchor both for every fixture task.
  const shadow = recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
  });
  assert.ok(shadow, 'fixture persisted the turn graph for the accepted task');
  discoveryGovernor.initializeTask({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    knownCapability,
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

test('classifies broad discovery across provider and MCP transport spellings', () => {
  // A broad search carries no subject: one requirement shopped across wordings
  // and providers must not be able to buy itself a second budget.
  for (const [name, input, surface] of [
    ['ToolSearch', { query: 'find a tool that can inspect my workspace' }, 'tool_search'],
    ['mcp__clementine-local__tool_search', { query: 'find a tool that can inspect my workspace' }, 'tool_search'],
    ['composio_search_tools', { query: 'outlook list unread messages' }, 'composio_search_tools'],
    ['mcp__clementine-local__composio_list_tools', { toolkit_slug: 'outlook' }, 'composio_list_tools'],
    ['mcp_list_tools', { server: 'dataforseo', query: 'keyword volume' }, 'mcp_list_tools'],
    ['local_cli_list', { filter: 'gh' }, 'local_cli_list'],
    ['clem.listTools', undefined, 'code_mode_list_tools'],
  ] as const) {
    assert.deepEqual(classifyDiscoveryCall(name, input), {
      category: 'broad_discovery',
      subject: '',
      surface,
    });
  }
});

test('classifies exact schema refreshes without charging ordinary status or carriers', () => {
  for (const [name, input, surface, subject] of [
    // Canonical identity: prose, select:, quotes and the mcp__ carrier all
    // resolve to the one tool the lookup is actually about.
    ['tool_search', { query: 'show me the workspace_roots schema' }, 'tool_search', 'workspace_roots'],
    ['ToolSearch', { query: 'select:mcp__dataforseo__serp_organic_live' }, 'tool_search', 'dataforseo__serp_organic_live'],
    ['composio_search_tools', { query: 'OUTLOOK_LIST_MESSAGES' }, 'composio_search_tools', 'outlook_list_messages'],
    ['local_cli_probe', { command: 'gh' }, 'local_cli_probe', 'gh'],
    ['composio_execute_tool', { tool_slug: 'SALESFORCE_DESCRIBE_SOBJECT', arguments: '{}' }, 'provider_describe_slug', 'salesforce_describe_sobject'],
    ['mcp__clementine-local__cx_airtable_get_base_schema', { base_id: 'x' }, 'provider_describe_slug', 'airtable_get_base_schema'],
    ['clem.describe', 'read_file', 'code_mode_describe', 'read_file'],
  ] as const) {
    assert.deepEqual(classifyDiscoveryCall(name, input), {
      category: 'exact_schema_refresh',
      subject,
      surface,
    });
  }

  assert.equal(classifyDiscoveryCall('composio_status', {}), null);
  assert.equal(classifyDiscoveryCall('mcp_status', {}), null);
  assert.equal(classifyDiscoveryCall('call_tool', {
    name: 'tool_search',
    args_json: '{"query":"workspace_roots"}',
  }), null);
  assert.equal(classifyDiscoveryCall('composio_execute_tool', {
    tool_slug: 'OUTLOOK_LIST_MESSAGES',
  }), null);
});

test('Claude parent predicate excludes Composio statics already charged by inner wraps', () => {
  assert.equal(isClaudeParentDiscoverySurface('ToolSearch', { query: 'find a calendar tool' }), true);
  assert.equal(isClaudeParentDiscoverySurface('mcp__clementine-local__local_cli_probe', { command: 'gh' }), true);
  assert.equal(isClaudeParentDiscoverySurface('mcp__clementine-local__composio_search_tools', { query: 'calendar' }), false);
  assert.equal(isClaudeParentDiscoverySurface('composio_execute_tool', { tool_slug: 'AIRTABLE_GET_BASE_SCHEMA' }), false);
  assert.equal(isClaudeParentDiscoverySurface('cx_airtable_get_base_schema', {}), true);
});

test('boundary bypasses legacy callers without accepted task identity', () => {
  assert.equal(admitDiscoveryBoundary({
    sessionId: 'legacy',
    toolName: 'tool_search',
    input: { query: 'find a calendar tool' },
    callId: 'legacy-1',
  }), null);
});

test('one physical broad call is admitted, settled, replay-safe, and a second is softly denied', () => {
  const key = acceptedTask('novel');
  const first = admitDiscoveryBoundary({
    ...key,
    turn: 1,
    attemptId: 'attempt-novel',
    toolName: 'composio_search_tools',
    input: { query: 'outlook list unread mail' },
    callId: 'provider-broad-1',
  });
  assert.ok(first);
  assert.equal(first.category, 'broad_discovery');
  assert.equal(first.replay, false);
  settleDiscoveryBoundary(first, 'succeeded');
  const settled = eventlog.listEvents(key.sessionId, { types: ['discovery_governor_outcome'] }).at(-1);
  assert.equal(settled?.turn, 1);
  assert.equal(settled?.data.sourceUserSeq, key.sourceUserSeq);
  assert.equal(settled?.data.attemptId, 'attempt-novel');
  assert.equal(settled?.data.recorded, true);
  assert.equal(settled?.data.reason, 'outcome_recorded');

  const replay = admitDiscoveryBoundary({
    ...key,
    toolName: 'composio_search_tools',
    input: { query: 'outlook list unread mail' },
    callId: 'provider-broad-1',
  });
  assert.equal(replay?.replay, true);

  assert.throws(() => admitDiscoveryBoundary({
    ...key,
    toolName: 'local_cli_list',
    input: { filter: 'gh' },
    callId: 'provider-broad-2',
  }), (error: unknown) => {
    assert.ok(error instanceof DiscoveryBudgetDeniedError);
    assert.equal(error.reason, 'category_budget_exhausted');
    assert.match(error.message, /do not issue another broad search/i);
    return true;
  });

  assert.equal(
    discoveryGovernor.getTaskState(key)?.claims.broad_discovery?.outcome,
    'succeeded',
  );
});

test('known tasks deny broad discovery but retain one exact schema refresh', () => {
  const key = acceptedTask('known', true);
  assert.throws(() => admitDiscoveryBoundary({
    ...key,
    toolName: 'tool_search',
    input: { query: 'find a workspace inspection tool' },
    callId: 'known-broad',
  }), DiscoveryBudgetDeniedError);

  const exact = admitDiscoveryBoundary({
    ...key,
    toolName: 'tool_search',
    input: { query: 'workspace_roots' },
    callId: 'known-exact',
  });
  assert.ok(exact);
  settleDiscoveryBoundary(exact, 'timed_out', 'provider_timeout');

  const state = discoveryGovernor.getTaskState(key);
  // The attempt is durably settled for audit...
  assert.equal(
    state?.allClaims.find((claim) => claim.category === 'exact_schema_refresh')?.outcome,
    'timed_out',
  );
  // A timeout is transient: the right recovery is to retry THIS call, not to
  // conclude the candidate was wrong and go looking for another one. So the
  // epoch is unchanged and the identical call may replay.
  assert.equal(state?.policy.epoch, 0);
  const retry = admitDiscoveryBoundary({
    ...key,
    toolName: 'tool_search',
    input: { query: 'workspace_roots' },
    callId: 'known-exact',
  });
  assert.equal(retry?.replay, true, 'a timed-out call is retryable as itself');
});

test('execute-only discovery stays conservatively charged and denies before a second provider call', async () => {
  const key = acceptedTask('wrapped');
  let providerCalls = 0;
  let claimObservedInsideExecute = false;
  const wrapped = wrapToolForHarness({
    name: 'composio_search_tools',
    execute: async () => {
      providerCalls += 1;
      claimObservedInsideExecute = Boolean(
        discoveryGovernor.getTaskState(key)?.claims.broad_discovery,
      );
      return 'provider result';
    },
  });
  const ctx = { ...key, counter: new ToolCallsCounter(10) };

  const first = await withHarnessRunContext(ctx, () => wrapped.execute!({ query: 'outlook unread mail' }));
  assert.equal(first, 'provider result');
  assert.equal(claimObservedInsideExecute, true);
  const second = await withHarnessRunContext(ctx, () => wrapped.execute!({ query: 'gmail unread mail' }));
  assert.equal(providerCalls, 1);
  assert.match(String(second), /^Tool call refused by harness: discovery budget denied/);
  assert.equal(
    discoveryGovernor.getTaskState(key)?.claims.broad_discovery?.outcome,
    'succeeded',
  );
});

test('SDK-local validation is free, then the first validated discovery is atomically charged before execute', async () => {
  const key = acceptedTask('sdk-validation-before-admission');
  let providerCalls = 0;
  let claimObservedInsideExecute = false;
  const wrapped = wrapToolForHarness(tool({
    name: 'composio_search_tools',
    description: 'focused discovery admission fixture',
    parameters: z.object({ query: z.string().min(1) }),
    execute: async ({ query }) => {
      providerCalls += 1;
      claimObservedInsideExecute =
        discoveryGovernor.getTaskState(key)?.claims.broad_discovery?.callId === 'sdk-valid';
      return `provider result for ${query}`;
    },
  }));
  const ctx = { ...key, counter: new ToolCallsCounter(10) };
  const invoke = (rawInput: string, callId: string) => withHarnessRunContext(
    ctx,
    () => wrapped.invoke(
      undefined as never,
      rawInput,
      { toolCall: { callId } } as never,
    ),
  );

  const malformed = await invoke('{', 'sdk-malformed');
  assert.match(String(malformed), /invalid|error/i);
  assert.equal(providerCalls, 0);
  assert.equal(discoveryGovernor.getTaskState(key)?.claims.broad_discovery, undefined);

  const schemaInvalid = await invoke(JSON.stringify({ query: '' }), 'sdk-schema-invalid');
  assert.match(String(schemaInvalid), /invalid|error/i);
  assert.equal(providerCalls, 0);
  assert.equal(discoveryGovernor.getTaskState(key)?.claims.broad_discovery, undefined);

  const valid = await invoke(JSON.stringify({ query: 'outlook unread mail' }), 'sdk-valid');
  assert.equal(valid, 'provider result for outlook unread mail');
  assert.equal(providerCalls, 1);
  assert.equal(claimObservedInsideExecute, true, 'the durable claim must predate execute/provider code');
  assert.equal(
    discoveryGovernor.getTaskState(key)?.claims.broad_discovery?.outcome,
    'succeeded',
  );

  const denied = await invoke(JSON.stringify({ query: 'gmail unread mail' }), 'sdk-extra');
  assert.match(String(denied), /^Tool call refused by harness: discovery budget denied/);
  assert.equal(providerCalls, 1, 'a denied validated call must not enter execute/provider code');
  assert.equal(ctx.counter.calls, 4, 'ordinary tool-attempt accounting is unchanged');
});

test('wrapped discovery timeout settles the durable claim as timed_out', async () => {
  const key = acceptedTask('wrapped-timeout');
  const wrapped = wrapToolForHarness({
    name: 'composio_search_tools',
    execute: async () => new Promise((resolve) => setTimeout(() => resolve('late'), 40)),
  }, { timeoutMs: 5 });

  const result = await withHarnessRunContext(
    { ...key, counter: new ToolCallsCounter(10) },
    () => wrapped.execute!({ query: 'outlook unread mail' }),
  );
  assert.match(String(result), /time budget|timed out/i);
  const state = discoveryGovernor.getTaskState(key);
  assert.equal(
    state?.allClaims.find((claim) => claim.category === 'broad_discovery')?.outcome,
    'timed_out',
  );
  // Transient, so the slot stays where it is and the same call can be retried.
  assert.equal(state?.policy.epoch, 0);
});

test('code-mode describe local validation does not consume the corrected schema-refresh call', async () => {
  const key = acceptedTask('code-mode-invalid-describe');
  let inventoryReads = 0;
  _setExternalMcpToolsForTests(async () => {
    inventoryReads += 1;
    return [{
      name: 'dataforseo__serp',
      description: 'search',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    }];
  });
  const ctx = { ...key, counter: new ToolCallsCounter(10) };
  try {
    const invalid = await withHarnessRunContext(
      ctx,
      () => dispatchCodeModeTool('describe', undefined, key.sessionId, ctx.counter),
    ) as { error?: string };
    assert.match(invalid.error ?? '', /pass a tool name string/i);
    assert.equal(inventoryReads, 0);
    assert.equal(discoveryGovernor.getTaskState(key)?.claims.exact_schema_refresh, undefined);

    const described = await withHarnessRunContext(
      ctx,
      () => dispatchCodeModeTool('describe', 'dataforseo__serp', key.sessionId, ctx.counter),
    ) as { parameters?: unknown };
    assert.ok(described.parameters);
    assert.equal(inventoryReads, 1);
    assert.equal(
      discoveryGovernor.getTaskState(key)?.claims.exact_schema_refresh?.outcome,
      'succeeded',
    );
  } finally {
    _setExternalMcpToolsForTests(null);
  }
});

test('code-mode listTools and describe share the same broad/exact task slots', async () => {
  const key = acceptedTask('code-mode-helpers');
  let inventoryReads = 0;
  _setExternalMcpToolsForTests(async () => {
    inventoryReads += 1;
    return [{
      name: 'dataforseo__serp',
      description: 'search',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    }];
  });
  const ctx = { ...key, counter: new ToolCallsCounter(10) };
  try {
    const listed = await withHarnessRunContext(
      ctx,
      () => dispatchCodeModeTool('listTools', undefined, key.sessionId, ctx.counter),
    ) as { mcp: unknown[] };
    assert.equal(listed.mcp.length, 1);

    const described = await withHarnessRunContext(
      ctx,
      () => dispatchCodeModeTool('describe', 'dataforseo__serp', key.sessionId, ctx.counter),
    ) as { parameters?: unknown };
    assert.ok(described.parameters);
    assert.equal(inventoryReads, 2);

    await assert.rejects(
      withHarnessRunContext(
        ctx,
        () => dispatchCodeModeTool('listTools', undefined, key.sessionId, ctx.counter),
      ),
      DiscoveryBudgetDeniedError,
    );
    await assert.rejects(
      withHarnessRunContext(
        ctx,
        () => dispatchCodeModeTool('describe', 'dataforseo__serp', key.sessionId, ctx.counter),
      ),
      DiscoveryBudgetDeniedError,
    );
    assert.equal(inventoryReads, 2, 'denied helper calls never touch provider inventory');
  } finally {
    _setExternalMcpToolsForTests(null);
  }
});
