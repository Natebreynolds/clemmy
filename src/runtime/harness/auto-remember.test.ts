/**
 * Run: npx tsx --test src/runtime/harness/auto-remember.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectNativeMcpSuccess, detectRememberableSuccess, autoRememberOnSuccess } from './auto-remember.js';
import { appendEvent, createSession, resetEventLog } from './eventlog.js';
import { peekToolChoice } from '../../memory/tool-choice-store.js';
import { withToolOutputContext } from './tool-output-context.js';

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

test('detectNativeMcpSuccess: structured failure envelopes never poison procedural memory', () => {
  for (const result of [
    '{"ok":false,"error":"permission denied"}',
    '{"success":false,"message":"unauthorized"}',
    '{"successful":false,"error":{"message":"request refused"}}',
    '{"isError":true,"content":"authentication required"}',
  ]) {
    assert.equal(
      detectNativeMcpSuccess('airtable__list_records', result),
      null,
      `must reject ${result}`,
    );
  }
});

test('detectNativeMcpSuccess: auth, permission, and refusal text never count as success', () => {
  for (const result of [
    'Permission denied for this workspace.',
    'Unauthorized: reconnect the integration.',
    'Authentication required before calling this tool.',
    'Tool call refused by harness.',
    'Access forbidden for this account.',
  ]) {
    assert.equal(
      detectNativeMcpSuccess('airtable__list_records', result),
      null,
      `must reject ${result}`,
    );
  }
});

test('detectNativeMcpSuccess: empty inputs are safe', () => {
  assert.equal(detectNativeMcpSuccess(null, 'x'), null);
  assert.equal(detectNativeMcpSuccess('notion__create_page', ''), null);
  assert.equal(detectNativeMcpSuccess(undefined, undefined), null);
});

test('detectRememberableSuccess: a clean Composio execute memorizes the slug', () => {
  const r = detectRememberableSuccess(
    'composio_execute_tool',
    'Returned 12 open tasks.',
    { tool_slug: 'SALESFORCE_SEARCH_TASKS' },
  );
  assert.deepEqual(r, { identifier: 'SALESFORCE_SEARCH_TASKS', kind: 'composio' });
});

test('detectRememberableSuccess: work_call inner Composio and MCP succeed', () => {
  assert.deepEqual(
    detectRememberableSuccess('work_call', 'ok', {
      name: 'composio_execute_tool',
      args: { tool_slug: 'OUTLOOK_LIST_MESSAGES' },
    }),
    { identifier: 'OUTLOOK_LIST_MESSAGES', kind: 'composio' },
  );
  assert.deepEqual(
    detectRememberableSuccess('call_tool', 'Created page abc123 in workspace.', {
      name: 'notion__create_page',
    }),
    { identifier: 'notion__create_page', kind: 'mcp' },
  );
});

test('detectRememberableSuccess: a clean host CLI read is remembered generically', () => {
  const r = detectRememberableSuccess(
    'run_shell_command',
    'exit_code: 0\n\nstdout:\n{"status":0,"result":{"records":[{"mrr":62947}]}}\n',
    {
      command: 'sf data query --json --query "SELECT SUM(Net_MRR__c) mrr FROM Opportunity WHERE IsWon = true AND CloseDate = THIS_WEEK"',
    },
  );
  assert.deepEqual(r, {
    identifier: 'sf',
    kind: 'cli',
    invocationTemplate: 'sf data query --json --query "{{arg}}"',
  });
});

test('detectRememberableSuccess: a failed host CLI JSON status is not a success', () => {
  assert.equal(
    detectRememberableSuccess(
      'run_shell_command',
      'exit_code: 0\n\nstdout:\n{"status":1,"name":"INVALID_FIELD","message":"bad soql"}\n',
      { command: 'sf data query --json --query "SELECT Missing FROM Opportunity"' },
    ),
    null,
  );
});

test('detectRememberableSuccess: a non-zero exit_code is not a success', () => {
  assert.equal(
    detectRememberableSuccess(
      'run_shell_command',
      'exit_code: 1\n\nstderr:\nError: not found\n',
      { command: 'gh api user' },
    ),
    null,
  );
});

test('detectRememberableSuccess: shell builtins are not remembered as host CLIs', () => {
  assert.equal(
    detectRememberableSuccess('run_shell_command', 'exit_code: 0\nREADME.md\n', {
      command: 'ls -la',
    }),
    null,
  );
});

test('detectRememberableSuccess: mutating host CLI writes are not remembered as reads', () => {
  assert.equal(
    detectRememberableSuccess('run_shell_command', 'exit_code: 0\nupdated', {
      command: 'sf data update record --sobject Opportunity --record-id 006xx --values "StageName=Closed Won"',
    }),
    null,
  );
});

test('detectRememberableSuccess: failed Composio executes are not successes', () => {
  assert.equal(
    detectRememberableSuccess('composio_execute_tool', 'ERROR: reconnect required', {
      tool_slug: 'SALESFORCE_SEARCH_TASKS',
    }),
    null,
  );
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

test('autoRememberOnSuccess: CLI aliases bind the originating accepted ask, not a later message', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const origin = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'What is the net MRR we sold as a team this week?' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: "What's 2x3" },
  });
  withToolOutputContext({ sessionId: sess.id, sourceUserSeq: origin.seq }, () => {
    autoRememberOnSuccess({
      toolName: 'run_shell_command',
      resultStr: 'exit_code: 0\n\nstdout:\n{"status":0,"result":{"records":[{"mrr":1}]}}\n',
      args: { command: 'sf data query --json --query "SELECT Id FROM Opportunity"' },
      sessionId: sess.id,
      sourceUserSeq: origin.seq,
    });
  });
  const stored = peekToolChoice('sf.data.query');
  assert.ok(stored?.aliases?.some((alias) => /net MRR we sold/i.test(alias.intent)), JSON.stringify(stored?.aliases));
  assert.equal(stored?.aliases?.some((alias) => /2x3/.test(alias.intent)), false);
});
