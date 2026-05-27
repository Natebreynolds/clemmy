/**
 * Run: npx tsx --test src/runtime/rate-limited-alert.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-alert-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rateLimitedAlert, __resetAlertBuckets } = await import('./rate-limited-alert.js');
const { listNotifications, listQueuedNotificationDeliveries } = await import('./notifications.js');

test.beforeEach(async () => {
  await __resetAlertBuckets();
});

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('first hit on a fresh key fires immediately', async () => {
  const result = await rateLimitedAlert('first-fire', {
    title: 'something happened',
    body: 'detail',
  });
  assert.equal(result.fired, true);
  assert.equal(result.suppressedSinceLastFire, 0);
});

test('subsequent hits within the window are suppressed and counted', async () => {
  const key = 'suppress-key';
  const first = await rateLimitedAlert(key, { title: 'a', body: 'b' });
  assert.equal(first.fired, true);

  const second = await rateLimitedAlert(key, { title: 'a', body: 'b' });
  assert.equal(second.fired, false);
  assert.equal(second.suppressedSinceLastFire, 1);

  const third = await rateLimitedAlert(key, { title: 'a', body: 'b' });
  assert.equal(third.fired, false);
  assert.equal(third.suppressedSinceLastFire, 2);
});

test('after the window elapses the next hit fires again with counter reset', async () => {
  const key = 'window-expiry';
  await rateLimitedAlert(key, { title: 'a', body: 'b', windowMs: 30 });
  // Suppressed during the window.
  await rateLimitedAlert(key, { title: 'a', body: 'b', windowMs: 30 });
  await new Promise((r) => setTimeout(r, 50));
  // Window expired — next hit fires again.
  const reFire = await rateLimitedAlert(key, { title: 'a', body: 'b', windowMs: 30 });
  assert.equal(reFire.fired, true);
  assert.equal(reFire.suppressedSinceLastFire, 0);
});

test('different keys are independent', async () => {
  const a = await rateLimitedAlert('k-a', { title: 'a', body: 'a' });
  const b = await rateLimitedAlert('k-b', { title: 'b', body: 'b' });
  assert.equal(a.fired, true);
  assert.equal(b.fired, true);
});

test('a fired alert creates a notification record', async () => {
  await rateLimitedAlert('notify-key', {
    title: 'datafs token expired',
    body: '47 occurrences in 10 min',
  });
  const items = listNotifications(10);
  // Find OUR notification (other tests may have left siblings).
  const ours = items.filter((n) => (n.metadata as { alertKey?: string } | undefined)?.alertKey === 'notify-key');
  assert.equal(ours.length, 1);
  assert.equal(ours[0].title, 'datafs token expired');
  assert.equal(ours[0].kind, 'system');
  assert.equal(ours[0].body, '47 occurrences in 10 min');
});

test('suppressed alerts do NOT create notifications', async () => {
  const key = 'no-extra-notify';
  await rateLimitedAlert(key, { title: 'a', body: 'b' });
  await rateLimitedAlert(key, { title: 'a', body: 'b' });
  await rateLimitedAlert(key, { title: 'a', body: 'b' });
  const ours = listNotifications(50).filter((n) =>
    (n.metadata as { alertKey?: string } | undefined)?.alertKey === key,
  );
  assert.equal(ours.length, 1);
});

test('custom kind is honored', async () => {
  await rateLimitedAlert('kind-test', {
    title: 't',
    body: 'b',
    kind: 'workflow',
  });
  const items = listNotifications(10);
  const ours = items.filter((n) =>
    (n.metadata as { alertKey?: string } | undefined)?.alertKey === 'kind-test',
  );
  assert.equal(ours.length, 1);
  assert.equal(ours[0].kind, 'workflow');
});

test('silent alerts are recorded without delivery fanout', async () => {
  await rateLimitedAlert('silent-test', {
    title: 'MCP server unavailable',
    body: 'diagnostic only',
    silent: true,
  });
  const items = listNotifications(10);
  const ours = items.filter((n) =>
    (n.metadata as { alertKey?: string } | undefined)?.alertKey === 'silent-test',
  );
  assert.equal(ours.length, 1);
  assert.equal(ours[0].silent, true);
  assert.equal(
    listQueuedNotificationDeliveries().some((job) => job.notificationId === ours[0].id),
    false,
  );
});

test('metadata passed in is preserved on the notification', async () => {
  await rateLimitedAlert('meta-test', {
    title: 't',
    body: 'b',
    metadata: { slug: 'dataforseo', failureCount: 3 },
  });
  const items = listNotifications(10);
  const ours = items.filter((n) =>
    (n.metadata as { alertKey?: string } | undefined)?.alertKey === 'meta-test',
  );
  assert.equal(ours.length, 1);
  const meta = ours[0].metadata as { slug?: string; failureCount?: number; alertKey?: string };
  assert.equal(meta.slug, 'dataforseo');
  assert.equal(meta.failureCount, 3);
  assert.equal(meta.alertKey, 'meta-test');
});
