/**
 * Familiar work skips the search, end to end through the production host turn.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/familiar-work-binds-directly.integration.test.ts
 *
 * A first request discovers a provider operation with tool_search, calls it,
 * and succeeds; the host learns that run at its done terminal. A later request
 * of the same kind, worded differently and about another target, is judged
 * familiar at the turn start (Jev double), and the host binds the learned
 * operation before the first model frame. The test brain behaves like a model
 * that follows the host's disclosure: it calls an operation directly only when
 * the request it receives carries a callable ref for it, and otherwise
 * searches. So "zero tool_search" here is the host's doing, not the script's.
 * When the binding cannot be made (the connection is gone) or the bound call
 * fails, search runs on the same, unchanged tool surface.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-familiar-direct-'));
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
  CLEMMY_UNIFIED_RECALL: 'off',
  CLEMMY_UNIFIED_TURN_PRIMER: 'off',
  CLEMMY_SEMANTIC_RECALL: 'off',
  CLEMMY_DEBATE_MODE: 'off',
  COMPOSIO_API_KEY: 'fixture-composio-key',
  COMPOSIO_USER_ID: 'fixture-user',
});
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-familiar-direct\n');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('no network in the familiar-work fixture'); };

const eventlog = await import('./eventlog.js');
const { runConversation } = await import('./loop.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const composioClient = await import('../../integrations/composio/client.js');
const isolatedTransport = await import('./isolated-attested-transport.fixture.js');
const production = await import('./production-capability-adapters.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifests = await import('./capability-manifest-store.js');
const schemas = await import('../../tools/composio-schema-cache.js');
const jev = await import('../jev/client.js');
const semanticPorts = await import('../semantic-boundary/turn-semantic-port-registry.js');
const strategies = await import('../../memory/run-strategy-store.js');

const OPERATION = 'GOOGLEDRIVE_FIND_FILE';
const REF_PATTERN = /cap:resolved:googledrive_find_file(?::definition:[a-z0-9]+)?/;
const INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: { query: { type: 'string' } },
};
const OUTPUT_SCHEMA = { type: 'object', properties: { files: { type: 'array' } } };

let connectionLive = true;
let failNextTransportCall = false;
let transportCalls = 0;

catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
/** Every provider crossing, whichever execution seam carries it. */
function providerAnswer(): { files: Array<{ id: string; name: string }> } {
  transportCalls += 1;
  if (failNextTransportCall) {
    failNextTransportCall = false;
    throw new Error('provider unavailable (fixture)');
  }
  return { files: [{ id: `fixture-file-${transportCalls}`, name: 'Matching file' }] };
}
isolatedTransport.installIsolatedAttestedTransport(async () => providerAnswer());
schemas._setToolSchemaLoaderForTests(async (identifier: string) => (
  identifier === OPERATION
    ? { inputParameters: INPUT_SCHEMA, outputParameters: OUTPUT_SCHEMA, providerObservedAt: Date.now(), providerOperationVersion: '20260926_01' }
    : null
));
composioClient.__test__.setComposioApiKeyOverride('fixture-composio-key');
const connectionsLoader = async () => (connectionLive
  ? [{ id: 'conn-googledrive', status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'googledrive' } }]
  : []);
composioClient.__test__.setConnectedAccountsLoader(connectionsLoader);
/** The host observes the owner's connections as they are now. */
async function observeConnections(): Promise<void> {
  composioClient.__test__.setConnectedAccountsLoader(connectionsLoader);
  await composioClient.listUsableConnectedToolkits({ requireFresh: true });
}
composioClient.__test__.setComposioClient({
  client: { baseURL: 'https://backend.composio.dev' },
  getClient: () => ({
    withOptions: () => ({
      tools: {
        execute: async () => ({ data: providerAnswer(), error: null, successful: true, log_id: `fixture-${transportCalls}` }),
      },
    }),
  }),
  tools: {
    async getRawComposioTools(input: { tools?: string[] }) {
      const exact = new Set((input.tools ?? []).map((value) => value.toUpperCase()));
      const rows = [{
        slug: OPERATION,
        name: 'Find file in Google Drive',
        description: 'Find files by name in the connected Google Drive.',
        toolkit: { slug: 'googledrive' },
        inputParameters: INPUT_SCHEMA,
        outputParameters: OUTPUT_SCHEMA,
        version: 'fixture-googledrive-v1',
      }];
      return rows.filter((row) => exact.size === 0 || exact.has(row.slug));
    },
    async execute() {
      return { data: providerAnswer(), error: null, successful: true };
    },
  },
} as never);
semanticPorts.installTurnSemanticModelPort({
  async interpret() { throw new Error('no hidden work plan in this fixture'); },
  async judgeAccountSelection(call) {
    return {
      verdict: call.mode === 'current_source_default' ? 'default_compatible' : 'entailed',
      proposalDigest: call.proposalDigest,
      modelIdentity: 'fixture-account-judge',
    };
  },
} as never);

