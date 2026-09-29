import * as approvalRegistry from './approval-registry.js';
import { approvalCallPreview } from './approval-call-preview.js';
import { approvalPreviewProjection } from './public-presentation.js';
import { pendingActionIdFromArgs } from './pending-action-view.js';
import { APPROVAL_REPLY_SURE, classifyApprovalReplyWithJev } from '../jev/control-plane.js';
import { approvalReplyTargets, parseApprovalIntent } from './approval-intent.js';
import { selectAddressedApproval } from './approval-addressing.js';

export interface ApprovalReplyRoute {
  /** Null suppresses a supplied decision while preserving normal conversation. */
  intent: { decision: 'approve' | 'reject'; approvalId: string } | null;
  /** An amendment rejects the frozen call and gives the model the owner's
   * exact words. The revised call needs its own approval. */
  changeRequest?: string;
}

export function isExactApprovalDecision(text: string): boolean {
  return parseApprovalIntent(text) !== null;
}

/** What the card will do, as Jev reads it: the operation and its fields. */
export function describePendingApproval(row: approvalRegistry.PendingApprovalRow): string {
  const preview = approvalRegistry.isApprovalGroup(row)
    ? approvalPreviewProjection(row.args?.preview)?.preview
    : row.tool ? approvalCallPreview({ toolName: row.tool, args: row.args, rawArgs: '' })
    : null;
  if (!preview) return row.subject;
  const fields = preview.fields.filter(field => !preview.items || field.name !== 'Prepared actions').map((field) => (
    `${field.name}: ${field.label ? `${field.label} (${field.value})` : field.value}`
  ));
  const members = (preview.items ?? []).map((item, index) => [
    `${index + 1}. ${item.operation}`,
    ...item.fields.map(field => `${field.name}: ${field.label ? `${field.label} (${field.value})` : field.value}`),
  ].join('\n'));
  return [preview.operation, ...fields, ...members].join('\n').slice(0, 2_000);
}

/** Exact decisions use the existing deterministic executor without a model
 * call. Other replies may amend or decline one supported card; Jev alone never
 * approves. Missing, ambiguous or unsupported targets stay with conversation. */
export async function routeReplyToPendingApproval(input: {
  sessionId: string;
  text: string;
  parsed: { decision: 'approve' | 'reject'; approvalId?: string } | null;
}): Promise<ApprovalReplyRoute | null> {
  const text = input.text.trim();
  // Defend against callers retaining an old prefix-based parser. Returning
  // null from those callers would restore the unsafe supplied decision.
  const fallback: ApprovalReplyRoute | null = input.parsed ? { intent: null } : null;
  const exact = parseApprovalIntent(text);
  if (exact && input.parsed) {
    return exact.decision === input.parsed.decision && exact.approvalId === input.parsed.approvalId
      ? null : fallback;
  }
  if (exact?.decision === 'approve') return null;
  if (!text) return fallback;
  try {
    const targets = approvalReplyTargets(text);
    if (targets.length > 1) return fallback;
    const waiting = approvalRegistry.listPending({ sessionId: input.sessionId, status: 'pending' })
      .filter((row) => approvalRegistry.isFormalApprovalSurface(row) && approvalRegistry.isActionable(row));
    // Select before inspecting executor support: a queued card is still a
    // competing target, and an explicit missing ID must never select another.
    const selected = selectAddressedApproval(waiting, targets[0]);
    if (selected.kind !== 'selected') return fallback;
    const row = selected.row;
    if (pendingActionIdFromArgs(row.args) !== null) return fallback;
    // Mobile supplies no parsed intent for bare declines. Preserve that
    // control after target selection without spending a semantic model call.
    if (exact?.decision === 'reject') {
      return { intent: { decision: 'reject', approvalId: row.approvalId } };
    }
    const reading = await classifyApprovalReplyWithJev(
      { pending: describePendingApproval(row), reply: text },
      { sessionId: input.sessionId },
    );
    const current = approvalRegistry.get(row.approvalId);
    if (!current || !approvalRegistry.isActionable(current)) return fallback;
    const sure = reading.kind !== null && (reading.confidence ?? 0) >= APPROVAL_REPLY_SURE;
    if (sure && reading.kind === 'changes') {
      return { intent: { decision: 'reject', approvalId: row.approvalId }, changeRequest: text };
    }
    if (sure && reading.kind === 'declines') {
      return { intent: { decision: 'reject', approvalId: row.approvalId } };
    }
    return fallback;
  } catch {
    // The caller's catch-to-null must not resurrect a qualified approval when
    // a registry read or semantic interpretation is unavailable.
    return fallback;
  }
}
