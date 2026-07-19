/**
 * Execution-wrap gate (v0.5.20 audit + safety).
 *
 * Forces Clem to wrap mutating external writes in an execution lane
 * BEFORE the write fires. Rationale (from real failure 2026-05-24,
 * execution-gate regression): a multi-step Google Sheets selection wrote 123 cells
 * across two composio_execute_tool calls with no execution wrapping.
 * Audit trail of "why was row 51 dropped?" lived only in a python
 * heredoc in run_shell_command. Mid-session resume would have lost
 * the work; querying "what did Clem do this week?" against the
 * execution registry returned nothing.
 *
 * Decision model:
 *   1. Is the tool call a mutating external write? (defined below)
 *   2. Is there an active execution for this session?
 *   3. Is this an exempt tool (execution_*, planner, approval helpers)?
 *
 * If (1) is true AND (2) is false AND (3) is false → throw
 * `MissingExecutionWrapError`. The harness surfaces this as a tool
 * error; Clem sees the message + the suggested fix (call execution_create
 * first) and the loop continues with that recovery hint.
 *
 * Hard-block design: a soft warning is
 * ignorable; the model can keep writing without wrapping. A hard
 * block forces the audit trail to exist.
 *
 * Env flag (escape hatch): `CLEMMY_EXECUTION_GATE=off` bypasses
 * the gate entirely. Useful for debugging or for users who explicitly
 * want the prior behavior. Default ON.
 *
 * Tested as pure logic in execution-gate.test.ts (no SDK, no DB).
 */

import { isReadOnlyCallAction } from '../../integrations/composio/slug-effect.js';

/**
 * Verbs in a Composio tool_slug that indicate external state mutation.
 * Conservative: when a tool slug contains any of these as a path
 * segment, treat as a write. False positives are acceptable (creates
 * a slightly-unnecessary audit trail); false negatives are not
 * (lets an un-audited write slip past the gate).
 */
const MUTATING_VERBS: ReadonlySet<string> = new Set([
  'UPDATE',
  'CREATE',
  'INSERT',
  'DELETE',
  'REPLACE',
  'APPEND',
  'SEND',
  'PATCH',
  'POST',
  'WRITE',
  'REMOVE',
  'PUBLISH',
  'BATCH', // BATCH_UPDATE, BATCH_DELETE, etc — slug starts with BATCH
  // Telephony / social publishes — irreversible external actions whose slugs
  // (TWILIO_MAKE_OUTBOUND_CALL, *_DIAL, *_BROADCAST) carry no CREATE/SEND verb
  // (2026-07-09 Hole B). Kept in sync with confirm-first IRREVERSIBLE_VERBS.
  'CALL',
  'DIAL',
  'OUTBOUND',
  'TWEET',
  'BROADCAST',
  'DM',
]);

/**
 * Composio tool slugs that LOOK mutating by verb but aren't actually
 * user-data mutations. Today this is just DataForSEO's task creation
 * (queueing a SERP/backlinks job is read-only from the user's
 * perspective — it doesn't write to any persistent user store).
 */
const EXEMPT_COMPOSIO_SLUG_PATTERNS: RegExp[] = [
  // DataForSEO uses CREATE/POST for queueing scans, not for user data writes.
  /^DATAFORSEO_/,
  // Firecrawl search/scrape/map/crawl are reads from external URLs,
  // not writes to the user's data. BATCH_SCRAPE still only creates a
  // provider-side read job.
  /^FIRECRAWL_(BATCH_)?(SCRAPE|MAP|SEARCH|CRAWL)/,
];

/**
 * Internal harness tools that must NEVER trigger the gate — they're
 * either how Clem creates the execution to satisfy the gate, or they
 * are explicitly designed to be callable without execution wrapping
 * (approval/notification/planning primitives).
 */
const EXEMPT_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Execution-lifecycle tools — these are the ESCAPE from the gate.
  'execution_create',
  'execution_update_step',
  'execution_complete',
  'execution_mark_blocked',
  'execution_get',
  'execution_list',
  // Planning primitives — pre-execution scaffolding.
  'draft_plan',
  // Approval + user-input — must always be callable.
  'request_approval',
  'ask_user_question',
  'notify_user',
  // Tool-choice memoization — pure cache, never external mutation.
  'tool_choice_recall',
  'tool_choice_remember',
  'tool_choice_invalidate',
  // Recall full prior tool output — pure read.
  'recall_tool_result',
]);

/**
 * Classify whether a single tool invocation counts as a mutating
 * external write that should require execution wrapping. Pure
 * function — no I/O, no SDK, exported for tests.
 *
 * The shape we look at:
 *   - `composio_execute_tool` with a tool_slug whose path contains a
 *     mutating verb (and isn't on the exempt-slug list)
 *   - Future: workflow_run (mutates external state by running other
 *     workflows). For now NOT gated to avoid second-order complexity;
 *     a workflow run is itself observable as an execution.
 *   - Future: run_shell_command for commands that touch external
 *     services (sf data update, gh api POST, etc). Not gated yet
 *     because static classification is unreliable; the user can opt
 *     in via env flag later.
 */
