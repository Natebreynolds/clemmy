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
  type PendingActionExecutionClaim,
  type PendingActionRecord,
} from '../runtime/harness/pending-actions.js';
import { dispatchBatchItemTool } from '../tools/code-mode-tool.js';
import { ToolCallsCounter } from '../runtime/harness/brackets.js';
import { detectStructuredToolFailure } from '../runtime/harness/tool-error-corrective.js';
import { pendingActionRequiresHumanApproval } from '../runtime/harness/pending-action-policy.js';

export interface ExecuteApprovedResult {
  ok: boolean;
  status: 'executed' | 'failed' | 'skipped';
  resultSummary: string;
  record: PendingActionRecord | null;
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
) => Promise<unknown>;

const defaultDispatch: ApprovedCallDispatch = (toolName, payload, sessionId, certifiedBatch) =>
  dispatchBatchItemTool(toolName, payload, sessionId, new ToolCallsCounter(50), certifiedBatch);

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
  };
}

export async function executeApprovedPendingActionCall(
  id: string,
  opts: { sessionId?: string; dispatch?: ApprovedCallDispatch } = {},
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
  if (record.status !== 'approved') {
    return skippedClaimResult(id, { claimed: false, reason: 'not_approved', record });
  }
  // GRANT INVARIANT I1 (Phase 1): irreversible sends execute only on HUMAN
  // consent — a policy-minted approval is inert at every executor.
  if (pendingActionRequiresHumanApproval(record) && record.approvedBy !== 'human') {
    return {
      ok: false,
      status: 'skipped',
      resultSummary: `Pending action ${id} is an irreversible send approved by POLICY, not the user — it requires their explicit approval card before execution.`,
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
      requireResolvedHumanCard: pendingActionRequiresHumanApproval(record),
    });
  } catch {
    // If durable claim storage itself is unavailable, the only safe choice is
    // zero dispatch. Treat the boundary as uncertain instead of throwing or
    // falling back to an unclaimed provider call.
    claim = {
      claimed: false,
      reason: 'claim_in_progress_or_uncertain',
      record: getPendingAction(id),
    };
  }
  if (!claim.claimed || !claim.record || !claim.claimToken) return skippedClaimResult(id, claim);
  const claimedRecord = claim.record;
  const claimToken = claim.claimToken;
  const sessionId = opts.sessionId ?? claimedRecord.sessionId ?? '';
  const dispatch = opts.dispatch ?? defaultDispatch;
  try {
    const out = await dispatch(claimedRecord.toolName, claimedRecord.payload, sessionId, {
      batchId: claimedRecord.id,
      payloadHash: claimedRecord.payloadHash,
    });
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
        `Dispatch returned refusal-shaped text after the execution claim began; provider outcome is uncertain and no retry is safe: ${reason}`.slice(0, 4000),
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
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof PendingActionPreDispatchError) {
      const updated = recordPendingActionResult(
        claimedRecord.id,
        'failed',
        `Dispatch was refused locally before the provider call started: ${msg}`.slice(0, 4000),
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
    const uncertain = `Execution attempt failed or became uncertain after dispatch began: ${msg}. Do not retry automatically.`;
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
