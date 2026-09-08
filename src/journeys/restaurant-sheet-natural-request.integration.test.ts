/**
 * Run: node scripts/run-tests-isolated.mjs src/journeys/restaurant-sheet-natural-request.integration.test.ts
 *
 * Exact regression for the 2026-08-23 Discord failure.  This is intentionally
 * one exported-channel -> bridge -> runConversation -> production-host journey,
 * not a collection of unit-shaped substitutes.  The only injected boundaries
 * are the model wire and connected provider wires; neither is allowed to mint
 * accepted-source, graph, expected-work, approval, or replay authority.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { currentSourceAccountReviewer } from './gauntlet-sheet-account-review.fixture-support.js';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-natural-restaurant-sheet-'));
const PROMPT = 'Find me 10 restaurants in Santa Clarita and put them in a new Google Sheet';
const SHEET_ID = 'fixture-santa-clarita-restaurants';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
const SUCCESS = `Created a new Google Sheet with 10 Santa Clarita restaurants: ${SHEET_URL}`;
const PREAMBLE = 'I’ll find ten Santa Clarita restaurants and put the results into one new Google Sheet.';
const BOUNDED_LOCATIONS = Object.freeze([
  'Canyon Country', 'Newhall', 'Saugus', 'Valencia',
  'Stevenson Ranch', 'Castaic', 'Sand Canyon', 'Placerita Canyon',
  'Northbridge', 'Northpark', 'Old Orchard', 'Vista Canyon',
  'Fair Oaks Ranch', 'Westridge', 'Tesoro del Valle', 'Bridgeport',
  'Copper Hill', 'Circle J Ranch', 'Happy Valley', 'Five Knolls',
  'Valencia Summit', 'Mountain View', 'River Village', 'Val Verde',
] as const);
const BOUNDED_PROMPT = [
  'Collect exactly 20 restaurant records from each of these Santa Clarita areas and summarize the complete collection:',
  ...BOUNDED_LOCATIONS.map((location) => `- ${location}`),
].join('\n');
const BOUNDED_SUCCESS = `Collected 480 restaurant records across ${BOUNDED_LOCATIONS.length} Santa Clarita areas.`;

const RESTAURANT_OPERATION = 'RESTAURANTS_SEARCH';
const SHEET_OPERATION = 'GOOGLESHEETS_SHEET_FROM_JSON';
const PLAN_CONTROL = 'plan_task';
const READ_REQUIREMENT = 'read_source';
const WRITE_REQUIREMENT = 'write_once';

const ROWS = Object.freeze([
  { name: 'Piccola Trattoria', category: 'Italian', rating: 4.8, address: '18302 Sierra Hwy, Santa Clarita, CA' },
  { name: 'Newhall Refinery', category: 'American', rating: 4.7, address: '24258 Main St, Santa Clarita, CA' },
  { name: 'Le Chene', category: 'French', rating: 4.7, address: '12625 Sierra Hwy, Santa Clarita, CA' },
  { name: 'Smokehouse on Main', category: 'Barbecue', rating: 4.6, address: '24255 Main St, Santa Clarita, CA' },
  { name: 'Gyromania', category: 'Greek', rating: 4.6, address: '20655 Soledad Canyon Rd, Santa Clarita, CA' },
  { name: 'The Old Town Junction', category: 'American', rating: 4.6, address: '24275 Main St, Santa Clarita, CA' },
  { name: 'Sabor Cocina Mexicana', category: 'Mexican', rating: 4.5, address: '23953 Newhall Ranch Rd, Santa Clarita, CA' },
  { name: 'Marston\'s', category: 'Breakfast', rating: 4.5, address: '24011 Newhall Ranch Rd, Santa Clarita, CA' },
  { name: 'La Cocina Bar & Grill', category: 'Mexican', rating: 4.5, address: '19915 Golden Valley Rd, Santa Clarita, CA' },
  { name: 'Wolf Creek Restaurant', category: 'American', rating: 4.4, address: '27746 McBean Pkwy, Santa Clarita, CA' },
] as const);

const RESTAURANT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['location', 'category', 'limit'],
  properties: {
    location: { type: 'string' },
    category: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 20 },
  },
});

const SHEET_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['title', 'sheet_name', 'sheet_json'],
  properties: {
    title: { type: 'string' },
    sheet_name: { type: 'string' },
    sheet_json: { type: 'string' },
  },
});

const RESTAURANT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['records', 'total', 'has_more'],
  properties: {
    records: { type: 'array', items: { type: 'object' } },
    total: { type: 'integer', minimum: 0 },
    has_more: { type: 'boolean' },
  },
});

const SHEET_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['successful', 'spreadsheetId', 'spreadsheetUrl'],
  properties: {
    successful: { type: 'boolean' },
    spreadsheetId: { type: 'string' },
    spreadsheetUrl: { type: 'string' },
  },
});

process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.AUTH_MODE = 'codex_oauth';
process.env.MODEL_ROUTING_MODE = 'off';
process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.5';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_TOOL_JIT = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_COMPLETION_REVIEW = 'on';
process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
  { role: 'judge', modelId: 'gpt-5.5', scope: 'durable', source: 'settings' },
]);
process.env.CLEMMY_BRAIN_FALLOVER = 'off';
process.env.CLEMMY_AUTH_FALLOVER = 'off';
process.env.CLEMMY_PROACTIVE_REPORT_DEFER = 'off';
process.env.CLEMMY_PLAN_FIRST = 'off';
process.env.CLEMMY_DYNAMIC_REASONING = 'off';
process.env.CLEMMY_EVAL_AUTO_PROMOTE = 'off';
process.env.COMPOSIO_API_KEY = 'fixture-composio-key';
process.env.COMPOSIO_USER_ID = 'fixture-user';

mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-natural-restaurant-sheet\n', 'utf8');
writeFileSync(path.join(HOME, 'state', 'auth.json'), JSON.stringify({
  source: 'native',
  codexOauth: {
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
    lastRefresh: new Date().toISOString(),
  },
}), 'utf8');

const { Usage } = await import('@openai/agents');
const { CodexModelProvider } = await import('../runtime/harness/codex-model.js');
const discord = await import('../channels/discord-harness.js');
const bridge = await import('../runtime/harness/respond-bridge.js');
const { configureHarnessRuntime, resetHarnessRuntimeConfig } = await import('../runtime/harness/codex-client.js');
const { buildOrchestratorAgent } = await import('../agents/orchestrator.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const capabilityCatalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const capabilityManifests = await import('../runtime/harness/capability-manifest.js');
const productionPorts = await import('../runtime/harness/production-capability-ports.js');
const productionAdapters = await import('../runtime/harness/production-capability-adapters.js');
const connectedCatalog = await import('../runtime/harness/connected-goal-catalog.js');
const semanticPorts = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
const innerDispatch = await import('../tools/inner-dispatch.js');
const composioTools = await import('../tools/composio-tools.js');
const composioClient = await import('../integrations/composio/client.js');
const capabilityIndex = await import('../memory/capability-index.js');
const capabilityCandidates = await import('../runtime/read-path/capability-candidates.js');
const proactivity = await import('../agents/proactivity-policy.js');
const documentedCreates = await import('../runtime/harness/documented-create-result-evidence.js');
const terminalLearning = await import('../memory/semantic-learning-worker.js');
const learningIntake = await import('../memory/learning-intake.js');
const sourceMap = await import('../memory/source-map.js');
const reflection = await import('../memory/reflection.js');
const memoryDb = await import('../memory/db.js');
const {
  comparePromptCacheRequests,
  observePromptCacheRequest,
} = await import('../runtime/harness/prompt-cache-observation.js');

let learningModelCalls = 0;
reflection._testOnly_setReflectionExtractor(async () => {
  learningModelCalls += 1;
  return { facts: [], entities: [], pointers: [], resources: [], relationships: [] } as never;
});

const originalFetch = globalThis.fetch;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
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
  const toolCalls = output.some((item) => (item as { type?: string }).type === 'function_call');
  yield { type: 'response_started' } as never;
  yield { type: 'model', event: { type: 'finish', finishReason: toolCalls ? 'tool_calls' : 'stop' } } as never;
  yield {
    type: 'response_done',
    response: {
      id: typeof response.responseId === 'string' ? response.responseId : 'fixture-response',
      usage: response.usage ?? { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
      ...(response.providerData && typeof response.providerData === 'object'
        ? { providerData: response.providerData }
        : {}),
    },
  } as never;
}

interface TraceEntry {
  kind: string;
  detail?: string;
}

function recordingTransport(trace: TraceEntry[]) {
  const initial: string[] = [];
  const edits: string[] = [];
  const errors: string[] = [];
  const followups: string[] = [];
  return {
    initial,
    edits,
    errors,
    followups,
    transport: {
      async sendInitial(content: string) {
        initial.push(content);
        trace.push({ kind: 'discord_initial', detail: content });
        return {
          async edit(content: string) {
            edits.push(content);
            trace.push({ kind: 'discord_edit', detail: content });
          },
        };
      },
      async sendError(content: string) {
        errors.push(content);
        trace.push({ kind: 'discord_error', detail: content });
      },
      async sendFollowup(content: string) {
        followups.push(content);
        trace.push({ kind: 'discord_followup', detail: content });
      },
    },
  };
}

function registeredCapability(input: {
  operationId: string;
  effect: 'read' | 'external_write';
  fingerprint: string;
  accountId: string;
}) {
  const write = input.effect === 'external_write';
  const manifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:resolved:${input.operationId.toLowerCase()}`,
    providerKind: 'composio',
    operationId: input.operationId,
    providerIdentity: `composio:${input.operationId.split('_')[0]?.toLowerCase()}`,
    providerVersion: 'fixture-live-v1',
    operationVersion: '1',
    definitionFingerprint: input.fingerprint,
    effect: input.effect,
    ...(write ? { destination: { family: 'workbook', posture: 'create_new' as const } } : {}),
    accountId: input.accountId,
    idempotency: { required: write, policy: write ? 'key_before_dispatch' as const : 'none' as const },
    reconciliation: { supported: write, policy: write ? 'exact_artifact' as const : 'none' as const },
    outputContract: { kind: write ? 'created_spreadsheet' : 'records' },
    purpose: write ? 'persist_collection' : 'collect_records',
    acceptedInputKinds: write ? ['records'] : ['query'],
    producedOutputKinds: write ? ['created_spreadsheet'] : ['records'],
    applicableDeliverableKinds: write ? ['workbook'] : ['records'],
    evidenceContract: { kinds: write ? ['receipt', 'readback'] : ['payload'], readbackRequired: write },
    provenance: {
      issuer: 'journey:connected-fixture',
      issuedAt: '2026-08-23T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: write ? ['destination', 'create'] : ['source', 'collection', 'collect'],
  });
  let forbiddenDirectPortBodies = 0;
  const directPort = async () => {
    forbiddenDirectPortBodies += 1;
    throw new Error('the host must retain the work_call/composio gateway carrier');
  };
  return { manifest, directPort, directBodies: () => forbiddenDirectPortBodies };
}

after(async () => {
  mock.restoreAll();
  innerDispatch._setInnerDispatchToolsForTests(null);
  connectedCatalog.installConnectedRegistryPort(null);
  semanticPorts.installTurnSemanticModelPort(null);
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  productionPorts.clearProductionCapabilityPorts();
  productionAdapters.installProductionTransport(null);
  composioClient.__test__.setConnectedAccountsLoader(null);
  composioClient.__test__.setComposioApiKeyOverride(null);
  composioClient.resetComposioClient();
  bridge._setBridgeImplsForTests({});
  resetHarnessRuntimeConfig();
  reflection._testOnly_setReflectionExtractor(null);
  eventlog.closeEventLog();
  memoryDb.closeMemoryDb();
  globalThis.fetch = originalFetch;
  rmSync(HOME, { recursive: true, force: true });
});

test('cold natural Discord request performs one restaurant read and one new-Sheet create in one foreground loop', { timeout: 120_000 }, async (t) => {
  // Fixture byte pins: changing the user wording or business payload is an
  // explicit test-contract change, never an unnoticed "close enough" edit.
  assert.equal(sha256(PROMPT), '54f5fd137e4e0f2f366f85a4beb44766cc1027e4bf7860c14f8d21a225f3f3de');
  assert.equal(sha256(canonical(ROWS)), '2668b71c863a81905ea164ba42b35f8ef6294adf492221da4166915b9d8341e9');

  eventlog.resetEventLog();
  resetHarnessRuntimeConfig();
  proactivity.saveProactivityPolicy({ autoApproveScope: 'strict' });

  const session = eventlog.createSession({
    id: 'discord-natural-restaurant-sheet',
    kind: 'chat',
    userId: 'discord-user-natural-request',
  });
  assert.deepEqual(eventlog.listEvents(session.id), [], 'history starts blank');
  assert.deepEqual(capabilityIndex.searchCapabilityOperations(PROMPT), [],
    'capability memory/index starts blank');

  const configured = await configureHarnessRuntime();
  assert.equal(configured.ok, true, configured.ok ? '' : configured.reason);

  // The provider wire is present, but it does not pre-install a manifest,
  // catalog entry, port, source choice, or argument contract. Foreground
  // discovery must still disclose the exact operations and plan_task must
  // freeze them before this transport can ever be relevant to execution.
  // The preserved work_call carrier crosses through the connected gateway
  // below; a direct catalog body here would be a parallel execution owner.
  let forbiddenDirectCatalogCrossings = 0;
  productionAdapters.installProductionTransport(async () => {
    forbiddenDirectCatalogCrossings += 1;
    throw new Error('natural journey forbids direct catalog execution outside work_call');
  });
  assert.equal(productionAdapters.productionProviderCrossingAllowed(), true,
    'the isolated connected wire is available without granting any catalog authority');

  const trace: TraceEntry[] = [];
  const providerCalls: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const providerDefinitionRequests: Array<{
    tools: string[];
    toolkits: string[];
    search: string | null;
  }> = [];
  let restaurantReads = 0;
  let sheetCreates = 0;
  let discoveryListings = 0;
  let rawBusinessRequests = 0;
  let legacyHighLevelExecuteCalls = 0;
  const noRetryOptions: unknown[] = [];
  let semanticCalls = 0;
  let settledReadRows: Array<Record<string, unknown>> | null = null;
  let providerScenario: 'standard' | 'bounded_collection' = 'standard';
  let boundedProviderPayloadBytes = 0;

  const factory = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  assert.ok(factory, 'runtime installs one empty searchable host catalog');
  assert.deepEqual(factory.snapshot(), [],
    'business capabilities are absent before the foreground model searches');
  productionPorts.clearProductionCapabilityPorts();

  // This is the connected registry boundary, not a planted source decision:
  // both operations are merely live candidates until the foreground model
  // discovers one and an exact call is admitted.
  connectedCatalog.installConnectedRegistryPort(() => ({
    connectedToolkits: ['restaurants', 'googlesheets'],
    tools: [
      { slug: RESTAURANT_OPERATION, schema: RESTAURANT_SCHEMA as unknown as Record<string, unknown> },
      { slug: SHEET_OPERATION, schema: SHEET_SCHEMA as unknown as Record<string, unknown> },
    ],
  }));

  const rawTools = [
    {
      slug: RESTAURANT_OPERATION,
      name: 'Search restaurants',
    description: 'Search restaurant listings by location and category and return one bounded aggregate set.',
    toolkit: { slug: 'restaurants' },
    inputParameters: RESTAURANT_SCHEMA,
    outputParameters: RESTAURANT_OUTPUT_SCHEMA,
    version: 'fixture-restaurants-v1',
  },
    {
      slug: SHEET_OPERATION,
      name: 'Create Google Sheet from JSON',
    description: 'Create one new Google Sheet from a JSON collection of rows.',
    toolkit: { slug: 'googlesheets' },
    inputParameters: SHEET_SCHEMA,
    outputParameters: SHEET_OUTPUT_SCHEMA,
    version: 'fixture-googlesheets-v1',
  },
  ];
  composioClient.__test__.setComposioApiKeyOverride('fixture-composio-key');
  composioClient.__test__.setConnectedAccountsLoader(async () => [
    { id: 'conn-restaurants', status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'restaurants' } },
    { id: 'conn-googlesheets', status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'googlesheets' } },
  ]);
  const executeConnectedProvider = async (
    operation: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const slug = operation.toUpperCase();
    providerCalls.push({ slug, args: structuredClone(args) });
    trace.push({ kind: slug === RESTAURANT_OPERATION ? 'provider_read' : 'provider_write', detail: slug });
    if (slug === RESTAURANT_OPERATION) {
      restaurantReads += 1;
      if (providerScenario === 'bounded_collection') {
        assert.equal(typeof args.location, 'string');
        assert.ok(BOUNDED_LOCATIONS.includes(args.location as typeof BOUNDED_LOCATIONS[number]));
        assert.deepEqual({ category: args.category, limit: args.limit }, {
          category: 'restaurant',
          limit: 20,
        });
        const location = String(args.location);
        const records = Array.from({ length: 20 }, (_, index) => ({
          id: `${location.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index + 1}`,
          name: `${location} Restaurant ${index + 1}`,
          location,
          detail: `authoritative-${sha256(`${location}:${index}`)}-${'x'.repeat(39_000)}`,
        }));
        const payload = { records, total: records.length, has_more: false };
        return payload;
      }
      assert.deepEqual(args, {
        location: 'Santa Clarita, CA',
        category: 'restaurant',
        limit: 10,
      }, 'the aggregate read carries every source argument from the accepted request');
      settledReadRows = ROWS.map((row) => ({ ...row }));
      return { records: settledReadRows, total: 10, has_more: false };
    }
    assert.equal(slug, SHEET_OPERATION, `unexpected provider operation ${slug}`);
    assert.ok(settledReadRows, 'the source result settles before the dependent create');
    sheetCreates += 1;
    assert.deepEqual(Object.keys(args).sort(), ['sheet_json', 'sheet_name', 'title']);
    assert.equal(args.title, 'Santa Clarita Restaurants');
    assert.equal(args.sheet_name, 'Restaurants');
    assert.equal(typeof args.sheet_json, 'string');
    const sheetRows = JSON.parse(String(args.sheet_json)) as Array<Record<string, unknown>>;
    assert.deepEqual(sheetRows, settledReadRows, 'the Sheet contains all and only the settled restaurant rows');
    return {
      successful: true,
      spreadsheetId: SHEET_ID,
      spreadsheetUrl: SHEET_URL,
    };
  };
  composioClient.__test__.setComposioClient({
    client: { baseURL: 'https://backend.composio.dev' },
    getClient: () => ({
      withOptions: (options: unknown) => {
        noRetryOptions.push(options);
        return {
          tools: {
            execute: async (
              operation: string,
              body: {
                arguments?: unknown;
                connected_account_id?: unknown;
                user_id?: unknown;
                version?: unknown;
              },
              request?: { signal?: AbortSignal },
            ) => {
              rawBusinessRequests += 1;
              assert.ok(request?.signal instanceof AbortSignal,
                'the exact raw business request inherits the host abort signal');
              assert.ok(body.arguments && typeof body.arguments === 'object'
                && !Array.isArray(body.arguments));
              assert.equal(body.connected_account_id,
                operation === RESTAURANT_OPERATION ? 'conn-restaurants' : 'conn-googlesheets');
              assert.equal(body.user_id, 'fixture-user');
              assert.equal(body.version,
                operation === RESTAURANT_OPERATION ? 'fixture-restaurants-v1' : 'fixture-googlesheets-v1');
              const data = await executeConnectedProvider(
                operation,
                body.arguments as Record<string, unknown>,
              );
              const logId = `fixture-${rawBusinessRequests}`;
              if (providerScenario === 'bounded_collection' && operation === RESTAURANT_OPERATION) {
                // Durable result accounting sees the exact normalized raw-v3.1
                // return, including transport metadata, rather than only its
                // nested business payload.
                boundedProviderPayloadBytes += Buffer.byteLength(JSON.stringify({
                  data,
                  error: null,
                  successful: true,
                  logId,
                }), 'utf8');
              }
              return { data, error: null, successful: true, log_id: logId };
            },
          },
        };
      },
    }),
    tools: {
      async getRawComposioTools(input: { tools?: string[]; toolkits?: string[]; search?: string }) {
        discoveryListings += 1;
        providerDefinitionRequests.push({
          tools: [...(input.tools ?? [])],
          toolkits: [...(input.toolkits ?? [])],
          search: input.search ?? null,
        });
        const exact = new Set((input.tools ?? []).map((value) => value.toUpperCase()));
        const toolkits = new Set((input.toolkits ?? []).map((value) => value.toLowerCase()));
        return rawTools.filter((candidate) =>
          (exact.size === 0 || exact.has(candidate.slug))
          && (toolkits.size === 0 || toolkits.has(candidate.toolkit.slug)));
      },
      async execute() {
        legacyHighLevelExecuteCalls += 1;
        throw new Error('natural journey forbids the legacy Composio high-level execute fallback');
      },
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://backend.composio.dev/api/v3/tools?')) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`journey forbids external network: ${url}`);
  }) as typeof fetch;

  // The optional account-selection model wire is distinct from forbidden
  // pre-loop interpretation/planning. Its verdict binds only the current
  // accepted source and sole actual account; production still owns authority.
  const accountReviewSources = new Map([[session.id, PROMPT]]);
  let accountReviews = 0;
  semanticPorts.installTurnSemanticModelPort({
    async judgeAccountSelection(call) {
      const acceptedText = accountReviewSources.get(call.sessionId);
      assert.ok(acceptedText, 'account review cannot borrow a source from another journey');
      assert.ok(['restaurants', 'googlesheets'].includes(call.toolkit));
      const reviewer = currentSourceAccountReviewer({
        sessionId: () => call.sessionId,
        acceptedText,
        toolkit: call.toolkit,
        accountIdentity: call.toolkit === 'restaurants' ? 'conn-restaurants' : 'conn-googlesheets',
        acceptedSource: (sessionId, seq) => eventlog.listEvents(sessionId,
          { sinceSeq: seq - 1, types: ['user_input_received'], limit: 1 })[0],
      });
      const verdict = await reviewer(call);
      accountReviews += 1;
      return verdict;
    },
    async interpret() {
      semanticCalls += 1;
      throw new Error('hidden pre-loop semantic model pass');
    },
    async judgeSourceEffect() {
      semanticCalls += 1;
      throw new Error('hidden pre-loop semantic effect judge');
    },
    async judgePlanGrounding() {
      semanticCalls += 1;
      throw new Error('hidden pre-loop semantic grounding judge');
    },
  });

  // Complete the existing model-wire fixture: real captured role resolution,
  // Agents Runner, parser and verdict publication still own completion. The
  // mock can rule only on the ten real settled rows and exact create receipt.
  let completionReviewSource: { sessionId: string; seq: number } | null = null;
  const completionReviews: Array<{ sessionId: string; seq: number; modelId: string }> = [];
  mock.method(CodexModelProvider.prototype, 'getModel', (modelId?: string) => {
    assert.equal(modelId, 'gpt-5.5', 'the isolated owner-selected same-provider reviewer is honored');
    return {
      async getResponse(request: unknown) {
        assert.ok(completionReviewSource, 'a reviewer cannot precede the accepted source');
        const source = eventlog.listEvents(completionReviewSource.sessionId,
          { sinceSeq: completionReviewSource.seq - 1, types: ['user_input_received'], limit: 1 })[0];
        assert.equal(source?.seq, completionReviewSource.seq);
        assert.equal(source?.sessionId, completionReviewSource.sessionId);
        assert.equal(source?.data.displayText || source?.data.text, PROMPT);
        const textValues: string[] = [];
        const collect = (value: unknown): void => {
          if (typeof value === 'string') textValues.push(value);
          else if (Array.isArray(value)) value.forEach(collect);
          else if (value && typeof value === 'object') Object.values(value).forEach(collect);
        };
        collect(request);
        const actualJudgeText = textValues.join('\n');
        assert.ok(actualJudgeText.includes(`Objective: ${PROMPT}`));
        assert.ok(actualJudgeText.includes(SUCCESS));
        assert.ok(actualJudgeText.includes(SHEET_URL));
        assert.ok(actualJudgeText.includes('Retained READ results for THIS accepted source'));
        for (const row of ROWS) {
          assert.ok(actualJudgeText.includes(row.name), `the actual reviewer receives ${row.name}`);
          assert.ok(actualJudgeText.includes(row.address), `the actual reviewer receives ${row.address}`);
        }
        assert.deepEqual(settledReadRows, ROWS.map(row => ({ ...row })));
        assert.equal(providerCalls.at(-1)?.slug, SHEET_OPERATION,
          'review runs after the sole successful dependent create, never as prewrite authority');
        completionReviews.push({ ...completionReviewSource, modelId: modelId! });
        return { usage: new Usage(), responseId: `completion-review-${completionReviews.length}`,
          output: [textMessage('DONE: the exact ten settled restaurant rows and successful new Sheet receipt satisfy this accepted request.')] };
      },
      async *getStreamedResponse() { throw new Error('completion review uses the existing one-turn nonstreaming Runner'); },
    } as never;
  });

  const gateway = composioTools.getComposioRuntimeTools()
    .find((candidate) => candidate.name === 'composio_execute_tool');
  assert.ok(gateway, 'the journey uses the production Composio carrier around the raw provider wire');
  innerDispatch._setInnerDispatchToolsForTests(new Map([
    ['composio_execute_tool', gateway as never],
  ]));

  const modelRequests: Array<{ phase: 'hidden' | 'primary'; tools: string[]; bytes: number }> = [];
  type CacheRun = 'cold' | 'warm';
  type CacheObservation = ReturnType<typeof observePromptCacheRequest>;
  const cacheUsageRecords: Array<{
    run: CacheRun;
    inputTokens: number;
    cachedInputTokens: number;
    uncachedInputTokens: number;
    observation: CacheObservation;
  }> = [];
  let previousCacheObservation: CacheObservation | null = null;
  const recordNaturalPromptCacheUsage = (run: CacheRun, rawRequest: unknown) => {
    const observation = observePromptCacheRequest(rawRequest as never);
    const transition = comparePromptCacheRequests(previousCacheObservation, observation);
    const promptLayers = ['stablePolicy', 'turnContext', 'memoryContext', 'catalog', 'task'] as const;
    // This deterministic tokenizer belongs to the recording provider boundary.
    // The harness consumes the returned receipt; it does not estimate usage.
    const tokens = Object.fromEntries(promptLayers.map((name) => [
      name,
      observation.layers[name].bytes === 0
        ? 0
        : Math.max(1, Math.ceil(observation.layers[name].bytes / 4)),
    ])) as Record<(typeof promptLayers)[number], number>;
    const inputTokens = promptLayers.reduce((sum, name) => sum + tokens[name], 0);
    const cachedInputTokens = transition.reusableLayers
      .filter((name): name is (typeof promptLayers)[number] => promptLayers.includes(name as never))
      .reduce((sum, name) => sum + tokens[name], 0);
    const uncachedInputTokens = inputTokens - cachedInputTokens;
    previousCacheObservation = observation;
    cacheUsageRecords.push({
      run,
      inputTokens,
      cachedInputTokens,
      uncachedInputTokens,
      observation,
    });
    return {
      usage: {
        requests: 1,
        inputTokens,
        outputTokens: 1,
        totalTokens: inputTokens + 1,
        inputTokensDetails: { cachedTokens: cachedInputTokens },
      },
      providerData: {
        promptCacheUsage: {
          version: 1,
          cacheDialect: 'inclusive',
          inputTokens,
          cachedInputTokens,
          uncachedInputTokens,
        },
      },
    } as const;
  };
  let primaryStep = 0;
  const scriptedModel = {
    async getResponse(rawRequest: unknown) {
      const request = (rawRequest ?? {}) as { tools?: Array<{ name?: string }>; input?: unknown };
      const tools = (request.tools ?? []).map((entry) => entry.name ?? '').filter(Boolean);
      const requestBytes = JSON.stringify(rawRequest ?? {}).length;
      const serialized = JSON.stringify(rawRequest ?? {});
      const hiddenPreflight = tools.length === 0
        && /Clementine Preflight Conversation|immediately before consequential work|Openness verdict: SETTLED/i.test(serialized);
      modelRequests.push({ phase: hiddenPreflight ? 'hidden' : 'primary', tools, bytes: requestBytes });
      const cacheReceipt = recordNaturalPromptCacheUsage('cold', rawRequest);
      if (hiddenPreflight) {
        // Keep current broken bytes observable long enough to reach the final
        // assertion; this response is never accepted as proof.  The release
        // contract requires ZERO such calls.
        return {
          ...cacheReceipt,
          output: [textMessage(PREAMBLE)],
          responseId: 'forbidden-hidden-preflight-response',
        };
      }

      primaryStep += 1;
      let output: unknown[];
      if (primaryStep === 1) {
        assert.match(serialized, new RegExp(PROMPT), 'the first primary step sees the exact accepted request');
        assert.ok(acceptedSource, 'the first primary step belongs to an actual accepted source');
        const initialCard = eventlog.listEvents(session.id).find(event =>
          event.type === 'primary_model_planning_card_snapshot'
          && event.data.sourceUserSeq === acceptedSource!.seq);
        assert.ok(initialCard && typeof initialCard.data.snapshotJson === 'string');
        const initialSnapshot = JSON.parse(initialCard.data.snapshotJson);
        assert.equal(initialSnapshot.objectiveDigest, sha256(PROMPT));
        assert.deepEqual(initialSnapshot.capabilities, [], 'the cold source has no undisclosed operation authority');
        assert.equal(initialSnapshot.effectCeiling, 'external_write');
        assert.doesNotMatch(serialized, /cap:resolved:restaurants_search|cap:resolved:googlesheets_sheet_from_json/,
          'blank-state capabilities are not planted into the first planning card');
        assert.equal(tools.includes(PLAN_CONTROL), false,
          'an empty initial planning catalog keeps the impossible plan control off the first model surface');
        assert.ok(tools.includes('tool_search'), 'blank state exposes metadata discovery before planning');
        assert.equal(tools.includes('work_call'), false,
          'the proposal-free carrier stays hidden until exact disclosure can also expose plan_task');
        assert.ok(tools.includes('run_worker'), 'scoped delegation is plan-optional on the first primary surface');
        assert.equal(providerCalls.length, 0, 'advertising a worker grants no provider crossing');
        assert.equal(eventlog.listEvents(session.id, { types: ['worker_started', 'worker_result'] }).length, 0,
          'fresh discovery has not dispatched any worker');
        output = [functionCall('discover-capabilities', 'tool_search', {
          query: 'search for restaurants by location and create a new Google Sheet from the results',
          role_key: null,
          limit: 8,
        })];
      } else if (primaryStep === 2) {
        assert.match(serialized, new RegExp(RESTAURANT_OPERATION), 'foreground discovery returns the restaurant operation');
        assert.match(serialized, new RegExp(SHEET_OPERATION), 'foreground discovery returns the Sheet operation');
        assert.match(serialized, /cap:resolved:restaurants_search/, 'the exact disclosed read ref reaches the model');
        assert.match(serialized, /cap:resolved:googlesheets_sheet_from_json/, 'the exact disclosed write ref reaches the model');
        assert.ok(tools.includes(PLAN_CONTROL), 'the plan control stays available until exact refs are resolved');
        assert.ok(tools.includes('work_call'),
          'search disclosure exposes the proposal-free carrier but grants no standalone business-call authority');
        output = [
          functionCall('admit-natural-task', PLAN_CONTROL, {
            preamble: PREAMBLE,
            draft: {
              criteria: [
                'Exactly 10 distinct Santa Clarita restaurant rows are collected.',
                'One new Google Sheet contains all and only those rows.',
              ],
              cardinality: { count: 10, fields: ['name', 'category', 'rating', 'address'] },
              destination: { posture: 'create_new', family: 'googlesheets', handleRequired: true },
              topology: {
                version: 1,
                operations: [
                  {
                    id: READ_REQUIREMENT,
                    effect: 'read',
                    coverage: 'complete_set',
                    dependsOn: [],
                    dataFrom: [],
                    cardinality: { kind: 'once' },
                  },
                  {
                    id: WRITE_REQUIREMENT,
                    effect: 'external_write',
                    coverage: null,
                    dependsOn: [READ_REQUIREMENT],
                    dataFrom: [READ_REQUIREMENT],
                    cardinality: { kind: 'once' },
                  },
                ],
                universes: [],
              },
              bindings: [
                {
                  operationId: READ_REQUIREMENT,
                  role: 'source',
                  capabilityRef: 'cap:resolved:restaurants_search',
                  evidence: ['records'],
                },
                {
                  operationId: WRITE_REQUIREMENT,
                  role: 'destination',
                  capabilityRef: 'cap:resolved:googlesheets_sheet_from_json',
                  evidence: ['receipt'],
                },
              ],
              deliverables: [{ id: 'restaurant-sheet', kind: 'googlesheets' }],
              evidenceRequirements: ['records', 'receipt'],
            },
          }),
          functionCall('restaurant-read', 'work_call', {
            requirement_id: READ_REQUIREMENT,
            universe_item_id: null,
            universe_selector: null,
            seal_amendment: null,
            name: 'composio_execute_tool',
            args_json: JSON.stringify({
              tool_slug: RESTAURANT_OPERATION,
              arguments: JSON.stringify({
                location: 'Santa Clarita, CA',
                category: 'restaurant',
                limit: 10,
              }),
              connected_account_id: 'conn-restaurants',
            }),
          }),
        ];
      } else if (primaryStep === 3) {
        assert.equal(tools.includes(PLAN_CONTROL), false, 'plan_task retires after durable action activation');
        assert.ok(tools.includes('work_call'), 'the activated business carrier remains available');
        assert.ok(tools.includes('run_worker'), 'bounded worker fanout is reachable after action activation');
        assert.ok(settledReadRows, 'the foreground receives the read result before forming the write');
        output = [functionCall('sheet-create', 'work_call', {
          requirement_id: WRITE_REQUIREMENT,
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: SHEET_OPERATION,
            arguments: JSON.stringify({
              title: 'Santa Clarita Restaurants',
              sheet_name: 'Restaurants',
              sheet_json: JSON.stringify(settledReadRows),
            }),
            connected_account_id: 'conn-googlesheets',
          }),
        })];
      } else {
        output = [textMessage(JSON.stringify({
          summary: SUCCESS,
          reply: SUCCESS,
          done: true,
          nextAction: 'completed',
          reason: null,
        }))];
      }
      return {
        ...cacheReceipt,
        output,
        responseId: `primary-response-${primaryStep}`,
      };
    },
    getStreamedResponse: streamResponse,
  };

  const builtSurfaces: string[][] = [];
  bridge._setBridgeImplsForTests({
    buildAgent: async (options) => {
      const built = await buildOrchestratorAgent({
        ...options,
        model: scriptedModel as never,
      });
      builtSurfaces.push((built.tools ?? []).map((entry) => entry.name));
      return built;
    },
  });

  const delivery = recordingTransport(trace);
  let acceptedSource: { seq: number; turn: number } | null = null;
  const durableRequest = {
    sessionId: session.id,
    runId: 'discord-natural-restaurant-sheet-request-1',
    onSourceAccepted(source: { seq: number; turn: number }) {
      acceptedSource = { seq: source.seq, turn: source.turn };
      completionReviewSource = { sessionId: session.id, seq: source.seq };
    },
  };
  await discord.runDiscordHarnessConversation({
    prompt: PROMPT,
    rawPrompt: PROMPT,
    channelId: 'discord-channel-natural-request',
    userId: 'discord-user-natural-request',
    guildId: 'discord-guild-natural-request',
    transport: delivery.transport,
    durableRequest,
  });

  assert.ok(acceptedSource, 'the exported Discord runner accepted one durable source');
  const sourceUserSeq = acceptedSource!.seq;
  assert.equal(semanticCalls, 0,
    'no hidden semantic/planner model pass runs before the conversational/foreground loop');
  assert.equal(modelRequests.filter((request) => request.phase === 'hidden').length, 0,
    'there is no separate preflight/conversation-author model route');
  assert.equal(modelRequests[0]?.phase, 'primary', 'the primary loop owns the first model-visible step');
  assert.equal(modelRequests.filter((request) => request.phase === 'primary').length, 4,
    `one primary loop owns discovery, plan+preamble+root-read, dependent write, and final response: ${JSON.stringify({ modelRequests, trace, deliveryErrors: delivery.errors, events: eventlog.listEvents(session.id).map((event) => ({ type: event.type, data: event.data })) })}`);
  assert.equal(primaryStep, 4);
  assert.equal(modelRequests[0]?.tools.includes(PLAN_CONTROL), false,
    'the empty initial catalog exposes discovery but not plan_task');
  assert.ok(modelRequests[1]?.tools.includes(PLAN_CONTROL),
    'the exact foreground disclosure enables plan_task on the next model surface');
  assert.equal(modelRequests[0]?.tools.includes('work_call'), false,
    'blank discovery does not pay or advertise the not-yet-usable business carrier');
  assert.ok(modelRequests[1]?.tools.includes('work_call'));
  assert.ok(modelRequests[2]?.tools.includes('work_call'),
    'work_call remains usable after the source-bound plan is admitted');
  assert.equal(modelRequests.slice(2).some((request) => request.tools.includes(PLAN_CONTROL)), false,
    'the plan schema is absent from read, write, and final model steps');
  assert.ok(discoveryListings >= 1, 'cold discovery reaches live connected definitions');
  assert.ok(accountReviews > 0, 'current source/default account compatibility is reviewed, not assumed');
  assert.ok(builtSurfaces.some((surface) => surface.includes(PLAN_CONTROL)));
  assert.ok(builtSurfaces.some((surface) => surface.includes('tool_search')));
  assert.ok(builtSurfaces.some((surface) => surface.includes('work_call')));

  const events = eventlog.listEvents(session.id);
  assert.equal(events.filter((event) => event.type === 'worker_started' || event.type === 'worker_result').length, 0,
    'this direct two-operation task performs no worker I/O despite plan-optional visibility');
  const preambles = events.filter((event) =>
    event.type === 'conversation_preamble' && event.data.sourceUserSeq === sourceUserSeq);
  assert.equal(preambles.length, 1);
  const preambleText = String(preambles[0]?.data.text ?? '');
  assert.ok(preambleText.trim());
  assert.doesNotMatch(preambleText, /\?/);
  const preambleDeliveryIndex = trace.findIndex((entry) =>
    entry.kind === 'discord_edit' && String(entry.detail ?? '').includes(preambleText));
  const providerIndex = trace.findIndex((entry) => entry.kind === 'provider_read');
  assert.ok(preambleDeliveryIndex >= 0 && providerIndex > preambleDeliveryIndex,
    `the conversational preamble crosses Discord before provider I/O: ${JSON.stringify(trace)}`);

  const forbiddenStops = events.filter((event) => [
    'awaiting_user_input',
    'approval_requested',
    'approval_required',
    'request_approval',
    'conversation_interrupted',
  ].includes(event.type));
  assert.deepEqual(forbiddenStops, [], 'the exact settled request asks no follow-up or approval question');
  assert.equal(events.some((event) => event.type === 'turn_preflight_decision'
    && event.data.sourceStrategyBinding !== undefined), false,
  'the cold request never acquires a planted source-strategy binding');

  assert.equal(restaurantReads, 1);
  assert.equal(sheetCreates, 1, JSON.stringify({
    trace,
    deliveryErrors: delivery.errors,
    providerCalls,
    events: events.map((event) => ({ type: event.type, data: event.data })),
  }));
  assert.equal(providerCalls.length, 2);
  assert.equal(rawBusinessRequests, 2, 'one raw no-retry request owns each physical business row');
  assert.equal(legacyHighLevelExecuteCalls, 0, 'the legacy high-level execute path is never a fallback');
  assert.deepEqual(noRetryOptions, [{ maxRetries: 0 }, { maxRetries: 0 }]);
  assert.equal(forbiddenDirectCatalogCrossings, 0,
    'the raw provider wire proves availability but never becomes a parallel dispatch owner');
  assert.deepEqual(providerCalls.map((call) => call.slug), [RESTAURANT_OPERATION, SHEET_OPERATION]);
  assert.equal(new Set(ROWS.map((row) => row.name)).size, 10, 'restaurant rows are distinct');
  assert.deepEqual(factory.snapshot().map((entry) => entry.capabilityId).sort(), [
    'cap:resolved:googlesheets_sheet_from_json',
    'cap:resolved:host_transform',
    'cap:resolved:restaurants_search',
  ], 'only foreground-disclosed live operations and the host transform enter the exact catalog');
  assert.doesNotMatch(JSON.stringify(providerCalls), /share|email|delete|spreadsheet_id|existing/i);

  const db = eventlog.openEventLog();
  const logical = db.prepare(`
    SELECT logical_tool_call_id, tool_name, state
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY rowid
  `).all(session.id, sourceUserSeq) as Array<{
    logical_tool_call_id: string;
    tool_name: string;
    state: string;
  }>;
  assert.ok(logical.length >= 3, JSON.stringify(logical));
  assert.ok(logical.every((row) => row.state === 'settled'), JSON.stringify(logical));
  assert.equal(logical.filter((row) => row.logical_tool_call_id === 'restaurant-read').length, 1);
  assert.equal(logical.filter((row) => row.logical_tool_call_id === 'sheet-create').length, 1);

  type HostCapabilityBindingRow = {
    logical_tool_call_id: string;
    root_authority_kind: string;
    root_graph_event_id: string | null;
    root_graph_hash: string | null;
    tool_name: string;
    operation_id: string;
    account_id: string;
    provider_input_schema_digest: string | null;
    effect: string;
    attested_argument_digest: string;
    logical_raw_argument_digest: string;
    logical_owner_raw_argument_digest: string;
    bound_effective_argument_digest: string | null;
    logical_effective_argument_digest: string | null;
    logical_argument_digest: string;
    durable_binding_digest: string;
  };
  const readHostCapabilityBindings = (): HostCapabilityBindingRow[] => db.prepare(`
    SELECT binding.logical_tool_call_id, binding.root_authority_kind,
           binding.root_graph_event_id, binding.root_graph_hash, binding.tool_name,
           binding.operation_id, binding.account_id,
           binding.provider_input_schema_digest, binding.effect,
           binding.attested_argument_digest, binding.logical_raw_argument_digest,
           call.raw_argument_digest AS logical_owner_raw_argument_digest,
           binding.bound_effective_argument_digest,
           call.effective_argument_digest AS logical_effective_argument_digest,
           call.argument_digest AS logical_argument_digest,
           binding.durable_binding_digest
      FROM host_call_capability_bindings binding
      JOIN logical_tool_calls call
        ON call.session_id = binding.session_id
       AND call.source_user_seq = binding.source_user_seq
       AND call.logical_tool_call_id = binding.logical_tool_call_id
     WHERE binding.session_id = ? AND binding.source_user_seq = ?
       AND binding.logical_tool_call_id IN ('restaurant-read', 'sheet-create')
     ORDER BY binding.logical_tool_call_id
  `).all(session.id, sourceUserSeq) as HostCapabilityBindingRow[];
  const hostCapabilityBindings = readHostCapabilityBindings();
  assert.equal(hostCapabilityBindings.length, 2, JSON.stringify(hostCapabilityBindings));
  const readHostBinding = hostCapabilityBindings.find((row) =>
    row.logical_tool_call_id === 'restaurant-read');
  const writeHostBinding = hostCapabilityBindings.find((row) =>
    row.logical_tool_call_id === 'sheet-create');
  assert.ok(hostCapabilityBindings.every((row) => (
    row.root_authority_kind === 'host_v1'
    && row.root_graph_event_id === null
    && row.root_graph_hash === null
  )), JSON.stringify(hostCapabilityBindings));
  assert.deepEqual({
    tool: readHostBinding?.tool_name,
    operation: readHostBinding?.operation_id,
    account: readHostBinding?.account_id,
    providerInputSchemaDigest: readHostBinding?.provider_input_schema_digest,
    effect: readHostBinding?.effect,
  }, {
    tool: RESTAURANT_OPERATION.toLowerCase(),
    operation: RESTAURANT_OPERATION,
    account: 'conn-restaurants',
    providerInputSchemaDigest: sha256(canonical(RESTAURANT_SCHEMA)),
    effect: 'read',
  });
  assert.deepEqual({
    tool: writeHostBinding?.tool_name,
    operation: writeHostBinding?.operation_id,
    account: writeHostBinding?.account_id,
    providerInputSchemaDigest: writeHostBinding?.provider_input_schema_digest,
    effect: writeHostBinding?.effect,
  }, {
    tool: SHEET_OPERATION.toLowerCase(),
    operation: SHEET_OPERATION,
    account: 'conn-googlesheets',
    providerInputSchemaDigest: sha256(canonical(SHEET_SCHEMA)),
    effect: 'external_write',
  });
  for (const binding of hostCapabilityBindings) {
    assert.equal(binding.logical_raw_argument_digest.length, 64);
    assert.equal(binding.logical_raw_argument_digest,
      binding.logical_owner_raw_argument_digest,
      'the durable host binding carries the exact immutable logical raw digest');
    assert.equal(binding.attested_argument_digest,
      binding.bound_effective_argument_digest ?? binding.logical_raw_argument_digest,
      'attestation binds the admitted raw digest or the one already-frozen effective digest');
    assert.equal(binding.logical_argument_digest,
      binding.logical_effective_argument_digest ?? binding.logical_raw_argument_digest,
      'the logical ledger exposes one exact raw-to-effective chain');
    assert.equal(binding.logical_argument_digest,
      binding.bound_effective_argument_digest ?? binding.logical_raw_argument_digest,
      'the durable host binding reopens the same final argument digest as its logical owner');
    assert.equal(binding.durable_binding_digest.length, 64);
  }

  const providerCrossings = db.prepare(`
    SELECT logical_tool_call_id, tool_name, state, execution_site
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
       AND logical_tool_call_id IN ('restaurant-read', 'sheet-create')
     ORDER BY rowid
  `).all(session.id, sourceUserSeq) as Array<{
    logical_tool_call_id: string;
    tool_name: string;
    state: string;
    execution_site: string | null;
  }>;
  assert.equal(providerCrossings.length, 2, JSON.stringify(providerCrossings));
  assert.ok(providerCrossings.every((row) => row.state === 'returned'), JSON.stringify(providerCrossings));

  const settlements = db.prepare(`
    SELECT logical_tool_call_id, physical_crossing_count, host_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
  `).all(session.id, sourceUserSeq) as Array<{
    logical_tool_call_id: string;
    physical_crossing_count: number;
    host_crossing_count: number;
  }>;
  const readSettlement = settlements.find((row) => row.logical_tool_call_id === 'restaurant-read');
  const writeSettlement = settlements.find((row) => row.logical_tool_call_id === 'sheet-create');
  assert.equal(readSettlement?.physical_crossing_count, 1, JSON.stringify(settlements));
  assert.equal(writeSettlement?.physical_crossing_count, 1, JSON.stringify(settlements));

  const workBindings = db.prepare(`
    SELECT logical_tool_call_id, requirement_id
      FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY rowid
  `).all(session.id, sourceUserSeq) as Array<{
    logical_tool_call_id: string;
    requirement_id: string;
  }>;
  assert.deepEqual(workBindings, [
    { logical_tool_call_id: 'restaurant-read', requirement_id: READ_REQUIREMENT },
    { logical_tool_call_id: 'sheet-create', requirement_id: WRITE_REQUIREMENT },
  ]);

  const observedOperations = db.prepare(`
    SELECT operation_id, logical_tool_call_id, resolved_tool, effect_kind
      FROM accepted_task_operations
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY rowid
  `).all(session.id, sourceUserSeq) as Array<{
    operation_id: string;
    logical_tool_call_id: string;
    resolved_tool: string;
    effect_kind: string;
  }>;
  assert.deepEqual(observedOperations.map((row) => ({
    logicalToolCallId: row.logical_tool_call_id,
    resolvedTool: row.resolved_tool,
    effectKind: row.effect_kind,
  })), [
    { logicalToolCallId: 'restaurant-read', resolvedTool: RESTAURANT_OPERATION.toLowerCase(), effectKind: 'read' },
    { logicalToolCallId: 'sheet-create', resolvedTool: SHEET_OPERATION.toLowerCase(), effectKind: 'external_write' },
  ], JSON.stringify(observedOperations));
  const manifestEvents = events.filter((event) =>
    event.type === 'obligation_manifest' && event.data.sourceUserSeq === sourceUserSeq);
  assert.equal(manifestEvents.length, 1, JSON.stringify(manifestEvents));
  const obligationManifest = manifestEvents[0]?.data.manifest as {
    nodes?: Array<{
      logicalToolCallId?: string;
      resolvedTool?: string;
      contentCommitMode?: string;
      obligations?: string[];
    }>;
  } | undefined;
  const sheetManifestNode = obligationManifest?.nodes?.find((node) =>
    node.resolvedTool === SHEET_OPERATION.toLowerCase());
  assert.equal(sheetManifestNode?.contentCommitMode, 'documented_atomic_input',
    JSON.stringify(obligationManifest));
  assert.ok(sheetManifestNode?.obligations?.includes('verify_committed_content'),
    JSON.stringify(sheetManifestNode));
  assert.equal(sheetManifestNode?.obligations?.includes('verify_committed_readback'), false,
    JSON.stringify(sheetManifestNode));
  const createResultRow = db.prepare(`
    SELECT h.raw_payload_json
      FROM logical_call_settlements s
      JOIN durable_result_handles h ON h.handle_id = s.result_handle_id
     WHERE s.session_id = ? AND s.source_user_seq = ?
       AND s.logical_tool_call_id = 'sheet-create'
  `).get(session.id, sourceUserSeq) as { raw_payload_json: string | null } | undefined;
  const createResultRaw = createResultRow?.raw_payload_json
    ? JSON.parse(createResultRow.raw_payload_json) as unknown
    : null;
  const verifiedCreate = documentedCreates.verifyCanonicalDocumentedCreateResult({
    value: createResultRaw,
  });
  assert.equal(verifiedCreate.status, 'verified', JSON.stringify({ createResultRow, verifiedCreate }));
  if (verifiedCreate.status === 'verified') {
    assert.deepEqual({
      acceptedTaskId: verifiedCreate.value.binding.acceptedTaskId,
      logicalToolCallId: verifiedCreate.value.binding.logicalToolCallId,
      requirementId: verifiedCreate.value.binding.requirementId,
      operationId: verifiedCreate.value.binding.operationId,
      effect: verifiedCreate.value.binding.effect,
    }, {
      acceptedTaskId: `task:${session.id}#${sourceUserSeq}`,
      logicalToolCallId: 'sheet-create',
      requirementId: WRITE_REQUIREMENT,
      operationId: SHEET_OPERATION,
      effect: 'external_write',
    });
  }

  const completions = events.filter((event) =>
    event.type === 'conversation_completed' && event.data.sourceUserSeq === sourceUserSeq);
  assert.equal(completions.length, 1, JSON.stringify(completions));
  assert.deepEqual(completionReviews, [{ sessionId: session.id, seq: sourceUserSeq, modelId: 'gpt-5.5' }]);
  const completionRef = completions[0]!.data.completionVerdictRef as Record<string, unknown>;
  assert.equal(completionRef.verified, true);
  assert.equal(completionRef.ownerSelectedJudge, true);
  assert.equal(completionRef.selfJudge, true);
  assert.equal(completionRef.disposition, 'reviewed');
  assert.equal(completionRef.replyMatches, true);
  assert.equal(completionRef.objectiveMatches, true);
  const reviewEvent = events.find(event => event.id === completionRef.eventId);
  assert.equal(reviewEvent?.type, 'goal_alignment_judged');
  assert.equal(reviewEvent?.data.sourceUserSeq, sourceUserSeq);
  assert.equal(reviewEvent?.data.judgeModelId, 'gpt-5.5');
  assert.equal(reviewEvent?.data.replyDigest, sha256(SUCCESS));
  assert.equal(reviewEvent?.data.objectiveDigest, sha256(PROMPT));
  assert.notEqual(reviewEvent?.data.failedOpen, true);
  const terminalAuthorityDiagnostics = {
    graphNodeBindings: db.prepare(`
      SELECT node_id, binding_json, binding_digest
        FROM graph_node_bindings
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY node_id
    `).all(session.id, sourceUserSeq),
    physicalAuthorities: db.prepare(`
      SELECT p.logical_tool_call_id, p.physical_dispatch_id, p.tool_name, p.state,
             a.authority_digest, a.provider_argument_digest,
             s.observation_digest, s.retention_class,
             json_extract(s.sealed_json, '$.nodeId') AS node_id,
             json_extract(s.sealed_json, '$.operationId') AS operation_id,
             json_extract(s.sealed_json, '$.manifestId') AS manifest_id,
             json_extract(s.sealed_json, '$.accountId') AS account_id,
             json_extract(s.sealed_json, '$.liveFingerprint') AS schema_fingerprint,
             json_extract(s.sealed_json, '$.resolvedEffect') AS resolved_effect
        FROM physical_dispatches p
        LEFT JOIN physical_dispatch_authority a
          ON a.session_id = p.session_id
         AND a.source_user_seq = p.source_user_seq
         AND a.physical_dispatch_id = p.physical_dispatch_id
        LEFT JOIN physical_dispatch_authority_sealed s
          ON s.session_id = p.session_id
         AND s.source_user_seq = p.source_user_seq
         AND s.physical_dispatch_id = p.physical_dispatch_id
       WHERE p.session_id = ? AND p.source_user_seq = ?
         AND p.logical_tool_call_id IN ('restaurant-read','sheet-create')
       ORDER BY p.logical_tool_call_id
    `).all(session.id, sourceUserSeq),
    sheetCatalogIdentities: db.prepare(`
      SELECT snapshot.snapshot_digest,
             json_extract(entry.value, '$.capabilityId') AS capability_id,
             json_extract(entry.value, '$.manifestId') AS manifest_id,
             json_extract(entry.value, '$.manifestDigest') AS manifest_digest,
             json_extract(entry.value, '$.operationId') AS operation_id,
             json_extract(entry.value, '$.account') AS account_id,
             json_extract(entry.value, '$.schemaDigest') AS schema_digest,
             json_extract(entry.value, '$.providerInputSchemaDigest') AS provider_input_schema_digest,
             json_extract(entry.value, '$.effect') AS effect,
             json_extract(entry.value, '$.invokePortId') AS invoke_port_id
        FROM accepted_source_catalog_snapshots snapshot,
             json_each(snapshot.snapshot_json) entry
       WHERE snapshot.session_id = ? AND snapshot.source_user_seq = ?
         AND json_extract(entry.value, '$.operationId') = ?
    `).all(session.id, sourceUserSeq, SHEET_OPERATION),
    graphEvents: events.filter((event) => (
      event.type === 'turn_graph_compiled' && event.data.sourceUserSeq === sourceUserSeq
    )).map((event) => event.data),
    workContracts: db.prepare(`
      SELECT contract_id, graph_event_id, graph_id, graph_hash, planner_source, contract_json
        FROM accepted_task_work_contracts
       WHERE session_id = ? AND source_user_seq = ?
    `).all(session.id, sourceUserSeq),
    workBindings,
    observedOperations,
    manifestNodes: obligationManifest?.nodes ?? [],
    failureEvents: events.filter((event) => (
      /fail|error|uncertain|artifact|evidence|settle|terminal/i.test(event.type)
    )).map((event) => ({ type: event.type, data: event.data })),
  };
  assert.equal((completions[0]?.data.presentation as { status?: unknown } | undefined)?.status, 'done',
    JSON.stringify({ completion: completions[0], terminalAuthorityDiagnostics }));
  assert.deepEqual(events.filter((event) => event.type === 'run_failed'), [],
    JSON.stringify(events.filter((event) => event.type === 'run_failed')));
  assert.equal(delivery.errors.length, 0);
  assert.equal(delivery.followups.length, 0);
  assert.equal(delivery.edits.at(-1), SUCCESS);
  assert.match(delivery.edits.at(-1) ?? '', new RegExp(SHEET_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const learned = await terminalLearning.drainTerminalSemanticLearning({
    requireIdle: false,
    shardLimit: 2,
  });
  assert.equal(learned.intake.batchesCreated, 1, JSON.stringify(learned));
  assert.equal(learned.intake.shardsCreated, 0, JSON.stringify(learned));
  assert.equal(learned.extractorInvocations, 0, JSON.stringify(learned));
  assert.equal(learningModelCalls, 0, 'structured rows and a verified create receipt need no learning model');
  const learningMembers = learningIntake.listMemoryLearningMemberReceipts();
  assert.equal(
    learningMembers.find((member) => member.logicalToolCallId === 'restaurant-read')?.disposition,
    'structured_task_evidence',
    JSON.stringify(learningMembers),
  );
  const sheetLearning = learningMembers.find((member) => member.logicalToolCallId === 'sheet-create');
  assert.equal(sheetLearning?.disposition, 'resource_pointer', JSON.stringify(learningMembers));
  assert.equal(sheetLearning?.resourceRef, SHEET_URL, JSON.stringify(sheetLearning));
  const sheetPointers = sourceMap.listResourcePointers({ app: 'googlesheets' });
  assert.equal(sheetPointers.length, 1, JSON.stringify(sheetPointers));
  assert.equal(sheetPointers[0]?.ref, SHEET_URL, JSON.stringify(sheetPointers));

  const beforeReplay = {
    modelCalls: modelRequests.length,
    restaurantReads,
    sheetCreates,
    physical: (db.prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
    `).get(session.id, sourceUserSeq) as { n: number }).n,
    hostCapabilityBindings,
  };
  const durableAttempts = db.prepare(`
    SELECT run_id, source_user_seq, status, finished_at
      FROM run_attempts
     WHERE session_id = ?
     ORDER BY rowid
  `).all(session.id) as Array<{
    run_id: string;
    source_user_seq: number | null;
    status: string;
    finished_at: string | null;
  }>;
  assert.equal(durableAttempts.filter((attempt) => attempt.run_id === durableRequest.runId).length, 1,
    JSON.stringify(durableAttempts));
  assert.deepEqual(durableAttempts[0], {
    run_id: durableRequest.runId,
    source_user_seq: sourceUserSeq,
    status: 'completed',
    finished_at: durableAttempts[0]!.finished_at,
  });
  assert.ok(durableAttempts[0]!.finished_at, JSON.stringify(durableAttempts));
  const replayTrace: TraceEntry[] = [];
  const replayDelivery = recordingTransport(replayTrace);
  await discord.runDiscordHarnessConversation({
    prompt: PROMPT,
    rawPrompt: PROMPT,
    channelId: 'discord-channel-natural-request',
    userId: 'discord-user-natural-request',
    guildId: 'discord-guild-natural-request',
    transport: replayDelivery.transport,
    durableRequest,
  });
  assert.deepEqual({
    modelCalls: modelRequests.length,
    restaurantReads,
    sheetCreates,
    physical: (db.prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
    `).get(session.id, sourceUserSeq) as { n: number }).n,
    hostCapabilityBindings: readHostCapabilityBindings(),
  }, beforeReplay, `same durable request id replays the terminal with zero additional crossings: ${JSON.stringify({
    modelRequests,
    replayInitial: replayDelivery.initial,
    replayEdits: replayDelivery.edits,
    replayErrors: replayDelivery.errors,
    terminalEvents: eventlog.listEvents(session.id).filter((event) =>
      event.type.includes('terminal') || event.type.includes('completed') || event.type.includes('accepted_source'))
      .map((event) => ({ seq: event.seq, type: event.type, data: event.data })),
    callAuthority: db.prepare(`SELECT * FROM accepted_turn_call_authorities WHERE session_id = ?`)
      .all(session.id),
    taskResolution: db.prepare(`SELECT * FROM accepted_task_resolutions WHERE session_id = ?`)
      .all(session.id),
  })}`);
  assert.deepEqual(replayDelivery.initial, [SUCCESS]);
  assert.deepEqual(replayDelivery.edits, []);
  assert.deepEqual(replayDelivery.errors, []);
  const replayLearning = await terminalLearning.drainTerminalSemanticLearning({ requireIdle: false });
  assert.equal(replayLearning.intake.batchesCreated, 0, JSON.stringify(replayLearning));
  assert.equal(replayLearning.extractorInvocations, 0, JSON.stringify(replayLearning));
  assert.equal(learningModelCalls, 0, 'canonical request replay must not add learning calls');
  assert.equal(sourceMap.listResourcePointers({ app: 'googlesheets' })[0]?.mentionCount, 1,
    'replay cannot duplicate the deterministic resource-pointer receipt');

  await t.test(
    'verified capability memory skips rediscovery but never grants call, effect, account, or approval authority',
    { timeout: 60_000 },
    async () => {
      const resolved = await capabilityCandidates.resolveTurnCapabilityCandidates({
        userInput: PROMPT,
        semantic: false,
      });
      const rememberedRead = resolved.candidates.find((candidate) =>
        candidate.identifier === RESTAURANT_OPERATION);
      assert.ok(rememberedRead, JSON.stringify(resolved));
      assert.equal(rememberedRead.via, 'exact');
      assert.equal(rememberedRead.klass, 'capability_only');
      assert.equal(rememberedRead.effectClass, 'read');
      assert.equal(rememberedRead.schemaAuthority, 'live');
      assert.ok(rememberedRead.verifiedReadOrigin,
        'only the cold turn\'s settled verified read may warm this path');
      const rememberedCard = capabilityCandidates.renderCapabilityCandidateCard(resolved);
      assert.match(rememberedCard, new RegExp(RESTAURANT_OPERATION));
      assert.match(rememberedCard, /advisory|nothing here is pre-authorized/i);

      const warmSession = eventlog.createSession({
        id: 'discord-natural-restaurant-sheet-warm',
        kind: 'chat',
        userId: 'discord-user-natural-request',
      });
      accountReviewSources.set(warmSession.id, PROMPT);
      const providerBefore = {
        restaurantReads,
        sheetCreates,
        calls: providerCalls.length,
      };
      const broadDefinitionReadsBefore = providerDefinitionRequests.filter((request) =>
        request.search !== null || request.tools.length === 0).length;
      let warmAcceptedSource: { seq: number; turn: number } | null = null;
      let preModelAuthority: {
        logicalCalls: number;
        capabilityBindings: number;
        physicalDispatches: number;
        taskResolutions: number;
        approvals: number;
      } | null = null;
      const warmModelRequests: Array<{ tools: string[]; bytes: number }> = [];
      let warmStep = 0;
      const warmModel = {
        async getResponse(rawRequest: unknown) {
          warmStep += 1;
          const request = (rawRequest ?? {}) as { tools?: Array<{ name?: string }> };
          const tools = (request.tools ?? []).map((entry) => entry.name ?? '').filter(Boolean);
          const serialized = JSON.stringify(rawRequest ?? {});
          warmModelRequests.push({ tools, bytes: Buffer.byteLength(serialized, 'utf8') });
          const cacheReceipt = recordNaturalPromptCacheUsage('warm', rawRequest);
          if (warmStep === 1) {
            assert.ok(warmAcceptedSource, 'the warm source is durable before memory reaches the model');
            const warmSeq = warmAcceptedSource!.seq;
            const count = (table: string, withSource = true): number => (
              db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?${withSource ? ' AND source_user_seq = ?' : ''}`)
                .get(...(withSource ? [warmSession.id, warmSeq] : [warmSession.id])) as { n: number }
            ).n;
            preModelAuthority = {
              logicalCalls: count('logical_tool_calls'),
              capabilityBindings: count('host_call_capability_bindings'),
              physicalDispatches: count('physical_dispatches'),
              taskResolutions: count('accepted_task_resolutions'),
              approvals: count('pending_approvals', false),
            };
            assert.deepEqual(preModelAuthority, {
              logicalCalls: 0,
              capabilityBindings: 0,
              physicalDispatches: 0,
              taskResolutions: 0,
              approvals: 0,
            }, 'candidate recall is context only; it mints no call/effect/account/approval rows');
            assert.match(serialized, new RegExp(RESTAURANT_OPERATION));
            assert.match(serialized, /advisory|nothing here is pre-authorized/i);
            assert.ok(tools.includes(PLAN_CONTROL));
            assert.ok(tools.includes('work_call'));
            assert.deepEqual({ restaurantReads, sheetCreates, calls: providerCalls.length }, providerBefore,
              'remembered capability context cannot cross before this response admits a fresh plan');
            return {
              ...cacheReceipt,
              output: [
                functionCall('admit-warm-natural-task', PLAN_CONTROL, {
                  preamble: PREAMBLE,
                  draft: {
                    criteria: [
                      'Exactly 10 distinct Santa Clarita restaurant rows are collected.',
                      'One new Google Sheet contains all and only those rows.',
                    ],
                    cardinality: { count: 10, fields: ['name', 'category', 'rating', 'address'] },
                    destination: { posture: 'create_new', family: 'googlesheets', handleRequired: true },
                    topology: {
                      version: 1,
                      operations: [
                        {
                          id: READ_REQUIREMENT,
                          effect: 'read',
                          coverage: 'complete_set',
                          dependsOn: [],
                          dataFrom: [],
                          cardinality: { kind: 'once' },
                        },
                        {
                          id: WRITE_REQUIREMENT,
                          effect: 'external_write',
                          coverage: null,
                          dependsOn: [READ_REQUIREMENT],
                          dataFrom: [READ_REQUIREMENT],
                          cardinality: { kind: 'once' },
                        },
                      ],
                      universes: [],
                    },
                    bindings: [
                      {
                        operationId: READ_REQUIREMENT,
                        role: 'source',
                        capabilityRef: 'cap:resolved:restaurants_search',
                        evidence: ['records'],
                      },
                      {
                        operationId: WRITE_REQUIREMENT,
                        role: 'destination',
                        capabilityRef: 'cap:resolved:googlesheets_sheet_from_json',
                        evidence: ['receipt'],
                      },
                    ],
                    deliverables: [{ id: 'warm-restaurant-sheet', kind: 'googlesheets' }],
                    evidenceRequirements: ['records', 'receipt'],
                  },
                }),
                functionCall('warm-restaurant-read', 'work_call', {
                  requirement_id: READ_REQUIREMENT,
                  universe_item_id: null,
                  universe_selector: null,
                  seal_amendment: null,
                  name: 'composio_execute_tool',
                  args_json: JSON.stringify({
                    tool_slug: RESTAURANT_OPERATION,
                    arguments: JSON.stringify({
                      location: 'Santa Clarita, CA',
                      category: 'restaurant',
                      limit: 10,
                    }),
                    connected_account_id: 'conn-restaurants',
                  }),
                }),
              ],
              responseId: 'warm-response-1',
            };
          }
          if (warmStep === 2) {
            assert.equal(tools.includes(PLAN_CONTROL), false);
            assert.ok(settledReadRows);
            return {
              ...cacheReceipt,
              output: [functionCall('warm-sheet-create', 'work_call', {
                requirement_id: WRITE_REQUIREMENT,
                universe_item_id: null,
                universe_selector: null,
                seal_amendment: null,
                name: 'composio_execute_tool',
                args_json: JSON.stringify({
                  tool_slug: SHEET_OPERATION,
                  arguments: JSON.stringify({
                    title: 'Santa Clarita Restaurants',
                    sheet_name: 'Restaurants',
                    sheet_json: JSON.stringify(settledReadRows),
                  }),
                  connected_account_id: 'conn-googlesheets',
                }),
              })],
              responseId: 'warm-response-2',
            };
          }
          return {
            ...cacheReceipt,
            output: [textMessage(JSON.stringify({
              summary: SUCCESS,
              reply: SUCCESS,
              done: true,
              nextAction: 'completed',
              reason: null,
            }))],
            responseId: 'warm-response-3',
          };
        },
        getStreamedResponse: streamResponse,
      };
      bridge._setBridgeImplsForTests({
        buildAgent: async (options) => buildOrchestratorAgent({
          ...options,
          model: warmModel as never,
        }),
      });
      const warmTrace: TraceEntry[] = [];
      const warmDelivery = recordingTransport(warmTrace);
      await discord.runDiscordHarnessConversation({
        prompt: PROMPT,
        rawPrompt: PROMPT,
        channelId: 'discord-channel-natural-request',
        userId: 'discord-user-natural-request',
        guildId: 'discord-guild-natural-request',
        transport: warmDelivery.transport,
        durableRequest: {
          sessionId: warmSession.id,
          runId: 'discord-natural-restaurant-sheet-request-warm',
          onSourceAccepted(source: { seq: number; turn: number }) {
            warmAcceptedSource = { seq: source.seq, turn: source.turn };
            completionReviewSource = { sessionId: warmSession.id, seq: source.seq };
          },
        },
      });

      assert.ok(preModelAuthority);
      assert.equal(warmStep, 3,
        'verified capability memory removes discovery without adding a refusal/model round');
      assert.equal(warmModelRequests.length, 3);
      const coldCacheUsage = cacheUsageRecords.filter((entry) => entry.run === 'cold');
      const warmCacheUsage = cacheUsageRecords.filter((entry) => entry.run === 'warm');
      assert.equal(coldCacheUsage.length, 4);
      assert.equal(warmCacheUsage.length, 3);
      const coldUncachedInputTokens = coldCacheUsage.reduce(
        (sum, entry) => sum + entry.uncachedInputTokens,
        0,
      );
      const warmUncachedInputTokens = warmCacheUsage.reduce(
        (sum, entry) => sum + entry.uncachedInputTokens,
        0,
      );
      const warmCachedInputTokens = warmCacheUsage.reduce(
        (sum, entry) => sum + entry.cachedInputTokens,
        0,
      );
      assert.ok(warmCachedInputTokens > 0,
        'the recording provider certifies a reused stable prefix on the verified warm journey');
      assert.ok(
        warmUncachedInputTokens * 100 <= coldUncachedInputTokens * 70,
        `verified warm natural journey must use <=70% of cold uncached input: ${JSON.stringify({
          coldUncachedInputTokens,
          warmUncachedInputTokens,
          warmCachedInputTokens,
          cold: coldCacheUsage.map(({ inputTokens, cachedInputTokens, uncachedInputTokens }) => ({
            inputTokens,
            cachedInputTokens,
            uncachedInputTokens,
          })),
          warm: warmCacheUsage.map(({ inputTokens, cachedInputTokens, uncachedInputTokens }) => ({
            inputTokens,
            cachedInputTokens,
            uncachedInputTokens,
          })),
        })}`,
      );
      assert.deepEqual({
        restaurantReads: restaurantReads - providerBefore.restaurantReads,
        sheetCreates: sheetCreates - providerBefore.sheetCreates,
        calls: providerCalls.length - providerBefore.calls,
      }, { restaurantReads: 1, sheetCreates: 1, calls: 2 });
      const warmEvents = eventlog.listEvents(warmSession.id);
      assert.equal(warmEvents.some((event) =>
        event.type === 'tool_called' && event.data.tool === 'tool_search'), false,
      'the receipt-backed exact path removes the broad rediscovery round');
      assert.equal(providerDefinitionRequests.filter((request) =>
        request.search !== null || request.tools.length === 0).length, broadDefinitionReadsBefore,
      'warm routing may exactly revalidate selected definitions but does not enumerate/search again');
      const warmSeq = warmAcceptedSource!.seq;
      const warmBindings = db.prepare(`
        SELECT logical_tool_call_id, account_id, effect
          FROM host_call_capability_bindings
         WHERE session_id = ? AND source_user_seq = ?
           AND logical_tool_call_id IN ('warm-restaurant-read', 'warm-sheet-create')
         ORDER BY logical_tool_call_id
      `).all(warmSession.id, warmSeq) as Array<{
        logical_tool_call_id: string;
        account_id: string;
        effect: string;
      }>;
      assert.deepEqual(warmBindings, [
        { logical_tool_call_id: 'warm-restaurant-read', account_id: 'conn-restaurants', effect: 'read' },
        { logical_tool_call_id: 'warm-sheet-create', account_id: 'conn-googlesheets', effect: 'external_write' },
      ], 'fresh host admission—not memory—mints exact effect/account bindings');
      assert.deepEqual(db.prepare(`
        SELECT approval_id FROM pending_approvals WHERE session_id = ?
      `).all(warmSession.id), [], 'candidate recall never manufactures approval authority');
      assert.equal(warmDelivery.errors.length, 0);
      assert.equal(warmDelivery.edits.at(-1), SUCCESS);
      assert.equal(completionReviews.filter(review => review.sessionId === warmSession.id
        && review.seq === warmAcceptedSource!.seq).length, 1);
      const warmCompletion = eventlog.listEvents(warmSession.id).find(event =>
        event.type === 'conversation_completed' && event.data.sourceUserSeq === warmAcceptedSource!.seq);
      assert.equal((warmCompletion?.data.completionVerdictRef as Record<string, unknown>)?.verified, true);
      assert.equal((warmCompletion?.data.completionVerdictRef as Record<string, unknown>)?.ownerSelectedJudge, true);
    },
  );

  await t.test(
    'discovery and tool-result context stay bounded as the requested collection and task duration grow',
    { timeout: 90_000 },
    async () => {
      assert.equal(BOUNDED_LOCATIONS.length, 24);
      assert.equal(new Set(BOUNDED_LOCATIONS).size, BOUNDED_LOCATIONS.length);
      const boundedSession = eventlog.createSession({
        id: 'discord-natural-restaurant-collection-bounded',
        kind: 'chat',
        userId: 'discord-user-natural-request',
      });
      const reviewCallsBeforeBounded = completionReviews.length;
      const definitionRequestStart = providerDefinitionRequests.length;
      const providerCallStart = providerCalls.length;
      const restaurantReadStart = restaurantReads;
      const modelRequests: Array<{
        step: number;
        bytes: number;
        tools: string[];
      }> = [];
      let accepted: { seq: number; turn: number } | null = null;
      let step = 0;
      const boundedModel = {
        async getResponse(rawRequest: unknown) {
          step += 1;
          const request = (rawRequest ?? {}) as { tools?: Array<{ name?: string }> };
          const tools = (request.tools ?? []).map((entry) => entry.name ?? '').filter(Boolean);
          const serialized = JSON.stringify(rawRequest ?? {});
          modelRequests.push({
            step,
            bytes: Buffer.byteLength(serialized, 'utf8'),
            tools,
          });
          if (step === 1) {
            assert.ok(accepted, 'the long collection source is durable before its planning card');
            assert.match(serialized, new RegExp(RESTAURANT_OPERATION));
            assert.ok(tools.includes(PLAN_CONTROL));
            assert.ok(tools.includes('work_call'));
            return {
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
              output: [functionCall('admit-bounded-collection', PLAN_CONTROL, {
                preamble: `I’ll collect twenty restaurant records from each of the ${BOUNDED_LOCATIONS.length} named areas and summarize the complete set.`,
                draft: {
                  criteria: [
                    `All ${BOUNDED_LOCATIONS.length} accepted area members are read exactly once.`,
                    'Every area returns one complete set of exactly 20 restaurant records.',
                    'The terminal summary covers the complete 480-record collection.',
                  ],
                  cardinality: { count: 480, fields: ['id', 'name', 'location', 'detail'] },
                  topology: {
                    version: 1,
                    operations: [{
                      id: 'read_each_area',
                      effect: 'read',
                      coverage: 'single',
                      dependsOn: [],
                      dataFrom: [],
                      cardinality: { kind: 'each', universeId: 'accepted_areas' },
                    }],
                    universes: [{
                      id: 'accepted_areas',
                      seal: 'accepted_input',
                      members: [...BOUNDED_LOCATIONS],
                    }],
                  },
                  bindings: [{
                    operationId: 'read_each_area',
                    role: 'source',
                    capabilityRef: 'cap:resolved:restaurants_search',
                    evidence: ['records'],
                  }],
                  deliverables: [{ id: 'restaurant-collection', kind: 'records' }],
                  evidenceRequirements: ['records'],
                },
              })],
              responseId: 'bounded-response-1',
            };
          }
          if (step >= 2 && step <= 7) {
            assert.equal(tools.includes(PLAN_CONTROL), false,
              'the accepted long task keeps one frozen plan across every read wave');
            const offset = (step - 2) * 4;
            return {
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
              output: BOUNDED_LOCATIONS.slice(offset, offset + 4).map((location, index) =>
                functionCall(`bounded-read-${String(offset + index + 1).padStart(2, '0')}`, 'work_call', {
                  requirement_id: 'read_each_area',
                  universe_item_id: location,
                  universe_selector: { argument_pointer: '/location', member_id_pointer: null },
                  seal_amendment: null,
                  name: 'composio_execute_tool',
                  args_json: JSON.stringify({
                    tool_slug: RESTAURANT_OPERATION,
                    arguments: JSON.stringify({
                      location,
                      category: 'restaurant',
                      limit: 20,
                    }),
                    connected_account_id: 'conn-restaurants',
                  }),
                })),
              responseId: `bounded-response-${step}`,
            };
          }
          return {
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
            output: [textMessage(JSON.stringify({
              summary: BOUNDED_SUCCESS,
              reply: BOUNDED_SUCCESS,
              done: true,
              nextAction: 'completed',
              reason: null,
            }))],
            responseId: `bounded-response-${step}`,
          };
        },
        getStreamedResponse: streamResponse,
      };
      bridge._setBridgeImplsForTests({
        buildAgent: async (options) => buildOrchestratorAgent({
          ...options,
          model: boundedModel as never,
        }),
      });
      const trace: TraceEntry[] = [];
      const delivery = recordingTransport(trace);
      providerScenario = 'bounded_collection';
      boundedProviderPayloadBytes = 0;
      try {
        await discord.runDiscordHarnessConversation({
          prompt: BOUNDED_PROMPT,
          rawPrompt: BOUNDED_PROMPT,
          channelId: 'discord-channel-natural-request',
          userId: 'discord-user-natural-request',
          guildId: 'discord-guild-natural-request',
          transport: delivery.transport,
          durableRequest: {
            sessionId: boundedSession.id,
            runId: 'discord-natural-restaurant-collection-bounded-request',
            onSourceAccepted(source: { seq: number; turn: number }) {
              accepted = { seq: source.seq, turn: source.turn };
            },
          },
        });
      } finally {
        providerScenario = 'standard';
      }

      assert.ok(accepted);
      assert.equal(step, 8, JSON.stringify(modelRequests));
      assert.equal(restaurantReads - restaurantReadStart, BOUNDED_LOCATIONS.length);
      assert.equal(providerCalls.length - providerCallStart, BOUNDED_LOCATIONS.length);
      assert.ok(boundedProviderPayloadBytes > 16 * 1024 * 1024,
        `fixture must materially outgrow model context: ${boundedProviderPayloadBytes}`);
      const seq = accepted!.seq;
      const boundedBindings = db.prepare(`
        SELECT COUNT(*) AS n,
               COUNT(DISTINCT universe_item_id) AS item_n,
               COUNT(DISTINCT logical_tool_call_id) AS logical_n
          FROM expected_work_call_bindings
         WHERE session_id = ? AND source_user_seq = ?
           AND requirement_id = 'read_each_area'
           AND universe_selector_json = ?
      `).get(
        boundedSession.id,
        seq,
        JSON.stringify({ argumentPointer: '/location', memberIdPointer: null }),
      ) as { n: number; item_n: number; logical_n: number };
      assert.deepEqual(boundedBindings, {
        n: BOUNDED_LOCATIONS.length,
        item_n: BOUNDED_LOCATIONS.length,
        logical_n: BOUNDED_LOCATIONS.length,
      }, 'every requested area owns one exact immutable work binding');
      const durable = db.prepare(`
        SELECT COUNT(*) AS n,
               SUM(raw_byte_count) AS raw_bytes,
               COUNT(DISTINCT logical_tool_call_id) AS logical_n
          FROM durable_result_handles
         WHERE session_id = ? AND source_user_seq = ?
           AND logical_tool_call_id LIKE 'bounded-read-%'
      `).get(boundedSession.id, seq) as {
        n: number;
        raw_bytes: number;
        logical_n: number;
      };
      assert.deepEqual({ n: durable.n, logical_n: durable.logical_n }, {
        n: BOUNDED_LOCATIONS.length,
        logical_n: BOUNDED_LOCATIONS.length,
      });
      assert.equal(durable.raw_bytes, boundedProviderPayloadBytes,
        'all provider result bytes remain durably addressable even when absent from model context');
      const boundedEvents = eventlog.listEvents(boundedSession.id);
      const inFlightCompaction = boundedEvents.find((event) =>
        event.type === 'condenser_applied' && event.data.inFlight === true);
      assert.ok(inFlightCompaction, JSON.stringify(boundedEvents.filter((event) =>
        event.type === 'condenser_applied')));
      const maximumRequestBytes = Math.max(...modelRequests.map((request) => request.bytes));
      const lateRequestBytes = modelRequests.at(-1)!.bytes;
      assert.ok(modelRequests[0]!.bytes < 80_000,
        `the discovery/planning card grew with collection cardinality: ${modelRequests[0]!.bytes}`);
      assert.ok(maximumRequestBytes < 768 * 1024,
        `model-visible context exceeded the hard long-task ceiling: ${maximumRequestBytes}`);
      assert.ok(maximumRequestBytes * 20 < boundedProviderPayloadBytes,
        JSON.stringify({ maximumRequestBytes, boundedProviderPayloadBytes }));
      assert.ok(lateRequestBytes <= maximumRequestBytes);
      const definitionRequests = providerDefinitionRequests.slice(definitionRequestStart);
      assert.ok(definitionRequests.length <= 2, JSON.stringify(definitionRequests));
      assert.ok(definitionRequests.every((request) =>
        request.search === null
        && request.toolkits.length === 0
        && request.tools.length === 1
        && request.tools[0] === RESTAURANT_OPERATION),
      `task duration cannot trigger repeated broad discovery: ${JSON.stringify(definitionRequests)}`);
      const providerCrossings = db.prepare(`
        SELECT COUNT(*) AS n, COUNT(DISTINCT physical_dispatch_id) AS physical_n
          FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ?
           AND logical_tool_call_id LIKE 'bounded-read-%'
           AND state = 'returned'
      `).get(boundedSession.id, seq) as { n: number; physical_n: number };
      assert.deepEqual(providerCrossings, {
        n: BOUNDED_LOCATIONS.length,
        physical_n: BOUNDED_LOCATIONS.length,
      });
      assert.equal(delivery.errors.length, 0);
      assert.equal(delivery.followups.length, 0);
      const boundedCompletion = boundedEvents.find(event => event.type === 'conversation_completed'
        && event.data.sourceUserSeq === seq);
      const boundedReviewRef = boundedCompletion?.data.completionVerdictRef as Record<string, unknown>;
      assert.equal(boundedReviewRef?.verified, false);
      assert.equal(boundedReviewRef?.failedOpen, true);
      assert.equal(boundedReviewRef?.disposition, 'enabled_unavailable');
      const boundedReview = boundedEvents.find(event => event.id === boundedReviewRef.eventId);
      assert.equal(boundedReview?.type, 'goal_alignment_judged');
      assert.equal(boundedReview?.data.sourceUserSeq, seq);
      assert.match(String(boundedReview?.data.reason), /Complete evidence review unavailable/);
      assert.equal(completionReviews.length, reviewCallsBeforeBounded,
        'the real model-window admission never sends a clipped 16MiB evidence set to the reviewer');
      assert.ok(delivery.edits.at(-1)?.startsWith(`${BOUNDED_SUCCESS}\n\nVerification note:`));
      assert.ok(delivery.edits.at(-1)?.includes(String(boundedReview?.data.reason)));
      assert.match(delivery.edits.at(-1) ?? '', /This result remains unreviewed\./);
    },
  );
});

// Cross-process restart is enforced by host-process-restart-settled.test.ts,
// which reopens the exact settled read and write in a fresh OS process without
// another provider body. Shared chat/workflow call ownership is enforced by
// harness-restart-kernel-parity.red.test.ts. Keep those production gates beside
// this natural journey in the release matrix; they are not fixture assumptions.
