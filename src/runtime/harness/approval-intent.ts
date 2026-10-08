/**
 * Deterministic authority for a complete written decision. Qualified replies
 * remain conversation; recognizing an approval prefix is not consent to the
 * unchanged call. All ingress surfaces use this grammar.
 */
export interface ParsedApprovalIntent {
  decision: 'approve' | 'reject';
  approvalId?: string;
}

const STRONG_APPROVE = /^(?:approved?|proceed|go ahead|lgtm|do it|confirm(?:ed)?|👍\p{Emoji_Modifier}?\uFE0F?)$/u;
const STRONG_REJECT = /^(?:reject(?:ed)?|deny|denied|abort|nevermind|never mind|not now|don'?t do (?:it|that)|👎\p{Emoji_Modifier}?\uFE0F?)$/u;
const LOOSE_APPROVE_WITH_ID = /^(?:yes|y|ok|okay|sure|sounds good|do this)$/;
const LOOSE_REJECT_WITH_ID = /^(?:no|n|stop)$/;

export function parseApprovalIntent(prompt: string): ParsedApprovalIntent | null {
  return parseCompleteDecision(prompt, false);
}

/** A complete yes/no answers a waiting card's question. This grammar does
 * not select or resolve a card; callers must prove the exact pending target
 * or ask which card when several remain. Ordinary chat keeps the stricter
 * grammar above. */
export function parseWaitingApprovalReplyIntent(prompt: string): ParsedApprovalIntent | null {
  return parseCompleteDecision(prompt, true);
}

function parseCompleteDecision(prompt: string, waitingCard: boolean): ParsedApprovalIntent | null {
  // Only sentence-ending assertion punctuation is ignorable. A question,
  // quote, condition, second decision or other suffix must remain visible.
  const text = prompt.trim().toLowerCase().replace(/\s+/gu, ' ').replace(/[.!]+$/u, '').trim();
  const id = /\s+(apr-[a-z0-9]{4})$/.exec(text);
  const approvalId = id?.[1];
  const decisionText = id ? text.slice(0, id.index).trim() : text;
  if (STRONG_APPROVE.test(decisionText) || (approvalId && LOOSE_APPROVE_WITH_ID.test(decisionText))
    || (waitingCard && /^(?:yes|y)$/.test(decisionText))) {
    return approvalId ? { decision: 'approve', approvalId } : { decision: 'approve' };
  }
  if (STRONG_REJECT.test(decisionText) || (approvalId && LOOSE_REJECT_WITH_ID.test(decisionText))
    || (waitingCard && /^(?:no|n)$/.test(decisionText))) {
    return approvalId ? { decision: 'reject', approvalId } : { decision: 'reject' };
  }
  return null;
}

/** Target references only, never execution authority. Keep unknown/malformed
 * IDs so an explicitly addressed reply cannot fall back to a different card. */
export function approvalReplyTargets(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(/\bapr-[\p{L}\p{N}_-]*/giu), (match) => match[0].toLowerCase()))];
}
