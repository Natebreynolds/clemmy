/**
 * Run: npx tsx --test src/execution/background-task-watchdog.test.ts
 *
 * The reports-back backstop for background tasks (mirrors the workflow watchdog):
 *   - a task that died mid-run (running past its budget + grace) is surfaced
 *   - an actively-progressing running task is NOT surfaced (no false positive)
 *   - a terminal task whose notification never delivered is surfaced (once)
 *   - a terminal task that DID report back (delivered notification) is skipped
 *   - aborted/interrupted/awaiting_approval are never flagged
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findStalledBackgroundTasks,
  reportedBackTaskIdsFrom,
  type BackgroundTaskWatchdogView,
} from './background-task-watchdog.js';

const NOW = Date.parse('2026-06-02T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

test('running task past its maxMinutes budget + grace → running_stalled', () => {
  const tasks: BackgroundTaskWatchdogView[] = [
    { id: 't1', title: 'Enrich prospects', status: 'running', startedAt: ago(40 * MIN), updatedAt: ago(40 * MIN), maxMinutes: 30 },
  ];
  const stalled = findStalledBackgroundTasks(tasks, NOW, new Set());
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].reason, 'running_stalled');
});

test('actively-progressing running task (recent updatedAt, within budget) is NOT flagged', () => {
  const tasks: BackgroundTaskWatchdogView[] = [
    { id: 't2', title: 'Long scrape', status: 'running', startedAt: ago(20 * MIN), updatedAt: ago(2 * MIN), maxMinutes: 120 },
  ];
  assert.equal(findStalledBackgroundTasks(tasks, NOW, new Set()).length, 0);
});

test('pending task stuck past the 30-min floor → running_stalled', () => {
  const tasks: BackgroundTaskWatchdogView[] = [
    { id: 't3', title: 'Queued task', status: 'pending', createdAt: ago(40 * MIN) },
  ];
  const stalled = findStalledBackgroundTasks(tasks, NOW, new Set());
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].reason, 'running_stalled');
});

test('terminal task with NO delivered notification → terminal_undelivered (within window)', () => {
  const tasks: BackgroundTaskWatchdogView[] = [
    { id: 't4', title: 'Done but lost', status: 'done', completedAt: ago(10 * MIN) },
  ];
  const stalled = findStalledBackgroundTasks(tasks, NOW, new Set());
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].reason, 'terminal_undelivered');
});

test('terminal task that DID report back (id in reportedBack) is skipped', () => {
  const tasks: BackgroundTaskWatchdogView[] = [
    { id: 't5', title: 'Done + delivered', status: 'done', completedAt: ago(10 * MIN) },
  ];
  assert.equal(findStalledBackgroundTasks(tasks, NOW, new Set(['t5'])).length, 0);
});

test('terminal task older than the 12h max window is NOT flagged (no historical backlog spam)', () => {
  const tasks: BackgroundTaskWatchdogView[] = [
    { id: 't6', title: 'Ancient', status: 'failed', completedAt: ago(13 * 60 * MIN) },
  ];
  assert.equal(findStalledBackgroundTasks(tasks, NOW, new Set()).length, 0);
});

test('aborted / interrupted / awaiting_approval are never flagged (known/handled states)', () => {
  const tasks: BackgroundTaskWatchdogView[] = [
    { id: 'a', title: 'x', status: 'aborted', completedAt: ago(10 * MIN) },
    { id: 'b', title: 'x', status: 'interrupted', updatedAt: ago(60 * MIN) },
    { id: 'c', title: 'x', status: 'awaiting_approval', updatedAt: ago(60 * MIN) },
  ];
  assert.equal(findStalledBackgroundTasks(tasks, NOW, new Set()).length, 0);
});

test('reportedBackTaskIdsFrom: only DELIVERED, non-watchdog notifications count', () => {
  const ids = reportedBackTaskIdsFrom([
    { id: 'n1', deliveredAt: ago(MIN), metadata: { backgroundTaskId: 'delivered' } },
    { id: 'n2', metadata: { backgroundTaskId: 'persisted-not-delivered' } }, // no deliveredAt → excluded
    { id: 'bgtask-stalled-terminal_undelivered-x', deliveredAt: ago(MIN), metadata: { backgroundTaskId: 'x' } }, // the watchdog's own alert → excluded
    { id: 'n3', deliveredDestinations: ['discord'], metadata: { backgroundTaskId: 'via-destinations' } },
  ]);
  assert.ok(ids.has('delivered'));
  assert.ok(ids.has('via-destinations'));
  assert.ok(!ids.has('persisted-not-delivered'));
  assert.ok(!ids.has('x'), "watchdog's own alert must not mask a lost result");
});
