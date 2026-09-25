/**
 * Run: node scripts/run-tests-isolated.mjs packages/chat-engine/src/answer-stream.test.ts
 *
 * The client half of the answer stream: offset-0 frames replace the draft,
 * matching offsets extend it, anything else is ignored, a withdrawn draft
 * stays on screen (provisional) until the next draft or an authoritative event
 * replaces it, and a draft is never read as the reply.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessEvent, LiveAnswerDraft } from './types.js';
import { answerDraftStatus, applyStreamToken, withoutAnswerDraft } from './answer-stream.js';
import { ChatEngine } from './engine.js';
import type { StreamConnection, StreamTransport } from './stream.js';

const place = (streamId: string, offset: number, delta: string, sourceUserSeq = 2) =>
  ({ public: true, streamId, offset, delta, sourceUserSeq });
const reset = (streamId: string, reason?: string) => ({ public: true, streamId, reset: true, ...(reason ? { reason } : {}) });
const checking = (streamId: string) => ({ public: true, streamId, checking: true });

test('offset 0 replaces, a matching offset extends, and anything else is ignored', () => {
  let m = { text: 'Sure — checking your calendar.' } as { text: string; answerDraft?: LiveAnswerDraft };
  m = applyStreamToken(m, place('a', 0, 'You have three'));
  assert.deepEqual(m, { text: 'You have three', answerDraft: { id: 'a', base: 'Sure — checking your calendar.', phase: 'writing' } });
  m = applyStreamToken(m, place('a', 14, ' meetings'));
  assert.equal(m.text, 'You have three meetings');
  assert.equal(applyStreamToken(m, place('a', 14, ' meetings')), m, 'a duplicate offset is inert');
  assert.equal(applyStreamToken(m, place('a', 40, 'gap')), m, 'a gap is inert');
  assert.equal(applyStreamToken(m, place('b', 3, 'other draft')), m, 'another draft cannot extend this one');
  assert.equal(applyStreamToken(m, reset('b')), m, 'another draft cannot retract this one');
  const replaced = applyStreamToken(m, place('b', 0, 'You have four meetings'));
  assert.deepEqual(replaced.answerDraft, { id: 'b', base: 'Sure — checking your calendar.', phase: 'writing' }, 'the original base survives');
  assert.deepEqual(withoutAnswerDraft(m), { text: 'Sure — checking your calendar.', answerDraft: undefined });
});

test('a withdrawn draft stays on screen, provisional, until the next draft replaces it in place', () => {
  let m = { text: '' } as { text: string; answerDraft?: LiveAnswerDraft };
  m = applyStreamToken(m, place('a', 0, 'Deal owners: Ana, Ben'));
  m = applyStreamToken(m, checking('a'));
  assert.equal(m.answerDraft?.phase, 'checking');
  assert.equal(answerDraftStatus(m.answerDraft), 'Checking this answer…');
  m = applyStreamToken(m, reset('a', 'review'));
  assert.equal(m.text, 'Deal owners: Ana, Ben', 'the draft does not vanish');
  assert.deepEqual(m.answerDraft, { id: 'a', base: '', phase: 'withdrawn', withdrawn: 'review' });
  assert.equal(answerDraftStatus(m.answerDraft), 'Found issues, correcting…');
  assert.equal(applyStreamToken(m, place('a', 21, ' and Cy')), m, 'a withdrawn draft is never extended');
  m = applyStreamToken(m, place('b', 0, 'Deal owners: Ana, Dee'));
  assert.equal(m.text, 'Deal owners: Ana, Dee', 'the corrected draft replaces it in place');
  assert.deepEqual(m.answerDraft, { id: 'b', base: '', phase: 'writing' });
  assert.equal(answerDraftStatus(m.answerDraft), null);
  assert.deepEqual(withoutAnswerDraft(m), { text: '', answerDraft: undefined }, 'no draft is ever the delivered reply');
});

test('a withdrawal for any other reason reads neutrally', () => {
  const empty: { text: string; answerDraft?: LiveAnswerDraft } = { text: '' };
  for (const reason of ['tool_call', 'writer', 'continuation', undefined, 'made-up']) {
    const m = applyStreamToken(applyStreamToken(empty, place('a', 0, 'A long enough draft')), reset('a', reason));
    assert.equal(answerDraftStatus(m.answerDraft), 'Still working…', String(reason));
  }
  const attached = applyStreamToken(empty, { ...place('a', 0, 'Checked draft'), checking: true });
  assert.equal(attached.answerDraft?.phase, 'checking', 'a viewer attaching mid-review sees the review');
});

test('a frame without a draft identity keeps the old plain-append behavior', () => {
  const m = applyStreamToken({ text: 'Hi ' }, { delta: 'there' });
  assert.deepEqual(m, { text: 'Hi there' });
});

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
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const frame = (data: Record<string, unknown>): HarnessEvent => ({ seq: 0, type: 'stream_token', data });
const durable = (seq: number, type: string, data: Record<string, unknown> = {}): HarnessEvent => ({ seq, type, data });

async function liveEngine() {
  const transport = new FakeTransport();
  const engine = new ChatEngine({
    transport,
    api: {
      send: async () => ({ sessionId: 's-draft', accepted: true }),
      loadSession: async () => ({ events: [], latestSeq: 0 }),
    },
    streamTimings: { reconnectBaseDelayMs: 5 },
  });
  await engine.send('what is on thursday');
  await wait(10);
  transport.live!.onEvent(durable(2, 'user_input_received', { text: 'what is on thursday' }));
  const reply = () => engine.snapshot().messages.at(-1)!;
  return { engine, live: transport.live!, reply };
}

test('the engine shows a draft over the preamble, keeps a rejected one until the correction, and lets the terminal replace it', async () => {
  const { engine, live, reply } = await liveEngine();
  live.onEvent(durable(3, 'conversation_preamble', { text: 'Checking your calendar.' }));
  live.onEvent(frame(place('d1', 0, 'Thursday has three meetings')));
  assert.equal(reply().text, 'Thursday has three meetings');
  assert.equal(reply().answerDraft?.id, 'd1');
  live.onEvent(frame(reset('d1', 'review')));
  assert.equal(reply().text, 'Thursday has three meetings', 'a rejected draft stays on screen while it is corrected');
  assert.equal(answerDraftStatus(reply().answerDraft), 'Found issues, correcting…');
  live.onEvent(frame(place('d2', 0, 'Thursday has four meetings')));
  live.onEvent(frame(place('d2', 26, ', the first at 9.')));
  assert.equal(reply().text, 'Thursday has four meetings, the first at 9.');
  live.onEvent(frame(place('d9', 0, 'a draft for another request', 99)));
  assert.equal(reply().answerDraft?.id, 'd2', 'a draft for another accepted source is ignored');
  live.onEvent(durable(5, 'conversation_completed', { reason: 'completed', reply: 'Thursday has four meetings; the first is at 9:00.' }));
  assert.equal(reply().text, 'Thursday has four meetings; the first is at 9:00.');
  assert.equal(reply().answerDraft, undefined);
  assert.equal(reply().status, 'complete');
  engine.dispose();
});

test('a draft is never kept as the answer by a terminal, a failure, or a question', async () => {
  {
    const { engine, live, reply } = await liveEngine();
    live.onEvent(frame(place('d1', 0, 'An unreviewed draft')));
    live.onEvent(durable(5, 'conversation_completed', { reason: 'completed' }));
    assert.notEqual(reply().text, 'An unreviewed draft', 'an empty terminal does not promote the draft');
    engine.dispose();
  }
  {
    const { engine, live, reply } = await liveEngine();
    live.onEvent(frame(place('d1', 0, 'A withdrawn draft')));
    live.onEvent(frame(reset('d1', 'review')));
    live.onEvent(durable(5, 'conversation_completed', { reason: 'completed' }));
    assert.notEqual(reply().text, 'A withdrawn draft', 'a withdrawn draft kept on screen is never promoted either');
    assert.equal(reply().answerDraft, undefined);
    engine.dispose();
  }
  {
    const { engine, live, reply } = await liveEngine();
    live.onEvent(frame(place('d1', 0, 'An unreviewed draft')));
    live.onEvent(durable(5, 'run_failed', { error: 'The run failed.' }));
    assert.equal(reply().text, 'The run failed.');
    assert.equal(reply().answerDraft, undefined);
    engine.dispose();
  }
  {
    const { engine, live, reply } = await liveEngine();
    live.onEvent(frame(place('d1', 0, 'An unreviewed draft')));
    live.onEvent(durable(5, 'awaiting_user_input', { question: 'Which calendar?' }));
    assert.equal(reply().text, 'Which calendar?');
    assert.equal(reply().answerDraft, undefined);
    engine.dispose();
  }
});
