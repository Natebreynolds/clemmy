/**
 * Approved-pending-action executor (P0c). A pending-approval card minted for a
 * judge-couldn't-verify irreversible call (or any single-call pending action)
 * carries the EXACT tool + args. Once the user approves it, THIS fires the stored
 * call server-side — the model can't swap the payload, and it never re-runs the
 * send itself. run_batch plans keep their own executor (run_batch action=execute);
 * this is the minimal single-call equivalent the team lead asked for.
 */
import {
  claimPendingActionExecution,
  getPendingAction,
  recordPendingActionResult,
  pendingActionResumeLogicalCallId,
  verifyPendingActionResumeExecutionCapability,
  type PendingActionExecutionClaim,
  type PendingActionExecutionCapability,
  type PendingActionRecord,
} from '../runtime/harness/pending-actions.js';
import { dispatchBatchItemTool, isMcpNamespacedTool } from '../tools/inner-dispatch.js';
import { ToolCallsCounter, harnessRunContextStorage, timeoutForTool, withHarnessRunContext } from '../runtime/harness/brackets.js';
import { acceptedTurnCallAuthorityFor } from '../runtime/harness/accepted-turn-call-authority.js';
import { ensureAcceptedTaskResolutionOpenInTransaction, expectedTaskFor } from '../runtime/harness/resolution-ledger.js';
import { activateDispatchLease, revokeDispatchLeaseBeforeRecovery } from '../runtime/harness/dispatch-lease.js';
import { getActiveRunAttempt, getRunAttemptSourceUserEvent, isKillRequested, openEventLog } from '../runtime/harness/eventlog.js';
import { invokeHostToolCall } from '../runtime/harness/host-tool-invocation.js';
import { classifyRuntimeToolEffect, unwrapRuntimeEffectiveToolIdentity } from '../runtime/harness/tool-effect.js';
import { canonicalLogicalToolName } from '../runtime/harness/logical-call-contract.js';
import { detectStructuredToolFailure } from '../runtime/harness/tool-error-corrective.js';
import { pendingActionRequiresHumanApproval } from '../runtime/harness/pending-action-policy.js';
import { ExternalWritePreDispatchError } from '../runtime/harness/external-write-admission.js';
import { verifyPendingComposioExecutionAuthority } from '../tools/pending-action-admission.js';

export interface ExecuteApprovedResult {
  ok: boolean;
  status: 'executed' | 'failed' | 'skipped';
  resultSummary: string;
  record: PendingActionRecord | null;
  /** A pre-provider bookkeeping owner is still live. No execution claim or
   * dispatch began; the exact caller may retry after bounded backoff. */
  retryable?: boolean;
}

/**
 * Fire the exact stored tool call of an APPROVED single-call pending action. The
 * dispatch runs through the gated write boundary with the per-item LLM judges
 * skipped — the human approval IS the verdict, so the failed goal-fidelity judge
 * can't re-mint another card (reuses the certified-batch skip marker). Records
 * the outcome on the pending action. Never throws.
 */
/** Dispatcher seam: fires ONE tool call through the gated write boundary with
 *  the per-item judges skipped (approval IS the verdict). Injectable for tests. */
export type ApprovedCallDispatch = (
  toolName: string,
  payload: unknown,
  sessionId: string,
  certifiedBatch: { batchId: string; payloadHash: string },
  executionCapability: PendingActionExecutionCapability,
) => Promise<unknown>;

const defaultDispatch: ApprovedCallDispatch = (toolName, payload, sessionId, certifiedBatch, executionCapability) =>
  dispatchBatchItemTool(
    toolName,
    payload,
    sessionId,
    new ToolCallsCounter(50),
    certifiedBatch,
    undefined,
    undefined,
    executionCapability,
  );

/** A carrier (call_tool, work_call, the Composio gateway) names one tool and
 * runs another; the effective operation is what its own wrapper books. */
function carriedCall(record: PendingActionRecord): boolean {
  const effective = unwrapRuntimeEffectiveToolIdentity(record.toolName, record.payload).toolName;
  return effective === null || canonicalLogicalToolName(effective) !== canonicalLogicalToolName(record.toolName);
}

/** The no-model approval resume uses the same exact invocation owner as an
 * ordinary host call. Legacy tool/card consumers retain their existing owner;
 * an explicitly accepted resume may never fall back to an unowned dispatch. */
