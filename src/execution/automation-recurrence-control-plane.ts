import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { WorkflowDefinition } from '../memory/workflow-store.js';
import { parseWorkflowNodeInvocationPlan } from '../memory/workflow-node-invocation-plan.js';
import {
  parseWorkflowCanonicalEntityResultProjection,
  type WorkflowCanonicalEntityResultProjection,
} from '../memory/workflow-result-projection-contract.js';
import {
  approvalResolutionWithinLifetime,
  type PendingApprovalRow,
} from '../runtime/harness/approval-registry.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import {
  parseWorkflowInterval,
  workflowIntervalDigest,
  workflowIntervalOccurrenceAtMs,
  type WorkflowIntervalCatchUpPolicy,
  type WorkflowIntervalOverlapPolicy,
  type WorkflowIntervalUnit,
  type WorkflowIntervalV1,
} from '../shared/workflow-interval.js';
import {
  parseCanonicalEntityWorkspaceBindingApproval,
  type CanonicalEntityWorkspaceBindingApprovalV1,
} from '../spaces/canonical-entity-workspace-binding-contract.js';
import { workflowDefinitionHash } from './workflow-run-definition.js';

export const AUTOMATION_RECURRENCE_CONTROL_PLANE_VERSION = 1 as const;
export const AUTOMATION_RECURRENCE_CONSENT_TOOL = 'automation_recurrence_activate' as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const EXACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;
const MAX_CONTRACT_BYTES = 768_000;

export interface AutomationRecurrenceAuthoritySnapshotV1 {
  version: 1;
  capabilitySnapshotDigest: string;
  accountSnapshotDigest: string;
  schemaSnapshotDigest: string;
  bindingSnapshotDigest: string;
  controlContractDigest: string;
  workspaceBindingDigest?: string;
}

export interface AutomationRecurrencePilotSuccessObservationV1 {
  version: 1;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  workflowId: string;
  workflowRevision: number;
  workflowDigest: string;
  nodeId: string;
  invocationPlanDigest: string;
  workflowInputs: Record<string, string>;
  workflowInputsDigest: string;
  pilotCompilationDigest: string;
  pilotAuthorizationRef: string;
  pilotAuthorizationDigest: string;
  runId: string;
  runOccurrenceId: string;
  triggerReceiptId: string;
  triggerReceiptDigest: string;
  terminalReceiptId: string;
  terminalReceiptDigest: string;
  status: 'completed';
  terminalOutcome: 'succeeded';
  needsAttention: false;
  finishedAt: string;
  resultAuthority: {
    version: 1;
    kind: 'closed_read';
    receiptId: string;
    receiptDigest: string;
    acceptedSourceCount: number;
  };
  projectionAuthority?: {
    version: 1;
    receiptId: string;
    receiptDigest: string;
    coverage: 'closed';
  };
  settlement: {
    version: 1;
    clean: true;
    receiptId: string;
    receiptDigest: string;
    reasons: [];
  };
  selectedSuccessCriterionIds: string[];
  criterionEvidence: Array<{
    criterionId: string;
    outcome: 'met';
    evidenceRef: string;
    evidenceDigest: string;
  }>;
  authoritySnapshot: AutomationRecurrenceAuthoritySnapshotV1;
  workspaceBinding?: CanonicalEntityWorkspaceBindingApprovalV1;
}

export interface AutomationRecurrencePilotSuccessEvidenceV1
  extends AutomationRecurrencePilotSuccessObservationV1 {
  state: 'succeeded';
  evidenceId: string;
  evidenceDigest: string;
}

export interface AutomationRecurrenceCadenceV1 {
  every: number;
  unit: WorkflowIntervalUnit;
  overlapPolicy: WorkflowIntervalOverlapPolicy;
  catchUpPolicy: WorkflowIntervalCatchUpPolicy;
}

export interface AutomationRecurrencePreviewV1 {
  version: 1;
  previewId: string;
  previewDigest: string;
  pilotSuccessEvidenceId: string;
  pilotSuccessEvidenceDigest: string;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  workflowId: string;
  workflowRevision: number;
  sourceDefinition: WorkflowDefinition;
  sourceDefinitionHash: string;
  reviewedDisabledDefinition: WorkflowDefinition;
  reviewedDisabledDefinitionHash: string;
  authorizedEnabledDefinition: WorkflowDefinition;
  authorizedEnabledDefinitionHash: string;
  interval: WorkflowIntervalV1;
  intervalDigest: string;
  firstFireAt: string;
  nodeId: string;
  invocationPlanDigest: string;
  workflowInputs: Record<string, string>;
  workflowInputsDigest: string;
  authoritySnapshot: AutomationRecurrenceAuthoritySnapshotV1;
  resultProjection?: WorkflowCanonicalEntityResultProjection;
  workspaceBinding?: CanonicalEntityWorkspaceBindingApprovalV1;
  previewedAt: string;
}

export interface AutomationRecurrenceConsentArgsV1 {
  version: 1;
  action: 'activate_interval_read_recurrence';
  previewId: string;
  previewDigest: string;
  pilotSuccessEvidenceId: string;
  pilotSuccessEvidenceDigest: string;
  workflowId: string;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  sourceDefinitionHash: string;
  reviewedDisabledDefinitionHash: string;
  authorizedEnabledDefinitionHash: string;
  interval: WorkflowIntervalV1;
  intervalDigest: string;
  firstFireAt: string;
  effect: 'read';
  externalWrites: false;
  sends: false;
  nodeId: string;
  invocationPlanDigest: string;
  workflowInputs: Record<string, string>;
  workflowInputsDigest: string;
  authoritySnapshot: AutomationRecurrenceAuthoritySnapshotV1;
  resultProjection?: WorkflowCanonicalEntityResultProjection;
  workspaceBinding?: CanonicalEntityWorkspaceBindingApprovalV1;
}

export interface AutomationRecurrenceConsentRequestV1 {
  version: 1;
  requestId: string;
  requestDigest: string;
  approvalSessionId: string;
  subject: string;
  tool: typeof AUTOMATION_RECURRENCE_CONSENT_TOOL;
  args: AutomationRecurrenceConsentArgsV1;
  resumeKey: string;
}

export type AutomationRecurrenceActivationStatus =
  | 'registering'
  | 'approval_pending'
  | 'activating'
  | 'active'
  | 'refused';

export interface AutomationRecurrenceActivationStateV1 {
  version: 1;
  activationId: string;
  status: AutomationRecurrenceActivationStatus;
  contractDigest: string;
  previewId: string;
  previewDigest: string;
  pilotSuccessEvidenceId: string;
  pilotSuccessEvidenceDigest: string;
  workflowId: string;
  approvalSessionId: string;
  approvalResumeKey: string;
  approvalId?: string;
  activationReceiptId?: string;
  activationReceiptDigest?: string;
  authorizedEnabledDefinitionHash: string;
  installedDefinitionHash?: string;
  activatedAt?: string;
  refusalCode?: string;
  refusalDetail?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  stateDigest: string;
}

export interface AutomationRecurrenceActivationReceiptV1 {
  version: 1;
  receiptId: string;
  receiptDigest: string;
  authorization: 'standing_interval_read';
  activationId: string;
  previewId: string;
  previewDigest: string;
  pilotSuccessEvidenceId: string;
  pilotSuccessEvidenceDigest: string;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  workflowId: string;
  workflowRevision: number;
  sourceDefinitionHash: string;
  reviewedDisabledDefinitionHash: string;
  authorizedEnabledDefinitionHash: string;
  interval: WorkflowIntervalV1;
  intervalDigest: string;
  firstFireAt: string;
  nodeId: string;
  invocationPlanDigest: string;
  workflowInputs: Record<string, string>;
  workflowInputsDigest: string;
  authoritySnapshot: AutomationRecurrenceAuthoritySnapshotV1;
  resultProjection?: WorkflowCanonicalEntityResultProjection;
  workspaceBinding?: CanonicalEntityWorkspaceBindingApprovalV1;
  consent: {
    version: 1;
    approvalId: string;
    approvalSessionId: string;
    resumeKey: string;
    requestDigest: string;
    requestedAt: string;
    expiresAt: string;
    resolver: string;
    resolvedAt: string;
    decisionDigest: string;
  };
  authorizedAt: string;
}

export interface AutomationRecurrenceActiveAuthorityV1 {
  version: 1;
  activationId: string;
  activationStateDigest: string;
  activationReceiptId: string;
  activationReceiptDigest: string;
  workflowId: string;
  authorizedEnabledDefinitionHash: string;
}

export type RegisterAutomationRecurrenceResultV1 =
  | { ok: true; inserted: boolean; state: AutomationRecurrenceActivationStateV1 }
  | { ok: false; code: string; reason: string };

export type BindAutomationRecurrenceConsentResultV1 =
  | { ok: true; replayed: boolean; state: AutomationRecurrenceActivationStateV1 }
  | { ok: false; code: string; reason: string; state?: AutomationRecurrenceActivationStateV1 };

export type ReconcileAutomationRecurrenceResultV1 =
  | { ok: true; state: 'pending'; activation: AutomationRecurrenceActivationStateV1 }
  | {
      ok: true;
      state: 'ready_to_install';
      activation: AutomationRecurrenceActivationStateV1;
      receipt: AutomationRecurrenceActivationReceiptV1;
      installation: {
        expectedDefinitionHashes: string[];
        authorizedDefinition: WorkflowDefinition;
        authorizedDefinitionHash: string;
      };
    }
  | {
      ok: true;
      state: 'active';
      activation: AutomationRecurrenceActivationStateV1;
      receipt: AutomationRecurrenceActivationReceiptV1;
      authority: AutomationRecurrenceActiveAuthorityV1;
    }
  | { ok: true; state: 'refused'; activation: AutomationRecurrenceActivationStateV1 }
  | { ok: false; code: string; reason: string; activation?: AutomationRecurrenceActivationStateV1 };

