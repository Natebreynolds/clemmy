/**
 * Run: npx tsx --test src/daemon/phase.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const {
  getDaemonRuntimePhase,
  isMeteredDaemonPhase,
  listInFlightDaemonPhases,
  resumeDaemonRuntimePhase,
  setDaemonRuntimePhase,
  withDaemonRuntimePhase,
  yieldToEventLoop,
} = await import('./phase.js');

const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Temporarily give this process an IPC `send`, recording every message. */
async function withIpcSpy<T>(fn: (sent: unknown[]) => Promise<T>): Promise<T> {
  const owner = process as NodeJS.Process & { send?: (message: unknown) => boolean };
  const original = owner.send;
  const sent: unknown[] = [];
  owner.send = (message: unknown) => { sent.push(message); return true; };
  try {
    return await fn(sent);
  } finally {
    if (original) owner.send = original;
    else delete owner.send;
  }
}

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

// ── In-flight phases: the label names the code that is really running ──────

test('the incident shape: sync work after an await is charged to the job, not to a phase that entered meanwhile', async () => {
  setDaemonRuntimePhase('daemon.loop.tick', { tickCount: 1 });
  const modelCall = deferred();
  let labelAtSyncWork = '';
  let labelAfterResume = '';
  const maintenance = withDaemonRuntimePhase('daemon.loop.memory_maintenance', {}, async () => {
    // An awaited model call: the loop is free, so another lane enters a phase.
    await withDaemonRuntimePhase('daemon.nightly.conflict_retry', {}, async () => { await modelCall.promise; });
    // A job entered in its own sub-phase is named at the start of its sync work.
    await withDaemonRuntimePhase('daemon.nightly.link_sync', {}, () => {
      labelAtSyncWork = getDaemonRuntimePhase().name;
    });
    // Without a sub-phase, resuming after the await takes the label back.
    await delay(1);
    resumeDaemonRuntimePhase();
    labelAfterResume = getDaemonRuntimePhase().name;
  });
  const deliveryWait = deferred();
  const delivery = withDaemonRuntimePhase('daemon.kick.notification_delivery', {}, async () => { await deliveryWait.promise; });
  assert.equal(getDaemonRuntimePhase().name, 'daemon.kick.notification_delivery', 'the kick took the label while maintenance awaited');
  modelCall.release();
  await maintenance;
  assert.equal(labelAtSyncWork, 'daemon.nightly.link_sync');
  assert.equal(labelAfterResume, 'daemon.loop.memory_maintenance');
  deliveryWait.release();
  await delivery;
});

test('a finished phase never comes back: A, then B during A, A ends, B ends -> the ambient label', async () => {
  const ambient = setDaemonRuntimePhase('daemon.loop.sleep', { tickCount: 7 });
  const a = deferred();
  const b = deferred();
  const running = withDaemonRuntimePhase('A.timer.background_tasks', {}, async () => { await a.promise; });
  await delay(5);
  const second = withDaemonRuntimePhase('B.loop.recursive_reflection', {}, async () => { await b.promise; });
  a.release();
  await running;
  assert.notEqual(getDaemonRuntimePhase().name, 'A.timer.background_tasks', 'A has ended');
  b.release();
  await second;
  const after = getDaemonRuntimePhase();
  assert.equal(after.name, ambient.name);
  assert.equal(after.sequence, ambient.sequence);
  assert.ok(Date.parse(after.startedAt) >= Date.parse(ambient.startedAt), 'activeMs is measured from the ambient label, not from A');

  // Three deep: A, B inside A's lifetime, C inside B's; A ends, C ends, B ends.
  setDaemonRuntimePhase('daemon.loop.sleep', { tickCount: 8 });
  const ra = deferred(); const rb = deferred(); const rc = deferred();
  const pa = withDaemonRuntimePhase('A', {}, async () => { await ra.promise; });
  const pb = withDaemonRuntimePhase('B', {}, async () => {
    const pc = withDaemonRuntimePhase('C', {}, async () => { await rc.promise; });
    await rb.promise;
    await pc;
  });
  ra.release(); await pa;
  rc.release(); await delay(1);
  rb.release(); await pb;
  assert.equal(getDaemonRuntimePhase().name, 'daemon.loop.sleep', 'no chain of returns to finished phases');
});

test('an exit hands the label to the caller that continues, when that caller is still in flight', async () => {
  setDaemonRuntimePhase('daemon.loop.tick', { tickCount: 9 });
  let afterInner = '';
  await withDaemonRuntimePhase('daemon.loop.memory_maintenance', {}, async () => {
    await withDaemonRuntimePhase('daemon.nightly.backup', {}, async () => { await delay(1); });
    afterInner = getDaemonRuntimePhase().name;
  });
  assert.equal(afterInner, 'daemon.loop.memory_maintenance');
  assert.equal(getDaemonRuntimePhase().name, 'daemon.loop.tick');
});