async function dispatchApprovedCall(
  dispatch: ApprovedCallDispatch,
  record: PendingActionRecord,
  sessionId: string,
  capability: PendingActionExecutionCapability,
  acceptedResume: boolean,
): Promise<unknown> {
  if (!acceptedResume) {
    return dispatch(record.toolName, record.payload, sessionId,
      { batchId: record.id, payloadHash: record.payloadHash }, capability);
  }
  const expected = expectedTaskFor(sessionId, capability.sourceUserSeq);
  const effect = classifyRuntimeToolEffect(record.toolName, record.payload).effect;
  const parent = harnessRunContextStorage.getStore();
  const attempt = getActiveRunAttempt(sessionId);
  if (
    expected.status !== 'ok'
    || expected.graph.classification.route !== 'act'
    || effect === 'unknown'
    || expected.graph.effectCeiling === 'none'
    || (expected.graph.effectCeiling !== 'unknown' && expected.graph.effectCeiling !== effect)
    || !attempt
    || getRunAttemptSourceUserEvent(attempt)?.seq !== capability.sourceUserSeq
    || (parent && (parent.sessionId !== sessionId
      || parent.sourceUserSeq !== capability.sourceUserSeq
      || parent.runAttemptId !== attempt.attemptId))
    || !verifyPendingActionResumeExecutionCapability({ capability, sessionId,
      toolName: record.toolName, payload: record.payload })
  ) throw new PendingActionPreDispatchError('The approved action has no exact live graph and attempt owner.');
  let root = acceptedTurnCallAuthorityFor(sessionId, capability.sourceUserSeq);
  // Graph call roots are normally armed by first logical admission. Only
  // after proving this exact executing claim and live attempt may this lane
  // use the same existing resolution transaction to arm its graph root.
  if (root.status === 'missing') {
    const db = openEventLog();
    db.transaction(() => ensureAcceptedTaskResolutionOpenInTransaction(db, expected.expectation)).immediate();
    root = acceptedTurnCallAuthorityFor(sessionId, capability.sourceUserSeq);
  }
  if (root.status !== 'ok' || root.authority.authorityKind !== 'turn_graph') {
    throw new PendingActionPreDispatchError('The approved action does not own an accepted graph call root.');
  }
  const logicalToolCallId = pendingActionResumeLogicalCallId(capability);
  const ownLease = !parent?.dispatchLease;
  const lease = parent?.dispatchLease ?? activateDispatchLease({
    sessionId,
    scopeId: `${attempt.attemptId}::${logicalToolCallId}`,
    runAttemptId: attempt.attemptId,
  });
  try {
    const invoked = await withHarnessRunContext({
      ...parent,
      sessionId,
      sourceUserSeq: capability.sourceUserSeq,
      runAttemptId: attempt.attemptId,
      dispatchLease: lease,
      counter: parent?.counter ?? new ToolCallsCounter(1),
      pendingActionExecution: capability,
    }, () => invokeHostToolCall({
      identity: { sessionId, sourceUserSeq: capability.sourceUserSeq, modelCallId: logicalToolCallId,
        toolName: record.toolName, args: record.payload, ...(parent?.turn ? { turn: parent.turn } : {}) },
      parentLease: lease,
      effect,
      // A plain local tool's crossing is the host's to book. A carried call
      // (its effective operation differs from its name) or an MCP tool books
      // its own crossing under the exact operation: a host-owned crossing
      // there names the carrier and conflicts with that row, or books a
      // second crossing beside the adapter's (live 2026-10-08).
      boundary: isMcpNamespacedTool(record.toolName) || carriedCall(record) ? 'nested_owned' : 'host_owned_local',
      deadlineMs: timeoutForTool(record.toolName),
      callerSignal: parent?.callerCancelSignal,
      isKillRequested: () => isKillRequested(sessionId, { attemptId: attempt.attemptId }),
      pendingActionExecution: capability,
      invoke: () => dispatch(record.toolName, record.payload, sessionId,
        { batchId: record.id, payloadHash: record.payloadHash }, capability),
    }));
    return invoked.value;
  } finally {
    if (ownLease) await revokeDispatchLeaseBeforeRecovery(lease);
  }
}

/** A test's stand-in for the provider dispatch on paths that own their own
 * executor call (an approval resume). Inert in every non-test process. */
let dispatchOverrideForTests: ApprovedCallDispatch | null = null;
export function _setApprovedCallDispatchForTests(dispatch: ApprovedCallDispatch | null): void {
  dispatchOverrideForTests = dispatch;
}

/** The record's own marker for a tool that refused the call in words after
 * the execution claim began: the words reach the owner, the outcome stays
 * uncertain because text alone cannot prove no provider commit. */
