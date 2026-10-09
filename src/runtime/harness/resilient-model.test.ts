import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from 'openai';
import { withResilience, translateSettings, classifyModelError, type ResiliencePolicy } from './resilient-model.js';
import { withModelResilienceTelemetry, type ResilienceTelemetryEvent } from './resilient-model.js';
import * as resilient from './resilient-model.js';
import { resolveModelCapability } from './model-wire-registry.js';
import { BoundaryError } from '../boundary-error.js';

const CLAUDE_CAP = resolveModelCapability('claude-opus-4-8');
const BYO_CAP = resolveModelCapability('deepseek-reasoner');

function req(extra: Record<string, unknown> = {}): ModelRequest {
  return { input: 'hi', modelSettings: {}, tools: [], handoffs: [], ...extra } as unknown as ModelRequest;
}

function noSleep(): Promise<void> { return Promise.resolve(); }

function policy(over: Partial<ResiliencePolicy> = {}): ResiliencePolicy {
  return { label: 'test', capability: CLAUDE_CAP, sleep: noSleep, ...over };
}

test('an explicit provider refusal is not an empty-response retry (real Anthropic adapter shape)', async () => {
  const { Agent, Runner } = await import('@openai/agents');
  const { aisdk } = await import('@openai/agents-extensions/ai-sdk');
  const { createAnthropic } = await import('@ai-sdk/anthropic');
  let calls = 0;
  const provider = createAnthropic({ apiKey: 'fixture-only', fetch: async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: 'msg-refusal', type: 'message', role: 'assistant',
      model: 'claude-opus-5', content: [], stop_reason: 'refusal', stop_sequence: null,
      usage: { input_tokens: 4396, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const model = withResilience(aisdk(provider('claude-opus-5')), policy());
  await assert.rejects(new Runner().run(new Agent({ name: 'RefusalFixture', model, tools: [], modelSettings: {} }), 'Review this report.'),
    (error: unknown) => error instanceof BoundaryError && error.kind === 'model.refused' && !error.retryable);
  assert.equal(calls, 1, 'a terminal provider refusal must not consume four identical requests');
});

test('a streamed provider refusal before content does not retry or publish empty success', async () => {
  let calls = 0;
  const model = withResilience({
    async getResponse() { throw new Error('unexpected nonstream request'); },
    async *getStreamedResponse() {
      calls += 1;
      yield { type: 'response_started' } as never;
      yield { type: 'model', event: { type: 'finish', finishReason: { unified: 'content-filter', raw: 'refusal' } } } as never;
      yield { type: 'response_done', response: { output: [], usage: {} } } as never;
    },
  }, policy());
  await assert.rejects(async () => { for await (const _ of model.getStreamedResponse(req())) { /* consume */ } },
    (error: unknown) => error instanceof BoundaryError && error.kind === 'model.refused' && !error.retryable);
  assert.equal(calls, 1);
});

test('the traceless host adapter retains refusal metadata for the surrounding retry classifier', async () => {
  const { withTracelessStep } = await import('./traceless-step-model.js');
  let calls = 0;
  const model = withResilience(withTracelessStep({
    async getResponse() { throw new Error('unexpected traced request'); },
    async *getStreamedResponse() {
      calls += 1;
      yield { type: 'model', event: { type: 'finish', finishReason: { unified: 'content-filter', raw: 'refusal' } } } as never;
      yield { type: 'response_done', response: { id: 'refused', output: [], usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 } } } as never;
    },
  }), policy());
  await assert.rejects(model.getResponse(req()), (error: unknown) => {
    assert.ok(error instanceof BoundaryError);
    assert.equal(error.kind, 'model.refused');
    assert.deepEqual(pick(classifyModelError(error)), { retryable: false, kind: 'model.refused', isAuth: false });
    return true;
  });
  assert.equal(calls, 1);
});

// --- translateSettings (G1) -------------------------------------------------

test('translateSettings: anthropic effort tier -> providerOptions.anthropic.effort', () => {
  const r = translateSettings(req({ modelSettings: { reasoning: { effort: 'high' } } }), CLAUDE_CAP);
  const pd = (r.modelSettings as { providerData?: any }).providerData;
  assert.equal(pd.providerOptions.anthropic.effort, 'high');
});

test("translateSettings: tier 'none' writes the enum floor, it does not omit", () => {
  // Omitting output_config.effort does not mean "cheapest" — the wire default
  // is 'high'. Live 2026-09-11 that made the harness's most common interactive
  // tier the most expensive request it could send (3,817 output tokens / 45.6s
  // for a 200-character question). 'low' is the floor the enum actually has.
  const r = translateSettings(req({ modelSettings: { reasoning: { effort: 'none' } } }), CLAUDE_CAP);
  const pd = (r.modelSettings as { providerData?: any }).providerData ?? {};
  assert.equal(pd?.providerOptions?.anthropic?.effort, 'low');
});

test('translateSettings: a cap with no effort knob still writes no key', () => {
  // The function-level guarantee: a null mapping omits. That is correct for a
  // model that 400s on output_config.effort at every level — it is only wrong
  // when a model HAS the knob and we decline to use it.
  const haiku = resolveModelCapability('claude-haiku-4-5');
  const r = translateSettings(req({ modelSettings: { reasoning: { effort: 'none' } } }), haiku);
  const pd = (r.modelSettings as { providerData?: any }).providerData ?? {};
  assert.equal(pd?.providerOptions?.anthropic?.effort, undefined);
});

test('translateSettings: non-anthropic shape is left untouched (BYO manages its own reasoning)', () => {
  const original = req({ modelSettings: { reasoning: { effort: 'high' } } });
  const r = translateSettings(original, BYO_CAP);
  assert.equal(r, original, 'returns the same request, unmodified');
});

test('translateSettings: an explicit anthropic.effort override is not clobbered', () => {
  const r = translateSettings(
    req({ modelSettings: { reasoning: { effort: 'high' }, providerData: { providerOptions: { anthropic: { effort: 'max' } } } } }),
    CLAUDE_CAP,
  );
  assert.equal((r.modelSettings as any).providerData.providerOptions.anthropic.effort, 'max');
});

// --- classifyModelError (G2) ------------------------------------------------

test('classifyModelError: 429/529/5xx/401/transport classified; random not retryable', () => {
  assert.deepEqual(pick(classifyModelError({ statusCode: 429 })), { retryable: true, kind: 'model.rate_limited', isAuth: false });
  assert.deepEqual(pick(classifyModelError({ statusCode: 529 })), { retryable: true, kind: 'model.overloaded', isAuth: false });
  assert.deepEqual(pick(classifyModelError({ statusCode: 503 })), { retryable: true, kind: 'model.http_5xx', isAuth: false });
  assert.deepEqual(pick(classifyModelError({ statusCode: 401 })), { retryable: true, kind: 'model.auth_expired', isAuth: true });
  assert.deepEqual(pick(classifyModelError(new Error('terminated'))), { retryable: true, kind: 'model.transport_timeout', isAuth: false });
  assert.equal(classifyModelError(new Error('bad input')).retryable, false);
});

test('classifyModelError: a dropped connection is transport, however the SDK wraps it', () => {
  // An SDK connection error names itself and says only "Connection error.";
  // the socket condition sits in its cause. None of those words are a status.
  const sdkShaped = Object.assign(new Error('Connection error.'), { name: 'APIConnectionError', cause: Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }) });
  assert.deepEqual(pick(classifyModelError(sdkShaped)), { retryable: true, kind: 'model.transport_timeout', isAuth: false });
  assert.deepEqual(pick(classifyModelError(new Error('Connection error.'))), { retryable: true, kind: 'model.transport_timeout', isAuth: false });
  assert.deepEqual(pick(classifyModelError({ message: 'request failed', cause: { code: 'ETIMEDOUT' } })), { retryable: true, kind: 'model.transport_timeout', isAuth: false },
    'a transport code anywhere in the cause chain counts');
  assert.equal(classifyModelError({ message: 'bad input', cause: { message: 'schema mismatch' } }).retryable, false);
});

