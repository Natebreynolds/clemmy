import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers';
import { after, afterEach, test, type TestContext } from 'node:test';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-read-first-review-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const {
  judgeObjectiveComplete, _setCompletionJudgeForTests,
  JEV_HEDGE_DELAY_MS, JEV_READ_HEDGE_DELAY_MS,
  HOST_COMPLETION_EVIDENCE_GUIDANCE, buildObjectiveJudgePrompt,
  buildCompletionJudgeInstructions, runRoutedJudgeAttempt, parseCompletionVerdict,
  completionJudgeContextAdmission,
} = await import('./objective-judge.js');
const { _setSystemOneFetchForTests, _setTypesafeKeyForTests } = await import('../jev/client.js');
const { _resetCompletionSizeGateForTests } = await import('../jev/control-plane.js');
const { closeEventLog, createSession, appendEvent } = await import('./eventlog.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('./brackets.js');
const { _resetJudgeMemoryForTest, judgeMemoryFor, rememberTurnMemoryForJudges } = await import('../../memory/judge-memory.js');
const { recordAcceptedModelMemory, acceptedModelMemoryEvidence } = await import('./model-memory-evidence.js');
const { modelUsageAttributionStorage } = await import('../usage-log.js');
const { renderSkillReference } = await import('./skill-execution.js');
const { admitHistoricalReadPacket, historicalEvidenceDigest } = await import('./historical-completion-evidence.js');
const { recordCatalogWindow } = await import('./model-window-observations.js');
const { judgeEvidenceGuidance, judgeEvidenceReferences } = await import('./judge-evidence-tools.js');
const { INSTRUCTION_CACHE_DELIM } = await import('./model-wire-registry.js');

type Context = NonNullable<Parameters<typeof judgeObjectiveComplete>[2]>;
type Judge = NonNullable<Parameters<typeof _setCompletionJudgeForTests>[0]>;
const read: Context = {
  sessionId: 'read-first-fixture', skills: [], reviewStakes: 'read',
  toolCallSummary: 'read_file succeeded once; no writes.',
  verifiedReads: 'The complete source says status=ready.',
  verifiedReadResults: [{
    toolName: 'read_file', logicalToolCallId: 'read-status', outcome: 'succeeded',
    status: 'verified', contentComplete: true, evidenceKind: 'source_result',
  }],
};
const objective = 'Read the local status and report it.';
const reply = 'The source says status=ready.';
const judged = { verdict: { done: true, reason: 'The configured reviewer verified the exact result.' }, failure: null };
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
};

function jevResponse(kind: 'done' | 'incomplete' | 'awaiting' | 'abstained' = 'done') {
  const values = { delivered: 0.95, unaddressed: 0.03, unsupported: 0.03,
    computed: 0.03, asksUser: 0.03, cannotFinish: 0.03,
    ...(kind === 'incomplete' ? { delivered: 0.1, unaddressed: 0.95 } : {}),
    ...(kind === 'awaiting' ? { delivered: 0.2, asksUser: 0.95 } : {}),
    ...(kind === 'abstained' ? { delivered: 0.4, unaddressed: 0.7, unsupported: 0.93, computed: 0.8 } : {}),
  };
  return { status: 200, ok: true, text: async () => JSON.stringify({
    model: 'jev-1.13.0',
    answers: Object.fromEntries(Object.entries(values).map(([id, noul]) => [id, { type: 'noul', noul }])),
    usage: { input_tokens: 36, output_tokens: 5 },
  }) };
}

function historicalPacket(request: string, response: string, sessionId = read.sessionId!, sourceUserSeq = 2) {
  return admitHistoricalReadPacket({ version: 1, kind: 'historical_observations',
    consumer: { sessionId, sourceUserSeq, runAttemptId: 'attempt:historical-read-first',
      sourceEventId: 'event:current', sourceEventDigest: 'a'.repeat(64),
      objectiveDigest: historicalEvidenceDigest(request), replyDigest: historicalEvidenceDigest(response) },
    groups: [{ ref: 'historical_source_1', source: { sessionId, sourceUserSeq: 1,
      eventId: 'event:old', eventDigest: 'b'.repeat(64), settlementDigest: 'c'.repeat(64),
      recordedAt: '2026-10-08T00:00:00Z', request: 'Read the status.' },
    observations: [{ ref: 'old_read', acceptedTaskId: 'task:old', logicalToolCallId: 'call:old',
      physicalDispatchId: 'dispatch:old', resultHandleId: 'rh_old', toolName: 'read_file',
      argumentDigest: 'd'.repeat(64), contentDigest: historicalEvidenceDigest('ready'), rawByteCount: 5,
      recordedAt: '2026-10-08T00:00:01Z', contentComplete: true, sourceExhausted: true,
      request: { path: '/synthetic/status' }, content: 'ready' }],
    warnings: [{ logicalToolCallId: 'call:unknown', toolName: 'write_file', outcome: 'unknown', mutating: true }] }],
  }, () => true)!;
}

function setup(t: TestContext, judge: Judge = async () => judged) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-10-09T00:00:00Z') });
  _setTypesafeKeyForTests('ts_read_first_fixture');
  _resetCompletionSizeGateForTests();
  let calls = 0;
  _setCompletionJudgeForTests(async (...args) => { calls++; return judge(...args); });
  return { reviewerCalls: () => calls };
}

function pendingJev() {
  let answer!: (value: ReturnType<typeof jevResponse>) => void;
  let started!: () => void;
  const whenStarted = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  _setSystemOneFetchForTests(async () => {
    calls++;
    return new Promise<ReturnType<typeof jevResponse>>(resolve => { answer = resolve; started(); });
  });
  return { whenStarted, calls: () => calls, answer: (kind: Parameters<typeof jevResponse>[0] = 'done') => answer(jevResponse(kind)) };
}

afterEach(() => {
  _setTypesafeKeyForTests(null); // No provider call may escape a fixture.
  _setSystemOneFetchForTests(undefined);
  _setCompletionJudgeForTests(null);
  _resetCompletionSizeGateForTests();
  _resetJudgeMemoryForTest();
});
after(() => { closeEventLog(); rmSync(testHome, { recursive: true, force: true }); });

