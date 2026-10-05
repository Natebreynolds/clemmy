/**
 * One Lean Rounds case in its own process and its own fresh isolated home:
 *
 *   CLEMENTINE_HOME=/tmp/fresh CLEMMY_TEST_ISOLATED_HOME=1 \
 *     node --import tsx src/journeys/lean-rounds.case.fixture.ts <scenario> <arm>
 *
 * lean-rounds.acceptance.test.ts spawns one of these per scenario and Jev arm.
 * A process per case is what makes the arms comparable: learned tool hot sets,
 * proven operations, memory and caches written by one turn can never reach
 * the next, and the Jev environment is fixed before any module reads it.
 *
 * The request runs through the exported channel runner -> bridge ->
 * runConversation -> production host. Only the model wire (an
 * evidence-seeking scripted model), the connected-provider wire, the System
 * One wire and the completion reviewer's model are fixtures. The turn is then
 * read back with scripts/score-turn-rounds.mts, the scorer used on the live
 * home, and one `LEAN_ROUNDS_CASE_RESULT {json}` line is printed.
 *
 * LEAN_ROUNDS_DUMP_DIR=/abs/dir writes the case's requests and events there
 * for diagnosis.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import {
  CALENDAR_ACCOUNT,
  CALENDAR_INPUT_SCHEMA,
  CALENDAR_OPERATION,
  CALENDAR_OUTPUT_SCHEMA,
  CALENDAR_PLANTED_FACTS,
  CALENDAR_TOOLKIT,
  HEARTBEAT_ID,
  HEARTBEAT_NEW_RULE,
  HEARTBEAT_SEEDED_RULE,
  JEV_ARMS,
  PROVIDER_ACCOUNT,
  PROVIDER_INPUT_SCHEMA,
  PROVIDER_OPERATION,
  PROVIDER_OUTPUT_SCHEMA,
  PROVIDER_PLANTED_FACTS,
  PROVIDER_TOOLKIT,
  SPACE_FILLER_ROWS,
  SPACE_PLANTED_FACTS,
  SPACE_SLUG,
  SPACE_TITLE,
  SPACE_VIEW_HTML,
  calendarPayload,
  decide,
  failingJevFetch,
  hangingJevFetch,
  providerGapPayload,
  requestView,
  scenarioScripts,
  scriptedJevFetch,
  spaceComparisonDocument,
  type CaseMetrics,
  type JevArm,
  type ScenarioId,
} from './lean-rounds-support.fixture.js';

const [scenarioArg, armArg] = process.argv.slice(2);
const SCRIPTS = scenarioScripts();
if (!scenarioArg || !(scenarioArg in SCRIPTS)) throw new Error(`unknown scenario ${scenarioArg}`);
if (!armArg || !JEV_ARMS.includes(armArg as JevArm)) throw new Error(`unknown Jev arm ${armArg}`);
const scenario = scenarioArg as ScenarioId;
const arm = armArg as JevArm;
const script = SCRIPTS[scenario];

const HOME = process.env.CLEMENTINE_HOME;
if (!HOME || process.env.CLEMMY_TEST_ISOLATED_HOME !== '1') {
  throw new Error('a Lean Rounds case runs only in a fresh isolated home');
}
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
process.env.CLEMMY_JEV = arm === 'jev_off' ? 'off' : 'on';
delete process.env.TYPESAFE_API_KEY;

mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-lean-rounds\n', 'utf8');
writeFileSync(path.join(HOME, 'state', 'auth.json'), JSON.stringify({
  source: 'native',
  codexOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', lastRefresh: new Date().toISOString() },
}), 'utf8');

const { Usage } = await import('@openai/agents');
const { CodexModelProvider } = await import('../runtime/harness/codex-model.js');
const discord = await import('../channels/discord-harness.js');
const bridge = await import('../runtime/harness/respond-bridge.js');
const { configureHarnessRuntime } = await import('../runtime/harness/codex-client.js');
const { buildOrchestratorAgent } = await import('../agents/orchestrator.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const productionAdapters = await import('../runtime/harness/production-capability-adapters.js');
const connectedCatalog = await import('../runtime/harness/connected-goal-catalog.js');
const semanticPorts = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
const composioTools = await import('../tools/composio-tools.js');
const composioClient = await import('../integrations/composio/client.js');
const reflection = await import('../memory/reflection.js');
const jevClient = await import('../runtime/jev/client.js');
const heartbeats = await import('../agents/heartbeats.js');
const { registerSpaceTools } = await import('../tools/space-tools.js');
const { canonicalPromptCacheRequest, observePromptCacheRequest } = await import('../runtime/harness/prompt-cache-observation.js');
const { harnessRunContextStorage } = await import('../runtime/harness/brackets.js');
const { recordModelUsage } = await import('../runtime/usage-log.js');
// The scorer lives with the repository scripts, outside the compiled source
// tree; it is loaded by path, and this file names only the fields it reads.
interface ScoredRound {
  provenance: {
    totalBytes: number;
    layerBytes: Record<string, number>;
    wireTools: string[];
    normalizedRequestDigest: string;
  } | null;
  composition: { buckets: Record<string, number>; bucketBytes: Record<string, number> } | null;
}
interface ScoredTurn {
  terminal: { status: string | null } | null;
  counts: { provenanceRequests: number; compositionEvents: number; brainLedgerRows: number };
  rounds: ScoredRound[];
  totals: { rounds: number; requestBytes: number };
  jev: { arm: string; calls: unknown[] };
}
const scorerModule = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/score-turn-rounds.mts')).href;
const { scoreAcceptedTurnRounds } = await import(scorerModule) as {
  scoreAcceptedTurnRounds: (home: string, sessionId: string, sourceUserSeq: number) => ScoredTurn;
};

reflection._testOnly_setReflectionExtractor(async () => (
  { facts: [], entities: [], pointers: [], resources: [], relationships: [] }
) as never);

function textMessage(text: string) {
  return { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] };
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
      ...(response.providerData && typeof response.providerData === 'object' ? { providerData: response.providerData } : {}),
    },
  } as never;
}

/**
 * A declared bytes/4 tokenizer at the recording provider boundary. Like every
 * model adapter, the boundary records the call in the usage ledger from the
 * harness run context (session, accepted source, attempt, prompt components);
 * the ledger attribution itself is production code.
 */
