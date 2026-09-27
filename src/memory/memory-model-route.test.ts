/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/memory-model-route.test.ts
 *
 * The memory model route: automatic keeps each job on exactly the model it
 * ran on before the role existed; a chosen model is used exactly; a chosen
 * model that cannot be served makes learning wait (null), never a stand-in;
 * every memory call records as route role `memory` with its job.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelResponse } from '@openai/agents-core';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-model-route-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { Usage } = await import('@openai/agents');
const { ClaudeModelProvider } = await import('../runtime/harness/claude-model.js');
const { CodexModelProvider } = await import('../runtime/harness/codex-model.js');
const { resolveBoundaryJudge } = await import('../runtime/harness/debate-model.js');
const { defaultForRole, pinnedBrainForSession, resolveRoleModel, __sessionBrainPinTest__ } = await import('../runtime/harness/model-roles.js');
const { __resetRateLimitStoreForTests, getRateLimitSnapshot, recordCodexUsageExhausted } = await import('../runtime/harness/rate-limit-store.js');
const { _setDiscoveredModelsForTest } = await import('../runtime/harness/model-discovery.js');
const { MODELS, DEFAULT_CODEX_FAST_MODEL } = await import('../config.js');
const {
  describeMemoryModel,
  memoryJobModelId,
  memoryModelAvailability,
  memoryRoleSettingsView,
  resolveMemoryModelRoute,
} = await import('./memory-model-route.js');
const { _testOnly_runExtractor, reflectionExtractorPause, setReflectionExtractorPauseForTest } = await import('./reflection.js');
const {
  openModelRouteMetricsDb,
  readRouteStandIn,
  withModelRouteObserver,
} = await import('../runtime/model-route-metrics.js');
type ObservedModelRoute = import('../runtime/model-route-metrics.js').ObservedModelRoute;
const {
  recordModelUsage,
  withModelUsageAttribution,
  withModelUsageObserver,
} = await import('../runtime/usage-log.js');
type ObservedModelUsage = import('../runtime/usage-log.js').ObservedModelUsage;
const eventlog = await import('../runtime/harness/eventlog.js');

/** A provider model that records one usage row the way an adapter does. */
function providerModel(provider: 'claude' | 'codex', modelId?: string): Model {
  return {
    async getResponse(): Promise<ModelResponse> {
      recordModelUsage({ sessionId: 'adapter-session', model: modelId ?? `${provider}-default`, inputTokens: 12, outputTokens: 3 });
      return { output: [], usage: new Usage(), responseId: `fixture-${provider}-${modelId ?? ''}` } as ModelResponse;
    },
    async *getStreamedResponse() { throw new Error('unused'); },
  };
}

function writeAuth(opts: { claude?: boolean; codex?: boolean } = {}): void {
  writeFileSync(path.join(TEST_HOME, 'state', 'auth.json'), JSON.stringify(opts.codex === false ? {} : {
    codexOauth: { accessToken: 'fixture-codex-access', refreshToken: 'fixture-codex-refresh' },
  }));
  writeFileSync(path.join(TEST_HOME, 'state', 'claude-auth.json'), JSON.stringify(opts.claude === false
    ? { accessToken: 'sk-ant-api03-not-a-subscription-token' }
    : { accessToken: 'sk-ant-oat01-fixture', expiresAt: Date.now() + 3_600_000 }));
}

beforeEach(() => {
  mock.restoreAll();
  Object.assign(process.env, {
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra',
    CLEMMY_JUDGE_CROSS_FAMILY: 'on',
    CLEMMY_MODEL_ROLES: '[]',
    CLEMMY_DEBATE_JUDGE: '', BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '', BYO_MODEL_ID: '', BYO_MODEL_JUDGE_ID: '',
    BYO_PROVIDERS: '',
  });
  delete process.env.CLEMMY_BOUNDARY_JUDGE_CLAUDE_MODEL;
  delete process.env.CLEMMY_BOUNDARY_JUDGE_CODEX_MODEL;
  writeAuth();
  _setDiscoveredModelsForTest({ anthropic: [], openai: [] });
  setReflectionExtractorPauseForTest(null);
  mock.method(ClaudeModelProvider.prototype, 'getModel', (id?: string) => providerModel('claude', id));
  mock.method(CodexModelProvider.prototype, 'getModel', (id?: string) => providerModel('codex', id));
});