test('classifyModelError: a provider-internal generation crash with no HTTP status is infra', () => {
  // Live 2026-08-28: xAI native SSE finished HTTP 200 then threw this bare
  // message after plan_task; missing status used to classify as runtime.unknown
  // and persist a terminal run_failed.
  assert.deepEqual(
    pick(classifyModelError(new Error('Internal error during token generation'))),
    { retryable: true, kind: 'model.http_5xx', isAuth: false },
  );
  assert.deepEqual(
    pick(classifyModelError({ message: 'The server had an error while processing your request.' })),
    { retryable: true, kind: 'model.http_5xx', isAuth: false },
  );
  assert.equal(classifyModelError(new Error('invalid schema for field x')).retryable, false);
});

test('classifyModelError: usage/plan quota exhausted → rate_limited (fallover), NOT auth, regardless of status', () => {
  // The live failure: Codex prolite "The usage limit has been reached" arriving as 403.
  assert.deepEqual(pick(classifyModelError({ status: 403, message: 'The usage limit has been reached. Reset at 2026-07-01T10:49:18.000Z.' })),
    { retryable: true, kind: 'model.rate_limited', isAuth: false });
  // Marker only in the body (400) — still a fallover-eligible rate-limit, not auth/terminal.
  assert.deepEqual(pick(classifyModelError({ status: 400, message: 'Bad Request', bodyText: '{"error":{"type":"usage_limit_reached"}}' })),
    { retryable: true, kind: 'model.rate_limited', isAuth: false });
  // As a 429 it was already rate_limited — stays rate_limited (no regression).
  assert.deepEqual(pick(classifyModelError({ status: 429, message: 'usage_limit_reached' })),
    { retryable: true, kind: 'model.rate_limited', isAuth: false });
  // Exact Anthropic model-scoped failure observed live: overall weekly usage
  // still had headroom, but the selected Fable allowance was exhausted.
  const scoped = classifyModelError({
    status: 400,
    message: 'Bad Request',
    responseBody: { error: { message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going." } },
  });
  assert.deepEqual(pick(scoped), { retryable: true, kind: 'model.rate_limited', isAuth: false });
  assert.equal(scoped.sameProviderRetryable, false, 'a durable scoped cap must switch routes, not back off on the same model');
  // A genuine 403 auth error (no quota marker) still classifies as auth_expired.
  assert.deepEqual(pick(classifyModelError({ status: 403, message: 'invalid api key' })),
    { retryable: true, kind: 'model.auth_expired', isAuth: true });
});

test('classifyModelError: a spent prepaid balance switches routes instead of retrying the same account', () => {
  const paymentRequired = classifyModelError({ status: 402, message: '402 Credit limit exceeded' });
  assert.deepEqual(pick(paymentRequired), { retryable: true, kind: 'model.rate_limited', isAuth: false });
  assert.equal(paymentRequired.sameProviderRetryable, false, 'more attempts on an empty balance cannot help');
  const spent = classifyModelError({ status: 429, message: '429', bodyText: '{"error":{"code":"credit_balance_exhausted"}}' });
  assert.equal(spent.kind, 'model.rate_limited');
  assert.equal(spent.sameProviderRetryable, false);
  // A 403 whose words name spent credit is not an auth failure.
  assert.deepEqual(pick(classifyModelError({ status: 403, message: 'Your team has used all available credits.' })),
    { retryable: true, kind: 'model.rate_limited', isAuth: false });
  // A burst rate limit keeps its same-provider retry.
  assert.notEqual(classifyModelError({ status: 429, message: 'Too Many Requests' }).sameProviderRetryable, false);
});

test('classifyModelError: honors Retry-After header (seconds)', () => {
  const c = classifyModelError({ statusCode: 429, responseHeaders: { 'retry-after': '2' } });
  assert.equal(c.retryAfterMs, 2000);
});

function pick(c: ReturnType<typeof classifyModelError>) {
  return { retryable: c.retryable, kind: c.kind, isAuth: c.isAuth };
}

// --- getResponse resilience (G2/G5) ----------------------------------------

test('getResponse: retries a 429 then returns the eventual answer', async () => {
  let calls = 0;
  const inner = makeModel({
    getResponse: async () => {
      calls += 1;
      if (calls === 1) throw { statusCode: 429 };
      return resp([{ type: 'message' }]);
    },
  });
  const res = await withResilience(inner, policy()).getResponse(req());
  assert.equal(calls, 2);
  assert.equal(res.output.length, 1);
});

test('getResponse: model-scoped plan exhaustion is never retried on the same model', async () => {
  let calls = 0;
  const liveError = {
    status: 400,
    message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
  };
  const inner = makeModel({
    getResponse: async () => {
      calls += 1;
      throw liveError;
    },
  });
  await assert.rejects(() => withResilience(inner, policy({ maxRetries: 3 })).getResponse(req()), (err) => err === liveError);
  assert.equal(calls, 1, 'no exponential-backoff tax on an exhausted allowance');
});

test('getResponse: a persistently empty completion throws a retryable boundary error (always-an-output)', async () => {
  const inner = makeModel({ getResponse: async () => resp([]) });
  await assert.rejects(
    () => withResilience(inner, policy({ maxRetries: 2 })).getResponse(req()),
    (e: unknown) => e instanceof BoundaryError && e.kind === 'model.empty_completion' && e.retryable === true,
  );
});

test('getResponse: 401 triggers a single auth refresh then retries', async () => {
  let calls = 0;
  let refreshed = 0;
  const inner = makeModel({
    getResponse: async () => {
      calls += 1;
      if (calls === 1) throw { statusCode: 401 };
      return resp([{ type: 'message' }]);
    },
  });
  const res = await withResilience(inner, policy({ refreshAuth: async () => { refreshed += 1; } })).getResponse(req());
  assert.equal(refreshed, 1, 'refreshAuth called exactly once');
  assert.equal(calls, 2);
  assert.equal(res.output.length, 1);
});

// --- getStreamedResponse resilience (the retry-safety invariant) -----------

test('getStreamedResponse: retries a pre-content generation crash (nothing yielded) and streams the 2nd attempt', async () => {
  let calls = 0;
  const inner = makeModel({
    getStreamedResponse: async function* () {
      calls += 1;
      if (calls === 1) throw new Error('Internal error during token generation');
      yield { type: 'response_started' } as any;
      yield { type: 'output_text_delta', delta: 'hello' } as any;
      yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as any;
    },
  });
  const events = await collect(withResilience(inner, policy()).getStreamedResponse(req()));
  assert.equal(calls, 2);
  assert.ok(events.some((e: any) => e.type === 'output_text_delta' && e.delta === 'hello'));
});

test('getStreamedResponse: retries a pre-content 429 (nothing yielded) and streams the 2nd attempt', async () => {
  let calls = 0;
  const inner = makeModel({
    getStreamedResponse: async function* () {
      calls += 1;
      if (calls === 1) throw { statusCode: 429 };
      yield { type: 'response_started' } as any;
      yield { type: 'output_text_delta', delta: 'hello' } as any;
      yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as any;
    },
  });
  const events = await collect(withResilience(inner, policy()).getStreamedResponse(req()));
  assert.equal(calls, 2);
  assert.ok(events.some((e: any) => e.type === 'output_text_delta' && e.delta === 'hello'));
});

test('getStreamedResponse: does NOT retry after a user-visible text delta (would duplicate output)', async () => {
  let calls = 0;
  const inner = makeModel({
    getStreamedResponse: async function* () {
      calls += 1;
      yield { type: 'response_started' } as any;
      yield { type: 'output_text_delta', delta: 'partial' } as any;
      throw { statusCode: 529 }; // overloaded AFTER content — must NOT retry
    },
  });
  const got: any[] = [];
  await assert.rejects(async () => {
    for await (const e of withResilience(inner, policy()).getStreamedResponse(req())) got.push(e);
  });
  assert.equal(calls, 1, 'committed stream is not retried');
  assert.ok(got.some((e) => e.type === 'output_text_delta'), 'the partial text was still delivered before the throw');
});

test('getStreamedResponse: a streamed empty completion is retried (no content committed)', async () => {
  let calls = 0;
  const inner = makeModel({
    getStreamedResponse: async function* () {
      calls += 1;
      if (calls < 2) {
        yield { type: 'response_started' } as any;
        yield { type: 'response_done', response: { output: [] } } as any; // empty
        return;
      }
      yield { type: 'response_started' } as any;
      yield { type: 'output_text_delta', delta: 'ok' } as any;
      yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as any;
    },
  });
  const events = await collect(withResilience(inner, policy()).getStreamedResponse(req()));
  assert.equal(calls, 2);
  assert.ok(events.some((e: any) => e.type === 'output_text_delta'));
});

test('getStreamedResponse: reasoning + tool-call frames stream THROUGH immediately (no starvation before text)', async () => {
  // A tool-only / thinking-heavy turn produces NO text delta — these events must
  // reach the Runner as they arrive so the loop's stall watchdog sees activity.
  const inner = makeModel({
    getStreamedResponse: async function* () {
      yield { type: 'response_started' } as any;
      yield { type: 'model', event: { type: 'reasoning-delta', delta: 'thinking…' } } as any;
      yield { type: 'model', event: { type: 'tool-call', toolName: 'sf_query' } } as any;
      yield { type: 'response_done', response: { output: [{ type: 'function_call' }] } } as any;
    },
  });
  const events = await collect(withResilience(inner, policy()).getStreamedResponse(req()));
  assert.deepEqual(
    (events as any[]).map((e) => e.type),
    ['response_started', 'model', 'model', 'response_done'],
    'start frame flushed before the first real part; reasoning + tool events not withheld',
  );
});

test('getStreamedResponse: a PERSISTENT streamed empty completion throws (never yields a clean empty done)', async () => {
  let calls = 0;
  let yieldedDone = false;
  const inner = makeModel({
    getStreamedResponse: async function* () {
      calls += 1;
      yield { type: 'response_started' } as any;
      yield { type: 'response_done', response: { output: [] } } as any;
    },
  });
  await assert.rejects(
    async () => {
      for await (const e of withResilience(inner, policy({ maxRetries: 1 })).getStreamedResponse(req())) {
        if ((e as any).type === 'response_done') yieldedDone = true;
      }
    },
    (e: unknown) => e instanceof BoundaryError && e.kind === 'model.empty_completion' && e.retryable === true,
  );
  assert.equal(calls, 2, 'retried once (maxRetries=1) then threw');
  assert.equal(yieldedDone, false, 'an empty response_done is never delivered downstream');
});

test('getResponse: a 401 arriving AFTER the transient-retry budget is exhausted still refreshes auth once', async () => {
  let calls = 0;
  let refreshed = 0;
  const inner = makeModel({
    getResponse: async () => {
      calls += 1;
      if (calls <= 2) throw { statusCode: 429 }; // consume the 2-retry budget
      if (calls === 3) throw { statusCode: 401 }; // 401 on the final attempt
      return resp([{ type: 'message' }]);
    },
  });
  const res = await withResilience(inner, policy({ maxRetries: 2, refreshAuth: async () => { refreshed += 1; } })).getResponse(req());
  assert.equal(refreshed, 1, 'auth refresh is NOT gated behind the transient budget');
  assert.equal(res.output.length, 1);
});

test('getStreamedResponse: empty completion WITH the adapter stream-start/finish frames still retries (real-adapter shape, G5)', async () => {
  // Regression for the bug where committing on the stream-start metadata frame
  // made doneEmpty always false -> empty turn yielded clean instead of retried.
  let calls = 0;
  let yieldedDone = false;
  const inner = makeModel({
    getStreamedResponse: async function* () {
      calls += 1;
      yield { type: 'response_started' } as any;
      yield { type: 'model', event: { type: 'stream-start' } } as any; // metadata — must NOT commit
      yield { type: 'model', event: { type: 'finish' } } as any; // metadata
      yield { type: 'response_done', response: { output: [] } } as any; // empty
    },
  });
  await assert.rejects(
    async () => {
      for await (const e of withResilience(inner, policy({ maxRetries: 1 })).getStreamedResponse(req())) {
        if ((e as any).type === 'response_done') yieldedDone = true;
      }
    },
    (e: unknown) => e instanceof BoundaryError && e.kind === 'model.empty_completion',
  );
  assert.equal(calls, 2, 'metadata frames did not falsely commit — empty completion retried then threw');
  assert.equal(yieldedDone, false, 'never yielded a clean empty response_done');
});

test('effort: an effort-rejection 400 strips effort and retries instead of hard-failing', async () => {
  let calls = 0;
  let effortOnRetry: unknown = 'unset';
  const inner = makeModel({
    getResponse: async (r: any) => {
      calls += 1;
      const effort = r?.modelSettings?.providerData?.providerOptions?.anthropic?.effort;
      if (calls === 1) throw { statusCode: 400, message: 'This model does not support the effort parameter.' };
      effortOnRetry = effort;
      return resp([{ type: 'message' }]);
    },
  });
  const r = req({ modelSettings: { reasoning: { effort: 'high' } } }); // translateSettings adds the anthropic.effort
  const res = await withResilience(inner, policy()).getResponse(r);
  assert.equal(calls, 2);
  assert.equal(effortOnRetry, undefined, 'effort stripped on the retry');
  assert.equal(res.output.length, 1);
});

test('isEffortRejection: matches the Anthropic effort-400, not other 400s', async () => {
  const { isEffortRejection } = await import('./resilient-model.js');
  assert.equal(isEffortRejection({ statusCode: 400, message: 'This model does not support the effort parameter.' }), true);
  assert.equal(isEffortRejection({ statusCode: 400, message: 'messages.0: invalid' }), false);
  assert.equal(isEffortRejection({ statusCode: 429 }), false);
});

// --- a provider that gave no answer -----------------------------------------

test('classifyModelError: the SDK connection class is transport even when its timeout carries no cause and no transport word', () => {
  // The real SDK objects: the timeout subclass is thrown for any pre-response
  // failure whose text says "timed out", and it keeps nothing of that failure.
  const timedOut = new APIConnectionTimeoutError();
  assert.equal(timedOut.message, 'Request timed out.');
  assert.equal((timedOut as { cause?: unknown }).cause, undefined);
  assert.deepEqual(pick(classifyModelError(timedOut)), { retryable: true, kind: 'model.transport_timeout', isAuth: false });
  assert.deepEqual(pick(classifyModelError(new APIConnectionError({ message: 'Connection error.', cause: new Error('socket closed') }))),
    { retryable: true, kind: 'model.transport_timeout', isAuth: false });
  assert.deepEqual(pick(classifyModelError({ message: 'wrapped', cause: timedOut })), { retryable: true, kind: 'model.transport_timeout', isAuth: false },
    'the class counts anywhere in the cause chain');
  assert.equal(classifyModelError(new Error('Tool call timed out after 30s')).kind, 'runtime.unknown',
    'prose that says "timed out" is not a dropped connection');
});

test('getStreamedResponse: the SDK connection timeout before content is retried transparently and the answer streams', async () => {
  let calls = 0;
  const inner = makeModel({
    getStreamedResponse: async function* () {
      calls += 1;
      if (calls === 1) throw new APIConnectionTimeoutError();
      yield { type: 'output_text_delta', delta: 'answered' } as any;
      yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as any;
    },
  });
  const events = await collect(withResilience(inner, policy()).getStreamedResponse(req()));
  assert.equal(calls, 2);
  assert.ok(events.some((e: any) => e.type === 'output_text_delta' && e.delta === 'answered'));
});

for (const path of ['getResponse', 'getStreamedResponse'] as const) {
  test(`${path}: a request the caller withdrew is never retried`, async () => {
    const caller = new AbortController();
    let calls = 0;
    const sleeps: number[] = [];
    const withdraw = (): never => { calls += 1; caller.abort(); throw new APIUserAbortError(); };
    const inner = makeModel({
      getResponse: async () => withdraw(),
      // eslint-disable-next-line require-yield
      getStreamedResponse: async function* () { withdraw(); },
    });
    const model = withResilience(inner, policy({ sleep: async (ms) => { sleeps.push(ms); } }));
    const request = req({ signal: caller.signal });
    await assert.rejects(path === 'getResponse' ? model.getResponse(request) : collect(model.getStreamedResponse(request)));
    assert.equal(calls, 1, 'no second attempt after the caller stopped');
    assert.deepEqual(sleeps, [], 'no backoff after the caller stopped');
  });
}

function connectTimeoutAfter(clock: { now: number }, ms: number): never {
  clock.now += ms;
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
}

test('getStreamedResponse: a connection that takes its own timeout to fail is retried only inside the no-answer window', async () => {
  const clock = { now: 0 };
  let calls = 0;
  const inner = makeModel({
    // eslint-disable-next-line require-yield
    getStreamedResponse: async function* () { calls += 1; connectTimeoutAfter(clock, 15_000); },
  });
  const model = withResilience(inner, policy({ now: () => clock.now, sleep: async (ms) => { clock.now += ms; } }));
  const err = await collect(model.getStreamedResponse(req())).then(() => assert.fail('must throw'), (e: unknown) => e);
  // 0-15 s fails; ~0.75 s backoff starts a second attempt inside 20 s; it
  // fails at ~31 s and no third attempt starts.
  assert.equal(calls, 2);
  assert.ok(clock.now < 35_000, `bounded: ${clock.now} ms`);
  assert.equal(resilient.modelRetriesSpentBeforeContent(err), true, 'outer layers see the retries were spent');
});

const slowFailures = {
  'a reset socket': () => Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } }),
  'a gateway 5xx with no Retry-After': () => ({ statusCode: 504, message: 'Gateway Timeout' }),
};
for (const path of ['getResponse', 'getStreamedResponse'] as const) {
  for (const [shape, failure] of Object.entries(slowFailures)) {
    test(`${path}: ${shape} that arrives after the no-answer window still gets one retry, and the answer arrives`, async () => {
      const clock = { now: 0 };
      let calls = 0;
      const attempt = (): void => {
        calls += 1;
        if (calls === 1) { clock.now += 25_000; throw failure(); }
      };
      const inner = makeModel({
        getResponse: async () => { attempt(); return resp([{ type: 'message', content: 'answered' }]); },
        getStreamedResponse: async function* () {
          attempt();
          yield { type: 'output_text_delta', delta: 'answered' } as any;
          yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as any;
        },
      });
      const model = withResilience(inner, policy({ now: () => clock.now, sleep: async (ms) => { clock.now += ms; } }));
      if (path === 'getResponse') await model.getResponse(req());
      else assert.ok((await collect(model.getStreamedResponse(req()))).some((e: any) => e.delta === 'answered'));
      assert.equal(calls, 2, 'one slow failure is a single blip, not a spent budget');
    });
  }
}

