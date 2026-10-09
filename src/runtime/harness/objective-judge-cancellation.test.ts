import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-completion-cancellation-'));
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

const { Runner } = await import('@openai/agents');
const { _setCompletionJudgeForTests, judgeObjectiveComplete, runRoutedJudgeAttempt, parseCompletionVerdict,
  reviewAtStakes, runHedgedJudge, JEV_HEDGE_DELAY_MS } = await import('./objective-judge.js');
const { captureBoundaryJudgeSelection } = await import('./debate-model.js');
const { ClaudeModelProvider } = await import('./claude-model.js');
const { withJudgeHedge } = await import('./judge-family.js');
const { _setSystemOneFetchForTests, _setTypesafeKeyForTests } = await import('../jev/client.js');
const { harnessRunContextStorage } = await import('./brackets.js');
const { _setDiscoveredModelsForTest } = await import('./model-discovery.js');
const { closeEventLog } = await import('./eventlog.js');

const objective = 'Read the fixture result and report its exact value.';
const reply = 'The fixture result is 323.';
const completeContext = { skills: [], toolCallSummary: 'fixture_read succeeded', verifiedReadResults: [
  { toolName: 'fixture_read', outcome: 'succeeded', status: 'verified', contentComplete: true, evidenceKind: 'source_result' },
] };
const doneRun = () => ({ verdict: { done: true, reason: 'configured reviewer accepted' }, failure: null });
function reading(kind: 'done' | 'incomplete' | 'missing') {
  const scores = kind === 'done' ? { delivered: .93, unaddressed: .05 }
    : kind === 'missing' ? { delivered: .93, unaddressed: .9 } : { delivered: .1, unaddressed: .9 };
  return { status: 200, ok: true, text: async () => JSON.stringify({ model: 'jev-1.13.0',
    answers: Object.fromEntries(Object.entries({ computed: .03, asksUser: .03, cannotFinish: .03, unsupported: .05, ...scores })
      .map(([id, noul]) => [id, { type: 'noul', noul }])), usage: { input_tokens: 36, output_tokens: 5 } }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const stopError = () => new DOMException('fixture owner Stop', 'AbortError');

beforeEach(() => {
  mock.restoreAll();
  _setCompletionJudgeForTests(null);
  _setTypesafeKeyForTests('ts_fixture');
  _setDiscoveredModelsForTest({ anthropic: [], openai: [] });
  Object.assign(process.env, {
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra',
    CLEMMY_JUDGE_CROSS_FAMILY: 'on', CLEMMY_JUDGE_HEDGE: 'off', CLEMMY_COMPLETION_REVIEW: 'on',
    CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'judge', modelId: 'claude-sonnet-5', scope: 'durable', source: 'settings' }]),
    CLEMMY_DEBATE_JUDGE: '', CLEMMY_CLAUDE_TRANSPORT: 'raw_messages', CLEMMY_CLAUDE_OVERLOAD_FALLBACK: 'off',
    BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '', BYO_MODEL_ID: '', BYO_PROVIDERS: '',
  });
  mock.method(globalThis, 'fetch', async () => { throw new Error('Unmocked network prohibited'); });
});
afterEach(() => {
  mock.restoreAll();
  _setCompletionJudgeForTests(null);
  _setSystemOneFetchForTests(undefined);
  _setTypesafeKeyForTests(undefined);
});
after(() => { closeEventLog(); rmSync(testHome, { recursive: true, force: true }); });

test('late accepted Jev cancels a started configured reviewer without waiting or failed-open acceptance', async () => {
  const started = deferred<void>();
  const cancelled = deferred<void>();
  let reviewSignal: AbortSignal | undefined;
  _setCompletionJudgeForTests(async (_objective, _reply, _context, options) => {
    reviewSignal = options?.signal;
    started.resolve();
    const result = await withJudgeHedge(signal => new Promise<ReturnType<typeof doneRun>>((_resolve, reject) => {
      signal?.addEventListener('abort', () => { cancelled.resolve(); reject(signal.reason); }, { once: true });
    }), null, { lane: 'completion', signal: options?.signal, timeoutMs: 10_000 });
    return result.value!;
  });
  _setSystemOneFetchForTests(async () => { await started.promise; return reading('done'); });
  const verdict = await judgeObjectiveComplete(objective, reply, completeContext);
  await cancelled.promise;
  assert.equal(reviewSignal?.aborted, true);
  assert.equal(verdict.done, true);
  assert.equal(verdict.fast, true);
  assert.equal(verdict.failedOpen, undefined);
  assert.equal(verdict.jevAttempt?.accepted, true);
  assert.equal(verdict.jevAttempt?.reviewerStarted, true, 'a cancelled physical request is not recorded as a skipped request');
});

