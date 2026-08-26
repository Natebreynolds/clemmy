/**
 * Run: node scripts/run-tests-isolated.mjs src/journeys/gauntlet-sheet-stale-residue-admission.integration.test.ts
 *
 * Regression pin for the LIVE 2026-08-26 chat-door failure (session
 * sess-desktop-31f1e40397312d483270b1a2, sourceUserSeq 84693): a real desktop
 * turn made 9 tool_search calls, disclosed and staged
 * cap:resolved:googlesheets_create_spreadsheet with a proven Composio
 * definition, then called plan_task citing exactly that ref. All 3 plan_task
 * attempts refused "primary model planning catalog no longer matches the
 * frozen host catalog" and accepted_source_catalog_snapshots persisted
 * snapshot_json='[]' — completely empty — for the whole turn.
 *
 * gauntlet-sheet-act-admission.integration.test.ts subtest 1 exercises the
 * same admit-at-plan-time seam but starts from an EMPTY capability-manifest
 * store and factory, so it never reproduced this. The daemon that produced
 * the live failure is a long-running, multi-session process: its durable
 * capability_manifests table already held ~38 "current" manifests (mostly
 * other Google Sheets/Drive/Slack/Outlook composio operations) accumulated
 * from earlier, unrelated turns. This journey reproduces THAT shape: it
 * seeds the durable manifest store and the live host-capability-catalog
 * factory with a few "current" composio manifests whose independent
 * observation (independent-capability-observation.ts,
 * INDEPENDENT_OBSERVATION_FRESHNESS_MS = 60_000) is already stale — exactly
 * what a manifest installed by an earlier turn in the same process looks
 * like by the time a later turn touches it — then runs the SAME
 * tool_search -> plan_task -> work_call shape as subtest 1 for a brand-new
 * capability. It targets GOOGLESHEETS_CREATE_SPREADSHEET (subtest 1's own
 * operation) rather than the live incident's exact
 * GOOGLESHEETS_SHEET_FROM_JSON, which carries an unrelated documented
 * atomic-input-content-commit requirement (operation-semantics.ts) that has
 * nothing to do with this freeze bug; the admission mechanism under test is
 * identical for both operations.
 *
 * ROOT CAUSE this pin targets: registerProofProvisionedCapabilities (called
 * from admitAndCompilePrimaryModelProposal, BEFORE the plan-admission
 * freeze) calls refreshTypedExecutionReadiness() whenever it registers
 * anything. That readiness recompute's evaluateCatalogReadiness() treats
 * EVERY "current" manifest in the ENTIRE process-wide store as "required",
 * and forgets (removes from the live factory) any one whose independent
 * observation is missing or older than 60s (configure-typed-execution-
 * runtime.ts, observationMatchesRequired). The initial planning card
 * (primePrimaryModelPlanningCatalog -> rankedLivePlanningDescriptors) had
 * already ranked some of that stale residue into catalog.capabilities as
 * un-staged "initial" descriptors (real-catalog capabilities that lexically
 * matched the objective) purely because they were live in the shared
 * factory at prime time. The plan-admission validation loop
 * (admit-and-compile-accepted-source.ts) requires every un-staged initial
 * descriptor to still be present, byte-identical, in the just-frozen
 * snapshot — so the SAME-TURN registration of an unrelated, brand-new
 * capability collaterally wipes the initial descriptors' factory entries,
 * and admission refuses "no longer matches the frozen host catalog" even
 * though the freshly-disclosed, freshly-selected capability itself is fine.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-gauntlet-sheet-stale-residue-'));
const PROMPT = 'Make me a google sheet called Gauntlet Residue Sheet with a header row: Scenario, Status, Notes';
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/gauntlet-residue-sheet/edit';
const SUCCESS = `Created the Gauntlet Residue Sheet with its header row: ${SHEET_URL}`;
const PREAMBLE = 'I’ll create one new Google Sheet named Gauntlet Residue Sheet with the header row Scenario, Status, Notes.';
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
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-gauntlet-sheet-stale-residue\n', 'utf8');
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
const capabilityManifestStore = await import('../runtime/harness/capability-manifest-store.js');
const capabilityManifest = await import('../runtime/harness/capability-manifest.js');
const independentObservation = await import('../runtime/harness/independent-capability-observation.js');
const providerDefinitionIdentity = await import('../integrations/composio/provider-definition-identity.js');
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

/** Seed one "current" composio manifest into the durable store AND the live
 * factory, with its independent observation already older than the 60s
 * freshness window — exactly the shape of a capability an earlier, unrelated
 * turn registered in this same long-running daemon process. */
