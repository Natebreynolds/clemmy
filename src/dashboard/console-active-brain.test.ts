/**
 * Run: npx tsx --test src/dashboard/console-active-brain.test.ts
 *
 * The active-brain picker is a second write path into all-in BYO mode. Keep its
 * legacy worker slot in lockstep with the older model-backend form so a stale
 * gpt-* value cannot cold-probe the BYO endpoint on the next fan-out. It is also
 * the live Codex/Claude switch, so pin exact model persistence, cache revival,
 * and the Claude subscription-auth fail-closed boundary here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-active-brain-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.NODE_ENV = 'test';
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.AUTH_MODE = 'codex_oauth';
process.env.MODEL_ROUTING_MODE = 'off';
process.env.BYO_MODEL_BASE_URL = 'https://api.z.ai/api/paas/v4';
process.env.BYO_MODEL_API_KEY = 'test-only-key';
process.env.BYO_MODEL_ID = 'glm-5.2';
process.env.OPENAI_MODEL_WORKER = 'gpt-5.4';
process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
  { role: 'worker', modelId: 'gpt-5.6-luna', scope: 'durable', source: 'settings' },
]);
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
// The home is signed in to Codex: only a connected model can be the brain.
const CODEX_AUTH_FILE = path.join(TMP_HOME, 'state', 'auth.json');
const signInToCodex = (): void => writeFileSync(CODEX_AUTH_FILE, JSON.stringify({
  source: 'native',
  codexOauth: { accessToken: 'fake-codex-access', refreshToken: 'fake-codex-refresh', lastRefresh: new Date().toISOString() },
}), 'utf-8');
signInToCodex();

const { registerConsoleRoutes } = await import('./console-routes.js');
const { getActiveAuthMode } = await import('../config.js');
const { effectiveBrainValue } = await import('../runtime/harness/model-role-options.js');
const {
  readDurableBindings,
  resolveRoleModel,
  pinSessionBrain,
  pinnedBrainForSession,
  __sessionBrainPinTest__,
} = await import('../runtime/harness/model-roles.js');
const claudeOauth = await import('../runtime/claude-oauth.js');
const fallbackModel = await import('../runtime/harness/fallback-model.js');

test.after(() => {
  claudeOauth.__test__.setVaultTokenReaderForTests(null);
  claudeOauth.__test__.setRawCredentialReaderForTests(null);
  claudeOauth.__test__.setRefreshClaudeTokensForTests(null);
  fallbackModel.reviveDeadBrains();
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot(authorized = true) {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => authorized, {} as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function patchActiveBrain(
  url: string,
  body: { brain: 'api_key' | 'codex_oauth' | 'claude_oauth'; modelId?: string; sessionId?: string },
) {
  const response = await fetch(`${url}/api/console/settings/active-brain`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    response,
    body: await response.json() as {
      activeBrain?: string;
      claudeAuth?: { configured?: boolean; source?: string };
      error?: string;
      kind?: string;
      needsLogin?: boolean;
    },
  };
}

function persistedEnvValue(key: string): string | undefined {
  const envFile = path.join(TMP_HOME, '.env');
  try {
    const line = readFileSync(envFile, 'utf8')
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith(`${key}=`));
    return line?.slice(key.length + 1);
  } catch {
    return undefined;
  }
}

test('fallback judge settings authenticate, persist exactly, and preserve the primary judge', async () => {
  const { removeEnvKey } = await import('../tools/shared.js');
  const h = await boot();
  const unauthorized = await boot(false);
  const originalPrimary = process.env.CLEMMY_MODEL_ROLES;
  const save = (url: string, body: unknown) => fetch(`${url}/api/console/settings/models/judge-fallback`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await save(unauthorized.url, { mode: 'off' })).status, 401);
    assert.equal((await save(h.url, { mode: 'model', modelId: 'not-connected' })).status, 400);
    const saved = await save(h.url, { mode: 'model', modelId: 'glm-5.2' });
    assert.equal(saved.status, 200, await saved.clone().text());
    const { options, ...choice } = (await saved.json()).judgeFallback;
    assert.deepEqual(choice, { mode: 'model', modelId: 'glm-5.2', available: true });
    assert.ok(Array.isArray(options));
    assert.equal(process.env.CLEMMY_MODEL_ROLES, originalPrimary);
    assert.equal(JSON.parse(persistedEnvValue('CLEMMY_JUDGE_FALLBACK')!).modelId, 'glm-5.2');
    const snapshot = await fetch(`${h.url}/api/console/settings`);
    assert.equal((await snapshot.json()).modelRoles.judgeFallback.modelId, 'glm-5.2');
    const off = await save(h.url, { mode: 'off' });
    assert.equal((await off.json()).judgeFallback.mode, 'off');
  } finally {
    await h.close();
    await unauthorized.close();
    removeEnvKey('CLEMMY_JUDGE_FALLBACK');
  }
});

test('switching to the BYO brain syncs the all-in worker slot without rewriting durable bindings', async () => {
  const durableBindings = process.env.CLEMMY_MODEL_ROLES;
  const harness = await boot();
  try {
    const response = await fetch(`${harness.url}/api/console/settings/active-brain`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brain: 'api_key' }),
    });
    const body = await response.json() as { activeBrain?: string; error?: string };
    assert.equal(response.status, 200, body.error);
    assert.equal(body.activeBrain, 'api_key');
    assert.equal(process.env.MODEL_ROUTING_MODE, 'all_in');
    assert.equal(process.env.OPENAI_MODEL_WORKER, 'glm-5.2');
    assert.equal(
      process.env.CLEMMY_MODEL_ROLES,
      durableBindings,
      'switching the brain changes the fallback slot, not the user-owned role binding',
    );

    const persisted = readFileSync(path.join(TMP_HOME, '.env'), 'utf8');
    assert.match(persisted, /^OPENAI_MODEL_WORKER=glm-5\.2$/m);
    assert.match(persisted, /^MODEL_ROUTING_MODE=all_in$/m);
  } finally {
    await harness.close();
  }
});

test('Codex and Claude switch live with exact model persistence and revive provider cooldowns', async () => {
  rmSync(path.join(TMP_HOME, '.env'), { force: true });
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.MODEL_ROUTING_MODE = 'off';
  process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.4';
  process.env.OPENAI_MODEL_FAST = 'gpt-5.4';
  process.env.OPENAI_MODEL_DEEP = 'gpt-5.4';
  process.env.OPENAI_MODEL_WORKER = 'gpt-5.4';
  process.env.CLAUDE_MODEL = 'claude-opus-4-8';

  let refreshCalls = 0;
  claudeOauth.__test__.setRawCredentialReaderForTests(() => null);
  claudeOauth.__test__.setVaultTokenReaderForTests(() => ({
    accessToken: 'sk-ant-oat01-test-active-brain',
    expiresAt: Date.now() + 60 * 60_000,
    subscriptionType: 'max',
    source: 'vault',
  }));
  claudeOauth.__test__.setRefreshClaudeTokensForTests(async () => {
    refreshCalls += 1;
    throw new Error('a fresh test token must not make a network refresh');
  });

  fallbackModel.markBrainAuthDead('codex', 'test-only expired grant');
  assert.equal(fallbackModel.isBrainAuthDead('codex'), true);

  const harness = await boot();
  try {
    const codex = await patchActiveBrain(harness.url, {
      brain: 'codex_oauth',
      modelId: 'gpt-5.6-terra',
    });
    assert.equal(codex.response.status, 200, codex.body.error);
    assert.equal(codex.body.activeBrain, 'codex_oauth');
    assert.equal(process.env.AUTH_MODE, 'codex_oauth');
    assert.equal(process.env.OPENAI_MODEL_PRIMARY, 'gpt-5.6-terra');
    assert.equal(getActiveAuthMode(), 'codex_oauth');
    assert.equal(effectiveBrainValue(), 'codex_oauth:gpt-5.6-terra');
    assert.equal(persistedEnvValue('AUTH_MODE'), 'codex_oauth');
    assert.equal(persistedEnvValue('OPENAI_MODEL_PRIMARY'), 'gpt-5.6-terra');
    assert.equal(
      fallbackModel.isBrainAuthDead('codex'),
      false,
      'a successful explicit switch must revive the provider immediately',
    );

    const claude = await patchActiveBrain(harness.url, {
      brain: 'claude_oauth',
      modelId: 'claude-sonnet-5',
    });
    assert.equal(claude.response.status, 200, claude.body.error);
    assert.equal(claude.body.activeBrain, 'claude_oauth');
    assert.equal(claude.body.claudeAuth?.configured, true);
    assert.equal(claude.body.claudeAuth?.source, 'vault');
    assert.equal(process.env.AUTH_MODE, 'claude_oauth');
    assert.equal(process.env.CLAUDE_MODEL, 'claude-sonnet-5');
    assert.equal(getActiveAuthMode(), 'claude_oauth');
    assert.equal(effectiveBrainValue(), 'claude_oauth:claude-sonnet-5');
    assert.equal(persistedEnvValue('AUTH_MODE'), 'claude_oauth');
    assert.equal(persistedEnvValue('CLAUDE_MODEL'), 'claude-sonnet-5');
    assert.equal(refreshCalls, 0, 'the preflight accepts a fresh OAuth token without a refresh call');
  } finally {
    await harness.close();
    claudeOauth.__test__.setVaultTokenReaderForTests(null);
    claudeOauth.__test__.setRefreshClaudeTokensForTests(null);
    fallbackModel.reviveDeadBrains();
  }
});

test('Claude switch fails closed before changing the live or persisted brain when OAuth is missing', async () => {
  rmSync(path.join(TMP_HOME, '.env'), { force: true });
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.MODEL_ROUTING_MODE = 'off';
  process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.6-terra';
  process.env.CLAUDE_MODEL = 'claude-sonnet-5';
  claudeOauth.__test__.setVaultTokenReaderForTests(() => null);
  claudeOauth.__test__.setRawCredentialReaderForTests(() => null);
  claudeOauth.__test__.setRefreshClaudeTokensForTests(async () => {
    assert.fail('a missing Claude token must fail before any refresh call');
  });

  const harness = await boot();
  try {
    const codex = await patchActiveBrain(harness.url, {
      brain: 'codex_oauth',
      modelId: 'gpt-5.6-terra',
    });
    assert.equal(codex.response.status, 200, codex.body.error);
    assert.equal(persistedEnvValue('AUTH_MODE'), 'codex_oauth');

    fallbackModel.markBrainAuthDead('claude', 'test-only missing grant');
    assert.equal(fallbackModel.isBrainAuthDead('claude'), true);

    const rejected = await patchActiveBrain(harness.url, { brain: 'claude_oauth' });
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.body.kind, 'missing');
    assert.equal(rejected.body.needsLogin, true);
    assert.match(rejected.body.error ?? '', /No Claude sign-in found/);
    assert.equal(process.env.AUTH_MODE, 'codex_oauth');
    assert.equal(getActiveAuthMode(), 'codex_oauth');
    assert.equal(effectiveBrainValue(), 'codex_oauth:gpt-5.6-terra');
    assert.equal(persistedEnvValue('AUTH_MODE'), 'codex_oauth');
    assert.equal(
      fallbackModel.isBrainAuthDead('claude'),
      true,
      'a rejected switch must not run the success-path cache reset',
    );
  } finally {
    await harness.close();
    claudeOauth.__test__.setVaultTokenReaderForTests(null);
    claudeOauth.__test__.setRefreshClaudeTokensForTests(null);
    fallbackModel.reviveDeadBrains();
  }
});

async function withPrimaryRouteFixture(values: Record<string, string>, action: () => Promise<void>): Promise<void> {
  const initial: Record<string, string> = {
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '',
    BYO_MODEL_ID: '', BYO_MODEL_JUDGE_ID: '', BYO_MODEL_PROVIDER: '', BYO_BRAIN_MODEL_ID: '', BYO_PROVIDERS: '',
    BYO_PROVIDER_CONTROLLED_API_KEY: '', BYO_PROVIDER_OTHER_API_KEY: '', BYO_PROVIDER_XAI_API_KEY: '',
    OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra', OPENAI_MODEL_WORKER: 'gpt-5.6-luna', CLAUDE_MODEL: 'claude-sonnet-5',
    CLEMMY_MODEL_ROLES: '[]', CLEMMY_BRAIN_BACKUPS: '["gpt-5.6-sol"]',
    ...values,
  };
  const saved = Object.fromEntries(Object.keys(initial).map(key => [key, process.env[key]]));
  const envFile = path.join(TMP_HOME, '.env');
  let savedFile: Buffer | null = null;
  try { savedFile = readFileSync(envFile); } catch { /* absent isolated fixture file */ }
  let savedAuth: Buffer | null = null;
  try { savedAuth = readFileSync(CODEX_AUTH_FILE); } catch { /* no grant is also a valid controlled fixture */ }
  Object.assign(process.env, initial);
  const runtime = await import('../runtime/harness/codex-client.js');
  runtime.resetHarnessRuntimeConfig();
  try { await action(); }
  finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (savedFile === null) rmSync(envFile, { force: true }); else writeFileSync(envFile, savedFile);
    if (savedAuth === null) rmSync(CODEX_AUTH_FILE, { force: true }); else writeFileSync(CODEX_AUTH_FILE, savedAuth);
    claudeOauth.__test__.setVaultTokenReaderForTests(null);
    claudeOauth.__test__.setRawCredentialReaderForTests(null);
    claudeOauth.__test__.setRefreshClaudeTokensForTests(null);
    runtime.resetHarnessRuntimeConfig();
  }
}

