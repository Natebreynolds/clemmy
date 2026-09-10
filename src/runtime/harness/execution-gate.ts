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
 * Production has no environment escape hatch. Isolated repository tests may
 * disable this one legacy wrapper gate while exercising a narrower boundary;
 * that seam is inert unless the process owns a disposable test home.
 *
 * Tested as pure logic in execution-gate.test.ts (no SDK, no DB).
 */

import { declaredMcpToolEffect, type DeclaredMcpToolEffect } from '../mcp-declared-effects.js';
import { composioSlugHasCuratedReadRule } from '../../integrations/composio/slug-effect.js';
import {
  currentManifestOperationContract,
} from './current-manifest-operation-semantics.js';
import type { CapabilityOperationReversibilityV1 } from './capability-manifest.js';
import {
  isClementineLocalToolNamespace as isClementineLocalMcpName,
  isPlainOrClementineLocalTool,
  isTrustedComposioGateway as isTrustedComposioCarrier,
  isTrustedDynamicComposioTool,
  runtimeToolTail as mcpToolTail,
  stripMcpTransportPrefix as withoutMcpTransportPrefix,
} from './runtime-tool-identity.js';

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
  // Host-owned reviewed artifact; the tool itself requires exact foreground Plan mode.
  'publish_plan',
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
  // MEETING: ZOOM_CREATE_MEETING / TEAMS_CREATE_MEETING dispatch invites to
  // attendees — the same external-notify action as a calendar EVENT, which
  // already gates. Only CREATE/MAKE gate (LIST/GET/UPDATE/DELETE_MEETING are
  // not dispatch verbs), so this catches the send-invite case without
  // over-gating meeting reads/edits (2026-07-21 write-path coverage sweep).
  'MEETING', 'MEETINGS',
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

/** Mutation verbs used ONLY to DISQUALIFY a read (fail-closed direction: adding
 * a verb here makes more operations writes, never fewer). A read classification
 * requires a read verb AND none of these anywhere in the operation, so a
 * compound like GONG_GET_CALL_AND_UPDATE_CONTACT or GMAIL_MARK_AS_READ stays a
 * write even though it also carries a read verb. */
const READ_DISQUALIFYING_WRITE_VERBS: ReadonlySet<string> = new Set([
  'UPDATE', 'DELETE', 'REMOVE', 'ADD', 'SET', 'MOVE', 'COPY', 'UPLOAD', 'MARK',
  'ARCHIVE', 'TRASH', 'CLEAR', 'INSERT', 'PATCH', 'PUT', 'MERGE', 'RENAME',
  'DUPLICATE', 'RESTORE', 'REFUND', 'CHARGE', 'CANCEL', 'APPROVE', 'REJECT',
  'ASSIGN', 'COMPLETE', 'SUBSCRIBE', 'UNSUBSCRIBE', 'PURGE', 'REBOOT', 'ROTATE',
  'TRANSACT', 'REACT', 'RUN', 'EXECUTE', 'TRIGGER', 'START', 'STOP', 'ENABLE',
  'DISABLE', 'CONNECT', 'DISCONNECT', 'INVITE', 'SCHEDULE', 'BOOK', 'ORDER',
  'PAY', 'TRANSFER', 'WRITE', 'EDIT', 'MODIFY', 'APPEND', 'REPLACE', 'CLOSE',
  'OPEN', 'LOCK', 'UNLOCK', 'GRANT', 'REVOKE', 'INSTALL', 'UNINSTALL', 'DEPLOY',
  'RESET', 'FLUSH', 'DROP', 'TRUNCATE', 'WIPE', 'KILL', 'TERMINATE', 'SUSPEND',
  'RESUME', 'ACTIVATE', 'DEACTIVATE', 'REGISTER', 'UNREGISTER', 'IMPORT',
  'UPSERT', 'SAVE', 'SUBMIT', 'APPLY', 'CONVERT', 'GENERATE', 'BUILD', 'CLONE',
  'CLEAR', 'EMPTY', 'PROMOTE', 'DEMOTE', 'MUTE', 'UNMUTE', 'PIN', 'UNPIN',
]);

/** A provider-shaped Composio slug is an unambiguous READ iff it carries a read
 * verb and NO send/dispatch/mutation verb. Used only as the absent-manifest
 * default for a provider slug (never native MCP), so a real read a workflow or
 * chat turn names before it is provisioned is not gated as a write. */
