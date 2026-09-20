export type PublicationReviewStatus = 'passed' | 'rejected' | 'unverified';

/** A saved artifact is not proof of a successful review. Match the exact
 * candidate digest, including on recovery of an already-published source. */
export function publicationReviewStatus(
  planDigest: string,
  reviews: readonly { planDigest?: unknown; fulfills?: unknown; failedOpen?: unknown }[],
): PublicationReviewStatus {
  const review = reviews.filter(row => row.planDigest === planDigest).at(-1);
  if (!review || review.failedOpen === true) return 'unverified';
  return review.fulfills === true ? 'passed' : review.fulfills === false ? 'rejected' : 'unverified';
}

export function planPublicationMessage(readiness: string, review: PublicationReviewStatus, recovered: boolean): string {
  const prefix = recovered ? 'This source already saved this exact plan; no replacement was published. ' : '';
  if (readiness === 'needs_input') return prefix + 'The partial plan and question are saved. The answer continues planning; prepare a ready revision before selecting Execute. No business execution has started.';
  if (review === 'rejected') return prefix + 'The plan is saved, but its completion review found unresolved gaps. Continue planning to repair this revision; do not present it as ready to Execute. No business execution has started.';
  if (review === 'unverified') return prefix + 'The plan is saved, but a successful review of this exact revision is not verified. Check its review before presenting it as ready to Execute. No business execution has started.';
  return prefix + 'The full plan is saved and its completion review passed. The user can Execute this exact revision. No business execution has started.';
}
