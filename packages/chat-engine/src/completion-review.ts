/** Owner setting for completion review, independent of fusion/Second opinion. */
export interface CompletionReviewSnapshot {
  enabled: boolean;
  /** Resolved judge model ID; this is not a provider selector. */
  judge: string;
  judgeSource: string;
}

/** Missing or malformed settings must never look like review is switched off. */
export function readCompletionReviewResponse(value: unknown): CompletionReviewSnapshot {
  const response = value as { completionReview?: unknown } | null;
  const row = response?.completionReview as Partial<CompletionReviewSnapshot> | null;
  if (!row || typeof row.enabled !== 'boolean'
    || typeof row.judge !== 'string' || !row.judge.trim()
    || typeof row.judgeSource !== 'string' || !row.judgeSource.trim()) {
    throw new Error('The completion review setting could not be confirmed. Reload it before changing it.');
  }
  return { enabled: row.enabled, judge: row.judge, judgeSource: row.judgeSource };
}
