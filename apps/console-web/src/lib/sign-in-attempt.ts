/** A screen owns its sign-in observation, not the upstream grant. Aborting a
 * request cannot undo a grant the daemon already accepted, so late responses
 * are fenced as well as cancelling requests and scheduled work. */
export function createSignInAttemptOwner(options: {
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
} = {}) {
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let current: { controller: AbortController; timers: Set<ReturnType<typeof setTimeout>> } | undefined;
  const stop = () => {
    const previous = current;
    current = undefined;
    if (!previous) return;
    previous.controller.abort();
    for (const timer of previous.timers) cancel(timer);
    previous.timers.clear();
  };
  return {
    stop,
    begin() {
      stop();
      const attempt = { controller: new AbortController(), timers: new Set<ReturnType<typeof setTimeout>>() };
      current = attempt;
      const isCurrent = () => current === attempt && !attempt.controller.signal.aborted;
      return {
        signal: attempt.controller.signal,
        isCurrent,
        stop() { if (isCurrent()) stop(); },
        later(callback: () => void, delay: number) {
          if (!isCurrent()) return () => {};
          const timer = schedule(() => {
            attempt.timers.delete(timer);
            if (isCurrent()) callback();
          }, delay);
          attempt.timers.add(timer);
          return () => { cancel(timer); attempt.timers.delete(timer); };
        },
      };
    },
  };
}

/** Bound observation even if a response contains a malformed or distant
 * deadline. This never changes the provider's actual authorization lifetime. */
export function deviceSignInDeadline(expiresAt: string | undefined, maxLifetimeMs: number, now = Date.now()): number | null {
  const deadline = expiresAt === undefined ? now + maxLifetimeMs : Date.parse(expiresAt);
  return Number.isFinite(deadline) ? Math.min(deadline, now + maxLifetimeMs) : null;
}

/** Invalid backoff must not become a zero-delay loop. Large valid intervals
 * are retained; the caller wakes at expiry before sending another request. */
export function deviceSignInPollDelay(seconds: number | undefined, fallbackMs = 5000): number {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    && Number.isFinite(seconds * 1000) ? Math.max(3, seconds) * 1000 : fallbackMs;
}
