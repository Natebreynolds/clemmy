import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-selected-judge-fallback-'));
Object.assign(process.env, { CLEMENTINE_HOME: TEST_HOME, CLEMMY_TEST_ISOLATED_HOME: '1',
  OPENAI_AGENTS_DISABLE_TRACING: '1', NODE_ENV: 'test' });
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { Usage } = await import('@openai/agents');
const { ClaudeModelProvider } = await import('./claude-model.js');
const { CodexModelProvider } = await import('./codex-model.js');
const { captureBoundaryJudgeSelection, isCapturedBoundaryJudgeSelection, resolveBoundaryJudgeChain,
  resolveBoundaryJudgeHedge, resolveBoundaryJudge, resolveSelectedJudgeFallback } = await import('./debate-model.js');
type Selection = import('./debate-model.js').CapturedBoundaryJudgeSelection;
const { runHedgedJudge, parseCompletionVerdict } = await import('./objective-judge.js');
const { __setClaudeUsageForTests } = await import('./claude-usage.js');
const { __resetRateLimitStoreForTests, recordCodexRateLimit } = await import('./rate-limit-store.js');
const { _setDiscoveredModelsForTest } = await import('./model-discovery.js');
const { closeEventLog, createSession } = await import('./eventlog.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('./brackets.js');
const { selectIndependentTerminalDeliveryJudgeRoute } = await import('./terminal-delivery-judge.js');
const { selectIndependentTurnOpennessJudgeRoute } = await import('./turn-openness.js');

const PRIMARY = 'claude-sonnet-5';
const FALLBACK = 'gpt-5.6-terra';
type Behavior = 'negative' | '429' | 'quota' | '503' | 'network' | 'auth' | 'hung' | 'invalid' | 'cancel';
let behavior: Behavior = 'negative';
let fallbackFails = false;
let onPrimaryStarted: (() => void) | undefined;
const calls: Array<{ provider: string; modelId?: string; signal?: AbortSignal }> = [];

function wire(provider: 'claude' | 'codex', modelId?: string): Model {
  return {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      calls.push({ provider, modelId, signal: request.signal });
      const isPrimary = modelId === PRIMARY;
      if (isPrimary) onPrimaryStarted?.();
      if (!isPrimary && fallbackFails) throw Object.assign(new Error('fallback temporarily unavailable'), { status: 503 });
      if (isPrimary) {
        if (behavior === '429') throw Object.assign(new Error('rate_limit_error'), { status: 429 });
        if (behavior === 'quota') throw Object.assign(new Error("You're out of extra usage."), { status: 400 });
        if (behavior === '503') throw Object.assign(new Error('service unavailable'), { status: 503 });
        if (behavior === 'auth') throw Object.assign(new Error('invalid authentication token'), { status: 401 });
        if (behavior === 'network') throw new Error('socket hang up');
        if (behavior === 'cancel') throw new DOMException('The caller cancelled the review', 'AbortError');
        if (behavior === 'hung') return new Promise<ModelResponse>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      const text = isPrimary ? behavior === 'invalid' ? 'not a verdict' : 'INCOMPLETE: one receipt is missing'
        : 'DONE: all receipts checked';
      return { output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, providerData: {} }] }], usage: new Usage(), responseId: 'fixture' } as ModelResponse;
    },
    async *getStreamedResponse() { throw new Error('Unexpected streamed checker request'); },
  };
}

function writeAuth(claude = true, codex = true): void {
  writeFileSync(path.join(TEST_HOME, 'state', 'auth.json'), JSON.stringify(codex
    ? { codexOauth: { accessToken: 'fixture-codex', refreshToken: 'fixture-refresh' } } : {}));
  writeFileSync(path.join(TEST_HOME, 'state', 'claude-auth.json'), JSON.stringify({
    accessToken: claude ? 'sk-ant-oat01-fixture' : 'sk-ant-api03-no-subscription', expiresAt: Date.now() + 3_600_000,
  }));
}

function selectFallback(modelId = FALLBACK): void {
  process.env.CLEMMY_JUDGE_FALLBACK = JSON.stringify({ mode: 'model', modelId });
}

