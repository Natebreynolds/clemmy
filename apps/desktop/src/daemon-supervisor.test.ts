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
  shouldDeferHungRestartForIpcHeartbeat,
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
