import { createHash } from 'node:crypto';
import path from 'node:path';

import { readWorkflow } from '../memory/workflow-store.js';
import {
  registerResumableApprovalCardAtomically,
  type AtomicResumableApprovalCardResult,
} from '../runtime/harness/approval-card.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { createSession, getSession } from '../runtime/harness/eventlog.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import { loadCanonicalEntityWorkflowLineageReceipt } from '../spaces/canonical-entity-workflow-lineage-store.js';
import { finalizeCanonicalEntityWorkflowCompletion } from '../spaces/canonical-entity-workflow-finalizer.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import {
  automationRecurrenceAuthoritySnapshotFromPreview,
  projectCurrentAutomationPilotAuthority,
} from './automation-recurrence-live-authority.js';
import {
  AUTOMATION_RECURRENCE_CONSENT_TOOL,
  bindAutomationRecurrenceConsentApproval,
  createAutomationRecurrenceConsentRequest,
  createAutomationRecurrencePilotSuccessEvidence,
  createAutomationRecurrencePreview,
  getAutomationRecurrenceActivationContract,
  listAutomationRecurrenceActivationsForReconciliation,
  reconcileAutomationRecurrenceActivation,
  registerAutomationRecurrenceActivation,
  type AutomationRecurrenceActivationStateV1,
  type AutomationRecurrenceCadenceV1,
  type AutomationRecurrencePilotSuccessEvidenceV1,
  type AutomationRecurrencePreviewV1,
} from './automation-recurrence-control-plane.js';
import { auditWorkflowRunSettlementTruth, type QueuedRunRecord } from './workflow-runner.js';
import {
  resolveWorkflowRunDefinitionSnapshot,
  type WorkflowRunDefinitionSnapshot,
} from './workflow-run-definition.js';
import { readWorkflowRunRecord } from './workflow-run-record.js';
import { resolveWorkflowReadPilotAdmission } from './workflow-read-pilot-admission.js';
import { compareAndSwapWorkflowDefinition } from './workflow-write.js';

const DIGEST_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;

function canonicalJson(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 40,
    maxNodes: 40_000,
    maxStringBytes: 96_000,
    maxTotalBytes: 768_000,
  });
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function exactId(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && ID_RE.test(value);
}

export type ProjectAutomationRecurrencePilotSuccessResultV1 =
  | {
      ok: true;
      evidence: AutomationRecurrencePilotSuccessEvidenceV1;
      sourceDefinition: WorkflowRunDefinitionSnapshot['definition'];
      workflowInputs: Record<string, string>;
    }
  | { ok: false; code: string; reason: string };

/**
 * Convert one already-terminal pilot into immutable recurrence evidence using
 * only durable admission, settlement, lineage, coverage, and projection facts.
 * Provider result bodies and user-facing prose are never consulted.
 */
