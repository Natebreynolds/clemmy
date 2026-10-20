import type { PendingActionResultLookup, PendingActionResultRecord } from './pending-action-result.js';

/** A display invalidation, never an approval, harness event or execution lease. */
export interface ApprovalResultUpdatedEvent {
  kind: 'approval.result_updated'; sessionId: string; approvalId: string;
  pendingActionId: string; payloadHash: string; recordUpdatedAt: string; projectionId: string;
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\s\u0000-\u001f\u007f]/.test(value);
}
export function normalizeApprovalResultUpdatedEvent(value: unknown): ApprovalResultUpdatedEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (event.kind !== 'approval.result_updated'
    || ![event.sessionId, event.approvalId, event.pendingActionId, event.payloadHash, event.projectionId].every(identifier)
    || typeof event.recordUpdatedAt !== 'string' || event.recordUpdatedAt.length > 64
    || !Number.isFinite(Date.parse(event.recordUpdatedAt))) return null;
  return { kind: 'approval.result_updated', sessionId: event.sessionId as string, approvalId: event.approvalId as string,
    pendingActionId: event.pendingActionId as string, payloadHash: event.payloadHash as string,
    recordUpdatedAt: event.recordUpdatedAt, projectionId: event.projectionId as string };
}
/** This exact visible card may read its own update. No latest-head lookup or
 * history scan can substitute for the owner stamped on the original card. */
export function approvalResultUpdateLookup(event: ApprovalResultUpdatedEvent, binding: PendingActionResultLookup | null,
  record?: PendingActionResultRecord): PendingActionResultLookup | null {
  if (!binding || event.sessionId !== binding.sessionId || event.approvalId !== binding.approvalId
    || binding.pendingActionId && event.pendingActionId !== binding.pendingActionId
    || binding.payloadHash && event.payloadHash !== binding.payloadHash
    || binding.recordUpdatedAt && Date.parse(event.recordUpdatedAt) < Date.parse(binding.recordUpdatedAt)) return null;
  if (record && (event.pendingActionId !== record.id || event.approvalId !== record.approvalId || event.payloadHash !== record.payloadHash
    || ['failed', 'rejected', 'expired', 'cancelled'].includes(record.status)
    || record.status === 'executed' && event.recordUpdatedAt !== record.updatedAt)) return null;
  return { sessionId: event.sessionId, approvalId: event.approvalId, pendingActionId: event.pendingActionId,
    payloadHash: event.payloadHash, recordUpdatedAt: event.recordUpdatedAt };
}
export function approvalResultUpdateMatchesRecord(event: ApprovalResultUpdatedEvent, record: PendingActionResultRecord): boolean {
  return record.id === event.pendingActionId && record.approvalId === event.approvalId && record.payloadHash === event.payloadHash
    && record.updatedAt === event.recordUpdatedAt && record.status === 'executed'
    && record.publicResult?.source === 'authored_projection' && record.publicResult.projection?.id === event.projectionId;
}
/** Bounded per mounted card. One automatic read per immutable execution
 * revision, even if the stream repeats it or supplies conflicting IDs. The
 * explicit refresh remains available after a missed signal or failed read. */
export class ApprovalResultUpdateGate {
  private readonly revisions = new Set<string>();
  admit(value: unknown, binding: PendingActionResultLookup | null, record?: PendingActionResultRecord): ApprovalResultUpdatedEvent | null {
    const event = normalizeApprovalResultUpdatedEvent(value);
    if (!event || !approvalResultUpdateLookup(event, binding, record)) return null;
    if (record?.publicResult?.source === 'authored_projection') return null;
    const key = JSON.stringify([event.sessionId, event.approvalId, event.pendingActionId, event.payloadHash, event.recordUpdatedAt]);
    if (this.revisions.has(key) || this.revisions.size >= 8) return null;
    this.revisions.add(key);
    return event;
  }
}
