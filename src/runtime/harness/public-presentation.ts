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
import type { EventRow } from './eventlog.js';
import {
  parseNarratedEnvelope,
  publicReplyFromNarratedEnvelope,
} from './envelope-narration.js';
import {
  presentationEventFromCompletionData,
  type PresentationEvent,
} from './turn-outcome.js';
import { looksLikeToolCallShape } from './tool-narration-shapes.js';
import { looksLikeCompactDecisionProtocol } from './presentation-hygiene.js';
import { isCanonicalTopLevelToolEvent } from './tool-effect.js';

const PRIVATE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn_ended',
  'turn_preflight_decision',
  'conversation_step',
  'conversation_recovery_candidate',
  'cross_session_prefix',
  'agent_context_packet',
  'turn_graph_compiled',
  'async_work_dispatch_prepared',
  'async_work_dispatch_batch_closed',
  'turn_memory_primer',
  'guardrail_tripped',
  'stuck_detected',
  'learning_candidate_evaluated',
]);

const DECISION_KEYS = new Set(['summary', 'reply', 'done', 'nextaction', 'reason']);
const RAW_TOOL_OR_REASONING_PROTOCOL_RE = /(?:<\/?(?:analysis|reasoning|invoke|tool_call)\b|\[tool\s*:|"tool_call"\s*:)/i;
const SAFE_TERMINAL_FALLBACK = 'I finished the turn, but the final reply was not safe to display. Please ask me to continue.';
export const PUBLIC_RUN_FAILURE_TEXT = 'Something went wrong on that turn. Please try again; the technical details are available in the activity log.';
export const PUBLIC_MODEL_RUNTIME_UNAVAILABLE_TEXT =
  'I could not start this turn because no model runtime is connected. Open Settings > Models, connect a model, and try again.';

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
  const candidate = text(value);
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
      if (data.synthetic === true) {
        if (data.source !== 'outcome') return null;
        return selected(data, ['synthetic', 'source', 'sourceId', 'sourceLabel', 'deliveryPhase']);
      }
      const input = publicUserInputText(data);
      return input ? { text: input } : null;
    }
    case 'conversation_completed':
      return terminalData(data, event.sessionId);
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
      return {
        ...selected(data, ['approvalId', 'subject', 'tool', 'destructive', 'expiresAt', 'sourceId']),
        ...(actionId ? { pendingActionId: actionId } : {}),
        ...(action ? { pendingAction: action } : {}),
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
      const tool = firstString(data.tool, data.toolName, data.name) || 'tool';
      const progress = publicToolProgressLabel(tool);
      return {
        ...selected(data, ['tool', 'toolName', 'name', 'callId', 'call_id', 'batchMode', 'accounting']),
        ...(progress ? { progress } : {}),
      };
    }
    case 'tool_returned':
      return selected(data, ['tool', 'toolName', 'name', 'callId', 'call_id', 'ok', 'success', 'batchMode', 'accounting']);
    case 'handoff':
      return selected(data, ['from', 'to', 'target']);
    case 'step_started':
      return selected(data, ['step', 'stepId', 'title']);
    case 'conversation_limit_exceeded':
      return selected(data, ['reason', 'steps', 'maxSteps', 'maxTurns', 'maxWallClockMs', 'transport']);
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
    case 'codemode_program_summary':
      return selected(data, ['ok', 'rpcCalls', 'durationMs', 'completed', 'failed']);
    case 'verdict_recorded':
      return selected(data, ['door', 'pass', 'failedOpen', 'selfJudge', 'criteriaMet', 'criteriaTotal']);
    case 'heartbeat':
      return selected(data, ['kind']);
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
  for (const event of events) {
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
    if (row) projected.push(row);
  }
  return projected;
}
