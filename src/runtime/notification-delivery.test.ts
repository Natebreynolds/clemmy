import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { NotificationRecord } from './notifications.js';
import { notificationDeliveryInternalsForTest } from './notification-delivery.js';

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

test('Discord delivery: only actionable approval notifications get plan buttons', () => {
  const approval = notification({
    kind: 'approval',
    title: 'Plan ready for review: smoke test',
    metadata: { planProposalId: 'plan-abc123' },
  });
  const components = notificationDeliveryInternalsForTest.buildDiscordComponentsForNotification(approval);
  const ids = customIds(components);

  assert.equal(notificationDeliveryInternalsForTest.shouldDeliverDiscordNotification(approval), true);
  assert.equal(ids.length, 3);
  assert.ok(ids.some((id) => id.includes('plan-approve:plan-abc123')));
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

test('Discord delivery: completed execution updates still deliver as plain text', () => {
  const completed = notification({
    kind: 'execution',
    title: 'Background task completed: Smoke test',
    metadata: { backgroundTaskId: 'bg-1' },
  });

  assert.equal(notificationDeliveryInternalsForTest.shouldDeliverDiscordNotification(completed), true);
  assert.equal(notificationDeliveryInternalsForTest.buildDiscordComponentsForNotification(completed), undefined);
});
