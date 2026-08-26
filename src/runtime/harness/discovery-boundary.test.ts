import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

async function invokeWrappedDiscoveryInFreshProcess(input: {
  key: { sessionId: string; sourceUserSeq: number };
  callId: string;
  markerPath: string;
}): Promise<{ callId: string; providerRan: boolean; result: string }> {
  const code = `
    const { appendFileSync } = await import('node:fs');
    const { tool } = await import('@openai/agents');
    const { z } = await import('zod');
    const { ToolCallsCounter, withHarnessRunContext, wrapToolForHarness } =
      await import(process.env.CLEM_BRACKETS_MODULE_URL);
    const eventlog = await import(process.env.CLEM_EVENTLOG_MODULE_URL);
    const key = JSON.parse(process.env.CLEM_DISCOVERY_TASK_KEY);
    const callId = process.env.CLEM_DISCOVERY_CALL_ID;
    let providerRan = false;
    const wrapped = wrapToolForHarness(tool({
      name: 'tool_search',
      description: 'cross-process discovery authority fixture',
      parameters: z.object({
        query: z.string().min(1),
        role_key: z.string().min(1),
      }),
      execute: async () => {
        providerRan = true;
        appendFileSync(process.env.CLEM_PROVIDER_MARKER, callId + '\\n', 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 'provider-result:' + callId;
      },
    }));
    let result;
    try {
      result = await withHarnessRunContext(
        { ...key, turn: 1, counter: new ToolCallsCounter(20) },
        () => wrapped.invoke(
          undefined,
          JSON.stringify({ query: 'find the source records', role_key: 'clause-0:read' }),
          { toolCall: { callId } },
        ),
      );
    } catch (error) {
      result = 'threw:' + (error?.name ?? 'Error') + ':' + (error?.message ?? String(error));
    }
    eventlog.closeEventLog();
    process.stdout.write(JSON.stringify({ callId, providerRan, result: String(result) }));
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', code],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLEMENTINE_HOME: TMP_HOME,
        CLEM_BRACKETS_MODULE_URL: pathToFileURL(path.resolve('src/runtime/harness/brackets.ts')).href,
        CLEM_EVENTLOG_MODULE_URL: pathToFileURL(path.resolve('src/runtime/harness/eventlog.ts')).href,
        CLEM_DISCOVERY_TASK_KEY: JSON.stringify(input.key),
        CLEM_DISCOVERY_CALL_ID: input.callId,
        CLEM_PROVIDER_MARKER: input.markerPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const [exitCode] = await once(child, 'close') as [number | null];
  assert.equal(exitCode, 0, stderr);
  return JSON.parse(stdout) as { callId: string; providerRan: boolean; result: string };
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
    ['clem.listTools', undefined, 'catalog_list_tools'],
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
    ['clem.describe', 'read_file', 'catalog_describe', 'read_file'],
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

test('one physical broad call settles; repeat ids are typed pre-dispatch denials', () => {
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

  assert.throws(
    () => admitDiscoveryBoundary({
      ...key,
      toolName: 'composio_search_tools',
      input: { query: 'outlook list unread mail' },
      callId: 'provider-broad-1',
    }),
    (error: unknown) => error instanceof DiscoveryBudgetDeniedError
      && error.reason === 'same_call_replay',
  );

  assert.throws(
    () => admitDiscoveryBoundary({
      ...key,
      toolName: 'local_cli_list',
      input: { filter: 'gh' },
      callId: 'provider-broad-2',
    }),
    (error: unknown) => error instanceof DiscoveryBudgetDeniedError
      && error.reason === 'new_call_requires_retry_epoch',
  );

  assert.equal(
    discoveryGovernor.getTaskState(key)?.claims.broad_discovery?.outcome,
    'succeeded',
  );
});

test('known tasks retain one bounded broad discovery and one exact schema refresh', () => {
  const key = acceptedTask('known', true);
  const broad = admitDiscoveryBoundary({
    ...key,
    toolName: 'tool_search',
    input: { query: 'find a workspace inspection tool' },
    callId: 'known-broad',
  });
  assert.ok(broad);
  settleDiscoveryBoundary(broad, 'succeeded');

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
  // A timeout alone does not prove the candidate wrong or authorize another
  // provider body. The epoch stays closed until typed host evidence opens it;
  // an upstream durable-result cache may still answer the old id without I/O.
  assert.equal(state?.policy.epoch, 0);
  assert.throws(
    () => admitDiscoveryBoundary({
      ...key,
      toolName: 'tool_search',
      input: { query: 'workspace_roots' },
      callId: 'known-exact',
    }),
    (error: unknown) => error instanceof DiscoveryBudgetDeniedError
      && error.reason === 'same_call_replay',
    'a retry cannot re-enter the provider unless an upstream cache returns first',
  );
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
  // A second, different physical id is a new provider authorization even when
  // it maps to the same durable subject. It is refused before execute.
  const second = await withHarnessRunContext(ctx, () => wrapped.execute!({ query: 'gmail unread mail' }));
  assert.equal(providerCalls, 1, 'the second search must not re-enter provider code');
  assert.match(String(second), /new_call_requires_retry_epoch/);
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

  await assert.rejects(
    () => invoke(JSON.stringify({ query: 'outlook unread mail' }), 'sdk-valid'),
    /logical call is already settled/i,
  );
  assert.equal(providerCalls, 1, 'the exact same call id cannot re-enter provider code');

  // A further valid search under a different id also lacks provider authority
  // until the runtime opens a typed evidence epoch.
  const extra = await invoke(JSON.stringify({ query: 'gmail unread mail' }), 'sdk-extra');
  assert.match(String(extra), /new_call_requires_retry_epoch/);
  assert.equal(providerCalls, 1, 'only the first validated search reaches provider code');
  assert.equal(ctx.counter.calls, 4, 'the earlier logical replay denial does not spend a tool attempt');
});

test('wrapped discovery elects one provider body across processes and restart until a typed epoch opens', async () => {
  const key = acceptedTask('cross-process-provider-body');
  discoveryGovernor.initializeRoles({
    ...key,
    requirements: [{
      roleKey: 'clause-0:read',
      clauseIndex: 0,
      text: 'find the source records',
      resolved: false,
    }],
    brokerCoverage: 'authorized_external_v1',
  });
  const markerPath = path.join(TMP_HOME, 'discovery-provider-bodies.log');
  const racedCallIds = [
    'cross-process-shared',
    'cross-process-shared',
    'cross-process-distinct-1',
    'cross-process-distinct-2',
    'cross-process-distinct-3',
    'cross-process-distinct-4',
  ];
  const raced = await Promise.all(
    racedCallIds.map((callId) => invokeWrappedDiscoveryInFreshProcess({
      key,
      callId,
      markerPath,
    })),
  );
  const winner = raced.find((result) => result.providerRan);
  assert.ok(winner, 'one process must own provider authority');
  assert.equal(raced.filter((result) => result.providerRan).length, 1);
  assert.equal(
    readFileSync(markerPath, 'utf8').trim().split('\n').filter(Boolean).length,
    1,
    'the shared provider body ran exactly once',
  );
  assert.equal(
    raced.filter((result) => !result.providerRan)
      .every((result) => /same_call_replay|new_call_requires_retry_epoch|logical call is already settled/i.test(result.result)),
    true,
  );

  const sameIdAfterRestart = await invokeWrappedDiscoveryInFreshProcess({
    key,
    callId: winner.callId,
    markerPath,
  });
  const newIdAfterRestart = await invokeWrappedDiscoveryInFreshProcess({
    key,
    callId: 'post-restart-distinct',
    markerPath,
  });
  assert.equal(sameIdAfterRestart.providerRan, false);
  assert.match(sameIdAfterRestart.result, /logical call is already settled/i);
  assert.equal(newIdAfterRestart.providerRan, false);
  assert.match(newIdAfterRestart.result, /new_call_requires_retry_epoch/);
  assert.equal(readFileSync(markerPath, 'utf8').trim().split('\n').filter(Boolean).length, 1);

  assert.equal(discoveryGovernor.recordEvidence({
    ...key,
    kind: 'candidate_unsupported',
    detail: 'typed execution settlement rejected the selected candidate',
  }).outcome, 'epoch_opened');
  const authorizedRetry = await invokeWrappedDiscoveryInFreshProcess({
    key,
    callId: 'typed-epoch-1',
    markerPath,
  });
  assert.equal(authorizedRetry.providerRan, true);
  assert.equal(readFileSync(markerPath, 'utf8').trim().split('\n').filter(Boolean).length, 2);

  const state = discoveryGovernor.getTaskState(key);
  assert.deepEqual(state?.allClaims.map((claim) => claim.outcome), ['succeeded', 'succeeded']);
  const recordedOutcomes = eventlog.listEvents(key.sessionId, {
    types: ['discovery_governor_outcome'],
  }).filter((event) => event.data.recorded === true);
  assert.deepEqual(
    recordedOutcomes.map((event) => event.data.callId).sort(),
    [winner.callId, 'typed-epoch-1'].sort(),
    'every admitted provider body has one exact durable settlement',
  );
  assert.equal(existsSync(markerPath), true);
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
  // Timeout alone does not open a new provider-authority epoch.
  assert.equal(state?.policy.epoch, 0);
});

// ─── A refusal must name the value that would satisfy it ─────────────────────
//
// The role-scoped denial told callers to "use the exact unresolved role_key
// shown in the current capability card". That is only followable while the card
// is still in view; a caller that has lost it must guess a host-owned
// identifier, and every wrong guess is refused again under a different reason
// (role_required -> role_not_unresolved -> role_resolved). Measured on the real
// home: 27 role-key refusals across 50 discovery denials.
//
// This file already records the same lesson from 2026-08-14 — "THE DENIAL IS
// CORRECT; THE OLD INSTRUCTION WAS NOT FOLLOWABLE HERE" — which named the right
// door but still not the right key.
test('a role-scoped discovery denial names the admissible role keys', () => {
  const denial = new DiscoveryBudgetDeniedError(
    'broad_discovery',
    'tool_search',
    'role_required',
    ['clause-0:write', 'clause-0:unknown'],
  );
  assert.match(denial.message, /clause-0:write/, 'the caller must be told what it may cite');
  assert.match(denial.message, /clause-0:unknown/);
});

test('a role-scoped denial with no unresolved role says so instead of demanding one', () => {
  const denial = new DiscoveryBudgetDeniedError(
    'broad_discovery',
    'tool_search',
    'role_required',
    [],
  );
  assert.match(
    denial.message,
    /no unresolved requirement role/i,
    'demanding a key that cannot exist is the failure this pin exists to prevent',
  );
});
