/** P3 same-step tool-edge journey. No provider/network calls: the real host,
 * consent reducer, dispatch lease, external settlement and result handle run
 * against a deterministic exact catalog port. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const PROCESS_HOME = process.env.CLEM_APPROVED_CHECKPOINT_FIXTURE_HOME;
if (PROCESS_HOME) assert.ok(path.resolve(PROCESS_HOME).startsWith(path.resolve(os.tmpdir()) + path.sep));
const TEST_HOME = PROCESS_HOME ?? mkdtempSync(path.join(os.tmpdir(), 'clem-host-direct-write-'));
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
  if (!PROCESS_HOME) rmSync(TEST_HOME, { recursive: true, force: true });
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

async function directWriteFixture(carrierName: 'call_tool' | 'work_call', kind: 'draft' | 'send' | 'delete' | 'admin' | 'opaque' | 'bounded' = 'draft', suffix = '', uncertain = false, outerShape: 'args_json' | 'args' = 'args_json', writeCount = 1, providerFixture?: { operationId: string; schema: Record<string, unknown>; payloads: Record<string, unknown>[]; singleFrame?: boolean; deferredAcrossSources?: boolean; preparationFailure?: boolean; carrierRepresentation?: 'gateway_object' | 'gateway_string' | 'gateway_alias'; taskMode?: { version: 1; kind: 'plan' }; result?: unknown; existingSourceSeq?: number }) {
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
    if (!providerFixture?.deferredAcrossSources) assert.equal(modelCalls, providerFixture?.singleFrame ? 1 : providerCalls, 'each call dispatches in the model step that nominated it');
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
  const sessionId = `p3-direct-write-${carrierName}-${kind}-${suffix}`;
  const session = providerFixture?.existingSourceSeq ? eventlog.getSession(sessionId)! : eventlog.createSession({ id: sessionId, kind: 'chat' });
  assert.ok(session);
  const source = providerFixture?.existingSourceSeq
    ? eventlog.listEvents(session.id, { types: ['user_input_received'] }).find(event => event.seq === providerFixture.existingSourceSeq)!
    : eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
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
  const useProductionAgent = async (acceptedSource = source) => {
    const { primePrimaryModelPlanningCatalog } = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
    const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
    factory.register(entry);
    const primed = await primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: acceptedSource.seq });
    assert.ok(primed.ok, JSON.stringify(primed));
    if (!primed.ok) throw new Error(primed.reason);
    agent = await buildOrchestratorAgent({ sessionId: session.id, sourceUserSeq: acceptedSource.seq,
      userInput: prompt, hostFreshPlanning: primed.planning, allowToolJit: true, model: model as never });
    return agent;
  };
  const runner = new EventEmitter();
  Object.assign(runner, { run() { throw new Error('legacy Runner must remain unreachable'); } });
  const run = (input: any = [{ type: 'message', role: 'user', content: prompt }], extra: Record<string, unknown> = {}, acceptedSource = source) => brackets.withHarnessRunContext({ sessionId: session.id, sourceUserSeq: acceptedSource.seq,
    counter: new brackets.ToolCallsCounter(writeCount + 2), behaviorScopeId: `${session.id}::turn:1` },
  () => hostRunRunner(runner as never, agent as never, input,
    { maxTurns: writeCount + 2, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: acceptedSource.seq }, ...extra } as never));
  return { run, session, source, agent, runner, manifest, accountId, operationId, outerArgs, modelArgs, prompt, model, useProductionAgent, modelInputs,
    counts: () => ({ providerCalls, modelCalls, preparationCalls, carrierBodies }) };
}

for (const cancelTarget of ['newer', 'parked'] as const) test(`approval preflight uses the parked source (cancel=${cancelTarget})`, async () => {
  const fixture = await directWriteFixture('work_call', 'opaque', `resume-exact-kill-owner-${cancelTarget}`, false, 'args_json', 1, {
    operationId: `PREFLIGHT_APPROVAL_${cancelTarget.toUpperCase()}`, schema: INPUT_SCHEMA, payloads: [ARGS],
  });
  assert.ok(fixture);
  const paused = await fixture.run();
  assert.equal(paused.hasInterruptions, true);
  const { HarnessSession } = await import('./session.js');
  HarnessSession.load(fixture.session.id)!.saveInterruptState(paused.serializedState!);
  const newerSource = eventlog.appendEvent({ sessionId: fixture.session.id, turn: 2,
    role: 'user', type: 'user_input_received', data: { text: 'Another independent request.' } });
  const cancelledAttempt = eventlog.beginRunAttempt(fixture.session.id, {
    runId: `exact-task-cancellation-fixture-${cancelTarget}`,
  });
  eventlog.bindRunAttemptSourceUserEvent(cancelledAttempt,
    cancelTarget === 'newer' ? newerSource.seq : fixture.source.seq);
  eventlog.requestKill(fixture.session.id, 'Stop only the selected request.', cancelledAttempt);
  eventlog.closeEventLog();
  const { resumePendingApproval } = await import('./loop.js');
  const outcome = await resumePendingApproval({
    sessionId: fixture.session.id, agent: fixture.agent, decision: 'approve',
    sourceUserSeq: newerSource.seq, makeRunner: () => fixture.runner as never,
  });
  assert.equal(outcome.status, cancelTarget === 'newer' ? 'awaiting_approval' : 'killed',
    'the original parked write recovers its approval card instead of consuming another task stop');
  assert.equal(eventlog.isKillRequested(fixture.session.id, cancelledAttempt), cancelTarget === 'newer',
    'only the parked task cancellation may be consumed by this resume');
  assert.equal(fixture.counts().providerCalls, 0, 'recovering a card grants no write authority');
  assert.equal(fixture.counts().modelCalls, 1, 'preflight recovery needs no additional model call');
});

for (const entry of ['conversation', 'pending'] as const) test(`approval from another source is refused before ${entry} resume work`, async () => {
  const fixture = await directWriteFixture('work_call', 'opaque', `wrong-source-${entry}`, false, 'args_json', 1, {
    operationId: `WRONG_SOURCE_${entry.toUpperCase()}`, schema: INPUT_SCHEMA, payloads: [ARGS],
  });
  assert.ok(fixture);
  const paused = await fixture.run();
  assert.equal(paused.hasInterruptions, true);
  const { HarnessSession } = await import('./session.js');
  HarnessSession.load(fixture.session.id)!.saveInterruptState(paused.serializedState!);
  const state = HostInterruptState.fromString(paused.serializedState!);
  const pending = state.pending[0]!;
  const newerSource = eventlog.appendEvent({ sessionId: fixture.session.id, turn: 2,
    role: 'user', type: 'user_input_received', data: { text: 'A separate task with the same payload.' } });
  const { hostInteractiveConsentApprovalResumeKey } = await import('./host-interactive-consent.js');
  const wrongSubject = { ...pending.consentSubject!, sourceUserSeq: newerSource.seq };
  const wrongCard = approvals.registerResumable({ sessionId: fixture.session.id,
    subject: 'Another task with the same arguments.', tool: pending.name,
    args: JSON.parse(pending.rawItem.arguments),
    resumeKey: hostInteractiveConsentApprovalResumeKey(wrongSubject)!,
  }).row;
  let builds = 0;
  const loop = await import('./loop.js');
  const options = { sessionId: fixture.session.id, approvalId: wrongCard.approvalId,
    decision: 'approve' as const, makeRunner: () => fixture.runner as never };
  if (entry === 'conversation') {
    const refused = await loop.runConversationFromResume({ ...options, turnEngine: 'host_v1',
      buildAgent: async () => { builds += 1; throw new Error('wrong task must not build an agent'); },
    });
    assert.equal(refused.status, 'awaiting_approval');
    assert.match(refused.error ?? '', /different paused action/);
    assert.equal(builds, 0, 'an unrelated card is rejected before planning or agent construction');
  } else {
    const refused = await loop.resumePendingApproval({ ...options, agent: fixture.agent });
    assert.equal(refused.status, 'awaiting_approval');
    assert.match(refused.error ?? '', /different paused action/);
  }
  assert.equal(approvals.get(wrongCard.approvalId)?.status, 'pending', 'another task card is never resolved');
  assert.equal(approvals.listPending({ sessionId: fixture.session.id, status: 'pending' }).length, 1,
    'an unrelated decision must not trigger registration of a different task card');
  assert.equal(HarnessSession.load(fixture.session.id)!.loadInterruptState(), paused.serializedState);
  assert.equal(fixture.counts().providerCalls, 0);
  assert.equal(fixture.counts().modelCalls, 1);
});

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

// Owner, 2026-09-25: a waiting card should be something you can change in
// words. The chat route turns a sure "change" reading into this resume.
test('a change requested through the resume rejects the exact write, sends nothing, and reaches the model', async () => {
  const fixture = await directWriteFixture('work_call', 'opaque', 'change-requested', false, 'args_json', 1, {
    operationId: 'CHANGE_REQUESTED_WRITE', schema: INPUT_SCHEMA, payloads: [ARGS],
  });
  assert.ok(fixture);
  const { runConversation, runConversationFromResume } = await import('./loop.js');
  const { buildOrchestratorAgentForApprovalResume } = await import('../../agents/orchestrator.js');
  const agent = await fixture.useProductionAgent();
  const paused = await runConversation({ agent, sessionId: fixture.session.id, input: fixture.prompt,
    sourceUserSeq: fixture.source.seq, reuseRecordedUserInput: true,
    suppressMemoryCapture: true, judgeCompletion: false, turnEngine: 'host_v1', makeRunner: () => fixture.runner as never });
  assert.equal(paused.status, 'awaiting_approval');
  const approval = approvals.listPending({ sessionId: fixture.session.id, status: 'pending' })[0]!;
  assert.ok(approval);
  const inputsBefore = fixture.modelInputs.length;
  eventlog.closeEventLog();
  await runConversationFromResume({ sessionId: fixture.session.id,
    approvalId: approval.approvalId, decision: 'reject', changeRequest: 'make it shorter and mention Alana',
    resolver: 'change-fixture', turnEngine: 'host_v1',
    makeRunner: () => fixture.runner as never, maxTurns: 3,
    judgeFn: async () => ({ done: true, reason: 'fixture reply' }),
    buildAgent: identity => buildOrchestratorAgentForApprovalResume({
      sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, acceptedRoute: identity.route,
      ...('hostFreshPlanning' in identity ? { hostFreshPlanning: identity.hostFreshPlanning as never } : {}),
      model: fixture.model as never, allowToolJit: true,
    }),
  });
  assert.equal(fixture.counts().providerCalls, 0, 'the unchanged write was never sent');
  assert.equal(approvals.get(approval.approvalId)?.resolution, 'rejected');
  const resolved = eventlog.listEvents(fixture.session.id, { types: ['approval_resolved'] })
    .find((event) => event.data.approvalId === approval.approvalId);
  assert.equal(resolved?.data.changeRequested, true);
  const after = JSON.stringify(fixture.modelInputs.slice(inputsBefore));
  assert.match(after, /APPROVAL CHANGE/);
  assert.match(after, /make it shorter and mention Alana/);
});

test('two production task approvals in one session resume independently after reopen', async () => {
  const fixture = await directWriteFixture('work_call', 'opaque', 'two-paused-sources', false, 'args_json', 2, {
    operationId: 'TWO_SOURCE_APPROVAL_WRITE', schema: INPUT_SCHEMA, payloads: [ARGS, ARGS], deferredAcrossSources: true,
  });
  assert.ok(fixture);
  const loop = await import('./loop.js');
  const { HarnessSession } = await import('./session.js');
  const { buildOrchestratorAgentForApprovalResume } = await import('../../agents/orchestrator.js');
  const pause = async (source: typeof fixture.source) => {
    await fixture.useProductionAgent(source);
    // Independently owned host work may park alongside another task (e.g. a
    // background workflow parent). Ordinary fresh-chat ingress still branches
    // or holds on an existing approval; do not bypass that policy in runTurn.
    const result = await fixture.run(undefined, {}, source);
    if (!result.hasInterruptions || !result.serializedState) throw new Error(`Expected pause: ${JSON.stringify(result.terminal)}`);
    HarnessSession.load(fixture.session.id)!.saveInterruptState(result.serializedState);
    // The source store is authoritative even if an old reader cleared only
    // the compatibility projection before restart/card recovery.
    eventlog.openEventLog().prepare(`UPDATE sessions SET metadata_json = json_remove(metadata_json,
      '$.__interrupt_state', '$.__interrupt_mcp_scope') WHERE id = ?`).run(fixture.session.id);
    assert.ok(HarnessSession.load(fixture.session.id)!.loadInterruptState());
    const recovered = loop.recoverParkedApprovalSurfaces();
    assert.equal(recovered.failed, 0);
  };
  await pause(fixture.source);
  const first = approvals.listPending({ sessionId: fixture.session.id, status: 'pending' })[0]!;
  const secondSource = eventlog.appendEvent({ sessionId: fixture.session.id, turn: 2, role: 'user',
    type: 'user_input_received', data: { text: fixture.prompt } });
  await pause(secondSource);
  const second = approvals.listPending({ sessionId: fixture.session.id, status: 'pending' })
    .find(row => row.approvalId !== first.approvalId)!;
  assert.ok(second, 'each task has its own addressable card, despite identical business arguments');
  assert.equal(fixture.counts().providerCalls, 0);
  eventlog.closeEventLog();
  const resume = (approvalId: string) => loop.runConversationFromResume({ sessionId: fixture.session.id,
    approvalId, decision: 'approve', resolver: 'two-task-fixture', turnEngine: 'host_v1',
    makeRunner: () => fixture.runner as never, maxTurns: 3,
    judgeFn: async () => ({ done: true, reason: 'fixture operation completed' }),
    buildAgent: identity => buildOrchestratorAgentForApprovalResume({ sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq, acceptedRoute: identity.route,
      hostFreshPlanning: identity.hostFreshPlanning, model: fixture.model as never, allowToolJit: true }),
  });
  const firstResult = await resume(first.approvalId);
  if (firstResult.status !== 'completed') throw new Error(`First resume failed: ${JSON.stringify(firstResult)}`);
  assert.equal(fixture.counts().providerCalls, 1);
  assert.equal(approvals.get(second.approvalId)?.status, 'pending');
  assert.ok(HarnessSession.load(fixture.session.id)!.loadInterruptState(secondSource.seq));
  eventlog.closeEventLog();
  const secondResult = await resume(second.approvalId);
  if (secondResult.status !== 'completed') throw new Error(`Second resume failed: ${JSON.stringify(secondResult)}`);
  assert.equal(fixture.counts().providerCalls, 2);
  const settlements = eventlog.openEventLog().prepare(`SELECT source_user_seq FROM logical_call_settlements
    WHERE session_id = ? AND mutating = 1 AND outcome_kind = 'succeeded' ORDER BY source_user_seq`)
    .all(fixture.session.id) as Array<{ source_user_seq: number }>;
  assert.deepEqual(settlements.map(row => row.source_user_seq), [fixture.source.seq, secondSource.seq]);
  const modelsBeforeReplay = fixture.counts().modelCalls;
  await resume(first.approvalId);
  await resume(second.approvalId);
  assert.equal(fixture.counts().modelCalls, modelsBeforeReplay, 'repeat decisions need no model work');
  assert.equal(fixture.counts().providerCalls, 2, 'repeat decisions do not duplicate either task write');
  assert.equal(HarnessSession.load(fixture.session.id)!.loadInterruptState(), null);
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

// A generic API-request call the host could not prove read-only is booked as a
// write, but its response is data (live 2026-09-25: research POSTs through one
// such operation; file_query refused every result and the model paged raw text
// instead). The durable shape here is the one the live host wrote: a top-level
// write lifecycle and a result the lifecycle hook stored without a nonce.
const RESEARCH_SCHEMA = { type: 'object', properties: { method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] }, path: { type: 'string' }, data: { type: 'array', items: { type: 'object' } } }, required: ['method', 'path', 'data'], additionalProperties: false };
const RESEARCH_PAYLOAD = { method: 'POST', path: '/v1/query', data: [{ query: 'fixture research' }] };

test('a settled write-classified result opens in file_query through the real host turn', async () => {
  const needle = 'fixture keyword ranked thirty seventh';
  const fixture = await directWriteFixture('work_call', 'bounded', 'query-write-result', false, 'args_json', 1, {
    operationId: 'research_request', schema: RESEARCH_SCHEMA, payloads: [RESEARCH_PAYLOAD],
    result: { status_code: 20000, items: [{ keyword: needle, search_volume: 49500, position: 37 }] },
  });
  assert.ok(fixture);
  const { runConversation } = await import('./loop.js');
  const agent = await fixture.useProductionAgent();
  const done = await runConversation({ agent, sessionId: fixture.session.id, input: fixture.prompt,
    sourceUserSeq: fixture.source.seq, reuseRecordedUserInput: true,
    suppressMemoryCapture: true, judgeCompletion: false, turnEngine: 'host_v1', makeRunner: () => fixture.runner as never });
  assert.equal(fixture.counts().providerCalls, 1, JSON.stringify(done));
  const called = eventlog.listEvents(fixture.session.id, { types: ['tool_called'] })
    .find((event) => event.data.callId === 'exact-draft' && event.data.accounting === 'top_level');
  assert.equal(called?.data.effect, 'external_write', 'the call is booked as a write');
  const db = eventlog.openEventLog();
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tool_output_invocations WHERE session_id = ? AND call_id = ?')
    .get(fixture.session.id, 'exact-draft') as { n: number }).n, 0, 'the host stored this result without a nonce, as live');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tool_outputs WHERE session_id = ? AND call_id = ?')
    .get(fixture.session.id, 'exact-draft') as { n: number }).n, 1);

  const { registerFileQueryTools } = await import('../../tools/file-query-tools.js');
  const { withToolOutputContext } = await import('./tool-output-context.js');
  let handler: ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) | undefined;
  registerFileQueryTools({ tool: (_name: string, _description: string, _shape: unknown, h: typeof handler) => { handler = h; } } as never);
  assert.ok(handler);
  const result = await withToolOutputContext({ sessionId: fixture.session.id }, () =>
    handler!({ query: needle, call_id: 'exact-draft' }));
  const text = result.content[0]!.text;
  assert.notEqual(result.isError, true, text);
  const parsed = JSON.parse(text) as { source: string; hits: Array<{ text: string }> };
  assert.equal(parsed.source, 'tool output exact-draft');
  assert.ok(parsed.hits.some((hit) => hit.text.includes(needle)), text);
});

// One effect label (live 2026-09-25): a send approved on a card that said
// irreversible was recorded irreversible=false, because the ledger asked the
// shape classifier, which reads only a materialized manifest's semantics, and
// that manifest declared none. The ledger now records the consent's own risk.
test('an approved send is recorded with the reversibility and consequence its consent card stated', async () => {
  const fixture = await directWriteFixture('call_tool', 'send', 'one-effect-label');
  assert.ok(fixture);
  const paused = await fixture.run();
  assert.equal(paused.hasInterruptions, true);
  const { classifyExternalWrite } = await import('./confirm-first-gate.js');
  assert.equal(classifyExternalWrite(fixture.operationId, ARGS).irreversible, false,
    'precondition as live: with its manifest materialized, the shape classifier calls this send reversible');
  const interruption = paused.interruptions![0]!;
  assert.deepEqual((interruption as any).consentCall.risk,
    { consequence: 'send', reversibility: 'irreversible', destructive: false });
  const approval = approvals.registerResumable({ sessionId: fixture.session.id,
    subject: 'Send this exact message.', tool: interruption.toolName, args: interruption.args,
    resumeKey: interruption.approvalResumeKey! }).row;
  assert.equal(approvals.resolve(approval.approvalId, 'approved', 'direct-host-fixture').ok, true);
  eventlog.closeEventLog();
  const state = HostInterruptState.fromString(paused.serializedState!);
  state.approve(state.getInterruptions()[0]);
  const resumed = await fixture.run(state, { hostApprovalIds: [approval.approvalId] });
  assert.equal(fixture.counts().providerCalls, 1, JSON.stringify(resumed.history));
  const ledger = eventlog.listEvents(fixture.session.id, { types: ['external_write', 'external_write_succeeded'] });
  assert.deepEqual(ledger.map((event) => event.type), ['external_write', 'external_write_succeeded']);
  for (const event of ledger) {
    assert.equal(event.data.irreversible, true, `${event.type} states what the consent card stated`);
    assert.equal(event.data.reversibility, 'irreversible');
    assert.equal(event.data.consequence, 'send');
    assert.equal(event.data.destructive, false);
  }
  // The receipt both apps render reads the same classification off the public
  // bus: the shared ledger fold over the real public projection.
  const { projectHarnessEventsForPublic } = await import('./public-presentation.js');
  const engine = await import('../../../packages/chat-engine/src/index.js');
  const rows = [...engine.foldWriteLedger(projectHarnessEventsForPublic(ledger)).values()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.disposition, 'confirmed');
  assert.equal(rows[0]!.consequence, 'send');
  assert.equal(engine.writeReversibilityLabel(rows[0]!), "can't be undone", 'the receipt says what the card said');
  assert.equal(engine.outsideWorkCards(rows.map((write) => ({ write })))[0]?.kind, 'message_sent');
  // A named change still counts as one.
  const { composeRunProgressLine } = await import('./run-progress.js');
  assert.match(composeRunProgressLine({ sessionId: fixture.session.id, sourceUserSeq: fixture.source.seq, fallback: '' }),
    /1 write completed/);
});

// Only an affirmed change reads as a write (live 2026-09-25): research requests
// through a generic API-request operation are booked as writes because their
// carrier could not be proven read-only; the progress line said "5 writes
// completed" and the receipt counted them as changes. Their consent
// classification never named a change, so a clean return is a completed call.
test('a carrier-bounded call that returns cleanly reads as a call, never as a write or a change', async () => {
  const fixture = await directWriteFixture('work_call', 'bounded', 'call-not-change', false, 'args_json', 1, {
    operationId: 'research_request', schema: RESEARCH_SCHEMA, payloads: [RESEARCH_PAYLOAD],
  });
  assert.ok(fixture);
  const outcome = await fixture.run();
  assert.equal(Boolean(outcome.hasInterruptions), false);
  assert.equal(fixture.counts().providerCalls, 1, JSON.stringify(outcome.history));
  // Safety truth is unchanged: the call is still reserved and settled as a write.
  const ledger = eventlog.listEvents(fixture.session.id, { types: ['external_write', 'external_write_succeeded'] });
  assert.deepEqual(ledger.map((event) => event.type), ['external_write', 'external_write_succeeded']);
  assert.equal(ledger[1]!.data.consequence, 'unknown');

  const { composeRunProgressLine } = await import('./run-progress.js');
  const line = composeRunProgressLine({ sessionId: fixture.session.id, sourceUserSeq: fixture.source.seq, fallback: '' });
  assert.match(line, /1 call completed/, line);
  assert.doesNotMatch(line, /\d+ writes? completed/, line);

  const { projectHarnessEventsForPublic } = await import('./public-presentation.js');
  const engine = await import('../../../packages/chat-engine/src/index.js');
  const rows = [...engine.foldWriteLedger(projectHarnessEventsForPublic(ledger)).values()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.disposition, 'returned', 'a completed call, not a confirmed write');
  assert.deepEqual(engine.outsideWorkCards(rows.map((write) => ({ write }))), [], 'no card claims a change');
  assert.equal(engine.writeRowIsChange(rows[0]!), false, 'not listed under what changed');
  assert.equal(engine.writeRowTone(rows[0]!), 'muted');
});

// Recipients are separate people (live 2026-09-25): a send's recorded targets
// held the merged recipient string "A, B" as a third recipient beside A and B.
test('a send to a merged recipient list records each person once', async () => {
  const schema = { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'], additionalProperties: false };
  const payload = { to: 'Pat Doe <Pat@Example.test>, "Lee, Sam" <sam@example.test>', body: 'Validated message body.' };
  const fixture = await directWriteFixture('call_tool', 'send', 'merged-recipients', false, 'args_json', 1, {
    operationId: 'EXAMPLE_SEND_TEAM_MESSAGE', schema, payloads: [payload],
  });
  assert.ok(fixture);
  const paused = await fixture.run();
  assert.equal(paused.hasInterruptions, true);
  const interruption = paused.interruptions![0]!;
  const approval = approvals.registerResumable({ sessionId: fixture.session.id,
    subject: 'Send this exact message.', tool: interruption.toolName, args: interruption.args,
    resumeKey: interruption.approvalResumeKey! }).row;
  assert.equal(approvals.resolve(approval.approvalId, 'approved', 'direct-host-fixture').ok, true);
  eventlog.closeEventLog();
  const state = HostInterruptState.fromString(paused.serializedState!);
  state.approve(state.getInterruptions()[0]);
  const resumed = await fixture.run(state, { hostApprovalIds: [approval.approvalId] });
  assert.equal(fixture.counts().providerCalls, 1, JSON.stringify(resumed.history));
  const ledger = eventlog.listEvents(fixture.session.id, { types: ['external_write', 'external_write_succeeded'] });
  assert.equal(ledger.length, 2);
  for (const event of ledger) {
    assert.deepEqual(event.data.targets, ['pat@example.test', 'sam@example.test'], `${event.type} names two people`);
  }
  const { projectHarnessEventsForPublic } = await import('./public-presentation.js');
  const engine = await import('../../../packages/chat-engine/src/index.js');
  const rows = [...engine.foldWriteLedger(projectHarnessEventsForPublic(ledger)).values()];
  assert.equal(engine.outsideWorkCards(rows.map((write) => ({ write })))[0]?.subtitle,
    'To pat@example.test, sam@example.test');
});

// Memory after the owner answers a card. The request's remembered fact is
// stored here, after every case above has run, so it reaches only these. The
// resumed activation is the same accepted request: it carries the memory a
// fresh activation of that request carries (the shared ranker's tail, or the
// per-block stand-in when the ranker gives no signal), on the approve path and
// on the change-request path alike.
const RESUME_FACT = 'Validated content for the connected owner account is filed under the heron archive label.';
for (const [decision, ranker] of [['approve', 'on'], ['approve', 'off'], ['change', 'on'], ['change', 'off']] as const) {
  test(`a resumed request (${decision}, ranker ${ranker}) carries the request's memory to the model`, async () => {
    const { rememberFact } = await import('../../memory/facts.js');
    const { listActiveFacts } = await import('../../memory/facts.js');
    if (!listActiveFacts({ limit: 50 }).some((fact) => fact.content === RESUME_FACT)) rememberFact({ kind: 'reference', content: RESUME_FACT });
    const previous = { primer: process.env.CLEMMY_UNIFIED_TURN_PRIMER, recall: process.env.CLEMMY_UNIFIED_RECALL, embeddings: process.env.EMBEDDINGS_DISABLED };
    process.env.CLEMMY_UNIFIED_TURN_PRIMER = ranker;
    process.env.CLEMMY_UNIFIED_RECALL = ranker;
    process.env.EMBEDDINGS_DISABLED = 'true';
    try {
      const fixture = await directWriteFixture('work_call', 'opaque', `resume-memory-${decision}-${ranker}`, false, 'args_json', 1, {
        operationId: `MEMORY_RESUME_WRITE_${decision === 'approve' ? 1 : 2}${ranker === 'on' ? 1 : 2}`, schema: INPUT_SCHEMA, payloads: [ARGS],
      });
      assert.ok(fixture);
      // Every request the brain receives, instructions and input alike.
      const sent: string[] = [];
      const answer = fixture.model.getResponse.bind(fixture.model);
      fixture.model.getResponse = async (request: any) => {
        sent.push([request.systemInstructions ?? '', JSON.stringify(request.input ?? [])].join('\n'));
        return answer(request);
      };
      const { runConversation, runConversationFromResume } = await import('./loop.js');
      const { buildOrchestratorAgentForApprovalResume } = await import('../../agents/orchestrator.js');
      const agent = await fixture.useProductionAgent();
      const paused = await runConversation({ agent, sessionId: fixture.session.id, input: fixture.prompt,
        sourceUserSeq: fixture.source.seq, reuseRecordedUserInput: true,
        suppressMemoryCapture: true, judgeCompletion: false, turnEngine: 'host_v1', makeRunner: () => fixture.runner as never });
      assert.equal(paused.status, 'awaiting_approval', JSON.stringify(paused));
      assert.match(sent.join('\n'), /heron archive label/, `the first activation carries the fact: ${JSON.stringify(eventlog.listEvents(fixture.session.id, { types: ['turn_memory_primer'] }).map((event) => event.data))}`);
      const approval = approvals.listPending({ sessionId: fixture.session.id, status: 'pending' })[0]!;
      assert.ok(approval);
      if (decision === 'approve') assert.equal(approvals.resolve(approval.approvalId, 'approved', 'resume-memory').ok, true);
      const before = sent.length;
      eventlog.closeEventLog();
      await runConversationFromResume({ sessionId: fixture.session.id,
        approvalId: approval.approvalId,
        ...(decision === 'approve'
          ? { decision: 'approve' as const }
          : { decision: 'reject' as const, changeRequest: 'make it shorter and mention the heron label' }),
        resolver: 'resume-memory', turnEngine: 'host_v1',
        makeRunner: () => fixture.runner as never, maxTurns: 3,
        judgeFn: async () => ({ done: true, reason: 'fixture reply' }),
        buildAgent: identity => buildOrchestratorAgentForApprovalResume({
          sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, acceptedRoute: identity.route,
          ...('hostFreshPlanning' in identity ? { hostFreshPlanning: identity.hostFreshPlanning as never } : {}),
          model: fixture.model as never, allowToolJit: true,
        }),
      });
      assert.equal(fixture.counts().providerCalls, decision === 'approve' ? 1 : 0);
      const resumed = sent.slice(before);
      assert.ok(resumed.length > 0, 'the resumed activation called the brain');
      assert.ok(resumed[0]!.includes(RESUME_FACT), `the resumed request carries the request's fact: ${resumed[0]!.slice(-3000)}`);
      assert.equal(resumed[0]!.split('[MEMORY PRIMER]').length - 1, 1, 'one memory tail rides the resumed request');
      const primer = eventlog.listEvents(fixture.session.id, { types: ['turn_memory_primer'] })
        .filter((event) => event.data.sourceUserSeq === fixture.source.seq).at(-1)?.data as Record<string, unknown> | undefined;
      assert.equal(primer?.injected, true, 'the resumed activation records the memory it sent');
      if (ranker === 'on') {
        assert.match(resumed[0]!, /## Relevant To This Request/, 'the shared ranker\'s tail rides the resumed request');
        assert.equal(primer?.source, 'unified');
      } else {
        assert.doesNotMatch(resumed[0]!, /## Relevant To This Request/, 'no ranked tail without a ranker');
        assert.match(resumed[0]!, /\[REMEMBERED FACTS/, 'the fallback memory stands in for a ranker with no signal');
      }
    } finally {
      for (const [key, value] of [['CLEMMY_UNIFIED_TURN_PRIMER', previous.primer], ['CLEMMY_UNIFIED_RECALL', previous.recall], ['EMBEDDINGS_DISABLED', previous.embeddings]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
}

// A later step of a resumed request continues the request the card belongs
// to, whichever source accepted the answer: the card's button (a control edge
// the runtime records) or a chat reply. It ranks memory by the parked
// request's text, never by the answer. Notes that share the host directive's
// words and not the request's are stored first, so memory ranked by anything
// else loses the request's fact. The later step here is the resume core
// re-asking for the reply the resumed step did not give.
// Regression: later steps were ranked by the accepting source; a button
// answer has no request text and a reply's text is not the request.
let laterStepLookalikesStored = false;
for (const answer of ['button', 'reply'] as const) {
  test(`a later step of a resume answered by ${answer} ranks its memory by the parked request`, async () => {
    const { rememberFact, listActiveFacts } = await import('../../memory/facts.js');
    const { judgeMemoryFor } = await import('../../memory/judge-memory.js');
    if (!listActiveFacts({ limit: 80 }).some((fact) => fact.content === RESUME_FACT)) rememberFact({ kind: 'reference', content: RESUME_FACT });
    if (!laterStepLookalikesStored) {
      laterStepLookalikesStored = true;
      for (let n = 1; n <= 12; n += 1) {
        rememberFact({ kind: 'project', importance: 5,
          content: `Visible answer ${n}: a completed turn that produced no reply for the user is answered again as plain text, stating the actual result and evidence (desk ${n}).` });
      }
    }
    const previous = { primer: process.env.CLEMMY_UNIFIED_TURN_PRIMER, recall: process.env.CLEMMY_UNIFIED_RECALL, embeddings: process.env.EMBEDDINGS_DISABLED };
    process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'on';
    process.env.CLEMMY_UNIFIED_RECALL = 'on';
    process.env.EMBEDDINGS_DISABLED = 'true';
    try {
      const fixture = await directWriteFixture('work_call', 'opaque', `resume-memory-later-step-${answer}`, false, 'args_json', 1, {
        operationId: `MEMORY_RESUME_LATER_STEP_${answer.toUpperCase()}`, schema: INPUT_SCHEMA, payloads: [ARGS],
      });
      assert.ok(fixture);
      const sent: string[] = [];
      let resumedCalls = -1;
      const respond = fixture.model.getResponse.bind(fixture.model);
      fixture.model.getResponse = async (request: any) => {
        sent.push([request.systemInstructions ?? '', JSON.stringify(request.input ?? [])].join('\n'));
        const response = await respond(request);
        if (resumedCalls < 0) return response;
        resumedCalls += 1;
        // The resumed step ends completed with no visible reply, so the resume
        // core re-asks in a later step of the same request.
        if (resumedCalls === 1) {
          return { ...response, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
            text: JSON.stringify({ summary: 'Resumed the approval.', reply: null, done: true, nextAction: 'completed', reason: null }) }] }] };
        }
        return response;
      };
      const { runConversation, runConversationFromResume } = await import('./loop.js');
      const { buildOrchestratorAgentForApprovalResume } = await import('../../agents/orchestrator.js');
      const agent = await fixture.useProductionAgent();
      const paused = await runConversation({ agent, sessionId: fixture.session.id, input: fixture.prompt,
        sourceUserSeq: fixture.source.seq, reuseRecordedUserInput: true,
        suppressMemoryCapture: true, judgeCompletion: false, turnEngine: 'host_v1', makeRunner: () => fixture.runner as never });
      assert.equal(paused.status, 'awaiting_approval', JSON.stringify(paused));
      const approval = approvals.listPending({ sessionId: fixture.session.id, status: 'pending' })[0]!;
      assert.ok(approval);
      // Answered in chat, the reply owns the approval and accepts it.
      const replySource = answer === 'reply'
        ? eventlog.appendEvent({ sessionId: fixture.session.id, turn: 2, role: 'user', type: 'user_input_received',
            data: { text: 'Yes, go ahead.', approvalId: approval.approvalId, decision: 'approve' } })
        : undefined;
      assert.equal(approvals.resolve(approval.approvalId, 'approved', `resume-memory-${answer}`).ok, true);
      const before = sent.length;
      resumedCalls = 0;
      eventlog.closeEventLog();
      const result = await runConversationFromResume({ sessionId: fixture.session.id,
        approvalId: approval.approvalId, decision: 'approve', resolver: `resume-memory-${answer}`, turnEngine: 'host_v1',
        ...(replySource ? { sourceUserSeq: replySource.seq } : {}),
        makeRunner: () => fixture.runner as never, maxTurns: 3,
        judgeFn: async () => ({ done: true, reason: 'fixture reply' }),
        buildAgent: identity => buildOrchestratorAgentForApprovalResume({
          sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, acceptedRoute: identity.route,
          ...('hostFreshPlanning' in identity ? { hostFreshPlanning: identity.hostFreshPlanning as never } : {}),
          model: fixture.model as never, allowToolJit: true,
        }),
      });
      assert.equal(fixture.counts().providerCalls, 1, JSON.stringify(result));
      const reasks = eventlog.listEvents(fixture.session.id, { types: ['guardrail_tripped'] })
        .filter((event) => event.data.kind === 'completed_without_reply' && event.data.path === 'resume');
      assert.equal(reasks.length, 1, `the resume core re-asked in a later step: ${JSON.stringify(result)}`);
      const accepting = eventlog.listEvents(fixture.session.id, { types: ['user_input_received'] }).at(-1)!;
      assert.notEqual(accepting.seq, fixture.source.seq, 'the answer is accepted by a source other than the parked request');
      const { completionEvidenceSource } = await import('./recovery-activation.js');
      assert.deepEqual(completionEvidenceSource({ sessionId: fixture.session.id, sourceUserSeq: accepting.seq }),
        { sessionId: fixture.session.id, sourceUserSeq: fixture.source.seq }, 'real resume journals the reviewed execution source');
      assert.equal((accepting.data as { synthetic?: unknown }).synthetic === true, answer === 'button',
        'a button answer is accepted by the runtime\'s control edge; a reply by the owner\'s own words');
      // Both paths must reach a second model frame, not merely record memory
      // before a provenance refusal. The write already settled once.
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.ok(judgeMemoryFor(fixture.session.id).includes(RESUME_FACT));
      const resumed = sent.slice(before);
      assert.equal(resumed.length, 2, 'the resumed step and the re-ask reached the brain');
      assert.ok(resumed[1]!.includes(RESUME_FACT));
      assert.equal(fixture.counts().providerCalls, 1, 'continuation never replays the approved write');
      const completed = eventlog.listEvents(fixture.session.id, { types: ['conversation_completed'] })
        .filter(event => event.data.sourceUserSeq === accepting.seq);
      assert.equal(completed.length, 1, 'one terminal settles the accepted approval answer');
      const replay = await runConversationFromResume({ agent, sessionId: fixture.session.id,
        sourceUserSeq: accepting.seq, approvalId: approval.approvalId, decision: 'approve',
        resolver: `resume-memory-${answer}`, turnEngine: 'host_v1', makeRunner: () => fixture.runner as never });
      assert.equal(replay.status, 'completed', JSON.stringify(replay));
      assert.equal(sent.length, before + 2, 'a replayed answer needs no additional brain call');
      assert.equal(fixture.counts().providerCalls, 1, 'a replayed answer cannot repeat the effect');
      const later = eventlog.listEvents(fixture.session.id, { types: ['turn_memory_primer'] }).at(-1)!.data as Record<string, unknown>;
      assert.equal(later.sourceUserSeq, fixture.source.seq, 'the later frame belongs to the original business request');
      assert.ok(String(later.queryPreview).startsWith(fixture.prompt.slice(0, 60)),
        `the later step ranks memory by the parked request: ${JSON.stringify(later)}`);
    } finally {
      for (const [key, value] of [['CLEMMY_UNIFIED_TURN_PRIMER', previous.primer], ['CLEMMY_UNIFIED_RECALL', previous.recall], ['EMBEDDINGS_DISABLED', previous.embeddings]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
}

// The chat dock answers a card with a change in the owner's own words: the
// reply owns the approval and the resume agent is built with the reply as its
// focus. The prompt's per-block memory ranked the resumed request by that
// reply; the shared ranker must see it too, together with the parked request,
// or memory that fits the change never reaches the model. Notes that share
// the parked request's words are stored first, so memory ranked by the parked
// request alone shows them instead. Regression: the resumed request's ranked
// memory searched with the parked request's text only.
const CHANGE_FACT = 'The Pemberton finance alias for board memos is pemberton-fin@example.test and it wants the subject prefixed BOARD.';
test('a change answered in chat carries the memory that fits the change to the resumed request', async () => {
  const { rememberFact } = await import('../../memory/facts.js');
  for (let n = 1; n <= 14; n += 1) {
    rememberFact({ kind: 'reference', importance: 5,
      content: `Exact operation ${n} on the connected owner account performs validated content checks for batch ${n}.` });
  }
  rememberFact({ kind: 'reference', content: CHANGE_FACT });
  const previous = { primer: process.env.CLEMMY_UNIFIED_TURN_PRIMER, recall: process.env.CLEMMY_UNIFIED_RECALL, embeddings: process.env.EMBEDDINGS_DISABLED };
  process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'on';
  process.env.CLEMMY_UNIFIED_RECALL = 'on';
  process.env.EMBEDDINGS_DISABLED = 'true';
  try {
    const fixture = await directWriteFixture('work_call', 'opaque', 'resume-memory-chat-change', false, 'args_json', 1, {
      operationId: 'MEMORY_RESUME_CHAT_CHANGE', schema: INPUT_SCHEMA, payloads: [ARGS],
    });
    assert.ok(fixture);
    const sent: string[] = [];
    const respond = fixture.model.getResponse.bind(fixture.model);
    fixture.model.getResponse = async (request: any) => {
      sent.push([request.systemInstructions ?? '', JSON.stringify(request.input ?? [])].join('\n'));
      return respond(request);
    };
    const { runConversation, runConversationFromResume } = await import('./loop.js');
    const { buildOrchestratorAgentForApprovalResume } = await import('../../agents/orchestrator.js');
    const agent = await fixture.useProductionAgent();
    const paused = await runConversation({ agent, sessionId: fixture.session.id, input: fixture.prompt,
      sourceUserSeq: fixture.source.seq, reuseRecordedUserInput: true,
      suppressMemoryCapture: true, judgeCompletion: false, turnEngine: 'host_v1', makeRunner: () => fixture.runner as never });
    assert.equal(paused.status, 'awaiting_approval', JSON.stringify(paused));
    const approval = approvals.listPending({ sessionId: fixture.session.id, status: 'pending' })[0]!;
    assert.ok(approval);
    const reply = 'No, address it to the Pemberton finance alias for board memos instead.';
    const replySource = eventlog.appendEvent({ sessionId: fixture.session.id, turn: 2, role: 'user', type: 'user_input_received',
      data: { text: reply, approvalId: approval.approvalId, decision: 'reject' } });
    assert.equal(approvals.resolve(approval.approvalId, 'rejected', 'chat-dock-change').ok, true);
    const before = sent.length;
    eventlog.closeEventLog();
    await runConversationFromResume({ sessionId: fixture.session.id,
      approvalId: approval.approvalId, sourceUserSeq: replySource.seq,
      decision: 'reject', changeRequest: reply,
      resolver: 'chat-dock-change', turnEngine: 'host_v1',
      makeRunner: () => fixture.runner as never, maxTurns: 3,
      judgeFn: async () => ({ done: true, reason: 'fixture reply' }),
      // The chat dock builds the resume agent with the reply as its focus.
      buildAgent: identity => buildOrchestratorAgentForApprovalResume({
        userInput: reply,
        sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, acceptedRoute: identity.route,
        ...('hostFreshPlanning' in identity ? { hostFreshPlanning: identity.hostFreshPlanning as never } : {}),
        model: fixture.model as never, allowToolJit: true,
      }),
    });
    assert.equal(fixture.counts().providerCalls, 0, 'the rejected write was never sent');
    const resumed = sent.slice(before);
    assert.ok(resumed.length > 0, 'the resumed request reached the brain');
    assert.ok(resumed[0]!.includes('pemberton-fin@example.test'), 'the memory that fits the change reaches the resumed request');
    const primer = eventlog.listEvents(fixture.session.id, { types: ['turn_memory_primer'] })
      .filter((event) => event.data.sourceUserSeq === fixture.source.seq).at(-1)?.data as Record<string, unknown> | undefined;
    assert.equal(primer?.source, 'unified', 'the shared ranker ran for the resumed request');
    const query = String(primer?.queryPreview ?? '');
    assert.ok(query.startsWith(reply), `the owner's answer leads the ranking: ${query}`);
    assert.ok(query.includes(fixture.prompt.slice(0, 40)), `the parked request is ranked by too: ${query}`);
  } finally {
    for (const [key, value] of [['CLEMMY_UNIFIED_TURN_PRIMER', previous.primer], ['CLEMMY_UNIFIED_RECALL', previous.recall], ['EMBEDDINGS_DISABLED', previous.embeddings]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

// A real approval is spent before a settled result is checkpointed. A local
// storage failure here must recover privately; asking again or replaying the
// send would violate the same consent and exact-once contracts.
async function approvedCheckpointFixture(stopTarget?: 'control' | 'business') {
  const phase = process.env.CLEM_APPROVED_CHECKPOINT_FIXTURE_PHASE;
  const handoffPath = path.join(TEST_HOME, 'checkpoint-handoff.json');
  const saved = phase === 'recover' || phase === 'replay' ? JSON.parse(readFileSync(handoffPath, 'utf8')) as {
    sourceUserSeq: number; acceptingSeq: number; approvalId: string;
  } : undefined;
  const fixture = await directWriteFixture('work_call', 'opaque', `approved-checkpoint-timer${stopTarget ? `-${stopTarget}` : ''}`, false, 'args_json', 1, {
    operationId: `APPROVED_CHECKPOINT_FIXTURE${stopTarget ? `_${stopTarget.toUpperCase()}` : ''}`, schema: INPUT_SCHEMA, payloads: [ARGS], existingSourceSeq: saved?.sourceUserSeq,
  });
  assert.ok(fixture);
  const { runConversation, runConversationFromResume } = await import('./loop.js');
  const { HarnessSession } = await import('./session.js');
  const { buildOrchestratorAgentForApprovalResume } = await import('../../agents/orchestrator.js');
  const { captureFreshSourceSessionContext, readSourceSessionContext } = await import('./source-session-context.js');
  if (!saved) captureFreshSourceSessionContext({ sessionId: fixture.session.id, sourceUserSeq: fixture.source.seq });
  else assert.ok(readSourceSessionContext({ sessionId: fixture.session.id, sourceUserSeq: saved.sourceUserSeq }));
  const agent = await fixture.useProductionAgent();
  if (saved) {
    const original = fixture.model.getResponse.bind(fixture.model);
    fixture.model.getResponse = async (request: any) => ({ ...await original(request),
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The approved action completed once.' }] }],
    });
    // Drive the public bridge after process exit, not just the loop. The
    // bridge sees the approval answer while the executor restores the source
    // that owned the write. Both must use one original composition scope.
    const { respondPreferHarness, _setBridgeImplsForTests } = await import('./respond-bridge.js');
    const { currentSourceSessionContext } = await import('./source-session-context-scope.js');
    const continueSaved = async () => {
      let outcome: Awaited<ReturnType<typeof runConversation>> | undefined;
      _setBridgeImplsForTests({
        configure: async () => ({ ok: true }),
        buildAgent: async options => buildOrchestratorAgentForApprovalResume({ ...options,
          model: fixture.model as never, allowToolJit: true }),
        runConversation: async options => {
          if (phase === 'recover') assert.equal(currentSourceSessionContext(fixture.session.id)?.sourceUserSeq, saved.sourceUserSeq);
          outcome = await runConversation({ ...options, makeRunner: () => fixture.runner as never,
            judgeFn: async () => ({ done: true, reason: 'fixture exact settled result' }) });
          return outcome;
        },
      });
      try {
        const control = eventlog.listEvents(fixture.session.id, { types: ['user_input_received'] }).find(event => event.seq === saved.acceptingSeq)!;
        const response = await respondPreferHarness('webhook', { sessionId: fixture.session.id,
          sourceUserSeq: saved.acceptingSeq, message: String(control.data.text),
          displayMessage: String(control.data.displayText ?? control.data.text) }, async () => { throw new Error('legacy responder cannot run'); });
        if (phase === 'recover') assert.ok(outcome, JSON.stringify(response));
        else assert.equal(outcome, undefined, 'a completed transport replay does not re-enter the executor');
        assert.equal(response.stoppedReason, 'success', JSON.stringify(response));
        return response;
      } finally { _setBridgeImplsForTests({}); }
    };
    if (phase === 'recover') {
      const { recoverInterruptedChatRuns } = await import('./restart-recovery.js');
      let settle!: (value: Awaited<ReturnType<typeof continueSaved>>) => void;
      let reject!: (reason: unknown) => void;
      const finished = new Promise<Awaited<ReturnType<typeof continueSaved>>>((resolve, fail) => { settle = resolve; reject = fail; });
      let dispatches = 0;
      const summary = recoverInterruptedChatRuns(Date.now, async dispatch => {
        assert.equal(dispatch.sourceUserSeq, saved.acceptingSeq, 'boot dispatch owns the approval answer');
        dispatches += 1;
        try { settle(await continueSaved()); } catch (error) { reject(error); throw error; }
      });
      assert.equal(summary.records.find(row => row.sessionId === fixture.session.id)?.autoResumed, true, JSON.stringify(summary));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([finished, new Promise<never>((_, fail) => {
        timeout = setTimeout(() => fail(new Error('approved checkpoint boot recovery timed out')), 15_000);
      })]).finally(() => { if (timeout) clearTimeout(timeout); });
      assert.equal(result.stoppedReason, 'success', JSON.stringify(result));
      assert.equal(dispatches, 1);
      assert.equal(fixture.counts().modelCalls, 1);
      const frame = fixture.modelInputs[0] as Array<{ type?: string; callId?: string }>;
      assert.equal(frame.filter(item => item.type === 'function_call_result' && item.callId === 'exact-draft').length, 1);
    } else {
      const result = await continueSaved();
      assert.equal(result.stoppedReason, 'success', JSON.stringify(result));
      assert.equal(fixture.counts().modelCalls, 0, 'a second process reopening the completed source performs no model work');
    }
    assert.equal(fixture.counts().providerCalls, 0, 'a fresh process must never cross the settled provider again');
    assert.equal(eventlog.listEvents(fixture.session.id, { types: ['conversation_completed'] })
      .filter(event => event.data.sourceUserSeq === saved.acceptingSeq).length, 1);
    assert.equal(HarnessSession.load(fixture.session.id)?.loadRecoveryState(), null);
    writeFileSync(path.join(TEST_HOME, `checkpoint-${phase}.json`), JSON.stringify({ ok: true, ...fixture.counts() }));
    return;
  }
  const paused = await runConversation({ agent, sessionId: fixture.session.id, input: fixture.prompt,
    sourceUserSeq: fixture.source.seq, reuseRecordedUserInput: true,
    suppressMemoryCapture: true, judgeCompletion: false, turnEngine: 'host_v1', makeRunner: () => fixture.runner as never });
  assert.equal(paused.status, 'awaiting_approval', JSON.stringify(paused));
  assert.equal(fixture.counts().providerCalls, 0);
  const approval = approvals.listPending({ sessionId: fixture.session.id, status: 'pending' })[0]!;
  assert.ok(approval);
  assert.equal(approvals.resolve(approval.approvalId, 'approved', 'checkpoint-timer-fixture').ok, true);
  const db = eventlog.openEventLog();
  db.exec(`CREATE TEMP TRIGGER reject_approved_result_checkpoint
    BEFORE INSERT ON logical_model_result_projection_receipts
    WHEN NEW.session_id = '${fixture.session.id}' AND NEW.call_id = 'exact-draft'
    BEGIN SELECT RAISE(ABORT, 'fixture approved result checkpoint unavailable'); END`);
  let result: Awaited<ReturnType<typeof runConversationFromResume>>;
  try {
    result = await runConversationFromResume({ sessionId: fixture.session.id,
      approvalId: approval.approvalId, decision: 'approve', resolver: 'checkpoint-timer-fixture', turnEngine: 'host_v1',
      makeRunner: () => fixture.runner as never, maxTurns: 3,
      judgeFn: async () => ({ done: true, reason: 'fixture exact settled result' }),
      buildAgent: identity => buildOrchestratorAgentForApprovalResume({
        sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, acceptedRoute: identity.route,
        ...('hostFreshPlanning' in identity ? { hostFreshPlanning: identity.hostFreshPlanning as never } : {}),
        model: fixture.model as never, allowToolJit: true,
      }),
    });
  } finally {
    if (phase !== 'prepare') db.exec('DROP TRIGGER IF EXISTS reject_approved_result_checkpoint');
  }
  assert.equal(result.status, 'held', JSON.stringify(result));
  assert.equal(fixture.counts().providerCalls, 1, 'the approved physical effect already landed');
  const heldCalls = fixture.counts().modelCalls;
  const accepting = eventlog.listEvents(fixture.session.id, { types: ['user_input_received'] }).at(-1)!;
  assert.notEqual(accepting.seq, fixture.source.seq);
  assert.ok(HarnessSession.load(fixture.session.id)?.loadRecoveryState(), JSON.stringify(eventlog.listEvents(fixture.session.id, { types: ['restart_recovery_decision'] }).map(event => event.data)));
  if (phase === 'prepare') {
    // Production transport owns a durable attempt for the approval answer.
    // The direct loop fixture above has no transport, so supply that receipt
    // before exercising the public bridge's exact-identity restart check.
    const deliveryAttempt = eventlog.beginRunAttempt(fixture.session.id, { runId: 'fixture-approved-control' });
    eventlog.recordRunAttemptUserInput(deliveryAttempt, { turn: accepting.turn, role: 'user', data: accepting.data },
      { existingEventSeq: accepting.seq, armRunInFlight: true });
    writeFileSync(handoffPath, JSON.stringify({ sourceUserSeq: fixture.source.seq,
      acceptingSeq: accepting.seq, approvalId: approval.approvalId, ...fixture.counts() }));
    // Simulate a process death while the storage fault is still present. The
    // next process receives only durable rows; no timer or closure survives.
    process.exit(0);
  }
  if (stopTarget) {
    const stoppedSeq = stopTarget === 'control' ? accepting.seq : fixture.source.seq;
    const stopAttempt = eventlog.beginRunAttempt(fixture.session.id, { runId: `checkpoint-stop-${stopTarget}` });
    eventlog.bindRunAttemptSourceUserEvent(stopAttempt, stoppedSeq);
    eventlog.requestKill(fixture.session.id, 'Stop this recovery only.', stopAttempt);
    const stopped = await runConversationFromResume({ agent, sessionId: fixture.session.id,
      sourceUserSeq: accepting.seq, approvalId: approval.approvalId, decision: 'approve',
      resolver: 'checkpoint-timer-fixture', turnEngine: 'host_v1', makeRunner: () => fixture.runner as never,
      judgeFn: async () => ({ done: true, reason: 'fixture exact settled result' }) });
    assert.equal(stopped.status, 'killed', JSON.stringify(stopped));
    assert.equal(fixture.counts().providerCalls, 1, 'stopping recovery cannot repeat the landed effect');
    assert.equal(fixture.counts().modelCalls, heldCalls, 'stopped recovery must not start another model frame');
    assert.equal(eventlog.isKillRequested(fixture.session.id, { sourceUserSeq: stoppedSeq }), false);
    return;
  }
  // Hold the timer's answer in flight while a second entry asks to recover
  // the same approval. Both entries must share one accepted-source activation.
  const originalAnswer = fixture.model.getResponse.bind(fixture.model);
  let answerStarted!: () => void;
  let releaseAnswer!: () => void;
  const started = new Promise<void>(resolve => { answerStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseAnswer = resolve; });
  fixture.model.getResponse = async (request: any) => {
    const response = await originalAnswer(request);
    answerStarted();
    await release;
    return response;
  };
  let startTimeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([started, new Promise<never>((_, reject) => {
    startTimeout = setTimeout(() => reject(new Error('timer answer did not start')), 15_000);
  })]).finally(() => { if (startTimeout) clearTimeout(startTimeout); });
  const joined = runConversationFromResume({ agent, sessionId: fixture.session.id,
    sourceUserSeq: accepting.seq, approvalId: approval.approvalId, decision: 'approve',
    resolver: 'checkpoint-timer-fixture', turnEngine: 'host_v1', makeRunner: () => fixture.runner as never,
    judgeFn: async () => ({ done: true, reason: 'fixture exact settled result' }) });
  let joinedSettled = false;
  void joined.then(() => { joinedSettled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  const deliveredBeforeAnswer = joinedSettled;
  releaseAnswer();
  assert.equal((await joined).status, 'completed');
  assert.equal(deliveredBeforeAnswer, false, 'a second recovery entry must wait for the actual answer, not publish empty completion');
  const deadline = Date.now() + 15_000;
  const terminals = () => eventlog.listEvents(fixture.session.id, { types: ['conversation_completed'] })
    .filter(event => event.data.sourceUserSeq === accepting.seq);
  while (Date.now() < deadline && terminals().length === 0) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(terminals().length, 1, JSON.stringify(eventlog.listEvents(fixture.session.id).slice(-12)));
  assert.equal(HarnessSession.load(fixture.session.id)?.loadRecoveryState(), null);
  assert.equal(fixture.counts().providerCalls, 1, 'recovery must adopt the settled effect');
  assert.equal(fixture.counts().modelCalls, heldCalls + 1, 'only the post-result answer calls the model');
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['approval_requested'] }).length, 1,
    'storage recovery cannot ask the user to approve the same effect again');
  const replay = await runConversationFromResume({ agent, sessionId: fixture.session.id,
    sourceUserSeq: accepting.seq, approvalId: approval.approvalId, decision: 'approve',
    resolver: 'checkpoint-timer-fixture', turnEngine: 'host_v1', makeRunner: () => fixture.runner as never });
  assert.equal(replay.status, 'completed', JSON.stringify(replay));
  assert.equal(fixture.counts().providerCalls, 1);
  assert.equal(fixture.counts().modelCalls, heldCalls + 1);
}

test('an approved write held on checkpoint storage resumes by timer without repeating the effect', () => approvedCheckpointFixture());
for (const target of ['control', 'business'] as const) {
  test(`approved checkpoint recovery honors a stop on its ${target} source`, () => approvedCheckpointFixture(target));
}

test('approved checkpoint recovery survives real process exit and a second reopen', async () => {
  const home = path.join(TEST_HOME, 'approved-checkpoint-process');
  mkdirSync(home, { recursive: true });
  for (const phase of ['prepare', 'recover', 'replay']) {
    await new Promise<void>((resolve, reject) => {
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, ['--import', 'tsx', '--test',
        '--test-name-pattern=approved write held on checkpoint storage', fileURLToPath(import.meta.url)], {
        env: { ...childEnv, CLEM_APPROVED_CHECKPOINT_FIXTURE_HOME: home,
          CLEM_APPROVED_CHECKPOINT_FIXTURE_PHASE: phase }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 30_000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', code => { clearTimeout(timeout); writeFileSync(path.join(home, `child-${phase}.log`), output); code === 0 ? resolve() : reject(new Error(`${phase} exited ${code}: ${output}`)); });
    });
  }
  const prepared = JSON.parse(readFileSync(path.join(home, 'checkpoint-handoff.json'), 'utf8'));
  const recovered = JSON.parse(readFileSync(path.join(home, 'checkpoint-recover.json'), 'utf8'));
  const replayed = JSON.parse(readFileSync(path.join(home, 'checkpoint-replay.json'), 'utf8'));
  assert.equal(prepared.providerCalls, 1);
  assert.equal(recovered.providerCalls + replayed.providerCalls, 0);
  assert.equal(recovered.modelCalls, 1);
  assert.equal(replayed.modelCalls, 0);
});

// A result checkpoint that can never be written must still end the turn. The
// timer that re-enters a held turn is the only owner left once the request
// has answered "held", so when the retry budget runs out it publishes the
// typed stop, which closes the run attempt in the same write.
test('a turn whose result checkpoint keeps failing ends with one public stop and a closed attempt', async () => {
  const fixture = await directWriteFixture('work_call', 'bounded', 'exhausted-checkpoint', false, 'args_json', 1, {
    operationId: 'research_request', schema: RESEARCH_SCHEMA, payloads: [RESEARCH_PAYLOAD],
  });
  assert.ok(fixture);
  const { runConversation } = await import('./loop.js');
  const { HarnessSession } = await import('./session.js');
  const agent = await fixture.useProductionAgent();
  const attempt = eventlog.beginRunAttempt(fixture.session.id, { runId: `exhausted-checkpoint-${fixture.source.seq}` });
  eventlog.recordRunAttemptUserInput(attempt, { turn: fixture.source.turn, role: 'user', data: fixture.source.data },
    { existingEventSeq: fixture.source.seq, armRunInFlight: true });
  const db = eventlog.openEventLog();
  db.exec(`CREATE TEMP TRIGGER reject_exhausted_result_checkpoint
    BEFORE INSERT ON logical_model_result_projection_receipts
    WHEN NEW.session_id = '${fixture.session.id}' AND NEW.call_id = 'exact-draft'
    BEGIN SELECT RAISE(ABORT, 'fixture result checkpoint unavailable'); END`);
  // The provider answered but its result could not be stored, so the call is
  // never settled as succeeded and stays open on its revoked lease.
  db.exec(`CREATE TEMP TRIGGER reject_exhausted_success_settlement
    BEFORE INSERT ON logical_call_settlements
    WHEN NEW.session_id = '${fixture.session.id}' AND NEW.logical_tool_call_id = 'exact-draft'
      AND NEW.outcome_kind = 'succeeded'
    BEGIN SELECT RAISE(ABORT, 'fixture result authority unavailable'); END`);
  const terminals = () => eventlog.listEvents(fixture.session.id, { types: ['conversation_completed'] })
    .filter(event => event.data.sourceUserSeq === fixture.source.seq);
  try {
    const first = await runConversation({ agent, sessionId: fixture.session.id, input: fixture.prompt,
      sourceUserSeq: fixture.source.seq, reuseRecordedUserInput: true, runAttemptId: attempt.attemptId,
      suppressMemoryCapture: true, judgeCompletion: false, turnEngine: 'host_v1', makeRunner: () => fixture.runner as never });
    assert.equal(first.status, 'held', JSON.stringify(first));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && terminals().length === 0) await new Promise(resolve => setTimeout(resolve, 50));
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_exhausted_result_checkpoint');
    db.exec('DROP TRIGGER IF EXISTS reject_exhausted_success_settlement');
  }
  const detail = () => JSON.stringify(eventlog.listEvents(fixture.session.id).slice(-16)
    .map(event => ({ type: event.type, data: JSON.stringify(event.data).slice(0, 240) })));
  assert.equal(terminals().length, 1, detail());
  const presentation = terminals()[0]!.data.presentation as { status?: string } | undefined;
  assert.equal(presentation?.status, 'blocked', detail());
  assert.equal(eventlog.getActiveRunAttempt(fixture.session.id), null, 'the stop closes the run attempt');
  assert.equal(HarnessSession.load(fixture.session.id)?.loadRecoveryState(), null);
  assert.equal(fixture.counts().providerCalls, 1, 'the landed call never repeats');
});

test('a chat request whose result checkpoint keeps failing ends with one public stop through the bridge', async () => {
  const fixture = await directWriteFixture('work_call', 'bounded', 'exhausted-checkpoint-bridge', false, 'args_json', 1, {
    operationId: 'research_request', schema: RESEARCH_SCHEMA, payloads: [RESEARCH_PAYLOAD],
  });
  assert.ok(fixture);
  await fixture.useProductionAgent();
  const { runConversationContinuingPastToolCallsLimit } = await import('./loop.js');
  const { HarnessSession } = await import('./session.js');
  const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
  const { respondPreferHarness, _setBridgeImplsForTests } = await import('./respond-bridge.js');
  const db = eventlog.openEventLog();
  db.exec(`CREATE TEMP TRIGGER reject_exhausted_bridge_checkpoint
    BEFORE INSERT ON logical_model_result_projection_receipts
    WHEN NEW.session_id = '${fixture.session.id}' AND NEW.call_id = 'exact-draft'
    BEGIN SELECT RAISE(ABORT, 'fixture result checkpoint unavailable'); END`);
  db.exec(`CREATE TEMP TRIGGER reject_exhausted_bridge_success_settlement
    BEFORE INSERT ON logical_call_settlements
    WHEN NEW.session_id = '${fixture.session.id}' AND NEW.logical_tool_call_id = 'exact-draft'
      AND NEW.outcome_kind = 'succeeded'
    BEGIN SELECT RAISE(ABORT, 'fixture result authority unavailable'); END`);
  _setBridgeImplsForTests({
    configure: async () => ({ ok: true }),
    buildAgent: async options => buildOrchestratorAgent({ ...options, model: fixture.model as never, allowToolJit: true }),
    runConversation: async options => runConversationContinuingPastToolCallsLimit({ ...options,
      makeRunner: () => fixture.runner as never }),
  });
  let closed = false;
  let sourceSeq = 0;
  const terminals = () => eventlog.listEvents(fixture.session.id, { types: ['conversation_completed'] })
    .filter(event => event.data.sourceUserSeq === sourceSeq);
  try {
    const response = await respondPreferHarness('home', { sessionId: fixture.session.id, message: fixture.prompt,
      channel: 'cli', userId: 'console', runId: 'exhausted-checkpoint-bridge-run', shouldCancel: () => closed },
    async () => { throw new Error('legacy responder cannot run'); });
    closed = true;
    sourceSeq = eventlog.listEvents(fixture.session.id, { types: ['user_input_received'] }).at(-1)!.seq;
    assert.equal(response.stoppedReason, 'in-progress', JSON.stringify(response));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && terminals().length === 0) await new Promise(resolve => setTimeout(resolve, 50));
  } finally {
    _setBridgeImplsForTests({});
    db.exec('DROP TRIGGER IF EXISTS reject_exhausted_bridge_checkpoint');
    db.exec('DROP TRIGGER IF EXISTS reject_exhausted_bridge_success_settlement');
  }
  const detail = () => JSON.stringify(eventlog.listEvents(fixture.session.id).slice(-16)
    .map(event => ({ type: event.type, data: JSON.stringify(event.data).slice(0, 240) })));
  assert.equal(terminals().length, 1, detail());
  assert.equal(eventlog.getActiveRunAttempt(fixture.session.id), null, 'the stop closes the run attempt');
  assert.equal(HarnessSession.load(fixture.session.id)?.loadRecoveryState(), null);
});

test('a held turn whose recovery cannot publish its stop is answered once the open call settles', async () => {
  const fixture = await directWriteFixture('work_call', 'bounded', 'unowned-stop', false, 'args_json', 1, {
    operationId: 'research_request', schema: RESEARCH_SCHEMA, payloads: [RESEARCH_PAYLOAD],
  });
  assert.ok(fixture);
  const { runConversation, HELD_TURN_UNOWNED_STOP_TEXT, drainPendingHeldStopPublications } = await import('./loop.js');
  const { reconcileRevokedHostToolInvocations } = await import('./host-tool-invocation.js');
  const agent = await fixture.useProductionAgent();
  const attempt = eventlog.beginRunAttempt(fixture.session.id, { runId: `unowned-stop-${fixture.source.seq}` });
  eventlog.recordRunAttemptUserInput(attempt, { turn: fixture.source.turn, role: 'user', data: fixture.source.data },
    { existingEventSeq: fixture.source.seq, armRunInFlight: true });
  const db = eventlog.openEventLog();
  db.exec(`CREATE TEMP TRIGGER reject_unowned_result_checkpoint
    BEFORE INSERT ON logical_model_result_projection_receipts
    WHEN NEW.session_id = '${fixture.session.id}' AND NEW.call_id = 'exact-draft'
    BEGIN SELECT RAISE(ABORT, 'fixture result checkpoint unavailable'); END`);
  // Every settlement is refused for a while, so the turn's own stop cannot
  // publish and the recovery timer is left holding a turn with no checkpoint.
  db.exec(`CREATE TEMP TRIGGER reject_unowned_settlement
    BEFORE INSERT ON logical_call_settlements
    WHEN NEW.session_id = '${fixture.session.id}' AND NEW.logical_tool_call_id = 'exact-draft'
    BEGIN SELECT RAISE(ABORT, 'fixture settlement unavailable'); END`);
  const terminals = () => eventlog.listEvents(fixture.session.id, { types: ['conversation_completed'] })
    .filter(event => event.data.sourceUserSeq === fixture.source.seq);
  const stoppedAtSite = () => eventlog.listEvents(fixture.session.id, { types: ['guardrail_tripped'] })
    .some(event => event.data.kind === 'host_blocked_terminal_site' && event.data.sourceUserSeq === fixture.source.seq);
  try {
    const first = await runConversation({ agent, sessionId: fixture.session.id, input: fixture.prompt,
      sourceUserSeq: fixture.source.seq, reuseRecordedUserInput: true, runAttemptId: attempt.attemptId,
      suppressMemoryCapture: true, judgeCompletion: false, turnEngine: 'host_v1', makeRunner: () => fixture.runner as never });
    assert.equal(first.status, 'held', JSON.stringify(first));
    const stopDeadline = Date.now() + 20_000;
    while (Date.now() < stopDeadline && !stoppedAtSite()) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(stoppedAtSite(), 'the retry budget ran out');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(terminals().length, 0, 'the stop waits while its call cannot settle');
    const pendingDebt = (eventlog.getSession(fixture.session.id)!.metadata[eventlog.HELD_STOP_PUBLICATION_METADATA_KEY] as Record<string, { attemptsUsed: number }>)[String(fixture.source.seq)];
    assert.equal(pendingDebt?.attemptsUsed, 0, 'known open-call waiting consumes no publication credit');
    db.exec('DROP TRIGGER IF EXISTS reject_unowned_settlement');
    // The real daemon's existing reaper owns structural settlement. The new
    // publication-only watcher must never do this sweep or execute the body.
    const reconciled = reconcileRevokedHostToolInvocations({ sessionId: fixture.session.id });
    assert.ok(reconciled.settled > 0);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && terminals().length === 0) {
      drainPendingHeldStopPublications();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_unowned_result_checkpoint');
    db.exec('DROP TRIGGER IF EXISTS reject_unowned_settlement');
  }
  assert.equal(terminals().length, 1);
  const presentation = terminals()[0]!.data.presentation as { status?: string; text?: string } | undefined;
  assert.equal(presentation?.status, 'blocked');
  assert.equal(presentation?.text, HELD_TURN_UNOWNED_STOP_TEXT);
  assert.equal(eventlog.getActiveRunAttempt(fixture.session.id), null, 'the stop closes the run attempt');
  assert.equal(fixture.counts().providerCalls, 1, 'the landed call never repeats');
});