for (const provider of ['controlled', 'xai'] as const) {
  test(`an explicit ${provider} model is a functional primary without an unrelated legacy default backend`, async () => {
    const modelId = provider === 'xai' ? 'grok-controlled-primary' : 'controlled/primary';
    const baseURL = `https://${provider}.example.test/v1`;
    await withPrimaryRouteFixture({
      BYO_PROVIDERS: JSON.stringify([{ id: provider, label: 'Controlled provider', baseURL, modelIds: [modelId] }]),
      ...(provider === 'controlled' ? { BYO_PROVIDER_CONTROLLED_API_KEY: 'controlled-fixture-key' } : {}),
    }, async () => {
      const auth = await import('../runtime/auth-store.js');
      if (provider === 'xai') auth.saveXaiOAuthTokens({ accessToken: 'controlled-xai-access', refreshToken: 'controlled-xai-refresh',
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });
      const harness = await boot();
      try {
        const backups = process.env.CLEMMY_BRAIN_BACKUPS;
        const selected = await patchActiveBrain(harness.url, { brain: 'api_key', modelId });
        assert.equal(selected.response.status, 200, selected.body.error);
        assert.equal(process.env.BYO_MODEL_BASE_URL, '', 'no default endpoint is invented');
        assert.equal(process.env.BYO_MODEL_API_KEY, '', 'no credential is copied to the default account');
        assert.equal(process.env.BYO_BRAIN_MODEL_ID, modelId);
        assert.equal(process.env.CLEMMY_BRAIN_BACKUPS, backups, 'explicit backup order is unchanged');
        assert.equal(resolveRoleModel('brain').modelId, modelId);
        assert.equal(resolveRoleModel('brain').provider, 'byo');
        assert.equal(resolveRoleModel('quick').modelId, modelId);
        const options = await import('../runtime/harness/model-role-options.js');
        assert.equal(options.effectiveBrain(), 'api_key');
        assert.equal(options.effectiveBrainValue(), `api_key:${modelId}`);
        assert.equal(options.brainOptions().filter(row => row.value === options.effectiveBrainValue() && row.available).length, 1);
        const runtime = await import('../runtime/harness/codex-client.js');
        runtime.resetHarnessRuntimeConfig();
        assert.deepEqual(await runtime.configureHarnessRuntime(), { ok: true }, 'the actual runtime configuration accepts the exact selected owner');
        const { routedPrimaryModel } = await import('../runtime/harness/router-model.js');
        const routed = routedPrimaryModel(resolveRoleModel('brain').modelId);
        assert.equal(routed.provider, 'byo');
        assert.equal(routed.modelId, modelId);
        assert.equal(routed.backend?.providerId, provider);
        assert.equal(routed.backend?.baseURL, baseURL);
        assert.equal(routed.backend?.apiKey, provider === 'xai' ? 'controlled-xai-access' : 'controlled-fixture-key');
      } finally { await harness.close(); }
    });
  });
}

