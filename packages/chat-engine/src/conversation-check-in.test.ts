import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatEngine, foldTranscript, inFlightTurnSince } from './engine.js';
import { isTerminalEvent, type HarnessEvent, type ReplayPayload } from './types.js';
import type { StreamConnection, StreamTransport } from './stream.js';

const sessionId = 'check-in-fixture';
const source = (seq = 1, text = 'Inspect the fixture', turn = 0): HarnessEvent => ({
  seq, type: 'user_input_received', sessionId, turn, role: 'user', data: { text },
});
const note = (seq = 2, sourceUserSeq = 1, text = 'The first source is verified.', turn = 0): HarnessEvent => ({
  seq, type: 'conversation_check_in', sessionId, turn, role: 'Clem',
  data: { version: 1, kind: 'check_in', sourceUserSeq, text },
});
const done = (seq = 3, sourceUserSeq = 1, turn = 0): HarnessEvent => ({
  seq, type: 'conversation_completed', sessionId, turn,
  data: { sourceUserSeq, reply: `Answer ${sourceUserSeq}` },
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

class Transport implements StreamTransport {
  live: Parameters<StreamTransport['connect']>[0] | null = null;
  recent: ReplayPayload = { events: [] };
  async connect(options: Parameters<StreamTransport['connect']>[0]): Promise<StreamConnection> {
    this.live = options;
    return { close: () => { if (this.live === options) this.live = null; } };
  }
  async fetchRecent(): Promise<ReplayPayload> { return this.recent; }
}

function createEngine(events: HarnessEvent[] = []) {
  const transport = new Transport();
  let key = 0;
  const engine = new ChatEngine({ sessionId, transport, newIdempotencyKey: () => `key-${++key}`,
    api: {
      send: async () => ({ sessionId, accepted: true }),
      loadSession: async () => ({ events, latestSeq: events.at(-1)?.seq ?? 0 }),
    },
  });
  return { engine, transport };
}

test('live and replay show canonical check-ins once without settling or replacing the answer', async () => {
  const { engine, transport } = createEngine();
  try {
    await engine.send('Inspect the fixture');
    await tick();
    transport.live!.onEvent(source());
    transport.live!.onEvent({ seq: 2, sessionId, type: 'conversation_preamble', data: { text: 'I will inspect it.' } });
    const progress = note(3);
    transport.live!.onEvent(progress);
    const live = engine.snapshot();
    assert.equal(live.busy, true);
    assert.equal(live.cancelKey, 'key-1');
    assert.equal(live.messages.at(-1)?.text, 'I will inspect it.');
    assert.equal(live.messages.at(-1)?.status, 'thinking');
    assert.equal(live.messages[1]?.checkIn, true);
    assert.equal(live.messages[1]?.status, undefined);
    assert.equal(live.messages[1]?.terminal, undefined);
    assert.equal(live.messages[1]?.activity, undefined);
    assert.equal(isTerminalEvent(progress.type), false);
    transport.live!.onEvent(done(4));
    assert.equal(engine.snapshot().busy, false);
    const replayed = foldTranscript([source(), progress, done(4)]);
    assert.deepEqual(engine.snapshot().messages.map(m => [m.text, m.checkIn, m.status]),
      replayed.map(m => [m.text, m.checkIn, m.status]));
  } finally { engine.dispose(); }
});

test('delayed A check-in stays with A while B retains its draft, cancel key and live state', async () => {
  const old = [source(), done()];
  const { engine, transport } = createEngine(old);
  try {
    await engine.open();
    await engine.send('Inspect another fixture');
    await tick();
    transport.live!.onEvent(source(10, 'Inspect another fixture', 1));
    transport.live!.onEvent({ seq: 11, sessionId, type: 'conversation_preamble', data: { text: 'Working on B.' } });
    transport.live!.onEvent(note(12));
    const snapshot = engine.snapshot();
    assert.deepEqual(snapshot.messages.map(m => m.text), [
      'Inspect the fixture', 'The first source is verified.', 'Answer 1', 'Inspect another fixture', 'Working on B.',
    ]);
    assert.equal(snapshot.busy, true);
    assert.equal(snapshot.cancelKey, 'key-1');
    assert.equal(snapshot.messages.at(-1)?.status, 'thinking');
    assert.equal(snapshot.messages.at(-1)?.acceptedSource?.sourceUserSeq, 10);
    assert.deepEqual(foldTranscript([...old, source(10, 'Inspect another fixture', 1), note(12)])
      .map(m => m.text), snapshot.messages.slice(0, -1).map(m => m.text));
  } finally { engine.dispose(); }
});

test('reopen and overlapping reconnect replay retain one copy and remain in flight', async () => {
  const events = [source(), note()];
  const { engine, transport } = createEngine(events);
  try {
    await engine.open();
    await tick();
    assert.equal(engine.snapshot().busy, true);
    assert.equal(inFlightTurnSince(events), 0);
    transport.live!.onReplay({ sessionId, events: [...events, note(3, 1, 'Second source verified.')] });
    transport.live!.onEvent(note(3, 1, 'Second source verified.'));
    assert.deepEqual(engine.snapshot().messages.filter(m => m.checkIn).map(m => m.checkInSeq), [2, 3]);
    transport.recent = { sessionId, events: [note(2), note(3, 1, 'Second source verified.'), note(4, 1, 'Checking the artifact.')] };
    transport.live!.onError();
    engine.resume();
    await tick();
    await tick();
    assert.deepEqual(engine.snapshot().messages.filter(m => m.checkIn).map(m => m.checkInSeq), [2, 3, 4]);
    assert.equal(engine.snapshot().busy, true);
    assert.equal(engine.snapshot().messages.at(-1)?.status, 'thinking');
  } finally { engine.dispose(); }
});

test('distinct same-text notes survive while duplicate event delivery is inert on replay', () => {
  const messages = foldTranscript([source(), note(), note(), note(3), done(4)]);
  assert.deepEqual(messages.filter(m => m.checkIn).map(m => m.checkInSeq), [2, 3]);
  assert.equal(messages.at(-1)?.status, 'complete');
});

test('same-text accepted requests retain separate task placement live and on replay', async () => {
  const old = [source(), done()];
  const { engine, transport } = createEngine(old);
  try {
    await engine.open();
    await engine.send('Inspect the fixture');
    await tick();
    transport.live!.onEvent(source(10, 'Inspect the fixture', 1));
    transport.live!.onEvent(note(11, 10, 'Second request progress.', 1));
    assert.deepEqual(engine.snapshot().messages.filter(m => m.role === 'user').map(m => m.acceptedSource?.sourceUserSeq), [1, 10]);
    assert.deepEqual(engine.snapshot().messages.slice(0, -1).map(m => m.text),
      foldTranscript([...old, source(10, 'Inspect the fixture', 1), note(11, 10, 'Second request progress.', 1)]).map(m => m.text));
  } finally { engine.dispose(); }
});

test('invalid, foreign, unbound and contradictory check-ins are refused live and on replay', async () => {
  const bad: HarnessEvent[] = [
    note(10, 99), note(11, -1), note(12, 1.5), note(13, 1, 'Wrong turn', 2),
    { ...note(14), sessionId: 'foreign' }, { ...note(15), turn: undefined },
    { ...note(16), role: 'host' }, note(17, 1, ''), note(18, 1, 'x'.repeat(601)),
    note(19, 1, 'unsafe\0text'), { ...note(20), data: { ...note().data, version: 2 } },
    { ...note(21), data: { ...note().data, status: 'done' } },
    note(1), { ...note(22), data: { ...note().data, sourceUserSeq: '1' } },
  ];
  const { engine, transport } = createEngine();
  try {
    await engine.send('Inspect the fixture');
    await tick();
    transport.live!.onEvent(source());
    for (const event of bad) transport.live!.onEvent(event);
    assert.equal(engine.snapshot().messages.some(m => m.checkIn), false);
    assert.equal(engine.snapshot().busy, true);
    assert.equal(foldTranscript([source(), ...bad], sessionId).some(m => m.checkIn), false);
    for (const invalidSource of [
      { ...source(), data: { text: 'Inspect the fixture', synthetic: true } },
      { ...source(), role: 'host' }, { ...source(), turn: 1 }, { ...source(), sessionId: 'foreign' },
    ]) assert.equal(foldTranscript([invalidSource, note()], sessionId).some(m => m.checkIn), false);
    assert.equal(foldTranscript([note()], sessionId).length, 0);
  } finally { engine.dispose(); }
});

test('transports may omit sessionId only when their own session supplies it', () => {
  const events = [{ ...source(), sessionId: undefined }, { ...note(), sessionId: undefined }];
  assert.equal(foldTranscript(events, sessionId).filter(m => m.checkIn).length, 1);
  assert.equal(foldTranscript(events).filter(m => m.checkIn).length, 0);
});
