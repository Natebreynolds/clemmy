/**
 * A learned hint keeps the shape of the work, not the earlier request's
 * values, end to end through the production host turn.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/learned-hints-keep-shape.integration.test.ts
 *
 * A first request about one target discovers a provider operation, calls it
 * and succeeds; the host learns that run at its done terminal. A later request
 * of the same kind about another target is confirmed by Jev before binding. Everything the host then puts in front of the brain
 * before its first frame (the proven-operation guidance and the memory
 * context's proven-run hint) names the tool and the roles of its arguments,
 * and none of it carries the first request's target.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-hint-shape-'));
Object.assign(process.env, {
  CLEMENTINE_HOME: HOME,
  CLEMMY_TEST_ISOLATED_HOME: '1',
  MCP_AUTO_IMPORT_ENABLED: 'false',
  EMBEDDINGS_DISABLED: 'true',
  OPENAI_AGENTS_DISABLE_TRACING: '1',
  CLEMMY_COMPLETION_REVIEW: 'off',
  AUTH_MODE: 'codex_oauth',
  MODEL_ROUTING_MODE: 'off',
  CLEMMY_MODEL_ROLES: '[]',
  HARNESS_TOOL_BRACKETS: 'on',
  CLEMMY_TOOL_JIT: 'on',
  CLEMMY_CODEX_TOOL_SEARCH: 'on',
  CLEMMY_SEMANTIC_RECALL: 'off',
  CLEMMY_DEBATE_MODE: 'off',
  COMPOSIO_API_KEY: 'fixture-composio-key',
  COMPOSIO_USER_ID: 'fixture-user',
});
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-hint-shape\n');
writeFileSync(path.join(HOME, 'state', 'composio-catalog-cache.json'), JSON.stringify({
  at: Date.now(),
  data: [{ slug: 'sampleseo', name: 'Sample SEO', authMode: 'managed', description: 'Fixture search-metrics provider for tests.' }],
}));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('no network in the hint-shape fixture'); };

const eventlog = await import('./eventlog.js');
const { runConversation } = await import('./loop.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const composioClient = await import('../../integrations/composio/client.js');
const isolatedTransport = await import('./isolated-attested-transport.fixture.js');
const production = await import('./production-capability-adapters.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifests = await import('./capability-manifest-store.js');
const schemas = await import('../../tools/composio-schema-cache.js');
const semanticPorts = await import('../semantic-boundary/turn-semantic-port-registry.js');
const strategies = await import('../../memory/run-strategy-store.js');
const jev = await import('../jev/client.js');

const OPERATION = 'SAMPLESEO_GET_BACKLINKS_SUMMARY';
const REF_PATTERN = /cap:resolved:sampleseo_get_backlinks_summary(?::definition:[a-z0-9]+)?/;
const INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['target'],
  properties: { target: { type: 'string' }, include_subdomains: { type: 'boolean' } },
};
const OUTPUT_SCHEMA = { type: 'object', properties: { backlinks: { type: 'number' } } };
const FIRST_TARGET = 'first-firm.example';
const SECOND_TARGET = 'second-firm.example';

let transportCalls = 0;
const targetsSeen: string[] = [];
function providerAnswer(args: unknown): { backlinks: number; target: string } {
  transportCalls += 1;
  const target = String((args as { target?: unknown } | undefined)?.target ?? '');
  targetsSeen.push(target);
  return { backlinks: 1_200 + transportCalls, target };
}

catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
isolatedTransport.installIsolatedAttestedTransport(async (call: unknown) => providerAnswer((call as { arguments?: unknown; args?: unknown }).arguments ?? (call as { args?: unknown }).args));
schemas._setToolSchemaLoaderForTests(async (identifier: string) => (
  identifier === OPERATION
    ? { inputParameters: INPUT_SCHEMA, outputParameters: OUTPUT_SCHEMA, providerObservedAt: Date.now(), providerOperationVersion: '20260926_01' }
    : null
));
composioClient.__test__.setComposioApiKeyOverride('fixture-composio-key');
composioClient.__test__.setConnectedAccountsLoader(async () => [
  { id: 'conn-sampleseo', status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'sampleseo' } },
]);
composioClient.__test__.setComposioClient({
  client: { baseURL: 'https://backend.composio.dev' },
  getClient: () => ({
    withOptions: () => ({
      tools: {
        execute: async (_slug: string, input: { arguments?: unknown }) => ({ data: providerAnswer(input?.arguments), error: null, successful: true, log_id: `fixture-${transportCalls}` }),
      },
    }),
  }),
  tools: {
    async getRawComposioTools(input: { tools?: string[] }) {
      const exact = new Set((input.tools ?? []).map((value) => value.toUpperCase()));
      const rows = [{
        slug: OPERATION,
        name: 'Backlinks summary',
        description: 'Count the backlinks and referring domains pointing at a target domain.',
        toolkit: { slug: 'sampleseo' },
        inputParameters: INPUT_SCHEMA,
        outputParameters: OUTPUT_SCHEMA,
        version: 'fixture-sampleseo-v1',
      }];
      return rows.filter((row) => exact.size === 0 || exact.has(row.slug));
    },
    async execute(_slug: string, input: { arguments?: unknown }) {
      return { data: providerAnswer(input?.arguments), error: null, successful: true };
    },
  },
} as never);
semanticPorts.installTurnSemanticModelPort({
  async interpret() { throw new Error('no hidden work plan in this fixture'); },
  async judgeAccountSelection(call) {
    return { verdict: call.mode === 'current_source_default' ? 'default_compatible' : 'entailed', proposalDigest: call.proposalDigest, modelIdentity: 'fixture-account-judge' };
  },
} as never);

jev._setTypesafeKeyForTests('ts_fixture');
jev._setSystemOneFetchForTests(async (_url, init) => {
  const body = JSON.parse(String(init.body)) as { questions: Record<string, { type: string; instructions?: string; criteria?: Record<string, unknown> }> };
  const ids = Object.keys(body.questions);
  if (!ids.some((id) => id.startsWith('run_') || id === 'select')) {
    return { status: 503, ok: false, text: async () => '' };
  }
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(body.questions)) {
    if (question.type === 'choice') {
      const hit = Object.entries(question.criteria ?? {})
        .find(([key, text]) => key !== 'none' && /sampleseo_get_backlinks_summary/i.test(String(text)));
      const choice = hit ? hit[0] : 'none';
      const confidence = hit ? 0.45 : 0.9;
      answers[id] = { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } };
    } else {
      answers[id] = { type: 'noul', noul: /sampleseo_get_backlinks_summary/i.test(question.instructions ?? '') ? 0.93 : 0.04 };
    }
  }
  return {
    status: 200,
    ok: true,
    text: async () => JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 60, output_tokens: 6 } }),
  };
});

after(() => {
  jev._setSystemOneFetchForTests(undefined);
  jev._setTypesafeKeyForTests(undefined);
  semanticPorts.installTurnSemanticModelPort(null);
  schemas._setToolSchemaLoaderForTests(null);
  schemas.resetToolSchemaCache();
  production.installProductionTransport(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifests.installCapabilityManifestStore(null);
  composioClient.__test__.setComposioClient(null);
  composioClient.__test__.setConnectedAccountsLoader(null);
  composioClient.__test__.setComposioApiKeyOverride(null);
  composioClient.resetComposioClient();
  eventlog.closeEventLog();
  globalThis.fetch = originalFetch;
  rmSync(HOME, { recursive: true, force: true });
});

type Frame = { tools: string[]; text: string };

function functionCall(callId: string, name: string, args: Record<string, unknown>) {
  return { type: 'function_call', callId, name, arguments: JSON.stringify(args) };
}
function assistantText(text: string) {
  return { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] };
}
function workCall(callId: string, ref: string, target: string) {
  return functionCall(callId, 'work_call', {
    requirement_id: ref,
    name: 'composio_execute_tool',
    args_json: JSON.stringify({ tool_slug: OPERATION, arguments: { target, include_subdomains: true } }),
    universe_item_id: null, universe_selector: null, seal_amendment: null, source_call_ids: null, source_record_ids: null,
  });
}

/** A brain that follows the host's disclosure: it calls the operation directly
 *  only when the request carries a callable ref for it; otherwise it searches. */