test('a missing or multiply-owned API pick cannot change the current route or borrow another configured account', async () => {
  await withPrimaryRouteFixture({
    BYO_PROVIDERS: JSON.stringify([
      { id: 'controlled', label: 'Controlled A', baseURL: 'https://a.example.test/v1', modelIds: ['shared-controlled-model'] },
      { id: 'other', label: 'Controlled B', baseURL: 'https://b.example.test/v1', modelIds: ['shared-controlled-model'] },
    ]), BYO_PROVIDER_CONTROLLED_API_KEY: 'controlled-a', BYO_PROVIDER_OTHER_API_KEY: 'controlled-b',
  }, async () => {
    const harness = await boot();
    const before = { auth: process.env.AUTH_MODE, mode: process.env.MODEL_ROUTING_MODE, pin: process.env.BYO_BRAIN_MODEL_ID };
    try {
      for (const modelId of ['shared-controlled-model', 'unconnected-controlled-model']) {
        const selected = await patchActiveBrain(harness.url, { brain: 'api_key', modelId });
        assert.equal(selected.response.status, 400);
        assert.deepEqual({ auth: process.env.AUTH_MODE, mode: process.env.MODEL_ROUTING_MODE, pin: process.env.BYO_BRAIN_MODEL_ID }, before);
      }
    } finally { await harness.close(); }
  });
});

