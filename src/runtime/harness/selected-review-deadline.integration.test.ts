import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-selected-review-deadline-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(testHome, 'state'), { recursive: true });
writeFileSync(path.join(testHome, 'state', 'auth.json'), JSON.stringify({
  codexOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh' },
}));
writeFileSync(path.join(testHome, 'state', 'claude-auth.json'), JSON.stringify({
  accessToken: 'sk-ant-oat01-fixture', expiresAt: Date.now() + 3_600_000,
}));

const { Usage } = await import('@openai/agents');
const { CodexModelProvider } = await import('./codex-model.js');
const { ClaudeModelProvider } = await import('./claude-model.js');
const { captureBoundaryJudgeSelection, resolveBoundaryJudge } = await import('./debate-model.js');
const { runHedgedJudge, parseCompletionVerdict } = await import('./objective-judge.js');
const { closeEventLog } = await import('./eventlog.js');
const { _setDiscoveredModelsForTest } = await import('./model-discovery.js');
const requests: Array<{ provider: string; model: string }> = [];

beforeEach(() => {
  mock.restoreAll(); requests.length = 0;
  Object.assign(process.env, {
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra',
    CLEMMY_JUDGE_CROSS_FAMILY: 'on', CLEMMY_JUDGE_HEDGE: 'off', CLEMMY_COMPLETION_REVIEW: 'on',
    CLEMMY_BOUNDARY_JUDGE_TIMEOUT_MS: '1000', CLEMMY_EXACT_JUDGE_TIMEOUT_MS: '1800',
    CLEMMY_MODEL_ROLES: '[]', CLEMMY_DEBATE_JUDGE: '', CLEMMY_CLAUDE_TRANSPORT: 'raw_messages',
    CLEMMY_CLAUDE_OVERLOAD_FALLBACK: 'off', BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '', BYO_MODEL_ID: '',
    BYO_PROVIDERS: JSON.stringify([{ id: 'xai', label: 'fixture xAI', baseURL: 'https://xai.invalid/v1', modelIds: ['grok-4.6'] }]),
    BYO_PROVIDER_XAI_API_KEY: 'fixture-xai-key',
  });
  _setDiscoveredModelsForTest({ anthropic: [], openai: [] });
  const model = (provider: string, id: string) => ({
    async getResponse() {
      requests.push({ provider, model: id });
      await new Promise(resolve => setTimeout(resolve, 1200));
      return { output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'DONE: all requested records checked', providerData: {} }] }],
        usage: new Usage(), responseId: 'fixture-reviewed' };
    },
    async *getStreamedResponse() { throw new Error('unexpected streaming reviewer'); },
  });
  mock.method(CodexModelProvider.prototype, 'getModel', (id: string) => model('codex', id));
  mock.method(ClaudeModelProvider.prototype, 'getModel', (id: string) => model('claude', id));
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    assert.equal(req.url, 'https://xai.invalid/v1/chat/completions');
    const body = await req.json() as { model: string };
    requests.push({ provider: 'byo', model: body.model });
    await new Promise(resolve => setTimeout(resolve, 1200));
    return new Response(JSON.stringify({ id: 'fixture-xai-reviewed', object: 'chat.completion', created: 1,
      model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'DONE: all requested records checked' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

after(() => { mock.restoreAll(); closeEventLog(); rmSync(testHome, { recursive: true, force: true }); });

for (const [modelId, provider] of [['gpt-5.6-terra', 'codex'], ['grok-4.6', 'byo'], ['claude-haiku-4-5', 'claude']] as const) {
  test(`selected ${modelId} keeps its verdict after the default checker deadline`, async () => {
    process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'judge', modelId, scope: 'durable', source: 'settings' }]);
    const selection = captureBoundaryJudgeSelection();
    assert.equal(selection.status, 'captured');
    // Later settings cannot turn the accepted selection back into a default.
    process.env.CLEMMY_MODEL_ROLES = '[]';
    const result = await runHedgedJudge('Review the requested work.', 'All records were checked.',
      parseCompletionVerdict, value => value.done, 'completion', { boundaryJudgeSelection: selection });
    assert.equal(result.value?.done, true);
    assert.equal(result.failure, null);
    assert.equal(result.routing?.ownerSelectedJudge, true);
    assert.equal(result.routing?.timeoutMs, 1800);
    assert.equal(result.routing?.modelId, modelId);
    assert.deepEqual(requests, [{ provider, model: modelId }]);
  });
}

test('unselected defaults retain the checker deadline; an explicit caller deadline still wins', async () => {
  const defaultRoute = resolveBoundaryJudge();
  assert.equal(defaultRoute.ownerSelectedJudge, undefined);
  assert.equal(defaultRoute.timeoutMs, 1000);
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'judge', modelId: 'gpt-5.6-terra', scope: 'durable', source: 'settings' }]);
  const result = await runHedgedJudge('Review the work.', 'All records checked.', parseCompletionVerdict,
    value => value.done, 'completion', { boundaryJudgeSelection: captureBoundaryJudgeSelection(), timeoutMs: 50 });
  assert.equal(result.value, null);
  assert.equal(result.failure, 'timeout');
  assert.deepEqual(requests, [{ provider: 'codex', model: 'gpt-5.6-terra' }]);
  // Drain the intentionally timed-out mock before closing its isolated home.
  await new Promise(resolve => setTimeout(resolve, 1250));
});
