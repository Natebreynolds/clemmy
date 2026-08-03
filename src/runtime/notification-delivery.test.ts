import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebClient } from '@slack/web-api';

import {
  exactOriginDeliveryMetadata,
  exactOriginDeliveryReceiptForTarget,
  type NotificationDestination,
  type NotificationRecord,
} from './notifications.js';
import {
  _setNotificationDeliverySendersForTests,
  deliverNotificationToDestination,
  notificationDeliveryInternalsForTest,
} from './notification-delivery.js';
import {
  _setSlackOutboundClientForTests,
  slackDeliveryInternalsForTest,
} from '../channels/slack.js';

function notification(patch: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: patch.id ?? 'n1',
    kind: patch.kind ?? 'system',
    title: patch.title ?? 'Test',
    body: patch.body ?? 'Body',
    createdAt: patch.createdAt ?? new Date().toISOString(),
    read: patch.read ?? false,
    metadata: patch.metadata,
    silent: patch.silent,
  };
}

type ObservedSlackMessage = {
  ts?: string;
  thread_ts?: string;
  metadata?: {
    event_type?: string;
    event_payload?: Record<string, unknown>;
  };
};

function fakeSlackClient(input: {
  historyMessages?: ObservedSlackMessage[];
  repliesMessages?: ObservedSlackMessage[];
  historyError?: Error;
  repliesError?: Error;
  dmChannelId?: string;
} = {}) {
  const posts: Array<Record<string, unknown>> = [];
  const historyCalls: Array<Record<string, unknown>> = [];
  const repliesCalls: Array<Record<string, unknown>> = [];
  const openCalls: Array<Record<string, unknown>> = [];
  const historyMessages = [...(input.historyMessages ?? [])];
  const repliesMessages = [...(input.repliesMessages ?? [])];
  const client = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args);
        return { ok: true, ts: '1900000000.000001' };
      },
    },
    conversations: {
      history: async (args: Record<string, unknown>) => {
        historyCalls.push(args);
        if (input.historyError) throw input.historyError;
        return { ok: true, messages: historyMessages, response_metadata: { next_cursor: '' } };
      },
      replies: async (args: Record<string, unknown>) => {
        repliesCalls.push(args);
        if (input.repliesError) throw input.repliesError;
        return { ok: true, messages: repliesMessages, response_metadata: { next_cursor: '' } };
      },
      open: async (args: Record<string, unknown>) => {
        openCalls.push(args);
        return { ok: true, channel: { id: input.dmChannelId ?? 'D-EXACT-USER' } };
      },
    },
  } as unknown as WebClient;
  return {
    client,
    posts,
    historyCalls,
    repliesCalls,
    openCalls,
    historyMessages,
    repliesMessages,
  };
}

afterEach(() => {
  _setSlackOutboundClientForTests();
  _setNotificationDeliverySendersForTests();
});

function customIds(rows: ReturnType<typeof notificationDeliveryInternalsForTest.buildDiscordComponentsForNotification>): string[] {
  if (!rows) return [];
  const ids: string[] = [];
  for (const row of rows) {
    const components = (row as { components?: Array<{ data?: { custom_id?: string } }> }).components ?? [];
    for (const comp of components) {
      const id = comp?.data?.custom_id;
      if (id) ids.push(id);
    }
  }
  return ids;
}

test('Discord delivery: stale plan metadata still delivers but has no dead buttons', () => {
  const approval = notification({
    kind: 'approval',
    title: 'Review before I start: smoke test',
    metadata: { planProposalId: 'plan-abc123' },
  });
  const components = notificationDeliveryInternalsForTest.buildDiscordComponentsForNotification(approval);
  const ids = customIds(components);

  assert.equal(notificationDeliveryInternalsForTest.shouldDeliverDiscordNotification(approval), true);
  assert.equal(ids.length, 0);
});

test('Discord delivery: plan-approved lifecycle notification is dashboard-only and has no buttons', () => {
  const approved = notification({
    kind: 'system',
    title: 'Plan approved: Prepare a confirm-first smoke-test batch',
    metadata: { planProposalId: 'plan-abc123' },
  });

  assert.equal(notificationDeliveryInternalsForTest.shouldDeliverDiscordNotification(approved), false);
  assert.equal(notificationDeliveryInternalsForTest.buildDiscordComponentsForNotification(approved), undefined);
});

