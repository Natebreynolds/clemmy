import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserVoiceAudio, MobileVoiceController, VoiceUtteranceBuffer,
  type MobileVoiceAudio, type MobileVoiceConversation, type MobileVoiceDependencies, type VoiceChatMessage, type VoiceSpeech,
} from './mobile-voice.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const reply = (id: string, text: string, status = 'complete'): VoiceChatMessage => ({ id, role: 'assistant', text, status });

class FakeAudio implements MobileVoiceAudio {
  events: string[] = [];
  utterance: ((wav: Blob) => void) | null = null;
  captureSignal: AbortSignal | null = null;
  playSignal: AbortSignal | null = null;
  unlockResult = Promise.resolve();
  listenResult = Promise.resolve();
  playResult = Promise.resolve();
  unlock() { this.events.push('unlock'); return this.unlockResult; }
  listen(callback: (wav: Blob) => void, signal: AbortSignal) {
    this.events.push('listen'); this.utterance = callback; this.captureSignal = signal;
    return this.listenResult;
  }
  stopListening() { this.events.push('stop mic'); }
  play(_speech: VoiceSpeech, signal: AbortSignal) { this.events.push('play'); this.playSignal = signal; return this.playResult; }
  close() { this.events.push('close'); }
}

function fixture(overrides: Partial<MobileVoiceDependencies> = {}, onSend?: MobileVoiceConversation['onSend']) {
  const audio = new FakeAudio();
  const sent: string[] = []; const said: string[] = [];
  const deps: MobileVoiceDependencies = {
    createAudio: () => audio,
    transcribe: async () => 'What is next?',
    speak: async words => { said.push(words); return new Blob(['fake MP3']); },
    ...overrides,
  };
  const controller = new MobileVoiceController(deps);
  const conversation: MobileVoiceConversation = {
    scope: 'engine-a', messages: [reply('history', 'An old answer.')], busy: false,
    onSend: onSend ?? (async words => { sent.push(words); }),
  };
  controller.observe(conversation);
  return { controller, audio, sent, said, conversation, observe: (patch: Partial<MobileVoiceConversation>) => {
    Object.assign(conversation, patch); controller.observe({ ...conversation });
  } };
}

test('explicit start unlocks synchronously, then the ordinary chat turn completes before listening again', async () => {
  const f = fixture();
  assert.deepEqual(f.audio.events, [], 'mount/observation never captures');
  const start = f.controller.start();
  assert.equal(f.audio.events[0], 'unlock', 'output is unlocked inside the tap call');
  await start; await settle();
  assert.equal(f.controller.getSnapshot().phase, 'listening');
  assert.deepEqual(f.said, [], 'history is never spoken');
  const capture = f.audio.captureSignal!;
  f.audio.utterance!(new Blob(['synthetic utterance'])); await settle();
  assert.equal(capture.aborted, true, 'no mic during transcription or work');
  assert.deepEqual(f.sent, ['What is next?']);
  assert.equal(f.controller.getSnapshot().phase, 'thinking');
  assert.equal(f.audio.events.filter(event => event === 'listen').length, 1);
  f.observe({ busy: true, messages: [...f.conversation.messages, { id: 'u1', role: 'user', text: f.sent[0] }, reply('a1', '', 'thinking')] });
  const playback = deferred<void>(); f.audio.playResult = playback.promise;
  f.observe({ busy: false, messages: [reply('history', 'An old answer.'), { id: 'u1', role: 'user', text: f.sent[0] }, reply('a1', 'Your meeting starts at four.')] });
  await settle();
  assert.deepEqual(f.said, ['Your meeting starts at four.']);
  assert.equal(f.controller.getSnapshot().phase, 'speaking');
  assert.equal(f.audio.events.filter(event => event === 'listen').length, 1, 'speaker never feeds the microphone');
  f.observe({}); await settle();
  assert.equal(f.said.length, 1, 'rerenders never repeat the answer');
  playback.resolve(); await settle();
  assert.equal(f.controller.getSnapshot().phase, 'listening');
  assert.equal(f.audio.events.filter(event => event === 'listen').length, 2);
  f.controller.stop();
});