test('timely original Jev abstention reaches one actual reviewer request without becoming evidence or a block', async t => {
  const owner = { sessionId: read.sessionId!, sourceUserSeq: 41, attemptId: 'attempt:timely-opinion' };
  const requests: import('@openai/agents-core').ModelRequest[] = [];
  const context: Context = { ...read, reviewInputOwner: owner, agentInstructions: 'Report the verified status only.',
    completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE };
  let capturedContext: Context | undefined;
  const state = setup(t, async (request, candidate, supplied) => {
    capturedContext = supplied;
    let instructions!: import('./review-input-observation.js').ReviewInputComposition;
    let prompt!: import('./review-input-observation.js').ReviewInputComposition;
    buildCompletionJudgeInstructions(supplied, value => { instructions = value; });
    buildObjectiveJudgePrompt(request, candidate, supplied, value => { prompt = value; });
    let priorOpinionDisposition: 'forwarded' | 'omitted_context_limit' | 'not_dispatched' | undefined;
    const model = { async getResponse(input: import('@openai/agents-core').ModelRequest) {
      requests.push(input);
      return { responseId: 'opinion-test', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1,
        inputTokensDetails: [], outputTokensDetails: [] }, output: [{ type: 'message' as const, role: 'assistant' as const,
        status: 'completed' as const, content: [{ type: 'output_text' as const, text: 'DONE: The verified status is ready.' }] }] };
    }, async *getStreamedResponse() { throw new Error('no stream expected'); } };
    const verdict = await runRoutedJudgeAttempt({ model: model as never, modelId: 'claude-sonnet-5', judgeFamily: 'claude',
      brainFamily: 'byo', selfJudge: false, transport: 'test' } as never,
    instructions.text, prompt.text, parseCompletionVerdict, true, undefined, undefined, 'medium', undefined,
    { priorOpinion: value => { priorOpinionDisposition = value; } }, undefined,
    { owner, stage: 'completion', objectiveDigest: historicalEvidenceDigest(request), candidateDigest: historicalEvidenceDigest(candidate),
      instructions, prompt });
    return { verdict, failure: null, reviewDepth: 'fast', priorOpinionDisposition };
  });
  let jevCalls = 0;
  _setSystemOneFetchForTests(async () => { jevCalls++; return jevResponse('abstained'); });
  await modelUsageAttributionStorage.run(owner, async () => {
    const verdict = await judgeObjectiveComplete(objective, reply, context);
    assert.equal(verdict.done, true, 'a contrary model opinion does not mechanically block a supported candidate');
    assert.equal(state.reviewerCalls(), 1); assert.equal(jevCalls, 1); assert.equal(requests.length, 1);
    assert.equal(requests[0]!.modelSettings.reasoning?.effort, 'medium');
    const input = JSON.stringify(requests[0]!.input);
    for (const text of [objective, reply, context.agentInstructions!, context.toolCallSummary]) assert.ok(input.includes(text));
    assert.match(input, /PRIOR MODEL OPINION/); assert.match(input, /NOT FACTUAL EVIDENCE/);
    assert.match(input, /unsupported\\\":0.93/);
    assert.deepEqual(capturedContext?.verifiedReadResults, context.verifiedReadResults);
    assert.equal(capturedContext?.toolCallSummary, context.toolCallSummary, 'opinion is not a source result');
    assert.equal(verdict.jevAttempt?.priorAssessment?.forwardedBeforeEntry, true);
    assert.equal(verdict.jevAttempt?.priorAssessment?.accountBackend, 'unknown');
    assert.doesNotMatch(buildObjectiveJudgePrompt(objective, reply, { ...capturedContext! }), /PRIOR MODEL OPINION/,
      'a cloned context does not transfer the private opinion');
    assert.doesNotMatch(buildObjectiveJudgePrompt(objective, 'Different candidate.', capturedContext), /PRIOR MODEL OPINION/);
  });
});

for (const boundary of ['fits', 'optional_overflow', 'both_overflow', 'cloned_composition', 'changed_owner', 'cancelled'] as const) {
  test(`actual selected-route admission ${boundary} preserves all required bytes and optional ownership`, async t => {
    // The review reserve is the route's output budget (88112a36d). At its
    // default this fixture's boundary windows fall under the 32,000-token floor
    // the window store keeps; the model's full output keeps them above it.
    const priorBudget = process.env.CLEMMY_JUDGE_MAX_OUTPUT_TOKENS;
    process.env.CLEMMY_JUDGE_MAX_OUTPUT_TOKENS = '65536';
    t.after(() => {
      if (priorBudget === undefined) delete process.env.CLEMMY_JUDGE_MAX_OUTPUT_TOKENS;
      else process.env.CLEMMY_JUDGE_MAX_OUTPUT_TOKENS = priorBudget;
    });
    const owner = { sessionId: read.sessionId!, sourceUserSeq: 50, attemptId: `attempt:opinion-${boundary}` };
    const requests: import('@openai/agents-core').ModelRequest[] = [];
    const context: Context = { ...read, fullSourceEvidence: true, reviewInputOwner: owner,
      agentInstructions: 'Keep contrary evidence: ready does not authorize writing.',
      completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE };
    const evidence = { refKind: 'handles', refs: () => ['rh_read_status'], resolve: () => undefined } as never;
    let attempted = 0;
    const state = setup(t, async (request, candidate, supplied) => {
      let instructions!: import('./review-input-observation.js').ReviewInputComposition;
      let prompt!: import('./review-input-observation.js').ReviewInputComposition;
      buildCompletionJudgeInstructions(supplied, value => { instructions = value; });
      buildObjectiveJudgePrompt(request, candidate, supplied, value => { prompt = value; });
      const without = buildObjectiveJudgePrompt(request, candidate, { ...supplied! });
      assert.match(prompt.text, /PRIOR MODEL OPINION/);
      assert.doesNotMatch(without, /PRIOR MODEL OPINION/);
      const suffix = `\n\nReview evidence references: ${judgeEvidenceReferences(evidence)}`;
      const fullInstructions = instructions.text + judgeEvidenceGuidance(evidence);
      const withSize = completionJudgeContextAdmission('claude-sonnet-5', fullInstructions, prompt.text + suffix).estimatedTotalTokens;
      const withoutSize = completionJudgeContextAdmission('claude-sonnet-5', fullInstructions, without + suffix).estimatedTotalTokens;
      assert.ok(withSize > withoutSize, 'the actual optional note is large enough to distinguish both admissions');
      const window = boundary === 'fits' ? withSize : boundary === 'both_overflow' ? withoutSize - 1 : withoutSize;
      recordCatalogWindow('claude-sonnet-5', window, 'isolated-review-boundary');
      const model = { async getResponse(input: import('@openai/agents-core').ModelRequest) {
        requests.push(input);
        return { responseId: 'optional-boundary', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1,
          inputTokensDetails: [], outputTokensDetails: [] }, output: [{ type: 'message' as const, role: 'assistant' as const,
          status: 'completed' as const, content: [{ type: 'output_text' as const, text: 'DONE: The verified status is ready.' }] }] };
      }, async *getStreamedResponse() { throw new Error('no stream expected'); } };
      const stop = new AbortController();
      if (boundary === 'cancelled') stop.abort();
      let priorOpinionDisposition: 'forwarded' | 'omitted_context_limit' | 'not_dispatched' | undefined;
      const seed = { owner, stage: 'completion' as const, objectiveDigest: historicalEvidenceDigest(request),
        candidateDigest: historicalEvidenceDigest(candidate), instructions,
        prompt: boundary === 'cloned_composition' ? { ...prompt } : prompt };
      const invoke = () => {
        attempted++;
        return runRoutedJudgeAttempt({ model: model as never, modelId: 'claude-sonnet-5', judgeFamily: 'claude',
          brainFamily: 'byo', selfJudge: false, transport: 'test' } as never,
        instructions.text, prompt.text, parseCompletionVerdict, true, evidence, stop.signal, 'medium', undefined,
        { priorOpinion: value => { priorOpinionDisposition = value; } }, undefined, seed);
      };
      const operation = boundary === 'changed_owner'
        ? modelUsageAttributionStorage.run({ ...owner, attemptId: 'attempt:foreign' }, invoke) : invoke();
      if (boundary === 'both_overflow' || boundary === 'cloned_composition') {
        await assert.rejects(operation, /Complete evidence review unavailable/);
      } else if (boundary === 'changed_owner') {
        await assert.rejects(operation, /optional review opinion is no longer owned/);
      } else if (boundary === 'cancelled') {
        await assert.rejects(operation, { name: 'AbortError' });
      } else {
        const verdict = await operation;
        assert.equal(verdict.done, true); assert.equal(requests.length, 1);
        const sent = requests[0]!.input as Array<{ role: string; content: string }>;
        const expectedPrompt = boundary === 'optional_overflow' ? without : prompt.text;
        assert.equal(String(sent[0]!.content), expectedPrompt + suffix, 'only the owned note differs; full source and refs are byte-identical');
        assert.equal(requests[0]!.systemInstructions, fullInstructions + INSTRUCTION_CACHE_DELIM);
        assert.equal(requests[0]!.modelSettings.reasoning?.effort, 'medium');
        assert.equal(priorOpinionDisposition, boundary === 'optional_overflow' ? 'omitted_context_limit' : 'forwarded');
        for (const required of [request, candidate, context.agentInstructions!, context.toolCallSummary, HOST_COMPLETION_EVIDENCE_GUIDANCE]) {
          assert.ok((String(requests[0]!.systemInstructions) + String(sent[0]!.content)).includes(required));
        }
      }
      assert.equal(requests.length, boundary === 'fits' || boundary === 'optional_overflow' ? 1 : 0,
        'failed ownership/cancellation/complete admission cannot cause a provider request');
      return { verdict: requests.length ? judged.verdict : null, failure: requests.length ? null : 'error',
        priorOpinionDisposition: priorOpinionDisposition ?? 'not_dispatched' };
    });
    let jevCalls = 0;
    _setSystemOneFetchForTests(async () => { jevCalls++; return jevResponse('abstained'); });
    await modelUsageAttributionStorage.run(owner, async () => {
      const verdict = await judgeObjectiveComplete(objective, reply, context);
      assert.equal(state.reviewerCalls(), 1); assert.equal(attempted, 1);
      assert.equal(jevCalls, 1,
        'an unchanged producer-owned completed abstention does not need another reading when the reviewer is unavailable');
      assert.equal(verdict.jevAttempt?.priorAssessment?.forwardedBeforeEntry, boundary === 'fits');
      if (boundary === 'optional_overflow') assert.equal(verdict.jevAttempt?.priorAssessment?.omissionReason, 'context_limit');
      if (boundary !== 'fits' && boundary !== 'optional_overflow') assert.equal(verdict.failedOpen, true);
    });
  });
}

