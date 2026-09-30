import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChatEngine, type ChatApi } from './engine.js';
import { createPendingMessageStore } from './pending-request.js';
import type { StreamTransport } from './stream.js';
import type { TaskMode } from './task-mode.js';

const continuation = { connectionRequestId: 'connection-request-42', clientRequestId: 'host-issued-stable-key-42' };
const sessionId = 'original-conversation';
const text = 'Continue with work mail';
type SendInput = Parameters<ChatApi['send']>[0];
const exact: SendInput = { message: text, sessionId, idempotencyKey: continuation.clientRequestId, connectionRequestId: continuation.connectionRequestId };

const quietTransport = (): StreamTransport => ({
  connect: async () => ({ close() {} }),
  fetchRecent: async () => ({ events: [] }),
});
const loadEmpty = async () => ({ events: [], latestSeq: 0 });
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
async function finishRetryWindow(t: TestContext) {
  await flush();
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(10_000); await flush(); }
}
function outbox() {
  const values = new Map<string, string>();
  const store = createPendingMessageStore({
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  }, 'connection-outbox');
  return { values, store };
}

test('a lost acceptance response retries the exact host continuation identity without another claim', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: SendInput[] = [];
  const accepted = new Set<string>();
  const saved = outbox();
  const engine = new ChatEngine({
    transport: quietTransport(), sessionId, pendingStore: saved.store,
    newIdempotencyKey: () => { throw new Error('Continuation must use the host key'); },
    api: { loadSession: loadEmpty, send: async input => {
      sent.push(structuredClone(input));
      if (!accepted.has(input.idempotencyKey)) {
        accepted.add(input.idempotencyKey);
        throw new Error('The server accepted the request, but its response was lost');
      }
      return { sessionId, accepted: false };
    } },
  });
  try {
    const sending = engine.send(text, undefined, { connectionResume: continuation });
    await flush();
    assert.equal(saved.store.load()[0]?.connectionRequestId, continuation.connectionRequestId);
    assert.equal(saved.store.load()[0]?.idempotencyKey, continuation.clientRequestId);
    t.mock.timers.tick(500);
    await sending;
    assert.deepEqual(sent, [exact, exact]);
    assert.equal(accepted.size, 1);
    assert.equal(engine.snapshot().messages.filter(message => message.role === 'user').length, 1);
    assert.equal(engine.snapshot().messages[0]?.pending, undefined);
    assert.equal(saved.values.size, 0, 'observed acceptance clears only the pending outbox');
  } finally { engine.dispose(); }
});

test('explicit Retry after exhausted delivery retains label, request id, session and stable key', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: SendInput[] = [];
  let unavailable = true;
  const engine = new ChatEngine({
    transport: quietTransport(), sessionId,
    newIdempotencyKey: () => { throw new Error('Retry must not mint a key'); },
    api: { loadSession: loadEmpty, send: async input => {
      sent.push(structuredClone(input));
      if (unavailable) throw new Error('Delivery unavailable');
      return { sessionId, accepted: true };
    } },
  });
  try {
    const mutableContext = { ...continuation };
    const sending = engine.send(text, { version: 1, kind: 'plan' }, { connectionResume: mutableContext });
    const rejection = assert.rejects(sending, /Delivery unavailable/);
    mutableContext.clientRequestId = 'changed-after-click';
    mutableContext.connectionRequestId = 'different-request';
    await finishRetryWindow(t);
    await rejection;
    const failed = engine.snapshot().messages.find(message => message.pending === 'failed');
    assert.ok(failed);
    assert.equal(engine.snapshot().busy, false);
    assert.equal(failed.taskMode, undefined);
    assert.equal(failed.connectionRequestId, continuation.connectionRequestId);
    assert.ok(sent.length > 1, 'automatic delivery recovery was exercised');
    unavailable = false;
    await engine.retry(failed.id);
    assert.deepEqual(sent, sent.map(() => exact));
    assert.equal(engine.snapshot().messages.find(message => message.id === failed.id)?.pending, undefined);
    assert.equal(engine.snapshot().messages.filter(message => message.role === 'user').length, 1);
  } finally { engine.dispose(); }
});

test('an unconfirmed continuation survives page reopen with its original target and identity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = outbox();
  const first = new ChatEngine({
    transport: quietTransport(), sessionId, pendingStore: saved.store,
    api: { loadSession: loadEmpty, send: async () => { throw new Error('Connection lost'); } },
  });
  try {
    const rejected = assert.rejects(first.send(text, undefined, { connectionResume: continuation }), /Connection lost/);
    await finishRetryWindow(t);
    await rejected;
  } finally { first.dispose(); }
  const sent: SendInput[] = [];
  const reopened = new ChatEngine({
    transport: quietTransport(), sessionId: 'another-open-view', pendingStore: saved.store,
    api: { loadSession: loadEmpty, send: async input => { sent.push(input); return { sessionId, accepted: true }; } },
  });
  try {
    await reopened.open();
    const failed = reopened.snapshot().messages.find(message => message.pending === 'failed');
    assert.ok(failed);
    await reopened.retry(failed.id);
    assert.deepEqual(sent, [exact]);
    assert.equal(saved.values.size, 0);
  } finally { reopened.dispose(); }
});