after(() => {
  mock.restoreAll();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function chooseMemory(modelId: string): void {
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'memory', modelId, scope: 'durable', source: 'settings' }]);
}

function useByo(): void {
  Object.assign(process.env, {
    BYO_MODEL_BASE_URL: 'https://byo.example.test/v1',
    BYO_MODEL_API_KEY: 'byo-key',
    BYO_MODEL_ID: 'byo-memory-model',
  });
}

/** Route context the wrapper recorded, read back without calling a model. */
function routeContext(model: unknown): { role?: string; reason?: Record<string, unknown> } {
  return (model as { context?: { role?: string; reason?: Record<string, unknown> } }).context ?? {};
}

test('automatic learning takes exactly the model the boundary checker selects, recorded as memory work', () => {
  for (const crossFamily of ['on', 'off']) {
    process.env.CLEMMY_JUDGE_CROSS_FAMILY = crossFamily;
    const checker = resolveBoundaryJudge();
    for (const job of ['learn', 'reconcile', 'patterns'] as const) {
      const route = resolveMemoryModelRoute(job);
      assert.ok(route, `${job} resolves with cross-family ${crossFamily}`);
      assert.equal(route.source, 'automatic');
      assert.equal(route.modelId, checker.modelId, `${job} keeps today's model (cross-family ${crossFamily})`);
      assert.equal(route.provider, checker.judgeFamily);
      assert.equal(route.boundary?.timeoutMs, checker.timeoutMs, 'the checker deadline passes through');
      assert.equal(route.boundary?.transport, checker.transport);
      assert.equal(routeContext(route.model).role, 'memory', 'recorded under the memory route role');
      assert.deepEqual({ seam: routeContext(route.model).reason?.seam, job: routeContext(route.model).reason?.job },
        { seam: 'memory', job });
    }
  }
});

test('an explicit checker pin is followed exactly, and the memory row says it follows the checker', () => {
  const judgeId = resolveRoleModel('judge').modelId;
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'judge', modelId: judgeId, scope: 'durable', source: 'settings' }]);
  const route = resolveMemoryModelRoute('learn');
  assert.equal(route?.modelId, judgeId);
  assert.equal(route?.follows, 'checker');
  const described = describeMemoryModel();
  assert.deepEqual(
    { source: described.source, modelId: described.modelId, follows: described.follows, unavailable: described.unavailable },
    { source: 'automatic', modelId: judgeId, follows: 'checker', unavailable: null },
  );
  const view = memoryRoleSettingsView();
  assert.equal(view.source, 'default');
  assert.equal(view.modelId, judgeId);
  assert.equal(view.follows, 'checker');
});

test('a same-family automatic model is named as itself, not as the checker row', () => {
  process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
  const route = resolveMemoryModelRoute('learn');
  assert.ok(route);
  const judgeRow = resolveRoleModel('judge').modelId;
  assert.equal(describeMemoryModel().modelId, route.modelId, 'the memory row names the memory route');
  if (route.modelId !== judgeRow) assert.notEqual(describeMemoryModel().follows, 'checker');
  assert.equal(defaultForRole('memory'), route.modelId, 'the role registry default is the memory route');
});

test('skills, profile and import keep today\'s fast-tier model string when automatic', () => {
  for (const job of ['skills', 'identity'] as const) {
    const route = resolveMemoryModelRoute(job);
    assert.ok(route);
    assert.equal(route.model, MODELS.fast, `${job} keeps the bare fast-tier string`);
    assert.equal(route.modelId, MODELS.fast);
    assert.equal(route.source, 'automatic');
    assert.equal(route.follows, null);
    assert.equal(route.boundary, undefined, 'no checker deadline or hedge');
  }
  const imported = resolveMemoryModelRoute('import');
  assert.equal(imported?.model, MODELS.fast || MODELS.primary || DEFAULT_CODEX_FAST_MODEL);
});

