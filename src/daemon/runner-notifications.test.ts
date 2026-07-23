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

test('U5 (v2.3.0): a LOUD notification with nothing configured resolves the desktop leg and DELIVERS', async () => {
  addNotification({
    id: 'loud-desktop-1',
    kind: 'system',
    title: 'Loud with no external destinations',
    body: 'The desktop leg is the guaranteed surface.',
    createdAt: new Date().toISOString(),
    read: false,
  });
  await processNotificationDeliveries(assistantStub);
  assert.equal(
    listQueuedNotificationDeliveries().some((job) => job.notificationId === 'loud-desktop-1'),
    false,
    'the loud record delivered via the desktop leg — never deferred (the 2026-07-22 stuck-jobs class)',
  );
  assert.doesNotMatch(getNotification('loud-desktop-1')?.deliveryError ?? '', /no notification destinations/i);
});

// The no-destination backoff machinery has NO reachable case post-U5: loud
// records always resolve the desktop leg and deliver; silent records are
// dashboard-only and never enqueue delivery jobs. Only the legacy-record
// cleanup below still matters (queues written by pre-U5 versions).
test('legacy no-destination setup warnings are cleaned from the delivery queue', async () => {
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
