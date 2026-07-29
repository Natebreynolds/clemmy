import { after, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import {
  withModelFallback,
  isOverloadError,
  isFalloverError,
  fallbackRouteResolution,
  type FallbackTarget,
  __test__,
} from './fallback-model.js';
import { BoundaryError } from '../boundary-error.js';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-fallback-model-test-'));
__test__.setDeadBrainsFileForTests(path.join(TMP, 'brain-auth-dead.json'));
__test__.setSilentBrainsFileForTests(path.join(TMP, 'brain-silent-cooldown.json'));

after(() => {
  __test__.setDeadBrainsFileForTests(null);
  __test__.setSilentBrainsFileForTests(null);
  rmSync(TMP, { recursive: true, force: true });
});

function req(): ModelRequest { return { input: 'hi', modelSettings: {}, tools: [], handoffs: [] } as unknown as ModelRequest; }
function resp(text: string): ModelResponse { return { output: [{ type: 'message', content: text }], usage: {} } as unknown as ModelResponse; }
const overload = () => ({ statusCode: 529, message: 'overloaded_error' });

function model(impl: Partial<Model>): Model {
  return {
    getResponse: impl.getResponse ?? (async () => resp('ok')),
    getStreamedResponse: impl.getStreamedResponse ?? (async function* () { yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as any; }),
  } as Model;
}
function target(label: string, m: Model): FallbackTarget { return { label, getModel: () => m }; }
async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> { const o: unknown[] = []; for await (const e of it) o.push(e); return o; }

beforeEach(async () => {
  // The cooldown memo is module-global; tests reuse brain labels, so a bench
  // earned in one case must never leak into the next (surfaced 2026-07-22 when
  // OVERLOADED joined the memo and test 7's opus bench rerouted test 8).
  const { clearRateLimitedBrainsForTest, reviveDeadBrains } = await import('./fallback-model.js');
  clearRateLimitedBrainsForTest();
  reviveDeadBrains();
});

test('isOverloadError: 529 yes, 429 no, BoundaryError(model.overloaded) yes', () => {
  assert.equal(isOverloadError({ statusCode: 529 }), true);
  assert.equal(isOverloadError({ statusCode: 429 }), false);
  assert.equal(isOverloadError({ statusCode: 400 }), false);
  assert.equal(isOverloadError(new BoundaryError({ kind: 'model.overloaded', retryable: true, userMessage: '', operatorMessage: '' })), true);
  assert.equal(isOverloadError(new BoundaryError({ kind: 'model.rate_limited', retryable: true, userMessage: '', operatorMessage: '' })), false);
});

test('isFalloverError: overload/5xx/TRANSPORT-TIMEOUT yes; 429 + 4xx no (the timeout is the real-world capacity case)', () => {
  assert.equal(isFalloverError({ statusCode: 529 }), true, 'overloaded');
  assert.equal(isFalloverError({ statusCode: 503 }), true, '5xx');
  // The load-bearing case: Anthropic at capacity HANGS → transport_timeout.
  assert.equal(isFalloverError(new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: '' })), true);
  assert.equal(isFalloverError(new BoundaryError({ kind: 'model.empty_completion', retryable: true, userMessage: '', operatorMessage: '' })), true);
  assert.equal(isFalloverError({ message: 'fetch failed' }), true, 'a transport error classifies as transport_timeout');
  // Excluded: a 429 is account-wide quota — switching Claude tiers won't help.
  assert.equal(isFalloverError({ statusCode: 429 }), false, '429 not a fallover');
  assert.equal(isFalloverError({ statusCode: 400 }), false, '4xx not a fallover');
});

test('getStreamedResponse: a TRANSPORT TIMEOUT (the Anthropic-hang case) falls over — not just a clean 529', async () => {
  // This is the exact failure the user hit: Claude hangs (transport_timeout), the
  // resilient wrapper throws it, and the chain MUST advance instead of failing.
  let codexCalls = 0;
  const opus = model({ getStreamedResponse: async function* () { throw new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: 'hung' }); } });
  const codex = model({ getStreamedResponse: async function* () { codexCalls++; yield { type: 'response_done', response: { output: [{ type: 'message', content: 'from codex' }] } } as any; } });
  const out = await collect(withModelFallback([target('opus', opus), target('codex', codex)]).getStreamedResponse(req()));
  assert.equal(codexCalls, 1, 'a transport timeout fell over to Codex');
  assert.ok(out.length > 0);
});

test('single-element chain keeps the completion invariant instead of bypassing the wrapper', async () => {
  const m = model({});
  const guarded = withModelFallback([target('only', m)]);
  assert.notEqual(guarded, m);
  assert.equal((await guarded.getResponse(req()).then((result) => (result.output[0] as any).content)), 'ok');
});

test('request capability: a tool-bearing turn skips a text-only fallback target', async () => {
  let textOnlyCalls = 0;
  let toolCapableCalls = 0;
  const textOnly = model({ getResponse: async () => { textOnlyCalls++; return resp('wrong'); } });
  const toolCapable = model({ getResponse: async () => { toolCapableCalls++; return resp('right'); } });
  const routed = withModelFallback([
    { label: 'text-only', getModel: () => textOnly, supportsRequest: (request) => (request.tools?.length ?? 0) === 0 },
    target('tool-capable', toolCapable),
  ]);
  const request = { ...req(), tools: [{ name: 'read_file' }] } as unknown as ModelRequest;
  const result = await routed.getResponse(request);
  assert.equal(textOnlyCalls, 0);
  assert.equal(toolCapableCalls, 1);
  assert.equal((result.output[0] as any).content, 'right');
});

