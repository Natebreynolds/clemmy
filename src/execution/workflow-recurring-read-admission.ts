import { createHash } from 'node:crypto';

import { parseWorkflowNodeInvocationPlan } from '../memory/workflow-node-invocation-plan.js';
import {
  parseWorkflowCanonicalEntityResultProjection,
  type WorkflowCanonicalEntityResultProjection,
} from '../memory/workflow-result-projection-contract.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import {
  workflowIntervalDigest,
  workflowIntervalOccurrenceAtMs,
  workflowIntervalOccurrenceId,
} from '../shared/workflow-interval.js';
import {
  parseCanonicalEntityWorkspaceBindingApproval,
  type CanonicalEntityWorkspaceBindingApprovalV1,
} from '../spaces/canonical-entity-workspace-binding-contract.js';
import {
  getAutomationRecurrenceActivation,
  getAutomationRecurrenceActivationReceipt,
  getAutomationRecurrenceActiveAuthority,
  type AutomationRecurrenceActiveAuthorityV1,
  type AutomationRecurrenceAuthoritySnapshotV1,
} from './automation-recurrence-control-plane.js';
import {
  workflowDefinitionHash,
  type WorkflowRunDefinitionSnapshot,
} from './workflow-run-definition.js';

export const WORKFLOW_RECURRING_READ_ADMISSION_VERSION = 1 as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const EXACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;

export interface WorkflowRecurringReadAdmissionV1 {
  version: typeof WORKFLOW_RECURRING_READ_ADMISSION_VERSION;
  activationAuthority: AutomationRecurrenceActiveAuthorityV1;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  pilotSuccessEvidenceId: string;
  pilotSuccessEvidenceDigest: string;
  workflowId: string;
  workflowRevision: number;
  workflowDigest: string;
  workflowInputsDigest: string;
  intervalDigest: string;
  runId: string;
  runOccurrenceId: string;
  occurrenceOrdinal: number;
  occurrenceAt: string;
  nodeId: string;
  nodeAttempt: number;
  invocationPlanDigest: string;
  bindingSnapshotDigest: string;
  controlDigest: string;
  workflowSessionId: string;
  authoritySnapshot: AutomationRecurrenceAuthoritySnapshotV1;
  resultProjection?: WorkflowCanonicalEntityResultProjection;
  workspaceBinding?: CanonicalEntityWorkspaceBindingApprovalV1;
  admissionDigest: string;
}

export type WorkflowRecurringReadAdmissionResolution =
  | { ok: true; admission: WorkflowRecurringReadAdmissionV1 }
  | { ok: false; reason: string };

export interface WorkflowRecurringReadAdmissionDraftV1 {
  activationId: string;
  occurrenceOrdinal: number;
  nodeAttempt: number;
  currentAuthoritySnapshot: AutomationRecurrenceAuthoritySnapshotV1;
}

function canonicalJson(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 32,
    maxNodes: 20_000,
    maxStringBytes: 64_000,
    maxTotalBytes: 512_000,
  });
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Exact scheduler/runner input identity covered by standing consent. */
export function workflowRecurringReadInputsDigest(
  inputs: Record<string, string>,
): string {
  return sha256(canonicalJson(inputs));
}

function exactId(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && EXACT_ID_RE.test(value);
}

function exactDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function exactPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function exactAuthoritySnapshot(
  actual: AutomationRecurrenceAuthoritySnapshotV1,
  expected: AutomationRecurrenceAuthoritySnapshotV1,
): boolean {
  try {
    return actual.version === 1
      && exactDigest(actual.capabilitySnapshotDigest)
      && exactDigest(actual.accountSnapshotDigest)
      && exactDigest(actual.schemaSnapshotDigest)
      && exactDigest(actual.bindingSnapshotDigest)
      && exactDigest(actual.controlContractDigest)
      && (actual.workspaceBindingDigest === undefined || exactDigest(actual.workspaceBindingDigest))
      && canonicalJson(actual) === canonicalJson(expected);
  } catch {
    return false;
  }
}

function sessionId(input: {
  activationId: string;
  receiptDigest: string;
  runOccurrenceId: string;
  nodeId: string;
  nodeAttempt: number;
}): string {
  return `workflow-recurrence:${sha256(canonicalJson({
    domain: 'workflow-recurring-read-session',
    version: 1,
    ...input,
  }))}`;
}

function admissionBody(
  admission: WorkflowRecurringReadAdmissionV1,
): Omit<WorkflowRecurringReadAdmissionV1, 'admissionDigest'> {
  const { admissionDigest: _digest, ...body } = admission;
  return body;
}

function digestAdmission(
  admission: Omit<WorkflowRecurringReadAdmissionV1, 'admissionDigest'>,
): string {
  return sha256(canonicalJson({
    domain: 'workflow-recurring-read-admission',
    version: WORKFLOW_RECURRING_READ_ADMISSION_VERSION,
    admission,
  }));
}

