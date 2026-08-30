import { createHash } from 'node:crypto';

import {
  activatePreparedWorkflowNodeCall,
  evaluatePreparedWorkflowNodeCallAutoConsent,
  prepareWorkflowNodeCall,
  type WorkflowNodeCallExecutionIdentityV1,
} from '../execution/workflow-node-invocation-executor.js';
import {
  compileLiveCatalogWorkflowCallPlan,
  exactWorkflowCallIdOrDigest,
} from '../execution/workflow-live-call-compiler.js';
import {
  oneShotActivationAuthorizationDecisionDigest,
  workflowV3DelegatedApprovalContract,
  type OneShotActivationAuthorization,
  type WorkflowV3AutoConsentAuthorizationV1,
  type WorkflowV3DelegatedApprovalContractV1,
  type WorkflowV3DurableCapabilityBinding,
} from '../runtime/harness/accepted-turn-call-authority.js';
import type { InteractiveConsentDecisionV1 } from '../runtime/harness/interactive-consent-policy.js';
import { get as getApproval } from '../runtime/harness/approval-registry.js';
import { createSession, getSession } from '../runtime/harness/eventlog.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import {
  actionApprovalSnapshot,
  verifySpaceActionApprovalAuthority,
} from './space-action-authority.js';
import { workspaceActionLooksOutbound } from './space-action-semantics.js';
import type { SpaceAction } from './store.js';
import type { SpaceSharedDurableComposioAuthority } from './runner.js';
import { getCachedToolSchema } from '../tools/composio-schema-cache.js';

export const SPACE_ACTION_V3_AUTHORIZATION_FIELD = 'workflowV3CallAuthorization';

type SpaceActionV3Preparation = {
  plan: ReturnType<typeof compileLiveCatalogWorkflowCallPlan> extends infer R
    ? R extends { ok: true; plan: infer P } ? P : never
    : never;
  contract: Readonly<WorkflowV3DelegatedApprovalContractV1> | null;
  prepared: Extract<ReturnType<typeof prepareWorkflowNodeCall>, { kind: 'authority_checkpoint' }>;
};

export type PrepareSpaceActionV3Result =
  | { ok: true; value: SpaceActionV3Preparation }
  | {
      ok: false;
      error: string;
      recoverableReason?: 'not-connected' | 'ambiguous-account';
    };

export type AcquireApprovedSpaceActionV3Result =
  | { ok: true; authority: SpaceSharedDurableComposioAuthority }
  | { ok: false; error: string; provenNoDispatch: true };

function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(closedCanonicalJson({ domain, version: 1, value }), 'utf8')
    .digest('hex');
}

function exactIdentity(input: {
  slug: string;
  action: SpaceAction;
  callerArgs: Record<string, unknown>;
  planDigest: string;
  binding: unknown;
  runOccurrenceId: string;
  consentMode: 'human_approval' | 'canonical_auto';
}): WorkflowNodeCallExecutionIdentityV1 {
  const snapshot = actionApprovalSnapshot({ id: input.slug }, input.action);
  const workflowId = exactWorkflowCallIdOrDigest(`workspace-action:${input.slug}`);
  return {
    workflowId,
    workflowRevision: 1,
    workflowDigest: digest('workspace-action-definition', {
      slug: input.slug,
      snapshot,
    }),
    runId: input.runOccurrenceId,
    runOccurrenceId: input.runOccurrenceId,
    nodeId: exactWorkflowCallIdOrDigest(`action:${input.action.id}`),
    nodeAttempt: 1,
    invocationPlanDigest: input.planDigest,
    bindingSnapshotDigest: digest('workspace-action-v3-binding', input.binding),
    controlDigest: digest('workspace-action-v3-control', {
      surface: 'workspace_action',
      slug: input.slug,
      actionId: input.action.id,
      consentMode: input.consentMode,
      callerArgumentDigest: digest('workspace-action-caller-args', input.callerArgs),
    }),
  };
}

