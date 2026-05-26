import { writeToolOutput } from './eventlog.js';
import { getToolOutputContext } from './tool-output-context.js';

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 4000;

export interface RecallableToolTextOptions {
  maxChars?: number;
  toolName?: string | null;
  sessionId?: string;
  callId?: string;
}

export function truncateToolText(text: string, maxChars: number = DEFAULT_TOOL_RESULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const dropped = text.length - maxChars;
  return `${head}\n\n…[truncated — ${dropped.toLocaleString()} of ${text.length.toLocaleString()} chars omitted; re-call with a narrower scope (offset/limit, filter, specific query) if you need the rest]`;
}

/**
 * Canonical model-facing tool-output formatter.
 *
 * If a harness session + call id is available, this stores the full
 * output in `tool_outputs` before returning a small prompt-safe stub
 * that tells the model exactly how to recover the original with
 * `recall_tool_result`. Without call context it falls back to a plain
 * truncation marker, which is the best a detached MCP/dev path can do.
 */
export function formatRecallableToolText(
  text: string,
  options: RecallableToolTextOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  if (text.length <= maxChars) return text;

  const active = getToolOutputContext();
  const sessionId = options.sessionId ?? active?.sessionId;
  const callId = options.callId ?? active?.callId;
  const toolName = options.toolName ?? active?.toolName ?? 'tool';

  if (!sessionId || !callId) {
    return truncateToolText(text, maxChars);
  }

  try {
    writeToolOutput({
      sessionId,
      callId,
      tool: toolName,
      output: text,
    });
  } catch {
    return truncateToolText(text, maxChars);
  }

  const iso = new Date().toISOString();
  return `${text.slice(0, maxChars)}\n[clipped: ${toolName} returned ${text.length} chars at ${iso} — call recall_tool_result("${callId}") for full output]`;
}
