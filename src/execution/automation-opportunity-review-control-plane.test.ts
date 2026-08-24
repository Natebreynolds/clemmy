/** Run: node scripts/run-tests-isolated.mjs src/execution/automation-opportunity-review-control-plane.test.ts */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-opportunity-review-control-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const review = await import('./automation-opportunity-review-control-plane.js');
const opportunityStore = await import('./automation-opportunity-store.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const opportunityTools = await import('../tools/automation-opportunity-tools.js');
const reviewTools = await import('../tools/automation-opportunity-review-tools.js');
const pilotTools = await import('../tools/automation-read-pilot-tools.js');
const materializer = await import('../runtime/harness/live-capability-materializer.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const shipped = await import('../runtime/harness/shipped-implementation-identity.js');
const shared = await import('../tools/shared.js');
import type { AutomationOpportunityV1 } from './automation-opportunity.js';
import type { AutomationOpportunityProposalRecordV1 } from './automation-opportunity-store.js';
import type { AutomationReadPilotCapabilityAcquisitionPortV1 } from './automation-read-pilot-control-plane.js';

review.installAutomationOpportunityReviewControlPlaneReconciler();

test.afterEach(() => {
  review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterIntentHook();
  review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterCardVisibleHook();
  review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterReviewTransitionHook();
  review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterDecisionClaimHook();
  review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterDecisionTransitionHook();
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

let sequence = 0;
function unique(label: string): string {
  sequence += 1;
  return `${label}_${sequence}`;
}

function opportunity(label: string, options: { requiredMissing?: boolean } = {}): AutomationOpportunityV1 {
  return {
    version: 1,
    title: `Bounded ${label} opportunity`,
    objective: `Retrieve one bounded ${label} result with exact evidence.`,
    rationale: 'A disabled pilot can verify the exact live read contract.',
    lifetime: { kind: 'single_run' },
    recurrence: { mode: 'none' },
    trigger: { kind: 'manual' },
    partition: {
      mode: 'single',
      checkpointEvery: 1,
      completion: { kind: 'terminal_evidence', evidence: ['One bounded result is present.'] },
    },
    capabilityRequirements: [{
      id: 'bounded-read',
      description: `retrieve bounded ${label} values`,
      minimumEffect: 'read',
      constraints: ['Return one bounded result.'],
    }],
    phases: [{
      id: 'read-result',
      objective: `Retrieve one bounded ${label} result.`,
      dependsOn: [],
      capabilityRequirementIds: ['bounded-read'],
      effect: { class: 'read', approval: 'not_required', maxOperationsPerRun: 1 },
      partitioned: false,
      outputEvidence: ['The records collection is non-empty.'],
    }],
    effectCeiling: { class: 'read', maxOperationsPerRun: 1 },
    deliverables: [{
      id: 'result',
      description: 'The bounded result.',
      kind: 'artifact',
      required: true,
      successCriterionIds: ['complete'],
      evidence: ['The records collection is present.'],
    }],
    missingInputs: options.requiredMissing
      ? [{
          id: 'required-scope',
          description: 'The bounded scope is required.',
          required: true,
          blockingPhaseIds: ['read-result'],
        }]
      : [],
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
  };
}

function createOwnedProposal(input: {
  sessionId: string;
  label: string;
  sourceUserSeq?: number;
  requiredMissing?: boolean;
}): AutomationOpportunityProposalRecordV1 {
  if (!eventlog.getSession(input.sessionId)) {
    eventlog.createSession({ id: input.sessionId, kind: 'chat' });
  }
  const created = opportunityStore.createAutomationOpportunityProposal({
    proposalId: unique(`proposal_${input.label}`),
    opportunity: opportunity(input.label, { requiredMissing: input.requiredMissing }),
    actorRef: `accepted-source:${input.sessionId}#${input.sourceUserSeq ?? 1}`,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) throw new Error(created.message);
  return created.record;
}

function reviewInput(
  proposal: AutomationOpportunityProposalRecordV1,
  sessionId: string,
  sourceUserSeq = 2,
) {
  return {
    proposalId: proposal.proposalId,
    expectedProposalRevision: proposal.revision,
    expectedProposalDigest: proposal.digest,
    approvalSessionId: sessionId,
    requestSourceUserSeq: sourceUserSeq,
  };
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function toolServer(): {
  handlers: Map<string, (input: Record<string, any>) => Promise<ToolResult>>;
  server: unknown;
} {
  const handlers = new Map<string, (input: Record<string, any>) => Promise<ToolResult>>();
  return {
    handlers,
    server: {
      tool(
        name: string,
        _description: string,
        _parameters: unknown,
        handler: (input: Record<string, any>) => Promise<ToolResult>,
      ): void {
        handlers.set(name, handler);
      },
    },
  };
}

function toolJson(result: ToolResult): Record<string, any> {
  assert.equal(result.content.length, 1);
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

function approvalCardCount(sessionId: string): number {
  return eventlog.listEvents(sessionId, { types: ['approval_requested'] }).length;
}

function workflowRunCount(): number {
  if (!existsSync(shared.WORKFLOW_RUNS_DIR)) return 0;
  return readdirSync(shared.WORKFLOW_RUNS_DIR).filter((file) => file.endsWith('.json')).length;
}

function installPilotAcquisition(
  proposal: AutomationOpportunityProposalRecordV1,
  label: string,
): AutomationReadPilotCapabilityAcquisitionPortV1 {
  const operationId = unique(`operation.${label}`);
  const accountId = unique(`account.${label}`);
  const providerIdentity = unique(`runtime.${label}`);
  const portId = unique(`port.${label}`);
  const compilerId = unique(`compiler.${label}`);
  const carrier: materializer.LiveCapabilityCarrier = {
    identity: { kind: 'host', name: unique(`carrier.${label}`) },
    async enumerate() {
      return [{
        identifier: operationId,
        carrierKind: 'host' as const,
        carrier: carrier.identity.name,
        displayName: `Bounded ${label} values`,
        description: proposal.opportunity.capabilityRequirements[0]!.description,
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
    async acquire(request) {
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
            { invoke: async () => ({ records: [{ key: `record.${label}` }] }) },
          );
        },
      });
    },
  };
}

test('chat tool stages one card, exact human resolution approves, and the existing pilot request accepts that CAS', async () => {
  const sessionId = unique('chat.review.e2e');
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const proposalSurface = toolServer();
  opportunityTools.registerAutomationOpportunityTools(proposalSurface.server as never, {
    acceptedSource: () => ({ sessionId, sourceUserSeq: 1 }),
  });
  const proposed = toolJson(await proposalSurface.handlers.get('automation_opportunity_propose')!({
    proposal_key: 'bounded-opportunity',
    opportunity: opportunity('e2e'),
  }));
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  assert.equal(proposed.proposal.status, 'proposed');
  assert.equal(proposed.executionAuthority, 'none');
  const proposal = opportunityStore.loadAutomationOpportunityProposal(proposed.proposal.proposalId)!;

  const reviewSurface = toolServer();
  reviewTools.registerAutomationOpportunityReviewTools(reviewSurface.server as never, {
    acceptedSource: () => ({ sessionId, sourceUserSeq: 2 }),
  });
  assert.deepEqual(
    [...reviewSurface.handlers.keys()],
    ['automation_opportunity_review_request'],
    'the human decision name is card metadata, never a model-callable tool',
  );
  const requestPayload = {
    proposal_id: proposal.proposalId,
    expected_proposal_revision: proposal.revision,
    expected_proposal_digest: proposal.digest,
  };
  const requested = toolJson(await reviewSurface.handlers.get('automation_opportunity_review_request')!(requestPayload));
  assert.equal(requested.ok, true, JSON.stringify(requested));
  assert.equal(requested.projection.status, 'reviewed');
  assert.equal(requested.proposal.status, 'reviewed');
  assert.equal(requested.executionAuthority, 'none');
  assert.equal(requested.decisionAuthority, 'formal_human_approval_only');
  assert.equal(requested.pilotAuthority, 'none');
  assert.equal(requested.recurrenceAuthority, 'none');
  assert.equal(approvalCardCount(sessionId), 1);
  assert.equal(workflowRunCount(), 0);

  const replay = toolJson(await reviewSurface.handlers.get('automation_opportunity_review_request')!(requestPayload));
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.projection.projectionId, requested.projection.projectionId);
  assert.equal(replay.approval.approvalId, requested.approval.approvalId);
  assert.equal(replay.projectionCreated, false);
  assert.equal(replay.approvalCreated, false);
  assert.equal(replay.cardCreated, false);
  assert.equal(approvalCardCount(sessionId), 1);

  const reviewedCas = opportunityStore.loadAutomationOpportunityProposal(proposal.proposalId)!;
  const laterSourceSurface = toolServer();
  reviewTools.registerAutomationOpportunityReviewTools(laterSourceSurface.server as never, {
    acceptedSource: () => ({ sessionId, sourceUserSeq: 99 }),
  });
  const laterSource = toolJson(await laterSourceSurface.handlers.get('automation_opportunity_review_request')!({
    proposal_id: reviewedCas.proposalId,
    expected_proposal_revision: reviewedCas.revision,
    expected_proposal_digest: reviewedCas.digest,
  }));
  assert.equal(laterSource.ok, true, JSON.stringify(laterSource));
  assert.equal(laterSource.projection.projectionId, requested.projection.projectionId);
  assert.equal(laterSource.projection.requestSourceUserSeq, 2, 'a later source cannot fork first-winner review authority');
  assert.equal(laterSource.cardCreated, false);
  assert.equal(approvalCardCount(sessionId), 1);

  const resolved = approvals.resolve(requested.approval.approvalId, 'approved', 'human.review.e2e');
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  const approved = opportunityStore.loadAutomationOpportunityProposal(proposal.proposalId)!;
  assert.equal(approved.status, 'approved');
  assert.equal(approved.revision, proposal.revision + 2);
  assert.equal(review.loadAutomationOpportunityReviewProjection(requested.projection.projectionId)?.status, 'approved');
  assert.equal(
    approvals.resolve(requested.approval.approvalId, 'approved', 'human.review.e2e').reason,
    'already_resolved',
  );
  assert.equal(opportunityStore.listAutomationOpportunityProposalRevisions(proposal.proposalId).length, 3);
  const decisionRevision = opportunityStore.listAutomationOpportunityProposalRevisions(proposal.proposalId)[2]!;
  assert.match(decisionRevision.actorRef, /^automation-decision:[a-f0-9]{64}$/);

  const terminalReplay = toolJson(await reviewSurface.handlers.get('automation_opportunity_review_request')!(requestPayload));
  assert.equal(terminalReplay.ok, true, JSON.stringify(terminalReplay));
  assert.equal(terminalReplay.projection.status, 'approved');
  assert.equal(terminalReplay.cardCreated, false);
  assert.equal(approvalCardCount(sessionId), 1);

  const acquisition = installPilotAcquisition(approved, 'e2e');
  const pilotSurface = toolServer();
  const acquisitionRef = `pilot-acquisition:host:${'a'.repeat(64)}`;
  pilotTools.registerAutomationReadPilotTools(pilotSurface.server as never, {
    acceptedSource: () => ({ sessionId, sourceUserSeq: 3 }),
    listAcquisitions: () => [{
      acquisitionRef,
      carrierKind: 'host',
      label: 'Configured live read registry',
      description: 'One exact provider-neutral live read acquisition.',
    }],
    resolveAcquisition: (candidate) => candidate === acquisitionRef
      ? { ok: true, acquisition }
      : { ok: false, code: 'acquisition_ref_stale', reason: 'Reference is stale.' },
  });
  const inventory = toolJson(await pilotSurface.handlers.get('automation_read_pilot_acquisition_list')!({
    proposal_id: approved.proposalId,
    expected_proposal_revision: approved.revision,
    expected_proposal_digest: approved.digest,
    phase_id: 'read-result',
    requirement_id: 'bounded-read',
  }));
  assert.equal(inventory.ok, true, JSON.stringify(inventory));
  assert.deepEqual(inventory.acquisitions.map((item: { acquisitionRef: string }) => item.acquisitionRef), [acquisitionRef]);
  const pilot = toolJson(await pilotSurface.handlers.get('automation_read_pilot_request')!({
    proposal_id: approved.proposalId,
    expected_proposal_revision: approved.revision,
    expected_proposal_digest: approved.digest,
    acquisition_ref: acquisitionRef,
    contract: {
      phase_id: 'read-result',
      requirement_id: 'bounded-read',
      workflow_inputs: { scope: { type: 'string', required: true } },
      arguments: {
        scope: {
          source: { kind: 'workflow_input', key: 'scope' },
          required: true,
          type: 'string',
        },
      },
      evidence: {
        required_paths: ['records'],
        non_empty_paths: ['records'],
        min_items: { records: 1 },
      },
      completeness: { kind: 'terminal_result', evidence_paths: ['records'] },
    },
    workflow_inputs: { scope: 'bounded.scope' },
  }));
  assert.equal(pilot.ok, true, JSON.stringify(pilot));
  assert.equal(pilot.projection.status, 'approval_pending');
  assert.equal(pilot.executionAuthority, 'pending_exact_approval');
  assert.notEqual(pilot.approval.approvalId, requested.approval.approvalId);
  assert.equal(workflowRunCount(), 0, 'proposal approval never grants pilot queue authority');
});

test('intent, card, review, and decision crash cuts recover without duplicate cards or revisions', async (t) => {
  await t.test('intent and card cuts recover registration', () => {
    for (const cut of ['intent', 'card'] as const) {
      const sessionId = unique(`chat.crash.${cut}`);
      const proposal = createOwnedProposal({ sessionId, label: cut });
      const hook = () => { throw new Error(`simulated ${cut} crash`); };
      if (cut === 'intent') review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterIntentHook(hook);
      else review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterCardVisibleHook(hook);
      assert.throws(
        () => review.registerAutomationOpportunityReviewProjection(reviewInput(proposal, sessionId)),
        new RegExp(`simulated ${cut} crash`),
      );
      const projection = review.listAutomationOpportunityReviewProjections({ limit: 1000 })
        .find((candidate) => candidate.proposalId === proposal.proposalId)!;
      assert.equal(projection.status, 'registering');
      assert.equal(approvalCardCount(sessionId), cut === 'card' ? 1 : 0);
      review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterIntentHook();
      review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterCardVisibleHook();
      eventlog.closeEventLog();
      const recovered = review.reconcileAutomationOpportunityReviewProjection(projection.projectionId);
      assert.equal(recovered.ok, true, JSON.stringify(recovered));
      if (recovered.ok) assert.equal(recovered.state, 'pending');
      assert.equal(approvalCardCount(sessionId), 1);
      assert.equal(opportunityStore.loadAutomationOpportunityProposal(proposal.proposalId)?.status, 'reviewed');
      assert.equal(opportunityStore.listAutomationOpportunityProposalRevisions(proposal.proposalId).length, 2);
    }
  });

  await t.test('a human decision that lands after card commit but before projection linkage is recovered', () => {
    const sessionId = unique('chat.crash.card-decision');
    const proposal = createOwnedProposal({ sessionId, label: 'card-decision' });
    review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterCardVisibleHook(() => {
      throw new Error('simulated card-before-link crash');
    });
    assert.throws(
      () => review.registerAutomationOpportunityReviewProjection(reviewInput(proposal, sessionId)),
      /simulated card-before-link crash/,
    );
    const projection = review.listAutomationOpportunityReviewProjections({ limit: 1000 })
      .find((candidate) => candidate.proposalId === proposal.proposalId)!;
    assert.equal(projection.status, 'registering');
    assert.equal(projection.approvalId, undefined);
    const pending = approvals.listPending({ sessionId });
    assert.equal(pending.length, 1);
    assert.equal(approvals.resolve(pending[0]!.approvalId, 'approved', 'human.card-before-link').ok, true);
    assert.equal(opportunityStore.loadAutomationOpportunityProposal(proposal.proposalId)?.status, 'proposed');
    review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterCardVisibleHook();
    eventlog.closeEventLog();
    const recovered = review.reconcileAutomationOpportunityReviewProjection(projection.projectionId);
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    if (recovered.ok) assert.equal(recovered.state, 'approved');
    assert.equal(opportunityStore.loadAutomationOpportunityProposal(proposal.proposalId)?.status, 'approved');
    assert.equal(approvalCardCount(sessionId), 1);
    assert.equal(opportunityStore.listAutomationOpportunityProposalRevisions(proposal.proposalId).length, 3);
  });

  await t.test('review and decision cuts recover cross-database commits', () => {
    const reviewSession = unique('chat.crash.review');
    const reviewProposal = createOwnedProposal({ sessionId: reviewSession, label: 'review-cut' });
    review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterReviewTransitionHook(() => {
      throw new Error('simulated review transition crash');
    });
    assert.throws(
      () => review.registerAutomationOpportunityReviewProjection(reviewInput(reviewProposal, reviewSession)),
      /simulated review transition crash/,
    );
    const interruptedReview = review.listAutomationOpportunityReviewProjections({ limit: 1000 })
      .find((candidate) => candidate.proposalId === reviewProposal.proposalId)!;
    assert.equal(interruptedReview.status, 'card_visible');
    assert.equal(opportunityStore.loadAutomationOpportunityProposal(reviewProposal.proposalId)?.status, 'reviewed');
    review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterReviewTransitionHook();
    eventlog.closeEventLog();
    const recoveredReview = review.reconcileAutomationOpportunityReviewProjection(interruptedReview.projectionId);
    assert.equal(recoveredReview.ok, true, JSON.stringify(recoveredReview));
    if (recoveredReview.ok) assert.equal(recoveredReview.state, 'pending');
    assert.equal(approvalCardCount(reviewSession), 1);
    assert.equal(opportunityStore.listAutomationOpportunityProposalRevisions(reviewProposal.proposalId).length, 2);

    const decisionSession = unique('chat.crash.decision');
    const decisionProposal = createOwnedProposal({ sessionId: decisionSession, label: 'decision-cut' });
    const registered = review.registerAutomationOpportunityReviewProjection(reviewInput(decisionProposal, decisionSession));
    assert.equal(registered.ok, true, JSON.stringify(registered));
    if (!registered.ok) return;
    review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterDecisionTransitionHook(() => {
      throw new Error('simulated decision transition crash');
    });
    assert.equal(approvals.resolve(registered.approval.approvalId, 'approved', 'human.decision-cut').ok, true);
    assert.equal(opportunityStore.loadAutomationOpportunityProposal(decisionProposal.proposalId)?.status, 'approved');
    assert.equal(review.loadAutomationOpportunityReviewProjection(registered.projection.projectionId)?.status, 'reviewed');
    review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterDecisionTransitionHook();
    eventlog.closeEventLog();
    const recoveredDecision = review.reconcileAutomationOpportunityReviewProjection(registered.projection.projectionId);
    assert.equal(recoveredDecision.ok, true, JSON.stringify(recoveredDecision));
    if (recoveredDecision.ok) assert.equal(recoveredDecision.state, 'approved');
    assert.equal(opportunityStore.listAutomationOpportunityProposalRevisions(decisionProposal.proposalId).length, 3);
    assert.equal(approvalCardCount(decisionSession), 1);
  });

  await t.test('an approval consumed before the decision transition completes only its exact proposal', () => {
    const sessionId = unique('chat.crash.decision-claim');
    const proposal = createOwnedProposal({ sessionId, label: 'decision-claim-cut' });
    const registered = review.registerAutomationOpportunityReviewProjection(reviewInput(proposal, sessionId));
    assert.equal(registered.ok, true, JSON.stringify(registered));
    if (!registered.ok) return;
    review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterDecisionClaimHook(() => {
      throw new Error('simulated decision claim crash');
    });
    assert.equal(approvals.resolve(registered.approval.approvalId, 'approved', 'human.decision-claim').ok, true);
    assert.equal(approvals.inspectResumableApproval(registered.approval.resumeKey!).state, 'consumed');
    assert.equal(opportunityStore.loadAutomationOpportunityProposal(proposal.proposalId)?.status, 'reviewed');
    assert.equal(review.loadAutomationOpportunityReviewProjection(registered.projection.projectionId)?.status, 'reviewed');
    review.automationOpportunityReviewControlPlaneInternalsForTest.setAfterDecisionClaimHook();
    eventlog.closeEventLog();
    const recovered = review.reconcileAutomationOpportunityReviewProjection(registered.projection.projectionId);
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    if (recovered.ok) assert.equal(recovered.state, 'approved');
    assert.equal(opportunityStore.loadAutomationOpportunityProposal(proposal.proposalId)?.status, 'approved');
    assert.equal(opportunityStore.listAutomationOpportunityProposalRevisions(proposal.proposalId).length, 3);
    assert.equal(approvalCardCount(sessionId), 1);
  });
});

test('reject, expiry, cancellation, stale CAS, missing input, and cross-session requests fail closed', async (t) => {
  await t.test('exact rejection transitions reviewed to rejected once', () => {
    const sessionId = unique('chat.reject');
    const proposal = createOwnedProposal({ sessionId, label: 'reject' });
    const registered = review.registerAutomationOpportunityReviewProjection(reviewInput(proposal, sessionId));
    assert.equal(registered.ok, true, JSON.stringify(registered));
    if (!registered.ok) return;
    assert.equal(approvals.resolve(registered.approval.approvalId, 'rejected', 'human.reject').ok, true);
    assert.equal(opportunityStore.loadAutomationOpportunityProposal(proposal.proposalId)?.status, 'rejected');
    assert.equal(review.loadAutomationOpportunityReviewProjection(registered.projection.projectionId)?.status, 'rejected');
    assert.equal(approvals.resolve(registered.approval.approvalId, 'approved', 'late-human').reason, 'already_resolved');
    assert.equal(opportunityStore.listAutomationOpportunityProposalRevisions(proposal.proposalId).length, 3);
  });

  await t.test('expiry and cancellation grant no decision and leave a reviewed proposal eligible for a fresh card', () => {
    for (const resolution of ['expired', 'cancelled_by_user', 'cancelled_by_system'] as const) {
      const sessionId = unique(`chat.${resolution}`);
      const proposal = createOwnedProposal({ sessionId, label: resolution });
      const registered = review.registerAutomationOpportunityReviewProjection(reviewInput(proposal, sessionId));
      assert.equal(registered.ok, true, JSON.stringify(registered));
      if (!registered.ok) continue;
      assert.equal(approvals.resolve(registered.approval.approvalId, resolution, `human.${resolution}`).ok, true);
      assert.equal(opportunityStore.loadAutomationOpportunityProposal(proposal.proposalId)?.status, 'reviewed');
      assert.equal(review.loadAutomationOpportunityReviewProjection(registered.projection.projectionId)?.status, 'refused');
      assert.equal(opportunityStore.listAutomationOpportunityProposalRevisions(proposal.proposalId).length, 2);
      assert.equal(workflowRunCount(), 0);

      const reviewed = opportunityStore.loadAutomationOpportunityProposal(proposal.proposalId)!;
      const renewed = review.registerAutomationOpportunityReviewProjection(
        reviewInput(reviewed, sessionId, 3),
      );
      assert.equal(renewed.ok, true, JSON.stringify(renewed));
      if (renewed.ok) {
        assert.notEqual(renewed.approval.approvalId, registered.approval.approvalId);
        assert.equal(renewed.projection.status, 'reviewed');
      }
      assert.equal(approvalCardCount(sessionId), 2);
      assert.equal(opportunityStore.listAutomationOpportunityProposalRevisions(proposal.proposalId).length, 2);
    }

    const lateSession = unique('chat.late-expiry');
    const lateProposal = createOwnedProposal({ sessionId: lateSession, label: 'late-expiry' });
    const late = review.registerAutomationOpportunityReviewProjection(reviewInput(lateProposal, lateSession));
    assert.equal(late.ok, true, JSON.stringify(late));
    if (!late.ok) return;
    eventlog.openEventLog().prepare(
      'UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?',
    ).run(new Date(Date.now() - 1_000).toISOString(), late.approval.approvalId);
    const lateDecision = approvals.resolve(late.approval.approvalId, 'approved', 'human.too-late');
    assert.equal(lateDecision.ok, false);
    assert.equal(lateDecision.reason, 'expired');
    assert.equal(opportunityStore.loadAutomationOpportunityProposal(lateProposal.proposalId)?.status, 'reviewed');
    assert.equal(review.loadAutomationOpportunityReviewProjection(late.projection.projectionId)?.refusalCode, 'review_approval_expired');
  });

  await t.test('semantic revision spends the reviewed CAS before a late approval', () => {
    const sessionId = unique('chat.stale');
    const proposal = createOwnedProposal({ sessionId, label: 'stale-before' });
    const registered = review.registerAutomationOpportunityReviewProjection(reviewInput(proposal, sessionId));
    assert.equal(registered.ok, true, JSON.stringify(registered));
    if (!registered.ok) return;
    const reviewed = opportunityStore.loadAutomationOpportunityProposal(proposal.proposalId)!;
    const revised = opportunityStore.reviseAutomationOpportunityProposal({
      proposalId: reviewed.proposalId,
      opportunity: opportunity('stale-after'),
      expectedRevision: reviewed.revision,
      expectedDigest: reviewed.digest,
      actorRef: `accepted-source:${sessionId}#3`,
    });
    assert.equal(revised.ok, true, JSON.stringify(revised));
    assert.equal(approvals.resolve(registered.approval.approvalId, 'approved', 'human.stale').ok, true);
    const current = opportunityStore.loadAutomationOpportunityProposal(proposal.proposalId)!;
    assert.equal(current.status, 'proposed');
    assert.notEqual(current.digest, proposal.digest);
    assert.equal(review.loadAutomationOpportunityReviewProjection(registered.projection.projectionId)?.status, 'refused');
    assert.equal(workflowRunCount(), 0);
  });

  await t.test('foreign source session and unresolved required input create no card', () => {
    const ownerSession = unique('chat.owner');
    const otherSession = unique('chat.other');
    eventlog.createSession({ id: otherSession, kind: 'chat' });
    const proposal = createOwnedProposal({ sessionId: ownerSession, label: 'owner' });
    const foreign = review.registerAutomationOpportunityReviewProjection(reviewInput(proposal, otherSession));
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.code, 'proposal_owner_mismatch');
    assert.equal(approvalCardCount(otherSession), 0);

    const missing = createOwnedProposal({
      sessionId: ownerSession,
      label: 'missing',
      sourceUserSeq: 4,
      requiredMissing: true,
    });
    const blocked = review.registerAutomationOpportunityReviewProjection(reviewInput(missing, ownerSession, 5));
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, 'proposal_missing_inputs');
    assert.equal(opportunityStore.loadAutomationOpportunityProposal(missing.proposalId)?.status, 'proposed');
  });

  await t.test('tool invocation without an exact accepted source stays inert', async () => {
    const surface = toolServer();
    reviewTools.registerAutomationOpportunityReviewTools(surface.server as never, {
      acceptedSource: () => undefined,
    });
    const result = toolJson(await surface.handlers.get('automation_opportunity_review_request')!({
      proposal_id: 'proposal.unowned',
      expected_proposal_revision: 1,
      expected_proposal_digest: 'a'.repeat(64),
    }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'accepted_source_required');
  });

  await t.test('approval-row drift is terminal and cannot mint replacement authority', () => {
    const sessionId = unique('chat.approval-drift');
    const proposal = createOwnedProposal({ sessionId, label: 'approval-drift' });
    const registered = review.registerAutomationOpportunityReviewProjection(reviewInput(proposal, sessionId));
    assert.equal(registered.ok, true, JSON.stringify(registered));
    if (!registered.ok) return;
    eventlog.openEventLog().prepare(
      'UPDATE pending_approvals SET args_json = ? WHERE approval_id = ?',
    ).run('{"drifted":true}', registered.approval.approvalId);
    const reconciled = review.reconcileAutomationOpportunityReviewProjection(registered.projection.projectionId);
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    if (reconciled.ok) assert.equal(reconciled.state, 'refused');
    assert.equal(
      review.loadAutomationOpportunityReviewProjection(registered.projection.projectionId)?.refusalCode,
      'review_approval_conflict',
    );
    assert.equal(opportunityStore.loadAutomationOpportunityProposal(proposal.proposalId)?.status, 'reviewed');
    assert.equal(approvalCardCount(sessionId), 1);
    assert.equal(workflowRunCount(), 0);
  });
});

test('auxiliary schema is versioned and contains no workflow, schedule, or Space authority', () => {
  const sessionId = unique('chat.schema');
  const proposal = createOwnedProposal({ sessionId, label: 'schema' });
  const registered = review.registerAutomationOpportunityReviewProjection(reviewInput(proposal, sessionId));
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const db = eventlog.openEventLog();
  assert.deepEqual(
    db.prepare('SELECT version FROM automation_opportunity_review_control_plane_migrations ORDER BY version').all(),
    [{ version: 1 }],
  );
  const columns = (db.prepare('PRAGMA table_info(automation_opportunity_review_projections)').all() as Array<{
    name: string;
  }>).map((column) => column.name);
  assert.equal(columns.some((name) => /workflow|schedule|recurrence|space/i.test(name)), false);
  assert.equal(workflowRunCount(), 0);
});
