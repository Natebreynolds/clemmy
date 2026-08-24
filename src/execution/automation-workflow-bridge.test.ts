import test from 'node:test';
import assert from 'node:assert/strict';

import type { CanonicalCatalogIdentityV1 } from '../runtime/harness/host-capability-catalog-factory.js';
import { validateWorkflowGraph } from './workflow-graph.js';
import {
  automationOpportunityDigest,
  parseAutomationOpportunity,
  type AutomationOpportunityV1,
} from './automation-opportunity.js';
import type { AutomationOpportunityProposalRecordV1 } from './automation-opportunity-store.js';
import {
  automationCapabilityRequirementDigest,
  automationLiveCapabilityContractDigest,
  automationLiveCapabilitySnapshotDigest,
  designApprovedAutomationWorkflowBridge,
  type AutomationLiveCapabilityContractV1,
  type AutomationLiveCapabilitySnapshotV1,
  type AutomationWorkflowActivationV1,
  type AutomationWorkflowBridgeInputV1,
} from './automation-workflow-bridge.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const DIGEST_D = 'd'.repeat(64);

function opportunity(
  overrides: Partial<AutomationOpportunityV1> = {},
): AutomationOpportunityV1 {
  return parseAutomationOpportunity({
    version: 1,
    title: 'Bounded recurring observation',
    objective: 'Produce a bounded observation with explicit terminal evidence.',
    rationale: 'The work benefits from durable review and an explicit cadence.',
    lifetime: { kind: 'ongoing' },
    recurrence: {
      mode: 'proposed',
      cadence: {
        kind: 'calendar',
        expression: '15 4 * * *',
        timezone: 'Etc/UTC',
      },
      overlapPolicy: 'skip',
      catchUpPolicy: 'run_once',
      activation: 'requires_pilot_success_and_recurrence_consent',
    },
    trigger: { kind: 'recurrence' },
    partition: {
      mode: 'single',
      checkpointEvery: 1,
      completion: {
        kind: 'terminal_evidence',
        evidence: ['A terminal receipt identifies the observed result.'],
      },
    },
    capabilityRequirements: [{
      id: 'observe-state',
      description: 'Observe the current bounded state.',
      minimumEffect: 'read',
      constraints: ['Returns terminal evidence.'],
    }],
    phases: [{
      id: 'observe',
      objective: 'Observe the bounded state and retain terminal evidence.',
      dependsOn: [],
      capabilityRequirementIds: ['observe-state'],
      effect: {
        class: 'read',
        approval: 'not_required',
        maxOperationsPerRun: 5,
      },
      partitioned: false,
      outputEvidence: ['The terminal receipt is present.'],
    }],
    effectCeiling: { class: 'read', maxOperationsPerRun: 5 },
    deliverables: [{
      id: 'result',
      description: 'A bounded result artifact.',
      kind: 'artifact',
      required: true,
      successCriterionIds: ['terminal'],
      evidence: ['The result references terminal evidence.'],
    }],
    missingInputs: [],
    successCriteria: [{
      id: 'terminal',
      description: 'The result carries terminal evidence.',
      evidence: ['A receipt reference is present.'],
    }],
    pilot: {
      required: true,
      maxPartitions: 1,
      maxRecords: 10,
      effectCeiling: { class: 'read', maxOperationsPerRun: 5 },
      successCriterionIds: ['terminal'],
      haltOnFailure: true,
    },
    budgets: {
      maxWallClockMinutesPerRun: 30,
      maxConcurrentPartitions: 1,
      maxAttemptsPerPartition: 2,
      maxPartitionsPerRun: 1,
      maxRecordsPerRun: 10,
      maxOperationsPerRun: 5,
      reserveOperations: 1,
    },
    ...overrides,
  });
}

