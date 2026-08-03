import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-pending-action-recipient-integrity';
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.COMPOSIO_BACKEND = 'sdk';

const {
  canonicalizePendingActionCall,
  registerPendingActionTools,
} = await import('./pending-action-tools.js');
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
const {
  queuedApprovalTransitionShouldMaterialize,
  queuedApprovalTransitionsForRequest,
} = await import('../runtime/harness/pending-action-transition.js');
const {
  grantComposioCliDefaultAccountAuthority,
  revokeComposioCliDefaultAccountAuthority,
} = await import('../integrations/composio/cli-default-account-authority.js');

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

function writeTrustedReadOutput(
  sessionId: string,
  callId: string,
  tool: string,
  output: string,
): void {
  const called = appendEvent({
    sessionId,
    turn: 1,
    role: 'agent',
    type: 'tool_called',
    data: { tool, callId, effect: 'read' },
  });
  writeToolOutput({ sessionId, callId, tool, output });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    parentEventId: called.id,
    data: { tool, callId, effect: 'read', ok: true },
  });
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
  writeTrustedReadOutput(
    session.id,
    'team-source',
    'memory_recall_all',
    `Complete team: ${correct.join(', ')}`,
  );

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
  writeTrustedReadOutput(
    session.id,
    'team-source',
    'memory_recall_all',
    correct.join(', '),
  );

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

test('pending_action_queue canonicalizes both Composio spellings and promotes one exact queue-only record', async () => {
  const session = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Stage this exact email, then make it ready for my approval.' },
  });
  const args = {
    recipient_email: 'owner@example.com',
    subject: 'Canonical proof',
    body: 'One immutable payload.',
  };
  const invoke = (input: Record<string, unknown>) => withToolOutputContext(
    { sessionId: session.id, runScopeId: 'canonical-run', callId: `call-${String(input.approvalIntent)}` },
    () => withHarnessRunContext(
      {
        sessionId: session.id,
        sourceUserSeq: source.seq,
        behaviorScopeId: 'canonical-run',
        counter: new ToolCallsCounter(10),
      },
      () => handlerFor('pending_action_queue')(input),
    ),
  );

  const staged = await invoke({
    title: 'Canonical email',
    summary: 'Stage the exact canonical email without opening a card yet.',
    kind: 'external_send',
    toolName: 'GMAIL_SEND_EMAIL',
    payloadJson: JSON.stringify(args),
    approvalIntent: 'queue_only',
  });
  assert.match(staged.content[0].text, /QUEUE-ONLY EDGE RECORDED/);

  const promoted = await invoke({
    title: 'Canonical email',
    summary: 'Open the one exact canonical email approval card now.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payloadJson: JSON.stringify({
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: args,
    }),
    approvalIntent: 'request_now',
  });
  assert.match(promoted.content[0].text, /Pending action reused/);
  assert.match(promoted.content[0].text, /GRAPH EDGE RECORDED/);

  const records = listPendingActions({ sessionId: session.id });
  assert.equal(records.length, 1, 'canonical raw/gateway spellings dedupe');
  assert.equal(records[0].toolName, 'composio_execute_tool');
  assert.deepEqual(records[0].payload, {
    tool_slug: 'GMAIL_SEND_EMAIL',
    arguments: JSON.stringify(args),
    connected_account_id: null,
  });
  const edges = listEvents(session.id, { types: ['autonomy_note'] })
    .filter((event) => event.data.kind === 'pending_action_queued');
  assert.deepEqual(edges.map((event) => event.data.approvalIntent), ['queue_only', 'request_now']);
  const [transition] = queuedApprovalTransitionsForRequest(session.id, source.seq);
  assert.equal(transition?.approvalIntent, 'request_now', 'promotion is monotonic');
  assert.equal(queuedApprovalTransitionShouldMaterialize(transition!, false), true);

  const refusedDowngrade = await invoke({
    title: 'Canonical email',
    summary: 'A stale retry must not downgrade the existing approval edge.',
    kind: 'external_send',
    toolName: 'GMAIL_SEND_EMAIL',
    payloadJson: JSON.stringify(args),
    approvalIntent: 'queue_only',
  });
  assert.match(refusedDowngrade.content[0].text, /GRAPH EDGE RECORDED/);
  assert.doesNotMatch(refusedDowngrade.content[0].text, /QUEUE-ONLY EDGE RECORDED/);
  assert.equal(
    queuedApprovalTransitionsForRequest(session.id, source.seq)[0]?.approvalIntent,
    'request_now',
    'request_now cannot be downgraded by a stale retry',
  );
});

