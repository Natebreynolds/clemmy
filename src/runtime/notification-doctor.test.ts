/**
 * Run: npx tsx --test src/runtime/notification-doctor.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotificationDoctor } from './notification-doctor.js';
import type { NotificationDestination, NotificationRecord } from './notifications.js';

function destination(partial: Partial<NotificationDestination>): NotificationDestination {
  return {
    id: partial.id ?? `dest-${partial.type ?? 'discord_user'}`,
    name: partial.name ?? 'Destination',
    type: partial.type ?? 'discord_user',
    enabled: partial.enabled ?? true,
    createdAt: '2026-07-03T10:00:00.000Z',
    ...partial,
  };
}

function notification(partial: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: partial.id ?? 'n1',
    kind: partial.kind ?? 'execution',
    title: partial.title ?? 'Background task completed: Demo',
    body: partial.body ?? 'Done',
    createdAt: partial.createdAt ?? '2026-07-03T10:01:00.000Z',
    read: partial.read ?? false,
    ...partial,
  };
}

test('buildNotificationDoctor marks Slack DM ready from an enabled Slack user destination', () => {
  const doctor = buildNotificationDoctor({
    destinations: [destination({ type: 'slack_user', userId: 'U123' })],
    notifications: [],
    slack: { enabled: true, connected: true, listening: true, teamName: 'Acme' },
    discord: { enabled: false, connected: false, guildCount: 0 },
    now: '2026-07-03T10:02:00.000Z',
  });

  const slack = doctor.surfaces.find((surface) => surface.id === 'slack');
  assert.equal(slack?.connected, true);
  assert.equal(slack?.configured, true);
  assert.equal(slack?.canDm, true);
  assert.equal(slack?.enabledDestinationCount, 1);
  assert.ok(slack?.issues.includes('No channel route configured'));
});

test('buildNotificationDoctor summarizes recent delivery receipts and explicit report-back targets', () => {
  const doctor = buildNotificationDoctor({
    destinations: [destination({ type: 'discord_channel', channelId: 'C1' })],
    notifications: [
      notification({
        id: 'done',
        deliveredAt: '2026-07-03T10:05:00.000Z',
        deliveredDestinations: ['Discord Channel C1'],
        metadata: { reportBackTargetType: 'discord_channel', reportBackTargetId: 'C1' },
      }),
      notification({
        id: 'failed',
        title: 'Background task failed: Demo',
        deliveryAttempts: 3,
        deliveryError: 'Discord client is not connected in this process.',
        metadata: { slackUserId: 'U123' },
      }),
      notification({
        id: 'partial',
        deliveredAt: '2026-07-03T10:04:00.000Z',
        deliveredDestinations: ['E2E Local Webhook'],
        deliveryAttempts: 4,
        deliveryError: 'Slack client is not connected in this process.',
      }),
      notification({ id: 'silent', silent: true }),
    ],
    discord: { enabled: true, connected: true, guildCount: 1 },
    slack: { enabled: true, connected: false },
    now: '2026-07-03T10:06:00.000Z',
  });

  assert.equal(doctor.recentReceipts.length, 3);
  assert.equal(doctor.recentReceipts[0].id, 'done');
  assert.equal(doctor.recentReceipts[0].status, 'delivered');
  assert.equal(doctor.recentReceipts[0].targetSummary, 'discord_channel: C1');
  assert.equal(doctor.recentReceipts[1].id, 'failed');
  assert.equal(doctor.recentReceipts[1].status, 'failed');
  assert.equal(doctor.recentReceipts[1].targetSummary, 'Slack DM: U123');
  assert.equal(doctor.recentReceipts[2].id, 'partial');
  assert.equal(doctor.recentReceipts[2].status, 'partial');
  assert.equal(doctor.recentReceipts[2].targetSummary, 'E2E Local Webhook');
});
