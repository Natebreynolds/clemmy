import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getByoProviders, resolveByoProviderForModel,
  byoProviderKeyEnvKey, slugifyProviderId, serializeExtraProviders, getByoProviderSnapshots,
  normalizeModelsList,
} from './byo-providers.js';

// These read process.env (getRuntimeEnv checks process.env before BASE_DIR/.env),
// so set the registry + keys via process.env and restore after each test.
// The 'default' provider IS the legacy BYO_MODEL_* slot; extra providers live in
// the BYO_PROVIDERS JSON registry. Keys come from env (vault file absent in CI).
const ENV_KEYS = [
  'BYO_PROVIDERS', 'BYO_MODEL_BASE_URL', 'BYO_MODEL_ID', 'BYO_MODEL_JUDGE_ID',
  'BYO_MODEL_API_KEY', 'BYO_MODEL_PROVIDER', 'OPENAI_MODEL_WORKER',
  'BYO_PROVIDER_MINIMAX_API_KEY', 'BYO_PROVIDER_DEEPSEEK_API_KEY',
  'BYO_PROVIDER_TOGETHER_API_KEY',
];
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // MASK with '' rather than delete: getRuntimeEnv returns process.env[key] ??
  // <.env files>, so a deleted key falls through to the developer's live
  // ~/.clementine-next/.env (which may have real BYO_PROVIDERS/keys) and pollutes
  // the test. '' is a defined value that masks the .env (and reads as unset for
  // the configured/JSON checks). Keeps local runs == CI's clean env.
  for (const k of ENV_KEYS) process.env[k] = '';
  for (const [k, v] of Object.entries(vars)) { if (v !== undefined) process.env[k] = v; }
  try { fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  }
}

const ZAI = 'https://api.z.ai/api/paas/v4';
const MINIMAX = 'https://api.minimax.io/v1';
const DEEPSEEK = 'https://api.deepseek.com';
const TOGETHER = 'https://api.together.ai/v1';

// 'default' = the legacy single backend; extras = the BYO_PROVIDERS registry.
const DEFAULT_ENV = {
  BYO_MODEL_BASE_URL: ZAI, BYO_MODEL_ID: 'glm-5.2', BYO_MODEL_API_KEY: 'zai-key', BYO_MODEL_PROVIDER: 'GLM (Z.ai)',
};
const EXTRAS = JSON.stringify([
  { id: 'minimax', label: 'MiniMax', baseURL: MINIMAX, modelIds: ['MiniMax-M3'] },
  { id: 'deepseek', label: 'DeepSeek', baseURL: DEEPSEEK, modelIds: ['deepseek-chat'] },
]);

test('each model id routes to its OWN provider (GLM brain / DeepSeek worker / MiniMax judge)', () => {
  withEnv({
    ...DEFAULT_ENV,
    BYO_PROVIDERS: EXTRAS,
    BYO_PROVIDER_MINIMAX_API_KEY: 'minimax-key',
    BYO_PROVIDER_DEEPSEEK_API_KEY: 'deepseek-key',
  }, () => {
    assert.equal(resolveByoProviderForModel('glm-5.2')?.baseURL, ZAI);
    assert.equal(resolveByoProviderForModel('MiniMax-M3')?.baseURL, MINIMAX, 'MiniMax judge hits MiniMax, not Z.ai');
    assert.equal(resolveByoProviderForModel('deepseek-chat')?.baseURL, DEEPSEEK);
    // keys come from each provider's own slot
    assert.equal(resolveByoProviderForModel('MiniMax-M3')?.apiKey, 'minimax-key');
    assert.equal(resolveByoProviderForModel('glm-5.2')?.apiKey, 'zai-key');
    assert.equal(resolveByoProviderForModel('MiniMax-M3')?.configured, true);
  });
});

test('a non-default provider takes precedence over the legacy default for a shared id', () => {
  withEnv({
    BYO_MODEL_BASE_URL: ZAI, BYO_MODEL_ID: 'glm-5.2', BYO_MODEL_JUDGE_ID: 'MiniMax-M3', BYO_MODEL_API_KEY: 'zai-key',
    BYO_PROVIDERS: JSON.stringify([{ id: 'minimax', label: 'MiniMax', baseURL: MINIMAX, modelIds: ['MiniMax-M3'] }]),
    BYO_PROVIDER_MINIMAX_API_KEY: 'minimax-key',
  }, () => {
    // default's stale judge id (MiniMax-M3) is overridden by the real MiniMax provider
    assert.equal(resolveByoProviderForModel('MiniMax-M3')?.baseURL, MINIMAX);
  });
});

