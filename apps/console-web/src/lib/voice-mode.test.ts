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
