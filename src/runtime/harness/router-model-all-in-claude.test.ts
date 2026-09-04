/**
 * Regression for live run 1788502900262-e0c54b (2026-09-03): workflow route
 * evidence selected claude-sonnet-5, but RouterModelProvider's duplicate
 * all_in branch silently paid GLM instead. The canonical provider classifier
 * and the physical router must make the same decision.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-router-all-in-claude-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const stateDir = path.join(TEST_HOME, 'state');
mkdirSync(stateDir, { recursive: true });
writeFileSync(path.join(stateDir, 'claude-auth.json'), JSON.stringify({
  accessToken: 'sk-ant-oat01-router-test',
  refreshToken: 'router-test-refresh',
  expiresAt: Date.now() + 60 * 60_000,
}), { encoding: 'utf-8', mode: 0o600 });

const { RouterModelProvider } = await import('./router-model.js');
const { resolveEffectiveProviderForModel } = await import('./byo-providers.js');

test('connected explicit Claude stays Claude under BYO all_in and route metrics report the paid lane', () => {
  const previous = {
    AUTH_MODE: process.env.AUTH_MODE,
    MODEL_ROUTING_MODE: process.env.MODEL_ROUTING_MODE,
    BYO_MODEL_BASE_URL: process.env.BYO_MODEL_BASE_URL,
    BYO_MODEL_ID: process.env.BYO_MODEL_ID,
    BYO_MODEL_API_KEY: process.env.BYO_MODEL_API_KEY,
    BYO_MODEL_PROVIDER: process.env.BYO_MODEL_PROVIDER,
    CLEMMY_BRAIN_FALLOVER: process.env.CLEMMY_BRAIN_FALLOVER,
  };
  Object.assign(process.env, {
    AUTH_MODE: 'api_key',
    MODEL_ROUTING_MODE: 'all_in',
    BYO_MODEL_BASE_URL: 'https://api.z.ai/api/paas/v4',
    BYO_MODEL_ID: 'glm-5.2',
    BYO_MODEL_API_KEY: 'test-key',
    BYO_MODEL_PROVIDER: 'GLM (Z.ai)',
    CLEMMY_BRAIN_FALLOVER: 'off',
  });

  try {
    const claudeRequests: string[] = [];
    const byoRequests: string[] = [];
    const router = new RouterModelProvider({
      claude: {
        getModel(modelName?: string) {
          claudeRequests.push(modelName ?? '');
          return {} as never;
        },
      },
      codex: { getModel: () => ({} as never) },
      resolveByoModel: ((modelName: string) => {
        byoRequests.push(modelName);
        return {} as never;
      }) as never,
      claudeAvailable: () => true,
      codexAvailable: () => false,
    });

    assert.equal(resolveEffectiveProviderForModel('claude-sonnet-5'), 'claude');
    const model = router.getModel('claude-sonnet-5') as unknown as {
      context?: { requestedModel?: string; resolvedModel?: string; provider?: string };
    };

    assert.deepEqual(claudeRequests, ['claude-sonnet-5']);
    assert.deepEqual(byoRequests, [], 'the BYO adapter must not be constructed for an explicit connected Claude route');
    assert.equal(model.context?.requestedModel, 'claude-sonnet-5');
    assert.equal(model.context?.resolvedModel, 'claude-sonnet-5');
    assert.equal(model.context?.provider, 'claude');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
