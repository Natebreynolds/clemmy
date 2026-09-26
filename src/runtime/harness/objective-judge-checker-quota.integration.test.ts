/**
 * The completion checker when its provider's plan quota is used up.
 *
 * Live 2026-09-21: with the Claude five-hour window at 100%, every completion
 * review failed open as "unreviewed" and the answer shipped unchecked, because
 * claudeAvailable() has no quota check and the review resolves one checker
 * plus a hedge, not a chain.
 *
 * These pins drive the REAL completion routing — judgeObjectiveComplete →
 * runCompletionJudge → runHedgedJudge → route resolution → Agents Runner —
 * with only the provider wires stubbed. Quota state comes from the app's own
 * trackers: the Claude usage meter (claude-usage.ts) and the Codex quota store
 * (rate-limit-store.ts). Brain routing is out of scope and must not move.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelResponse } from '@openai/agents-core';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-checker-quota-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
// Keeps the Codex quota store in memory: a reading from one pin must not
// persist into the next.
process.env.NODE_ENV = 'test';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { Usage } = await import('@openai/agents');
const { ClaudeModelProvider } = await import('./claude-model.js');
const { CodexModelProvider } = await import('./codex-model.js');
const { captureBoundaryJudgeSelection } = await import('./debate-model.js');
const { judgeObjectiveComplete } = await import('./objective-judge.js');
const { boundaryClaudeJudgeModel, boundaryCodexJudgeModel, claudeAvailable, debateBrainsAvailable,
  getJudgeMetricsSnapshot, resetJudgeMetricsForTests } = await import('./judge-family.js');
const { __setClaudeUsageForTests } = await import('./claude-usage.js');
type ClaudeUsageSnapshot = import('./claude-usage.js').ClaudeUsageSnapshot;
const { recordCodexRateLimit, __resetRateLimitStoreForTests } = await import('./rate-limit-store.js');
const { _setDiscoveredModelsForTest } = await import('./model-discovery.js');
const { resolveRoleModel } = await import('./model-roles.js');
const { closeEventLog, createSession, appendEvent, listEvents } = await import('./eventlog.js');

const PINNED = 'claude-sonnet-5';
const HOUR = 3_600_000;

/** How the Claude wire behaves: it answers, refuses the way an exhausted
 *  account does, or fails in a way that has nothing to do with quota. */
type ClaudeWire = 'answers' | 'bare_429' | 'out_of_extra_usage' | 'transport_error' | 'invalid' | 'hung';
let claudeWire: ClaudeWire = 'answers';
const calls: Array<{ provider: 'claude' | 'codex'; modelId?: string }> = [];

function verdictResponse(text: string, id: string): ModelResponse {
  return {
    output: [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, providerData: {} }] }],
    usage: new Usage(), responseId: id,
  } as ModelResponse;
}

function wire(provider: 'claude' | 'codex', modelId?: string): Model {
  return {
    async getResponse(): Promise<ModelResponse> {
      calls.push({ provider, modelId });
      if (provider === 'claude' && claudeWire === 'bare_429') {
        throw Object.assign(new Error('rate_limit_error'), { status: 429 });
      }
      if (provider === 'claude' && claudeWire === 'out_of_extra_usage') {
        // The provider's own words when extra usage is spent (live 2026-09-23).
        throw Object.assign(new Error("You're out of extra usage. Add more at claude.ai/settings/usage and keep going."), { status: 400 });
      }
      if (provider === 'claude' && claudeWire === 'transport_error') throw new Error('fixture checker transport unavailable');
      if (provider === 'claude' && claudeWire === 'hung') return new Promise<ModelResponse>(() => {});
      if (provider === 'claude' && claudeWire === 'invalid') return verdictResponse('not a verdict', 'fixture-claude');
      // Each family rules differently, so a verdict shows who ruled.
      return provider === 'claude'
        ? verdictResponse('INCOMPLETE: the receipts are absent', 'fixture-claude')
        : verdictResponse('DONE: every receipt is present', 'fixture-codex');
    },
    async *getStreamedResponse() { throw new Error('a checker uses its one-turn request'); },
  };
}