test('getStreamedResponse: a slow failure that repeats is retried once, then surfaces marked as spent', async () => {
  const clock = { now: 0 };
  let calls = 0;
  const inner = makeModel({
    // eslint-disable-next-line require-yield
    getStreamedResponse: async function* () { calls += 1; connectTimeoutAfter(clock, 25_000); },
  });
  const model = withResilience(inner, policy({ now: () => clock.now, sleep: async (ms) => { clock.now += ms; } }));
  const err = await collect(model.getStreamedResponse(req())).then(() => assert.fail('must throw'), (e: unknown) => e);
  assert.equal(calls, 2, 'the first retry always runs; the window stops the second');
  assert.ok(clock.now <= 2 * 25_000 + 1_000, `bounded by about two attempts: ${clock.now} ms`);
  assert.equal(resilient.modelRetriesSpentBeforeContent(err), true);
});

// Other retries share the attempt count; they must not use up the no-answer
// retry a later slow failure is owed.
const fastFirsts = {
  'a rate-limit 429': () => { throw { statusCode: 429 }; },
  'an expired token (401) that refreshes': () => { throw { statusCode: 401 }; },
  'a rejected effort setting (400)': () => { throw { statusCode: 400, message: 'this model does not support the effort parameter' }; },
  'an empty completion': () => 'empty' as const,
};
for (const path of ['getResponse', 'getStreamedResponse'] as const) {
  for (const [shape, first] of Object.entries(fastFirsts)) {
    test(`${path}: ${shape} first, then one slow reset, still gets its no-answer retry and the answer arrives`, async () => {
      const clock = { now: 0 };
      let calls = 0;
      let refreshes = 0;
      const attempt = (): 'empty' | 'answer' => {
        calls += 1;
        if (calls === 1) return first();
        if (calls === 2) { clock.now += 25_000; throw slowFailures['a reset socket'](); }
        return 'answer';
      };
      const inner = makeModel({
        getResponse: async () => (attempt() === 'empty' ? resp([]) : resp([{ type: 'message', content: 'answered' }])),
        getStreamedResponse: async function* () {
          if (attempt() === 'empty') { yield { type: 'response_done', response: { output: [] } } as any; return; }
          yield { type: 'output_text_delta', delta: 'answered' } as any;
          yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as any;
        },
      });
      const model = withResilience(inner, policy({
        now: () => clock.now,
        sleep: async (ms) => { clock.now += ms; },
        refreshAuth: async () => { refreshes += 1; },
      }));
      if (path === 'getResponse') await model.getResponse(req());
      else assert.ok((await collect(model.getStreamedResponse(req()))).some((e: any) => e.delta === 'answered'));
      assert.equal(calls, 3, 'the fast retry and the no-answer retry both ran');
    });
  }
}