test('request capability: a compatible text request may use the text-only target', async () => {
  let textOnlyCalls = 0;
  const textOnly = model({ getResponse: async () => { textOnlyCalls++; return resp('text'); } });
  const routed = withModelFallback([
    { label: 'text-only', getModel: () => textOnly, supportsRequest: (request) => (request.tools?.length ?? 0) === 0 },
    target('other', model({ getResponse: async () => resp('other') })),
  ]);
  await routed.getResponse(req());
  assert.equal(textOnlyCalls, 1);
});

test('getResponse: overload on primary falls back to the next brain', async () => {
  let opusCalls = 0, sonnetCalls = 0;
  const opus = model({ getResponse: async () => { opusCalls++; throw overload(); } });
  const sonnet = model({ getResponse: async () => { sonnetCalls++; return resp('from sonnet'); } });
  const res = await withModelFallback([
    { ...target('opus', opus), provider: 'claude', model: 'claude-opus' },
    { ...target('sonnet', sonnet), provider: 'claude', model: 'claude-sonnet' },
  ]).getResponse(req());
  assert.equal(opusCalls, 1);
  assert.equal(sonnetCalls, 1);
  assert.equal((res.output[0] as any).content, 'from sonnet');
  assert.deepEqual(fallbackRouteResolution(res), {
    initialLabel: 'opus',
    resolvedLabel: 'sonnet',
    provider: 'claude',
    model: 'claude-sonnet',
    fellOver: true,
    reason: 'model.overloaded',
  }, 'the response carries truthful winner metadata for outer route accounting');
});

test('getResponse: a caller-configured overall abort remains bounded and never dispatches a rescue', async () => {
  const controller = new AbortController();
  let rescueCalls = 0;
  const primary = model({
    getResponse: async (request: any) => new Promise<ModelResponse>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('aborted by overall deadline')), { once: true });
    }),
  });
  const rescue = model({
    getResponse: async () => {
      rescueCalls += 1;
      return resp('unexpected rescue');
    },
  });
  const overallDeadline = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(
      () => withModelFallback(
        [target('primary', primary), target('rescue', rescue)],
        { firstByteTimeoutMs: 1 },
      ).getResponse({ ...req(), signal: controller.signal } as never),
      /overall deadline/,
    );
  } finally {
    clearTimeout(overallDeadline);
  }
  assert.equal(rescueCalls, 0, 'caller cancellation is authoritative and never starts a duplicate provider call');
});

test('getResponse: a NON-overload error (400) does NOT fall back — it throws', async () => {
  let sonnetCalls = 0;
  const opus = model({ getResponse: async () => { throw { statusCode: 400, message: 'bad' }; } });
  const sonnet = model({ getResponse: async () => { sonnetCalls++; return resp('x'); } });
  await assert.rejects(() => withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getResponse(req()));
  assert.equal(sonnetCalls, 0, 'never tried the fallback for a non-overload error');
});

test('getResponse: chain Opus->Sonnet->Codex, all overloaded except the last', async () => {
  const opus = model({ getResponse: async () => { throw overload(); } });
  const sonnet = model({ getResponse: async () => { throw overload(); } });
  const codex = model({ getResponse: async () => resp('from codex') });
  const res = await withModelFallback([target('opus', opus), target('sonnet', sonnet), target('codex', codex)]).getResponse(req());
  assert.equal((res.output[0] as any).content, 'from codex');
});

test('getStreamedResponse: overload before any yield falls back and streams the next brain', async () => {
  const opus = model({ getStreamedResponse: async function* () { throw overload(); } });
  const sonnet = model({ getStreamedResponse: async function* () {
    yield { type: 'response_started' } as any;
    yield { type: 'output_text_delta', delta: 'sonnet says hi' } as any;
    yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as any;
  } });
  const events = await collect(withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getStreamedResponse(req()));
  assert.ok((events as any[]).some((e) => e.type === 'output_text_delta' && e.delta === 'sonnet says hi'));
  assert.ok(events.every((event) => fallbackRouteResolution(event)?.resolvedLabel === 'sonnet'));
  assert.ok(events.every((event) => fallbackRouteResolution(event)?.fellOver === true));
});

test('stream metadata and response_started are buffered: failure before real content may fall over', async () => {
  let rescueCalls = 0;
  const metadataThenFailure = model({ getStreamedResponse: async function* () {
    yield { type: 'response_started', providerData: { responseId: 'do-not-leak' } } as any;
    yield { type: 'model', event: { type: 'response.in_progress', sequence_number: 1 } } as any;
    throw overload();
  } });
  const rescue = model({ getStreamedResponse: async function* () {
    rescueCalls += 1;
    yield { type: 'output_text_delta', delta: 'rescued after metadata-only failure' } as any;
  } });
  const events = await collect(withModelFallback([
    target('metadata-primary', metadataThenFailure),
    target('metadata-rescue', rescue),
  ]).getStreamedResponse(req()));

  assert.equal(rescueCalls, 1);
  assert.deepEqual(
    events.map((event) => (event as { type?: string }).type),
    ['output_text_delta'],
    'uncommitted primary metadata is discarded instead of leaking across the rescue response',
  );
});