function approvedRecord(
  value: AutomationOpportunityV1 = opportunity(),
  overrides: Partial<AutomationOpportunityProposalRecordV1> = {},
): AutomationOpportunityProposalRecordV1 {
  const digest = automationOpportunityDigest(value);
  return {
    version: 1,
    proposalId: 'proposal-neutral',
    status: 'approved',
    revision: 3,
    digest,
    opportunity: value,
    createdAt: '2026-08-22T08:00:00.000Z',
    updatedAt: '2026-08-22T08:10:00.000Z',
    reviewedAt: '2026-08-22T08:05:00.000Z',
    decidedAt: '2026-08-22T08:10:00.000Z',
    ...overrides,
  };
}

function identity(
  capabilityId: string,
  overrides: Partial<CanonicalCatalogIdentityV1> = {},
): CanonicalCatalogIdentityV1 {
  return {
    capabilityId,
    manifestId: `manifest_${capabilityId}`,
    manifestDigest: DIGEST_A,
    operationId: `operation_${capabilityId}`,
    schemaVersion: '1',
    schemaDigest: DIGEST_B,
    providerKind: 'local_registry',
    providerVersion: '1',
    liveFingerprint: DIGEST_C,
    account: `account_${capabilityId}`,
    effect: 'read',
    destination: null,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    invokePortId: `invoke_${capabilityId}`,
    argumentCompiler: { id: 'compiler_exact', version: '1' },
    ...overrides,
  };
}

function capability(
  value: AutomationOpportunityV1,
  capabilityId = 'capability_alpha',
  overrides: Partial<AutomationLiveCapabilityContractV1> = {},
): AutomationLiveCapabilityContractV1 {
  const requirement = value.capabilityRequirements[0];
  return {
    lifecycle: 'current',
    logicalToolName: `surface_${capabilityId}`,
    identity: identity(capabilityId),
    matches: [{
      requirementId: requirement.id,
      requirementDigest: automationCapabilityRequirementDigest(requirement),
    }],
    ...overrides,
  };
}

function snapshot(
  capabilities: AutomationLiveCapabilityContractV1[],
): AutomationLiveCapabilitySnapshotV1 {
  return {
    digest: automationLiveCapabilitySnapshotDigest(capabilities),
    capabilities,
  };
}

function pilotActivation(
  proposal: AutomationOpportunityProposalRecordV1,
  preview: NonNullable<ReturnType<typeof designApprovedAutomationWorkflowBridge>['preview']>,
): AutomationWorkflowActivationV1 {
  return {
    kind: 'pilot',
    pilot: {
      state: 'authorized',
      proposalRevision: proposal.revision,
      proposalDigest: proposal.digest,
      compilationDigest: preview.compilationDigest,
      bindingSnapshotDigest: preview.bindingSnapshotDigest,
      controlContractDigest: preview.controlContractDigest,
      authorizationRef: 'pilot_authorization_1',
      authorizationDigest: DIGEST_C,
      authorizationResumeKey: `automation-pilot:v1:${DIGEST_A}`,
    },
  };
}

function recurrenceActivation(
  proposal: AutomationOpportunityProposalRecordV1,
  pilotPreview: NonNullable<ReturnType<typeof designApprovedAutomationWorkflowBridge>['preview']>,
  recurrencePreview: NonNullable<ReturnType<typeof designApprovedAutomationWorkflowBridge>['preview']>,
): AutomationWorkflowActivationV1 {
  return {
    kind: 'recurrence',
    pilot: {
      state: 'succeeded',
      proposalRevision: proposal.revision,
      proposalDigest: proposal.digest,
      pilotCompilationDigest: pilotPreview.compilationDigest,
      pilotBindingSnapshotDigest: pilotPreview.bindingSnapshotDigest,
      pilotControlContractDigest: pilotPreview.controlContractDigest,
      pilotAuthorizationRef: 'pilot_authorization_1',
      runOccurrenceId: 'pilot_occurrence_1',
      evidenceRef: 'pilot_evidence_1',
      evidenceDigest: DIGEST_D,
      terminalReceiptDigest: DIGEST_A,
    },
    recurrenceConsent: {
      proposalRevision: proposal.revision,
      proposalDigest: proposal.digest,
      compilationDigest: recurrencePreview.compilationDigest,
      bindingSnapshotDigest: recurrencePreview.bindingSnapshotDigest,
      controlContractDigest: recurrencePreview.controlContractDigest,
      consentRef: 'recurrence_consent_1',
      consentDigest: DIGEST_C,
    },
  };
}

