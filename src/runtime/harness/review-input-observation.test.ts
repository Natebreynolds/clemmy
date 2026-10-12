import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Model, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';
import { bindCompletedModelResponse } from './model-response-binding.js';
import { composeReviewInput, createReviewInputObservation, reviewInputObservationForSource,
  captureReviewWireExpectation, reviewWireInclusionForDispatch,
  beginReviewWireTransform, finishReviewWireTransform,
  type ReviewWireExpectation, type ReviewInputSeed, type ReviewInputObservation, type BoundReviewInputObservation } from './review-input-observation.js';
import { modelUsageAttributionStorage } from '../usage-log.js';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const owner = { sessionId: 'sess-review-fixture', sourceUserSeq: 7, attemptId: 'attempt:review-fixture' };
const seed = (suffix = ''): ReviewInputSeed => ({ owner: { ...owner }, stage: 'completion',
  objectiveDigest: digest('controlled objective' + suffix), candidateDigest: digest('controlled candidate' + suffix),
  instructions: composeReviewInput([
    { text: 'Controlled rubric' + suffix, component: 'judge_rubric' },
    { text: 'Whole controlled guide', component: 'host_completion_guidance' },
  ], '\n\n'),
  prompt: composeReviewInput([
    { text: 'Controlled objective' + suffix, component: 'effective_objective' },
    { text: 'Controlled candidate' + suffix, component: 'candidate_response' },
    { text: 'Controlled evidence', component: 'private_review_evidence' },
  ], '\n'),
});
const request = (value: ReviewInputSeed): ModelRequest => ({ systemInstructions: value.instructions.text,
  input: [{ role: 'user', content: value.prompt.text }], modelSettings: { maxTokens: 2048 }, tools: [], handoffs: [],
  outputType: { type: 'text' }, tracing: 'disabled' });
let responseOrdinal = 0;
function response(text = 'DONE: controlled.', bind = true): ModelResponse {
  const ordinal = ++responseOrdinal;
  const result = { responseId: `msg_review_fixture_${ordinal}`,
    usage: { inputTokens: 100, outputTokens: 4, totalTokens: 104, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
    output: [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text }] }] } as ModelResponse;
  if (bind) bindCompletedModelResponse(result, `call_review_fixture_${ordinal}`, 1);
  return result;
}
const modelReturning = (result: ModelResponse): Model => ({ async getResponse() { return result; }, async *getStreamedResponse() {} });
const collector = (value = seed(), extra: Parameters<typeof createReviewInputObservation>[1] = {}) =>
  createReviewInputObservation(value, { ownerAtEntry: () => value.owner, ...extra });
const bound = (value: ReviewInputObservation): BoundReviewInputObservation => {
  assert.equal(value.status, 'bound'); return value as BoundReviewInputObservation;
};

test('fixed components retain exact UTF-8 join bytes and construction spans', () => {
  const left = composeReviewInput([{ text: 'résumé 🟠', component: 'judge_rubric' }], '');
  const all = composeReviewInput([left, { text: 'Whole guide', component: 'host_completion_guidance' }], '\n\n');
  assert.equal(all.text, 'résumé 🟠\n\nWhole guide');
  const bytes = Buffer.from(all.text);
  for (const item of all.components) {
    const selected = bytes.subarray(item.startByte, item.endByte);
    assert.equal(selected.length, item.bytes);
    assert.equal(digest(selected.toString()), item.sha256);
  }
  assert.ok(Object.isFrozen(all) && Object.isFrozen(all.components) && all.components.every(Object.isFrozen));
  assert.throws(() => composeReviewInput([{ text: 'private', component: 'https://private.invalid' as never }], ''), /Unknown/);
  assert.throws(() => composeReviewInput([{ ...left, components: [] }], ''), /Unknown/);
});

