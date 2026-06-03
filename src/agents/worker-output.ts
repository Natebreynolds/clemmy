/**
 * Normalize a run_worker (Agent.asTool) result into a deterministic,
 * status-prefixed envelope so the orchestrator can tell done vs failed in
 * CODE (the `ERROR:`/`PARTIAL:` prefix it already keys on) instead of hoping
 * the worker's free text is honest.
 *
 * Wired as the `customOutputExtractor` on run_worker (behind
 * CLEMMY_WORKER_THRASH_GUARD). The key case it fixes: a worker that hit its
 * turn cap (FIX 1.2) or errored internally yields the SDK's generic
 * "An error occurred while running the tool…" string (or empty) — which today
 * reads as an ambiguous, possibly-successful result. We prepend `ERROR:` so a
 * capped/errored worker is reported as a FAILED item, never a hollow done.
 *
 * Total + pure: never throws. On any unexpected input it returns the raw text
 * so we can never LOSE a worker's real output by trying to classify it.
 */

const ERROR_PREFIX_RE = /^\s*ERROR:/i;
const PARTIAL_PREFIX_RE = /^\s*PARTIAL:/i;
// The string defaultToolErrorFunction returns when a worker run throws
// (MaxTurnsExceeded from the turn cap, or any internal tool error).
const SDK_GENERIC_ERROR_RE = /An error occurred while running the tool/i;

function extractText(res: unknown): string {
  if (typeof res === 'string') return res;
  if (res && typeof res === 'object') {
    const r = res as Record<string, unknown>;
    // The SDK passes the run result; prefer the same fields it would use.
    for (const key of ['finalOutput', 'rawOutputText', 'finalOutputText', 'output', 'text']) {
      const v = r[key];
      if (typeof v === 'string') return v;
    }
    try {
      return JSON.stringify(res);
    } catch {
      return String(res);
    }
  }
  return res == null ? '' : String(res);
}

/**
 * @param res the worker run result (string or SDK result object)
 * @returns a string whose FIRST token is `ERROR:`/`PARTIAL:` for non-success,
 *          or the worker's body verbatim for success.
 */
export function normalizeWorkerOutput(res: unknown): string {
  try {
    const text = extractText(res);
    const trimmed = text.trim();

    // Already a structured failure/partial — pass through verbatim.
    if (ERROR_PREFIX_RE.test(trimmed) || PARTIAL_PREFIX_RE.test(trimmed)) return text;

    // Worker produced nothing, or the SDK's generic tool-error string (the
    // turn-cap / internal-error path). Report it as a FAILED item.
    if (trimmed.length === 0 || SDK_GENERIC_ERROR_RE.test(trimmed)) {
      return `ERROR: worker did not complete this item (hit its turn cap or errored internally) — treat as failed and retry the item or report it as needs-attention.`;
    }

    // Success: hand back the worker's result unchanged.
    return text;
  } catch {
    // Never lose the output to a classification bug.
    return typeof res === 'string' ? res : String(res ?? '');
  }
}