function input(
  proposal = approvedRecord(),
  capabilities = [capability(proposal.opportunity)],
  activation: AutomationWorkflowActivationV1 = { kind: 'preview', target: 'pilot' },
): AutomationWorkflowBridgeInputV1 {
  return {
    proposal,
    expectedProposalRevision: proposal.revision,
    expectedProposalDigest: proposal.digest,
    activation,
    liveSnapshot: snapshot(capabilities),
  };
}

function exactPilotPreview(
  proposal: AutomationOpportunityProposalRecordV1,
  capabilities = [capability(proposal.opportunity)],
) {
  const result = designApprovedAutomationWorkflowBridge(input(
    proposal,
    capabilities,
    { kind: 'preview', target: 'pilot' },
  ));
  assert.ok(result.preview);
  return result.preview;
}

function exactPilotSuccess(
  proposal: AutomationOpportunityProposalRecordV1,
  preview: NonNullable<ReturnType<typeof designApprovedAutomationWorkflowBridge>['preview']>,
) {
  return {
    state: 'succeeded' as const,
    proposalRevision: proposal.revision,
    proposalDigest: proposal.digest,
    pilotCompilationDigest: preview.compilationDigest,
    pilotBindingSnapshotDigest: preview.bindingSnapshotDigest,
    pilotControlContractDigest: preview.controlContractDigest,
    pilotAuthorizationRef: 'pilot_authorization_1',
    runOccurrenceId: 'pilot_occurrence_1',
    evidenceRef: 'pilot_evidence_1',
    evidenceDigest: DIGEST_D,
    terminalReceiptDigest: DIGEST_A,
  };
}

function exactRecurrencePreview(
  proposal: AutomationOpportunityProposalRecordV1,
  capabilities: AutomationLiveCapabilityContractV1[],
  pilotPreview: NonNullable<ReturnType<typeof designApprovedAutomationWorkflowBridge>['preview']>,
) {
  const result = designApprovedAutomationWorkflowBridge(input(
    proposal,
    capabilities,
    { kind: 'preview', target: 'recurrence', pilot: exactPilotSuccess(proposal, pilotPreview) },
  ));
  assert.ok(result.preview);
  return result.preview;
}

function issueCodes(result: ReturnType<typeof designApprovedAutomationWorkflowBridge>): string[] {
  return result.issues.map((issue) => issue.code);
}

function exactReadContract() {
  return {
    phaseId: 'observe',
    requirementId: 'observe-state',
    workflowInputs: {
      scope: { type: 'string' as const, required: true, description: 'Exact bounded scope.' },
    },
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
  };
}

function exactPaginatedReadContract(maxPages = 3) {
  return {
    ...exactReadContract(),
    arguments: {
      ...exactReadContract().arguments,
      cursor: {
        source: { kind: 'continuation_cursor' as const },
        required: false,
        type: 'string' as const,
      },
    },
    completeness: {
      kind: 'finite_exhaustive' as const,
      exhaustedPath: 'page.exhausted',
      evidencePaths: ['records'],
    },
    continuation: {
      kind: 'cursor' as const,
      cursorArgument: 'cursor',
      nextCursorPath: 'page.next',
      exhaustedPath: 'page.exhausted',
      maxPages,
    },
  };
}

