import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-judge-parse-diagnostic-'));
Object.assign(process.env, { CLEMENTINE_HOME: testHome, CLEMMY_TEST_ISOLATED_HOME: '1',
  OPENAI_AGENTS_DISABLE_TRACING: '1', AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off',
  OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra', CLEMMY_MODEL_ROLES: '[]', CLEMMY_JUDGE_FALLBACK: '{"mode":"automatic"}',
  CLEMMY_JUDGE_CROSS_FAMILY: 'on', CLEMMY_JUDGE_HEDGE: 'on', CLEMMY_JUDGE_HEDGE_DELAY_MS: '500',
  CLEMMY_CLAUDE_TRANSPORT: 'raw_messages', CLEMMY_CLAUDE_OVERLOAD_FALLBACK: 'off' });
mkdirSync(path.join(testHome, 'state'), { recursive: true });
writeFileSync(path.join(testHome, 'state/auth.json'), JSON.stringify({ codexOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh' } }));
writeFileSync(path.join(testHome, 'state/claude-auth.json'), JSON.stringify({ accessToken: 'sk-ant-oat01-fixture', expiresAt: Date.now() + 3_600_000 }));
const { Usage } = await import('@openai/agents');
const { runRoutedJudgeAttempt, runHedgedJudge, sanitizeJudgeInitialParseDiagnostic } = await import('./objective-judge.js');
const { parseWorkflowMutationReview, workflowMutationReviewInvalidReason } = await import('./workflow-mutation-review.js');
const { ClaudeModelProvider } = await import('./claude-model.js');
const { CodexModelProvider } = await import('./codex-model.js');
const { closeEventLog } = await import('./eventlog.js');

beforeEach(() => {
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => { throw new Error('Unmocked network request prohibited'); });
});
after(() => { mock.restoreAll(); closeEventLog(); rmSync(testHome, { recursive: true, force: true }); });

const digest = 'a'.repeat(64);
const valid = JSON.stringify({ verdict: 'compatible', reason: 'Synthetic constraints checked.', proposalDigest: digest });
const parse = (output: unknown) => parseWorkflowMutationReview(output, digest);
const classify = (output: unknown) => ({ not_json: 'malformed_output', no_verdict: 'missing_verdict',
  digest_missing: 'missing_binding', digest_mismatch: 'binding_mismatch', no_reason: 'missing_reason' }[workflowMutationReviewInvalidReason(output, digest)]);
function response(text: string): ModelResponse {
  return { output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, providerData: {} }] }], usage: new Usage(), responseId: 'parse-fixture' };
}
function scripted(texts: string[]) {
  const requests: ModelRequest[] = [];
  const model: Model = { async getResponse(request) { requests.push(request); return response(texts[requests.length - 1]!); },
    async *getStreamedResponse() { throw new Error('Unexpected stream'); } };
  return { model, requests };
}
const route = (model: Model) => ({ model, modelId: 'fixture-judge', judgeFamily: 'claude' as const,
  brainFamily: 'codex' as const, transport: 'claude_subscription' as const, selfJudge: false });
const attempt = (model: Model, observer: (value: unknown) => unknown, classifier: (output: unknown) => unknown = classify) =>
  runRoutedJudgeAttempt(route(model), 'Review the synthetic write and return JSON with the supplied digest.',
    `Synthetic proposal digest: ${digest}`, parse, false, undefined, undefined, 'medium', undefined,
    { initialParse: observer }, undefined, undefined, undefined, classifier);

test('valid first verdict records parsed without classification or another request', async () => {
  const { model, requests } = scripted([valid]);
  const observed: unknown[] = [];
  const result = await attempt(model, value => observed.push(value), () => { throw new Error('must not classify a parsed verdict'); });
  assert.equal(result.verdict, 'compatible');
  assert.deepEqual(observed, [{ status: 'parsed', reason: null }]);
  assert.equal(requests.length, 1);
});

