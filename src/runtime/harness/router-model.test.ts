import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RouterModelProvider } from './router-model.js';
import { resetByoModelCache } from './byo-model.js';
import { ToolCallsCounter, withHarnessRunContext } from './brackets.js';

const ENV_KEYS = [
  'AUTH_MODE',
  'MODEL_ROUTING_MODE',
  'BYO_MODEL_BASE_URL',
  'BYO_MODEL_ID',
  'BYO_MODEL_API_KEY',
  'BYO_MODEL_PROVIDER',
  'BYO_PROVIDERS',
  'CLEMMY_BRAIN_FALLOVER',
];

function withEnv(vars: Record<string, string>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; process.env[k] = ''; }
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try { fn(); } finally {
    resetByoModelCache();
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  }
}

test('brain route metrics wrapper carries the active session + workflow run ids', () => {
  withEnv({
    AUTH_MODE: 'api_key',
    MODEL_ROUTING_MODE: 'all_in',
    BYO_MODEL_BASE_URL: 'https://api.z.ai/api/paas/v4',
    BYO_MODEL_ID: 'glm-5.2',
    BYO_MODEL_API_KEY: 'test-key',
    BYO_MODEL_PROVIDER: 'GLM (Z.ai)',
    CLEMMY_BRAIN_FALLOVER: 'off',
  }, () => {
    withHarnessRunContext({
      sessionId: 'workflow:run-123:step-build:item-1',
      counter: new ToolCallsCounter(8),
    }, () => {
      const model = new RouterModelProvider().getModel('glm-5.2') as unknown as {
        context?: { sessionId?: string; workflowRunId?: string; role?: string; provider?: string; resolvedModel?: string };
      };
      assert.equal(model.context?.role, 'brain');
      assert.equal(model.context?.provider, 'byo');
      assert.equal(model.context?.resolvedModel, 'glm-5.2');
      assert.equal(model.context?.sessionId, 'workflow:run-123:step-build:item-1');
      assert.equal(model.context?.workflowRunId, 'run-123');
    });
  });
});
