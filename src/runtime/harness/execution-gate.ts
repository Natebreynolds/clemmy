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

import {
  composioSlugEffectEvidence,
} from '../../integrations/composio/slug-effect.js';
import {
  documentedComposioOperationSemantic,
  type DocumentedComposioReversibility,
} from '../../integrations/composio/operation-semantics.js';
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

interface CanonicalExternalAction {
  /** Canonical provider action, not its transport wrapper. */
  action?: string;
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
   * documented semantic says the exact canonical operation can be corrected;
   * it is never inferred merely because the action is not a send.
   */
  reversibility: DocumentedComposioReversibility | 'unknown';
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
    return { external: true, action: extractToolSlug(args) };
  }
  if (namespaced && (tail === 'composio_execute_tool' || tail === 'execute_tool')) {
    return { external: true };
  }

  if (isTrustedDynamicComposioTool(toolName)) {
    const action = tail.slice(3).trim();
    return { external: true, ...(action ? { action: action.toUpperCase() } : {}) };
  }
  if (namespaced && tail.toLowerCase().startsWith('cx_')) {
    return { external: true };
  }

  if (namespaced) {
    // Clementine's own MCP namespace contains local memory/files/control tools.
    // Only its explicit external carriers above cross the provider boundary.
    if (isClementineLocalMcpName(toolName)) return { external: false };
    const action = [server, tail].filter(Boolean).join('_');
    return { external: true, ...(action ? { action } : {}) };
  }

  // Bare native tools are not distinguishable from local runtime tools. Keep
  // the established high-confidence send floor; every namespaced MCP action
  // takes the fail-closed path above.
  if (isIrreversibleSendSlug(toolName)) return { external: true, action: toolName };
  return { external: false };
}

/** One shared effect classifier after transport normalization. */
function canonicalExternalActionWriteClassification(action: string | undefined): {
  mutating: boolean;
  classificationKnown: boolean;
} {
  // A known external carrier with no usable action identity is not provably a
  // read. This is the safety boundary: malformed wrappers and newly introduced
  // mutation verbs cannot bypass execution wrapping.
  if (!action) return { mutating: true, classificationKnown: false };
  const documented = documentedComposioOperationSemantic(action);
  if (documented) {
    return { mutating: documented.effect === 'write', classificationKnown: true };
  }
  const evidence = composioSlugEffectEvidence(action);
  if (evidence === 'read') return { mutating: false, classificationKnown: true };
  if (evidence === 'write') return { mutating: true, classificationKnown: true };
  // A connected operation with no documented semantics and no recognized verb
  // stays a conservative mutation, but remains explicitly UNKNOWN so approval
  // and workspace consumers can fail closed.
  return { mutating: true, classificationKnown: false };
}

function canonicalExternalActionIsWrite(action: string | undefined): boolean {
  return canonicalExternalActionWriteClassification(action).mutating;
}

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
  if (isInternalExemptTool(toolName)) return false;

  const canonical = canonicalExternalAction(toolName, rawArgs);
  return canonical.external
    ? canonicalExternalActionIsWrite(canonical.action)
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
  const write = canonicalExternalActionWriteClassification(canonical.action);
  const documented = canonical.action
    ? documentedComposioOperationSemantic(canonical.action)
    : null;
  const irreversible = documented
    ? documented.reversibility === 'irreversible'
    : canonical.action
      ? isIrreversibleSendSlug(canonical.action)
      : false;
  const reversibility: CanonicalExternalEffect['reversibility'] = documented
    ? documented.reversibility
    : irreversible
      ? 'irreversible'
      : write.classificationKnown && !write.mutating
        ? 'read_only'
        : 'unknown';
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
        `Once the execution exists, re-issue this tool call — it will pass through. Per-tool escape hatch: set env \`CLEMMY_EXECUTION_GATE=off\` if you genuinely need to bypass.`,
    );
    this.name = 'MissingExecutionWrapError';
    this.toolName = opts.toolName;
    this.toolSlug = opts.toolSlug;
    this.sessionId = opts.sessionId;
  }
}

/**
 * Read the env-flag mode. Defaults to on and disables only for an explicit
 * false value. A typo in a safety flag must preserve the gate, not silently
 * turn external-write protection off.
 */
export function isGateEnabled(): boolean {
  const raw = (process.env.CLEMMY_EXECUTION_GATE ?? 'on').trim().toLowerCase();
  return !['off', 'false', '0', 'no'].includes(raw);
}

/** Convenience export for tests + brackets integration. */
export { EXEMPT_TOOL_NAMES };
