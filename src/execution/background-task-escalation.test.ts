/**
 * Run: npx tsx --test src/execution/background-task-escalation.test.ts
 *
 * 2026-07-08 — watchdog ESCALATION. Two live zombie tasks were warned "silent"
 * 185 and 169 consecutive ticks while the board showed them running for days.
 * A running task silent past the escalation window is closed as `interrupted`
 * (one notification), not observed forever.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TEST_HOME = '/tmp/clemmy-test-bgtask-escalation';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { createBackgroundTask, markBackgroundTaskRunning, listBackgroundTasks } = await import('./background-tasks.js');
const { runBackgroundTaskWatchdog } = await import('./background-task-watchdog.js');
const { loadNotifications } = await import('../runtime/notifications.js');

const HOUR = 60 * 60_000;

beforeEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  delete process.env.CLEMMY_BGTASK_ESCALATE;
});

function makeSilentRunningTask(silentForMs: number): string {
  const t = createBackgroundTask({ prompt: 'long research sweep', title: 'Long research sweep', maxMinutes: 30 } as never);
  markBackgroundTaskRunning(t.id);
  // Backdate the record ON DISK — updateBackgroundTask() always re-stamps
  // updatedAt to now, which is right in production and wrong for simulating a
  // task that has been silent for hours.
  const file = path.join(TEST_HOME, 'state', 'background-tasks', `${t.id}.json`);
  const rec = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  const past = new Date(Date.now() - silentForMs).toISOString();
  rec.startedAt = past;
  rec.updatedAt = past;
  writeFileSync(file, JSON.stringify(rec, null, 2), 'utf-8');
  return t.id;
}

test('a running task silent past the escalation window is CLOSED as interrupted + notified once', () => {
  const id = makeSilentRunningTask(7 * HOUR);
  const { stalled } = runBackgroundTaskWatchdog();
  assert.ok(stalled >= 1, 'the zombie was detected');
  const task = listBackgroundTasks().find((t) => t.id === id);
  assert.equal(task?.status, 'interrupted', 'the zombie is closed, not observed forever');
  const notes = loadNotifications();
  assert.ok(notes.some((n) => n.id === `bgtask-escalated-${id}`), 'one escalation notification was minted');
  // A second tick neither re-flags nor re-notifies — the task is terminal now.
  const again = runBackgroundTaskWatchdog();
  assert.equal(again.stalled, 0, 'a closed task stops churning the watchdog');
});

test('a task silent for LESS than the window keeps the observe-only alert (not closed)', () => {
  const id = makeSilentRunningTask(2 * HOUR);
  runBackgroundTaskWatchdog();
  const task = listBackgroundTasks().find((t) => t.id === id);
  assert.equal(task?.status, 'running', 'still running — only the deduped alert fires');
  const notes = loadNotifications();
  assert.ok(notes.some((n) => n.id === `bgtask-stalled-running_stalled-${id}`), 'the observe-only alert exists');
  assert.ok(!notes.some((n) => n.id === `bgtask-escalated-${id}`), 'no premature escalation');
});

test('CLEMMY_BGTASK_ESCALATE=off restores pure observe-only behavior', () => {
  process.env.CLEMMY_BGTASK_ESCALATE = 'off';
  const id = makeSilentRunningTask(9 * HOUR);
  runBackgroundTaskWatchdog();
  const task = listBackgroundTasks().find((t) => t.id === id);
  assert.equal(task?.status, 'running', 'kill-switch: the watchdog never mutates');
});
