import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import { withResilience, translateSettings, classifyModelError, type ResiliencePolicy } from './resilient-model.js';
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

// --- translateSettings (G1) -------------------------------------------------

test('translateSettings: anthropic effort tier -> providerOptions.anthropic.effort', () => {
  const r = translateSettings(req({ modelSettings: { reasoning: { effort: 'high' } } }), CLAUDE_CAP);
  const pd = (r.modelSettings as { providerData?: any }).providerData;
  assert.equal(pd.providerOptions.anthropic.effort, 'high');
});

test("translateSettings: tier 'none' omits effort (no key written)", () => {
  const r = translateSettings(req({ modelSettings: { reasoning: { effort: 'none' } } }), CLAUDE_CAP);
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