for (const change of ['unchanged', 'requirements', 'evidence', 'memory', 'memory_requirement', 'inherited',
  'plan_surface', 'stakes', 'full_source', 'owner_source', 'owner_attempt',
  'accessor_context', 'accessor_owner', 'toJSON_context', 'toJSON_evidence', 'proxy_evidence', 'unstable_proxy',
  'symbol_context', 'nonenumerable_context', 'class_evidence', 'sparse_evidence', 'sparse_extra_numeric',
  'missing_owner', 'protocol_failure', 'partial_scores', 'cancelled'] as const) {
  test(`reviewer timeout reuses only the original complete current Jev abstention: ${change}`, async t => {
    const owner = { sessionId: read.sessionId!, sourceUserSeq: 60, attemptId: `attempt:screen-reuse-${change}` };
    const context: Context = { ...read, reviewInputOwner: owner, agentInstructions: 'Original standing requirement.',
      completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE,
      verifiedReadResults: read.verifiedReadResults!.map(row => ({ ...row })) };
    if (change === 'missing_owner') context.reviewInputOwner = undefined;
    rememberTurnMemoryForJudges(owner.sessionId, 'Original supplied judge memory.');
    const stop = new AbortController();
    let getterReads = 0; let toJSONCalls = 0; let proxyTraps = 0;
    const state = setup(t, async () => {
      if (change === 'requirements') context.agentInstructions = 'Changed standing requirement.';
      if (change === 'evidence') context.verifiedReadResults![0]!.contentComplete = false;
      if (change === 'memory') rememberTurnMemoryForJudges(owner.sessionId, 'Changed supplied judge memory.');
      if (change === 'memory_requirement') context.memoryRequirementContext = 'New durable memory requirement.';
      if (change === 'inherited') context.inheritedReadCoverage = [];
      if (change === 'plan_surface') context.reviewsPlan = true;
      if (change === 'stakes') context.reviewStakes = 'write';
      if (change === 'full_source') context.fullSourceEvidence = true;
      if (change === 'accessor_context') {
        const value = context.toolCallSummary;
        Object.defineProperty(context, 'toolCallSummary', { enumerable: true, get() { getterReads++; return value; } });
      }
      if (change === 'accessor_owner') {
        const value = owner.attemptId;
        Object.defineProperty(owner, 'attemptId', { enumerable: true, get() { getterReads++; return value; } });
      }
      if (change === 'toJSON_context') Object.defineProperty(context, 'toJSON', { enumerable: true,
        value() { toJSONCalls++; throw new Error('reuse must not execute this serializer'); } });
      if (change === 'toJSON_evidence') Object.defineProperty(context.verifiedReadResults![0], 'toJSON', { enumerable: true,
        value() { toJSONCalls++; return read.verifiedReadResults![0]; } });
      if (change === 'proxy_evidence' || change === 'unstable_proxy') {
        context.verifiedReadResults = new Proxy(context.verifiedReadResults!, {
          get(target, key, receiver) { proxyTraps++; return Reflect.get(target, key, receiver); },
          ownKeys(target) { proxyTraps++; if (change === 'unstable_proxy') target[0]!.contentComplete = false; return Reflect.ownKeys(target); },
        });
      }
      if (change === 'symbol_context') Object.defineProperty(context, Symbol('unsupported reuse field'), { value: 'x' });
      if (change === 'nonenumerable_context') Object.defineProperty(context, 'toolCallSummary', { value: context.toolCallSummary, enumerable: false });
      if (change === 'class_evidence') context.verifiedReadResults![0] = Object.assign(new class UnsupportedContext {}(), context.verifiedReadResults![0]!);
      if (change === 'sparse_evidence' || change === 'sparse_extra_numeric') {
        const sparse = new Array<NonNullable<Context['verifiedReadResults']>[number]>(1);
        if (change === 'sparse_extra_numeric') Object.defineProperty(sparse, '4294967295', {
          enumerable: true, value: { ...read.verifiedReadResults![0] },
        });
        assert.equal(Object.hasOwn(sparse, 0), false);
        context.verifiedReadResults = sparse;
      }
      if (change === 'owner_source') owner.sourceUserSeq++;
      if (change === 'owner_attempt') owner.attemptId = 'attempt:changed-owner';
      if (change === 'cancelled') stop.abort();
      return { verdict: null, failure: 'timeout' };
    });
    const requests: Array<{ state: { memory?: string; requirementContext?: string } }> = [];
    _setSystemOneFetchForTests(async (_url, init) => {
      requests.push(JSON.parse(String(init.body)));
      if (requests.length === 1 && change === 'protocol_failure') {
        return { status: 200, ok: true, text: async () => '{invalid response' };
      }
      if (requests.length === 1 && change === 'partial_scores') {
        const response = jevResponse('abstained');
        const payload = JSON.parse(await response.text());
        delete payload.answers.unsupported;
        return { ...response, text: async () => JSON.stringify(payload) };
      }
      return jevResponse('abstained');
    });
    await modelUsageAttributionStorage.run(owner, async () => {
      const run = Promise.resolve(withHarnessRunContext({ sessionId: owner.sessionId, sourceUserSeq: owner.sourceUserSeq,
        runAttemptId: owner.attemptId, turn: 1, counter: new ToolCallsCounter(4), callerCancelSignal: stop.signal },
      () => judgeObjectiveComplete(objective, reply, context)));
      if (change === 'cancelled') {
        await assert.rejects(run, { name: 'AbortError' });
      } else {
        const verdict = await run;
        assert.equal(verdict.done, true, 'the existing unreviewed publication policy remains unchanged');
        assert.equal(verdict.failedOpen, true);
        assert.equal(verdict.reviewFailure, 'timeout');
        assert.equal(verdict.fast, undefined, 'an abstention never becomes an accepted Jev verdict');
        assert.equal(verdict.judgeModelId, undefined, 'no completed reviewer identity is fabricated');
      }
      assert.equal(state.reviewerCalls(), 1, 'the configured review is attempted once at its existing depth');
      assert.equal(requests.length, change === 'unchanged' || change === 'cancelled' ? 1 : 2,
        'only the same complete current original screen can suppress the late fallback; Stop starts none');
      if (change === 'memory') assert.notEqual(requests[0]!.state.memory, requests[1]!.state.memory);
      if (change === 'requirements') assert.notEqual(requests[0]!.state.requirementContext, requests[1]!.state.requirementContext);
      if (change === 'accessor_context') assert.equal(getterReads, 1, 'only the existing fresh fallback request reads its supplied field');
      if (change.startsWith('toJSON')) assert.equal(toJSONCalls, 0, 'reuse diagnostics never invoke custom serialization');
      if (change === 'proxy_evidence' || change === 'unstable_proxy') assert.equal(proxyTraps, 0, 'actual Node proxies are rejected before traps');
      if (['accessor_context', 'accessor_owner', 'toJSON_context', 'toJSON_evidence', 'proxy_evidence', 'unstable_proxy',
        'symbol_context', 'nonenumerable_context', 'class_evidence', 'sparse_evidence', 'sparse_extra_numeric'].includes(change)) {
        assert.deepEqual(requests[0], requests[1], 'unsupported reuse diagnostics do not change the legacy request payload');
      }
    });
  });
}

