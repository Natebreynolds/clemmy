import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers';
import { after, afterEach, test, type TestContext } from 'node:test';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-read-first-review-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const {
  judgeObjectiveComplete, _setCompletionJudgeForTests,
  JEV_HEDGE_DELAY_MS, JEV_READ_HEDGE_DELAY_MS,
} = await import('./objective-judge.js');
const { _setSystemOneFetchForTests, _setTypesafeKeyForTests } = await import('../jev/client.js');
const { _resetCompletionSizeGateForTests } = await import('../jev/control-plane.js');
const { closeEventLog } = await import('./eventlog.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('./brackets.js');
await import('../../memory/judge-memory.js');

type Context = NonNullable<Parameters<typeof judgeObjectiveComplete>[2]>;
type Judge = NonNullable<Parameters<typeof _setCompletionJudgeForTests>[0]>;
const read: Context = {
  sessionId: 'read-first-fixture', skills: [], reviewStakes: 'read',
  toolCallSummary: 'read_file succeeded once; no writes.',
  verifiedReads: 'The complete source says status=ready.',
  verifiedReadResults: [{
    toolName: 'read_file', logicalToolCallId: 'read-status', outcome: 'succeeded',
    status: 'verified', contentComplete: true, evidenceKind: 'source_result',
  }],
};
const objective = 'Read the local status and report it.';
const reply = 'The source says status=ready.';
const judged = { verdict: { done: true, reason: 'The configured reviewer verified the exact result.' }, failure: null };
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
};

function jevResponse(kind: 'done' | 'incomplete' | 'awaiting' = 'done') {
  const values = { delivered: 0.95, unaddressed: 0.03, unsupported: 0.03,
    computed: 0.03, asksUser: 0.03, cannotFinish: 0.03,
    ...(kind === 'incomplete' ? { delivered: 0.1, unaddressed: 0.95 } : {}),
    ...(kind === 'awaiting' ? { delivered: 0.2, asksUser: 0.95 } : {}),
  };
  return { status: 200, ok: true, text: async () => JSON.stringify({
    model: 'jev-1.13.0',
    answers: Object.fromEntries(Object.entries(values).map(([id, noul]) => [id, { type: 'noul', noul }])),
    usage: { input_tokens: 36, output_tokens: 5 },
  }) };
}

function setup(t: TestContext, judge: Judge = async () => judged) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-10-09T00:00:00Z') });
  _setTypesafeKeyForTests('ts_read_first_fixture');
  _resetCompletionSizeGateForTests();
  let calls = 0;
  _setCompletionJudgeForTests(async (...args) => { calls++; return judge(...args); });
  return { reviewerCalls: () => calls };
}

function pendingJev() {
  let answer!: (value: ReturnType<typeof jevResponse>) => void;
  let started!: () => void;
  const whenStarted = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  _setSystemOneFetchForTests(async () => {
    calls++;
    return new Promise<ReturnType<typeof jevResponse>>(resolve => { answer = resolve; started(); });
  });
  return { whenStarted, calls: () => calls, answer: (kind: Parameters<typeof jevResponse>[0] = 'done') => answer(jevResponse(kind)) };
}

afterEach(() => {
  _setTypesafeKeyForTests(null); // No provider call may escape a fixture.
  _setSystemOneFetchForTests(undefined);
  _setCompletionJudgeForTests(null);
  _resetCompletionSizeGateForTests();
});
after(() => { closeEventLog(); rmSync(testHome, { recursive: true, force: true }); });

test('a complete ordinary read lets a 1.9 s affirmative Jev check settle without speculative review', async t => {
  const state = setup(t), jev = pendingJev();
  const pending = judgeObjectiveComplete(objective, reply, read);
  await jev.whenStarted;
  assert.equal(jev.calls(), 1);
  t.mock.timers.tick(JEV_HEDGE_DELAY_MS + 1); await flush();
  assert.equal(state.reviewerCalls(), 0, 'the former 1 s timer must not start a complete-read reviewer');
  t.mock.timers.tick(899); jev.answer();
  const verdict = await pending;
  assert.equal(verdict.done, true);
  assert.equal(verdict.fast, true);
  assert.equal(verdict.jevAttempt?.accepted, true);
  assert.equal(verdict.jevAttempt?.reviewerStarted, false);
  assert.equal(verdict.judgeModelId, 'jev-1.13.0');
  t.mock.timers.tick(JEV_READ_HEDGE_DELAY_MS + 1); await flush();
  assert.equal(state.reviewerCalls(), 0, 'the settled hedge must be cleared');
});

test('an incomplete Jev finding starts the configured reviewer immediately, with no extra delay', async t => {
  const state = setup(t, async () => ({ verdict: { done: false, reason: 'The requested part remains absent.' }, failure: null }));
  _setSystemOneFetchForTests(async () => jevResponse('incomplete'));
  const verdict = await judgeObjectiveComplete(objective, 'I will read the missing status.', read);
  assert.equal(state.reviewerCalls(), 1);
  assert.equal(verdict.done, false);
  assert.equal(verdict.jevAttempt?.accepted, false);
  assert.notEqual(verdict.fast, true);
});

