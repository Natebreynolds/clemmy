/**
 * Run: npx tsx --test src/runtime/sandboxed-script.test.ts
 *
 * The shared sandboxed-script substrate is the keystone of Wave 1.3 — both the
 * Workspace runner and the workflow deterministic step route through it, so its
 * safety properties (output cap, EPIPE guard, scrubbed env, timeout) are tested
 * once, here.
 */
import { after, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, type spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  interpreterFor, scrubbedChildEnv, electronNodeEnv, spawnSandboxedScript, DEFAULT_MAX_OUTPUT_BYTES,
  _testOnly_createSandboxedScriptSpawner, SANDBOXED_SCRIPT_UNCONFIRMED_STOP_GUIDANCE,
} from './sandboxed-script.js';
import { stopWindowsProcessTree, type ProcessTreeStopResult } from './windows-process-tree.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'clemmy-sandbox-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function writeScript(name: string, body: string, exec = false): string {
  const p = path.join(tmp, name);
  writeFileSync(p, body, 'utf-8');
  if (exec) chmodSync(p, 0o755);
  return p;
}

// ── interpreterFor ───────────────────────────────────────────────────────────

test('interpreterFor: .mjs/.js/.cjs run under the node/Electron binary as node', () => {
  for (const ext of ['mjs', 'js', 'cjs']) {
    const i = interpreterFor(`/x/y.${ext}`, '/usr/bin');
    assert.ok(i);
    assert.equal(i.command, process.execPath);
    assert.equal(i.isElectron, true);
    assert.deepEqual(i.args, [`/x/y.${ext}`]);
  }
});

test('interpreterFor: .ts resolves tsx and runs under node (the new capability)', () => {
  const i = interpreterFor('/x/y.ts', '/usr/bin');
  assert.ok(i, 'tsx should resolve in this repo');
  assert.equal(i.command, process.execPath);
  assert.equal(i.isElectron, true);
  // args = [tsxCli, target]
  assert.equal(i.args.length, 2);
  assert.equal(i.args[1], '/x/y.ts');
});

test('interpreterFor: .py and .sh are NOT electron (never get ELECTRON_RUN_AS_NODE)', () => {
  const py = interpreterFor('/x/y.py', '/usr/bin');
  assert.ok(py);
  assert.equal(py.isElectron, false);
  const sh = interpreterFor('/x/y.sh', '/usr/bin');
  if (process.platform === 'win32') { assert.equal(sh, null, 'a POSIX-only PATH cannot supply Windows bash'); return; }
  assert.ok(sh);
  assert.equal(sh.isElectron, false);
});

test('interpreterFor: a chmod+x extensionless file runs itself; a non-exec unknown ext is unsupported', {
  skip: process.platform === 'win32' ? 'POSIX executable mode proof' : false,
}, () => {
  const execFile = writeScript('runnable', '#!/bin/sh\necho hi\n', true);
  const i = interpreterFor(execFile, '/usr/bin');
  assert.ok(i);
  assert.equal(i.command, execFile);
  assert.deepEqual(i.args, []);

  const plain = writeScript('notes.xyz', 'just text', false);
  assert.equal(interpreterFor(plain, '/usr/bin'), null);
});

// ── scrubbedChildEnv ─────────────────────────────────────────────────────────

