/**
 * Pure Composio action classifier shared by dispatch, retry, approval, and
 * runtime guardrail code. Keep this module dependency-free: the Composio
 * client imports it directly, so importing the harness or tool registry here
 * would create a cycle at the provider boundary.
 */

import {
  documentedComposioOperationSemantic,
} from './operation-semantics.js';

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

/**
 * The CONSEQUENCE class an action's own declared verb implies.
 *
 * `classifyComposioSlugEffect` answers read-or-write, which is the right
 * question for gating but too coarse for a choice: creating a new record and
 * updating an existing one are both "write", and they are not interchangeable
 * outcomes. A caller that asked to change something and is offered only a way
 * to make something new is being offered a materially different result, and
 * that difference should be visible as DATA rather than discovered afterwards.
 *
 * Derived from the action's own tokens against the same verb evidence the
 * effect classifier uses — no provider names, no slug lists, no per-tool rules.
 * Unknown verbs stay unknown rather than being guessed into a class.
 */
export type ComposioActionConsequence = 'read' | 'create' | 'update' | 'delete' | 'send' | 'other';

const CREATE_VERBS: ReadonlySet<string> = new Set(['CREATE', 'INSERT', 'ADD', 'NEW', 'DUPLICATE', 'COPY', 'UPLOAD', 'REGISTER']);
const UPDATE_VERBS: ReadonlySet<string> = new Set(['UPDATE', 'EDIT', 'PATCH', 'MODIFY', 'REPLACE', 'SET', 'RENAME', 'MOVE', 'APPEND', 'SAVE']);
const DELETE_VERBS: ReadonlySet<string> = new Set(['DELETE', 'REMOVE', 'TRASH', 'DESTROY', 'ARCHIVE', 'UNREGISTER']);
const SEND_VERBS: ReadonlySet<string> = new Set(['SEND', 'DISPATCH', 'POST', 'PUBLISH', 'BROADCAST', 'FORWARD', 'REPLY', 'DM', 'TWEET', 'CALL', 'DIAL', 'INVITE']);

export function classifyComposioActionConsequence(
  slug: string | null | undefined,
): ComposioActionConsequence {
  if (!slug) return 'other';
  const documented = documentedComposioOperationSemantic(slug);
  if (documented) return documented.consequence;
  const tokens = actionTokens(slug);
  // Most specific consequence wins; a slug naming several verbs is judged by
  // the most consequential one it declares.
  if (tokens.some((t) => DELETE_VERBS.has(t))) return 'delete';
  if (tokens.some((t) => SEND_VERBS.has(t))) return 'send';
  if (tokens.some((t) => UPDATE_VERBS.has(t))) return 'update';
  if (tokens.some((t) => CREATE_VERBS.has(t))) return 'create';
  if (tokens.some((t) => READ_ACTIONS.has(t))) return 'read';
  return 'other';
}

export function actionTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/**
 * An action whose object is a DRAFT that stays unsent: CREATE_DRAFT /
 * UPDATE_DRAFT compose, SEND_DRAFT / PUBLISH_DRAFT dispatch the composed
 * draft. Token rule mirrors the irreversible-send chokepoint
 * (execution-gate.ts isIrreversibleSendSlug) so the two classifiers can never
 * disagree about which side of the send boundary a draft action sits on.
 */
export function actionTargetsUnsentDraft(slug: string | null | undefined): boolean {
  if (!slug) return false;
  const tokens = actionTokens(slug);
  if (!tokens.includes('DRAFT') && !tokens.includes('DRAFTS')) return false;
  return !tokens.includes('SEND') && !tokens.includes('PUBLISH');
}

const DATAFORSEO_RESEARCH_NAMESPACES: ReadonlySet<string> = new Set([
  'SERP',
  'LABS',
  'BACKLINK',
  'BACKLINKS',
]);

/** DataForSEO exposes research through both synchronous reads and provider-side
 * TASK_POST jobs. Exempt only those structural research namespaces: the old
 * `DATAFORSEO_*` blanket let unfamiliar mutations such as SET_CREDENTIALS and
 * ENABLE_WEBHOOK bypass every external-write boundary. CREATE/POST are read-job
 * transport vocabulary only for a terminal TASK(S)_POST shape; every other
 * affirmative write token wins. */