test('completion drafts stay silent until reviewed terminal delivery, then speak once', async () => {
  const f = fixture(); await f.controller.start(); await settle();
  const draft = (text: string, phase = 'writing'): VoiceChatMessage => ({ ...reply('a1', text, 'thinking'), answerDraft: { id: 'd1', phase, withdrawn: 'review' } });
  f.observe({ busy: true, messages: [draft('Half a sentence')] }); await settle(); assert.deepEqual(f.said, []);
  f.observe({ messages: [draft('An unreviewed completion. Another unfinished')] }); await settle(); assert.deepEqual(f.said, []);
  f.observe({ messages: [draft('An unreviewed completion.', 'checking')] }); await settle(); assert.deepEqual(f.said, []);
  f.observe({ messages: [{ ...draft('An unreviewed completion.'), answerDraft: { id: 'd2' } }] }); await settle(); assert.deepEqual(f.said, [], 'unknown draft phases cannot bypass review');
  f.observe({ messages: [draft('An unreviewed completion.', 'withdrawn')] }); await settle(); assert.deepEqual(f.said, []);
  f.observe({ busy: false, messages: [reply('a1', 'The corrected answer (with its context).')] }); await settle();
  f.observe({}); await settle();
  assert.deepEqual(f.said, ['The corrected answer (with its context).']);
  assert.equal(f.audio.events.filter(event => event === 'play').length, 1);
  f.controller.stop();
});

test('canonical check-ins, first words and tool intent remain speakable', async () => {
  const f = fixture(); await f.controller.start(); await settle();
  const progress = { ...reply('p1', 'I am checking the fixture.', 'thinking'), checkIn: { kind: 'progress' } };
  const first = reply('a1', 'I will inspect the current result.', 'thinking');
  const toolIntent = { ...reply('a2', 'I will read that file.', 'thinking'), answerDraft: { id: 'd2', phase: 'withdrawn', withdrawn: 'tool_call' } };
  f.observe({ busy: true, messages: [progress, first, toolIntent] }); await settle();
  assert.deepEqual(f.said, ['I am checking the fixture.', 'I will inspect the current result.', 'I will read that file.']);
  f.observe({}); await settle(); assert.equal(f.said.length, 3);
  assert.equal(f.controller.getSnapshot().phase, 'thinking');
  f.controller.stop();
});

test('review withdrawal removes queued speech before generation while accepted delivery waits its turn', async () => {
  const f = fixture(); const playback = deferred<void>(); f.audio.playResult = playback.promise;
  await f.controller.start(); await settle();
  const progress = { ...reply('p1', 'Checking the controlled fixture.', 'thinking'), checkIn: { kind: 'progress' } };
  const toolIntent = { ...reply('a1', 'I will inspect its output.', 'thinking'), answerDraft: { id: 'd1', phase: 'withdrawn', withdrawn: 'tool_call' } };
  f.observe({ busy: true, messages: [progress, toolIntent] }); await settle();
  assert.deepEqual(f.said, ['Checking the controlled fixture.']);
  f.observe({ messages: [progress, { ...toolIntent, text: 'An obsolete completion claim.', answerDraft: { id: 'd1', phase: 'checking' } }] });
  f.observe({ messages: [progress, { ...toolIntent, text: 'An obsolete completion claim.', answerDraft: { id: 'd1', phase: 'withdrawn', withdrawn: 'review' } }] });
  f.observe({ busy: false, messages: [progress, reply('a1', 'The corrected terminal answer.')] });
  f.audio.playResult = Promise.resolve(); playback.resolve(); await settle();
  assert.deepEqual(f.said, ['Checking the controlled fixture.', 'The corrected terminal answer.']);
  assert.equal(f.audio.events.filter(event => event === 'play').length, 2);
  f.controller.stop();
});

