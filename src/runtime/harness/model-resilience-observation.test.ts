import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelResilienceObservation } from './model-resilience-observation.js';
import { withModelResilienceTelemetry, withResilience, type ResilienceTelemetryEvent } from './resilient-model.js';
import { resolveModelCapability } from './model-wire-registry.js';
import type { ModelRequest } from '@openai/agents-core';

test('one successful logical response retains the failed physical attempt and backoff under its exact source', async () => {
  let clock = 100;
  let calls = 0;
  const rows: Record<string, unknown>[] = [];
  const observation = createModelResilienceObservation({
    owner: { sessionId: 'fixture', sourceUserSeq: 42, runAttemptId: 'attempt:fixture' },
    requestOrdinal: () => 3, retired: () => false, now: () => clock,
    record: (data) => rows.push(data),
  });
  const response = { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'correct' }] }], usage: {} };
  const model = withResilience({ async getResponse() {
    calls++;
    clock += calls === 1 ? 28_000 : 2_000;
    if (calls === 1) throw new Error('socket timeout');
    return response as never;
  }, async *getStreamedResponse() { throw new Error('unused'); } }, {
    label: 'byo', capability: resolveModelCapability('deepseek-reasoner'),
    now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  const result = await withModelResilienceTelemetry(observation.observer, () =>
    model.getResponse({ input: 'fixture', modelSettings: {}, tools: [], handoffs: [] } as unknown as ModelRequest));
  observation.close('returned');
  assert.equal(result, response);
  assert.equal(calls, 2);
  assert.ok(rows.every(row => row.sourceUserSeq === 42 && row.requestOrdinal === 3 && row.runAttemptId === 'attempt:fixture'));
  const total = rows.find(row => row.phase === 'call_finished')!;
  assert.equal(total.failedAttemptMs, 28_000);
  assert.equal(total.attemptMs, 30_000);
  assert.equal(total.failedAttemptCount, 1);
  assert.equal(total.durationMs, 30_000 + Number(total.retryWaitMs));
  assert.equal(rows.at(-1)?.phase, 'host_step_finished');
  assert.equal(rows.at(-1)?.durationMs, total.durationMs);
  assert.equal(rows.some(row => 'inputTokens' in row || 'cost' in row || 'modelId' in row || 'accountId' in row), false);
});

test('late retry observations keep their original owner but cannot claim active progress after closure', () => {
  const rows: Record<string, unknown>[] = [];
  let retired = false;
  const observation = createModelResilienceObservation({
    owner: { sessionId: 'original', sourceUserSeq: 7 }, requestOrdinal: () => undefined,
    retired: () => retired, record: data => rows.push(data), now: () => 10,
  });
  const retry = { type: 'retry_scheduled', callId: 'call', label: 'byo', path: 'getResponse',
    at: 10, elapsedMs: 0, maxRetries: 3, afterAttempt: 1, nextAttempt: 2,
    reason: 'transient_failure', failureKind: 'model.transport_timeout', plannedBackoffMs: 750 } as ResilienceTelemetryEvent;
  observation.observer(retry);
  retired = true;
  observation.close('cancelled');
  observation.observer({ ...retry, secret: 'never-record-this', error: 'private URL' } as ResilienceTelemetryEvent);
  observation.close('cancelled');
  assert.deepEqual(rows.map(row => row.retired), [false, true, true]);
  assert.equal(rows.filter(row => row.phase === 'host_step_finished').length, 1);
  assert.ok(rows.every(row => row.sourceUserSeq === 7 && !('requestOrdinal' in row)));
  assert.doesNotMatch(JSON.stringify(rows), /never-record-this|private URL/);
});

test('failed observation sinks cannot change model return or replay an effect', async () => {
  const observation = createModelResilienceObservation({
    owner: { sessionId: 'fixture', sourceUserSeq: 9 }, requestOrdinal: () => 1,
    retired: () => false, record: () => { throw new Error('journal unavailable'); },
  });
  let calls = 0;
  const model = withResilience({ async getResponse() {
    calls++; return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'result' }] }], usage: {} } as never;
  }, async *getStreamedResponse() { throw new Error('unused'); } }, {
    label: 'byo', capability: resolveModelCapability('deepseek-reasoner'),
  });
  const response = await withModelResilienceTelemetry(observation.observer, () =>
    model.getResponse({ input: 'fixture', modelSettings: {}, tools: [], handoffs: [] } as unknown as ModelRequest));
  observation.close('returned');
  assert.ok(response);
  assert.equal(calls, 1);
});

test('an aborted physical request retires only its observations while the same logical step can be rescued', () => {
  const rows: Record<string, unknown>[] = [];
  const observation = createModelResilienceObservation({
    owner: { sessionId: 'rescue', sourceUserSeq: 8 }, requestOrdinal: () => 4,
    retired: () => false, record: data => rows.push(data), now: () => 10,
  });
  const retry = { type: 'retry_scheduled', callId: 'old-call', label: 'byo', path: 'getResponse',
    at: 10, elapsedMs: 0, maxRetries: 3, afterAttempt: 1, nextAttempt: 2,
    reason: 'empty_completion', failureKind: 'model.empty_completion', plannedBackoffMs: 750,
    requestAborted: true } as ResilienceTelemetryEvent;
  observation.observer(retry);
  observation.observer({ ...retry, callId: 'rescue-call', requestAborted: false });
  observation.close('returned');
  assert.deepEqual(rows.map(row => row.retired), [true, false, false]);
  assert.equal(rows[0]?.requestAborted, true);
  assert.equal(rows[1]?.requestAborted, false);
  assert.ok(rows.every(row => row.sourceUserSeq === 8 && row.requestOrdinal === 4));
});
