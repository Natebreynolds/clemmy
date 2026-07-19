import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { NotchVoice, type NotchVoiceStatus } from './notch-voice';

const originalFetch = globalThis.fetch;
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

before(() => {
  // Keep getAuthToken on its bootstrap path in Node, where Vite's import.meta.env
  // object is intentionally absent.
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __CLEM_BOOTSTRAP__: { token: 'voice-test', version: '', flags: {} } },
  });
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalWindowDescriptor) Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  else Reflect.deleteProperty(globalThis, 'window');
});

function seedPcm(voice: NotchVoice): void {
  (voice as unknown as { pcm: ArrayBuffer[] }).pcm = [Uint8Array.from([1, 0]).buffer];
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('stopAndSend is one-shot and shares one request across duplicate Send calls', async () => {
  const paths: string[] = [];
  const signals: AbortSignal[] = [];
  globalThis.fetch = async (input, init) => {
    paths.push(String(input));
    assert.ok(init?.signal, 'voice requests should always be abortable');
    signals.push(init.signal);
    if (paths.length === 1) return jsonResponse({ text: 'open my pipeline' });
    return new Response([
      JSON.stringify({ type: 'status', text: 'Checking pipeline…' }),
      JSON.stringify({ type: 'done', text: 'Your pipeline is open.', stoppedReason: 'success' }),
      '',
    ].join('\n'));
  };

  const statuses: NotchVoiceStatus[] = [];
  const userText: string[] = [];
  const assistantText: string[] = [];
  const voice = new NotchVoice({
    onStatus: (status) => statuses.push(status),
    onUserText: (text) => userText.push(text),
    onAssistantText: (text) => assistantText.push(text),
  });
  seedPcm(voice);

  const first = voice.stopAndSend();
  const duplicate = voice.stopAndSend();
  assert.equal(duplicate, first, 'duplicate Send should join the original operation');
  await first;
  assert.equal(voice.stopAndSend(), first, 'Send remains one-shot after completion');

  assert.deepEqual(paths, [
    '/api/console/voice/transcribe?token=voice-test',
    '/api/console/home/chat/stream?token=voice-test',
  ]);
  assert.equal(signals[0], signals[1], 'transcription and chat share one cancellation scope');
  assert.deepEqual(userText, ['open my pipeline']);
  assert.deepEqual(assistantText, ['Your pipeline is open.']);
  assert.deepEqual(statuses, ['transcribing', 'thinking', 'thinking', 'done']);
});

test('cancel aborts an in-flight voice request without surfacing a stale error', async () => {
  let requestSignal: AbortSignal | undefined;
  let markFetchStarted: (() => void) | undefined;
  const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
  globalThis.fetch = async (_input, init) => {
    requestSignal = init?.signal ?? undefined;
    markFetchStarted?.();
    return await new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    });
  };

  const statuses: NotchVoiceStatus[] = [];
  const voice = new NotchVoice({ onStatus: (status) => statuses.push(status) });
  seedPcm(voice);
  const send = voice.stopAndSend();
  await fetchStarted;
  voice.cancel();

  await assert.doesNotReject(send);
  assert.equal(requestSignal?.aborted, true);
  assert.deepEqual(statuses, ['transcribing']);
});

test('a transport that ignores abort still cannot publish a late transcription', async () => {
  let resolveTranscription: ((response: Response) => void) | undefined;
  let markFetchStarted: (() => void) | undefined;
  const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    markFetchStarted?.();
    return await new Promise<Response>((resolve) => { resolveTranscription = resolve; });
  };

  const userText: string[] = [];
  const statuses: NotchVoiceStatus[] = [];
  const voice = new NotchVoice({
    onStatus: (status) => statuses.push(status),
    onUserText: (text) => userText.push(text),
  });
  seedPcm(voice);
  const send = voice.stopAndSend();
  await fetchStarted;
  voice.cancel();
  resolveTranscription?.(jsonResponse({ text: 'late stale transcript' }));

  await assert.doesNotReject(send);
  assert.equal(fetchCount, 1, 'a cancelled transcription must never start chat');
  assert.deepEqual(userText, []);
  assert.deepEqual(statuses, ['transcribing']);
});
