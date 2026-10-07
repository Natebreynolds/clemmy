import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatEngine, foldTranscript } from './engine.js';
import { liveActivityHeadline, narrateActivity } from './activity-presentation.js';
import { MODEL_PHASE_ACTIVITY_ID, reduceActivity } from './reduce-activity.js';
import type { HarnessEvent, ReplayPayload } from './types.js';
import type { StreamConnection, StreamTransport } from './stream.js';

const event = (seq: number, type: string, data: Record<string, unknown> = {}): HarnessEvent => ({
  seq, type, data, sessionId: 'retry-chat',
});
const retry = (seq: number, sourceUserSeq: number, reasonCode = 'connection'): HarnessEvent =>
  event(seq, 'model_resilience_observed', { sourceUserSeq, phase: 'retry', reasonCode });
const source = (seq: number): HarnessEvent => ({
  ...event(seq, 'user_input_received', { text: 'Fixture request' }), role: 'user', turn: 1,
});
const headline = (activity: Parameters<typeof narrateActivity>[0]): string =>
  liveActivityHeadline(narrateActivity(activity, { live: true }));
const nextTurn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

class RetryTransport implements StreamTransport {
  live: { onEvent(event: HarnessEvent): void } | null = null;
  async connect(opts: {
    sessionId: string; sinceSeq: number;
    onReplay(payload: ReplayPayload): void; onEvent(event: HarnessEvent): void;
  }): Promise<StreamConnection> {
    this.live = { onEvent: opts.onEvent };
    queueMicrotask(() => opts.onReplay({ sessionId: opts.sessionId, events: [] }));
    return { close: () => { this.live = null; } };
  }
  async fetchRecent(): Promise<ReplayPayload> { return { events: [] }; }
}

test('retry phase uses one fixed human row, survives a heartbeat and yields to concrete work', () => {
  let activity = reduceActivity([], event(1, 'turn_model_routed', { model: 'gpt-5.6-sol' }), () => 10);
  activity = reduceActivity(activity, { ...retry(2, 1), data: {
    ...retry(2, 1).data, label: 'secret transport diagnostic', error: 'private-account',
  } }, () => 20);
  assert.equal(headline(activity), 'The model connection was interrupted. Retrying…');
  assert.doesNotMatch(JSON.stringify(activity), /secret|private-account/);
  activity = reduceActivity(activity, retry(3, 1, 'busy'), () => 30);
  assert.equal(activity.filter(row => row.id === MODEL_PHASE_ACTIVITY_ID).length, 1);
  assert.equal(activity.find(row => row.id === MODEL_PHASE_ACTIVITY_ID)?.startedAt, 10);
  const pendingRetry = activity;
  assert.equal(reduceActivity(activity, event(4, 'heartbeat', { kind: 'active_turn_check_in' })), pendingRetry);
  assert.equal(reduceActivity(activity, retry(5, 1, 'future_reason')), pendingRetry);
  assert.equal(reduceActivity(activity, retry(6, 0)), pendingRetry);

  activity = reduceActivity(activity, event(7, 'tool_called', { tool: 'write_file', callId: 'fixture-write' }));
  assert.doesNotMatch(activity.find(row => row.id === MODEL_PHASE_ACTIVITY_ID)?.label ?? '', /Retrying/);
  assert.notEqual(headline(activity), 'The model is temporarily unavailable. Retrying…');
  assert.equal(reduceActivity(activity, retry(8, 1)), activity, 'a retry cannot mask a running concrete tool');
  activity = reduceActivity(activity, event(9, 'tool_returned', { tool: 'write_file', callId: 'fixture-write', ok: true }));
  assert.equal(headline(activity), 'Working on it…');
});

