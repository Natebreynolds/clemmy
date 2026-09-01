/**
 * Authored external SEND authority, proven through the production host.
 *
 * Owner rule (2026-07-24): the only human-in-the-loop gate inside a saved
 * workflow is a step AUTHORED `requiresApproval`; a step the author declared
 * `sideEffect: 'send'` sends without parking — saving + enabling/running the
 * workflow is the consent. Under host_v1 that consent is the exact authored
 * receipt/grant: bound to the accepted source, batch occurrence, arguments,
 * destination, account and schema, ONE send per step attempt. It replaces the
 * TTL-wide `allowAnySend` scope flag, which is gone.
 *
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/harness/authored-workflow-send-authority.host.acceptance.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentInputItem } from '@openai/agents';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-authored-send-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
delete process.env.OPENAI_API_KEY;
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-authored-send\n');

const { hostRunRunner } = await import('./host-turn-runner.js');
const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const capabilityEnvelopes = await import('../../agents/capability-envelope.js');
const planScopes = await import('../../agents/plan-scope.js');
const authorityAdapter = await import('./authored-workflow-write-authority.js');
const callAuthority = await import('./accepted-turn-call-authority.js');
const hostBindings = await import('./host-call-capability-binding.js');
const logicalContracts = await import('./logical-call-contract.js');
const identities = await import('./attempt-identity.js');
const checkpoints = await import('./accepted-model-batch-checkpoint.js');
const leases = await import('./dispatch-lease.js');
const hostInvocation = await import('./host-tool-invocation.js');
const manifests = await import('./capability-manifest.js');
const manifestStores = await import('./capability-manifest-store.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const observations = await import('./independent-capability-observation.js');
const productionAdapters = await import('./production-capability-adapter.js');
const productionPorts = await import('./production-capability-ports.js');
const acceptedCatalogScope = await import('./accepted-source-catalog-scope.js');
const composioSchemas = await import('../../tools/composio-schema-cache.js');
const toolContracts = await import('../../tools/tool-contract-store.js');
const workflowDefinitions = await import('../../execution/workflow-run-definition.js');
const sharedTools = await import('../../tools/shared.js');
const memoryDatabase = await import('../../memory/db.js');

const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
const priorManifestStore = manifestStores.peekCapabilityManifestStore();

test.after(() => {
  observations.clearIndependentCapabilityObservations();
  catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  manifestStores.installCapabilityManifestStore(priorManifestStore);
  productionPorts.clearProductionCapabilityPorts();
  composioSchemas.resetToolSchemaCache();
  eventlog.closeEventLog();
  memoryDatabase.closeMemoryDb();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

// ─── opaque send / delete / foreign-send catalog fixtures ───────────────────

const SEND_SCHEMA = {
  type: 'object',
  required: ['to', 'subject', 'body'],
  properties: {
    to: { type: 'string', minLength: 1 },
    subject: { type: 'string', minLength: 1 },
    body: { type: 'string' },
  },
  additionalProperties: false,
};
const SEND_ARGS = { to: 'owner@example.test', subject: 'Daily standup', body: 'No meetings on calendar.' };
const DELETE_SCHEMA = {
  type: 'object',
  required: ['message_id'],
  properties: { message_id: { type: 'string', minLength: 1 } },
  additionalProperties: false,
};

const portBodies: Record<string, number> = {};

function installOperation(input: {
  operationId: string;
  capabilityId: string;
  accountId: string;
  schema: Record<string, unknown>;
}) {
  composioSchemas.rememberToolSchema(
    input.operationId,
    input.schema,
    Date.now(),
    '1',
    { type: 'object', additionalProperties: true },
  );
  const providerInputSchemaDigest = toolContracts.digestSchema(input.schema);
  const definitionFingerprint = sha256(`definition:${input.operationId}:v1`);
  const manifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: input.capabilityId,
    providerKind: 'native_mcp',
    operationId: input.operationId,
    providerIdentity: 'configured-messaging:authored-send-fixture',
    providerVersion: 'fixture-provider-v1',
    operationVersion: '1',
    definitionFingerprint,
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest,
      semanticName: input.operationId,
      behaviorHints: { readOnly: false, destructive: false, idempotent: null, openWorld: false },
    },
    effect: 'external_write',
    destination: { family: 'external_message', posture: 'named_existing' },
    accountId: input.accountId,
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'provider_lookup' },
    outputContract: { kind: 'send_receipt' },
    purpose: 'invoke_live_operation',
    acceptedInputKinds: ['arguments'],
    producedOutputKinds: ['send_receipt'],
    applicableDeliverableKinds: ['message'],
    evidenceContract: { kinds: ['receipt'], readbackRequired: false },
    provenance: {
      issuer: 'host:test:authored-workflow-send',
      issuedAt: '2026-08-31T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['destination', 'send'],
    argumentCompiler: { id: 'compile:proof-schema:v1', version: '1' },
    invokePortId: `fixture:messaging:${input.operationId.toLowerCase()}`,
  });
  const observedAt = Date.now();
  assert.deepEqual(observations.registerIndependentCapabilityObservation({
    operationId: input.operationId,
    accountId: input.accountId,
    definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt,
    origin: 'independent',
    observe: () => ({
      operationId: input.operationId,
      accountId: input.accountId,
      definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt,
    }),
  }), { ok: true });
  portBodies[input.operationId] = 0;
  const invoke = async () => {
    portBodies[input.operationId] = (portBodies[input.operationId] ?? 0) + 1;
    return { successful: true, data: { id: `msg-${portBodies[input.operationId]}`, delivered: true } };
  };
  const entry = productionAdapters.registeredCapabilityFromManifest({
    manifest,
    observation: {
      definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      accountId: input.accountId,
      observedAt,
    },
    invoke,
  });
  assert.deepEqual(productionPorts.registerFixtureCapabilityPort(
    productionPorts.productionPortIdentityFromManifest(manifest),
    { invoke: invoke as never },
  ), { ok: true });
  return { manifest, entry, providerInputSchemaDigest };
}

productionPorts.clearProductionCapabilityPorts();
const SEND = installOperation({
  operationId: 'FIXTURE_MESSAGES_SEND',
  capabilityId: 'cap:workflow:messages-send',
  accountId: 'account:workflow:messages-owner',
  schema: SEND_SCHEMA,
});
const FOREIGN_SEND = installOperation({
  operationId: 'FIXTURE_OTHER_SEND',
  capabilityId: 'cap:workflow:other-send',
  accountId: 'account:workflow:messages-owner',
  schema: SEND_SCHEMA,
});
const DELETE = installOperation({
  operationId: 'FIXTURE_MESSAGES_DELETE',
  capabilityId: 'cap:workflow:messages-delete',
  accountId: 'account:workflow:messages-owner',
  schema: DELETE_SCHEMA,
});
manifestStores.installCapabilityManifestStore(
  manifestStores.createCapabilityManifestStore([SEND.manifest, FOREIGN_SEND.manifest, DELETE.manifest], { durable: true }),
);
catalogs.installHostCapabilityCatalogFactory(
  catalogs.createHostCapabilityCatalogFactory([SEND.entry, FOREIGN_SEND.entry, DELETE.entry]),
);
const sendIdentity = catalogs.canonicalCatalogIdentityOf(SEND.entry)!;
const foreignIdentity = catalogs.canonicalCatalogIdentityOf(FOREIGN_SEND.entry)!;
const deleteIdentity = catalogs.canonicalCatalogIdentityOf(DELETE.entry)!;
assert.ok(sendIdentity && foreignIdentity && deleteIdentity);

// ─── production host scaffolding ────────────────────────────────────────────

async function* testModelStream(
  this: { getResponse: (request: unknown) => Promise<{ output?: unknown[]; responseId?: string }> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = response.output ?? [];
  const finishReason = output.some((item) => (item as { type?: string }).type === 'function_call')
    ? 'tool_calls'
    : 'stop';
  yield { type: 'response_started' } as never;
  yield { type: 'model', event: { type: 'finish', finishReason } } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId ?? 'test-response',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
    },
  } as never;
}

function stubModel(responses: unknown[][]) {
  let call = 0;
  return {
    calls: () => call,
    async getResponse() {
      const output = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output,
        responseId: `resp-${call}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
}

const textMsg = (text: string) => ({
  type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text }],
});
const toolCall = (callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'function_call', callId, name, arguments: JSON.stringify(args),
});
const sendCall = (callId: string, operationId = SEND.manifest.operationId, args: Record<string, unknown> = SEND_ARGS) => (
  toolCall(callId, 'call_tool', { name: operationId, args_json: JSON.stringify(args) })
);

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('Runner.run must not own the turn');
  };
  return runner;
}

function dispositionMarkers(history: readonly unknown[]): Array<{ disposition: string; retry: string }> {
  const markers: Array<{ disposition: string; retry: string }> = [];
  for (const item of history) {
    if ((item as { type?: string }).type !== 'function_call_result') continue;
    const output = (item as { output?: unknown }).output;
    const text = typeof output === 'string'
      ? output
      : output && typeof output === 'object' ? (output as { text?: unknown }).text : undefined;
    if (typeof text !== 'string') continue;
    try {
      const decoded = JSON.parse(text) as { protocol?: string; disposition?: string; retry?: string };
      if (decoded.protocol === 'host_tool_disposition_v1' && decoded.disposition && decoded.retry) {
        markers.push({ disposition: decoded.disposition, retry: decoded.retry });
      }
    } catch { /* ordinary tool result */ }
  }
  return markers;
}

