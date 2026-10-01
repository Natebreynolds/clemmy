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
type FromClemReplyDeps = Parameters<typeof replyToFromClem>[2];

const stream = (voiced?: (key: string, digest: string) => string | undefined) => buildFromClem({
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
  ],
  planProposals: [{ id: 'plan1', proposedAt: '2026-10-01T09:00:00.000Z', proposedByAgent: 'workflow-suggestions', status: 'pending', title: 'Save this as a workflow' }],
  asksOwner: (n) => n.id === 'wr',
  ...(voiced ? { voiced } : {}),
});

test('she writes each item once, a few per pass, again when it changes, and forgets what is gone', async () => {
  const calls: string[] = [];
  const port = () => ({
    async voiceProactiveItem(call: { item: { title: string }; evidenceDigest: string }) {
      calls.push(call.item.title);
      return { message: `I saw: ${call.item.title}`, evidenceDigest: call.evidenceDigest, modelIdentity: 'fixture-brain' };
    },
  });
  const rows = stream().rows;
  assert.equal(await voiceFromClemRows(rows, { port: port as never, max: 2 }), 2);
  assert.equal(await voiceFromClemRows(rows, { port: port as never, max: 2 }), 2);
  assert.equal(await voiceFromClemRows(rows, { port: port as never, max: 2 }), 0, 'nothing left to say');
  assert.equal(calls.length, 4);

  // The stream now carries her words; the record's own words stay as facts.
  const fs = await import('node:fs');
  const kept = JSON.parse(fs.readFileSync(path.join(TMP, 'state', 'from-clem-voice.json'), 'utf8')) as { entries: Record<string, { digest: string; message: string }> };
  const voicedStream = stream((key, digest) => (kept.entries[key]?.digest === digest ? kept.entries[key]!.message : undefined));
  const calendar = voicedStream.rows.find((row) => row.key === 'notif:cal')!;
  assert.equal(calendar.say, 'I saw: Cancelled: Interview');
  assert.equal(calendar.text, 'Cancelled: Interview');

  // A changed item is said again; a gone one is forgotten.
  const changed = rows.map((row) => (row.key === 'notif:cal' ? { ...row, voiceDigest: 'changed' } : row)).filter((row) => row.key !== 'notif:wr');
  assert.equal(await voiceFromClemRows(changed, { port: port as never }), 1);
  const after = JSON.parse(fs.readFileSync(path.join(TMP, 'state', 'from-clem-voice.json'), 'utf8')) as { entries: Record<string, unknown> };
  assert.equal(after.entries['notif:wr'], undefined);

  // No model: nothing is written and the items keep their own words.
  assert.equal(await voiceFromClemRows(rows, { port: () => null }), 0);
});

function deps(over: Partial<FromClemReplyDeps> = {}, decision: { decision: string; instruction?: string } = { decision: 'done' }) {
  const log: string[] = [];
  const all: FromClemReplyDeps = {
    read: async () => stream((key) => (key === 'notif:cal' ? 'Your 4:00 interview was cancelled; that hour is free.' : undefined)),
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

  run = deps({}, { decision: 'done' });
  assert.equal((await replyToFromClem('plan:plan1', 'no thanks', run.all)).outcome, 'declined');
});

test('unclear words change nothing, and a row that is gone says so', async () => {
  const run = deps({}, { decision: 'unclear' });
  assert.deepEqual(await replyToFromClem('notif:cal', 'hmm', run.all), { outcome: 'unclear', decision: 'unclear' });
  assert.equal(run.log.length, 1, 'only the read');
  assert.deepEqual(await replyToFromClem('notif:missing', 'ok', run.all), { outcome: 'gone' });
});