test('an exact original completed response receives immutable content-free same-call SDK proof', async () => {
  const value = seed(); const observed = collector(value); const result = response(); const req = request(value);
  assert.equal(await observed.wrap(modelReturning(result)).getResponse(req), result);
  const record = bound(observed.finish([result], 'DONE: controlled.'));
  assert.equal(record.sessionId, owner.sessionId); assert.equal(record.attemptId, owner.attemptId);
  assert.equal(record.sourceUserSeq, owner.sourceUserSeq); assert.equal(record.requestOrdinal, 1);
  assert.equal(record.physicalAttempt, 1); assert.equal(record.instructionsSha256, digest(value.instructions.text));
  assert.equal(record.wireDispatchInventory, 'unknown'); assert.equal(record.accountBackendBilling, 'unknown');
  assert.equal(record.components.length, 5); assert.equal(record.sdkRequestSha256.length, 64);
  assert.ok(Object.isFrozen(record) && Object.isFrozen(record.components));
  assert.doesNotMatch(JSON.stringify(record), /Controlled|Whole controlled|DONE:|msg_review_fixture|headers|authorization/);
  const expected = { ...owner, objectiveDigest: value.objectiveDigest, candidateDigest: value.candidateDigest };
  assert.equal(reviewInputObservationForSource(record, expected), record);
  assert.equal(reviewInputObservationForSource({ ...record }, expected), undefined);
  assert.equal(reviewInputObservationForSource(record, { ...expected, sourceUserSeq: 8 }), undefined);
  assert.equal(reviewInputObservationForSource(record, { ...expected, attemptId: 'attempt:other' }), undefined);
  assert.equal(reviewInputObservationForSource(record, { ...expected, candidateDigest: digest('other') }), undefined);
});

for (const change of ['omitted_guide', 'mutated_objective', 'extra_prompt_message'] as const) {
  test(`${change} cannot attest the expected assembly even when a response completes`, async () => {
    const value = seed(); const observed = collector(value); const result = response(); const req = request(value);
    if (change === 'omitted_guide') req.systemInstructions = 'Controlled rubric';
    if (change === 'mutated_objective') req.input = [{ role: 'user', content: value.prompt.text.replace('Controlled objective', 'Other objective') }];
    if (change === 'extra_prompt_message') req.input = [{ role: 'user', content: 'prefix' }, { role: 'user', content: value.prompt.text }];
    assert.equal(await observed.wrap(modelReturning(result)).getResponse(req), result);
    assert.deepEqual(observed.finish([result], 'DONE: controlled.'),
      { version: 1, scope: 'sdk_model_entry', status: 'unqualified', reason: 'request_mismatch' });
  });
}

test('request mutation during provider invocation cannot certify the earlier snapshot', async () => {
  const value = seed(); const observed = collector(value); const result = response(); const req = request(value);
  const inner: Model = { ...modelReturning(result), async getResponse(current) { current.systemInstructions += ' changed'; return result; } };
  assert.equal(await observed.wrap(inner).getResponse(req), result);
  assert.equal((observed.finish([result], 'DONE: controlled.') as { reason: string }).reason, 'request_mutated');
});

test('different current ownership, missing attempt and throwing scope observations remain unqualified', async () => {
  for (const mode of ['different_source', 'different_attempt', 'missing_attempt', 'throw'] as const) {
    const value = seed();
    if (mode === 'missing_attempt') value.owner.attemptId = undefined;
    const observed = collector(value, { ownerAtEntry: () => {
      if (mode === 'throw') throw new Error('controlled observation failure');
      return { ...owner, ...(mode === 'different_source' ? { sourceUserSeq: 8 } : {}),
        ...(mode === 'different_attempt' ? { attemptId: 'attempt:other' } : {}) };
    } });
    const result = response(); assert.equal(await observed.wrap(modelReturning(result)).getResponse(request(value)), result);
    assert.equal(observed.finish([result], 'DONE: controlled.').status, 'unqualified');
  }
});

test('equal-response-ID clones and a missing private completed binding receive no proof', async () => {
  const value = seed(); const observed = collector(value); const result = response();
  await observed.wrap(modelReturning(result)).getResponse(request(value));
  assert.equal(observed.finish([{ ...result }], 'DONE: controlled.').status, 'unqualified');
  const missing = collector(value); const unbound = response('DONE: controlled.', false);
  await missing.wrap(modelReturning(unbound)).getResponse(request(value));
  assert.equal((missing.finish([unbound], 'DONE: controlled.') as { reason: string }).reason, 'response_unbound');
});

