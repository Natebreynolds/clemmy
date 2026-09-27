/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/usage-observer.test.ts
 *
 * A background job (memory work) reads back the model calls it made: which
 * model served, the tokens, the time. The innermost observer owns a call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { recordModelUsage, withModelUsageAttribution, withModelUsageObserver } = await import('./usage-log.js');

function call(model: string, inputTokens = 100, outputTokens = 10) {
  recordModelUsage({ sessionId: 'unknown', model, inputTokens, outputTokens, durationMs: 42 });
}

test('an observer collects the calls made inside it, with channel and role from the scope', async () => {
  const sink: import('./usage-log.js').ObservedModelUsage[] = [];
  await withModelUsageObserver(sink, () => withModelUsageAttribution(
    { sessionId: 'unknown', sourceUserSeq: 0, channel: 'memory:learn' },
    async () => { call('model-a', 120, 12); },
  ));
  assert.equal(sink.length, 1);
  assert.equal(sink[0].model, 'model-a');
  assert.equal(sink[0].inputTokens, 120);
  assert.equal(sink[0].outputTokens, 12);
  assert.equal(sink[0].durationMs, 42);
  assert.equal(sink[0].ok, true);
  assert.equal(sink[0].channel, 'memory:learn');
});

test('the innermost observer owns a call, so nothing is counted twice', async () => {
  const outer: import('./usage-log.js').ObservedModelUsage[] = [];
  const inner: import('./usage-log.js').ObservedModelUsage[] = [];
  await withModelUsageObserver(outer, async () => {
    call('outer-model');
    await withModelUsageObserver(inner, async () => { call('inner-model'); });
  });
  assert.deepEqual(outer.map((c) => c.model), ['outer-model']);
  assert.deepEqual(inner.map((c) => c.model), ['inner-model']);
});

test('calls made before a job throws stay in the caller-owned sink', async () => {
  const sink: import('./usage-log.js').ObservedModelUsage[] = [];
  await assert.rejects(withModelUsageObserver(sink, async () => {
    call('served-then-failed');
    throw new Error('parse failed');
  }));
  assert.equal(sink.length, 1);
});

test('no observer, no cost: recording outside a job still works', () => {
  call('plain');
});