function composioSlugIsUnambiguousRead(operationId: string): boolean {
  if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(operationId)) return false;
  const toolParts = operationId.split(/[_.]+/).filter(Boolean).slice(1);
  if (!toolParts.some((token) => READ_VERBS.has(token))) return false;
  // A SEND OR DISPATCH TOKEN ANYWHERE STILL FAILS CLOSED. These are the
  // irreversible ones (SEND, PUBLISH, POST, REPLY, CREATE, MAKE); a slug that
  // mentions one at all is never defaulted to a read.
  if (toolParts.some((token) => (
    IRREVERSIBLE_SEND_VERBS.has(token) || DISPATCH_VERBS.has(token)
  ))) return false;
  // THE VERB IS THE LEADING TOKEN; WHAT FOLLOWS IS THE OBJECT.
  //
  // The softer write vocabulary is full of words that are OBJECTS in ordinary
  // read slugs: the schedule, the run, the build, the order, open issues. A
  // token-anywhere rule graded a free/busy calendar read, an automation run
  // and build read, an order read and an open-issues list as MUTATIONS —
  // while the PLURAL form of the same nouns passed, so singular vs plural of
  // one noun flipped the effect. Live 2026-09-09: "what's on my calendar
  // Thursday?" could not be answered at all, because the one exposed calendar
  // read was refused as a write. (The exact slugs live in the test, not here:
  // production source must not accumulate provider literals.)
  //
  // So scan in order, exactly as `leadingVerbIsRead` already does for the send
  // floor: the first token that is a known verb decides. A get-the-schedule
  // slug reads; a schedule-a-meeting slug does not. Slugs that repeat their
  // toolkit before the verb still resolve on their first known
  // verb. This is only the absent-manifest default for a provider-shaped slug;
  // an exact manifest, consent, approval, expected-work and settlement all
  // still decide the actual call.
  // A COMPOUND SLUG STILL MUTATES. A slug that reads one thing and updates
  // another (get-call-and-update-contact shapes) must not pass, so only the
  // token IMMEDIATELY AFTER the read verb is treated as that verb's object; a
  // write verb further along is a second operation and still disqualifies.
  const verbIndex = toolParts.findIndex((token) => (
    READ_VERBS.has(token) || READ_DISQUALIFYING_WRITE_VERBS.has(token)
  ));
  if (verbIndex < 0 || !READ_VERBS.has(toolParts[verbIndex]!)) return false;
  return !toolParts.some((token, index) => (
    index > verbIndex + 1 && READ_DISQUALIFYING_WRITE_VERBS.has(token)
  ));
}

interface CanonicalExternalAction {
  /** Exact operation identity used only to reopen a sealed manifest. */
  operationId?: string;
  /** Canonical provider action, not its transport wrapper. */
  action?: string;
  /**
   * The token EFFECT VOCABULARY is read from, when it differs from the
   * identity above. A native MCP action's identity must carry its server
   * (two servers can expose the same tool name), but the SERVER NAME IS NOT
   * EVIDENCE OF EFFECT: fusing them let a read verb in the server slug prove
   * a destructive tool read-only — `mcp__audit-log__purge`,
   * `mcp__list-monk__unsubscribe`, `mcp__get-things-done__complete_task` and
   * `mcp__browse-ai__run_robot` ALL classified `mutating:false,
   * reversibility:'read_only', classificationKnown:true` (verified
   * 2026-08-21). Effect is inferred from the operation, identity from both.
   */
  effectToken?: string;
  /**
   * What the owning MCP server declared for this exact tool
   * (readOnly/destructive/idempotent). Declared, never proven: it may admit a
   * read, and it may raise risk, but it can never override contrary evidence.
   */
  declaredEffect?: DeclaredMcpToolEffect;
  /** True only when the carrier is known to cross an external boundary. */
  external: boolean;
}

export interface CanonicalExternalEffect {
  /** Canonical provider action after every known transport wrapper is removed. */
  action?: string;
  /** Whether the call crosses a provider/external boundary. */
  external: boolean;
  /** Whether the canonical action can change external state. */
  mutating: boolean;
  /** Whether the canonical action sends/publishes something irreversible. */
  irreversible: boolean;
  /**
   * Affirmative operation reversibility. `reversible` is emitted only when a
   * sealed manifest says the exact canonical operation can be corrected; it
   * is never inferred merely because the action is not a send.
   */
  reversibility: CapabilityOperationReversibilityV1 | 'read_only' | 'unknown';
  /** False for an external mutation whose effect vocabulary is not understood. */
  classificationKnown: boolean;
}

