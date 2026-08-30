/** Run: node scripts/run-tests-isolated.mjs src/execution/automation-pilot-advancement-control-plane.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-pilot-advancement-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const advancement = await import('./automation-pilot-advancement-control-plane.js');
const opportunities = await import('./automation-opportunity.js');
const opportunityStore = await import('./automation-opportunity-store.js');
const review = await import('./automation-opportunity-review-control-plane.js');
const workspaceControl = await import('./automation-read-pilot-workspace-control-plane.js');
const pilot = await import('./automation-read-pilot-control-plane.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const materializer = await import('../runtime/harness/live-capability-materializer.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const shipped = await import('../runtime/harness/shipped-implementation-identity.js');
const spaces = await import('../spaces/store.js');
const resultProjections = await import('../memory/workflow-result-projection-contract.js');
import type { AutomationOpportunityV1 } from './automation-opportunity.js';
import type { AutomationOpportunityProposalRecordV1 } from './automation-opportunity-store.js';
import type { AutomationReadPilotCapabilityAcquisitionPortV1 } from './automation-read-pilot-control-plane.js';

let sequence = 0;
function unique(label: string): string {
  sequence += 1;
  return `${label}.${sequence}`;
}

function opportunity(label: string, dataset = true): AutomationOpportunityV1 {
  return opportunities.parseAutomationOpportunity({
    version: 1,
    title: `Bounded ${label} collection`,
    objective: `Collect one bounded ${label} result with exact evidence.`,
    rationale: 'A one-shot pilot should prove the reviewed read contract.',
    lifetime: { kind: 'ongoing' },
    recurrence: {
      mode: 'proposed',
      cadence: { kind: 'interval', every: 2, unit: 'hour' },
      overlapPolicy: 'skip',
      catchUpPolicy: 'run_once',
      activation: 'requires_pilot_success_and_recurrence_consent',
    },
    trigger: { kind: 'recurrence' },
    partition: {
      mode: 'single',
      checkpointEvery: 1,
      completion: { kind: 'terminal_evidence', evidence: ['The records collection is present.'] },
    },
    capabilityRequirements: [{
      id: 'bounded-read',
      description: `retrieve exact ${label} records`,
      minimumEffect: 'read',
      constraints: ['Return a bounded records collection.'],
    }],
    phases: [{
      id: 'read-result',
      objective: 'Retrieve the exact bounded records.',
      dependsOn: [],
      capabilityRequirementIds: ['bounded-read'],
      effect: { class: 'read', approval: 'not_required', maxOperationsPerRun: 1 },
      partitioned: false,
      outputEvidence: ['The records collection is non-empty.'],
    }],
    effectCeiling: { class: 'read', maxOperationsPerRun: 1 },
    ...(dataset ? {
      dataset: {
        schema: {
          fields: [
            { name: 'key', type: 'string', required: true, sensitivity: 'public' },
            { name: 'scope', type: 'string', required: true, sensitivity: 'internal' },
          ],
          additionalFields: 'reject',
        },
        identity: {
          rules: [{ id: 'by-key', fields: ['key'], match: 'exact', normalizers: ['trim'] }],
          ambiguousMatch: 'review_required',
        },
        merge: {
          mode: 'review_required',
          defaultConflict: 'review_required',
          fieldPolicies: [],
          preserveSourceRecords: true,
        },
        provenance: {
          required: true,
          retainSourceSnapshots: true,
          requiredReferences: ['source_ref', 'run_ref', 'observed_at'],
        },
      },
    } : {}),
    deliverables: [{
      id: 'result',
      description: 'The bounded result.',
      kind: dataset ? 'dataset_snapshot' : 'artifact',
      required: true,
      successCriterionIds: ['complete'],
      evidence: ['The records collection is present.'],
    }],
    missingInputs: [],
    successCriteria: [{
      id: 'complete',
      description: 'The bounded result is complete.',
      evidence: ['The records collection is non-empty.'],
    }],
    pilot: {
      required: true,
      maxPartitions: 1,
      maxRecords: 10,
      effectCeiling: { class: 'read', maxOperationsPerRun: 1 },
      successCriterionIds: ['complete'],
      haltOnFailure: true,
    },
    budgets: {
      maxWallClockMinutesPerRun: 5,
      maxConcurrentPartitions: 1,
      maxAttemptsPerPartition: 1,
      maxPartitionsPerRun: 1,
      maxRecordsPerRun: 10,
      maxOperationsPerRun: 1,
      reserveOperations: 0,
    },
  });
}

function approvedReview(label: string, dataset = true): {
  sessionId: string;
  proposal: AutomationOpportunityProposalRecordV1;
  projection: review.AutomationOpportunityReviewProjectionV1;
} {
  const sessionId = unique('chat');
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const created = opportunityStore.createAutomationOpportunityProposal({
    proposalId: unique('proposal').replaceAll('.', '_'),
    opportunity: opportunity(label, dataset),
    actorRef: `accepted-source:${sessionId}#1`,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) throw new Error(created.message);
  const requested = review.registerAutomationOpportunityReviewProjection({
    proposalId: created.record.proposalId,
    expectedProposalRevision: created.record.revision,
    expectedProposalDigest: created.record.digest,
    approvalSessionId: sessionId,
    requestSourceUserSeq: 1,
  });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  if (!requested.ok) throw new Error(requested.reason);
  assert.equal(approvals.resolve(
    requested.approval.approvalId,
    'approved',
    `human.${label}`,
  ).ok, true);
  const reconciled = review.reconcileAutomationOpportunityReviewProjection(
    requested.projection.projectionId,
  );
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  if (!reconciled.ok) throw new Error(reconciled.reason);
  assert.equal(reconciled.state, 'approved');
  return {
    sessionId,
    proposal: reconciled.proposal,
    projection: reconciled.projection,
  };
}

function finiteEnumerationOpportunity(label: string): AutomationOpportunityV1 {
  const base = opportunity(label);
  return opportunities.parseAutomationOpportunity({
    ...base,
    objective: `Enumerate and process every reviewed ${label} partition.`,
    partition: {
      mode: 'finite',
      keyFields: ['key'],
      dimensions: ['record'],
      checkpointEvery: 2,
      completion: { kind: 'exact_count', expected: 4 },
    },
    capabilityRequirements: [
      ...base.capabilityRequirements,
      {
        id: 'partition-read',
        description: `read one exact ${label} partition`,
        minimumEffect: 'read',
        constraints: ['Use the normalized partition identity.'],
      },
    ],
    phases: [
      { ...base.phases[0]!, id: 'enumerate', objective: 'Enumerate the exact closed partition scope.' },
      {
        id: 'process-partition',
        objective: 'Process one exact normalized partition.',
        dependsOn: ['enumerate'],
        capabilityRequirementIds: ['partition-read'],
        effect: { class: 'read', approval: 'not_required', maxOperationsPerRun: 4 },
        partitioned: true,
        outputEvidence: ['The exact partition has a durable settlement.'],
      },
    ],
    effectCeiling: { class: 'read', maxOperationsPerRun: 5 },
    successCriteria: [
      {
        id: 'enumeration-closed',
        description: 'Step "enumerate" output includes required keys: version, kind, activationId, authorityRootId, logicalCallId',
        evidence: ['The pilot enumeration has one exact closed result authority.'],
      },
      {
        id: 'complete',
        description: 'All four normalized partitions settle.',
        evidence: ['The partition ledger contains four unique terminal partitions.'],
      },
    ],
    pilot: {
      ...base.pilot,
      successCriterionIds: ['enumeration-closed'],
    },
    budgets: {
      ...base.budgets,
      maxConcurrentPartitions: 2,
      maxAttemptsPerPartition: 2,
      maxPartitionsPerRun: 4,
      maxRecordsPerRun: 10,
      maxOperationsPerRun: 5,
      reserveOperations: 1,
    },
  });
}

function approvedReviewForOpportunity(
  label: string,
  reviewedOpportunity: AutomationOpportunityV1,
): {
  sessionId: string;
  proposal: AutomationOpportunityProposalRecordV1;
  projection: review.AutomationOpportunityReviewProjectionV1;
} {
  const sessionId = unique('chat');
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const created = opportunityStore.createAutomationOpportunityProposal({
    proposalId: unique('proposal').replaceAll('.', '_'),
    opportunity: reviewedOpportunity,
    actorRef: `accepted-source:${sessionId}#1`,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) throw new Error(created.message);
  const requested = review.registerAutomationOpportunityReviewProjection({
    proposalId: created.record.proposalId,
    expectedProposalRevision: created.record.revision,
    expectedProposalDigest: created.record.digest,
    approvalSessionId: sessionId,
    requestSourceUserSeq: 1,
  });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  if (!requested.ok) throw new Error(requested.reason);
  assert.equal(approvals.resolve(
    requested.approval.approvalId,
    'approved',
    `human.${label}`,
  ).ok, true);
  const reconciled = review.reconcileAutomationOpportunityReviewProjection(
    requested.projection.projectionId,
  );
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  if (!reconciled.ok) throw new Error(reconciled.reason);
  assert.equal(reconciled.state, 'approved');
  return {
    sessionId,
    proposal: reconciled.proposal,
    projection: reconciled.projection,
  };
}

function approvalCardCount(sessionId: string): number {
  return (eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS count FROM events
     WHERE session_id = ? AND type = 'approval_requested'
  `).get(sessionId) as { count: number }).count;
}

function acquisitionFixture(label: string): {
  acquisition: AutomationReadPilotCapabilityAcquisitionPortV1;
  acquisitions(): number;
  businessInvokes(): number;
} {
  const operationId = unique(`operation.${label}`);
  const accountId = unique(`account.${label}`);
  const providerIdentity = unique(`runtime.${label}`);
  const portId = unique(`port.${label}`);
  const compilerId = unique(`compiler.${label}`);
  let acquisitionCount = 0;
  let bodyCount = 0;
  const carrier: materializer.LiveCapabilityCarrier = {
    identity: { kind: 'host', name: unique(`carrier.${label}`) },
    async enumerate() {
      return [{
        identifier: operationId,
        carrierKind: 'host' as const,
        carrier: carrier.identity.name,
        displayName: `Bounded ${label} records`,
        description: `retrieve exact ${label} records`,
        effectClass: 'read' as const,
        effectProvenance: 'declared' as const,
        accountIdentity: accountId,
      }];
    },
    async refresh() {},
    observe(reference) {
      if (reference.identifier !== operationId || reference.accountId !== accountId) return 'missing';
      return {
        operationId,
        providerKind: 'local_registry',
        providerIdentity,
        providerVersion: '1',
        operationVersion: '1',
        accountId,
        effect: 'read',
        effectAttestation: 'carrier_declared',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { scope: { type: 'string' } },
          required: ['scope'],
        },
        observedAt: Date.now(),
        invoke: { portId, argumentCompiler: { id: compilerId, version: '1' } },
      };
    },
  };
  const factory = catalogs.createHostCapabilityCatalogFactory();
  const store = manifestStores.createCapabilityManifestStore();
  catalogs.installHostCapabilityCatalogFactory(factory);
  manifestStores.installCapabilityManifestStore(store);
  return {
    acquisition: {
      async acquire(request) {
        acquisitionCount += 1;
        return materializer.materializeLiveReadCapability({
          objective: request.objective,
          carrier,
          factory,
          store,
          registerPort: ({ manifest, attestation }) => {
            if (ports.resolveProductionPortsForManifest(manifest)) return { ok: true as const };
            shipped.loadShippedImplementations().registerIsolatedObservation({
              operationId: attestation.reference.identifier,
              accountId: attestation.accountId,
              definitionFingerprint: attestation.definitionFingerprint,
              providerVersion: attestation.providerVersion,
              operationVersion: attestation.operationVersion,
              observedAt: Date.now(),
            });
            return ports.registerFixtureCapabilityPort(
              ports.productionPortIdentityFromManifest(manifest),
              {
                invoke: async () => {
                  bodyCount += 1;
                  return { records: [{ key: `record.${label}`, scope: label }] };
                },
              },
            );
          },
        });
      },
    },
    acquisitions: () => acquisitionCount,
    businessInvokes: () => bodyCount,
  };
}

function authoringResult(input: {
  request: advancement.AutomationPilotAuthoringRequestV1;
  requestDigest: string;
}): advancement.AutomationPilotAuthoringResultV1 {
  const selection = input.request.workspaceSelection;
  return {
    version: 1,
    requestId: input.request.requestId,
    requestDigest: input.requestDigest,
    contract: {
      phaseId: input.request.requirement.phaseId,
      requirementId: input.request.requirement.requirementId,
      workflowInputs: { scope: { type: 'string', required: true } },
      arguments: {
        scope: {
          source: { kind: 'workflow_input', key: 'scope' },
          required: true,
          type: 'string',
        },
      },
      evidence: {
        requiredPaths: ['records'],
        nonEmptyPaths: ['records'],
        minItems: { records: 1 },
      },
      completeness: { kind: 'terminal_result', evidencePaths: ['records'] },
      ...(selection ? {
        resultProjection: resultProjections.createWorkflowCanonicalEntityResultProjection({
          recordsPath: 'records',
          fields: [
            { field: 'key', recordPath: 'key', type: 'string', required: true, sensitivity: 'public', confidence: 1 },
            { field: 'scope', recordPath: 'scope', type: 'string', required: true, sensitivity: 'internal', confidence: 1 },
          ],
          sourceRecord: { idPath: 'key', observedAt: { kind: 'page_settled_at' } },
          entityKind: 'generic-record',
          identityRules: [{
            ruleId: 'by-key',
            fields: ['key'],
            normalizers: ['trim'],
            exactIdentifierNamespace: 'generic-key',
          }],
          resolutionPolicy: {
            policyId: 'exact-generic-key',
            mergeThreshold: 10,
            distinctThreshold: 2,
            ambiguityMargin: 1,
            weights: {
              defaultExactIdentifierMatch: 10,
              defaultCompoundSignalMatch: 0,
            },
          },
          fieldResolution: {
            kind: 'retain_all_evidence',
            selection: 'highest_confidence_then_newest',
            conflict: 'mark_conflicting_for_review',
          },
          provenance: { kind: 'workflow_page_record', retainSourceSnapshots: true },
          partition: {
            kind: 'workflow_run',
            coverageItems: 'source_record_occurrences',
            denominator: 'settled_record_count',
            completion: 'closed_authority_exhaustion',
          },
          bounds: {
            maxPages: 1,
            maxRecordsPerPage: 10,
            maxRecords: 10,
            maxPageBytes: 100_000,
            maxRecordBytes: 10_000,
            maxTotalBytes: 100_000,
          },
        }),
        workspaceBindingSelection: structuredClone(selection),
      } : {}),
    },
    workflowInputs: { scope: 'bounded.scope' },
  };
}

function trustedAuthority(): advancement.AutomationPilotWorkspaceDecisionAuthorityV1 {
  return { verify: () => ({ ok: true }) };
}

test.afterEach(() => {
  advancement.automationPilotAdvancementControlPlaneInternalsForTest.setAfterPilotRegistrationHook();
  workspaceControl.automationReadPilotWorkspaceControlPlaneInternalsForTest.setAfterWorkspaceSaveHook();
  workspaceControl.automationReadPilotWorkspaceControlPlaneInternalsForTest.setBeforeWorkspaceCreateHook();
  for (const workspace of spaces.spaceStore.list(true)) spaces.spaceStore.remove(workspace.id);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
});

test.after(() => {
  opportunityStore.closeAutomationOpportunityStoreForTests();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('zero-Workspace approval advances automatically to authoring, then stages exactly one ordinary pilot card', async () => {
  const source = approvedReview('zero-workspace');
  const live = acquisitionFixture('zero-workspace');
  const registered = advancement.registerAutomationPilotAdvancement({
    reviewProjectionId: source.projection.projectionId,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) return;
  assert.equal(registered.projection.stage, 'workspace_creation_pending');
  assert.equal(live.acquisitions(), 0);

  const pendingWorkspace = await advancement.reconcileAutomationPilotAdvancement(
    registered.projection.advancementId,
    { acquisition: live.acquisition },
  );
  assert.equal(pendingWorkspace.ok, true, JSON.stringify(pendingWorkspace));
  if (!pendingWorkspace.ok) return;
  assert.equal(pendingWorkspace.projection.stage, 'workspace_creation_pending');
  assert.equal(live.acquisitions(), 0, 'no capability metadata is acquired before Workspace creation approval');
  const creation = workspaceControl.loadAutomationReadPilotWorkspaceCreation(
    pendingWorkspace.projection.workspaceCreationProjectionId!,
  )!;
  assert.equal(creation.status, 'approval_pending');
  assert.ok(creation.approvalId);
  assert.equal(approvals.resolve(creation.approvalId!, 'approved', 'human.workspace').ok, true);

  const authored = await advancement.reconcileAutomationPilotAdvancement(
    registered.projection.advancementId,
    { acquisition: live.acquisition },
  );
  assert.equal(authored.ok, true, JSON.stringify(authored));
  if (!authored.ok) return;
  assert.equal(authored.projection.stage, 'authoring_required');
  assert.ok(authored.projection.workspaceSelection);
  assert.equal(live.acquisitions(), 1);
  assert.equal(live.businessInvokes(), 0);

  const claimed = advancement.claimAutomationPilotAuthoringRequest({
    advancementId: authored.projection.advancementId,
    expectedStateRevision: authored.projection.stateRevision,
    expectedStateDigest: authored.projection.stateDigest,
    workerId: 'worker.authoring',
    leaseMs: 60_000,
  });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  if (!claimed.ok) return;
  const submitted = advancement.submitAutomationPilotAuthoringResult({
    advancementId: claimed.projection.advancementId,
    expectedStateRevision: claimed.projection.stateRevision,
    expectedStateDigest: claimed.projection.stateDigest,
    claimId: claimed.claim.claimId,
    result: authoringResult(claimed),
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  if (!submitted.ok) return;
  assert.equal(submitted.projection.stage, 'pilot_registering');

  const pilotPending = await advancement.reconcileAutomationPilotAdvancement(
    submitted.projection.advancementId,
    { acquisition: live.acquisition },
  );
  assert.equal(pilotPending.ok, true, JSON.stringify(pilotPending));
  if (!pilotPending.ok) return;
  assert.equal(pilotPending.projection.stage, 'pilot_approval_pending');
  assert.equal(live.acquisitions(), 2, 'registration refreshes and rechecks the exact acquired identity');
  assert.equal(live.businessInvokes(), 0);
  const pilotProjection = pilot.loadAutomationReadPilotProjection(
    pilotPending.projection.pilotProjectionId!,
  )!;
  assert.equal(pilotProjection.status, 'approval_pending');
  assert.ok(pilotProjection.approvalId);
  const cardsBeforeReplay = approvalCardCount(source.sessionId);
  const replay = await advancement.reconcileAutomationPilotAdvancement(
    submitted.projection.advancementId,
    { acquisition: live.acquisition },
  );
  assert.equal(replay.ok, true);
  assert.equal(approvalCardCount(source.sessionId), cardsBeforeReplay);

  assert.equal(approvals.resolve(pilotProjection.approvalId!, 'approved', 'human.pilot').ok, true);
  const queuedPilot = pilot.reconcileAutomationReadPilotProjection(pilotProjection.projectionId);
  assert.equal(queuedPilot.ok, true, JSON.stringify(queuedPilot));
  if (queuedPilot.ok) assert.equal(queuedPilot.state, 'queued');
  const queued = await advancement.reconcileAutomationPilotAdvancement(
    submitted.projection.advancementId,
    { acquisition: live.acquisition },
  );
  assert.equal(queued.ok, true, JSON.stringify(queued));
  if (queued.ok) assert.equal(queued.projection.stage, 'queued');
  assert.equal(live.businessInvokes(), 0, 'queue admission is not a provider business read');
});

test('a finite proposal pilots only its sole closed enumeration before partition fan-out', async () => {
  spaces.spaceStore.save({ id: 'finite-enumeration-workspace', title: 'Finite enumeration' });
  const source = approvedReviewForOpportunity(
    'finite-enumeration',
    finiteEnumerationOpportunity('finite-enumeration'),
  );
  const live = acquisitionFixture('finite-enumeration');
  const registered = advancement.registerAutomationPilotAdvancement({
    reviewProjectionId: source.projection.projectionId,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) return;
  assert.equal(registered.projection.stage, 'workspace_destination_required');
  const option = registered.projection.workspaceOptions?.find(
    (candidate) => candidate.workspaceId === 'finite-enumeration-workspace',
  );
  assert.ok(option);
  const selected = advancement.recordAutomationPilotWorkspaceDestination({
    advancementId: registered.projection.advancementId,
    receipt: {
      version: 1,
      advancementId: registered.projection.advancementId,
      expectedStateRevision: registered.projection.stateRevision,
      expectedStateDigest: registered.projection.stateDigest,
      choice: { kind: 'existing', workspace: structuredClone(option!) },
      actorRef: 'human.finite-enumeration',
      decidedAt: new Date().toISOString(),
      nonce: unique('choice'),
    },
    authority: trustedAuthority(),
  });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  if (!selected.ok) return;
  const authored = await advancement.reconcileAutomationPilotAdvancement(
    selected.projection.advancementId,
    { acquisition: live.acquisition },
  );
  assert.equal(authored.ok, true, JSON.stringify(authored));
  if (!authored.ok) return;
  assert.equal(authored.projection.stage, 'authoring_required');
  assert.equal(authored.projection.authoringRequest?.requirement.phaseId, 'enumerate');
  assert.equal(authored.projection.authoringRequest?.requirement.requirementId, 'bounded-read');
  const claimed = advancement.claimAutomationPilotAuthoringRequest({
    advancementId: authored.projection.advancementId,
    expectedStateRevision: authored.projection.stateRevision,
    expectedStateDigest: authored.projection.stateDigest,
    workerId: 'worker.finite-enumeration',
    leaseMs: 60_000,
  });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  if (!claimed.ok) return;
  const submitted = advancement.submitAutomationPilotAuthoringResult({
    advancementId: claimed.projection.advancementId,
    expectedStateRevision: claimed.projection.stateRevision,
    expectedStateDigest: claimed.projection.stateDigest,
    claimId: claimed.claim.claimId,
    result: authoringResult(claimed),
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  if (!submitted.ok) return;
  const pilotPending = await advancement.reconcileAutomationPilotAdvancement(
    submitted.projection.advancementId,
    { acquisition: live.acquisition },
  );
  assert.equal(pilotPending.ok, true, JSON.stringify(pilotPending));
  if (!pilotPending.ok) return;
  assert.equal(
    pilotPending.projection.stage,
    'pilot_approval_pending',
    JSON.stringify(pilotPending.projection),
  );
  assert.equal(live.businessInvokes(), 0, 'source pilot registration still performs no business read');
});

test('existing Workspaces require an exact verified human choice and never select by title or order', async () => {
  spaces.spaceStore.save({ id: 'zeta-workspace', title: 'Same title' });
  spaces.spaceStore.save({ id: 'alpha-workspace', title: 'Same title' });
  const source = approvedReview('existing-choice');
  const registered = advancement.registerAutomationPilotAdvancement({
    reviewProjectionId: source.projection.projectionId,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) return;
  assert.equal(registered.projection.stage, 'workspace_destination_required');
  assert.deepEqual(
    registered.projection.workspaceOptions?.map((option) => option.workspaceId),
    ['alpha-workspace', 'zeta-workspace'],
  );
  assert.equal(registered.projection.workspaceSelection, undefined);

  const chosen = registered.projection.workspaceOptions![1]!;
  const receipt: advancement.AutomationPilotWorkspaceDestinationDecisionReceiptV1 = {
    version: 1,
    advancementId: registered.projection.advancementId,
    expectedStateRevision: registered.projection.stateRevision,
    expectedStateDigest: registered.projection.stateDigest,
    choice: { kind: 'existing', workspace: structuredClone(chosen) },
    actorRef: 'human.workspace-chooser',
    decidedAt: new Date().toISOString(),
    nonce: unique('choice'),
  };
  const unverified = advancement.recordAutomationPilotWorkspaceDestination({
    advancementId: registered.projection.advancementId,
    receipt,
    authority: { verify: () => ({ ok: false, reason: 'not a host UI receipt' }) },
  });
  assert.equal(unverified.ok, false);
  if (!unverified.ok) assert.equal(unverified.code, 'workspace_destination_unverified');
  assert.equal(
    advancement.loadAutomationPilotAdvancement(registered.projection.advancementId)?.stage,
    'workspace_destination_required',
  );

  const selected = advancement.recordAutomationPilotWorkspaceDestination({
    advancementId: registered.projection.advancementId,
    receipt,
    authority: trustedAuthority(),
  });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  if (!selected.ok) return;
  assert.equal(selected.projection.stage, 'acquisition_pending');
  assert.equal(selected.projection.workspaceSelection?.workspaceId, 'zeta-workspace');
  assert.equal(selected.projection.workspaceDecision?.actorRef, 'human.workspace-chooser');
});

test('Workspace revision drift refuses the offered choice before acquisition', () => {
  spaces.spaceStore.save({ id: 'drift-workspace', title: 'Before' });
  const source = approvedReview('workspace-drift');
  const registered = advancement.registerAutomationPilotAdvancement({
    reviewProjectionId: source.projection.projectionId,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) return;
  const option = registered.projection.workspaceOptions![0]!;
  spaces.spaceStore.save({ id: option.workspaceId, title: 'After' });
  const refused = advancement.recordAutomationPilotWorkspaceDestination({
    advancementId: registered.projection.advancementId,
    receipt: {
      version: 1,
      advancementId: registered.projection.advancementId,
      expectedStateRevision: registered.projection.stateRevision,
      expectedStateDigest: registered.projection.stateDigest,
      choice: { kind: 'existing', workspace: structuredClone(option) },
      actorRef: 'human.workspace-drift',
      decidedAt: new Date().toISOString(),
      nonce: unique('choice'),
    },
    authority: trustedAuthority(),
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, 'workspace_selection_drift');
  assert.equal(
    advancement.loadAutomationPilotAdvancement(registered.projection.advancementId)?.stage,
    'workspace_destination_required',
  );
});

test('missing and ambiguous registry-wide acquisition fail closed with no authoring request', async (t) => {
  for (const reason of ['missing', 'ambiguous'] as const) {
    await t.test(reason, async () => {
      const source = approvedReview(`acquisition-${reason}`, false);
      const registered = advancement.registerAutomationPilotAdvancement({
        reviewProjectionId: source.projection.projectionId,
      });
      assert.equal(registered.ok, true, JSON.stringify(registered));
      if (!registered.ok) return;
      assert.equal(registered.projection.stage, 'acquisition_pending');
      const reconciled = await advancement.reconcileAutomationPilotAdvancement(
        registered.projection.advancementId,
        {
          acquisition: {
            async acquire() {
              return { status: 'blocked' as const, reason, detail: `${reason} exact read`, retired: [] };
            },
          },
        },
      );
      assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
      if (!reconciled.ok) return;
      assert.equal(reconciled.projection.stage, 'blocked');
      assert.equal(reconciled.projection.blocked?.code, `capability_acquisition_${reason}`);
      assert.equal(reconciled.projection.blocked?.detail, `${reason} exact read`);
      assert.equal(reconciled.projection.authoringRequest, undefined);
    });
  }
});

test('authoring leases reject stale or malformed results and crash replay cannot duplicate the pilot card', async () => {
  const workspace = spaces.spaceStore.save({ id: 'lease-workspace', title: 'Lease target' });
  const source = approvedReview('lease-crash');
  const live = acquisitionFixture('lease-crash');
  const registered = advancement.registerAutomationPilotAdvancement({
    reviewProjectionId: source.projection.projectionId,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) return;
  const option = registered.projection.workspaceOptions?.find((item) => item.workspaceId === workspace.id)!;
  const selected = advancement.recordAutomationPilotWorkspaceDestination({
    advancementId: registered.projection.advancementId,
    receipt: {
      version: 1,
      advancementId: registered.projection.advancementId,
      expectedStateRevision: registered.projection.stateRevision,
      expectedStateDigest: registered.projection.stateDigest,
      choice: { kind: 'existing', workspace: structuredClone(option) },
      actorRef: 'human.lease-choice',
      decidedAt: new Date().toISOString(),
      nonce: unique('choice'),
    },
    authority: trustedAuthority(),
  });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  if (!selected.ok) return;
  const authored = await advancement.reconcileAutomationPilotAdvancement(
    selected.projection.advancementId,
    { acquisition: live.acquisition },
  );
  assert.equal(authored.ok, true, JSON.stringify(authored));
  if (!authored.ok) return;
  const claimedAt = Date.UTC(2026, 7, 22, 12, 0, 0);
  const first = advancement.claimAutomationPilotAuthoringRequest({
    advancementId: authored.projection.advancementId,
    expectedStateRevision: authored.projection.stateRevision,
    expectedStateDigest: authored.projection.stateDigest,
    workerId: 'worker.first',
    leaseMs: 5_000,
    nowMs: claimedAt,
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  if (!first.ok) return;
  const activeReplay = advancement.claimAutomationPilotAuthoringRequest({
    advancementId: first.projection.advancementId,
    expectedStateRevision: first.projection.stateRevision,
    expectedStateDigest: first.projection.stateDigest,
    workerId: 'worker.first',
    leaseMs: 5_000,
    nowMs: claimedAt + 1,
  });
  assert.equal(activeReplay.ok, false);
  if (!activeReplay.ok) assert.equal(activeReplay.code, 'authoring_already_claimed');
  assert.equal(
    advancement.loadAutomationPilotAdvancement(first.projection.advancementId)?.authoringAttemptCount,
    1,
    'an active lease cannot be replayed into a duplicate model call even by the same worker id',
  );
  const second = advancement.claimAutomationPilotAuthoringRequest({
    advancementId: first.projection.advancementId,
    expectedStateRevision: first.projection.stateRevision,
    expectedStateDigest: first.projection.stateDigest,
    workerId: 'worker.second',
    leaseMs: 60_000,
    nowMs: claimedAt + 5_001,
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  if (!second.ok) return;
  const stale = advancement.submitAutomationPilotAuthoringResult({
    advancementId: second.projection.advancementId,
    expectedStateRevision: first.projection.stateRevision,
    expectedStateDigest: first.projection.stateDigest,
    claimId: first.claim.claimId,
    result: authoringResult(first),
    nowMs: claimedAt + 5_002,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, 'authoring_submission_unclaimed');

  const malformed = authoringResult(second);
  malformed.contract.workspaceBindingSelection = {
    ...malformed.contract.workspaceBindingSelection!,
    workspaceId: 'different-workspace',
  };
  const rejected = advancement.submitAutomationPilotAuthoringResult({
    advancementId: second.projection.advancementId,
    expectedStateRevision: second.projection.stateRevision,
    expectedStateDigest: second.projection.stateDigest,
    claimId: second.claim.claimId,
    result: malformed,
    nowMs: claimedAt + 5_003,
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, 'authoring_result_invalid');
  assert.equal(
    advancement.loadAutomationPilotAdvancement(second.projection.advancementId)?.stage,
    'authoring_required',
  );

  const submitted = advancement.submitAutomationPilotAuthoringResult({
    advancementId: second.projection.advancementId,
    expectedStateRevision: second.projection.stateRevision,
    expectedStateDigest: second.projection.stateDigest,
    claimId: second.claim.claimId,
    result: authoringResult(second),
    nowMs: claimedAt + 5_004,
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  if (!submitted.ok) return;
  advancement.automationPilotAdvancementControlPlaneInternalsForTest
    .setAfterPilotRegistrationHook(() => { throw new Error('simulated crash after pilot card'); });
  await assert.rejects(
    advancement.reconcileAutomationPilotAdvancement(
      submitted.projection.advancementId,
      { acquisition: live.acquisition },
    ),
    /simulated crash after pilot card/,
  );
  const afterCrash = advancement.loadAutomationPilotAdvancement(submitted.projection.advancementId)!;
  assert.equal(afterCrash.stage, 'pilot_registering');
  const cardsAfterCrash = approvalCardCount(source.sessionId);
  advancement.automationPilotAdvancementControlPlaneInternalsForTest.setAfterPilotRegistrationHook();
  eventlog.closeEventLog();
  const recovered = await advancement.reconcileAutomationPilotAdvancement(
    submitted.projection.advancementId,
    { acquisition: live.acquisition },
  );
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  if (!recovered.ok) return;
  assert.equal(recovered.projection.stage, 'pilot_approval_pending');
  assert.equal(approvalCardCount(source.sessionId), cardsAfterCrash, 'crash replay reuses the exact full pilot card');
  assert.equal(live.businessInvokes(), 0);
});