test('withdrawal aborts in-flight speech generation and late audio cannot supersede its replacement', async () => {
  const oldSpeech = deferred<Blob>(); const requested: string[] = []; const signals: AbortSignal[] = [];
  const f = fixture({ speak: async (words, signal) => {
    requested.push(words); signals.push(signal);
    return requested.length === 1 ? oldSpeech.promise : new Blob(['corrected audio']);
  } });
  await f.controller.start(); await settle();
  f.observe({ busy: true, messages: [reply('a1', 'I will check the result.', 'thinking')] }); await settle();
  assert.equal(f.audio.events.filter(event => event === 'play').length, 0);
  f.observe({ messages: [{ ...reply('a1', 'An obsolete completion claim.', 'thinking'), answerDraft: { id: 'd1', phase: 'checking' } }] });
  assert.equal(signals[0].aborted, true);
  f.observe({ messages: [{ ...reply('a1', 'An obsolete completion claim.', 'thinking'), answerDraft: { id: 'd1', phase: 'withdrawn', withdrawn: 'review' } }] });
  const playing = deferred<void>(); f.audio.playResult = playing.promise;
  f.observe({ busy: false, messages: [reply('a1', 'The corrected terminal answer.')] }); await settle();
  assert.deepEqual(requested, ['I will check the result.', 'The corrected terminal answer.']);
  assert.equal(f.audio.events.filter(event => event === 'play').length, 1);
  oldSpeech.resolve(new Blob(['obsolete audio'])); await settle();
  assert.equal(f.audio.events.filter(event => event === 'play').length, 1, 'late revoked audio never starts playback');
  assert.equal(f.controller.getSnapshot().phase, 'speaking', 'old completion cannot release the replacement operation');
  assert.equal(signals[1].aborted, false);
  assert.equal(f.audio.events.filter(event => event === 'listen').length, 1);
  playing.resolve(); await settle();
  assert.equal(f.controller.getSnapshot().phase, 'listening');
  assert.equal(f.controller.getSnapshot().error, '');
  f.controller.stop();
});

test('withdrawal aborts active playback without treating its late rejection as a new voice failure', async () => {
  const f = fixture(); const playing = deferred<void>(); f.audio.playResult = playing.promise;
  await f.controller.start(); await settle();
  f.observe({ busy: true, messages: [reply('a1', 'I am checking the result.', 'thinking')] }); await settle();
  const oldPlayback = f.audio.playSignal!;
  f.observe({ messages: [{ ...reply('a1', 'An obsolete completion claim.', 'thinking'), answerDraft: { id: 'd1', phase: 'withdrawn', withdrawn: 'review' } }] });
  assert.equal(oldPlayback.aborted, true);
  const replacementPlayback = deferred<void>(); f.audio.playResult = replacementPlayback.promise;
  f.observe({ busy: false, messages: [reply('a1', 'The corrected terminal answer.')] }); await settle();
  assert.deepEqual(f.said, ['I am checking the result.', 'The corrected terminal answer.']);
  playing.reject(new DOMException('Obsolete speech stopped', 'AbortError')); await settle();
  assert.equal(f.controller.getSnapshot().enabled, true);
  assert.equal(f.controller.getSnapshot().phase, 'speaking');
  assert.equal(f.audio.playSignal?.aborted, false);
  replacementPlayback.resolve(); await settle();
  assert.equal(f.controller.getSnapshot().phase, 'listening');
  assert.equal(f.controller.getSnapshot().error, '');
  f.controller.stop();
});

