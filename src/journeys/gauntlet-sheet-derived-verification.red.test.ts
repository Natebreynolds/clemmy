/**
 * Run: npx tsx src/journeys/gauntlet-sheet-derived-verification.red.test.ts
 *
 * The model authors business work. The HOST verifies every mutation.
 *
 * Live 2026-08-26: a natural two-operation plan (create a Sheet, write its
 * header row) was admitted, the sheet was really created, and only then did the
 * dependent write discover the plan could never be discharged — a mutation
 * discharges solely against a host-issued exact readback, and a model plans
 * business work, never readbacks. Teaching a model to author the ceremony does
 * not hold; the next plan omits it again.
 *
 * So the semantic and expected-work graph stays exactly what was asked for:
 *
 *     create_sheet → write_headers
 *
 * and each mutation carries a frozen verification recipe on its own durable
 * binding. After a mutation settles, the host runs that recipe as its own
 * deterministic child call through the ordinary invocation kernel. The model
 * never issues a readback, and the readback is never a graph node.
 *
 * The provider sequence a correct run must produce:
 *
 *     CREATE → BATCH_GET(identity) → VALUES_UPDATE → BATCH_GET(content)
 *
 * The two mutations arrive through work_call. The two verifier reads arrive
 * through the catalog transport, which this fixture opens ONLY for the exact
 * frozen verifier operation and account — any mutation attempting that route
 * throws, so a verifier can never smuggle a write.
 */
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { currentSourceAccountReviewer } from './gauntlet-sheet-account-review.fixture-support.js';
import { after, mock, test } from 'node:test';
import type { RunConversationOptions, RunConversationResult } from '../runtime/harness/loop.js';

const PROCESS_RESTART_FIXTURE = process.env.CLEM_DERIVED_RESTART_FIXTURE === '1';
const HOME = PROCESS_RESTART_FIXTURE
  ? (() => {
      const configured = process.env.CLEMENTINE_HOME?.trim();
      if (!configured) throw new Error('derived restart fixture requires CLEMENTINE_HOME');
      return configured;
    })()
  : mkdtempSync(path.join(os.tmpdir(), 'clem-derived-verification-'));
const PROMPT = 'make me a new google sheet called Clem Derived Gate with a header row: check, result, timestamp';
const SHEET_ID = 'derived-gate-sheet';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
const PREAMBLE = 'I’m creating the new sheet and adding its three-column header row.';
const ACCOUNT = 'conn-googlesheets';

const CREATE_OPERATION = 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1';
const UPDATE_OPERATION = 'GOOGLESHEETS_VALUES_UPDATE';
const READ_OPERATION = 'GOOGLESHEETS_BATCH_GET';
const CREATE_REF = 'cap:resolved:googlesheets_create_google_sheet1';
const UPDATE_REF = 'cap:resolved:googlesheets_values_update';

/** Exactly the two operations a person asked for. */
const CREATE_NODE = 'create_sheet';
const WRITE_NODE = 'write_headers';
const HEADER_VALUES = ['check', 'result', 'timestamp'];
const HEADER_RANGE = 'Sheet1!A1:C1';

const CREATE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: [],
  properties: {
    title: { type: 'string' },
    folder_id: { type: 'string' },
    folder_name: { type: 'string' },
  },
});
const PROVIDER_ENVELOPE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['data', 'successful'],
  properties: {
    data: { type: 'object' },
    error: {},
    successful: { type: 'boolean' },
  },
});
const UPDATE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['spreadsheet_id', 'range', 'values'],
  properties: {
    spreadsheet_id: { type: 'string' },
    range: { type: 'string' },
    values: { type: 'array', items: { type: 'array' } },
    value_input_option: { type: 'string' },
  },
});
const READ_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['spreadsheet_id'],
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
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-derived-verification\n', 'utf8');
writeFileSync(path.join(HOME, 'state', 'auth.json'), JSON.stringify({
  source: 'native',
  codexOauth: {
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
    lastRefresh: new Date().toISOString(),
  },
}), 'utf8');

// This journey exercises dispatch, recovery and transport, not the first-time
// card: it runs with every connected-app kind approved, like the unit fixtures
// (70c7dd879). The ask-once rule itself (owner 2026-10-06) is the
// balanced-user-stops journeys' subject.
const { _setApprovedWriteKindsForTests } = await import('../agents/plan-scope.js');
_setApprovedWriteKindsForTests('all');
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

reflection._testOnly_setReflectionExtractor(async () =>
  ({ facts: [], entities: [], pointers: [], resources: [], relationships: [] } as never));

function textMessage(text: string) {
  return {
    type: 'message' as const, role: 'assistant' as const, status: 'completed' as const,
    content: [{ type: 'output_text' as const, text }],
  };
}

