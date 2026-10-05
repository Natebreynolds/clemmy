/**
 * Acting on an approval from inside the chat transcript.
 *
 * The approval branch in Chat.tsx rendered "Waiting on you — {subject}" and
 * early-returned with no controls, while the PLAN branch twenty lines below
 * rendered Approve/Reject. So when Clem asked for approval mid-conversation on
 * mobile, there was nothing to press.
 *
 * The reply is sent as ordinary chat text rather than through the approval
 * endpoint, for one specific reason: `approval_requested` is TERMINAL for the
 * stream (stream.ts finishes the turn on it). Only engine.send() re-attaches
 * it. Calling the endpoint directly resolves the approval but leaves the
 * transcript frozen until something else wakes it, so the user taps Approve
 * and appears to get nothing.
 */

/**
 * The exact text to send for a decision, or null when the approval carries no
 * id and therefore cannot be acted on from here.
 *
 * Capitalisation is load-bearing. The server records the synthetic user turn
 * as `Approve apr-…` / `Reject apr-…` (mobile-routes.ts), and the chat
 * engine's echo de-duplication falls back to an EXACT text comparison once the
 * pending marker has cleared. A lowercase send still classifies — the
 * classifier regex is case-insensitive — but the echo would no longer match,
 * and the transcript would show the decision twice.
 */
export function chatApprovalReply(
  decision: 'approve' | 'reject',
  approvalId: string | null | undefined,
): string | null {
  const id = typeof approvalId === 'string' ? approvalId.trim() : '';
  if (!id) return null;
  return `${decision === 'approve' ? 'Approve' : 'Reject'} ${id}`;
}

interface TranscriptMessage {
  role: string;
  text: string;
  pending?: string;
  approval?: { approvalId?: string | null; resolution?: string };
}

/** A sent answer is a request, not a recorded decision. Keep a failed or
 * unfinished answer actionable on replay; the UI's busy state gates taps
 * while delivery is in progress. */
export function chatApprovalDecided(
  messages: readonly TranscriptMessage[],
  approvalId: string | null | undefined,
): boolean {
  if (!approvalId) return false;
  return messages.some((message) => message.approval?.approvalId === approvalId
    && Boolean(message.approval.resolution));
}