beforeEach(() => {
  mock.restoreAll();
  calls.length = 0;
  behavior = 'negative';
  fallbackFails = false;
  onPrimaryStarted = undefined;
  Object.assign(process.env, {
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: FALLBACK,
    CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'judge', modelId: PRIMARY, source: 'settings', scope: 'durable' }]),
    CLEMMY_JUDGE_CHAIN: 'on', CLEMMY_JUDGE_CROSS_FAMILY: 'on', CLEMMY_JUDGE_HEDGE: 'on',
    CLEMMY_JUDGE_HEDGE_DELAY_MS: '500', CLEMMY_EXACT_JUDGE_TIMEOUT_MS: '90000',
    CLEMMY_CLAUDE_OVERLOAD_FALLBACK: 'on', CLEMMY_CLAUDE_TRANSPORT: 'raw_messages',
    CLEMMY_DEBATE_JUDGE: '', BYO_PROVIDERS: '', BYO_MODEL_ID: '', BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '',
    BYO_PROVIDER_ALPHA_API_KEY: '', BYO_PROVIDER_BETA_API_KEY: '',
  });
  selectFallback();
  writeAuth();
  __setClaudeUsageForTests(null);
  __resetRateLimitStoreForTests();
  _setDiscoveredModelsForTest({ anthropic: [], openai: [] });
  mock.method(ClaudeModelProvider.prototype, 'getModel', (id?: string) => wire('claude', id));
  mock.method(CodexModelProvider.prototype, 'getModel', (id?: string) => wire('codex', id));
  mock.method(globalThis, 'fetch', async () => { throw new Error('Unmocked network call prohibited'); });
});

after(() => { mock.restoreAll(); closeEventLog(); rmSync(TEST_HOME, { recursive: true, force: true }); });

function review(selection?: Selection, timeoutMs = 2_000, reviewedAuthor?: import('./model-roles.js').ResolvedRoleModel) {
  return runHedgedJudge('Review the requested receipts.', 'Eight receipts were requested.',
    parseCompletionVerdict, value => value.done, 'completion', {
      timeoutMs, quotaAwareRoute: true, boundaryJudgeSelection: selection ?? captureBoundaryJudgeSelection(), reviewedAuthor,
    });
}

function exhaustClaude(): void {
  __setClaudeUsageForTests({ fiveHour: { usedPercent: 100, resetAt: Date.now() + 3_600_000 },
    weekly: { usedPercent: 20, resetAt: Date.now() + 72 * 3_600_000 }, capturedAt: Date.now() });
}

test('a valid primary rejection stands; a selected fallback is never a second opinion or a hedge', async () => {
  const selection = captureBoundaryJudgeSelection();
  assert.equal(resolveBoundaryJudgeHedge(resolveBoundaryJudge(selection), selection), null);
  const result = await review(selection);
  assert.equal(result.value?.done, false);
  assert.equal(result.routing?.modelId, PRIMARY);
  assert.deepEqual(calls.map(c => c.modelId), [PRIMARY]);
});

for (const failure of ['429', 'quota', '503', 'network', 'auth', 'hung'] as const) {
  test(`an explicit fallback handles ${failure} once and reports the actual selected reviewer`, async () => {
    behavior = failure;
    const result = await review(undefined, failure === 'hung' ? 30 : 2_000);
    assert.equal(result.value?.done, true);
    assert.equal(result.routing?.modelId, FALLBACK);
    assert.equal(result.routing?.requestedModelId, PRIMARY);
    assert.equal(result.routing?.substituteForExactPin, true);
    assert.equal(result.routing?.ownerSelectedJudge, true);
    assert.equal(result.routing?.selfJudge, true);
    assert.equal(result.routing?.transport, 'codex_responses');
    assert.deepEqual(calls.map(c => c.modelId), [PRIMARY, FALLBACK]);
    if (failure === 'hung') assert.equal(calls[0]?.signal?.aborted, true, 'cancel primary before advancing');
  });
}

for (const failure of ['invalid', 'cancel'] as const) {
  test(`the explicit fallback does not replace ${failure}`, async () => {
    behavior = failure;
    const result = await review();
    assert.equal(result.value, null);
    assert.deepEqual(calls.map(c => c.modelId), failure === 'invalid' ? [PRIMARY, PRIMARY] : [PRIMARY]);
  });
}

test('a user stop while the primary is hung cancels the review without starting the fallback', async () => {
  const controller = new AbortController();
  behavior = 'hung';
  onPrimaryStarted = () => setTimeout(() => controller.abort(), 0);
  const session = createSession({ kind: 'chat', channel: 'desktop', title: 'Selected fallback cancellation fixture' });
  const result = await withHarnessRunContext({ sessionId: session.id, counter: new ToolCallsCounter(10), callerCancelSignal: controller.signal },
    () => review(undefined, 200));
  assert.equal(result.value, null);
  assert.deepEqual(calls.map(c => c.modelId), [PRIMARY]);
  assert.equal(calls[0]?.signal?.aborted, true);
});

