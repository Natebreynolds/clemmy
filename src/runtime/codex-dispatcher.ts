/**
 * Codex-scoped undici dispatcher.
 *
 * Codex requests share a dedicated undici `Agent` with tight headers
 * and body timeouts so a silently-stalled SSE stream fails fast
 * (within ~30s) instead of sitting on an open TCP connection until
 * the daemon is restarted. v0.5.21 Phase 2 root cause: undici defaults
 * are `headersTimeout: 300_000` and `bodyTimeout: 300_000` (5 min each),
 * and none of the Codex fetch sites set an explicit dispatcher. A
 * Cloudflare edge holding the connection open with no body bytes
 * therefore hung Discord chat indefinitely (verified 2026-05-25 on
 * sess-mplfm14j-f0985a98 — 3+ minutes of silence after `turn_started`).
 *
 * Why a SCOPED dispatcher and not `setGlobalDispatcher`:
 *   MCP servers, tool fetches (firecrawl, dataforseo), and embedding
 *   calls legitimately take longer than 30s. Setting a global timeout
 *   would cap them artificially. The dispatcher option is scoped to
 *   the 3 codex fetch sites only.
 *
 * Values calibrated against real telemetry from supervisor.log:
 *   - Healthy ttfbMs from `codex.codex-model` warn logs: ~2.6s worst
 *     case observed. 15s headers timeout gives 5× headroom.
 *   - Worst observed between-chunk gap on healthy streams: ~1-2s.
 *     30s body timeout gives 15× headroom — covers slow reasoning
 *     models (gpt-5.5 thinking gap before first content) without
 *     permitting indefinite stalls.
 */

import { Agent } from 'undici';
import { BoundaryError } from './boundary-error.js';

/** 15s — Codex must return response headers within this window after POST. */
export const CODEX_HEADERS_TIMEOUT_MS = 15_000;

/** 30s — at most this gap between SSE body bytes from Codex. */
export const CODEX_BODY_TIMEOUT_MS = 30_000;

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
 * Construct the BoundaryError for a Codex transport-level timeout.
 * The harness loop's F4 ask-user routing recognizes
 * `codex.transport_timeout` and converts it to a Retry/Switch/Stop
 * card with retry_context populated from the most recent tool_called
 * event (loop.ts:2281).
 */
export function buildTransportTimeoutError(
  code: 'UND_ERR_HEADERS_TIMEOUT' | 'UND_ERR_BODY_TIMEOUT',
  context: Record<string, unknown> = {},
  cause?: unknown,
): BoundaryError {
  const phase = code === 'UND_ERR_HEADERS_TIMEOUT' ? 'before any response headers' : 'mid-stream after headers';
  const budgetMs = code === 'UND_ERR_HEADERS_TIMEOUT' ? CODEX_HEADERS_TIMEOUT_MS : CODEX_BODY_TIMEOUT_MS;
  return new BoundaryError({
    kind: 'codex.transport_timeout',
    retryable: true,
    userMessage: "Clementine's model backend stopped responding. Retry — if this persists, the Codex backend may be having an incident.",
    operatorMessage: `Codex fetch aborted by undici ${code} after ${budgetMs}ms (${phase}).`,
    context: { ...context, undiciCode: code, budgetMs },
    cause,
  });
}
