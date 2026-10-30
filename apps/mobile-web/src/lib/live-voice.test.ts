import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneLiveVoice, type PhoneLiveVoiceDependencies } from './live-voice.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

function fixture() {
  const channel = new EventTarget() as EventTarget & { readyState: string; send(value: string): void; close(): void };
  channel.readyState = 'open'; channel.send = () => {}; channel.close = () => { channel.readyState = 'closed'; };
  let stopped = 0; let requests = 0; let remote = 0; let requestSignal: AbortSignal | undefined;
  const track = { enabled: true, stop: () => { stopped++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const peer = Object.assign(new EventTarget(), {
    iceGatheringState: 'complete', connectionState: 'connected', localDescription: { sdp: 'fixture-offer' },
    addTrack() {}, createDataChannel: () => channel,
    createOffer: async () => ({ type: 'offer', sdp: 'fixture-offer' }),
    setLocalDescription: async () => {}, setRemoteDescription: async () => { remote++; }, close() {},
  }) as unknown as RTCPeerConnection;
  const audio = { autoplay: false, setAttribute() {}, pause() {}, srcObject: null } as unknown as HTMLAudioElement;
  const mic = deferred<MediaStream>(); const answer = deferred<{ sessionId: string; sdp: string }>();
  const deps: PhoneLiveVoiceDependencies = {
    createPeer: () => peer, createAudio: () => audio, microphone: () => mic.promise,
    createSession: async (_body, signal) => { requests++; requestSignal = signal; return answer.promise; },
  };
  const link = new PhoneLiveVoice({ onLive() {}, onRequest() {}, onSpeaking() {}, onHearing() {}, onClosed() {}, onError() {} }, deps);
  return { link, mic, stream, answer, channel, stats: () => ({ stopped, requests, remote, requestAborted: requestSignal?.aborted }) };
}

test('ending voice before permission resolves stops late microphone and never creates a session', async () => {
  const f = fixture(); const start = f.link.start([]);
  f.link.close(); f.mic.resolve(f.stream);
  await start;
  assert.equal(f.stats().stopped, 1);
  assert.equal(f.stats().requests, 0);
  assert.equal(f.stats().remote, 0);
});

test('ending a connecting voice session aborts negotiation and ignores its late answer', async () => {
  const f = fixture(); const start = f.link.start([]); f.mic.resolve(f.stream);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.stats().requests, 1);
  f.channel.readyState = 'connecting'; f.link.close();
  assert.equal(f.stats().requestAborted, true);
  f.answer.resolve({ sessionId: 'fixture-session', sdp: 'fixture-answer' });
  await start;
  assert.equal(f.stats().remote, 0);
  assert.equal(f.stats().stopped, 1);
});
