/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/restart-recovery-stale-markers.test.ts
 *
 * A stale interrupted chat run is settled exactly once. Each fixture below
 * rebuilds one marker shape found in a long-lived home with the production
 * producers (accepted inputs, physical attempts, typed terminals, the
 * workflow queue and the orphan reaper), then drives the real boot path.
 *
 * Three ways a marker used to survive every boot:
 *  - The marker names a later accepted source that ran without a physical
 *    attempt (a background report-back or an approval resume). Recovery took
 *    its identity from the session's newest attempt, found that OLDER turn's
 *    terminal, and the owner compare-and-swap then refused to clear a marker
 *    that names a different source.
 *  - The marker names an earlier physical attempt of the same source; a retry
 *    ran as a new attempt and never took the marker over. The source already
 *    has its terminal, but cleanup named the newest attempt and lost the CAS.
 *  - A prepared workflow dispatch was admitted, then its run was cancelled as
 *    an orphan. The source group still counted as pending, so recovery kept
 *    the marker and promised a resume nothing could perform.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { RestartResumeDispatch } from './restart-recovery.js';
import type { EventRow } from './eventlog.js';
import type { TurnOutcome } from './turn-outcome.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-stale-markers-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'stale-markers\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId, presentationEventFromCompletionData } = await import('./turn-outcome.js');
const {
  recoverInterruptedChatRuns,
  reportInterruptedChatRuns,
  restartRecoveryPrimerPrefixForTests,
} = await import('./restart-recovery.js');
const queue = await import('../../tools/workflow-run-queue.js');
const { WORKFLOW_RUNS_DIR } = await import('../../tools/shared.js');
const { cancelWorkflowRunAtBoundary } = await import('../../execution/workflow-run-cancellation.js');
const { writeWorkflow } = await import('../../memory/workflow-store.js');
const { exactOriginDeliveryTargetDigest } = await import('../exact-origin-delivery.js');

after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60_000;
const T0 = Date.now();
const ORIGIN = { type: 'origin_chat' } as const;
const originData = () => ({
  originReplyTarget: ORIGIN,
  originReplyTargetDigest: exactOriginDeliveryTargetDigest(ORIGIN),
});

const dispatched: RestartResumeDispatch[] = [];
async function recordDispatch(restart: RestartResumeDispatch): Promise<void> {
  dispatched.push(restart);
}

/** The daemon boot steps that bear on a stale chat marker, in boot order:
 * previous-process attempts are interrupted, orphaned prepared workflow runs
 * are reaped, then interrupted chats are recovered. */
function boot(nowMs: number) {
  eventlog.interruptOrphanedRunAttemptsAtBoot(nowMs);
  queue.reapOrphanedWorkflowChatDispatches((input) => cancelWorkflowRunAtBoundary(input));
  return recoverInterruptedChatRuns(() => nowMs, recordDispatch, { bootCutoffMs: nowMs - 60_000 });
}

function sessionRow(sessionId: string) {
  const row = eventlog.getSession(sessionId);
  assert.ok(row, `session ${sessionId} exists`);
  return row;
}

function markerSince(sessionId: string): string | null {
  return HarnessSession.load(sessionId)?.runInFlightSince() ?? null;
}

function ownerJsonType(sessionId: string): string | null {
  const row = eventlog.openEventLog().prepare(
    "SELECT json_type(metadata_json, '$.__run_in_flight_owner.sourceUserSeq') AS type FROM sessions WHERE id = ?",
  ).get(sessionId) as { type: string | null } | undefined;
  return row?.type ?? null;
}

/** Older builds wrote the owner with plain JSON integers; the current arm
 * path binds through SQLite and stores the same number as a REAL. */
function rewriteOwner(sessionId: string, owner: Record<string, unknown>): void {
  eventlog.openEventLog().prepare(
    "UPDATE sessions SET metadata_json = json_set(metadata_json, '$.__run_in_flight_owner', json(?)) WHERE id = ?",
  ).run(JSON.stringify(owner), sessionId);
}

function terminalsFor(sessionId: string, sourceUserSeq: number): EventRow[] {
  return eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).filter((event) =>
    presentationEventFromCompletionData(event.data)?.identity.sourceUserSeq === sourceUserSeq);
}

function commitTerminal(
  source: EventRow,
  outcome: Record<string, unknown>,
  legacyReason: string,
): void {
  const identity = { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.seq };
  commitTurnOutcome(
    { version: 2, id: turnOutcomeId(identity), identity, ...outcome } as TurnOutcome,
    { legacyReason, metadata: { steps: 1 } },
  );
}

