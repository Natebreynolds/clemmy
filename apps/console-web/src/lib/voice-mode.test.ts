import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceModeController, type VoiceModeDependencies, type VoiceChatMessage } from './voice-mode.js';
import type { VoiceSpeakerHandlers } from './voice-speaker.js';

const reply = (id: string, text: string, status = 'complete'): VoiceChatMessage => ({ id, role: 'assistant', text, status });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

class FakeSpeaker {
  speaking = false;
  requested: string[] = [];
  stopped = 0;
  constructor(private readonly handlers: VoiceSpeakerHandlers) {}
  say(text: string): void { this.requested.push(text); this.speaking = true; this.handlers.onSpeaking?.(); }
  finish(): void { this.speaking = false; this.handlers.onIdle?.(); }
  stop(): void { this.stopped++; if (this.speaking) this.finish(); }
}
function fixture() {
  let speaker!: FakeSpeaker;
  let captures = 0; let cancellations = 0;
  const deps: VoiceModeDependencies = {
    createSpeaker: handlers => (speaker = new FakeSpeaker(handlers)),
    createMic: () => ({ startRecording: async () => { captures++; }, cancel: () => { cancellations++; } }),
  };
  const controller = new VoiceModeController(deps);
  controller.enable('chat-a', async () => undefined, [reply('history', 'A historical answer.')]);
  return { controller, speaker, captures: () => captures, cancellations: () => cancellations };
}

test('desktop holds writing, checking and rejected completion drafts, then speaks terminal once', async () => {
  const f = fixture();
  for (const phase of ['writing', 'checking', 'withdrawn', undefined]) {
    f.controller.observe('chat-a', [{ ...reply('a1', 'An unreviewed completion.', 'thinking'), answerDraft: { id: 'd1', phase, withdrawn: 'review' } }]);
  }
  assert.deepEqual(f.speaker.requested, []);
  f.controller.observe('chat-a', [reply('a1', 'The corrected terminal answer.')]);
  f.controller.observe('chat-a', [reply('a1', 'The corrected terminal answer.')]);
  assert.deepEqual(f.speaker.requested, ['The corrected terminal answer.']);
  f.speaker.finish(); await settle();
  f.controller.observe('chat-a', [reply('a1', 'The corrected terminal answer.')]);
  assert.equal(f.speaker.requested.length, 1);
  f.controller.disable();
});

test('desktop removes withdrawn queued text before speech while preserving current progress and terminal delivery', () => {
  const f = fixture();
  const progress = { ...reply('p1', 'Checking the controlled fixture.', 'thinking'), checkIn: true };
  const intent = { ...reply('a1', 'I will inspect its output.', 'thinking'), answerDraft: { id: 'd1', phase: 'withdrawn', withdrawn: 'tool_call' } };
  f.controller.observe('chat-a', [progress, intent]);
  assert.deepEqual(f.speaker.requested, ['Checking the controlled fixture.']);
  f.controller.observe('chat-a', [progress, { ...intent, text: 'An obsolete claim.', answerDraft: { id: 'd1', phase: 'withdrawn', withdrawn: 'review' } }]);
  f.controller.observe('chat-a', [progress, reply('a1', 'The corrected terminal answer.')]);
  f.speaker.finish();
  assert.deepEqual(f.speaker.requested, ['Checking the controlled fixture.', 'The corrected terminal answer.']);
  f.speaker.finish();
  f.controller.disable();
});

test('desktop revokes active speech on draft replacement without reopening capture over the replacement', () => {
  const f = fixture();
  f.controller.observe('chat-a', [reply('a1', 'I will inspect the result.', 'thinking')]);
  const captures = f.captures(); const stopped = f.speaker.stopped;
  f.controller.observe('chat-a', [reply('a1', 'The corrected terminal answer.')]);
  assert.equal(f.speaker.stopped, stopped + 1);
  assert.deepEqual(f.speaker.requested, ['I will inspect the result.', 'The corrected terminal answer.']);
  assert.equal(f.captures(), captures, 'the synchronous stop callback cannot open capture before replacement playback');
  assert.equal(f.controller.getSnapshot().phase, 'speaking');
  f.controller.observe('chat-a', [{ ...reply('a1', 'An obsolete claim.', 'thinking'), answerDraft: { id: 'd1', phase: 'checking' } }]);
  assert.equal(f.speaker.speaking, false);
  assert.equal(f.speaker.requested.length, 2, 'checking completion cannot enter speech');
  f.controller.disable();
});

