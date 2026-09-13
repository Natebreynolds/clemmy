import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { closedCanonicalJson, SEALED_CALL_CANONICAL_LIMITS } from '../../shared/closed-canonical-json.js';

export type PlanReviewCandidate = { fullText: string; structuredPlan: unknown; readiness: string; missingPrerequisites: string[] };
export function planReviewDigest(candidate: PlanReviewCandidate): string {
  return createHash('sha256').update(closedCanonicalJson(candidate, SEALED_CALL_CANONICAL_LIMITS)).digest('hex');
}
const finalReview = new AsyncLocalStorage<(candidate: PlanReviewCandidate) => Promise<'continue' | 'done' | 'awaiting_user_input'>>();
export function withPlanCompletionReview<T>(review: (candidate: PlanReviewCandidate) => Promise<'continue' | 'done' | 'awaiting_user_input'>, invoke: () => T): T {
  return finalReview.run(review, invoke);
}
export async function reviewPlanForPublication(candidate: PlanReviewCandidate): Promise<'continue' | 'done'> {
  const verdict = await finalReview.getStore()?.(candidate) ?? 'done';
  // A needs-input plan can be published for discussion. A ready plan cannot
  // inherit readiness from a verdict that accepts an unresolved question.
  return verdict === 'awaiting_user_input' ? candidate.readiness === 'needs_input' ? 'done' : 'continue' : verdict;
}