function decodedArgs(rawArgs: unknown): unknown {
  if (typeof rawArgs !== 'string') return rawArgs;
  const trimmed = rawArgs.trim();
  if (!trimmed) return rawArgs;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return rawArgs;
  }
}

function isInternalExemptTool(toolName: string): boolean {
  const tail = mcpToolTail(toolName);
  return EXEMPT_TOOL_NAMES.has(tail)
    && isPlainOrClementineLocalTool(toolName, tail);
}

/**
 * Resolve transport wrappers before effect classification. This is the one
 * carrier normalizer for execution safety: broker calls, dynamic `cx_*`
 * tools, namespaced MCP tools, and deferred `call_tool` dispatch all land on
 * the same provider action identity.
 */
function canonicalExternalAction(
  toolName: string,
  rawArgs: unknown,
  depth = 0,
): CanonicalExternalAction {
  if (depth > 8) return { external: true };
  const args = decodedArgs(rawArgs);
  const tail = mcpToolTail(toolName);
  const normalized = withoutMcpTransportPrefix(toolName);
  // This admission boundary receives both raw local/SDK identities and fully
  // qualified MCP transport names. Only the latter prove a native provider
  // boundary here. Runtime effect accounting restores `mcp__` before calling
  // this classifier, so carrier-less SDK provider names still fail closed
  // there without turning every local `namespace__tool` into an external write.
  const hasMcpTransport = toolName.startsWith('mcp__');
  const namespace = hasMcpTransport ? normalized.split('__') : [];
  const namespaced = hasMcpTransport && namespace.length > 1;
  const server = namespace.slice(0, -1).join('__');

  if (tail === 'call_tool') {
    if (!isPlainOrClementineLocalTool(toolName, 'call_tool')) {
      return { external: true };
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { external: false };
    }
    const record = args as Record<string, unknown>;
    const target = typeof record.name === 'string' ? record.name.trim() : '';
    if (!target) return { external: false };
    // A trusted local call_tool dispatches names from the connected tool
    // catalog. That carrier supplies the provenance a bare SDK callback name
    // lacks, so restore MCP qualification before classifying server__tool.
    // Clementine-local namespaces remain local under the shared identity rule.
    const catalogTarget = !target.startsWith('mcp__') && target.includes('__')
      ? `mcp__${target}`
      : target;
    return canonicalExternalAction(catalogTarget, record.args_json ?? record.args ?? {}, depth + 1);
  }

  const composioCarrier = isTrustedComposioCarrier(toolName);
  if (composioCarrier) {
    const action = extractToolSlug(args);
    return { external: true, ...(action ? { action, operationId: action } : {}) };
  }
  if (namespaced && (tail === 'composio_execute_tool' || tail === 'execute_tool')) {
    return { external: true };
  }

  if (isTrustedDynamicComposioTool(toolName)) {
    const action = tail.slice(3).trim();
    return {
      external: true,
      ...(action ? { action: action.toUpperCase(), operationId: action.toUpperCase() } : {}),
    };
  }
  if (namespaced && tail.toLowerCase().startsWith('cx_')) {
    return { external: true };
  }

  if (namespaced) {
    // Clementine's own MCP namespace contains local memory/files/control tools.
    // Only its explicit external carriers above cross the provider boundary.
    if (isClementineLocalMcpName(toolName)) return { external: false };
    const action = [server, tail].filter(Boolean).join('_');
    const declaredEffect = declaredMcpToolEffect(toolName);
    return {
      external: true,
      ...(action ? { action } : {}),
      ...(normalized ? { operationId: normalized } : {}),
      ...(tail ? { effectToken: tail } : {}),
      ...(declaredEffect ? { declaredEffect } : {}),
    };
  }

  // Bare native tools are not distinguishable from local runtime tools. Keep
  // the established high-confidence send floor; every namespaced MCP action
  // takes the fail-closed path above.
  if (isIrreversibleSendSlug(toolName)) {
    return { external: true, action: toolName, operationId: toolName };
  }
  return { external: false };
}

