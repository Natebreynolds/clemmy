import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessEvent } from '../../../lib/types';
import { advanceRunEventPage, appendRunEvents, recentEventsUrl, type StepBuffer } from './run-event-buffer';

const buffer = (): StepBuffer => ({ events: [], maxSeq: 0, scanSeq: 0 });
const event = (seq: number): HarnessEvent => ({ seq, type: 'user_input_received', turn: 1, role: 'user', data: { text: `message ${seq}` } });

test('an empty public page follows its raw cursor and finishes through trailing private rows', () => {
  const state = buffer();
  const first = advanceRunEventPage(state, { events: [], latestSeq: 900, page: { version: 1, scannedThroughSeq: 500, snapshotSeq: 900, hasMore: true } }, 500);
  assert.deepEqual(first, { more: true, complete: false });
  assert.equal(state.maxSeq, 0);
  assert.match(recentEventsUrl('session/one', state, 500), /session%2Fone.*sinceSeq=500&limit=500&throughSeq=900/);
  appendRunEvents(state, [event(700)]);
  assert.deepEqual(advanceRunEventPage(state, { events: [event(700)], latestSeq: 900, page: { version: 1, scannedThroughSeq: 900, snapshotSeq: 900, hasMore: false } }, 500), { more: false, complete: true });
  assert.equal(state.maxSeq, 700);
  assert.equal(state.scanSeq, 900);
  assert.equal(state.snapshotSeq, undefined);
});

test('a newer live event neither skips older replay nor lets replay replace retained activity', () => {
  const state = buffer();
  appendRunEvents(state, [event(800)]);
  assert.equal(state.scanSeq, 0);
  appendRunEvents(state, [event(100), event(200), event(800)]);
  assert.deepEqual(state.events.map(item => item.seq), [100, 200, 800]);
  assert.equal(state.maxSeq, 800);
  advanceRunEventPage(state, { events: [event(100), event(200)], latestSeq: 800, page: { version: 1, scannedThroughSeq: 500, snapshotSeq: 700, hasMore: true } }, 500);
  const second = advanceRunEventPage(state, { events: [], latestSeq: 800, page: { version: 1, scannedThroughSeq: 700, snapshotSeq: 700, hasMore: false } }, 500);
  assert.deepEqual(second, { more: true, complete: false });
  assert.match(recentEventsUrl('one', state, 500), /sinceSeq=700&limit=500$/);
  assert.deepEqual(state.events.map(item => item.seq), [100, 200, 800]);
});

test('legacy short pages remain partial; unrelated newer live events cannot supply their raw cursor', () => {
  const state = buffer();
  appendRunEvents(state, [event(999)]);
  const old = advanceRunEventPage(state, { events: [event(200)], latestSeq: 900 }, 500);
  assert.deepEqual(old, { more: false, complete: false });
  assert.equal(state.scanSeq, 200);
  assert.deepEqual(advanceRunEventPage(state, { events: [], latestSeq: 900 }, 500), { more: false, complete: false });
});

test('invalid or non-progressing page contracts do not advance the existing cursor', () => {
  const state = buffer();
  state.scanSeq = 10; state.snapshotSeq = 30;
  for (const page of [
    { version: 1 as const, scannedThroughSeq: 10, snapshotSeq: 30, hasMore: true },
    { version: 1 as const, scannedThroughSeq: 20, snapshotSeq: 31, hasMore: true },
    { version: 1 as const, scannedThroughSeq: 20, snapshotSeq: 30, hasMore: false },
  ]) assert.throws(() => advanceRunEventPage(state, { page }, 500), /invalid continuation/);
  assert.equal(state.scanSeq, 10);
});