function writeAuth(codexSignedIn = true, claudeSignedIn = true): void {
  writeFileSync(path.join(TEST_HOME, 'state', 'auth.json'), JSON.stringify(codexSignedIn
    ? { codexOauth: { accessToken: 'fixture-codex-access', refreshToken: 'fixture-codex-refresh' } }
    : {}));
  // An explicit token keeps the operator's keychain out of it; a non-subscription
  // token is how a signed-out Claude account looks.
  writeFileSync(path.join(TEST_HOME, 'state', 'claude-auth.json'), JSON.stringify({
    accessToken: claudeSignedIn ? 'sk-ant-oat01-fixture' : 'sk-ant-api03-no-subscription', expiresAt: Date.now() + HOUR,
  }));
}

function pinJudge(modelId: string | null): void {
  process.env.CLEMMY_MODEL_ROLES = modelId
    ? JSON.stringify([{ role: 'judge', modelId, scope: 'durable', source: 'settings' }])
    : '[]';
}

/** A usage reading as the meter stores it. */
function claudeReading(fiveHour: number, options: { capturedAgoMs?: number; resetInMs?: number; extraUsage?: boolean } = {}): ClaudeUsageSnapshot {
  const now = Date.now();
  return {
    fiveHour: { usedPercent: fiveHour, resetAt: now + (options.resetInMs ?? HOUR) },
    weekly: { usedPercent: 20, resetAt: now + 72 * HOUR },
    ...(options.extraUsage === undefined ? {} : { extraUsageEnabled: options.extraUsage }),
    capturedAt: now - (options.capturedAgoMs ?? 0),
  };
}

function exhaustCodex(): void {
  recordCodexRateLimit({
    'x-codex-primary-used-percent': '100',
    'x-codex-primary-reset-after-seconds': '3600',
    'x-codex-primary-window-minutes': '300',
  });
}

beforeEach(() => {
  mock.restoreAll();
  calls.length = 0;
  claudeWire = 'answers';
  Object.assign(process.env, {
    // A Codex brain whose owner chose a Claude checker: the 09-21 shape.
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra',
    CLEMMY_JUDGE_CROSS_FAMILY: 'on', CLEMMY_JUDGE_HEDGE: 'on', CLEMMY_JUDGE_HEDGE_DELAY_MS: '500',
    CLEMMY_JUDGE_CHAIN: 'on', CLEMMY_COMPLETION_REVIEW: 'on', CLEMMY_CLAUDE_OVERLOAD_FALLBACK: 'off',
    CLEMMY_CLAUDE_TRANSPORT: 'raw_messages', CLEMMY_DEBATE_JUDGE: '',
    BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '', BYO_MODEL_ID: '', BYO_PROVIDERS: '',
    CLEMMY_BOUNDARY_JUDGE_CLAUDE_MODEL: '', CLEMMY_BOUNDARY_JUDGE_CODEX_MODEL: '',
    CLEMMY_EXACT_JUDGE_TIMEOUT_MS: '90000',
  });
  pinJudge(PINNED);
  writeAuth();
  _setDiscoveredModelsForTest({ anthropic: [], openai: [] });
  resetJudgeMetricsForTests();
  __setClaudeUsageForTests(null);
  __resetRateLimitStoreForTests();
  // Stub only the provider wires. Role resolution, the quota trackers, the
  // concrete adapter binding, route metrics, the Runner, the hedge engine and
  // the verdict parser are all real.
  mock.method(ClaudeModelProvider.prototype, 'getModel', (id?: string) => wire('claude', id));
  mock.method(CodexModelProvider.prototype, 'getModel', (id?: string) => wire('codex', id));
});

