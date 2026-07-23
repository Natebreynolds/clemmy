/**
 * Run with: npx tsx --test apps/desktop/src/desktop-toast-queue.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  DESKTOP_TOAST_BURST_CAP,
  type DesktopPendingNotification,
  advanceWatermark,
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
      { id: 'a', title: 'Hi', body: 'there', createdAt: '2026-07-22T09:59:00.000Z', kind: 'approval' },
      { id: '   ', title: 'blank id dropped' },
      { title: 'missing id dropped' },
      'not an object',
      { id: 'b' },
    ],
  });
  assert.equal(parsed.now, '2026-07-22T10:00:00.000Z');
  assert.deepEqual(parsed.items.map((i) => i.id), ['a', 'b']);
  assert.equal(parsed.items[0].kind, 'approval');
  // Defaults fill in when fields are absent.
  assert.equal(parsed.items[1].title, 'Clementine');
  assert.equal(parsed.items[1].body, '');
});

test('parseDesktopPendingResponse tolerates junk payloads', () => {
  assert.deepEqual(parseDesktopPendingResponse(null), { items: [], now: undefined });
  assert.deepEqual(parseDesktopPendingResponse('nope'), { items: [], now: undefined });
  assert.deepEqual(parseDesktopPendingResponse({ items: 'no' }).items, []);
  // A malformed `now` is dropped to undefined so the watermark holds.
  assert.equal(parseDesktopPendingResponse({ now: 'bad', items: [] }).now, undefined);
});
