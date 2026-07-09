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
import { READ_ONLY_TOOLS, dispatchCodeModeTool, buildCodeModeTool, isCodeModeToolAllowed, isMcpNamespacedTool, codeModeMandateDirective } from './code-mode-tool.js';

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
      () => dispatchCodeModeTool('composio_execute_tool', { tool_slug: 'OUTLOOK_SEND_EMAIL', arguments: '{"to":"a@b.com"}' }, 'sess'),
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

test('codeModeMandateDirective: kill-switches respect CODE_MODE_MANDATE and CODE_MODE', () => {
  const prevM = process.env.CLEMMY_CODE_MODE_MANDATE;
  const prevC = process.env.CLEMMY_CODE_MODE;
  try {
    process.env.CLEMMY_CODE_MODE = 'on';
    process.env.CLEMMY_CODE_MODE_MANDATE = 'off';
    assert.equal(codeModeMandateDirective({ mcpServersInScope: 3 }), '', 'mandate kill-switch silences it');
    process.env.CLEMMY_CODE_MODE_MANDATE = 'on';
    process.env.CLEMMY_CODE_MODE = 'off';
    assert.equal(codeModeMandateDirective({ mcpServersInScope: 3 }), '', 'no mandate when code mode itself is off');
  } finally {
    if (prevM === undefined) delete process.env.CLEMMY_CODE_MODE_MANDATE; else process.env.CLEMMY_CODE_MODE_MANDATE = prevM;
    if (prevC === undefined) delete process.env.CLEMMY_CODE_MODE; else process.env.CLEMMY_CODE_MODE = prevC;
  }
});

test('buildCodeModeTool exposes run_tool_program with a program parameter', () => {
  const t = buildCodeModeTool() as { name?: string };
  assert.equal(t.name, 'run_tool_program');
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
  const mcp = await describeCodeModeTool('dataforseo__serp_organic_live_advanced') as { source: string };
  assert.equal(mcp.source, 'mcp');
});
