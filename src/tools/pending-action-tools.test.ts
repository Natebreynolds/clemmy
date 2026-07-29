import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-pending-action-recipient-integrity';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { registerPendingActionTools } = await import('./pending-action-tools.js');
const { appendEvent, createSession, listEvents, resetEventLog, writeToolOutput } = await import('../runtime/harness/eventlog.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('../runtime/harness/brackets.js');
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

function schemaFor(name: string): Record<string, unknown> {
  const schemas = new Map<string, Record<string, unknown>>();
  registerPendingActionTools({
    tool(toolName: string, ...args: unknown[]) {
      schemas.set(toolName, args.at(-2) as Record<string, unknown>);
    },
  } as never);
  const schema = schemas.get(name);
  if (!schema) throw new Error(`missing schema for ${name}`);
  return schema;
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

  const response = await withToolOutputContext({ sessionId: session.id }, () =>
    handlerFor('pending_action_queue')({
      title: 'Invite the team',
      summary: 'Create one calendar invite for the saved team roster.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payloadJson: JSON.stringify({
        tool_slug: 'OUTLOOK_CREATE_EVENT',
        arguments: JSON.stringify({ attendees: outgoing.map((email) => ({ email })) }),
      }),
    }));

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

  const response = await withToolOutputContext({ sessionId: session.id }, () =>
    handlerFor('pending_action_queue')({
      title: 'Invite the team',
      summary: 'Create one calendar invite for the saved team roster.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payloadJson: JSON.stringify({
        tool_slug: 'OUTLOOK_CREATE_EVENT',
        arguments: JSON.stringify({ attendees: correct.map((email) => ({ email })) }),
      }),
    }));

  assert.match(response.content[0].text, /Pending action queued/);
  assert.match(response.content[0].text, /REQUIRED NEXT EDGE/);
  assert.match(response.content[0].text, /single formal approval card/);
  assert.match(response.content[0].text, /pending_action_execute/);
  assert.equal(listPendingActions({ sessionId: session.id }).length, 1);
});

test('pending_action_queue keeps a reversible local action on the lighter conversational path', async () => {
  const session = createSession({ kind: 'chat' });
  const response = await withToolOutputContext({ sessionId: session.id }, () =>
    handlerFor('pending_action_queue')({
      title: 'Save local draft',
      summary: 'Save a reversible local draft in the current workspace.',
      kind: 'local_file_write',
      toolName: 'write_file',
      payloadJson: JSON.stringify({
        path: 'draft.md',
        content: 'Local draft only.',
      }),
    }));

  assert.match(response.content[0].text, /Next step: ask the user whether to execute/);
  assert.doesNotMatch(response.content[0].text, /REQUIRED NEXT TOOL/);
});

test('pending_action_queue keeps ambient session ownership over model-supplied null or foreign ids', async () => {
  const ambient = createSession({ kind: 'chat' });
  const victim = createSession({ kind: 'chat' });
  const queue = (sessionId: string) => withToolOutputContext({ sessionId: ambient.id }, () =>
    handlerFor('pending_action_queue')({
      title: 'Session-owned send',
      summary: 'Queue an external send under the active harness session.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payloadJson: JSON.stringify({
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: { to: 'owner@example.com', subject: 'Owned', body: 'Session-owned.' },
      }),
      targetSummary: 'owner@example.com',
      sessionId,
    }));

  await queue('null');
  await queue(victim.id);

  const records = listPendingActions({ sessionId: ambient.id });
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.sessionId === ambient.id));
  assert.equal(listPendingActions({ sessionId: 'null' }).length, 0);
  assert.equal(listPendingActions({ sessionId: victim.id }).length, 0);
  const queuedEvents = listEvents(ambient.id, { types: ['autonomy_note'] });
  assert.equal(queuedEvents.length, 2);
  assert.ok(queuedEvents.every((event) => (
    event.data.kind === 'pending_action_queued'
    && event.data.actionKind === 'external_send'
    && event.data.approvalRequired === true
  )));
  assert.equal(listEvents(victim.id, { types: ['autonomy_note'] }).length, 0);
});

