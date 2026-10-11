import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { bindCompletedModelResponse, completedModelResponseBinding } from './model-response-binding.js';
import { withResilience, withModelResilienceTelemetry, type ResilienceTelemetryEvent } from './resilient-model.js';
import { resolveModelCapability } from './model-wire-registry.js';
import { withRawClaudeUsageRecording } from './claude-model.js';
import { harnessRunContextStorage } from './brackets.js';
import { createModelResilienceObservation } from './model-resilience-observation.js';

const request = { input: 'controlled fixture', modelSettings: {}, tools: [], handoffs: [] } as never;
const policy = { label: 'claude', capability: resolveModelCapability('claude-opus-5'), sleep: async () => {} };
const response = (id: string, output = true) => ({ responseId: id,
  output: output ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'controlled answer' }] }] : [],
  usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 }, providerData: { model: 'claude-opus-5-wire' } });
const digest = (id: string) => createHash('sha256').update(id).digest('hex');

test('a binding stays on its exact response object, rejects mutations and never transfers to clones', () => {
  const value = response('msg_exact');
  const binding = bindCompletedModelResponse(value, 'host-call-1', 1)!;
  assert.equal(binding.providerResponseIdDigest, digest('msg_exact'));
  assert.ok(Object.isFrozen(binding));
  assert.equal(completedModelResponseBinding(value), binding);
  assert.equal(completedModelResponseBinding({ ...value }), undefined);
  value.responseId = 'msg_changed';
  assert.equal(completedModelResponseBinding(value), undefined);
  assert.equal(bindCompletedModelResponse(value, 'host-call-2', 1), undefined);
  assert.equal(bindCompletedModelResponse(value, 'host-call-3', 1), undefined, 'ambiguous reuse stays permanently unbound');
});

test('absent, conflicting or content-shaped provider identity cannot mint a binding', () => {
  for (const value of [{}, { responseId: 'https://private.invalid/capability' }, { responseId: 'msg_x', id: 'msg_y' },
    { responseId: 'private\ncontent' }]) assert.equal(bindCompletedModelResponse(value, 'host-1', 1), undefined);
  const throwing = { get responseId() { throw new Error('private getter'); } };
  assert.equal(bindCompletedModelResponse(throwing, 'host-1', 1), undefined);
  assert.equal(completedModelResponseBinding(throwing), undefined);
});

for (const path of ['buffered', 'streamed'] as const) test(`${path} raw Claude response binds host call and usage once without changing token arithmetic`, async () => {
  const rows: Record<string, any>[] = [];
  const observations: Record<string, any>[] = [];
  const wire = response(`msg_${path}`);
  const streamed = { ...wire, id: wire.responseId };
  const inner = { async getResponse() { return wire as never; }, async *getStreamedResponse() {
    yield { type: 'response_done', response: streamed } as never;
  } };
  const model = withRawClaudeUsageRecording(withResilience(inner, policy), 'claude-opus-5',
    row => rows.push(row), () => {}, () => {});
  const owner = { sessionId: 'binding-fixture', sourceUserSeq: 42, runAttemptId: 'attempt:binding', turn: 1 };
  const observation = createModelResilienceObservation({ owner, requestOrdinal: () => 1, retired: () => false,
    record: row => observations.push(row) });
  await harnessRunContextStorage.run(owner as never, () => withModelResilienceTelemetry(observation.observer, async () => {
    if (path === 'buffered') assert.equal(await model.getResponse(request), wire);
    else for await (const _ of model.getStreamedResponse(request)) { /* observe */ }
  }));
  observation.close('returned');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inputTokens, 100); assert.equal(rows[0].outputTokens, 5);
  assert.equal(rows[0].responseId, wire.responseId);
  const observed = observations.find(row => row.phase === 'response_observed')!;
  assert.equal(observed.providerResponseIdDigest, digest(wire.responseId));
  assert.equal(observed.callId, rows[0].trace.modelCallId);
  assert.equal(observed.attempt, 1);
  assert.ok(observations.every(row => row.sourceUserSeq === 42 && row.runAttemptId === 'attempt:binding'));
  assert.equal(rows[0].providerReportedModel, 'claude-opus-5-wire');
  assert.equal(rows[0].account, undefined); assert.equal(rows[0].backendId, undefined);
  assert.doesNotMatch(JSON.stringify(observations), /controlled answer|msg_buffered|msg_streamed/);
});

test('retry responses retain separate physical ordinals but do not manufacture usage for an unrecorded retry', async () => {
  let calls = 0;
  const rows: Record<string, any>[] = [];
  const events: ResilienceTelemetryEvent[] = [];
  const model = withRawClaudeUsageRecording(withResilience({ async getResponse() {
    return response(`msg_retry_${++calls}`, calls > 1) as never;
  }, async *getStreamedResponse() {} }, policy), 'claude-opus-5', row => rows.push(row), () => {}, () => {});
  await withModelResilienceTelemetry(event => events.push(event), () => model.getResponse(request));
  const observed = events.filter(event => event.type === 'response_observed');
  assert.deepEqual(observed.map(event => event.attempt), [1, 2]);
  assert.equal(rows.length, 1, 'existing outer-wrapper accounting is unchanged');
  assert.equal(rows[0].responseId, 'msg_retry_2');
  assert.equal(rows[0].trace.modelCallId, observed[1]?.callId);
  assert.equal(events.find(event => event.type === 'call_finished')?.failedAttemptCount, 1);
});

test('late completed response after abort keeps its exact usage binding and remains cancelled', async () => {
  const controller = new AbortController();
  const rows: Record<string, any>[] = [];
  const events: ResilienceTelemetryEvent[] = [];
  const model = withRawClaudeUsageRecording(withResilience({ async getResponse() {
    controller.abort(); return response('msg_late') as never;
  }, async *getStreamedResponse() {} }, policy), 'claude-opus-5', row => rows.push(row), () => {}, () => {});
  await withModelResilienceTelemetry(event => events.push(event), () => model.getResponse({ signal: controller.signal } as never));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trace.modelCallId, events.find(event => event.type === 'response_observed')?.callId);
  assert.equal(events.find(event => event.type === 'call_finished')?.outcome, 'cancelled');
});

test('abort before a completed response records no invented response or usage', async () => {
  const rows: Record<string, any>[] = [];
  const events: ResilienceTelemetryEvent[] = [];
  const controller = new AbortController();
  const model = withRawClaudeUsageRecording(withResilience({ async getResponse() {
    controller.abort(); throw new Error('controlled interruption');
  }, async *getStreamedResponse() {} }, policy), 'claude-opus-5', row => rows.push(row), () => {}, () => {});
  await assert.rejects(withModelResilienceTelemetry(event => events.push(event), () => model.getResponse({ signal: controller.signal } as never)));
  assert.equal(rows.length, 0);
  assert.equal(events.some(event => event.type === 'response_observed'), false);
  assert.equal(events.find(event => event.type === 'call_finished')?.outcome, 'cancelled');
});