for (const kind of ['missing_key', 'malformed_response', 'http_error'] as const) {
  test(`a ${kind} screen falls through without waiting for the complete-read window`, async t => {
    const state = setup(t);
    if (kind === 'missing_key') _setTypesafeKeyForTests(null);
    _setSystemOneFetchForTests(async () => kind === 'http_error'
      ? { status: 503, ok: false, text: async () => 'synthetic unavailable' }
      : { status: 200, ok: true, text: async () => 'unparseable synthetic response' });
    const verdict = await judgeObjectiveComplete(objective, reply, read);
    assert.equal(state.reviewerCalls(), 1);
    assert.equal(verdict.done, true);
    assert.notEqual(verdict.judgeModelId, 'jev-1.13.0');
  });
}

test('the existing 2.5 s Jev timeout starts only one configured reviewer and cannot certify Jev', async t => {
  const state = setup(t);
  let aborted = 0;
  let started!: () => void;
  const whenStarted = new Promise<void>(resolve => { started = resolve; });
  _setSystemOneFetchForTests((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted++; reject(new DOMException('synthetic bounded timeout', 'AbortError'));
    }, { once: true });
    started();
  }));
  const pending = judgeObjectiveComplete(objective, reply, read);
  await whenStarted;
  t.mock.timers.tick(JEV_READ_HEDGE_DELAY_MS - 1); await flush();
  assert.equal(state.reviewerCalls(), 0);
  assert.equal(aborted, 0);
  t.mock.timers.tick(1); await flush();
  const verdict = await pending;
  assert.equal(aborted, 1, 'read hedge stays aligned with the actual completion transport deadline');
  assert.equal(state.reviewerCalls(), 1);
  assert.equal(verdict.done, true);
  assert.notEqual(verdict.fast, true);
  assert.notEqual(verdict.judgeModelId, 'jev-1.13.0');
});

for (const kind of ['unknown_stakes', 'direction_question'] as const) {
  test(`${kind} preserves the existing 1 s hedge and cancels its losing reviewer`, async t => {
    let reviewerSignal: AbortSignal | undefined;
    const state = setup(t, async (_objective, _reply, _context, judge) => {
      reviewerSignal = judge?.signal; return judged;
    });
    const jev = pendingJev();
    const pending = judgeObjectiveComplete(objective,
      kind === 'direction_question' ? 'Should I use the work file or the personal file?' : reply,
      kind === 'unknown_stakes' ? { ...read, reviewStakes: undefined } : read);
    await jev.whenStarted;
    t.mock.timers.tick(JEV_HEDGE_DELAY_MS); await flush();
    assert.equal(state.reviewerCalls(), 1);
    jev.answer(kind === 'direction_question' ? 'awaiting' : 'done');
    const verdict = await pending;
    assert.equal(verdict.jevAttempt?.accepted, true);
    assert.equal(verdict.jevAttempt?.reviewerStarted, true);
    assert.equal(reviewerSignal?.aborted, true);
    assert.equal(Boolean(verdict.awaitingUser), kind === 'direction_question');
  });
}

for (const [name, context] of [
  ['prepared_plan', { ...read, reviewsPlan: true, reviewStakes: 'plan' }],
  ['effectful_write', { ...read, reviewStakes: 'write' }],
  ['required_memory', { ...read, memoryRequirementContext: 'The owner explicitly required this fact to be retained.' }],
  ['partial_read', { ...read, verifiedReadResults: [{ ...read.verifiedReadResults![0]!, contentComplete: false }] }],
  ['failed_read', { ...read, verifiedReadResults: [{ ...read.verifiedReadResults![0]!, outcome: 'failed', status: 'not_succeeded' }] }],
] satisfies Array<[string, Context]>) {
  test(`${name} still starts the configured reviewer directly`, async t => {
    const state = setup(t);
    let jevCalls = 0;
    _setSystemOneFetchForTests(async () => { jevCalls++; return jevResponse(); });
    const verdict = await judgeObjectiveComplete(objective, reply, context);
    assert.equal(state.reviewerCalls(), 1);
    assert.equal(jevCalls, 0, 'ineligible evidence/stakes cannot wait for or settle through Jev');
    assert.equal(verdict.done, true);
    assert.equal(verdict.jevAttempt, undefined);
  });
}

test('Stop during the read window clears the hedge and a later Jev DONE cannot deliver a verdict', async t => {
  const state = setup(t), jev = pendingJev(), stop = new AbortController();
  const pending = Promise.resolve(withHarnessRunContext({ sessionId: read.sessionId!, turn: 1,
    counter: new ToolCallsCounter(4), callerCancelSignal: stop.signal },
  () => judgeObjectiveComplete(objective, reply, read)));
  const stopped = assert.rejects(pending, { name: 'AbortError' });
  await jev.whenStarted;
  t.mock.timers.tick(1_200); stop.abort();
  t.mock.timers.tick(JEV_READ_HEDGE_DELAY_MS + 1); await flush();
  assert.equal(state.reviewerCalls(), 0, 'Stop must prevent a delayed configured reviewer');
  jev.answer(); await stopped;
  assert.equal(state.reviewerCalls(), 0);
});