test('live retry owns only the exact active chat source and cannot revive completed work', async () => {
  const transport = new RetryTransport();
  const engine = new ChatEngine({ sessionId: 'retry-chat', transport, observeWhileIdle: true, api: {
    send: async () => ({ sessionId: 'retry-chat', accepted: true }),
    loadSession: async () => ({ events: [source(10)], latestSeq: 10 }),
  } });
  try {
    await engine.open();
    await nextTurn();
    assert.ok(transport.live);
    const feed = transport.live.onEvent;
    feed(retry(11, 9));
    assert.equal(engine.snapshot().messages.at(-1)?.activity?.length ?? 0, 0);
    feed({ ...retry(12, 10), sessionId: 'another-chat' });
    assert.equal(engine.snapshot().messages.at(-1)?.activity?.length ?? 0, 0);
    feed(retry(13, 10));
    assert.equal(headline(engine.snapshot().messages.at(-1)?.activity ?? []), 'The model connection was interrupted. Retrying…');

    feed(event(14, 'conversation_completed', { sourceUserSeq: 10, reply: 'Fixture completed.' }));
    const completed = engine.snapshot();
    assert.equal(completed.busy, false);
    assert.equal(completed.messages.at(-1)?.activity?.some(row => row.status === 'running'), false);
    feed(retry(15, 10, 'busy'));
    assert.deepEqual(engine.snapshot().messages, completed.messages);
    assert.equal(engine.snapshot().busy, false);

    feed(source(20));
    feed(event(21, 'turn_model_routed', { model: 'gpt-5.6-sol' }));
    const newer = engine.snapshot().messages;
    feed(retry(22, 10));
    assert.deepEqual(engine.snapshot().messages, newer, 'old retry cannot relabel the newer source');
    feed(retry(23, 20, 'empty'));
    assert.equal(headline(engine.snapshot().messages.at(-1)?.activity ?? []), 'The model returned no usable reply. Retrying…');
    feed(event(27, 'turn_model_routed', { model: 'gpt-5.6-sol' }));
    const routed = engine.snapshot().messages;
    feed(retry(25, 20, 'busy')); // Unseen older durable row, so stream dedup alone admits it.
    assert.deepEqual(engine.snapshot().messages, routed, 'an older same-source retry cannot replace a newer route');
    feed(event(31, 'tool_called', { tool: 'write_file', callId: 'newer-write' }));
    feed(event(32, 'tool_returned', { tool: 'write_file', callId: 'newer-write', ok: true }));
    const worked = engine.snapshot().messages;
    feed(retry(30, 20));
    assert.deepEqual(engine.snapshot().messages, worked, 'an unseen old retry cannot return after newer concrete work settles');
    feed(retry(33, 20, 'busy'));
    assert.equal(headline(engine.snapshot().messages.at(-1)?.activity ?? []), 'The model is temporarily unavailable. Retrying…');
  } finally { engine.dispose(); }
});

test('replay rejects older and settled retry rows while retaining a valid exact-source phase', t => {
  t.mock.method(Date, 'now', () => 100);
  const terminal = event(4, 'conversation_completed', { sourceUserSeq: 1, reply: 'Done.' });
  const completed = foldTranscript([source(1), retry(2, 1), terminal], 'retry-chat');
  assert.deepEqual(foldTranscript([source(1), retry(2, 1), terminal, retry(5, 1, 'busy')], 'retry-chat'), completed);
  assert.equal(completed.at(-1)?.activity?.some(row => row.status === 'running'), false);

  const newer = [source(1), terminal, source(10), event(11, 'turn_model_routed', { model: 'gpt-5.6-sol' })];
  const finishNewer = event(15, 'conversation_completed', { sourceUserSeq: 10, reply: 'Newer done.' });
  assert.deepEqual(foldTranscript([...newer, retry(12, 1), finishNewer], 'retry-chat'),
    foldTranscript([...newer, finishNewer], 'retry-chat'));
  const matching = foldTranscript([...newer, retry(12, 10, 'empty'), finishNewer], 'retry-chat');
  assert.equal(matching.at(-1)?.activity?.find(row => row.id === MODEL_PHASE_ACTIVITY_ID)?.label,
    'The model returned no usable reply. Retrying…');
  assert.deepEqual(foldTranscript([...newer, { ...retry(12, 10), sessionId: 'another-chat' }, finishNewer], 'retry-chat'),
    foldTranscript([...newer, finishNewer], 'retry-chat'));
  const newerRoute = event(14, 'turn_model_routed', { model: 'gpt-5.6-sol' });
  assert.deepEqual(foldTranscript([...newer, newerRoute, retry(12, 10), finishNewer], 'retry-chat'),
    foldTranscript([...newer, newerRoute, finishNewer], 'retry-chat'), 'folding unseen older progress keeps the newer phase');
  const olderTerminal = event(12, 'conversation_completed', { sourceUserSeq: 1, reply: 'Older done.' });
  const afterOlderTerminal = foldTranscript([...newer, olderTerminal, retry(13, 10, 'empty'), finishNewer], 'retry-chat');
  assert.equal(afterOlderTerminal.at(-1)?.activity?.find(row => row.id === MODEL_PHASE_ACTIVITY_ID)?.label,
    'The model returned no usable reply. Retrying…', 'an older terminal cannot retire the current exact-source retry');
});

