/**
 * Run: node scripts/run-tests-isolated.mjs src/dashboard/from-clem-runtime.test.ts
 *
 * Clem says each From Clem item in her own words, written once by the brain
 * and kept against what the item says, and the owner can reply to any item in
 * theirs: the reply is read into a decision and settled through the path that
 * already exists for that kind of item.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { PlanProposal } from '../agents/plan-proposals.js';
import type { FromClemSetup } from './from-clem-setup.js';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-from-clem-runtime-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const { buildFromClem } = await import('./from-clem.js');
const { voiceFromClemRows, replyToFromClem } = await import('./from-clem-runtime.js');
const { modelUsageAttributionStorage } = await import('../runtime/usage-log.js');
type FromClemReplyDeps = Parameters<typeof replyToFromClem>[2];

const stream = (voiced?: (key: string, digest: string) => { message: string; choices?: string[] } | undefined, readIds: ReadonlySet<string> = new Set()) => buildFromClem({
  heartbeats: [
    { id: 'calendar', title: 'Calendar watch', enabled: true },
    { id: 'work-review', title: 'Work review', enabled: true },
    { id: 'noticing', title: 'Noticing', enabled: true },
    { id: 'workflow-suggestions', title: 'Workflow suggestions', enabled: true },
  ],
  noticingProposals: [{ id: 'p1', title: 'Settle the panel goal', status: 'open', createdAt: '2026-10-01T10:00:00.000Z', checkInId: 'ci1' }],
  notifications: [
    { id: 'cal', kind: 'execution', title: 'Cancelled: Interview', body: 'Was 4:00 PM.', createdAt: '2026-10-01T12:00:00.000Z', read: false, metadata: { watch: 'calendar', itemKey: 'k1' } },
    { id: 'wr', kind: 'execution', title: 'Still waiting on you: standup', body: 'Waiting since yesterday.', createdAt: '2026-10-01T11:00:00.000Z', read: false, metadata: { heartbeatId: 'work-review', itemKey: 'k2' } },
  ].map((n) => ({ ...n, read: readIds.has(n.id) })),
  planProposals: [{ id: 'plan1', proposedAt: '2026-10-01T09:00:00.000Z', proposedByAgent: 'workflow-suggestions', status: 'pending', title: 'Save this as a workflow' }],
  asksOwner: (n) => n.id === 'wr',
  ...(voiced ? { voiced } : {}),
});

test('she writes each item once, a few per pass, again when it changes, and forgets what is gone', async () => {
  const calls: string[] = [];
  const port = () => ({
    async voiceProactiveItem(call: { item: { title: string; at: string }; now: string; evidenceDigest: string }) {
      calls.push(call.item.title);
      assert.ok(call.item.at && call.now, 'she is told when it happened and what time it is now');
      return { message: `I saw: ${call.item.title}`, evidenceDigest: call.evidenceDigest, modelIdentity: 'fixture-brain' };
    },
  });
  const rows = stream().rows;
  assert.equal(await voiceFromClemRows(rows, { port: port as never, max: 2, thread: null }), 2);
  assert.equal(await voiceFromClemRows(rows, { port: port as never, max: 2, thread: null }), 2);
  assert.equal(await voiceFromClemRows(rows, { port: port as never, max: 2, thread: null }), 0, 'nothing left to say');
  assert.equal(calls.length, 4);

  // The stream now carries her words; the record's own words stay as facts.
  const fs = await import('node:fs');
  const kept = JSON.parse(fs.readFileSync(path.join(TMP, 'state', 'from-clem-voice.json'), 'utf8')) as { entries: Record<string, { digest: string; message: string }> };
  const voicedStream = stream((key, digest) => (kept.entries[key]?.digest === digest ? { message: kept.entries[key]!.message } : undefined));
  const calendar = voicedStream.rows.find((row) => row.key === 'notif:cal')!;
  assert.equal(calendar.say, 'I saw: Cancelled: Interview');
  assert.equal(calendar.text, 'Cancelled: Interview');

  // A changed item is said again; a gone one is forgotten.
  const changed = rows.map((row) => (row.key === 'notif:cal' ? { ...row, voiceDigest: 'changed' } : row)).filter((row) => row.key !== 'notif:wr');
  assert.equal(await voiceFromClemRows(changed, { port: port as never, thread: null }), 1);
  const after = JSON.parse(fs.readFileSync(path.join(TMP, 'state', 'from-clem-voice.json'), 'utf8')) as { entries: Record<string, unknown> };
  assert.equal(after.entries['notif:wr'], undefined);

  // No model: nothing is written and the items keep their own words.
  assert.equal(await voiceFromClemRows(rows, { port: () => null, thread: null }), 0);
});

test('what she writes lands in her own thread once, oldest first, and the thread knows what she raised', async () => {
  const fs = await import('node:fs');
  fs.rmSync(path.join(TMP, 'state', 'from-clem-voice.json'), { force: true });
  const posts: Array<{ key: string; text: string }> = [];
  const primers: string[] = [];
  let ensured = 0;
  const thread = {
    ensure: () => { ensured += 1; },
    postedKeys: () => new Set<string>(),
    post: (m: { key: string; text: string }) => { posts.push(m); },
    primer: (t: string) => { primers.push(t); return true; },
  };
  const port = () => ({
    async voiceProactiveItem(call: { item: { title: string }; evidenceDigest: string }) {
      return { message: `Clem: ${call.item.title}`, evidenceDigest: call.evidenceDigest, modelIdentity: 'fixture-brain' };
    },
  });
  const rows = stream().rows;
  await voiceFromClemRows(rows, { port: port as never, max: 10, thread });
  assert.deepEqual(posts.map((post) => post.key), ['plan:plan1', 'noticing:p1', 'notif:wr', 'notif:cal'], 'oldest first');
  assert.ok(ensured >= 1);
  assert.match(primers.at(-1)!, /^\[clem-raised\] What I \(Clem\) raised/);
  assert.match(primers.at(-1)!, /Calendar watch: Clem: Cancelled: Interview/);
  // Nothing new: nothing posted again.
  await voiceFromClemRows(rows, { port: port as never, max: 10, thread });
  assert.equal(posts.length, 4);
});

test('saying an item again in new words does not post it to her thread again; a changed item does', async () => {
  const fs = await import('node:fs');
  const { fromClemVoiceDigest } = await import('./from-clem.js');
  const file = path.join(TMP, 'state', 'from-clem-voice.json');
  const rows = stream().rows;
  const cal = rows.find((row) => row.key === 'notif:cal')!;
  // Written and posted under the previous rubric's words.
  const earlier = fromClemVoiceDigest(cal, 2);
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: {
    'notif:cal': { digest: earlier, message: 'Old words', model: 'fixture-brain', at: '2026-10-01T12:01:00.000Z', posted: earlier },
  } }));
  const posts: string[] = [];
  const thread = { ensure: () => {}, postedKeys: () => new Set<string>(), post: (m: { key: string }) => { posts.push(m.key); }, primer: () => true };
  const port = () => ({
    async voiceProactiveItem(call: { item: { title: string; waitingOnOwner: boolean }; evidenceDigest: string }) {
      return { message: `New words: ${call.item.title}`, ...(call.item.waitingOnOwner ? { choices: ['Do it', 'Drop it'] } : {}),
        evidenceDigest: call.evidenceDigest, modelIdentity: 'fixture-brain' };
    },
  });
  await voiceFromClemRows(rows, { port: port as never, max: 10, thread });
  assert.ok(!posts.includes('notif:cal'), 'the calendar item was already in her thread');
  const kept = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Record<string, { message: string; choices?: string[] }> };
  assert.equal(kept.entries['notif:cal']!.message, 'New words: Cancelled: Interview');
  assert.deepEqual(kept.entries['notif:wr']!.choices, ['Do it', 'Drop it'], 'an item waiting on the owner keeps her answers');
  // The stream offers her answers only where the owner is asked.
  const voicedStream = stream((key) => (kept.entries[key] ? { message: kept.entries[key]!.message, ...(kept.entries[key]!.choices ? { choices: kept.entries[key]!.choices } : {}) } : undefined));
  assert.equal(voicedStream.rows.find((row) => row.key === 'notif:wr')?.choices?.length, 2);
  assert.equal(voicedStream.rows.find((row) => row.key === 'notif:cal')?.choices, undefined);
  // A changed item is news again.
  const changed = rows.map((row) => (row.key === 'notif:cal' ? { ...row, at: '2026-10-02T09:00:00.000Z', voiceDigest: fromClemVoiceDigest({ ...row, at: '2026-10-02T09:00:00.000Z' }) } : row));
  await voiceFromClemRows(changed, { port: port as never, max: 10, thread });
  assert.ok(posts.includes('notif:cal'));
});

function deps(over: Partial<FromClemReplyDeps> = {}, decision: { decision: string; instruction?: string } = { decision: 'done' }) {
  const log: string[] = [];
  const all: FromClemReplyDeps = {
    read: async () => stream((key) => (key === 'notif:cal' ? { message: 'Your 4:00 interview was cancelled; that hour is free.' } : undefined)),
    port: () => ({
      async readClemReply(call) {
        log.push(`read:${call.said}|${call.reply}`);
        return { ...decision, evidenceDigest: call.evidenceDigest, modelIdentity: 'fixture-brain' } as never;
      },
    }),
    answerQuestion: (id, text) => { log.push(`answer:${id}:${text}`); return true; },
    markRead: (id) => { log.push(`read-notif:${id}`); },
    addRule: (heartbeat, text) => { log.push(`rule:${heartbeat}:${text}`); },
    approvePlan: (id) => { log.push(`approve:${id}`); return true; },
    rejectPlan: (id, reason) => { log.push(`reject:${id}:${reason}`); return true; },
    snoozePlan: (id) => { log.push(`snooze:${id}`); },
    later: (key) => { log.push(`later:${key}`); },
    startTurn: (input) => { log.push(`turn:${input.displayMessage}:${input.message}`); return { sessionId: 'sess-1', runId: 'from-clem:fixture' }; },
    ...over,
  };
  return { all, log };
}

test('a Noticing reply is the check-in answer; the brain is not asked twice', async () => {
  const { all, log } = deps();
  assert.deepEqual(await replyToFromClem('noticing:p1', 'do it', all), { outcome: 'answered', questionId: 'checkin:ci1' });
  assert.deepEqual(log, ['answer:checkin:ci1:do it']);
});

test('typed clear and later controls on a words question never become an answer or resume', async () => {
  for (const decision of ['done', 'not_now', 'never'] as const) {
    const actions: string[] = [];
    const { all, log } = deps({ presentQuestion: (id, action) => { actions.push(`${id}:${action}`); return true; } });
    const result = await replyToFromClem('noticing:p1', 'Done', all, { decision });
    assert.equal(result.outcome, decision === 'not_now' ? 'later' : 'cleared');
    assert.deepEqual(log, []);
    assert.deepEqual(actions, [`checkin:ci1:${decision === 'not_now' ? 'defer' : 'dismiss'}`]);
  }
});

test('acknowledging one grouped review clears all represented notices and never starts work', async () => {
  const row = { ...stream().rows.find((item) => item.key === 'notif:wr')!,
    key: 'review:flow:controlled', relatedNotificationIds: ['new-notice', 'old-notice'] };
  const { all, log } = deps({ read: async () => ({ ...stream(), rows: [row] }) });
  const result = await replyToFromClem(row.key, 'Dismiss', all, { decision: 'done' });
  assert.equal(result.outcome, 'cleared');
  assert.deepEqual(log, ['read-notif:new-notice', 'read-notif:old-notice']);
});

test('generic attention replies use the canonical exact preference and never acknowledge or change source work', async () => {
  const row = { ...stream().rows.find((item) => item.key === 'notif:wr')!, attentionKey: 'flow:FRAMEWORK-TEST-reply',
    lifecycle: { canDismiss: true as const, canDefer: true as const, effect: 'hide_only' as const,
      dismissLabel: 'Dismiss' as const, deferLabel: 'Tomorrow' as const, generation: 'a'.repeat(64) } };
  for (const decision of ['done', 'not_now', 'never', 'do_it'] as const) {
    const actions: string[] = [];
    const { all, log } = deps({ read: async () => ({ ...stream(), rows: [row] }),
      presentAttention: (key, action, generation) => { actions.push(`${key}:${action}:${generation}`); return true; } });
    const result = await replyToFromClem(row.key, 'Controlled owner preference', all, { decision, seenDigest: row.voiceDigest });
    if (decision === 'do_it') {
      assert.equal(result.outcome, 'started');
      assert.deepEqual(actions, []);
    } else {
      assert.equal(result.outcome, decision === 'not_now' ? 'later' : decision === 'never' ? 'rule_added' : 'cleared');
      assert.deepEqual(actions, [`${row.attentionKey}:${decision === 'not_now' ? 'defer' : 'dismiss'}:${row.lifecycle.generation}`]);
    }
    assert.equal(log.some(line => /^(read-notif|later|approve|reject|snooze|answer):/.test(line)), false);
  }
  const missing = deps({ read: async () => ({ ...stream(), rows: [row] }) });
  assert.equal((await replyToFromClem(row.key, 'Done', missing.all, { decision: 'done' })).outcome, 'unclear');
  assert.deepEqual(missing.log, [], 'a missing preference writer cannot fall back to acknowledging source notifications');
  const stale = deps({ read: async () => ({ ...stream(), rows: [row] }), presentAttention: () => false });
  assert.equal((await replyToFromClem(row.key, 'Done', stale.all, { decision: 'done' })).outcome, 'changed');
  assert.deepEqual(stale.log, []);
});

test('different failures on one workflow retain separate acknowledgement authority', async () => {
  const notifications = [
    { id: 'credit-a', body: '402 Credit limit exceeded.' },
    { id: 'credit-b', body: '402 Credit limit exceeded.' },
    { id: 'permission', body: 'Permission denied for the requested source.' },
  ].map((item) => ({ ...item, kind: 'execution' as const, title: 'Controlled workflow failed',
    createdAt: '2026-10-01T12:00:00.000Z', read: false,
    metadata: { heartbeatId: 'work-review', changeKind: 'run_failed', itemKey: `run_failed:${item.id}` } }));
  const grouped = buildFromClem({ heartbeats: [], noticingProposals: [], planProposals: [], notifications,
    asksOwner: () => true, attentionKey: () => 'flow:controlled-failures' });
  assert.equal(grouped.rows.length, 2);
  const credit = grouped.rows.find((row) => row.blocker?.kind === 'provider_credit')!;
  const permission = grouped.rows.find((row) => !row.blocker)!;
  assert.deepEqual(credit.relatedNotificationIds, ['credit-a', 'credit-b']);
  assert.deepEqual(permission.relatedNotificationIds, ['permission']);
  const { all, log } = deps({ read: async () => grouped });
  assert.equal((await replyToFromClem(credit.key, 'Dismiss', all, { decision: 'done' })).outcome, 'cleared');
  assert.deepEqual(log, ['read-notif:credit-a', 'read-notif:credit-b']);
});

test('a finding: done clears it, never becomes a rule in the owner\'s words, do it starts a turn with what she said', async () => {
  let run = deps({}, { decision: 'done' });
  assert.equal((await replyToFromClem('notif:cal', 'got it', run.all)).outcome, 'cleared');
  assert.deepEqual(run.log, ['read:Your 4:00 interview was cancelled; that hour is free.|got it', 'read-notif:cal']);

  run = deps({}, { decision: 'never' });
  assert.equal((await replyToFromClem('notif:wr', 'stop telling me about standup', run.all)).outcome, 'rule_added');
  assert.deepEqual(run.log.slice(1), ['read-notif:wr', 'rule:work-review:stop telling me about standup']);

  run = deps({}, { decision: 'do_it' });
  const started = await replyToFromClem('notif:cal', 'let the organizer know', run.all);
  assert.deepEqual(started, { outcome: 'started', decision: 'do_it', sessionId: 'sess-1', runId: 'from-clem:fixture' });
  const turn = run.log.find((line) => line.startsWith('turn:'))!;
  assert.match(turn, /^turn:let the organizer know:You told me: Your 4:00 interview was cancelled; that hour is free\./);
  assert.match(turn, /What it was about: Cancelled: Interview\nWas 4:00 PM\./);
  assert.match(turn, /My reply: let the organizer know$/);
  assert.ok(run.log.includes('read-notif:cal'));
});

test('a suggestion: do it approves it, with an instruction it becomes a conversation, not now snoozes it, done declines it', async () => {
  let run = deps({}, { decision: 'do_it' });
  assert.equal((await replyToFromClem('plan:plan1', 'yes', run.all)).outcome, 'approved');
  assert.ok(run.log.includes('approve:plan1'));

  run = deps({}, { decision: 'do_it', instruction: 'call it Calendar view' });
  assert.equal((await replyToFromClem('plan:plan1', 'yes but call it Calendar view', run.all)).outcome, 'started');
  assert.ok(run.log.some((line) => line.startsWith('reject:plan1:Taken up in conversation')));

  run = deps({}, { decision: 'not_now' });
  assert.equal((await replyToFromClem('plan:plan1', 'later', run.all)).outcome, 'later');
  assert.ok(run.log.includes('snooze:plan1'));
  // "Not now" on a finding moves it to later; it is never cleared.
  run = deps({}, { decision: 'not_now' });
  assert.equal((await replyToFromClem('notif:cal', 'not now', run.all)).outcome, 'later');
  assert.ok(run.log.includes('later:notif:cal'));
  assert.ok(!run.log.some((line) => line.startsWith('read-notif:')), 'a finding moved to later stays unread');

  run = deps({}, { decision: 'done' });
  assert.equal((await replyToFromClem('plan:plan1', 'no thanks', run.all)).outcome, 'declined');
});

test('a brain-outage question: yes switches back, no keeps the backup, words with a new instruction become a conversation', async () => {
  const { buildFromClem } = await import('./from-clem.js');
  const outageStream = () => buildFromClem({
    heartbeats: [], noticingProposals: [], planProposals: [],
    notifications: [{ id: 'brain-outage-bo1-back', kind: 'system', title: 'The chosen model is answering again', body: 'Waiting on the owner: switch back?',
      createdAt: '2026-10-15T08:00:00.000Z', read: false,
      metadata: { heartbeatId: 'brain-health', itemKey: 'bo1:back', brainOutageId: 'bo1', needsAttention: true } }],
    asksOwner: () => true,
  });
  const answers: string[] = [];
  const outageDeps = (decision: { decision: string; instruction?: string }, resolved = true) => deps({
    read: async () => outageStream(),
    resolveBrainOutage: async (id, choice) => { answers.push(`${id}:${choice}`); return resolved; },
  }, decision);
  assert.equal((await replyToFromClem('notif:brain-outage-bo1-back', 'Yes, switch back', outageDeps({ decision: 'do_it' }).all, { decision: 'do_it' })).outcome, 'approved');
  assert.equal((await replyToFromClem('notif:brain-outage-bo1-back', 'No, keep the backup', outageDeps({ decision: 'done' }).all, { decision: 'done' })).outcome, 'declined');
  assert.deepEqual(answers, ['bo1:switch_back', 'bo1:stay']);
  const later = outageDeps({ decision: 'not_now' });
  assert.equal((await replyToFromClem('notif:brain-outage-bo1-back', 'ask me tomorrow', later.all)).outcome, 'later');
  assert.ok(later.log.includes('later:notif:brain-outage-bo1-back'));
  assert.equal(answers.length, 2, 'later decides nothing');
  const other = outageDeps({ decision: 'do_it', instruction: 'switch to the Claude model instead' });
  assert.equal((await replyToFromClem('notif:brain-outage-bo1-back', 'switch to the Claude model instead', other.all)).outcome, 'started');
  assert.equal(answers.length, 2, 'a new instruction is hers to carry out in a turn');
  assert.deepEqual(await replyToFromClem('notif:brain-outage-bo1-back', 'Yes', outageDeps({ decision: 'do_it' }, false).all, { decision: 'do_it' }), { outcome: 'gone' });
});

test('unclear words change nothing, and a row that is gone says so', async () => {
  const run = deps({}, { decision: 'unclear' });
  assert.deepEqual(await replyToFromClem('notif:cal', 'hmm', run.all), { outcome: 'unclear', decision: 'unclear' });
  assert.equal(run.log.length, 1, 'only the read');
  assert.deepEqual(await replyToFromClem('notif:missing', 'ok', run.all), { outcome: 'gone' });
});

// An informational reply is a conversation about an unresolved item, not an
// answer to that item. These fixtures never use a real notification or provider.
function assertNoFollowUpSettlement(log: readonly string[]): void {
  assert.deepEqual(log.filter((line) => /^(?:answer:|read-notif:|rule:|approve:|reject:|snooze:|later:)/.test(line)), []);
}

test('a typed informational follow-up dispatches the ordinary turn with exact context and no approval or notification settlement', async () => {
  const { bindFromClemRespond, startFromClemTurn, CLEM_THREAD_ID } = await import('./from-clem-runtime.js');
  const requests: Array<Parameters<NonNullable<Parameters<typeof bindFromClemRespond>[0]>>[0]> = [];
  let ensured = 0;
  bindFromClemRespond(async (request) => { requests.push(request); });
  try {
    const run = deps({
      read: async () => stream((key) => key === 'notif:wr'
        ? { message: 'The controlled standup is waiting on your decision.', choices: ['Accept', 'Decline', 'Suggest another time'] }
        : undefined),
      startTurn: (input) => startFromClemTurn(input, { ensure() { ensured += 1; } }),
    }, { decision: 'follow_up' });
    const row = (await run.all.read()).rows.find((item) => item.key === 'notif:wr')!;
    const reply = 'what day is this?';
    const result = await replyToFromClem(row.key, reply, run.all, {
      requestId: 'follow-up-notification-ordinary-0001', seenDigest: row.voiceDigest,
    });
    assert.equal(result.outcome, 'started');
    assert.deepEqual(result, {
      outcome: 'started', decision: 'follow_up', itemSettled: false,
      sessionId: CLEM_THREAD_ID, runId: requests[0]?.runId,
    });
    assert.equal(ensured, 1);
    assert.equal(requests.length, 1);
    const request = requests[0]!;
    assert.equal(request.channel, 'desktop');
    assert.equal(request.sessionId, CLEM_THREAD_ID);
    assert.match(request.runId, /^from-clem:[A-Za-z0-9-]+$/);
    assert.equal(request.displayMessage, reply, 'the accepted owner wording is not replaced by the card or an action');
    assert.ok(request.message.includes(row.say!));
    assert.ok(request.message.includes(`${row.text}\n${row.detail}`));
    assert.ok(request.message.includes('itemKey=k2'), 'the existing item reference reaches the ordinary turn');
    assert.ok(request.message.includes(`My reply: ${reply}`));
    assert.equal(Object.hasOwn(request, 'ownerChoiceToken'), false, 'asking for context is not approval of an offered action');
    assertNoFollowUpSettlement(run.log);
    assert.equal((await run.all.read()).rows.find((item) => item.key === row.key)?.asks, true);
  } finally { bindFromClemRespond(null); }
});

test('a typed informational follow-up about a plan starts a conversation without approving, rejecting, or snoozing the plan', async () => {
  const starts: Array<Parameters<FromClemReplyDeps['startTurn']>[0]> = [];
  const run = deps({ startTurn: (input) => {
    starts.push(input); return { sessionId: 'sess-follow-up-plan', runId: 'from-clem:follow-up-plan' };
  } }, { decision: 'follow_up', instruction: 'Explain the proposed scope.' });
  const row = (await run.all.read()).rows.find((item) => item.key === 'plan:plan1')!;
  const reply = 'What would this include?';
  assert.deepEqual(await replyToFromClem(row.key, reply, run.all, {
    requestId: 'follow-up-plan-ordinary-0001', seenDigest: row.voiceDigest,
  }), {
    outcome: 'started', decision: 'follow_up', itemSettled: false,
    sessionId: 'sess-follow-up-plan', runId: 'from-clem:follow-up-plan',
  });
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.displayMessage, reply);
  assert.ok(starts[0]!.message.includes(row.text));
  assert.ok(starts[0]!.message.includes(`My reply: ${reply}`));
  assert.equal(Object.hasOwn(starts[0]!, 'ownerChoiceToken'), false);
  assertNoFollowUpSettlement(run.log);
  assert.equal((await run.all.read()).rows.find((item) => item.key === row.key)?.answer?.kind, 'yes_no');
});

test('a duplicate informational follow-up request starts one conversation while leaving the item unresolved', async () => {
  const starts: Array<Parameters<FromClemReplyDeps['startTurn']>[0]> = [];
  const run = deps({ startTurn: (input) => {
    starts.push(input); return { sessionId: 'sess-follow-up-repeat', runId: 'from-clem:follow-up-repeat' };
  } }, { decision: 'follow_up' });
  const row = (await run.all.read()).rows.find((item) => item.key === 'notif:wr')!;
  const request = { requestId: 'follow-up-deduplicated-0001', seenDigest: row.voiceDigest };
  const [first, duplicate] = await Promise.all([
    replyToFromClem(row.key, 'what day is this?', run.all, request),
    replyToFromClem(row.key, 'what day is this?', run.all, request),
  ]);
  assert.deepEqual(first, {
    outcome: 'started', decision: 'follow_up', itemSettled: false,
    sessionId: 'sess-follow-up-repeat', runId: 'from-clem:follow-up-repeat',
  });
  assert.deepEqual(duplicate, first);
  assert.deepEqual(await replyToFromClem(row.key, 'what day is this?', run.all, request), first);
  assert.equal(starts.length, 1);
  assert.equal(run.log.filter((line) => line.startsWith('read:')).length, 1);
  assert.equal(Object.hasOwn(starts[0]!, 'ownerChoiceToken'), false);
  assertNoFollowUpSettlement(run.log);
});

test('an informational follow-up to a stale item version does not classify, dispatch, or settle anything', async () => {
  const run = deps({}, { decision: 'follow_up' });
  assert.deepEqual(await replyToFromClem('notif:wr', 'what day is this?', run.all, {
    requestId: 'follow-up-stale-entry-0001', seenDigest: 'a-version-the-owner-no-longer-sees',
  }), { outcome: 'changed' });
  assert.deepEqual(run.log, []);
});

test('an informational follow-up rechecks the item after classification before dispatching or settling', async () => {
  let reads = 0;
  const run = deps({ read: async () => {
    reads += 1;
    const value = stream();
    return reads === 1 ? value : { ...value, rows: value.rows.map((row) => row.key === 'notif:wr'
      ? { ...row, voiceDigest: 'changed-during-informational-classification' } : row) };
  } }, { decision: 'follow_up' });
  const seenDigest = stream().rows.find((item) => item.key === 'notif:wr')!.voiceDigest;
  assert.deepEqual(await replyToFromClem('notif:wr', 'what day is this?', run.all, {
    requestId: 'follow-up-stale-recheck-0001', seenDigest,
  }), { outcome: 'changed' });
  assert.equal(reads, 2);
  assert.equal(run.log.length, 1, 'classification is the only work that happened');
  assertNoFollowUpSettlement(run.log);
});

test('informational wording does not dispatch when its classifier is absent, malformed, or unclear', async () => {
  const { configuredBrainSemanticPort } = await import('../runtime/semantic-boundary/configured-brain-semantic-port.js');
  const rawPackets: unknown[] = [
    { decision: 'unclear', instruction: null },
    { decision: 'follow_up' }, // instruction remains required, even when null.
    { decision: 'follow_up', instruction: 42 },
    { decision: 'follow_up', instruction: null, failedOpen: true },
    null,
  ];
  for (const [index, raw] of rawPackets.entries()) {
    let classified = 0;
    const port = configuredBrainSemanticPort(async () => {
      classified += 1;
      return { raw, modelIdentity: 'controlled-follow-up-classifier', inputTokens: 0, outputTokens: 0, latencyMs: 0 };
    });
    const run = deps({ port: () => port });
    assert.deepEqual(await replyToFromClem('notif:wr', 'what day is this?', run.all, {
      requestId: `follow-up-invalid-packet-${index}`,
    }), { outcome: 'unclear', decision: 'unclear' });
    assert.equal(classified, 1);
    assert.deepEqual(run.log, [], 'no dispatch, settlement, or fallback action');
  }
  for (const [index, port] of [null, {}].entries()) {
    const run = deps({ port: () => port as ReturnType<FromClemReplyDeps['port']> });
    assert.deepEqual(await replyToFromClem('notif:wr', 'what day is this?', run.all, {
      requestId: `follow-up-missing-classifier-${index}`,
    }), { outcome: 'unclear', decision: 'unclear' });
    assert.deepEqual(run.log, []);
  }
});

test('an unavailable informational-reply classifier never falls through to a conversation or settlement', async () => {
  const { configuredBrainSemanticPort } = await import('../runtime/semantic-boundary/configured-brain-semantic-port.js');
  const failure = new Error('Controlled classifier unavailable');
  let classified = 0;
  const port = configuredBrainSemanticPort(async () => { classified += 1; throw failure; });
  const run = deps({ port: () => port });
  await assert.rejects(replyToFromClem('notif:wr', 'what day is this?', run.all, {
    requestId: 'follow-up-classifier-unavailable-0001',
  }), (error) => error === failure);
  assert.equal(classified, 1);
  assert.deepEqual(run.log, []);
});

// ── durability: crash/retry, stale versions, double replies ──────────────────

test('a message already in her thread is not posted again when the record of posting it was lost', async () => {
  const fs = await import('node:fs');
  fs.rmSync(path.join(TMP, 'state', 'from-clem-voice.json'), { force: true });
  const port = () => ({
    async voiceProactiveItem(call: { item: { title: string }; evidenceDigest: string }) {
      return { message: `Clem: ${call.item.title}`, evidenceDigest: call.evidenceDigest, modelIdentity: 'fixture-brain' };
    },
  });
  const rows = stream().rows;
  const cal = rows.find((row) => row.key === 'notif:cal')!;
  // The thread already has this item at this version (posted, then the voice
  // file write was lost); the voice file says nothing was posted.
  const posts: string[] = [];
  const thread = {
    ensure: () => undefined,
    postedKeys: () => new Set([`notif:cal:${cal.voiceDigest}`]),
    post: (m: { key: string }) => { posts.push(m.key); },
    primer: () => true,
  };
  await voiceFromClemRows(rows, { port: port as never, max: 10, thread });
  assert.equal(posts.includes('notif:cal'), false, 'not posted twice');
  assert.ok(posts.includes('notif:wr'));
});

test('her thread forgets a raised item once it is resolved, even with nothing new to post', async () => {
  const fs = await import('node:fs');
  fs.rmSync(path.join(TMP, 'state', 'from-clem-voice.json'), { force: true });
  const port = () => ({
    async voiceProactiveItem(call: { item: { title: string }; evidenceDigest: string }) {
      return { message: `Clem: ${call.item.title}`, evidenceDigest: call.evidenceDigest, modelIdentity: 'fixture-brain' };
    },
  });
  const primers: string[] = [];
  const thread = { ensure: () => undefined, postedKeys: () => new Set<string>(), post: () => undefined, primer: (t: string) => { primers.push(t); return true; } };
  await voiceFromClemRows(stream().rows, { port: port as never, max: 10, thread });
  assert.match(primers.at(-1)!, /Cancelled: Interview/);
  // The calendar finding is cleared: no new post, and the primer follows.
  await voiceFromClemRows(stream(undefined, new Set(['cal'])).rows, { port: port as never, max: 10, thread });
  assert.doesNotMatch(primers.at(-1)!, /Cancelled: Interview/);
  const count = primers.length;
  await voiceFromClemRows(stream(undefined, new Set(['cal'])).rows, { port: port as never, max: 10, thread });
  assert.equal(primers.length, count, 'an unchanged primer is not rewritten');
  await voiceFromClemRows([], { port: port as never, max: 10, thread });
  assert.match(primers.at(-1)!, /^\[clem-raised\] Nothing I \(Clem\) raised/);
});

test('one item that cannot be said waits on its own; the others are still said', async () => {
  const fs = await import('node:fs');
  fs.rmSync(path.join(TMP, 'state', 'from-clem-voice.json'), { force: true });
  const asked: string[] = [];
  const port = () => ({
    async voiceProactiveItem(call: { item: { title: string }; evidenceDigest: string }) {
      asked.push(call.item.title);
      if (call.item.title === 'Save this as a workflow') throw new Error('fixture model refused');
      return { message: `Clem: ${call.item.title}`, evidenceDigest: call.evidenceDigest, modelIdentity: 'fixture-brain' };
    },
  });
  let now = Date.parse('2026-10-01T13:00:00.000Z');
  const rows = stream().rows;
  assert.equal(await voiceFromClemRows(rows, { port: port as never, max: 10, thread: null, now: () => now }), 3, 'the failing item does not stop the pass');
  asked.length = 0;
  now += 60_000;
  assert.equal(await voiceFromClemRows(rows, { port: port as never, max: 10, thread: null, now: () => now }), 0);
  assert.deepEqual(asked, [], 'it waits before being asked again');
  now += 10 * 60_000;
  await voiceFromClemRows(rows, { port: port as never, max: 10, thread: null, now: () => now });
  assert.deepEqual(asked, ['Save this as a workflow'], 'and is asked again after its wait');
});

test('a reply to a version the owner did not see, or an item that changed while reading it, does nothing', async () => {
  let run = deps({}, { decision: 'done' });
  assert.deepEqual(await replyToFromClem('notif:cal', 'got it', run.all, { seenDigest: 'an-older-version' }), { outcome: 'changed' });
  assert.deepEqual(run.log, []);

  let reads = 0;
  run = deps({
    read: async () => {
      reads += 1;
      const current = stream();
      if (reads === 1) return current;
      return { ...current, rows: current.rows.map((row) => (row.key === 'notif:cal' ? { ...row, voiceDigest: 'moved-on' } : row)) };
    },
  }, { decision: 'done' });
  assert.deepEqual(await replyToFromClem('notif:cal', 'got it', run.all), { outcome: 'changed' });
  assert.equal(run.log.some((line) => line.startsWith('read-notif:')), false);
});

test('one reply is one action: a retried send returns the first answer, and a second reply reads what the first did', async () => {
  const readIds = new Set<string>();
  let turns = 0;
  const run = deps({
    read: async () => stream(undefined, readIds),
    markRead: (id) => { readIds.add(id); },
    startTurn: () => { turns += 1; return { sessionId: 'sess-1', runId: 'from-clem:fixture' }; },
  }, { decision: 'do_it' });
  const [first, retried] = await Promise.all([
    replyToFromClem('notif:cal', 'let the organizer know', run.all, { requestId: 'reply-aaaaaaaa' }),
    replyToFromClem('notif:cal', 'let the organizer know', run.all, { requestId: 'reply-aaaaaaaa' }),
  ]);
  assert.deepEqual(first, retried);
  assert.equal(turns, 1);
  // The same reply from another device, with its own id, finds the item handled.
  assert.deepEqual(await replyToFromClem('notif:cal', 'let the organizer know', run.all, { requestId: 'reply-bbbbbbbb' }), { outcome: 'gone' });
  assert.equal(turns, 1);
});

test('a Noticing answer carries the reply id, so the check-in sees one answer', async () => {
  const ids: Array<string | undefined> = [];
  const run = deps({ answerQuestion: (_id, _text, requestId) => { ids.push(requestId); return true; } });
  await replyToFromClem('noticing:p1', 'yes', run.all, { requestId: 'reply-cccccccc' });
  assert.deepEqual(ids, ['reply-cccccccc']);
});

test('her words are background usage and reading a reply is work in her thread, never unattributed', async () => {
  const fs = await import('node:fs');
  fs.rmSync(path.join(TMP, 'state', 'from-clem-voice.json'), { force: true });
  const owners: string[] = [];
  const port = () => ({
    async voiceProactiveItem(call: { item: { title: string }; evidenceDigest: string }) {
      owners.push(modelUsageAttributionStorage.getStore()?.sessionId ?? 'none');
      return { message: `Clem: ${call.item.title}`, evidenceDigest: call.evidenceDigest, modelIdentity: 'fixture-brain' };
    },
  });
  await voiceFromClemRows(stream().rows.slice(0, 1), { port: port as never, max: 1, thread: null });
  assert.deepEqual(owners, ['background:from-clem']);
  let replyOwner = 'none';
  const run = deps({ port: () => ({
    async readClemReply(call) {
      replyOwner = modelUsageAttributionStorage.getStore()?.sessionId ?? 'none';
      return { decision: 'unclear', evidenceDigest: call.evidenceDigest, modelIdentity: 'fixture-brain' } as never;
    },
  }) });
  await replyToFromClem('notif:cal', 'hmm', run.all);
  assert.equal(replyOwner, 'clem');
});

test('a heartbeat\'s latest check counts as failed only when its error belongs to that check', async () => {
  const { lastCheckFailed } = await import('./from-clem-runtime.js');
  assert.equal(lastCheckFailed('2026-10-02T10:00:00.000Z', undefined), false);
  assert.equal(lastCheckFailed('2026-10-02T10:00:00.000Z', '2026-10-02T10:00:00.000Z'), true, 'the same check');
  assert.equal(lastCheckFailed('2026-10-02T10:00:40.000Z', '2026-10-02T10:00:00.000Z'), false, 'a rapid later finding cannot inherit an older failure');
  assert.equal(lastCheckFailed('2026-10-02T10:00:00.000Z', '2026-10-02T10:00:40.000Z'), true, 'a later failed attempt supersedes the older finding');
  assert.equal(lastCheckFailed('2026-10-02T10:30:00.000Z', '2026-10-02T10:00:00.000Z'), false, 'an older failure, since checked cleanly');
  assert.equal(lastCheckFailed('not a date', '2026-10-02T10:00:00.000Z'), false);
});

test('the shared live From Clem read preserves partial check state without presenting raw failure text as a finding', async () => {
  const { readFromClem } = await import('./from-clem-runtime.js');
  const { emptyCalendarWatchState } = await import('../agents/calendar-watch.js');
  const { loadCalendarWatchState, saveCalendarWatchState } = await import('../agents/calendar-watch-runtime.js');
  const before = loadCalendarWatchState();
  const state = emptyCalendarWatchState();
  const at = new Date(Date.now() - 1_000).toISOString();
  state.lastTickAt = at;
  state.lastFinding = { tickId: 'controlled-partial-read', at, source: 'manual', durationMs: 1, accounts: 1,
    events: 0, changes: 0, produced: 0, vetoed: 0, retired: 0, quiet: true, readFailures: 1,
    summary: 'No change across the successfully read account.' };
  state.lastError = { at, reason: 'Controlled private read diagnostic.' };
  try {
    saveCalendarWatchState(state);
    // This control owns heartbeat projection, not setup readiness. The
    // default setup reader loads unrelated provider/credential/MCP graphs.
    let setupReads = 0;
    const stream = await readFromClem({ readSetup: async () => { setupReads++; return null; } });
    assert.equal(setupReads, 1);
    const pulse = stream.pulses.find(row => row.heartbeat === 'calendar');
    assert.equal(pulse?.presentation?.lastCheck.state, 'partial');
    assert.equal(pulse?.presentation?.lastCheck.readFailures, 1);
    assert.equal(pulse?.summary, undefined);
    assert.equal(pulse?.lastAt, at);
    assert.ok(!JSON.stringify(stream).includes('Controlled private read diagnostic'));
  } finally { saveCalendarWatchState(before); }
});

for (const unavailableSetup of ['held', 'rejecting'] as const) {
  test(`retained pending asks do not invoke ${unavailableSetup} setup enrichment when it is omitted`, { timeout: 10_000 }, async (t) => {
    const { readFromClem } = await import('./from-clem-runtime.js');
    const proposal: PlanProposal = {
      id: `controlled-no-setup-${unavailableSetup}`, proposedAt: new Date().toISOString(),
      proposedByAgent: 'workflow-suggestions', status: 'pending', version: 'v1',
      originatingRequest: 'Save the controlled report as a reusable workflow.',
      context: 'Keep the current account and prepare a local draft only.',
      plan: {
        objective: 'Prepare the controlled local report.',
        steps: [{ n: 1, action: 'Read the controlled fixture.', rationale: 'Preserve its source evidence.', verification: 'The draft cites the fixture.' }],
        successCriteria: ['The local draft cites the controlled fixture.'], stages: null, risks: [],
        estimatedComplexity: 'moderate', recommendsTrackedExecution: false, needsUserInput: [],
        appliedInstructions: ['Use the current account; do not send.'], externalSends: null,
      },
    };
    const proposalDir = path.join(TMP, 'state', 'plan-proposals');
    const proposalFile = path.join(proposalDir, `${proposal.id}.json`);
    mkdirSync(proposalDir, { recursive: true });
    writeFileSync(proposalFile, JSON.stringify(proposal));
    let releaseHeld!: (value: FromClemSetup | null) => void;
    const held = new Promise<FromClemSetup | null>((resolve) => { releaseHeld = resolve; });
    t.after(() => { releaseHeld(null); rmSync(proposalFile, { force: true }); });

    const setup: FromClemSetup = {
      ability: 'phone', name: 'The phone app', unlocks: 'answer from anywhere', detail: 'No controlled phone is paired.',
      state: 'not_set_up', place: 'phone', placeName: 'Your phone', since: proposal.proposedAt,
    };
    let defaultSetupReads = 0;
    const enriched = await readFromClem({ readSetup: async () => { defaultSetupReads++; return setup; } });
    assert.equal(defaultSetupReads, 1, 'ordinary reads retain setup enrichment by default');
    assert.ok(enriched.rows.some((row) => row.key === 'setup:phone' && row.asks === false));

    let omittedSetupReads = 0;
    const retained = await readFromClem({ includeSetup: false, readSetup: () => {
      omittedSetupReads++;
      return unavailableSetup === 'held' ? held : Promise.reject(new Error('controlled setup reader must not run'));
    } });
    assert.equal(omittedSetupReads, 0);
    assert.ok(retained.rows.every((row) => !row.setup));
    assert.deepEqual(retained.rows, enriched.rows.filter((row) => !row.setup), 'retained rows keep their content, bindings and digests');
    assert.deepEqual(retained.covers, enriched.covers);
    const pending = retained.rows.filter((row) => row.asks && row.heartbeat !== 'noticing');
    assert.deepEqual(pending, enriched.rows.filter((row) => row.asks && row.heartbeat !== 'noticing'));
    assert.ok(pending.some((row) => row.key === `plan:${proposal.id}`));
    assert.deepEqual(pending.find((row) => row.key === `plan:${proposal.id}`)?.answer,
      { kind: 'yes_no', planProposalId: proposal.id });
  });
}

test('structured handoff progress needs no extra model wording or repeated invitation', async () => {
  const progress = buildFromClem({ heartbeats: [], notifications: [], planProposals: [], asksOwner: () => false,
    noticingProposals: [{ id: 'controlled-progress', title: 'Prepare the controlled draft', status: 'answered',
      createdAt: '2026-10-01T10:00:00.000Z', handoff: { state: 'dispatched', sessionId: 'controlled-progress-chat',
        updatedAt: '2026-10-01T11:00:00.000Z' } }] }).rows;
  let calls = 0;
  const written = await voiceFromClemRows(progress, { thread: null, port: () => ({
    async voiceProactiveItem() { calls++; throw new Error('handoff progress must use the retained state'); },
  }) as never });
  assert.equal(written, 0);
  assert.equal(calls, 0);
  assert.equal(progress[0]?.asks, false);
  assert.equal(progress[0]?.answer, undefined);
});

test('an item moved to later is hidden until the next morning and stays covered meanwhile', async () => {
  const { moveFromClemRowToLater, nextMorning, readFromClem } = await import('./from-clem-runtime.js');
  const now = new Date(2026, 9, 4, 15, 0).getTime();
  const morning = new Date(nextMorning(now));
  assert.equal(morning.getDate(), 5);
  assert.equal(morning.getHours(), 8);
  moveFromClemRowToLater('notif:cal', now);
  const hidden = stream(undefined, new Set());
  assert.ok(hidden.rows.some((row) => row.key === 'notif:cal'), 'the stream helper itself is unfiltered');
  const { buildFromClem: build } = await import('./from-clem.js');
  const later = build({ heartbeats: [], noticingProposals: [], planProposals: [], asksOwner: () => false,
    notifications: [{ id: 'cal', kind: 'execution', title: 'Cancelled: Interview', body: '', createdAt: '2026-10-01T12:00:00.000Z', read: false, metadata: { watch: 'calendar', itemKey: 'k1' } }],
    later: (key) => key === 'notif:cal' });
  assert.equal(later.rows.length, 0);
  assert.deepEqual(later.covers.notificationIds, ['cal']);
  assert.equal(typeof readFromClem, 'function');
});

test('a workflow report lands in her thread as she wrote it, titled, with no model asked to say it again', async () => {
  const fs = await import('node:fs');
  fs.rmSync(path.join(TMP, 'state', 'from-clem-voice.json'), { force: true });
  const posts: Array<{ key: string; text: string }> = [];
  const primers: string[] = [];
  const thread = {
    ensure: () => {},
    postedKeys: () => new Set<string>(),
    post: (m: { key: string; text: string }) => { posts.push(m); },
    primer: (t: string) => { primers.push(t); return true; },
  };
  const body = `Five things moved.\n${'- a detail worth reading\n'.repeat(40)}`.trim();
  const rows = buildFromClem({
    heartbeats: [], noticingProposals: [], planProposals: [], asksOwner: () => false,
    now: Date.parse('2026-10-09T15:00:00.000Z'),
    notifications: [{ id: 'rep', kind: 'workflow', title: 'Morning trends', body, createdAt: '2026-10-09T14:31:00.000Z', read: false,
      metadata: { source: 'notify_user_tool', workflowRunId: 'run-rep', workflow: 'morning-trends' } }],
  }).rows;
  let asked = 0;
  const port = () => ({ async voiceProactiveItem() { asked += 1; return { message: 'reworded', evidenceDigest: 'x', modelIdentity: 'm' }; } });
  assert.equal(await voiceFromClemRows(rows, { port: port as never, thread }), 0, 'nothing for a model to write');
  assert.equal(asked, 0);
  assert.deepEqual(posts.map((post) => post.text), [`Morning trends\n\n${body}`]);
  // The thread's context names it without carrying the whole report again.
  assert.match(primers.at(-1)!, /morning-trends: Morning trends/);
  assert.ok(primers.at(-1)!.length < body.length + 600);
  await voiceFromClemRows(rows, { port: port as never, thread });
  assert.equal(posts.length, 1, 'posted once');
});

test('a tapped choice carries the owner\'s approval of exactly that action; typed words and a mismatched tap do not', async () => {
  // Owner 2026-10-09: "Tap is the approval."
  const { redeemOwnerChoiceToken } = await import('../runtime/harness/owner-choice.js');
  const tokens: Array<string | undefined> = [];
  const run = deps({
    read: async () => stream((key) => (key === 'notif:wr' ? { message: 'Standup is still waiting on you. Accept it?', choices: ['Accept', 'Decline'] } : undefined)),
    startTurn: (input) => { tokens.push(input.ownerChoiceToken); return { sessionId: 'sess-1', runId: 'from-clem:fixture' }; },
  }, { decision: 'do_it' });
  const row = (await run.all.read()).rows.find((candidate) => candidate.key === 'notif:wr')!;
  assert.deepEqual(row.ref, { itemKey: 'k2' }, 'the row carries what it is about');

  assert.equal((await replyToFromClem('notif:wr', 'Accept', run.all, { choiceIndex: 0, requestId: 'tap-accept-0001' })).outcome, 'started');
  const choice = redeemOwnerChoiceToken(tokens.at(-1));
  assert.equal(choice?.choice, 'Accept');
  assert.equal(choice?.rowKey, 'notif:wr');
  assert.equal(choice?.said, 'Standup is still waiting on you. Accept it?');
  assert.match(choice?.facts ?? '', /Still waiting on you: standup/);
  assert.deepEqual(choice?.ref, { itemKey: 'k2' });

  await replyToFromClem('notif:wr', 'Accept', run.all, { requestId: 'typed-accept-0001' });
  assert.equal(tokens.at(-1), undefined, 'the same words typed are an ordinary reply');
  await replyToFromClem('notif:wr', 'Accept', run.all, { choiceIndex: 1, requestId: 'tap-mismatch-0001' });
  assert.equal(tokens.at(-1), undefined, 'an index that is not the shown choice is nothing');
});

test('tap outcomes bind the exact dispatched run, never identical words or a newer choice', async () => {
  const { fromClemTurnOutcome, CLEM_THREAD_ID } = await import('./from-clem-runtime.js');
  const eventlog = await import('../runtime/harness/eventlog.js');
  const { commitTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
  const { turnOutcomeId } = await import('../runtime/harness/turn-outcome.js');
  if (!eventlog.getSession(CLEM_THREAD_ID)) eventlog.createSession({ id: CLEM_THREAD_ID, kind: 'chat', channel: 'desktop' });
  const since = new Date(Date.now() - 1_000).toISOString();
  const accept = (runId: string, rowKey: string, choice?: string) => {
    const attempt = eventlog.beginRunAttempt(CLEM_THREAD_ID, { runId });
    return eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
      text: 'Do it', displayText: 'Do it', runId,
      ...(choice ? { ownerChoice: { version: 1, rowKey, voiceDigest: 'fixture', said: 'Controlled fixture.', facts: 'Fixture.', choice, tappedAt: new Date().toISOString() } } : {}),
    } });
  };
  const finish = (source: ReturnType<typeof accept>, text: string) => {
    const identity = { sessionId: CLEM_THREAD_ID, turn: source.turn, sourceUserSeq: source.seq };
    commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false,
      presentation: { kind: 'answer', text } });
  };
  const first = accept('from-clem:fixture-first', 'notif:first');
  finish(first, 'First controlled result.');
  const second = accept('from-clem:fixture-second', 'notif:second');
  finish(second, 'Second controlled result.');
  assert.deepEqual(fromClemTurnOutcome({ runId: 'from-clem:fixture-first', since }),
    { state: 'done', text: 'First controlled result.', sessionId: CLEM_THREAD_ID });
  const earlier = accept('from-clem:fixture-choice-1', 'notif:repeat', 'Accept');
  finish(earlier, 'Earlier controlled choice.');
  const later = accept('from-clem:fixture-choice-2', 'notif:repeat', 'Decline');
  finish(later, 'Later controlled choice.');
  assert.deepEqual(fromClemTurnOutcome({ runId: 'from-clem:fixture-choice-1', since }),
    { state: 'done', text: 'Earlier controlled choice.', sessionId: CLEM_THREAD_ID });
  assert.deepEqual(fromClemTurnOutcome({ runId: 'from-clem:fixture-never-accepted', since }), { state: 'working' });
  assert.deepEqual(fromClemTurnOutcome({ runId: 'from-clem:fixture-never-accepted', since: new Date(Date.now() - 180_000).toISOString() }), { state: 'not_found' });
});

test('a From Clem start returns the same host run identity passed into dispatch', async () => {
  const { bindFromClemRespond, startFromClemTurn, CLEM_THREAD_ID } = await import('./from-clem-runtime.js');
  const requests: Array<Record<string, unknown>> = [];
  bindFromClemRespond(async (request) => { requests.push(request); });
  try {
    const input = { title: 'Controlled fixture', message: 'Read the controlled item.', displayMessage: 'Do it' };
    const first = startFromClemTurn(input, { ensure() {} });
    const second = startFromClemTurn(input, { ensure() {} });
    assert.equal(first.sessionId, CLEM_THREAD_ID);
    assert.match(first.runId, /^from-clem:/);
    assert.notEqual(first.runId, second.runId);
    assert.equal(requests[0]?.runId, first.runId);
    assert.equal(requests[1]?.runId, second.runId);
  } finally { bindFromClemRespond(null); }
});
