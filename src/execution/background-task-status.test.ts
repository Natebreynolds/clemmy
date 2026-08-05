/**
 * Run: npx tsx --test src/execution/background-task-status.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-bgtask-status-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  archiveBackgroundTask,
  createBackgroundTask,
  listBackgroundTasks,
  markBackgroundTaskAwaitingContinue,
  markBackgroundTaskAwaitingInput,
  markBackgroundTaskDone,
} = await import('./background-tasks.js');
const { recordToolEvent } = await import('../agents/tool-observability.js');
const {
  getBackgroundTaskStatus,
  listBackgroundTaskStatusSummaries,
  renderBackgroundTaskStatus,
  resolveBackgroundTask,
} = await import('./background-task-status.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('background task status resolves ids and includes tool activity/result', () => {
  const task = createBackgroundTask({
    title: 'Write local report',
    prompt: 'write a local markdown report',
    source: 'discord',
  });
  recordToolEvent({
    at: new Date().toISOString(),
    sessionId: task.runSessionId,
    toolName: 'write_file',
    kind: 'write',
    phase: 'end',
    outcome: 'success',
    durationMs: 42,
    argsSummary: '/tmp/report.md',
  });
  markBackgroundTaskDone(task.id, 'Report complete.');

  assert.equal(resolveBackgroundTask(`run-${task.id}`)?.id, task.id);
  assert.equal(resolveBackgroundTask(task.runSessionId)?.id, task.id);

  const details = getBackgroundTaskStatus(task.id);
  assert.ok(details);
  assert.equal(details.task.status, 'done');
  assert.equal(details.toolEvents.length, 1);
  assert.equal(details.toolEvents[0]?.toolName, 'write_file');
  assert.match(renderBackgroundTaskStatus(details), /Report complete/);
});

test('background task status summaries include awaiting_continue in active work', () => {
  const task = createBackgroundTask({
    title: 'Continue long task',
    prompt: 'keep going',
    source: 'desktop',
  });
  markBackgroundTaskAwaitingContinue(task.id, 'turn budget', 'partial');

  const active = listBackgroundTaskStatusSummaries({ status: 'active', limit: 20 });
  assert.ok(active.some((item) => item.task.id === task.id && item.task.status === 'awaiting_continue'));
});

test('background task status resolves an awaiting_input task by default', () => {
  for (const existing of listBackgroundTasks()) archiveBackgroundTask(existing.id);
  const task = createBackgroundTask({
    title: 'Needs a decision',
    prompt: 'ask before continuing',
    source: 'desktop',
  });
  markBackgroundTaskAwaitingInput(task.id, 'q-status-default', 'Which segment should I use?');

  assert.equal(resolveBackgroundTask()?.id, task.id);
  const details = getBackgroundTaskStatus();
  assert.equal(details?.task.id, task.id);
  assert.equal(details?.task.status, 'awaiting_input');
});

test('a running task renders concrete progress: elapsed, tool tally, fan-out counts — and honest latest activity', async () => {
  const { markBackgroundTaskRunning, archiveBackgroundTask: archive2, listBackgroundTasks: list2 } = await import('./background-tasks.js');
  const { appendEvent } = await import('../runtime/harness/eventlog.js');
  for (const existing of list2()) archive2(existing.id);

  const task = createBackgroundTask({
    title: 'Research 29 dormant accounts',
    prompt: 'research + draft',
    source: 'desktop',
  });
  markBackgroundTaskRunning(task.id);

  appendEvent({
    sessionId: task.runSessionId, turn: 1, role: 'agent', type: 'tool_called',
    data: { tool: 'web_search', callId: 'c1', arguments: '{}' },
  });
  appendEvent({
    sessionId: task.runSessionId, turn: 1, role: 'agent', type: 'batch_progress',
    data: { batchId: 'accounts', done: 12, total: 29, failed: 1 },
  });

  const details = getBackgroundTaskStatus(task.id);
  assert.ok(details);
  assert.equal(details.toolCallCount, 1, 'the authoritative tool tally is computed');

  const rendered = renderBackgroundTaskStatus(details);
  // The three quantitative floors a "how's it going?" answer needs:
  assert.match(rendered, /Elapsed: /, 'a running task reports elapsed time');
  assert.match(rendered, /Tool calls so far: 1/, 'the tool tally is RENDERED, not just computed');
  assert.match(rendered, /items: 12\/29 done \(1 failed\)/, 'fan-out counts reach the render without a work manifest');
  // Regression: "Latest activity" must never collapse to the bare record echo
  // while real run activity exists.
  assert.ok(
    !/Latest activity: [^\n]*Task status is running\./.test(rendered),
    'latest activity reflects real run events, not the task record fallback',
  );
});

test('a task with no run activity falls back to an honest no-activity line', async () => {
  const { archiveBackgroundTask: archive3, listBackgroundTasks: list3 } = await import('./background-tasks.js');
  for (const existing of list3()) archive3(existing.id);
  const task = createBackgroundTask({ title: 'Just created', prompt: 'not started', source: 'desktop' });
  const details = getBackgroundTaskStatus(task.id);
  assert.ok(details);
  // The queue notification is real activity and an acceptable answer; the bare
  // record echo ("Task status is pending.") is the regression this pins out.
  assert.ok(details.latestActivitySummary, 'a latest-activity line still exists');
  assert.ok(
    !/^Task status is \w+\.$/.test(details.latestActivitySummary ?? ''),
    'the record-echo candidate never outranks real activity or the honest fallback',
  );
});

test('the chat prompt snapshot names active work with counts; silent when idle', async () => {
  const { renderActiveBackgroundWorkForInstructions } = await import('./background-task-status.js');
  const { markBackgroundTaskRunning: run4, archiveBackgroundTask: archive4, listBackgroundTasks: list4 } = await import('./background-tasks.js');
  for (const existing of list4()) archive4(existing.id);

  assert.equal(renderActiveBackgroundWorkForInstructions(), '', 'no active work → zero prompt overhead');

  const task = createBackgroundTask({
    title: 'Research 29 dormant accounts',
    prompt: 'research + draft',
    source: 'desktop',
  });
  run4(task.id);

  const block = renderActiveBackgroundWorkForInstructions();
  assert.match(block, /Research 29 dormant accounts/, 'the running task is named every turn');
  assert.match(block, /\[running\]/, 'its live status is visible');
  assert.match(block, /background_task_status/, 'the model is pointed at the deep-status tool');

  for (const existing of list4()) archive4(existing.id);
});
