import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recallFinalEventIdentity, recallFinalMetadata } from './recall-final-event.js';

test('SDK utterance identity is stable within one capture and distinct across captures', () => {
  const metadata = recallFinalMetadata({ participant: { id: 7 }, utterance_id: 'utterance-1' });
  assert.deepEqual(recallFinalEventIdentity('capture-a', metadata), recallFinalEventIdentity('capture-a', metadata));
  assert.notEqual(recallFinalEventIdentity('capture-a', metadata).eventId, recallFinalEventIdentity('capture-b', metadata).eventId);
  assert.equal(recallFinalEventIdentity('capture-a', metadata).eventIdentity, 'sdk');
});

test('word time spans and participants distinguish repeated legitimate utterances', () => {
  const segment = (start: number, participant = 7) => recallFinalMetadata({
    participant: { id: participant }, words: [{ text: 'Yes', start_timestamp: { relative: start }, end_timestamp: { relative: start + 1 } }],
  });
  const first = recallFinalEventIdentity('capture-a', segment(10));
  assert.deepEqual(first, recallFinalEventIdentity('capture-a', segment(10)));
  assert.notEqual(first.eventId, recallFinalEventIdentity('capture-a', segment(20)).eventId);
  assert.notEqual(first.eventId, recallFinalEventIdentity('capture-a', segment(10, 8)).eventId);
});

test('text alone and invalid time spans never grant SDK replay identity', () => {
  for (const data of [
    { text: 'Yes' },
    { participant: { id: 7 }, words: [{ text: 'Yes', start_timestamp: { relative: -1 }, end_timestamp: { relative: 0 } }] },
    { participant: { id: 7 }, words: [{ text: 'Yes', start_timestamp: { relative: 5 }, end_timestamp: { relative: 4 } }] },
  ]) {
    const metadata = recallFinalMetadata(data);
    const a = recallFinalEventIdentity('capture-a', metadata);
    const b = recallFinalEventIdentity('capture-a', metadata);
    assert.equal(a.eventIdentity, 'delivery');
    assert.notEqual(a.eventId, b.eventId);
  }
});
