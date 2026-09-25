/**
 * The last line under an answer: whether it was checked, and by whose work.
 *
 * Both facts are already on the turn's activity. The brain the route chose is
 * the model-phase row's detail, and every review lands as a verdict row. This
 * module reads them back so a surface never re-derives either from a label.
 */
import { MODEL_PHASE_ACTIVITY_ID } from './reduce-activity.js';
import type { ActivityItem } from './types.js';

/** `checked` is a review that passed. `unchecked` is a turn whose reviewer
 *  never ran: it must never read as a pass. `rejected` is the last review
 *  saying no. */
export type TurnReview = 'checked' | 'unchecked' | 'rejected';

/** The latest verdict decides; an earlier rejection followed by a passing
 *  rewrite is a checked answer. No verdict row means no claim at all. */
export function turnReview(
  activity: readonly Pick<ActivityItem, 'kind' | 'verdict'>[] | undefined,
): TurnReview | null {
  if (!activity) return null;
  for (let i = activity.length - 1; i >= 0; i -= 1) {
    const row = activity[i];
    if (row.kind !== 'check' || !row.verdict) continue;
    if (row.verdict === 'passed') return 'checked';
    return row.verdict === 'unreviewed' ? 'unchecked' : 'rejected';
  }
  return null;
}

/** The display name of the model the route chose for this turn. Only a real
 *  model id counts: a provider on its own is a family, not a name. */
export function turnModelName(
  activity: readonly Pick<ActivityItem, 'id' | 'modelName'>[] | undefined,
): string | undefined {
  const row = activity?.find((item) => item.id === MODEL_PHASE_ACTIVITY_ID);
  const name = row?.modelName?.trim();
  return name ? name : undefined;
}