// A Jev double for the turn-start questions only: it judges a past run or an
// operation to be this kind of work when it names the drive operation, and
// leans toward it the way same-kind runs split a real choice. Every other lane
// is unavailable, so it fails open exactly as it would without Jev.
const turnStartRequests: Array<{ questions: Record<string, { type: string; instructions?: string; criteria?: Record<string, unknown> }> }> = [];
jev._setTypesafeKeyForTests('ts_fixture');
jev._setSystemOneFetchForTests(async (_url, init) => {
  const body = JSON.parse(String(init.body)) as { questions: Record<string, { type: string; instructions?: string; criteria?: Record<string, unknown> }> };
  const ids = Object.keys(body.questions);
  if (!ids.some((id) => id.startsWith('run_') || id === 'select')) {
    return { status: 503, ok: false, text: async () => '' };
  }
  turnStartRequests.push(body);
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(body.questions)) {
    if (question.type === 'choice') {
      const hit = Object.entries(question.criteria ?? {})
        .find(([key, text]) => key !== 'none' && /googledrive_find_file/i.test(String(text)));
      const choice = hit ? hit[0] : 'none';
      const confidence = hit ? 0.45 : 0.9;
      answers[id] = { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } };
    } else {
      answers[id] = { type: 'noul', noul: /googledrive_find_file/i.test(question.instructions ?? '') ? 0.93 : 0.04 };
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

function workCall(callId: string, ref: string, query: string) {
  return functionCall(callId, 'work_call', {
    requirement_id: ref,
    name: 'composio_execute_tool',
    args_json: JSON.stringify({ tool_slug: OPERATION, arguments: { query } }),
    universe_item_id: null,
    universe_selector: null,
    seal_amendment: null,
    source_call_ids: null,
    source_record_ids: null,
  });
}

/** A brain that follows the host's disclosure. It calls the operation directly
 *  only when the request carries a callable ref for it that no tool result
 *  supplied in this turn; otherwise it searches for it. After a failed call it
 *  searches once, then retries with what the search disclosed. */
function disclosureFollowingBrain(label: string, query: string) {
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
        // First frame: direct call only on a host-disclosed callable ref.
        const disclosed = /skip tool_search/.test(text) ? REF_PATTERN.exec(text)?.[0] : undefined;
        output = disclosed
          ? [workCall(`${label}-direct`, disclosed, query)]
          : [functionCall(`${label}-search`, 'tool_search', {
              query: `${OPERATION} find a file by name`, account_selection: null, role_key: null, limit: 5, cursor: null,
            })];
      } else if (called(`${label}-direct`) && !called(`${label}-search`)
        && !/fixture-file-/.test(resultText(input, `${label}-direct`))) {
        // The bound call failed: search is the way back.
        output = [functionCall(`${label}-search`, 'tool_search', {
          query: `${OPERATION} find a file by name`, account_selection: null, role_key: null, limit: 5, cursor: null,
        })];
      } else if (called(`${label}-search`) && !called(`${label}-after-search`)) {
        const ref = REF_PATTERN.exec(resultText(input, `${label}-search`))?.[0];
        output = ref ? [workCall(`${label}-after-search`, ref, query)] : [assistantText('I could not reach that operation.')];
      } else {
        output = [assistantText(`Done (${label}).`)];
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

async function hostTurn(label: string, text: string, query: string) {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: label });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `familiar-${label}:${session.id}` });
  const accepted = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
    text, taskMode: { version: 1, kind: 'normal' },
  } }, { armRunInFlight: true });
  const identity = { sessionId: session.id, sourceUserSeq: accepted.seq };
  const brain = disclosureFollowingBrain(label, query);
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
    frames: run.frames.map((frame) => frame.tools),
    events: run.trace.map((event) => event.type).slice(-40),
  }).slice(0, 6_000);
}

