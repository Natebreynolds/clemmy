/**
 * Run: node scripts/run-tests-isolated.mjs src/dashboard/from-clem.test.ts
 *
 * From Clem is one stream of what the heartbeats brought the owner, read from
 * their own records: an open Noticing proposal answered in words, an unread
 * heartbeat finding marked done, a workflow suggestion answered yes or no.
 * Everything else stays where it is, and what the stream shows is named so
 * Home's other lists leave it out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFromClem, type FromClemInput } from './from-clem.js';
import type { NotificationRecord } from '../runtime/notifications.js';

const notification = (id: string, metadata: Record<string, unknown>, extra: Partial<NotificationRecord> = {}): NotificationRecord => ({
  id, kind: 'execution', title: `title ${id}`, body: `body ${id}`, createdAt: '2026-10-01T18:00:00.000Z', read: false, metadata, ...extra,
});

const input = (over: Partial<FromClemInput> = {}): FromClemInput => ({
  heartbeats: [
    { id: 'noticing', title: 'Noticing', enabled: true, lastFinding: { at: '2026-10-01T19:26:00.000Z', summary: 'Quiet: considered 7 things' } },
    { id: 'calendar', title: 'Calendar watch', enabled: true, lastFinding: { at: '2026-10-01T21:09:00.000Z', summary: '1 change' } },
    { id: 'work-review', title: 'Work review', enabled: true },
    { id: 'workflow-suggestions', title: 'Workflow suggestions', enabled: false, lastFinding: { at: '2026-10-01T15:58:00.000Z', summary: '3 repeats' } },
  ],
  noticingProposals: [
    { id: 'p-open', title: 'Settle the panel goal', why: 'It is blocked on a decision.', action: 'Close it', status: 'open', createdAt: '2026-10-01T17:00:00.000Z', checkInId: 'ci-1', notificationId: 'carrier-1' },
    { id: 'p-done', title: 'Old', status: 'answered', createdAt: '2026-09-30T17:00:00.000Z', checkInId: 'ci-0' },
  ],
  notifications: [
    notification('cal-1', { watch: 'calendar', itemKey: 'k1', changeKind: 'cancelled' }, { createdAt: '2026-10-01T21:09:00.000Z' }),
    notification('cal-ask', { watch: 'calendar', itemKey: 'k2', changeKind: 'invite_unanswered' }, { createdAt: '2026-10-01T16:00:00.000Z' }),
    notification('wr-1', { heartbeatId: 'work-review', itemKey: 'k3' }),
    notification('cal-read', { watch: 'calendar', itemKey: 'k4' }, { read: true }),
    notification('plain', { workflowRunId: 'r1' }),
  ],
  planProposals: [
    { id: 'plan-s', proposedAt: '2026-10-01T15:58:00.000Z', proposedByAgent: 'workflow-suggestions', status: 'pending', title: 'Save this as a workflow', context: 'You asked three times.' },
    { id: 'plan-chat', proposedAt: '2026-10-01T15:00:00.000Z', proposedByAgent: 'clementine', status: 'pending', title: 'A chat plan' },
  ],
  asksOwner: (n) => n.metadata?.changeKind === 'invite_unanswered',
  ...over,
});

test('one stream of what the heartbeats said, what waits on the owner first, each with its own way to answer', () => {
  const out = buildFromClem(input());
  assert.deepEqual(out.rows.map((row) => row.key), [
    'noticing:p-open', 'notif:cal-ask', 'plan:plan-s', 'notif:cal-1', 'notif:wr-1',
  ]);
  assert.deepEqual(out.rows.map((row) => row.asks), [true, true, true, false, false]);
  const proposal = out.rows.find((row) => row.key === 'noticing:p-open')!;
  assert.equal(proposal.asks, true);
  assert.equal(proposal.text, 'Settle the panel goal');
  assert.equal(proposal.detail, 'It is blocked on a decision.\nWhat I would do: Close it');
  assert.deepEqual(proposal.answer, { kind: 'words', questionId: 'checkin:ci-1' });
  const suggestion = out.rows.find((row) => row.key === 'plan:plan-s')!;
  assert.deepEqual(suggestion.answer, { kind: 'yes_no', planProposalId: 'plan-s' });
  assert.equal(suggestion.heartbeatTitle, 'Workflow suggestions');
  const finding = out.rows.find((row) => row.key === 'notif:cal-1')!;
  assert.equal(finding.asks, false);
  assert.deepEqual(finding.done, { notificationId: 'cal-1' });
  assert.equal(finding.heartbeatTitle, 'Calendar watch');
});

test('what the stream shows is named, so Home leaves it out of Needs you and While away', () => {
  const out = buildFromClem(input());
  assert.deepEqual(out.covers.questionIds, ['checkin:ci-1']);
  assert.deepEqual(out.covers.planProposalIds, ['plan-s']);
  assert.deepEqual(out.covers.notificationIds.sort(), ['cal-1', 'cal-ask', 'carrier-1', 'wr-1']);
});

test('a quiet Clem still says when each heartbeat last looked', () => {
  const out = buildFromClem(input({ noticingProposals: [], notifications: [], planProposals: [] }));
  assert.deepEqual(out.rows, []);
  assert.deepEqual(out.pulses.find((pulse) => pulse.heartbeat === 'noticing'),
    { heartbeat: 'noticing', title: 'Noticing', enabled: true, lastAt: '2026-10-01T19:26:00.000Z', summary: 'Quiet: considered 7 things' });
  assert.equal(out.pulses.find((pulse) => pulse.heartbeat === 'work-review')?.lastAt, undefined);
});

test('a check that failed says when it looked, never what went wrong', () => {
  // Live 10-02: another owner's home page showed "Read failed: calendar read
  // not learned…" as Clem's latest word. The reason belongs to the
  // heartbeat's own page; Home shows only that it looked.
  const out = buildFromClem(input({
    noticingProposals: [], notifications: [], planProposals: [],
    heartbeats: [
      { id: 'calendar', title: 'Calendar watch', enabled: true, lastFinding: { at: '2026-10-01T21:09:00.000Z', summary: 'Read failed: calendar read not learned for gmail: the model did not answer for it', failed: true } },
      { id: 'noticing', title: 'Noticing', enabled: true, lastFinding: { at: '2026-10-01T19:26:00.000Z', summary: 'Quiet: considered 7 things', failed: false } },
    ],
  }));
  assert.deepEqual(out.pulses.find((pulse) => pulse.heartbeat === 'calendar'),
    { heartbeat: 'calendar', title: 'Calendar watch', enabled: true, lastAt: '2026-10-01T21:09:00.000Z' });
  assert.equal(out.pulses.find((pulse) => pulse.heartbeat === 'noticing')?.summary, 'Quiet: considered 7 things');
  assert.ok(!JSON.stringify(out).includes('Read failed'), 'no failure text anywhere in the stream');
});
