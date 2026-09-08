/**
 * Run: node scripts/run-tests-isolated.mjs src/journeys/gauntlet-sheet-act-admission.integration.test.ts
 *
 * Regression pin for the 2026-08-26 gauntlet break B1 (tag-blocking): the
 * chat act lane was structurally write-dead. The live act-interpretation prep
 * enumerated the catalog BEFORE the model turn and durably froze an EMPTY
 * accepted-source snapshot; every plan proposal — including ones citing a
 * capability disclosed by tool_search in the SAME turn — then died
 * plan_not_admitted ("frozen host catalog mismatch" / "not disclosed to this
 * source"). 22 turns, ~249 tool calls, zero external effects.
 *
 * This journey walks the S1 prompt shape through the REAL front door with the
 * live pre-condition reproduced:
 *   accepted source → pre-model prep catalog enumeration (the live freezer) →
 *   foreground tool_search discovery → composio disclosure → plan_task
 *   admission → sealed dispatch authority → the sheet write DISPATCHES.
 * Only the model wire and the connected provider wire are injected, exactly
 * like the neighboring restaurant-sheet journey; no live network.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { currentSourceAccountReviewer } from './gauntlet-sheet-account-review.fixture-support.js';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-gauntlet-sheet-admission-'));
const PROMPT = 'Make me a google sheet called Gauntlet Sheet with a header row: Scenario, Status, Notes';
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/fixture-gauntlet-sheet-0001/edit';
const SUCCESS = `Created the Gauntlet Sheet with its header row: ${SHEET_URL}`;
const PREAMBLE = 'I’ll create one new Google Sheet named Gauntlet Sheet with the header row Scenario, Status, Notes.';
const SHEET_OPERATION = 'GOOGLESHEETS_CREATE_SPREADSHEET';
const PLAN_CONTROL = 'plan_task';
const WRITE_REQUIREMENT = 'write_once';

const SHEET_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['title', 'header_row'],
  properties: {
    title: { type: 'string' },
    header_row: { type: 'array', items: { type: 'string' } },
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
process.env.CLEMMY_BRAIN_FALLOVER = 'off';
process.env.CLEMMY_AUTH_FALLOVER = 'off';
process.env.CLEMMY_PROACTIVE_REPORT_DEFER = 'off';
process.env.CLEMMY_PLAN_FIRST = 'off';
process.env.CLEMMY_DYNAMIC_REASONING = 'off';
process.env.CLEMMY_EVAL_AUTO_PROMOTE = 'off';
process.env.COMPOSIO_API_KEY = 'fixture-composio-key';
process.env.COMPOSIO_USER_ID = 'fixture-user';

mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-gauntlet-sheet-admission\n', 'utf8');
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
const indexedCatalog = await import('../runtime/harness/indexed-capability-catalog.js');
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

test('S1 prompt: prep-frozen turn still admits and dispatches the same-turn-disclosed sheet write', { timeout: 120_000 }, async () => {
  eventlog.resetEventLog();
  resetHarnessRuntimeConfig();
  proactivity.saveProactivityPolicy({ autoApproveScope: 'strict' });

  const session = eventlog.createSession({
    id: 'discord-gauntlet-sheet-admission',
    kind: 'chat',
    userId: 'discord-user-gauntlet',
  });

  const configured = await configureHarnessRuntime();
  assert.equal(configured.ok, true, configured.ok ? '' : configured.reason);

  productionAdapters.installProductionTransport(async () => {
    throw new Error('journey forbids direct catalog execution outside work_call');
  });

  const factory = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  assert.ok(factory, 'runtime installs one empty searchable host catalog');
  productionPorts.clearProductionCapabilityPorts();

  connectedCatalog.installConnectedRegistryPort(() => ({
    connectedToolkits: ['googlesheets'],
    tools: [
      { slug: SHEET_OPERATION, schema: SHEET_SCHEMA as unknown as Record<string, unknown> },
    ],
  }));

  const rawTools = [{
    slug: SHEET_OPERATION,
    name: 'Create Google Sheet',
    description: 'Create one new Google Sheet with an optional header row.',
    toolkit: { slug: 'googlesheets' },
    inputParameters: SHEET_SCHEMA,
    outputParameters: SHEET_OUTPUT_SCHEMA,
    version: 'fixture-googlesheets-v1',
  }];
  composioClient.__test__.setComposioApiKeyOverride('fixture-composio-key');
  composioClient.__test__.setConnectedAccountsLoader(async () => [
    { id: 'conn-googlesheets', status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'googlesheets' } },
  ]);
  const providerWrites: Array<Record<string, unknown>> = [];
  composioClient.__test__.setComposioClient({
    client: { baseURL: 'https://backend.composio.dev' },
    getClient: () => ({
      withOptions: () => ({
        tools: {
          execute: async (
            operation: string,
            body: { arguments?: unknown },
          ) => {
            assert.equal(operation, SHEET_OPERATION);
            const args = body.arguments as Record<string, unknown>;
            providerWrites.push(structuredClone(args));
            assert.equal(args.title, 'Gauntlet Sheet');
            return {
              data: {
                successful: true,
                spreadsheetId: 'gauntlet-sheet',
                spreadsheetUrl: SHEET_URL,
              },
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
        assert.match(serialized, /Gauntlet Sheet/, 'the first step sees the accepted request');
        assert.ok(tools.includes('tool_search'), 'blank state exposes metadata discovery');
        discoveredRoleKey = serialized.match(/clause-\d+:[a-z_]+/i)?.[0] ?? null;
        output = [functionCall('discover-sheet-write', 'tool_search', {
          query: 'create a new google sheet with a header row',
          role_key: discoveredRoleKey,
          limit: 8,
        })];
      } else if (primaryStep === 2) {
        assert.match(serialized, new RegExp(SHEET_OPERATION),
          'foreground discovery returns the sheet operation');
        assert.match(serialized, /cap:resolved:googlesheets_create_spreadsheet/,
          'the exact disclosed write ref reaches the model');
        assert.ok(tools.includes(PLAN_CONTROL),
          'disclosure exposes plan_task on the next model surface');
        output = [functionCall('admit-gauntlet-sheet', PLAN_CONTROL, {
          preamble: PREAMBLE,
          draft: {
            criteria: [
              'One new Google Sheet named "Gauntlet Sheet" exists with the header row Scenario, Status, Notes.',
            ],
            cardinality: null,
            destination: { posture: 'create_new', family: 'googlesheets', handleRequired: true },
            topology: {
              version: 1,
              operations: [{
                id: WRITE_REQUIREMENT,
                effect: 'external_write',
                coverage: null,
                dependsOn: [],
                dataFrom: [],
                cardinality: { kind: 'once' },
              }],
              universes: [],
            },
            bindings: [{
              operationId: WRITE_REQUIREMENT,
              role: 'destination',
              capabilityRef: 'cap:resolved:googlesheets_create_spreadsheet',
              evidence: ['receipt'],
            }],
            deliverables: [{ id: 'gauntlet-sheet', kind: 'googlesheets' }],
            evidenceRequirements: ['receipt'],
          },
        })];
      } else if (primaryStep === 3) {
        const planRecord = eventlog.getToolOutput(session.id, 'admit-gauntlet-sheet') as { output?: unknown } | null;
        const planText = String(planRecord?.output ?? '');
        assert.match(planText, /"ok":\s*true/,
          `plan_task must admit the same-turn-disclosed write: `);
        assert.ok(tools.includes('work_call'), 'the activated business carrier is available');
        output = [functionCall('gauntlet-sheet-create', 'work_call', {
          requirement_id: WRITE_REQUIREMENT,
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: SHEET_OPERATION,
            arguments: JSON.stringify({
              title: 'Gauntlet Sheet',
              header_row: ['Scenario', 'Status', 'Notes'],
            }),
            connected_account_id: 'conn-googlesheets',
          }),
        })];
      } else {
        if (process.env.CLEM_GAUNTLET_PIN_DEBUG) {
          const { writeFileSync: debugWrite } = await import('node:fs');
          debugWrite(`${process.env.CLEM_GAUNTLET_PIN_DEBUG}.step4.json`, serialized, 'utf8');
        }
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
        responseId: `gauntlet-primary-${primaryStep}`,
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
  let prepEnumeratedEntries: string[] | null = null;
  await discord.runDiscordHarnessConversation({
    prompt: PROMPT,
    rawPrompt: PROMPT,
    channelId: 'discord-channel-gauntlet',
    userId: 'discord-user-gauntlet',
    guildId: 'discord-guild-gauntlet',
    transport,
    durableRequest: {
      sessionId: session.id,
      runId: 'discord-gauntlet-sheet-request-1',
      onSourceAccepted(source: { seq: number }) {
        acceptedSource = { seq: source.seq };
        // THE LIVE PRE-CONDITION: act interpretation/deterministic compile
        // enumerates the accepted-source catalog BEFORE the model turn. On
        // the broken build this call durably froze snapshot_json='[]' and
        // every later plan admission was refused against it.
        prepEnumeratedEntries = indexedCatalog.catalogEntriesForAcceptedSource({
          sessionId: session.id,
          sourceUserSeq: source.seq,
        }).map((entry) => entry.capabilityId);
      },
    },
  });

  assert.ok(acceptedSource, 'the exported Discord runner accepted one durable source');
  const sourceUserSeq = acceptedSource!.seq;
  assert.deepEqual(prepEnumeratedEntries, [],
    'pre-model prep ran against the blank catalog (the live freezer shape)');
  if (process.env.CLEM_GAUNTLET_PIN_DEBUG) {
    const { writeFileSync: debugWrite } = await import('node:fs');
    debugWrite(process.env.CLEM_GAUNTLET_PIN_DEBUG, JSON.stringify({
      planOutput: eventlog.getToolOutput(session.id, 'admit-gauntlet-sheet'),
      edits,
      events: eventlog.listEvents(session.id).map((event) => ({
        seq: event.seq, type: event.type, data: event.data,
      })),
    }, null, 1), 'utf8');
  }
  assert.equal(primaryStep, 4, JSON.stringify({
    planOutput: eventlog.getToolOutput(session.id, 'admit-gauntlet-sheet'),
    edits,
    events: eventlog.listEvents(session.id).map((event) => ({
      seq: event.seq, type: event.type, data: event.data,
    })),
  }));

  // Admission: the plan cited a capability that did not exist anywhere at
  // prep time and was disclosed by THIS turn's tool_search.
  const planRecord = eventlog.getToolOutput(session.id, 'admit-gauntlet-sheet') as { output?: unknown } | null;
  const planOutput = String(planRecord?.output ?? '');
  assert.match(planOutput, /"ok":\s*true/, planOutput);
  assert.doesNotMatch(planOutput, /plan_not_admitted|frozen host catalog|not disclosed/);

  // The durable frozen snapshot absorbed the same-turn disclosure: this is
  // the seam the gauntlet measured as snapshot_json='[]' on every act turn.
  const snapshotRow = eventlog.openEventLog().prepare(`
    SELECT snapshot_json FROM accepted_source_catalog_snapshots
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, sourceUserSeq) as { snapshot_json: string } | undefined;
  assert.ok(snapshotRow, 'plan admission persisted the accepted-source snapshot');
  assert.match(snapshotRow!.snapshot_json, /cap:resolved:googlesheets_create_spreadsheet/,
    'the frozen catalog contains the same-turn-disclosed write capability');

  // Dispatch authority: the selected graph capability is durably sealed.
  const sealed = capabilityCatalogs.loadSealedNodeBinding(session.id, sourceUserSeq, WRITE_REQUIREMENT);
  assert.ok(sealed, 'the admitted write operation received one exact durable node seal');
  assert.equal(sealed!.capabilityId, 'cap:resolved:googlesheets_create_spreadsheet');
  assert.equal(sealed!.effect, 'external_write');
  assert.equal(sealed!.providerOperationId, SHEET_OPERATION);

  // And the write actually DISPATCHED through the harness path.
  assert.equal(providerWrites.length, 1, 'exactly one sheet write crossed the provider wire');
  assert.equal(sha256(JSON.stringify(providerWrites[0]!.title)), sha256(JSON.stringify('Gauntlet Sheet')));

  // ≤1 approval (measured: none needed under the strict auto-approve policy).
  const approvalStops = eventlog.listEvents(session.id).filter((event) => [
    'approval_requested', 'approval_required', 'request_approval', 'awaiting_user_input',
  ].includes(event.type));
  assert.ok(approvalStops.length <= 1,
    `at most one approval may interpose: ${JSON.stringify(approvalStops)}`);
});

test('read surface: an exact disclosed read is admitted through the business carrier', { timeout: 120_000 }, async () => {
  // Gauntlet hole 12 (S5B, seq 82691): GOOGLEDRIVE_FIND_FILE, effect 'read',
  // was refused with "only admits configured harness-bounded tools" — the
  // boundary computed the read effect and the gate ignored it. A discovery
  // read must never kill a turn; the frozen-manifest proof is the WRITE bar.
  const DRIVE_OPERATION = 'GOOGLEDRIVE_FIND_FILE';
  const DRIVE_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: { query: { type: 'string' } },
  });
  proactivity.saveProactivityPolicy({ autoApproveScope: 'strict' });
  const session = eventlog.createSession({
    id: 'discord-gauntlet-drive-read',
    kind: 'chat',
    userId: 'discord-user-gauntlet-read',
  });

  semanticPorts.installTurnSemanticModelPort({
    async interpret() { throw new Error('hidden pre-loop semantic model pass'); },
    async judgeSourceEffect() { throw new Error('hidden pre-loop semantic effect judge'); },
    async judgePlanGrounding() { throw new Error('hidden pre-loop semantic grounding judge'); },
    judgeAccountSelection: currentSourceAccountReviewer({
      sessionId: () => session.id, acceptedText: 'Is there already a sheet called Gauntlet Sheet in my google drive?', toolkit: 'googledrive',
      accountIdentity: 'conn-googledrive',
      acceptedSource: (id, seq) => eventlog.listEvents(id, { sinceSeq: seq - 1,
        types: ['user_input_received'], limit: 1 }).find(event => event.seq === seq),
    }),
  });

  connectedCatalog.installConnectedRegistryPort(() => ({
    connectedToolkits: ['googledrive'],
    tools: [
      { slug: DRIVE_OPERATION, schema: DRIVE_SCHEMA as unknown as Record<string, unknown> },
    ],
  }));
  composioClient.__test__.setConnectedAccountsLoader(async () => [
    { id: 'conn-googledrive', status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'googledrive' } },
  ]);
  let driveReads = 0;
  composioClient.__test__.setComposioClient({
    client: { baseURL: 'https://backend.composio.dev' },
    getClient: () => ({
      withOptions: () => ({
        tools: {
          execute: async (operation: string) => {
            assert.equal(operation, DRIVE_OPERATION);
            driveReads += 1;
            return {
              data: { files: [{ id: 'gauntlet-sheet', name: 'Gauntlet Sheet' }] },
              error: null,
              successful: true,
              log_id: `fixture-read-${driveReads}`,
            };
          },
        },
      }),
    }),
    tools: {
      async getRawComposioTools(input: { tools?: string[]; toolkits?: string[] }) {
        const exact = new Set((input.tools ?? []).map((value) => value.toUpperCase()));
        const toolkits = new Set((input.toolkits ?? []).map((value) => value.toLowerCase()));
        return [{
          slug: DRIVE_OPERATION,
          name: 'Find file in Google Drive',
          description: 'Find files by name in the connected Google Drive.',
          toolkit: { slug: 'googledrive' },
          inputParameters: DRIVE_SCHEMA,
          outputParameters: { type: 'object', properties: { files: { type: 'array' } } },
          version: 'fixture-googledrive-v1',
        }].filter((candidate) =>
          (exact.size === 0 || exact.has(candidate.slug))
          && (toolkits.size === 0 || toolkits.has(candidate.toolkit.slug)));
      },
      async execute() {
        throw new Error('journey forbids the legacy Composio high-level execute fallback');
      },
    },
  });
  // Selected-definition revalidation consumes the prepared connected-account
  // snapshot. The prior subtest prepared a Sheets-only account, so refresh the
  // fixture observation after replacing the loader with Drive.
  await composioClient.listUsableConnectedToolkits();

  let step = 0;
  let readResultSeen = '';
  const scriptedModel = {
    async getResponse(rawRequest: unknown) {
      const serialized = JSON.stringify(rawRequest ?? {});
      const tools = ((rawRequest as { tools?: Array<{ name?: string }> })?.tools ?? [])
        .map((entry) => entry.name ?? '')
        .filter(Boolean);
      step += 1;
      let output: unknown[];
      if (step === 1) {
        output = [functionCall('discover-drive-read', 'tool_search', {
          query: 'find a file in google drive',
          role_key: serialized.match(/clause-\d+:[a-z_]+/i)?.[0] ?? null,
          limit: 8,
        })];
      } else if (step === 2) {
        assert.match(serialized, new RegExp(DRIVE_OPERATION),
          'foreground discovery returns and proves the drive read');
        assert.ok(tools.includes(PLAN_CONTROL),
          'the exact disclosure makes plan_task reachable');
        output = [functionCall('admit-gauntlet-drive-read', PLAN_CONTROL, {
          preamble: 'I’ll check Google Drive for the existing Gauntlet Sheet.',
          draft: {
            criteria: ['The matching Google Drive file result is returned from the connected account.'],
            cardinality: { count: 1, fields: ['id', 'name'] },
            destination: { posture: 'named_existing', family: 'googledrive', handleRequired: false },
            topology: {
              version: 1,
              operations: [{
                id: 'find_existing_sheet',
                effect: 'read',
                coverage: 'complete_set',
                dependsOn: [],
                dataFrom: [],
                cardinality: { kind: 'once' },
              }],
              universes: [],
            },
            bindings: [{
              operationId: 'find_existing_sheet',
              role: 'source',
              capabilityRef: 'cap:resolved:googledrive_find_file',
              evidence: ['records'],
            }],
            deliverables: [{ id: 'drive-search-results', kind: 'evidence' }],
            evidenceRequirements: ['records'],
          },
        })];
      } else if (step === 3) {
        const plan = eventlog.getToolOutput(session.id, 'admit-gauntlet-drive-read') as { output?: unknown } | null;
        assert.match(String(plan?.output ?? ''), /"ok":\s*true/,
          `the exact read plan is durably admitted before execution: ${JSON.stringify(plan)}`);
        assert.ok(tools.includes('work_call'),
          'the admitted exact read is reachable through the business carrier');
        output = [functionCall('gauntlet-drive-find', 'work_call', {
          requirement_id: 'find_existing_sheet',
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: DRIVE_OPERATION,
            arguments: JSON.stringify({ query: 'Gauntlet Sheet' }),
            connected_account_id: 'conn-googledrive',
          }),
        })];
      } else {
        const readResult = (rawRequest as { input?: unknown[] }).input?.find((item) =>
          item && typeof item === 'object'
          && (item as { callId?: unknown }).callId === 'gauntlet-drive-find'
          && (item as { type?: unknown }).type === 'function_call_result');
        readResultSeen = JSON.stringify(readResult ?? '');
        output = [textMessage(JSON.stringify({
          summary: 'Found the Gauntlet Sheet in Drive.',
          reply: 'Found the Gauntlet Sheet in Drive.',
          done: true,
          nextAction: 'completed',
          reason: null,
        }))];
      }
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output,
        responseId: `gauntlet-read-${step}`,
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
    prompt: 'Is there already a sheet called Gauntlet Sheet in my google drive?',
    rawPrompt: 'Is there already a sheet called Gauntlet Sheet in my google drive?',
    channelId: 'discord-channel-gauntlet-read',
    userId: 'discord-user-gauntlet-read',
    guildId: 'discord-guild-gauntlet',
    transport,
    durableRequest: {
      sessionId: session.id,
      runId: 'discord-gauntlet-drive-read-1',
    },
  });

  assert.ok(step === 3 || step === 4, JSON.stringify(eventlog.listEvents(session.id).map((event) => ({
    seq: event.seq, type: event.type, data: event.data,
  }))));
  const durableRead = eventlog.getToolOutput(session.id, 'gauntlet-drive-find') as { output?: unknown } | null;
  readResultSeen ||= JSON.stringify(durableRead?.output ?? durableRead ?? '');
  const readPlan = eventlog.getToolOutput(session.id, 'admit-gauntlet-drive-read');
  assert.match(readResultSeen, /Gauntlet Sheet/,
    `the model received the read payload, not a refusal: ${readResultSeen}; plan=${JSON.stringify(readPlan)}`);
  assert.doesNotMatch(readResultSeen, /refused before dispatch/,
    'a proven discovery read must never die at the harness provenance wall');
  assert.equal(driveReads, 1, 'the proven read crossed the provider wire exactly once');
});
