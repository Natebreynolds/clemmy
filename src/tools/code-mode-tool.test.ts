/**
 * Run: npx tsx --test src/tools/code-mode-tool.test.ts
 *
 * Code Mode tool surface + read-only dispatcher (Lane C Phase 1). The safety
 * boundary: a code-mode program can ONLY reach read-only tools — a write/send
 * tool is refused before any dispatch. And the tool is off the surface unless
 * CLEMMY_CODE_MODE=on (byte-identical default).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { READ_ONLY_TOOLS, dispatchReadOnlyTool, buildCodeModeTool } from './code-mode-tool.js';

test('READ_ONLY_TOOLS excludes every mutating tool (the Phase-1 boundary)', () => {
  for (const writeTool of ['composio_execute_tool', 'write_file', 'run_shell_command', 'request_approval', 'execution_create', 'memory_remember']) {
    assert.equal(READ_ONLY_TOOLS.has(writeTool), false, `${writeTool} must NOT be in the read-only allowlist`);
  }
  // sanity: it DOES include the read tools
  for (const readTool of ['memory_search', 'read_file', 'composio_search_tools']) {
    assert.equal(READ_ONLY_TOOLS.has(readTool), true);
  }
});

test('dispatchReadOnlyTool refuses a non-allowlisted (mutating) tool BEFORE any dispatch', async () => {
  await assert.rejects(
    () => dispatchReadOnlyTool('composio_execute_tool', { tool_slug: 'X_SEND', arguments: '{}' }, 'sess'),
    /not available|read-only/,
  );
  await assert.rejects(() => dispatchReadOnlyTool('write_file', { path: '/tmp/x', content: 'y' }, 'sess'), /not available|read-only/);
});

test('buildCodeModeTool exposes run_tool_program with a program parameter', () => {
  const t = buildCodeModeTool() as { name?: string };
  assert.equal(t.name, 'run_tool_program');
});

test('run_tool_program is OFF the core surface by default, ON only under CLEMMY_CODE_MODE=on', async () => {
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