test('pending-action canonicalization never rewrites local or custom tool identities as Composio', () => {
  const dynamicToolsDir = `${TEST_HOME}/tools`;
  mkdirSync(dynamicToolsDir, { recursive: true });
  writeFileSync(`${dynamicToolsDir}/SEND_INVOICE.sh`, '#!/bin/sh\n', 'utf8');
  for (const toolName of [
    'space_publish',
    'space_save',
    'request_approval',
    'run_worker',
    'custom_write_record',
    'SEND_INVOICE',
  ]) {
    const payload = { proof: toolName };
    assert.deepEqual(
      canonicalizePendingActionCall(toolName, payload),
      { toolName, payload },
      toolName,
    );
  }

  assert.deepEqual(
    canonicalizePendingActionCall('GMAIL_SEND_EMAIL', {
      to: 'proof@example.com',
      subject: 'Proof',
      body: 'Meaningful payload.',
    }),
    {
      toolName: 'composio_execute_tool',
      payload: {
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: JSON.stringify({
          to: 'proof@example.com',
          subject: 'Proof',
          body: 'Meaningful payload.',
        }),
        connected_account_id: null,
      },
    },
  );
  assert.throws(
    () => canonicalizePendingActionCall('composio_execute_tool', {
      tool_slug: 'space_publish',
      arguments: {},
    }),
    /concrete Composio action slug/,
  );
});

