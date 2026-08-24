import {
  createSession,
  getSession,
} from '../runtime/harness/eventlog.js';
import {
  registerResumableApprovalCardAtomically,
  type AtomicResumableApprovalCardResult,
} from '../runtime/harness/approval-card.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { oneShotActivationAuthorizationDecisionDigest } from '../runtime/harness/accepted-turn-call-authority.js';
import { readWorkflow } from '../memory/workflow-store.js';
import {
  missingWorkflowRunInputs,
  normalizeWorkflowRunInputs,
} from './workflow-inputs.js';
import { workflowDefinitionHash } from './workflow-run-definition.js';
import { writeWorkflowAndSyncTriggers } from './workflow-write.js';
import {
  queueWorkflowRun,
  type QueueWorkflowRunResult,
} from '../tools/workflow-run-queue.js';
import {
  designApprovedAutomationWorkflowBridge,
  type AutomationWorkflowBridgeInputV1,
  type AutomationWorkflowBridgeResultV1,
} from './automation-workflow-bridge.js';
import {
  workflowReadPilotApprovalMatches,
  workflowReadPilotTriggerReceiptId,
} from './workflow-read-pilot-admission.js';

/** The mutable activation choice is deliberately absent. Both public entry
 * points below derive preview and pilot activation from canonical state. */
export type AutomationReadPilotCompilationInputV1 = Omit<
  AutomationWorkflowBridgeInputV1,
  'activation'
>;

export type RequestAutomationReadPilotApprovalResult =
  | {
      ok: true;
      bridge: AutomationWorkflowBridgeResultV1;
      approval: AtomicResumableApprovalCardResult;
    }
  | {
      ok: false;
      reason: string;
      bridge?: AutomationWorkflowBridgeResultV1;
    };

export type QueueApprovedAutomationReadPilotResult =
  | {
      ok: true;
      bridge: AutomationWorkflowBridgeResultV1;
      queue: QueueWorkflowRunResult;
    }
  | {
      ok: false;
      reason: string;
      bridge?: AutomationWorkflowBridgeResultV1;
      queue?: QueueWorkflowRunResult;
    };

export type ResolvedApprovedAutomationReadPilotAuthority =
  | {
      ok: true;
      bridge: AutomationWorkflowBridgeResultV1 & {
        preview: NonNullable<AutomationWorkflowBridgeResultV1['preview']>;
        pilotApprovalRequest: NonNullable<AutomationWorkflowBridgeResultV1['pilotApprovalRequest']>;
        pilotAdmission: NonNullable<AutomationWorkflowBridgeResultV1['pilotAdmission']>;
      };
      approval: approvalRegistry.PendingApprovalRow;
      triggerReceiptId: string;
    }
  | {
      ok: false;
      reason: string;
      bridge?: AutomationWorkflowBridgeResultV1;
    };

function previewBridge(
  compilation: AutomationReadPilotCompilationInputV1,
): AutomationWorkflowBridgeResultV1 {
  return designApprovedAutomationWorkflowBridge({
    ...compilation,
    activation: { kind: 'preview', target: 'pilot' },
  });
}

function usablePreview(
  bridge: AutomationWorkflowBridgeResultV1,
): bridge is AutomationWorkflowBridgeResultV1 & {
  preview: NonNullable<AutomationWorkflowBridgeResultV1['preview']>;
  pilotApprovalRequest: NonNullable<AutomationWorkflowBridgeResultV1['pilotApprovalRequest']>;
} {
  return bridge.ok
    && bridge.issues.length === 0
    && bridge.preview?.activation === 'pilot'
    && bridge.preview.workflow.enabled === false
    && bridge.preview.workflow.steps.length === 1
    && bridge.preview.workflow.steps[0].invocationPlan !== undefined
    && bridge.pilotApprovalRequest !== undefined;
}

/**
 * Materialize the user-visible pilot decision only after the inert preview and
 * its exact binding/control bytes exist. The formal row and card are committed
 * in one SQLite transaction; this function never installs or queues a workflow.
 */
