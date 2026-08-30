import { createHash } from 'node:crypto';

import { parseWorkflowNodeInvocationPlan } from '../memory/workflow-node-invocation-plan.js';
import {
  parseWorkflowCanonicalEntityResultProjection,
  type WorkflowCanonicalEntityResultProjection,
} from '../memory/workflow-result-projection-contract.js';
import {
  parseCanonicalEntityWorkspaceBindingApproval,
  type CanonicalEntityWorkspaceBindingApprovalV1,
} from '../spaces/canonical-entity-workspace-binding-contract.js';
import {
  oneShotActivationAuthorizationDecisionDigest,
  type OneShotActivationAuthorization,
} from '../runtime/harness/accepted-turn-call-authority.js';
import type { PendingApprovalRow } from '../runtime/harness/approval-registry.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import {
  workflowDefinitionHash,
  type WorkflowRunDefinitionSnapshot,
} from './workflow-run-definition.js';

export const WORKFLOW_READ_PILOT_ADMISSION_VERSION = 1 as const;
export const WORKFLOW_READ_PILOT_APPROVAL_TOOL = 'workflow_node_read' as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const EXACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;

export interface WorkflowReadPilotLineageV1 {
  version: typeof WORKFLOW_READ_PILOT_ADMISSION_VERSION;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  compilationDigest: string;
  bindingSnapshotDigest: string;
  controlDigest: string;
  workflowId: string;
  workflowRevision: number;
  workflowDigest: string;
  runOccurrenceId: string;
  nodeId: string;
  nodeAttempt: number;
  invocationPlanDigest: string;
  workflowSessionId: string;
  /** Full reviewed bytes are deliberately present on the formal approval
   * card. A digest-only card would hide the extraction/entity contract. */
  resultProjection?: WorkflowCanonicalEntityResultProjection;
  workspaceBinding?: CanonicalEntityWorkspaceBindingApprovalV1;
}

export interface WorkflowReadPilotAdmissionDraftV1 extends WorkflowReadPilotLineageV1 {
  oneShotActivationAuthorization: OneShotActivationAuthorization;
}

export interface WorkflowReadPilotAdmissionV1 extends WorkflowReadPilotAdmissionDraftV1 {
  runId: string;
  admissionDigest: string;
}

export interface WorkflowReadPilotApprovalRequestV1 {
  subject: string;
  tool: typeof WORKFLOW_READ_PILOT_APPROVAL_TOOL;
  args: Record<string, unknown>;
  resumeKey: string;
}

export type WorkflowReadPilotAdmissionResolution =
  | { ok: true; admission: WorkflowReadPilotAdmissionV1 }
  | { ok: false; reason: string };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 24,
    maxNodes: 8_000,
    maxStringBytes: 32_000,
    maxTotalBytes: 256_000,
  });
}

function exactId(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && EXACT_ID_RE.test(value);
}

function exactDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function canonicalLineage(input: WorkflowReadPilotLineageV1): WorkflowReadPilotLineageV1 {
  return {
    version: WORKFLOW_READ_PILOT_ADMISSION_VERSION,
    proposalId: input.proposalId,
    proposalRevision: input.proposalRevision,
    proposalDigest: input.proposalDigest,
    compilationDigest: input.compilationDigest,
    bindingSnapshotDigest: input.bindingSnapshotDigest,
    controlDigest: input.controlDigest,
    workflowId: input.workflowId,
    workflowRevision: input.workflowRevision,
    workflowDigest: input.workflowDigest,
    runOccurrenceId: input.runOccurrenceId,
    nodeId: input.nodeId,
    nodeAttempt: input.nodeAttempt,
    invocationPlanDigest: input.invocationPlanDigest,
    workflowSessionId: input.workflowSessionId,
    ...(input.resultProjection
      ? { resultProjection: JSON.parse(canonicalJson(input.resultProjection)) as WorkflowCanonicalEntityResultProjection }
      : {}),
    ...(input.workspaceBinding
      ? { workspaceBinding: JSON.parse(canonicalJson(input.workspaceBinding)) as CanonicalEntityWorkspaceBindingApprovalV1 }
      : {}),
  };
}

function lineageValid(value: WorkflowReadPilotLineageV1): boolean {
  return value.version === WORKFLOW_READ_PILOT_ADMISSION_VERSION
    && exactId(value.proposalId)
    && Number.isSafeInteger(value.proposalRevision)
    && value.proposalRevision > 0
    && exactDigest(value.proposalDigest)
    && exactDigest(value.compilationDigest)
    && exactDigest(value.bindingSnapshotDigest)
    && exactDigest(value.controlDigest)
    && exactId(value.workflowId)
    && Number.isSafeInteger(value.workflowRevision)
    && value.workflowRevision > 0
    && exactDigest(value.workflowDigest)
    && exactId(value.runOccurrenceId)
    && exactId(value.nodeId)
    && Number.isSafeInteger(value.nodeAttempt)
    && value.nodeAttempt > 0
    && exactDigest(value.invocationPlanDigest)
    && exactId(value.workflowSessionId)
    && (value.resultProjection === undefined
      || parseWorkflowCanonicalEntityResultProjection(value.resultProjection).ok)
    && (value.workspaceBinding === undefined
      || (
        parseCanonicalEntityWorkspaceBindingApproval(value.workspaceBinding).ok
        && value.workspaceBinding.binding.workflowId === value.workflowId
      ));
}

