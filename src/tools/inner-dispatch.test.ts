/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/inner-dispatch.test.ts
 *
 * Pins for the nested tool-dispatch lane shared by run_batch, call_tool,
 * work_call, and the pending-action executor. The model-visible program
 * executor is gone; these pins protect only the shared host transport.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  READ_ONLY_TOOLS,
  dispatchBatchItemTool,
  isMcpNamespacedTool,
  normalizeInnerDispatchToolResult,
  parseShellToolOutput,
  inheritedNestedHarnessContext,
  _setInnerDispatchToolsForTests,
  _setInnerDispatchMcpResolverForTests,
  _coerceJsonStringParamsForTest,
} from './inner-dispatch.js';
import { batchShapeDirective } from './batch-shape-directive.js';

test('READ_ONLY_TOOLS excludes every mutating tool (the read/write boundary)', () => {
  for (const writeTool of ['composio_execute_tool', 'write_file', 'run_shell_command', 'request_approval', 'execution_create', 'memory_remember']) {
    assert.equal(READ_ONLY_TOOLS.has(writeTool), false, `${writeTool} must NOT be in the read-only set`);
  }
  for (const readTool of ['memory_search', 'read_file']) {
    assert.equal(READ_ONLY_TOOLS.has(readTool), true);
  }
});

test('isMcpNamespacedTool: true for <server>__<tool>, false for local tool names', () => {
  assert.equal(isMcpNamespacedTool('dataforseo__serp_organic_live_advanced'), true);
  assert.equal(isMcpNamespacedTool('supabase__query'), true);
  assert.equal(isMcpNamespacedTool('memory_search'), false);
  assert.equal(isMcpNamespacedTool('composio_execute_tool'), false);
  assert.equal(isMcpNamespacedTool('run_batch'), false);
  assert.equal(isMcpNamespacedTool('__leading'), false, 'empty server half is not namespaced');
});

test('MCP inner dispatch resolves and calls under the executable server__tool identity', async () => {
  const { ToolCallsCounter } = await import('../runtime/harness/brackets.js');
  const resolved: string[] = [];
  const dispatched: string[] = [];
  _setInnerDispatchMcpResolverForTests((toolName) => {
    resolved.push(toolName);
    return {
      listTools: async () => [{ name: 'dataforseo__read_serp' }],
      callTool: async (name) => {
        dispatched.push(name);
        return [{ type: 'text', text: 'ok' }];
      },
    };
  });
  try {
    await dispatchBatchItemTool(
      'mcp__dataforseo__read_serp',
      { keyword: 'clementine' },
      'sess-inner-mcp-carrier',
      new ToolCallsCounter(10),
    );
    assert.deepEqual(resolved, ['dataforseo__read_serp']);
    assert.deepEqual(dispatched, ['dataforseo__read_serp']);
  } finally {
    _setInnerDispatchMcpResolverForTests(null);
  }
});

test('local-only scope is a hard authority wall before provider resolution or dispatch', async () => {
  const { withHarnessRunContext, ToolCallsCounter } = await import('../runtime/harness/brackets.js');
  let resolverCalls = 0;
  let listCalls = 0;
  let dispatchCalls = 0;
  _setInnerDispatchMcpResolverForTests(() => {
    resolverCalls += 1;
    return {
      listTools: async () => {
        listCalls += 1;
        return [{ name: 'proof__read' }];
      },
      callTool: async () => {
        dispatchCalls += 1;
        return 'should-not-run';
      },
    };
  });
  try {
    await withHarnessRunContext(
      {
        sessionId: 'sess-local-only-inner',
        counter: new ToolCallsCounter(20),
        mcpToolScope: {
          reason: 'explicit local-only regression',
          authority: 'none',
          allowedServerSlugs: [],
          maxTools: 0,
        },
      },
      async () => {
        await assert.rejects(
          () => dispatchBatchItemTool('proof__read', {}, 'sess-local-only-inner', new ToolCallsCounter(10)),
          /MCP_SCOPE_DENIED/,
        );
      },
    );
    assert.equal(resolverCalls, 0, 'provider factory/spawn must not be resolved');
    assert.equal(listCalls, 0, 'provider listTools must not run');
    assert.equal(dispatchCalls, 0, 'provider callTool must not run');
  } finally {
    _setInnerDispatchMcpResolverForTests(null);
  }
});

