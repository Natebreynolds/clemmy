import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-objective-judge-coverage-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { Usage } = await import('@openai/agents');
const { ClaudeModelProvider } = await import('./claude-model.js');
const { CodexModelProvider } = await import('./codex-model.js');
const { judgeObjectiveComplete, HOST_COMPLETION_EVIDENCE_GUIDANCE } = await import('./objective-judge.js');
const { resetJudgeMetricsForTests } = await import('./judge-family.js');
const { _setDiscoveredModelsForTest } = await import('./model-discovery.js');
const { closeEventLog } = await import('./eventlog.js');

/** One scripted reviewer turn: a verdict, or a lookup the runner executes. */
type Step = string | Error | { tool: 'open_evidence' | 'query_evidence'; args: Record<string, unknown> };
let script: Step[] = [];
const requests: ModelRequest[] = [];

const reviewer: Model = {
  async getResponse(request): Promise<ModelResponse> {
    requests.push(request);
    const step = script.shift();
    if (step === undefined) throw new Error('the reviewer was asked more often than this review allows');
    if (step instanceof Error) throw step;
    if (typeof step === 'string') {
      return { output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: step, providerData: {} }] }],
        usage: new Usage(), responseId: `coverage-${requests.length}` } as ModelResponse;
    }
    return { output: [{ type: 'function_call', callId: `lookup-${requests.length}`, name: step.tool,
      arguments: JSON.stringify(step.args), status: 'completed' }],
      usage: new Usage(), responseId: `coverage-${requests.length}` } as ModelResponse;
  },
  async *getStreamedResponse() { throw new Error('the judge must not stream'); },
};

// 94 list records, none of which carries the title the reply says is absent,
// and one on a later page that does. Which of the two the source holds is
// exactly what a bounded view cannot show.
const records = (withLateMatch: boolean) => Array.from({ length: 94 }, (_, index) => ({
  id: `record-${index}`,
  subject: withLateMatch && index === 71 ? 'Autumn Picture Day' : `Standing meeting ${index % 7}`,
  start: { dateTime: `2026-10-${String((index % 28) + 1).padStart(2, '0')}T09:00:00` },
  notes: 'x'.repeat(400),
}));
let source = { data: { value: records(false) } };

const evidence = {
  refKind: 'logicalCall ids or result handles',
  refs: () => ['call_list', 'call_write'],
  resolve(ref: string) {
    if (ref === 'call_list' || ref === 'rh_list') return { text: JSON.stringify(source), value: source, recordPath: 'data.value' };
    if (ref === 'call_write' || ref === 'rh_write') return { text: '{"id":"created-1"}', value: { id: 'created-1' } };
    return undefined;
  },
};
const boundedList = { logicalToolCallId: 'call_list', toolName: 'provider_list_records', outcome: 'succeeded', status: 'verified',
  evidenceKind: 'source_result', resultHandleId: 'rh_list', contentComplete: false, rawByteCount: 51_000, shownByteCount: 3_600,
  recordCount: 94, sourceExhausted: true, precedesWrite: true };
const writeReceipt = { logicalToolCallId: 'call_write', toolName: 'provider_create_record', outcome: 'succeeded', status: 'verified',
  evidenceKind: 'source_result', resultHandleId: 'rh_write', contentComplete: true, rawByteCount: 19, shownByteCount: 19 };

const OBJECTIVE = 'Add the autumn events to the shared calendar.';
const REPLY = 'The event is on the calendar. I checked the month first: none of these existed, so there are no duplicates.';

function review(over: Record<string, unknown> = {}) {
  return judgeObjectiveComplete(OBJECTIVE, REPLY, {
    skills: [],
    toolCallSummary: 'Retained READ results for THIS accepted source: provider_list_records [logicalCall=call_list] BOUNDED view.',
    verifiedReadResults: [boundedList, writeReceipt],
    fullSourceEvidence: true,
    evidence,
    reviewStakes: 'write',
    ...over,
  } as never);
}
const promptOf = (request: ModelRequest): string => JSON.stringify(request.input);

function inheritedReview(sourceExhausted = false, shown = false) {
  const ref = 'inherited-read:rh_parent_exact';
  return review({ verifiedReadResults: [],
    inheritedReadCoverage: [{ logicalToolCallId: ref, toolName: 'read_file', outcome: 'succeeded', status: 'verified',
      evidenceKind: 'origin_qualified_inherited_read', rawByteCount: 3_002, shownByteCount: shown ? 3_002 : 0,
      contentComplete: shown, sourceExhausted }],
    toolCallSummary: 'Origin-qualified historical READ evidence from the exact stopped parent. Semantic completeness unknown; not a child dispatch.',
    evidence: { refKind: 'exact inherited-read refs', refs: () => [ref], resolve: (name: string) =>
      name === ref ? { text: JSON.stringify('x'.repeat(3_000)), value: 'x'.repeat(3_000) } : undefined },
  });
}

beforeEach(() => {
  mock.restoreAll();
  script = [];
  requests.length = 0;
  source = { data: { value: records(false) } };
  Object.assign(process.env, {
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra',
    CLEMMY_JUDGE_CROSS_FAMILY: 'on', CLEMMY_JUDGE_HEDGE: 'off',
    CLEMMY_COMPLETION_REVIEW: 'on', CLEMMY_CLAUDE_OVERLOAD_FALLBACK: 'off', CLEMMY_CLAUDE_TRANSPORT: 'raw_messages',
    CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'judge', modelId: 'claude-sonnet-5', scope: 'durable', source: 'settings' }]),
    CLEMMY_DEBATE_JUDGE: '', BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '', BYO_MODEL_ID: '', BYO_PROVIDERS: '',
    CLEMMY_BOUNDARY_JUDGE_CLAUDE_MODEL: '', CLEMMY_BOUNDARY_JUDGE_CODEX_MODEL: '',
    JEV_API_KEY: '', JEV_ENABLED: 'off',
  });
  writeFileSync(path.join(TEST_HOME, 'state', 'auth.json'), JSON.stringify({
    codexOauth: { accessToken: 'fixture-codex-access', refreshToken: 'fixture-codex-refresh' },
  }));
  writeFileSync(path.join(TEST_HOME, 'state', 'claude-auth.json'), JSON.stringify({
    accessToken: 'sk-ant-oat01-fixture', expiresAt: Date.now() + 3_600_000,
  }));
  _setDiscoveredModelsForTest({ anthropic: [], openai: [] });
  resetJudgeMetricsForTests();
  mock.method(ClaudeModelProvider.prototype, 'getModel', () => reviewer);
  mock.method(CodexModelProvider.prototype, 'getModel', () => reviewer);
});