function durableBinding(
  prepared: Extract<ReturnType<typeof prepareWorkflowNodeCall>, { kind: 'authority_checkpoint' }>['prepared'],
): WorkflowV3DurableCapabilityBinding {
  return {
    capabilityId: prepared.binding.capabilityId,
    manifestId: prepared.binding.manifestId,
    manifestDigest: prepared.binding.manifestDigest,
    operationId: prepared.binding.operationId,
    operationVersion: prepared.binding.operationVersion,
    schemaDigest: prepared.binding.schemaDigest,
    providerVersion: prepared.binding.providerVersion,
    liveFingerprint: prepared.binding.liveFingerprint,
    accountId: prepared.binding.accountId,
    effect: prepared.binding.effect as WorkflowV3DurableCapabilityBinding['effect'],
    invokePortId: prepared.binding.invokePortId,
    argumentCompiler: { ...prepared.binding.argumentCompiler },
  };
}

/** Compile and revalidate the exact provider-ready action without arming or
 * consuming anything. At approval-request time the placeholder occurrence is
 * intentionally omitted from the returned contract; the registry row id owns
 * that identity after the human resolves the card. */
export function prepareSpaceActionV3Approval(input: {
  slug: string;
  action: SpaceAction;
  callerArgs: Record<string, unknown>;
  runOccurrenceId?: string;
  consentMode?: 'human_approval' | 'canonical_auto';
}): PrepareSpaceActionV3Result {
  const operationId = input.action.composioSlug?.trim() ?? '';
  if (!operationId) return { ok: false, error: 'Workspace action has no Composio operation.' };
  const args = { ...(input.action.argsTemplate ?? {}), ...(input.callerArgs ?? {}) };
  const compiled = compileLiveCatalogWorkflowCallPlan({
    ownerId: input.slug,
    nodeId: input.action.id,
    operationId,
    args,
    expectedEffect: workspaceActionLooksOutbound(input.action) ? 'send' : 'write',
    requirementNamespace: 'workspace-action',
    logicalCapabilityNamespace: 'workspace.action',
  });
  if (!compiled.ok) {
    return {
      ok: false,
      error: compiled.message,
      ...(compiled.recoverable ? { recoverableReason: compiled.reason } : {}),
    };
  }

  const identity = exactIdentity({
    slug: input.slug,
    action: input.action,
    callerArgs: input.callerArgs,
    planDigest: compiled.plan.bindingDigest,
    binding: compiled.plan.binding,
    runOccurrenceId: input.runOccurrenceId ?? 'approval-pending',
    consentMode: input.consentMode ?? 'human_approval',
  });
  const preparation = prepareWorkflowNodeCall({
    plan: compiled.plan,
    identity,
    arguments: { workflowInputs: args, stepOutputs: {} },
  });
  if (preparation.kind === 'blocked') {
    return {
      ok: false,
      error: `${preparation.preparation.block.code}: ${preparation.preparation.block.message}`,
    };
  }
  if (preparation.kind !== 'authority_checkpoint') {
    return {
      ok: false,
      error: `Workspace action resolved to ${preparation.effect} authority instead of a mutation.`,
    };
  }
  if (preparation.effect !== 'local_write' && preparation.effect !== 'external_write') {
    return {
      ok: false,
      error: `Workspace action resolved to unsupported ${preparation.effect} authority.`,
    };
  }

  const contract = (input.consentMode ?? 'human_approval') === 'human_approval'
    ? workflowV3DelegatedApprovalContract({
        activationSessionId: exactWorkflowCallIdOrDigest(`workspace-action:${input.slug}`),
        workflowId: identity.workflowId,
        workflowRevision: identity.workflowRevision,
        workflowDigest: identity.workflowDigest,
        nodeId: identity.nodeId,
        nodeAttempt: identity.nodeAttempt,
        invocationPlanDigest: identity.invocationPlanDigest,
        bindingSnapshotDigest: identity.bindingSnapshotDigest,
        controlDigest: identity.controlDigest,
        requirementId: preparation.prepared.requirementId,
        logicalCapabilityId: preparation.prepared.logicalCapabilityId,
        canonicalArgumentDigest: preparation.prepared.canonicalArgumentDigest,
        sourceArgumentDigest: preparation.prepared.sourceArgumentDigest,
        obligationDigest: preparation.authority.obligation.obligationDigest,
        binding: durableBinding(preparation.prepared),
      })
    : null;
  return { ok: true, value: { plan: compiled.plan, contract, prepared: preparation } };
}