test('first-content deadline is not satisfied or reset by response_started/keepalive metadata', async () => {
  let rescueCalls = 0;
  const metadataThenHang = model({ getStreamedResponse: async function* (request: any) {
    yield { type: 'response_started' } as any;
    yield { type: 'model', event: { type: 'response.in_progress' } } as any;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5_000);
      request?.signal?.addEventListener?.('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted metadata-only stream'));
      }, { once: true });
    });
  } });
  const rescue = model({ getStreamedResponse: async function* () {
    rescueCalls += 1;
    yield { type: 'output_text_delta', delta: 'deadline rescue' } as any;
  } });
  const startedAt = Date.now();
  const events = await collect(withModelFallback([
    target('metadata-hang', metadataThenHang),
    target('deadline-rescue', rescue),
  ], { firstByteTimeoutMs: 50 }).getStreamedResponse(req()));

  assert.equal(rescueCalls, 1);
  assert.ok(Date.now() - startedAt < 1_000, 'metadata cannot extend a 50ms first-content budget into a hang');
  assert.deepEqual(events.map((event) => (event as any).delta), ['deadline rescue']);
});

test('reasoning-only work stays private and may fall over before any actionable output escapes', async () => {
  let rescueCalls = 0;
  const reasoningThenFailure = model({ getStreamedResponse: async function* () {
    yield { type: 'response_started' } as any;
    yield {
      type: 'model',
      event: { type: 'response.reasoning_summary_text.delta', delta: 'considering the safe tool' },
    } as any;
    throw overload();
  } });
  const rescue = model({ getStreamedResponse: async function* () {
    rescueCalls += 1;
    yield { type: 'output_text_delta', delta: 'rescued' } as any;
  } });
  const got = await collect(withModelFallback([
    target('reasoning-primary', reasoningThenFailure),
    target('reasoning-rescue', rescue),
  ]).getStreamedResponse(req()));
  assert.equal(rescueCalls, 1);
  assert.deepEqual(
    got.map((event) => (event as any).delta).filter(Boolean),
    ['rescued'],
    'discarded private reasoning never leaks or duplicates across the rescue',
  );
});

test('a reasoning-only completed response falls over instead of entering the Agents SDK run-again loop', async () => {
  let rescueCalls = 0;
  const reasoningOnly = model({ getStreamedResponse: async function* () {
    yield { type: 'response_started' } as any;
    yield {
      type: 'model',
      event: { type: 'response.reasoning_summary_text.delta', delta: 'private analysis' },
    } as any;
    yield {
      type: 'response_done',
      response: {
        output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'private analysis' }] }],
        usage: { outputTokens: 4_096 },
      },
    } as any;
  } });
  const rescue = model({ getStreamedResponse: async function* () {
    rescueCalls += 1;
    yield { type: 'output_text_delta', delta: 'actionable answer' } as any;
  } });

  const got = await collect(withModelFallback([
    target('reasoning-only', reasoningOnly),
    target('rescue', rescue),
  ]).getStreamedResponse(req()));

  assert.equal(rescueCalls, 1);
  assert.deepEqual(got.map((event) => (event as any).delta).filter(Boolean), ['actionable answer']);
});

test('a lone reasoning-only brain surfaces typed model.empty_completion instead of a clean loop', async () => {
  const reasoningOnly = model({ getStreamedResponse: async function* () {
    yield {
      type: 'model',
      event: { type: 'reasoning-delta', delta: 'still thinking' },
    } as any;
    yield {
      type: 'response_done',
      response: { output: [{ type: 'reasoning', content: [{ text: 'still thinking' }] }] },
    } as any;
  } });

  await assert.rejects(
    () => collect(withModelFallback([target('only', reasoningOnly)]).getStreamedResponse(req())),
    (err: unknown) => err instanceof BoundaryError && err.kind === 'model.empty_completion',
  );
});

test('private reasoning updates run liveness without escaping before an actionable item', async () => {
  const { harnessRunContextStorage, ToolCallsCounter } = await import('./brackets.js');
  const context = {
    sessionId: 'private-reasoning-liveness',
    counter: new ToolCallsCounter(8),
    privateModelActivityAt: undefined as number | undefined,
  };
  const reasoningOnly = model({ getStreamedResponse: async function* () {
    yield {
      type: 'model',
      event: { type: 'reasoning-delta', delta: 'active private work' },
    } as any;
  } });

  await assert.rejects(
    () => harnessRunContextStorage.run(
      context,
      () => collect(withModelFallback([target('liveness-only', reasoningOnly)]).getStreamedResponse(req())),
    ),
    (err: unknown) => err instanceof BoundaryError && err.kind === 'model.empty_completion',
  );
  assert.equal(typeof context.privateModelActivityAt, 'number');
  assert.ok((context.privateModelActivityAt ?? 0) > 0);
});

