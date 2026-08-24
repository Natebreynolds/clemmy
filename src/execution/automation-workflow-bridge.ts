/**
 * Fail-closed pure compiler from an approved AutomationOpportunityV1 to the
 * durable workflow contracts that exist today.
 *
 * This module intentionally performs no persistence, approval mutation,
 * scheduling, or execution. For one provider-neutral read pilot it can emit a
 * versioned WorkflowNodeInvocationPlan whose exact manifest/schema/account/
 * effect/port binding survives workflow storage. The same sealed plan may
 * explicitly carry a bounded cursor contract. A separate admission adapter
 * binds that inert preview to a formal one-shot approval and the matching
 * workflow read ToolKernel root. Every other execution shape stays
 * represented only as a disabled preview or an explicit blocker.
 *
 * The returned preview is useful and deliberately inert: it proves the exact
 * approved proposal, resolves the current live contracts, preserves the DAG,
 * and places any proposed cadence only on WorkflowDefinition.trigger. Every
 * preview is disabled and result-only; callers must never treat preview bytes
 * alone as execution or recurrence authority.
 */
import { createHash } from 'node:crypto';

import type {
  WorkflowDefinition,
  WorkflowInputDef,
  WorkflowTrigger,
} from '../memory/workflow-store.js';
import {
  createWorkflowNodeInvocationPlan,
  type WorkflowNodeArgumentBindingV1,
  type WorkflowNodeCompletenessContractV1,
  type WorkflowNodeContinuationContractV1,
  type WorkflowNodeEvidenceContractV1,
} from '../memory/workflow-node-invocation-plan.js';
import {
  parseWorkflowCanonicalEntityResultProjection,
  type WorkflowCanonicalEntityResultProjectionV1,
} from '../memory/workflow-result-projection-contract.js';
import {
  createCanonicalEntityWorkspaceBindingApproval,
  parseCanonicalEntityWorkspaceBindingSelection,
  type CanonicalEntityWorkspaceBindingApprovalV1,
  type CanonicalEntityWorkspaceBindingSelectionV1,
} from '../spaces/canonical-entity-workspace-binding-contract.js';
import type { CanonicalCatalogIdentityV1 } from '../runtime/harness/host-capability-catalog-factory.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import {
  WORKFLOW_GRAPH_ALLOWED_TOOLS,
  compileWorkflowStepsToGraph,
  validateWorkflowGraph,
  type WorkflowGraphDefinition,
} from './workflow-graph.js';
import {
  automationOpportunityDigest,
  parseAutomationOpportunity,
  type AutomationCapabilityRequirementV1,
  type AutomationOpportunityV1,
} from './automation-opportunity.js';
import type { AutomationOpportunityProposalRecordV1 } from './automation-opportunity-store.js';
import type { ProjectEffectClass } from './project-plan-ir.js';
import { workflowDefinitionHash } from './workflow-run-definition.js';
import {
  createWorkflowReadPilotAdmissionDraft,
  workflowReadPilotApprovalRequest,
  workflowReadPilotOccurrenceId,
  workflowReadPilotSessionId,
  type WorkflowReadPilotAdmissionDraftV1,
  type WorkflowReadPilotApprovalRequestV1,
  type WorkflowReadPilotLineageV1,
} from './workflow-read-pilot-admission.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const AUTHORITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;
const EXACT_TOOL_RE = /^[^\s*{}]+$/;

export const AUTOMATION_WORKFLOW_BRIDGE_DESIGN_VERSION = 1 as const;

/**
 * A live semantic match is tied to the exact requirement bytes. A stale match
 * from a previous proposal revision is drift, not authority.
 */
export interface AutomationLiveCapabilityMatchV1 {
  requirementId: string;
  requirementDigest: string;
}

/**
 * Compiler input projected from the host-owned live catalog. It contains no
 * invocation arguments. `logicalToolName` is retained only in the separate
 * binding preview; it is never copied into the approved proposal or an
 * executable WorkflowStepInput.
 */
export interface AutomationLiveCapabilityContractV1 {
  lifecycle: 'current' | 'unavailable' | 'revoked';
  logicalToolName: string;
  identity: CanonicalCatalogIdentityV1;
  matches: AutomationLiveCapabilityMatchV1[];
}

export interface AutomationLiveCapabilitySnapshotV1 {
  digest: string;
  capabilities: AutomationLiveCapabilityContractV1[];
}

/** Optional explicit disambiguation, itself pinned to exact live bytes. */
export interface AutomationApprovedCapabilitySelectionV1 {
  requirementId: string;
  capabilityId: string;
  expectedContractDigest: string;
}

/** Durable consent/evidence records are required because the proposal store's
 * plain `approved` status does not distinguish preview review, pilot
 * authorization, pilot success, and recurrence authorization. This pure
 * compiler validates their exact identities and reviewed digests; the runtime
 * must project them from the canonical approval/receipt authority seam rather
 * than trusting caller-authored references. */
export interface AutomationPilotAuthorizationV1 {
  state: 'authorized';
  proposalRevision: number;
  proposalDigest: string;
  compilationDigest: string;
  bindingSnapshotDigest: string;
  controlContractDigest: string;
  authorizationRef: string;
  authorizationDigest: string;
  /** Canonical approval-registry resume key derived from the preview lineage.
   * It is consumed atomically by the matching workflow read authority. */
  authorizationResumeKey: string;
}

export interface AutomationPilotSuccessEvidenceV1 {
  state: 'succeeded';
  proposalRevision: number;
  proposalDigest: string;
  pilotCompilationDigest: string;
  pilotBindingSnapshotDigest: string;
  pilotControlContractDigest: string;
  pilotAuthorizationRef: string;
  runOccurrenceId: string;
  evidenceRef: string;
  evidenceDigest: string;
  terminalReceiptDigest: string;
}

export interface AutomationRecurrenceConsentV1 {
  proposalRevision: number;
  proposalDigest: string;
  compilationDigest: string;
  bindingSnapshotDigest: string;
  controlContractDigest: string;
  consentRef: string;
  consentDigest: string;
}

