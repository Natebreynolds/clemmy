import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-slack-exact-delivery-'));
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  _setSlackOutboundClientForTests,
  sendSlackChannelMessage,
  slackDeliveryInternalsForTest,
} = await import('./slack.js');

type SlackPost = Record<string, unknown>;
type SlackMessage = {
  ts?: string;
  thread_ts?: string;
  metadata?: {
    event_type?: string;
    event_payload?: Record<string, unknown>;
  };
};

function observationClient(messages: SlackMessage[] = []) {
  const historyCalls: Array<Record<string, unknown>> = [];
  const unsafePosts: SlackPost[] = [];
  const client = {
    conversations: {
      history: async (args: Record<string, unknown>) => {
        historyCalls.push(args);
        return { ok: true, messages, response_metadata: { next_cursor: '' } };
      },
    },
    chat: {
      postMessage: async (args: SlackPost) => {
        unsafePosts.push(args);
        return { ok: true, ts: '1900000000.000001' };
      },
    },
  } as unknown as WebClient;
  return { client, historyCalls, unsafePosts };
}

function singleAttemptPostClient() {
  const posts: SlackPost[] = [];
  const client = {
    chat: {
      postMessage: async (args: SlackPost) => {
        posts.push(args);
        return { ok: true, ts: '1900000000.000001' };
      },
    },
  } as unknown as WebClient;
  return { client, posts };
}

afterEach(() => _setSlackOutboundClientForTests());
after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

test('exact Slack create uses the dedicated zero-retry client after provider observation', async () => {
  const observer = observationClient();
  const sender = singleAttemptPostClient();
  _setSlackOutboundClientForTests(observer.client, sender.client);

  await sendSlackChannelMessage('C0EXACT', 'Terminal result.', {
    exactDelivery: {
      key: 'a'.repeat(32),
      oldestTs: '1785760000.000000',
    },
  });

  assert.equal(slackDeliveryInternalsForTest.exactPostRetryCount, 0);
  assert.equal(slackDeliveryInternalsForTest.exactPostTimeoutMs, 15_000);
  assert.equal(observer.historyCalls.length, 1);
  assert.equal(observer.unsafePosts.length, 0, 'the retrying observation client must never create an exact message');
  assert.equal(sender.posts.length, 1, 'the zero-retry provider client owns the one create attempt');
});

test('top-level exact replay recognizes a Slack parent after it acquires thread_ts === ts', async () => {
  const key = 'b'.repeat(32);
  const ts = '1900000000.000001';
  const parent: SlackMessage = {
    ts,
    thread_ts: ts,
    metadata: {
      event_type: slackDeliveryInternalsForTest.exactDeliveryEventType,
      event_payload: { delivery_key: key },
    },
  };
  const observer = observationClient([parent]);
  const sender = singleAttemptPostClient();
  _setSlackOutboundClientForTests(observer.client, sender.client);

  await sendSlackChannelMessage('D0EXACT', 'Already delivered.', {
    exactDelivery: { key, oldestTs: '1785760000.000000' },
  });

  assert.equal(sender.posts.length, 0, 'a reply on the delivered parent must not turn crash replay into a duplicate post');
  assert.equal(slackDeliveryInternalsForTest.slackMessageMatchesExactDelivery({
    expectedChannelId: 'D0EXACT',
    expectedKey: key,
    observedChannelId: 'D0EXACT',
    message: parent,
  }), true);
});

test('a real threaded reply cannot satisfy a top-level exact replay', () => {
  const key = 'c'.repeat(32);
  assert.equal(slackDeliveryInternalsForTest.slackMessageMatchesExactDelivery({
    expectedChannelId: 'D0EXACT',
    expectedKey: key,
    observedChannelId: 'D0EXACT',
    message: {
      ts: '1900000000.000002',
      thread_ts: '1900000000.000001',
      metadata: {
        event_type: slackDeliveryInternalsForTest.exactDeliveryEventType,
        event_payload: { delivery_key: key },
      },
    },
  }), false);
});

test('ordinary Slack sends stay on the existing client and do not invoke provider observation', async () => {
  const observer = observationClient();
  const sender = singleAttemptPostClient();
  _setSlackOutboundClientForTests(observer.client, sender.client);

  await sendSlackChannelMessage('C0ORDINARY', 'Ordinary notification.');

  assert.equal(observer.historyCalls.length, 0);
  assert.equal(observer.unsafePosts.length, 1);
  assert.equal(sender.posts.length, 0);
});
