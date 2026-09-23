/** Durable exclusive ownership for resuming the original workflow parent.
 * Unlike fresh request admission this never creates or supersedes an attempt.
 * A claim alone is not tool/effect authority; the host must fence execution
 * against its lease and revalidate the candidate before each activation.
 */
import { randomUUID } from 'node:crypto';
import { appendEvent, isKillRequested, listEvents, openEventLog } from '../runtime/harness/eventlog.js';
import { readWorkflowParentContinuation, readWorkflowParentContinuationTrigger } from './workflow-origin-completion-review.js';
import type { WorkflowOriginTerminalInput } from './workflow-origin-terminal.js';
import { WORKFLOW_PARENT_LEASE_PREFIX } from '../runtime/harness/workflow-parent-activation.js';

export interface WorkflowParentContinuationLease {
  sessionId: string;
  sourceUserSeq: number;
  attemptId: string;
  ownerId: string;
  expiresAt: string;
  evidenceDigest: string;
  verdictEventId: string;
}

/** A durable requested continuation survives new parent evidence and process
 * death. Reopening it grants no ownership: callers still have to claim the
 * exact unfinished attempt and revalidate its execution lease. */
export function readPendingWorkflowParentContinuation(input: WorkflowOriginTerminalInput, reply: string) {
  const events = listEvents(input.observer.originSessionId, { types: ['workflow_parent_continuation_requested'] });
  for (const event of events.reverse()) {
    if (event.role !== 'system' || event.data.sourceUserSeq !== input.observer.sourceUserSeq
      || typeof event.data.verdictEventId !== 'string' || typeof event.data.evidenceDigest !== 'string') continue;
    const candidate = readWorkflowParentContinuationTrigger(input, reply, {
      verdictEventId: event.data.verdictEventId, evidenceDigest: event.data.evidenceDigest,
    });
    if (candidate && candidate.attemptId === event.data.attemptId
      && candidate.child.sourceGroupId === event.data.sourceGroupId
      && candidate.child.sourceGroupDigest === event.data.sourceGroupDigest) return candidate;
  }
  return null;
}

export function claimWorkflowParentContinuation(
  input: WorkflowOriginTerminalInput,
  reply: string,
  options: { leaseMs: number; nowMs?: number },
) {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || !Number.isFinite(options.leaseMs) || options.leaseMs < 1_000) {
    throw new Error('workflow continuation requires a finite clock and lease of at least 1000ms');
  }
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + options.leaseMs).toISOString();
  const db = openEventLog();
  return db.transaction(() => {
    const pending = readPendingWorkflowParentContinuation(input, reply);
    const candidate = pending ?? readWorkflowParentContinuation(input, reply);
    if (!candidate) return null;
    const sessionId = candidate.checkpoint.sessionId;
    const sourceUserSeq = candidate.checkpoint.sourceUserSeq;
    const attemptId = candidate.attemptId;
    if (isKillRequested(sessionId, { attemptId })) return null;
    // A unique token per activation also excludes duplicate wake-ups in the
    // same process. An old callback cannot release a successor's lease.
    const ownerId = `${WORKFLOW_PARENT_LEASE_PREFIX}${randomUUID()}`;
    const updated = db.prepare(`UPDATE run_attempts
      SET lease_owner = ?, lease_expires_at = ?
      WHERE session_id = ? AND attempt_id = ? AND source_user_seq = ?
        AND status = 'active' AND finished_at IS NULL
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`)
      .run(ownerId, expiresAt, sessionId, attemptId, sourceUserSeq, now);
    if (updated.changes !== 1) return null;
    if (!pending) appendEvent({ sessionId, turn: 0, role: 'system',
      type: 'workflow_parent_continuation_requested', data: { sourceUserSeq, attemptId,
        sourceGroupId: candidate.child.sourceGroupId,
        sourceGroupDigest: candidate.child.sourceGroupDigest,
        evidenceDigest: candidate.evidenceDigest, verdictEventId: candidate.verdictEventId } });
    const lease: WorkflowParentContinuationLease = { sessionId, sourceUserSeq,
      attemptId, ownerId, expiresAt, evidenceDigest: candidate.evidenceDigest,
      verdictEventId: candidate.verdictEventId };
    return { candidate, lease };
  }).immediate();
}

export function releaseWorkflowParentContinuation(lease: WorkflowParentContinuationLease): boolean {
  const updated = openEventLog().prepare(`UPDATE run_attempts
    SET lease_owner = NULL, lease_expires_at = NULL
    WHERE session_id = ? AND attempt_id = ? AND source_user_seq = ?
      AND lease_owner = ? AND status = 'active' AND finished_at IS NULL`)
    .run(lease.sessionId, lease.attemptId, lease.sourceUserSeq, lease.ownerId);
  return updated.changes === 1;
}

/** Re-open both the evidence and exclusive owner before model/tool work. A
 * retained in-memory candidate is not proof that its child bytes or owner are
 * still current. The host's effect admission must carry this same fence. */
export function readOwnedWorkflowParentContinuation(
  lease: WorkflowParentContinuationLease,
  input: WorkflowOriginTerminalInput,
  reply: string,
  nowMs = Date.now(),
) {
  if (!Number.isFinite(nowMs)) return null;
  const candidate = readWorkflowParentContinuationTrigger(input, reply, lease);
  if (!candidate || candidate.attemptId !== lease.attemptId
    || candidate.evidenceDigest !== lease.evidenceDigest
    || candidate.checkpoint.sessionId !== lease.sessionId
    || candidate.checkpoint.sourceUserSeq !== lease.sourceUserSeq
    || isKillRequested(lease.sessionId, { attemptId: lease.attemptId })) return null;
  const owner = openEventLog().prepare(`SELECT 1 FROM run_attempts
    WHERE session_id = ? AND attempt_id = ? AND source_user_seq = ?
      AND lease_owner = ? AND lease_expires_at > ?
      AND status = 'active' AND finished_at IS NULL`)
    .get(lease.sessionId, lease.attemptId, lease.sourceUserSeq, lease.ownerId,
      new Date(nowMs).toISOString());
  return owner ? candidate : null;
}

export function renewWorkflowParentContinuation(
  lease: WorkflowParentContinuationLease,
  input: WorkflowOriginTerminalInput,
  reply: string,
  options: { leaseMs: number; nowMs?: number },
): boolean {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || !Number.isFinite(options.leaseMs) || options.leaseMs < 1000) return false;
  return openEventLog().transaction(() => {
    if (!readOwnedWorkflowParentContinuation(lease, input, reply, nowMs)) return false;
    const updated = openEventLog().prepare(`UPDATE run_attempts SET lease_expires_at = ?
      WHERE session_id = ? AND attempt_id = ? AND source_user_seq = ?
        AND lease_owner = ? AND status = 'active' AND finished_at IS NULL`)
      .run(new Date(nowMs + options.leaseMs).toISOString(), lease.sessionId,
        lease.attemptId, lease.sourceUserSeq, lease.ownerId);
    return updated.changes === 1;
  }).immediate();
}
