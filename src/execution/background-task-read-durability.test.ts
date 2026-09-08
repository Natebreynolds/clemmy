import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clemmy-background-read-'));
process.env.CLEMENTINE_HOME = fixtureHome;
const { createBackgroundTask, getBackgroundTask, listBackgroundTasks } = await import('./background-tasks.js');
const { closeProspectiveIntentionsDbForTest } = await import('../runtime/prospective-intentions.js');
const taskDirectory = path.join(fixtureHome, 'state', 'background-tasks');

test.after(() => {
  closeProspectiveIntentionsDbForTest();
  fs.rmSync(fixtureHome, { recursive: true, force: true });
});

test('background inventory never creates or flushes state; task creation still durably publishes its directory chain', (t) => {
  const originalFsync = fs.fsyncSync;
  const flushedDirectories: Array<{ dev: number; ino: number }> = [];
  const flush = t.mock.method(fs, 'fsyncSync', (fd: number) => {
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory()) flushedDirectories.push({ dev: stat.dev, ino: stat.ino });
    originalFsync(fd);
  });
  const mkdir = t.mock.method(fs, 'mkdirSync');
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  assert.equal(fs.existsSync(taskDirectory), false);
  assert.deepEqual(listBackgroundTasks(), []);
  assert.equal(getBackgroundTask('missing'), null);
  assert.equal(fs.existsSync(taskDirectory), false);
  assert.equal(mkdir.mock.callCount(), 0, 'an empty inventory must not initialize storage');
  assert.equal(flush.mock.callCount(), 0);

  const task = createBackgroundTask({ title: 'Read-only inventory regression', prompt: 'Retain this task for inventory.' });
  assert.ok(fs.existsSync(path.join(taskDirectory, `${task.id}.json`)));
  assert.ok(flush.mock.callCount() > 0, 'task creation still flushes its durable record');
  if (process.platform !== 'win32') {
    for (const directory of [taskDirectory, path.dirname(taskDirectory), fixtureHome, path.dirname(fixtureHome)]) {
      const stat = fs.statSync(directory);
      assert.ok(flushedDirectories.some((seen) => seen.dev === stat.dev && seen.ino === stat.ino),
        `creation must durably publish the directory chain: ${directory}`);
    }
  }

  const flushCount = flush.mock.callCount();
  const mkdirCount = mkdir.mock.callCount();
  const originalBytes = fs.readFileSync(path.join(taskDirectory, `${task.id}.json`));
  for (let iteration = 0; iteration < 5; iteration += 1) {
    assert.deepEqual(listBackgroundTasks({ status: 'pending' }).map((row) => row.id), [task.id]);
    assert.equal(listBackgroundTasks({ status: 'running' }).length, 0);
    assert.equal(getBackgroundTask(task.id)?.id, task.id);
  }
  assert.equal(flush.mock.callCount(), flushCount, 'repeated timer/UI inventories must perform zero fsyncs');
  assert.equal(mkdir.mock.callCount(), mkdirCount, 'existing inventories must perform zero directory writes');
  assert.deepEqual(fs.readFileSync(path.join(taskDirectory, `${task.id}.json`)), originalBytes);
});
