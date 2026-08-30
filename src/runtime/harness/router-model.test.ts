import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RouterModelProvider, brainFalloverFirstByteMsForProvider } from './router-model.js';
import { resetByoModelCache } from './byo-model.js';
import { ToolCallsCounter, withHarnessRunContext } from './brackets.js';
import { modelFirstByteStallMs } from './model-stall-policy.js';

const ENV_KEYS = [
  'AUTH_MODE',
  'MODEL_ROUTING_MODE',
  'BYO_MODEL_BASE_URL',
  'BYO_MODEL_ID',
  'BYO_MODEL_API_KEY',
  'BYO_MODEL_PROVIDER',
  'OPENAI_MODEL_WORKER',
  'BYO_PROVIDERS',
  'BYO_PROVIDER_TOGETHER_API_KEY',
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

test('BYO gets a LONGER fallover deadline, never an absent one', () => {
  // This asserted `undefined` for BYO, to protect a real concern: the BYO
  // adapter completes non-streaming and emits one synthetic chunk, so its
  // "first byte" IS the whole completion and a streaming-length deadline would
  // falsely fail healthy long work.
  //
  // The concern was right; the remedy was not. `undefined` removed the FALLOVER
  // deadline while the loop's own first-byte watchdog still applied, so a hung
  // BYO brain hit the watchdog, retried the same dead brain, and the turn DIED
  // without the chain ever being consulted (live 2026-08-28: three
  // model.transport_timeout retries, a dead turn, and a healthy Codex and
  // Claude unused in the chain).
  //
  // The answer to "needs longer" is a longer budget, not none. Anything slower
  // than the watchdog was already being killed, so a budget just below it only
  // converts a death into a brain switch — which still returns an answer.
  const byo = brainFalloverFirstByteMsForProvider('byo');
  const codex = brainFalloverFirstByteMsForProvider('codex');
  const claude = brainFalloverFirstByteMsForProvider('claude');
  assert.equal(typeof byo, 'number', 'an absent budget disables fallover for a silent hang');
  assert.equal(typeof codex, 'number');
  assert.equal(typeof claude, 'number');
  assert.ok((byo as number) > (codex as number),
    'the original concern still holds: BYO needs more headroom than a streaming brain');
  assert.ok((byo as number) < modelFirstByteStallMs(),
    'and it must stay under the watchdog, or fallover is unreachable by construction');
});

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

test('all_in collapses an undeclared gpt-shaped request to the BYO primary', () => {
  withEnv({
    AUTH_MODE: 'api_key',
    MODEL_ROUTING_MODE: 'all_in',
    BYO_MODEL_BASE_URL: 'https://api.z.ai/api/paas/v4',
    BYO_MODEL_ID: 'glm-5.2',
    BYO_MODEL_API_KEY: 'test-key',
    BYO_MODEL_PROVIDER: 'GLM (Z.ai)',
    OPENAI_MODEL_WORKER: '',
    CLEMMY_BRAIN_FALLOVER: 'on',
  }, () => {
    const model = new RouterModelProvider().getModel('gpt-5.4') as unknown as {
      context?: { provider?: string; resolvedModel?: string };
    };
    assert.equal(model.context?.provider, 'byo');
    assert.equal(model.context?.resolvedModel, 'glm-5.2');
  });
});

test('all_in preserves a built-in-shaped worker explicitly declared on the default BYO provider', () => {
  withEnv({
    AUTH_MODE: 'api_key',
    MODEL_ROUTING_MODE: 'all_in',
    BYO_MODEL_BASE_URL: 'https://api.z.ai/api/paas/v4',
    BYO_MODEL_ID: 'glm-5.2',
    BYO_MODEL_API_KEY: 'test-key',
    BYO_MODEL_PROVIDER: 'GLM (Z.ai)',
    OPENAI_MODEL_WORKER: 'gpt-4o',
    CLEMMY_BRAIN_FALLOVER: 'off',
  }, () => {
    const model = new RouterModelProvider().getModel('gpt-4o') as unknown as {
      context?: { provider?: string; resolvedModel?: string };
    };
    assert.equal(model.context?.provider, 'byo');
    assert.equal(model.context?.resolvedModel, 'gpt-4o');
  });
});

test('all_in collapses an undeclared Claude-shaped model to the BYO primary', () => {
  withEnv({
    AUTH_MODE: 'api_key',
    MODEL_ROUTING_MODE: 'all_in',
    BYO_MODEL_BASE_URL: 'https://api.z.ai/api/paas/v4',
    BYO_MODEL_ID: 'glm-5.2',
    BYO_MODEL_API_KEY: 'test-key',
    BYO_MODEL_PROVIDER: 'GLM (Z.ai)',
    CLEMMY_BRAIN_FALLOVER: 'off',
  }, () => {
    const model = new RouterModelProvider().getModel('claude-opus-stale') as unknown as {
      context?: { provider?: string; resolvedModel?: string };
    };
    assert.equal(model.context?.provider, 'byo');
    assert.equal(model.context?.resolvedModel, 'glm-5.2');
  });
});

test('all_in preserves a gpt-shaped model explicitly declared by an extra BYO provider', () => {
  withEnv({
    AUTH_MODE: 'api_key',
    MODEL_ROUTING_MODE: 'all_in',
    BYO_PROVIDERS: JSON.stringify([
      { id: 'together', label: 'Together', baseURL: 'https://api.together.ai/v1', modelIds: ['gpt-4o'] },
    ]),
    BYO_PROVIDER_TOGETHER_API_KEY: 'together-key',
    CLEMMY_BRAIN_FALLOVER: 'on',
  }, () => {
    const model = new RouterModelProvider().getModel('gpt-4o') as unknown as {
      context?: { provider?: string; resolvedModel?: string };
    };
    assert.equal(model.context?.provider, 'byo');
    assert.equal(model.context?.resolvedModel, 'gpt-4o');
  });
});

test('mixed routing rejects a model id exposed by both Codex and an extra BYO provider', () => {
  withEnv({
    AUTH_MODE: 'api_key',
    MODEL_ROUTING_MODE: 'off',
    BYO_PROVIDERS: JSON.stringify([
      { id: 'together', label: 'Together', baseURL: 'https://api.together.ai/v1', modelIds: ['gpt-4o'] },
    ]),
    BYO_PROVIDER_TOGETHER_API_KEY: 'together-key',
    CLEMMY_BRAIN_FALLOVER: 'off',
  }, () => {
    assert.throws(
      () => new RouterModelProvider().getModel('gpt-4o'),
      /exposed by both Codex and BYO provider Together/,
    );
  });
});

test('mixed routing rejects a gpt-shaped primary on the migrated default BYO provider', () => {
  withEnv({
    AUTH_MODE: 'api_key',
    MODEL_ROUTING_MODE: 'worker',
    BYO_MODEL_BASE_URL: 'https://api.together.ai/v1',
    BYO_MODEL_ID: 'gpt-4o',
    BYO_MODEL_API_KEY: 'together-key',
    BYO_MODEL_PROVIDER: 'Together',
    CLEMMY_BRAIN_FALLOVER: 'off',
  }, () => {
    assert.throws(
      () => new RouterModelProvider().getModel('gpt-4o'),
      /exposed by both Codex and BYO provider Together/,
    );
  });
});

test('router rejects an unqualified id exposed by multiple BYO providers', () => {
  withEnv({
    AUTH_MODE: 'api_key',
    MODEL_ROUTING_MODE: 'all_in',
    BYO_MODEL_BASE_URL: 'https://api.z.ai/v1',
    BYO_MODEL_ID: 'shared-model',
    BYO_MODEL_API_KEY: 'zai-key',
    BYO_MODEL_PROVIDER: 'Z.ai',
    BYO_PROVIDERS: JSON.stringify([
      { id: 'together', label: 'Together', baseURL: 'https://api.together.ai/v1', modelIds: ['shared-model'] },
    ]),
    BYO_PROVIDER_TOGETHER_API_KEY: 'together-key',
  }, () => {
    assert.throws(
      () => new RouterModelProvider().getModel('shared-model'),
      /multiple connected BYO providers/,
    );
  });
});
