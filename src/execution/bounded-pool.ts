/**
 * Generic bounded-concurrency pool.
 *
 * Runs `worker(item)` over `items` with at most `concurrency` in flight
 * at once. Used by the workflow-run drain so several queued runs can
 * make progress concurrently without one long run blocking the rest —
 * while still capping how many heavyweight harness runs execute at once.
 *
 * Contract:
 *   - Never more than `concurrency` workers active simultaneously.
 *   - Every item is handed to the worker exactly once.
 *   - A worker that throws does NOT abort the pool; its error is passed
 *     to `onError` (if provided) and the pool keeps draining. This
 *     matters for the drain: one bad run must not strand the others.
 *   - Resolves once every item has been processed.
 *
 * Pure (no I/O, no globals, no clock) so the scheduling guarantees are
 * unit-testable in isolation.
 */
export async function runBoundedPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  onError?: (err: unknown, item: T, index: number) => void,
): Promise<void> {
  const total = items.length;
  if (total === 0) return;
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, total));

  let cursor = 0;
  const runOne = async (): Promise<void> => {
    while (cursor < total) {
      const index = cursor;
      cursor += 1;
      try {
        await worker(items[index], index);
      } catch (err) {
        if (onError) onError(err, items[index], index);
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runOne()));
}
