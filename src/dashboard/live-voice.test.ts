import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-live-voice-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.MARKITDOWN_WARM = 'off';
delete process.env.OPENAI_LIVE_MODEL;
delete process.env.OPENAI_LIVE_VOICE;
delete process.env.OPENAI_TTS_VOICE;

const { registerConsoleRoutes } = await import('./console-routes.js');
const live = await import('./live-voice.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');
const { closeMemoryDb } = await import('../memory/db.js');
const bearer = 'Bearer synthetic-live-voice';
const offer = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n';

test.after(() => { closeEventLog(); closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });

function withKey<T>(key: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = process.env.OPENAI_API_KEY;
  if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
  return run().finally(() => { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; });
}

test('the voice hands every request to Clem and keeps the prompt sections the service expects', () => {
  const instructions = live.liveVoiceInstructions();
  for (const heading of ['Backchannel policy:', 'Interruption policy:', 'Delegation policy:', 'Backend tools:',
    'Delegate to the backend when:', 'Do not delegate to the backend when:']) {
    assert.ok(instructions.includes(heading), heading);
  }
  assert.match(instructions, /Delegate before giving an answer that depends on backend work\.\nDo not guess the result while waiting\./);
  assert.match(instructions, /approves or declines something Clem prepared/);
  assert.match(instructions, /Never answer a question, state a fact, or say something was done from your own knowledge/);
});

test('recent history keeps the newest messages within the bounds, in order, as owner and Clem messages', () => {
  const history = live.liveVoiceHistory([
    { role: 'user', text: 'oldest' },
    { role: 'system', text: 'never forwarded' },
    { role: 'assistant', text: '  Want me to send it?\n\n' },
    { role: 'user', text: 42 },
    { role: 'user', text: 'yes' },
  ]);
  assert.deepEqual(history.map(item => [item.role, item.content[0].type, item.content[0].text]), [
    ['user', 'input_text', 'oldest'],
    ['assistant', 'output_text', 'Want me to send it?'],
    ['user', 'input_text', 'yes'],
  ]);
  const many = Array.from({ length: 60 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `message ${index}` }));
  const bounded = live.liveVoiceHistory(many);
  assert.equal(bounded.length, live.LIVE_HISTORY_MAX_MESSAGES);
  assert.equal(bounded.at(-1)!.content[0].text, 'message 59');
  const long = Array.from({ length: 20 }, () => ({ role: 'user', text: 'x'.repeat(1_400) }));
  const total = live.liveVoiceHistory(long).reduce((sum, item) => sum + item.content[0].text.length, 0);
  assert.ok(total <= live.LIVE_HISTORY_MAX_CHARS);
  assert.deepEqual(live.liveVoiceHistory('not a list'), []);
});

test('the offer is exchanged with client delegation, the voice and the history; the key stays in the header', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ session: { id: 'live_synthetic' }, transport: { type: 'webrtc', sdp: 'answer-sdp' } }), { status: 201 });
  }) as unknown as typeof fetch;
  const result = await withKey('sk-synthetic-live', () => live.createLiveVoiceSession(
    { sdp: offer, history: [{ role: 'assistant', text: 'Send the draft to the team?' }] }, undefined, fetchImpl));
  assert.deepEqual(result, { ok: true, sessionId: 'live_synthetic', sdp: 'answer-sdp' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/live\/sessions$/);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer sk-synthetic-live');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.session.model, 'gpt-live-1');
  assert.deepEqual(body.session.delegation, { type: 'client' });
  assert.deepEqual(body.session.audio, { output: { voice: 'marin' } });
  assert.equal(body.session.instructions, live.liveVoiceInstructions());
  assert.deepEqual(body.session.input, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Send the draft to the team?' }] }]);
  assert.deepEqual(body.transport, { type: 'webrtc', sdp: offer });
  assert.ok(!JSON.stringify(body).includes('sk-synthetic-live'));
});

test('a missing offer, a missing key and service refusals each say what happened', async () => {
  const never = (async () => { throw new Error('must not call the service'); }) as unknown as typeof fetch;
  assert.equal((await withKey('sk-synthetic-live', () => live.createLiveVoiceSession({ sdp: '  ' }, undefined, never))).ok, false);
  const noKey = await withKey(undefined, () => live.createLiveVoiceSession({ sdp: offer }, undefined, never));
  assert.ok(!noKey.ok && noKey.code === 'LIVE_VOICE_NEEDS_KEY');
  const answering = (status: number) => (async () => new Response('{"error":{"message":"nope"}}', { status })) as unknown as typeof fetch;
  const refused = await withKey('sk-synthetic-live', () => live.createLiveVoiceSession({ sdp: offer }, undefined, answering(401)));
  assert.ok(!refused.ok && refused.code === 'LIVE_VOICE_KEY_REFUSED');
  const unavailable = await withKey('sk-synthetic-live', () => live.createLiveVoiceSession({ sdp: offer }, undefined, answering(404)));
  assert.ok(!unavailable.ok && unavailable.code === 'LIVE_VOICE_UNAVAILABLE');
  const failed = await withKey('sk-synthetic-live', () => live.createLiveVoiceSession({ sdp: offer }, undefined, answering(500)));
  assert.ok(!failed.ok && failed.code === 'LIVE_VOICE_FAILED' && failed.status === 502);
  const empty = (async () => new Response('{}', { status: 201 })) as unknown as typeof fetch;
  const incomplete = await withKey('sk-synthetic-live', () => live.createLiveVoiceSession({ sdp: offer }, undefined, empty));
  assert.ok(!incomplete.ok && incomplete.code === 'LIVE_VOICE_FAILED');
});

test('the console routes are owner-only and return the session answer', async () => {
  const offers: unknown[] = [];
  const app = express();
  registerConsoleRoutes(app, req => req.get('authorization') === bearer, {} as never, {
    serveLegacyAtRoot: false,
    liveVoiceRuntime: {
      status: () => ({ available: true }),
      createSession: async (input) => { offers.push(input); return { ok: true, sessionId: 'live_route', sdp: 'answer' }; },
    },
  });
  const server = await new Promise<Server>(resolve => { const listener = createServer(app); listener.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/console/voice/live`)).status, 401);
    assert.deepEqual(await (await fetch(`${base}/api/console/voice/live`, { headers: { authorization: bearer } })).json(), { available: true });
    const post = (authorized: boolean) => fetch(`${base}/api/console/voice/live-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorized ? { authorization: bearer } : {}) },
      body: JSON.stringify({ sdp: offer, history: [{ role: 'user', text: 'hi' }] }),
    });
    assert.equal((await post(false)).status, 401);
    assert.equal(offers.length, 0);
    const res = await post(true);
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { sessionId: 'live_route', sdp: 'answer' });
    assert.deepEqual(offers, [{ sdp: offer, history: [{ role: 'user', text: 'hi' }] }]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