after(() => {
  mock.restoreAll();
  closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('omitted inherited bytes require a typed coverage attestation rather than empty child coverage', async () => {
  script = ['DONE: the saved file supports the answer.', 'DONE: the saved file supports the answer.'];
  const verdict = await inheritedReview();
  assert.equal(requests.length, 2);
  assert.equal(verdict.failedOpen, true);
  assert.equal(verdict.evidenceCoverage?.status, 'unattested');
  assert.match(promptOf(requests[0]!), /inherited-read:rh_parent_exact.*0 of 3002 bytes shown/);
  assert.match(promptOf(requests[0]!), /NEEDS ALL OF/);
});

test('exact inherited whole-result refs are inspected, while unknown source completeness cannot certify all of the source', async () => {
  const ref = 'inherited-read:rh_parent_exact';
  script = [
    { tool: 'open_evidence', args: { ref, offset: 0, max_chars: 4_000 } },
    `DONE: every byte of the source was checked.\nNEEDS ALL OF: ${ref}`,
    `DONE: every byte of the retained result was checked.\nNEEDS ALL OF: ${ref}`,
  ];
  const verdict = await inheritedReview();
  assert.equal(verdict.done, false);
  assert.equal(verdict.evidenceCoverage?.status, 'insufficient');
  assert.equal(verdict.evidenceCoverage?.unsupported[0]?.ref, ref, 'the namespaced result is a known exact review row');
  assert.equal(verdict.evidenceCoverage?.lookups[0]?.ref, ref);
  assert.equal(verdict.evidenceCoverage?.unsupported[0]?.inspection, 'inspected');
  assert.equal(verdict.evidenceCoverage?.unsupported[0]?.moreAtSource, true);
});

test('a claim limited to shown inherited bytes remains eligible without certifying an unknown source', async () => {
  script = ['DONE: the shown portion supports this limited quotation.\nNEEDS ALL OF: none'];
  const verdict = await inheritedReview(false, true);
  assert.equal(verdict.done, true);
  assert.equal(requests.length, 1);
  assert.equal(verdict.evidenceCoverage?.status, 'sufficient');
  assert.equal(verdict.evidenceCoverage?.open[0]?.moreAtSource, true);
  assert.deepEqual(verdict.evidenceCoverage?.needsAllOf, []);
});

test('the reviewer is told before it rules which results it holds only in part', async () => {
  script = ['DONE: the event was created, confirmed by its write receipt.\nNEEDS ALL OF: call_write'];
  const verdict = await review();
  assert.equal(verdict.done, true);
  assert.equal(requests.length, 1, 'a verdict resting on results shown whole costs no further call');
  assert.match(promptOf(requests[0]!), /RESULTS YOU HAVE ONLY IN PART/);
  assert.match(promptOf(requests[0]!), /call_list \(provider_list_records\): 3600 of 51000 bytes shown; 94 records; nothing else opened/);
  assert.match(promptOf(requests[0]!), /read before a write by this request/);
  assert.match(promptOf(requests[0]!), /NEEDS ALL OF: none/, 'the line is asked for with the results it concerns');
  assert.doesNotMatch(String(requests[0]!.systemInstructions ?? ''), /NEEDS ALL OF/, 'stable instructions are unchanged by a review');
  assert.equal(verdict.evidenceCoverage?.status, 'sufficient');
  assert.deepEqual(verdict.evidenceCoverage?.needsAllOf, ['call_write']);
  assert.deepEqual(verdict.evidenceCoverage?.open.map((row) => row.ref), ['call_list'],
    'the uninspected result stays on the record even though the verdict does not rest on it');
  assert.equal(verdict.evidenceCoverage?.followUp, undefined);
});

test('relocated host guidance preserves a sufficient verdict through the actual completion request', async () => {
  script = ['DONE: the event was created, confirmed by its write receipt.\nNEEDS ALL OF: call_write'];
  const verdict = await review({ completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE });
  assert.equal(verdict.done, true);
  assert.equal(verdict.failedOpen, undefined);
  assert.equal(requests.length, 1);
  assert.equal(verdict.evidenceCoverage?.status, 'sufficient');
  assert.deepEqual(verdict.evidenceCoverage?.needsAllOf, ['call_write']);
  const system = String(requests[0]!.systemInstructions);
  assert.equal(system.split(HOST_COMPLETION_EVIDENCE_GUIDANCE).length - 1, 1);
  assert.doesNotMatch(system, /call_list|call_write|rh_list|rh_write|Autumn Picture Day/);
  assert.doesNotMatch(promptOf(requests[0]!), /Judge only the effective accepted objective/);
  assert.match(promptOf(requests[0]!), /Retained READ results for THIS accepted source/);
  assert.match(promptOf(requests[0]!), /call_list/);
});

test('relocated host guidance cannot qualify an acceptance resting on unopened evidence', async () => {
  script = [
    'DONE: created; none of the records pre-existed.\nNEEDS ALL OF: call_list',
    'DONE: created; the successful count confirms absence.\nNEEDS ALL OF: call_list',
  ];
  const verdict = await review({ completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE });
  assert.equal(requests.length, 2, 'the existing one-follow-up coverage bound is retained');
  assert.equal(verdict.done, false);
  assert.equal(verdict.failedOpen, undefined);
  assert.equal(verdict.repairScope, 'claims');
  assert.equal(verdict.evidenceCoverage?.status, 'insufficient');
  assert.equal(verdict.evidenceCoverage?.returnedForCorrection, true);
  assert.deepEqual(verdict.evidenceCoverage?.lookups, []);
  for (const request of requests) {
    assert.equal(String(request.systemInstructions).split(HOST_COMPLETION_EVIDENCE_GUIDANCE).length - 1, 1);
    assert.doesNotMatch(promptOf(request), /Judge only the effective accepted objective/);
  }
});

test('an acceptance resting on an unopened result is asked once to inspect it, and the lookup is recorded', async () => {
  script = [
    'DONE: the event was created; the earlier read of 94 records confirms none pre-existed.\nNEEDS ALL OF: call_write, call_list',
    { tool: 'query_evidence', args: { ref: 'call_list', where_field: 'subject', contains: 'picture day', fields: ['subject', 'start.dateTime'] } },
    'DONE: the event was created; no record of 94 carries that title.\nNEEDS ALL OF: call_write, call_list',
  ];
  const verdict = await review();
  assert.equal(verdict.done, true);
  assert.equal(requests.length, 3);
  const followUp = promptOf(requests[1]!);
  assert.match(followUp, /COVERAGE CHECK/);
  assert.match(followUp, /Your verdict needs the whole of these results, which you have not inspected in full/);
  assert.match(followUp, /Retained READ results for THIS accepted source/, 'the evidence is resent unchanged ahead of the check');
  assert.equal(verdict.evidenceCoverage?.status, 'sufficient');
  assert.equal(verdict.evidenceCoverage?.followUp, 'answered');
  assert.deepEqual(verdict.evidenceCoverage?.lookups, [{ tool: 'query_evidence', ref: 'call_list', recordPath: 'data.value',
    recordsTotal: 94, recordsMatched: 0, recordsReturned: 0, offset: 0,
    filter: { field: 'subject', mode: 'contains' }, fields: ['subject', 'start.dateTime'] }]);
});

test('inspection can overturn the acceptance: a match on a later page becomes a correction', async () => {
  source = { data: { value: records(true) } };
  script = [
    'DONE: created; the month read confirms none pre-existed.\nNEEDS ALL OF: call_list',
    { tool: 'query_evidence', args: { ref: 'call_list', where_field: 'subject', contains: 'picture day', fields: ['subject'] } },
    'CORRECT: (1) "none of these existed" — record 71 of the month read is "Autumn Picture Day"',
  ];
  const verdict = await review();
  assert.equal(verdict.done, false);
  assert.equal(verdict.repairScope, 'claims');
  assert.match(verdict.reason, /record 71/);
  assert.equal(verdict.evidenceCoverage?.lookups[0]?.recordsMatched, 1);
  assert.equal(verdict.evidenceCoverage?.returnedForCorrection, undefined, 'the reviewer made this finding, not the host');
});

test('a reviewer that keeps accepting on a result it never read does not get its acceptance', async () => {
  script = [
    'DONE: created; 94 records were returned and none pre-existed.\nNEEDS ALL OF: call_list',
    'DONE: created; the read succeeded with 94 records, so nothing pre-existed.\nNEEDS ALL OF: call_list',
  ];
  const verdict = await review();
  assert.equal(requests.length, 2, 'one follow-up, never a loop');
  assert.equal(verdict.done, false, 'a count and a success are not an inspection');
  assert.equal(verdict.repairScope, 'claims');
  assert.match(verdict.reason, /needs the whole of provider_list_records \[call_list\]/);
  assert.match(verdict.reason, /holds 94 records and only part of it was read/);
  assert.equal(verdict.evidenceCoverage?.status, 'insufficient');
  assert.equal(verdict.evidenceCoverage?.returnedForCorrection, true);
  assert.deepEqual(verdict.evidenceCoverage?.lookups, []);
});

test('one page of two is not the list: the second page completes the inspection', async () => {
  script = [
    { tool: 'query_evidence', args: { ref: 'call_list', fields: ['subject'], limit: 50 } },
    'DONE: created; none pre-existed.\nNEEDS ALL OF: call_list',
    { tool: 'query_evidence', args: { ref: 'call_list', fields: ['subject'], offset: 50, limit: 50 } },
    'DONE: created; all 94 subjects read, none matches.\nNEEDS ALL OF: call_list',
  ];
  const verdict = await review();
  assert.equal(verdict.done, true);
  assert.match(promptOf(requests[2]!), /1 lookup\(s\), not covering the rest/);
  assert.equal(verdict.evidenceCoverage?.status, 'sufficient');
  assert.deepEqual(verdict.evidenceCoverage?.lookups.map((lookup) => [lookup.offset, lookup.recordsReturned]), [[0, 50], [50, 44]]);
});

test('a verdict that never attests its coverage is not reported as a passing review', async () => {
  script = ['DONE: the event was created.', 'DONE: the event was created, confirmed by its receipt.'];
  const verdict = await review();
  assert.equal(requests.length, 2);
  assert.match(promptOf(requests[1]!), /did not say which results it needs the whole of/);
  assert.equal(verdict.done, true, 'the existing failed-open policy preserves landed work');
  assert.equal(verdict.failedOpen, true);
  assert.equal(verdict.reviewFailure, 'invalid');
  assert.equal(verdict.repairScope, undefined, 'missing review qualification is not invented incomplete work');
  assert.match(verdict.reason, /no review was completed.*Required evidence coverage/);
  assert.equal(verdict.evidenceCoverage?.status, 'unattested');
  assert.equal(verdict.evidenceCoverage?.needsAllOf, null);
});

test('an unreadable coverage follow-up preserves its record but cannot qualify the earlier acceptance', async () => {
  script = ['DONE: the event was created.', 'The receipt looks right to me.', 'Still no verdict line here.'];
  const verdict = await review();
  assert.equal(verdict.done, true);
  assert.equal(requests.length, 3, 'one follow-up and its existing one format-repair attempt, no further review');
  assert.equal(verdict.failedOpen, true);
  assert.equal(verdict.reviewFailure, 'invalid');
  assert.equal(verdict.repairScope, undefined);
  assert.equal(verdict.evidenceCoverage?.status, 'unattested');
  assert.equal(verdict.evidenceCoverage?.followUp, 'unanswered');
});

test('an unavailable coverage follow-up is reported as unavailable rather than successful or missing work', async () => {
  script = ['DONE: the event was created.', new Error('controlled non-transient reviewer failure')];
  const verdict = await review();
  assert.equal(requests.length, 2, 'the qualification check adds no retry after the existing follow-up fails');
  assert.equal(verdict.done, true);
  assert.equal(verdict.failedOpen, true);
  assert.equal(verdict.reviewFailure, 'unavailable');
  assert.equal(verdict.repairScope, undefined);
  assert.match(verdict.reason, /no review was completed/);
  assert.equal(verdict.evidenceCoverage?.status, 'unattested');
  assert.equal(verdict.evidenceCoverage?.followUp, 'unanswered');
});

test('a format-repaired completion attests its coverage in the same output without another coverage call', async () => {
  script = ['The created event is supported by the exact write receipt; the verdict rests on that receipt.',
    'DONE: the event was created.\nNEEDS ALL OF: call_write'];
  const verdict = await review();
  assert.equal(requests.length, 2, 'the initial review plus one existing format repair, no extra coverage review');
  assert.equal(verdict.done, true);
  assert.equal(verdict.failedOpen, undefined);
  assert.equal(verdict.evidenceCoverage?.status, 'sufficient');
  assert.deepEqual(verdict.evidenceCoverage?.needsAllOf, ['call_write']);
  assert.equal(verdict.evidenceCoverage?.followUp, undefined);
  assert.match(String(requests[1]!.systemInstructions), /required NEEDS ALL OF line/);
});

test('a genuine second negative verdict stays authoritative without an acceptance attestation', async () => {
  script = ['DONE: the event was created.', 'CORRECT: (1) "none of these existed" is not established by the shown records.'];
  const verdict = await review();
  assert.equal(requests.length, 2);
  assert.equal(verdict.done, false);
  assert.equal(verdict.failedOpen, undefined);
  assert.equal(verdict.repairScope, 'claims');
  assert.match(verdict.reason, /not established/);
  assert.equal(verdict.evidenceCoverage?.followUp, 'answered');
});

test('a source that reported more than it returned cannot support absence, however much was read', async () => {
  script = [
    'DONE: created; the read shows none pre-existed.\nNEEDS ALL OF: call_list',
    'DONE: created; every returned record was read.\nNEEDS ALL OF: call_list',
  ];
  const verdict = await review({ verifiedReadResults: [
    { ...boundedList, contentComplete: true, shownByteCount: 51_000, sourceExhausted: false }, writeReceipt] });
  assert.equal(verdict.done, false);
  assert.match(verdict.reason, /source reported more results than the call returned/);
});

test('with every result shown whole there is no ledger, no extra line required and no follow-up', async () => {
  script = ['DONE: the event was created, confirmed by its write receipt.'];
  const verdict = await review({ verifiedReadResults: [writeReceipt] });
  assert.equal(verdict.done, true);
  assert.equal(requests.length, 1);
  assert.doesNotMatch(promptOf(requests[0]!), /RESULTS YOU HAVE ONLY IN PART/);
  assert.doesNotMatch(JSON.stringify(requests[0]), /NEEDS ALL OF/, 'a review shown everything is asked for nothing more');
  assert.equal(verdict.evidenceCoverage?.status, 'sufficient');
});

test('a verdict that sends the work back is never asked about coverage', async () => {
  script = ['INCOMPLETE: (1) the second event was never created'];
  const verdict = await review();
  assert.equal(verdict.done, false);
  assert.equal(requests.length, 1);
  assert.equal(verdict.evidenceCoverage, undefined);
});

test('a plan review and a review without evidence tools keep their existing single pass', async () => {
  script = ['DONE: the plan covers the objective.'];
  const plan = await review({ reviewsPlan: true, reviewStakes: 'plan' });
  assert.equal(plan.done, true);
  assert.equal(plan.evidenceCoverage, undefined);
  assert.equal(requests.length, 1);
  script = ['DONE: created.'];
  const untooled = await review({ evidence: undefined });
  assert.equal(untooled.evidenceCoverage, undefined);
  assert.equal(requests.length, 2);
});

let inheritedAskSerial = 0;
async function inheritedAskFixture(input: { objective?: string; continuation?: string; payload?: string } = {}) {
  const eventlog = await import('./eventlog.js');
  const shadow = await import('../graph/turn-graph-shadow.js');
  const dispatch = await import('./dispatch-ledger.js');
  const identities = await import('./attempt-identity.js');
  const outcomes = await import('./attempt-outcome.js');
  const settlements = await import('./logical-call-settlement-store.js');
  const delivery = await import('./delivery-committer.js');
  const turnOutcomes = await import('./turn-outcome.js');
  const selector = await import('./accepted-source-session-branch.js');
  const shares = await import('./cancelled-successor-retained-read.js');
  const host = await import('./host-turn-runner.js');
  const brackets = await import('./brackets.js');
  const envelopes = await import('../../agents/capability-envelope.js');
  const approvals = await import('./approval-registry.js');
  const callAuthority = await import('./accepted-turn-call-authority.js');
  const hostBindings = await import('./host-call-capability-binding.js');
  const { durableLogicalCallContract } = await import('./logical-call-contract.js');
  const n = ++inheritedAskSerial;
  const objective = input.objective ?? 'Read the named fixture and explain both lines. Do not reread, write or send.';
  const continuation = input.continuation ?? 'Continue. Preserve the same no-write requirement.';
  const continuity = { provider: 'desktop', scopeId: null, conversationId: `inherited-ask-${n}`, audienceId: 'fixture-owner' };
  const parent = eventlog.createSession({ id: `inherited-ask-parent-${n}`, kind: 'chat', channel: 'desktop',
    userId: continuity.audienceId, metadata: { source: continuity.provider, channelId: continuity.conversationId, userId: continuity.audienceId } });
  const attempt = eventlog.beginRunAttempt(parent.id, { runId: `inherited-ask-parent-run-${n}` });
  const source = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user',
    data: { text: objective, attemptId: attempt.attemptId, runId: attempt.runId } });
  const task = { sessionId: parent.id, sourceUserSeq: source.seq, turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(parent.id, source.seq) };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }));
  const logicalToolCallId = `logical:inherited-ask-read-${n}`, args = { path: 'named-controlled-fixture.txt' };
  const begun = dispatch.beginPhysicalDispatch({ identity: { ...task, logicalToolCallId,
    physicalDispatchId: `dispatch:inherited-ask-read-${n}`, ordinal: 0 }, tool: 'read_file', args, executionSite: 'host' });
  assert.equal(begun.status, 'inserted');
  if (begun.status !== 'inserted') throw new Error('fixture read not admitted');
  assert.equal(dispatch.settlePhysicalDispatch({ identity: begun.identity, tool: 'read_file', outcome: 'returned' }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({ identity: { ...task, logicalToolCallId },
    contract: { toolName: 'read_file', args }, execution: { kind: 'local_execution' },
    result: { payload: input.payload ?? 'FIRST\nREMAINING\n' }, outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false }, observer: { lane: 'claude_sdk', turn: 1 } });
  assert.equal(settled.status, 'committed');
  if (settled.status !== 'committed') throw new Error('fixture read not settled');
  const handle = settled.settlement.resultHandleId!;
  const steering = eventlog.appendEvent({ sessionId: parent.id, turn: 1, role: 'user', type: 'user_steer_note',
    data: { text: 'Keep the original line order.' } });
  eventlog.appendEvent({ sessionId: parent.id, turn: 1, role: 'system', type: 'user_steer_note_delivered',
    data: { sourceUserSeq: source.seq, noteSeqs: [steering.seq] } });
  const identity = { ...task, attemptId: attempt.attemptId, runId: attempt.runId };
  delivery.commitTurnOutcome({ version: 2, id: turnOutcomes.turnOutcomeId(identity), identity,
    status: 'cancelled', resumable: false, presentation: { kind: 'stopped', text: 'Stopped.' } });
  eventlog.finishRunAttempt(attempt, 'cancelled');
  eventlog.updateSession(parent.id, { status: 'cancelled' });
  const runId = `inherited-ask-child-run-${n}`;
  const claimed = selector.claimSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: parent.id,
    durableSourceId: runId, continuity, receipt: { requestId: `inherited-ask-request-${n}`, runId, inputHash: '1'.repeat(64) } });
  assert.equal(claimed.selection.disposition, 'branched');
  const sessionId = claimed.selection.sessionId;
  const childAttempt = eventlog.beginRunAttempt(sessionId, { runId });
  const childSource = eventlog.recordRunAttemptUserInput(childAttempt, { turn: 1, role: 'user',
    data: { text: continuation, runId, attemptId: childAttempt.attemptId } });
  const consumer = { sessionId, sourceUserSeq: childSource.seq, attemptId: childAttempt.attemptId };
  let modelCalls = 0;
  let writerEvidencePending = false;
  const primaryRequests: ModelRequest[] = [];
  async function run(replies: string[], options: Record<string, unknown> = {}, beforeModelFinish?: () => void) {
    const agent = { tools: [], model: {
      async getResponse(request: ModelRequest) {
        primaryRequests.push(request);
        if (modelCalls === 0 && writerEvidencePending) commitWriterReadEvidence();
        const text = replies[modelCalls++];
        assert.notEqual(text, undefined, 'no unplanned primary model round');
        return { usage: new Usage(), output: [{ type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text }] }], responseId: `inherited-ask-model-${n}-${modelCalls}` };
      },
      async *getStreamedResponse(this: { getResponse: (request: ModelRequest) => Promise<{ output: unknown[]; usage: Usage; responseId: string }> }, request: ModelRequest) {
        const response = await this.getResponse(request);
        beforeModelFinish?.();
        yield { type: 'response_started' };
        yield { type: 'model', event: { type: 'finish', finishReason: 'stop' } };
        yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } };
      },
    } };
    const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId, universeTools: [], activeToolNames: [],
      policyHash: 'controlled-inherited-ask-policy', budget: { maxUncachedTokens: 1_000, maxModelCalls: 8, maxToolCalls: 8, maxElapsedMs: 60_000 } });
    assert.equal(sealed.ok, true); if (!sealed.ok) throw new Error('fixture surface not sealed');
    envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
    envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
    const runner = new EventEmitter();
    Object.assign(runner, { run: () => { throw new Error('Runner.run must not be called'); } });
    return brackets.withHarnessRunContext({ sessionId, sourceUserSeq: childSource.seq,
      runAttemptId: childAttempt.attemptId, interactiveForeground: true, counter: new brackets.ToolCallsCounter(8) },
      () => host.hostRunRunner(runner as never, agent as never,
        [{ type: 'message', role: 'user', content: continuation }] as never,
        { maxTurns: 4, hostTurnEngine: 'host_v1', hostJudgeCompletion: true,
          context: { sessionId, sourceUserSeq: childSource.seq }, ...options } as never));
  }
  const reviews = () => eventlog.listEvents(sessionId, { types: ['goal_alignment_judged'] }).filter(row => row.data.kind === 'completion');
  const assertNoChildEffects = () => {
    assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) n FROM physical_dispatches WHERE session_id=?').get(sessionId) as { n: number }).n, 0);
    assert.equal(eventlog.getRunAttemptBySourceUserSeq(parent.id, source.seq)?.status, 'cancelled');
  };
  const commitWriterReadEvidence = () => {
    const childTask = { sessionId, sourceUserSeq: childSource.seq, turn: 1,
      acceptedTaskId: identities.acceptedTaskIdFor(sessionId, childSource.seq) };
    for (let index = 0; index < 2; index++) {
      const logicalToolCallId = `logical:controlled-writer-read-${n}-${index}`;
      const args = { path: `controlled-writer-report-${index}.txt` };
      const root = callAuthority.acceptedTurnCallAuthorityFor(sessionId, childSource.seq);
      assert.equal(root.status, 'ok');
      if (root.status !== 'ok') throw new Error('controlled writer read lacks current host authority');
      const contract = durableLogicalCallContract(childTask.acceptedTaskId, 'read_file', args)!;
      const base = { sessionId, sourceUserSeq: childSource.seq, acceptedTaskId: childTask.acceptedTaskId,
        sourceEventId: root.authority.sourceEventId, sourceEventDigest: root.authority.sourceEventDigest,
        logicalToolCallId, toolName: contract.toolName, argumentDigest: contract.argumentDigest,
        effect: 'read' as const, bindingKind: 'local_envelope' as const, capabilityId: 'read_file',
        schemaFingerprint: 'a'.repeat(64), accountId: '', invokePortId: 'fixture:read', operationId: 'read_file',
        manifestId: '', manifestDigest: '', engineVersion: root.authority.engineVersion,
        surfaceVersion: root.authority.surfaceVersion, authorityDigest: root.authority.authorityDigest,
        authorityRevision: root.authority.revision, surfaceDigest: root.authority.surfaceDigest,
        catalogRevisionDigest: root.authority.catalogRevisionDigest!, bindingRevisionDigest: root.authority.bindingRevisionDigest! };
      const begun = callAuthority.withHostCallAttestation({ ...base,
        bindingDigest: hostBindings.hostCallAttestationBindingDigest(base) }, () => dispatch.beginPhysicalDispatch({
        identity: { ...childTask, logicalToolCallId, physicalDispatchId: `dispatch:controlled-writer-read-${n}-${index}`, ordinal: 0 },
        tool: 'read_file', args, executionSite: 'host' }));
      assert.equal(begun.status, 'inserted', JSON.stringify(begun));
      if (begun.status !== 'inserted') throw new Error('controlled writer read not admitted');
      assert.equal(dispatch.settlePhysicalDispatch({ identity: begun.identity, tool: 'read_file', outcome: 'returned' }).status, 'inserted');
      assert.equal(settlements.commitLogicalCallSettlement({ identity: { ...childTask, logicalToolCallId },
        contract: { toolName: 'read_file', args }, execution: { kind: 'local_execution' },
        result: { payload: `Controlled supporting report ${index}` }, outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
        recovery: { businessCall: true, mutating: false }, observer: { lane: 'claude_sdk', turn: 1 } }).status, 'committed');
    }
    writerEvidencePending = false;
  };
  const seedWriterReadEvidence = () => { writerEvidencePending = true; };
  return { eventlog, host, shares, approvals, objective, consumer, childSource, handle, run, reviews,
    modelCalls: () => modelCalls, primaryRequests, seedWriterReadEvidence, assertNoChildEffects };
}

