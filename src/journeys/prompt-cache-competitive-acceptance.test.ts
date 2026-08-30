/**
 * Run: node scripts/run-tests-isolated.mjs src/journeys/prompt-cache-competitive-acceptance.test.ts
 *
 * Competitive prompt-cache gate. Requests are assembled by the real
 * Orchestrator + Agents SDK and cross the production model-route recording
 * wrapper. The deterministic provider owns its tokenization/cache state and
 * returns an explicit, dialect-bound usage receipt; these are causal eval
 * metrics, never represented as measurements from a live commercial provider.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-prompt-cache-competitive-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.AUTH_MODE = 'codex_oauth';
process.env.MODEL_ROUTING_MODE = 'off';
process.env.CLEMMY_MODEL_PARITY = 'on';
process.env.CLEMMY_RUBRIC_VARIANT = 'lean';
process.env.CLEMMY_TOOL_JIT = 'on';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'prompt-cache-competitive-machine\n');

const sdk = await import('@openai/agents');
const { buildOrchestratorAgent } = await import('../agents/orchestrator.js');
const { createSession } = await import('../runtime/harness/eventlog.js');
const { checkpointWorkingMemory } = await import('../memory/working-memory.js');
const {
  closeModelRouteMetricsDb,
  openModelRouteMetricsDb,
  withModelRouteMetrics,
} = await import('../runtime/model-route-metrics.js');
const {
  comparePromptCacheRequests,
  observePromptCacheRequest,
} = await import('../runtime/harness/prompt-cache-observation.js');

after(() => {
  closeModelRouteMetricsDb();
  rmSync(HOME, { recursive: true, force: true });
});

function responseMessage(text: string) {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  } as const;
}

type Observation = ReturnType<typeof observePromptCacheRequest>;
type Transition = ReturnType<typeof comparePromptCacheRequests>;

class RecordingCacheProvider implements Model {
  readonly requests: ModelRequest[] = [];
  readonly observations: Observation[] = [];
  readonly transitions: Transition[] = [];
  readonly usage: Array<{
    inputTokens: number;
    cachedInputTokens: number;
    uncachedInputTokens: number;
  }> = [];
  private previous: Observation | null = null;

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const observation = observePromptCacheRequest(request);
    const transition = comparePromptCacheRequests(this.previous, observation);
    const promptLayers = ['stablePolicy', 'turnContext', 'memoryContext', 'catalog', 'task'] as const;
    // This is the recording provider's declared tokenizer. It is intentionally
    // deterministic and owned at the provider boundary; the harness never
    // estimates or invents the resulting usage fields.
    const tokens = Object.fromEntries(promptLayers.map((name) => [
      name,
      observation.layers[name].bytes === 0 ? 0 : Math.max(1, Math.ceil(observation.layers[name].bytes / 4)),
    ])) as Record<(typeof promptLayers)[number], number>;
    const inputTokens = promptLayers.reduce((sum, name) => sum + tokens[name], 0);
    const cachedInputTokens = transition.reusableLayers
      .filter((name): name is (typeof promptLayers)[number] => promptLayers.includes(name as never))
      .reduce((sum, name) => sum + tokens[name], 0);
    const uncachedInputTokens = inputTokens - cachedInputTokens;
    const providerUsage = {
      version: 1 as const,
      cacheDialect: 'inclusive' as const,
      inputTokens,
      cachedInputTokens,
      uncachedInputTokens,
    };

    this.requests.push(request);
    this.observations.push(observation);
    this.transitions.push(transition);
    this.usage.push(providerUsage);
    this.previous = observation;

    return {
      usage: new sdk.Usage({
        requests: 1,
        inputTokens,
        outputTokens: 1,
        totalTokens: inputTokens + 1,
        inputTokensDetails: { cachedTokens: cachedInputTokens },
        outputTokensDetails: {},
      }),
      output: [responseMessage(JSON.stringify({
        summary: 'Cache cohort response.',
        reply: 'Cache cohort response.',
        done: true,
        nextAction: 'completed',
        reason: null,
      }))] as never,
      responseId: `cache-provider-${this.requests.length}`,
      providerData: { promptCacheUsage: providerUsage },
    };
  }

  async *getStreamedResponse(request: ModelRequest) {
    const response = await this.getResponse(request);
    yield { type: 'response_started' } as never;
    yield { type: 'response_done', response } as never;
  }
}

test('cold/warm/policy/memory/catalog/task cohort preserves the exact stable prefix and records certified usage', async (t) => {
  const session = createSession({
    id: 'prompt-cache-competitive-session',
    kind: 'chat',
    userId: 'prompt-cache-user',
  });
  checkpointWorkingMemory(session.id, {
    turn: 1,
    lastText: 'CACHE_MEMORY_ALPHA: summarize the launch notes without external work.',
  });

  const provider = new RecordingCacheProvider();
  const recorded = withModelRouteMetrics(provider, {
    sessionId: session.id,
    role: 'brain',
    requestedModel: 'recording-cache-provider',
    resolvedModel: 'recording-cache-provider',
    provider: 'unknown',
    source: 'explicit',
    reason: { cohort: 'prompt-cache-competitive' },
  });
  const naturalTask = 'Rewrite these launch notes as a concise, friendly update for the team.';
  const alternateTask = 'Rewrite these launch notes as three concise bullets for the team.';

  async function buildPolicyAgent() {
    return buildOrchestratorAgent({
      userInput: naturalTask,
      sessionId: session.id,
      hostPlainConversation: true,
      allowToolJit: true,
      model: recorded as never,
    });
  }

  async function run(agent: Awaited<ReturnType<typeof buildPolicyAgent>>, input: string): Promise<void> {
    const runner = new sdk.Runner();
    await runner.run(agent, input, { maxTurns: 1 });
  }

  const policyA = await buildPolicyAgent();
  await run(policyA, naturalTask);       // cold
  await run(policyA, naturalTask);       // exact warm
  await run(policyA, alternateTask);     // task-only drift

  checkpointWorkingMemory(session.id, {
    turn: 2,
    lastText: 'CACHE_MEMORY_BETA: the audience now prefers a shorter update.',
  });
  const memoryB = await buildPolicyAgent();
  await run(memoryB, alternateTask);     // memory-only drift

  const memoryRequest = provider.requests.at(-1)!;
  const catalogRequest: ModelRequest = {
    ...memoryRequest,
    tools: [{
      type: 'function',
      name: 'recording_catalog_revision',
      description: 'A recording-only catalog revision; it is never invoked.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      strict: true,
    }],
    toolsExplicitlyProvided: true,
  } as ModelRequest;
  await recorded.getResponse(catalogRequest); // catalog-only drift

  process.env.CLEMMY_RUBRIC_VARIANT = 'legacy';
  const policyB = await buildPolicyAgent();
  await run(policyB, alternateTask);      // explicit policy revision
  process.env.CLEMMY_RUBRIC_VARIANT = 'lean';

  assert.equal(provider.requests.length, 6, 'each cohort member crosses the recording provider exactly once');
  assert.deepEqual(provider.transitions.map((entry) => entry.invalidatedAt), [
    'cold',
    'none',
    'task',
    'memory_context',
    'catalog',
    'policy',
  ]);

  const [cold, warm, taskDrift, memoryDrift, catalogDrift, policyDrift] = provider.observations;
  assert.ok(cold?.cacheEligible, 'the production request exposes one canonical stable boundary');
  assert.equal(cold?.layers.stablePolicy.sha256, warm?.layers.stablePolicy.sha256);
  assert.equal(cold?.layers.stablePolicy.sha256, taskDrift?.layers.stablePolicy.sha256);
  assert.equal(cold?.layers.stablePolicy.sha256, memoryDrift?.layers.stablePolicy.sha256);
  assert.equal(cold?.layers.stablePolicy.sha256, catalogDrift?.layers.stablePolicy.sha256);
  assert.notEqual(cold?.layers.stablePolicy.sha256, policyDrift?.layers.stablePolicy.sha256,
    'only the explicit rubric revision changes the identity/rubric bytes');
  assert.notEqual(taskDrift?.layers.task.sha256, warm?.layers.task.sha256);
  assert.notEqual(memoryDrift?.layers.memoryContext.sha256, taskDrift?.layers.memoryContext.sha256);
  assert.notEqual(catalogDrift?.layers.catalog.sha256, memoryDrift?.layers.catalog.sha256);

  const [coldUsage, warmUsage] = provider.usage;
  assert.ok(coldUsage && warmUsage);
  assert.equal(coldUsage.cachedInputTokens, 0);
  assert.ok(warmUsage.cachedInputTokens > 0);
  assert.ok(warmUsage.uncachedInputTokens <= coldUsage.uncachedInputTokens * 0.70,
    `warm uncached ${warmUsage.uncachedInputTokens} must be <=70% of cold ${coldUsage.uncachedInputTokens}`);
  t.diagnostic(`recording-provider usage: ${JSON.stringify({
    cold: coldUsage,
    warm: warmUsage,
    warmToColdUncachedRatio: coldUsage.uncachedInputTokens > 0
      ? warmUsage.uncachedInputTokens / coldUsage.uncachedInputTokens
      : null,
  })}`);
  assert.equal(provider.usage.at(-1)?.cachedInputTokens, 0,
    'a live policy revision cannot reuse the retired policy prefix');

  // Current requests contain current truth only. The cache receipt is digests
  // and usage—not a prompt/result replay channel or capability authority.
  const memoryBWire = JSON.stringify(provider.requests[3]);
  assert.match(memoryBWire, /CACHE_MEMORY_BETA/);
  assert.doesNotMatch(memoryBWire, /CACHE_MEMORY_ALPHA/);
  const policyBWire = JSON.stringify(provider.requests[5]);
  assert.doesNotMatch(policyBWire, /CACHE_MEMORY_ALPHA/);
  assert.doesNotMatch(policyBWire, /cache-provider-[1-5]/,
    'prior response identity is not replayed into a fresh accepted request');

  const db = openModelRouteMetricsDb();
  const rows = db.prepare(`
    SELECT d.reason_json, o.input_tokens, o.cached_tokens, o.metadata_json
    FROM model_route_decisions d
    JOIN model_route_outcomes o ON o.decision_id = d.id
    ORDER BY d.rowid ASC
  `).all() as Array<{
    reason_json: string;
    input_tokens: number;
    cached_tokens: number;
    metadata_json: string;
  }>;
  assert.equal(rows.length, 6);
  for (const [index, row] of rows.entries()) {
    const reason = JSON.parse(row.reason_json) as { promptCacheRequest?: Observation };
    const metadata = JSON.parse(row.metadata_json) as {
      promptCacheUsage?: {
        cacheDialect: string;
        inputTokens: number;
        cachedInputTokens: number;
        uncachedInputTokens: number;
      };
    };
    assert.equal(reason.promptCacheRequest?.normalizedRequestDigest, provider.observations[index]?.normalizedRequestDigest);
    assert.equal(row.input_tokens, provider.usage[index]?.inputTokens);
    assert.equal(row.cached_tokens, provider.usage[index]?.cachedInputTokens);
    assert.deepEqual(metadata.promptCacheUsage, {
      version: 1,
      cacheDialect: 'inclusive',
      ...provider.usage[index],
    });
  }
});
