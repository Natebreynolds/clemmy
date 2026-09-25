import * as approvalRegistry from './approval-registry.js';
import { approvalCallPreview } from './approval-call-preview.js';
import { pendingActionIdFromArgs } from './pending-action-view.js';
import { APPROVAL_REPLY_SURE, classifyApprovalReplyWithJev } from '../jev/control-plane.js';

/**
 * A reply to a waiting approval card, in words.
 *
 * The owner can answer a card by writing instead of pressing a button: "make
 * it shorter", "don't send it", "yes but mention Alana". Jev reads the reply
 * against what the card will do. A sure change rejects the exact call and
 * carries the owner's words to the model for one fresh call, which comes back
 * as a new card; a sure decline rejects it. Nothing is sent on Jev's word
 * alone: an approval still needs the button or a short typed decision, and a
 * longer reply that only starts like an approval ("go ahead but make it
 * shorter", which used to send the old text) is approved only when Jev is
 * sure it changes nothing.
 */

export interface ApprovalReplyRoute {
  /** The decision for the waiting card; null leaves it waiting and treats
   *  the reply as an ordinary message. */
  intent: { decision: 'approve' | 'reject'; approvalId: string } | null;
  /** The owner's words when they asked for a change. */
  changeRequest?: string;
}

/** A button press or a short typed decision: "approve", "go ahead",
 *  "reject apr-k42z". The existing parser reads these unaided. */
export function isShortApprovalDecision(text: string): boolean {
  const words = text
    .replace(/\bapr-[a-z0-9]{4}\b/gi, ' ')
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length <= 4;
}

/** What the card will do, as Jev reads it: the operation and its fields. */
export function describePendingApproval(row: approvalRegistry.PendingApprovalRow): string {
  const preview = row.tool
    ? approvalCallPreview({ toolName: row.tool, args: row.args, rawArgs: '' })
    : null;
  if (!preview) return row.subject;
  const fields = preview.fields.map((field) => (
    `${field.name}: ${field.label ? `${field.label} (${field.value})` : field.value}`
  ));
  return [preview.operation, ...fields].join('\n').slice(0, 2_000);
}

/**
 * Route a written reply while an approval waits in this session. Returns null
 * when nothing changes: no single plain card is waiting, or the reply is a
 * short decision the parser already reads.
 */
export async function routeReplyToPendingApproval(input: {
  sessionId: string;
  text: string;
  parsed: { decision: 'approve' | 'reject'; approvalId?: string } | null;
}): Promise<ApprovalReplyRoute | null> {
  const text = input.text.trim();
  if (!text || (input.parsed && isShortApprovalDecision(text))) return null;
  const waiting = approvalRegistry.listPending({ sessionId: input.sessionId, status: 'pending' })
    .filter(approvalRegistry.isFormalApprovalSurface)
    // A queued pending action runs through its own executor and card.
    .filter((row) => pendingActionIdFromArgs(row.args) === null)
    .filter((row) => !input.parsed?.approvalId || row.approvalId === input.parsed.approvalId);
  if (waiting.length !== 1) return null;
  const row = waiting[0]!;
  const reading = await classifyApprovalReplyWithJev(
    { pending: describePendingApproval(row), reply: text },
    { sessionId: input.sessionId },
  );
  const sure = reading.kind !== null && (reading.confidence ?? 0) >= APPROVAL_REPLY_SURE;
  if (sure && reading.kind === 'changes') {
    return { intent: { decision: 'reject', approvalId: row.approvalId }, changeRequest: text };
  }
  if (sure && reading.kind === 'declines') {
    return { intent: { decision: 'reject', approvalId: row.approvalId } };
  }
  if (input.parsed?.decision === 'approve') {
    return sure && reading.kind === 'approves'
      ? { intent: { decision: 'approve', approvalId: row.approvalId } }
      : { intent: null };
  }
  // A parsed decline stays a decline; anything else is an ordinary message.
  return null;
}
