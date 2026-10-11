import assert from 'node:assert/strict';
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
} = await import('./objective-judge.js');
const { _setSystemOneFetchForTests, _setTypesafeKeyForTests } = await import('../jev/client.js');
const { _resetCompletionSizeGateForTests } = await import('../jev/control-plane.js');
const { closeEventLog, createSession, appendEvent } = await import('./eventlog.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('./brackets.js');
const { _resetJudgeMemoryForTest, judgeMemoryFor } = await import('../../memory/judge-memory.js');
const { recordAcceptedModelMemory, acceptedModelMemoryEvidence } = await import('./model-memory-evidence.js');
const { renderSkillReference } = await import('./skill-execution.js');
const { admitHistoricalReadPacket, historicalEvidenceDigest } = await import('./historical-completion-evidence.js');

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

function jevResponse(kind: 'done' | 'incomplete' | 'awaiting' = 'done') {
  const values = { delivered: 0.95, unaddressed: 0.03, unsupported: 0.03,
    computed: 0.03, asksUser: 0.03, cannotFinish: 0.03,
    ...(kind === 'incomplete' ? { delivered: 0.1, unaddressed: 0.95 } : {}),
    ...(kind === 'awaiting' ? { delivered: 0.2, asksUser: 0.95 } : {}),
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