test('an unavailable saved API primary refuses runtime setup even when another legacy account and Claude are connected', async () => {
  await withPrimaryRouteFixture({ AUTH_MODE: 'claude_oauth', MODEL_ROUTING_MODE: 'all_in',
    BYO_BRAIN_MODEL_ID: 'missing-controlled-selection', BYO_MODEL_BASE_URL: 'https://other.example.test/v1',
    BYO_MODEL_API_KEY: 'other-fixture-key', BYO_MODEL_ID: 'other-controlled-model',
  }, async () => {
    claudeOauth.__test__.setRawCredentialReaderForTests(() => null);
    claudeOauth.__test__.setVaultTokenReaderForTests(() => ({ accessToken: 'sk-ant-oat01-controlled-other',
      expiresAt: Date.now() + 60 * 60_000, source: 'vault' }));
    const { getSelectedByoBrainBackendConfig } = await import('../runtime/harness/byo-providers.js');
    assert.equal(getSelectedByoBrainBackendConfig().configured, false);
    assert.equal(getSelectedByoBrainBackendConfig().apiKey, '', 'another backend cannot donate its key');
    assert.equal(effectiveBrainValue(), 'api_key:missing-controlled-selection');
    const runtime = await import('../runtime/harness/codex-client.js');
    runtime.resetHarnessRuntimeConfig();
    const configured = await runtime.configureHarnessRuntime();
    assert.equal(configured.ok, false, 'neither the legacy provider nor Claude substitutes for the missing exact API choice');
  });
});

