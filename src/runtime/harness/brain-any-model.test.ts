/**
 * Run: npx tsx --test src/runtime/harness/brain-any-model.test.ts
 *
 * Any connected BYO model can be the brain — including a model that lives in an
 * EXTRA provider (e.g. Together AI), not just the legacy default slot. The proof
 * that there are NO routing gotchas: when the brain is pinned to a Together model,
 * defaultForRole('brain') (what the orchestrator uses), effectiveBrainValue (what
 * the picker highlights), AND resolveByoProviderForModel (the actual wire) all
 * agree and point at Together's base URL + key — never the default GLM slot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brainOptions, effectiveBrainValue } from './model-role-options.js';
import { defaultForRole } from './model-roles.js';
import { resolveByoProviderForModel } from './byo-providers.js';
import { MODELS } from '../../config.js';

const ZAI = 'https://api.z.ai/api/paas/v4';
const TOGETHER = 'https://api.together.ai/v1';
const TOGETHER_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

// getRuntimeEnv reads process.env before BASE_DIR/.env, so set the registry +
// keys via process.env and restore after. 'default' = the legacy BYO_MODEL_* slot
// (GLM); 'together' = an extra in the BYO_PROVIDERS registry. Keys live in
// per-id env slots (vault file absent in CI), matching byoProviderKeyEnvKey.
const ENV_KEYS = [
  'BYO_PROVIDERS', 'BYO_MODEL_BASE_URL', 'BYO_MODEL_ID', 'BYO_MODEL_API_KEY', 'BYO_MODEL_PROVIDER',
  'MODEL_ROUTING_MODE', 'BYO_BRAIN_MODEL_ID', 'AUTH_MODE', 'BYO_PROVIDER_TOGETHER_API_KEY',
];
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  // MASK with '' rather than delete: getRuntimeEnv returns process.env[key] ??
  // <.env files>, so a deleted key falls through to the developer's live
  // ~/.clementine-next/.env (which may have a real BYO_PROVIDERS) and pollutes the
  // test. '' masks the .env and reads as unset for the configured/JSON checks.
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; process.env[k] = ''; }
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try { fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  }
}

const BASE = {
  BYO_MODEL_BASE_URL: ZAI, BYO_MODEL_ID: 'glm-5.2', BYO_MODEL_API_KEY: 'zai-key', BYO_MODEL_PROVIDER: 'GLM (Z.ai)',
  BYO_PROVIDERS: JSON.stringify([{ id: 'together', label: 'Together AI', baseURL: TOGETHER, modelIds: [TOGETHER_MODEL] }]),
  BYO_PROVIDER_TOGETHER_API_KEY: 'together-key',
  MODEL_ROUTING_MODE: 'all_in',
};

test('brainOptions lists EVERY connected BYO model (default GLM + extra Together), not just the default slot', () => {
  withEnv(BASE, () => {
    const values = brainOptions().map((o) => o.value);
    assert.ok(values.includes('api_key:glm-5.2'), 'default GLM is a brain option');
    assert.ok(values.includes(`api_key:${TOGETHER_MODEL}`), 'extra Together model is a brain option (the bug)');
    const together = brainOptions().find((o) => o.modelId === TOGETHER_MODEL);
    assert.equal(together?.providerId, 'together');
    assert.equal(together?.id, 'api_key');
  });
});

test('Together model as brain: defaultForRole + effectiveBrainValue + the WIRE all agree (no gotchas)', () => {
  withEnv({ ...BASE, BYO_BRAIN_MODEL_ID: TOGETHER_MODEL, AUTH_MODE: 'api_key' }, () => {
    // What the orchestrator asks the router for:
    assert.equal(defaultForRole('brain'), TOGETHER_MODEL, 'brain override honored in all_in');
    // What the picker highlights:
    assert.equal(effectiveBrainValue(), `api_key:${TOGETHER_MODEL}`);
    // THE ROUTING: that model id wires to Together's URL + key — NOT the GLM default slot.
    const backend = resolveByoProviderForModel(TOGETHER_MODEL);
    assert.equal(backend?.baseURL, TOGETHER, 'brain wires to Together base URL');
    assert.equal(backend?.apiKey, 'together-key', 'brain uses the Together key, not the default GLM key');
    assert.equal(backend?.configured, true);
  });
});

test('no override → brain stays the default slot (GLM); routing unchanged (back-compat)', () => {
  withEnv(BASE, () => {
    assert.equal(defaultForRole('brain'), 'glm-5.2');
    assert.equal(effectiveBrainValue(), 'api_key:glm-5.2');
    assert.equal(resolveByoProviderForModel('glm-5.2')?.baseURL, ZAI);
  });
});

test('effectiveBrainValue always tracks the wire brain (defaultForRole) and is never an orphan value', () => {
  // The mixed state a fresh provider-connect can leave: AUTH_MODE=api_key but
  // MODEL_ROUTING_MODE=worker (not all_in). effectiveBrainValue is derived from
  // defaultForRole('brain'), so it ALWAYS matches a real brainOptions value and
  // reflects the brain the wire actually uses — never a bare unmatchable 'api_key'.
  // (In live runtime MODELS.primary is collapsed to the BYO primary when
  // AUTH_MODE=api_key; in this unit env it stays the Codex default, so the brain
  // here is Codex — exactly what defaultForRole returns.)
  withEnv({ ...BASE, MODEL_ROUTING_MODE: 'worker', AUTH_MODE: 'api_key' }, () => {
    const brain = defaultForRole('brain');
    assert.equal(brain, MODELS.primary, 'worker mode → defaultForRole returns MODELS.primary');
    const value = effectiveBrainValue();
    const optionValues = brainOptions().map((o) => o.value);
    assert.ok(optionValues.includes(value), `effectiveBrainValue ${value} must be a real picker option`);
    assert.ok(brainOptions().some((o) => o.modelId === TOGETHER_MODEL), 'Together stays selectable');
  });
});
