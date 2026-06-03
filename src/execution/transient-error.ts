/**
 * Transient-vs-deterministic error classification — a pure leaf module with no
 * dependencies, so it can be shared by both the workflow runner's step-retry
 * and low-level tool modules (e.g. composio-tools) WITHOUT an import cycle.
 *
 * "Transient" = an infrastructure blip (rate limit / 5xx / network reset /
 * timeout) where a SINGLE retry of the same call may succeed. "Deterministic"
 * = a 4xx / schema / not-found / approval error where repeating the identical
 * call returns the identical failure — that's thrash, not retry.
 */

const TRANSIENT_RE = /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network error|fetch failed|connection (?:error|closed|reset)|timed? ?out|timeout|rate.?limit|too many requests|temporarily unavailable|service unavailable|bad gateway|gateway timeout)\b/i;
// Things that read as "timeout"-ish but are NOT retryable (e.g. "waiting for
// approval" contains "timed out"). This override wins over TRANSIENT_RE.
const NON_RETRYABLE_RE = /(waiting for approval|exceeded approval wait budget|was not approved|missing required input|failed its contract|deterministic runner)/i;
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** True when `err` looks like a transient infrastructure failure worth ONE
 *  retry. Bounded-recurses into `err.cause` (undici wraps the real cause). */
export function isTransientStepError(err: unknown, depth = 0): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (NON_RETRYABLE_RE.test(msg)) return false;
  const code = (err as { code?: string; status?: number; cause?: unknown } | null);
  if (code?.code && TRANSIENT_RE.test(code.code)) return true;
  if (typeof code?.status === 'number' && TRANSIENT_STATUS.has(code.status)) return true;
  if (TRANSIENT_RE.test(msg)) return true;
  // undici fetch / aggregate errors wrap the real transient cause one level down
  // (a `fetch failed` whose cause is ECONNRESET). Recurse, bounded, on the cause.
  if (depth < 3 && code?.cause && code.cause !== err) return isTransientStepError(code.cause, depth + 1);
  return false;
}
