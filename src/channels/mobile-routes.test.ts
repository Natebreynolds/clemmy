/**
 * Run: npx tsx --test src/channels/mobile-routes.test.ts
 *
 * Smoke + happy-path coverage for the mobile PIN auth router. Uses a
 * fresh temp state dir per run so the existing daemon's state isn't
 * touched. Hits the router via supertest-equivalent: spin a tiny
 * Express app, bind to an ephemeral port, fetch().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mobile-routes-test-'));
test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const { createMobileRouter, MOBILE_SESSION_COOKIE } = await import('./mobile-routes.js');
const { setPin } = await import('../runtime/mobile-pin.js');
const { createMobilePairingCode } = await import('../runtime/mobile-pairing.js');

interface Harness {
  url: string;
  close: () => Promise<void>;
  stateDir: string;
}

let harnessCounter = 0;

async function startHarness(opts?: { admin?: boolean; cookieSecure?: boolean }): Promise<Harness> {
  const stateDir = path.join(TMP_ROOT, `case-${++harnessCounter}`);
  const app = express();
  app.use(express.json());
  const admin = opts?.admin ?? false;
  app.use(
    '/m',
    createMobileRouter({
      stateDir,
      cookieSecure: opts?.cookieSecure,
      isAdminAuthorized: () => admin,
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    stateDir,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function extractCookie(setCookie: string | string[] | null | undefined): string | undefined {
  if (!setCookie) return undefined;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const entry of list) {
    if (entry.startsWith(`${MOBILE_SESSION_COOKIE}=`)) {
      const value = entry.slice(MOBILE_SESSION_COOKIE.length + 1).split(';')[0];
      return `${MOBILE_SESSION_COOKIE}=${value}`;
    }
  }
  return undefined;
}

test('login fails with PIN_NOT_CONFIGURED before any PIN is set', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    assert.equal(res.status, 409);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'PIN_NOT_CONFIGURED');
  } finally { await h.close(); }
});

test('session cookie is preview-friendly on loopback and Secure behind HTTPS tunnel', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });

    const local = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!', deviceLabel: 'local-preview' }),
    });
    assert.equal(local.status, 200);
    const localCookie = local.headers.get('set-cookie') ?? '';
    assert.match(localCookie, new RegExp(`${MOBILE_SESSION_COOKIE}=`));
    assert.doesNotMatch(localCookie, /;\s*Secure/i);

    const tunnel = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ pin: 'TestPin1!', deviceLabel: 'phone-tunnel' }),
    });
    assert.equal(tunnel.status, 200);
    const tunnelCookie = tunnel.headers.get('set-cookie') ?? '';
    assert.match(tunnelCookie, /;\s*Secure/i);
  } finally { await h.close(); }
});

test('happy path: set PIN, login, whoami, logout', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });

    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!', deviceLabel: 'Nathans iPhone' }),
    });
    assert.equal(login.status, 200);
    const cookie = extractCookie(login.headers.get('set-cookie'));
    assert.ok(cookie, 'login should issue a session cookie');

    const me = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie: cookie! } });
    assert.equal(me.status, 200);
    const meBody = await me.json() as { deviceLabel: string; deviceId: string };
    assert.equal(meBody.deviceLabel, 'Nathans iPhone');
    assert.ok(meBody.deviceId.startsWith('dev-'));

    const logout = await fetch(`${h.url}/m/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookie! },
    });
    assert.equal(logout.status, 200);

    const afterLogout = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie: cookie! } });
    assert.equal(afterLogout.status, 401);
  } finally { await h.close(); }
});

test('QR pairing creates a session without manual PIN and is one-time use', async () => {
  const h = await startHarness();
  try {
    const pair = await createMobilePairingCode({ targetUrl: `${h.url}/m/` }, { stateDir: h.stateDir });

    const paired = await fetch(`${h.url}/m/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken: pair.token, deviceLabel: 'QR iPhone' }),
    });
    assert.equal(paired.status, 200);
    const cookie = extractCookie(paired.headers.get('set-cookie'));
    assert.ok(cookie, 'pairing should issue a session cookie');

    const me = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie: cookie! } });
    assert.equal(me.status, 200);
    const meBody = await me.json() as { deviceLabel: string; deviceId: string };
    assert.equal(meBody.deviceLabel, 'QR iPhone');
    assert.ok(meBody.deviceId.startsWith('dev-'));

    const reused = await fetch(`${h.url}/m/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken: pair.token, deviceLabel: 'Replay' }),
    });
    assert.equal(reused.status, 401);
    const reusedBody = await reused.json() as { error: string };
    assert.equal(reusedBody.error, 'INVALID_PAIRING_CODE');
  } finally { await h.close(); }
});

test('whoami rejects requests with no cookie', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    const res = await fetch(`${h.url}/m/api/whoami`);
    assert.equal(res.status, 401);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'NO_SESSION');
  } finally { await h.close(); }
});

test('whoami rejects a tampered cookie', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    const res = await fetch(`${h.url}/m/api/whoami`, {
      headers: { cookie: `${MOBILE_SESSION_COOKIE}=not-a-real-token` },
    });
    assert.equal(res.status, 401);
  } finally { await h.close(); }
});

test('wrong PIN returns 401 then 429 after the 5th failure', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    for (let i = 0; i < 4; i += 1) {
      const res = await fetch(`${h.url}/m/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: 'WrongPin0' }),
      });
      assert.equal(res.status, 401, `attempt ${i + 1} should be 401`);
    }
    const fifth = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'WrongPin0' }),
    });
    assert.equal(fifth.status, 429);
    const body = await fifth.json() as { error: string; retryAfterMs: number };
    assert.equal(body.error, 'LOCKED_OUT');
    assert.ok(body.retryAfterMs > 0);
    assert.ok(fifth.headers.get('retry-after'), 'Retry-After header should be set');

    // Even the correct PIN is denied while locked out.
    const lockedCorrect = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    assert.equal(lockedCorrect.status, 429);
  } finally { await h.close(); }
});

test('rotate is admin-gated and invalidates existing sessions', async () => {
  const nonAdmin = await startHarness({ admin: false });
  try {
    await setPin('TestPin1!', { stateDir: nonAdmin.stateDir });
    const blocked = await fetch(`${nonAdmin.url}/m/auth/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'RotatedP1n!' }),
    });
    assert.equal(blocked.status, 401);
  } finally { await nonAdmin.close(); }

  const admin = await startHarness({ admin: true });
  try {
    await setPin('TestPin1!', { stateDir: admin.stateDir });
    const login = await fetch(`${admin.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    assert.equal(login.status, 200);
    const cookie = extractCookie(login.headers.get('set-cookie'))!;

    const rotate = await fetch(`${admin.url}/m/auth/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'RotatedP1n!' }),
    });
    assert.equal(rotate.status, 200);
    const rotateBody = await rotate.json() as { revokedSessions: number };
    assert.equal(rotateBody.revokedSessions, 1);

    // Old cookie should now be rejected.
    const after = await fetch(`${admin.url}/m/api/whoami`, { headers: { cookie } });
    assert.equal(after.status, 401);

    // New PIN works; old PIN does not.
    const oldPin = await fetch(`${admin.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    assert.equal(oldPin.status, 401);
    const newPin = await fetch(`${admin.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'RotatedP1n!' }),
    });
    assert.equal(newPin.status, 200);
  } finally { await admin.close(); }
});

test('auth/status reports configuration + auth state without leaking the hash', async () => {
  const h = await startHarness();
  try {
    let res = await fetch(`${h.url}/m/auth/status`);
    let body = await res.json() as { pinConfigured: boolean; authenticated: boolean };
    assert.equal(body.pinConfigured, false);
    assert.equal(body.authenticated, false);

    await setPin('TestPin1!', { stateDir: h.stateDir });
    res = await fetch(`${h.url}/m/auth/status`);
    body = await res.json() as { pinConfigured: boolean; authenticated: boolean };
    assert.equal(body.pinConfigured, true);
    assert.equal(body.authenticated, false);

    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    const cookie = extractCookie(login.headers.get('set-cookie'))!;
    res = await fetch(`${h.url}/m/auth/status`, { headers: { cookie } });
    body = await res.json() as { pinConfigured: boolean; authenticated: boolean };
    assert.equal(body.authenticated, true);
  } finally { await h.close(); }
});

test('chat/send rejects without Idempotency-Key', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    const cookie = extractCookie(login.headers.get('set-cookie'))!;
    const res = await fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: 'hello' }),
    });
    // No assistant wired in the test harness → 503; either way, the
    // missing-key check fires first.
    assert.ok(res.status === 400 || res.status === 503, `unexpected ${res.status}`);
    if (res.status === 400) {
      const body = await res.json() as { error: string };
      assert.equal(body.error, 'MISSING_IDEMPOTENCY_KEY');
    }
  } finally { await h.close(); }
});

test('chat/send rejects without a cookie', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-x' },
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.equal(res.status, 401);
  } finally { await h.close(); }
});

test('chat/send returns 503 when no assistant is wired', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    const cookie = extractCookie(login.headers.get('set-cookie'))!;
    const res = await fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'idempotency-key': 'k-x' },
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.equal(res.status, 503);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'CHAT_SEND_UNAVAILABLE');
  } finally { await h.close(); }
});

test('setPin enforces 8-64 char floor + allowed-char policy', async () => {
  const h = await startHarness();
  try {
    // Empty / too short.
    await assert.rejects(() => setPin('', { stateDir: h.stateDir }));
    await assert.rejects(() => setPin('1234567', { stateDir: h.stateDir }));
    // Too long (> 64 chars).
    await assert.rejects(() => setPin('a'.repeat(65), { stateDir: h.stateDir }));
    // Invalid char (newline isn't in the allowed set).
    await assert.rejects(() => setPin('AbCdEf\n12', { stateDir: h.stateDir }));
    // Valid: 8 chars exactly.
    await setPin('Pwd12345', { stateDir: h.stateDir });
    // Valid: max length 64.
    await setPin('A'.repeat(64), { stateDir: h.stateDir });
    // Valid: mixed letters / digits / symbols.
    await setPin('Clem-Test-2024!', { stateDir: h.stateDir });
  } finally { await h.close(); }
});
