import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cadenceChoices, cadenceWords, phonePushCaveat, refineHeartbeatPrompt } from './heartbeats.js';

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

test('push that cannot reach a phone says why, and says nothing when it can', () => {
  assert.equal(phonePushCaveat({ ready: true, phones: { webPush: 1, apns: 0 } }), '');
  assert.match(phonePushCaveat({ ready: false, reason: 'no_phone_registered', phones: { webPush: 0, apns: 0 } }), /Open Clem on your phone/);
  assert.match(phonePushCaveat({ ready: false, reason: 'apns_key_missing', phones: { webPush: 0, apns: 1 } }), /no Apple push key/);
  assert.equal(phonePushCaveat(undefined), '');
});

test('refining opens chat with the heartbeat named, then stops', () => {
  assert.equal(refineHeartbeatPrompt('Work review'), 'About my "Work review" heartbeat: ');
});
