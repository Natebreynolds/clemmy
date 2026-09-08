/**
 * Run: node scripts/run-tests-isolated.mjs src/journeys/gauntlet-sheet-two-op-admission.integration.test.ts
 *
 * Regression pin for the live 2026-08-26 empty-frozen-catalog RECURRENCE
 * (session sess-desktop-117cf0fdc389f60519f0ffd7): a host_v1 chat turn asked
 * to "make me a new google sheet ... with a header row" ran 12 successful
 * tool_search calls and recorded FIVE capability_discovered events (disclosure
 * genuinely happened), yet all 28 plan_task attempts refused
 * plan_not_admitted ("primary model planning catalog no longer matches the
 * frozen host catalog") and accepted_source_catalog_snapshots persisted
 * snapshot_json='[]' — empty, again — even though the two prior gauntlet
 * fixes (83a593b5 publication allowlist, 68544cee scoped readiness) are both
 * shipped and their own pins are green.
 *
 * The one shape none of the existing gauntlet-sheet pins exercise: the real
 * live draft bound TWO dependent external_write operations to TWO DIFFERENT
 * composio capabilities in a single plan_task call (create the sheet, then
 * write its header row) — every existing pin selects exactly one write. This
 * journey walks that exact two-operation shape through the real front door.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { currentSourceAccountReviewer } from './gauntlet-sheet-account-review.fixture-support.js';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-gauntlet-sheet-two-op-'));
const PROMPT = 'make me a new google sheet called Clem Release Gate 0826 with a header row: check, result, timestamp';
const SHEET_ID = 'fixture-two-op-sheet';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
const SUCCESS = `Created the sheet with its header row: ${SHEET_URL}`;
const PREAMBLE = 'I’m creating the new sheet and adding its three-column header row.';
const CREATE_OPERATION = 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1';
const UPDATE_OPERATION = 'GOOGLESHEETS_VALUES_UPDATE';
const READ_OPERATION = 'GOOGLESHEETS_BATCH_GET';
const PLAN_CONTROL = 'plan_task';
const CREATE_NODE = 'create_sheet';
const WRITE_NODE = 'write_headers';
const CREATE_REF = 'cap:resolved:googlesheets_create_google_sheet1';
const UPDATE_REF = 'cap:resolved:googlesheets_values_update';
const HEADER_RANGE = 'Sheet1!A1:C1';

const CREATE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    title: { type: 'string' },
    folder_id: { type: 'string' },
    folder_name: { type: 'string' },
  },
});
const PROVIDER_ENVELOPE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['data', 'successful'],
  properties: {
    data: { type: 'object' },
    error: {},
    successful: { type: 'boolean' },
  },
});
const UPDATE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['spreadsheet_id', 'range', 'values'],
  properties: {
    spreadsheet_id: { type: 'string' },
    range: { type: 'string' },
    values: { type: 'array', items: { type: 'array' } },
    value_input_option: { type: 'string' },
  },
});
const READ_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['spreadsheet_id'],
  properties: {
    spreadsheet_id: { type: 'string' },
    ranges: { type: 'array', items: { type: 'string' } },
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
process.env.CLEMMY_BRAIN_FALLOVER = 'off';
process.env.CLEMMY_AUTH_FALLOVER = 'off';
process.env.CLEMMY_PROACTIVE_REPORT_DEFER = 'off';
process.env.CLEMMY_PLAN_FIRST = 'off';
process.env.CLEMMY_DYNAMIC_REASONING = 'off';
process.env.CLEMMY_EVAL_AUTO_PROMOTE = 'off';
process.env.COMPOSIO_API_KEY = 'fixture-composio-key';
process.env.COMPOSIO_USER_ID = 'fixture-user';

mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-gauntlet-sheet-two-op\n', 'utf8');
writeFileSync(path.join(HOME, 'state', 'auth.json'), JSON.stringify({
  source: 'native',
  codexOauth: {
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
    lastRefresh: new Date().toISOString(),
  },
}), 'utf8');

const discord = await import('../channels/discord-harness.js');
const bridge = await import('../runtime/harness/respond-bridge.js');
const { configureHarnessRuntime, resetHarnessRuntimeConfig } = await import('../runtime/harness/codex-client.js');
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
const proactivity = await import('../agents/proactivity-policy.js');
const reflection = await import('../memory/reflection.js');
const memoryDb = await import('../memory/db.js');

reflection._testOnly_setReflectionExtractor(async () =>
  ({ facts: [], entities: [], pointers: [], resources: [], relationships: [] } as never));

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
  const toolCalls = output.some((item) => (item as { type?: string }).type === 'function_call');
  yield { type: 'response_started' } as never;
  yield { type: 'model', event: { type: 'finish', finishReason: toolCalls ? 'tool_calls' : 'stop' } } as never;
  yield {
    type: 'response_done',
    response: {
      id: typeof response.responseId === 'string' ? response.responseId : 'fixture-response',
      usage: response.usage ?? { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
    },
  } as never;
}

after(async () => {
  innerDispatch._setInnerDispatchToolsForTests(null);
  connectedCatalog.installConnectedRegistryPort(null);
  semanticPorts.installTurnSemanticModelPort(null);
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  productionPorts.clearProductionCapabilityPorts();
  productionAdapters.installProductionTransport(null);
  composioClient.__test__.setComposioClient(null);
  composioClient.__test__.setConnectedAccountsLoader(null);
  composioClient.__test__.setComposioApiKeyOverride(null);
  composioClient.resetComposioClient();
  bridge._setBridgeImplsForTests({});
  resetHarnessRuntimeConfig();
  reflection._testOnly_setReflectionExtractor(null);
  eventlog.closeEventLog();
  memoryDb.closeMemoryDb();
  globalThis.fetch = originalFetch;
  if (process.env.CLEM_GAUNTLET_PIN_DEBUG) {
    const { writeFileSync: debugWrite } = await import('node:fs');
    debugWrite(`${process.env.CLEM_GAUNTLET_PIN_DEBUG}.home.txt`, HOME, 'utf8');
  } else {
    rmSync(HOME, { recursive: true, force: true });
  }
});

test('two-op plan: create-then-write-headers selects two composio capabilities in one plan_task', { timeout: 120_000 }, async () => {
  eventlog.resetEventLog();
  resetHarnessRuntimeConfig();
  proactivity.saveProactivityPolicy({ autoApproveScope: 'strict' });

  const session = eventlog.createSession({
    id: 'discord-gauntlet-sheet-two-op',
    kind: 'chat',
    userId: 'discord-user-gauntlet-two-op',
  });

  const configured = await configureHarnessRuntime();
  assert.equal(configured.ok, true, configured.ok ? '' : configured.reason);

  const providerWrites: Array<{ operation: string; args: Record<string, unknown> }> = [];
  const providerCalls: Array<{
    operation: string;
    args: Record<string, unknown>;
    via: 'work_call' | 'catalog';
  }> = [];
  const headerValues = new Map<string, string[]>();
  productionAdapters.installProductionTransport(async (call) => {
    assert.equal(call.operationId, READ_OPERATION,
      'only the frozen verifier may use the direct catalog transport');
    assert.equal(call.accountId, 'conn-googlesheets');
    const args = structuredClone(call.args);
    const spreadsheetId = String(args.spreadsheet_id ?? '');
    const observed = headerValues.get(spreadsheetId);
    providerCalls.push({ operation: call.operationId, args, via: 'catalog' });
    return {
      data: {
        valueRanges: observed ? [{ range: HEADER_RANGE, values: [observed] }] : [],
      },
      error: null,
      successful: true,
    };
  });

  const factory = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  assert.ok(factory, 'runtime installs one empty searchable host catalog');
  productionPorts.clearProductionCapabilityPorts();

  connectedCatalog.installConnectedRegistryPort(() => ({
    connectedToolkits: ['googlesheets'],
    tools: [
      { slug: CREATE_OPERATION, schema: CREATE_SCHEMA as unknown as Record<string, unknown> },
      { slug: UPDATE_OPERATION, schema: UPDATE_SCHEMA as unknown as Record<string, unknown> },
      { slug: READ_OPERATION, schema: READ_SCHEMA as unknown as Record<string, unknown> },
    ],
  }));

  const rawTools = [
    {
      slug: CREATE_OPERATION,
      name: 'Create Google Sheet',
      description: 'Create one new Google Sheet.',
      toolkit: { slug: 'googlesheets' },
      inputParameters: CREATE_SCHEMA,
      outputParameters: PROVIDER_ENVELOPE_OUTPUT_SCHEMA,
      version: 'fixture-googlesheets-create-v1',
    },
    {
      slug: UPDATE_OPERATION,
      name: 'Update Google Sheet values',
      description: 'Write one exact range into an existing Google Sheet.',
      toolkit: { slug: 'googlesheets' },
      inputParameters: UPDATE_SCHEMA,
      outputParameters: PROVIDER_ENVELOPE_OUTPUT_SCHEMA,
      version: 'fixture-googlesheets-update-v1',
    },
    {
      slug: READ_OPERATION,
      name: 'Read Google Sheet values',
      description: 'Read values back from an existing Google Sheet by exact id.',
      toolkit: { slug: 'googlesheets' },
      inputParameters: READ_SCHEMA,
      outputParameters: PROVIDER_ENVELOPE_OUTPUT_SCHEMA,
      version: 'fixture-googlesheets-read-v1',
    },
  ];
  composioClient.__test__.setComposioApiKeyOverride('fixture-composio-key');
  composioClient.__test__.setConnectedAccountsLoader(async () => [
    { id: 'conn-googlesheets', status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'googlesheets' } },
  ]);
  composioClient.__test__.setComposioClient({
    client: { baseURL: 'https://backend.composio.dev' },
    getClient: () => ({
      withOptions: () => ({
        tools: {
          execute: async (
            operation: string,
            body: { arguments?: unknown },
          ) => {
            const args = body.arguments as Record<string, unknown>;
            providerWrites.push({ operation, args: structuredClone(args) });
            providerCalls.push({ operation, args: structuredClone(args), via: 'work_call' });
            if (operation === CREATE_OPERATION) {
              return {
                data: {
                  spreadsheetId: SHEET_ID,
                  spreadsheetUrl: SHEET_URL,
                },
                error: null,
                successful: true,
                log_id: `fixture-write-${providerWrites.length}`,
              };
            }
            if (operation === UPDATE_OPERATION) {
              headerValues.set(String(args.spreadsheet_id ?? ''), ['check', 'result', 'timestamp']);
            }
            return {
              data: { updatedCells: 3 },
              error: null,
              successful: true,
              log_id: `fixture-write-${providerWrites.length}`,
            };
          },
        },
      }),
    }),
    tools: {
      async getRawComposioTools(input: { tools?: string[]; toolkits?: string[] }) {
        const exact = new Set((input.tools ?? []).map((value) => value.toUpperCase()));
        const toolkits = new Set((input.toolkits ?? []).map((value) => value.toLowerCase()));
        return rawTools.filter((candidate) =>
          (exact.size === 0 || exact.has(candidate.slug))
          && (toolkits.size === 0 || toolkits.has(candidate.toolkit.slug)));
      },
      async execute() {
        throw new Error('journey forbids the legacy Composio high-level execute fallback');
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

  semanticPorts.installTurnSemanticModelPort({
    async interpret() { throw new Error('hidden pre-loop semantic model pass'); },
    async judgeSourceEffect() { throw new Error('hidden pre-loop semantic effect judge'); },
    async judgePlanGrounding() { throw new Error('hidden pre-loop semantic grounding judge'); },
    judgeAccountSelection: currentSourceAccountReviewer({
      sessionId: () => session.id, acceptedText: PROMPT, toolkit: 'googlesheets',
      accountIdentity: 'conn-googlesheets',
      acceptedSource: (id, seq) => eventlog.listEvents(id, { sinceSeq: seq - 1,
        types: ['user_input_received'], limit: 1 }).find(event => event.seq === seq),
    }),
  });

  const gateway = composioTools.getComposioRuntimeTools()
    .find((candidate) => candidate.name === 'composio_execute_tool');
  assert.ok(gateway, 'the journey uses the production Composio carrier around the raw provider wire');
  innerDispatch._setInnerDispatchToolsForTests(new Map([
    ['composio_execute_tool', gateway as never],
  ]));

  let primaryStep = 0;
  let discoveredRoleKey: string | null = null;
  const scriptedModel = {
    async getResponse(rawRequest: unknown) {
      const request = (rawRequest ?? {}) as { tools?: Array<{ name?: string }> };
      const tools = (request.tools ?? []).map((entry) => entry.name ?? '').filter(Boolean);
      const serialized = JSON.stringify(rawRequest ?? {});
      primaryStep += 1;
      let output: unknown[];
      if (primaryStep === 1) {
        assert.ok(tools.includes('tool_search'), 'blank state exposes metadata discovery');
        discoveredRoleKey = serialized.match(/clause-\d+:[a-z_]+/i)?.[0] ?? null;
        output = [functionCall('discover-sheet-create', 'tool_search', {
          query: 'create a new google sheet',
          role_key: discoveredRoleKey,
          limit: 8,
        })];
      } else if (primaryStep === 2) {
        assert.match(serialized, new RegExp(CREATE_OPERATION),
          'foreground discovery returns the sheet-create operation');
        assert.match(serialized, new RegExp(UPDATE_OPERATION),
          'the bounded discovery card also returns the sheet-update operation');
        assert.match(serialized, new RegExp(READ_OPERATION),
          'the bounded discovery card also publishes the exact host-owned readback verifier');
        assert.match(serialized, new RegExp(CREATE_REF.replace(/[:.]/g, '\\$&')),
          'the create ref stays disclosed on this same turn');
        assert.match(serialized, new RegExp(UPDATE_REF.replace(/[:.]/g, '\\$&')),
          'the update ref is disclosed on the same bounded card');
        assert.ok(tools.includes(PLAN_CONTROL), 'disclosure exposes plan_task on the next model surface');
        output = [functionCall('admit-two-op-plan', PLAN_CONTROL, {
          preamble: PREAMBLE,
          draft: {
            criteria: [
              'Create a Google Sheet titled "Clem Release Gate 0826" in the default Drive location.',
              'Set the first row of the initial worksheet to: check, result, timestamp.',
            ],
            cardinality: null,
            destination: { posture: 'create_new', family: 'google_sheet', handleRequired: true },
            topology: {
              version: 1,
              operations: [
                {
                  id: CREATE_NODE,
                  effect: 'external_write',
                  coverage: null,
                  dependsOn: [],
                  dataFrom: [],
                  cardinality: { kind: 'once' },
                },
                {
                  id: WRITE_NODE,
                  effect: 'external_write',
                  coverage: null,
                  dependsOn: [CREATE_NODE],
                  dataFrom: [CREATE_NODE],
                  cardinality: { kind: 'once' },
                },
              ],
              universes: [],
            },
            bindings: [
              { operationId: CREATE_NODE, role: 'create_google_sheet', capabilityRef: CREATE_REF, evidence: [] },
              { operationId: WRITE_NODE, role: 'write_google_sheet_values', capabilityRef: UPDATE_REF, evidence: [] },
            ],
            deliverables: [{ id: 'release_gate_sheet', kind: 'google_sheet' }],
            evidenceRequirements: [],
          },
        })];
      } else if (primaryStep === 3) {
        const planRecord = eventlog.getToolOutput(session.id, 'admit-two-op-plan') as { output?: unknown } | null;
        const planText = String(planRecord?.output ?? '');
        assert.match(planText, /"ok":\s*true/, `plan_task must admit the two-op write: ${planText}`);
        assert.ok(tools.includes('work_call'), 'the activated business carrier is available');
        output = [functionCall('two-op-create', 'work_call', {
          requirement_id: CREATE_NODE,
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: CREATE_OPERATION,
            arguments: JSON.stringify({ title: 'Clem Release Gate 0826' }),
            connected_account_id: 'conn-googlesheets',
          }),
        })];
      } else if (primaryStep === 4) {
        output = [functionCall('two-op-write', 'work_call', {
          requirement_id: WRITE_NODE,
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: UPDATE_OPERATION,
            arguments: JSON.stringify({
              spreadsheet_id: SHEET_ID,
              range: HEADER_RANGE,
              values: [['check', 'result', 'timestamp']],
              value_input_option: 'RAW',
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
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output,
        responseId: `gauntlet-two-op-${primaryStep}`,
      };
    },
    getStreamedResponse: streamResponse,
  };

  bridge._setBridgeImplsForTests({
    buildAgent: async (options) => buildOrchestratorAgent({
      ...options,
      model: scriptedModel as never,
    }),
  });

  const edits: string[] = [];
  const transport = {
    async sendInitial() {
      return { async edit(content: string) { edits.push(content); } };
    },
    async sendError(content: string) { edits.push(`ERROR:${content}`); },
    async sendFollowup(content: string) { edits.push(content); },
  };

  let acceptedSource: { seq: number } | null = null;
  await discord.runDiscordHarnessConversation({
    prompt: PROMPT,
    rawPrompt: PROMPT,
    channelId: 'discord-channel-gauntlet-two-op',
    userId: 'discord-user-gauntlet-two-op',
    guildId: 'discord-guild-gauntlet',
    transport,
    durableRequest: {
      sessionId: session.id,
      runId: 'discord-gauntlet-sheet-two-op-1',
      onSourceAccepted(source: { seq: number }) {
        acceptedSource = { seq: source.seq };
      },
    },
  });

  assert.ok(acceptedSource, 'the exported Discord runner accepted one durable source');
  const sourceUserSeq = acceptedSource!.seq;

  if (process.env.CLEM_GAUNTLET_PIN_DEBUG) {
    const { writeFileSync: debugWrite } = await import('node:fs');
    debugWrite(process.env.CLEM_GAUNTLET_PIN_DEBUG, JSON.stringify({
      planOutput: eventlog.getToolOutput(session.id, 'admit-two-op-plan'),
      edits,
      events: eventlog.listEvents(session.id).map((event) => ({
        seq: event.seq, type: event.type, data: event.data,
      })),
    }, null, 1), 'utf8');
  }

  const planRecord = eventlog.getToolOutput(session.id, 'admit-two-op-plan') as { output?: unknown } | null;
  const planOutput = String(planRecord?.output ?? '');
  assert.match(planOutput, /"ok":\s*true/, planOutput);
  assert.doesNotMatch(planOutput, /plan_not_admitted|frozen host catalog|not disclosed/);

  const snapshotRow = eventlog.openEventLog().prepare(`
    SELECT snapshot_json FROM accepted_source_catalog_snapshots
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, sourceUserSeq) as { snapshot_json: string } | undefined;
  assert.ok(snapshotRow, 'plan admission persisted the accepted-source snapshot');
  assert.match(snapshotRow!.snapshot_json, new RegExp(CREATE_REF.replace(/[:.]/g, '\\$&')),
    'the frozen catalog contains the create capability');
  assert.match(snapshotRow!.snapshot_json, new RegExp(UPDATE_REF.replace(/[:.]/g, '\\$&')),
    'the frozen catalog contains the write-headers capability');

  const sealedCreate = capabilityCatalogs.loadSealedNodeBinding(session.id, sourceUserSeq, CREATE_NODE);
  const sealedWrite = capabilityCatalogs.loadSealedNodeBinding(session.id, sourceUserSeq, WRITE_NODE);
  assert.ok(sealedCreate, 'the create node received one exact durable node seal');
  assert.ok(sealedWrite, 'the write-headers node received one exact durable node seal');
  assert.equal(sealedCreate!.capabilityId, CREATE_REF);
  assert.equal(sealedWrite!.capabilityId, UPDATE_REF);
  assert.ok(sealedCreate!.verification, 'the create seal carries its digest-covered identity recipe');
  assert.ok(sealedWrite!.verification, 'the update seal carries its digest-covered content recipe');

  assert.equal(providerWrites.length, 2, 'both the create and the header write crossed the provider wire');
  assert.equal(sha256(JSON.stringify(providerWrites[0]!.operation)), sha256(JSON.stringify(CREATE_OPERATION)));
  assert.equal(sha256(JSON.stringify(providerWrites[1]!.operation)), sha256(JSON.stringify(UPDATE_OPERATION)));
  assert.deepEqual(providerCalls.map((call) => call.operation), [
    CREATE_OPERATION,
    READ_OPERATION,
    UPDATE_OPERATION,
    READ_OPERATION,
  ], 'two model-authored business calls produce four durable provider phases');
  assert.deepEqual(providerCalls.map((call) => call.via), [
    'work_call', 'catalog', 'work_call', 'catalog',
  ], 'the model never emits a verifier read; both readbacks are host-owned child calls');
  assert.ok(providerCalls.filter((call) => call.operation === READ_OPERATION)
    .every((call) => call.args.spreadsheet_id === SHEET_ID),
  'both frozen verifier recipes use the exact created resource id');
});

test('two-op plan re-admitted on the same long-running daemon reuses current exact definitions', { timeout: 120_000 }, async () => {
  // Deliberately does NOT call eventlog.resetEventLog() or
  // resetHarnessRuntimeConfig(): production is one long-running daemon whose
  // capability_manifests table and in-memory HostCapabilityCatalogFactory
  // persist across many prior sessions. The live failing session
  // (sess-desktop-117cf0fdc389f60519f0ffd7) was NOT this daemon's first-ever
  // Google Sheets turn — the durable capability_manifests table already held
  // "current" entries for both googlesheets_create_google_sheet1 and
  // googlesheets_values_update under this exact account before that turn ran.
  // This subtest reuses the manifest store and factory the FIRST subtest just
  // populated (same account) and asks the exact same thing again, to find out
  // whether a REPEAT registration against an already-"current" durable
  // manifest behaves differently from a first-ever registration.
  proactivity.saveProactivityPolicy({ autoApproveScope: 'strict' });

  const session = eventlog.createSession({
    id: 'discord-gauntlet-sheet-two-op-replay',
    kind: 'chat',
    userId: 'discord-user-gauntlet-two-op',
  });

  semanticPorts.installTurnSemanticModelPort({
    async interpret() { throw new Error('hidden pre-loop semantic model pass'); },
    async judgeSourceEffect() { throw new Error('hidden pre-loop semantic effect judge'); },
    async judgePlanGrounding() { throw new Error('hidden pre-loop semantic grounding judge'); },
    judgeAccountSelection: currentSourceAccountReviewer({
      sessionId: () => session.id, acceptedText: PROMPT, toolkit: 'googlesheets',
      accountIdentity: 'conn-googlesheets',
      acceptedSource: (id, seq) => eventlog.listEvents(id, { sinceSeq: seq - 1,
        types: ['user_input_received'], limit: 1 }).find(event => event.seq === seq),
    }),
  });

  let primaryStep = 0;
  let discoveredRoleKey: string | null = null;
  const scriptedModel = {
    async getResponse(rawRequest: unknown) {
      const request = (rawRequest ?? {}) as { tools?: Array<{ name?: string }> };
      const tools = (request.tools ?? []).map((entry) => entry.name ?? '').filter(Boolean);
      const serialized = JSON.stringify(rawRequest ?? {});
      primaryStep += 1;
      let output: unknown[];
      if (primaryStep === 1) {
        assert.ok(tools.includes('tool_search'), 'blank state exposes metadata discovery');
        discoveredRoleKey = serialized.match(/clause-\d+:[a-z_]+/i)?.[0] ?? null;
        output = [functionCall('discover-sheet-create-2', 'tool_search', {
          query: 'create a new google sheet',
          role_key: discoveredRoleKey,
          limit: 8,
        })];
      } else if (primaryStep === 2) {
        assert.match(serialized, new RegExp(CREATE_OPERATION),
          'foreground discovery returns the sheet-create operation');
        assert.match(serialized, new RegExp(UPDATE_OPERATION),
          'the repeated bounded card republishes the sheet-update operation');
        assert.match(serialized, new RegExp(READ_OPERATION),
          'the repeated bounded card republishes the exact compatible verifier');
        assert.ok(tools.includes(PLAN_CONTROL), 'disclosure exposes plan_task on the next model surface');
        output = [functionCall('admit-two-op-plan-2', PLAN_CONTROL, {
          preamble: PREAMBLE,
          draft: {
            criteria: [
              'Create a Google Sheet titled "Clem Release Gate 0826" in the default Drive location.',
              'Set the first row of the initial worksheet to: check, result, timestamp.',
            ],
            cardinality: null,
            destination: { posture: 'create_new', family: 'google_sheet', handleRequired: true },
            topology: {
              version: 1,
              operations: [
                {
                  id: CREATE_NODE,
                  effect: 'external_write',
                  coverage: null,
                  dependsOn: [],
                  dataFrom: [],
                  cardinality: { kind: 'once' },
                },
                {
                  id: WRITE_NODE,
                  effect: 'external_write',
                  coverage: null,
                  dependsOn: [CREATE_NODE],
                  dataFrom: [CREATE_NODE],
                  cardinality: { kind: 'once' },
                },
              ],
              universes: [],
            },
            bindings: [
              { operationId: CREATE_NODE, role: 'create_google_sheet', capabilityRef: CREATE_REF, evidence: [] },
              { operationId: WRITE_NODE, role: 'write_google_sheet_values', capabilityRef: UPDATE_REF, evidence: [] },
            ],
            deliverables: [{ id: 'release_gate_sheet', kind: 'google_sheet' }],
            evidenceRequirements: [],
          },
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
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output,
        responseId: `gauntlet-two-op-replay-${primaryStep}`,
      };
    },
    getStreamedResponse: streamResponse,
  };

  bridge._setBridgeImplsForTests({
    buildAgent: async (options) => buildOrchestratorAgent({
      ...options,
      model: scriptedModel as never,
    }),
  });

  const transport = {
    async sendInitial() { return { async edit() {} }; },
    async sendError() {},
    async sendFollowup() {},
  };

  await discord.runDiscordHarnessConversation({
    prompt: PROMPT,
    rawPrompt: PROMPT,
    channelId: 'discord-channel-gauntlet-two-op',
    userId: 'discord-user-gauntlet-two-op',
    guildId: 'discord-guild-gauntlet',
    transport,
    durableRequest: {
      sessionId: session.id,
      runId: 'discord-gauntlet-sheet-two-op-replay-1',
    },
  });

  const planRecord = eventlog.getToolOutput(session.id, 'admit-two-op-plan-2') as { output?: unknown } | null;
  const planOutput = String(planRecord?.output ?? '');
  assert.match(planOutput, /"ok":\s*true/, planOutput);
  assert.doesNotMatch(planOutput, /plan_not_admitted|frozen host catalog|not disclosed/);
});