export const PENDING_ACTION_TOOL_REFUSAL = 'The tool refused the call after the execution claim began';

/** The record's own marker for a refusal that happened before any provider
 * call: the result summary starts with it. The owner's ending reads it by
 * this constant, never by matching provider prose. */
export const PENDING_ACTION_PRE_DISPATCH_REFUSAL = 'Dispatch was refused locally before the provider call started';
/** The record's marker for an attempt that may have reached the provider
 * before it failed: the outcome is uncertain and never retried on its own. */
export const PENDING_ACTION_DISPATCH_UNCERTAIN = 'Execution attempt failed or became uncertain after dispatch began';

/** Nominal local refusal for dispatcher implementations that can establish the
 * provider thunk was never invoked. Text returned from a dispatch is never
 * upgraded into this type: providers can echo local-looking marker prose after
 * a remote change committed. */
export class PendingActionPreDispatchError extends Error {
  readonly provenNoDispatch = true;

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PendingActionPreDispatchError';
  }
}

/** Pure detection of refusal-shaped RETURN text. This is presentation
 * classification only, not proof of no-dispatch. A matching result is parked as
 * uncertain and remains non-replayable. */
export function dispatchOutputIndicatesRefusal(text: string): boolean {
  const head = (text ?? '').slice(0, 600);
  return /\[provider-dispatch:not-started:/i.test(head)
    || /SEND BLOCKED — standing sender constraint/i.test(head)
    || /Tool call refused by harness/i.test(head)
    || /^\s*ERROR: dispatch blocked/i.test(head);
}

function skippedClaimResult(id: string, claim: PendingActionExecutionClaim): ExecuteApprovedResult {
  const status = claim.record?.status;
  const detail = claim.reason === 'payload_integrity_failed' || claim.reason === 'approval_authority_invalid'
    ? claim.record?.resultSummary
      ?? `Pending action ${id} failed its pre-dispatch authorization integrity check. No provider call was made.`
    : claim.reason === 'session_authority_mismatch'
      ? `Pending action ${id} belongs to a different session and was not executed.`
      : claim.reason === 'pre_provider_transition_in_progress'
        ? `Pending action ${id} has a live pre-provider bookkeeping owner. No provider call began; retry after that exact transition settles.`
      : claim.reason === 'claim_in_progress_or_uncertain' || status === 'executing'
    ? `Pending action ${id} already has an execution claim. It may still be in progress or its outcome may be uncertain — no second dispatch was attempted, and it must not be retried automatically.`
    : status === 'executed'
      ? `Pending action ${id} was already executed — no second dispatch was attempted.`
      : status === 'failed'
        ? `Pending action ${id} already has a failed or uncertain execution result — no automatic retry was attempted.`
        : `Pending action ${id} is ${status ?? 'not available'} — it must be APPROVED before execution.`;
  const integrityFailure = claim.reason === 'payload_integrity_failed'
    || claim.reason === 'approval_authority_invalid';
  return {
    ok: false,
    status: integrityFailure ? 'failed' : 'skipped',
    resultSummary: detail,
    record: claim.record,
    ...(claim.reason === 'pre_provider_transition_in_progress' ? { retryable: true } : {}),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Revalidate route authority inside the pending-action claim lock. This closes
 * every queue producer, including legacy/judge-outage paths: a CLI-default
 * write needs the exact current grant generation, and an SDK social publish
 * still needs a concrete connected account.
 */
function verifyPendingActionExecutionAuthority(record: PendingActionRecord): string | null {
  const authority = record.executionAuthority ?? null;
  if (record.toolName !== 'composio_execute_tool' || !isPlainRecord(record.payload)) {
    return authority
      ? 'A Composio CLI-default capability was attached to a non-Composio action.'
      : null;
  }
  const slug = typeof record.payload.tool_slug === 'string'
    ? record.payload.tool_slug.trim()
    : '';
  const connectedAccountId = typeof record.payload.connected_account_id === 'string'
    ? record.payload.connected_account_id.trim()
    : '';
  let accountAlias: unknown;
  try {
    const parsedArguments = typeof record.payload.arguments === 'string'
      ? JSON.parse(record.payload.arguments) as unknown
      : record.payload.arguments;
    if (isPlainRecord(parsedArguments) && Object.prototype.hasOwnProperty.call(parsedArguments, 'account_alias')) {
      accountAlias = parsedArguments.account_alias;
    }
  } catch { /* payload integrity/canonicalization handles malformed arguments */ }
  return verifyPendingComposioExecutionAuthority({
    toolSlug: slug,
    connectedAccountIds: [connectedAccountId || null],
    accountAliases: [accountAlias],
    executionAuthority: authority,
  });
}

export async function executeApprovedPendingActionCall(
  id: string,
  opts: { sessionId?: string; sourceUserSeq?: number; dispatch?: ApprovedCallDispatch } = {},
): Promise<ExecuteApprovedResult> {
  const record = getPendingAction(id);
  if (!record) return { ok: false, status: 'skipped', resultSummary: `No pending action ${id}.`, record: null };
  if (!opts.sessionId || !record.sessionId || opts.sessionId !== record.sessionId) {
    return {
      ok: false,
      status: 'skipped',
      resultSummary: `Pending action ${id} belongs to a different session and was not executed.`,
      record,
    };
  }
  const conversationEvidence = record.approvalEvidence?.kind === 'conversation'
    ? record.approvalEvidence
    : null;
  if (
    conversationEvidence
    && (
      !Number.isSafeInteger(opts.sourceUserSeq)
      || opts.sourceUserSeq !== conversationEvidence.responseSourceUserSeq
    )
  ) {
    return {
      ok: false,
      status: 'skipped',
      resultSummary: `Pending action ${id} has no exact accepted reply source and was not executed.`,
      record,
    };
  }
  if (record.status !== 'approved') {
    return skippedClaimResult(id, { claimed: false, reason: 'not_approved', record });
  }
  // GRANT INVARIANT I1 (Phase 1): irreversible sends execute only on HUMAN
  // consent — a policy-minted approval is inert at every executor.
  if (pendingActionRequiresHumanApproval(record, { sessionId: record.sessionId }) && record.approvedBy !== 'human') {
    return {
      ok: false,
      status: 'skipped',
      resultSummary: `Pending action ${id} is an irreversible send approved by POLICY, not the user — it requires their explicit human decision before execution.`,
      record,
    };
  }
  if (record.toolName === 'run_batch') {
    return { ok: false, status: 'skipped', resultSummary: `Pending action ${id} is a run_batch plan — execute it via run_batch action=execute.`, record };
  }
  // The synchronous filesystem claim is the single dispatch authority. It
  // consumes APPROVED before any await/provider boundary, so concurrent console,
  // chat, and cross-process callers cannot all observe APPROVED and fire.
  let claim: PendingActionExecutionClaim;
  try {
    claim = claimPendingActionExecution(id, 'pending-action-executor', {
      expectedSessionId: opts.sessionId,
      requireResolvedHumanCard: pendingActionRequiresHumanApproval(record, { sessionId: record.sessionId }),
      verifyExecutionAuthority: verifyPendingActionExecutionAuthority,
    });
  } catch {
    // If durable claim storage itself is unavailable, the only safe choice is
    // zero dispatch. Reread the durable phase: APPROVED means the provider
    // boundary never began and the outer transition is retryable; EXECUTING
    // remains strict/uncertain and can never be replayed automatically.
    const current = getPendingAction(id);
    claim = {
      claimed: false,
      reason: !current
        ? 'not_found'
        : current.status === 'approved'
          ? 'pre_provider_transition_in_progress'
          : current.status === 'executing'
            ? 'claim_in_progress_or_uncertain'
            : 'not_approved',
      record: current,
    };
  }
  if (!claim.claimed || !claim.record || !claim.claimToken) return skippedClaimResult(id, claim);
  const claimedRecord = claim.record;
  const claimToken = claim.claimToken;
  const sessionId = opts.sessionId ?? claimedRecord.sessionId ?? '';
  const dispatch = opts.dispatch ?? dispatchOverrideForTests ?? defaultDispatch;
  try {
    // Legacy records may predate pending_action_queue's carrier rejection.
    // call_tool authority is turn-scoped (reachable/denied sets), so replaying
    // its raw name + args_json later cannot reproduce the approval-time scope.
    // Fail proven-pre-dispatch and require a fresh validated inner-tool record.
    if ((claimedRecord.toolName.split('__').at(-1) ?? claimedRecord.toolName) === 'call_tool') {
      throw new PendingActionPreDispatchError(
        'Stored call_tool carriers cannot be replayed outside their original turn scope. Queue the validated inner tool and exact payload in a new pending action.',
      );
    }
    const out = await dispatchApprovedCall(dispatch, claimedRecord, sessionId, {
      pendingActionId: claimedRecord.id,
      payloadHash: claimedRecord.payloadHash,
      claimToken,
      // A conversational approval names the reply that carried it; a card
      // approved outside any turn settles under the source that queued it.
      sourceUserSeq: opts.sourceUserSeq ?? claimedRecord.sourceUserSeq ?? 0,
    }, opts.sourceUserSeq !== undefined);
    const outText = typeof out === 'string' ? out : JSON.stringify(out ?? '');
    const structuredFailure = detectStructuredToolFailure(outText);
    // A gate/guard refusal commonly comes back as a returned string. It is not
    // safe to call that pre-dispatch solely from its text: the provider may
    // echo the marker after a mutation or a downstream step may fail after a
    // partial commit. Park it as FAILED/uncertain so it is neither a false
    // success nor replay authority.
    if (dispatchOutputIndicatesRefusal(outText)) {
      const reason = outText.slice(0, 400);
      const updated = recordPendingActionResult(
        claimedRecord.id,
        'failed',
        `${PENDING_ACTION_TOOL_REFUSAL}; provider outcome is uncertain and no retry is safe: ${reason}`.slice(0, 4000),
        'pending-action-executor',
        claimToken,
      );
      return {
        ok: false,
        status: 'failed',
        resultSummary: `Dispatch of ${claimedRecord.toolName} returned refusal-shaped text, but text alone cannot prove no provider commit. Outcome is uncertain; no automatic retry is safe. ${reason}`,
        record: updated ?? getPendingAction(id),
      };
    }
    // MCP/Composio providers can return a normal JSON value whose envelope says
    // the operation failed. That is still a terminal provider result, not an
    // exception, and must never earn an EXECUTED receipt (which would suppress
    // the only safe repair path and let the brain narrate a write that did not
    // happen). Do not auto-retry an approved write here; record the truth and let
    // the user/model choose a corrected payload.
    if (structuredFailure.failed) {
      const reason = structuredFailure.summary || 'the provider reported an error';
      const updated = recordPendingActionResult(
        claimedRecord.id,
        'failed',
        `The provider returned a failure after dispatch began for the approved ${claimedRecord.toolName} call; outcome may be partial or uncertain: ${reason}`.slice(0, 4000),
        'pending-action-executor',
        claimToken,
      );
      return {
        ok: false,
        status: 'failed',
        resultSummary: `The provider reported that ${claimedRecord.toolName} failed after dispatch began: ${reason}. It may have partially committed; no automatic retry is safe.`,
        record: updated ?? getPendingAction(id),
      };
    }
    const preview = outText.slice(0, 400);
    const updated = recordPendingActionResult(
      claimedRecord.id,
      'executed',
      `Executed the approved ${claimedRecord.toolName} call. ${preview}`.slice(0, 4000),
      'pending-action-executor',
      claimToken,
    );
    return {
      ok: true,
      status: 'executed',
      resultSummary: [
        `Executed ${claimedRecord.toolName} for pending action ${claimedRecord.id}.`,
        'Authoritative tool result:',
        preview,
        'Outcome is already recorded. Do not call pending_action_get or pending_action_record_result.',
      ].join('\n'),
      record: updated ?? getPendingAction(id),
    };
  } catch (err) {
    // A certified nested dispatcher preserves this nominal in-process type.
    // Map it into the executor's local control-flow error by identity — never
    // by matching provider-visible prose, which could follow a real commit.
    const preDispatchError = err instanceof PendingActionPreDispatchError
      ? err
      : err instanceof ExternalWritePreDispatchError
        ? new PendingActionPreDispatchError(err.message, err)
        : null;
    const msg = preDispatchError?.message
      ?? (err instanceof Error ? err.message : String(err));
    if (preDispatchError) {
      const updated = recordPendingActionResult(
        claimedRecord.id,
        'failed',
        `${PENDING_ACTION_PRE_DISPATCH_REFUSAL}: ${msg}`.slice(0, 4000),
        'pending-action-executor',
        claimToken,
      );
      return {
        ok: false,
        status: 'failed',
        resultSummary: `Dispatch of ${claimedRecord.toolName} was refused locally before the provider call started: ${msg}. No provider commit occurred.`,
        record: updated ?? getPendingAction(id),
      };
    }
    const uncertain = `${PENDING_ACTION_DISPATCH_UNCERTAIN}: ${msg}. Do not retry automatically.`;
    const updated = recordPendingActionResult(
      claimedRecord.id,
      'failed',
      uncertain.slice(0, 4000),
      'pending-action-executor',
      claimToken,
    );
    return {
      ok: false,
      status: 'failed',
      resultSummary: `Execution of ${claimedRecord.toolName} failed or is uncertain: ${msg}. No automatic retry is safe.`,
      record: updated ?? getPendingAction(id),
    };
  }
}
