import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-objective-judge-coverage-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { Usage } = await import('@openai/agents');
const { ClaudeModelProvider } = await import('./claude-model.js');
const { CodexModelProvider } = await import('./codex-model.js');
const { judgeObjectiveComplete } = await import('./objective-judge.js');
const { resetJudgeMetricsForTests } = await import('./judge-family.js');
const { _setDiscoveredModelsForTest } = await import('./model-discovery.js');
const { closeEventLog } = await import('./eventlog.js');

/** One scripted reviewer turn: a verdict, or a lookup the runner executes. */
type Step = string | { tool: 'open_evidence' | 'query_evidence'; args: Record<string, unknown> };
let script: Step[] = [];
const requests: ModelRequest[] = [];

const reviewer: Model = {
  async getResponse(request): Promise<ModelResponse> {
    requests.push(request);
    const step = script.shift();
    if (step === undefined) throw new Error('the reviewer was asked more often than this review allows');
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

test('the reviewer is told before it rules which results it holds only in part', async () => {
  script = ['DONE: the event was created, confirmed by its write receipt.\nNEEDS ALL OF: call_write'];
  const verdict = await review();
  assert.equal(verdict.done, true);
  assert.equal(requests.length, 1, 'a verdict resting on results shown whole costs no further call');
  assert.match(promptOf(requests[0]!), /RESULTS YOU HAVE ONLY IN PART/);
  assert.match(promptOf(requests[0]!), /call_list \(provider_list_records\): 3600 of 51000 bytes shown; 94 records; nothing else opened/);
  assert.match(promptOf(requests[0]!), /read before a write by this request/);
  assert.equal(verdict.evidenceCoverage?.status, 'sufficient');
  assert.deepEqual(verdict.evidenceCoverage?.needsAllOf, ['call_write']);
  assert.deepEqual(verdict.evidenceCoverage?.open.map((row) => row.ref), ['call_list'],
    'the uninspected result stays on the record even though the verdict does not rest on it');
  assert.equal(verdict.evidenceCoverage?.followUp, undefined);
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

test('a verdict that never says what it needs the whole of is asked once, then stands as unattested', async () => {
  script = ['DONE: the event was created.', 'DONE: the event was created, confirmed by its receipt.'];
  const verdict = await review();
  assert.equal(requests.length, 2);
  assert.match(promptOf(requests[1]!), /did not say which results it needs the whole of/);
  assert.equal(verdict.done, true, 'nothing shows the verdict needs the unopened result, so the work is not sent back');
  assert.equal(verdict.evidenceCoverage?.status, 'unattested');
  assert.equal(verdict.evidenceCoverage?.needsAllOf, null);
});

test('a follow-up that gets no answer leaves the first verdict and its record standing', async () => {
  script = ['DONE: the event was created.', 'The receipt looks right to me.', 'Still no verdict line here.'];
  const verdict = await review();
  assert.equal(verdict.done, true);
  assert.equal(verdict.evidenceCoverage?.status, 'unattested');
  assert.equal(verdict.evidenceCoverage?.followUp, 'unanswered');
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