test('an inherited-read ASK is reviewed against the whole stopped objective and repaired without rereading', async () => {
  const f = await inheritedAskFixture();
  const ask = 'ASK: I cannot see the saved read. Could you read the fixture again?';
  const answer = 'The retained read contains FIRST followed by REMAINING. Nothing was read again, written or sent.';
  script = ['INCOMPLETE: the exact saved read is already available; answer both lines without rereading.',
    'DONE: the answer explains the two shown lines and respects the no-reread requirement.\nNEEDS ALL OF: none'];
  const result = await f.run([ask, answer]);
  assert.equal(result.finalOutput, answer);
  assert.equal(f.modelCalls(), 2);
  assert.equal(requests.length, 2, 'ASK cannot waive the existing whole-objective reviewer');
  assert.match(promptOf(requests[0]!), /Read the named fixture and explain both lines/);
  assert.match(promptOf(requests[0]!), /Keep the original line order/);
  assert.match(promptOf(requests[0]!), /Preserve the same no-write requirement/);
  assert.match(promptOf(requests[0]!), /whole effective objective together with current amendments/);
  assert.match(promptOf(requests[0]!), /inherited-read:/);
  for (const row of f.reviews()) {
    assert.equal(row.data.inheritedReadReviewRequired, true);
    assert.ok(row.data.judgedInheritedReadResults);
    assert.deepEqual(row.data.judgedReadResults, [], 'no child count or evidence inflation');
    assert.equal(row.data.judgedHistoricalReadResults, undefined, 'unknown completeness cannot enable historical fast closure');
  }
  f.assertNoChildEffects();
});

