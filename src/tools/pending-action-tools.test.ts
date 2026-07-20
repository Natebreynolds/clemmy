import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-pending-action-recipient-integrity';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { registerPendingActionTools } = await import('./pending-action-tools.js');
const { appendEvent, createSession, resetEventLog, writeToolOutput } = await import('../runtime/harness/eventlog.js');
const { listPendingActions } = await import('../runtime/harness/pending-actions.js');

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
  assert.match(response.content[0].text, /pending_action_execute/);
  assert.equal(listPendingActions({ sessionId: session.id }).length, 1);
});