function seedStaleComposioResidue(input: {
  slug: string;
  accountId: string;
  purposeWords: string;
}): void {
  const store = capabilityManifestStore.peekCapabilityManifestStore() ?? capabilityManifestStore.resolveCapabilityManifestStore();
  const factory = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  assert.ok(factory, 'runtime installs one host capability catalog factory before residue seeding');
  const capabilityId = `cap:resolved:${input.slug.toLowerCase()}`;
  const inputSchema = { type: 'object', additionalProperties: false, properties: {} };
  const outputSchema = { type: 'object', additionalProperties: false, properties: {} };
  const providerInputSchemaDigest = sha256(JSON.stringify(inputSchema));
  const providerOutputSchemaDigest = sha256(JSON.stringify(outputSchema));
  const operationVersion = 'residue-fixture-v1';
  const invokePortId = `port:${capabilityId}:${input.slug}`;
  const definitionFingerprint = sha256(JSON.stringify({
    operationId: input.slug,
    operationVersion,
    accountId: input.accountId,
    invokePortId,
    providerInputSchemaDigest,
    providerOutputSchemaDigest,
  }));
  const manifest = capabilityManifest.attachSemanticContract({
    version: 1,
    manifestId: capabilityId,
    providerKind: 'composio',
    operationId: input.slug,
    providerIdentity: 'composio',
    providerVersion: providerDefinitionIdentity.COMPOSIO_PROVIDER_SURFACE_VERSION,
    operationVersion,
    definitionFingerprint,
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest,
      providerOutputSchemaObserved: true,
      providerOutputSchemaDigest,
      semanticName: input.slug,
      behaviorHints: { readOnly: null, destructive: null, idempotent: null, openWorld: null },
    },
    effect: 'read' as const,
    accountId: input.accountId,
    idempotency: { required: false, policy: 'none' as const },
    reconciliation: { supported: false, policy: 'none' as const },
    outputContract: { kind: 'records' as const },
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: { issuer: 'host:resolution-proof', issuedAt: '1970-01-01T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' as const },
    advisoryRoles: ['collection'],
    purpose: `earlier-turn residue: ${input.purposeWords}`,
    acceptedInputKinds: ['evidence'],
    producedOutputKinds: ['evidence', 'records'],
    applicableDeliverableKinds: ['evidence'],
    argumentCompiler: { id: 'compile:proof-schema:v1', version: '1' },
    invokePortId,
  });
  const installed = store.install(manifest);
  assert.ok(installed.ok, `residue manifest ${input.slug} installs cleanly: ${JSON.stringify(installed)}`);
  factory!.register({
    capabilityId,
    toolName: input.slug,
    schemaVersion: operationVersion,
    schemaDigest: definitionFingerprint,
    effect: 'read',
    advisoryRoles: ['collection'],
    manifestDigest: capabilityManifest.capabilityManifestDigest(manifest),
    providerKind: 'composio',
    providerInputSchemaDigest,
    liveFingerprint: definitionFingerprint,
    manifest,
    account: input.accountId,
    invoke: async () => [],
  });
  // Registered by an earlier turn, well past the 60s freshness window this
  // turn's own registration will check it against.
  const registeredObservation = independentObservation.registerIndependentCapabilityObservation({
    operationId: input.slug,
    accountId: input.accountId,
    definitionFingerprint,
    providerVersion: providerDefinitionIdentity.COMPOSIO_PROVIDER_SURFACE_VERSION,
    operationVersion,
    observedAt: Date.now() - (independentObservation.INDEPENDENT_OBSERVATION_FRESHNESS_MS + 5_000),
    origin: 'independent',
    observe: () => ({
      operationId: input.slug,
      accountId: input.accountId,
      definitionFingerprint,
      providerVersion: providerDefinitionIdentity.COMPOSIO_PROVIDER_SURFACE_VERSION,
      operationVersion,
      observedAt: Date.now() - (independentObservation.INDEPENDENT_OBSERVATION_FRESHNESS_MS + 5_000),
    }),
  });
  assert.ok(registeredObservation.ok, `residue observation for ${input.slug} registers: ${JSON.stringify(registeredObservation)}`);
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

