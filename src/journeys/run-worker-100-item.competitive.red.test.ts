/**
 * Run:
 *   node scripts/run-tests-isolated.mjs src/journeys/run-worker-100-item.competitive.red.test.ts
 *
 * Test-only competitive acceptance for one cold 100-item fan-out. The model,
 * connected catalog, provider, and worker model responses are hermetic; all
 * planning, disclosure, capability materialization, host execution, worker
 * pooling, reduction, durable manifests, replay, and gateway denial are the
 * production implementations.
 *
 * The historical `.red` suffix records the gap this journey originally
 * exposed; the release gate is now expected to stay green. The fixture does
 * not locally normalize worker packets or lower the live digest threshold:
 * both remain production-owned behavior.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { currentSourceAccountReviewer } from './gauntlet-sheet-account-review.fixture-support.js';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-run-worker-100-'));
const ITEM_COUNT = 100;
const RAW_DETAIL_BYTES = 4_096;
const MAX_WORKER_WIDTH = 6;
const MIN_CACHEABLE_PREFIX_RATIO = 0.85;
const SOURCE_OPERATION = 'COMPETITIVE_LIST_BENCHMARK_RECORDS';
const COMMIT_OPERATION = 'COMPETITIVE_CREATE_BENCHMARK_BATCH';
const READBACK_OPERATION = 'COMPETITIVE_GET_BENCHMARK_BATCH';
const SOURCE_REQUIREMENT = 'read_benchmark_set';
const COMMIT_REQUIREMENT = 'commit_benchmark_batch';
const READBACK_REQUIREMENT = 'verify_benchmark_batch';
const PROVIDER_OPERATION_VERSION = '20260825_01';
const PROMPT = 'Read the benchmark set of 100 fixture records, analyze every record independently, and commit one new ordered benchmark batch.';
const PREAMBLE = 'I’ll read the benchmark set, analyze all one hundred records in a bounded worker pool, then commit one ordered batch.';
const ITEMS = Object.freeze(Array.from({ length: ITEM_COUNT }, (_, index) =>
  `benchmark-item-${String(index + 1).padStart(3, '0')}`));

const SOURCE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['set_id', 'limit'],
  properties: {
    set_id: { type: 'string' },
    limit: { type: 'integer', minimum: 100, maximum: 100 },
  },
});
const COMMIT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['batch_name', 'evidence_json'],
  properties: {
    batch_name: { type: 'string' },
    evidence_json: { type: 'string' },
  },
});
const READBACK_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['batch_id'],
  properties: { batch_id: { type: 'string' } },
});
const SOURCE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['records', 'total', 'has_more'],
  properties: {
    records: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'digest'],
        properties: {
          id: { type: 'string' },
          digest: { type: 'string' },
        },
      },
    },
    total: { type: 'integer' },
    has_more: { type: 'boolean' },
  },
});
const COMMIT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['id', 'handle', 'receipt', 'successful', 'batch_id', 'committed'],
  properties: {
    id: { type: 'string' },
    handle: { type: 'string' },
    receipt: { type: 'string' },
    successful: { type: 'boolean' },
    batch_id: { type: 'string' },
    committed: { type: 'integer' },
  },
});
const READBACK_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['id', 'handle', 'content'],
  properties: {
    id: { type: 'string' },
    handle: { type: 'string' },
    content: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'digest'],
        properties: {
          id: { type: 'string' },
          digest: { type: 'string' },
        },
      },
    },
  },
});

process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.AUTH_MODE = 'codex_oauth';
process.env.MODEL_ROUTING_MODE = 'off';
process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.5';
process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{
  role: 'worker',
  modelId: 'claude-sonnet-4-6',
  scope: 'durable',
  source: 'competitive-test',
}]);
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_TOOL_JIT = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_BRAIN_FALLOVER = 'off';
process.env.CLEMMY_AUTH_FALLOVER = 'off';
process.env.CLEMMY_PLAN_FIRST = 'off';
process.env.CLEMMY_DYNAMIC_REASONING = 'off';
process.env.CLEMMY_EVAL_AUTO_PROMOTE = 'off';
process.env.CLEMMY_WORKER_MAX_CONCURRENCY = String(MAX_WORKER_WIDTH);
process.env.CLEMMY_WORKER_MAX_CONCURRENCY_GLOBAL = String(MAX_WORKER_WIDTH);
process.env.COMPOSIO_API_KEY = 'fixture-fanout-key';
process.env.COMPOSIO_USER_ID = 'fixture-fanout-user';
delete process.env.CLEMMY_REDUCE_FANOUT_THRESHOLD;
delete process.env.CLEMMY_CHAT_FANOUT_DIGEST;

mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-run-worker-100\n', 'utf8');
writeFileSync(path.join(HOME, 'state', 'auth.json'), JSON.stringify({
  source: 'native',
  codexOauth: {
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
    lastRefresh: new Date().toISOString(),
  },
}), 'utf8');
// The role registry only accepts a Claude worker binding when that provider is
// live-connected. This fake subscription-shaped grant keeps routing hermetic;
// the injected worker adapter below remains the sole model crossing.
writeFileSync(path.join(HOME, 'state', 'claude-auth.json'), JSON.stringify({
  accessToken: 'sk-ant-oat01-competitive-worker-fixture',
  refreshToken: 'fixture-refresh',
  expiresAt: Date.now() + 60 * 60 * 1_000,
}), 'utf8');

const { runConversation } = await import('../runtime/harness/loop.js');
const { configureHarnessRuntime, resetHarnessRuntimeConfig } = await import('../runtime/harness/codex-client.js');
const planScope = await import('../agents/plan-scope.js');
const modelDiscovery = await import('../runtime/harness/model-discovery.js');
const { buildOrchestratorAgent } = await import('../agents/orchestrator.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const capabilityCatalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const productionPorts = await import('../runtime/harness/production-capability-ports.js');
const productionAdapters = await import('../runtime/harness/production-capability-adapters.js');
const connectedCatalog = await import('../runtime/harness/connected-goal-catalog.js');
const semanticPorts = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
const innerDispatch = await import('../tools/inner-dispatch.js');
const composioTools = await import('../tools/composio-tools.js');
const composioClient = await import('../integrations/composio/client.js');
const composioSchemas = await import('../tools/composio-schema-cache.js');
const capabilityIndex = await import('../memory/capability-index.js');
const proactivity = await import('../agents/proactivity-policy.js');
const brackets = await import('../runtime/harness/brackets.js');
const workerAdapter = await import('../runtime/harness/claude-agent-worker.js');
const fanoutReduce = await import('../runtime/harness/fanout-reduce.js');
const workerConcurrency = await import('../agents/worker-concurrency.js');
const workManifest = await import('../runtime/harness/work-manifest.js');
const graphShadow = await import('../runtime/graph/turn-graph-shadow.js');
const { RunContext } = await import('@openai/agents');
const originalFetch = globalThis.fetch;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function textMessage(text: string) {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}

function functionCall(callId: string, name: string, args: Record<string, unknown>) {
  return { type: 'function_call', callId, name, arguments: JSON.stringify(args) };
}

async function* streamResponse(
  this: { getResponse: (request: unknown) => Promise<Record<string, unknown>> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = Array.isArray(response.output) ? response.output : [];
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: {
      type: 'finish',
      finishReason: output.some((item) => (item as { type?: string }).type === 'function_call')
        ? 'tool_calls'
        : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: typeof response.responseId === 'string' ? response.responseId : 'fanout-response',
      usage: response.usage ?? { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
    },
  } as never;
}

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as EventEmitter & { run: () => never }).run = () => {
    throw new Error('Runner.run must not own this host acceptance');
  };
  return runner;
}

function projectedToolResult(request: unknown, callId: string): string {
  const input = (request as { input?: unknown })?.input;
  if (!Array.isArray(input)) return '';
  const row = [...input].reverse().find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const value = entry as Record<string, unknown>;
    return value.type === 'function_call_result'
      && (value.callId === callId || value.call_id === callId);
  }) as Record<string, unknown> | undefined;
  if (!row) return '';
  if (typeof row.output === 'string') return row.output;
  if (row.output && typeof row.output === 'object' && typeof (row.output as { text?: unknown }).text === 'string') {
    return String((row.output as { text: string }).text);
  }
  if (Array.isArray(row.output)) {
    return row.output.map((part) => part && typeof part === 'object'
      ? String((part as { text?: unknown }).text ?? '')
      : '').join('');
  }
  return JSON.stringify(row.output ?? '');
}

function packetFromWorkerPrompt(prompt: string): Record<string, unknown> {
  const marker = '\nPacket JSON:\n';
  const offset = prompt.lastIndexOf(marker);
  assert.ok(offset >= 0, 'worker adapter received the real production job packet prompt');
  return JSON.parse(prompt.slice(offset + marker.length)) as Record<string, unknown>;
}

function workerVisibleWire(options: Record<string, unknown>): string {
  // Anthropic's cache-prefix hierarchy is tools, then system, then messages.
  // Keep this synthetic measurement in that production order: putting the
  // stable tool/scope declaration after PROMPT invented a large post-item tail
  // that the provider does not serialize after the user message.
  return [
    'LOCAL_TOOLS', JSON.stringify(options.allowedLocalMcpTools ?? []),
    'NATIVE_SCOPE', JSON.stringify(options.nativeMcpToolScope ?? null),
    'SYSTEM_APPEND', String(options.systemAppend ?? ''),
    'PROMPT', String(options.prompt ?? ''),
  ].join('\n');
}

function commonPrefixBytes(values: readonly string[]): number {
  if (values.length === 0) return 0;
  const buffers = values.map((value) => Buffer.from(value, 'utf8'));
  const ceiling = Math.min(...buffers.map((buffer) => buffer.length));
  let index = 0;
  while (index < ceiling && buffers.every((buffer) => buffer[index] === buffers[0]![index])) index += 1;
  return index;
}

function evidenceFor(item: string): { id: string; digest: string } {
  return { id: item, digest: sha256(`evidence:${item}`).slice(0, 20) };
}

function runWorkerPacket(mode: 'declare' | 'reconcile') {
  return {
    objective: 'Analyze every accepted benchmark item independently and return stable read-only evidence for the parent commit.',
    item: null,
    items: [...ITEMS],
    resolvedTools: 'none needed; the parent aggregate read already supplied the sealed item identifiers',
    externalMcpToolNames: null,
    context: 'Benchmark contract v1. Each item identifier is the complete read-only fixture input. Preserve its exact spelling and produce no external side effect.',
    instructions: mode === 'declare'
      ? 'Read only. Return the exact evidence shape. Do not mutate a provider; one adversarial worker will test that the gateway denies such an attempt.'
      : 'Restart recovery: reuse durable completed evidence exactly. Do not spawn, recompute, or mutate anything.',
    expectedOutput: 'EVIDENCE::<exact item id>::<20 hex digest>, followed by bounded diagnostic detail; ERROR: <reason> on failure.',
    intent: 'analysis',
    model: null,
    workManifest: {
      id: 'competitive-benchmark-100',
      contractVersion: '1',
      phase: 'analyze',
      mode,
      phases: [{ id: 'analyze', label: 'read-only analysis', dependsOn: null }],
      aliases: null,
    },
    expectedWork: null,
  };
}

after(async () => {
  planScope._setApprovedWriteKindsForTests(null);
  modelDiscovery._setModelDiscoverersForTest(null);
  workerAdapter.setClaudeAgentSdkWorkerRunForTest(null);
  fanoutReduce._setShardReducerForTests(null);
  workerConcurrency._resetWorkerConcurrencyForTest();
  innerDispatch._setInnerDispatchToolsForTests(null);
  connectedCatalog.installConnectedRegistryPort(null);
  semanticPorts.installTurnSemanticModelPort(null);
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  productionPorts.clearProductionCapabilityPorts();
  productionAdapters.installProductionTransport(null);
  composioClient.__test__.setConnectedAccountsLoader(null);
  composioClient.__test__.setComposioApiKeyOverride(null);
  composioClient.resetComposioClient();
  composioSchemas.resetToolSchemaCache();
  resetHarnessRuntimeConfig();
  eventlog.closeEventLog();
  globalThis.fetch = originalFetch;
  rmSync(HOME, { recursive: true, force: true });
});

test('GATE: cold host plans once, fans 100 read-only workers, replays exactly once, and commits one ordered batch', {
  timeout: 180_000,
}, async (t) => {
  eventlog.resetEventLog();
  workerConcurrency._resetWorkerConcurrencyForTest();
  resetHarnessRuntimeConfig();
  // Auto mode (2026-09-30): this journey pins the provider write pipeline,
  // not the mode; in Ask mode the first change of a kind waits for the owner.
  proactivity.saveProactivityPolicy({ autoApproveScope: 'yolo' });
  // It pins the pipeline, not the first-time card either (owner 2026-10-06:
  // a connected-app change asks once in both modes): every kind runs as
  // approved, like the unit fixtures that exercise dispatch.
  planScope._setApprovedWriteKindsForTests('all');
  // No live model catalog. A real Anthropic discovery spawns the Claude SDK
  // and, when it finishes first, replaces the presets the worker binding is
  // validated against, so every worker ran on another model (10-10).
  modelDiscovery._setModelDiscoverersForTest({ anthropic: async () => [], openai: async () => [] });

  const configured = await configureHarnessRuntime();
  assert.equal(configured.ok, true, configured.ok ? '' : configured.reason);
  const factory = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  assert.ok(factory, 'runtime installed the real searchable host catalog');
  assert.deepEqual(factory.snapshot(), []);
  assert.deepEqual(capabilityIndex.searchCapabilityOperations(PROMPT), [],
    'no memory/index entry seeds capability or execution authority');
  productionPorts.clearProductionCapabilityPorts();

  connectedCatalog.installConnectedRegistryPort(() => ({
    connectedToolkits: ['competitive'],
    tools: [
      { slug: SOURCE_OPERATION, schema: SOURCE_SCHEMA as unknown as Record<string, unknown> },
      { slug: COMMIT_OPERATION, schema: COMMIT_SCHEMA as unknown as Record<string, unknown> },
      { slug: READBACK_OPERATION, schema: READBACK_SCHEMA as unknown as Record<string, unknown> },
    ],
  }));

  // Complete provider definition rows: input + output + operation version are
  // all required to mint the same full manifest identity the terminal gateway
  // later reopens. A schema-only discovery row is validation data, not
  // executable authority.
  const rawProviderDefinitions = [
    {
      slug: SOURCE_OPERATION,
      name: 'List benchmark records',
      description: 'Read one complete bounded benchmark set containing exactly one hundred fixture records.',
      toolkit: { slug: 'competitive' },
      inputParameters: SOURCE_SCHEMA,
      outputParameters: SOURCE_OUTPUT_SCHEMA,
      version: PROVIDER_OPERATION_VERSION,
    },
    {
      slug: COMMIT_OPERATION,
      name: 'Create benchmark batch',
      description: 'Create one new benchmark batch from one ordered JSON evidence collection.',
      toolkit: { slug: 'competitive' },
      inputParameters: COMMIT_SCHEMA,
      outputParameters: COMMIT_OUTPUT_SCHEMA,
      version: PROVIDER_OPERATION_VERSION,
    },
    {
      slug: READBACK_OPERATION,
      name: 'Get benchmark batch',
      description: 'Read back one exact committed benchmark batch by id including its ordered evidence content.',
      toolkit: { slug: 'competitive' },
      inputParameters: READBACK_SCHEMA,
      outputParameters: READBACK_OUTPUT_SCHEMA,
      version: PROVIDER_OPERATION_VERSION,
    },
  ];

  let discoveryCalls = 0;
  let sourceReads = 0;
  let parentCommits = 0;
  let readbackReads = 0;
  let providerBodies = 0;
  let workerProviderBodies = 0;
  let committedEvidence: Array<{ id: string; digest: string }> = [];
  let noRetryTransportPreparations = 0;
  composioClient.__test__.setComposioApiKeyOverride('fixture-fanout-key');
  composioClient.__test__.setConnectedAccountsLoader(async () => [{
    id: 'conn-competitive',
    status: 'ACTIVE',
    user_id: 'fixture-fanout-user',
    toolkit: { slug: 'competitive' },
  }]);
  const executeProviderBody = async (operation: string, body: {
    arguments?: unknown;
    connected_account_id?: unknown;
    user_id?: unknown;
    version?: unknown;
  }) => {
    providerBodies += 1;
    assert.equal(body.connected_account_id, 'conn-competitive');
    assert.equal(body.user_id, 'fixture-fanout-user');
    assert.equal(body.version, PROVIDER_OPERATION_VERSION);
    const ambient = brackets.harnessRunContextStorage.getStore();
    if (ambient?.workerScope) workerProviderBodies += 1;
    const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
      ? body.arguments as Record<string, unknown>
      : {};
    if (operation.toUpperCase() === SOURCE_OPERATION) {
      sourceReads += 1;
      assert.deepEqual(args, { set_id: 'competitive-100', limit: 100 });
      return {
        successful: true,
        error: null,
        data: { records: ITEMS.map(evidenceFor), total: ITEM_COUNT, has_more: false },
      };
    }
    if (operation.toUpperCase() === COMMIT_OPERATION) {
      parentCommits += 1;
      assert.equal(args.batch_name, 'competitive-benchmark-100');
      committedEvidence = JSON.parse(String(args.evidence_json)) as Array<{ id: string; digest: string }>;
      assert.deepEqual(committedEvidence, ITEMS.map(evidenceFor));
      return {
        successful: true,
        error: null,
        data: {
          id: 'benchmark-batch-100',
          handle: 'competitive://benchmark-batches/benchmark-batch-100',
          receipt: 'competitive-provider-ack-100',
          successful: true,
          batch_id: 'benchmark-batch-100',
          committed: ITEM_COUNT,
        },
      };
    }
    assert.equal(operation.toUpperCase(), READBACK_OPERATION);
    readbackReads += 1;
    assert.deepEqual(args, { batch_id: 'benchmark-batch-100' });
    assert.equal(committedEvidence.length, ITEM_COUNT, 'readback follows the exact successful create');
    return {
      successful: true,
      error: null,
      data: {
        id: 'benchmark-batch-100',
        handle: 'competitive://benchmark-batches/benchmark-batch-100',
        content: committedEvidence,
      },
    };
  };
  composioClient.__test__.setComposioClient({
    client: { baseURL: 'https://backend.composio.dev' },
    getClient: () => ({
      withOptions: (options: { maxRetries?: number }) => {
        noRetryTransportPreparations += 1;
        assert.equal(options.maxRetries, 0, 'the terminal fixture uses the production raw no-retry SDK lane');
        return { tools: { execute: executeProviderBody } };
      },
    }),
    tools: {
      async getRawComposioTools(input: { tools?: string[]; toolkits?: string[] }) {
        discoveryCalls += 1;
        const exact = new Set((input.tools ?? []).map((value) => value.toUpperCase()));
        const toolkits = new Set((input.toolkits ?? []).map((value) => value.toLowerCase()));
        return rawProviderDefinitions.filter((candidate) =>
          (exact.size === 0 || exact.has(candidate.slug))
          && (toolkits.size === 0 || toolkits.has(candidate.toolkit.slug)));
      },
      async execute() {
        assert.fail('the legacy retry-capable SDK wrapper must never own a provider body');
      },
    },
  });
  const currentAccounts = await composioClient.listUsableConnectedToolkits({ requireFresh: true });
  assert.deepEqual(currentAccounts.map((account) => ({
    connectionId: account.connectionId,
    ownerUserId: account.ownerUserId,
    slug: account.slug,
    status: account.status,
  })), [{
    connectionId: 'conn-competitive',
    ownerUserId: 'fixture-fanout-user',
    slug: 'competitive',
    status: 'ACTIVE',
  }], 'the business lane begins from one current addressable account observation');
  const observedAt = Date.now();
  composioSchemas.rememberToolSchema(
    SOURCE_OPERATION,
    SOURCE_SCHEMA,
    observedAt,
    PROVIDER_OPERATION_VERSION,
    SOURCE_OUTPUT_SCHEMA,
  );
  composioSchemas.rememberToolSchema(
    COMMIT_OPERATION,
    COMMIT_SCHEMA,
    observedAt,
    PROVIDER_OPERATION_VERSION,
    COMMIT_OUTPUT_SCHEMA,
  );
  composioSchemas.rememberToolSchema(
    READBACK_OPERATION,
    READBACK_SCHEMA,
    observedAt,
    PROVIDER_OPERATION_VERSION,
    READBACK_OUTPUT_SCHEMA,
  );
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://backend.composio.dev/api/v3/tools?')) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`competitive gate forbids external network: ${url}`);
  }) as typeof fetch;

  let forbiddenDirectCatalogBodies = 0;
  productionAdapters.installProductionTransport(async () => {
    forbiddenDirectCatalogBodies += 1;
    throw new Error('work_call must remain the sole business carrier');
  });
  const gateway = composioTools.getComposioRuntimeTools()
    .find((candidate) => candidate.name === 'composio_execute_tool');
  assert.ok(gateway);
  innerDispatch._setInnerDispatchToolsForTests(new Map([['composio_execute_tool', gateway as never]]));

  let semanticCalls = 0;
  let accountReviews = 0;
  const reviewAccount = currentSourceAccountReviewer({
    sessionId: () => session.id,
    acceptedText: PROMPT,
    toolkit: 'competitive',
    accountIdentity: 'conn-competitive',
    acceptedSource: (sessionId, seq) => eventlog.listEvents(sessionId,
      { sinceSeq: seq - 1, types: ['user_input_received'], limit: 1 })[0],
  });
  semanticPorts.installTurnSemanticModelPort({
    async judgeAccountSelection(call) {
      const verdict = await reviewAccount(call);
      accountReviews += 1;
      return verdict;
    },
    async interpret() { semanticCalls += 1; throw new Error('hidden semantic pass'); },
    async judgeSourceEffect() { semanticCalls += 1; throw new Error('hidden effect judge'); },
    async judgePlanGrounding() { semanticCalls += 1; throw new Error('hidden grounding judge'); },
  });

  const workerWires: string[] = [];
  const workerPrompts: string[] = [];
  const workerItems: string[] = [];
  let workerModelCrossings = 0;
  let legacyWorkerCrossings = 0;
  let workerInflight = 0;
  let peakWorkerInflight = 0;
  let adversarialWriteAttempts = 0;
  let adversarialWriteDenials = 0;
  let shardReducerCalls = 0;
  let shardReducerPromptBytes = 0;
  fanoutReduce._setShardReducerForTests(async (prompt) => {
    shardReducerCalls += 1;
    shardReducerPromptBytes += Buffer.byteLength(prompt, 'utf8');
    const keys = [...prompt.matchAll(/<<<ITEM key="([^"]+)" BEGIN/g)].map((match) => match[1]!);
    return JSON.stringify({ perItem: keys.map((itemKey) => ({ itemKey, gist: `stable gist for ${itemKey}` })) });
  });
  const answerWorker = async (options: Record<string, unknown>) => {
    const rawOptions = options as unknown as Record<string, unknown>;
    assert.equal(rawOptions.workerScope, true, 'the real adapter marks every nested crossing worker-scoped');
    const prompt = String(rawOptions.prompt ?? '');
    const packet = packetFromWorkerPrompt(prompt);
    const item = String(packet.item ?? '');
    const index = ITEMS.indexOf(item);
    assert.ok(index >= 0, `worker packet contains one canonical item: ${item}`);
    workerModelCrossings += 1;
    if (typeof rawOptions.recordedHostWire !== 'string') legacyWorkerCrossings += 1;
    workerItems.push(item);
    workerPrompts.push(prompt);
    workerWires.push(typeof rawOptions.recordedHostWire === 'string' ? rawOptions.recordedHostWire : workerVisibleWire(rawOptions));
    workerInflight += 1;
    peakWorkerInflight = Math.max(peakWorkerInflight, workerInflight);
    try {
      const attemptWrite = adversarialWriteAttempts === 0;
      if (attemptWrite) {
        adversarialWriteAttempts += 1;
        const parent = brackets.harnessRunContextStorage.getStore();
        assert.ok(parent, 'worker adapter retains the parent accepted-source context');
        const blocked = await brackets.harnessRunContextStorage.run({
          ...parent!,
          workerScope: true,
          counter: new brackets.ToolCallsCounter(20),
        }, () => composioTools.dispatchComposioTool(COMMIT_OPERATION, {
          batch_name: 'forbidden-worker-batch',
          evidence_json: '[]',
        }, {
          sessionId: parent!.sessionId,
          connectedAccountId: 'conn-competitive',
        }));
        assert.equal(blocked.ok, false);
        if (!blocked.ok) {
          assert.equal(blocked.reason, 'worker-compose-only');
          assert.match(blocked.message, /No provider dispatch was started/);
        }
        adversarialWriteDenials += 1;
      }
      // Deterministic, intentionally out-of-order completion exercises stable
      // parent reinsertion while keeping the wall-clock test short.
      await new Promise((resolve) => setTimeout(resolve, (ITEM_COUNT - index) % 7));
      const evidence = evidenceFor(item);
      return {
        text: `EVIDENCE::${evidence.id}::${evidence.digest}\n${'x'.repeat(RAW_DETAIL_BYTES)}\nRAW_TAIL_SENTINEL::${item}`,
        toolUses: [],
        model: 'claude-sonnet-4-6',
        sessionId: `worker-${index + 1}`,
        usage: { input_tokens: Math.ceil(Buffer.byteLength(String(rawOptions.recordedHostWire ?? prompt), 'utf8') / 4), output_tokens: 1_100 },
      };
    } finally {
      workerInflight -= 1;
    }
  };
  workerAdapter.setClaudeAgentSdkWorkerRunForTest(options => answerWorker(options as unknown as Record<string, unknown>));
  const { RouterModelProvider } = await import('../runtime/harness/router-model.js');
  t.mock.method(RouterModelProvider.prototype, 'getModel', (modelId?: string) => {
    assert.equal(modelId, 'claude-sonnet-4-6', 'the configured worker model owns the recorded crossing');
    return {
      async getResponse(request: any) {
        const user = request.input.find((entry: any) => entry.role === 'user');
        const prompt = typeof user?.content === 'string' ? user.content
          : user?.content?.map((part: any) => part.text ?? '').join('');
        assert.equal(typeof prompt, 'string');
        const result = await answerWorker({ prompt,
          workerScope: brackets.harnessRunContextStorage.getStore()?.workerScope,
          recordedHostWire: ['TOOLS', JSON.stringify(request.tools ?? []),
            'SYSTEM', String(request.systemInstructions ?? ''), 'INPUT', JSON.stringify(request.input)].join('\n'),
        });
        return { usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens,
          totalTokens: result.usage.input_tokens + result.usage.output_tokens, requests: 1 },
          output: [textMessage(result.text)], responseId: result.sessionId };
      },
      getStreamedResponse: streamResponse,
    };
  });

  const session = eventlog.createSession({
    id: 'competitive-run-worker-100',
    kind: 'chat',
    userId: 'competitive-user',
  });
  const parentModelRequests: Array<{ step: number; bytes: number; tools: string[] }> = [];
  let parentStep = 0;
  let firstFanoutProjection = '';
  let replayFanoutProjection = '';
  let middleRecallOffset = 0;
  let middleReadbackExact = false;
  let eventlogRestarted = false;
  let restartReceiptComplete = false;
  let restartReceiptNoReplay = false;
  const model = {
    async getResponse(rawRequest: unknown) {
      parentStep += 1;
      const request = (rawRequest ?? {}) as { tools?: Array<{ name?: string }> };
      const tools = (request.tools ?? []).map((entry) => String(entry.name ?? '')).filter(Boolean);
      const serialized = JSON.stringify(rawRequest ?? {});
      parentModelRequests.push({
        step: parentStep,
        bytes: Buffer.byteLength(serialized, 'utf8'),
        tools,
      });
      let output: unknown[];
      if (parentStep === 1) {
        assert.match(serialized, /benchmark set of 100 fixture records/);
        assert.ok(tools.includes('tool_search'));
        assert.equal(tools.includes('plan_task'), false,
          'the cold empty-catalog surface discovers before it can plan against exact capabilities');
        output = [functionCall('discover-benchmark-capabilities', 'tool_search', {
          query: 'read one complete benchmark record set, create one new ordered benchmark batch from JSON evidence, and verify it by exact id readback',
          role_key: null,
          limit: 8,
        })];
      } else if (parentStep === 2) {
        assert.match(serialized, new RegExp(SOURCE_OPERATION));
        assert.match(serialized, new RegExp(COMMIT_OPERATION));
        assert.match(serialized, new RegExp(READBACK_OPERATION));
        assert.ok(tools.includes('plan_task'),
          'exact discovery opens the production planning surface on the next request');
        output = [functionCall('plan-benchmark-fanout', 'plan_task', {
          preamble: PREAMBLE,
          draft: {
            criteria: [
              'Exactly one hundred accepted fixture records are analyzed.',
              'One new ordered batch contains one stable evidence row per accepted fixture record.',
            ],
            cardinality: { count: ITEM_COUNT, fields: ['id', 'digest'] },
            destination: { posture: 'create_new', family: 'competitive', handleRequired: true },
            topology: {
              version: 1,
              operations: [
                {
                  id: SOURCE_REQUIREMENT,
                  effect: 'read',
                  coverage: 'complete_set',
                  dependsOn: [],
                  dataFrom: [],
                  cardinality: { kind: 'once' },
                },
                {
                  id: COMMIT_REQUIREMENT,
                  effect: 'external_write',
                  coverage: null,
                  dependsOn: [SOURCE_REQUIREMENT],
                  dataFrom: [SOURCE_REQUIREMENT],
                  cardinality: { kind: 'once' },
                },
                {
                  id: READBACK_REQUIREMENT,
                  effect: 'read',
                  coverage: 'single',
                  dependsOn: [COMMIT_REQUIREMENT],
                  dataFrom: [COMMIT_REQUIREMENT],
                  cardinality: { kind: 'once' },
                },
              ],
              universes: [],
            },
            bindings: [
              {
                operationId: SOURCE_REQUIREMENT,
                role: 'source',
                capabilityRef: `cap:resolved:${SOURCE_OPERATION.toLowerCase()}`,
                evidence: ['records'],
              },
              {
                operationId: COMMIT_REQUIREMENT,
                role: 'destination',
                capabilityRef: `cap:resolved:${COMMIT_OPERATION.toLowerCase()}`,
                evidence: ['receipt'],
              },
              {
                operationId: READBACK_REQUIREMENT,
                role: 'readback',
                capabilityRef: `cap:resolved:${READBACK_OPERATION.toLowerCase()}`,
                evidence: ['readback'],
              },
            ],
            deliverables: [{ id: 'benchmark-batch', kind: 'competitive' }],
            evidenceRequirements: ['records', 'worker_evidence', 'receipt', 'readback'],
          },
        })];
      } else if (parentStep === 3) {
        // Schema visibility is cache-stable; execution authority must come
        // from the exact durable plan, not from a tool disappearing.
        const plan = JSON.parse(projectedToolResult(rawRequest, 'plan-benchmark-fanout')) as {
          ok: boolean; acceptedTaskId: string; contractId: string;
          requirements: Array<{ id: string }>;
        };
        assert.equal(plan.ok, true, 'the plan call must succeed before worker execution');
        assert.deepEqual(plan.requirements.map((entry) => entry.id).sort(),
          [SOURCE_REQUIREMENT, COMMIT_REQUIREMENT, READBACK_REQUIREMENT].sort());
        const authority = eventlog.openEventLog().prepare(
          'SELECT work_contract_id, source_user_seq FROM accepted_task_authority WHERE accepted_task_id = ? AND session_id = ?',
        ).get(plan.acceptedTaskId, session.id) as { work_contract_id: string; source_user_seq: number } | undefined;
        const accepted = eventlog.listEvents(session.id, { types: ['user_input_received'] }).find(row => row.data.text === PROMPT);
        assert.equal(authority?.source_user_seq, accepted?.seq);
        assert.ok(authority && authority.work_contract_id === plan.contractId,
          'the accepted parent source owns the frozen plan contract before any worker or write');
        assert.ok(tools.includes('work_call'));
        assert.ok(tools.includes('run_worker'));
        output = [functionCall('read-benchmark-set', 'work_call', {
          requirement_id: SOURCE_REQUIREMENT,
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: SOURCE_OPERATION,
            arguments: JSON.stringify({ set_id: 'competitive-100', limit: ITEM_COUNT }),
            connected_account_id: 'conn-competitive',
          }),
        })];
      } else if (parentStep === 4) {
        const read = JSON.parse(projectedToolResult(rawRequest, 'read-benchmark-set'));
        assert.equal(read.data.total, ITEM_COUNT);
        assert.equal(read.data.has_more, false);
        assert.equal(read.__clementine?.truncated, true);
        assert.equal(read.__clementine.recovery.tool_output_query.call_id, 'read-benchmark-set');
        assert.ok(tools.includes('tool_output_query'), 'the retained-result reader is reachable without discovery');
        output = [functionCall('read-benchmark-identifiers', 'tool_output_query', {
          call_id: 'read-benchmark-set', fields: ['id'], limit: ITEM_COUNT,
        })];
      } else if (parentStep === 5) {
        const identifiers = projectedToolResult(rawRequest, 'read-benchmark-identifiers');
        assert.deepEqual([...identifiers.matchAll(/"id":\s*"([^"\n]+)"/g)].map(match => match[1]), ITEMS,
          'the model must see all exact item identifiers through the retained reader before fan-out');
        output = [functionCall('fanout-declare', 'run_worker', runWorkerPacket('declare'))];
      } else if (parentStep === 6) {
        firstFanoutProjection = projectedToolResult(rawRequest, 'fanout-declare');
        assert.ok(firstFanoutProjection, 'the first 100-item result rejoined the parent model');
        // Close and reopen the durable store between calls. The next packet is
        // intentionally byte-different; logical manifest identity, not packet
        // identity or in-memory state, must suppress all 100 re-executions.
        eventlog.closeEventLog();
        eventlog.openEventLog();
        eventlogRestarted = true;
        output = [functionCall('fanout-reconcile-after-restart', 'run_worker', runWorkerPacket('reconcile'))];
      } else if (parentStep === 7) {
        replayFanoutProjection = projectedToolResult(rawRequest, 'fanout-reconcile-after-restart');
        // Keep large result bodies out of assertion diagnostics. Receipt gaps
        // belong in the compact aggregate RED below, alongside the crossing
        // and durable-output counts that explain them.
        restartReceiptComplete = /Durable receipt: all 100\/100 requested items were already complete/.test(replayFanoutProjection);
        restartReceiptNoReplay = /No worker ran and no action was repeated/.test(replayFanoutProjection);
        const count = firstFanoutProjection.match(/\[digest: run_worker returned ([\d,]+) chars/);
        assert.ok(count, 'a bounded parent result must disclose its full size and recovery route');
        assert.match(firstFanoutProjection, /recall_tool_result/);
        assert.ok(tools.includes('recall_tool_result'));
        middleRecallOffset = Math.floor(Number(count[1]!.replaceAll(',', '')) / 2);
        output = [functionCall('read-fanout-middle-after-restart', 'recall_tool_result', {
          call_id: 'fanout-declare', offset: middleRecallOffset, max_chars: 4000,
        })];
      } else if (parentStep === 8) {
        const recovered = projectedToolResult(rawRequest, 'read-fanout-middle-after-restart');
        const retained = eventlog.getToolOutput(session.id, 'fanout-declare');
        assert.ok(retained);
        const exactMiddle = retained.output.slice(middleRecallOffset, middleRecallOffset + 4000);
        middleReadbackExact = exactMiddle.length === 4000 && recovered.includes(exactMiddle);
        assert.equal(middleReadbackExact, true, 'the actual reader must redeem omitted middle bytes exactly after reopen');
        output = [functionCall('commit-one-parent-batch', 'work_call', {
          requirement_id: COMMIT_REQUIREMENT,
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: COMMIT_OPERATION,
            arguments: JSON.stringify({
              batch_name: 'competitive-benchmark-100',
              evidence_json: JSON.stringify(ITEMS.map(evidenceFor)),
            }),
            connected_account_id: 'conn-competitive',
          }),
        })];
      } else if (parentStep === 9) {
        const commitProjection = projectedToolResult(rawRequest, 'commit-one-parent-batch');
        assert.match(commitProjection, /benchmark-batch-100/);
        output = [functionCall('verify-parent-batch', 'work_call', {
          requirement_id: READBACK_REQUIREMENT,
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: READBACK_OPERATION,
            arguments: JSON.stringify({ batch_id: 'benchmark-batch-100' }),
            connected_account_id: 'conn-competitive',
          }),
        })];
      } else {
        assert.match(projectedToolResult(rawRequest, 'verify-parent-batch'), /benchmark-batch-100/);
        output = [textMessage(JSON.stringify({
          summary: 'Analyzed 100/100 fixture records, committed one ordered benchmark batch, and read back benchmark-batch-100 with 100 ordered rows.',
          reply: 'Analyzed 100/100 fixture records, committed one ordered benchmark batch, and read back benchmark-batch-100 with 100 ordered rows.',
          done: true,
          nextAction: 'completed',
          reason: null,
        }))];
      }
      return {
        usage: { inputTokens: Math.ceil(Buffer.byteLength(serialized, 'utf8') / 4), outputTokens: 1, totalTokens: 2, requests: 1 },
        output,
        responseId: `parent-response-${parentStep}`,
      };
    },
    getStreamedResponse: streamResponse,
  };

  const deliveredPreambles: string[] = [];
  const result = await runConversation({
    sessionId: session.id,
    input: PROMPT,
    turnEngine: 'host_v1',
    maxSteps: 1,
    maxTurns: 12,
    toolCallsPerTurn: 1_000,
    judgeCompletion: false,
    makeRunner: throwingRunner as never,
    buildAgent: async (identity) => buildOrchestratorAgent({
      ...identity,
      userInput: PROMPT,
      model: model as never,
    }),
    onConversationPreamble: async (request) => {
      deliveredPreambles.push(request.text);
      return {
        status: 'delivered' as const,
        receipt: {
          version: 1 as const,
          deliveryKey: request.deliveryKey,
          eventId: request.eventId,
          eventDigest: request.eventDigest,
          surface: 'channel_message' as const,
          target: `competitive-discord-fixture:${request.eventId}`,
        },
      };
    },
  });

  assert.ok(accountReviews > 0, 'the current accepted source/account is reviewed by its real semantic model-port boundary');
  const hostContinuedAfterPlan = result.status === 'completed';
  const hostDb = eventlog.openEventLog();
  const hostReachedWorkerJourney = workerModelCrossings === ITEM_COUNT
    && Boolean(firstFanoutProjection)
    && Boolean(replayFanoutProjection)
    && eventlogRestarted;

  let measurementSessionId = session.id;
  if (!hostContinuedAfterPlan && !hostReachedWorkerJourney) {
    // Keep measuring the worker architecture when the current fresh host
    // generation terminates at the post-plan authority handoff. This is not an
    // authority shortcut for the host request: the final aggregate gate still
    // records that end-to-end RED. The worker measurement owns a new accepted
    // source and uses the production run_worker tool itself.
    const workerSession = eventlog.createSession({
      id: 'competitive-run-worker-100-measurement',
      kind: 'chat',
      userId: 'competitive-user',
    });
    measurementSessionId = workerSession.id;
    const workerSource = eventlog.appendEvent({
      sessionId: workerSession.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Analyze the exact 100 accepted benchmark fixture ids read-only and return one stable evidence row for each id.' },
    });
    assert.ok(graphShadow.recordTurnGraphShadow({
      identity: {
        sessionId: workerSession.id,
        sourceUserSeq: workerSource.seq,
        turn: workerSource.turn,
      },
    }));

    const parentRead = await brackets.harnessRunContextStorage.run({
      sessionId: workerSession.id,
      sourceUserSeq: workerSource.seq,
      turn: workerSource.turn,
      counter: new brackets.ToolCallsCounter(50),
    }, () => composioTools.dispatchComposioTool(SOURCE_OPERATION, {
      set_id: 'competitive-100',
      limit: ITEM_COUNT,
    }, {
      sessionId: workerSession.id,
      connectedAccountId: 'conn-competitive',
    }));
    assert.equal(parentRead.ok, true, JSON.stringify(parentRead));

    const workerAgent = await buildOrchestratorAgent({
      sessionId: workerSession.id,
    });
    const runWorker = (workerAgent.tools ?? []).find((tool) => tool.name === 'run_worker') as {
      invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
    } | undefined;
    assert.ok(runWorker, 'production orchestrator exposes run_worker on the admitted measurement source');
    const invokeWorker = async (callId: string, packet: ReturnType<typeof runWorkerPacket>): Promise<string> => {
      const encoded = JSON.stringify(packet);
      return String(await brackets.withHarnessRunContext({
        sessionId: workerSession.id,
        sourceUserSeq: workerSource.seq,
        turn: workerSource.turn,
        // Mirror the real parent lane: fan-out reduction reads the routed
        // parent's live window from this context when choosing its threshold.
        routedModelId: 'claude-opus-4-8',
        counter: new brackets.ToolCallsCounter(1_000),
        behaviorScopeId: `${workerSession.id}::${callId}`,
      }, () => runWorker!.invoke(
        new RunContext({ sessionId: workerSession.id, sourceUserSeq: workerSource.seq }),
        encoded,
        { toolCall: { name: 'run_worker', callId, arguments: encoded } },
      )));
    };

    firstFanoutProjection = await invokeWorker('fanout-declare', runWorkerPacket('declare'));
    eventlog.closeEventLog();
    eventlog.openEventLog();
    eventlogRestarted = true;
    replayFanoutProjection = await invokeWorker(
      'fanout-reconcile-after-restart',
      runWorkerPacket('reconcile'),
    );
    restartReceiptComplete = /Durable receipt: all 100\/100 requested items were already complete/.test(replayFanoutProjection);
    restartReceiptNoReplay = /No worker ran and no action was repeated/.test(replayFanoutProjection);

    const parentCommit = await brackets.harnessRunContextStorage.run({
      sessionId: workerSession.id,
      sourceUserSeq: workerSource.seq,
      turn: workerSource.turn,
      counter: new brackets.ToolCallsCounter(50),
      certifiedBatch: { batchId: 'competitive-parent-batch', payloadHash: sha256(JSON.stringify(ITEMS.map(evidenceFor))) },
    }, () => composioTools.dispatchComposioTool(COMMIT_OPERATION, {
      batch_name: 'competitive-benchmark-100',
      evidence_json: JSON.stringify(ITEMS.map(evidenceFor)),
    }, {
      sessionId: workerSession.id,
      connectedAccountId: 'conn-competitive',
    }));
    assert.equal(parentCommit.ok, true, JSON.stringify(parentCommit));
  }

  await fanoutReduce._drainFanoutReduces(measurementSessionId);
  assert.equal(eventlogRestarted, true);

  const prefixBytes = commonPrefixBytes(workerWires);
  const totalWorkerWireBytes = workerWires.reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0);
  const cacheablePrefixBytes = prefixBytes * workerWires.length;
  const perItemWireBytes = totalWorkerWireBytes - cacheablePrefixBytes;
  const commonPrefixRatio = totalWorkerWireBytes === 0 ? 0 : cacheablePrefixBytes / totalWorkerWireBytes;
  const averageWorkerWireBytes = Math.round(totalWorkerWireBytes / Math.max(1, workerWires.length));
  // Inspect the decoded prompt rather than searching escaped JSON wire bytes:
  // missing shared keys must never make this ordering assertion pass vacuously.
  const itemPayloadAppendedLast = workerPrompts.length === ITEM_COUNT && workerPrompts.every((prompt, index) => {
    const marker = 'Packet JSON:\n';
    const markerOffset = prompt.lastIndexOf(marker);
    assert.ok(markerOffset >= 0, 'the host model receives the canonical worker packet');
    const packetJson = prompt.slice(markerOffset + marker.length);
    const packet = JSON.parse(packetJson) as Record<string, unknown>;
    const keys = Object.keys(packet);
    return ['resolvedTools', 'context', 'instructions', 'expectedOutput', 'workManifest']
      .every(key => keys.includes(key)) && keys.at(-1) === 'item' && packet.item === workerItems[index];
  });
  // Verify complete batch coverage on the retained envelope, and separately
  // bound what the parent actually sees. A clipped view is not 96 raw bodies.
  const retainedFanout = eventlog.getToolOutput(session.id, 'fanout-declare')?.output ?? firstFanoutProjection;
  const parentHandleCount = (retainedFanout.match(/full output parked:/g) ?? []).length;
  const visibleVerbatimResults = (firstFanoutProjection.match(new RegExp('x'.repeat(RAW_DETAIL_BYTES), 'g')) ?? []).length;
  // A tail-aware digest deliberately carries RAW_TAIL_SENTINEL too, so the
  // sentinel no longer distinguishes verbatim results from compact envelopes.
  // The durable reader handle is the production protocol discriminator.
  const parentVerbatimResultCount = ITEM_COUNT - parentHandleCount;
  const parentDigestThreshold = brackets.harnessRunContextStorage.run({
    sessionId: measurementSessionId,
    counter: new brackets.ToolCallsCounter(1),
    routedModelId: 'claude-opus-4-8',
  }, () => fanoutReduce.fanoutDigestThreshold());
  const parentFanoutBytes = Buffer.byteLength(firstFanoutProjection, 'utf8');
  const replayFanoutBytes = Buffer.byteLength(replayFanoutProjection, 'utf8');
  const rawWorkerOutputBytes = workerPrompts.length === 0
    ? 0
    : ITEMS.reduce((sum, item) => {
        const evidence = evidenceFor(item);
        return sum + Buffer.byteLength(
          `EVIDENCE::${evidence.id}::${evidence.digest}\n${'x'.repeat(RAW_DETAIL_BYTES)}\nRAW_TAIL_SENTINEL::${item}`,
          'utf8',
        );
      }, 0);
  const db = eventlog.openEventLog();
  const durableRaw = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(content_bytes), 0) AS bytes
      FROM tool_outputs
     WHERE session_id = ? AND tool = 'run_worker'
       AND output_full LIKE '%RAW_TAIL_SENTINEL::%'
  `).get(measurementSessionId) as { count: number; bytes: number };
  const workerResults = eventlog.listEvents(measurementSessionId, { types: ['worker_result'] });
  const workerStarts = eventlog.listEvents(measurementSessionId, { types: ['worker_started'] });
  const manifest = workManifest.summarizeWorkManifest(measurementSessionId, 'competitive-benchmark-100');
  const succeededItems = new Set((manifest?.items ?? [])
    .filter((item) => item.phases.analyze?.status === 'succeeded')
    .map((item) => item.id));
  const parentModelBytes = parentModelRequests.reduce((sum, request) => sum + request.bytes, 0);
  const totalModelVisibleBytes = parentModelBytes + totalWorkerWireBytes + shardReducerPromptBytes;
  const estimatedVisibleTokens = Math.ceil(totalModelVisibleBytes / 4);
  const orderedHeaders = ITEMS.map((item) => retainedFanout.indexOf(`--- item: ${item} ---`));
  const stableParentOrder = orderedHeaders.every((offset, index) =>
    offset >= 0 && (index === 0 || offset > orderedHeaders[index - 1]!));
  const events = eventlog.listEvents(measurementSessionId);
  const writeBlocks = events.filter((event) =>
    event.type === 'guardrail_tripped' && event.data?.reason === 'worker-compose-only');
  const logicalCalls = db.prepare(`
    SELECT logical_tool_call_id, tool_name, state
      FROM logical_tool_calls
     WHERE session_id = ?
     ORDER BY rowid
  `).all(session.id) as Array<{ logical_tool_call_id: string; tool_name: string; state: string }>;
  const hostCompletion = eventlog.listEvents(session.id, { types: ['conversation_completed'] }).at(-1);
  const hostTerminalBlockedReason = typeof hostCompletion?.data.blockedReason === 'string'
    ? hostCompletion.data.blockedReason
    : null;
  const metrics = {
    itemCount: ITEM_COUNT,
    hostWorkerFailures: eventlog.listEvents(session.id, { types: ['worker_result'] }).filter(row => row.data.ok === false).slice(0, 2).map(row => row.data),
    hostStatusAfterPlan: result.status,
    hostErrorAfterPlan: result.error ?? null,
    hostTerminalBlockedReason,
    hostContinuedAfterPlan,
    hostReachedWorkerJourney,
    completion: succeededItems.size,
    parentSteps: parentModelRequests.length,
    oneDiscoveryCall: logicalCalls.filter((row) => row.tool_name === 'tool_search').length,
    onePlanCall: logicalCalls.filter((row) => row.tool_name === 'plan_task').length,
    sourceReads,
    parentCommits,
    readbackReads,
    providerBodies,
    noRetryTransportPreparations,
    workerProviderBodies,
    workerModelCrossings,
    legacyWorkerCrossings,
    workerStarts: workerStarts.length,
    workerResultEvents: workerResults.length,
    peakWorkerInflight,
    restartReplaySuppressedCrossings: workerModelCrossings === ITEM_COUNT,
    restartReceiptComplete,
    restartReceiptNoReplay,
    durableRawOutputCountAfterRestart: durableRaw.count,
    durableRawOutputBytesAfterRestart: durableRaw.bytes,
    cachePrefixBreakOffset: prefixBytes,
    itemPayloadAppendedLast,
    commonPrefixRatio: Number(commonPrefixRatio.toFixed(6)),
    cacheableCommonPrefixBytes: cacheablePrefixBytes,
    perItemWireBytes,
    averageWorkerWireBytes,
    totalWorkerWireBytes,
    parentFanoutBytes,
    retainedFanoutBytes: Buffer.byteLength(retainedFanout),
    visibleVerbatimResults,
    middleReadbackExact,
    replayFanoutBytes,
    rawWorkerOutputBytes,
    parentVerbatimResultCount,
    parentVerbatimWithinThreshold: parentVerbatimResultCount <= parentDigestThreshold,
    parentHandleCount,
    parentDigestThreshold,
    shardReducerCalls,
    shardReducerPromptBytes,
    parentModelBytes,
    totalModelVisibleBytes,
    estimatedVisibleTokens,
    stableParentOrder,
    adversarialWriteAttempts,
    adversarialWriteDenials,
    workerComposeOnlyEvents: writeBlocks.length,
    discoveryProviderListings: discoveryCalls,
    hiddenSemanticCalls: semanticCalls,
    currentSourceAccountReviews: accountReviews,
    forbiddenDirectCatalogBodies,
    preambles: deliveredPreambles.length,
  };

  // One aggregate assertion preserves every exact current metric in the RED.
  // The expected side is the competitive contract, not a softened baseline.
  assert.deepEqual({
    oneDiscoveryCall: metrics.oneDiscoveryCall,
    onePlanCall: metrics.onePlanCall,
    hostContinuedAfterPlan,
    sourceReads,
    readbackReads,
    completion: metrics.completion,
    workerModelCrossings,
    legacyWorkerCrossings,
    workerStarts: metrics.workerStarts,
    restartReplaySuppressedCrossings: metrics.restartReplaySuppressedCrossings,
    restartReceiptComplete,
    restartReceiptNoReplay,
    durableRawOutputCountAfterRestart: metrics.durableRawOutputCountAfterRestart,
    boundedPool: peakWorkerInflight >= 2 && peakWorkerInflight <= MAX_WORKER_WIDTH,
    stableParentOrder,
    middleReadbackExact,
    visibleBodiesBounded: visibleVerbatimResults <= parentDigestThreshold,
    projectedParentIsSmaller: parentFanoutBytes < Buffer.byteLength(retainedFanout),
    itemPayloadAppendedLast,
    cacheablePrefixAtLeast85Percent: commonPrefixRatio >= MIN_CACHEABLE_PREFIX_RATIO,
    parentVerbatimWithinThreshold: metrics.parentVerbatimWithinThreshold,
    parentHasCompactHandlesForRemainder: parentHandleCount >= ITEM_COUNT - parentDigestThreshold,
    adversarialWriteAttempts,
    adversarialWriteDenials,
    workerProviderBodies,
    parentCommits,
    providerBodies,
    noRetryTransportPreparations,
    committedEvidenceCount: committedEvidence.length,
    preambles: deliveredPreambles.length,
    hiddenSemanticCalls: semanticCalls,
    forbiddenDirectCatalogBodies,
  }, {
    oneDiscoveryCall: 1,
    onePlanCall: 1,
    hostContinuedAfterPlan: true,
    sourceReads: 1,
    readbackReads: 1,
    completion: ITEM_COUNT,
    workerModelCrossings: ITEM_COUNT,
    legacyWorkerCrossings: 0,
    workerStarts: ITEM_COUNT,
    restartReplaySuppressedCrossings: true,
    restartReceiptComplete: true,
    restartReceiptNoReplay: true,
    // 100 item bodies plus the initial and restart aggregate projections. The
    // replay aliases existing item bytes rather than parking another 100.
    durableRawOutputCountAfterRestart: ITEM_COUNT + 2,
    boundedPool: true,
    stableParentOrder: true,
    middleReadbackExact: true,
    visibleBodiesBounded: true,
    projectedParentIsSmaller: true,
    itemPayloadAppendedLast: true,
    cacheablePrefixAtLeast85Percent: true,
    parentVerbatimWithinThreshold: true,
    parentHasCompactHandlesForRemainder: true,
    adversarialWriteAttempts: 1,
    adversarialWriteDenials: 1,
    workerProviderBodies: 0,
    parentCommits: 1,
    providerBodies: 3,
    noRetryTransportPreparations: 3,
    committedEvidenceCount: ITEM_COUNT,
    preambles: 1,
    hiddenSemanticCalls: 0,
    forbiddenDirectCatalogBodies: 0,
  }, `RUN_WORKER_100_COMPETITIVE_RED ${JSON.stringify(metrics)}`);
});
