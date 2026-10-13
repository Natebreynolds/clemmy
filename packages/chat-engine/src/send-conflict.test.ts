import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatEngine, STEER_NOT_DELIVERED_TEXT, type ChatApi } from './engine.js';
import type { HarnessEvent } from './types.js';
import type { StreamTransport } from './stream.js';

const sessionId = 'send-conflict-fixture';
const conflict = () => Object.assign(new Error('Choose the current card before continuing.'), { status: 409 });
const empty = async () => ({ events: [], latestSeq: 0 });
const quietTransport: StreamTransport = {
  connect: async () => ({ close() {} }),
  fetchRecent: async () => ({ events: [] }),
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a phone authority conflict sends once and clears sending and Stop without a retry timer', async () => {
  let sends = 0;
  const rejection = conflict();
  const engine = new ChatEngine({ sessionId, transport: quietTransport, api: {
    loadSession: empty, send: async () => { sends++; throw rejection; },
  } });
  try {
    await engine.send('Yes.');
    const snapshot = engine.snapshot();
    assert.equal(sends, 1);
    assert.equal(snapshot.busy, false);
    assert.equal(snapshot.cancelKey, null);
    assert.equal(snapshot.messages.length, 1, 'the unaccepted empty assistant is removed');
    assert.equal(snapshot.messages[0]?.text, 'Yes.');
    assert.equal(snapshot.messages[0]?.pending, 'failed');
    assert.equal(snapshot.messages[0]?.pendingError, rejection.message);
  } finally { engine.dispose(); }
});

test('an authority conflict reaches a connection callback immediately with the original identity', async () => {
  const sent: Parameters<ChatApi['send']>[0][] = [];
  const rejection = conflict();
  const continuation = { connectionRequestId: 'connection-fixture', clientRequestId: 'connection-key-fixture' };
  const engine = new ChatEngine({ sessionId, transport: quietTransport, api: {
    loadSession: empty, send: async input => { sent.push(input); throw rejection; },
  } });
  try {
    await assert.rejects(engine.send('Continue', undefined, { connectionResume: continuation }), error => error === rejection);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.connectionRequestId, continuation.connectionRequestId);
    assert.equal(sent[0]?.idempotencyKey, continuation.clientRequestId);
    assert.equal(engine.snapshot().busy, false);
    assert.equal(engine.snapshot().messages[0]?.pending, 'failed');
  } finally { engine.dispose(); }
});

test('network loss and a temporary server failure keep the existing exact-key retry delays', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: Parameters<ChatApi['send']>[0][] = [];
  const engine = new ChatEngine({ sessionId, transport: quietTransport, newIdempotencyKey: () => 'retry-fixture-key', api: {
    loadSession: empty, send: async input => {
      sent.push(structuredClone(input));
      if (sent.length === 1) throw new Error('Response lost');
      if (sent.length === 2) throw Object.assign(new Error('Temporarily unavailable'), { status: 503 });
      return { sessionId, accepted: true };
    },
  } });
  try {
    const sending = engine.send('Controlled request');
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(engine.snapshot().busy, true);
    t.mock.timers.tick(499); await flush();
    assert.equal(sent.length, 1);
    t.mock.timers.tick(1); await flush();
    assert.equal(sent.length, 2);
    t.mock.timers.tick(1499); await flush();
    assert.equal(sent.length, 2);
    t.mock.timers.tick(1); await sending;
    assert.equal(sent.length, 3);
    assert.deepEqual(sent, sent.map(() => sent[0]));
    assert.equal(engine.snapshot().messages[0]?.pending, undefined);
    assert.equal(engine.snapshot().busy, true, 'accepted work remains live until its terminal');
  } finally { engine.dispose(); }
});

function observedEngine(send: ChatApi['send']) {
  let live: Parameters<StreamTransport['connect']>[0] | undefined;
  const transport: StreamTransport = {
    connect: async options => { live = options; return { close() {} }; },
    fetchRecent: async () => ({ events: [] }),
  };
  const event = (seq: number, type: string, data: Record<string, unknown>): HarnessEvent =>
    ({ sessionId, seq, type, data, role: type === 'user_input_received' ? 'user' : 'Clem', turn: 2 });
  const engine = new ChatEngine({ sessionId, transport, observeWhileIdle: true, api: {
    send, loadSession: async () => ({ events: [
      event(1, 'user_input_received', { text: 'Earlier fixture' }),
      event(2, 'conversation_completed', { sourceUserSeq: 1, reply: 'Earlier result' }),
    ], latestSeq: 2 }),
  } });
  return { engine, emit: (seq: number, type: string, data: Record<string, unknown>) => live!.onEvent(event(seq, type, data)) };
}