test('cold unique live capability resolves, but the current workflow format stays inert', () => {
  const proposal = approvedRecord();
  const live = capability(proposal.opportunity);
  const result = designApprovedAutomationWorkflowBridge(input(proposal, [live]));

  assert.deepEqual(issueCodes(result), ['workflow_tool_kernel_binding_unrepresented']);
  assert.ok(result.preview);
  assert.equal(result.preview.executable, false);
  assert.equal(result.preview.workflow.enabled, false);
  assert.deepEqual(result.preview.workflow.trigger, { manual: true });
  assert.equal(validateWorkflowGraph(result.preview.graph).ok, true);
  assert.equal(result.preview.capabilityBindings[0].logicalToolName, live.logicalToolName);
  assert.equal(result.preview.workflow.steps[0].call, undefined);
  assert.equal(result.preview.workflow.steps[0].allowedTools?.includes(live.logicalToolName), false);
  assert.equal(JSON.stringify(proposal.opportunity).includes(live.logicalToolName), false);
});

test('pilot consent can only name an already-rendered inert preview', () => {
  const proposal = approvedRecord();
  const live = [capability(proposal.opportunity)];
  const preview = exactPilotPreview(proposal, live);
  const authorized = designApprovedAutomationWorkflowBridge(input(
    proposal,
    live,
    pilotActivation(proposal, preview),
  ));

  assert.ok(authorized.preview);
  assert.equal(authorized.preview.compilationDigest, preview.compilationDigest);
  assert.equal(authorized.preview.bindingSnapshotDigest, preview.bindingSnapshotDigest);
  assert.equal(authorized.preview.controlContractDigest, preview.controlContractDigest);
  assert.deepEqual(issueCodes(authorized), ['workflow_tool_kernel_binding_unrepresented']);
  assert.equal(authorized.preview.executable, false);
  assert.equal(authorized.preview.workflow.enabled, false);
});

test('one exact non-paginated read compiles into a disabled plan and authorization binds its bytes', () => {
  const proposal = approvedRecord();
  const live = [capability(proposal.opportunity)];
  const previewRequest = input(proposal, live);
  previewRequest.readPilotContract = exactReadContract();
  const rendered = designApprovedAutomationWorkflowBridge(previewRequest);
  assert.equal(rendered.ok, true, JSON.stringify(rendered.issues));
  assert.deepEqual(rendered.issues, []);
  assert.ok(rendered.preview);
  assert.ok(rendered.pilotApprovalRequest);
  if (!rendered.preview || !rendered.pilotApprovalRequest) return;
  const step = rendered.preview.workflow.steps[0];
  assert.equal(rendered.preview.workflow.enabled, false);
  assert.deepEqual(rendered.preview.workflow.trigger, { manual: true });
  assert.ok(step.invocationPlan);
  assert.equal(step.invocationPlan?.binding.capabilityId, 'capability_alpha');
  assert.equal(step.invocationPlan?.binding.operationId, 'operation_capability_alpha');
  assert.equal(step.call, undefined);
  assert.equal(step.allowedTools, undefined);
  assert.equal(JSON.stringify(step.invocationPlan).includes('surface_capability_alpha'), false);

  const activation = pilotActivation(proposal, rendered.preview);
  if (activation.kind !== 'pilot') return;
  activation.pilot.authorizationResumeKey = rendered.pilotApprovalRequest.resumeKey;
  const authorizedRequest = input(proposal, live, activation);
  authorizedRequest.readPilotContract = exactReadContract();
  const authorized = designApprovedAutomationWorkflowBridge(authorizedRequest);
  assert.equal(authorized.ok, true, JSON.stringify(authorized.issues));
  assert.ok(authorized.pilotAdmission);
  assert.equal(authorized.pilotAdmission?.invocationPlanDigest, step.invocationPlan?.bindingDigest);
  assert.equal(authorized.pilotAdmission?.workflowDigest.length, 64);
  assert.equal(
    authorized.pilotAdmission?.oneShotActivationAuthorization.resumeKey,
    rendered.pilotApprovalRequest.resumeKey,
  );

  activation.pilot.authorizationResumeKey = `automation-pilot:v1:${DIGEST_D}`;
  const staleRequest = input(proposal, live, activation);
  staleRequest.readPilotContract = exactReadContract();
  const stale = designApprovedAutomationWorkflowBridge(staleRequest);
  assert.deepEqual(issueCodes(stale), ['pilot_authority_mismatch']);
  assert.equal(stale.pilotAdmission, undefined);
});