test('pending_action_queue exposes no model-controlled session field and refuses unowned approval actions', async () => {
  assert.equal(Object.hasOwn(schemaFor('pending_action_queue'), 'sessionId'), false);
  assert.equal(Object.hasOwn(schemaFor('pending_action_execute'), 'sessionId'), false);
  for (const [index, sessionId] of ['null', ' NULL ', 'undefined'].entries()) {
    const response = await handlerFor('pending_action_queue')({
      title: `Unscoped legacy queue ${index}`,
      summary: 'Queue outside a harness context without accepting a sentinel owner.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payloadJson: JSON.stringify({
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: { to: 'owner@example.com', subject: 'Unscoped', body: 'No ambient session.' },
      }),
      sessionId,
    });
    assert.match(response.content[0].text, /requires an authoritative harness session/);
  }
  const records = listPendingActions({ status: 'all' })
    .filter((record) => record.title.startsWith('Unscoped legacy queue'));
  assert.equal(records.length, 0);
});

test('pending_action_queue binds its audit edge to the exact accepted request and payload hash', async () => {
  const session = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Queue the reviewed email.' },
  });
  await withToolOutputContext(
    { sessionId: session.id, runScopeId: 'run-exact', callId: 'call-exact' },
    () => withHarnessRunContext(
      {
        sessionId: session.id,
        sourceUserSeq: source.seq,
        behaviorScopeId: 'run-exact',
        counter: new ToolCallsCounter(10),
      },
      () => handlerFor('pending_action_queue')({
        title: 'Exact attributed send',
        summary: 'Queue one exact request-owned external send.',
        kind: 'external_send',
        toolName: 'composio_execute_tool',
        payloadJson: JSON.stringify({
          tool_slug: 'GMAIL_SEND_EMAIL',
          arguments: { to: 'owner@example.com', subject: 'Exact', body: 'Request-owned.' },
        }),
      }),
    ),
  );

  const event = listEvents(session.id, { types: ['autonomy_note'] }).at(-1)!;
  const record = listPendingActions({ sessionId: session.id }).at(-1)!;
  assert.equal(event.data.kind, 'pending_action_queued');
  assert.equal(event.data.sourceUserSeq, source.seq);
  assert.equal(event.data.runScopeId, 'run-exact');
  assert.equal(event.data.callId, 'call-exact');
  assert.equal(event.data.pendingActionId, record.id);
  assert.equal(event.data.payloadHash, record.payloadHash);
});

test('pending_action_queue reuses an exact same-request retry but not a later user request', async () => {
  const session = createSession({ kind: 'chat' });
  const firstSource = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Queue the exact launch post.' },
  });
  const input = {
    title: 'Publish launch post',
    summary: 'Publish one exact reviewed launch post.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payloadJson: JSON.stringify({
      tool_slug: 'SLACK_SEND_MESSAGE',
      arguments: { channel: 'launch-proof', text: 'The exact launch update.' },
    }),
  };
  const queueFor = (sourceUserSeq: number) => withToolOutputContext(
    { sessionId: session.id, runScopeId: `run-${sourceUserSeq}`, callId: `call-${sourceUserSeq}` },
    () => withHarnessRunContext(
      {
        sessionId: session.id,
        sourceUserSeq,
        behaviorScopeId: `run-${sourceUserSeq}`,
        counter: new ToolCallsCounter(10),
      },
      () => handlerFor('pending_action_queue')(input),
    ),
  );

  const first = await queueFor(firstSource.seq);
  const retry = await queueFor(firstSource.seq);
  assert.match(first.content[0].text, /Pending action queued:/);
  assert.match(retry.content[0].text, /Pending action reused:/);
  const firstId = first.content[0].text.match(/pa-[a-z0-9-]+/)?.[0];
  assert.ok(firstId);
  assert.match(retry.content[0].text, new RegExp(firstId!));
  assert.equal(listPendingActions({ sessionId: session.id }).length, 1);
  assert.equal(
    listEvents(session.id, { types: ['autonomy_note'] })
      .filter((event) => event.data.kind === 'pending_action_queued').length,
    1,
  );

  const secondSource = appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send that same update again as a new request.' },
  });
  const later = await queueFor(secondSource.seq);
  assert.match(later.content[0].text, /Pending action queued:/);
  assert.equal(listPendingActions({ sessionId: session.id }).length, 2);
  assert.equal(
    listEvents(session.id, { types: ['autonomy_note'] })
      .filter((event) => event.data.kind === 'pending_action_queued').length,
    2,
  );
});

