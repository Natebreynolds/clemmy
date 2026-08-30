/**
 * Run: npx tsx --test src/daemon/phase.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const {
  getDaemonRuntimePhase,
  setDaemonRuntimePhase,
  withDaemonRuntimePhase,
} = await import('./phase.js');

test('setDaemonRuntimePhase stores bounded phase details', () => {
  const phase = setDaemonRuntimePhase('daemon.loop.workflow_runs', { tickCount: 12, extra: 'x'.repeat(400) });

  assert.equal(phase.name, 'daemon.loop.workflow_runs');
  assert.ok((phase.detail ?? '').length <= 240);
  assert.match(phase.detail ?? '', /tickCount/);
  assert.equal(typeof phase.sequence, 'number');
});

test('withDaemonRuntimePhase restores the previous phase after async work', async () => {
  const previous = setDaemonRuntimePhase('daemon.loop.sleep', { tickCount: 1 });

  await withDaemonRuntimePhase('daemon.loop.background_tasks', { tickCount: 2 }, async () => {
    const active = getDaemonRuntimePhase();
    assert.equal(active.name, 'daemon.loop.background_tasks');
    assert.match(active.detail ?? '', /tickCount/);
  });

  const restored = getDaemonRuntimePhase();
  assert.equal(restored.name, previous.name);
  assert.equal(restored.sequence, previous.sequence);
});

test('withDaemonRuntimePhase does not clobber a newer overlapping phase', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const running = withDaemonRuntimePhase('daemon.timer.workflow_runs', { tickCount: 3 }, async () => {
    await wait;
  });

  setDaemonRuntimePhase('daemon.loop.goal_resumptions', { tickCount: 4 });
  release();
  await running;

  assert.equal(getDaemonRuntimePhase().name, 'daemon.loop.goal_resumptions');
});

test('real IPC child sends its phase heartbeat to the parent process', async () => {
  const phaseModule = new URL('./phase.ts', import.meta.url).href;
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    [
      `const { setDaemonRuntimePhase } = await import(${JSON.stringify(phaseModule)});`,
      "setDaemonRuntimePhase('daemon.loop.sleep', { tickCount: 1 });",
      'setTimeout(() => process.exit(0), 25);',
    ].join('\n'),
  ], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let heartbeat: unknown;
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  child.on('message', (message: unknown) => { heartbeat = message; });

  const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('real IPC phase child did not exit within 5 seconds'));
    }, 5_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  assert.deepEqual(exited, { code: 0, signal: null }, stderr);
  assert.ok(heartbeat && typeof heartbeat === 'object' && !Array.isArray(heartbeat));
  const message = heartbeat as {
    type?: unknown;
    at?: unknown;
    pid?: unknown;
    uptimeMs?: unknown;
    phase?: {
      name?: unknown;
      detail?: unknown;
      startedAt?: unknown;
      activeMs?: unknown;
      sequence?: unknown;
    };
    reason?: unknown;
  };
  assert.equal(message.type, 'clementine.daemon.heartbeat');
  assert.equal(message.pid, child.pid);
  assert.equal(message.reason, 'phase');
  assert.equal(message.phase?.name, 'daemon.loop.sleep');
  assert.equal(message.phase?.detail, '{"tickCount":1}');
  assert.equal(message.phase?.sequence, 1);
  assert.match(String(message.at), /^\d{4}-\d{2}-\d{2}T/);
  assert.match(String(message.phase?.startedAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof message.uptimeMs, 'number');
  assert.equal(typeof message.phase?.activeMs, 'number');
});