const CONTINUE_OUTCOME = {
  status: 'needs_input',
  resumable: true,
  needs: { kind: 'continue' },
  presentation: {
    kind: 'continue',
    text: 'This run was interrupted by a restart before it finished. Reply `continue` to pick up where it left off.',
  },
};

/** What an earlier boot recorded after committing that terminal. */
function recordEarlierReconcile(sessionId: string, source: EventRow, attemptId: string): void {
  const since = markerSince(sessionId);
  assert.ok(since);
  const terminal = terminalsFor(sessionId, source.seq)[0];
  assert.ok(terminal);
  eventlog.appendEvent({
    sessionId,
    turn: 0,
    role: 'system',
    type: 'restart_recovery_decision',
    data: {
      phase: 'terminal_reconciled',
      interruptedAt: since,
      interruptedAttemptId: attemptId,
      sourceUserSeq: source.seq,
      terminalEventSeq: terminal.seq,
      autoResume: false,
    },
  });
}

// ── Shape A: the marker names a later source that ran without an attempt ──

function backgroundReportBackInterrupted(label: string, status: 'blocked' | 'done') {
  const session = HarnessSession.create({ id: `sess-desktop-stale-bg-${label}`, kind: 'chat', title: `report back ${label}` });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `desktop:stale-bg-${label}` });
  const request = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Read this document end to end and draft a research plan.', ...originData() },
  }, { armRunInFlight: true });
  commitTerminal(request, {
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'Started that as a background task.' },
  }, 'queued_background');
  eventlog.finishRunAttempt(attempt, 'completed');
  // Background report-backs are accepted through the direct path: no
  // physical attempt, a source-only marker owner.
  const reportBack = (text: string) => eventlog.acceptUserInputForRun({
    sessionId: session.id,
    turn: 0,
    role: 'user',
    data: {
      text,
      synthetic: true,
      source: 'outcome',
      sourceLabel: 'background task',
      sourceId: `bg-${label}`,
      status,
      deliveryPhase: 'directive',
    },
  });
  reportBack(`[background task bg-${label} ${status}] Read this document end to end.`);
  const source = reportBack('A background task you started from this conversation finished (see the latest result).');
  // The process died before that report-back turn published anything. An
  // earlier boot then reconciled the OLDER source's terminal instead.
  recordEarlierReconcile(session.id, request, attempt.attemptId);
  return { sessionId: session.id, olderSource: request, source };
}

function approvalResumeInterrupted(label: string, approvalIds: string[], turn: number) {
  const session = HarnessSession.create({ id: `sess-desktop-stale-approval-${label}`, kind: 'chat', title: `approval ${label}` });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `desktop:stale-approval-${label}` });
  const request = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Execute this reviewed plan to completion.', ...originData() },
  }, { armRunInFlight: true });
  commitTerminal(request, {
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'approval' },
    presentation: {
      kind: 'approval',
      text: `Approval required. Review ${approvalIds[0]} to continue.`,
      approvalId: approvalIds[0],
    },
  }, 'awaiting_approval');
  eventlog.finishRunAttempt(attempt, 'completed');
  let source: EventRow | undefined;
  for (const approvalId of approvalIds) {
    source = eventlog.acceptUserInputForRun({
      sessionId: session.id,
      turn,
      role: 'user',
      data: {
        text: `Approve ${approvalId}.`,
        displayText: `Approve ${approvalId}`,
        synthetic: true,
        source: 'approval_resume',
        decision: 'approve',
        approvalId,
      },
    });
  }
  assert.ok(source);
  recordEarlierReconcile(session.id, request, attempt.attemptId);
  return { sessionId: session.id, olderSource: request, source };
}

// ── Shape B: the marker names an earlier attempt of the same source ──

