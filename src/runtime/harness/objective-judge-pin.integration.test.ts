import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelResponse } from '@openai/agents-core';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-objective-judge-pin-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { Usage } = await import('@openai/agents');
const { ClaudeModelProvider } = await import('./claude-model.js');
const originalClaudeGetModel = ClaudeModelProvider.prototype.getModel;
const { CodexModelProvider } = await import('./codex-model.js');
const { captureBoundaryJudgeSelection, resolveBoundaryJudge, resolveBoundaryJudgeHedge } = await import('./debate-model.js');
const { runHedgedJudge, parseCompletionVerdict } = await import('./objective-judge.js');
const { getJudgeMetricsSnapshot, resetJudgeMetricsForTests } = await import('./judge-family.js');
const { _setDiscoveredModelsForTest } = await import('./model-discovery.js');
const { closeEventLog, createSession, appendEvent } = await import('./eventlog.js');

type Behavior = 'slow' | 'error' | 'invalid' | 'hung' | 'rate_limited';
let claudeBehavior: Behavior = 'slow';
const calls: Array<{ provider: string; modelId?: string }> = [];

function providerModel(provider: 'claude' | 'codex', modelId?: string): Model {
  return {
    async getResponse(): Promise<ModelResponse> {
      calls.push({ provider, modelId });
      if (provider === 'claude') {
        if (claudeBehavior === 'hung') return new Promise(() => {});
        if (claudeBehavior === 'error') throw new Error('fixture pinned judge transport unavailable');
        if (claudeBehavior === 'rate_limited') throw Object.assign(new Error('provider request rejected'), { status: 429 });
        if (claudeBehavior === 'slow') await new Promise(resolve => setTimeout(resolve, 650));
      }
      const text = provider === 'codex' ? 'DONE: fast self-family verdict'
        : claudeBehavior === 'invalid' ? 'not a verdict'
          : 'INCOMPLETE: the eight worker receipts are absent';
      return {
        output: [{ type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text, providerData: {} }] }],
        usage: new Usage(), responseId: `fixture-${provider}`,
      } as ModelResponse;
    },
    async *getStreamedResponse() { throw new Error('judge must use its ordinary one-turn request'); },
  };
}

function writeAuth(claudeAvailable = true): void {
  writeFileSync(path.join(TEST_HOME, 'state', 'auth.json'), JSON.stringify({
    codexOauth: { accessToken: 'fixture-codex-access', refreshToken: 'fixture-codex-refresh' },
  }));
  // An explicit non-OAuth token prevents fallback to the operator's keychain.
  writeFileSync(path.join(TEST_HOME, 'state', 'claude-auth.json'), JSON.stringify({
    accessToken: claudeAvailable ? 'sk-ant-oat01-fixture' : 'sk-ant-api03-no-subscription',
    expiresAt: Date.now() + 3_600_000,
  }));
}

beforeEach(() => {
  mock.restoreAll();
  calls.length = 0;
  claudeBehavior = 'slow';
  Object.assign(process.env, {
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra',
    CLEMMY_JUDGE_CROSS_FAMILY: 'on', CLEMMY_JUDGE_HEDGE: 'on', CLEMMY_JUDGE_HEDGE_DELAY_MS: '500',
    CLEMMY_COMPLETION_REVIEW: 'on', CLEMMY_CLAUDE_OVERLOAD_FALLBACK: 'off', CLEMMY_CLAUDE_TRANSPORT: 'raw_messages',
    CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'judge', modelId: 'claude-sonnet-5', scope: 'durable', source: 'settings' }]),
    CLEMMY_DEBATE_JUDGE: '', BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '', BYO_MODEL_ID: '', BYO_PROVIDERS: '',
    BYO_PROVIDER_ALPHA_API_KEY: '', BYO_PROVIDER_BETA_API_KEY: '',
    CLEMMY_BOUNDARY_JUDGE_CLAUDE_MODEL: '', CLEMMY_BOUNDARY_JUDGE_CODEX_MODEL: '',
  });
  writeAuth();
  _setDiscoveredModelsForTest({ anthropic: [], openai: [] });
  resetJudgeMetricsForTests();
  // Stub only the provider wires. Real role resolution, concrete adapter
  // binding, route metrics, Agents Runner, hedge engine and parser still run.
  mock.method(ClaudeModelProvider.prototype, 'getModel', (id?: string) => providerModel('claude', id));
  mock.method(CodexModelProvider.prototype, 'getModel', (id?: string) => providerModel('codex', id));
});

