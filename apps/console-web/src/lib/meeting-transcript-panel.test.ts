import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptMeetingTranscriptEvent, createMeetingTranscriptStream, emptyMeetingTranscriptStream,
  meetingTranscriptAtBottom, meetingTranscriptCaptureKey, meetingTranscriptEventMatches,
  reconcileMeetingTranscript, type MeetingTranscriptStreamState,
} from './meeting-transcript-panel';

const capture = { windowId: 'zoom-window', sdkUploadId: 'upload-a', recordingId: 'recording-a' };
const at = '2026-10-17T12:00:00.000Z';
const partial = (extra: Record<string, unknown> = {}) => ({ ...capture, type: 'transcript-partial', text: 'A question in progress', at, ...extra });
const final = (id = 'one', extra: Record<string, unknown> = {}) => ({ ...capture, type: 'transcript', segmentId: `segment-${id}`, eventId: `event-${id}`, text: 'What changed?', speaker: 'Sam', at, ...extra });

test('a reused window does not mix captures or contradictory recording identities', () => {
  for (const event of [partial({ sdkUploadId: 'old-upload' }), partial({ sdkUploadId: undefined }), partial({ recordingId: 'old-recording' }), partial({ windowId: 'another-window' })]) {
    assert.equal(meetingTranscriptEventMatches(capture, event), false);
  }
  assert.equal(meetingTranscriptEventMatches(capture, partial()), true);
  assert.equal(meetingTranscriptEventMatches({ windowId: capture.windowId, recordingId: 'recording-a' }, partial({ sdkUploadId: undefined })), true);
  assert.equal(meetingTranscriptEventMatches({ windowId: capture.windowId }, partial()), false);
  assert.notEqual(meetingTranscriptCaptureKey(capture), meetingTranscriptCaptureKey({ ...capture, sdkUploadId: 'new-upload' }));
});

test('interim words preserve full text and never request a transcript read', () => {
  const fullText = 'A long but known sentence. '.repeat(400);
  const next = acceptMeetingTranscriptEvent(emptyMeetingTranscriptStream(), capture, partial({ text: fullText }), 1_000);
  assert.equal(next.refresh, false);
  assert.equal(next.state.partial?.text, fullText);
  assert.equal(next.state.partial?.expiresAt, 21_000);
  assert.deepEqual(next.state.acknowledged, []);
});

test('an exact final bridges interim words until its own persisted identity appears', () => {
  const interim = acceptMeetingTranscriptEvent(emptyMeetingTranscriptStream(), capture, partial(), 0).state;
  const next = acceptMeetingTranscriptEvent(interim, capture, final(), 100);
  assert.equal(next.refresh, true);
  assert.equal(next.state.partial, undefined);
  assert.equal(next.state.acknowledged[0]?.text, 'What changed?');
  const unrelated = reconcileMeetingTranscript(next.state, [{ id: 'other', text: 'What changed?', isFinal: true }], 200);
  assert.equal(unrelated.acknowledged.length, 1, 'matching words do not prove readback');
  const interimRead = reconcileMeetingTranscript(next.state, [{ id: 'segment-one', text: 'What changed?', isFinal: false }], 200);
  assert.equal(interimRead.acknowledged.length, 1, 'a partial record is not final readback');
  const contradictory = reconcileMeetingTranscript(next.state, [{ id: 'different-segment', eventId: 'event-one', text: 'What changed?' }], 200);
  assert.equal(contradictory.acknowledged.length, 1, 'a contradictory retained identity does not confirm this line');
  assert.equal(reconcileMeetingTranscript(next.state, [{ id: 'segment-one', text: 'What changed?', isFinal: true }], 200).acknowledged.length, 0);
  assert.equal(reconcileMeetingTranscript(next.state, [{ eventId: 'event-one', text: 'What changed?' }], 200).acknowledged.length, 0);
});

test('final identity deduplication retains repeated utterances with different ids', () => {
  let state = acceptMeetingTranscriptEvent(emptyMeetingTranscriptStream(), capture, final('one'), 0).state;
  state = acceptMeetingTranscriptEvent(state, capture, final('two'), 1).state;
  assert.equal(state.acknowledged.length, 2);
  const duplicate = acceptMeetingTranscriptEvent(state, capture, final('one', { text: 'Changed transport payload' }), 2);
  assert.equal(duplicate.state, state);
  assert.equal(duplicate.refresh, false);
  const eventAlias = acceptMeetingTranscriptEvent(state, capture, final('one', { segmentId: undefined }), 2);
  assert.equal(eventAlias.refresh, false);
  assert.equal(eventAlias.state.acknowledged.length, 2);
});

