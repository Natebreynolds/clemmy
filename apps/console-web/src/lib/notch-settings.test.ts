import assert from 'node:assert/strict';
import test from 'node:test';
import {
  notchRecallCapability,
  notchRecallCapabilityCopy,
  type NotchSettingsSnapshot,
} from './notch-settings.js';

type MeetingCapture = NonNullable<NotchSettingsSnapshot['meetingCapture']>;

function capture(overrides: Partial<MeetingCapture> = {}): MeetingCapture {
  return {
    enabled: true,
    sdkAvailable: true,
    initialized: true,
    recording: false,
    autoRecord: false,
    platformSupport: { supported: true },
    ...overrides,
  };
}

test('Recall capability only claims live controls for an initialized available SDK', () => {
  assert.equal(notchRecallCapability(capture()), 'ready');
  assert.equal(notchRecallCapability(capture({ sdkAvailable: false })), 'needs-attention');
  assert.equal(notchRecallCapability(capture({ initialized: false })), 'needs-attention');
  assert.equal(notchRecallCapability(capture({ platformSupport: { supported: false } })), 'unsupported');
  assert.equal(notchRecallCapability(capture({ enabled: false })), 'off');
});

test('Recall capability copy never claims failed capture is live', () => {
  const failed = capture({ sdkAvailable: false, initialized: false, lastError: 'SDK failed to load.' });
  const copy = notchRecallCapabilityCopy(failed);
  assert.match(copy, /need attention/i);
  assert.match(copy, /SDK failed to load/);
  assert.doesNotMatch(copy, /controls are live/i);
});

test('Recall capability copy does not claim live notch controls while the notch is off', () => {
  const copy = notchRecallCapabilityCopy(capture(), false);
  assert.match(copy, /notch is off/i);
  assert.doesNotMatch(copy, /controls are live/i);
});

test('notch capability copy keeps in-person recording discoverable when Recall is off', () => {
  const copy = notchRecallCapabilityCopy(capture({ enabled: false }));
  assert.match(copy, /in-person microphone recording/i);
  assert.match(copy, /turn on online meeting capture/i);
});
