import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-worker-response-identity-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const log = await import('./harness/eventlog.js');
const { harnessRunContextStorage } = await import('./harness/brackets.js');
const metrics = await import('./model-route-metrics.js');
const { withRawClaudeUsageRecording } = await import('./harness/claude-model.js');
const usageLog = await import('./usage-log.js');

after(() => {
  metrics.closeModelRouteMetricsDb();
  log.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});

type CallPath = 'getResponse' | 'getStreamedResponse';
const paths: CallPath[] = ['getResponse', 'getStreamedResponse'];
const hash = (id: string) => createHash('sha256').update(id, 'utf8').digest('hex');
const request = { input: 'private synthetic request', tools: [], handoffs: [], modelSettings: {} } as unknown as ModelRequest;
let serial = 0;
function scope() {
  const session = log.createSession({ id: `worker-response-identity-${++serial}`, kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Verify the supplied synthetic record.' } });
  const attempt = log.beginRunAttempt(session.id);
  log.bindRunAttemptSourceUserEvent(attempt, source.seq);
  return { sessionId: session.id, sourceUserSeq: source.seq, runAttemptId: attempt.attemptId, turn: 1, workerScope: true };
}
function response(id: unknown, callPath: CallPath): ModelResponse {
  return { [callPath === 'getResponse' ? 'responseId' : 'id']: id,
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'synthetic result' }] }],
    usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    providerData: { model: 'served-worker-fixture', responseId: 'untrusted-provider-metadata-id' },
  } as unknown as ModelResponse;
}
function instrument(model: Model, recordUsage = false): Model {
  return metrics.withModelRouteMetrics(recordUsage
    ? withRawClaudeUsageRecording(model, 'claude-worker-fixture', usageLog.recordModelUsage, () => {}, () => {}) : model,
  { role: 'worker', requestedModel: 'requested-worker-fixture', resolvedModel: 'routed-worker-fixture', provider: 'claude', source: 'explicit' });
}
async function call(model: Model, callPath: CallPath, active: ReturnType<typeof scope>, req = request): Promise<unknown> {
  return harnessRunContextStorage.run(active as never, async () => {
    if (callPath === 'getResponse') return model.getResponse(req);
    const events: StreamEvent[] = [];
    for await (const event of model.getStreamedResponse(req)) events.push(event);
    return events;
  });
}
function completed(active: ReturnType<typeof scope>) {
  return log.listEvents(active.sessionId, { types: ['worker_model_response_completed'], limit: 20 });
}
function outcome(decisionId: string) {
  const row = metrics.openModelRouteMetricsDb().prepare('SELECT * FROM model_route_outcomes WHERE decision_id = ?')
    .get(decisionId) as { status: string; input_tokens: number; output_tokens: number; total_tokens: number; metadata_json: string };
  assert.ok(row);
  return { ...row, metadata: JSON.parse(row.metadata_json) as Record<string, unknown> };
}
function latestOutcome(active: ReturnType<typeof scope>) {
  const row = metrics.openModelRouteMetricsDb().prepare('SELECT id FROM model_route_decisions WHERE session_id = ?')
    .get(active.sessionId) as { id: string };
  assert.ok(row);
  return outcome(row.id);
}
function body(completion: ModelResponse, done?: StreamEvent): Model {
  return { async getResponse() { return completion; },
    async *getStreamedResponse() { yield done ?? { type: 'response_done', response: completion } as never; } };
}

