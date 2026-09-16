/** P3 same-step tool-edge journey. No provider/network calls: the real host,
 * consent reducer, dispatch lease, external settlement and result handle run
 * against a deterministic exact catalog port. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-direct-write-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_WATCHER_JUDGE = 'off';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'host-direct-write-fixture\n');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifests = await import('./capability-manifest.js');
const stores = await import('./capability-manifest-store.js');
const observations = await import('./independent-capability-observation.js');
const ports = await import('./production-capability-ports.js');
const adapters = await import('./production-capability-adapter.js');
const schemas = await import('../../tools/composio-schema-cache.js');
const { digestSchema } = await import('../../tools/tool-contract-store.js');
const { buildWorkCall } = await import('../../tools/work-call.js');
const { hostRunRunner, HostInterruptState, HostRecoveryState } = await import('./host-turn-runner.js');
const approvals = await import('./approval-registry.js');
const completion = await import('./carrier-completion-registry.js');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const INPUT_SCHEMA = { type: 'object', properties: { body: { type: 'string' } }, required: ['body'], additionalProperties: false };
const ARGS = { body: 'Prepared and validated local draft content.' };
after(() => {
  observations.clearIndependentCapabilityObservations();
  catalogs.installHostCapabilityCatalogFactory(null);
  stores.installCapabilityManifestStore(null);
  ports.clearProductionCapabilityPorts();
  schemas.resetToolSchemaCache();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function* modelStream(this: { getResponse(request: unknown): Promise<any> }, request: unknown) {
  const response = await this.getResponse(request);
  yield { type: 'response_started' } as never;
  yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
}

// A provider-neutral completer for the fixture's own carrier shape: the model
// wrote `args` (an object) where the carrier takes `args_json` (a string), and
// the host completes it before admission — the same args→args_json rewrite
// composio-carrier-completion applies to a live carrier. Claims nothing else.
const FIXTURE_ALIAS_OPERATIONS = new Set<string>();
completion.registerCarrierCompleter((argumentsJson) => {
  let outer: Record<string, unknown>;
  try { outer = JSON.parse(argumentsJson) as Record<string, unknown>; } catch { return null; }
  if (!outer || typeof outer !== 'object' || typeof outer.name !== 'string' || !FIXTURE_ALIAS_OPERATIONS.has(outer.name)) return null;
  if ('args_json' in outer || !('args' in outer) || !outer.args || typeof outer.args !== 'object') return null;
  const { args, ...rest } = outer;
  return { argumentsJson: JSON.stringify({ ...rest, args_json: JSON.stringify(args) }), toolSlug: outer.name, changes: ['args renamed to args_json'] };
});

async function directWriteFixture(carrierName: 'call_tool' | 'work_call', kind: 'draft' | 'send' | 'delete' | 'admin' | 'opaque' | 'bounded' = 'draft', suffix = '', uncertain = false, outerShape: 'args_json' | 'args' = 'args_json', writeCount = 1, providerFixture?: { operationId: string; schema: Record<string, unknown>; payloads: Record<string, unknown>[]; singleFrame?: boolean; preparationFailure?: boolean; carrierRepresentation?: 'gateway_object' | 'gateway_string' | 'gateway_alias'; taskMode?: { version: 1; kind: 'plan' }; result?: unknown }) {
  const inputSchema = providerFixture?.schema ?? INPUT_SCHEMA;
  const payloadForWrite = (ordinal: number): Record<string, unknown> => providerFixture?.payloads[ordinal - 1]
    ?? (writeCount === 1 ? ARGS : { body: `${ARGS.body} Item ${ordinal}.` });
  const args = payloadForWrite(1);
  const operationId = providerFixture?.operationId ?? { draft: 'EXAMPLE_CREATE_DRAFT', send: 'EXAMPLE_SEND_MESSAGE', delete: 'EXAMPLE_DELETE_RECORD', admin: 'EXAMPLE_ROTATE_API_KEY', opaque: 'api_request', bounded: 'api_request' }[kind];
  if (outerShape === 'args') FIXTURE_ALIAS_OPERATIONS.add(operationId);
  const capabilityId = `cap:resolved:${operationId.toLowerCase()}`;
  const accountId = 'account:direct:owner';
  const providerInputSchemaDigest = digestSchema(inputSchema);
  const definitionFingerprint = sha(`${operationId}:${providerInputSchemaDigest}`);
  schemas.rememberToolSchema(operationId, inputSchema, Date.now(), '1', { type: 'object' });
  const manifest = manifests.attachSemanticContract({
    version: 1, manifestId: capabilityId, providerKind: 'native_mcp', operationId,
    providerIdentity: 'native:direct-write-fixture', providerVersion: 'catalog-v1', operationVersion: '1', definitionFingerprint,
    externalDefinition: { version: 1, providerInputSchemaDigest, semanticName: operationId,
      // An opaque call is carrier-silent (no destructive claim either way), so
      // its consequence stays unnamed and it still pauses for the person. A
      // bounded call is the same operation whose carrier declares it
      // non-destructive; the harness answers that one itself.
      behaviorHints: { readOnly: false, destructive: kind === 'delete' ? true : kind === 'opaque' ? null : false, idempotent: null, openWorld: false } },
    effect: kind === 'admin' ? 'admin' : 'external_write', accountId,
    ...(kind === 'draft' ? { operationSemantics: { version: 1 as const, reversibility: 'reversible' as const } } : {}),
    destination: { family: 'external_resource', posture: kind === 'draft' ? 'create_new' : 'named_existing' },
    idempotency: { required: true, policy: 'key_before_dispatch' }, reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'created_resource' }, purpose: 'invoke_live_operation',
    acceptedInputKinds: ['arguments'], producedOutputKinds: ['result'], applicableDeliverableKinds: ['result'],
    evidenceContract: { kinds: ['result'], readbackRequired: false },
    provenance: { issuer: 'host:direct-write:test', issuedAt: '2026-09-04T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' }, invokePortId: 'host:direct-fixture:invoke', argumentCompiler: { id: 'host:json', version: '1' },
  });
  stores.installCapabilityManifestStore(stores.createCapabilityManifestStore([manifest], { durable: true }));
  const observedAt = Date.now();
  const observation = { definitionFingerprint, providerVersion: manifest.providerVersion, operationVersion: '1', accountId, observedAt };
  assert.equal(observations.registerIndependentCapabilityObservation({ operationId, ...observation, origin: 'independent', observe: () => ({ operationId, ...observation }) }).ok, true);
  let modelCalls = 0;
  let providerCalls = 0;
  let preparationCalls = 0;
  const invoke = async (request: any) => {
    providerCalls += 1;
    assert.equal(modelCalls, providerFixture?.singleFrame ? 1 : providerCalls, 'each call dispatches in the model step that nominated it');
    assert.deepEqual(request.payload, payloadForWrite(providerCalls));
    assert.equal(request.binding.account, accountId);
    assert.ok(request.authority, 'the existing adapter receives the exact consent grant');
    if (uncertain) throw new Error('fixture transport outcome unknown after possible write');
    if (providerFixture && Object.prototype.hasOwnProperty.call(providerFixture, 'result')) return providerFixture.result;
    return { successful: true, data: { id: `draft-${carrierName}-${providerCalls}`, ...payloadForWrite(providerCalls) } };
  };
  ports.clearProductionCapabilityPorts();
  assert.equal(ports.registerFixtureCapabilityPort(ports.productionPortIdentityFromManifest(manifest), {
    invoke: invoke as never,
    admitPreparation: () => undefined,
    prepareInvocation: async () => {
      preparationCalls += 1;
      if (providerFixture?.preparationFailure) throw new Error('fixture packaged provider client is unavailable before dispatch');
      return { fixture: true };
    },
    invokeWithPreparation: async (_proof: unknown, work: () => Promise<unknown>) => work(),
  }).ok, true);
  const entry = adapters.registeredCapabilityFromManifest({ manifest, observation, invoke: invoke as never });
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  const prompt = kind === 'draft'
    ? `Create ${writeCount} independent reversible drafts on my connected owner account from this validated content. Do not send anything.`
    : `Perform the exact ${kind} operation on my connected owner account from this validated content.`;
  const session = eventlog.createSession({ id: `p3-direct-write-${carrierName}-${kind}-${suffix}`, kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: prompt, ...(providerFixture?.taskMode ? { taskMode: providerFixture.taskMode } : {}) } });
  let carrierBodies = 0;
  const carrier = brackets.wrapToolForHarness(carrierName === 'work_call'
    ? buildWorkCall({ requireHostPlan: true, hostPlanningReady: () => true }) as never
    : { type: 'function', name: 'call_tool', description: 'Invoke one exact current tool.',
        // `note` is a required strict-nullable field the fixture model never emits:
        // the pause persists materialized bytes (note: null) while the checkpoint
        // history keeps the raw bytes, so every resume case in this file also pins
        // that an omitted nullable field is not an approval edit.
        parameters: { type: 'object', properties: { name: { type: 'string' }, args_json: { type: 'string' }, note: { type: ['string', 'null'] } }, required: ['name', 'args_json', 'note'] },
        invoke: async () => { carrierBodies += 1; throw new Error('must use the already resolved exact port'); } } as never);
  const outerArgs = carrierName === 'work_call'
    ? { requirement_id: 'create_draft', universe_item_id: null, universe_selector: null, seal_amendment: null,
        source_call_ids: null, source_record_ids: null, name: operationId, args_json: JSON.stringify(args) }
    : { name: operationId, args_json: JSON.stringify(args) };
  // The bytes the MODEL emits. With the `args` shape the host completes them
  // (args → args_json) before admission, so the pause persists bytes that never
  // appeared in the checkpointed model history.
  const modelArgs: Record<string, unknown> = outerShape === 'args'
    ? (({ args_json: _dropped, ...rest }) => ({ ...rest, args }))(outerArgs)
    : outerArgs;
  const modelArgumentsForOrdinal = (ordinal: number): Record<string, unknown> => {
    const representation = providerFixture?.carrierRepresentation;
    if (representation) {
      // Actual candidate2 shape: the outer args_json is a string, but the
      // nested Composio arguments value is an object. The real host completer
      // serializes it once while accepted model history retains these bytes.
      const inner = { tool_slug: operationId, arguments: representation === 'gateway_string'
        ? JSON.stringify(payloadForWrite(ordinal)) : payloadForWrite(ordinal) };
      const outer = { ...outerArgs, name: 'composio_execute_tool', args_json: JSON.stringify(inner) };
      if (representation !== 'gateway_alias') return outer;
      const { args_json: _omitted, ...hostFields } = outer;
      return { ...hostFields, args: inner };
    }
    return writeCount === 1 ? modelArgs
      : { ...modelArgs, ...(outerShape === 'args'
        ? { args: payloadForWrite(ordinal) }
        : { args_json: JSON.stringify(payloadForWrite(ordinal)) }) };
  };
  const modelInputs: unknown[] = [];
  const model = {
    async getResponse(request: { tools?: Array<{ name?: string }>; input?: unknown }) {
      modelCalls += 1;
      modelInputs.push(request.input);
      assert.ok(request.tools?.some((entry) => entry.name === carrierName), JSON.stringify(request.tools?.map(t => t.name)));
      if (modelCalls === 1) {
        // Same shape as the tag canary: exact live capability is ready only
        // after the model request froze its empty catalog. Never make a plan.
        factory.register(entry);
      }
      const ordinals = providerFixture?.singleFrame
        ? (modelCalls === 1 ? Array.from({ length: writeCount }, (_, index) => index + 1) : [])
        : (modelCalls <= writeCount ? [modelCalls] : []);
      return { responseId: `direct-write-${carrierName}-${modelCalls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: ordinals.length > 0
          ? ordinals.map(ordinal => ({ type: 'function_call', callId: writeCount === 1 ? 'exact-draft' : `exact-draft-${ordinal}`, name: carrierName, arguments: JSON.stringify(modelArgumentsForOrdinal(ordinal)) }))
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: providerFixture?.preparationFailure ? 'The provider could not be prepared; no drafts were created.' : 'The draft was created.' }] }],
      };
    }, getStreamedResponse: modelStream,
  };
  let agent: any = { model, tools: [carrier] };
  const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: [carrier], activeToolNames: [carrierName],
    policyHash: 'p3-direct-write', budget: { maxUncachedTokens: 10_000, maxModelCalls: writeCount + 2, maxToolCalls: writeCount + 2, maxElapsedMs: 60_000 } });
  assert.ok(sealed.ok);
  if (!sealed.ok) return;
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const useProductionAgent = async () => {
    const { primePrimaryModelPlanningCatalog } = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
    const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
    factory.register(entry);
    const primed = await primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: source.seq });
    assert.ok(primed.ok, JSON.stringify(primed));
    if (!primed.ok) throw new Error(primed.reason);
    agent = await buildOrchestratorAgent({ sessionId: session.id, sourceUserSeq: source.seq,
      userInput: prompt, hostFreshPlanning: primed.planning, allowToolJit: true, model: model as never });
    return agent;
  };
  const runner = new EventEmitter();
  Object.assign(runner, { run() { throw new Error('legacy Runner must remain unreachable'); } });
  const run = (input: any = [{ type: 'message', role: 'user', content: prompt }], extra: Record<string, unknown> = {}) => brackets.withHarnessRunContext({ sessionId: session.id, sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(writeCount + 2), behaviorScopeId: `${session.id}::turn:1` },
  () => hostRunRunner(runner as never, agent as never, input,
    { maxTurns: writeCount + 2, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq }, ...extra } as never));
  return { run, session, source, agent, runner, manifest, accountId, operationId, outerArgs, modelArgs, prompt, model, useProductionAgent, modelInputs,
    counts: () => ({ providerCalls, modelCalls, preparationCalls, carrierBodies }) };
}

test('the production approval wrapper rebuilds the original host source and continues after SQLite reopen', async () => {
  const fixture = await directWriteFixture('work_call', 'opaque', 'production-resume', false, 'args_json', 1, {
    operationId: 'PRODUCTION_APPROVAL_WRITE', schema: INPUT_SCHEMA, payloads: [ARGS],
  });
  assert.ok(fixture);
  const { runConversation, runConversationFromResume } = await import('./loop.js');
  const { buildOrchestratorAgentForApprovalResume } = await import('../../agents/orchestrator.js');
  const agent = await fixture.useProductionAgent();
  const paused = await runConversation({ agent, sessionId: fixture.session.id, input: fixture.prompt,
    sourceUserSeq: fixture.source.seq, reuseRecordedUserInput: true,
    suppressMemoryCapture: true, judgeCompletion: false, turnEngine: 'host_v1', makeRunner: () => fixture.runner as never });
  assert.equal(paused.status, 'awaiting_approval', JSON.stringify({ paused, errors: eventlog.listEvents(fixture.session.id, { types: ['run_failed', 'guardrail_tripped'] }).map(e => e.data) }));
  assert.equal(fixture.counts().providerCalls, 0);
  const approval = approvals.listPending({ sessionId: fixture.session.id, status: 'pending' })[0]!;
  assert.ok(approval);
  assert.equal(approvals.resolve(approval.approvalId, 'approved', 'production-fixture').ok, true);
  eventlog.closeEventLog();
  const resumed = await runConversationFromResume({ sessionId: fixture.session.id,
    approvalId: approval.approvalId, decision: 'approve', resolver: 'production-fixture', turnEngine: 'host_v1',
    makeRunner: () => fixture.runner as never, maxTurns: 3,
    judgeFn: async () => ({ done: true, reason: 'fixture operation completed' }),
    buildAgent: identity => buildOrchestratorAgentForApprovalResume({
      sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, acceptedRoute: identity.route,
      ...('hostFreshPlanning' in identity ? { hostFreshPlanning: identity.hostFreshPlanning as never } : {}),
      model: fixture.model as never, allowToolJit: true,
    }),
  });
  const detail = eventlog.listEvents(fixture.session.id, { types: ['guardrail_tripped'] }).map(e => e.data);
  assert.equal(fixture.counts().providerCalls, 1, JSON.stringify({ resumed, detail }));
  assert.equal(resumed.status, 'completed');
  const terminal = eventlog.listEvents(fixture.session.id, { types: ['conversation_completed'] }).at(-1);
  assert.match(JSON.stringify(terminal?.data), /The draft was created/);
  const settlements = eventlog.openEventLog().prepare('SELECT source_user_seq, outcome_kind FROM logical_call_settlements WHERE session_id = ? AND mutating = 1').all(fixture.session.id) as any[];
  assert.deepEqual(settlements.map(row => [row.source_user_seq, row.outcome_kind]), [[fixture.source.seq, 'succeeded']]);
});

for (const carrierName of ['call_tool', 'work_call'] as const) test(`one exact ${carrierName} reversible write crosses in its model step without plan_task`, async () => {
  const fixture = await directWriteFixture(carrierName);
  assert.ok(fixture);
  const { session } = fixture;
  const outcome = await fixture.run();
  const { providerCalls, preparationCalls, carrierBodies } = fixture.counts();
  assert.equal(providerCalls, 1, `exact write did not dispatch: ${JSON.stringify(outcome.history.filter((row) => (row as any).type === 'function_call_result'))}`);
  assert.equal(preparationCalls, 1);
  assert.equal(carrierBodies, 0);
  assert.equal(Boolean(outcome.hasInterruptions), false);
  assert.equal(eventlog.listEvents(session.id, { types: ['turn_graph_compiled', 'awaiting_user_input'] }).length, 0);
  assert.equal(eventlog.listEvents(session.id, { types: ['external_write_succeeded'] }).length, 1);
  const db = eventlog.openEventLog();
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM durable_result_handles WHERE session_id = ?').get(session.id) as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ?').get(session.id) as { n: number }).n, 0);
});

test('three independent exact reversible writes settle through per-call consent without plan_task', async () => {
  const fixture = await directWriteFixture('work_call', 'draft', 'three-independent', false, 'args_json', 3);
  assert.ok(fixture);
  const outcome = await fixture.run();
  assert.equal(fixture.counts().providerCalls, 3, JSON.stringify(outcome.history));
  assert.equal(fixture.counts().preparationCalls, 3);
  assert.equal(Boolean(outcome.hasInterruptions), false);
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['turn_graph_compiled', 'awaiting_user_input'] }).length, 0);
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['external_write_succeeded'] }).length, 3);
  const returned = outcome.history.filter((item: any) => item.type === 'function_call_result');
  assert.equal(returned.length, 3);
  assert.equal(new Set(returned.map((item: any) => item.callId)).size, 3);
});

test('three exact drafts dispatch from the real SDK schema after undefined optional metadata is closed at ingestion', async () => {
  const schema = JSON.parse(readFileSync(new URL('../../tools/fixtures/outlook-create-draft-input-schema.json', import.meta.url), 'utf8'));
  // The exact SDK shape found by a metadata-only live reproduction. It is
  // absent from the provider JSON wire, but present as undefined in memory.
  schema.properties.attachment.anyOf[0].description = undefined;
  const payloads = [
    { subject: 'schema-proof-A', body: 'Redwood appointment follow-up.', is_html: false },
    { subject: 'schema-proof-B', body: 'Juniper proposal follow-up.', is_html: false },
    { subject: 'schema-proof-C', body: 'Willow formatting check.', is_html: false },
  ];
  const fixture = await directWriteFixture('work_call', 'draft', 'sdk-schema-three', false, 'args_json', 3,
    { operationId: 'OUTLOOK_CREATE_DRAFT', schema, payloads, singleFrame: true });
  assert.ok(fixture);
  assert.equal(fixture.manifest.externalDefinition?.providerInputSchemaDigest, 'e76f11e4b4d7b4ee8f075b8f43a7d6a329e09d6b3dcabfceab8685f9817dd418');
  const outcome = await fixture.run();
  assert.equal(fixture.counts().providerCalls, 3, JSON.stringify(outcome.history));
  assert.equal(fixture.counts().preparationCalls, 3);
  assert.equal(Boolean(outcome.hasInterruptions), false);
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['turn_graph_compiled', 'awaiting_user_input'] }).length, 0);
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['external_write_succeeded'] }).length, 3);
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['guardrail_tripped'] }).filter(row => row.data.kind === 'prepared_external_call_mismatch').length, 0);
});

function refusedProviderFixture(representation: 'direct' | 'gateway_object' | 'gateway_string' | 'gateway_alias') {
  const schema = representation === 'direct' ? INPUT_SCHEMA
    : JSON.parse(readFileSync(new URL('../../tools/fixtures/outlook-create-draft-input-schema.json', import.meta.url), 'utf8'));
  if (representation !== 'direct') schema.properties.attachment.anyOf[0].description = undefined;
  return {
    operationId: representation === 'direct' ? 'EXAMPLE_CREATE_DRAFT' : 'OUTLOOK_CREATE_DRAFT', schema,
    payloads: [1, 2, 3].map(ordinal => representation === 'direct'
      ? { body: `Exact refused draft ${ordinal}.` }
      : { subject: `raw-carrier-proof-${ordinal}`, body: `Exact refused draft ${ordinal}.`, is_html: false,
          to_recipients: [], cc_recipients: [], bcc_recipients: [] }),
    singleFrame: true, preparationFailure: true,
    ...(representation === 'direct' ? {} : { carrierRepresentation: representation }),
  };
}

for (const representation of ['direct', 'gateway_object', 'gateway_string', 'gateway_alias'] as const) test(`a preparation refusal settles all three ${representation} work calls without dispatch or checkpoint recovery`, async () => {
  const fixture = await directWriteFixture('work_call', 'draft', `three-preparation-refused-${representation}`, false, 'args_json', 3,
    refusedProviderFixture(representation));
  assert.ok(fixture);
  const outcome = await fixture.run();
  assert.equal(fixture.counts().preparationCalls, 1);
  assert.equal(fixture.counts().providerCalls, 0);
  assert.equal(outcome.hold, undefined, JSON.stringify(outcome));
  assert.equal(outcome.serializedRecoveryState, undefined);
  const rawCall = outcome.history.find((item: any) => item.type === 'function_call') as any;
  const rawOuter = JSON.parse(rawCall.arguments);
  if (representation === 'gateway_object') {
    assert.equal(typeof JSON.parse(rawOuter.args_json).arguments, 'object', 'accepted model history keeps the raw nested object');
  } else if (representation === 'gateway_alias') {
    assert.ok(rawOuter.args, 'accepted history retains the raw args alias');
    assert.equal(Object.hasOwn(rawOuter, 'args_json'), false);
  }
  const returned = outcome.history.filter((item: any) => item.type === 'function_call_result') as any[];
  assert.deepEqual(returned.map(item => [item.callId, item.name, JSON.parse(item.output.text).disposition]), [
    ['exact-draft-1', 'work_call', 'refused_pre_dispatch'],
    ['exact-draft-2', 'work_call', 'not_started'],
    ['exact-draft-3', 'work_call', 'not_started'],
  ]);
  // Reopen storage to prove settlement and projection survive process-local
  // state loss; the provider cannot be entered by receipt/checkpoint recovery.
  eventlog.closeEventLog();
  const db = eventlog.openEventLog();
  const calls = db.prepare('SELECT logical_tool_call_id, tool_name, state FROM logical_tool_calls WHERE session_id = ? ORDER BY logical_tool_call_id').all(fixture.session.id);
  assert.deepEqual(calls, [1, 2, 3].map(ordinal => ({ logical_tool_call_id: `exact-draft-${ordinal}`, tool_name: fixture.operationId.toLowerCase(), state: 'settled' })));
  const settlements = db.prepare('SELECT execution_kind, host_crossing_count, physical_crossing_count FROM logical_call_settlements WHERE session_id = ?').all(fixture.session.id);
  assert.deepEqual(settlements, [1, 2, 3].map(() => ({ execution_kind: 'refused_pre_dispatch', host_crossing_count: 0, physical_crossing_count: 0 })));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?').get(fixture.session.id) as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM logical_model_result_projection_receipts WHERE session_id = ?').get(fixture.session.id) as { n: number }).n, 3);
  assert.deepEqual(db.prepare('SELECT disposition FROM accepted_model_batch_checkpoints WHERE session_id = ?').all(fixture.session.id), [{ disposition: 'ready' }]);
});

for (const representation of ['direct', 'gateway_object'] as const) test(`finalize recovery closes exact ${representation} unstarted siblings after storage reopens without replaying preparation`, async () => {
  const fixture = await directWriteFixture('work_call', 'draft', `three-refused-recovery-${representation}`, false, 'args_json', 3,
    refusedProviderFixture(representation));
  assert.ok(fixture);
  eventlog.openEventLog().exec(`CREATE TEMP TRIGGER fixture_refuse_sibling_settlement
    BEFORE INSERT ON logical_call_settlements
    WHEN NEW.logical_tool_call_id = 'exact-draft-2'
    BEGIN SELECT RAISE(ABORT, 'fixture settlement storage unavailable'); END`);
  const held = await fixture.run();
  assert.ok(held.serializedRecoveryState);
  assert.equal(HostRecoveryState.fromString(held.serializedRecoveryState).phase, 'finalize');
  const { commitTurnOutcome } = await import('./delivery-committer.js');
  const { turnOutcomeId } = await import('./turn-outcome.js');
  const identity = { sessionId: fixture.session.id, turn: fixture.source.turn, sourceUserSeq: fixture.source.seq };
  const blockedTerminal = {
    version: 2 as const, id: turnOutcomeId(identity), identity,
    status: 'blocked' as const, resumable: true,
    presentation: { kind: 'blocked' as const, text: 'The provider could not be prepared; no drafts were created.' },
  };
  // Exact live failure: exhausting checkpoint retries returned a blocked
  // outcome, but the unchanged terminal guard correctly rejected its two
  // OPEN siblings. Merely delivering different prose cannot repair this.
  assert.throws(() => commitTurnOutcome(blockedTerminal), /host call authority still owns unsettled work/);
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['conversation_completed'] }).length, 0);
  assert.deepEqual(fixture.counts(), { providerCalls: 0, modelCalls: 1, preparationCalls: 1, carrierBodies: 0 });
  eventlog.closeEventLog(); // drops the injected failure as a fresh process would
  const recovered = await fixture.run(HostRecoveryState.fromString(held.serializedRecoveryState));
  assert.ok(recovered.serializedRecoveryState);
  assert.equal(HostRecoveryState.fromString(recovered.serializedRecoveryState).phase, 'continue');
  assert.deepEqual(fixture.counts(), { providerCalls: 0, modelCalls: 1, preparationCalls: 1, carrierBodies: 0 });
  const db = eventlog.openEventLog();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM logical_tool_calls WHERE session_id = ? AND state = 'settled' AND tool_name = ?").get(fixture.session.id, fixture.operationId.toLowerCase()) as { n: number }).n, 3);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM logical_model_result_projection_receipts WHERE session_id = ?').get(fixture.session.id) as { n: number }).n, 3);
  assert.deepEqual(db.prepare('SELECT disposition FROM accepted_model_batch_checkpoints WHERE session_id = ?').all(fixture.session.id), [{ disposition: 'ready' }]);
  const completed = await fixture.run(HostRecoveryState.fromString(recovered.serializedRecoveryState));
  assert.equal(completed.hold, undefined);
  assert.equal(fixture.counts().preparationCalls, 1);
  assert.equal(fixture.counts().providerCalls, 0);
  const terminal = commitTurnOutcome(blockedTerminal);
  assert.equal(terminal.presentation.status, 'blocked');
  assert.equal(terminal.presentation.identity.sourceUserSeq, fixture.source.seq);
  assert.equal(commitTurnOutcome(blockedTerminal).event.id, terminal.event.id);
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['conversation_completed'] }).length, 1);
});

for (const change of ['call_name', 'arguments', 'active_call_lease'] as const) test(`unstarted sibling recovery refuses ${change} without inventing a zero-effect settlement`, async () => {
  const fixture = await directWriteFixture('work_call', 'draft', `refusal-tamper-${change}`, false, 'args_json', 3, {
    operationId: 'EXAMPLE_CREATE_DRAFT', schema: INPUT_SCHEMA,
    payloads: [1, 2, 3].map(ordinal => ({ body: `Exact protected draft ${ordinal}.` })),
    singleFrame: true, preparationFailure: true,
  });
  assert.ok(fixture);
  eventlog.openEventLog().exec(`CREATE TEMP TRIGGER fixture_refuse_sibling_settlement
    BEFORE INSERT ON logical_call_settlements
    WHEN NEW.logical_tool_call_id = 'exact-draft-2'
    BEGIN SELECT RAISE(ABORT, 'fixture settlement storage unavailable'); END`);
  const held = await fixture.run();
  assert.ok(held.serializedRecoveryState);
  eventlog.closeEventLog();
  const state = HostRecoveryState.fromString(held.serializedRecoveryState);
  const call = state.frameHistory[1] as any;
  if (change === 'call_name') {
    call.name = 'call_tool';
    (state.resultItems[1] as any).name = 'call_tool';
  } else if (change === 'arguments') {
    const outer = JSON.parse(call.arguments);
    outer.args_json = JSON.stringify({ body: 'Changed body after admission.' });
    call.arguments = JSON.stringify(outer);
  } else {
    const { activateDispatchLease } = await import('./dispatch-lease.js');
    const { durableLogicalCallRecoveryMaterial } = await import('./logical-call-contract.js');
    const acceptedTaskId = state.acceptedModelBatchRef!.acceptedTaskId;
    const material = durableLogicalCallRecoveryMaterial(acceptedTaskId, call.name, JSON.parse(call.arguments));
    assert.ok(material);
    activateDispatchLease({ sessionId: fixture.session.id, scopeId: `fixture-active-sibling:${fixture.session.id}`,
      sourceUserSeq: fixture.source.seq, acceptedTaskId, logicalToolCallId: call.callId,
      recovery: { effect: 'external_write', businessCall: true, material } });
  }
  const outcome = await fixture.run(state);
  assert.ok(outcome.hold, JSON.stringify(outcome));
  assert.deepEqual(fixture.counts(), { providerCalls: 0, modelCalls: 1, preparationCalls: 1, carrierBodies: 0 });
  assert.equal((eventlog.openEventLog().prepare('SELECT state FROM logical_tool_calls WHERE session_id = ? AND logical_tool_call_id = ?')
    .get(fixture.session.id, 'exact-draft-2') as { state: string }).state, 'open');
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) AS n FROM accepted_model_batch_checkpoints WHERE session_id = ?')
    .get(fixture.session.id) as { n: number }).n, 0);
});

for (const change of ['rejected', 'edited-args', 'wrong-approval', 'expired'] as const) test(`direct approval resume ${change} cannot execute a provider call`, async () => {
  const fixture = await directWriteFixture('work_call', 'send', change);
  assert.ok(fixture);
  const paused = await fixture.run();
  assert.equal(paused.hasInterruptions, true, JSON.stringify(paused.history));
  const interruption = paused.interruptions![0]!;
  const approval = approvals.registerResumable({ sessionId: fixture.session.id,
    subject: 'Approve this exact send.', tool: interruption.toolName, args: interruption.args,
    resumeKey: interruption.approvalResumeKey! }).row;
  assert.equal(approvals.resolve(approval.approvalId, change === 'rejected' ? 'rejected' : 'approved', 'direct-host-fixture').ok, true);
  const state = HostInterruptState.fromString(paused.serializedState!);
  const pending = state.getInterruptions()[0]!;
  if (change === 'rejected') state.reject(pending);
  else state.approve(pending);
  if (change === 'edited-args') pending.rawItem.arguments = JSON.stringify({ ...fixture.outerArgs, args_json: JSON.stringify({ body: 'Altered send content.' }) });
  if (change === 'expired') {
    eventlog.openEventLog().prepare('UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?').run(1, approval.approvalId);
  }
  const outcome = await fixture.run(state, { hostApprovalIds: [change === 'wrong-approval' ? 'unrelated-approval' : approval.approvalId] });
  assert.equal(fixture.counts().providerCalls, 0, JSON.stringify(outcome.history));
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['external_write_started', 'external_write_succeeded'] }).length, 0);
  assert.equal(Boolean(outcome.hasInterruptions), false, 'a changed/rejected grant repairs visibly instead of inventing another card');
  assert.ok(outcome.history.some((item) => (item as any).type === 'function_call_result'), 'the refused call stays paired in model history');
});

test('an uncertain exact write is never automatically retried', async () => {
  const fixture = await directWriteFixture('call_tool', 'draft', 'uncertain', true);
  assert.ok(fixture);
  const outcome = await fixture.run();
  assert.equal(fixture.counts().providerCalls, 1);
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['external_write_succeeded'] }).length, 0);
  assert.match(JSON.stringify(outcome), /uncertain|unknown|reconcil/i);
  assert.equal(Boolean(outcome.hasInterruptions), false, 'uncertain state is reconciliation, not a new approval');
});

for (const kind of ['send', 'delete', 'admin'] as const) test(`exact ${kind} pauses before I/O and unchanged durable approval resumes the same call`, async () => {
  const fixture = await directWriteFixture('call_tool', kind);
  assert.ok(fixture);
  const paused = await fixture.run();
  assert.equal(paused.hasInterruptions, true, JSON.stringify(paused.history));
  assert.equal(fixture.counts().providerCalls, 0);
  assert.equal(fixture.counts().modelCalls, 1);
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['turn_graph_compiled', 'external_write_succeeded'] }).length, 0);
  const interruption = paused.interruptions![0]!;
  assert.ok(interruption.approvalResumeKey);
  const approval = approvals.registerResumable({ sessionId: fixture.session.id,
    subject: `Approve the exact ${kind}.`, tool: interruption.toolName, args: interruption.args,
    resumeKey: interruption.approvalResumeKey! }).row;
  assert.equal(approvals.resolve(approval.approvalId, 'approved', 'direct-host-fixture').ok, true);
  const state = HostInterruptState.fromString(paused.serializedState!);
  state.approve(state.getInterruptions()[0]);
  const resumed = await fixture.run(state, { hostApprovalIds: [approval.approvalId] });
  assert.equal(fixture.counts().providerCalls, 1, JSON.stringify(resumed.history));
  assert.equal(Boolean(resumed.hasInterruptions), false);
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['external_write_succeeded'] }).length, 1);
});

// The pause persists the bytes the host ADMITTED — here completed from the
// model's `args` alias into the carrier's `args_json` — while the checkpointed
// model history keeps the raw bytes. An unchanged approval must compare against
// what was admitted, never against the checkpoint: otherwise every host-completed
// carrier write reads as a user edit on resume and the send never dispatches.
test('an approved carrier write whose pause bytes the host completed resumes unchanged and dispatches exactly once', async () => {
  const fixture = await directWriteFixture('work_call', 'send', 'completed-carrier', false, 'args');
  assert.ok(fixture);
  const paused = await fixture.run();
  assert.equal(paused.hasInterruptions, true, JSON.stringify(paused.history));
  assert.equal(fixture.counts().providerCalls, 0);
  const checkpointed = paused.history.find((item) => (item as any).type === 'function_call' && (item as any).callId === 'exact-draft') as any;
  assert.ok(checkpointed, 'the raw model call is checkpointed');
  assert.ok('args' in JSON.parse(checkpointed.arguments), 'the checkpoint keeps the raw model shape');
  const interruption = paused.interruptions![0]!;
  const persisted = JSON.parse(interruption.rawArgs!) as Record<string, unknown>;
  assert.equal(typeof persisted.args_json, 'string', 'the pause persisted the completed carrier bytes');
  assert.equal('args' in persisted, false);
  assert.notEqual(interruption.rawArgs, checkpointed.arguments, 'this pin only bites if the pause bytes differ from the checkpoint bytes');
  const approval = approvals.registerResumable({ sessionId: fixture.session.id,
    subject: 'Approve the exact send.', tool: interruption.toolName, args: interruption.args,
    resumeKey: interruption.approvalResumeKey! }).row;
  assert.equal(approvals.resolve(approval.approvalId, 'approved', 'direct-host-fixture').ok, true);
  const state = HostInterruptState.fromString(paused.serializedState!);
  state.approve(state.getInterruptions()[0]);
  const resumed = await fixture.run(state, { hostApprovalIds: [approval.approvalId] });
  assert.equal(fixture.counts().providerCalls, 1, JSON.stringify(resumed.history));
  assert.equal(Boolean(resumed.hasInterruptions), false);
  assert.equal((resumed as { hold?: unknown }).hold, undefined);
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['external_write_succeeded'] }).length, 1);
});

// The fourth reducer decision. allow/ask/deny above all carry exact accepted
// coverage; a graph-neutral direct local mutation has none, so the reducer
// answers `repair` (coverage_missing) and the same-step door must release the
// admitted logical call into the zero-I/O repair pairing. The strict schema
// has a nullable field the model omits, so the raw model bytes and the
// materialized bytes the loop admitted digest DIFFERENTLY: settlement must
// present the admitted bytes or the release fails and the turn is refused.
test('an uncovered direct local write with an omitted strict-nullable field repairs before I/O', async () => {
  const { acceptedTaskIdFor } = await import('./attempt-identity.js');
  const { durableLogicalCallContract } = await import('./logical-call-contract.js');
  const { materializeStrictNullableFields } = await import('../schema-normalizer.js');
  const taxonomy = await import('../../agents/tool-taxonomy.js');
  const RAW_ARGS = { path: '/fixture/draft.txt', content: 'draft', mode: 'create', append: null };
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
      mode: { anyOf: [{ type: 'string', enum: ['create', 'append', 'overwrite'] }, { type: 'null' }] },
      append: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
      optional_context: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['path', 'content', 'mode', 'append', 'optional_context'],
    additionalProperties: false,
  };
  let bodies = 0;
  const tool = brackets.wrapToolForHarness({
    type: 'function', name: 'write_file', description: 'Recording-only local write fixture.', strict: true, parameters: schema,
    needsApproval: taxonomy.needsApprovalFromTaxonomy('write_file', { computeInsideWorkspace: () => true }),
    invoke: async () => { bodies += 1; return JSON.stringify({ ok: true }); },
  } as never);
  const prompt = 'Create a small draft file in the selected workspace.';
  const callId = 'uncovered-local-write';
  const session = eventlog.createSession({ id: 'p3-direct-write-local-uncovered-repair', kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: prompt } });
  let modelCalls = 0;
  const model = {
    async getResponse() {
      modelCalls += 1;
      return { responseId: `uncovered-local-write-${modelCalls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: modelCalls === 1
          ? [{ type: 'function_call', callId, name: 'write_file', arguments: JSON.stringify(RAW_ARGS) }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The write was repaired without I/O.' }] }],
      };
    }, getStreamedResponse: modelStream,
  };
  const agent = { model, tools: [tool] };
  const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: [tool], activeToolNames: ['write_file'],
    policyHash: 'p3-direct-write-local', budget: { maxUncachedTokens: 10_000, maxModelCalls: 3, maxToolCalls: 3, maxElapsedMs: 60_000 } });
  assert.ok(sealed.ok);
  if (!sealed.ok) return;
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const runner = new EventEmitter();
  Object.assign(runner, { run() { throw new Error('legacy Runner must remain unreachable'); } });
  const outcome = await brackets.withHarnessRunContext({ sessionId: session.id, sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(3), behaviorScopeId: `${session.id}::turn:1` },
  () => hostRunRunner(runner as never, agent as never, [{ type: 'message', role: 'user', content: prompt }],
    { maxTurns: 3, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq } } as never));

  // This pin only proves something if admission and raw bytes truly diverge.
  const acceptedTaskId = acceptedTaskIdFor(session.id, source.seq);
  const admitted = materializeStrictNullableFields(RAW_ARGS, schema);
  assert.deepEqual(admitted, { ...RAW_ARGS, optional_context: null });
  const rawDigest = durableLogicalCallContract(acceptedTaskId, 'write_file', RAW_ARGS)!.argumentDigest;
  const admittedDigest = durableLogicalCallContract(acceptedTaskId, 'write_file', admitted)!.argumentDigest;
  assert.notEqual(rawDigest, admittedDigest, 'raw and materialized bytes must digest differently for this pin to bite');

  assert.equal(bodies, 0, 'an uncovered mutation must never reach its body');
  assert.equal(Boolean(outcome.hasInterruptions), false, 'coverage_missing is a repair, not an approval question');
  assert.equal((outcome as { terminal?: unknown }).terminal, undefined, 'a repair is paired to the model, never a public terminal');
  assert.equal(modelCalls, 2, 'the paired repair must reach the next model step');
  assert.ok(outcome.history.some((item) => (item as any).type === 'function_call_result' && (item as any).callId === callId),
    `the refused call stays paired in model history: ${JSON.stringify(outcome.history)}`);
  const db = eventlog.openEventLog();
  const rows = db.prepare('SELECT tool_name, argument_digest, state FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ?')
    .all(session.id, source.seq) as Array<{ tool_name: string; argument_digest: string; state: string }>;
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0]!.tool_name, 'write_file');
  assert.equal(rows[0]!.argument_digest, admittedDigest, 'the reducer admitted the materialized contract');
  assert.equal(rows[0]!.state, 'settled', 'the refused call is settled under the bytes that admitted it, never left open');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ? AND source_user_seq = ?').get(session.id, source.seq) as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ?').get(session.id) as { n: number }).n, 0);
});

test('the real host approval reaches the public event with reducer effect, account and reversibility', async () => {
  const fixture = await directWriteFixture('call_tool', 'send', 'public-card');
  assert.ok(fixture);
  const outcome = await fixture.run();
  assert.equal(outcome.hasInterruptions, true);
  const { runTurn } = await import('./loop.js');
  const published = await runTurn({ agent: fixture.agent as never, sessionId: fixture.session.id,
    input: fixture.prompt, sourceUserSeq: fixture.source.seq, reuseRecordedUserInput: true,
    skipAutomaticMemoryPrimer: true, suppressMemoryCapture: true, turnEngine: 'host_v1',
    makeRunner: () => fixture.runner as never, runRunner: async () => outcome });
  assert.equal(published.status, 'awaiting_approval');
  const events = eventlog.listEvents(fixture.session.id, { types: ['approval_requested'] });
  assert.equal(events.length, 1);
  const metadata = (events[0]!.data as any).consentCall;
  assert.ok(metadata, 'the actual reducer result must reach the public approval event');
  assert.equal(metadata.effect, 'external_write');
  assert.equal(metadata.accountId, fixture.accountId);
  assert.equal(metadata.risk.consequence, 'send');
  assert.equal(metadata.risk.reversibility, 'irreversible');
  assert.deepEqual(metadata, (outcome.interruptions![0] as any).consentCall);
  assert.deepEqual(metadata, (HostInterruptState.fromString(outcome.serializedState!).getInterruptions()[0] as any).consentCall);
  assert.equal(fixture.counts().providerCalls, 0);
});

for (const carrier of ['call_tool', 'work_call'] as const) {
  test(`opaque external ${carrier} pauses for its exact action, reopens, and dispatches once after approval`, async () => {
    const fixture = await directWriteFixture(carrier, 'opaque', 'exact-api', false, 'args_json', 1, {
      operationId: 'api_request',
      schema: { type: 'object', properties: { method: { type: 'string' }, path: { type: 'string' }, data: { type: 'array', items: { type: 'object' } } }, required: ['method', 'path', 'data'], additionalProperties: false },
      payloads: [{ method: 'POST', path: '/v1/query', data: [{ query: 'fixture research' }] }],
    });
    assert.ok(fixture);
    const paused = await fixture.run();
    assert.equal(paused.hasInterruptions, true, 'valid opaque arguments must not enter an impossible repair loop');
    assert.equal(fixture.counts().providerCalls, 0);
    const interruption = paused.interruptions![0]!;
    assert.deepEqual((interruption as any).consentCall.risk, { consequence: 'unknown', reversibility: 'unknown', destructive: false });
    assert.ok(interruption.approvalResumeKey);
    const approval = approvals.registerResumable({ sessionId: fixture.session.id,
      subject: 'Review this exact research request.', tool: interruption.toolName, args: interruption.args,
      resumeKey: interruption.approvalResumeKey! }).row;
    assert.equal(approvals.resolve(approval.approvalId, 'approved', 'direct-host-fixture').ok, true);
    eventlog.closeEventLog();
    const state = HostInterruptState.fromString(paused.serializedState!);
    state.approve(state.getInterruptions()[0]);
    const resumed = await fixture.run(state, { hostApprovalIds: [approval.approvalId] });
    assert.equal(fixture.counts().providerCalls, 1, JSON.stringify(resumed.history));
    assert.equal(Boolean(resumed.hasInterruptions), false);
    assert.equal(eventlog.listEvents(fixture.session.id, { types: ['external_write_succeeded'] }).length, 1);
  });
}

test('a carrier-declared non-destructive generic call is answered by the harness and dispatches once without a card', async () => {
  const fixture = await directWriteFixture('work_call', 'bounded', 'bounded-api', false, 'args_json', 1, {
    operationId: 'generic_request',
    schema: { type: 'object', properties: { method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] }, path: { type: 'string' }, data: { type: 'array', items: { type: 'object' } } }, required: ['method', 'path', 'data'], additionalProperties: false },
    payloads: [{ method: 'POST', path: '/v1/query', data: [{ query: 'fixture research' }] }],
  });
  assert.ok(fixture);
  const outcome = await fixture.run();
  assert.equal(Boolean(outcome.hasInterruptions), false, 'no human card for a carrier-bounded call');
  assert.equal(fixture.counts().providerCalls, 1, JSON.stringify(outcome.history));
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['external_write_succeeded'] }).length, 1);
  const decided = eventlog.listEvents(fixture.session.id, { types: ['interactive_consent_decided'] });
  assert.equal(decided.length, 1, 'the harness journals the decision it answered');
  assert.equal(decided[0]!.data.basis, 'exact_carrier_bounded_work');
  assert.equal(decided[0]!.data.requestMethod, 'post');
});

// A PLANNING TURN'S PROBE IS PREPARATION, NOT A MUTATION. The same
// carrier-bounded shape in Plan proceeds once as a preparation probe and is
// accounted like a read crossing: no write reservation, no orphan projection,
// a non-mutating settlement whose returned text is ordinary retained evidence,
// and the turn continues to the next model round. The Act-mode case above
// keeps reserving and settling the identical call as a write.
test('a carrier-bounded call in Plan mode dispatches once as a preparation probe and is accounted like a read', async () => {
  const providerText = 'Ok. 20000 rows returned for the fixture research query.';
  const fixture = await directWriteFixture('call_tool', 'bounded', 'plan-probe', false, 'args_json', 1, {
    operationId: 'generic_request',
    schema: { type: 'object', properties: { method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] }, path: { type: 'string' }, data: { type: 'array', items: { type: 'object' } } }, required: ['method', 'path', 'data'], additionalProperties: false },
    payloads: [{ method: 'POST', path: '/v1/query', data: [{ query: 'fixture research' }] }],
    taskMode: { version: 1, kind: 'plan' },
    result: providerText,
  });
  assert.ok(fixture);
  const outcome = await fixture.run();
  const detail = () => JSON.stringify({ terminal: outcome.terminal, output: outcome.finalOutput, history: outcome.history });
  assert.equal(Boolean(outcome.hasInterruptions), false, 'no human card for a preparation probe');
  assert.notEqual(outcome.terminal, 'exact_checkpoint_admission_exhausted', detail());
  assert.equal(fixture.counts().providerCalls, 1, detail());
  assert.equal(fixture.counts().modelCalls, 2, 'the turn proceeds to the next model round');
  assert.ok(JSON.stringify(fixture.modelInputs[1]).includes(providerText), 'the provider text reaches the model unchanged');
  const decided = eventlog.listEvents(fixture.session.id, { types: ['interactive_consent_decided'] });
  assert.equal(decided.length, 1, 'the consent journal row stays');
  assert.equal(decided[0]!.data.basis, 'plan_preparation_probe');
  for (const type of ['external_write', 'external_write_orphaned', 'external_write_succeeded', 'external_write_failed'] as const) {
    assert.equal(eventlog.listEvents(fixture.session.id, { types: [type] }).length, 0, `${type} is never booked for a probe`);
  }
  const settledAll = eventlog.listEvents(fixture.session.id, { types: ['tool_attempt_settled'] });
  const settled = settledAll.filter((event) => event.data.callId === 'exact-draft');
  assert.equal(settled.length, 1, JSON.stringify(settledAll.map(e => e.data)));
  assert.equal(settled[0]!.data.mutating, false);
  assert.equal(settled[0]!.data.kind, 'succeeded');
  assert.notEqual(settled[0]!.data.action, 'stop_and_explain');
  const row = eventlog.openEventLog().prepare(`SELECT outcome_kind, mutating, recovery_action FROM logical_call_settlements
    WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
    .get(fixture.session.id, fixture.source.seq, 'exact-draft') as Record<string, unknown> | undefined;
  assert.ok(row, 'the settlement is durable');
  assert.equal(row.outcome_kind, 'succeeded');
  assert.equal(row.mutating, 0);
  assert.notEqual(row.recovery_action, 'stop_and_explain');
});
