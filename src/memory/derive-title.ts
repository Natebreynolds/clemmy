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
 * Derive a short, human title from a message: strip a leading command
 * verb (`/run`, `bg`, …) and a polite preamble ("can you …"), then clip
 * to 120 chars. Empty/blank input falls back to `fallback`.
 */
export function deriveTitle(message: string, fallback = 'Background task'): string {
  return clean(
    message
      .replace(/^\/?(background|bg|run|start|queue|plan)\b/i, '')
      .replace(/^(please|can you|could you|let'?s|i need you to|help me)\s+/i, '')
      .trim(),
    120,
  ) || fallback;
}