test('review-confirmed required input remains a typed inherited-read pause without further execution', async () => {
  const f = await inheritedAskFixture();
  const ask = 'ASK: The retained lines are FIRST and REMAINING. Which interpretation did you intend?';
  script = ['AWAITING: the owner must choose the intended interpretation of the retained lines.'];
  const result = await f.run([ask]);
  assert.equal(result.finalOutput, ask);
  assert.deepEqual(result.terminal, { status: 'awaiting_user_input', reason: 'completion_review_needs_input' });
  assert.equal(f.modelCalls(), 1);
  assert.equal(requests.length, 1);
  assert.equal(f.reviews()[0]?.data.awaitingUser, true);
  assert.equal(f.reviews()[0]?.data.fulfills, false, 'a verified question is not task completion');
  assert.equal(f.reviews()[0]?.data.inheritedReadReviewRequired, true);
  f.assertNoChildEffects();
});

test('a reviewed ASK marker cannot turn an honest question into a done terminal', async () => {
  const f = await inheritedAskFixture();
  const ask = 'ASK: FIRST and REMAINING are retained. Which interpretation did you intend?';
  script = ['DONE: the shown lines and question are supported.\nNEEDS ALL OF: none'];
  const result = await f.run([ask]);
  const { toOrchestratorDecision } = await import('./turn-decision.js');
  assert.equal(result.finalOutput, ask);
  assert.equal(toOrchestratorDecision(result.finalOutput)?.nextAction, 'awaiting_user_input');
  assert.equal(toOrchestratorDecision(result.finalOutput)?.done, false);
  assert.equal(requests.length, 1);
  f.assertNoChildEffects();
});