function snapshotIssue(input: {
  snapshot: WorkflowRunDefinitionSnapshot;
  workflowId: string;
  authorizedDefinitionHash: string;
  interval: unknown;
  intervalDigest: string;
  nodeId: string;
  invocationPlanDigest: string;
  resultProjection?: WorkflowCanonicalEntityResultProjection;
  workspaceBinding?: CanonicalEntityWorkspaceBindingApprovalV1;
}): string | null {
  let snapshot: WorkflowRunDefinitionSnapshot;
  try { snapshot = clone(input.snapshot); }
  catch { return 'recurring read snapshot is not bounded plain JSON'; }
  const definition = snapshot.definition;
  if (
    snapshot.version !== 1
    || snapshot.workflowSlug !== input.workflowId
    || snapshot.definitionHash !== input.authorizedDefinitionHash
    || workflowDefinitionHash(definition) !== input.authorizedDefinitionHash
    || definition.name !== input.workflowId
    || definition.enabled !== true
    || canonicalJson(definition.trigger) !== canonicalJson({ interval: input.interval })
    || workflowIntervalDigest(definition.trigger.interval) !== input.intervalDigest
    || (definition.allowedTools?.length ?? 0) !== 0
    || definition.synthesis !== undefined
    || definition.steps.length !== 1
  ) return 'recurring read snapshot does not match the exact consented enabled interval definition';
  const step = definition.steps[0]!;
  if (
    step.id !== input.nodeId
    || step.sideEffect !== 'read'
    || step.call !== undefined
    || step.deterministic !== undefined
    || step.subgraph !== undefined
    || step.forEach !== undefined
    || step.loopUntil !== undefined
    || step.requiresApproval === true
    || (step.allowedTools?.length ?? 0) !== 0
    || !step.invocationPlan
  ) return 'recurring read node is not an exact plan-only read';
  const parsed = parseWorkflowNodeInvocationPlan(step.invocationPlan);
  if (
    !parsed.ok
    || parsed.plan.bindingDigest !== input.invocationPlanDigest
    || parsed.plan.binding.effect !== 'read'
    || canonicalJson(parsed.plan.resultProjection ?? null)
      !== canonicalJson(input.resultProjection ?? null)
    || (parsed.plan.continuation.kind === 'cursor' && parsed.plan.completeness.kind !== 'finite_exhaustive')
  ) return 'recurring read invocation plan is invalid, drifted, or lacks bounded completeness';
  if ((input.resultProjection === undefined) !== (input.workspaceBinding === undefined)) {
    return 'recurring read projection and Workspace binding authority are incomplete';
  }
  if (input.resultProjection !== undefined && !parseWorkflowCanonicalEntityResultProjection(input.resultProjection).ok) {
    return 'recurring read result projection is invalid';
  }
  if (input.workspaceBinding !== undefined) {
    const binding = parseCanonicalEntityWorkspaceBindingApproval(input.workspaceBinding);
    if (!binding.ok || binding.approval.binding.workflowId !== input.workflowId) {
      return 'recurring read Workspace binding is invalid or foreign';
    }
  }
  return null;
}

/**
 * Bind one scheduler-owned interval occurrence to the current immutable
 * standing consent receipt and the exact run definition snapshot. This does
 * not queue or execute anything; scheduler admission and runner resolution use
 * the same function so stale serialized bytes cannot gain authority.
 */