export type EvaluateSpaceActionV3AutoConsentResult =
  | {
      status: 'decided';
      decision: InteractiveConsentDecisionV1;
      preparation: SpaceActionV3Preparation;
      authorization?: WorkflowV3AutoConsentAuthorizationV1;
    }
  | {
      status: 'needs_user';
      need: 'choice' | 'credential';
      message: string;
    }
  | { status: 'conflict'; reason: string };

/** Compile one exact current Workspace action and project it through the same
 * provider-neutral Auto reducer as foreground work_call. Account ambiguity is
 * returned before any approval/card/activation can exist. */
export function evaluateSpaceActionV3AutoConsent(input: {
  slug: string;
  action: SpaceAction;
  callerArgs: Record<string, unknown>;
  runOccurrenceId: string;
}): EvaluateSpaceActionV3AutoConsentResult {
  const prepared = prepareSpaceActionV3Approval({
    ...input,
    consentMode: 'canonical_auto',
  });
  if (!prepared.ok) {
    if (prepared.recoverableReason === 'ambiguous-account') {
      return { status: 'needs_user', need: 'choice', message: prepared.error };
    }
    if (prepared.recoverableReason === 'not-connected') {
      return { status: 'needs_user', need: 'credential', message: prepared.error };
    }
    return { status: 'conflict', reason: prepared.error };
  }
  const operationId = input.action.composioSlug?.trim() ?? '';
  const inputSchema = operationId ? getCachedToolSchema(operationId) : null;
  if (!inputSchema) {
    return {
      status: 'conflict',
      reason: 'the exact current provider input schema is unavailable; refresh capability discovery before retrying',
    };
  }
  const evaluated = evaluatePreparedWorkflowNodeCallAutoConsent({
    sessionId: exactWorkflowCallIdOrDigest(`workspace-action:${input.slug}`),
    prepared: prepared.value.prepared.prepared,
    proof: prepared.value.prepared.proof,
    inputSchema,
  });
  if (evaluated.status !== 'decided') return evaluated;
  return {
    status: 'decided',
    decision: evaluated.decision,
    preparation: prepared.value,
    ...(evaluated.authorization ? { authorization: evaluated.authorization } : {}),
  };
}

