import assert from 'node:assert/strict';
import test from 'node:test';
import type { RecallCaptureStatus } from './recall-capture.js';
import {
  isCurrentDetectedMeeting,
  recallCaptureRequiresVisibleControls,
  recallMeetingDetectionNotificationCopy,
  sanitizeLocalMeetingRecorderForNotch,
  sanitizeRecallEventForNotch,
  sanitizeRecallStatusForNotch,
} from './notch-meeting.js';

const status: RecallCaptureStatus = {
  sdkAvailable: true,
  platformSupport: { supported: true, platform: 'darwin', arch: 'arm64' },
  initialized: true,
  enabled: true,
  recording: true,
  capturePhase: 'recording',
  recordingStartedAt: '2026-07-18T12:00:00.000Z',
  currentWindowId: 'window-1',
  permissionStatuses: { microphone: 'granted', 'screen-capture': 'granted' },
  detectedWindows: [{
    windowId: 'window-1',
    platform: 'zoom',
    title: 'Roadmap review',
    detectedAt: '2026-07-18T11:59:00.000Z',
    recording: true,
  }],
  hasActiveMeetingWindow: true,
  networkStatus: 'reconnected',
  mediaCaptureStatuses: { 'window-1': { audio: true, video: false } },
  complianceMessageStatuses: {},
  settings: {
    enabled: true,
    region: 'us-west-2',
    autoRecord: false,
    liveTranscript: true,
    analyzeOnComplete: true,
  },
};

test('sanitizes Recall status to presentation-only meeting data', () => {
  const safe = sanitizeRecallStatusForNotch(status);
  assert.equal(safe?.recording, true);
  assert.equal(safe?.detectedWindows[0]?.title, 'Roadmap review');
  assert.equal(safe?.autoRecord, false);
  assert.deepEqual(safe?.mediaCapture, { audio: true, video: false });
  assert.equal(safe?.networkStatus, 'reconnected');
  assert.equal('region' in (safe ?? {}), false);
  assert.equal('liveTranscript' in (safe ?? {}), false);
});

test('allowlists live meeting events and removes private recording metadata', () => {
  const safe = sanitizeRecallEventForNotch({
    type: 'recording-ended',
    at: '2026-07-18T12:30:00.000Z',
    windowId: 'window-1',
    title: 'Roadmap review',
    sdkUploadId: 'private-upload-id',
    recordingId: 'private-recording-id',
    complete: { token: 'private' },
  });
  assert.deepEqual(safe, {
    type: 'recording-ended',
    at: '2026-07-18T12:30:00.000Z',
    windowId: 'window-1',
    title: 'Roadmap review',
  });
  assert.equal(sanitizeRecallEventForNotch({ type: 'transcript', text: 'private words' }), null);
  assert.deepEqual(sanitizeRecallEventForNotch({
    type: 'media-capture-status',
    windowId: 'window-1',
    mediaType: 'audio',
    capturing: false,
    uploadToken: 'private',
  }), {
    type: 'media-capture-status',
    windowId: 'window-1',
    capturing: false,
    mediaType: 'audio',
  });
});

test('requires an exact currently detected window before acting', () => {
  assert.equal(isCurrentDetectedMeeting(status, 'window-1'), true);
  assert.equal(isCurrentDetectedMeeting(status, 'window-2'), false);
  assert.equal(isCurrentDetectedMeeting(status, '  '), false);
});

test('starting, recording, and stopping require persistent native controls', () => {
  assert.equal(recallCaptureRequiresVisibleControls({ capturePhase: 'starting' }), true);
  assert.equal(recallCaptureRequiresVisibleControls({ capturePhase: 'recording' }), true);
  assert.equal(recallCaptureRequiresVisibleControls({ capturePhase: 'stopping' }), true);
  assert.equal(recallCaptureRequiresVisibleControls({ capturePhase: 'prompt' }), false);
  assert.equal(recallCaptureRequiresVisibleControls({ capturePhase: 'idle' }), false);
  assert.equal(recallCaptureRequiresVisibleControls(null), false);
});

test('local recorder sanitizer never exposes audio paths to the notch', () => {
  const safe = sanitizeLocalMeetingRecorderForNotch({
    recording: true,
    sessionId: 'local-session-123',
    title: 'Customer workshop',
    audioPath: '/private/clementine/meeting-audio.wav',
    startedAt: '2026-07-19T10:00:00.000Z',
    bytes: 32_000,
    durationSeconds: 1,
    sampleRate: 16_000,
    channels: 1,
    lastAppendAt: '2026-07-19T10:00:01.000Z',
    stale: false,
  });
  assert.equal(safe.recording, true);
  assert.equal(safe.sessionId, 'local-session-123');
  assert.equal(safe.title, 'Customer workshop');
  assert.equal('audioPath' in safe, false);
  assert.equal('lastAppendAt' in safe, false);
});

test('native Recall detection alerts use safe provider-specific copy', () => {
  assert.deepEqual(recallMeetingDetectionNotificationCopy('slack-huddle'), {
    title: 'Slack Huddle detected',
    body: 'Clementine is ready to record it. Click to choose from the notch.',
  });
  assert.deepEqual(recallMeetingDetectionNotificationCopy('microsoft-teams', true), {
    title: 'Microsoft Teams meeting detected',
    body: 'Clementine is recording it now. Click to open the notch controls.',
  });
  assert.equal(recallMeetingDetectionNotificationCopy('private-custom-provider').title, 'Online meeting detected');
});