test('pilot goal judges only selected pilot criteria while recurrence retains the full objective', () => {
  const mixed = opportunity({
    successCriteria: [
      {
        id: 'terminal',
        description: 'The bounded pilot carries terminal evidence.',
        evidence: ['A receipt reference is present.'],
      },
      {
        id: 'long-horizon',
        description: 'The eventual recurring dataset covers the full operating horizon.',
        evidence: ['Every future partition is represented.'],
      },
    ],
    pilot: {
      required: true,
      maxPartitions: 1,
      maxRecords: 10,
      effectCeiling: { class: 'read', maxOperationsPerRun: 5 },
      successCriterionIds: ['terminal'],
      haltOnFailure: true,
    },
  });
  const proposal = approvedRecord(mixed);
  const live = [capability(proposal.opportunity)];

  const pilotRequest = input(proposal, live, { kind: 'preview', target: 'pilot' });
  pilotRequest.readPilotContract = exactReadContract();
  const pilot = designApprovedAutomationWorkflowBridge(pilotRequest);
  assert.equal(pilot.ok, true, JSON.stringify(pilot.issues));
  assert.deepEqual(pilot.preview?.workflow.goal?.successCriteria, [
    'The bounded pilot carries terminal evidence.',
  ]);

  assert.ok(pilot.preview);
  if (!pilot.preview) return;
  const recurrenceRequest = input(proposal, live, {
    kind: 'preview',
    target: 'recurrence',
    pilot: exactPilotSuccess(proposal, pilot.preview),
  });
  recurrenceRequest.readPilotContract = exactReadContract();
  const recurrence = designApprovedAutomationWorkflowBridge(recurrenceRequest);
  assert.ok(recurrence.preview);
  assert.deepEqual(recurrence.preview?.workflow.goal?.successCriteria, [
    'The eventual recurring dataset covers the full operating horizon.',
    'The bounded pilot carries terminal evidence.',
  ]);
});

test('one exact paginated read seals cursor, exhaustion, and reviewed page budget into the plan', () => {
  const proposal = approvedRecord();
  const live = [capability(proposal.opportunity)];
  const request = input(proposal, live);
  request.readPilotContract = exactPaginatedReadContract(3);
  const rendered = designApprovedAutomationWorkflowBridge(request);
  assert.equal(rendered.ok, true, JSON.stringify(rendered.issues));
  assert.deepEqual(rendered.issues, []);
  const plan = rendered.preview?.workflow.steps[0]?.invocationPlan;
  assert.ok(plan);
  assert.deepEqual(plan?.continuation, {
    kind: 'cursor',
    cursorArgument: 'cursor',
    nextCursorPath: 'page.next',
    exhaustedPath: 'page.exhausted',
    maxPages: 3,
  });
  assert.deepEqual(plan?.completeness, {
    kind: 'finite_exhaustive',
    exhaustedPath: 'page.exhausted',
    evidencePaths: ['records'],
  });

  const overBudget = input(proposal, live);
  overBudget.readPilotContract = exactPaginatedReadContract(5);
  const refused = designApprovedAutomationWorkflowBridge(overBudget);
  assert.equal(refused.ok, false);
  assert.equal(refused.preview, undefined);
  assert.match(refused.issues[0]?.message ?? '', /reviewed operation budget/);
});