test('a chosen memory model is used exactly by every governed job, with no deadline or hedge', () => {
  useByo();
  chooseMemory('byo-memory-model');
  for (const job of ['learn', 'reconcile', 'patterns', 'skills', 'identity', 'import'] as const) {
    const route = resolveMemoryModelRoute(job);
    assert.ok(route, `${job} resolves the chosen model`);
    assert.equal(route.source, 'chosen');
    assert.equal(route.modelId, 'byo-memory-model');
    assert.equal(route.provider, 'byo');
    assert.equal(typeof route.model, 'object', 'a concrete provider-bound model, never a bare string');
    assert.equal(route.boundary, undefined, 'no checker deadline or hedge');
    assert.equal(route.follows, null);
    assert.equal(routeContext(route.model).role, 'memory');
    assert.equal(routeContext(route.model).reason?.job, job);
  }
  const described = describeMemoryModel();
  assert.equal(described.source, 'chosen');
  assert.equal(described.modelId, 'byo-memory-model');
  assert.equal(described.inactiveBinding, null);
  assert.deepEqual(memoryModelAvailability('learn'), { ok: true });
  const view = memoryRoleSettingsView();
  assert.deepEqual({ source: view.source, modelId: view.modelId, provider: view.provider },
    { source: 'settings', modelId: 'byo-memory-model', provider: 'byo' });
});

test('each governed job\'s model is named from one description, building no model', () => {
  // The Memory tab polls every few seconds; naming six jobs must not build
  // six provider models (each build reads the account state).
  const governed = ['learn', 'reconcile', 'patterns', 'skills', 'identity', 'import'] as const;
  const builds = () => [ClaudeModelProvider.prototype.getModel, CodexModelProvider.prototype.getModel]
    .reduce((n, fn) => n + (fn as unknown as { mock: { callCount(): number } }).mock.callCount(), 0);
  const counted = builds();
  const expected = governed.map((job) => resolveMemoryModelRoute(job)?.modelId ?? null);
  assert.ok(expected[0], 'fixture: the automatic route resolves');
  assert.ok(builds() > counted, 'fixture: building a route is counted');
  const described = describeMemoryModel();
  const before = builds();
  assert.deepEqual(governed.map((job) => memoryJobModelId(job, described)), expected, 'the same ids the routes ask for');
  assert.equal(builds(), before, 'no model was built to name them');
  for (const job of ['standing', 'verify', 'index', 'tidy'] as const) assert.equal(memoryJobModelId(job, described), null, job);

  useByo();
  chooseMemory('byo-memory-model');
  const chosen = describeMemoryModel();
  assert.deepEqual(governed.map((job) => memoryJobModelId(job, chosen)), governed.map(() => 'byo-memory-model'));
});

test('a chosen model that cannot be served makes learning wait; nothing stands in', () => {
  chooseMemory('byo-memory-model'); // no BYO provider is configured now
  for (const job of ['learn', 'skills'] as const) assert.equal(resolveMemoryModelRoute(job), null, job);
  const described = describeMemoryModel();
  assert.equal(described.source, 'chosen');
  assert.equal(described.modelId, 'byo-memory-model', 'the pick is still named');
  assert.equal(described.inactiveBinding?.modelId, 'byo-memory-model');
  assert.deepEqual(described.unavailable, { problem: 'not_connected' });
  assert.deepEqual(memoryModelAvailability('learn'), { ok: false, reason: 'model_unavailable', problem: 'not_connected' });
  const view = memoryRoleSettingsView();
  assert.equal(view.modelId, '', 'no model is being used instead');
  assert.equal(view.inactiveBinding?.modelId, 'byo-memory-model');
  assert.equal(view.source, 'settings');
});