test('scrubbedChildEnv carries NO daemon secrets, but DOES carry an augmented PATH', () => {
  const prevKey = process.env.OPENAI_API_KEY;
  const prevTok = process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-should-not-leak';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
  try {
    const env = scrubbedChildEnv({ CLEMENTINE_SPACE_SLUG: 'demo' });
    assert.equal(env.OPENAI_API_KEY, undefined, 'must not pass through API keys');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.ok(env.PATH && env.PATH.length > 0, 'PATH present (augmented)');
    assert.equal(env.CLEMENTINE_SPACE_SLUG, 'demo', 'caller extra is layered on');
    assert.equal(env.NO_COLOR, '1');
    assert.equal(env.PYTHONIOENCODING, 'utf-8');
  } finally {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    if (prevTok === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevTok;
  }
});

test('electronNodeEnv sets the flag ONLY for the node/Electron binary', () => {
  assert.deepEqual(electronNodeEnv(process.execPath, true), { ELECTRON_RUN_AS_NODE: '1' });
  assert.deepEqual(electronNodeEnv('/usr/bin/python3', false), {});
  // isElectron true but a different command (defensive) → not set.
  assert.deepEqual(electronNodeEnv('/usr/bin/python3', true), {});
});

// ── spawnSandboxedScript ─────────────────────────────────────────────────────

test('happy path: reads stdin payload, returns code 0 + stdout', async () => {
  const script = writeScript('echo.mjs', [
    'let i = ""; process.stdin.setEncoding("utf-8");',
    'process.stdin.on("data", (c) => i += c);',
    'process.stdin.on("end", () => process.stdout.write("got:" + i));',
  ].join('\n'));
  const out = await spawnSandboxedScript({
    command: process.execPath, args: [script], cwd: tmp,
    env: scrubbedChildEnv({ ELECTRON_RUN_AS_NODE: '1' }),
    stdinPayload: 'PING', timeoutMs: 10_000,
  });
  assert.equal(out.launchError, undefined);
  assert.equal(out.code, 0);
  assert.equal(out.stdout, 'got:PING');
  assert.equal(out.overflowed, false);
  assert.equal(out.timedOut, false);
});

test('launch failure surfaces as launchError (never rejects)', async () => {
  const out = await spawnSandboxedScript({
    command: path.join(tmp, 'does-not-exist-binary'), args: [], cwd: tmp,
    env: scrubbedChildEnv(), stdinPayload: '', timeoutMs: 5_000,
  });
  assert.ok(out.launchError, 'ENOENT should surface as launchError');
  assert.equal(out.code, null);
});

test('output cap: a runaway writer is killed and flagged overflowed', async () => {
  // Backpressure-respecting steady stream: writes 64KB chunks and only schedules
  // more after 'drain', so the child stays alive and keeps streaming until the
  // PARENT trips the cap and kills it (rather than the child self-crashing on a
  // synchronous mega-burst, which would exit before the cap is reached).
  const script = writeScript('flood.mjs', [
    'const chunk = Buffer.alloc(64 * 1024, 0x78);',
    'function write(){ let ok = true; while (ok) ok = process.stdout.write(chunk); process.stdout.once("drain", write); }',
    'process.stdout.on("error", () => process.exit(0));', // killed pipe → exit cleanly
    'write();',
  ].join('\n'));
  const out = await spawnSandboxedScript({
    command: process.execPath, args: [script], cwd: tmp,
    env: scrubbedChildEnv({ ELECTRON_RUN_AS_NODE: '1' }),
    stdinPayload: '', timeoutMs: 15_000, maxOutputBytes: 2 * 1024 * 1024,
  });
  assert.equal(out.overflowed, true, 'should trip the output cap');
  assert.ok(Buffer.byteLength(out.stdout) <= 2 * 1024 * 1024 + 1024 * 1024, 'stdout bounded near the cap');
});

test('a fast script that exits before stdin is fully written does NOT throw EPIPE', async () => {
  // Reads nothing and exits immediately; the parent still tries to write stdin.
  const script = writeScript('quick.mjs', 'process.stdout.write("done");\n');
  const big = 'y'.repeat(2 * 1024 * 1024); // large enough that the write is mid-flight on exit
  const out = await spawnSandboxedScript({
    command: process.execPath, args: [script], cwd: tmp,
    env: scrubbedChildEnv({ ELECTRON_RUN_AS_NODE: '1' }),
    stdinPayload: big, timeoutMs: 10_000,
  });
  assert.equal(out.launchError, undefined);
  assert.equal(out.code, 0);
  assert.equal(out.stdout, 'done');
});

test('timeout: a hung script is killed and flagged timedOut', async () => {
  const script = writeScript('hang.mjs', 'setInterval(() => {}, 1000);\n');
  const out = await spawnSandboxedScript({
    command: process.execPath, args: [script], cwd: tmp,
    env: scrubbedChildEnv({ ELECTRON_RUN_AS_NODE: '1' }),
    stdinPayload: '', timeoutMs: 400,
  });
  assert.equal(out.timedOut, true);
  assert.notEqual(out.code, 0);
});

test('DEFAULT_MAX_OUTPUT_BYTES is the 64MB safety cap', () => {
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 64 * 1024 * 1024);
});