test('Discord delivery: approved-plan queued lifecycle notification is dashboard-only and has no buttons', () => {
  const queued = notification({
    kind: 'execution',
    title: 'Approved plan queued: Prepare a confirm-first smoke-test batch',
    metadata: { planProposalId: 'plan-abc123', backgroundTaskId: 'bg-1' },
  });

  assert.equal(notificationDeliveryInternalsForTest.shouldDeliverDiscordNotification(queued), false);
  assert.equal(notificationDeliveryInternalsForTest.buildDiscordComponentsForNotification(queued), undefined);
});

test('Discord delivery: background lifecycle pings stay out of Discord', () => {
  for (const title of [
    'Background task queued: Smoke test',
    'Background task started: Smoke test',
    'Background task progress: Smoke test',
    'Background task heartbeat: Smoke test',
  ]) {
    assert.equal(
      notificationDeliveryInternalsForTest.shouldDeliverDiscordNotification(notification({ kind: 'execution', title })),
      false,
      title,
    );
  }
});

test('Discord delivery: a loud "background task update:" progress heartbeat reaches the channel', () => {
  const update = notification({
    kind: 'execution',
    title: 'Background task update: the quarterly SEO analysis',
    body: 'Still working on the quarterly SEO analysis — 12m in, 23 tool calls.\nCurrently: serp_organic_live_advanced',
    metadata: { backgroundTaskId: 'bg-1', heartbeat: true },
    // Loud heartbeat: not silent, so it is delivered like a terminal report-back.
    silent: false,
  });
  assert.equal(notificationDeliveryInternalsForTest.shouldDeliverDiscordNotification(update), true);
  assert.equal(notificationDeliveryInternalsForTest.buildDiscordComponentsForNotification(update), undefined);
});

test('Discord delivery: a silent (kill-switch off) heartbeat stays dashboard-only', () => {
  const silentUpdate = notification({
    kind: 'execution',
    title: 'Background task update: the quarterly SEO analysis',
    metadata: { backgroundTaskId: 'bg-1', heartbeat: true },
    silent: true,
  });
  assert.equal(notificationDeliveryInternalsForTest.shouldDeliverDiscordNotification(silentUpdate), false);
});

test('Discord delivery: completed execution updates still deliver as plain text', () => {
  const completed = notification({
    kind: 'execution',
    title: 'Background task completed: Smoke test',
    metadata: { backgroundTaskId: 'bg-1' },
  });

  assert.equal(notificationDeliveryInternalsForTest.shouldDeliverDiscordNotification(completed), true);
  assert.equal(notificationDeliveryInternalsForTest.buildDiscordComponentsForNotification(completed), undefined);
});

test('exact-origin Discord delivery is body-only and bypasses lifecycle suppression without approval chrome', () => {
  const exact = notification({
    kind: 'approval',
    title: 'Background task queued: this title must not be narrated',
    body: 'The requested report is ready.',
    metadata: {
      ...exactOriginDeliveryMetadata({ type: 'discord_channel', channelId: 'discord-origin-1' }),
      discordInlineHandled: true,
      approvalId: 'approval-that-must-not-render',
    },
  });

  assert.equal(notificationDeliveryInternalsForTest.shouldDeliverDiscordNotification(exact), true);
  assert.equal(notificationDeliveryInternalsForTest.buildDiscordBotMessage(exact), exact.body);
  assert.equal(notificationDeliveryInternalsForTest.buildDiscordComponentsForNotification(exact), undefined);
  assert.ok(!notificationDeliveryInternalsForTest.buildDiscordBotMessage(exact).includes(exact.title));
  const nonce = notificationDeliveryInternalsForTest.exactDiscordDeliveryNonce(exact);
  assert.match(nonce ?? '', /^[a-f0-9]{24}$/);
  assert.equal(
    notificationDeliveryInternalsForTest.exactDiscordDeliveryNonce({ ...exact }),
    nonce,
    'a retry of the durable notification must reuse the provider nonce',
  );
  assert.notEqual(
    notificationDeliveryInternalsForTest.exactDiscordDeliveryNonce({ ...exact, id: `${exact.id}-other` }),
    nonce,
  );
});

