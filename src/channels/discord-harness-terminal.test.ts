/**
 * Focused regression coverage for deterministic Discord/Slack early outcomes.
 *
 * Run: npx tsx --test src/channels/discord-harness-terminal.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-discord-terminal-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.AUTH_MODE = 'codex_oauth';
process.env.MODEL_ROUTING_MODE = 'off';
process.env.CLEMMY_AUTH_FALLOVER = 'off';
process.env.CLEMMY_BRAIN_FALLOVER = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  __test__,
  bindDiscordHarnessSession,
  tryHandleHarnessApprovalReply,
  UnboundDurableApprovalReplyError,
} = await import('./discord-harness.js');
const {
  appendConversationPreambleOnce,
  appendEvent,
  createSession,
  listEvents,
} = await import('../runtime/harness/eventlog.js');
const { projectHarnessEventForPublic } = await import('../runtime/harness/public-presentation.js');
const { _setLocalProviderForTest } = await import('../memory/embeddings.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { bindInboundSource, claimInbound, completeInbound, getInbound } = await import('./inbox-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const {
  createWorkflowChatDispatchPreparationAuthority,
  createWorkflowChatDispatchPreparedReceipt,
  createWorkflowOriginGroupCloseAuthority,
  createWorkflowOriginGroupClosedBatchReceipt,
  finalizeWorkflowOriginGroupClosedBatch,
  recordWorkflowChatDispatchPreparation,
  recordWorkflowOriginGroupClosedBatch,
} = await import('../execution/workflow-origin-group.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function terminalEvents(sessionId: string) {
  return listEvents(sessionId, { types: ['conversation_completed'] });
}

function appendActiveWorkflowDispatch(source: import('../runtime/harness/eventlog.js').EventRow, runId: string) {
  const replyTarget = source.data.originReplyTarget as { type: 'discord_channel'; channelId: string };
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'test-workflow',
    status: 'awaiting_chat_dispatch_seal',
  }), 'utf-8');
  const authority = createWorkflowChatDispatchPreparationAuthority({
    runId,
    observer: { sessionId: source.sessionId, sourceUserSeq: source.seq, replyTarget },
    queueRequestDigest: createHash('sha256').update(`terminal-test:${runId}`).digest('hex'),
  });
  const prepared = appendEvent({
    sessionId: source.sessionId,
    turn: source.turn,
    role: 'system',
    type: 'async_work_dispatch_prepared',
    parentEventId: source.id,
    data: { ...authority },
  });
  const receipt = recordWorkflowChatDispatchPreparation(createWorkflowChatDispatchPreparedReceipt(authority, {
    eventId: prepared.id,
    eventSeq: prepared.seq,
    preparedAt: prepared.createdAt,
  }));
  const closeAuthority = createWorkflowOriginGroupCloseAuthority([receipt]);
  const closed = appendEvent({
    sessionId: source.sessionId,
    turn: source.turn,
    role: 'system',
    type: 'async_work_dispatch_batch_closed',
    parentEventId: source.id,
    data: { ...closeAuthority },
  });
  recordWorkflowOriginGroupClosedBatch({
    receipt: createWorkflowOriginGroupClosedBatchReceipt(closeAuthority, {
      eventId: closed.id,
      eventSeq: closed.seq,
      closedAt: closed.createdAt,
    }),
    preparedReceipts: [receipt],
  });
  const active = finalizeWorkflowOriginGroupClosedBatch(receipt.sourceGroupId, {
    beforeMemberRelease: () => {},
  });
  return appendEvent({
    sessionId: source.sessionId,
    turn: source.turn,
    role: 'system',
    type: 'async_work_dispatched',
    parentEventId: source.id,
    data: { ...active.publicDispatch, replyTarget: active.sealed.replyTarget },
  });
}

function recordingTransport() {
  const initial: string[] = [];
  const errors: string[] = [];
  return {
    initial,
    errors,
    transport: {
      async sendInitial(content: string) {
        initial.push(content);
        return { async edit() {} };
      },
      async sendError(content: string) {
        errors.push(content);
      },
    },
  };
}

test('accepted channel requests persist their typed progress presentation for approval resumes', () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const active = __test__.registerActiveChannelRunForTest({
    channel: 'discord',
    channelId: 'chan-quiet-policy',
    userId: 'user-quiet-policy',
    guildId: null,
    sessionId: session.id,
  });
  try {
    const accepted = __test__.recordActiveChannelUserInputForTest(
      active,
      'Find the verified result.',
      'Do not narrate your plan or tool calls. Return only the verified answer.',
    );
    assert.equal(accepted.data.progressPresentation, 'quiet');
    assert.deepEqual(accepted.data.originReplyTarget, {
      type: 'discord_channel',
      channelId: 'chan-quiet-policy',
    });
    assert.match(String(accepted.data.originReplyTargetDigest), /^[a-f0-9]{64}$/);
    assert.equal(__test__.progressPresentationForSessionForTest(session.id), 'quiet');
  } finally {
    __test__.unregisterActiveChannelRunForTest(active);
  }
});

test('exact-source preamble is nonterminal, foreign-safe, preserves tool status, and yields to final', () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const current = appendEvent({
    sessionId: session.id,
    turn: 5,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'current request' },
  });
  const foreign = appendEvent({
    sessionId: session.id,
    turn: 5,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'overlapping foreign request' },
  });
  const currentPreamble = projectHarnessEventForPublic(appendConversationPreambleOnce({
    source: current,
    text: 'I remember the earlier attempt and I’m beginning the current request.',
  }).event);
  const foreignPreamble = projectHarnessEventForPublic(appendConversationPreambleOnce({
    source: foreign,
    text: 'This belongs to the overlapping request.',
  }).event);
  assert.ok(currentPreamble);
  assert.ok(foreignPreamble);

  const state = {
    summary: '',
    status: 'starting',
    done: false,
    progressPresentation: 'compact' as const,
    toolsCalled: [] as string[],
    toolCount: 0,
  };
  assert.equal(
    __test__.applyEventToAcceptedChannelState(foreignPreamble, current, state, () => false),
    false,
  );
  assert.equal(state.summary, '');
  assert.equal(
    __test__.applyEventToAcceptedChannelState(currentPreamble, current, state, () => false),
    true,
  );
  assert.equal(state.summary, 'I remember the earlier attempt and I’m beginning the current request.');
  assert.equal(state.done, false);
  assert.equal(__test__.acceptedChannelOutcome(current), null, 'a preamble is not an accepted outcome');

  __test__.applyEventToAcceptedChannelState({
    ...currentPreamble,
    id: 'current-tool-call',
    type: 'tool_called',
    role: 'tool',
    data: { tool: 'call_tool', accounting: 'top_level', progress: 'using call_tool' },
  }, current, state, () => false);
  assert.equal(state.status, 'using call_tool');
  assert.equal(state.toolCount, 1);
  __test__.applyEventToAcceptedChannelState(currentPreamble, current, state, () => false);
  assert.equal(state.status, 'using call_tool', 'late/replayed preamble cannot erase useful tool status');
  assert.equal(state.done, false);

  const terminal = __test__.commitDiscordAnswerForTest({
    source: current,
    text: 'The current request is complete.',
    reason: 'test_complete',
  });
  const publicTerminal = projectHarnessEventForPublic(terminal.event);
  assert.ok(publicTerminal);
  assert.equal(
    __test__.applyEventToAcceptedChannelState(publicTerminal, current, state, () => false),
    true,
  );
  assert.equal(state.summary, 'The current request is complete.');
  assert.equal(state.done, true);
});

test('preamble delivery edits one owned placeholder idempotently and has quiet/fail-closed results', async () => {
  const request = (text: string) => ({
    version: 1 as const,
    sessionId: 'discord-preamble-session',
    sourceUserSeq: 9,
    eventId: 'discord-preamble-event',
    eventDigest: 'a'.repeat(64),
    deliveryKey: `preamble-delivery:v1:${'b'.repeat(64)}`,
    text,
  });
  const state = {
    summary: '',
    status: 'starting',
    done: false,
    progressPresentation: 'compact' as const,
    toolsCalled: [] as string[],
    toolCount: 0,
  };
  const order: string[] = [];
  const delivered = __test__.createChannelConversationPreambleDelivery({
    progressPresentation: 'compact',
    state,
    handle: { async edit(content: string) { order.push(`edit:${content}`); } },
    transport: {
      async sendInitial() { throw new Error('unused'); },
      async sendError() {},
    },
    isFinalized: () => false,
  });
  assert.deepEqual(await delivered(request('I have the details and I’m starting now.')), {
    status: 'delivered',
    receipt: {
      version: 1,
      deliveryKey: `preamble-delivery:v1:${'b'.repeat(64)}`,
      eventId: 'discord-preamble-event',
      eventDigest: 'a'.repeat(64),
      surface: 'channel_message',
      target: 'active_placeholder',
    },
  });
  order.push('tool:start');
  assert.deepEqual(order, [
    'edit:_starting_\n\nI have the details and I’m starting now.',
    'tool:start',
  ]);

  let quietPaints = 0;
  const quiet = __test__.createChannelConversationPreambleDelivery({
    progressPresentation: 'quiet',
    state: { ...state, summary: '' },
    handle: { async edit() { quietPaints += 1; } },
    transport: {
      async sendInitial() { throw new Error('unused'); },
      async sendError() {},
      async sendFollowup() { quietPaints += 1; },
    },
    isFinalized: () => false,
  });
  assert.deepEqual(await quiet(request('I will keep the presentation quiet.')), {
    status: 'not_applicable',
    reason: 'quiet_presentation',
    receipt: {
      version: 1,
      deliveryKey: `preamble-delivery:v1:${'b'.repeat(64)}`,
      eventId: 'discord-preamble-event',
      eventDigest: 'a'.repeat(64),
      surface: 'not_applicable',
      target: 'quiet_presentation',
    },
  });
  assert.equal(quietPaints, 0);

  const retryEdits: string[] = [];
  const retry = __test__.createChannelConversationPreambleDelivery({
    progressPresentation: 'compact',
    state: { ...state, summary: '' },
    handle: { async edit() { throw new Error('the exact transport hook owns this edit'); } },
    transport: {
      async sendInitial() { throw new Error('unused'); },
      async sendError() {},
      async deliverConversationPreamble(input) {
        retryEdits.push(`${input.deliveryKey}:discord:channel-1:placeholder-1`);
        return { target: 'discord:channel-1:placeholder-1' };
      },
    },
    isFinalized: () => false,
  });
  const retryRequest = request('Retry-safe preamble.');
  const firstRetry = await retry(retryRequest);
  const secondRetry = await retry(retryRequest);
  assert.deepEqual(firstRetry, secondRetry);
  assert.deepEqual(firstRetry, {
    status: 'delivered',
    receipt: {
      version: 1,
      deliveryKey: retryRequest.deliveryKey,
      eventId: retryRequest.eventId,
      eventDigest: retryRequest.eventDigest,
      surface: 'channel_message',
      target: 'discord:channel-1:placeholder-1',
    },
  });
  assert.deepEqual(retryEdits, [
    `${retryRequest.deliveryKey}:discord:channel-1:placeholder-1`,
    `${retryRequest.deliveryKey}:discord:channel-1:placeholder-1`,
  ], 'recovery re-edits one provider target with the exact stable delivery key');

  const failed = __test__.createChannelConversationPreambleDelivery({
    progressPresentation: 'compact',
    state: { ...state, summary: '' },
    handle: { async edit() { throw new Error('edit failed'); } },
    transport: {
      async sendInitial() { throw new Error('unused'); },
      async sendError() {},
      async sendFollowup() { throw new Error('followup failed'); },
    },
    isFinalized: () => false,
  });
  assert.deepEqual(await failed(request('Undeliverable preamble.')), {
    status: 'failed',
    reason: 'delivery_failed',
  });
  assert.deepEqual(await failed(request('{"summary":"x","reply":"x","done":true,"nextAction":"completed"}')), {
    status: 'failed',
    reason: 'delivery_failed',
  });
});

test('accepted Slack source freezes the active thread even if session metadata was rebound', () => {
  const session = createSession({
    kind: 'chat',
    channel: 'slack',
    metadata: { channelId: 'C0NEWERBINDING' },
  });
  const active = __test__.registerActiveChannelRunForTest({
    channel: 'slack',
    channelId: 'C0ORIGINAL:1785763575.123456',
    userId: 'U-source',
    guildId: 'T-team',
    sessionId: session.id,
  });
  try {
    const accepted = __test__.recordActiveChannelUserInputForTest(
      active,
      'Run it here.',
      'Run it here.',
    );
    assert.deepEqual(accepted.data.originReplyTarget, {
      type: 'slack_channel',
      channelId: 'C0ORIGINAL',
      threadTs: '1785763575.123456',
    });
    assert.match(String(accepted.data.originReplyTargetDigest), /^[a-f0-9]{64}$/);
  } finally {
    __test__.unregisterActiveChannelRunForTest(active);
  }
});

let durableOrdinal = 0;
function durableProviderRequest(channelId: string, prompt: string, sessionId?: string) {
  durableOrdinal += 1;
  const sourceMessageId = `provider-approval-${durableOrdinal}`;
  const channel = `discord:${channelId}`;
  const runId = `discord-run-${durableOrdinal}`;
  claimInbound({
    channel,
    sourceMessageId,
    sessionId,
    userId: `user-${durableOrdinal}`,
    runId,
    payloadHash: `payload:${prompt}`,
  });
  return {
    channel,
    sourceMessageId,
    durableRequest: {
      runId,
      sessionId,
      onSourceAccepted(source: { sessionId: string; seq: number }) {
        bindInboundSource({
          channel,
          sourceMessageId,
          sessionId: source.sessionId,
          runId,
          sourceUserSeq: source.seq,
        });
      },
    },
  };
}

function typedTerminalStatus(sessionId: string): string | undefined {
  const terminal = terminalEvents(sessionId)[0];
  return (terminal?.data.turnOutcome as { status?: string } | undefined)?.status;
}

test('cross-session seed reaches the eight-hour-old rephrased Ventura attempt as an ignorable historical candidate', async (t) => {
  const channelId = 'chan-semantic-prior-work-seed';
  const userId = 'user-semantic-prior-work-seed';
  const priorObjective = 'Find me the top 5 restaurants in Ventura ca using Apify mcp please and just send me a quick email about them';
  const currentObjective = 'Pull the top 5 restaurants in Ventura CA from the Apify API, put them in a new Google Sheet with name, rating, and address, then email me the link.';
  _setLocalProviderForTest({
    name: 'local',
    model: 'deterministic-discord-prior-work-test',
    dim: 3,
    async embed(texts: string[]) {
      return texts.map(() => Float32Array.from([1, 0, 0]));
    },
  });
  t.after(() => _setLocalProviderForTest(undefined));
  const prior = createSession({
    kind: 'chat',
    channel: 'discord',
    userId,
    title: 'prior Ventura attempt',
    metadata: { channelId, userId },
  });
  const source = appendEvent({
    sessionId: prior.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: priorObjective },
  });
  const outcomeId = `turn:${source.seq}`;
  const identity = { sessionId: prior.id, turn: 1, sourceUserSeq: source.seq };
  appendEvent({
    sessionId: prior.id,
    turn: 1,
    role: 'Clem',
    type: 'conversation_completed',
    data: {
      logicalTerminalVersion: 1,
      terminalKey: outcomeId,
      sourceUserSeq: source.seq,
      presentation: {
        version: 1,
        id: `${outcomeId}:presentation`,
        outcomeId,
        audience: 'user',
        phase: 'final',
        identity,
        status: 'failed',
        kind: 'error',
        text: 'PRIOR-VENTURA-FAILURE',
        resumable: false,
      },
      turnOutcome: { version: 2, id: outcomeId, status: 'failed', resumable: false },
      reply: 'PRIOR-VENTURA-FAILURE',
    },
  });

  const unrelated = createSession({
    kind: 'chat',
    channel: 'discord',
    userId,
    title: 'nearby unrelated attempt',
    metadata: { channelId, userId },
  });
  appendEvent({
    sessionId: unrelated.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Summarize the quarterly launch notes.' },
  });
  appendEvent({
    sessionId: unrelated.id,
    turn: 1,
    role: 'Clem',
    type: 'conversation_completed',
    data: { reply: 'UNRELATED-RAW-CONTINUATION' },
  });

  const current = createSession({
    kind: 'chat',
    channel: 'discord',
    userId,
    title: 'fresh Ventura attempt',
    metadata: { channelId, userId },
  });
  await __test__.seedCrossSessionPrefixForTest({
    newSessionId: current.id,
    channelId,
    userId,
    now: Date.now() + (8 * 60 * 60 * 1_000),
    newMessage: currentObjective,
    priorWorkObjective: currentObjective,
  });

  const prefix = listEvents(current.id, { types: ['cross_session_prefix'] }).at(-1);
  assert.ok(prefix);
  const priorWork = prefix.data.priorWork as {
    match: string;
    count: number;
    items: Array<{ sourceSessionId: string; sourceUserSeq: number; status: string }>;
  };
  assert.equal(priorWork.match, 'historical_candidates');
  assert.equal(priorWork.count, 1);
  assert.deepEqual(priorWork.items, [{
    sourceSessionId: prior.id,
    sourceUserSeq: source.seq,
    objective: priorObjective,
    matchKind: 'semantic',
    matchScore: 1,
    statusSource: 'typed_terminal',
    status: 'failed',
    evidenceRefs: [],
  }]);
  const text = String(prefix.data.text);
  const [historicalBlock = '', continuationBlock = ''] = text.split('[CONTINUATION CONTEXT');
  assert.match(historicalBlock, /POSSIBLY RELEVANT PRIOR WORK/i);
  assert.match(historicalBlock, /PRIOR-VENTURA-FAILURE/);
  assert.match(historicalBlock, /no current ownership/i);
  assert.match(historicalBlock, /may ignore/i);
  assert.doesNotMatch(historicalBlock, /UNRELATED-RAW-CONTINUATION/);
  assert.equal(continuationBlock, '', 'eight-hour-old history is a candidate, never authoritative continuation');
  assert.doesNotMatch(JSON.stringify(prefix.data.priorWork), /intentKey|approvalId|resumable|normalized_exact/);
});

test('historical candidate query is same-user/channel, fourteen-day, and twenty-four-source bounded', () => {
  const channelId = 'chan-prior-work-query-bounds';
  const userId = 'user-prior-work-query-bounds';
  const current = createSession({
    kind: 'chat',
    channel: 'discord',
    userId,
    metadata: { channelId, userId },
  });
  const matching = createSession({
    kind: 'chat',
    channel: 'discord',
    userId,
    metadata: { channelId, userId },
  });
  const sourceSeqs: number[] = [];
  for (let index = 0; index < 26; index += 1) {
    sourceSeqs.push(appendEvent({
      sessionId: matching.id,
      turn: index + 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: `bounded historical source ${index}` },
    }).seq);
  }
  const wrongUser = createSession({
    kind: 'chat',
    channel: 'discord',
    userId: 'different-user',
    metadata: { channelId, userId: 'different-user' },
  });
  const wrongUserSource = appendEvent({
    sessionId: wrongUser.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'wrong user must stay out' },
  });
  const wrongChannel = createSession({
    kind: 'chat',
    channel: 'discord',
    userId,
    metadata: { channelId: 'different-channel', userId },
  });
  const wrongChannelSource = appendEvent({
    sessionId: wrongChannel.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'wrong channel must stay out' },
  });

  const sources = __test__.historicalPriorWorkSourcesForTest({
    newSessionId: current.id,
    channelId,
    userId,
    channel: 'discord',
    now: Date.now(),
  });

  assert.equal(sources.length, 24);
  assert.deepEqual(sources.map((candidate: { sourceUserSeq: number }) => candidate.sourceUserSeq), sourceSeqs.slice(-24).reverse());
  assert.ok(!sources.some((candidate: { sourceUserSeq: number }) => candidate.sourceUserSeq === wrongUserSource.seq));
  assert.ok(!sources.some((candidate: { sourceUserSeq: number }) => candidate.sourceUserSeq === wrongChannelSource.seq));
  assert.deepEqual(__test__.historicalPriorWorkSourcesForTest({
    newSessionId: current.id,
    channelId,
    userId,
    channel: 'discord',
    now: Date.now() + (15 * 24 * 60 * 60 * 1_000),
  }), [], 'sources older than fourteen days are not candidates');
});

test('provider replied means dispatch ACK delivered while the exact logical edge remains pending', () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const provider = durableProviderRequest('chan-dispatch-ack', 'run the report', session.id);
  const active = __test__.registerActiveChannelRunForTest({
    channel: 'discord',
    channelId: 'chan-dispatch-ack',
    userId: 'user-dispatch-ack',
    guildId: null,
    sessionId: session.id,
    runId: provider.durableRequest.runId,
  });
  try {
    const accepted = __test__.recordActiveChannelUserInputForTest(active, 'run the report', 'run the report');
    provider.durableRequest.onSourceAccepted(accepted);
    appendActiveWorkflowDispatch(accepted, 'workflow-run-ack');

    const outcome = __test__.acceptedChannelOutcome(accepted);
    assert.equal(outcome?.kind, 'dispatched');
    assert.equal(outcome?.text, 'Started — I’ll post the result here when it’s ready.');
    assert.equal(terminalEvents(session.id).length, 0);

    // The provider row accounts for ingress/ACK delivery, not logical work
    // completion. The durable async event is still the pending report-back edge.
    completeInbound({
      channel: provider.channel,
      sourceMessageId: provider.sourceMessageId,
      status: 'replied',
      runId: provider.durableRequest.runId,
    });
    assert.equal(getInbound(provider.channel, provider.sourceMessageId)?.status, 'replied');
    assert.equal(listEvents(session.id, { types: ['async_work_dispatched'] }).length, 1);
    assert.equal(terminalEvents(session.id).length, 0);
  } finally {
    __test__.unregisterActiveChannelRunForTest(active, 'completed');
  }
});

test('fresh Discord /goal outcome owns the newly accepted user turn', () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const active = __test__.registerActiveChannelRunForTest({
    channel: 'discord',
    channelId: 'chan-goal-fresh',
    userId: 'user-goal-fresh',
    guildId: null,
    sessionId: session.id,
  });

  try {
    const accepted = __test__.recordActiveChannelUserInputForTest(
      active,
      '/goal status',
      '/goal status',
    );
    __test__.commitDiscordAnswerForTest({
      source: accepted,
      text: 'No goal is currently active.',
      reason: 'goal_command',
      metadata: { steps: 0 },
    });
    // A transport retry of the same accepted outcome must reuse the durable
    // terminal instead of publishing a second assistant turn.
    __test__.commitDiscordAnswerForTest({
      source: accepted,
      text: 'No goal is currently active.',
      reason: 'goal_command',
      metadata: { steps: 0 },
    });

    const users = listEvents(session.id, { types: ['user_input_received'] });
    const completed = terminalEvents(session.id);
    assert.equal(users.length, 1);
    assert.equal(users[0].seq, accepted.seq);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].data.reason, 'goal_command');
    assert.equal(completed[0].data.sourceUserSeq, accepted.seq);
    assert.equal(completed[0].data.terminalKey, `turn:${accepted.seq}`);
    assert.equal((completed[0].data.presentation as { text?: string }).text, 'No goal is currently active.');
  } finally {
    __test__.unregisterActiveChannelRunForTest(active);
  }
});

test('continuing Discord durable-background outcome cannot reuse the prior turn identity', () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const first = __test__.registerActiveChannelRunForTest({
    channel: 'discord',
    channelId: 'chan-background-continuing',
    userId: 'user-background-continuing',
    guildId: null,
    sessionId: session.id,
  });
  const firstUser = __test__.recordActiveChannelUserInputForTest(first, 'hello', 'hello');
  __test__.commitDiscordAnswerForTest({
    source: firstUser,
    text: 'Hello.',
    reason: 'success',
  });
  __test__.unregisterActiveChannelRunForTest(first);

  const second = __test__.registerActiveChannelRunForTest({
    channel: 'discord',
    channelId: 'chan-background-continuing',
    userId: 'user-background-continuing',
    guildId: null,
    sessionId: session.id,
  });
  try {
    const accepted = __test__.recordActiveChannelUserInputForTest(
      second,
      '/background finish the report',
      '/background finish the report',
    );
    __test__.commitDiscordAnswerForTest({
      source: accepted,
      text: 'Queued the report as a background task.',
      reason: 'queued_background',
      metadata: { steps: 0, queuedTaskId: 'bg-test' },
    });

    const users = listEvents(session.id, { types: ['user_input_received'] });
    const completed = terminalEvents(session.id);
    assert.equal(users.length, 2);
    assert.equal(completed.length, 2);
    assert.notEqual(accepted.seq, firstUser.seq);
    assert.notEqual(completed[1].data.terminalKey, completed[0].data.terminalKey);
    assert.equal(completed[1].data.reason, 'queued_background');
    assert.equal(completed[1].data.sourceUserSeq, accepted.seq);
    assert.equal(completed[1].data.terminalKey, `turn:${accepted.seq}`);
    assert.equal((completed[1].data.presentation as { text?: string }).text, 'Queued the report as a background task.');
  } finally {
    __test__.unregisterActiveChannelRunForTest(second);
  }
});

test('missing approval owns one provider receipt, source, and needs-input terminal; retry only replays', async () => {
  const channelId = 'chan-missing-durable-approval';
  const session = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId },
  });
  assert.equal(bindDiscordHarnessSession({ channelId, sessionId: session.id }), true);

  const prompt = 'approve apr-none';
  // This provider receipt has already selected the current conversation.
  // Missing-card routing may settle only against that durable identity; the
  // legacy channel-only continuity pointer is deliberately non-authorizing.
  const provider = durableProviderRequest(channelId, prompt, session.id);
  const delivery = recordingTransport();
  const input = {
    channelId,
    prompt,
    transport: delivery.transport,
    allowGlobalApprovalFallback: true,
    durableRequest: provider.durableRequest,
  };

  assert.equal(await tryHandleHarnessApprovalReply(input), true);
  assert.equal(await tryHandleHarnessApprovalReply(input), true);

  const receipt = getInbound(provider.channel, provider.sourceMessageId);
  const users = listEvents(session.id, { types: ['user_input_received'] });
  const terminals = terminalEvents(session.id);
  assert.equal(receipt?.sessionId, session.id);
  assert.equal(receipt?.sourceUserSeq, users[0]?.seq);
  assert.equal(users.length, 1, 'redelivery must not append another accepted source');
  assert.equal(terminals.length, 1, 'redelivery must not append another terminal');
  assert.equal(terminals[0].data.sourceUserSeq, users[0].seq);
  assert.equal(typedTerminalStatus(session.id), 'needs_input');
  assert.equal(delivery.initial.length, 2, 'first delivery plus exact terminal replay');
  assert.equal(delivery.initial[1], delivery.initial[0]);
  assert.equal(delivery.errors.length, 0);
  assert.equal(listEvents(session.id, { types: ['tool_called', 'run_completed'] }).length, 0);
});

test('unprovable approval session fails closed before source, terminal, mutation, or model dispatch', async () => {
  const channelId = 'chan-unbound-durable-approval';
  // An EXPLICIT card id is what makes a message approval control. (A bare
  // verb with nothing pending is ordinary conversation and is declined to the
  // normal turn — live 2026-08-12: "go ahead" answering Clem's own question
  // was swallowed by "no pending approval is waiting".) `apr-missing` never
  // parsed as an id — the pattern is exactly four characters — so this
  // fixture now names a well-formed id that simply does not exist.
  const prompt = 'approve apr-mi55';
  const provider = durableProviderRequest(channelId, prompt);
  const delivery = recordingTransport();

  await assert.rejects(
    tryHandleHarnessApprovalReply({
      channelId,
      prompt,
      transport: delivery.transport,
      allowGlobalApprovalFallback: true,
      durableRequest: provider.durableRequest,
    }),
    UnboundDurableApprovalReplyError,
  );

  const receipt = getInbound(provider.channel, provider.sourceMessageId);
  assert.equal(receipt?.status, 'claimed');
  assert.equal(receipt?.sessionId, undefined);
  assert.equal(receipt?.sourceUserSeq, undefined);
  assert.deepEqual(delivery.initial, []);
  assert.deepEqual(delivery.errors, []);
});

test('ambiguous bare approval commits needs-input without resolving either card', async () => {
  const channelId = 'chan-ambiguous-durable-approval';
  const session = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId },
  });
  bindDiscordHarnessSession({ channelId, sessionId: session.id });
  const first = approvalRegistry.register({
    sessionId: session.id,
    channel: 'discord',
    channelId,
    subject: 'Send the first message',
  });
  const second = approvalRegistry.register({
    sessionId: session.id,
    channel: 'discord',
    channelId,
    subject: 'Send the second message',
  });
  const provider = durableProviderRequest(channelId, 'approve');
  const delivery = recordingTransport();

  assert.equal(await tryHandleHarnessApprovalReply({
    channelId,
    prompt: 'approve',
    transport: delivery.transport,
    allowGlobalApprovalFallback: true,
    durableRequest: provider.durableRequest,
  }), true);

  assert.equal(approvalRegistry.get(first.approvalId)?.status, 'pending');
  assert.equal(approvalRegistry.get(second.approvalId)?.status, 'pending');
  assert.equal(listEvents(session.id, { types: ['user_input_received'] }).length, 1);
  assert.equal(terminalEvents(session.id).length, 1);
  assert.equal(typedTerminalStatus(session.id), 'needs_input');
  assert.match(delivery.initial[0], /Pick the one you mean/i);
  assert.equal(listEvents(session.id, { types: ['tool_called', 'run_completed'] }).length, 0);
});

test('cross-channel approval commits in the current conversation and leaves the foreign card pending', async () => {
  const currentChannelId = 'chan-current-approval';
  const foreignChannelId = 'chan-foreign-approval';
  const current = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId: currentChannelId },
  });
  const foreign = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId: foreignChannelId },
  });
  bindDiscordHarnessSession({ channelId: currentChannelId, sessionId: current.id });
  bindDiscordHarnessSession({ channelId: foreignChannelId, sessionId: foreign.id });
  const approval = approvalRegistry.register({
    sessionId: foreign.id,
    channel: 'discord',
    channelId: foreignChannelId,
    subject: 'Foreign write',
  });
  const prompt = `approve ${approval.approvalId}`;
  // The foreign card is not evidence for the current conversation. Mirror
  // real ingress by carrying the current session on the durable receipt.
  const provider = durableProviderRequest(currentChannelId, prompt, current.id);
  const delivery = recordingTransport();

  assert.equal(await tryHandleHarnessApprovalReply({
    channelId: currentChannelId,
    prompt,
    transport: delivery.transport,
    durableRequest: provider.durableRequest,
  }), true);

  assert.equal(approvalRegistry.get(approval.approvalId)?.status, 'pending');
  assert.equal(listEvents(current.id, { types: ['user_input_received'] }).length, 1);
  assert.equal(terminalEvents(current.id).length, 1);
  assert.equal(typedTerminalStatus(current.id), 'needs_input');
  assert.equal(listEvents(foreign.id, { types: ['user_input_received', 'conversation_completed'] }).length, 0);
  assert.match(delivery.initial[0], /different or stale conversation/i);
});

test('expired approval accepts its source before mutation and commits needs-input', async () => {
  const channelId = 'chan-expired-durable-approval';
  const session = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId },
  });
  bindDiscordHarnessSession({ channelId, sessionId: session.id });
  const approval = approvalRegistry.register({
    sessionId: session.id,
    channel: 'discord',
    channelId,
    subject: 'Expired write',
    ttlMs: -1,
  });
  const prompt = `approve ${approval.approvalId}`;
  const provider = durableProviderRequest(channelId, prompt);
  const delivery = recordingTransport();

  assert.equal(await tryHandleHarnessApprovalReply({
    channelId,
    prompt,
    transport: delivery.transport,
    durableRequest: provider.durableRequest,
  }), true);

  const users = listEvents(session.id, { types: ['user_input_received'] });
  const terminals = terminalEvents(session.id);
  assert.equal(approvalRegistry.get(approval.approvalId)?.status, 'expired');
  assert.equal(users.length, 1);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].data.sourceUserSeq, users[0].seq);
  assert.equal(typedTerminalStatus(session.id), 'needs_input');
  assert.match(delivery.initial[0], /has expired/i);
});

test('already-resolved approval gets a deterministic needs-input terminal without re-mutation', async () => {
  const channelId = 'chan-resolved-durable-approval';
  const session = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId },
  });
  bindDiscordHarnessSession({ channelId, sessionId: session.id });
  const approval = approvalRegistry.register({
    sessionId: session.id,
    channel: 'discord',
    channelId,
    subject: 'Already handled write',
  });
  assert.equal(approvalRegistry.resolve(approval.approvalId, 'approved', 'test').ok, true);
  const prompt = `approve ${approval.approvalId}`;
  const provider = durableProviderRequest(channelId, prompt);
  const delivery = recordingTransport();

  assert.equal(await tryHandleHarnessApprovalReply({
    channelId,
    prompt,
    transport: delivery.transport,
    durableRequest: provider.durableRequest,
  }), true);

  assert.equal(approvalRegistry.get(approval.approvalId)?.status, 'resolved');
  assert.equal(approvalRegistry.get(approval.approvalId)?.resolution, 'approved');
  assert.equal(listEvents(session.id, { types: ['user_input_received'] }).length, 1);
  assert.equal(terminalEvents(session.id).length, 1);
  assert.equal(typedTerminalStatus(session.id), 'needs_input');
  assert.match(delivery.initial[0], /already resolved/i);
});

test('model-runtime-unavailable resume has an accepted source and failed terminal without resolving approval', async () => {
  const channelId = 'chan-runtime-unavailable-approval';
  const session = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId },
  });
  bindDiscordHarnessSession({ channelId, sessionId: session.id });
  HarnessSession.load(session.id)?.saveInterruptState('{"test":"paused"}');
  const approval = approvalRegistry.register({
    sessionId: session.id,
    channel: 'discord',
    channelId,
    subject: 'Runtime-gated write',
  });
  const prompt = `approve ${approval.approvalId}`;
  const provider = durableProviderRequest(channelId, prompt);
  const delivery = recordingTransport();

  assert.equal(await tryHandleHarnessApprovalReply({
    channelId,
    prompt,
    transport: delivery.transport,
    durableRequest: provider.durableRequest,
  }), true);

  const users = listEvents(session.id, { types: ['user_input_received'] });
  const terminals = terminalEvents(session.id);
  assert.equal(users.length, 1);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].data.sourceUserSeq, users[0].seq);
  assert.equal(typedTerminalStatus(session.id), 'failed');
  assert.equal(approvalRegistry.get(approval.approvalId)?.status, 'pending');
  assert.equal(listEvents(session.id, { types: ['tool_called', 'run_completed'] }).length, 0);
  assert.match(delivery.initial[0], /model|connect|settings/i);
});
