/**
 * Public chat projection.
 *
 * The harness event log is an execution/audit ledger. Its payloads may contain
 * model output, tool arguments, judge rationale, retry directives, and other
 * control-plane detail that must never become chat copy merely because a UI is
 * subscribed to the ledger. This module is the one-way boundary from that raw
 * ledger into user-facing chat events.
 *
 * Keep this projection fail-closed:
 *   - a new event type receives no payload until it is explicitly projected;
 *   - raw model-turn/control events are not public events at all;
 *   - untrusted token deltas require an explicit `public: true` marker;
 *   - terminal events expose one canonical reply, not the decision envelope.
 *
 * The returned rows deliberately keep the legacy EventRow wire shape so the
 * desktop clients can adopt the boundary without a protocol rewrite.
 */
import { getRunAttemptSourceUserEvent, listEvents, type EventRow } from './eventlog.js';
import { isLiveApprovalAcknowledgement } from './accepted-source-kind.js';
import {
  parseNarratedEnvelope,
  publicReplyFromNarratedEnvelope,
} from './envelope-narration.js';
import {
  assertPublicPresentationText,
  presentationEventFromCompletionData,
  type PresentationEvent,
} from './turn-outcome.js';
import { looksLikeToolCallShape } from './tool-narration-shapes.js';
import {
  looksLikeCompactDecisionProtocol,
  stripLeakedDecisionAssignment,
} from './presentation-hygiene.js';
import { isCanonicalTopLevelToolEvent } from './tool-effect.js';
import {
  isSettledReadReplayReturnData,
  settledReadReplayCallId,
  SETTLED_READ_REUSE_LABEL,
} from './settled-read-replay-semantics.js';
import { WORK_ID_PATTERN } from '../../shared/work-id.js';
import { parsePlanRevisionRef, parseTaskMode, type PlanRevisionRef, type TaskMode } from './task-mode.js';

export function publicPlanArtifactRef(value: unknown): PlanRevisionRef | undefined {
  try { return value === undefined ? undefined : parsePlanRevisionRef(value); } catch { return undefined; }
}

export function publicTaskMode(value: unknown): TaskMode | undefined {
  try { return parseTaskMode(value); } catch { return undefined; }
}

const PRIVATE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn_ended',
  'turn_preflight_decision',
  'conversation_step',
  'conversation_recovery_candidate',
  'claude_local_permission_admitted',
  'claude_local_permission_claimed',
  'cross_session_prefix',
  'agent_context_packet',
  'primary_model_planning_card_snapshot',
  'async_work_dispatch_prepared',
  'async_work_dispatch_batch_closed',
  'turn_memory_primer',
  'guardrail_tripped',
  'stuck_detected',
  'learning_candidate_evaluated',
  'durable_memory_intake_receipt',
]);

