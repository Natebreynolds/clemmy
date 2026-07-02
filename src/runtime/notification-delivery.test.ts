import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { NotificationDestination, NotificationRecord } from './notifications.js';
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

test('Discord delivery: completed execution updates still deliver as plain text', () => {
  const completed = notification({
    kind: 'execution',
    title: 'Background task completed: Smoke test',
    metadata: { backgroundTaskId: 'bg-1' },
  });

  assert.equal(notificationDeliveryInternalsForTest.shouldDeliverDiscordNotification(completed), true);
  assert.equal(notificationDeliveryInternalsForTest.buildDiscordComponentsForNotification(completed), undefined);
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
