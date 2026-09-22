/**
 * Run: npx tsx --test src/runtime/harness/objective-judge.test.ts
 *
 * Pure + fail-open behavior of the objective judge. The live model call is
 * NOT unit-tested (covered via the loop's injected judgeFn tests).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveJudgeResponder, honestFailureReportSettles, boundedAttemptResultIsTerminal, buildObjectiveJudgePrompt, judgeObjectiveComplete, shouldRunObjectiveJudge, isPromiseShapedReply, clipForJudge, JUDGE_RESPONSE_MAX_CHARS, JUDGE_SYSTEM_PROMPT, parseCompletionVerdict, parseProgressVerdict, assessCompletionEvidenceCoverage, _setCompletionJudgeForTests, JEV_HEDGE_DELAY_MS } = await import('./objective-judge.js');
const { _setSystemOneFetchForTests, _setTypesafeKeyForTests } = await import('../jev/client.js');

function unavailableSettingsJudge() {
  return Promise.resolve({
    verdict: null,
    failure: 'error' as const,
    unavailableReason: 'A completion reviewer was unavailable; no review was completed.',
  });
}

afterEach(() => {
  _setTypesafeKeyForTests(undefined);
  _setSystemOneFetchForTests(undefined);
  _setCompletionJudgeForTests(unavailableSettingsJudge);
});
_setCompletionJudgeForTests(unavailableSettingsJudge);

test('parseProgressVerdict: on-contract PROGRESS/STUCK single-line verdicts (Wave 3 self-resume)', () => {
  assert.deepEqual(parseProgressVerdict('PROGRESS: fetched 12 new firm records this cycle'), { progressing: true, reason: 'fetched 12 new firm records this cycle' });
  assert.deepEqual(parseProgressVerdict('STUCK: re-running the same failing search'), { progressing: false, reason: 're-running the same failing search' });
  assert.equal(parseProgressVerdict('PROGRESS - advancing coverage across the sheet')?.progressing, true);
  // A STUCK marker on a later line still wins (preamble before the verdict line).
  assert.equal(parseProgressVerdict('Assessing progress...\nSTUCK: thrashing on the same call')?.progressing, false);
  assert.equal(parseProgressVerdict('some unparseable blob'), null);
  assert.equal(parseProgressVerdict(''), null);
});

// Regression for the Wave-3 adversarial-review finding: the old parser scanned the
// whole blob for the FIRST progress-ish token unanchored, so a STUCK verdict whose
// prose merely OPENED with the word "progress" parsed as PROGRESSING and GRANTED a
// stuck run more unattended compute — inverting the gate's fail-CLOSED guarantee.
// Every one of these must now be NOT progressing (park), never {progressing:true}.
test('parseProgressVerdict: FAILS CLOSED — a STUCK verdict phrased in prose never reads as PROGRESSING', () => {
  const stuckPhrasings = [
    'No real progress; STUCK: repeating the same failing call',
    'No forward progress — STUCK: looping',
    'Making no forward progress — STUCK',
    'The run shows no progress and is STUCK looping',
    'Progress toward the objective is minimal; the run is stuck.',
    'In terms of progress, the run is looping and blocked. STUCK.',
    'Progress: none. The run is thrashing.',
    'The run should not CONTINUE; it is STUCK on the same error.',
    'The task will not progress further; STUCK',
  ];
  for (const reply of stuckPhrasings) {
    assert.equal(parseProgressVerdict(reply)?.progressing, false, `must park (not progressing): ${JSON.stringify(reply)}`);
  }
  // Off-contract prose with no marker and no stuck-signal ⇒ null ⇒ caller parks.
  assert.equal(parseProgressVerdict('PROGRESSING nicely toward the sheet'), null);
  assert.equal(parseProgressVerdict('It made good headway toward the goal'), null);
});

const baseGate = {
  optIn: true,
  actionIntent: false,
  meaningfulToolEvidence: false,
  continuationsUsed: 0,
  maxContinuations: 3,
  nextAction: 'completed',
};

test('gate: fires for an explicit ACTION intent without meaningful evidence', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: true }), true);
});

test('gate: a promised lookup on a deictic conversation turn does not start completion review', () => {
  // The exemption is the CONVERSATION, not the absence of action intent. Left
  // as "actionIntent: false" alone it also swallowed a real lookup whose reply
  // deferred the lookup, which is the one turn the promise branch exists for.
  assert.equal(shouldRunObjectiveJudge({
    ...baseGate, actionIntent: false, conversationalIntent: true, promiseShaped: true,
  }), false);
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: true, promiseShaped: true }), true);
});

test('gate: a promise that defers a LOOKUP is still reviewed', () => {
  // "Read the current harness status and report it." -> "I will read the
  // status." Intent is lookup, so actionIntent is false and nothing has been
  // called yet; the owner must not have to nudge for the read.
  assert.equal(shouldRunObjectiveJudge({
    ...baseGate, actionIntent: false, conversationalIntent: false, promiseShaped: true,
  }), true);
  // Unset is the same as false: a caller that does not know the intent keeps the review.
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: false, promiseShaped: true }), true);
});

test('gate: skips concrete successful tool-backed completions instead of re-running work', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: true, meaningfulToolEvidence: true }), false);
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: false, meaningfulToolEvidence: true }), false);
});

test('gate: one successful mutation does not certify a multi-result objective', () => {
  assert.equal(shouldRunObjectiveJudge({
    ...baseGate,
    actionIntent: true,
    meaningfulToolEvidence: true,
    multiResultObjective: true,
  }), true);
});

test('gate: an accepted execution ledger certifies a tool-backed multi-result objective', () => {
  assert.equal(shouldRunObjectiveJudge({
    ...baseGate,
    actionIntent: true,
    meaningfulToolEvidence: true,
    multiResultObjective: true,
    acceptedExecutionEvidence: true,
  }), false);
});

test('gate: accepted execution does not hide an obviously promise-shaped final reply', () => {
  assert.equal(shouldRunObjectiveJudge({
    ...baseGate,
    actionIntent: true,
    meaningfulToolEvidence: true,
    multiResultObjective: true,
    acceptedExecutionEvidence: true,
    promiseShaped: true,
  }), true);
});

test('gate: does NOT fire for a trivial non-action lookup', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: false }), false);
});

test('gate: does NOT fire when the caller did not opt in', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, optIn: false, actionIntent: true }), false);
});

test('gate: does NOT fire once the continuation budget is exhausted', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: true, continuationsUsed: 3 }), false);
});

test('final verification can review the repaired candidate without granting another continuation', () => {
  const input = { ...baseGate, actionIntent: true, continuationsUsed: 3, reviewAtContinuationLimit: true };
  assert.equal(shouldRunObjectiveJudge(input), true);
  assert.equal(shouldRunObjectiveJudge({ ...input, optIn: false }), false);
  assert.equal(shouldRunObjectiveJudge({ ...input, openApprovalCard: true }), false);
  assert.equal(shouldRunObjectiveJudge({ ...input, continuationsUsed: 4 }), false);
});

test('gate: does NOT fire when nextAction is not completed (e.g. awaiting approval)', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: true, nextAction: 'awaiting_approval' }), false);
});

// ── Promise-shaped completion (the "I'll do that next" chatbot turn) ──────────

test('gate: FIRES for a promise-shaped reply even when it looks low-effort (the incident)', () => {
  // The exact shape that slipped through: non-action intent, 1 tool call, done.
  assert.equal(
    shouldRunObjectiveJudge({ ...baseGate, actionIntent: false, meaningfulToolEvidence: true, promiseShaped: true }),
    true,
  );
  // Without the promise signal, the same low-effort turn is NOT judged (unchanged).
  assert.equal(
    shouldRunObjectiveJudge({ ...baseGate, actionIntent: false, meaningfulToolEvidence: true, promiseShaped: false }),
    false,
  );
});

test('gate: a status/discovery call is not enough to judge a non-action Act turn', () => {
  // The live shape: mcp_status is a host control tool, so no business call.
  assert.equal(shouldRunObjectiveJudge({
    ...baseGate,
    actionIntent: false,
    meaningfulToolEvidence: false,
    sourceWorkAttempted: true,
  }), false);
  // A lookup that made a real business read stays review-eligible.
  assert.equal(shouldRunObjectiveJudge({
    ...baseGate,
    actionIntent: false,
    meaningfulToolEvidence: true,
    sourceWorkAttempted: true,
  }), true);
});

test('gate: claiming the work is done without a write still judges an action turn', () => {
  assert.equal(shouldRunObjectiveJudge({
    ...baseGate,
    actionIntent: true,
    meaningfulToolEvidence: true,
    claimedCompletedWork: true,
  }), true);
});

test('isPromiseShapedReply: future-tense promise with no artifact → true', () => {
  for (const p of [
    "Got it. I'll prep them as review-ready drafts, not send them yet.",
    'Going to put that report together for you.',
    "Let me go pull all the data and build the file.",
    'The check-in landed; next I’ll actually run the posts scraper against Scorpion’s Facebook page.',
  ]) {
    assert.equal(isPromiseShapedReply(p), true, `promise: ${p}`);
  }
});

test('isPromiseShapedReply: a real artifact/result suppresses the promise signal → false', () => {
  for (const r of [
    "Done — created the sheet: https://example.com/s/123",
    "Here's the summary of all 44 records.",
    "I've drafted the report and saved it to /tmp/out.html",
    'Found 5 accounts matching your filter.',
    "You're right — going forward I'll treat SEO data as raw metrics first.",
    "From now on I'll use the source column for those rows.",
    '', // empty
  ]) {
    assert.equal(isPromiseShapedReply(r), false, `not a bare promise: ${r}`);
  }
});

test('buildObjectiveJudgePrompt includes the objective and the assistant response', () => {
  const prompt = buildObjectiveJudgePrompt('build a report on X', 'Done — saved to /tmp/report.md');
  assert.match(prompt, /build a report on X/);
  assert.match(prompt, /\/tmp\/report\.md/);
});

test('judge contract treats upper bounds as ceilings and never authorizes forbidden retries', () => {
  const prompt = buildObjectiveJudgePrompt(
    'Make one call and return up to three results. Do not retry.',
    'The verified call returned zero results.',
  );
  assert.match(JUDGE_SYSTEM_PROMPT, /ceiling, not a minimum/i);
  assert.match(JUDGE_SYSTEM_PROMPT, /verification never grants authority/i);
  assert.match(prompt, /returned zero results/i);
});

test('bounded attempt: a meaningful call with an honest empty result is terminal', () => {
  assert.equal(
    boundedAttemptResultIsTerminal(
      'Make one real read-only call and return up to three suggestions. Do not retry.',
      'The configured endpoint returned zero suggestions for that exact query.',
      true,
    ),
    true,
  );
  assert.equal(
    boundedAttemptResultIsTerminal(
      'Make one real read-only call.',
      'Done.',
      true,
    ),
    false,
    'a bare completion claim is not evidence of a bounded result',
  );
  assert.equal(
    boundedAttemptResultIsTerminal(
      'Make one real read-only call.',
      'The endpoint returned zero results.',
      false,
    ),
    false,
    'request-bound meaningful tool evidence is required',
  );
});

test('clipForJudge passes a sub-cap body through untouched', () => {
  const r = clipForJudge('a short response');
  assert.equal(r.truncated, false);
  assert.equal(r.text, 'a short response');
});

test('clipForJudge windows head+tail and self-describes the elision', () => {
  const head = 'HEAD_MARKER ' + 'a'.repeat(JUDGE_RESPONSE_MAX_CHARS);
  const tailEvidence = ' saved to https://example.com/sheet TAIL_MARKER';
  const full = head + 'z'.repeat(2000) + tailEvidence;
  const r = clipForJudge(full);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < full.length, 'output is shorter than the full input');
  assert.ok(r.text.length <= JUDGE_RESPONSE_MAX_CHARS + 200, 'output stays near the cap (plus the small marker)');
  assert.match(r.text, /HEAD_MARKER/, 'keeps the head');
  assert.match(r.text, /TAIL_MARKER/, 'keeps the tail where artifact evidence clusters');
  assert.match(r.text, /elided from the MIDDLE for length/, 'tells the judge the middle was cut for length');
});

test('buildObjectiveJudgePrompt directs the judge not to penalize a windowed reply', () => {
  const prompt = buildObjectiveJudgePrompt('build a big report', 'B'.repeat(JUDGE_RESPONSE_MAX_CHARS + 5000));
  assert.match(prompt, /do not mark the objective incomplete merely because/i);
});

test('judgeObjectiveComplete fails OPEN (done:true) when there is no response text to judge', async () => {
  const v = await judgeObjectiveComplete('build a report', '');
  assert.equal(v.done, true);
});

test('judgeObjectiveComplete fails OPEN when the objective is empty', async () => {
  const v = await judgeObjectiveComplete('', 'some response');
  assert.equal(v.done, true);
});

test('judgeObjectiveComplete uses a confident Jev verdict and skips the chat-model judge', async () => {
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        verdict: {
          type: 'choice',
          choice: 'done',
          probabilities: { done: 0.91, incomplete: 0.09 },
          confidence: 0.88,
        },
        matches: { type: 'noul', noul: 0.9 },
      },
      usage: { input_tokens: 36, output_tokens: 4 },
    }),
  }));
  const v = await judgeObjectiveComplete(
    'Create /tmp/jev.txt containing JEV_OK',
    'Created /tmp/jev.txt with exactly JEV_OK plus one newline.',
    {
      sessionId: 'probe-jev-complete',
      skills: [],
      toolCallSummary: 'write_file succeeded',
      verifiedReadResults: [
        { toolName: 'write_file', outcome: 'succeeded', status: 'verified', contentComplete: true, evidenceKind: 'source_result' },
      ],
    },
  );
  assert.equal(v.done, true);
  assert.equal(v.judgeModelId, 'jev-1.13.0');
  assert.equal(v.failedOpen, undefined);
});

test('evidence coverage uses registry role and completeness, not vendor names', () => {
  const empty = assessCompletionEvidenceCoverage({
    objective: 'look up the named record and its window',
    results: [],
  });
  assert.equal(empty.missingCoverage, true);
  assert.equal(empty.complete, false);

  const discoveryOnly = assessCompletionEvidenceCoverage({
    objective: 'look up the named record and its window',
    results: [
      { toolName: 'tool_search', outcome: 'succeeded', contentDisposition: 'discovery_navigation', contentComplete: false },
    ],
  });
  assert.equal(discoveryOnly.missingCoverage, true);
  assert.equal(discoveryOnly.complete, false);

  const renamedCapability = assessCompletionEvidenceCoverage({
    objective: 'look up the named record',
    results: [
      { toolName: 'acme_record_lookup', outcome: 'succeeded', status: 'verified', contentComplete: true, evidenceKind: 'source_result' },
    ],
  });
  assert.equal(renamedCapability.complete, true, 'unfamiliar business names still count as outcome evidence');

  const executionWithoutOutcome = assessCompletionEvidenceCoverage({
    objective: 'write the fixture',
    results: [
      { toolName: 'write_file', outcome: 'succeeded', status: 'verified', contentComplete: false, evidenceKind: 'source_result' },
    ],
  });
  assert.equal(executionWithoutOutcome.complete, false, 'a succeeded call with an incomplete receipt is not outcome coverage');
  assert.equal(executionWithoutOutcome.incompleteReceipts.length, 1);

  const pagedSameCall = assessCompletionEvidenceCoverage({
    objective: 'look up the named record and its window',
    results: [
      { toolName: 'tool_search', outcome: 'succeeded', contentDisposition: 'discovery_navigation', contentComplete: false },
      { toolName: 'calendar_list_view', outcome: 'succeeded', status: 'verified', contentComplete: false, evidenceKind: 'source_result', logicalToolCallId: 'call-a', resultHandleId: 'rh_a', physicalDispatchId: 'disp-a' },
      { toolName: 'tool_output_query', outcome: 'succeeded', status: 'verified', contentComplete: true, evidenceKind: 'retained_projection', logicalToolCallId: 'query-a', sourceLogicalToolCallId: 'call-a', sourceResultHandleId: 'rh_a', sourcePhysicalDispatchId: 'disp-a' },
    ],
  });
  assert.equal(pagedSameCall.complete, true, 'a complete projection of the same call covers that truncated source');
  assert.equal(pagedSameCall.missingCoverage, false);
  assert.equal(pagedSameCall.incompleteReceipts.length, 0);

  const pagedDifferentCall = assessCompletionEvidenceCoverage({
    objective: 'look up the named record and its window',
    results: [
      { toolName: 'calendar_list_view', outcome: 'succeeded', status: 'verified', contentComplete: false, evidenceKind: 'source_result', logicalToolCallId: 'call-a', resultHandleId: 'rh_a' },
      { toolName: 'tool_output_query', outcome: 'succeeded', status: 'verified', contentComplete: true, evidenceKind: 'retained_projection', logicalToolCallId: 'query-b', sourceLogicalToolCallId: 'call-b', sourceResultHandleId: 'rh_b' },
    ],
  });
  assert.equal(pagedDifferentCall.complete, false, 'a projection of a different call does not complete this source');
  assert.equal(pagedDifferentCall.incompleteReceipts.length, 1);

  const pagedUnlinkedProjection = assessCompletionEvidenceCoverage({
    objective: 'look up the named record and its window',
    results: [
      { toolName: 'calendar_list_view', outcome: 'succeeded', status: 'verified', contentComplete: false, evidenceKind: 'source_result' },
      { toolName: 'tool_output_query', outcome: 'succeeded', status: 'verified', contentComplete: true, evidenceKind: 'retained_projection' },
    ],
  });
  assert.equal(pagedUnlinkedProjection.complete, false, 'an unlinked projection does not complete an incomplete source');
  assert.equal(pagedUnlinkedProjection.incompleteReceipts.length, 1);

  const twoDeliverablesOneProjection = assessCompletionEvidenceCoverage({
    objective: 'look up the named record and its window',
    results: [
      { toolName: 'record_lookup', outcome: 'succeeded', status: 'verified', contentComplete: false, evidenceKind: 'source_result', logicalToolCallId: 'call-a' },
      { toolName: 'window_lookup', outcome: 'succeeded', status: 'verified', contentComplete: false, evidenceKind: 'source_result', logicalToolCallId: 'call-b' },
      { toolName: 'tool_output_query', outcome: 'succeeded', status: 'verified', contentComplete: true, evidenceKind: 'retained_projection', logicalToolCallId: 'query-a', sourceLogicalToolCallId: 'call-a' },
    ],
  });
  assert.equal(twoDeliverablesOneProjection.complete, false, 'one of two deliverables remaining is not complete');
  assert.equal(twoDeliverablesOneProjection.incompleteReceipts.length, 1);

  const twoDeliverablesOneFailed = assessCompletionEvidenceCoverage({
    objective: 'look up the named record and its window',
    results: [
      { toolName: 'record_lookup', outcome: 'succeeded', status: 'verified', contentComplete: true, evidenceKind: 'source_result', logicalToolCallId: 'call-a' },
      { toolName: 'window_lookup', outcome: 'failed', evidenceKind: 'source_result', logicalToolCallId: 'call-b' },
    ],
  });
  assert.equal(twoDeliverablesOneFailed.complete, false, 'a failed sibling deliverable keeps coverage incomplete');
  assert.equal(twoDeliverablesOneFailed.failedAttempts.length, 1);
});

test('Jev DONE after discovery-only execution is not accepted as completion', async () => {
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        verdict: {
          type: 'choice',
          choice: 'done',
          probabilities: { done: 0.9, incomplete: 0.1 },
          confidence: 0.84,
        },
      },
      usage: { input_tokens: 20, output_tokens: 2 },
    }),
  }));
  const v = await judgeObjectiveComplete(
    'look up the named record',
    'Found it.',
    {
      sessionId: 'probe',
      skills: [],
      verifiedReadResults: [
        { toolName: 'tool_search', outcome: 'succeeded', contentDisposition: 'discovery_navigation', contentComplete: false },
      ],
    },
  );
  assert.notEqual(v.judgeModelId, 'jev-1.13.0');
});

test('judgeObjectiveComplete keeps a Jev incomplete verdict when there are no verified reads', async () => {
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        verdict: {
          type: 'choice',
          choice: 'incomplete',
          probabilities: { incomplete: 0.8, done: 0.2 },
          confidence: 0.84,
        },
      },
      usage: { input_tokens: 36, output_tokens: 4 },
    }),
  }));
  const empty = await judgeObjectiveComplete(
    'find tim in salesforce and tell me if he is on my calendar this week',
    'Tim Demik is in Salesforce and on the calendar.',
    { sessionId: 'probe', skills: [], toolCallSummary: 'none' },
  );
  assert.equal(empty.judgeModelId, 'jev-1.13.0');
  assert.equal(empty.done, false);
});

test('an unreachable reviewer plus a Jev NOT-DONE finding continues instead of delivering the promise', async () => {
  // Live 2026-09-21, a BYO setup with no reachable checker: Clem replied "I'll
  // resolve that and turn it on, then run the first batch as the test", stopped,
  // and attached "it stands unreviewed". Jev had already read that reply and
  // found the objective unmet; the verdict was discarded in favour of done:true,
  // so the promise WAS the answer and the owner had to nudge.
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        verdict: { type: 'choice', choice: 'incomplete', probabilities: { incomplete: 0.86, done: 0.14 }, confidence: 0.85 },
        // Jev's own 'matches' criterion for false is "or only promises the work".
        matches: { type: 'noul', noul: 0.08 },
      },
      usage: { input_tokens: 30, output_tokens: 4 },
    }),
  }));
  const v = await judgeObjectiveComplete(
    'Turn the workflow on and run the first batch as the test.',
    "I'll resolve that and turn it on, then run the first batch as the test.",
    {
      sessionId: 'probe-unreachable-reviewer',
      skills: [],
      toolCallSummary: 'tool_search succeeded',
      // Coverage is COMPLETE, so the strict acceptJev rules reject this
      // incomplete verdict and the configured reviewer is the only lane left.
      verifiedReadResults: [
        { toolName: 'write_file', outcome: 'succeeded', status: 'verified', contentComplete: true, evidenceKind: 'source_result' },
      ],
    },
  );
  // The reviewer could not run, so nothing may claim a completed review...
  assert.equal(v.failedOpen, true);
  // ...but a promise is not a result: the turn continues rather than settling.
  assert.equal(v.done, false);
  assert.ok((v.reason ?? '').trim().length > 0, 'the continuation carries a reason');
});

test('Jev incomplete after a paged read is not coerced to done from reply similarity', async () => {
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        verdict: {
          type: 'choice',
          choice: 'incomplete',
          probabilities: { incomplete: 0.88, done: 0.12 },
          confidence: 0.88,
        },
        matches: { type: 'noul', noul: 0.79 },
      },
      usage: { input_tokens: 40, output_tokens: 6 },
    }),
  }));
  const v = await judgeObjectiveComplete(
    'look up the named record and its window',
    'The named record is present in the verified window.',
    {
      sessionId: 'probe-paged-read',
      skills: [],
      verifiedReadResults: [
        { toolName: 'tool_search', outcome: 'succeeded', contentDisposition: 'discovery_navigation', contentComplete: false },
        { toolName: 'calendar_list_view', outcome: 'succeeded', status: 'verified', contentComplete: false, evidenceKind: 'source_result', logicalToolCallId: 'call-a' },
        { toolName: 'tool_output_query', outcome: 'succeeded', status: 'verified', contentComplete: true, evidenceKind: 'retained_projection', logicalToolCallId: 'query-a', sourceLogicalToolCallId: 'call-a' },
      ],
    },
  );
  assert.equal(v.jevAttempt?.coverageComplete, true);
  assert.equal(v.jevAttempt?.accepted, false);
  assert.equal(v.jevAttempt?.replyMatchesReceipts, 0.79);
  assert.notEqual(v.fast, true);
  assert.notEqual(v.judgeModelId, 'jev-1.13.0');
  assert.notEqual(v.reason, 'Jev found the response reports the verified receipts.');
});

test('Jev incomplete with complete receipts falls through; reply similarity does not force done', async () => {
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        verdict: {
          type: 'choice',
          choice: 'incomplete',
          probabilities: { incomplete: 0.7, done: 0.3 },
          confidence: 0.84,
        },
        matches: { type: 'noul', noul: 0.82 },
      },
      usage: { input_tokens: 40, output_tokens: 6 },
    }),
  }));
  const v = await judgeObjectiveComplete(
    'Create /tmp/jev.txt containing JEV_OK',
    'Created /tmp/jev.txt with exactly JEV_OK.',
    {
      sessionId: 'probe-jev-match',
      skills: [],
      verifiedReadResults: [
        { toolName: 'write_file', outcome: 'succeeded', status: 'verified', contentComplete: true, evidenceKind: 'source_result' },
      ],
    },
  );
  assert.equal(v.jevAttempt?.accepted, false);
  assert.equal(v.jevAttempt?.coverageComplete, true);
  assert.equal(v.jevAttempt?.replyMatchesReceipts, 0.82);
  assert.notEqual(v.fast, true);
  assert.notEqual(v.judgeModelId, 'jev-1.13.0');
  assert.notEqual(v.reason, 'Jev found the response reports the verified receipts.');
});

test('a Jev miss does not serialize: the reviewer starts at the hedge delay, before Jev returns', async () => {
  _setTypesafeKeyForTests('ts_test');
  const t0 = Date.now();
  let judgeStartedAt = 0;
  _setCompletionJudgeForTests(async () => {
    judgeStartedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { verdict: { done: false, reason: 'settings-judge' }, failure: null };
  });
  let jevEndedAt = 0;
  _setSystemOneFetchForTests(async () => {
    // Slower than the hedge: the reviewer must already be running by then.
    await new Promise((resolve) => setTimeout(resolve, JEV_HEDGE_DELAY_MS + 300));
    jevEndedAt = Date.now();
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          verdict: { type: 'choice', choice: 'incomplete', probabilities: { done: 0.2, incomplete: 0.8 }, confidence: 0.7 },
          matches: { type: 'noul', noul: 0.2 },
        },
        usage: { input_tokens: 36, output_tokens: 4 },
      }),
    };
  });
  const v = await judgeObjectiveComplete(
    'Create /tmp/jev.txt containing JEV_OK',
    'Created /tmp/jev.txt with exactly JEV_OK plus one newline.',
    {
      sessionId: 'probe-jev-overlap',
      skills: [],
      verifiedReadResults: [
        { toolName: 'write_file', outcome: 'succeeded', status: 'verified', contentComplete: true, evidenceKind: 'source_result' },
      ],
    },
  );
  assert.ok(judgeStartedAt > 0, 'Settings judge must start');
  assert.ok(judgeStartedAt < jevEndedAt, 'the reviewer must not wait for a slow Jev');
  assert.ok(judgeStartedAt - t0 >= JEV_HEDGE_DELAY_MS - 20 && judgeStartedAt - t0 < JEV_HEDGE_DELAY_MS + 250,
    `the reviewer starts at the hedge delay, not immediately (started after ${judgeStartedAt - t0}ms)`);
  assert.equal(v.done, false);
  assert.equal(v.jevAttempt?.reviewerStarted, true);
  _setCompletionJudgeForTests(null);
});

test('judgeObjectiveComplete still uses Jev when a captured judge selection is present', async () => {
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        verdict: {
          type: 'choice',
          choice: 'done',
          probabilities: { done: 0.9, incomplete: 0.1 },
          confidence: 0.84,
        },
        matches: { type: 'noul', noul: 0.9 },
      },
      usage: { input_tokens: 36, output_tokens: 4 },
    }),
  }));
  const v = await judgeObjectiveComplete(
    'Create /tmp/jev.txt containing JEV_OK',
    'Created /tmp/jev.txt with exactly JEV_OK plus one newline.',
    {
      sessionId: 'probe-jev-complete',
      skills: [],
      toolCallSummary: 'write_file succeeded',
      verifiedReadResults: [
        { toolName: 'write_file', outcome: 'succeeded', status: 'verified', contentComplete: true, evidenceKind: 'source_result' },
      ],
      boundaryJudgeSelection: {
        status: 'captured',
        role: { modelId: 'grok-4.3', provider: 'byo', source: 'settings' },
        crossFamily: true,
        defaultModels: { claude: 'claude-haiku-4-5', codex: 'gpt-5-mini' },
      },
    },
  );
  assert.equal(v.judgeModelId, 'jev-1.13.0');
});

test('buildObjectiveJudgePrompt frames retained skills as references applicable to the accepted objective', async () => {
  const { buildObjectiveJudgePrompt } = await import('./objective-judge.js');
  const p = buildObjectiveJudgePrompt('clone and improve the site', 'I built and deployed it.', {
    skills: [{ name: 'redesign-skill', body: 'Step 1: generate hero imagery. Step 2: build. Step 3: deploy.' }],
    toolCallSummary: 'run_shell_command×13, skill_read×4',
  });
  assert.match(p, /Reading a skill supplies reference material/i);
  assert.match(p, /Plan|inspection|comparison/i);
  assert.match(p, /readOrigins=unknown/);
  assert.doesNotMatch(p, /verify they were EXECUTED/i);
  assert.match(p, /redesign-skill/);
  assert.match(p, /generate hero imagery/);
  assert.match(p, /run_shell_command×13/);
});

test('buildObjectiveJudgePrompt without skill context is unchanged (no rubric injected)', async () => {
  const { buildObjectiveJudgePrompt } = await import('./objective-judge.js');
  const p = buildObjectiveJudgePrompt('do a thing', 'done');
  assert.doesNotMatch(p, /SKILLS LOADED THIS SESSION/);
  assert.match(p, /exactly one verdict line/);
  assert.doesNotMatch(p, /structured verdict/);
});

// Regression (2026-06-14): a build/deploy run that loads NO skill still did real
// work; the judge was previously starved of the tool-call evidence (it only
// rendered inside the skills block), so it false-rejected genuinely-finished
// action turns and stranded ~10% of completions into a false stuck loop.
test('buildObjectiveJudgePrompt surfaces tool-call evidence even with NO skill loaded', () => {
  const p = buildObjectiveJudgePrompt(
    'build and deploy the Test Bakehouse site',
    'Done — Test Bakehouse is live: https://test-bakehouse.netlify.app',
    { skills: [], toolCallSummary: 'run_shell_command×5, write_file×1' },
  );
  assert.match(p, /Tool calls made this session/);
  assert.match(p, /run_shell_command×5/);
  // No skill rubric should be injected for an empty skills list.
  assert.doesNotMatch(p, /SKILLS LOADED THIS SESSION/);
});

test('buildObjectiveJudgePrompt suppresses the evidence line for a zero-tool turn', () => {
  // A bare promise with no tools must NOT get a corroborating evidence line —
  // the judge should still see only prose and demand the artifact.
  const p = buildObjectiveJudgePrompt('build a thing', "I'll get right on that.", {
    skills: [],
    toolCallSummary: '(no tool calls made)',
  });
  assert.doesNotMatch(p, /Tool calls made this session/);
});

// ─── composeJudgedObjective — continuity-aware judged objective ────

test('composeJudgedObjective: bare follow-up gets prior REAL user messages as context', async () => {
  const { composeJudgedObjective } = await import('./objective-judge.js');
  const composed = composeJudgedObjective('just mine please', [
    'I need to pull 25 priority account accounts new from Salesforce that have not had contact in 15 days, de-dupe against Airtable, then SEO enrichment.',
    'Continue with the next step of your plan. If you have nothing left to do, set done=true and nextAction=completed.',
    'You hit a step / time budget on the previous turn and the user has now replied `continue`.\n\nPick up where you left off; do not restart the workflow from scratch.',
  ]);
  assert.match(composed, /25 priority account accounts/);
  assert.match(composed, /Current user message .*: just mine please/);
  assert.doesNotMatch(composed, /Continue with the next step/, 'harness drip injections must be filtered');
  assert.doesNotMatch(composed, /step \/ time budget/, 'synthetic continue inputs must be filtered');
});

test('composeJudgedObjective: long objective passes through unchanged', async () => {
  const { composeJudgedObjective } = await import('./objective-judge.js');
  const long = 'Research the top 25 personal injury firms in New York by SERP visibility, then write each one an outreach note referencing their weakest keyword cluster.';
  assert.equal(composeJudgedObjective(long, ['earlier message']), long);
});

test('composeJudgedObjective: no real priors → raw input unchanged', async () => {
  const { composeJudgedObjective } = await import('./objective-judge.js');
  assert.equal(composeJudgedObjective('lets do it', []), 'lets do it');
  assert.equal(
    composeJudgedObjective('lets do it', [
      'You marked this objective complete, but an independent verification check found it is NOT finished: x.',
    ]),
    'lets do it',
    'injected-only history must not be treated as context',
  );
});

test('composeJudgedObjective: keeps only the last 2 priors and truncates very long ones', async () => {
  const { composeJudgedObjective } = await import('./objective-judge.js');
  const composed = composeJudgedObjective('go', ['first', 'second', `third ${'x'.repeat(700)}`]);
  assert.doesNotMatch(composed, /\bfirst\b/, 'only the last 2 priors are kept');
  assert.match(composed, /second/);
  assert.match(composed, /…/, 'long prior is truncated');
});

test('JUDGE_SYSTEM_PROMPT: rubric audits only NAMED deliverables and yields on ambiguity', async () => {
  const { JUDGE_SYSTEM_PROMPT } = await import('./objective-judge.js');
  assert.match(JUDGE_SYSTEM_PROMPT, /Do NOT invent extra deliverables/);
  assert.match(JUDGE_SYSTEM_PROMPT, /bare conversational follow-up/);
  assert.doesNotMatch(JUDGE_SYSTEM_PROMPT, /lean toward not-done/, 'the loop-forever-on-ambiguity rule is gone');
});

// ─── Plain-text verdict parser (schema-free; feed fake finalOutput strings) ───

test('parseCompletionVerdict: DONE marker → done:true + reason', () => {
  const v = parseCompletionVerdict('DONE: Spreadsheet created at /Users/me/Q3.xlsx with URL returned');
  assert.equal(v?.done, true);
  assert.match(v!.reason, /Q3\.xlsx/);
});

test('parseCompletionVerdict: INCOMPLETE marker → done:false + missing evidence', () => {
  const v = parseCompletionVerdict('INCOMPLETE: Assistant proposed steps but no artifact or URL was produced');
  assert.equal(v?.done, false);
  assert.match(v!.reason, /no artifact/);
});

test('parseCompletionVerdict: tolerant of NOT-DONE alias, no colon, lowercase, whitespace', () => {
  assert.equal(parseCompletionVerdict('  done  everything shipped')?.done, true);
  assert.equal(parseCompletionVerdict('DONE')?.done, true);
  assert.equal(parseCompletionVerdict('DONE - everything shipped')?.done, true);
  assert.equal(parseCompletionVerdict('NOT-DONE: still missing the send confirmation')?.done, false);
  assert.equal(parseCompletionVerdict('not done: nothing produced')?.done, false);
});

test('parseCompletionVerdict: legacy structured object/JSON verdicts are accepted', () => {
  const done = parseCompletionVerdict({ done: true, reason: 'file written at /tmp/report.md' });
  assert.deepEqual(done, { done: true, reason: 'file written at /tmp/report.md' });

  const incomplete = parseCompletionVerdict('```json\n{"done":"false","reason":"missing the spreadsheet URL"}\n```');
  assert.equal(incomplete?.done, false);
  assert.equal(incomplete?.reason, 'missing the spreadsheet URL');

  const status = parseCompletionVerdict('{"status":"completed","summary":"artifact path returned"}');
  assert.equal(status?.done, true);
  assert.equal(status?.reason, 'artifact path returned');
});

test('parseCompletionVerdict: no marker → null (caller applies its own fail semantics)', () => {
  assert.equal(parseCompletionVerdict('It seems like the work is finished'), null);
  assert.equal(parseCompletionVerdict(''), null);
  assert.equal(parseCompletionVerdict(undefined), null);
});

test('parseCompletionVerdict: reason clamped in code, never validated', () => {
  const v = parseCompletionVerdict(`DONE: ${'z'.repeat(900)}`);
  assert.equal(v?.done, true);
  assert.equal(v!.reason.length, 400);
});

// ─── Per-criterion checklist verdict parsing (goal-contract granularity) ───

test('parseCriteriaVerdicts: one line per criterion, mixed MET/UNMET, notes preserved', async () => {
  const { parseCriteriaVerdicts } = await import('./objective-judge.js');
  const raw = ['1: MET: sheet URL present', '2: UNMET: no send confirmation', '3: MET: file path quoted'].join('\n');
  const v = parseCriteriaVerdicts(raw, 3);
  assert.equal(v?.length, 3);
  assert.deepEqual(v?.map((x) => x.pass), [true, false, true]);
  assert.match(v?.[1].note ?? '', /send confirmation/);
});

test('parseCriteriaVerdicts: tolerant of synonyms (PASS/FAIL), separators, and order', async () => {
  const { parseCriteriaVerdicts } = await import('./objective-judge.js');
  const raw = ['2) FAIL — missing artifact', '1. PASS: done well'].join('\n');
  const v = parseCriteriaVerdicts(raw, 2);
  assert.deepEqual(v?.map((x) => x.pass), [true, false]);
});

test('parseCriteriaVerdicts: ALL-OR-NOTHING — a partial listing returns null (never silently partial)', async () => {
  const { parseCriteriaVerdicts } = await import('./objective-judge.js');
  assert.equal(parseCriteriaVerdicts('1: MET: ok', 2), null);
  assert.equal(parseCriteriaVerdicts('here is my analysis of the criteria...', 2), null);
  assert.equal(parseCriteriaVerdicts('', 1), null);
});

test('parseCriteriaVerdicts: out-of-range and duplicate indices ignored, prose around lines tolerated', async () => {
  const { parseCriteriaVerdicts } = await import('./objective-judge.js');
  const raw = ['Verdicts:', '1: MET: ok', '1: UNMET: dup ignored', '5: MET: out of range', '2: UNMET: real'].join('\n');
  const v = parseCriteriaVerdicts(raw, 2);
  assert.deepEqual(v?.map((x) => x.pass), [true, false]);
});

// ─── AWAITING verdict + direction-seeking question regression ────────────────

test('parseCompletionVerdict: AWAITING maps to done + awaitingUser (never a bounce)', () => {
  const v = parseCompletionVerdict('AWAITING: Assistant asked whether to send the 55 prepared emails now');
  assert.equal(v?.done, true);
  assert.equal(v?.awaitingUser, true);
  assert.match(v?.reason ?? '', /55 prepared emails/);
  // DONE / INCOMPLETE keep their exact prior shape (no awaitingUser leak).
  assert.equal(parseCompletionVerdict('DONE: saved')?.awaitingUser, undefined);
  assert.equal(parseCompletionVerdict('INCOMPLETE: nothing produced')?.awaitingUser, undefined);
});

test('isDirectionSeekingQuestion: catches the batch-approval question; ignores polite tails', async () => {
  const { isDirectionSeekingQuestion } = await import('./objective-judge.js');
  // The exact shape that got bounced live: a resume + a go/no-go question.
  assert.equal(isDirectionSeekingQuestion(
    'Yes — we’re on the 60 priority-account reactivation emails.\n\nDo you want me to pick up by **sending the 55 send-ready emails now**, or review the drafts first?',
  ), true);
  assert.equal(isDirectionSeekingQuestion('Should I send these to the full list or just the top 10?'), true);
  assert.equal(isDirectionSeekingQuestion('Which account should I use for the export?'), true);
  assert.equal(isDirectionSeekingQuestion('Which audience should this rollout brief target?'), true);
  assert.equal(
    isDirectionSeekingQuestion('Before I draft this, who should the rollout brief target — which audience?'),
    true,
    'a natural lead-in before the interrogative still creates a durable clarification pause',
  );
  assert.equal(isDirectionSeekingQuestion('Where should I save the finished brief?'), true);
  assert.equal(isDirectionSeekingQuestion('Is this intended for engineers or executives?'), true);
  assert.equal(isDirectionSeekingQuestion('The report is ready at /tmp/report.md. OK to publish it to the site?'), true);
  // NOT direction-seeking: statements, rhetorical/polite tails, no question mark.
  assert.equal(isDirectionSeekingQuestion('Done — report saved to /tmp/report.md.'), false);
  assert.equal(isDirectionSeekingQuestion('Done — report saved. Anything else?'), false);
  assert.equal(isDirectionSeekingQuestion('Done — report saved. Does that help?'), false);
  assert.equal(isDirectionSeekingQuestion('Should I publish it? I will wait for your approval.'), false);
  assert.equal(isDirectionSeekingQuestion('I sent the 10 emails.'), false);
  assert.equal(isDirectionSeekingQuestion(''), false);
  assert.equal(isDirectionSeekingQuestion(null), false);
});

test('isBlockingDirectionSeekingQuestion: a retrieve answer plus an offer stays delivered', async () => {
  const { isBlockingDirectionSeekingQuestion } = await import('./objective-judge.js');
  const roster = [
    'Eight people on the roster:',
    '',
    '- Bobby Romano — bobby.romano@example.com',
    '- Brett Lorenzini — brett.lorenzini@example.com',
    '',
    'Want me to pull this week\'s closed-won totals next?',
  ].join('\n');
  assert.equal(
    isBlockingDirectionSeekingQuestion(roster, { route: 'retrieve' }),
    false,
    'an already-answered retrieve may offer a next step without parking',
  );
  assert.equal(
    isBlockingDirectionSeekingQuestion('Which team should I use — east or west?', { route: 'retrieve' }),
    true,
    'a retrieve that is only a clarification still pauses',
  );
  assert.equal(
    isBlockingDirectionSeekingQuestion(
      'Yes — we\'re on the 60 priority-account reactivation emails.\n\nDo you want me to pick up by **sending the 55 send-ready emails now**, or review the drafts first?',
      { route: 'act' },
    ),
    true,
    'ask-first on an action turn still parks',
  );
});

test('the goal judge has its own deadline, off the 25 s boundary wall, and the env can move it', async () => {
  const family = await import('./judge-family.js');
  const prior = process.env.CLEMMY_GOAL_JUDGE_TIMEOUT_MS;
  try {
    delete process.env.CLEMMY_GOAL_JUDGE_TIMEOUT_MS;
    assert.equal(family.goalJudgeTimeoutMs(), 90_000);
    assert.ok(family.goalJudgeTimeoutMs() > family.boundaryJudgeTimeoutMs(), 'a post-run audit may wait longer than a chat gate');
    process.env.CLEMMY_GOAL_JUDGE_TIMEOUT_MS = '120000';
    assert.equal(family.goalJudgeTimeoutMs(), 120_000);
    process.env.CLEMMY_GOAL_JUDGE_TIMEOUT_MS = '5';
    assert.equal(family.goalJudgeTimeoutMs(), 90_000, 'a sub-second value falls back to the default');
  } finally {
    if (prior === undefined) delete process.env.CLEMMY_GOAL_JUDGE_TIMEOUT_MS;
    else process.env.CLEMMY_GOAL_JUDGE_TIMEOUT_MS = prior;
  }
});

test('the judge is told a reported provider failure needs a matching provider call in the evidence', () => {
  const prompt = buildObjectiveJudgePrompt(
    'edit this event and add a brief description',
    "I couldn't update the existing invite — the Outlook API can locate it but won't accept its event ID for editing.",
  );
  assert.match(prompt, /counts as evidence only when a matching provider call appears in the evidence above/);
  assert.match(prompt, /treat the reported failure as unverified: the objective is not fulfilled/);
});

test('an honest failure report settles after one bounce; claims and promises still get judged', () => {
  const honest = "I couldn't update the invite because the calendar connector rejected the operation. No changes were made.";
  assert.equal(honestFailureReportSettles({ verdictDone: false, continuationsUsed: 1, reply: honest, settledWrites: 0 }), true);
  assert.equal(honestFailureReportSettles({ verdictDone: false, continuationsUsed: 0, reply: honest, settledWrites: 0 }), false, 'the first negative verdict still bounces once');
  assert.equal(honestFailureReportSettles({ verdictDone: false, continuationsUsed: 1, reply: 'Done — the invite was updated.', settledWrites: 0 }), false, 'a claim is judged');
  assert.equal(honestFailureReportSettles({ verdictDone: false, continuationsUsed: 1, reply: "I'll update it next.", settledWrites: 0 }), false, 'a promise is judged');
  assert.equal(honestFailureReportSettles({ verdictDone: false, continuationsUsed: 1, reply: honest, settledWrites: 1 }), false, 'a settled write is verified, not settled by wording');
  assert.equal(honestFailureReportSettles({ verdictDone: true, continuationsUsed: 1, reply: honest, settledWrites: 0 }), false);
});

test('a verdict records the model that answered after a mid-call fallover, keeping the pin as requested', () => {
  const startedAt = Date.parse('2026-09-15T07:59:40.000Z');
  const rows = [
    { createdAt: '2026-09-15T08:00:15.000Z', data: { fallover: true, fromModel: 'grok-4.6', model: 'gpt-5.6-luna', provider: 'codex', reason: 'model.http_5xx' } },
    { createdAt: '2026-09-15T07:50:00.000Z', data: { fallover: true, fromModel: 'grok-4.6', model: 'gpt-5.6-terra', provider: 'codex', reason: 'earlier' } },
  ];
  assert.deepEqual(resolveJudgeResponder({ requested: { judgeModelId: 'grok-4.6', judgeProvider: 'byo' }, judgeStartedAt: startedAt, routedRows: rows }), {
    judgeModelId: 'gpt-5.6-luna', judgeProvider: 'codex', substituteForExactPin: true, requestedJudgeModelId: 'grok-4.6', substituteReason: 'fallover:model.http_5xx',
  });
  // No fallover in the window: the pin answered.
  assert.deepEqual(resolveJudgeResponder({ requested: { judgeModelId: 'grok-4.6', judgeProvider: 'byo' }, judgeStartedAt: Date.parse('2026-09-15T08:05:00.000Z'), routedRows: rows }), { judgeModelId: 'grok-4.6', judgeProvider: 'byo' });
  // A fallover of a different model is not this judge's.
  assert.deepEqual(resolveJudgeResponder({ requested: { judgeModelId: 'claude-haiku-4-5' }, judgeStartedAt: startedAt, routedRows: rows }), { judgeModelId: 'claude-haiku-4-5' });
});

test('an accepted Jev verdict inside the hedge delay never starts the configured reviewer', async () => {
  const { _setCompletionJudgeForTests } = await import('./objective-judge.js');
  let reviewerCalls = 0;
  _setCompletionJudgeForTests(async () => { reviewerCalls += 1; return { verdict: { done: true, reason: 'reviewer ran' }, failure: null }; });
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({
    status: 200, ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: { verdict: { type: 'choice', choice: 'done', probabilities: { done: 0.9, incomplete: 0.1 }, confidence: 0.85 }, matches: { type: 'noul', noul: 0.9 } },
      usage: { input_tokens: 30, output_tokens: 4 },
    }),
  }));
  try {
    const v = await judgeObjectiveComplete(
      'Create /tmp/jev-hedge.txt containing HEDGE_OK',
      'Created /tmp/jev-hedge.txt with exactly HEDGE_OK.',
      { sessionId: 'probe-jev-hedge', skills: [], toolCallSummary: 'write_file succeeded',
        verifiedReadResults: [{ toolName: 'write_file', outcome: 'succeeded', status: 'verified', contentComplete: true, evidenceKind: 'source_result' }] },
    );
    assert.equal(v.done, true);
    assert.equal(v.judgeModelId, 'jev-1.13.0');
    assert.equal(v.jevAttempt?.reviewerStarted, false, 'the hedge must have saved the reviewer call');
    // Give any stray hedge timer a chance to fire; it must have been cleared.
    await new Promise((resolve) => setTimeout(resolve, JEV_HEDGE_DELAY_MS + 100));
    assert.equal(reviewerCalls, 0, 'the configured reviewer must not run for a verdict Jev already settled');
  } finally {
    _setCompletionJudgeForTests(null);
  }
});

test('a Jev verdict slower than the hedge delay lets the configured reviewer start, and its verdict still wins when Jev is rejected', async () => {
  const { _setCompletionJudgeForTests } = await import('./objective-judge.js');
  let reviewerCalls = 0;
  _setCompletionJudgeForTests(async () => { reviewerCalls += 1; return { verdict: { done: false, reason: 'reviewer: not done' }, failure: null }; });
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => {
    await new Promise((resolve) => setTimeout(resolve, JEV_HEDGE_DELAY_MS + 200));
    return {
      status: 200, ok: true,
      text: async () => JSON.stringify({
        model: 'jev-1.13.0',
        answers: { verdict: { type: 'choice', choice: 'done', probabilities: { done: 0.9, incomplete: 0.1 }, confidence: 0.85 }, matches: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 30, output_tokens: 4 },
      }),
    };
  });
  try {
    // No verified reads → coverage incomplete → Jev DONE is not accepted.
    const v = await judgeObjectiveComplete('look up the record', 'I looked it up.', { sessionId: 'probe-jev-slow', skills: [], toolCallSummary: '' });
    assert.equal(reviewerCalls, 1, 'a slow Jev must not delay the reviewer past the hedge');
    assert.equal(v.done, false);
    assert.equal(v.jevAttempt?.reviewerStarted, true);
  } finally {
    _setCompletionJudgeForTests(null);
  }
});
