import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatEngine, foldTranscript, type ChatApi } from './engine.js';
import { createPendingMessageStore } from './pending-request.js';
import type { StreamTransport } from './stream.js';

const transport: StreamTransport = {
  connect: async () => ({ close() {} }),
  fetchRecent: async () => ({ events: [] }),
};
const noTranscript = async () => ({ events: [], latestSeq: 0 });

test('normal sends carry true-only voice intent without replacing the request identity', async () => {
  const requests: Parameters<ChatApi['send']>[0][] = [];
  const engine = new ChatEngine({ transport, newIdempotencyKey: () => 'voice-key', api: {
    send: async input => { requests.push(input); return { sessionId: 'voice-session', accepted: true }; },
    loadSession: noTranscript,
  } });
  try {
    await engine.send('Tell me the result', undefined, { voice: true });
    assert.equal(requests[0].voice, true);
    assert.equal(requests[0].idempotencyKey, 'voice-key');
    assert.equal(engine.snapshot().messages.find(message => message.role === 'user')?.voice, true);
  } finally { engine.dispose(); }
});

test('an uncertain spoken request survives serialized storage and retry with its original bytes', async () => {
  const values = new Map<string, string>();
  const store = createPendingMessageStore({ getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }, 'voice-pending');
  store.save([{ id: 'voice-local', role: 'user', text: 'Spoken request', voice: true,
    pending: 'sending', idempotencyKey: 'original-key', requestSessionId: null }]);
  const requests: Parameters<ChatApi['send']>[0][] = [];
  const engine = new ChatEngine({ transport, pendingStore: store, sessionId: 'different-open-chat', api: {
    send: async input => { requests.push(input); return { sessionId: 'original-accepted-chat', accepted: true }; },
    loadSession: noTranscript,
  } });
  try {
    await engine.retry('voice-local');
    assert.deepEqual(requests, [{ message: 'Spoken request', voice: true, sessionId: null, idempotencyKey: 'original-key' }]);
    assert.equal(values.has('voice-pending'), false);
  } finally { engine.dispose(); }
});

test('spoken steering and its retry retain voice intent without admitting another turn', async () => {
  const requests: Parameters<ChatApi['send']>[0][] = [];
  let refuseSteer = true;
  const engine = new ChatEngine({ transport, api: {
    send: async input => {
      requests.push(input);
      if (input.steerOnly && refuseSteer) throw new Error('Connection interrupted');
      return { sessionId: 'busy-chat', accepted: !input.steerOnly, ...(input.steerOnly ? { steered: true } : {}) };
    }, loadSession: noTranscript,
  } });
  try {
    await engine.send('Start work');
    assert.equal(requests[0].voice, undefined);
    await engine.send('One more detail', undefined, { voice: true });
    const failed = engine.snapshot().messages.find(message => message.steer === 'failed')!;
    assert.equal(failed.voice, true);
    refuseSteer = false;
    await engine.retry(failed.id);
    assert.equal(requests[1].voice, true);
    assert.equal(requests[2].voice, true);
    assert.equal(requests[2].steerOnly, true);
    assert.equal(requests[2].idempotencyKey, requests[1].idempotencyKey);
    assert.equal(engine.snapshot().busy, true);
    assert.equal(engine.snapshot().messages.filter(message => message.role === 'assistant').length, 1);
  } finally { engine.dispose(); }
});

test('replayed accepted input recovers only an explicit true spoken marker', () => {
  const messages = foldTranscript([
    { seq: 1, role: 'user', type: 'user_input_received', data: { text: 'Spoken', voice: true } },
    { seq: 2, role: 'user', type: 'user_input_received', data: { text: 'Typed', voice: 'true' } },
  ]);
  assert.equal(messages.find(message => message.text === 'Spoken')?.voice, true);
  assert.equal(messages.find(message => message.text === 'Typed')?.voice, undefined);
});
