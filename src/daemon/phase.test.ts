/**
 * Run: npx tsx --test src/daemon/phase.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
