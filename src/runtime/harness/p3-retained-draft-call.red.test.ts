/** Local-only retained-byte replay. Intentionally uncommitted: reads private
 * canary evidence from a stopped snapshot rather than copying it into git. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'p3-retained-draft-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_WATCHER_JUDGE = 'off';
process.env.COMPOSIO_API_KEY = 'fixture-key';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'p3-retained-draft-fixture\n');

// This replay reads a live-evidence snapshot captured on one machine. Where
// the snapshot is absent (CI, another checkout) the file registers ONE skipped
// test instead of failing at import — the evidence path is still honored via
// P3_DRAFT_SNAPSHOT wherever the capture exists.
const SNAPSHOT_PATH = process.env.P3_DRAFT_SNAPSHOT
  ?? '/private/tmp/clem-p3-draft-canary-evidence.GhAH2o/harness.snapshot.db';
if (!existsSync(SNAPSHOT_PATH)) {
  test('p3 retained draft replay needs its evidence snapshot', { skip: `snapshot not present: ${SNAPSHOT_PATH} (set P3_DRAFT_SNAPSHOT)` }, () => {});
} else {
const snapshot = new Database(SNAPSHOT_PATH, { readonly: true });
const frame = (ordinal: number): any[] => JSON.parse((snapshot.prepare(
  'SELECT frame_history_json FROM accepted_model_batch_admissions WHERE source_user_seq=442 AND batch_ordinal=?',
).get(ordinal) as { frame_history_json: string }).frame_history_json);
const history = JSON.parse((snapshot.prepare(
  'SELECT history_json FROM accepted_model_batch_checkpoints WHERE source_user_seq=442 AND batch_ordinal=1',
).get() as { history_json: string }).history_json);
const searchResult = JSON.parse(history.find((item: any) => item.type === 'function_call_result'
  && item.callId === 'toolu_01QCUAVMLPjWhSuQgSbMB8X7').output.text);
const providerSchema = searchResult.schemas.OUTLOOK_CREATE_DRAFT;
const sourceText = JSON.parse((snapshot.prepare(
  "SELECT data_json FROM events WHERE session_id='background:bg-graph-driver-tag-canary-20260904' AND seq=442",
).get() as { data_json: string }).data_json).text;
const capturedFrame = frame(6);
const initialRejectedFrame = frame(3);
const secondRejectedFrame = frame(4);
const thirdRejectedFrame = frame(5);
const capturedCall = capturedFrame.find((item) => item.type === 'function_call');
const capturedPlan = frame(2);
const capturedBinding = snapshot.prepare(
  'SELECT * FROM host_call_capability_bindings WHERE logical_tool_call_id=?',
).get(capturedCall.callId) as any;
snapshot.close();

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const productionAdapters = await import('./production-capability-adapters.js');
const stores = await import('./capability-manifest-store.js');
const connected = await import('./connected-goal-catalog.js');
const client = await import('../../integrations/composio/client.js');
const inner = await import('../../tools/inner-dispatch.js');
const composioTools = await import('../../tools/composio-tools.js');
const schemaCache = await import('../../tools/composio-schema-cache.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const { canonicalExternalInputSchemaDigestV1 } = await import('./external-capability-risk-loader.js');
const { durableLogicalCallContract } = await import('./logical-call-contract.js');
const { buildCallTool } = await import('../../tools/call-tool.js');
const { selectExactPreparedExternalCall } = await import('./host-interactive-consent.js');
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  inner._setInnerDispatchToolsForTests(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  stores.installCapabilityManifestStore(null);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('retained batch6 exact provider evidence reproduces its durable schema and argument digest', async () => {
  schemaCache.rememberToolSchema('OUTLOOK_CREATE_DRAFT', providerSchema, Date.now());
  const outer = JSON.parse(capturedCall.arguments);
  const contract = durableLogicalCallContract(capturedBinding.accepted_task_id, 'work_call', outer)!;
  assert.equal(contract.argumentDigest, capturedBinding.attested_argument_digest);
  assert.equal(canonicalExternalInputSchemaDigestV1(providerSchema), capturedBinding.provider_input_schema_digest);
  let selected: unknown;
  const tool = buildCallTool({ reachableBuiltinNames: new Set(['composio_execute_tool']),
    aroundResolvedDispatch: async (resolved) => {
      selected = selectExactPreparedExternalCall({
        acceptedTaskId: capturedBinding.accepted_task_id,
        effectiveArgumentDigest: capturedBinding.attested_argument_digest,
        effectiveToolName: capturedBinding.tool_name,
        providerInputSchemaDigest: capturedBinding.provider_input_schema_digest,
        candidates: [
          { inputSchema: resolved.targetInputSchema, arguments: resolved.targetArgs, logicalToolName: resolved.targetName },
          { inputSchema: resolved.evidenceInputSchema, arguments: resolved.evidenceArgs, logicalToolName: capturedBinding.tool_name },
        ],
      });
      return { successful: true };
    },
  });
  await (tool as any).invoke({ context: { sessionId: 'exact-decoder' } }, JSON.stringify({ name: outer.name, args_json: outer.args_json }),
    { toolCall: { callId: capturedCall.callId } });
  assert.ok(selected, 'real carrier decoder must retain its exact provider evidence pair');
});

test('retained batch6 corrected singleton crosses real host preparation and consent once', async () => {
  const bodies: unknown[] = [];
  productionAdapters.installProductionTransport(async (call) => {
    bodies.push(call); return { successful: true, data: { id: 'fixture-only-draft' } };
  });
  const outputSchema = { type: 'object', properties: { successful: { type: 'boolean' }, data: { type: 'object' } } };
  const rawTool = { slug: 'OUTLOOK_CREATE_DRAFT', name: 'Create an Outlook draft', description: searchResult.results[0].summary,
    toolkit: { slug: 'outlook' }, inputParameters: providerSchema, outputParameters: outputSchema, version: '20260903_00' };
  client.__test__.setComposioApiKeyOverride('fixture-key');
  client.__test__.setConnectedAccountsLoader(async () => [{ id: capturedBinding.account_id, status: 'ACTIVE', user_id: 'fixture-user',
    toolkit: { slug: 'outlook' }, email: 'nathan.reynolds@scorpion.co' }] as never);
  client.__test__.setComposioClient({ client: { baseURL: 'https://backend.composio.dev' },
    getClient: () => ({ withOptions: () => ({ tools: { execute: async (_operation: string, body: unknown) => {
      bodies.push(body); return { successful: true, data: { id: 'fixture-only-draft' } };
    } } }) }),
    tools: { getRawComposioTools: async () => [rawTool], execute: async () => { throw new Error('legacy provider fallback'); } },
  } as never);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://backend.composio.dev/api/v3/tools?')) return new Response(JSON.stringify({ items: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`no network in retained replay: ${url}`);
  }) as typeof fetch;
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  stores.installCapabilityManifestStore(stores.createCapabilityManifestStore());
  connected.installConnectedRegistryPort(() => ({ connectedToolkits: ['outlook'], tools: [{ slug: rawTool.slug, schema: providerSchema }] }));
  const gateway = composioTools.getComposioRuntimeTools().find((tool) => tool.name === 'composio_execute_tool')!;
  inner._setInnerDispatchToolsForTests(new Map([['composio_execute_tool', gateway as never]]));
  const session = eventlog.createSession({ id: 'p3-retained-draft-call', kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: sourceText } });
  const primed = await semantic.primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: source.seq });
  assert.ok(primed.ok, JSON.stringify(primed));
  if (!primed.ok) return;
  let step = 0;
  const model = {
    async getResponse() {
      step += 1;
      const output = step === 1 ? [{ type: 'function_call', callId: 'disclose-captured-draft', name: 'tool_search',
        arguments: JSON.stringify({ query: searchResult.query, role_key: null, limit: 8 }) }]
        : step === 2 ? capturedPlan
        : step === 3 ? initialRejectedFrame
        : step === 4 ? secondRejectedFrame
        : step === 5 ? thirdRejectedFrame
        : step === 6 ? capturedFrame
        : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture ended after the nominated call.' }] }];
      return { responseId: `retained-${step}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output };
    },
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse();
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
  const agent = await buildOrchestratorAgent({ userInput: sourceText, sessionId: session.id, sourceUserSeq: source.seq,
    hostFreshPlanning: primed.planning, allowToolJit: true, model: model as never });
  const runner = new EventEmitter();
  Object.assign(runner, { run() { throw new Error('legacy SDK loop'); } });
  const outcome = await brackets.withHarnessRunContext({ sessionId: session.id, sourceUserSeq: source.seq,
    turn: source.turn, counter: new brackets.ToolCallsCounter(24), behaviorScopeId: `${session.id}::turn:1` },
  () => hostRunRunner(runner as never, agent as never, [{ type: 'message', role: 'user', content: sourceText }] as never,
    { maxTurns: 7, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq } } as never));
  const toolResults = outcome.history.filter((item: any) => item.type === 'function_call_result');
  const corrected = toolResults.find((item: any) => item.callId === capturedCall.callId) as any;
  assert.ok(corrected, 'the actual corrected singleton was evaluated');
  const firstRefusal = toolResults.find((item: any) => item.callId === initialRejectedFrame.find((row) => row.type === 'function_call').callId) as any;
  assert.match(firstRefusal.output.text, /work_cardinality_mismatch/);
  assert.doesNotMatch(corrected.output.text, /bound_catalog_call_does_not_match_exact_schema_and_arguments/,
    'retained call/frame/schema bytes alone do not reproduce the live prepared-pair mismatch');
  console.error(JSON.stringify({ step, bodies: bodies.length, correctedOutput: corrected.output.text }));
  assert.equal(bodies.length, 1, 'the corrected exact draft must dispatch once; captured five-each completion is intentionally not asserted');
});
}
