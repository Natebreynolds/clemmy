import type { PendingApprovalRow } from './approval-registry.js';
import { getPendingAction, type PendingActionRecord } from './pending-actions.js';

export type PendingActionApprovalDecision = 'approve' | 'reject' | 'approve_with_edits';

export type PendingActionApprovalPreflight =
  | { kind: 'none' }
  | { kind: 'ok'; pendingActionId: string; record: PendingActionRecord }
  | { kind: 'error'; status: 404 | 409; reason: string };

/**
 * Establish whether an approval card is the current, exact human-authority
 * backlink for a durable pending action. Surfaces use this before choosing an
 * execution owner: a generic Inbox/Tasks/mobile approval may authorize the
 * action, but must not also resume a serialized SDK run and compete with the
 * pending-action executor.
 */
export function exactPendingActionApprovalPreflight(
  row: PendingApprovalRow,
  decision: PendingActionApprovalDecision,
): PendingActionApprovalPreflight {
  const rawId = row.args?.pendingActionId ?? row.args?.pending_action_id;
  if (typeof rawId !== 'string' || !rawId.trim()) return { kind: 'none' };
  const pendingActionId = rawId.trim();
  const record = getPendingAction(pendingActionId);
  if (!record) {
    return { kind: 'error', status: 404, reason: 'pending action referenced by approval card was not found' };
  }
  if (record.approvalId !== row.approvalId) {
    return {
      kind: 'error',
      status: 409,
      reason: 'approval card is superseded or does not belong to this pending action',
    };
  }
  if (record.sessionId && row.sessionId && record.sessionId !== row.sessionId) {
    return { kind: 'error', status: 409, reason: 'approval card belongs to a different pending-action session' };
  }
  if (decision === 'approve_with_edits') {
    return {
      kind: 'error',
      status: 409,
      reason: 'a queued exact payload cannot be approved with edits; create a fresh pending action and card',
    };
  }
  if (['executing', 'executed', 'failed', 'rejected', 'expired', 'cancelled'].includes(record.status)) {
    return { kind: 'error', status: 409, reason: `pending action is already ${record.status}` };
  }
  return { kind: 'ok', pendingActionId, record };
}
