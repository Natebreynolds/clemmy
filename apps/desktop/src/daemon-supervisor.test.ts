/**
 * Run with: npx tsx --test apps/desktop/src/daemon-supervisor.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  appendSupervisorLogTail,
  formatHungRestartDiagnostic,
  isDaemonIpcHeartbeatMessage,
  normalizeDaemonIpcHeartbeatMessage,
  settleTerminalReadinessFailure,
  shouldDeferHungRestartForIpcHeartbeat,
  shouldDeferHungRestartForLivenessBeacon,
  shouldExtendReadinessForLivenessBeacon,
} from './daemon-supervisor.js';

test('isDaemonIpcHeartbeatMessage accepts only the daemon heartbeat envelope', () => {
  assert.equal(isDaemonIpcHeartbeatMessage({
    type: 'clementine.daemon.heartbeat',
    at: new Date().toISOString(),
    pid: 1234,
    uptimeMs: 5000,
  }), true);
  assert.equal(isDaemonIpcHeartbeatMessage({ type: 'other.message' }), false);
  assert.equal(isDaemonIpcHeartbeatMessage(null), false);
});

test('normalizeDaemonIpcHeartbeatMessage preserves bounded phase diagnostics', () => {
  const heartbeat = normalizeDaemonIpcHeartbeatMessage({
    type: 'clementine.daemon.heartbeat',
    at: '2026-07-09T10:00:00.000Z',
    pid: 1234,
    uptimeMs: 5000,
    reason: 'phase',
    phase: {
      name: 'daemon.loop.workflow_runs',
      detail: '{"tickCount":4}',
      startedAt: '2026-07-09T09:59:50.000Z',
      activeMs: 10_000,
      sequence: 42,
    },
  });

  assert.deepEqual(heartbeat, {
    at: '2026-07-09T10:00:00.000Z',
    pid: 1234,
    uptimeMs: 5000,
    reason: 'phase',
    phase: {
      name: 'daemon.loop.workflow_runs',
      detail: '{"tickCount":4}',
      startedAt: '2026-07-09T09:59:50.000Z',
      activeMs: 10_000,
      sequence: 42,
    },
  });
});

test('hang diagnostic includes phase and bounded recent daemon log tail', () => {
  let tail = appendSupervisorLogTail([], 'stdout', 'ready\nfirst line', '2026-07-09T10:00:00.000Z', { maxEntries: 3 });
  tail = appendSupervisorLogTail(tail, 'stderr', 'second line\nthird line\nfourth line', '2026-07-09T10:00:01.000Z', { maxEntries: 3 });

  const diagnostic = formatHungRestartDiagnostic({
    misses: 4,
    unresponsiveMs: 80_000,
    ipcHeartbeatAgeMs: 45_000,
    heartbeat: {
      at: '2026-07-09T10:00:00.000Z',
      pid: 1234,
      uptimeMs: 600_000,
      phase: { name: 'daemon.loop.background_tasks', detail: '{"tickCount":9}', activeMs: 75_000 },
    },
    recentLogs: tail,
  });

  assert.match(diagnostic, /phase=daemon\.loop\.background_tasks/);
  assert.match(diagnostic, /active=75s/);
  assert.doesNotMatch(diagnostic, /ready/);
  assert.match(diagnostic, /second line/);
  assert.match(diagnostic, /fourth line/);
});

test('shouldDeferHungRestartForIpcHeartbeat defers only for a fresh heartbeat', () => {
  assert.equal(shouldDeferHungRestartForIpcHeartbeat(0, 30_000, 0, 2), true);
  assert.equal(shouldDeferHungRestartForIpcHeartbeat(29_999, 30_000, 0, 2), true);
  assert.equal(shouldDeferHungRestartForIpcHeartbeat(30_001, 30_000, 0, 2), false);
  assert.equal(shouldDeferHungRestartForIpcHeartbeat(null, 30_000, 0, 2), false);
  assert.equal(shouldDeferHungRestartForIpcHeartbeat(-1, 30_000, 0, 2), false);
  assert.equal(shouldDeferHungRestartForIpcHeartbeat(Number.NaN, 30_000, 0, 2), false);
  assert.equal(shouldDeferHungRestartForIpcHeartbeat(1000, 30_000, 1, 2), true);
  assert.equal(shouldDeferHungRestartForIpcHeartbeat(1000, 30_000, 2, 2), false);
});

test('terminal readiness failure rejects only after a live daemon is stopped and reaped', async () => {
  const events: string[] = [];
  let releaseStop: (() => void) | undefined;
  const stopFinished = new Promise<void>((resolve) => {
    releaseStop = () => {
      events.push('stop-finished');
      resolve();
    };
  });
  const expected = new Error('readiness timed out');
  const failure = settleTerminalReadinessFailure({
    isRunning: () => true,
    stop: async () => {
      events.push('stop-started');
      await stopFinished;
    },
  }, expected);
  void failure.catch(() => { events.push('failure-reported'); });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['stop-started']);

  releaseStop?.();
  await assert.rejects(failure, (err: unknown) => err === expected);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['stop-started', 'stop-finished', 'failure-reported']);
});

test('terminal readiness failure does not disturb an already-reaped daemon', async () => {
  let stopCalls = 0;
  const expected = new Error('daemon exited before ready');

  await assert.rejects(settleTerminalReadinessFailure({
    isRunning: () => false,
    stop: async () => { stopCalls += 1; },
  }, expected), (err: unknown) => err === expected);

  assert.equal(stopCalls, 0);
});

test('a young running phase defers the kill even next to an old in-flight entry', () => {
  // A background task's phase stays open for its whole run. It is in flight,
  // but it is not what holds the thread; the running phase is.
  const read = {
    beacon: {
      at: new Date().toISOString(),
      mainStampAgeMs: 70_000,
      maxMainStampAgeMs: 70_000,
      phase: { name: 'daemon.nightly.grounded_backfill', activeMs: 75_000 },
      inFlight: [
        { name: 'daemon.timer.background_tasks', activeMs: 25 * 60_000 },
        { name: 'daemon.nightly.grounded_backfill', activeMs: 75_000 },
      ],
    },
    ageMs: 2_000,
  };
  assert.equal(shouldDeferHungRestartForLivenessBeacon(read, 0), true);
});

test('a boot still making progress gets more time; a stale, foreign or stuck boot does not', () => {
  // Owner's Mac 10-08 under swap: boots took 75–95 s and each was killed at 90 s.
  const booting = { beacon: { at: new Date().toISOString(), pid: 4242, phase: { name: 'daemon.boot.start', activeMs: 40_000 } }, ageMs: 3_000 };
  assert.equal(shouldExtendReadinessForLivenessBeacon(booting, 4242, 90_000), true);
  assert.equal(shouldExtendReadinessForLivenessBeacon(booting, 9999, 90_000), false, "a previous daemon's beacon never extends this boot");
  assert.equal(shouldExtendReadinessForLivenessBeacon({ ...booting, ageMs: 25_000 }, 4242, 90_000), false, 'a stale beacon means the boot is not progressing');
  assert.equal(shouldExtendReadinessForLivenessBeacon(booting, 4242, 5 * 60_000), false, 'the whole wait stays bounded');
  assert.equal(shouldExtendReadinessForLivenessBeacon({ ...booting, beacon: { ...booting.beacon, phase: { name: 'daemon.boot.start', activeMs: 11 * 60_000 } } }, 4242, 90_000), false,
    'one phase past the stuck ceiling is a freeze');
  assert.equal(shouldExtendReadinessForLivenessBeacon(null, 4242, 90_000), false);
  assert.equal(shouldExtendReadinessForLivenessBeacon(booting, undefined, 90_000), false);
});

test('the HUNG line names the beacon running phase, its stamp ages and the in-flight set', () => {
  const diagnostic = formatHungRestartDiagnostic({
    misses: 4,
    unresponsiveMs: 80_000,
    ipcHeartbeatAgeMs: 85_000,
    // The IPC heartbeat is the last one sent before the loop stopped.
    heartbeat: { phase: { name: 'daemon.kick.notification_delivery', activeMs: 90_000 } },
    recentLogs: [],
    beacon: {
      ageMs: 3_000,
      beacon: {
        at: new Date().toISOString(),
        mainStampAgeMs: 81_234,
        maxMainStampAgeMs: 81_000,
        metered: true,
        phase: { name: 'daemon.nightly.link_sync', activeMs: 82_000 },
        inFlight: [
          { name: 'daemon.loop.memory_maintenance', activeMs: 90_000 },
          { name: 'daemon.nightly.link_sync', activeMs: 82_000 },
        ],
      },
    },
  });
  const headline = diagnostic.split('\n')[0]!;
  assert.match(headline, /phase=daemon\.kick\.notification_delivery/);
  assert.match(headline, /beacon_phase=daemon\.nightly\.link_sync active=82s/);
  assert.match(headline, /main_stamp_age=81234ms/);
  assert.match(headline, /max_main_stamp_age=81000ms/);
  assert.match(headline, /in_flight=\[daemon\.loop\.memory_maintenance\(90s\),daemon\.nightly\.link_sync\(82s\)\]/);
  assert.match(diagnostic, /\[beacon\] \{/);
});

test('a HUNG line without a beacon says so instead of guessing', () => {
  const diagnostic = formatHungRestartDiagnostic({
    misses: 4, unresponsiveMs: 80_000, ipcHeartbeatAgeMs: null, heartbeat: null, recentLogs: [], beacon: null,
  });
  assert.match(diagnostic.split('\n')[0]!, /beacon=none/);
});

test('the hang snapshot and the HUNG line carry the beacon read used for the decision', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./daemon-supervisor.ts', import.meta.url), 'utf8');
  assert.match(source, /formatHungRestartDiagnostic\(\{[^}]*beacon: beaconRead \}\)/);
  assert.match(source, /writeHungRestartSnapshot\(\{[^}]*beacon: beaconRead\?\.beacon/);
});
