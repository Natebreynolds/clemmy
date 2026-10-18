import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMeetingCaptureTarget, resolveMeetingLiveNavigation, retainedMeetingCapture,
  type MeetingCaptureTarget, type MeetingNavigationSdkStatus, type MeetingNavigationDaemonStatus,
  type MeetingNavigationRow } from './meeting-live-navigation.js';

const detectedAt = '2026-10-18T10:00:00.000Z';
const startedAt = '2026-10-18T10:02:00.000Z';
const target: MeetingCaptureTarget = { windowId: 'zoom:window+17', detectedAt, startedAt };
const query = (value: MeetingCaptureTarget) => new URLSearchParams({ captureWindow: value.windowId,
  captureDetectedAt: value.detectedAt, ...(value.startedAt ? { captureStartedAt: value.startedAt } : {}) });
function fixture() {
  const sdk: MeetingNavigationSdkStatus = { sdkAvailable: true, initialized: true, recording: true, capturePhase: 'recording',
    currentWindowId: target.windowId, recordingStartedAt: startedAt,
    detectedWindows: [{ windowId: target.windowId, detectedAt, recording: true }] };
  const daemon: MeetingNavigationDaemonStatus = { activeMeetingId: 'recall-exact', activeWindowId: target.windowId, activeRecordingStartedAt: startedAt };
  const meetings: MeetingNavigationRow[] = [{ id: 'recall-exact', windowId: target.windowId, status: 'recording',
    startedAt: detectedAt, recordingStartedAt: startedAt }];
  return { target: parseMeetingCaptureTarget(query(target)), sdk, daemon, meetings };
}
function unavailable(input: Parameters<typeof resolveMeetingLiveNavigation>[0], reason: string) {
  const result = resolveMeetingLiveNavigation(input);
  assert.equal(result.kind, 'unavailable');
  if (result.kind !== 'unavailable') throw new Error('Expected unavailable');
  assert.equal(result.reason, reason);
}

test('native popup query parses only its exact opaque window and canonical generation timestamps', () => {
  assert.deepEqual(parseMeetingCaptureTarget(''), { kind: 'none' });
  assert.deepEqual(parseMeetingCaptureTarget('?'), { kind: 'none' });
  assert.deepEqual(parseMeetingCaptureTarget(query(target)), { kind: 'target', target });
  assert.deepEqual(parseMeetingCaptureTarget(`?${query(target)}`), { kind: 'target', target });
  assert.deepEqual(parseMeetingCaptureTarget(query({ windowId: target.windowId, detectedAt })),
    { kind: 'target', target: { windowId: target.windowId, detectedAt } });
  assert.equal(parseMeetingCaptureTarget(query({ ...target, windowId: 'a'.repeat(512) })).kind, 'target');
});

test('foreign aliases, extra or duplicate parameters and missing generation never become an implicit active navigation', () => {
  for (const search of ['?windowId=zoom&detectedAt=2026-10-18T10%3A00%3A00.000Z', '?meeting=recall-exact',
    `?${query(target)}&captureWindow=another`, `?${query(target)}&captureDetectedAt=${detectedAt}`,
    `?${query(target)}&captureStartedAt=${startedAt}`, `?${query(target)}&redirect=elsewhere`,
    '?captureWindow=zoom', `?captureDetectedAt=${detectedAt}`, `?captureStartedAt=${startedAt}`]) {
    const parsed = parseMeetingCaptureTarget(search); assert.equal(parsed.kind, 'invalid', search);
    unavailable({ ...fixture(), target: parsed }, 'invalid_target');
  }
});

test('unsafe ids, malformed escapes, invalid dates and noncanonical timestamps are refused', () => {
  for (const windowId of ['', 'a'.repeat(513), 'https://example.test', '../window', 'window\\part', 'window?x', 'window#x',
    'window%2Fnext', 'window id', 'window\nnext', 'window<script>', 'a\u0000b']) {
    assert.equal(parseMeetingCaptureTarget(query({ ...target, windowId })).kind, 'invalid', JSON.stringify(windowId));
  }
  for (const timestamp of ['2026-02-30T10:00:00.000Z', '2026-10-18T10:00:00Z', '2026-10-18T10:00:00.000+00:00',
    '2026-10-18', '2026-10-18T24:00:00.000Z', 'not-a-date', '']) {
    assert.equal(parseMeetingCaptureTarget(query({ ...target, detectedAt: timestamp })).kind, 'invalid', timestamp);
    const params = query(target); params.set('captureStartedAt', timestamp);
    assert.equal(parseMeetingCaptureTarget(params).kind, 'invalid', timestamp);
  }
  for (const raw of ['?captureWindow=window%ZZ', '?captureWindow=%', `?${query(target)}#fragment`, '?'.repeat(4_097)]) {
    assert.equal(parseMeetingCaptureTarget(raw).kind, 'invalid');
  }
});