for (const [first, reason] of [
  ['private-fixture-review-prose', 'malformed_output'],
  [JSON.stringify({ verdict: 'compatible', reason: 'Synthetic review.', proposalDigest: 'b'.repeat(64) }), 'binding_mismatch'],
] as const) {
  test(`${reason} remains the initial diagnosis after successful repair`, async () => {
    const { model, requests } = scripted([first, valid]);
    const observed: unknown[] = [];
    const result = await attempt(model, value => observed.push(value));
    assert.equal(result.proposalDigest, digest);
    assert.deepEqual(observed, [{ status: 'rejected', reason }]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.modelSettings.reasoning?.effort, 'medium');
    assert.equal(requests[1]!.modelSettings.reasoning?.effort, 'low');
    assert.equal(requests[1]!.tools?.length ?? 0, 0);
    assert.equal(JSON.stringify(observed).includes('private-fixture-review-prose'), false);
  });
}

test('diagnostic classifier and observer failures cannot change verdict or requests', async () => {
  for (const classifier of [() => { throw new Error('private-classifier-error'); }, () => 'private-classifier-output',
    () => Promise.reject(new Error('private-async-classifier-error'))]) {
    const { model, requests } = scripted(['private-review', valid]);
    const observed: unknown[] = [];
    const result = await attempt(model, value => { observed.push(value); throw new Error('private-observer-error'); }, classifier);
    assert.equal(result.verdict, 'compatible');
    assert.deepEqual(observed, [{ status: 'rejected', reason: 'unknown' }]);
    assert.equal(requests.length, 2);
  }
  const { model, requests } = scripted([valid]);
  assert.equal((await attempt(model, () => Promise.reject(new Error('private-async-observer-error')))).verdict, 'compatible');
  assert.equal(requests.length, 1);
});

test('structural parse diagnostics retain only finite malformed-output details', () => {
  for (const structure of ['empty_output', 'json_syntax', 'top_level_shape']) {
    assert.deepEqual(sanitizeJudgeInitialParseDiagnostic({ status: 'rejected', reason: 'malformed_output',
      structure, output: 'private-review', error: 'private-error' }), { status: 'rejected', reason: 'malformed_output', structure });
  }
  for (const structure of ['private-forged-detail', { text: 'private-review' }, null]) {
    assert.deepEqual(sanitizeJudgeInitialParseDiagnostic({ status: 'rejected', reason: 'malformed_output', structure }),
      { status: 'rejected', reason: 'malformed_output' });
  }
  assert.deepEqual(sanitizeJudgeInitialParseDiagnostic({ status: 'parsed', reason: null, structure: 'json_syntax' }),
    { status: 'parsed', reason: null });
  assert.deepEqual(sanitizeJudgeInitialParseDiagnostic({ status: 'rejected', reason: 'binding_mismatch', structure: 'json_syntax' }),
    { status: 'rejected', reason: 'binding_mismatch' });
});

for (const [field, allowed] of [['status', 'rejected'], ['reason', 'malformed_output'], ['structure', 'json_syntax']] as const) {
  test(`structural diagnostics snapshot ${field} once before validation`, () => {
    const expected = { status: 'rejected', reason: 'malformed_output', structure: 'json_syntax' };
    let reads = 0;
    const candidate = Object.defineProperty({ ...expected }, field, { get: () => ++reads === 1 ? allowed : 'private-late-value' });
    const diagnostic = sanitizeJudgeInitialParseDiagnostic(candidate);
    assert.equal(JSON.stringify(diagnostic).includes('private-'), false);
    assert.deepEqual(diagnostic, expected);
    assert.equal(reads, 1);
    assert.equal(sanitizeJudgeInitialParseDiagnostic(Object.defineProperty({ ...expected }, field,
      { get: () => { throw new Error('private-getter-error'); } })), null);
  });
}

for (const [first, structure] of [
  ['private-review-prose', 'json_syntax'], ['[]', 'top_level_shape'], [`\`\`\`json\n${valid}\n\`\`\``, 'json_syntax'],
] as const) test(`structural parse detail ${structure} for ${first === '[]' ? 'array' : first.startsWith('```') ? 'fenced JSON' : 'prose'} preserves repair requests`, async () => {
  const baseline = scripted([first, valid]);
  const fixture = scripted([first, valid]);
  const observed: unknown[] = [];
  assert.equal(parse(first), null, 'diagnostics never make the first output acceptable');
  const original = await attempt(baseline.model, () => {});
  const result = await attempt(fixture.model, value => observed.push(value), () => ({ reason: 'malformed_output', structure,
    output: 'private-review', error: 'private-error' }));
  assert.deepEqual(result, original);
  assert.deepEqual(observed, [{ status: 'rejected', reason: 'malformed_output', structure }]);
  assert.equal(fixture.requests.length, 2);
  const requestBytes = (requests: ModelRequest[]) => requests.map(request => ({ instructions: request.systemInstructions,
    input: request.input, settings: request.modelSettings, tools: request.tools }));
  assert.deepEqual(requestBytes(fixture.requests), requestBytes(baseline.requests));
  assert.equal(fixture.requests[1]!.modelSettings.reasoning?.effort, 'low');
  assert.equal(fixture.requests[1]!.tools?.length ?? 0, 0);
});

