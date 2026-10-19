import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ModelRequest } from '@openai/agents-core';
import { createStandaloneModelAccountingJob, standaloneModelAccountingJobBinding, withStandaloneModelAccountingJob,
  withModelUsageAttribution } from '../usage-log.js';
import { bindCompletedModelResponse } from './model-response-binding.js';
import { captureUnavailableModelTransportOwner, createModelTransportAttempt, finishModelTransportAttempt, modelTransportAttemptStream,
  captureModelTransportOwner, beginActiveClaudeReviewWireTransform,
  createClaudeModelWireProducer, declareActiveClaudeModelWireProducer,
  modelWireRequestSnapshot, observeCompletedTransportModelResponse, observeModelTransportFetch,
  withModelTransportAttempt, withModelTransportRecorder } from './model-transport-observation.js';
import { withResilience } from './resilient-model.js';
import { resolveModelCapability } from './model-wire-registry.js';
import { applyClaudeEnvelope } from './claude-model.js';
import { composeReviewInput, createReviewInputObservation } from './review-input-observation.js';

const legacyRows = (rows: readonly Readonly<Record<string, unknown>>[]) => rows.filter(row =>
  row.phase !== 'adapter_attempt_created' && row.phase !== 'adapter_attempt_finished');
const streamedRequest = { input: 'fixture', modelSettings: {}, tools: [], handoffs: [] } as unknown as ModelRequest;
const streamedPolicy = { label: 'transport-owner-fixture', capability: resolveModelCapability('claude-opus-4-8'),
  maxRetries: 1, sleep: async () => {} };

test('standalone jobs retain immutable distinct owners under concurrent foreign drainers without turn or review authority', async () => {
  const jobs = [0, 1].map(() => createStandaloneModelAccountingJob({ operation: 'noticing_proposal',
    operationId: 'controlled-tick', revisionDigest: 'a'.repeat(64) }));
  assert.notEqual(standaloneModelAccountingJobBinding(jobs[0]!)?.usageJobId,
    standaloneModelAccountingJobBinding(jobs[1]!)?.usageJobId);
  const rows: Readonly<Record<string, unknown>>[] = [];
  const captured = jobs.map(job => withModelTransportRecorder(row => rows.push(row), () =>
    withStandaloneModelAccountingJob(job, captureModelTransportOwner)));
  await Promise.all(captured.map((owner, i) => withModelUsageAttribution({ sessionId: `foreign-drainer-${i}`,
    sourceUserSeq: 700 + i, attemptId: `foreign-attempt-${i}`, role: 'brain' }, async () => {
    const scope = createModelTransportAttempt(`controlled-job-call-${i}`, 1, owner);
    assert.equal(scope.owner, undefined);
    assert.equal(scope.accountingJob?.usageJobId, standaloneModelAccountingJobBinding(jobs[i]!)?.usageJobId);
    const response = { id: `controlled-job-response-${i}` };
    await withModelTransportAttempt(scope, async () => {
      declareActiveClaudeModelWireProducer(createClaudeModelWireProducer());
      assert.equal(beginActiveClaudeReviewWireTransform({ system: 'private guide' }), undefined);
      await observeModelTransportFetch('raw_claude_messages', 'claude-controlled', async () => ({ status: 200, ok: true }));
      bindCompletedModelResponse(response, scope.modelCallId, 1);
      observeCompletedTransportModelResponse(scope, response);
      finishModelTransportAttempt(scope, 'returned');
    });
  })));
  for (const [i, job] of jobs.entries()) {
    const own = rows.filter(row => row.usageJobId === standaloneModelAccountingJobBinding(job)?.usageJobId);
    assert.deepEqual(own.map(row => row.phase), ['adapter_attempt_created', 'dispatch_started', 'headers_received',
      'model_result_completed', 'adapter_attempt_finished']);
    assert.ok(own.every(row => row.ownerKind === 'accounting_job' && row.modelCallId === `controlled-job-call-${i}`));
    assert.equal(own.at(-1)?.providerResponseIdDigest,
      createHash('sha256').update(`controlled-job-response-${i}`).digest('hex'));
    for (const row of own) for (const field of ['sourceUserSeq', 'logicalTurnId', 'runAttemptId', 'wireInputInclusion', 'reviewWireInclusionReceipts']) {
      assert.equal(Object.hasOwn(row, field), false, field);
    }
  }
  assert.doesNotMatch(JSON.stringify(rows), /private guide|foreign-drainer|foreign-attempt/);
});