test('an owner-disabled captured policy is not overridden by inherited-read ASK eligibility', async () => {
  const f = await inheritedAskFixture();
  f.host.captureEffectiveCompletionPolicyOnce({ ...f.consumer, enabled: false });
  const ask = 'ASK: FIRST and REMAINING are retained. Which interpretation did you intend?';
  const result = await f.run([ask]);
  assert.equal(result.finalOutput, ask);
  assert.equal(requests.length, 0);
  assert.equal(f.reviews().length, 0);
  assert.equal(f.host.readCapturedCompletionPolicy(f.consumer).status, 'captured');
  f.assertNoChildEffects();
});

test('pending approval and caller cancellation still fence inherited-read ASK review without granting effects', async t => {
  await t.test('an exact pending approval keeps its own pause', async () => {
    const f = await inheritedAskFixture();
    const approval = f.approvals.register({ sessionId: f.consumer.sessionId, channel: 'desktop',
      subject: 'Controlled pending send', tool: 'send_message', args: { message: 'fixture-only' }, ttlMs: 60_000 });
    const result = await f.run(['ASK: Should I send the prepared message?'], {
      hostQueuedApprovalBeforeCompletion: () => ({ approvalIds: [approval.approvalId], unregisteredActionIds: [] }),
    });
    assert.deepEqual(result.terminal, { status: 'awaiting_approval', reason: 'queued_action_approval', approvalId: approval.approvalId });
    assert.equal(requests.length, 0);
    assert.equal(f.reviews().length, 0);
    assert.equal(f.approvals.get(approval.approvalId)?.status, 'pending');
    assert.equal(f.approvals.get(approval.approvalId)?.consumedAt, null);
    f.assertNoChildEffects();
  });
  await t.test('caller cancellation fences review and further work after an in-flight primary response', async () => {
    const f = await inheritedAskFixture();
    const controller = new AbortController();
    await assert.rejects(f.run(['ASK: Should I continue?'], { signal: controller.signal },
      () => controller.abort(new Error('controlled caller Stop'))), (error: unknown) =>
      error instanceof Error && error.name === 'KillRequested'
      && (error as { sessionId?: string }).sessionId === f.consumer.sessionId);
    assert.equal(f.modelCalls(), 1, 'the interrupted response never triggers another round');
    assert.equal(requests.length, 0);
    assert.equal(f.reviews().length, 0);
    f.assertNoChildEffects();
  });
});