test('chat navigation and a new voice generation cannot replay a late answer from the old origin', async () => {
  const pending = deferred<Blob>(); let oldSignal: AbortSignal | undefined; const requested: string[] = [];
  const f = fixture({ speak: async (words, signal) => {
    requested.push(words);
    if (requested.length === 1) { oldSignal = signal; return pending.promise; }
    return new Blob(['new origin audio']);
  } });
  await f.controller.start(); await settle();
  f.observe({ messages: [reply('a1', 'The first conversation answer.')] }); await settle();
  f.observe({ scope: 'engine-b', messages: [] }); assert.equal(oldSignal?.aborted, true);
  await f.controller.start(); await settle();
  f.observe({ messages: [reply('a1', 'The current conversation answer.')] }); await settle();
  pending.resolve(new Blob(['old origin audio'])); await settle();
  assert.deepEqual(requested, ['The first conversation answer.', 'The current conversation answer.']);
  assert.equal(f.audio.events.filter(event => event === 'play').length, 1);
  assert.equal(f.controller.getSnapshot().phase, 'listening');
  f.controller.stop();
});

test('noise-only transcription resumes capture without sending a chat', async () => {
  const f = fixture({ transcribe: async () => '[MUSIC] (applause)' });
  await f.controller.start(); await settle(); f.audio.utterance!(new Blob()); await settle();
  assert.deepEqual(f.sent, []); assert.equal(f.controller.getSnapshot().phase, 'listening'); f.controller.stop();
});

test('stop during output unlock or microphone startup cannot open or revive the loop', async () => {
  for (const pendingStage of ['unlock', 'listen']) {
    const f = fixture(); const pending = deferred<void>();
    if (pendingStage === 'unlock') f.audio.unlockResult = pending.promise;
    else f.audio.listenResult = pending.promise;
    const start = f.controller.start(); await settle();
    const lateUtterance = f.audio.utterance;
    f.controller.stop(); pending.resolve(); await start; await settle();
    lateUtterance?.(new Blob()); await settle();
    assert.equal(f.controller.getSnapshot().enabled, false);
    assert.deepEqual(f.sent, []);
    assert.equal(f.audio.events.filter(event => event === 'listen').length, pendingStage === 'unlock' ? 0 : 1);
    assert.equal(f.audio.events.at(-1), 'close');
  }
});

test('stop aborts transcription and ignores its late result, including after restarting', async () => {
  const transcribed = deferred<string>(); let signal: AbortSignal | undefined;
  const f = fixture({ transcribe: async (_wav, abort) => { signal = abort; return transcribed.promise; } });
  await f.controller.start(); await settle(); f.audio.utterance!(new Blob());
  assert.equal(f.controller.getSnapshot().phase, 'transcribing');
  f.controller.stop(); assert.equal(signal?.aborted, true);
  await f.controller.start(); await settle();
  transcribed.resolve('A stale request'); await settle();
  assert.deepEqual(f.sent, []); assert.equal(f.controller.getSnapshot().phase, 'listening'); f.controller.stop();
});

test('scope changes revoke the admission callback after asynchronous chat setup', async () => {
  const setup = deferred<void>(); const accepted: string[] = []; let stillCurrent: (() => boolean) | undefined;
  const f = fixture({}, async (words, current) => {
    stillCurrent = current; await setup.promise; if (current()) accepted.push(words);
  });
  await f.controller.start(); await settle(); f.audio.utterance!(new Blob()); await settle();
  assert.equal(stillCurrent?.(), true);
  f.observe({ scope: 'engine-b' }); assert.equal(stillCurrent?.(), false);
  setup.resolve(); await settle(); assert.deepEqual(accepted, []); assert.equal(f.controller.getSnapshot().enabled, false);
});

test('a turn starting during transcription preserves spoken words and never steers them into that turn', async () => {
  const transcribed = deferred<string>(); const f = fixture({ transcribe: () => transcribed.promise });
  await f.controller.start(); await settle(); f.audio.utterance!(new Blob()); f.observe({ busy: true });
  transcribed.resolve('Please make the report'); await settle();
  assert.deepEqual(f.sent, []); assert.equal(f.controller.getSnapshot().enabled, false);
  assert.equal(f.controller.getSnapshot().heard, 'Please make the report'); assert.match(f.controller.getSnapshot().error, /another turn/);
});