test('a single provider owns everything (byte-identical single-backend behavior)', () => {
  withEnv({ BYO_MODEL_BASE_URL: ZAI, BYO_MODEL_ID: 'glm-5.2', BYO_MODEL_API_KEY: 'zai-key' }, () => {
    assert.equal(resolveByoProviderForModel('glm-5.2')?.baseURL, ZAI);
    // an id not in the list still resolves to the only provider
    assert.equal(resolveByoProviderForModel('some-other-model')?.baseURL, ZAI);
  });
});

test('primaryId is the PROVIDER\'s own model, never the requested id (all_in codex-collapse safety)', () => {
  // REGRESSION GUARD: the router's all_in branch does
  //   id = resolveProvider(name)==='codex' ? (backend.primaryId || name) : name
  // so backend.primaryId MUST be the BYO model (glm-5.2), NOT the requested gpt-*
  // id — else a gpt-* id is sent verbatim to the GLM endpoint and the call fails
  // (this breaks the grounding/goal-fidelity gates, which request MODELS.fast).
  withEnv({ BYO_MODEL_BASE_URL: ZAI, BYO_MODEL_ID: 'glm-5.2', BYO_MODEL_API_KEY: 'zai-key' }, () => {
    // a stray codex-shaped id resolves to the single provider, but primaryId
    // stays the provider's own model so the collapse remaps correctly
    assert.equal(resolveByoProviderForModel('gpt-5.4-mini')?.primaryId, 'glm-5.2');
    assert.equal(resolveByoProviderForModel('glm-5.2')?.primaryId, 'glm-5.2');
  });
  // multi-provider: a model's OWN provider config still reports that provider's primary
  withEnv({
    ...DEFAULT_ENV, BYO_PROVIDERS: EXTRAS,
    BYO_PROVIDER_MINIMAX_API_KEY: 'mm', BYO_PROVIDER_DEEPSEEK_API_KEY: 'ds',
  }, () => {
    assert.equal(resolveByoProviderForModel('MiniMax-M3')?.primaryId, 'MiniMax-M3');
    assert.equal(resolveByoProviderForModel('deepseek-chat')?.primaryId, 'deepseek-chat');
  });
});

test('an unclaimed id with multiple providers returns undefined (caller falls back to legacy)', () => {
  withEnv({
    ...DEFAULT_ENV, BYO_PROVIDERS: EXTRAS,
    BYO_PROVIDER_MINIMAX_API_KEY: 'k', BYO_PROVIDER_DEEPSEEK_API_KEY: 'k',
  }, () => {
    assert.equal(resolveByoProviderForModel('totally-unknown-xyz'), undefined);
  });
});

test('migration: legacy BYO_MODEL_* with no registry is the single "default" provider', () => {
  withEnv({
    BYO_MODEL_BASE_URL: ZAI, BYO_MODEL_ID: 'glm-5.2', BYO_MODEL_JUDGE_ID: 'glm-4.6',
    BYO_MODEL_API_KEY: 'zai-key', BYO_MODEL_PROVIDER: 'GLM (Z.ai)', OPENAI_MODEL_WORKER: 'glm-5.2',
  }, () => {
    const providers = getByoProviders();
    assert.equal(providers.length, 1);
    assert.equal(providers[0].id, 'default');
    assert.equal(providers[0].baseURL, ZAI);
    assert.deepEqual([...providers[0].modelIds].sort(), ['glm-4.6', 'glm-5.2']);
    assert.equal(resolveByoProviderForModel('glm-5.2')?.baseURL, ZAI);
    assert.equal(resolveByoProviderForModel('glm-5.2')?.apiKey, 'zai-key');
  });
});

test('the "default" id inside BYO_PROVIDERS is ignored (default always comes from the legacy slot)', () => {
  withEnv({
    ...DEFAULT_ENV,
    BYO_PROVIDERS: JSON.stringify([{ id: 'default', label: 'spoof', baseURL: 'https://evil.test', modelIds: ['glm-5.2'] }]),
  }, () => {
    // glm-5.2 still routes to the real legacy default, not the spoofed registry entry
    assert.equal(resolveByoProviderForModel('glm-5.2')?.baseURL, ZAI);
    assert.equal(getByoProviders().filter((p) => p.id === 'default').length, 1);
  });
});

test('empty id is never resolved', () => {
  withEnv({ ...DEFAULT_ENV, BYO_PROVIDERS: EXTRAS }, () => {
    assert.equal(resolveByoProviderForModel(''), undefined);
    assert.equal(resolveByoProviderForModel('   '), undefined);
  });
});

// ── persistence helpers ──────────────────────────────────────────────────

test('byoProviderKeyEnvKey: default reuses the legacy slot; others get a per-id slot', () => {
  assert.equal(byoProviderKeyEnvKey('default'), 'BYO_MODEL_API_KEY');
  assert.equal(byoProviderKeyEnvKey('minimax'), 'BYO_PROVIDER_MINIMAX_API_KEY');
  assert.equal(byoProviderKeyEnvKey('z-ai'), 'BYO_PROVIDER_Z_AI_API_KEY');
});