export type AutomationWorkflowActivationV1 =
  | {
    /** Compile an inert plan first. A preview grants no pilot or recurrence
     * authority; its exact digests are what a later human decision names. */
    kind: 'preview';
    target: 'pilot';
  }
  | {
    kind: 'preview';
    target: 'recurrence';
    pilot: AutomationPilotSuccessEvidenceV1;
  }
  | {
    kind: 'pilot';
    pilot: AutomationPilotAuthorizationV1;
  }
  | {
    kind: 'recurrence';
    pilot:
      | { state: 'not_started' | 'authorized' | 'failed' }
      | AutomationPilotSuccessEvidenceV1;
    recurrenceConsent: AutomationRecurrenceConsentV1;
  };

export interface AutomationWorkflowBridgeInputV1 {
  proposal: AutomationOpportunityProposalRecordV1;
  expectedProposalRevision: number;
  expectedProposalDigest: string;
  activation: AutomationWorkflowActivationV1;
  liveSnapshot: AutomationLiveCapabilitySnapshotV1;
  selections?: AutomationApprovedCapabilitySelectionV1[];
  /** Explicit provider-neutral compiler inputs for one read node. They contain
   * typed sources, continuation, and result evidence, never rendered arguments
   * or a physical tool name. */
  readPilotContract?: AutomationSingleReadPilotContractV1;
}

export interface AutomationSingleReadPilotContractV1 {
  phaseId: string;
  requirementId: string;
  workflowInputs: Record<string, WorkflowInputDef>;
  arguments: Record<string, WorkflowNodeArgumentBindingV1>;
  evidence: WorkflowNodeEvidenceContractV1;
  completeness: WorkflowNodeCompletenessContractV1;
  continuation?: WorkflowNodeContinuationContractV1;
  resultProjection?: WorkflowCanonicalEntityResultProjectionV1;
  workspaceBindingSelection?: CanonicalEntityWorkspaceBindingSelectionV1;
}

export type AutomationWorkflowBridgeIssueCode =
  | 'proposal_not_approved'
  | 'proposal_revision_mismatch'
  | 'proposal_digest_mismatch'
  | 'proposal_integrity_failure'
  | 'required_input_missing'
  | 'pilot_authority_mismatch'
  | 'pilot_not_succeeded'
  | 'recurrence_consent_mismatch'
  | 'recurrence_not_proposed'
  | 'schedule_contract_unrepresented'
  | 'live_snapshot_invalid'
  | 'live_snapshot_digest_mismatch'
  | 'selection_invalid'
  | 'capability_missing'
  | 'capability_ambiguous'
  | 'capability_drift'
  | 'capability_effect_unsafe'
  | 'capability_write_contract_unsafe'
  | 'workflow_tool_kernel_binding_unrepresented'
  | 'workflow_partition_contract_unrepresented'
  | 'workflow_dataset_contract_unrepresented'
  | 'workspace_binding_contract_unrepresented'
  | 'workflow_effect_authority_unrepresented'
  | 'workflow_graph_invalid';

export interface AutomationWorkflowBridgeIssueV1 {
  code: AutomationWorkflowBridgeIssueCode;
  message: string;
  requirementId?: string;
  phaseId?: string;
}

export interface AutomationWorkflowCapabilityBindingV1 {
  requirementId: string;
  requirementDigest: string;
  capabilityId: string;
  logicalToolName: string;
  contractDigest: string;
  manifestId: string;
  manifestDigest: string;
  operationId: string;
  schemaVersion: string;
  schemaDigest: string;
  providerVersion: string;
  liveFingerprint: string;
  account: string;
  effect: ProjectEffectClass;
  invokePortId: string;
  argumentCompiler: { id: string; version: string };
  reconcilePortId?: string;
}

export interface AutomationWorkflowBridgePreviewV1 {
  version: typeof AUTOMATION_WORKFLOW_BRIDGE_DESIGN_VERSION;
  executable: false;
  proposal: {
    proposalId: string;
    revision: number;
    digest: string;
  };
  activation: 'pilot' | 'recurrence';
  workflow: WorkflowDefinition;
  graph: WorkflowGraphDefinition;
  capabilityBindings: AutomationWorkflowCapabilityBindingV1[];
  liveSnapshotDigest: string;
  bindingSnapshotDigest: string;
  /** Exact effect, pilot, partition, cadence, and run-budget bytes the human
   * reviews in addition to the selected live bindings. */
  controlContractDigest: string;
  compilationDigest: string;
  canonicalEntityWorkspaceBinding?: CanonicalEntityWorkspaceBindingApprovalV1;
}

export interface AutomationWorkflowBridgeResultV1 {
  ok: boolean;
  issues: AutomationWorkflowBridgeIssueV1[];
  /** Present only after all approval/live-resolution checks have succeeded. */
  preview?: AutomationWorkflowBridgePreviewV1;
  /** Exact formal approval request for the already-rendered disabled preview. */
  pilotApprovalRequest?: WorkflowReadPilotApprovalRequestV1;
  /** Present only after exact pilot authorization names that preview. This is
   * queue admission data, not scheduling authority. */
  pilotAdmission?: WorkflowReadPilotAdmissionDraftV1;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 32,
    maxNodes: 20_000,
    maxStringBytes: 64_000,
    maxTotalBytes: 512_000,
  });
}

function canonicalLiveCapability(contract: AutomationLiveCapabilityContractV1): unknown {
  return {
    lifecycle: contract.lifecycle,
    logicalToolName: contract.logicalToolName,
    identity: contract.identity,
    matches: [...contract.matches]
      .map((match) => ({ ...match }))
      .sort((left, right) => left.requirementId.localeCompare(right.requirementId)
        || left.requirementDigest.localeCompare(right.requirementDigest)),
  };
}

export function automationCapabilityRequirementDigest(
  requirement: AutomationCapabilityRequirementV1,
): string {
  return sha256(stableJson({
    id: requirement.id,
    description: requirement.description,
    minimumEffect: requirement.minimumEffect,
    constraints: [...requirement.constraints].sort(),
  }));
}

export function automationLiveCapabilityContractDigest(
  contract: AutomationLiveCapabilityContractV1,
): string {
  return sha256(stableJson(canonicalLiveCapability(contract)));
}

export function automationLiveCapabilitySnapshotDigest(
  capabilities: readonly AutomationLiveCapabilityContractV1[],
): string {
  const entries = capabilities
    .map((contract) => ({
      capabilityId: contract.identity.capabilityId,
      contractDigest: automationLiveCapabilityContractDigest(contract),
    }))
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)
      || left.contractDigest.localeCompare(right.contractDigest));
  return sha256(stableJson(entries));
}