test('unusable final previews trigger readback without claiming invented text', () => {
  const interim = acceptMeetingTranscriptEvent(emptyMeetingTranscriptStream(), capture, partial(), 0).state;
  const missingText = acceptMeetingTranscriptEvent(interim, capture, final('one', { text: undefined }), 10);
  assert.equal(missingText.refresh, true);
  assert.equal(missingText.state.partial, undefined);
  assert.equal(missingText.state.acknowledged.length, 0);
  assert.equal(missingText.state.unconfirmed[0]?.segmentId, 'segment-one');
  const noIdentity = acceptMeetingTranscriptEvent(emptyMeetingTranscriptStream(), capture, final('one', { eventId: undefined, segmentId: undefined }), 10);
  assert.equal(noIdentity.refresh, true);
  assert.equal(noIdentity.state.acknowledged.length, 0);
});

test('twenty-second expiry removes transient words; exact later readback clears uncertainty', () => {
  let state = acceptMeetingTranscriptEvent(emptyMeetingTranscriptStream(), capture, final(), 1_000).state;
  state = acceptMeetingTranscriptEvent(state, capture, partial(), 1_000).state;
  const expired = reconcileMeetingTranscript(state, [], 21_000);
  assert.equal(expired.partial, undefined);
  assert.deepEqual(expired.acknowledged, []);
  assert.deepEqual(expired.unconfirmed, [{ key: 'segment:segment-one', segmentId: 'segment-one', eventId: 'event-one' }]);
  assert.equal(JSON.stringify(expired).includes('What changed?'), false);
  assert.equal(reconcileMeetingTranscript(expired, [{ id: 'segment-one', text: 'What changed?' }], 22_000).unconfirmed.length, 0);
});

test('long meetings bound retained native previews and identity bookkeeping', () => {
  let state = emptyMeetingTranscriptStream();
  for (let n = 0; n < 300; n++) state = acceptMeetingTranscriptEvent(state, capture, final(String(n)), n).state;
  assert.equal(state.acknowledged.length, 24);
  assert.equal(state.acknowledged[0]?.segmentId, 'segment-276');
  assert.ok(state.unconfirmed.length <= 128);
  assert.ok(state.seenFinalKeys.length <= 128);
});

function fixture() {
  let now = 0;
  let nextId = 0;
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  let unsubscribed = 0;
  let refreshes = 0;
  const states: MeetingTranscriptStreamState[] = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  const allCallbacks: Array<() => void> = [];
  const controller = createMeetingTranscriptStream({
    capture,
    subscribe: cb => { listener = cb; return () => { unsubscribed++; }; },
    onState: state => states.push(state), onFinal: () => { refreshes++; }, now: () => now,
    schedule: (callback, delay) => {
      const id = ++nextId; timers.set(id, { at: now + delay, callback }); allCallbacks.push(callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: id => { timers.delete(id as unknown as number); },
  });
  const advance = (to: number) => {
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].callback();
    }
    now = to;
  };
  return { controller, states, timers, allCallbacks, emit: (event: Record<string, unknown>) => listener!(event), advance,
    refreshes: () => refreshes, unsubscribed: () => unsubscribed };
}

test('native final bursts coalesce without letting continuous speech postpone every refresh', () => {
  const f = fixture();
  for (let n = 0; n < 10; n++) f.emit(partial({ text: `interim ${n}` }));
  f.advance(100); assert.equal(f.refreshes(), 0);
  f.emit(final('one'));
  f.advance(200); f.emit(final('two'));
  f.advance(279); assert.equal(f.refreshes(), 0);
  f.advance(280); assert.equal(f.refreshes(), 1);
  f.emit(final('three'));
  f.advance(459); assert.equal(f.refreshes(), 1);
  f.advance(460); assert.equal(f.refreshes(), 2);
  f.controller.reconcile([{ id: 'segment-one', text: 'What changed?' }]);
  assert.equal(f.states.at(-1)?.acknowledged.length, 2);
  f.controller.dispose();
});

test('expiry is scheduled once and disposal blocks queued callbacks and late native delivery', () => {
  const f = fixture();
  f.emit(final()); f.emit(partial());
  f.advance(180);
  assert.equal(f.refreshes(), 1);
  f.advance(20_000);
  assert.equal(f.states.at(-1)?.partial, undefined);
  assert.equal(f.states.at(-1)?.acknowledged.length, 0);
  assert.equal(f.states.at(-1)?.unconfirmed.length, 1);
  f.emit(final('two'));
  const count = f.states.length;
  const refreshes = f.refreshes();
  f.controller.dispose();
  assert.equal(f.unsubscribed(), 1);
  assert.equal(f.timers.size, 0);
  f.emit(final('three'));
  for (const callback of f.allCallbacks) callback();
  assert.equal(f.states.length, count);
  assert.equal(f.refreshes(), refreshes);
});

test('follow-latest only applies near the bottom of the current viewport', () => {
  assert.equal(meetingTranscriptAtBottom({ scrollTop: 760, scrollHeight: 1000, clientHeight: 200 }), true);
  assert.equal(meetingTranscriptAtBottom({ scrollTop: 300, scrollHeight: 1000, clientHeight: 200 }), false);
  assert.equal(meetingTranscriptAtBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 200 }), true);
  assert.equal(meetingTranscriptAtBottom({ scrollTop: Number.NaN, scrollHeight: 1000, clientHeight: 200 }), false);
});
