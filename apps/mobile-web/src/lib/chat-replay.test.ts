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

test('mobile reopen drains each retained physical history without advancing the live head cursor', async () => {
  const savedFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async input => {
    const url = String(input); requests.push(url);
    if (requests.length === 1) return Response.json({ session: { id: 'visible-root', executionSessionId: 'live-head' },
      events: [{ seq: 40, sessionId: 'live-head', type: 'user_input_received', data: { text: 'Continue.' } }], latestSeq: 40,
      page: { version: 1, scannedThroughSeq: 40, snapshotSeq: 40, hasMore: false },
      history: [{ sessionId: 'visible-root', events: [{ seq: 10, sessionId: 'visible-root', type: 'user_input_received', data: { text: 'Retain this draft.' } }], latestSeq: 80,
        page: { version: 1, scannedThroughSeq: 10, snapshotSeq: 80, hasMore: true } }] });
    assert.ok(url.includes('/visible-root/events/recent?'));
    assert.equal(new URL(url, 'https://phone.test').searchParams.get('throughSeq'), '80');
    return Response.json({ sessionId: 'visible-root', latestSeq: 100, events: [
      { seq: 80, sessionId: 'visible-root', type: 'conversation_completed', data: { sourceUserSeq: 10, reply: 'Stopped with draft retained.' } },
      { seq: 100, sessionId: 'foreign-head', type: 'conversation_completed', data: { reply: 'Foreign.' } },
    ], page: { version: 1, scannedThroughSeq: 80, snapshotSeq: 80, hasMore: false } });
  };
  try {
    const reopened = await getChatSession('visible-root');
    assert.equal(reopened.session.executionSessionId, 'live-head');
    assert.deepEqual(reopened.events.map(event => event.seq), [40]);
    assert.equal(reopened.latestSeq, 40, 'the old head can have later rows without advancing the current head');
    assert.deepEqual(reopened.history?.map(group => [group.sessionId, group.events.map(event => event.seq)]), [['visible-root', [10, 80]]]);
  } finally { globalThis.fetch = savedFetch; }
});

test('mobile reopen rejects duplicated heads and unbound historical events', async () => {
  const savedFetch = globalThis.fetch;
  try {
    for (const history of [
      [{ sessionId: 'live-head', events: [], latestSeq: 0, page: { version: 1, scannedThroughSeq: 0, snapshotSeq: 0, hasMore: false } }],
      [{ sessionId: 'visible-root', events: [{ seq: 1, sessionId: 'foreign-head' }], latestSeq: 1,
        page: { version: 1, scannedThroughSeq: 1, snapshotSeq: 1, hasMore: false } }],
    ]) {
      globalThis.fetch = async () => Response.json({ session: { id: 'visible-root', executionSessionId: 'live-head' }, events: [], latestSeq: 0, history });
      await assert.rejects(() => getChatSession('visible-root'), /lineage is invalid/);
    }
  } finally { globalThis.fetch = savedFetch; }
});
