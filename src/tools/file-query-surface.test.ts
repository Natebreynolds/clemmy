/** Run: node scripts/run-tests-isolated.mjs src/tools/file-query-surface.test.ts
 *
 * RESTART-GATE PIN — a landed tool result must be queryable.
 *
 * Live 2026-08-18 (sess-synthetic-004): one Firecrawl search returned ~322k chars;
 * the model called `file_query` by name and got
 * "No such tool available: mcp__clementine-local__file_query" because the JIT
 * allowlist filter dropped its registration; the fallback was 37 pages of
 * recall_tool_result and a request for a SECOND search. These pin the fix:
 * file_query is floor-registered on the local MCP server under ANY allowlist,
 * and it rides the always-loaded hot set beside its recall-class siblings so
 * its schema is advertised without a discovery round. It is a READ — it never
 * requires work_call.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-file-query-surface-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { createClementineMcpServer } = await import('./mcp-server.js');
const { TOOL_SEARCH_ALWAYS_LOADED, resolveHotSet } = await import('../agents/tool-catalog.js');
const { actionTopologyRoleFor } = await import('./tool-registry.js');

after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('file_query survives a JIT allowlist that does not name it — the exact live error cannot recur', () => {
  const registered: string[] = [];
  createClementineMcpServer({
    // The live turn's shape: a narrow schema-on-demand allowlist with no
    // file_query in it.
    allowedTools: ['tool_search', 'call_tool', 'memory_recall_all'],
    onToolRegistered: (name) => { registered.push(name); },
  });
  assert.ok(registered.includes('file_query'),
    'floor registration: mcp__clementine-local__file_query must always resolve');
  assert.ok(registered.includes('ping'), 'the health floor is intact');
  assert.ok(!registered.includes('composio_execute_tool'),
    'the floor is surgical — it does not unfilter the rest of the surface');
});

test('file_query is in the always-loaded recall class, so the hot set advertises its schema', () => {
  assert.ok(TOOL_SEARCH_ALWAYS_LOADED.has('file_query'));
  const hot = resolveHotSet('sess-any', 'summarize what that big search result says about pricing', {
    allowedNames: new Set(['file_query', 'tool_search', 'memory_recall_all', 'composio_execute_tool']),
  });
  assert.ok([...hot].includes('file_query'),
    'no discovery round needed: the tool she called is first-class on the surface');
});

test('file_query is a READ, never routed through the business work carrier', () => {
  assert.notEqual(actionTopologyRoleFor('file_query'), 'business',
    'a stored-output query must not require work_call / a frozen write binding');
});