for (const kind of ['incomplete', 'missing'] as const) {
  test(`late Jev ${kind} keeps the configured reviewer authoritative`, async () => {
    const started = deferred<void>();
    const release = deferred<ReturnType<typeof doneRun>>();
    let reviewSignal: AbortSignal | undefined;
    _setCompletionJudgeForTests(async (_objective, _reply, _context, options) => {
      reviewSignal = options?.signal;
      started.resolve();
      return release.promise;
    });
    _setSystemOneFetchForTests(async () => {
      await started.promise;
      assert.equal(reviewSignal?.aborted, false);
      release.resolve(doneRun());
      return reading(kind);
    });
    const verdict = await judgeObjectiveComplete(objective, reply, completeContext);
    assert.equal(reviewSignal?.aborted, false);
    assert.equal(verdict.reason, 'configured reviewer accepted');
    assert.equal(verdict.fast, undefined);
    assert.equal(verdict.jevAttempt?.accepted, false);
    assert.equal(verdict.jevAttempt?.reviewerStarted, true);
  });
}

for (const [name, extra] of [['plan', { reviewsPlan: true }], ['write', { reviewStakes: 'write' as const }],
  ['memory', { memoryRequirementContext: 'exact source-owned memory completion obligation' }]] as const) {
  test(`${name} review keeps the configured reviewer; the outer Jev cancellation path is ineligible`, async () => {
    let jevCalls = 0;
    let reviewerCalls = 0;
    let reviewSignal: AbortSignal | undefined;
    _setSystemOneFetchForTests(async () => { jevCalls++; return reading('done'); });
    _setCompletionJudgeForTests(async (_objective, _reply, _context, options) => {
      reviewerCalls++; reviewSignal = options?.signal; return doneRun();
    });
    const verdict = await judgeObjectiveComplete(objective, reply, { ...completeContext, ...extra });
    assert.equal(reviewerCalls, 1);
    assert.equal(jevCalls, 0);
    assert.equal(reviewSignal?.aborted, false);
    assert.equal(verdict.reason, 'configured reviewer accepted');
    assert.equal(verdict.fast, undefined);
  });
}

test('owner Stop while Jev is pending clears the outer hedge and cannot accept Jev completion', async () => {
  const parent = new AbortController();
  const reason = stopError();
  const jevStarted = deferred<void>();
  const releaseJev = deferred<void>();
  let reviewerCalls = 0;
  _setCompletionJudgeForTests(async () => { reviewerCalls++; return doneRun(); });
  _setSystemOneFetchForTests(async () => { jevStarted.resolve(); await releaseJev.promise; return reading('done'); });
  const pending = harnessRunContextStorage.run({ callerCancelSignal: parent.signal } as never,
    () => judgeObjectiveComplete(objective, reply, completeContext));
  const rejection = assert.rejects(pending, error => error === reason);
  await jevStarted.promise;
  parent.abort(reason);
  releaseJev.resolve();
  await rejection;
  await new Promise(resolve => setTimeout(resolve, JEV_HEDGE_DELAY_MS + 25));
  assert.equal(reviewerCalls, 0, 'Stop cannot trigger a delayed reviewer');
});

test('owner Stop also reaches an already started reviewer and is never a failed-open verdict', async () => {
  const parent = new AbortController();
  const reason = stopError();
  const started = deferred<void>();
  const releaseJev = deferred<void>();
  let reviewSignal: AbortSignal | undefined;
  _setCompletionJudgeForTests(async (_objective, _reply, _context, options) => {
    reviewSignal = options?.signal;
    started.resolve();
    return new Promise((_resolve, reject) => reviewSignal?.addEventListener('abort', () => reject(reviewSignal.reason), { once: true }));
  });
  _setSystemOneFetchForTests(async () => { await started.promise; await releaseJev.promise; return reading('done'); });
  const pending = harnessRunContextStorage.run({ callerCancelSignal: parent.signal } as never,
    () => judgeObjectiveComplete(objective, reply, completeContext));
  const rejection = assert.rejects(pending, error => error === reason);
  await started.promise;
  parent.abort(reason);
  releaseJev.resolve();
  await rejection;
  assert.equal(reviewSignal?.aborted, true);
  assert.equal(reviewSignal?.reason, reason);
});