/** Verbs whose external effect can't be taken back. Kept here (the lowest pure
 *  module) so both isMutatingExternalWrite and the confirm-first classifier
 *  share ONE definition (2026-07-09 unification). */
export const IRREVERSIBLE_SEND_VERBS: ReadonlySet<string> = new Set([
  'SEND', 'PUBLISH', 'POST', 'DIAL', 'OUTBOUND', 'TWEET', 'BROADCAST', 'DM',
  // FORWARD (outlook_forward_mail) and REPLY (gmail_reply_to_thread) dispatch a
  // real email. A *_REPLY_DRAFT stays reversible — the DRAFT rule below wins.
  'FORWARD', 'REPLY',
  // NOTE: 'CALL' is a COMM_OBJECT, not a send verb. Every real call-SEND slug
  // carries a dispatch verb (CREATE_CALL, MAKE_OUTBOUND_CALL) or OUTBOUND/DIAL,
  // so it's still caught — while call-READS (VAPI_GET_CALL, list_calls) no longer
  // false-match the bare noun (2026-07-09 re-hunt).
]);
// A CREATE/MAKE/RESPOND/POST of a COMMUNICATION object is a send (an email/
// call/message/invite goes out) even without a SEND verb —
// TWILIO_CREATE_MESSAGE, VAPI_CREATE_CALL, GOOGLECALENDAR_CREATE_EVENT,
// RESPOND_TO_EVENT (RSVP) — while CREATE_SPREADSHEET / CREATE_RECORD stay
// reversible writes. This object-aware layer is what the {SEND,PUBLISH}
// verb-match was missing.
const COMM_OBJECTS: ReadonlySet<string> = new Set([
  'MESSAGE', 'MESSAGES', 'EMAIL', 'EMAILS', 'MAIL', 'SMS', 'CALL', 'POST', 'POSTS',
  'TWEET', 'INVITE', 'INVITES', 'INVITATION', 'REPLY',
  'DM', 'NOTIFICATION', 'ANNOUNCEMENT', 'EVENT',
  // NOTE: 'CHAT' and 'COMMENT' were removed — they over-gated reversible calls
  // (OPENAI_CREATE_CHAT_COMPLETION is an LLM read; *_CREATE_COMMENT on a doc/
  // record is internal + deletable). SLACK_CHAT_POST_MESSAGE stays caught via
  // the POST verb + MESSAGE object (2026-07-09 re-hunt).
]);
// NOTE: 'ADD' is deliberately NOT here. It catches ZERO real sends (no
// *_ADD_<comm-object> send slug exists) but DID over-gate reversible metadata
// ops — GMAIL_ADD_LABEL_TO_EMAIL, SLACK_ADD_REACTION_TO_A_MESSAGE — as
// irreversible sends, silently breaking auto-triage/labeling workflows
// (2026-07-09 re-hunt round 2). Adding a label/reaction is reversible; there is
// no add-a-communication send verb.
const DISPATCH_VERBS: ReadonlySet<string> = new Set(['CREATE', 'MAKE', 'RESPOND', 'POST']);

/** THE canonical "is this an irreversible external send" predicate — the one
 *  chokepoint classifier every dispatch lane routes through. A DRAFT is
 *  reversible; a SEND/PUBLISH/CALL verb is a send; a CREATE/MAKE/RESPOND/POST
 *  of a communication object is a send. Pure + exported. */
export function isIrreversibleSendSlug(slug: string): boolean {
  const normalized = slug
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s/]+/g, '_');
  const parts = normalized.toUpperCase().split(/[_.]+/).filter(Boolean);
  // DRAFT handling must run BEFORE the send-verb match, but must NOT blanket-
  // exempt an explicit send-of-draft: SEND_DRAFT / PUBLISH_DRAFT actually
  // dispatch the composed draft, while CREATE_DRAFT / CREATE_REPLY_DRAFT do not.
  // (The prior `includes('DRAFT') → return false` short-circuited before the
  // SEND check and let every *_SEND_DRAFT through unapproved — 2026-07-09 re-hunt.)
  if (parts.includes('DRAFT') || parts.includes('DRAFTS')) {
    return parts.includes('SEND') || parts.includes('PUBLISH');
  }
  if (parts.some((p) => IRREVERSIBLE_SEND_VERBS.has(p))) return true;
  return parts.some((p) => DISPATCH_VERBS.has(p)) && parts.some((p) => COMM_OBJECTS.has(p));
}

