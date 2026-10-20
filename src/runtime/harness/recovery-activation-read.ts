/** Canonical observational activation proof over an explicit read snapshot. */
import type Database from 'better-sqlite3';
import { readConnectionExecutionActivation } from './connection-execution-activation-proof.js';

export interface RecoveryActivationOwner {
  sourceUserSeq: number;
  attemptId?: string;
  approvalContinuation?: {
    requestSourceUserSeq: number;
    approvalId: string;
    decision: 'approve' | 'approve_with_edits' | 'reject';
  };
  connectionContinuation?: {
    requestSourceUserSeq: number;
    requestId: string;
    activationEventId: string;
  };
}
export interface RecoveryActivationReader {
  database(): Database.Database;
  metadata(sessionId: string): Record<string, unknown> | undefined;
}

/** Validate the persisted continuation against its accepted control and card.
 * The host still reopens the exact batch and validates every execution receipt. */
export function readApprovalRecoveryActivationRead(sessionId: string, reader: RecoveryActivationReader): RecoveryActivationOwner | null {
  const metadata = reader.metadata(sessionId);
  const raw = metadata?.__host_recovery_owner as RecoveryActivationOwner | undefined;
  const blob = metadata?.__host_recovery_state;
  if (typeof blob !== 'string' || !raw || !Object.hasOwn(raw, 'approvalContinuation')) return null;
  const invalid = (): never => { throw new Error('The approval checkpoint continuation does not match its durable owner.'); };
  const link = raw.approvalContinuation;
  if (!raw || raw.connectionContinuation || !link || !Number.isSafeInteger(raw.sourceUserSeq) || raw.sourceUserSeq <= 0
    || !Number.isSafeInteger(link.requestSourceUserSeq) || link.requestSourceUserSeq <= 0
    || raw.sourceUserSeq <= link.requestSourceUserSeq || typeof link.approvalId !== 'string'
    || !['approve', 'approve_with_edits', 'reject'].includes(link.decision)
    || (raw.attemptId != null && typeof raw.attemptId !== 'string')) return invalid();
  const db = reader.database();
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

/** Read one connection recovery owner only through its durable control,
 * shared receipt and original pause. Mutable selected-agent settings and
 * today's sign-in state cannot rewrite the execution identity. */
export function readConnectionRecoveryActivationRead(sessionId: string, reader: RecoveryActivationReader): RecoveryActivationOwner | null {
  const metadata = reader.metadata(sessionId);
  const raw = metadata?.__host_recovery_owner as RecoveryActivationOwner | undefined;
  const blob = metadata?.__host_recovery_state;
  if (!raw || !Object.hasOwn(raw, 'connectionContinuation')) return null;
  const invalid = (): never => { throw new Error('The connection checkpoint continuation does not match its durable owner.'); };
  const link = raw.connectionContinuation;
  if (raw.approvalContinuation || !link || !Number.isSafeInteger(raw.sourceUserSeq) || raw.sourceUserSeq <= 0
    || !Number.isSafeInteger(link.requestSourceUserSeq) || link.requestSourceUserSeq <= 0
    || raw.sourceUserSeq <= link.requestSourceUserSeq || typeof link.requestId !== 'string' || !link.requestId
    || typeof link.activationEventId !== 'string' || !link.activationEventId
    || (raw.attemptId != null && (typeof raw.attemptId !== 'string' || !raw.attemptId))) return invalid();
  const db = reader.database();
  const marker = readConnectionExecutionActivation(db, { sessionId, activationEventId: link.activationEventId,
    deliverySourceUserSeq: raw.sourceUserSeq, requestId: link.requestId });
  if (!marker || marker.activation.executionSourceUserSeq !== link.requestSourceUserSeq) return invalid();
  // Adoption removes the blob, but the exact owner remains until terminal
  // delivery. Preserve composition/evidence mapping through that crash window;
  // this record alone still grants no dispatch or permission to reset history.
  if (blob !== undefined) {
    if (typeof blob !== 'string') return invalid();
    const state = JSON.parse(blob) as { sessionId?: string; sourceUserSeq?: number; __clemHostRecovery?: number };
    if (state.__clemHostRecovery !== 1 || state.sessionId !== sessionId || state.sourceUserSeq !== link.requestSourceUserSeq) return invalid();
  }
  if (raw.attemptId && !db.prepare(`SELECT 1 FROM run_attempts
    WHERE session_id = ? AND attempt_id = ? AND source_user_seq = ? AND run_id = ?`)
    .get(sessionId, raw.attemptId, raw.sourceUserSeq, marker.activation.runId)) return invalid();
  return { sourceUserSeq: raw.sourceUserSeq, ...(raw.attemptId ? { attemptId: raw.attemptId } : {}), connectionContinuation: { ...link } };
}

export function readRecoveryActivationRead(sessionId: string, reader: RecoveryActivationReader): RecoveryActivationOwner | null {
  return readConnectionRecoveryActivationRead(sessionId, reader) ?? readApprovalRecoveryActivationRead(sessionId, reader);
}
