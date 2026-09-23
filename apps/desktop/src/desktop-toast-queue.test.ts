/**
 * Run with: npx tsx --test apps/desktop/src/desktop-toast-queue.test.ts
 */

import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { strict as assert } from 'node:assert';

import {
  DESKTOP_TOAST_BURST_CAP,
  DesktopNotificationRetention,
  type DesktopPendingNotification,
  advanceWatermark,
  desktopNotificationRoute,
  openDesktopNotification,
  parseDesktopPendingResponse,
  planDesktopToasts,
} from './desktop-toast-queue.js';

function item(id: string, over: Partial<DesktopPendingNotification> = {}): DesktopPendingNotification {
  return {
    id,
    title: `title ${id}`,
    body: `body ${id}`,
    createdAt: '2026-07-22T10:00:00.000Z',
    ...over,
  };
}

test('planDesktopToasts shows every item when under the burst cap', () => {
  const plan = planDesktopToasts([item('a'), item('b')], new Set());
  assert.deepEqual(plan.toasts.map((t) => t.id), ['a', 'b']);
  assert.equal(plan.summary, null);
  assert.deepEqual(plan.seenIds, ['a', 'b']);
});

test('planDesktopToasts caps toasts and collapses the remainder into a summary', () => {
  const plan = planDesktopToasts(
    [item('a'), item('b'), item('c'), item('d'), item('e')],
    new Set(),
  );
  assert.equal(plan.toasts.length, DESKTOP_TOAST_BURST_CAP);
  assert.deepEqual(plan.toasts.map((t) => t.id), ['a', 'b', 'c']);
  assert.deepEqual(plan.summary, { count: 2 });
  // Every surfaced id (shown + summarized) is reported so the belt-set
  // suppresses them next cycle even if the read-mark lagged.
  assert.deepEqual(plan.seenIds, ['a', 'b', 'c', 'd', 'e']);
});

test('planDesktopToasts drops ids already surfaced', () => {
  const plan = planDesktopToasts([item('a'), item('b'), item('c')], new Set(['a', 'c']));
  assert.deepEqual(plan.toasts.map((t) => t.id), ['b']);
  assert.equal(plan.summary, null);
  assert.deepEqual(plan.seenIds, ['b']);
});

test('planDesktopToasts dedupes repeated ids within a single batch', () => {
  const plan = planDesktopToasts([item('a'), item('a'), item('b')], new Set());
  assert.deepEqual(plan.toasts.map((t) => t.id), ['a', 'b']);
  assert.deepEqual(plan.seenIds, ['a', 'b']);
});

test('planDesktopToasts skips items with a blank id', () => {
  const plan = planDesktopToasts([item(''), item('  '), item('b')], new Set());
  assert.deepEqual(plan.toasts.map((t) => t.id), ['b']);
});

test('advanceWatermark prefers the server clock and never moves backwards', () => {
  const start = '2026-07-22T10:00:00.000Z';
  assert.equal(advanceWatermark(start, '2026-07-22T10:05:00.000Z'), '2026-07-22T10:05:00.000Z');
  // Skewed / stale server clock earlier than current: keep current.
  assert.equal(advanceWatermark(start, '2026-07-22T09:00:00.000Z'), start);
  // Missing or malformed `now`: keep current, don't replay the backlog.
  assert.equal(advanceWatermark(start, undefined), start);
  assert.equal(advanceWatermark(start, 'not-a-date'), start);
  // Equal timestamp is a valid (idempotent) advance.
  assert.equal(advanceWatermark(start, start), start);
});

test('parseDesktopPendingResponse normalizes rows and drops malformed ones', () => {
  const parsed = parseDesktopPendingResponse({
    now: '2026-07-22T10:00:00.000Z',
    items: [
      {
        id: 'a', title: 'Hi', body: 'there', createdAt: '2026-07-22T09:59:00.000Z', kind: 'approval',
        href: '/inbox?tab=needs&select=approval-a', markReadOnOpen: false,
      },
      { id: '   ', title: 'blank id dropped' },
      { title: 'missing id dropped' },
      'not an object',
      { id: 'b' },
    ],
  });
  assert.equal(parsed.now, '2026-07-22T10:00:00.000Z');
  assert.deepEqual(parsed.items.map((i) => i.id), ['a', 'b']);
  assert.equal(parsed.items[0].kind, 'approval');
  assert.equal(parsed.items[0].href, '/inbox?tab=needs&select=approval-a');
  assert.equal(parsed.items[0].markReadOnOpen, false);
  // Defaults fill in when fields are absent.
  assert.equal(parsed.items[1].title, 'Clementine');
  assert.equal(parsed.items[1].body, '');
  assert.equal(parsed.items[1].markReadOnOpen, true);
});