function usageReceipt(rawRequest: unknown, responseId: string) {
  const observation = observePromptCacheRequest(rawRequest as never);
  const layers = ['stablePolicy', 'turnContext', 'memoryContext', 'catalog', 'task'] as const;
  const inputTokens = layers.reduce((sum, name) => (
    sum + (observation.layers[name].bytes === 0 ? 0 : Math.max(1, Math.ceil(observation.layers[name].bytes / 4)))
  ), 0);
  const harnessContext = harnessRunContextStorage.getStore();
  recordModelUsage({
    sessionId: harnessContext?.sessionId ?? 'unknown',
    sourceUserSeq: harnessContext?.sourceUserSeq,
    attemptId: harnessContext?.runAttemptId,
    model: 'lean-rounds-scripted',
    trace: { brain: 'codex', modelCallId: responseId },
    cacheDialect: 'inclusive',
    inputTokens,
    cachedInputTokens: 0,
    outputTokens: 1,
    totalTokens: inputTokens + 1,
    responseId,
    promptComponents: harnessContext?.promptComponents,
    durationMs: 0,
  });
  return {
    usage: { requests: 1, inputTokens, outputTokens: 1, totalTokens: inputTokens + 1, inputTokensDetails: { cachedTokens: 0 } },
    providerData: {
      promptCacheUsage: { version: 1, cacheDialect: 'inclusive', inputTokens, cachedInputTokens: 0, uncachedInputTokens: inputTokens },
    },
  } as const;
}

