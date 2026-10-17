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
import { buildFromClem, fromClemVoiceDigest, type FromClemInput } from './from-clem.js';
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

test('pulse presentation retains partial and unavailable states without claiming a clean check or hiding owner decisions', () => {
  const at = '2026-10-01T21:09:00.000Z';
  const out = buildFromClem(input({
    heartbeats: [{ id: 'calendar', title: 'Calendar watch', enabled: true,
      lastFinding: { at, summary: 'No changes in one account.' },
      presentation: { state: 'partial', lastCheck: { state: 'partial', at, readFailures: 1, successfulReads: 1 } } }],
    unavailableHeartbeats: [{ id: 'noticing', title: 'Noticing', reason: 'status_unavailable' }],
  }));
  const calendar = out.pulses.find(row => row.heartbeat === 'calendar');
  assert.equal(calendar?.presentation?.lastCheck.state, 'partial');
  assert.equal(calendar?.lastAt, at);
  assert.equal(calendar?.summary, undefined);
  assert.deepEqual(out.pulses.find(row => row.heartbeat === 'noticing'), {
    heartbeat: 'noticing', title: 'Noticing', enabled: null, availability: 'unavailable',
  });
  assert.ok(out.rows.some(row => row.key === 'noticing:p-open'), 'a failed status read does not remove its retained question');
  assert.ok(out.rows.some(row => row.key === 'plan:plan-s'), 'a failed status read does not remove a retained suggestion');
  assert.ok(out.covers.questionIds.includes('checkin:ci-1'));
  const unknown = buildFromClem(input({ heartbeats: [{ id: 'calendar', title: 'Calendar watch', enabled: true,
    lastFinding: { at: 'invalid', summary: 'Unverified retained text.' },
    presentation: { state: 'unknown', lastCheck: { state: 'unknown' } } }] }));
  assert.equal(unknown.pulses[0]?.lastAt, undefined);
  assert.equal(unknown.pulses[0]?.summary, undefined);
});

test('an answered proposal keeps only its retained handoff progress and chat, never another answer or approval action', () => {
  for (const state of ['not_started', 'needs_attention', 'dispatched'] as const) {
    const out = buildFromClem(input({ notifications: [], planProposals: [], noticingProposals: [{ id: 'controlled-handoff',
      title: 'Prepare the controlled draft', why: 'Keep its result reviewable.', action: 'Prepare a draft.', status: 'answered',
      createdAt: '2026-10-01T10:00:00.000Z', checkInId: 'controlled-answered-question', notificationId: 'controlled-carrier',
      handoff: { state, updatedAt: '2026-10-01T11:00:00.000Z', sessionId: 'exact-retained-handoff-chat', reason: 'Controlled progress.' } }],
      voiced: () => ({ message: 'Controlled progress in her words.', choices: ['Run again'] }),
    }));
    assert.equal(out.rows.length, 1);
    const row = out.rows[0]!;
    assert.equal(row.key, 'noticing:controlled-handoff');
    assert.equal(row.asks, false);
    assert.equal(row.at, '2026-10-01T11:00:00.000Z');
    assert.deepEqual(row.handoff, { state, sessionId: 'exact-retained-handoff-chat', reason: 'Controlled progress.' });
    assert.equal(row.answer, undefined);
    assert.equal(row.done, undefined);
    assert.equal(row.say, undefined, 'a handoff does not reuse proposal wording');
    assert.equal(row.choices, undefined, 'old voiced choices cannot become another run grant');
    assert.notEqual(fromClemVoiceDigest(row), fromClemVoiceDigest({ ...row, handoff: { ...row.handoff!, sessionId: 'changed-chat' } }));
    assert.notEqual(fromClemVoiceDigest(row), fromClemVoiceDigest({ ...row, handoff: { ...row.handoff!, state: 'settled' } }));
    assert.deepEqual(out.covers.questionIds, ['checkin:controlled-answered-question']);
    assert.deepEqual(out.covers.notificationIds, ['controlled-carrier']);
  }
  const settled = buildFromClem(input({ notifications: [], planProposals: [], noticingProposals: [{ id: 'settled',
    title: 'Already settled', status: 'answered', createdAt: '2026-10-01T10:00:00.000Z',
    handoff: { state: 'settled', updatedAt: '2026-10-01T11:00:00.000Z' } }] }));
  assert.deepEqual(settled.rows, []);
});