for (const callPath of paths) {
  test(`${callPath}: exact completed response digest joins the real source-bound usage record`, async () => {
    const active = scope();
    const id = `provider-opaque-café-${active.sessionId}`;
    const completion = response(id, callPath);
    const result = await call(instrument(body(completion), true), callPath, active);
    if (callPath === 'getResponse') assert.equal(result, completion, 'instrumentation preserves the returned response');
    else assert.match(JSON.stringify(result), /synthetic result/);
    const rows = completed(active);
    assert.equal(rows.length, 1);
    const event = rows[0]!;
    assert.equal(event.data.sourceUserSeq, active.sourceUserSeq);
    assert.equal(event.data.runAttemptId, active.runAttemptId);
    assert.match(String(event.data.modelCallId), /^[0-9a-f-]{36}$/);
    assert.equal(event.data.providerResponseIdDigest, hash(id));
    assert.equal(event.data.model, 'served-worker-fixture');
    assert.equal(event.data.provider, 'claude');
    assert.equal(event.data.fallover, false);
    const recorded = outcome(String(event.data.modelCallId));
    assert.equal(recorded.status, 'success');
    assert.equal(recorded.metadata.providerResponseIdDigest, hash(id));
    assert.deepEqual([recorded.input_tokens, recorded.output_tokens, recorded.total_tokens], [12, 5, 17]);
    assert.ok(!JSON.stringify(event.data).includes(id));
    assert.ok(!recorded.metadata_json.includes(id));
    assert.ok(!recorded.metadata_json.includes('untrusted-provider-metadata-id'));
    const usage = usageLog.readUsageEventsForDate().filter(row => row.source === active.sessionId);
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.trace?.acceptedSource, usageLog.acceptedSourceIdentity(active.sessionId, active.sourceUserSeq));
    assert.equal(usage[0]!.trace?.attemptId, active.runAttemptId);
    assert.equal(usage[0]!.trace?.modelCallId, id);
    assert.equal(hash(String(usage[0]!.trace?.modelCallId)), event.data.providerResponseIdDigest);
  });

  for (const [name, id] of [['missing', undefined], ['empty', ''], ['whitespace', ' \n '], ['number', 42],
    ['object', { id: 'nested-id' }], ['over-bound', 'x'.repeat(1_025)], ['utf8-over-bound', 'é'.repeat(513)],
    ['malformed-utf8', '\uD800opaque']] as const) {
    test(`${callPath}: ${name} identity stays absent without changing completed-route evidence`, async () => {
      const active = scope();
      const result = await call(instrument(body(response(id, callPath))), callPath, active);
      assert.ok(result);
      const event = completed(active)[0]!;
      assert.ok(event);
      assert.equal(Object.hasOwn(event.data, 'providerResponseIdDigest'), false);
      const recorded = outcome(String(event.data.modelCallId));
      assert.equal(Object.hasOwn(recorded.metadata, 'providerResponseIdDigest'), false);
      assert.equal(recorded.status, 'success');
      assert.equal(recorded.total_tokens, 17);
    });
  }

  test(`${callPath}: the complete identity at the UTF-8 byte bound is hashed without truncation`, async () => {
    const active = scope();
    const id = 'é'.repeat(512);
    await call(instrument(body(response(id, callPath))), callPath, active);
    assert.equal(completed(active)[0]!.data.providerResponseIdDigest, hash(id));
  });

  test(`${callPath}: a malformed identity accessor cannot break model output or completion evidence`, async () => {
    const active = scope();
    const completion = response(undefined, callPath);
    Object.defineProperty(completion, callPath === 'getResponse' ? 'responseId' : 'id', { get() { throw new Error('malformed identifier'); } });
    await call(instrument(body(completion)), callPath, active);
    assert.equal(completed(active).length, 1);
    assert.equal(Object.hasOwn(completed(active)[0]!.data, 'providerResponseIdDigest'), false);
  });
}

test('getResponse: a late completed response after cancellation keeps its observed identity, output and usage', async () => {
  const active = scope();
  const controller = new AbortController();
  const completion = response('late-completed-id', 'getResponse');
  const model = instrument({ ...body(completion), async getResponse() { controller.abort(); return completion; } });
  assert.equal(await call(model, 'getResponse', active, { ...request, signal: controller.signal }), completion);
  assert.equal(completed(active)[0]!.data.providerResponseIdDigest, hash('late-completed-id'));
  assert.equal(latestOutcome(active).status, 'success', 'observability preserves existing route status semantics');
  assert.equal(latestOutcome(active).total_tokens, 17);
});

test('stream: early return before completion cannot infer identity from a start event or its metadata', async () => {
  const active = scope();
  let returned = 0;
  const model = instrument({ async getResponse() { throw new Error('unused'); }, async *getStreamedResponse() {
    try { yield { type: 'response_started', providerData: { responseId: 'start-only-id' } } as never;
      yield { type: 'response_done', response: response('never-observed-id', 'getStreamedResponse') } as never;
    } finally { returned++; }
  } });
  await harnessRunContextStorage.run(active as never, async () => {
    const iterator = model.getStreamedResponse(request)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
  });
  assert.equal(returned, 1);
  assert.equal(completed(active).length, 0);
  const recorded = latestOutcome(active);
  assert.equal(recorded.status, 'cancelled');
  assert.equal(Object.hasOwn(recorded.metadata, 'providerResponseIdDigest'), false);
});

test('stream: cancellation after an observed completion retains its digest in the outcome without adding a success event', async () => {
  const active = scope();
  const completion = response('observed-before-close', 'getStreamedResponse');
  const done = { type: 'response_done', response: completion } as unknown as StreamEvent;
  await harnessRunContextStorage.run(active as never, async () => {
    const iterator = instrument(body(completion, done)).getStreamedResponse(request)[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value, done, 'the original stream event is preserved');
    await iterator.return?.();
  });
  assert.equal(completed(active).length, 0, 'existing drained-success requirement remains unchanged');
  const recorded = latestOutcome(active);
  assert.equal(recorded.status, 'cancelled');
  assert.equal(recorded.metadata.providerResponseIdDigest, hash('observed-before-close'));
  assert.equal(recorded.total_tokens, 17);
});

test('stream: a later completion with no ID cannot inherit an earlier response identity', async () => {
  const active = scope();
  const model = instrument({ ...body(response(undefined, 'getResponse')), async *getStreamedResponse() {
    yield { type: 'response_done', response: response('earlier-id', 'getStreamedResponse') } as never;
    yield { type: 'response_done', response: response(undefined, 'getStreamedResponse') } as never;
  } });
  await call(model, 'getStreamedResponse', active);
  assert.equal(completed(active).length, 1);
  assert.equal(Object.hasOwn(completed(active)[0]!.data, 'providerResponseIdDigest'), false);
});
