/**
 * Focused Slack provider-ingress authority regressions.
 * Run: npx tsx --test src/channels/slack-ingress-idempotency.test.ts
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-slack-ingress-'));
const PREV_HOME = process.env.CLEMENTINE_HOME;
process.env.CLEMENTINE_HOME = TMP_HOME;

const { __test__ } = await import('./slack.js');
const {
  beginRunAttempt,
  createSession,
  listEvents,
  recordRunAttemptUserInput,
  resetEventLog,
} = await import('../runtime/harness/eventlog.js');
const { completeInbound, getInbound } = await import('./inbox-store.js');
const { PUBLIC_CHANNEL_FAILURE_TEXT } = await import('./public-failure.js');

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
