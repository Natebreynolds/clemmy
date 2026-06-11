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
    (err: unknown) => err instanceof Error && /stalled/.test(err.message) && isTransientStepError(err),
  );
  assert.ok(Date.now() - started < 5_000, 'aborts promptly, not after minutes');
});

test('a stream wedging mid-flight (after events) is also aborted', async () => {
  const result = makeStreamResult({ events: 3, gapMs: 30, hang: true });
  await assert.rejects(
    __defaultRunRunner(runnerFor(result), {} as never, [], {} as never),
    /stalled/,
  );
});

test('steady events keep the turn alive even when each gap is near the threshold', async () => {
  // 6 events at 200ms gaps with a 300ms stall threshold: total 1.2s > threshold,
  // but the timer resets per event — must complete, not stall.
  const result = makeStreamResult({ events: 6, gapMs: 200 });
  const out = await __defaultRunRunner(runnerFor(result), {} as never, [], {} as never);
  assert.deepEqual(out.finalOutput, { ok: true });
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