test('reasoning may run past the first-byte budget when it eventually yields a tool', async () => {
  let rescueCalls = 0;
  const slowReasoningThenTool = model({ getStreamedResponse: async function* () {
    yield {
      type: 'model',
      event: { type: 'reasoning-delta', delta: 'working' },
    } as any;
    await new Promise((resolve) => setTimeout(resolve, 90));
    yield {
      type: 'model',
      event: {
        type: 'response.output_item.added',
        item: { type: 'function_call', call_id: 'call-slow', name: 'read_file', arguments: '{}' },
      },
    } as any;
    yield {
      type: 'response_done',
      response: { output: [{ type: 'function_call', call_id: 'call-slow', name: 'read_file', arguments: '{}' }] },
    } as any;
  } });
  const rescue = model({ getStreamedResponse: async function* () {
    rescueCalls += 1;
    yield { type: 'output_text_delta', delta: 'should not run' } as any;
  } });

  const got = await collect(withModelFallback([
    target('reasoning-then-tool', slowReasoningThenTool),
    target('rescue', rescue),
  ], { firstByteTimeoutMs: 40 }).getStreamedResponse(req()));

  assert.equal(rescueCalls, 0);
  assert.ok(got.some((event) => (event as any).event?.item?.type === 'function_call'));
});

test('non-streamed reasoning-only response falls over to an actionable brain', async () => {
  let rescueCalls = 0;
  const reasoningOnly = model({
    getResponse: async () => ({
      output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'private' }] }],
      usage: { outputTokens: 4_096 },
    } as never),
  });
  const rescue = model({
    getResponse: async () => {
      rescueCalls += 1;
      return resp('actionable');
    },
  });
  const result = await withModelFallback([
    target('reasoning-only', reasoningOnly),
    target('rescue', rescue),
  ]).getResponse(req());
  assert.equal(rescueCalls, 1);
  assert.equal((result.output[0] as any).content, 'actionable');
});

test('reasoning-only silence is remembered across fresh wrappers in one Runner.run', async () => {
  const runSilencedLabels = new Set<string>();
  let primaryCalls = 0;
  let rescueCalls = 0;
  const reasoningOnly = model({
    getResponse: async () => {
      primaryCalls += 1;
      return {
        output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'private' }] }],
        usage: { outputTokens: 4_096 },
      } as never;
    },
  });
  const rescue = model({
    getResponse: async () => {
      rescueCalls += 1;
      return resp('actionable');
    },
  });
  const chain = [target('reasoning-run-primary', reasoningOnly), target('reasoning-run-rescue', rescue)];

  await withModelFallback(chain, { runSilencedLabels }).getResponse(req());
  await withModelFallback(chain, { runSilencedLabels }).getResponse(req());

  assert.equal(primaryCalls, 1, 'later SDK iterations skip the lane that already completed reasoning-only');
  assert.equal(rescueCalls, 2);
  assert.deepEqual([...runSilencedLabels], ['reasoning-run-primary']);
});

test('native compaction is durable continuation progress and never switches providers', async () => {
  let rescueCalls = 0;
  const compacting = model({ getStreamedResponse: async function* () {
    yield {
      type: 'model',
      event: {
        type: 'response.output_item.added',
        item: { type: 'compaction', encryptedContent: 'opaque-provider-state' },
      },
    } as any;
    yield {
      type: 'response_done',
      response: { output: [{ type: 'compaction', encryptedContent: 'opaque-provider-state' }] },
    } as any;
  } });
  const rescue = model({ getStreamedResponse: async function* () {
    rescueCalls += 1;
    yield { type: 'output_text_delta', delta: 'incorrect replay' } as any;
  } });

  const got = await collect(withModelFallback([
    target('codex-compaction', compacting),
    target('other-provider', rescue),
  ]).getStreamedResponse(req()));

  assert.equal(rescueCalls, 0);
  assert.ok(got.some((event) => (event as any).event?.item?.type === 'compaction'));
});

test('caller abort during buffered reasoning never dispatches a rescue brain', async () => {
  const controller = new AbortController();
  let rescueCalls = 0;
  const reasoningUntilAbort = model({ getStreamedResponse: async function* (request: any) {
    yield {
      type: 'model',
      event: { type: 'reasoning-delta', delta: 'working until cancelled' },
    } as any;
    await new Promise<void>((_resolve, reject) => {
      request?.signal?.addEventListener?.('abort', () => reject(new Error('caller aborted')), { once: true });
    });
  } });
  const rescue = model({ getStreamedResponse: async function* () {
    rescueCalls += 1;
    yield { type: 'output_text_delta', delta: 'must not run' } as any;
  } });

  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => collect(withModelFallback([
    target('abort-primary', reasoningUntilAbort),
    target('abort-rescue', rescue),
  ]).getStreamedResponse({ ...req(), signal: controller.signal } as never)));
  assert.equal(rescueCalls, 0);
});

test('tool-call content commits the stream, so a later failure is not replayed on another model', async () => {
  let rescueCalls = 0;
  const toolThenFailure = model({ getStreamedResponse: async function* () {
    yield { type: 'response_started' } as any;
    yield {
      type: 'model',
      event: {
        type: 'response.output_item.added',
        item: { type: 'function_call', call_id: 'call-1', name: 'write_record', arguments: '' },
      },
    } as any;
    throw overload();
  } });
  const rescue = model({ getStreamedResponse: async function* () {
    rescueCalls += 1;
    yield { type: 'output_text_delta', delta: 'duplicate tool turn' } as any;
  } });
  await assert.rejects(() => collect(withModelFallback([
    target('tool-primary', toolThenFailure),
    target('tool-rescue', rescue),
  ]).getStreamedResponse(req())));
  assert.equal(rescueCalls, 0);
});

