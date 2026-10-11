import test from 'node:test';
import assert from 'node:assert/strict';
import { speakVoice, transcribeVoice, sendChatMessageAsync, setSessionFingerprint } from './api.js';

test('voice requests retain the mobile API transport and abort signal', async t => {
  setSessionFingerprint(null);
  const calls: Array<{ path: string; options: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (path: string, options: RequestInit) => {
    calls.push({ path, options });
    return path.endsWith('/speak') ? new Response('audio', { headers: { 'content-type': 'audio/mpeg' } })
      : Response.json(path.endsWith('/send') ? { accepted: true, sessionId: 'synthetic-voice' } : { text: 'Hello', engine: 'local' });
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await transcribeVoice(new Blob(['synthetic']), signal), { text: 'Hello', engine: 'local' });
  assert.equal(await (await speakVoice('Hello', signal) as Blob).text(), 'audio');
  await sendChatMessageAsync({ message: 'Hello', idempotencyKey: 'synthetic-voice', voice: true });
  assert.deepEqual(calls.map(call => call.path), ['/m/api/chat/transcribe', '/m/api/chat/speak', '/m/api/chat/send']);
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[1].options.signal, signal);
  assert.ok(calls.every(call => call.options.credentials === 'same-origin'));
  assert.equal(JSON.parse(calls[2].options.body as string).voice, true);
});

test('transcription displays the route recovery message while preserving error identity', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'TRANSCRIPTION_STOPPED', message: 'Wait for cleanup, then try again.' }, { status: 409 }));
  await assert.rejects(transcribeVoice(new Blob()), (error: unknown) => {
    assert.equal((error as Error).message, 'Wait for cleanup, then try again.');
    assert.equal((error as { status: number }).status, 409);
    return true;
  });
});

test('only an explicit speech fallback can select the device voice', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'No speech key', fallback: 'system', text: 'Hello.' }, { status: 409 }));
  assert.deepEqual(await speakVoice('**Hello.**'), { fallback: 'system', text: 'Hello.' });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Speech service unavailable' }, { status: 502 }));
  await assert.rejects(speakVoice('Hello.'), /Speech service unavailable/);
});