test('the second time a familiar kind of question is asked, the learned operation is bound and no tool_search runs', async () => {
  // First time: discover, call, succeed, learn.
  const first = await hostTurn('first', 'Is there a file called Q3 Plan in my Google Drive?', 'Q3 Plan');
  assert.deepEqual(first.toolCalls.filter((name) => name === 'tool_search'), ['tool_search'], debug(first));
  assert.equal(transportCalls, 1, debug(first));
  const learned = first.trace.find((event) => event.type === 'run_strategy_learned');
  assert.ok(learned, `a verified done turn teaches its run: ${debug(first)}`);
  assert.ok((learned.data.toolsUsed as string[]).some((name) => name.toUpperCase() === OPERATION), JSON.stringify(learned.data));

  // Second time: another target, another wording, no keyword floor cleared.
  const request = 'can you check whether my drive has the budget spreadsheet in it';
  assert.equal(strategies.listMatchingRunStrategies(request, 4).length, 0,
    'the wording shares no keyword floor with the first request, so only a judgement of kind can connect them');
  const turnStartsBefore = turnStartRequests.length;
  const second = await hostTurn('second', request, 'budget spreadsheet');
  assert.equal(turnStartRequests.length, turnStartsBefore + 1, 'one turn-start decision');
  assert.equal(second.selected?.pickedBy, 'jev', debug(second));
  assert.equal(second.selected?.skipDiscoverySearch, true, debug(second));
  assert.ok((second.selected?.capabilityRefs as string[] | undefined)?.some((ref) => REF_PATTERN.test(ref)), debug(second));
  assert.ok(second.frames[0]?.tools.includes('tool_search'), 'search stays on the surface as the way back');
  assert.deepEqual(second.toolCalls.filter((name) => name === 'tool_search'), [], `zero tool_search: ${debug(second)}`);
  assert.equal(transportCalls, 2, 'the bound operation ran once, directly');
  assert.equal(second.result.status, 'completed', debug(second));
});

test('when the learned operation cannot be bound because its connection is gone, search runs', async () => {
  connectionLive = false;
  // The host's current observation of the owner's connections now shows none.
  await observeConnections();
  assert.deepEqual(composioClient.peekCurrentConnectedToolkits(), []);
  try {
    const before = transportCalls;
    const run = await hostTurn('disconnected', 'look in my drive for the onboarding checklist please', 'onboarding checklist');
    assert.notEqual(run.selected?.skipDiscoverySearch, true, `a stale connection is never bound: ${debug(run)}`);
    assert.ok(run.toolCalls.includes('tool_search'), `search runs when the proven path is unavailable: ${debug(run)}`);
    assert.equal(transportCalls, before, 'nothing reached the provider without a live connection');
  } finally {
    connectionLive = true;
    await observeConnections();
  }
});

test('when the bound call fails, search runs on the same surface and the operation is reached again', async () => {
  const before = transportCalls;
  failNextTransportCall = true;
  const run = await hostTurn('failed-bound', 'does my google drive have the hiring tracker', 'hiring tracker');
  assert.equal(run.selected?.skipDiscoverySearch, true, debug(run));
  assert.ok(run.toolCalls.indexOf('work_call') < run.toolCalls.indexOf('tool_search'), `the bound call ran first: ${debug(run)}`);
  assert.equal(run.toolCalls.filter((name) => name === 'tool_search').length, 1, debug(run));
  assert.equal(transportCalls, before + 2, 'the failed call and the call after search each reached the provider once');
  const surfaces = new Set(run.frames.map((frame) => frame.tools.join(',')));
  assert.equal(surfaces.size, 1, `the tool surface is stable for the whole turn: ${JSON.stringify([...surfaces])}`);
});
