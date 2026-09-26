import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phonePushReadiness } from './phone-push-readiness.js';

test('no phone registered is said plainly, before anything about keys', () => {
  assert.deepEqual(phonePushReadiness([], false), { ready: false, reason: 'no_phone_registered', phones: { webPush: 0, apns: 0 } });
  assert.deepEqual(phonePushReadiness([{ type: 'discord_channel', enabled: true }], true).reason, 'no_phone_registered');
});

test('a native phone without an APNs key on this machine is not ready; with the key it is', () => {
  const apns = [{ type: 'apns', enabled: true }];
  assert.deepEqual(phonePushReadiness(apns, false), { ready: false, reason: 'apns_key_missing', phones: { webPush: 0, apns: 1 } });
  assert.equal(phonePushReadiness(apns, true).ready, true);
});

test('a web-push phone is ready on its own, and a disabled destination does not count', () => {
  assert.equal(phonePushReadiness([{ type: 'web_push', enabled: true }], false).ready, true);
  assert.equal(phonePushReadiness([{ type: 'web_push', enabled: false }], true).reason, 'no_phone_registered');
});
