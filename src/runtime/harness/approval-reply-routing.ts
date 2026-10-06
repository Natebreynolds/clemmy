import * as approvalRegistry from './approval-registry.js';
import { approvalCallPreview } from './approval-call-preview.js';
import { approvalPreviewProjection } from './public-presentation.js';
import { pendingActionIdFromArgs } from './pending-action-view.js';
import { APPROVAL_REPLY_SURE, classifyApprovalReplyWithJev } from '../jev/control-plane.js';
import { approvalReplyTargets, parseApprovalIntent } from './approval-intent.js';
import { selectAddressedApproval } from './approval-addressing.js';
import { openEventLog } from './eventlog.js';

export interface ApprovalReplyRoute {
  /** Null suppresses a supplied decision while preserving normal conversation. */
  intent: { decision: 'approve' | 'reject'; approvalId: string } | null;
  /** An amendment rejects the frozen call and gives the model the owner's
   * exact words. The revised call needs its own approval. */
  changeRequest?: string;
  /** The reply leans one way but Jev is not sure enough to act on it. Clem
   * asks the card's question back in one line; nothing else starts. Live
   * 2026-10-06: "Yes, delete the draft." to a card reading "Delete Outlook
   * message · message_id: AAMk…" scored approves 0.70, fell through to a
   * fresh turn, and that turn minted an identical card — four times over. */
  confirm?: { approvalId: string; leaning: 'approves' | 'declines'; question: string };
}

/** A reading that leans one way is worth a one-line confirmation; below this
 * the reply is conversation. */
export const APPROVAL_REPLY_LEANING = 0.5;

/** The card's own words — the question Clem asked and why — as recorded when
 * the card was shown. The registry row keeps the call; the chat event keeps
 * the plain-English framing the owner actually read. */
export function pendingApprovalWords(approvalId: string): { ask?: string; why?: string } {
  try {
    const row = openEventLog().prepare(`
      SELECT data_json FROM events
       WHERE type = 'approval_requested' AND json_extract(data_json, '$.approvalId') = ?
       ORDER BY seq DESC LIMIT 1
    `).get(approvalId) as { data_json: string } | undefined;
    if (!row) return {};
    const preview = (JSON.parse(row.data_json) as { preview?: { ask?: unknown; why?: unknown } }).preview;
    return {
      ...(typeof preview?.ask === 'string' && preview.ask.trim() ? { ask: preview.ask.trim() } : {}),
      ...(typeof preview?.why === 'string' && preview.why.trim() ? { why: preview.why.trim() } : {}),
    };
  } catch {
    return {};
  }
}

export function isExactApprovalDecision(text: string): boolean {
  return parseApprovalIntent(text) !== null;
}

/** What the card will do, as Jev reads it: the question Clem asked in her
 * own words (when the card recorded one), then the operation and its fields.
 * Fields alone can be opaque — "Delete Outlook message · message_id: AAMk…"
 * — and an owner who answers "yes, delete the draft" is answering the
 * question, not the id. */
export function describePendingApproval(row: approvalRegistry.PendingApprovalRow): string {
  const words = pendingApprovalWords(row.approvalId);
  const framing = [
    ...(words.ask ? [`Clem asked: ${words.ask}`] : []),
    ...(words.why ? [`Why: ${words.why}`] : []),
  ];
  const preview = approvalRegistry.isApprovalGroup(row)
    ? approvalPreviewProjection(row.args?.preview)?.preview
    : row.tool ? approvalCallPreview({ toolName: row.tool, args: row.args, rawArgs: '' })
    : null;
  if (!preview) return [...framing, row.subject].join('\n').slice(0, 2_000);
  const fields = preview.fields.filter(field => !preview.items || field.name !== 'Prepared actions').map((field) => (
    `${field.name}: ${field.label ? `${field.label} (${field.value})` : field.value}`
  ));
  const members = (preview.items ?? []).map((item, index) => [
    `${index + 1}. ${item.operation}`,
    ...item.fields.map(field => `${field.name}: ${field.label ? `${field.label} (${field.value})` : field.value}`),
  ].join('\n'));
  return [...framing, preview.operation, ...fields, ...members].join('\n').slice(0, 2_000);
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
    // A queued exact payload (a shell command, a send) can be DECLINED in
    // words like any other card. Approving it in words is not routed yet: the
    // registry listener runs a chat-queued action through the turn's
    // expected-work graph and fails `not_action` on a question turn (live
    // 2026-10-06, twice; the card button depends on the same path), which
    // left an approval-resume attempt stranded. Until that executor is
    // fixed, an approve reading stays with conversation; a change is a fresh
    // action and a new card.
    const queued = pendingActionIdFromArgs(row.args) !== null;
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
    if (queued && (reading.kind === 'changes' || reading.kind === 'approves')) return fallback;
    if (sure && reading.kind === 'changes') {
      return { intent: { decision: 'reject', approvalId: row.approvalId }, changeRequest: text };
    }
    if (sure && reading.kind === 'declines') {
      return { intent: { decision: 'reject', approvalId: row.approvalId } };
    }
    // The card asks a question in Clem's words; a plain-words yes to it is
    // the owner's decision. Until 2026-10-05 only an exact typed word or the
    // button approved, so "Yes, delete it." to "Can I delete the recurring
    // job…?" started a fresh turn that minted a duplicate card. Owner:
    // build typed approval. Jev must be sure, the reply must address this one
    // card, and a "yes but…" is still read as a change, never an approval.
    if (sure && reading.kind === 'approves') {
      return { intent: { decision: 'approve', approvalId: row.approvalId } };
    }
    // Leaning yes or no, not sure: ask the card's question back in one line.
    // A fresh turn here re-plans the same action and mints a duplicate card.
    if ((reading.kind === 'approves' || reading.kind === 'declines') && (reading.confidence ?? 0) >= APPROVAL_REPLY_LEANING) {
      const ask = pendingApprovalWords(row.approvalId).ask;
      const question = ask
        ? `Just to be sure — ${ask.replace(/^can i /i, 'should I ').replace(/\?+$/, '')}?`
        : `Just to be sure — should I go ahead with "${row.subject}"?`;
      return { intent: null, confirm: { approvalId: row.approvalId, leaning: reading.kind, question } };
    }
    return fallback;
  } catch {
    // The caller's catch-to-null must not resurrect a qualified approval when
    // a registry read or semantic interpretation is unavailable.
    return fallback;
  }
}
