import assert from 'node:assert/strict';
import test from 'node:test';
import { getChatSession } from './api.js';

const initial = { session: { id: 'origin' }, events: [], latestSeq: 999,
  page: { version: 1, scannedThroughSeq: 10, snapshotSeq: 30, hasMore: true } };

test('mobile reopen drains private origin pages to its frozen frontier and excludes incidental child activity', async () => {
  const savedFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async input => {
    const url = String(input); requests.push(url);
    if (requests.length === 1) return Response.json(initial);
    assert.equal(new URL(url, 'https://phone.test').searchParams.get('throughSeq'), '30');
    const since = new URL(url, 'https://phone.test').searchParams.get('sinceSeq');
    return Response.json({ sessionId: 'origin', latestSeq: 999,
      events: since === '10' ? [] : [
        { seq: 30, sessionId: 'origin', type: 'conversation_completed', data: { reply: 'The complete original reply.' } },
        { seq: 999, sessionId: 'workflow:child:step', type: 'heartbeat' },
      ], page: { version: 1, scannedThroughSeq: since === '10' ? 20 : 30, snapshotSeq: 30, hasMore: since === '10' } });
  };
  try {
    const reopened = await getChatSession('origin');
    assert.equal(requests.length, 3);
    assert.equal(reopened.latestSeq, 30);
    assert.deepEqual(reopened.events.map(event => event.seq), [30]);
    assert.equal(reopened.events[0].data.reply, 'The complete original reply.');
  } finally { globalThis.fetch = savedFetch; }
});

test('mobile reopen rejects changed, unproven, and wrong-session continuation instead of skipping history', async () => {
  const savedFetch = globalThis.fetch;
  try {
    for (const next of [
      { sessionId: 'origin', page: { version: 1, scannedThroughSeq: 20, snapshotSeq: 31, hasMore: true } },
      { sessionId: 'origin', page: { version: 1, scannedThroughSeq: 20, snapshotSeq: 30, hasMore: false } },
      { sessionId: 'other', page: { version: 1, scannedThroughSeq: 30, snapshotSeq: 30, hasMore: false } },
      { sessionId: 'origin' },
    ]) {
      let count = 0;
      globalThis.fetch = async () => Response.json(++count === 1 ? initial : { ...next, events: [{ seq: 30, type: 'conversation_completed' }] });
      await assert.rejects(() => getChatSession('origin'), /did not advance within its origin snapshot/);
      assert.equal(count, 2);
    }
  } finally { globalThis.fetch = savedFetch; }
});
