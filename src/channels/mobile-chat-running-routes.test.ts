/**
 * Run: node scripts/run-tests-isolated.mjs src/channels/mobile-chat-running-routes.test.ts
 *
 * The phone's conversation list says which conversations have work in flight
 * right now, so a reply that keeps going after the owner leaves the thread is
 * still visible as running from the menu and the list. The signal is the
 * run attempt the engine itself keeps open while it works.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mobile-running-'));
process.env.CLEMENTINE_HOME = TMP_ROOT;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP_ROOT, 'state'), { recursive: true });

const { createMobileRouter, MOBILE_SESSION_COOKIE } = await import('./mobile-routes.js');
const { setPin } = await import('../runtime/mobile-pin.js');
const eventlog = await import('../runtime/harness/eventlog.js');

test.after(() => {
  eventlog.closeEventLog();
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('the phone list marks a conversation running while its run is in flight, and only then', async () => {
  const stateDir = path.join(TMP_ROOT, 'case');
  const app = express();
  app.use(express.json());
  app.use('/m', createMobileRouter({ stateDir, isAdminAuthorized: () => false }));
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await setPin('TestPin1!', { stateDir });
    const login = await fetch(`${url}/m/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!', deviceLabel: 'Running phone' }),
    });
    assert.equal(login.status, 200);
    const raw = login.headers.get('set-cookie') ?? '';
    const cookie = `${MOBILE_SESSION_COOKIE}=${raw.slice(raw.indexOf('=') + 1).split(';')[0]}`;
    const list = async () => (await (await fetch(`${url}/m/api/chat/sessions`, { headers: { cookie } })).json()) as {
      sessions: Array<{ id: string; running: boolean }>;
    };

    const busy = eventlog.createSession({ kind: 'chat', title: 'Fixture still working' });
    const quiet = eventlog.createSession({ kind: 'chat', title: 'Fixture finished' });
    const attempt = eventlog.beginRunAttempt(busy.id, { runId: 'fixture-running-reply' });
    const done = eventlog.beginRunAttempt(quiet.id, { runId: 'fixture-finished-reply' });
    eventlog.finishRunAttempt(done, 'completed');

    const during = await list();
    assert.equal(during.sessions.find((s) => s.id === busy.id)?.running, true);
    assert.equal(during.sessions.find((s) => s.id === quiet.id)?.running, false);

    eventlog.finishRunAttempt(attempt, 'completed');
    const after = await list();
    assert.equal(after.sessions.find((s) => s.id === busy.id)?.running, false, 'the mark ends when the work does');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
