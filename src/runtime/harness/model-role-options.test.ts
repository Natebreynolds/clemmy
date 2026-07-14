/**
 * Run: npx tsx --test src/runtime/harness/model-role-options.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-model-options-test-'));
process.env.CLEMENTINE_HOME = home;

const {
  connectedModelGroups,
  connectedModelGroupsForRole,
  validateRoleModelBinding,
  brainOptions,
  effectiveBrain,
  effectiveBrainValue,
  falloverBrainModelIds,
  roleModelCapability,
} = await import('./model-role-options.js');

function withEnv(over: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(over)) {
    prev[k] = process.env[k];
    if (over[k] === undefined) delete process.env[k];
    else process.env[k] = over[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(over)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

function writeAuthFiles(): void {
  const state = path.join(home, 'state');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'auth.json'), JSON.stringify({
    source: 'native',
    codexOauth: { grantProvenance: 'clementine-oauth-v1', grantId: 'grant-model-role-options-test', accessToken: 'codex-access', refreshToken: 'codex-refresh' },
  }), 'utf-8');
  writeFileSync(path.join(state, 'claude-auth.json'), JSON.stringify({
    accessToken: 'sk-ant-oat01-test',
    refreshToken: 'claude-refresh',
    expiresAt: Date.now() + 60 * 60 * 1000,
  }), 'utf-8');
}

function blockClaudeKeychainFallback(): void {
  const state = path.join(home, 'state');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'claude-auth.json'), JSON.stringify({
    accessToken: 'sk-ant-api03-not-a-subscription-token',
  }), 'utf-8');
}

test('validateRoleModelBinding rejects roles when no providers are connected', () => {
  blockClaudeKeychainFallback();
  withEnv({
    BYO_MODEL_BASE_URL: '',
    BYO_MODEL_API_KEY: '',
    BYO_MODEL_ID: '',
    BYO_MODEL_JUDGE_ID: '',
    OPENAI_MODEL_WORKER: '',
  }, () => {
    assert.deepEqual(connectedModelGroups(), []);
    const v = validateRoleModelBinding('worker', 'deepseek-chat');
    assert.equal(v.ok, false);
  });
});

test('connected model catalog includes authenticated Codex/Claude and configured BYO ids', () => {
  writeAuthFiles();
  withEnv({
    BYO_MODEL_BASE_URL: 'https://api.example.test',
    BYO_MODEL_API_KEY: 'k',
    BYO_MODEL_ID: 'deepseek-chat',
    BYO_MODEL_JUDGE_ID: 'minimax-judge',
    OPENAI_MODEL_WORKER: 'qwen-worker',
  }, () => {
    const ids = new Set(connectedModelGroups().flatMap((g) => g.models.map((m) => m.id)));
    assert.equal(ids.has('gpt-5.4-nano'), true);
    assert.equal(ids.has('gpt-5.4'), true);
    assert.equal(ids.has('claude-opus-4-8'), true);
    assert.equal(ids.has('deepseek-chat'), true);
    assert.equal(ids.has('minimax-judge'), true);
    assert.equal(ids.has('qwen-worker'), true);

    // Multi-provider: a connected provider's models can serve ANY non-brain
    // role — worker vs judge is the user's pick now, not a per-env-var split.
    // So all three configured BYO ids are available for BOTH worker and judge.
    const workerIds = new Set(connectedModelGroupsForRole('worker').flatMap((g) => g.models.map((m) => m.id)));
    const judgeIds = new Set(connectedModelGroupsForRole('judge').flatMap((g) => g.models.map((m) => m.id)));
    assert.equal(workerIds.has('deepseek-chat'), true);
    assert.equal(workerIds.has('qwen-worker'), true);
    assert.equal(workerIds.has('minimax-judge'), true);
    assert.equal(judgeIds.has('deepseek-chat'), true);
    assert.equal(judgeIds.has('minimax-judge'), true);
    assert.equal(judgeIds.has('qwen-worker'), true);

    assert.deepEqual(validateRoleModelBinding('worker', 'claude-sonnet-4-6'), { ok: true, provider: 'claude' });
    assert.deepEqual(validateRoleModelBinding('worker', 'deepseek-chat'), { ok: true, provider: 'byo' });
    assert.deepEqual(validateRoleModelBinding('worker', 'qwen-worker'), { ok: true, provider: 'byo' });
    assert.deepEqual(validateRoleModelBinding('worker', 'minimax-judge'), { ok: true, provider: 'byo' });
    assert.deepEqual(validateRoleModelBinding('judge', 'minimax-judge'), { ok: true, provider: 'byo' });
    assert.deepEqual(validateRoleModelBinding('judge', 'deepseek-chat'), { ok: true, provider: 'byo' });
    assert.deepEqual(validateRoleModelBinding('judge', 'qwen-worker'), { ok: true, provider: 'byo' });
    // an id no connected provider offers still rejects (no over-acceptance)
    assert.equal(validateRoleModelBinding('judge', 'not-connected').ok, false);
    assert.equal(validateRoleModelBinding('worker', 'not-connected').ok, false);
  });
});

test('multi-provider: picker lists every model across all connected BYO providers', () => {
  writeAuthFiles();
  withEnv({
    // 'default' = the legacy slot; minimax + deepseek = extra registry providers
    BYO_MODEL_BASE_URL: 'https://api.z.ai/api/paas/v4', BYO_MODEL_ID: 'glm-5.2',
    BYO_MODEL_API_KEY: 'zai-key', BYO_MODEL_PROVIDER: 'GLM (Z.ai)',
    BYO_MODEL_JUDGE_ID: '', OPENAI_MODEL_WORKER: '',
    BYO_PROVIDERS: JSON.stringify([
      { id: 'minimax', label: 'MiniMax', baseURL: 'https://api.minimax.io/v1', modelIds: ['MiniMax-M3'] },
      { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com', modelIds: ['deepseek-chat'] },
    ]),
    BYO_PROVIDER_MINIMAX_API_KEY: 'mm-key',
    BYO_PROVIDER_DEEPSEEK_API_KEY: 'ds-key',
  }, () => {
    const byoGroups = connectedModelGroups().filter((g) => g.provider === 'byo');
    assert.equal(byoGroups.length, 3, 'one group per connected provider');
    const byId = new Map(byoGroups.map((g) => [g.providerId, g] as const));
    assert.equal(byId.get('default')?.label, 'GLM (Z.ai)');
    assert.deepEqual(byId.get('default')?.models.map((m) => m.id), ['glm-5.2']);
    assert.equal(byId.get('minimax')?.label, 'MiniMax');
    assert.deepEqual(byId.get('minimax')?.models.map((m) => m.id), ['MiniMax-M3']);
    assert.deepEqual(byId.get('deepseek')?.models.map((m) => m.id), ['deepseek-chat']);
    // every connected provider's model is bindable to any non-brain role
    assert.equal(validateRoleModelBinding('judge', 'MiniMax-M3').ok, true);
    assert.equal(validateRoleModelBinding('worker', 'deepseek-chat').ok, true);
    assert.equal(validateRoleModelBinding('judge', 'glm-5.2').ok, true);
  });
});

test('multi-provider: a provider with no saved key is not offered', () => {
  writeAuthFiles();
  withEnv({
    BYO_MODEL_BASE_URL: 'https://api.z.ai/api/paas/v4', BYO_MODEL_ID: 'glm-5.2',
    BYO_MODEL_API_KEY: 'zai-key', BYO_MODEL_PROVIDER: 'GLM (Z.ai)',
    BYO_MODEL_JUDGE_ID: '', OPENAI_MODEL_WORKER: '',
    BYO_PROVIDERS: JSON.stringify([{ id: 'minimax', label: 'MiniMax', baseURL: 'https://api.minimax.io/v1', modelIds: ['MiniMax-M3'] }]),
    BYO_PROVIDER_MINIMAX_API_KEY: '', // minimax has NO key
  }, () => {
    const byoGroups = connectedModelGroups().filter((g) => g.provider === 'byo');
    assert.deepEqual(byoGroups.map((g) => g.providerId), ['default'], 'unkeyed provider is hidden');
    assert.equal(validateRoleModelBinding('worker', 'MiniMax-M3').ok, false, 'cannot bind an unkeyed provider model');
    assert.equal(validateRoleModelBinding('worker', 'glm-5.2').ok, true);
  });
});

// --- "UI matches available models + combinations" audit ---------------------

test('worker/judge dropdowns list EVERY connected model (Codex + Claude + all BYO)', () => {
  writeAuthFiles(); // Codex + Claude both logged in
  withEnv({
    BYO_MODEL_BASE_URL: 'https://api.z.ai/api/paas/v4', BYO_MODEL_ID: 'glm-5.2',
    BYO_MODEL_API_KEY: 'zai-key', BYO_MODEL_PROVIDER: 'GLM (Z.ai)',
    BYO_MODEL_JUDGE_ID: '', OPENAI_MODEL_WORKER: '',
    BYO_PROVIDERS: JSON.stringify([{ id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com', modelIds: ['deepseek-chat'] }]),
    BYO_PROVIDER_DEEPSEEK_API_KEY: 'ds-key',
  }, () => {
    for (const role of ['worker', 'judge'] as const) {
      const groups = connectedModelGroupsForRole(role);
      const providers = new Set(groups.map((g) => g.provider));
      assert.ok(providers.has('codex'), `${role}: Codex offered`);
      assert.ok(providers.has('claude'), `${role}: Claude offered`);
      assert.ok(providers.has('byo'), `${role}: BYO offered`);
      const ids = new Set(groups.flatMap((g) => g.models.map((m) => m.id)));
      assert.ok(ids.has('glm-5.2'), `${role}: GLM model present`);
      assert.ok(ids.has('deepseek-chat'), `${role}: DeepSeek model present`);
      assert.ok(ids.has('gpt-5.4') || ids.has('gpt-5.5'), `${role}: a Codex model present`);
    }
  });
});

test('brainOptions includes a BYO brain when configured; effectiveBrain reflects all-in', () => {
  writeAuthFiles();
  withEnv({
    BYO_MODEL_BASE_URL: 'https://api.z.ai/api/paas/v4', BYO_MODEL_ID: 'glm-5.2',
    BYO_MODEL_API_KEY: 'zai-key', BYO_MODEL_PROVIDER: 'GLM (Z.ai)',
    MODEL_ROUTING_MODE: 'all_in', AUTH_MODE: 'api_key',
  }, () => {
    const opts = brainOptions();
    const byId = new Map(opts.map((o) => [o.id, o] as const));
    assert.equal(byId.get('codex_oauth')?.available, true);
    assert.equal(byId.get('claude_oauth')?.available, true);
    assert.equal(byId.get('api_key')?.available, true, 'BYO is a brain option');
    assert.equal(byId.get('api_key')?.modelId, 'glm-5.2');
    assert.equal(effectiveBrain(), 'api_key', 'all-in BYO → BYO is the brain');
  });
});

test('all_in is provider-isolated and gpt-shaped BYO ids remain BYO in role/UI reporting', () => {
  withEnv({
    BYO_MODEL_BASE_URL: 'https://api.together.test/v1',
    BYO_MODEL_ID: 'gpt-4o',
    BYO_MODEL_API_KEY: 'key',
    MODEL_ROUTING_MODE: 'all_in',
    AUTH_MODE: 'api_key',
  }, () => {
    assert.deepEqual(roleModelCapability('worker', 'gpt-4o'), { ok: true, provider: 'byo' });
    assert.equal(effectiveBrain(), 'api_key');
    assert.equal(effectiveBrainValue(), 'api_key:gpt-4o');
    const codex = roleModelCapability('worker', 'gpt-5.6');
    assert.equal(codex.ok, false);
    if (!codex.ok) assert.match(codex.reason, /not offered by any connected provider/);
  });
});

test('role selection rejects built-in/BYO and multi-BYO identity collisions', () => {
  withEnv({
    MODEL_ROUTING_MODE: 'off',
    BYO_MODEL_BASE_URL: '',
    BYO_MODEL_ID: '',
    BYO_MODEL_API_KEY: '',
    BYO_PROVIDERS: JSON.stringify([
      { id: 'together', label: 'Together', baseURL: 'https://api.together.test/v1', modelIds: ['gpt-4o', 'shared-model'] },
      { id: 'second', label: 'Second', baseURL: 'https://api.second.test/v1', modelIds: ['shared-model'] },
    ]),
    BYO_PROVIDER_TOGETHER_API_KEY: 'together-key',
    BYO_PROVIDER_SECOND_API_KEY: 'second-key',
  }, () => {
    const builtIn = roleModelCapability('worker', 'gpt-4o');
    assert.equal(builtIn.ok, false);
    if (!builtIn.ok) assert.match(builtIn.reason, /both Codex and BYO provider Together/);

    const multiByo = validateRoleModelBinding('judge', 'shared-model');
    assert.equal(multiByo.ok, false);
    if (!multiByo.ok) assert.match(multiByo.reason, /multiple connected BYO providers/);

    const offered = connectedModelGroupsForRole('worker').flatMap((group) => group.models.map((model) => model.id));
    assert.equal(offered.includes('gpt-4o'), false, 'ambiguous built-in/BYO id is not selectable');
    assert.equal(offered.includes('shared-model'), false, 'ambiguous multi-BYO id is not selectable');
    assert.equal(brainOptions().some((option) => option.id === 'api_key' && option.modelId === 'shared-model'), false,
      'ambiguous multi-BYO id is not selectable as the brain');
  });
});

test('brainOptions hides BYO when no backend; effectiveBrain follows AUTH_MODE off all-in', () => {
  writeAuthFiles();
  withEnv({
    BYO_MODEL_BASE_URL: '', BYO_MODEL_ID: '', BYO_MODEL_API_KEY: '',
    MODEL_ROUTING_MODE: 'off', AUTH_MODE: 'codex_oauth',
  }, () => {
    assert.equal(brainOptions().some((o) => o.id === 'api_key'), false, 'no BYO brain option without a backend');
    assert.equal(effectiveBrain(), 'codex_oauth');
  });
});

test('brainOptions offers SPECIFIC Codex models (codex_oauth:<id>) so the brain can be pinned to gpt-5.5 vs gpt-5.4', () => {
  writeAuthFiles();
  // The polluted real-world case: a BYO id left in the OPENAI_MODEL_* slot while
  // the brain is Codex. The picker must still offer the real gpt-5.x models, and
  // effectiveBrainValue must stay one of them (the codexSafePrimary fallback).
  withEnv({
    BYO_MODEL_BASE_URL: 'https://api.z.ai/api/paas/v4', BYO_MODEL_ID: 'glm-5.2',
    BYO_MODEL_API_KEY: 'zai-key', BYO_MODEL_PROVIDER: 'GLM (Z.ai)',
    OPENAI_MODEL_PRIMARY: 'glm-5.2', MODEL_ROUTING_MODE: 'off', AUTH_MODE: 'codex_oauth',
  }, () => {
    const opts = brainOptions();
    const codexValues = opts.filter((o) => o.id === 'codex_oauth').map((o) => o.value);
    assert.ok(codexValues.includes('codex_oauth:gpt-5.5'), 'gpt-5.5 is a selectable Codex brain');
    assert.ok(codexValues.includes('codex_oauth:gpt-5.4'), 'gpt-5.4 is a selectable Codex brain');
    // The invariant: the highlighted value is always a real picker option. With the
    // slot polluted by glm-5.2, the Codex brain resolves to the gpt-5.4 default.
    const value = effectiveBrainValue();
    assert.ok(value.startsWith('codex_oauth:'), `codex brain value is model-specific, got ${value}`);
    assert.ok(opts.map((o) => o.value).includes(value), `effectiveBrainValue ${value} must be a real option`);
  });
});

test('falloverBrainModelIds — Claude→Codex→GLM order, excludes current, [] in all_in', () => {
  writeAuthFiles(); // codex + claude OAuth present
  const byoEnv = {
    BYO_MODEL_BASE_URL: 'https://api.z.ai/api/paas/v4',
    BYO_MODEL_API_KEY: 'k',
    BYO_MODEL_ID: 'glm-5.2',
  };

  // Brain = Claude, overload → next targets are Codex then GLM (claude excluded).
  withEnv({ ...byoEnv, MODEL_ROUTING_MODE: 'off', AUTH_MODE: 'claude_oauth' }, () => {
    const chain = falloverBrainModelIds('claude');
    assert.deepEqual(chain.map((c) => c.provider), ['codex', 'byo'], 'Claude falls to Codex then GLM');
    assert.equal(chain.find((c) => c.provider === 'byo')?.modelId, 'glm-5.2');
    assert.equal(chain.some((c) => c.provider === 'claude'), false, 'never includes the current brain');
  });

  // Brain = Codex → Claude then GLM.
  withEnv({ ...byoEnv, MODEL_ROUTING_MODE: 'off', AUTH_MODE: 'codex_oauth' }, () => {
    assert.deepEqual(falloverBrainModelIds('codex').map((c) => c.provider), ['claude', 'byo']);
  });

  // all_in (BYO-only) → no cross-provider targets.
  withEnv({ ...byoEnv, MODEL_ROUTING_MODE: 'all_in', AUTH_MODE: 'codex_oauth' }, () => {
    assert.deepEqual(falloverBrainModelIds('byo'), []);
  });

  // No BYO configured → Claude falls to Codex only.
  withEnv({ BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '', BYO_MODEL_ID: '', MODEL_ROUTING_MODE: 'off', AUTH_MODE: 'claude_oauth' }, () => {
    assert.deepEqual(falloverBrainModelIds('claude').map((c) => c.provider), ['codex']);
  });
});

test('falloverBrainModelIds — a repurposed OPENAI_MODEL_PRIMARY (BYO id) cannot knock connected Codex out of the chain', () => {
  writeAuthFiles(); // codex + claude OAuth present
  // Nathan's real config class: OPENAI_MODEL_PRIMARY repurposed to glm-5.2. The
  // codex slot used to borrow that id verbatim, resolve to BYO, and get dropped
  // by the mis-route guard — Codex silently vanished from claude→X recovery
  // (observed 2026-07-02: every recovery went straight to glm-5.2).
  withEnv({
    BYO_MODEL_BASE_URL: 'https://api.z.ai/api/paas/v4',
    BYO_MODEL_API_KEY: 'k',
    BYO_MODEL_ID: 'glm-5.2',
    OPENAI_MODEL_PRIMARY: 'glm-5.2',
    MODEL_ROUTING_MODE: 'off',
    AUTH_MODE: 'claude_oauth',
  }, () => {
    const chain = falloverBrainModelIds('claude');
    assert.deepEqual(chain.map((c) => c.provider), ['codex', 'byo'], 'Codex must survive the repurposed primary slot');
    const codex = chain.find((c) => c.provider === 'codex');
    assert.notEqual(codex?.modelId, 'glm-5.2', 'the codex entry must not carry a BYO id');
  });
});
