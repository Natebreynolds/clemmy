/**
 * Run: npx tsx --test src/runtime/harness/auto-invalidate.test.ts
 *
 * Evolving procedural memory: a remembered tool choice that HARD-fails is
 * auto-invalidated so the next run rediscovers. Conservative — only on
 * binary/connection/server-broken signals, never on arg-level or transient
 * errors. Per-test temp CLEMENTINE_HOME so we don't touch real state.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-auto-invalidate-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'memory'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { autoInvalidateOnFailure } = await import('./auto-invalidate.js');
const { rememberToolChoice, peekToolChoice } = await import('../../memory/tool-choice-store.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

function remember(intent: string, kind: 'composio' | 'cli' | 'mcp', identifier: string): void {
  rememberToolChoice({ intent, choice: { kind, identifier } });
  assert.equal(peekToolChoice(intent)?.choice?.identifier, identifier, 'precondition: choice active');
}

test('Composio FAILED auto-invalidates the matching memo (and records a fallback)', () => {
  remember('pull serp rankings', 'composio', 'DATAFORSEO_SERP_GOOGLE_ORGANIC');
  autoInvalidateOnFailure({
    toolName: 'composio_execute_tool',
    args: '{"tool_slug":"DATAFORSEO_SERP_GOOGLE_ORGANIC","arguments":"{}"}',
    resultStr: '⚠️ composio_execute_tool FAILED (slug=DATAFORSEO_SERP_GOOGLE_ORGANIC): 401 unauthorized',
  });
  const rec = peekToolChoice('pull serp rankings');
  assert.equal(rec?.choice, null, 'active choice cleared');
  assert.ok(rec?.fallbacks.some((f) => f.identifier === 'DATAFORSEO_SERP_GOOGLE_ORGANIC'), 'failed choice moved to fallbacks');
});

test('Composio NOT FOUND does NOT invalidate (arg/discovery problem, tool is fine)', () => {
  remember('list airtable records', 'composio', 'AIRTABLE_LIST_RECORDS');
  autoInvalidateOnFailure({
    toolName: 'composio_execute_tool',
    args: '{"tool_slug":"AIRTABLE_LIST_RECORDS"}',
    resultStr: '⚠️ composio_execute_tool NOT FOUND (slug=AIRTABLE_LIST_RECORDS): no such table',
  });
  assert.equal(peekToolChoice('list airtable records')?.choice?.identifier, 'AIRTABLE_LIST_RECORDS', 'NOT FOUND keeps the memo');
});

test('Composio success (no failure header) does NOT invalidate', () => {
  remember('search drive', 'composio', 'GOOGLEDRIVE_SEARCH');
  autoInvalidateOnFailure({
    toolName: 'composio_execute_tool',
    args: '{"tool_slug":"GOOGLEDRIVE_SEARCH"}',
    resultStr: '{"data":{"files":[]},"successful":true}',
  });
  assert.equal(peekToolChoice('search drive')?.choice?.identifier, 'GOOGLEDRIVE_SEARCH');
});

test('CLI binary-gone (command not found) auto-invalidates the cli memo', () => {
  remember('salesforce.count', 'cli', 'sf');
  autoInvalidateOnFailure({
    toolName: 'run_shell_command',
    args: '{"command":"sf data query --query \\"SELECT count() FROM Account\\""}',
    resultStr: 'sf: command not found',
  });
  assert.equal(peekToolChoice('salesforce.count')?.choice, null, 'binary-gone clears the cli memo');
});

test('CLI plain non-zero exit does NOT invalidate (transient / user error)', () => {
  remember('git status check', 'cli', 'git');
  autoInvalidateOnFailure({
    toolName: 'run_shell_command',
    args: '{"command":"git status"}',
    resultStr: 'exit_code: 1\nfatal: not a git repository',
  });
  assert.equal(peekToolChoice('git status check')?.choice?.identifier, 'git', 'a normal failure keeps the memo');
});

test('MCP server_unavailable auto-invalidates the mcp memo', () => {
  remember('serp via native mcp', 'mcp', 'dataforseo__dataforseo_labs_google_ranked_keywords');
  autoInvalidateOnFailure({
    toolName: 'dataforseo__dataforseo_labs_google_ranked_keywords',
    args: '{}',
    resultStr: 'BoundaryError: mcp.server_unavailable slug=dataforseo failureCount=5',
  });
  assert.equal(peekToolChoice('serp via native mcp')?.choice, null);
});

test('MCP approval_blocked does NOT invalidate (a gate, not a broken server)', () => {
  remember('send via mcp', 'mcp', 'outlook__send_mail');
  autoInvalidateOnFailure({
    toolName: 'outlook__send_mail',
    args: '{}',
    resultStr: 'BoundaryError: mcp.approval_blocked tool=outlook__send_mail',
  });
  assert.equal(peekToolChoice('send via mcp')?.choice?.identifier, 'outlook__send_mail');
});

test('ambiguous identifier (two intents → same tool) is left to the agent (no auto-forget)', () => {
  remember('salesforce.count.a', 'cli', 'sfdup');
  remember('salesforce.count.b', 'cli', 'sfdup');
  autoInvalidateOnFailure({
    toolName: 'run_shell_command',
    args: '{"command":"sfdup whatever"}',
    resultStr: 'sfdup: command not found',
  });
  assert.equal(peekToolChoice('salesforce.count.a')?.choice?.identifier, 'sfdup', 'ambiguous → neither invalidated');
  assert.equal(peekToolChoice('salesforce.count.b')?.choice?.identifier, 'sfdup');
});
