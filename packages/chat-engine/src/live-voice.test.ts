import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_APPEND_MAX_CHARS, LiveTranscript, LiveVoiceProtocol, liveSpokenText, type LiveVoiceHandlers } from './live-voice.js';

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function protocol() {
  const sent: Array<Record<string, unknown>> = [];
  const requests: Array<{ id: string; words: string }> = [];
  const speaking: boolean[] = [];
  const closed: Array<[string, boolean]> = [];
  let live = 0;
  const handlers: LiveVoiceHandlers = {
    onLive: () => { live += 1; },
    onRequest: request => requests.push(request),
    onSpeaking: value => speaking.push(value),
    onHearing: () => undefined,
    onClosed: (reason, expected) => closed.push([reason, expected]),
    onError: () => undefined,
  };
  const session = new LiveVoiceProtocol(handlers);
  session.attach(event => sent.push(event));
  const heard = (delta: string, start: number, end = start + 200) => session.receive({ type: 'session.input_transcript.delta', delta, start_ms: start, end_ms: end });
  const ask = (id: string, offset: number) => session.receive({ type: 'session.delegation.created', offset_ms: offset, delegation: { id, type: 'delegation', target: 'client' } as never });
  return { session, sent, requests, speaking, closed, heard, ask, live: () => live };
}

test('a request takes every word not yet taken, in timeline order, once', () => {
  const transcript = new LiveTranscript();
  transcript.add(' the report', 1_200, 1_600);
  transcript.add('Send', 1_000, 1_200);
  transcript.add(' to the team', 1_600, 2_000);
  assert.equal(transcript.take(), 'Send the report to the team');
  assert.equal(transcript.take(), '');
  transcript.add('And also', 3_000, 3_300);
  assert.equal(transcript.take(), 'And also');
});

test('what the voice is given to say has no markdown, code or tables and stays within one append', () => {
  const spoken = liveSpokenText([
    '**Done.** I moved the meeting to `Thursday`.',
    '| Day | Time |', '|---|---|', '| Thu | 3 |',
    '```js', 'secret()', '```',
    'See [the invite](https://example.com/x) or https://example.com/raw.',
  ].join('\n'));
  assert.equal(spoken, 'Done. I moved the meeting to Thursday. See the invite or the link');
  const long = liveSpokenText(Array.from({ length: 200 }, (_, i) => `Sentence ${i} is here.`).join(' '));
  assert.ok(long.length <= LIVE_APPEND_MAX_CHARS);
  assert.match(long, /here\. The rest is on screen\.$/);
});

test('nothing is sent before the session starts; held words go out once it has', () => {
  const f = protocol();
  f.session.note('Context before start.', null);
  assert.equal(f.sent.length, 0);
  f.session.receive({ type: 'session.started' });
  assert.equal(f.live(), 1);
  assert.deepEqual(f.sent.map(event => [event.type, event.delegation_id, event.content]), [['session.thinking.append', null, 'Context before start.']]);
  assert.ok(typeof f.sent[0].event_id === 'string');
});

test('the voice may ask before the owner finishes: the request waits for their pause', async () => {
  const f = protocol();
  f.session.receive({ type: 'session.started' });
  f.heard('Hey Clem, what is on', 2_000);
  f.ask('item_a', 2_400);
  f.heard(' my calendar', 2_200);
  await wait(300);
  f.heard(' today', 2_600);
  await wait(500);
  assert.deepEqual(f.requests, [], 'still talking');
  await wait(400);
  assert.deepEqual(f.requests, [{ id: 'item_a', words: 'Hey Clem, what is on my calendar today' }]);
  f.session.say('You have two meetings.', 'item_a');
  f.session.say('A note for an unknown request.', 'item_unknown');
  f.session.direct('Stop talking now.');
  assert.deepEqual(f.sent.map(event => [event.type, event.delegation_id, event.content]), [
    ['session.commentary.append', 'item_a', 'You have two meetings.'],
    ['session.commentary.append', null, 'A note for an unknown request.'],
    ['session.instructions.append', null, 'Stop talking now.'],
  ]);
});

test('a request made after the owner already paused goes at once; asks made while they spoke are one request', async () => {
  const f = protocol();
  f.session.receive({ type: 'session.started' });
  f.heard('Add milk to the list', 1_000, 1_800);
  f.ask('item_a', 2_600);
  await wait(320);
  assert.deepEqual(f.requests, [{ id: 'item_a', words: 'Add milk to the list' }]);

  f.heard('Book the room', 5_000, 5_600);
  f.ask('item_b', 5_400);
  f.heard(' for Thursday, not Friday', 5_600, 6_400);
  f.ask('item_c', 6_300);
  await wait(800);
  assert.deepEqual(f.requests.slice(1), [{ id: 'item_b', words: 'Book the room for Thursday, not Friday' }]);
  assert.deepEqual(f.sent.map(event => [event.type, event.delegation_id]), [['session.thinking.append', 'item_c']]);
});

test('speaking follows the voice\'s words and the session ends once, saying whether the owner ended it', async () => {
  const f = protocol();
  f.session.receive({ type: 'session.started' });
  f.session.receive({ type: 'session.output_transcript.delta', delta: 'Sure', start_ms: 0, end_ms: 100 });
  f.session.receive({ type: 'session.output_transcript.delta', delta: ' thing', start_ms: 100, end_ms: 200 });
  assert.deepEqual(f.speaking, [true]);
  await wait(1_000);
  assert.deepEqual(f.speaking, [true, false]);
  assert.equal(f.session.close(), true);
  assert.equal(f.session.close(), false);
  assert.equal(f.sent.at(-1)!.type, 'session.close');
  f.session.say('Too late.', null);
  assert.equal(f.sent.at(-1)!.type, 'session.close', 'nothing is appended after closing starts');
  f.session.receive({ type: 'session.closed', reason: 'close_requested' });
  f.session.transportClosed();
  assert.deepEqual(f.closed, [['close_requested', true]]);

  const lost = protocol();
  lost.session.receive({ type: 'session.started' });
  lost.session.transportClosed();
  assert.deepEqual(lost.closed, [['connection_lost', false]]);
  const expired = protocol();
  expired.session.receive({ type: 'session.closed', reason: 'expired' });
  assert.deepEqual(expired.closed, [['expired', false]]);
});