function exactProposalRef(
  input: { proposalRevision: number; proposalDigest: string },
  proposal: AutomationOpportunityProposalRecordV1,
): boolean {
  return input.proposalRevision === proposal.revision
    && input.proposalDigest === proposal.digest;
}

function exactExternalRef(ref: unknown): ref is string {
  return typeof ref === 'string' && SAFE_ID_RE.test(ref);
}

function exactExternalEvidence(ref: unknown, digest: unknown): boolean {
  return exactExternalRef(ref)
    && typeof digest === 'string'
    && SHA256_RE.test(digest);
}

function exactDigestSet(...values: unknown[]): boolean {
  return values.every((value) => typeof value === 'string' && SHA256_RE.test(value));
}

function activationTarget(
  activation: AutomationWorkflowActivationV1,
): 'pilot' | 'recurrence' {
  return activation.kind === 'preview' ? activation.target : activation.kind;
}

function proposalIssues(
  input: AutomationWorkflowBridgeInputV1,
): { opportunity?: AutomationOpportunityV1; issues: AutomationWorkflowBridgeIssueV1[] } {
  const issues: AutomationWorkflowBridgeIssueV1[] = [];
  if (input.proposal.status !== 'approved') {
    issues.push({
      code: 'proposal_not_approved',
      message: `Proposal "${input.proposal.proposalId}" is ${input.proposal.status}, not approved.`,
    });
  }
  if (input.expectedProposalRevision !== input.proposal.revision) {
    issues.push({
      code: 'proposal_revision_mismatch',
      message: `Expected proposal revision ${input.expectedProposalRevision}; current revision is ${input.proposal.revision}.`,
    });
  }
  if (input.expectedProposalDigest !== input.proposal.digest) {
    issues.push({
      code: 'proposal_digest_mismatch',
      message: 'Expected proposal digest does not match the approved record.',
    });
  }

  let opportunity: AutomationOpportunityV1 | undefined;
  try {
    opportunity = parseAutomationOpportunity(input.proposal.opportunity);
    if (!SHA256_RE.test(input.proposal.digest)
      || automationOpportunityDigest(opportunity) !== input.proposal.digest) {
      issues.push({
        code: 'proposal_integrity_failure',
        message: 'Approved proposal bytes do not match their semantic digest.',
      });
    }
  } catch (error) {
    issues.push({
      code: 'proposal_integrity_failure',
      message: error instanceof Error ? error.message : 'Approved proposal is invalid.',
    });
  }

  if (opportunity) {
    const missing = opportunity.missingInputs.filter((item) => item.required);
    if (missing.length > 0) {
      issues.push({
        code: 'required_input_missing',
        message: `Required inputs remain unresolved: ${missing.map((item) => item.id).join(', ')}.`,
      });
    }
  }

  if (input.activation.kind === 'pilot') {
    if (
      !exactProposalRef(input.activation.pilot, input.proposal)
      || !exactDigestSet(
        input.activation.pilot.compilationDigest,
        input.activation.pilot.bindingSnapshotDigest,
        input.activation.pilot.controlContractDigest,
      )
      || !exactExternalEvidence(
        input.activation.pilot.authorizationRef,
        input.activation.pilot.authorizationDigest,
      )
      || typeof input.activation.pilot.authorizationResumeKey !== 'string'
      || !input.activation.pilot.authorizationResumeKey.startsWith('automation-pilot:v1:')
    ) {
      issues.push({
        code: 'pilot_authority_mismatch',
        message: 'Pilot authority is not pinned to this exact approved revision and digest.',
      });
    }
  }

  const target = activationTarget(input.activation);
  const pilotSuccess = input.activation.kind === 'recurrence'
    || (input.activation.kind === 'preview' && input.activation.target === 'recurrence')
    ? input.activation.pilot
    : undefined;
  if (target === 'recurrence') {
    if (!pilotSuccess || pilotSuccess.state !== 'succeeded') {
      issues.push({
        code: 'pilot_not_succeeded',
        message: 'Recurrence cannot compile before the exact proposal pilot succeeds.',
      });
    } else if (
      !exactProposalRef(pilotSuccess, input.proposal)
      || !exactDigestSet(
        pilotSuccess.pilotCompilationDigest,
        pilotSuccess.pilotBindingSnapshotDigest,
        pilotSuccess.pilotControlContractDigest,
        pilotSuccess.terminalReceiptDigest,
      )
      || !exactExternalRef(pilotSuccess.pilotAuthorizationRef)
      || typeof pilotSuccess.runOccurrenceId !== 'string'
      || !AUTHORITY_ID_RE.test(pilotSuccess.runOccurrenceId)
      || !exactExternalEvidence(
        pilotSuccess.evidenceRef,
        pilotSuccess.evidenceDigest,
      )
    ) {
      issues.push({
        code: 'pilot_authority_mismatch',
        message: 'Pilot success evidence is not pinned to this exact approved revision and digest.',
      });
    }
    if (input.activation.kind === 'recurrence') {
      if (
        !exactProposalRef(input.activation.recurrenceConsent, input.proposal)
        || !exactDigestSet(
          input.activation.recurrenceConsent.compilationDigest,
          input.activation.recurrenceConsent.bindingSnapshotDigest,
          input.activation.recurrenceConsent.controlContractDigest,
        )
        || !exactExternalEvidence(
          input.activation.recurrenceConsent.consentRef,
          input.activation.recurrenceConsent.consentDigest,
        )
      ) {
        issues.push({
          code: 'recurrence_consent_mismatch',
          message: 'Recurrence consent is not pinned to this exact approved revision, preview, and binding digest.',
        });
      }
    }
    if (!opportunity || opportunity.recurrence.mode !== 'proposed') {
      issues.push({
        code: 'recurrence_not_proposed',
        message: 'The approved opportunity does not propose recurrence.',
      });
    } else if (opportunity.recurrence.cadence.kind !== 'calendar') {
      issues.push({
        code: 'schedule_contract_unrepresented',
        message: 'The existing workflow scheduler stores calendar expressions, not elapsed interval semantics.',
      });
    }
  }

  return { opportunity, issues };
}