after(() => {
  mock.restoreAll();
  closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

/** One completion review, with the selection captured at acceptance as the
 *  host captures it. */
async function review() {
  const boundaryJudgeSelection = captureBoundaryJudgeSelection();
  return judgeObjectiveComplete('Confirm the eight worker receipts.', 'All eight receipts are saved.', {
    skills: [], toolCallSummary: 'Eight receipts were requested.', boundaryJudgeSelection,
  });
}

test('with quota to spare, the owner’s chosen checker reviews and nothing stands in', async () => {
  for (const reading of [null, claudeReading(40)]) {
    calls.length = 0;
    __setClaudeUsageForTests(reading);
    const verdict = await review();
    assert.equal(verdict.done, false, 'the chosen checker’s own finding stands');
    assert.equal(verdict.failedOpen, undefined);
    assert.equal(verdict.judgeModelId, PINNED);
    assert.equal(verdict.judgeProvider, 'claude');
    assert.equal(verdict.ownerSelectedJudge, true);
    assert.equal(verdict.substituteForExactPin, undefined);
    assert.deepEqual(calls, [{ provider: 'claude', modelId: PINNED }]);
  }
});

test('a used-up Claude plan window moves the review to the next family and records who judged', async () => {
  __setClaudeUsageForTests(claudeReading(100));
  claudeWire = 'bare_429'; // what the account would answer if it were dialed
  const verdict = await review();
  assert.equal(verdict.failedOpen, undefined, 'a stand-in reviewed; nothing passed unreviewed');
  assert.equal(verdict.done, true, 'the stand-in’s finding is the verdict');
  assert.equal(verdict.judgeModelId, boundaryCodexJudgeModel());
  assert.equal(verdict.judgeProvider, 'codex');
  assert.equal(verdict.substituteForExactPin, true);
  assert.equal(verdict.requestedJudgeModelId, PINNED);
  assert.equal(verdict.substituteReason, 'exact_pin_quota_exhausted');
  assert.equal(verdict.ownerSelectedJudge, undefined, 'a stand-in is never the owner’s choice');
  assert.equal(verdict.selfJudge, true, 'the only family left wrote the answer; it says so');
  assert.deepEqual(calls, [{ provider: 'codex', modelId: boundaryCodexJudgeModel() }],
    'the exhausted account is not dialed');
  const metric = getJudgeMetricsSnapshot().lanes.find((lane) => lane.lane === 'completion');
  assert.equal(metric?.lastModelId, boundaryCodexJudgeModel());
  assert.equal(metric?.lastJudgeFamily, 'codex');
});

test('an unpinned default checker falls through the same way, without claiming to stand in for a pin', async () => {
  pinJudge(null);
  __setClaudeUsageForTests(claudeReading(100));
  claudeWire = 'bare_429';
  const selection = captureBoundaryJudgeSelection();
  assert.equal(selection.status === 'captured' && selection.role.provider, 'claude',
    'the default checker for a Codex brain is the other family');
  const verdict = await judgeObjectiveComplete('Confirm the eight worker receipts.', 'All eight receipts are saved.', {
    skills: [], toolCallSummary: 'Eight receipts were requested.', boundaryJudgeSelection: selection,
  });
  assert.equal(verdict.failedOpen, undefined);
  assert.equal(verdict.judgeModelId, boundaryCodexJudgeModel());
  assert.equal(verdict.substituteForExactPin, undefined, 'no pin was requested');
  assert.equal(verdict.requestedJudgeModelId, undefined);
  assert.deepEqual(calls.map((call) => call.provider), ['codex']);
});

test('a pinned Codex checker out of quota falls through too, instead of reading as merely unavailable', async () => {
  // codexAvailable() already counts quota, so without the checker's own
  // question this pin resolved as "Configured boundary judge … is unavailable".
  pinJudge('gpt-5.6-terra');
  exhaustCodex();
  const verdict = await review();
  assert.equal(verdict.failedOpen, undefined);
  assert.equal(verdict.done, false, 'the stand-in’s own finding');
  assert.equal(verdict.judgeModelId, boundaryClaudeJudgeModel());
  assert.equal(verdict.judgeProvider, 'claude');
  assert.equal(verdict.selfJudge, false, 'a different family from the Codex brain');
  assert.equal(verdict.substituteForExactPin, true);
  assert.equal(verdict.requestedJudgeModelId, 'gpt-5.6-terra');
  assert.equal(verdict.substituteReason, 'exact_pin_quota_exhausted');
  assert.deepEqual(calls, [{ provider: 'claude', modelId: boundaryClaudeJudgeModel() }]);
});

test('a checker refused for quota at call time moves to the next family within the same review', async () => {
  // Extra usage is on, so the meter's 100% alone proves nothing; the
  // provider's own refusal does.
  __setClaudeUsageForTests(claudeReading(100, { extraUsage: true }));
  claudeWire = 'out_of_extra_usage';
  const verdict = await review();
  assert.equal(verdict.failedOpen, undefined);
  assert.equal(verdict.judgeModelId, boundaryCodexJudgeModel());
  assert.equal(verdict.substituteForExactPin, true);
  assert.equal(verdict.requestedJudgeModelId, PINNED);
  assert.equal(verdict.substituteReason, 'exact_pin_quota_exhausted');
  assert.deepEqual(calls, [
    { provider: 'claude', modelId: PINNED },
    { provider: 'codex', modelId: boundaryCodexJudgeModel() },
  ]);
});

test('a call-time quota refusal with no family left is recorded unreviewed in the provider’s own words', async () => {
  __setClaudeUsageForTests(claudeReading(100, { extraUsage: true }));
  claudeWire = 'out_of_extra_usage';
  exhaustCodex();
  const verdict = await review();
  assert.equal(verdict.failedOpen, true);
  assert.match(verdict.reason, new RegExp(`checker ${PINNED} could not review this answer`));
  assert.match(verdict.reason, /refused the review for lack of quota or credit/);
  assert.match(verdict.reason, /out of extra usage/);
  assert.match(verdict.reason, /No other model family is available/);
  assert.deepEqual(calls, [{ provider: 'claude', modelId: PINNED }], 'dialed once, refused, nothing else');
});

// The pin invariants (objective-judge-pin.integration.test.ts) exercise
// runHedgedJudge directly; these hold them on the completion route itself.
for (const failure of ['bare_429', 'transport_error', 'invalid', 'hung'] as const) {
  test(`on the completion route a chosen checker's ${failure} stays unjudged: only a quota refusal moves the review`, async () => {
    process.env.CLEMMY_EXACT_JUDGE_TIMEOUT_MS = '1000'; // a hung checker times out quickly
    claudeWire = failure;
    const verdict = await review();
    assert.equal(verdict.failedOpen, true);
    assert.equal(verdict.judgeModelId, undefined, 'no model ruled');
    assert.equal(verdict.substituteForExactPin, undefined);
    assert.deepEqual(calls.map((call) => call.provider), failure === 'invalid' ? ['claude', 'claude'] : ['claude'],
      'no stand-in is dialed; a malformed verdict gets its one repair on the same checker');
  });
}

test('on the completion route a pinned checker that cannot sign in is unavailable, and nothing stands in', async () => {
  writeAuth(true, false);
  const verdict = await review();
  assert.equal(verdict.failedOpen, true);
  assert.match(verdict.reason, new RegExp(`Configured boundary judge ${PINNED} is unavailable`));
  assert.deepEqual(calls, []);
});

test('with no family left to review, the verdict is recorded unreviewed with the quota reason', async () => {
  __setClaudeUsageForTests(claudeReading(100));
  claudeWire = 'bare_429';
  exhaustCodex();
  const verdict = await review();
  assert.equal(verdict.failedOpen, true, 'unreviewed, and marked so');
  assert.equal(verdict.done, true);
  assert.match(verdict.reason, new RegExp(`checker ${PINNED}`));
  assert.match(verdict.reason, /five-hour limit is used up/);
  assert.match(verdict.reason, /No other model family is available/);
  assert.match(verdict.reason, /no review was completed/);
  assert.equal(verdict.judgeModelId, undefined, 'no model judged, so none is named');
  assert.deepEqual(calls, [], 'neither exhausted account is dialed');
});

test('with the checker fallback switched off, the review says so instead of dialing the exhausted account', async () => {
  process.env.CLEMMY_JUDGE_CHAIN = 'off';
  __setClaudeUsageForTests(claudeReading(100));
  claudeWire = 'bare_429';
  const verdict = await review();
  assert.equal(verdict.failedOpen, true);
  assert.match(verdict.reason, /five-hour limit is used up/);
  assert.match(verdict.reason, /CLEMMY_JUDGE_CHAIN=off/);
  assert.match(verdict.reason, /no review was completed/);
  assert.deepEqual(calls, [], 'no stand-in, and no doomed call');
});

test('when the quota returns, the owner’s checker is used again with no stand-in marking', async () => {
  __setClaudeUsageForTests(claudeReading(100));
  claudeWire = 'bare_429';
  const during = await review();
  assert.equal(during.judgeModelId, boundaryCodexJudgeModel());
  calls.length = 0;
  __setClaudeUsageForTests(claudeReading(3)); // the window reset
  claudeWire = 'answers';
  const afterReset = await review();
  assert.equal(afterReset.judgeModelId, PINNED);
  assert.equal(afterReset.ownerSelectedJudge, true);
  assert.equal(afterReset.substituteForExactPin, undefined);
  assert.deepEqual(calls, [{ provider: 'claude', modelId: PINNED }]);
});

test('an old, a spent-window or an extra-usage reading is not evidence of exhaustion', async () => {
  const readings: Array<[string, ClaudeUsageSnapshot]> = [
    ['captured long ago', claudeReading(100, { capturedAgoMs: 16 * 60_000 })],
    ['reset already passed', claudeReading(100, { resetInMs: -60_000 })],
    ['extra usage on', claudeReading(100, { extraUsage: true })],
  ];
  for (const [label, reading] of readings) {
    calls.length = 0;
    __setClaudeUsageForTests(reading);
    const verdict = await review();
    assert.equal(verdict.judgeModelId, PINNED, label);
    assert.deepEqual(calls, [{ provider: 'claude', modelId: PINNED }], label);
  }
});

test('an unpinned checker’s hedge is never started on an account that is out of quota', async () => {
  const { resolveCompletionCheckerRoute } = await import('./debate-model.js');
  pinJudge(null);
  const selection: import('./debate-model.js').CapturedBoundaryJudgeSelection = {
    status: 'captured', role: { modelId: 'gpt-5.6-terra', provider: 'codex', source: 'default' },
    crossFamily: true, defaultModels: { claude: boundaryClaudeJudgeModel(), codex: boundaryCodexJudgeModel() },
  };
  assert.equal(resolveCompletionCheckerRoute(selection).hedge?.judgeFamily, 'claude',
    'with quota to spare, the other family hedges the chosen checker');
  __setClaudeUsageForTests(claudeReading(100));
  const route = resolveCompletionCheckerRoute(selection);
  assert.equal(route.primary.judgeFamily, 'codex', 'the chosen checker is untouched');
  assert.equal(route.primary.substituteForExactPin, undefined);
  assert.equal(route.hedge, null, 'a hedge onto the used-up account could not answer');
  assert.deepEqual(calls, [], 'resolving a route dials nothing');
});

test('a test run never dials the live Claude usage endpoint, even when the reading is due a refresh', async () => {
  const { __resetClaudeUsageForTests } = await import('./claude-usage.js');
  const { checkerQuotaExhaustion } = await import('./judge-family.js');
  const requested: string[] = [];
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requested.push(input instanceof Request ? input.url : String(input));
    return new Response('{}', { status: 500 });
  });
  __resetClaudeUsageForTests(); // no reading, and a refresh is due
  assert.equal(checkerQuotaExhaustion('claude'), null, 'no reading proves nothing');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(requested, [], 'the owner’s live account is never called from a test');
});

