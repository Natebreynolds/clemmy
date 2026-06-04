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
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  createBackgroundTask,
  markBackgroundTaskFailed,
  markBackgroundTaskDone,
  getBackgroundTask,
  listBackgroundTasks,
  resumeInterruptedBackgroundTasks,
  processBackgroundTasks,
  classifyBackgroundTaskOutcome,
} = await import('./background-tasks.js');
const { isAutoApprovedByScope, getPlanScope } = await import('../agents/plan-scope.js');
const { SessionStore } = await import('../memory/session-store.js');

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

  // Minimal ClementineAssistant stub. respond() stands in for the worker
  // run; we probe the scope from inside it (the exact window where internal
  // tools would otherwise re-prompt).
  const stubAssistant = {
    getRuntime() {
      return {} as never;
    },
    async respond(request: { sessionId: string }) {
      runSessionSeen = request.sessionId;
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
  assert.equal(approvedDuringRun, true, 'mutating tool must be pre-approved by the sticky scope mid-run');

  // The scope persists and covers all non-read tools for this run session.
  const scope = getPlanScope(task.runSessionId);
  assert.ok(scope, 'a plan scope should exist for the run session');
  assert.deepEqual(scope!.allowedTools, ['*'], 'background run scope covers all non-read tools');
  assert.equal(scope!.planProposalId, `background-task:${task.id}`);
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
