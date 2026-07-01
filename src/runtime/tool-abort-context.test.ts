/**
 * Run: npx tsx --test src/runtime/tool-abort-context.test.ts
 *
 * The per-tool-call abort signal must be visible to `currentToolAbortSignal()`
 * across every await boundary reached from inside `runWithToolAbortSignal`, and
 * must be absent outside it (fail-open for tests / out-of-band calls).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithToolAbortSignal, currentToolAbortSignal } from './tool-abort-context.js';

test('currentToolAbortSignal is undefined outside a wrapped invocation', () => {
  assert.equal(currentToolAbortSignal(), undefined);
});

test('the signal is visible synchronously and across await boundaries', async () => {
  const ac = new AbortController();
  await runWithToolAbortSignal(ac.signal, async () => {
    assert.equal(currentToolAbortSignal(), ac.signal, 'visible synchronously');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(currentToolAbortSignal(), ac.signal, 'still visible after a timer await');
    await Promise.resolve();
    assert.equal(currentToolAbortSignal(), ac.signal, 'still visible after a microtask');
  });
});

test('abort() on the outer controller is observable through the ALS signal', async () => {
  const ac = new AbortController();
  await runWithToolAbortSignal(ac.signal, async () => {
    const seen = currentToolAbortSignal();
    assert.ok(seen);
    assert.equal(seen!.aborted, false);
    ac.abort(new Error('timed out'));
    assert.equal(seen!.aborted, true, 'the same signal instance reflects the abort');
  });
});

test('the context does not leak out after the callback settles', async () => {
  const ac = new AbortController();
  await runWithToolAbortSignal(ac.signal, async () => {
    await new Promise((r) => setTimeout(r, 1));
  });
  assert.equal(currentToolAbortSignal(), undefined, 'no leak once the invocation ends');
});

test('nested invocations restore the outer signal on unwind', async () => {
  const outer = new AbortController();
  const inner = new AbortController();
  await runWithToolAbortSignal(outer.signal, async () => {
    assert.equal(currentToolAbortSignal(), outer.signal);
    await runWithToolAbortSignal(inner.signal, async () => {
      assert.equal(currentToolAbortSignal(), inner.signal);
    });
    assert.equal(currentToolAbortSignal(), outer.signal, 'outer signal restored');
  });
});
