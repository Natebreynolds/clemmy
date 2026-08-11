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
 *  "Sent a message to paul@…", "Created a record", "Saved a file". Derived from
 *  the action's verb CONSEQUENCE plus the write's recorded `irreversible` bit,
 *  never an ordered slug-regex chain (the chain rendered OUTLOOK_UPDATE_EMAIL
 *  and SLACK_DELETE_MESSAGE as "Sent a message" — live 2026-08). Mirrors the
 *  server's describeExternalWrite (src/runtime/harness/work-report.ts) so the
 *  live feed and the report-back message read identically; console-web cannot
 *  import server code, so the parity test in
 *  src/runtime/harness/work-report-effect-truth.test.ts pins the two copies
 *  phrase-identical. A write recorded reversible may never render as delivery. */
const CW_DELETE_VERBS = new Set(['DELETE', 'REMOVE', 'TRASH', 'DESTROY', 'ARCHIVE', 'UNREGISTER']);
const CW_SEND_VERBS = new Set(['SEND', 'DISPATCH', 'POST', 'PUBLISH', 'BROADCAST', 'FORWARD', 'REPLY', 'DM', 'TWEET', 'CALL', 'DIAL', 'INVITE']);
const CW_UPDATE_VERBS = new Set(['UPDATE', 'EDIT', 'PATCH', 'MODIFY', 'REPLACE', 'SET', 'RENAME', 'MOVE', 'APPEND', 'SAVE']);
const CW_CREATE_VERBS = new Set(['CREATE', 'INSERT', 'ADD', 'NEW', 'DUPLICATE', 'COPY', 'UPLOAD', 'REGISTER']);

function cwActionTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

export function describeExternalWrite(
  shapeKey: string | undefined,
  toolName: string,
  targets: string[],
  write?: { irreversible?: boolean; actionKey?: string },
): string {
  const key = shapeKey || write?.actionKey || toolName || 'action';
  const to = targets.length
    ? ` to ${targets.slice(0, 3).join(', ')}${targets.length > 3 ? ` (+${targets.length - 3} more)` : ''}`
    : '';
  const tokens = cwActionTokens(key);
  const has = (token: string): boolean => tokens.includes(token);
  const deliveryAllowed = write?.irreversible !== false;
  const fileShaped = has('UPLOAD') || has('SAVE') || has('WRITE') || has('FILE');
  const fallback = `Ran ${key.toLowerCase().replace(/[_:]/g, ' ')}${to}`;
  const consequence = tokens.some((t) => CW_DELETE_VERBS.has(t)) ? 'delete'
    : tokens.some((t) => CW_SEND_VERBS.has(t)) ? 'send'
      : tokens.some((t) => CW_UPDATE_VERBS.has(t)) ? 'update'
        : tokens.some((t) => CW_CREATE_VERBS.has(t)) ? 'create'
          : 'other';

  if ((has('DRAFT') || has('DRAFTS')) && !has('SEND') && !has('PUBLISH')) {
    return consequence === 'update' ? `Updated a draft${to}` : `Created a draft${to}`;
  }
  switch (consequence) {
    case 'delete':
      return `Deleted a record${to}`;
    case 'send':
      if (!deliveryAllowed) return fallback;
      return has('PUBLISH') || has('POST') || has('TWEET') ? `Published a post${to}` : `Sent a message${to}`;
    case 'update':
      return fileShaped ? `Saved a file${to}` : `Updated a record${to}`;
    case 'create':
      return fileShaped ? `Saved a file${to}` : `Created a record${to}`;
    default:
      return fileShaped ? `Saved a file${to}` : fallback;
  }
}

/** Human label for a tool call: composio calls read as their inner slug
 *  ("outlook send email"), MCP calls drop the server prefix, underscores drop.
 *  `publicSlug` is the runtime-validated dispatch identity the public event
 *  plane attaches (raw args are private there) — it wins when present, so the
 *  live strip says "outlook send email" instead of "composio execute tool". */
export function humanToolLabel(tool: string, argsRaw?: unknown, publicSlug?: unknown, innerTool?: unknown): string {
  if (typeof publicSlug === 'string' && publicSlug) {
    return publicSlug.replace(/_/g, ' ').toLowerCase();
  }
  // call_tool / run_tool_program wrap an inner tool; show the real inner name
  // (runtime-validated `effectiveTool`) instead of the anonymous wrapper.
  if (typeof innerTool === 'string' && innerTool) {
    return innerTool.replace(/_/g, ' ').toLowerCase();
  }
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