function retriedSourceInterrupted(
  label: string,
  options: { runId?: string; integerOwner: boolean; terminal: Record<string, unknown>; legacyReason: string },
) {
  const session = HarnessSession.create({ id: `sess-desktop-stale-retry-${label}`, kind: 'chat', title: `retry ${label}` });
  const first = eventlog.beginRunAttempt(session.id, options.runId ? { runId: options.runId } : {});
  const source = eventlog.recordRunAttemptUserInput(first, {
    turn: 1,
    role: 'user',
    data: { text: 'Execute the reviewed plan, revision 1.', ...originData() },
  }, { armRunInFlight: true });
  const armedAt = markerSince(session.id);
  assert.ok(armedAt);
  if (options.integerOwner) {
    rewriteOwner(session.id, { attemptId: first.attemptId, sourceUserSeq: source.seq, armedAt });
  }
  // The first physical attempt settles without the turn's answer; a retry
  // of the same accepted source runs as a new attempt and binds the source
  // without taking the marker over.
  eventlog.finishRunAttempt(first, 'completed');
  const retry = eventlog.beginRunAttempt(session.id, options.runId ? { runId: options.runId } : {});
  eventlog.recordRunAttemptUserInput(retry, { turn: 1, role: 'user', data: {} }, {
    existingEventSeq: source.seq,
    armRunInFlight: true,
  });
  assert.notEqual(retry.attemptId, first.attemptId);
  // A restart interrupts the retry; that boot's recovery publishes the
  // source's terminal. The terminal's own marker CAS names the retry, so the
  // marker survives it.
  eventlog.interruptOrphanedRunAttemptsAtBoot(T0 + 60_000);
  commitTerminal(source, options.terminal, options.legacyReason);
  assert.equal(terminalsFor(session.id, source.seq).length, 1);
  assert.ok(markerSince(session.id), 'fixture: the terminal left the marker armed');
  recordEarlierReconcile(session.id, source, retry.attemptId);
  return { sessionId: session.id, source, first, retry };
}

// ── Shape C: a prepared workflow dispatch whose run was reaped ──

function writeManualWorkflow(name: string): void {
  writeWorkflow(name, {
    name,
    description: 'A bounded restart ownership fixture.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'work', prompt: 'Perform the admitted read-only work.', sideEffect: 'read' }],
  });
}

function preparedWorkflowInterrupted(label: string, workflow: string) {
  const session = HarnessSession.create({
    id: `console:wf-stale-${label}`,
    kind: 'chat',
    channel: 'desktop',
    title: `wf ${label}`,
  });
  const first = eventlog.beginRunAttempt(session.id, { runId: `run-home-stale-${label}` });
  const source = eventlog.recordRunAttemptUserInput(first, {
    turn: 1,
    role: 'user',
    data: { text: `run the workflow named ${workflow}`, source: 'bridge:home', ...originData() },
  }, { armRunInFlight: true });
  const armedAt = markerSince(session.id);
  assert.ok(armedAt);
  rewriteOwner(session.id, { attemptId: first.attemptId, sourceUserSeq: source.seq, armedAt });
  const queued = queue.queueWorkflowRun(workflow, {}, {
    originSessionId: session.id,
    originObserver: { sessionId: session.id, sourceUserSeq: source.seq, replyTarget: ORIGIN },
    prepareChatDispatch: (authority) => {
      const prepared = eventlog.appendEvent({
        sessionId: session.id,
        turn: source.turn,
        role: 'system',
        type: 'async_work_dispatch_prepared',
        parentEventId: source.id,
        data: { ...authority },
      });
      return queue.recordWorkflowChatDispatchPreparation(
        queue.createWorkflowChatDispatchPreparedReceipt(authority, {
          eventId: prepared.id,
          eventSeq: prepared.seq,
          preparedAt: prepared.createdAt,
        }),
      );
    },
  });
  assert.ok(queued.id);
  // An earlier boot re-dispatched the same accepted source as a new attempt
  // that did not take the marker over.
  eventlog.interruptOrphanedRunAttemptsAtBoot(T0 + 60_000);
  const retry = eventlog.beginRunAttempt(session.id);
  eventlog.recordRunAttemptUserInput(retry, { turn: 1, role: 'user', data: {} }, {
    existingEventSeq: source.seq,
  });
  eventlog.interruptOrphanedRunAttemptsAtBoot(T0 + 120_000);
  return { sessionId: session.id, source, first, retry, runId: queued.id };
}

function runStatus(runId: string): string {
  return (JSON.parse(
    readFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), 'utf8'),
  ) as { status: string }).status;
}

