/**
 * Run: npx tsx --test src/execution/background-tasks.test.ts
 *
 * Covers the boot-time auto-resume of interrupted background tasks:
 *   - resumeInterruptedBackgroundTasks re-queues an `interrupted` task
 *     once, stamps the original so it's not re-spawned, and respects the
 *     resume cap so a crash-looping task can't resume forever.
 *
 * Per-test temp dir via CLEMENTINE_HOME so we don't touch real state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-bgtasks-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_HARNESS_BACKGROUND = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  createBackgroundTask,
  markBackgroundTaskFailed,
  markBackgroundTaskDone,
  getBackgroundTask,
  listBackgroundTasks,
  resumeInterruptedBackgroundTasks,
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
} = await import('./background-tasks.js');
const { enqueueDurableChatTask } = await import('./background-promote.js');
const { isAutoApprovedByScope, getPlanScope } = await import('../agents/plan-scope.js');
const { SessionStore } = await import('../memory/session-store.js');
const { recordWorkerResult, clearLedger, summarizeLedger } = await import('../runtime/harness/fanout-ledger.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('resumeInterruptedBackgroundTasks re-queues once and respects the cap', () => {
  const task = createBackgroundTask({ title: 'Analyze meeting transcript: zoom', prompt: 'do the thing' });
  markBackgroundTaskFailed(task.id, 'Daemon restarted while task was running.', 'interrupted');

  // First boot: the interrupted task is resumed exactly once.
  const resumed = resumeInterruptedBackgroundTasks({ cap: 2 });
  assert.equal(resumed, 1);

  const original = getBackgroundTask(task.id);
  assert.ok(original?.resumedIntoTaskId, 'original should be stamped with the resume id');
  const child = getBackgroundTask(original!.resumedIntoTaskId!);
  assert.equal(child?.status, 'pending', 'resume should be a fresh pending task');
  assert.equal(child?.resumeCount, 1);

  // Second boot with the SAME interrupted original still on disk: it's
  // already carried forward, so it must not be re-spawned.
  assert.equal(resumeInterruptedBackgroundTasks({ cap: 2 }), 0, 'stamped original is not re-resumed');

  // Now interrupt the child (resumeCount=1) and confirm it resumes once
  // more (cap=2), then a grandchild at the cap does not.
  markBackgroundTaskFailed(child!.id, 'Daemon restarted while task was running.', 'interrupted');
  assert.equal(resumeInterruptedBackgroundTasks({ cap: 2 }), 1, 'resumeCount 1 < cap 2 resumes');

  const grandchild = listBackgroundTasks({ status: 'pending' })
    .find((t) => t.resumeCount === 2);
  assert.ok(grandchild, 'grandchild created at resumeCount 2');
  markBackgroundTaskFailed(grandchild!.id, 'Daemon restarted while task was running.', 'interrupted');
  assert.equal(resumeInterruptedBackgroundTasks({ cap: 2 }), 0, 'resumeCount 2 >= cap 2 does not resume');
});

test('resumeInterruptedBackgroundTasks ignores non-restart interrupted tasks', () => {
  const task = createBackgroundTask({ title: 'Manual interrupted task', prompt: 'do not restart this automatically' });
  markBackgroundTaskFailed(task.id, 'Interrupted manually during review.', 'interrupted');

  assert.equal(resumeInterruptedBackgroundTasks({ cap: 2 }), 0);
  assert.equal(getBackgroundTask(task.id)?.resumedIntoTaskId, undefined);
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

test('queueBackgroundTaskInputResolution re-queues with the freeform answer', () => {
  const task = createBackgroundTask({ title: 'Pull accounts', prompt: 'pull', originSessionId: 'console:home' });
  markBackgroundTaskAwaitingInput(task.id, 'q-2', 'How many?');
  const resumed = queueBackgroundTaskInputResolution('q-2', 'just my market-leader accounts');
  assert.equal(resumed?.status, 'pending', 're-queued for the daemon to resume');
  assert.equal(resumed?.inputResolution?.answer, 'just my market-leader accounts');
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