type Handler = (input: Record<string, unknown>) => Promise<unknown> | unknown;
function resultText(result: unknown): string {
  return (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '';
}

// ---------------------------------------------------------------------------
// Network: only the Composio definition listing is answered; everything else
// is refused, so no case can reach a real service.
// ---------------------------------------------------------------------------
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith('https://backend.composio.dev/api/v3/tools?')) {
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`Lean Rounds case forbids external network: ${url}`);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Connected providers: two fixture toolkits behind the production Composio
// carrier. Discovery, account review and the carrier are production code.
// ---------------------------------------------------------------------------
const providerCalls: Array<{ slug: string; args: Record<string, unknown> }> = [];
{
  const rawTools = [
    {
      slug: PROVIDER_OPERATION,
      name: 'Domain keyword gaps',
      description: 'Compare two domains on organic keywords and return the keywords where the target ranks below the competitor, scored by gap.',
      toolkit: { slug: PROVIDER_TOOLKIT },
      inputParameters: PROVIDER_INPUT_SCHEMA,
      outputParameters: PROVIDER_OUTPUT_SCHEMA,
      version: 'fixture-keywordintel-v1',
    },
    {
      slug: CALENDAR_OPERATION,
      name: 'List calendar events',
      description: 'List events on a Google Calendar between two times.',
      toolkit: { slug: CALENDAR_TOOLKIT },
      inputParameters: CALENDAR_INPUT_SCHEMA,
      outputParameters: CALENDAR_OUTPUT_SCHEMA,
      version: 'fixture-googlecalendar-v1',
    },
  ];
  const accounts: Record<string, string> = { [PROVIDER_TOOLKIT]: PROVIDER_ACCOUNT, [CALENDAR_TOOLKIT]: CALENDAR_ACCOUNT };
  productionAdapters.installProductionTransport(async () => {
    throw new Error('Lean Rounds case forbids direct catalog execution outside work_call');
  });
  connectedCatalog.installConnectedRegistryPort(() => ({
    connectedToolkits: [PROVIDER_TOOLKIT, CALENDAR_TOOLKIT],
    tools: rawTools.map((tool) => ({ slug: tool.slug, schema: tool.inputParameters as unknown as Record<string, unknown> })),
  }));
  composioClient.__test__.setComposioApiKeyOverride('fixture-composio-key');
  composioClient.__test__.setConnectedAccountsLoader(async () => Object.entries(accounts).map(([toolkit, id]) => (
    { id, status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: toolkit } }
  )));
  composioClient.__test__.setComposioClient({
    client: { baseURL: 'https://backend.composio.dev' },
    getClient: () => ({
      withOptions: () => ({
        tools: {
          execute: async (operation: string, body: { arguments?: unknown }) => {
            const slug = operation.toUpperCase();
            providerCalls.push({ slug, args: structuredClone((body.arguments ?? {}) as Record<string, unknown>) });
            const data = slug === PROVIDER_OPERATION ? providerGapPayload()
              : slug === CALENDAR_OPERATION ? calendarPayload()
              : null;
            if (!data) throw new Error(`unexpected provider operation ${slug}`);
            return { data, error: null, successful: true, log_id: `fixture-${providerCalls.length}` };
          },
        },
      }),
    }),
    tools: {
      async getRawComposioTools(input: { tools?: string[]; toolkits?: string[] }) {
        const exact = new Set((input.tools ?? []).map((value) => value.toUpperCase()));
        const toolkits = new Set((input.toolkits ?? []).map((value) => value.toLowerCase()));
        return rawTools.filter((candidate) => (exact.size === 0 || exact.has(candidate.slug))
          && (toolkits.size === 0 || toolkits.has(candidate.toolkit.slug)));
      },
      async execute() {
        throw new Error('Lean Rounds case forbids the legacy Composio high-level execute fallback');
      },
    },
  } as never);
  // The default inner-dispatch map holds every local tool and this production
  // Composio carrier; nothing is substituted around them.
  assert.ok(composioTools.getComposioRuntimeTools().some((candidate) => candidate.name === 'composio_execute_tool'));
  semanticPorts.installTurnSemanticModelPort({
    async judgeAccountSelection(call: { toolkit: string; accountIdentity: string; proposalDigest: string }) {
      assert.equal(accounts[call.toolkit], call.accountIdentity, 'account review sees the fixture connection');
      return { verdict: 'default_compatible', proposalDigest: call.proposalDigest, modelIdentity: 'fixture-account-reviewer' };
    },
    async interpret() { throw new Error('hidden pre-loop semantic model pass'); },
    async judgeSourceEffect() { throw new Error('hidden pre-loop semantic effect judge'); },
    async judgePlanGrounding() { throw new Error('hidden pre-loop semantic grounding judge'); },
  } as never);
}

