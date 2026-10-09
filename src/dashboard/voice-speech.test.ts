import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-voice-speech-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.MARKITDOWN_WARM = 'off';

const { registerConsoleRoutes } = await import('./console-routes.js');
const { spokenReplyText, SPOKEN_REPLY_MAX_CHARS } = await import('./voice-speech.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');
const { closeMemoryDb } = await import('../memory/db.js');
type SpeechRuntime = { requestSpeech: typeof import('./voice-speech.js').requestSpeech };
const bearer = 'Bearer synthetic-voice-speak';

test.after(() => { closeEventLog(); closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });

async function withRoutes(runtime: SpeechRuntime, run: (speak: (body: unknown, authorized?: boolean) => Promise<Response>) => Promise<void>): Promise<void> {
  const app = express();
  registerConsoleRoutes(app, req => req.get('authorization') === bearer, {} as never, {
    serveLegacyAtRoot: false, voiceSpeechRuntime: runtime,
  });
  const server = await new Promise<Server>(resolve => {
    const listener = createServer(app); listener.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run((body, authorized = true) => fetch(`${base}/api/console/voice/speak`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorized ? { authorization: bearer } : {}) },
      body: JSON.stringify(body) }));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('what is heard: whole sentences without markdown, code or tables, within the bound', () => {
  const reply = [
    '**Done.** I moved the meeting to `Thursday` at 3.',
    '',
    '| Day | Time |',
    '|-----|------|',
    '| Thu | 3 pm |',
    '',
    '```js',
    'console.log("never read")',
    '```',
    'See [the invite](https://example.com/invite) for details.',
  ].join('\n');
  const heard = spokenReplyText(reply);
  assert.equal(heard, 'Done. I moved the meeting to Thursday at 3. See the invite for details.');
  const long = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const bounded = spokenReplyText(long);
  assert.ok(bounded.length <= SPOKEN_REPLY_MAX_CHARS);
  assert.match(bounded, /^Sentence number 0 is here\./);
  assert.match(bounded, /here\.$/, 'a bounded reply stops at a sentence end');
});

test('the speak route streams the speech service audio for the heard text only', async () => {
  const asked: string[] = [];
  await withRoutes({
    requestSpeech: async (text) => {
      asked.push(text);
      return { ok: true, contentType: 'audio/mpeg', response: new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04])) };
    },
  }, async (speak) => {
    assert.equal((await speak({ text: 'Hello.' }, false)).status, 401);
    assert.equal((await speak({ text: '   ' })).status, 400);
    const res = await speak({ text: '**Hi** there. `x`' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0x49, 0x44, 0x33, 0x04]);
    assert.deepEqual(asked, ['Hi there. x']);
  });
});

test('without a usable key the route says so and hands the client the words for its own voice', async () => {
  await withRoutes({
    requestSpeech: async () => ({ ok: false, status: 409, error: 'Voice replies need an OpenAI key; using this computer’s voice.', fallback: 'system' }),
  }, async (speak) => {
    const res = await speak({ text: 'All set.' });
    assert.equal(res.status, 409);
    const body = await res.json() as { fallback?: string; text?: string };
    assert.equal(body.fallback, 'system');
    assert.equal(body.text, 'All set.');
  });
});