test('desktop toast navigation accepts only the first-party Inbox route', () => {
  const parsed = parseDesktopPendingResponse({
    items: [
      { id: 'safe', href: '/inbox?tab=needs&select=gate' },
      { id: 'external', href: 'https://evil.example/inbox' },
      { id: 'protocol-relative', href: '//evil.example/inbox' },
      { id: 'other-local', href: '/settings' },
    ],
  });
  assert.equal(parsed.items.find((row) => row.id === 'safe')?.href, '/inbox?tab=needs&select=gate');
  assert.equal(parsed.items.find((row) => row.id === 'external')?.href, undefined);
  assert.equal(parsed.items.find((row) => row.id === 'protocol-relative')?.href, undefined);
  assert.equal(parsed.items.find((row) => row.id === 'other-local')?.href, undefined);
});

test('parseDesktopPendingResponse tolerates junk payloads', () => {
  assert.deepEqual(parseDesktopPendingResponse(null), { items: [], now: undefined });
  assert.deepEqual(parseDesktopPendingResponse('nope'), { items: [], now: undefined });
  assert.deepEqual(parseDesktopPendingResponse({ items: 'no' }).items, []);
  // A malformed `now` is dropped to undefined so the watermark holds.
  assert.equal(parseDesktopPendingResponse({ now: 'bad', items: [] }).now, undefined);
});


test('desktop notification maps the Inbox mount and preserves exact selection', () => {
  assert.equal(desktopNotificationRoute('/inbox?tab=notifications&select=a%2Fb#detail'),
    '/console/inbox?tab=notifications&select=a%2Fb#detail');
  for (const bad of [undefined, '/settings', '//evil.example/inbox', 'https://evil.example/inbox', 'javascript:alert(1)']) {
    assert.equal(desktopNotificationRoute(bad), undefined);
  }
});

test('desktop notification acknowledges only after confirmed navigation', async () => {
  const calls: string[] = [];
  let finish!: (ok: boolean) => void;
  const opened = openDesktopNotification(item('notice', { href: '/inbox?select=notice' }),
    async (route) => { calls.push(route); return new Promise<boolean>((resolve) => { finish = resolve; }); },
    async (id) => { calls.push(`read:${id}`); });
  assert.deepEqual(calls, ['/console/inbox?select=notice']);
  finish(true);
  await opened;
  assert.deepEqual(calls, ['/console/inbox?select=notice', 'read:notice']);
});

test('failed or rejected navigation and actionable notices remain unread', async () => {
  let reads = 0;
  const read = async () => { reads++; };
  const notice = item('notice', { href: '/inbox?select=notice' });
  await openDesktopNotification(notice, async () => false, read);
  await assert.rejects(openDesktopNotification(notice, async () => { throw new Error('renderer gone'); }, read));
  await openDesktopNotification({ ...notice, markReadOnOpen: false }, async () => true, read);
  await openDesktopNotification({ ...notice, href: 'https://evil.example/inbox' }, async () => { throw new Error('must not navigate'); }, read);
  assert.equal(reads, 0);
});


class FakeNativeNotice extends EventEmitter {
  closeCalls = 0;
  close(): void { this.closeCalls++; this.emit('close'); }
}

test('native notices and click handlers remain owned after show until interaction', () => {
  const retained = new DesktopNotificationRetention<FakeNativeNotice>(3);
  const notice = new FakeNativeNotice(); let clicked = 0;
  retained.retain(notice); notice.on('click', () => { clicked++; });
  notice.emit('show');
  assert.equal(retained.has(notice), true);
  assert.equal(retained.size, 1);
  notice.emit('click');
  assert.equal(clicked, 1); assert.equal(retained.size, 0);
});

test('native failure and dismissal release ownership without consuming other notices', () => {
  const retained = new DesktopNotificationRetention<FakeNativeNotice>(3);
  const failed = new FakeNativeNotice(), closed = new FakeNativeNotice(), pending = new FakeNativeNotice();
  for (const notice of [failed, closed, pending]) retained.retain(notice);
  failed.emit('failed', {}, 'delivery refused'); closed.emit('close');
  assert.equal(retained.size, 1); assert.equal(retained.has(pending), true);
  assert.equal(pending.closeCalls, 0);
});

test('notification retention bounds memory, explicitly closes oldest, and deduplicates ownership', () => {
  const retained = new DesktopNotificationRetention<FakeNativeNotice>(2);
  const a = new FakeNativeNotice(), b = new FakeNativeNotice(), c = new FakeNativeNotice();
  retained.retain(a); retained.retain(a); retained.retain(b); retained.retain(c);
  assert.equal(retained.size, 2); assert.equal(a.closeCalls, 1);
  assert.equal(retained.has(b), true); assert.equal(retained.has(c), true);
  assert.throws(() => new DesktopNotificationRetention(0), RangeError);
});


test('banner timeout keeps the Action Center click handler alive', () => {
  const retained = new DesktopNotificationRetention<FakeNativeNotice>(2);
  const notice = new FakeNativeNotice();
  retained.retain(notice);
  notice.emit('close', { reason: 'timedOut' });
  assert.equal(retained.has(notice), true);
  notice.emit('close', { reason: 'userCanceled' });
  assert.equal(retained.size, 0);
});
