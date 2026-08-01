/**
 * Run: npx tsx --test src/runtime/harness/restart-recovery.test.ts
 *
 * Restart recovery (#3): a chat run killed mid-flight leaves an in-flight marker
 * that survives the restart; on boot we surface an exact typed continue outcome
 * when a user must resume it, while automatic recovery remains nonterminal.
 * Cleanly-finished runs (no marker) and non-chat sessions are never touched.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-restart-rec-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });
writeFileSync(path.join(TMP, 'state', 'machine-id'), 'machine-A\n');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { HarnessSession } = await import('./session.js');
const {
  beginRunAttempt,
  finishRunAttempt,
  getLatestRunAttempt,
  listEvents,
  recordRunAttemptUserInput,
} = await import('./eventlog.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const {
  clearRunInFlightAfterTerminal,
  reportInterruptedChatRuns,
  recoverInterruptedChatRuns,
  markRunInFlight,
  restartRecoveryPrimerPrefixForTests,
} = await import('./restart-recovery.js');

test('exported markRunInFlight: arms + clears a CHAT session, skips non-chat, respects the kill-switch', () => {
  const chat = HarnessSession.create({ kind: 'chat', title: 'c' });
  markRunInFlight(chat.id, true);
  assert.notEqual(HarnessSession.load(chat.id)?.runInFlightSince(), null, 'chat session is armed');
  markRunInFlight(chat.id, false);
  assert.equal(HarnessSession.load(chat.id)?.runInFlightSince(), null, 'chat session is cleared');

  // Non-chat sessions are never marked (workflow/agent have their own resume).
  const wf = HarnessSession.create({ kind: 'workflow', title: 'w' });
  markRunInFlight(wf.id, true);
  assert.equal(HarnessSession.load(wf.id)?.runInFlightSince(), null, 'non-chat session is never armed');

  // Kill-switch fully disables it.
  const prev = process.env.CLEMMY_CHAT_RESTART_RECOVERY;
  process.env.CLEMMY_CHAT_RESTART_RECOVERY = 'off';
  try {
    const c2 = HarnessSession.create({ kind: 'chat', title: 'c2' });
    markRunInFlight(c2.id, true);
    assert.equal(HarnessSession.load(c2.id)?.runInFlightSince(), null, 'kill-switch off → never armed');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CHAT_RESTART_RECOVERY; else process.env.CLEMMY_CHAT_RESTART_RECOVERY = prev;
  }
});

test('terminal marker clear refuses to steal ownership from a foreign active attempt', () => {
  const chat = HarnessSession.create({ kind: 'chat', title: 'shared marker' });
  const active = beginRunAttempt(chat.id, { runId: 'shared-marker-owner' });
  markRunInFlight(chat.id, true);

  assert.equal(clearRunInFlightAfterTerminal(chat.id), false, 'an unowned direct clear cannot cross an active attempt');
  assert.ok(HarnessSession.load(chat.id)?.runInFlightSince());
  assert.equal(
    clearRunInFlightAfterTerminal(chat.id, 'attempt:some-other-run'),
    false,
    'a different physical attempt cannot settle the shared marker',
  );
  assert.ok(HarnessSession.load(chat.id)?.runInFlightSince());
  assert.equal(clearRunInFlightAfterTerminal(chat.id, active.attemptId), true);
  assert.equal(HarnessSession.load(chat.id)?.runInFlightSince(), null);
  finishRunAttempt(active, 'completed');
});

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

function hasInterruptedEvent(sessionId: string): boolean {
  return listEvents(sessionId, { limit: 50 }).some(
    (e) => e.type === 'conversation_completed'
      && (e.data as { reason?: string } | undefined)?.reason === 'interrupted_by_restart',
  );
}

function armAcceptedInterruptedTurn(
  session: InstanceType<typeof HarnessSession>,
  since = '2026-06-07T00:00:00.000Z',
): {
  attempt: ReturnType<typeof beginRunAttempt>;
  source: ReturnType<typeof recordRunAttemptUserInput>;
} {
  const attempt = beginRunAttempt(session.id, { runId: `restart-recovery-test:${session.id}` });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Finish the interrupted task.' },
  });
  session.setRunInFlight(since);
  return { attempt, source };
}

test('marker round-trip: set then clear', () => {
  const s = HarnessSession.create({ kind: 'chat', title: 't' });
  assert.equal(s.runInFlightSince(), null);
  s.setRunInFlight('2026-06-07T00:00:00.000Z');
  assert.equal(HarnessSession.load(s.id)?.runInFlightSince(), '2026-06-07T00:00:00.000Z');
  HarnessSession.load(s.id)!.clearRunInFlight();
  assert.equal(HarnessSession.load(s.id)?.runInFlightSince(), null);
});

test('surfaces ONLY interrupted chat runs; leaves clean + non-chat sessions alone', () => {
  const interrupted = HarnessSession.create({ kind: 'chat', title: 'long task' });
  armAcceptedInterruptedTurn(interrupted);
  const clean = HarnessSession.create({ kind: 'chat', title: 'finished task' }); // no marker
  const wf = HarnessSession.create({ kind: 'workflow', title: 'wf' }); // wrong kind — never scanned

  const recovered = reportInterruptedChatRuns(() => 1000);
  assert.equal(recovered, 1, 'exactly the one marked chat run is recovered');

  // marker cleared on the recovered run
  assert.equal(HarnessSession.load(interrupted.id)?.runInFlightSince(), null);
  // non-silent notice emitted on the interrupted run
  assert.ok(hasInterruptedEvent(interrupted.id), 'interrupted run got a non-silent notice');
  // clean + workflow sessions untouched
  assert.ok(!hasInterruptedEvent(clean.id), 'a clean run is never flagged');
  assert.ok(!hasInterruptedEvent(wf.id), 'a non-chat session is never flagged');
});

test('an identity-less legacy marker records pause state without inventing a public terminal', () => {
  const legacy = HarnessSession.create({ kind: 'chat', title: 'pre-attempt legacy chat' });
  legacy.setRunInFlight('2026-06-07T00:00:00.000Z');

  const summary = recoverInterruptedChatRuns(() => 1100);

  assert.equal(summary.recovered, 1);
  assert.equal(listEvents(legacy.id, { types: ['conversation_completed'] }).length, 0);
  const paused = listEvents(legacy.id, { types: ['run_paused'] });
  assert.equal(paused.length, 1);
  assert.equal(paused[0].data.reason, 'restart_recovery_identity_missing');
  assert.equal(HarnessSession.load(legacy.id)?.runInFlightSince(), null);
});

test('structured recovery prepares a durable replay primer in the harness snapshot', () => {
  const interrupted = HarnessSession.create({ kind: 'chat', title: 'recoverable long task' });
  interrupted.updateConversationSnapshot([{ role: 'user', content: 'Research the market and build the report.' }]);
  armAcceptedInterruptedTurn(interrupted);

  const summary = recoverInterruptedChatRuns(() => 1234);
  assert.equal(summary.enabled, true);
  assert.equal(summary.recovered, 1);
  assert.equal(summary.notified, 1);
  assert.equal(summary.records.length, 1);
  const record = summary.records[0];
  assert.equal(record.sessionId, interrupted.id);
  assert.equal(record.replayPrepared, true);
  assert.equal(record.snapshotItemsBefore, 1);
  assert.equal(record.snapshotItemsAfter, 2);
  assert.equal(record.markerCleared, true);

  const items = HarnessSession.load(interrupted.id)!.toInputItems();
  assert.ok(items.some((it) => {
    const content = (it as { content?: unknown }).content;
    return typeof content === 'string'
      && content.startsWith(restartRecoveryPrimerPrefixForTests())
      && content.includes('continue');
  }), 'restart primer is durably replayed on the next turn');

  const notice = listEvents(interrupted.id, { types: ['conversation_completed'] }).at(-1);
  assert.equal(notice?.data.presentation && (notice.data.presentation as { status?: string }).status, 'needs_input');
  assert.equal(notice?.data.presentation && (notice.data.presentation as { kind?: string }).kind, 'continue');
  const decision = listEvents(interrupted.id, { types: ['restart_recovery_decision'] }).at(-1);
  assert.equal(decision?.data.replayPrepared, true);
  assert.equal(decision?.data.snapshotItemsAfter, 2);
});

test('boot scan finds an interrupted chat behind newer session pages', () => {
  const interrupted = HarnessSession.create({ kind: 'chat', title: 'older interrupted task' });
  armAcceptedInterruptedTurn(interrupted);

  for (let i = 0; i < 125; i += 1) {
    HarnessSession.create({ kind: 'chat', title: `newer clean chat ${i}` });
  }

  const recovered = reportInterruptedChatRuns(() => 1500);
  assert.equal(recovered, 1, 'older interrupted chat behind the default first page is recovered');
  assert.equal(HarnessSession.load(interrupted.id)?.runInFlightSince(), null);
  assert.ok(hasInterruptedEvent(interrupted.id), 'older interrupted chat got a non-silent restart notice');
});

test('idempotent: a second boot scan finds nothing (marker already cleared)', () => {
  const s = HarnessSession.create({ kind: 'chat', title: 'x' });
  armAcceptedInterruptedTurn(s);
  assert.equal(reportInterruptedChatRuns(() => 2000), 1);
  assert.equal(reportInterruptedChatRuns(() => 2001), 0, 'no double-recovery');
});

test('commit then crash before marker clear reconciles the exact terminal without dispatch or notice', async () => {
  const nowMs = Date.parse('2026-07-10T19:14:46.000Z');
  const since = '2026-07-10T19:13:46.000Z';
  const session = HarnessSession.create({ kind: 'chat', title: 'terminal committed before crash' });
  const { attempt, source } = armAcceptedInterruptedTurn(session, since);
  const identity = {
    sessionId: session.id,
    turn: source.turn,
    attemptId: attempt.attemptId,
    runId: attempt.runId ?? undefined,
    sourceUserSeq: source.seq,
  };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'The task finished before the restart.' },
  });
  // Deliberately omit finishRunAttempt() and clearRunInFlight(): this is the
  // exact crash window the boot reconciler must close without replaying work.
  const dispatched: string[] = [];

  const summary = recoverInterruptedChatRuns(
    () => nowMs,
    async (sessionId) => { dispatched.push(sessionId); },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(summary.recovered, 1);
  assert.equal(summary.notified, 0);
  assert.deepEqual(dispatched, [], 'an already-terminal turn is never dispatched again');
  assert.equal(summary.records[0]?.terminalReconciled, true);
  assert.equal(summary.records[0]?.autoResumed, false);
  assert.equal(summary.records[0]?.noticeRecorded, false);
  assert.equal(summary.records[0]?.markerCleared, true);
  assert.equal(HarnessSession.load(session.id)?.runInFlightSince(), null);
  assert.equal(getLatestRunAttempt(session.id)?.status, 'completed');
  assert.equal(listEvents(session.id, { types: ['conversation_completed'] }).length, 1);
  assert.equal(listEvents(session.id, { types: ['run_resumed', 'run_paused'] }).length, 0);
  assert.equal(
    listEvents(session.id, { types: ['restart_recovery_decision'] }).at(-1)?.data.phase,
    'terminal_reconciled',
  );
  assert.equal(
    HarnessSession.load(session.id)?.toInputItems().some((item) => {
      const content = (item as { content?: unknown }).content;
      return typeof content === 'string' && content.startsWith(restartRecoveryPrimerPrefixForTests());
    }),
    false,
    'reconciliation does not inject a continuation primer',
  );
});

test('a terminal from another source with the same run id cannot settle the interrupted turn', async () => {
  const nowMs = Date.parse('2026-07-10T19:14:46.000Z');
  const session = HarnessSession.create({ kind: 'chat', title: 'reused run identity' });
  const sharedRunId = `restart-recovery-shared:${session.id}`;
  const oldAttempt = beginRunAttempt(session.id, { runId: sharedRunId });
  const oldSource = recordRunAttemptUserInput(oldAttempt, {
    turn: 1,
    role: 'user',
    data: { text: 'First logical turn.' },
  });
  const oldIdentity = {
    sessionId: session.id,
    turn: oldSource.turn,
    attemptId: oldAttempt.attemptId,
    runId: sharedRunId,
    sourceUserSeq: oldSource.seq,
  };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(oldIdentity),
    identity: oldIdentity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'The first logical turn is complete.' },
  });
  finishRunAttempt(oldAttempt, 'completed');

  const interruptedAttempt = beginRunAttempt(session.id, { runId: sharedRunId });
  const interruptedSource = recordRunAttemptUserInput(interruptedAttempt, {
    turn: 2,
    role: 'user',
    data: { text: 'Second logical turn.' },
  });
  session.setRunInFlight('2026-07-10T19:13:46.000Z');
  const dispatched: Array<{ sessionId: string; sourceUserSeq: number }> = [];

  const summary = recoverInterruptedChatRuns(
    () => nowMs,
    async (sessionId, _directive, sourceUserSeq) => { dispatched.push({ sessionId, sourceUserSeq }); },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.notEqual(interruptedAttempt.attemptId, oldAttempt.attemptId);
  assert.notEqual(interruptedSource.seq, oldSource.seq);
  assert.equal(summary.records[0]?.terminalReconciled, false);
  assert.equal(summary.records[0]?.autoResumed, true);
  assert.deepEqual(
    dispatched,
    [{ sessionId: session.id, sourceUserSeq: interruptedSource.seq }],
    'the distinct interrupted source follows normal recovery with exact binding',
  );
  assert.equal(listEvents(session.id, { types: ['conversation_completed'] }).length, 1);
  assert.equal(listEvents(session.id, { types: ['run_resumed'] }).length, 1);
  assert.notEqual(
    HarnessSession.load(session.id)?.runInFlightSince(),
    null,
    'the fake dispatcher did not commit a terminal, so recovery ownership stays armed',
  );
});

test('boot cutoff recovers only markers owned by the previous daemon process', async () => {
  const bootCutoffMs = Date.parse('2026-07-10T19:11:47.000Z');
  const scanNowMs = Date.parse('2026-07-10T19:14:46.000Z');
  const previousProcess = HarnessSession.create({ kind: 'chat', title: 'pre-boot work' });
  armAcceptedInterruptedTurn(previousProcess, '2026-07-10T19:11:46.999Z');
  const liveProcess = HarnessSession.create({ kind: 'chat', title: 'live work' });
  liveProcess.setRunInFlight('2026-07-10T19:14:38.000Z');
  const equalCutoff = HarnessSession.create({ kind: 'chat', title: 'ambiguous boundary' });
  equalCutoff.setRunInFlight('2026-07-10T19:11:47.000Z');
  const malformed = HarnessSession.create({ kind: 'chat', title: 'malformed marker' });
  malformed.setRunInFlight('not-a-timestamp');
  const dispatched: Array<{ sessionId: string; sourceUserSeq: number }> = [];

  const summary = recoverInterruptedChatRuns(
    () => scanNowMs,
    async (sessionId, _directive, sourceUserSeq) => { dispatched.push({ sessionId, sourceUserSeq }); },
    { bootCutoffMs },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(summary.recovered, 1);
  assert.deepEqual(dispatched, [{
    sessionId: previousProcess.id,
    sourceUserSeq: getLatestRunAttempt(previousProcess.id)?.sourceUserSeq ?? -1,
  }]);
  assert.notEqual(
    HarnessSession.load(previousProcess.id)?.runInFlightSince(),
    null,
    'a fake dispatcher with no terminal cannot clear the previous process marker',
  );
  assert.equal(hasInterruptedEvent(previousProcess.id), false, 'automatic resume does not create a false terminal');
  assert.equal(listEvents(previousProcess.id, { types: ['run_resumed'] }).length, 1);

  for (const session of [liveProcess, equalCutoff, malformed]) {
    assert.notEqual(HarnessSession.load(session.id)?.runInFlightSince(), null, `${session.title} marker remains armed`);
    assert.equal(hasInterruptedEvent(session.id), false, `${session.title} receives no false restart notice`);
    assert.equal(
      listEvents(session.id, { types: ['restart_recovery_decision'] }).length,
      0,
      `${session.title} receives no restart decision`,
    );
    assert.equal(
      HarnessSession.load(session.id)?.toInputItems().some((item) => {
        const content = (item as { content?: unknown }).content;
        return typeof content === 'string' && content.startsWith(restartRecoveryPrimerPrefixForTests());
      }),
      false,
      `${session.title} receives no replay primer`,
    );
  }
});

test('kill-switch off → no-op (marker preserved, nothing surfaced)', () => {
  const prev = process.env.CLEMMY_CHAT_RESTART_RECOVERY;
  const s = HarnessSession.create({ kind: 'chat', title: 'y' });
  s.setRunInFlight('2026-06-07T00:00:00.000Z');
  try {
    process.env.CLEMMY_CHAT_RESTART_RECOVERY = 'off';
    assert.equal(reportInterruptedChatRuns(() => 3000), 0);
    assert.equal(HarnessSession.load(s.id)?.runInFlightSince(), '2026-06-07T00:00:00.000Z', 'marker untouched when disabled');
    assert.ok(!hasInterruptedEvent(s.id));
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CHAT_RESTART_RECOVERY;
    else process.env.CLEMMY_CHAT_RESTART_RECOVERY = prev;
  }
});
