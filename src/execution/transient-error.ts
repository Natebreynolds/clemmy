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

const TRANSIENT_RE = /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network error|fetch failed|connection (?:error|closed|reset)|timed? ?out|timeout|rate.?limit|too many requests|temporarily unavailable|service unavailable|bad gateway|gateway timeout|overloaded|internal server error|usually temporary)\b/i;
// Things that read as "timeout"-ish but are NOT retryable (e.g. "waiting for
// approval" contains "timed out"). This override wins over TRANSIENT_RE.
const NON_RETRYABLE_RE = /(waiting for approval|exceeded approval wait budget|was not approved|missing required input|failed its contract|deterministic runner)/i;
// 529 = Anthropic "Overloaded"; the rest are the standard infra 5xx + rate-limit.
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
// Provider SDKs (Claude Code / Codex) embed the HTTP status in the error MESSAGE
// ("Claude Code returned an error result: API Error: 529 Overloaded…") rather than
// as an `err.status` property, so the status check above never sees it. Pull a
// 3-digit code out of an "API Error: NNN" / "HTTP NNN" / "status NNN" phrasing so
// a provider overload surfaced as a plain Error is still classified transient.
const STATUS_IN_MESSAGE_RE = /\b(?:api error|http|status)\s*[:#]?\s*(\d{3})\b/i;

/** True when `err` looks like a transient infrastructure failure worth ONE
 *  retry. Bounded-recurses into `err.cause` (undici wraps the real cause). */
export function isTransientStepError(err: unknown, depth = 0): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (NON_RETRYABLE_RE.test(msg)) return false;
  const code = (err as { code?: string; status?: number; cause?: unknown } | null);
  if (code?.code && TRANSIENT_RE.test(code.code)) return true;
  if (typeof code?.status === 'number' && TRANSIENT_STATUS.has(code.status)) return true;
  if (TRANSIENT_RE.test(msg)) return true;
  const inMsg = msg.match(STATUS_IN_MESSAGE_RE);
  if (inMsg && TRANSIENT_STATUS.has(Number(inMsg[1]))) return true;
  // undici fetch / aggregate errors wrap the real transient cause one level down
  // (a `fetch failed` whose cause is ECONNRESET). Recurse, bounded, on the cause.
  if (depth < 3 && code?.cause && code.cause !== err) return isTransientStepError(code.cause, depth + 1);
  return false;
}