test('a renamed operation is resolved from current live truth, never a remembered physical name', () => {
  const proposal = approvedRecord();
  const before = capability(proposal.opportunity, 'capability_alpha');
  const after = capability(proposal.opportunity, 'capability_alpha', {
    logicalToolName: 'surface_shifted',
    identity: identity('capability_alpha', {
      operationId: 'operation_shifted',
      schemaDigest: DIGEST_D,
      liveFingerprint: DIGEST_D,
    }),
  });

  const first = designApprovedAutomationWorkflowBridge(input(proposal, [before]));
  const renamed = designApprovedAutomationWorkflowBridge(input(proposal, [after]));
  assert.ok(first.preview && renamed.preview);
  assert.equal(renamed.preview.capabilityBindings[0].logicalToolName, 'surface_shifted');
  assert.equal(renamed.preview.capabilityBindings[0].operationId, 'operation_shifted');
  assert.notEqual(
    first.preview.capabilityBindings[0].contractDigest,
    renamed.preview.capabilityBindings[0].contractDigest,
  );
  assert.deepEqual(
    first.preview.graph.nodes.map((node) => node.id),
    renamed.preview.graph.nodes.map((node) => node.id),
  );
});

test('missing and ambiguous renamed successors fail before a workflow preview exists', () => {
  const proposal = approvedRecord();
  const missing = designApprovedAutomationWorkflowBridge(input(proposal, []));
  assert.deepEqual(issueCodes(missing), ['capability_missing']);
  assert.equal(missing.preview, undefined);

  const ambiguous = designApprovedAutomationWorkflowBridge(input(proposal, [
    capability(proposal.opportunity, 'capability_successor_a', {
      logicalToolName: 'surface_shifted_a',
    }),
    capability(proposal.opportunity, 'capability_successor_b', {
      logicalToolName: 'surface_shifted_b',
    }),
  ]));
  assert.deepEqual(issueCodes(ambiguous), ['capability_ambiguous']);
  assert.equal(ambiguous.preview, undefined);
});

test('an exact selection detects schema, account, and operation contract drift', () => {
  const proposal = approvedRecord();
  const reviewed = capability(proposal.opportunity, 'capability_alpha');
  const changedIdentities: CanonicalCatalogIdentityV1[] = [
    identity('capability_alpha', { schemaDigest: DIGEST_D, liveFingerprint: DIGEST_D }),
    identity('capability_alpha', { account: 'account_shifted' }),
    identity('capability_alpha', { operationId: 'operation_shifted' }),
  ];
  for (const changedIdentity of changedIdentities) {
    const changed = capability(proposal.opportunity, 'capability_alpha', {
      identity: changedIdentity,
    });
    const request = input(proposal, [changed]);
    request.selections = [{
      requirementId: 'observe-state',
      capabilityId: 'capability_alpha',
      expectedContractDigest: automationLiveCapabilityContractDigest(reviewed),
    }];
    const result = designApprovedAutomationWorkflowBridge(request);
    assert.deepEqual(issueCodes(result), ['capability_drift']);
    assert.equal(result.preview, undefined);
  }
});

test('a capability with a stronger effect cannot satisfy a read requirement', () => {
  const proposal = approvedRecord();
  const unsafe = capability(proposal.opportunity, 'capability_alpha', {
    identity: identity('capability_alpha', {
      effect: 'external_write',
      idempotency: { required: true, policy: 'key_before_dispatch' },
      reconciliation: { supported: true, policy: 'exact_artifact' },
      reconcilePortId: 'reconcile_capability_alpha',
    }),
  });

  const result = designApprovedAutomationWorkflowBridge(input(proposal, [unsafe]));
  assert.deepEqual(issueCodes(result), ['capability_effect_unsafe']);
  assert.equal(result.preview, undefined);
});

