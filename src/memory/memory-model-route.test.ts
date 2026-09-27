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
const { defaultForRole, resolveRoleModel } = await import('../runtime/harness/model-roles.js');
const { _setDiscoveredModelsForTest } = await import('../runtime/harness/model-discovery.js');
const { MODELS, DEFAULT_CODEX_FAST_MODEL } = await import('../config.js');
const {
  describeMemoryModel,
  memoryModelAvailability,
  memoryRoleSettingsView,
  resolveMemoryModelRoute,
} = await import('./memory-model-route.js');
const { setReflectionExtractorPauseForTest } = await import('./reflection.js');
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
      assert.equal(route.timeoutMs, checker.timeoutMs, 'the checker deadline passes through');
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
    assert.equal(route.timeoutMs, undefined);
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
    assert.equal(route.timeoutMs, undefined);
    assert.equal(route.boundary, undefined);
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
