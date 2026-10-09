import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { resolveModelCapability } from './model-wire-registry.js';
import { withResilience, withModelResilienceTelemetry, type ResiliencePolicy,
  type ResilienceTelemetryEvent } from './resilient-model.js';

const capability = resolveModelCapability('claude-opus-4-8');
const paths = ['getResponse', 'getStreamedResponse'] as const;
type Path = typeof paths[number];
const abortReason = () => new DOMException('fixture request retired', 'AbortError');
const request = (signal: AbortSignal) => ({ input: 'fixture', tools: [], handoffs: [],
  modelSettings: { reasoning: { effort: 'high' } }, signal }) as unknown as ModelRequest;
const response = (empty = false) => ({ id: 'fixture-response',
  output: empty ? [] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture result' }] }],
  usage: { inputTokens: 42, outputTokens: empty ? 0 : 7, totalTokens: empty ? 42 : 49 },
}) as unknown as ModelResponse;
const policy = (over: Partial<ResiliencePolicy> = {}): ResiliencePolicy => ({ label: 'cancellation-fixture',
  capability, sleep: async () => {}, ...over });

function modelFor(work: (request: ModelRequest) => Promise<ModelResponse | undefined>): Model {
  return {
    async getResponse(req) {
      const result = await work(req);
      assert.ok(result, 'nonstream fixture must return a response');
      return result;
    },
    async *getStreamedResponse(req) {
      const result = await work(req);
      if (result) yield { type: 'response_done', response: result } as StreamEvent;
    },
  };
}

async function run(model: Model, path: Path, signal: AbortSignal): Promise<unknown> {
  if (path === 'getResponse') return model.getResponse(request(signal));
  const output: StreamEvent[] = [];
  for await (const event of model.getStreamedResponse(request(signal))) output.push(event);
  return output;
}

async function promptly<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('cancelled retry remained pending')), 300);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

