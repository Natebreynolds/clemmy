/**
 * Run: node scripts/run-tests-isolated.mjs src/channels/mobile-mode-routes.test.ts
 *
 * The phone reads and sets the one approval mode the desktop has, from the
 * same policy file, and sees what Ask mode learned with the same forget.
 * Both verbs sit behind the paired mobile session like every other phone
 * setting; nothing here grants or removes execution authority.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mobile-mode-'));
process.env.CLEMENTINE_HOME = TMP_ROOT;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP_ROOT, 'state'), { recursive: true });
test.after(() => { try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

const { createMobileRouter, MOBILE_SESSION_COOKIE } = await import('./mobile-routes.js');
const { setPin } = await import('../runtime/mobile-pin.js');
const { loadProactivityPolicy } = await import('../agents/proactivity-policy.js');
const scopes = await import('../agents/plan-scope.js');

async function startHarness() {
  const stateDir = path.join(TMP_ROOT, 'case');
  const app = express();
  app.use(express.json());
  app.use('/m', createMobileRouter({ stateDir, isAdminAuthorized: () => false }));
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  await setPin('TestPin1!', { stateDir });
  const login = await fetch(`http://127.0.0.1:${port}/m/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: 'TestPin1!', deviceLabel: 'Mode phone' }),
  });
  assert.equal(login.status, 200);
  const raw = login.headers.get('set-cookie') ?? '';
  const cookie = `${MOBILE_SESSION_COOKIE}=${raw.slice(raw.indexOf('=') + 1).split(';')[0]}`;
  return {
    url: `http://127.0.0.1:${port}`,
    cookie,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('the phone sets the mode in the shared policy and sees what Ask learned', async () => {
  const h = await startHarness();
  const call = (method: string, url: string, body?: unknown) => fetch(`${h.url}${url}`, {
    method, headers: { 'content-type': 'application/json', cookie: h.cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await fetch(`${h.url}/m/api/settings/mode`)).status, 401, 'no session, no read');

    const initial = await (await call('GET', '/m/api/settings/mode')).json() as { mode: string; learned: unknown[] };
    assert.equal(initial.mode, 'auto', 'a fresh home ships in Auto');
    assert.deepEqual(initial.learned, []);

    const bad = await call('PATCH', '/m/api/settings/mode', { mode: 'balanced' });
    assert.equal(bad.status, 400, 'only the two modes exist');

    const asked = await (await call('PATCH', '/m/api/settings/mode', { mode: 'ask' })).json() as { mode: string };
    assert.equal(asked.mode, 'ask');
    assert.equal(loadProactivityPolicy().autoApproveScope, 'strict', 'the desktop reads the same file');

    scopes.recordApprovedWriteKind({ operationId: 'EXAMPLE_CREATE_ROW', accountId: 'account:owner', approvalId: 'apr-1' });
    const learned = await (await call('GET', '/m/api/settings/mode')).json() as { learned: Array<{ operationId: string; accountId: string | null }> };
    assert.deepEqual(learned.learned.map((k) => [k.operationId, k.accountId]), [['EXAMPLE_CREATE_ROW', 'account:owner']]);

    const forgotten = await (await call('DELETE', '/m/api/settings/mode/learned', { operationId: 'EXAMPLE_CREATE_ROW', accountId: 'account:owner' })).json() as { learned: unknown[] };
    assert.deepEqual(forgotten.learned, []);
    assert.equal((await call('DELETE', '/m/api/settings/mode/learned', { operationId: 'EXAMPLE_CREATE_ROW', accountId: 'account:owner' })).status, 404);

    const back = await (await call('PATCH', '/m/api/settings/mode', { mode: 'auto' })).json() as { mode: string };
    assert.equal(back.mode, 'auto');
    assert.equal(loadProactivityPolicy().autoApproveScope, 'yolo');
  } finally {
    await h.close();
  }
});
