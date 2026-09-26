import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cadenceChoices, cadenceWords, refineHeartbeatPrompt } from './heartbeats.js';

test('a cadence reads the way a person says it', () => {
  assert.equal(cadenceWords(15), 'every 15 min');
  assert.equal(cadenceWords(60), 'every hour');
  assert.equal(cadenceWords(120), 'every 2 h');
  assert.equal(cadenceWords(1440), 'every day');
  assert.equal(cadenceWords(2880), 'every 2 days');
});

test('the cadence choices stay inside the heartbeat range and always include the current value', () => {
  assert.deepEqual(cadenceChoices({ min: 15, max: 1440 }, 60), [15, 30, 60, 120, 180, 240, 360, 720, 1440]);
  assert.deepEqual(cadenceChoices({ min: 5, max: 240 }, 45), [5, 10, 15, 30, 45, 60, 120, 180, 240]);
});

test('refining opens chat with the heartbeat named, then stops', () => {
  assert.equal(refineHeartbeatPrompt('Work review'), 'About my "Work review" heartbeat: ');
});