function functionCall(callId: string, name: string, args: Record<string, unknown>) {
  return { type: 'function_call' as const, callId, name, arguments: JSON.stringify(args) };
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

if (!PROCESS_RESTART_FIXTURE) {
  after(() => {
    innerDispatch._setInnerDispatchToolsForTests(null);
    try { eventlog.closeEventLog(); } catch { /* already closed */ }
    if (process.env.CLEM_DERIVED_KEEP_HOME) {
      console.error(`[derived] kept ${HOME}`);
    } else {
      rmSync(HOME, { recursive: true, force: true });
    }
  });
}

/** One append-only provider crossing log shared by BOTH routes. */
type ProviderBody = {
  operation: string;
  args: Record<string, unknown>;
  via: 'work_call' | 'catalog';
};

export type TurnOptions = {
  /** Controlled read-only failures; callers own recovery so no real timer races the clock. */
  verifierFailures?: readonly ('transient' | 'authentication' | 'eventual' | null)[];
  /** Keep completion review inside this transport fixture and prove its saved effect evidence. */
  controlledCompletionReview?: true;
  /** Negative control: omit only the typed source-account semantic reviewer. */
  omitAccountReviewer?: boolean;
  sessionId: string;
  /** Omit the verifier capability to prove the pre-mutation refusal. */
  discloseVerifier: boolean;
  /** The spreadsheet_id the model puts in the header write. */
  updateTargetId: string;
  /** Re-enter through the exported channel boundary with the identical durable
   * request id after the first terminal commits. */
  replaySameRequest?: boolean;
  /** Process-restart fixture seam: keep the existing durable database and
   * re-enter the same request rather than constructing a new accepted source. */
  resetDurableState?: boolean;
  /** Append-only provider-body witness outside SQLite. */
  externalBodyLog?: string;
  externalPhase?: 'A' | 'B';
};

export type TurnResult = {
  bodies: ProviderBody[];
  edits: string[];
  sessionId: string;
  sourceUserSeq: number;
  modelToolCalls: string[];
  replayAdditionalProviderCrossings: number;
  replayAdditionalModelCalls: number;
  replayAdditionalTerminalEvents: number;
  /** Real same-source host continuation; only the controlled verifier cases expose it. */
  redriveAcceptedSource?: (options?: { scheduleRecovery?: true; maxTurns?: number }) => Promise<RunConversationResult>;
  hostResults?: RunConversationResult[];
  controlledReviewCalls?: () => number;
};

export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  if (options.resetDurableState !== false) eventlog.resetEventLog();
  resetHarnessRuntimeConfig();
  // Each case represents a cold process/catalog. Keeping a prior case's
  // verifier registration after resetting the durable database would create a
  // capability that this case never disclosed and turn the no-verifier oracle
  // into a stale-definition failure instead of the intended admission refusal.
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  // Auto mode (2026-09-30): this journey pins the provider write pipeline,
  // not the mode; in Ask mode the first change of a kind waits for the owner.
  proactivity.saveProactivityPolicy({ autoApproveScope: 'yolo' });

  const session = options.resetDurableState === false
    ? eventlog.getSession(options.sessionId)
    : eventlog.createSession({
        id: options.sessionId, kind: 'chat', userId: 'discord-user-derived',
      });
  assert.ok(session, `durable session ${options.sessionId} must already exist on restart`);

  const configured = await configureHarnessRuntime();
  assert.equal(configured.ok, true, configured.ok ? '' : configured.reason);

  const bodies: ProviderBody[] = [];
  let verifierOrdinal = 0;
  const headerCells = new Map<string, string[]>();
  const recordProviderBody = (body: ProviderBody): void => {
    bodies.push(body);
    if (options.externalBodyLog) {
      appendFileSync(options.externalBodyLog, `${JSON.stringify({
        phase: options.externalPhase ?? null,
        pid: process.pid,
        operation: body.operation,
        via: body.via,
        args: body.args,
      })}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  };

  // The catalog route is open ONLY to the exact frozen verifier operation on
  // the exact account. A mutation attempting this route is a hard failure: a
  // verifier must never become a way to write.
  productionAdapters.installProductionTransport(async (call) => {
    if (call.operationId !== READ_OPERATION || call.accountId !== ACCOUNT) {
      throw new Error(
        `journey forbids the direct catalog route for ${call.operationId}; only the exact frozen verifier may use it`,
      );
    }
    const target = String((call.args as { spreadsheet_id?: unknown }).spreadsheet_id ?? '');
    const observed = headerCells.get(target);
    recordProviderBody({ operation: call.operationId, args: { ...call.args }, via: 'catalog' });
    const failure = options.verifierFailures?.[verifierOrdinal++];
    if (failure === 'eventual') return { data: { valueRanges: [{ range: HEADER_RANGE, values: [['stale values']] }] },
      error: null, successful: true };
    if (failure) {
      const error = new Error(failure === 'transient' ? 'controlled verifier timeout' : 'controlled verifier authentication failure');
      if (failure === 'transient') error.name = 'TimeoutError';
      else Object.assign(error, { status: 401 });
      throw error;
    }
    return {
      data: {
        valueRanges: observed ? [{ range: HEADER_RANGE, values: [observed] }] : [],
      },
      error: null,
      successful: true,
    };
  });
  assert.ok(capabilityCatalogs.peekHostCapabilityCatalogFactory(), 'runtime installs one host catalog');
  productionPorts.clearProductionCapabilityPorts();

  const connectedTools = [
    { slug: CREATE_OPERATION, schema: CREATE_SCHEMA as unknown as Record<string, unknown> },
    { slug: UPDATE_OPERATION, schema: UPDATE_SCHEMA as unknown as Record<string, unknown> },
    ...(options.discloseVerifier
      ? [{ slug: READ_OPERATION, schema: READ_SCHEMA as unknown as Record<string, unknown> }]
      : []),
  ];
  connectedCatalog.installConnectedRegistryPort(() => ({
    connectedToolkits: ['googlesheets'], tools: connectedTools,
  }));

  const rawTools = [
    {
      slug: CREATE_OPERATION, name: 'Create Google Sheet',
      description: 'Create one new Google Sheet.',
      toolkit: { slug: 'googlesheets' },
      inputParameters: CREATE_SCHEMA, outputParameters: PROVIDER_ENVELOPE_OUTPUT_SCHEMA,
      version: 'fixture-create-v1',
    },
    {
      slug: UPDATE_OPERATION, name: 'Update Google Sheet values',
      description: 'Write one exact range into an existing Google Sheet.',
      toolkit: { slug: 'googlesheets' },
      inputParameters: UPDATE_SCHEMA, outputParameters: PROVIDER_ENVELOPE_OUTPUT_SCHEMA,
      version: 'fixture-update-v1',
    },
    ...(options.discloseVerifier ? [{
      slug: READ_OPERATION, name: 'Read Google Sheet values',
      description: 'Read values back from an existing Google Sheet by exact id.',
      toolkit: { slug: 'googlesheets' },
      inputParameters: READ_SCHEMA, outputParameters: PROVIDER_ENVELOPE_OUTPUT_SCHEMA,
      version: 'fixture-read-v1',
    }] : []),
  ];

  composioClient.__test__.setComposioApiKeyOverride('fixture-composio-key');
  composioClient.__test__.setConnectedAccountsLoader(async () => [
    { id: ACCOUNT, status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'googlesheets' } },
  ]);
  composioClient.__test__.setComposioClient({
    client: { baseURL: 'https://backend.composio.dev' },
    getClient: () => ({
      withOptions: () => ({
        tools: {
          execute: async (operation: string, body: { arguments?: unknown }) => {
            const args = body.arguments as Record<string, unknown>;
            recordProviderBody({ operation, args: structuredClone(args), via: 'work_call' });
            if (operation === CREATE_OPERATION) {
              return {
                data: { spreadsheetId: SHEET_ID, spreadsheetUrl: SHEET_URL },
                error: null, successful: true, log_id: `fixture-${bodies.length}`,
              };
            }
            if (operation === UPDATE_OPERATION) {
              headerCells.set(String(args.spreadsheet_id ?? ''), [...HEADER_VALUES]);
              return {
                data: { updatedCells: HEADER_VALUES.length }, error: null, successful: true,
                log_id: `fixture-${bodies.length}`,
              };
            }
            throw new Error(`journey forbids ${operation} through the business carrier`);
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
      async execute() { throw new Error('journey forbids the legacy Composio execute fallback'); },
    },
  } as never);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://backend.composio.dev/api/v3/tools?')) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`journey forbids external network: ${url}`);
  }) as typeof fetch;

  semanticPorts.installTurnSemanticModelPort({
    async interpret() { throw new Error('hidden pre-loop semantic model pass'); },
    async judgeSourceEffect() { throw new Error('hidden pre-loop semantic effect judge'); },
    async judgePlanGrounding() { throw new Error('hidden pre-loop semantic grounding judge'); },
    ...(options.omitAccountReviewer ? {} : { judgeAccountSelection: currentSourceAccountReviewer({
      sessionId: () => session.id, acceptedText: PROMPT, toolkit: 'googlesheets',
      accountIdentity: ACCOUNT,
      acceptedSource: (id, seq) => eventlog.listEvents(id, { sinceSeq: seq - 1,
        types: ['user_input_received'], limit: 1 }).find(event => event.seq === seq),
    }) }),
  });

  const gateway = composioTools.getComposioRuntimeTools()
    .find((candidate) => candidate.name === 'composio_execute_tool');
  assert.ok(gateway, 'the journey uses the production Composio carrier');
  innerDispatch._setInnerDispatchToolsForTests(new Map([
    ['composio_execute_tool', gateway as never],
  ]));

  const modelToolCalls: string[] = [];
  let primaryStep = 0;
  let roleKey: string | null = null;

  const planText = (): string => {
    const record = eventlog.getToolOutput(options.sessionId, 'admit-plan') as { output?: unknown } | null;
    return String(record?.output ?? '');
  };
  const planAdmitted = (): boolean => /"ok":\s*true/.test(planText());

  const scriptedModel = {
    async getResponse(rawRequest: unknown) {
      const request = (rawRequest ?? {}) as { tools?: Array<{ name?: string }> };
      const tools = (request.tools ?? []).map((entry) => entry.name ?? '').filter(Boolean);
      const serialized = JSON.stringify(rawRequest ?? {});
      primaryStep += 1;
      const searchSteps = options.discloseVerifier ? 3 : 2;
      let output: unknown[];
      if (primaryStep <= searchSteps) {
        roleKey = roleKey ?? serialized.match(/clause-\d+:[a-z_]+/i)?.[0] ?? null;
        const queries = [
          'create a new google sheet',
          'write values into a google sheet header row',
          'read google sheet values back by spreadsheet id',
        ];
        modelToolCalls.push('tool_search');
        output = [functionCall(`discover-${primaryStep}`, 'tool_search',
          { query: queries[primaryStep - 1], role_key: roleKey, limit: 8 })];
      } else if (primaryStep === searchSteps + 1) {
        assert.equal(tools.includes('plan_task'), false, 'deferred planning remains callable without permanent schema growth');
        modelToolCalls.push('plan_task');
        // BUSINESS PLAN ONLY. Two operations. No verification is authored here,
        // ever — that is the entire point of the vertical.
        output = [functionCall('admit-plan', 'plan_task', {
          preamble: PREAMBLE,
          draft: {
            criteria: [
              'Create a Google Sheet titled "Clem Derived Gate".',
              'Set the first row of the initial worksheet to: check, result, timestamp.',
            ],
            cardinality: null,
            destination: { posture: 'create_new', family: 'google_sheet', handleRequired: true },
            topology: {
              version: 1,
              operations: [
                {
                  id: CREATE_NODE, effect: 'external_write', coverage: null,
                  dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
                },
                {
                  id: WRITE_NODE, effect: 'external_write', coverage: null,
                  // The created receipt supplies the destination, not the
                  // literal header content already supplied by the user.
                  // dependsOn retains exact verified-resource targeting.
                  dependsOn: [CREATE_NODE], dataFrom: [], cardinality: { kind: 'once' },
                },
              ],
              universes: [],
            },
            bindings: [
              { operationId: CREATE_NODE, role: 'create_google_sheet', capabilityRef: CREATE_REF, evidence: [] },
              { operationId: WRITE_NODE, role: 'write_google_sheet_values', capabilityRef: UPDATE_REF, evidence: [] },
            ],
            deliverables: [{ id: 'derived_gate_sheet', kind: 'google_sheet' }],
            evidenceRequirements: [],
          },
        })];
      } else if (planAdmitted() && primaryStep === searchSteps + 2) {
        modelToolCalls.push('work_call:create');
        output = [functionCall('call-create', 'work_call', {
          requirement_id: CREATE_NODE,
          universe_item_id: null, universe_selector: null, seal_amendment: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: CREATE_OPERATION,
            arguments: JSON.stringify({ title: 'Clem Derived Gate' }),
            connected_account_id: ACCOUNT,
          }),
        })];
      } else if (planAdmitted() && primaryStep === searchSteps + 3) {
        modelToolCalls.push('work_call:update');
        output = [functionCall('call-update', 'work_call', {
          requirement_id: WRITE_NODE,
          universe_item_id: null, universe_selector: null, seal_amendment: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: UPDATE_OPERATION,
            arguments: JSON.stringify({
              spreadsheet_id: options.updateTargetId,
              range: HEADER_RANGE,
              values: [HEADER_VALUES],
              value_input_option: 'RAW',
            }),
            connected_account_id: ACCOUNT,
          }),
        })];
      } else if (!planAdmitted()) {
        output = [textMessage(JSON.stringify({
          summary: 'I could not admit a verifiable plan, so I created nothing.',
          reply: 'I could not admit a verifiable plan, so I created nothing.',
          done: true, nextAction: 'blocked', reason: 'verification_successor_required',
        }))];
      } else {
        // The model claims BOTH completed, always. Terminal truth must come
        // from the durable record, never from this sentence.
        output = [textMessage(JSON.stringify({
          summary: `Created the sheet with its header row: ${SHEET_URL}`,
          reply: `Created the sheet with its header row: ${SHEET_URL}`,
          done: true, nextAction: 'completed', reason: null,
        }))];
      }
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output, responseId: `derived-${primaryStep}`,
      };
    },
    getStreamedResponse: streamResponse,
  };

  let recoveryInput: RunConversationOptions | undefined;
  const hostResults: RunConversationResult[] = [];
  let controlledReviewCalls = 0;
  if (options.controlledCompletionReview) {
    const host = await import('../runtime/harness/host-turn-runner.js');
    host._setHostObjectiveJudgeForTests(async (objective, reply) => {
      controlledReviewCalls += 1;
      assert.equal(objective, PROMPT, 'the fixture reviewer must receive the original whole task');
      assert.match(reply, /header row/i);
      assert.equal(bodies.filter(body => body.operation === CREATE_OPERATION).length, 1);
      assert.equal(bodies.filter(body => body.operation === UPDATE_OPERATION).length, 1);
      assert.deepEqual(headerCells.get(SHEET_ID), HEADER_VALUES);
      return { done: true, reason: 'Controlled fixture readback proves the exact created sheet and header row.' };
    });
  }
  bridge._setBridgeImplsForTests({
    ...(options.verifierFailures ? {
      runConversation: async (input) => {
        const loop = await import('../runtime/harness/loop.js');
        recoveryInput = { ...input, callerOwnsRecovery: true };
        const result = await loop.runConversationContinuingPastToolCallsLimit(recoveryInput);
        hostResults.push(result);
        return result;
      },
    } : {}),
    buildAgent: async (agentOptions) => buildOrchestratorAgent({
      ...agentOptions, model: scriptedModel as never,
    }),
  });

  const edits: string[] = [];
  const transport = {
    async sendInitial() { return { async edit(content: string) { edits.push(content); } }; },
    async sendError(content: string) { edits.push(`ERROR:${content}`); },
    async sendFollowup(content: string) { edits.push(content); },
  };

  let acceptedSource: { seq: number } | null = null;
  const durableRequest = {
    sessionId: session.id,
    runId: `${options.sessionId}-run`,
    onSourceAccepted(source: { seq: number }) { acceptedSource = { seq: source.seq }; },
  };
  await discord.runDiscordHarnessConversation({
    prompt: PROMPT, rawPrompt: PROMPT,
    channelId: 'discord-channel-derived', userId: 'discord-user-derived',
    guildId: 'discord-guild-derived', transport,
    durableRequest,
  });
  assert.ok(acceptedSource, 'one durable source was accepted');
  const beforeReplayBodies = bodies.length;
  const beforeReplayModelCalls = modelToolCalls.length;
  const beforeReplayTerminals = eventlog.listEvents(session.id)
    .filter((event) => event.type === 'conversation_completed').length;
  if (options.replaySameRequest) {
    const replayEdits: string[] = [];
    await discord.runDiscordHarnessConversation({
      prompt: PROMPT, rawPrompt: PROMPT,
      channelId: 'discord-channel-derived', userId: 'discord-user-derived',
      guildId: 'discord-guild-derived',
      transport: {
        async sendInitial() { return { async edit(content: string) { replayEdits.push(content); } }; },
        async sendError(content: string) { replayEdits.push(`ERROR:${content}`); },
        async sendFollowup(content: string) { replayEdits.push(content); },
      },
      durableRequest,
    });
  }
  if (process.env.CLEM_DERIVED_DEBUG) {
    console.error(`[derived ${options.sessionId}] bodies=${bodies.map((b) => `${b.operation}/${b.via}`).join(' ')}`);
    console.error(`[derived ${options.sessionId}] model=${modelToolCalls.join(' ')}`);
    console.error(`[derived ${options.sessionId}] plan=${planText().slice(0, 220)}`);
    console.error(`[derived ${options.sessionId}] edits=${JSON.stringify(edits).slice(0, 260)}`);
  }
  return {
    bodies, edits, sessionId: session.id, modelToolCalls,
    sourceUserSeq: (acceptedSource as { seq: number }).seq,
    replayAdditionalProviderCrossings: bodies.length - beforeReplayBodies,
    replayAdditionalModelCalls: modelToolCalls.length - beforeReplayModelCalls,
    replayAdditionalTerminalEvents: eventlog.listEvents(session.id)
      .filter((event) => event.type === 'conversation_completed').length - beforeReplayTerminals,
    ...(options.verifierFailures ? {
      hostResults,
      ...(options.controlledCompletionReview ? { controlledReviewCalls: () => controlledReviewCalls } : {}),
      redriveAcceptedSource: async (resumeOptions?: { scheduleRecovery?: true; maxTurns?: number }) => {
        assert.ok(recoveryInput, 'the original production host options must exist');
        // Match the production checkpoint wake: preserve exact accepted source,
        // rebuild fresh activation ownership, and drop foreground delivery hooks.
        const { onChunk: _discardChunk, onConversationPreamble: _discardPreamble, ...stableOptions } = recoveryInput;
        const loop = await import('../runtime/harness/loop.js');
        const result = await loop.runConversation({ ...stableOptions,
          sourceUserSeq: (acceptedSource as { seq: number }).seq,
          reuseRecordedUserInput: true, suppressMemoryCapture: true,
          ...(resumeOptions?.maxTurns !== undefined ? { maxTurns: resumeOptions.maxTurns } : {}),
          callerOwnsRecovery: resumeOptions?.scheduleRecovery ? undefined : true });
        hostResults.push(result);
        return result;
      },
    } : {}),
  };
}

const count = (result: TurnResult, operation: string): number =>
  result.bodies.filter((entry) => entry.operation === operation).length;

const sequence = (result: TurnResult): string[] => result.bodies.map((entry) => entry.operation);

function planRequirementIds(sessionId: string): string[] {
  const record = eventlog.getToolOutput(sessionId, 'admit-plan') as { output?: unknown } | null;
  const text = String(record?.output ?? '');
  if (!/"ok":\s*true/.test(text)) return [];
  const parsed = JSON.parse(text) as { requirements?: Array<{ id: string }> };
  return (parsed.requirements ?? []).map((entry) => entry.id);
}

function terminalPresentation(sessionId: string): { status?: string; text?: string } {
  const events = eventlog.listEvents(sessionId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const data = events[index]!.data as { presentation?: { status?: string; text?: string } };
    if (events[index]!.type === 'conversation_completed' && data?.presentation) return data.presentation;
  }
  return {};
}

function settledVerifierCalls(sessionId: string): string[] {
  return eventlog.listEvents(sessionId)
    .filter((event) => event.type === 'tool_attempt_settled')
    .map((event) => (event.data as { logicalToolCallId?: string; businessCall?: boolean }))
    .filter((data) => data.businessCall === false && String(data.logicalToolCallId ?? '').startsWith('verify:'))
    .map((data) => String(data.logicalToolCallId));
}

if (!PROCESS_RESTART_FIXTURE) test('missing write-account reviewer preserves read discovery and performs no write', { timeout: 180_000 }, async () => {
  const result = await runTurn({ sessionId: 'derived-missing-account-reviewer',
    discloseVerifier: true, updateTargetId: SHEET_ID, omitAccountReviewer: true });
  assert.deepEqual(result.bodies, [], 'an unavailable reviewer grants no provider crossing');
  const events = eventlog.listEvents(result.sessionId);
  const returnedRows = events.filter(event => event.type === 'tool_returned'
    && event.data.sourceUserSeq === result.sourceUserSeq && event.data.tool === 'tool_search')
    .flatMap(event => {
      const raw = eventlog.getToolOutput(result.sessionId, String(event.data.callId))?.output;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(parsed?.results) ? parsed.results : [];
    });
  const sheetRows = returnedRows.filter(row => [CREATE_OPERATION, UPDATE_OPERATION].includes(row.name));
  assert.ok(returnedRows.some(row => row.name === READ_OPERATION && row.capabilityRef),
    'read routing remains usable when the write reviewer is unavailable');
  assert.ok(sheetRows.length > 0, 'metadata must still be exposed, not hidden to make the negative pass');
  assert.ok(sheetRows.every(row => row.planningRefStatus === 'account_selection_required'
    && row.accountSelectionReason === 'review_unavailable' && !row.capabilityRef));
  assert.equal(events.filter(event => event.type === 'capability_resolution'
    && event.data.sourceUserSeq === result.sourceUserSeq)
    .flatMap(event => Array.isArray(event.data.entries) ? event.data.entries : [])
    .some(entry => entry.kind === 'composio' && entry.status === 'proven' && [CREATE_OPERATION, UPDATE_OPERATION].includes(entry.identifier)), false);
  assert.equal((capabilityCatalogs.peekHostCapabilityCatalogFactory()?.snapshot() ?? [])
    .some(entry => [CREATE_REF, UPDATE_REF].includes(entry.capabilityId)), false);
});

// ------------------------------------------------------------------ case 1 --
if (!PROCESS_RESTART_FIXTURE) test('the two-operation business request produces exactly four verified provider phases', { timeout: 180_000 }, async () => {
  const result = await runTurn({
    sessionId: 'derived-green', discloseVerifier: true, updateTargetId: SHEET_ID,
  });

  assert.deepEqual(planRequirementIds(result.sessionId), [CREATE_NODE, WRITE_NODE],
    'the expected-work graph is exactly the two operations the person asked for');

  assert.deepEqual(result.modelToolCalls.filter((entry) => entry.startsWith('work_call')),
    ['work_call:create', 'work_call:update'],
    'the model issues only its two business calls and never a readback');

  assert.deepEqual(sequence(result),
    [CREATE_OPERATION, READ_OPERATION, UPDATE_OPERATION, READ_OPERATION],
    'CREATE -> identity read -> UPDATE -> content read, in that exact order');
  assert.equal(count(result, CREATE_OPERATION), 1, 'the sheet is created exactly once');
  assert.equal(count(result, UPDATE_OPERATION), 1, 'the header row is written exactly once');
  assert.equal(count(result, READ_OPERATION), 2, 'each mutation is verified exactly once');

  const verifiers = result.bodies.filter((entry) => entry.operation === READ_OPERATION);
  assert.ok(verifiers.every((entry) => entry.via === 'catalog'),
    'verifier reads travel the host child-call route, never the business carrier');
  assert.ok(verifiers.every((entry) => String(entry.args.spreadsheet_id) === SHEET_ID),
    'both verifiers read back the exact created resource');

  const settled = settledVerifierCalls(result.sessionId);
  assert.equal(settled.length, 2, 'each verifier has its own durable settlement');
  assert.equal(new Set(settled).size, 2,
    'the two verifiers carry DISTINCT deterministic identities — they prove different states');

  assert.equal(terminalPresentation(result.sessionId).status, 'done',
    'canonical terminal status agrees with the durable record');
});

// ------------------------------------------------------------------ case 2 --
if (!PROCESS_RESTART_FIXTURE) test('a header write aimed at any id but the verified created id is stopped by target comparison', { timeout: 180_000 }, async () => {
  const result = await runTurn({
    sessionId: 'derived-wrong-target', discloseVerifier: true, updateTargetId: 'some-other-spreadsheet',
  });

  // This oracle must not be satisfiable by "nothing ran": the create and its
  // identity verification MUST have happened, so the only thing standing
  // between the header write and the wire is the target comparison itself.
  assert.equal(count(result, CREATE_OPERATION), 1, 'the create really happened');
  assert.equal(count(result, READ_OPERATION), 1, 'its identity verifier really ran');
  assert.equal(count(result, UPDATE_OPERATION), 0,
    'a write whose target is not the verified created id never crosses the wire');
  assert.deepEqual(sequence(result), [CREATE_OPERATION, READ_OPERATION],
    'the run stops after identity verification; no content verifier is reached');
});

// ------------------------------------------------------------------ case 3 --
if (!PROCESS_RESTART_FIXTURE) test('partial work tells the truth: the sheet exists, the header row does not', { timeout: 180_000 }, async () => {
  const result = await runTurn({
    sessionId: 'derived-partial', discloseVerifier: true, updateTargetId: 'some-other-spreadsheet',
  });

  assert.equal(count(result, CREATE_OPERATION), 1, 'create genuinely happened');
  assert.equal(count(result, UPDATE_OPERATION), 0, 'the header write genuinely did not');

  const presentation = terminalPresentation(result.sessionId);
  assert.notEqual(presentation.status, 'completed',
    'a run whose header requirement is unobserved is not completed');
  const published = [presentation.text ?? '', ...result.edits].join('\n');
  assert.doesNotMatch(published, /with its header row/i,
    'the model claimed both completed; durable truth must override that claim');
  assert.match(published, /requested resource/i,
    'qualified partial truth is preserved — the requested resource really was created');
});

// ------------------------------------------------------------------ case 4 --
if (!PROCESS_RESTART_FIXTURE) test('replaying a completed run adds zero provider crossings', { timeout: 180_000 }, async () => {
  const result = await runTurn({
    sessionId: 'derived-replay', discloseVerifier: true, updateTargetId: SHEET_ID,
    replaySameRequest: true,
  });
  assert.equal(result.bodies.length, 4, 'the first run crossed exactly four times');
  assert.equal(result.replayAdditionalProviderCrossings, 0,
    'the identical durable request replays its terminal with zero provider I/O');
  assert.equal(result.replayAdditionalModelCalls, 0,
    'the identical durable request does not invoke the model again');
  assert.equal(result.replayAdditionalTerminalEvents, 0,
    'the identical durable request reuses the one committed terminal');
});

// ------------------------------------------------------------------ case 5 --
if (!PROCESS_RESTART_FIXTURE) test('a plan with no exact verifier is admitted and carries the obligation', { timeout: 180_000 }, async () => {
  const result = await runTurn({
    sessionId: 'derived-no-verifier', discloseVerifier: false, updateTargetId: SHEET_ID,
  });

  const record = eventlog.getToolOutput(result.sessionId, 'admit-plan') as { output?: unknown } | null;
  const text = String(record?.output ?? '');
  assert.match(text, /"ok":\s*true/, 'missing staged verifier must not refuse the plan');
  assert.doesNotMatch(
    text,
    /verification_successor_required:no_compatible_verifier/,
    'G15 zero-candidate must carry the obligation, not refuse',
  );
  // Since 5faf8eb7 the next-step reads "wrote and could not confirm — never
  // claim done" and the admit output carries the obligation itself as
  // unverifiedMutations. The contract is unchanged: a missing exact verifier is
  // an OBLIGATION carried into the terminal — never a plan refusal, never a done
  // claim.
  assert.match(
    text,
    /could not (verify|confirm)/,
    'the admitted plan names the honest unverified-write report',
  );
  assert.match(text, /never claim done/, 'the admitted plan forbids a done claim on an unconfirmed write');
  const admitted = JSON.parse(text) as { unverifiedMutations?: unknown };
  assert.ok(
    Array.isArray(admitted.unverifiedMutations) && admitted.unverifiedMutations.length > 0,
    'the admitted plan carries the unverified-write obligation on every write requirement',
  );
});

let verifierRecoverySequence = 0;
async function recoverVerifier(result: TurnResult, extra: { isKillRequested?: () => boolean } = {}) {
  const recovery = await import('../runtime/harness/mutation-verification-executor.js');
  const leases = await import('../runtime/harness/dispatch-lease.js');
  const brackets = await import('../runtime/harness/brackets.js');
  const parentLease = leases.activateDispatchLease({ sessionId: result.sessionId,
    scopeId: `controlled-verifier-recovery-${++verifierRecoverySequence}` });
  try {
    return await brackets.withHarnessRunContext({ sessionId: result.sessionId,
      sourceUserSeq: result.sourceUserSeq, turn: 1, dispatchLease: parentLease,
      counter: new brackets.ToolCallsCounter(10),
    }, () => recovery.recoverCommittedMutationVerificationsForSource({
        sessionId: result.sessionId, sourceUserSeq: result.sourceUserSeq,
        parentLease, deadlineMs: 10_000, ...extra,
      }));
  } finally { leases.revokeDispatchLease(parentLease); }
}

function verifierSettlementTimes(result: TurnResult): number[] {
  return (eventlog.openEventLog().prepare(`SELECT settled_at FROM logical_call_settlements
    WHERE session_id = ? AND source_user_seq = ?
      AND (logical_tool_call_id LIKE 'verify:%' OR logical_tool_call_id LIKE 'verify-retry:%')
    ORDER BY settled_at, logical_tool_call_id`).all(result.sessionId, result.sourceUserSeq) as Array<{ settled_at: string }>)
    .map(row => Date.parse(row.settled_at));
}

if (!PROCESS_RESTART_FIXTURE) test('the actual host retains a same-source verifier wait and resumes only unfinished work when due', { timeout: 180_000 }, async () => {
  let now = Date.now();
  const clock = mock.method(Date, 'now', () => now);
  const host = await import('../runtime/harness/host-turn-runner.js');
  try {
    const result = await runTurn({ sessionId: 'derived-verifier-host-resume', discloseVerifier: true,
      updateTargetId: SHEET_ID, verifierFailures: ['transient'], controlledCompletionReview: true });
    assert.deepEqual(sequence(result), [CREATE_OPERATION, READ_OPERATION]);
    assert.equal(result.hostResults?.[0]?.status, 'held');
    assert.ok(result.redriveAcceptedSource);
    const { HarnessSession } = await import('../runtime/harness/session.js');
    const { HostRecoveryState } = await import('../runtime/harness/host-turn-runner.js');
    const recovery = await import('../runtime/harness/mutation-verification-executor.js');
    const identity = { sessionId: result.sessionId, sourceUserSeq: result.sourceUserSeq };
    const retainedState = () => {
      const serialized = HarnessSession.load(result.sessionId)?.loadRecoveryState();
      assert.ok(serialized, 'the real host retains durable recovery ownership');
      const state = HostRecoveryState.fromString(serialized);
      assert.equal(state.phase, 'continue', 'the host owns continuation rather than owner-call replay');
      assert.equal(state.sessionId, result.sessionId);
      assert.equal(state.sourceUserSeq, result.sourceUserSeq);
      return state;
    };
    const initialState = retainedState();
    const modelsBeforeWait = result.modelToolCalls.length;
    const anchor = verifierSettlementTimes(result)[0]!;
    assert.ok(Number.isSafeInteger(anchor));
    eventlog.closeEventLog();
    now = anchor + 999;
    const waiting = await result.redriveAcceptedSource();
    assert.equal(waiting.status, 'held', JSON.stringify(waiting));
    assert.deepEqual(waiting.hold, { owner: 'host', wake: 'recovery', reason: 'recovery_pending' });
    assert.equal(retainedState().stepIndex, initialState.stepIndex,
      'an early activation does not consume a model continuation step');
    assert.deepEqual(sequence(result), [CREATE_OPERATION, READ_OPERATION],
      'an early real host resume starts no getter, owner mutation, or downstream mutation');
    assert.equal(result.modelToolCalls.length, modelsBeforeWait, 'the pending host does not ask a model to wait or retry');
    assert.equal(result.controlledReviewCalls?.(), 0, 'waiting does not buy a completion review');
    const [hold] = recovery.committedMutationVerificationHoldsForSource(identity);
    assert.equal(hold?.ownerLogicalToolCallId, 'call-create');
    assert.equal(hold?.recoveryKind, 'automatic');
    assert.equal(hold?.verifierOnlyRetryable, true);
    assert.equal(hold?.nextNotBeforeAtMs, anchor + 1_000);
    assert.equal(eventlog.listEvents(result.sessionId, { types: ['conversation_completed'] }).length, 0,
      'waiting never publishes completion');

    now = anchor + 1_000;
    const completed = await result.redriveAcceptedSource();
    assert.equal(completed.status, 'completed', JSON.stringify(completed));
    assert.equal(result.controlledReviewCalls?.(), 1, 'the completed controlled task receives one bound fixture review');
    assert.deepEqual(sequence(result), [CREATE_OPERATION, READ_OPERATION, READ_OPERATION, UPDATE_OPERATION, READ_OPERATION],
      'due recovery reads the committed create, then performs and verifies only the unfinished header write');
    assert.equal(count(result, CREATE_OPERATION), 1, 'the committed owner write is never replayed');
    assert.equal(count(result, UPDATE_OPERATION), 1, 'the legitimate downstream write runs once, after verification');
    assert.ok(result.bodies.filter(body => body.operation === READ_OPERATION)
      .every(body => body.via === 'catalog' && body.args.spreadsheet_id === SHEET_ID));
    assert.deepEqual(result.modelToolCalls.filter(name => name.startsWith('work_call')),
      ['work_call:create', 'work_call:update'], 'recovery never asks the brain to regenerate a committed work_call');
    assert.equal(eventlog.listEvents(result.sessionId, { types: ['user_input_received'] }).length, 1,
      'all host activations belong to the original accepted source');
    assert.equal(eventlog.listEvents(result.sessionId, { types: ['conversation_completed'] }).length, 1);
    assert.equal(terminalPresentation(result.sessionId).status, 'done');
    assert.equal(HarnessSession.load(result.sessionId)?.loadRecoveryState(), null);
    assert.deepEqual(recovery.committedMutationVerificationHoldsForSource(identity), []);
    const { assertTerminalVerifierRetryProofControls } = await import('./terminal-verifier-retry.fixture-support.js');
    assert.equal(await assertTerminalVerifierRetryProofControls({ ...identity, ownerLogicalToolCallId: 'call-create' }), 8,
      'the actual completed retry proof rejects all eight independent corruptions in disposable clones');
    // This exercises the public host's pre-model recovery gate. Its defensive
    // executeCall deferred-return branch cannot be forced without fabricating
    // an admitted checkpoint for an already-settled owner call.
  } finally { host._setHostObjectiveJudgeForTests(null); clock.mock.restore(); }
});

if (!PROCESS_RESTART_FIXTURE) test('the actual host verifies a committed last-step write before enforcing its model-step ceiling', { timeout: 180_000 }, async () => {
  let now = Date.now();
  const clock = mock.method(Date, 'now', () => now);
  try {
    const result = await runTurn({ sessionId: 'derived-verifier-host-last-step', discloseVerifier: true,
      updateTargetId: SHEET_ID, verifierFailures: ['transient'] });
    assert.ok(result.redriveAcceptedSource);
    assert.equal(result.hostResults?.[0]?.status, 'held');
    assert.deepEqual(sequence(result), [CREATE_OPERATION, READ_OPERATION]);
    const { HarnessSession } = await import('../runtime/harness/session.js');
    const { HostRecoveryState } = await import('../runtime/harness/host-turn-runner.js');
    const state = () => {
      const serialized = HarnessSession.load(result.sessionId)?.loadRecoveryState();
      assert.ok(serialized);
      const held = HostRecoveryState.fromString(serialized);
      assert.equal(held.phase, 'continue');
      assert.equal(held.sourceUserSeq, result.sourceUserSeq);
      return held;
    };
    // Narrow only the activation budget to the real saved next model step.
    // No checkpoint, accepted source, or effect authority is manufactured.
    const maxTurns = state().stepIndex;
    assert.ok(Number.isSafeInteger(maxTurns) && maxTurns > 0);
    const anchor = verifierSettlementTimes(result)[0]!;
    assert.ok(Number.isSafeInteger(anchor));
    const originalModels = result.modelToolCalls.length;
    now = anchor + 999;
    const early = await result.redriveAcceptedSource({ maxTurns });
    assert.equal(early.status, 'held', JSON.stringify(early));
    assert.equal(state().stepIndex, maxTurns);
    assert.deepEqual(sequence(result), [CREATE_OPERATION, READ_OPERATION]);
    assert.equal(result.modelToolCalls.length, originalModels);
    assert.equal(eventlog.listEvents(result.sessionId, { types: ['conversation_completed'] }).length, 0);

    now = anchor + 1_000;
    const limited = await result.redriveAcceptedSource({ maxTurns });
    assert.equal(limited.status, 'blocked', JSON.stringify(limited));
    assert.equal(limited.blockedReason, 'max_turns');
    assert.deepEqual(sequence(result), [CREATE_OPERATION, READ_OPERATION, READ_OPERATION],
      'host readback crosses at due despite the exhausted reasoning budget');
    assert.equal(count(result, CREATE_OPERATION), 1);
    assert.equal(count(result, UPDATE_OPERATION), 0, 'the ceiling still prevents a new downstream write');
    assert.equal(result.modelToolCalls.length, originalModels, 'verification does not buy another reasoning step');
    const recovery = await import('../runtime/harness/mutation-verification-executor.js');
    assert.deepEqual(recovery.committedMutationVerificationHoldsForSource({ sessionId: result.sessionId,
      sourceUserSeq: result.sourceUserSeq }), [], 'the retained write is now actually verified');
    assert.equal(eventlog.listEvents(result.sessionId, { types: ['user_input_received'] }).length, 1);
    assert.equal(eventlog.listEvents(result.sessionId, { types: ['conversation_completed'] }).length, 1);
    assert.equal(terminalPresentation(result.sessionId).status, 'blocked');
    assert.doesNotMatch(terminalPresentation(result.sessionId).text ?? '', /created the sheet with its header row/i,
      'the missing header requirement never becomes a done claim');
    assert.equal(HarnessSession.load(result.sessionId)?.loadRecoveryState(), null);
  } finally { clock.mock.restore(); }
});

if (!PROCESS_RESTART_FIXTURE) test('the real checkpoint scheduler publishes Stop before a future verifier wake without reactivation', { timeout: 180_000 }, async () => {
  let now = Date.now();
  const clock = mock.method(Date, 'now', () => now);
  try {
    const result = await runTurn({ sessionId: 'derived-verifier-scheduled-stop', discloseVerifier: true,
      updateTargetId: SHEET_ID, verifierFailures: ['transient'] });
    assert.ok(result.redriveAcceptedSource);
    assert.deepEqual(sequence(result), [CREATE_OPERATION, READ_OPERATION]);
    const anchor = verifierSettlementTimes(result)[0]!;
    assert.ok(Number.isSafeInteger(anchor));
    // A controlled wall-clock rollback leaves the real future wake well beyond
    // the bounded Stop observation window; no retry delay is shortened.
    now = anchor - 10_000;
    const waiting = await result.redriveAcceptedSource({ scheduleRecovery: true });
    assert.equal(waiting.status, 'held', JSON.stringify(waiting));
    const modelsBeforeStop = result.modelToolCalls.length;
    const stoppedAt = performance.now();
    eventlog.requestKill(result.sessionId, 'stopped by the fixture owner', { sourceUserSeq: result.sourceUserSeq });
    const deadline = stoppedAt + 3_000;
    while (eventlog.listEvents(result.sessionId, { types: ['conversation_completed'] }).length === 0
      && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const terminals = eventlog.listEvents(result.sessionId, { types: ['conversation_completed'] });
    assert.equal(terminals.length, 1, 'the default timer publishes one stopped result within three seconds');
    assert.equal(terminalPresentation(result.sessionId).status, 'cancelled');
    assert.ok(performance.now() - stoppedAt < 3_000, 'Stop does not wait for the future verifier due time');
    assert.ok(now < anchor + 1_000);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(sequence(result), [CREATE_OPERATION, READ_OPERATION],
      'Stop starts no retry getter, repeated owner write, or unfinished downstream write');
    assert.equal(result.modelToolCalls.length, modelsBeforeStop, 'Stop never reactivates a model');
    assert.equal(eventlog.listEvents(result.sessionId, { types: ['conversation_completed'] }).length, 1);
    assert.equal(eventlog.listEvents(result.sessionId, { types: ['user_input_received'] }).length, 1);
    const { HarnessSession } = await import('../runtime/harness/session.js');
    assert.equal(HarnessSession.load(result.sessionId)?.loadRecoveryState(), null);
  } finally { clock.mock.restore(); }
});

if (!PROCESS_RESTART_FIXTURE) test('verifier cooldown survives reopen and resumes only one read after its immutable due time', { timeout: 180_000 }, async () => {
  let now = Date.now();
  const clock = mock.method(Date, 'now', () => now);
  try {
    const result = await runTurn({ sessionId: 'derived-verifier-cooldown', discloseVerifier: true,
      updateTargetId: SHEET_ID, verifierFailures: ['transient'] });
    assert.deepEqual(sequence(result), [CREATE_OPERATION, READ_OPERATION], 'the committed create is not retried after verifier failure');
    const recovery = await import('../runtime/harness/mutation-verification-executor.js');
    const identity = { sessionId: result.sessionId, sourceUserSeq: result.sourceUserSeq };
    const anchor = verifierSettlementTimes(result)[0]!;
    assert.ok(Number.isSafeInteger(anchor));
    now = anchor;
    const originalModels = result.modelToolCalls.length;
    const pending = await recoverVerifier(result);
    assert.equal(pending.status, 'held');
    if (pending.status !== 'held') return;
    assert.equal(pending.holds[0]?.nextNotBeforeAtMs, anchor + 1_000);
    assert.equal(pending.holds[0]?.recoveryKind, 'automatic');
    assert.equal(pending.holds[0]?.verifierOnlyRetryable, true);
    eventlog.closeEventLog();
    now = anchor - 10_000;
    const rollback = await recoverVerifier(result);
    assert.equal(rollback.status, 'held', 'clock rollback cannot make a retry due');
    if (rollback.status === 'held') assert.equal(rollback.holds[0]?.nextNotBeforeAtMs, anchor + 1_000);
    now = anchor + 999;
    assert.equal((await recoverVerifier(result)).status, 'held');
    assert.equal(result.bodies.length, 2, 'every early/reopened recovery performs zero provider calls');
    const foreign = eventlog.appendEvent({ sessionId: result.sessionId, role: 'user', turn: 2,
      type: 'user_input_received', data: { text: 'A distinct controlled source.' } });
    assert.deepEqual(recovery.committedMutationVerificationHoldsForSource({ ...identity, sourceUserSeq: foreign.seq }), []);
    assert.equal((await recoverVerifier({ ...result, sourceUserSeq: foreign.seq })).status, 'not_pending');
    assert.equal(result.bodies.length, 2, 'another accepted source cannot adopt the retained write');
    now = anchor + 1_000;
    const verified = await recoverVerifier(result);
    assert.equal(verified.status, 'verified', JSON.stringify(verified));
    assert.deepEqual(sequence(result), [CREATE_OPERATION, READ_OPERATION, READ_OPERATION]);
    assert.equal(count(result, CREATE_OPERATION), 1);
    assert.equal(count(result, UPDATE_OPERATION), 0, 'readback recovery does not run downstream writes');
    assert.equal(result.modelToolCalls.length, originalModels, 'pending and verification recovery require no model call');
    assert.deepEqual(recovery.committedMutationVerificationHoldsForSource(identity), []);
  } finally { clock.mock.restore(); }
});

if (!PROCESS_RESTART_FIXTURE) test('verifier cooldown keeps three attempts and anchors the last retry to the second settlement', { timeout: 180_000 }, async () => {
  let now = Date.now();
  const clock = mock.method(Date, 'now', () => now);
  try {
    const result = await runTurn({ sessionId: 'derived-verifier-exhaustion', discloseVerifier: true,
      updateTargetId: SHEET_ID, verifierFailures: ['transient', 'transient', 'transient'] });
    const first = verifierSettlementTimes(result)[0]!;
    now = first + 1_000;
    assert.equal((await recoverVerifier(result)).status, 'held');
    assert.equal(count(result, READ_OPERATION), 2);
    const second = verifierSettlementTimes(result).at(-1)!;
    now = second + 2_499;
    const waiting = await recoverVerifier(result);
    assert.equal(waiting.status, 'held');
    if (waiting.status === 'held') assert.equal(waiting.holds[0]?.nextNotBeforeAtMs, second + 2_500);
    assert.equal(count(result, READ_OPERATION), 2);
    now = second + 2_500;
    const exhausted = await recoverVerifier(result);
    assert.equal(exhausted.status, 'held');
    if (exhausted.status === 'held') {
      assert.equal(exhausted.holds[0]?.recoveryKind, 'exhausted');
      assert.equal(exhausted.holds[0]?.verifierOnlyRetryable, false);
    }
    now += 60_000;
    await recoverVerifier(result);
    assert.equal(count(result, READ_OPERATION), 3, 'a later wake cannot create a fourth automatic read');
    assert.equal(count(result, CREATE_OPERATION), 1);
  } finally { clock.mock.restore(); }
});

if (!PROCESS_RESTART_FIXTURE) test('verifier cooldown also waits when an acknowledged read still shows stale content', { timeout: 180_000 }, async () => {
  let now = Date.now();
  const clock = mock.method(Date, 'now', () => now);
  try {
    const result = await runTurn({ sessionId: 'derived-verifier-eventual', discloseVerifier: true,
      updateTargetId: SHEET_ID, verifierFailures: [null, 'eventual'] });
    assert.deepEqual(sequence(result), [CREATE_OPERATION, READ_OPERATION, UPDATE_OPERATION, READ_OPERATION]);
    const anchor = verifierSettlementTimes(result).at(-1)!;
    now = anchor + 999;
    const pending = await recoverVerifier(result);
    assert.equal(pending.status, 'held');
    if (pending.status === 'held') {
      assert.equal(pending.holds[0]?.ownerLogicalToolCallId, 'call-update');
      assert.equal(pending.holds[0]?.nextNotBeforeAtMs, anchor + 1_000);
    }
    assert.equal(result.bodies.length, 4);
    now = anchor + 1_000;
    eventlog.closeEventLog();
    assert.equal((await recoverVerifier(result)).status, 'verified');
    assert.equal(count(result, CREATE_OPERATION), 1);
    assert.equal(count(result, UPDATE_OPERATION), 1);
    assert.equal(count(result, READ_OPERATION), 3);
  } finally { clock.mock.restore(); }
});

if (!PROCESS_RESTART_FIXTURE) test('verifier user-action, catalog drift, Stop and invalid timing do not gain retry authority', { timeout: 180_000 }, async () => {
  const actualNow = Date.now.bind(Date);
  let now = Date.now();
  const clock = mock.method(Date, 'now', () => now);
  try {
    const auth = await runTurn({ sessionId: 'derived-verifier-auth', discloseVerifier: true,
      updateTargetId: SHEET_ID, verifierFailures: ['authentication'] });
    now = verifierSettlementTimes(auth)[0]! + 60_000;
    const needsUser = await recoverVerifier(auth);
    assert.equal(needsUser.status, 'held');
    if (needsUser.status === 'held') assert.equal(needsUser.holds[0]?.recoveryKind, 'user_action');
    assert.deepEqual(sequence(auth), [CREATE_OPERATION, READ_OPERATION]);

    now = actualNow();
    const drift = await runTurn({ sessionId: 'derived-verifier-drift', discloseVerifier: true,
      updateTargetId: SHEET_ID, verifierFailures: ['transient'] });
    now = verifierSettlementTimes(drift)[0]! + 1_000;
    const factory = capabilityCatalogs.peekHostCapabilityCatalogFactory()!;
    for (const entry of factory.snapshot()) if (entry.manifest?.operationId === READ_OPERATION) factory.forget(entry.capabilityId);
    const drifted = await recoverVerifier(drift);
    assert.equal(drifted.status, 'held');
    if (drifted.status === 'held') assert.equal(drifted.holds[0]?.recoveryKind, 'user_action');
    assert.deepEqual(sequence(drift), [CREATE_OPERATION, READ_OPERATION]);

    now = actualNow();
    const stopped = await runTurn({ sessionId: 'derived-verifier-stop', discloseVerifier: true,
      updateTargetId: SHEET_ID, verifierFailures: ['transient'] });
    now = verifierSettlementTimes(stopped)[0]! + 1_000;
    assert.equal((await recoverVerifier(stopped, { isKillRequested: () => true })).status, 'held');
    assert.deepEqual(sequence(stopped), [CREATE_OPERATION, READ_OPERATION]);

    now = actualNow();
    const invalid = await runTurn({ sessionId: 'derived-verifier-invalid-time', discloseVerifier: true,
      updateTargetId: SHEET_ID, verifierFailures: ['transient'] });
    const invalidTimestamp = new Date(verifierSettlementTimes(invalid)[0]!).toISOString();
    const parse = Date.parse;
    const badClock = mock.method(Date, 'parse', (value: string) => value === invalidTimestamp ? Number.NaN : parse(value));
    try {
      const held = await recoverVerifier(invalid);
      assert.equal(held.status, 'held');
      if (held.status === 'held') {
        assert.equal(held.holds[0]?.recoveryKind, 'exhausted');
        assert.match(held.holds[0]?.reason ?? '', /settlement time is invalid/);
      }
      assert.deepEqual(sequence(invalid), [CREATE_OPERATION, READ_OPERATION]);
    } finally { badClock.mock.restore(); }
  } finally { clock.mock.restore(); }
});

type DurableProviderCallSnapshot = {
  logicalToolCallId: string;
  operation: string;
  businessCall: boolean;
  logicalRows: number;
  physicalRows: number;
  settlementRows: number;
  resultRows: number;
};

function durableProviderSnapshot(sessionId: string, sourceUserSeq: number): DurableProviderCallSnapshot[] {
  const db = eventlog.openEventLog();
  return eventlog.listEvents(sessionId)
    .filter((event) => event.type === 'tool_attempt_settled')
    .map((event) => event.data as {
      sourceUserSeq?: number;
      executionKind?: string;
      physicalDispatchCount?: number;
      logicalToolCallId?: string;
      tool?: string;
      businessCall?: boolean;
    })
    .filter((data) => data.sourceUserSeq === sourceUserSeq
      && data.executionKind === 'provider_execution'
      && data.physicalDispatchCount === 1
      && typeof data.logicalToolCallId === 'string')
    .map((data) => {
      const callId = data.logicalToolCallId!;
      const counts = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM logical_tool_calls
            WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS logical_n,
          (SELECT COUNT(*) FROM physical_dispatches
            WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS physical_n,
          (SELECT COUNT(*) FROM logical_call_settlements
            WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS settlement_n,
          (SELECT COUNT(*) FROM durable_result_handles
            WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS result_n
      `).get(
        sessionId, sourceUserSeq, callId,
        sessionId, sourceUserSeq, callId,
        sessionId, sourceUserSeq, callId,
        sessionId, sourceUserSeq, callId,
      ) as { logical_n: number; physical_n: number; settlement_n: number; result_n: number };
      return {
        logicalToolCallId: callId,
        operation: String(data.tool ?? '').toUpperCase(),
        businessCall: data.businessCall === true,
        logicalRows: counts.logical_n,
        physicalRows: counts.physical_n,
        settlementRows: counts.settlement_n,
        resultRows: counts.result_n,
      };
    });
}

