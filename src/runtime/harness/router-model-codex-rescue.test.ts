/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/router-model-codex-rescue.test.ts
 *
 * Isolated route proof for the user-configurable all-in BYO rescue lane. The
 * provider seams are fake, but the production router, fallback graph, metrics,
 * and operational telemetry all execute unchanged.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-router-rescue-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { RouterModelProvider } = await import('./router-model.js');
const { fallbackRouteResolution } = await import('./fallback-model.js');
const { BoundaryError } = await import('../boundary-error.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('./brackets.js');
const { listOperationalEvents, closeOperationalTelemetryDb } = await import('../operational-telemetry.js');
const { openModelRouteMetricsDb, closeModelRouteMetricsDb } = await import('../model-route-metrics.js');

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

after(() => {
  closeModelRouteMetricsDb();
  closeOperationalTelemetryDb();
});

test('GLM transport timeout falls to the configured cheaper Codex model with exact telemetry identity', async () => {
  process.env.AUTH_MODE = 'api_key';
  process.env.MODEL_ROUTING_MODE = 'all_in';
  process.env.BYO_MODEL_BASE_URL = 'https://api.z.ai/api/paas/v4';
  process.env.BYO_MODEL_ID = 'glm-5.2';
  process.env.BYO_MODEL_API_KEY = 'test-key';
  process.env.BYO_MODEL_PROVIDER = 'GLM (Z.ai)';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.6-sol';
  process.env.OPENAI_MODEL_RESCUE = 'gpt-5.6-luna';

  const requestedCodexModels: string[] = [];
  const hungGlm = model({
    getResponse: async () => {
      throw new BoundaryError({
        kind: 'model.transport_timeout',
        retryable: true,
        userMessage: 'The GLM model timed out.',
        operatorMessage: 'deterministic GLM timeout for route proof',
      });
    },
  });
  const luna = model({ getResponse: async () => response('rescued by luna') });
  const unusedClaude = model({ getResponse: async () => response('must not use Claude') });
  const router = new RouterModelProvider({
    resolveByoModel: () => hungGlm,
    codex: {
      getModel: (modelId) => {
        requestedCodexModels.push(modelId ?? '');
        return luna;
      },
    },
    claude: { getModel: () => unusedClaude },
    codexAvailable: () => true,
    claudeAvailable: () => false,
  });
  const sessionId = 'router-rescue-configured-luna';

  const result = await withHarnessRunContext({
    sessionId,
    counter: new ToolCallsCounter(8),
  }, async () => router.getModel('glm-5.2').getResponse(request()));

  assert.equal((result.output[0] as { content?: string }).content, 'rescued by luna');
  assert.deepEqual(requestedCodexModels, ['gpt-5.6-luna'], 'the route uses the exact configured id, not primary/label inference');
  assert.deepEqual(fallbackRouteResolution(result), {
    initialLabel: 'glm-5.2',
    resolvedLabel: 'codex:rescue',
    provider: 'codex',
    model: 'gpt-5.6-luna',
    fellOver: true,
    reason: 'model.transport_timeout',
  });

  const rescueDecision = openModelRouteMetricsDb().prepare(`
    SELECT resolved_model AS resolvedModel, provider, source
    FROM model_route_decisions
    WHERE session_id = ? AND source = 'fallback'
  `).get(sessionId) as { resolvedModel?: string; provider?: string; source?: string } | undefined;
  assert.deepEqual(rescueDecision, {
    resolvedModel: 'gpt-5.6-luna',
    provider: 'codex',
    source: 'fallback',
  });

  const [fallover] = listOperationalEvents({ sessionId, limit: 20 })
    .filter((event) => event.type === 'model_fallover');
  assert.ok(fallover, 'the provider switch is visible in operational telemetry');
  assert.equal((fallover.payload as Record<string, unknown>).toProvider, 'codex');
  assert.equal((fallover.payload as Record<string, unknown>).toModel, 'gpt-5.6-luna');
  assert.equal((fallover.payload as Record<string, unknown>).resolvedModel, 'gpt-5.6-luna');
});

test('an unset rescue with a BYO primary targets and reports the canonical Codex default', async () => {
  process.env.AUTH_MODE = 'api_key';
  process.env.MODEL_ROUTING_MODE = 'all_in';
  process.env.BYO_MODEL_BASE_URL = 'https://api.z.ai/api/paas/v4';
  process.env.BYO_MODEL_ID = 'glm-5.3';
  process.env.BYO_MODEL_API_KEY = 'test-key';
  process.env.BYO_MODEL_PROVIDER = 'GLM (Z.ai)';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  process.env.OPENAI_MODEL_PRIMARY = 'glm-5.3';
  delete process.env.OPENAI_MODEL_RESCUE;

  const requestedCodexModels: string[] = [];
  const hungGlm = model({
    getResponse: async () => {
      throw new BoundaryError({
        kind: 'model.transport_timeout',
        retryable: true,
        userMessage: 'The GLM model timed out.',
        operatorMessage: 'deterministic GLM timeout for inherited route proof',
      });
    },
  });
  const codex = model({ getResponse: async () => response('rescued by the Codex default') });
  const router = new RouterModelProvider({
    resolveByoModel: () => hungGlm,
    codex: {
      getModel: (modelId) => {
        requestedCodexModels.push(modelId ?? '');
        return codex;
      },
    },
    claude: { getModel: () => model({ getResponse: async () => response('unused Claude') }) },
    codexAvailable: () => true,
    claudeAvailable: () => false,
  });
  const sessionId = 'router-rescue-byo-primary-safe-default';

  const result = await withHarnessRunContext({
    sessionId,
    counter: new ToolCallsCounter(8),
  }, async () => router.getModel('glm-5.3').getResponse(request()));

  assert.equal((result.output[0] as { content?: string }).content, 'rescued by the Codex default');
  assert.deepEqual(requestedCodexModels, ['gpt-5.4']);
  assert.deepEqual(fallbackRouteResolution(result), {
    initialLabel: 'glm-5.3',
    resolvedLabel: 'codex:rescue',
    provider: 'codex',
    model: 'gpt-5.4',
    fellOver: true,
    reason: 'model.transport_timeout',
  });

  const rescueDecision = openModelRouteMetricsDb().prepare(`
    SELECT resolved_model AS resolvedModel, provider, source
    FROM model_route_decisions
    WHERE session_id = ? AND source = 'fallback'
  `).get(sessionId) as { resolvedModel?: string; provider?: string; source?: string } | undefined;
  assert.deepEqual(rescueDecision, {
    resolvedModel: 'gpt-5.4',
    provider: 'codex',
    source: 'fallback',
  });

  const [fallover] = listOperationalEvents({ sessionId, limit: 20 })
    .filter((event) => event.type === 'model_fallover');
  assert.ok(fallover);
  assert.equal((fallover.payload as Record<string, unknown>).toModel, 'gpt-5.4');
  assert.equal((fallover.payload as Record<string, unknown>).resolvedModel, 'gpt-5.4');
});

test('the router applies the absolute pre-actionable wall only to an interactive foreground context', async () => {
  process.env.AUTH_MODE = 'api_key';
  process.env.MODEL_ROUTING_MODE = 'all_in';
  process.env.BYO_MODEL_BASE_URL = 'https://api.z.ai/api/paas/v4';
  process.env.BYO_MODEL_ID = 'glm-foreground-deadline';
  process.env.BYO_MODEL_API_KEY = 'test-key';
  process.env.BYO_MODEL_PROVIDER = 'GLM (Z.ai)';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  process.env.CLEMMY_MODEL_INTERACTIVE_PRE_ACTIONABLE_MS = '45';
  process.env.OPENAI_MODEL_RESCUE = 'gpt-5.6-luna';

  let foregroundRescueCalls = 0;
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
  const foregroundRouter = new RouterModelProvider({
    resolveByoModel: () => privateThenSlowText,
    codex: { getModel: () => model({ getStreamedResponse: async function* () {
      foregroundRescueCalls += 1;
      yield { type: 'output_text_delta', delta: 'foreground rescue' } as never;
    } }) },
    claude: { getModel: () => model({}) },
    codexAvailable: () => true,
    claudeAvailable: () => false,
  });

  const foregroundEvents = await withHarnessRunContext({
    sessionId: 'router-interactive-pre-actionable',
    interactiveForeground: true,
    counter: new ToolCallsCounter(8),
  }, () => collect(foregroundRouter.getModel('glm-foreground-deadline').getStreamedResponse(request())));

  assert.equal(foregroundRescueCalls, 1);
  assert.deepEqual(
    foregroundEvents.map((event) => (event as { delta?: string }).delta).filter(Boolean),
    ['foreground rescue'],
  );
  assert.equal(fallbackRouteResolution(foregroundEvents.at(-1))?.reason, 'pre-actionable-timeout');

  process.env.BYO_MODEL_ID = 'glm-background-no-deadline';
  let backgroundRescueCalls = 0;
  const backgroundRouter = new RouterModelProvider({
    resolveByoModel: () => privateThenSlowText,
    codex: { getModel: () => model({ getStreamedResponse: async function* () {
      backgroundRescueCalls += 1;
      yield { type: 'output_text_delta', delta: 'background rescue must not run' } as never;
    } }) },
    claude: { getModel: () => model({}) },
    codexAvailable: () => true,
    claudeAvailable: () => false,
  });
  const backgroundEvents = await withHarnessRunContext({
    sessionId: 'router-background-no-pre-actionable',
    interactiveForeground: false,
    counter: new ToolCallsCounter(8),
  }, () => collect(backgroundRouter.getModel('glm-background-no-deadline').getStreamedResponse(request())));

  assert.equal(backgroundRescueCalls, 0, 'background work does not inherit a foreground latency wall');
  assert.deepEqual(
    backgroundEvents.map((event) => (event as { delta?: string }).delta).filter(Boolean),
    ['primary eventually answered'],
  );
});
