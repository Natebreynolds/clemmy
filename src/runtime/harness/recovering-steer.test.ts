import { readFileSync } from 'node:fs';
/**
 * A follow-up sent while a crashed turn is RECOVERING must reach that work.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/recovering-steer.test.ts
 *
 * Live 2026-09-07: the daemon was SIGKILLed mid-turn on source 139708. Boot
 * recovery resumed it. At 00:30:17 the user sent "Never mind that. In one short
 * sentence: what is 9 plus 4?" — and because a recovering attempt holds only
 * the dead process's expired lease, the steering gate did not fire. The message
 * fell through to ordinary acceptance, the unsettled head made the session
 * non-reusable, and it branched into sess-branch-0b3390df… The original task
 * then issued its workflow_create at 00:30:33. The steering never arrived.
 *
 * These pin the DECISION — lease liveness versus recovery liveness — rather
 * than the HTTP route, so no daemon, model or provider is involved.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-recovering-steer-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'recovering-steer\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const {
  takeUndeliveredSteerNotes,
  appendSteerNote,
  steerReasonForRunningWork,
  RECOVERING_STEER_WINDOW_MS,
} = await import('./steer-notes.js');
after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

const WINDOW_MS = RECOVERING_STEER_WINDOW_MS;

/**
 * The ACTUAL predicate console-routes calls, fed the same three facts the
 * route reads. Re-implementing it here would have pinned a copy rather than
 * the shipped decision.
 */
function messageSteersRunningWork(input: {
  sessionId: string;
  leaseExpiresAt: string | null;
  finishedAt: string | null;
  nowMs: number;
}): { steers: boolean; reason: string | null } {
  const reason = steerReasonForRunningWork({
    runInFlightSince: HarnessSession.load(input.sessionId)?.runInFlightSince() ?? null,
    leaseExpiresAt: input.leaseExpiresAt,
    attemptFinishedAt: input.finishedAt,
    hasUnfinishedAttempt: !input.finishedAt,
    nowMs: input.nowMs,
  });
  return { steers: reason !== null, reason };
}

function chat(title: string) {
  return eventlog.createSession({ kind: 'chat', channel: 'desktop', title });
}

test('THE LIVE CASE: a follow-up during recovery steers instead of branching', () => {
  const row = chat('recovering');
  const s = HarnessSession.load(row.id);
  const crashedAt = '2026-09-07T00:27:01.921Z';       // the real interrupt time
  s.setRunInFlight(crashedAt);
  const now = Date.parse('2026-09-07T00:30:17.602Z'); // the real follow-up time

  const decision = messageSteersRunningWork({
    sessionId: row.id,
    leaseExpiresAt: '2026-09-07T00:27:31.000Z',       // expired with the dead process
    finishedAt: null,
    nowMs: now,
  });
  assert.equal(decision.steers, true, 'recovering work is still running work');
  assert.equal(decision.reason, 'recovering_in_flight');
});

test('an expired lease with NO recovery under way is not steerable', () => {
  // A dead-leased, non-recovering attempt must keep the ordinary supersede
  // path — otherwise a stopped run silently swallows the next message.
  const row = chat('dead-lease');
  const decision = messageSteersRunningWork({
    sessionId: row.id,
    leaseExpiresAt: '2026-09-07T00:00:00.000Z',
    finishedAt: null,
    nowMs: Date.parse('2026-09-07T01:00:00.000Z'),
  });
  assert.equal(decision.steers, false);
});

test('an ORPHANED marker past the window stops swallowing messages', () => {
  const row = chat('orphan');
  HarnessSession.load(row.id).setRunInFlight('2026-09-07T00:00:00.000Z');
  const decision = messageSteersRunningWork({
    sessionId: row.id,
    leaseExpiresAt: null,
    finishedAt: null,
    nowMs: Date.parse('2026-09-07T00:00:00.000Z') + WINDOW_MS + 1,
  });
  assert.equal(decision.steers, false, 'past the window the ordinary path resumes');
});

test('DELIBERATE SEPARATE WORK: a finished attempt still starts a new turn', () => {
  // "Retain deliberate independent work": a session whose run actually ended
  // must accept the next message as its own turn, not as steering.
  const row = chat('finished');
  const s = HarnessSession.load(row.id);
  s.setRunInFlight('2026-09-07T00:00:00.000Z');
  s.clearRunInFlight();
  const decision = messageSteersRunningWork({
    sessionId: row.id,
    leaseExpiresAt: '2026-09-07T00:01:00.000Z',
    finishedAt: '2026-09-07T00:00:30.000Z',
    nowMs: Date.parse('2026-09-07T00:00:45.000Z'),
  });
  assert.equal(decision.steers, false, 'completed work does not absorb the next request');
});

test('a live lease still steers, unchanged', () => {
  const row = chat('live-lease');
  const decision = messageSteersRunningWork({
    sessionId: row.id,
    leaseExpiresAt: '2026-09-07T00:05:00.000Z',
    finishedAt: null,
    nowMs: Date.parse('2026-09-07T00:00:00.000Z'),
  });
  assert.equal(decision.steers, true);
  assert.equal(decision.reason, 'lease_live', 'the pre-existing lane is untouched');
});

