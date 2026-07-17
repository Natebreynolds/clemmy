/**
 * Pure Composio action classifier shared by dispatch, retry, approval, and
 * runtime guardrail code. Keep this module dependency-free: the Composio
 * client imports it directly, so importing the harness or tool registry here
 * would create a cycle at the provider boundary.
 */

export type ComposioSlugEffect = 'read' | 'external_write';

const READ_ACTIONS: ReadonlySet<string> = new Set([
  'GET', 'LIST', 'SEARCH', 'FIND', 'FETCH', 'READ', 'QUERY', 'LOOKUP',
  'RETRIEVE', 'DESCRIBE', 'BROWSE', 'SCAN', 'VIEW', 'INSPECT', 'STATUS',
  'HEAD', 'PEEK', 'COUNT', 'SUMMARIZE', 'RECALL', 'OBSERVE', 'PREVIEW',
  'SHOW', 'CHECK', 'DISCOVER', 'PROBE', 'DETECT', 'ENUMERATE', 'AUDIT',
  'INTROSPECT',
]);

const WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'UPDATE', 'CREATE', 'INSERT', 'DELETE', 'REPLACE', 'APPEND', 'SEND',
  'PATCH', 'POST', 'WRITE', 'REMOVE', 'PUBLISH', 'UPLOAD', 'PUT', 'SET',
  'EDIT', 'MODIFY', 'SAVE', 'ARCHIVE', 'RESTORE', 'ADD', 'REGISTER',
  'UNREGISTER', 'SCHEDULE', 'UNSCHEDULE', 'DISPATCH', 'FORWARD', 'REPLY',
  'CALL', 'DIAL', 'OUTBOUND', 'TWEET', 'BROADCAST', 'DM',
  'MOVE', 'COPY', 'DUPLICATE', 'RENAME', 'ASSIGN', 'UNASSIGN', 'ATTACH',
  'DETACH', 'LINK', 'UNLINK', 'ACCEPT', 'REJECT', 'APPROVE', 'DECLINE',
  'INVITE', 'CANCEL', 'ENABLE', 'DISABLE',
]);

function actionTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** `CALL` is ambiguous: it can be the action (place a call) or the object being
 * read (`GONG_GET_CALL_TRANSCRIPT`). A concrete read verb wins only when CALL
 * is the sole write-shaped token. Mixed actions such as FIND_OR_CREATE_CALL
 * remain writes. Exported so native MCP and execution-gate classification use
 * the same production-name rule as the Composio gateway. */
export function isReadOnlyCallAction(value: string | null | undefined): boolean {
  const tokens = actionTokens(String(value ?? ''));
  if (!tokens.includes('CALL') || !tokens.some((token) => READ_ACTIONS.has(token))) return false;
  return !tokens.some((token) => WRITE_ACTIONS.has(token) && token !== 'CALL');
}

/**
 * Classify the user-visible effect of a Composio action slug.
 *
 * Provider-side research jobs are reads even when their implementation uses a
 * CREATE/POST endpoint. For every other toolkit, an explicit write token wins
 * over a read token so mixed actions such as FIND_OR_CREATE cannot bypass
 * mutation controls. Missing and unfamiliar action names remain conservative.
 */
export function classifyComposioSlugEffect(slug: string | null | undefined): ComposioSlugEffect {
  const upper = String(slug ?? '').trim().toUpperCase();
  if (!upper) return 'external_write';

  if (
    upper.startsWith('DATAFORSEO_')
    || /^FIRECRAWL_(BATCH_)?(?:SCRAPE|MAP|SEARCH|CRAWL)(?:_|$)/.test(upper)
  ) {
    return 'read';
  }

  const tokens = actionTokens(upper);
  if (isReadOnlyCallAction(upper)) return 'read';
  if (tokens.some((token) => WRITE_ACTIONS.has(token))) return 'external_write';
  if (tokens.some((token) => READ_ACTIONS.has(token))) return 'read';
  return 'external_write';
}

export function composioSlugIsReadOnly(slug: string | null | undefined): boolean {
  return classifyComposioSlugEffect(slug) === 'read';
}
