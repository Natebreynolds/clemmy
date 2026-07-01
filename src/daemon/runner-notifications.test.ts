/**
 * Run: npx tsx --test src/daemon/runner-notifications.test.ts
 *
 * Focused daemon notification-delivery regressions. These tests keep
 * CLEMENTINE_HOME isolated and do not start the daemon loop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-daemon-notif-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.DISCORD_ENABLED = 'false';
process.env.SLACK_ENABLED = 'false';
process.env.WEBHOOK_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  addNotification,
  getNotification,
  listNotifications,
  listQueuedNotificationDeliveries,
} = await import('../runtime/notifications.js');
const { processNotificationDeliveries } = await import('./runner.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const assistantStub = {
  getRuntime() {
    return {
      listPendingApprovals() {
        return [];
      },
    };
  },
} as never;

test('no-destination notification jobs stay queued but back off noisy retries', async () => {
  addNotification({
    id: 'unroutable-1',
    kind: 'system',
    title: 'Unroutable test notification',
    body: 'No external destinations are configured.',
    createdAt: new Date().toISOString(),
    read: false,
  });

  await processNotificationDeliveries(assistantStub);

  const firstQueue = listQueuedNotificationDeliveries();
  assert.equal(firstQueue.length, 1, 'the original notification stays queued for future destinations');
  assert.equal(firstQueue[0].notificationId, 'unroutable-1');
  const firstRetryAt = firstQueue[0].nextAttemptAtByDestination?.__no_destinations__;
  assert.ok(firstRetryAt, 'queue records a no-destination retry timestamp');
  assert.ok(Date.parse(firstRetryAt) > Date.now(), 'retry timestamp is in the future');
  assert.match(getNotification('unroutable-1')?.deliveryError ?? '', /no notification destinations/i);

  const setupWarning = listNotifications(50)
    .find((item) => item.metadata?.errorCategory === 'no_destinations');
  assert.equal(setupWarning?.silent, true, 'setup warning is dashboard-only');
  assert.equal(
    listQueuedNotificationDeliveries().some((job) => job.notificationId === setupWarning?.id),
    false,
    'setup warning does not enqueue another unroutable delivery job',
  );

  await processNotificationDeliveries(assistantStub);
  const secondQueue = listQueuedNotificationDeliveries();
  assert.equal(secondQueue.length, 1);
  assert.equal(
    secondQueue[0].nextAttemptAtByDestination?.__no_destinations__,
    firstRetryAt,
    'a second immediate tick keeps the same backoff instead of re-prompting',
  );

  addNotification({
    id: 'legacy-no-destinations-warning',
    kind: 'system',
    title: '1 notification cannot be delivered',
    body: 'No notification destination is configured.',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { errorCategory: 'no_destinations' },
  });

  await processNotificationDeliveries(assistantStub);

  assert.equal(
    listQueuedNotificationDeliveries().some((job) => job.notificationId === 'legacy-no-destinations-warning'),
    false,
    'legacy no-destination setup warnings are removed from the external delivery queue',
  );
  assert.match(
    getNotification('legacy-no-destinations-warning')?.deliveryError ?? '',
    /dashboard-only/i,
    'legacy setup warning remains in Activity but is marked dashboard-only for delivery',
  );
});