test('failed Claude account/model preflight preserves an existing API primary and every persisted route byte', async () => {
  await withPrimaryRouteFixture({ AUTH_MODE: 'api_key', MODEL_ROUTING_MODE: 'all_in', BYO_BRAIN_MODEL_ID: 'controlled/primary',
    BYO_PROVIDERS: JSON.stringify([{ id: 'controlled', label: 'Controlled', baseURL: 'https://controlled.example.test/v1', modelIds: ['controlled/primary'] }]),
    BYO_PROVIDER_CONTROLLED_API_KEY: 'controlled-key',
  }, async () => {
    const { updateEnvKey } = await import('../tools/shared.js');
    for (const key of ['AUTH_MODE', 'MODEL_ROUTING_MODE', 'BYO_BRAIN_MODEL_ID', 'CLAUDE_MODEL', 'OPENAI_MODEL_WORKER']) {
      updateEnvKey(key, process.env[key]!);
    }
    const envFile = path.join(TMP_HOME, '.env');
    const before = readFileSync(envFile, 'utf8');
    const route = Object.fromEntries(['AUTH_MODE', 'MODEL_ROUTING_MODE', 'BYO_BRAIN_MODEL_ID', 'CLAUDE_MODEL', 'OPENAI_MODEL_WORKER']
      .map(key => [key, process.env[key]]));
    claudeOauth.__test__.setRawCredentialReaderForTests(() => null);
    const harness = await boot();
    try {
      for (const failure of ['missing', 'unavailable-model', 'refresh'] as const) {
        claudeOauth.__test__.setVaultTokenReaderForTests(() => failure === 'missing' ? null : {
          accessToken: 'sk-ant-oat01-controlled', expiresAt: failure === 'refresh' ? 1 : Date.now() + 60 * 60_000,
          refreshToken: 'controlled-refresh', source: 'vault',
        });
        claudeOauth.__test__.setRefreshClaudeTokensForTests(async () => { throw new Error('Controlled refresh refusal'); });
        const selected = await patchActiveBrain(harness.url, { brain: 'claude_oauth',
          modelId: failure === 'unavailable-model' ? 'claude-controlled-unavailable-model' : 'claude-sonnet-5' });
        assert.equal(selected.response.status, failure === 'unavailable-model' ? 400 : 409);
        assert.equal(readFileSync(envFile, 'utf8'), before, failure);
        assert.deepEqual(Object.fromEntries(Object.keys(route).map(key => [key, process.env[key]])), route, failure);
        assert.equal(resolveRoleModel('brain').modelId, 'controlled/primary', failure);
      }
    } finally { await harness.close(); }
  });
});

