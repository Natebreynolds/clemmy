/**
 * Run: npx tsx --test src/dashboard/model-status-route.test.ts
 *
 * GET /api/console/model-status powers the top-bar chips. It must: require auth,
 * always return connection booleans plus connected BYO providers + an updatedAt,
 * surface captured Codex/Claude quota windows, and NEVER leak a key/secret.
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

const ENV_KEYS = [
  'BYO_MODEL_BASE_URL',
  'BYO_MODEL_ID',
  'BYO_MODEL_API_KEY',
  'BYO_MODEL_PROVIDER',
  'BYO_PROVIDERS',
  'BYO_PROVIDER_DEEPSEEK_API_KEY',
  'BYO_PROVIDER_TOGETHER_API_KEY',
];

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; process.env[k] = ''; }
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try { return await fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  }
}

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

test('surfaces every configured BYO provider generically without leaking keys', async () => {
  await withEnv({
    BYO_MODEL_BASE_URL: 'https://api.z.ai/api/paas/v4',
    BYO_MODEL_ID: 'glm-5.2',
    BYO_MODEL_API_KEY: 'zai-secret',
    BYO_MODEL_PROVIDER: 'GLM (Z.ai)',
    BYO_PROVIDERS: JSON.stringify([
      { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com', modelIds: ['deepseek-chat'] },
      { id: 'together', label: 'Together AI', baseURL: 'https://api.together.ai/v1', modelIds: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'] },
    ]),
    BYO_PROVIDER_DEEPSEEK_API_KEY: 'deepseek-secret',
    BYO_PROVIDER_TOGETHER_API_KEY: 'together-secret',
  }, async () => {
    const h = await boot();
    try {
      const body = await (await fetch(`${h.url}/api/console/model-status`)).json() as {
        byoProviders: Array<{ id: string; label: string; modelIds: string[]; connected: boolean }>;
        together: { connected: boolean };
      };
      assert.deepEqual(body.byoProviders.map((p) => p.id), ['default', 'deepseek', 'together']);
      assert.equal(body.byoProviders.every((p) => p.connected), true);
      assert.equal(body.byoProviders.find((p) => p.id === 'default')?.label, 'GLM (Z.ai)');
      assert.deepEqual(body.byoProviders.find((p) => p.id === 'deepseek')?.modelIds, ['deepseek-chat']);
      assert.equal(body.together.connected, true, 'legacy together chip remains compatible');
      const raw = JSON.stringify(body).toLowerCase();
      for (const secret of ['zai-secret', 'deepseek-secret', 'together-secret', 'api_key', 'apikey', 'bearer']) {
        assert.ok(!raw.includes(secret.toLowerCase()), `payload leaked ${secret}`);
      }
    } finally {
      await h.close();
    }
  });
});

test('reports the Grok account with its captured limits and today\'s spend per provider', async () => {
  __resetRateLimitStoreForTests();
  const { saveXaiOAuthTokens, clearXaiOAuthTokens } = await import('../runtime/auth-store.js');
  const { recordByoRateLimit } = await import('../runtime/harness/rate-limit-store.js');
  const { __resetModelStatusCacheForTests, providerForSpend } = await import('../runtime/harness/model-status.js');
  saveXaiOAuthTokens({ accessToken: 'xai-access-token-test', refreshToken: 'xai-refresh-test' });
  recordByoRateLimit('xai', {
    'x-ratelimit-limit-requests': '600',
    'x-ratelimit-remaining-requests': '590',
    'x-ratelimit-limit-tokens': '12000000',
    'x-ratelimit-remaining-tokens': '11000000',
  });
  __resetModelStatusCacheForTests();
  const h = await boot();
  try {
    const raw = await (await fetch(`${h.url}/api/console/model-status`)).text();
    assert.doesNotMatch(raw, /xai-access-token-test|xai-refresh-test/, 'no secret may leave the route');
    const body = JSON.parse(raw) as {
      xai: { connected: boolean; requests?: { limit: number; remaining: number }; tokens?: { limit: number } };
      spendToday: { date: string; byProvider: Record<string, { tokens: number; calls: number }> };
    };
    assert.equal(body.xai.connected, true);
    assert.deepEqual(body.xai.requests, { limit: 600, remaining: 590 });
    assert.equal(body.xai.tokens?.limit, 12_000_000);
    assert.match(body.spendToday.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof body.spendToday.byProvider, 'object');
  } finally {
    await h.close();
    clearXaiOAuthTokens();
  }
  // Ledger rows land on the account that paid for them.
  assert.equal(providerForSpend('gpt-5.6-sol', []), 'codex');
  assert.equal(providerForSpend('claude-sonnet-5', []), 'claude');
  assert.equal(providerForSpend('grok-4-1-fast-non-reasoning', []), 'xai');
  assert.equal(providerForSpend('glm-5.3', [{ id: 'glm', modelIds: ['glm-5.3'] }]), 'glm');
});

test('a Grok account that is not connected is reported as such without limits', async () => {
  __resetRateLimitStoreForTests();
  const { __resetModelStatusCacheForTests } = await import('../runtime/harness/model-status.js');
  __resetModelStatusCacheForTests();
  const h = await boot();
  try {
    const body = await (await fetch(`${h.url}/api/console/model-status`)).json() as { xai: { connected: boolean; requests?: unknown } };
    assert.equal(body.xai.connected, false);
    assert.equal(body.xai.requests, undefined);
  } finally {
    await h.close();
  }
});
