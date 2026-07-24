/**
 * Pure Composio action classifier shared by dispatch, retry, approval, and
 * runtime guardrail code. Keep this module dependency-free: the Composio
 * client imports it directly, so importing the harness or tool registry here
 * would create a cycle at the provider boundary.
 */

export type ComposioSlugEffect = 'read' | 'external_write';

/** Evidence-grade classification: 'read' and 'write' are affirmative verb
 * evidence; 'unknown' means the action name carries no recognized verb at all
 * (noun-shaped API slugs such as SLACK_CONVERSATIONS_HISTORY). Consumers that
 * honor an author-declared `sideEffect: read` may do so only for 'unknown' —
 * never against affirmative write/send evidence. */
export type ComposioSlugEffectEvidence = 'read' | 'write' | 'unknown';

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
 * Workflow effect-classification review: `GMAIL_MARK_AS_READ` must never classify read
 * — MARK is not a known write verb and READ is a trailing state word — while
 * `TWITTER_GET_POST` must never classify write — POST there is the object).
 * Missing and unfamiliar action names remain conservative writes.
 */
export function classifyComposioSlugEffect(slug: string | null | undefined): ComposioSlugEffect {
  return composioSlugEffectEvidence(slug) === 'read' ? 'read' : 'external_write';
}

/**
 * Same verb analysis as classifyComposioSlugEffect, but keeps "an affirmative
 * write verb is present" distinct from "no recognized verb at all". A blank
 * slug is 'unknown' (nothing to prove either way); a bare CALL/POST action
 * with no anchoring read verb is affirmative 'write' (outbound), matching the
 * 2026-07-09 send-gate incident rule.
 */
export function composioSlugEffectEvidence(slug: string | null | undefined): ComposioSlugEffectEvidence {
  const upper = String(slug ?? '').trim().toUpperCase();
  if (!upper) return 'unknown';

  if (
    upper.startsWith('DATAFORSEO_')
    || /^FIRECRAWL_(BATCH_)?(?:SCRAPE|MAP|SEARCH|CRAWL)(?:_|$)/.test(upper)
  ) {
    return 'read';
  }

  const tokens = actionTokens(upper);
  // EPHEMERAL COMPUTE (live 2026-07-24): "CREATE" + a compute noun creates no
  // durable external state — OPENAI_CREATE_CHAT_COMPLETION produces a model
  // RESPONSE, not a record. Treating it as a write dragged the execution-wrap
  // ceremony onto every inference batch through the Composio OpenAI lane.
  // Principled noun rule (like STATE_NOUN_READ_TOKENS), not a tool list.
  const COMPUTE_NOUNS = new Set(['COMPLETION', 'COMPLETIONS', 'EMBEDDING', 'EMBEDDINGS', 'MODERATION', 'MODERATIONS', 'TRANSCRIPTION', 'TRANSCRIPTIONS', 'TRANSLATION', 'TRANSLATIONS']);
  const lastToken = tokens[tokens.length - 1] ?? '';
  if (COMPUTE_NOUNS.has(lastToken) && tokens.some((token) => token === 'CREATE' || token === 'GENERATE' || token === 'RUN')) {
    return 'read';
  }
  // An unambiguous write verb anywhere is a mutation, full stop.
  if (tokens.some((token) => WRITE_ACTIONS.has(token) && !AMBIGUOUS_OBJECT_TOKENS.has(token))) {
    return 'write';
  }
  // A read verb is trusted as the ACTION when it is not a trailing state noun.
  const readIndex = tokens.findIndex((token) => READ_ACTIONS.has(token));
  if (readIndex >= 0) {
    const trustedRead = readIndex < tokens.length - 1 || !STATE_NOUN_READ_TOKENS.has(tokens[readIndex] ?? '');
    if (trustedRead) return 'read';
    // A read token present only as a trailing STATE noun (GMAIL_MARK_AS_READ,
    // SLACK_MARK_CHANNEL_READ, SOMETOOL_RUN_CHECK) means the action mutates
    // that state — a conservative write, NOT a declaration-trusted unknown.
    return 'write';
  }
  // Bare CALL/POST actions (no anchoring read verb) are outbound writes.
  if (tokens.some((token) => AMBIGUOUS_OBJECT_TOKENS.has(token))) return 'write';
  // No recognized read/write/ambiguous token at all: a pure noun endpoint such
  // as SLACK_CONVERSATIONS_HISTORY or TWITTER_USER_TIMELINE. Genuinely unknown
  // — a caller's declared `sideEffect: read` is the best available signal, so
  // an existing declared-read workflow keeps validating (fold 2026-07-17 #4).
  return 'unknown';
}

export function composioSlugIsReadOnly(slug: string | null | undefined): boolean {
  return classifyComposioSlugEffect(slug) === 'read';
}

/** Does the slug carry an AFFIRMATIVE write verb (SEND/CREATE/UPDATE/…)?
 *  Narrower than composioSlugEffectEvidence === 'write': the trailing
 *  state-noun rule conservatively classifies GMAIL_MARK_AS_READ and
 *  FIRECRAWL_BATCH_STATUS as writes for the APPROVAL gates, but the
 *  loop-guardrail's poll exemption (advisory realm only) needs the stricter
 *  question — is there a real write verb here at all. */
export function slugHasAffirmativeWriteVerb(slug: string | null | undefined): boolean {
  const tokens = actionTokens(String(slug ?? '').trim().toUpperCase());
  return tokens.some((token) => WRITE_ACTIONS.has(token) && !AMBIGUOUS_OBJECT_TOKENS.has(token));
}