function identityErrors(contract: AutomationLiveCapabilityContractV1): string[] {
  const errors: string[] = [];
  const identity = contract.identity;
  if (!['current', 'unavailable', 'revoked'].includes(contract.lifecycle)) {
    errors.push('lifecycle is invalid');
  }
  const requiredStrings: Array<[string, unknown]> = [
    ['capabilityId', identity?.capabilityId],
    ['manifestId', identity?.manifestId],
    ['operationId', identity?.operationId],
    ['schemaVersion', identity?.schemaVersion],
    ['providerKind', identity?.providerKind],
    ['providerVersion', identity?.providerVersion],
    ['account', identity?.account],
    ['effect', identity?.effect],
    ['invokePortId', identity?.invokePortId],
    ['argumentCompiler.id', identity?.argumentCompiler?.id],
    ['argumentCompiler.version', identity?.argumentCompiler?.version],
  ];
  for (const [name, value] of requiredStrings) {
    if (typeof value !== 'string' || !value.trim()) errors.push(`${name} is missing`);
  }
  for (const [name, value] of [
    ['manifestDigest', identity?.manifestDigest],
    ['schemaDigest', identity?.schemaDigest],
    ['liveFingerprint', identity?.liveFingerprint],
  ] as const) {
    if (typeof value !== 'string' || !SHA256_RE.test(value)) errors.push(`${name} is not a sha256 digest`);
  }
  if (!AUTHORITY_ID_RE.test(identity?.capabilityId ?? '')) errors.push('capabilityId is not a safe identity');
  if (typeof contract.logicalToolName !== 'string'
    || !EXACT_TOOL_RE.test(contract.logicalToolName)) errors.push('logicalToolName is not exact');
  if (!['read', 'local_write', 'external_write'].includes(identity?.effect ?? '')) {
    errors.push('effect cannot be represented by AutomationOpportunityV1');
  }
  if (!Array.isArray(contract.matches) || contract.matches.length === 0) {
    errors.push('at least one exact requirement match is required');
  }
  const seen = new Set<string>();
  for (const match of contract.matches ?? []) {
    if (!SAFE_ID_RE.test(match.requirementId)) errors.push('requirementId is not a safe identity');
    if (!SHA256_RE.test(match.requirementDigest)) errors.push('requirementDigest is not a sha256 digest');
    if (seen.has(match.requirementId)) errors.push(`requirementId "${match.requirementId}" appears twice`);
    seen.add(match.requirementId);
  }
  return errors;
}

function snapshotIssues(snapshot: AutomationLiveCapabilitySnapshotV1): AutomationWorkflowBridgeIssueV1[] {
  const issues: AutomationWorkflowBridgeIssueV1[] = [];
  if (!snapshot || !Array.isArray(snapshot.capabilities)) {
    return [{
      code: 'live_snapshot_invalid',
      message: 'Live capability snapshot is malformed.',
    }];
  }
  for (const contract of snapshot.capabilities) {
    if (!contract || typeof contract !== 'object' || !contract.identity) {
      issues.push({
        code: 'live_snapshot_invalid',
        message: 'Live capability contract is malformed.',
      });
      continue;
    }
    const errors = identityErrors(contract);
    if (errors.length > 0) {
      issues.push({
        code: 'live_snapshot_invalid',
        message: `Live capability contract is invalid: ${errors.join('; ')}.`,
      });
    }
  }
  if (issues.length > 0) return issues;
  if (!SHA256_RE.test(snapshot.digest)
    || automationLiveCapabilitySnapshotDigest(snapshot.capabilities) !== snapshot.digest) {
    issues.push({
      code: 'live_snapshot_digest_mismatch',
      message: 'Live capability snapshot digest does not match its canonical contracts.',
    });
  }
  return issues;
}

function effectRank(effect: ProjectEffectClass): number {
  return ['read', 'local_write', 'external_write'].indexOf(effect);
}

function writeContractSafe(identity: CanonicalCatalogIdentityV1): boolean {
  if (identity.effect === 'read') return true;
  return Boolean(
    identity.idempotency
    && identity.idempotency.policy !== 'none'
    && identity.reconciliation?.supported === true
    && identity.reconciliation.policy !== 'none'
    && identity.reconcilePortId,
  );
}

function bindingFrom(
  requirement: AutomationCapabilityRequirementV1,
  contract: AutomationLiveCapabilityContractV1,
): AutomationWorkflowCapabilityBindingV1 {
  const identity = contract.identity;
  return {
    requirementId: requirement.id,
    requirementDigest: automationCapabilityRequirementDigest(requirement),
    capabilityId: identity.capabilityId,
    logicalToolName: contract.logicalToolName,
    contractDigest: automationLiveCapabilityContractDigest(contract),
    manifestId: identity.manifestId,
    manifestDigest: identity.manifestDigest,
    operationId: identity.operationId,
    schemaVersion: identity.schemaVersion,
    schemaDigest: identity.schemaDigest,
    providerVersion: identity.providerVersion,
    liveFingerprint: identity.liveFingerprint,
    account: identity.account,
    effect: identity.effect as ProjectEffectClass,
    invokePortId: identity.invokePortId,
    argumentCompiler: { ...identity.argumentCompiler },
    ...(identity.reconcilePortId ? { reconcilePortId: identity.reconcilePortId } : {}),
  };
}

