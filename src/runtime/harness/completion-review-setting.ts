import { getRuntimeEnv } from '../../config.js';

/**
 * Owner control: is completion review switched ON?
 *
 * The owner requires a feature users can turn on and off that also works with a
 * single provider. Nothing persisted previously fed the completion judge — every
 * `judgeCompletion` value was a compile-time literal, so the only way to be
 * unjudged was to be on a surface that never opted in. The existing "Second
 * opinion" switch does NOT turn completion review off; its own copy says
 * completion judges still run.
 *
 * Persisted in the same .env-backed store as the judge model selection
 * (CLEMMY_MODEL_ROLES), so on/off and which-model travel together and survive
 * restart. Default ON preserves today's behaviour for everyone who never touches
 * it. Disabled-by-owner is a legitimate policy, NOT a failed verification: it
 * must never force Plan, a retry, or an unfinished result.
 *
 * This is the one reader of the owner's switch. A surface that never reviews
 * in its own loop, and a workflow run whose review happens at the run level,
 * combine it with their own posture; they never restate it.
 */
export function completionReviewEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_COMPLETION_REVIEW', 'on') || 'on').trim().toLowerCase() !== 'off';
}