test('force-overload knob (dev-gated) skips the primary so the next brain answers', async () => {
  const prevDev = process.env.CLEMMY_DEV_OVERRIDES;
  const prevForce = process.env.CLEMMY_FORCE_CLAUDE_OVERLOAD;
  process.env.CLEMMY_DEV_OVERRIDES = '1';
  process.env.CLEMMY_FORCE_CLAUDE_OVERLOAD = '1';
  try {
    let opusCalls = 0, sonnetCalls = 0;
    const opus = model({ getResponse: async () => { opusCalls++; return resp('opus'); } });
    const sonnet = model({ getResponse: async () => { sonnetCalls++; return resp('sonnet'); } });
    const res = await withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getResponse(req());
    assert.equal(opusCalls, 0, 'force knob skipped the primary');
    assert.equal(sonnetCalls, 1);
    assert.equal((res.output[0] as any).content, 'sonnet');
  } finally {
    if (prevDev === undefined) delete process.env.CLEMMY_DEV_OVERRIDES; else process.env.CLEMMY_DEV_OVERRIDES = prevDev;
    if (prevForce === undefined) delete process.env.CLEMMY_FORCE_CLAUDE_OVERLOAD; else process.env.CLEMMY_FORCE_CLAUDE_OVERLOAD = prevForce;
  }
});

test('getStreamedResponse: overload AFTER content yielded does NOT fall back (would duplicate)', async () => {
  let sonnetCalls = 0;
  const opus = model({ getStreamedResponse: async function* () {
    yield { type: 'output_text_delta', delta: 'partial' } as any;
    throw overload();
  } });
  const sonnet = model({ getStreamedResponse: async function* () { sonnetCalls++; yield { type: 'response_done', response: { output: [] } } as any; } });
  const got: any[] = [];
  await assert.rejects(async () => { for await (const e of withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getStreamedResponse(req())) got.push(e); });
  assert.equal(sonnetCalls, 0, 'committed stream is not switched');
  assert.ok(got.some((e) => e.type === 'output_text_delta'));
});

// ─── Universal cross-provider fallover: 429 + first-byte-timeout (2026-06-21) ───

const rateLimited = () => ({ statusCode: 429, message: 'rate_limited' });

test('falloverOn429: a 429 on one provider falls over to the next (cross-provider quota is independent)', async () => {
  let nextCalls = 0;
  const glm = model({ getStreamedResponse: async function* () { throw rateLimited(); } });
  const codex = model({ getStreamedResponse: async function* () { nextCalls++; yield { type: 'output_text_delta', delta: 'from codex' } as any; } });
  const out = await collect(withModelFallback([target('glm', glm), target('codex', codex)], { falloverOn429: true }).getStreamedResponse(req()));
  assert.equal(nextCalls, 1, 'a 429 fell over to the next provider');
  assert.ok((out as any[]).some((e) => e.delta === 'from codex'));
});

test('falloverOn429: Anthropic HTTP 400 extra-usage exhaustion falls over as model capacity', async () => {
  let limitedCalls = 0;
  let nextCalls = 0;
  const claude = model({ getStreamedResponse: async function* () {
    limitedCalls++;
    throw { status: 400, message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going." };
  } });
  const codex = model({ getStreamedResponse: async function* () {
    nextCalls++;
    yield { type: 'output_text_delta', delta: 'rescued by codex' } as any;
  } });
  const out = await collect(withModelFallback(
    [target('claude-fable-5', claude), target('codex', codex)],
    { falloverOn429: true },
  ).getStreamedResponse(req()));
  assert.equal(limitedCalls, 1);
  assert.equal(nextCalls, 1);
  assert.ok((out as any[]).some((event) => event.delta === 'rescued by codex'));
});

test('default (no opts): a 429 does NOT fall over (same-provider tier behavior preserved)', async () => {
  let nextCalls = 0;
  const opus = model({ getStreamedResponse: async function* () { throw rateLimited(); } });
  const sonnet = model({ getStreamedResponse: async function* () { nextCalls++; yield { type: 'response_done', response: { output: [] } } as any; } });
  await assert.rejects(async () => { for await (const _ of withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getStreamedResponse(req())) { /* drain */ } });
  assert.equal(nextCalls, 0, 'a 429 without the cross-provider opt-in does NOT switch tiers');
});

test('firstByteTimeoutMs: a brain that HANGS pre-content falls over to the next brain', async () => {
  let nextCalls = 0;
  // Hung brain: never yields a first event; respects the abort signal so the test cleans up fast.
  const hung = model({ getStreamedResponse: async function* (request: any) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 5_000);
      request?.signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    });
    yield { type: 'response_done', response: { output: [] } } as any;
  } });
  const codex = model({ getStreamedResponse: async function* () { nextCalls++; yield { type: 'output_text_delta', delta: 'rescued' } as any; } });
  const out = await collect(withModelFallback([target('hung', hung), target('codex', codex)], { firstByteTimeoutMs: 50 }).getStreamedResponse(req()));
  assert.equal(nextCalls, 1, 'the hung brain fell over to the next');
  assert.ok((out as any[]).some((e) => e.delta === 'rescued'));
});

