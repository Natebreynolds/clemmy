/**
 * Run: npx tsx --test src/dashboard/model-status-route.test.ts
 *
 * GET /api/console/model-status powers the top-bar chips. It must: require auth,
 * always return connection booleans for all four providers + an updatedAt, surface
 * captured Codex/Claude quota windows, and NEVER leak a key/secret.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-model-status-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.NODE_ENV = 'test';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { recordCodexRateLimit, __resetRateLimitStoreForTests } = await import('../runtime/harness/rate-limit-store.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

async function boot(authorized = { v: true }) {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => authorized.v, {} as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('requires authorization', async () => {
  const h = await boot({ v: false });
  try {
    const res = await fetch(`${h.url}/api/console/model-status`);
    assert.equal(res.status, 401);
  } finally {
    await h.close();
  }
});

test('returns connection booleans for all providers + updatedAt; never leaks a key', async () => {
  __resetRateLimitStoreForTests();
  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/model-status`);
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, { connected: boolean }> & { updatedAt: number };
    for (const p of ['codex', 'claude', 'openai', 'together']) {
      assert.equal(typeof body[p]?.connected, 'boolean', `${p}.connected is a boolean`);
    }
    assert.equal(typeof body.updatedAt, 'number');
    // No secret material ever serialized.
    const raw = JSON.stringify(body).toLowerCase();
    assert.ok(!raw.includes('apikey') && !raw.includes('api_key') && !raw.includes('bearer') && !raw.includes('sk-'),
      'no key/secret in the payload');
  } finally {
    await h.close();
  }
});

test('surfaces a captured Codex quota window', async () => {
  __resetRateLimitStoreForTests();
  recordCodexRateLimit({ 'x-codex-primary-used-percent': '42', 'x-codex-secondary-used-percent': '18' });
  const h = await boot();
  try {
    const body = await (await fetch(`${h.url}/api/console/model-status`)).json() as {
      codex: { connected: boolean; primary?: { usedPercent: number }; secondary?: { usedPercent: number } };
    };
    assert.equal(body.codex.primary?.usedPercent, 42);
    assert.equal(body.codex.secondary?.usedPercent, 18);
  } finally {
    await h.close();
  }
});
