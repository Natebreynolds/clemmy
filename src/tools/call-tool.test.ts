/**
 * Run: npx tsx --test src/tools/call-tool.test.ts
 *
 * call_tool — the schema-on-demand generic dispatcher (Phase 1). Proves:
 *  - AUTHORITY: refuses a target that is not on the orchestrator surface (no escalation).
 *  - ARG VALIDATION: bad args return {error:'arg_validation', schema} with NO dispatch.
 *  - GATE PARITY: a mutating inner tool routed through call_tool trips the SAME
 *    write-boundary gate (keyed on the INNER name), via the _setCodeModeToolsForTests seam.
 *  - PROMOTION: a successful dispatch records the reached tool to the session hot-set.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-call-tool-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildCallTool,
  _resetCallToolSchemaCacheForTest,
  materializeStrictNullableFields,
} = await import('./call-tool.js');
const { _setCodeModeToolsForTests } = await import('./code-mode-tool.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { withHarnessRunContext, ToolCallsCounter, wrapToolForHarness } = await import('../runtime/harness/brackets.js');
const { getHotSet, _resetHotSetForTest } = await import('../agents/tool-hotset.js');
const { resetEventLog, createSession, listEvents } = await import('../runtime/harness/eventlog.js');
const { getLocalToolSchemas } = await import('./local-runtime-tools.js');
const { deriveOrchestratorDiscoveryNames } = await import('./tool-registry.js');

type ToolLike = { invoke?: (ctx: unknown, input: string, details: unknown) => Promise<unknown> };

function invokeCallTool(sessionId: string, name: string, argsJson: string): Promise<unknown> {
  const callTool = buildCallTool() as unknown as ToolLike;
  return withToolOutputContext({ sessionId }, () =>
    callTool.invoke!(
      { context: { sessionId } },
      JSON.stringify({ name, args_json: argsJson }),
      { toolCall: { callId: `call-${Math.random()}` } },
    ) as Promise<unknown>,
  );
}

test('refuses a target that is not on the orchestrator surface (no escalation)', async () => {
  // cron_list is a cli-only tool (never on the chat surface); nonexistent is unknown.
  for (const target of ['cron_list', 'nonexistent_tool_xyz']) {
    const out = JSON.parse(String(await invokeCallTool('sess-auth', target, '{}')));
    assert.equal(out.error, 'not_reachable', `${target} should be refused`);
  }
  // sanity: the guard is not refusing everything — an orchestrator tool is reachable.
  assert.ok(deriveOrchestratorDiscoveryNames().has('composio_execute_tool'));
});

test('turn-scoped reachability refuses a built-in that was not advertised as deferred', async () => {
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(['memory_recall']),
  }) as unknown as ToolLike;
  const out = await withToolOutputContext({ sessionId: 'sess-scoped-auth' }, () =>
    callTool.invoke!(
      { context: { sessionId: 'sess-scoped-auth' } },
      JSON.stringify({ name: 'composio_execute_tool', args_json: '{}' }),
      { toolCall: { callId: 'scoped-call' } },
    ) as Promise<unknown>,
  );
  assert.equal(JSON.parse(String(out)).error, 'not_reachable');
});

test('explicit turn denials cannot be bypassed with an external MCP name', async () => {
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(),
    deniedNames: new Set(['fakeserver__fake_tool']),
  }) as unknown as ToolLike;
  const out = await withToolOutputContext({ sessionId: 'sess-denied-mcp' }, () =>
    callTool.invoke!(
      { context: { sessionId: 'sess-denied-mcp' } },
      JSON.stringify({ name: 'fakeserver__fake_tool', args_json: '{}' }),
      { toolCall: { callId: 'denied-mcp-call' } },
    ) as Promise<unknown>,
  );
  assert.equal(JSON.parse(String(out)).error, 'not_reachable');
});

test('bad args return the schema with error=arg_validation and NO dispatch', async () => {
  _resetHotSetForTest();
  _resetCallToolSchemaCacheForTest();
  // Find a lane-orchestrator tool whose schema rejects {} (has a required field).
  const schemas = getLocalToolSchemas();
  const allowed = deriveOrchestratorDiscoveryNames();
  const target = [...allowed].find((n) => {
    const s = schemas.get(n);
    return s ? !s.safeParse({}).success : false;
  });
  assert.ok(target, 'expected at least one orchestrator tool with a required arg');

  const out = JSON.parse(String(await invokeCallTool('sess-argval', target!, '{}')));
  assert.equal(out.error, 'arg_validation');
  assert.ok(out.schema && typeof out.schema === 'object', 'returns the target JSON schema');
  assert.ok(typeof out.detail === 'string' && out.detail.length > 0, 'returns a detail message');
  // No dispatch happened → the tool was never promoted to the hot-set.
  assert.ok(!getHotSet('sess-argval').includes(target!), 'a validation miss must not dispatch');
});

test('unknown deferred arguments are rejected instead of silently stripped before dispatch', async () => {
  _resetHotSetForTest();
  _resetCallToolSchemaCacheForTest();
  const out = JSON.parse(String(await invokeCallTool(
    'sess-stale-workspace-schema',
    'space_save',
    JSON.stringify({
      slug: 'stale-workspace-shape',
      title: 'Stale Workspace Shape',
      view_path: '/tmp/never-dispatched.html',
      description: 'obsolete field',
      dataSources: [{ id: 'tasks', type: 'runner' }],
    }),
  )));
  assert.equal(out.error, 'arg_validation');
  assert.match(out.detail, /Unrecognized keys?:.*description.*dataSources|Unrecognized keys?:.*dataSources.*description/i);
  assert.ok(out.schema && typeof out.schema === 'object');
  assert.match(out.guidance, /clem\.data\(\)/, 'the correction includes the selected tool contract, not only its arguments');
  assert.match(out.guidance, /MUST print the dataset as JSON to stdout/, 'runner semantics are available on direct stale-schema calls');
  assert.ok(!getHotSet('sess-stale-workspace-schema').includes('space_save'), 'unknown fields must prevent dispatch and promotion');
});

test('invalid JSON in args_json returns arg_validation with no dispatch', async () => {
  const out = JSON.parse(String(await invokeCallTool('sess-json', 'composio_execute_tool', '{not json')));
  assert.equal(out.error, 'arg_validation');
});

test('deferred validation accepts omitted optional keys as well as strict-mode nulls', () => {
  _resetCallToolSchemaCacheForTest();
  const schemas = getLocalToolSchemas();
  const facts = schemas.get('memory_list_facts');
  const working = schemas.get('working_memory');
  const recall = schemas.get('memory_recall_all');
  const getRunner = schemas.get('space_get_runner');
  const refreshSpace = schemas.get('space_refresh');
  assert.ok(facts && working && recall && getRunner && refreshSpace);
  assert.equal(facts!.safeParse({ query: 'Northstar live-proof team', limit: 50 }).success, true);
  assert.equal(facts!.safeParse({ kind: null, query: 'Northstar live-proof team', limit: 50, includeInactive: false }).success, true);
  assert.equal(working!.safeParse({ action: 'read' }).success, true);
  assert.equal(working!.safeParse({ action: 'read', content: null }).success, true);
  assert.equal(recall!.safeParse({}).success, false, 'genuinely required keys remain required');
  assert.equal(getRunner!.safeParse({ slug: 'proof-cockpit', runner_path: 'tasks.mjs' }).success, true);
  assert.equal(refreshSpace!.safeParse({ slug: 'proof-cockpit' }).success, true);
});

test('deferred workflow schemas accept lean nested steps and materialize strict nulls only at dispatch', async () => {
  _resetCallToolSchemaCacheForTest();
  const update = getLocalToolSchemas().get('workflow_update');
  assert.ok(update);
  const lean = {
    name: 'lean-workflow',
    steps: [{
      id: 'define',
      deterministic: {
        runner: 'define.mjs',
        source: 'process.stdout.write("[]")',
      },
    }],
  };
  assert.equal(
    update!.safeParse(lean).success,
    true,
    'args_json should not need dozens of nested null placeholders',
  );

  const { getCoreTools } = await import('./registry.js');
  const strict = getCoreTools().find((tool) => tool.name === 'workflow_update')?.parameters;
  assert.ok(strict);
  const materialized = materializeStrictNullableFields(lean, strict) as {
    steps: Array<Record<string, unknown>>;
  };
  assert.equal(materialized.steps[0].id, 'define');
  assert.equal(materialized.steps[0].prompt, null);
  assert.equal(materialized.steps[0].call, null);
  assert.deepEqual(materialized.steps[0].deterministic, {
    runner: 'define.mjs',
    source: 'process.stdout.write("[]")',
  });
});

test('materialization survives a nullish (double-anyOf) wrapper around a nested array', async () => {
  _resetCallToolSchemaCacheForTest();
  // Live failure (proof workspace-build, 2026-07-27): space_save's
  // data_sources is nullish → JSON schema anyOf[anyOf[array,null],null].
  // The branch resolver did not recurse through the nested wrapper, so the
  // items schema was lost and nested required-nullable keys (composio_slug,
  // schedule, timezone, …) stayed omitted — the strict inner parser then
  // rejected the call three times and the model degraded to a static page.
  const { getCoreTools } = await import('./registry.js');
  const strict = getCoreTools().find((tool) => tool.name === 'space_save')?.parameters;
  assert.ok(strict);
  const materialized = materializeStrictNullableFields(
    { slug: 'proof-cockpit', title: 'Proof Cockpit', data_sources: [{ id: 'local_tasks', runner: 'tasks.mjs' }] },
    strict,
  ) as { data_sources: Array<Record<string, unknown>> };
  assert.equal(materialized.data_sources[0].id, 'local_tasks');
  assert.equal(materialized.data_sources[0].runner, 'tasks.mjs');
  assert.equal(materialized.data_sources[0].composio_slug, null);
  assert.equal(materialized.data_sources[0].schedule, null);
  assert.equal(materialized.data_sources[0].timezone, null);
});

test('call_tool materializes omitted optional keys before invoking the real strict inner tool', async () => {
  _resetCallToolSchemaCacheForTest();
  const out = String(await invokeCallTool(
    'sess-optional-inner-dispatch',
    'memory_list_facts',
    JSON.stringify({ query: 'Northstar live-proof team', limit: 10 }),
  ));
  assert.doesNotMatch(out, /InvalidToolInputError|arg_validation/);
  assert.ok(Array.isArray(JSON.parse(out)), 'the real inner memory tool completed with valid JSON');
});

test('call_tool materializes omitted nullable computer-tool defaults before strict dispatch', async () => {
  _resetCallToolSchemaCacheForTest();
  const out = String(await invokeCallTool(
    'sess-computer-null-defaults',
    'run_shell_command',
    JSON.stringify({ command: 'echo CALL_TOOL_NULL_DEFAULTS_OK' }),
  ));
  assert.doesNotMatch(out, /InvalidToolInputError|arg_validation/);
  assert.match(out, /CALL_TOOL_NULL_DEFAULTS_OK/);
});

test('gate parity: a mutating inner tool routed through call_tool trips the write boundary (keyed on inner name)', async () => {
  const prev = {
    brackets: process.env.HARNESS_TOOL_BRACKETS,
    confirm: process.env.CLEMMY_CONFIRM_FIRST,
    execGate: process.env.CLEMMY_EXECUTION_GATE,
  };
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'on';
  process.env.CLEMMY_EXECUTION_GATE = 'off'; // isolate the confirm-first batch gate
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  // Inject a fake inner composio_execute_tool. dispatchBatchItemTool wraps THIS via
  // wrapToolForHarness, so the write boundary keys on 'composio_execute_tool' (inner).
  _setCodeModeToolsForTests(
    new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'sent' }]]),
  );
  try {
    // NEW CONTRACT (2026-07-09 Lane 2): an IRREVERSIBLE SEND via call_tool is
    // REFUSED — call_tool bypasses the approval card, so sends must go through
    // run_batch or a first-class call. The refusal names the fix.
    const sendOut = String(await invokeCallTool(
      sess.id, 'composio_execute_tool',
      JSON.stringify({ tool_slug: 'GMAIL_SEND_EMAIL', arguments: JSON.stringify({ to: 'p@site.example' }) }),
    ));
    assert.match(sendOut, /SEND_REQUIRES_APPROVAL|run_batch/i, 'a send via call_tool is refused, directed to run_batch/first-class');
    assert.equal(listEvents(sess.id, { types: ['external_write'] }).length, 0, 'no send dispatched');

    // A REVERSIBLE WRITE still routes through the gated boundary keyed on the
    // inner tool name (gate parity preserved for non-sends).
    _setCodeModeToolsForTests(
      new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'updated' }]]),
    );
    const writeOut = String(await invokeCallTool(
      sess.id, 'composio_execute_tool',
      JSON.stringify({ tool_slug: 'GOOGLESHEETS_VALUES_UPDATE', arguments: JSON.stringify({ range: 'A1' }) }),
    ));
    assert.ok(writeOut.startsWith('updated'), 'a reversible write routes through the gated inner tool');
  } finally {
    _setCodeModeToolsForTests(null);
    process.env.HARNESS_TOOL_BRACKETS = prev.brackets;
    process.env.CLEMMY_CONFIRM_FIRST = prev.confirm;
    process.env.CLEMMY_EXECUTION_GATE = prev.execGate;
  }
});

test('a successful dispatch records the reached tool to the session hot-set', async () => {
  _resetHotSetForTest();
  // Fake read inner tool (a read slug → no gate) so dispatch is deterministic.
  _setCodeModeToolsForTests(
    new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'ok' }]]),
  );
  try {
    const out = await invokeCallTool(
      'sess-lru',
      'composio_execute_tool',
      JSON.stringify({ tool_slug: 'APIFY_GET_DATASET_ITEMS', arguments: '{}' }),
    );
    assert.equal(String(out), 'ok');
    assert.ok(getHotSet('sess-lru').includes('composio_execute_tool'), 'reached tool is promoted to the hot-set');
  } finally {
    _setCodeModeToolsForTests(null);
  }
});

test('a first-class built-in accidentally wrapped in call_tool dispatches instead of bouncing not_reachable', async () => {
  _setCodeModeToolsForTests(
    new Map([['memory_recall_all', { name: 'memory_recall_all', invoke: async () => 'all eight teammates' }]]),
  );
  try {
    const callTool = buildCallTool({
      reachableBuiltinNames: new Set(),
      firstClassNames: new Set(['memory_recall_all']),
    }) as unknown as ToolLike;
    const out = await callTool.invoke!(
      { context: { sessionId: 'sess-first-class-wrapper' } },
      JSON.stringify({ name: 'memory_recall_all', args_json: JSON.stringify({ objective: 'my team', limit: null }) }),
      { toolCall: { callId: 'first-class-wrapper' } },
    );
    assert.equal(String(out), 'all eight teammates');
  } finally {
    _setCodeModeToolsForTests(null);
  }
});

test('a common http_fetch guess repairs to the allowed bounded GET path without double-counting the inner mirror', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  let dispatched: Record<string, unknown> | null = null;
  _setCodeModeToolsForTests(
    new Map([['run_shell_command', {
      name: 'run_shell_command',
      invoke: async (_ctx: unknown, input: string) => {
        dispatched = JSON.parse(input) as Record<string, unknown>;
        return '{"id":1}';
      },
    }]]),
  );
  try {
    const callTool = buildCallTool({
      reachableBuiltinNames: new Set(),
      firstClassNames: new Set(['run_shell_command']),
    }) as unknown as ToolLike;
    const out = await callTool.invoke!(
      { context: { sessionId: sess.id } },
      JSON.stringify({
        name: 'http_fetch',
        args_json: JSON.stringify({ url: 'https://example.com/posts/1' }),
      }),
      { toolCall: { callId: 'outer-http-fetch' } },
    );
    assert.deepEqual(JSON.parse(String(out)), { id: 1 });
    assert.ok(dispatched);
    const command = String(dispatched!.command ?? '');
    assert.match(command, /^curl /);
    assert.match(command, /--max-filesize 1048576/);
    assert.match(command, /--write-out/);
    assert.match(command, /CLEMENTINE_HTTP_META_V1/);
    assert.ok(
      command.includes('marker=b"\\n__CLEMENTINE_HTTP_META_V1__"'),
      'the parser must split on the real newline emitted by curl, not a literal backslash-n',
    );
    assert.match(command, /sha256/);
    assert.match(command, /http_code/);
    assert.match(command, /https:\/\/example\.com\/posts\/1/);

    const inner = listEvents(sess.id, { types: ['tool_called'] })
      .find((event) => (event.data as { tool?: string }).tool === 'run_shell_command');
    assert.ok(inner, 'the repaired real tool remains visible in raw telemetry');
    assert.equal(inner!.data.accounting, 'transport_mirror');
    assert.equal(inner!.data.canonicalCallId, 'outer-http-fetch');
  } finally {
    _setCodeModeToolsForTests(null);
  }
});

test('the common mcp_tools guess repairs to the on-demand MCP inventory tool', async () => {
  let dispatched: Record<string, unknown> | null = null;
  _setCodeModeToolsForTests(
    new Map([['mcp_list_tools', {
      name: 'mcp_list_tools',
      invoke: async (_ctx: unknown, input: string) => {
        dispatched = JSON.parse(input) as Record<string, unknown>;
        return '{"results":[{"name":"dataforseo__keyword_suggestions"}]}';
      },
    }]]),
  );
  try {
    const callTool = buildCallTool({
      reachableBuiltinNames: new Set(['mcp_list_tools']),
    }) as unknown as ToolLike;
    const out = await callTool.invoke!(
      { context: { sessionId: 'sess-mcp-tools-alias' } },
      JSON.stringify({
        name: 'mcp_tools',
        args_json: JSON.stringify({ server_name: 'dataforseo', query: 'keyword suggestions' }),
      }),
      { toolCall: { callId: 'mcp-tools-alias' } },
    );
    assert.match(String(out), /dataforseo__keyword_suggestions/);
    assert.equal(dispatched?.server_name, 'dataforseo');
    assert.equal(dispatched?.query, 'keyword suggestions');
  } finally {
    _setCodeModeToolsForTests(null);
  }
});

test('the HTTP alias refuses mutation-shaped or credential-bearing inputs before dispatch', async () => {
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(),
    firstClassNames: new Set(['run_shell_command']),
  }) as unknown as ToolLike;
  for (const args of [
    { url: 'https://example.com/items', method: 'POST' },
    { url: 'https://user:secret@example.com/items' },
    { url: 'file:///etc/passwd' },
    { url: 'https://example.com/items', headers: { authorization: 'secret' } },
  ]) {
    const out = await callTool.invoke!(
      { context: { sessionId: 'sess-http-alias-refusal' } },
      JSON.stringify({ name: 'http_fetch', args_json: JSON.stringify(args) }),
      { toolCall: { callId: `http-refusal-${Math.random()}` } },
    );
    assert.equal(JSON.parse(String(out)).error, 'arg_validation');
  }
});

test('production run context attributes the inner dispatch without a tool-output ALS shim', async () => {
  _resetHotSetForTest();
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  _setCodeModeToolsForTests(
    new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'rows' }]]),
  );
  try {
    const callTool = buildCallTool() as unknown as ToolLike;
    const out = await withHarnessRunContext(
      { sessionId: sess.id, counter: new ToolCallsCounter(10) },
      () => callTool.invoke!(
        { context: { sessionId: sess.id } },
        JSON.stringify({
          name: 'composio_execute_tool',
          args_json: JSON.stringify({ tool_slug: 'APIFY_GET_DATASET_ITEMS', arguments: '{}' }),
        }),
        { toolCall: { callId: 'outer-call-tool' } },
      ) as Promise<unknown>,
    );

    assert.equal(String(out), 'rows');
    const innerCalls = listEvents(sess.id, { types: ['tool_called'] })
      .filter((event) => (event.data as { tool?: string }).tool === 'composio_execute_tool');
    assert.equal(innerCalls.length, 1, 'inner dispatch telemetry stays on the active session');
    assert.ok(getHotSet(sess.id).includes('composio_execute_tool'), 'promotion stays on the active session');
  } finally {
    _setCodeModeToolsForTests(null);
  }
});

test('nested call_tool dispatch reuses the ambient run counter', async () => {
  _setCodeModeToolsForTests(
    new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'rows' }]]),
  );
  const counter = new ToolCallsCounter(1);
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(['composio_execute_tool']),
  }) as unknown as ToolLike;
  const invoke = () => callTool.invoke!(
    { context: { sessionId: 'sess-shared-counter' } },
    JSON.stringify({
      name: 'composio_execute_tool',
      args_json: JSON.stringify({ tool_slug: 'APIFY_GET_DATASET_ITEMS', arguments: '{}' }),
    }),
    { toolCall: { callId: `shared-counter-${counter.calls}` } },
  ) as Promise<unknown>;
  try {
    await withHarnessRunContext(
      { sessionId: 'sess-shared-counter', counter },
      async () => {
        assert.equal(String(await invoke()), 'rows');
        assert.equal(counter.calls, 1, 'the inner call consumes the ambient budget');
        const refused = String(await invoke());
        assert.match(refused, /tool call refused by harness|tool.call limit|exceeded/i);
        assert.equal(counter.calls, 1, 'a refused nested call cannot reset or consume past the shared limit');
      },
    );
  } finally {
    _setCodeModeToolsForTests(null);
  }
});

test('an external MCP name (<server>__<tool>) passes authority and reaches MCP resolution (2026-07-08 live gap)', async () => {
  // The model tried call_tool→dataforseo__kw_data_google_ads_search_volume live
  // and got not_reachable, then fell back to hand-rolling the provider REST API
  // through shell calls. MCP names must pass the built-in allowlist and be
  // enforced DOWNSTREAM by the session's connected-MCP scope. Here no MCP server
  // is connected, so dispatch fails — but with an MCP-resolution error, NOT the
  // authority refusal.
  const out = String(await invokeCallTool('sess-mcp', 'fakeserver__fake_tool', '{"q":1}'));
  assert.ok(!out.includes('not_reachable'), 'MCP names must not be refused by the built-in authority check');
});

test('a harness-wrapped call_tool charges the ambient budget exactly ONCE per deferred action', async () => {
  // Live shape: the orchestrator wraps call_tool with wrapToolForHarness, and
  // the inner dispatch charges the SAME ambient counter. Without the wrapper
  // exemption every deferred action costs 2, halving the effective per-turn
  // budget on the schema-on-demand lane.
  _setCodeModeToolsForTests(
    new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'rows' }]]),
  );
  const counter = new ToolCallsCounter(10);
  const wrapped = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set(['composio_execute_tool']) }) as never,
  ) as unknown as ToolLike;
  try {
    await withHarnessRunContext(
      { sessionId: 'sess-single-charge', counter },
      async () => {
        const out = await wrapped.invoke!(
          { context: { sessionId: 'sess-single-charge' } },
          JSON.stringify({
            name: 'composio_execute_tool',
            args_json: JSON.stringify({ tool_slug: 'APIFY_GET_DATASET_ITEMS', arguments: '{}' }),
          }),
          { toolCall: { callId: 'single-charge-1' } },
        );
        assert.equal(String(out), 'rows');
        assert.equal(counter.calls, 1, 'outer dispatcher wrapper must not double-charge the inner action');
      },
    );
  } finally {
    _setCodeModeToolsForTests(null);
  }
});

test('a FAILING call_tool dispatch still charges the budget — no zero-cost retry loop', async () => {
  // Round-2 regression: the wrapper exemption must not exempt the failure
  // paths (refusals return before the inner dispatch, which is what normally
  // charges). Each refused invocation costs exactly 1, and the ceiling still
  // throws once exhausted.
  const counter = new ToolCallsCounter(2);
  const wrapped = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set() }) as never,
  ) as unknown as ToolLike;
  const invoke = () => wrapped.invoke!(
    { context: { sessionId: 'sess-fail-charge' } },
    JSON.stringify({ name: 'not_a_real_tool', args_json: '{}' }),
    { toolCall: { callId: `fail-charge-${counter.calls}` } },
  ) as Promise<unknown>;
  await withHarnessRunContext(
    { sessionId: 'sess-fail-charge', counter },
    async () => {
      assert.equal(JSON.parse(String(await invoke())).error, 'not_reachable');
      assert.equal(counter.calls, 1, 'a refused dispatch costs exactly one call');
      assert.equal(JSON.parse(String(await invoke())).error, 'not_reachable');
      assert.equal(counter.calls, 2);
      const third = String(await invoke());
      assert.match(third, /tool call refused by harness|tool.call limit|exceeded/i, 'the ceiling still bounds a failing loop');
      assert.equal(counter.calls, 2, 'the ceiling refuses without further spend');
    },
  );
});