test('an abstention completed after reviewer entry remains unsupported for late reuse', async t => {
  const owner = { sessionId: read.sessionId!, sourceUserSeq: 61, attemptId: 'attempt:late-screen-timeout' };
  const state = setup(t, async () => ({ verdict: null, failure: 'timeout' }));
  let first!: (value: ReturnType<typeof jevResponse>) => void;
  let started!: () => void;
  const whenStarted = new Promise<void>(resolve => { started = resolve; });
  let jevCalls = 0;
  _setSystemOneFetchForTests(async () => {
    jevCalls++;
    if (jevCalls === 1) return new Promise<ReturnType<typeof jevResponse>>(resolve => { first = resolve; started(); });
    return jevResponse('abstained');
  });
  await modelUsageAttributionStorage.run(owner, async () => {
    const run = judgeObjectiveComplete(objective, reply, { ...read, reviewStakes: undefined, reviewInputOwner: owner });
    // The existing one-second hedge enters while the initial transport still
    // has time to return a genuinely successful abstention.
    await whenStarted; t.mock.timers.tick(JEV_HEDGE_DELAY_MS); await flush();
    first(jevResponse('abstained'));
    const verdict = await run;
    assert.equal(state.reviewerCalls(), 1); assert.equal(jevCalls, 2);
    assert.equal(verdict.failedOpen, true); assert.equal(verdict.reviewFailure, 'timeout');
  });
});

test('a Jev abstention arriving after hedge entry cannot alter the sent request or cause another review', async t => {
  const owner = { sessionId: read.sessionId!, sourceUserSeq: 42, attemptId: 'attempt:late-opinion' };
  let reviewPrompt = '';
  const state = setup(t, async (request, candidate, context) => {
    reviewPrompt = buildObjectiveJudgePrompt(request, candidate, context); return judged;
  });
  const jev = pendingJev();
  await modelUsageAttributionStorage.run(owner, async () => {
    const run = judgeObjectiveComplete(objective, reply, { ...read, reviewStakes: undefined, reviewInputOwner: owner });
    await jev.whenStarted; t.mock.timers.tick(JEV_HEDGE_DELAY_MS); await flush();
    assert.equal(state.reviewerCalls(), 1); assert.doesNotMatch(reviewPrompt, /PRIOR MODEL OPINION/);
    jev.answer('abstained'); const result = await run;
    assert.equal(result.done, true); assert.equal(state.reviewerCalls(), 1);
    assert.equal(result.jevAttempt?.priorAssessment, undefined);
    assert.doesNotMatch(reviewPrompt, /PRIOR MODEL OPINION/);
  });
});

test('changed owner requirements invalidate an otherwise timely assessment without removing current context', async t => {
  const owner = { sessionId: read.sessionId!, sourceUserSeq: 43, attemptId: 'attempt:changed-opinion' };
  const context: Context = { ...read, reviewInputOwner: owner, agentInstructions: 'Original standing rule.' };
  let sent = '';
  const state = setup(t, async (request, candidate, supplied) => { sent = buildObjectiveJudgePrompt(request, candidate, supplied); return judged; });
  const jev = pendingJev();
  await modelUsageAttributionStorage.run(owner, async () => {
    const run = judgeObjectiveComplete(objective, reply, context);
    await jev.whenStarted; context.agentInstructions = 'Current standing rule.';
    jev.answer('abstained'); const result = await run;
    assert.equal(result.done, true); assert.equal(state.reviewerCalls(), 1); assert.equal(jev.calls(), 1);
    assert.ok(sent.includes('Current standing rule.')); assert.doesNotMatch(sent, /PRIOR MODEL OPINION/);
    assert.equal(result.jevAttempt?.priorAssessment, undefined);
  });
});

test('cancelled same-source abstention cannot start or populate a reviewer', async t => {
  const owner = { sessionId: read.sessionId!, sourceUserSeq: 44, attemptId: 'attempt:cancelled-opinion' };
  const state = setup(t), jev = pendingJev(), stop = new AbortController();
  await modelUsageAttributionStorage.run(owner, async () => {
    const run = Promise.resolve(withHarnessRunContext({ sessionId: owner.sessionId, sourceUserSeq: owner.sourceUserSeq,
      runAttemptId: owner.attemptId, turn: 1, counter: new ToolCallsCounter(4), callerCancelSignal: stop.signal },
    () => judgeObjectiveComplete(objective, reply, { ...read, reviewInputOwner: owner })));
    const rejected = assert.rejects(run, { name: 'AbortError' });
    await jev.whenStarted; stop.abort(); jev.answer('abstained'); await rejected;
    assert.equal(state.reviewerCalls(), 0); assert.equal(jev.calls(), 1);
  });
});

