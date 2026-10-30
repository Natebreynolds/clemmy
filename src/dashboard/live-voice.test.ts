import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const noCredit = (async () => new Response('{"error":{"message":"You have no credits remaining.","type":"insufficient_quota","code":"credit_balance_exhausted"}}', { status: 429 })) as unknown as typeof fetch;
  const outOfCredit = await withKey('sk-synthetic-live', () => live.createLiveVoiceSession({ sdp: offer }, undefined, noCredit));
  assert.ok(!outOfCredit.ok && outOfCredit.code === 'LIVE_VOICE_NO_CREDIT' && /out of credit/.test(outOfCredit.error));
  const busy = await withKey('sk-synthetic-live', () => live.createLiveVoiceSession({ sdp: offer }, undefined, answering(429)));
  assert.ok(!busy.ok && busy.code === 'LIVE_VOICE_BUSY');
  const failed = await withKey('sk-synthetic-live', () => live.createLiveVoiceSession({ sdp: offer }, undefined, answering(500)));
  assert.ok(!failed.ok && failed.code === 'LIVE_VOICE_FAILED' && failed.status === 502);
  const empty = (async () => new Response('{}', { status: 201 })) as unknown as typeof fetch;
  const incomplete = await withKey('sk-synthetic-live', () => live.createLiveVoiceSession({ sdp: offer }, undefined, empty));
  assert.ok(!incomplete.ok && incomplete.code === 'LIVE_VOICE_FAILED');
});

test('a saved key that cannot be read safely is an answer, never an exception', async () => {
  const refused: import('./live-voice.js').LiveVoiceConfigReader = {
    openAiKey: () => { throw new Error('Credential storage privacy or integrity could not be verified'); },
    env: (_key, fallback) => fallback,
  };
  const never = (async () => { throw new Error('must not call the service'); }) as unknown as typeof fetch;
  const result = await live.createLiveVoiceSession({ sdp: offer }, undefined, never, refused);
  assert.ok(!result.ok && result.code === 'LIVE_VOICE_KEY_UNREADABLE' && result.status === 503);
  assert.deepEqual(live.liveVoiceStatus(refused), { available: false, reason: live.VOICE_KEY_WORDS.key_unreadable });
});

test('a refused saved key makes live voice unavailable, with the reason, until the key changes or works again', async () => {
  // Live 2026-10-27: the saved key had been refused (401) for speech and for
  // live voice, and the status still said available; the mic would start and
  // then fail.
  live._resetSavedOpenAiKeyMemoryForTests();
  const key = { openAiKey: () => 'sk-synthetic-live', env: (_k: string, f: string) => f };
  const other = { openAiKey: () => 'sk-synthetic-other', env: (_k: string, f: string) => f };
  assert.deepEqual(live.liveVoiceStatus(key), { available: true });
  const answering = (status: number) => (async () => new Response('{"error":{"message":"nope"}}', { status })) as unknown as typeof fetch;
  const refused = await live.createLiveVoiceSession({ sdp: offer }, undefined, answering(401), key);
  assert.ok(!refused.ok && refused.code === 'LIVE_VOICE_KEY_REFUSED');
  assert.deepEqual(live.liveVoiceStatus(key), { available: false, reason: live.VOICE_KEY_WORDS.key_refused });
  assert.deepEqual(live.liveVoiceStatus(other), { available: true }, 'a different saved key is judged on its own');
  const ok = (async () => new Response(JSON.stringify({ session: { id: 'live_ok' }, transport: { type: 'webrtc', sdp: 'answer' } }), { status: 201 })) as unknown as typeof fetch;
  assert.equal((await live.createLiveVoiceSession({ sdp: offer }, undefined, ok, key)).ok, true);
  assert.deepEqual(live.liveVoiceStatus(key), { available: true }, 'a later success with the same key clears the refusal');
  live.noteSavedOpenAiKeyOutcome('sk-synthetic-live', { reason: 'The saved OpenAI key was refused for speech. Save a working key in Settings.' });
  assert.equal(live.liveVoiceStatus(key).available, false, 'a speech refusal of the same key counts too');
  live._resetSavedOpenAiKeyMemoryForTests();
});

test('a refused saved key is still known after a restart, and a later success forgets it', () => {
  // Live 2026-10-30: the refusal was held only in memory, so every restart
  // said live voice was available again and the phone's next session failed.
  live._resetSavedOpenAiKeyMemoryForTests();
  const key = { openAiKey: () => 'sk-synthetic-restart', env: (_k: string, f: string) => f };
  live.noteSavedOpenAiKeyOutcome('sk-synthetic-restart', { reason: live.VOICE_KEY_WORDS.key_refused });
  live._forgetSavedOpenAiKeyMemoryForTests();
  assert.deepEqual(live.liveVoiceStatus(key), { available: false, reason: live.VOICE_KEY_WORDS.key_refused });
  const stored = readFileSync(path.join(home, 'state', 'voice-key-refusal.json'), 'utf8');
  assert.equal(stored.includes('sk-synthetic-restart'), false, 'only the key\'s digest is kept, never the key');
  live.noteSavedOpenAiKeyOutcome('sk-synthetic-restart', null);
  live._forgetSavedOpenAiKeyMemoryForTests();
  assert.deepEqual(live.liveVoiceStatus(key), { available: true });
  live._resetSavedOpenAiKeyMemoryForTests();
});

test('a session that throws answers 500 and the server keeps serving', async () => {
  const app = express();
  registerConsoleRoutes(app, req => req.get('authorization') === bearer, {} as never, {
    serveLegacyAtRoot: false,
    liveVoiceRuntime: { status: () => ({ available: true }), createSession: async () => { throw new Error('vault refused'); } },
  });
  const server = await new Promise<Server>(resolve => { const listener = createServer(app); listener.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const post = () => fetch(`${base}/api/console/voice/live-session`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: bearer }, body: JSON.stringify({ sdp: offer }),
    });
    const first = await post();
    assert.equal(first.status, 500);
    assert.equal((await first.json() as { code: string }).code, 'LIVE_VOICE_FAILED');
    assert.equal((await post()).status, 500, 'still serving');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
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
