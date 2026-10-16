/**
 * A creation test that a tool call is waiting on reaches the brain as that
 * call's result. The chat report-back exists for the case where nobody is
 * waiting; sending both posts the same result twice, once in the workflow
 * runner's words. The waiting call registers here; the runner claims the
 * delivery when the test settles while it is still registered.
 */
const awaiting = new Set<string>();
const claimed = new Set<string>();

export function awaitCreationTestInline(runId: string): void {
  awaiting.add(runId);
}

/** The waiter stopped waiting. Returns true when the runner already claimed
 *  the delivery, so the waiter must still hand the settled result over. */
export function releaseCreationTestInline(runId: string): boolean {
  awaiting.delete(runId);
  return claimed.delete(runId);
}

/** Called by the runner when the test settles: true when a waiting call will
 *  deliver this exact run's result, so no separate report goes to the chat. */
export function claimInlineCreationTestDelivery(runId: string): boolean {
  if (!awaiting.has(runId)) return false;
  claimed.add(runId);
  return true;
}