test('failed or uncertain admission preserves the spoken request without automatic retry', async () => {
  const f = fixture({}, async () => { throw new Error('Connection lost; check the conversation before retrying.'); });
  await f.controller.start(); await settle(); f.audio.utterance!(new Blob()); await settle();
  assert.equal(f.controller.getSnapshot().enabled, false); assert.match(f.controller.getSnapshot().error, /Connection lost/);
  assert.equal(f.controller.getSnapshot().heard, 'What is next?'); assert.equal(f.audio.events.filter(event => event === 'listen').length, 1);
});

test('stopping the admitted chat ends voice without speaking its stop receipt or reopening the mic', async () => {
  const f = fixture(); await f.controller.start(); await settle(); f.audio.utterance!(new Blob()); await settle();
  f.observe({ busy: false, messages: [...f.conversation.messages, { id: 'u1', role: 'user', text: 'What is next?' }, reply('a1', 'Stopped as requested.', 'stopped')] });
  await settle(); assert.equal(f.controller.getSnapshot().enabled, false); assert.deepEqual(f.said, []);
  assert.equal(f.audio.events.filter(event => event === 'listen').length, 1);
});

test('stopping cancels pending speech generation and active playback without listening again', async () => {
  for (const stage of ['speak', 'play']) {
    const pending = deferred<Blob>(); const playing = deferred<void>(); let speechSignal: AbortSignal | undefined;
    const f = fixture({ speak: async (_words, signal) => { speechSignal = signal; return stage === 'speak' ? pending.promise : new Blob(); } });
    f.audio.playResult = playing.promise;
    await f.controller.start(); await settle(); f.observe({ messages: [reply('a1', 'A new reply.')] }); await settle();
    f.controller.stop(); assert.equal(speechSignal?.aborted, true);
    pending.resolve(new Blob()); playing.resolve(); await settle();
    assert.equal(f.audio.events.filter(event => event === 'play').length, stage === 'speak' ? 0 : 1);
    assert.equal(f.audio.events.filter(event => event === 'listen').length, 1);
    assert.equal(f.controller.getSnapshot().enabled, false);
  }
});

test('capture and speech failures stop with visible recovery text', async () => {
  const f = fixture(); f.audio.listenResult = Promise.reject(new Error('Microphone access was not allowed.'));
  await f.controller.start(); await settle();
  assert.equal(f.controller.getSnapshot().enabled, false); assert.match(f.controller.getSnapshot().error, /not allowed/);
  const g = fixture({ speak: async () => { throw new Error('Spoken replies are unavailable.'); } });
  await g.controller.start(); await settle(); g.observe({ messages: [reply('a1', 'Still readable in chat.')] }); await settle();
  assert.equal(g.controller.getSnapshot().enabled, false); assert.match(g.controller.getSnapshot().error, /unavailable/);
});

test('a synchronous stop from an active-state subscriber cannot create output or capture', async () => {
  const f = fixture(); f.controller.subscribe(() => { if (f.controller.getSnapshot().enabled) f.controller.stop(); });
  await f.controller.start(); assert.deepEqual(f.audio.events, []); assert.equal(f.controller.getSnapshot().enabled, false);
});

test('silence stays bounded, small noises do not send, and speech ends after a pause', () => {
  const buffer = new VoiceUtteranceBuffer(16_000); const quiet = new Float32Array(1600); const talking = new Float32Array(1600).fill(0.08);
  for (let i = 0; i < 1000; i++) assert.equal(buffer.append(quiet), null);
  assert.equal(buffer.append(talking), null);
  for (let i = 0; i < 12; i++) assert.equal(buffer.append(quiet), null, 'one noise spike is not a request');
  buffer.append(talking); buffer.append(talking); buffer.append(talking);
  let wav: Blob | null = null;
  for (let i = 0; i < 9; i++) wav = buffer.append(quiet) ?? wav;
  assert.ok(wav); assert.ok(wav.size < 50_000, 'the long quiet period was never retained');
  assert.equal(wav.type, 'audio/wav');
});