test('firstByteTimeoutMs: a brain that answers quickly is NOT falsely failed over', async () => {
  let nextCalls = 0;
  const fast = model({ getStreamedResponse: async function* () { yield { type: 'output_text_delta', delta: 'fast reply' } as any; } });
  const codex = model({ getStreamedResponse: async function* () { nextCalls++; yield { type: 'output_text_delta', delta: 'should not run' } as any; } });
  const out = await collect(withModelFallback([target('fast', fast), target('codex', codex)], { firstByteTimeoutMs: 50 }).getStreamedResponse(req()));
  assert.equal(nextCalls, 0, 'a prompt brain is never failed over');
  assert.ok((out as any[]).some((e) => e.delta === 'fast reply'));
});

test('run-scoped silent memory avoids paying the same first-byte timeout twice in one harness turn', async () => {
  const runSilencedLabels = new Set<string>();
  let hungCalls = 0;
  let rescueCalls = 0;
  const hung = model({ getResponse: async () => {
    hungCalls += 1;
    throw new BoundaryError({
      kind: 'model.transport_timeout',
      retryable: true,
      userMessage: '',
      operatorMessage: 'provider stayed silent',
    });
  } });
  const rescue = model({ getResponse: async () => {
    rescueCalls += 1;
    return resp('rescued');
  } });

  // RouterModelProvider resolves a fresh FallbackModel for each SDK model turn.
  // Both wrappers share the harness run's set, so the second turn must start on
  // the already-proven rescue lane instead of burning another timeout.
  await withModelFallback(
    [target('silent-primary', hung), target('healthy-rescue', rescue)],
    { runSilencedLabels },
  ).getResponse(req());
  await withModelFallback(
    [target('silent-primary', hung), target('healthy-rescue', rescue)],
    { runSilencedLabels },
  ).getResponse(req());

  assert.equal(hungCalls, 1, 'one silent probe per harness turn, not one per model iteration');
  assert.equal(rescueCalls, 2);
  assert.deepEqual([...runSilencedLabels], ['silent-primary']);
});

test('isFalloverError: a brain AUTH failure is recoverable → fall over to a valid brain (not terminal)', () => {
  // ClaudeAuthError (expired subscription) and reauth-worded errors → fallover.
  class ClaudeAuthError extends Error { constructor(m: string) { super(m); this.name = 'ClaudeAuthError'; } }
  assert.equal(isFalloverError(new ClaudeAuthError('Claude subscription token has expired')), true);
  assert.equal(isFalloverError(new Error('Claude token refresh failed (400): invalid_grant')), true);
  assert.equal(isFalloverError(new Error('HTTP 401 Unauthorized')), true);
  // A plain bad-request / validation error is NOT an auth fallover.
  assert.equal(isFalloverError(new Error('400 invalid schema for field x')), false);
});

// ─── Sticky dead-brain registry (2026-07-08) ────────────────────────────────
// Live logs showed 25 auth_expired fallovers over two days: the chain re-tried
// a dead-token brain on EVERY request before falling over. An auth failure
// must stick — the next request skips the dead brain entirely.
test('sticky auth-dead: after an auth failure, the NEXT request skips the dead brain entirely', async () => {
  const { reviveDeadBrains, isBrainAuthDead } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    let deadCalls = 0, liveCalls = 0;
    const dead = model({ getResponse: async () => { deadCalls++; throw new Error('HTTP 401 Unauthorized'); } });
    const live = model({ getResponse: async () => { liveCalls++; return resp('from live'); } });
    const fb = withModelFallback([target('gpt-5.5-dead', dead), target('claude-live', live)]);
    await fb.getResponse(req()); // first request: probes dead → falls over → marks dead
    assert.equal(deadCalls, 1);
    assert.equal(liveCalls, 1);
    assert.equal(isBrainAuthDead('gpt-5.5-dead'), true, 'the auth failure stuck');
    assert.equal(__test__.getDeadBrainEntryForTests('gpt-5.5-dead')?.reason, 'model.auth_expired');
    await fb.getResponse(req()); // second request: dead brain is SKIPPED
    assert.equal(deadCalls, 1, 'the dead brain was not probed again');
    assert.equal(liveCalls, 2);
  } finally {
    reviveDeadBrains();
  }
});

test('sticky auth-dead: marker survives daemon restart and skips the dead brain during cooldown', async () => {
  const { reviveDeadBrains, isBrainAuthDead } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    let deadCalls = 0, liveCalls = 0;
    const dead = model({ getResponse: async () => { deadCalls++; throw new Error('HTTP 401 Unauthorized'); } });
    const live = model({ getResponse: async () => { liveCalls++; return resp('from live'); } });
    const fb = withModelFallback([target('restart-dead', dead), target('restart-live', live)]);
    await fb.getResponse(req());
    assert.equal(deadCalls, 1);
    assert.equal(liveCalls, 1);
    assert.equal(isBrainAuthDead('restart-dead'), true);

    __test__.resetDeadBrainsMemoryForTests();
    const afterRestart = withModelFallback([target('restart-dead', dead), target('restart-live', live)]);
    await afterRestart.getResponse(req());
    assert.equal(deadCalls, 1, 'persisted auth-dead marker skipped the dead brain after restart');
    assert.equal(liveCalls, 2);
  } finally {
    reviveDeadBrains();
  }
});