test('original responses reused across requests or collectors are ambiguous', async () => {
  const value = seed(); const a = collector(value); const b = collector(value); const result = response();
  await a.wrap(modelReturning(result)).getResponse(request(value));
  await b.wrap(modelReturning(result)).getResponse(request(value));
  assert.equal((a.finish([result], 'DONE: controlled.') as { reason: string }).reason, 'response_ambiguous');
  assert.equal((b.finish([result], 'DONE: controlled.') as { reason: string }).reason, 'response_ambiguous');
});

test('a duplicated final response in Runner history is ambiguous even with an exact original object', async () => {
  const value = seed(); const observed = collector(value); const result = response();
  await observed.wrap(modelReturning(result)).getResponse(request(value));
  assert.equal((observed.finish([result, result], 'DONE: controlled.') as { reason: string }).reason, 'response_ambiguous');
});

test('output mutation or a different final SDK output cannot borrow completed-response proof', async () => {
  const value = seed(); const a = collector(value); const result = response();
  await a.wrap(modelReturning(result)).getResponse(request(value));
  assert.equal(a.finish([result], 'DONE: different.').status, 'unqualified');
  (result.output[0] as { content: unknown }).content = [{ type: 'output_text', text: 'DONE: different.' }];
  assert.equal((a.finish([result], 'DONE: different.') as { reason: string }).reason, 'response_mutated');
});

test('concurrent winner and loser collectors cannot exchange their response or prompt proof', async () => {
  const winnerSeed = seed(' winner'); const loserSeed = seed(' loser');
  const winner = collector(winnerSeed); const loser = collector(loserSeed);
  const win = response('DONE: winner.'); const lose = response('DONE: loser.');
  await Promise.all([winner.wrap(modelReturning(win)).getResponse(request(winnerSeed)),
    loser.wrap(modelReturning(lose)).getResponse(request(loserSeed))]);
  assert.equal(winner.finish([lose], 'DONE: loser.').status, 'unqualified');
  assert.equal(loser.finish([win], 'DONE: winner.').status, 'unqualified');
  const yes = bound(winner.finish([win], 'DONE: winner.'));
  const no = bound(loser.finish([lose], 'DONE: loser.'));
  assert.notEqual(yes.modelCallId, no.modelCallId); assert.notEqual(yes.reviewInvocationId, no.reviewInvocationId);
  assert.equal(yes.candidateDigest, winnerSeed.candidateDigest);
});

test('late completed calls after cancellation and throwing calls preserve execution without winner proof', async () => {
  const value = seed(); const controller = new AbortController(); const observed = collector(value, { signal: controller.signal });
  const result = response();
  const inner: Model = { ...modelReturning(result), async getResponse() { controller.abort(); return result; } };
  assert.equal(await observed.wrap(inner).getResponse(request(value)), result);
  assert.equal((observed.finish([result], 'DONE: controlled.') as { reason: string }).reason, 'cancelled_or_incomplete');
  const failure = new Error('controlled provider failure'); const throwing = collector(value);
  await assert.rejects(throwing.wrap({ ...modelReturning(result), async getResponse() { throw failure; } }).getResponse(request(value)),
    error => error === failure);
  assert.equal(throwing.finish([], undefined).status, 'unqualified');
});

