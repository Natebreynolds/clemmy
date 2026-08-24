/** Run: node scripts/run-tests-isolated.mjs src/execution/automation-pilot-authoring-dispatcher.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-pilot-authoring-dispatch-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const dispatcher = await import('./automation-pilot-authoring-dispatcher.js');
const chooser = await import('./automation-pilot-workspace-destination-authority.js');
const advancement = await import('./automation-pilot-advancement-control-plane.js');
const opportunities = await import('./automation-opportunity.js');
const opportunityStore = await import('./automation-opportunity-store.js');
const review = await import('./automation-opportunity-review-control-plane.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const materializer = await import('../runtime/harness/live-capability-materializer.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const productionPorts = await import('../runtime/harness/production-capability-ports.js');
const shipped = await import('../runtime/harness/shipped-implementation-identity.js');
const spaces = await import('../spaces/store.js');
const projections = await import('../memory/workflow-result-projection-contract.js');
import type { AutomationOpportunityV1 } from './automation-opportunity.js';
import type { AutomationReadPilotCapabilityAcquisitionPortV1 } from './automation-read-pilot-control-plane.js';

let sequence = 0;
function unique(label: string): string {
  sequence += 1;
  return `${label}.${sequence}`;
}

function opportunity(label: string): AutomationOpportunityV1 {
  return opportunities.parseAutomationOpportunity({
    version: 1,
    title: `Bounded ${label} collection`,
    objective: `Collect one bounded ${label} result with exact evidence.`,
    rationale: 'A one-shot read pilot should prove the reviewed contract.',
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
    dataset: {
      schema: {
        fields: [
          { name: 'key', type: 'string', required: true, sensitivity: 'public' },
          { name: 'name', type: 'string', required: true, sensitivity: 'public' },
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
    deliverables: [{
      id: 'result',
      description: 'The bounded result.',
      kind: 'dataset_snapshot',
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

function approvedAdvancement(label: string): advancement.AutomationPilotAdvancementProjectionV1 {
  const sessionId = unique('chat');
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const created = opportunityStore.createAutomationOpportunityProposal({
    proposalId: unique('proposal').replaceAll('.', '_'),
    opportunity: opportunity(label),
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
  assert.equal(approvals.resolve(requested.approval.approvalId, 'approved', `human.${label}`).ok, true);
  const reviewed = review.reconcileAutomationOpportunityReviewProjection(requested.projection.projectionId);
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  if (!reviewed.ok) throw new Error(reviewed.reason);
  const registered = advancement.registerAutomationPilotAdvancement({ reviewProjectionId: reviewed.projection.projectionId });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) throw new Error(registered.reason);
  return registered.projection;
}

function acquisitionFixture(label: string, withOutputSchema = true): {
  acquisition: AutomationReadPilotCapabilityAcquisitionPortV1;
  businessInvokes(): number;
} {
  const operationId = unique(`operation.${label}`);
  const accountId = unique(`account.${label}`);
  const providerIdentity = unique(`runtime.${label}`);
  const portId = unique(`port.${label}`);
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
        ...(withOutputSchema ? {
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              records: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { key: { type: 'string' }, name: { type: 'string' } },
                  required: ['key', 'name'],
                },
              },
            },
            required: ['records'],
          },
          outputSchemaAttestation: 'carrier_declared' as const,
        } : {}),
        observedAt: Date.now(),
        invoke: { portId, argumentCompiler: { id: 'compiler.test', version: '1' } },
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
        return materializer.materializeLiveReadCapability({
          objective: request.objective,
          carrier,
          factory,
          store,
          registerPort: ({ manifest, attestation }) => {
            if (productionPorts.resolveProductionPortsForManifest(manifest)) return { ok: true as const };
            shipped.loadShippedImplementations().registerIsolatedObservation({
              operationId: attestation.reference.identifier,
              accountId: attestation.accountId,
              definitionFingerprint: attestation.definitionFingerprint,
              providerVersion: attestation.providerVersion,
              operationVersion: attestation.operationVersion,
              observedAt: Date.now(),
            });
            return productionPorts.registerFixtureCapabilityPort(
              productionPorts.productionPortIdentityFromManifest(manifest),
              {
                invoke: async () => {
                  bodyCount += 1;
                  return { records: [{ key: `key.${label}`, name: label }] };
                },
              },
            );
          },
        });
      },
    },
    businessInvokes: () => bodyCount,
  };
}

async function authoringStage(label: string, withOutputSchema = true): Promise<{
  projection: advancement.AutomationPilotAdvancementProjectionV1;
  live: ReturnType<typeof acquisitionFixture>;
}> {
  spaces.spaceStore.save({ id: `${label}-workspace`, title: `${label} target` });
  const staged = approvedAdvancement(label);
  const ensured = chooser.ensureAutomationPilotWorkspaceChooser({ advancementId: staged.advancementId });
  assert.equal(ensured.ok, true, JSON.stringify(ensured));
  if (!ensured.ok) throw new Error(ensured.reason);
  const selected = ensured.projection.choices.find((choice) => choice.kind === 'existing')!;
  const resolved = chooser.resolveAutomationPilotWorkspaceChooser({
    chooserId: ensured.projection.chooserId,
    expectedChooserRevision: ensured.projection.chooserRevision,
    expectedChooserDigest: ensured.projection.chooserDigest,
    choiceId: selected.choiceId,
    actorRef: 'human.desktop',
  });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  const live = acquisitionFixture(label, withOutputSchema);
  const reconciled = await advancement.reconcileAutomationPilotAdvancement(staged.advancementId, {
    acquisition: live.acquisition,
  });
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  if (!reconciled.ok) throw new Error(reconciled.reason);
  assert.equal(reconciled.projection.stage, 'authoring_required');
  return { projection: reconciled.projection, live };
}

function candidate(request: advancement.AutomationPilotAuthoringRequestV1, digest: string) {
  return {
    version: 1 as const,
    requestId: request.requestId,
    requestDigest: digest,
    contract: {
      phaseId: request.requirement.phaseId,
      requirementId: request.requirement.requirementId,
      workflowInputs: { scope: { type: 'string' as const, required: true } },
      arguments: {
        scope: {
          source: { kind: 'workflow_input' as const, key: 'scope' },
          required: true,
          type: 'string' as const,
        },
      },
      evidence: {
        requiredPaths: ['records'],
        nonEmptyPaths: ['records'],
        minItems: { records: 1 },
      },
      completeness: { kind: 'terminal_result' as const, evidencePaths: ['records'] },
      continuation: { kind: 'none' as const },
      resultProjection: projections.createWorkflowCanonicalEntityResultProjection({
        recordsPath: 'records',
        fields: [
          { field: 'key', recordPath: 'key', type: 'string', required: true, sensitivity: 'public', confidence: 1 },
          { field: 'name', recordPath: 'name', type: 'string', required: true, sensitivity: 'public', confidence: 1 },
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
          policyId: 'exact-key',
          mergeThreshold: 10,
          distinctThreshold: 2,
          ambiguityMargin: 1,
          weights: { defaultExactIdentifierMatch: 10, defaultCompoundSignalMatch: 0 },
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
      workspaceBindingSelection: structuredClone(request.workspaceSelection!),
    },
    workflowInputs: { scope: 'bounded.scope' },
  };
}

test.afterEach(() => {
  for (const workspace of spaces.spaceStore.list(true)) spaces.spaceStore.remove(workspace.id);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  productionPorts.clearProductionCapabilityPorts();
});

test.after(() => {
  opportunityStore.closeAutomationOpportunityStoreForTests();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('one constrained no-tools authoring dispatch reaches the existing full pilot card with no business read', async () => {
  const authored = await authoringStage('automatic');
  let calls = 0;
  const dispatched = await dispatcher.reconcileAutomationPilotAuthoringDispatch({
    advancementId: authored.projection.advancementId,
    port: {
      async author(input) {
        calls += 1;
        assert.equal(input.request.authority.businessInvoke, 'none');
        assert.equal(input.signal.aborted, false);
        assert.doesNotMatch(input.prompt, new RegExp(input.request.acquisition.providerIdentity));
        assert.doesNotMatch(input.prompt, new RegExp(input.request.acquisition.accountId));
        return candidate(input.request, input.requestDigest);
      },
    },
    leaseMs: 60_000,
    timeoutMs: 5_000,
  });
  assert.deepEqual(dispatched, {
    ok: true,
    state: 'submitted',
    advancementId: authored.projection.advancementId,
  });
  assert.equal(calls, 1);
  assert.equal(authored.live.businessInvokes(), 0);
  const stagedPilot = await advancement.reconcileAutomationPilotAdvancement(
    authored.projection.advancementId,
    { acquisition: authored.live.acquisition },
  );
  assert.equal(stagedPilot.ok, true, JSON.stringify(stagedPilot));
  if (stagedPilot.ok) assert.equal(stagedPilot.projection.stage, 'pilot_approval_pending');
  assert.equal(authored.live.businessInvokes(), 0);
});

test('absent output schema visibly blocks before any model call or business sample', async () => {
  const authored = await authoringStage('missing-output', false);
  let calls = 0;
  const dispatched = await dispatcher.reconcileAutomationPilotAuthoringDispatch({
    advancementId: authored.projection.advancementId,
    port: { async author() { calls += 1; return {}; } },
  });
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
  if (dispatched.ok) assert.equal(dispatched.state, 'blocked');
  const blocked = advancement.loadAutomationPilotAdvancement(authored.projection.advancementId)!;
  assert.equal(blocked.stage, 'blocked');
  assert.equal(blocked.blocked?.code, 'output_shape_unavailable');
  assert.equal(calls, 0);
  assert.equal(authored.live.businessInvokes(), 0);
});

test('malformed candidates consume a bounded durable attempt budget and then fail closed', async () => {
  const authored = await authoringStage('bad-candidate');
  const port: dispatcher.AutomationPilotAuthoringPortV1 = {
    async author(input) {
      const result = candidate(input.request, input.requestDigest);
      result.contract.resultProjection.fields[0]!.recordPath = 'invented_key';
      return result;
    },
  };
  const first = await dispatcher.reconcileAutomationPilotAuthoringDispatch({
    advancementId: authored.projection.advancementId,
    port,
    maxAttempts: 2,
    leaseMs: 60_000,
    timeoutMs: 5_000,
  });
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.state, 'retry');
  const afterFirst = advancement.loadAutomationPilotAdvancement(authored.projection.advancementId)!;
  assert.equal(afterFirst.stage, 'authoring_required');
  assert.equal(afterFirst.authoringAttemptCount, 1);
  assert.equal(afterFirst.authoringClaim, undefined);

  const second = await dispatcher.reconcileAutomationPilotAuthoringDispatch({
    advancementId: authored.projection.advancementId,
    port,
    maxAttempts: 2,
    leaseMs: 60_000,
    timeoutMs: 5_000,
  });
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.state, 'blocked');
  const blocked = advancement.loadAutomationPilotAdvancement(authored.projection.advancementId)!;
  assert.equal(blocked.stage, 'blocked');
  assert.equal(blocked.authoringAttemptCount, 2);
  assert.equal(blocked.blocked?.code, 'authoring_attempt_budget_exhausted');
  assert.equal(authored.live.businessInvokes(), 0);
});

test('an expired crashed attempt at the durable budget blocks before another model call', async () => {
  const authored = await authoringStage('crash-budget');
  const claimedAt = Date.UTC(2026, 7, 22, 12, 0, 0);
  const claim = advancement.claimAutomationPilotAuthoringRequest({
    advancementId: authored.projection.advancementId,
    expectedStateRevision: authored.projection.stateRevision,
    expectedStateDigest: authored.projection.stateDigest,
    workerId: 'worker.crashed-author',
    leaseMs: 6_000,
    nowMs: claimedAt,
  });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  if (!claim.ok) return;
  let calls = 0;
  const reconciled = await dispatcher.reconcileAutomationPilotAuthoringDispatch({
    advancementId: claim.projection.advancementId,
    port: { async author() { calls += 1; return {}; } },
    maxAttempts: 1,
    leaseMs: 6_000,
    timeoutMs: 100,
    nowMs: claimedAt + 6_001,
  });
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  if (reconciled.ok) assert.equal(reconciled.state, 'blocked');
  const blocked = advancement.loadAutomationPilotAdvancement(claim.projection.advancementId)!;
  assert.equal(blocked.stage, 'blocked');
  assert.equal(blocked.blocked?.code, 'authoring_attempt_budget_exhausted');
  assert.equal(blocked.authoringAttemptCount, 1);
  assert.equal(calls, 0);
  assert.equal(authored.live.businessInvokes(), 0);
});

test('a transient model failure releases only its own claim and the next tick can submit', async () => {
  const authored = await authoringStage('retry-success');
  let calls = 0;
  const port: dispatcher.AutomationPilotAuthoringPortV1 = {
    async author(input) {
      calls += 1;
      if (calls === 1) throw new Error('temporary model transport failure');
      return candidate(input.request, input.requestDigest);
    },
  };
  const first = await dispatcher.reconcileAutomationPilotAuthoringDispatch({
    advancementId: authored.projection.advancementId,
    port,
    leaseMs: 60_000,
    timeoutMs: 5_000,
  });
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.state, 'retry');
  eventlog.closeEventLog();
  const recovered = await dispatcher.reconcileAutomationPilotAuthoringDispatch({
    advancementId: authored.projection.advancementId,
    port,
    leaseMs: 60_000,
    timeoutMs: 5_000,
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  if (recovered.ok) assert.equal(recovered.state, 'submitted');
  assert.equal(calls, 2);
  assert.equal(
    advancement.loadAutomationPilotAdvancement(authored.projection.advancementId)?.authoringAttemptCount,
    2,
  );
});
