/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/grok-xai-routing.test.ts
 *
 * RESTART-GATE PIN — Grok is a credential, not a lane.
 *
 * A grok-* / xAI model id must complete the SAME host one-step path Codex
 * uses: resolveHarnessModel → RouterModelProvider → BYO `xai` backend
 * (OpenAI-compatible chat model with getResponse). It must never require the
 * @openai/agents Runner mega-loop (which has no production caller left) and
 * never fork into the Claude SDK lane. The xAI credential arrives as a typed
 * key or the stored xAI OAuth grant — mirroring the live post-login state
 * (BYO_PROVIDERS row + MODEL_ROUTING_MODE=worker written by Settings).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-grok-routing-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.BYO_PROVIDERS = JSON.stringify([
  { id: 'xai', label: 'xAI (Grok)', baseURL: 'https://api.x.ai/v1', modelIds: ['grok-4'] },
]);
process.env.BYO_PROVIDER_XAI_API_KEY = 'xai-test-credential';
process.env.MODEL_ROUTING_MODE = 'worker';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { resolveByoProviderForModel, getByoProviders, XAI_PROVIDER_ID } = await import('./byo-providers.js');
const { resolveProvider } = await import('./model-wire-registry.js');
const { resolveHarnessModel } = await import('./codex-client.js');
const { codexOneStep } = await import('./codex-one-step.js');
const { claudeAgentSdkBrainEnabled } = await import('./claude-agent-brain.js');

after(() => {
  delete process.env.BYO_PROVIDERS;
  delete process.env.BYO_PROVIDER_XAI_API_KEY;
  delete process.env.MODEL_ROUTING_MODE;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('a grok id is BYO-owned by the xai provider — never a codex or claude id', () => {
  assert.equal(resolveProvider('grok-4'), 'byo', 'no grok row exists in the wire registry; ownership is BYO');
  const providers = getByoProviders();
  const xai = providers.find((p) => p.id === XAI_PROVIDER_ID);
  assert.ok(xai, 'the xai registry row is present');
  assert.equal(xai!.baseURL, 'https://api.x.ai/v1');
  const backend = resolveByoProviderForModel('grok-4');
  assert.ok(backend, 'grok-4 resolves to a backend');
  assert.equal(backend!.baseURL, 'https://api.x.ai/v1', 'the declared owner is the xAI endpoint');
  assert.equal(backend!.configured, true, 'the xAI credential completes the backend');
});

test('resolveHarnessModel completes for a grok id — the one-step path needs no Runner', async () => {
  const model = await resolveHarnessModel('grok-4');
  assert.ok(model, 'the router resolves a model for grok-4');
  assert.equal(typeof (model as { getResponse?: unknown }).getResponse, 'function',
    'a Model with getResponse is exactly what codexOneStep consumes — no vendor loop in between');
});

test('codexOneStep is model-agnostic: one getResponse for a grok id, tool calls stay HOST intents', async () => {
  let calls = 0;
  const step = await codexOneStep({
    modelId: 'grok-4',
    resolveModel: async (modelId: string) => {
      assert.equal(modelId, 'grok-4');
      return {
        async getResponse() {
          calls += 1;
          return {
            responseId: 'grok-step-1',
            output: [
              { type: 'function_call', callId: 'call-1', name: 'tool_search', arguments: '{"query":"coffee"}' },
            ],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          };
        },
      } as never;
    },
    request: {
      systemInstructions: 'unused',
      input: [{ type: 'message', role: 'user', content: 'find coffee shops' }],
      tools: [],
      modelSettings: {},
    } as never,
  } as never);
  assert.equal(calls, 1, 'exactly one model step per host call');
  assert.equal(step.toolCalls.length, 1, 'tool calls come back as INTENTS for the host to execute');
  assert.equal(step.toolCalls[0]?.name, 'tool_search');
});

test('a grok brain never enters the Claude SDK lane', () => {
  const prior = process.env.AUTH_MODE;
  try {
    process.env.AUTH_MODE = 'api_key';
    assert.equal(claudeAgentSdkBrainEnabled('home'), false,
      'without claude_oauth + a claude brain model, chat falls to the host loop (hostRunRunner)');
  } finally {
    if (prior === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = prior;
  }
});