test('an accepted source and terminal win over a delayed conflict without failing the accepted user', async () => {
  for (const connectionResume of [undefined, { connectionRequestId: 'accepted-connection', clientRequestId: 'accepted-key' }]) {
    const post = deferred<Awaited<ReturnType<ChatApi['send']>>>();
    const { engine, emit } = observedEngine(() => post.promise);
    try {
      await engine.open();
      const sending = engine.send('Yes.', undefined, connectionResume ? { connectionResume } : {});
      emit(3, 'user_input_received', { text: 'Yes.' });
      emit(4, 'conversation_completed', { sourceUserSeq: 3, reply: 'Which exact card?', terminalStatus: 'needs_input' });
      const settled = engine.snapshot();
      post.reject(conflict());
      await sending;
      assert.deepEqual(engine.snapshot().messages, settled.messages);
      assert.equal(engine.snapshot().busy, false);
      assert.equal(engine.snapshot().messages.find(message => message.role === 'user' && message.text === 'Yes.')?.pending, undefined);
    } finally { engine.dispose(); }
  }
});

test('a delayed refused request cannot clear a different accepted source that is still working', async () => {
  const post = deferred<Awaited<ReturnType<ChatApi['send']>>>();
  const { engine, emit } = observedEngine(() => post.promise);
  try {
    await engine.open();
    const sending = engine.send('Old refused reply');
    emit(3, 'user_input_received', { text: 'Another device request' });
    emit(0, 'stream_token', { sourceUserSeq: 3, delta: 'Accepted candidate draft' });
    const candidate = engine.snapshot().messages.find(message => message.role === 'assistant' && message.acceptedSource?.sourceUserSeq === 3);
    assert.ok(candidate);
    post.reject(conflict());
    await sending;
    assert.equal(engine.snapshot().busy, true);
    assert.equal(engine.snapshot().activeSourceUserSeq, 3);
    assert.deepEqual(engine.snapshot().messages.find(message => message.id === candidate.id), candidate);
    assert.equal(engine.snapshot().messages.find(message => message.text === 'Old refused reply')?.pending, 'failed');
  } finally { engine.dispose(); }
});

test('a refused mid-turn message shows the route’s plain line on its failed row, an offline one the transport’s, and never a connection guess', async () => {
  const line = 'This turn is finishing; the message was not queued.';
  const offline = "Can't reach your computer right now";
  const failures: unknown[] = [
    Object.assign(new Error(line), { status: 409, body: { error: line, code: 'STEER_NOTE_CUTOVER', sessionId } }),
    Object.assign(new Error(offline), { status: 0, offline: true }),
    'a failure with no words',
  ];
  let steers = 0;
  const engine = new ChatEngine({ sessionId, transport: quietTransport, api: {
    loadSession: empty, send: async input => {
      if (!input.steerOnly) return { sessionId, accepted: true };
      throw failures[steers++];
    },
  } });
  try {
    await engine.send('Start the controlled work.');
    assert.equal(engine.snapshot().busy, true, 'the accepted turn is live');
    await engine.send('Add this detail.');
    await engine.send('And this one.');
    await engine.send('And a third.');
    assert.equal(steers, 3);
    const rows = engine.snapshot().messages.filter(message => message.steer);
    assert.deepEqual(rows.map(message => [message.pending, message.steer, message.pendingError]), [
      ['failed', 'failed', line],
      ['failed', 'failed', offline],
      ['failed', 'failed', STEER_NOT_DELIVERED_TEXT],
    ]);
    assert.doesNotMatch(rows[0]!.pendingError!, /STEER_NOTE/, 'the owner reads the line, never the code');
    assert.doesNotMatch(STEER_NOT_DELIVERED_TEXT, /reach|\b(?:I|I’m|I'm|me|my)\b/, 'a wordless failure claims nothing about the connection');
    assert.equal(engine.snapshot().busy, true, 'a refused mid-turn message never clears the live turn');
  } finally { engine.dispose(); }
});
