/**
 * Run: npx tsx --test src/execution/background-terminal-report-back.test.ts
 *
 * Pins the background completion crash window. A terminal task and the exact
 * report-back envelope must become durable in one task-file generation; each
 * delivery can then be replayed until its own durable acknowledgement lands.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-bg-report-outbox-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_HARNESS_BACKGROUND = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  _setBackgroundTaskTerminalReportBackFaultForTests,
  createBackgroundTask,
  drainBackgroundTaskTerminalReportBacks,
  getBackgroundTask,
  markBackgroundTaskDone,
  processBackgroundTasks,
  resumeInterruptedBackgroundTasks,
} = await import('./background-tasks.js');
const { SessionStore } = await import('../memory/session-store.js');
const { listNotifications } = await import('../runtime/notifications.js');

after(() => {
  _setBackgroundTaskTerminalReportBackFaultForTests(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function completionNotifications(taskId: string) {
  return listNotifications(500).filter((item) => (
    item.metadata?.backgroundTaskId === taskId
    && item.metadata?.terminalReportBack === true
    && item.title.startsWith('Background task completed:')
  ));
}

function outcomeTurns(sessionId: string, taskId: string) {
  return new SessionStore().get(sessionId).turns.filter((turn) => (
    typeof turn.text === 'string'
    && turn.text.startsWith(`[background task ${taskId} completed]`)
  ));
}

test('crash immediately after done persistence recovers the exact human + model envelopes once', () => {
  const sessionId = 'sess-bg-outbox-after-persist';
  const task = createBackgroundTask({
    title: 'Prepare the durable report',
    prompt: 'prepare it',
    originSessionId: sessionId,
  });
  const modelResult = [
    'The durable report is ready.',
    '',
    '## Evidence / Verification',
    '- Internal receipt bg-proof-1.',
  ].join('\n');

  _setBackgroundTaskTerminalReportBackFaultForTests((phase: string) => {
    if (phase === 'after_persist') throw new Error('simulated process death after terminal write');
  });
  assert.throws(
    () => markBackgroundTaskDone(task.id, modelResult),
    /simulated process death/,
  );

  const stranded = getBackgroundTask(task.id);
  assert.equal(stranded?.status, 'done', 'terminal state survived the crash');
  assert.ok(stranded?.terminalReportBack, 'the exact report envelope survived with it');
  assert.equal(stranded?.terminalReportBack?.detail, modelResult, 'model receives the full result');
  assert.match(stranded?.terminalReportBack?.notification.body ?? '', /durable report is ready/i);
  assert.doesNotMatch(
    stranded?.terminalReportBack?.notification.body ?? '',
    /Evidence \/ Verification/,
    'the persisted human notification uses the conversational projection',
  );
  assert.equal(stranded?.terminalReportBack?.notificationAcknowledgedAt, undefined);
  assert.equal(stranded?.terminalReportBack?.originAcknowledgedAt, undefined);
  assert.equal(completionNotifications(task.id).length, 0, 'nothing escaped before the injected crash');
  assert.equal(outcomeTurns(sessionId, task.id).length, 0);

  _setBackgroundTaskTerminalReportBackFaultForTests(null);
  const firstDrain = drainBackgroundTaskTerminalReportBacks({ limit: 10 });
  assert.equal(firstDrain.acknowledged, 1);
  const recovered = getBackgroundTask(task.id);
  assert.ok(recovered?.terminalReportBack?.notificationAcknowledgedAt);
  assert.ok(recovered?.terminalReportBack?.originAcknowledgedAt);
  assert.ok(recovered?.terminalReportBack?.acknowledgedAt);
  assert.equal(completionNotifications(task.id).length, 1);
  assert.equal(outcomeTurns(sessionId, task.id).length, 1);

  const immutableEnvelope = recovered?.terminalReportBack;
  drainBackgroundTaskTerminalReportBacks({ limit: 10 });
  markBackgroundTaskDone(task.id, 'A conflicting late physical completion.');
  assert.equal(completionNotifications(task.id).length, 1, 'retries never duplicate the notification');
  assert.equal(outcomeTurns(sessionId, task.id).length, 1, 'retries never duplicate the origin turn');
  assert.deepEqual(
    getBackgroundTask(task.id)?.terminalReportBack,
    immutableEnvelope,
    'the first immutable envelope and its acknowledgements remain authority',
  );
});

test('crash after notification delivery repairs its missing acknowledgement without a duplicate', () => {
  const sessionId = 'sess-bg-outbox-after-notification';
  const task = createBackgroundTask({
    title: 'Crash after notification',
    prompt: 'finish it',
    originSessionId: sessionId,
  });

  let crashed = false;
  _setBackgroundTaskTerminalReportBackFaultForTests((phase: string) => {
    if (!crashed && phase === 'after_notification_delivery') {
      crashed = true;
      throw new Error('simulated process death after notification');
    }
  });
  assert.throws(() => markBackgroundTaskDone(task.id, 'Finished once.'), /simulated process death/);
  assert.equal(completionNotifications(task.id).length, 1, 'notification reached its durable store');
  assert.equal(getBackgroundTask(task.id)?.terminalReportBack?.notificationAcknowledgedAt, undefined);
  assert.equal(outcomeTurns(sessionId, task.id).length, 0);

  _setBackgroundTaskTerminalReportBackFaultForTests(null);
  drainBackgroundTaskTerminalReportBacks({ limit: 10 });
  assert.equal(completionNotifications(task.id).length, 1, 'stable id turns replay into verification');
  assert.equal(outcomeTurns(sessionId, task.id).length, 1);
  assert.ok(getBackgroundTask(task.id)?.terminalReportBack?.acknowledgedAt);
});

test('crash after origin delivery repairs its missing acknowledgement without a duplicate turn', () => {
  const sessionId = 'sess-bg-outbox-after-origin';
  const task = createBackgroundTask({
    title: 'Crash after origin',
    prompt: 'finish it',
    originSessionId: sessionId,
  });

  let crashed = false;
  _setBackgroundTaskTerminalReportBackFaultForTests((phase: string) => {
    if (!crashed && phase === 'after_origin_delivery') {
      crashed = true;
      throw new Error('simulated process death after origin');
    }
  });
  assert.throws(() => markBackgroundTaskDone(task.id, 'Finished once.'), /simulated process death/);
  assert.equal(completionNotifications(task.id).length, 1);
  assert.equal(outcomeTurns(sessionId, task.id).length, 1, 'origin write landed before the crash');
  assert.ok(getBackgroundTask(task.id)?.terminalReportBack?.notificationAcknowledgedAt);
  assert.equal(getBackgroundTask(task.id)?.terminalReportBack?.originAcknowledgedAt, undefined);

  _setBackgroundTaskTerminalReportBackFaultForTests(null);
  drainBackgroundTaskTerminalReportBacks({ limit: 10 });
  assert.equal(completionNotifications(task.id).length, 1);
  assert.equal(outcomeTurns(sessionId, task.id).length, 1, 'duplicate acknowledgement does not append twice');
  assert.ok(getBackgroundTask(task.id)?.terminalReportBack?.acknowledgedAt);
});

test('internal and originless tasks preserve their existing delivery semantics', () => {
  const internal = createBackgroundTask({
    title: 'Internal plan unit',
    prompt: 'reduce internally',
    internal: true,
    originSessionId: 'sess-internal-no-terminal-report',
  });
  const internalDone = markBackgroundTaskDone(internal.id, 'Internal reducer result.');
  assert.equal(internalDone?.terminalReportBack, undefined, 'plan-owned units do not mint user report-back');
  assert.equal(completionNotifications(internal.id).length, 0);
  assert.equal(outcomeTurns('sess-internal-no-terminal-report', internal.id).length, 0);

  const originless = createBackgroundTask({
    title: 'Autonomous report',
    prompt: 'finish autonomously',
  });
  markBackgroundTaskDone(originless.id, 'Autonomous result.');
  const stored = getBackgroundTask(originless.id);
  assert.ok(stored?.terminalReportBack?.notificationAcknowledgedAt);
  assert.ok(stored?.terminalReportBack?.originAcknowledgedAt, 'no origin is an acknowledged no-op');
  assert.ok(stored?.terminalReportBack?.acknowledgedAt);
  assert.equal(completionNotifications(originless.id).length, 1);
});

test('boot and ordinary processor entry points drain persisted completions before new work', async () => {
  const bootTask = createBackgroundTask({
    title: 'Boot recovery report',
    prompt: 'finish before restart',
    originSessionId: 'sess-bg-outbox-boot-entry',
  });
  _setBackgroundTaskTerminalReportBackFaultForTests((phase: string) => {
    if (phase === 'after_persist') throw new Error('boot-boundary crash');
  });
  assert.throws(() => markBackgroundTaskDone(bootTask.id, 'Boot recovered result.'), /boot-boundary crash/);
  _setBackgroundTaskTerminalReportBackFaultForTests(null);

  assert.equal(resumeInterruptedBackgroundTasks({ cap: 1 }), 0, 'no interrupted worker needed resuming');
  assert.ok(getBackgroundTask(bootTask.id)?.terminalReportBack?.acknowledgedAt, 'boot entry drained the done report');

  const tickTask = createBackgroundTask({
    title: 'Tick recovery report',
    prompt: 'finish before tick',
    originSessionId: 'sess-bg-outbox-tick-entry',
  });
  _setBackgroundTaskTerminalReportBackFaultForTests((phase: string) => {
    if (phase === 'after_persist') throw new Error('tick-boundary crash');
  });
  assert.throws(() => markBackgroundTaskDone(tickTask.id, 'Tick recovered result.'), /tick-boundary crash/);
  _setBackgroundTaskTerminalReportBackFaultForTests(null);

  const processed = await processBackgroundTasks({} as never, 1);
  assert.equal(processed, 0, 'outbox recovery does not count as executing a new task');
  assert.ok(getBackgroundTask(tickTask.id)?.terminalReportBack?.acknowledgedAt, 'ordinary tick drained the done report');
  assert.equal(outcomeTurns('sess-bg-outbox-boot-entry', bootTask.id).length, 1);
  assert.equal(outcomeTurns('sess-bg-outbox-tick-entry', tickTask.id).length, 1);
});

test('a large result stays in its durable result file while the replay envelope remains bounded', () => {
  const sessionId = 'sess-bg-outbox-large-result';
  const task = createBackgroundTask({
    title: 'Large durable report',
    prompt: 'produce the full report',
    originSessionId: sessionId,
  });
  const fullResult = Array.from(
    { length: 30_000 },
    (_, index) => `record-${String(index).padStart(5, '0')}: verified source and analysis`,
  ).join('\n');

  markBackgroundTaskDone(task.id, fullResult);
  const stored = getBackgroundTask(task.id);
  assert.ok(stored?.resultPath, 'large result has a durable payload file');
  assert.equal(readFileSync(stored!.resultPath!, 'utf8'), fullResult, 'the full model result remains retrievable');
  assert.ok((stored?.terminalReportBack?.detail.length ?? Infinity) <= 4_000);
  assert.equal(
    stored?.terminalReportBack?.outcomePayload.detail,
    stored?.terminalReportBack?.detail,
    'the exact bounded replay body is persisted once',
  );
  assert.match(stored?.terminalReportBack?.detail ?? '', /background_task_status/);
  assert.match(stored?.terminalReportBack?.detail ?? '', new RegExp(task.id));

  const taskFile = path.join(TMP_HOME, 'state', 'background-tasks', `${task.id}.json`);
  assert.ok(
    statSync(taskFile).size < 30_000,
    `task/outbox carrier should stay bounded, got ${statSync(taskFile).size} bytes`,
  );
  const delivered = outcomeTurns(sessionId, task.id);
  assert.equal(delivered.length, 1);
  assert.ok(delivered[0]!.text.length < 6_000, 'origin transcript gets a preview, not the megabyte payload');
  assert.match(delivered[0]!.text, /background_task_status/);
});