test('a chosen model whose account is signed out waits with the reason', () => {
  const codexId = resolveRoleModel('worker').modelId;
  chooseMemory(codexId);
  assert.equal(resolveMemoryModelRoute('learn')?.modelId, codexId);
  writeAuth({ codex: false });
  assert.equal(resolveMemoryModelRoute('learn'), null);
  const availability = memoryModelAvailability('learn');
  assert.equal(availability.ok, false);
  if (!availability.ok) assert.equal(availability.reason, 'model_unavailable');
});

test('an extractor pause makes learning wait until the provider said, with the problem', () => {
  const until = Date.now() + 10 * 60_000;
  setReflectionExtractorPauseForTest(until, 'quota');
  assert.deepEqual(memoryModelAvailability('learn'), {
    ok: false, reason: 'model_paused', problem: 'quota', until: new Date(until).toISOString(),
  });
  assert.deepEqual(describeMemoryModel().unavailable, { problem: 'quota', until: new Date(until).toISOString() });
  assert.deepEqual(memoryModelAvailability('reconcile'), { ok: true }, 'the extractor pause is the extractor\'s');
  setReflectionExtractorPauseForTest(Date.now() - 1, 'quota');
  assert.deepEqual(memoryModelAvailability('learn'), { ok: true }, 'a lapsed pause no longer holds learning');
  assert.equal(describeMemoryModel().unavailable, null);
});

test('jobs the memory model does not govern have no memory route and never wait on it', () => {
  for (const job of ['standing', 'verify', 'index', 'tidy'] as const) {
    assert.equal(resolveMemoryModelRoute(job), null, job);
    assert.deepEqual(memoryModelAvailability(job), { ok: true }, job);
  }
});

test('a memory call records role memory, keeps the job channel, and names the route that served it', async () => {
  const route = resolveMemoryModelRoute('learn');
  assert.ok(route && typeof route.model === 'object');
  const usage: ObservedModelUsage[] = [];
  const routes: ObservedModelRoute[] = [];
  await withModelUsageObserver(usage, () => withModelRouteObserver(routes, () =>
    withModelUsageAttribution({ sessionId: 'memory', sourceUserSeq: 0, channel: 'memory:learn' }, () =>
      (route.model as Model).getResponse({ input: 'fixture', modelSettings: {}, tools: [], handoffs: [] } as never))));
  assert.equal(usage.length, 1);
  assert.equal(usage[0].role, 'memory', 'the route role reaches the usage row');
  assert.equal(usage[0].channel, 'memory:learn', 'the job scope keeps its channel');
  assert.equal(routes.length, 1);
  assert.deepEqual({ role: routes[0].role, status: routes[0].status, resolvedModel: routes[0].resolvedModel, job: routes[0].reason?.job },
    { role: 'memory', status: 'success', resolvedModel: route.modelId, job: 'learn' });
  assert.deepEqual(readRouteStandIn(routes), { route: routes[0], standIn: false });

  const row = openModelRouteMetricsDb().prepare(`
    SELECT d.role, d.reason_json, o.status FROM model_route_decisions d
    JOIN model_route_outcomes o ON o.decision_id = d.id
    WHERE d.id = ?
  `).get(routes[0].decisionId) as { role: string; reason_json: string; status: string } | undefined;
  assert.equal(row?.role, 'memory', 'the decisions table admits the memory role');
  assert.equal(row?.status, 'success');
  assert.deepEqual({ seam: JSON.parse(row!.reason_json).seam, job: JSON.parse(row!.reason_json).job }, { seam: 'memory', job: 'learn' });
});