export interface AutomationRecurrenceContractV1 {
  version: 1;
  pilotSuccess: AutomationRecurrencePilotSuccessEvidenceV1;
  preview: AutomationRecurrencePreviewV1;
  consentRequest: AutomationRecurrenceConsentRequestV1;
}

interface ActivationRow {
  activation_id: string;
  workflow_id: string;
  status: AutomationRecurrenceActivationStatus;
  contract_json: string;
  contract_digest: string;
  approval_id: string | null;
  activation_receipt_id: string | null;
  activation_receipt_digest: string | null;
  installed_definition_hash: string | null;
  activated_at: string | null;
  refusal_code: string | null;
  refusal_detail: string | null;
  revision: number;
  state_digest: string;
  created_at: string;
  updated_at: string;
}

interface ReceiptRow {
  receipt_id: string;
  activation_id: string;
  receipt_json: string;
  receipt_digest: string;
  created_at: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS automation_recurrence_control_plane_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_recurrence_activations (
  activation_id                    TEXT PRIMARY KEY,
  workflow_id                      TEXT NOT NULL,
  status                           TEXT NOT NULL CHECK (status IN (
    'registering','approval_pending','activating','active','refused'
  )),
  contract_json                    TEXT NOT NULL,
  contract_digest                  TEXT NOT NULL,
  approval_id                      TEXT UNIQUE,
  activation_receipt_id            TEXT UNIQUE,
  activation_receipt_digest        TEXT,
  installed_definition_hash        TEXT,
  activated_at                     TEXT,
  refusal_code                     TEXT,
  refusal_detail                   TEXT,
  revision                         INTEGER NOT NULL CHECK (revision >= 1),
  state_digest                     TEXT NOT NULL,
  created_at                       TEXT NOT NULL,
  updated_at                       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_recurrence_activation_receipts (
  receipt_id      TEXT PRIMARY KEY,
  activation_id   TEXT NOT NULL UNIQUE,
  receipt_json    TEXT NOT NULL,
  receipt_digest  TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS automation_recurrence_reconcile
  ON automation_recurrence_activations(status, updated_at, activation_id);

CREATE UNIQUE INDEX IF NOT EXISTS automation_recurrence_one_live_authority
  ON automation_recurrence_activations(workflow_id)
  WHERE status IN ('registering','approval_pending','activating','active');
`;

function canonicalJson(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 40,
    maxNodes: 40_000,
    maxStringBytes: 96_000,
    maxTotalBytes: MAX_CONTRACT_BYTES,
  });
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactId(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && EXACT_ID_RE.test(value);
}

function exactDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function exactIso(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
}

function exactPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function canonicalMinuteAtOrAfter(value: string): string {
  if (!exactIso(value)) throw new Error('recurrence preview time must be a canonical ISO timestamp');
  const at = Date.parse(value);
  return new Date(Math.ceil(at / 60_000) * 60_000).toISOString();
}

function authoritySnapshotValid(value: AutomationRecurrenceAuthoritySnapshotV1): boolean {
  return value?.version === 1
    && exactDigest(value.capabilitySnapshotDigest)
    && exactDigest(value.accountSnapshotDigest)
    && exactDigest(value.schemaSnapshotDigest)
    && exactDigest(value.bindingSnapshotDigest)
    && exactDigest(value.controlContractDigest)
    && (value.workspaceBindingDigest === undefined || exactDigest(value.workspaceBindingDigest));
}

function workflowInputsValid(value: unknown, digest: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactDigest(digest)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([key, item]) => !exactId(key) || typeof item !== 'string')) return false;
  try { return sha256(canonicalJson(value)) === digest; } catch { return false; }
}

function evidenceBody(
  value: AutomationRecurrencePilotSuccessEvidenceV1,
): AutomationRecurrencePilotSuccessObservationV1 & { state: 'succeeded' } {
  const { evidenceId: _id, evidenceDigest: _digest, ...body } = value;
  return body;
}

function evidenceObservationValid(value: AutomationRecurrencePilotSuccessObservationV1): string | null {
  try { canonicalJson(value); } catch (error) {
    return error instanceof Error ? error.message : 'pilot success observation is not bounded JSON';
  }
  if (
    value.version !== 1
    || !exactId(value.proposalId)
    || !exactPositiveInteger(value.proposalRevision)
    || !exactDigest(value.proposalDigest)
    || !exactId(value.workflowId)
    || !exactPositiveInteger(value.workflowRevision)
    || !exactDigest(value.workflowDigest)
    || !exactId(value.nodeId)
    || !exactDigest(value.invocationPlanDigest)
    || !workflowInputsValid(value.workflowInputs, value.workflowInputsDigest)
    || !exactDigest(value.pilotCompilationDigest)
    || !exactId(value.pilotAuthorizationRef)
    || !exactDigest(value.pilotAuthorizationDigest)
    || !exactId(value.runId)
    || !exactId(value.runOccurrenceId)
    || !exactId(value.triggerReceiptId)
    || !exactDigest(value.triggerReceiptDigest)
    || !exactId(value.terminalReceiptId)
    || !exactDigest(value.terminalReceiptDigest)
    || value.status !== 'completed'
    || value.terminalOutcome !== 'succeeded'
    || value.needsAttention !== false
    || !exactIso(value.finishedAt)
    || !authoritySnapshotValid(value.authoritySnapshot)
  ) return 'pilot success identity or terminal truth is invalid';
  if (
    value.resultAuthority?.version !== 1
    || value.resultAuthority.kind !== 'closed_read'
    || !exactId(value.resultAuthority.receiptId)
    || !exactDigest(value.resultAuthority.receiptDigest)
    || !exactPositiveInteger(value.resultAuthority.acceptedSourceCount)
  ) return 'pilot success requires a non-vacuous closed read authority';
  if (
    value.settlement?.version !== 1
    || value.settlement.clean !== true
    || !exactId(value.settlement.receiptId)
    || !exactDigest(value.settlement.receiptDigest)
    || !Array.isArray(value.settlement.reasons)
    || value.settlement.reasons.length !== 0
  ) return 'pilot settlement is not exactly clean';
  if (value.projectionAuthority !== undefined && (
    value.projectionAuthority.version !== 1
    || !exactId(value.projectionAuthority.receiptId)
    || !exactDigest(value.projectionAuthority.receiptDigest)
    || value.projectionAuthority.coverage !== 'closed'
  )) return 'pilot projection authority is not closed';
  const selected = value.selectedSuccessCriterionIds;
  if (
    !Array.isArray(selected)
    || selected.length < 1
    || selected.some((id) => !exactId(id))
    || new Set(selected).size !== selected.length
    || [...selected].sort().join('\0') !== selected.join('\0')
  ) return 'pilot success criteria must be a non-empty canonical unique set';
  const evidence = value.criterionEvidence;
  if (!Array.isArray(evidence) || evidence.length !== selected.length) {
    return 'pilot success evidence must cover every selected criterion exactly once';
  }
  const byCriterion = new Map<string, (typeof evidence)[number]>();
  for (const item of evidence) {
    if (
      !exactId(item?.criterionId)
      || item.outcome !== 'met'
      || !exactId(item.evidenceRef)
      || !exactDigest(item.evidenceDigest)
      || byCriterion.has(item.criterionId)
    ) return 'pilot criterion evidence is invalid, duplicated, or not met';
    byCriterion.set(item.criterionId, item);
  }
  if (selected.some((id) => !byCriterion.has(id))) {
    return 'pilot criterion evidence does not match the selected pilot criteria';
  }
  if (value.workspaceBinding !== undefined) {
    const parsed = parseCanonicalEntityWorkspaceBindingApproval(value.workspaceBinding);
    if (!parsed.ok || parsed.approval.binding.workflowId !== value.workflowId) {
      return 'pilot Workspace binding is invalid or belongs to another workflow';
    }
    if (value.authoritySnapshot.workspaceBindingDigest !== parsed.approval.bindingDigest) {
      return 'pilot Workspace binding does not match the authority snapshot';
    }
    if (!value.projectionAuthority) return 'a Workspace-bound pilot requires closed projection authority';
  } else if (value.authoritySnapshot.workspaceBindingDigest !== undefined) {
    return 'authority snapshot names a Workspace binding that is absent';
  }
  return null;
}

export function createAutomationRecurrencePilotSuccessEvidence(
  observation: AutomationRecurrencePilotSuccessObservationV1,
): AutomationRecurrencePilotSuccessEvidenceV1 {
  const canonical = clone(observation);
  const issue = evidenceObservationValid(canonical);
  if (issue) throw new Error(issue);
  const body = { ...canonical, state: 'succeeded' as const };
  const evidenceDigest = sha256(canonicalJson({
    domain: 'automation-recurrence-pilot-success',
    version: 1,
    evidence: body,
  }));
  return {
    ...body,
    evidenceId: `automation-pilot-success:v1:${evidenceDigest}`,
    evidenceDigest,
  };
}

export function parseAutomationRecurrencePilotSuccessEvidence(
  value: unknown,
): { ok: true; evidence: AutomationRecurrencePilotSuccessEvidenceV1 } | { ok: false; reason: string } {
  let candidate: AutomationRecurrencePilotSuccessEvidenceV1;
  try { candidate = clone(value) as AutomationRecurrencePilotSuccessEvidenceV1; }
  catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
  if (candidate.state !== 'succeeded' || !exactId(candidate.evidenceId) || !exactDigest(candidate.evidenceDigest)) {
    return { ok: false, reason: 'pilot success evidence identity is invalid' };
  }
  const issue = evidenceObservationValid(candidate);
  if (issue) return { ok: false, reason: issue };
  const digest = sha256(canonicalJson({
    domain: 'automation-recurrence-pilot-success',
    version: 1,
    evidence: evidenceBody(candidate),
  }));
  if (
    candidate.evidenceDigest !== digest
    || candidate.evidenceId !== `automation-pilot-success:v1:${digest}`
  ) return { ok: false, reason: 'pilot success evidence bytes do not match their digest' };
  return { ok: true, evidence: candidate };
}

/** Compatibility projection for the existing pure workflow bridge. */
export function automationPilotSuccessEvidenceForBridge(
  value: AutomationRecurrencePilotSuccessEvidenceV1,
): {
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
} {
  const parsed = parseAutomationRecurrencePilotSuccessEvidence(value);
  if (!parsed.ok) throw new Error(parsed.reason);
  const evidence = parsed.evidence;
  return {
    state: 'succeeded',
    proposalRevision: evidence.proposalRevision,
    proposalDigest: evidence.proposalDigest,
    pilotCompilationDigest: evidence.pilotCompilationDigest,
    pilotBindingSnapshotDigest: evidence.authoritySnapshot.bindingSnapshotDigest,
    pilotControlContractDigest: evidence.authoritySnapshot.controlContractDigest,
    pilotAuthorizationRef: evidence.pilotAuthorizationRef,
    runOccurrenceId: evidence.runOccurrenceId,
    evidenceRef: evidence.evidenceId,
    evidenceDigest: evidence.evidenceDigest,
    terminalReceiptDigest: evidence.terminalReceiptDigest,
  };
}

function readPlanIssue(definition: WorkflowDefinition, evidence: AutomationRecurrencePilotSuccessEvidenceV1): string | null {
  if (
    definition.name !== evidence.workflowId
    || definition.enabled !== false
    || canonicalJson(definition.trigger) !== '{"manual":true}'
    || (definition.allowedTools?.length ?? 0) !== 0
    || definition.synthesis !== undefined
    || definition.steps.length !== 1
  ) return 'recurrence source must be the exact disabled manual one-read pilot';
  const step = definition.steps[0]!;
  if (
    step.id !== evidence.nodeId
    || step.sideEffect !== 'read'
    || step.call !== undefined
    || step.deterministic !== undefined
    || step.subgraph !== undefined
    || step.forEach !== undefined
    || step.loopUntil !== undefined
    || step.requiresApproval === true
    || (step.allowedTools?.length ?? 0) !== 0
    || !step.invocationPlan
  ) return 'recurrence source node is not an exact plan-only read';
  const parsed = parseWorkflowNodeInvocationPlan(step.invocationPlan);
  if (
    !parsed.ok
    || parsed.plan.bindingDigest !== evidence.invocationPlanDigest
    || parsed.plan.binding.effect !== 'read'
    || (parsed.plan.continuation.kind === 'cursor' && parsed.plan.completeness.kind !== 'finite_exhaustive')
  ) return 'recurrence invocation plan is invalid, drifted, or not a bounded read';
  if (parsed.plan.resultProjection) {
    const projection = parseWorkflowCanonicalEntityResultProjection(parsed.plan.resultProjection);
    if (!projection.ok || !evidence.workspaceBinding || !evidence.projectionAuthority) {
      return 'dataset recurrence lacks exact closed projection and Workspace authority';
    }
  } else if (evidence.workspaceBinding || evidence.projectionAuthority) {
    return 'dataset authority is present but the reviewed invocation plan has no result projection';
  }
  return null;
}

function previewBody(value: AutomationRecurrencePreviewV1): Omit<AutomationRecurrencePreviewV1, 'previewId' | 'previewDigest'> {
  const { previewId: _id, previewDigest: _digest, ...body } = value;
  return body;
}

function previewDigest(body: Omit<AutomationRecurrencePreviewV1, 'previewId' | 'previewDigest'>): string {
  return sha256(canonicalJson({ domain: 'automation-recurrence-preview', version: 1, preview: body }));
}

export function createAutomationRecurrencePreview(input: {
  pilotSuccess: AutomationRecurrencePilotSuccessEvidenceV1;
  workflowSlug: string;
  sourceDefinition: WorkflowDefinition;
  cadence: AutomationRecurrenceCadenceV1;
  previewedAt: string;
}): AutomationRecurrencePreviewV1 {
  const parsedEvidence = parseAutomationRecurrencePilotSuccessEvidence(input.pilotSuccess);
  if (!parsedEvidence.ok) throw new Error(parsedEvidence.reason);
  const pilotSuccess = parsedEvidence.evidence;
  if (!exactId(input.workflowSlug) || input.workflowSlug !== pilotSuccess.workflowId) {
    throw new Error('recurrence workflow identity does not match the successful pilot');
  }
  const sourceDefinition = clone(input.sourceDefinition);
  const sourceDefinitionHash = workflowDefinitionHash(sourceDefinition);
  if (sourceDefinitionHash !== pilotSuccess.workflowDigest) {
    throw new Error('recurrence source definition drifted from the successful pilot');
  }
  const planIssue = readPlanIssue(sourceDefinition, pilotSuccess);
  if (planIssue) throw new Error(planIssue);
  const anchorAt = canonicalMinuteAtOrAfter(input.previewedAt);
  const parsedInterval = parseWorkflowInterval({
    version: 1,
    every: input.cadence.every,
    unit: input.cadence.unit,
    anchorAt,
    overlapPolicy: input.cadence.overlapPolicy,
    catchUpPolicy: input.cadence.catchUpPolicy,
  });
  if (!parsedInterval.ok) throw new Error(parsedInterval.errors.join(' '));
  const interval = parsedInterval.value;
  const reviewedDisabledDefinition: WorkflowDefinition = clone({
    ...sourceDefinition,
    enabled: false,
    trigger: { interval },
  });
  const authorizedEnabledDefinition: WorkflowDefinition = clone({
    ...reviewedDisabledDefinition,
    enabled: true,
  });
  const plan = parseWorkflowNodeInvocationPlan(sourceDefinition.steps[0]!.invocationPlan);
  if (!plan.ok) throw new Error(plan.errors.join(' '));
  const resultProjection = plan.plan.resultProjection
    ? parseWorkflowCanonicalEntityResultProjection(plan.plan.resultProjection)
    : undefined;
  if (resultProjection && !resultProjection.ok) throw new Error(resultProjection.errors.join(' '));
  const body: Omit<AutomationRecurrencePreviewV1, 'previewId' | 'previewDigest'> = {
    version: 1,
    pilotSuccessEvidenceId: pilotSuccess.evidenceId,
    pilotSuccessEvidenceDigest: pilotSuccess.evidenceDigest,
    proposalId: pilotSuccess.proposalId,
    proposalRevision: pilotSuccess.proposalRevision,
    proposalDigest: pilotSuccess.proposalDigest,
    workflowId: pilotSuccess.workflowId,
    workflowRevision: pilotSuccess.workflowRevision,
    sourceDefinition,
    sourceDefinitionHash,
    reviewedDisabledDefinition,
    reviewedDisabledDefinitionHash: workflowDefinitionHash(reviewedDisabledDefinition),
    authorizedEnabledDefinition,
    authorizedEnabledDefinitionHash: workflowDefinitionHash(authorizedEnabledDefinition),
    interval,
    intervalDigest: workflowIntervalDigest(interval),
    firstFireAt: new Date(workflowIntervalOccurrenceAtMs(interval, 1)).toISOString(),
    nodeId: pilotSuccess.nodeId,
    invocationPlanDigest: pilotSuccess.invocationPlanDigest,
    workflowInputs: clone(pilotSuccess.workflowInputs),
    workflowInputsDigest: pilotSuccess.workflowInputsDigest,
    authoritySnapshot: clone(pilotSuccess.authoritySnapshot),
    ...(resultProjection?.ok ? { resultProjection: clone(resultProjection.contract) } : {}),
    ...(pilotSuccess.workspaceBinding ? { workspaceBinding: clone(pilotSuccess.workspaceBinding) } : {}),
    previewedAt: input.previewedAt,
  };
  const digest = previewDigest(body);
  return { ...body, previewId: `automation-recurrence-preview:v1:${digest}`, previewDigest: digest };
}

export function parseAutomationRecurrencePreview(
  value: unknown,
): { ok: true; preview: AutomationRecurrencePreviewV1 } | { ok: false; reason: string } {
  let preview: AutomationRecurrencePreviewV1;
  try { preview = clone(value) as AutomationRecurrencePreviewV1; }
  catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
  if (
    preview.version !== 1
    || !exactId(preview.previewId)
    || !exactDigest(preview.previewDigest)
    || !exactId(preview.pilotSuccessEvidenceId)
    || !exactDigest(preview.pilotSuccessEvidenceDigest)
    || !exactId(preview.proposalId)
    || !exactPositiveInteger(preview.proposalRevision)
    || !exactDigest(preview.proposalDigest)
    || !exactId(preview.workflowId)
    || !exactPositiveInteger(preview.workflowRevision)
    || !exactDigest(preview.sourceDefinitionHash)
    || !exactDigest(preview.reviewedDisabledDefinitionHash)
    || !exactDigest(preview.authorizedEnabledDefinitionHash)
    || !exactDigest(preview.intervalDigest)
    || !exactIso(preview.firstFireAt)
    || !exactId(preview.nodeId)
    || !exactDigest(preview.invocationPlanDigest)
    || !workflowInputsValid(preview.workflowInputs, preview.workflowInputsDigest)
    || !authoritySnapshotValid(preview.authoritySnapshot)
    || !exactIso(preview.previewedAt)
  ) return { ok: false, reason: 'recurrence preview identity is invalid' };
  const interval = parseWorkflowInterval(preview.interval);
  if (!interval.ok || workflowIntervalDigest(preview.interval) !== preview.intervalDigest) {
    return { ok: false, reason: 'recurrence preview interval is invalid or drifted' };
  }
  if (new Date(workflowIntervalOccurrenceAtMs(interval.value, 1)).toISOString() !== preview.firstFireAt) {
    return { ok: false, reason: 'recurrence preview first fire contradicts its interval' };
  }
  if (
    workflowDefinitionHash(preview.sourceDefinition) !== preview.sourceDefinitionHash
    || workflowDefinitionHash(preview.reviewedDisabledDefinition) !== preview.reviewedDisabledDefinitionHash
    || workflowDefinitionHash(preview.authorizedEnabledDefinition) !== preview.authorizedEnabledDefinitionHash
    || preview.sourceDefinition.name !== preview.workflowId
    || preview.reviewedDisabledDefinition.name !== preview.workflowId
    || preview.authorizedEnabledDefinition.name !== preview.workflowId
    || preview.reviewedDisabledDefinition.enabled !== false
    || preview.authorizedEnabledDefinition.enabled !== true
    || canonicalJson(preview.reviewedDisabledDefinition.trigger) !== canonicalJson({ interval: interval.value })
    || canonicalJson(preview.authorizedEnabledDefinition.trigger) !== canonicalJson({ interval: interval.value })
    || canonicalJson({ ...preview.authorizedEnabledDefinition, enabled: false })
      !== canonicalJson(preview.reviewedDisabledDefinition)
    || canonicalJson({
      ...preview.reviewedDisabledDefinition,
      enabled: preview.sourceDefinition.enabled,
      trigger: preview.sourceDefinition.trigger,
    }) !== canonicalJson(preview.sourceDefinition)
  ) return { ok: false, reason: 'recurrence preview definition bytes are contradictory or drifted' };
  const sourcePlan = preview.sourceDefinition.steps?.length === 1
    ? parseWorkflowNodeInvocationPlan(preview.sourceDefinition.steps[0]?.invocationPlan)
    : { ok: false as const, errors: ['missing source plan'] };
  if (
    !sourcePlan.ok
    || preview.sourceDefinition.steps[0]!.id !== preview.nodeId
    || sourcePlan.plan.bindingDigest !== preview.invocationPlanDigest
    || sourcePlan.plan.binding.effect !== 'read'
  ) return { ok: false, reason: 'recurrence preview read plan is invalid or drifted' };
  if (preview.resultProjection !== undefined) {
    const result = parseWorkflowCanonicalEntityResultProjection(preview.resultProjection);
    if (
      !result.ok
      || canonicalJson(sourcePlan.plan.resultProjection ?? null) !== canonicalJson(result.contract)
      || !preview.workspaceBinding
    ) return { ok: false, reason: 'recurrence preview result projection is invalid or unbound' };
  } else if (sourcePlan.plan.resultProjection !== undefined || preview.workspaceBinding !== undefined) {
    return { ok: false, reason: 'recurrence preview projection and Workspace binding are incomplete' };
  }
  if (preview.workspaceBinding !== undefined) {
    const binding = parseCanonicalEntityWorkspaceBindingApproval(preview.workspaceBinding);
    if (
      !binding.ok
      || binding.approval.binding.workflowId !== preview.workflowId
      || binding.approval.bindingDigest !== preview.authoritySnapshot.workspaceBindingDigest
    ) return { ok: false, reason: 'recurrence preview Workspace binding is invalid or drifted' };
  }
  const digest = previewDigest(previewBody(preview));
  if (preview.previewDigest !== digest || preview.previewId !== `automation-recurrence-preview:v1:${digest}`) {
    return { ok: false, reason: 'recurrence preview bytes do not match their digest' };
  }
  return { ok: true, preview };
}

function requestBody(value: AutomationRecurrenceConsentRequestV1): Omit<
  AutomationRecurrenceConsentRequestV1,
  'requestId' | 'requestDigest' | 'resumeKey'
> {
  const { requestId: _id, requestDigest: _digest, resumeKey: _resumeKey, ...body } = value;
  return body;
}

function cadenceLabel(interval: WorkflowIntervalV1): string {
  return `${interval.every} ${interval.unit}${interval.every === 1 ? '' : 's'}`;
}

export function createAutomationRecurrenceConsentRequest(input: {
  preview: AutomationRecurrencePreviewV1;
  approvalSessionId: string;
}): AutomationRecurrenceConsentRequestV1 {
  const parsed = parseAutomationRecurrencePreview(input.preview);
  if (!parsed.ok) throw new Error(parsed.reason);
  if (!exactId(input.approvalSessionId)) throw new Error('recurrence consent requires an exact approval session');
  const preview = parsed.preview;
  const args: AutomationRecurrenceConsentArgsV1 = {
    version: 1,
    action: 'activate_interval_read_recurrence',
    previewId: preview.previewId,
    previewDigest: preview.previewDigest,
    pilotSuccessEvidenceId: preview.pilotSuccessEvidenceId,
    pilotSuccessEvidenceDigest: preview.pilotSuccessEvidenceDigest,
    workflowId: preview.workflowId,
    proposalId: preview.proposalId,
    proposalRevision: preview.proposalRevision,
    proposalDigest: preview.proposalDigest,
    sourceDefinitionHash: preview.sourceDefinitionHash,
    reviewedDisabledDefinitionHash: preview.reviewedDisabledDefinitionHash,
    authorizedEnabledDefinitionHash: preview.authorizedEnabledDefinitionHash,
    interval: clone(preview.interval),
    intervalDigest: preview.intervalDigest,
    firstFireAt: preview.firstFireAt,
    effect: 'read',
    externalWrites: false,
    sends: false,
    nodeId: preview.nodeId,
    invocationPlanDigest: preview.invocationPlanDigest,
    workflowInputs: clone(preview.workflowInputs),
    workflowInputsDigest: preview.workflowInputsDigest,
    authoritySnapshot: clone(preview.authoritySnapshot),
    ...(preview.resultProjection ? { resultProjection: clone(preview.resultProjection) } : {}),
    ...(preview.workspaceBinding ? { workspaceBinding: clone(preview.workspaceBinding) } : {}),
  };
  const partial = {
    version: 1 as const,
    approvalSessionId: input.approvalSessionId,
    subject: `Activate ${preview.workflowId} every ${cadenceLabel(preview.interval)} beginning ${preview.firstFireAt} (read-only; ${preview.interval.overlapPolicy}; catch-up ${preview.interval.catchUpPolicy})`,
    tool: AUTOMATION_RECURRENCE_CONSENT_TOOL,
    args,
  };
  const requestDigest = sha256(canonicalJson({
    domain: 'automation-recurrence-consent-request',
    version: 1,
    request: partial,
  }));
  return {
    ...partial,
    requestId: `automation-recurrence-consent:v1:${requestDigest}`,
    requestDigest,
    resumeKey: `automation-recurrence-consent:v1:${requestDigest}`,
  };
}

export function parseAutomationRecurrenceConsentRequest(
  value: unknown,
): { ok: true; request: AutomationRecurrenceConsentRequestV1 } | { ok: false; reason: string } {
  let request: AutomationRecurrenceConsentRequestV1;
  try { request = clone(value) as AutomationRecurrenceConsentRequestV1; }
  catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
  if (
    request.version !== 1
    || !exactId(request.requestId)
    || !exactDigest(request.requestDigest)
    || !exactId(request.approvalSessionId)
    || typeof request.subject !== 'string'
    || request.subject !== request.subject.trim()
    || !request.subject
    || request.tool !== AUTOMATION_RECURRENCE_CONSENT_TOOL
    || request.resumeKey !== `automation-recurrence-consent:v1:${request.requestDigest}`
    || request.requestId !== request.resumeKey
    || request.args?.version !== 1
    || request.args.action !== 'activate_interval_read_recurrence'
    || request.args.effect !== 'read'
    || request.args.externalWrites !== false
    || request.args.sends !== false
    || !workflowInputsValid(request.args.workflowInputs, request.args.workflowInputsDigest)
  ) return { ok: false, reason: 'recurrence consent request identity is invalid' };
  const digest = sha256(canonicalJson({
    domain: 'automation-recurrence-consent-request',
    version: 1,
    request: requestBody(request),
  }));
  if (digest !== request.requestDigest) {
    return { ok: false, reason: 'recurrence consent request bytes do not match their digest' };
  }
  return { ok: true, request };
}

function database(): Database.Database {
  const db = openEventLog();
  const migrate = db.transaction(() => {
    db.exec(SCHEMA_SQL);
    db.prepare(`
      INSERT OR IGNORE INTO automation_recurrence_control_plane_migrations
        (version, applied_at) VALUES (1, ?)
    `).run(new Date().toISOString());
  });
  migrate.immediate();
  const versions = db.prepare(
    'SELECT version FROM automation_recurrence_control_plane_migrations ORDER BY version',
  ).all() as Array<{ version: number }>;
  if (versions.length !== 1 || versions[0]?.version !== 1) {
    throw new Error('automation recurrence control-plane schema version is unknown');
  }
  return db;
}

function activationIdFor(contract: AutomationRecurrenceContractV1): string {
  return `automation-recurrence:v1:${sha256(canonicalJson({
    domain: 'automation-recurrence-activation',
    version: 1,
    previewId: contract.preview.previewId,
    previewDigest: contract.preview.previewDigest,
    consentRequestId: contract.consentRequest.requestId,
    consentRequestDigest: contract.consentRequest.requestDigest,
  }))}`;
}

function stateWithoutDigest(value: AutomationRecurrenceActivationStateV1): Omit<AutomationRecurrenceActivationStateV1, 'stateDigest'> {
  const { stateDigest: _digest, ...body } = value;
  return body;
}

function stateDigest(value: Omit<AutomationRecurrenceActivationStateV1, 'stateDigest'>): string {
  return sha256(canonicalJson({ domain: 'automation-recurrence-state', version: 1, state: value }));
}

function contractFromRow(row: ActivationRow): AutomationRecurrenceContractV1 {
  let contract: AutomationRecurrenceContractV1;
  try { contract = JSON.parse(row.contract_json) as AutomationRecurrenceContractV1; }
  catch { throw new Error(`automation recurrence contract ${row.activation_id} is corrupt`); }
  if (sha256(row.contract_json) !== row.contract_digest || canonicalJson(contract) !== row.contract_json) {
    throw new Error(`automation recurrence contract ${row.activation_id} does not match its digest`);
  }
  const evidence = parseAutomationRecurrencePilotSuccessEvidence(contract.pilotSuccess);
  const preview = parseAutomationRecurrencePreview(contract.preview);
  const request = parseAutomationRecurrenceConsentRequest(contract.consentRequest);
  if (!evidence.ok || !preview.ok || !request.ok) {
    throw new Error(`automation recurrence contract ${row.activation_id} is invalid`);
  }
  if (
    row.workflow_id !== contract.preview.workflowId
    ||
    preview.preview.pilotSuccessEvidenceId !== evidence.evidence.evidenceId
    || preview.preview.pilotSuccessEvidenceDigest !== evidence.evidence.evidenceDigest
    || request.request.args.previewId !== preview.preview.previewId
    || request.request.args.previewDigest !== preview.preview.previewDigest
  ) throw new Error(`automation recurrence contract ${row.activation_id} has contradictory lineage`);
  return contract;
}

function stateBodyFromRow(
  row: ActivationRow,
  contract: AutomationRecurrenceContractV1,
): Omit<AutomationRecurrenceActivationStateV1, 'stateDigest'> {
  return {
    version: 1,
    activationId: row.activation_id,
    status: row.status,
    contractDigest: row.contract_digest,
    previewId: contract.preview.previewId,
    previewDigest: contract.preview.previewDigest,
    pilotSuccessEvidenceId: contract.pilotSuccess.evidenceId,
    pilotSuccessEvidenceDigest: contract.pilotSuccess.evidenceDigest,
    workflowId: contract.preview.workflowId,
    approvalSessionId: contract.consentRequest.approvalSessionId,
    approvalResumeKey: contract.consentRequest.resumeKey,
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    ...(row.activation_receipt_id ? { activationReceiptId: row.activation_receipt_id } : {}),
    ...(row.activation_receipt_digest ? { activationReceiptDigest: row.activation_receipt_digest } : {}),
    authorizedEnabledDefinitionHash: contract.preview.authorizedEnabledDefinitionHash,
    ...(row.installed_definition_hash ? { installedDefinitionHash: row.installed_definition_hash } : {}),
    ...(row.activated_at ? { activatedAt: row.activated_at } : {}),
    ...(row.refusal_code ? { refusalCode: row.refusal_code } : {}),
    ...(row.refusal_detail ? { refusalDetail: row.refusal_detail } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stateFromRow(row: ActivationRow, contract = contractFromRow(row)): AutomationRecurrenceActivationStateV1 {
  const value = stateBodyFromRow(row, contract);
  const digest = stateDigest(value);
  if (digest !== row.state_digest) {
    throw new Error(`automation recurrence state ${row.activation_id} does not match its digest`);
  }
  return { ...value, stateDigest: digest };
}

function rowForActivation(db: Database.Database, activationId: string): ActivationRow | undefined {
  return db.prepare(`SELECT * FROM automation_recurrence_activations WHERE activation_id = ? LIMIT 1`)
    .get(activationId) as ActivationRow | undefined;
}

function writeStateTransition(
  db: Database.Database,
  row: ActivationRow,
  contract: AutomationRecurrenceContractV1,
  patch: Partial<Omit<ActivationRow, 'activation_id' | 'contract_json' | 'contract_digest' | 'created_at'>>,
): AutomationRecurrenceActivationStateV1 {
  const nextRow: ActivationRow = { ...row, ...patch, revision: row.revision + 1 };
  const nextDigest = stateDigest(stateBodyFromRow(nextRow, contract));
  const changed = db.prepare(`
    UPDATE automation_recurrence_activations
       SET status = ?, approval_id = ?, activation_receipt_id = ?,
           activation_receipt_digest = ?, installed_definition_hash = ?, activated_at = ?,
           refusal_code = ?, refusal_detail = ?, revision = ?, state_digest = ?, updated_at = ?
     WHERE activation_id = ? AND revision = ? AND state_digest = ?
  `).run(
    nextRow.status,
    nextRow.approval_id,
    nextRow.activation_receipt_id,
    nextRow.activation_receipt_digest,
    nextRow.installed_definition_hash,
    nextRow.activated_at,
    nextRow.refusal_code,
    nextRow.refusal_detail,
    nextRow.revision,
    nextDigest,
    nextRow.updated_at,
    row.activation_id,
    row.revision,
    row.state_digest,
  ).changes;
  if (changed !== 1) throw new Error('automation recurrence state compare-and-swap lost');
  return stateFromRow(rowForActivation(db, row.activation_id)!, contract);
}

function initialRow(input: {
  activationId: string;
  contractJson: string;
  contractDigest: string;
  contract: AutomationRecurrenceContractV1;
  at: string;
}): ActivationRow {
  const provisional: Omit<AutomationRecurrenceActivationStateV1, 'stateDigest'> = {
    version: 1,
    activationId: input.activationId,
    status: 'registering',
    contractDigest: input.contractDigest,
    previewId: input.contract.preview.previewId,
    previewDigest: input.contract.preview.previewDigest,
    pilotSuccessEvidenceId: input.contract.pilotSuccess.evidenceId,
    pilotSuccessEvidenceDigest: input.contract.pilotSuccess.evidenceDigest,
    workflowId: input.contract.preview.workflowId,
    approvalSessionId: input.contract.consentRequest.approvalSessionId,
    approvalResumeKey: input.contract.consentRequest.resumeKey,
    authorizedEnabledDefinitionHash: input.contract.preview.authorizedEnabledDefinitionHash,
    revision: 1,
    createdAt: input.at,
    updatedAt: input.at,
  };
  return {
    activation_id: input.activationId,
    workflow_id: input.contract.preview.workflowId,
    status: 'registering',
    contract_json: input.contractJson,
    contract_digest: input.contractDigest,
    approval_id: null,
    activation_receipt_id: null,
    activation_receipt_digest: null,
    installed_definition_hash: null,
    activated_at: null,
    refusal_code: null,
    refusal_detail: null,
    revision: 1,
    state_digest: stateDigest(provisional),
    created_at: input.at,
    updated_at: input.at,
  };
}

function crossContractIssue(contract: AutomationRecurrenceContractV1): string | null {
  const evidence = parseAutomationRecurrencePilotSuccessEvidence(contract.pilotSuccess);
  const preview = parseAutomationRecurrencePreview(contract.preview);
  const request = parseAutomationRecurrenceConsentRequest(contract.consentRequest);
  if (!evidence.ok) return evidence.reason;
  if (!preview.ok) return preview.reason;
  if (!request.ok) return request.reason;
  if (
    preview.preview.pilotSuccessEvidenceId !== evidence.evidence.evidenceId
    || preview.preview.pilotSuccessEvidenceDigest !== evidence.evidence.evidenceDigest
    || request.request.args.previewId !== preview.preview.previewId
    || request.request.args.previewDigest !== preview.preview.previewDigest
    || request.request.args.pilotSuccessEvidenceId !== evidence.evidence.evidenceId
    || request.request.args.pilotSuccessEvidenceDigest !== evidence.evidence.evidenceDigest
    || request.request.args.authorizedEnabledDefinitionHash !== preview.preview.authorizedEnabledDefinitionHash
  ) return 'recurrence evidence, preview, and formal consent request do not share exact lineage';
  if (
    preview.preview.proposalId !== evidence.evidence.proposalId
    || preview.preview.proposalRevision !== evidence.evidence.proposalRevision
    || preview.preview.proposalDigest !== evidence.evidence.proposalDigest
    || preview.preview.workflowId !== evidence.evidence.workflowId
    || preview.preview.workflowRevision !== evidence.evidence.workflowRevision
    || preview.preview.sourceDefinitionHash !== evidence.evidence.workflowDigest
    || preview.preview.nodeId !== evidence.evidence.nodeId
    || preview.preview.invocationPlanDigest !== evidence.evidence.invocationPlanDigest
    || preview.preview.workflowInputsDigest !== evidence.evidence.workflowInputsDigest
    || canonicalJson(preview.preview.workflowInputs) !== canonicalJson(evidence.evidence.workflowInputs)
    || canonicalJson(preview.preview.authoritySnapshot) !== canonicalJson(evidence.evidence.authoritySnapshot)
    || canonicalJson(preview.preview.workspaceBinding ?? null)
      !== canonicalJson(evidence.evidence.workspaceBinding ?? null)
    || readPlanIssue(preview.preview.sourceDefinition, evidence.evidence) !== null
  ) return 'recurrence preview does not preserve the exact successful pilot authority';
  const expectedRequest = createAutomationRecurrenceConsentRequest({
    preview: preview.preview,
    approvalSessionId: request.request.approvalSessionId,
  });
  if (canonicalJson(expectedRequest) !== canonicalJson(request.request)) {
    return 'formal recurrence consent card does not exactly represent the reviewed preview';
  }
  return null;
}

export function registerAutomationRecurrenceActivation(input: {
  pilotSuccess: AutomationRecurrencePilotSuccessEvidenceV1;
  preview: AutomationRecurrencePreviewV1;
  consentRequest: AutomationRecurrenceConsentRequestV1;
  at?: string;
}): RegisterAutomationRecurrenceResultV1 {
  const at = input.at ?? new Date().toISOString();
  if (!exactIso(at)) return { ok: false, code: 'invalid_time', reason: 'registration time is not canonical ISO' };
  let contract: AutomationRecurrenceContractV1;
  try {
    contract = clone({
      version: 1,
      pilotSuccess: input.pilotSuccess,
      preview: input.preview,
      consentRequest: input.consentRequest,
    });
  } catch (error) {
    return { ok: false, code: 'invalid_contract', reason: error instanceof Error ? error.message : String(error) };
  }
  const issue = crossContractIssue(contract);
  if (issue) return { ok: false, code: 'invalid_contract', reason: issue };
  const contractJson = canonicalJson(contract);
  const contractDigest = sha256(contractJson);
  const activationId = activationIdFor(contract);
  const db = database();
  try {
    return db.transaction((): RegisterAutomationRecurrenceResultV1 => {
      const retained = rowForActivation(db, activationId);
      if (retained) {
        const state = stateFromRow(retained);
        if (retained.contract_json !== contractJson || retained.contract_digest !== contractDigest) {
          return { ok: false, code: 'activation_conflict', reason: 'retained activation has contradictory contract bytes' };
        }
        return { ok: true, inserted: false, state };
      }
      const row = initialRow({ activationId, contractJson, contractDigest, contract, at });
      db.prepare(`
        INSERT INTO automation_recurrence_activations (
          activation_id, workflow_id, status, contract_json, contract_digest, approval_id,
          activation_receipt_id, activation_receipt_digest, installed_definition_hash,
          activated_at, refusal_code, refusal_detail, revision, state_digest, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
      `).run(
        row.activation_id,
        row.workflow_id,
        row.status,
        row.contract_json,
        row.contract_digest,
        row.revision,
        row.state_digest,
        row.created_at,
        row.updated_at,
      );
      return { ok: true, inserted: true, state: stateFromRow(rowForActivation(db, activationId)!, contract) };
    }).immediate();
  } catch (error) {
    return { ok: false, code: 'state_write_failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

function approvalMatchesRequest(row: PendingApprovalRow, request: AutomationRecurrenceConsentRequestV1): boolean {
  try {
    return row.approvalId === row.approvalId.trim()
      && exactId(row.approvalId)
      && row.sessionId === request.approvalSessionId
      && row.resumeKey === request.resumeKey
      && row.subject === request.subject
      && row.tool === request.tool
      && canonicalJson(row.args) === canonicalJson(request.args)
      && row.presentation === null;
  } catch {
    return false;
  }
}

export function automationRecurrenceConsentDecisionDigest(input: {
  approval: PendingApprovalRow;
  request: AutomationRecurrenceConsentRequestV1;
}): string | null {
  const { approval, request } = input;
  if (
    !approvalMatchesRequest(approval, request)
    || approval.status !== 'resolved'
    || approval.resolution !== 'approved'
    || !approval.resolver
    || !approval.resolvedAt
    || !exactIso(approval.requestedAt)
    || !exactIso(approval.expiresAt)
    || !exactIso(approval.resolvedAt)
    || !approvalResolutionWithinLifetime(approval)
    || approval.consumedAt !== null
  ) return null;
  return sha256(canonicalJson({
    domain: 'automation-recurrence-consent-decision',
    version: 1,
    decision: 'approved',
    approvalId: approval.approvalId,
    approvalSessionId: approval.sessionId,
    resumeKey: approval.resumeKey,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    subject: approval.subject,
    tool: approval.tool,
    args: approval.args,
    resolver: approval.resolver,
    resolvedAt: approval.resolvedAt,
  }));
}

export function bindAutomationRecurrenceConsentApproval(input: {
  activationId: string;
  approval: PendingApprovalRow;
  at?: string;
}): BindAutomationRecurrenceConsentResultV1 {
  const at = input.at ?? new Date().toISOString();
  if (!exactId(input.activationId) || !exactIso(at)) {
    return { ok: false, code: 'invalid_input', reason: 'activation identity or transition time is invalid' };
  }
  const db = database();
  try {
    return db.transaction((): BindAutomationRecurrenceConsentResultV1 => {
      const row = rowForActivation(db, input.activationId);
      if (!row) return { ok: false, code: 'activation_missing', reason: 'recurrence activation is missing' };
      const contract = contractFromRow(row);
      const state = stateFromRow(row, contract);
      if (!approvalMatchesRequest(input.approval, contract.consentRequest)) {
        return { ok: false, code: 'consent_mismatch', reason: 'formal consent row does not match the exact recurrence preview', state };
      }
      if (row.approval_id && row.approval_id !== input.approval.approvalId) {
        return { ok: false, code: 'consent_conflict', reason: 'another formal consent row already owns this activation', state };
      }
      if (row.status !== 'registering') {
        if (row.approval_id === input.approval.approvalId) return { ok: true, replayed: true, state };
        return { ok: false, code: 'state_conflict', reason: `activation is already ${row.status}`, state };
      }
      const updated = writeStateTransition(db, row, contract, {
        status: 'approval_pending',
        approval_id: input.approval.approvalId,
        updated_at: at,
      });
      return { ok: true, replayed: false, state: updated };
    }).immediate();
  } catch (error) {
    return { ok: false, code: 'state_write_failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

function receiptBody(value: AutomationRecurrenceActivationReceiptV1): Omit<AutomationRecurrenceActivationReceiptV1, 'receiptId' | 'receiptDigest'> {
  const { receiptId: _id, receiptDigest: _digest, ...body } = value;
  return body;
}

function receiptFrom(input: {
  activationId: string;
  contract: AutomationRecurrenceContractV1;
  approval: PendingApprovalRow;
  decisionDigest: string;
}): AutomationRecurrenceActivationReceiptV1 {
  const { preview, pilotSuccess, consentRequest } = input.contract;
  const body: Omit<AutomationRecurrenceActivationReceiptV1, 'receiptId' | 'receiptDigest'> = {
    version: 1,
    authorization: 'standing_interval_read',
    activationId: input.activationId,
    previewId: preview.previewId,
    previewDigest: preview.previewDigest,
    pilotSuccessEvidenceId: pilotSuccess.evidenceId,
    pilotSuccessEvidenceDigest: pilotSuccess.evidenceDigest,
    proposalId: preview.proposalId,
    proposalRevision: preview.proposalRevision,
    proposalDigest: preview.proposalDigest,
    workflowId: preview.workflowId,
    workflowRevision: preview.workflowRevision,
    sourceDefinitionHash: preview.sourceDefinitionHash,
    reviewedDisabledDefinitionHash: preview.reviewedDisabledDefinitionHash,
    authorizedEnabledDefinitionHash: preview.authorizedEnabledDefinitionHash,
    interval: clone(preview.interval),
    intervalDigest: preview.intervalDigest,
    firstFireAt: preview.firstFireAt,
    nodeId: preview.nodeId,
    invocationPlanDigest: preview.invocationPlanDigest,
    workflowInputs: clone(preview.workflowInputs),
    workflowInputsDigest: preview.workflowInputsDigest,
    authoritySnapshot: clone(preview.authoritySnapshot),
    ...(preview.resultProjection ? { resultProjection: clone(preview.resultProjection) } : {}),
    ...(preview.workspaceBinding ? { workspaceBinding: clone(preview.workspaceBinding) } : {}),
    consent: {
      version: 1,
      approvalId: input.approval.approvalId,
      approvalSessionId: input.approval.sessionId,
      resumeKey: input.approval.resumeKey!,
      requestDigest: consentRequest.requestDigest,
      requestedAt: input.approval.requestedAt,
      expiresAt: input.approval.expiresAt,
      resolver: input.approval.resolver!,
      resolvedAt: input.approval.resolvedAt!,
      decisionDigest: input.decisionDigest,
    },
    authorizedAt: input.approval.resolvedAt!,
  };
  const receiptDigest = sha256(canonicalJson({
    domain: 'automation-recurrence-activation-receipt',
    version: 1,
    receipt: body,
  }));
  return {
    ...body,
    receiptId: `automation-recurrence-receipt:v1:${receiptDigest}`,
    receiptDigest,
  };
}

export function parseAutomationRecurrenceActivationReceipt(
  value: unknown,
): { ok: true; receipt: AutomationRecurrenceActivationReceiptV1 } | { ok: false; reason: string } {
  let receipt: AutomationRecurrenceActivationReceiptV1;
  try { receipt = clone(value) as AutomationRecurrenceActivationReceiptV1; }
  catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
  if (
    receipt.version !== 1
    || receipt.authorization !== 'standing_interval_read'
    || !exactId(receipt.receiptId)
    || !exactDigest(receipt.receiptDigest)
    || !exactId(receipt.activationId)
    || !exactId(receipt.previewId)
    || !exactDigest(receipt.previewDigest)
    || !exactId(receipt.pilotSuccessEvidenceId)
    || !exactDigest(receipt.pilotSuccessEvidenceDigest)
    || !exactId(receipt.proposalId)
    || !exactPositiveInteger(receipt.proposalRevision)
    || !exactDigest(receipt.proposalDigest)
    || !exactId(receipt.workflowId)
    || !exactPositiveInteger(receipt.workflowRevision)
    || !exactDigest(receipt.sourceDefinitionHash)
    || !exactDigest(receipt.reviewedDisabledDefinitionHash)
    || !exactDigest(receipt.authorizedEnabledDefinitionHash)
    || !exactDigest(receipt.intervalDigest)
    || !exactIso(receipt.firstFireAt)
    || !exactId(receipt.nodeId)
    || !exactDigest(receipt.invocationPlanDigest)
    || !workflowInputsValid(receipt.workflowInputs, receipt.workflowInputsDigest)
    || !authoritySnapshotValid(receipt.authoritySnapshot)
    || !exactIso(receipt.authorizedAt)
    || receipt.consent?.version !== 1
    || !exactId(receipt.consent.approvalId)
    || !exactId(receipt.consent.approvalSessionId)
    || !exactId(receipt.consent.resumeKey)
    || !exactDigest(receipt.consent.requestDigest)
    || !exactIso(receipt.consent.requestedAt)
    || !exactIso(receipt.consent.expiresAt)
    || !exactId(receipt.consent.resolver)
    || !exactIso(receipt.consent.resolvedAt)
    || !exactDigest(receipt.consent.decisionDigest)
    || receipt.authorizedAt !== receipt.consent.resolvedAt
  ) return { ok: false, reason: 'recurrence activation receipt identity is invalid' };
  const interval = parseWorkflowInterval(receipt.interval);
  if (
    !interval.ok
    || workflowIntervalDigest(receipt.interval) !== receipt.intervalDigest
    || new Date(workflowIntervalOccurrenceAtMs(receipt.interval, 1)).toISOString() !== receipt.firstFireAt
  ) return { ok: false, reason: 'recurrence activation receipt interval is invalid or contradictory' };
  if (receipt.resultProjection !== undefined && !parseWorkflowCanonicalEntityResultProjection(receipt.resultProjection).ok) {
    return { ok: false, reason: 'recurrence activation receipt result projection is invalid' };
  }
  if ((receipt.resultProjection === undefined) !== (receipt.workspaceBinding === undefined)) {
    return { ok: false, reason: 'recurrence activation receipt projection and Workspace binding are incomplete' };
  }
  if (receipt.workspaceBinding !== undefined) {
    const binding = parseCanonicalEntityWorkspaceBindingApproval(receipt.workspaceBinding);
    if (
      !binding.ok
      || binding.approval.binding.workflowId !== receipt.workflowId
      || binding.approval.bindingDigest !== receipt.authoritySnapshot.workspaceBindingDigest
    ) return { ok: false, reason: 'recurrence activation receipt Workspace binding is invalid or drifted' };
  }
  const digest = sha256(canonicalJson({
    domain: 'automation-recurrence-activation-receipt',
    version: 1,
    receipt: receiptBody(receipt),
  }));
  if (receipt.receiptDigest !== digest || receipt.receiptId !== `automation-recurrence-receipt:v1:${digest}`) {
    return { ok: false, reason: 'recurrence activation receipt bytes do not match their digest' };
  }
  return { ok: true, receipt };
}

function receiptFromRow(row: ReceiptRow): AutomationRecurrenceActivationReceiptV1 {
  let value: unknown;
  try { value = JSON.parse(row.receipt_json); }
  catch { throw new Error(`automation recurrence receipt ${row.receipt_id} is corrupt`); }
  const parsed = parseAutomationRecurrenceActivationReceipt(value);
  if (
    !parsed.ok
    || parsed.receipt.receiptId !== row.receipt_id
    || parsed.receipt.receiptDigest !== row.receipt_digest
    || parsed.receipt.activationId !== row.activation_id
    || canonicalJson(parsed.receipt) !== row.receipt_json
  ) throw new Error(`automation recurrence receipt ${row.receipt_id} is invalid or drifted`);
  return parsed.receipt;
}

function receiptMatchesContract(
  receipt: AutomationRecurrenceActivationReceiptV1,
  contract: AutomationRecurrenceContractV1,
): boolean {
  const { preview, pilotSuccess, consentRequest } = contract;
  try {
    return receipt.activationId === activationIdFor(contract)
      && receipt.previewId === preview.previewId
      && receipt.previewDigest === preview.previewDigest
      && receipt.pilotSuccessEvidenceId === pilotSuccess.evidenceId
      && receipt.pilotSuccessEvidenceDigest === pilotSuccess.evidenceDigest
      && receipt.proposalId === preview.proposalId
      && receipt.proposalRevision === preview.proposalRevision
      && receipt.proposalDigest === preview.proposalDigest
      && receipt.workflowId === preview.workflowId
      && receipt.workflowRevision === preview.workflowRevision
      && receipt.sourceDefinitionHash === preview.sourceDefinitionHash
      && receipt.reviewedDisabledDefinitionHash === preview.reviewedDisabledDefinitionHash
      && receipt.authorizedEnabledDefinitionHash === preview.authorizedEnabledDefinitionHash
      && canonicalJson(receipt.interval) === canonicalJson(preview.interval)
      && receipt.intervalDigest === preview.intervalDigest
      && receipt.firstFireAt === preview.firstFireAt
      && receipt.nodeId === preview.nodeId
      && receipt.invocationPlanDigest === preview.invocationPlanDigest
      && receipt.workflowInputsDigest === preview.workflowInputsDigest
      && canonicalJson(receipt.workflowInputs) === canonicalJson(preview.workflowInputs)
      && canonicalJson(receipt.authoritySnapshot) === canonicalJson(preview.authoritySnapshot)
      && canonicalJson(receipt.resultProjection ?? null) === canonicalJson(preview.resultProjection ?? null)
      && canonicalJson(receipt.workspaceBinding ?? null) === canonicalJson(preview.workspaceBinding ?? null)
      && receipt.consent.approvalSessionId === consentRequest.approvalSessionId
      && receipt.consent.resumeKey === consentRequest.resumeKey
      && receipt.consent.requestDigest === consentRequest.requestDigest;
  } catch {
    return false;
  }
}

function receiptForActivation(db: Database.Database, activationId: string): AutomationRecurrenceActivationReceiptV1 | null {
  const row = db.prepare(`
    SELECT * FROM automation_recurrence_activation_receipts WHERE activation_id = ? LIMIT 1
  `).get(activationId) as ReceiptRow | undefined;
  return row ? receiptFromRow(row) : null;
}

function retainReceipt(
  db: Database.Database,
  receipt: AutomationRecurrenceActivationReceiptV1,
): AutomationRecurrenceActivationReceiptV1 {
  const json = canonicalJson(receipt);
  db.prepare(`
    INSERT OR IGNORE INTO automation_recurrence_activation_receipts
      (receipt_id, activation_id, receipt_json, receipt_digest, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(receipt.receiptId, receipt.activationId, json, receipt.receiptDigest, receipt.authorizedAt);
  const retained = receiptForActivation(db, receipt.activationId);
  if (!retained || canonicalJson(retained) !== json) {
    throw new Error('retained recurrence activation receipt conflicts with the approved decision');
  }
  return retained;
}

function definitionHash(value: unknown): string | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as WorkflowDefinition;
    if (!exactId(candidate.name) || !Array.isArray(candidate.steps)) return null;
    // The workflow reader intentionally materializes absent optional fields as
    // `undefined`. Normalize through JSON before the closed-size check so the
    // exact durable SKILL.md representation hashes like the authorized object,
    // while functions, cycles, BigInt, and out-of-bounds data still fail shut.
    const normalizedJson = JSON.stringify(candidate);
    if (
      typeof normalizedJson !== 'string'
      || Buffer.byteLength(normalizedJson, 'utf8') > MAX_CONTRACT_BYTES
    ) return null;
    JSON.parse(normalizedJson) as WorkflowDefinition;
    return workflowDefinitionHash(candidate);
  } catch {
    return null;
  }
}

function refused(
  db: Database.Database,
  row: ActivationRow,
  contract: AutomationRecurrenceContractV1,
  code: string,
  detail: string,
  at: string,
): ReconcileAutomationRecurrenceResultV1 {
  if (row.status === 'refused') {
    return { ok: true, state: 'refused', activation: stateFromRow(row, contract) };
  }
  const activation = writeStateTransition(db, row, contract, {
    status: 'refused',
    refusal_code: code.slice(0, 128),
    refusal_detail: detail.slice(0, 2_000),
    updated_at: at,
  });
  return { ok: true, state: 'refused', activation };
}

function activeAuthority(
  activation: AutomationRecurrenceActivationStateV1,
  receipt: AutomationRecurrenceActivationReceiptV1,
): AutomationRecurrenceActiveAuthorityV1 {
  if (
    activation.status !== 'active'
    || activation.activationReceiptId !== receipt.receiptId
    || activation.activationReceiptDigest !== receipt.receiptDigest
    || activation.authorizedEnabledDefinitionHash !== receipt.authorizedEnabledDefinitionHash
  ) throw new Error('recurrence activation is not exact active authority');
  return {
    version: 1,
    activationId: activation.activationId,
    activationStateDigest: activation.stateDigest,
    activationReceiptId: receipt.receiptId,
    activationReceiptDigest: receipt.receiptDigest,
    workflowId: activation.workflowId,
    authorizedEnabledDefinitionHash: activation.authorizedEnabledDefinitionHash,
  };
}

function readyToInstall(
  activation: AutomationRecurrenceActivationStateV1,
  contract: AutomationRecurrenceContractV1,
  receipt: AutomationRecurrenceActivationReceiptV1,
): ReconcileAutomationRecurrenceResultV1 {
  return {
    ok: true,
    state: 'ready_to_install',
    activation,
    receipt,
    installation: {
      expectedDefinitionHashes: [
        contract.preview.sourceDefinitionHash,
        contract.preview.reviewedDisabledDefinitionHash,
      ],
      authorizedDefinition: clone(contract.preview.authorizedEnabledDefinition),
      authorizedDefinitionHash: contract.preview.authorizedEnabledDefinitionHash,
    },
  };
}

export function reconcileAutomationRecurrenceActivation(input: {
  activationId: string;
  currentDefinition: unknown;
  approval?: PendingApprovalRow | null;
  at?: string;
}): ReconcileAutomationRecurrenceResultV1 {
  const at = input.at ?? new Date().toISOString();
  if (!exactId(input.activationId) || !exactIso(at)) {
    return { ok: false, code: 'invalid_input', reason: 'activation identity or reconciliation time is invalid' };
  }
  const db = database();
  try {
    return db.transaction((): ReconcileAutomationRecurrenceResultV1 => {
      let row = rowForActivation(db, input.activationId);
      if (!row) return { ok: false, code: 'activation_missing', reason: 'recurrence activation is missing' };
      const contract = contractFromRow(row);
      let activation = stateFromRow(row, contract);
      if (row.status === 'refused') return { ok: true, state: 'refused', activation };

      // Validate the workflow before requiring a consent binding. This lets a
      // boot/tick reconcile an abandoned registering intent to a durable
      // refusal without first manufacturing a formal approval card for work
      // that no longer exists.
      const currentHash = definitionHash(input.currentDefinition);
      if (!currentHash) return refused(db, row, contract, 'workflow_missing_or_invalid', 'The exact workflow definition is missing or invalid.', at);

      if (row.status === 'registering') {
        return { ok: false, code: 'consent_not_bound', reason: 'formal recurrence consent card has not been bound', activation };
      }

      if (row.status === 'approval_pending') {
        const approval = input.approval;
        if (!approval || approval.approvalId !== row.approval_id || !approvalMatchesRequest(approval, contract.consentRequest)) {
          return refused(
            db,
            row,
            contract,
            'consent_missing_or_invalid',
            'The canonical formal consent row is missing or contradicts the exact recurrence request.',
            at,
          );
        }
        if (approval.status === 'pending') return { ok: true, state: 'pending', activation };
        if (approval.status !== 'resolved' || approval.resolution !== 'approved') {
          return refused(db, row, contract, 'consent_not_approved', `Formal recurrence consent resolved as ${approval.resolution ?? approval.status}.`, at);
        }
        if (!approvalResolutionWithinLifetime(approval)) {
          return refused(
            db,
            row,
            contract,
            'consent_outside_lifetime',
            'Formal recurrence consent was resolved outside the exact lifetime of its approval card.',
            at,
          );
        }
        const decisionDigest = automationRecurrenceConsentDecisionDigest({
          approval,
          request: contract.consentRequest,
        });
        if (!decisionDigest) {
          return { ok: false, code: 'consent_mismatch', reason: 'approved recurrence consent bytes are malformed, consumed, or contradictory', activation };
        }
        if (
          currentHash !== contract.preview.sourceDefinitionHash
          && currentHash !== contract.preview.reviewedDisabledDefinitionHash
        ) {
          return refused(db, row, contract, 'definition_drifted_before_activation', 'Workflow bytes changed after preview and before activation.', at);
        }
        const receipt = retainReceipt(db, receiptFrom({
          activationId: row.activation_id,
          contract,
          approval,
          decisionDigest,
        }));
        activation = writeStateTransition(db, row, contract, {
          status: 'activating',
          activation_receipt_id: receipt.receiptId,
          activation_receipt_digest: receipt.receiptDigest,
          updated_at: at,
        });
        return readyToInstall(activation, contract, receipt);
      }

      const receipt = receiptForActivation(db, row.activation_id);
      if (
        !receipt
        || !receiptMatchesContract(receipt, contract)
        || row.activation_receipt_id !== receipt.receiptId
        || row.activation_receipt_digest !== receipt.receiptDigest
      ) return refused(db, row, contract, 'activation_receipt_missing', 'Standing recurrence receipt is missing or contradictory.', at);

      if (currentHash === contract.preview.authorizedEnabledDefinitionHash) {
        if (row.status !== 'active') {
          activation = writeStateTransition(db, row, contract, {
            status: 'active',
            installed_definition_hash: currentHash,
            activated_at: at,
            updated_at: at,
          });
          row = rowForActivation(db, row.activation_id)!;
        }
        return {
          ok: true,
          state: 'active',
          activation,
          receipt,
          authority: activeAuthority(activation, receipt),
        };
      }

      if (
        row.status === 'activating'
        && (
          currentHash === contract.preview.sourceDefinitionHash
          || currentHash === contract.preview.reviewedDisabledDefinitionHash
        )
      ) return readyToInstall(activation, contract, receipt);

      return refused(db, row, contract, 'definition_revision_drifted', 'Workflow revision no longer matches the consented source or enabled bytes.', at);
    }).immediate();
  } catch (error) {
    return { ok: false, code: 'reconciliation_failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

export function getAutomationRecurrenceActivation(
  activationId: string,
): AutomationRecurrenceActivationStateV1 | null {
  if (!exactId(activationId)) return null;
  const row = rowForActivation(database(), activationId);
  return row ? stateFromRow(row) : null;
}

/** Read-only recovery view of the exact evidence → preview → consent bytes.
 * Boot/tick reconciliation uses this to repair a crash after the activation
 * intent was stored but before its formal approval card was registered. */
export function getAutomationRecurrenceActivationContract(
  activationId: string,
): AutomationRecurrenceContractV1 | null {
  if (!exactId(activationId)) return null;
  const row = rowForActivation(database(), activationId);
  return row ? clone(contractFromRow(row)) : null;
}

export function getAutomationRecurrenceActivationReceipt(
  activationId: string,
): AutomationRecurrenceActivationReceiptV1 | null {
  if (!exactId(activationId)) return null;
  const db = database();
  const row = rowForActivation(db, activationId);
  if (!row) return null;
  const contract = contractFromRow(row);
  const receipt = receiptForActivation(db, activationId);
  if (receipt && !receiptMatchesContract(receipt, contract)) {
    throw new Error(`automation recurrence receipt ${receipt.receiptId} contradicts its activation contract`);
  }
  return receipt;
}

export function getAutomationRecurrenceActiveAuthority(
  activationId: string,
): AutomationRecurrenceActiveAuthorityV1 | null {
  const db = database();
  const row = rowForActivation(db, activationId);
  if (!row) return null;
  const activation = stateFromRow(row);
  const receipt = receiptForActivation(db, activationId);
  const contract = contractFromRow(row);
  if (!receipt || !receiptMatchesContract(receipt, contract) || activation.status !== 'active') return null;
  return activeAuthority(activation, receipt);
}

export function getActiveAutomationRecurrenceForWorkflow(workflowId: string): {
  activation: AutomationRecurrenceActivationStateV1;
  receipt: AutomationRecurrenceActivationReceiptV1;
  authority: AutomationRecurrenceActiveAuthorityV1;
} | null {
  if (!exactId(workflowId)) return null;
  const db = database();
  const rows = db.prepare(`
    SELECT * FROM automation_recurrence_activations
     WHERE workflow_id = ? AND status = 'active'
     ORDER BY activation_id
  `).all(workflowId) as ActivationRow[];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error(`workflow ${workflowId} has ambiguous recurrence authority`);
  const row = rows[0]!;
  const contract = contractFromRow(row);
  const activation = stateFromRow(row, contract);
  const receipt = receiptForActivation(db, activation.activationId);
  if (!receipt || !receiptMatchesContract(receipt, contract)) {
    throw new Error(`workflow ${workflowId} has corrupt recurrence authority`);
  }
  return { activation, receipt, authority: activeAuthority(activation, receipt) };
}

export function listAutomationRecurrenceActivationsForReconciliation(): AutomationRecurrenceActivationStateV1[] {
  const db = database();
  const rows = db.prepare(`
    SELECT * FROM automation_recurrence_activations
     WHERE status IN ('registering','approval_pending','activating','active')
     ORDER BY updated_at, activation_id
  `).all() as ActivationRow[];
  return rows.map((row) => stateFromRow(row));
}
