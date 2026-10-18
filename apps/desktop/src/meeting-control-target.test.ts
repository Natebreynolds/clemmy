import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRecallMeetingDetectionTarget, assertRecallMeetingStopTarget } from './meeting-control-target.js';

type Status = NonNullable<Parameters<typeof assertRecallMeetingStopTarget>[1]>;
const windowId = 'controlled-window:exact';
const detectedAt = '2026-10-18T09:00:00.000Z';
const recordingStartedAt = '2026-10-18T09:01:00.000Z';
const target = { windowId, recordingStartedAt };
function recording(): Status { return { recording: true, capturePhase: 'recording', currentWindowId: windowId,
  recordingStartedAt, detectedWindows: [{ windowId, detectedAt }] }; }

test('exact Stop validates synchronously immediately before one controlled stop dispatch', () => {
  let stops = 0; const status = recording(); const order: string[] = [];
  const read = () => { order.push('status'); return status; };
  const stop = () => { order.push('stop'); stops++; return Promise.resolve(); };
  const dispatch = () => { assertRecallMeetingStopTarget(target, read()); return stop(); };
  void dispatch();
  assert.equal(stops, 1); assert.deepEqual(order, ['status', 'stop']);
  assert.doesNotThrow(() => assertRecallMeetingStopTarget(target, { ...status, capturePhase: 'starting' }));
});

test('an old exact Stop cannot stop a replaced, different, ended or unknown recording', () => {
  let stops = 0;
  for (const status of [null, undefined, { ...recording(), currentWindowId: 'different-window' },
    { ...recording(), recordingStartedAt: '2026-10-18T09:02:00.000Z' },
    { ...recording(), recording: false }, { ...recording(), capturePhase: 'idle' as const },
    { ...recording(), capturePhase: 'stopping' as const }, { ...recording(), recordingStartedAt: undefined }]) {
    assert.throws(() => { assertRecallMeetingStopTarget(target, status); stops++; }, /no longer active/);
  }
  assert.equal(stops, 0);
});

test('supplied Stop targets are strict, bounded and complete instead of silently becoming legacy Stop', () => {
  for (const value of [null, {}, [], target.windowId, { windowId }, { recordingStartedAt },
    { ...target, unknown: true }, { ...target, windowId: 'bad/id' }, { ...target, windowId: 'x'.repeat(513) },
    { ...target, recordingStartedAt: null }, { ...target, recordingStartedAt: '2026-10-18T09:01:00Z' },
    { ...target, recordingStartedAt: '2026-02-30T09:01:00.000Z' }]) {
    assert.throws(() => assertRecallMeetingStopTarget(value, recording()), /no longer active/);
  }
});

test('legacy no-payload Stop and one-argument detected Record retain existing admission behavior', () => {
  assert.doesNotThrow(() => assertRecallMeetingStopTarget(undefined, null));
  assert.doesNotThrow(() => assertRecallMeetingStopTarget(undefined, recording()));
  assert.doesNotThrow(() => assertRecallMeetingDetectionTarget(windowId, undefined, null));
});

test('exact detected Record requires the same currently present detection generation', () => {
  let records = 0;
  const dispatch = (status: Status | null) => {
    assertRecallMeetingDetectionTarget(windowId, detectedAt, status); records++;
  };
  dispatch(recording()); assert.equal(records, 1);
  for (const status of [null, { ...recording(), detectedWindows: [] },
    { ...recording(), detectedWindows: [{ windowId: 'different-window', detectedAt }] },
    { ...recording(), detectedWindows: [{ windowId, detectedAt: recordingStartedAt }] }]) {
    assert.throws(() => dispatch(status), /changed or closed/);
  }
  assert.equal(records, 1, 'a closed/reused detection never reaches recording dispatch');
});

test('malformed optional detectedAt never opts into the legacy path', () => {
  for (const value of [null, true, 1, '', '2026-10-18T09:00:00Z', '2026-02-30T09:00:00.000Z',
    '2026-10-18T09:00:00.000+00:00']) {
    assert.throws(() => assertRecallMeetingDetectionTarget(windowId, value, recording()), /changed or closed/);
  }
  for (const id of ['bad/id', 'bad?id', 'bad#id', 'bad%id', ' invalid ', 'x'.repeat(513)]) {
    assert.throws(() => assertRecallMeetingDetectionTarget(id, detectedAt, recording()), /changed or closed/);
  }
});