test('missing required inherited bytes cannot fall back to empty-context ASK review', async () => {
  const f = await inheritedAskFixture();
  f.eventlog.openEventLog().prepare("UPDATE events SET data_json=json_set(data_json,'$.cancelledReadShares[0].rawPayloadSha256','changed') WHERE session_id=? AND type='cross_session_prefix'")
    .run(f.consumer.sessionId);
  assert.equal(f.shares.cancelledSuccessorReadReviewRequired(f.consumer), true);
  const ask = 'ASK: The retained read is unavailable. Could you provide it again?';
  const result = await f.run([ask]);
  assert.equal(result.finalOutput, ask);
  assert.equal(requests.length, 0, 'unavailable proof does not become ordinary zero-evidence review');
  assert.equal(f.reviews()[0]?.data.inheritedReadReviewRequired, true);
  assert.equal(f.reviews()[0]?.data.failedOpen, true);
  assert.equal(f.reviews()[0]?.data.judgedInheritedReadResults, undefined);
  assert.equal(f.host.completionVerdictForAcceptedSource(f.consumer)?.fulfills, false);
  f.assertNoChildEffects();
});

const JSON_CONTINUATION_OBJECTIVE = 'Read the named fixture. Then return one bounded JSON object with first_count, '
  + 'remaining_count, byte_count and scenarios. Do not reread, write or send. Preserve unknown completeness.';
