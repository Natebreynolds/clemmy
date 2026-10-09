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
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
    startTurn: (input) => { log.push(`turn:${input.displayMessage}:${input.message}`); return 'sess-1'; },
    ...over,
  };
  return { all, log };
}

test('a Noticing reply is the check-in answer; the brain is not asked twice', async () => {
  const { all, log } = deps();
  assert.deepEqual(await replyToFromClem('noticing:p1', 'do it', all), { outcome: 'answered', questionId: 'checkin:ci1' });
  assert.deepEqual(log, ['answer:checkin:ci1:do it']);
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
  assert.deepEqual(started, { outcome: 'started', decision: 'do_it', sessionId: 'sess-1' });
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

test('unclear words change nothing, and a row that is gone says so', async () => {
  const run = deps({}, { decision: 'unclear' });
  assert.deepEqual(await replyToFromClem('notif:cal', 'hmm', run.all), { outcome: 'unclear', decision: 'unclear' });
  assert.equal(run.log.length, 1, 'only the read');
  assert.deepEqual(await replyToFromClem('notif:missing', 'ok', run.all), { outcome: 'gone' });
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
    startTurn: () => { turns += 1; return 'sess-1'; },
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
  assert.equal(lastCheckFailed('2026-10-02T10:00:40.000Z', '2026-10-02T10:00:00.000Z'), true, 'error recorded as the check started');
  assert.equal(lastCheckFailed('2026-10-02T10:30:00.000Z', '2026-10-02T10:00:00.000Z'), false, 'an older failure, since checked cleanly');
  assert.equal(lastCheckFailed('not a date', '2026-10-02T10:00:00.000Z'), false);
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
    startTurn: (input) => { tokens.push(input.ownerChoiceToken); return 'sess-1'; },
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