test('getStreamedResponse: after a rate-limit retry, a slow failure that repeats still stops at two no-answer attempts', async () => {
  const clock = { now: 0 };
  let calls = 0;
  const inner = makeModel({
    // eslint-disable-next-line require-yield
    getStreamedResponse: async function* () {
      calls += 1;
      if (calls === 1) throw { statusCode: 429 };
      connectTimeoutAfter(clock, 25_000);
    },
  });
  const model = withResilience(inner, policy({ now: () => clock.now, sleep: async (ms) => { clock.now += ms; } }));
  const err = await collect(model.getStreamedResponse(req())).then(() => assert.fail('must throw'), (e: unknown) => e);
  assert.equal(calls, 3, 'one rate-limit retry, then one no-answer retry, then the window stops');
  assert.equal(resilient.modelRetriesSpentBeforeContent(err), true);
});

for (const path of ['getResponse', 'getStreamedResponse'] as const) {
  test(`${path}: a no-answer failure on the last attempt after only rate-limit retries is not marked spent`, async () => {
    let calls = 0;
    const attempt = (): void => {
      calls += 1;
      if (calls <= 3) throw { statusCode: 429 };
      throw slowFailures['a reset socket']();
    };
    const inner = makeModel({
      getResponse: async () => { attempt(); return resp([]); },
      // eslint-disable-next-line require-yield
      getStreamedResponse: async function* () { attempt(); },
    });
    const model = withResilience(inner, policy());
    const run = path === 'getResponse' ? model.getResponse(req()) : collect(model.getStreamedResponse(req()));
    const err = await run.then(() => assert.fail('must throw'), (e: unknown) => e);
    assert.equal(calls, 4, 'the count budget ran out on rate limits');
    assert.equal(resilient.modelRetriesSpentBeforeContent(err), false,
      'no retry of a request that gave no answer ran, so the turn keeps its own retry');
  });
}

