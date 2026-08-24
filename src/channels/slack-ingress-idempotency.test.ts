/**
 * Focused Slack provider-ingress authority regressions.
 * Run: npx tsx --test src/channels/slack-ingress-idempotency.test.ts
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-slack-ingress-'));
const PREV_HOME = process.env.CLEMENTINE_HOME;
const PREV_HARNESS_WEBHOOK = process.env.CLEMMY_HARNESS_WEBHOOK;
const PREV_TURN_ENGINE = process.env.CLEMMY_TURN_ENGINE;
const PREV_ROUTING_MODE = process.env.MODEL_ROUTING_MODE;
const PREV_BYO_BASE_URL = process.env.BYO_MODEL_BASE_URL;
const PREV_BYO_API_KEY = process.env.BYO_MODEL_API_KEY;
const PREV_BYO_MODEL_ID = process.env.BYO_MODEL_ID;
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_HARNESS_WEBHOOK = 'on';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.MODEL_ROUTING_MODE = 'all_in';
process.env.BYO_MODEL_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.BYO_MODEL_API_KEY = 'test-only-byo-key';
process.env.BYO_MODEL_ID = 'test-only-model';

const { __test__ } = await import('./slack.js');
const {
  appendEvent,
  beginRunAttempt,
  createSession,
  listEvents,
  openEventLog,
  recordRunAttemptUserInput,
  resetEventLog,
} = await import('../runtime/harness/eventlog.js');
const { completeInbound, getInbound } = await import('./inbox-store.js');
const { PUBLIC_CHANNEL_FAILURE_TEXT } = await import('./public-failure.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const harnessApprovals = await import('../runtime/harness/approval-registry.js');
const {
  bindDiscordHarnessSession,
  getBoundDiscordHarnessSessionId,
} = await import('./discord-harness.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
const { resetHarnessRuntimeConfig } = await import('../runtime/harness/codex-client.js');
const { publicAsyncWorkDispatchedData } = await import('../runtime/harness/public-presentation.js');
const { commitTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
const { turnOutcomeId } = await import('../runtime/harness/turn-outcome.js');
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

after(() => {
  _setBridgeImplsForTests({});
  resetEventLog();
  if (PREV_HARNESS_WEBHOOK === undefined) delete process.env.CLEMMY_HARNESS_WEBHOOK;
  else process.env.CLEMMY_HARNESS_WEBHOOK = PREV_HARNESS_WEBHOOK;
  if (PREV_TURN_ENGINE === undefined) delete process.env.CLEMMY_TURN_ENGINE;
  else process.env.CLEMMY_TURN_ENGINE = PREV_TURN_ENGINE;
  if (PREV_ROUTING_MODE === undefined) delete process.env.MODEL_ROUTING_MODE;
  else process.env.MODEL_ROUTING_MODE = PREV_ROUTING_MODE;
  if (PREV_BYO_BASE_URL === undefined) delete process.env.BYO_MODEL_BASE_URL;
  else process.env.BYO_MODEL_BASE_URL = PREV_BYO_BASE_URL;
  if (PREV_BYO_API_KEY === undefined) delete process.env.BYO_MODEL_API_KEY;
  else process.env.BYO_MODEL_API_KEY = PREV_BYO_API_KEY;
  if (PREV_BYO_MODEL_ID === undefined) delete process.env.BYO_MODEL_ID;
  else process.env.BYO_MODEL_ID = PREV_BYO_MODEL_ID;
  if (PREV_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PREV_HOME;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function installSlackHostRunForTest(
  run: (options: {
    sessionId: string;
    input: string;
    sourceUserSeq?: number;
  }) => Promise<Record<string, unknown>>,
): () => void {
  resetHarnessRuntimeConfig();
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: run as never,
  });
  return () => _setBridgeImplsForTests({});
}

function fakeSlackClient() {
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args);
        return { ts: `${posts.length}.000` };
      },
      update: async () => ({}),
    },
  };
  return { client, posts };
}

function appendActiveWorkflowDispatch(
  source: import('../runtime/harness/eventlog.js').EventRow,
  runId: string,
) {
  const replyTarget = source.data.originReplyTarget as import('../runtime/exact-origin-delivery.js').ExactOriginDeliveryTarget;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'slack-dispatch-test',
    status: 'awaiting_chat_dispatch_seal',
  }), 'utf-8');
  const authority = createWorkflowChatDispatchPreparationAuthority({
    runId,
    observer: { sessionId: source.sessionId, sourceUserSeq: source.seq, replyTarget },
    queueRequestDigest: createHash('sha256').update(`slack-dispatch:${runId}`).digest('hex'),
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

function commitAnswerForSource(
  source: import('../runtime/harness/eventlog.js').EventRow,
  text: string,
) {
  const identity = { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.seq };
  return commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text },
  }, { legacyReason: 'slack_dispatch_test_terminal' });
}

test('Slack ordinary ingress atomically branches a held principal, retries once, and does not bleed to another user', async () => {
  resetEventLog();
  const channelId = 'C0HELDFRESHSOURCE';
  const teamId = 'T0HELDFRESHSOURCE';
  const userId = 'U0HELDFRESHSOURCE';
  const parent = HarnessSession.create({
    id: 'sess-slack-held-parent',
    kind: 'chat',
    channel: 'slack',
    userId,
    metadata: { source: 'slack', channelId, userId, guildId: teamId },
  });
  bindDiscordHarnessSession({ channel: 'slack', channelId, sessionId: parent.id, userId, guildId: teamId });
  const approval = harnessApprovals.register({
    sessionId: parent.id,
    channel: 'slack',
    channelId,
    subject: 'Older Slack request remains parked',
  });
  let hostCalls = 0;
  const acceptedSessions: string[] = [];
  const restore = installSlackHostRunForTest(async (options) => {
    hostCalls += 1;
    acceptedSessions.push(options.sessionId);
    const source = listEvents(options.sessionId, { types: ['user_input_received'] })
      .find((event) => event.seq === options.sourceUserSeq);
    assert.ok(source);
    const committed = commitAnswerForSource(source, `Slack answer ${hostCalls}`);
    return {
      sessionId: options.sessionId,
      status: 'completed',
      steps: 1,
      lastTurn: source.turn,
      publicPresentation: committed.presentation,
    };
  });
  try {
    const firstTransport = fakeSlackClient();
    const firstTs = '1785000090.000100';
    await __test__.dispatchInbound({
      client: firstTransport.client as never,
      channelId,
      teamId,
      userId,
      ts: firstTs,
      prompt: 'Start an unrelated Slack request.',
    });
    const firstReceipt = getInbound(`slack:${channelId}`, firstTs);
    assert.ok(firstReceipt?.sessionId);
    assert.notEqual(firstReceipt!.sessionId, parent.id);
    assert.equal(acceptedSessions[0], firstReceipt!.sessionId);
    assert.equal(harnessApprovals.get(approval.approvalId)?.status, 'pending');
    assert.equal(listEvents(parent.id, { types: ['user_input_received'] }).length, 0);

    const callsBeforeRetry = hostCalls;
    await __test__.dispatchInbound({
      client: firstTransport.client as never,
      channelId,
      teamId,
      userId,
      ts: firstTs,
      prompt: 'Start an unrelated Slack request.',
    });
    assert.equal(hostCalls, callsBeforeRetry);
    assert.equal(
      listEvents(firstReceipt!.sessionId!, { types: ['user_input_received'] }).length,
      1,
    );

    const otherUser = 'U0HELDFRESHOTHER';
    const otherTs = '1785000091.000100';
    await __test__.dispatchInbound({
      client: fakeSlackClient().client as never,
      channelId,
      teamId,
      userId: otherUser,
      ts: otherTs,
      prompt: 'This belongs to a different person.',
    });
    const otherReceipt = getInbound(`slack:${channelId}`, otherTs);
    assert.ok(otherReceipt?.sessionId);
    assert.notEqual(otherReceipt!.sessionId, parent.id);
    assert.notEqual(otherReceipt!.sessionId, firstReceipt!.sessionId);
  } finally {
    restore();
  }
});

test('Slack session-resume refuses cross-team, user, thread, channel, and provider targets without mutation', () => {
  resetEventLog();
  const conversationId = 'C0RESUMEAUTH:1785000200.000100';
  const target = HarnessSession.create({
    id: 'sess-slack-resume-authority',
    kind: 'chat',
    channel: 'slack',
    userId: 'U0RESUMEOWNER',
    metadata: {
      source: 'slack',
      channelId: conversationId,
      guildId: 'T0RESUMEOWNER',
      userId: 'U0RESUMEOWNER',
    },
  });
  const db = openEventLog();
  const metadataBefore = (db.prepare('SELECT metadata_json FROM sessions WHERE id = ?')
    .get(target.id) as { metadata_json: string }).metadata_json;
  const bindingsBefore = (db.prepare(
    'SELECT COUNT(*) AS count FROM accepted_source_session_bindings WHERE session_id = ?',
  ).get(target.id) as { count: number }).count;
  for (const mismatch of [
    { channelId: 'C0RESUMEAUTH', threadTs: '1785000200.000100', teamId: 'T0RESUMEOWNER', userId: 'U0RESUMEATTACKER' },
    { channelId: 'C0RESUMEAUTH', threadTs: '1785000200.000100', teamId: 'T0RESUMEATTACKER', userId: 'U0RESUMEOWNER' },
    { channelId: 'C0RESUMEAUTH', threadTs: '1785000201.000100', teamId: 'T0RESUMEOWNER', userId: 'U0RESUMEOWNER' },
    { channelId: 'C0RESUMEOTHER', threadTs: '1785000200.000100', teamId: 'T0RESUMEOWNER', userId: 'U0RESUMEOWNER' },
  ]) {
    assert.throws(() => __test__.bindSlackSessionResumeForAction({
      targetSessionId: target.id,
      actionIdentity: `forged:${JSON.stringify(mismatch)}`,
      ...mismatch,
    }), /audience|scope|conversation|principal/);
  }
  const discordTarget = HarnessSession.create({
    id: 'sess-discord-forged-slack-resume',
    kind: 'chat',
    channel: 'discord',
    userId: 'U0RESUMEOWNER',
    metadata: {
      source: 'discord',
      channelId: conversationId,
      guildId: 'T0RESUMEOWNER',
      userId: 'U0RESUMEOWNER',
    },
  });
  assert.throws(() => __test__.bindSlackSessionResumeForAction({
    targetSessionId: discordTarget.id,
    actionIdentity: 'forged-provider',
    channelId: 'C0RESUMEAUTH',
    threadTs: '1785000200.000100',
    teamId: 'T0RESUMEOWNER',
    userId: 'U0RESUMEOWNER',
  }), /provider|principal/);
  assert.equal(
    (db.prepare('SELECT metadata_json FROM sessions WHERE id = ?').get(target.id) as { metadata_json: string }).metadata_json,
    metadataBefore,
  );
  assert.equal((db.prepare(
    'SELECT COUNT(*) AS count FROM accepted_source_session_bindings WHERE session_id = ?',
  ).get(target.id) as { count: number }).count, bindingsBefore);
  assert.equal(getBoundDiscordHarnessSessionId(
    conversationId, 'slack', 'U0RESUMEATTACKER', 'T0RESUMEOWNER',
  ), null);
  assert.equal(__test__.bindSlackSessionResumeForAction({
    targetSessionId: target.id,
    actionIdentity: 'valid-slack-resume',
    channelId: 'C0RESUMEAUTH',
    threadTs: '1785000200.000100',
    teamId: 'T0RESUMEOWNER',
    userId: 'U0RESUMEOWNER',
  }), true);
  assert.equal(getBoundDiscordHarnessSessionId(
    conversationId, 'slack', 'U0RESUMEOWNER', 'T0RESUMEOWNER',
  ), target.id);
});

test('Slack stale retry after accepted-source crash fails closed with one source and one terminal', async () => {
  resetEventLog();
  const channelId = 'C-CRASH-REPLAY';
  const sourceMessageId = '1785000000.000100';
  const userId = 'U-CRASH-REPLAY';
  const prompt = 'send the external update exactly once';
  const ingress = __test__.claimSlackInboundRequest({
    channelId,
    sourceMessageId,
    userId,
    prompt,
  });
  const session = createSession({
    id: 'sess-slack-crash-replay',
    kind: 'chat',
    channel: 'slack',
    userId,
    metadata: { source: 'slack', channelId },
  });
  const crashedAttempt = beginRunAttempt(session.id, { runId: ingress.identity.runId });
  const accepted = recordRunAttemptUserInput(crashedAttempt, {
    turn: 1,
    role: 'user',
    data: {
      text: prompt,
      displayText: prompt,
      source: 'slack',
      runId: ingress.identity.runId,
      attemptId: crashedAttempt.attemptId,
    },
  }, { armRunInFlight: true });
  __test__.bindSlackInboundAcceptedSource(ingress, accepted);

  // Simulate the replacement daemon seeing a prior process failure. This makes
  // the inbox claim immediately retryable while preserving its durable source.
  completeInbound({
    ...ingress.inboxKey,
    runId: ingress.identity.runId,
    status: 'failed',
    error: 'process exited after acceptance',
  });

  const { client, posts } = fakeSlackClient();
  await __test__.dispatchInbound({
    client: client as never,
    channelId,
    userId,
    ts: sourceMessageId,
    prompt,
  });

  assert.equal(posts.length, 1, 'retry is answered without entering the Slack harness/model path');
  assert.equal(String(posts[0].text), PUBLIC_CHANNEL_FAILURE_TEXT);
  const users = listEvents(session.id, { types: ['user_input_received'] });
  const terminals = listEvents(session.id, { types: ['conversation_completed'] });
  assert.equal(users.length, 1);
  assert.equal(users[0].seq, accepted.seq);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].data.sourceUserSeq, accepted.seq);
  assert.equal(terminals[0].data.terminalKey, `turn:${accepted.seq}`);
  const receipt = getInbound(ingress.inboxKey.channel, sourceMessageId);
  assert.equal(receipt?.runId, ingress.identity.runId);
  assert.equal(receipt?.sourceUserSeq, accepted.seq);
  assert.equal(receipt?.status, 'replied');
});

test('Slack provider id payload conflict fails before source acceptance or work', async () => {
  resetEventLog();
  const channelId = 'C-PAYLOAD-CONFLICT';
  const sourceMessageId = '1785000001.000100';
  const original = __test__.claimSlackInboundRequest({
    channelId,
    sourceMessageId,
    userId: 'U-PAYLOAD-CONFLICT',
    threadTs: '1785000000.000000',
    prompt: 'original immutable request',
    files: [{ name: 'brief.txt', url_private: 'https://files.slack.test/original' }],
  });
  const { client, posts } = fakeSlackClient();
  await __test__.dispatchInbound({
    client: client as never,
    channelId,
    userId: 'U-PAYLOAD-CONFLICT',
    ts: sourceMessageId,
    threadTs: '1785000000.000000',
    prompt: 'changed request under the same provider id',
    files: [{ name: 'brief.txt', url_private: 'https://files.slack.test/original' }],
  });

  assert.equal(posts.length, 1);
  assert.equal(String(posts[0].text), PUBLIC_CHANNEL_FAILURE_TEXT);
  assert.equal(listEvents('sess-does-not-exist', { types: ['user_input_received'] }).length, 0);
  const receipt = getInbound(original.inboxKey.channel, sourceMessageId);
  assert.equal(receipt?.payloadHash, original.payloadHash);
  assert.equal(receipt?.runId, original.identity.runId);
  assert.equal(receipt?.sourceUserSeq, undefined);
  assert.equal(receipt?.attempts, 1);
});

test('Slack stale retry replays a verified workflow dispatch without stealing its later terminal', async () => {
  resetEventLog();
  const channelId = 'C0ASYNCREPLAY';
  const sourceMessageId = '1785000002.000100';
  const userId = 'U0ASYNCREPLAY';
  const prompt = 'prepare the long sales analysis and post it back here';
  const ingress = __test__.claimSlackInboundRequest({
    channelId,
    sourceMessageId,
    userId,
    prompt,
  });
  const session = createSession({
    id: 'sess-slack-verified-dispatch-replay',
    kind: 'chat',
    channel: 'slack',
    userId,
    metadata: { source: 'slack', channelId },
  });
  const crashedAttempt = beginRunAttempt(session.id, { runId: ingress.identity.runId });
  const accepted = recordRunAttemptUserInput(crashedAttempt, {
    turn: 1,
    role: 'user',
    data: {
      text: prompt,
      displayText: prompt,
      source: 'slack',
      runId: ingress.identity.runId,
      attemptId: crashedAttempt.attemptId,
    },
  }, { armRunInFlight: true });
  __test__.bindSlackInboundAcceptedSource(ingress, accepted);
  const dispatch = appendActiveWorkflowDispatch(accepted, 'workflow-slack-verified-dispatch');
  const expectedAck = publicAsyncWorkDispatchedData(dispatch.data)?.text;
  assert.ok(expectedAck);
  completeInbound({
    ...ingress.inboxKey,
    runId: ingress.identity.runId,
    status: 'failed',
    error: 'transport process exited after durable dispatch',
  });

  const { client, posts } = fakeSlackClient();
  await __test__.dispatchInbound({
    client: client as never,
    channelId,
    userId,
    ts: sourceMessageId,
    prompt,
  });

  assert.equal(posts.length, 1);
  assert.equal(String(posts[0].text), expectedAck);
  assert.equal(listEvents(session.id, { types: ['user_input_received'] }).length, 1);
  assert.equal(listEvents(session.id, { types: ['async_work_dispatched'] }).length, 1);
  assert.equal(listEvents(session.id, { types: ['conversation_completed'] }).length, 0,
    'a dispatch acknowledgement is not the conversation terminal');
  assert.equal(getInbound(ingress.inboxKey.channel, sourceMessageId)?.status, 'replied');

  const committed = commitAnswerForSource(accepted, 'The sales analysis is ready.');
  assert.equal(committed.inserted, true, 'the workflow result retains first-terminal authority');
  assert.equal(committed.presentation.text, 'The sales analysis is ready.');
  assert.equal(listEvents(session.id, { types: ['conversation_completed'] }).length, 1);
});

test('Slack replied duplicate is inert at the shouldProcess boundary', async () => {
  resetEventLog();
  const channelId = 'C0REPLIEDINERT';
  const sourceMessageId = '1785000003.000100';
  const userId = 'U0REPLIEDINERT';
  const prompt = 'this provider delivery was already answered';
  const ingress = __test__.claimSlackInboundRequest({
    channelId,
    sourceMessageId,
    userId,
    prompt,
  });
  completeInbound({
    ...ingress.inboxKey,
    runId: ingress.identity.runId,
    status: 'replied',
  });
  const { client, posts } = fakeSlackClient();

  await __test__.dispatchInbound({
    client: client as never,
    channelId,
    userId,
    ts: sourceMessageId,
    prompt,
  });

  assert.equal(posts.length, 0, 'replied duplicates never enter commands, model, tools, or transport');
  const receipt = getInbound(ingress.inboxKey.channel, sourceMessageId);
  assert.equal(receipt?.status, 'replied');
  assert.equal(receipt?.attempts, 1);
  assert.equal(receipt?.sourceUserSeq, undefined);
});
