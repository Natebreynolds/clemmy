import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowDigest, todayDigest, todayRows } from './today.js';
import type { InboxNotification, ReminderItem } from './api.js';

const NOW = Date.parse('2026-09-26T20:00:00.000Z');
const n = (over: Partial<InboxNotification>): InboxNotification => ({
  id: 'n', kind: 'workflow', title: 'Done', body: '', createdAt: new Date(NOW - 60_000).toISOString(), read: false, needsAttention: false,
  deliveredAt: null, deliveryError: null, context: { actionItemId: null, approvalId: null, planProposalId: null, trustProposalId: null, questionId: null, sessionId: null },
  ...over,
} as InboxNotification);
const r = (over: Partial<ReminderItem>): ReminderItem => ({ id: 'r', kind: 'reminder', text: 'Standup', at: new Date(NOW + 30 * 60_000).toISOString(), recurring: false, ...over });

test('the day reads: soon calendar first, then what Clementine noticed, then what came back; open decisions stay out', () => {
  const rows = todayRows({
    nowMs: NOW,
    reminders: [r({ id: 'c1', text: 'Standup' }), r({ id: 'old', text: 'Yesterday', at: new Date(NOW - 5 * 3_600_000).toISOString() })],
    notifications: [
      n({ id: 'd1', title: 'Weekly review finished', kind: 'workflow' }),
      n({ id: 'hb1', title: 'Still waiting: morning-briefing', needsAttention: true, needsYouKey: 'heartbeat:work-review:run_waiting:morning-briefing' }),
      n({ id: 'open', title: 'Approve the send', kind: 'approval', needsAttention: true }),
      n({ id: 'u1', title: 'Clementine restarted', kind: 'system', createdAt: new Date(NOW - 2 * 3_600_000).toISOString() }),
    ],
  });
  assert.deepEqual(rows.map((x) => x.key), ['cal:c1', 'hb:hb1', 'n:d1', 'n:u1']);
  assert.equal(rows[1].eyebrow, 'Work review');
  assert.equal(rows[1].notificationId, 'hb1');
  assert.equal(rows[2].eyebrow, 'Came back');
});

test('the digest counts since you last looked and says nothing when nothing happened', () => {
  const rows = [n({ id: 'a' }), n({ id: 'b', createdAt: new Date(NOW - 26 * 3_600_000).toISOString() }), n({ id: 'h', needsAttention: true, needsYouKey: 'heartbeat:work-review:x' })];
  assert.equal(todayDigest({ notifications: rows, sinceMs: NOW - 12 * 3_600_000 }), 'Since you last looked: 1 finished · 1 thing Clementine noticed');
  assert.equal(todayDigest({ notifications: [], sinceMs: NOW - 12 * 3_600_000 }), '', 'the lead already says who needs you');
});

test('the digest shows once a day', () => {
  assert.equal(shouldShowDigest(null, NOW), true);
  assert.equal(shouldShowDigest(new Date(NOW - 60_000).toISOString(), NOW), false);
  assert.equal(shouldShowDigest(new Date(NOW - 26 * 3_600_000).toISOString(), NOW), true);
});
