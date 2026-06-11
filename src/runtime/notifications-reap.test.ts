/** Run: npx tsx --test src/runtime/notifications-reap.test.ts */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-notif-reap-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { addNotification, listNotifications, reapStaleNotifications, getNotification } = await import('./notifications.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

function add(id: string, kind: 'approval' | 'execution' | 'system', daysAgo: number, read = false) {
  addNotification({
    id, kind, read,
    title: `n-${id}`, body: 'body',
    createdAt: new Date(Date.now() - daysAgo * 24 * 3600_000).toISOString(),
    silent: true,
  });
}

test('reapStaleNotifications: stale unread approval/execution flip to read; fresh + system untouched; >30d purged', () => {
  add('fresh-appr', 'approval', 1);
  add('stale-appr', 'approval', 10);
  add('stale-exec', 'execution', 14);
  add('stale-system', 'system', 14); // informational — left alone
  add('ancient', 'execution', 45);

  const stats = reapStaleNotifications();
  assert.equal(stats.markedRead, 2, 'stale approval + execution marked read');
  assert.equal(stats.purged, 1, 'ancient record purged');

  assert.equal(getNotification('fresh-appr')!.read, false, 'fresh actionable stays unread');
  assert.equal(getNotification('stale-appr')!.read, true);
  assert.equal(getNotification('stale-appr')!.metadata?.reapReason, 'stale_action_notification');
  assert.equal(getNotification('stale-exec')!.read, true);
  assert.equal(getNotification('stale-system')!.read, false, 'system notifications not action-reaped');
  assert.equal(getNotification('ancient'), undefined, 'purged from store');
  assert.ok(listNotifications(50).length >= 4);
});

test('reapStaleNotifications: idempotent — second pass is a no-op', () => {
  const again = reapStaleNotifications();
  assert.equal(again.markedRead, 0);
  assert.equal(again.purged, 0);
});