test('Jev receives exact host semantics separately from full source evidence', async t => {
  const state = setup(t);
  let payload: { state: { evidence?: string; requirementContext?: string; request?: string; response?: string } } | undefined;
  _setSystemOneFetchForTests(async (_url, init) => {
    payload = JSON.parse(String(init.body));
    return jevResponse();
  });
  const verdict = await judgeObjectiveComplete(objective, reply, {
    ...read, completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE,
  });
  assert.equal(verdict.fast, true);
  assert.equal(state.reviewerCalls(), 0);
  assert.equal(payload?.state.request, objective);
  assert.equal(payload?.state.response, reply);
  assert.ok(payload?.state.evidence?.includes(read.toolCallSummary));
  assert.ok(payload?.state.evidence?.includes(read.verifiedReads!));
  assert.equal(payload?.state.requirementContext, HOST_COMPLETION_EVIDENCE_GUIDANCE);
  assert.equal(payload?.state.evidence?.includes(HOST_COMPLETION_EVIDENCE_GUIDANCE), false);
});

for (const owner of ['getters', 'proxy'] as const) {
  test(`Jev instruction preflight preserves legacy ${owner} option read order without rendering a discarded prompt`, async t => {
    const state = setup(t);
    const reads: string[] = [];
    let payload: { state: { requirementContext?: string; request?: string; response?: string } } | undefined;
    _setSystemOneFetchForTests(async (_url, init) => { payload = JSON.parse(String(init.body)); return jevResponse(); });
    const values = { completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE, fullSourceEvidence: true,
      memoryRequirementContext: undefined };
    const context: Context = owner === 'getters' ? { ...read,
      get completionEvidenceGuidance() { reads.push('guide'); return values.completionEvidenceGuidance; },
      get fullSourceEvidence() { reads.push('full'); return values.fullSourceEvidence; },
      get memoryRequirementContext() { reads.push('memory'); return values.memoryRequirementContext; },
    } : new Proxy({ ...read, ...values }, { get(target, key, receiver) {
      if (key === 'completionEvidenceGuidance') reads.push('guide');
      if (key === 'fullSourceEvidence') reads.push('full');
      if (key === 'memoryRequirementContext') reads.push('memory');
      return Reflect.get(target, key, receiver);
    } });
    const expected = ['guide', 'guide', 'full', 'guide', 'guide', 'memory', 'full', 'guide'];
    const instructions = buildCompletionJudgeInstructions(context);
    assert.deepEqual(reads, expected, 'actual renderer reads the original options in the original order');
    assert.equal(instructions, buildCompletionJudgeInstructions({ ...read, ...values }));
    reads.length = 0;
    const verdict = await judgeObjectiveComplete(objective, reply, context);
    assert.equal(verdict.fast, true); assert.equal(state.reviewerCalls(), 0);
    assert.deepEqual(reads, ['memory', ...expected, 'guide'], 'read eligibility and the later requirement-context guide read keep their original order too');
    assert.equal(payload?.state.requirementContext, HOST_COMPLETION_EVIDENCE_GUIDANCE);
    assert.equal(payload?.state.request, objective); assert.equal(payload?.state.response, reply);
  });
}

test('instruction option validation retains wrong-guidance and getter throw precedence', () => {
  const reads: string[] = [];
  const wrong = { get completionEvidenceGuidance() { reads.push('guide'); return 'different host rules'; },
    get fullSourceEvidence() { reads.push('full'); return true; } };
  assert.throws(() => buildCompletionJudgeInstructions(wrong as never), /must match the retained host rules exactly/);
  assert.deepEqual(reads, ['guide', 'guide']);
  reads.length = 0;
  const interrupted = { get completionEvidenceGuidance() { reads.push('guide'); return HOST_COMPLETION_EVIDENCE_GUIDANCE; },
    get fullSourceEvidence() { reads.push('full'); return true; },
    get memoryRequirementContext(): never { reads.push('memory'); throw new Error('fixture option interrupted'); } };
  assert.throws(() => buildCompletionJudgeInstructions(interrupted), /fixture option interrupted/);
  assert.deepEqual(reads, ['guide', 'guide', 'full', 'guide', 'guide', 'memory']);
});

for (const historical of [false, true]) {
  test(`${historical ? 'historical' : 'ordinary'} review preserves full standing instructions and exact skill versions beside host rules`, async t => {
    const state = setup(t);
    const request = historical ? 'Report only what the earlier status read showed.' : objective;
    const response = historical ? 'The earlier status read showed ready; it has not been checked again.' : reply;
    const skills: Context['skills'] = [
      { name: 'status-reference', body: '  Use the exact observed value.\nDo not invent a fresh read.\n',
        bodyDigest: 'e'.repeat(64), evidenceStatus: 'verified',
        origins: [{ callId: 'call:skill:one', readEventSeq: 1, sourceUserSeq: 1, scope: 'prior_source', authority: 'exact' }] },
      { name: 'status-reference', body: 'Alternative retained version; this version does not override an adopted one.',
        bodyDigest: 'f'.repeat(64), evidenceStatus: 'verified',
        origins: [{ callId: 'call:skill:two', readEventSeq: 2, sourceUserSeq: 2, scope: 'current_source', authority: 'exact' }] },
    ];
    const instructions = 'Agent: Status auditor\nStanding instructions:\nReport past observations with their recorded time; do not ask a delegated display choice again.';
    const context: Context = { ...read, skills, agentInstructions: instructions,
      completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE,
      ...(historical ? { verifiedReadResults: [], historicalEvidence: historicalPacket(request, response) } : {}) };
    let posted: { state: Record<string, any>; questions: Record<string, any> } | undefined;
    _setSystemOneFetchForTests(async (_url, init) => {
      posted = JSON.parse(String(init.body));
      const result = JSON.parse(await jevResponse().text());
      if (historical) Object.assign(result.answers, {
        historicalOnly: { type: 'noul', noul: .95 },
        historicalGroup: { type: 'choice', choice: 'historical_source_1', confidence: .95,
          probabilities: { historical_source_1: .95 } },
      });
      return { status: 200, ok: true, text: async () => JSON.stringify(result) };
    });
    const verdict = await judgeObjectiveComplete(request, response, context);
    assert.equal(verdict.fast, true);
    assert.equal(state.reviewerCalls(), 0);
    const requirements = posted!.state.requirementContext as string;
    assert.equal(requirements.split(HOST_COMPLETION_EVIDENCE_GUIDANCE).length - 1, 1);
    assert.ok(requirements.includes(instructions), 'no standing-instruction text is shortened');
    for (const skill of skills) assert.ok(requirements.includes(renderSkillReference(skill)), 'scope, digest, full body and version are unchanged');
    const dynamicRequirements = requirements.slice(HOST_COMPLETION_EVIDENCE_GUIDANCE.length + 1);
    assert.ok(buildObjectiveJudgePrompt(request, response, context).includes(dynamicRequirements),
      'the configured reviewer gets exactly the same reference and standing blocks');
    assert.match(requirements, /does not adopt every step or add deliverables/);
    assert.match(posted!.questions.unaddressed.instructions, /requirementContext/);
    assert.match(posted!.questions.asksUser.instructions, /already settled or delegated/);
    if (historical) {
      assert.equal(posted!.state.evidence, undefined, 'current prose is not promoted to historical receipts');
      assert.equal(posted!.state.currentReviewContext, context.toolCallSummary, 'current requirements/contrary context is retained separately');
      assert.equal(posted!.state.historicalEvidence.groups[0].warnings[0].outcome, 'unknown');
      assert.match(posted!.questions.historicalOnly.instructions, /applicable requirements in requirementContext/);
    }
  });
}