test('exact-origin Slack delivery is body-only and has no approval blocks', () => {
  const exact = notification({
    kind: 'approval',
    title: 'Internal lifecycle wrapper',
    body: 'Here is the answer you requested.',
    metadata: {
      ...exactOriginDeliveryMetadata({ type: 'slack_user', userId: 'U_EXACT' }),
      slackInlineHandled: true,
      approvalId: 'approval-that-must-not-render',
    },
  });

  assert.equal(notificationDeliveryInternalsForTest.buildSlackBotMessage(exact), exact.body);
  assert.equal(notificationDeliveryInternalsForTest.buildSlackBlocksForNotification(exact), undefined);
  assert.ok(!notificationDeliveryInternalsForTest.buildSlackBotMessage(exact).includes(exact.title));
});

test('exact-origin send path rejects a destination that does not match admitted authority', async () => {
  const exact = notification({
    metadata: {
      ...exactOriginDeliveryMetadata({ type: 'discord_channel', channelId: 'discord-origin-1' }),
    },
  });
  const wrongDestination: NotificationDestination = {
    id: 'derived-desktop',
    name: 'Desktop app',
    type: 'desktop',
    enabled: true,
    createdAt: exact.createdAt,
  };

  await assert.rejects(
    () => deliverNotificationToDestination(exact, wrongDestination),
    /does not match its admitted target/i,
  );
});