export function isMutatingExternalWrite(
  toolName: string,
  rawArgs: unknown,
): boolean {
  // Internal exempt tools never trigger the gate.
  if (EXEMPT_TOOL_NAMES.has(toolName)) return false;

  if (toolName === 'composio_execute_tool') {
    // Args shape: { tool_slug: 'GOOGLESHEETS_VALUES_UPDATE', arguments: '...', connected_account_id?: '...' }
    const slug = extractToolSlug(rawArgs);
    if (!slug) return false; // Can't classify → don't block. Fail-open.
    // Known-exempt slug patterns (DataForSEO task creation, Firecrawl reads).
    for (const pattern of EXEMPT_COMPOSIO_SLUG_PATTERNS) {
      if (pattern.test(slug)) return false;
    }
    // CALL is also a communication object. GONG_GET_CALL_TRANSCRIPT and
    // VAPI_RETRIEVE_CALL are reads; another mutation verb still wins.
    if (isReadOnlyCallAction(slug)) return false;
    // Mutating verb anywhere in the slug path?
    const parts = slug.split('_');
    for (const part of parts) {
      if (MUTATING_VERBS.has(part)) return true;
    }
    // An irreversible send whose verb isn't in MUTATING_VERBS (RESPOND_TO_EVENT
    // RSVP, a CREATE/RESPOND + comm-object) must still be seen as mutating so
    // the send floor gets a chance (2026-07-09 unification).
    if (isIrreversibleSendSlug(slug)) return true;
    return false;
  }

  // Native MCP tools (e.g. outlook_send_mail, make_outbound_call, create_call,
  // slack post_message) bypass composio_execute_tool but are still irreversible
  // external actions. The 2026-07-09 bypass hunt found these ungated on the MCP
  // shim lane. Name-shape match on the bare tool name (server prefix stripped
  // upstream): a send/publish/post/dispatch verb.
  if (looksLikeNativeMcpSend(toolName)) return true;

  // Everything else is NOT gated for now. Extension points above.
  return false;
}

/**
 * Name-shape detector for a native (non-composio) MCP tool that performs an
 * irreversible external send/publish. Delegates to the ONE canonical classifier
 * (isIrreversibleSendSlug) on the bare tool name, so native names go through the
 * same send-verb + CREATE/RESPOND/POST-of-a-comm-object logic as composio slugs
 * — catching outlook_send_mail, make_outbound_call, create_event (invite),
 * respond_to_event (RSVP), create_record_comment, post_message; excluding
 * drafts and reads (2026-07-09 unification). Pure + exported.
 */
export function looksLikeNativeMcpSend(toolName: string): boolean {
  const bare = toolName.includes('__') ? toolName.split('__').at(-1) ?? toolName : toolName;
  return isIrreversibleSendSlug(bare);
}

/**
 * Best-effort extract `tool_slug` from a composio_execute_tool args
 * object. The wire shape comes in as a JS object (the SDK already
 * parsed JSON from the model) but defensive-handle string inputs too.
 */
function extractToolSlug(rawArgs: unknown): string | undefined {
  if (!rawArgs) return undefined;
  if (typeof rawArgs === 'string') {
    try {
      return extractToolSlug(JSON.parse(rawArgs) as unknown);
    } catch {
      return undefined;
    }
  }
  if (typeof rawArgs !== 'object') return undefined;
  const candidate = (rawArgs as Record<string, unknown>).tool_slug;
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate;
  }
  return undefined;
}

/** Error thrown when a mutating external write is attempted without
 *  an active execution wrap. The message is consumed by the SDK and
 *  surfaced to the model as a tool error, so it MUST clearly tell
 *  Clem how to recover (call execution_create first). */
export class MissingExecutionWrapError extends Error {
  public readonly toolName: string;
  public readonly toolSlug: string | undefined;
  public readonly sessionId: string;
  constructor(opts: {
    toolName: string;
    toolSlug: string | undefined;
    sessionId: string;
  }) {
    const slugPart = opts.toolSlug ? ` (${opts.toolSlug})` : '';
    super(
      `EXECUTION_WRAP_REQUIRED: \`${opts.toolName}\`${slugPart} is a mutating external write but this session has no active execution. ` +
        `Before retrying, call \`execution_create\` with a clear objective + criteria so the work is auditable + resumable. ` +
        `Once the execution exists, re-issue this tool call — it will pass through. Per-tool escape hatch: set env \`CLEMMY_EXECUTION_GATE=off\` if you genuinely need to bypass.`,
    );
    this.name = 'MissingExecutionWrapError';
    this.toolName = opts.toolName;
    this.toolSlug = opts.toolSlug;
    this.sessionId = opts.sessionId;
  }
}

/**
 * Read the env-flag mode. Defaults to 'on'. Set to 'off' to disable
 * the gate (debug / explicit-bypass). Anything else also disables —
 * be permissive on unrecognized values rather than risk blocking
 * legitimate work because of a typo.
 */
export function isGateEnabled(): boolean {
  const raw = (process.env.CLEMMY_EXECUTION_GATE ?? 'on').toLowerCase();
  return raw === 'on' || raw === 'strict' || raw === 'true' || raw === '1';
}

/** Convenience export for tests + brackets integration. */
export { MUTATING_VERBS, EXEMPT_TOOL_NAMES, EXEMPT_COMPOSIO_SLUG_PATTERNS };