test('cancellation after the first fast finding prevents a full-depth confirmation', async () => {
  const parent = new AbortController();
  const reason = stopError();
  let reviews = 0;
  await assert.rejects(reviewAtStakes('read', async () => {
    reviews++;
    parent.abort(reason);
    return { verdict: { done: false, reason: 'unscoped finding' }, failure: null };
  }, { readEvidenceComplete: true, signal: parent.signal }), error => error === reason);
  assert.equal(reviews, 1);
});

test('the captured configured route receives parent cancellation without provider fallthrough', async () => {
  const parent = new AbortController();
  const reason = stopError();
  const started = deferred<void>();
  let calls = 0;
  let requestSignal: AbortSignal | undefined;
  let requestedModel: string | undefined;
  mock.method(ClaudeModelProvider.prototype, 'getModel', (modelId?: string) => {
    requestedModel = modelId;
    return {
      async getResponse(request: { signal?: AbortSignal }) {
        calls++; requestSignal = request.signal; started.resolve();
        return new Promise((_resolve, reject) => request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true }));
      },
      async *getStreamedResponse() { throw new Error('unexpected reviewer streaming'); },
    };
  });
  const selection = captureBoundaryJudgeSelection();
  assert.equal(selection.status, 'captured');
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'judge', modelId: 'gpt-5.6-terra', scope: 'durable', source: 'settings' }]);
  const pending = runHedgedJudge('Review the fixture receipts.', objective, parseCompletionVerdict, value => value.done,
    'completion', { boundaryJudgeSelection: selection, quotaAwareRoute: true, signal: parent.signal });
  const rejection = assert.rejects(pending, error => error === reason);
  await started.promise;
  parent.abort(reason);
  await rejection;
  assert.equal(requestedModel, 'claude-sonnet-5');
  assert.equal(requestSignal?.aborted, true);
  assert.equal(requestSignal?.reason, reason);
  assert.equal(calls, 1, 'caller cancellation is not an unavailable review or permission to try another provider');
});

test('cancellation at verdict restatement prevents a second SDK request', async () => {
  const parent = new AbortController();
  const reason = stopError();
  let requests = 0;
  mock.method(Runner.prototype, 'run', async () => {
    requests++;
    return { finalOutput: 'The evidence appears consistent, without a verdict line.', rawResponses: [] } as never;
  });
  await assert.rejects(runRoutedJudgeAttempt({ model: 'fixture-model', modelId: 'gpt-5.6-terra',
    judgeFamily: 'codex', brainFamily: 'claude', transport: 'test', selfJudge: false } as never,
  'State your verdict.', objective, parseCompletionVerdict, false, undefined, parent.signal, undefined, undefined,
  { restated: () => parent.abort(reason) }), error => error === reason);
  assert.equal(requests, 1);
});

test('cancellation of a parsed acceptance prevents coverage follow-up and configured fallback', async () => {
  const parent = new AbortController();
  const reason = stopError();
  let requests = 0;
  mock.method(Runner.prototype, 'run', async () => {
    requests++;
    return { get finalOutput() { parent.abort(reason); return 'DONE: nothing was omitted.\nNEEDS ALL OF: call_partial'; }, rawResponses: [] } as never;
  });
  await assert.rejects(harnessRunContextStorage.run({ callerCancelSignal: parent.signal } as never,
    () => judgeObjectiveComplete('Inspect all fixture records.', 'All records were inspected.', {
      skills: [], reviewStakes: 'write', fullSourceEvidence: true, toolCallSummary: 'fixture list returned a bounded preview',
      verifiedReadResults: [{ toolName: 'fixture_read', logicalToolCallId: 'call_partial', outcome: 'succeeded',
        status: 'verified', contentComplete: false, evidenceKind: 'source_result', rawByteCount: 4000, shownByteCount: 400,
        recordCount: 20, sourceExhausted: true }],
    })), error => error === reason);
  assert.equal(requests, 1, 'a partial-evidence acceptance cannot start another review after Stop');
});