const DECISION_KEYS = new Set(['summary', 'reply', 'done', 'nextaction', 'reason']);
const RAW_TOOL_OR_REASONING_PROTOCOL_RE = /(?:<\/?(?:analysis|reasoning|invoke|tool_call)\b|\[tool\s*:|"tool_call"\s*:)/i;
const SAFE_TERMINAL_FALLBACK =
  'I finished the turn, but the final reply was not safe to display. The activity log has the technical details.';
/** The host could not seal a model request because its local vault has no
 *  seal key. Live 2026-09-08: a desktop user's every first message died as
 *  "Something went wrong" while the only trace was a boot-time warning. */
export const PUBLIC_VAULT_NOT_READY_TEXT = 'Clementine\'s local vault isn\'t ready, so no model request can start. Quit and reopen Clementine; if this keeps happening, tell me and I\'ll walk you through repairing the home folder.';
export const PUBLIC_RUN_FAILURE_TEXT = 'Something went wrong on that turn. Please try again; the technical details are available in the activity log.';
export const PUBLIC_MODEL_RUNTIME_UNAVAILABLE_TEXT =
  'I could not start this turn because no model runtime is connected. Open Settings > Models, connect a model, and try again.';

export type PublicHeldKind = 'blocked' | 'uncertain';

export interface PublicHeldExecutionInput {
  kind: PublicHeldKind;
  cause:
    | 'provider_identity'
    | 'schema'
    | 'account'
    | 'observation'
    | 'reconciliation'
    | 'settlement'
    | 'unsupported_write'
    | 'semantic';
  providerCallOccurred: boolean;
  externalChangePossible: boolean;
  retrySafe: boolean;
  willResumeAutomatically: boolean;
}

export function publicHeldExecutionText(input: PublicHeldExecutionInput): string {
  const call = input.providerCallOccurred
    ? 'A provider call was already reserved or started.'
    : 'No provider call was made.';
  const change = input.externalChangePossible
    ? 'An external change may already exist, so I will not guess and will not write again.'
    : 'No external change was made.';
  const retry = input.retrySafe
    ? 'A retry is safe once the missing account, capability, or schema is ready.'
    : 'A retry is not safe until this crossing is reconciled or marked complete.';
  const resume = input.willResumeAutomatically
    ? 'I will resume automatically when that recovery finishes.'
    : 'I will wait for you before trying again.';
  const next = input.cause === 'account'
    ? 'Next: reconnect the exact account for this capability.'
    : input.cause === 'schema' || input.cause === 'provider_identity'
      ? 'Next: approve or provision the current capability identity.'
      : input.cause === 'reconciliation' || input.cause === 'unsupported_write'
        ? 'Next: verify the artifact, then tell me whether to continue.'
        : input.cause === 'observation'
          ? 'Next: reconnect the provider so I can observe the live operation and account.'
          : input.cause === 'settlement'
            ? 'Next: wait for recovery to finish, or ask me to check whether that step actually went through.'
            : 'Next: restate the request, or approve the capability if one is missing.';
  const lead = input.kind === 'uncertain'
    ? 'I stopped because I cannot prove whether that work finished.'
    : 'I stopped before finishing because the host could not authorize the next step.';
  return `${lead} ${call} ${change} ${retry} ${resume} ${next}`;
}

const HOST_AUTHORITY_HELD_RE =
  /observ|account|schema|fingerprint|binary_drift|provider|capability|identity_mismatch|manifest|live lease|reconcil|settle|storage_error|unsupported.?write|independent_observation/i;

/** True when the stop is host authority/recovery, not a semantic or contract refuse. */
export function isHostAuthorityHeldReason(reason: string): boolean {
  return HOST_AUTHORITY_HELD_RE.test(reason ?? '');
}

/** Map an internal held/recovery reason onto user-facing copy. Never leaks
 *  digests, account IDs, or "could not interpret" for host-authority stops. */
export function heldExecutionTextForInternalReason(
  reason: string,
  kind: PublicHeldKind = /uncertain|reconcil/i.test(reason) ? 'uncertain' : 'blocked',
): string {
  if (!isHostAuthorityHeldReason(reason)) return reason;
  const text = reason ?? '';
  const cause: PublicHeldExecutionInput['cause'] =
    /account|live lease|reconnect/i.test(text) ? 'account'
      : /schema|fingerprint|definition|binary_drift/i.test(text) ? 'schema'
        : /provider|capability|identity_mismatch|manifest|port/i.test(text) ? 'provider_identity'
          : /observ/i.test(text) ? 'observation'
            : /reconcil|unsupported.?write/i.test(text)
              ? (/unsupported.?write/i.test(text) ? 'unsupported_write' : 'reconciliation')
              : /settle|storage_error|conflict/i.test(text) ? 'settlement'
                : 'semantic';
  const providerCallOccurred = /reserved|started|provider (?:call|outcome|crossing)|reconcil|settle/i.test(text);
  const externalChangePossible = kind === 'uncertain'
    || /provider outcome is unknown|already reserved|external change/i.test(text);
  return publicHeldExecutionText({
    kind,
    cause,
    providerCallOccurred,
    externalChangePossible,
    retrySafe: !externalChangePossible && cause !== 'reconciliation' && cause !== 'settlement',
    willResumeAutomatically: cause === 'settlement',
  });
}

const PUBLIC_CONVERSATION_PREAMBLE_KEYS = new Set([
  'version',
  'kind',
  'sourceUserSeq',
  'text',
  'intentKey',
]);
const PUBLIC_CONVERSATION_PREAMBLE_INTENT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_PUBLIC_CONVERSATION_PREAMBLE_CHARS = 8_000;

/**
 * Model-authored prose shown before execution begins. This is deliberately a
 * nonterminal presentation record: it carries no status, outcome, need,
 * approval, or effect authority. Keeping the payload closed prevents a future
 * producer from smuggling control fields onto the public event plane.
 */
export interface PublicConversationPreambleData extends Record<string, unknown> {
  version: 1;
  kind: 'pre_execution';
  sourceUserSeq: number;
  text: string;
  intentKey?: string;
}

/** Validate and normalize the only public pre-execution prose shape. */
export function publicConversationPreambleData(
  data: Record<string, unknown>,
): PublicConversationPreambleData | null {
  if (Object.keys(data).some((key) => !PUBLIC_CONVERSATION_PREAMBLE_KEYS.has(key))) return null;
  const sourceUserSeq = data.sourceUserSeq;
  if (
    data.version !== 1
    || data.kind !== 'pre_execution'
    || !Number.isSafeInteger(sourceUserSeq)
    || Number(sourceUserSeq) <= 0
    || typeof data.text !== 'string'
  ) return null;
  let safeText: string;
  try { safeText = assertPublicPresentationText(data.text); } catch { return null; }
  if (safeText.length > MAX_PUBLIC_CONVERSATION_PREAMBLE_CHARS || safeText.includes('\0')) return null;
  const intentKey = data.intentKey === undefined
    ? undefined
    : typeof data.intentKey === 'string'
      ? data.intentKey.trim()
      : '';
  if (intentKey !== undefined && !PUBLIC_CONVERSATION_PREAMBLE_INTENT_KEY_RE.test(intentKey)) return null;
  return {
    version: 1,
    kind: 'pre_execution',
    sourceUserSeq: Number(sourceUserSeq),
    text: safeText,
    ...(intentKey ? { intentKey } : {}),
  };
}

export interface PublicConversationCheckInData extends Record<string, unknown> {
  version: 1;
  kind: 'check_in';
  sourceUserSeq: number;
  text: string;
}

const PUBLIC_CONVERSATION_CHECK_IN_KEYS: ReadonlySet<string> = new Set([
  'version', 'kind', 'sourceUserSeq', 'text',
]);
/** A check-in is a sentence or two, not a report. The cap is deliberately
 *  tighter than the preamble's: many of these land in one thread. */
const MAX_PUBLIC_CONVERSATION_CHECK_IN_CHARS = 600;

/** Clem's own mid-task words, validated for a public surface exactly as the
 *  preamble is: a closed key set, no control characters, bounded length. It
 *  carries no status, outcome or authority — only what she wants to say. */
export function publicConversationCheckInData(
  data: Record<string, unknown>,
): PublicConversationCheckInData | null {
  if (Object.keys(data).some((key) => !PUBLIC_CONVERSATION_CHECK_IN_KEYS.has(key))) return null;
  const sourceUserSeq = data.sourceUserSeq;
  if (
    data.version !== 1
    || data.kind !== 'check_in'
    || !Number.isSafeInteger(sourceUserSeq)
    || Number(sourceUserSeq) <= 0
    || typeof data.text !== 'string'
  ) return null;
  let safeText: string;
  try { safeText = assertPublicPresentationText(data.text); } catch { return null; }
  if (!safeText.trim()) return null;
  if (safeText.length > MAX_PUBLIC_CONVERSATION_CHECK_IN_CHARS || safeText.includes('\0')) return null;
  return { version: 1, kind: 'check_in', sourceUserSeq: Number(sourceUserSeq), text: safeText };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Accepted turns may carry a model-facing expansion (`text`) plus the exact
 * human-authored display form. Never replay continuation directives or folded
 * attachment contents when `displayText` is available. */
export function publicUserInputText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const data = value as Record<string, unknown>;
  return text(data.displayText) || text(data.text ?? data.message);
}

function compactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

function jsonReply(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).map(compactKey);
    const decisionShaped = keys.filter((key) => DECISION_KEYS.has(key)).length >= 3;
    if (!decisionShaped && typeof record.reply !== 'string') return null;
    return text(record.reply);
  } catch {
    return null;
  }
}

