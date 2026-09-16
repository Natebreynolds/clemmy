/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/turn-clock.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _resetTurnClocksForTests, markTurnClock, startTurnClock, takeTurnClock } from './turn-clock.js';

test('stages record offsets from the start and the take clears the clock', async () => {
  _resetTurnClocksForTests();
  startTurnClock('sess-a');
  markTurnClock('sess-a', 'capability_discovered');
  await new Promise((resolve) => setTimeout(resolve, 15));
  markTurnClock('sess-a', 'turn_started');
  const stages = takeTurnClock('sess-a');
  assert.ok(stages);
  assert.ok(stages.capability_discovered >= 0);
  assert.ok(stages.turn_started >= stages.capability_discovered + 10, 'later stages carry larger offsets');
  assert.ok(stages.totalMs >= stages.turn_started);
  assert.equal(takeTurnClock('sess-a'), null, 'taken once');
});

test('a session with no running clock is a no-op for marks and takes', () => {
  _resetTurnClocksForTests();
  markTurnClock('sess-none', 'anything');
  markTurnClock(undefined, 'anything');
  assert.equal(takeTurnClock('sess-none'), null);
  assert.equal(takeTurnClock(null), null);
});

test('restarting a clock forgets the previous turn, and the map stays bounded', () => {
  _resetTurnClocksForTests();
  startTurnClock('sess-b');
  markTurnClock('sess-b', 'old');
  startTurnClock('sess-b');
  const stages = takeTurnClock('sess-b');
  assert.ok(stages && !('old' in stages), 'a fresh turn starts a fresh record');
  for (let index = 0; index < 300; index += 1) startTurnClock(`sess-${index}`);
  assert.equal(takeTurnClock('sess-0'), null, 'the oldest clock was evicted');
  assert.ok(takeTurnClock('sess-299'), 'the newest clock survives');
});