async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('controlled script did not reach its expected state');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function ownedPosixProcessState(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'invalid descendant PID; no process queried';
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,stat='], {
      encoding: 'utf8', timeout: 500, maxBuffer: 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().slice(0, 256) || 'not present';
  } catch { return 'process state unavailable'; }
}

test('cancellation before admission starts no process and is not a launch failure', async () => {
  const controller = new AbortController();
  controller.abort();
  const marker = path.join(tmp, 'never-started');
  const out = await spawnSandboxedScript({
    command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
    cwd: tmp, env: scrubbedChildEnv(), stdinPayload: '', timeoutMs: 5_000, signal: controller.signal,
  });
  assert.equal(out.aborted, true);
  assert.equal(out.spawned, false);
  assert.equal(out.launchError, undefined);
  assert.equal(out.timedOut, false);
  assert.equal(existsSync(marker), false);
});

for (const [inheritedPipes, deadline] of [[false, false], [true, false], [true, true]] as const) {
  test(`${deadline ? 'Deadline' : 'Stop'} kills a nested TERM-resistant CLI (inherited pipes: ${inheritedPipes})`, {
    skip: process.platform === 'win32' ? 'POSIX process-group proof' : false,
    timeout: 15_000,
  }, async t => {
    const suffix = deadline ? 'deadline' : inheritedPipes ? 'pipes' : 'detached-stdio';
    const ready = path.join(tmp, `grandchild-${suffix}.pid`);
    const late = path.join(tmp, `grandchild-${suffix}.late`);
    const nested = writeScript(`nested-${suffix}.mjs`, [
      'import fs from "node:fs";',
      'process.on("SIGTERM", () => {});',
      `fs.writeFileSync(${JSON.stringify(`${ready}.tmp`)}, String(process.pid) + '\\n');`,
      `fs.renameSync(${JSON.stringify(`${ready}.tmp`)}, ${JSON.stringify(ready)});`,
      `setTimeout(() => { fs.writeFileSync(${JSON.stringify(late)}, 'unexpected effect'); process.exit(0); }, 6_000);`,
    ].join('\n'));
    const wrapper = writeScript(`wrapper-${suffix}.mjs`, [
      'import {spawn} from "node:child_process";',
      `spawn(process.execPath, [${JSON.stringify(nested)}], {stdio: ${JSON.stringify(inheritedPipes ? 'inherit' : 'ignore')}});`,
      'setTimeout(() => process.exit(0), 7_000);',
    ].join('\n'));
    const controller = new AbortController();
    const pending = spawnSandboxedScript({
      command: process.execPath, args: [wrapper], cwd: tmp,
      env: scrubbedChildEnv(), stdinPayload: '', timeoutMs: deadline ? 2_000 : 10_000, signal: controller.signal,
    });
    let pid: number | undefined;
    try {
      await waitUntil(() => {
        if (!existsSync(ready)) return false;
        const marker = readFileSync(ready, 'utf8');
        if (!/^[1-9][0-9]*\n$/.test(marker)) return false;
        const candidate = Number(marker.slice(0, -1));
        if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > 0x7fffffff
          || marker !== `${candidate}\n`) return false;
        pid = candidate;
        return true;
      });
      assert.ok(pid !== undefined, 'ready marker admitted an owned positive PID');
      const started = Date.now();
      if (!deadline) controller.abort();
      const out = await pending;
      assert.equal(out.aborted, !deadline);
      assert.equal(out.spawned, true, 'Stop must not claim that no process ran');
      assert.equal(out.timedOut, deadline);
      assert.ok(Date.now() - started < 5_000, 'Stop/deadline cannot wait for the nested command to finish naturally');
      try { await waitUntil(() => !processAlive(pid!)); }
      catch (error) {
        t.diagnostic(JSON.stringify({ ownedDescendantPid: pid, columns: 'pid ppid pgid stat',
          state: ownedPosixProcessState(pid), delayedEffectPresent: existsSync(late),
          stopped: { aborted: out.aborted, timedOut: out.timedOut, code: out.code, signal: out.signal } }));
        throw error;
      }
      assert.equal(existsSync(late), false, 'stopped child cannot perform its delayed write');
    } finally {
      controller.abort();
      if (pid && processAlive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      await pending;
    }
  });
}