test('worker role PATCH survives a route restart and clear removes the live and durable binding', async () => {
  rmSync(path.join(TMP_HOME, '.env'), { force: true });
  const previous = {
    AUTH_MODE: process.env.AUTH_MODE,
    MODEL_ROUTING_MODE: process.env.MODEL_ROUTING_MODE,
    CLEMMY_MODEL_ROLES_REGISTRY: process.env.CLEMMY_MODEL_ROLES_REGISTRY,
    CLEMMY_MODEL_ROLES: process.env.CLEMMY_MODEL_ROLES,
  };
  process.env.AUTH_MODE = 'codex_oauth';
  process.env.MODEL_ROUTING_MODE = 'off';
  process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
  delete process.env.CLEMMY_MODEL_ROLES;

  const expected = {
    role: 'worker',
    modelId: 'glm-5.2',
    scope: 'durable',
    source: 'settings',
  } as const;
  let harness = await boot();
  try {
    const boundResponse = await fetch(`${harness.url}/api/console/settings/models/roles`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'worker', modelId: expected.modelId }),
    });
    const boundBody = await boundResponse.json() as {
      modelRoles?: { bindings?: unknown[]; roles?: { worker?: { modelId?: string; provider?: string; source?: string } } };
      error?: string;
    };
    assert.equal(boundResponse.status, 200, boundBody.error);
    assert.deepEqual(boundBody.modelRoles?.bindings, [expected]);
    assert.deepEqual(JSON.parse(process.env.CLEMMY_MODEL_ROLES ?? 'null'), [expected]);
    assert.deepEqual(JSON.parse(persistedEnvValue('CLEMMY_MODEL_ROLES') ?? 'null'), [expected]);
    assert.deepEqual(readDurableBindings(), [expected]);
    assert.deepEqual(resolveRoleModel('worker'), {
      modelId: expected.modelId,
      provider: 'byo',
      source: 'settings',
    });

    await harness.close();
    // Simulate a daemon restart: discard the live mirror, reopen a fresh HTTP
    // route owner, and require the resolver to rehydrate from BASE_DIR/.env.
    delete process.env.CLEMMY_MODEL_ROLES;
    harness = await boot();
    assert.deepEqual(readDurableBindings(), [expected]);
    assert.deepEqual(resolveRoleModel('worker'), {
      modelId: expected.modelId,
      provider: 'byo',
      source: 'settings',
    });

    const clearResponse = await fetch(`${harness.url}/api/console/settings/models/roles`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'worker', clear: true }),
    });
    const clearBody = await clearResponse.json() as {
      modelRoles?: { bindings?: unknown[]; roles?: { worker?: { modelId?: string; source?: string } } };
      error?: string;
    };
    assert.equal(clearResponse.status, 200, clearBody.error);
    assert.deepEqual(clearBody.modelRoles?.bindings, []);
    assert.equal(process.env.CLEMMY_MODEL_ROLES, '[]');
    assert.equal(persistedEnvValue('CLEMMY_MODEL_ROLES'), '[]');
    assert.deepEqual(readDurableBindings(), []);
    assert.equal(resolveRoleModel('worker').source, 'default');
  } finally {
    await harness.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('the memory row shows the memory route, and its PATCH sets and clears it through the same owner', async () => {
  rmSync(path.join(TMP_HOME, '.env'), { force: true });
  const previous = {
    AUTH_MODE: process.env.AUTH_MODE,
    MODEL_ROUTING_MODE: process.env.MODEL_ROUTING_MODE,
    CLEMMY_MODEL_ROLES: process.env.CLEMMY_MODEL_ROLES,
    CLEMMY_DEBATE_JUDGE: process.env.CLEMMY_DEBATE_JUDGE,
  };
  process.env.AUTH_MODE = 'codex_oauth';
  process.env.MODEL_ROUTING_MODE = 'off';
  process.env.CLEMMY_MODEL_ROLES = '[]';
  delete process.env.CLEMMY_DEBATE_JUDGE;
  const { describeMemoryModel } = await import('../memory/memory-model-route.js');
  type MemoryRow = { modelId?: string; source?: string; follows?: string | null; provider?: string };
  type Body = { modelRoles?: { bindings?: unknown[]; roles?: { memory?: MemoryRow }; roleOptions?: { memory?: unknown[] } }; error?: string };
  const patch = async (body: unknown) => {
    const response = await fetch(`${harness.url}/api/console/settings/models/roles`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Body };
  };
  const harness = await boot();
  try {
    const settings = await (await fetch(`${harness.url}/api/console/settings`)).json() as Body;
    const automatic = settings.modelRoles?.roles?.memory;
    assert.equal(automatic?.source, 'default');
    assert.equal(automatic?.modelId, describeMemoryModel().modelId ?? '', 'the row names the memory route, not the checker row');
    assert.ok(automatic && 'follows' in automatic);
    assert.ok(Array.isArray(settings.modelRoles?.roleOptions?.memory), 'the memory picker has its own options');

    const chosen = await patch({ role: 'memory', modelId: 'glm-5.2' });
    assert.equal(chosen.status, 200, chosen.body.error);
    assert.deepEqual(chosen.body.modelRoles?.bindings, [{ role: 'memory', modelId: 'glm-5.2', scope: 'durable', source: 'settings' }]);
    assert.deepEqual(
      { modelId: chosen.body.modelRoles?.roles?.memory?.modelId, source: chosen.body.modelRoles?.roles?.memory?.source,
        follows: chosen.body.modelRoles?.roles?.memory?.follows },
      { modelId: 'glm-5.2', source: 'settings', follows: null },
    );
    assert.equal(persistedEnvValue('CLEMMY_DEBATE_JUDGE'), undefined, 'the memory model has no side key');

    const refused = await patch({ role: 'memory', modelId: 'not-a-connected-model' });
    assert.equal(refused.status, 400);

    // Memory work reads only the role-wide pick: a per-kind rule is refused
    // rather than saved as a rule nothing reads.
    const scoped = await patch({ role: 'memory', modelId: 'glm-5.2', whenIntent: 'design' });
    assert.equal(scoped.status, 400, 'a memory rule for one kind of work is refused');
    assert.deepEqual(readDurableBindings(), [{ role: 'memory', modelId: 'glm-5.2', scope: 'durable', source: 'settings' }],
      'the role-wide pick is untouched');

    const cleared = await patch({ role: 'memory', clear: true });
    assert.equal(cleared.status, 200, cleared.body.error);
    assert.deepEqual(cleared.body.modelRoles?.bindings, []);
    assert.equal(cleared.body.modelRoles?.roles?.memory?.source, 'default');
  } finally {
    await harness.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// D2 pins (adversarial review 2026-08-26): once session brain pins serve (D1),
// the global flip alone no longer re-routes an already-pinned conversation —
// which would silently break the switcher's promise "applies to your next
// message" for the very conversation the user switched FROM. The route
// therefore accepts an optional sessionId and re-pins exactly that session.
test('active-brain PATCH with sessionId re-pins THAT session; without sessionId no pin is touched', async () => {
  rmSync(path.join(TMP_HOME, '.env'), { force: true });
  const previous = {
    AUTH_MODE: process.env.AUTH_MODE,
    MODEL_ROUTING_MODE: process.env.MODEL_ROUTING_MODE,
    OPENAI_MODEL_PRIMARY: process.env.OPENAI_MODEL_PRIMARY,
  };
  process.env.AUTH_MODE = 'codex_oauth';
  process.env.MODEL_ROUTING_MODE = 'off';
  process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.4';
  __sessionBrainPinTest__.reset();
  // The bare test home has no live provider grants; pin-serve liveness is
  // covered by model-roles-session-pin-live.test.ts. Here the ROUTE seam is
  // under test: which pins a switch stamps and which it must leave alone.
  __sessionBrainPinTest__.setValidatorForTests(() => true);

  const harness = await boot();
  try {
    // Two live conversations, each pinned to the pre-switch global brain.
    pinSessionBrain('sess-switched-from');
    pinSessionBrain('sess-bystander');
    const before = pinnedBrainForSession('sess-bystander');
    assert.equal(before?.modelId, 'gpt-5.4');

    // The user switches brains FROM sess-switched-from (chat header / console
    // section with a session in hand): that one session must follow.
    const switched = await patchActiveBrain(harness.url, {
      brain: 'api_key',
      sessionId: 'sess-switched-from',
    });
    assert.equal(switched.response.status, 200, switched.body.error);
    assert.equal(pinnedBrainForSession('sess-switched-from')?.modelId, 'glm-5.2',
      'the conversation the user switched FROM is re-pinned to the new brain');
    assert.equal(pinnedBrainForSession('sess-bystander')?.modelId, 'gpt-5.4',
      'other live conversations keep their own pinned brain');

    // A Settings-context switch (no sessionId) is global-only: existing pins
    // are left alone in BOTH directions.
    const globalOnly = await patchActiveBrain(harness.url, {
      brain: 'codex_oauth',
      modelId: 'gpt-5.4',
    });
    assert.equal(globalOnly.response.status, 200, globalOnly.body.error);
    assert.equal(pinnedBrainForSession('sess-switched-from')?.modelId, 'glm-5.2',
      'a sessionless switch must not re-pin the previously switched session');
    assert.equal(pinnedBrainForSession('sess-bystander')?.modelId, 'gpt-5.4',
      'a sessionless switch must not touch any existing pin');
  } finally {
    await harness.close();
    __sessionBrainPinTest__.reset();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a newer Codex generation selection persists the exact requested model', async () => {
  const harness = await boot();
  try {
    process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.4';
    const result = await patchActiveBrain(harness.url, { brain: 'codex_oauth', modelId: 'gpt-6-sol' });
    assert.equal(result.response.status, 200, result.body.error);
    assert.equal(process.env.OPENAI_MODEL_PRIMARY, 'gpt-6-sol');
    assert.equal(persistedEnvValue('OPENAI_MODEL_PRIMARY'), 'gpt-6-sol');
  } finally {
    await harness.close();
  }
});

test('a Codex switch fails closed before changing the live or persisted brain when Codex is not signed in', async () => {
  const before = { mode: process.env.AUTH_MODE, routing: process.env.MODEL_ROUTING_MODE };
  process.env.AUTH_MODE = 'claude_oauth';
  rmSync(CODEX_AUTH_FILE, { force: true });
  const server = await boot();
  try {
    const { response, body } = await patchActiveBrain(server.url, { brain: 'codex_oauth' });
    assert.equal(response.status, 409);
    assert.match(String(body.error), /Codex is not signed in/);
    assert.equal((body as { needsLogin?: unknown }).needsLogin, true);
    assert.equal(process.env.AUTH_MODE, 'claude_oauth', 'the live brain did not move');
    assert.equal(process.env.MODEL_ROUTING_MODE, before.routing, 'no routing state moved');
  } finally {
    await server.close();
    signInToCodex();
    if (before.mode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = before.mode;
  }
});