test('throwing or rejecting diagnostic observers cannot change original results or bound records', async () => {
  for (const observe of [() => { throw new Error('controlled observer'); }, async () => { throw new Error('controlled async observer'); }]) {
    const value = seed(); const observed = collector(value, { observe }); const result = response();
    assert.equal(await observed.wrap(modelReturning(result)).getResponse(request(value)), result);
    assert.equal(observed.finish([result], 'DONE: controlled.').status, 'bound');
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('stream completion forwards exact events; consumer closure cannot attest a partial stream', async () => {
  const value = seed(); const observed = collector(value); const result = response();
  const event = { type: 'response_done', response: result } as unknown as StreamEvent;
  const inner: Model = { ...modelReturning(result), async *getStreamedResponse() { yield event; } };
  const outgoing: StreamEvent[] = [];
  for await (const item of observed.wrap(inner).getStreamedResponse(request(value))) outgoing.push(item);
  assert.equal(outgoing[0], event); assert.equal(observed.finish([result], 'DONE: controlled.').status, 'bound');
  const partial = collector(value); const partialResponse = response();
  const partialInner: Model = { ...modelReturning(partialResponse), async *getStreamedResponse() {
    yield { type: 'response_done', response: partialResponse } as unknown as StreamEvent;
    yield { type: 'output_text_delta', delta: 'late' } as unknown as StreamEvent;
  } };
  for await (const _ of partial.wrap(partialInner).getStreamedResponse(request(value))) break;
  assert.equal((partial.finish([partialResponse], 'DONE: controlled.') as { reason: string }).reason, 'cancelled_or_incomplete');
});

const previousHome = process.env.CLEMENTINE_HOME;
const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-review-input-proof-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(testHome, 'state'), { recursive: true });
const { buildCompletionJudgeInstructions, buildObjectiveJudgePrompt, runRoutedJudgeAttempt, parseCompletionVerdict,
  HOST_COMPLETION_EVIDENCE_GUIDANCE } = await import('./objective-judge.js');
const { withModelUsageAttribution } = await import('../usage-log.js');
const { closeEventLog } = await import('./eventlog.js');
const { Agent, Runner } = await import('@openai/agents');
after(() => { closeEventLog(); rmSync(testHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.CLEMENTINE_HOME; else process.env.CLEMENTINE_HOME = previousHome; });

test('the actual SDK reviewer receives identical instructions/input/settings with and without attestation', async () => {
  const context = { skills: [], toolCallSummary: 'controlled source evidence', fullSourceEvidence: true,
    completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE, agentInstructions: 'controlled standing rule' };
  let instructions: ReviewInputSeed['instructions'] | undefined; let prompt: ReviewInputSeed['prompt'] | undefined;
  const instructionText = buildCompletionJudgeInstructions(context, value => { instructions = value; });
  const promptText = buildObjectiveJudgePrompt('controlled objective', 'controlled candidate', context, value => { prompt = value; });
  const evidence = { refKind: 'call ids', refs: () => ['controlled_ref'], resolve: () => ({ text: 'controlled result' }) };
  const requests: ModelRequest[] = []; const records: ReviewInputObservation[] = [];
  const route = () => ({ modelId: 'claude-sonnet-5', judgeFamily: 'claude', brainFamily: 'claude', selfJudge: true,
    model: { async getResponse(current: ModelRequest) { requests.push(current); return response(); }, async *getStreamedResponse() {} } });
  const base = await runRoutedJudgeAttempt(route() as never, instructionText, promptText, parseCompletionVerdict,
    true, evidence, undefined, 'medium');
  const observed = await withModelUsageAttribution({ ...owner }, () => runRoutedJudgeAttempt(route() as never,
    instructionText, promptText, parseCompletionVerdict, true, evidence, undefined, 'medium', undefined,
    { input: record => { records.push(record); } }, undefined,
    { ...seed(), instructions: instructions!, prompt: prompt! }));
  assert.deepEqual(observed, base); assert.equal(requests.length, 2);
  for (const key of ['systemInstructions', 'input', 'modelSettings', 'tools', 'handoffs', 'outputType'] as const) {
    assert.deepEqual(requests[1]![key], requests[0]![key], key);
  }
  const record = bound(records[0]!);
  const names = record.components.map(item => item.name);
  for (const name of ['judge_rubric', 'host_completion_guidance', 'effective_objective', 'candidate_response',
    'private_review_evidence', 'standing_instructions', 'evidence_tool_guidance', 'evidence_reference_inventory']) assert.ok(names.includes(name as never));
  assert.equal(names.filter(name => name === 'host_completion_guidance').length, 1);
  assert.doesNotMatch(JSON.stringify(record), /controlled source|controlled standing|controlled objective|controlled_ref/);
});

test('real Runner retry aggregation loses nominal response identity and stays unqualified', async () => {
  const value = seed(); const observed = collector(value); let calls = 0;
  const inner: Model = { async getResponse() {
    calls += 1; if (calls === 1) throw new Error('controlled retry'); return response();
  }, async *getStreamedResponse() {} };
  const agent = new Agent({ name: 'ControlledReview', instructions: value.instructions.text, model: observed.wrap(inner),
    modelSettings: { retry: { maxRetries: 1, policy: () => true, backoff: { initialDelayMs: 0, maxDelayMs: 0, jitter: false } } } });
  const result = await new Runner().run(agent, value.prompt.text, { maxTurns: 1 });
  assert.equal(calls, 2); assert.equal(result.finalOutput, 'DONE: controlled.');
  assert.equal((observed.finish(result.rawResponses, result.finalOutput) as { reason: string }).reason, 'final_response_unproven');
});

test('existing verdict restatement keeps identical requests and call count, and binds only its separate final call', async () => {
  const context = { skills: [], toolCallSummary: 'controlled source evidence', fullSourceEvidence: true,
    completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE };
  let instructions: ReviewInputSeed['instructions'] | undefined; let prompt: ReviewInputSeed['prompt'] | undefined;
  const instructionText = buildCompletionJudgeInstructions(context, value => { instructions = value; });
  const promptText = buildObjectiveJudgePrompt('controlled objective', 'controlled candidate', context, value => { prompt = value; });
  const requests: ModelRequest[][] = [[], []]; const records: ReviewInputObservation[] = [];
  const resultIds: string[][] = [[], []];
  const route = (index: number) => ({ modelId: 'claude-sonnet-5', judgeFamily: 'claude', brainFamily: 'claude', selfJudge: true,
    model: { async getResponse(current: ModelRequest) {
      requests[index]!.push(current);
      const result = response(requests[index]!.length === 1 ? 'The controlled review omitted its verdict line.' : 'DONE: controlled.');
      resultIds[index]!.push(digest(result.responseId!)); return result;
    }, async *getStreamedResponse() {} } });
  const base = await runRoutedJudgeAttempt(route(0) as never, instructionText, promptText, parseCompletionVerdict,
    true, undefined, undefined, 'medium');
  const observed = await withModelUsageAttribution({ ...owner }, () => runRoutedJudgeAttempt(route(1) as never,
    instructionText, promptText, parseCompletionVerdict, true, undefined, undefined, 'medium', undefined,
    { input: record => { records.push(record); } }, undefined,
    { ...seed(), instructions: instructions!, prompt: prompt! }));
  assert.deepEqual(observed, base); assert.equal(requests[0]!.length, 2); assert.equal(requests[1]!.length, 2);
  for (const index of [0, 1]) for (const key of ['systemInstructions', 'input', 'modelSettings', 'tools', 'handoffs', 'outputType'] as const) {
    assert.deepEqual(requests[1]![index]![key], requests[0]![index]![key], `${index}:${key}`);
  }
  assert.equal(records.length, 1);
  const record = bound(records[0]!);
  assert.equal(record.reviewStage, 'verdict_restatement');
  assert.equal(record.providerResponseIdDigest, resultIds[1]![1]);
  assert.notEqual(record.providerResponseIdDigest, resultIds[1]![0]);
  assert.deepEqual(record.components.map(item => item.name), ['verdict_restatement_instructions', 'verdict_restatement_input']);
  assert.doesNotMatch(JSON.stringify(record), /controlled review|controlled objective|DONE:|msg_review_fixture/);
});

test('routed input observer failure cannot change the verdict or add another call', async () => {
  for (const input of [() => { throw new Error('controlled observation failure'); },
    async () => { throw new Error('controlled async observation failure'); }]) {
    const value = seed(); let calls = 0;
    const route = { modelId: 'claude-sonnet-5', judgeFamily: 'claude', brainFamily: 'claude', selfJudge: true,
      model: { async getResponse() { calls++; return response(); }, async *getStreamedResponse() {} } };
    const verdict = await withModelUsageAttribution({ ...owner }, () => runRoutedJudgeAttempt(route as never,
      value.instructions.text, value.prompt.text, parseCompletionVerdict, true, undefined, undefined, 'medium', undefined,
      { input }, undefined, value));
    assert.equal(verdict.done, true); assert.equal(calls, 1);
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('lazy review creation captures immutable accounting without restoring tool authority or draining the model', async () => {
  const value = seed(); const result = response(); let calls = 0;
  const contexts: unknown[] = [];
  const actual = { ...owner, role: 'reviewer' as const, channel: 'judge:fixture' };
  const observed = collector(value, { ownerAtEntry: () => modelUsageAttributionStorage.getStore() });
  const inner: Model = { async getResponse() { throw new Error('unused'); }, async *getStreamedResponse() {
    calls++; contexts.push(modelUsageAttributionStorage.getStore());
    yield { type: 'response_done', response: result } as never;
  } };
  const stream = withModelUsageAttribution(actual, () => observed.wrap(inner).getStreamedResponse(request(value)));
  assert.equal(calls, 0, 'capturing diagnostics must not eagerly enter or drain the model');
  actual.sessionId = 'mutated-owner'; actual.sourceUserSeq = 999;
  await withModelUsageAttribution({ sessionId: 'foreign', sourceUserSeq: 80, attemptId: 'foreign-attempt' }, async () => {
    for await (const _ of stream) { /* original one event */ }
  });
  assert.equal(calls, 1); assert.deepEqual(contexts, [{ ...owner, role: 'reviewer', channel: 'judge:fixture' }]);
  assert.equal(observed.finish([result], 'DONE: controlled.').status, 'bound');
});

test('initial absent accounting and interrupted lazy review cannot borrow a foreign owner or retain text proof', async () => {
  for (const present of [false, true]) {
    const value = seed(); const result = response(); let calls = 0; let afterYield = false;
    let expectation: ReviewWireExpectation | undefined; let observedOwner: unknown;
    const observed = collector(value, { ownerAtEntry: () => modelUsageAttributionStorage.getStore() });
    const inner: Model = { async getResponse() { throw new Error('unused'); }, async *getStreamedResponse() {
      calls++; observedOwner = modelUsageAttributionStorage.getStore(); expectation = captureReviewWireExpectation();
      yield { type: 'output_text_delta', delta: 'unchanged' } as never;
      afterYield = true; yield { type: 'response_done', response: result } as never;
    } };
    const create = () => observed.wrap(inner).getStreamedResponse(request(value));
    const stream = present ? withModelUsageAttribution({ ...owner, role: 'reviewer' }, create)
      : modelUsageAttributionStorage.exit(create);
    await withModelUsageAttribution({ sessionId: 'foreign', sourceUserSeq: 80, attemptId: 'foreign-attempt' }, async () => {
      const iterator = stream[Symbol.asyncIterator](); assert.equal((await iterator.next()).done, false); await iterator.return!();
    });
    assert.equal(calls, 1); assert.equal(afterYield, false, 'no extra drain after cancellation');
    assert.deepEqual(observedOwner, present ? { ...owner, role: 'reviewer' } : undefined);
    assert.equal(observed.finish([result], 'DONE: controlled.').status, 'unqualified');
    const record = reviewWireInclusionForDispatch(expectation!, undefined, { ...owner, modelCallId: 'retired-call', physicalAttempt: 1 },
      'retired-dispatch', 1, '{}');
    assert.equal(record?.status, 'unqualified'); assert.equal(record?.reason, 'retired_expectation');
    assert.equal(reviewWireInclusionForDispatch({ ...expectation! }, undefined,
      { ...owner, modelCallId: 'borrowed-call', physicalAttempt: 1 }, 'borrowed-dispatch', 1, '{}'), undefined);
  }
});

test('an owned second SDK request keeps unsupported conversation layout distinct from a retired expectation', async () => {
  const value = seed(); const observed = collector(value); const first = response(); const final = response();
  let calls = 0; let expectation: ReviewWireExpectation | undefined;
  const wireOwner = { ...owner, modelCallId: 'wire-continuation-fixture', physicalAttempt: 1 };
  const inner: Model = { async getResponse() {
    calls++;
    if (calls === 1) return first;
    expectation = captureReviewWireExpectation();
    const body = { system: [{ type: 'text', text: value.instructions.text }], messages: [
      { role: 'user', content: [{ type: 'text', text: value.prompt.text }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'controlled_lookup', name: 'open_evidence', input: { ref: 'controlled_ref' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'controlled_lookup', content: 'controlled result' }] },
    ] };
    const transform = beginReviewWireTransform(expectation, wireOwner, body);
    finishReviewWireTransform(transform!, body, undefined, 'controlled identity');
    const wire = reviewWireInclusionForDispatch(expectation, transform, wireOwner,
      'wire-continuation-dispatch', 1, JSON.stringify(body));
    assert.equal(wire?.status, 'unqualified');
    assert.equal(wire?.reason, 'unsupported_sdk_layout');
    assert.equal(wire?.components, undefined, 'unsupported requests gain no component spans');
    const foreign = reviewWireInclusionForDispatch(expectation, transform,
      { ...wireOwner, attemptId: 'foreign-attempt' }, 'foreign-dispatch', 1, JSON.stringify(body));
    assert.equal(foreign?.status, 'unqualified');
    assert.equal(foreign?.reason, 'foreign_or_unfinished_transform');
    assert.equal(reviewWireInclusionForDispatch({ ...expectation }, transform, wireOwner,
      'cloned-dispatch', 1, JSON.stringify(body)), undefined);
    return final;
  }, async *getStreamedResponse() {} };
  const wrapped = observed.wrap(inner);
  assert.equal(await wrapped.getResponse(request(value)), first);
  const req = request(value);
  req.input = [{ role: 'user', content: value.prompt.text },
    { type: 'function_call_output', callId: 'controlled_lookup', output: 'controlled result' }] as never;
  assert.equal(await wrapped.getResponse(req), final);
  assert.equal(calls, 2, 'diagnostics neither add nor suppress a model call');
  const record = bound(observed.finish([first, final], 'DONE: controlled.'));
  assert.equal(record.requestOrdinal, 2, 'SDK input proof remains independent of unsupported wire layout');
  const retired = reviewWireInclusionForDispatch(expectation!, undefined, wireOwner,
    'retired-continuation-dispatch', 1, '{}');
  assert.equal(retired?.status, 'unqualified');
  assert.equal(retired?.reason, 'retired_expectation', 'only the completed wrapper actually retired this expectation');
});

test('an active unsupported prompt override stays unqualified without being called retired', async () => {
  const value = seed(); const observed = collector(value); const original = response();
  const wireOwner = { ...owner, modelCallId: 'wire-override-fixture', physicalAttempt: 1 };
  const inner: Model = { async getResponse() {
    const expectation = captureReviewWireExpectation();
    const body = { system: [{ type: 'text', text: value.instructions.text }],
      messages: [{ role: 'user', content: [{ type: 'text', text: value.prompt.text }] }] };
    const transform = beginReviewWireTransform(expectation, wireOwner, body);
    finishReviewWireTransform(transform!, body, undefined, 'controlled identity');
    const wire = reviewWireInclusionForDispatch(expectation, transform, wireOwner,
      'wire-override-dispatch', 1, JSON.stringify(body));
    assert.equal(wire?.status, 'unqualified'); assert.equal(wire?.reason, 'unsupported_sdk_layout');
    assert.equal(wire?.components, undefined);
    return original;
  }, async *getStreamedResponse() {} };
  const req = request(value); req.prompt = { id: 'controlled_override' } as never;
  assert.equal(await observed.wrap(inner).getResponse(req), original);
  assert.equal(observed.finish([original], 'DONE: controlled.').status, 'bound');
});
