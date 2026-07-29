/**
 * Run: npx tsx --test src/runtime/harness/turn-stall.test.ts
 * Turn-stall watchdog (2026-06-11): a model stream that goes silent past
 * CLEMMY_MODEL_STREAM_STALL_MS aborts the turn with a timeout-flavored error
 * (transient → workflow steps auto-retry; chat surfaces run_failed) instead
 * of hanging forever. Events flowing reset the timer.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-stall-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
process.env.CLEMMY_MODEL_STREAM_STALL_MS = '300';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Runner } from '@openai/agents';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const { __defaultRunRunner } = await import('./loop.js');
const { isTransientStepError } = await import('../../execution/transient-error.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

function makeStreamResult(opts: { events?: number; gapMs?: number; hang?: boolean }) {
  let resolveCompleted!: () => void;
  const completed = new Promise<void>((r) => { resolveCompleted = r; });
  return {
    history: [],
    lastResponseId: 'resp_x',
    finalOutput: { ok: true },
    rawResponses: [],
    completed,
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < (opts.events ?? 0); i++) {
        await new Promise((r) => setTimeout(r, opts.gapMs ?? 50));
        yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: `t${i}` } };
      }
      if (opts.hang) {
        await new Promise(() => { /* never settles — the wedge */ });
      }
      resolveCompleted();
    },
  };
}

const runnerFor = (result: unknown): Runner =>
  ({ run: async () => result } as unknown as Runner);

function completedMessage(text: string): ModelResponse {
  return {
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  } as unknown as ModelResponse;
}

function neverSettlingModel(onAbort: () => void): Model {
  const waitForAbort = (request: ModelRequest): Promise<never> => new Promise((_resolve, reject) => {
    const signal = (request as { signal?: AbortSignal }).signal;
    const aborted = () => {
      onAbort();
      reject(new Error('fusion model request aborted'));
    };
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
  });
  return {
    getResponse: (request) => waitForAbort(request),
    getStreamedResponse: async function* (request) {
      await waitForAbort(request);
    },
  } as Model;
}

function runnerForModelStream(
  stream: (signal: AbortSignal) => AsyncIterable<unknown>,
): {
  runner: Runner;
  forceStop: () => void;
  cancelCalls: () => number;
} {
  let activeStop: () => void = () => {};
  let cancellationCalls = 0;
  const runner = {
    run: async () => {
      const controller = new AbortController();
      let complete!: () => void;
      const completed = new Promise<void>((resolve) => { complete = resolve; });
      let stopped = false;
      activeStop = () => {
        if (stopped) return;
        stopped = true;
        controller.abort();
        complete();
      };
      return {
        history: [],
        lastResponseId: 'fusion-stall',
        finalOutput: { ok: true },
        rawResponses: [],
        completed,
        cancel: () => {
          cancellationCalls += 1;
          activeStop();
        },
        async *[Symbol.asyncIterator]() {
          try {
            for await (const data of stream(controller.signal)) {
              yield { type: 'raw_model_stream_event', data };
            }
          } finally {
            complete();
          }
        },
      };
    },
  } as unknown as Runner;
  return {
    runner,
    forceStop: () => activeStop(),
    cancelCalls: () => cancellationCalls,
  };
}

async function expectFusionPreContentStall(
  rig: ReturnType<typeof runnerForModelStream>,
): Promise<void> {
  let safetyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      Promise.race([
        __defaultRunRunner(
          rig.runner,
          {} as never,
          [],
          { disablePreContentRetry: true } as never,
        ),
        new Promise<never>((_resolve, reject) => {
          safetyTimer = setTimeout(() => {
            rig.forceStop();
            reject(new Error('fusion watchdog regression safety timeout'));
          }, 1_500);
        }),
      ]),
      (err: unknown) => err instanceof Error
        && /timed out/.test(err.message)
        && !/regression safety/.test(err.message),
    );
  } finally {
    if (safetyTimer) clearTimeout(safetyTimer);
    rig.forceStop();
  }
  assert.equal(rig.cancelCalls(), 1, 'the watchdog attempted to cancel the stuck fused model stream');
}

test('a stream that never emits is aborted with a transient timeout error', async () => {
  const result = makeStreamResult({ events: 0, hang: true });
  const started = Date.now();
  await assert.rejects(
    __defaultRunRunner(runnerFor(result), {} as never, [], {} as never),
    (err: unknown) => err instanceof Error && /timed out/.test(err.message) && isTransientStepError(err),
  );
  assert.ok(Date.now() - started < 5_000, 'aborts promptly, not after minutes');
});