function disclosureFollowingBrain(label: string, target: string) {
  const frames: Frame[] = [];
  let step = 0;
  const resultText = (input: unknown[], callId: string): string => {
    const row = input.find((item) => (item as { type?: string; callId?: string }).type === 'function_call_result'
      && (item as { callId?: string }).callId === callId) as { output?: unknown } | undefined;
    return row ? JSON.stringify(row.output) : '';
  };
  const model = {
    frames,
    async getResponse(rawRequest: unknown) {
      const request = rawRequest as { input?: unknown[]; tools?: Array<{ name?: string }> };
      const input = Array.isArray(request.input) ? request.input : [];
      const text = JSON.stringify({ ...request, tools: undefined });
      frames.push({ tools: (request.tools ?? []).map((tool) => tool.name ?? ''), text });
      step += 1;
      const called = (callId: string) => input.some((item) => (item as { callId?: string }).callId === callId);
      let output: unknown[];
      if (!called(`${label}-direct`) && !called(`${label}-search`)) {
        const disclosed = /skip tool_search/.test(text) ? REF_PATTERN.exec(text)?.[0] : undefined;
        output = disclosed
          ? [workCall(`${label}-direct`, disclosed, target)]
          : [functionCall(`${label}-search`, 'tool_search', {
              query: 'count the backlinks pointing at a target domain', account_selection: null, role_key: null, limit: 5, cursor: null,
            })];
      } else if (called(`${label}-search`) && !called(`${label}-after-search`)) {
        const ref = REF_PATTERN.exec(resultText(input, `${label}-search`))?.[0];
        output = ref ? [workCall(`${label}-after-search`, ref, target)] : [assistantText('I could not reach that operation.')];
      } else {
        output = [assistantText(`Done (${label}): the backlink count for ${target} is in the result above.`)];
      }
      return {
        responseId: `${label}-${step}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output,
      };
    },
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
  return model;
}

async function hostTurn(label: string, text: string, target: string) {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: label });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `hint-${label}:${session.id}` });
  const accepted = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
    text, taskMode: { version: 1, kind: 'normal' },
  } }, { armRunInFlight: true });
  const identity = { sessionId: session.id, sourceUserSeq: accepted.seq };
  const brain = disclosureFollowingBrain(label, target);
  const result = await runConversation({ ...identity, input: text, reuseRecordedUserInput: true,
    runAttemptId: attempt.attemptId, turnEngine: 'host_v1', maxSteps: 1, maxTurns: 6, toolCallsPerTurn: 8, judgeCompletion: false,
    buildAgent: async (context) => buildOrchestratorAgent({ sessionId: context.sessionId,
      sourceUserSeq: context.sourceUserSeq, hostFreshPlanning: context.hostFreshPlanning, userInput: text, allowToolJit: true,
      model: brain as never }),
    makeRunner: () => Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute'); } }) as never,
  });
  const trace = eventlog.listEvents(session.id);
  const toolCalls = trace.filter((event) => event.type === 'tool_called').map((event) => String(event.data.tool));
  const selected = trace.filter((event) => event.type === 'proven_operation_selected').at(-1)?.data as Record<string, unknown> | undefined;
  return { identity, result, trace, toolCalls, selected, frames: brain.frames };
}

function debug(run: Awaited<ReturnType<typeof hostTurn>>): string {
  return JSON.stringify({
    status: run.result.status,
    error: (run.result as { error?: unknown }).error,
    toolCalls: run.toolCalls,
    selected: run.selected,
    frames: run.frames.map((frame) => frame.tools.length),
    events: run.trace.map((event) => event.type).slice(-30),
  }).slice(0, 6_000);
}

/** Every host-authored hint about past runs that reached the brain's first frame. */
function hintText(frame: Frame | undefined): string {
  const text = frame?.text ?? '';
  const blocks: string[] = [];
  for (const marker of ['[PROVEN OPERATION', '[ROUTED OPERATION', 'Proven Run Strategies']) {
    let at = text.indexOf(marker);
    while (at >= 0) {
      blocks.push(text.slice(at, at + 2_400));
      at = text.indexOf(marker, at + 1);
    }
  }
  return blocks.join('\n');
}

test('the first request about one target discovers, calls and teaches the run, with the argument roles recorded and the target elided', async () => {
  const first = await hostTurn('first', `how many backlinks does https://${FIRST_TARGET} have?`, FIRST_TARGET);
  assert.equal(first.result.status, 'completed', debug(first));
  assert.deepEqual(first.toolCalls.filter((name) => name === 'tool_search'), ['tool_search'], debug(first));
  assert.deepEqual(targetsSeen, [FIRST_TARGET]);
  const learned = first.trace.find((event) => event.type === 'run_strategy_learned');
  assert.ok(learned, `a verified done turn teaches its run: ${debug(first)}`);
  const record = strategies.listVerifiedRunStrategies().find((row) => row.toolsUsed.some((name) => name.toUpperCase() === OPERATION));
  assert.ok(record, JSON.stringify(strategies.listVerifiedRunStrategies()));
  assert.ok(record.provenShapes?.length, 'the settled call\'s shape is recorded with the run');
  assert.match(record.provenShapes![0]!.shape, /"target":"string"/);
  assert.doesNotMatch(JSON.stringify(record.provenShapes), new RegExp(FIRST_TARGET.replace('.', '\\.')), 'the shape holds roles, not the target');
});

test('a later request of the same kind about another target receives a hint that names the tool and its argument roles and none of the first request\'s values', async () => {
  const request = `how many backlinks does https://${SECOND_TARGET} have?`;
  // The memory-context hint for this request, as the host renders it.
  const memoryHint = strategies.renderRunStrategiesForContext(request);
  assert.match(memoryHint, /Prior verified run \(candidate only; confirm it fits this request\) used: /, memoryHint);
  assert.match(memoryHint, /sampleseo_get_backlinks_summary \(tool_slug=SAMPLESEO_GET_BACKLINKS_SUMMARY, arguments\.target, arguments\.include_subdomains\)/i, memoryHint);
  assert.match(memoryHint, /Use this request's own targets and values/);
  assert.doesNotMatch(memoryHint, new RegExp(`${FIRST_TARGET.replace('.', '\\.')}|first-firm|similar past run`), memoryHint);

  const second = await hostTurn('second', request, SECOND_TARGET);
  assert.equal(second.result.status, 'completed', debug(second));
  assert.equal(second.selected?.pickedBy, 'jev', `Jev confirms the new target before the remembered operation binds: ${debug(second)}`);
  assert.equal(second.selected?.skipDiscoverySearch, true, debug(second));
  assert.deepEqual(second.toolCalls.filter((name) => name === 'tool_search'), [], `zero tool_search: ${debug(second)}`);
  assert.deepEqual(targetsSeen, [FIRST_TARGET, SECOND_TARGET], 'the bound operation ran once, on this request\'s own target');

  const hints = hintText(second.frames[0]);
  assert.match(hints, /\[PROVEN OPERATION — skip tool_search\]/, `the host disclosed the proven operation before the first frame: ${debug(second)}`);
  assert.match(hints, /already proved these tools: sampleseo_get_backlinks_summary/i, hints);
  assert.match(hints, /Use this request's own targets and values/, hints);
  assert.match(hints, /Request shapes that succeeded in the proven run/, hints);
  // The frame is captured as JSON, so quotes inside it are escaped.
  assert.match(hints, /target\\*":\\*"string/, 'the argument roles reach the brain');
  assert.match(hints, /arguments\.target, arguments\.include_subdomains/, 'the memory-context hint names the roles');
  assert.doesNotMatch(hints, new RegExp(`${FIRST_TARGET.replace('.', '\\.')}|first-firm`), `the first request's target never reaches the brain as a hint:\n${hints}`);
  assert.doesNotMatch(hints, /A prior successful run \("|similar past run/, hints);
  // The first request's target appears nowhere in what the brain received on this turn.
  assert.doesNotMatch(second.frames[0]?.text ?? '', new RegExp(FIRST_TARGET.replace('.', '\\.')), 'no host-authored text on this turn carries the earlier target');
});