test('continuous speech is capped at one minute per clip', () => {
  const buffer = new VoiceUtteranceBuffer(16_000); const talking = new Float32Array(1600).fill(0.08);
  let wav: Blob | null = null; let clips = 0;
  for (let i = 0; i < 601; i++) { const next = buffer.append(talking); if (next) { wav = next; clips++; } }
  assert.equal(clips, 1); assert.ok(wav); assert.ok(wav.size <= 60.1 * 32_000 + 44);
});

class FakeNode {
  onended: (() => void) | null = null;
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null;
  gain = { value: 1 }; buffer: unknown; started = false; stopped = false; disconnected = false;
  connect() { return this; }
  disconnect() { this.disconnected = true; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}
class FakeContext {
  sampleRate = 48_000; state = 'running'; destination = new FakeNode(); onstatechange: (() => void) | null = null;
  nodes: FakeNode[] = []; resumed = false; closed = false;
  decoded: Promise<unknown> = Promise.resolve({}); failProcessor = false; failBufferSource = false; resumeResult = Promise.resolve();
  resume() { this.resumed = true; return this.resumeResult; }
  close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
  createBuffer() { return {}; }
  createBufferSource() { if (this.failBufferSource) throw new Error('Output graph failed'); const node = new FakeNode(); this.nodes.push(node); return node; }
  createMediaStreamSource() { return this.createBufferSource(); }
  createScriptProcessor() { if (this.failProcessor) throw new Error('Capture graph failed'); return this.createBufferSource(); }
  createGain() { return this.createBufferSource(); }
  decodeAudioData() { return this.decoded; }
}
function browserFixture(t: TestContext, getUserMedia?: () => Promise<unknown>, setupContext?: (context: FakeContext) => void) {
  const contexts: FakeContext[] = []; const track = new EventTarget() as EventTarget & { stop: () => void; stopped: boolean };
  track.stopped = false; track.stop = () => { track.stopped = true; };
  const stream = { getTracks: () => [track] };
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    AudioContext: class extends FakeContext { constructor() { super(); contexts.push(this); setupContext?.(this); } },
  } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: getUserMedia ?? (async () => stream) } } });
  t.after(() => {
    if (windowBefore) Object.defineProperty(globalThis, 'window', windowBefore); else Reflect.deleteProperty(globalThis, 'window');
    if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore); else Reflect.deleteProperty(globalThis, 'navigator');
  });
  const errors: unknown[] = []; const audio = new BrowserVoiceAudio(error => errors.push(error));
  return { audio, contexts, track, stream, errors };
}

test('browser output resumes during the tap and uses the same audio context for delayed MP3 playback', async t => {
  const f = browserFixture(t); const unlock = f.audio.unlock();
  assert.equal(f.contexts.length, 1); assert.equal(f.contexts[0].resumed, true); assert.equal(f.contexts[0].nodes[0].started, true);
  await unlock;
  const capture = new AbortController(); await f.audio.listen(() => undefined, capture.signal);
  assert.equal(f.track.stopped, false);
  const playing = f.audio.play(new Blob(['fake MP3']), new AbortController().signal); await settle();
  assert.equal(f.track.stopped, true, 'output closes capture'); assert.equal(f.contexts.length, 1);
  const output = f.contexts[0].nodes.at(-1)!; assert.equal(output.started, true);
  output.onended!(); await playing; assert.equal(output.disconnected, true);
  f.audio.close(); assert.equal(f.contexts[0].closed, true);
});

test('permission resolved after stop closes late microphone tracks', async t => {
  const permission = deferred<unknown>(); const f = browserFixture(t, () => permission.promise);
  await f.audio.unlock(); const capture = new AbortController(); const listening = f.audio.listen(() => assert.fail('late capture'), capture.signal);
  capture.abort(); f.audio.close(); permission.resolve(f.stream); await listening;
  assert.equal(f.track.stopped, true); assert.equal(f.contexts[0].nodes.length, 1, 'no capture graph created');
});

