import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-pending-action-recipient-integrity';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { registerPendingActionTools } = await import('./pending-action-tools.js');
const { appendEvent, createSession, resetEventLog, writeToolOutput } = await import('../runtime/harness/eventlog.js');
const {
  claimPendingActionExecution,
  getPendingAction,
  listPendingActions,
  markPendingActionApprovalResolved,
  queuePendingAction,
  recordPendingActionResult,
} = await import('../runtime/harness/pending-actions.js');

function handlerFor(name: string): (input: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>>();
  registerPendingActionTools({
    tool(toolName: string, ...args: unknown[]) {
      handlers.set(toolName, args.at(-1) as (input: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>);
    },
  } as never);
  const handler = handlers.get(name);
  if (!handler) throw new Error(`missing ${name}`);
  return handler;
}

before(() => rmSync(TEST_HOME, { recursive: true, force: true }));
beforeEach(() => {
  resetEventLog();
  rmSync(`${TEST_HOME}/pending-actions`, { recursive: true, force: true });
});
after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

test('pending_action_queue refuses a fabricated multi-recipient payload before an approval card exists', async () => {
  const session = createSession({ kind: 'chat' });
  const correct = ['avery@example.com', 'blair@example.com', 'casey@example.com'];
  const outgoing = ['avery@example.com', 'jamie@example.com', 'jules@example.com'];
  writeToolOutput({
    sessionId: session.id,
    callId: 'team-source',
    tool: 'memory_recall_all',
    output: `Complete team: ${correct.join(', ')}`,
  });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'memory_recall_all', callId: 'team-source', effect: 'read', result: 'stored' },
  });

  const response = await handlerFor('pending_action_queue')({
    title: 'Invite the team',
    summary: 'Create one calendar invite for the saved team roster.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payloadJson: JSON.stringify({
      tool_slug: 'OUTLOOK_CREATE_EVENT',
      arguments: JSON.stringify({ attendees: outgoing.map((email) => ({ email })) }),
    }),
    sessionId: session.id,
  });

  assert.match(response.content[0].text, /RECIPIENT_SET_INTEGRITY_FAILED/);
  assert.match(response.content[0].text, /jamie@example\.com/);
  assert.equal(listPendingActions({ sessionId: session.id }).length, 0, 'no misleading approval artifact is created');
});

test('pending_action_queue accepts the exact source-backed recipient set', async () => {
  const session = createSession({ kind: 'chat' });
  const correct = ['avery@example.com', 'blair@example.com', 'casey@example.com'];
  writeToolOutput({ sessionId: session.id, callId: 'team-source', tool: 'memory_recall_all', output: correct.join(', ') });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'memory_recall_all', callId: 'team-source', effect: 'read', result: 'stored' },
  });

  const response = await handlerFor('pending_action_queue')({
    title: 'Invite the team',
    summary: 'Create one calendar invite for the saved team roster.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payloadJson: JSON.stringify({
      tool_slug: 'OUTLOOK_CREATE_EVENT',
      arguments: JSON.stringify({ attendees: correct.map((email) => ({ email })) }),
    }),
    sessionId: session.id,
  });

  assert.match(response.content[0].text, /Pending action queued/);
  assert.match(response.content[0].text, /call request_approval ONCE now/);
  assert.match(response.content[0].text, /approval card is the single user confirmation/);
  assert.match(response.content[0].text, /pending_action_execute/);
  assert.equal(listPendingActions({ sessionId: session.id }).length, 1);
});

test('pending_action_queue keeps a reversible local action on the lighter conversational path', async () => {
  const session = createSession({ kind: 'chat' });
  const response = await handlerFor('pending_action_queue')({
    title: 'Save local draft',
    summary: 'Save a reversible local draft in the current workspace.',
    kind: 'local_file_write',
    toolName: 'write_file',
    payloadJson: JSON.stringify({
      path: 'draft.md',
      content: 'Local draft only.',
    }),
    sessionId: session.id,
  });

  assert.match(response.content[0].text, /Next step: ask the user whether to execute/);
  assert.doesNotMatch(response.content[0].text, /REQUIRED NEXT TOOL/);
});

test('model-callable pending_action_record_result cannot forge completion of an executing action', async () => {
  const record = queuePendingAction({
    title: 'Owner-bound completion',
    summary: 'The dispatcher alone may record terminal provider truth.',
    kind: 'external_write',
    toolName: 'proof__write',
    payload: { value: 'one' },
  });
  markPendingActionApprovalResolved(record.id, 'approved', null, {
    by: 'policy',
    evidence: { kind: 'policy', scope: 'test' },
  });
  const claim = claimPendingActionExecution(record.id, 'trusted-dispatcher');
  assert.equal(claim.claimed, true);
  assert.ok(claim.claimToken);

  const forged = await handlerFor('pending_action_record_result')({
    id: record.id,
    status: 'executed',
    resultSummary: 'I say it worked.',
  });
  assert.match(forged.content[0].text, /marked executing/i, 'the tool reports durable truth, not the requested forgery');
  assert.equal(getPendingAction(record.id)?.status, 'executing');

  recordPendingActionResult(
    record.id,
    'failed',
    'trusted dispatcher could not confirm the provider outcome',
    'trusted-dispatcher',
    claim.claimToken,
  );
  assert.equal(getPendingAction(record.id)?.status, 'failed');
});
