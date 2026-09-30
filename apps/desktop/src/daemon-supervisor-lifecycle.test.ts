import { test, type TestContext } from 'node:test';
import { strict as assert } from 'node:assert';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonSupervisor, type SupervisorEvent } from './daemon-supervisor.js';

// Exercise the production lifecycle with controlled process/network boundaries.
// No daemon, user shell, model, credentials or business workflow is launched.
class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];
  holdTermination = false;
  constructor(readonly pid: number) { super(); }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.signals.push(signal);
    if (!this.holdTermination || signal === 'SIGKILL') queueMicrotask(() => this.exit(signal));
    return true;
  }
  exit(signal: NodeJS.Signals = 'SIGKILL') {
    if (this.signalCode) return;
    this.signalCode = signal;
    this.stdout.end(); this.stderr.end();
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
  }
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-supervisor-lifecycle-'));
  mkdirSync(path.join(root, 'dist'));
  writeFileSync(path.join(root, 'dist/index.js'), '// process boundary is mocked\n');
  const oldHome = process.env.CLEMENTINE_HOME;
  process.env.CLEMENTINE_HOME = root;
  const children: Child[] = [];
  const events: SupervisorEvent[] = [];
  let response: () => Promise<Response> = async () => new Response('', { status: 200 });
  t.mock.method(childProcess, 'spawn', (command: string) => {
    const child = new Child(10_000 + children.length);
    if (command === process.execPath) children.push(child);
    else queueMicrotask(() => child.emit('error', new Error('fixture: no login shell')));
    return child;
  });
  syncBuiltinESMExports();
  t.mock.method(globalThis, 'fetch', () => response());
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const supervisor = new DaemonSupervisor({
    daemonProjectRoot: root, preferredPort: 0,
    logFile: path.join(root, 'supervisor.log'), onEvent: (event) => events.push(event),
  });
  t.after(async () => {
    for (const child of children) child.holdTermination = false;
    await supervisor.stop();
    await flush();
    t.mock.restoreAll(); syncBuiltinESMExports(); t.mock.timers.reset();
    if (oldHome === undefined) delete process.env.CLEMENTINE_HOME;
    else process.env.CLEMENTINE_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, supervisor, children, events, setResponse(fn: () => Promise<Response>) { response = fn; } };
}

test('automatic replacement retries a startup timeout after reaping, then becomes ready', async (t) => {
  const f = fixture(t);
  await f.supervisor.start();
  f.setResponse(async () => new Response('', { status: 503 }));
  f.children[0]!.exit();
  t.mock.timers.tick(1000); await flush();
  assert.equal(f.children.length, 2);
  t.mock.timers.tick(90_000); await flush();
  assert.deepEqual(f.children[1]!.signals, ['SIGTERM']);
  assert.equal(f.events.filter((e) => e.type === 'restart-scheduled').length, 2,
    'a readiness timeout must not turn automatic recovery into an explicit stop');
  f.setResponse(async () => new Response('', { status: 200 }));
  t.mock.timers.tick(2000); await flush();
  assert.equal(f.children.length, 3);
  assert.equal(f.events.filter((e) => e.type === 'ready').length, 2);
});

test('initial startup timeout reaps before rejecting and does not leave a background retry', async (t) => {
  const f = fixture(t);
  f.setResponse(async () => new Response('', { status: 503 }));
  let rejected = false;
  const started = f.supervisor.start();
  const checked = assert.rejects(started, /did not become ready/).then(() => { rejected = true; });
  await flush();
  f.children[0]!.holdTermination = true;
  t.mock.timers.tick(90_000); await flush();
  assert.equal(rejected, false);
  assert.deepEqual(f.children[0]!.signals, ['SIGTERM']);
  t.mock.timers.tick(5000); await checked;
  assert.equal(f.supervisor.isRunning(), false);
  t.mock.timers.tick(30_000); await flush();
  assert.equal(f.children.length, 1);
});

test('late readiness from a stopped generation cannot mark the replacement ready', async (t) => {
  const f = fixture(t);
  let release!: (response: Response) => void;
  f.setResponse(() => new Promise<Response>((resolve) => { release = resolve; }));
  const first = f.supervisor.start();
  const firstRejected = assert.rejects(first, /stopp|exit|supersed/i);
  await flush();
  await f.supervisor.stop();
  f.setResponse(async () => new Response('', { status: 200 }));
  await f.supervisor.start();
  release(new Response('', { status: 200 })); await flush();
  await firstRejected;
  assert.equal(f.events.filter((e) => e.type === 'ready').length, 1);
  assert.deepEqual(f.children[1]!.signals, []);
});

