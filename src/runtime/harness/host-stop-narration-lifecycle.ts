/** Optional words may use the current turn's model, but cannot outlive the
 * accepted source's ownership, Stop or their existing narration deadline. */
export async function runOwnedHostStopNarration<T>(input: {
  signal?: AbortSignal;
  deadlineMs: number;
  assertOwned: () => void;
  isStopped: () => boolean;
  work: (scope: { signal: AbortSignal; assertCurrent: () => void }) => Promise<T>;
}): Promise<T | undefined> {
  const controller = new AbortController();
  let closed = false;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = (reason: unknown): void => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    rejectAbort(reason);
  };
  const assertCurrent = (): void => {
    if (closed) throw new Error('host_stop_narration_closed');
    controller.signal.throwIfAborted();
    try {
      input.assertOwned();
      if (input.isStopped()) throw new Error('host_stop_narration_stopped');
    } catch (error) {
      abort(error);
      throw error;
    }
  };
  // An outer abort is retained as that abort; it is not evidence that the
  // owner pressed Stop. Only the exact durable predicate proves that fact.
  const onAbort = (): void => abort(input.signal?.reason ?? new Error('host_stop_narration_aborted'));
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => abort(new Error('host_stop_narration_deadline')), input.deadlineMs);
  const stopped = setInterval(() => {
    try { assertCurrent(); } catch { /* the abort race owns this failure */ }
  }, 250);
  try {
    if (input.signal?.aborted) onAbort();
    // Attach the abort race before invoking work, so synchronous admission
    // failures and an adapter which ignores cancellation remain contained.
    const work = Promise.resolve().then(async () => {
      assertCurrent();
      const value = await input.work({ signal: controller.signal, assertCurrent });
      assertCurrent();
      return value;
    });
    return await Promise.race([work, aborted]);
  } catch {
    return undefined;
  } finally {
    closed = true;
    clearTimeout(deadline);
    clearInterval(stopped);
    input.signal?.removeEventListener('abort', onAbort);
  }
}
