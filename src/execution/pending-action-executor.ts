/**
 * Approved-pending-action executor (P0c). A pending-approval card minted for a
 * judge-couldn't-verify irreversible call (or any single-call pending action)
 * carries the EXACT tool + args. Once the user approves it, THIS fires the stored
 * call server-side — the model can't swap the payload, and it never re-runs the
 * send itself. run_batch plans keep their own executor (run_batch action=execute);
 * this is the minimal single-call equivalent the team lead asked for.
 */
import { getPendingAction, recordPendingActionResult, type PendingActionRecord } from '../runtime/harness/pending-actions.js';
import { dispatchBatchItemTool } from '../tools/code-mode-tool.js';
import { ToolCallsCounter } from '../runtime/harness/brackets.js';

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

export async function executeApprovedPendingActionCall(
  id: string,
  opts: { sessionId?: string; dispatch?: ApprovedCallDispatch } = {},
): Promise<ExecuteApprovedResult> {
  const record = getPendingAction(id);
  if (!record) return { ok: false, status: 'skipped', resultSummary: `No pending action ${id}.`, record: null };
  if (record.status !== 'approved') {
    return { ok: false, status: 'skipped', resultSummary: `Pending action ${id} is ${record.status} — it must be APPROVED before execution.`, record };
  }
  // GRANT INVARIANT I1 (Phase 1): irreversible sends execute only on HUMAN
  // consent — a policy-minted approval is inert at every executor.
  if (record.kind === 'external_send' && record.approvedBy !== 'human') {
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
  const sessionId = opts.sessionId ?? record.sessionId ?? '';
  const dispatch = opts.dispatch ?? defaultDispatch;
  try {
    const out = await dispatch(record.toolName, record.payload, sessionId, {
      batchId: record.id,
      payloadHash: record.payloadHash,
    });
    const preview = (typeof out === 'string' ? out : JSON.stringify(out ?? '')).slice(0, 400);
    const updated = recordPendingActionResult(record.id, 'executed', `Executed the approved ${record.toolName} call. ${preview}`.slice(0, 4000));
    return { ok: true, status: 'executed', resultSummary: `Executed ${record.toolName} for pending action ${record.id}.`, record: updated ?? getPendingAction(id) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const updated = recordPendingActionResult(record.id, 'failed', `Execution failed: ${msg}`.slice(0, 4000));
    return { ok: false, status: 'failed', resultSummary: `Execution of ${record.toolName} failed: ${msg}`, record: updated ?? getPendingAction(id) };
  }
}
