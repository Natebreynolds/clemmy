/**
 * Run: npx tsx --test src/tools/code-mode-tool.test.ts
 *
 * Code Mode tool surface + read-only dispatcher (Lane C Phase 1). The safety
 * boundary: with writes OFF, a code-mode program can ONLY reach read-only tools —
 * a write/send tool is refused before any dispatch. Code Mode is DEFAULT-ON since
 * v0.11.0 (sandbox escape-soaked); CLEMMY_CODE_MODE=off is the kill-switch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  READ_ONLY_TOOLS,
  dispatchCodeModeTool,
  buildCodeModeTool,
  isCodeModeToolAllowed,
  isMcpNamespacedTool,
  codeModeMandateDirective,
  normalizeCodeModeToolResult,
  parseShellToolOutput,
  runCodeModeForSession,
  _setCodeModeToolsForTests,
} from './code-mode-tool.js';

test('READ_ONLY_TOOLS excludes every mutating tool (the Phase-1 boundary)', () => {
  for (const writeTool of ['composio_execute_tool', 'write_file', 'run_shell_command', 'request_approval', 'execution_create', 'memory_remember']) {
    assert.equal(READ_ONLY_TOOLS.has(writeTool), false, `${writeTool} must NOT be in the read-only allowlist`);
  }
  // sanity: it DOES include the read tools
  for (const readTool of ['memory_search', 'read_file', 'composio_search_tools']) {
    assert.equal(READ_ONLY_TOOLS.has(readTool), true);
  }
});

test('dispatchCodeModeTool refuses a mutating tool when writes are OFF (kill-switch)', async () => {
  const prev = process.env.CLEMMY_CODE_MODE_WRITES;
  process.env.CLEMMY_CODE_MODE_WRITES = 'off'; // writes kill-switch (default is now on)
  try {
    await assert.rejects(
      () => dispatchCodeModeTool('composio_execute_tool', { tool_slug: 'X_SEND', arguments: '{}' }, 'sess'),
      /not available|writes are disabled/,
    );
    await assert.rejects(() => dispatchCodeModeTool('write_file', { path: '/tmp/x', content: 'y' }, 'sess'), /not available|writes are disabled/);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CODE_MODE_WRITES; else process.env.CLEMMY_CODE_MODE_WRITES = prev;
  }
});

test('dispatchCodeModeTool refuses an irreversible SEND even with writes ON — routes to run_batch', async () => {
  // 2026-07-07: a run_tool_program looping 10 OUTLOOK_SEND_EMAIL calls hit the
  // 60s code-mode cap and died mid-batch with 0 confirmed sent. Sends must be
  // refused here so the model is redirected to run_batch BEFORE burning 60s.
  const prev = process.env.CLEMMY_CODE_MODE_WRITES;
  process.env.CLEMMY_CODE_MODE_WRITES = 'on';
  try {
    await assert.rejects(
      () => dispatchCodeModeTool('composio_execute_tool', { tool_slug: 'OUTLOOK_SEND_EMAIL', arguments: '{"to":"a@beta.example"}' }, 'sess'),
      /run_batch/,
      'an irreversible send inside code mode must be refused and point at run_batch',
    );
    // A non-irreversible write (update) is NOT blocked by the send guard for the
    // first two calls, but a MUTATION LOOP is: the 3rd mutating call in one
    // program run (same counter) is refused with the run_batch redirect —
    // reversible-write batches die at the 60s cap exactly like sends.
    const { ToolCallsCounter } = await import('../runtime/harness/brackets.js');
    const programCounter = new ToolCallsCounter(100);
    const guardRejected = (p: Promise<unknown>) =>
      p.then(() => false, (e: unknown) => e instanceof Error && /run_batch/.test(e.message) && /code-mode: refusing/.test(e.message));
    assert.equal(await guardRejected(dispatchCodeModeTool('composio_execute_tool', { tool_slug: 'AIRTABLE_UPDATE_RECORD', arguments: '{"r":1}' }, 'sess', programCounter)), false, '1st reversible write passes the guard');
    assert.equal(await guardRejected(dispatchCodeModeTool('composio_execute_tool', { tool_slug: 'AIRTABLE_UPDATE_RECORD', arguments: '{"r":2}' }, 'sess', programCounter)), false, '2nd reversible write passes the guard');
    assert.equal(await guardRejected(dispatchCodeModeTool('composio_execute_tool', { tool_slug: 'AIRTABLE_UPDATE_RECORD', arguments: '{"r":3}' }, 'sess', programCounter)), true, '3rd mutating call in one program is refused → run_batch');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CODE_MODE_WRITES; else process.env.CLEMMY_CODE_MODE_WRITES = prev;
  }
});

test('isMcpNamespacedTool: true for <server>__<tool>, false for local tool names', () => {
  assert.equal(isMcpNamespacedTool('dataforseo__serp_organic_live_advanced'), true);
  assert.equal(isMcpNamespacedTool('supabase__query'), true);
  // local tools (single underscores, or a name that IS in an allowlist) never route to MCP
  assert.equal(isMcpNamespacedTool('memory_search'), false);
  assert.equal(isMcpNamespacedTool('composio_execute_tool'), false);
  assert.equal(isMcpNamespacedTool('run_tool_program'), false);
  assert.equal(isMcpNamespacedTool('__leading'), false, 'empty server half is not namespaced');
});

test('MCP tools are allowed in-sandbox even when local writes are OFF (gated by the shim, not the writes flag)', () => {
  const prev = process.env.CLEMMY_CODE_MODE_WRITES;
  process.env.CLEMMY_CODE_MODE_WRITES = 'off';
  try {
    assert.equal(isCodeModeToolAllowed('dataforseo__serp_organic_live_advanced'), true, 'MCP read reachable with writes off');
    assert.equal(isCodeModeToolAllowed('memory_search'), true, 'local read still allowed');
    assert.equal(isCodeModeToolAllowed('composio_execute_tool'), false, 'local write still blocked with writes off');
    assert.equal(isCodeModeToolAllowed('totally_made_up_tool'), false, 'a non-namespaced unknown is refused');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CODE_MODE_WRITES; else process.env.CLEMMY_CODE_MODE_WRITES = prev;
  }
});

test('codeModeMandateDirective: fires on a data-heavy turn (MCP servers in scope), silent otherwise', () => {
  // non-data turn → byte-identical prompt (empty directive)
  assert.equal(codeModeMandateDirective({ mcpServersInScope: 0 }), '');
  // data-heavy turn → the standing lane rule with ALL THREE lanes present
  const d = codeModeMandateDirective({ mcpServersInScope: 2 });
  assert.match(d, /run_tool_program/);
  assert.match(d, /BATCH-SHAPE RULE/);
  assert.match(d, /run_worker/);
  assert.match(d, /SINGLE read/);
  // allowAll also triggers it
  assert.match(codeModeMandateDirective({ allowAllMcp: true }), /run_tool_program/);
});

// Move 3 / adoption: the trigger used to key ONLY on external MCP servers, so a
// composio-heavy turn (email/CRM/calendar — the common case, and the lane where a
// live probe showed 6 discrete calls + 0 programs) never tripped the mandate.
test('codeModeMandateDirective: composioInScope fires the mandate (was MCP-only)', () => {
  // no data tools at all → still silent (byte-identical prompt)
  assert.equal(codeModeMandateDirective({}), '');
  assert.equal(codeModeMandateDirective({ composioInScope: false }), '');
  // composio in scope with no MCP → NOW fires
  const d = codeModeMandateDirective({ composioInScope: true });
  assert.match(d, /BATCH-SHAPE RULE/);
  assert.match(d, /run_tool_program/);
  // base rule is constant across calls → safe to sit in the cacheable stable append
  assert.equal(d, codeModeMandateDirective({ composioInScope: true }));
});

test('codeModeMandateDirective: fan-out-shaped turns get a POSITIVE lane-(a) directive, not silence', () => {
  // 2026-07-07: the old contract returned '' on fanoutPreferred, so a missed
  // detection actively steered batch work into code mode and a hit detection
  // left the model with no guidance at all. Now: the rule is always present,
  // and a detected multi-item turn names the batch and mandates run_worker.
  const d = codeModeMandateDirective({
    mcpServersInScope: 2,
    fanoutPreferred: true,
    multiItem: { count: 18, kind: 'firms', carried: true },
  });
  assert.match(d, /THIS TURN IS BATCH-SHAPED/);
  assert.match(d, /~18 independent firms/);
  assert.match(d, /your own prior message names the batch/);
  assert.match(d, /run_batch/);
  assert.match(d, /run_worker/);
  // fanoutPreferred without shape detail still gets the standing rule
  const bare = codeModeMandateDirective({ mcpServersInScope: 2, fanoutPreferred: true });
  assert.match(bare, /BATCH-SHAPE RULE/);
  assert.doesNotMatch(bare, /THIS TURN IS BATCH-SHAPED/);
});

test('codeModeMandateDirective: mentions composio_execute_tool only when writes are on', () => {
  const prev = process.env.CLEMMY_CODE_MODE_WRITES;
  try {
    process.env.CLEMMY_CODE_MODE_WRITES = 'on';
    assert.match(codeModeMandateDirective({ mcpServersInScope: 1 }), /composio_execute_tool/);
    process.env.CLEMMY_CODE_MODE_WRITES = 'off';
    assert.doesNotMatch(codeModeMandateDirective({ mcpServersInScope: 1 }), /composio_execute_tool/);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CODE_MODE_WRITES; else process.env.CLEMMY_CODE_MODE_WRITES = prev;
  }
});

test('codeModeMandateDirective: no mandate when code mode itself is off', () => {
  const prevC = process.env.CLEMMY_CODE_MODE;
  try {
    process.env.CLEMMY_CODE_MODE = 'off';
    assert.equal(codeModeMandateDirective({ mcpServersInScope: 3 }), '', 'no mandate when code mode itself is off');
  } finally {
    if (prevC === undefined) delete process.env.CLEMMY_CODE_MODE; else process.env.CLEMMY_CODE_MODE = prevC;
  }
});

test('buildCodeModeTool exposes run_tool_program with a program parameter', () => {
  const t = buildCodeModeTool() as { name?: string };
  assert.equal(t.name, 'run_tool_program');
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

test('normalizeCodeModeToolResult: obvious tool-error banners become structured failures', () => {
  const out = normalizeCodeModeToolResult(
    'composio_execute_tool',
    'An error occurred while running the tool. Please try again. Error: InvalidToolInputError: Invalid JSON input for tool',
  ) as { ok?: boolean; error?: string };
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /InvalidToolInputError/);
});

test('runCodeModeForSession: run_shell_command exposes stdout/stdout_json instead of the text wrapper', async () => {
  const prevWrites = process.env.CLEMMY_CODE_MODE_WRITES;
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.CLEMMY_CODE_MODE_WRITES = 'on';
  process.env.HARNESS_TOOL_BRACKETS = 'off';
  _setCodeModeToolsForTests(new Map<string, { name: string; invoke: () => Promise<unknown> }>([
    ['run_shell_command', {
      name: 'run_shell_command',
      invoke: async () => 'exit_code: 0\n\nstdout:\n{"status":0,"result":{"records":[{"Name":"Acme"}]}}\n\nstderr:\nCLI warning',
    }],
  ]));
  try {
    const result = await runCodeModeForSession(
      `const res = await clem.run_shell_command({ command: 'sf data query --json', cwd: null, timeout_ms: 1000 });
       return { exit: res.exit_code, parsed: JSON.parse(res.stdout).result.records[0].Name, auto: res.stdout_json.result.records[0].Name, stderr: res.stderr };`,
      'sess-codemode-shell',
    );
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.value, { exit: 0, parsed: 'Acme', auto: 'Acme', stderr: 'CLI warning' });
  } finally {
    _setCodeModeToolsForTests(null);
    if (prevWrites === undefined) delete process.env.CLEMMY_CODE_MODE_WRITES; else process.env.CLEMMY_CODE_MODE_WRITES = prevWrites;
    if (prevBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS; else process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
  }
});

test('run_tool_program surface follows CLEMMY_CODE_MODE: absent when off, present when on (default on)', async () => {
  const { getCoreTools } = await import('./registry.js');
  const prev = process.env.CLEMMY_CODE_MODE;
  try {
    process.env.CLEMMY_CODE_MODE = 'off';
    assert.equal(getCoreTools().some((t) => (t as { name?: string }).name === 'run_tool_program'), false, 'absent when off');
    process.env.CLEMMY_CODE_MODE = 'on';
    assert.equal(getCoreTools().some((t) => (t as { name?: string }).name === 'run_tool_program'), true, 'present when on');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CODE_MODE; else process.env.CLEMMY_CODE_MODE = prev;
  }
});

// F2 distill re-steer (round-2 tune): a multi-fetch program that returned raw
// payloads (savedBytes≈0) gets an advisory to distill; single/distilled don't.
test('codeModeDistillReSteer: fires only on a multi-fetch program that returned raw payloads', async () => {
  const { codeModeDistillReSteer } = await import('./code-mode-tool.js');
  // raw: 3 fetches, return ~= intermediate (no distill)
  assert.match(codeModeDistillReSteer({ ok: true, rpcCalls: 3, value: 'x'.repeat(1500), logs: [], intermediateBytes: 1500 }), /raw fetch payloads/);
  // distilled: returned a tiny value vs large intermediate
  assert.equal(codeModeDistillReSteer({ ok: true, rpcCalls: 3, value: { count: 3 }, logs: [], intermediateBytes: 1500 }), '');
  // single fetch: exempt (a single read shouldn't be a program anyway)
  assert.equal(codeModeDistillReSteer({ ok: true, rpcCalls: 1, value: 'x'.repeat(1500), logs: [], intermediateBytes: 1500 }), '');
  // no fetches / failed: exempt
  assert.equal(codeModeDistillReSteer({ ok: true, rpcCalls: 0, value: {}, logs: [], intermediateBytes: 0 }), '');
  assert.equal(codeModeDistillReSteer({ ok: false, rpcCalls: 3, error: 'x', logs: [], intermediateBytes: 1500 }), '');
});

// ─── Move 5: clem.run_worker (bounded sub-agent spawning from a program) ───
const VALID_WORKER_SPEC = {
  objective: 'Summarize the sentiment of one review',
  item: 'review-42',
  resolvedTools: 'none needed',
  context: 'Review text: "great product, fast shipping"',
  instructions: 'Return one word: positive, negative, or neutral.',
  expectedOutput: '{ "sentiment": "positive|negative|neutral" }',
  intent: null,
};

test('clem.run_worker: recursion guard refuses a worker spawned INSIDE a worker (depth ≤ 1)', async () => {
  const { dispatchCodeModeTool, _setCodeModeWorkerRunnerForTests } = await import('./code-mode-tool.js');
  const { withHarnessRunContext, ToolCallsCounter } = await import('../runtime/harness/brackets.js');
  _setCodeModeWorkerRunnerForTests(async () => ({ text: 'should-not-run', model: 'x' }));
  try {
    // guardrailScopeId set → we are inside a worker run → run_worker must refuse.
    const out = await withHarnessRunContext(
      { sessionId: 'sess-w', counter: new ToolCallsCounter(100), guardrailScopeId: 'sess-w::w:1' },
      () => dispatchCodeModeTool('run_worker', VALID_WORKER_SPEC, 'sess-w', new ToolCallsCounter(100)),
    ) as { ok: boolean; error?: string };
    assert.equal(out.ok, false);
    assert.match(out.error ?? '', /worker-of-worker|inside a worker/);
  } finally {
    _setCodeModeWorkerRunnerForTests(null);
  }
});

test('clem.run_worker: per-program count cap refuses beyond the limit', async () => {
  const { dispatchCodeModeTool, _setCodeModeWorkerRunnerForTests } = await import('./code-mode-tool.js');
  const { ToolCallsCounter } = await import('../runtime/harness/brackets.js');
  _setCodeModeWorkerRunnerForTests(async () => ({ text: 'ok', model: 'x' }));
  const counter = new ToolCallsCounter(100); // ONE program run
  try {
    for (let i = 0; i < 4; i++) {
      const out = await dispatchCodeModeTool('run_worker', VALID_WORKER_SPEC, 'sess-cap', counter) as { ok: boolean };
      assert.equal(out.ok, true, `worker ${i + 1} of 4 should run`);
    }
    const overflow = await dispatchCodeModeTool('run_worker', VALID_WORKER_SPEC, 'sess-cap', counter) as { ok: boolean; error?: string };
    assert.equal(overflow.ok, false, '5th worker refused');
    assert.match(overflow.error ?? '', /limit reached/);
  } finally {
    _setCodeModeWorkerRunnerForTests(null);
  }
});

test('clem.run_worker: invalid spec returns a structured error (no dispatch)', async () => {
  const { dispatchCodeModeTool } = await import('./code-mode-tool.js');
  const { ToolCallsCounter } = await import('../runtime/harness/brackets.js');
  const out = await dispatchCodeModeTool('run_worker', { objective: 'too short' }, 'sess-bad', new ToolCallsCounter(100)) as { ok: boolean; error?: string };
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /invalid spec/);
});

test('clem.run_worker: kill-switch CLEMMY_CODE_MODE_WORKERS=off disables it', async () => {
  const { dispatchCodeModeTool } = await import('./code-mode-tool.js');
  const { ToolCallsCounter } = await import('../runtime/harness/brackets.js');
  const prev = process.env.CLEMMY_CODE_MODE_WORKERS;
  process.env.CLEMMY_CODE_MODE_WORKERS = 'off';
  try {
    const out = await dispatchCodeModeTool('run_worker', VALID_WORKER_SPEC, 'sess-off', new ToolCallsCounter(100)) as { ok: boolean; error?: string };
    assert.equal(out.ok, false);
    assert.match(out.error ?? '', /disabled/);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CODE_MODE_WORKERS; else process.env.CLEMMY_CODE_MODE_WORKERS = prev;
  }
});

test('a PROGRAM can fetch then fan out clem.run_worker on the result (the north-star shape)', async () => {
  const { runCodeModeForSession, _setCodeModeToolsForTests, _setCodeModeWorkerRunnerForTests } = await import('./code-mode-tool.js');
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'off';
  _setCodeModeToolsForTests(new Map([
    ['memory_search', { name: 'memory_search', invoke: async () => ({ items: ['a', 'b'] }) }],
  ]));
  // fake worker echoes the item it was given
  _setCodeModeWorkerRunnerForTests(async (input) => ({ text: `judged:${input.item}`, model: 'test' }));
  try {
    const r = await runCodeModeForSession(
      `const found = await clem.memory_search({ q: 'x' });
       const out = [];
       for (const item of found.items) {
         const w = await clem.run_worker({ objective: 'judge one item here', item, resolvedTools: 'none needed', context: 'ctx', instructions: 'do it', expectedOutput: '{}', intent: null });
         out.push(w.ok ? w.text : ('ERR:' + w.error));
       }
       return { verdicts: out };`,
      'sess-fanout',
    );
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.value, { verdicts: ['judged:a', 'judged:b'] });
  } finally {
    _setCodeModeToolsForTests(null);
    _setCodeModeWorkerRunnerForTests(null);
    if (prevBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS; else process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
  }
});

// ─── Track 4: clem.describe + result handles ───
test('clem.describe returns schema info for a local tool and never dispatches it', async () => {
  const { describeCodeModeTool } = await import('./code-mode-tool.js');
  const d = await describeCodeModeTool('list_files') as { name: string; allowed: boolean; source: string; parameters?: unknown };
  assert.equal(d.name, 'list_files');
  assert.equal(d.allowed, true);
  assert.equal(d.source, 'local');
  const unknown = await describeCodeModeTool('no_such_tool_xyz') as { allowed: boolean; error?: string };
  assert.equal(unknown.allowed, false);
  assert.match(unknown.error ?? '', /unknown tool/);
});

// Move 4 / G4: describe now returns the REAL schema for external MCP tools (was a
// prose note) so the model stops guessing arg shapes for the batch case.
test('clem.describe returns the real inputSchema for an external MCP tool', async () => {
  const { describeCodeModeTool, _setExternalMcpToolsForTests } = await import('./code-mode-tool.js');
  const schema = { type: 'object', properties: { keyword: { type: 'string' }, location: { type: 'number' } }, required: ['keyword'] };
  _setExternalMcpToolsForTests(async () => [
    { name: 'dataforseo__serp_organic_live_advanced', description: 'SERP organic results', inputSchema: schema },
  ]);
  try {
    const mcp = await describeCodeModeTool('dataforseo__serp_organic_live_advanced') as { source: string; parameters?: unknown; description?: string };
    assert.equal(mcp.source, 'mcp');
    assert.deepEqual(mcp.parameters, schema, 'the real arg schema is surfaced, not a prose note');
    assert.match(mcp.description ?? '', /SERP organic/);
    // a name not in the connected set → graceful pointer to listTools, still source mcp
    const miss = await describeCodeModeTool('dataforseo__not_a_tool') as { source: string; note?: string };
    assert.equal(miss.source, 'mcp');
    assert.match(miss.note ?? '', /listTools/);
  } finally {
    _setExternalMcpToolsForTests(null);
  }
});

test('a PROGRAM can call clem.listTools() and clem.describe() through the sandbox (real dispatch)', async () => {
  const { runCodeModeForSession, _setExternalMcpToolsForTests } = await import('./code-mode-tool.js');
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'off';
  _setExternalMcpToolsForTests(async () => [
    { name: 'dataforseo__serp', description: 'SERP results', inputSchema: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] } },
  ]);
  try {
    const r = await runCodeModeForSession(
      `const list = await clem.listTools();
       const schema = await clem.describe('dataforseo__serp');
       return { count: list.mcp.length, name: list.mcp[0].name, params: schema.parameters };`,
      'sess-codemode-describe',
    );
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.value, {
      count: 1,
      name: 'dataforseo__serp',
      params: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] },
    });
  } finally {
    _setExternalMcpToolsForTests(null);
    if (prevBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS; else process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
  }
});

test('clem.listTools enumerates built-in + connected MCP tools for discovery', async () => {
  const { listCodeModeTools, _setExternalMcpToolsForTests } = await import('./code-mode-tool.js');
  _setExternalMcpToolsForTests(async () => [
    { name: 'dataforseo__serp_organic_live_advanced', description: 'x'.repeat(300) },
    { name: 'salesforce__query', description: 'SOQL query' },
  ]);
  try {
    const out = await listCodeModeTools() as { builtin: string[]; mcp: Array<{ name: string; description: string }>; note: string };
    assert.ok(out.builtin.includes('read_file'), 'lists built-in read tools');
    assert.equal(out.mcp.length, 2);
    assert.equal(out.mcp[0].name, 'dataforseo__serp_organic_live_advanced');
    assert.ok(out.mcp[0].description.length <= 120, 'descriptions are bounded');
    assert.match(out.note, /describe/);
  } finally {
    _setExternalMcpToolsForTests(null);
  }
  // no MCP connected → empty list + honest note
  _setExternalMcpToolsForTests(async () => []);
  try {
    const out = await listCodeModeTools() as { mcp: unknown[]; note: string };
    assert.equal(out.mcp.length, 0);
    assert.match(out.note, /no external MCP/);
  } finally {
    _setExternalMcpToolsForTests(null);
  }
});

test('dispatchBatchItemTool establishes tool-output context for the inner tool (background-handoff regression)', async () => {
  // Live 2026-07-09: dispatch_background_task reached via call_tool refused
  // with "no session context here" — the code-mode dispatch set the harness
  // GATE context but never the tool-output ALS the inner tool reads.
  const { dispatchBatchItemTool, _setCodeModeToolsForTests } = await import('./code-mode-tool.js');
  const { getToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
  const { ToolCallsCounter, withHarnessRunContext, harnessRunContextStorage } = await import('../runtime/harness/brackets.js');
  _setCodeModeToolsForTests(new Map([
    ['ctx_probe', {
      name: 'ctx_probe',
      invoke: async () => JSON.stringify({
        seenSessionId: getToolOutputContext()?.sessionId ?? null,
        seenSourceUserSeq: harnessRunContextStorage.getStore()?.sourceUserSeq ?? null,
      }),
    }],
  ]) as never);
  try {
    const out = await withHarnessRunContext(
      { sessionId: 'sess-ctx-regression', sourceUserSeq: 42, counter: new ToolCallsCounter(10) },
      () => dispatchBatchItemTool('ctx_probe', {}, 'sess-ctx-regression', new ToolCallsCounter(10)),
    ) as { seenSessionId?: string | null; seenSourceUserSeq?: number | null };
    assert.equal(out?.seenSessionId, 'sess-ctx-regression', 'inner tool must see the session via getToolOutputContext');
    assert.equal(out?.seenSourceUserSeq, 42, 'inner tool must retain the exact source turn instead of consulting the latest ambient user input');
  } finally {
    _setCodeModeToolsForTests(null);
  }
});
