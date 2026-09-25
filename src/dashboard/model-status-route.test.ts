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
  'BYO_PROVIDER_MOONSHOT_API_KEY',
  'CLEMMY_MODEL_ROLES',
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
    // No secret material ever serialized (billing pages are directory data).
    const raw = JSON.stringify(body, (k, v) => (k === 'url' ? undefined : v)).toLowerCase();
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
      // Billing pages are directory data, not secrets; scan everything else.
      const raw = JSON.stringify(body, (k, v) => (k === 'url' ? undefined : v)).toLowerCase();
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

interface BillingView {
  url?: string;
  kind?: string;
  outOfCredit?: { status?: number; detail?: string };
  balance?: { amount: number; currency: string };
  roles?: string[];
}

test('each account carries its billing page, whether its provider refused for credit, and the money figures the key can read', async () => {
  const { noteCreditRefused, __resetProviderCreditForTests } = await import('../runtime/provider-credit.js');
  const { __setBalanceFetchForTests, __resetProviderBillingForTests, recentCreditRefusalNotice } = await import('../runtime/harness/provider-billing.js');
  __resetProviderCreditForTests();
  __resetProviderBillingForTests();
  const balanceReads: string[] = [];
  __setBalanceFetchForTests(async (url) => {
    balanceReads.push(url);
    if (url.includes('/billing/usage')) {
      return {
        ok: true,
        json: async () => ({
          object: 'list', billing_period: '2026-09', currency: 'USD',
          data: [
            { date: '2026-09-23', line_items: [{ product_name: 'a', cost: '30.00' }, { product_name: 'b', cost: '2.10' }] },
            { date: '2026-09-24', line_items: [{ product_name: 'a', cost: '10.00' }] },
          ],
          next_cursor: null,
        }),
      };
    }
    return { ok: true, json: async () => ({ code: 0, data: { available_balance: 49.5, voucher_balance: 46.5, cash_balance: 3 }, status: true }) };
  });
  await withEnv({
    BYO_PROVIDERS: JSON.stringify([
      { id: 'together', label: 'Together AI', baseURL: 'https://api.together.ai/v1', modelIds: ['zai-org/GLM-5.2'] },
      { id: 'moonshot', label: 'Moonshot', baseURL: 'https://api.moonshot.ai/v1', modelIds: ['kimi-k3'] },
    ]),
    BYO_PROVIDER_TOGETHER_API_KEY: 'together-secret',
    BYO_PROVIDER_MOONSHOT_API_KEY: 'moonshot-secret',
    CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'worker', modelId: 'zai-org/GLM-5.2', scope: 'durable', source: 'settings' }]),
  }, async () => {
    noteCreditRefused('together', { status: 402, detail: 'Credit limit exceeded' });
    const h = await boot();
    try {
      const read = async () => (await fetch(`${h.url}/api/console/model-status`)).text();
      await read(); // the first read starts the balance fetch in the background
      await new Promise((resolve) => setTimeout(resolve, 25));
      const raw = await read();
      for (const secret of ['together-secret', 'moonshot-secret']) assert.ok(!raw.includes(secret), `payload leaked ${secret}`);
      const body = JSON.parse(raw) as {
        byoProviders: Array<{ id: string; billing?: BillingView }>;
        claude: { billing?: BillingView };
        codex: { billing?: BillingView };
        openai: { billing?: BillingView };
        jev: { connected: boolean; billing?: BillingView };
      };
      const together = body.byoProviders.find((p) => p.id === 'together')?.billing;
      assert.equal(together?.url, 'https://api.together.ai/settings/organization/~current/billing');
      assert.equal(together?.kind, 'prepaid');
      assert.equal(together?.outOfCredit?.status, 402);
      assert.equal(together?.outOfCredit?.detail, 'Credit limit exceeded');
      assert.equal(together?.balance, undefined, 'Together serves no balance to the key');
      assert.deepEqual(together?.monthSpend && { amount: together.monthSpend.amount, currency: together.monthSpend.currency }, { amount: 42.1, currency: 'USD' },
        'Together serves its billed spend for the month, summed from its own line items');
      assert.ok(together?.roles?.includes('worker'), 'the account names the job it is doing');
      assert.ok(!body.byoProviders.find((p) => p.id === 'moonshot')?.billing?.roles?.includes('worker'));

      const moonshot = body.byoProviders.find((p) => p.id === 'moonshot')?.billing;
      assert.deepEqual(moonshot?.balance && { amount: moonshot.balance.amount, currency: moonshot.balance.currency }, { amount: 49.5, currency: 'USD' });
      assert.equal(moonshot?.outOfCredit, undefined);
      assert.deepEqual(
        [...balanceReads].sort(),
        ['https://api.moonshot.ai/v1/users/me/balance', 'https://api.together.ai/v1/billing/usage?granularity=day&limit=100'],
        'only what a provider serves to the key is read, once each',
      );

      assert.equal(body.claude.billing?.url, 'https://claude.ai/settings/usage');
      assert.equal(body.claude.billing?.kind, 'plan');
      assert.equal(body.codex.billing?.kind, 'plan');
      assert.deepEqual(body.openai.billing?.roles, ['memory_search']);
      assert.equal(body.jev.connected, false);
      assert.equal(body.jev.billing?.url, 'https://console.typesafe.ai/settings/billing');

      // A chat turn that fails on the refusal quotes the provider and links its page.
      assert.equal(
        recentCreditRefusalNotice(),
        'Together AI turned down this request: “Credit limit exceeded”. Add credit here: https://api.together.ai/settings/organization/~current/billing',
      );
    } finally {
      await h.close();
      __resetProviderBillingForTests();
      __resetProviderCreditForTests();
    }
  });
});

test('a Coding Plan endpoint and a pay-as-you-go endpoint on one host get their own pages', async () => {
  const { billingEntryForBaseURL } = await import('../runtime/harness/provider-billing.js');
  assert.equal(billingEntryForBaseURL('https://api.z.ai/api/coding/paas/v4')?.kind, 'plan');
  assert.equal(billingEntryForBaseURL('https://api.z.ai/api/paas/v4')?.kind, 'prepaid');
  assert.equal(billingEntryForBaseURL('https://api.kimi.com/coding/v1')?.kind, 'plan');
  assert.equal(billingEntryForBaseURL('https://llm.internal.example/v1'), undefined, 'an unknown endpoint gets no guessed link');
  assert.equal(billingEntryForBaseURL('not a url'), undefined);
});