test('a cloned job capture is unowned and a failed job attempt retains unknown usage', () => {
  const rows: Readonly<Record<string, unknown>>[] = [];
  const job = createStandaloneModelAccountingJob({ operation: 'noticing_answer', operationId: 'controlled-check-in',
    revisionDigest: 'b'.repeat(64) });
  const captured = withModelTransportRecorder(row => rows.push(row), () => withStandaloneModelAccountingJob(job, captureModelTransportOwner));
  withModelUsageAttribution({ sessionId: 'later-turn', sourceUserSeq: 750, attemptId: 'later-attempt' }, () => {
    const forged = createModelTransportAttempt('forged-job-call', 1, { ...captured });
    assert.equal(forged.owner, undefined); assert.equal(forged.accountingJob, undefined);
    finishModelTransportAttempt(forged, 'returned');
    const actual = createModelTransportAttempt('failed-job-call', 1, captured);
    finishModelTransportAttempt(actual, 'failed');
  });
  assert.deepEqual(rows.map(row => row.phase), ['adapter_attempt_created', 'adapter_attempt_finished']);
  assert.equal(rows[1]?.outcome, 'failed'); assert.equal(rows[1]?.usage, 'unknown');
  assert.equal(rows[1]?.remoteSettlement, 'unknown'); assert.equal(rows[1]?.providerResponseIdDigest, undefined);
});