test('sticky auth-dead: a transport timeout does NOT stick (transient failures stay per-request)', async () => {
  const { reviveDeadBrains, isBrainAuthDead } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    let flakyCalls = 0;
    const flaky = model({ getResponse: async () => { flakyCalls++; throw new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: 'hung' }); } });
    const live = model({ getResponse: async () => resp('rescued') });
    const fb = withModelFallback([target('flaky', flaky), target('live', live)]);
    await fb.getResponse(req());
    assert.equal(isBrainAuthDead('flaky'), false, 'a timeout never sticks');
    await fb.getResponse(req());
    assert.equal(flakyCalls, 2, 'the flaky brain is probed again next request');
  } finally {
    reviveDeadBrains();
  }
});

test('silent cooldown: repeated transport timeouts skip the quiet brain briefly', async () => {
  const { reviveDeadBrains, isBrainSilenced } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    let quietCalls = 0, liveCalls = 0;
    const quiet = model({ getResponse: async () => {
      quietCalls++;
      throw new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: 'hung' });
    } });
    const live = model({ getResponse: async () => { liveCalls++; return resp('from live'); } });
    const fb = withModelFallback([target('quiet-primary', quiet), target('quiet-live', live)]);

    await fb.getResponse(req());
    assert.equal(quietCalls, 1);
    assert.equal(liveCalls, 1);
    assert.equal(isBrainSilenced('quiet-primary'), false, 'one timeout is still treated as transient');

    await fb.getResponse(req());
    assert.equal(quietCalls, 2);
    assert.equal(liveCalls, 2);
    assert.equal(isBrainSilenced('quiet-primary'), true, 'the second timeout opens the short cooldown');
    assert.equal(__test__.getSilentBrainEntryForTests('quiet-primary')?.reason, 'model.transport_timeout');

    await fb.getResponse(req());
    assert.equal(quietCalls, 2, 'cooldown skipped the repeatedly silent brain');
    assert.equal(liveCalls, 3);
  } finally {
    reviveDeadBrains();
  }
});

test('silent cooldown: marker survives daemon restart and skips the quiet brain', async () => {
  const { reviveDeadBrains, isBrainSilenced } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    let quietCalls = 0, liveCalls = 0;
    const quiet = model({ getResponse: async () => {
      quietCalls++;
      throw new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: 'hung' });
    } });
    const live = model({ getResponse: async () => { liveCalls++; return resp('from live'); } });
    const fb = withModelFallback([target('restart-quiet', quiet), target('restart-live', live)]);

    await fb.getResponse(req());
    await fb.getResponse(req());
    assert.equal(quietCalls, 2);
    assert.equal(liveCalls, 2);
    assert.equal(isBrainSilenced('restart-quiet'), true);

    __test__.resetSilentBrainsMemoryForTests();
    const afterRestart = withModelFallback([target('restart-quiet', quiet), target('restart-live', live)]);
    await afterRestart.getResponse(req());
    assert.equal(quietCalls, 2, 'persisted silent marker skipped the quiet brain after restart');
    assert.equal(liveCalls, 3);
  } finally {
    reviveDeadBrains();
  }
});

test('silent cooldown: a successful retry clears prior silent-failure history', async () => {
  const { reviveDeadBrains, isBrainSilenced } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    let mode: 'timeout' | 'ok' = 'timeout';
    let primaryCalls = 0, liveCalls = 0;
    const primary = model({ getResponse: async () => {
      primaryCalls++;
      if (mode === 'timeout') {
        throw new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: 'hung' });
      }
      return resp('primary recovered');
    } });
    const live = model({ getResponse: async () => { liveCalls++; return resp('from live'); } });
    const fb = withModelFallback([target('recovering-primary', primary), target('recovering-live', live)]);

    await fb.getResponse(req());
    assert.equal(primaryCalls, 1);
    assert.equal(liveCalls, 1);
    assert.equal(isBrainSilenced('recovering-primary'), false);

    mode = 'ok';
    await fb.getResponse(req());
    assert.equal(primaryCalls, 2);
    assert.equal(liveCalls, 1);
    assert.equal(__test__.getSilentBrainEntryForTests('recovering-primary'), null, 'success cleared the prior failure count');

    mode = 'timeout';
    await fb.getResponse(req());
    assert.equal(primaryCalls, 3, 'the recovered brain is probed again');
    assert.equal(liveCalls, 2);
    assert.equal(isBrainSilenced('recovering-primary'), false, 'a fresh single timeout does not immediately silence it');
  } finally {
    reviveDeadBrains();
  }
});

