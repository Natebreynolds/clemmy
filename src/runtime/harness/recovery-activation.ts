/** Delivery activation and execution source are distinct after an approval.
 * This scope changes checkpoint ownership only, never tool/batch authority. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSession, openEventLog } from './eventlog.js';

export interface RecoveryActivationOwner {
  sourceUserSeq: number;
  attemptId?: string;
  approvalContinuation?: {
    requestSourceUserSeq: number;
    approvalId: string;
    decision: 'approve' | 'approve_with_edits' | 'reject';
  };
}
const scope = new AsyncLocalStorage<{ sessionId: string; owner: RecoveryActivationOwner }>();

export function withRecoveryActivation<T>(sessionId: string, owner: RecoveryActivationOwner, fn: () => T): T {
  return scope.run({ sessionId, owner }, fn);
}

export function recoveryActivationOwner(sessionId: string, owner: RecoveryActivationOwner): RecoveryActivationOwner {
  const active = scope.getStore();
  return active?.sessionId === sessionId
    && active.owner.approvalContinuation?.requestSourceUserSeq === owner.sourceUserSeq
    ? { ...active.owner, ...(owner.attemptId ? { attemptId: owner.attemptId } : {}) }
    : owner;
}

/** Validate the persisted continuation against its accepted control and card.
 * The host still reopens the exact batch and validates every execution receipt. */
export function readApprovalRecoveryActivation(sessionId: string): RecoveryActivationOwner | null {
  const metadata = getSession(sessionId)?.metadata;
  const raw = metadata?.__host_recovery_owner as RecoveryActivationOwner | undefined;
  const blob = metadata?.__host_recovery_state;
  if (typeof blob !== 'string' || !raw || !Object.hasOwn(raw, 'approvalContinuation')) return null;
  const invalid = (): never => { throw new Error('The approval checkpoint continuation does not match its durable owner.'); };
  const link = raw.approvalContinuation;
  if (!raw || !link || !Number.isSafeInteger(raw.sourceUserSeq) || raw.sourceUserSeq <= 0
    || !Number.isSafeInteger(link.requestSourceUserSeq) || link.requestSourceUserSeq <= 0
    || raw.sourceUserSeq <= link.requestSourceUserSeq || typeof link.approvalId !== 'string'
    || !['approve', 'approve_with_edits', 'reject'].includes(link.decision)
    || (raw.attemptId != null && typeof raw.attemptId !== 'string')) return invalid();
  const db = openEventLog();
  const control = db.prepare("SELECT data_json FROM events WHERE session_id = ? AND seq = ? AND type = 'user_input_received'")
    .get(sessionId, raw.sourceUserSeq) as { data_json: string } | undefined;
  const request = db.prepare("SELECT 1 FROM events WHERE session_id = ? AND seq = ? AND type = 'user_input_received'")
    .get(sessionId, link.requestSourceUserSeq);
  const card = db.prepare('SELECT status, resolution FROM pending_approvals WHERE session_id = ? AND approval_id = ?')
    .get(sessionId, link.approvalId) as { status: string; resolution: string } | undefined;
  if (!control || !request || card?.status !== 'resolved'
    || card.resolution !== (link.decision === 'reject' ? 'rejected' : 'approved')) return invalid();
  const data = JSON.parse(control.data_json) as Record<string, unknown>;
  if (data.approvalId !== link.approvalId || data.decision !== link.decision) return invalid();
  const state = JSON.parse(blob) as { sessionId?: string; sourceUserSeq?: number; __clemHostRecovery?: number };
  if (state.__clemHostRecovery !== 1 || state.sessionId !== sessionId || state.sourceUserSeq !== link.requestSourceUserSeq) return invalid();
  return { sourceUserSeq: raw.sourceUserSeq, ...(raw.attemptId ? { attemptId: raw.attemptId } : {}), approvalContinuation: { ...link } };
}