test('slugifyProviderId: stable, lowercased, never collides with "default"', () => {
  assert.equal(slugifyProviderId('GLM (Z.ai)'), 'glm-z-ai');
  assert.equal(slugifyProviderId('MiniMax'), 'minimax');
  assert.equal(slugifyProviderId('default'), 'provider'); // reserved
  assert.equal(slugifyProviderId(''), 'provider');
});

test('serializeExtraProviders: drops the default and keeps only registry fields', () => {
  const json = serializeExtraProviders([
    { id: 'default', label: 'GLM', baseURL: 'https://z', modelIds: ['glm-5.2'] },
    { id: 'minimax', label: 'MiniMax', baseURL: 'https://m', modelIds: ['MiniMax-M3'] },
  ]);
  const parsed = JSON.parse(json) as Array<{ id: string }>;
  assert.deepEqual(parsed.map((p) => p.id), ['minimax']);
});

test('getByoProviderSnapshots: hasKey/configured/isDefault reflect the stored keys', () => {
  withEnv({
    ...DEFAULT_ENV, BYO_PROVIDERS: EXTRAS,
    BYO_PROVIDER_MINIMAX_API_KEY: 'mm-key', BYO_PROVIDER_DEEPSEEK_API_KEY: '',
  }, () => {
    const snaps = getByoProviderSnapshots();
    const byId = new Map(snaps.map((s) => [s.id, s] as const));
    assert.equal(byId.get('default')?.isDefault, true);
    assert.equal(byId.get('default')?.hasKey, true);
    assert.equal(byId.get('minimax')?.hasKey, true);
    assert.equal(byId.get('minimax')?.configured, true);
    assert.equal(byId.get('deepseek')?.hasKey, false, 'no key → not configured');
    assert.equal(byId.get('deepseek')?.configured, false);
    // snapshots never leak the secret
    assert.equal('apiKey' in (byId.get('minimax') as object), false);
  });
});

// ── Together AI: an OpenAI-compatible provider with namespaced (org/model) ids ──

test('Together AI provider round-trips: namespaced org/model ids route to the Together key+endpoint', () => {
  withEnv({
    ...DEFAULT_ENV,
    BYO_PROVIDERS: JSON.stringify([
      { id: 'together', label: 'Together AI', baseURL: TOGETHER, modelIds: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'deepseek-ai/DeepSeek-V3'] },
    ]),
    BYO_PROVIDER_TOGETHER_API_KEY: 'together-key',
  }, () => {
    const cfg = resolveByoProviderForModel('meta-llama/Llama-3.3-70B-Instruct-Turbo');
    assert.equal(cfg?.baseURL, TOGETHER);
    assert.equal(cfg?.apiKey, 'together-key');
    assert.equal(cfg?.configured, true);
    // the second namespaced id resolves to the same provider
    assert.equal(resolveByoProviderForModel('deepseek-ai/DeepSeek-V3')?.baseURL, TOGETHER);
  });
});

test('Together slug + key env-key', () => {
  assert.equal(slugifyProviderId('Together AI'), 'together-ai');
  assert.equal(byoProviderKeyEnvKey('together'), 'BYO_PROVIDER_TOGETHER_API_KEY');
});

// ── normalizeModelsList: tolerate every /models shape, never throw ──────────

test('normalizeModelsList: OpenAI/Together {object:list, data:[...]} → sorted id/label list', () => {
  const out = normalizeModelsList({ object: 'list', data: [{ id: 'b-model' }, { id: 'a-model', display_name: 'A Model' }] });
  assert.deepEqual(out, [{ id: 'a-model', label: 'A Model' }, { id: 'b-model', label: undefined }]);
});

test('normalizeModelsList: bare array of strings or objects', () => {
  assert.deepEqual(normalizeModelsList(['y', 'x']), [{ id: 'x', label: undefined }, { id: 'y', label: undefined }]);
  assert.deepEqual(normalizeModelsList([{ id: 'x' }]), [{ id: 'x', label: undefined }]);
});

test('normalizeModelsList: dedupes repeated ids', () => {
  assert.deepEqual(normalizeModelsList({ data: [{ id: 'dup' }, { id: 'dup' }] }), [{ id: 'dup', label: undefined }]);
});

test('normalizeModelsList: garbage / bad ids → [] without throwing', () => {
  assert.deepEqual(normalizeModelsList(null), []);
  assert.deepEqual(normalizeModelsList({}), []);
  assert.deepEqual(normalizeModelsList('nope'), []);
  // ids with illegal chars (space) are dropped by cleanId
  assert.deepEqual(normalizeModelsList([{ id: 'bad id' }, { id: 'good-id' }]), [{ id: 'good-id', label: undefined }]);
});