test('capture graph failure releases the already granted microphone', async t => {
  const f = browserFixture(t); await f.audio.unlock(); f.contexts[0].failProcessor = true;
  await assert.rejects(f.audio.listen(() => undefined, new AbortController().signal), /Capture graph failed/);
  assert.equal(f.track.stopped, true); f.audio.close();
});

test('abort during decoding never starts an audio source', async t => {
  const f = browserFixture(t); await f.audio.unlock(); const decoded = deferred<unknown>(); f.contexts[0].decoded = decoded.promise;
  const operation = new AbortController(); const playing = f.audio.play(new Blob(['fake MP3']), operation.signal); await settle();
  operation.abort(); f.audio.close(); decoded.resolve({}); await assert.rejects(playing, { name: 'AbortError' });
  assert.equal(f.contexts[0].nodes.length, 1, 'only the tap unlock source existed');
});

test('unavailable system speech visibly fails instead of silently listening over a missing answer', async t => {
  const f = browserFixture(t); await f.audio.unlock();
  await assert.rejects(f.audio.play({ text: 'The reply', fallback: 'system' }, new AbortController().signal), /Spoken replies are unavailable/);
  f.audio.close();
});

test('permission denial has actionable recovery and audio interruptions notify the controller', async t => {
  const f = browserFixture(t, async () => { throw new DOMException('denied', 'NotAllowedError'); }); await f.audio.unlock();
  await assert.rejects(f.audio.listen(() => undefined, new AbortController().signal), /Allow microphone access.*Talk to Clem/);
  f.contexts[0].state = 'interrupted'; f.contexts[0].onstatechange!();
  assert.match((f.errors[0] as Error).message, /Audio was interrupted/); f.audio.close();
});

test('audio startup is bounded and late resume rejection after a graph error is observed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred<void>();
  const f = browserFixture(t, undefined, context => { context.resumeResult = pending.promise; });
  const startup = f.audio.unlock(); const failed = assert.rejects(startup, /Audio did not start/);
  t.mock.timers.tick(8_001); await failed; f.audio.close();
  pending.reject(new Error('Late platform rejection')); await settle();
  const late = deferred<void>();
  const g = browserFixture(t, undefined, context => { context.resumeResult = late.promise; context.failBufferSource = true; });
  await assert.rejects(g.audio.unlock(), /Output graph failed/); late.reject(new Error('Late rejection after graph failed')); await settle();
  g.audio.close();
});

class FakeUtterance {
  onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}
function systemSpeechFixture(t: TestContext) {
  const f = browserFixture(t); let utterance: FakeUtterance | null = null; let cancelled = 0;
  Object.assign(window, { SpeechSynthesisUtterance: FakeUtterance, speechSynthesis: {
    speak: (value: FakeUtterance) => { utterance = value; }, cancel: () => { cancelled++; },
  } });
  return { ...f, current: () => utterance!, cancelled: () => cancelled };
}

test('system speech blocked without callbacks fails promptly and stops the platform queue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = systemSpeechFixture(t); await f.audio.unlock();
  const playing = f.audio.play({ text: 'The answer', fallback: 'system' }, new AbortController().signal);
  const failed = assert.rejects(playing, /did not play/); t.mock.timers.tick(5_001); await failed;
  assert.equal(f.cancelled(), 1); f.audio.close();
});

test('started system speech waits for its actual end and abort cancels it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = systemSpeechFixture(t); await f.audio.unlock();
  const playing = f.audio.play({ text: 'The answer', fallback: 'system' }, new AbortController().signal);
  f.current().onstart!(); t.mock.timers.tick(5_001); assert.equal(f.cancelled(), 0);
  f.current().onend!(); await playing;
  const operation = new AbortController(); const stopped = f.audio.play({ text: 'Another answer', fallback: 'system' }, operation.signal);
  const rejected = assert.rejects(stopped, { name: 'AbortError' }); operation.abort(); await rejected;
  assert.equal(f.cancelled(), 1); f.audio.close();
});
