import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stopWindowsProcessTree, windowsSystemRoot } from './windows-process-tree.js';

function simulatedUtility(outcome: 'ok' | 'error' | 'nonzero' | 'hang') {
  const calls: unknown[][] = [];
  let killed = false;
  const utility = Object.assign(new EventEmitter(), { kill() { killed = true; return true; }, unref() {} }) as unknown as ChildProcess;
  const spawnProcess = ((...args: unknown[]) => {
    calls.push(args);
    if (outcome !== 'hang') setTimeout(() => {
      if (outcome === 'error') utility.emit('error', new Error('fixture failure'));
      else utility.emit('close', outcome === 'ok' ? 0 : 1);
    }, 5);
    return utility;
  }) as typeof spawn;
  return { spawnProcess, calls, utility, wasKilled: () => killed };
}

test('tree stop awaits the exact OS utility receipt and withholds unrelated environment', async () => {
  const utility = simulatedUtility('ok');
  const child = { pid: 42, kill: () => { throw new Error('parent must not be killed after receipt'); } };
  const stopped = stopWindowsProcessTree(child, { spawnProcess: utility.spawnProcess,
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\project', OPENAI_API_KEY: 'fixture-not-a-real-secret' } });
  let resolved = false; void stopped.then(() => { resolved = true; });
  await Promise.resolve(); assert.equal(resolved, false);
  assert.equal(await stopped, 'complete');
  assert.equal(utility.calls[0][0], 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(utility.calls[0][1], ['/PID', '42', '/T', '/F']);
  assert.deepEqual((utility.calls[0][2] as { env: unknown }).env, { SystemRoot: 'C:\\Windows' });
});

for (const outcome of ['error', 'nonzero', 'hang'] as const) test(`failed ${outcome} cleanup never claims a stopped tree`, async () => {
  const utility = simulatedUtility(outcome); let parentStops = 0;
  const child = { pid: 42, kill: () => { parentStops += 1; return true; } };
  assert.equal(await stopWindowsProcessTree(child, {spawnProcess: utility.spawnProcess, timeoutMs: 20}), 'incomplete');
  assert.equal(parentStops, 1);
  if (outcome === 'hang') assert.equal(utility.wasKilled(), true);
});

test('invalid process identity dispatches nothing; mixed-case OS root remains absolute', async () => {
  const utility = simulatedUtility('ok');
  for (const pid of [undefined, -1, 0, 1.5, NaN]) {
    assert.equal(await stopWindowsProcessTree({ pid, kill: () => true }, {spawnProcess: utility.spawnProcess}), 'incomplete');
  }
  assert.equal(utility.calls.length, 0);
  assert.equal(windowsSystemRoot({ systemroot: 'D:\\Windows' }), 'D:\\Windows');
  assert.throws(() => windowsSystemRoot({SystemRoot:'project'}), /absolute/);
});

test('actual Windows taskkill receipt arrives only after the owned descendant is gone', { skip: process.platform !== 'win32' }, async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'clem-windows-tree-'));
  const pidFile = path.join(fixture, 'child.pid');
  const program = path.join(fixture, 'parent.mjs');
  writeFileSync(program, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';\nconst c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); writeFileSync(process.argv[2],String(c.pid)); setInterval(()=>{},1000);\n`);
  const child = spawn(process.execPath, [program, pidFile], {stdio:'ignore',windowsHide:true});
  let descendant: number | undefined;
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(existsSync(pidFile), true, 'owned fixture starts');
    descendant = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(await stopWindowsProcessTree(child), 'complete');
    assert.throws(() => process.kill(descendant!, 0), 'descendant has stopped before receipt');
  } finally {
    await stopWindowsProcessTree(child);
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
    rmSync(fixture, {recursive:true,force:true});
  }
});