test('a stream wedging mid-flight (after events) is also aborted', async () => {
  const result = makeStreamResult({ events: 3, gapMs: 30, hang: true });
  await assert.rejects(
    __defaultRunRunner(runnerFor(result), {} as never, [], {} as never),
    /timed out/,
  );
});

test('steady events keep the turn alive even when each gap is near the threshold', async () => {
  // 6 events at 200ms gaps with a 300ms stall threshold: total 1.2s > threshold,
  // but the timer resets per event — must complete, not stall.
  const result = makeStreamResult({ events: 6, gapMs: 200 });
  const out = await __defaultRunRunner(runnerFor(result), {} as never, [], {} as never);
  assert.deepEqual(out.finalOutput, { ok: true });
});

test('genuine tool activity keeps the watchdog alive', async () => {
  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
  const result = {
    history: [],
    lastResponseId: 'resp_tool_activity',
    finalOutput: { ok: true },
    rawResponses: [],
    completed,
    async *[Symbol.asyncIterator]() {
      // Total duration exceeds the 300ms watchdog, but each real Runner tool
      // event is semantic progress and must refresh its liveness clock.
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        yield { type: 'run_item_stream_event', item: { type: 'tool_call_item', id: `tool-${i}` } };
      }
      resolveCompleted();
    },
  };

  const out = await __defaultRunRunner(runnerFor(result), {} as never, [], {} as never);

  assert.deepEqual(out.finalOutput, { ok: true });
});

test('buffered private reasoning keeps the watchdog alive without entering Runner history', async () => {
  const { harnessRunContextStorage, withHarnessRunContext, ToolCallsCounter } = await import('./brackets.js');
  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
  const result = {
    history: [],
    lastResponseId: 'resp_private_reasoning',
    finalOutput: { ok: true },
    rawResponses: [],
    completed,
    async *[Symbol.asyncIterator]() {
      const timer = setInterval(() => {
        const context = harnessRunContextStorage.getStore();
        if (context) context.privateModelActivityAt = Date.now();
      }, 75);
      try {
        // More than 2x the configured 300ms first-byte window, with zero public
        // stream events. Only the private reasoning liveness channel can keep it
        // alive; the fallback later flushes real reasoning if a tool/text commits.
        await new Promise((resolve) => setTimeout(resolve, 750));
      } finally {
        clearInterval(timer);
      }
      resolveCompleted();
    },
  };
  const context = {
    sessionId: 'private-reasoning-watchdog',
    counter: new ToolCallsCounter(8),
  };

  const out = await withHarnessRunContext(
    context,
    () => __defaultRunRunner(runnerFor(result), {} as never, [], {} as never),
  );
  assert.deepEqual(out.finalOutput, { ok: true });
  assert.equal(typeof context.privateModelActivityAt, 'number');
});

test('Fusion VERIFY visibility heartbeats do not keep a never-settling executor alive', async () => {
  const previousMode = process.env.CLEMMY_DEBATE_MODE;
  const previousStrategy = process.env.CLEMMY_FUSION_STRATEGY;
  process.env.CLEMMY_DEBATE_MODE = 'all';
  process.env.CLEMMY_FUSION_STRATEGY = 'verify';
  try {
    const { DebateModel } = await import('./debate-model.js');
    let executorAborts = 0;
    const executor = neverSettlingModel(() => { executorAborts += 1; });
    const checker = {
      getResponse: async () => completedMessage('{"verdict":"accept","issues":[],"corrected":null}'),
      getStreamedResponse: async function* () {},
    } as Model;
    const fused = new DebateModel(
      { passthrough: executor, draftA: executor, draftB: executor, judge: checker },
      { heartbeatMs: 50 },
    );
    const rig = runnerForModelStream((signal) => fused.getStreamedResponse({
      input: 'verify this',
      modelSettings: {},
      tools: [],
      handoffs: [],
      signal,
    } as unknown as ModelRequest));

    await expectFusionPreContentStall(rig);

    assert.equal(executorAborts, 1, 'the stuck VERIFY executor received cancellation');
  } finally {
    if (previousMode === undefined) delete process.env.CLEMMY_DEBATE_MODE;
    else process.env.CLEMMY_DEBATE_MODE = previousMode;
    if (previousStrategy === undefined) delete process.env.CLEMMY_FUSION_STRATEGY;
    else process.env.CLEMMY_FUSION_STRATEGY = previousStrategy;
  }
});