/**
 * Convert one legacy reply candidate into displayable prose. This is a
 * compatibility adapter, not authorization for arbitrary text: decision forms
 * yield only their `reply` field and tool/reasoning protocols fail closed.
 */
function projectReplyText(value: unknown, fallback: string, depth: number): string {
  if (depth > 3) return fallback;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return projectReplyText(record.reply, fallback, depth + 1);
  }
  const candidate = stripLeakedDecisionAssignment(text(value) ?? '');
  if (!candidate) return fallback;

  // Preserve the compatibility contract for a whole legacy JSON decision that
  // carries a usable public reply. A decision object without one remains
  // private control output. The shared detector is deliberately
  // whole-envelope/fence-aware, so examples remain public.
  const fromJson = jsonReply(candidate);
  if (fromJson !== null) return projectReplyText(fromJson, fallback, depth + 1);
  if (looksLikeCompactDecisionProtocol(candidate)) return fallback;
  if (parseNarratedEnvelope(candidate)) {
    return projectReplyText(publicReplyFromNarratedEnvelope(candidate), fallback, depth + 1);
  }
  if (
    RAW_TOOL_OR_REASONING_PROTOCOL_RE.test(candidate)
    || looksLikeToolCallShape(candidate)
  ) return fallback;
  return candidate;
}

export function publicReplyText(value: unknown, fallback = ''): string {
  return projectReplyText(value, fallback, 0);
}

function stringList(value: unknown, max = 12): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(0, max)
      .map((item) => item.trim())
    : [];
}

function shortString(value: unknown, max = 240): string | undefined {
  const candidate = text(value);
  return candidate ? candidate.slice(0, max) : undefined;
}

function selected(data: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  return out;
}

const PUBLIC_WORKFLOW_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const PUBLIC_WORK_REQUIREMENT_ID_RE = WORK_ID_PATTERN;
const PUBLIC_SHA256_DIGEST_RE = /^[a-f0-9]{64}$/;

export interface PublicAsyncWorkDispatchedData extends Record<string, unknown> {
  version: 2;
  kind: 'workflow_run_group';
  status: 'dispatched';
  sourceUserSeq: number;
  sourceGroupId: string;
  sourceGroupDigest: string;
  runIds: string[];
  dispatchKey: string;
  /** Immutable digest of the exact destination captured at queue admission. */
  replyTargetDigest: string;
  /** Deterministic runtime copy. Model prose never enters this field. */
  text: string;
}

/** Validate and project the only public async-dispatch shape. */
export function publicAsyncWorkDispatchedData(
  data: Record<string, unknown>,
): PublicAsyncWorkDispatchedData | null {
  const sourceUserSeq = data.sourceUserSeq;
  const sourceGroupId = typeof data.sourceGroupId === 'string' ? data.sourceGroupId.trim() : '';
  const sourceGroupDigest = typeof data.sourceGroupDigest === 'string'
    ? data.sourceGroupDigest.trim()
    : '';
  const runIds = Array.isArray(data.runIds)
    ? data.runIds.map((runId) => typeof runId === 'string' ? runId.trim() : '')
    : [];
  const replyTargetDigest = typeof data.replyTargetDigest === 'string'
    ? data.replyTargetDigest.trim()
    : '';
  if (
    data.version !== 2
    || data.kind !== 'workflow_run_group'
    || data.status !== 'dispatched'
    || !Number.isSafeInteger(sourceUserSeq)
    || Number(sourceUserSeq) <= 0
    || !/^workflow-origin-group-v1:[a-f0-9]{64}$/.test(sourceGroupId)
    || !PUBLIC_SHA256_DIGEST_RE.test(sourceGroupDigest)
    || runIds.length === 0
    || runIds.some((runId) => !PUBLIC_WORKFLOW_RUN_ID_RE.test(runId))
    || new Set(runIds).size !== runIds.length
    || !PUBLIC_SHA256_DIGEST_RE.test(replyTargetDigest)
  ) return null;
  const dispatchKey = `workflow_source_group:${sourceGroupId}:${sourceGroupDigest}`;
  if (data.dispatchKey !== dispatchKey) return null;
  return {
    version: 2,
    kind: 'workflow_run_group',
    status: 'dispatched',
    sourceUserSeq: Number(sourceUserSeq),
    sourceGroupId,
    sourceGroupDigest,
    runIds,
    dispatchKey,
    replyTargetDigest,
    text: runIds.length === 1
      ? 'Started — I’ll post the result here when it’s ready.'
      : `Started ${runIds.length} workflows — I’ll post one combined result here when they’re ready.`,
  };
}

function pendingActionProjection(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const out = selected(data, [
    'id', 'title', 'summary', 'kind', 'status', 'toolName', 'targetSummary',
    'preview', 'risk', 'rollback', 'approvalId', 'resultSummary', 'createdAt', 'updatedAt',
  ]);
  return Object.keys(out).length > 0 ? out : undefined;
}