test('desktop navigation drops old speech and ignores stale origin observations', () => {
  const f = fixture();
  f.controller.observe('chat-a', [reply('a1', 'The original chat answer.'), reply('a2', 'An old queued answer.')]);
  const stopped = f.speaker.stopped;
  f.controller.attach('chat-b', async () => undefined, [reply('b-history', 'An existing chat answer.')]);
  assert.equal(f.speaker.stopped, stopped + 1);
  f.controller.observe('chat-a', [reply('a3', 'A late old chat answer.')]);
  f.controller.observe('chat-b', [reply('b-history', 'An existing chat answer.'), reply('b1', 'The current chat answer.')]);
  assert.deepEqual(f.speaker.requested, ['The original chat answer.', 'The current chat answer.']);
  f.controller.disable();
});

test('desktop disable and detach clear queued speech without reopening the microphone', () => {
  for (const action of ['disable', 'detach'] as const) {
    const f = fixture();
    f.controller.observe('chat-a', [reply('a1', 'The current answer.'), reply('a2', 'A queued answer.')]);
    const captures = f.captures();
    if (action === 'disable') f.controller.disable(); else f.controller.detach('chat-a');
    assert.equal(f.speaker.speaking, false);
    assert.equal(f.captures(), captures);
    assert.deepEqual(f.speaker.requested, ['The current answer.']);
    f.controller.disable();
  }
});

class FakeLive {
  started: Array<Array<{ role: string; text: string }>> = [];
  said: Array<[string, string | null]> = [];
  notes: Array<[string, string | null]> = [];
  directions: string[] = [];
  closes = 0;
  failStart: Error | null = null;
  constructor(readonly handlers: import('./live-voice.js').LiveVoiceHandlers) {}
  async start(history: readonly { role: 'user' | 'assistant'; text: string }[]): Promise<void> {
    this.started.push([...history]);
    if (this.failStart) throw this.failStart;
  }
  say(text: string, id: string | null): void { this.said.push([text, id]); }
  note(text: string, id: string | null): void { this.notes.push([text, id]); }
  direct(text: string): void { this.directions.push(text); }
  close(): void { this.closes++; }
}

function liveFixture(options: { available?: boolean; failStart?: Error } = {}) {
  const links: FakeLive[] = [];
  const sent: string[] = [];
  let speaker!: FakeSpeaker;
  let captures = 0;
  const deps: VoiceModeDependencies = {
    createSpeaker: handlers => (speaker = new FakeSpeaker(handlers)),
    createMic: () => ({ startRecording: async () => { captures++; }, cancel: () => undefined }),
    live: {
      available: async () => options.available ?? true,
      create: handlers => { const link = new FakeLive(handlers); if (options.failStart) link.failStart = options.failStart; links.push(link); return link; },
    },
  };
  const controller = new VoiceModeController(deps);
  const history = [{ id: 'u0', role: 'user' as const, text: 'Earlier question' }, reply('history', 'A historical answer.')];
  controller.enable('chat-a', async (text) => { sent.push(text); }, history);
  return { controller, links, sent, history, speaker: () => speaker, captures: () => captures };
}