test('known quota uses the explicit fallback even when the old chain flag is off', async () => {
  process.env.CLEMMY_JUDGE_CHAIN = 'off';
  exhaustClaude();
  const result = await review();
  assert.equal(result.value?.done, true);
  assert.equal(result.routing?.substituteReason, 'exact_pin_quota_exhausted');
  assert.deepEqual(calls.map(c => c.modelId), [FALLBACK]);
});

test('an unavailable primary can use the explicitly selected fallback without claiming primary qualification', async () => {
  writeAuth(false);
  const result = await review();
  assert.equal(result.value?.done, true);
  assert.equal(result.routing?.requestedModelId, PRIMARY);
  assert.equal(result.routing?.substituteReason, 'exact_pin_unresolved');
  assert.deepEqual(calls.map(c => c.modelId), [FALLBACK]);
});

test('a failed selected fallback does not hop to a third model', async () => {
  behavior = '503';
  fallbackFails = true;
  const result = await review();
  assert.equal(result.value, null);
  assert.deepEqual(calls.map(c => c.modelId), [PRIMARY, FALLBACK]);
});

test('a fallback already used for known quota is never attempted twice', async () => {
  exhaustClaude();
  fallbackFails = true;
  const result = await review();
  assert.equal(result.value, null);
  assert.deepEqual(calls.map(c => c.modelId), [FALLBACK]);
});

test('choosing the primary as fallback does not duplicate its failed attempt', async () => {
  selectFallback(PRIMARY);
  behavior = '503';
  const result = await review();
  assert.equal(result.value, null);
  assert.match(result.unavailableReason ?? '', /same checker/);
  assert.deepEqual(calls.map(c => c.modelId), [PRIMARY]);
});

test('off stops construction-time and call-time fallback and removes every chain alternate', async () => {
  process.env.CLEMMY_JUDGE_FALLBACK = '{"mode":"off"}';
  assert.deepEqual(resolveBoundaryJudgeChain().map(r => r.modelId), [PRIMARY]);
  const selection = captureBoundaryJudgeSelection();
  assert.equal(resolveBoundaryJudgeHedge(resolveBoundaryJudge(selection), selection), null);
  exhaustClaude();
  assert.equal((await review(selection)).value, null);
  assert.deepEqual(calls, []);
  __setClaudeUsageForTests(null);
  behavior = 'quota';
  assert.equal((await review(selection)).value, null);
  assert.deepEqual(calls.map(c => c.modelId), [PRIMARY]);
});

test('boundary chains contain only the primary and selected fallback, or neither unchosen alternate', () => {
  assert.deepEqual(resolveBoundaryJudgeChain().map(r => r.modelId), [PRIMARY, FALLBACK]);
  selectFallback('missing-fixture-reviewer');
  assert.deepEqual(resolveBoundaryJudgeChain().map(r => r.modelId), [PRIMARY]);
  exhaustClaude();
  assert.deepEqual(resolveBoundaryJudgeChain(), []);
});

test('a selected fallback cannot overtake a healthy default primary in a one-shot selector', () => {
  process.env.CLEMMY_MODEL_ROLES = '[]';
  const chain = resolveBoundaryJudgeChain();
  assert.equal(chain.length, 2);
  assert.equal(chain[0]?.ownerSelectedJudge, undefined);
  assert.equal(chain[1]?.ownerSelectedJudge, true);
  assert.equal(chain[1]?.deferredFallback, true);
  assert.equal(selectIndependentTerminalDeliveryJudgeRoute(chain), chain[0]);
  assert.equal(selectIndependentTurnOpennessJudgeRoute(chain, 'codex'), chain[0]);
});

test('an independent selected fallback cannot bypass a healthy same-family primary', () => {
  process.env.CLEMMY_MODEL_ROLES = '[]';
  process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
  selectFallback(PRIMARY);
  const chain = resolveBoundaryJudgeChain();
  assert.equal(chain[0]?.judgeFamily, 'codex');
  assert.equal(chain[0]?.selfJudge, true);
  assert.equal(chain[1]?.judgeFamily, 'claude');
  assert.equal(chain[1]?.deferredFallback, true);
  assert.equal(selectIndependentTurnOpennessJudgeRoute(chain, 'codex'), null);
  assert.equal(selectIndependentTerminalDeliveryJudgeRoute(chain), null);
});