if (PROCESS_RESTART_FIXTURE) {
  const phase = process.env.CLEM_DERIVED_RESTART_PHASE;
  const bodyLog = process.env.CLEM_DERIVED_RESTART_BODY_LOG;
  if ((phase !== 'A' && phase !== 'B') || !bodyLog) {
    throw new Error('derived restart fixture requires phase A/B and an append-only provider body log');
  }
  const prior = phase === 'B'
    ? JSON.parse(Buffer.from(process.env.CLEM_DERIVED_RESTART_PRIOR ?? '', 'base64url').toString('utf8')) as {
        sessionId: string;
        sourceUserSeq: number;
        snapshot: DurableProviderCallSnapshot[];
      }
    : null;
  const sessionId = prior?.sessionId ?? 'derived-process-restart';
  const before = prior
    ? durableProviderSnapshot(prior.sessionId, prior.sourceUserSeq)
    : [];
  const result = await runTurn({
    sessionId,
    discloseVerifier: true,
    updateTargetId: SHEET_ID,
    resetDurableState: phase === 'A',
    replaySameRequest: phase === 'B',
    externalBodyLog: bodyLog,
    externalPhase: phase,
  });
  const snapshot = durableProviderSnapshot(result.sessionId, result.sourceUserSeq);
  try { eventlog.closeEventLog(); } catch { /* process exit owns final teardown */ }
  process.stdout.write(`\n@@CLEM_DERIVED_RESTART@@${JSON.stringify({
    phase,
    pid: process.pid,
    sessionId: result.sessionId,
    sourceUserSeq: result.sourceUserSeq,
    localProviderBodies: result.bodies.map((body) => body.operation),
    localModelCalls: result.modelToolCalls.length,
    replayAdditionalProviderCrossings: result.replayAdditionalProviderCrossings,
    replayAdditionalModelCalls: result.replayAdditionalModelCalls,
    replayAdditionalTerminalEvents: result.replayAdditionalTerminalEvents,
    before,
    snapshot,
  })}\n`);
}
