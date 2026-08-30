/**
 * Run: node scripts/run-tests-isolated.mjs src/journeys/ordinary-conversation-competitive-acceptance.test.ts
 *
 * Competitive foreground-conversation gate. This deliberately enters through
 * the exported Discord accepted-channel runner, the shared response bridge,
 * runConversation, and host_v1. The model wire is immediate and recording;
 * every other potentially expensive or effectful wire is a counting tripwire.
 *
 * The positive cohort proves that ordinary talk is still one real model turn,
 * not a canned classifier response, while paying none of the action ceremony.
 * The near-action negatives prove the cheap surface is conservative: a social
 * prefix cannot hide a concrete request from the full foreground action path.
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-ordinary-conversation-competitive-'));
const TRUE_SESSION_PREFIX = 'discord-ordinary-conversation-';

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
process.env.CLEMMY_SEMANTIC_RECALL = 'on';
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
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-ordinary-conversation-competitive\n', 'utf8');
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
const connectedCatalog = await import('../runtime/harness/connected-goal-catalog.js');
const semanticPorts = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
const productionAdapters = await import('../runtime/harness/production-capability-adapters.js');
const composioClient = await import('../integrations/composio/client.js');
const schemaCache = await import('../tools/composio-schema-cache.js');
const embeddings = await import('../memory/embeddings.js');

const originalFetch = globalThis.fetch;

const GREETINGS = [
  'Hi',
  'Hello',
  'Hey there',
  'Howdy',
  'Yo',
  'Good morning',
  'Good afternoon',
  'Good evening',
  'Good night',
  "What's up?",
  "How's it going?",
  'How are you?',
  'You there?',
  'Sup?',
  'Hi Clementine',
  'Hello again',
  'Hey friend',
  'Howdy there',
  'Yo Clementine',
  'Good morning, Clem',
  'Good afternoon, Clem',
  'Good evening, Clem',
  'Nice to see you',
  'Awesome to see you',
  'Amazing to see you',
  'Sweet to see you',
  "Hey, hope you're well",
  'Hello, hope all is well',
  "Hi! Glad you're here",
  'Howdy! Hope things are good',
] as const;

const THANKS_AND_ACKS = [
  'Thanks',
  'Thank you',
  'Thanks a lot',
  'Thank you so much',
  'Ty',
  'Cheers',
  'Appreciate it',
  'Nice',
  'Okay',
  'Ok',
  'Cool',
  'Got it',
  'Sounds good',
  'Sweet',
  'Perfect',
  'Awesome',
  'Amazing',
  'Haha',
  'Lol',
  'Lmao',
  'Bye',
  'Goodnight',
  'See ya',
  'Talk later',
  'Later',
  'Nice work',
  'Thanks again',
  'Cheers, friend',
  'Okay then',
  'Cool, understood',
] as const;

const CONVERSATIONAL_QUESTIONS = [
  "What's 2 plus 2?",
  'What is two plus two?',
  'What are prime numbers?',
  'Who is Ada Lovelace?',
  'Who was Marie Curie?',
  'Why is the sky blue?',
  'Why do cats purr?',
  'Why do leaves fall?',
  'Why does ice float?',
  'Why is grass green?',
  'How do rainbows form?',
  'How do magnets attract?',
  'How does gravity work?',
  'How are clouds formed?',
  'What is photosynthesis?',
  'What is a sonnet?',
  'What is recursion?',
  'What are black holes?',
  'What are tectonic plates?',
  'What was the Renaissance?',
  'Who is Sherlock Holmes?',
  'Who was Odysseus?',
  'Why is snow white?',
  'Why does thunder rumble?',
  'Why do stars twinkle?',
  'How do seasons happen?',
  'What is a metaphor?',
  'What is symmetry?',
  'What is 12 times 7?',
  'Why do bubbles look round?',
] as const;

const SIMPLE_EXPLANATIONS = [
  'What causes an echo?',
  'What causes ocean waves?',
  'What causes a solar eclipse?',
  'What causes morning dew?',
  'What causes static electricity?',
  'What causes a rainbow?',
  'What makes bread rise?',
  'What makes popcorn pop?',
  'What makes metal rust?',
  'What makes soap bubble?',
  'Why does the moon have phases?',
  'Why do owls hunt at night?',
  'Why do planets orbit stars?',
  'Why does salt melt ice?',
  'Why does sound need a medium?',
  'Why is copper conductive?',
  'Why is glass transparent?',
  'Why is the ocean salty?',
  'Why is space dark?',
  'How does a compass point north?',
  'How does a prism split light?',
  'How does a seed become a tree?',
  'How does a zipper work?',
  'How does a thermostat work?',
  'How does a lever multiply force?',
  'How does camouflage help animals?',
  'How does an eclipse happen?',
  'What causes fog?',
  'What causes wind?',
  'What causes lightning?',
] as const;

const DIRECT_GENERATION = [
  'Create a haiku about rain.',
  'Write a limerick about cats.',
  'Build a simple packing checklist.',
  'Generate three title ideas.',
  'Prepare a short agenda.',
  'Design a simple workout.',
  'Rewrite this sentence: Hello.',
  'Make a two-item grocery list.',
  'Produce a short bedtime story.',
  'Create a four-line poem.',
] as const;

const NEAR_ACTION_NEGATIVES = [
  'Hi, save this haiku to a Desktop file.',
  'Thanks, email the limerick to Alex.',
  'Okay, put the packing list in a new Google Sheet.',
  'Cool, schedule lunch for noon tomorrow.',
  'Nice, update the named Project Note.',
  'Sweet, set a five-minute timer.',
  'Perfect, create three Todoist tasks.',
  'Awesome, upload the story to Google Drive.',
  'Amazing, search the current web for title trends.',
  'Howdy, open a blank document on my Mac.',
  'Thank you, add a heading to the existing note.',
  'Cheers, message the agenda to the team.',
  'Hey there, save the workout as a Desktop file.',
  'Hello, book a calendar event for Friday.',
  'Yo, put the poem into a new Google Doc.',
] as const;

type CaseKind = 'conversation' | 'near_action';

interface ConversationCase {
  id: string;
  prompt: string;
  kind: CaseKind;
}

interface RecordedModelRequest {
  caseId: string;
  toolNames: string[];
  advertisedToolSchemaBytes: number;
  preWireWallMs: number;
  preWireCpuMs: number;
  wireMs: number;
  wireCpuMs: number;
}

interface CausalTimerAttribution {
  active: boolean;
  hostFiredDelayMs: number;
  wireFiredDelayMs: number;
}

interface OrdinaryLatencySample {
  wallMs: number;
  hostCpuMs: number;
  hostFiredDelayMs: number;
}

interface HostPhaseMark {
  wallMs: number;
  cpuMs: number;
}

interface ActiveHostTiming {
  wallStartedAt: number;
  cpuStarted: ReturnType<typeof process.cpuUsage>;
  accepted?: HostPhaseMark;
  buildStarted?: HostPhaseMark;
  buildCompleted?: HostPhaseMark;
}

const causalTimerAttribution = new AsyncLocalStorage<CausalTimerAttribution>();
const modelWireTimerPhase = new AsyncLocalStorage<boolean>();

interface BuildRecord {
  caseId: string;
  hostPlainConversation: boolean;
  hostFreshPlanning: boolean;
}

interface DeliveryRecord {
  initial: string[];
  edits: string[];
  errors: string[];
  followups: string[];
  transport: {
    sendInitial(content: string): Promise<{ edit(content: string): Promise<void> }>;
    sendError(content: string): Promise<void>;
    sendFollowup(content: string): Promise<void>;
  };
}

interface ExternalCounters {
  catalogRegister: number;
  catalogForget: number;
  catalogClear: number;
  catalogSnapshot: number;
  catalogGet: number;
  catalogBuild: number;
  connectedRegistry: number;
  schemaLoads: number;
  embeddingCalls: number;
  embeddingTexts: number;
  providerCrossings: number;
  composioListings: number;
  composioExecutions: number;
  networkFetches: number;
  semanticInterpret: number;
  semanticEffectJudge: number;
  semanticGroundingJudge: number;
}

function blankCounters(): ExternalCounters {
  return {
    catalogRegister: 0,
    catalogForget: 0,
    catalogClear: 0,
    catalogSnapshot: 0,
    catalogGet: 0,
    catalogBuild: 0,
    connectedRegistry: 0,
    schemaLoads: 0,
    embeddingCalls: 0,
    embeddingTexts: 0,
    providerCrossings: 0,
    composioListings: 0,
    composioExecutions: 0,
    networkFetches: 0,
    semanticInterpret: 0,
    semanticEffectJudge: 0,
    semanticGroundingJudge: 0,
  };
}

function counterDelta(afterValue: ExternalCounters, beforeValue: ExternalCounters): ExternalCounters {
  return Object.fromEntries(
    Object.keys(afterValue).map((key) => [
      key,
      afterValue[key as keyof ExternalCounters] - beforeValue[key as keyof ExternalCounters],
    ]),
  ) as unknown as ExternalCounters;
}

function textMessage(text: string) {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}

async function* streamResponse(
  this: { getResponse: (request: unknown) => Promise<Record<string, unknown>> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = Array.isArray(response.output) ? response.output : [];
  yield { type: 'response_started' } as never;
  yield { type: 'model', event: { type: 'finish', finishReason: 'stop' } } as never;
  yield {
    type: 'response_done',
    response: {
      id: typeof response.responseId === 'string' ? response.responseId : 'fixture-response',
      usage: response.usage ?? { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
    },
  } as never;
}

function recordingTransport(): DeliveryRecord {
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
        return {
          async edit(next: string) { edits.push(next); },
        };
      },
      async sendError(content: string) { errors.push(content); },
      async sendFollowup(content: string) { followups.push(content); },
    },
  };
}

function percentile(sorted: readonly number[], proportion: number): number {
  assert.ok(sorted.length > 0);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * proportion) - 1));
  return sorted[index]!;
}

function fixed(value: number): number {
  return Number(value.toFixed(3));
}

function correctedHostCpuMs(totalCpuMs: number, wireCpuMs: number): number {
  return Math.max(0, totalCpuMs - wireCpuMs);
}

function evaluateOrdinaryLatency(
  samples: readonly OrdinaryLatencySample[],
  limitMs = 50,
): {
  wallMedianMs: number;
  wallP95Ms: number;
  causalP95Ms: number;
  violations: Array<{ gate: string; detail: unknown }>;
} {
  assert.ok(samples.length > 0);
  const wall = samples.map((entry) => entry.wallMs).sort((left, right) => left - right);
  const causal = samples
    .map((entry) => entry.hostCpuMs + entry.hostFiredDelayMs)
    .sort((left, right) => left - right);
  const wallMedianMs = percentile(wall, 0.50);
  const wallP95Ms = percentile(wall, 0.95);
  const causalP95Ms = percentile(causal, 0.95);
  const violations: Array<{ gate: string; detail: unknown }> = [];
  if (wallP95Ms > limitMs) {
    violations.push({
      gate: 'positive_host_wall_p95_le_50ms',
      detail: { wallMedianMs: fixed(wallMedianMs), wallP95Ms: fixed(wallP95Ms) },
    });
  }
  if (causalP95Ms > limitMs) {
    violations.push({
      gate: 'positive_host_causal_cpu_plus_fired_delay_p95_le_50ms',
      detail: { causalP95Ms: fixed(causalP95Ms) },
    });
  }
  return { wallMedianMs, wallP95Ms, causalP95Ms, violations };
}

function installCausalTimerProbe(): () => void {
  const originalSetTimeout = globalThis.setTimeout;
  const instrumentedSetTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const attribution = causalTimerAttribution.getStore();
    const wirePhase = modelWireTimerPhase.getStore() === true;
    const requestedDelayMs = Number.isFinite(delay) ? Math.max(0, Number(delay)) : 0;
    const wrapped = function instrumentedTimerCallback(this: unknown, ...callbackArgs: unknown[]) {
      if (attribution?.active && requestedDelayMs > 0) {
        if (wirePhase) attribution.wireFiredDelayMs += requestedDelayMs;
        else attribution.hostFiredDelayMs += requestedDelayMs;
      }
      callback.apply(this, callbackArgs);
    };
    return originalSetTimeout(wrapped, delay, ...args);
  }) as typeof globalThis.setTimeout;
  globalThis.setTimeout = instrumentedSetTimeout;
  return () => {
    if (globalThis.setTimeout === instrumentedSetTimeout) {
      globalThis.setTimeout = originalSetTimeout;
    }
  };
}

test('ordinary latency evaluator governs wall p95, retains causal work as an additional guard, and subtracts wire CPU', () => {
  const fast = (): OrdinaryLatencySample => ({ wallMs: 20, hostCpuMs: 10, hostFiredDelayMs: 0 });
  const splitTail = [
    ...Array.from({ length: 123 }, fast),
    ...Array.from({ length: 7 }, (): OrdinaryLatencySample => ({
      wallMs: 70,
      hostCpuMs: 30,
      hostFiredDelayMs: 30,
    })),
  ];
  const splitEvaluation = evaluateOrdinaryLatency(splitTail);
  assert.equal(splitEvaluation.wallP95Ms, 70);
  assert.equal(splitEvaluation.causalP95Ms, 60);
  assert.deepEqual(
    splitEvaluation.violations.map((entry) => entry.gate),
    [
      'positive_host_wall_p95_le_50ms',
      'positive_host_causal_cpu_plus_fired_delay_p95_le_50ms',
    ],
  );

  const schedulerOnlyTail = [
    ...Array.from({ length: 123 }, fast),
    ...Array.from({ length: 7 }, (): OrdinaryLatencySample => ({
      wallMs: 200,
      hostCpuMs: 10,
      hostFiredDelayMs: 0,
    })),
  ];
  const schedulerEvaluation = evaluateOrdinaryLatency(schedulerOnlyTail);
  assert.equal(schedulerEvaluation.wallP95Ms, 200);
  assert.equal(schedulerEvaluation.causalP95Ms, 10);
  assert.deepEqual(
    schedulerEvaluation.violations.map((entry) => entry.gate),
    ['positive_host_wall_p95_le_50ms'],
  );

  assert.equal(correctedHostCpuMs(35, 5), 30);
  assert.equal(correctedHostCpuMs(4, 5), 0);
});

test('causal timer probe counts only fired positive delays and keeps model-wire delay separate', async (t) => {
  const restoreCausalTimerProbe = installCausalTimerProbe();
  t.after(restoreCausalTimerProbe);
  const attribution: CausalTimerAttribution = {
    active: true,
    hostFiredDelayMs: 0,
    wireFiredDelayMs: 0,
  };
  try {
    await causalTimerAttribution.run(attribution, async () => {
      const cancelled = setTimeout(() => {
        assert.fail('cancelled timer must not fire');
      }, 25);
      clearTimeout(cancelled);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      await modelWireTimerPhase.run(true, () =>
        new Promise<void>((resolve) => setTimeout(resolve, 3)));
    });
  } finally {
    attribution.active = false;
  }
  assert.equal(attribution.hostFiredDelayMs, 2);
  assert.equal(attribution.wireFiredDelayMs, 3);
});

function responseFor(caseInfo: ConversationCase): string {
  return caseInfo.kind === 'conversation'
    ? `Conversation reply for ${caseInfo.id}.`
    : `Action surface retained for ${caseInfo.id}.`;
}

function sessionScopedCount(db: ReturnType<typeof eventlog.openEventLog>, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id LIKE ?`)
    .get(`${TRUE_SESSION_PREFIX}%`) as { n: number };
  return row.n;
}

after(async () => {
  embeddings._setEmbeddingProviderForTest(undefined);
  schemaCache._setToolSchemaLoaderForTests(null);
  schemaCache.resetToolSchemaCache();
  connectedCatalog.installConnectedRegistryPort(null);
  semanticPorts.installTurnSemanticModelPort(null);
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  productionAdapters.installProductionTransport(null);
  composioClient.__test__.setConnectedAccountsLoader(null);
  composioClient.__test__.setComposioApiKeyOverride(null);
  composioClient.resetComposioClient();
  bridge._setBridgeImplsForTests({});
  resetHarnessRuntimeConfig();
  eventlog.closeEventLog();
  globalThis.fetch = originalFetch;
  rmSync(HOME, { recursive: true, force: true });
});

test('130 ordinary chats and direct generations use one foreground request with zero action ceremony; adversarial social-prefix effects retain the full path', { timeout: 180_000 }, async (t) => {
  const conversations: ConversationCase[] = [
    ...GREETINGS.map((prompt, index) => ({ id: `greeting-${index + 1}`, prompt, kind: 'conversation' as const })),
    ...THANKS_AND_ACKS.map((prompt, index) => ({ id: `thanks-${index + 1}`, prompt, kind: 'conversation' as const })),
    ...CONVERSATIONAL_QUESTIONS.map((prompt, index) => ({ id: `question-${index + 1}`, prompt, kind: 'conversation' as const })),
    ...SIMPLE_EXPLANATIONS.map((prompt, index) => ({ id: `explanation-${index + 1}`, prompt, kind: 'conversation' as const })),
    ...DIRECT_GENERATION.map((prompt, index) => ({ id: `generation-${index + 1}`, prompt, kind: 'conversation' as const })),
  ];
  const negatives: ConversationCase[] = NEAR_ACTION_NEGATIVES.map((prompt, index) => ({
    id: `near-action-${index + 1}`,
    prompt,
    kind: 'near_action',
  }));
  assert.equal(conversations.length, 130);
  assert.equal(new Set(conversations.map((entry) => entry.prompt.toLowerCase())).size, conversations.length,
    'the positive cohort contains 130 distinct natural utterances');

  eventlog.resetEventLog();
  resetHarnessRuntimeConfig();
  const configured = await configureHarnessRuntime();
  assert.equal(configured.ok, true, configured.ok ? '' : configured.reason);

  const counters = blankCounters();
  const realFactory = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  assert.ok(realFactory, 'the production runtime installed its ordinary catalog factory');
  capabilityCatalogs.installHostCapabilityCatalogFactory({
    register(capability) { counters.catalogRegister += 1; realFactory.register(capability); },
    forget(capabilityId) { counters.catalogForget += 1; realFactory.forget(capabilityId); },
    clear() { counters.catalogClear += 1; realFactory.clear(); },
    snapshot() { counters.catalogSnapshot += 1; return realFactory.snapshot(); },
    get(capabilityId) { counters.catalogGet += 1; return realFactory.get(capabilityId); },
    catalog() { counters.catalogBuild += 1; return realFactory.catalog(); },
  });

  connectedCatalog.installConnectedRegistryPort(() => {
    counters.connectedRegistry += 1;
    return { connectedToolkits: [], tools: [] };
  });
  schemaCache.resetToolSchemaCache();
  schemaCache._setToolSchemaLoaderForTests(async () => {
    counters.schemaLoads += 1;
    return null;
  });
  embeddings._setEmbeddingProviderForTest({
    name: 'ordinary-conversation-counting-provider',
    model: 'ordinary-conversation-counting-model',
    dim: 4,
    async embed(texts: string[]) {
      counters.embeddingCalls += 1;
      counters.embeddingTexts += texts.length;
      return texts.map(() => new Float32Array(4));
    },
  } as never);
  productionAdapters.installProductionTransport(async () => {
    counters.providerCrossings += 1;
    throw new Error('ordinary conversation must never cross a business provider');
  });
  composioClient.__test__.setComposioApiKeyOverride('fixture-composio-key');
  composioClient.__test__.setConnectedAccountsLoader(async () => []);
  composioClient.__test__.setComposioClient({
    client: { baseURL: 'https://backend.composio.dev' },
    tools: {
      async getRawComposioTools() {
        counters.composioListings += 1;
        return [];
      },
      async execute() {
        counters.composioExecutions += 1;
        throw new Error('ordinary conversation must never execute a Composio tool');
      },
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    counters.networkFetches += 1;
    throw new Error(`ordinary conversation forbids external network: ${String(input)}`);
  }) as typeof fetch;
  semanticPorts.installTurnSemanticModelPort({
    async interpret() {
      counters.semanticInterpret += 1;
      throw new Error('ordinary conversation must not invoke a hidden semantic model');
    },
    async judgeSourceEffect() {
      counters.semanticEffectJudge += 1;
      throw new Error('ordinary conversation must not invoke a hidden effect judge');
    },
    async judgePlanGrounding() {
      counters.semanticGroundingJudge += 1;
      throw new Error('ordinary conversation must not invoke a hidden grounding judge');
    },
  });

  let activeCase: ConversationCase | null = null;
  let activeHostTiming: ActiveHostTiming | null = null;
  const markActiveHostPhase = (): HostPhaseMark | undefined => {
    if (!activeHostTiming) return undefined;
    const cpu = process.cpuUsage(activeHostTiming.cpuStarted);
    return {
      wallMs: Math.max(0, performance.now() - activeHostTiming.wallStartedAt),
      cpuMs: (cpu.user + cpu.system) / 1_000,
    };
  };
  const modelRequests: RecordedModelRequest[] = [];
  const buildRecords: BuildRecord[] = [];
  const scriptedModel = {
    async getResponse(rawRequest: unknown) {
      return modelWireTimerPhase.run(true, async () => {
        assert.ok(activeCase, 'a primary request is bound to the active accepted-channel case');
        const wireEnteredAt = performance.now();
        const preWireCpu = activeHostTiming
          ? process.cpuUsage(activeHostTiming.cpuStarted)
          : { user: 0, system: 0 };
        const startedAt = performance.now();
        const cpuStarted = process.cpuUsage();
        const request = (rawRequest ?? {}) as { tools?: Array<{ name?: string }> };
        const tools = Array.isArray(request.tools) ? request.tools : [];
        const toolNames = tools.map((entry) => entry?.name ?? '').filter(Boolean);
        const advertisedToolSchemaBytes = tools.reduce(
          (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry), 'utf8'),
          0,
        );
        const reply = responseFor(activeCase);
        const response = {
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
          output: [textMessage(JSON.stringify({
            summary: reply,
            reply,
            done: true,
            nextAction: 'completed',
            reason: null,
          }))],
          responseId: `primary-${activeCase.id}`,
        };
        const wireCpu = process.cpuUsage(cpuStarted);
        modelRequests.push({
          caseId: activeCase.id,
          toolNames,
          advertisedToolSchemaBytes,
          preWireWallMs: activeHostTiming
            ? Math.max(0, wireEnteredAt - activeHostTiming.wallStartedAt)
            : 0,
          preWireCpuMs: (preWireCpu.user + preWireCpu.system) / 1_000,
          wireMs: performance.now() - startedAt,
          wireCpuMs: (wireCpu.user + wireCpu.system) / 1_000,
        });
        return response;
      });
    },
    getStreamedResponse: streamResponse,
  };

  bridge._setBridgeImplsForTests({
    buildAgent: async (options) => {
      assert.ok(activeCase, 'agent construction is bound to the active accepted-channel case');
      if (activeHostTiming) activeHostTiming.buildStarted = markActiveHostPhase();
      buildRecords.push({
        caseId: activeCase.id,
        hostPlainConversation: options.hostPlainConversation === true,
        hostFreshPlanning: options.hostFreshPlanning !== undefined,
      });
      const agent = await buildOrchestratorAgent({
        ...options,
        model: scriptedModel as never,
      });
      if (activeHostTiming) activeHostTiming.buildCompleted = markActiveHostPhase();
      return agent;
    },
  });

  const hostOverheads: Array<{
    caseId: string;
    ms: number;
    hostCpuMs: number;
    preWireWallMs: number;
    preWireCpuMs: number;
    channelAcceptWallMs: number;
    channelAcceptCpuMs: number;
    acceptedRouteWallMs: number;
    acceptedRouteCpuMs: number;
    agentBuildWallMs: number;
    agentBuildCpuMs: number;
    turnPreparationWallMs: number;
    turnPreparationCpuMs: number;
    postWireWallMs: number;
    postWireCpuMs: number;
    hostFiredDelayMs: number;
    wireFiredDelayMs: number;
    wallMinusCpuMs: number;
    voluntaryContextSwitches: number;
    involuntaryContextSwitches: number;
  }> = [];
  const restoreCausalTimerProbe = installCausalTimerProbe();
  t.after(restoreCausalTimerProbe);
  for (const [index, caseInfo] of conversations.entries()) {
    activeCase = caseInfo;
    const sessionId = `${TRUE_SESSION_PREFIX}${index + 1}`;
    const session = eventlog.createSession({
      id: sessionId,
      kind: 'chat',
      userId: `ordinary-user-${index + 1}`,
    });
    const delivery = recordingTransport();
    let acceptedSource: { seq: number; turn: number } | null = null;
    const modelStartIndex = modelRequests.length;
    const cpuStarted = process.cpuUsage();
    const usageStarted = process.resourceUsage();
    const startedAt = performance.now();
    const timerAttribution: CausalTimerAttribution = {
      active: true,
      hostFiredDelayMs: 0,
      wireFiredDelayMs: 0,
    };
    const caseHostTiming: ActiveHostTiming = { wallStartedAt: startedAt, cpuStarted };
    activeHostTiming = caseHostTiming;
    try {
      await causalTimerAttribution.run(timerAttribution, () =>
        discord.runDiscordHarnessConversation({
          prompt: caseInfo.prompt,
          rawPrompt: caseInfo.prompt,
          channelId: `ordinary-channel-${index + 1}`,
          userId: `ordinary-user-${index + 1}`,
          guildId: 'ordinary-competitive-guild',
          transport: delivery.transport,
          durableRequest: {
            sessionId: session.id,
            runId: `ordinary-request-${index + 1}`,
            onSourceAccepted(source: { seq: number; turn: number }) {
              acceptedSource = { seq: source.seq, turn: source.turn };
              if (activeHostTiming) activeHostTiming.accepted = markActiveHostPhase();
            },
          },
        }));
    } finally {
      timerAttribution.active = false;
      activeHostTiming = null;
    }
    const elapsedMs = performance.now() - startedAt;
    const cpuElapsed = process.cpuUsage(cpuStarted);
    const usageElapsed = process.resourceUsage();
    const requests = modelRequests.slice(modelStartIndex);
    assert.equal(requests.length, 1, `${caseInfo.id} has exactly one primary model request`);
    assert.equal(requests[0]!.caseId, caseInfo.id);
    const hostMs = Math.max(0, elapsedMs - requests[0]!.wireMs);
    const totalCpuMs = (cpuElapsed.user + cpuElapsed.system) / 1_000;
    const hostCpuMs = correctedHostCpuMs(totalCpuMs, requests[0]!.wireCpuMs);
    const preWireWallMs = Math.min(hostMs, requests[0]!.preWireWallMs);
    const preWireCpuMs = Math.min(hostCpuMs, requests[0]!.preWireCpuMs);
    const acceptedMark = caseHostTiming.accepted;
    const buildStartedMark = caseHostTiming.buildStarted;
    const buildCompletedMark = caseHostTiming.buildCompleted;
    assert.ok(acceptedMark, `${caseInfo.id} records the accepted-channel phase boundary`);
    assert.ok(buildStartedMark, `${caseInfo.id} records the accepted-source routing boundary`);
    assert.ok(buildCompletedMark, `${caseInfo.id} records the agent-build phase boundary`);
    hostOverheads.push({
      caseId: caseInfo.id,
      ms: hostMs,
      hostCpuMs,
      preWireWallMs,
      preWireCpuMs,
      channelAcceptWallMs: acceptedMark.wallMs,
      channelAcceptCpuMs: acceptedMark.cpuMs,
      acceptedRouteWallMs: Math.max(0, buildStartedMark.wallMs - acceptedMark.wallMs),
      acceptedRouteCpuMs: Math.max(0, buildStartedMark.cpuMs - acceptedMark.cpuMs),
      agentBuildWallMs: Math.max(0, buildCompletedMark.wallMs - buildStartedMark.wallMs),
      agentBuildCpuMs: Math.max(0, buildCompletedMark.cpuMs - buildStartedMark.cpuMs),
      turnPreparationWallMs: Math.max(0, preWireWallMs - buildCompletedMark.wallMs),
      turnPreparationCpuMs: Math.max(0, preWireCpuMs - buildCompletedMark.cpuMs),
      postWireWallMs: Math.max(0, hostMs - preWireWallMs),
      postWireCpuMs: Math.max(0, hostCpuMs - preWireCpuMs),
      hostFiredDelayMs: timerAttribution.hostFiredDelayMs,
      wireFiredDelayMs: timerAttribution.wireFiredDelayMs,
      wallMinusCpuMs: Math.max(0, hostMs - hostCpuMs),
      voluntaryContextSwitches:
        usageElapsed.voluntaryContextSwitches - usageStarted.voluntaryContextSwitches,
      involuntaryContextSwitches:
        usageElapsed.involuntaryContextSwitches - usageStarted.involuntaryContextSwitches,
    });

    assert.ok(acceptedSource, `${caseInfo.id} has one durable accepted source`);
    const events = eventlog.listEvents(session.id);
    const terminals = events.filter((event) =>
      event.type === 'conversation_completed'
      && event.data.sourceUserSeq === acceptedSource!.seq);
    assert.equal(terminals.length, 1, `${caseInfo.id} has exactly one public terminal`);
    const stops = events.filter((event) => [
      'awaiting_user_input',
      'approval_requested',
      'approval_required',
      'request_approval',
      'conversation_interrupted',
    ].includes(event.type));
    assert.deepEqual(stops, [], `${caseInfo.id} has no user stop`);
    assert.equal(events.some((event) => event.type === 'turn_graph_compiled'), false,
      `${caseInfo.id} creates no graph`);
    const contextPackets = events.filter((event) => event.type === 'agent_context_packet');
    assert.equal(contextPackets.length, 1, `${caseInfo.id} builds one context packet`);
    assert.equal(
      contextPackets[0]!.data.semanticEnrichmentSkippedReason,
      'plain_conversation_surface',
      `${caseInfo.id} carries the accepted no-effect proof into context assembly`,
    );
    assert.deepEqual(contextPackets[0]!.data.skills, [], `${caseInfo.id} skips skill ranking`);
    assert.deepEqual(contextPackets[0]!.data.workflows, [], `${caseInfo.id} skips workflow ranking`);
    assert.equal(
      (contextPackets[0]!.data.toolScope as { authority?: unknown } | undefined)?.authority,
      'none',
      `${caseInfo.id} records an exact zero-tool context boundary`,
    );
    assert.equal(delivery.errors.length, 0, `${caseInfo.id} has no channel error`);
    assert.equal(delivery.followups.length, 0, `${caseInfo.id} fits one final Discord edit`);
    assert.equal(delivery.edits.at(-1), responseFor(caseInfo));
  }
  activeCase = null;

  const sorted = hostOverheads.map((entry) => entry.ms).sort((left, right) => left - right);
  const overhead = {
    samples: sorted.length,
    minMs: fixed(sorted[0]!),
    medianMs: fixed(percentile(sorted, 0.50)),
    p95Ms: fixed(percentile(sorted, 0.95)),
    p99Ms: fixed(percentile(sorted, 0.99)),
    maxMs: fixed(sorted.at(-1)!),
    meanMs: fixed(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
  const generationSorted = hostOverheads
    .filter((entry) => entry.caseId.startsWith('generation-'))
    .map((entry) => entry.ms)
    .sort((left, right) => left - right);
  t.diagnostic(`ordinary host overhead (immediate recording model): ${JSON.stringify({
    ...overhead,
    directGenerationMedianMs: fixed(percentile(generationSorted, 0.50)),
    directGenerationP95Ms: fixed(percentile(generationSorted, 0.95)),
  })}`);
  const cohortPrefix = (caseId: string): string => caseId.split('-', 1)[0] ?? caseId;
  const cohortTiming = Object.fromEntries(
    [...new Set(hostOverheads.map((entry) => cohortPrefix(entry.caseId)))].map((cohort) => {
      const entries = hostOverheads.filter((entry) => cohortPrefix(entry.caseId) === cohort);
      const wall = entries.map((entry) => entry.ms).sort((left, right) => left - right);
      const cpu = entries.map((entry) => entry.hostCpuMs).sort((left, right) => left - right);
      const firedDelay = entries
        .map((entry) => entry.hostFiredDelayMs)
        .sort((left, right) => left - right);
      const causal = entries
        .map((entry) => entry.hostCpuMs + entry.hostFiredDelayMs)
        .sort((left, right) => left - right);
      const wait = entries.map((entry) => entry.wallMinusCpuMs).sort((left, right) => left - right);
      return [cohort, {
        samples: entries.length,
        wallMedianMs: fixed(percentile(wall, 0.50)),
        wallP95Ms: fixed(percentile(wall, 0.95)),
        hostCpuMedianMs: fixed(percentile(cpu, 0.50)),
        hostCpuP95Ms: fixed(percentile(cpu, 0.95)),
        hostFiredDelayP95Ms: fixed(percentile(firedDelay, 0.95)),
        hostCausalP95Ms: fixed(percentile(causal, 0.95)),
        observedWallMinusHostCpuMedianMs: fixed(percentile(wait, 0.50)),
        observedWallMinusHostCpuP95Ms: fixed(percentile(wait, 0.95)),
      }];
    }),
  );
  const slowest = [...hostOverheads]
    .sort((left, right) => right.ms - left.ms)
    .slice(0, 12)
    .map((entry) => ({
      ...entry,
      ms: fixed(entry.ms),
      hostCpuMs: fixed(entry.hostCpuMs),
      hostFiredDelayMs: fixed(entry.hostFiredDelayMs),
      wireFiredDelayMs: fixed(entry.wireFiredDelayMs),
      wallMinusCpuMs: fixed(entry.wallMinusCpuMs),
    }));
  const cpuSorted = hostOverheads
    .map((entry) => entry.hostCpuMs)
    .sort((left, right) => left - right);
  const firedDelaySorted = hostOverheads
    .map((entry) => entry.hostFiredDelayMs)
    .sort((left, right) => left - right);
  const causalSorted = hostOverheads
    .map((entry) => entry.hostCpuMs + entry.hostFiredDelayMs)
    .sort((left, right) => left - right);
  const preWireWallSorted = hostOverheads
    .map((entry) => entry.preWireWallMs)
    .sort((left, right) => left - right);
  const preWireCpuSorted = hostOverheads
    .map((entry) => entry.preWireCpuMs)
    .sort((left, right) => left - right);
  const postWireWallSorted = hostOverheads
    .map((entry) => entry.postWireWallMs)
    .sort((left, right) => left - right);
  const postWireCpuSorted = hostOverheads
    .map((entry) => entry.postWireCpuMs)
    .sort((left, right) => left - right);
  const phaseDistribution = (field: keyof typeof hostOverheads[number]) => {
    const values = hostOverheads
      .map((entry) => entry[field])
      .filter((value): value is number => typeof value === 'number')
      .sort((left, right) => left - right);
    return {
      medianMs: fixed(percentile(values, 0.50)),
      p95Ms: fixed(percentile(values, 0.95)),
    };
  };
  const wallMinusCpuSorted = hostOverheads
    .map((entry) => entry.wallMinusCpuMs)
    .sort((left, right) => left - right);
  const involuntarySorted = hostOverheads
    .map((entry) => entry.involuntaryContextSwitches)
    .sort((left, right) => left - right);
  const latencyEvaluation = evaluateOrdinaryLatency(hostOverheads.map((entry) => ({
    wallMs: entry.ms,
    hostCpuMs: entry.hostCpuMs,
    hostFiredDelayMs: entry.hostFiredDelayMs,
  })));
  const temporalWindows = Array.from(
    { length: Math.ceil(hostOverheads.length / 10) },
    (_, windowIndex) => {
      const entries = hostOverheads.slice(windowIndex * 10, (windowIndex + 1) * 10);
      const wall = entries.map((entry) => entry.ms).sort((left, right) => left - right);
      const cpu = entries.map((entry) => entry.hostCpuMs).sort((left, right) => left - right);
      const firedDelay = entries
        .map((entry) => entry.hostFiredDelayMs)
        .sort((left, right) => left - right);
      const causal = entries
        .map((entry) => entry.hostCpuMs + entry.hostFiredDelayMs)
        .sort((left, right) => left - right);
      const wait = entries.map((entry) => entry.wallMinusCpuMs).sort((left, right) => left - right);
      return {
        samples: `${windowIndex * 10 + 1}-${windowIndex * 10 + entries.length}`,
        wallP95Ms: fixed(percentile(wall, 0.95)),
        hostCpuP95Ms: fixed(percentile(cpu, 0.95)),
        hostFiredDelayP95Ms: fixed(percentile(firedDelay, 0.95)),
        hostCausalP95Ms: fixed(percentile(causal, 0.95)),
        observedWallMinusHostCpuP95Ms: fixed(percentile(wait, 0.95)),
      };
    },
  );
  t.diagnostic(`ordinary host timing cohorts: ${JSON.stringify(cohortTiming)}`);
  t.diagnostic(`ordinary host causal latency control: ${JSON.stringify({
    hostCpuMedianMs: fixed(percentile(cpuSorted, 0.50)),
    hostCpuP95Ms: fixed(percentile(cpuSorted, 0.95)),
    hostFiredDelayMedianMs: fixed(percentile(firedDelaySorted, 0.50)),
    hostFiredDelayP95Ms: fixed(percentile(firedDelaySorted, 0.95)),
    hostCausalMedianMs: fixed(percentile(causalSorted, 0.50)),
    hostCausalP95Ms: fixed(latencyEvaluation.causalP95Ms),
    observedWallMinusHostCpuMedianMs: fixed(percentile(wallMinusCpuSorted, 0.50)),
    observedWallMinusHostCpuP95Ms: fixed(percentile(wallMinusCpuSorted, 0.95)),
    involuntaryContextSwitchP95: percentile(involuntarySorted, 0.95),
    temporalWindows,
  })}`);
  t.diagnostic(`ordinary host pre/post wire attribution: ${JSON.stringify({
    preWireWallMedianMs: fixed(percentile(preWireWallSorted, 0.50)),
    preWireWallP95Ms: fixed(percentile(preWireWallSorted, 0.95)),
    preWireCpuMedianMs: fixed(percentile(preWireCpuSorted, 0.50)),
    preWireCpuP95Ms: fixed(percentile(preWireCpuSorted, 0.95)),
    postWireWallMedianMs: fixed(percentile(postWireWallSorted, 0.50)),
    postWireWallP95Ms: fixed(percentile(postWireWallSorted, 0.95)),
    postWireCpuMedianMs: fixed(percentile(postWireCpuSorted, 0.50)),
    postWireCpuP95Ms: fixed(percentile(postWireCpuSorted, 0.95)),
  })}`);
  t.diagnostic(`ordinary host pre-wire phase attribution: ${JSON.stringify({
    channelAcceptWall: phaseDistribution('channelAcceptWallMs'),
    channelAcceptCpu: phaseDistribution('channelAcceptCpuMs'),
    acceptedRouteWall: phaseDistribution('acceptedRouteWallMs'),
    acceptedRouteCpu: phaseDistribution('acceptedRouteCpuMs'),
    agentBuildWall: phaseDistribution('agentBuildWallMs'),
    agentBuildCpu: phaseDistribution('agentBuildCpuMs'),
    turnPreparationWall: phaseDistribution('turnPreparationWallMs'),
    turnPreparationCpu: phaseDistribution('turnPreparationCpuMs'),
  })}`);
  t.diagnostic(`ordinary host slowest samples: ${JSON.stringify(slowest)}`);
  // The written competitive contract governs observed host wall p95 at 50 ms.
  // Corrected process CPU plus the requested duration of positive-delay timers
  // remains an additional causal guard and attribution metric; it cannot
  // substitute for or excuse a wall-tail failure. The immediate model wire is
  // excluded from both host wall and causal attribution.
  const violations: Array<{ gate: string; detail: unknown }> = [
    ...latencyEvaluation.violations,
  ];

  const positiveSchemaLeaks = modelRequests.filter((request) =>
    request.toolNames.length > 0 || request.advertisedToolSchemaBytes !== 0);
  if (positiveSchemaLeaks.length > 0) {
    violations.push({ gate: 'positive_zero_advertised_tool_schema_bytes', detail: positiveSchemaLeaks });
  }
  const positiveBuilds = buildRecords.filter((entry) => entry.caseId.startsWith('greeting-')
    || entry.caseId.startsWith('thanks-')
    || entry.caseId.startsWith('question-')
    || entry.caseId.startsWith('explanation-')
    || entry.caseId.startsWith('generation-'));
  if (positiveBuilds.length !== conversations.length) {
    violations.push({
      gate: 'positive_one_agent_build_per_source',
      detail: { expected: conversations.length, actual: positiveBuilds.length },
    });
  }
  const positiveSurfaceOffenders = positiveBuilds.filter((entry) =>
    !entry.hostPlainConversation || entry.hostFreshPlanning);
  if (positiveSurfaceOffenders.length > 0) {
    violations.push({ gate: 'positive_conversation_only_surface', detail: positiveSurfaceOffenders });
  }
  if (modelRequests.length !== conversations.length) {
    violations.push({
      gate: 'positive_exactly_one_primary_request',
      detail: { expected: conversations.length, actual: modelRequests.length },
    });
  }

  const positiveCounters = { ...counters };
  if (Object.values(positiveCounters).some((count) => count !== 0)) {
    violations.push({ gate: 'positive_zero_hidden_or_external_calls', detail: positiveCounters });
  }

  const db = eventlog.openEventLog();
  const zeroSessionTables = [
    'accepted_task_resolutions',
    'accepted_task_operations',
    'accepted_task_authority',
    'accepted_task_work_contracts',
    'accepted_source_catalog_snapshots',
    'graph_node_bindings',
    'graph_journal_entries',
    'logical_tool_calls',
    'physical_dispatches',
    'logical_call_settlements',
    'expected_work_call_bindings',
    'expected_work_universe_amendments',
    'expected_work_source_lineage_identities',
    'expected_work_generated_artifact_contracts',
    'evidence_receipts',
    'discovery_governor_tasks',
  ] as const;
  const rowCounts = Object.fromEntries(
    zeroSessionTables.map((table) => [table, sessionScopedCount(db, table)]),
  );
  if (Object.values(rowCounts).some((count) => count !== 0)) {
    violations.push({ gate: 'positive_zero_graph_work_call_physical_settlement_rows', detail: rowCounts });
  }
  const graphNodeLeases = (db.prepare('SELECT COUNT(*) AS n FROM graph_node_leases').get() as { n: number }).n;
  if (graphNodeLeases !== 0) {
    violations.push({ gate: 'positive_zero_graph_node_leases', detail: { graphNodeLeases } });
  }
  const hostAuthorities = db.prepare(`
    SELECT COUNT(*) AS n,
           SUM(CASE WHEN graph_event_id IS NOT NULL OR graph_hash IS NOT NULL THEN 1 ELSE 0 END) AS graph_bound
      FROM accepted_turn_call_authorities
     WHERE session_id LIKE ?
  `).get(`${TRUE_SESSION_PREFIX}%`) as { n: number; graph_bound: number };
  if (hostAuthorities.n !== conversations.length || hostAuthorities.graph_bound !== 0) {
    violations.push({
      gate: 'positive_one_graph_neutral_accepted_turn_root',
      detail: { expected: conversations.length, ...hostAuthorities },
    });
  }

  const beforeNegatives = { ...counters };
  const negativeModelStart = modelRequests.length;
  const negativeBuildStart = buildRecords.length;
  for (const [index, caseInfo] of negatives.entries()) {
    activeCase = caseInfo;
    const session = eventlog.createSession({
      id: `discord-near-action-${index + 1}`,
      kind: 'chat',
      userId: `near-action-user-${index + 1}`,
    });
    const delivery = recordingTransport();
    await discord.runDiscordHarnessConversation({
      prompt: caseInfo.prompt,
      rawPrompt: caseInfo.prompt,
      channelId: `near-action-channel-${index + 1}`,
      userId: `near-action-user-${index + 1}`,
      guildId: 'ordinary-competitive-guild',
      transport: delivery.transport,
      durableRequest: {
        sessionId: session.id,
        runId: `near-action-request-${index + 1}`,
      },
    });
    const negativeContextPacket = eventlog.listEvents(session.id, {
      types: ['agent_context_packet'],
    }).at(-1);
    assert.ok(negativeContextPacket, `${caseInfo.id} builds an action context packet`);
    assert.equal(
      negativeContextPacket.data.semanticEnrichmentSkippedReason,
      null,
      `${caseInfo.id} cannot borrow the plain-conversation trim`,
    );
    if (delivery.errors.length > 0) {
      violations.push({ gate: 'negative_accepted_channel_completion', detail: { caseId: caseInfo.id, errors: delivery.errors } });
    }
  }
  activeCase = null;

  const negativeRequests = modelRequests.slice(negativeModelStart);
  const negativeBuilds = buildRecords.slice(negativeBuildStart);
  if (negativeRequests.length !== negatives.length) {
    violations.push({
      gate: 'negative_one_primary_request',
      detail: { expected: negatives.length, actual: negativeRequests.length },
    });
  }
  if (negativeBuilds.length !== negatives.length) {
    violations.push({
      gate: 'negative_one_agent_build_per_source',
      detail: { expected: negatives.length, actual: negativeBuilds.length },
    });
  }
  const negativeSurfaceOffenders = negativeBuilds.filter((entry) =>
    entry.hostPlainConversation || !entry.hostFreshPlanning);
  if (negativeSurfaceOffenders.length > 0) {
    violations.push({ gate: 'negative_full_action_surface', detail: negativeSurfaceOffenders });
  }
  // The cold action surface is search-first. plan_task becomes reachable only
  // after tool_search discloses an exact citable capability; advertising it on
  // this empty-catalog first frame would invite an unsealable draft.
  const negativePlanOffenders = negativeRequests.filter((request) => request.toolNames.includes('plan_task'));
  if (negativePlanOffenders.length > 0) {
    violations.push({ gate: 'negative_plan_task_hidden_until_discovery', detail: negativePlanOffenders });
  }
  const negativeSearchOffenders = negativeRequests.filter((request) => !request.toolNames.includes('tool_search'));
  if (negativeSearchOffenders.length > 0) {
    violations.push({ gate: 'negative_tool_search_reachable', detail: negativeSearchOffenders });
  }
  const negativeSchemaOffenders = negativeRequests.filter((request) =>
    request.advertisedToolSchemaBytes <= 0);
  if (negativeSchemaOffenders.length > 0) {
    violations.push({ gate: 'negative_schema_bearing_surface', detail: negativeSchemaOffenders });
  }
  const negativeCost = counterDelta(counters, beforeNegatives);
  const negativeDiscoveryTasks = (db.prepare(`
    SELECT COUNT(*) AS n
      FROM discovery_governor_tasks
     WHERE session_id LIKE 'discord-near-action-%'
  `).get() as { n: number }).n;
  if (negativeDiscoveryTasks < negatives.length) {
    violations.push({
      gate: 'negative_discovery_initialization_retained',
      detail: { expectedAtLeast: negatives.length, actual: negativeDiscoveryTasks },
    });
  }
  if (negativeCost.catalogSnapshot < negatives.length) {
    violations.push({ gate: 'negative_catalog_preparation_retained', detail: negativeCost });
  }
  if (negativeCost.embeddingCalls <= 0) {
    violations.push({ gate: 'negative_recall_preparation_retained', detail: negativeCost });
  }
  if (
    negativeCost.providerCrossings !== 0
    || negativeCost.composioExecutions !== 0
  ) {
    violations.push({ gate: 'negative_no_unrequested_provider_dispatch', detail: negativeCost });
  }
  if (
    negativeCost.semanticInterpret !== 0
    || negativeCost.semanticEffectJudge !== 0
    || negativeCost.semanticGroundingJudge !== 0
  ) {
    violations.push({ gate: 'negative_no_hidden_semantic_planner', detail: negativeCost });
  }
  t.diagnostic(`positive hidden/external counters: ${JSON.stringify(positiveCounters)}`);
  t.diagnostic(`positive graph/work/call/lease/physical/settlement rows: ${JSON.stringify({
    ...rowCounts,
    graph_node_leases: graphNodeLeases,
    graph_neutral_accepted_turn_roots: hostAuthorities.n,
    graph_bound_accepted_turn_roots: hostAuthorities.graph_bound,
  })}`);
  t.diagnostic(`near-action path counters: ${JSON.stringify(negativeCost)}`);
  t.diagnostic(`competitive gate violations: ${JSON.stringify(violations)}`);
  assert.deepEqual(violations, [], 'every ordinary-conversation competitive gate must pass');
});
