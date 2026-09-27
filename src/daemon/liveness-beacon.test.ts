import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readLivenessBeacon,
  shouldDeferHungRestartForLivenessBeacon,
} from '../../apps/desktop/src/daemon-supervisor.js';
import { LIVENESS_STAMP_SLOTS, livenessMonotonicMs } from './liveness-beacon.js';

// 2026-09-10, during a Zoom call: the daemon blocked in
// daemon.loop.memory_maintenance on a CPU-starved machine. HTTP stopped
// answering AND the IPC heartbeat went stale — both ride the same event loop —
// so the supervisor's "busy but alive" deferral could not fire and it SIGKILLed
// a daemon that was merely slow, into a ~16s+ boot reconciliation over a 1.1GB
// eventlog. The beacon exists to break that shared failure mode.

function beaconFile(body: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'clem-beacon-'));
  const file = path.join(dir, 'daemon-liveness.json');
  writeFileSync(file, JSON.stringify(body));
  return file;
}

test('a fresh beacon in a bounded phase defers the restart — starved is not frozen', () => {
  const read = {
    beacon: { at: new Date().toISOString(), phase: { name: 'daemon.loop.memory_maintenance', activeMs: 9_000 } },
    ageMs: 3_000,
  };
  assert.equal(shouldDeferHungRestartForLivenessBeacon(read, 0), true);
});

test('the observed hang would now be deferred instead of killed', () => {
  // The real numbers from the incident: IPC heartbeat 75s stale (so the IPC
  // deferral was unreachable), daemon inside memory_maintenance for ~9s.
  const read = {
    beacon: { at: new Date().toISOString(), mainStampAgeMs: 75_229, phase: { name: 'daemon.loop.memory_maintenance', activeMs: 8_780 } },
    ageMs: 4_000,
  };
  assert.equal(shouldDeferHungRestartForLivenessBeacon(read, 0), true,
    'a live beacon proves the PROCESS is running even when the loop is blocked');
});

test('a stale beacon does NOT defer — the process really is gone or wholly frozen', () => {
  const read = {
    beacon: { at: new Date(Date.now() - 60_000).toISOString(), phase: { name: 'x', activeMs: 1_000 } },
    ageMs: 60_000,
  };
  assert.equal(shouldDeferHungRestartForLivenessBeacon(read, 0), false);
});

test('a beacon stuck in ONE phase past the ceiling does NOT defer — that is a real freeze', () => {
  const read = {
    beacon: { at: new Date().toISOString(), phase: { name: 'daemon.loop.memory_maintenance', activeMs: 20 * 60_000 } },
    ageMs: 2_000,
  };
  assert.equal(shouldDeferHungRestartForLivenessBeacon(read, 0), false,
    'a live worker alongside a permanently-wedged main thread must still be restarted');
});

test('deferrals are bounded — a starved daemon is not deferred forever', () => {
  const read = { beacon: { at: new Date().toISOString(), phase: { name: 'p', activeMs: 1_000 } }, ageMs: 1_000 };
  assert.equal(shouldDeferHungRestartForLivenessBeacon(read, 5), true);
  assert.equal(shouldDeferHungRestartForLivenessBeacon(read, 6), false, 'the cap must hold');
});

test('a missing or unparseable beacon is simply no evidence, never a crash', () => {
  assert.equal(readLivenessBeacon(path.join(tmpdir(), 'clem-does-not-exist-beacon.json')), null);
  assert.equal(shouldDeferHungRestartForLivenessBeacon(null, 0), false);
  const garbage = beaconFile('not-an-object-with-at');
  assert.equal(readLivenessBeacon(garbage), null);
});

test('readLivenessBeacon reports the age of a well-formed beacon', () => {
  const at = new Date(Date.now() - 7_000).toISOString();
  const file = beaconFile({ at, pid: 123, phase: { name: 'daemon.loop.tick', activeMs: 500 } });
  const read = readLivenessBeacon(file);
  assert.ok(read, 'a well-formed beacon must parse');
  assert.ok(read!.ageMs >= 6_000 && read!.ageMs <= 9_000, `age looked wrong: ${read!.ageMs}`);
  assert.equal(read!.beacon.phase?.name, 'daemon.loop.tick');
});

