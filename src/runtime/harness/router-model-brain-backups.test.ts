/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/router-model-brain-backups.test.ts
 *
 * Isolated route proof for the owner's backup brains. The provider seams are
 * fake, but the production router, fallback graph, metrics and operational
 * telemetry all execute unchanged.
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-router-backups-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { RouterModelProvider } = await import('./router-model.js');
const { fallbackRouteResolution } = await import('./fallback-model.js');
const { BoundaryError } = await import('../boundary-error.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('./brackets.js');
const { listOperationalEvents, closeOperationalTelemetryDb } = await import('../operational-telemetry.js');
const { openModelRouteMetricsDb, closeModelRouteMetricsDb } = await import('../model-route-metrics.js');
const { modelUsageAttributionStorage } = await import('../usage-log.js');
const backups = await import('./brain-backups.js');

const BACKUP = 'gpt-5.6-luna';

function request(): ModelRequest {
  return { input: 'recover this turn', modelSettings: {}, tools: [], handoffs: [] } as unknown as ModelRequest;
}

function response(text: string): ModelResponse {
  return { output: [{ type: 'message', content: text }], usage: {} } as unknown as ModelResponse;
}

function model(impl: Partial<Model>): Model {
  return {
    getResponse: impl.getResponse ?? (async () => response('ok')),
    getStreamedResponse: impl.getStreamedResponse ?? (async function* () {
      yield { type: 'response_done', response: response('ok') } as never;
    }),
  } as Model;
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const timeout = () => new BoundaryError({
  kind: 'model.transport_timeout',
  retryable: true,
  userMessage: 'The model timed out.',
  operatorMessage: 'deterministic timeout for route proof',
});

function allInBrain(modelId: string): void {
  process.env.AUTH_MODE = 'api_key';
  process.env.MODEL_ROUTING_MODE = 'all_in';
  process.env.BYO_MODEL_BASE_URL = 'https://api.z.ai/api/paas/v4';
  process.env.BYO_MODEL_ID = modelId;
  process.env.BYO_MODEL_API_KEY = 'test-key';
  process.env.BYO_MODEL_PROVIDER = 'GLM (Z.ai)';
  process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.6-sol';
}

function routerWith(primary: Model, requested: string[], backup: Model) {
  return new RouterModelProvider({
    resolveByoModel: () => primary,
    resolveEffectiveProvider: (id) => (id.startsWith('gpt-') ? 'codex' : 'byo'),
    codex: { getModel: (modelId) => { requested.push(modelId ?? ''); return backup; } },
    claude: { getModel: () => model({ getResponse: async () => response('must not use Claude') }) },
    codexAvailable: () => true,
    claudeAvailable: () => true,
  });
}

beforeEach(() => {
  rmSync(path.join(TMP_HOME, 'state', 'brain-outage.json'), { force: true });
  backups.__brainBackupsTest__.reset(path.join(TMP_HOME, 'state', 'brain-outage.json'));
  backups.__brainBackupsTest__.setOptions(() => [
    { id: 'codex_oauth', value: `codex_oauth:${BACKUP}`, label: 'Codex — GPT-5.6 Luna', available: true, modelId: BACKUP },
  ]);
  delete process.env[backups.BRAIN_BACKUPS_ENV];
});

after(() => {
  backups.__brainBackupsTest__.reset();
  closeModelRouteMetricsDb();
  closeOperationalTelemetryDb();
});

test('a brain that times out falls to the owner\'s first listed backup with exact telemetry identity', async () => {
  allInBrain('glm-5.2');
  process.env[backups.BRAIN_BACKUPS_ENV] = JSON.stringify([BACKUP]);
  const requested: string[] = [];
  const router = routerWith(model({ getResponse: async () => { throw timeout(); } }), requested,
    model({ getResponse: async () => response('answered by the backup') }));
  const sessionId = 'router-backup-listed';

  const result = await withHarnessRunContext({ sessionId, counter: new ToolCallsCounter(8) },
    async () => router.getModel('glm-5.2').getResponse(request()));

  assert.equal((result.output[0] as { content?: string }).content, 'answered by the backup');
  assert.deepEqual(requested, [BACKUP], 'only the listed model is asked');
  assert.deepEqual(fallbackRouteResolution(result), {
    initialLabel: 'glm-5.2',
    resolvedLabel: BACKUP,
    provider: 'codex',
    model: BACKUP,
    fellOver: true,
    reason: 'model.transport_timeout',
  });
  const decision = openModelRouteMetricsDb().prepare(`
    SELECT resolved_model AS resolvedModel, provider, source
    FROM model_route_decisions
    WHERE session_id = ? AND source = 'fallback'
  `).get(sessionId) as { resolvedModel?: string; provider?: string; source?: string } | undefined;
  assert.deepEqual(decision, { resolvedModel: BACKUP, provider: 'codex', source: 'fallback' });
  const [fallover] = listOperationalEvents({ sessionId, limit: 20 }).filter((event) => event.type === 'model_fallover');
  assert.ok(fallover, 'the switch is visible in operational telemetry');
  assert.equal((fallover.payload as Record<string, unknown>).toModel, BACKUP);
});

test('with no backup listed, the chosen brain is the only model asked, connected subscriptions included', async () => {
  allInBrain('glm-5.3');
  const requested: string[] = [];
  const router = routerWith(model({ getResponse: async () => { throw timeout(); } }), requested,
    model({ getResponse: async () => response('must not answer') }));
  await assert.rejects(withHarnessRunContext({ sessionId: 'router-no-backup', counter: new ToolCallsCounter(8) },
    async () => router.getModel('glm-5.3').getResponse(request())));
  assert.deepEqual(requested, [], 'no built-in rescue is asked');
});

test('a memory job on the brain\'s own model keeps waiting for it', async () => {
  allInBrain('glm-5.4');
  process.env[backups.BRAIN_BACKUPS_ENV] = JSON.stringify([BACKUP]);
  const requested: string[] = [];
  const router = routerWith(model({ getResponse: async () => { throw timeout(); } }), requested,
    model({ getResponse: async () => response('must not answer') }));
  await assert.rejects(modelUsageAttributionStorage.run(
    { sessionId: 'memory', sourceUserSeq: 0, role: 'memory', usageJobId: 'memory:learn:test' },
    async () => router.getModel('glm-5.4').getResponse(request()),
  ));
  assert.deepEqual(requested, []);
});

test('the router applies the absolute pre-actionable wall only to an interactive foreground context', async () => {
  allInBrain('glm-foreground-deadline');
  process.env[backups.BRAIN_BACKUPS_ENV] = JSON.stringify([BACKUP]);
  process.env.CLEMMY_MODEL_INTERACTIVE_PRE_ACTIONABLE_MS = '45';

  const privateThenSlowText = model({ getStreamedResponse: async function* () {
    yield {
      type: 'model',
      event: {
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { reasoning_content: 'private work' }, finish_reason: null }],
      },
    } as never;
    await new Promise((resolve) => setTimeout(resolve, 90));
    yield { type: 'output_text_delta', delta: 'primary eventually answered' } as never;
  } });
  let foregroundRescueCalls = 0;
  const foregroundRouter = routerWith(privateThenSlowText, [], model({ getStreamedResponse: async function* () {
    foregroundRescueCalls += 1;
    yield { type: 'output_text_delta', delta: 'foreground rescue' } as never;
  } }));
  const foregroundEvents = await withHarnessRunContext({
    sessionId: 'router-interactive-pre-actionable',
    interactiveForeground: true,
    counter: new ToolCallsCounter(8),
  }, () => collect(foregroundRouter.getModel('glm-foreground-deadline').getStreamedResponse(request())));
  assert.equal(foregroundRescueCalls, 1);
  assert.deepEqual(foregroundEvents.map((event) => (event as { delta?: string }).delta).filter(Boolean), ['foreground rescue']);
  assert.equal(fallbackRouteResolution(foregroundEvents.at(-1))?.reason, 'pre-actionable-timeout');

  allInBrain('glm-background-no-deadline');
  let backgroundRescueCalls = 0;
  const backgroundRouter = routerWith(privateThenSlowText, [], model({ getStreamedResponse: async function* () {
    backgroundRescueCalls += 1;
    yield { type: 'output_text_delta', delta: 'background rescue must not run' } as never;
  } }));
  const backgroundEvents = await withHarnessRunContext({
    sessionId: 'router-background-no-pre-actionable',
    interactiveForeground: false,
    counter: new ToolCallsCounter(8),
  }, () => collect(backgroundRouter.getModel('glm-background-no-deadline').getStreamedResponse(request())));
  assert.equal(backgroundRescueCalls, 0, 'background work does not inherit a foreground latency wall');
  assert.deepEqual(backgroundEvents.map((event) => (event as { delta?: string }).delta).filter(Boolean), ['primary eventually answered']);
});