test('empty structural rejection remains one failed request without a restatement', async () => {
  const { model, requests } = scripted(['']);
  const observed: unknown[] = [];
  await assert.rejects(attempt(model, value => observed.push(value), () => ({ reason: 'malformed_output', structure: 'empty_output' })),
    /reviewer returned no text/);
  assert.deepEqual(observed, [{ status: 'rejected', reason: 'malformed_output', structure: 'empty_output' }]);
  assert.equal(requests.length, 1);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

for (const repairedWinner of [false, true, 'structural'] as const) test(`a losing hedge cannot contaminate a ${repairedWinner === 'structural' ? 'structurally rejected' : repairedWinner ? 'repaired' : 'first-parse'} winner, even after late completion`, { timeout: 5_000 }, async () => {
  const primaryReply = deferred<ModelResponse>();
  const hedgeRepair = deferred<ModelResponse>();
  const hedgeStartedRepair = deferred<void>();
  let primaryCalls = 0;
  let hedgeCalls = 0;
  mock.method(CodexModelProvider.prototype, 'getModel', () => ({
    async getResponse() { return ++primaryCalls === 1 ? primaryReply.promise : response(valid); },
    async *getStreamedResponse() { throw new Error('Unexpected stream'); },
  }));
  mock.method(ClaudeModelProvider.prototype, 'getModel', () => ({
    async getResponse() {
      if (++hedgeCalls === 1) return response('private-losing-hedge-review');
      hedgeStartedRepair.resolve(); return hedgeRepair.promise;
    }, async *getStreamedResponse() { throw new Error('Unexpected stream'); },
  }));
  const running = runHedgedJudge('Review the synthetic write.', `Synthetic proposal digest: ${digest}`, parse,
    value => value.verdict === 'compatible', 'mutation_constraints', { timeoutMs: 4_000,
      boundaryJudgeSelection: { status: 'captured', role: { modelId: 'gpt-5.6-terra', provider: 'codex', source: 'default' },
        crossFamily: true, defaultModels: { claude: 'claude-sonnet-5', codex: 'gpt-5.6-terra' } },
      classifyParseRejection: output => output === '[]' ? { reason: 'malformed_output', structure: 'top_level_shape' }
        : output === 'private-losing-hedge-review' ? { reason: 'malformed_output', structure: 'json_syntax' } : classify(output) });
  try {
    await hedgeStartedRepair.promise;
    primaryReply.resolve(response(repairedWinner === 'structural' ? '[]' : repairedWinner
      ? JSON.stringify({ verdict: 'compatible', reason: 'Synthetic review.', proposalDigest: 'b'.repeat(64) }) : valid));
    const result = await running;
    assert.equal(result.value?.verdict, 'compatible');
    assert.equal(result.routing?.modelId, 'gpt-5.6-terra');
    const expected = repairedWinner === 'structural' ? { status: 'rejected', reason: 'malformed_output', structure: 'top_level_shape' }
      : repairedWinner ? { status: 'rejected', reason: 'binding_mismatch' } : { status: 'parsed', reason: null };
    assert.deepEqual(result.initialParse, expected);
    assert.equal(typeof result.restatedFrom === 'string', Boolean(repairedWinner));
    hedgeRepair.resolve(response(valid));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(result.initialParse, expected);
    assert.equal(hedgeCalls, 2);
    assert.equal(primaryCalls, repairedWinner ? 2 : 1);
  } finally { primaryReply.resolve(response(valid)); hedgeRepair.resolve(response(valid)); }
});
