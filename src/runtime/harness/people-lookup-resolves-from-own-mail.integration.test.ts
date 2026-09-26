/**
 * A person's address is resolved from the owner's own mail, remembered with
 * its source, and next time answered from memory, end to end through the
 * production host turn.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/people-lookup-resolves-from-own-mail.integration.test.ts
 *
 * The host surfaces the built-in people-lookup skill for a request that names
 * a person to reach. The test brain follows what the host discloses: it reads
 * the skill the packet names, searches memory first, then the owner's mail
 * through tool_search and the connected (fictional) mail toolkit, takes the
 * address from the thread the person sent, and records it with
 * memory_remember. On the next request the host's memory context already
 * carries the address, so the brain answers with no lookup at all. Nothing in
 * the brain constructs an address; the assertions check that no call ever
 * carried one that a source had not returned.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-people-lookup-'));
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-people-lookup\n');
// A fictional mail toolkit, registered the way any catalog toolkit is.
writeFileSync(path.join(HOME, 'state', 'composio-catalog-cache.json'), JSON.stringify({
  at: Date.now(),
  data: [{ slug: 'samplemail', name: 'Sample Mail', authMode: 'managed', description: 'Fixture mailbox for tests.' }],
}));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('no network in the people-lookup fixture'); };

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
const builtins = await import('../../setup/builtin-skills.js');
const facts = await import('../../memory/facts.js');

const PERSON = 'Dana Lee';
const ADDRESS = 'dana.lee@sampleteam.example';
const SEARCH_OP = 'SAMPLEMAIL_SEARCH_MESSAGES';
const SEARCH_REF = /cap:resolved:samplemail_search_messages(?::definition:[a-z0-9]+)?/;
const SEARCH_INPUT = { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string' }, top: { type: 'number' } } };
const SEARCH_OUTPUT = { type: 'object', properties: { messages: { type: 'array' } } };
const DIRECTORY_OP = 'SAMPLEMAIL_GET_USER_BY_EMAIL';
const DIRECTORY_INPUT = { type: 'object', additionalProperties: false, required: ['email'], properties: { email: { type: 'string' } } };

const providerCalls: Array<{ slug: string; arguments: unknown }> = [];
function providerAnswer(slug: string, args: unknown): unknown {
  providerCalls.push({ slug, arguments: args });
  if (slug === SEARCH_OP) {
    return {
      messages: [
        { from: { name: PERSON, address: ADDRESS }, to: [{ name: 'Owner', address: 'owner@sampleteam.example' }], subject: 'Q3 plan draft', receivedAt: '2026-09-20T15:04:00Z' },
        { from: { name: 'Owner', address: 'owner@sampleteam.example' }, to: [{ name: PERSON, address: ADDRESS }], subject: 'Re: Q3 plan draft', receivedAt: '2026-09-20T16:10:00Z' },
      ],
    };
  }
  throw new Error(`fixture: unexpected provider operation ${slug}`);
}

catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
isolatedTransport.installIsolatedAttestedTransport(async (call: unknown) => {
  const c = call as { toolSlug?: string; tool_slug?: string; slug?: string; arguments?: unknown; args?: unknown };
  return providerAnswer(String(c.toolSlug ?? c.tool_slug ?? c.slug ?? SEARCH_OP), c.arguments ?? c.args);
});
const OPS: Record<string, { input: unknown; output: unknown; name: string; description: string }> = {
  [SEARCH_OP]: { input: SEARCH_INPUT, output: SEARCH_OUTPUT, name: 'Search mail messages', description: 'Search the connected mailbox for messages by sender name, recipient name, subject or keyword; returns from, to, subject and received time.' },
  [DIRECTORY_OP]: { input: DIRECTORY_INPUT, output: { type: 'object' }, name: 'Get directory user by email', description: 'Look up one organization directory user by an exact email address.' },
};
schemas._setToolSchemaLoaderForTests(async (identifier: string) => {
  const op = OPS[identifier.toUpperCase()];
  return op ? { inputParameters: op.input, outputParameters: op.output, providerObservedAt: Date.now(), providerOperationVersion: '20260926_01' } : null;
});
composioClient.__test__.setComposioApiKeyOverride('fixture-composio-key');
composioClient.__test__.setConnectedAccountsLoader(async () => [
  { id: 'conn-samplemail', status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'samplemail' } },
]);
composioClient.__test__.setComposioClient({
  client: { baseURL: 'https://backend.composio.dev' },
  getClient: () => ({
    withOptions: () => ({
      tools: {
        execute: async (slug: string, input: { arguments?: unknown }) => ({ data: providerAnswer(slug, input?.arguments), error: null, successful: true, log_id: `fixture-${providerCalls.length}` }),
      },
    }),
  }),
  tools: {
    async getRawComposioTools(input: { tools?: string[] }) {
      const exact = new Set((input.tools ?? []).map((value) => value.toUpperCase()));
      const rows = Object.entries(OPS).map(([slug, op]) => ({
        slug, name: op.name, description: op.description, toolkit: { slug: 'samplemail' },
        inputParameters: op.input, outputParameters: op.output, version: 'fixture-samplemail-v1',
      }));
      return rows.filter((row) => exact.size === 0 || exact.has(row.slug));
    },
    async execute(slug: string, input: { arguments?: unknown }) {
      return { data: providerAnswer(slug, input?.arguments), error: null, successful: true };
    },
  },
} as never);
semanticPorts.installTurnSemanticModelPort({
  async interpret() { throw new Error('no hidden work plan in this fixture'); },
  async judgeAccountSelection(call) {
    return { verdict: call.mode === 'current_source_default' ? 'default_compatible' : 'entailed', proposalDigest: call.proposalDigest, modelIdentity: 'fixture-account-judge' };
  },
} as never);

// The built-in skills are provisioned into this home the way boot does it.
const provisioned = builtins.provisionBuiltinSkills({ baseDir: HOME, packageRoot: REPO_ROOT });

after(() => {
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
/** A kernel tool is called by its own name when it is on the surface, else through call_tool. */
function kernelCall(tools: string[], callId: string, name: string, args: Record<string, unknown>) {
  return tools.includes(name)
    ? functionCall(callId, name, args)
    : functionCall(callId, 'call_tool', { name, args_json: JSON.stringify(args) });
}

