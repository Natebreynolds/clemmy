/**
 * Shared humanizers for tool calls, used by BOTH the chat activity strip
 * (lib/useChat) and the board's live trace drawer, so a tool call reads the
 * same everywhere — "outlook send email → paul@…", never a raw
 * "composio_execute_tool" or a synthetic "reflection end" row.
 */

/**
 * Synthetic / housekeeping "tools" the brain emits for its own bookkeeping
 * (reflection, tool-choice scoring, workflow-pattern mining). They are not real
 * actions and must never surface in a user-facing tool feed. Mirrors the
 * backend observatory's SYNTHETIC_TOOL_EVENTS set.
 */
export const HOUSEKEEPING_TOOLS = new Set(['reflection', 'recursive_reflection', 'tool_choice', 'workflow_pattern']);

export function isHousekeepingTool(name: string | undefined | null): boolean {
  if (!name) return false;
  return HOUSEKEEPING_TOOLS.has(name.trim().toLowerCase());
}

/** The one salient thing this call is ABOUT — recipient, keyword, path, query —
 *  so the strip narrates "sending email → paul@…" instead of a bare wrench name.
 *  Best-effort over the event's truncated args preview; '' when nothing salient. */
export function salientArgDetail(argsRaw: unknown): string {
  if (typeof argsRaw !== 'string' || !argsRaw) return '';
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(argsRaw) as Record<string, unknown>; } catch { return ''; }
  // composio_execute_tool nests the real payload under `arguments` (a JSON string).
  if (typeof parsed.arguments === 'string') {
    try { parsed = { ...parsed, ...(JSON.parse(parsed.arguments) as Record<string, unknown>) }; } catch { /* keep outer */ }
  }
  const SALIENT_KEYS = ['to', 'recipient', 'recipient_email', 'recipients', 'subject', 'keyword', 'keywords', 'query', 'q', 'path', 'url', 'target', 'domain', 'name', 'title'];
  for (const key of SALIENT_KEYS) {
    const v = parsed[key];
    const text = typeof v === 'string' ? v : Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(', ') : '';
    if (text.trim()) return text.trim().slice(0, 64);
  }
  return '';
}

/** Humanize ONE recorded external write into a plain, short feed line —
 *  "Sent a message to paul@…", "Created a record", "Saved a file". Keyed off the
 *  write's shapeKey/slug (SEND / CREATE / UPDATE / …), never a specific tool name,
 *  so it covers email, chat, SMS, CRM, files. Mirrors the server's
 *  describeExternalWrite (src/runtime/harness/work-report.ts) so the live feed and
 *  the report-back message read identically. */
export function describeExternalWrite(shapeKey: string | undefined, toolName: string, targets: string[]): string {
  const key = (shapeKey || toolName || 'action').toUpperCase();
  const to = targets.length
    ? ` to ${targets.slice(0, 3).join(', ')}${targets.length > 3 ? ` (+${targets.length - 3} more)` : ''}`
    : '';
  if (/DRAFT/.test(key) && !/SEND|PUBLISH/.test(key)) return `Created a draft${to}`;
  if (/SEND|EMAIL|DELIVER|DISPATCH|DM\b|MESSAGE|SMS|TEXT/.test(key)) return `Sent a message${to}`;
  if (/PUBLISH|POST|TWEET/.test(key)) return `Published a post${to}`;
  if (/CREATE|ADD|INSERT|UPSERT/.test(key)) return `Created a record${to}`;
  if (/UPDATE|PATCH|EDIT|MODIFY|SET_/.test(key)) return `Updated a record${to}`;
  if (/DELETE|REMOVE|ARCHIVE|TRASH/.test(key)) return `Deleted a record${to}`;
  if (/UPLOAD|SAVE|WRITE/.test(key)) return `Saved a file${to}`;
  return `Ran ${key.toLowerCase().replace(/_/g, ' ')}${to}`;
}

/** Human label for a tool call: composio calls read as their inner slug
 *  ("outlook send email"), MCP calls drop the server prefix, underscores drop. */
export function humanToolLabel(tool: string, argsRaw?: unknown): string {
  if (tool === 'composio_execute_tool' && typeof argsRaw === 'string') {
    try {
      const slug = (JSON.parse(argsRaw) as { tool_slug?: unknown }).tool_slug;
      if (typeof slug === 'string' && slug) return slug.replace(/_/g, ' ').toLowerCase();
    } catch { /* fall through */ }
  }
  // `server__tool` names render as "server · tool"; `mcp__server__tool` drops
  // the mcp prefix first. Single underscores become spaces.
  const stripped = tool.replace(/^mcp__/, '');
  return stripped.split('__').map((part) => part.replace(/_/g, ' ')).filter(Boolean).join(' · ');
}
