import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isExactClementineLiveIpcSender,
  isExactClementineNotchSettingsIpcSender,
} from './live-ipc-security.js';

const expected = { webContentsId: 42, mainFrameRoutingId: 7 };

test('accepts only the current Clementine Live main frame', () => {
  assert.equal(isExactClementineLiveIpcSender({ senderId: 42, senderFrameRoutingId: 7 }, expected), true);
  assert.equal(isExactClementineLiveIpcSender({ senderId: 41, senderFrameRoutingId: 7 }, expected), false);
  assert.equal(isExactClementineLiveIpcSender({ senderId: 42, senderFrameRoutingId: 8 }, expected), false);
  assert.equal(isExactClementineLiveIpcSender({ senderId: 42, senderFrameRoutingId: null }, expected), false);
  assert.equal(isExactClementineLiveIpcSender({ senderId: 42, senderFrameRoutingId: 7 }, null), false);
});

test('notch settings require the exact trusted Settings main frame', () => {
  const event = { senderId: 42, senderFrameRoutingId: 7 };
  assert.equal(isExactClementineNotchSettingsIpcSender(
    event,
    expected,
    'http://127.0.0.1:3131/console/settings?token=redacted',
    true,
  ), true);
  assert.equal(isExactClementineNotchSettingsIpcSender(event, expected, 'http://127.0.0.1:3131/console/chat', true), false);
  assert.equal(isExactClementineNotchSettingsIpcSender(event, expected, 'http://evil.example/console/settings', false), false);
  assert.equal(isExactClementineNotchSettingsIpcSender({ ...event, senderFrameRoutingId: 8 }, expected, 'http://127.0.0.1:3131/console/settings', true), false);
});