test('a failed extraction pauses learning with the kind of trouble the provider reported', async () => {
  process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off'; // no other family to hedge onto
  const failing = (error: Record<string, unknown>): Model => ({
    async getResponse(): Promise<ModelResponse> { throw Object.assign(new Error(String(error.message ?? 'refused')), error); },
    async *getStreamedResponse() { throw Object.assign(new Error(String(error.message ?? 'refused')), error); },
  });
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ statusCode: 429, message: 'rate limited' }, 'quota'],
    [{ statusCode: 402, message: 'payment required' }, 'credit'],
    [{ statusCode: 401, message: 'unauthorized' }, 'not_connected'],
    [{ statusCode: 503, message: 'unavailable' }, 'error'],
  ];
  for (const [error, problem] of cases) {
    setReflectionExtractorPauseForTest(null);
    mock.restoreAll();
    mock.method(CodexModelProvider.prototype, 'getModel', () => failing(error));
    mock.method(ClaudeModelProvider.prototype, 'getModel', () => failing(error));
    assert.equal(await _testOnly_runExtractor('{"fixture":true}'), null);
    const pause = reflectionExtractorPause();
    assert.equal(pause?.problem, problem, `status ${error.statusCode} pauses as ${problem}`);
    const availability = memoryModelAvailability('learn');
    assert.equal(availability.ok, false);
    if (!availability.ok) {
      assert.equal(availability.reason, 'model_paused');
      assert.equal(availability.problem, problem);
      assert.equal(availability.until, new Date(pause!.until).toISOString());
    }
  }
  setReflectionExtractorPauseForTest(null);
});

test('memory work never pins the brain: after the owner switches it, the route and the row still agree', () => {
  // Same-family automatic memory follows the brain's family, so a stale brain
  // would put memory work on the wrong family's model.
  process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
  __sessionBrainPinTest__.reset();
  __sessionBrainPinTest__.setValidatorForTests(() => true);
  try {
    // The journal's scope: a fixed label, no accepted user input.
    const scope = { sessionId: 'memory', sourceUserSeq: 0, channel: 'memory:learn', role: 'memory' as const };
    const inJob = () => withModelUsageAttribution(scope, () => ({
      brain: resolveRoleModel('brain'),
      learn: resolveMemoryModelRoute('learn')?.modelId,
    }));
    const before = inJob();
    assert.ok(before.learn, 'fixture: the automatic route resolves');
    process.env.AUTH_MODE = 'claude_oauth'; // the owner switches the brain
    const after = inJob();
    assert.notEqual(after.brain.source, 'session', 'a memory job is not a served turn');
    assert.equal(after.brain.modelId, resolveRoleModel('brain').modelId, 'memory work sees the brain the owner chose');
    assert.equal(after.learn, describeMemoryModel().modelId, 'the job runs on the model the Memory tab names');
    assert.notEqual(after.learn, before.learn, 'the switch reached memory work');
    assert.equal(pinnedBrainForSession('memory'), null, 'nothing was pinned under the job label');
  } finally {
    __sessionBrainPinTest__.reset();
  }
});

test('an automatic model that is the brain\'s own model says it follows the brain', () => {
  // A same-family checker whose cheap model is the brain's model.
  Object.assign(process.env, {
    AUTH_MODE: 'claude_oauth', CLEMMY_JUDGE_CROSS_FAMILY: 'off',
    CLAUDE_MODEL: 'claude-test-model', CLEMMY_BOUNDARY_JUDGE_CLAUDE_MODEL: 'claude-test-model',
  });
  try {
    assert.notEqual(resolveRoleModel('judge').modelId, 'claude-test-model', 'fixture: the checker row names another model');
    const route = resolveMemoryModelRoute('learn');
    assert.equal(route?.modelId, resolveBoundaryJudge().modelId, 'still exactly the boundary selection');
    assert.equal(route?.modelId, 'claude-test-model');
    assert.equal(route?.follows, 'brain');
    const described = describeMemoryModel();
    assert.deepEqual({ source: described.source, modelId: described.modelId, follows: described.follows },
      { source: 'automatic', modelId: 'claude-test-model', follows: 'brain' });
    assert.equal(memoryRoleSettingsView().follows, 'brain');
  } finally {
    delete process.env.CLAUDE_MODEL;
  }
});

