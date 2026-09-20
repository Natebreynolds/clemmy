/** A repair limit bounds send-backs, never which candidate gets reviewed. */
export async function reviewPlanWithinRepairBudget(
  review: () => Promise<'continue' | 'done'>,
  priorRounds: number,
  budget: number,
): Promise<{ requestRepair: boolean; budgetSpent: boolean }> {
  const verdict = await review();
  const budgetSpent = priorRounds >= budget;
  return { requestRepair: verdict === 'continue' && !budgetSpent, budgetSpent };
}
