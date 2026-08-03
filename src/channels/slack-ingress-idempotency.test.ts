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
process.env.CLEMENTINE_HOME = TMP_HOME;

const { __test__ } = await import('./slack.js');
const {
  appendEvent,
  beginRunAttempt,
  createSession,
  listEvents,
  recordRunAttemptUserInput,
  resetEventLog,
} = await import('../runtime/harness/eventlog.js');
const { completeInbound, getInbound } = await import('./inbox-store.js');
const { PUBLIC_CHANNEL_FAILURE_TEXT } = await import('./public-failure.js');
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
  resetEventLog();
  if (PREV_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PREV_HOME;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

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
