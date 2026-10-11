import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mobile-voice-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(home, 'state'), { recursive: true });
const { createMobileRouter, MOBILE_SESSION_COOKIE } = await import('./mobile-routes.js');
const { setPin } = await import('../runtime/mobile-pin.js');
const eventlog = await import('../runtime/harness/eventlog.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});

test('mobile spoken sends preserve first acceptance across sync, async, and replay without a provider', async () => {
  const stateDir = path.join(home, 'mobile');
  let providerCalls = 0;
  const app = express();
  app.use(express.json());
  app.use('/m', createMobileRouter({ stateDir, isAdminAuthorized: () => false, assistant: {
    respond: async () => { providerCalls += 1; throw new Error('No provider may run in this fixture'); },
  } as never }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await setPin('TestPin1!', { stateDir });
    const login = await fetch(`${url}/m/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!', deviceLabel: 'Voice fixture' }) });
    assert.equal(login.status, 200);
    const raw = login.headers.get('set-cookie') ?? '';
    const cookie = `${MOBILE_SESSION_COOKIE}=${raw.slice(raw.indexOf('=') + 1).split(';')[0]}`;
    const send = async (key: string, body: Record<string, unknown>) => {
      const response = await fetch(`${url}/m/api/chat/send`, { method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'Idempotency-Key': key }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    for (const async of [false, true]) {
      const key = `voice-${async}`;
      const first = await send(key, { message: 'tasks', voice: true, async });
      assert.equal(first.status, async ? 202 : 200, JSON.stringify(first.body));
      const sessionId = String(first.body.sessionId);
      // Async mode acknowledges before completion; wait only for this controlled host command.
      for (let tries = 0; tries < 100 && !eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).length; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const sources = eventlog.listEvents(sessionId, { types: ['user_input_received'] });
      assert.equal(sources.length, 1);
      assert.equal(sources[0].data.voice, true);
      assert.equal(eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
      const replay = await send(key, { message: 'tasks', voice: false, async });
      assert.equal(replay.status, async ? 202 : 200, JSON.stringify(replay.body));
      assert.equal(replay.body.sessionId, sessionId);
      assert.equal(eventlog.listEvents(sessionId, { types: ['user_input_received'] }).length, 1);
      assert.equal(eventlog.listEvents(sessionId, { types: ['user_input_received'] })[0].data.voice, true);
    }
    const typed = await send('typed', { message: 'tasks', voice: 'true' });
    assert.equal(typed.status, 200);
    const sessionId = String(typed.body.sessionId);
    assert.equal(eventlog.listEvents(sessionId, { types: ['user_input_received'] })[0].data.voice, undefined);

    const lease = eventlog.claimRunAttemptLease({ sessionId, runId: 'voice-steer-active', ownerId: 'fixture', leaseMs: 60_000 });
    assert.equal(lease.claimed, true);
    const steering = { message: 'Please keep the answer brief', sessionId, steerOnly: true, voice: true };
    const steer = await send('voice-steer', steering);
    assert.equal(steer.status, 200, JSON.stringify(steer.body));
    assert.equal(steer.body.steered, true);
    const replay = await send('voice-steer', { ...steering, voice: false });
    assert.equal(replay.body.noteSeq, steer.body.noteSeq);
    const notes = eventlog.listEvents(sessionId, { types: ['user_steer_note'] });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].data.voice, true);
    assert.equal(eventlog.listEvents(sessionId, { types: ['user_input_received'] }).length, 1);
    eventlog.finishRunAttempt(lease.attempt, 'completed');
    assert.equal(providerCalls, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