test('the steered note is delivered to the running turn exactly once', () => {
  const row = chat('delivery');
  appendSteerNote(row.id, 'Never mind that. In one short sentence: what is 9 plus 4?');
  const first = takeUndeliveredSteerNotes(row.id);
  assert.equal(first.length, 1);
  assert.match(first[0]!.text, /Never mind that/);
  assert.equal(takeUndeliveredSteerNotes(row.id).length, 0, 'delivered exactly once');
});

test('A FINISHED RESUME does not absorb the message, even with the marker armed', () => {
  // Measured live 2026-09-07 01:21: the resume attempt finished at 01:21:09
  // while the run-in-flight marker was still armed. Keying on the marker alone
  // steered the follow-up into a note no running turn would ever read, and the
  // session published no terminal — the user got no answer at all. The marker
  // is a claim; an unfinished attempt is the evidence.
  const row = chat('finished-resume');
  HarnessSession.load(row.id).setRunInFlight('2026-09-07T01:20:22.079Z');
  const reason = steerReasonForRunningWork({
    runInFlightSince: HarnessSession.load(row.id).runInFlightSince(),
    leaseExpiresAt: null,
    attemptFinishedAt: '2026-09-07T01:21:09.382Z',
    hasUnfinishedAttempt: false,
    nowMs: Date.parse('2026-09-07T01:21:30.000Z'),
  });
  assert.equal(reason, null, 'a finished resume must start a new turn, not swallow the message');
});

/* ------------------------------------------------------------------ *
 * THE DECISIVE C31 DEFECT: the judge evaluated the owner's answer
 * against the objective the owner had already abandoned.
 * ------------------------------------------------------------------ */

const { adoptedSteerNotesForSource, objectiveWithAdoptedSteering } =
  await import('./steer-notes.js');

function acceptSource(sessionId: string, text: string): number {
  const row = eventlog.appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text },
  });
  return row.seq;
}

test('an ADOPTED steer becomes part of the objective the judge evaluates', () => {
  const row = chat('objective');
  const src = acceptSource(row.id, 'Create a native workflow named X with three steps.');
  appendSteerNote(row.id, 'Never mind that. In one short sentence: what is 9 plus 4?');
  takeUndeliveredSteerNotes(row.id);          // the model adopts it

  const adopted = adoptedSteerNotesForSource({ sessionId: row.id, sourceUserSeq: src });
  assert.equal(adopted.length, 1);

  const objective = objectiveWithAdoptedSteering('Create a native workflow named X with three steps.', adopted);
  assert.match(objective, /Create a native workflow named X/, 'the original is preserved verbatim');
  assert.match(objective, /Never mind that/, 'the owner\'s later words reach the judge');
  assert.match(objective, /GOVERN WHERE THEY CONFLICT/, 'and are marked as governing');
});

test('an UNDELIVERED steer does not change the objective', () => {
  // Judging against an instruction the run never saw would fail work for
  // ignoring something it was never shown.
  const row = chat('undelivered');
  const src = acceptSource(row.id, 'Original objective.');
  appendSteerNote(row.id, 'Change of plan.');
  assert.deepEqual(adoptedSteerNotesForSource({ sessionId: row.id, sourceUserSeq: src }), []);
  assert.equal(objectiveWithAdoptedSteering('Original objective.', []), 'Original objective.');
});

test('a note belongs to exactly ONE accepted source', () => {
  const row = chat('binding');
  const first = acceptSource(row.id, 'First job.');
  appendSteerNote(row.id, 'Note for the first job.');
  takeUndeliveredSteerNotes(row.id);
  const second = acceptSource(row.id, 'Second job.');
  appendSteerNote(row.id, 'Note for the second job.');
  takeUndeliveredSteerNotes(row.id);

  const one = adoptedSteerNotesForSource({ sessionId: row.id, sourceUserSeq: first });
  const two = adoptedSteerNotesForSource({ sessionId: row.id, sourceUserSeq: second });
  assert.deepEqual(one.map((n) => n.text), ['Note for the first job.']);
  assert.deepEqual(two.map((n) => n.text), ['Note for the second job.']);
});

test('a repeated client request does not append a duplicate note', () => {
  const row = chat('dedupe');
  const a = appendSteerNote(row.id, 'Same instruction.', { clientRequestId: 'req-1' });
  const b = appendSteerNote(row.id, 'Same instruction.', { clientRequestId: 'req-1' });
  assert.equal(a.seq, b.seq, 'the retry returns the original note');
  assert.equal(
    eventlog.listEvents(row.id, { types: ['user_steer_note'] }).length, 1,
    'exactly one instruction is recorded',
  );
});

test('ADDITIVE steering keeps the original objective intact', () => {
  // "Preserve additive instructions": an amendment must not read as an
  // abandonment of the work in flight.
  const row = chat('additive');
  const src = acceptSource(row.id, 'Draft the quarterly summary.');
  appendSteerNote(row.id, 'Also mention the Q3 renewals.');
  takeUndeliveredSteerNotes(row.id);
  const objective = objectiveWithAdoptedSteering(
    'Draft the quarterly summary.',
    adoptedSteerNotesForSource({ sessionId: row.id, sourceUserSeq: src }),
  );
  assert.match(objective, /Draft the quarterly summary\./);
  assert.match(objective, /Also mention the Q3 renewals\./);
});