/** A brain that follows the host's disclosure and the skill it names. */
function skillFollowingBrain(label: string) {
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
      const tools = (request.tools ?? []).map((tool) => tool.name ?? '');
      const text = JSON.stringify({ ...request, tools: undefined });
      frames.push({ tools, text });
      step += 1;
      const called = (callId: string) => input.some((item) => (item as { callId?: string }).callId === callId);
      let output: unknown[];
      const toolResultsSoFar = input.some((item) => (item as { type?: string }).type === 'function_call_result');
      if (!toolResultsSoFar && text.includes(ADDRESS)) {
        // Memory first: the host already carries the address, so nothing is looked up.
        output = [assistantText(`${PERSON}'s email address is ${ADDRESS} (remembered from a message she sent you on 2026-09-20).`)];
      } else if (!called(`${label}-skill`)) {
        output = /people-lookup/.test(text)
          ? [functionCall(`${label}-skill`, 'skill_read', { name: 'people-lookup' })]
          : [assistantText('The host did not name a procedure for reaching a person; stopping.')];
      } else if (!called(`${label}-memory`)) {
        output = /Memory first/.test(resultText(input, `${label}-skill`))
          ? [kernelCall(tools, `${label}-memory`, 'memory_search_facts', { query: PERSON, limit: 15 })]
          : [assistantText('The skill body did not arrive; stopping.')];
      } else if (!called(`${label}-search`)) {
        output = [functionCall(`${label}-search`, 'tool_search', {
          query: 'search mail messages by sender or recipient name', account_selection: null, role_key: null, limit: 5, cursor: null,
        })];
      } else if (!called(`${label}-mail`)) {
        const ref = SEARCH_REF.exec(resultText(input, `${label}-search`))?.[0];
        output = ref
          ? [functionCall(`${label}-mail`, 'work_call', {
              requirement_id: ref, name: 'composio_execute_tool',
              args_json: JSON.stringify({ tool_slug: SEARCH_OP, arguments: { query: PERSON, top: 10 } }),
              universe_item_id: null, universe_selector: null, seal_amendment: null, source_call_ids: null, source_record_ids: null,
            })]
          : [assistantText('No mail search operation was disclosed; stopping.')];
      } else if (!called(`${label}-remember`)) {
        const found = new RegExp(`"address":"([^"]+)"`).exec(resultText(input, `${label}-mail`).replace(/\\"/g, '"'))?.[1];
        output = found
          ? [kernelCall(tools, `${label}-remember`, 'memory_remember', {
              kind: 'reference',
              content: `${PERSON}'s work email address is ${found} (from a message she sent on 2026-09-20, found in the owner's mailbox)`,
              entities: [{ type: 'person', name: PERSON, identifiers: [{ scheme: 'email', value: found }] }],
            })]
          : [assistantText(`The thread carried no address; I would ask the owner for it rather than guess. RESULT=${resultText(input, `${label}-mail`).slice(0, 2_000)}`)];
      } else {
        output = [assistantText(`${PERSON}'s email address is ${ADDRESS} (found in a message she sent you on 2026-09-20).`)];
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

async function hostTurn(label: string, text: string) {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: label });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `people-${label}:${session.id}` });
  const accepted = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
    text, taskMode: { version: 1, kind: 'normal' },
  } }, { armRunInFlight: true });
  const identity = { sessionId: session.id, sourceUserSeq: accepted.seq };
  const brain = skillFollowingBrain(label);
  const startedAt = Date.now();
  const result = await runConversation({ ...identity, input: text, reuseRecordedUserInput: true,
    runAttemptId: attempt.attemptId, turnEngine: 'host_v1', maxSteps: 1, maxTurns: 10, toolCallsPerTurn: 8, judgeCompletion: false,
    buildAgent: async (context) => buildOrchestratorAgent({ sessionId: context.sessionId,
      sourceUserSeq: context.sourceUserSeq, hostFreshPlanning: context.hostFreshPlanning, userInput: text, allowToolJit: true,
      model: brain as never }),
    makeRunner: () => Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute'); } }) as never,
  });
  const elapsedMs = Date.now() - startedAt;
  const trace = eventlog.listEvents(session.id);
  const toolCalls = trace.filter((event) => event.type === 'tool_called')
    .map((event) => ({ tool: String(event.data.tool), args: typeof event.data.arguments === 'string' ? event.data.arguments : JSON.stringify(event.data.arguments ?? {}) }));
  const decision = (result as { lastDecision?: Record<string, unknown> }).lastDecision ?? {};
  const presentation = (result as { publicPresentation?: Record<string, unknown> }).publicPresentation ?? {};
  const reply = [decision.message, decision.text, decision.reply, presentation.text, presentation.reply, presentation.message]
    .find((value): value is string => typeof value === 'string') ?? JSON.stringify({ decision, presentation });
  return { identity, result, trace, toolCalls, reply, elapsedMs, frames: brain.frames };
}