const JSON_CONTINUATION_ANSWER = JSON.stringify({ first_count: 1, remaining_count: 1, byte_count: 16,
  scenarios: { uncertain_write: 'Unresolved: do not repeat the write.' }, semanticCompleteness: 'unknown' });

function stubFormatWorker(answer: string, observed: ModelRequest[]): void {
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
    { role: 'judge', modelId: 'claude-sonnet-5', scope: 'durable', source: 'settings' },
    { role: 'worker', modelId: 'gpt-5.6-terra', scope: 'durable', source: 'settings' },
  ]);
  const model: Model = {
    async getResponse(request) {
      observed.push(request);
      return { output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: answer, providerData: {} }] }], usage: new Usage(),
        responseId: `format-worker-${observed.length}` } as ModelResponse;
    },
    async *getStreamedResponse(request) {
      const response = await model.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'model', event: { type: 'finish', finishReason: 'stop' } } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
  mock.method(CodexModelProvider.prototype, 'getModel', () => model);
}

test('a prose-wrapped JSON candidate returns to its primary author instead of an unrelated worker', async () => {
  const f = await inheritedAskFixture({ objective: JSON_CONTINUATION_OBJECTIVE });
  const wrapped = `Saved evidence:\n\`\`\`json\n${JSON_CONTINUATION_ANSWER}\n\`\`\`\nNo new writes.`;
  const repaired: ModelRequest[] = [];
  stubFormatWorker(JSON_CONTINUATION_ANSWER, repaired);
  script = ['DONE: the counts and uncertainty qualifier are supported.\nNEEDS ALL OF: none',
    'DONE: the whole JSON object preserves the counts and honest uncertainty.\nNEEDS ALL OF: none'];
  const result = await f.run([wrapped, JSON_CONTINUATION_ANSWER]);
  assert.equal(result.finalOutput, JSON_CONTINUATION_ANSWER, 'only a new reviewed candidate replaces the draft');
  assert.equal(f.modelCalls(), 2);
  assert.equal(repaired.length, 0, 'a configured worker cannot replace the actual final author');
  assert.equal(requests.length, 2, 'the full review occurs on both exact candidates');
  assert.match(promptOf(requests[0]!), /complete final answer must parse as a JSON object/);
  assert.match(promptOf(requests[0]!), /scenarios/);
  assert.match(promptOf(requests[1]!), /Keep the original line order/);
  assert.match(promptOf(f.primaryRequests[1]!), /Preserve the same no-write requirement/);
  assert.match(promptOf(requests[1]!), /Preserve unknown completeness/);
  assert.match(promptOf(f.primaryRequests[1]!), /Unresolved/);
  assert.doesNotMatch(promptOf(f.primaryRequests[1]!), /scenarios must be an array/);
  const [rejected, accepted] = f.reviews();
  assert.equal(rejected?.data.fulfills, false);
  assert.equal(rejected?.data.repairScope, 'reply_format');
  assert.equal(rejected?.data.failedOpen, undefined);
  assert.equal(rejected?.data.judgeModelId, 'claude-sonnet-5');
  assert.deepEqual(rejected?.data.responseFormatContract, { kind: 'whole_json_object', candidateValid: false });
  assert.equal(accepted?.data.fulfills, true);
  assert.deepEqual(accepted?.data.responseFormatContract, { kind: 'whole_json_object', candidateValid: true });
  assert.ok(accepted?.data.judgedInheritedReadResults, 'normal exact historical evidence review survives repair');
  f.assertNoChildEffects();
});

test('an exact whole-output JSON object with a scenario map passes its normal review without a format round', async () => {
  const f = await inheritedAskFixture({ objective: JSON_CONTINUATION_OBJECTIVE });
  const repaired: ModelRequest[] = [];
  stubFormatWorker('UNEXPECTED FORMAT REPAIR', repaired);
  script = ['DONE: the exact JSON answer is supported and unknown completeness remains unknown.\nNEEDS ALL OF: none'];
  const result = await f.run([JSON_CONTINUATION_ANSWER]);
  assert.equal(result.finalOutput, JSON_CONTINUATION_ANSWER);
  assert.equal(f.modelCalls(), 1);
  assert.equal(requests.length, 1);
  assert.equal(repaired.length, 0);
  const instructions = String(requests[0]!.systemInstructions);
  assert.equal(instructions.match(/STOP \/ CONTINUE REASONING:/g)?.length, 1);
  assert.doesNotMatch(promptOf(requests[0]!), /STOP \/ CONTINUE REASONING:/,
    'exact inherited results remain evidence, without duplicating cached review rules');
  assert.equal(f.reviews()[0]?.data.fulfills, true);
  assert.deepEqual(f.reviews()[0]?.data.responseFormatContract, { kind: 'whole_json_object', candidateValid: true });
  f.assertNoChildEffects();
});

