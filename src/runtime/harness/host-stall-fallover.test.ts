/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-stall-fallover.test.ts
 *
 * The harness must not kill its own fallover.
 *
 * The host stall watchdog retires a silent attempt by aborting the same
 * AbortController whose signal rides the model request. Inside the fallback
 * boundary that abort read as the USER pressing stop, so the `!callerAborted`
 * guard barred the brain switch, and every later attempt inherited the dead
 * signal at birth. Live 2026-09-02: an 11m37s silent turn with two healthy
 * brains in the chain, no fallover, no log, a harness-authored reply.
 *
 * Pinned here: a harness deadline abort switches brains; a user abort does
 * not; the rescue is not born aborted; the user's own cancel still reaches the
 * rescue; the stalled brain is demoted for the rest of the run.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelRequest } from '@openai/agents-core';
import { withModelFallback, __test__, type FallbackTarget } from './fallback-model.js';
import { ModelStreamStalledError } from './model-stall-policy.js';
import { ToolCallsCounter, withHarnessRunContext, type HarnessRunContext } from './brackets.js';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-host-stall-fallover-'));
__test__.setDeadBrainsFileForTests(path.join(TMP, 'brain-auth-dead.json'));
__test__.setSilentBrainsFileForTests(path.join(TMP, 'brain-silent-cooldown.json'));