test('known primary quota activates the selected fallback for one-shot routing too', () => {
  exhaustClaude();
  const chain = resolveBoundaryJudgeChain();
  assert.equal(chain.length, 1);
  assert.equal(chain[0]?.modelId, FALLBACK);
  assert.equal(chain[0]?.deferredFallback, undefined);
  assert.equal(selectIndependentTerminalDeliveryJudgeRoute(chain), chain[0]);
});

test('an inactive quota-limited primary cannot be mistaken for its selected fallback when building a chain', () => {
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'judge', modelId: FALLBACK, source: 'settings', scope: 'durable' }]);
  selectFallback('claude-haiku-4-5');
  recordCodexRateLimit({ 'x-codex-primary-used-percent': '100',
    'x-codex-primary-reset-after-seconds': '3600', 'x-codex-primary-window-minutes': '300' });
  const chain = resolveBoundaryJudgeChain();
  assert.equal(chain.length, 1);
  assert.equal(chain[0]?.modelId, 'claude-haiku-4-5');
  assert.equal(chain[0]?.requestedModelId, FALLBACK);
  assert.equal(chain[0]?.substituteReason, 'exact_pin_quota_exhausted');
  assert.equal(chain[0]?.deferredFallback, undefined);
});

test('accepted fallback policy survives settings edits and durable serialization', async () => {
  const selection = JSON.parse(JSON.stringify(captureBoundaryJudgeSelection())) as Selection;
  assert.equal(isCapturedBoundaryJudgeSelection(selection), true);
  process.env.CLEMMY_JUDGE_FALLBACK = '{"mode":"off"}';
  behavior = 'network';
  const result = await review(selection);
  assert.equal(result.routing?.modelId, FALLBACK);
  assert.deepEqual(calls.map(c => c.modelId), [PRIMARY, FALLBACK]);
});

test('a captured off policy cannot acquire a later selected fallback', async () => {
  process.env.CLEMMY_JUDGE_FALLBACK = '{"mode":"off"}';
  const selection = captureBoundaryJudgeSelection();
  selectFallback();
  behavior = 'quota';
  const result = await review(selection);
  assert.equal(result.value, null);
  assert.deepEqual(calls.map(c => c.modelId), [PRIMARY]);
});

test('an unavailable saved fallback does not break a healthy primary and cannot invite a third route', async () => {
  selectFallback('unavailable-review-fixture');
  const selected = captureBoundaryJudgeSelection();
  const healthy = await review(selected);
  assert.equal(healthy.value?.done, false);
  behavior = '503';
  const outage = await review(selected);
  assert.equal(outage.value, null);
  assert.match(outage.unavailableReason ?? '', /selected fallback unavailable-review-fixture is unavailable/);
  assert.deepEqual(calls.map(c => c.modelId), [PRIMARY, PRIMARY]);
});

test('durable fallback validation rejects a changed role identity and a missing API provider identity', () => {
  const selected = captureBoundaryJudgeSelection();
  assert.equal(selected.status, 'captured');
  if (selected.status !== 'captured' || selected.fallback?.mode !== 'model'
    || selected.fallback.resolution.status !== 'available') throw new Error('Selected fallback unavailable');
  const changedRole = { ...selected, fallback: { ...selected.fallback, resolution: { ...selected.fallback.resolution,
    role: { ...selected.fallback.resolution.role, modelId: PRIMARY } } } };
  assert.equal(isCapturedBoundaryJudgeSelection(changedRole), false);
  const missingApiIdentity = { ...selected, fallback: { ...selected.fallback, resolution: { ...selected.fallback.resolution,
    role: { ...selected.fallback.resolution.role, provider: 'byo' } } } };
  assert.equal(isCapturedBoundaryJudgeSelection(missingApiIdentity), false);
});

test('a selected same-family fallback is exact and reports the reviewed author’s family', async () => {
  const sibling = 'claude-haiku-4-5';
  selectFallback(sibling);
  behavior = 'network';
  const result = await review(undefined, 2_000, { modelId: PRIMARY, provider: 'claude', source: 'settings' });
  assert.equal(result.value?.done, true);
  assert.equal(result.routing?.modelId, sibling);
  assert.equal(result.routing?.selfJudge, true);
  assert.equal(result.routing?.ownerSelectedJudge, true);
  assert.deepEqual(calls.map(c => c.modelId), [PRIMARY, sibling]);
  const invocation = (ClaudeModelProvider.prototype.getModel as unknown as { mock: { calls: Array<{ arguments: unknown[] }> } }).mock.calls;
  assert.deepEqual(invocation.at(-1)?.arguments[1], { allowOverloadFallback: false });
});