test('Fusion DEBATE visibility heartbeats do not keep two never-settling drafts alive', async () => {
  const previousMode = process.env.CLEMMY_DEBATE_MODE;
  const previousStrategy = process.env.CLEMMY_FUSION_STRATEGY;
  process.env.CLEMMY_DEBATE_MODE = 'all';
  process.env.CLEMMY_FUSION_STRATEGY = 'debate';
  try {
    const { DebateModel } = await import('./debate-model.js');
    let draftAAborts = 0;
    let draftBAborts = 0;
    const draftA = neverSettlingModel(() => { draftAAborts += 1; });
    const draftB = neverSettlingModel(() => { draftBAborts += 1; });
    const passthrough = neverSettlingModel(() => {});
    const judge = {
      getResponse: async () => completedMessage('unused'),
      getStreamedResponse: async function* () {},
    } as Model;
    const fused = new DebateModel(
      { passthrough, draftA, draftB, judge },
      { heartbeatMs: 50 },
    );
    const rig = runnerForModelStream((signal) => fused.getStreamedResponse({
      input: 'debate this',
      modelSettings: {},
      tools: [],
      handoffs: [],
      signal,
    } as unknown as ModelRequest));

    await expectFusionPreContentStall(rig);

    assert.equal(draftAAborts, 1, 'draft A received cancellation');
    assert.equal(draftBAborts, 1, 'draft B received cancellation');
  } finally {
    if (previousMode === undefined) delete process.env.CLEMMY_DEBATE_MODE;
    else process.env.CLEMMY_DEBATE_MODE = previousMode;
    if (previousStrategy === undefined) delete process.env.CLEMMY_FUSION_STRATEGY;
    else process.env.CLEMMY_FUSION_STRATEGY = previousStrategy;
  }
});

test('a PRE-CONTENT stall is retried and self-heals when the retry streams (Claude tool-turn hang)', async () => {
  // Tool-turn hang regression: the first model call produced ZERO events for the window
  // (a silent/wedged Claude stream). With pre-content retry, the SECOND call
  // streams normally and the turn recovers instead of hard-failing the user.
  const first = makeStreamResult({ events: 0, hang: true }); // wedges pre-content
  const second = makeStreamResult({ events: 2, gapMs: 30 }); // healthy retry
  let call = 0;
  const flakyRunner = { run: async () => (call++ === 0 ? first : second) } as unknown as Runner;
  const started = Date.now();
  const out = await __defaultRunRunner(flakyRunner, {} as never, [], {} as never);
  assert.deepEqual(out.finalOutput, { ok: true }, 'recovered via the retry');
  assert.equal(call, 2, 'made exactly one retry');
  assert.ok(Date.now() - started < 5_000, 'recovered promptly');
});

test('disablePreContentRetry (approval-resume): a pre-content stall does NOT replay — no duplicate approved write', async () => {
  // On resume the run input is a RunState whose first act is an already-approved,
  // side-effecting tool. A pre-content stall there must surface as an error, NOT
  // replay the state (which would re-fire the approved external write a second
  // time). The opts flag forces 0 retries; the runner is invoked exactly once.
  let call = 0;
  const wedgedRunner = { run: async () => { call++; return makeStreamResult({ events: 0, hang: true }); } } as unknown as Runner;
  await assert.rejects(
    __defaultRunRunner(wedgedRunner, {} as never, [], { disablePreContentRetry: true } as never),
    (err: unknown) => err instanceof Error && /timed out/.test(err.message),
  );
  assert.equal(call, 1, 'the approved-tool RunState was NOT replayed');
});

test('a superseded (stalled) attempt does NOT stream its late tokens into the live retry (no garble)', async () => {
  // The race that produced garbled output ("importportance") on a recovered
  // heavy Claude turn: the stalled attempt's stream delivers a late token RIGHT
  // as the retry begins, and both fed the same onChunk → interleaved SSE.
  let signalRetry!: () => void;
  const retryStarted = new Promise<void>((r) => { signalRetry = r; });
  const stale = {
    history: [], lastResponseId: 'r0', finalOutput: { ok: false }, rawResponses: [],
    completed: new Promise<void>(() => { /* abandoned — never completes */ }),
    async *[Symbol.asyncIterator]() {
      await retryStarted; // stay silent → pre-content stall → retry
      yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'STALE' } };
      await new Promise(() => { /* hang: the abandoned stream */ });
    },
  };
  const live = {
    history: [], lastResponseId: 'r1', finalOutput: { ok: true }, rawResponses: [],
    completed: Promise.resolve(),
    async *[Symbol.asyncIterator]() {
      signalRetry(); // release the stale stream's late token now, mid-retry
      await new Promise((r) => setTimeout(r, 40)); // give STALE a chance to interleave
      yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'GOOD' } };
    },
  };
  let call = 0;
  const runner = { run: async () => (call++ === 0 ? stale : live) } as unknown as Runner;
  const chunks: string[] = [];
  const out = await __defaultRunRunner(
    runner, {} as never, [],
    { onChunk: (d: string) => { chunks.push(d); } } as never,
  );
  assert.deepEqual(out.finalOutput, { ok: true }, 'the live retry won');
  assert.deepEqual(chunks, ['GOOD'], "the superseded attempt's late STALE token must be suppressed");
});

