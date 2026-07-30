/**
 * Regression pin: an autonomy cycle that stops WAITING ON THE HUMAN must PARK,
 * not fail.
 *
 * Before this, every non-success stop reason — including 'pending-approval' and
 * 'awaiting-input', which are healthy outcomes — became a generic thrown error,
 * was logged as a cycle failure, and got the 90s failure-retry backoff. So a
 * cycle that legitimately stopped for an approval card re-ran every 90 seconds
 * forever, re-tripping the same card. Parking is what makes "proactive" safe:
 * the work sits in the user's inbox until they act, instead of hammering.
 *
 * Run: npx tsx --test src/agents/autonomy-parking.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AutonomyCycleParked,
  _testOnly_isParkedCycleReason as isParkedCycleReason,
  _testOnly_buildCycleParkedState as buildCycleParkedState,
  _testOnly_buildCycleFailureState as buildCycleFailureState,
} from './autonomy-v2.js';

test('waiting-on-the-human stop reasons are classified as parked, not failed', () => {
  for (const reason of ['pending-approval', 'awaiting-input', 'awaits-user-material']) {
    assert.equal(isParkedCycleReason(reason), true, `${reason} must park (it is waiting on the user)`);
  }
});

test('genuine failures are NOT treated as parked (they keep the retry backoff)', () => {
  for (const reason of ['error', 'max-turns', 'cancelled', undefined]) {
    assert.equal(
      isParkedCycleReason(reason as string | undefined),
      false,
      `${String(reason)} is a real failure/terminal reason and must not park`,
    );
  }
});

test('a parked state clears the retry clock and the error — it waits for the user', () => {
  const failed = buildCycleFailureState(
    { engine: 'v2' } as never,
    'agent-slug',
    'boom',
    Date.UTC(2026, 0, 1),
    ['inbox-1'],
  );
  // The failure state is the contrast: it sets a retry clock and an error.
  assert.ok(failed.nextWakeAt, 'a real failure schedules a retry');
  assert.ok(failed.lastError, 'a real failure records the error');

  const parked = buildCycleParkedState(failed, 'pending-approval', Date.UTC(2026, 0, 1));
  assert.equal(parked.parkedReason, 'pending-approval');
  assert.ok(parked.parkedAt, 'parking is stamped so the UI can show why it is waiting');
  assert.equal(parked.nextWakeAt, undefined, 'parked work must NOT be on a retry clock (no 90s hammering)');
  assert.equal(parked.lastError, undefined, 'waiting on the user is not an error');
  assert.equal(parked.failedInboxFingerprint, undefined, 'the failure backoff fingerprint is cleared on park');
});

test('AutonomyCycleParked carries the reason so the caller can park deliberately', () => {
  const err = new AutonomyCycleParked('pending-approval');
  assert.equal(err.reason, 'pending-approval');
  assert.equal(err.name, 'AutonomyCycleParked');
  assert.match(err.message, /cycle_parked:pending-approval/);
  assert.ok(err instanceof Error, 'must remain a real Error so existing catch paths still work');
});