function resolveBindings(input: {
  opportunity: AutomationOpportunityV1;
  snapshot: AutomationLiveCapabilitySnapshotV1;
  selections: readonly AutomationApprovedCapabilitySelectionV1[];
}): { bindings: AutomationWorkflowCapabilityBindingV1[]; issues: AutomationWorkflowBridgeIssueV1[] } {
  const issues: AutomationWorkflowBridgeIssueV1[] = [];
  const selections = new Map<string, AutomationApprovedCapabilitySelectionV1>();
  for (const selection of input.selections) {
    if (
      !SAFE_ID_RE.test(selection.requirementId)
      || !AUTHORITY_ID_RE.test(selection.capabilityId)
      || !SHA256_RE.test(selection.expectedContractDigest)
      || selections.has(selection.requirementId)
    ) {
      issues.push({
        code: 'selection_invalid',
        requirementId: selection.requirementId,
        message: `Capability selection for "${selection.requirementId}" is malformed or duplicated.`,
      });
      continue;
    }
    selections.set(selection.requirementId, selection);
  }

  const knownRequirements = new Set(input.opportunity.capabilityRequirements.map((item) => item.id));
  for (const selection of selections.values()) {
    if (!knownRequirements.has(selection.requirementId)) {
      issues.push({
        code: 'selection_invalid',
        requirementId: selection.requirementId,
        message: `Capability selection references unknown requirement "${selection.requirementId}".`,
      });
    }
  }
  if (issues.length > 0) return { bindings: [], issues };

  const bindings: AutomationWorkflowCapabilityBindingV1[] = [];
  for (const requirement of input.opportunity.capabilityRequirements) {
    const requirementDigest = automationCapabilityRequirementDigest(requirement);
    const current = input.snapshot.capabilities.filter((contract) => (
      contract.lifecycle === 'current'
      && contract.matches.some((match) => match.requirementId === requirement.id)
    ));
    const fresh = current.filter((contract) => contract.matches.some((match) => (
      match.requirementId === requirement.id && match.requirementDigest === requirementDigest
    )));
    if (current.length > 0 && fresh.length === 0) {
      issues.push({
        code: 'capability_drift',
        requirementId: requirement.id,
        message: `Every live match for requirement "${requirement.id}" was produced from stale requirement bytes.`,
      });
      continue;
    }

    const effectSafe = fresh.filter((contract) => contract.identity.effect === requirement.minimumEffect);
    if (fresh.length > 0 && effectSafe.length === 0) {
      issues.push({
        code: 'capability_effect_unsafe',
        requirementId: requirement.id,
        message: `Live matches for requirement "${requirement.id}" do not preserve its ${requirement.minimumEffect} effect.`,
      });
      continue;
    }

    const selection = selections.get(requirement.id);
    const selected = selection
      ? effectSafe.filter((contract) => contract.identity.capabilityId === selection.capabilityId)
      : effectSafe;
    if (selected.length === 0) {
      issues.push({
        code: 'capability_missing',
        requirementId: requirement.id,
        message: selection
          ? `Selected capability "${selection.capabilityId}" is not a current exact match for requirement "${requirement.id}".`
          : `No current exact capability matches requirement "${requirement.id}".`,
      });
      continue;
    }
    if (selected.length > 1) {
      issues.push({
        code: 'capability_ambiguous',
        requirementId: requirement.id,
        message: `Requirement "${requirement.id}" resolves to ${selected.length} current capabilities; choose one exact contract.`,
      });
      continue;
    }

    const contract = selected[0];
    const contractDigest = automationLiveCapabilityContractDigest(contract);
    if (selection && contractDigest !== selection.expectedContractDigest) {
      issues.push({
        code: 'capability_drift',
        requirementId: requirement.id,
        message: `Selected capability "${selection.capabilityId}" no longer matches its approved contract digest.`,
      });
      continue;
    }
    if (!writeContractSafe(contract.identity)) {
      issues.push({
        code: 'capability_write_contract_unsafe',
        requirementId: requirement.id,
        message: `Write capability for requirement "${requirement.id}" lacks exact idempotency and reconciliation authority.`,
      });
      continue;
    }
    bindings.push(bindingFrom(requirement, contract));
  }

  const byRequirement = new Map(bindings.map((binding) => [binding.requirementId, binding]));
  for (const phase of input.opportunity.phases) {
    for (const requirementId of phase.capabilityRequirementIds) {
      const binding = byRequirement.get(requirementId);
      if (!binding) continue;
      if (effectRank(binding.effect) > effectRank(phase.effect.class)) {
        issues.push({
          code: 'capability_effect_unsafe',
          requirementId,
          phaseId: phase.id,
          message: `Capability "${binding.capabilityId}" exceeds phase "${phase.id}" effect ${phase.effect.class}.`,
        });
      }
    }
  }

  return {
    bindings: [...bindings].sort((left, right) => left.requirementId.localeCompare(right.requirementId)),
    issues,
  };
}

function workflowTriggerFor(
  opportunity: AutomationOpportunityV1,
  target: 'pilot' | 'recurrence',
): WorkflowTrigger {
  if (target === 'pilot') return { manual: true };
  const recurrence = opportunity.recurrence;
  if (recurrence.mode !== 'proposed' || recurrence.cadence.kind !== 'calendar') {
    return { manual: true };
  }
  return {
    schedule: recurrence.cadence.expression,
    timezone: recurrence.cadence.timezone,
  };
}

function topologicalPhases(opportunity: AutomationOpportunityV1): AutomationOpportunityV1['phases'] {
  const remaining = [...opportunity.phases].sort((left, right) => left.id.localeCompare(right.id));
  const emitted = new Set<string>();
  const ordered: AutomationOpportunityV1['phases'] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex((phase) => phase.dependsOn.every((id) => emitted.has(id)));
    if (index < 0) return [...opportunity.phases];
    const [phase] = remaining.splice(index, 1);
    ordered.push(phase);
    emitted.add(phase.id);
  }
  return ordered;
}

