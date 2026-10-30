/**
 * Run: node scripts/run-tests-isolated.mjs packages/chat-engine/src/key-request.test.ts
 *
 * A question that needs a key arrives with the server and key names; the
 * engine keeps them on the question for the card, a malformed request draws no
 * fields, and the reply after saving names keys, never a value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessEvent } from './types.js';
import { ChatEngine } from './engine.js';
import { keyRequestSavedReply, readKeyRequest } from './key-request.js';
import type { StreamConnection, StreamTransport } from './stream.js';

class FakeTransport implements StreamTransport {
  live: { onEvent(e: HarnessEvent): void } | null = null;
  async connect(opts: {
    sessionId: string; sinceSeq: number;
    onReplay(p: { sessionId?: string; events: HarnessEvent[] }): void; onEvent(e: HarnessEvent): void; onError(): void;
  }): Promise<StreamConnection> {
    this.live = { onEvent: opts.onEvent };
    queueMicrotask(() => opts.onReplay({ sessionId: opts.sessionId, events: [] }));
    return { close: () => { this.live = null; } };
  }
  async fetchRecent() { return { events: [] }; }
}
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('the question carries the server and key names for the card', async () => {
  const transport = new FakeTransport();
  const engine = new ChatEngine({
    transport,
    api: { send: async () => ({ sessionId: 's-key', accepted: true }), loadSession: async () => ({ events: [], latestSeq: 0 }) },
    streamTimings: { reconnectBaseDelayMs: 5 },
  });
  await engine.send('set up the TEST FIXTURE weather server');
  await wait(10);
  transport.live!.onEvent({ seq: 2, type: 'user_input_received', data: { text: 'set up the TEST FIXTURE weather server' } });
  transport.live!.onEvent({ seq: 3, type: 'awaiting_user_input', data: {
    question: 'What is the TEST FIXTURE weather key?', keyRequest: { server: 'weather-fixture', keys: ['TEST_FIXTURE_WEATHER_KEY'] } } });
  const reply = engine.snapshot().messages.at(-1)!;
  assert.equal(reply.status, 'awaiting-reply');
  assert.deepEqual(reply.keyRequest, { server: 'weather-fixture', keys: ['TEST_FIXTURE_WEATHER_KEY'] });
  engine.dispose();
});

test('a malformed request draws no fields, and the saved reply never carries a value', () => {
  assert.equal(readKeyRequest({ server: 'weather-fixture', keys: [] }), null);
  assert.equal(readKeyRequest({ server: 'weather-fixture', keys: ['not a key'] }), null);
  assert.equal(readKeyRequest({ server: '', keys: ['A_KEY'] }), null);
  const request = readKeyRequest({ server: 'weather-fixture', keys: ['TEST_FIXTURE_WEATHER_KEY'], value: 'sk-never' })!;
  assert.deepEqual(request, { server: 'weather-fixture', keys: ['TEST_FIXTURE_WEATHER_KEY'] });
  assert.equal(keyRequestSavedReply(request), 'I saved the weather-fixture key (TEST_FIXTURE_WEATHER_KEY).');
  assert.equal(keyRequestSavedReply({ server: 'mail-fixture', keys: ['A_KEY', 'B_KEY'] }), 'I saved the mail-fixture keys (A_KEY, B_KEY).');
});