test('plain approved status cannot activate recurrence before pilot evidence and separate consent', () => {
  const proposal = approvedRecord();
  const live = [capability(proposal.opportunity)];
  const pilotPreview = exactPilotPreview(proposal, live);
  const approvedOnly = pilotActivation(proposal, pilotPreview) as unknown as {
    kind: 'pilot';
    pilot: Record<string, unknown>;
  };
  delete approvedOnly.pilot.authorizationRef;
  delete approvedOnly.pilot.authorizationDigest;
  const noPilotAuthorization = designApprovedAutomationWorkflowBridge(input(
    proposal,
    live,
    approvedOnly as unknown as AutomationWorkflowActivationV1,
  ));
  assert.deepEqual(issueCodes(noPilotAuthorization), ['pilot_authority_mismatch']);
  assert.equal(noPilotAuthorization.preview, undefined);

  const stalePilot = pilotActivation(proposal, pilotPreview);
  if (stalePilot.kind === 'pilot') stalePilot.pilot.compilationDigest = DIGEST_D;
  const changedPilot = designApprovedAutomationWorkflowBridge(input(proposal, live, stalePilot));
  assert.ok(changedPilot.preview, 'a stale decision returns the current inert preview for re-review');
  assert.deepEqual(issueCodes(changedPilot), [
    'pilot_authority_mismatch',
    'workflow_tool_kernel_binding_unrepresented',
  ]);

  const notPiloted = {
    kind: 'recurrence',
    pilot: { state: 'authorized' },
    recurrenceConsent: {
      proposalRevision: proposal.revision,
      proposalDigest: proposal.digest,
      compilationDigest: DIGEST_A,
      bindingSnapshotDigest: DIGEST_B,
      controlContractDigest: DIGEST_C,
      consentRef: 'recurrence_consent_1',
      consentDigest: DIGEST_C,
    },
  } as unknown as AutomationWorkflowActivationV1;
  const blocked = designApprovedAutomationWorkflowBridge(input(
    proposal,
    live,
    notPiloted,
  ));
  assert.deepEqual(issueCodes(blocked), ['pilot_not_succeeded']);
  assert.equal(blocked.preview, undefined);

  const recurrencePreview = exactRecurrencePreview(proposal, live, pilotPreview);
  for (const missing of [
    'pilotAuthorizationRef',
    'runOccurrenceId',
    'terminalReceiptDigest',
  ] as const) {
    const activation = recurrenceActivation(proposal, pilotPreview, recurrencePreview) as unknown as {
      kind: 'recurrence';
      pilot: Record<string, unknown>;
    };
    delete activation.pilot[missing];
    const missingPilotLineage = designApprovedAutomationWorkflowBridge(input(
      proposal,
      live,
      activation as unknown as AutomationWorkflowActivationV1,
    ));
    assert.deepEqual(
      issueCodes(missingPilotLineage),
      ['pilot_authority_mismatch'],
      `${missing} must be durable before recurrence can be previewed or authorized`,
    );
    assert.equal(missingPilotLineage.preview, undefined);
  }

  const noConsent = recurrenceActivation(proposal, pilotPreview, recurrencePreview) as unknown as {
    kind: 'recurrence';
    pilot: AutomationWorkflowActivationV1 extends { kind: 'recurrence'; pilot: infer T } ? T : never;
    recurrenceConsent: Record<string, unknown>;
  };
  delete noConsent.recurrenceConsent.consentRef;
  delete noConsent.recurrenceConsent.consentDigest;
  const missingConsent = designApprovedAutomationWorkflowBridge(input(
    proposal,
    live,
    noConsent as unknown as AutomationWorkflowActivationV1,
  ));
  assert.deepEqual(issueCodes(missingConsent), ['recurrence_consent_mismatch']);
  assert.equal(missingConsent.preview, undefined);

  const consentDrift = recurrenceActivation(proposal, pilotPreview, recurrencePreview);
  if (consentDrift.kind === 'recurrence') consentDrift.recurrenceConsent.proposalRevision -= 1;
  const stale = designApprovedAutomationWorkflowBridge(input(
    proposal,
    [capability(proposal.opportunity)],
    consentDrift,
  ));
  assert.deepEqual(issueCodes(stale), ['recurrence_consent_mismatch']);
});