function ensureWorkspaceActionActivationSession(
  slug: string,
): { ok: true; sessionId: string } | { ok: false; error: string } {
  const sessionId = exactWorkflowCallIdOrDigest(`workspace-action:${slug}`);
  try {
    const session = getSession(sessionId);
    if (!session) {
      createSession({
        id: sessionId,
        kind: 'workflow',
        title: `Workspace ${slug} actions`,
      });
    } else if (session.kind !== 'workflow') {
      return { ok: false, error: 'Workspace action activation session has a foreign kind.' };
    }
    return { ok: true, sessionId };
  } catch (error) {
    return {
      ok: false,
      error: `Workspace action activation session is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type AcquireAutoSpaceActionV3Result =
  | { ok: true; authority: SpaceSharedDurableComposioAuthority }
  | { ok: false; error: string; provenNoDispatch: true };

/** Arm an already-decided ordinary Workspace call. The authorization object is
 * process-opaque; its durable decision receipt and v3 activation commit in one
 * transaction, then the normal kernel owns dispatch/replay/settlement. */
export function acquireAutoSpaceActionV3Authority(input: {
  slug: string;
  preparation: SpaceActionV3Preparation;
  authorization: WorkflowV3AutoConsentAuthorizationV1;
}): AcquireAutoSpaceActionV3Result {
  const session = ensureWorkspaceActionActivationSession(input.slug);
  if (!session.ok) return { ok: false, error: session.error, provenNoDispatch: true };
  const activated = activatePreparedWorkflowNodeCall({
    sessionId: session.sessionId,
    prepared: input.preparation.prepared.prepared,
    proof: input.preparation.prepared.proof,
    autoConsentAuthorization: input.authorization,
  });
  if ('reason' in activated) {
    return {
      ok: false,
      error: `workflow_v3_call Auto activation ${activated.status}: ${activated.reason}`,
      provenNoDispatch: true,
    };
  }
  return {
    ok: true,
    authority: {
      version: 1,
      kernel: 'workflow_v3_call',
      activationId: activated.activationId,
      invocationPlan: input.preparation.plan,
    },
  };
}

function exactOneShotAuthorization(approvalId: string): OneShotActivationAuthorization | null {
  const row = getApproval(approvalId);
  if (
    !row
    || row.status !== 'resolved'
    || row.resolution !== 'approved'
    || !row.resumeKey
    || !row.resolver
    || !row.resolvedAt
  ) return null;
  try {
    return {
      approvalId: row.approvalId,
      resumeKey: row.resumeKey,
      decisionDigest: oneShotActivationAuthorizationDecisionDigest({
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
      }),
    };
  } catch {
    return null;
  }
}

/**
 * Redeem the already-resolved Workspace card into the one shared v3 kernel.
 * Exact Space snapshot/caller authority is checked before live compilation;
 * catalog/schema/account drift is then caught by comparing the approval-time
 * embedded contract byte-for-byte with a newly prepared provider-ready call.
 */
export function acquireApprovedSpaceActionV3Authority(input: {
  approvalId: string;
  slug: string;
  action: SpaceAction;
  callerArgs: Record<string, unknown>;
}): AcquireApprovedSpaceActionV3Result {
  const verified = verifySpaceActionApprovalAuthority(input);
  if (!verified.ok) {
    return {
      ok: false,
      error: `exact Workspace action approval is invalid: ${verified.error ?? 'authority check failed'}`,
      provenNoDispatch: true,
    };
  }
  const approval = getApproval(input.approvalId);
  const approvedContract = approval?.args?.[SPACE_ACTION_V3_AUTHORIZATION_FIELD];
  if (!approvedContract || typeof approvedContract !== 'object' || Array.isArray(approvedContract)) {
    return {
      ok: false,
      error: 'approval predates exact workflow_v3_call binding; click the Workspace action again.',
      provenNoDispatch: true,
    };
  }
  const current = prepareSpaceActionV3Approval({
    ...input,
    runOccurrenceId: input.approvalId,
  });
  if (!current.ok) {
    return { ok: false, error: current.error, provenNoDispatch: true };
  }
  if (!current.value.contract) {
    return {
      ok: false,
      error: 'approval-time workflow_v3_call contract is missing.',
      provenNoDispatch: true,
    };
  }
  try {
    if (closedCanonicalJson(approvedContract) !== closedCanonicalJson(current.value.contract)) {
      return {
        ok: false,
        error: 'exact provider operation, account, schema, arguments, or action binding changed after approval; click the Workspace action again.',
        provenNoDispatch: true,
      };
    }
  } catch {
    return {
      ok: false,
      error: 'approval contains an invalid workflow_v3_call binding.',
      provenNoDispatch: true,
    };
  }

  const oneShotActivationAuthorization = exactOneShotAuthorization(input.approvalId);
  if (!oneShotActivationAuthorization) {
    return {
      ok: false,
      error: 'resolved Workspace approval cannot be bound to an exact one-shot activation.',
      provenNoDispatch: true,
    };
  }
  const session = ensureWorkspaceActionActivationSession(input.slug);
  if (!session.ok) return { ok: false, error: session.error, provenNoDispatch: true };

  const activated = activatePreparedWorkflowNodeCall({
    sessionId: session.sessionId,
    prepared: current.value.prepared.prepared,
    proof: current.value.prepared.proof,
    oneShotActivationAuthorization,
  });
  if ('reason' in activated) {
    return {
      ok: false,
      error: `workflow_v3_call activation ${activated.status}: ${activated.reason}`,
      provenNoDispatch: true,
    };
  }
  return {
    ok: true,
    authority: {
      version: 1,
      kernel: 'workflow_v3_call',
      activationId: activated.activationId,
      invocationPlan: current.value.plan,
    },
  };
}