test('concurrent dispatches retain whole immutable accepted owners and keep headers distinct from original completion', async () => {
  const rows: Readonly<Record<string, unknown>>[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ownerA = { sessionId: 'fixture-a', sourceUserSeq: 10, attemptId: 'attempt-a', role: 'reviewer' as const };
  const ownerB = { sessionId: 'fixture-b', sourceUserSeq: 20, attemptId: 'attempt-b', role: 'reviewer' as const };
  const work = (owner: typeof ownerA, id: string) => withModelUsageAttribution(owner, () => {
    const scope = createModelTransportAttempt(id, 1);
    owner.sessionId = 'mutated'; owner.sourceUserSeq = 999;
    return withModelTransportAttempt(scope, async () => {
      await observeModelTransportFetch('raw_claude_messages', 'claude-fixture', async () => {
        await gate; return { status: 200, ok: true };
      });
      assert.equal(rows.filter(row => row.modelCallId === id && row.phase === 'model_result_completed').length, 0);
      const response = { responseId: `response-${id}` };
      observeCompletedTransportModelResponse(scope, response);
      bindCompletedModelResponse(response, id, 1);
      observeCompletedTransportModelResponse(scope, { ...response });
      observeCompletedTransportModelResponse(scope, response);
      observeCompletedTransportModelResponse(scope, response);
    });
  });
  await withModelTransportRecorder(data => rows.push(data), async () => {
    const a = work(ownerA, 'call-a'); const b = work(ownerB, 'call-b'); release(); await Promise.all([a, b]);
  });
  assert.equal(legacyRows(rows).length, 6);
  assert.equal(new Set(rows.filter(row => row.phase === 'dispatch_started').map(row => row.dispatchId)).size, 2);
  for (const [id, source, attempt] of [['call-a', 10, 'attempt-a'], ['call-b', 20, 'attempt-b']] as const) {
    const owned = legacyRows(rows).filter(row => row.modelCallId === id);
    assert.ok(owned.every(row => row.sourceUserSeq === source && row.runAttemptId === attempt));
    assert.deepEqual(owned.map(row => row.phase), ['dispatch_started', 'headers_received', 'model_result_completed']);
    assert.equal(owned[1].modelCompletion, 'unproved');
    assert.equal((owned[2].dispatchIds as string[])[0], owned[0].dispatchId);
    assert.equal(owned[2].resultScope, 'original_sdk_response');
  }
});

test('local declarations close without instrumented dispatch and never invent wire work or usage', () => {
  for (const outcome of ['returned', 'failed', 'cancelled'] as const) {
    const rows: Readonly<Record<string, unknown>>[] = [];
    withModelTransportRecorder(row => rows.push(row), () => withModelUsageAttribution({
      sessionId: 'local-only-owner', sourceUserSeq: 301, attemptId: 'attempt-local-only', role: 'worker',
    }, () => {
      const scope = createModelTransportAttempt(`local-only-${outcome}`, 1);
      finishModelTransportAttempt(scope, outcome); finishModelTransportAttempt(scope, 'returned');
    }));
    assert.deepEqual(rows.map(row => row.phase), ['adapter_attempt_created', 'adapter_attempt_finished']);
    assert.equal(rows[1].outcome, outcome); assert.deepEqual(rows[1].dispatchIds, []);
    assert.equal(rows[1].resultScope, 'local_retirement'); assert.equal(rows[1].usage, 'unknown');
    assert.equal(rows[1].remoteSettlement, 'unknown'); assert.equal(rows[1].providerResponseIdDigest, undefined);
    assert.deepEqual(legacyRows(rows), [], 'no declared wire census becomes a known-zero wire census');
  }
});

test('nominal unavailable capture never adopts a later accepted owner or wire expectation', async () => {
  const rows: Readonly<Record<string, unknown>>[] = [];
  const captured = withModelTransportRecorder(row => rows.push(row), () => captureUnavailableModelTransportOwner());
  await withModelUsageAttribution({ sessionId: 'later-owner', sourceUserSeq: 333, attemptId: 'attempt-later' }, async () => {
    for (const owner of [captured, { ...captured }]) {
      const scope = createModelTransportAttempt('unavailable-owner-call', 1, owner, 'jev-completion');
      assert.equal(scope.owner, undefined); assert.equal(scope.purpose, 'unknown');
      assert.equal(scope.callPurpose, 'jev-completion');
      assert.equal(Reflect.set(scope, 'callPurpose', 'jev-turn-start'), false);
      await withModelTransportAttempt(scope, () => observeModelTransportFetch('typesafe_systemone', 'jev-1.13.0',
        async () => ({ status: 200, ok: true })));
      finishModelTransportAttempt(scope, 'returned');
    }
  });
  assert.deepEqual(rows, []);
});

test('original SDK identity is reopened only at final local outcome; clones and changed identities decline', () => {
  for (const mode of ['valid', 'clone', 'wrong-call', 'changed', 'ambiguous', 'late'] as const) {
    const rows: Readonly<Record<string, unknown>>[] = [];
    withModelTransportRecorder(row => rows.push(row), () => withModelUsageAttribution({
      sessionId: 'local-original-owner', sourceUserSeq: 302, attemptId: 'attempt-local-original',
    }, () => {
      const scope = createModelTransportAttempt(`local-original-${mode}`, 1);
      const original = { responseId: `result-local-${mode}` };
      bindCompletedModelResponse(original, mode === 'wrong-call' ? 'older-call' : scope.modelCallId, 1);
      if (mode === 'late') finishModelTransportAttempt(scope, 'cancelled');
      observeCompletedTransportModelResponse(scope, mode === 'clone' ? { ...original } : original);
      assert.equal(rows.filter(row => row.phase === 'adapter_attempt_finished').length, mode === 'late' ? 1 : 0);
      if (mode === 'changed') original.responseId = 'changed-result';
      if (mode === 'ambiguous') {
        const other = { responseId: 'another-result' }; bindCompletedModelResponse(other, scope.modelCallId, 1);
        observeCompletedTransportModelResponse(scope, other);
      }
      finishModelTransportAttempt(scope, 'returned');
    }));
    const ended = rows.filter(row => row.phase === 'adapter_attempt_finished');
    assert.equal(ended.length, 1);
    assert.equal(ended[0].resultScope, mode === 'valid' ? 'original_sdk_response' : 'local_retirement');
    assert.equal(typeof ended[0].providerResponseIdDigest, mode === 'valid' ? 'string' : 'undefined');
    assert.equal(ended[0].usage, 'unknown'); assert.equal(ended[0].remoteSettlement, 'unknown');
    assert.deepEqual(legacyRows(rows), []);
  }
});

test('actual resilient empty completion has a failed local outcome despite a completed SDK identity', async () => {
  const rows: Readonly<Record<string, unknown>>[] = []; let calls = 0;
  const model = withResilience({
    async getResponse() { calls++; return { responseId: 'empty-original-result', output: [], usage: {} } as never; },
    async *getStreamedResponse() { throw new Error('unused'); },
  }, { ...streamedPolicy, maxRetries: 0 });
  await withModelTransportRecorder(row => rows.push(row), () => withModelUsageAttribution({
    sessionId: 'empty-original-owner', sourceUserSeq: 303, attemptId: 'attempt-empty-original',
  }, () => assert.rejects(model.getResponse(streamedRequest), /empty completion/)));
  assert.equal(calls, 1);
  const ended = rows.filter(row => row.phase === 'adapter_attempt_finished');
  assert.equal(ended.length, 1); assert.equal(ended[0].outcome, 'failed');
  assert.equal(ended[0].resultScope, 'original_sdk_response'); assert.equal(ended[0].usage, 'unknown');
  assert.deepEqual(legacyRows(rows), []);
});

test('a public lazy stream never drained remains outside this local attempt census', () => {
  const rows: Readonly<Record<string, unknown>>[] = []; let calls = 0;
  const model = withResilience({
    async getResponse() { throw new Error('unused'); },
    async *getStreamedResponse() { calls++; yield { type: 'response_done' } as never; },
  }, streamedPolicy);
  withModelTransportRecorder(row => rows.push(row), () => withModelUsageAttribution({
    sessionId: 'never-drained-owner', sourceUserSeq: 304, attemptId: 'attempt-never-drained',
  }, () => model.getStreamedResponse(streamedRequest)));
  assert.equal(calls, 0); assert.deepEqual(rows, []);
});

test('late wire work after no-dispatch local retirement remains a census consistency gap', async () => {
  const rows: Readonly<Record<string, unknown>>[] = [];
  await withModelTransportRecorder(row => rows.push(row), () => withModelUsageAttribution({
    sessionId: 'late-local-owner', sourceUserSeq: 305, attemptId: 'attempt-late-local',
  }, async () => {
    const scope = createModelTransportAttempt('late-local-call', 1);
    finishModelTransportAttempt(scope, 'cancelled');
    await withModelTransportAttempt(scope, () => observeModelTransportFetch('raw_claude_messages', 'claude-fixture',
      async () => ({ status: 200, ok: true })));
  }));
  const finished = rows.find(row => row.phase === 'adapter_attempt_finished')!;
  const dispatch = rows.find(row => row.phase === 'dispatch_started')!;
  assert.deepEqual(finished.dispatchIds, []); assert.equal(finished.outcome, 'cancelled');
  assert.equal(rows.indexOf(dispatch) > rows.indexOf(finished), true);
  assert.equal(dispatch.late, false, 'preserved legacy flag cannot alone certify local-census closure');
  assert.equal(rows.filter(row => row.phase === 'adapter_attempt_finished').length, 1);
});

test('wire snapshots expose only exact hashes and bytes; caller clones cannot smuggle metadata', async () => {
  const rows: Readonly<Record<string, unknown>>[] = [];
  const body = JSON.stringify({ model: 'claude-fixture', system: [{ type: 'text', text: 'PRIVATE GUIDE' }],
    messages: [{ role: 'user', content: 'PRIVATE OWNER WORDS' }], tools: [{ name: 'fixture', input_schema: { type: 'object' } }] });
  const snapshot = modelWireRequestSnapshot(body)!;
  assert.equal(snapshot.serialized.sha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(snapshot.serialized.bytes, Buffer.byteLength(body));
  assert.ok(snapshot.components.toolSchemas);
  await withModelTransportRecorder(data => rows.push(data), () => withModelUsageAttribution({
    sessionId: 'snapshot-owner', sourceUserSeq: 30, attemptId: 'snapshot-attempt',
  }, async () => {
    const scope = createModelTransportAttempt('snapshot-call', 1);
    await withModelTransportAttempt(scope, async () => {
      await observeModelTransportFetch('raw_claude_messages', 'claude-fixture', async () => ({ status: 400, ok: false }), undefined, snapshot);
      await observeModelTransportFetch('raw_claude_messages', 'claude-fixture', async () => ({ status: 200, ok: true }),
        'cache_ttl_rejected', { ...snapshot } as never);
    });
    finishModelTransportAttempt(scope, 'cancelled');
  }));
  const starts = rows.filter(row => row.phase === 'dispatch_started');
  assert.equal(starts.length, 2); assert.notEqual(starts[0].dispatchId, starts[1].dispatchId);
  assert.equal(starts[1].wireSubattempt, 2); assert.equal(starts[1].retryReason, 'cache_ttl_rejected');
  assert.deepEqual(starts[0].wireRequest, snapshot); assert.equal(starts[1].wireRequest, undefined);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE GUIDE|PRIVATE OWNER WORDS|input_schema|Bearer|authorization/);
  assert.equal(rows.at(-1)?.remoteSettlement, 'unknown');
});

test('retired noncooperative fetch and async journal rejection cannot alter result or invent completion', async () => {
  const rows: Readonly<Record<string, unknown>>[] = [];
  let resolve!: (value: { status: number; ok: boolean }) => void;
  const pending = new Promise<{ status: number; ok: boolean }>(done => { resolve = done; });
  const response = { status: 200, ok: true };
  await withModelTransportRecorder(data => { rows.push(data); return Promise.reject(new Error('fixture sink failure')); },
    () => withModelUsageAttribution({ sessionId: 'late-owner', sourceUserSeq: 40, attemptId: 'late-attempt' }, async () => {
      const scope = createModelTransportAttempt('late-call', 1);
      const work = withModelTransportAttempt(scope, () => observeModelTransportFetch('typesafe_systemone', 'jev-fixture', () => pending));
      finishModelTransportAttempt(scope, 'cancelled');
      resolve(response); assert.equal(await work, response);
      await Promise.resolve();
    }));
  assert.equal(rows.filter(row => row.phase === 'model_result_completed').length, 0);
  assert.equal(rows.at(-1)?.phase, 'headers_received'); assert.equal(rows.at(-1)?.late, true);
  assert.equal(rows.at(-1)?.modelCompletion, 'unproved');
});

test('stream next and return preserve original source scope when drained from another caller', async () => {
  const rows: Readonly<Record<string, unknown>>[] = [];
  await withModelTransportRecorder(data => rows.push(data), async () => {
    // The sink is captured with the source, so recreate within its own sink.
    const own = withModelUsageAttribution({ sessionId: 'stream-owner', sourceUserSeq: 50, attemptId: 'stream-attempt' },
      () => createModelTransportAttempt('stream-second', 1));
    const iterable = (async function* () {
      try { await observeModelTransportFetch('raw_claude_messages', 'claude-fixture', async () => ({ status: 200, ok: true })); yield 'unchanged'; }
      finally { finishModelTransportAttempt(own, 'cancelled'); }
    })();
    await withModelUsageAttribution({ sessionId: 'foreign-caller', sourceUserSeq: 60, attemptId: 'foreign-attempt' }, async () => {
      const iterator = modelTransportAttemptStream(own, iterable)[Symbol.asyncIterator]();
      assert.deepEqual(await iterator.next(), { value: 'unchanged', done: false });
      await iterator.return!();
    });
  });
  assert.ok(rows.length >= 3); assert.ok(rows.every(row => row.sourceUserSeq === 50 && row.runAttemptId === 'stream-attempt'));
});

test('the public resilient stream captures source and sink before lazy drain, across a real retry', async () => {
  const rows: Readonly<Record<string, unknown>>[] = [];
  const foreignRows: Readonly<Record<string, unknown>>[] = [];
  let calls = 0;
  const model = withResilience({
    async getResponse() { throw new Error('unused'); },
    async *getStreamedResponse() {
      calls += 1;
      await observeModelTransportFetch('raw_claude_messages', 'claude-fixture', async () => {
        if (calls === 1) throw Object.assign(new Error('fixture transient'), { status: 503 });
        return { status: 200, ok: true };
      });
      yield { type: 'output_text_delta', delta: 'unchanged' } as never;
      yield { type: 'response_done', response: { responseId: 'fixture-stream-result', output: [{ type: 'message' }], usage: {} } } as never;
    },
  }, streamedPolicy);
  const owner = { sessionId: 'original-stream-owner', sourceUserSeq: 70, attemptId: 'original-attempt', role: 'brain' as const };
  const stream = withModelTransportRecorder(row => rows.push(row), () => withModelUsageAttribution(owner,
    () => model.getStreamedResponse(streamedRequest)));
  owner.sessionId = 'mutated'; owner.sourceUserSeq = 999;
  const yielded: unknown[] = [];
  await withModelTransportRecorder(row => foreignRows.push(row), () => withModelUsageAttribution({
    sessionId: 'foreign-stream-owner', sourceUserSeq: 80, attemptId: 'foreign-attempt', role: 'reviewer',
  }, async () => { for await (const event of stream) yielded.push(event); }));
  assert.equal(calls, 2); assert.equal(yielded.length, 2); assert.equal(foreignRows.length, 0);
  assert.ok(rows.every(row => row.sourceUserSeq === 70 && row.runAttemptId === 'original-attempt' && row.purpose === 'brain'));
  assert.deepEqual(rows.filter(row => row.phase === 'dispatch_started').map(row => row.physicalAttempt), [1, 2]);
  assert.equal(new Set(rows.filter(row => row.phase === 'dispatch_started').map(row => row.dispatchId)).size, 2);
  assert.equal(rows.filter(row => row.phase === 'model_attempt_retired' && row.outcome === 'failed').length, 1);
  assert.equal(rows.filter(row => row.phase === 'model_result_completed').length, 1);
});

test('an initially unowned resilient stream never adopts a later caller', async () => {
  const rows: Readonly<Record<string, unknown>>[] = [];
  let calls = 0;
  const model = withResilience({
    async getResponse() { throw new Error('unused'); },
    async *getStreamedResponse() {
      calls += 1;
      await observeModelTransportFetch('raw_claude_messages', 'claude-fixture', async () => ({ status: 200, ok: true }));
      yield { type: 'response_done', response: { responseId: 'fixture-unowned', output: [{ type: 'message' }], usage: {} } } as never;
    },
  }, streamedPolicy);
  const stream = model.getStreamedResponse(streamedRequest);
  await withModelTransportRecorder(row => rows.push(row), () => withModelUsageAttribution({
    sessionId: 'foreign-unowned-drainer', sourceUserSeq: 90, attemptId: 'foreign-attempt',
  }, async () => { for await (const _ of stream) { /* consume original output */ } }));
  assert.equal(calls, 1); assert.deepEqual(rows, []);
});

test('returning a resilient stream before its result keeps cancellation and usage unsettled', async () => {
  const rows: Readonly<Record<string, unknown>>[] = [];
  let calls = 0;
  const model = withResilience({
    async getResponse() { throw new Error('unused'); },
    async *getStreamedResponse() {
      calls += 1;
      await observeModelTransportFetch('raw_claude_messages', 'claude-fixture', async () => ({ status: 200, ok: true }));
      yield { type: 'output_text_delta', delta: 'unchanged' } as never;
      yield { type: 'response_done', response: { responseId: 'must-not-be-observed', output: [{ type: 'message' }], usage: {} } } as never;
    },
  }, streamedPolicy);
  const stream = withModelTransportRecorder(row => rows.push(row), () => withModelUsageAttribution({
    sessionId: 'cancelled-stream-owner', sourceUserSeq: 100, attemptId: 'cancelled-attempt',
  }, () => model.getStreamedResponse(streamedRequest)));
  await withModelUsageAttribution({ sessionId: 'foreign-cancel-drainer', sourceUserSeq: 110 }, async () => {
    const iterator = stream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).done, false); await iterator.return!();
  });
  assert.equal(calls, 1); assert.ok(rows.every(row => row.sourceUserSeq === 100));
  assert.equal(rows.filter(row => row.phase === 'model_result_completed').length, 0);
  assert.equal(rows.at(-1)?.phase, 'model_attempt_retired');
  assert.equal(rows.at(-1)?.outcome, 'cancelled'); assert.equal(rows.at(-1)?.usage, 'unknown');
});