test('synchronous spawn argument failure is returned with no process started', async () => {
  const out = await spawnSandboxedScript({
    command: 'invalid\0command', args: [], cwd: tmp,
    env: scrubbedChildEnv(), stdinPayload: '', timeoutMs: 1_000,
  });
  assert.ok(out.launchError);
  assert.equal(out.spawned, false);
  assert.equal(out.aborted, false);
});

function fakeScriptProcess(pid: number): ChildProcessWithoutNullStreams & { unrefs: number } {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => true, unrefs: 0, unref() { this.unrefs += 1; } }) as unknown as ChildProcessWithoutNullStreams & { unrefs: number };
}

for (const status of ['complete', 'incomplete'] as const) test(`Windows stop holds settlement through late close and ${status} cleanup`, async () => {
  const children: ReturnType<typeof fakeScriptProcess>[] = [];
  let completeCleanup: ((status: ProcessTreeStopResult) => void) | undefined;
  const run = _testOnly_createSandboxedScriptSpawner({ platform: 'win32',
    spawnProcess: (() => { const child = fakeScriptProcess(400 + children.length); children.push(child); return child; }) as typeof spawn,
    stopWindowsTree: () => new Promise(resolve => { completeCleanup = resolve; }),
  });
  const input = { command: 'controlled-fixture.exe', args: [], cwd: tmp, env: {}, stdinPayload: '', timeoutMs: 20 };
  let settled = false;
  const pending = run(input); void pending.then(() => { settled = true; });
  await waitUntil(() => !!completeCleanup);
  children[0].emit('close', 0, null);
  await Promise.resolve(); assert.equal(settled, false, 'zero-exit wrapper cannot erase the pending tree stop');
  const duringStop = await run(input);
  assert.equal(duringStop.spawned, false); assert.match(duringStop.launchError!.message, /Check and stop.*restart/);
  completeCleanup!(status);
  const out = await pending;
  assert.equal(out.timedOut, true); assert.equal(out.aborted, false); assert.equal(out.spawned, true);
  assert.equal(out.code, null); assert.equal(out.timeoutCleanup, status);
  assert.equal(children[0].stdout.destroyed, true); assert.equal(children[0].stderr.destroyed, true);
  assert.equal(children[0].unrefs, status === 'incomplete' ? 1 : 0);
  const again = run({ ...input, timeoutMs: 5_000 });
  if (status === 'complete') { children[1].emit('close', 0, null); assert.equal((await again).code, 0); }
  else {
    const held = await again;
    assert.equal(held.spawned, false); assert.equal(held.timeoutCleanup, 'incomplete');
    assert.equal(held.launchError!.message, SANDBOXED_SCRIPT_UNCONFIRMED_STOP_GUIDANCE);
    assert.equal(children.length, 1, 'an uncertain prior stop admits no new process');
  }
});

test('one complete concurrent stop cannot clear another uncertain stop in the same workspace', async () => {
  const children: ReturnType<typeof fakeScriptProcess>[] = [];
  const cleanups: ((status: ProcessTreeStopResult) => void)[] = [];
  const run = _testOnly_createSandboxedScriptSpawner({ platform: 'win32',
    spawnProcess: (() => { const child = fakeScriptProcess(500 + children.length); children.push(child); return child; }) as typeof spawn,
    stopWindowsTree: () => new Promise(resolve => { cleanups.push(resolve); }),
  });
  const input = { command: 'controlled-fixture.exe', args: [], cwd: tmp, env: {}, stdinPayload: '', timeoutMs: 5_000 };
  const a = new AbortController(), b = new AbortController();
  const first = run({ ...input, signal: a.signal }), second = run({ ...input, signal: b.signal });
  a.abort(); b.abort(); await waitUntil(() => cleanups.length === 2);
  cleanups[0]('incomplete'); cleanups[1]('complete');
  assert.equal((await first).aborted, true); assert.equal((await second).aborted, true);
  const held = await run(input);
  assert.equal(held.spawned, false); assert.equal(children.length, 2);
  const unrelated = run({ ...input, cwd: path.dirname(tmp) });
  children[2].emit('close', 0, null); assert.equal((await unrelated).code, 0, 'other workspaces remain usable');
});