// ---------------------------------------------------------------------------
// Seed the fixtures through their production owners.
// ---------------------------------------------------------------------------
eventlog.resetEventLog();
const configured = await configureHarnessRuntime();
assert.equal(configured.ok, true, configured.ok ? '' : configured.reason);

const spaceHandlers: Record<string, Handler> = {};
registerSpaceTools({ tool(name: string, _d: string, _p: unknown, handler: Handler) { spaceHandlers[name] = handler; } } as never);
const saved = resultText(await spaceHandlers.space_save!({
  slug: SPACE_SLUG,
  title: SPACE_TITLE,
  objective: 'Keep the keyword comparison of the three example domains on hand.',
  view_html: SPACE_VIEW_HTML,
  initial_data_json: JSON.stringify(spaceComparisonDocument(SPACE_FILLER_ROWS)),
}));
assert.match(saved, /Created workspace/, saved);
const spaceGetBody = resultText(await spaceHandlers.space_get!({ slug: SPACE_SLUG }));
assert.ok(spaceGetBody.length >= 10_000 && spaceGetBody.length <= 11_000,
  `the space_get body is ~10,500 characters (got ${spaceGetBody.length})`);
for (const fact of SPACE_PLANTED_FACTS) {
  const at = spaceGetBody.indexOf(fact);
  assert.ok(at > 4_000 && at < spaceGetBody.length - 2_000,
    `planted fact "${fact}" sits after character 4,000 and clear of the body's tail (at ${at} of ${spaceGetBody.length})`);
}
const seededRule = heartbeats.addRule(HEARTBEAT_ID, HEARTBEAT_SEEDED_RULE, 'owner');
assert.equal(seededRule.ok, true);
const rulesBefore = (await heartbeats.heartbeatStatus(HEARTBEAT_ID)).contract.rules.map((rule) => rule.text);

// ---------------------------------------------------------------------------
// The completion reviewer's model wire: a fixed verdict, counted.
// ---------------------------------------------------------------------------
let reviews = 0;
mock.method(CodexModelProvider.prototype, 'getModel', () => ({
  async getResponse() {
    reviews += 1;
    // The reviewer answers as it is told to: the verdict, and the one memory
    // requirement line (ignored unless the review asked for it).
    return { usage: new Usage(), responseId: `review-${reviews}`, output: [textMessage([
      'DONE: the reply answers the request from the settled results.',
      'MEMORY_REQUIREMENT: {"version":1,"kind":"none","corrections":[],"reason":"a lookup asks nothing to be remembered"}',
    ].join('\n'))] };
  },
  async *getStreamedResponse() { throw new Error('completion review uses the one-turn nonstreaming Runner'); },
}) as never);

// ---------------------------------------------------------------------------
// One turn: the evidence-seeking scripted model as the brain, driven through
// the exported channel runner.
// ---------------------------------------------------------------------------
interface TurnRun {
  sessionId: string;
  sourceUserSeq: number;
  requests: unknown[];
  route: string[];
  sent: string[];
  turnMs: number;
}