test('the cohort of stale shapes settles on one boot, and the next boot finds none', async () => {
  writeManualWorkflow('stale-briefing');
  writeManualWorkflow('stale-review');
  // Shape C: two chats admitted to one run (the second attached to the
  // first's live run), and a third with its own run.
  const planner = preparedWorkflowInterrupted('planner', 'stale-briefing');
  const briefing = preparedWorkflowInterrupted('briefing', 'stale-briefing');
  const review = preparedWorkflowInterrupted('review', 'stale-review');
  assert.equal(briefing.runId, planner.runId, 'fixture: the second chat shares the first chat\'s run');
  // An earlier boot saw the dispatch still held and told the owner once.
  const earlier = recoverInterruptedChatRuns(() => T0 + DAY, recordDispatch, {
    bootCutoffMs: T0 + DAY - 60_000,
  });
  for (const fixture of [planner, briefing, review]) {
    const record = earlier.records.find((row) => row.sessionId === fixture.sessionId);
    assert.equal(record?.preparedDispatchOwnershipPreserved, true, 'fixture: the held dispatch owned the source');
    assert.equal(record?.notified, true);
  }

  // Shape B: an earlier attempt of the same source owns the marker, the
  // source's terminal already exists. One owner stored as a REAL.
  const retriedDesktop = retriedSourceInterrupted('desktop', {
    runId: 'desktop:stale-retry-desktop',
    integerOwner: true,
    terminal: CONTINUE_OUTCOME,
    legacyReason: 'interrupted_by_restart',
  });
  const retriedBlocked = retriedSourceInterrupted('blocked', {
    runId: 'desktop:stale-retry-blocked',
    integerOwner: true,
    terminal: {
      status: 'blocked',
      resumable: true,
      presentation: { kind: 'blocked', text: 'The planning catalog was unavailable.' },
    },
    legacyReason: 'planning_catalog_unavailable',
  });
  const retriedGenerated = retriedSourceInterrupted('generated', {
    integerOwner: true,
    terminal: CONTINUE_OUTCOME,
    legacyReason: 'interrupted_by_restart',
  });
  const retriedReal = retriedSourceInterrupted('real', {
    runId: 'desktop:stale-retry-real',
    integerOwner: false,
    terminal: {
      ...CONTINUE_OUTCOME,
      presentation: {
        kind: 'continue',
        text: 'This run kept stopping at the same point, so I stopped retrying it. Reply `continue` and I will take it from here fresh.',
      },
    },
    legacyReason: 'recovery_window_exhausted',
  });
  assert.equal(ownerJsonType(retriedReal.sessionId), 'real', 'fixture: the arm path stores the owner source as a REAL');
  assert.equal(ownerJsonType(retriedDesktop.sessionId), 'integer');

  // Shape A: report-backs and approval resumes that ran without an attempt.
  const reportBlocked = backgroundReportBackInterrupted('blocked', 'blocked');
  const reportDone = backgroundReportBackInterrupted('done', 'done');
  const approval = approvalResumeInterrupted('single', ['apr-stale1'], 5);
  const approvals = approvalResumeInterrupted('several', ['apr-stale2', 'apr-stale3', 'apr-stale4', 'apr-stale5'], 3);

  const shapeA = [reportBlocked, reportDone, approval, approvals];
  const shapeB = [retriedDesktop, retriedBlocked, retriedGenerated, retriedReal];
  const shapeC = [planner, briefing, review];
  const all = [...shapeC, ...shapeB, ...shapeA];
  const updatedBefore = new Map(all.map((fixture) => [fixture.sessionId, sessionRow(fixture.sessionId).updatedAt]));
  const terminalCountsBefore = new Map(all.map((fixture) => [
    fixture.sessionId,
    eventlog.listEvents(fixture.sessionId, { types: ['conversation_completed'] }).length,
  ]));
  for (const fixture of all) assert.ok(markerSince(fixture.sessionId), `${fixture.sessionId} starts armed`);

  const settleAt = T0 + 14 * DAY;
  const first = boot(settleAt);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(first.recovered, 11, 'every stale marker is settled on this boot');
  assert.deepEqual(dispatched, [], 'nothing this old is replayed');
  const recordFor = (sessionId: string) => {
    const record = first.records.find((row) => row.sessionId === sessionId);
    assert.ok(record, `${sessionId} was scanned`);
    return record;
  };
  for (const fixture of all) {
    assert.equal(markerSince(fixture.sessionId), null, `${fixture.sessionId} marker cleared`);
    assert.equal(recordFor(fixture.sessionId).markerCleared, true);
    assert.deepEqual(recordFor(fixture.sessionId).errors, []);
  }

  // Shape A: the marker's own source gets the resumable terminal; the older
  // source keeps exactly its original terminal.
  for (const fixture of shapeA) {
    const record = recordFor(fixture.sessionId);
    assert.equal(record.markerOwnerSourceUserSeq, fixture.source.seq);
    assert.equal(record.terminalReconciled, false);
    assert.equal(record.autoResumeSkipped, 'too_old');
    const settled = terminalsFor(fixture.sessionId, fixture.source.seq);
    assert.equal(settled.length, 1, 'the interrupted source is settled once');
    const presentation = presentationEventFromCompletionData(settled[0]!.data);
    assert.equal(presentation?.status, 'needs_input');
    assert.equal(presentation?.kind, 'continue', 'the owner can still say continue');
    assert.equal(presentation?.identity.turn, fixture.source.turn);
    assert.equal(terminalsFor(fixture.sessionId, fixture.olderSource.seq).length, 1);
    assert.equal(record.notified, true, 'an interruption nobody was told about is announced once');
  }

  // Shape B: nothing new is published; only the marker is retired, and the
  // conversation does not jump to the top of the list for bookkeeping.
  for (const fixture of shapeB) {
    const record = recordFor(fixture.sessionId);
    assert.equal(record.terminalReconciled, true);
    assert.equal(record.notified, false);
    assert.equal(
      eventlog.listEvents(fixture.sessionId, { types: ['conversation_completed'] }).length,
      terminalCountsBefore.get(fixture.sessionId),
    );
    assert.equal(sessionRow(fixture.sessionId).updatedAt, updatedBefore.get(fixture.sessionId));
  }

  // Shape C: the reaped runs no longer own the source; it gets a resumable
  // terminal without a second notice about the same interruption.
  for (const fixture of shapeC) {
    assert.equal(runStatus(fixture.runId), 'cancelled');
    assert.equal(
      queue.readPendingWorkflowChatDispatchOwnership({
        sessionId: fixture.sessionId,
        sourceUserSeq: fixture.source.seq,
      }),
      null,
    );
    const record = recordFor(fixture.sessionId);
    assert.equal(record.preparedDispatchOwnershipPreserved, false);
    assert.equal(record.notified, false, 'the owner was already told about this interruption');
    const settled = terminalsFor(fixture.sessionId, fixture.source.seq);
    assert.equal(settled.length, 1);
    assert.equal(presentationEventFromCompletionData(settled[0]!.data)?.kind, 'continue');
    const decision = eventlog.listEvents(fixture.sessionId, { types: ['restart_recovery_decision'] }).at(-1);
    assert.equal(decision?.data.preparedDispatchOwnershipPreserved, false, 'the changed decision is on record');
  }
  assert.equal(first.notified, shapeA.length);

  const decisionsBefore = new Map(all.map((fixture) => [
    fixture.sessionId,
    eventlog.listEvents(fixture.sessionId, { desc: true, limit: 1 })[0]?.seq,
  ]));
  const nextAt = settleAt + DAY;
  eventlog.interruptOrphanedRunAttemptsAtBoot(nextAt);
  assert.equal(
    reportInterruptedChatRuns(() => nextAt, recordDispatch, { bootCutoffMs: nextAt - 60_000 }),
    0,
    'the next boot finds nothing to recover',
  );
  for (const fixture of all) {
    assert.equal(
      eventlog.listEvents(fixture.sessionId, { desc: true, limit: 1 })[0]?.seq,
      decisionsBefore.get(fixture.sessionId),
      `${fixture.sessionId} gains no event on the next boot`,
    );
  }
});

