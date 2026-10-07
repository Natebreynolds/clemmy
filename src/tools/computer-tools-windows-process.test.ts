import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { type spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = mkdtempSync(path.join(os.tmpdir(), 'clem-windows-shell-receipt-'));
process.env.CLEMENTINE_HOME = fixture;
mkdirSync(path.join(fixture, 'state'), { recursive: true });
const tools = await import('./computer-tools.js');

function childProcess() {
  return Object.assign(new EventEmitter(), {
    pid: 42, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, unref: () => {},
  });
}

test('shell deadline waits for cleanup and forbids another dispatch while receipt is pending or incomplete', async () => {
  tools._testOnly_resetShellCleanupState();
  const child = childProcess(); let spawns = 0;
  const spawnProcess = (() => { spawns += 1; return child; }) as unknown as typeof spawn;
  let finishStop!: (receipt: 'complete' | 'incomplete') => void;
  let startedStop!: () => void;
  const stopStarted = new Promise<void>(resolve => { startedStop = resolve; });
  const stopTree = () => { startedStop(); return new Promise<'complete' | 'incomplete'>(resolve => { finishStop = resolve; }); };
  const runtime = { platform: 'win32' as const, spawnProcess, stopTree };
  try {
    const command = tools._testOnly_runShellCommand('echo fixture', fixture, 10, runtime);
    let resolved = false; const failure = command.catch(error => { resolved = true; return error; });
    await stopStarted;
    assert.equal(resolved, false);
    await assert.rejects(tools._testOnly_runShellCommand('echo later', fixture, 10, runtime), error => {
      assert.equal((error as { outcome: { dispatch: string } }).outcome.dispatch, 'not_started');
      return /No command was started.*not been confirmed stopped/.test(String(error));
    });
    child.emit('close', 0);
    assert.equal(resolved, false, 'late parent exit cannot replace the tree receipt');
    finishStop('incomplete');
    const error = await failure;
    assert.equal(error.outcome.timeoutCleanup, 'incomplete');
    assert.match(error.message, /verify any completed effects.*restart Clem/);
    await assert.rejects(tools._testOnly_runShellCommand('echo again', fixture, 10, runtime), /No command was started/);
    assert.equal(spawns, 1);
  } finally { tools._testOnly_resetShellCleanupState(); }
});

test('a confirmed cleanup leaves the next independent shell command usable', async () => {
  tools._testOnly_resetShellCleanupState();
  const first = childProcess();
  await assert.rejects(tools._testOnly_runShellCommand('echo fixture', fixture, 10, {
    platform: 'win32', spawnProcess: (() => first) as unknown as typeof spawn, stopTree: async () => 'complete',
  }), error => (error as { outcome: { timeoutCleanup: string } }).outcome.timeoutCleanup === 'complete');
  const second = childProcess();
  const result = tools._testOnly_runShellCommand('echo next', fixture, 1000, {
    platform: 'win32', spawnProcess: (() => second) as unknown as typeof spawn,
  });
  second.stdout.write('next'); second.emit('close', 0);
  assert.equal((await result).outcome.exitCode, 0);
});