test('S1-residue: stale process-wide catalog residue must not sink a same-turn-disclosed sheet write', { timeout: 120_000 }, async () => {
  eventlog.resetEventLog();
  resetHarnessRuntimeConfig();
  proactivity.saveProactivityPolicy({ autoApproveScope: 'strict' });

  const session = eventlog.createSession({
    id: 'discord-gauntlet-sheet-stale-residue',
    kind: 'chat',
    userId: 'discord-user-gauntlet-residue',
  });

  const configured = await configureHarnessRuntime();
  assert.equal(configured.ok, true, configured.ok ? '' : configured.reason);

  productionAdapters.installProductionTransport(async () => {
    throw new Error('journey forbids direct catalog execution outside work_call');
  });

  const factory = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  assert.ok(factory, 'runtime installs one empty searchable host catalog');
  productionPorts.clearProductionCapabilityPorts();

  // THE LIVE PRE-CONDITION: a long-running daemon's shared, process-wide
  // catalog already holds "current" composio manifests from earlier, unrelated
  // turns, each ranking into THIS turn's initial planning card purely by
  // lexical match against "google sheet" — and each one's independent
  // observation is already stale.
  seedStaleComposioResidue({
    slug: 'GOOGLESHEETS_BATCH_UPDATE',
    accountId: 'ca_residue_sheets',
    purposeWords: 'google sheet batch update spreadsheet',
  });
  seedStaleComposioResidue({
    slug: 'GOOGLESHEETS_GET_SPREADSHEET_INFO',
    accountId: 'ca_residue_sheets',
    purposeWords: 'google sheet spreadsheet info',
  });
  seedStaleComposioResidue({
    slug: 'GOOGLESHEETS_VALUES_UPDATE',
    accountId: 'ca_residue_sheets',
    purposeWords: 'google sheet values update spreadsheet',
  });

  connectedCatalog.installConnectedRegistryPort(() => ({
    connectedToolkits: ['googlesheets'],
    tools: [
      { slug: SHEET_OPERATION, schema: SHEET_SCHEMA as unknown as Record<string, unknown> },
    ],
  }));

  const rawTools = [{
    slug: SHEET_OPERATION,
    name: 'Create Google Sheet from JSON',
    description: 'Create one new Google Sheet with an optional header row.',
    toolkit: { slug: 'googlesheets' },
    inputParameters: SHEET_SCHEMA,
    outputParameters: SHEET_OUTPUT_SCHEMA,
    version: 'fixture-googlesheets-v1',
  }];
  composioClient.__test__.setComposioApiKeyOverride('fixture-composio-key');
  composioClient.__test__.setConnectedAccountsLoader(async () => [
    { id: 'conn-googlesheets-residue', status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'googlesheets' } },
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
            assert.equal(args.title, 'Gauntlet Residue Sheet');
            return {
              data: {
                successful: true,
                spreadsheetId: 'gauntlet-residue-sheet',
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
  });

  const gateway = composioTools.getComposioRuntimeTools()
    .find((candidate) => candidate.name === 'composio_execute_tool');
  assert.ok(gateway, 'the journey uses the production Composio carrier around the raw provider wire');
  innerDispatch._setInnerDispatchToolsForTests(new Map([
    ['composio_execute_tool', gateway as never],
  ]));

  let primaryStep = 0;
  const scriptedModel = {
    async getResponse(rawRequest: unknown) {
      const request = (rawRequest ?? {}) as { tools?: Array<{ name?: string }> };
      const tools = (request.tools ?? []).map((entry) => entry.name ?? '').filter(Boolean);
      const serialized = JSON.stringify(rawRequest ?? {});
      primaryStep += 1;
      let output: unknown[];
      if (primaryStep === 1) {
        assert.match(serialized, /Gauntlet Residue Sheet/, 'the first step sees the accepted request');
        assert.ok(tools.includes('tool_search'), 'blank state exposes metadata discovery');
        output = [functionCall('discover-sheet-write', 'tool_search', {
          query: 'create a new google sheet with a header row from json',
          role_key: serialized.match(/clause-\d+:[a-z_]+/i)?.[0] ?? null,
          limit: 8,
        })];
      } else if (primaryStep === 2) {
        assert.match(serialized, new RegExp(SHEET_OPERATION),
          'foreground discovery returns the sheet operation');
        assert.match(serialized, /cap:resolved:googlesheets_create_spreadsheet/,
          'the exact disclosed write ref reaches the model');
        assert.ok(tools.includes(PLAN_CONTROL),
          'disclosure exposes plan_task on the next model surface');
        output = [functionCall('admit-gauntlet-residue-sheet', PLAN_CONTROL, {
          preamble: PREAMBLE,
          draft: {
            criteria: [
              'One new Google Sheet named "Gauntlet Residue Sheet" exists with the header row Scenario, Status, Notes.',
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
            deliverables: [{ id: 'gauntlet-residue-sheet', kind: 'googlesheets' }],
            evidenceRequirements: ['receipt'],
          },
        })];
      } else if (primaryStep === 3) {
        const planRecord = eventlog.getToolOutput(session.id, 'admit-gauntlet-residue-sheet') as { output?: unknown } | null;
        const planText = String(planRecord?.output ?? '');
        assert.match(planText, /"ok":\s*true/,
          `plan_task must admit the same-turn-disclosed write despite stale process-wide residue: ${planText}`);
        assert.ok(tools.includes('work_call'), 'the activated business carrier is available');
        output = [functionCall('gauntlet-residue-sheet-create', 'work_call', {
          requirement_id: WRITE_REQUIREMENT,
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: SHEET_OPERATION,
            arguments: JSON.stringify({
              title: 'Gauntlet Residue Sheet',
              header_row: ['Scenario', 'Status', 'Notes'],
            }),
            connected_account_id: 'conn-googlesheets-residue',
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
        responseId: `gauntlet-residue-${primaryStep}`,
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
    channelId: 'discord-channel-gauntlet-residue',
    userId: 'discord-user-gauntlet-residue',
    guildId: 'discord-guild-gauntlet',
    transport,
    durableRequest: {
      sessionId: session.id,
      runId: 'discord-gauntlet-sheet-residue-request-1',
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
      planOutput: eventlog.getToolOutput(session.id, 'admit-gauntlet-residue-sheet'),
      edits,
      events: eventlog.listEvents(session.id).map((event) => ({
        seq: event.seq, type: event.type, data: event.data,
      })),
    }, null, 1), 'utf8');
  }
  assert.equal(primaryStep, 4, JSON.stringify({
    planOutput: eventlog.getToolOutput(session.id, 'admit-gauntlet-residue-sheet'),
    edits,
  }));

  const planRecord = eventlog.getToolOutput(session.id, 'admit-gauntlet-residue-sheet') as { output?: unknown } | null;
  const planOutput = String(planRecord?.output ?? '');
  assert.match(planOutput, /"ok":\s*true/, planOutput);
  assert.doesNotMatch(planOutput, /plan_not_admitted|frozen host catalog|not disclosed/);

  const snapshotRow = eventlog.openEventLog().prepare(`
    SELECT snapshot_json FROM accepted_source_catalog_snapshots
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, sourceUserSeq) as { snapshot_json: string } | undefined;
  assert.ok(snapshotRow, 'plan admission persisted the accepted-source snapshot');
  assert.notEqual(snapshotRow!.snapshot_json, '[]',
    'the frozen snapshot must not come back completely empty despite stale process-wide residue');
  assert.match(snapshotRow!.snapshot_json, /cap:resolved:googlesheets_create_spreadsheet/,
    'the frozen catalog contains the same-turn-disclosed write capability');

  const sealed = capabilityCatalogs.loadSealedNodeBinding(session.id, sourceUserSeq, WRITE_REQUIREMENT);
  assert.ok(sealed, 'the admitted write operation received one exact durable node seal');
  assert.equal(sealed!.capabilityId, 'cap:resolved:googlesheets_create_spreadsheet');
  assert.equal(sealed!.effect, 'external_write');
  assert.equal(sealed!.providerOperationId, SHEET_OPERATION);

  assert.equal(providerWrites.length, 1, 'exactly one sheet write crossed the provider wire');
  assert.equal(sha256(JSON.stringify(providerWrites[0]!.title)), sha256(JSON.stringify('Gauntlet Residue Sheet')));
});

/**
 * Regression pin for the mechanism S1-residue's own admission-level fix left
 * standing: registerProofProvisionedCapabilities's post-registration
 * refreshTypedExecutionReadiness() treated every "current" manifest in the
 * whole process-wide store as required and forgot (evicted from the LIVE
 * FACTORY) any whose independent observation had gone stale — including
 * residue nobody selected. S1-residue only proves admission still succeeds
 * despite that eviction (an unselected descriptor going missing is tolerated,
 * per admit-and-compile-accepted-source.ts). It does not prove the eviction
 * stopped happening. Live 2026-08-26 (session sess-desktop-2f3944f36e1b19eb-
 * d3fbdc2d): after that admission-side tolerance shipped, a real multi-
 * attempt plan_task turn still froze a completely empty catalog snapshot and
 * refused every attempt — the daemon's shared factory had been swept clean.
 * This subtest re-runs S1-residue's exact shape (its own separate write
 * operation and residue slugs, so it shares no manifest/port identity with
 * S1-residue's own turn) and additionally asserts the unrelated residue
 * capabilities are still registered in the live factory after the turn, not
 * just that admission tolerated their absence.
 */
const SURVIVES_SHEET_OPERATION = 'GOOGLESHEETS_SPREADSHEET_CREATE';
const SURVIVES_RESIDUE_SLUGS = [
  'GOOGLESHEETS_CLEAR_VALUES',
  'GOOGLESHEETS_ADD_SHEET',
  'GOOGLESHEETS_DELETE_SHEET',
] as const;

test('S2-residue-survives: registering the selected write must not evict unrelated stale residue from the live factory', { timeout: 120_000 }, async () => {
  eventlog.resetEventLog();
  resetHarnessRuntimeConfig();
  proactivity.saveProactivityPolicy({ autoApproveScope: 'strict' });

  const session = eventlog.createSession({
    id: 'discord-gauntlet-sheet-stale-residue-survives',
    kind: 'chat',
    userId: 'discord-user-gauntlet-residue-survives',
  });

  const configured = await configureHarnessRuntime();
  assert.equal(configured.ok, true, configured.ok ? '' : configured.reason);

  productionAdapters.installProductionTransport(async () => {
    throw new Error('journey forbids direct catalog execution outside work_call');
  });

  const factory = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  assert.ok(factory, 'runtime installs one empty searchable host catalog');
  productionPorts.clearProductionCapabilityPorts();

  // THE LIVE PRE-CONDITION, same shape as S1-residue, but this turn's own
  // residue slugs/account — never touched by S1-residue's turn — so this
  // pin exercises a fresh registration racing fresh residue, not a replay of
  // S1-residue's already-registered capability.
  for (const slug of SURVIVES_RESIDUE_SLUGS) {
    seedStaleComposioResidue({
      slug,
      accountId: 'ca_residue_sheets_survives',
      purposeWords: 'google sheet spreadsheet',
    });
  }
  const residueCapabilityIds = SURVIVES_RESIDUE_SLUGS.map((slug) => `cap:resolved:${slug.toLowerCase()}`);
  for (const id of residueCapabilityIds) {
    assert.ok(factory.get(id), `residue ${id} is seeded live before the turn`);
  }

  connectedCatalog.installConnectedRegistryPort(() => ({
    connectedToolkits: ['googlesheets'],
    tools: [
      { slug: SURVIVES_SHEET_OPERATION, schema: SHEET_SCHEMA as unknown as Record<string, unknown> },
    ],
  }));

  const rawTools = [{
    slug: SURVIVES_SHEET_OPERATION,
    name: 'Create Google Sheet',
    description: 'Create one new Google Sheet with an optional header row.',
    toolkit: { slug: 'googlesheets' },
    inputParameters: SHEET_SCHEMA,
    outputParameters: SHEET_OUTPUT_SCHEMA,
    version: 'fixture-googlesheets-survives-v1',
  }];
  composioClient.__test__.setComposioApiKeyOverride('fixture-composio-key');
  composioClient.__test__.setConnectedAccountsLoader(async () => [
    { id: 'conn-googlesheets-residue-survives', status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'googlesheets' } },
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
            assert.equal(operation, SURVIVES_SHEET_OPERATION);
            const args = body.arguments as Record<string, unknown>;
            providerWrites.push(structuredClone(args));
            assert.equal(args.title, 'Gauntlet Residue Sheet');
            return {
              data: {
                successful: true,
                spreadsheetId: 'gauntlet-residue-sheet-survives',
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
  });

  const gateway = composioTools.getComposioRuntimeTools()
    .find((candidate) => candidate.name === 'composio_execute_tool');
  assert.ok(gateway, 'the journey uses the production Composio carrier around the raw provider wire');
  innerDispatch._setInnerDispatchToolsForTests(new Map([
    ['composio_execute_tool', gateway as never],
  ]));

  const survivesCapabilityId = `cap:resolved:${SURVIVES_SHEET_OPERATION.toLowerCase()}`;
  let primaryStep = 0;
  const scriptedModel = {
    async getResponse(rawRequest: unknown) {
      const request = (rawRequest ?? {}) as { tools?: Array<{ name?: string }> };
      const tools = (request.tools ?? []).map((entry) => entry.name ?? '').filter(Boolean);
      const serialized = JSON.stringify(rawRequest ?? {});
      primaryStep += 1;
      let output: unknown[];
      if (primaryStep === 1) {
        assert.match(serialized, /Gauntlet Residue Sheet/, 'the first step sees the accepted request');
        assert.ok(tools.includes('tool_search'), 'blank state exposes metadata discovery');
        output = [functionCall('discover-sheet-write', 'tool_search', {
          query: 'create a new google sheet with a header row',
          role_key: serialized.match(/clause-\d+:[a-z_]+/i)?.[0] ?? null,
          limit: 8,
        })];
      } else if (primaryStep === 2) {
        assert.match(serialized, new RegExp(SURVIVES_SHEET_OPERATION),
          'foreground discovery returns the sheet operation');
        assert.match(serialized, new RegExp(survivesCapabilityId),
          'the exact disclosed write ref reaches the model');
        assert.ok(tools.includes(PLAN_CONTROL),
          'disclosure exposes plan_task on the next model surface');
        output = [functionCall('admit-gauntlet-residue-sheet-survives', PLAN_CONTROL, {
          preamble: PREAMBLE,
          draft: {
            criteria: [
              'One new Google Sheet named "Gauntlet Residue Sheet" exists with the header row Scenario, Status, Notes.',
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
              capabilityRef: survivesCapabilityId,
              evidence: ['receipt'],
            }],
            deliverables: [{ id: 'gauntlet-residue-sheet-survives', kind: 'googlesheets' }],
            evidenceRequirements: ['receipt'],
          },
        })];
      } else if (primaryStep === 3) {
        const planRecord = eventlog.getToolOutput(session.id, 'admit-gauntlet-residue-sheet-survives') as { output?: unknown } | null;
        const planText = String(planRecord?.output ?? '');
        assert.match(planText, /"ok":\s*true/,
          `plan_task must admit the same-turn-disclosed write despite stale process-wide residue: ${planText}`);
        assert.ok(tools.includes('work_call'), 'the activated business carrier is available');
        output = [functionCall('gauntlet-residue-sheet-create-survives', 'work_call', {
          requirement_id: WRITE_REQUIREMENT,
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: SURVIVES_SHEET_OPERATION,
            arguments: JSON.stringify({
              title: 'Gauntlet Residue Sheet',
              header_row: ['Scenario', 'Status', 'Notes'],
            }),
            connected_account_id: 'conn-googlesheets-residue-survives',
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
        responseId: `gauntlet-residue-survives-${primaryStep}`,
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
    channelId: 'discord-channel-gauntlet-residue-survives',
    userId: 'discord-user-gauntlet-residue-survives',
    guildId: 'discord-guild-gauntlet-survives',
    transport,
    durableRequest: {
      sessionId: session.id,
      runId: 'discord-gauntlet-sheet-residue-survives-request-1',
      onSourceAccepted(source: { seq: number }) {
        acceptedSource = { seq: source.seq };
      },
    },
  });

  assert.ok(acceptedSource, 'the exported Discord runner accepted one durable source');
  const sourceUserSeq = acceptedSource!.seq;
  assert.equal(primaryStep, 4, JSON.stringify({
    planOutput: eventlog.getToolOutput(session.id, 'admit-gauntlet-residue-sheet-survives'),
    edits,
  }));

  const planRecord = eventlog.getToolOutput(session.id, 'admit-gauntlet-residue-sheet-survives') as { output?: unknown } | null;
  const planOutput = String(planRecord?.output ?? '');
  assert.match(planOutput, /"ok":\s*true/, planOutput);
  assert.doesNotMatch(planOutput, /plan_not_admitted|frozen host catalog|not disclosed/);

  const snapshotRow = eventlog.openEventLog().prepare(`
    SELECT snapshot_json FROM accepted_source_catalog_snapshots
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, sourceUserSeq) as { snapshot_json: string } | undefined;
  assert.ok(snapshotRow, 'plan admission persisted the accepted-source snapshot');
  assert.notEqual(snapshotRow!.snapshot_json, '[]',
    'the frozen snapshot must not come back completely empty despite stale process-wide residue');
  assert.match(snapshotRow!.snapshot_json, new RegExp(survivesCapabilityId),
    'the frozen catalog contains the same-turn-disclosed write capability');

  assert.equal(providerWrites.length, 1, 'exactly one sheet write crossed the provider wire');

  // THE POINT OF THIS PIN: registering the selected write must not have
  // collaterally evicted the unrelated, still-stale residue from the LIVE
  // FACTORY. S1-residue only proves admission tolerates their absence;
  // this proves they were never forgotten in the first place.
  for (const id of residueCapabilityIds) {
    assert.ok(factory.get(id), `unrelated stale residue ${id} must survive this turn's registration in the live factory`);
  }
});


/**
 * Direction pin for a SECOND, independent mechanism that also empties the
 * frozen catalog (fixed 2026-08-26 in admit-and-compile-accepted-source.ts,
 * "Whatever gets revalidated gets published" — that file is off-limits to
 * this crew, fixed by another): a capability the model selects straight off
 * the LIVE catalog (primePrimaryModelPlanningCatalog's disclosureByName,
 * built once at turn-prime time from whatever the shared factory already
 * holds) rather than through THIS turn's own staged tool_search disclosure
 * was revalidated (connection checked, schema re-fetched live) and then
 * omitted from registerProofProvisionedCapabilities's publication allowlist,
 * which used to be built only from the STAGED selections. Revalidated and
 * never published: plan admission froze a catalog without it and refused the
 * very proposal it had just proven (live 2026-08-26: an active, proven
 * Sheets connection, seven plan_task refusals, zero business calls).
 *
 * disclosureByName is computed ONCE per turn from the factory's state AT
 * PRIME TIME — a capability registered later in the SAME turn (e.g. via this
 * turn's own tool_search) never retroactively becomes a "live" entry for
 * that same turn. So this pin uses two turns, exactly like a real multi-turn
 * conversation: TURN 1 discovers, stages, and publishes
 * GOOGLESHEETS_LIVE_PUBLISHED_CREATE the ordinary way (tool_search ->
 * plan_task -> work_call), which registers it into the shared, process-wide
 * factory with a real, correctly-computed manifest. TURN 2 is a fresh
 * accepted source in the same process: it seeds stale, unrelated residue
 * exactly as S1/S2 do, then its model cites the SAME capability directly in
 * its very first plan_task call — never calling tool_search for it — so for
 * TURN 2 that ref is disclosureByName-only, exactly the shape production
 * hits. Both mechanisms are exercised together the way production hits them:
 * TURN 2's own residue-forgetting exposure (this file's mechanism) and its
 * live-catalog-selected-but-unpublished exposure (the other fix).
 */
const LIVE_PUBLISHED_OPERATION = 'GOOGLESHEETS_LIVE_PUBLISHED_CREATE';
const LIVE_PUBLISHED_RESIDUE_SLUGS = [
  'GOOGLESHEETS_RENAME_SHEET',
  'GOOGLESHEETS_DUPLICATE_SHEET',
  'GOOGLESHEETS_FORMAT_CELLS',
] as const;

test('S3-live-catalog-published: a write selected straight off the live catalog (never staged this turn) still lands in the frozen snapshot', { timeout: 180_000 }, async () => {
  eventlog.resetEventLog();
  resetHarnessRuntimeConfig();
  proactivity.saveProactivityPolicy({ autoApproveScope: 'strict' });

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
      { slug: LIVE_PUBLISHED_OPERATION, schema: SHEET_SCHEMA as unknown as Record<string, unknown> },
    ],
  }));

  const rawTools = [{
    slug: LIVE_PUBLISHED_OPERATION,
    name: 'Create Google Sheet',
    description: 'Create one new Google Sheet with an optional header row.',
    toolkit: { slug: 'googlesheets' },
    inputParameters: SHEET_SCHEMA,
    outputParameters: SHEET_OUTPUT_SCHEMA,
    version: 'fixture-googlesheets-live-published-v1',
  }];
  composioClient.__test__.setComposioApiKeyOverride('fixture-composio-key');
  composioClient.__test__.setConnectedAccountsLoader(async () => [
    { id: 'conn-googlesheets-live-published', status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'googlesheets' } },
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
            assert.equal(operation, LIVE_PUBLISHED_OPERATION);
            const args = body.arguments as Record<string, unknown>;
            providerWrites.push(structuredClone(args));
            return {
              data: {
                successful: true,
                spreadsheetId: `gauntlet-live-published-sheet-${providerWrites.length}`,
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
  });

  const gateway = composioTools.getComposioRuntimeTools()
    .find((candidate) => candidate.name === 'composio_execute_tool');
  assert.ok(gateway, 'the journey uses the production Composio carrier around the raw provider wire');
  innerDispatch._setInnerDispatchToolsForTests(new Map([
    ['composio_execute_tool', gateway as never],
  ]));

  const liveCapabilityId = `cap:resolved:${LIVE_PUBLISHED_OPERATION.toLowerCase()}`;
  const edits: string[] = [];
  const transport = {
    async sendInitial() {
      return { async edit(content: string) { edits.push(content); } };
    },
    async sendError(content: string) { edits.push(`ERROR:${content}`); },
    async sendFollowup(content: string) { edits.push(content); },
  };

  // TURN 1: ordinary tool_search -> plan_task -> work_call, publishing
  // LIVE_PUBLISHED_OPERATION into the shared, process-wide factory the real
  // way (real revalidation, real digests) so TURN 2 can select it live.
  const turn1Session = eventlog.createSession({
    id: 'discord-gauntlet-sheet-live-published-turn1',
    kind: 'chat',
    userId: 'discord-user-gauntlet-live-published',
  });
  let turn1Step = 0;
  const turn1Model = {
    async getResponse(rawRequest: unknown) {
      const request = (rawRequest ?? {}) as { tools?: Array<{ name?: string }> };
      const tools = (request.tools ?? []).map((entry) => entry.name ?? '').filter(Boolean);
      const serialized = JSON.stringify(rawRequest ?? {});
      turn1Step += 1;
      let output: unknown[];
      if (turn1Step === 1) {
        assert.ok(tools.includes('tool_search'), 'blank state exposes metadata discovery');
        output = [functionCall('discover-live-published-write', 'tool_search', {
          query: 'create a new google sheet with a header row',
          role_key: serialized.match(/clause-\d+:[a-z_]+/i)?.[0] ?? null,
          limit: 8,
        })];
      } else if (turn1Step === 2) {
        assert.match(serialized, new RegExp(LIVE_PUBLISHED_OPERATION), 'foreground discovery returns the sheet operation');
        assert.ok(tools.includes(PLAN_CONTROL), 'disclosure exposes plan_task on the next model surface');
        output = [functionCall('admit-live-published-turn1', PLAN_CONTROL, {
          preamble: PREAMBLE,
          draft: {
            criteria: [
              'One new Google Sheet named "Gauntlet Residue Sheet" exists with the header row Scenario, Status, Notes.',
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
              capabilityRef: liveCapabilityId,
              evidence: ['receipt'],
            }],
            deliverables: [{ id: 'gauntlet-live-published-sheet-turn1', kind: 'googlesheets' }],
            evidenceRequirements: ['receipt'],
          },
        })];
      } else if (turn1Step === 3) {
        const planRecord = eventlog.getToolOutput(turn1Session.id, 'admit-live-published-turn1') as { output?: unknown } | null;
        const planText = String(planRecord?.output ?? '');
        assert.match(planText, /"ok":\s*true/, `turn 1 plan_task must admit the staged write: ${planText}`);
        assert.ok(tools.includes('work_call'), 'the activated business carrier is available');
        output = [functionCall('turn1-live-published-create', 'work_call', {
          requirement_id: WRITE_REQUIREMENT,
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: LIVE_PUBLISHED_OPERATION,
            arguments: JSON.stringify({
              title: 'Gauntlet Residue Sheet',
              header_row: ['Scenario', 'Status', 'Notes'],
            }),
            connected_account_id: 'conn-googlesheets-live-published',
          }),
        })];
      } else {
        output = [textMessage(JSON.stringify({
          summary: SUCCESS, reply: SUCCESS, done: true, nextAction: 'completed', reason: null,
        }))];
      }
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output,
        responseId: `gauntlet-live-published-turn1-${turn1Step}`,
      };
    },
    getStreamedResponse: streamResponse,
  };
  bridge._setBridgeImplsForTests({
    buildAgent: async (options) => buildOrchestratorAgent({ ...options, model: turn1Model as never }),
  });
  let turn1Accepted: { seq: number } | null = null;
  await discord.runDiscordHarnessConversation({
    prompt: PROMPT,
    rawPrompt: PROMPT,
    channelId: 'discord-channel-gauntlet-live-published',
    userId: 'discord-user-gauntlet-live-published',
    guildId: 'discord-guild-gauntlet-live-published',
    transport,
    durableRequest: {
      sessionId: turn1Session.id,
      runId: 'discord-gauntlet-sheet-live-published-turn1-request-1',
      onSourceAccepted(source: { seq: number }) { turn1Accepted = { seq: source.seq }; },
    },
  });
  assert.ok(turn1Accepted, 'turn 1 accepted one durable source');
  assert.equal(turn1Step, 4, 'turn 1 completed tool_search -> plan_task -> work_call -> summary');
  assert.equal(providerWrites.length, 1, 'turn 1 crossed the provider wire exactly once');
  assert.ok(factory.get(liveCapabilityId), 'turn 1 published the write capability into the shared, process-wide factory');

  // TURN 2: a fresh accepted source in the SAME process. Seed stale,
  // unrelated residue exactly as S1/S2 do, then select
  // LIVE_PUBLISHED_OPERATION directly — no tool_search this turn — relying
  // purely on it already being live from TURN 1.
  for (const slug of LIVE_PUBLISHED_RESIDUE_SLUGS) {
    seedStaleComposioResidue({
      slug,
      accountId: 'ca_residue_sheets_live_published',
      purposeWords: 'google sheet spreadsheet',
    });
  }
  const residueCapabilityIds = LIVE_PUBLISHED_RESIDUE_SLUGS.map((slug) => `cap:resolved:${slug.toLowerCase()}`);
  for (const id of residueCapabilityIds) {
    assert.ok(factory.get(id), `residue ${id} is seeded live before turn 2`);
  }

  const turn2Session = eventlog.createSession({
    id: 'discord-gauntlet-sheet-live-published-turn2',
    kind: 'chat',
    userId: 'discord-user-gauntlet-live-published',
  });
  let turn2Step = 0;
  const turn2Model = {
    async getResponse(rawRequest: unknown) {
      const request = (rawRequest ?? {}) as { tools?: Array<{ name?: string }> };
      const tools = (request.tools ?? []).map((entry) => entry.name ?? '').filter(Boolean);
      const serialized = JSON.stringify(rawRequest ?? {});
      turn2Step += 1;
      let output: unknown[];
      if (turn2Step === 1) {
        // THE POINT: no tool_search call, ever, in this turn. The ref is
        // cited straight off this turn's own initial planning card, which
        // finds LIVE_PUBLISHED_OPERATION already live in the shared factory
        // from turn 1 — the disclosureByName path, never staged this turn.
        assert.match(serialized, /Gauntlet Residue Sheet/, 'the first step sees the accepted request');
        assert.ok(tools.includes(PLAN_CONTROL), 'plan_task is available before any tool_search call this turn');
        output = [functionCall('admit-live-published-turn2', PLAN_CONTROL, {
          preamble: PREAMBLE,
          draft: {
            criteria: [
              'One new Google Sheet named "Gauntlet Residue Sheet" exists with the header row Scenario, Status, Notes.',
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
              capabilityRef: liveCapabilityId,
              evidence: ['receipt'],
            }],
            deliverables: [{ id: 'gauntlet-live-published-sheet-turn2', kind: 'googlesheets' }],
            evidenceRequirements: ['receipt'],
          },
        })];
      } else if (turn2Step === 2) {
        const planRecord = eventlog.getToolOutput(turn2Session.id, 'admit-live-published-turn2') as { output?: unknown } | null;
        const planText = String(planRecord?.output ?? '');
        assert.match(planText, /"ok":\s*true/,
          `turn 2 plan_task must admit a write selected straight off the live catalog, never staged this turn: ${planText}`);
        assert.ok(tools.includes('work_call'), 'the activated business carrier is available');
        output = [functionCall('turn2-live-published-create', 'work_call', {
          requirement_id: WRITE_REQUIREMENT,
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: LIVE_PUBLISHED_OPERATION,
            arguments: JSON.stringify({
              title: 'Gauntlet Residue Sheet',
              header_row: ['Scenario', 'Status', 'Notes'],
            }),
            connected_account_id: 'conn-googlesheets-live-published',
          }),
        })];
      } else {
        output = [textMessage(JSON.stringify({
          summary: SUCCESS, reply: SUCCESS, done: true, nextAction: 'completed', reason: null,
        }))];
      }
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output,
        responseId: `gauntlet-live-published-turn2-${turn2Step}`,
      };
    },
    getStreamedResponse: streamResponse,
  };
  bridge._setBridgeImplsForTests({
    buildAgent: async (options) => buildOrchestratorAgent({ ...options, model: turn2Model as never }),
  });
  let turn2Accepted: { seq: number } | null = null;
  await discord.runDiscordHarnessConversation({
    prompt: PROMPT,
    rawPrompt: PROMPT,
    channelId: 'discord-channel-gauntlet-live-published',
    userId: 'discord-user-gauntlet-live-published',
    guildId: 'discord-guild-gauntlet-live-published',
    transport,
    durableRequest: {
      sessionId: turn2Session.id,
      runId: 'discord-gauntlet-sheet-live-published-turn2-request-1',
      onSourceAccepted(source: { seq: number }) { turn2Accepted = { seq: source.seq }; },
    },
  });

  assert.ok(turn2Accepted, 'turn 2 accepted one durable source');
  const turn2SourceUserSeq = turn2Accepted!.seq;
  assert.equal(turn2Step, 3, JSON.stringify({
    planOutput: eventlog.getToolOutput(turn2Session.id, 'admit-live-published-turn2'),
    edits,
  }));

  const planRecord = eventlog.getToolOutput(turn2Session.id, 'admit-live-published-turn2') as { output?: unknown } | null;
  const planOutput = String(planRecord?.output ?? '');
  assert.match(planOutput, /"ok":\s*true/, planOutput);
  assert.doesNotMatch(planOutput, /plan_not_admitted|frozen host catalog|not disclosed/);

  const snapshotRow = eventlog.openEventLog().prepare(`
    SELECT snapshot_json FROM accepted_source_catalog_snapshots
     WHERE session_id = ? AND source_user_seq = ?
  `).get(turn2Session.id, turn2SourceUserSeq) as { snapshot_json: string } | undefined;
  assert.ok(snapshotRow, 'turn 2 plan admission persisted the accepted-source snapshot');
  assert.match(
    snapshotRow!.snapshot_json,
    new RegExp(liveCapabilityId),
    "a capability SELECTED straight off the live catalog, never staged through turn 2's own tool_search, still lands in turn 2's frozen snapshot",
  );

  assert.equal(providerWrites.length, 2, 'turn 2 crossed the provider wire exactly once more');

  // BOTH mechanisms exercised together: the live-selected write published in
  // turn 2, and turn 2's unrelated stale residue never collaterally evicted.
  for (const id of residueCapabilityIds) {
    assert.ok(factory.get(id), `unrelated stale residue ${id} must survive turn 2's registration in the live factory`);
  }
});