function hasReplayPrimer(sessionId: string): boolean {
  return HarnessSession.load(sessionId)?.toInputItems().some((item) => {
    const content = (item as { content?: unknown }).content;
    return typeof content === 'string' && content.startsWith(restartRecoveryPrimerPrefixForTests());
  }) ?? false;
}

function preparedDispatchFor(sessionId: string, source: EventRow, workflow: string) {
  return queue.queueWorkflowRun(workflow, {}, {
    originSessionId: sessionId,
    originObserver: { sessionId, sourceUserSeq: source.seq, replyTarget: ORIGIN },
    prepareChatDispatch: (authority) => {
      const prepared = eventlog.appendEvent({
        sessionId,
        turn: source.turn,
        role: 'system',
        type: 'async_work_dispatch_prepared',
        parentEventId: source.id,
        data: { ...authority },
      });
      return queue.recordWorkflowChatDispatchPreparation(
        queue.createWorkflowChatDispatchPreparedReceipt(authority, {
          eventId: prepared.id,
          eventSeq: prepared.seq,
          preparedAt: prepared.createdAt,
        }),
      );
    },
  });
}

for (const [kind, text] of [
  ['status', 'How is that work going?'],
  ['continue', 'Please keep going with that task.'],
  ['correction', 'Actually, include only the urgent tickets.'],
  ['another-question', 'What time is the meeting?'],
] as const) {
  test(`a later ${kind} input cannot cancel an unfinished accepted source`, async () => {
    const session = HarnessSession.create({ id: `sess-desktop-stale-followup-${kind}`, kind: 'chat', title: kind });
    const interrupted = eventlog.acceptUserInputForRun({
      sessionId: session.id, turn: 1, role: 'user', data: { text: 'Summarize the open tickets.' },
    });
    const laterAttempt = eventlog.beginRunAttempt(session.id, { runId: `desktop:stale-followup-${kind}` });
    const later = eventlog.recordRunAttemptUserInput(laterAttempt, {
      turn: 2, role: 'user', data: { text, ...originData() },
    });
    commitTerminal(later, { status: 'done', resumable: false,
      presentation: { kind: 'answer', text: 'I have answered this follow-up.' } }, 'success');
    eventlog.finishRunAttempt(laterAttempt, 'completed');
    const since = markerSince(session.id);
    assert.ok(since, 'the unfinished source still owns the marker');
    // An older interrupted task uses the existing manual continuation policy.
    // The follow-up terminal settles only its own accepted source.
    const nowMs = Date.parse(since) + 3 * 60 * 60_000;
    dispatched.length = 0;
    const summary = recoverInterruptedChatRuns(() => nowMs, recordDispatch, { bootCutoffMs: nowMs - 1_000 });
    const record = summary.records.find((row) => row.sessionId === session.id);
    assert.equal(record?.autoResumeSkipped, 'too_old');
    assert.deepEqual(dispatched, []);
    const settled = terminalsFor(session.id, interrupted.seq);
    assert.equal(settled.length, 1);
    const presentation = presentationEventFromCompletionData(settled[0]!.data);
    assert.equal(presentation?.status, 'needs_input');
    assert.equal(presentation?.kind, 'continue');
    assert.equal(presentation?.resumable, true, 'new input alone cannot revoke the unfinished task');
    assert.equal(presentation?.identity.sourceUserSeq, interrupted.seq);
    assert.equal(terminalsFor(session.id, later.seq).length, 1);
    assert.equal(hasReplayPrimer(session.id), true, 'the task remains available for continuation');
    assert.equal(markerSince(session.id), null, 'the resumable terminal settles only its own marker');
    assert.equal(record?.markerCleared, true);
    const again = recoverInterruptedChatRuns(() => nowMs + DAY, recordDispatch, { bootCutoffMs: nowMs + DAY - 1_000 });
    assert.equal(again.records.some((row) => row.sessionId === session.id), false);
  });
}