export function dataForSeoResearchActionIsReadOnly(slug: string | null | undefined): boolean {
  const upper = String(slug ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase();
  if (!/^DATAFORSEO_(?:DATAFORSEO_)?/.test(upper)) return false;
  const tokens = actionTokens(upper);
  while (tokens[0] === 'DATAFORSEO') tokens.shift();
  const namespaceIndex = tokens.findIndex((token) => DATAFORSEO_RESEARCH_NAMESPACES.has(token));
  const structurallyResearch = namespaceIndex === 0
    || (
      namespaceIndex === 1
      && (READ_ACTIONS.has(tokens[0] ?? '') || tokens[0] === 'CREATE')
    );
  if (!structurallyResearch) return false;

  const writeTokens = tokens.filter((token) => WRITE_ACTIONS.has(token));
  if (writeTokens.length === 0) return true;
  const taskPost = tokens.at(-1) === 'POST'
    && tokens.some((token) => token === 'TASK' || token === 'TASKS');
  return taskPost && writeTokens.every((token) => token === 'CREATE' || token === 'POST');
}

const FIRECRAWL_READ_JOB_FAMILY = /^FIRECRAWL_(?:FIRECRAWL_)?(?:BATCH_)?(?:SCRAPE|MAP|SEARCH|CRAWL)(?:_|$)/;

/** Firecrawl's scrape/map/search/crawl actions are external reads, including
 * BATCH_SCRAPE provider jobs. Family membership alone is not authority to
 * downgrade a mutation: mixed names such as SCRAPE_AND_PUBLISH and
 * CRAWL_AND_DELETE must retain their external-write effect everywhere this
 * shared classifier is consumed (approval, retries, and dispatch). */
export function firecrawlResearchActionIsReadOnly(slug: string | null | undefined): boolean {
  const upper = String(slug ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase();
  if (!FIRECRAWL_READ_JOB_FAMILY.test(upper)) return false;
  return !actionTokens(upper).some((token) => WRITE_ACTIONS.has(token));
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

const EPHEMERAL_COMPUTE_NOUNS: ReadonlySet<string> = new Set([
  'COMPLETION', 'COMPLETIONS', 'EMBEDDING', 'EMBEDDINGS',
  'MODERATION', 'MODERATIONS', 'TRANSCRIPTION', 'TRANSCRIPTIONS',
  'TRANSLATION', 'TRANSLATIONS',
]);

/** A nondeterministic inference/transform action that creates no durable
 * provider record. It is read-class for approval purposes, but it is not a
 * snapshot read: two identical calls may intentionally produce independent
 * samples and therefore must never enter settled-read replay. */
export function composioActionIsEphemeralCompute(slug: string | null | undefined): boolean {
  const tokens = actionTokens(String(slug ?? '').trim().toUpperCase());
  const lastToken = tokens[tokens.length - 1] ?? '';
  return EPHEMERAL_COMPUTE_NOUNS.has(lastToken)
    && tokens.some((token) => token === 'CREATE' || token === 'GENERATE' || token === 'RUN');
}

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
/**
 * Whether a READ verdict for this exact slug comes from a CURATED provider
 * rule rather than generic verb inference.
 *
 * Curated rules (documented semantics, the DataForSEO/Firecrawl research
 * families, ephemeral compute) are exact provider knowledge and legitimately
 * key on the provider-qualified slug — `DATAFORSEO_SERP_*` is only meaningful
 * with its toolkit token. Generic verb inference is different: it must never
 * see a namespace the user chose, because a read verb in an arbitrary MCP
 * server name would prove its destructive tools read-only (2026-08-21).
 */
export function composioSlugHasCuratedReadRule(slug: string | null | undefined): boolean {
  const upper = String(slug ?? '').trim().toUpperCase();
  if (!upper) return false;
  if (documentedComposioOperationSemantic(upper)?.effect === 'read') return true;
  return dataForSeoResearchActionIsReadOnly(upper)
    || firecrawlResearchActionIsReadOnly(upper)
    || composioActionIsEphemeralCompute(upper);
}

export function composioSlugEffectEvidence(slug: string | null | undefined): ComposioSlugEffectEvidence {
  const upper = String(slug ?? '').trim().toUpperCase();
  if (!upper) return 'unknown';

  const documented = documentedComposioOperationSemantic(upper);
  // A documented noun-shaped WRITE is affirmative effect evidence. Keep a
  // noun-shaped READ at `unknown` in this low-level verb-evidence API: callers
  // that accept author-declared reads depend on that distinction, while the
  // canonical external-effect classifier consumes the full documented
  // descriptor and can affirm the read directly.
  if (documented?.effect === 'write') return 'write';

  if (dataForSeoResearchActionIsReadOnly(upper)) {
    return 'read';
  }

  const tokens = actionTokens(upper);
  if (firecrawlResearchActionIsReadOnly(upper)) {
    return 'read';
  }
  // EPHEMERAL COMPUTE (live 2026-07-24): "CREATE" + a compute noun creates no
  // durable external state — OPENAI_CREATE_CHAT_COMPLETION produces a model
  // RESPONSE, not a record. Treating it as a write dragged the execution-wrap
  // ceremony onto every inference batch through the Composio OpenAI lane.
  // Principled noun rule (like STATE_NOUN_READ_TOKENS), not a tool list.
  if (composioActionIsEphemeralCompute(upper)) {
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
