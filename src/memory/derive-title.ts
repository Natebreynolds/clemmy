/**
 * Shared title derivation. Originally lived inline in
 * `src/gateway/router.ts` for background-task titles; extracted here so
 * the desktop chat path (auto-titling a conversation from its first
 * message) and the gateway use ONE implementation. No behavior change
 * for the gateway — it keeps the `'Background task'` fallback.
 */

/** Collapse whitespace, trim, and clip to `maxChars`. */
export function clean(value: string, maxChars = 200): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/**
 * Synthetic report-back head: `[background task bg-x completed] Optional title`
 * (see renderOutcomeText in src/runtime/outcome.ts — the prefix is a stable
 * idempotency contract). The closing bracket may be missing when a stored
 * title was clipped mid-head.
 */
const REPORT_BACK_HEAD_RE = /^\[(background task|workflow run)\s+(\S+)([^\n]*)/i;

/**
 * Turn a synthetic report-back text (or a stored title derived from one) into
 * a human title: "Background task: <headline>" / "Workflow run: <headline>".
 * Returns null when the text is not a report-back, so callers can fall through
 * to their normal derivation.
 */
export function humanizeReportBackTitle(text: string): string | null {
  const trimmed = text.trim();
  const match = REPORT_BACK_HEAD_RE.exec(trimmed);
  if (!match) return null;
  const label = match[1].toLowerCase() === 'workflow run' ? 'Workflow run' : 'Background task';
  // The headline is only what follows the closing `]` of the status word; a
  // stored title clipped mid-head has no `]`, and its trailing fragment is
  // truncated junk, not a title.
  const rest = match[3] ?? '';
  const closeIdx = rest.indexOf(']');
  const headline = closeIdx >= 0 ? clean(rest.slice(closeIdx + 1), 96) : '';
  if (headline) return `${label}: ${headline}`;
  // Head line carried no title — use the first body line (the summary).
  const body = trimmed.split('\n').slice(1).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const bodyLine = clean(body, 96);
  return bodyLine ? `${label}: ${bodyLine}` : label;
}

/**
 * Derive a short, human title from a message: strip a leading command
 * verb (`/run`, `bg`, …) and a polite preamble ("can you …"), then clip
 * to 120 chars. Empty/blank input falls back to `fallback`. Synthetic
 * report-back turns become "Background task: …" / "Workflow run: …"
 * instead of leaking their bracketed id prefix verbatim.
 */
export function deriveTitle(message: string, fallback = 'Background task'): string {
  const reportBack = humanizeReportBackTitle(message);
  if (reportBack) return reportBack;
  return clean(
    message
      .replace(/^\/?(background|bg|run|start|queue|plan)\b/i, '')
      .replace(/^(please|can you|could you|let'?s|i need you to|help me)\s+/i, '')
      .trim(),
    120,
  ) || fallback;
}