test('a stop aimed at another active attempt cannot cancel a marker owner without an attempt', () => {
  const session = HarnessSession.create({ id: 'sess-desktop-stale-stop-scope', kind: 'chat', title: 'exact stop scope' });
  const interrupted = eventlog.acceptUserInputForRun({
    sessionId: session.id, turn: 1, role: 'user', data: { text: 'Prepare the ticket summary.' },
  });
  const laterAttempt = eventlog.beginRunAttempt(session.id, { runId: 'desktop:stale-stop-later' });
  const later = eventlog.recordRunAttemptUserInput(laterAttempt, {
    turn: 2, role: 'user', data: { text: 'Check the meeting time.', ...originData() },
  });
  eventlog.requestKill(session.id, 'Stop this meeting lookup.', laterAttempt);
  const nowMs = Date.parse(markerSince(session.id)!) + 3 * 60 * 60_000;
  const summary = recoverInterruptedChatRuns(() => nowMs, recordDispatch, { bootCutoffMs: nowMs - 1_000 });
  const record = summary.records.find((row) => row.sessionId === session.id);
  assert.equal(record?.autoResumeSkipped, 'too_old', 'another attempt’s stop is not this source’s stop');
  const presentation = presentationEventFromCompletionData(terminalsFor(session.id, interrupted.seq)[0]?.data);
  assert.equal(presentation?.resumable, true);
  assert.equal(presentation?.status, 'needs_input');
  commitTerminal(later, { status: 'cancelled', resumable: false,
    presentation: { kind: 'stopped', text: 'Stopped the meeting lookup.' } }, 'stopped');
  eventlog.finishRunAttempt(laterAttempt, 'cancelled');
  recoverInterruptedChatRuns(() => nowMs + 1_000, recordDispatch, { bootCutoffMs: nowMs });
  assert.equal(markerSince(session.id), null);
});