after(() => {
  __test__.setDeadBrainsFileForTests(null);
  __test__.setSilentBrainsFileForTests(null);
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(async () => {
  const { clearRateLimitedBrainsForTest, reviveDeadBrains } = await import('./fallback-model.js');
  clearRateLimitedBrainsForTest();
  reviveDeadBrains();
});

function req(signal?: AbortSignal): ModelRequest {
  return { input: 'hi', modelSettings: {}, tools: [], handoffs: [], ...(signal ? { signal } : {}) } as unknown as ModelRequest;
}
const DONE = { type: 'response_done', response: { output: [{ type: 'message', content: 'rescued' }], usage: {} } };

/** Waits for its request signal and throws the abort reason, like a hung provider. */
function hangingUntilAbort(seen: { aborts: unknown[] }): Model {
  const waitForAbort = (request: ModelRequest): Promise<never> => new Promise((_, reject) => {
    const signal = (request as { signal?: AbortSignal }).signal;
    if (!signal) return;
    const onAbort = (): void => {
      seen.aborts.push(signal.reason);
      reject(signal.reason ?? new Error('aborted'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    getResponse: async (request: ModelRequest) => waitForAbort(request),
    getStreamedResponse: async function* (request: ModelRequest) {
      await waitForAbort(request);
      yield DONE;
    },
  } as unknown as Model;
}

function answering(log: { entries: Array<{ abortedAtEntry: boolean }> }): Model {
  return {
    getResponse: async () => ({ output: DONE.response.output, usage: {} }),
    getStreamedResponse: async function* (request: ModelRequest) {
      log.entries.push({ abortedAtEntry: (request as { signal?: AbortSignal }).signal?.aborted === true });
      yield DONE;
    },
  } as unknown as Model;
}

async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of it) out.push(event);
  return out;
}

const stall = (): ModelStreamStalledError => new ModelStreamStalledError(600, true, false);

test('a harness stall abort switches brains, and the rescue is not born aborted', async () => {
  const seen = { aborts: [] as unknown[] };
  const rescue = { entries: [] as Array<{ abortedAtEntry: boolean }> };
  const chain: FallbackTarget[] = [
    { label: 'stalled', getModel: () => hangingUntilAbort(seen) },
    { label: 'rescue', getModel: () => answering(rescue) },
  ];
  const controller = new AbortController();
  const out = collect(withModelFallback(chain).getStreamedResponse(req(controller.signal)));
  setTimeout(() => controller.abort(stall()), 20);
  const events = await out;
  assert.equal(seen.aborts.length, 1, 'the stalled attempt was released');
  assert.ok(seen.aborts[0] instanceof ModelStreamStalledError, 'released with the typed deadline reason');
  assert.equal(rescue.entries.length, 1, 'the next brain took the step');
  assert.equal(rescue.entries[0]!.abortedAtEntry, false, 'the rescue did not inherit the retired signal');
  assert.ok(events.length > 0, 'the step completed on the rescue');
});

test('a user abort does not switch brains', async () => {
  const seen = { aborts: [] as unknown[] };
  const rescue = { entries: [] as Array<{ abortedAtEntry: boolean }> };
  const chain: FallbackTarget[] = [
    { label: 'stalled', getModel: () => hangingUntilAbort(seen) },
    { label: 'rescue', getModel: () => answering(rescue) },
  ];
  const controller = new AbortController();
  const out = collect(withModelFallback(chain).getStreamedResponse(req(controller.signal)));
  setTimeout(() => controller.abort(new Error('user stop')), 20);
  await assert.rejects(out);
  assert.equal(rescue.entries.length, 0, 'a person\'s stop is honored — no rescue brain');
});

test('the user\'s own cancel still reaches a rescue started after a stall abort', async () => {
  const seen = { aborts: [] as unknown[] };
  const rescueSeen = { aborts: [] as unknown[] };
  const chain: FallbackTarget[] = [
    { label: 'stalled', getModel: () => hangingUntilAbort(seen) },
    { label: 'rescue', getModel: () => hangingUntilAbort(rescueSeen) },
  ];
  const controller = new AbortController();
  const cancelAuthority = new AbortController();
  const context = {
    sessionId: 'host-stall-fallover',
    counter: new ToolCallsCounter(10),
    callerCancelSignal: cancelAuthority.signal,
  } as unknown as HarnessRunContext;
  const run = withHarnessRunContext(
    context,
    () => collect(withModelFallback(chain).getStreamedResponse(req(controller.signal))),
  ) as Promise<unknown[]>;
  setTimeout(() => controller.abort(stall()), 20);
  setTimeout(() => cancelAuthority.abort(new Error('user stop')), 80);
  await assert.rejects(run);
  assert.equal(seen.aborts.length, 1, 'the stalled attempt was retired');
  assert.equal(rescueSeen.aborts.length, 1, 'the rescue observed the user cancel');
  assert.match(String((rescueSeen.aborts[0] as Error)?.message ?? ''), /user stop/);
});

test('a stall-aborted brain is remembered as run-silenced so later steps prefer the rescue', async () => {
  const seen = { aborts: [] as unknown[] };
  const rescue = { entries: [] as Array<{ abortedAtEntry: boolean }> };
  const runSilencedLabels = new Set<string>();
  const chain: FallbackTarget[] = [
    { label: 'stalled', getModel: () => hangingUntilAbort(seen) },
    { label: 'rescue', getModel: () => answering(rescue) },
  ];
  const controller = new AbortController();
  const out = collect(withModelFallback(chain, { runSilencedLabels }).getStreamedResponse(req(controller.signal)));
  setTimeout(() => controller.abort(stall()), 20);
  await out;
  assert.ok(runSilencedLabels.has('stalled'), 'demoted for the rest of the run');
  assert.equal(runSilencedLabels.has('rescue'), false);
});

test('the fallback boundary stamps the switch so the host watchdog can grant a rescue its grace', async () => {
  const seen = { aborts: [] as unknown[] };
  const rescue = { entries: [] as Array<{ abortedAtEntry: boolean }> };
  const chain: FallbackTarget[] = [
    { label: 'stalled', getModel: () => hangingUntilAbort(seen) },
    { label: 'rescue', getModel: () => answering(rescue) },
  ];
  const controller = new AbortController();
  const context = {
    sessionId: 'host-stall-fallover-stamp',
    counter: new ToolCallsCounter(10),
    modelFalloverInFlightAt: 0,
  } as unknown as HarnessRunContext;
  const run = withHarnessRunContext(
    context,
    () => collect(withModelFallback(chain).getStreamedResponse(req(controller.signal))),
  ) as Promise<unknown[]>;
  const before = Date.now();
  setTimeout(() => controller.abort(stall()), 20);
  await run;
  assert.ok((context.modelFalloverInFlightAt ?? 0) >= before, 'the switch was stamped on the run context');
});