test('useful exact-source live text clears retry and fences older catch-up rows at the observed cursor', async () => {
  const transport = new RetryTransport();
  const engine = new ChatEngine({ sessionId: 'retry-chat', transport, api: {
    send: async () => ({ sessionId: 'retry-chat', accepted: true }),
    loadSession: async () => ({ events: [source(10)], latestSeq: 10 }),
  } });
  try {
    await engine.open();
    await nextTurn();
    assert.ok(transport.live);
    const feed = transport.live.onEvent;
    feed(retry(12, 10));
    const retryLabel = 'The model connection was interrupted. Retrying…';
    for (const data of [
      { sourceUserSeq: 9, streamId: 'foreign', offset: 0, delta: 'Other source' },
      { sourceUserSeq: 10, streamId: 'a', offset: 20, delta: 'Rejected offset' },
      { sourceUserSeq: 10, streamId: 'a', offset: 0, delta: ' ' },
      { sourceUserSeq: 10, streamId: 'a', checking: true },
      { sourceUserSeq: 10, streamId: 'a', reset: true },
    ]) {
      feed(event(0, 'stream_token', data));
      assert.equal(headline(engine.snapshot().messages.at(-1)?.activity ?? []), retryLabel);
    }
    feed(event(16, 'heartbeat', { kind: 'active_turn_check_in' }));
    assert.equal(headline(engine.snapshot().messages.at(-1)?.activity ?? []), retryLabel,
      'heartbeat alone does not prove model progress');
    feed(event(0, 'stream_token', { sourceUserSeq: 10, streamId: 'b', offset: 0, delta: 'Useful draft' }));
    assert.equal(engine.snapshot().messages.at(-1)?.text, 'Useful draft');
    assert.equal(headline(engine.snapshot().messages.at(-1)?.activity ?? []), 'Working on it…');
    const streamed = engine.snapshot().messages;
    feed(retry(14, 10, 'busy')); // Unseen and above the prior retry12, below the observed heartbeat16.
    assert.deepEqual(engine.snapshot().messages, streamed, 'seq0 text advances only retry admission to its observed durable cursor');
    feed(event(0, 'stream_token', { sourceUserSeq: 10, streamId: 'b', offset: 12, delta: ' continues' }));
    assert.equal(engine.snapshot().messages.at(-1)?.text, 'Useful draft continues', 'ordinary draft placement remains intact');
    assert.equal(engine.snapshot().messages.at(-1)?.activity?.filter(row => row.id === MODEL_PHASE_ACTIVITY_ID).length, 1);
  } finally { engine.dispose(); }
});

test('replayed useful text fences an older retry without delivering provisional draft words', t => {
  t.mock.method(Date, 'now', () => 100);
  const before = [source(10), retry(12, 10)];
  const heartbeat = event(16, 'heartbeat', { kind: 'active_turn_check_in' });
  const finish = event(18, 'conversation_completed', { sourceUserSeq: 10, presentation: { status: 'done' }, reply: 'Canonical reply.' });
  const baseline = foldTranscript([...before, finish], 'retry-chat');
  for (const frame of [
    event(16, 'stream_token', { sourceUserSeq: 10, streamId: 'draft', offset: 0, delta: 'Provisional words' }),
    event(0, 'stream_token', { sourceUserSeq: 10, streamId: 'draft', offset: 0, delta: 'Provisional words' }),
  ]) {
    const replayed = foldTranscript([...before, heartbeat, frame, retry(14, 10, 'busy'), finish], 'retry-chat');
    assert.equal(replayed.at(-1)?.activity?.find(row => row.id === MODEL_PHASE_ACTIVITY_ID)?.label, 'Working on it…');
    assert.equal(replayed.at(-1)?.text, baseline.at(-1)?.text);
    assert.doesNotMatch(replayed.at(-1)?.text ?? '', /Provisional/);
  }
  for (const data of [
    { sourceUserSeq: 9, streamId: 'draft', offset: 0, delta: 'Other source' },
    { sourceUserSeq: 10, streamId: 'draft', offset: 7, delta: 'Rejected offset' },
    { sourceUserSeq: 10, streamId: 'draft', offset: 0, delta: ' ' },
    { sourceUserSeq: 10, streamId: 'draft', checking: true },
  ]) {
    const replayed = foldTranscript([...before, event(0, 'stream_token', data), finish], 'retry-chat');
    assert.equal(replayed.at(-1)?.activity?.find(row => row.id === MODEL_PHASE_ACTIVITY_ID)?.label,
      'The model connection was interrupted. Retrying…');
  }
});