test('a tool-free format repair reuses the exact captured final writer even if role settings change', async () => {
  const f = await inheritedAskFixture({ objective: JSON_CONTINUATION_OBJECTIVE });
  f.seedWriterReadEvidence();
  const unrelatedWorkerRequests: ModelRequest[] = [];
  stubFormatWorker('UNEXPECTED OTHER PROVIDER', unrelatedWorkerRequests);
  const writerRequests: ModelRequest[] = [];
  const wrapped = `Saved evidence:\n\`\`\`json\n${JSON_CONTINUATION_ANSWER}\n\`\`\`\nNo new writes.`;
  const author = { modelId: 'claude-opus-5.5', provider: 'claude' as const, source: 'settings' as const };
  const model: Model = {
    async getResponse(request) {
      writerRequests.push(request);
      assert.ok(writerRequests.length <= 2, 'the final author is not sent through another writer pass');
      // A settings change must not replace the already captured author.
      if (writerRequests.length === 1) f.host._setHostWriterForTests(() => ({
        resolved: { modelId: 'gpt-5.6-terra', provider: 'codex', source: 'settings' },
        model: { getResponse: async () => { throw new Error('new writer must not replace captured author'); } } as never,
      }));
      const text = writerRequests.length === 1 ? wrapped : JSON_CONTINUATION_ANSWER;
      return { output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, providerData: {} }] }], usage: new Usage(),
        responseId: `captured-writer-${writerRequests.length}` } as ModelResponse;
    },
    async *getStreamedResponse(request) {
      const response = await model.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'model', event: { type: 'finish', finishReason: 'stop' } } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
  f.host._setHostWriterForTests(() => ({ resolved: author, model }));
  script = ['DONE: the counts and uncertainty qualifier are supported.\nNEEDS ALL OF: none',
    'DONE: the whole JSON object preserves the truthful semantic answer.\nNEEDS ALL OF: none'];
  try {
    const result = await f.run(['Brain draft with supported counts.'], { maxTurns: 5 });
    assert.equal(result.finalOutput, JSON_CONTINUATION_ANSWER, JSON.stringify({ terminal: result.terminal,
      guide: f.eventlog.listEvents(f.consumer.sessionId, { types: ['guardrail_tripped'] }).map(row => ({
        kind: row.data.kind, reason: row.data.reason, modelId: row.data.modelId, phase: row.data.phase })) }));
    assert.equal(f.modelCalls(), 1);
    assert.equal(writerRequests.length, 2);
    assert.equal(unrelatedWorkerRequests.length, 0);
    assert.deepEqual(writerRequests[1]!.tools, [], 'formatting conveys no business-tool authority');
    const packet = JSON.parse((writerRequests[1]!.input as Array<{ content: string }>)[0]!.content);
    assert.equal(packet.draft, wrapped);
    assert.match(packet.objective, /Keep the original line order/);
    assert.match(packet.objective, /Preserve the same no-write requirement/);
    assert.match(packet.objective, /Preserve unknown completeness/);
    assert.equal(requests.length, 2, 'both exact writer candidates receive full review');
    const [rejected, accepted] = f.reviews();
    assert.equal(rejected?.data.fulfills, false);
    assert.equal(accepted?.data.fulfills, true);
    assert.equal(rejected?.data.selfJudge, true, 'the Claude-family qualifier is not hidden by formatting');
    assert.equal(accepted?.data.selfJudge, true);
    const repair = f.eventlog.listEvents(f.consumer.sessionId, { types: ['guardrail_tripped'] })
      .find(row => row.data.kind === 'response_format_repair');
    assert.equal(repair?.data.modelId, author.modelId);
    assert.equal(repair?.data.provider, author.provider);
    assert.equal(repair?.data.role, 'writer');
    const dispatchCount = f.eventlog.openEventLog().prepare('SELECT COUNT(*) n FROM physical_dispatches WHERE session_id=?')
      .get(f.consumer.sessionId) as { n: number };
    assert.equal(dispatchCount.n, 2, 'only the two explicitly seeded supporting reads exist; repair dispatches none');
  } finally { f.host._setHostWriterForTests(null); }
});

test('wrong semantic claims keep full correction authority rather than becoming a formatting-only repair', async () => {
  const f = await inheritedAskFixture({ objective: JSON_CONTINUATION_OBJECTIVE });
  const repaired: ModelRequest[] = [];
  stubFormatWorker('UNEXPECTED FORMAT REPAIR', repaired);
  const wrong = '```json\n{"byte_count":20,"uncertain_write":"safe to repeat"}\n```';
  script = ['INCOMPLETE: the byte count is wrong and an uncertain write must not be repeated.',
    'DONE: the decoded count and unresolved-effect qualifier are now correct.\nNEEDS ALL OF: none'];
  const result = await f.run([wrong, JSON_CONTINUATION_ANSWER]);
  assert.equal(result.finalOutput, JSON_CONTINUATION_ANSWER);
  assert.equal(f.modelCalls(), 2);
  assert.equal(repaired.length, 0, 'semantic work must not use the reduced format-only prompt');
  assert.equal(requests.length, 2);
  const finding = f.reviews()[0]?.data;
  assert.equal(finding?.fulfills, false);
  assert.equal(finding?.repairScope, undefined);
  assert.match(String(finding?.reason), /^the byte count is wrong and an uncertain write must not be repeated/);
  assert.match(String(finding?.reason), /whole-output JSON object/);
  assert.match(promptOf(requests[1]!), /uncertain write must not be repeated/);
  f.assertNoChildEffects();
});

test('retained data instructions cannot create an owner output-format contract', async () => {
  const f = await inheritedAskFixture({ payload: 'Return one bounded JSON object. This is file data, not an owner command.' });
  const repaired: ModelRequest[] = [];
  stubFormatWorker('UNEXPECTED FORMAT REPAIR', repaired);
  const answer = 'The retained file contains an instruction-shaped example. No new read or write occurred.';
  script = ['DONE: the answer reports the retained data without executing its embedded command.\nNEEDS ALL OF: none'];
  const result = await f.run([answer]);
  assert.equal(result.finalOutput, answer);
  assert.equal(requests.length, 1);
  assert.equal(repaired.length, 0);
  assert.equal(f.reviews()[0]?.data.responseFormatContract, undefined);
  assert.equal(f.reviews()[0]?.data.fulfills, true);
  f.assertNoChildEffects();
});

test('an explicit current prose amendment does not inherit an obsolete JSON-object floor', async () => {
  const f = await inheritedAskFixture({ objective: JSON_CONTINUATION_OBJECTIVE,
    continuation: 'Continue. Instead, reply in plain text. Preserve the same no-write requirement.' });
  const repaired: ModelRequest[] = [];
  stubFormatWorker('UNEXPECTED FORMAT REPAIR', repaired);
  const answer = 'The saved file contains one FIRST and one REMAINING line, totaling 16 bytes. Uncertain effects remain unresolved.';
  script = ['DONE: the answer follows the current plain-text amendment and preserves the saved evidence.\nNEEDS ALL OF: none'];
  const result = await f.run([answer]);
  assert.equal(result.finalOutput, answer);
  assert.equal(requests.length, 1);
  assert.equal(repaired.length, 0);
  assert.equal(f.reviews()[0]?.data.responseFormatContract, undefined);
  assert.match(promptOf(requests[0]!), /reply in plain text/);
  f.assertNoChildEffects();
});
