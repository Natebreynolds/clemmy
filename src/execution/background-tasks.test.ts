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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  registerBackgroundDrainKick,
  requestBackgroundDrain,
  markBackgroundTaskRunning,
  truncateResultBody,
  backgroundHeartbeatInternalsForTest,
} = await import('./background-tasks.js');
const { enqueueDurableChatTask } = await import('./background-promote.js');
const { isAutoApprovedByScope, getPlanScope } = await import('../agents/plan-scope.js');
const { SessionStore } = await import('../memory/session-store.js');
const { recordWorkerResult, clearLedger, summarizeLedger } = await import('../runtime/harness/fanout-ledger.js');
const { createSession, appendEvent, getSession } = await import('../runtime/harness/eventlog.js');
const { listNotifications, getNotificationDestinationsForRecord } = await import('../runtime/notifications.js');
const { markBackgroundTaskBlocked } = await import('./background-tasks.js');
const { listOperationalEvents } = await import('../runtime/operational-telemetry.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
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
// (elapsed + tool count + current activity), rate-limited to one per interval,
// default ON, revertible via CLEMMY_LOUD_PROGRESS_CHECKINS.
const {
  loudProgressCheckInsEnabled,
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

test('decideHeartbeat: running past the interval emits a LOUD heartbeat by default', () => {
  const prev = process.env.CLEMMY_LOUD_PROGRESS_CHECKINS;
  delete process.env.CLEMMY_LOUD_PROGRESS_CHECKINS;
  try {
    assert.equal(loudProgressCheckInsEnabled(), true, 'default ON');
    const d = decideHeartbeat({ status: 'running', nowMs: 200_000, lastHeartbeatAtMs: 0, intervalMs: 180_000 });
    assert.deepEqual(d, { emit: true, loud: true });
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_LOUD_PROGRESS_CHECKINS;
    else process.env.CLEMMY_LOUD_PROGRESS_CHECKINS = prev;
  }
});

test('decideHeartbeat: within the interval is rate-limited (no second loud message)', () => {
  const d = decideHeartbeat({ status: 'running', nowMs: 100_000, lastHeartbeatAtMs: 0, intervalMs: 180_000 });
  assert.deepEqual(d, { emit: false, loud: false });
});

test('decideHeartbeat: kill-switch reverts to a silent, dashboard-only ping', () => {
  const prev = process.env.CLEMMY_LOUD_PROGRESS_CHECKINS;
  process.env.CLEMMY_LOUD_PROGRESS_CHECKINS = '0';
  try {
    assert.equal(loudProgressCheckInsEnabled(), false);
    const d = decideHeartbeat({ status: 'running', nowMs: 200_000, lastHeartbeatAtMs: 0, intervalMs: 180_000 });
    assert.deepEqual(d, { emit: true, loud: false }, 'still recorded on the dashboard, just not loud');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_LOUD_PROGRESS_CHECKINS;
    else process.env.CLEMMY_LOUD_PROGRESS_CHECKINS = prev;
  }
});

test('decideHeartbeat: "false"/"off" also disable loud heartbeats', () => {
  const prev = process.env.CLEMMY_LOUD_PROGRESS_CHECKINS;
  try {
    for (const val of ['false', 'OFF', 'False']) {
      process.env.CLEMMY_LOUD_PROGRESS_CHECKINS = val;
      assert.equal(loudProgressCheckInsEnabled(), false, `"${val}" disables`);
    }
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_LOUD_PROGRESS_CHECKINS;
    else process.env.CLEMMY_LOUD_PROGRESS_CHECKINS = prev;
  }
});

test('decideHeartbeat: terminal and awaiting states stop heartbeats entirely', () => {
  for (const status of ['done', 'failed', 'aborted', 'interrupted', 'awaiting_approval', 'awaiting_input', 'awaiting_continue'] as const) {
    const d = decideHeartbeat({ status, nowMs: 10_000_000, lastHeartbeatAtMs: 0, intervalMs: 180_000 });
    assert.deepEqual(d, { emit: false, loud: false }, `no heartbeat when ${status}`);
  }
});

test('decideHeartbeat: cancelling emits a QUIET dashboard ping (never loud)', () => {
  const prev = process.env.CLEMMY_LOUD_PROGRESS_CHECKINS;
  delete process.env.CLEMMY_LOUD_PROGRESS_CHECKINS;
  try {
    const d = decideHeartbeat({ status: 'cancelling', nowMs: 200_000, lastHeartbeatAtMs: 0, intervalMs: 180_000 });
    assert.deepEqual(d, { emit: true, loud: false }, 'cancelling is dashboard-only even with the kill-switch ON');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_LOUD_PROGRESS_CHECKINS;
    else process.env.CLEMMY_LOUD_PROGRESS_CHECKINS = prev;
  }
});
