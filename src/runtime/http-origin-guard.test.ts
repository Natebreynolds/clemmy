/**
 * Run: npx tsx --test src/runtime/http-origin-guard.test.ts
 *
 * Regression coverage for DNS rebinding. Before this guard existed, the only
 * Host check was "is this the configured tunnel hostname?", used to restrict
 * that one name to /m/*. Every other Host — including a rebound attacker name
 * pointed at 127.0.0.1 — fell straight through to the full /api/* surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

/**
 * Raw http.request rather than fetch: `Host` is a forbidden header name in the
 * fetch spec and is silently dropped, so a fetch-based test cannot express the
 * rebinding attack at all — it would assert against the wrong Host and pass
 * regardless of whether the guard exists.
 */
function rawRequest(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string> },
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-origin-guard-test-'));
process.env.CLEMENTINE_HOME = TMP_ROOT;
test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const {
  hostAllowlistMiddleware,
  requireSameOriginForMutations,
  isAllowedHost,
  isAllowedOrigin,
  normalizeHostHeader,
  allowHostName,
} = await import('./http-origin-guard.js');

async function startApp(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(hostAllowlistMiddleware);
  app.use(requireSameOriginForMutations);
  app.get('/api/status', (_req, res) => { res.json({ ok: true }); });
  app.post('/api/mutate', (_req, res) => { res.json({ ok: true }); });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

test('normalizeHostHeader strips ports and IPv6 brackets', () => {
  assert.equal(normalizeHostHeader('Example.COM:8420'), 'example.com');
  assert.equal(normalizeHostHeader('[::1]:8420'), '::1');
  assert.equal(normalizeHostHeader('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeHostHeader(undefined), '');
});

test('rebinding: an unknown Host name is refused with 421', async () => {
  const app = await startApp();
  try {
    const res = await rawRequest(app.port, { path: '/api/status', headers: { Host: 'evil.example' } });
    assert.equal(res.status, 421, 'a rebound attacker hostname must not reach the API surface');
  } finally {
    await app.close();
  }
});

test('loopback and IP-literal Hosts are allowed', async () => {
  const app = await startApp();
  try {
    for (const host of ['127.0.0.1', 'localhost', '192.168.1.5']) {
      const res = await rawRequest(app.port, { path: '/api/status', headers: { Host: host } });
      assert.equal(res.status, 200, `${host} should be served`);
    }
  } finally {
    await app.close();
  }
});

test('CLEMENTINE_EXTRA_ALLOWED_HOSTS widens the allowlist', () => {
  const prior = process.env.CLEMENTINE_EXTRA_ALLOWED_HOSTS;
  process.env.CLEMENTINE_EXTRA_ALLOWED_HOSTS = 'my-box.lan, other.example';
  try {
    assert.equal(isAllowedHost('my-box.lan'), true);
    assert.equal(isAllowedHost('other.example'), true);
    assert.equal(isAllowedHost('evil.example'), false);
  } finally {
    if (prior === undefined) delete process.env.CLEMENTINE_EXTRA_ALLOWED_HOSTS;
    else process.env.CLEMENTINE_EXTRA_ALLOWED_HOSTS = prior;
  }
});

test('cross-origin mutation is refused, same-origin passes', async () => {
  const app = await startApp();
  try {
    const cross = await rawRequest(app.port, {
      method: 'POST', path: '/api/mutate',
      headers: { Host: '127.0.0.1', Origin: 'https://evil.example' },
    });
    assert.equal(cross.status, 403);

    const same = await rawRequest(app.port, {
      method: 'POST', path: '/api/mutate',
      headers: { Host: '127.0.0.1', Origin: `http://127.0.0.1:${app.port}` },
    });
    assert.equal(same.status, 200);
  } finally {
    await app.close();
  }
});

test('non-browser clients without an Origin header still work', async () => {
  // curl, the CLI, and the desktop app send no Origin. They are not subject to
  // CSRF and still need a credential, so blocking them would break real flows.
  const app = await startApp();
  try {
    const res = await rawRequest(app.port, {
      method: 'POST', path: '/api/mutate', headers: { Host: '127.0.0.1' },
    });
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }
});

test('a cross-site fetch without Origin is still refused via Sec-Fetch-Site', async () => {
  const app = await startApp();
  try {
    const res = await rawRequest(app.port, {
      method: 'POST', path: '/api/mutate',
      headers: { Host: '127.0.0.1', 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(res.status, 403);
  } finally {
    await app.close();
  }
});

test('allowHostName registers a runtime host — the relay hostname must not 421', () => {
  // Regression pin: the first live request through the Railway relay was
  // refused with 421 because <pairId>.<relay base> was not allowlisted.
  // The relay wiring registers it at boot; this pins the mechanism.
  assert.equal(isAllowedHost('de9334b0f70862c5.r.example.com'), false);
  allowHostName('de9334b0f70862c5.r.example.com:53028');
  assert.equal(isAllowedHost('de9334b0f70862c5.r.example.com'), true, 'port must be normalized away');
  assert.equal(isAllowedHost('other.r.example.com'), false, 'only the exact registered host is allowed');
});


/**
 * ── Host and Origin are two different questions ─────────────────────────────
 *
 * isAllowedHost answers "could this Host header be a rebinding attack?", where
 * the IP-literal shortcut is correct — rebinding works by changing what a NAME
 * resolves to. The CSRF backstop reused it to answer "did this come from a page
 * I serve?", and there the same shortcut admitted every bare IP on the internet.
 */

test('an Origin on a foreign bare IP is refused, though the same Host would pass', () => {
  // The Host question: an IP literal is not a rebinding vector, so it passes.
  assert.equal(isAllowedHost('198.51.100.7'), true);
  // The Origin question: this machine does not answer at that address, so a
  // page served from it is cross-origin and its mutations must be refused.
  assert.equal(isAllowedOrigin('198.51.100.7'), false,
    'any page on any bare IP could otherwise defeat the one explicit CSRF layer');
  assert.equal(isAllowedOrigin('203.0.113.99'), false);
});

test('loopback origins pass in both address families', () => {
  assert.equal(isAllowedOrigin('127.0.0.1'), true);
  assert.equal(isAllowedOrigin('::1'), true);
  // URL.hostname hands back the brackets; judging on the bracketed form used to
  // refuse every legitimate IPv6 LAN client by accident.
  assert.equal(isAllowedOrigin('[::1]'), true);
  assert.equal(isAllowedOrigin('localhost'), true);
});

test('an origin on one of this machine\'s own addresses passes', () => {
  const local = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === 'IPv4' && !entry.internal);
  if (!local) return; // no LAN interface on this runner — nothing to assert
  assert.equal(isAllowedOrigin(local.address), true,
    'the LAN address the daemon is reachable at must stay same-origin');
});

test('a runtime-registered name is an allowed origin, an unregistered one is not', () => {
  assert.equal(isAllowedOrigin('abc123.relay.example'), false);
  allowHostName('abc123.relay.example');
  assert.equal(isAllowedOrigin('abc123.relay.example'), true,
    'the relay hostname the daemon answers for is a real origin of this app');
});

test('an empty or unparseable origin host is refused', () => {
  assert.equal(isAllowedOrigin(''), false);
  assert.equal(isAllowedOrigin('   '), false);
});
