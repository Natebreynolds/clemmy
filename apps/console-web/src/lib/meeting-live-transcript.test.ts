import assert from 'node:assert/strict';
import test from 'node:test';
import { matchingMeetingLiveLine } from './meeting-live-transcript.js';

const capture = { windowId: 'controlled-zoom-window', sdkUploadId: 'upload-current' };
const partial = { type: 'transcript-partial', ...capture, text: 'Could we check the proposal', speaker: 'Speaker', at: '2026-10-17T12:00:00Z' };
test('partial display requires exact capture identity, not a reused meeting window', () => {
  assert.equal(matchingMeetingLiveLine(capture, { ...partial, sdkUploadId: 'upload-old' }), undefined);
  assert.equal(matchingMeetingLiveLine(capture, { ...partial, sdkUploadId: undefined }), undefined);
  assert.equal(matchingMeetingLiveLine({ windowId: capture.windowId }, partial), undefined);
  assert.equal(matchingMeetingLiveLine(capture, { ...partial, windowId: 'foreign-window' }), undefined);
  assert.deepEqual(matchingMeetingLiveLine(capture, partial), { text: partial.text, speaker: 'Speaker', at: partial.at });
});
test('only a matching persisted-final acknowledgement clears a transient line', () => {
  assert.equal(matchingMeetingLiveLine(capture, { ...partial, type: 'transcript' }), null);
  assert.equal(matchingMeetingLiveLine(capture, { ...partial, type: 'transcript-store-failed' }), undefined);
  assert.equal(matchingMeetingLiveLine(capture, { ...partial, type: 'transcript', sdkUploadId: 'other' }), undefined);
});
test('unconfirmed time and blank content are not displayed; long speech is bounded without becoming evidence', () => {
  assert.equal(matchingMeetingLiveLine(capture, { ...partial, at: 'unknown' }), undefined);
  assert.equal(matchingMeetingLiveLine(capture, { ...partial, text: ' ' }), undefined);
  assert.equal(matchingMeetingLiveLine(capture, { ...partial, text: 'x'.repeat(9000) })?.text.length, 4000);
});