for (const deadline of [false, true]) test(`actual Windows ${deadline ? 'deadline' : 'Stop'} awaits descendant cleanup before returning`, {
  skip: process.platform !== 'win32', timeout: 15_000,
}, async () => {
  const fixture = mkdtempSync(path.join(tmp, 'windows-stop-'));
  const ready = path.join(fixture, 'descendant.pid');
  const nested = path.join(fixture, 'nested.mjs');
  const wrapper = path.join(fixture, 'wrapper.mjs');
  writeFileSync(nested, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>{},1000);`);
  writeFileSync(wrapper, `import {spawn} from 'node:child_process'; spawn(process.execPath,[${JSON.stringify(nested)}],{stdio:'inherit'}); setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const pending = spawnSandboxedScript({ command: process.execPath, args: [wrapper], cwd: fixture,
    env: scrubbedChildEnv(), stdinPayload: '', timeoutMs: deadline ? 2_000 : 10_000, signal: controller.signal });
  let descendant: number | undefined;
  try {
    await waitUntil(() => existsSync(ready)); descendant = Number(readFileSync(ready, 'utf8'));
    if (!deadline) controller.abort();
    const result = await pending;
    assert.equal(result.timeoutCleanup, 'complete'); assert.equal(result.spawned, true);
    assert.equal(result.aborted, !deadline); assert.equal(result.timedOut, deadline);
    assert.equal(processAlive(descendant), false, 'owned descendant is gone before the result returns');
  } finally {
    controller.abort(); await pending;
    if (descendant && processAlive(descendant)) await stopWindowsProcessTree({ pid: descendant, kill: signal => { try { process.kill(descendant!, signal); return true; } catch { return false; } } });
  }
});

test('actual Windows missing cleanup utility returns uncertainty and blocks same-workspace effects', {
  skip: process.platform !== 'win32', timeout: 15_000,
}, async () => {
  const fixture = mkdtempSync(path.join(tmp, 'windows-failed-stop-'));
  const ready = path.join(fixture, 'descendant.pid'), marker = path.join(fixture, 'must-not-run');
  const nested = path.join(fixture, 'nested.mjs'), wrapper = path.join(fixture, 'wrapper.mjs');
  writeFileSync(nested, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>{},1000);`);
  writeFileSync(wrapper, `import {spawn} from 'node:child_process'; spawn(process.execPath,[${JSON.stringify(nested)}],{stdio:'inherit'}); setInterval(()=>{},1000);`);
  const run = _testOnly_createSandboxedScriptSpawner({
    stopWindowsTree: child => stopWindowsProcessTree(child, { env: { SystemRoot: path.join(fixture, 'missing-system-root') } }),
  });
  const controller = new AbortController();
  const input = { command: process.execPath, args: [wrapper], cwd: fixture, env: scrubbedChildEnv(), stdinPayload: '', timeoutMs: 10_000 };
  const pending = run({ ...input, signal: controller.signal });
  let descendant: number | undefined;
  try {
    await waitUntil(() => existsSync(ready)); descendant = Number(readFileSync(ready, 'utf8'));
    const started = Date.now(); controller.abort();
    const result = await pending;
    assert.ok(Date.now() - started < 6_000, 'inherited pipes cannot extend the OS cleanup bound');
    assert.equal(result.timeoutCleanup, 'incomplete'); assert.equal(result.aborted, true); assert.equal(result.spawned, true);
    const held = await run({ ...input, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'effect')`] });
    assert.equal(held.spawned, false); assert.match(held.launchError!.message, /effects are uncertain.*Check and stop.*restart/);
    assert.equal(existsSync(marker), false);
  } finally {
    controller.abort(); await pending;
    if (descendant && processAlive(descendant)) await stopWindowsProcessTree({ pid: descendant, kill: signal => { try { process.kill(descendant!, signal); return true; } catch { return false; } } });
  }
});