test('the checker’s quota awareness leaves every brain-routing input unchanged', () => {
  __setClaudeUsageForTests(claudeReading(100));
  // router-model.ts and the session brain pin read these; that scope is the
  // owner's decision, not this fix's.
  assert.equal(claudeAvailable(), true);
  assert.deepEqual(debateBrainsAvailable(), { claude: true, codex: true });
  pinJudge(null);
  assert.equal(resolveRoleModel('judge').modelId, boundaryClaudeJudgeModel(),
    'the default judge role is unchanged; only the review’s route falls through');
});

/** A workflow run the owner asked for, finished and reported back, with the
 *  owner's Claude checker captured at acceptance. `commit` runs the REAL
 *  report-back review and commits the answer the owner receives. */
async function reportedBackWorkflow(name: string) {
  const host = await import('./host-turn-runner.js');
  const { writeWorkflow } = await import('../../memory/workflow-store.js');
  const { exactOriginDeliveryTargetDigest } = await import('../exact-origin-delivery.js');
  const { admitNamedWorkflowRunFromAcceptedSource } = await import('../../tools/admit-named-workflow-run.js');
  const { finalizePreparedWorkflowDispatchForSource } = await import('./loop.js');
  const queue = await import('../../tools/workflow-run-queue.js');
  const records = await import('../../execution/workflow-run-record.js');
  const report = await import('../../execution/workflow-run-report-back.js');
  const terminal = await import('../../execution/workflow-origin-terminal.js');
  const reviewer = await import('../../execution/workflow-origin-completion-review.js');
  const brackets = await import('./brackets.js');
  const usage = await import('../usage-log.js');
  const { WORKFLOW_RUNS_DIR } = await import('../../tools/shared.js');
  reviewer._setWorkflowOriginCompletionJudgeForTests(null);
  writeWorkflow(name, { name, description: 'Summarize supplied text.', enabled: true,
    trigger: { manual: true }, steps: [{ id: 'summary', prompt: 'Summarize {{input.text}}.', sideEffect: 'read' }] });
  const replyTarget = { type: 'origin_chat' } as const;
  const session = createSession({ kind: 'chat', channel: 'desktop' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: `Run ${name}; give the summary here.`, originReplyTarget: replyTarget,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(replyTarget) } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  host.captureEffectiveCompletionPolicyOnce({ ...identity, enabled: true }); // the owner's Claude checker
  const admitted = admitNamedWorkflowRunFromAcceptedSource({ ...identity, workflowName: name,
    inputs: { text: 'Southgate is ready.' } });
  assert.ok(admitted.ok && admitted.runId);
  const runId = admitted.runId!;
  assert.ok(finalizePreparedWorkflowDispatchForSource(session.id, source.seq));
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  records.withWorkflowRunRecordLock(file, () => {
    const row = records.readWorkflowRunRecordUnlocked<Record<string, unknown>>(file)!;
    records.writeWorkflowRunRecordDurablyUnlocked(file, { ...row, status: 'completed',
      finishedAt: new Date().toISOString(), stepsTotal: 1, stepsCompleted: 1,
      stepOutputs: { summary: { summary: 'Southgate is ready.' } }, output: 'Southgate is ready.' });
  });
  assert.equal(report.checkpointWorkflowRunReportBack(file, { workflowName: name,
    outcome: 'done', detail: 'Southgate is ready.' }), true);
  const observer = queue.readWorkflowRunOriginRecords(runId).find((row) => row.version === 2);
  assert.ok(observer && observer.version === 2);
  const inWorkflow = { sessionId: `workflow:${name}:step`, sourceUserSeq: 999_999 };
  return {
    sessionId: session.id,
    commit: () => usage.withModelUsageAttribution(inWorkflow, () => brackets.withHarnessRunContext({
      ...inWorkflow, counter: new brackets.ToolCallsCounter(8), workerScope: true,
    }, () => terminal.reviewAndCommitWorkflowOriginTerminal({ observer, runId,
      outcome: 'done', detail: 'Southgate is ready.' }))),
  };
}

test('the durable verdict of a real review names the stand-in and the checker it stood in for', async () => {
  const run = await reportedBackWorkflow('checker-quota-durable-stand-in');
  __setClaudeUsageForTests(claudeReading(100)); // the plan window runs out before the review
  claudeWire = 'bare_429';
  const committed = await run.commit();
  assert.ok(committed);
  assert.deepEqual(calls.map((call) => call.provider), ['codex'], 'only the stand-in was dialed');
  const judged = listEvents(run.sessionId, { types: ['goal_alignment_judged'] });
  assert.equal(judged.length, 1);
  const recorded = judged[0]!.data as Record<string, unknown>;
  assert.equal(recorded.judgeModelId, boundaryCodexJudgeModel());
  assert.equal(recorded.judgeProvider, 'codex');
  assert.equal(recorded.substituteForExactPin, true);
  assert.equal(recorded.requestedJudgeModelId, PINNED);
  assert.equal(recorded.substituteReason, 'exact_pin_quota_exhausted');
  assert.equal(recorded.failedOpen, undefined);
  const ref = committed.event.data.completionVerdictRef as Record<string, unknown>;
  assert.equal(ref.judgeModelId, boundaryCodexJudgeModel());
  assert.equal(ref.requestedJudgeModelId, PINNED);
  assert.equal(ref.substituteForExactPin, true);
});

test('with no family left, the durable verdict and the delivered answer say unreviewed, with the reason', async () => {
  const run = await reportedBackWorkflow('checker-quota-durable-unreviewed');
  __setClaudeUsageForTests(claudeReading(100));
  claudeWire = 'bare_429';
  exhaustCodex();
  const committed = await run.commit();
  assert.ok(committed);
  assert.deepEqual(calls, [], 'neither used-up account is dialed');
  const judged = listEvents(run.sessionId, { types: ['goal_alignment_judged'] });
  assert.equal(judged.length, 1);
  const recorded = judged[0]!.data as Record<string, unknown>;
  assert.equal(recorded.failedOpen, true);
  assert.match(String(recorded.reason), /five-hour limit is used up/);
  assert.match(String(recorded.reason), /No other model family is available/);
  assert.equal(recorded.judgeModelId, undefined);
  const ref = committed.event.data.completionVerdictRef as Record<string, unknown>;
  assert.equal(ref.failedOpen, true);
  assert.match(committed.presentation.text, /stands unreviewed/, 'the owner is told; nothing passes silently');
});
