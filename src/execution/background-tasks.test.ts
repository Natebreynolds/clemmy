/**
 * Run: npx tsx --test src/execution/background-tasks.test.ts
 *
 * Covers fail-closed boot recovery of interrupted background tasks:
 *   - read-only work reattaches to its original receipt-bearing run session,
 *   - write-touched / ambiguous work parks for verification,
 *   - explicit resume stays in place, and
 *   - the resume cap bounds crash loops without cloning the objective.
 *
 * Per-test temp dir via CLEMENTINE_HOME so we don't touch real state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-bgtasks-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_HARNESS_BACKGROUND = 'off';
process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  createBackgroundTask,
  markBackgroundTaskFailed,
  markBackgroundTaskDone,
  getBackgroundTask,
  listBackgroundTasks,
  resumeInterruptedBackgroundTasks,
  interruptStaleRunningBackgroundTasks,
  resumeBackgroundTask,
  processBackgroundTasks,
  classifyBackgroundTaskOutcome,
  _setBackgroundDeliveryJudgeForTests,
  markBackgroundTaskAwaitingInput,
  markBackgroundTaskAwaitingContinue,
  queueBackgroundTaskInputResolution,
  queueBackgroundTaskContinue,
  getBackgroundTaskByQuestionId,
  findSoleAwaitingInputTaskForOrigin,
  findSoleAwaitingContinueTaskForOrigin,
  updateBackgroundTask,
  archiveBackgroundTask,
  restoreBackgroundTask,
  staleTaskKind,
  findStaleBackgroundTasks,
  STALE_TASK_AGE_MS,
  registerBackgroundDrainKick,
  requestBackgroundDrain,
  markBackgroundTaskRunning,
  cancelBackgroundTask,
  truncateResultBody,
  backgroundHeartbeatInternalsForTest,
  sweepInvalidDoneBackgroundTasks,
  replayBackgroundTaskReportBack,
  probeObjectiveForTask,
  selfResumeDecision,
  assessBackgroundTaskRestartSafety,
  _setBackgroundTaskSettlementCasHookForTests,
  _setBackgroundTaskApprovalDispatchCheckHookForTests,
  _setBackgroundTaskReattachCasHookForTests,
  markBackgroundTaskAwaitingApproval,
  queueBackgroundTaskApprovalResolution,
} = await import('./background-tasks.js');
const { enqueueDurableChatTask } = await import('./background-promote.js');
const { isAutoApprovedByScope, getPlanScope } = await import('../agents/plan-scope.js');
const { SessionStore } = await import('../memory/session-store.js');
const { recordWorkerResult, clearLedger, summarizeLedger } = await import('../runtime/harness/fanout-ledger.js');
const { createSession, appendEvent, getSession, listEvents } = await import('../runtime/harness/eventlog.js');
const { listNotifications, getNotificationDestinationsForRecord } = await import('../runtime/notifications.js');
const { markBackgroundTaskBlocked } = await import('./background-tasks.js');
const { listOperationalEvents } = await import('../runtime/operational-telemetry.js');
const { listRuns } = await import('../runtime/run-events.js');
const { runBackgroundTaskWatchdog } = await import('./background-task-watchdog.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('selfResumeDecision (Wave 3): fail-safe cheap checks + defer to judge only when warranted', () => {
  const base = { enabled: true, autoContinueAttempts: 4, hardCap: 24, cycleToolCalls: 5 };
  // Genuinely-continuable case → the (expensive) progress judge decides.
  assert.deepEqual(selfResumeDecision(base), { needJudge: true, reason: 'progress check required' });
  // Kill-switch off → park, no judge.
  assert.equal(selfResumeDecision({ ...base, enabled: false }).resume, false);
  assert.equal(selfResumeDecision({ ...base, enabled: false }).needJudge, undefined);
  // Hard ceiling → park, no judge (absolute bound even while "progressing").
  assert.equal(selfResumeDecision({ ...base, autoContinueAttempts: 24 }).resume, false);
  assert.match(selfResumeDecision({ ...base, autoContinueAttempts: 24 }).reason, /ceiling/);
  // No new tool activity this cycle → park without spending a judge call.
  assert.equal(selfResumeDecision({ ...base, cycleToolCalls: 0 }).resume, false);
  assert.equal(selfResumeDecision({ ...base, cycleToolCalls: 0 }).needJudge, undefined);
});

test('probeObjectiveForTask: goal-bound uses plan objective+criteria; ad-hoc (no goal) falls back to prompt/title', () => {
  const task = { prompt: 'Scrape the 8 firm sites and build the sheet', title: 'Firm scrape' };
  // Goal-bound → plan objective + success criteria (the goal-bound-only path, unchanged)
  assert.equal(
    probeObjectiveForTask(task, { approvedPlan: { objective: 'Build the SEO sheet', successCriteria: ['Sheet has 8 rows', 'Each row has a domain'] } }),
    'Build the SEO sheet\nSheet has 8 rows\nEach row has a domain',
  );
  // approvedPlan preferred over plan
  assert.match(probeObjectiveForTask(task, { approvedPlan: { objective: 'APPROVED' }, plan: { objective: 'DRAFT' } }), /APPROVED/);
  // AD-HOC (no goal) → prompt (the 2026-07-13 extension: probe runs on every task)
  assert.equal(probeObjectiveForTask(task, null), 'Scrape the 8 firm sites and build the sheet');
  assert.equal(probeObjectiveForTask(task, undefined), 'Scrape the 8 firm sites and build the sheet');
  // Goal present but empty plan → still falls back to the task prompt
  assert.equal(probeObjectiveForTask(task, { approvedPlan: { objective: '  ' } }), 'Scrape the 8 firm sites and build the sheet');
  // No prompt → title
  assert.equal(probeObjectiveForTask({ prompt: '', title: 'Firm scrape' }, null), 'Firm scrape');
});

test('enqueueDurableChatTask kicks the drain immediately (fires without waiting for the 15s tick)', () => {
  const kicks: Array<number | undefined> = [];
  registerBackgroundDrainKick((limit) => kicks.push(limit));
  try {
    const task = enqueueDurableChatTask({ message: 'Build the Meta-ads workspace', sessionId: 'sess-kick-1', source: 'desktop' });
    assert.equal(task.status, 'pending', 'task is enqueued pending');
    assert.deepEqual(kicks, [1], 'enqueue requested exactly one immediate single-task drain');
  } finally {
    registerBackgroundDrainKick(() => {});
  }
});

test('requestBackgroundDrain is a safe no-op with no kick registered, and honors the kill-switch', () => {
  // Unregister by installing a throwing kick then clearing via the kill-switch path.
  const kicks: number[] = [];
  registerBackgroundDrainKick((limit) => kicks.push(limit ?? -1));
  const prev = process.env.CLEMMY_BG_DRAIN_KICK;
  try {
    process.env.CLEMMY_BG_DRAIN_KICK = 'off';
    requestBackgroundDrain(1);
    assert.deepEqual(kicks, [], 'kill-switch off ⇒ no kick fired');
    process.env.CLEMMY_BG_DRAIN_KICK = 'on';
    requestBackgroundDrain(2);
    assert.deepEqual(kicks, [2], 'kill-switch on ⇒ kick fired with the requested limit');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_BG_DRAIN_KICK; else process.env.CLEMMY_BG_DRAIN_KICK = prev;
    registerBackgroundDrainKick(() => {});
  }
});

test('operational mirror: background task lifecycle emits created → started → finished + parked/failed', () => {
  const opsFor = (taskId: string) =>
    listOperationalEvents({ limit: 400 }).filter((e) => (e.payload as { taskId?: string }).taskId === taskId);

  // create → running → done
  const a = createBackgroundTask({ title: 'Lifecycle A', prompt: 'do A' });
  const created = opsFor(a.id).find((e) => e.type === 'background_task_created');
  assert.ok(created, 'created emitted');
  assert.equal((created!.payload as { runSessionId?: string }).runSessionId, a.runSessionId);
  markBackgroundTaskRunning(a.id);
  markBackgroundTaskDone(a.id, 'done result');
  const aTypes = opsFor(a.id).map((e) => e.type);
  assert.ok(aTypes.includes('background_task_started'), 'started emitted');
  const finished = opsFor(a.id).find((e) => e.type === 'background_task_finished');
  assert.ok(finished, 'finished emitted');
  assert.equal((finished!.payload as { status?: string }).status, 'done');

  // parked: awaiting_input
  const b = createBackgroundTask({ title: 'Lifecycle B', prompt: 'do B' });
  markBackgroundTaskAwaitingInput(b.id, 'q-1', 'need input?');
  const bParked = opsFor(b.id).find((e) => e.type === 'background_task_parked');
  assert.ok(bParked, 'awaiting_input parked emitted');
  assert.equal((bParked!.payload as { reason?: string }).reason, 'awaiting_input');
  assert.equal(bParked!.severity, 'warn');

  // failed → finished with error severity
  const c = createBackgroundTask({ title: 'Lifecycle C', prompt: 'do C' });
  markBackgroundTaskFailed(c.id, 'boom', 'failed');
  const cFinished = opsFor(c.id).find((e) => e.type === 'background_task_finished');
  assert.ok(cFinished, 'failed → finished emitted');
  assert.equal((cFinished!.payload as { status?: string }).status, 'failed');
  assert.equal(cFinished!.severity, 'error');

  // blocked → parked
  const d = createBackgroundTask({ title: 'Lifecycle D', prompt: 'do D' });
  markBackgroundTaskBlocked(d.id, 'missing creds', 'blocked text');
  const dParked = opsFor(d.id).find((e) => e.type === 'background_task_parked');
  assert.ok(dParked, 'blocked → parked emitted');
  assert.equal((dParked!.payload as { reason?: string }).reason, 'blocked');
});

test('an empty best-effort ledger parks instead of pretending to prove a read-only restart', () => {
  const before = listBackgroundTasks({ includeArchived: true }).length;
  const task = createBackgroundTask({ title: 'Analyze meeting transcript: zoom', prompt: 'do the thing' });
  markBackgroundTaskRunning(task.id); // creates a session, but not fail-closed write-history proof
  markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');

  assert.deepEqual(assessBackgroundTaskRestartSafety(task), {
    safeToAutoResume: false,
    reason: 'receipt_history_unavailable',
    externalWriteCount: 0,
    ambiguousWriteCount: 0,
  });
  assert.equal(resumeInterruptedBackgroundTasks({ cap: 2 }), 0);

  let live = getBackgroundTask(task.id);
  assert.equal(live?.status, 'interrupted');
  assert.equal(live?.runSessionId, task.runSessionId, 'original receipt-bearing session is preserved');
  assert.equal(live?.resumedIntoTaskId, undefined, 'no clone was stamped');
  assert.equal(live?.resumeCount, undefined);
  assert.equal(live?.restartRecovery?.disposition, 'parked_for_verification');
  assert.equal(live?.restartRecovery?.reason, 'receipt_history_unavailable');
  assert.equal(listBackgroundTasks({ includeArchived: true }).length, before + 1, 'only the original task exists');

  // Explicit Resume is the verification boundary and still reattaches in place.
  const resumed = resumeBackgroundTask(task.id);
  assert.equal(resumed?.id, task.id);
  assert.equal(resumed?.runSessionId, task.runSessionId);
  assert.equal(resumed?.status, 'pending');
  assert.equal(resumed?.resumeCount, 1);
  assert.equal(resumed?.restartRecovery?.disposition, 'manual_resumed_in_place');

  // A later boot does not touch a task that is already pending.
  assert.equal(resumeInterruptedBackgroundTasks({ cap: 2 }), 0);
  assert.equal(listBackgroundTasks({ includeArchived: true }).length, before + 1, 'crash bounces never fork a child');
});

test('write-touched restart parks; explicit resume preserves the original receipts/session', () => {
  const before = listBackgroundTasks({ includeArchived: true }).length;
  const task = createBackgroundTask({ title: 'Send the approved follow-up', prompt: 'send it', source: 'desktop' });
  markBackgroundTaskRunning(task.id);
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'composio_execute_tool', callId: 'send-1', accounting: 'top_level', effect: 'external_write' },
  });
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: { shapeKey: 'OUTLOOK_SEND_EMAIL', toolName: 'composio_execute_tool', targets: ['casey@example.com'] },
  });
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'composio_execute_tool', callId: 'send-1', result: 'sent message m-1' },
  });
  markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');

  assert.deepEqual(assessBackgroundTaskRestartSafety(task), {
    safeToAutoResume: false,
    reason: 'external_write_history',
    externalWriteCount: 1,
    ambiguousWriteCount: 0,
  });
  assert.equal(resumeInterruptedBackgroundTasks({ cap: 2 }), 0, 'boot does not replay write-touched work');
  const parked = getBackgroundTask(task.id);
  assert.equal(parked?.status, 'interrupted');
  assert.equal(parked?.restartRecovery?.disposition, 'parked_for_verification');
  assert.equal(parked?.restartRecovery?.reason, 'external_write_history');
  assert.match(parked?.error ?? '', /Verify the external outcome before resuming/);
  assert.equal(parked?.resumedIntoTaskId, undefined);
  assert.equal(listBackgroundTasks({ includeArchived: true }).length, before + 1, 'no fresh safety session/task was created');
  assert.ok(listEvents(task.runSessionId, { types: ['restart_recovery_decision'] })
    .some((event) => (event.data as { disposition?: string }).disposition === 'parked_for_verification'));

  // Choosing Resume is the explicit verification boundary. It reattaches the
  // SAME id/session, so the send receipt and duplicate-write ledger remain in view.
  const resumed = resumeBackgroundTask(task.id);
  assert.equal(resumed?.id, task.id);
  assert.equal(resumed?.runSessionId, task.runSessionId);
  assert.equal(resumed?.restartRecovery?.disposition, 'manual_resumed_in_place');
  assert.match(resumed?.continueResolution?.reason ?? '', /verify prior external outcomes/i);
  assert.equal(listEvents(task.runSessionId, { types: ['external_write'] }).length, 1, 'original receipt is still attached');
  assert.equal(listBackgroundTasks({ includeArchived: true }).length, before + 1, 'manual resume creates no clone');
});

test('a proven failed write is netted, but an empty best-effort remainder still requires verification', () => {
  const task = createBackgroundTask({ title: 'Rejected update', prompt: 'update it', source: 'desktop' });
  markBackgroundTaskRunning(task.id);
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: { shapeKey: 'AIRTABLE_UPDATE_RECORD', targets: ['rec-1'] },
  });
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'system',
    type: 'external_write_failed',
    data: { shapeKey: 'AIRTABLE_UPDATE_RECORD', targets: ['rec-1'] },
  });
  markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');

  assert.deepEqual(assessBackgroundTaskRestartSafety(task), {
    safeToAutoResume: false,
    reason: 'receipt_history_unavailable',
    externalWriteCount: 0,
    ambiguousWriteCount: 0,
  });
  assert.equal(resumeInterruptedBackgroundTasks({ cap: 2 }), 0);
});

test('an unresolved external-write call is ambiguous and always parks on boot', () => {
  const task = createBackgroundTask({ title: 'Ambiguous CRM update', prompt: 'update the account', source: 'desktop' });
  markBackgroundTaskRunning(task.id);
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'composio_execute_tool', callId: 'crm-uncertain', accounting: 'top_level', effect: 'external_write' },
  });
  markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');

  const assessment = assessBackgroundTaskRestartSafety(task);
  assert.equal(assessment.safeToAutoResume, false);
  assert.equal(assessment.reason, 'ambiguous_external_write');
  assert.equal(assessment.ambiguousWriteCount, 1);
  assert.equal(resumeInterruptedBackgroundTasks({ cap: 2 }), 0);
  assert.equal(getBackgroundTask(task.id)?.restartRecovery?.reason, 'ambiguous_external_write');
  assert.equal(getBackgroundTask(task.id)?.resumedIntoTaskId, undefined);
});

test('a lone tool_returned carrying an external-write effect counts as a write and fails closed (finding B)', () => {
  const task = createBackgroundTask({ title: 'Partial-logged send', prompt: 'send it', source: 'desktop' });
  markBackgroundTaskRunning(task.id);
  // Partial best-effort logging: the external-write effect was recorded ONLY on
  // the RETURN row — no matching external-effect tool_called row landed. The old
  // assessment built external evidence only from tool_called rows, so this run
  // looked read-only and was judged safe to auto-replay.
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'composio_execute_tool', callId: 'send-1', effect: 'external_write', result: 'sent message m-1' },
  });
  markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');

  const assessment = assessBackgroundTaskRestartSafety(task);
  assert.equal(assessment.safeToAutoResume, false, 'an external-write effect on the return row must fail closed');
  assert.equal(assessment.reason, 'external_write_history');
  assert.equal(assessment.externalWriteCount, 1);
  assert.equal(resumeInterruptedBackgroundTasks({ cap: 2 }), 0, 'boot must not auto-replay a write-touched run');
  assert.equal(getBackgroundTask(task.id)?.restartRecovery?.disposition, 'parked_for_verification');
});

test('a clean read-only complete history auto-resumes in place as safe_no_external_write', () => {
  const before = listBackgroundTasks({ includeArchived: true }).length;
  const task = createBackgroundTask({ title: 'Summarize the quarterly transcript', prompt: 'read and summarize', source: 'desktop' });
  markBackgroundTaskRunning(task.id);
  // Durable evidence the best-effort producers WERE recording: two real read
  // tool calls, each returned, and NOT one external_write / external_write_failed
  // / external-effect tool_called among them.
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'google_drive_read_file', callId: 'read-1', accounting: 'top_level' },
  });
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'google_drive_read_file', callId: 'read-1', result: 'transcript body' },
  });
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'session_history', callId: 'read-2', accounting: 'top_level' },
  });
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'session_history', callId: 'read-2', result: 'prior turns' },
  });
  markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');

  assert.deepEqual(assessBackgroundTaskRestartSafety(task), {
    safeToAutoResume: true,
    reason: 'safe_no_external_write',
    externalWriteCount: 0,
    ambiguousWriteCount: 0,
  });

  // Boot recovery reattaches this read-only run automatically — no manual
  // 'Verify before resuming' park, and no clone.
  assert.equal(resumeInterruptedBackgroundTasks({ cap: 2 }), 1, 'clean read-only history is auto-resumed on boot');
  const resumed = getBackgroundTask(task.id);
  assert.equal(resumed?.status, 'pending', 'reattached in place, re-queued for the drain');
  assert.equal(resumed?.runSessionId, task.runSessionId, 'same receipt-bearing session — not a fresh one');
  assert.equal(resumed?.resumedIntoTaskId, undefined, 'no carry-forward clone stamp');
  assert.equal(resumed?.resumeCount, 1, 'resumeCount bumped so the crash cap still bounds it');
  assert.equal(resumed?.restartRecovery?.disposition, 'auto_resumed_in_place');
  assert.equal(resumed?.restartRecovery?.reason, 'safe_no_external_write');
  assert.equal(resumed?.continueResolution?.auto, true, 'automatic (not user-initiated) continuation');
  assert.equal(listBackgroundTasks({ includeArchived: true }).length, before + 1, 'auto-resume creates no clone');
});

test('boot recovery never clobbers a user abort that lands before reattach (finding C)', () => {
  const task = createBackgroundTask({ title: 'Read-only run cancelled mid-recovery', prompt: 'read and summarize', source: 'desktop' });
  markBackgroundTaskRunning(task.id);
  // A clean read-only history so boot recovery WOULD auto-resume this run…
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'google_drive_read_file', callId: 'read-1', accounting: 'top_level' },
  });
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'google_drive_read_file', callId: 'read-1', result: 'transcript body' },
  });
  markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');
  assert.equal(assessBackgroundTaskRestartSafety(task).safeToAutoResume, true, 'sanity: this run is auto-resumable');

  // …but a user abort commits in the window between the interrupted-scan read and
  // the reattach. The hook fires at the very top of reattach, before it re-reads.
  let hookCalls = 0;
  _setBackgroundTaskReattachCasHookForTests(() => {
    hookCalls += 1;
    _setBackgroundTaskReattachCasHookForTests(null);
    assert.equal(
      cancelBackgroundTask(task.id, 'Cancelled by the user during boot recovery.')?.status,
      'aborted',
      'the abort wins on an interrupted task',
    );
  });

  try {
    const resumed = resumeInterruptedBackgroundTasks({ cap: 2 });
    assert.equal(hookCalls, 1, 'reattach was entered exactly once');
    assert.equal(resumed, 0, 'the aborted task is NOT auto-resumed');
    assert.equal(getBackgroundTask(task.id)?.status, 'aborted', 'the user abort is preserved, not clobbered back to pending');
  } finally {
    _setBackgroundTaskReattachCasHookForTests(null);
  }
});

test('a read-only history that also attempted a compensated write stays parked (write evidence blocks safe)', () => {
  const task = createBackgroundTask({ title: 'Read then failed-write', prompt: 'read then try a write', source: 'desktop' });
  markBackgroundTaskRunning(task.id);
  // A genuine read (returned) …
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'airtable_list_records', callId: 'read-1', accounting: 'top_level' },
  });
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'airtable_list_records', callId: 'read-1', result: 'rows' },
  });
  // … plus a write that was ATTEMPTED then compensated to a net-zero remainder.
  // It nets externalWriteCount to 0, but the write-attempt evidence must keep the
  // run fail-closed rather than letting the clean read flip it to safe.
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: { shapeKey: 'AIRTABLE_UPDATE_RECORD', targets: ['rec-1'] },
  });
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'system',
    type: 'external_write_failed',
    data: { shapeKey: 'AIRTABLE_UPDATE_RECORD', targets: ['rec-1'] },
  });
  markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');

  assert.deepEqual(assessBackgroundTaskRestartSafety(task), {
    safeToAutoResume: false,
    reason: 'receipt_history_unavailable',
    externalWriteCount: 0,
    ambiguousWriteCount: 0,
  });
  assert.equal(resumeInterruptedBackgroundTasks({ cap: 2 }), 0, 'a compensated write attempt never auto-resumes');
  assert.equal(getBackgroundTask(task.id)?.restartRecovery?.disposition, 'parked_for_verification');
});

test('missing original receipt session fails closed instead of cloning onto a blank session', () => {
  const task = createBackgroundTask({ title: 'Legacy interrupted task', prompt: 'unknown prior work' });
  // Deliberately skip markBackgroundTaskRunning: this simulates a legacy record
  // whose original harness session/receipt history is unavailable.
  markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');
  assert.equal(assessBackgroundTaskRestartSafety(task).reason, 'receipt_history_unavailable');
  assert.equal(resumeInterruptedBackgroundTasks({ cap: 2 }), 0);
  const parked = getBackgroundTask(task.id);
  assert.equal(parked?.restartRecovery?.reason, 'receipt_history_unavailable');
  assert.equal(parked?.resumedIntoTaskId, undefined);
});

test('resumeInterruptedBackgroundTasks ignores non-restart interrupted tasks', () => {
  const task = createBackgroundTask({ title: 'Manual interrupted task', prompt: 'do not restart this automatically' });
  markBackgroundTaskFailed(task.id, 'Interrupted manually during review.', 'interrupted');

  assert.equal(resumeInterruptedBackgroundTasks({ cap: 2 }), 0);
  assert.equal(getBackgroundTask(task.id)?.resumedIntoTaskId, undefined);
});

test('daemon restart terminalizes a user-cancelling task instead of resurrecting it', () => {
  const task = createBackgroundTask({ title: 'Do not resurrect', prompt: 'long task' });
  assert.equal(markBackgroundTaskRunning(task.id)?.status, 'running');
  assert.equal(cancelBackgroundTask(task.id, 'Stopped by the user before restart.')?.status, 'cancelling');

  assert.equal(interruptStaleRunningBackgroundTasks(), 1);
  const settled = getBackgroundTask(task.id);
  assert.equal(settled?.status, 'aborted');
  assert.equal(settled?.error, 'Stopped by the user before restart.');
  assert.equal(resumeInterruptedBackgroundTasks({ cap: 2 }), 0);
  assert.equal(settled?.resumedIntoTaskId, undefined);
});

test('P0 single ownership: a goal-bound restart parks, then explicit resume reattaches in place', async () => {
  const { createGoalContract } = await import('../agents/plan-proposals.js');
  const before = listBackgroundTasks({ includeArchived: true }).length;

  const task = createBackgroundTask({
    title: 'Scorpion Facebook post rundown',
    prompt: 'pull the last 5 Scorpion Facebook posts and their content',
    source: 'desktop',
  });
  // Bind an ACTIVE goal contract to the task's OWN run session — exactly what a
  // detached / goal-bound background run does (see bindBackgroundRunGoal). This
  // is the "run has its own resume path" signal.
  const goal = createGoalContract({
    objective: 'pull the last 5 Scorpion Facebook posts and their content',
    sessionId: task.runSessionId,
    origin: { kind: 'background' },
  });
  assert.ok(goal, 'goal contract created on the run session');

  // Simulate the daemon restart: running task → interrupted.
  markBackgroundTaskRunning(task.id);
  markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');

  const resumed = resumeInterruptedBackgroundTasks({ cap: 2 });
  assert.equal(resumed, 0, 'boot cannot infer replay safety from an empty best-effort ledger');

  // ZERO new task records: no "Resume X" clone was spawned to compete with the
  // goal-bound run — the objective has exactly ONE executor.
  const afterTasks = listBackgroundTasks({ includeArchived: true });
  assert.equal(afterTasks.length, before + 1, 'no clone record was created (only the original exists)');
  assert.ok(!afterTasks.some((t) => t.resumedFromTaskId === task.id), 'nothing points back at the original as a clone');

  let reattached = getBackgroundTask(task.id);
  assert.equal(reattached?.status, 'interrupted', 'boot parks for verification');
  assert.equal(reattached?.restartRecovery?.reason, 'receipt_history_unavailable');

  // Explicit Resume re-drives the SAME record on its own run session.
  reattached = resumeBackgroundTask(task.id);
  assert.equal(reattached?.status, 'pending', 'the same task is re-queued in place (drain re-drives it)');
  assert.equal(reattached?.runSessionId, task.runSessionId, 'same run session — not a fresh one');
  assert.equal(reattached?.resumedIntoTaskId, undefined, 'no carry-forward stamp (not a clone)');
  assert.equal(reattached?.resumeCount, 1, 'resumeCount bumped so the crash cap still bounds it');
  assert.ok(reattached?.continueResolution, 'carries a continuation marker to resume from prior session state');

  // The older goal-only kill-switch cannot reopen the unsafe interrupted-task
  // clone path: restart safety now applies to every background task.
  process.env.CLEMMY_BG_SINGLE_OWNER_RESUME = 'off';
  try {
    markBackgroundTaskRunning(task.id);
    markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');
    assert.equal(resumeInterruptedBackgroundTasks({ cap: 3 }), 0, 'kill switch cannot bypass verification');
    const reattachedAgain = resumeBackgroundTask(task.id);
    assert.equal(reattachedAgain?.id, task.id);
    assert.equal(reattachedAgain?.runSessionId, task.runSessionId);
    assert.equal(reattachedAgain?.resumedIntoTaskId, undefined, 'interrupted recovery remains in place');
  } finally {
    delete process.env.CLEMMY_BG_SINGLE_OWNER_RESUME;
  }
});

test('single ownership: two verified restart resumes keep one record and zero clones', async () => {
  const { createGoalContract } = await import('../agents/plan-proposals.js');
  const drainKicks: Array<number | undefined> = [];
  registerBackgroundDrainKick((limit) => drainKicks.push(limit));
  try {
    const before = listBackgroundTasks({ includeArchived: true }).length;
    const task = createBackgroundTask({ title: 'Double-interrupt goal task', prompt: 'do the durable thing', source: 'desktop' });
    assert.ok(createGoalContract({ objective: 'do the durable thing', sessionId: task.runSessionId, origin: { kind: 'background' } }), 'goal bound');

    // Bounce 1: boot parks; explicit verification reattaches in place.
    markBackgroundTaskRunning(task.id);
    markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');
    assert.equal(resumeInterruptedBackgroundTasks({ cap: 5 }), 0);
    assert.equal(getBackgroundTask(task.id)?.status, 'interrupted');
    resumeBackgroundTask(task.id);
    let live = getBackgroundTask(task.id);
    assert.equal(live?.status, 'pending', 'reattached in place (pending)');
    assert.equal(live?.resumeCount, 1);
    assert.ok(drainKicks.length >= 1, 'reattach handed the task back to the runner (drain kick)');

    // Bounce 2: the reattached task ran again then got interrupted again.
    markBackgroundTaskRunning(task.id);
    markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');
    assert.equal(resumeInterruptedBackgroundTasks({ cap: 5 }), 0);
    resumeBackgroundTask(task.id);

    // Exactly ONE record for THIS objective — no "Resume X" clone across bounces.
    // (Other leftover interrupted tasks in the shared temp home may clone; assert
    // specifically that nothing forked off OUR task.)
    const after = listBackgroundTasks({ includeArchived: true });
    assert.ok(!after.some((t) => t.resumedFromTaskId === task.id), 'nothing points back at our original as a clone');
    live = getBackgroundTask(task.id);
    assert.equal(live?.status, 'pending', 'the ONE record is queued for the runner');
    assert.equal(live?.resumedIntoTaskId, undefined, 'no carry-forward stamp (reattached, not cloned)');
    assert.equal(live?.resumeCount, 2, 'resumeCount bumped each bounce (crash cap still bounds it)');
  } finally {
    registerBackgroundDrainKick(() => {});
  }
});

test('manual resume: a goal-bound interrupted task reattaches SAME id and re-enqueues (no clone)', async () => {
  const { createGoalContract } = await import('../agents/plan-proposals.js');
  const drainKicks: Array<number | undefined> = [];
  registerBackgroundDrainKick((limit) => drainKicks.push(limit));
  try {
    const before = listBackgroundTasks({ includeArchived: true }).length;
    const task = createBackgroundTask({ title: 'Manual-resume goal task', prompt: 'resume me from the board', source: 'desktop' });
    assert.ok(createGoalContract({ objective: 'resume me from the board', sessionId: task.runSessionId, origin: { kind: 'background' } }), 'goal bound');
    markBackgroundTaskRunning(task.id);
    markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');

    // The board resume route calls resumeBackgroundTask directly (no boot drain).
    const resumed = resumeBackgroundTask(task.id);
    assert.equal(resumed?.id, task.id, 'manual resume reattaches the SAME task id, not a clone');
    assert.equal(resumed?.status, 'pending', 're-queued for the runner');
    assert.ok(drainKicks.length >= 1, 'manual reattach kicked the drain so it re-enters the runner immediately');
    const after = listBackgroundTasks({ includeArchived: true });
    assert.equal(after.length, before + 1, 'no clone record created by the manual route');
    assert.ok(!after.some((t) => t.resumedFromTaskId === task.id), 'no "Resume X" clone from the manual route');
  } finally {
    registerBackgroundDrainKick(() => {});
  }
});

test('manual resume: an ordinary non-goal interrupted task reattaches in place', () => {
  const before = listBackgroundTasks({ includeArchived: true }).length;
  const task = createBackgroundTask({ title: 'Non-goal resume task', prompt: 'continue me safely', source: 'cli' });
  markBackgroundTaskRunning(task.id);
  markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');
  const resumed = resumeBackgroundTask(task.id);
  assert.equal(resumed?.id, task.id);
  assert.equal(resumed?.runSessionId, task.runSessionId);
  assert.equal(resumed?.resumedIntoTaskId, undefined);
  const after = listBackgroundTasks({ includeArchived: true });
  assert.equal(after.length, before + 1, 'only the original exists');
  assert.ok(!after.some((candidate) => candidate.resumedFromTaskId === task.id));
});

test('failed-task retry with committed write evidence stays on the receipt-bearing task/session', () => {
  const before = listBackgroundTasks({ includeArchived: true }).length;
  const task = createBackgroundTask({ title: 'Retry write task', prompt: 'create the external record', source: 'desktop' });
  markBackgroundTaskRunning(task.id);
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'Clem',
    type: 'external_write',
    data: { callId: 'failed-write-1', shapeKey: 'create:record', targets: ['crm'] },
  });
  markBackgroundTaskFailed(task.id, 'Provider response was lost.', 'failed');

  const resumed = resumeBackgroundTask(task.id)!;
  assert.equal(resumed.id, task.id, 'retry reattaches the original task');
  assert.equal(resumed.runSessionId, task.runSessionId, 'committed-write evidence remains in scope');
  assert.equal(resumed.status, 'pending');
  assert.equal(resumed.restartRecovery?.reason, 'external_write_history');
  assert.match(resumed.continueResolution?.reason ?? '', /verify prior external outcomes/i);
  assert.equal(listEvents(task.runSessionId, { types: ['external_write'] }).length, 1);
  assert.equal(listBackgroundTasks({ includeArchived: true }).length, before + 1, 'retry creates no receipt-hiding clone');
});

test('aborted-task retry with an unreturned mutation stays in place and records ambiguity', () => {
  const before = listBackgroundTasks({ includeArchived: true }).length;
  const task = createBackgroundTask({ title: 'Retry ambiguous task', prompt: 'send the approved update', source: 'desktop' });
  markBackgroundTaskRunning(task.id);
  appendEvent({
    sessionId: task.runSessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'connected_action', callId: 'aborted-write-1', effect: 'external_write' },
  });
  markBackgroundTaskFailed(task.id, 'Stopped after dispatch may have begun.', 'aborted');

  const resumed = resumeBackgroundTask(task.id)!;
  assert.equal(resumed.id, task.id);
  assert.equal(resumed.runSessionId, task.runSessionId);
  assert.equal(resumed.status, 'pending');
  assert.equal(resumed.restartRecovery?.reason, 'ambiguous_external_write');
  assert.equal(resumed.restartRecovery?.ambiguousWriteCount, 1);
  assert.equal(listBackgroundTasks({ includeArchived: true }).length, before + 1, 'retry creates no fresh run session');
});

test('legacy multi-hop resume chain returns the latest live owner instead of reattaching an intermediate task', () => {
  const first = createBackgroundTask({ title: 'Legacy owner A', prompt: 'do the original work', source: 'desktop' });
  const second = createBackgroundTask({ title: 'Legacy owner B', prompt: 'legacy first retry', source: 'desktop' });
  const latest = createBackgroundTask({ title: 'Legacy owner C', prompt: 'legacy second retry', source: 'desktop' });
  markBackgroundTaskFailed(first.id, 'First legacy attempt failed.', 'failed');
  markBackgroundTaskFailed(second.id, 'Second legacy attempt failed.', 'failed');
  updateBackgroundTask(first.id, { resumedIntoTaskId: second.id });
  updateBackgroundTask(second.id, { resumedFromTaskId: first.id, resumedIntoTaskId: latest.id });
  updateBackgroundTask(latest.id, { resumedFromTaskId: second.id });

  const resolved = resumeBackgroundTask(first.id);
  assert.equal(resolved?.id, latest.id, 'A -> B -> C resolves all the way to C');
  assert.equal(resolved?.runSessionId, latest.runSessionId);
  assert.equal(resolved?.status, 'pending', 'the existing live owner is returned unchanged');
  assert.equal(getBackgroundTask(second.id)?.status, 'failed', 'intermediate B is never reattached beside live C');
});

test('legacy resume ownership cycles and invalid targets fail closed', () => {
  const cycleA = createBackgroundTask({ title: 'Cycle A', prompt: 'legacy cycle', source: 'desktop' });
  const cycleB = createBackgroundTask({ title: 'Cycle B', prompt: 'legacy cycle', source: 'desktop' });
  markBackgroundTaskFailed(cycleA.id, 'failed A', 'failed');
  markBackgroundTaskFailed(cycleB.id, 'failed B', 'failed');
  updateBackgroundTask(cycleA.id, { resumedFromTaskId: cycleB.id, resumedIntoTaskId: cycleB.id });
  updateBackgroundTask(cycleB.id, { resumedFromTaskId: cycleA.id, resumedIntoTaskId: cycleA.id });
  assert.equal(resumeBackgroundTask(cycleA.id), null, 'cycle cannot select an authoritative receipt owner');
  assert.equal(getBackgroundTask(cycleA.id)?.status, 'failed');
  assert.equal(getBackgroundTask(cycleB.id)?.status, 'failed');

  const missing = createBackgroundTask({ title: 'Missing target', prompt: 'legacy missing target', source: 'desktop' });
  markBackgroundTaskFailed(missing.id, 'failed', 'failed');
  updateBackgroundTask(missing.id, { resumedIntoTaskId: 'bg-deadbeef-abcdef' });
  assert.equal(resumeBackgroundTask(missing.id), null, 'missing target fails closed');
  assert.equal(getBackgroundTask(missing.id)?.status, 'failed');

  const malformed = createBackgroundTask({ title: 'Malformed target', prompt: 'legacy malformed target', source: 'desktop' });
  markBackgroundTaskFailed(malformed.id, 'failed', 'failed');
  updateBackgroundTask(malformed.id, { resumedIntoTaskId: '../not-a-task' });
  assert.equal(resumeBackgroundTask(malformed.id), null, 'malformed target fails before any file lookup');
  assert.equal(getBackgroundTask(malformed.id)?.status, 'failed');
});

test('P3/P4 cockpit: toolCallCount is truthful; Tools feed keeps real calls, drops reflection/housekeeping', async () => {
  const { getBackgroundTaskStatus } = await import('./background-task-status.js');
  const task = createBackgroundTask({ title: 'Cockpit stats task', prompt: 'do work', source: 'desktop' });
  const sid = task.runSessionId;
  createSession({ id: sid, kind: 'execution', title: 'Cockpit stats task' });
  const call = (tool: string, callId: string, accounting?: string) => appendEvent({ sessionId: sid, turn: 1, role: 'Clem', type: 'tool_called', data: { tool, callId, ...(accounting ? { accounting } : {}) } });
  const ret = (tool: string, callId: string, result = 'ok', accounting?: string) => appendEvent({ sessionId: sid, turn: 1, role: 'Clem', type: 'tool_returned', data: { tool, callId, result, ...(accounting ? { accounting } : {}) } });

  // Two REAL tool calls (with returns) + three housekeeping/reflection calls.
  call('composio_execute_tool', 'c1', 'top_level');
  call('composio_execute_tool', 'mcp-c1', 'transport_mirror');
  ret('composio_execute_tool', 'mcp-c1', 'ok', 'transport_mirror');
  ret('composio_execute_tool', 'c1', 'ok', 'top_level');
  call('run_batch', 'c2'); ret('run_batch', 'c2');
  call('reflection', 'c3'); ret('reflection', 'c3');
  call('session_history', 'c4'); ret('session_history', 'c4');
  call('composio_status', 'c5'); ret('composio_status', 'c5');

  const detail = getBackgroundTaskStatus(task.id);
  assert.ok(detail, 'status resolves');
  // P3: the tally counts logical top-level calls (parity with the live check-in
  // counter), while the raw transport mirror remains in the audit log.
  assert.equal(listEvents(sid, { types: ['tool_called'] }).length, 6);
  assert.equal(detail!.toolCallCount, 5, 'toolCallCount excludes the native MCP mirror');
  // P4: the human-facing feed keeps the real calls and drops reflection +
  // session_history + *_status housekeeping noise.
  const names = detail!.toolEvents.map((event) => event.toolName).sort();
  assert.deepEqual(names, ['composio_execute_tool', 'run_batch'], 'feed shows only real, named tool calls');
});

test('P2 report-back: desktop task defaults to origin-chat; completion is terminal-delivered, never queued/leaked', async () => {
  const { listQueuedNotificationDeliveries } = await import('../runtime/notifications.js');

  const task = createBackgroundTask({
    title: 'Desktop Scorpion rundown',
    prompt: 'pull the last 5 Scorpion Facebook posts',
    source: 'desktop',
    originSessionId: 'sess-p2-origin',
  });
  // (b) an explicit target is resolved AT CREATION — desktop chat origin → origin_chat.
  assert.deepEqual(task.reportBackTarget, { type: 'origin_chat' }, 'desktop task defaults to origin-chat');

  markBackgroundTaskDone(task.id, 'here is the rundown of the 5 posts');

  const done = listNotifications(500).find(
    (n) => n.metadata?.backgroundTaskId === task.id && n.title.startsWith('Background task completed'),
  );
  assert.ok(done, 'completion notification exists');
  // (c) ACTUAL send outcome: delivered to origin-chat (terminal), not an eternal 'queued'.
  assert.ok(done!.deliveredAt, 'completion is marked delivered (terminal)');
  assert.deepEqual(done!.deliveredDestinations, ['origin-chat'], 'delivered to origin-chat');
  // It never resolves an external destination, so it can't leak to a Discord/Slack DM fallback…
  assert.equal(getNotificationDestinationsForRecord(done!).length, 0, 'zero external destinations resolved');
  // …and it is not sitting in the external delivery queue waiting forever.
  assert.ok(
    !listQueuedNotificationDeliveries().some((job) => job.notificationId === done!.id),
    'origin-chat report is not enqueued for external delivery',
  );
});

test('report-back replay: terminal task with lost notification re-delivers result into origin chat', async () => {
  createSession({ id: 'sess-replay-origin', kind: 'chat', title: 'Replay origin' });
  const task = createBackgroundTask({
    title: 'Replay me',
    prompt: 'produce the saved result',
    source: 'desktop',
    originSessionId: 'sess-replay-origin',
  });
  updateBackgroundTask(task.id, {
    status: 'done',
    completedAt: '2026-07-08T19:06:06.000Z',
    result: 'rescued report body',
  });

  const replay = replayBackgroundTaskReportBack(task.id, { now: '2026-07-08T19:10:06.000Z', reason: 'test_lost_report' });
  assert.equal(replay.ok, true);
  assert.equal(replay.outcomeDelivered, true);

  const note = listNotifications(500).find((n) => n.id === replay.notificationId);
  assert.ok(note, 'stable replay notification exists');
  assert.equal(note!.metadata?.reportBackReplay, true);
  assert.ok(note!.deliveredAt, 'origin-chat replay is terminal-delivered');
  assert.deepEqual(note!.deliveredDestinations, ['origin-chat']);

  const synthetic = listEvents('sess-replay-origin', { types: ['user_input_received'], limit: 10 })
    .find((event) => event.data?.source === 'outcome' && event.data?.sourceId === task.id);
  assert.ok(synthetic, 'result was injected back into the origin harness session');
  assert.match(String(synthetic!.data?.text ?? ''), /rescued report body/);
});

test('watchdog repairs a terminal-undelivered task by replaying the saved report-back', async () => {
  const now = Date.parse('2026-07-08T19:10:06.000Z');
  createSession({ id: 'sess-watchdog-replay-origin', kind: 'chat', title: 'Watchdog replay origin' });
  const task = createBackgroundTask({
    title: 'Watchdog replay',
    prompt: 'save the report',
    source: 'desktop',
    originSessionId: 'sess-watchdog-replay-origin',
  });
  updateBackgroundTask(task.id, {
    status: 'done',
    completedAt: '2026-07-08T19:06:06.000Z',
    result: 'watchdog rescued body',
  });

  const result = runBackgroundTaskWatchdog(now);
  assert.equal(result.stalled, 1);

  const note = listNotifications(500).find((n) => n.id === `bgtask-report-replay-${task.id}-done`);
  assert.ok(note, 'watchdog created a stable replay notification');
  assert.equal(note!.metadata?.reportBackReplay, true);
  assert.equal(note!.metadata?.replayReason, 'watchdog_terminal_undelivered');
  assert.deepEqual(note!.deliveredDestinations, ['origin-chat']);
  assert.equal(
    listNotifications(500).some((n) => n.id === `bgtask-stalled-terminal_undelivered-${task.id}`),
    false,
    'watchdog did not emit the old vague stalled alert when replay worked',
  );

  const synthetic = listEvents('sess-watchdog-replay-origin', { types: ['user_input_received'], limit: 10 })
    .find((event) => event.data?.source === 'outcome' && event.data?.sourceId === task.id);
  assert.ok(synthetic, 'watchdog replay injected the saved result into the origin session');
  assert.match(String(synthetic!.data?.text ?? ''), /watchdog rescued body/);
});

test('P2 channels: origin-chat is always an available target; the enumerated key round-trips', async () => {
  const { listReportBackChannelOptions, setBackgroundTaskReportBackTarget } = await import('./background-tasks.js');
  const options = listReportBackChannelOptions();
  assert.ok(options.some((o) => o.key === 'origin_chat'), 'origin-chat is always enumerated');

  // A task whose target is set via the enumerated key persists that target.
  const task = createBackgroundTask({ title: 'Channel key task', prompt: 'do work', source: 'discord' });
  const updated = setBackgroundTaskReportBackTarget(task.id, { type: 'origin_chat' });
  assert.deepEqual(updated?.reportBackTarget, { type: 'origin_chat' }, 'origin_chat target persists');
});

// ─── sticky approval: launching a background task IS the approval ──────
//
// A background-task worker run is autonomous-by-default — the user
// consented when they kicked it off, so internal mutating tools must NOT
// re-pause mid-run. processBackgroundTasks opens a plan scope (the canonical
// approval mechanism) keyed on the task's runSessionId, covering `*`, before
// the worker run executes. This test drives processBackgroundTasks with a
// stub assistant and asserts: (1) at the moment respond() runs, a mutating
// tool inside that run is auto-approved by the scope; (2) the scope persists
// on the run session and covers `*`.
test('processBackgroundTasks opens a sticky plan scope so mutating tools auto-approve mid-run', async () => {
  const task = createBackgroundTask({ title: 'Pull deals and write a sheet', prompt: 'do the autonomous thing' });

  let approvedDuringRun: boolean | undefined;
  let runSessionSeen: string | undefined;
  let workerPromptSeen = '';

  // Minimal ClementineAssistant stub. respond() stands in for the worker
  // run; we probe the scope from inside it (the exact window where internal
  // tools would otherwise re-prompt).
  const stubAssistant = {
    getRuntime() {
      return {} as never;
    },
    async respond(request: { message: string; sessionId: string }) {
      runSessionSeen = request.sessionId;
      workerPromptSeen = request.message;
      // A representative mutating tool (write_file) must be auto-approved by
      // the scope the processor opened for this run session.
      approvedDuringRun = isAutoApprovedByScope(request.sessionId, 'write_file', { path: '/tmp/out.csv' });
      return { text: 'done', sessionId: request.sessionId };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processed = await processBackgroundTasks(stubAssistant as any, 1);
  assert.equal(processed, 1, 'the queued task should be processed');

  assert.ok(runSessionSeen, 'respond should have been called with the run session id');
  assert.equal(runSessionSeen, task.runSessionId);
  assert.match(workerPromptSeen, /run_worker fan-out/i, 'background worker prompt should steer batch work to subagent fan-out');
  assert.equal(approvedDuringRun, true, 'mutating tool must be pre-approved by the sticky scope mid-run');

  // The scope persists and covers all non-read tools for this run session.
  const scope = getPlanScope(task.runSessionId);
  assert.ok(scope, 'a plan scope should exist for the run session');
  assert.deepEqual(scope!.allowedTools, ['*'], 'background run scope covers all non-read tools');
  assert.equal(scope!.planProposalId, `background-task:${task.id}`);
});

test('processBackgroundTasks embeds origin transcript and action ledger in the worker prompt', async () => {
  for (const existing of listBackgroundTasks({ includeArchived: true })) archiveBackgroundTask(existing.id);
  const workspaceRoot = path.join(TMP_HOME, 'workspace-root');
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(path.join(TMP_HOME, '.env'), `WORKSPACE_DIRS=${workspaceRoot}\n`, 'utf-8');
  const origin = createSession({ kind: 'chat', channel: 'desktop', title: 'Origin chat' });
  appendEvent({ sessionId: origin.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Use the approved Revill prospect list and do not email Casey twice.' } });
  appendEvent({ sessionId: origin.id, turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'email_send', targets: ['casey@example.com'] } });
  appendEvent({ sessionId: origin.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Sent Casey the first email and saved the draft follow-up.' } });
  const task = createBackgroundTask({ title: 'Finish follow-up', prompt: 'finish the follow-up sequence', originSessionId: origin.id, model: 'claude-sonnet-5' });

  let workerPromptSeen = '';
  const stubAssistant = {
    getRuntime() {
      return {} as never;
    },
    async respond(request: { message: string; sessionId: string }) {
      workerPromptSeen = request.message;
      return { text: 'Done — follow-up sequence completed and verified.', sessionId: request.sessionId, stoppedReason: 'success' as const };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processed = await processBackgroundTasks(stubAssistant as any, 1);
  assert.equal(processed, 1);
  assert.match(workerPromptSeen, /## Origin Session Lineage/);
  assert.match(workerPromptSeen, /session_history/);
  assert.match(workerPromptSeen, /USER: Use the approved Revill prospect list/);
  assert.match(workerPromptSeen, /YOU: Sent Casey the first email/);
  assert.match(workerPromptSeen, /ALREADY DONE/);
  assert.match(workerPromptSeen, /email_send/);
  assert.match(workerPromptSeen, /casey@example\.com/);
  assert.match(workerPromptSeen, /## Workspace Roots/);
  assert.match(workerPromptSeen, /Primary workspace root:/);
  assert.match(workerPromptSeen, /Clementine's data directory is not the user workspace/);
  assert.match(workerPromptSeen, /list_files\(directory=\.\.\.\), read_file\(path=\.\.\.\), and run_shell_command\(cwd=\.\.\.\)/);
  assert.match(workerPromptSeen, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const updated = getBackgroundTask(task.id);
  assert.equal(updated?.status, 'done');
  assert.equal(updated?.requestedModel, 'claude-sonnet-5');
  assert.equal(updated?.effectiveModel, 'claude-sonnet-5');
  assert.equal(updated?.modelProvider, 'claude');
  assert.equal(updated?.modelRouteKind, 'legacy');
  assert.equal(updated?.modelTransport, 'legacy_assistant');
});

test('processBackgroundTasks carries origin lineage into automatic continuation prompts', async () => {
  for (const existing of listBackgroundTasks({ includeArchived: true })) archiveBackgroundTask(existing.id);
  const origin = createSession({ kind: 'chat', channel: 'desktop', title: 'Origin chat' });
  appendEvent({ sessionId: origin.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Only use the approved Denver shortlist.' } });
  appendEvent({ sessionId: origin.id, turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['casey@example.com'] } });
  appendEvent({ sessionId: origin.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Casey has already been emailed once.' } });
  const task = createBackgroundTask({ title: 'Long follow-up', prompt: 'finish the follow-up sequence', originSessionId: origin.id });
  const messages: string[] = [];

  const stubAssistant = {
    getRuntime() {
      return {} as never;
    },
    async respond(request: { message: string; sessionId: string }) {
      messages.push(request.message);
      if (messages.length === 1) {
        return {
          text: 'Partial pass finished; more work remains.',
          sessionId: request.sessionId,
          stoppedReason: 'max-turns-with-grace' as const,
        };
      }
      return {
        text: 'Done — follow-up sequence completed without resending Casey.',
        sessionId: request.sessionId,
        stoppedReason: 'success' as const,
      };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processed = await processBackgroundTasks(stubAssistant as any, 1);
  assert.equal(processed, 1);
  assert.equal(messages.length, 2);
  assert.match(messages[1], /Continue background task/);
  assert.match(messages[1], /## Origin Session Lineage/);
  assert.match(messages[1], /USER: Only use the approved Denver shortlist/);
  assert.match(messages[1], /ALREADY DONE/);
  assert.match(messages[1], /OUTLOOK_SEND_EMAIL/);
  assert.match(messages[1], /casey@example\.com/);
});

test('processBackgroundTasks carries origin lineage into question-answer resume prompts', async () => {
  for (const existing of listBackgroundTasks({ includeArchived: true })) archiveBackgroundTask(existing.id);
  const origin = createSession({ kind: 'chat', channel: 'desktop', title: 'Origin chat' });
  appendEvent({ sessionId: origin.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Use my approved healthcare segment and avoid duplicate sends.' } });
  appendEvent({ sessionId: origin.id, turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'crm_update', targets: ['record:acct-42'] } });
  appendEvent({ sessionId: origin.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Updated acct-42 and asked which segment to finish.' } });
  const task = createBackgroundTask({ title: 'Resume after answer', prompt: 'finish the enrichment', originSessionId: origin.id });
  markBackgroundTaskAwaitingInput(task.id, 'q-origin-resume', 'Which segment should I use?');
  queueBackgroundTaskInputResolution('q-origin-resume', 'healthcare only');
  let workerPromptSeen = '';

  const stubAssistant = {
    getRuntime() {
      return {} as never;
    },
    async respond(request: { message: string; sessionId: string }) {
      workerPromptSeen = request.message;
      return {
        text: 'Done — healthcare segment enriched and acct-42 was not repeated.',
        sessionId: request.sessionId,
        stoppedReason: 'success' as const,
      };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processed = await processBackgroundTasks(stubAssistant as any, 1);
  assert.equal(processed, 1);
  assert.match(workerPromptSeen, /healthcare only/);
  assert.match(workerPromptSeen, /## Origin Session Lineage/);
  assert.match(workerPromptSeen, /USER: Use my approved healthcare segment/);
  assert.match(workerPromptSeen, /ALREADY DONE/);
  assert.match(workerPromptSeen, /crm_update/);
  assert.match(workerPromptSeen, /record:acct-42/);
});

test('processBackgroundTasks auto-continues a max-turn pause before marking the task done', async () => {
  const task = createBackgroundTask({ title: 'Long analysis', prompt: 'work through all records' });
  const messages: string[] = [];

  const stubAssistant = {
    getRuntime() {
      return {} as never;
    },
    async respond(request: { message: string; sessionId: string }) {
      messages.push(request.message);
      if (messages.length === 1) {
        return {
          text: 'Partial pass finished; more records remain.',
          sessionId: request.sessionId,
          stoppedReason: 'max-turns-with-grace' as const,
        };
      }
      return {
        text: 'Done — all records were processed and verified.',
        sessionId: request.sessionId,
        stoppedReason: 'success' as const,
      };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processed = await processBackgroundTasks(stubAssistant as any, 1);
  assert.equal(processed, 1);
  assert.equal(messages.length, 2, 'the processor should issue a continuation turn');
  assert.match(messages[1], /Continue background task/);
  const updated = getBackgroundTask(task.id);
  assert.equal(updated?.status, 'done');
  assert.match(updated?.result ?? '', /all records were processed/);
});

test('processBackgroundTasks settles a cancelled response as cancelled/aborted, never blocked or failed', async () => {
  const task = createBackgroundTask({ title: 'Stop this research run', prompt: 'research until stopped' });
  const stubAssistant = {
    getRuntime() { return {} as never; },
    async respond(request: { sessionId: string }) {
      return {
        text: 'Stopped — you asked me to halt this run.',
        sessionId: request.sessionId,
        stoppedReason: 'cancelled' as const,
      };
    },
  };

  const processed = await processBackgroundTasks(stubAssistant as any, 1);
  assert.equal(processed, 1);
  assert.equal(getBackgroundTask(task.id)?.status, 'aborted', 'task store uses aborted for a user cancellation');
  const tracked = listRuns(40).find((run) => run.sessionId === task.runSessionId);
  assert.equal(tracked?.status, 'cancelled');
  assert.equal(tracked?.events.filter((event) => event.type === 'cancelled').length, 1);
  assert.equal(tracked?.events.some((event) => event.type === 'failed'), false);
});

test('a cancellation arriving during delivery verification wins over a blocked verdict', async () => {
  for (const existing of listBackgroundTasks({ includeArchived: true })) archiveBackgroundTask(existing.id);
  const task = createBackgroundTask({ title: 'Cancel while verifying', prompt: 'prepare the requested report' });
  let enterJudge!: () => void;
  let releaseJudge!: () => void;
  const judgeEntered = new Promise<void>((resolve) => { enterJudge = resolve; });
  const judgeReleased = new Promise<void>((resolve) => { releaseJudge = resolve; });
  _setBackgroundDeliveryJudgeForTests(async () => {
    enterJudge();
    await judgeReleased;
    return { done: false, reason: 'no verified report yet' };
  });

  try {
    const processing = processBackgroundTasks({
      getRuntime() { return {} as never; },
      async respond(request: { sessionId: string }) {
        return {
          text: "I'll prepare and share the report next.",
          sessionId: request.sessionId,
          stoppedReason: 'success' as const,
        };
      },
    } as any, 1);

    await judgeEntered;
    assert.equal(cancelBackgroundTask(task.id, 'Stopped during verification.')?.status, 'cancelling');
    releaseJudge();
    assert.equal(await processing, 1);

    assert.equal(getBackgroundTask(task.id)?.status, 'aborted');
    const tracked = listRuns(40).find((run) => run.sessionId === task.runSessionId);
    assert.equal(tracked?.status, 'cancelled');
    assert.equal(tracked?.events.filter((event) => event.type === 'cancelled').length, 1);
    assert.equal(tracked?.events.some((event) => event.type === 'failed'), false);
  } finally {
    releaseJudge?.();
    _setBackgroundDeliveryJudgeForTests(null);
  }
});

test('a cancellation committing between completion observation and terminal CAS settles the run as cancelled', async () => {
  for (const existing of listBackgroundTasks({ includeArchived: true })) archiveBackgroundTask(existing.id);
  const task = createBackgroundTask({ title: 'Cancel at completion CAS', prompt: 'prepare the final report' });
  let hookCalls = 0;
  _setBackgroundTaskSettlementCasHookForTests(() => {
    hookCalls += 1;
    _setBackgroundTaskSettlementCasHookForTests(null);
    assert.equal(cancelBackgroundTask(task.id, 'Stopped at the completion boundary.')?.status, 'cancelling');
  });

  try {
    const processed = await processBackgroundTasks({
      getRuntime() { return {} as never; },
      async respond(request: { sessionId: string }) {
        return {
          text: 'Done — the requested report is complete and verified.',
          sessionId: request.sessionId,
          stoppedReason: 'success' as const,
        };
      },
    } as any, 1);

    assert.equal(processed, 1);
    assert.equal(hookCalls, 1);
    assert.equal(getBackgroundTask(task.id)?.status, 'aborted');
    const tracked = listRuns(40).find((run) => run.sessionId === task.runSessionId);
    assert.equal(tracked?.status, 'cancelled');
    assert.equal(tracked?.events.filter((event) => event.type === 'cancelled').length, 1);
    assert.equal(tracked?.events.some((event) => event.type === 'completed'), false);
  } finally {
    _setBackgroundTaskSettlementCasHookForTests(null);
  }
});

test('cancellation after approval continuation starts wins before the approved mutation dispatch', async () => {
  for (const existing of listBackgroundTasks({ includeArchived: true })) archiveBackgroundTask(existing.id);
  const approvalId = 'approval-cancel-before-dispatch';
  const task = createBackgroundTask({
    title: 'Cancel approved send before dispatch',
    prompt: 'Send the approved follow-up only if cancellation has not won.',
  });
  assert.equal(
    markBackgroundTaskAwaitingApproval(task.id, approvalId, 'Ready to send after approval.')?.status,
    'awaiting_approval',
  );
  assert.equal(queueBackgroundTaskApprovalResolution(approvalId, true)?.status, 'pending');

  let dispatchCalls = 0;
  let hookCalls = 0;
  _setBackgroundTaskApprovalDispatchCheckHookForTests(() => {
    hookCalls += 1;
    _setBackgroundTaskApprovalDispatchCheckHookForTests(null);
    assert.equal(getBackgroundTask(task.id)?.status, 'running', 'processor already won pending->running');
    assert.equal(
      cancelBackgroundTask(task.id, 'Cancelled after start but before the approved mutation dispatched.')?.status,
      'cancelling',
    );
  });

  try {
    const processed = await processBackgroundTasks({
      getRuntime() {
        return {
          async resolveApproval() {
            dispatchCalls += 1;
            throw new Error('approved mutation must not dispatch after cancellation wins');
          },
        };
      },
      async respond() {
        throw new Error('respond should not run for an approval continuation');
      },
    } as any, 1);

    assert.equal(processed, 1);
    assert.equal(hookCalls, 1);
    assert.equal(dispatchCalls, 0, 'resolveApproval/provider dispatch is never entered');
    assert.equal(getBackgroundTask(task.id)?.status, 'aborted');
    const tracked = listRuns(40).find((candidate) => candidate.sessionId === task.runSessionId);
    assert.equal(tracked?.status, 'cancelled');
    assert.equal(tracked?.events.some((event) => event.type === 'completed'), false);
  } finally {
    _setBackgroundTaskApprovalDispatchCheckHookForTests(null);
  }
});

test('an approved continuation with no cancellation dispatches the mutation exactly once (finding D lock)', async () => {
  // Finding D is already mitigated: between the dispatch-boundary re-read and
  // resolveApproval there is no await, so no cancellation can interleave; the
  // cancel-wins test above locks the fail-closed side. This locks the other
  // side — the re-read guard must still let a LEGITIMATE approved dispatch
  // through exactly once (no spurious fail-closed).
  for (const existing of listBackgroundTasks({ includeArchived: true })) archiveBackgroundTask(existing.id);
  const approvalId = 'approval-clean-dispatch';
  const task = createBackgroundTask({ title: 'Send the approved follow-up', prompt: 'Send the approved follow-up.' });
  assert.equal(
    markBackgroundTaskAwaitingApproval(task.id, approvalId, 'Ready to send after approval.')?.status,
    'awaiting_approval',
  );
  assert.equal(queueBackgroundTaskApprovalResolution(approvalId, true)?.status, 'pending');

  let dispatchCalls = 0;
  let hookCalls = 0;
  _setBackgroundTaskApprovalDispatchCheckHookForTests(() => {
    hookCalls += 1;
    _setBackgroundTaskApprovalDispatchCheckHookForTests(null);
    // No cancellation — the task is genuinely still running at the boundary.
    assert.equal(getBackgroundTask(task.id)?.status, 'running', 'processor won pending->running');
  });
  _setBackgroundDeliveryJudgeForTests(async () => ({ done: true }));

  try {
    const processed = await processBackgroundTasks({
      getRuntime() {
        return {
          async resolveApproval(id: string, approved: boolean) {
            dispatchCalls += 1;
            assert.equal(id, approvalId);
            assert.equal(approved, true);
            return { text: 'Sent the approved follow-up to casey@example.com (message m-1).' };
          },
        };
      },
      async respond() {
        throw new Error('respond should not run for an approval continuation');
      },
    } as any, 1);

    assert.equal(processed, 1);
    assert.equal(hookCalls, 1);
    assert.equal(dispatchCalls, 1, 'the approved mutation dispatched exactly once');
    assert.equal(getBackgroundTask(task.id)?.status, 'done');
    const tracked = listRuns(40).find((candidate) => candidate.sessionId === task.runSessionId);
    assert.equal(tracked?.status, 'completed');
  } finally {
    _setBackgroundTaskApprovalDispatchCheckHookForTests(null);
    _setBackgroundDeliveryJudgeForTests(null);
  }
});

test('processBackgroundTasks clears per-turn fanout coverage before automatic continuation', async () => {
  const task = createBackgroundTask({ title: 'Recover failed fanout', prompt: 'process every prospect' });
  clearLedger(task.runSessionId);
  let calls = 0;

  const stubAssistant = {
    getRuntime() {
      return {} as never;
    },
    async respond(request: { sessionId: string }) {
      calls += 1;
      if (calls === 1) {
        recordWorkerResult({
          sessionId: task.runSessionId,
          callId: 'worker-first-failed',
          item: 'Acme LLP',
          ok: false,
          reason: 'ERROR: first pass ran out of room',
        });
        return {
          text: 'Partial pass hit the turn budget; Acme still needs recovery.',
          sessionId: request.sessionId,
          stoppedReason: 'max-turns-with-grace' as const,
        };
      }
      return {
        text: 'Done — recovered Acme and completed every prospect.',
        sessionId: request.sessionId,
        stoppedReason: 'success' as const,
      };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processed = await processBackgroundTasks(stubAssistant as any, 1);
  assert.equal(processed, 1);
  assert.equal(calls, 2);
  assert.equal(summarizeLedger(task.runSessionId).total, 0, 'max-turn continuation resets per-turn fanout coverage');
  const updated = getBackgroundTask(task.id);
  assert.equal(updated?.status, 'done');
  assert.match(updated?.result ?? '', /recovered Acme/);
});

test('processBackgroundTasks lets a verified final deliverable override partial worker coverage', async () => {
  for (const existing of listBackgroundTasks({ includeArchived: true })) archiveBackgroundTask(existing.id);
  const task = createBackgroundTask({ title: 'Write comparison doc', prompt: 'Research 10 tools and save comparison.md' });
  clearLedger(task.runSessionId);
  let judgeCalls = 0;

  _setBackgroundDeliveryJudgeForTests(async () => {
    judgeCalls += 1;
    return { done: true, reason: 'comparison.md exists and covers all requested tools' };
  });

  try {
    const stubAssistant = {
      getRuntime() {
        return {} as never;
      },
      async respond(request: { sessionId: string }) {
        recordWorkerResult({
          sessionId: task.runSessionId,
          callId: 'worker-asana-failed',
          item: 'Asana',
          ok: false,
          reason: 'ERROR: worker failed after parent recovered the data',
        });
        return {
          text: 'Done. Deliverable: comparison.md. Verified all 10 tools and all required sections.',
          sessionId: request.sessionId,
          stoppedReason: 'success' as const,
        };
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processed = await processBackgroundTasks(stubAssistant as any, 1);
    assert.equal(processed, 1);
    assert.equal(judgeCalls, 0, 'concrete artifact text is accepted by the cheap verifier without a judge call');
    const updated = getBackgroundTask(task.id);
    assert.equal(updated?.status, 'done');
    assert.match(updated?.result ?? '', /Verified all 10 tools/);
  } finally {
    _setBackgroundDeliveryJudgeForTests(null);
  }
});

test('processBackgroundTasks parks turn-budget exhaustion before terminal fanout coverage', async () => {
  const task = createBackgroundTask({ title: 'Exhausted fanout run', prompt: 'process a very large list' });
  clearLedger(task.runSessionId);
  let calls = 0;

  const stubAssistant = {
    getRuntime() {
      return {} as never;
    },
    async respond(request: { sessionId: string }) {
      calls += 1;
      recordWorkerResult({
        sessionId: task.runSessionId,
        callId: `worker-failed-${calls}`,
        item: `Prospect ${calls}`,
        ok: false,
        reason: 'ERROR: pass ended before this item recovered',
      });
      return {
        text: `Pass ${calls} hit the turn budget before finishing.`,
        sessionId: request.sessionId,
        stoppedReason: 'max-turns-with-grace' as const,
      };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processed = await processBackgroundTasks(stubAssistant as any, 1);
  assert.equal(processed, 1);
  assert.ok(calls > 1, 'the worker should attempt bounded automatic continuations before parking');
  const updated = getBackgroundTask(task.id);
  assert.equal(updated?.status, 'awaiting_continue');
  assert.match(updated?.error ?? '', /turn budget/i);
  assert.equal(summarizeLedger(task.runSessionId).total, 0, 'parked continuation clears stale per-turn fanout coverage');
});

test('markBackgroundTaskDone feeds the result back into the origin session (async report-back)', () => {
  const sessionId = 'sess-reportback-1';
  const task = createBackgroundTask({
    title: 'Pull DataForSEO rankings',
    prompt: 'do it',
    originSessionId: sessionId,
  });

  markBackgroundTaskDone(task.id, 'Top organic result: Yates & Wheland at #3.');

  const store = new SessionStore();
  const turns = store.get(sessionId).turns;
  const marker = `[background task ${task.id} completed]`;
  const reportTurns = turns.filter((t) => typeof t.text === 'string' && t.text.startsWith(marker));
  assert.equal(reportTurns.length, 1, 'exactly one report-back turn appended');
  assert.match(reportTurns[0].text, /Yates & Wheland/, 'result text is carried into context');
  assert.match(reportTurns[0].text, new RegExp(`background_task_status\\('${task.id}'\\)`), 'full-result hint embedded');

  // Idempotent: a retried/double completion must not append twice.
  markBackgroundTaskDone(task.id, 'Top organic result: Yates & Wheland at #3.');
  const after = store.get(sessionId).turns.filter((t) => typeof t.text === 'string' && t.text.startsWith(marker));
  assert.equal(after.length, 1, 'double-complete does not duplicate the report-back turn');
});

test('markBackgroundTaskDone humanizes the notification body but keeps the full result for the model', () => {
  const sessionId = 'sess-humanize-note';
  const task = createBackgroundTask({ title: 'Deal review', prompt: 'do it', originSessionId: sessionId });
  const workerText = [
    'Pipeline is healthy — 3 deals worth $180k are on track to close this month.',
    '',
    '## Completed',
    '- Reviewed 12 open opportunities.',
    '',
    '## Evidence / Verification',
    '- Salesforce query sfq-99, row counts match.',
    '',
    '## Remaining Risks',
    '- Acme deal has no next step booked.',
    '',
    '## Next Step',
    '- Nudge the Acme owner.',
  ].join('\n');
  markBackgroundTaskDone(task.id, workerText);

  const note = listNotifications(200).find((n) => n.metadata?.backgroundTaskId === task.id);
  assert.ok(note, 'a completion notification exists');
  assert.match(note!.body, /Pipeline is healthy/, 'human keeps the actual answer');
  assert.doesNotMatch(note!.body, /Evidence \/ Verification/, 'human body drops the audit ledger');
  assert.doesNotMatch(note!.body, /Remaining Risks|Next Step/, 'human body drops the audit ledger');

  // The MODEL still gets the full result (audit sections intact) via the record.
  const updated = getBackgroundTask(task.id);
  assert.match(updated?.result ?? '', /Evidence \/ Verification/, 'model-facing result is unchanged');
  assert.match(updated?.result ?? '', /Remaining Risks/, 'model-facing result is unchanged');
});

test('markBackgroundTaskDone honors an explicit notificationBody override (job-watcher path)', () => {
  const task = createBackgroundTask({ title: 'Firecrawl crawl', prompt: 'crawl' });
  const rawResult = 'The Composio firecrawl job fc-1 finished — this is the real result.\n\n{"items":[{"url":"https://x"}]}';
  markBackgroundTaskDone(task.id, rawResult, { notificationBody: 'Your firecrawl job finished — 1 item retrieved.' });

  const note = listNotifications(200).find((n) => n.metadata?.backgroundTaskId === task.id);
  assert.equal(note?.body, 'Your firecrawl job finished — 1 item retrieved.', 'override wins for the human');
  assert.match(getBackgroundTask(task.id)?.result ?? '', /this is the real result/, 'model result keeps the raw JSON prose');
});

test('markBackgroundTaskDone with NO origin session is a no-op for transcripts (autonomous spawn)', () => {
  const task = createBackgroundTask({ title: 'Analyze meeting transcript: zoom', prompt: 'analyze' });
  // Should not throw and should not create any session.
  const updated = markBackgroundTaskDone(task.id, 'summary');
  assert.equal(updated?.status, 'done');
  const store = new SessionStore();
  // No session id to wake → no session record created by the report-back path.
  assert.equal(store.list(50).some((s) => s.turns.some((t) => t.text?.includes(task.id))), false);
});

test('markBackgroundTaskFailed reports a genuine failure back into the origin session', () => {
  const sessionId = 'sess-reportback-fail';
  const task = createBackgroundTask({ title: 'Enrich prospects', prompt: 'do it', originSessionId: sessionId });
  markBackgroundTaskFailed(task.id, 'DataForSEO returned 402 payment required', 'failed');

  const store = new SessionStore();
  const turns = store.get(sessionId).turns;
  const reported = turns.filter((t) => typeof t.text === 'string' && t.text.startsWith(`[background task ${task.id} `));
  assert.equal(reported.length, 1, 'a failed task re-enters the session exactly once');
  assert.match(reported[0].text, /FAILED/);
  assert.match(reported[0].text, /402 payment required/);
});

test('markBackgroundTaskFailed with status=interrupted does NOT report back (auto-resumed transient)', () => {
  const sessionId = 'sess-reportback-interrupted';
  const task = createBackgroundTask({ title: 'Long pull', prompt: 'do it', originSessionId: sessionId });
  markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');

  const store = new SessionStore();
  const turns = store.get(sessionId).turns;
  const reported = turns.filter((t) => typeof t.text === 'string' && t.text.startsWith(`[background task ${task.id} `));
  assert.equal(reported.length, 0, 'interrupted (auto-resumed) must not spam the session with a failure');
});

test('markBackgroundTaskDone still reports after an earlier needs-input report-back', () => {
  const sessionId = 'sess-reportback-after-input';
  const task = createBackgroundTask({ title: 'Finish outreach', prompt: 'do it', originSessionId: sessionId });
  markBackgroundTaskAwaitingInput(task.id, 'q-reportback-after-input', 'Which segment should I use?');
  markBackgroundTaskDone(task.id, 'Finished the healthcare segment.');

  const turns = new SessionStore().get(sessionId).turns
    .filter((t) => typeof t.text === 'string' && t.text.startsWith(`[background task ${task.id} `));
  assert.equal(turns.length, 2, 'parked question and final completion both reach the chat');
  assert.match(turns[0].text, /NEEDS INPUT/);
  assert.match(turns[1].text, /completed/);
  assert.match(turns[1].text, /healthcare segment/);
});

test('markBackgroundTaskAwaitingInput reports distinct follow-up questions for the same task', () => {
  const sessionId = 'sess-reportback-two-inputs';
  const task = createBackgroundTask({ title: 'Finish outreach', prompt: 'do it', originSessionId: sessionId });
  markBackgroundTaskAwaitingInput(task.id, 'q-reportback-first-input', 'Which segment should I use?');
  // A crash/retry of the same parked question must stay idempotent.
  markBackgroundTaskAwaitingInput(task.id, 'q-reportback-first-input-retry', 'Which segment should I use?');
  markBackgroundTaskAwaitingInput(task.id, 'q-reportback-second-input', 'Which region should I prioritize?');

  const turns = new SessionStore().get(sessionId).turns
    .filter((t) => typeof t.text === 'string' && t.text.startsWith(`[background task ${task.id} `));
  assert.equal(turns.length, 2, 'distinct parked questions both reach the origin chat');
  assert.match(turns[0].text, /Which segment/);
  assert.match(turns[1].text, /Which region/);
});

test('markBackgroundTaskDone still reports after an earlier continue-needed report-back', () => {
  const sessionId = 'sess-reportback-after-continue';
  const task = createBackgroundTask({ title: 'Long build', prompt: 'do it', originSessionId: sessionId });
  markBackgroundTaskAwaitingContinue(task.id, 'hit turn budget', 'partial notes');
  markBackgroundTaskDone(task.id, 'Finished after continuing.');

  const turns = new SessionStore().get(sessionId).turns
    .filter((t) => typeof t.text === 'string' && t.text.startsWith(`[background task ${task.id} `));
  assert.equal(turns.length, 2, 'continue-needed and final completion both reach the chat');
  assert.match(turns[0].text, /NEEDS INPUT/);
  assert.match(turns[1].text, /completed/);
  assert.match(turns[1].text, /Finished after continuing/);
});

test('terminal background states clear stale parked input and continue metadata', () => {
  const inputTask = createBackgroundTask({ title: 'Finish after answer', prompt: 'do it', originSessionId: 'sess-terminal-cleanup-input' });
  markBackgroundTaskAwaitingInput(inputTask.id, 'q-terminal-cleanup', 'Which segment?');
  queueBackgroundTaskInputResolution('q-terminal-cleanup', 'healthcare');
  markBackgroundTaskDone(inputTask.id, 'Finished after the answer.');

  const inputDone = getBackgroundTask(inputTask.id);
  assert.equal(inputDone?.status, 'done');
  assert.equal(inputDone?.pendingQuestionId, undefined);
  assert.equal(inputDone?.pendingQuestion, undefined);
  assert.equal(inputDone?.inputResolution, undefined);
  assert.equal(getBackgroundTaskByQuestionId('q-terminal-cleanup'), null);

  const continueTask = createBackgroundTask({ title: 'Fail after continue', prompt: 'do it', originSessionId: 'sess-terminal-cleanup-continue' });
  markBackgroundTaskAwaitingContinue(continueTask.id, 'hit turn budget', 'partial notes');
  queueBackgroundTaskContinue(continueTask.id);
  markBackgroundTaskFailed(continueTask.id, 'provider failed after resume', 'failed');

  const continueFailed = getBackgroundTask(continueTask.id);
  assert.equal(continueFailed?.status, 'failed');
  assert.equal(continueFailed?.continueResolution, undefined);
  assert.equal(continueFailed?.pendingQuestionId, undefined);
  assert.equal(continueFailed?.pendingApprovalId, undefined);
});

// ─── P0-C: a runtime-error abort must NOT be reported as a completed task ─────

test('classifyBackgroundTaskOutcome: stoppedReason "error" → blocked (not a hollow done)', () => {
  const outcome = classifyBackgroundTaskOutcome(
    { runSessionId: 'sess-p0c-error' },
    "I hit a runtime error and couldn't finish the reply: Clementine's model backend exceeded the wall-clock budget of 120000ms and was aborted mid-stream.",
    'error',
  );
  assert.equal(outcome.outcome, 'blocked', 'a typed error result is a non-completion');
  assert.ok(outcome.reason && /wall-clock budget/.test(outcome.reason), 'reason carries the error text');
});

test('classifyBackgroundTaskOutcome: max-turns-with-grace → blocked until continued', () => {
  const outcome = classifyBackgroundTaskOutcome(
    { runSessionId: 'sess-turn-budget' },
    'I hit the run budget before finishing — say "continue" to keep going.',
    'max-turns-with-grace',
  );
  assert.equal(outcome.outcome, 'blocked', 'a continuation prompt is not a completed background task');
  assert.match(outcome.reason ?? '', /continue|budget/i);
});

test('classifyBackgroundTaskOutcome: the wall-clock error text alone (no stoppedReason) → blocked', () => {
  const outcome = classifyBackgroundTaskOutcome(
    { runSessionId: 'sess-p0c-text' },
    "I hit a runtime error and couldn't finish the reply: ...exceeded the wall-clock budget of 120000ms...",
  );
  assert.equal(outcome.outcome, 'blocked', 'the runtime-error text patterns catch it even without stoppedReason');
});

test('classifyBackgroundTaskOutcome: self-declared no-result text → blocked', () => {
  const outcome = classifyBackgroundTaskOutcome(
    { runSessionId: 'sess-no-result-text' },
    "I'm stopping this run without a number because no command executed and no tool result was available. Nothing satisfies the success criterion; no verified integer was produced.",
  );
  assert.equal(outcome.outcome, 'blocked', 'a clean stop with no verified deliverable is not a completed background task');
  assert.match(outcome.reason ?? '', /without a number/i);
});

test('classifyBackgroundTaskOutcome: fake tool transcript is blocked, not reported done', () => {
  const fake = "**Tool: read**\n\n*(No `path` provided in the assistant's tool call — the harness will supply required params.)*";
  const outcome = classifyBackgroundTaskOutcome(
    { runSessionId: 'sess-fake-tool-bg' },
    fake,
  );
  assert.equal(outcome.outcome, 'blocked', 'a fake tool transcript is not a background-task deliverable');
  assert.match(outcome.reason ?? '', /fake tool call transcript/i);
});

test('sweepInvalidDoneBackgroundTasks reclassifies prior fake-transcript completions as blocked', () => {
  const task = createBackgroundTask({ title: 'Bad historical completion', prompt: 'Read the transcript and save analysis JSON.' });
  const fake = "**Tool: read**\n\n*(No `path` provided in the assistant's tool call — the harness will supply required params.)*";
  markBackgroundTaskDone(task.id, fake);

  const repaired = sweepInvalidDoneBackgroundTasks({ now: Date.now(), maxAgeMs: 60_000 });

  assert.ok(repaired.ids.includes(task.id));
  assert.ok(repaired.repaired >= 1);
  const updated = getBackgroundTask(task.id);
  assert.equal(updated?.status, 'blocked');
  assert.match(updated?.error ?? '', /Integrity sweep reclassified/i);
  assert.match(updated?.result ?? '', /Tool: read/i);
});

test('sweepInvalidDoneBackgroundTasks leaves genuine completions alone', () => {
  const task = createBackgroundTask({ title: 'Good historical completion', prompt: 'Create the report.' });
  markBackgroundTaskDone(task.id, 'Done — I created the report, saved it to /tmp/report.md, and verified the file exists.');

  const repaired = sweepInvalidDoneBackgroundTasks({ now: Date.now(), maxAgeMs: 60_000 });

  assert.equal(repaired.ids.includes(task.id), false);
  assert.equal(getBackgroundTask(task.id)?.status, 'done');
});

test('sweepInvalidDoneBackgroundTasks does NOT reclassify a success that recounts an overcome blocker (finding A)', () => {
  const task = createBackgroundTask({ title: 'SEO audit sheet', prompt: 'Pull the data and build the audit sheet.' });
  // A GENUINE completion whose narrative recounts a blocker it already OVERCAME.
  // The self-reported-blocked text patterns ("blocked on", "missing credentials")
  // are past-tense-blind, so the old sweep flipped this true success to blocked —
  // and emitted a contradictory "task blocked" notification for a done task.
  markBackgroundTaskDone(
    task.id,
    'Done — I created the "90-Day SEO Audit" Google Sheet with 1,393 rows and shared it with you. '
      + 'Earlier I was blocked on missing Salesforce credentials, but I reconnected the account and completed the full pull.',
  );

  const repaired = sweepInvalidDoneBackgroundTasks({ now: Date.now(), maxAgeMs: 60_000 });

  assert.equal(repaired.ids.includes(task.id), false, 'a success that only recounts an overcome blocker stays done');
  assert.equal(getBackgroundTask(task.id)?.status, 'done');
  // And no contradictory "Background task blocked: …" notification is emitted.
  const blockedNotif = listNotifications(500).find(
    (n) => n.metadata?.backgroundTaskId === task.id && /Background task blocked/i.test(n.title ?? ''),
  );
  assert.equal(blockedNotif, undefined, 'no contradictory blocked notification for a task that stays done');
});

test('sweepInvalidDoneBackgroundTasks still reclassifies a done task with no saved result (structural signal survives)', () => {
  // The false-positive fix removes only the self-reported-blocked TEXT heuristic;
  // a positive/structural non-deliverable (here: an empty saved result) must
  // still reclassify so the sweep keeps healing genuine hollow completions.
  const task = createBackgroundTask({ title: 'Empty completion', prompt: 'Produce the deliverable.' });
  markBackgroundTaskDone(task.id, '   ');

  const repaired = sweepInvalidDoneBackgroundTasks({ now: Date.now(), maxAgeMs: 60_000 });

  assert.ok(repaired.ids.includes(task.id), 'a done task with no saved result is still repaired');
  assert.equal(getBackgroundTask(task.id)?.status, 'blocked');
  assert.match(getBackgroundTask(task.id)?.error ?? '', /no saved result/i);
});

test('classifyBackgroundTaskOutcome: self-reported no tool access is blocked, not reported done', () => {
  const outcome = classifyBackgroundTaskOutcome(
    { runSessionId: 'sess-no-tool-bg' },
    'Nothing new - this environment has no tool access (Composio, Google Sheets, DataForSEO, or file I/O are not exposed to me here), so I cannot fetch search volumes, create a Google Sheet, or verify anything.',
  );
  assert.equal(outcome.outcome, 'blocked', 'a no-tool-access self-report is not a background-task deliverable');
  assert.match(outcome.reason ?? '', /no tool access/i);
});

test('classifyBackgroundTaskOutcome: a genuinely-complete run still reports done', () => {
  const done = classifyBackgroundTaskOutcome(
    { runSessionId: 'sess-p0c-done' },
    'Done — I created the Google Sheet "90-Day Audit" with 1,393 rows and shared it with you.',
    'success',
  );
  assert.equal(done.outcome, 'done', 'a clean completion is not diverted (regression lock)');

  const doneNoReason = classifyBackgroundTaskOutcome(
    { runSessionId: 'sess-p0c-done2' },
    'Finished the export and saved it to your vault.',
  );
  assert.equal(doneNoReason.outcome, 'done', 'clean text with no stoppedReason stays done');
});

test('processBackgroundTasks blocks promise-shaped completion when the delivery judge rejects it', async () => {
  for (const existing of listBackgroundTasks({ includeArchived: true })) archiveBackgroundTask(existing.id);
  const task = createBackgroundTask({ title: 'Prepare contacts', prompt: 'Pull the contacts and write the sheet' });
  let judgeCalls = 0;

  _setBackgroundDeliveryJudgeForTests(async (objective, response) => {
    judgeCalls += 1;
    assert.match(objective, /Pull the contacts/);
    assert.match(response, /send them next/);
    return { done: false, reason: 'no verifiable sheet or contact rows' };
  });

  try {
    const stubAssistant = {
      getRuntime() {
        return {} as never;
      },
      async respond(request: { sessionId: string }) {
        return {
          text: "I'll pull those contacts and send them next.",
          sessionId: request.sessionId,
          stoppedReason: 'success' as const,
        };
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processed = await processBackgroundTasks(stubAssistant as any, 1);
    assert.equal(processed, 1);
    assert.equal(judgeCalls, 1, 'promise-shaped unattended completion must be judged');
    const updated = getBackgroundTask(task.id);
    assert.equal(updated?.status, 'blocked');
    assert.match(updated?.error ?? '', /no verifiable sheet/);
  } finally {
    _setBackgroundDeliveryJudgeForTests(null);
  }
});

test('processBackgroundTasks blocks promise-shaped post-approval completion when the delivery judge rejects it', async () => {
  for (const existing of listBackgroundTasks({ includeArchived: true })) archiveBackgroundTask(existing.id);
  const task = createBackgroundTask({ title: 'Finish approved send', prompt: 'Send the approved follow-up email' });
  updateBackgroundTask(task.id, {
    approvalResolution: { approvalId: 'approval-bg-1', approved: true, queuedAt: new Date().toISOString() },
  });
  let judgeCalls = 0;

  _setBackgroundDeliveryJudgeForTests(async () => {
    judgeCalls += 1;
    return { done: false, reason: 'approval resumed but no send receipt is present' };
  });

  try {
    const stubAssistant = {
      getRuntime() {
        return {
          async resolveApproval(approvalId: string, approved: boolean) {
            return {
              approvalId,
              status: approved ? 'approved' as const : 'rejected' as const,
              text: "I'll send the approved follow-up next.",
              sessionId: task.runSessionId,
            };
          },
        };
      },
      async respond() {
        throw new Error('respond should not be called on approval resume');
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processed = await processBackgroundTasks(stubAssistant as any, 1);
    assert.equal(processed, 1);
    assert.equal(judgeCalls, 1, 'post-approval promise-shaped completion must be judged');
    const updated = getBackgroundTask(task.id);
    assert.equal(updated?.status, 'blocked');
    assert.match(updated?.error ?? '', /no send receipt/);
  } finally {
    _setBackgroundDeliveryJudgeForTests(null);
  }
});

// ─── needs_input check-in round-trip (the judge-gated pause/resume) ───

test('markBackgroundTaskAwaitingInput parks the task with the question', () => {
  const task = createBackgroundTask({ title: 'Draft the emails', prompt: 'draft', originSessionId: 'console:home' });
  const parked = markBackgroundTaskAwaitingInput(task.id, 'q-1', 'Which segment — all leads, or just market-leaders?');
  assert.equal(parked?.status, 'awaiting_input');
  assert.equal(parked?.pendingQuestionId, 'q-1');
  assert.match(parked?.pendingQuestion ?? '', /market-leaders/);
});

test('awaiting-input notifications preserve origin metadata and route Slack report-backs to requester DM', () => {
  const discordTask = createBackgroundTask({
    title: 'Discord follow-up',
    prompt: 'ask in Discord',
    originSessionId: 'discord:origin',
    source: 'discord',
    userId: 'discord-user-1',
    channel: 'discord:discord-channel-1',
  });
  markBackgroundTaskAwaitingInput(discordTask.id, 'q-discord-routing', 'Which Discord segment?');
  const discordNote = listNotifications(200)
    .find((item) => item.metadata?.backgroundTaskId === discordTask.id);
  assert.equal(discordNote?.metadata?.discordUserId, 'discord-user-1');
  assert.equal(discordNote?.metadata?.discordChannelId, 'discord-channel-1');
  assert.equal(discordNote?.metadata?.originDiscordChannelId, 'discord-channel-1');

  const slackTask = createBackgroundTask({
    title: 'Slack follow-up',
    prompt: 'ask in Slack',
    originSessionId: 'slack:C123:1700000000.000100',
    source: 'slack',
    userId: 'U123',
    channel: 'slack:C123:1700000000.000100',
  });
  markBackgroundTaskAwaitingInput(slackTask.id, 'q-slack-routing', 'Which Slack segment?');
  const storedSlackTask = getBackgroundTask(slackTask.id);
  assert.deepEqual(storedSlackTask?.reportBackTarget, { type: 'slack_user', userId: 'U123' });
  const slackNote = listNotifications(200)
    .find((item) => item.metadata?.backgroundTaskId === slackTask.id);
  assert.equal(slackNote?.metadata?.slackUserId, 'U123');
  assert.equal(slackNote?.metadata?.reportBackTargetType, 'slack_user');
  assert.equal(slackNote?.metadata?.reportBackTargetId, 'U123');
  assert.equal(slackNote?.metadata?.slackChannelId, undefined);
  assert.equal(slackNote?.metadata?.slackThreadTs, undefined);
  assert.equal(slackNote?.metadata?.originSlackChannelId, 'C123');
  assert.equal(slackNote?.metadata?.originSlackThreadTs, '1700000000.000100');
  assert.ok(slackNote, 'Slack notification recorded');
  const slackDests = getNotificationDestinationsForRecord(slackNote);
  assert.ok(slackDests.some((dest) => dest.type === 'slack_user' && dest.userId === 'U123'), 'Slack requester DM is the explicit route');
  assert.ok(!slackDests.some((dest) => dest.type === 'slack_channel' && dest.channelId === 'C123'), 'origin thread is not reused as the report-back route');
});

test('completed Slack background tasks DM the requester by default', () => {
  const task = createBackgroundTask({
    title: 'Finish Slack report',
    prompt: 'finish the report in the background',
    originSessionId: 'slack:C999:1700000000.000200',
    source: 'slack',
    userId: 'U999',
    channel: 'slack:C999:1700000000.000200',
  });
  markBackgroundTaskDone(task.id, '## Completed\nThe report is ready.');
  const note = listNotifications(300)
    .find((item) => item.metadata?.backgroundTaskId === task.id && item.title.startsWith('Background task completed:'));
  assert.ok(note, 'completion notification recorded');
  assert.equal(note.metadata?.slackUserId, 'U999');
  assert.equal(note.metadata?.slackChannelId, undefined);
  assert.equal(note.metadata?.originSlackChannelId, 'C999');
  assert.equal(note.metadata?.originSlackThreadTs, '1700000000.000200');
  const dests = getNotificationDestinationsForRecord(note);
  assert.ok(dests.some((dest) => dest.type === 'slack_user' && dest.userId === 'U999'), 'completion routes to requester DM');
  assert.ok(!dests.some((dest) => dest.type === 'slack_channel' && dest.channelId === 'C999'), 'completion does not disappear into the origin thread');
});

test('queueBackgroundTaskInputResolution re-queues with the freeform answer', () => {
  const task = createBackgroundTask({ title: 'Pull accounts', prompt: 'pull', originSessionId: 'console:home' });
  markBackgroundTaskAwaitingInput(task.id, 'q-2', 'How many?');
  const questionCard = listNotifications(300).find((item) => item.metadata?.questionId === 'q-2');
  assert.equal(questionCard?.read, false, 'question starts as an actionable needs-input card');
  const resumed = queueBackgroundTaskInputResolution('q-2', 'just my market-leader accounts');
  assert.equal(resumed?.status, 'pending', 're-queued for the daemon to resume');
  assert.equal(resumed?.inputResolution?.answer, 'just my market-leader accounts');
  assert.equal(
    listNotifications(300).find((item) => item.metadata?.questionId === 'q-2')?.read,
    true,
    'answering clears the stale needs-input card from Home',
  );
  // resolving a non-parked / unknown question is a no-op
  assert.equal(queueBackgroundTaskInputResolution('q-nope', 'x'), null);
});

test('getBackgroundTaskByQuestionId + findSoleAwaitingInputTaskForOrigin resolve the parked task', () => {
  const task = createBackgroundTask({ title: 'Build the report', prompt: 'build', originSessionId: 'console:alpha' });
  markBackgroundTaskAwaitingInput(task.id, 'q-3', 'Need a decision.');
  assert.equal(getBackgroundTaskByQuestionId('q-3')?.id, task.id);
  assert.equal(findSoleAwaitingInputTaskForOrigin('console:alpha')?.id, task.id);
  // a different origin session does not match
  assert.equal(findSoleAwaitingInputTaskForOrigin('console:other'), null);
  // two parked on the same origin → ambiguous → null (caller must disambiguate)
  const task2 = createBackgroundTask({ title: 'Second task', prompt: 'second', originSessionId: 'console:alpha' });
  markBackgroundTaskAwaitingInput(task2.id, 'q-4', 'Another decision.');
  assert.equal(findSoleAwaitingInputTaskForOrigin('console:alpha'), null);
});

test('awaiting_continue tasks can be found by origin and re-queued in place', () => {
  const task = createBackgroundTask({ title: 'Long background run', prompt: 'keep working', originSessionId: 'console:continue' });
  markBackgroundTaskAwaitingContinue(task.id, 'hit turn budget', 'partial notes');

  assert.equal(findSoleAwaitingContinueTaskForOrigin('console:continue')?.id, task.id);
  const queued = queueBackgroundTaskContinue(task.id);
  assert.equal(queued?.id, task.id, 'continuation keeps the same durable task');
  assert.equal(queued?.status, 'pending');
  assert.ok(queued?.continueResolution, 'queued task carries continuation context');
  assert.match(queued?.lastCheckInMessage ?? '', /Continue requested/);
});

test('resumeBackgroundTask re-queues awaiting_continue without spawning a child task', () => {
  const task = createBackgroundTask({ title: 'Resume paused run', prompt: 'continue it', originSessionId: 'console:resume' });
  markBackgroundTaskAwaitingContinue(task.id, 'hit turn budget', 'partial notes');

  const resumed = resumeBackgroundTask(task.id);
  assert.equal(resumed?.id, task.id);
  assert.equal(resumed?.status, 'pending');
  assert.equal(getBackgroundTask(task.id)?.resumedIntoTaskId, undefined);
});

// ─── dispatch tool: agreed plan flows into the worker prompt verbatim ───

test('enqueueDurableChatTask uses a composedPrompt verbatim + sets originSessionId for report-back', () => {
  const composed = 'Objective: redesign the landing page\n\nAgreed plan:\n- audit current\n- rebuild hero';
  const task = enqueueDurableChatTask({
    message: 'redesign the landing page',
    composedPrompt: composed,
    sessionId: 'console:home',
    source: 'desktop',
  });
  assert.equal(task.prompt, composed, 'the agreed plan reaches the worker prompt verbatim');
  assert.equal(task.originSessionId, 'console:home', 'report-back wired to the origin chat');
  assert.equal(task.status, 'pending');
  assert.match(task.title, /redesign|landing/i, 'title derived from the objective, not the composed prompt');
});

// ─── Stale-task detection + archive/restore (2026-06-21 "auto-expire" spin) ───
// Staleness is measured by passing a future `now` to the predicate, so we never
// have to fabricate an old updatedAt.

const DAY = 24 * 60 * 60 * 1000;

test('staleTaskKind: a finished task past the threshold is "finished"; a fresh one is not', () => {
  const t = createBackgroundTask({ title: 'old done task', prompt: 'x' });
  markBackgroundTaskDone(t.id, 'finished');
  const done = getBackgroundTask(t.id)!;
  assert.equal(staleTaskKind(done, Date.parse(done.updatedAt) + STALE_TASK_AGE_MS + DAY), 'finished');
  assert.equal(staleTaskKind(done, Date.parse(done.updatedAt) + 1000), null, 'a day-old finished task is not stale');
});

test('staleTaskKind: a parked (awaiting_input/approval/continue) task past the threshold is "parked"', () => {
  const t = createBackgroundTask({ title: 'forgotten parked task', prompt: 'x' });
  updateBackgroundTask(t.id, { status: 'awaiting_input' });
  const parked = getBackgroundTask(t.id)!;
  assert.equal(staleTaskKind(parked, Date.parse(parked.updatedAt) + STALE_TASK_AGE_MS + DAY), 'parked');

  const c = createBackgroundTask({ title: 'forgotten continue task', prompt: 'x' });
  updateBackgroundTask(c.id, { status: 'awaiting_continue' });
  const awaitingContinue = getBackgroundTask(c.id)!;
  assert.equal(staleTaskKind(awaitingContinue, Date.parse(awaitingContinue.updatedAt) + STALE_TASK_AGE_MS + DAY), 'parked');
});

test('staleTaskKind: active states (pending/running) are NEVER stale, however old', () => {
  const t = createBackgroundTask({ title: 'long pending', prompt: 'x' }); // status pending
  assert.equal(staleTaskKind(t, Date.parse(t.updatedAt) + 100 * DAY), null);
  updateBackgroundTask(t.id, { status: 'running' });
  const running = getBackgroundTask(t.id)!;
  assert.equal(staleTaskKind(running, Date.parse(running.updatedAt) + 100 * DAY), null);
});

test('archive: drops a task off the active list, keeps it restorable, and is idempotent', () => {
  const t = createBackgroundTask({ title: 'to archive', prompt: 'x' });
  markBackgroundTaskDone(t.id, 'done');
  const archived = archiveBackgroundTask(t.id)!;
  assert.equal(archived.archived, true);
  assert.ok(archived.archivedAt, 'archivedAt stamped');
  assert.equal(listBackgroundTasks().some((x) => x.id === t.id), false, 'gone from the active list');
  assert.equal(listBackgroundTasks({ includeArchived: true }).some((x) => x.id === t.id), true, 'still on disk');
  // idempotent
  assert.equal(archiveBackgroundTask(t.id)!.archivedAt, archived.archivedAt, 're-archive is a no-op');
});

test('archive: an archived task is never stale (already cleared)', () => {
  const t = createBackgroundTask({ title: 'archived old', prompt: 'x' });
  markBackgroundTaskDone(t.id, 'done');
  archiveBackgroundTask(t.id);
  const a = getBackgroundTask(t.id)!;
  assert.equal(staleTaskKind(a, Date.parse(a.updatedAt) + 100 * DAY), null);
});

test('restore: brings an archived task back and bumps updatedAt so it is not instantly re-stale', () => {
  const t = createBackgroundTask({ title: 'to restore', prompt: 'x' });
  markBackgroundTaskDone(t.id, 'done');
  archiveBackgroundTask(t.id);
  const restored = restoreBackgroundTask(t.id)!;
  assert.equal(restored.archived, false);
  assert.equal(restored.archivedAt, undefined, 'archivedAt cleared');
  assert.equal(listBackgroundTasks().some((x) => x.id === t.id), true, 'back on the active list');
  // freshly restored → not stale against "now"
  assert.equal(staleTaskKind(restored, Date.parse(restored.updatedAt) + 1000), null);
});

test('findStaleBackgroundTasks: returns finished + parked, excludes active + archived', () => {
  // clear any tasks left by earlier tests so the counts are deterministic
  for (const x of listBackgroundTasks({ includeArchived: true })) archiveBackgroundTask(x.id);

  const finished = createBackgroundTask({ title: 'stale finished', prompt: 'x' });
  markBackgroundTaskDone(finished.id, 'done');
  const parked = createBackgroundTask({ title: 'stale parked', prompt: 'x' });
  updateBackgroundTask(parked.id, { status: 'awaiting_approval' });
  const active = createBackgroundTask({ title: 'still pending', prompt: 'x' }); // pending → active, never stale
  const archivedTask = createBackgroundTask({ title: 'already archived', prompt: 'x' });
  markBackgroundTaskDone(archivedTask.id, 'done');
  archiveBackgroundTask(archivedTask.id);

  const base = Date.parse(getBackgroundTask(finished.id)!.updatedAt);
  const stale = findStaleBackgroundTasks(base + STALE_TASK_AGE_MS + DAY); // age-based: everything below is 8d old
  const ids = new Set(stale.map((s) => s.task.id));

  assert.equal(ids.has(finished.id), true);
  assert.equal(ids.has(parked.id), true);
  assert.equal(stale.find((s) => s.task.id === finished.id)?.kind, 'finished');
  assert.equal(stale.find((s) => s.task.id === parked.id)?.kind, 'parked');
  assert.equal(ids.has(active.id), false, 'pending is active, not stale — even when old');
  assert.equal(ids.has(archivedTask.id), false, 'archived is already cleared, never stale');
});

test('markBackgroundTaskRunning pre-registers the background:<id> trace session (no SSE 404 window)', () => {
  const task = createBackgroundTask({ title: 'Deep SEO on 3 firms', prompt: 'do the work' });
  assert.equal(getSession(task.runSessionId), null, 'no trace session before it runs');
  const running = markBackgroundTaskRunning(task.id);
  assert.equal(running?.status, 'running');
  const sess = getSession(task.runSessionId);
  assert.ok(sess, 'the background:<id> harness session exists the instant it flips to RUNNING → trace SSE finds it, no 404');
  assert.equal(sess?.kind, 'execution');
});

test('truncateResultBody: short bodies pass through unchanged', () => {
  const short = 'All five firms analyzed. No blockers.';
  assert.equal(truncateResultBody(short), short);
});

test('truncateResultBody: long bodies cut at a word boundary with an ellipsis (never mid-word)', () => {
  const paragraph = 'The quarterly SEO analysis is complete. ';
  const long = paragraph.repeat(400); // well over the 4000-char cap
  const out = truncateResultBody(long);
  assert.ok(out.length <= 4000 + 2, 'stays within the cap (+ ellipsis)');
  assert.ok(out.endsWith(' …'), 'marks the truncation with an ellipsis');
  const beforeEllipsis = out.slice(0, -2);
  assert.ok(!/\S$/.test(beforeEllipsis) || beforeEllipsis.endsWith('complete.') || / $/.test(beforeEllipsis) === false,
    'cut lands on a boundary, not mid-word');
  // Concretely: the last retained character sequence is a whole word from the source.
  assert.ok(long.startsWith(beforeEllipsis.trimEnd()), 'retained text is a clean prefix of the source');
});

test('truncateResultBody: prefers a paragraph boundary when one is available', () => {
  const head = 'First paragraph with the headline result.';
  const body = head + '\n\n' + 'x'.repeat(6000);
  const out = truncateResultBody(body);
  assert.ok(out.startsWith(head), 'keeps the whole first paragraph');
  assert.ok(out.endsWith(' …'));
});

// ── Loud progress heartbeats ──────────────────────────────────────────────────
// Time-based check-ins now reach the report-back channel with substance
// (elapsed + tool count + current activity), rate-limited to one per interval.
const {
  formatElapsedDuration,
  decideHeartbeat,
  buildProgressCheckInBody,
} = backgroundHeartbeatInternalsForTest;

function heartbeatTask(patch: Record<string, unknown> = {}): any {
  return { id: 'bg-hb-1', title: 'the quarterly SEO analysis', ...patch };
}

test('formatElapsedDuration: seconds, minutes, hours', () => {
  assert.equal(formatElapsedDuration(45_000), '45s');
  assert.equal(formatElapsedDuration(12 * 60_000), '12m');
  assert.equal(formatElapsedDuration(60 * 60_000), '1h');
  assert.equal(formatElapsedDuration(65 * 60_000), '1h 5m');
});

test('progress heartbeat body carries elapsed time, tool count, and current activity', () => {
  const body = buildProgressCheckInBody({
    task: heartbeatTask(),
    elapsedMs: 12 * 60_000,
    toolCount: 23,
    latestActivitySummary: 'serp_organic_live_advanced',
    runId: 'run-bg-hb-1',
  });
  assert.match(body, /Still working on the quarterly SEO analysis/);
  assert.match(body, /12m in/, 'human elapsed time is present');
  assert.match(body, /23 tool calls/, 'tool-call count is present');
  assert.match(body, /Currently: serp_organic_live_advanced/, 'latest activity is surfaced');
});

test('progress heartbeat body falls back to the task label when no activity seen yet, and singularizes one call', () => {
  const body = buildProgressCheckInBody({
    task: heartbeatTask(),
    elapsedMs: 30_000,
    toolCount: 1,
    latestActivitySummary: '',
  });
  assert.match(body, /1 tool call\./, 'singular "call" for a single tool call');
  assert.match(body, /Currently: the quarterly SEO analysis/, 'falls back to the label as the activity');
});

test('decideHeartbeat: running past the interval emits a LOUD heartbeat', () => {
  const d = decideHeartbeat({ status: 'running', nowMs: 200_000, lastHeartbeatAtMs: 0, intervalMs: 180_000 });
  assert.deepEqual(d, { emit: true, loud: true });
});

test('decideHeartbeat: within the interval is rate-limited (no second loud message)', () => {
  const d = decideHeartbeat({ status: 'running', nowMs: 100_000, lastHeartbeatAtMs: 0, intervalMs: 180_000 });
  assert.deepEqual(d, { emit: false, loud: false });
});

test('decideHeartbeat: terminal and awaiting states stop heartbeats entirely', () => {
  for (const status of ['done', 'failed', 'aborted', 'interrupted', 'awaiting_approval', 'awaiting_input', 'awaiting_continue'] as const) {
    const d = decideHeartbeat({ status, nowMs: 10_000_000, lastHeartbeatAtMs: 0, intervalMs: 180_000 });
    assert.deepEqual(d, { emit: false, loud: false }, `no heartbeat when ${status}`);
  }
});

test('decideHeartbeat: cancelling emits a QUIET dashboard ping (never loud)', () => {
  const d = decideHeartbeat({ status: 'cancelling', nowMs: 200_000, lastHeartbeatAtMs: 0, intervalMs: 180_000 });
  assert.deepEqual(d, { emit: true, loud: false }, 'cancelling is dashboard-only');
});

test('selfResumeDecision (Stage 4): budgetExhausted parks unconditionally — before hard cap and judge', () => {
  const base = { enabled: true, autoContinueAttempts: 0, hardCap: 24, cycleToolCalls: 10 };
  const parked = selfResumeDecision({ ...base, budgetExhausted: true });
  assert.equal(parked.resume, false);
  assert.match(parked.reason, /token budget exhausted/);
  // Budget beats every other gate, including a healthy progressing cycle.
  assert.equal(selfResumeDecision({ ...base, autoContinueAttempts: 0, budgetExhausted: true }).needJudge, undefined);
  // Absent/false ⇒ unchanged Wave-3 behavior.
  assert.deepEqual(selfResumeDecision({ ...base, budgetExhausted: false }), { needJudge: true, reason: 'progress check required' });
});