test('explicit live target joins the exact native epoch and active record, not historical detection startedAt', () => {
  assert.deepEqual(resolveMeetingLiveNavigation(fixture()), { kind: 'recording', source: 'explicit',
    meetingId: 'recall-exact', windowId: target.windowId, startedAt, target });
});

test('same window reused at a different detection generation cannot select a later recording', () => {
  const input = fixture(); input.sdk.detectedWindows = [{ windowId: target.windowId, detectedAt: '2026-10-18T11:00:00.000Z', recording: true }];
  input.sdk.recordingStartedAt = '2026-10-18T11:01:00.000Z';
  input.daemon.activeRecordingStartedAt = input.sdk.recordingStartedAt;
  input.meetings[0]!.recordingStartedAt = input.sdk.recordingStartedAt;
  unavailable(input, 'capture_replaced');
});

test('an ended notification retains only its exact recording after a new meeting is detected', () => {
  const input = fixture();
  input.meetings[0]!.status = 'completed';
  input.meetings.unshift({ id: 'newer-detected-meeting', windowId: target.windowId, status: 'detected',
    startedAt: '2026-10-18T11:00:00.000Z' });
  assert.deepEqual(retainedMeetingCapture(input), { meetingId: 'recall-exact', windowId: target.windowId, startedAt });
  input.meetings.unshift({ id: 'newer-recording', windowId: target.windowId, status: 'recording', recordingStartedAt: '2026-10-18T11:01:00.000Z' });
  assert.equal(retainedMeetingCapture(input)?.meetingId, 'recall-exact');
});

test('retained navigation never guesses a capture from the window, newest row or an ambiguous identity', () => {
  const input = fixture(); input.meetings[0]!.status = 'completed';
  const promptTarget = parseMeetingCaptureTarget(query({ windowId: target.windowId, detectedAt }));
  assert.equal(retainedMeetingCapture({ ...input, target: promptTarget }), null, 'prompt-only URL needs a recording observed by this view');
  assert.deepEqual(retainedMeetingCapture({ ...input, target: promptTarget,
    observed: { meetingId: 'recall-exact', windowId: target.windowId, startedAt } }),
    { meetingId: 'recall-exact', windowId: target.windowId, startedAt });
  assert.equal(retainedMeetingCapture({ ...input, target: promptTarget,
    observed: { meetingId: 'another-meeting', windowId: target.windowId, startedAt } }), null);
  assert.equal(retainedMeetingCapture({ ...input, target: { kind: 'invalid', reason: 'invalid_query' } }), null);
  assert.equal(retainedMeetingCapture({ ...input, target: { kind: 'none' } }), null);
  input.meetings.push({ ...input.meetings[0]!, id: 'ambiguous-copy' });
  assert.equal(retainedMeetingCapture(input), null);
});

test('canonical start must match exactly at URL, native, daemon and record boundaries', () => {
  for (const part of ['query', 'daemon', 'row'] as const) {
    const input = fixture(); const different = '2026-10-18T10:02:00.001Z';
    if (part === 'query') input.target = parseMeetingCaptureTarget(query({ ...target, startedAt: different }));
    if (part === 'daemon') input.daemon.activeRecordingStartedAt = different;
    if (part === 'row') input.meetings[0]!.recordingStartedAt = different;
    unavailable(input, part === 'daemon' ? 'daemon_identity_mismatch' : 'recording_identity_mismatch');
  }
});

test('a stale explicit window cannot fall back to another currently active meeting', () => {
  const input = fixture(); input.sdk.currentWindowId = 'other-window';
  input.sdk.detectedWindows = [{ windowId: 'other-window', detectedAt, recording: true }];
  input.daemon.activeWindowId = 'other-window'; input.daemon.activeMeetingId = 'other-meeting';
  input.meetings = [{ id: 'other-meeting', windowId: 'other-window', status: 'recording', recordingStartedAt: startedAt }];
  unavailable(input, 'capture_not_detected');
});

