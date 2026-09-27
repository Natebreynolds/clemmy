import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeThisDevice } from './device-name.js';

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const WKWEBVIEW = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

test('the phone names itself by platform and app, never by user-agent', () => {
  assert.equal(describeThisDevice(SAFARI, false), 'iPhone · Safari');
  assert.equal(describeThisDevice(WKWEBVIEW, true), 'iPhone · Clem app');
  assert.equal(describeThisDevice(WKWEBVIEW, false), 'iPhone · Clem app');
});
