import type { HarnessEvent } from './types.js';

/** Presentation proof supplied only for the host's exact, durable card receipt.
 * It grants no execution, approval, completion, or cancellation authority. */
export interface ApprovalDecisionAck {
  version: 1;
  sourceUserSeq: number;
  approvalId: string;
  decision: 'approve' | 'reject';
}

const MARKER_KEYS = ['approvalId', 'decision', 'sourceUserSeq', 'version'];
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}
function nonempty(value: unknown): boolean {
  return value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0);
}

/** A copied marker cannot turn a question, failed action or useful result into
 * a hidden receipt. The server proves provenance; this boundary checks the
 * exact public event binding and refuses terminals carrying work evidence. */
export function readApprovalDecisionAck(event: HarnessEvent, sessionId?: string | null): ApprovalDecisionAck | null {
  if (event.type !== 'conversation_completed' || !Number.isSafeInteger(event.seq) || event.seq <= 0
    || (event.role !== undefined && event.role !== 'system')
    || (sessionId && event.sessionId && sessionId !== event.sessionId)) return null;
  const d = event.data ?? {};
  const marker = record(d.approvalDecisionAck);
  const presentation = record(d.presentation);
  const identity = record(presentation?.identity);
  const outcome = record(d.turnOutcome);
  const notice = record(d.notice);
  const session = event.sessionId ?? sessionId;
  if (!marker || Object.keys(marker).sort().join(',') !== MARKER_KEYS.join(',')
    || marker.version !== 1 || !Number.isSafeInteger(marker.sourceUserSeq) || Number(marker.sourceUserSeq) <= 0
    || Number(marker.sourceUserSeq) >= event.seq || !identifier(marker.approvalId)
    || (marker.decision !== 'approve' && marker.decision !== 'reject')
    || !session || !identifier(session) || d.sourceUserSeq !== marker.sourceUserSeq
    || presentation?.version !== 1 || presentation.audience !== 'user' || presentation.phase !== 'final'
    || presentation.status !== 'done' || presentation.kind !== 'answer' || presentation.resumable !== false
    || identity?.sessionId !== session || identity.sourceUserSeq !== marker.sourceUserSeq
    || !Number.isSafeInteger(identity.turn) || Number(identity.turn) < 0
    || outcome?.version !== 2 || outcome.status !== 'done' || outcome.resumable !== false
    || notice?.code !== 'card_decision' || Object.keys(notice).some(key => key !== 'code')) return null;
  if (nonempty(presentation.needs) || nonempty(outcome.needs)
    || nonempty(presentation.evidenceRefs) || nonempty(outcome.evidenceRefs)
    || (d.review !== undefined && d.review !== 'unchecked')
    || (typeof d.reviewNote === 'string' ? !!d.reviewNote.trim() : nonempty(d.reviewNote))
    || (d.steps !== undefined && d.steps !== 0)
    || ['artifact', 'files', 'workflows', 'planArtifactRef', 'planProposalId', 'verification', 'artifactVerification', 'artifactRunScopeId', 'backgroundOutcomeReport']
      .some(key => nonempty(d[key]))) return null;
  const retained = record(d.retained);
  if (d.retained !== undefined && (!retained || (retained.results !== undefined && retained.results !== 0)
    || (retained.outsideChange !== undefined && retained.outsideChange !== 'none'))) return null;
  return marker as unknown as ApprovalDecisionAck;
}

interface ApprovalCardMessage {
  role: string;
  approval?: { approvalId?: string | null; resolution?: string };
}

/** Resolve just the displayed card. Existing changed/expired/opposite decisions
 * remain visible and cannot be overwritten by a late receipt. */
export function applyApprovalDecisionAck<T extends ApprovalCardMessage>(messages: readonly T[], ack: ApprovalDecisionAck): {
  messages: T[]; matched: boolean;
} {
  const resolution = ack.decision === 'approve' ? 'approved' : 'declined';
  const matched = messages.some(message => message.role === 'assistant' && message.approval?.approvalId === ack.approvalId
    && (message.approval.resolution === undefined || message.approval.resolution === resolution));
  if (!matched) return { messages: messages as T[], matched: false };
  let changed = false;
  const next = messages.map(message => {
    if (message.role !== 'assistant' || message.approval?.approvalId !== ack.approvalId
      || message.approval.resolution !== undefined) return message;
    changed = true;
    return { ...message, approval: { ...message.approval, resolution } };
  });
  return { messages: changed ? next : messages as T[], matched: true };
}

/** When history omits the card, its decision still has one human-readable line. */
export function approvalDecisionFallback(ack: ApprovalDecisionAck): string {
  return ack.decision === 'approve' ? 'Approved.' : 'Declined.';
}
