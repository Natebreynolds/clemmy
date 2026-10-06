/** Installed MEMORY07 asked for an agent's GPT pin, but all-in routing sent
 * GLM. Use synthetic owned credentials and inert provider seams to exercise
 * the production classifier and physical model selection without a call. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-router-all-in-codex-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_MODEL_PRIMARY = 'gpt-6.1-sol';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
const authPath = path.join(TEST_HOME, 'state', 'auth.json');
const fakeAuth = JSON.stringify({ codexOauth: {
  accessToken: 'fixture-owned-codex-access', refreshToken: 'fixture-owned-codex-refresh',
} });
writeFileSync(authPath, fakeAuth, { mode: 0o600 });

const { RouterModelProvider } = await import('./router-model.js');
const { resolveEffectiveProviderForModel, captureByoRoutingSnapshot, resolveEffectiveProviderForModelFromSnapshot,
  resolveDeclaredByoProviderForModel, resolveByoProviderForModel, repairByoRoutedModelId,
  markByoModelNotServed, clearByoNotServedForTest } = await import('./byo-providers.js');
const { modelProviderLive } = await import('./model-roles.js');
const { withPinnedWorkerModel } = await import('./pinned-worker-model.js');

after(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });

const ENV_KEYS = ['AUTH_MODE', 'MODEL_ROUTING_MODE', 'BYO_MODEL_BASE_URL', 'BYO_MODEL_ID',
  'BYO_MODEL_API_KEY', 'BYO_MODEL_PROVIDER', 'BYO_PROVIDERS', 'BYO_PROVIDER_TOGETHER_API_KEY',
  'BYO_PROVIDER_MINIMAX_API_KEY', 'OPENAI_MODEL_WORKER', 'CLEMMY_BRAIN_FALLOVER'];
function withByoDefault(fn: () => void): void {
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) process.env[key] = '';
  Object.assign(process.env, { AUTH_MODE: 'api_key', MODEL_ROUTING_MODE: 'all_in',
    BYO_MODEL_BASE_URL: 'https://byo.example.test/v1', BYO_MODEL_ID: 'glm-5.2',
    BYO_MODEL_API_KEY: 'fixture-key', BYO_MODEL_PROVIDER: 'Fixture BYO', CLEMMY_BRAIN_FALLOVER: 'off' });
  try { fn(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function routingProbe() {
  const codexRequests: string[] = [];
  const byoRequests: Array<{ model: string; backendId?: string }> = [];
  const router = new RouterModelProvider({
    codex: { getModel: (model?: string) => { codexRequests.push(model ?? ''); return {} as never; } },
    claude: { getModel: () => { throw new Error('Unexpected Claude construction'); } },
    resolveByoModel: ((model: string, backend: { providerId?: string }) => {
      byoRequests.push({ model, backendId: backend.providerId }); return {} as never;
    }) as never,
  });
  const selected = (model?: string) => router.getModel(model) as unknown as {
    context: { requestedModel: string; resolvedModel: string; provider: string };
  };
  return { codexRequests, byoRequests, selected };
}

test('connected explicit GPT stays GPT under an all-in BYO default, matching route evidence', () => {
  withByoDefault(() => {
    assert.equal(resolveEffectiveProviderForModel('gpt-6.1-sol'), 'codex');
    const probe = routingProbe();
    const model = probe.selected('gpt-6.1-sol');
    assert.deepEqual(probe.codexRequests, ['gpt-6.1-sol']);
    assert.deepEqual(probe.byoRequests, [], 'the BYO model must never be constructed for the GPT pin');
    assert.equal(model.context.requestedModel, 'gpt-6.1-sol');
    assert.equal(model.context.resolvedModel, 'gpt-6.1-sol');
    assert.equal(model.context.provider, 'codex');
  });
});

test('a declared BYO GPT id retains its exact backend even with Codex connected', () => {
  withByoDefault(() => {
    process.env.BYO_PROVIDERS = JSON.stringify([{ id: 'together', label: 'Fixture declared owner',
      baseURL: 'https://declared.example.test/v1', modelIds: ['gpt-6.1-sol'] }]);
    process.env.BYO_PROVIDER_TOGETHER_API_KEY = 'fixture-extra-key';
    assert.equal(resolveEffectiveProviderForModel('gpt-6.1-sol'), 'byo');
    const probe = routingProbe();
    const model = probe.selected('gpt-6.1-sol');
    assert.deepEqual(probe.codexRequests, []);
    assert.deepEqual(probe.byoRequests, [{ model: 'gpt-6.1-sol', backendId: 'together' }]);
    assert.equal(model.context.resolvedModel, 'gpt-6.1-sol');
    assert.equal(model.context.provider, 'byo');
  });
});

test('a named BYO declaration losing its key cannot switch to connected Codex or the ambient backend', () => {
  withByoDefault(() => {
    process.env.BYO_PROVIDERS = JSON.stringify([{ id: 'together', label: 'Fixture declared owner',
      baseURL: 'https://declared.example.test/v1', modelIds: ['gpt-6.1-sol'] }]);
    process.env.BYO_PROVIDER_TOGETHER_API_KEY = 'fixture-extra-key';
    const connected = routingProbe();
    assert.equal(connected.selected('gpt-6.1-sol').context.provider, 'byo');
    assert.deepEqual(connected.codexRequests, []);
    assert.deepEqual(connected.byoRequests, [{ model: 'gpt-6.1-sol', backendId: 'together' }]);

    // Keep both the declaration and connected subscription, then remove only
    // this named backend's credential. Ownership must survive key loss.
    process.env.BYO_PROVIDER_TOGETHER_API_KEY = '';
    assert.equal(captureByoRoutingSnapshot().codexAvailable, true);
    const disconnected = routingProbe();
    const expected = /declared.*Fixture declared owner.*not connected/;
    assert.throws(() => resolveEffectiveProviderForModel('gpt-6.1-sol'), expected);
    assert.throws(() => resolveDeclaredByoProviderForModel('gpt-6.1-sol'), expected);
    assert.throws(() => resolveByoProviderForModel('gpt-6.1-sol'), expected);
    assert.throws(() => repairByoRoutedModelId('gpt-6.1-sol'), expected);
    assert.throws(() => disconnected.selected('gpt-6.1-sol'), expected);
    assert.equal(modelProviderLive('gpt-6.1-sol', 'byo'), false);
    assert.deepEqual(disconnected.codexRequests, []);
    assert.deepEqual(disconnected.byoRequests, [], 'no replacement backend may be constructed');
  });
});

test('a connected named BYO model marked unavailable cannot repair through another backend', () => {
  withByoDefault(() => {
    process.env.BYO_PROVIDERS = JSON.stringify([{ id: 'together', label: 'Fixture declared owner',
      baseURL: 'https://declared.example.test/v1', modelIds: ['gpt-6.1-sol'] }]);
    process.env.BYO_PROVIDER_TOGETHER_API_KEY = 'fixture-extra-key';
    clearByoNotServedForTest();
    try {
      assert.equal(repairByoRoutedModelId('gpt-6.1-sol'), 'gpt-6.1-sol');
      markByoModelNotServed('gpt-6.1-sol');
      const probe = routingProbe();
      // The retry caller repairs first, then constructs the returned model.
      // Rejection must happen before either alternate connection is selected.
      assert.throws(() => probe.selected(repairByoRoutedModelId('gpt-6.1-sol')),
        /declared.*Fixture declared owner.*marked unavailable/);
      assert.deepEqual(probe.codexRequests, []);
      assert.deepEqual(probe.byoRequests, [], 'repair cannot construct the ambient or another named backend');
    } finally {
      clearByoNotServedForTest();
    }
  });
});

test('a named BYO declaration losing its key remains unavailable when the legacy backend declares the same id', () => {
  withByoDefault(() => {
    process.env.BYO_MODEL_ID = 'gpt-6.1-sol';
    process.env.BYO_PROVIDERS = JSON.stringify([{ id: 'together', label: 'Fixture declared owner',
      baseURL: 'https://declared.example.test/v1', modelIds: ['gpt-6.1-sol'] }]);
    const probe = routingProbe();
    assert.throws(() => probe.selected('gpt-6.1-sol'), /declared.*Fixture declared owner.*not connected/);
    assert.deepEqual(probe.codexRequests, []);
    assert.deepEqual(probe.byoRequests, [], 'a connected same-name default is a different owner');
  });
});

test('two named BYO declarations remain ambiguous after one key is lost', () => {
  withByoDefault(() => {
    process.env.BYO_PROVIDERS = JSON.stringify([
      { id: 'together', label: 'Missing owner', baseURL: 'https://missing.example.test/v1', modelIds: ['gpt-6.1-sol'] },
      { id: 'minimax', label: 'Other owner', baseURL: 'https://other.example.test/v1', modelIds: ['gpt-6.1-sol'] },
    ]);
    process.env.BYO_PROVIDER_MINIMAX_API_KEY = 'fixture-other-key';
    try {
      const probe = routingProbe();
      assert.throws(() => resolveEffectiveProviderForModel('gpt-6.1-sol'), /multiple.*BYO providers/);
      assert.throws(() => probe.selected('gpt-6.1-sol'), /multiple.*BYO providers/);
      assert.deepEqual(probe.codexRequests, []);
      assert.deepEqual(probe.byoRequests, [], 'one connected key cannot resolve an ambiguous saved id');
    } finally { process.env.BYO_PROVIDER_MINIMAX_API_KEY = ''; }
  });
});

test('BYO primary and its explicit legacy GPT worker keep their existing lanes', () => {
  withByoDefault(() => {
    process.env.OPENAI_MODEL_WORKER = 'gpt-4o';
    const probe = routingProbe();
    assert.equal(probe.selected('glm-5.2').context.resolvedModel, 'glm-5.2');
    assert.equal(probe.selected('gpt-4o').context.resolvedModel, 'gpt-4o');
    assert.deepEqual(probe.codexRequests, []);
    assert.deepEqual(probe.byoRequests.map(row => row.model), ['glm-5.2', 'gpt-4o']);
  });
});

test('omitting a model keeps the ambient all-in BYO default with Codex connected', () => {
  withByoDefault(() => {
    const probe = routingProbe();
    const model = probe.selected();
    assert.equal(model.context.requestedModel, 'gpt-6.1-sol');
    assert.equal(model.context.resolvedModel, 'glm-5.2');
    assert.equal(model.context.provider, 'byo');
    assert.deepEqual(probe.codexRequests, []);
    assert.deepEqual(probe.byoRequests.map(row => row.model), ['glm-5.2']);
  });
});

test('disconnected ambient GPT keeps legacy collapse, while an exact worker pin refuses it', () => {
  withByoDefault(() => {
    rmSync(authPath);
    try {
      assert.equal(resolveEffectiveProviderForModel('gpt-6.1-sol'), 'byo');
      const probe = routingProbe();
      assert.equal(probe.selected('gpt-6.1-sol').context.resolvedModel, 'glm-5.2');
      assert.throws(() => withPinnedWorkerModel('gpt-6.1-sol', () => probe.selected('gpt-6.1-sol')),
        /exact model is unavailable/);
      assert.deepEqual(probe.codexRequests, []);
    } finally { writeFileSync(authPath, fakeAuth, { mode: 0o600 }); }
  });
});

test('one routing snapshot retains its captured subscription availability', () => {
  withByoDefault(() => {
    const snapshot = captureByoRoutingSnapshot();
    assert.equal(snapshot.codexAvailable, true);
    rmSync(authPath);
    try {
      assert.equal(resolveEffectiveProviderForModelFromSnapshot('gpt-6.1-sol', snapshot), 'codex');
      assert.equal(resolveEffectiveProviderForModel('gpt-6.1-sol'), 'byo');
    } finally { writeFileSync(authPath, fakeAuth, { mode: 0o600 }); }
  });
});