test('after exact pilot success, the disabled workflow is the only owner of cadence', () => {
  const proposal = approvedRecord();
  const live = [capability(proposal.opportunity)];
  const pilotPreview = exactPilotPreview(proposal, live);
  const recurrencePreview = exactRecurrencePreview(proposal, live, pilotPreview);
  const activation = recurrenceActivation(proposal, pilotPreview, recurrencePreview);
  const result = designApprovedAutomationWorkflowBridge(input(
    proposal,
    live,
    activation,
  ));

  assert.ok(result.preview);
  assert.deepEqual(result.preview.workflow.trigger, {
    schedule: '15 4 * * *',
    timezone: 'Etc/UTC',
  });
  assert.equal(result.preview.workflow.enabled, false);
  assert.equal(Object.hasOwn(result.preview.activation, 'schedule'), false);
  assert.equal(Object.hasOwn(result.preview, 'schedule'), false);
});

test('elapsed interval recurrence blocks instead of inventing a second scheduler', () => {
  const value = opportunity({
    recurrence: {
      mode: 'proposed',
      cadence: { kind: 'interval', every: 2, unit: 'hour' },
      overlapPolicy: 'skip',
      catchUpPolicy: 'run_once',
      activation: 'requires_pilot_success_and_recurrence_consent',
    },
  });
  const proposal = approvedRecord(value);
  const pilotPreview = exactPilotPreview(proposal, [capability(value)]);
  const result = designApprovedAutomationWorkflowBridge(input(
    proposal,
    [capability(value)],
    { kind: 'preview', target: 'recurrence', pilot: exactPilotSuccess(proposal, pilotPreview) },
  ));
  assert.deepEqual(issueCodes(result), ['schedule_contract_unrepresented']);
  assert.equal(result.preview, undefined);
});

test('exact approval pair is mandatory even when the record itself says approved', () => {
  const request = input();
  request.expectedProposalRevision -= 1;
  request.expectedProposalDigest = DIGEST_D;
  const result = designApprovedAutomationWorkflowBridge(request);
  assert.deepEqual(issueCodes(result), [
    'proposal_revision_mismatch',
    'proposal_digest_mismatch',
  ]);
  assert.equal(result.preview, undefined);
});

test('replay is byte-stable across catalog and selection ordering', () => {
  const proposal = approvedRecord();
  const selected = capability(proposal.opportunity, 'capability_alpha');
  const other = capability(proposal.opportunity, 'capability_beta');
  const selection = {
    requirementId: 'observe-state',
    capabilityId: 'capability_alpha',
    expectedContractDigest: automationLiveCapabilityContractDigest(selected),
  };

  const forward = input(proposal, [selected, other]);
  forward.selections = [selection];
  const reverse = input(proposal, [other, selected]);
  reverse.selections = [selection];
  assert.equal(forward.liveSnapshot.digest, reverse.liveSnapshot.digest);

  const first = designApprovedAutomationWorkflowBridge(forward);
  const second = designApprovedAutomationWorkflowBridge(reverse);
  assert.ok(first.preview && second.preview);
  assert.equal(first.preview.compilationDigest, second.preview.compilationDigest);
  assert.deepEqual(first.preview, second.preview);
});

test('closed bridge digest boundary rejects accessors without reading or producing approval/run authority', () => {
  const proposal = approvedRecord();
  const request = input(proposal, [capability(proposal.opportunity)]);
  request.readPilotContract = exactReadContract();
  let reads = 0;
  Object.defineProperty(request, 'selections', {
    enumerable: true,
    get() {
      reads += 1;
      return [];
    },
  });

  const result = designApprovedAutomationWorkflowBridge(request);
  assert.equal(reads, 0);
  assert.deepEqual(issueCodes(result), ['proposal_integrity_failure']);
  assert.equal(result.preview, undefined);
  assert.equal(result.pilotApprovalRequest, undefined);
  assert.equal(result.pilotAdmission, undefined);
});
