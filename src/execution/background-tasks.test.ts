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
  getBackgroundTask,
  listBackgroundTasks,
  resumeInterruptedBackgroundTasks,
} = await import('./background-tasks.js');

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