function exactSingleReadPlan(input: {
  proposal: AutomationOpportunityProposalRecordV1;
  opportunity: AutomationOpportunityV1;
  bindings: AutomationWorkflowCapabilityBindingV1[];
  contract?: AutomationSingleReadPilotContractV1;
}) {
  const contract = input.contract;
  if (!contract) return undefined;
  if (
    input.opportunity.phases.length !== 1
    || input.opportunity.capabilityRequirements.length !== 1
    || input.opportunity.partition.mode !== 'single'
  ) throw new Error('the read pilot compiler supports exactly one unpartitioned phase and one capability');
  const phase = input.opportunity.phases[0];
  const requirement = input.opportunity.capabilityRequirements[0];
  const binding = input.bindings.find((candidate) => candidate.requirementId === contract.requirementId);
  if (
    contract.phaseId !== phase.id
    || contract.requirementId !== requirement.id
    || phase.capabilityRequirementIds.length !== 1
    || phase.capabilityRequirementIds[0] !== requirement.id
    || phase.effect.class !== 'read'
    || requirement.minimumEffect !== 'read'
    || binding?.effect !== 'read'
  ) throw new Error('the read pilot contract does not match the exact read phase and requirement');
  const continuation = contract.continuation ?? { kind: 'none' as const };
  if (continuation.kind === 'cursor') {
    const primaryOperationBudget = input.opportunity.budgets.maxOperationsPerRun
      - input.opportunity.budgets.reserveOperations;
    const reviewedCeilings = [
      phase.effect.maxOperationsPerRun,
      input.opportunity.effectCeiling.maxOperationsPerRun,
      input.opportunity.pilot.effectCeiling.maxOperationsPerRun,
      primaryOperationBudget,
    ];
    if (
      contract.completeness.kind !== 'finite_exhaustive'
      || reviewedCeilings.some((ceiling) => continuation.maxPages > ceiling)
    ) {
      throw new Error('the paginated read plan exceeds its reviewed operation budget or lacks finite exhaustion');
    }
  }
  const dataset = input.opportunity.dataset;
  const projection = contract.resultProjection;
  const workspaceSelection = contract.workspaceBindingSelection;
  if (!dataset && projection) {
    throw new Error('a result projection cannot be added to a dataset-less proposal');
  }
  if (!dataset && workspaceSelection) {
    throw new Error('a Workspace binding cannot be added to a dataset-less proposal');
  }
  if (dataset) {
    if (!projection) throw new Error('workflow_dataset_contract_unrepresented');
    const parsedWorkspaceSelection = parseCanonicalEntityWorkspaceBindingSelection(workspaceSelection);
    if (!parsedWorkspaceSelection.ok) throw new Error(`workspace_binding_contract_unrepresented: ${parsedWorkspaceSelection.errors.join(' ')}`);
    const parsedProjection = parseWorkflowCanonicalEntityResultProjection(projection);
    if (!parsedProjection.ok) throw new Error(`workflow_dataset_contract_unrepresented: ${parsedProjection.errors.join(' ')}`);
    const exactProjection = parsedProjection.contract;
    const expectedFields = [...dataset.schema.fields]
      .map((field) => ({
        field: field.name,
        type: field.type,
        required: field.required,
        sensitivity: field.sensitivity,
      }))
      .sort((left, right) => left.field.localeCompare(right.field));
    const projectedFields = exactProjection.fields
      .map((field) => ({
        field: field.field,
        type: field.type,
        required: field.required,
        sensitivity: field.sensitivity,
      }))
      .sort((left, right) => left.field.localeCompare(right.field));
    const expectedRules = [...dataset.identity.rules]
      .map((rule) => ({
        ruleId: rule.id,
        fields: [...rule.fields].sort(),
        normalizers: [...rule.normalizers].sort(),
      }))
      .sort((left, right) => left.ruleId.localeCompare(right.ruleId));
    const projectedRules = exactProjection.identityRules
      .map((rule) => ({
        ruleId: rule.ruleId,
        fields: [...rule.fields].sort(),
        normalizers: [...rule.normalizers].sort(),
      }))
      .sort((left, right) => left.ruleId.localeCompare(right.ruleId));
    const supportedMerge = dataset.schema.additionalFields === 'reject'
      && dataset.merge.mode === 'review_required'
      && dataset.merge.defaultConflict === 'review_required'
      && dataset.merge.fieldPolicies.every((policy) => policy.onConflict === 'review_required')
      && dataset.merge.preserveSourceRecords === true
      && dataset.provenance.required === true
      && dataset.provenance.retainSourceSnapshots === true;
    if (
      stableJson(expectedFields) !== stableJson(projectedFields)
      || stableJson(expectedRules) !== stableJson(projectedRules)
      || !supportedMerge
      || !contract.evidence.requiredPaths.includes(exactProjection.recordsPath)
      || !contract.completeness.evidencePaths.includes(exactProjection.recordsPath)
      || exactProjection.bounds.maxPages !== (continuation.kind === 'cursor' ? continuation.maxPages : 1)
      || exactProjection.bounds.maxRecords > input.opportunity.pilot.maxRecords
      || exactProjection.bounds.maxRecords > input.opportunity.budgets.maxRecordsPerRun
    ) throw new Error('workflow_dataset_contract_unrepresented: result mapping, merge/provenance semantics, evidence, or reviewed bounds are incomplete');
  }
  return createWorkflowNodeInvocationPlan({
    requirementId: requirement.id,
    logicalCapabilityId: `automation.requirement:${input.proposal.proposalId}:${requirement.id}`,
    binding: {
      capabilityId: binding.capabilityId,
      manifestId: binding.manifestId,
      manifestDigest: binding.manifestDigest,
      operationId: binding.operationId,
      operationVersion: binding.schemaVersion,
      schemaDigest: binding.schemaDigest,
      providerVersion: binding.providerVersion,
      liveFingerprint: binding.liveFingerprint,
      accountId: binding.account,
      effect: 'read',
      invokePortId: binding.invokePortId,
      argumentCompiler: { ...binding.argumentCompiler },
    },
    arguments: contract.arguments,
    evidence: contract.evidence,
    completeness: contract.completeness,
    continuation,
    ...(projection ? { resultProjection: projection } : {}),
  });
}