test('cloned/ambiguous producers, foreign recipes and retired dispatches cannot borrow nominal wire inclusion', async () => {
  const parity = process.env.CLEMMY_MODEL_PARITY; process.env.CLEMMY_MODEL_PARITY = 'on';
  try {
    for (const mode of ['cloned_producer', 'ambiguous_producer', 'foreign_recipe', 'retired_dispatch'] as const) {
      const owner = { sessionId: 'wire-boundary-fixture', sourceUserSeq: 200, attemptId: 'attempt-wire-boundary' };
      const rows: Readonly<Record<string, unknown>>[] = []; let calls = 0;
      const instructions = composeReviewInput([{ text: 'PRIVATE guide 🟠', component: 'host_completion_guidance' }], '');
      const prompt = composeReviewInput([{ text: 'PRIVATE objective', component: 'effective_objective' }], '');
      const collector = createReviewInputObservation({ owner, stage: 'completion', objectiveDigest: 'a'.repeat(64),
        candidateDigest: 'b'.repeat(64), instructions, prompt }, { ownerAtEntry: () => owner });
      const result = { responseId: `fixture-${mode}`, output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'DONE: boundary.' }] }], usage: {} };
      const original = collector.wrap({ async getResponse() {
        const scope = createModelTransportAttempt(`boundary-${mode}`, 1);
        return withModelTransportAttempt(scope, async () => {
          const producer = createClaudeModelWireProducer();
          declareActiveClaudeModelWireProducer(mode === 'cloned_producer' ? { ...producer } : producer);
          const envelope = applyClaudeEnvelope({ body: JSON.stringify({ model: 'claude-sonnet-5',
            system: [{ type: 'text', text: instructions.text }], messages: [{ role: 'user', content: [{ type: 'text', text: prompt.text }] }] }) },
          'fixture-only', 'fixture');
          if (mode === 'ambiguous_producer') declareActiveClaudeModelWireProducer(createClaudeModelWireProducer());
          const fetch = () => observeModelTransportFetch('raw_claude_messages', 'claude-sonnet-5', async () => {
            calls++; return { status: 200, ok: true };
          }, undefined, undefined, { transform: envelope.reviewWireTransform, serialized: envelope.body });
          if (mode === 'foreign_recipe') {
            const foreign = createModelTransportAttempt('foreign-recipe-call', 2);
            await withModelTransportAttempt(foreign, async () => { declareActiveClaudeModelWireProducer(producer); await fetch(); });
          } else if (mode === 'retired_dispatch') {
            await observeModelTransportFetch('raw_claude_messages', 'claude-sonnet-5', async () => ({ status: 200, ok: true }));
            finishModelTransportAttempt(scope, 'cancelled'); await fetch();
          } else await fetch();
          bindCompletedModelResponse(result, scope.modelCallId, scope.physicalAttempt);
          observeCompletedTransportModelResponse(scope, result); return result as never;
        });
      }, async *getStreamedResponse() {} });
      await withModelTransportRecorder(row => rows.push(row), () => withModelUsageAttribution({ ...owner, role: 'reviewer' },
        () => original.getResponse({ systemInstructions: instructions.text, input: prompt.text,
          modelSettings: {}, tools: [], handoffs: [] } as unknown as ModelRequest)));
      assert.equal(calls, 1, mode);
      const inclusion = rows.filter(row => row.phase === 'dispatch_started' && row.wireInputInclusion).at(-1)?.wireInputInclusion as { status?: string };
      assert.equal(inclusion?.status, 'unqualified', mode);
      assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|fixture-only/);
      if (mode === 'retired_dispatch') assert.equal(rows.filter(row => row.phase === 'model_result_completed').length, 0);
    }
  } finally { if (parity === undefined) delete process.env.CLEMMY_MODEL_PARITY; else process.env.CLEMMY_MODEL_PARITY = parity; }
});