test('an authoritative normal attempt can mutate exactly once through the dispatch lease', async () => {
  const {
    ToolCallsCounter,
    withHarnessRunContext,
    wrapToolForHarness,
  } = await import('./brackets.js');
  const { createSession } = await import('./eventlog.js');
  const session = createSession({ kind: 'chat' });
  const writes: string[] = [];
  const wrapped = wrapToolForHarness({
    name: 'space_save',
    execute: async (input: unknown) => {
      writes.push(String((input as { writer?: unknown }).writer ?? 'unknown'));
      return 'saved';
    },
  }, { timeoutMs: 1_000 });
  const healthy = {
    history: [], lastResponseId: 'healthy', finalOutput: { ok: true }, rawResponses: [],
    completed: Promise.resolve(),
    async *[Symbol.asyncIterator]() {
      await wrapped.execute!({ writer: 'authoritative-attempt' });
      yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'done' } };
    },
  };

  const out = await withHarnessRunContext(
    {
      sessionId: session.id,
      behaviorScopeId: `${session.id}::turn:normal`,
      counter: new ToolCallsCounter(10),
    },
    () => __defaultRunRunner(runnerFor(healthy), {} as never, [], {} as never),
  );

  assert.deepEqual(out.finalOutput, { ok: true });
  assert.deepEqual(writes, ['authoritative-attempt']);
});

test('a superseded pre-content attempt cannot mutate after the recovery attempt starts', async () => {
  // The stream guard above protects only user-visible text. A cancelled provider
  // can still finish a late tool call after the retry has started, so the tool
  // boundary must reject work owned by the superseded attempt. This reproduces
  // the live GLM workspace race without a network dependency: cancel() is
  // observed, the recovery attempt saves first, then the abandoned attempt
  // reaches the real harness wrapper with a second space_save.
  const {
    ToolCallsCounter,
    withHarnessRunContext,
    wrapToolForHarness,
  } = await import('./brackets.js');
  const { createSession } = await import('./eventlog.js');
  const session = createSession({ kind: 'chat' });
  const writes: string[] = [];
  let cancelCalls = 0;
  let releaseRetry!: () => void;
  let settleStale!: () => void;
  const retryStarted = new Promise<void>((resolve) => { releaseRetry = resolve; });
  const staleSettled = new Promise<void>((resolve) => { settleStale = resolve; });
  const wrapped = wrapToolForHarness({
    name: 'space_save',
    execute: async (input: unknown) => {
      writes.push(String((input as { writer?: unknown }).writer ?? 'unknown'));
      return 'saved';
    },
  }, { timeoutMs: 1_000 });

  const stale = {
    history: [], lastResponseId: 'stale', finalOutput: { ok: false }, rawResponses: [],
    completed: Promise.resolve(),
    cancel: () => { cancelCalls += 1; },
    async *[Symbol.asyncIterator]() {
      await retryStarted;
      try {
        await wrapped.execute!({ writer: 'stale-attempt' });
        yield { type: 'run_item_stream_event', item: { type: 'tool_call_item' } };
      } catch {
        // A dispatch-lease refusal is the expected fixed behavior. The stale
        // drain is detached, so expose settlement through staleSettled below.
      } finally {
        settleStale();
      }
    },
  };
  const live = {
    history: [], lastResponseId: 'live', finalOutput: { ok: true }, rawResponses: [],
    completed: Promise.resolve(),
    async *[Symbol.asyncIterator]() {
      releaseRetry();
      await wrapped.execute!({ writer: 'recovery-attempt' });
      yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'done' } };
    },
  };
  let call = 0;
  const runner = { run: async () => (call++ === 0 ? stale : live) } as unknown as Runner;
  const out = await withHarnessRunContext(
    {
      sessionId: session.id,
      behaviorScopeId: `${session.id}::turn:1`,
      counter: new ToolCallsCounter(10),
    },
    () => __defaultRunRunner(runner, {} as never, [], {} as never),
  );
  await staleSettled;

  assert.deepEqual(out.finalOutput, { ok: true }, 'the recovery attempt remains authoritative');
  assert.equal(call, 2, 'the stalled turn is retried exactly once');
  assert.equal(cancelCalls, 1, 'the stale stream received the best-effort transport cancel');
  assert.deepEqual(
    writes,
    ['recovery-attempt'],
    'the superseded attempt must be fenced before its late mutation executes',
  );
});

