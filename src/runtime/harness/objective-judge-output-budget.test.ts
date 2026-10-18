import assert from 'node:assert/strict';
import { after, afterEach, mock, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const priorHome = process.env.CLEMENTINE_HOME;
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-judge-output-budget-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(home, 'state'), { recursive: true });
const { Usage } = await import('@openai/agents');
const { completionJudgeContextAdmission, judgeMaxOutputTokens, parseCompletionVerdict, runHedgedJudge,
  runRoutedJudgeAttempt } = await import('./objective-judge.js');
const { recordCatalogWindow } = await import('./model-window-observations.js');
const { resolveModelCapability } = await import('./model-wire-registry.js');
const { closeEventLog } = await import('./eventlog.js');
const { captureBoundaryJudgeSelection } = await import('./debate-model.js');
const { ClaudeModelProvider } = await import('./claude-model.js');
const { CodexModelProvider } = await import('./codex-model.js');
const { _setDiscoveredModelsForTest } = await import('./model-discovery.js');
const savedEnv = new Map<string, string | undefined>();
function env(key: string, value: string) {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}
afterEach(() => {
  mock.restoreAll();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  savedEnv.clear();
});
after(() => {
  closeEventLog(); rmSync(home, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.CLEMENTINE_HOME; else process.env.CLEMENTINE_HOME = priorHome;
});
function scripted(answer: (request: ModelRequest, call: number) => string) {
  const requests: ModelRequest[] = [];
  const model: Model = {
    async getResponse(request): Promise<ModelResponse> {
      requests.push(request);
      const text = answer(request, requests.length);
      return { output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, providerData: {} }] }], usage: new Usage(), responseId: `budget-fixture-${requests.length}` };
    },
    async *getStreamedResponse() { throw new Error('The fixture reviewer must not stream'); },
  };
  return { model, requests };
}
const route = (modelId: string, model: Model) => ({ modelId, model, judgeFamily: 'byo' as const,
  brainFamily: 'byo' as const, transport: 'byo_api' as const, selfJudge: false });
const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
  : Array.isArray(value) ? value.flatMap(strings)
    : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];

test('the selected route cap bounds both admission and the actual review request', async () => {
  env('CLEMMY_JUDGE_MAX_OUTPUT_TOKENS', '65536');
  for (const modelId of ['claude-sonnet-5', 'grok-4.6', 'unknown-budget-fixture']) {
    const cap = resolveModelCapability(modelId).maxOutput;
    const fixture = scripted(() => 'DONE: exact requested content verified');
    const admission = completionJudgeContextAdmission(modelId, 'Audit the complete objective.', 'All required evidence is retained.');
    const verdict = await runRoutedJudgeAttempt(route(modelId, fixture.model), 'Audit the complete objective.',
      'All required evidence is retained.', parseCompletionVerdict, true, undefined, undefined, 'medium');
    assert.equal(verdict.done, true);
    assert.equal(fixture.requests.length, 1);
    assert.equal(admission.outputReserve, Math.min(65_536, cap));
    assert.equal(fixture.requests[0]!.modelSettings.maxTokens, admission.outputReserve);
    assert.equal(fixture.requests[0]!.modelSettings.reasoning?.effort, 'medium', 'the budget does not alter review effort');
  }
});

test('complete evidence that fits the bounded review reaches the model without artificial ceiling rejection', async () => {
  env('CLEMMY_JUDGE_MAX_OUTPUT_TOKENS', '4096');
  const modelId = 'gpt-6-budget-complete';
  recordCatalogWindow(modelId, 32_000, 'controlled-window');
  const instructions = 'Audit the entire original objective and every retained evidence item.';
  const prompt = 'ORIGINAL_OBJECTIVE\n' + 'retained evidence '.repeat(4_000) + '\nFINAL_REQUIRED_EVIDENCE';
  const admission = completionJudgeContextAdmission(modelId, instructions, prompt);
  assert.equal(admission.fits, true);
  assert.ok(admission.estimatedInputTokens + resolveModelCapability(modelId).maxOutput > admission.contextWindow,
    'the old model-ceiling reserve would reject this otherwise complete request');
  const fixture = scripted(request => {
    assert.ok(strings(request).includes(instructions), 'the original objective-review instructions reach the actual request');
    assert.ok(strings(request.input).includes(prompt), 'all objective and evidence bytes reach the actual request');
    assert.equal(request.modelSettings.maxTokens, admission.outputReserve);
    return 'DONE: complete source and final requirement verified';
  });
  const verdict = await runRoutedJudgeAttempt(route(modelId, fixture.model), instructions, prompt, parseCompletionVerdict, true);
  assert.equal(verdict.done, true);
  assert.equal(fixture.requests.length, 1);
});

test('a genuinely oversized complete request is refused before any model call', async () => {
  env('CLEMMY_JUDGE_MAX_OUTPUT_TOKENS', '4096');
  const modelId = 'gpt-6-budget-oversized';
  recordCatalogWindow(modelId, 32_000, 'controlled-window');
  const prompt = 'required evidence '.repeat(15_000) + 'DO_NOT_DROP_THIS_REQUIREMENT';
  assert.equal(completionJudgeContextAdmission(modelId, 'Audit all requirements.', prompt).fits, false);
  const fixture = scripted(() => { throw new Error('Oversized evidence must not be dispatched'); });
  await assert.rejects(runRoutedJudgeAttempt(route(modelId, fixture.model), 'Audit all requirements.', prompt,
    parseCompletionVerdict, true), /Complete evidence review unavailable.*No source evidence was discarded/s);
  assert.equal(fixture.requests.length, 0);
});