// existing nominal state is reopened, never fabricated
// from provider IDs or serialized records. Real accepted owners are disposable.
for (const mode of ['live', 'retired', 'unsupported', 'empty', 'wrong_token'] as const) {
  test(`BYO accounting capture distinguishes absent from present ${mode} attempts without ambient adoption`, async () => {
    assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1');
    const log = await import('./eventlog.js');
    const { captureModelTransportUsageOwner, captureActiveModelTransportUsage, capturedModelTransportUsageCallId } = await import('./model-transport-observation.js');
    const { capturedModelUsageAttribution, captureModelUsageProvenance } = await import('../usage-log.js');
    const session = log.createSession({ kind: 'chat', channel: 'test' });
    const attempt = log.beginRunAttempt(session.id);
    const source = log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'Synthetic nominal state control.' } });
    const owner = { sessionId: session.id, sourceUserSeq: source.seq, attemptId: attempt.attemptId, role: 'brain' as const };
    try {
      assert.equal(captureActiveModelTransportUsage(), undefined, 'only absent active scope is legacy');
      const scope = mode === 'unsupported' ? { modelCallId: 'unsupported-nominal', physicalAttempt: 1, purpose: 'brain' as const }
        : withModelUsageAttribution(owner, () => createModelTransportAttempt(`nominal-${mode}`, 1,
          mode === 'empty' ? captureUnavailableModelTransportOwner() : captureModelTransportUsageOwner()));
      if (mode === 'retired') finishModelTransportAttempt(scope, 'cancelled');
      withModelUsageAttribution({ sessionId: 'foreign-b', sourceUserSeq: 999, attemptId: 'foreign-attempt', role: 'brain' }, () =>
        withModelTransportAttempt(scope, () => {
          const captured = captureActiveModelTransportUsage()!; assert.ok(captured);
          const usage = capturedModelUsageAttribution(captured.callerProvenance);
          if (mode === 'unsupported' || mode === 'empty') {
            assert.equal(captured.owner, undefined); assert.equal(usage?.sourceUserSeq, 0);
          } else {
            assert.equal(captured.owner?.sessionId, session.id); assert.equal(usage?.attemptId, attempt.attemptId);
          }
          const token = mode === 'wrong_token' ? captureModelUsageProvenance() : captured.callerProvenance;
          assert.equal(capturedModelTransportUsageCallId(captured.attempt, token), mode === 'live' ? scope.modelCallId : undefined);
        }));
    } finally { log.finishRunAttempt(attempt, 'completed'); }
  });
}