export function workflowReadPilotOccurrenceId(input: {
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  compilationDigest: string;
}): string {
  canonicalJson(input);
  return `pilot-occurrence:${sha256(canonicalJson({ version: 1, ...input }))}`;
}

export function workflowReadPilotSessionId(input: {
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  compilationDigest: string;
}): string {
  canonicalJson(input);
  return `workflow-pilot:${sha256(canonicalJson({ version: 1, ...input }))}`;
}

export function workflowReadPilotApprovalRequest(
  lineage: WorkflowReadPilotLineageV1,
): WorkflowReadPilotApprovalRequestV1 {
  canonicalJson(lineage);
  if (!lineageValid(lineage)) throw new Error('workflow read pilot lineage is invalid');
  const args = canonicalLineage(lineage) as unknown as Record<string, unknown>;
  const argsDigest = sha256(canonicalJson(args));
  return {
    subject: `Authorize exact disabled read pilot ${lineage.workflowId} / ${lineage.nodeId}`,
    tool: WORKFLOW_READ_PILOT_APPROVAL_TOOL,
    args,
    resumeKey: `automation-pilot:v1:${argsDigest}`,
  };
}

export function createWorkflowReadPilotAdmissionDraft(input: {
  lineage: WorkflowReadPilotLineageV1;
  oneShotActivationAuthorization: OneShotActivationAuthorization;
}): WorkflowReadPilotAdmissionDraftV1 {
  canonicalJson(input.oneShotActivationAuthorization);
  const request = workflowReadPilotApprovalRequest(input.lineage);
  if (input.oneShotActivationAuthorization.resumeKey !== request.resumeKey) {
    throw new Error('pilot authorization resume key does not bind the exact preview lineage');
  }
  if (
    !exactId(input.oneShotActivationAuthorization.approvalId)
    || !exactDigest(input.oneShotActivationAuthorization.decisionDigest)
  ) throw new Error('pilot one-shot authorization is invalid');
  return {
    ...canonicalLineage(input.lineage),
    oneShotActivationAuthorization: { ...input.oneShotActivationAuthorization },
  };
}

function admissionDigest(input: Omit<WorkflowReadPilotAdmissionV1, 'admissionDigest'>): string {
  return sha256(canonicalJson(input));
}

export function workflowReadPilotApprovalMatches(
  approval: PendingApprovalRow | null | undefined,
  admission: WorkflowReadPilotAdmissionDraftV1,
  options: { allowConsumed?: boolean } = {},
): boolean {
  try {
    if (!approval) return false;
    canonicalJson(approval);
    canonicalJson(admission);
    const request = workflowReadPilotApprovalRequest(admission);
    const exact = approval.approvalId === admission.oneShotActivationAuthorization.approvalId
      && approval.status === 'resolved'
      && approval.resolution === 'approved'
      && approval.resumeKey === request.resumeKey
      && approval.subject === request.subject
      && approval.tool === request.tool
      && canonicalJson(approval.args) === canonicalJson(request.args)
      && (approval.consumedAt === null || options.allowConsumed === true);
    if (!exact || !approval.resumeKey || !approval.resolver || !approval.resolvedAt) return false;
    return oneShotActivationAuthorizationDecisionDigest({
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
    }) === admission.oneShotActivationAuthorization.decisionDigest;
  } catch {
    return false;
  }
}

export function workflowReadPilotTriggerReceiptId(
  draft: WorkflowReadPilotAdmissionDraftV1,
): string {
  canonicalJson(draft);
  if (!lineageValid(draft)) throw new Error('workflow read pilot lineage is invalid');
  return `automation-pilot:v1:${sha256(canonicalJson({
    lineage: canonicalLineage(draft),
    approvalId: draft.oneShotActivationAuthorization.approvalId,
    decisionDigest: draft.oneShotActivationAuthorization.decisionDigest,
  }))}`;
}