function debug(run: Awaited<ReturnType<typeof hostTurn>>): string {
  return JSON.stringify({
    status: run.result.status,
    error: (run.result as { error?: unknown }).error,
    toolCalls: run.toolCalls.map((call) => call.tool),
    frames: run.frames.map((frame) => frame.tools.length),
    events: run.trace.map((event) => event.type).slice(-40),
    reply: run.reply.slice(0, 2_400),
    resultKeys: Object.keys(run.result as object),
    lastFrameMailResult: (() => {
      const text = run.frames.at(-1)?.text ?? '';
      const at = text.indexOf('-mail');
      return at >= 0 ? text.slice(Math.max(0, at - 200), at + 1_800) : '';
    })(),
  }).slice(0, 9_000);
}

test('a request naming a person resolves the address from the owner\'s own mail, remembers it with its source, and never guesses one', async () => {
  assert.ok(provisioned.some((entry) => entry.name === builtins.PEOPLE_LOOKUP_SKILL), JSON.stringify(provisioned));
  const first = await hostTurn('first', `Find ${PERSON}'s email address for me, she is on the sales team; I need it for the invite.`);
  assert.equal(first.result.status, 'completed', debug(first));
  // The host named the skill before the brain asked for anything.
  assert.match(first.frames[0]?.text ?? '', /people-lookup/, `the packet names the skill: ${debug(first)}`);
  assert.ok(first.frames[0]?.tools.includes('skill_read'), debug(first));
  const names = first.toolCalls.map((call) => call.tool);
  assert.ok(names.includes('skill_read'), debug(first));
  assert.equal(names.filter((name) => name === 'tool_search').length, 1, `one discovery, for the mail search: ${debug(first)}`);
  // Memory was searched before mail, and mail before anything else.
  const memoryAt = first.toolCalls.findIndex((call) => /memory_search_facts/.test(`${call.tool} ${call.args}`));
  const mailAt = first.toolCalls.findIndex((call) => call.tool === 'work_call');
  assert.ok(memoryAt >= 0 && mailAt > memoryAt, `memory first, then the owner's mail: ${debug(first)}`);
  assert.deepEqual(providerCalls.map((call) => call.slug), [SEARCH_OP], 'the only provider crossing is the mail search by name; no directory call');
  assert.match(JSON.stringify(providerCalls[0]!.arguments), new RegExp(PERSON), 'the mail search is keyed on the person\'s name');
  // No call carried an address before a source returned one.
  for (const call of first.toolCalls.slice(0, mailAt + 1)) {
    assert.doesNotMatch(call.args, /@sampleteam\.example/, `no constructed address before the thread was read: ${call.tool} ${call.args}`);
  }
  // The address is durable memory with the thread it came from as its source.
  const remembered = facts.searchFactsByText(PERSON, 5).find((fact) => fact.content.includes(ADDRESS));
  assert.ok(remembered, `the resolved address is remembered: ${JSON.stringify(facts.searchFactsByText(PERSON, 5))} ${debug(first)}`);
  assert.match(remembered.content, /from a message she sent/);
  const mailCall = first.trace.find((event) => event.type === 'tool_called' && event.data.tool === 'work_call');
  assert.ok(mailCall, debug(first));
  assert.equal(remembered.source?.sessionId, first.identity.sessionId, 'the fact is bound to the conversation that read the thread');
  assert.ok(Date.parse(remembered.createdAt) >= Date.parse(String(mailCall.createdAt)), 'remembered after the thread was read, not before');
  // Known gap, not pinned: memory_remember's best-effort derivedFrom link does
  // not bind to a provider read that ran through work_call, because the
  // authority resolver sees the carrier and its transport mirror under one
  // call id and treats the id as ambiguous. The source lives in the fact text.
  assert.match(first.reply, new RegExp(ADDRESS.replace('.', '\\.')));
});

test('the next request that needs the same person resolves from memory: no lookup call, no guessed address, under five seconds', async () => {
  const before = providerCalls.length;
  const second = await hostTurn('second', `What is ${PERSON}'s email address again? Adding her to the invite.`);
  assert.equal(second.result.status, 'completed', debug(second));
  assert.match(second.frames[0]?.text ?? '', new RegExp(ADDRESS.replace('.', '\\.')), `the host's memory context carries the address before the first frame: ${debug(second)}`);
  assert.deepEqual(second.toolCalls, [], `no lookup of any kind: ${debug(second)}`);
  assert.equal(providerCalls.length, before, 'nothing reached the provider');
  assert.match(second.reply, new RegExp(ADDRESS.replace('.', '\\.')));
  assert.ok(second.elapsedMs < 5_000, `resolved in ${second.elapsedMs} ms`);
});