test('pending_action_queue refuses a targetless directed send but accepts an account-scoped social publish', async () => {
  assert.throws(
    () => canonicalizePendingActionCall('GMAIL_SEND_EMAIL', {
      ownerEmail: 'sender@example.com',
      accountId: 'ca_sender',
      subject: 'Targetless proof',
      body: 'This must never mint a card.',
    }),
    /recipient|target/i,
  );
  assert.throws(
    () => canonicalizePendingActionCall('composio_execute_tool', {
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: JSON.stringify({
        profileEmail: 'sender@example.com',
        subject: 'Targetless proof',
        body: 'This must never mint a card.',
      }),
    }),
    /recipient|target/i,
  );

  const social = canonicalizePendingActionCall('composio_execute_tool', {
    tool_slug: 'INSTAGRAM_CREATE_POST',
    arguments: {
      caption: 'Account-scoped launch post',
      image_url: 'https://assets.example/launch.png',
    },
    connected_account_id: 'ca_instagram_brand',
  });
  assert.equal(social.toolName, 'composio_execute_tool');
  assert.deepEqual(social.payload, {
    tool_slug: 'INSTAGRAM_CREATE_POST',
    arguments: JSON.stringify({
      caption: 'Account-scoped launch post',
      image_url: 'https://assets.example/launch.png',
    }),
    connected_account_id: 'ca_instagram_brand',
  });

  const session = createSession({ kind: 'chat' });
  const response = await withToolOutputContext({ sessionId: session.id }, () =>
    handlerFor('pending_action_queue')({
      title: 'Targetless email',
      summary: 'A directed send without a recipient must stay pre-approval.',
      kind: 'external_send',
      toolName: 'GMAIL_SEND_EMAIL',
      payloadJson: JSON.stringify({
        authenticatedUserEmail: 'sender@example.com',
        subject: 'Targetless proof',
        body: 'No recipient.',
      }),
      approvalIntent: 'request_now',
    }));
  assert.match(response.content[0].text, /recipient|target/i);
  assert.equal(listPendingActions({ sessionId: session.id }).length, 0);

  const unboundRequestNow = await withToolOutputContext({ sessionId: session.id }, () =>
    handlerFor('pending_action_queue')({
      title: 'Publish launch post now',
      summary: 'Open approval for the exact account-scoped launch post.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payloadJson: JSON.stringify({
        tool_slug: 'INSTAGRAM_CREATE_POST',
        arguments: {
          caption: 'Account-scoped launch post',
          image_url: 'https://assets.example/launch.png',
        },
      }),
      approvalIntent: 'request_now',
    }));
  assert.match(unboundRequestNow.content[0].text, /connected_account_id.*immutable SDK snapshot/i);
  assert.equal(listPendingActions({ sessionId: session.id }).length, 0, 'an unbound card never exists');

  const unboundLegacyIntent = await withToolOutputContext({ sessionId: session.id }, () =>
    handlerFor('pending_action_queue')({
      title: 'Legacy launch post',
      summary: 'An omitted intent must not leave the legacy prose bridge able to open an unbound card.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payloadJson: JSON.stringify({
        tool_slug: 'INSTAGRAM_CREATE_POST',
        arguments: {
          caption: 'Account-scoped launch post',
          image_url: 'https://assets.example/launch.png',
        },
      }),
    }));
  assert.match(unboundLegacyIntent.content[0].text, /formal approval path.*connected_account_id/i);
  assert.equal(listPendingActions({ sessionId: session.id }).length, 0, 'the legacy bridge cannot mint an unbound card');

  const stagedUnbound = await withToolOutputContext({ sessionId: session.id }, () =>
    handlerFor('pending_action_queue')({
      title: 'Stage launch post',
      summary: 'Keep the account-scoped launch post preparatory until its account is selected.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payloadJson: JSON.stringify({
        tool_slug: 'INSTAGRAM_CREATE_POST',
        arguments: {
          caption: 'Account-scoped launch post',
          image_url: 'https://assets.example/launch.png',
        },
      }),
      approvalIntent: 'queue_only',
    }));
  assert.match(stagedUnbound.content[0].text, /QUEUE-ONLY EDGE RECORDED/);
  assert.equal(listPendingActions({ sessionId: session.id }).length, 1, 'preparatory staging remains available');

  const pinnedSession = createSession({ kind: 'chat' });
  const pinnedRequestNow = await withToolOutputContext({ sessionId: pinnedSession.id }, () =>
    handlerFor('pending_action_queue')({
      title: 'Publish pinned launch post',
      summary: 'Open approval for the immutable account-scoped launch post.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payloadJson: JSON.stringify({
        tool_slug: 'INSTAGRAM_CREATE_POST',
        arguments: {
          caption: 'Account-scoped launch post',
          image_url: 'https://assets.example/launch.png',
        },
        connected_account_id: 'ca_instagram_brand',
      }),
      approvalIntent: 'request_now',
    }));
  assert.match(pinnedRequestNow.content[0].text, /GRAPH EDGE RECORDED/);
  const [pinnedRecord] = listPendingActions({ sessionId: pinnedSession.id });
  assert.equal(
    (pinnedRecord.payload as { connected_account_id?: string }).connected_account_id,
    'ca_instagram_brand',
    'the approval snapshot freezes the exact social account',
  );
});

