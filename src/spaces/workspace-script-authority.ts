/** Exact call preparation for saved scripts. No scheduler or UI is enabled by
 * importing this module. A caller must own a durable occurrence and a real
 * approved v3 call; historical runner trust is not execution authority. */
import { createHash } from 'node:crypto';
import { activatePreparedWorkflowNodeCall, prepareWorkflowNodeCall, workflowV3CallConsentRequest } from '../execution/workflow-node-invocation-executor.js';
import { compileLiveCatalogWorkflowCallPlan, exactWorkflowCallIdOrDigest } from '../execution/workflow-live-call-compiler.js';
import { oneShotActivationAuthorizationDecisionDigest } from '../runtime/harness/accepted-turn-call-authority.js';
import { get as getApproval } from '../runtime/harness/approval-registry.js';
import { createSession, getSession } from '../runtime/harness/eventlog.js';
import { ensureReviewedLocalWorkflowCapability } from '../runtime/harness/reviewed-local-workflow-capability.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import { validateWorkspaceScriptArguments } from './workspace-script-carrier.js';
import { WORKSPACE_SCRIPT_OPERATION, workspaceScriptArguments, type WorkspaceScriptArguments } from './workspace-script-contract.js';

const digest = (value: unknown) => createHash('sha256').update(closedCanonicalJson(value)).digest('hex');

export function prepareWorkspaceScriptCall(input: WorkspaceScriptArguments) {
  const args = workspaceScriptArguments.parse(input);
  validateWorkspaceScriptArguments(args);
  const registered = ensureReviewedLocalWorkflowCapability({ operationId: WORKSPACE_SCRIPT_OPERATION, args });
  if (!registered.ok) throw new Error(`Saved script capability is unavailable: ${registered.reason}`);
  const compiled = compileLiveCatalogWorkflowCallPlan({
    ownerId: args.slug, nodeId: args.source_id, operationId: WORKSPACE_SCRIPT_OPERATION,
    args, expectedEffect: 'admin', requirementNamespace: 'workspace-script',
    logicalCapabilityNamespace: 'workspace.script',
  });
  if (!compiled.ok) throw new Error(compiled.message);
  const workflowId = exactWorkflowCallIdOrDigest(`workspace-script:${args.slug}`);
  const sessionId = workflowId;
  const prepared = prepareWorkflowNodeCall({
    plan: compiled.plan,
    identity: {
      workflowId, workflowRevision: 1,
      workflowDigest: digest({ kind: 'saved_source_script', slug: args.slug,
        sourceId: args.source_id, sourceDigest: args.source_digest, scriptDigest: args.script_sha256 }),
      runId: args.occurrence_id, runOccurrenceId: args.occurrence_id,
      nodeId: exactWorkflowCallIdOrDigest(`source:${args.source_id}`), nodeAttempt: 1,
      invocationPlanDigest: compiled.plan.bindingDigest,
      bindingSnapshotDigest: digest(compiled.plan.binding),
      controlDigest: digest({ kind: 'saved_source_script', cause: args.cause, occurrenceId: args.occurrence_id }),
    },
    arguments: { workflowInputs: args, stepOutputs: {} },
  });
  if (prepared.kind !== 'authority_checkpoint' || prepared.effect !== 'admin') {
    throw new Error('Saved script did not prepare an exact execution consent checkpoint.');
  }
  const consent = workflowV3CallConsentRequest({ prepared: prepared.prepared, proof: prepared.proof });
  if (!consent.ok) throw new Error(`Saved script consent is unavailable: ${consent.reason}`);
  return {
    sessionId, args, plan: compiled.plan, prepared,
    // These are the shared kernel's existing one-shot approval bytes. Details
    // shown to the user must include source, schedule and script provenance;
    // a script digest never promises that its dependencies/effects are frozen.
    consent: consent.request,
  };
}

export function activateApprovedWorkspaceScriptCall(input: {
  args: WorkspaceScriptArguments; approvalId: string;
}) {
  const current = prepareWorkspaceScriptCall(input.args);
  const row = getApproval(input.approvalId);
  if (!row || row.status !== 'resolved' || row.resolution !== 'approved'
    || !row.resumeKey || !row.resolver || !row.resolvedAt
    || row.sessionId !== current.sessionId || row.tool !== current.consent.tool
    || row.resumeKey !== current.consent.resumeKey
    || closedCanonicalJson(row.args) !== closedCanonicalJson(current.consent.args)) {
    throw new Error('Saved script lacks approval for this exact source revision and occurrence.');
  }
  if (!getSession(current.sessionId)) createSession({ id: current.sessionId, kind: 'workflow', title: `Workspace ${input.args.slug} script refreshes` });
  const activated = activatePreparedWorkflowNodeCall({
    sessionId: current.sessionId, prepared: current.prepared.prepared, proof: current.prepared.proof,
    oneShotActivationAuthorization: {
      approvalId: row.approvalId, resumeKey: row.resumeKey,
      decisionDigest: oneShotActivationAuthorizationDecisionDigest({
        approvalId: row.approvalId, approvalSessionId: row.sessionId, resumeKey: row.resumeKey,
        requestedAt: row.requestedAt, expiresAt: row.expiresAt, subject: row.subject,
        tool: row.tool, args: row.args, resolver: row.resolver, resolvedAt: row.resolvedAt,
      }),
    },
  });
  if ('reason' in activated) throw new Error(`Saved script activation refused: ${activated.reason}`);
  // Pass the compiler's canonical object verbatim. Re-parsing with Zod orders
  // keys by schema, which would change this kernel's sealed argument bytes.
  return { activationId: activated.activationId, invocationPlan: current.plan,
    args: current.prepared.prepared.canonicalArgs as WorkspaceScriptArguments };
}