async function runTurn(sessionId: string): Promise<TurnRun> {
  const requests: unknown[] = [];
  const route: string[] = [];
  const scriptedModel = {
    async getResponse(rawRequest: unknown) {
      requests.push(rawRequest);
      const responseId = `${sessionId}-${requests.length}`;
      const decision = decide(script, rawRequest, requests.length);
      const receipt = usageReceipt(rawRequest, responseId);
      if (decision.kind === 'answer') {
        route.push('answer');
        const text = decision.text ?? '';
        return {
          ...receipt,
          responseId,
          output: [textMessage(JSON.stringify({ summary: text, reply: text, done: true, nextAction: 'completed', reason: null }))],
        };
      }
      route.push(decision.name === 'call_tool' || decision.name === 'work_call'
        ? `${decision.name}>${String((decision.args as { name?: unknown }).name)}`
        : decision.name!);
      return { ...receipt, responseId, output: [functionCall(responseId, decision.name!, decision.args!)] };
    },
    getStreamedResponse: streamResponse,
  };
  bridge._setBridgeImplsForTests({
    buildAgent: async (options) => buildOrchestratorAgent({ ...options, model: scriptedModel as never }),
  });
  const session = eventlog.createSession({ id: sessionId, kind: 'chat', userId: 'lean-rounds-owner' });
  let sourceUserSeq = 0;
  const sent: string[] = [];
  const started = Date.now();
  await discord.runDiscordHarnessConversation({
    prompt: script.prompt,
    rawPrompt: script.prompt,
    channelId: `${sessionId}-channel`,
    userId: 'lean-rounds-owner',
    guildId: 'lean-rounds-guild',
    transport: {
      async sendInitial(content: string) { sent.push(content); return { async edit(next: string) { sent.push(next); } }; },
      async sendError(content: string) { sent.push(content); },
      async sendFollowup(content: string) { sent.push(content); },
    } as never,
    durableRequest: {
      sessionId: session.id,
      runId: `${sessionId}-run`,
      onSourceAccepted(source: { seq: number }) { sourceUserSeq = source.seq; },
    },
  });
  assert.ok(sourceUserSeq > 0, `${sessionId}: the runner accepted one durable source`);
  return { sessionId: session.id, sourceUserSeq, requests, route, sent, turnMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// A warm scenario first asks the same thing once in another conversation,
// with no Jev key, so every arm starts from the same learned state.
// ---------------------------------------------------------------------------
if (script.warmUp) {
  jevClient._setTypesafeKeyForTests(null);
  const warm = await runTurn(`lean-${scenario}-${arm}-warmup`);
  assert.equal(scoreAcceptedTurnRounds(HOME, warm.sessionId, warm.sourceUserSeq).terminal?.status, 'done',
    'the warm-up turn completes');
  providerCalls.length = 0;
}

// ---------------------------------------------------------------------------
// The Jev arm for the measured turn.
// ---------------------------------------------------------------------------
const jevLog: string[] = [];
if (arm === 'jev_off') {
  jevClient._setTypesafeKeyForTests(null);
  jevClient._setSystemOneFetchForTests(async () => {
    throw new Error('Jev is off: no System One request may leave the host');
  });
} else {
  jevClient._setTypesafeKeyForTests('fixture-jev-key');
  jevClient._setSystemOneFetchForTests(arm === 'jev_hang' ? hangingJevFetch
    : arm === 'jev_http_500' ? failingJevFetch
    : scriptedJevFetch(script.steps.map((step) => step.tool), jevLog));
}
reviews = 0;
const measured = await runTurn(`lean-${scenario}-${arm}`);
const { requests, route, sent, turnMs } = measured;
if (process.env.LEAN_ROUNDS_DUMP_DIR) {
  writeFileSync(path.join(process.env.LEAN_ROUNDS_DUMP_DIR, `${scenario}-${arm}.json`), JSON.stringify({
    route, sent, jevLog, requests,
    events: eventlog.listEvents(measured.sessionId).map((event) => ({ seq: event.seq, type: event.type, data: event.data })),
  }, null, 1));
}

// ---------------------------------------------------------------------------
// Read the turn back. Three readings must agree: the requests this model
// actually received, durable provenance, and prompt_composition.
// ---------------------------------------------------------------------------
const score = scoreAcceptedTurnRounds(HOME, measured.sessionId, measured.sourceUserSeq);
assert.equal(score.counts.provenanceRequests, requests.length, 'one provenance row per request the model received');
assert.equal(score.counts.compositionEvents, requests.length, 'one prompt_composition event per request');
assert.equal(score.counts.brainLedgerRows, requests.length, 'one brain ledger row per request');
assert.deepEqual(
  score.rounds.map((round) => round.provenance?.normalizedRequestDigest),
  requests.map((request) => canonicalPromptCacheRequest(request as never).observation.normalizedRequestDigest),
  'provenance digests are derived from the exact requests the model received',
);
const round1 = score.rounds[0]!;
assert.deepEqual(round1.provenance!.wireTools, [...requestView(requests[0]).tools],
  'provenance names exactly the tools on the round-1 wire');
if (arm === 'jev_off') assert.equal(score.jev.calls.length, 0, 'Jev off writes no router rows');
assert.equal(score.terminal?.status, 'done', `the turn completes: ${JSON.stringify({ terminal: score.terminal, route, reply: sent.at(-1) })}`);

const reply = sent.at(-1) ?? '';
for (const fact of script.evidence) assert.ok(reply.includes(fact), `the reply names the planted fact "${fact}"`);
if (scenario === 'b_heartbeat_edit') {
  const added = (await heartbeats.heartbeatStatus(HEARTBEAT_ID)).contract.rules
    .filter((rule) => !rulesBefore.includes(rule.text));
  assert.deepEqual(added.map((rule) => rule.text), [HEARTBEAT_NEW_RULE], 'exactly one new heartbeat rule, in the owner\'s words');
}
if (scenario === 'c_provider_carrier_read') {
  assert.deepEqual(providerCalls.map((call) => call.slug), [PROVIDER_OPERATION], 'one provider read');
  for (const fact of PROVIDER_PLANTED_FACTS) assert.ok(reply.includes(fact));
}
if (scenario === 'd_calendar_read' || scenario === 'f_calendar_read_warm') {
  assert.deepEqual(providerCalls.map((call) => call.slug), [CALENDAR_OPERATION], 'one calendar read');
  for (const fact of CALENDAR_PLANTED_FACTS) assert.ok(reply.includes(fact));
}
if (scenario === 'a_saved_work_lookup' || scenario === 'b_heartbeat_edit' || scenario === 'e_no_signal_control') {
  assert.deepEqual(providerCalls, [], 'no provider crossing');
}

const metrics: CaseMetrics = {
  scenario,
  arm,
  rounds: score.totals.rounds,
  round1Bytes: round1.provenance!.totalBytes,
  round1Layers: { ...round1.provenance!.layerBytes },
  round1BucketTokens: { ...round1.composition!.buckets },
  round1BucketBytes: { ...round1.composition!.bucketBytes },
  round1WireTools: round1.provenance!.wireTools,
  round1OnRequestTools: [...requestView(requests[0]).onRequest],
  totalRequestBytes: score.totals.requestBytes,
  toolRoute: route,
  jevRouterRows: score.jev.calls.length,
  jevArmObserved: score.jev.arm,
  reviews,
  turnMs,
  completed: true,
};
process.stdout.write(`\nLEAN_ROUNDS_CASE_RESULT ${JSON.stringify(metrics)}\n`);
eventlog.closeEventLog();
process.exit(0);