for (const decision of ['done', 'awaiting'] as const) {
  test(`reopened accepted owner-context tail cannot disappear behind historical ${decision} closure`, async t => {
    const request = 'Report only the earlier observation in the delegated display.';
    const response = decision === 'done' ? 'The earlier source was ready; the prior write is settled.'
      : 'Should I use the work display or personal display?';
    const session = createSession({ id: `reopened-historical-owner-${decision}`, kind: 'chat' });
    const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: request } });
    const identity = { sessionId: session.id, sourceUserSeq: source.seq };
    const requiredTail = 'OWNER TAIL: the work display is already delegated; report the prior write as uncertain, never settled.';
    recordAcceptedModelMemory(identity, [
      'Accepted contextual observations. '.repeat(260),
      "THE OWNER'S STANDING INSTRUCTIONS, AS THE WORK HAD THEM\n" + requiredTail,
    ], 'fixture:accepted-response');
    closeEventLog();
    _resetJudgeMemoryForTest();
    const summary = acceptedModelMemoryEvidence(identity)!;
    assert.ok(summary.indexOf(requiredTail) > 6_000, 'the relevant instruction is beyond prior courtesy/producer caps');
    assert.equal(judgeMemoryFor(session.id), '', 'no process-local memory can rescue a dropped persisted context');
    let posted: { state: Record<string, any>; questions: Record<string, any> } | undefined;
    const state = setup(t, async () => ({ verdict: { done: false, reason: 'The exact accepted owner tail was not followed.' }, failure: null }));
    _setSystemOneFetchForTests(async (_url, init) => {
      posted = JSON.parse(String(init.body));
      // This reader would miss the requirement if the historical branch
      // discarded it. The fixture decides only from the exact posted context.
      const result = JSON.parse(await jevResponse(posted!.state.currentReviewContext?.includes(requiredTail)
        ? 'incomplete' : decision).text());
      Object.assign(result.answers, { historicalOnly: { type: 'noul', noul: .95 },
        historicalGroup: { type: 'choice', choice: 'historical_source_1', confidence: .95,
          probabilities: { historical_source_1: .95 } } });
      return { status: 200, ok: true, text: async () => JSON.stringify(result) };
    });
    const verdict = await judgeObjectiveComplete(request, response, { sessionId: session.id, skills: [],
      reviewStakes: 'read', completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE,
      toolCallSummary: summary, verifiedReadResults: [],
      historicalEvidence: historicalPacket(request, response, session.id, source.seq) });
    assert.equal(posted!.state.currentReviewContext, summary, 'the persisted, exact source-owned context arrives whole');
    assert.equal(posted!.state.memory, undefined);
    assert.equal(posted!.state.evidence, undefined);
    assert.match(posted!.state.currentReviewContextNote, /cannot settle an unknown original effect or replace historical proof/);
    assert.match(posted!.questions.unaddressed.instructions, /exact accepted owner context in currentReviewContext/);
    assert.match(posted!.questions.asksUser.instructions, /currentReviewContext/);
    assert.equal(verdict.done, false);
    assert.equal(verdict.awaitingUser, undefined);
    assert.equal(verdict.fast, undefined);
    assert.equal(state.reviewerCalls(), 1);
  });
}

for (const decision of ['done', 'awaiting'] as const) {
  test(`oversized exact historical review context cannot buy a clipped ${decision} verdict`, async t => {
    const state = setup(t);
    const request = 'Report only the earlier observation.';
    const response = decision === 'done' ? 'The earlier status was ready.' : 'Which display should I use?';
    let posts = 0;
    _setSystemOneFetchForTests(async () => { posts++; return jevResponse(decision); });
    const verdict = await judgeObjectiveComplete(request, response, { sessionId: read.sessionId!, skills: [],
      completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE, reviewStakes: 'read',
      toolCallSummary: 'Exact accepted contextual observations. '.repeat(2_000)
        + 'The tail owner instruction forbids declaring the prior unknown effect settled.',
      verifiedReadResults: [], historicalEvidence: historicalPacket(request, response) });
    assert.equal(posts, 0, 'the full exact context is mandatory even when historical receipts are short');
    assert.equal(state.reviewerCalls(), 1);
    assert.equal(verdict.fast, undefined);
  });
}

for (const decision of ['done', 'awaiting'] as const) {
  for (const oversized of ['requirements', 'evidence'] as const) {
    test(`${oversized} that cannot fit routes ${decision} to the configured reviewer without a clipped positive screen`, async t => {
      const state = setup(t);
      let jevCalls = 0;
      _setSystemOneFetchForTests(async () => { jevCalls++; return jevResponse(decision); });
      const context: Context = { ...read, completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE,
        ...(oversized === 'requirements' ? { agentInstructions: 'Late applicable constraint. '.repeat(4_000) }
          : { toolCallSummary: 'Full source evidence. '.repeat(5_000) }) };
      const verdict = await judgeObjectiveComplete(objective,
        decision === 'awaiting' ? 'Should I use the work file or the personal file?' : reply, context);
      assert.equal(jevCalls, 0);
      assert.equal(state.reviewerCalls(), 1);
      assert.notEqual(verdict.fast, true);
      assert.equal(verdict.awaitingUser, undefined);
    });
  }
}

for (const reviewerAvailable of [true, false]) {
  test(`exact inherited-read attestation stays with the configured reviewer when it is ${reviewerAvailable ? 'available' : 'unavailable'}`, async t => {
    const inherited: NonNullable<Context['inheritedReadCoverage']> = [{ toolName: 'read_file',
      logicalToolCallId: 'inherited-read:rh_exact', outcome: 'succeeded', status: 'verified',
      evidenceKind: 'origin_qualified_inherited_read', contentComplete: false, sourceExhausted: false,
      contentDigest: '9'.repeat(64), rawByteCount: 1_000, shownByteCount: 120 }];
    const context: Context = { ...read, inheritedReadCoverage: inherited, fullSourceEvidence: true,
      evidence: { refKind: 'exact inherited refs', refs: () => ['inherited-read:rh_exact'],
        resolve: () => ({ text: 'The exact original source content.' }) },
      toolCallSummary: 'Origin-qualified parent preview; contrary unknown write remains unresolved.\n' + read.toolCallSummary };
    const state = setup(t, async (_objective, _reply, seen) => {
      assert.equal(seen?.inheritedReadCoverage, inherited);
      assert.equal(seen?.evidence, context.evidence, 'exact open/attestation source is preserved');
      assert.equal(seen?.verifiedReadResults, read.verifiedReadResults, 'a current complete read remains separate');
      return reviewerAvailable ? judged : { verdict: null, failure: 'error', unavailableReason: 'Synthetic reviewer unavailable.' };
    });
    let jevCalls = 0;
    _setSystemOneFetchForTests(async () => { jevCalls++; return jevResponse(); });
    const verdict = await judgeObjectiveComplete(objective, reply, context);
    assert.equal(state.reviewerCalls(), 1);
    assert.equal(jevCalls, 0, 'neither current counts nor late fallback may waive inherited coverage');
    assert.equal(verdict.fast, undefined);
    assert.equal(Boolean(verdict.failedOpen), !reviewerAvailable, 'unavailable full review stays explicitly unqualified');
  });
}