/** One shared effect classifier after transport normalization. */
function canonicalExternalActionWriteClassification(
  operationId: string | undefined,
  _action: string | undefined,
  _effectToken?: string,
  /** What the owning server declared. Admits a read; never overrides. */
  declaredEffect?: DeclaredMcpToolEffect,
): {
  mutating: boolean;
  classificationKnown: boolean;
} {
  const manifest = currentManifestOperationContract(operationId);
  if (manifest) {
    if (manifest.effect === 'read') return { mutating: false, classificationKnown: true };
    if (
      manifest.effect === 'external_write'
      || manifest.effect === 'local_write'
      || manifest.effect === 'admin'
    ) return { mutating: true, classificationKnown: true };
    return { mutating: true, classificationKnown: false };
  }
  // A server-authored generic effect declaration is positive adapter
  // authority. Tool/provider vocabulary never substitutes for it.
  if (declaredEffect?.destructive === true) {
    return { mutating: true, classificationKnown: true };
  }
  if (declaredEffect?.readOnly === true) return { mutating: false, classificationKnown: true };
  // A CURATED provider read rule (documented semantics, the research job
  // families) is exact provider knowledge, not verb inference: it is the same
  // authority that seeds the manifest's effect when one is minted. Without
  // this, every unproven curated read classified as a write at the frame
  // (census 2026-09-01, D1) and a work_call carrying it was refused as
  // plan-bound. Generic GET/LIST/CREATE vocabulary stays identity only.
  // Only a provider-shaped Composio slug (single underscores, uppercase):
  // a native MCP name is whatever the user called the server and is never
  // effect proof, however read-shaped it looks.
  if (
    operationId
    && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(operationId)
    && composioSlugHasCuratedReadRule(operationId)
  ) {
    return { mutating: false, classificationKnown: true };
  }
  // A read-verb provider operation with no exact contract is a READ, not a
  // conservative mutation. The absent-manifest default-to-write is the
  // documented seam that OVER-gates ordinary reads while under-gating sends
  // (open-clem-up 2026-08-29; census D1; live 2026-09-02 a work_call carrying
  // GOOGLESHEETS_BATCH_GET / SLACK_FETCH_CONVERSATION_HISTORY was classified
  // external_write and refused as plan-bound though a read never needs a plan).
  // The irreversible-send floor is UNCHANGED: isIrreversibleSendSlug uses the
  // same leading-verb read test, and a SEND/PUBLISH/UPDATE/CLEAR/DELETE verb
  // still falls through to the mutation default below. Gated to a
  // provider-shaped Composio slug (single underscores, uppercase); a native
  // MCP name is whatever the user called the server and is never effect proof.
  // classificationKnown stays false: this is a safe default for the plan gate,
  // not a proven-authority read.
  if (operationId && composioSlugIsUnambiguousRead(operationId)) {
    return { mutating: false, classificationKnown: false };
  }
  // A connected operation with no exact current effect contract and no read
  // verb stays a conservative mutation.
  return { mutating: true, classificationKnown: false };
}

function canonicalExternalActionIsWrite(
  operationId: string | undefined,
  action: string | undefined,
  effectToken?: string,
  declaredEffect?: DeclaredMcpToolEffect,
): boolean {
  return canonicalExternalActionWriteClassification(
    operationId,
    action,
    effectToken,
    declaredEffect,
  ).mutating;
}

/** THE canonical "is this an irreversible external send" predicate — the one
 *  chokepoint classifier every dispatch lane routes through. A DRAFT is
 *  reversible; a SEND/PUBLISH/CALL verb is a send; a CREATE/MAKE/RESPOND/POST
 *  of a communication object is a send. Pure + exported. */

const READ_VERBS: ReadonlySet<string> = new Set([
  'GET', 'LIST', 'FETCH', 'SEARCH', 'FIND', 'READ', 'LOOKUP', 'RETRIEVE', 'QUERY',
  'DESCRIBE', 'VIEW', 'SHOW', 'COUNT', 'CHECK',
]);

function leadingVerbIsRead(slug: string, parts: readonly string[]): boolean {
  // Tool-name portion: after the last `__` (MCP server separator) when present;
  // otherwise after the provider toolkit token (the first `_`-separated part).
  const toolPortion = slug.includes('__') ? slug.slice(slug.lastIndexOf('__') + 2) : '';
  const toolParts = toolPortion
    ? toolPortion.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s/]+/g, '_').toUpperCase().split(/[_.]+/).filter(Boolean)
    : parts.slice(1);
  for (const token of toolParts) {
    if (READ_VERBS.has(token)) return true;
    if (IRREVERSIBLE_SEND_VERBS.has(token) || DISPATCH_VERBS.has(token)) return false;
  }
  return false;
}

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
  // A read verb is never a send: TWITTER_GET_POST reads a post, GMAIL_GET_REPLY
  // reads a reply. The floor is judged on the TOOL name only — after an MCP
  // server segment (`mcp__server__tool`) or a provider toolkit prefix — so a
  // read verb in a SERVER slug still cannot vouch for a destructive tool.
  // The first token that is any known verb decides: read → never a send.
  if (leadingVerbIsRead(slug, parts)) return false;
  if (parts.some((p) => IRREVERSIBLE_SEND_VERBS.has(p))) return true;
  return parts.some((p) => DISPATCH_VERBS.has(p)) && parts.some((p) => COMM_OBJECTS.has(p));
}