export function requestAutomationReadPilotApproval(input: {
  compilation: AutomationReadPilotCompilationInputV1;
  approvalSessionId: string;
}): RequestAutomationReadPilotApprovalResult {
  const bridge = previewBridge(input.compilation);
  if (!usablePreview(bridge)) {
    return {
      ok: false,
      reason: bridge.issues.map((issue) => issue.message).join('; ')
        || 'The exact disabled read pilot preview is not representable.',
      bridge,
    };
  }
  const session = getSession(input.approvalSessionId);
  if (!session || session.kind !== 'chat') {
    return { ok: false, reason: 'Pilot approval requires an existing human chat session.', bridge };
  }
  try {
    const request = bridge.pilotApprovalRequest;
    const approval = registerResumableApprovalCardAtomically({
      sessionId: session.id,
      subject: request.subject,
      tool: request.tool,
      args: request.args,
      resumeKey: request.resumeKey,
      extra: {
        kind: 'automation_read_pilot',
        workflowId: bridge.preview.workflow.name,
        nodeId: bridge.preview.workflow.steps[0].id,
        compilationDigest: bridge.preview.compilationDigest,
      },
    });
    return { ok: true, bridge, approval };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Pilot approval registration failed.',
      bridge,
    };
  }
}

function approvalDecisionDigest(row: approvalRegistry.PendingApprovalRow): string | null {
  if (
    row.status !== 'resolved'
    || row.resolution !== 'approved'
    || !row.resumeKey
    || !row.resolver
    || !row.resolvedAt
  ) return null;
  try {
    return oneShotActivationAuthorizationDecisionDigest({
      approvalId: row.approvalId,
      approvalSessionId: row.sessionId,
      resumeKey: row.resumeKey,
      requestedAt: row.requestedAt,
      expiresAt: row.expiresAt,
      subject: row.subject,
      tool: row.tool,
      args: row.args,
      resolver: row.resolver,
      resolvedAt: row.resolvedAt,
    });
  } catch {
    return null;
  }
}

/**
 * Reconstruct the exact one-shot queue authority from the canonical approval
 * row and the same inert compilation that produced its card. This is pure
 * with respect to workflow installation and queueing. A durable reconciler can
 * therefore persist the returned trigger receipt before calling the mutating
 * queue entry point, then use that receipt to close a lost-response window.
 */
export function resolveApprovedAutomationReadPilotAuthority(input: {
  compilation: AutomationReadPilotCompilationInputV1;
  approvalId: string;
  /** Receipt recovery may inspect the same exact row after ToolKernel consumed
   * its one-shot grant. Fresh queue admission must leave this false. */
  allowConsumed?: boolean;
}): ResolvedApprovedAutomationReadPilotAuthority {
  const preview = previewBridge(input.compilation);
  if (!usablePreview(preview)) {
    return {
      ok: false,
      reason: preview.issues.map((issue) => issue.message).join('; ')
        || 'The exact disabled read pilot preview is not representable.',
      bridge: preview,
    };
  }
  const row = approvalRegistry.get(input.approvalId);
  const decisionDigest = row ? approvalDecisionDigest(row) : null;
  if (
    !row
    || !decisionDigest
    || (!input.allowConsumed && row.consumedAt !== null)
  ) {
    return {
      ok: false,
      reason: 'Pilot approval is missing, unresolved, rejected, or already consumed.',
      bridge: preview,
    };
  }
  const authorized = designApprovedAutomationWorkflowBridge({
    ...input.compilation,
    activation: {
      kind: 'pilot',
      pilot: {
        state: 'authorized',
        proposalRevision: preview.preview.proposal.revision,
        proposalDigest: preview.preview.proposal.digest,
        compilationDigest: preview.preview.compilationDigest,
        bindingSnapshotDigest: preview.preview.bindingSnapshotDigest,
        controlContractDigest: preview.preview.controlContractDigest,
        authorizationRef: row.approvalId,
        authorizationDigest: decisionDigest,
        authorizationResumeKey: row.resumeKey!,
      },
    },
  });
  if (
    !authorized.ok
    || !authorized.preview
    || !authorized.pilotApprovalRequest
    || !authorized.pilotAdmission
  ) {
    return {
      ok: false,
      reason: authorized.issues.map((issue) => issue.message).join('; ')
        || 'The resolved approval did not bind the exact pilot preview.',
      bridge: authorized,
    };
  }
  const request = authorized.pilotApprovalRequest;
  if (
    request.resumeKey !== row.resumeKey
    || request.tool !== row.tool
    || !workflowReadPilotApprovalMatches(
      row,
      authorized.pilotAdmission,
      { allowConsumed: input.allowConsumed },
    )
  ) {
    return {
      ok: false,
      reason: 'Canonical approval bytes do not match the exact disabled pilot preview.',
      bridge: authorized,
    };
  }
  return {
    ok: true,
    bridge: authorized as Extract<
      ResolvedApprovedAutomationReadPilotAuthority,
      { ok: true }
    >['bridge'],
    approval: row,
    triggerReceiptId: workflowReadPilotTriggerReceiptId(authorized.pilotAdmission),
  };
}