test('a source whose admitted workflow run is still live keeps its marker until that run ends', async () => {
  writeManualWorkflow('stale-live-shared');
  // Another owner's run of the same workflow is already queued; the chat's
  // dispatch attaches to it instead of queueing a duplicate.
  const shared = queue.queueWorkflowRun('stale-live-shared', {});
  assert.equal(shared.status, 'queued');
  const session = HarnessSession.create({ id: 'console:wf-stale-live', kind: 'chat', channel: 'desktop', title: 'live shared run' });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: 'run-home-stale-live' });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'run the workflow named stale-live-shared', source: 'bridge:home', ...originData() },
  }, { armRunInFlight: true });
  const attached = preparedDispatchFor(session.id, source, 'stale-live-shared');
  assert.equal(attached.id, shared.id, 'fixture: the chat attached to the live run');
  const since = markerSince(session.id);
  assert.ok(since);

  const firstAt = T0 + 20 * DAY;
  const first = boot(firstAt);
  const firstRecord = first.records.find((row) => row.sessionId === session.id);
  assert.equal(runStatus(shared.id!), 'queued', 'the reaper leaves a live run alone');
  assert.equal(firstRecord?.preparedDispatchOwnershipPreserved, true);
  assert.equal(firstRecord?.markerCleared, false);
  assert.equal(firstRecord?.notified, true);
  assert.equal(markerSince(session.id), since, 'the pending dispatch keeps its restart handle');
  assert.equal(terminalsFor(session.id, source.seq).length, 0);
  const seqAfterFirst = eventlog.listEvents(session.id, { desc: true, limit: 1 })[0]?.seq;

  const second = boot(firstAt + DAY);
  const secondRecord = second.records.find((row) => row.sessionId === session.id);
  assert.equal(secondRecord?.preparedDispatchOwnershipPreserved, true);
  assert.equal(secondRecord?.notified, false, 'the same interruption is not announced twice');
  assert.equal(markerSince(session.id), since);
  assert.equal(eventlog.listEvents(session.id, { desc: true, limit: 1 })[0]?.seq, seqAfterFirst);

  // The shared run ends. Nothing is left for the dispatch to release.
  const ended = cancelWorkflowRunAtBoundary({ runId: shared.id!, reason: 'Stopped by its owner.', source: 'test' });
  assert.equal(ended.status, 'cancelled');
  const third = boot(firstAt + 2 * DAY);
  const thirdRecord = third.records.find((row) => row.sessionId === session.id);
  assert.equal(thirdRecord?.preparedDispatchOwnershipPreserved, false);
  assert.equal(thirdRecord?.markerCleared, true);
  assert.equal(thirdRecord?.notified, false, 'the owner already heard about this interruption');
  assert.equal(markerSince(session.id), null);
  assert.equal(presentationEventFromCompletionData(terminalsFor(session.id, source.seq)[0]?.data)?.kind, 'continue');

  const fourth = boot(firstAt + 3 * DAY);
  assert.equal(fourth.records.some((row) => row.sessionId === session.id), false);
});

test('a prepared dispatch with a close in progress stays owned after its runs end', () => {
  writeManualWorkflow('stale-closing');
  writeManualWorkflow('stale-unfenced');
  const admit = (label: string, workflow: string) => {
    const session = HarnessSession.create({ id: `console:wf-stale-${label}`, kind: 'chat', channel: 'desktop', title: label });
    const attempt = eventlog.beginRunAttempt(session.id, { runId: `run-home-stale-${label}` });
    const source = eventlog.recordRunAttemptUserInput(attempt, {
      turn: 1,
      role: 'user',
      data: { text: `run the workflow named ${workflow}`, ...originData() },
    }, { armRunInFlight: true });
    const queued = preparedDispatchFor(session.id, source, workflow);
    assert.equal(queued.status, 'held');
    return { sessionId: session.id, source, runId: queued.id! };
  };
  const closing = admit('closing', 'stale-closing');
  const unfenced = admit('unfenced', 'stale-unfenced');
  const groupId = queue.workflowOriginSourceGroupId({
    sessionId: closing.sessionId,
    sourceUserSeq: closing.source.seq,
  });
  queue.recordWorkflowOriginGroupCloseIntent(
    queue.createWorkflowOriginGroupCloseAuthority(queue.readIndexedWorkflowChatDispatchPreparations(groupId)),
  );
  for (const fixture of [closing, unfenced]) {
    assert.equal(
      cancelWorkflowRunAtBoundary({ runId: fixture.runId, reason: 'Stopped by its owner.', source: 'test' }).status,
      'cancelled',
    );
  }

  const owned = queue.readPendingWorkflowChatDispatchOwnership({
    sessionId: closing.sessionId,
    sourceUserSeq: closing.source.seq,
  });
  assert.equal(owned?.phase, 'prepared', 'a fenced close still has a reducer that owns the source');
  assert.deepEqual(owned?.runIds, [closing.runId]);
  assert.equal(
    queue.readPendingWorkflowChatDispatchOwnership({
      sessionId: unfenced.sessionId,
      sourceUserSeq: unfenced.source.seq,
    }),
    null,
    'an unfenced group whose runs all ended owns nothing',
  );

  // Leave the shared home clean for later pins: finish both chats' attempts
  // and retire their markers through the ordinary terminal path.
  for (const fixture of [closing, unfenced]) {
    const attempt = eventlog.getRunAttemptBySourceUserSeq(fixture.sessionId, fixture.source.seq);
    if (attempt) eventlog.finishRunAttempt(attempt, 'cancelled');
    eventlog.openEventLog().prepare(
      "UPDATE sessions SET metadata_json = json_remove(metadata_json, '$.__run_in_flight', '$.__run_in_flight_owner') WHERE id = ?",
    ).run(fixture.sessionId);
  }
});