export function isMutatingExternalWrite(
  toolName: string,
  rawArgs: unknown,
): boolean {
  // Internal exempt tools never trigger the gate.
  if (isInternalExemptTool(toolName)) return false;

  const canonical = canonicalExternalAction(toolName, rawArgs);
  return canonical.external
    ? canonicalExternalActionIsWrite(
        canonical.operationId,
        canonical.action,
        canonical.effectToken,
        canonical.declaredEffect,
      )
    : false;
}

/**
 * Canonical external-effect classifier shared by every gate. It unwraps
 * deferred call_tool, Composio, dynamic cx_ tools, and native MCP namespaces
 * exactly once, so mutation and irreversibility cannot disagree by transport.
 */
export function classifyCanonicalExternalEffect(
  toolName: string,
  rawArgs: unknown,
): CanonicalExternalEffect {
  if (isInternalExemptTool(toolName)) {
    return {
      external: false,
      mutating: false,
      irreversible: false,
      reversibility: 'read_only',
      classificationKnown: true,
    };
  }
  const canonical = canonicalExternalAction(toolName, rawArgs);
  if (!canonical.external) {
    return {
      external: false,
      mutating: false,
      irreversible: false,
      reversibility: 'read_only',
      classificationKnown: true,
    };
  }
  const write = canonicalExternalActionWriteClassification(
    canonical.operationId,
    canonical.action,
    canonical.effectToken,
    canonical.declaredEffect,
  );
  const manifest = currentManifestOperationContract(canonical.operationId);
  const manifestReversibility = manifest?.effect === 'read'
    ? 'read_only' as const
    : manifest?.semantics?.reversibility;
  // The manifest takes PRECEDENCE over the slug evidence. It does not REPLACE
  // it.
  //
  // This read `: false` when no manifest was installed — and the manifest comes
  // from peekHostCapabilityCatalogFactory(), a process-wide singleton that is
  // null unless something materialized that exact operation in-process. So on
  // any ordinary path with no materialization, NOTHING was irreversible:
  // outlook_send_mail, VAPI_CREATE_CALL and every other send lost the floor
  // that holds them for human consent, and `send-trust: the invariant HOLDS
  // with zero grants` failed with an irreversible send auto-approved.
  //
  // Note the asymmetry that made it dangerous: the sibling default above
  // (`{ mutating: true, classificationKnown: false }`) is conservative, so an
  // absent manifest OVER-gates ordinary reads while simultaneously
  // UNDER-gating sends. One missing fallback, harm in both directions.
  //
  // isIrreversibleSendSlug remained correct and exported the whole time; it had
  // simply stopped being consulted. An absent manifest now falls back to it
  // rather than to a permissive constant.
  const irreversible = manifest
    ? manifestReversibility === 'irreversible'
    : (isIrreversibleSendSlug(canonical.operationId ?? '')
      || isIrreversibleSendSlug(canonical.action ?? '')
      || looksLikeNativeMcpSend(canonical.operationId ?? ''));
  const reversibility: CanonicalExternalEffect['reversibility'] = manifestReversibility
    ?? (irreversible
      ? 'irreversible'
      : write.classificationKnown && !write.mutating
        ? 'read_only'
        : 'unknown');
  return {
    ...(canonical.action ? { action: canonical.action } : {}),
    external: true,
    mutating: write.mutating,
    irreversible,
    reversibility,
    classificationKnown: write.classificationKnown || irreversible,
  };
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
        'Once the execution exists, re-issue this tool call — it will pass through.',
    );
    this.name = 'MissingExecutionWrapError';
    this.toolName = opts.toolName;
    this.toolSlug = opts.toolSlug;
    this.sessionId = opts.sessionId;
  }
}

/**
 * Production is unconditionally enabled. The historical flag is honored only
 * inside the process-isolated test harness so existing focused tests can turn
 * off this wrapper while exercising a different authority boundary.
 */
export function isGateEnabled(): boolean {
  if (process.env.CLEMMY_TEST_ISOLATED_HOME !== '1') return true;
  const raw = (process.env.CLEMMY_EXECUTION_GATE ?? 'on').trim().toLowerCase();
  return !['off', 'false', '0', 'no'].includes(raw);
}

/** Convenience export for tests + brackets integration. */
export { EXEMPT_TOOL_NAMES };
