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

const { createBackgroundTask, markBackgroundTaskDone } = await import('./background-tasks.js');
const { recordToolEvent } = await import('../agents/tool-observability.js');
const {
  getBackgroundTaskStatus,
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