test('an uncertified irreversible SEND through inner dispatch parks for approval, never runs', async () => {
  const { ToolCallsCounter } = await import('../runtime/harness/brackets.js');
  let dispatched = 0;
  _setInnerDispatchToolsForTests(new Map([
    ['composio_execute_tool', {
      name: 'composio_execute_tool',
      invoke: async () => { dispatched += 1; return '{"successful":true}'; },
    }],
  ]) as never);
  try {
    await assert.rejects(
      () => dispatchBatchItemTool(
        'composio_execute_tool',
        { tool_slug: 'OUTLOOK_SEND_EMAIL', arguments: '{"to":"a@beta.example"}' },
        'sess-inner-send-floor',
        new ToolCallsCounter(10),
      ),
      (error: unknown) => error instanceof Error && /approval|pending/i.test(error.message),
      'the send floor must route to the pending-action graph',
    );
    assert.equal(dispatched, 0, 'the provider tool must never be invoked');
  } finally {
    _setInnerDispatchToolsForTests(null);
  }
});

test('parseShellToolOutput: exit_code/stdout/stderr wrapper becomes a structured shell result', () => {
  const out = parseShellToolOutput('exit_code: 0\n\nstdout:\n{"status":0,"records":[{"Name":"Acme"}]}\n\nstderr:\nwarning only');
  assert.ok(out);
  assert.equal(out.ok, true);
  assert.equal(out.exit_code, 0);
  assert.equal(out.stdout.trim(), '{"status":0,"records":[{"Name":"Acme"}]}');
  assert.equal(out.stderr.trim(), 'warning only');
  assert.deepEqual(out.stdout_json, { status: 0, records: [{ Name: 'Acme' }] });
});

test('normalizeInnerDispatchToolResult: obvious tool-error banners become structured failures', () => {
  const out = normalizeInnerDispatchToolResult(
    'composio_execute_tool',
    'An error occurred while running the tool. Please try again. Error: InvalidToolInputError: Invalid JSON input for tool',
  ) as { ok?: boolean; error?: string };
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /InvalidToolInputError/);
});

test('normalizeInnerDispatchToolResult: Composio warning-prefixed FAILED banners become structured failures', () => {
  const out = normalizeInnerDispatchToolResult(
    'composio_execute_tool',
    '⚠️ composio_execute_tool FAILED (slug=GOOGLESHEETS_BATCH_GET): Error: Range Sheet1!A1202:BR1401 exceeds grid limits. Max rows: 1009, max columns: 70.',
  ) as { ok?: boolean; error?: string; error_kind?: string };
  assert.equal(out.ok, false);
  assert.equal(out.error_kind, 'tool_error');
  assert.match(out.error ?? '', /exceeds grid limits/);
});

test('normalizeInnerDispatchToolResult: a chunked exact result exposes the full tail, never a prefix', async () => {
  const { createSession, writeToolOutput, TOOL_OUTPUT_MAX_BYTES } = await import('../runtime/harness/eventlog.js');
  const sess = createSession({ kind: 'chat' });
  // Sized FROM the cap ('a,1\n' = 4 bytes/row) so the fixture keeps crossing
  // the durable ceiling at any cap value.
  const full = `group,value\n${'a,1\n'.repeat(Math.ceil(TOOL_OUTPUT_MAX_BYTES / 4) + 50_000)}`;
  assert.ok(Buffer.byteLength(full) > TOOL_OUTPUT_MAX_BYTES, 'fixture must cross the durable output cap');
  writeToolOutput({
    sessionId: sess.id,
    callId: 'call_truncated_inner_result',
    tool: 'provider_list_rows',
    output: full,
    invocationNonce: 'nonce-truncated-inner-result',
  });

  const out = normalizeInnerDispatchToolResult(
    'provider_list_rows',
    { modelVisible: 'structured clipped preview' },
    { sessionId: sess.id, callId: 'call_truncated_inner_result' },
  );
  assert.equal(out, full);
  assert.match(String(out).slice(-32), /a,1/);
});

test('dispatchBatchItemTool establishes tool-output context for the inner tool (background-handoff regression)', async () => {
  // Live 2026-07-09: dispatch_background_task reached via call_tool refused
  // with "no session context here" — the dispatch set the harness GATE
  // context but never the tool-output ALS the inner tool reads.
  const { getToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
  const { ToolCallsCounter, withHarnessRunContext, harnessRunContextStorage } = await import('../runtime/harness/brackets.js');
  const { createSession, appendEvent } = await import('../runtime/harness/eventlog.js');
  const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
  _setInnerDispatchToolsForTests(new Map([
    ['ctx_probe', {
      name: 'ctx_probe',
      invoke: async () => JSON.stringify({
        seenSessionId: getToolOutputContext()?.sessionId ?? null,
        seenSourceUserSeq: harnessRunContextStorage.getStore()?.sourceUserSeq ?? null,
      }),
    }],
  ]) as never);
  try {
    const sid = createSession({ kind: 'chat' }).id;
    const source = appendEvent({
      sessionId: sid,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'hand off the background task' },
    });
    assert.ok(recordTurnGraphShadow({
      identity: { sessionId: sid, sourceUserSeq: source.seq, turn: source.turn },
    }), 'fixture persisted the turn graph for the accepted task');
    // A LATER ambient user input: the inner tool must keep the exact accepted
    // source seq, not this newest event.
    const decoy = appendEvent({
      sessionId: sid,
      turn: 2,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'unrelated newer input' },
    });
    assert.notEqual(decoy.seq, source.seq);
    const out = await withHarnessRunContext(
      { sessionId: sid, sourceUserSeq: source.seq, turn: source.turn, counter: new ToolCallsCounter(10) },
      () => dispatchBatchItemTool('ctx_probe', {}, sid, new ToolCallsCounter(10)),
    ) as { seenSessionId?: string | null; seenSourceUserSeq?: number | null };
    assert.equal(out?.seenSessionId, sid, 'inner tool must see the session via getToolOutputContext');
    assert.equal(out?.seenSourceUserSeq, source.seq, 'inner tool must retain the exact source turn instead of consulting the latest ambient user input');
  } finally {
    _setInnerDispatchToolsForTests(null);
  }
});

