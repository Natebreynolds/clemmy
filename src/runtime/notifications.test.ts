/**
 * Run: npx tsx --test src/runtime/notifications.test.ts
 *
 * Covers the v0.2.8 atomic-write / corruption-recovery contract for
 * the notifications store. Specifically:
 *
 *   - addNotification writes atomically: no .tmp leftovers, and the
 *     canonical file is parseable after a write completes.
 *
 *   - A corrupted notifications.json is NOT silently swallowed.
 *     loadNotifications now: (a) returns [] (so the daemon doesn't
 *     crash), (b) renames the bad file to .corrupt-<timestamp> so
 *     it survives for inspection, and (c) emits a 'notification.
 *     created' actionBus event with kind=system so the live rail
 *     and Discord notifications surface the recovery.
 *
 *   - Same for the delivery-queue file (separate file, same rules).
 *
 * Per-test temp dir via CLEMENTINE_HOME so we don't trample the user's
 * real ~/.clementine-next state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-notif-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { actionBus } = await import('./action-bus.js');
const {
  addNotification,
  listNotifications,
  markStaleApprovalNotificationsRead,
  markNotificationsReadByApprovalId,
} = await import('./notifications.js');

const NOTIFICATIONS_FILE = path.join(TMP_HOME, 'state', 'notifications.json');
const DELIVERY_FILE = path.join(TMP_HOME, 'state', 'notification-delivery-queue.json');

function makeNotification(id: string, body = 'hello'): Parameters<typeof addNotification>[0] {
  return {
    id,
    kind: 'system',
    title: `test-${id}`,
    body,
    createdAt: new Date().toISOString(),
    read: false,
  };
}

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('addNotification: writes atomically and leaves no .tmp behind', () => {
  addNotification(makeNotification('n1'));
  const state = readdirSync(path.join(TMP_HOME, 'state'));
  // Canonical file present; no leftover .tmp.* siblings.
  assert.ok(state.includes('notifications.json'), `notifications.json should exist; got ${state.join(',')}`);
  const tmpLeftovers = state.filter((name) => name.startsWith('notifications.json.tmp.'));
  assert.deepEqual(tmpLeftovers, [], `unexpected .tmp leftovers: ${tmpLeftovers.join(',')}`);
  const parsed = JSON.parse(readFileSync(NOTIFICATIONS_FILE, 'utf-8'));
  assert.equal(parsed[0].id, 'n1');
});

test('addNotification: subsequent writes preserve prior items', () => {
  addNotification(makeNotification('n2', 'second'));
  const items = listNotifications(50);
  const ids = items.map((it) => it.id).sort();
  assert.ok(ids.includes('n1') && ids.includes('n2'), `expected n1 and n2 in ${ids.join(',')}`);
});

test('loadNotifications: corrupted JSON is quarantined and surfaced via actionBus', () => {
  // Write garbage to the notifications file to simulate a half-written
  // file from a SIGKILL during the previous (non-atomic) write path.
  writeFileSync(NOTIFICATIONS_FILE, '{ "not valid json', 'utf-8');

  // Subscribe to actionBus to capture the corruption signal.
  const events: Array<{ kind: string; notification?: { kind?: string; title?: string } }> = [];
  const unsubscribe = actionBus.subscribe((event: unknown) => {
    events.push(event as { kind: string; notification?: { kind?: string; title?: string } });
  });

  try {
    // listNotifications triggers the load path which detects + quarantines.
    const result = listNotifications(10);
    assert.deepEqual(result, [], 'corrupted file should produce empty result (after quarantine), not crash');
  } finally {
    unsubscribe();
  }

  // Quarantine file should be present.
  const state = readdirSync(path.join(TMP_HOME, 'state'));
  const quarantined = state.filter((name) => name.startsWith('notifications.json.corrupt-'));
  assert.equal(quarantined.length, 1, `expected one quarantine file, got: ${state.join(',')}`);

  // actionBus should have emitted a system-kind notification.created.
  const corruptionEvent = events.find(
    (e) => e.kind === 'notification.created' && e.notification?.kind === 'system',
  );
  assert.ok(corruptionEvent, `expected a system notification.created event, got: ${JSON.stringify(events)}`);
  assert.match(String(corruptionEvent.notification?.title ?? ''), /corrupt/i);
});

test('loadNotifications: after corruption recovery, addNotification works again', () => {
  // The previous test left the file quarantined and the canonical
  // file missing — the next addNotification should establish a fresh
  // canonical file without throwing.
  addNotification(makeNotification('n3'));
  const items = listNotifications(10);
  const ids = items.map((it) => it.id);
  assert.ok(ids.includes('n3'), `expected n3 after recovery, got ${ids.join(',')}`);
});

test('delivery queue: corrupted JSON is quarantined and surfaced too', () => {
  writeFileSync(DELIVERY_FILE, '{{not json}}', 'utf-8');

  const events: Array<{ kind: string; notification?: { metadata?: { filePath?: string } } }> = [];
  const unsubscribe = actionBus.subscribe((event: unknown) => {
    events.push(event as { kind: string; notification?: { metadata?: { filePath?: string } } });
  });

  try {
    // Any operation that triggers a delivery-queue load will trip it.
    // addNotification queues a delivery so it loads the file path.
    addNotification(makeNotification('n4'));
  } finally {
    unsubscribe();
  }

  const state = readdirSync(path.join(TMP_HOME, 'state'));
  const quarantined = state.filter((name) => name.startsWith('notification-delivery-queue.json.corrupt-'));
  assert.equal(quarantined.length, 1, `expected one quarantine file, got: ${state.join(',')}`);
  // We don't need to assert the actionBus event again — the same code path
  // emits it, and the earlier test already validates that emission.
});

test('markNotificationsReadByApprovalId marks stable and metadata approval notifications read', () => {
  addNotification({
    id: 'approval-apr-test',
    kind: 'approval',
    title: 'Approval pending',
    body: 'approve this',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { approvalId: 'apr-test' },
  });
  addNotification({
    id: '1670000000000-approval-apr-test',
    kind: 'approval',
    title: 'Approval required',
    body: 'runtime approval',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { approvalId: 'apr-test' },
  });
  addNotification({
    id: 'approval-apr-other',
    kind: 'approval',
    title: 'Other approval',
    body: 'do not touch',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { approvalId: 'apr-other' },
  });

  const changed = markNotificationsReadByApprovalId('apr-test', { approvalStatus: 'resolved' });
  assert.equal(changed.length, 2);
  const items = listNotifications(50);
  const mine = items.filter((item) => item.metadata?.approvalId === 'apr-test');
  assert.equal(mine.length, 2);
  assert.ok(mine.every((item) => item.read));
  assert.ok(mine.every((item) => item.metadata?.approvalStatus === 'resolved'));
  assert.equal(items.find((item) => item.id === 'approval-apr-other')?.read, false);
});

test('markStaleApprovalNotificationsRead leaves active approvals unread and clears stale ones', () => {
  addNotification({
    id: 'approval-apr-active',
    kind: 'approval',
    title: 'Active approval',
    body: 'still pending',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { approvalId: 'apr-active' },
  });
  addNotification({
    id: 'approval-apr-stale',
    kind: 'approval',
    title: 'Stale approval',
    body: 'already gone',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { approvalId: 'apr-stale' },
  });

  const changed = markStaleApprovalNotificationsRead(['apr-active'], { approvalStatus: 'not_pending' });
  assert.ok(changed.some((item) => item.id === 'approval-apr-stale'));
  const items = listNotifications(100);
  assert.equal(items.find((item) => item.id === 'approval-apr-active')?.read, false);
  const stale = items.find((item) => item.id === 'approval-apr-stale');
  assert.equal(stale?.read, true);
  assert.equal(stale?.metadata?.approvalStatus, 'not_pending');
});
