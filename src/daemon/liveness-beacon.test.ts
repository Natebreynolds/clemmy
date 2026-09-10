import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readLivenessBeacon,
  shouldDeferHungRestartForLivenessBeacon,
} from '../../apps/desktop/src/daemon-supervisor.js';

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