function carrierTool() {
  let outerBodies = 0;
  const tool = brackets.wrapToolForHarness({
    type: 'function',
    name: 'call_tool',
    description: 'Invoke one exact operation acquired from the frozen capability catalog.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, args_json: { type: 'string' } },
      required: ['name', 'args_json'],
    },
    needsApproval: async () => false,
    invoke: async () => {
      outerBodies += 1;
      throw new Error('the generic carrier body must not replace the exact production port');
    },
  });
  return { tool, outerBodies: () => outerBodies };
}

let serial = 0;

function createSendStepFixture(input: {
  kind?: 'workflow' | 'chat';
  requiresApproval?: boolean;
  trigger?: 'manual' | 'schedule';
  prompt?: string;
  identities?: ReadonlyArray<typeof sendIdentity>;
  record?: boolean;
}) {
  const suffix = String(++serial);
  const workflowRunId = `run-authored-send-${suffix}`;
  const workflowSlug = `authored-send-${suffix}`;
  const workflowName = `Authored Send ${suffix}`;
  const stepId = 'main';
  const attemptId = `attempt:workflow:${workflowRunId}:${stepId}`;
  const sessionId = `workflow:${workflowRunId}:${stepId}`;
  const planProposalId = `workflow:${workflowName}:${workflowRunId}:${stepId}`;
  const prompt = input.prompt
    ?? `Check the calendar, then send the standup email with ${SEND.manifest.operationId} and return a structured result.`;
  const definition = {
    name: workflowName,
    description: 'Exercise exact authored send authority.',
    enabled: true,
    trigger: input.trigger === 'schedule' ? { schedule: '0 8 * * 1-5' } : { manual: true as const },
    steps: [{
      id: stepId,
      prompt,
      sideEffect: 'send' as const,
      requiresApproval: input.requiresApproval === true,
    }],
  };
  const snapshot = workflowDefinitions.createWorkflowRunDefinitionSnapshot(
    workflowSlug,
    definition,
    `2026-08-31T00:00:${String(serial).padStart(2, '0')}.000Z`,
  );
  mkdirSync(sharedTools.WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(sharedTools.WORKFLOW_RUNS_DIR, `${workflowRunId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: workflowRunId,
    workflow: workflowName,
    workflowDefinitionSnapshot: snapshot,
    status: 'running',
    inputs: {},
    ...(input.trigger === 'schedule' ? { source: 'schedule', scheduledFor: '2026-09-01T15:00:00.000Z' } : {}),
    createdAt: '2026-08-31T00:00:00.000Z',
    startedAt: '2026-08-31T00:00:01.000Z',
  }), 'utf8');
  const session = eventlog.createSession({
    id: sessionId,
    kind: input.kind ?? 'workflow',
    channel: 'workflow',
    title: `${workflowName}::${stepId}`,
    metadata: { source: 'workflow', workflowName, workflowRunId, stepId },
  });
  const attempt = eventlog.beginRunAttempt(session.id, {
    runId: `workflow-step:${workflowRunId}:${stepId}`,
    attemptId,
  });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: `Workflow: ${workflowName}\nStep: ${stepId}\n\n${prompt}`, workflowName, workflowRunId, stepId, attemptId },
  });
  planScopes.openPlanScope({
    sessionId: session.id,
    planProposalId,
    approvedPlanObjective: `Approved workflow "${workflowName}" step "${stepId}"`,
    allowedTools: ['*'],
    ttlMs: 10 * 60_000,
  });
  const identitiesForReceipt = input.identities ?? [sendIdentity];
  const recorded = input.record === false
    ? { status: 'none' as const }
    : authorityAdapter.recordAuthoredWorkflowWriteAuthority({
        sessionId: session.id,
        sourceUserSeq: source.seq,
        attemptId,
        workflowRunId,
        workflowSlug,
        stepId,
        expectedPlanProposalId: planProposalId,
        catalogIdentities: identitiesForReceipt,
      });
  return {
    session,
    source,
    attempt,
    workflowRunId,
    workflowSlug,
    workflowName,
    stepId,
    planProposalId,
    snapshot,
    runFile,
    recorded,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    parent: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      counter: new brackets.ToolCallsCounter(8),
      behaviorScopeId: `${session.id}::turn:1`,
    },
    context: { sessionId: session.id, sourceUserSeq: source.seq },
    scope: {
      manifestIds: identitiesForReceipt.map((identity) => identity.manifestId),
      operationIds: identitiesForReceipt.map((identity) => identity.operationId),
    },
  };
}

type SendFixture = ReturnType<typeof createSendStepFixture>;

function bindSurface(fixture: SendFixture, agent: object, tools: Array<{ name: string }>) {
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
    sessionId: fixture.session.id,
    universeTools: tools,
    activeToolNames: tools.map((entry) => entry.name),
    policyHash: 'authored-send-policy-v1',
    budget: { maxUncachedTokens: 1_000, maxModelCalls: 8, maxToolCalls: 8, maxElapsedMs: 60_000 },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) throw new Error(sealed.errors.join('; '));
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
}

function runProductionHost(
  fixture: SendFixture,
  agent: Record<string, unknown>,
  itemsOrState: unknown = [{ type: 'message', role: 'user', content: fixture.source.data.text }],
  extraOptions: Record<string, unknown> = {},
) {
  return acceptedCatalogScope.withAcceptedSourceCatalogManifestScope(fixture.scope, () => (
    brackets.withHarnessRunContext(fixture.parent, () => hostRunRunner(
      throwingRunner() as never,
      agent as never,
      itemsOrState as never,
      { maxTurns: 4, hostTurnEngine: 'host_v1', context: fixture.context, ...extraOptions } as never,
    ))
  ));
}

function db() {
  return eventlog.openEventLog();
}

function nonRefusedSettlements(fixture: SendFixture) {
  return db().prepare(`
    SELECT settlement.logical_tool_call_id AS logical_tool_call_id,
           settlement.execution_kind AS execution_kind,
           settlement.outcome_kind AS outcome_kind,
           call.tool_name AS tool_name
      FROM logical_call_settlements settlement
      JOIN logical_tool_calls call
        ON call.session_id = settlement.session_id
       AND call.source_user_seq = settlement.source_user_seq
       AND call.logical_tool_call_id = settlement.logical_tool_call_id
     WHERE settlement.session_id = ? AND settlement.source_user_seq = ?
       AND settlement.execution_kind != 'refused_pre_dispatch'
     ORDER BY settlement.settled_at, settlement.rowid
  `).all(fixture.session.id, fixture.source.seq) as Array<{
    logical_tool_call_id: string; execution_kind: string; outcome_kind: string; tool_name: string;
  }>;
}

function pendingApprovals(fixture: SendFixture) {
  return db().prepare(`
    SELECT approval_id, resume_key, status, resolution FROM pending_approvals WHERE session_id = ?
  `).all(fixture.session.id) as Array<{ approval_id: string; resume_key: string | null; status: string; resolution: string | null }>;
}

/** Catalog-manifest attestation exactly as the production host binds a
 *  direct operation carried through call_tool. */
function catalogAttestation(
  fixture: SendFixture,
  callId: string,
  identity: typeof sendIdentity,
  args: Record<string, unknown>,
): callAuthority.HostCallAttestation {
  const root = callAuthority.acceptedTurnCallAuthorityFor(fixture.session.id, fixture.source.seq);
  assert.equal(root.status, 'ok', JSON.stringify(root));
  if (root.status !== 'ok') throw new Error(root.reason);
  const contract = logicalContracts.durableLogicalCallContract(fixture.acceptedTaskId, identity.operationId, args);
  assert.ok(contract);
  if (!contract) throw new Error('fixture identity is unavailable');
  const base = {
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    acceptedTaskId: fixture.acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: callId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect: 'external_write' as const,
    bindingKind: 'catalog_manifest' as const,
    capabilityId: identity.capabilityId,
    providerInputSchemaDigest: identity.providerInputSchemaDigest,
    schemaFingerprint: identity.schemaDigest,
    accountId: identity.account,
    invokePortId: identity.invokePortId,
    operationId: identity.operationId,
    manifestId: identity.manifestId,
    manifestDigest: identity.manifestDigest,
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest: root.authority.catalogRevisionDigest!,
    bindingRevisionDigest: root.authority.bindingRevisionDigest!,
  };
  return { ...base, bindingDigest: hostBindings.hostCallAttestationBindingDigest(base) };
}

function armDirect(fixture: SendFixture) {
  const armed = callAuthority.armHostCallAuthority({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    catalogRevisionDigest: sha256(`catalog:${fixture.session.id}`),
    bindingRevisionDigest: sha256(`binding:${fixture.session.id}`),
    maxLogicalCalls: 8,
    maxParallelCalls: 2,
  });
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
}

function admitFrame(fixture: SendFixture, frame: unknown[], label: string) {
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    preHistory: [{ role: 'user', content: fixture.source.data.text } as AgentInputItem],
    frameHistory: frame as AgentInputItem[],
    providerResponseId: `response:${label}`,
  });
  assert.equal(admitted.status, 'admitted', JSON.stringify(admitted));
  if (admitted.status !== 'admitted') throw new Error('batch not admitted');
  return admitted.admission;
}

const evaluateDirect = (
  fixture: SendFixture,
  attestation: callAuthority.HostCallAttestation,
  acceptedBatch: ReturnType<typeof admitFrame>,
  args: Record<string, unknown>,
  callIndex: number,
) => acceptedCatalogScope.withAcceptedSourceCatalogManifestScope(fixture.scope, () => (
  authorityAdapter.evaluateAuthoredWorkflowMutationConsent({ attestation, args, acceptedBatch, callIndex })
));

// ─── pins ───────────────────────────────────────────────────────────────────

for (const trigger of ['manual', 'schedule'] as const) {
  test(`${trigger} first run: an authored send step sends exactly once on its exact standing grant, no approval card`, async () => {
    const fixture = createSendStepFixture({ trigger });
    assert.equal(fixture.recorded.status, 'ready', JSON.stringify(fixture.recorded));
    const before = portBodies[SEND.manifest.operationId]!;
    const carrier = carrierTool();
    const model = stubModel([
      [sendCall(`${trigger}-send-1`)],
      [textMsg(`${trigger} standup sent`)],
    ]);
    const agent = { model, tools: [carrier.tool] };
    bindSurface(fixture, agent, [carrier.tool]);

    const outcome = await runProductionHost(fixture, agent);
    assert.equal(outcome.finalOutput, `${trigger} standup sent`, JSON.stringify(outcome.history));
    assert.equal(outcome.hasInterruptions ?? false, false, 'an authored send without requiresApproval never parks');
    assert.equal(portBodies[SEND.manifest.operationId], before + 1, 'exactly one provider body');
    assert.equal(carrier.outerBodies(), 0);
    assert.deepEqual(dispositionMarkers(outcome.history), []);
    assert.deepEqual(pendingApprovals(fixture), [], 'zero approval cards');
    const settled = nonRefusedSettlements(fixture);
    assert.equal(settled.length, 1, JSON.stringify(settled));
    assert.equal(settled[0]!.tool_name.toUpperCase(), SEND.manifest.operationId);
    assert.equal(settled[0]!.execution_kind, 'provider_execution');
    const receipt = eventlog.listEvents(fixture.session.id, { types: ['authored_workflow_write_authority'] })[0]!;
    assert.equal(receipt.data.stepSideEffect, 'send');
    assert.equal(receipt.data.requiresApproval, false);
  });
}

test('the exact grant is a send grant: once per step attempt, irreversible send risk, sibling call in the same frame is cardinality_spent', async () => {
  const fixture = createSendStepFixture({});
  assert.equal(fixture.recorded.status, 'ready');
  armDirect(fixture);
  const frame = admitFrame(fixture, [sendCall('direct-send-a'), sendCall('direct-send-b')], 'direct-two-sends');
  const first = await evaluateDirect(fixture, catalogAttestation(fixture, 'direct-send-a', sendIdentity, SEND_ARGS), frame, SEND_ARGS, 0);
  assert.equal(first?.status, 'decided', JSON.stringify(first));
  assert.equal(first?.decision.kind, 'proceed', JSON.stringify(first));
  if (first?.decision.kind === 'proceed') assert.equal(first.decision.basis, 'exact_user_grant');
  assert.deepEqual(first?.call.risk, { reversibility: 'irreversible', consequence: 'send', destructive: false });
  assert.deepEqual(first?.call.cardinality, { kind: 'once' });
  assert.equal(first?.call.effect, 'external_write');
  assert.equal(first?.coverage?.contractId, `authored-workflow:${fixture.recorded.status === 'ready' ? fixture.recorded.authorityDigest : ''}`);

  const second = await evaluateDirect(fixture, catalogAttestation(fixture, 'direct-send-b', sendIdentity, SEND_ARGS), frame, SEND_ARGS, 1);
  assert.equal(second?.status, 'decided', JSON.stringify(second));
  assert.deepEqual(second?.decision, { kind: 'repair', reason: 'cardinality_spent' },
    'the step attempt has one authored send; a sibling in the same frame cannot bind it');

  const again = await evaluateDirect(fixture, catalogAttestation(fixture, 'direct-send-a', sendIdentity, SEND_ARGS), frame, SEND_ARGS, 0);
  assert.equal(again?.decision.kind, 'proceed', 're-evaluating the same logical call keeps its own reservation');

  assert.equal(await evaluateDirect(fixture, catalogAttestation(fixture, 'direct-send-a', sendIdentity, SEND_ARGS), {
    ...frame,
    batchId: `batch:foreign:${frame.batchId}`,
  }, SEND_ARGS, 0), null, 'a forged accepted batch grants nothing');

  const originalDestination = SEND.entry.destination;
  SEND.entry.destination = { family: 'foreign_channel', posture: 'named_existing' };
  assert.equal(await evaluateDirect(fixture, catalogAttestation(fixture, 'direct-send-a', sendIdentity, SEND_ARGS), frame, SEND_ARGS, 0),
    null, 'current catalog destination drift grants nothing');
  SEND.entry.destination = originalDestination;
});

test('two sends in one model frame: the frame is refused with zero bodies; the corrected single-send frame then sends once', async () => {
  const fixture = createSendStepFixture({});
  assert.equal(fixture.recorded.status, 'ready');
  const before = portBodies[SEND.manifest.operationId]!;
  const carrier = carrierTool();
  const model = stubModel([
    [sendCall('frame-send-a'), sendCall('frame-send-b')],
    [sendCall('frame-send-c')],
    [textMsg('sent once after the double-send frame was refused')],
  ]);
  const agent = { model, tools: [carrier.tool] };
  bindSurface(fixture, agent, [carrier.tool]);

  const outcome = await runProductionHost(fixture, agent);
  assert.equal(outcome.finalOutput, 'sent once after the double-send frame was refused', JSON.stringify(outcome.history));
  assert.equal(portBodies[SEND.manifest.operationId], before + 1, 'the refused frame ran nothing; the corrected frame ran once');
  assert.deepEqual(dispositionMarkers(outcome.history), [
    { disposition: 'refused_pre_dispatch', retry: 'replan' },
    { disposition: 'refused_pre_dispatch', retry: 'replan' },
  ], 'both calls of the double-send frame are paired as refused, never one executed and one refused');
  assert.deepEqual(nonRefusedSettlements(fixture).map((row) => row.logical_tool_call_id), ['frame-send-c']);
  assert.deepEqual(pendingApprovals(fixture), []);
});

test('a later frame cannot send again after the step attempt already sent: the durable ledger spends the reservation', async () => {
  const fixture = createSendStepFixture({});
  assert.equal(fixture.recorded.status, 'ready');
  const before = portBodies[SEND.manifest.operationId]!;
  const carrier = carrierTool();
  const model = stubModel([
    [sendCall('later-send-1')],
    [sendCall('later-send-2')],
    [textMsg('second send refused')],
  ]);
  const agent = { model, tools: [carrier.tool] };
  bindSurface(fixture, agent, [carrier.tool]);

  const outcome = await runProductionHost(fixture, agent);
  assert.equal(outcome.finalOutput, 'second send refused', JSON.stringify(outcome.history));
  assert.equal(portBodies[SEND.manifest.operationId], before + 1, 'one authored send per step attempt');
  assert.deepEqual(dispositionMarkers(outcome.history), [{ disposition: 'refused_pre_dispatch', retry: 'replan' }]);
  assert.deepEqual(nonRefusedSettlements(fixture).map((row) => row.logical_tool_call_id), ['later-send-1']);
});

test('the same admitted send occurrence replays from its settlement: settled_replay, duplicate:true, one body', async () => {
  const fixture = createSendStepFixture({});
  assert.equal(fixture.recorded.status, 'ready');
  armDirect(fixture);
  const callId = 'replay-send-1';
  const frame = admitFrame(fixture, [sendCall(callId)], 'direct-replay');
  const attestation = catalogAttestation(fixture, callId, sendIdentity, SEND_ARGS);
  const first = await evaluateDirect(fixture, attestation, frame, SEND_ARGS, 0);
  assert.equal(first?.decision.kind, 'proceed', JSON.stringify(first));

  let bodies = 0;
  const parentLease = leases.activateDispatchLease({
    sessionId: fixture.session.id,
    scopeId: `${fixture.session.id}::send-replay`,
  });
  const context = {
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(8),
    dispatchLease: parentLease,
  } satisfies brackets.HarnessRunContext;
  const invoke = () => callAuthority.withHostCallAttestation(attestation, () =>
    brackets.withHarnessRunContext(context, () => hostInvocation.invokeHostToolCall({
      identity: {
        sessionId: fixture.session.id,
        sourceUserSeq: fixture.source.seq,
        modelCallId: callId,
        toolName: SEND.manifest.operationId,
        args: SEND_ARGS,
        turn: 1,
      },
      parentLease,
      effect: 'external_write',
      boundary: 'host_owned_external',
      deadlineMs: 500,
      invoke: async () => {
        bodies += 1;
        return { successful: true, data: { id: 'msg-replay', delivered: true } };
      },
    })));
  const crossed = await invoke();
  assert.equal(crossed.settlement.duplicate, false);
  assert.equal(bodies, 1);
  const replayConsent = await evaluateDirect(fixture, attestation, frame, SEND_ARGS, 0);
  assert.equal(replayConsent?.decision.kind, 'proceed', JSON.stringify(replayConsent));
  if (replayConsent?.decision.kind === 'proceed') assert.equal(replayConsent.decision.basis, 'settled_replay');
  const replay = await invoke();
  assert.equal(replay.settlement.duplicate, true);
  assert.equal(bodies, 1, 'the same admitted send never enters the provider twice');
  leases.revokeDispatchLease(parentLease);
});

test('a send operation the immutable step never named cannot get a receipt; a delete never inherits send authority', async () => {
  const foreign = createSendStepFixture({ identities: [foreignIdentity] });
  assert.deepEqual(foreign.recorded, { status: 'refused', reason: 'write_operation_not_authored_in_immutable_step' });

  const withDelete = createSendStepFixture({
    prompt: `Send the standup with ${SEND.manifest.operationId}; if it bounces, clean up with ${DELETE.manifest.operationId}.`,
    identities: [sendIdentity, deleteIdentity],
  });
  assert.equal(withDelete.recorded.status, 'ready', JSON.stringify(withDelete.recorded));
  armDirect(withDelete);
  const deleteArgs = { message_id: 'msg-1' };
  const frame = admitFrame(withDelete, [
    toolCall('delete-1', 'call_tool', { name: DELETE.manifest.operationId, args_json: JSON.stringify(deleteArgs) }),
  ], 'direct-delete');
  assert.equal(await evaluateDirect(withDelete, catalogAttestation(withDelete, 'delete-1', deleteIdentity, deleteArgs), frame, deleteArgs, 0),
    null, 'delete/admin/destructive projections stay outside every authored grant');
});

test('a chat session wearing forged workflow metadata gets no send receipt', () => {
  const fixture = createSendStepFixture({ kind: 'chat' });
  assert.deepEqual(fixture.recorded, { status: 'refused', reason: 'workflow_session_owner_mismatch' });
});

test('the step PlanScope never auto-approves the send by itself: the exact receipt/grant is the only send authority', () => {
  const fixture = createSendStepFixture({});
  assert.equal(fixture.recorded.status, 'ready');
  // The legacy scope predicate classifies sends by provider slug shape; the
  // step scope opened for an authored send step must never wave one, whatever
  // the step declared. (Under host_v1 this predicate is unreachable for
  // mutations; the exact receipt/grant above is the only send authority.)
  const sendArgs = { tool_slug: 'SLACK_SEND_MESSAGE', arguments: JSON.stringify({ channel: 'C1', markdown_text: 'standup' }) };
  assert.equal(planScopes.isAutoApprovedByScope(fixture.session.id, 'composio_execute_tool', sendArgs, 'send'), false,
    'an authored send step scope never auto-approves an irreversible send');
  const scope = planScopes.getPlanScope(fixture.session.id);
  assert.ok(scope);
  assert.equal('allowAnySend' in (scope as object), false, 'the TTL-wide send flag no longer exists');
});
