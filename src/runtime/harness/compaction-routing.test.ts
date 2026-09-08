/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/compaction-routing.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentInputItem, Model } from '@openai/agents';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-compaction-routing-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_DEBATE_MODE = 'off';
const { summarizeOlderMessages } = await import('./compaction.js');
const { RouterModelProvider } = await import('./router-model.js');
const sdk = await import('@openai/agents');
const eventlog = await import('./eventlog.js');
const { closeMemoryDb } = await import('../../memory/db.js');

test.after(() => {
  eventlog.closeEventLog();
  closeMemoryDb();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const cases = [
  {
    label: 'Claude brain ignores an unsupported legacy Codex fast slot',
    env: { AUTH_MODE: 'claude_oauth', OPENAI_MODEL_FAST: 'gpt-5.4' },
    modelId: 'claude-sonnet-5', provider: 'claude',
  },
  {
    label: 'Codex brain ignores a foreign BYO fast slot',
    env: { AUTH_MODE: 'codex_oauth', OPENAI_MODEL_FAST: 'unconfigured-byo-model' },
    modelId: 'gpt-5.6-terra', provider: 'codex',
  },
  {
    label: 'all-in BYO worker preserves its configured endpoint despite stale OAuth and fast slots',
    env: {
      AUTH_MODE: 'claude_oauth', MODEL_ROUTING_MODE: 'all_in', OPENAI_MODEL_FAST: 'gpt-5.4',
      BYO_MODEL_BASE_URL: 'https://summary-fixture.invalid/v1',
      BYO_MODEL_API_KEY: 'fixture-key', BYO_MODEL_ID: 'deepseek-chat',
    },
    modelId: 'deepseek-chat', provider: 'byo',
  },
  {
    label: 'an explicit connected worker assignment is retained while the brain is Claude',
    env: {
      AUTH_MODE: 'claude_oauth', OPENAI_MODEL_FAST: 'gpt-5.4',
      BYO_MODEL_BASE_URL: 'https://summary-fixture.invalid/v1',
      BYO_MODEL_API_KEY: 'fixture-key', BYO_MODEL_ID: 'deepseek-chat',
      CLEMMY_MODEL_ROLES: JSON.stringify([{
        role: 'worker', modelId: 'deepseek-chat', scope: 'durable', source: 'settings',
      }]),
    },
    modelId: 'deepseek-chat', provider: 'byo',
  },
] as const;

for (const scenario of cases) {
  test(`summarizeOlderMessages: ${scenario.label}`, async (t) => {
    const overrides: Record<string, string | undefined> = {
      MODEL_ROUTING_MODE: 'off', CLAUDE_MODEL: 'claude-sonnet-5',
      OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra', OPENAI_MODEL_WORKER: undefined,
      CLEMMY_MODEL_ROLES: '[]', CLEMMY_ROUTE_POLICY: 'off', CLEMMY_BRAIN_FALLOVER: 'off',
      BYO_MODEL_BASE_URL: undefined, BYO_MODEL_API_KEY: undefined, BYO_MODEL_ID: undefined,
      BYO_PROVIDERS: '[]', BYO_BRAIN_MODEL_ID: undefined,
      ...scenario.env,
    };
    const prior = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const originalGetModel = RouterModelProvider.prototype.getModel;
    const routes: Array<{ provider: string; modelId: string; baseURL?: string }> = [];
    let responses = 0;
    const providerModel = (provider: string, modelId: string, baseURL?: string): Model => {
      routes.push({ provider, modelId, ...(baseURL ? { baseURL } : {}) });
      if (modelId === 'gpt-5.4') throw new Error('gpt-5.4 is not supported by this subscription');
      return {
        async getResponse(request) {
          responses += 1;
          assert.equal(request.tools?.length ?? 0, 0, 'the summarizer must not acquire execution tools');
          assert.match(JSON.stringify(request.input), /Brett has three completed follow-up drafts/);
          return {
            responseId: `summary-${scenario.provider}`,
            usage: new sdk.Usage(),
            output: [{
              type: 'message', role: 'assistant', status: 'completed', id: 'summary-output',
              content: [{ type: 'output_text', text: '- Brett has three completed follow-up drafts.', providerData: {} }],
            }],
          };
        },
        async *getStreamedResponse() { throw new Error('unexpected streaming summary'); },
      };
    };
    // Keep the real role resolver, credential-router entry point, provider
    // ownership classifier, and SDK Runner. Replace only transport factories.
    RouterModelProvider.prototype.getModel = function (modelId?: string) {
      const router = new RouterModelProvider({
        claude: { getModel: (id) => providerModel('claude', id!) },
        codex: { getModel: (id) => providerModel('codex', id!) },
        resolveByoModel: (id, backend) => providerModel('byo', id, backend.baseURL),
        codexAvailable: () => true,
        claudeAvailable: () => true,
      });
      return originalGetModel.call(router, modelId);
    };
    sdk.setDefaultModelProvider({ getModel() { throw new Error('ambient SDK provider must not receive compaction'); } });
    t.after(() => {
      RouterModelProvider.prototype.getModel = originalGetModel;
      sdk.setDefaultModelProvider(new RouterModelProvider());
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const session = eventlog.createSession({ kind: 'chat' });
    const source = { role: 'user', content: 'Keep the same three Brett drafts.' } as AgentInputItem;
    const history = [
      source,
      ...Array.from({ length: 8 }, () => ({
        role: 'assistant', content: 'Brett has three completed follow-up drafts; retain their specific content.',
      } as AgentInputItem)),
    ];
    const result = await summarizeOlderMessages(history, session.id, 2);
    assert.equal(result.applied, true, JSON.stringify(result));
    assert.equal(result.modelUsed, scenario.modelId);
    assert.equal(result.error, undefined);
    assert.equal(responses, 1);
    assert.deepEqual(routes, [{
      provider: scenario.provider, modelId: scenario.modelId,
      ...(scenario.provider === 'byo' ? { baseURL: 'https://summary-fixture.invalid/v1' } : {}),
    }]);
    assert.ok(result.mutatedItems?.some((item) => JSON.stringify(item) === JSON.stringify(source)),
      'routing repair must preserve the exact user request');
    assert.ok(result.mutatedItems?.some((item) => JSON.stringify(item).includes('[summary of earlier conversation]')));
  });
}