// Program-recall budget exemption (live 2026-07-24): the inherited model-lane
// recall budget capped a 100-item resume at 3 recalls; calls 4+ returned the
// budget error and 60 accounts of good banked data were declared "malformed".
test('nested dispatch context never inherits the model-lane recall budget; per-run accounting is kept', async () => {
  const { withHarnessRunContext, ToolCallsCounter, RecallBudget } = await import('../runtime/harness/brackets.js');
  const { createSession } = await import('../runtime/harness/eventlog.js');
  const sess = createSession({ kind: 'chat' }).id;
  await withHarnessRunContext(
    {
      sessionId: sess,
      counter: new ToolCallsCounter(50),
      recallBudget: new RecallBudget(3, 60_000),
      behaviorScopeId: 'scope-x',
      sourceUserSeq: 42,
      hostOwnsToolAccounting: true,
    },
    async () => {
      const nested = inheritedNestedHarnessContext(sess);
      assert.equal('recallBudget' in nested, false, 'nested recalls read a lossless local store — no model-context cost, no budget');
      assert.equal(nested.behaviorScopeId, 'scope-x', 'per-run accounting still inherited');
      assert.equal(nested.sourceUserSeq, 42, 'attempt authority still inherited');
      assert.equal(nested.hostOwnsToolAccounting, undefined, 'ambient parent accounting cannot exempt new nested work');
      assert.equal(inheritedNestedHarnessContext(sess, true).hostOwnsToolAccounting, true,
        'only the exact host-admitted mirror retains its existing charge');
      assert.deepEqual(inheritedNestedHarnessContext('foreign-session', true), {},
        'an exact token never imports another session context');
    },
  );
});

test('inner dispatch coerces object-valued JSON-string params instead of refusing (live 2026-08-20 slack bonfire)', () => {
  const coerced = _coerceJsonStringParamsForTest('composio_execute_tool', {
    tool_slug: 'SLACK_FETCH_CONVERSATION_HISTORY',
    arguments: { channel: 'D0BK123', limit: 20 },
  }) as Record<string, unknown>;
  assert.equal(typeof coerced.arguments, 'string', 'object arguments become the JSON string the schema demands');
  assert.deepEqual(JSON.parse(coerced.arguments as string), { channel: 'D0BK123', limit: 20 });
  const passthrough = _coerceJsonStringParamsForTest('composio_execute_tool', {
    tool_slug: 'X', arguments: '{"already":"string"}',
  }) as Record<string, unknown>;
  assert.equal(passthrough.arguments, '{"already":"string"}', 'string args pass through byte-identical');
});

test('batchShapeDirective: fires on a data-heavy turn, silent otherwise, and steers reads to PARALLEL calls', () => {
  assert.equal(batchShapeDirective({}), '', 'non-data turn keeps the prompt byte-identical');
  const fired = batchShapeDirective({ mcpServersInScope: 2 });
  assert.match(fired, /BATCH-SHAPE RULE/);
  assert.match(fired, /PARALLEL tool calls in ONE response/, 'reads lane targets parallel direct calls');
  assert.match(fired, /run_batch/);
  assert.match(fired, /run_worker/);
  assert.doesNotMatch(fired, /run_tool_program/, 'no steer may point at the subtracted program door');
  const composio = batchShapeDirective({ composioInScope: true });
  assert.match(composio, /BATCH-SHAPE RULE/, 'composio-only turns fire the rule too');
  const sharpened = batchShapeDirective({
    composioInScope: true,
    fanoutPreferred: true,
    multiItem: { count: 18, kind: 'firms', carried: false },
  });
  assert.match(sharpened, /THIS TURN IS BATCH-SHAPED/);
  assert.match(sharpened, /~18 independent firms/);
});
