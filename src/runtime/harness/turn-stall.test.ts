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
