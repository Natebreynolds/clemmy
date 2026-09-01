/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/harness/authored-workflow-write-authority.acceptance.red.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentInputItem } from '@openai/agents';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-authored-workflow-write-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-authored-workflow-write\n');

const eventlog = await import('./eventlog.js');
const callAuthority = await import('./accepted-turn-call-authority.js');
const checkpoints = await import('./accepted-model-batch-checkpoint.js');
const identities = await import('./attempt-identity.js');
const logicalContracts = await import('./logical-call-contract.js');
const hostBindings = await import('./host-call-capability-binding.js');
const leases = await import('./dispatch-lease.js');
const brackets = await import('./brackets.js');
const hostInvocation = await import('./host-tool-invocation.js');
const manifests = await import('./capability-manifest.js');
const manifestStores = await import('./capability-manifest-store.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const observations = await import('./independent-capability-observation.js');
const productionAdapters = await import('./production-capability-adapter.js');
const acceptedCatalogScope = await import('./accepted-source-catalog-scope.js');
const authorityAdapter = await import('./authored-workflow-write-authority.js');
const externalRisk = await import('./external-capability-risk-loader.js');
const canonicalJson = await import('../../shared/closed-canonical-json.js');
const composioSchemas = await import('../../tools/composio-schema-cache.js');
const toolContracts = await import('../../tools/tool-contract-store.js');
const planScopes = await import('../../agents/plan-scope.js');
const workflowDefinitions = await import('../../execution/workflow-run-definition.js');
const sharedTools = await import('../../tools/shared.js');

const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
const priorManifestStore = manifestStores.peekCapabilityManifestStore();

test.after(() => {
  observations.clearIndependentCapabilityObservations();
  catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  manifestStores.installCapabilityManifestStore(priorManifestStore);
  composioSchemas.resetToolSchemaCache();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const OPERATION_ID = 'FIXTURE_RECORDS_UPDATE_RECORD';
const ACCOUNT_ID = 'account:workflow:records-owner';
const CAPABILITY_ID = 'cap:workflow:records-update-record';
const SCHEMA = {
  type: 'object',
  required: ['record_id', 'field', 'value'],
  properties: {
    record_id: { type: 'string', minLength: 1 },
    field: { type: 'string', minLength: 1 },
    value: { type: 'string' },
  },
  additionalProperties: false,
};
const PROVIDER_ARGS = {
  record_id: 'record-49',
  field: 'review_status',
  value: 'reviewed',
};

composioSchemas.rememberToolSchema(
  OPERATION_ID,
  SCHEMA,
  Date.now(),
  '1',
  { type: 'object', additionalProperties: true },
);
const providerInputSchemaDigest = toolContracts.digestSchema(SCHEMA);
const definitionFingerprint = sha256(`definition:${OPERATION_ID}:v1`);
const manifest = manifests.attachSemanticContract({
  version: 1,
  manifestId: CAPABILITY_ID,
  providerKind: 'composio',
  operationId: OPERATION_ID,
  providerIdentity: 'composio:workflow-write-fixture',
  providerVersion: 'fixture-provider-v1',
  operationVersion: '1',
  definitionFingerprint,
  externalDefinition: {
    version: 1,
    providerInputSchemaDigest,
    semanticName: OPERATION_ID,
    behaviorHints: {
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
  },
  effect: 'external_write',
  destination: { family: 'record_collection', posture: 'named_existing' },
  operationSemantics: { version: 1, reversibility: 'ordinary_non_destructive' },
  accountId: ACCOUNT_ID,
  idempotency: { required: true, policy: 'key_before_dispatch' },
  reconciliation: { supported: true, policy: 'provider_lookup' },
  outputContract: { kind: 'result' },
  purpose: 'invoke_live_operation',
  acceptedInputKinds: ['arguments'],
  producedOutputKinds: ['result'],
  applicableDeliverableKinds: ['result'],
  evidenceContract: { kinds: ['result'], readbackRequired: false },
  provenance: {
    issuer: 'host:test:authored-workflow-write',
    issuedAt: '2026-08-31T00:00:00.000Z',
    trusted: true,
  },
  lifecycle: { state: 'current' },
  advisoryRoles: ['destination'],
  argumentCompiler: { id: 'compile:proof-schema:v1', version: '1' },
  invokePortId: 'fixture:composio:invoke',
});
const manifestDigest = manifests.capabilityManifestDigest(manifest);
const observedAt = Date.now();
assert.deepEqual(observations.registerIndependentCapabilityObservation({
  operationId: OPERATION_ID,
  accountId: ACCOUNT_ID,
  definitionFingerprint,
  providerVersion: manifest.providerVersion,
  operationVersion: manifest.operationVersion,
  observedAt,
  origin: 'independent',
  observe: () => ({
    operationId: OPERATION_ID,
    accountId: ACCOUNT_ID,
    definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt,
  }),
}), { ok: true });
const entry = productionAdapters.registeredCapabilityFromManifest({
  manifest,
  observation: {
    definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    accountId: ACCOUNT_ID,
    observedAt,
  },
  invoke: async () => ({ successful: true, data: { updated: true } }),
});
const store = manifestStores.createCapabilityManifestStore([manifest], { durable: true });
const catalog = catalogs.createHostCapabilityCatalogFactory([entry]);
manifestStores.installCapabilityManifestStore(store);
catalogs.installHostCapabilityCatalogFactory(catalog);
const catalogIdentity = catalogs.canonicalCatalogIdentityOf(entry);
assert.ok(catalogIdentity);

let serial = 0;

function createRunFixture(
  kind: 'workflow' | 'chat' = 'workflow',
  authorOperation = true,
) {
  const suffix = String(++serial);
  const workflowRunId = `run-authored-write-${suffix}`;
  const workflowSlug = `authored-write-${suffix}`;
  const workflowName = `Authored Write ${suffix}`;
  const stepId = 'main';
  const attemptId = `attempt:workflow:${workflowRunId}:${stepId}`;
  const sessionId = `workflow:${workflowRunId}:${stepId}`;
  const planProposalId = `workflow:${workflowName}:${workflowRunId}:${stepId}`;
  const definition = {
    name: workflowName,
    description: 'Exercise exact unattended record authority.',
    enabled: true,
    trigger: { manual: true as const },
    // The operation is intentionally NOT in prompt prose. The immutable
    // effective allowlist is an equally authored exact operation source.
    steps: [{
      id: stepId,
      prompt: 'Update the already-bound review record and return a structured result.',
      sideEffect: 'write' as const,
      requiresApproval: false,
      allowedTools: authorOperation ? [OPERATION_ID] : [],
    }],
  };
  const snapshot = workflowDefinitions.createWorkflowRunDefinitionSnapshot(
    workflowSlug,
    definition,
    `2026-08-31T00:00:0${suffix}.000Z`,
  );
  mkdirSync(sharedTools.WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(sharedTools.WORKFLOW_RUNS_DIR, `${workflowRunId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: workflowRunId,
    workflow: workflowName,
    workflowDefinitionSnapshot: snapshot,
    status: 'running',
    inputs: {},
    createdAt: '2026-08-31T00:00:00.000Z',
    startedAt: '2026-08-31T00:00:01.000Z',
  }), 'utf8');
  const session = eventlog.createSession({
    id: sessionId,
    kind,
    channel: 'workflow',
    title: `${workflowName}::${stepId}`,
    metadata: {
      source: 'workflow',
      workflowName,
      workflowRunId,
      stepId,
    },
  });
  const attempt = eventlog.beginRunAttempt(session.id, {
    runId: `workflow-step:${workflowRunId}:${stepId}`,
    attemptId,
  });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: {
      text: definition.steps[0].prompt,
      workflowName,
      workflowRunId,
      stepId,
      attemptId,
    },
  });
  planScopes.openPlanScope({
    sessionId: session.id,
    planProposalId,
    approvedPlanObjective: `Approved workflow "${workflowName}" step "${stepId}"`,
    allowedTools: ['*'],
    ttlMs: 10 * 60_000,
  });
  const armed = callAuthority.armHostCallAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    catalogRevisionDigest: sha256(`catalog:${session.id}`),
    bindingRevisionDigest: sha256(`binding:${session.id}`),
    maxLogicalCalls: 16,
    maxParallelCalls: 4,
  });
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  const parentLease = leases.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::authored-write-test`,
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
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    parentLease,
  };
}

function toolFrame(callId: string): AgentInputItem[] {
  return [{
    type: 'function_call',
    callId,
    name: OPERATION_ID,
    arguments: JSON.stringify(PROVIDER_ARGS),
    status: 'completed',
  } as AgentInputItem];
}

function attestationFor(
  fixture: ReturnType<typeof createRunFixture>,
  callId: string,
): callAuthority.HostCallAttestation {
  const root = callAuthority.acceptedTurnCallAuthorityFor(
    fixture.session.id,
    fixture.source.seq,
  );
  assert.equal(root.status, 'ok', JSON.stringify(root));
  if (root.status !== 'ok') throw new Error(root.reason);
  const contract = logicalContracts.durableLogicalCallContract(
    fixture.acceptedTaskId,
    OPERATION_ID,
    PROVIDER_ARGS,
  );
  assert.ok(contract);
  if (!contract || !catalogIdentity) throw new Error('fixture identity is unavailable');
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
    capabilityId: catalogIdentity.capabilityId,
    providerInputSchemaDigest: catalogIdentity.providerInputSchemaDigest,
    schemaFingerprint: catalogIdentity.schemaDigest,
    accountId: catalogIdentity.account,
    invokePortId: catalogIdentity.invokePortId,
    operationId: catalogIdentity.operationId,
    manifestId: catalogIdentity.manifestId,
    manifestDigest: catalogIdentity.manifestDigest,
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

test('effective authored allowlist records exact authority and current batch projects a standing workflow grant', async () => {
  const fixture = createRunFixture();
  const invalidArgs = { record_id: 'record-49', wrong_field: 'review_status' };
  const invalid = entry.validateForegroundPayload?.(invalidArgs);
  assert.equal(invalid?.ok, false, JSON.stringify(invalid));
  if (invalid && !invalid.ok) {
    assert.equal(invalid.schemaAvailable, true);
    assert.match(invalid.repair, /field|unknown fields|required/i);
  }
  assert.equal(eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS count FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).get(fixture.session.id, fixture.source.seq).count, 0,
  'schema repair must happen before a physical crossing');
  const recorded = authorityAdapter.recordAuthoredWorkflowWriteAuthority({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    attemptId: fixture.attempt.attemptId,
    workflowRunId: fixture.workflowRunId,
    workflowSlug: fixture.workflowSlug,
    stepId: fixture.stepId,
    expectedPlanProposalId: fixture.planProposalId,
    catalogIdentities: [catalogIdentity!],
  });
  assert.equal(recorded.status, 'ready', JSON.stringify(recorded));

  const callId = 'call:authored-write:1';
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    preHistory: [{ role: 'user', content: fixture.snapshot.definition.steps[0].prompt } as AgentInputItem],
    frameHistory: toolFrame(callId),
    providerResponseId: 'response:authored-write:1',
  });
  assert.equal(admitted.status, 'admitted', JSON.stringify(admitted));
  if (admitted.status !== 'admitted') return;

  const attestation = attestationFor(fixture, callId);
  const pointer = planScopes.readAuthoredWorkflowWriteAuthorityScope(fixture.session.id);
  assert.ok(pointer, 'recording must install the durable non-granting receipt pointer');
  assert.equal(checkpoints.reopenAcceptedModelBatch(admitted.admission).status, 'open');
  const receiptEvent = eventlog.listEvents(fixture.session.id, {
    types: ['authored_workflow_write_authority'],
  })[0];
  assert.ok(receiptEvent);
  const receiptIdentity = (receiptEvent.data.catalogIdentities as unknown[])[0];
  assert.equal(
    canonicalJson.closedCanonicalJson(receiptIdentity),
    canonicalJson.closedCanonicalJson(catalogIdentity),
    'receipt canonicalization must preserve the exact current catalog identity',
  );
  const signals = externalRisk.deriveExternalCapabilityCallSignalsV1({
    version: 1,
    inputSchema: SCHEMA,
    arguments: PROVIDER_ARGS,
  });
  assert.equal(signals.status, 'projected', JSON.stringify(signals));
  if (signals.status !== 'projected') return;
  const risk = externalRisk.loadCatalogManifestExternalRiskAttestationV1({
    version: 1,
    binding: {
      bindingKind: 'catalog_manifest',
      capabilityId: attestation.capabilityId,
      providerInputSchemaDigest: attestation.providerInputSchemaDigest,
      schemaFingerprint: attestation.schemaFingerprint,
      accountId: attestation.accountId,
      invokePortId: attestation.invokePortId,
      operationId: attestation.operationId,
      manifestId: attestation.manifestId,
      manifestDigest: attestation.manifestDigest,
      effect: attestation.effect,
    },
    inputSchema: SCHEMA,
    destination: { posture: 'named_existing', digest: 'a'.repeat(64) },
    callSignals: signals.callSignals,
    safety: 'admissible',
  });
  assert.equal(risk.ok, true, JSON.stringify(risk));
  if (!risk.ok) return;
  assert.equal(risk.attestation.projection.risk.reversibility, 'ordinary_non_destructive');
  const evaluate = (
    candidateAttestation: callAuthority.HostCallAttestation = attestation,
    acceptedBatch = admitted.admission,
    args: Record<string, unknown> = PROVIDER_ARGS,
    callIndex = 0,
  ) => acceptedCatalogScope.withAcceptedSourceCatalogManifestScope({
    manifestIds: [catalogIdentity!.manifestId],
    operationIds: [catalogIdentity!.operationId],
  }, () => authorityAdapter.evaluateAuthoredWorkflowMutationConsent({
    attestation: candidateAttestation,
    args,
    acceptedBatch,
    callIndex,
  }));
  const evaluated = await evaluate();
  assert.equal(evaluated?.status, 'decided', JSON.stringify(evaluated));
  assert.equal(evaluated?.decision.kind, 'proceed', JSON.stringify(evaluated));
  if (evaluated?.decision.kind === 'proceed') {
    assert.equal(evaluated.decision.basis, 'exact_user_grant');
    assert.match(evaluated.decision.authorityDigest, /^[a-f0-9]{64}$/);
  }
  assert.equal(evaluated?.call.argumentDigest, sha256(canonicalJson.closedCanonicalJson(PROVIDER_ARGS)),
    'provider arguments, not an outer carrier envelope, own exact consent');
  assert.equal(evaluated?.coverage.callBinding.logicalToolCallId, callId);

  for (const [label, candidate] of [
    ['wrong account', { ...attestation, accountId: 'account:foreign' }],
    ['wrong effect', { ...attestation, effect: 'admin' as const }],
    ['wrong source', { ...attestation, sourceUserSeq: attestation.sourceUserSeq + 1 }],
    ['wrong manifest', { ...attestation, manifestId: 'cap:foreign:manifest' }],
    ['wrong operation', { ...attestation, operationId: 'FOREIGN_RECORDS_UPDATE_RECORD' }],
    ['wrong invoke port', { ...attestation, invokePortId: 'fixture:foreign:invoke' }],
  ] as const) {
    assert.equal(await evaluate(candidate as callAuthority.HostCallAttestation), null, label);
  }
  assert.equal(await evaluate(attestation, {
    ...admitted.admission,
    batchId: `batch:foreign:${admitted.admission.batchId}`,
  }), null, 'a forged/stale accepted batch reference grants nothing');
  assert.equal(await evaluate(attestation, admitted.admission, PROVIDER_ARGS, 1), null,
    'a different call ordinal in the same batch grants nothing');

  const originalDestination = entry.destination;
  entry.destination = { family: 'foreign_collection', posture: 'named_existing' };
  assert.equal(await evaluate(), null, 'current catalog destination drift grants nothing');
  entry.destination = originalDestination;

  const changedDefinition = {
    ...fixture.snapshot.definition,
    steps: fixture.snapshot.definition.steps.map((step) => (
      step.id === fixture.stepId ? { ...step, prompt: `${step.prompt} Changed after admission.` } : step
    )),
  };
  const changedSnapshot = workflowDefinitions.createWorkflowRunDefinitionSnapshot(
    fixture.workflowSlug,
    changedDefinition,
    '2026-08-31T00:05:00.000Z',
  );
  writeFileSync(fixture.runFile, JSON.stringify({
    id: fixture.workflowRunId,
    workflow: fixture.workflowName,
    workflowDefinitionSnapshot: changedSnapshot,
    status: 'running',
    inputs: {},
  }), 'utf8');
  assert.equal(await evaluate(), null, 'changed workflow definition/admission hash grants nothing');
  writeFileSync(fixture.runFile, JSON.stringify({
    id: fixture.workflowRunId,
    workflow: fixture.workflowName,
    workflowDefinitionSnapshot: fixture.snapshot,
    status: 'running',
    inputs: {},
  }), 'utf8');

  planScopes.openPlanScope({
    sessionId: fixture.session.id,
    planProposalId: fixture.planProposalId,
    approvedPlanObjective: 'A wildcard plan alone is not authored write authority.',
    allowedTools: ['*'],
    ttlMs: 10 * 60_000,
  });
  assert.equal(await evaluate(), null, 'wildcard PlanScope alone grants nothing');
  assert.equal(authorityAdapter.recordAuthoredWorkflowWriteAuthority({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    attemptId: fixture.attempt.attemptId,
    workflowRunId: fixture.workflowRunId,
    workflowSlug: fixture.workflowSlug,
    stepId: fixture.stepId,
    expectedPlanProposalId: fixture.planProposalId,
    catalogIdentities: [catalogIdentity!],
  }).status, 'ready', 'the exact immutable receipt may safely reinstall its pointer');
  assert.equal((await evaluate())?.decision.kind, 'proceed');

  let bodies = 0;
  const context = {
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(16),
    dispatchLease: fixture.parentLease,
  } satisfies brackets.HarnessRunContext;
  const invoke = () => callAuthority.withHostCallAttestation(attestation, () =>
    brackets.withHarnessRunContext(context, () => hostInvocation.invokeHostToolCall({
      identity: {
        sessionId: fixture.session.id,
        sourceUserSeq: fixture.source.seq,
        modelCallId: callId,
        toolName: OPERATION_ID,
        args: PROVIDER_ARGS,
        turn: 1,
      },
      parentLease: fixture.parentLease,
      effect: 'external_write',
      boundary: 'host_owned_external',
      deadlineMs: 500,
      invoke: async () => {
        bodies += 1;
        return { successful: true, data: { updated: true } };
      },
    })));
  const first = await invoke();
  assert.equal(first.settlement.duplicate, false);
  assert.equal(bodies, 1);
  assert.equal(eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS count FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(fixture.session.id, fixture.source.seq, callId).count, 1);

  const replayConsent = await evaluate();
  assert.equal(replayConsent?.decision.kind, 'proceed', JSON.stringify(replayConsent));
  if (replayConsent?.decision.kind === 'proceed') {
    assert.equal(replayConsent.decision.basis, 'settled_replay');
  }
  const replay = await invoke();
  assert.equal(replay.settlement.duplicate, true);
  assert.equal(bodies, 1, 'the same admitted occurrence must not enter the provider body twice');
  assert.equal(eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS count FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(fixture.session.id, fixture.source.seq, callId).count, 1);
  leases.revokeDispatchLease(fixture.parentLease);
});

test('forged workflow metadata on an ordinary chat cannot record authored write authority', () => {
  const fixture = createRunFixture('chat');
  const recorded = authorityAdapter.recordAuthoredWorkflowWriteAuthority({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    attemptId: fixture.attempt.attemptId,
    workflowRunId: fixture.workflowRunId,
    workflowSlug: fixture.workflowSlug,
    stepId: fixture.stepId,
    expectedPlanProposalId: fixture.planProposalId,
    catalogIdentities: [catalogIdentity!],
  });
  assert.deepEqual(recorded, {
    status: 'refused',
    reason: 'workflow_session_owner_mismatch',
  });
  leases.revokeDispatchLease(fixture.parentLease);
});

test('a current but foreign operation absent from immutable prompt and allowlists cannot get a receipt', () => {
  const fixture = createRunFixture('workflow', false);
  const recorded = authorityAdapter.recordAuthoredWorkflowWriteAuthority({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    attemptId: fixture.attempt.attemptId,
    workflowRunId: fixture.workflowRunId,
    workflowSlug: fixture.workflowSlug,
    stepId: fixture.stepId,
    expectedPlanProposalId: fixture.planProposalId,
    catalogIdentities: [catalogIdentity!],
  });
  assert.deepEqual(recorded, {
    status: 'refused',
    reason: 'write_operation_not_authored_in_immutable_step',
  });
  leases.revokeDispatchLease(fixture.parentLease);
});