export function projectAutomationRecurrencePilotSuccess(
  runId: string,
): ProjectAutomationRecurrencePilotSuccessResultV1 {
  if (!exactId(runId)) return { ok: false, code: 'run_identity_invalid', reason: 'Pilot run identity is invalid.' };
  let run: QueuedRunRecord | null;
  try {
    run = readWorkflowRunRecord<QueuedRunRecord>(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`));
  } catch {
    run = null;
  }
  if (!run || run.id !== runId) return { ok: false, code: 'run_missing', reason: 'Pilot run record is missing or unreadable.' };
  if (
    run.source !== 'automation_pilot'
    || run.acceptDisabled !== true
    || run.status !== 'completed'
    || run.terminalOutcome !== 'succeeded'
    || run.needsAttention === true
    || run.goalOutcome !== 'satisfied'
    || typeof run.finishedAt !== 'string'
    || !run.triggerReceiptId
  ) return { ok: false, code: 'pilot_not_successful', reason: 'Pilot has no exact clean, goal-satisfied terminal success.' };

  const authority = projectCurrentAutomationPilotAuthority(runId);
  if (!authority.ok) return authority;
  if (!authority.preview) {
    return { ok: false, code: 'pilot_compilation_drift', reason: 'Pilot preview is unavailable.' };
  }
  const admitted = resolveWorkflowRunDefinitionSnapshot(run.workflowDefinitionSnapshot);
  if (admitted.status !== 'valid' || admitted.snapshot.version !== 1) {
    return { ok: false, code: 'pilot_snapshot_invalid', reason: 'Pilot run has no exact catalog definition snapshot.' };
  }
  const snapshot = admitted.snapshot;
  const candidate = run.workflowReadPilotAdmission as {
    oneShotActivationAuthorization?: { approvalId?: unknown; decisionDigest?: unknown };
  } | undefined;
  const approvalId = candidate?.oneShotActivationAuthorization?.approvalId;
  const approval = typeof approvalId === 'string' ? approvalRegistry.get(approvalId) : undefined;
  const admission = resolveWorkflowReadPilotAdmission({
    value: run.workflowReadPilotAdmission,
    runId,
    snapshot,
    approval,
    allowConsumedApproval: true,
  });
  if (
    !admission.ok
    || authority.projection.approvalId !== approvalId
    || authority.projection.runId !== runId
    || authority.projection.triggerReceiptId !== run.triggerReceiptId
    || admission.admission.workflowDigest !== snapshot.definitionHash
  ) return { ok: false, code: 'pilot_admission_invalid', reason: 'Pilot projection, approval, trigger, and run admission do not share exact lineage.' };

  const settlement = auditWorkflowRunSettlementTruth(runId);
  if (!settlement.clean) {
    return { ok: false, code: 'pilot_settlement_unclean', reason: settlement.reasons.join('; ').slice(0, 1_000) };
  }
  const finalized = finalizeCanonicalEntityWorkflowCompletion({
    version: 1,
    runId,
    workflowId: admission.admission.workflowId,
    status: run.status,
    terminalOutcome: run.terminalOutcome,
    finishedAt: run.finishedAt,
    needsAttention: run.needsAttention,
    claim: run.canonicalEntityWorkspaceProjectionClaim,
  });
  if (
    finalized.status !== 'projected'
    && finalized.status !== 'replayed'
  ) return { ok: false, code: 'pilot_projection_not_closed', reason: `Pilot canonical projection is ${finalized.status}.` };
  if (
    !finalized.coverage.complete
    || finalized.coverage.status !== 'complete'
    || finalized.coverage.exhaustion !== 'exhausted'
  ) return { ok: false, code: 'pilot_projection_not_closed', reason: 'Pilot canonical projection is partial, unknown, or not exhausted.' };

  const claim = run.canonicalEntityWorkspaceProjectionClaim as { receiptId?: unknown; receiptDigest?: unknown } | undefined;
  const lineageReceipt = typeof claim?.receiptId === 'string'
    ? loadCanonicalEntityWorkflowLineageReceipt(claim.receiptId)
    : null;
  const acceptedSourceCount = lineageReceipt
    ? Math.max(finalized.records.observationsCommitted, lineageReceipt.request.batchLineage.length)
    : 0;
  if (
    !lineageReceipt
    || lineageReceipt.receiptDigest !== claim?.receiptDigest
    || lineageReceipt.request.identity.runId !== runId
    || acceptedSourceCount < 1
  ) return { ok: false, code: 'pilot_result_authority_invalid', reason: 'Pilot has no non-vacuous exact closed lineage receipt.' };

  const selected = [...authority.compilation.proposal.opportunity.pilot.successCriterionIds].sort();
  if (selected.length < 1) return { ok: false, code: 'pilot_criteria_missing', reason: 'Reviewed pilot selected no success criteria.' };
  const terminalReceiptDigest = sha256({
    domain: 'automation-recurrence-pilot-terminal',
    version: 1,
    runId,
    status: run.status,
    terminalOutcome: run.terminalOutcome,
    goalOutcome: run.goalOutcome,
    finishedAt: run.finishedAt,
    claimReceiptDigest: lineageReceipt.receiptDigest,
  });
  const settlementReceiptDigest = sha256({
    domain: 'automation-recurrence-pilot-settlement',
    version: 1,
    runId,
    clean: true,
    reasons: [],
  });
  const triggerReceiptDigest = sha256({
    domain: 'automation-recurrence-pilot-trigger',
    version: 1,
    triggerReceiptId: run.triggerReceiptId,
    runId,
  });
  try {
    const evidence = createAutomationRecurrencePilotSuccessEvidence({
      version: 1,
      proposalId: admission.admission.proposalId,
      proposalRevision: admission.admission.proposalRevision,
      proposalDigest: admission.admission.proposalDigest,
      workflowId: admission.admission.workflowId,
      workflowRevision: admission.admission.workflowRevision,
      workflowDigest: admission.admission.workflowDigest,
      nodeId: admission.admission.nodeId,
      invocationPlanDigest: admission.admission.invocationPlanDigest,
      workflowInputs: authority.workflowInputs,
      workflowInputsDigest: sha256(authority.workflowInputs),
      pilotCompilationDigest: admission.admission.compilationDigest,
      pilotAuthorizationRef: admission.admission.oneShotActivationAuthorization.approvalId,
      pilotAuthorizationDigest: admission.admission.oneShotActivationAuthorization.decisionDigest,
      runId,
      runOccurrenceId: admission.admission.runOccurrenceId,
      triggerReceiptId: run.triggerReceiptId,
      triggerReceiptDigest,
      terminalReceiptId: `workflow-terminal:v1:${terminalReceiptDigest}`,
      terminalReceiptDigest,
      status: 'completed',
      terminalOutcome: 'succeeded',
      needsAttention: false,
      finishedAt: run.finishedAt,
      resultAuthority: {
        version: 1,
        kind: 'closed_read',
        receiptId: lineageReceipt.receiptId,
        receiptDigest: lineageReceipt.receiptDigest,
        acceptedSourceCount,
      },
      projectionAuthority: {
        version: 1,
        receiptId: `workspace-projection:v1:${finalized.projectionDigest}`,
        receiptDigest: finalized.projectionDigest,
        coverage: 'closed',
      },
      settlement: {
        version: 1,
        clean: true,
        receiptId: `workflow-settlement:v1:${settlementReceiptDigest}`,
        receiptDigest: settlementReceiptDigest,
        reasons: [],
      },
      selectedSuccessCriterionIds: selected,
      criterionEvidence: selected.map((criterionId) => ({
        criterionId,
        outcome: 'met' as const,
        evidenceRef: `workflow-terminal:v1:${terminalReceiptDigest}`,
        evidenceDigest: terminalReceiptDigest,
      })),
      authoritySnapshot: automationRecurrenceAuthoritySnapshotFromPreview(authority.preview),
      ...(admission.admission.workspaceBinding
        ? { workspaceBinding: admission.admission.workspaceBinding }
        : {}),
    });
    return {
      ok: true,
      evidence,
      sourceDefinition: snapshot.definition,
      workflowInputs: authority.workflowInputs,
    };
  } catch (error) {
    return { ok: false, code: 'pilot_success_projection_failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

export type RequestAutomationRecurrenceActivationResultV1 =
  | {
      ok: true;
      activation: AutomationRecurrenceActivationStateV1;
      preview: AutomationRecurrencePreviewV1;
      approval: approvalRegistry.PendingApprovalRow;
      approvalCreated: boolean;
      cardCreated: boolean;
    }
  | { ok: false; code: string; reason: string };

function registerAndBindConsentCard(activationId: string):
  | { ok: true; card: AtomicResumableApprovalCardResult; activation: AutomationRecurrenceActivationStateV1 }
  | { ok: false; code: string; reason: string } {
  const contract = getAutomationRecurrenceActivationContract(activationId);
  if (!contract) return { ok: false, code: 'activation_missing', reason: 'Recurrence activation contract is missing.' };
  const request = contract.consentRequest;
  let card: AtomicResumableApprovalCardResult;
  try {
    card = registerResumableApprovalCardAtomically({
      sessionId: request.approvalSessionId,
      subject: request.subject,
      tool: request.tool,
      args: request.args as unknown as Record<string, unknown>,
      resumeKey: request.resumeKey,
      extra: {
        kind: 'automation_recurrence_consent',
        activationId,
        previewId: contract.preview.previewId,
        workflowId: contract.preview.workflowId,
      },
    });
  } catch (error) {
    return { ok: false, code: 'consent_card_registration_failed', reason: error instanceof Error ? error.message : String(error) };
  }
  const bound = bindAutomationRecurrenceConsentApproval({ activationId, approval: card.row });
  if (!bound.ok) return { ok: false, code: bound.code, reason: bound.reason };
  return { ok: true, card, activation: bound.state };
}

export function requestAutomationRecurrenceActivation(input: {
  pilotRunId: string;
  approvalSessionId: string;
  cadence: AutomationRecurrenceCadenceV1;
  previewedAt?: string;
}): RequestAutomationRecurrenceActivationResultV1 {
  const success = projectAutomationRecurrencePilotSuccess(input.pilotRunId);
  if (!success.ok) return success;
  let preview: AutomationRecurrencePreviewV1;
  try {
    preview = createAutomationRecurrencePreview({
      pilotSuccess: success.evidence,
      workflowSlug: success.evidence.workflowId,
      sourceDefinition: success.sourceDefinition,
      cadence: input.cadence,
      previewedAt: input.previewedAt ?? new Date().toISOString(),
    });
  } catch (error) {
    return { ok: false, code: 'recurrence_preview_failed', reason: error instanceof Error ? error.message : String(error) };
  }
  const request = createAutomationRecurrenceConsentRequest({
    preview,
    approvalSessionId: input.approvalSessionId,
  });
  const registered = registerAutomationRecurrenceActivation({
    pilotSuccess: success.evidence,
    preview,
    consentRequest: request,
  });
  if (!registered.ok) return registered;

  // Persist the reviewed interval configuration while it is still inert. A
  // crash here leaves enabled=false and boot can reconstruct the exact card.
  const configured = compareAndSwapWorkflowDefinition({
    workflowSlug: preview.workflowId,
    expectedDefinitionHashes: [preview.sourceDefinitionHash],
    authorizedDefinition: preview.reviewedDisabledDefinition,
    authorizedDefinitionHash: preview.reviewedDisabledDefinitionHash,
  });
  if (!configured.ok) {
    return { ok: false, code: `recurrence_preview_${configured.status}`, reason: 'The disabled recurrence preview could not be installed by exact CAS.' };
  }
  const linked = registerAndBindConsentCard(registered.state.activationId);
  if (!linked.ok) return linked;
  return {
    ok: true,
    activation: linked.activation,
    preview,
    approval: linked.card.row,
    approvalCreated: linked.card.approvalCreated,
    cardCreated: linked.card.eventCreated,
  };
}

export function ensureAutomationRecurrenceWorkflowSession(
  sessionId: string,
  workflowId: string,
): boolean {
  const existing = getSession(sessionId);
  if (existing) return existing.kind === 'workflow';
  try {
    createSession({
      id: sessionId,
      kind: 'workflow',
      title: `Recurring read ${workflowId}`,
      metadata: { protocol: 'automation_recurrence_v1', workflowId },
    });
    return true;
  } catch {
    return getSession(sessionId)?.kind === 'workflow';
  }
}

export interface ReconcileAutomationRecurrencesResultV1 {
  scanned: number;
  pending: number;
  active: number;
  refused: number;
  repairedCards: number;
  installed: number;
  failed: number;
}

/** Boot/tick convergence across every filesystem/SQLite crash cut. */
export function reconcileAutomationRecurrences(): ReconcileAutomationRecurrencesResultV1 {
  const result: ReconcileAutomationRecurrencesResultV1 = {
    scanned: 0,
    pending: 0,
    active: 0,
    refused: 0,
    repairedCards: 0,
    installed: 0,
    failed: 0,
  };
  for (const initial of listAutomationRecurrenceActivationsForReconciliation()) {
    result.scanned += 1;
    let state = initial;
    let current = readWorkflow(state.workflowId);

    // A vanished or unreadable workflow cannot justify creating a new card.
    // The control plane records the terminal refusal and releases the exact
    // one-live-activation uniqueness claim.
    if (state.status === 'registering' && !current) {
      const reconciled = reconcileAutomationRecurrenceActivation({
        activationId: state.activationId,
        currentDefinition: null,
      });
      if (!reconciled.ok) result.failed += 1;
      else if (reconciled.state === 'refused') result.refused += 1;
      else result.pending += 1;
      continue;
    }

    if (state.status === 'registering') {
      const linked = registerAndBindConsentCard(state.activationId);
      if (!linked.ok) { result.failed += 1; continue; }
      if (linked.card.eventCreated || linked.card.approvalCreated) result.repairedCards += 1;
      state = linked.activation;
      // Close the narrow race where the workflow disappears while the formal
      // card is being materialized. The card is now real, so the branch below
      // keeps it linked until its actual decision or expiry.
      current = readWorkflow(state.workflowId);
    }
    let approval = state.approvalId ? approvalRegistry.get(state.approvalId) : undefined;
    if (approval?.status === 'pending' && approvalRegistry.isExpired(approval)) {
      approvalRegistry.resolve(approval.approvalId, 'expired', 'automation-recurrence-reconciler');
      approval = approvalRegistry.get(approval.approvalId);
    }

    // Do not detach a still-actionable card or invent a cancellation reason.
    // Its real decision/TTL is bounded; the listener or next tick then drives
    // the missing definition through the durable refusal path below.
    if (!current && state.status === 'approval_pending' && approval?.status === 'pending') {
      result.pending += 1;
      continue;
    }

    let reconciled = reconcileAutomationRecurrenceActivation({
      activationId: state.activationId,
      currentDefinition: current?.data ?? null,
      approval,
    });
    if (!reconciled.ok) { result.failed += 1; continue; }
    if (reconciled.state === 'ready_to_install') {
      const installed = compareAndSwapWorkflowDefinition({
        workflowSlug: reconciled.receipt.workflowId,
        ...reconciled.installation,
      });
      if (!installed.ok) { result.failed += 1; continue; }
      if (installed.status === 'installed') result.installed += 1;
      const retained = readWorkflow(reconciled.receipt.workflowId);
      if (!retained) { result.failed += 1; continue; }
      reconciled = reconcileAutomationRecurrenceActivation({
        activationId: state.activationId,
        currentDefinition: retained.data,
        approval,
      });
      if (!reconciled.ok) { result.failed += 1; continue; }
    }
    if (reconciled.state === 'active') result.active += 1;
    else if (reconciled.state === 'refused') result.refused += 1;
    else result.pending += 1;
  }
  return result;
}

let approvalListenerInstalled = false;

/** Best-effort post-decision kick. Boot and scheduler ticks remain the durable
 * recovery authority for a crash before or during this listener. */
export function installAutomationRecurrenceReconciler(): void {
  if (approvalListenerInstalled) return;
  approvalListenerInstalled = true;
  approvalRegistry.onApprovalResolved((row) => {
    if (
      row.tool !== AUTOMATION_RECURRENCE_CONSENT_TOOL
      || !row.resumeKey?.startsWith('automation-recurrence-consent:v1:')
    ) return;
    reconcileAutomationRecurrences();
  });
}

export const automationRecurrenceRuntimeInternalsForTest = {
  authoritySnapshotFromPreview: automationRecurrenceAuthoritySnapshotFromPreview,
  registerAndBindConsentCard,
  digestPattern: DIGEST_RE,
};