test('when the automatic route cannot be built, nothing is named and the row says why', () => {
  // The owner pinned the checker; its account is signed out.
  const codexJudge = resolveRoleModel('worker').modelId;
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'judge', modelId: codexJudge, scope: 'durable', source: 'settings' }]);
  assert.equal(resolveMemoryModelRoute('learn')?.modelId, codexJudge, 'fixture: the pin serves while signed in');
  writeAuth({ codex: false });
  assert.equal(resolveMemoryModelRoute('learn'), null, 'learning waits; the checker pin is never substituted');
  const described = describeMemoryModel();
  assert.deepEqual(
    { source: described.source, modelId: described.modelId, follows: described.follows, unavailable: described.unavailable },
    { source: 'automatic', modelId: null, follows: null, unavailable: { problem: 'not_connected' } },
  );
  assert.deepEqual(memoryModelAvailability('learn'), { ok: false, reason: 'model_unavailable', problem: 'not_connected' });
  const view = memoryRoleSettingsView();
  assert.deepEqual({ modelId: view.modelId, source: view.source, unavailable: view.unavailable },
    { modelId: '', source: 'default', unavailable: { problem: 'not_connected' } });
});

test('a checker out of plan quota makes automatic learning wait until the plan serves again', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test'; // the quota store stays in memory
  __resetRateLimitStoreForTests();
  try {
    const codexJudge = resolveRoleModel('worker').modelId;
    process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'judge', modelId: codexJudge, scope: 'durable', source: 'settings' }]);
    recordCodexUsageExhausted(60 * 60_000); // the provider refused for its usage limit
    const until = new Date(getRateLimitSnapshot().codex!.exhaustedUntil!).toISOString();
    assert.equal(resolveMemoryModelRoute('learn'), null);
    const described = describeMemoryModel();
    assert.deepEqual({ modelId: described.modelId, unavailable: described.unavailable },
      { modelId: null, unavailable: { problem: 'quota', until } });
    assert.deepEqual(memoryModelAvailability('learn'), { ok: false, reason: 'model_unavailable', problem: 'quota', until });
  } finally {
    __resetRateLimitStoreForTests();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('with no model signed in, the automatic route resolves nothing: every governed job waits as not connected', () => {
  // The checker's selection still builds a model for a signed-out family
  // (a review fails open); memory work must not spend tries on it.
  const governed = ['learn', 'reconcile', 'patterns', 'skills', 'identity', 'import'] as const;
  for (const crossFamily of ['on', 'off']) {
    process.env.CLEMMY_JUDGE_CROSS_FAMILY = crossFamily;
    writeAuth({ claude: false, codex: false });
    assert.ok(resolveBoundaryJudge().model, 'fixture: the checker route still builds a model');
    for (const job of governed) {
      assert.equal(resolveMemoryModelRoute(job), null, `${job} (cross-family ${crossFamily})`);
      assert.deepEqual(memoryModelAvailability(job), { ok: false, reason: 'model_unavailable', problem: 'not_connected' }, job);
    }
    const described = describeMemoryModel();
    assert.deepEqual({ modelId: described.modelId, unavailable: described.unavailable },
      { modelId: null, unavailable: { problem: 'not_connected' } });
    for (const job of governed) assert.equal(memoryJobModelId(job, described), null, `${job} names no model nothing can serve`);
    assert.deepEqual(memoryRoleSettingsView().unavailable, { problem: 'not_connected' });
  }
});

test('a same-family automatic route on a signed-out brain family waits, while the model strings still reach a connected provider', () => {
  Object.assign(process.env, { AUTH_MODE: 'claude_oauth', CLEMMY_JUDGE_CROSS_FAMILY: 'off' });
  writeAuth({ claude: false });
  assert.equal(resolveBoundaryJudge().judgeFamily, 'claude', 'fixture: the checker stays in the brain family');
  assert.equal(resolveMemoryModelRoute('learn'), null);
  assert.deepEqual(memoryModelAvailability('learn'), { ok: false, reason: 'model_unavailable', problem: 'not_connected' });
  // A bare model string goes through the shared router, which reaches the
  // provider that is signed in.
  assert.ok(resolveMemoryModelRoute('skills'), 'skills still has a model that can answer');
  writeAuth();
  assert.ok(resolveMemoryModelRoute('learn'), 'signed back in, learning resumes');
});
