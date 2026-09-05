/** P3 same-step tool-edge journey. No provider/network calls: the real host,
 * consent reducer, dispatch lease, external settlement and result handle run
 * against a deterministic exact catalog port. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const { hostRunRunner, HostInterruptState } = await import('./host-turn-runner.js');
const approvals = await import('./approval-registry.js');
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

async function directWriteFixture(carrierName: 'call_tool' | 'work_call', kind: 'draft' | 'send' | 'delete' | 'admin' = 'draft', suffix = '', uncertain = false) {
  const operationId = { draft: 'EXAMPLE_CREATE_DRAFT', send: 'EXAMPLE_SEND_MESSAGE', delete: 'EXAMPLE_DELETE_RECORD', admin: 'EXAMPLE_ROTATE_API_KEY' }[kind];
  const capabilityId = `cap:resolved:${operationId.toLowerCase()}`;
  const accountId = 'account:direct:owner';
  const providerInputSchemaDigest = digestSchema(INPUT_SCHEMA);
  const definitionFingerprint = sha(`${operationId}:${providerInputSchemaDigest}`);
  schemas.rememberToolSchema(operationId, INPUT_SCHEMA, Date.now(), '1', { type: 'object' });
  const manifest = manifests.attachSemanticContract({
    version: 1, manifestId: capabilityId, providerKind: 'native_mcp', operationId,
    providerIdentity: 'native:direct-write-fixture', providerVersion: 'catalog-v1', operationVersion: '1', definitionFingerprint,
    externalDefinition: { version: 1, providerInputSchemaDigest, semanticName: operationId,
      behaviorHints: { readOnly: false, destructive: kind === 'delete', idempotent: null, openWorld: false } },
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
    assert.equal(modelCalls, 1, 'consent must dispatch before another model step');
    assert.deepEqual(request.payload, ARGS);
    assert.equal(request.binding.account, accountId);
    assert.ok(request.authority, 'the existing adapter receives the exact consent grant');
    if (uncertain) throw new Error('fixture transport outcome unknown after possible write');
    return { successful: true, data: { id: `draft-${carrierName}`, body: ARGS.body } };
  };
  ports.clearProductionCapabilityPorts();
  assert.equal(ports.registerFixtureCapabilityPort(ports.productionPortIdentityFromManifest(manifest), {
    invoke: invoke as never,
    admitPreparation: () => undefined,
    prepareInvocation: async () => { preparationCalls += 1; return { fixture: true }; },
    invokeWithPreparation: async (_proof: unknown, work: () => Promise<unknown>) => work(),
  }).ok, true);
  const entry = adapters.registeredCapabilityFromManifest({ manifest, observation, invoke: invoke as never });
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  const prompt = kind === 'draft'
    ? 'Create one reversible draft on my connected owner account from this validated content. Do not send anything.'
    : `Perform the exact ${kind} operation on my connected owner account from this validated content.`;
  const session = eventlog.createSession({ id: `p3-direct-write-${carrierName}-${kind}-${suffix}`, kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: prompt } });
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
        source_call_ids: null, source_record_ids: null, name: operationId, args_json: JSON.stringify(ARGS) }
    : { name: operationId, args_json: JSON.stringify(ARGS) };
  const model = {
    async getResponse(request: { tools?: Array<{ name?: string }> }) {
      modelCalls += 1;
      assert.ok(request.tools?.some((entry) => entry.name === carrierName));
      if (modelCalls === 1) {
        // Same shape as the tag canary: exact live capability is ready only
        // after the model request froze its empty catalog. Never make a plan.
        factory.register(entry);
      }
      return { responseId: `direct-write-${carrierName}-${modelCalls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: modelCalls === 1
          ? [{ type: 'function_call', callId: 'exact-draft', name: carrierName, arguments: JSON.stringify(outerArgs) }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The draft was created.' }] }],
      };
    }, getStreamedResponse: modelStream,
  };
  const agent = { model, tools: [carrier] };
  const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: [carrier], activeToolNames: [carrierName],
    policyHash: 'p3-direct-write', budget: { maxUncachedTokens: 10_000, maxModelCalls: 3, maxToolCalls: 3, maxElapsedMs: 60_000 } });
  assert.ok(sealed.ok);
  if (!sealed.ok) return;
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const runner = new EventEmitter();
  Object.assign(runner, { run() { throw new Error('legacy Runner must remain unreachable'); } });
  const run = (input: any = [{ type: 'message', role: 'user', content: prompt }], extra: Record<string, unknown> = {}) => brackets.withHarnessRunContext({ sessionId: session.id, sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(3), behaviorScopeId: `${session.id}::turn:1` },
  () => hostRunRunner(runner as never, agent as never, input,
    { maxTurns: 3, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq }, ...extra } as never));
  return { run, session, source, agent, runner, manifest, accountId, operationId, outerArgs, prompt,
    counts: () => ({ providerCalls, modelCalls, preparationCalls, carrierBodies }) };
}

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
