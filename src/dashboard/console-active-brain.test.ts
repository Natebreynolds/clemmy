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
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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

async function boot() {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => true, {} as never, { serveLegacyAtRoot: false });
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