test('a report a workflow run sent the owner is hers to say as written, with its run, while it is news', () => {
  const now = Date.parse('2026-10-09T15:00:00.000Z');
  const report = (id: string, extra: Partial<NotificationRecord> = {}, meta: Record<string, unknown> = {}) => notification(id,
    { source: 'notify_user_tool', workflowRunId: `run-${id}`, workflow: 'morning-trends', ...meta },
    { kind: 'workflow', title: `Trends ${id}`, body: `Five things moved.\n- one\n- two`, createdAt: '2026-10-09T14:31:00.000Z', ...extra });
  const stream = buildFromClem(input({
    now,
    notifications: [
      report('fresh'),
      report('to-its-chat', { silent: true }),
      report('seen', { read: true }),
      report('stale', { createdAt: '2026-10-05T14:31:00.000Z' }),
    ],
    voiced: () => ({ message: 'reworded by a model' }),
  }));
  const rows = stream.rows.filter((row) => row.heartbeat === 'workflow');
  assert.deepEqual(rows.map((row) => row.key), ['notif:fresh']);
  const [row] = rows;
  assert.equal(row!.heartbeatTitle, 'morning-trends');
  assert.equal(row!.text, 'Trends fresh');
  assert.equal(row!.say, 'Five things moved.\n- one\n- two', 'her report as written, never reworded');
  assert.equal(row!.authored, true);
  assert.equal(row!.asks, false);
  assert.deepEqual(row!.run, { runId: 'run-fresh', workflow: 'morning-trends' });
  assert.deepEqual(row!.done, { notificationId: 'fresh' });
  assert.ok(stream.covers.notificationIds.includes('fresh'));
  assert.ok(!stream.covers.notificationIds.includes('stale'), 'an old report stays in the inbox');
});

test('a brain-outage question answers yes or no through its own route, never through her wording', () => {
  const outageAsk = notification('brain-outage-bo1-back', {
    heartbeatId: 'brain-health', sourceTitle: 'Your brain', itemKey: 'bo1:back', brainOutageId: 'bo1', needsAttention: true,
  }, { kind: 'system', title: 'Chosen model is answering again' });
  const outageTell = notification('brain-outage-bo1-switched', {
    heartbeatId: 'brain-health', sourceTitle: 'Your brain', itemKey: 'bo1:switched', brainOutageId: 'bo1', inboxOnly: true,
  }, { kind: 'system', title: 'Chosen model stopped answering' });
  const out = buildFromClem(input({
    notifications: [outageAsk, outageTell],
    asksOwner: (n) => n.metadata?.needsAttention === true,
    voiced: () => ({ message: 'It is answering again. Switch back?', choices: ['Switch back', 'Keep the backup'] }),
  }));
  const ask = out.rows.find((row) => row.key === 'notif:brain-outage-bo1-back')!;
  assert.deepEqual(ask.answer, { kind: 'brain_outage', outageId: 'bo1' });
  assert.equal(ask.choices, undefined, 'the yes/no is the host\'s, so her wording cannot pick an outcome');
  assert.equal(ask.say, 'It is answering again. Switch back?');
  assert.equal(ask.heartbeatTitle, 'Your brain', 'a source outside the heartbeat list names itself');
  const tell = out.rows.find((row) => row.key === 'notif:brain-outage-bo1-switched')!;
  assert.equal(tell.asks, false);
  assert.equal(tell.answer, undefined, 'telling asks nothing');
});