// ── The connection pin ──────────────────────────────────────────────────────
test('the beacon is stamped from the heartbeat path and started independently of IPC', () => {
  const source = readFileSync(new URL('./phase.ts', import.meta.url), 'utf8');
  const send = source.slice(source.indexOf('export function sendSupervisorIpcHeartbeat'));
  const stampAt = send.indexOf('stampLiveness(');
  const guardAt = send.indexOf("if (typeof send !== 'function') return;");
  assert.ok(stampAt >= 0, 'the heartbeat path must stamp the beacon');
  assert.ok(guardAt < 0 || stampAt < guardAt,
    'the beacon must be stamped BEFORE any IPC-availability guard — it is the signal that survives when IPC does not');

  const start = source.slice(source.indexOf('export function startSupervisorIpcHeartbeat'));
  const beaconAt = start.indexOf('startLivenessBeacon()');
  const returnAt = start.indexOf("if (typeof supervisorSend() !== 'function') return;");
  assert.ok(beaconAt >= 0 && beaconAt < returnAt,
    'the beacon must start even when the parent gave us no IPC channel');
});

test('the supervisor consults the beacon before declaring a hang', () => {
  const source = readFileSync(new URL('../../apps/desktop/src/daemon-supervisor.ts', import.meta.url), 'utf8');
  // 'hung-restart' also appears in the event type union near the top of the
  // file — anchor on the LAST occurrence, inside the watchdog.
  const decision = source.slice(source.indexOf('const ipcHeartbeatAgeMs ='), source.lastIndexOf("type: 'hung-restart'"));
  assert.ok(decision.length > 0, 'failed to locate the hang decision block');
  assert.match(decision, /shouldDeferHungRestartForLivenessBeacon\(/,
    'the IPC heartbeat shares an event loop with the thing it measures; the beacon must be checked before SIGKILL');
  assert.ok(
    decision.indexOf('shouldDeferHungRestartForIpcHeartbeat') < decision.indexOf('shouldDeferHungRestartForLivenessBeacon'),
    'the cheap IPC check stays first; the beacon is the fallback',
  );
});

test('the daemon is told where to write the beacon, and a stale one is cleared on start', () => {
  const source = readFileSync(new URL('../../apps/desktop/src/daemon-supervisor.ts', import.meta.url), 'utf8');
  assert.match(source, /CLEMMY_LIVENESS_BEACON_FILE: this\.livenessBeaconFile\(\)/,
    'both sides must agree on the path without guessing at each other');
  assert.match(source, /rmSync\(this\.livenessBeaconFile\(\), \{ force: true \}\)/,
    'a beacon left by the previous daemon must never vouch for the one replacing it');
});

test('embedding inference is off the main thread by default, with an in-process fallback', () => {
  const source = readFileSync(new URL('../memory/embeddings.ts', import.meta.url), 'utf8');
  assert.match(source, /const worker = await startEmbeddingWorker\(\);/,
    'ONNX inference on the loop is what took HTTP and the heartbeat down together');
  assert.match(source, /thread: 'worker'/);
  // The fallback must still exist: degraded recall beats no recall.
  assert.match(source, /createLocalExtractor\(\)/);
  assert.match(source, /ON THE MAIN THREAD/,
    'falling back to the blocking path must be loud, not silent');
});

test('a worker that cannot spawn degrades immediately, not after the boot timeout', () => {
  const source = readFileSync(new URL('../memory/embedding-worker.ts', import.meta.url), 'utf8');
  const boot = source.slice(source.indexOf('const runtime = await new Promise'), source.indexOf('if (runtime === null'));
  assert.match(boot, /worker\.once\('error'/, 'a failed spawn must settle the boot promise');
  assert.match(boot, /worker\.once\('exit'/, 'an immediate exit must settle the boot promise');
  assert.ok(boot.indexOf('WORKER_BOOT_TIMEOUT_MS') > 0, 'the timeout remains the backstop, not the only exit');
});

// ── In-flight phases, the metered stretch meter and the stall journal ─────────

async function waitFor<T>(read: () => T | undefined | null | false, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

function readLines(file: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Stamp as the main thread does, on both clocks, `agoMs` in the past. */
function stampMain(view: Float64Array, agoMs = 0): void {
  view[0] = Date.now() - agoMs;
  view[4] = livenessMonotonicMs() - agoMs;
}

/** A live main thread: re-stamps every 10 ms until the returned stop is called. */
function keepStamping(view: Float64Array): () => void {
  stampMain(view);
  const timer = setInterval(() => stampMain(view), 10);
  return () => clearInterval(timer);
}

async function startBeaconWorker(dir: string, intervalMs = 50) {
  const { Worker } = await import('node:worker_threads');
  const file = path.join(dir, 'daemon-liveness.json');
  const buffer = new SharedArrayBuffer(LIVENESS_STAMP_SLOTS * Float64Array.BYTES_PER_ELEMENT);
  const view = new Float64Array(buffer);
  stampMain(view);
  view[1] = Date.now();
  const worker = new Worker(new URL('./liveness.worker.ts', import.meta.url), {
    workerData: { file, stamps: buffer, intervalMs, sampleMs: 20, pid: 4242 },
    execArgv: ['--import', 'tsx'],
  });
  return { worker, view, file, stalls: path.join(dir, 'daemon-stalls.jsonl') };
}

test('while a metered phase runs, a stale stamp is measured and journalled with the in-flight set', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clem-beacon-metered-'));
  const { worker, view, file, stalls } = await startBeaconWorker(dir);
  const stopStamping = keepStamping(view);
  try {
    const now = Date.now();
    worker.postMessage({
      running: { name: 'daemon.nightly.link_sync', detail: '{"tick":3}', startedAtMs: now - 5_000, sequence: 42 },
      inFlight: [
        { name: 'daemon.loop.memory_maintenance', startedAtMs: now - 6_000, sequence: 40 },
        { name: 'daemon.nightly.link_sync', startedAtMs: now - 5_000, sequence: 42 },
      ],
      metered: true,
    });
    view[1] = now - 5_000;
    view[2] = 42;
    view[3] = 1;
    // The worker has taken the message once a beat names the phase.
    await waitFor(() => (readJson(file)?.phase as { name?: string } | undefined)?.name === 'daemon.nightly.link_sync', 'the worker to take the phase message');
    // Drive the stamp directly: the main thread last stamped 1.2 s ago and has
    // not stamped since. The stamp stays stale until the assertions have seen it.
    stopStamping();
    stampMain(view, 1_200);

    const beacon = await waitFor(() => {
      const b = readJson(file);
      return b && typeof b.maxMainStampAgeMs === 'number' && b.maxMainStampAgeMs >= 1_200 ? b : null;
    }, 'a beat window reporting the stale stretch');
    assert.equal(beacon.metered, true);
    assert.equal((beacon.phase as { name?: string }).name, 'daemon.nightly.link_sync');
    const inFlight = beacon.inFlight as Array<{ name: string; activeMs: number }>;
    assert.deepEqual(inFlight.map((p) => p.name), ['daemon.loop.memory_maintenance', 'daemon.nightly.link_sync']);
    assert.ok(inFlight[0]!.activeMs >= 6_000);

    const start = await waitFor(() => readLines(stalls).find((line) => line.event === 'start'), 'a stall start line');
    assert.equal(start.metered, true);
    assert.equal(start.thresholdMs, 1_000);
    assert.equal((start.phase as { name?: string }).name, 'daemon.nightly.link_sync');
    assert.ok(Number(start.ageMs) >= 1_000);

    // The main thread comes back.
    const staleStamp = view[4]!;
    stampMain(view);
    const end = await waitFor(() => readLines(stalls).find((line) => line.event === 'end'), 'a stall end line');
    assert.equal(Number(end.durationMs), view[4]! - staleStamp, 'the duration is the gap between the two stamps, in awake time');
    assert.ok(Number(end.durationMs) >= 1_200);
    assert.equal((end.phase as { name?: string }).name, 'daemon.nightly.link_sync', 'the end line names the phase that held the thread');
    assert.deepEqual((end.inFlight as Array<{ name: string }>).map((p) => p.name), ['daemon.loop.memory_maintenance', 'daemon.nightly.link_sync']);
    assert.equal(readLines(stalls).filter((line) => line.event === 'start').length, 1, 'one stretch, one record');
  } finally {
    stopStamping();
    await worker.terminate();
  }
});

test('outside a metered phase only a stretch past the long threshold is journalled', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clem-beacon-unmetered-'));
  const { worker, view, file, stalls } = await startBeaconWorker(dir);
  const stopStamping = keepStamping(view);
  try {
    worker.postMessage({
      running: { name: 'daemon.loop.cron_schedules', startedAtMs: Date.now(), sequence: 7 },
      inFlight: [{ name: 'daemon.loop.cron_schedules', startedAtMs: Date.now(), sequence: 7 }],
      metered: false,
    });
    view[3] = 0;
    await waitFor(() => (readJson(file)?.phase as { name?: string } | undefined)?.name === 'daemon.loop.cron_schedules', 'the worker to take the phase message');
    stopStamping();
    stampMain(view, 1_200);
    await waitFor(() => {
      const b = readJson(file);
      return b && typeof b.maxMainStampAgeMs === 'number' && b.maxMainStampAgeMs >= 1_200 ? b : null;
    }, 'a beat reporting the stale stamp');
    assert.deepEqual(readLines(stalls), [], 'a 1.2 s stretch outside metered work is not a stall');

    stampMain(view, 10_500);
    const start = await waitFor(() => readLines(stalls).find((line) => line.event === 'start'), 'a long-stall start line');
    assert.equal(start.metered, false);
    assert.equal(start.thresholdMs, 10_000);
  } finally {
    stopStamping();
    await worker.terminate();
  }
});

test('a machine that slept is not a stall: stretches are measured in awake time', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clem-beacon-sleep-'));
  const { worker, view, file, stalls } = await startBeaconWorker(dir);
  const stopStamping = keepStamping(view);
  try {
    worker.postMessage({
      running: { name: 'daemon.loop.sleep', startedAtMs: Date.now(), sequence: 9 },
      inFlight: [],
      metered: false,
    });
    view[3] = 0;
    await waitFor(() => (readJson(file)?.phase as { name?: string } | undefined)?.name === 'daemon.loop.sleep', 'the worker to take the phase message');
    // Just after a wake, before the main thread has run: its last stamp is
    // three hours old on the wall clock, but only moments old in awake time,
    // because the monotonic clock stood still while the machine slept.
    stopStamping();
    const wallBeforeSleep = Date.now() - 3 * 60 * 60_000;
    view[0] = wallBeforeSleep;
    view[4] = livenessMonotonicMs();
    const beacon = await waitFor(() => {
      const b = readJson(file);
      return b && b.mainStampAt === new Date(wallBeforeSleep).toISOString() ? b : null;
    }, 'a beat that read the post-wake stamp');
    assert.ok(Number(beacon.mainStampAgeMs) < 10_000, `the hours asleep are not main-thread time (age ${String(beacon.mainStampAgeMs)})`);
    assert.ok(Number(beacon.maxMainStampAgeMs) < 10_000);
    assert.deepEqual(readLines(stalls), [], 'no stall is journalled for the sleep');
  } finally {
    stopStamping();
    await worker.terminate();
  }
});

test('the host posts a phase message only when the running phase or the in-flight set changes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clem-beacon-host-'));
  const previous = process.env.CLEMMY_LIVENESS_BEACON_FILE;
  process.env.CLEMMY_LIVENESS_BEACON_FILE = path.join(dir, 'daemon-liveness.json');
  const beacon = await import('./liveness-beacon.js');
  const phase = await import('./phase.js');
  try {
    beacon.startLivenessBeacon();
    assert.ok(beacon._livenessStampsForTest(), 'the beacon started');
    let postsInsideJob = -1;
    let tickerDuringJob = false;
    await phase.withDaemonRuntimePhase('daemon.nightly.grounded_backfill', {}, async () => {
      const atEntry = beacon._livenessBeaconPostCountForTest();
      for (let i = 0; i < 20; i += 1) await phase.yieldToEventLoop();
      postsInsideJob = beacon._livenessBeaconPostCountForTest() - atEntry;
      tickerDuringJob = beacon._livenessMeteredTickerRunningForTest();
      assert.equal(beacon._livenessStampsForTest()![3], 1, 'the metered flag is set while the pass is in flight');
    });
    assert.equal(postsInsideJob, 0, 'twenty slices of one job post nothing');
    assert.equal(tickerDuringJob, true, 'the main thread re-stamps while a metered phase is in flight');
    assert.equal(beacon._livenessMeteredTickerRunningForTest(), false, 'and stops when it ends');
    assert.equal(beacon._livenessStampsForTest()![3], 0);
    const beforeHttp = beacon._livenessBeaconPostCountForTest();
    await phase.withDaemonRuntimePhase('daemon.http', {}, async () => { await phase.yieldToEventLoop(); }, { ipc: false });
    assert.ok(beacon._livenessBeaconPostCountForTest() >= beforeHttp + 2, 'entry and exit of a request both change the in-flight set');

    // The loop's own label, handed back when a request started outside any
    // phase ends, is dated from that exit in the stamp the worker reads.
    const tick = phase.setDaemonRuntimePhase('daemon.loop.tick', { tickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const beforeRequest = Date.now();
    await phase.withDaemonRuntimePhase('daemon.http', {}, async () => { await phase.yieldToEventLoop(); }, { ipc: false });
    const stamps = beacon._livenessStampsForTest()!;
    assert.equal(stamps[2], tick.sequence, 'the running label is the loop\'s own again');
    assert.ok(stamps[1]! >= beforeRequest, 'dated from the request\'s exit, not from the start of the pass');
    assert.ok(stamps[4]! > 0, 'the stamp is also written on the monotonic clock');
  } finally {
    beacon._stopLivenessBeaconForTest();
    if (previous === undefined) delete process.env.CLEMMY_LIVENESS_BEACON_FILE;
    else process.env.CLEMMY_LIVENESS_BEACON_FILE = previous;
  }
});