function pendingActionId(data: Record<string, unknown>): string | undefined {
  const direct = shortString(data.pendingActionId ?? data.pending_action_id, 160);
  if (direct) return direct;
  if (data.pendingAction && typeof data.pendingAction === 'object' && !Array.isArray(data.pendingAction)) {
    const embedded = shortString((data.pendingAction as Record<string, unknown>).id, 160);
    if (embedded) return embedded;
  }
  let args: unknown = data.args;
  if (typeof args === 'string') {
    try { args = JSON.parse(args) as unknown; } catch { args = null; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  return shortString(
    (args as Record<string, unknown>).pendingActionId
      ?? (args as Record<string, unknown>).pending_action_id,
    160,
  );
}

/** Resolve a terminal's only authorized human text. Legacy `summary` is not a
 * publication field: it is frequently reducer/judge bookkeeping in plain
 * English and therefore cannot be made safe with an output-shape regex. */
export function publicCompletionText(
  data: Record<string, unknown>,
  fallback = SAFE_TERMINAL_FALLBACK,
): string {
  try {
    const typedPresentation = presentationEventFromCompletionData(data);
    return typedPresentation?.text
      || publicReplyText(data.reply, '')
      || fallback;
  } catch {
    // A row that claims the typed contract but contradicts it is not legacy.
    // Its duplicated reply/summary fields came from the same invalid write and
    // cannot be laundered into publication through the compatibility adapter.
    return fallback;
  }
}

/**
 * Return the exact logical owner of a fully valid typed completion.
 *
 * `sourceUserSeq` fields copied onto legacy or malformed rows are not enough to
 * earn ownership: the two typed projections must validate together, and their
 * embedded session must agree with the ledger row that contains them. Readers
 * use this helper to pair a public terminal with the accepted input it actually
 * completed instead of guessing from the reusable numeric `turn` column.
 */
export function validTypedCompletionPresentation(
  data: Record<string, unknown>,
  eventSessionId: string,
): PresentationEvent | null {
  try {
    const presentation = presentationEventFromCompletionData(data);
    if (!presentation || presentation.identity.sessionId !== eventSessionId) return null;
    return presentation;
  } catch {
    return null;
  }
}

function claimsTypedCompletion(data: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(data, 'presentation')
    || Object.prototype.hasOwnProperty.call(data, 'turnOutcome');
}

function legacyCompletionSourceUserSeq(data: Record<string, unknown>): number | null {
  const direct = data.sourceUserSeq;
  if (typeof direct === 'number' && Number.isSafeInteger(direct) && direct > 0) return direct;

  // The first source-owned terminal writer used `turn:<source seq>` before all
  // legacy completion payloads carried a dedicated sourceUserSeq field. Treat
  // only that closed canonical key as ownership; attempt/run ids are physical
  // execution identity and must never collapse distinct accepted turns.
  const terminalKey = typeof data.terminalKey === 'string' ? data.terminalKey : '';
  const match = /^turn:([1-9]\d*)$/.exec(terminalKey);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function completionSourceKey(event: EventRow): string | null {
  if (event.type !== 'conversation_completed') return null;
  if (claimsTypedCompletion(event.data)) {
    const presentation = validTypedCompletionPresentation(event.data, event.sessionId);
    return presentation
      ? `${event.sessionId}:${presentation.identity.sourceUserSeq}`
      : null;
  }
  const sourceUserSeq = legacyCompletionSourceUserSeq(event.data);
  return sourceUserSeq === null ? null : `${event.sessionId}:${sourceUserSeq}`;
}

function terminalData(data: Record<string, unknown>, eventSessionId: string): Record<string, unknown> {
  let typedPresentation: ReturnType<typeof presentationEventFromCompletionData> = null;
  try {
    typedPresentation = presentationEventFromCompletionData(data);
    if (typedPresentation && typedPresentation.identity.sessionId !== eventSessionId) {
      throw new Error('typed completion belongs to another session');
    }
  } catch {
    return {
      reply: SAFE_TERMINAL_FALLBACK,
      summary: SAFE_TERMINAL_FALLBACK,
      presentation: {
        version: 1,
        audience: 'user',
        phase: 'final',
        status: 'failed',
        kind: 'error',
        text: SAFE_TERMINAL_FALLBACK,
        resumable: false,
      },
    };
  }
  const reply = publicCompletionText(data);
  const reason = text(data.reason);
  const legacyNeedsInput = data.awaitingUser === true
    || reason === 'awaiting_user_input'
    || reason === 'awaiting_approval'
    || reason === 'awaiting_continue';
  const legacyStatus = legacyNeedsInput
    ? 'needs_input'
    : data.delivered === false
      ? 'blocked'
      : 'done';
  const legacyKind = reason === 'awaiting_approval'
    ? 'approval'
    : reason === 'awaiting_continue'
      ? 'continue'
      : legacyNeedsInput
        ? 'question'
        : data.delivered === false
          ? 'blocked'
          : 'answer';
  // Keep the two validated halves together on the public bus. Reconstruct the
  // durable half from the decoded presentation instead of forwarding the raw
  // payload, so downstream public consumers can revalidate the contract without
  // gaining access to model summaries or other ledger-only fields.
  const typedOutcome: {
    version: 2;
    id: PresentationEvent['outcomeId'];
    status: PresentationEvent['status'];
    resumable: PresentationEvent['resumable'];
    needs?: PresentationEvent['needs'];
    evidenceRefs?: PresentationEvent['evidenceRefs'];
  } | null = typedPresentation
    ? {
        version: 2,
        id: typedPresentation.outcomeId,
        status: typedPresentation.status,
        resumable: typedPresentation.resumable,
        ...(typedPresentation.needs ? { needs: typedPresentation.needs } : {}),
        ...(typedPresentation.evidenceRefs ? { evidenceRefs: typedPresentation.evidenceRefs } : {}),
      }
    : null;
  return {
    ...selected(data, [
      'reason', 'steps', 'delivered', 'awaitingUser', 'missingReply',
      'limitKind', 'planProposalId', 'planProposalStatus', 'planProposalNeedsUserInput',
      'queuedTaskId', 'pendingApprovalId', 'attemptId', 'runId', 'sourceUserSeq',
      'terminalKey', 'verification', 'artifactVerification', 'artifactRunScopeId',
      'transport', 'maxTurns',
    ]),
    ...(typedPresentation && publicPlanArtifactRef(data.planArtifactRef)
      ? { planArtifactRef: publicPlanArtifactRef(data.planArtifactRef) } : {}),
    reply,
    // Compatibility for consumers that historically read summary first.
    summary: reply,
    ...(typedOutcome ? { turnOutcome: typedOutcome } : {}),
    presentation: typedPresentation ?? {
      version: 1,
      audience: 'user',
      phase: 'final',
      status: legacyStatus,
      kind: legacyKind,
      text: reply,
      resumable: legacyNeedsInput,
    },
  };
}

const PUBLIC_TOOL_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function publicToolIdentifier(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return PUBLIC_TOOL_IDENTIFIER_RE.test(candidate) ? candidate : '';
}

/**
 * One privacy-safe public progress label. The canonical top-level tool name is
 * runtime-owned event metadata; call_tool's target name and Composio slug are
 * model-supplied arguments and therefore stay private until a future producer
 * can attach a separately validated public identity. Shape-checking an argument
 * is not validation: secrets, paths, and queries can all look identifier-like.
 */
function publicToolProgressLabel(toolValue: unknown): string {
  const tool = publicToolIdentifier(toolValue);
  if (!tool) return 'using a tool';
  return `using ${tool}`.slice(0, 110);
}

/** Strict provider-slug grammar: uppercase snake with at least two segments
 *  (`OUTLOOK_SEND_EMAIL`). This is the NAME shape, never a value shape — no
 *  real secret is all-uppercase-with-underscores — so a slug the runtime's
 *  accounting layer attached (data.toolSlug / effectiveTool) may ship as the
 *  call's public identity. This is the "separately validated public identity"
 *  the privacy note below anticipated; free-text arguments stay private. */
const PUBLIC_DISPATCH_SLUG_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

function publicDispatchSlug(data: Record<string, unknown>): string {
  const candidate = firstString(data.toolSlug, data.effectiveTool);
  if (!candidate || candidate.length > 64) return '';
  return PUBLIC_DISPATCH_SLUG_RE.test(candidate) ? candidate : '';
}

/** call_tool and other host carriers wrap an inner tool; the WRAPPER name ("call tool") is
 *  all the strip could show, so a page of anonymous "call tool" rows hid what
 *  was actually happening (live 2026-08-07: write_file + sf data query rendered
 *  as identical blank rows, so the user could not see progress or steer). The
 *  runtime attaches the real inner tool as `effectiveTool` — runtime-owned
 *  metadata (accounting layer), NOT a model-supplied argument — so it is safe
 *  to surface as the row's identity. Lowercase built-in tool names only; a
 *  provider SLUG rides `publicDispatchSlug` already. */
const PUBLIC_INNER_TOOL_RE = /^[a-z][a-z0-9_]{1,48}$/;
function publicInnerTool(data: Record<string, unknown>): string {
  const wrapper = firstString(data.tool, data.toolName, data.name);
  if (wrapper !== 'call_tool') return '';
  const inner = firstString(data.effectiveTool);
  return inner && PUBLIC_INNER_TOOL_RE.test(inner) ? inner : '';
}

/** The read-result glimpse ("12 records · name, website, phone · sample").
 *  Structure-derived by the runtime; every field re-validated and bounded
 *  here so a malformed producer cannot widen the window. */
function publicResultGlimpse(data: Record<string, unknown>): Record<string, unknown> | null {
  const raw = data.glimpse;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const g = raw as Record<string, unknown>;
  const count = typeof g.count === 'number' && Number.isFinite(g.count) && g.count > 0 ? Math.floor(g.count) : 0;
  if (!count) return null;
  const key = firstString(g.key).slice(0, 40);
  const fields = Array.isArray(g.fields)
    ? g.fields.filter((f): f is string => typeof f === 'string' && f.length > 0 && f.length <= 40).slice(0, 6)
    : [];
  const sample = firstString(g.sample).slice(0, 80);
  return { count, ...(key ? { key } : {}), ...(fields.length ? { fields } : {}), ...(sample ? { sample } : {}) };
}

/** Runtime-owned effect classification (a closed enum, never model text). */
function publicToolEffect(data: Record<string, unknown>): string {
  const effect = firstString(data.effect);
  return effect === 'read' || effect === 'compute' || effect === 'local_write'
    || effect === 'external_write' || effect === 'admin'
    ? effect
    : '';
}

export interface PublicLiveApprovalControl {
  version: 1;
  ownerAttemptId: string;
  ownerSourceUserSeq: number;
}

/** Controls have their own acknowledgements while the original executor stays
 * live. Publish only a relationship backed by the original attempt and exact
 * accepted source; a copied terminal metadata field cannot claim ownership.
 */
function publicLiveApprovalControl(event: EventRow): PublicLiveApprovalControl | null {
  if (event.type !== 'conversation_completed' && !event.data.liveApprovalControl) return null;
  try {
    let source = event;
    if (event.type === 'conversation_completed') {
      const presentation = validTypedCompletionPresentation(event.data, event.sessionId);
      if (!presentation) return null;
      const seq = presentation.identity.sourceUserSeq;
      const accepted = listEvents(event.sessionId, { types: ['user_input_received'], sinceSeq: seq - 1, limit: 1 })[0];
      if (!accepted || accepted.seq !== seq || accepted.seq >= event.seq) return null;
      source = accepted;
    }
    if (!isLiveApprovalAcknowledgement(source)) return null;
    const control = source.data.liveApprovalControl as PublicLiveApprovalControl;
    const ownerSource = getRunAttemptSourceUserEvent({ sessionId: source.sessionId, attemptId: control.ownerAttemptId });
    if (!ownerSource || ownerSource.seq !== control.ownerSourceUserSeq || ownerSource.id !== source.parentEventId) return null;
    const claimed = event.data.liveApprovalControl as Partial<PublicLiveApprovalControl> | undefined;
    if (claimed && (claimed.version !== control.version || claimed.ownerAttemptId !== control.ownerAttemptId
      || claimed.ownerSourceUserSeq !== control.ownerSourceUserSeq)) return null;
    return { version: 1, ownerAttemptId: control.ownerAttemptId, ownerSourceUserSeq: control.ownerSourceUserSeq };
  } catch { return null; }
}

function projectData(event: EventRow): Record<string, unknown> | null {
  const data = event.data ?? {};
  switch (event.type) {
    case 'stream_token': {
      // Raw provider/model deltas are untrusted. A future ReplyComposer may emit
      // this marker once it owns a typed public-reply port.
      if (data.public !== true) return null;
      const delta = typeof data.delta === 'string' ? data.delta : '';
      return delta ? { delta, public: true } : null;
    }
    case 'user_input_received': {
      const liveApprovalControl = publicLiveApprovalControl(event);
      if (liveApprovalControl) {
        return { text: publicUserInputText(data), synthetic: true, liveApprovalControl };
      }
      if (data.synthetic === true) {
        if (data.source !== 'outcome') return null;
        return selected(data, ['synthetic', 'source', 'sourceId', 'sourceLabel', 'deliveryPhase']);
      }
      const input = publicUserInputText(data);
      const taskMode = publicTaskMode(data.taskMode);
      return input ? { text: input, ...(taskMode ? { taskMode } : {}) } : null;
    }
    case 'plan_revision_published': {
      const ref = publicPlanArtifactRef(data.planArtifactRef);
      if (!ref || event.role !== 'host' || !event.parentEventId
        || !Number.isSafeInteger(data.sourceUserSeq) || Number(data.sourceUserSeq) <= 0
        || (data.readiness !== 'ready' && data.readiness !== 'needs_input')) return null;
      return { planArtifactRef: ref, sourceUserSeq: data.sourceUserSeq, readiness: data.readiness };
    }
    case 'plan_execution_claimed': {
      const claim = data.claim as Record<string, unknown> | undefined;
      const ref = publicPlanArtifactRef(claim?.ref);
      if (!claim || !ref || event.role !== 'host' || event.parentEventId !== claim.sourceEventId
        || event.sessionId !== claim.sessionId || !Number.isSafeInteger(claim.sourceUserSeq)
        || Number(claim.sourceUserSeq) <= 0 || typeof claim.executionRunId !== 'string'
        || !claim.executionRunId || typeof claim.claimId !== 'string' || !claim.claimId) return null;
      return { planArtifactRef: ref, sourceUserSeq: claim.sourceUserSeq,
        executionRunId: claim.executionRunId, claimId: claim.claimId, executionReserved: true };
    }
    // Mid-run steering: the user's own words, shown in their own transcript —
    // same trust class as user_input_received. Delivery markers stay internal.
    case 'user_steer_note': {
      const text = typeof data.text === 'string' ? data.text : '';
      return text ? { text } : null;
    }
    case 'turn_model_routed': {
      // Route identity is useful, but route diagnostics are not presentation:
      // expose only bounded provider/model names plus two closed transition
      // bits. Internal failure reasons, abandoned brains, transport, attempts,
      // and route topology stay in the audit ledger.
      const model = publicToolIdentifier(data.model);
      const provider = publicToolIdentifier(data.provider);
      if (!model && !provider) return null;
      return {
        phase: 'model',
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
        fallover: data.fallover === true,
        preselected: data.preselected === true,
      };
    }
    // The compiled turn plan, as a SHAPE summary only: route + fast-path +
    // node count. The chat header uses route/fast-path to name the kind of
    // work ("Looking this up…"); node count is not user-facing. Hashes,
    // policy internals, and the graph body stay private.
    case 'turn_graph_compiled': {
      const fastPath = typeof data.fastPath === 'string' ? data.fastPath : '';
      const route = typeof data.route === 'string' ? data.route : '';
      const nodeCount = typeof data.nodeCount === 'number' ? data.nodeCount : 0;
      if (!route || nodeCount <= 0) return null;
      return { route, fastPath, nodeCount };
    }
    case 'conversation_completed': {
      const liveApprovalControl = publicLiveApprovalControl(event);
      return { ...terminalData(data, event.sessionId), ...(liveApprovalControl ? { liveApprovalControl } : {}) };
    }
    case 'conversation_preamble':
      // The dedicated eventlog CAS writer binds this event to its exact real
      // user source. Retain a small event-level floor here as well so a
      // malformed generic row cannot become public merely because its data
      // object resembles the closed payload.
      if (!event.parentEventId || event.role !== 'Clem' || !Number.isSafeInteger(event.turn) || event.turn < 0) {
        return null;
      }
      return publicConversationPreambleData(data);
    case 'conversation_check_in':
      // Same event-level floor as the preamble: bound to its source, authored
      // by Clem, on a real turn. A malformed generic row must never reach a
      // thread just because its payload resembles the closed shape.
      if (!event.parentEventId || event.role !== 'Clem' || !Number.isSafeInteger(event.turn) || event.turn < 0) {
        return null;
      }
      return publicConversationCheckInData(data);
    case 'async_work_dispatched':
      return publicAsyncWorkDispatchedData(data);
    case 'awaiting_user_input': {
      const question = publicReplyText(data.question, 'I need your input before I can continue.');
      return {
        question,
        options: stringList(data.options, 8),
        ...selected(data, ['source', 'approvalId', 'pendingQuestionId', 'sourceId']),
      };
    }
    case 'approval_requested': {
      const action = pendingActionProjection(data.pendingAction);
      const actionId = pendingActionId(data);
      const consentCall = data.consentCall && typeof data.consentCall === 'object'
        && !Array.isArray(data.consentCall) ? data.consentCall as Record<string, unknown> : null;
      const risk = consentCall?.risk && typeof consentCall.risk === 'object'
        && !Array.isArray(consentCall.risk) ? consentCall.risk as Record<string, unknown> : null;
      return {
        ...selected(data, [
          'approvalId', 'subject', 'tool', 'destructive', 'expiresAt', 'sourceId',
          'approvalPresentation', 'question',
        ]),
        ...(actionId ? { pendingActionId: actionId } : {}),
        ...(action ? { pendingAction: action } : {}),
        ...(consentCall && risk ? { consentCall: {
          ...selected(consentCall, ['effect', 'accountId']),
          risk: selected(risk, ['reversibility', 'consequence', 'destructive']),
        } } : {}),
      };
    }
    case 'approval_resolved':
      return selected(data, ['approvalId', 'decision', 'resolution', 'sourceId']);
    case 'run_failed':
      // Execution failures are private evidence, not a second terminal
      // protocol. The bridge/graph reducer publishes one typed failed
      // conversation_completed outcome after it owns the exact logical turn.
      // Projecting this row as well races that terminal live and disappears on
      // replay because transcripts intentionally consume only completions.
      return null;
    case 'tool_called': {
      const innerTool = publicInnerTool(data);
      const labelName = innerTool || firstString(data.tool, data.toolName, data.name) || 'tool';
      const progress = publicToolProgressLabel(labelName);
      const publicSlug = publicDispatchSlug(data);
      return {
        ...selected(data, ['tool', 'toolName', 'name', 'callId', 'call_id', 'batchMode', 'accounting']),
        ...(innerTool ? { innerTool } : {}),
        ...(progress ? { progress } : {}),
        ...(publicSlug ? { publicSlug } : {}),
        ...(publicToolEffect(data) ? { effect: publicToolEffect(data) } : {}),
      };
    }
    case 'tool_returned': {
      const innerTool = publicInnerTool(data);
      const publicSlug = publicDispatchSlug(data);
      const glimpse = publicResultGlimpse(data);
      const reused = isSettledReadReplayReturnData(data);
      return {
        ...selected(data, ['tool', 'toolName', 'name', 'callId', 'call_id', 'ok', 'success', 'batchMode', 'accounting']),
        ...(innerTool ? { innerTool } : {}),
        ...(publicSlug ? { publicSlug } : {}),
        ...(publicToolEffect(data) ? { effect: publicToolEffect(data) } : {}),
        ...(glimpse ? { glimpse } : {}),
        // Derived at the trust boundary from the exact replay marker plus
        // providerDispatched:false. Replay ids and control prose stay private.
        ...(reused ? { reused: true, progress: SETTLED_READ_REUSE_LABEL } : {}),
      };
    }
    case 'deliverable_saved': {
      // Runtime truth: the write path emits this only after the filesystem
      // write succeeded, with basename + one parent segment — never a full
      // path. Both are still validated here so a malformed producer cannot
      // leak an absolute path onto the public bus.
      const name = firstString(data.name);
      if (!name || name.includes('/') || name.includes('\\') || name.length > 120) return null;
      const dir = firstString(data.dir);
      const excerpt = firstString(data.excerpt);
      return {
        name,
        ...(dir && !dir.includes('/') && !dir.includes('\\') && dir.length <= 80 ? { dir } : {}),
        ...(typeof data.bytes === 'number' && Number.isFinite(data.bytes) ? { bytes: data.bytes } : {}),
        // The runtime read this back from the file it just wrote — the
        // session owner's own deliverable, bounded for the peek pane.
        ...(excerpt ? { excerpt: excerpt.slice(0, 700) } : {}),
      };
    }
    case 'handoff':
      return selected(data, ['from', 'to', 'target']);
    case 'step_started':
      return selected(data, ['step', 'stepId', 'title']);
    case 'conversation_limit_exceeded':
      return selected(data, ['reason', 'steps', 'maxSteps', 'maxTurns', 'maxWallClockMs', 'transport', 'autoResumed', 'autoResumeAttempt']);
    case 'worker_started':
    case 'worker_result':
    case 'worker_capped':
      return selected(data, ['item', 'role', 'model', 'provider', 'ok']);
    case 'batch_started':
    case 'batch_progress':
    case 'batch_completed':
      return selected(data, ['batchId', 'items', 'done', 'total', 'failed', 'succeeded', 'halted', 'throttled', 'itemId', 'slug', 'tool', 'sideEffect']);
    case 'external_write':
    case 'external_write_succeeded':
    case 'external_write_failed':
    case 'external_write_orphaned':
      return {
        ...selected(data, ['shapeKey', 'toolName', 'tool', 'callId', 'call_id', 'preDispatch']),
        targets: stringList(data.targets, 25),
      };
    case 'codemode_program_summary': // historical event presentation
      return selected(data, ['ok', 'rpcCalls', 'durationMs', 'completed', 'failed']);
    case 'capability_resolution': {
      // Typed "what Clem knows going in" frame. Bounded and sanitized: the
      // identifier must be a well-formed tool identifier; internal failure
      // prose stays private (the UI speaks plain voice from status + date).
      const rawEntries = Array.isArray(data.entries) ? data.entries.slice(0, 8) : [];
      const entries = rawEntries.flatMap((raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const e = raw as Record<string, unknown>;
        const identifier = firstString(e.identifier);
        const status = firstString(e.status);
        if (!identifier || !PUBLIC_TOOL_IDENTIFIER_RE.test(identifier)) return [];
        if (status !== 'proven' && status !== 'previously_failed') return [];
        return [{
          identifier,
          status,
          ...(firstString(e.intent) ? { intent: firstString(e.intent) } : {}),
          ...(firstString(e.kind) ? { kind: firstString(e.kind) } : {}),
          ...(firstString(e.connection) ? { connection: firstString(e.connection) } : {}),
          ...(firstString(e.accountIdentity) ? { accountIdentity: firstString(e.accountIdentity) } : {}),
          ...(firstString(e.failedAt) ? { failedAt: firstString(e.failedAt) } : {}),
        }];
      });
      if (entries.length === 0) return null;
      return { entries };
    }
    case 'expected_work_progress': {
      // Host plan card only. Requirement ids are mechanical; the UI humanizes
      // them. Extra keys and unknown states fail closed.
      const sourceUserSeq = data.sourceUserSeq;
      if (
        data.version !== 1
        || !Number.isSafeInteger(sourceUserSeq)
        || Number(sourceUserSeq) <= 0
      ) return null;
      const rawLines = Array.isArray(data.lines) ? data.lines.slice(0, 32) : [];
      const lines = rawLines.flatMap((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const line = raw as Record<string, unknown>;
        const id = firstString(line.id);
        const effect = firstString(line.effect);
        const state = firstString(line.state);
        if (!PUBLIC_WORK_REQUIREMENT_ID_RE.test(id)) return [];
        if (
          effect !== 'read' && effect !== 'compute' && effect !== 'local_write'
          && effect !== 'external_write' && effect !== 'admin'
        ) return [];
        if (
          state !== 'satisfied' && state !== 'data_in' && state !== 'open'
          && state !== 'blocked_on_dependency'
        ) return [];
        const settled = Number.isSafeInteger(line.settled) && Number(line.settled) >= 0
          ? Number(line.settled)
          : 0;
        const observed = Number.isSafeInteger(line.observed) && Number(line.observed) >= 0
          ? Number(line.observed)
          : 0;
        const required = line.required === null
          ? null
          : Number.isSafeInteger(line.required) && Number(line.required) >= 0
            ? Number(line.required)
            : null;
        const dependsOn = Array.isArray(line.dependsOn)
          ? line.dependsOn
            .filter((dep): dep is string => typeof dep === 'string' && PUBLIC_WORK_REQUIREMENT_ID_RE.test(dep))
            .slice(0, 32)
          : [];
        return [{ id, effect, state, settled, observed, required, dependsOn }];
      });
      if (lines.length === 0) return null;
      return { version: 1, sourceUserSeq: Number(sourceUserSeq), lines };
    }
    case 'verdict_recorded':
      return selected(data, ['door', 'pass', 'failedOpen', 'selfJudge', 'criteriaMet', 'criteriaTotal']);
    case 'heartbeat': {
      // A progress check-in's `message` is the HOST-COMPOSED ledger line
      // (composeRunProgressLine — plan/evidence/collection facts, no model
      // prose, no arguments). Projecting it is what lets Discord and the
      // desktop feed say "plan 1/3 steps underway · 25-item collection"
      // instead of an unchanging "Still working" (live 2026-08-18
      // session-fixture-unprovisioned-catalog: 13 ledger heartbeats, zero reached a surface). Other
      // heartbeat kinds keep the kind-only projection.
      const base = selected(data, ['kind']);
      if (data.kind !== 'progress_check_in') return base;
      const message = firstString(data.message).slice(0, 300);
      return { ...base, ...(message ? { message } : {}) };
    }
    case 'turn_started':
    case 'turn_ended':
    case 'plan_drafted':
    case 'plan_approved':
    case 'plan_revised':
    case 'plan_rejected':
    case 'stall_retry_attempted':
    case 'memory_signals_captured':
    case 'run_paused':
    case 'run_resumed':
    case 'run_completed':
      return {};
    default:
      // A new event earns no place on the public bus until this switch
      // explicitly grants both its type and its safe payload projection.
      return null;
  }
}

/** Project one raw harness row into the public chat event plane. */
export function projectHarnessEventForPublic(event: EventRow): EventRow | null {
  if (PRIVATE_EVENT_TYPES.has(event.type)) return null;
  if (
    (event.type === 'tool_called' || event.type === 'tool_returned')
    && !isCanonicalTopLevelToolEvent(event)
  ) return null;
  let data: Record<string, unknown> | null;
  try { data = projectData(event); } catch { return null; }
  if (data === null) return null;
  return {
    ...event,
    // Parent links are execution topology, not presentation state.
    parentEventId: null,
    data,
  };
}

/** Project a replay batch while retaining the raw event sequence as its cursor. */
export function projectHarnessEventsForPublic(events: readonly EventRow[]): EventRow[] {
  // A database upgraded from 3.5 can already contain both the former
  // brain:<attempt> terminal and a later turn:<source> terminal for the same
  // accepted input. It can also contain two source-tagged legacy completions
  // from the same physical attempt. Keep every raw row for audit, but public
  // replay elects the earliest valid terminal for that logical source. Compute
  // the winner by durable seq rather than trusting caller order.
  const winnerBySource = new Map<string, EventRow>();
  const reusedToolCallIds = new Set<string>();
  const reusedToolCallParentIds = new Set<string>();
  const canonicalToolCallIdCounts = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'tool_called' && isCanonicalTopLevelToolEvent(event)) {
      const callId = firstString(
        event.data.canonicalCallId,
        event.data.callId,
        event.data.call_id,
      );
      if (callId) canonicalToolCallIdCounts.set(
        callId,
        (canonicalToolCallIdCounts.get(callId) ?? 0) + 1,
      );
    }
    if (event.type === 'tool_returned' && isCanonicalTopLevelToolEvent(event)) {
      const callId = settledReadReplayCallId(event.data);
      if (callId) {
        reusedToolCallIds.add(callId);
        if (event.parentEventId) reusedToolCallParentIds.add(event.parentEventId);
      }
    }
    if (event.type !== 'conversation_completed') continue;
    // A row that advertises the typed contract but fails validation is private
    // evidence, not a legacy candidate allowed to suppress a valid owner.
    if (claimsTypedCompletion(event.data)
      && !validTypedCompletionPresentation(event.data, event.sessionId)) continue;
    const key = completionSourceKey(event);
    if (!key) continue;
    const prior = winnerBySource.get(key);
    if (!prior || event.seq < prior.seq) winnerBySource.set(key, event);
  }

  const projected: EventRow[] = [];
  for (const event of events) {
    if (event.type === 'conversation_completed' && claimsTypedCompletion(event.data)) {
      const presentation = validTypedCompletionPresentation(event.data, event.sessionId);
      // Corrupt/partial typed rows are private audit evidence on replay. They
      // cannot launder a copied legacy reply, nor can an unvalidated source
      // claim suppress the real winner.
      if (!presentation) continue;
    }
    if (event.type === 'conversation_completed') {
      const key = completionSourceKey(event);
      if (key && winnerBySource.get(key) !== event) continue;
    }
    const row = projectHarnessEventForPublic(event);
    if (!row) continue;
    if (event.type === 'tool_called') {
      const callId = firstString(
        event.data.canonicalCallId,
        event.data.callId,
        event.data.call_id,
      );
      const reused = reusedToolCallParentIds.has(event.id)
        || Boolean(
          callId
          && canonicalToolCallIdCounts.get(callId) === 1
          && reusedToolCallIds.has(callId),
        );
      if (reused) {
        // Keep the canonical call row (it is an honest model attempt), but
        // narrate how that attempt settled instead of implying a fresh fetch.
        row.data = {
          ...row.data,
          reused: true,
          progress: SETTLED_READ_REUSE_LABEL,
        };
      }
    }
    projected.push(row);
  }
  return projected;
}