after(() => {
  mock.restoreAll();
  closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function completion(timeoutMs = 2_000) {
  return runHedgedJudge('Audit the requested worker receipts.', 'Eight workers were requested; none ran.',
    parseCompletionVerdict, value => value.done, 'completion', { timeoutMs });
}

test('a faster brain-family hedge cannot replace the pinned completion judge', async () => {
  const result = await completion();
  assert.equal(result.value?.done, false);
  assert.equal(result.failure, null);
  assert.equal(result.routing?.modelId, 'claude-sonnet-5');
  assert.equal(result.routing?.transport, 'claude_subscription');
  assert.equal(result.routing?.selfJudge, false);
  assert.deepEqual(calls, [{ provider: 'claude', modelId: 'claude-sonnet-5' }]);
  const metric = getJudgeMetricsSnapshot().lanes.find(lane => lane.lane === 'completion');
  assert.equal(metric?.lastModelId, 'claude-sonnet-5');
  assert.equal(metric?.lastJudgeFamily, 'claude');
  assert.equal(metric?.lastBrainFamily, 'codex');
  assert.equal(metric?.lastSelfJudge, false);
});

for (const behavior of ['error', 'invalid', 'hung'] as const) {
  test(`an explicit completion judge ${behavior} is unjudged without a silent alternate verdict`, async () => {
    claudeBehavior = behavior;
    const result = await completion(behavior === 'hung' ? 30 : 2_000);
    assert.equal(result.value, null);
    assert.equal(result.failure, behavior === 'hung' ? 'timeout' : behavior);
    assert.equal(result.routing?.modelId, 'claude-sonnet-5');
    assert.equal(result.routing?.selfJudge, false);
    assert.deepEqual(calls, [{ provider: 'claude', modelId: 'claude-sonnet-5' }]);
    const metric = getJudgeMetricsSnapshot().lanes.find(lane => lane.lane === 'completion');
    assert.equal(metric?.lastOutcome, behavior === 'hung' ? 'timeout' : behavior);
  });
}

test('an unavailable explicit judge binding never silently resolves to the brain wire', async () => {
  writeAuth(false);
  const result = await completion();
  assert.equal(result.value, null);
  assert.equal(result.failure, 'error');
  assert.deepEqual(calls, []);
  assert.equal(getJudgeMetricsSnapshot().lanes.find(lane => lane.lane === 'completion')?.errors, 1);
});

test('an unpinned cross-family primary cannot hedge back onto the brain family', () => {
  process.env.CLEMMY_MODEL_ROLES = '[]';
  const primary = resolveBoundaryJudge();
  assert.equal(primary.selfJudge, false);
  assert.equal(resolveBoundaryJudgeHedge(primary), null);
});


async function capturedCompletion(selection: import('./debate-model.js').CapturedBoundaryJudgeSelection) {
  return runHedgedJudge('Audit the requested worker receipts.', 'Eight workers were requested; none ran.',
    parseCompletionVerdict, value => value.done, 'completion', { timeoutMs: 2_000, boundaryJudgeSelection: selection });
}

function pin(modelId: string) {
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'judge', modelId, scope: 'durable', source: 'settings' }]);
}