function ensureWorkflowSession(sessionId: string, workflowId: string): boolean {
  const existing = getSession(sessionId);
  if (existing) return existing.kind === 'workflow';
  try {
    createSession({
      id: sessionId,
      kind: 'workflow',
      title: `Read pilot ${workflowId}`,
      metadata: { protocol: 'automation_read_pilot_v1', workflowId },
    });
    return true;
  } catch {
    return getSession(sessionId)?.kind === 'workflow';
  }
}

/**
 * Project one resolved formal approval into one deterministic disabled pilot
 * run. No caller-authored authorization bytes are accepted: the decision
 * digest is recomputed from the canonical registry row, the workflow is
 * installed only when absent or byte-identical, and queue admission binds the
 * generated run id plus immutable definition snapshot before it becomes
 * executable. This grants one manual occurrence; it never enables recurrence.
 */
export function queueApprovedAutomationReadPilot(input: {
  compilation: AutomationReadPilotCompilationInputV1;
  approvalId: string;
  workflowInputs: Record<string, string>;
  originSessionId?: string;
}): QueueApprovedAutomationReadPilotResult {
  const authority = resolveApprovedAutomationReadPilotAuthority({
    compilation: input.compilation,
    approvalId: input.approvalId,
  });
  if (!authority.ok) return authority;
  const authorized = authority.bridge;

  const normalizedInputs = normalizeWorkflowRunInputs(input.workflowInputs);
  const missing = missingWorkflowRunInputs(authorized.preview.workflow, normalizedInputs);
  if (missing.length > 0) {
    return { ok: false, reason: `Missing required pilot input${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`, bridge: authorized };
  }

  const workflowId = authorized.preview.workflow.name;
  const current = readWorkflow(workflowId);
  if (current) {
    if (workflowDefinitionHash(current.data) !== authorized.pilotAdmission.workflowDigest) {
      return { ok: false, reason: 'A workflow with this identity exists but its exact disabled preview bytes drifted.', bridge: authorized };
    }
  } else {
    try {
      writeWorkflowAndSyncTriggers(workflowId, authorized.preview.workflow);
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'The exact disabled pilot workflow could not be installed.',
        bridge: authorized,
      };
    }
  }
  const installedWorkflow = readWorkflow(workflowId);
  const installedDigest = installedWorkflow
    ? workflowDefinitionHash(installedWorkflow.data)
    : null;
  if (installedDigest !== authorized.pilotAdmission.workflowDigest) {
    return {
      ok: false,
      reason: `The persisted disabled pilot did not round-trip its reviewed workflow bytes (${installedDigest ?? 'missing'}).`,
      bridge: authorized,
    };
  }
  if (!ensureWorkflowSession(authorized.pilotAdmission.workflowSessionId, workflowId)) {
    return { ok: false, reason: 'The exact pilot workflow session is missing or has a foreign session kind.', bridge: authorized };
  }

  try {
    const queue = queueWorkflowRun(workflowId, normalizedInputs, {
      source: 'automation_pilot',
      workflowSlug: workflowId,
      triggerReceiptId: authority.triggerReceiptId,
      targetStepId: authorized.pilotAdmission.nodeId,
      acceptDisabled: true,
      workflowReadPilotAdmission: authorized.pilotAdmission,
      ...(input.originSessionId ? { originSessionId: input.originSessionId } : {}),
    });
    if (queue.status !== 'queued' && queue.status !== 'duplicate') {
      return { ok: false, reason: queue.message, bridge: authorized, queue };
    }
    return { ok: true, bridge: authorized, queue };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'The exact pilot run could not be queued.',
      bridge: authorized,
    };
  }
}
