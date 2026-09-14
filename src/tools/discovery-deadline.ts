/** Metadata I/O has a short discovery budget. A model review belongs to the
 * current tool invocation and uses that invocation's cancellation/deadline,
 * rather than racing a second, shorter metadata timer. */
export interface DiscoveryDeadline {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  awaitModelReview<T>(work: () => Promise<T>): Promise<T>;
}

export async function withDiscoveryDeadline<T>(
  input: { deadlineAt: number; signal?: AbortSignal; onModelWait?: (elapsedMs: number) => void },
  work: (control: DiscoveryDeadline) => Promise<T>,
): Promise<T | null> {
  const controller = new AbortController();
  let deadlineAt = input.deadlineAt;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reviews = 0;
  let pausedAt = 0;
  let closed = false;
  let expire!: () => void;
  const expired = new Promise<null>(resolve => {
    expire = () => { controller.abort(input.signal?.reason); resolve(null); };
  });
  const arm = () => {
    if (!closed && !controller.signal.aborted && reviews === 0) {
      timer = setTimeout(expire, Math.max(0, deadlineAt - Date.now()));
    }
  };
  const control: DiscoveryDeadline = {
    signal: controller.signal,
    get deadlineAt() { return deadlineAt; },
    async awaitModelReview(run) {
      if (closed || controller.signal.aborted || (reviews === 0 && Date.now() >= deadlineAt)) {
        throw new Error('discovery invocation ended before account review');
      }
      if (reviews++ === 0) { pausedAt = Date.now(); clearTimeout(timer); }
      try { return await run(); }
      finally {
        if (--reviews === 0 && !closed) {
          const elapsed = Date.now() - pausedAt;
          deadlineAt += elapsed;
          input.onModelWait?.(elapsed);
          arm();
        }
      }
    },
  };
  input.signal?.addEventListener('abort', expire, { once: true });
  try {
    if (input.signal?.aborted || Date.now() >= deadlineAt) { expire(); return null; }
    arm();
    const result = await Promise.race([work(control), expired]);
    return controller.signal.aborted || Date.now() >= deadlineAt ? null : result;
  } finally {
    closed = true;
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', expire);
    // A late metadata/review promise must not publish after its owner exits.
    controller.abort();
  }
}