test('accepted capture survives settings changes and SQLite reopen to govern the actual judge wire', async () => {
  const host = await import('./host-turn-runner.js');
  const session = createSession({ kind: 'chat', channel: 'desktop', title: 'captured route' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Audit eight receipts.' } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  host.captureEffectiveCompletionPolicyOnce({ ...identity, enabled: true });
  pin('gpt-5.6-terra');
  process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
  process.env.CLEMMY_COMPLETION_REVIEW = 'off';
  closeEventLog();
  const read = host.readCapturedCompletionPolicy(identity);
  assert.equal(read.status, 'captured');
  if (read.status !== 'captured') throw new Error('missing capture');
  assert.equal(read.policy.enabled, true);
  const result = await capturedCompletion(read.policy.judgeSelection);
  assert.equal(result.value?.done, false);
  assert.equal(result.routing?.ownerSelectedJudge, true);
  assert.equal(result.routing?.transport, 'claude_subscription');
  assert.deepEqual(calls, [{ provider: 'claude', modelId: 'claude-sonnet-5' }]);
});

for (const capturedCrossFamily of ['on', 'off']) {
  test(`same-provider pin remains the exact selected model with captured cross-family ${capturedCrossFamily}`, async () => {
    pin('gpt-5.6-terra');
    process.env.CLEMMY_JUDGE_CROSS_FAMILY = capturedCrossFamily;
    const selected = captureBoundaryJudgeSelection();
    pin('claude-sonnet-5');
    process.env.CLEMMY_JUDGE_CROSS_FAMILY = capturedCrossFamily === 'on' ? 'off' : 'on';
    const result = await capturedCompletion(selected);
    assert.equal(result.value?.done, true);
    assert.equal(result.routing?.selfJudge, true);
    assert.equal(result.routing?.ownerSelectedJudge, true);
    assert.equal(result.routing?.transport, 'codex_responses');
    assert.deepEqual(calls, [{ provider: 'codex', modelId: 'gpt-5.6-terra' }]);
  });

  test(`captured pin losing auth is unavailable without substitution when cross-family ${capturedCrossFamily}`, async () => {
    process.env.CLEMMY_JUDGE_CROSS_FAMILY = capturedCrossFamily;
    const selected = captureBoundaryJudgeSelection();
    writeAuth(false);
    pin('gpt-5.6-terra');
    const result = await capturedCompletion(selected);
    assert.equal(result.value, null);
    assert.equal(result.failure, 'error');
    assert.match(result.unavailableReason ?? '', /unavailable/i);
    assert.deepEqual(calls, []);
  });

  test(`inactive explicit pin cannot become a default when captured cross-family ${capturedCrossFamily}`, async () => {
    process.env.CLEMMY_JUDGE_CROSS_FAMILY = capturedCrossFamily;
    writeAuth(false);
    const selected = captureBoundaryJudgeSelection();
    assert.equal(selected.status, 'captured');
    if (selected.status !== 'captured') throw new Error('selection unavailable');
    assert.equal(selected.role.inactiveBinding?.modelId, 'claude-sonnet-5');
    writeAuth();
    pin('gpt-5.6-terra');
    const result = await capturedCompletion(selected);
    assert.equal(result.value, null);
    assert.deepEqual(calls, [], 'an inactive accepted selection must not be silently reinterpreted');
  });
}

test('captured unpinned cross-family preference is independent of the later switch', async () => {
  process.env.CLEMMY_MODEL_ROLES = '[]';
  process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
  const selected = captureBoundaryJudgeSelection();
  process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'on';
  pin('claude-sonnet-5');
  const result = await capturedCompletion(selected);
  assert.equal(result.value?.done, true);
  assert.equal(result.routing?.judgeFamily, 'codex');
  assert.equal(result.routing?.ownerSelectedJudge, undefined);
  assert.equal(resolveBoundaryJudgeHedge(result.routing!, selected), null);
  assert.deepEqual(calls.map(call => call.provider), ['codex']);
});

test('missing legacy provider identity yields the existing fail-open verdict without any provider request', async () => {
  const { judgeObjectiveComplete } = await import('./objective-judge.js');
  const result = await judgeObjectiveComplete('Audit the eight receipts.', 'All eight exist.', {
    skills: [], toolCallSummary: 'No receipts were supplied.',
    boundaryJudgeSelection: { status: 'unavailable', reason: 'Legacy capture has no provider identity.' },
  });
  assert.equal(result.done, true);
  assert.equal(result.failedOpen, true);
  assert.match(result.reason, /no provider identity/);
  assert.equal(result.judgeModelId, undefined);
  assert.deepEqual(calls, []);
});

function byoProvider(id: string, baseURL: string, modelIds = ['review-fixture']) {
  return { id, label: id, baseURL, modelIds };
}
function prepareByoSelection() {
  process.env.BYO_PROVIDERS = JSON.stringify([byoProvider('alpha', 'https://alpha.invalid/v1')]);
  process.env.BYO_PROVIDER_ALPHA_API_KEY = 'fixture-alpha-original';
  pin('review-fixture');
  const selected = captureBoundaryJudgeSelection();
  assert.equal(selected.status, 'captured');
  if (selected.status !== 'captured') throw new Error('BYO selection missing');
  assert.equal(selected.role.provider, 'byo');
  assert.deepEqual(selected.byoProvider, { id: 'alpha', baseURL: 'https://alpha.invalid/v1', ownership: 'declared' });
  assert.doesNotMatch(JSON.stringify(selected), /fixture-alpha-original|apiKey|accessToken/);
  return selected;
}

test('BYO capture binds its original provider endpoint while reloading only that provider’s live credential', async () => {
  const selected = prepareByoSelection();
  process.env.BYO_PROVIDERS = JSON.stringify([
    byoProvider('alpha', 'https://alpha.invalid/v1'),
    byoProvider('beta', 'https://beta.invalid/v1'),
  ]);
  process.env.BYO_PROVIDER_ALPHA_API_KEY = 'fixture-alpha-rotated';
  process.env.BYO_PROVIDER_BETA_API_KEY = 'fixture-beta-secret';
  pin('claude-sonnet-5');
  const requests: Array<{ url: string; authorization: string | null; model: unknown }> = [];
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = await req.json() as { model?: unknown };
    requests.push({ url: req.url, authorization: req.headers.get('authorization'), model: body.model });
    return new Response(JSON.stringify({ id: 'captured-byo', object: 'chat.completion', created: 1,
      model: 'review-fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'DONE: all receipts checked' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await capturedCompletion(selected);
  assert.equal(result.value?.done, true);
  assert.equal(result.routing?.judgeFamily, 'byo');
  assert.equal(result.routing?.judgeProviderId, 'alpha');
  assert.equal(result.routing?.ownerSelectedJudge, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://alpha.invalid/v1/chat/completions');
  assert.equal(requests[0]?.authorization, 'Bearer fixture-alpha-rotated');
  assert.equal(requests[0]?.model, 'review-fixture');
  assert.deepEqual(calls, []);
});

for (const change of ['removed', 'endpoint changed', 'model removed'] as const) {
  test(`a captured BYO provider ${change} cannot fall back to the newly sole backend`, async () => {
    const selected = prepareByoSelection();
    process.env.BYO_PROVIDER_BETA_API_KEY = 'fixture-beta-secret';
    process.env.BYO_PROVIDERS = JSON.stringify(change === 'removed'
      ? [byoProvider('beta', 'https://beta.invalid/v1')]
      : [byoProvider('alpha', change === 'endpoint changed' ? 'https://replacement.invalid/v1' : 'https://alpha.invalid/v1',
        change === 'model removed' ? ['another-model'] : ['review-fixture'])]);
    let networkCalls = 0;
    mock.method(globalThis, 'fetch', async () => { networkCalls++; throw new Error('unexpected provider call'); });
    const result = await capturedCompletion(selected);
    assert.equal(result.value, null);
    assert.equal(result.failure, 'error');
    assert.equal(networkCalls, 0);
    assert.deepEqual(calls, []);
  });
}


test('a captured Claude judge bypasses the optional adapter overload chain while legacy callers keep it', () => {
  process.env.CLEMMY_CLAUDE_OVERLOAD_FALLBACK = 'on';
  // These are concrete adapter objects; construction does not call a provider.
  const legacy = originalClaudeGetModel.call(new ClaudeModelProvider(), 'claude-sonnet-5');
  const exact = originalClaudeGetModel.call(new ClaudeModelProvider(), 'claude-sonnet-5', { allowOverloadFallback: false });
  assert.equal(legacy.constructor.name, 'FallbackModel');
  assert.notEqual(exact.constructor.name, 'FallbackModel');
  const optionsSeen: Array<{ allowOverloadFallback?: boolean } | undefined> = [];
  mock.method(ClaudeModelProvider.prototype, 'getModel', (id?: string, options?: { allowOverloadFallback?: boolean }) => {
    optionsSeen.push(options);
    return providerModel('claude', id);
  });
  resolveBoundaryJudge(captureBoundaryJudgeSelection());
  assert.equal(optionsSeen[0]?.allowOverloadFallback, false, 'the accepted route disables hidden adapter substitution');
});

test('BYO cache cannot reuse a previous credential whose last eight characters match the rotation', async () => {
  const selected = prepareByoSelection();
  const credentials = ['fixture-before-COLLIDE8', 'fixture-after-COLLIDE8'];
  assert.equal(credentials[0]!.slice(-8), credentials[1]!.slice(-8), 'the old cache key collides');
  const authorization: Array<string | null> = [];
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    assert.equal(req.url, 'https://alpha.invalid/v1/chat/completions');
    authorization.push(req.headers.get('authorization'));
    return new Response(JSON.stringify({ id: `rotation-${authorization.length}`, object: 'chat.completion', created: 1,
      model: 'review-fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'DONE: all receipts checked' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  for (const credential of credentials) {
    process.env.BYO_PROVIDER_ALPHA_API_KEY = credential;
    const result = await capturedCompletion(selected);
    assert.equal(result.value?.done, true);
    assert.equal(result.routing?.judgeProviderId, 'alpha', 'provider identity is unchanged; this control isolates credential reuse');
  }
  assert.deepEqual(authorization, credentials.map(key => `Bearer ${key}`));
});

test('the generic BYO client cache separates exact endpoints and static versus refreshable auth', async () => {
  const { getByoModel, resetByoModelCache } = await import('./byo-model.js');
  resetByoModelCache();
  const backend = { configured: true, baseURL: 'https://cache-a.invalid/v1', apiKey: 'fixture-cache-credential',
    primaryId: 'review-fixture', judgeId: 'review-fixture', providerLabel: 'cache fixture' };
  const first = getByoModel('review-fixture', backend);
  assert.equal(getByoModel('review-fixture', { ...backend }), first, 'identical identity may reuse the model');
  assert.notEqual(getByoModel('review-fixture', { ...backend, baseURL: 'https://cache-b.invalid/v1' }), first);
  assert.notEqual(getByoModel('review-fixture', { ...backend, refreshBearer: async () => 'fixture-refreshed' }), first);
  resetByoModelCache();
});


test('a captured unpinned hedge keeps its exact Claude adapter while legacy hedges retain overload behavior', () => {
  process.env.CLEMMY_CLAUDE_OVERLOAD_FALLBACK = 'on';
  process.env.CLEMMY_MODEL_ROLES = '[]';
  const selected: import('./debate-model.js').CapturedBoundaryJudgeSelection = {
    status: 'captured', role: { modelId: 'gpt-5.6-terra', provider: 'codex', source: 'default' },
    crossFamily: true,
    defaultModels: { claude: 'claude-sonnet-5', codex: 'gpt-5.6-terra' },
  };
  // A BYO brain with an unpinned Codex primary can have a distinct Claude hedge.
  // Exercise the real adapter factory, not a replacement model that hides its
  // fallback chain. Construction performs no provider request.
  const primary: import('./debate-model.js').BoundaryJudgeRouting = {
    model: providerModel('codex', 'gpt-5.6-terra'), modelId: 'gpt-5.6-terra',
    judgeFamily: 'codex', brainFamily: 'byo', transport: 'codex_responses', selfJudge: false,
  };
  const built: Array<{ id?: string; options?: { allowOverloadFallback?: boolean }; model: Model }> = [];
  mock.method(ClaudeModelProvider.prototype, 'getModel', function (this: InstanceType<typeof ClaudeModelProvider>,
    id?: string, options?: { allowOverloadFallback?: boolean }) {
    const model = originalClaudeGetModel.call(this, id, options);
    built.push({ id, options, model });
    return model;
  });
  const capturedHedge = resolveBoundaryJudgeHedge(primary, selected);
  assert.equal(capturedHedge?.modelId, 'claude-sonnet-5');
  assert.equal(capturedHedge?.judgeFamily, 'claude');
  assert.equal(built.length, 1);
  assert.equal(built[0]?.id, 'claude-sonnet-5');
  assert.equal(built[0]?.options?.allowOverloadFallback, false);
  assert.notEqual(built[0]?.model.constructor.name, 'FallbackModel');

  const legacyHedge = resolveBoundaryJudgeHedge(primary);
  assert.equal(legacyHedge?.judgeFamily, 'claude');
  assert.equal(built.length, 2);
  assert.equal(built[1]?.options?.allowOverloadFallback, undefined);
  assert.equal(built[1]?.model.constructor.name, 'FallbackModel');
  assert.deepEqual(calls, [], 'factory inspection must not issue a model request');
});


test('a pinned provider quota failure remains unjudged and preserves an actionable reason', async () => {
  claudeBehavior = 'rate_limited';
  const result = await completion();
  assert.equal(result.value, null);
  assert.equal(result.failure, 'error');
  assert.match(result.unavailableReason ?? '', /completion reviewer.*rate-limited/);
  assert.match(result.unavailableReason ?? '', /no review was completed/);
  assert.deepEqual(calls, [{ provider: 'claude', modelId: 'claude-sonnet-5' }], 'an exact pin cannot silently substitute a reviewer');
});

test('a reviewer transport failure retains its concrete cause without leaking credentials', async () => {
  mock.method(ClaudeModelProvider.prototype, 'getModel', () => ({
    async getResponse() { throw new Error('Invalid response stream; api_key=reviewer-fixture-secret'); },
    async *getStreamedResponse() { throw new Error('unexpected stream'); },
  }));
  const result = await completion();
  assert.equal(result.value, null);
  assert.equal(result.failure, 'error');
  assert.match(result.unavailableReason ?? '', /Invalid response stream/);
  assert.ok(!result.unavailableReason?.includes('reviewer-fixture-secret'));
});

test('workflow report-back actual judge wire owns the parent source and captured provider inside a child context', async () => {
  const host = await import('./host-turn-runner.js');
  const brackets = await import('./brackets.js');
  const usage = await import('../usage-log.js');
  const metrics = await import('../model-route-metrics.js');
  const { writeWorkflow } = await import('../../memory/workflow-store.js');
  const { exactOriginDeliveryTargetDigest } = await import('../exact-origin-delivery.js');
  const { admitNamedWorkflowRunFromAcceptedSource } = await import('../../tools/admit-named-workflow-run.js');
  const { finalizePreparedWorkflowDispatchForSource } = await import('./loop.js');
  const queue = await import('../../tools/workflow-run-queue.js');
  const records = await import('../../execution/workflow-run-record.js');
  const report = await import('../../execution/workflow-run-report-back.js');
  const terminal = await import('../../execution/workflow-origin-terminal.js');
  const review = await import('../../execution/workflow-origin-completion-review.js');
  const { WORKFLOW_RUNS_DIR } = await import('../../tools/shared.js');
  review._setWorkflowOriginCompletionJudgeForTests(null);
  const name = 'parent-captured-judge-attribution';
  writeWorkflow(name, { name, description: 'Summarize supplied text.', enabled: true,
    trigger: { manual: true }, steps: [{ id: 'summary', prompt: 'Summarize {{input.text}}.', sideEffect: 'read' }] });
  const replyTarget = { type: 'origin_chat' } as const;
  const session = createSession({ kind: 'chat', channel: 'desktop' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: `Run ${name}; give the summary here.`, originReplyTarget: replyTarget,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(replyTarget) } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  host.captureEffectiveCompletionPolicyOnce({ ...identity, enabled: true }); // selected Claude settings pin
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
      stepOutputs: { summary: { summary: 'Southgate is ready.', nonce: 'actual-wire-child-evidence' } },
      output: 'Southgate is ready.' });
  });
  assert.equal(report.checkpointWorkflowRunReportBack(file, { workflowName: name,
    outcome: 'done', detail: 'Southgate is ready.' }), true);
  const observer = queue.readWorkflowRunOriginRecords(runId).find(row => row.version === 2);
  assert.ok(observer && observer.version === 2);
  pin('gpt-5.6-terra'); // cannot replace the parent's captured provider/model
  const wired: Array<Record<string, unknown>> = [];
  mock.method(ClaudeModelProvider.prototype, 'getModel', (modelId?: string) => ({
    async getResponse(request: unknown) {
      wired.push({ modelId, source: brackets.harnessRunContextStorage.getStore()?.sourceUserSeq,
        sessionId: brackets.harnessRunContextStorage.getStore()?.sessionId,
        usage: usage.modelUsageAttributionStorage.getStore(), request });
      assert.match(JSON.stringify(request), /actual-wire-child-evidence/);
      return { output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'DONE: actual child returned Southgate ready.', providerData: {} }] }],
        usage: new Usage(), responseId: 'parent-review-real-runner' } as ModelResponse;
    },
    async *getStreamedResponse() { throw new Error('unexpected stream'); },
  } as Model));
  const unrelated = { sessionId: 'workflow:unrelated-child:step', sourceUserSeq: 999999 };
  const committed = await usage.withModelUsageAttribution(unrelated, () => brackets.withHarnessRunContext({
    ...unrelated, counter: new brackets.ToolCallsCounter(8), workerScope: true,
  }, () => terminal.reviewAndCommitWorkflowOriginTerminal({ observer, runId,
    outcome: 'done', detail: 'Southgate is ready.' })));
  assert.ok(committed);
  assert.equal(wired.length, 1);
  assert.equal(wired[0].modelId, 'claude-sonnet-5');
  assert.equal(wired[0].sessionId, session.id);
  assert.equal(wired[0].source, source.seq);
  assert.deepEqual(wired[0].usage, identity);
  const rows = metrics.openModelRouteMetricsDb().prepare(`SELECT session_id, role, requested_model,
    resolved_model FROM model_route_decisions WHERE session_id = ? AND role = 'judge'`).all(session.id) as Array<Record<string, unknown>>;
  assert.ok(rows.some(row => row.requested_model === 'claude-sonnet-5' && row.resolved_model === 'claude-sonnet-5'), JSON.stringify(rows));
  assert.equal(committed.presentation.status, 'done');
  const ref = committed.event.data.completionVerdictRef as Record<string, unknown>;
  assert.equal(ref.verified, true);
  assert.equal(ref.replyMatches, true);
  assert.equal(ref.judgeModelId, 'claude-sonnet-5');
});
