/**
 * Run: npx tsx --test src/shared/activity-snapshot.test.ts
 *
 * The shared activity snapshot is a read-only, fail-open builder the dashboard,
 * Slack, and Discord surfaces all consume. These pin that it: builds an empty
 * but well-formed snapshot with no data (never throws), surfaces running
 * background tasks with elapsed + live worker counts folded from operational
 * events, counts "waiting on you" and "recently done", and that the compact
 * formatters behave.
 *
 * Per-test temp dir via CLEMENTINE_HOME (BINDING) so we never touch real state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-activity-snapshot-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_HARNESS_BACKGROUND = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  buildActivitySnapshot,
  formatElapsed,
  formatNextRun,
  isHarnessTerminalEvent,
} = await import('./activity-snapshot.js');
const bg = await import('../execution/background-tasks.js');
const { recordOperationalEvent } = await import('../runtime/operational-telemetry.js');

test('buildActivitySnapshot returns a well-formed, empty snapshot with no data and never throws', () => {
  const snap = buildActivitySnapshot();
  assert.ok(Array.isArray(snap.runningNow));
  assert.ok(Array.isArray(snap.upcoming));
  assert.ok(Array.isArray(snap.recentDone));
  assert.equal(typeof snap.needsYou.count, 'number');
  assert.equal(snap.counts.running, snap.runningNow.length);
  assert.equal(snap.counts.upcoming, snap.upcoming.length);
  assert.equal(snap.counts.needsYou, snap.needsYou.count);
});

test('a running background task appears in runningNow with elapsed + queued state distinction', () => {
  const running = bg.createBackgroundTask({ title: 'Analyze five firms', prompt: 'do the thing', maxMinutes: 30 });
  bg.markBackgroundTaskRunning(running.id);
  const queued = bg.createBackgroundTask({ title: 'Draft the brief', prompt: 'draft', maxMinutes: 30 });

  const snap = buildActivitySnapshot();
  const runRow = snap.runningNow.find((r) => r.id === running.id);
  const queuedRow = snap.runningNow.find((r) => r.id === queued.id);

  assert.ok(runRow, 'running task is in runningNow');
  assert.equal(runRow?.kind, 'task');
  assert.equal(runRow?.title, 'Analyze five firms');
  assert.equal(runRow?.sessionId, running.runSessionId);
  assert.ok((runRow?.elapsedMs ?? -1) >= 0, 'elapsed is computed');

  assert.ok(queuedRow, 'pending task is in runningNow');
  assert.equal(queuedRow?.kind, 'queued', 'pending tasks are labeled queued');

  assert.ok(snap.counts.running >= 2);
});

test('live worker counts are folded from recent operational events onto the owning session', () => {
  const task = bg.createBackgroundTask({ title: 'Fan out to workers', prompt: 'swarm', maxMinutes: 30 });
  bg.markBackgroundTaskRunning(task.id);
  const sessionId = task.runSessionId;

  // Three spawned, one completed → 2 active. Plus one queued.
  recordOperationalEvent({ source: 'harness', type: 'worker_spawned', sessionId });
  recordOperationalEvent({ source: 'harness', type: 'worker_spawned', sessionId });
  recordOperationalEvent({ source: 'harness', type: 'worker_spawned', sessionId });
  recordOperationalEvent({ source: 'harness', type: 'worker_completed', sessionId });
  recordOperationalEvent({ source: 'harness', type: 'worker_queued', sessionId });

  const snap = buildActivitySnapshot();
  const row = snap.runningNow.find((r) => r.id === task.id);
  assert.ok(row?.workers, 'worker counts present');
  assert.equal(row?.workers?.active, 2);
  assert.equal(row?.workers?.queued, 1);
});

test('an open approval on a running session sets needsApproval; a resolved one clears it', () => {
  const task = bg.createBackgroundTask({ title: 'Gated write', prompt: 'write', maxMinutes: 30 });
  bg.markBackgroundTaskRunning(task.id);
  const sessionId = task.runSessionId;

  recordOperationalEvent({ source: 'safety', type: 'approval_required', sessionId });
  let row = buildActivitySnapshot().runningNow.find((r) => r.id === task.id);
  assert.equal(row?.needsApproval, true);

  recordOperationalEvent({ source: 'safety', type: 'approval_resolved', sessionId });
  row = buildActivitySnapshot().runningNow.find((r) => r.id === task.id);
  assert.notEqual(row?.needsApproval, true, 'resolved approval clears the marker');
});

test('recentDone carries finished tasks with an ok flag, and doneToday counts today', () => {
  const done = bg.createBackgroundTask({ title: 'Finished job', prompt: 'x', maxMinutes: 30 });
  bg.markBackgroundTaskRunning(done.id);
  bg.markBackgroundTaskDone(done.id, 'all set');

  const snap = buildActivitySnapshot();
  const doneRow = snap.recentDone.find((r) => r.title === 'Finished job');
  assert.ok(doneRow, 'done task is in recentDone');
  assert.equal(doneRow?.ok, true);
  assert.ok(snap.counts.doneToday >= 1, 'a task completed today is counted');
});

test('formatElapsed / formatNextRun produce compact, bounded strings', () => {
  assert.equal(formatElapsed(undefined), '');
  assert.equal(formatElapsed(-5), '');
  assert.equal(formatElapsed(30_000), '<1m');
  assert.equal(formatElapsed(12 * 60_000), '12m');
  assert.equal(formatElapsed(3 * 60 * 60_000), '3h');
  assert.equal(formatElapsed(2 * 24 * 60 * 60_000), '2d');

  const now = new Date('2026-07-01T12:00:00.000Z');
  assert.equal(formatNextRun(new Date(now.getTime() - 1000).toISOString(), now), 'soon');
  assert.equal(formatNextRun(new Date(now.getTime() + 5 * 60_000).toISOString(), now), 'in 5m');
  assert.equal(formatNextRun(new Date(now.getTime() + 3 * 60 * 60_000).toISOString(), now), 'in 3h');
});

test('isHarnessTerminalEvent marks run/approval boundaries terminal, in-flight events not', () => {
  assert.equal(isHarnessTerminalEvent('run_completed'), true);
  assert.equal(isHarnessTerminalEvent('approval_requested'), true);
  assert.equal(isHarnessTerminalEvent('awaiting_user_input'), true);
  assert.equal(isHarnessTerminalEvent('tool_called'), false);
  assert.equal(isHarnessTerminalEvent('turn_started'), false);
});