test('a newer turn armed in this process is never touched by boot recovery', async () => {
  const session = HarnessSession.create({ id: 'sess-desktop-stale-newer', kind: 'chat', title: 'newer owner' });
  const stale = eventlog.acceptUserInputForRun({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    data: { text: 'Draft the weekly summary.' },
  });
  const cutoff = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const attempt = eventlog.beginRunAttempt(session.id, { runId: 'desktop:stale-newer-live' });
  const newer = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 2,
    role: 'user',
    data: { text: 'Add last week\'s metrics too.', ...originData() },
  }, { armRunInFlight: true });
  const ownerBefore = HarnessSession.load(session.id)?.sessionRow.metadata.__run_in_flight_owner;
  const sinceBefore = markerSince(session.id);
  assert.equal((ownerBefore as { sourceUserSeq?: number } | undefined)?.sourceUserSeq, newer.seq);
  const lastSeq = eventlog.listEvents(session.id, { desc: true, limit: 1 })[0]?.seq;

  const summary = recoverInterruptedChatRuns(() => Date.now() + 60_000, recordDispatch, { bootCutoffMs: cutoff });

  assert.equal(summary.records.some((row) => row.sessionId === session.id), false);
  assert.deepEqual(HarnessSession.load(session.id)?.sessionRow.metadata.__run_in_flight_owner, ownerBefore);
  assert.equal(markerSince(session.id), sinceBefore);
  assert.equal(terminalsFor(session.id, stale.seq).length, 0);
  assert.equal(terminalsFor(session.id, newer.seq).length, 0);
  assert.equal(eventlog.listEvents(session.id, { desc: true, limit: 1 })[0]?.seq, lastSeq);
  assert.equal(eventlog.getRunAttemptBySourceUserSeq(session.id, newer.seq)?.finishedAt, null);

  // The live turn finishes through its own terminal, which settles its marker.
  commitTerminal(newer, {
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'Added the metrics.' },
  }, 'success');
  eventlog.finishRunAttempt(attempt, 'completed');
});

test('a resume that fails after a newer turn armed leaves the newer owner in place', async () => {
  const session = HarnessSession.create({ id: 'sess-desktop-stale-race', kind: 'chat', title: 'race' });
  const interrupted = eventlog.acceptUserInputForRun({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    data: { text: 'Compile the vendor list.' },
  });
  const since = markerSince(session.id);
  assert.ok(since);
  const nowMs = Date.parse(since) + 60_000;
  let newer: EventRow | undefined;

  const summary = recoverInterruptedChatRuns(() => nowMs, async () => {
    // The owner sent a new message while the resume was starting.
    newer = eventlog.acceptUserInputForRun({
      sessionId: session.id,
      turn: 2,
      role: 'user',
      data: { text: 'Never mind, only the top three vendors.' },
    });
    throw new Error('the resume failed before producing anything');
  }, { bootCutoffMs: nowMs - 1_000 });
  assert.equal(summary.records.find((row) => row.sessionId === session.id)?.autoResumed, true);
  for (let i = 0; i < 100 && terminalsFor(session.id, interrupted.seq).length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(newer);
  const settled = terminalsFor(session.id, interrupted.seq);
  assert.equal(settled.length, 1, 'the failed resume is settled with its own terminal');
  assert.equal(presentationEventFromCompletionData(settled[0]!.data)?.kind, 'continue');
  const owner = HarnessSession.load(session.id)?.sessionRow.metadata.__run_in_flight_owner as
    { sourceUserSeq?: number } | undefined;
  assert.equal(owner?.sourceUserSeq, newer.seq, 'the newer turn keeps its marker');
  assert.ok(markerSince(session.id));

  commitTerminal(newer, {
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'Here are the top three vendors.' },
  }, 'success');
  assert.equal(markerSince(session.id), null, 'the newer turn settles its own marker');
});
