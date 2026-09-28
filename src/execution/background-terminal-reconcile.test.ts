import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-background-terminal-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const tasks = await import('./background-tasks.js');
const { createSession, getSession, appendEvent, openEventLog, closeEventLog } = await import('../runtime/harness/eventlog.js');
const { startRun, getRun } = await import('../runtime/run-events.js');
const { closeMemoryDb } = await import('../memory/db.js');
after(() => { closeEventLog(); closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });

let counter = 0;
function parkedAttempt(active = false) {
  const task = tasks.createBackgroundTask({ title: `Analyze capture ${++counter}`, prompt: 'Analyze a saved capture.', source: 'daemon' });
  const running = tasks.markBackgroundTaskRunning(task.id)!;
  if (!getSession(task.runSessionId)) createSession({ id: task.runSessionId, kind: 'execution' });
  startRun({ id: `run-${task.id}`, sessionId: task.runSessionId, source: 'daemon', message: task.prompt });
  const source = appendEvent({ sessionId: task.runSessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: task.prompt } });
  openEventLog().prepare('INSERT INTO run_attempts (attempt_id,session_id,started_at,finished_at,status,source_user_seq) VALUES (?,?,?,?,?,?)')
    .run(`attempt-${task.id}`, task.runSessionId, running.startedAt, active ? null : new Date().toISOString(), active ? 'running' : 'interrupted', source.seq);
  appendEvent({ sessionId: task.runSessionId, turn: 1, role: 'system', type: 'conversation_completed', data: {
    sourceUserSeq: source.seq, reason: 'awaiting_user_input', reply: 'Which source should I use?', awaitingUser: true,
  } });
  return { task, source };
}

test('late exact-source input terminal releases background capacity and clears Thinking without claiming completion', async () => {
  const { task } = parkedAttempt();
  await tasks.reconcileSettledBackgroundTaskInputs();
  assert.equal(tasks.getBackgroundTask(task.id)?.status, 'awaiting_input');
  assert.equal(getRun(`run-${task.id}`)?.status, 'awaiting_input');
  assert.equal(tasks.getBackgroundTask(task.id)?.pendingQuestion, 'Which source should I use?');
  assert.equal(await tasks.reconcileSettledBackgroundTaskInputs(), 0, 'repeat reconciliation has no second transition');
});

test('a live attempt and an older source terminal cannot park current work', async () => {
  const live = parkedAttempt(true);
  const newer = parkedAttempt();
  appendEvent({ sessionId: newer.task.runSessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'New scope.' } });
  await tasks.reconcileSettledBackgroundTaskInputs();
  assert.equal(tasks.getBackgroundTask(live.task.id)?.status, 'running');
  assert.equal(tasks.getBackgroundTask(newer.task.id)?.status, 'running');
});

test('a stopped orphan with no active attempt settles cancelled, never resumable or done', async () => {
  const { task } = parkedAttempt();
  tasks.cancelBackgroundTask(task.id);
  await tasks.reconcileSettledBackgroundTaskInputs();
  assert.equal(tasks.getBackgroundTask(task.id)?.status, 'aborted');
  assert.equal(getRun(`run-${task.id}`)?.status, 'cancelled');
});

test('an old attempt cannot settle a newly started incarnation of the same task', async () => {
  const { task } = parkedAttempt();
  tasks.updateBackgroundTask(task.id, { startedAt: new Date(Date.now() + 60_000).toISOString() });
  await tasks.reconcileSettledBackgroundTaskInputs();
  assert.equal(tasks.getBackgroundTask(task.id)?.status, 'running');
});
