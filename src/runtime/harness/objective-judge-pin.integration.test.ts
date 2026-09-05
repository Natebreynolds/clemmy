import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelResponse } from '@openai/agents-core';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-objective-judge-pin-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { Usage } = await import('@openai/agents');
const { ClaudeModelProvider } = await import('./claude-model.js');
const { CodexModelProvider } = await import('./codex-model.js');
const { resolveBoundaryJudge, resolveBoundaryJudgeHedge } = await import('./debate-model.js');
const { runHedgedJudge, parseCompletionVerdict } = await import('./objective-judge.js');
const { getJudgeMetricsSnapshot, resetJudgeMetricsForTests } = await import('./judge-family.js');
const { _setDiscoveredModelsForTest } = await import('./model-discovery.js');
const { closeEventLog } = await import('./eventlog.js');

type Behavior = 'slow' | 'error' | 'invalid' | 'hung';
let claudeBehavior: Behavior = 'slow';
const calls: Array<{ provider: string; modelId?: string }> = [];

function providerModel(provider: 'claude' | 'codex', modelId?: string): Model {
  return {
    async getResponse(): Promise<ModelResponse> {
      calls.push({ provider, modelId });
      if (provider === 'claude') {
        if (claudeBehavior === 'hung') return new Promise(() => {});
        if (claudeBehavior === 'error') throw new Error('fixture pinned judge transport unavailable');
        if (claudeBehavior === 'slow') await new Promise(resolve => setTimeout(resolve, 650));
      }
      const text = provider === 'codex' ? 'DONE: fast self-family verdict'
        : claudeBehavior === 'invalid' ? 'not a verdict'
          : 'INCOMPLETE: the eight worker receipts are absent';
      return {
        output: [{ type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text, providerData: {} }] }],
        usage: new Usage(), responseId: `fixture-${provider}`,
      } as ModelResponse;
    },
    async *getStreamedResponse() { throw new Error('judge must use its ordinary one-turn request'); },
  };
}

function writeAuth(claudeAvailable = true): void {
  writeFileSync(path.join(TEST_HOME, 'state', 'auth.json'), JSON.stringify({
    codexOauth: { accessToken: 'fixture-codex-access', refreshToken: 'fixture-codex-refresh' },
  }));
  // An explicit non-OAuth token prevents fallback to the operator's keychain.
  writeFileSync(path.join(TEST_HOME, 'state', 'claude-auth.json'), JSON.stringify({
    accessToken: claudeAvailable ? 'sk-ant-oat01-fixture' : 'sk-ant-api03-no-subscription',
    expiresAt: Date.now() + 3_600_000,
  }));
}

beforeEach(() => {
  mock.restoreAll();
  calls.length = 0;
  claudeBehavior = 'slow';
  Object.assign(process.env, {
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra',
    CLEMMY_JUDGE_CROSS_FAMILY: 'on', CLEMMY_JUDGE_HEDGE: 'on', CLEMMY_JUDGE_HEDGE_DELAY_MS: '500',
    CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'judge', modelId: 'claude-sonnet-5', scope: 'durable', source: 'settings' }]),
    CLEMMY_DEBATE_JUDGE: '', BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '', BYO_MODEL_ID: '', BYO_PROVIDERS: '',
  });
  writeAuth();
  _setDiscoveredModelsForTest({ anthropic: [], openai: [] });
  resetJudgeMetricsForTests();
  // Stub only the provider wires. Real role resolution, concrete adapter
  // binding, route metrics, Agents Runner, hedge engine and parser still run.
  mock.method(ClaudeModelProvider.prototype, 'getModel', (id?: string) => providerModel('claude', id));
  mock.method(CodexModelProvider.prototype, 'getModel', (id?: string) => providerModel('codex', id));
});

after(() => {
  mock.restoreAll();
  closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function completion(timeoutMs = 2_000) {
  return runHedgedJudge('Audit the requested worker receipts.', 'Eight workers were requested; none ran.',
    parseCompletionVerdict, value => value.done, 'completion', { timeoutMs });
}

test('a faster brain-family hedge cannot replace the pinned completion judge', async () => {
  const result = await completion();
  assert.equal(result.value?.done, false);
  assert.equal(result.failure, null);
  assert.equal(result.routing?.modelId, 'claude-sonnet-5');
  assert.equal(result.routing?.transport, 'claude_subscription');
  assert.equal(result.routing?.selfJudge, false);
  assert.deepEqual(calls, [{ provider: 'claude', modelId: 'claude-sonnet-5' }]);
  const metric = getJudgeMetricsSnapshot().lanes.find(lane => lane.lane === 'completion');
  assert.equal(metric?.lastModelId, 'claude-sonnet-5');
  assert.equal(metric?.lastJudgeFamily, 'claude');
  assert.equal(metric?.lastBrainFamily, 'codex');
  assert.equal(metric?.lastSelfJudge, false);
});

for (const behavior of ['error', 'invalid', 'hung'] as const) {
  test(`an explicit completion judge ${behavior} is unjudged without a silent alternate verdict`, async () => {
    claudeBehavior = behavior;
    const result = await completion(behavior === 'hung' ? 30 : 2_000);
    assert.equal(result.value, null);
    assert.equal(result.failure, behavior === 'hung' ? 'timeout' : behavior);
    assert.equal(result.routing?.modelId, 'claude-sonnet-5');
    assert.equal(result.routing?.selfJudge, false);
    assert.deepEqual(calls, [{ provider: 'claude', modelId: 'claude-sonnet-5' }]);
    const metric = getJudgeMetricsSnapshot().lanes.find(lane => lane.lane === 'completion');
    assert.equal(metric?.lastOutcome, behavior === 'hung' ? 'timeout' : behavior);
  });
}

test('an unavailable explicit judge binding never silently resolves to the brain wire', async () => {
  writeAuth(false);
  const result = await completion();
  assert.equal(result.value, null);
  assert.equal(result.failure, 'error');
  assert.deepEqual(calls, []);
  assert.equal(getJudgeMetricsSnapshot().lanes.find(lane => lane.lane === 'completion')?.errors, 1);
});

test('an unpinned cross-family primary cannot hedge back onto the brain family', () => {
  process.env.CLEMMY_MODEL_ROLES = '[]';
  const primary = resolveBoundaryJudge();
  assert.equal(primary.selfJudge, false);
  assert.equal(resolveBoundaryJudgeHedge(primary), null);
});
