/**
 * Run: npx tsx --test src/runtime/harness/model-role-options.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

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
  modelRoleOptionCatalogSnapshot,
  roleModelCapability,
  savedRoleModelIdsForProvider,
  _setModelOptionSnapshotObserverForTest,
} = await import('./model-role-options.js');
const {
  captureByoRoutingSnapshot,
  resolveEffectiveProviderForModel,
  resolveEffectiveProviderForModelFromSnapshot,
} = await import('./byo-providers.js');
const { _setRuntimeEnvReadObserverForTest } = await import('../../config.js');
const { _setDiscoveredModelsForTest } = await import('./model-discovery.js');
// Keep this unit file deterministic: provider auth fixtures are fake, so model
// discovery itself is covered separately with injected discoverers.
_setDiscoveredModelsForTest({ anthropic: [], openai: [] });

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

async function withEnvAsync(
  over: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(over)) {
    prev[k] = process.env[k];
    if (over[k] === undefined) delete process.env[k];
    else process.env[k] = over[k];
  }
  try {
    await fn();
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
    codexOauth: { accessToken: 'codex-access', refreshToken: 'codex-refresh' },
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

test('saved dynamic role models remain available while provider discovery is degraded', () => {
  writeAuthFiles();
  _setDiscoveredModelsForTest({ anthropic: [], openai: [] }, 'degraded');
  try {
    withEnv({
      CLEMMY_MODEL_ROLES: JSON.stringify([
        { role: 'worker', modelId: 'gpt-5.6-luna', scope: 'durable', source: 'settings' },
        { role: 'judge', modelId: 'claude-fable-5', scope: 'durable', source: 'settings' },
      ]),
      BYO_MODEL_BASE_URL: '',
      BYO_MODEL_API_KEY: '',
      BYO_MODEL_ID: '',
      BYO_MODEL_JUDGE_ID: '',
      OPENAI_MODEL_WORKER: '',
    }, () => {
      const ids = new Set(connectedModelGroups().flatMap((group) => group.models.map((model) => model.id)));
      assert.equal(ids.has('gpt-5.6-luna'), true);
      assert.equal(ids.has('claude-fable-5'), true);
      assert.deepEqual(validateRoleModelBinding('worker', 'gpt-5.6-luna'), { ok: true, provider: 'codex' });
      assert.deepEqual(validateRoleModelBinding('judge', 'claude-fable-5'), { ok: true, provider: 'claude' });
    });
  } finally {
    _setDiscoveredModelsForTest({ anthropic: [], openai: [] });
  }
});

test('saved role-model parsing is provider-scoped and ignores malformed bindings', () => {
  const raw = JSON.stringify([
    { role: 'worker', modelId: 'gpt-5.6-luna' },
    { role: 'judge', modelId: 'claude-fable-5' },
    { role: 'brain', modelId: 'gpt-5.6-sol' },
    { role: 'worker', modelId: 'deepseek-chat' },
    { role: 'worker', modelId: '' },
  ]);
  assert.deepEqual(savedRoleModelIdsForProvider(raw, 'codex'), ['gpt-5.6-luna']);
  assert.deepEqual(savedRoleModelIdsForProvider(raw, 'claude'), ['claude-fable-5']);
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

test('200-model settings catalog captures runtime provider state once, preserves output, and yields promptly', async () => {
  writeAuthFiles();
  const modelIds = Array.from({ length: 200 }, (_, index) => `together-org/model-${index}`);
  const firstRegistry = JSON.stringify([
    {
      id: 'together',
      label: 'Together',
      baseURL: 'https://api.together.test/v1',
      modelIds,
    },
  ]);
  await withEnvAsync({
    MODEL_ROUTING_MODE: 'off',
    BYO_MODEL_BASE_URL: '',
    BYO_MODEL_API_KEY: '',
    BYO_MODEL_ID: '',
    BYO_MODEL_JUDGE_ID: '',
    BYO_MODEL_PROVIDER: '',
    OPENAI_MODEL_WORKER: '',
    BYO_PROVIDERS: firstRegistry,
    BYO_PROVIDER_TOGETHER_API_KEY: 'together-key',
    BYO_PROVIDER_SECOND_API_KEY: 'second-key',
  }, async () => {
    let providerCaptures = 0;
    let runtimeEnvReads = 0;
    const runtimeEnvReadsByKey = new Map<string, number>();
    let observation: { providerCount: number; configuredProviderCount: number; modelCount: number } | undefined;
    _setModelOptionSnapshotObserverForTest((next) => {
      providerCaptures += 1;
      observation = next;
    });
    _setRuntimeEnvReadObserverForTest((key) => {
      runtimeEnvReads += 1;
      runtimeEnvReadsByKey.set(key, (runtimeEnvReadsByKey.get(key) ?? 0) + 1);
    });

    const startedAt = performance.now();
    const immediateLag = new Promise<number>((resolve) => {
      setImmediate(() => resolve(performance.now() - startedAt));
    });
    let catalog: ReturnType<typeof modelRoleOptionCatalogSnapshot>;
    try {
      catalog = modelRoleOptionCatalogSnapshot();
    } finally {
      _setRuntimeEnvReadObserverForTest(null);
      _setModelOptionSnapshotObserverForTest(null);
    }
    const synchronousMs = performance.now() - startedAt;
    const yieldedAfterMs = await immediateLag;

    assert.equal(providerCaptures, 1, 'one settings derivation captures provider/env state once');
    assert.deepEqual(observation, {
      providerCount: 1,
      configuredProviderCount: 1,
      modelCount: 200,
    });
    assert.equal(runtimeEnvReadsByKey.get('BYO_PROVIDERS'), 1,
      'the provider registry is captured exactly once for the whole settings catalog');
    assert.ok(runtimeEnvReads < 40,
      `runtime env reads stay bounded by provider count, not 200 models (got ${runtimeEnvReads})`);
    assert.ok(synchronousMs < 750,
      `200-model derivation must not monopolize the event loop (took ${synchronousMs.toFixed(1)}ms)`);
    assert.ok(yieldedAfterMs < 1_000,
      `a queued immediate must run promptly after settings derivation (lag ${yieldedAfterMs.toFixed(1)}ms)`);

    const availableByo = catalog.available.find((group) => group.providerId === 'together');
    const workerByo = catalog.roleOptions.worker.find((group) => group.providerId === 'together');
    const judgeByo = catalog.roleOptions.judge.find((group) => group.providerId === 'together');
    assert.deepEqual(availableByo?.models.map((model) => model.id), modelIds);
    assert.deepEqual(workerByo?.models.map((model) => model.id), modelIds);
    assert.deepEqual(judgeByo?.models.map((model) => model.id), modelIds);
    assert.deepEqual(
      catalog.brainOptions.filter((option) => option.providerId === 'together').map((option) => option.modelId),
      modelIds,
    );
    assert.deepEqual(catalog.providerSnapshots, [{
      id: 'together',
      label: 'Together',
      baseURL: 'https://api.together.test/v1',
      modelIds,
      hasKey: true,
      configured: true,
      isDefault: false,
    }]);

    // The composite request result stays byte/deep-equivalent to the legacy
    // public derivations; they now just capture their own one-request context.
    assert.deepEqual(catalog.available, connectedModelGroups());
    assert.deepEqual(catalog.roleOptions.worker, connectedModelGroupsForRole('worker'));
    assert.deepEqual(catalog.roleOptions.judge, connectedModelGroupsForRole('judge'));
    assert.deepEqual(catalog.brainOptions, brainOptions());

    // No cross-request memo: a live environment flip is visible on the very
    // next derivation without a daemon restart.
    process.env.BYO_PROVIDERS = JSON.stringify([{
      id: 'second',
      label: 'Second',
      baseURL: 'https://api.second.test/v1',
      modelIds: ['second/model'],
    }]);
    const refreshed = modelRoleOptionCatalogSnapshot();
    assert.equal(refreshed.brainOptions.some((option) => option.modelId === modelIds[0]), false);
    assert.equal(refreshed.brainOptions.some((option) => option.modelId === 'second/model'), true);
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
    if (!codex.ok) assert.match(codex.reason, /Codex-family ids stay on the BYO backend in all-in/);
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
  // Alexander's real config class: OPENAI_MODEL_PRIMARY repurposed to glm-5.2. The
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

// Hybrid stacks (owner ask, 2026-07-24: "kimi with cheap workers but a really
// good judge"): all-in collapses DEFAULTS to the BYO backend, but an EXPLICIT
// binding to a CONNECTED OAuth family is honored — restoring never-self-grade.
// Disconnected families stay refused.
test('all_in honors an explicit judge binding to a CONNECTED OAuth family; disconnected stays refused', () => {
  writeAuthFiles(); // codex + claude subscription tokens present
  withEnv({
    BYO_MODEL_BASE_URL: 'https://api.moonshot.test/v1',
    BYO_MODEL_ID: 'kimi-k3',
    BYO_MODEL_API_KEY: 'key',
    MODEL_ROUTING_MODE: 'all_in',
    AUTH_MODE: 'api_key',
  }, () => {
    const claudeJudge = roleModelCapability('judge', 'claude-opus-4-8');
    assert.equal(claudeJudge.ok, true, 'connected Claude login can judge a BYO brain');
    if (claudeJudge.ok) assert.equal(claudeJudge.provider, 'claude');
  });

  blockClaudeKeychainFallback(); // demote to a non-subscription token → disconnected
  withEnv({
    BYO_MODEL_BASE_URL: 'https://api.moonshot.test/v1',
    BYO_MODEL_ID: 'kimi-k3',
    BYO_MODEL_API_KEY: 'key',
    MODEL_ROUTING_MODE: 'all_in',
    AUTH_MODE: 'api_key',
  }, () => {
    const claudeJudge = roleModelCapability('judge', 'claude-opus-4-8');
    assert.equal(claudeJudge.ok, false, 'a disconnected family is still refused');
    if (!claudeJudge.ok) assert.match(claudeJudge.reason, /needs a connected Claude login/);
  });
  writeAuthFiles(); // restore for any later tests
});

// 2026-07-24, two-pass history: the wire collapse first CRASHED tool paths
// (2.7.0 space runner) and, once scoped away, silently REWROTE a workflow's
// Sonnet pin to GLM at dispatch. With the per-request transport router
// (v2.7.3) making the claude lane tool-capable, an explicit claude id now
// resolves 'claude' at the wire too — validation and dispatch tell ONE truth.
test('all_in: claude judge binding validates as claude while the wire classifier still collapses to byo', () => {
  writeAuthFiles();
  withEnv({
    BYO_MODEL_BASE_URL: 'https://api.moonshot.test/v1',
    BYO_MODEL_ID: 'kimi-k3',
    BYO_MODEL_API_KEY: 'key',
    MODEL_ROUTING_MODE: 'all_in',
    AUTH_MODE: 'api_key',
  }, () => {
    const routingSnapshot = captureByoRoutingSnapshot();
    assert.equal(routingSnapshot.claudeAvailable, true, 'fixture exercises the connected OAuth lane');
    const validation = roleModelCapability('judge', 'claude-opus-4-8');
    assert.equal(validation.ok, true);
    if (validation.ok) assert.equal(validation.provider, 'claude');
    assert.equal(
      resolveEffectiveProviderForModelFromSnapshot('claude-opus-4-8', routingSnapshot),
      resolveEffectiveProviderForModel('claude-opus-4-8'),
      'the request-scoped helper and public canonical wrapper agree for OAuth routing',
    );
    assert.equal(
      resolveEffectiveProviderForModel('claude-opus-4-8'),
      'claude',
      'explicit claude ids dispatch on the claude lane — never a silent substitute',
    );
  });
});
