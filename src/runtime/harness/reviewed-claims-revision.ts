/**
 * A read-only answer's one revision to a review finding the host can verify.
 *
 * The reviewer quotes what it found: the claims it could not verify, or the
 * exact replacement line a reply-format finding asks for. The model revises
 * the answer once; the host checks the revision against those quotes. That
 * check is mechanical and true, so the revised answer ships on it instead of
 * waiting on a second review of the whole reply, which cost as much as the
 * first. Work that wrote or created something keeps its second review: there
 * the review guards what reached outside, not the wording of a reply.
 */
import type { ReviewStakes } from './objective-judge.js';

export type ReviewedRevisionScope = 'claims' | 'reply_format';

export interface ReviewedClaimsRevision {
  scope: ReviewedRevisionScope;
  /** The reviewer's quotes the check was made against. */
  quotes: string[];
  /** The draft the review ruled on. */
  fromReplyDigest: string;
}

const MIN_REPLACEMENT_CHARS = 12;

function normalizedLine(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
}

export function reviewedClaimsRevision(input: {
  feedback: { repairScope?: ReviewedRevisionScope; quotes?: readonly string[]; replyDigest: string } | undefined;
  reply: string;
  replyDigest: string;
  stakes: ReviewStakes;
  settledCount: number;
}): ReviewedClaimsRevision | null {
  const feedback = input.feedback;
  if (!feedback || !feedback.repairScope) return null;
  if (input.stakes !== 'read' || input.settledCount > 0) return null;
  const quotes = (feedback.quotes ?? []).filter((quote) => quote.trim().length > 0);
  if (quotes.length === 0) return null;
  if (input.replyDigest === feedback.replyDigest) return null;
  if (feedback.repairScope === 'claims') {
    // Every claim the reviewer quoted is gone from the revision.
    if (quotes.some((quote) => input.reply.includes(quote))) return null;
    return { scope: 'claims', quotes: [...quotes], fromReplyDigest: feedback.replyDigest };
  }
  // The revision is exactly the replacement the reviewer spelled out.
  const reply = normalizedLine(input.reply);
  const replacement = quotes.find((quote) => quote.length >= MIN_REPLACEMENT_CHARS && normalizedLine(quote) === reply);
  if (!replacement) return null;
  return { scope: 'reply_format', quotes: [replacement], fromReplyDigest: feedback.replyDigest };
}

export function reviewedClaimsRevisionReason(revision: ReviewedClaimsRevision): string {
  const named = revision.quotes.map((quote) => `"${quote}"`).join('; ');
  return (revision.scope === 'claims'
    ? `Revised to the review's findings; none of the quoted claims remain: ${named}`
    : `Revised to the review's exact replacement: ${named}`).slice(0, 1_600);
}