test('a complete ordinary read lets a 1.9 s affirmative Jev check settle without speculative review', async t => {
  const state = setup(t), jev = pendingJev();
  const pending = judgeObjectiveComplete(objective, reply, read);
  await jev.whenStarted;
  assert.equal(jev.calls(), 1);
  t.mock.timers.tick(JEV_HEDGE_DELAY_MS + 1); await flush();
  assert.equal(state.reviewerCalls(), 0, 'the former 1 s timer must not start a complete-read reviewer');
  t.mock.timers.tick(899); jev.answer();
  const verdict = await pending;
  assert.equal(verdict.done, true);
  assert.equal(verdict.fast, true);
  assert.equal(verdict.jevAttempt?.accepted, true);
  assert.equal(verdict.jevAttempt?.reviewerStarted, false);
  assert.equal(verdict.judgeModelId, 'jev-1.13.0');
  t.mock.timers.tick(JEV_READ_HEDGE_DELAY_MS + 1); await flush();
  assert.equal(state.reviewerCalls(), 0, 'the settled hedge must be cleared');
});

test('an incomplete Jev finding starts the configured reviewer immediately, with no extra delay', async t => {
  const state = setup(t, async () => ({ verdict: { done: false, reason: 'The requested part remains absent.' }, failure: null }));
  _setSystemOneFetchForTests(async () => jevResponse('incomplete'));
  const verdict = await judgeObjectiveComplete(objective, 'I will read the missing status.', read);
  assert.equal(state.reviewerCalls(), 1);
  assert.equal(verdict.done, false);
  assert.equal(verdict.jevAttempt?.accepted, false);
  assert.notEqual(verdict.fast, true);
});

for (const kind of ['missing_key', 'malformed_response', 'http_error'] as const) {
  test(`a ${kind} screen falls through without waiting for the complete-read window`, async t => {
    const state = setup(t);
    if (kind === 'missing_key') _setTypesafeKeyForTests(null);
    _setSystemOneFetchForTests(async () => kind === 'http_error'
      ? { status: 503, ok: false, text: async () => 'synthetic unavailable' }
      : { status: 200, ok: true, text: async () => 'unparseable synthetic response' });
    const verdict = await judgeObjectiveComplete(objective, reply, read);
    assert.equal(state.reviewerCalls(), 1);
    assert.equal(verdict.done, true);
    assert.notEqual(verdict.judgeModelId, 'jev-1.13.0');
  });
}

test('the existing 2.5 s Jev timeout starts only one configured reviewer and cannot certify Jev', async t => {
  const state = setup(t);
  let aborted = 0;
  let started!: () => void;
  const whenStarted = new Promise<void>(resolve => { started = resolve; });
  _setSystemOneFetchForTests((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted++; reject(new DOMException('synthetic bounded timeout', 'AbortError'));
    }, { once: true });
    started();
  }));
  const pending = judgeObjectiveComplete(objective, reply, read);
  await whenStarted;
  t.mock.timers.tick(JEV_READ_HEDGE_DELAY_MS - 1); await flush();
  assert.equal(state.reviewerCalls(), 0);
  assert.equal(aborted, 0);
  t.mock.timers.tick(1); await flush();
  const verdict = await pending;
  assert.equal(aborted, 1, 'read hedge stays aligned with the actual completion transport deadline');
  assert.equal(state.reviewerCalls(), 1);
  assert.equal(verdict.done, true);
  assert.notEqual(verdict.fast, true);
  assert.notEqual(verdict.judgeModelId, 'jev-1.13.0');
});

for (const kind of ['unknown_stakes', 'direction_question'] as const) {
  test(`${kind} preserves the existing 1 s hedge and cancels its losing reviewer`, async t => {
    let reviewerSignal: AbortSignal | undefined;
    const state = setup(t, async (_objective, _reply, _context, judge) => {
      reviewerSignal = judge?.signal; return judged;
    });
    const jev = pendingJev();
    const pending = judgeObjectiveComplete(objective,
      kind === 'direction_question' ? 'Should I use the work file or the personal file?' : reply,
      kind === 'unknown_stakes' ? { ...read, reviewStakes: undefined } : read);
    await jev.whenStarted;
    t.mock.timers.tick(JEV_HEDGE_DELAY_MS); await flush();
    assert.equal(state.reviewerCalls(), 1);
    jev.answer(kind === 'direction_question' ? 'awaiting' : 'done');
    const verdict = await pending;
    assert.equal(verdict.jevAttempt?.accepted, true);
    assert.equal(verdict.jevAttempt?.reviewerStarted, true);
    assert.equal(reviewerSignal?.aborted, true);
    assert.equal(Boolean(verdict.awaitingUser), kind === 'direction_question');
  });
}

for (const [name, context] of [
  ['prepared_plan', { ...read, reviewsPlan: true, reviewStakes: 'plan' }],
  ['effectful_write', { ...read, reviewStakes: 'write' }],
  ['required_memory', { ...read, memoryRequirementContext: 'The owner explicitly required this fact to be retained.' }],
  ['partial_read', { ...read, verifiedReadResults: [{ ...read.verifiedReadResults![0]!, contentComplete: false }] }],
  ['failed_read', { ...read, verifiedReadResults: [{ ...read.verifiedReadResults![0]!, outcome: 'failed', status: 'not_succeeded' }] }],
] satisfies Array<[string, Context]>) {
  test(`${name} still starts the configured reviewer directly`, async t => {
    const state = setup(t);
    let jevCalls = 0;
    _setSystemOneFetchForTests(async () => { jevCalls++; return jevResponse(); });
    const verdict = await judgeObjectiveComplete(objective, reply, context);
    assert.equal(state.reviewerCalls(), 1);
    assert.equal(jevCalls, 0, 'ineligible evidence/stakes cannot wait for or settle through Jev');
    assert.equal(verdict.done, true);
    assert.equal(verdict.jevAttempt, undefined);
  });
}

test('Stop during the read window clears the hedge and a later Jev DONE cannot deliver a verdict', async t => {
  const state = setup(t), jev = pendingJev(), stop = new AbortController();
  const pending = Promise.resolve(withHarnessRunContext({ sessionId: read.sessionId!, turn: 1,
    counter: new ToolCallsCounter(4), callerCancelSignal: stop.signal },
  () => judgeObjectiveComplete(objective, reply, read)));
  const stopped = assert.rejects(pending, { name: 'AbortError' });
  await jev.whenStarted;
  t.mock.timers.tick(1_200); stop.abort();
  t.mock.timers.tick(JEV_READ_HEDGE_DELAY_MS + 1); await flush();
  assert.equal(state.reviewerCalls(), 0, 'Stop must prevent a delayed configured reviewer');
  jev.answer(); await stopped;
  assert.equal(state.reviewerCalls(), 0);
});