test('a timer phase started outside any phase hands back a label dated from its exit, not from the start of the pass', async () => {
  const tick = setDaemonRuntimePhase('daemon.loop.tick', { tickCount: 12 });
  // An independent timer lane, started outside any phase (like the runner's
  // setInterval lanes). It enters and leaves its phase while a later
  // sub-phase of the pass awaits.
  const laneGate = deferred();
  const timerLane = (async () => {
    await laneGate.promise;
    await withDaemonRuntimePhase('daemon.timer.background_tasks', {}, async () => { await delay(1); });
  })();
  // An earlier sub-phase of the same pass awaits a while, so the pass is
  // older than the sub-phase that follows it.
  await withDaemonRuntimePhase('daemon.loop.cron_schedules', {}, () => delay(20));
  let label: ReturnType<typeof getDaemonRuntimePhase> | undefined;
  let subPhase: ReturnType<typeof getDaemonRuntimePhase> | undefined;
  let afterResume = '';
  await withDaemonRuntimePhase('daemon.loop.memory_maintenance', {}, async () => {
    laneGate.release();
    await timerLane; // stands in for the awaited backup: another lane ran meanwhile
    const now = Date.now();
    label = getDaemonRuntimePhase(now);
    subPhase = listInFlightDaemonPhases(now).find((phase) => phase.name === 'daemon.loop.memory_maintenance');
    resumeDaemonRuntimePhase();
    afterResume = getDaemonRuntimePhase().name;
  });
  assert.ok(label && subPhase);
  assert.equal(label!.name, tick.name, 'without a resume the label is the loop\'s own');
  assert.equal(label!.sequence, tick.sequence);
  assert.ok(
    Date.parse(label!.startedAt) >= Date.parse(subPhase!.startedAt),
    `the label is dated from the timer phase's exit (${label!.startedAt}), not from the start of the pass (${tick.startedAt})`,
  );
  assert.ok(label!.activeMs <= subPhase!.activeMs, 'so its age is at most the running sub-phase\'s');
  assert.equal(afterResume, 'daemon.loop.memory_maintenance', 'a resume names the sub-phase');
});

test('listInFlightDaemonPhases is exactly the set of entered, unfinished phases', async () => {
  setDaemonRuntimePhase('daemon.loop.tick', { tickCount: 10 });
  const release = [deferred(), deferred(), deferred()];
  const names = ['daemon.timer.workflow_runs', 'daemon.nightly.grounded_backfill', 'daemon.http'];
  const before = new Set(listInFlightDaemonPhases().map((p) => p.sequence));
  const running = names.map((name, i) => withDaemonRuntimePhase(name, {}, async () => { await release[i]!.promise; }));
  const mine = () => listInFlightDaemonPhases().filter((p) => !before.has(p.sequence)).map((p) => p.name);
  assert.deepEqual(mine(), names);
  release[1]!.release();
  await running[1];
  assert.deepEqual(mine(), [names[0], names[2]]);
  release[0]!.release(); release[2]!.release();
  await Promise.all(running);
  assert.deepEqual(mine(), []);
});

test('resume and yield send no IPC; a phase marked ipc:false sends none either', async () => {
  await withIpcSpy(async (sent) => {
    await withDaemonRuntimePhase('daemon.nightly.link_sync', {}, async () => {
      const atEntry = sent.length;
      assert.ok(atEntry >= 1, 'entering a normal phase still heartbeats');
      for (let i = 0; i < 5; i += 1) await yieldToEventLoop();
      resumeDaemonRuntimePhase();
      assert.equal(sent.length, atEntry, 'slices and resumes never touch the IPC channel');
      await withDaemonRuntimePhase('daemon.http', { method: 'GET' }, async () => { await delay(1); }, { ipc: false });
      assert.equal(sent.length, atEntry, 'an ipc:false phase sends nothing on entry or exit');
    });
  });
});

test('yieldToEventLoop gives a real macrotask turn and takes the label back', async () => {
  setDaemonRuntimePhase('daemon.loop.tick', { tickCount: 11 });
  let turns = 0;
  let on = true;
  (function turn() { turns += 1; if (on) setImmediate(turn); })();
  const start = turns;
  let label = '';
  await withDaemonRuntimePhase('daemon.nightly.grounded_backfill', {}, async () => {
    // Another lane enters and leaves a phase between our slices.
    const other = withDaemonRuntimePhase('daemon.http', {}, async () => { await delay(1); }, { ipc: false });
    for (let i = 0; i < 3; i += 1) await yieldToEventLoop();
    await other;
    await yieldToEventLoop();
    label = getDaemonRuntimePhase().name;
  });
  on = false;
  assert.ok(turns - start >= 3, `expected macrotask turns while yielding, saw ${turns - start}`);
  assert.equal(label, 'daemon.nightly.grounded_backfill');
});

test('metered phases are the long memory passes', () => {
  assert.equal(isMeteredDaemonPhase('daemon.nightly.link_sync'), true);
  assert.equal(isMeteredDaemonPhase('daemon.maintenance.anything'), true);
  assert.equal(isMeteredDaemonPhase('daemon.http.memory_reconcile'), true);
  assert.equal(isMeteredDaemonPhase('daemon.http'), false);
  assert.equal(isMeteredDaemonPhase('daemon.loop.memory_maintenance'), false);
  assert.equal(isMeteredDaemonPhase('daemon.timer.background_tasks'), false);
});
