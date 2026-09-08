/** C5 regression: a real plan_task and three real host/provider adapter calls
 * must acknowledge exact provider results without inventing Graph receipt fields.
 * The provider port is deterministic and all durable state stays in a temp home. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-planned-draft-ack-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.COMPOSIO_BACKEND = 'sdk';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_WATCHER_JUDGE = 'off';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'planned-draft-ack-fixture\n');

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
const { buildPlanTaskTool } = await import('../../tools/plan-tools.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const preparation = await import('./accepted-task-terminal-preparation.js');
const expectedWork = await import('./expected-work-contract.js');
const { writeWorkflow } = await import('../../memory/workflow-store.js');
const { sealedNodeBindingDigestOf } = await import('./sealed-node-binding-digest.js');
const { verifyAcceptedTaskTerminalProofInTransaction } = await import('./terminal-publication-proof.js');
const { loadManifestState } = await import('./obligation-store.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const client = await import('../../integrations/composio/client.js');
const providerIdentity = await import('../../integrations/composio/provider-definition-identity.js');
const production = await import('./production-capability-adapters.js');
const transport = (await import('./composio-attested-transport.js')).buildComposioAttestedTransport();
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('planned draft fixture must never perform network I/O'); };

const PAYLOADS = [
  { subject: 'planned-draft-A', body: 'Redwood appointment follow-up.\nSecond line stays here.', is_html: false, to_recipients: [], cc_recipients: [], bcc_recipients: [] },
  { subject: 'planned-draft-B', body: 'Juniper proposal follow-up: ready for review?', is_html: false, to_recipients: [], cc_recipients: [], bcc_recipients: [] },
  { subject: 'planned-draft-C', body: 'Willow formatting check. Keep this exact punctuation!', is_html: false, to_recipients: [], cc_recipients: [], bcc_recipients: [] },
];
const OPERATION = 'OUTLOOK_CREATE_DRAFT';
const CAPABILITY = 'cap:resolved:outlook_create_draft';
const ACCOUNT = 'ca-planned-draft-owner';
const INVOKE_PORT = `port:${CAPABILITY}:${OPERATION}`;

after(() => {
  globalThis.fetch = originalFetch;
  production.installProductionTransport(null);
  schemas._setToolSchemaLoaderForTests(null);
  client.__test__.setConnectedAccountsLoader(null);
  client.__test__.setComposioApiKeyOverride(null);
  client.resetComposioClient();
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

async function plannedDraftFixture(suffix: string, evidence: string[] = ['tool_result'], c6Collision = false) {
  const schema = JSON.parse(readFileSync(new URL('../../tools/fixtures/outlook-create-draft-input-schema.json', import.meta.url), 'utf8'));
  schema.properties.attachment.anyOf[0].description = undefined;
  const providerInputSchemaDigest = digestSchema(schema);
  const definitionFingerprint = providerIdentity.fingerprintComposioProviderDefinition({ operationId: OPERATION, operationVersion: '1', accountId: ACCOUNT, invokePortId: INVOKE_PORT, inputSchema: schema, outputSchema: { type: 'object' } });
  assert.ok(definitionFingerprint);
  client.__test__.setComposioApiKeyOverride('planned-draft-fixture-key');
  client.__test__.setConnectedAccountsLoader(async () => [{ id: ACCOUNT, status: 'ACTIVE', user_id: 'fixture-owner', toolkit: { slug: 'outlook' }, account_email: 'owner@example.invalid' }]);
  await client.listConnectedToolkits({ requireFresh: true });
  schemas.rememberToolSchema(OPERATION, schema, Date.now(), '1', { type: 'object' });
  schemas._setToolSchemaLoaderForTests(async () => ({ inputParameters: schema, outputParameters: { type: 'object' }, providerObservedAt: Date.now(), providerOperationVersion: '1' }));
  production.installProductionTransport(call => transport.execute(call));
  const manifest = manifests.attachSemanticContract({
    version: 1, manifestId: CAPABILITY, providerKind: 'composio', operationId: OPERATION,
    providerIdentity: 'composio', providerVersion: providerIdentity.COMPOSIO_PROVIDER_SURFACE_VERSION, operationVersion: '1', definitionFingerprint,
    externalDefinition: { version: 1, providerInputSchemaDigest, providerOutputSchemaObserved: true, providerOutputSchemaDigest: digestSchema({ type: 'object' }), semanticName: OPERATION,
      behaviorHints: { readOnly: false, destructive: false, idempotent: null, openWorld: false } },
    effect: 'external_write', accountId: ACCOUNT,
    operationSemantics: { version: 1, reversibility: 'reversible' },
    destination: { family: 'outlook_draft', posture: 'create_new' },
    idempotency: { required: true, policy: 'key_before_dispatch' }, reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'result' }, purpose: 'Create a draft in the connected fixture owner mailbox.',
    acceptedInputKinds: ['evidence'], producedOutputKinds: ['evidence'], applicableDeliverableKinds: ['outlook_draft'],
    evidenceContract: { kinds: ['tool_result'], readbackRequired: false },
    provenance: { issuer: 'host:planned-draft:test', issuedAt: '2026-09-05T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' }, invokePortId: INVOKE_PORT, argumentCompiler: { id: 'host:json', version: '1' },
  });
  stores.installCapabilityManifestStore(stores.createCapabilityManifestStore([manifest], { durable: true }));
  const observation = { definitionFingerprint, providerVersion: manifest.providerVersion, operationVersion: '1', accountId: ACCOUNT, observedAt: Date.now() };
  assert.equal(observations.registerIndependentCapabilityObservation({ operationId: OPERATION, ...observation, origin: 'independent', observe: () => ({ operationId: OPERATION, ...observation }) }).ok, true);
  let modelCalls = 0;
  let providerCalls = 0;
  const providerResult = async (slug: string, body: Record<string, unknown>) => {
    const ordinal = providerCalls++;
    assert.equal(modelCalls, 2, 'all writes execute only after the first model frame admitted the plan');
    assert.equal(slug, OPERATION);
    assert.deepEqual(body.arguments, PAYLOADS[ordinal]);
    assert.equal(body.connected_account_id, ACCOUNT);
    assert.equal(body.version, '1');
    // Actual Graph/Composio output shape. There is no fabricated handle,
    // receipt, writtenDigest, or provider readback observation in this result.
    return { successful: true, error: null, logId: `fixture-provider-log-${ordinal + 1}`, data: {
      id: `fixture-draft-${ordinal + 1}`, subject: PAYLOADS[ordinal]!.subject,
      body: { content: PAYLOADS[ordinal]!.body, contentType: 'text' }, isDraft: true,
      toRecipients: [], ccRecipients: [], bccRecipients: [], parentFolderId: 'fixture-drafts-folder',
    } };
  };
  client.__test__.setComposioClient({
    getClient: () => ({ withOptions: (options: { maxRetries?: number }) => {
      assert.equal(options.maxRetries, 0);
      return { tools: { execute: providerResult } };
    } }),
    tools: { execute: async () => { throw new Error('legacy provider retry surface must not execute'); } },
  });
  const invoke = async () => { throw new Error('fixture adapter must dispatch through the exact Composio SDK one-shot'); };
  ports.clearProductionCapabilityPorts();
  assert.equal(ports.registerFixtureCapabilityPort(ports.productionPortIdentityFromManifest(manifest), {
    invoke: invoke as never, admitPreparation: () => undefined,
    prepareInvocation: async () => ({ fixture: true }),
    invokeWithPreparation: async (_proof: unknown, work: () => Promise<unknown>) => work(),
  }).ok, true);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  factory.register(adapters.registeredCapabilityFromManifest({ manifest, observation, invoke: invoke as never }));
  const basePrompt = 'Create exactly these three plain-text drafts in my connected owner mailbox, owner@example.invalid. Preserve the exact subjects and bodies, including punctuation and the line break; keep To, Cc, Bcc empty. Do not send any email. Plan the three creations, then report each returned draft ID.\n' + JSON.stringify(PAYLOADS);
  const session = eventlog.createSession({ id: `planned-draft-ack-${suffix}`, kind: 'chat' });
  const priorHistory: Array<Record<string, unknown>> = [];
  if (c6Collision) {
    // Synthetic reproduction of the catalog collision; no original owner names.
    const saved = JSON.parse(readFileSync(new URL('../../tools/fixtures/c6-saved-workflow-catalog.json', import.meta.url), 'utf8')) as Array<{ slug: string; name: string; enabled: boolean }>;
    assert.equal(saved.length, 29);
    assert.ok(saved.some(entry => entry.name === 'Outlook Sampleteam Inbox Read Canary'));
    for (const entry of saved) writeWorkflow(entry.slug, { name: entry.name, enabled: entry.enabled,
      description: 'Synthetic metadata-only collision fixture; never execute.',
      trigger: { schedule: '0 0 1 1 *', timezone: 'UTC' }, steps: [{ id: 'never-execute', prompt: 'No provider operations.' }] });
    const composeText = 'Compose these exact three draft messages without creating or sending anything: ' + JSON.stringify(PAYLOADS);
    const composeSource = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: composeText } });
    const composeIdentity = { sessionId: session.id, turn: 1, sourceUserSeq: composeSource.seq };
    const composeReply = JSON.stringify(PAYLOADS);
    const composed = commitTurnOutcome({ version: 2, id: turnOutcomeId(composeIdentity), identity: composeIdentity,
      status: 'done', resumable: false, presentation: { kind: 'answer', text: composeReply } });
    assert.equal(composed.presentation.status, 'done');
    priorHistory.push({ type: 'message', role: 'user', content: composeText }, { type: 'message', role: 'assistant', content: composeReply });
  }
  const prompt = c6Collision
    ? 'Save those exact three drafts in the Outlook Drafts folder for my Sampleteam mailbox. This is the live draft-write test. Keep To, Cc, and Bcc empty; preserve their subjects and bodies including punctuation and the line break; create each once. Do not send any email. Report each full subject and its full returned draft ID. Use plain-text bodies. Use a plan for these three saves, then execute it.'
    : basePrompt;
  const source = eventlog.appendEvent({ sessionId: session.id, turn: c6Collision ? 2 : 1, role: 'user', type: 'user_input_received', data: { text: prompt } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, JSON.stringify(primed));
  if (!primed.ok) throw new Error('fixture catalog must prime');
  assert.ok(primed.planning.capabilities.some(cap => cap.id === CAPABILITY), 'the exact provider capability is published before planning');
  const plan = brackets.wrapToolForHarness(buildPlanTaskTool({ planning: primed.planning }) as never);
  const work = brackets.wrapToolForHarness(buildWorkCall({ requireHostPlan: true, hostPlanningReady: () => true }) as never);
  const planArgs = {
    preamble: 'Saving the three fixture drafts to your connected owner mailbox, without recipients, using plain text.',
    draft: {
      criteria: ['Each of the three drafts created exactly once in the connected owner Drafts folder',
        'Subjects and bodies preserved byte-exact including punctuation and line break', 'To, Cc, Bcc all empty',
        'Plain-text body (is_html false)', 'No email sent', 'Report each subject with its returned draft ID'],
      cardinality: { count: 3, fields: ['subject', 'draft_id'], locator: null },
      destination: { posture: 'create_new', family: 'outlook_draft', handleRequired: false },
      topology: { version: 1, operations: ['draft_a', 'draft_b', 'draft_c'].map(id => ({
        id, effect: 'external_write', coverage: null, dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
      })), universes: [] },
      bindings: ['draft_a', 'draft_b', 'draft_c'].map(operationId => ({ operationId, role: 'create_draft', capabilityRef: CAPABILITY, evidence })),
      deliverables: ['draft_a', 'draft_b', 'draft_c'].map(id => ({ id, kind: 'outlook_draft' })),
      evidenceRequirements: evidence,
    },
  };
  const model = {
    async getResponse(request: unknown) {
      modelCalls += 1;
      if (modelCalls === 2) {
        assert.ok(eventlog.getTurnGraphEventForSource(session.id, source.seq), JSON.stringify(request));
        assert.equal(expectedWork.loadExpectedWorkContract(session.id, source.seq).status, 'ok');
      }
      return { responseId: `planned-draft-${suffix}-${modelCalls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: modelCalls === 1
          ? [{ type: 'function_call', callId: 'plan-three-drafts', name: 'plan_task', arguments: JSON.stringify(planArgs) }]
          : modelCalls === 2 ? PAYLOADS.map((payload, index) => ({
            type: 'function_call', callId: `write-draft-${index + 1}`, name: 'work_call', arguments: JSON.stringify({
              requirement_id: ['draft_a', 'draft_b', 'draft_c'][index], universe_item_id: null, universe_selector: null,
              seal_amendment: null, source_call_ids: null, source_record_ids: null,
              name: 'composio_execute_tool', args_json: JSON.stringify({ tool_slug: OPERATION, arguments: payload }),
            }),
          })) : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Created the three drafts: fixture-draft-1, fixture-draft-2, fixture-draft-3.' }] }],
      };
    }, getStreamedResponse: modelStream,
  };
  const agent = { model, tools: [plan, work] };
  const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: [plan, work], activeToolNames: ['plan_task', 'work_call'],
    policyHash: 'planned-draft-ack-fixture', budget: { maxUncachedTokens: 10_000, maxModelCalls: 6, maxToolCalls: 8, maxElapsedMs: 60_000 } });
  assert.ok(sealed.ok);
  if (!sealed.ok) throw new Error('fixture surface must seal');
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const runner = new EventEmitter();
  Object.assign(runner, { run() { throw new Error('legacy Runner must not own the turn'); } });
  const outcome = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(8), behaviorScopeId: `${session.id}::turn:${source.turn}` }, () => hostRunRunner(runner as never, agent as never, [...priorHistory, { type: 'message', role: 'user', content: prompt }] as never,
    { maxTurns: 6, hostTurnEngine: 'host_v1', context: identity } as never));
  return { session, source, identity, outcome, counts: () => ({ providerCalls, modelCalls }) };
}

test('a real three-draft plan settles exact provider acknowledgements and survives a durable reopen', async (t) => {
  const fixture = await plannedDraftFixture('exact');
  assert.equal(fixture.counts().providerCalls, 3, JSON.stringify(fixture.outcome.history));
  assert.equal(Boolean(fixture.outcome.hasInterruptions), false);
  const db = eventlog.openEventLog();
  const settlements = db.prepare(`SELECT logical_tool_call_id, outcome_kind, execution_kind, mutating,
    physical_crossing_count, host_crossing_count, requires_reconciliation, result_handle_id
    FROM logical_call_settlements WHERE session_id=? AND source_user_seq=? AND business_call=1
    ORDER BY logical_tool_call_id`).all(fixture.session.id, fixture.source.seq) as Array<Record<string, unknown>>;
  assert.equal(settlements.length, 3, JSON.stringify(settlements));
  for (const row of settlements) {
    assert.equal(row.outcome_kind, 'succeeded'); assert.equal(row.execution_kind, 'provider_execution');
    assert.equal(row.mutating, 1); assert.equal(row.physical_crossing_count, 1); assert.equal(row.host_crossing_count, 0);
    assert.equal(row.requires_reconciliation, 0); assert.ok(row.result_handle_id);
  }
  const raw = db.prepare(`SELECT raw_payload_json FROM durable_result_handles WHERE session_id=? AND source_user_seq=? AND tool_name=? ORDER BY logical_tool_call_id`)
    .all(fixture.session.id, fixture.source.seq, OPERATION.toLowerCase()) as Array<{ raw_payload_json: string }>;
  assert.equal(raw.length, 3);
  raw.forEach((row, index) => {
    const result = JSON.parse(row.raw_payload_json);
    assert.equal(result.data.id, `fixture-draft-${index + 1}`);
    assert.equal(result.data.body.content, PAYLOADS[index]!.body);
    assert.equal(result.data.handle, undefined); assert.equal(result.data.receipt, undefined); assert.equal(result.data.writtenDigest, undefined);
  });
  const proposedReply = 'Created the three drafts: fixture-draft-1, fixture-draft-2, fixture-draft-3.';
  const prepared = preparation.prepareAcceptedTaskTerminal({ ...fixture.identity, proposedReply });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  eventlog.closeEventLog();
  const reopened = preparation.prepareAcceptedTaskTerminal({ ...fixture.identity, proposedReply });
  assert.deepEqual(reopened, prepared, 'reopening storage must redeem the same frozen receipts without a provider retry');
  assert.equal(fixture.counts().providerCalls, 3);
  const reopenedDb = eventlog.openEventLog();
  const receipts = reopenedDb.prepare(`SELECT receipt_json FROM host_provider_acknowledgement_receipts_v1
    WHERE session_id=? AND source_user_seq=? ORDER BY node_id`).all(fixture.session.id, fixture.source.seq) as Array<{ receipt_json: string }>;
  assert.equal(receipts.length, 3);
  receipts.forEach(row => {
    const receipt = JSON.parse(row.receipt_json);
    assert.equal(receipt.proofKind, 'provider_acknowledgement_v1');
    assert.equal(receipt.accountId, ACCOUNT);
    assert.ok(settlements.some(settlement => settlement.logical_tool_call_id === receipt.logicalToolCallId
      && settlement.result_handle_id === receipt.resultHandleId));
    assert.equal(receipt.sourceUserSeq, fixture.source.seq);
    assert.equal(receipt.sessionId, fixture.session.id);
    assert.equal(receipt.artifactHandle, undefined);
    assert.equal(receipt.writtenDigest, undefined);
    assert.match(receipt.rawPayloadSha256, /^[a-f0-9]{64}$/);
  });
  const first = JSON.parse(receipts[0]!.receipt_json);
  const manifestState = loadManifestState(fixture.session.id, fixture.source.seq);
  assert.equal(manifestState.status, 'ok');
  if (manifestState.status !== 'ok') throw new Error('the exact obligation manifest must reopen');
  const publicationProof = () => verifyAcceptedTaskTerminalProofInTransaction({ db: reopenedDb,
    ...fixture.identity, acceptedTaskId: first.acceptedTaskId, manifest: manifestState.manifest });
  assert.deepEqual(reopenedDb.transaction(publicationProof)(), { ok: true }, 'the final transactional proof accepts the real SDK representation');
  const physical = reopenedDb.prepare('SELECT execution_site FROM physical_dispatches WHERE physical_dispatch_id=?')
    .get(first.physicalDispatchId) as { execution_site: string | null };
  assert.equal(physical.execution_site, null, 'the real gateway records the established NULL provider-site representation');

  // Simulate durable corruption after success, within a rolled-back temp-home
  // savepoint. Removing this table's immutable triggers models storage damage;
  // it is not an alternate runtime writer or an admission bypass.
  async function damaged(label: string, tables: string[], mutation: () => void) {
    await t.test(label, () => {
      reopenedDb.exec('SAVEPOINT acknowledgement_corruption');
      try {
        for (const table of tables) {
          const triggers = reopenedDb.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table) as Array<{ name: string }>;
          for (const trigger of triggers) reopenedDb.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
        }
        mutation();
        assert.equal(publicationProof().ok, false, `${label}: final transactional publication must refuse`);
        const rejected = preparation.prepareAcceptedTaskTerminal({ ...fixture.identity, proposedReply });
        assert.notEqual(rejected.status, 'ready', `${label}: ${JSON.stringify(rejected)}`);
        assert.notEqual(rejected.status, 'unstaged', `${label}: staged authority cannot disappear`);
        assert.equal(fixture.counts().providerCalls, 3, 'receipt refusal must never retry a provider write');
      } finally {
        reopenedDb.exec('ROLLBACK TO acknowledgement_corruption');
        reopenedDb.exec('RELEASE acknowledgement_corruption');
      }
      assert.equal(preparation.prepareAcceptedTaskTerminal({ ...fixture.identity, proposedReply }).status, 'ready');
    });
  }
  await damaged('missing exact host binding blocks a previously successful receipt', ['host_call_capability_bindings'], () => {
    reopenedDb.prepare('DELETE FROM host_call_capability_bindings WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?')
      .run(fixture.session.id, fixture.source.seq, first.logicalToolCallId);
  });
  await damaged('changed host account blocks a previously successful receipt', ['host_call_capability_bindings'], () => {
    reopenedDb.prepare('UPDATE host_call_capability_bindings SET account_id=? WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?')
      .run('ca-different-owner', fixture.session.id, fixture.source.seq, first.logicalToolCallId);
  });
  await damaged('changed raw result hash blocks a previously successful receipt', ['durable_result_handles'], () => {
    reopenedDb.prepare('UPDATE durable_result_handles SET raw_payload_sha256=? WHERE handle_id=?').run('0'.repeat(64), first.resultHandleId);
  });
  await damaged('unknown physical outcome cannot redeem a successful acknowledgement', ['physical_dispatches'], () => {
    reopenedDb.prepare('UPDATE physical_dispatches SET state=? WHERE physical_dispatch_id=?').run('unknown', first.physicalDispatchId);
  });
  await damaged('host execution cannot masquerade as a provider acknowledgement', ['physical_dispatches'], () => {
    reopenedDb.prepare('UPDATE physical_dispatches SET execution_site=? WHERE physical_dispatch_id=?').run('host', first.physicalDispatchId);
  });
  await damaged('a different well-formed work contract cannot replace the frozen acknowledgement mode', ['graph_node_bindings'], () => {
    const row = reopenedDb.prepare('SELECT binding_json FROM graph_node_bindings WHERE session_id=? AND source_user_seq=? ORDER BY node_id LIMIT 1')
      .get(fixture.session.id, fixture.source.seq) as { binding_json: string };
    const binding = JSON.parse(row.binding_json);
    binding.writeEvidenceMode.workContractId = `expected-work:v1:${'0'.repeat(64)}`;
    binding.bindingDigest = sealedNodeBindingDigestOf(binding);
    reopenedDb.prepare('UPDATE graph_node_bindings SET binding_json=?, binding_digest=? WHERE session_id=? AND source_user_seq=? AND node_id=?')
      .run(JSON.stringify(binding), binding.bindingDigest, fixture.session.id, fixture.source.seq, binding.nodeId);
  });
  await damaged('changed graph evidence requirements cannot redeem an old acknowledgement', ['events'], () => {
    const row = reopenedDb.prepare("SELECT id,data_json FROM events WHERE session_id=? AND type='turn_graph_compiled'")
      .get(fixture.session.id) as { id: string; data_json: string };
    const data = JSON.parse(row.data_json);
    data.graph.classification.goalConstraints.evidenceRequirements = ['tool_result', 'readback'];
    reopenedDb.prepare('UPDATE events SET data_json=? WHERE id=?').run(JSON.stringify(data), row.id);
  });
  const terminalOutcome = { version: 2 as const, id: turnOutcomeId(fixture.identity), identity: fixture.identity,
    status: 'done' as const, resumable: false as const, presentation: { kind: 'answer' as const, text: proposedReply } };
  const terminal = commitTurnOutcome(terminalOutcome);
  assert.equal(terminal.presentation.status, 'done');
  assert.equal(terminal.presentation.identity.sourceUserSeq, fixture.source.seq);
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['conversation_completed'] }).length, 1);
  eventlog.closeEventLog();
  assert.equal(commitTurnOutcome(terminalOutcome).event.id, terminal.event.id, 'terminal publication replays once across restart');
  assert.equal(fixture.counts().providerCalls, 3);
});

test('a real plan that explicitly promises readback cannot complete from three provider acknowledgements', async () => {
  const fixture = await plannedDraftFixture('explicit-readback', ['tool_result', 'readback']);
  assert.equal(fixture.counts().providerCalls, 3, JSON.stringify(fixture.outcome.history));
  const rows = eventlog.openEventLog().prepare('SELECT binding_json FROM graph_node_bindings WHERE session_id=? AND source_user_seq=?')
    .all(fixture.session.id, fixture.source.seq) as Array<{ binding_json: string }>;
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(JSON.parse(row.binding_json).writeEvidenceMode, undefined);
  const prepared = preparation.prepareAcceptedTaskTerminal({ ...fixture.identity, proposedReply: 'Created the three drafts.' });
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  assert.match(prepared.reason, /readback|handle|receipt|verification/);
  eventlog.closeEventLog();
  assert.deepEqual(preparation.prepareAcceptedTaskTerminal({ ...fixture.identity, proposedReply: 'Created the three drafts.' }), prepared);
  assert.equal(fixture.counts().providerCalls, 3);
});


test('the synthetic C6 follow-up admits its requested three-write plan despite the saved workflow catalog', async () => {
  const fixture = await plannedDraftFixture('c6-workflow-collision', ['tool_result'], true);
  assert.equal(fixture.counts().providerCalls, 3, JSON.stringify(fixture.outcome.history));
  assert.equal(fixture.counts().modelCalls, 3);
  const graph = eventlog.getTurnGraphEventForSource(fixture.session.id, fixture.source.seq);
  assert.ok(graph, 'the requested action plan must actually be admitted');
  const prepared = preparation.prepareAcceptedTaskTerminal({ ...fixture.identity,
    proposedReply: 'Created the three drafts: fixture-draft-1, fixture-draft-2, fixture-draft-3.' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const db = eventlog.openEventLog();
  const rows = db.prepare('SELECT receipt_json FROM host_provider_acknowledgement_receipts_v1 WHERE session_id=? AND source_user_seq=?')
    .all(fixture.session.id, fixture.source.seq) as Array<{ receipt_json: string }>;
  assert.equal(rows.length, 3, 'all three writes discharge the real frozen plan through acknowledgement receipts');
  const bindings = db.prepare('SELECT binding_json FROM graph_node_bindings WHERE session_id=? AND source_user_seq=?')
    .all(fixture.session.id, fixture.source.seq) as Array<{ binding_json: string }>;
  assert.equal(bindings.length, 3);
  for (const row of bindings) assert.equal(JSON.parse(row.binding_json).writeEvidenceMode.kind, 'provider_acknowledgement_v1');
  const calls = eventlog.listEvents(fixture.session.id, { types: ['tool_called'] });
  assert.equal(calls.some(event => /workflow/.test(String(event.data.tool))), false, 'saved workflow names must never hijack draft creation');
  assert.equal(fixture.counts().providerCalls, 3);
});