test('a connection continuation arriving during another run rejects without becoming a steer', async () => {
  const sent: SendInput[] = [];
  const engine = new ChatEngine({ transport: quietTransport(), sessionId, api: {
    loadSession: loadEmpty,
    send: async input => { sent.push(input); return { sessionId, accepted: true }; },
  } });
  try {
    await engine.send('Keep working on the current task');
    const before = engine.snapshot();
    await assert.rejects(engine.send(text, undefined, { connectionResume: continuation }), /Another turn is running/);
    assert.equal(sent.length, 1);
    assert.deepEqual(engine.snapshot().messages, before.messages);
    assert.equal(engine.snapshot().busy, true);
    assert.equal(engine.snapshot().messages.some(message => message.steer), false);
  } finally { engine.dispose(); }
});

test('explicit Retry of a connection cannot cross into a different active turn', async () => {
  const sent: SendInput[] = [];
  const saved = outbox();
  saved.store.save([{
    id: 'failed-connection', role: 'user', text, pending: 'failed', requestSessionId: sessionId,
    idempotencyKey: continuation.clientRequestId, connectionRequestId: continuation.connectionRequestId,
  }]);
  const engine = new ChatEngine({ transport: quietTransport(), sessionId, pendingStore: saved.store, api: {
    loadSession: async () => ({ events: [{ seq: 100, type: 'user_input_received', data: { text: 'Another live task' } }], latestSeq: 100 }),
    send: async input => { sent.push(input); return { sessionId, accepted: true }; },
  } });
  try {
    await engine.open();
    assert.equal(engine.snapshot().busy, true);
    await engine.retry('failed-connection');
    assert.deepEqual(sent, []);
    assert.equal(engine.snapshot().messages.find(message => message.id === 'failed-connection')?.pending, 'failed');
    assert.equal(engine.snapshot().messages.some(message => message.steer), false);
  } finally { engine.dispose(); }
});

test('composer Normal, Plan and Execute selections cannot redefine a connection continuation', async () => {
  const modes: TaskMode[] = [
    { version: 1, kind: 'normal' }, { version: 1, kind: 'plan' },
    { version: 1, kind: 'execute', executeRef: { planId: 'unrelated-plan', revision: 7, digest: 'a'.repeat(64) } },
  ];
  for (const mode of modes) {
    const sent: SendInput[] = [];
    const engine = new ChatEngine({ transport: quietTransport(), sessionId, api: {
      loadSession: loadEmpty, send: async input => { sent.push(input); return { sessionId, accepted: true }; },
    } });
    try {
      await engine.send(text, mode, { connectionResume: continuation });
      assert.deepEqual(sent, [exact]);
      assert.equal(engine.snapshot().activeTaskMode, undefined);
      assert.equal(engine.snapshot().messages.some(message => message.taskMode !== undefined), false);
    } finally { engine.dispose(); }
  }
});

test('stale-request rejection reaches the setup callback and keeps the failed echo retryable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejection = Object.assign(new Error('This connection request no longer belongs to the current task'), { status: 409 });
  const engine = new ChatEngine({ transport: quietTransport(), sessionId, api: {
    loadSession: loadEmpty, send: async () => { throw rejection; },
  } });
  try {
    const failedSend = assert.rejects(engine.send(text, undefined, { connectionResume: continuation }), error => error === rejection);
    await finishRetryWindow(t);
    await failedSend;
    assert.equal(engine.snapshot().busy, false);
    const failed = engine.snapshot().messages.find(message => message.pending === 'failed');
    assert.ok(failed);
    assert.equal(failed.pendingError, rejection.message);
    assert.equal(failed.connectionRequestId, continuation.connectionRequestId);
    const failedRetry = assert.rejects(engine.retry(failed.id), error => error === rejection);
    await finishRetryWindow(t);
    await failedRetry;
    assert.equal(engine.snapshot().messages.find(message => message.id === failed.id)?.pending, 'failed');
  } finally { engine.dispose(); }
});

test('ordinary exhausted sends keep their existing resolved Promise and failed-bubble contract', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const engine = new ChatEngine({ transport: quietTransport(), sessionId, api: {
    loadSession: loadEmpty, send: async () => { throw new Error('Ordinary delivery failed'); },
  } });
  try {
    const sending = engine.send('Ordinary request');
    await finishRetryWindow(t);
    await assert.doesNotReject(sending);
    assert.equal(engine.snapshot().messages[0]?.pending, 'failed');
    assert.equal(engine.snapshot().busy, false);
  } finally { engine.dispose(); }
});