test('CLI-default publish queue snapshots operator authority and refuses account-targeted selectors', async () => {
  const previousBackend = process.env.COMPOSIO_BACKEND;
  process.env.COMPOSIO_BACKEND = 'cli';
  const authority = await grantComposioCliDefaultAccountAuthority({
    toolkit: 'instagram',
    label: 'Brand Instagram selected in the Composio CLI',
    grantedBy: 'test',
  });
  const session = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Publish this approved launch post to the CLI default Instagram account.' },
  });
  const invoke = (payload: Record<string, unknown>) => withToolOutputContext(
    { sessionId: session.id, runScopeId: 'cli-default-publish', callId: 'queue-cli-default' },
    () => withHarnessRunContext(
      {
        sessionId: session.id,
        sourceUserSeq: source.seq,
        behaviorScopeId: 'cli-default-publish',
        counter: new ToolCallsCounter(10),
      },
      () => handlerFor('pending_action_queue')({
        title: 'Publish CLI-default launch post',
        summary: 'Publish the exact reviewed post to the operator-verified CLI default.',
        kind: 'external_send',
        toolName: 'composio_execute_tool',
        payloadJson: JSON.stringify(payload),
        approvalIntent: 'request_now',
      }),
    ),
  );

  try {
    const queued = await invoke({
      tool_slug: 'INSTAGRAM_CREATE_POST',
      arguments: {
        caption: 'Launch day',
        image_url: 'https://assets.example/launch.png',
      },
    });
    assert.match(queued.content[0].text, /GRAPH EDGE RECORDED/);
    const [record] = listPendingActions({ sessionId: session.id });
    assert.deepEqual(record.executionAuthority, authority);
    assert.equal(
      (record.payload as { connected_account_id?: unknown }).connected_account_id,
      null,
      'the approval is explicitly CLI-default and never pretends to carry an SDK account id',
    );

    const targeted = await invoke({
      tool_slug: 'INSTAGRAM_CREATE_POST',
      arguments: {
        caption: 'Wrong route',
        image_url: 'https://assets.example/wrong.png',
      },
      connected_account_id: 'ca_brand',
    });
    assert.match(targeted.content[0].text, /CLI cannot honor account-targeted selectors/i);
    assert.equal(listPendingActions({ sessionId: session.id }).length, 1);
  } finally {
    await revokeComposioCliDefaultAccountAuthority('instagram');
    process.env.COMPOSIO_BACKEND = previousBackend ?? 'sdk';
  }
});

test('pending_action_queue refuses the turn-scoped call_tool carrier instead of persisting raw deferred authority', async () => {
  assert.throws(
    () => canonicalizePendingActionCall('call_tool', {
      name: 'composio_execute_tool',
      args_json: JSON.stringify({
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: JSON.stringify({ to: 'authority@example.com' }),
      }),
    }),
    /call_tool cannot be stored.*validated inner toolName/i,
  );
  assert.throws(
    () => canonicalizePendingActionCall('mcp__clementine-local__call_tool', {
      name: 'composio_execute_tool',
      args_json: '{}',
    }),
    /call_tool cannot be stored/i,
  );

  const session = createSession({ kind: 'chat' });
  const response = await withToolOutputContext({ sessionId: session.id }, () =>
    handlerFor('pending_action_queue')({
      title: 'Raw deferred send',
      summary: 'A transport carrier must not become durable approval authority.',
      kind: 'external_send',
      toolName: 'call_tool',
      payloadJson: JSON.stringify({
        name: 'composio_execute_tool',
        args_json: JSON.stringify({
          tool_slug: 'GMAIL_SEND_EMAIL',
          arguments: JSON.stringify({ to: 'authority@example.com' }),
        }),
      }),
      approvalIntent: 'request_now',
    }));
  assert.match(response.content[0].text, /call_tool cannot be stored/i);
  assert.equal(listPendingActions({ sessionId: session.id }).length, 0);
});

test('pending_action_queue rejects malformed Composio transport before creating an action', async () => {
  const session = createSession({ kind: 'chat' });
  const response = await withToolOutputContext({ sessionId: session.id }, () =>
    handlerFor('pending_action_queue')({
      title: 'Malformed gateway',
      summary: 'This invalid transport must not reach an approval card.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payloadJson: JSON.stringify({
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: '[1,2,3]',
      }),
      approvalIntent: 'request_now',
    }));
  assert.match(response.content[0].text, /arguments must be a valid JSON-object string or a plain object/);
  assert.equal(listPendingActions({ sessionId: session.id }).length, 0);
  assert.equal(
    listEvents(session.id, { types: ['autonomy_note'] })
      .filter((event) => event.data.kind === 'pending_action_queued').length,
    0,
  );
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
  assert.equal(Object.hasOwn(schemaFor('pending_action_queue'), 'approvalIntent'), true);
  const approvalIntentSchema = schemaFor('pending_action_queue').approvalIntent as {
    safeParse(value: unknown): { success: boolean };
  };
  assert.equal(
    approvalIntentSchema.safeParse(undefined).success,
    true,
    'pre-3.0 queue callers may omit the typed edge and use the legacy bridge',
  );
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
