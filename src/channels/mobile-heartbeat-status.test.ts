import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { HeartbeatPresentation, HeartbeatStatus } from '../agents/heartbeats.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-mobile-heartbeat-status-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TEST_HOME, 'state'));
const { serializeHeartbeatForMobile, serializeHeartbeatSnapshotForMobile } = await import('./mobile-routes.js');
test.after(async () => {
  const { closeEventLog } = await import('../runtime/harness/eventlog.js');
  closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function heartbeat(presentation: HeartbeatPresentation): HeartbeatStatus {
  return { id: 'calendar', title: 'Calendar watch', purpose: 'Controlled read status.', enabled: true, cadenceMinutes: 30,
    cadenceRange: { min: 5, max: 240 }, running: false, quietHoursActive: false,
    metrics: { ticks: 1, quietTicks: 1, itemsProduced: 0, itemsAcknowledged: 0, itemsRetired: 0, modelCalls: 0, modelVetoes: 0 },
    openItems: [{ key: 'controlled-item', kind: 'moved', subject: 'Controlled event', createdAt: '2026-10-16T11:00:00.000Z' }], recentlyRetired: [], rulesApply: false,
    contract: { id: 'calendar', notify: 'quiet', rules: [], updatedAt: '2026-10-16T11:00:00.000Z' },
    phonePush: { ready: false, reason: 'no_phone_registered', phones: { webPush: 0, apns: 0 } }, presentation };
}

test('mobile heartbeat projection preserves schedule and incomplete-read states instead of reducing them to On', () => {
  for (const state of ['off', 'quiet_hours', 'checking', 'scheduled', 'due', 'never', 'failed', 'partial', 'unknown'] as const) {
    const presentation: HeartbeatPresentation = { state, lastCheck: { state: state === 'failed' || state === 'partial' ? state : 'unknown',
      at: '2026-10-16T11:00:00.000Z', readFailures: 1, successfulReads: state === 'partial' ? 1 : 0 },
      ...(state === 'scheduled' ? { nextCheckAt: '2026-10-16T12:30:00.000Z' } : {}) };
    const result = serializeHeartbeatForMobile(heartbeat(presentation));
    assert.deepEqual(result.presentation, presentation);
    assert.equal(result.openItems, 1);
    assert.equal(result.notify, 'quiet');
    assert.equal('authority' in result, false);
    assert.equal('approval' in result, false);
  }
});

test('the mobile GET projection retains unavailable identities without manufacturing their enabled state', () => {
  const snapshot = { heartbeats: [heartbeat({ state: 'never', lastCheck: { state: 'never' } })],
    unavailable: [{ id: 'noticing' as const, title: 'Noticing', reason: 'status_unavailable' as const }], generatedAt: '2026-10-16T12:00:00.000Z' };
  const result = serializeHeartbeatSnapshotForMobile(snapshot);
  assert.equal(result.heartbeats[0]?.openItems, 1);
  assert.deepEqual(result.unavailable, snapshot.unavailable);
  assert.equal(result.generatedAt, snapshot.generatedAt);
  assert.equal('enabled' in result.unavailable[0]!, false);
});