test('a pre-content stall that NEVER recovers still fails after exhausting retries', async () => {
  // Both attempts wedge → after the one retry, surface the transient stall.
  const wedged = () => makeStreamResult({ events: 0, hang: true });
  const wedgedRunner = { run: async () => wedged() } as unknown as Runner;
  await assert.rejects(
    __defaultRunRunner(wedgedRunner, {} as never, [], {} as never),
    (err: unknown) => err instanceof Error && /timed out/.test(err.message) && isTransientStepError(err),
  );
});

test('kill-switch: CLEMMY_MODEL_STREAM_STALL_MS=0 disables the watchdog', async () => {
  process.env.CLEMMY_MODEL_STREAM_STALL_MS = '0';
  try {
    const result = makeStreamResult({ events: 2, gapMs: 400 });
    const out = await __defaultRunRunner(runnerFor(result), {} as never, [], {} as never);
    assert.deepEqual(out.finalOutput, { ok: true });
  } finally {
    process.env.CLEMMY_MODEL_STREAM_STALL_MS = '300';
  }
});

test('G4 (2026-07-20): a kill lands MID-STREAM on a tool-less turn — no waiting for the next boundary', async () => {
  // Steady events keep the stall watchdog satisfied (gap 200ms < 300ms window),
  // so ONLY the kill poll can stop this turn. Before the fix, a kill during a
  // long tool-less reasoning stretch waited for the next tool call / step
  // boundary; the Claude SDK lane already polled per stream message.
  const { createSession, requestKill } = await import('./eventlog.js');
  const sess = createSession({ kind: 'chat' });
  requestKill(sess.id, 'user hit stop');
  const result = makeStreamResult({ events: 40, gapMs: 200 }); // ~8s of healthy streaming
  const started = Date.now();
  await assert.rejects(
    __defaultRunRunner(runnerFor(result), {} as never, [], { context: { sessionId: sess.id } } as never),
    (err: unknown) => err instanceof Error && err.name === 'KillRequested',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4_000, `kill honored mid-stream in ~1 poll tick, not at the turn boundary (took ${elapsed}ms)`);
});

test('a killed attempt is fenced before transport cancel can release a late mutation', async () => {
  const {
    ToolCallsCounter,
    withHarnessRunContext,
    wrapToolForHarness,
  } = await import('./brackets.js');
  const { createSession, requestKill } = await import('./eventlog.js');
  const session = createSession({ kind: 'chat' });
  const writes: string[] = [];
  let cancelCalls = 0;
  let releaseCancel!: () => void;
  let signalStarted!: () => void;
  let signalSettled!: () => void;
  const cancelled = new Promise<void>((resolve) => { releaseCancel = resolve; });
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const settled = new Promise<void>((resolve) => { signalSettled = resolve; });
  const wrapped = wrapToolForHarness({
    name: 'space_save',
    execute: async () => {
      writes.push('late-after-kill');
      return 'saved';
    },
  }, { timeoutMs: 1_000 });
  const stale = {
    history: [], lastResponseId: 'killed', finalOutput: { ok: false }, rawResponses: [],
    completed: Promise.resolve(),
    cancel: () => {
      cancelCalls += 1;
      releaseCancel();
    },
    async *[Symbol.asyncIterator]() {
      signalStarted();
      let wasCancelled = false;
      while (!wasCancelled) {
        wasCancelled = await Promise.race([
          cancelled.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
        ]);
        if (!wasCancelled) {
          yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: '.' } };
        }
      }
      try {
        await wrapped.execute!({});
      } catch {
        // The kill path must revoke before invoking cancel(), so this is the
        // expected stale-generation refusal.
      } finally {
        signalSettled();
      }
    },
  };
  const task = withHarnessRunContext(
    {
      sessionId: session.id,
      behaviorScopeId: `${session.id}::turn:kill`,
      counter: new ToolCallsCounter(10),
    },
    () => __defaultRunRunner(
      runnerFor(stale),
      {} as never,
      [],
      { context: { sessionId: session.id } } as never,
    ),
  );
  await started;
  requestKill(session.id, 'user hit stop');
  await assert.rejects(
    task,
    (err: unknown) => err instanceof Error && err.name === 'KillRequested',
  );
  await settled;

  assert.equal(cancelCalls, 1);
  assert.deepEqual(writes, [], 'cancel-released stale work never reaches the local mutation');
});
