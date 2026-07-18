import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTO_RECORD_CONSENT_LABEL,
  INITIAL_NOTCH_MEETING_STATE,
  notchMeetingCaptureInterrupted,
  notchMeetingReducer,
  notchMeetingStateFromStatus,
  notchMeetingStopControl,
} from './notch-meeting-model.js';

const meeting = { windowId: 'meeting-1', platform: 'zoom', title: 'Roadmap review' };

test('hydrates a pending meeting prompt and an already-active recording', () => {
  assert.deepEqual(notchMeetingStateFromStatus({
    enabled: true,
    capturePhase: 'prompt',
    pendingMeeting: meeting,
  }), { phase: 'prompt', meeting });

  assert.deepEqual(notchMeetingStateFromStatus({
    enabled: true,
    capturePhase: 'recording',
    currentWindowId: meeting.windowId,
    recordingStartedAt: '2026-07-18T12:00:00.000Z',
    detectedWindows: [meeting],
  }), {
    phase: 'recording',
    meeting,
    recordingStartedAt: '2026-07-18T12:00:00.000Z',
  });
});

test('requires native confirmation before presenting a recording as live', () => {
  let state = notchMeetingReducer({ phase: 'prompt', meeting }, { type: 'start', meeting });
  assert.equal(state.phase, 'starting');
  state = notchMeetingReducer(state, { type: 'event', event: { type: 'recording-start-requested', ...meeting } });
  assert.equal(state.phase, 'starting');
  state = notchMeetingReducer(state, { type: 'event', event: { type: 'recording-started', windowId: meeting.windowId } });
  assert.equal(state.phase, 'recording');
});

test('late stop acknowledgement cannot regress the completed state', () => {
  let state = notchMeetingReducer({ phase: 'recording', meeting }, { type: 'stop' });
  assert.equal(state.phase, 'stopping');
  state = notchMeetingReducer(state, { type: 'event', event: { type: 'recording-ended', ...meeting } });
  assert.equal(state.phase, 'stopped');
  state = notchMeetingReducer(state, { type: 'event', event: { type: 'recording-stop-requested', windowId: meeting.windowId } });
  assert.equal(state.phase, 'stopped');
  state = notchMeetingReducer(state, {
    type: 'hydrate',
    status: { enabled: true, capturePhase: 'idle', lastMeeting: meeting },
  });
  assert.equal(state.phase, 'stopped', 'idle stop response must retain the terminal state');
});

test('active recording identity wins over another pending meeting', () => {
  const other = { windowId: 'meeting-2', platform: 'teams', title: 'Other call' };
  const state = notchMeetingStateFromStatus({
    enabled: true,
    capturePhase: 'recording',
    currentWindowId: meeting.windowId,
    pendingMeeting: other,
    detectedWindows: [meeting, other],
  });
  assert.equal(state.phase, 'recording');
  assert.equal(state.meeting?.windowId, meeting.windowId);
  const afterPromptEvent = notchMeetingReducer(state, {
    type: 'event',
    event: { type: 'meeting-prompt-required', ...other },
  });
  assert.equal(afterPromptEvent.phase, 'recording');
  assert.equal(afterPromptEvent.meeting?.windowId, meeting.windowId);
});

test('stale hydration cannot regress confirmed recording and media truth follows native events', () => {
  let state = notchMeetingReducer({ phase: 'starting', meeting }, {
    type: 'event',
    event: { type: 'recording-started', ...meeting },
  });
  state = notchMeetingReducer(state, {
    type: 'hydrate',
    status: { enabled: true, capturePhase: 'starting', currentWindowId: meeting.windowId, detectedWindows: [meeting] },
  });
  assert.equal(state.phase, 'recording');

  state = notchMeetingReducer(state, {
    type: 'event',
    event: { type: 'media-capture-status', windowId: meeting.windowId, mediaType: 'audio', capturing: false },
  });
  state = notchMeetingReducer(state, {
    type: 'event',
    event: { type: 'network-status', status: 'disconnected' },
  });
  assert.equal(state.audioCapturing, false);
  assert.equal(state.networkStatus, 'disconnected');
});

test('stale meeting events do not replace an active recording', () => {
  const state = notchMeetingReducer(
    { phase: 'recording', meeting },
    { type: 'event', event: { type: 'recording-ended', windowId: 'meeting-2', title: 'Other call' } },
  );
  assert.equal(state.phase, 'recording');
  assert.equal(state.meeting?.windowId, meeting.windowId);
  assert.deepEqual(notchMeetingReducer(INITIAL_NOTCH_MEETING_STATE, { type: 'event', event: null }), INITIAL_NOTCH_MEETING_STATE);
});

test('starting keeps a usable cancel control while the start request is pending', () => {
  assert.deepEqual(notchMeetingStopControl('starting', 'start'), {
    label: 'Cancel recording',
    disabled: false,
  });
  assert.deepEqual(notchMeetingStopControl('starting', 'start-auto'), {
    label: 'Cancel recording',
    disabled: false,
  });
  assert.deepEqual(notchMeetingStopControl('starting', 'stop'), {
    label: 'Cancelling…',
    disabled: true,
  });
});

test('collapsed capture truth treats either audio or network interruption as interrupted', () => {
  assert.equal(notchMeetingCaptureInterrupted({ audioCapturing: false }), true);
  assert.equal(notchMeetingCaptureInterrupted({ audioCapturing: true, networkStatus: 'disconnected' }), true);
  assert.equal(notchMeetingCaptureInterrupted({ audioCapturing: true, networkStatus: 'reconnected' }), false);
});

test('auto-record consent names its future-meeting effect', () => {
  assert.equal(AUTO_RECORD_CONSENT_LABEL, 'Record now & auto-record future meetings');
});