test('verdict repair retains the admitted budget even when configuration changes during the first response', async () => {
  env('CLEMMY_JUDGE_MAX_OUTPUT_TOKENS', '4096');
  const modelId = 'gpt-6-budget-repair';
  recordCatalogWindow(modelId, 32_000, 'controlled-window');
  const review = 'I examined the retained content. '.repeat(800) + 'LAST_FINDING: the final required section is absent.';
  const fixture = scripted((request, call) => {
    if (call === 1) { env('CLEMMY_JUDGE_MAX_OUTPUT_TOKENS', '65536'); return review; }
    assert.ok(JSON.stringify(request.input).includes(review), 'repair preserves the entire review');
    return 'INCOMPLETE: the final required section is absent';
  });
  const verdict = await runRoutedJudgeAttempt(route(modelId, fixture.model), 'Audit every required section.',
    'The source artifact is retained in full.', parseCompletionVerdict, true, undefined, undefined, 'high');
  assert.equal(verdict.done, false);
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.requests.map(request => request.modelSettings.maxTokens), [4096, 4096]);
  assert.equal(fixture.requests[0]!.modelSettings.reasoning?.effort, 'high');
  assert.equal(fixture.requests[1]!.modelSettings.reasoning?.effort, 'low', 'only the existing restatement policy changes effort');
  assert.equal(judgeMaxOutputTokens(modelId), 65_536, 'the changed setting was not silently reused for the admitted repair');
});

test('an oversized full review is never clipped into an affirmative repair', async () => {
  env('CLEMMY_JUDGE_MAX_OUTPUT_TOKENS', '4096');
  const modelId = 'gpt-6-budget-repair-overflow';
  recordCatalogWindow(modelId, 32_000, 'controlled-window');
  const fixture = scripted(() => 'I examined the retained content. '.repeat(8_000) + 'LAST_FINDING: required content is absent.');
  await assert.rejects(runRoutedJudgeAttempt(route(modelId, fixture.model), 'Audit everything.', 'Full source retained.',
    parseCompletionVerdict, true), /judge output did not parse/);
  assert.equal(fixture.requests.length, 1, 'an inadmissible repair never dispatches a clipped second request');
});

test('a real configured fallback gets its own route cap through the same admission and Agent path', async () => {
  for (const [key, value] of Object.entries({
    CLEMMY_JUDGE_MAX_OUTPUT_TOKENS: '65536', AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off',
    OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra', CLEMMY_JUDGE_CROSS_FAMILY: 'on', CLEMMY_JUDGE_HEDGE: 'off',
    CLEMMY_CLAUDE_OVERLOAD_FALLBACK: 'off', CLEMMY_CLAUDE_TRANSPORT: 'raw_messages',
    CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'judge', modelId: 'claude-sonnet-5', scope: 'durable', source: 'settings' }]),
    CLEMMY_JUDGE_FALLBACK: JSON.stringify({ mode: 'model', modelId: 'gpt-5.6-terra' }),
    CLEMMY_DEBATE_JUDGE: '', BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '', BYO_MODEL_ID: '', BYO_PROVIDERS: '',
  })) env(key, value);
  writeFileSync(path.join(home, 'state/auth.json'), JSON.stringify({ codexOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh' } }));
  writeFileSync(path.join(home, 'state/claude-auth.json'), JSON.stringify({ accessToken: 'sk-ant-oat01-fixture', expiresAt: Date.now() + 3_600_000 }));
  _setDiscoveredModelsForTest({ anthropic: [], openai: [] });
  const requests: Array<{ modelId: string | undefined; outputBudget: unknown }> = [];
  const primary = scripted(request => {
    requests.push({ modelId: 'claude-sonnet-5', outputBudget: request.modelSettings.maxTokens });
    throw Object.assign(new Error('controlled provider unavailable'), { status: 503 });
  });
  const fallback = scripted(request => {
    requests.push({ modelId: 'gpt-5.6-terra', outputBudget: request.modelSettings.maxTokens });
    return 'DONE: the complete requested result is verified';
  });
  mock.method(ClaudeModelProvider.prototype, 'getModel', () => primary.model);
  mock.method(CodexModelProvider.prototype, 'getModel', () => fallback.model);
  mock.method(globalThis, 'fetch', () => { throw new Error('No real provider is permitted in this fixture'); });
  const selection = captureBoundaryJudgeSelection();
  assert.equal(selection.status, 'captured');
  const result = await runHedgedJudge('Audit the complete objective.', 'All exact evidence is retained.', parseCompletionVerdict,
    verdict => verdict.done, 'completion', { requireCompletePrompt: true, boundaryJudgeSelection: selection, timeoutMs: 1_000 });
  assert.equal(result.value?.done, true);
  assert.equal(result.routing?.modelId, 'gpt-5.6-terra');
  assert.deepEqual(requests, [{ modelId: 'claude-sonnet-5', outputBudget: 64_000 }, { modelId: 'gpt-5.6-terra', outputBudget: 65_536 }]);
});
