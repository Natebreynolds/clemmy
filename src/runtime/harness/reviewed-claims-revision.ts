/**
 * Compatibility boundary for a proposed quoted-revision shortcut.
 *
 * Quote disappearance does not prove that a paraphrase is supported, that no
 * new claim was added, or that all deliverables remain. A quote in a format
 * finding can be a rejected example rather than an approved replacement.
 * Current feedback has no typed whole-objective/evidence qualification that
 * can be transferred to a changed candidate. It therefore grants no shortcut:
 * the caller must review the revised answer against the whole objective.
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

export function reviewedClaimsRevision(_input: {
  feedback: { repairScope?: ReviewedRevisionScope; quotes?: readonly string[]; replyDigest: string } | undefined;
  reply: string;
  replyDigest: string;
  stakes: ReviewStakes;
  settledCount: number;
}): ReviewedClaimsRevision | null {
  return null;
}

export function reviewedClaimsRevisionReason(revision: ReviewedClaimsRevision): string {
  const named = revision.quotes.map((quote) => `"${quote}"`).join('; ');
  return (revision.scope === 'claims'
    ? `Claims-revision proposal still requires whole-objective review: ${named}`
    : `Format-revision proposal still requires whole-objective review: ${named}`).slice(0, 1_600);
}