test('live voice: a request the voice hears becomes the owner\'s turn and Clem\'s answer goes back to it', async () => {
  const f = liveFixture();
  await settle();
  assert.equal(f.links.length, 1);
  const link = f.links[0];
  assert.deepEqual(f.links[0].started, [[{ role: 'user', text: 'Earlier question' }, { role: 'assistant', text: 'A historical answer.' }]]);
  assert.equal(f.controller.getSnapshot().phase, 'connecting');
  assert.equal(f.controller.getSnapshot().engine, 'live');
  link.handlers.onLive();
  assert.equal(f.controller.getSnapshot().phase, 'listening');
  assert.equal(f.captures(), 0, 'the turn-by-turn microphone never opens');

  link.handlers.onRequest({ id: 'item_1', words: ' What is on my calendar today? ' });
  await settle();
  assert.deepEqual(f.sent, ['What is on my calendar today?']);
  assert.equal(f.controller.getSnapshot().phase, 'thinking');

  const owner = { id: 'u1', role: 'user' as const, text: 'What is on my calendar today?' };
  f.controller.observe('chat-a', [...f.history, owner, { ...reply('a1', 'Checking your calendar.', 'thinking') }]);
  f.controller.observe('chat-a', [...f.history, owner, { ...reply('a2', 'Still looking.', 'thinking'), checkIn: { at: 1 } }, reply('a1', '**Two** meetings: standup at 9 and review at 3.')]);
  assert.deepEqual(link.said, [['Checking your calendar.', 'item_1'], ['Two meetings: standup at 9 and review at 3.', 'item_1']]);
  assert.deepEqual(link.notes, [['Clem\'s progress: Still looking.', 'item_1']]);
  assert.equal(f.controller.getSnapshot().phase, 'listening', 'the answered turn ends');
  assert.deepEqual(f.speaker().requested, [], 'the turn-by-turn speaker never speaks');

  // Something Clem says later on her own is not tied to the old request.
  f.controller.observe('chat-a', [...f.history, owner, reply('a1', '**Two** meetings: standup at 9 and review at 3.'), reply('a3', 'Your export finished.')]);
  assert.deepEqual(link.said.at(-1), ['Your export finished.', null]);

  link.handlers.onSpeaking(true);
  assert.equal(f.controller.getSnapshot().phase, 'speaking');
  f.controller.interrupt();
  assert.equal(link.directions.length, 1);
  link.handlers.onSpeaking(false);
  assert.equal(f.controller.getSnapshot().phase, 'listening');

  f.controller.disable();
  assert.equal(link.closes, 1);
  assert.equal(f.controller.getSnapshot().phase, 'off');
});

test('live voice: unheard words are asked again instead of being sent', async () => {
  const f = liveFixture();
  await settle();
  f.links[0].handlers.onLive();
  f.links[0].handlers.onRequest({ id: 'item_1', words: ' [noise] ' });
  await settle();
  assert.deepEqual(f.sent, []);
  assert.equal(f.links[0].directions.length, 1);
});

test('live voice: without it, or when it cannot connect, turn-by-turn voice carries the conversation', async () => {
  const unavailable = liveFixture({ available: false });
  await settle();
  assert.equal(unavailable.links.length, 0);
  assert.equal(unavailable.controller.getSnapshot().engine, 'standard');
  assert.equal(unavailable.captures(), 1);

  const failing = liveFixture({ failStart: new Error('No microphone.') });
  await settle(); await settle();
  assert.equal(failing.controller.getSnapshot().engine, 'standard');
  assert.match(failing.controller.getSnapshot().notice, /Live voice is unavailable: No microphone\./);
  assert.equal(failing.captures(), 1);
});

test('live voice: an unexpected end reconnects once, then says why it stopped', async () => {
  const f = liveFixture();
  await settle();
  f.links[0].handlers.onLive();
  f.links[0].handlers.onClosed('connection_lost', false);
  assert.equal(f.links.length, 2, 'one automatic reconnect');
  f.links[1].handlers.onLive();
  f.links[1].handlers.onClosed('expired', false);
  assert.equal(f.links.length, 2);
  const state = f.controller.getSnapshot();
  assert.equal(state.enabled, false);
  assert.equal(state.error, 'Live voice reached its time limit.');
  // An end the owner asked for is quiet.
  const g = liveFixture();
  await settle();
  g.controller.disable();
  g.links[0].handlers.onClosed('close_requested', true);
  assert.equal(g.controller.getSnapshot().error, '');
});

test('live voice: moving between chats keeps the conversation; leaving the composer ends it', async () => {
  const f = liveFixture();
  await settle();
  const link = f.links[0];
  link.handlers.onLive();
  f.controller.detach('chat-a');
  f.controller.attach('chat-b', async () => undefined, []);
  assert.equal(link.closes, 0);
  assert.equal(link.notes.length, 1, 'the voice is told the conversation changed');
  assert.equal(f.links.length, 1);
});