for (const reportedModel of [true, false]) {
  test(`accepted Jev-fast original reading joins its actual invocation and usage: reported model ${reportedModel}`, async t => {
    const state = setup(t);
    const session = createSession({ id: `fast-reading-original-${reportedModel}`, kind: 'chat' });
    const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: objective } });
    const owner = { sessionId: session.id, sourceUserSeq: source.seq, attemptId: `attempt:fast-reading-${reportedModel}` };
    const context: Context = { ...read, sessionId: session.id, reviewInputOwner: owner,
      agentInstructions: 'PRIVATE_FAST_READING_INSTRUCTIONS' };
    const { withModelTransportRecorder } = await import('./model-transport-observation.js');
    const { readUsageEventsForDate } = await import('../usage-log.js');
    const { parseSystemOneResponse } = await import('../jev/system-one.js');
    const rows: Readonly<Record<string, unknown>>[] = [];
    let calls = 0, posted = '', returnedBody: unknown;
    _setSystemOneFetchForTests(async (_url, init) => {
      calls++; posted = init.body;
      const payload = JSON.parse(await jevResponse().text());
      if (!reportedModel) delete payload.model;
      returnedBody = payload;
      return { status: 200, ok: true, text: async () => JSON.stringify(payload) };
    });
    const verdict = await withModelTransportRecorder(row => rows.push(row), () => modelUsageAttributionStorage.run(owner,
      () => judgeObjectiveComplete(objective, reply, context)));
    assert.equal(verdict.done, true); assert.equal(verdict.fast, true);
    assert.equal(verdict.jevAttempt?.accepted, true); assert.equal(state.reviewerCalls(), 0); assert.equal(calls, 1);
    const reading = verdict.jevAttempt?.originalReading;
    assert.ok(reading, 'a same-call private assessment supplies an optional original-reading diagnostic');
    assert.equal(reading.scope, 'diagnostic_only'); assert.deepEqual(reading.owner, owner);
    assert.equal(reading.physicalAttempt, 1);
    const local = rows.filter(row => row.phase === 'adapter_attempt_created' || row.phase === 'adapter_attempt_finished');
    assert.equal(local.length, 2); assert.equal(local[1].outcome, 'returned');
    assert.equal(reading.modelCallId, local[0].modelCallId); assert.equal(local[1].modelCallId, reading.modelCallId);
    const usage = readUsageEventsForDate().filter(row => row.trace?.modelCallId === reading.modelCallId);
    assert.equal(usage.length, 1); assert.equal(usage[0].trace?.acceptedSource, `${owner.sessionId}:${owner.sourceUserSeq}`);
    assert.equal(usage[0].trace?.attemptId, owner.attemptId); assert.equal(usage[0].role, 'router');
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const request = JSON.parse(posted);
    assert.equal(reading.requestBodySha256, hash(posted));
    assert.equal(reading.questionnaireSha256, hash(JSON.stringify(request.questions)));
    assert.equal(reading.originalResultSha256, hash(JSON.stringify({ ...parseSystemOneResponse(returnedBody, request.questions), status: 200 })));
    assert.equal(reading.objectiveDigest, hash(objective)); assert.equal(reading.candidateDigest, hash(reply));
    assert.match(reading.contextDigest, /^[a-f0-9]{64}$/); assert.match(reading.reviewInvocationId, /^[a-f0-9-]{36}$/);
    assert.equal(reading.requestedModel, 'jev-1.13.0');
    assert.equal(reading.providerReportedModel, reportedModel ? 'jev-1.13.0' : undefined);
    assert.equal(Object.hasOwn(reading, 'providerReportedModel'), reportedModel);
    assert.equal(reading.accountBackend, 'unknown'); assert.equal(reading.providerResponseIdentity, 'unknown');
    assert.equal(verdict.jevAttempt?.priorAssessment, undefined, 'a fast return does not claim reviewer forwarding');
    assert.doesNotMatch(JSON.stringify(reading), /PRIVATE_FAST_READING_INSTRUCTIONS|read_file|source says|ts_read_first_fixture/);
  });
}

for (const change of ['stale_context', 'stale_owner', 'foreign_owner', 'unowned', 'projection_error'] as const) {
  test(`accepted Jev-fast omits an unavailable original reading without changing its verdict: ${change}`, async t => {
    const state = setup(t), jev = pendingJev();
    const owner = { sessionId: read.sessionId!, sourceUserSeq: 71, attemptId: `attempt:fast-reading-${change}` };
    const context: Context = { ...read, reviewInputOwner: { ...owner }, agentInstructions: 'Original standing requirement.' };
    if (change === 'foreign_owner') context.reviewInputOwner = { ...owner, attemptId: 'attempt:foreign-reading' };
    const invoke = () => judgeObjectiveComplete(objective, reply, context);
    const run = change === 'unowned' ? invoke() : modelUsageAttributionStorage.run(owner, invoke);
    await jev.whenStarted;
    if (change === 'stale_context') context.agentInstructions = 'Changed current standing requirement.';
    if (change === 'stale_owner') context.reviewInputOwner = { ...owner, attemptId: 'attempt:changed-current-reading' };
    if (change === 'projection_error') Object.defineProperty(context, 'toolCallSummary', {
      enumerable: true, get() { throw new Error('PRIVATE_OPTIONAL_PROJECTION_ERROR'); },
    });
    jev.answer();
    const verdict = await run;
    assert.equal(verdict.done, true); assert.equal(verdict.fast, true); assert.equal(verdict.jevAttempt?.accepted, true);
    assert.equal(verdict.jevAttempt?.originalReading, undefined);
    assert.equal(verdict.jevAttempt?.reviewerStarted, false); assert.equal(state.reviewerCalls(), 0); assert.equal(jev.calls(), 1);
  });
}

test('Stop while an original Jev-fast reading is pending emits no accepted verdict or reviewer request', async t => {
  const state = setup(t), jev = pendingJev(), stop = new AbortController();
  const owner = { sessionId: read.sessionId!, sourceUserSeq: 72, attemptId: 'attempt:fast-reading-cancelled' };
  const run = Promise.resolve(modelUsageAttributionStorage.run(owner, () => withHarnessRunContext({
    sessionId: owner.sessionId, sourceUserSeq: owner.sourceUserSeq, runAttemptId: owner.attemptId,
    turn: 1, counter: new ToolCallsCounter(4), callerCancelSignal: stop.signal,
  }, () => judgeObjectiveComplete(objective, reply, { ...read, reviewInputOwner: owner }))));
  const rejected = assert.rejects(run, { name: 'AbortError' });
  await jev.whenStarted; stop.abort(); jev.answer(); await rejected;
  assert.equal(state.reviewerCalls(), 0); assert.equal(jev.calls(), 1);
});

for (const lane of ['configured_reviewer', 'late_fallback'] as const) {
  test(`original-reading diagnostic is confined to the initial accepted fast return: ${lane}`, async t => {
    const state = setup(t, async () => lane === 'late_fallback' ? { verdict: null, failure: 'timeout' } : judged);
    const owner = { sessionId: read.sessionId!, sourceUserSeq: 73, attemptId: `attempt:fast-reading-${lane}` };
    let calls = 0;
    _setSystemOneFetchForTests(async () => { calls++; return jevResponse(lane === 'late_fallback' ? 'done' : 'incomplete'); });
    const verdict = await modelUsageAttributionStorage.run(owner, () => judgeObjectiveComplete(objective, reply, {
      ...read, reviewInputOwner: owner, ...(lane === 'late_fallback' ? { reviewStakes: 'write' } : {}),
    }));
    assert.equal(verdict.done, true); assert.equal(verdict.fast, undefined);
    assert.equal(verdict.jevAttempt?.originalReading, undefined);
    assert.equal(state.reviewerCalls(), 1); assert.equal(calls, 1);
    assert.equal(Boolean(verdict.failedOpen), lane === 'late_fallback');
    assert.equal(verdict.jevAttempt?.accepted, false);
  });
}