function configureByo(modelId = 'review-fixture', endpoint = 'https://alpha.invalid/v1'): void {
  process.env.BYO_PROVIDERS = JSON.stringify([{ id: 'alpha', label: 'Alpha', baseURL: endpoint, modelIds: [modelId] }]);
  process.env.BYO_PROVIDER_ALPHA_API_KEY = 'fixture-alpha';
  selectFallback(modelId);
}

test('an explicit subscription fallback keeps its exact transport with an all-in API brain', async () => {
  // One legacy default API connection. Declaring the same ID again in Alpha
  // would deliberately trigger the independent ambiguous-owner guard.
  process.env.MODEL_ROUTING_MODE = 'all_in';
  process.env.BYO_MODEL_ID = 'api-brain-fixture';
  process.env.BYO_MODEL_BASE_URL = 'https://alpha.invalid/v1';
  process.env.BYO_MODEL_API_KEY = 'fixture-alpha';
  selectFallback();
  const selected = captureBoundaryJudgeSelection();
  const route = resolveSelectedJudgeFallback({ modelId: PRIMARY, provider: 'claude', why: 'fixture outage' }, selected);
  assert.equal(route.modelId, FALLBACK);
  assert.equal(route.judgeFamily, 'codex');
  assert.equal(route.transport, 'codex_responses');
  await route.model!.getResponse({} as ModelRequest);
  assert.deepEqual(calls.map(c => ({ provider: c.provider, modelId: c.modelId })), [{ provider: 'codex', modelId: FALLBACK }]);
  assert.equal((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length, 0);
});

test('the selected API model is bound to its captured provider and can refresh only its credential', async () => {
  configureByo();
  const selected = captureBoundaryJudgeSelection();
  assert.equal(isCapturedBoundaryJudgeSelection(selected), true);
  assert.doesNotMatch(JSON.stringify(selected), /fixture-alpha|apiKey|accessToken/);
  process.env.BYO_PROVIDER_ALPHA_API_KEY = 'fixture-alpha-refreshed';
  behavior = '429';
  const requests: Array<{ url: string; model: unknown; authorization: string | null }> = [];
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = await req.json() as { model?: unknown };
    requests.push({ url: req.url, model: body.model, authorization: req.headers.get('authorization') });
    return new Response(JSON.stringify({ id: 'fixture-api', object: 'chat.completion', created: 1, model: 'review-fixture',
      choices: [{ index: 0, message: { role: 'assistant', content: 'DONE: all receipts checked' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await review(selected);
  assert.equal(result.value?.done, true);
  assert.equal(result.routing?.judgeFamily, 'byo');
  assert.equal(result.routing?.judgeProviderId, 'alpha');
  assert.equal(result.routing?.modelId, 'review-fixture');
  assert.deepEqual(requests, [{ url: 'https://alpha.invalid/v1/chat/completions', model: 'review-fixture',
    authorization: 'Bearer fixture-alpha-refreshed' }]);
  assert.deepEqual(calls.map(c => c.modelId), [PRIMARY]);
});

for (const change of ['endpoint', 'owner', 'model'] as const) {
  test(`a captured API fallback with changed ${change} is unavailable without retargeting`, async () => {
    configureByo();
    const selected = captureBoundaryJudgeSelection();
    process.env.BYO_PROVIDERS = JSON.stringify([{ id: change === 'owner' ? 'beta' : 'alpha', label: 'Changed',
      baseURL: change === 'endpoint' ? 'https://changed.invalid/v1' : 'https://alpha.invalid/v1',
      modelIds: [change === 'model' ? 'different-fixture' : 'review-fixture'] }]);
    process.env.BYO_PROVIDER_BETA_API_KEY = 'fixture-beta';
    behavior = 'network';
    const result = await review(selected);
    assert.equal(result.value, null);
    assert.match(result.unavailableReason ?? '', /identity is unavailable or has changed/);
    assert.deepEqual(calls.map(c => c.modelId), [PRIMARY]);
    assert.equal((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length, 0);
  });
}