test('late timeout from an old generation cannot stop its replacement', async (t) => {
  const f = fixture(t);
  let release!: (response: Response) => void;
  f.setResponse(() => new Promise<Response>((resolve) => { release = resolve; }));
  const firstRejected = assert.rejects(f.supervisor.start(), /stopp|exit|supersed/i);
  await flush();
  await f.supervisor.stop();
  f.setResponse(async () => new Response('', { status: 200 }));
  await f.supervisor.start();
  t.mock.timers.tick(90_001);
  release(new Response('', { status: 503 })); await flush();
  t.mock.timers.tick(250); await flush();
  await firstRejected;
  assert.deepEqual(f.children[1]!.signals, []);
  assert.equal(f.supervisor.isRunning(), true);
});

test('concurrent starts share one spawn and stop while selecting a port prevents a spawn', async (t) => {
  const f = fixture(t);
  await Promise.all([f.supervisor.start(), f.supervisor.start()]);
  assert.equal(f.children.length, 1);
  await f.supervisor.stop();
  const stopped = assert.rejects(f.supervisor.start(), /stopp|supersed/i);
  await f.supervisor.stop();
  await stopped;
  assert.equal(f.children.length, 1);
  await f.supervisor.restart();
  assert.equal(f.children.length, 2);
});

test('explicit stop cancels a scheduled automatic restart', async (t) => {
  const f = fixture(t);
  await f.supervisor.start();
  f.children[0]!.exit();
  await f.supervisor.stop();
  t.mock.timers.tick(60_000); await flush();
  assert.equal(f.children.length, 1);
  assert.equal(f.supervisor.isRunning(), false);
});

test('brief successful boots do not erase the bounded restart budget', async (t) => {
  const f = fixture(t);
  await f.supervisor.start();
  for (let i = 0; i < 9; i++) {
    f.children[i]!.exit();
    t.mock.timers.tick(Math.min(30_000, 1000 * 2 ** i)); await flush();
  }
  assert.equal(f.children.length, 9, 'initial boot plus at most eight replacements');
  assert.equal(f.events.filter((e) => e.type === 'restart-skipped').length, 1);
  assert.equal(f.supervisor.isRunning(), false);
});

test('repeated replacement readiness failures stop at the retry cap exactly once', async (t) => {
  const f = fixture(t);
  await f.supervisor.start();
  f.setResponse(async () => new Response('', { status: 503 }));
  f.children[0]!.exit();
  for (let i = 0; i < 8; i++) {
    t.mock.timers.tick(Math.min(30_000, 1000 * 2 ** i)); await flush();
    t.mock.timers.tick(90_000); await flush();
  }
  assert.equal(f.children.length, 9);
  assert.equal(f.events.filter((e) => e.type === 'restart-skipped').length, 1);
  assert.equal(f.supervisor.isRunning(), false);
  // An explicit owner restart begins a fresh recovery budget.
  f.setResponse(async () => new Response('', { status: 200 }));
  await f.supervisor.restart();
  f.children[9]!.exit();
  assert.deepEqual(f.events.filter((e) => e.type === 'restart-scheduled').at(-1),
    { type: 'restart-scheduled', delayMs: 1000, attempt: 1 });
});

test('missing entry on recovery is bounded even without a process exit event', async (t) => {
  const f = fixture(t);
  await f.supervisor.start();
  rmSync(path.join(f.root, 'dist/index.js'));
  f.children[0]!.exit();
  for (let i = 0; i < 8; i++) {
    t.mock.timers.tick(Math.min(30_000, 1000 * 2 ** i)); await flush();
  }
  assert.equal(f.children.length, 1);
  assert.equal(f.events.filter((e) => e.type === 'restart-skipped').length, 1);
});

test('stable uptime decays the budget once and cannot be reused by failed replacements', async (t) => {
  const f = fixture(t);
  await f.supervisor.start();
  f.children[0]!.exit();
  t.mock.timers.tick(1000); await flush();
  t.mock.timers.tick(5 * 60_000); await flush();
  f.setResponse(async () => new Response('', { status: 503 }));
  f.children[1]!.exit();
  t.mock.timers.tick(1000); await flush();
  t.mock.timers.tick(90_000); await flush();
  assert.equal(f.events.filter((e) => e.type === 'restart-counter-reset').length, 1);
  assert.deepEqual(f.events.filter((e) => e.type === 'restart-scheduled').at(-1),
    { type: 'restart-scheduled', delayMs: 2000, attempt: 2 });
});