test('getStreamedResponse: a stream that ends silently on the last attempt after only empty completions is not marked spent', async () => {
  let calls = 0;
  const inner = makeModel({
    getStreamedResponse: async function* () {
      calls += 1;
      if (calls <= 3) yield { type: 'response_done', response: { output: [] } } as any;
    },
  });
  const err = await collect(withResilience(inner, policy()).getStreamedResponse(req())).then(() => assert.fail('must throw'), (e: unknown) => e);
  assert.equal(calls, 4);
  assert.equal(resilient.modelRetriesSpentBeforeContent(err), false);
});

test('getResponse: a connection that fails fast keeps the full retry count, and the spent failure is marked', async () => {
  const clock = { now: 0 };
  let calls = 0;
  const inner = makeModel({ getResponse: async () => { calls += 1; return connectTimeoutAfter(clock, 50); } });
  const model = withResilience(inner, policy({ now: () => clock.now, sleep: async (ms) => { clock.now += ms; } }));
  const err = await model.getResponse(req()).then(() => assert.fail('must throw'), (e: unknown) => e);
  assert.equal(calls, 4, 'one attempt plus three retries');
  assert.equal(resilient.modelRetriesSpentBeforeContent(err), true);
});

test('getStreamedResponse: a failure after content is not marked as spent before content', async () => {
  const inner = makeModel({
    getStreamedResponse: async function* () {
      yield { type: 'output_text_delta', delta: 'partial' } as any;
      throw new TypeError('terminated');
    },
  });
  const err = await collect(withResilience(inner, policy()).getStreamedResponse(req())).then(() => assert.fail('must throw'), (e: unknown) => e);
  assert.equal(resilient.modelRetriesSpentBeforeContent(err), false, 'an outer layer still owns recovery of a partial frame');
});

