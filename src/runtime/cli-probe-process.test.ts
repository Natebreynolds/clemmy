import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { test } from 'node:test';
import { createCliProbeRunner } from './cli-probe-process.js';

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid: 3456, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, unref: () => undefined });
  return child;
}
const options = { cwd: 'C:\\owned fixture', env: { SystemRoot: 'C:\\Windows' }, timeoutMs: 1_000, platform: 'win32' as const };

test('bounded probe preserves literal argv and separate successful stdout/account data', async () => {
  const child = fakeChild();
  const argv = ['status', 'literal & argument', 'café 日本語'];
  const run = createCliProbeRunner();
  const promise = run('C:\\space & café\\fixture.cmd', argv, {
    ...options,
    spawnProcess: ((command, args, opts) => {
      assert.equal(command, 'C:\\space & café\\fixture.cmd'); assert.deepEqual(args, argv);
      assert.equal(opts?.shell, undefined); assert.equal(opts?.windowsHide, true);
      return child;
    }) as typeof spawn,
  });
  child.stdout!.emit('data', Buffer.from('account café 日本語'));
  child.stderr!.emit('data', Buffer.from('diagnostic'));
  child.emit('close', 0);
  assert.deepEqual(await promise, { exitCode: 0, stdout: 'account café 日本語', stderr: 'diagnostic', output: 'account café 日本語\ndiagnostic', timedOut: false });
});

test('Windows timeout waits for the exact child tree receipt before returning failure', async () => {
  const child = fakeChild();
  let resolveStop: ((value: 'complete') => void) | undefined;
  let returned = false;
  const run = createCliProbeRunner();
  const promise = run('C:\\owned\\fixture.cmd', [], {
    ...options, timeoutMs: 5, spawnProcess: (() => child) as typeof spawn,
    stopWindowsTree: async target => {
      assert.equal(target, child);
      return new Promise(resolve => { resolveStop = resolve; });
    },
  }).then(value => { returned = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(returned, false); assert.ok(resolveStop);
  child.emit('close', 0); // A kill racing with exit zero cannot create success.
  resolveStop('complete');
  const result = await promise;
  assert.equal(result.exitCode, null); assert.equal(result.timedOut, true);
  assert.equal(child.stdout?.destroyed, true);
});

test('incomplete Windows cleanup blocks the same executable across case variants but permits another CLI', async () => {
  const run = createCliProbeRunner(); let spawns = 0;
  const spawnProcess = (() => { spawns++; return fakeChild(); }) as typeof spawn;
  const failed = await run('C:\\owned\\fixture.cmd', [], {
    ...options, timeoutMs: 5, spawnProcess, stopWindowsTree: async () => 'incomplete',
  });
  assert.equal(failed.cleanupIncomplete, true); assert.equal(failed.timedOut, true); assert.notEqual(failed.exitCode, 0);
  const blocked = await run('c:\\OWNED\\FIXTURE.CMD', [], { ...options, spawnProcess });
  assert.equal(spawns, 1); assert.equal(blocked.cleanupIncomplete, true);
  assert.match(blocked.stderr, /restart Clementine/);
  const other = fakeChild();
  const good = run('C:\\owned\\other.cmd', [], { ...options, spawnProcess: (() => { spawns++; return other; }) as typeof spawn });
  other.emit('close', 0); assert.equal((await good).exitCode, 0); assert.equal(spawns, 2);
});

test('each pending Windows cleanup obligation blocks redispatch until its own receipt settles', async () => {
  const run = createCliProbeRunner(); const children = [fakeChild(), fakeChild()];
  const stops: Array<(value: 'complete' | 'incomplete') => void> = [];
  let spawns = 0;
  const deps = {
    ...options, timeoutMs: 5,
    spawnProcess: (() => children[spawns++]) as typeof spawn,
    stopWindowsTree: async () => new Promise<'complete' | 'incomplete'>(resolve => { stops.push(resolve); }),
  };
  const first = run('C:\\owned\\fixture.cmd', [], deps);
  const second = run('C:\\owned\\fixture.cmd', [], deps);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stops.length, 2);
  const pending = await run('c:\\OWNED\\fixture.cmd', [], deps);
  assert.equal(spawns, 2); assert.equal(pending.cleanupIncomplete, true); assert.match(pending.stderr, /still being stopped/);
  stops[0]('complete'); await first;
  const stillPending = await run('C:\\owned\\fixture.cmd', [], deps);
  assert.equal(spawns, 2); assert.match(stillPending.stderr, /still being stopped/);
  stops[1]('incomplete'); await second;
  const blocked = await run('C:\\owned\\fixture.cmd', [], deps);
  assert.equal(spawns, 2); assert.match(blocked.stderr, /restart Clementine/);
});

test('a completed delayed Windows stop permits a later probe without clearing an incomplete latch', async () => {
  const run = createCliProbeRunner(); const stopped = fakeChild(); let finishStop: ((value: 'complete') => void) | undefined;
  const first = run('C:\\owned\\fixture.cmd', [], {
    ...options, timeoutMs: 5, spawnProcess: (() => stopped) as typeof spawn,
    stopWindowsTree: async () => new Promise(resolve => { finishStop = resolve; }),
  });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(finishStop);
  finishStop('complete'); await first;
  const child = fakeChild();
  const next = run('C:\\owned\\fixture.cmd', [], { ...options, spawnProcess: (() => child) as typeof spawn });
  child.emit('close', 0); assert.equal((await next).exitCode, 0);
});

test('output overflow discards partial auth metadata and awaits bounded tree cleanup', async () => {
  const run = createCliProbeRunner(); const child = fakeChild(); let stopped = false;
  const promise = run('C:\\owned\\fixture.cmd', [], {
    ...options, maxBuffer: 8, spawnProcess: (() => child) as typeof spawn,
    stopWindowsTree: async target => { assert.equal(target, child); stopped = true; return 'complete'; },
  });
  child.stdout!.emit('data', Buffer.from('Logged in as wrong@example.test'));
  child.emit('close', 0);
  const result = await promise;
  assert.equal(stopped, true); assert.equal(result.overflowed, true); assert.equal(result.exitCode, 1);
  assert.equal(result.output, ''); assert.equal(result.stdout, '');
});

test('spawn errors and POSIX timeout remain failed probes with no new healthy verdict', async () => {
  const run = createCliProbeRunner();
  const error = await run('/owned/fixture', [], { ...options, platform: 'linux', spawnProcess: (() => { throw new Error('private detail'); }) as typeof spawn });
  assert.equal(error.exitCode, 1); assert.doesNotMatch(error.stderr, /private detail/);
  const child = fakeChild(); let killed = false;
  child.kill = () => { killed = true; return true; };
  const result = await run('/owned/fixture', [], {
    ...options, platform: 'linux', timeoutMs: 5, spawnProcess: (() => child) as typeof spawn,
    stopWindowsTree: async () => { throw new Error('Windows cleanup cannot run on POSIX'); },
  });
  assert.equal(killed, true); assert.equal(result.timedOut, true);
});