function buildPreview(input: {
  proposal: AutomationOpportunityProposalRecordV1;
  opportunity: AutomationOpportunityV1;
  target: 'pilot' | 'recurrence';
  bindings: AutomationWorkflowCapabilityBindingV1[];
  liveSnapshotDigest: string;
  readPilotContract?: AutomationSingleReadPilotContractV1;
}): AutomationWorkflowBridgePreviewV1 | AutomationWorkflowBridgeIssueV1 {
  const workflowName = `automation-${input.proposal.digest.slice(0, 16)}`;
  let invocationPlan: ReturnType<typeof createWorkflowNodeInvocationPlan> | undefined;
  try {
    invocationPlan = exactSingleReadPlan({
      proposal: input.proposal,
      opportunity: input.opportunity,
      bindings: input.bindings,
      contract: input.readPilotContract,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The exact read pilot contract is invalid.';
    return {
      code: message.startsWith('workflow_dataset_contract_unrepresented')
        ? 'workflow_dataset_contract_unrepresented'
        : message.startsWith('workspace_binding_contract_unrepresented')
          ? 'workspace_binding_contract_unrepresented'
        : 'workflow_tool_kernel_binding_unrepresented',
      message,
    };
  }
  const workflow: WorkflowDefinition = {
    name: workflowName,
    description: input.opportunity.objective,
    // The workflow store writes description as the SKILL.md body when an
    // explicit body is absent, then reads that body back as description_body.
    // Include the same bytes in the reviewed preview so its authority digest
    // survives the durable store round-trip exactly.
    description_body: input.opportunity.objective,
    enabled: false,
    trigger: workflowTriggerFor(input.opportunity, input.target),
    ...(!invocationPlan ? { allowedTools: [...WORKFLOW_GRAPH_ALLOWED_TOOLS] } : {}),
    ...(invocationPlan ? { inputs: structuredClone(input.readPilotContract!.workflowInputs) } : {}),
    steps: topologicalPhases(input.opportunity).map((phase) => ({
      id: phase.id,
      prompt: invocationPlan ? '' : phase.objective,
      ...(phase.dependsOn.length > 0 ? { dependsOn: [...phase.dependsOn] } : {}),
      // A preview must be safe even if a caller mistakenly hands it to a
      // writer. Exact capability names remain only in capabilityBindings.
      ...(!invocationPlan ? { allowedTools: [...WORKFLOW_GRAPH_ALLOWED_TOOLS] } : {}),
      sideEffect: phase.effect.class === 'read' ? 'read' : 'write',
      ...(!invocationPlan ? { requiresApproval: phase.effect.class === 'external_write' } : {}),
      ...(invocationPlan ? { invocationPlan } : {}),
      ...(phase.effect.class === 'external_write'
        ? { approvalPreview: phase.objective }
        : {}),
    })),
    goal: {
      objective: input.opportunity.objective,
      // A pilot proves only the bounded criteria that the reviewed pilot
      // contract selected. Requiring the whole long-lived automation outcome
      // here can turn an otherwise clean pilot into a false failure and suppress
      // its canonical result projection. The recurrence preview retains the
      // complete objective criteria for the later standing workflow.
      successCriteria: input.opportunity.successCriteria
        .filter((criterion) => (
          input.target === 'recurrence'
          || input.opportunity.pilot.successCriterionIds.includes(criterion.id)
        ))
        .map((criterion) => criterion.description),
      maxAttempts: 1,
    },
  };
  const graph = compileWorkflowStepsToGraph(workflow.steps, {
    id: workflowName,
    name: workflowName,
    version: AUTOMATION_WORKFLOW_BRIDGE_DESIGN_VERSION,
    metadata: {
      executable: false,
      proposalId: input.proposal.proposalId,
      proposalRevision: input.proposal.revision,
      proposalDigest: input.proposal.digest,
    },
  });
  const validation = validateWorkflowGraph(graph);
  if (!validation.ok) {
    return {
      code: 'workflow_graph_invalid',
      message: `Existing workflow graph rejected the approved topology: ${validation.errors.join('; ')}.`,
    };
  }

  const bindings = [...input.bindings].sort((left, right) => (
    left.requirementId.localeCompare(right.requirementId)
  ));
  let canonicalEntityWorkspaceBinding: CanonicalEntityWorkspaceBindingApprovalV1 | undefined;
  if (input.readPilotContract?.workspaceBindingSelection) {
    try {
      canonicalEntityWorkspaceBinding = createCanonicalEntityWorkspaceBindingApproval({
        selection: input.readPilotContract.workspaceBindingSelection,
        workflowId: workflow.name,
        at: input.proposal.decidedAt ?? input.proposal.updatedAt,
      });
    } catch (error) {
      return {
        code: 'workspace_binding_contract_unrepresented',
        message: error instanceof Error ? error.message : 'The exact Workspace binding is invalid.',
      };
    }
  }
  const bindingSnapshotDigest = sha256(stableJson(canonicalEntityWorkspaceBinding
    ? { capabilityBindings: bindings, canonicalEntityWorkspaceBinding }
    : bindings));
  const controlContractDigest = sha256(stableJson({
    target: input.target,
    effectCeiling: input.opportunity.effectCeiling,
    pilot: input.opportunity.pilot,
    budgets: input.opportunity.budgets,
    partition: input.opportunity.partition,
    dataset: input.opportunity.dataset ?? null,
    recurrence: input.target === 'recurrence' ? input.opportunity.recurrence : { mode: 'none' },
    phaseEffects: input.opportunity.phases.map((phase) => ({
      phaseId: phase.id,
      effect: phase.effect,
      partitioned: phase.partitioned,
    })),
    ...(input.readPilotContract?.resultProjection
      ? { resultProjection: input.readPilotContract.resultProjection }
      : {}),
    ...(canonicalEntityWorkspaceBinding
      ? { canonicalEntityWorkspaceBinding }
      : {}),
  }));
  const withoutDigest = {
    version: AUTOMATION_WORKFLOW_BRIDGE_DESIGN_VERSION,
    executable: false as const,
    proposal: {
      proposalId: input.proposal.proposalId,
      revision: input.proposal.revision,
      digest: input.proposal.digest,
    },
    activation: input.target,
    workflow,
    graph,
    capabilityBindings: bindings,
    liveSnapshotDigest: input.liveSnapshotDigest,
    bindingSnapshotDigest,
    controlContractDigest,
    ...(canonicalEntityWorkspaceBinding ? { canonicalEntityWorkspaceBinding } : {}),
  };
  return {
    ...withoutDigest,
    compilationDigest: sha256(stableJson(withoutDigest)),
  };
}

function representationIssues(
  opportunity: AutomationOpportunityV1,
  preview: AutomationWorkflowBridgePreviewV1,
): AutomationWorkflowBridgeIssueV1[] {
  const exactReadPlan = preview.workflow.steps.length === 1
    ? preview.workflow.steps[0].invocationPlan
    : undefined;
  const issues: AutomationWorkflowBridgeIssueV1[] = [];
  if (!exactReadPlan) {
    issues.push({
      code: 'workflow_tool_kernel_binding_unrepresented',
      message: 'This preview has no exact typed invocation plan for the shared workflow call kernel.',
    });
  }
  if (opportunity.partition.mode !== 'single' || opportunity.phases.some((phase) => phase.partitioned)) {
    issues.push({
      code: 'workflow_partition_contract_unrepresented',
      message: 'The approved partition denominator/checkpoint contract has no exact WorkflowDefinition field.',
    });
  }
  if (opportunity.dataset) {
    if (!exactReadPlan?.resultProjection) {
      issues.push({
        code: 'workflow_dataset_contract_unrepresented',
        message: 'The approved canonical identity, merge, provenance, extraction, resolution, coverage, and bound contract has no exact WorkflowDefinition field.',
      });
    }
    if (!preview.canonicalEntityWorkspaceBinding) {
      issues.push({
        code: 'workspace_binding_contract_unrepresented',
        message: 'The approved dataset has no exact human-reviewed workflow-to-Workspace binding.',
      });
    }
  }
  if (opportunity.phases.some((phase) => phase.effect.class !== 'read')) {
    issues.push({
      code: 'workflow_effect_authority_unrepresented',
      message: 'WorkflowDefinition collapses local/external effects and cannot persist exact prior approval plus readback authority.',
    });
  }
  if (preview.activation === 'recurrence') {
    issues.push({
      code: 'schedule_contract_unrepresented',
      message: 'Recurrence admission remains disabled until the exact pilot receipt and schedule contract have a durable activation projection.',
    });
  }
  return issues;
}

function pilotLineageForPreview(
  preview: AutomationWorkflowBridgePreviewV1,
): WorkflowReadPilotLineageV1 | null {
  const step = preview.workflow.steps.length === 1 ? preview.workflow.steps[0] : undefined;
  if (!step?.invocationPlan || preview.activation !== 'pilot') return null;
  const occurrenceInput = {
    proposalId: preview.proposal.proposalId,
    proposalRevision: preview.proposal.revision,
    proposalDigest: preview.proposal.digest,
    compilationDigest: preview.compilationDigest,
  };
  return {
    version: 1,
    proposalId: preview.proposal.proposalId,
    proposalRevision: preview.proposal.revision,
    proposalDigest: preview.proposal.digest,
    compilationDigest: preview.compilationDigest,
    bindingSnapshotDigest: preview.bindingSnapshotDigest,
    controlDigest: preview.controlContractDigest,
    workflowId: preview.workflow.name,
    workflowRevision: preview.proposal.revision,
    workflowDigest: workflowDefinitionHash(preview.workflow),
    runOccurrenceId: workflowReadPilotOccurrenceId(occurrenceInput),
    nodeId: step.id,
    nodeAttempt: 1,
    invocationPlanDigest: step.invocationPlan.bindingDigest,
    workflowSessionId: workflowReadPilotSessionId(occurrenceInput),
    ...(step.invocationPlan.resultProjection
      ? { resultProjection: structuredClone(step.invocationPlan.resultProjection) }
      : {}),
    ...(preview.canonicalEntityWorkspaceBinding
      ? { workspaceBinding: structuredClone(preview.canonicalEntityWorkspaceBinding) }
      : {}),
  };
}

function exactPreviewLineage(
  value: {
    compilationDigest: string;
    bindingSnapshotDigest: string;
    controlContractDigest: string;
  },
  preview: AutomationWorkflowBridgePreviewV1,
): boolean {
  return value.compilationDigest === preview.compilationDigest
    && value.bindingSnapshotDigest === preview.bindingSnapshotDigest
    && value.controlContractDigest === preview.controlContractDigest;
}

function activationPreviewIssues(
  activation: AutomationWorkflowActivationV1,
  preview: AutomationWorkflowBridgePreviewV1,
): AutomationWorkflowBridgeIssueV1[] {
  if (activation.kind === 'preview') return [];
  if (activation.kind === 'pilot') {
    return exactPreviewLineage(activation.pilot, preview)
      ? []
      : [{
          code: 'pilot_authority_mismatch',
          message: 'Pilot authority names a different disabled compilation, binding snapshot, or control contract.',
        }];
  }
  return exactPreviewLineage(activation.recurrenceConsent, preview)
    ? []
    : [{
        code: 'recurrence_consent_mismatch',
        message: 'Recurrence consent names a different disabled compilation, binding snapshot, or control contract.',
      }];
}

/**
 * Resolve and design the bridge. This pure function has no I/O and always
 * returns an inert disabled preview. A pilotAdmission, when present, is only
 * the exact one-shot lineage consumed by the separate durable queue/runner
 * adapter; it does not enable the workflow or authorize recurrence.
 */
export function designApprovedAutomationWorkflowBridge(
  input: AutomationWorkflowBridgeInputV1,
): AutomationWorkflowBridgeResultV1 {
  try {
    // This is an authority compiler, not a permissive JSON normalizer. Reject
    // hidden/getter/prototype/unsupported/oversized bytes before reading any
    // proposal, live binding, selection, or typed argument contract field.
    stableJson(input);
  } catch (error) {
    return {
      ok: false,
      issues: [{
        code: 'proposal_integrity_failure',
        message: error instanceof Error
          ? `Automation bridge input is outside the bounded plain-JSON contract: ${error.message}`
          : 'Automation bridge input is outside the bounded plain-JSON contract.',
      }],
    };
  }
  const approved = proposalIssues(input);
  const liveIssues = snapshotIssues(input.liveSnapshot);
  if (!approved.opportunity || approved.issues.length > 0 || liveIssues.length > 0) {
    return { ok: false, issues: [...approved.issues, ...liveIssues] };
  }

  const resolved = resolveBindings({
    opportunity: approved.opportunity,
    snapshot: input.liveSnapshot,
    selections: input.selections ?? [],
  });
  if (resolved.issues.length > 0) return { ok: false, issues: resolved.issues };

  const preview = buildPreview({
    proposal: input.proposal,
    opportunity: approved.opportunity,
    target: activationTarget(input.activation),
    bindings: resolved.bindings,
    liveSnapshotDigest: input.liveSnapshot.digest,
    readPilotContract: input.readPilotContract,
  });
  if ('code' in preview) return { ok: false, issues: [preview] };

  const consentIssues = activationPreviewIssues(input.activation, preview);
  const represented = representationIssues(approved.opportunity, preview);
  const lineage = pilotLineageForPreview(preview);
  let pilotApprovalRequest: WorkflowReadPilotApprovalRequestV1 | undefined;
  let pilotAdmission: WorkflowReadPilotAdmissionDraftV1 | undefined;
  if (lineage) {
    pilotApprovalRequest = workflowReadPilotApprovalRequest(lineage);
    if (input.activation.kind === 'pilot' && consentIssues.length === 0 && represented.length === 0) {
      try {
        pilotAdmission = createWorkflowReadPilotAdmissionDraft({
          lineage,
          oneShotActivationAuthorization: {
            approvalId: input.activation.pilot.authorizationRef,
            resumeKey: input.activation.pilot.authorizationResumeKey,
            decisionDigest: input.activation.pilot.authorizationDigest,
          },
        });
      } catch (error) {
        consentIssues.push({
          code: 'pilot_authority_mismatch',
          message: error instanceof Error
            ? error.message
            : 'Pilot authorization does not bind the exact disabled preview.',
        });
      }
    }
  }
  const issues = [...consentIssues, ...represented];

  return {
    ok: issues.length === 0,
    preview,
    issues,
    ...(pilotApprovalRequest ? { pilotApprovalRequest } : {}),
    ...(pilotAdmission ? { pilotAdmission } : {}),
  };
}