test('getResponse: a provider-directed rate-limit wait is not cut short by the no-answer window', async () => {
  const clock = { now: 0 };
  let calls = 0;
  const inner = makeModel({
    getResponse: async () => {
      calls += 1;
      if (calls === 1) throw { statusCode: 429, responseHeaders: { 'retry-after': '25' } };
      return resp([{ type: 'message' }]);
    },
  });
  const model = withResilience(inner, policy({ now: () => clock.now, sleep: async (ms) => { clock.now += ms; } }));
  await model.getResponse(req());
  assert.equal(calls, 2);
});

// --- per-call timing observation -------------------------------------------

for (const path of ['getResponse', 'getStreamedResponse'] as const) {
  test(`${path}: timing includes the failed physical attempt and actual retry wait without inventing usage`, async () => {
    const clock = { now: 100 };
    const events: ResilienceTelemetryEvent[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    const attempt = (): void => {
      calls += 1;
      clock.now += calls === 1 ? 28_000 : 2_474;
      if (calls === 1) throw new APIConnectionTimeoutError();
    };
    const answer = resp([{ type: 'message', content: 'exact answer' }]);
    const model = withResilience(makeModel({
      getResponse: async () => { attempt(); return answer; },
      getStreamedResponse: async function* () { attempt(); yield { type: 'response_done', response: answer } as never; },
    }), policy({ now: () => clock.now, sleep: async (ms) => { sleeps.push(ms); clock.now += ms + 5; } }));
    const request = req({ input: 'private fixture bytes never enter telemetry' });
    const output = await withModelResilienceTelemetry(event => events.push(event), () => (
      path === 'getResponse' ? model.getResponse(request) : collect(model.getStreamedResponse(request))
    ));
    assert.ok(output);
    assert.equal(calls, 2);
    assert.deepEqual(events.map(event => event.type), [
      'call_started', 'attempt_started', 'attempt_finished', 'retry_scheduled',
      'retry_wait_finished', 'attempt_started', 'attempt_finished', 'call_finished',
    ]);
    const attempts = events.filter(event => event.type === 'attempt_finished');
    assert.deepEqual(attempts.map(event => [event.attempt, event.durationMs, event.outcome]), [[1, 28_000, 'failed'], [2, 2_474, 'returned']]);
    assert.equal(attempts[0].failureKind, 'model.transport_timeout');
    assert.equal(attempts[0].contentCommitted, false);
    const retry = events.find(event => event.type === 'retry_scheduled');
    assert.ok(retry && retry.type === 'retry_scheduled');
    assert.equal(retry.reason, 'transient_failure');
    assert.equal(retry.plannedBackoffMs, sleeps[0]);
    assert.equal(retry.maxRetries, 3);
    const finished = events.at(-1);
    assert.ok(finished && finished.type === 'call_finished');
    assert.equal(finished.durationMs, 28_000 + 2_474 + sleeps[0] + 5);
    assert.equal(finished.failedAttemptMs, 28_000);
    assert.equal(finished.attemptMs, 30_474);
    assert.equal(finished.retryWaitMs, sleeps[0] + 5);
    assert.equal(finished.failedAttemptCount, 1);
    assert.equal(finished.attemptCount, 2);
    assert.equal(finished.completionObserved, true);
    assert.equal(new Set(events.map(event => event.callId)).size, 1);
    const encoded = JSON.stringify(events);
    for (const absent of ['private fixture', 'inputTokens', 'outputTokens', 'requestModel', 'providerReportedModel', 'backendId', 'exact answer']) {
      assert.equal(encoded.includes(absent), false, `observation must not invent or expose ${absent}`);
    }
  });
}

test('timing: concurrent calls on the same cached wrapper retain separate observers and call identities', async () => {
  const eventsA: ResilienceTelemetryEvent[] = [];
  const eventsB: ResilienceTelemetryEvent[] = [];
  const releases = new Map<string, () => void>();
  const model = withResilience(makeModel({ getResponse: async request => {
    await new Promise<void>(resolve => releases.set(String(request.input), resolve));
    return resp([{ type: 'message', content: request.input }]);
  } }), policy());
  const a = withModelResilienceTelemetry(event => eventsA.push(event), () => model.getResponse(req({ input: 'A' })));
  const b = withModelResilienceTelemetry(event => eventsB.push(event), () => model.getResponse(req({ input: 'B' })));
  assert.deepEqual([...releases.keys()], ['A', 'B'], 'both requests cross the deterministic barrier');
  releases.get('B')!();
  await b;
  assert.equal(eventsA.some(event => event.type === 'call_finished'), false);
  releases.get('A')!();
  await a;
  assert.equal(new Set(eventsA.map(event => event.callId)).size, 1);
  assert.equal(new Set(eventsB.map(event => event.callId)).size, 1);
  assert.notEqual(eventsA[0].callId, eventsB[0].callId);
  const before = eventsA.length + eventsB.length;
  const unobserved = model.getResponse(req({ input: 'C' }));
  releases.get('C')!();
  await unobserved;
  assert.equal(eventsA.length + eventsB.length, before, 'no observer escapes its async scope');
});

for (const observer of [() => { throw new Error('journal unavailable'); }, async () => { throw new Error('async journal unavailable'); }]) {
  test(`timing: ${observer.constructor.name} observer failure cannot alter provider retry or output`, async () => {
    let calls = 0;
    const expected = resp([{ type: 'message', content: 'preserved' }]);
    const model = withResilience(makeModel({ getResponse: async () => {
      if (++calls === 1) throw { statusCode: 429, message: 'sensitive provider body' };
      return expected;
    } }), policy());
    assert.equal(await withModelResilienceTelemetry(observer, () => model.getResponse(req())), expected);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
  });
}

test('timing: caller cancellation before content emits one cancelled attempt and never schedules a retry', async () => {
  const events: ResilienceTelemetryEvent[] = [];
  const caller = new AbortController();
  let calls = 0;
  const model = withResilience(makeModel({ getStreamedResponse: async function* () {
    calls += 1;
    caller.abort();
    throw new APIUserAbortError();
  } }), policy());
  await assert.rejects(withModelResilienceTelemetry(event => events.push(event), () => collect(model.getStreamedResponse(req({ signal: caller.signal })))), APIUserAbortError);
  assert.equal(calls, 1);
  assert.equal(events.some(event => event.type === 'retry_scheduled'), false);
  assert.equal(events.filter(event => event.type === 'attempt_finished').length, 1);
  assert.equal(events.at(-1)?.type, 'call_finished');
  const finished = events.at(-1);
  assert.ok(finished && finished.type === 'call_finished');
  assert.equal(finished.outcome, 'cancelled');
  assert.equal(finished.completionObserved, false);
});

test('timing: a failure after content remains a single failed attempt, and consumer close is interrupted rather than returned', async () => {
  for (const close of [false, true]) {
    const events: ResilienceTelemetryEvent[] = [];
    let calls = 0;
    const model = withResilience(makeModel({ getStreamedResponse: async function* () {
      calls += 1;
      yield { type: 'output_text_delta', delta: 'partial' } as never;
      throw new TypeError('terminated');
    } }), policy());
    const work = () => close ? (async () => { for await (const _ of model.getStreamedResponse(req())) break; })()
      : collect(model.getStreamedResponse(req()));
    if (close) await withModelResilienceTelemetry(event => events.push(event), work);
    else await assert.rejects(withModelResilienceTelemetry(event => events.push(event), work), /terminated/);
    assert.equal(calls, 1);
    const attempt = events.find(event => event.type === 'attempt_finished');
    assert.ok(attempt && attempt.type === 'attempt_finished');
    assert.equal(attempt.contentCommitted, true);
    assert.equal(attempt.completionObserved, false);
    assert.equal(attempt.outcome, close ? 'interrupted' : 'failed');
    assert.equal(events.some(event => event.type === 'retry_scheduled'), false);
    const finished = events.at(-1);
    assert.ok(finished && finished.type === 'call_finished');
    assert.equal(finished.outcome, close ? 'interrupted' : 'failed');
  }
});

test('timing: auth refresh and effort stripping keep their independent allowance and record distinct reasons', async () => {
  for (const reason of ['auth_refresh', 'effort_rejected'] as const) {
    const clock = { now: 0 };
    const events: ResilienceTelemetryEvent[] = [];
    let calls = 0;
    let refreshes = 0;
    const request = req({ modelSettings: { reasoning: { effort: 'high' } } });
    const model = withResilience(makeModel({ getResponse: async current => {
      calls += 1;
      clock.now += 10;
      assert.equal(current.input, request.input);
      assert.equal(current.tools, request.tools);
      if (calls === 1) throw reason === 'auth_refresh' ? { statusCode: 401 }
        : { statusCode: 400, message: 'This model does not support the effort parameter.' };
      if (reason === 'effort_rejected') assert.equal(current.modelSettings.providerData?.providerOptions?.anthropic?.effort, undefined);
      return resp([{ type: 'message' }]);
    } }), policy({ maxRetries: 0, now: () => clock.now,
      refreshAuth: async () => { refreshes += 1; clock.now += 25; } }));
    await withModelResilienceTelemetry(event => events.push(event), () => model.getResponse(request));
    assert.equal(calls, 2, 'these existing one-shot repairs are independent of transient count allowance');
    assert.equal(refreshes, reason === 'auth_refresh' ? 1 : 0);
    const retries = events.filter(event => event.type === 'retry_scheduled');
    assert.equal(retries.length, 1);
    assert.equal(retries[0].reason, reason);
    assert.equal(retries[0].plannedBackoffMs, 0);
    const finished = events.at(-1);
    assert.ok(finished && finished.type === 'call_finished');
    assert.equal(finished.durationMs, reason === 'auth_refresh' ? 45 : 20);
    assert.equal(finished.retryWaitMs, reason === 'auth_refresh' ? 25 : 0);
  }
});

test('timing: inaccessible error metadata after content cannot replace the original failure', async () => {
  const events: ResilienceTelemetryEvent[] = [];
  const original = new Error('the original partial stream failure');
  Object.defineProperty(original, 'statusCode', { get() { throw new Error('metadata unavailable'); } });
  const model = withResilience(makeModel({ getStreamedResponse: async function* () {
    yield { type: 'output_text_delta', delta: 'partial' } as never;
    throw original;
  } }), policy());
  await assert.rejects(withModelResilienceTelemetry(event => events.push(event), () => collect(model.getStreamedResponse(req()))),
    err => { assert.equal(err, original); return true; });
  assert.equal(events.some(event => event.type === 'retry_scheduled'), false);
  const finished = events.at(-1);
  assert.ok(finished && finished.type === 'call_finished');
  assert.equal(finished.outcome, 'failed');
  assert.equal(finished.failureKind, 'runtime.unknown');
});

test('timing: slow repeated failures retain the no-answer bound and never emit returned success', async () => {
  const clock = { now: 0 };
  const events: ResilienceTelemetryEvent[] = [];
  let calls = 0;
  const model = withResilience(makeModel({ getResponse: async () => { calls += 1; return connectTimeoutAfter(clock, 25_000); } }),
    policy({ now: () => clock.now, sleep: async ms => { clock.now += ms; } }));
  const error = await withModelResilienceTelemetry(event => events.push(event), () => model.getResponse(req())).then(
    () => assert.fail('a failed provider cannot return success'), (err: unknown) => err);
  assert.equal(calls, 2);
  assert.equal(resilient.modelRetriesSpentBeforeContent(error), true);
  assert.equal(events.filter(event => event.type === 'retry_scheduled').length, 1);
  const finished = events.at(-1);
  assert.ok(finished && finished.type === 'call_finished');
  assert.equal(finished.outcome, 'failed');
  assert.equal(finished.failedAttemptCount, 2);
  assert.equal(finished.failedAttemptMs, 50_000);
});

test('timing: an earlier empty done cannot certify a later partial stream as complete', async () => {
  const events: ResilienceTelemetryEvent[] = [];
  let calls = 0;
  const model = withResilience(makeModel({ getStreamedResponse: async function* () {
    if (++calls === 1) yield { type: 'response_done', response: { output: [] } } as never;
    else yield { type: 'output_text_delta', delta: 'partial without done' } as never;
  } }), policy());
  await withModelResilienceTelemetry(event => events.push(event), () => collect(model.getStreamedResponse(req())));
  assert.equal(calls, 2);
  assert.equal(events.find(event => event.type === 'retry_scheduled')?.reason, 'empty_completion');
  const finished = events.at(-1);
  assert.ok(finished && finished.type === 'call_finished');
  assert.equal(finished.completionObserved, false, 'the wrapper retains its existing return behavior, not a completion proof');
});

test('timing: a retired child late-empty cancellation is distinguishable from the same logical step successful rescue', async () => {
  const { withModelFallback } = await import('./fallback-model.js');
  const events: ResilienceTelemetryEvent[] = [];
  const caller = new AbortController();
  let childCalls = 0;
  let rescueCalls = 0;
  const child = withResilience(makeModel({ getStreamedResponse: async function* (request) {
    childCalls += 1;
    if (childCalls === 1) {
      assert.ok(request.signal);
      // Only FallbackModel's physical retirement opens this barrier. The
      // owner signal stays live throughout the successful rescue.
      await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => resolve(), { once: true }));
      yield { type: 'response_done', response: { output: [] } } as never;
    } else yield { type: 'response_done', response: resp([{ type: 'message', content: 'ignored old result' }]) } as never;
  } }), policy({ label: 'retired-child' }));
  const rescue = withResilience(makeModel({ getStreamedResponse: async function* (request) {
    rescueCalls += 1;
    assert.equal(request.signal?.aborted, false);
    yield { type: 'response_done', response: resp([{ type: 'message', content: 'rescue result' }]) } as never;
  } }), policy({ label: 'successful-rescue' }));
  const model = withModelFallback([
    { label: 'telemetry-fixture-retired-child', getModel: () => child },
    { label: 'telemetry-fixture-successful-rescue', getModel: () => rescue },
  ], { firstByteTimeoutMs: 10, responseWallMs: 0 });
  const output = await withModelResilienceTelemetry(event => events.push(event), () => collect(model.getStreamedResponse(req({ signal: caller.signal }))));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(caller.signal.aborted, false);
  assert.equal(childCalls, 1, 'a retired physical request must not start its empty-completion retry');
  assert.equal(rescueCalls, 1);
  assert.match(JSON.stringify(output), /rescue result/);
  assert.doesNotMatch(JSON.stringify(output), /ignored old result/);
  const oldRetry = events.find(event => event.type === 'retry_scheduled' && event.label === 'retired-child');
  assert.equal(oldRetry, undefined);
  const retired = events.find(event => event.type === 'attempt_finished' && event.label === 'retired-child');
  assert.ok(retired && retired.type === 'attempt_finished');
  assert.equal(retired.outcome, 'cancelled');
  assert.equal(retired.failureKind, 'model.empty_completion');
  assert.equal(retired.completionObserved, true, 'retain the actual late empty completion observation');
  assert.equal(retired.requestAborted, true, 'host can retire only the obsolete physical-call progress');
  const retiredCall = events.find(event => event.type === 'call_finished' && event.label === 'retired-child');
  assert.ok(retiredCall && retiredCall.type === 'call_finished');
  assert.equal(retiredCall.outcome, 'cancelled');
  assert.equal(retiredCall.attemptCount, 1);
  const rescued = events.find(event => event.type === 'call_finished' && event.label === 'successful-rescue');
  assert.ok(rescued && rescued.type === 'call_finished');
  assert.equal(rescued.outcome, 'returned');
  assert.equal(rescued.requestAborted, false);
  assert.equal(rescued.completionObserved, true);
});

// --- helpers ---------------------------------------------------------------

function resp(output: unknown[]): ModelResponse {
  return { output, usage: {}, providerData: {} } as unknown as ModelResponse;
}

function makeModel(impl: Partial<Model>): Model {
  return {
    getResponse: impl.getResponse ?? (async () => resp([{ type: 'message' }])),
    getStreamedResponse: impl.getStreamedResponse ?? (async function* () { yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as any; }),
  } as Model;
}

async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of it) out.push(e);
  return out;
}
