import { isDeepStrictEqual } from 'node:util';
import { getEvent, openEventLog, type EventRow } from './eventlog.js';
import { presentationEventFromCompletionData } from './turn-outcome.js';
import { parseRetainedWorkCheckpoint } from './retained-work-checkpoint.js';

export interface ApprovalDecisionAck {
  version: 1;
  sourceUserSeq: number;
  approvalId: string;
  decision: 'approve' | 'reject';
}

const ACK_REASONS = new Set([
  'queued_action_decision_resolved', 'sdk_approval_resolved', 'workflow_approval_resolved',
  'workspace_runner_approval_refresh_started', 'workspace_approval_resolved',
  'mobile_approval_resolved', 'mobile_background_approval_queued',
]);

function exactSource(source: EventRow): boolean {
  const retained = getEvent(source.id);
  return !!retained && retained.type === 'user_input_received' && retained.role === 'user'
    && retained.seq === source.seq && retained.sessionId === source.sessionId
    && retained.turn === source.turn && retained.parentEventId === source.parentEventId
    && isDeepStrictEqual(retained.data, source.data);
}

function decidedCard(source: EventRow, approvalId: string, decision: ApprovalDecisionAck['decision']) {
  // Read the durable row without importing registry execution dependencies
  // into eventlog's public projection bootstrap.
  const row = openEventLog().prepare(`SELECT approval_id AS approvalId, session_id AS sessionId,
    status, resolution, resolved_at AS resolvedAt FROM pending_approvals WHERE approval_id = ?`)
    .get(approvalId) as { approvalId: string; sessionId: string; status: string;
      resolution: string | null; resolvedAt: string | null } | undefined;
  if (!row || row.sessionId !== source.sessionId || row.status !== 'resolved'
    || row.resolution !== (decision === 'approve' ? 'approved' : 'rejected') || !row.resolvedAt) return null;
  const carrier = openEventLog().prepare(`SELECT 1 FROM events
    WHERE session_id = ? AND type = 'approval_requested'
      AND json_extract(data_json, '$.approvalId') = ? AND seq < ? LIMIT 1`)
    .get(source.sessionId, approvalId, source.seq);
  return carrier ? row : null;
}

/** Issued only by a successful host decision-only branch. This receipt changes
 * presentation, never approval, execution, Stop or retry authority. Keep the
 * event id and resolved timestamp private so copying a receipt cannot bind it
 * to another accepted input or a later decision. */
export function approvalDecisionAckMetadata(
  source: EventRow, approvalId: string, decision: ApprovalDecisionAck['decision'],
): Record<string, unknown> {
  if (!exactSource(source) || source.data.changeRequested || source.data.confirm || source.data.approvalInquiry
    || (source.data.approvalId !== undefined && source.data.approvalId !== approvalId)
    || (source.data.decision !== undefined && source.data.decision !== decision)) return {};
  const row = decidedCard(source, approvalId, decision);
  if (!row) return {};
  return { approvalDecisionAck: { version: 1, sourceUserSeq: source.seq,
    sourceEventId: source.id, approvalId, decision, resolvedAt: row.resolvedAt } };
}

/** Only the exact retained, typed, decision-only terminal earns the public
 * card receipt. Meaningful task results and questions remain ordinary replies,
 * even when they mention a card or carry copied receipt metadata. */
export function publicApprovalDecisionAck(event: EventRow): ApprovalDecisionAck | null {
  try {
    if (event.type !== 'conversation_completed' || event.role !== 'system') return null;
    const marker = event.data.approvalDecisionAck;
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
    const retained = getEvent(event.id);
    if (!retained || retained.seq !== event.seq || retained.sessionId !== event.sessionId
      || retained.type !== event.type || retained.role !== event.role || retained.turn !== event.turn
      || retained.parentEventId !== event.parentEventId
      || !isDeepStrictEqual(retained.data, event.data)) return null;
    const data = event.data;
    const m = marker as Record<string, unknown>;
    if (Object.keys(m).sort().join(',') !== 'approvalId,decision,resolvedAt,sourceEventId,sourceUserSeq,version'
      || m.version !== 1 || !Number.isSafeInteger(m.sourceUserSeq) || Number(m.sourceUserSeq) <= 0
      || typeof m.sourceEventId !== 'string' || typeof m.approvalId !== 'string'
      || typeof m.resolvedAt !== 'string' || (m.decision !== 'approve' && m.decision !== 'reject')) return null;
    const presentation = presentationEventFromCompletionData(data);
    if (!presentation || presentation.identity.sessionId !== event.sessionId
      || presentation.identity.sourceUserSeq !== m.sourceUserSeq || presentation.identity.turn !== event.turn
      || presentation.status !== 'done' || presentation.kind !== 'answer' || presentation.resumable
      || presentation.needs || presentation.evidenceRefs?.length
      || !ACK_REASONS.has(String(data.reason)) || (data.steps !== undefined && data.steps !== 0)
      || (data.review !== undefined && data.review !== 'unchecked') || data.reviewNote
      || data.planArtifactRef || data.planProposalId || data.artifactVerification || data.verification
      || data.artifactRunScopeId) return null;
    const kept = parseRetainedWorkCheckpoint(presentation.text);
    if (kept.results > 0 || kept.outsideChange !== 'none') return null;
    const source = getEvent(m.sourceEventId);
    if (!source || source.seq !== m.sourceUserSeq || source.sessionId !== event.sessionId
      || source.turn !== event.turn || source.seq >= event.seq
      || source.type !== 'user_input_received' || source.role !== 'user') return null;
    if ((source.data.approvalId !== undefined && source.data.approvalId !== m.approvalId)
      || (source.data.decision !== undefined && source.data.decision !== m.decision)
      || source.data.changeRequested || source.data.confirm || source.data.approvalInquiry) return null;
    const row = decidedCard(source, m.approvalId, m.decision);
    if (!row || row.resolvedAt !== m.resolvedAt) return null;
    return { version: 1, sourceUserSeq: source.seq, approvalId: row.approvalId, decision: m.decision };
  } catch { return null; }
}
