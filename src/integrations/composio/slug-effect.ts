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

/** Write-shaped tokens that are just as often the OBJECT being read: a phone
 * call (`GONG_GET_CALL_TRANSCRIPT`) or a social post (`TWITTER_GET_POST`).
 * They count as writes only when no read verb anchors the action. */
const AMBIGUOUS_OBJECT_TOKENS: ReadonlySet<string> = new Set(['CALL', 'POST']);

/** Read tokens that are commonly a trailing STATE/NOUN rather than the action:
 * `GMAIL_MARK_AS_READ` mutates, `…_UPDATE_VIEW` mutates, `RUN_CHECK` acts. A
 * read token in FINAL position is only trusted when it cannot be a state noun
 * (`GMAIL_SEARCH`, `NOTION_GET`). */
const STATE_NOUN_READ_TOKENS: ReadonlySet<string> = new Set([
  'READ', 'VIEW', 'STATUS', 'PREVIEW', 'CHECK', 'AUDIT', 'HEAD', 'PEEK',
]);

/**
 * Classify the user-visible effect of a Composio action slug.
 *
 * Provider-side research jobs are reads even when their implementation uses a
 * CREATE/POST endpoint. For every other toolkit, an unambiguous write token
 * wins so mixed actions such as FIND_OR_CREATE cannot bypass mutation
 * controls; a read token is trusted only in ACTION position (fold 2026-07-17,
 * review wf_30a7ce7e-e9c #3/#5: `GMAIL_MARK_AS_READ` must never classify read
 * — MARK is not a known write verb and READ is a trailing state word — while
 * `TWITTER_GET_POST` must never classify write — POST there is the object).
 * Missing and unfamiliar action names remain conservative writes.
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
  // An unambiguous write verb anywhere is a mutation, full stop.
  if (tokens.some((token) => WRITE_ACTIONS.has(token) && !AMBIGUOUS_OBJECT_TOKENS.has(token))) {
    return 'external_write';
  }
  // A read verb is trusted as the ACTION when it is not a trailing state noun.
  const readIndex = tokens.findIndex((token) => READ_ACTIONS.has(token));
  const trustedRead = readIndex >= 0
    && (readIndex < tokens.length - 1 || !STATE_NOUN_READ_TOKENS.has(tokens[readIndex] ?? ''));
  if (trustedRead) return 'read';
  // Bare CALL/POST actions (no anchoring read verb) are outbound writes.
  if (tokens.some((token) => AMBIGUOUS_OBJECT_TOKENS.has(token))) return 'external_write';
  return 'external_write';
}

export function composioSlugIsReadOnly(slug: string | null | undefined): boolean {
  return classifyComposioSlugEffect(slug) === 'read';
}