// ── Slack placement: terminal report-backs to an IM channel post top-level ──
function slackChannelDest(patch: Partial<NotificationDestination>): NotificationDestination {
  return {
    id: patch.id ?? 'd1',
    name: patch.name ?? 'slack channel',
    type: 'slack_channel',
    channelId: patch.channelId,
    threadTs: patch.threadTs,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

test('isTerminalReportBack: workflow + cron + background completion/failure are terminal', () => {
  const { isTerminalReportBack } = notificationDeliveryInternalsForTest;
  assert.equal(isTerminalReportBack(notification({ kind: 'workflow', title: 'Morning brief' })), true);
  assert.equal(isTerminalReportBack(notification({ kind: 'cron', title: 'Daily digest' })), true);
  assert.equal(isTerminalReportBack(notification({ kind: 'execution', title: 'Background task completed: X' })), true);
  assert.equal(isTerminalReportBack(notification({ kind: 'execution', title: 'Background task failed: X' })), true);
  // Not terminal report-backs:
  assert.equal(isTerminalReportBack(notification({ kind: 'approval', title: 'Approve before I start' })), false);
  assert.equal(isTerminalReportBack(notification({ kind: 'execution', title: 'Background task started: X' })), false);
  assert.equal(isTerminalReportBack(notification({ kind: 'system', title: 'Heads up' })), false);
});

test('slackThreadForDelivery: drops the stale pane thread for a terminal report-back on an IM (D) channel', () => {
  const completed = notification({ kind: 'execution', title: 'Background task completed: Deep SEO' });
  const dest = slackChannelDest({ channelId: 'D0ABC', threadTs: '1700000000.000100' });
  assert.equal(notificationDeliveryInternalsForTest.slackThreadForDelivery(completed, dest), undefined);
});

test('slackThreadForDelivery: keeps the thread on a real (C) channel where the thread is the conversation', () => {
  const completed = notification({ kind: 'workflow', title: 'Weekly report' });
  const dest = slackChannelDest({ channelId: 'C0TEAM', threadTs: '1700000000.000100' });
  assert.equal(notificationDeliveryInternalsForTest.slackThreadForDelivery(completed, dest), '1700000000.000100');
});

test('slackThreadForDelivery: keeps the thread for a NON-terminal (approval) notification even on an IM channel', () => {
  const approval = notification({ kind: 'approval', title: 'Background task awaiting approval: send email' });
  const dest = slackChannelDest({ channelId: 'D0ABC', threadTs: '1700000000.000100' });
  assert.equal(notificationDeliveryInternalsForTest.slackThreadForDelivery(approval, dest), '1700000000.000100');
});

test('slackThreadForDelivery: no threadTs stays undefined (fresh top-level post)', () => {
  const completed = notification({ kind: 'execution', title: 'Background task completed: X' });
  const dest = slackChannelDest({ channelId: 'D0ABC' });
  assert.equal(notificationDeliveryInternalsForTest.slackThreadForDelivery(completed, dest), undefined);
});

test('exact-origin Slack terminal delivery posts top-level in an IM despite a legacy admitted pane thread', () => {
  const threadTs = '1700000000.000100';
  const completed = notification({
    kind: 'execution',
    title: 'Background task completed: exact follow-up',
    metadata: {
      ...exactOriginDeliveryMetadata({
        type: 'slack_channel',
        channelId: 'D0EXACT',
        threadTs,
      }),
    },
  });
  const dest = slackChannelDest({ channelId: 'D0EXACT', threadTs });

  assert.equal(notificationDeliveryInternalsForTest.slackThreadForDelivery(completed, dest), undefined);
});

test('exact-origin Slack terminal delivery retains an admitted real-channel thread', () => {
  const threadTs = '1700000000.000100';
  const completed = notification({
    kind: 'workflow',
    title: 'Platform 49 review',
    metadata: {
      ...exactOriginDeliveryMetadata({
        type: 'slack_channel',
        channelId: 'C0EXACT',
        threadTs,
      }),
    },
  });
  const dest = slackChannelDest({ channelId: 'C0EXACT', threadTs });

  assert.equal(notificationDeliveryInternalsForTest.slackThreadForDelivery(completed, dest), threadTs);
});

test('exact Slack channel delivery passes a stable key to the actual sender and suppresses a crash replay', async () => {
  const target = { type: 'slack_channel' as const, channelId: 'C0DELIVERY' };
  const receipt = exactOriginDeliveryReceiptForTarget(target);
  assert.ok(receipt);
  const exact = notification({
    id: 'notif-durable-slack-1',
    kind: 'workflow',
    title: 'Platform 49 review complete',
    body: 'Here is what changed since the last run.',
    createdAt: '2026-08-03T13:26:00.000Z',
    metadata: { ...exactOriginDeliveryMetadata(target) },
  });
  const destination: NotificationDestination = {
    id: receipt,
    name: receipt,
    type: 'slack_channel',
    channelId: target.channelId,
    enabled: true,
    createdAt: exact.createdAt,
  };
  const fake = fakeSlackClient();
  _setSlackOutboundClientForTests(fake.client);

  const identity = notificationDeliveryInternalsForTest.exactSlackDeliveryIdentity(exact);
  assert.ok(identity);
  await deliverNotificationToDestination(exact, destination);

  assert.equal(fake.posts.length, 1);
  assert.deepEqual(fake.posts[0]?.metadata, {
    event_type: slackDeliveryInternalsForTest.exactDeliveryEventType,
    event_payload: { delivery_key: identity.key },
  });
  assert.deepEqual(fake.historyCalls[0], {
    channel: target.channelId,
    oldest: identity.oldestTs,
    inclusive: true,
    include_all_metadata: true,
    limit: 100,
  });

  // Model the real crash window: Slack accepted the first post, but the local
  // delivery receipt was never saved. The provider message is now observable.
  fake.historyMessages.push({
    ts: '1900000000.000001',
    metadata: fake.posts[0]?.metadata as ObservedSlackMessage['metadata'],
  });
  await deliverNotificationToDestination(exact, destination);
  assert.equal(fake.posts.length, 1, 'provider observation must reuse success instead of posting twice');
  assert.equal(fake.historyCalls.length, 2);
});

test('Slack exact metadata cannot be satisfied by the wrong channel, thread, or key', () => {
  const key = 'a'.repeat(32);
  const message: ObservedSlackMessage = {
    thread_ts: '1700000000.000100',
    metadata: {
      event_type: slackDeliveryInternalsForTest.exactDeliveryEventType,
      event_payload: { delivery_key: key },
    },
  };
  const matches = slackDeliveryInternalsForTest.slackMessageMatchesExactDelivery;
  const base = {
    expectedChannelId: 'C0EXPECTED',
    expectedThreadTs: '1700000000.000100',
    expectedKey: key,
    observedChannelId: 'C0EXPECTED',
    message,
  };

  assert.equal(matches(base), true);
  assert.equal(matches({ ...base, observedChannelId: 'C0WRONG' }), false);
  assert.equal(matches({ ...base, expectedThreadTs: '1700000000.000200' }), false);
  assert.equal(matches({ ...base, expectedKey: 'b'.repeat(32) }), false);
  assert.equal(matches({ ...base, expectedThreadTs: undefined }), false, 'a threaded post cannot satisfy top-level delivery');
});

test('exact Slack delivery fails closed when provider observation is unavailable', async () => {
  const target = { type: 'slack_channel' as const, channelId: 'C0UNAVAILABLE' };
  const receipt = exactOriginDeliveryReceiptForTarget(target);
  assert.ok(receipt);
  const exact = notification({
    id: 'notif-slack-observation-unavailable',
    createdAt: '2026-08-03T13:26:00.000Z',
    metadata: { ...exactOriginDeliveryMetadata(target) },
  });
  const fake = fakeSlackClient({ historyError: new Error('missing conversations:history scope') });
  _setSlackOutboundClientForTests(fake.client);

  await assert.rejects(
    () => deliverNotificationToDestination(exact, {
      id: receipt,
      name: receipt,
      type: 'slack_channel',
      channelId: target.channelId,
      enabled: true,
      createdAt: exact.createdAt,
    }),
    /observation is unavailable.*duplicate-risk/i,
  );
  assert.equal(fake.posts.length, 0);
});

test('exact Slack user delivery observes the opened DM before posting', async () => {
  const target = { type: 'slack_user' as const, userId: 'U0EXACT' };
  const receipt = exactOriginDeliveryReceiptForTarget(target);
  assert.ok(receipt);
  const exact = notification({
    id: 'notif-slack-user-replay',
    createdAt: '2026-08-03T13:26:00.000Z',
    metadata: { ...exactOriginDeliveryMetadata(target) },
  });
  const identity = notificationDeliveryInternalsForTest.exactSlackDeliveryIdentity(exact);
  assert.ok(identity);
  const fake = fakeSlackClient({
    dmChannelId: 'D0EXACTUSER',
    historyMessages: [{
      ts: '1900000000.000001',
      metadata: {
        event_type: slackDeliveryInternalsForTest.exactDeliveryEventType,
        event_payload: { delivery_key: identity.key },
      },
    }],
  });
  _setSlackOutboundClientForTests(fake.client);

  await deliverNotificationToDestination(exact, {
    id: receipt,
    name: receipt,
    type: 'slack_user',
    userId: target.userId,
    enabled: true,
    createdAt: exact.createdAt,
  });

  assert.deepEqual(fake.openCalls, [{ users: target.userId }]);
  assert.equal(fake.historyCalls[0]?.channel, 'D0EXACTUSER');
  assert.equal(fake.posts.length, 0);
});

test('non-exact Slack delivery remains a direct post without observation or metadata', async () => {
  const ordinary = notification({ id: 'ordinary-slack' });
  const fake = fakeSlackClient({ historyError: new Error('must not be called') });
  _setSlackOutboundClientForTests(fake.client);

  await deliverNotificationToDestination(ordinary, slackChannelDest({ channelId: 'C0ORDINARY' }));

  assert.equal(fake.historyCalls.length, 0);
  assert.equal(fake.posts.length, 1);
  assert.equal('metadata' in (fake.posts[0] ?? {}), false);
});

test('exact Discord channel delivery passes its stable nonce with provider enforcement', async () => {
  const target = { type: 'discord_channel' as const, channelId: 'discord-exact-channel' };
  const receipt = exactOriginDeliveryReceiptForTarget(target);
  assert.ok(receipt);
  const exact = notification({
    id: 'notif-durable-discord-1',
    body: 'The requested result is ready.',
    metadata: { ...exactOriginDeliveryMetadata(target) },
  });
  let captured: { channelId: string; text: string; options: { nonce?: string; enforceNonce?: boolean } } | undefined;
  _setNotificationDeliverySendersForTests({
    sendDiscordChannelMessage: async (channelId, text, options) => {
      captured = { channelId, text, options };
    },
  });

  await deliverNotificationToDestination(exact, {
    id: receipt,
    name: receipt,
    type: 'discord_channel',
    channelId: target.channelId,
    enabled: true,
    createdAt: exact.createdAt,
  });

  assert.deepEqual(captured, {
    channelId: target.channelId,
    text: exact.body,
    options: {
      nonce: notificationDeliveryInternalsForTest.exactDiscordDeliveryNonce(exact),
      enforceNonce: true,
    },
  });
});

// ── Discord rendering: buildDiscordBotMessage adapts GFM to Discord's subset ──
test('buildDiscordBotMessage: pipe table becomes an aligned code-block table', () => {
  const withTable = notification({
    kind: 'workflow',
    title: 'Report',
    body: 'Rankings:\n\n| Firm | Keywords |\n| --- | --- |\n| Acme | 12 |\n| Beta | 340 |',
  });
  const out = notificationDeliveryInternalsForTest.buildDiscordBotMessage(withTable);
  // Bold title preserved, no raw pipe rows, fenced code block present.
  assert.match(out, /\*\*Report\*\*/);
  assert.match(out, /```/);
  assert.ok(!/\| --- \|/.test(out), 'GFM separator row should be gone');
  // Alignment: the wide value column padded the header cell out.
  assert.match(out, /Firm {2}Keywords/);
});
