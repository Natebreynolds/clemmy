/**
 * Parser for the Workflow Architect's structured diff output.
 *
 * The architect's reply is prose followed (optionally) by a single
 * fenced ```json block carrying { ops, summary }. This module extracts
 * the diff cleanly from prose so the UI can render either a diff card
 * (when ops are present) or a plain message (when the architect was
 * just answering a question).
 *
 * Lossless on failure: a missing or unparseable JSON block returns
 * { text: rawTrimmed, diff: null } — the chat falls back to plain text
 * rendering, never crashes.
 *
 * Lives in its own file so the parsing logic stays unit-testable
 * without pulling the full console-routes Express handler graph into
 * the test runtime.
 */

export interface ArchitectDiff {
  ops: unknown[];
  summary?: string;
}

const FENCE_REGEX = /```json\s*([\s\S]*?)```\s*$/i;

export function extractArchitectDiff(raw: string): { text: string; diff: ArchitectDiff | null } {
  if (!raw) return { text: '', diff: null };
  const match = raw.match(FENCE_REGEX);
  if (!match) return { text: raw.trim(), diff: null };
  const jsonText = match[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { text: raw.trim(), diff: null };
  }
  if (!parsed || typeof parsed !== 'object') return { text: raw.trim(), diff: null };
  const obj = parsed as { ops?: unknown; summary?: unknown };
  if (!Array.isArray(obj.ops) || obj.ops.length === 0) {
    // Empty ops is treated as no diff — strip the block from prose
    // anyway so the user doesn't see a useless empty fence.
    return { text: raw.replace(FENCE_REGEX, '').trim(), diff: null };
  }
  return {
    text: raw.replace(FENCE_REGEX, '').trim(),
    diff: {
      ops: obj.ops,
      summary: typeof obj.summary === 'string' ? obj.summary : undefined,
    },
  };
}
