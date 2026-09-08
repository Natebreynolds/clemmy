import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChatStream, type StreamTransport } from './stream.js';
import type { HarnessEvent, ReplayPayload } from './types.js';
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('private raw pages reach the origin terminal even after a later own live event and foreign activity', async () => {
  const requests: Array<[number, number | undefined]> = [];
  const delivered: HarnessEvent[] = [];
  let callbacks: Parameters<StreamTransport['connect']>[0] | undefined;
  const transport: StreamTransport = {
    async connect(input) { callbacks = input; return { close() {} }; },
    async fetchRecent(_id, since, through): Promise<ReplayPayload> {
      requests.push([since, through]);
      return since < 90 ? { sessionId: 'origin', events: [], page: { version: 1, scannedThroughSeq: since + 10, snapshotSeq: 100, hasMore: true } }
        : { sessionId: 'origin', events: [{ sessionId: 'origin', seq: 100, type: 'conversation_completed', data: { reply: 'The actual delivered answer.' } }], page: { version: 1, scannedThroughSeq: 100, snapshotSeq: 100, hasMore: false } };
    },
  };
  const stream = runChatStream({ sessionId: 'origin', transport, onEvent: event => delivered.push(event) });
  await tick();
  callbacks!.onEvent({ seq: 500, sessionId: 'origin', type: 'tool_called', data: { callId: 'later' } });
  callbacks!.onEvent({ seq: 999, sessionId: 'workflow:child:step', type: 'heartbeat' });
  callbacks!.onReplay({ sessionId: 'origin', events: [], latestSeq: 500, page: { version: 1, scannedThroughSeq: 10, snapshotSeq: 100, hasMore: true } });
  for (let n = 0; n < 20 && !delivered.some(event => event.seq === 100); n++) await tick();
  assert.deepEqual(requests.map(([since]) => since), [10,20,30,40,50,60,70,80,90]);
  assert.ok(requests.every(([, through]) => through === 100));
  assert.equal(delivered.filter(event => event.seq === 100).length, 1);
  assert.equal(stream.cursor(), 500, 'foreign sequence never becomes origin progress');
  stream.stop();
});

test('replay overlap stays deduplicated after the raw scanned prefix is pruned', async () => {
  let callbacks: Parameters<StreamTransport['connect']>[0] | undefined;
  let count = 0;
  const stream = runChatStream({ sessionId: 'origin', onEvent: () => count++,
    transport: { async connect(input) { callbacks = input; return { close() {} }; }, async fetchRecent() { return { events: [] }; } } });
  await tick();
  const events = Array.from({ length: 4200 }, (_, i) => ({ seq: i + 1, sessionId: 'origin', type: 'heartbeat' }));
  callbacks!.onReplay({ sessionId: 'origin', events, page: { version: 1, scannedThroughSeq: 4200, snapshotSeq: 4200, hasMore: false } });
  callbacks!.onEvent({ seq: 4201, sessionId: 'origin', type: 'heartbeat' });
  callbacks!.onReplay({ sessionId: 'origin', events, page: { version: 1, scannedThroughSeq: 4200, snapshotSeq: 4200, hasMore: false } });
  assert.equal(count, 4201);
  stream.stop();
});

test('malformed or changed raw snapshots fail before presenting events or advancing the origin cursor', async () => {
  for (const page of [
    { version: 1 as const, scannedThroughSeq: 50, snapshotSeq: 100, hasMore: false },
    { version: 1 as const, scannedThroughSeq: 20, snapshotSeq: 101, hasMore: true },
  ]) {
    let callbacks: Parameters<StreamTransport['connect']>[0] | undefined;
    const delivered: HarnessEvent[] = [];
    let release: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const stream = runChatStream({ sessionId: 'origin', onEvent: event => delivered.push(event),
      transport: { async connect(input) { callbacks = input; return { close() {} }; },
        async fetchRecent() { await pending; throw new Error('offline'); } } });
    await tick();
    callbacks!.onReplay({ sessionId: 'origin', events: [], page: { version: 1, scannedThroughSeq: 10, snapshotSeq: 100, hasMore: true } });
    callbacks!.onReplay({ sessionId: 'origin', events: [{ seq: 20, sessionId: 'origin', type: 'conversation_completed' }], page });
    assert.deepEqual(delivered, []);
    assert.equal(stream.cursor(), 10);
    stream.stop(); release!(); await tick();
  }
});

test('approval settling drains the frozen private backlog beyond one poll batch before closing', async () => {
  let callbacks: Parameters<StreamTransport['connect']>[0] | undefined;
  const delivered: HarnessEvent[] = [];
  let terminals = 0;
  const stream = runChatStream({ sessionId: 'origin', approvalSettleMs: 1,
    onEvent: event => delivered.push(event), onTerminal: () => terminals++,
    transport: { async connect(input) { callbacks = input; return { close() {} }; },
      async fetchRecent(_id, since, through) {
        assert.equal(through, 120);
        await tick();
        return { sessionId: 'origin', events: since === 110 ? [{ sessionId: 'origin', seq: 120, type: 'conversation_completed', data: { reply: 'Complete answer' } }] : [],
          page: { version: 1, scannedThroughSeq: since + 10, snapshotSeq: 120, hasMore: since < 110 } };
      } } });
  await tick();
  callbacks!.onReplay({ sessionId: 'origin', events: [{ seq: 1, sessionId: 'origin', type: 'approval_requested' }],
    page: { version: 1, scannedThroughSeq: 10, snapshotSeq: 120, hasMore: true } });
  for (let n = 0; n < 50 && !delivered.some(event => event.seq === 120); n++) await tick();
  assert.equal(delivered.filter(event => event.seq === 120).length, 1);
  assert.equal(terminals, 1);
  stream.stop();
});
