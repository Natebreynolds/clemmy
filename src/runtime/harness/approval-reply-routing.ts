import * as approvalRegistry from './approval-registry.js';
import { approvalCallPreview } from './approval-call-preview.js';
import { approvalPreviewProjection } from './public-presentation.js';
import { pendingActionIdFromArgs } from './pending-action-view.js';
import { APPROVAL_REPLY_SURE, classifyApprovalReplyWithJev } from '../jev/control-plane.js';
import { approvalReplyTargets, parseApprovalIntent } from './approval-intent.js';
import { selectAddressedApproval } from './approval-addressing.js';
import { appendEvent, openEventLog } from './eventlog.js';

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
  confirm?: { approvalId: string; leaning: 'approves' | 'declines' | 'unread'; question: string };
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
/** The card's own question, asked back: "Just to be sure — should I …?" */
function confirmQuestionFor(row: approvalRegistry.PendingApprovalRow): string {
  const ask = pendingApprovalWords(row.approvalId).ask;
  return ask
    ? `Just to be sure — ${ask.replace(/^can i /i, 'should I ').replace(/\?+$/, '')}?`
    : `Just to be sure — should I go ahead with "${row.subject}"?`;
}

/** The host already asked this exact question back once in this session. */
function confirmationAlreadyAsked(sessionId: string, question: string): boolean {
  try {
    return openEventLog().prepare(`
      SELECT 1 FROM events
       WHERE session_id = ? AND type = 'awaiting_user_input'
         AND json_extract(data_json, '$.reason') = 'approval_confirmation_required'
         AND json_extract(data_json, '$.question') = ?
       LIMIT 1
    `).get(sessionId, question) !== undefined;
  } catch {
    return false;
  }
}

/** THE CARD MAY LIVE IN AN ANCESTOR OF THIS CONVERSATION. A reply that was
 * conversation (a question about the card, a waver) starts a fresh turn in a
 * successor session while the card stays pending in the parent; the next
 * "Yes." then reached a session with no card and started a new delete, send
 * or create (live 2026-10-06, twice). Typed decisions are read against the
 * nearest session in this conversation's lineage that holds a formal waiting
 * card (the session itself first), and committed there. */
export function sessionHoldingWaitingCard(
  sessionId: string,
  lineage: readonly string[],
  pausedOnApproval: (id: string) => boolean = () => false,
): string {
  const holds = (id: string): boolean => {
    try {
      return approvalRegistry.listPending({ sessionId: id, status: 'pending' }).some(approvalRegistry.isFormalApprovalSurface)
        || pausedOnApproval(id);
    } catch {
      return false;
    }
  };
  if (holds(sessionId)) return sessionId;
  return lineage.find(holds) ?? sessionId;
}

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
    // A queued exact payload (a shell command, a send) is approved or
    // declined in words like any other card; the resume compiles the owner's
    // decision as the control source it is. A change is never applied in
    // place: it rejects this exact card as changed and the owner's words run
    // as the next turn, whose fresh card names the one it revises
    // (owner-approved design, 2026-10-07; see resolveQueuedCardAsChanged).
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
    if (reading.failedOpen) {
      // Jev could not read the reply at all (unavailable, or past its
      // deadline under load). Starting a fresh turn here is the dead end:
      // the card's session is paused, so the turn branches into a successor
      // session that has no card, re-derives the work and mints a duplicate
      // card (live 2026-10-06, "Yes, delete it."). Ask the card's own
      // question back instead, once — a plain yes or no to it is parsed
      // exactly, with no model at all. A second unreadable reply to the
      // same question is conversation.
      if (confirmationAlreadyAsked(input.sessionId, confirmQuestionFor(row))) return fallback;
      return { intent: null, confirm: { approvalId: row.approvalId, leaning: 'unread', question: confirmQuestionFor(row) } };
    }
    const sure = reading.kind !== null && (reading.confidence ?? 0) >= APPROVAL_REPLY_SURE;
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
      return { intent: null, confirm: { approvalId: row.approvalId, leaning: reading.kind, question: confirmQuestionFor(row) } };
    }
    return fallback;
  } catch {
    // The caller's catch-to-null must not resurrect a qualified approval when
    // a registry read or semantic interpretation is unavailable.
    return fallback;
  }
}

/**
 * A change in words on a card that links a queued exact payload. The queued
 * payload cannot be amended in place, so the card is resolved as changed —
 * one typed resolution carrying the owner's words, written before the
 * registry settles it so the card copy reads "Changed" and never "Declined" —
 * and the caller runs those words as an ordinary turn. The fresh card that
 * turn raises names this one (loop.ts revisedCardLink). Returns false when
 * the card is not a queued one or is no longer pending; nothing is written.
 */
export function resolveQueuedCardAsChanged(input: { sessionId: string; approvalId: string; changeRequest: string }): boolean {
  const row = approvalRegistry.get(input.approvalId);
  if (!row || row.status !== 'pending' || pendingActionIdFromArgs(row.args) === null) return false;
  const change = input.changeRequest.trim().slice(0, 600);
  if (!change) return false;
  appendEvent({
    sessionId: input.sessionId,
    turn: 0,
    role: 'system',
    type: 'approval_resolved',
    data: { approvalId: row.approvalId, tool: row.tool, decision: 'reject', resolution: 'rejected', sticky: false, edited: false, changeRequested: true, changeRequest: change },
  });
  return approvalRegistry.resolve(row.approvalId, 'rejected', 'chat-dock-change-request').ok;
}