test('duplicate native window entries or same-capture records deny ambiguous selection', () => {
  const native = fixture(); native.sdk.detectedWindows = [native.sdk.detectedWindows![0]!, native.sdk.detectedWindows![0]!];
  unavailable(native, 'ambiguous_capture');
  const rows = fixture(); rows.meetings.push({ ...rows.meetings[0]!, id: 'second-record' });
  unavailable(rows, 'ambiguous_meeting');
  const duplicateId = fixture(); duplicateId.meetings.push({ id: 'recall-exact', windowId: 'other-window', status: 'recording', recordingStartedAt: startedAt });
  unavailable(duplicateId, 'ambiguous_meeting');
});

test('default selection is the exact active id and never the newest or first recording row', () => {
  const input = { ...fixture(), target: { kind: 'none' } as const };
  input.meetings.unshift({ id: 'unrelated-later', windowId: 'later-window', status: 'recording', recordingStartedAt: '2026-10-18T12:00:00.000Z' });
  assert.deepEqual(resolveMeetingLiveNavigation(input), { kind: 'recording', source: 'active',
    meetingId: 'recall-exact', windowId: target.windowId, startedAt });
  input.daemon.activeMeetingId = 'missing-active'; unavailable(input, 'daemon_identity_mismatch');
});

test('a manually selected history record is never replaced by default active navigation', () => {
  assert.deepEqual(resolveMeetingLiveNavigation({ ...fixture(), target: { kind: 'none' }, historySelected: true }), { kind: 'none' });
});

test('matching prompt may offer its own capture, but navigation itself has no start action', () => {
  const input = fixture(); input.target = parseMeetingCaptureTarget(query({ windowId: target.windowId, detectedAt }));
  input.sdk.recording = false; input.sdk.capturePhase = 'prompt'; delete input.sdk.currentWindowId; delete input.sdk.recordingStartedAt;
  input.sdk.detectedWindows = [{ windowId: target.windowId, detectedAt, recording: false }];
  assert.deepEqual(resolveMeetingLiveNavigation(input), { kind: 'prompt', target: { windowId: target.windowId, detectedAt } });
});

test('optimistic starting and stopping remain waiting even when a daemon recording row exists', () => {
  for (const phase of ['starting', 'stopping'] as const) {
    const input = fixture(); input.sdk.capturePhase = phase;
    const result = resolveMeetingLiveNavigation(input);
    assert.equal(result.kind, 'waiting');
    if (result.kind === 'waiting') assert.equal(result.reason, phase === 'starting' ? 'capture_starting' : 'capture_stopping');
  }
});

test('legacy detection timestamps or missing canonical recording identity never qualify a live record', () => {
  const row = fixture(); delete row.meetings[0]!.recordingStartedAt; row.meetings[0]!.startedAt = startedAt;
  unavailable(row, 'recording_identity_mismatch');
  const daemon = fixture(); delete daemon.daemon.activeRecordingStartedAt;
  assert.equal(resolveMeetingLiveNavigation(daemon).kind, 'waiting');
  const native = fixture(); delete native.sdk.recordingStartedAt;
  assert.equal(resolveMeetingLiveNavigation(native).kind, 'waiting');
});

test('unknown native status and missing rows wait; browser-only metadata cannot auto-select a live recording', () => {
  assert.equal(resolveMeetingLiveNavigation({ ...fixture(), sdk: undefined }).kind, 'waiting');
  unavailable({ ...fixture(), sdk: null }, 'native_unavailable');
  assert.equal(resolveMeetingLiveNavigation({ ...fixture(), daemon: undefined }).kind, 'waiting');
  assert.equal(resolveMeetingLiveNavigation({ ...fixture(), meetings: [] }).kind, 'waiting');
  assert.deepEqual(resolveMeetingLiveNavigation({ target: { kind: 'none' }, meetings: [] }), { kind: 'none' });
});

test('completed or contrary current record never becomes live and pure resolution never mutates input', () => {
  const input = fixture(); input.meetings[0]!.status = 'completed'; unavailable(input, 'meeting_not_recording');
  const exact = fixture(); const before = JSON.stringify(exact); resolveMeetingLiveNavigation(exact);
  assert.equal(JSON.stringify(exact), before);
  const params = query(target); const text = params.toString(); parseMeetingCaptureTarget(params); assert.equal(params.toString(), text);
});