export function bindWorkflowReadPilotAdmission(input: {
  draft: WorkflowReadPilotAdmissionDraftV1;
  runId: string;
  snapshot: WorkflowRunDefinitionSnapshot;
  approval?: PendingApprovalRow | null;
  /** Queue admission requires an unused grant. Runtime restart resolution may
   * accept the same exact row after v51 consumed it; v51 still requires the
   * matching durable activation before it will replay a closed call. */
  allowConsumedApproval?: boolean;
}): WorkflowReadPilotAdmissionResolution {
  const draft = input.draft;
  try {
    canonicalJson(draft);
    canonicalJson(input.snapshot);
    if (input.approval !== undefined) canonicalJson(input.approval);
  } catch {
    return { ok: false, reason: 'pilot admission contains bytes outside the bounded plain-JSON contract' };
  }
  if (!lineageValid(draft) || !exactId(input.runId)) {
    return { ok: false, reason: 'pilot admission identity is invalid' };
  }
  let request: WorkflowReadPilotApprovalRequestV1;
  try {
    request = workflowReadPilotApprovalRequest(draft);
  } catch {
    return { ok: false, reason: 'pilot approval request lineage is invalid' };
  }
  if (
    !exactId(draft.oneShotActivationAuthorization?.approvalId)
    || !exactDigest(draft.oneShotActivationAuthorization?.decisionDigest)
    || draft.oneShotActivationAuthorization.resumeKey !== request.resumeKey
  ) return { ok: false, reason: 'pilot one-shot authorization does not bind this lineage' };
  if (input.approval !== undefined && !workflowReadPilotApprovalMatches(
    input.approval,
    draft,
    { allowConsumed: input.allowConsumedApproval },
  )) {
    return { ok: false, reason: 'canonical approval row does not match the exact pilot preview' };
  }
  if (
    input.snapshot.workflowSlug !== draft.workflowId
    || input.snapshot.definitionHash !== draft.workflowDigest
    || workflowDefinitionHash(input.snapshot.definition) !== draft.workflowDigest
    || input.snapshot.definition.enabled !== false
    || canonicalJson(input.snapshot.definition.trigger) !== '{"manual":true}'
    || (input.snapshot.definition.allowedTools?.length ?? 0) !== 0
    || input.snapshot.definition.synthesis !== undefined
    || input.snapshot.definition.steps.length !== 1
  ) return { ok: false, reason: 'admitted workflow snapshot does not match the disabled one-read pilot' };
  const step = input.snapshot.definition.steps[0];
  if (
    step.id !== draft.nodeId
    || step.sideEffect !== 'read'
    || step.call !== undefined
    || step.deterministic !== undefined
    || step.subgraph !== undefined
    || step.forEach !== undefined
    || step.loopUntil !== undefined
    || step.requiresApproval === true
    || (step.allowedTools?.length ?? 0) !== 0
    || !step.invocationPlan
  ) return { ok: false, reason: 'pilot node is not an exact plan-only read' };
  const parsed = parseWorkflowNodeInvocationPlan(step.invocationPlan);
  if (
    !parsed.ok
    || parsed.plan.bindingDigest !== draft.invocationPlanDigest
    || parsed.plan.binding.effect !== 'read'
    || canonicalJson(parsed.plan.resultProjection ?? null)
      !== canonicalJson(draft.resultProjection ?? null)
    || (
      parsed.plan.continuation.kind === 'cursor'
      && parsed.plan.completeness.kind !== 'finite_exhaustive'
    )
  ) return { ok: false, reason: 'pilot invocation plan is invalid, drifted, or lacks exact continuation completeness' };

  const withoutDigest: Omit<WorkflowReadPilotAdmissionV1, 'admissionDigest'> = {
    ...canonicalLineage(draft),
    oneShotActivationAuthorization: { ...draft.oneShotActivationAuthorization },
    runId: input.runId,
  };
  return {
    ok: true,
    admission: {
      ...withoutDigest,
      admissionDigest: admissionDigest(withoutDigest),
    },
  };
}

export function resolveWorkflowReadPilotAdmission(input: {
  value: unknown;
  runId: string;
  snapshot: WorkflowRunDefinitionSnapshot;
  approval?: PendingApprovalRow | null;
  allowConsumedApproval?: boolean;
}): WorkflowReadPilotAdmissionResolution {
  if (!input.value || typeof input.value !== 'object' || Array.isArray(input.value)) {
    return { ok: false, reason: 'pilot admission is missing or malformed' };
  }
  const candidate = input.value as Partial<WorkflowReadPilotAdmissionV1>;
  const resolved = bindWorkflowReadPilotAdmission({
    draft: candidate as WorkflowReadPilotAdmissionDraftV1,
    runId: input.runId,
    snapshot: input.snapshot,
    ...(input.approval !== undefined ? { approval: input.approval } : {}),
    ...(input.allowConsumedApproval !== undefined
      ? { allowConsumedApproval: input.allowConsumedApproval }
      : {}),
  });
  if (!resolved.ok) return resolved;
  if (
    candidate.runId !== input.runId
    || candidate.admissionDigest !== resolved.admission.admissionDigest
    || canonicalJson(candidate) !== canonicalJson(resolved.admission)
  ) return { ok: false, reason: 'pilot admission bytes or digest do not match their canonical contract' };
  return resolved;
}
