/**
 * Run: npx tsx --test src/runtime/harness/auto-remember.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectNativeMcpSuccess, autoRememberOnSuccess } from './auto-remember.js';

test('detectNativeMcpSuccess: a clean namespaced MCP result is remembered', () => {
  const r = detectNativeMcpSuccess('notion__create_page', 'Created page abc123 in workspace.');
  assert.deepEqual(r, { identifier: 'notion__create_page' });
});

test('detectNativeMcpSuccess: composio dynamic tools (cx_) are NOT treated as native MCP', () => {
  assert.equal(detectNativeMcpSuccess('cx_airtable_create', 'ok done'), null);
});

test('detectNativeMcpSuccess: non-namespaced tools are ignored', () => {
  assert.equal(detectNativeMcpSuccess('run_shell_command', 'exit_code: 0'), null);
  assert.equal(detectNativeMcpSuccess('memory_recall', 'some facts'), null);
});

test('detectNativeMcpSuccess: error / unavailable / approval results are not successes', () => {
  assert.equal(detectNativeMcpSuccess('slack__post_message', '⚠️ FAILED: rate limited'), null);
  assert.equal(detectNativeMcpSuccess('slack__post_message', 'ERROR: boom'), null);
  assert.equal(detectNativeMcpSuccess('airtable__list_records', 'server_unavailable'), null);
  assert.equal(detectNativeMcpSuccess('airtable__list_records', 'approval_blocked: needs ok'), null);
  assert.equal(detectNativeMcpSuccess('airtable__list_records', 'NOT FOUND: base missing'), null);
});

test('detectNativeMcpSuccess: empty inputs are safe', () => {
  assert.equal(detectNativeMcpSuccess(null, 'x'), null);
  assert.equal(detectNativeMcpSuccess('notion__create_page', ''), null);
  assert.equal(detectNativeMcpSuccess(undefined, undefined), null);
});

test('autoRememberOnSuccess: kill-switch off is a silent no-op (no throw, no write)', () => {
  const prev = process.env.CLEMMY_SCOPE_FROM_RECALL;
  try {
    process.env.CLEMMY_SCOPE_FROM_RECALL = 'off';
    assert.doesNotThrow(() =>
      autoRememberOnSuccess({ toolName: 'notion__create_page', resultStr: 'Created page.' }),
    );
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_SCOPE_FROM_RECALL;
    else process.env.CLEMMY_SCOPE_FROM_RECALL = prev;
  }
});

test('autoRememberOnSuccess: a non-success never writes (no throw)', () => {
  assert.doesNotThrow(() =>
    autoRememberOnSuccess({ toolName: 'slack__post_message', resultStr: '⚠️ FAILED' }),
  );
});
