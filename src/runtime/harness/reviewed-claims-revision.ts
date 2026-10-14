/**
 * A read-only answer's one revision to a claims-only review finding.
 *
 * The reviewer quoted the claims it could not verify; the model revised the
 * answer once; the host checks that none of the quoted claims remain. That
 * check is mechanical and true, so the revised answer ships on it instead of
 * waiting on a second review of the whole reply, which cost as much as the
 * first. Work that wrote or created something keeps its second review: there
 * the review guards what reached outside, not the wording of a reply.
 */
import type { ReviewStakes } from './objective-judge.js';

export interface ReviewedClaimsRevision {
  /** The quoted claims the reviewer named, none of which remain. */
  quotes: string[];
  /** The draft the review ruled on. */
  fromReplyDigest: string;
}

export function reviewedClaimsRevision(input: {
  feedback: { repairScope?: 'claims'; quotes?: readonly string[]; replyDigest: string } | undefined;
  reply: string;
  replyDigest: string;
  stakes: ReviewStakes;
  settledCount: number;
}): ReviewedClaimsRevision | null {
  const feedback = input.feedback;
  if (!feedback || feedback.repairScope !== 'claims') return null;
  if (input.stakes !== 'read' || input.settledCount > 0) return null;
  const quotes = (feedback.quotes ?? []).filter((quote) => quote.trim().length > 0);
  if (quotes.length === 0) return null;
  if (input.replyDigest === feedback.replyDigest) return null;
  if (quotes.some((quote) => input.reply.includes(quote))) return null;
  return { quotes: [...quotes], fromReplyDigest: feedback.replyDigest };
}

export function reviewedClaimsRevisionReason(revision: ReviewedClaimsRevision): string {
  const named = revision.quotes.map((quote) => `"${quote}"`).join('; ');
  return `Revised to the review's findings; none of the quoted claims remain: ${named}`.slice(0, 1_600);
}
