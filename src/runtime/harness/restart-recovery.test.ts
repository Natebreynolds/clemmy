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
  acceptUserInputForRun,
  beginRunAttempt,
  finishRunAttempt,
  getLatestRunAttempt,
  listEvents,
  listExactCheckpointRecoverySessions,
  listSessions,
  openEventLog,
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
const {
  EXACT_CHECKPOINT_REENTRY_BUDGET,
  exactCheckpointReentryKey,
  exactCheckpointReentryExhausted,
  noteExactCheckpointReentry,
  _resetExactCheckpointReentriesForTests,
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

test('late attempt A cannot clear newer attempt B structured recovery ownership', () => {
  const chat = HarnessSession.create({ kind: 'chat', title: 'exact marker race' });
  const attemptA = beginRunAttempt(chat.id, { runId: 'marker-race-A' });
  const sourceA = recordRunAttemptUserInput(attemptA, {
    turn: 1,
    role: 'user',
    data: { text: 'first request' },
  }, { armRunInFlight: true });
  const attemptB = beginRunAttempt(chat.id, { runId: 'marker-race-B' });
  const sourceB = recordRunAttemptUserInput(attemptB, {
    turn: 2,
    role: 'user',
    data: { text: 'newer request' },
  }, { armRunInFlight: true });

  const before = HarnessSession.load(chat.id)?.sessionRow.metadata;
  assert.deepEqual(before?.__run_in_flight_owner, {
    attemptId: attemptB.attemptId,
    sourceUserSeq: sourceB.seq,
    armedAt: (before?.__run_in_flight_owner as { armedAt?: string } | undefined)?.armedAt,
  });
  assert.equal(
    clearRunInFlightAfterTerminal(chat.id, attemptA.attemptId, sourceA.seq),
    false,
    'late A loses the owner CAS',
  );
  assert.deepEqual(
    HarnessSession.load(chat.id)?.sessionRow.metadata.__run_in_flight_owner,
    before?.__run_in_flight_owner,
    'B keeps both its marker and exact owner',
  );

  assert.equal(clearRunInFlightAfterTerminal(chat.id, attemptB.attemptId, sourceB.seq), true);
  const after = HarnessSession.load(chat.id)?.sessionRow.metadata ?? {};
  assert.equal(after.__run_in_flight, undefined);
  assert.equal(after.__run_in_flight_owner, undefined);
  finishRunAttempt(attemptB, 'completed');
});

test('source re-entry preserves the stronger outer attempt owner', () => {
  const chat = HarnessSession.create({ kind: 'chat', title: 'attempt owner re-entry' });
  const attempt = beginRunAttempt(chat.id, { runId: 'attempt-owner-reentry' });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'accepted by the outer bridge' },
  }, { armRunInFlight: true });
  const before = HarnessSession.load(chat.id)?.sessionRow.metadata.__run_in_flight_owner;

  const reused = acceptUserInputForRun({
    sessionId: chat.id,
    turn: source.turn,
    role: source.role,
    data: source.data,
  }, { existingEventSeq: source.seq });

  assert.equal(reused.seq, source.seq);
  assert.deepEqual(
    HarnessSession.load(chat.id)?.sessionRow.metadata.__run_in_flight_owner,
    before,
    'source-only loop acceptance cannot erase attempt identity',
  );
  assert.equal(clearRunInFlightAfterTerminal(chat.id, attempt.attemptId, source.seq), true);
  finishRunAttempt(attempt, 'completed');
});

