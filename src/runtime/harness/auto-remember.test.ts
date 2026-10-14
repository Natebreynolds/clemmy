/**
 * Run: npx tsx --test src/runtime/harness/auto-remember.test.ts
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { detectNativeMcpSuccess, detectRememberableSuccess, autoRememberOnSuccess } from './auto-remember.js';
import { appendEvent, createSession, resetEventLog, openEventLog, closeEventLog } from './eventlog.js';
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


// The external isolated runner binds config before this file's static imports.
assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1', 'auto-remember tests require the disposable-home runner');
const { withAcceptedSourceSessionContext } = await import('./source-session-context.js');
const { harnessRunContextStorage } = await import('./brackets.js');
const { createFocus } = await import('../../memory/focus.js');
const { closeMemoryDb } = await import('../../memory/db.js');
after(() => { closeEventLog(); closeMemoryDb(); });
const EXCLUDED_LEARNING = { version: 1, mode: 'exclude', reason: 'controlled_test' } as const;
let procedureSourceSerial = 0;
function procedureSource(policy?: unknown, text = 'Inspect the controlled procedure.') {
  const session = createSession({ id: `auto-procedure-source-${++procedureSourceSerial}`, kind: 'chat' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text, ...(policy === undefined ? {} : { learningPolicy: policy }) } });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

test('autoRememberOnSuccess: excluded and unreadable exact sources create no memo or alias, ordinary sibling still learns', () => {
  const excluded = procedureSource(EXCLUDED_LEARNING, 'Excluded procedure phrase.');
  const normalRow = appendEvent({ sessionId: excluded.sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Ordinary procedure phrase.' } });
  const normal = { sessionId: excluded.sessionId, sourceUserSeq: normalRow.seq };
  const success = { toolName: 'fixture__policy_read', resultStr: 'Returned controlled rows.' };
  for (const identity of [excluded, { sessionId: excluded.sessionId },
    { ...excluded, sourceUserSeq: 0 }, { ...excluded, sourceUserSeq: normalRow.seq + 100000 },
    { sessionId: 'foreign-procedure-session', sourceUserSeq: normalRow.seq }]) {
    autoRememberOnSuccess({ ...success, ...identity });
    assert.equal(peekToolChoice('fixture.policy_read'), null);
  }
  withAcceptedSourceSessionContext(normal, () => {
    autoRememberOnSuccess({ ...success, ...excluded });
    assert.equal(peekToolChoice('fixture.policy_read'), null, 'explicit excluded source cannot borrow an ordinary current sibling');
    autoRememberOnSuccess({ ...success, sessionId: normal.sessionId });
  }, { newlyAccepted: true });
  const memo = peekToolChoice('fixture.policy_read');
  assert.ok(memo?.choice);
  assert.ok(memo.aliases?.some(alias => alias.intent === 'Ordinary procedure phrase.'));
  assert.equal(memo.aliases?.some(alias => alias.intent === 'Excluded procedure phrase.'), false);
});

test('autoRememberOnSuccess: an excluded CLI success cannot enrich an existing canonical operation', () => {
  const normal = procedureSource(undefined, 'Read the controlled CLI summary.');
  const input = { toolName: 'run_shell_command', resultStr: 'exit_code: 0\n{"status":0}',
    args: { command: 'sf data query --json --query "SELECT Id FROM Opportunity"' } };
  autoRememberOnSuccess({ ...input, ...normal });
  const before = peekToolChoice('sf.data.query');
  assert.ok(before?.aliases?.some(alias => alias.intent === 'Read the controlled CLI summary.'));
  autoRememberOnSuccess({ ...input, ...procedureSource(EXCLUDED_LEARNING, 'Never attach this controlled alias.') });
  assert.deepEqual(peekToolChoice('sf.data.query'), before, 'exclusion leaves old procedure and aliases byte-equivalent');
});

test('autoRememberOnSuccess: known ambient session is not standalone and exact empty source never adopts later focus', () => {
  const excluded = procedureSource(EXCLUDED_LEARNING);
  harnessRunContextStorage.run({ ...excluded } as never, () => {
    autoRememberOnSuccess({ toolName: 'fixture__ambient_read', resultStr: 'Returned controlled rows.' });
  });
  assert.equal(peekToolChoice('fixture.ambient_read'), null, 'a known session without validated source scope cannot learn');
  createFocus({ resourceRef: 'controlled:standalone-procedure', title: 'Standalone procedure', summary: 'Controlled maintenance context.' });
  autoRememberOnSuccess({ toolName: 'fixture__standalone_read', resultStr: 'Returned controlled rows.' });
  assert.ok(peekToolChoice('fixture.standalone_read')?.choice, 'true no-session standalone maintenance remains supported');
  const empty = procedureSource(undefined, '');
  autoRememberOnSuccess({ toolName: 'fixture__empty_read', resultStr: 'Returned controlled rows.', ...empty });
  assert.equal(peekToolChoice('fixture.empty_read'), null, 'known exact source with no ask cannot use global focus');
});

test('autoRememberOnSuccess: policy is reopened immediately before the memo write', () => {
  const source = procedureSource();
  autoRememberOnSuccess({ ...source, toolName: 'fixture__revoked_read', resultStr: 'Returned controlled rows.',
    get args() {
      openEventLog().prepare('UPDATE events SET data_json=? WHERE session_id=? AND seq=?')
        .run(JSON.stringify({ text: 'Inspect the controlled procedure.', learningPolicy: EXCLUDED_LEARNING }), source.sessionId, source.sourceUserSeq);
      return undefined;
    },
  });
  assert.equal(peekToolChoice('fixture.revoked_read'), null);
});