export function createWorkflowRecurringReadAdmission(input: {
  activationId: string;
  runId: string;
  occurrenceOrdinal: number;
  nodeAttempt: number;
  snapshot: WorkflowRunDefinitionSnapshot;
  currentAuthoritySnapshot: AutomationRecurrenceAuthoritySnapshotV1;
}): WorkflowRecurringReadAdmissionResolution {
  if (
    !exactId(input.activationId)
    || !exactId(input.runId)
    || !exactPositiveInteger(input.occurrenceOrdinal)
    || !exactPositiveInteger(input.nodeAttempt)
  ) return { ok: false, reason: 'recurring read occurrence identity is invalid' };
  let activation;
  let receipt;
  let authority;
  try {
    activation = getAutomationRecurrenceActivation(input.activationId);
    receipt = getAutomationRecurrenceActivationReceipt(input.activationId);
    authority = getAutomationRecurrenceActiveAuthority(input.activationId);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'recurrence authority is unreadable' };
  }
  if (
    !activation
    || activation.status !== 'active'
    || !receipt
    || !authority
    || activation.activationReceiptId !== receipt.receiptId
    || activation.activationReceiptDigest !== receipt.receiptDigest
    || authority.activationStateDigest !== activation.stateDigest
  ) return { ok: false, reason: 'recurring read standing activation is not exactly active' };
  if (!exactAuthoritySnapshot(input.currentAuthoritySnapshot, receipt.authoritySnapshot)) {
    return { ok: false, reason: 'recurring read capability, account, schema, binding, or control authority drifted' };
  }
  const issue = snapshotIssue({
    snapshot: input.snapshot,
    workflowId: receipt.workflowId,
    authorizedDefinitionHash: receipt.authorizedEnabledDefinitionHash,
    interval: receipt.interval,
    intervalDigest: receipt.intervalDigest,
    nodeId: receipt.nodeId,
    invocationPlanDigest: receipt.invocationPlanDigest,
    ...(receipt.resultProjection ? { resultProjection: receipt.resultProjection } : {}),
    ...(receipt.workspaceBinding ? { workspaceBinding: receipt.workspaceBinding } : {}),
  });
  if (issue) return { ok: false, reason: issue };
  const occurrenceAtMs = workflowIntervalOccurrenceAtMs(receipt.interval, input.occurrenceOrdinal);
  const runOccurrenceId = workflowIntervalOccurrenceId({
    workflowKey: receipt.workflowId,
    interval: receipt.interval,
    ordinal: input.occurrenceOrdinal,
  });
  const workflowSessionId = sessionId({
    activationId: authority.activationId,
    receiptDigest: receipt.receiptDigest,
    runOccurrenceId,
    nodeId: receipt.nodeId,
    nodeAttempt: input.nodeAttempt,
  });
  const body: Omit<WorkflowRecurringReadAdmissionV1, 'admissionDigest'> = {
    version: WORKFLOW_RECURRING_READ_ADMISSION_VERSION,
    activationAuthority: clone(authority),
    proposalId: receipt.proposalId,
    proposalRevision: receipt.proposalRevision,
    proposalDigest: receipt.proposalDigest,
    pilotSuccessEvidenceId: receipt.pilotSuccessEvidenceId,
    pilotSuccessEvidenceDigest: receipt.pilotSuccessEvidenceDigest,
    workflowId: receipt.workflowId,
    workflowRevision: receipt.workflowRevision,
    workflowDigest: receipt.authorizedEnabledDefinitionHash,
    workflowInputsDigest: receipt.workflowInputsDigest,
    intervalDigest: receipt.intervalDigest,
    runId: input.runId,
    runOccurrenceId,
    occurrenceOrdinal: input.occurrenceOrdinal,
    occurrenceAt: new Date(occurrenceAtMs).toISOString(),
    nodeId: receipt.nodeId,
    nodeAttempt: input.nodeAttempt,
    invocationPlanDigest: receipt.invocationPlanDigest,
    bindingSnapshotDigest: receipt.authoritySnapshot.bindingSnapshotDigest,
    controlDigest: receipt.authoritySnapshot.controlContractDigest,
    workflowSessionId,
    authoritySnapshot: clone(receipt.authoritySnapshot),
    ...(receipt.resultProjection ? { resultProjection: clone(receipt.resultProjection) } : {}),
    ...(receipt.workspaceBinding ? { workspaceBinding: clone(receipt.workspaceBinding) } : {}),
  };
  return {
    ok: true,
    admission: { ...body, admissionDigest: digestAdmission(body) },
  };
}

export function resolveWorkflowRecurringReadAdmission(input: {
  value: unknown;
  runId: string;
  snapshot: WorkflowRunDefinitionSnapshot;
  currentAuthoritySnapshot: AutomationRecurrenceAuthoritySnapshotV1;
}): WorkflowRecurringReadAdmissionResolution {
  let candidate: WorkflowRecurringReadAdmissionV1;
  try { candidate = clone(input.value) as WorkflowRecurringReadAdmissionV1; }
  catch { return { ok: false, reason: 'recurring read admission is missing, malformed, or outside bounded JSON' }; }
  if (
    candidate.version !== WORKFLOW_RECURRING_READ_ADMISSION_VERSION
    || !exactId(candidate.activationAuthority?.activationId)
    || !exactId(candidate.runId)
    || !exactPositiveInteger(candidate.occurrenceOrdinal)
    || !exactPositiveInteger(candidate.nodeAttempt)
    || !exactDigest(candidate.workflowInputsDigest)
    || !exactDigest(candidate.admissionDigest)
  ) return { ok: false, reason: 'recurring read admission identity is invalid' };
  const rebuilt = createWorkflowRecurringReadAdmission({
    activationId: candidate.activationAuthority.activationId,
    runId: input.runId,
    occurrenceOrdinal: candidate.occurrenceOrdinal,
    nodeAttempt: candidate.nodeAttempt,
    snapshot: input.snapshot,
    currentAuthoritySnapshot: input.currentAuthoritySnapshot,
  });
  if (!rebuilt.ok) return rebuilt;
  if (
    candidate.runId !== input.runId
    || canonicalJson(candidate) !== canonicalJson(rebuilt.admission)
    || candidate.admissionDigest !== digestAdmission(admissionBody(candidate))
  ) return { ok: false, reason: 'recurring read admission bytes do not match current standing authority' };
  return rebuilt;
}