test('late source-only turn A cannot clear newer source-only turn B recovery ownership', () => {
  const chat = HarnessSession.create({ kind: 'chat', title: 'source marker race' });
  const sourceA = acceptUserInputForRun({
    sessionId: chat.id,
    turn: 1,
    role: 'user',
    data: { text: 'first direct request' },
  });
  const sourceB = acceptUserInputForRun({
    sessionId: chat.id,
    turn: 2,
    role: 'user',
    data: { text: 'newer direct request' },
  });

  const before = HarnessSession.load(chat.id)?.sessionRow.metadata;
  const sourceOnlyOwner = before?.__run_in_flight_owner as {
    sourceUserSeq?: number;
    armedAt?: string;
  } | undefined;
  assert.equal(
    sourceOnlyOwner?.sourceUserSeq,
    sourceB.seq,
  );
  assert.equal(before?.__run_in_flight, sourceOnlyOwner?.armedAt, 'fresh B owns a fresh boot-cutoff timestamp');
  assert.equal(
    clearRunInFlightAfterTerminal(chat.id, undefined, sourceA.seq),
    false,
    'late A loses the source owner CAS',
  );
  assert.deepEqual(
    HarnessSession.load(chat.id)?.sessionRow.metadata.__run_in_flight_owner,
    before?.__run_in_flight_owner,
  );
  assert.equal(clearRunInFlightAfterTerminal(chat.id, undefined, sourceB.seq), true);
  const after = HarnessSession.load(chat.id)?.sessionRow.metadata ?? {};
  assert.equal(after.__run_in_flight, undefined);
  assert.equal(after.__run_in_flight_owner, undefined);
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

test('a corrupt legacy sessions.metadata_json row neither blocks its own updates nor aborts the recovery scans', () => {
  // 8531 class: v72/v73 created idx_sessions_chat_run_in_flight_updated with an
  // unguarded json_type(metadata_json, …) predicate. SQLite evaluates a partial
  // index WHERE on EVERY sessions write, so one malformed legacy row raised
  // SQLITE_ERROR "malformed JSON" on every UPDATE of that row and aborted the
  // per-tick exact-checkpoint scan. v74 recreates the index behind json_valid;
  // the recovery read/clear paths guard the same predicate.
  const corrupt = HarnessSession.create({ kind: 'chat', title: 'corrupt legacy metadata' });
  const interrupted = HarnessSession.create({ kind: 'chat', title: 'healthy interrupted checkpoint' });
  const { source } = armAcceptedInterruptedTurn(interrupted, new Date().toISOString());
  interrupted.saveRecoveryState(JSON.stringify({
    __clemHostRecovery: 1,
    sessionId: interrupted.id,
    sourceUserSeq: source.seq,
    phase: 'admit',
    frameHistory: [],
  }));
  const db = openEventLog();
  db.prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run('{not-json', corrupt.id);

  assert.doesNotThrow(
    () => db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('still writable', corrupt.id),
    'the partial-index predicate must not raise on the corrupt row',
  );
  const runInFlight = listSessions({ kind: 'chat', runInFlightOnly: true, limit: 500 });
  assert.ok(runInFlight.some((row) => row.id === interrupted.id), 'the healthy interrupted chat is still listed');
  assert.ok(!runInFlight.some((row) => row.id === corrupt.id), 'a malformed row is not an in-flight owner');
  const exact = listExactCheckpointRecoverySessions(64);
  assert.ok(exact.some((row) => row.id === interrupted.id), 'the per-tick exact-checkpoint scan survives the corrupt row');
  assert.ok(!exact.some((row) => row.id === corrupt.id));
  assert.equal(clearRunInFlightAfterTerminal(corrupt.id), false, 'a corrupt row is not an owner to clear');
  assert.equal(clearRunInFlightAfterTerminal(corrupt.id, 'attempt-x', 1), false);
  assert.doesNotThrow(() => recoverInterruptedChatRuns(() => Date.now(), undefined, { exactCheckpointsOnly: true }));
  assert.doesNotThrow(() => reportInterruptedChatRuns(() => Date.now()));
  assert.equal(
    (db.prepare('SELECT metadata_json FROM sessions WHERE id = ?').get(corrupt.id) as { metadata_json: string }).metadata_json,
    '{not-json',
    'malformed legacy bytes stay untouched',
  );
  // Exact checkpoints are preserved by both scans above (no dispatcher), so
  // release this fixture's marker: later tests in this shared home count
  // interrupted chats by construction. The corrupt row deliberately stays.
  const healthy = HarnessSession.load(interrupted.id)!;
  healthy.clearRecoveryState();
  healthy.clearRunInFlight();
  assert.equal(HarnessSession.load(interrupted.id)?.runInFlightSince(), null);
});

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
    async (restart) => { dispatched.push(restart.sessionId); },
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
    async (restart) => {
      dispatched.push({
        sessionId: restart.sessionId,
        sourceUserSeq: restart.sourceUserSeq,
      });
    },
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
    async (restart) => {
      dispatched.push({
        sessionId: restart.sessionId,
        sourceUserSeq: restart.sourceUserSeq,
      });
    },
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

test('exact-checkpoint re-entry budget: the same checkpoint is dispatched a bounded number of times; progress (a new frame) starts fresh', () => {
  // 2026-09-01: 1,006 re-entries in 90 minutes on one checkpoint, no exit.
  _resetExactCheckpointReentriesForTests();
  const key = exactCheckpointReentryKey('chat-1', { sourceUserSeq: 7, phase: 'admit', frameCallIds: ['c1', 'c2'] });
  assert.equal(key, 'chat-1:7:admit:c1|c2');
  assert.equal(exactCheckpointReentryExhausted(key), false);
  for (let i = 1; i < EXACT_CHECKPOINT_REENTRY_BUDGET; i += 1) {
    assert.deepEqual(noteExactCheckpointReentry(key), { count: i, exhausted: false });
    assert.equal(exactCheckpointReentryExhausted(key), false, `attempt ${i} is still within budget`);
  }
  assert.deepEqual(noteExactCheckpointReentry(key), { count: EXACT_CHECKPOINT_REENTRY_BUDGET, exhausted: true });
  assert.equal(exactCheckpointReentryExhausted(key), true);
  const progressed = exactCheckpointReentryKey('chat-1', { sourceUserSeq: 7, phase: 'finalize', frameCallIds: ['c1', 'c2'] });
  assert.equal(exactCheckpointReentryExhausted(progressed), false, 'a new checkpoint is a new count');
  _resetExactCheckpointReentriesForTests();
  assert.equal(exactCheckpointReentryExhausted(key), false, 'a restart starts over');
});