test('pending_action_queue and execute fail closed when a harness context has no session owner', async () => {
  const queued = await withToolOutputContext({}, () =>
    handlerFor('pending_action_queue')({
      title: 'Missing owner',
      summary: 'This queue attempt has no authoritative session owner.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payloadJson: JSON.stringify({ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'owner@example.com' } }),
    }));
  assert.match(queued.content[0].text, /no authoritative session owner/);

  const action = queuePendingAction({
    title: 'Existing action',
    summary: 'An id alone must not become execution authority.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'owner@example.com' } },
  });
  const executed = await withToolOutputContext({}, () =>
    handlerFor('pending_action_execute')({ id: action.id }));
  assert.match(executed.content[0].text, /no authoritative session owner/);
  assert.equal(getPendingAction(action.id)?.status, 'queued');
});

test('pending_action_queue cancels an approval payload when its durable graph edge cannot persist', async () => {
  const missingSessionId = 'sess-missing-edge-owner';
  const response = await withToolOutputContext(
    { sessionId: missingSessionId, runScopeId: 'missing-edge', callId: 'missing-edge-call' },
    () => withHarnessRunContext(
      {
        sessionId: missingSessionId,
        sourceUserSeq: 42,
        behaviorScopeId: 'missing-edge',
        counter: new ToolCallsCounter(10),
      },
      () => handlerFor('pending_action_queue')({
        title: 'Unsaved approval edge',
        summary: 'This action must remain inert when its request event cannot persist.',
        kind: 'external_send',
        toolName: 'mcp__proof__send_message',
        payloadJson: JSON.stringify({ channel: 'proof', text: 'Must not execute.' }),
      }),
    ),
  );
  assert.match(response.content[0].text, /failed safely/);
  assert.match(response.content[0].text, /Nothing is authorized or executable/);
  const [record] = listPendingActions({ sessionId: missingSessionId, status: 'all' });
  assert.equal(record?.status, 'cancelled');
  assert.match(record?.resultSummary ?? '', /durable request edge could not be recorded/);
});

test('pending_action_list preserves an explicit read filter inside another ambient session', async () => {
  const ambient = createSession({ kind: 'chat' });
  const requested = createSession({ kind: 'chat' });
  queuePendingAction({
    title: 'Ambient action',
    summary: 'This action belongs to the ambient session only.',
    kind: 'local_file_write',
    toolName: 'write_file',
    payload: { path: 'ambient.md', content: 'ambient' },
    sessionId: ambient.id,
  });
  queuePendingAction({
    title: 'Requested action',
    summary: 'This action belongs to the explicitly requested read filter.',
    kind: 'local_file_write',
    toolName: 'write_file',
    payload: { path: 'requested.md', content: 'requested' },
    sessionId: requested.id,
  });

  const response = await withToolOutputContext({ sessionId: ambient.id }, () =>
    handlerFor('pending_action_list')({ sessionId: requested.id, status: 'all' }));
  assert.match(response.content[0].text, /Requested action/);
  assert.doesNotMatch(response.content[0].text, /Ambient action/);
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
