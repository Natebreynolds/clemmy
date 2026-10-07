import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-transcription-stop-routes-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.MARKITDOWN_WARM = 'off';

const { registerConsoleRoutes } = await import('../dashboard/console-routes.js');
const { createMobileRouter, MOBILE_SESSION_COOKIE } = await import('./mobile-routes.js');
const { LocalWhisperRuntimeError } = await import('../integrations/local-meetings/whisper-runtime.js');
const { setPin } = await import('../runtime/mobile-pin.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');
const { closeMemoryDb } = await import('../memory/db.js');
type Runtime = NonNullable<Parameters<typeof createMobileRouter>[0]['voiceTranscriptionRuntime']>;
const bytes = Buffer.alloc(64, 19); // Deliberately not audio: no inference or decoder may run.
const bearer = 'Bearer synthetic-voice-route';
let sequence = 0;

async function assertScratchReleased(target: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (existsSync(target) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(target), false, 'owned uploaded scratch bytes were released');
}

test.after(() => { closeEventLog(); closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });

async function withRoutes(runtime: Runtime, run: (post: (surface: 'desktop' | 'mobile', authorized?: boolean, body?: Buffer) => Promise<Response>) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  const stateDir = path.join(home, `mobile-${++sequence}`);
  registerConsoleRoutes(app, req => req.get('authorization') === bearer, {} as never, {
    serveLegacyAtRoot: false, voiceTranscriptionRuntime: runtime,
  });
  app.use('/m', createMobileRouter({ stateDir, cookieSecure: false, pwaDistDir: null,
    isAdminAuthorized: () => false, voiceTranscriptionRuntime: runtime }));
  const server = await new Promise<Server>(resolve => {
    const listener = createServer(app); listener.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await setPin('SyntheticPin1!', { stateDir });
    const login = await fetch(`${base}/m/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'SyntheticPin1!', deviceLabel: 'Synthetic voice phone' }) });
    assert.equal(login.status, 200);
    const raw = login.headers.get('set-cookie') ?? '';
    const cookie = `${MOBILE_SESSION_COOKIE}=${raw.slice(raw.indexOf('=') + 1).split(';')[0]}`;
    assert.ok(raw.startsWith(`${MOBILE_SESSION_COOKIE}=`));
    await run((surface, authorized = true, body = bytes) => fetch(`${base}${surface === 'desktop'
      ? '/api/console/voice/transcribe' : '/m/api/chat/transcribe'}`, { method: 'POST',
      headers: { 'content-type': 'audio/wav', ...(authorized ? surface === 'desktop' ? { authorization: bearer } : { cookie } : {}) },
      body: new Uint8Array(body) }));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

for (const [code, stopReason, guidance] of [
  ['TRANSCRIPTION_CLEANUP_PENDING', undefined, /Wait for cleanup/],
  ['TRANSCRIPTION_CLEANUP_UNKNOWN', 'timeout', /Close any remaining.*restart Clementine/],
  ['TRANSCRIPTION_CANCELLED', 'cancelled', /Start a new recording/],
  ['TRANSCRIPTION_CANCELLED', 'shutdown', /Start a new recording/],
] as const) test(`both authenticated voice surfaces retain ${code}/${stopReason ?? 'pending'} without cloud fallback or private diagnostics`, async () => {
  const paths: string[] = []; let localCalls = 0; let keyLookups = 0; let cloudCalls = 0;
  await withRoutes({
    transcribeLocal: async ({ audioPath }) => {
      localCalls += 1; paths.push(audioPath); assert.deepEqual(readFileSync(audioPath), bytes);
      throw new LocalWhisperRuntimeError(code, `private synthetic token/path ${audioPath}`, {
        stopReason, cause: new Error('private provider detail') });
    },
    hasCloudKey: () => { keyLookups += 1; return true; },
    transcribeCloud: async () => { cloudCalls += 1; return { ok: true, text: 'must not appear' }; },
  }, async post => {
    for (const surface of ['desktop', 'mobile'] as const) {
      const response = await post(surface);
      assert.equal(response.status, 409);
      const body = await response.json() as { error: string; message?: string; code: string; text?: string; engine?: string };
      assert.equal(body.code, code); assert.equal(body.text, undefined); assert.equal(body.engine, undefined);
      if (surface === 'mobile') assert.equal(body.error, 'TRANSCRIPTION_STOPPED');
      const publicText = body.message ?? body.error;
      assert.match(publicText, guidance); assert.match(publicText, /No cloud transcription was started/);
      assert.doesNotMatch(JSON.stringify(body), /private|must not appear|provider detail/);
      assert.equal(JSON.stringify(body).includes(paths.at(-1)!), false);
      await assertScratchReleased(paths.at(-1)!);
    }
  });
  assert.equal(localCalls, 2); assert.equal(keyLookups, 0); assert.equal(cloudCalls, 0);
});

test('local success returns the existing trimmed local result without checking a cloud account', async () => {
  let calls = 0;
  await withRoutes({ transcribeLocal: async () => ({ text: '  controlled local words  ', model: 'base.en', segments: [] }),
    hasCloudKey: () => { assert.fail('local success must not check a cloud account'); },
    transcribeCloud: async () => { calls += 1; assert.fail('local success must not call the cloud'); },
  }, async post => {
    for (const surface of ['desktop', 'mobile'] as const) {
      const response = await post(surface); assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { text: 'controlled local words', engine: 'local' });
    }
  });
  assert.equal(calls, 0);
});

for (const code of ['CLI_NOT_FOUND', 'TRANSCRIPTION_FAILED'] as const) test(`ordinary ${code} still performs the existing single configured cloud fallback`, async () => {
  let keyLookups = 0; let cloudCalls = 0; const paths: string[] = [];
  await withRoutes({ transcribeLocal: async ({ audioPath }) => { paths.push(audioPath); throw new LocalWhisperRuntimeError(code, 'controlled not ready'); },
    hasCloudKey: () => { keyLookups += 1; return true; },
    transcribeCloud: async audioPath => { assert.equal(audioPath, paths.at(-1)); assert.deepEqual(readFileSync(audioPath), bytes);
      cloudCalls += 1; return { ok: true, text: '  controlled cloud words  ' }; },
  }, async post => {
    for (const surface of ['desktop', 'mobile'] as const) {
      const response = await post(surface); assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { text: 'controlled cloud words', engine: 'openai' });
      await assertScratchReleased(paths.at(-1)!);
    }
  });
  assert.equal(keyLookups, 2); assert.equal(cloudCalls, 2);
});

test('ordinary local failure with no cloud key retains not-ready status without provider dispatch', async () => {
  let keyLookups = 0;
  await withRoutes({ transcribeLocal: async () => { throw new LocalWhisperRuntimeError('TRANSCRIPTION_FAILED', 'controlled unavailable'); },
    hasCloudKey: () => { keyLookups += 1; return false; }, transcribeCloud: async () => { assert.fail('no key means no cloud call'); },
  }, async post => {
    for (const surface of ['desktop', 'mobile'] as const) {
      const response = await post(surface); assert.equal(response.status, 502);
      const body = await response.json() as { error: string; message?: string; code?: string };
      assert.match(body.message ?? body.error, /ready: controlled unavailable/);
      assert.equal(body.code, undefined);
    }
  });
  assert.equal(keyLookups, 2);
});

test('both surfaces reject missing authentication or audio before any transcription dispatch', async () => {
  await withRoutes({ transcribeLocal: async () => { assert.fail('invalid request cannot call local transcription'); },
    hasCloudKey: () => { assert.fail('invalid request cannot inspect cloud credentials'); },
    transcribeCloud: async () => { assert.fail('invalid request cannot call cloud transcription'); },
  }, async post => {
    for (const surface of ['desktop', 'mobile'] as const) {
      assert.equal((await post(surface, false)).status, 401);
      assert.equal((await post(surface, true, Buffer.alloc(0))).status, 400);
    }
  });
});
