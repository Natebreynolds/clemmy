/**
 * Launch a set of independent, detection-only judges as one boundary batch.
 *
 * This is deliberately not a hedge/race primitive. A hedge is a delayed
 * fallback for the same opinion and should avoid duplicate spend when the
 * primary answers quickly. Every factory passed here is a distinct advisory
 * opinion whose result cannot change whether the primary work is allowed to
 * continue.
 *
 * All factories are invoked in the current JavaScript turn before any promise
 * continuation can run. When `pending` is present, their fail-open promises are
 * registered for a single later `allSettled` join and this function returns
 * synchronously; user-critical work never waits for advisory latency. The
 * optional no-registry return preserves the legacy inline-wait contract for
 * callers that have not installed a run-level advisory registry.
 */
export function launchIndependentAdvisoryJudges(
  pending: Array<Promise<void>> | undefined,
  judges: ReadonlyArray<() => void | Promise<void>>,
): Promise<void> | undefined {
  const launched = judges.map((judge): Promise<void> => {
    try {
      return Promise.resolve(judge()).catch(() => {
        // Detection-only advisories are fail-open by contract.
      });
    } catch {
      return Promise.resolve();
    }
  });

  if (pending) {
    pending.push(...launched);
    return undefined;
  }

  return Promise.allSettled(launched).then(() => undefined);
}

/** Join a completed run's advisory registry without allowing one rejected
 * opinion to suppress its independent siblings or fail the primary work. */
export async function settleIndependentAdvisoryJudges(
  pending: readonly Promise<void>[],
): Promise<void> {
  if (pending.length === 0) return;
  await Promise.allSettled(pending);
}
