import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSpeaker } from './voice-speaker.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const response = (blob: () => Promise<Blob>, body: ReadableStream<Uint8Array> | null = null) => ({ ok: true, body, blob }) as Response;

class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  paused = false;
  played = false;
  playResult = Promise.resolve();
  play() { this.played = true; return this.playResult; }
  pause() { this.paused = true; }
  removeAttribute() {}
  load() {}
}
function fixture(t: TestContext, fetchResponse: typeof fetch, setupAudio?: (audio: FakeAudio, index: number) => void) {
  const audio: FakeAudio[] = []; const revoked: string[] = [];
  const replace = (name: string, value: unknown) => {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (before) Object.defineProperty(globalThis, name, before); else Reflect.deleteProperty(globalThis, name); });
  };
  // Synthetic bootstrap data avoids browser bundler env access in Node. There
  // is no real authentication or provider call: every request is mocked below.
  replace('window', { __CLEM_BOOTSTRAP__: { token: 'isolated-voice-test' } });
  replace('Audio', class extends FakeAudio { constructor() { super(); setupAudio?.(this, audio.length); audio.push(this); } });
  replace('MediaSource', undefined);
  t.mock.method(globalThis, 'fetch', fetchResponse);
  let urls = 0;
  t.mock.method(URL, 'createObjectURL', () => `blob:isolated-voice-${++urls}`);
  t.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); });
  const errors: string[] = [];
  const speaker = new VoiceSpeaker({ onError: message => { errors.push(message); } });
  t.after(() => speaker.stop());
  return { speaker, audio, errors, revoked, replace };
}

test('withdrawal during a delayed audio body cannot start obsolete audio or release replacement playback', async t => {
  const oldBody = deferred<Blob>(); let requests = 0;
  const f = fixture(t, async () => response(() => ++requests === 1 ? oldBody.promise : Promise.resolve(new Blob(['corrected audio']))));
  f.speaker.say('The provisional progress.'); await settle();
  assert.equal(f.audio.length, 0);
  f.speaker.stop();
  f.speaker.say('The corrected terminal answer.'); await settle();
  assert.equal(f.audio.length, 1);
  const replacement = f.audio[0];
  oldBody.resolve(new Blob(['obsolete audio'])); await settle();
  assert.equal(f.audio.length, 1, 'the old body cannot start a second audio element');
  assert.equal(replacement.paused, false, 'the old callback cannot release current playback');
  assert.equal(f.speaker.speaking, true);
  assert.deepEqual(f.errors, []);
  replacement.onended!(); await settle();
  assert.equal(f.speaker.speaking, false);
});

test('late play rejection cannot erase the replacement stop callback or strand its speech drain', async t => {
  const latePlay = deferred<void>();
  const f = fixture(t, async () => response(async () => new Blob(['controlled audio'])), (audio, index) => {
    if (index === 0) audio.playResult = latePlay.promise;
  });
  // The public say() intentionally returns void. Observe completion of its
  // existing drain boundary to verify that Stop settles the actual lifecycle,
  // rather than merely changing the visible speaking flag.
  const lifecycle = f.speaker as unknown as { drain: (generation: number) => Promise<void> };
  const originalDrain = lifecycle.drain.bind(f.speaker);
  const settled: boolean[] = [];
  t.mock.method(lifecycle, 'drain', (generation: number) => {
    const index = settled.push(false) - 1;
    return originalDrain(generation).finally(() => { settled[index] = true; });
  });
  f.speaker.say('The previous progress.'); await settle();
  f.speaker.stop(); await settle();
  assert.deepEqual(settled, [true]);
  f.speaker.say('The corrected terminal answer.'); await settle();
  latePlay.reject(new Error('Late old audio rejection')); await settle();
  assert.equal(f.audio[1].paused, false);
  assert.deepEqual(settled, [true, false]);
  f.speaker.stop(); await settle();
  assert.equal(f.audio[1].paused, true);
  assert.deepEqual(settled, [true, true], 'replacement Stop must settle its own pending playback and drain');
  assert.deepEqual(f.errors, []);
});

test('a stopped request ignores late response headers and releases its unused body', async t => {
  const headers = deferred<Response>(); const signals: AbortSignal[] = []; let requests = 0; let cancelled = 0;
  const f = fixture(t, async (_url, options) => {
    signals.push(options?.signal as AbortSignal);
    return ++requests === 1 ? headers.promise : response(async () => new Blob(['corrected audio']));
  });
  f.speaker.say('The previous answer.'); await settle();
  f.speaker.stop(); assert.equal(signals[0].aborted, true);
  f.speaker.say('The current answer.'); await settle();
  const body = { cancel: async () => { cancelled++; } } as unknown as ReadableStream<Uint8Array>;
  headers.resolve(response(async () => new Blob(['obsolete audio']), body)); await settle();
  assert.equal(cancelled, 1);
  assert.equal(f.audio.length, 1);
  assert.equal(f.audio[0].paused, false);
  assert.deepEqual(f.errors, []);
  f.audio[0].onended!(); await settle();
});

test('stream bytes arriving after withdrawal are cancelled without appending to the old audio graph', async t => {
  const read = deferred<ReadableStreamReadResult<Uint8Array>>(); let cancelled = 0;
  const reader = { read: () => read.promise, cancel: async () => { cancelled++; } };
  const body = { getReader: () => reader, cancel: async () => { cancelled++; } } as unknown as ReadableStream<Uint8Array>;
  let requests = 0;
  const f = fixture(t, async () => ++requests === 1
    ? response(async () => new Blob(), body)
    : response(async () => new Blob(['corrected audio'])));
  const sources: FakeMediaSource[] = [];
  class FakeMediaSource extends EventTarget {
    static isTypeSupported() { return true; }
    readyState = 'open';
    appended: Uint8Array[] = [];
    ended = 0;
    constructor() { super(); sources.push(this); }
    addSourceBuffer() {
      return Object.assign(new EventTarget(), { appendBuffer: (value: Uint8Array) => { this.appended.push(value); } });
    }
    endOfStream() { this.ended++; }
  }
  f.replace('MediaSource', FakeMediaSource);
  f.speaker.say('The previous progress.'); await settle();
  sources[0].dispatchEvent(new Event('sourceopen')); await settle();
  f.speaker.stop();
  f.speaker.say('The corrected terminal answer.'); await settle();
  const replacement = f.audio[1];
  read.resolve({ done: false, value: new Uint8Array([1, 2, 3]) }); await settle();
  assert.equal(cancelled, 1);
  assert.deepEqual(sources[0].appended, []);
  assert.equal(sources[0].ended, 0);
  assert.equal(replacement.paused, false);
  assert.deepEqual(f.errors, []);
  replacement.onended!(); await settle();
});

test('a late stream-open event cannot create buffers after its speech generation was stopped', async t => {
  let cancelled = 0; let buffers = 0;
  const body = { cancel: async () => { cancelled++; } } as unknown as ReadableStream<Uint8Array>;
  const f = fixture(t, async () => response(async () => new Blob(), body));
  let source!: EventTarget;
  f.replace('MediaSource', class extends EventTarget {
    static isTypeSupported() { return true; }
    constructor() { super(); source = this; }
    addSourceBuffer() { buffers++; assert.fail('obsolete stream cannot create a buffer'); }
  });
  f.speaker.say('The previous progress.'); await settle();
  f.speaker.stop();
  source.dispatchEvent(new Event('sourceopen')); await settle();
  assert.equal(buffers, 0);
  assert.equal(cancelled, 1);
  assert.deepEqual(f.errors, []);
});
