/**
 * Run: npx tsx --test src/runtime/notifications-exact-origin.test.ts
 *
 * The environment is intentionally noisy: configured destinations, Discord
 * and Slack fallbacks, a proactive Slack channel, web push, and legacy routing
 * metadata are all present. Exact-origin mode must still resolve one admitted
 * target or none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-exact-origin-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.DISCORD_ENABLED = 'true';
process.env.DISCORD_BOT_TOKEN = 'discord-test-token';
process.env.DISCORD_DM_ALLOWED_USERS = 'D_PRIMARY';
process.env.SLACK_ENABLED = 'true';
process.env.SLACK_BOT_TOKEN = 'slack-test-token';
process.env.SLACK_ALLOWED_USERS = 'U_PRIMARY';
process.env.SLACK_PROACTIVE_CHANNEL = 'C_PROACTIVE';

const {
  addNotification,
  exactOriginDeliveryDestinationId,
  exactOriginDeliveryMetadata,
  expectedExactOriginDeliveryReceipt,
  getNotification,
  getNotificationDestinationsForRecord,
  hasExactOriginDeliveryReceipt,
  hasExpectedExactOriginDeliveryReceipt,
  listQueuedNotificationDeliveries,
  upsertNotificationDestination,
} = await import('./notifications.js');

type Notification = Parameters<typeof getNotificationDestinationsForRecord>[0];

function record(metadata?: Record<string, unknown>): Notification {
  return {
    id: 'exact-test-record',
    kind: 'workflow',
    title: 'Lifecycle wrapper that must not route',
    body: 'Only this body should be delivered.',
    createdAt: '2026-08-03T12:00:00.000Z',
    read: false,
    metadata,
  };
}

upsertNotificationDestination({
  id: 'configured-generic',
  name: 'Configured generic destination',
  type: 'generic_webhook',
  url: 'https://configured.example/webhook',
  enabled: true,
  createdAt: '2026-08-03T00:00:00.000Z',
});
upsertNotificationDestination({
  id: 'configured-push',
  name: 'Configured web push',
  type: 'web_push',
  pushEndpoint: 'https://push.example/exact-test',
  pushP256dh: 'p256dh',
  pushAuth: 'auth',
  deviceId: 'exact-test-device',
  enabled: true,
  createdAt: '2026-08-03T00:00:00.000Z',
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('exact-origin Discord channel resolves exactly one target with no configured, fallback, proactive, push, or desktop fan-out', () => {
  const target = { type: 'discord_channel', channelId: 'discord-origin-42' } as const;
  const notification = record({
    ...exactOriginDeliveryMetadata(target),
    // Conflicting legacy hints are intentionally ignored in exact mode.
    discordChannelId: 'discord-wrong',
    slackChannelId: 'C_WRONG',
    slackThreadTs: '111.222',
    terminalReportBack: true,
    reportBackTargetType: 'origin_chat',
  });

  const destinations = getNotificationDestinationsForRecord(notification);
  const receipt = exactOriginDeliveryDestinationId(target);
  assert.equal(destinations.length, 1);
  assert.deepEqual(destinations[0], {
    id: receipt,
    name: receipt,
    type: 'discord_channel',
    channelId: target.channelId,
    enabled: true,
    createdAt: notification.createdAt,
  });
});

test('exact-origin Slack user and channel targets each resolve alone and preserve thread identity', () => {
  const userTarget = { type: 'slack_user', userId: 'U_EXACT' } as const;
  const userDestinations = getNotificationDestinationsForRecord(record({
    ...exactOriginDeliveryMetadata(userTarget),
    discordChannelId: 'discord-wrong',
  }));
  assert.equal(userDestinations.length, 1);
  assert.equal(userDestinations[0].type, 'slack_user');
  assert.equal(userDestinations[0].userId, userTarget.userId);
  assert.equal(userDestinations[0].id, exactOriginDeliveryDestinationId(userTarget));

  const channelTarget = {
    type: 'slack_channel',
    channelId: 'D0EXACT',
    threadTs: '1700000000.000100',
  } as const;
  const channelDestinations = getNotificationDestinationsForRecord(record({
    ...exactOriginDeliveryMetadata(channelTarget),
    slackChannelId: 'C_WRONG',
    slackThreadTs: '999.999',
  }));
  assert.equal(channelDestinations.length, 1);
  assert.equal(channelDestinations[0].type, 'slack_channel');
  assert.equal(channelDestinations[0].channelId, channelTarget.channelId);
  assert.equal(channelDestinations[0].threadTs, channelTarget.threadTs);
  assert.equal(channelDestinations[0].id, exactOriginDeliveryDestinationId(channelTarget));
});

test('exact-origin external metadata is enqueue-compatible and is not pre-acknowledged', () => {
  const id = 'exact-external-enqueue';
  const target = { type: 'discord_channel', channelId: 'discord-queue-target' } as const;
  addNotification({
    ...record(exactOriginDeliveryMetadata(target)),
    id,
  });

  const stored = getNotification(id);
  assert.ok(stored);
  assert.equal(stored.deliveredAt, undefined);
  assert.equal(hasExactOriginDeliveryReceipt(stored, target), false);
  assert.ok(listQueuedNotificationDeliveries().some((job) => job.notificationId === id));
  assert.deepEqual(
    getNotificationDestinationsForRecord(stored).map((destination) => destination.id),
    [exactOriginDeliveryDestinationId(target)],
  );
});

test('missing or corrupt exact-origin targets stay undelivered and never fall back', () => {
  const corruptMetadata: Record<string, unknown>[] = [
    { exactOriginDelivery: null },
    { exactOriginDelivery: { version: 1 } },
    { exactOriginDelivery: { version: 2, target: { type: 'discord_channel', channelId: 'discord-origin' } } },
    { exactOriginDelivery: { version: 1, target: { type: 'discord_channel' } } },
    { exactOriginDelivery: { version: 1, target: { type: 'slack_channel', channelId: 'C1', threadTs: '' } } },
    { exactOriginDelivery: { version: 1, target: { type: 'unsupported', channelId: 'C1' } } },
  ];

  for (const metadata of corruptMetadata) {
    const destinations = getNotificationDestinationsForRecord(record({
      ...metadata,
      discordChannelId: 'legacy-discord-must-not-route',
      slackUserId: 'legacy-slack-must-not-route',
    }));
    assert.deepEqual(destinations, [], JSON.stringify(metadata));
  }

  const id = 'exact-corrupt-enqueue';
  addNotification({
    ...record({
      exactOriginDelivery: { version: 1, target: { type: 'discord_channel' } },
      discordChannelId: 'legacy-discord-must-not-route',
      reportBackTargetType: 'origin_chat',
    }),
    id,
  });
  const stored = getNotification(id);
  assert.ok(stored);
  assert.equal(stored.deliveredAt, undefined);
  assert.equal(stored.deliveredDestinations, undefined);
  assert.equal(expectedExactOriginDeliveryReceipt(stored), undefined);
  assert.ok(listQueuedNotificationDeliveries().some((job) => job.notificationId === id));
  assert.deepEqual(getNotificationDestinationsForRecord(stored), []);
});

test('exact origin_chat is acknowledged by its precise receipt without an outbound or push leg', () => {
  const id = 'exact-origin-chat';
  const target = { type: 'origin_chat' } as const;
  const createdAt = '2026-08-03T12:34:56.000Z';
  addNotification({
    ...record({
      ...exactOriginDeliveryMetadata(target),
      terminalReportBack: true,
      reportBackTargetType: 'origin_chat',
    }),
    id,
    createdAt,
  });

  const stored = getNotification(id);
  assert.ok(stored);
  assert.equal(stored.deliveredAt, createdAt);
  assert.deepEqual(stored.deliveredDestinations, [exactOriginDeliveryDestinationId(target)]);
  assert.equal(hasExactOriginDeliveryReceipt(stored, target), true);
  assert.equal(hasExpectedExactOriginDeliveryReceipt(stored), true);
  assert.deepEqual(getNotificationDestinationsForRecord(stored), []);
  assert.ok(!listQueuedNotificationDeliveries().some((job) => job.notificationId === id));
});

test('receipt predicate requires exact target identity, including Slack thread', () => {
  const target = {
    type: 'slack_channel',
    channelId: 'D0EXACT',
    threadTs: '1700000000.000100',
  } as const;
  const exactReceipt = exactOriginDeliveryDestinationId(target);
  assert.ok(exactReceipt);
  const notification = record(exactOriginDeliveryMetadata(target));
  notification.deliveredAt = '2026-08-03T12:05:00.000Z';

  for (const wrongReceipt of [
    'Slack Channel D0EXACT Thread 1700000000.000100',
    `${exactReceipt}-almost`,
    exactOriginDeliveryDestinationId({ type: 'slack_channel', channelId: target.channelId }),
    exactOriginDeliveryDestinationId({
      type: 'slack_channel',
      channelId: target.channelId,
      threadTs: '1700000000.000101',
    }),
  ]) {
    notification.deliveredDestinations = wrongReceipt ? [wrongReceipt] : [];
    assert.equal(hasExactOriginDeliveryReceipt(notification, target), false, wrongReceipt);
    assert.equal(hasExpectedExactOriginDeliveryReceipt(notification), false, wrongReceipt);
  }

  notification.deliveredDestinations = [exactReceipt];
  assert.equal(hasExactOriginDeliveryReceipt(notification, target), true);
  assert.equal(hasExpectedExactOriginDeliveryReceipt(notification), true);

  const swappedMetadata = record(exactOriginDeliveryMetadata({
    type: 'slack_channel',
    channelId: target.channelId,
    threadTs: '1700000000.000101',
  }));
  swappedMetadata.deliveredDestinations = [exactReceipt];
  assert.equal(
    hasExactOriginDeliveryReceipt(swappedMetadata, target),
    false,
    'a receipt string cannot acknowledge a carrier whose embedded authority names another thread',
  );
  const missingMetadata = record();
  missingMetadata.deliveredDestinations = [exactReceipt];
  assert.equal(hasExactOriginDeliveryReceipt(missingMetadata, target), false);
});

test('metadata builder rejects malformed targets before enqueue', () => {
  assert.throws(
    () => exactOriginDeliveryMetadata({
      type: 'slack_channel',
      channelId: 'C_EXACT',
      threadTs: '',
    }),
    /invalid exact-origin delivery target/i,
  );
});
