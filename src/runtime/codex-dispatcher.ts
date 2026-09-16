/**
 * Codex-scoped undici dispatcher.
 *
 * Codex requests share a dedicated undici `Agent` with explicit headers and
 * body timeouts. undici's defaults leave both at several minutes, so a
 * connection an edge holds open without ever sending bytes would otherwise
 * sit on an open TCP socket for the life of the daemon.
 *
 * What each timeout is for:
 *   - The headers timeout is a liveness check on the request itself: a healthy
 *     backend answers with headers in a few seconds, so a window several times
 *     that is a down edge, not a slow one.
 *   - The body timeout guards the gap between SSE frames, including the
 *     provider-private reasoning frames that precede the first visible token
 *     and are never surfaced to the SDK. It is a dead-socket guard, never the
 *     owner-visible pace. A gap below a legitimate reasoning pause fires falsely,
 *     and every false fire re-pays the whole prefill on the retry. The pace the
 *     owner experiences is owned by the harness walls (the first-content
 *     fallover deadline and the stream-stall watchdog), which are brain-agnostic
 *     and sized to the prompt; this constant matches the between-event gap the
 *     other streaming adapters tolerate.
 *
 * Why a SCOPED dispatcher and not `setGlobalDispatcher`:
 *   MCP servers, tool fetches, and embedding calls legitimately run longer than
 *   a model's between-frame gap. A global timeout would cap them artificially,
 *   so the dispatcher option is passed only at the Codex fetch sites.
 */

import { Agent } from 'undici';
import { BoundaryError } from './boundary-error.js';

/** Codex must return response headers within this window after POST. */
export const CODEX_HEADERS_TIMEOUT_MS = 15_000;

/** At most this gap between SSE body bytes from Codex (a dead-socket guard;
 *  see the header comment). */
export const CODEX_BODY_TIMEOUT_MS = 120_000;

/**
 * Shared undici Agent for Codex fetches. Same instance reused across
 * all codex calls — undici handles connection pooling internally. Do
 * NOT call `setGlobalDispatcher` with this; we want it scoped.
 */
export const codexDispatcher = new Agent({
  headersTimeout: CODEX_HEADERS_TIMEOUT_MS,
  bodyTimeout: CODEX_BODY_TIMEOUT_MS,
});

/**
 * Detect undici headers/body timeout errors. These surface as
 * `TypeError: fetch failed` with `cause.code` set to the undici code,
 * OR (less commonly) with `code` set directly on the error.
 *
 * Returns the matching code string ('UND_ERR_HEADERS_TIMEOUT' |
 * 'UND_ERR_BODY_TIMEOUT'), or null if the error is something else.
 */
export type CodexTransportFailureCode =
  | 'UND_ERR_HEADERS_TIMEOUT'
  | 'UND_ERR_BODY_TIMEOUT'
  | 'FETCH_TERMINATED';

export function detectUndiciTimeout(err: unknown): 'UND_ERR_HEADERS_TIMEOUT' | 'UND_ERR_BODY_TIMEOUT' | null {
  if (!err || typeof err !== 'object') return null;
  const direct = (err as { code?: unknown }).code;
  const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;
  const code = (typeof direct === 'string' ? direct : undefined)
    ?? (typeof causeCode === 'string' ? causeCode : undefined);
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return code;
  }
  return null;
}

/**
 * Undici can also surface a dropped fetch body as a bare
 * `TypeError("terminated")` with no UND_ERR_* code. Treat that as the
 * same retryable Codex transport class, so the adapter's "retry only
 * before visible/tool output" safety gate can handle it.
 */
export function detectCodexTransportFailure(err: unknown): CodexTransportFailureCode | null {
  const timeoutCode = detectUndiciTimeout(err);
  if (timeoutCode) return timeoutCode;
  if (!err || typeof err !== 'object') return null;
  const message = err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? '');
  const cause = (err as { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error
    ? cause.message
    : typeof cause === 'object' && cause != null
      ? String((cause as { message?: unknown }).message ?? '')
      : '';
  if (message === 'terminated' || causeMessage === 'terminated') {
    return 'FETCH_TERMINATED';
  }
  return null;
}

/**
 * Construct the BoundaryError for a Codex transport-level timeout.
 * The harness loop's F4 ask-user routing recognizes
 * `codex.transport_timeout` and converts it to a Retry/Switch/Stop
 * card with retry_context populated from the most recent tool_called
 * event (loop.ts:2281).
 */
export function buildTransportTimeoutError(
  code: CodexTransportFailureCode,
  context: Record<string, unknown> = {},
  cause?: unknown,
): BoundaryError {
  const phase =
    code === 'UND_ERR_HEADERS_TIMEOUT'
      ? 'before any response headers'
      : code === 'UND_ERR_BODY_TIMEOUT'
        ? 'mid-stream after headers'
        : 'connection terminated by the fetch runtime';
  const budgetMs =
    code === 'UND_ERR_HEADERS_TIMEOUT'
      ? CODEX_HEADERS_TIMEOUT_MS
      : code === 'UND_ERR_BODY_TIMEOUT'
        ? CODEX_BODY_TIMEOUT_MS
        : null;
  return new BoundaryError({
    kind: 'codex.transport_timeout',
    retryable: true,
    userMessage: "Clementine's model backend stopped responding. Retry — if this persists, the Codex backend may be having an incident.",
    operatorMessage: budgetMs == null
      ? `Codex fetch terminated by undici (${phase}).`
      : `Codex fetch aborted by undici ${code} after ${budgetMs}ms (${phase}).`,
    context: { ...context, undiciCode: code, budgetMs },
    cause,
  });
}
