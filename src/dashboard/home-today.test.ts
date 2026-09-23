import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectHomeToday } from './home-today.js';
import type { CalEvent } from '../agents/calendar-watch.js';

const NOW = Date.parse('2026-09-23T15:00:00.000Z');
const ev = (id: string, subject: string, startH: number, extra: Partial<CalEvent> = {}): CalEvent => ({
  id, subject, startMs: NOW + startH * 3_600_000, endMs: NOW + (startH + 1) * 3_600_000,
  isAllDay: false, isCancelled: false, showAs: 'busy', myResponse: 'accepted', attendeeCount: 3, ...extra,
});

test('Today is the watch\'s last read, in time order, without what is over, cancelled or declined', () => {
  const today = projectHomeToday({
    state: {
      snapshotAt: '2026-09-23T14:50:00.000Z',
      snapshot: {
        work: {
          a: ev('a', 'Pipeline review', 2),
          b: ev('b', 'Standup', -3),
          c: ev('c', 'Cancelled sync', 1, { isCancelled: true }),
          d: ev('d', 'Declined lunch', 3, { myResponse: 'declined' }),
          e: ev('e', 'Proposal meeting', 1, { myResponse: 'notResponded' }),
        },
      },
    },
    connectedOperations: ['op-1'],
    nextTickAt: '2026-09-23T15:15:00.000Z',
    nowMs: NOW,
  });
  assert.deepEqual(today.events.map((e) => e.title), ['Proposal meeting', 'Pipeline review']);
  assert.equal(today.events[0]!.needsReply, true, 'the watch\'s own unanswered-invite rule');
  assert.equal(today.events[1]!.needsReply, false);
  assert.equal(today.asOf, '2026-09-23T14:50:00.000Z');
  assert.equal(today.nextCheckAt, '2026-09-23T15:15:00.000Z');
  assert.equal(today.connected, true);
});

test('one meeting on two calendars, or one mailbox connected twice, is one row', () => {
  const today = projectHomeToday({
    state: { snapshot: { a: { x: ev('x', 'Board sync', 2) }, b: { x: ev('x', 'Board sync', 2), y: ev('y', 'Board sync', 2) } } },
    connectedOperations: [],
    nowMs: NOW,
  });
  assert.equal(today.events.length, 1);
});

test('no calendar connected and never read says so, and a failed read keeps the read before it', () => {
  const none = projectHomeToday({ state: { snapshot: {} }, connectedOperations: [], nowMs: NOW });
  assert.equal(none.connected, false);
  assert.equal(none.asOf, null);
  const failed = projectHomeToday({
    state: { snapshot: { w: { a: ev('a', 'Kept from the last good read', 2) } }, snapshotAt: '2026-09-23T12:00:00.000Z', lastError: { at: '2026-09-23T14:55:00.000Z', reason: 'token expired' } },
    connectedOperations: ['op'],
    nowMs: NOW,
  });
  assert.equal(failed.lastError, 'token expired');
  assert.equal(failed.events.length, 1);
});
