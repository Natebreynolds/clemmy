import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { HoldToTalk } from './hold-to-talk';
import { bindDictationForegroundCancellation } from './dictation-support';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeAudio(t: TestContext, options: { permission?: () => Promise<MediaStream>; resume?: () => Promise<void>; setupError?: Error } = {}) {
  const calls: string[] = [];
  let stops = 0;
  const stream = { getTracks: () => [{ stop: () => { stops++; } }] } as unknown as MediaStream;
  const contexts: FakeContext[] = [];
  class FakeContext {
    state = 'running';
    sampleRate = 16_000;
    destination = {};
    closed = 0;
    processor = { onaudioprocess: null as ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null, connect() {}, disconnect() {} };
    constructor() { calls.push('context'); contexts.push(this); }
    resume() { calls.push('resume'); return options.resume?.() ?? Promise.resolve(); }
    close() { this.closed++; this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { if (options.setupError) throw options.setupError; return { connect() {} }; }
    createScriptProcessor() { return this.processor; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    emit(seconds = 0.5) { this.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(Math.floor(seconds * 16_000)).fill(0.2) } }); }
  }
  for (const [key, value] of Object.entries({ window: { AudioContext: FakeContext }, navigator: { mediaDevices: { getUserMedia: () => { calls.push('permission'); return options.permission?.() ?? Promise.resolve(stream); } } } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); });
  }
  return { calls, stream, contexts, stops: () => stops };
}

test('tap capture unlocks audio before awaiting permission, then stops tracks before transcription', async t => {
  const permission = deferred<MediaStream>();
  const audio = fakeAudio(t, { permission: () => permission.promise });
  let transcribed = 0;
  const capture = new HoldToTalk(async wav => {
    transcribed++;
    assert.equal(audio.stops(), 1);
    assert.equal(audio.contexts[0].closed, 1);
    assert.equal(wav.type, 'audio/wav');
    assert.ok(wav.size > 15_000);
    return { text: '  My spoken words  ', engine: 'local' };
  });
  const starting = capture.start();
  assert.deepEqual(audio.calls, ['context', 'resume', 'permission']);
  assert.equal(transcribed, 0);
  permission.resolve(audio.stream);
  assert.equal(await starting, true);
  audio.contexts[0].emit();
  assert.equal(await capture.stop(), 'My spoken words');
  assert.equal(transcribed, 1);
});

test('permission rejection and audio setup failure release all resources', async t => {
  await t.test('permission', async t => {
    const denied = new DOMException('Denied', 'NotAllowedError');
    const audio = fakeAudio(t, { permission: async () => { throw denied; } });
    await assert.rejects(new HoldToTalk().start(), error => error === denied);
    assert.equal(audio.contexts[0].closed, 1);
  });
  for (const failure of ['resume', 'setup']) await t.test(failure, async t => {
    const error = new Error(`${failure} failed`);
    const audio = fakeAudio(t, failure === 'resume' ? { resume: async () => { throw error; } } : { setupError: error });
    await assert.rejects(new HoldToTalk().start(), candidate => candidate === error);
    assert.equal(audio.stops(), 1);
    assert.equal(audio.contexts[0].closed, 1);
  });
});

test('cancel while permission is pending closes audio immediately and stops a late stream', async t => {
  const permission = deferred<MediaStream>();
  const audio = fakeAudio(t, { permission: () => permission.promise });
  const capture = new HoldToTalk();
  const starting = capture.start();
  capture.cancel();
  assert.equal(audio.contexts[0].closed, 1);
  permission.resolve(audio.stream);
  assert.equal(await starting, false);
  assert.equal(audio.stops(), 1);
  assert.equal(audio.contexts[0].processor.onaudioprocess, null);
});

test('a cancelled audio resume cannot tear down a later recording', async t => {
  const resume = deferred<void>();
  let resumes = 0;
  const audio = fakeAudio(t, { resume: () => ++resumes === 1 ? resume.promise : Promise.resolve() });
  const capture = new HoldToTalk(async () => ({ text: 'New recording', engine: 'local' }));
  const oldStart = capture.start();
  await Promise.resolve();
  capture.cancel();
  assert.equal(await capture.start(), true);
  resume.resolve();
  assert.equal(await oldStart, false);
  assert.equal(audio.contexts[1].closed, 0);
  audio.contexts[1].emit();
  assert.equal(await capture.stop(), 'New recording');
});

test('short capture and empty transcription are explained instead of silently discarding a tap', async t => {
  const audio = fakeAudio(t);
  let transcribed = 0;
  const capture = new HoldToTalk(async () => { transcribed++; return { text: '', engine: 'local' }; });
  await capture.start();
  await assert.rejects(capture.stop(), /too short/);
  assert.equal(transcribed, 0);
  await capture.start();
  audio.contexts[1].emit();
  await assert.rejects(capture.stop(), /No speech was heard/);
  assert.equal(transcribed, 1);
});

test('cancel after Finish suppresses a delayed transcript and preserves the next capture', async t => {
  const transcription = deferred<{ text: string; engine: 'local' }>();
  const audio = fakeAudio(t);
  const signals: AbortSignal[] = [];
  const capture = new HoldToTalk((_wav, signal) => { signals.push(signal!); return transcription.promise; });
  await capture.start();
  audio.contexts[0].emit();
  const words = capture.stop();
  capture.cancel();
  assert.equal(signals[0].aborted, true);
  assert.equal(await capture.start(), true);
  transcription.resolve({ text: 'Old transcript', engine: 'local' });
  assert.equal(await words, '');
  assert.equal(audio.contexts[1].closed, 0);
  capture.cancel();
});

test('foreground lifecycle cancellation stops late permission, active tracks and delayed transcription without restart', async t => {
  for (const stage of ['permission', 'recording', 'transcribing']) await t.test(stage, async t => {
    const permission = deferred<MediaStream>();
    const transcription = deferred<{ text: string; engine: 'local' }>();
    const audio = fakeAudio(t, stage === 'permission' ? { permission: () => permission.promise } : {});
    const signals: AbortSignal[] = [];
    const capture = new HoldToTalk((_wav, signal) => { signals.push(signal!); return transcription.promise; });
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const page = new EventTarget();
    const unbind = bindDictationForegroundCancellation(document, page, () => capture.cancel());
    t.after(unbind);
    const starting = capture.start();
    if (stage !== 'permission') assert.equal(await starting, true);
    if (stage === 'transcribing') audio.contexts[0].emit();
    const words = stage === 'transcribing' ? capture.stop() : null;
    if (stage === 'recording') page.dispatchEvent(new Event('pagehide'));
    else { document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); }
    assert.equal(audio.contexts[0].closed, 1);
    if (stage === 'permission') {
      permission.resolve(audio.stream);
      assert.equal(await starting, false);
    }
    assert.equal(audio.stops(), 1);
    if (words) {
      assert.equal(signals[0].aborted, true);
      transcription.resolve({ text: 'Words received after background', engine: 'local' });
      assert.equal(await words, '');
    }
    document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
    page.dispatchEvent(new Event('pageshow'));
    assert.equal(audio.contexts.length, 1, 'foregrounding never starts recording again');
    assert.equal(audio.contexts[0].processor.onaudioprocess, null);
  });
});