test('silent cooldown: when EVERY brain is silenced, the full chain is still probed', async () => {
  const { reviveDeadBrains, isBrainSilenced } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    let aMode: 'timeout' | 'ok' = 'timeout';
    let aCalls = 0, bCalls = 0;
    const a = model({ getResponse: async () => {
      aCalls++;
      if (aMode === 'ok') return resp('a recovered');
      throw new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: 'a hung' });
    } });
    const b = model({ getResponse: async () => {
      bCalls++;
      throw new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: 'b hung' });
    } });
    const fb = withModelFallback([target('all-silent-a', a), target('all-silent-b', b)]);

    await assert.rejects(() => fb.getResponse(req()));
    await assert.rejects(() => fb.getResponse(req()));
    assert.equal(isBrainSilenced('all-silent-a'), true);
    assert.equal(isBrainSilenced('all-silent-b'), true);

    aMode = 'ok';
    const res = await fb.getResponse(req());
    assert.equal(aCalls, 3, 'the all-silenced chain still probed from the top');
    assert.equal(bCalls, 2);
    assert.ok(JSON.stringify(res).includes('a recovered'));
  } finally {
    reviveDeadBrains();
  }
});

test('sticky auth-dead: when EVERY brain is marked dead, the full chain is probed anyway (never zero brains)', async () => {
  const { reviveDeadBrains, markBrainAuthDead } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    markBrainAuthDead('a', 'model.auth_expired');
    markBrainAuthDead('b', 'model.auth_expired');
    let aCalls = 0;
    const a = model({ getResponse: async () => { aCalls++; return resp('a recovered'); } });
    const b = model({ getResponse: async () => resp('b') });
    const res = await withModelFallback([target('a', a), target('b', b)]).getResponse(req());
    assert.equal(aCalls, 1, 'an all-dead chain still probes (out-of-band re-auth recovers)');
    assert.ok(JSON.stringify(res).includes('a recovered'));
  } finally {
    reviveDeadBrains();
  }
});

test('sticky auth-dead: reviveDeadBrains() clears the mark (re-auth flow → immediate probe)', async () => {
  const { reviveDeadBrains, markBrainAuthDead, isBrainAuthDead } = await import('./fallback-model.js');
  reviveDeadBrains();
  markBrainAuthDead('gpt-5.5', 'model.auth_expired');
  assert.equal(isBrainAuthDead('gpt-5.5'), true);
  reviveDeadBrains('gpt-5.5');
  assert.equal(isBrainAuthDead('gpt-5.5'), false);
  markBrainAuthDead('x', 'model.auth_expired');
  markBrainAuthDead('y', 'model.auth_expired');
  reviveDeadBrains();
  assert.equal(isBrainAuthDead('x'), false);
  assert.equal(isBrainAuthDead('y'), false);
});

test('sticky auth-dead: the LAST brain failing with auth is marked too (next request routes around it)', async () => {
  const { reviveDeadBrains, isBrainAuthDead } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    const ok = model({ getResponse: async () => resp('primary ok') });
    const dead = model({ getResponse: async () => { throw new Error('HTTP 401 Unauthorized'); } });
    // Force the primary to fail with overload so the LAST brain (auth-dead) is hit and throws.
    const overloaded = model({ getResponse: async () => { throw overload(); } });
    const fb = withModelFallback([target('primary', overloaded), target('last-dead', dead)]);
    await assert.rejects(() => fb.getResponse(req()));
    assert.equal(isBrainAuthDead('last-dead'), true, 'the last brain auth failure stuck');
    void ok;
  } finally {
    reviveDeadBrains();
  }
});

test('rate-limit memo: a 429-marked brain is skipped on the NEXT call (no retry ladder tax)', async () => {
  const { clearRateLimitedBrainsForTest, isBrainRateLimited } = await import('./fallback-model.js');
  clearRateLimitedBrainsForTest();
  try {
    let limitedCalls = 0;
    let healthyCalls = 0;
    const limited = model({ getStreamedResponse: async function* () { limitedCalls++; throw rateLimited(); } });
    const healthy = model({ getStreamedResponse: async function* () { healthyCalls++; yield { type: 'output_text_delta', delta: 'ok' } as any; } });
    const chain = withModelFallback([target('kimi', limited), target('codex', healthy)], { falloverOn429: true });

    // Call 1: kimi 429s, falls over, and gets memo'd.
    await collect(chain.getStreamedResponse(req()));
    assert.equal(limitedCalls, 1);
    assert.equal(healthyCalls, 1);
    assert.equal(isBrainRateLimited('kimi'), true, 'the 429 brain is in its cooldown window');

    // Call 2: kimi is skipped entirely — straight to the healthy brain.
    await collect(chain.getStreamedResponse(req()));
    assert.equal(limitedCalls, 1, 'no second attempt against the known-limited brain');
    assert.equal(healthyCalls, 2);
  } finally {
    clearRateLimitedBrainsForTest();
  }
});

test('L2 (v2.3.0): an OVERLOADED brain joins the cooldown memo — the 529-storm class', async () => {
  const { markBrainRateLimited, isBrainRateLimited } = await import('./fallback-model.js');
  const { BoundaryError } = await import('../boundary-error.js');
  const overloaded = BoundaryError.from(new Error('529 overloaded'), { kind: 'model.overloaded', retryable: true, userMessage: 'x' });
  markBrainRateLimited('claude-storm-test', overloaded);
  assert.equal(isBrainRateLimited('claude-storm-test'), true, 'overloaded benches like a rate limit');
  // Non-transient kinds never bench via this memo.
  const parseErr = BoundaryError.from(new Error('bad json'), { kind: 'model.invalid_output', retryable: false, userMessage: 'x' });
  markBrainRateLimited('claude-clean-test', parseErr);
  assert.equal(isBrainRateLimited('claude-clean-test'), false);
});