for (const path of paths) {
  test(`${path}: a pre-aborted request starts no physical attempt`, async () => {
    const controller = new AbortController();
    const reason = abortReason();
    controller.abort(reason);
    let calls = 0;
    const events: ResilienceTelemetryEvent[] = [];
    const model = withResilience(modelFor(async () => { calls++; return response(); }), policy());
    await assert.rejects(withModelResilienceTelemetry(event => events.push(event),
      () => run(model, path, controller.signal)), error => error === reason);
    assert.equal(calls, 0);
    const finished = events.find(event => event.type === 'call_finished');
    assert.ok(finished?.type === 'call_finished');
    assert.equal(finished.outcome, 'cancelled');
    assert.equal(finished.attemptCount, 0);
  });

  test(`${path}: cancellation at attempt admission is checked before invoking the transport`, async () => {
    const controller = new AbortController();
    const reason = abortReason();
    let calls = 0;
    const model = withResilience(modelFor(async () => { calls++; return response(); }), policy());
    await assert.rejects(withModelResilienceTelemetry(event => {
      if (event.type === 'attempt_started') controller.abort(reason);
    }, () => run(model, path, controller.signal)), error => error === reason);
    assert.equal(calls, 0);
  });

  test(`${path}: a late empty completion retains cancellation history and starts no retry`, async () => {
    const controller = new AbortController();
    const reason = abortReason();
    let calls = 0;
    let waits = 0;
    const events: ResilienceTelemetryEvent[] = [];
    const model = withResilience(modelFor(async () => {
      calls++; controller.abort(reason); return response(true);
    }), policy({ sleep: async () => { waits++; } }));
    await assert.rejects(withModelResilienceTelemetry(event => events.push(event),
      () => run(model, path, controller.signal)), error => error === reason);
    assert.equal(calls, 1);
    assert.equal(waits, 0);
    assert.equal(events.some(event => event.type === 'retry_scheduled'), false);
    const attempt = events.find(event => event.type === 'attempt_finished');
    assert.ok(attempt?.type === 'attempt_finished');
    assert.equal(attempt.outcome, 'cancelled');
    assert.equal(attempt.failureKind, 'model.empty_completion');
    assert.equal(attempt.completionObserved, true);
    const finished = events.find(event => event.type === 'call_finished');
    assert.ok(finished?.type === 'call_finished');
    assert.equal(finished.outcome, 'cancelled');
    assert.equal(finished.failedAttemptCount, 1);
    assert.equal(finished.completionObserved, true);
  });

  test(`${path}: cancellation prevents late effort rejection from stripping and retrying`, async () => {
    const controller = new AbortController();
    const error = Object.assign(new Error('model does not support the effort parameter'), { status: 400 });
    let calls = 0;
    const events: ResilienceTelemetryEvent[] = [];
    const model = withResilience(modelFor(async () => {
      calls++; controller.abort(abortReason()); throw error;
    }), policy());
    await assert.rejects(withModelResilienceTelemetry(event => events.push(event),
      () => run(model, path, controller.signal)), actual => actual === error);
    assert.equal(calls, 1);
    assert.equal(events.some(event => event.type === 'retry_scheduled'), false);
  });

  test(`${path}: cancellation during auth refresh prevents the refreshed retry`, async () => {
    const controller = new AbortController();
    const error = Object.assign(new Error('expired token'), { status: 401 });
    let calls = 0;
    let refreshes = 0;
    const events: ResilienceTelemetryEvent[] = [];
    const model = withResilience(modelFor(async () => { calls++; throw error; }), policy({
      refreshAuth: async () => { refreshes++; await Promise.resolve(); controller.abort(abortReason()); },
    }));
    await assert.rejects(withModelResilienceTelemetry(event => events.push(event),
      () => run(model, path, controller.signal)), actual => actual === error);
    assert.equal(calls, 1);
    assert.equal(refreshes, 1);
    const finished = events.find(event => event.type === 'call_finished');
    assert.ok(finished?.type === 'call_finished');
    assert.equal(finished.outcome, 'cancelled');
  });

  test(`${path}: cancellation at auth admission starts neither refresh nor another request`, async () => {
    const controller = new AbortController();
    const error = Object.assign(new Error('expired token'), { status: 401 });
    let calls = 0;
    let refreshes = 0;
    const model = withResilience(modelFor(async () => { calls++; throw error; }), policy({
      refreshAuth: async () => { refreshes++; },
    }));
    await assert.rejects(withModelResilienceTelemetry(event => {
      if (event.type === 'retry_scheduled' && event.reason === 'auth_refresh') controller.abort(abortReason());
    }, () => run(model, path, controller.signal)), actual => actual === error);
    assert.equal(calls, 1);
    assert.equal(refreshes, 0);
  });

  for (const failure of ['empty', 'transient'] as const) {
    test(`${path}: cancellation interrupts injected ${failure} backoff and observes late rejection`, async () => {
      const controller = new AbortController();
      const reason = abortReason();
      let calls = 0;
      let started!: () => void;
      const sleeping = new Promise<void>(resolve => { started = resolve; });
      let rejectSleep!: (error: Error) => void;
      const events: ResilienceTelemetryEvent[] = [];
      const model = withResilience(modelFor(async () => {
        calls++;
        if (failure === 'transient') throw Object.assign(new Error('overloaded'), { status: 529 });
        return response(true);
      }), policy({ sleep: () => new Promise<void>((_, reject) => { rejectSleep = reject; started(); }) }));
      const pending = withModelResilienceTelemetry(event => events.push(event), () => run(model, path, controller.signal));
      const rejected = assert.rejects(pending, error => error === reason);
      await sleeping;
      controller.abort(reason);
      await promptly(rejected);
      assert.equal(calls, 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      const wait = events.find(event => event.type === 'retry_wait_finished');
      assert.ok(wait?.type === 'retry_wait_finished');
      assert.equal(wait.outcome, 'failed');
      rejectSleep(new Error('late injected sleep failure'));
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(calls, 1);
    });
  }

  test(`${path}: cancellation clears the actual backoff timer`, async t => {
    const controller = new AbortController();
    const reason = abortReason();
    let calls = 0;
    let started!: () => void;
    const sleeping = new Promise<void>(resolve => { started = resolve; });
    let backoffTimer: ReturnType<typeof setTimeout> | undefined;
    const cleared: unknown[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => {
      const timer = originalSetTimeout(...args);
      if (Number(args[1]) >= 600) { backoffTimer = timer; started(); }
      return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', (timer: Parameters<typeof clearTimeout>[0]) => {
      cleared.push(timer); originalClearTimeout(timer);
    });
    const model = withResilience(modelFor(async () => { calls++; return response(true); }), policy({ sleep: undefined }));
    const rejected = assert.rejects(run(model, path, controller.signal), error => error === reason);
    await sleeping;
    controller.abort(reason);
    await promptly(rejected);
    assert.ok(backoffTimer);
    assert.ok(cleared.includes(backoffTimer), 'the owned timer must be cleared, not merely ignored on settlement');
    assert.equal(calls, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  test(`${path}: a completed late response keeps actual usage and reports cancelled request telemetry`, async () => {
    const { withRawClaudeUsageRecording } = await import('./claude-model.js');
    const { harnessRunContextStorage } = await import('./brackets.js');
    const controller = new AbortController();
    const actual = response();
    const recorded: Array<Record<string, unknown>> = [];
    const events: ResilienceTelemetryEvent[] = [];
    let calls = 0;
    const model = withRawClaudeUsageRecording(withResilience(modelFor(async () => {
      calls++; controller.abort(abortReason()); return actual;
    }), policy()), 'claude-opus-4-8', entry => recorded.push(entry as unknown as Record<string, unknown>), () => {}, () => {});
    const result = await harnessRunContextStorage.run({ sessionId: 'cancelled-usage-fixture', sourceUserSeq: 17,
      runAttemptId: 'attempt:cancelled-usage', turn: 1 } as never, () =>
      withModelResilienceTelemetry(event => events.push(event), () => run(model, path, controller.signal)));
    if (path === 'getResponse') assert.equal(result, actual);
    else assert.match(JSON.stringify(result), /fixture result/);
    assert.equal(calls, 1);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.inputTokens, 42);
    assert.equal(recorded[0]?.outputTokens, 7);
    assert.equal(recorded[0]?.sourceUserSeq, 17);
    assert.equal(recorded[0]?.attemptId, 'attempt:cancelled-usage');
    const finished = events.find(event => event.type === 'call_finished');
    assert.ok(finished?.type === 'call_finished');
    assert.equal(finished.outcome, 'cancelled');
    assert.equal(finished.completionObserved, true);
  });
}

test('getStreamedResponse: a cancelled silent end cannot start an incomplete-stream retry', async () => {
  const controller = new AbortController();
  const reason = abortReason();
  let calls = 0;
  const events: ResilienceTelemetryEvent[] = [];
  const model = withResilience(modelFor(async () => {
    calls++; controller.abort(reason); return undefined;
  }), policy());
  await assert.rejects(withModelResilienceTelemetry(event => events.push(event),
    () => run(model, 'getStreamedResponse', controller.signal)), error => error === reason);
  assert.equal(calls, 1);
  assert.equal(events.some(event => event.type === 'retry_scheduled'), false);
  const attempt = events.find(event => event.type === 'attempt_finished');
  assert.ok(attempt?.type === 'attempt_finished');
  assert.equal(attempt.outcome, 'cancelled');
  assert.equal(attempt.completionObserved, false);
  assert.equal(attempt.failureKind, 'model.transport_timeout');
});

test('getStreamedResponse: a cancelled partial stream preserves committed content without reporting completion', async () => {
  const controller = new AbortController();
  const reason = abortReason();
  let calls = 0;
  const events: ResilienceTelemetryEvent[] = [];
  const seen: unknown[] = [];
  const model = withResilience({ async getResponse() { throw new Error('unused'); },
    async *getStreamedResponse() {
      calls++; yield { type: 'output_text_delta', delta: 'partial fixture' } as never;
      controller.abort(reason);
    },
  }, policy());
  await assert.rejects(withModelResilienceTelemetry(event => events.push(event), async () => {
    for await (const event of model.getStreamedResponse(request(controller.signal))) seen.push(event);
  }), error => error === reason);
  assert.equal(calls, 1);
  assert.equal(seen.length, 1);
  const attempt = events.find(event => event.type === 'attempt_finished');
  assert.ok(attempt?.type === 'attempt_finished');
  assert.equal(attempt.outcome, 'cancelled');
  assert.equal(attempt.contentCommitted, true);
  assert.equal(attempt.completionObserved, false);
});
