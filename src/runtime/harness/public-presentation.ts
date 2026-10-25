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
import { withoutHostReceiptLines } from '../host-receipt-lines.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getEvent, getRunAttemptSourceUserEvent, listEvents, openEventLog, type EventRow } from './eventlog.js';
import { BoundaryError } from '../boundary-error.js';
import { isBackgroundOutcomeSource, isLiveApprovalAcknowledgement } from './accepted-source-kind.js';
import {
  parseNarratedEnvelope,
  publicReplyFromNarratedEnvelope,
} from './envelope-narration.js';
import {
  assertPublicPresentationText,
  presentationEventFromCompletionData,
  type PresentationEvent,
} from './turn-outcome.js';
import { looksLikeToolCallShape, looksLikeToolCallShapeStreaming } from './tool-narration-shapes.js';
import { isProviderCapacityExhausted, isProviderCreditRefusal } from '../../shared/provider-capacity.js';
import {
  looksLikeCompactDecisionProtocol,
  stripLeakedDecisionAssignment,
} from './presentation-hygiene.js';
import { isCanonicalTopLevelToolEvent } from './tool-effect.js';
import { parseRetainedWorkCheckpoint, type RetainedOutsideChange } from './retained-work-checkpoint.js';
import { normalizeTerminalNotice, type TerminalNotice } from './terminal-notice.js';
import { publicApprovalDecisionAck } from './approval-decision-ack.js';
import {
  isSettledReadReplayReturnData,
  settledReadReplayCallId,
  SETTLED_READ_REUSE_LABEL,
} from './settled-read-replay-semantics.js';
import { WORK_ID_PATTERN } from '../../shared/work-id.js';
import { appForWriteAction } from '../../integrations/composio/toolkit-identity.js';
import { workerModelOfferResolution } from './worker-model-offer.js';
import { parsePlanRevisionRef, parseTaskMode, type PlanRevisionRef, type TaskMode } from './task-mode.js';
import {
  isInteractiveConsentConsequence,
  isInteractiveConsentReversibility,
  recordedConsentAffirmsChange,
} from './interactive-consent-policy.js';

/** The host-built approval preview (operation + argument values the owner is
 * approving), admitted only in its exact bounded shape. */
type ApprovalPreviewField = { name: string; value: string; label?: string; detail?: true; display?: string };
type ApprovalPreview = { operation: string; fields: ApprovalPreviewField[]; check?: ApprovalPreviewCheck; items?: ApprovalPreview[]; does?: string; ask?: string; why?: string };
type ApprovalPreviewCheck = { status: 'clear' | 'conflicts' | 'unavailable'; conflicts?: string[] };

function approvalPreviewCheck(value: unknown): ApprovalPreviewCheck | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { status, conflicts } = value as Record<string, unknown>;
  if (status !== 'clear' && status !== 'conflicts' && status !== 'unavailable') return null;
  if (conflicts === undefined) return { status };
  if (!Array.isArray(conflicts) || conflicts.length > 3
    || conflicts.some((line) => typeof line !== 'string' || !line.trim() || line.length > 300)) return null;
  return { status, conflicts: conflicts as string[] };
}

export function approvalPreviewProjection(value: unknown): { preview: ApprovalPreview } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.operation !== 'string' || !record.operation.trim() || record.operation.length > 80) return null;
  if (!Array.isArray(record.fields) || record.fields.length > 16) return null;
  const fields: ApprovalPreviewField[] = [];
  let totalCharacters = 0;
  for (const field of record.fields) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) return null;
    const { name, value: shown, label, detail, display } = field as Record<string, unknown>;
    if (typeof name !== 'string' || typeof shown !== 'string' || !name || name.length > 80) return null;
    // A grouped review contains all prepared actions. Keep the total bounded
    // without silently dropping its preview at the former per-field limit.
    totalCharacters += shown.length;
    if (totalCharacters > 256_000) return null;
    // A file named on the card ("q3 report.pdf · 120 KB · in Reports") can run
    // to the card's own 300-character label bound.
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 300)) return null;
    if (display !== undefined && (typeof display !== 'string' || !display.trim() || display.length > 700)) return null;
    fields.push({
      name, value: shown,
      ...(typeof label === 'string' ? { label } : {}),
      ...(typeof display === 'string' ? { display } : {}),
      ...(detail === true ? { detail: true as const } : {}),
    });
  }
  const check = approvalPreviewCheck(record.check);
  if (check === null) return null;
  let items: ApprovalPreview[] | undefined;
  if (record.items !== undefined) {
    if (!Array.isArray(record.items) || record.items.length < 2 || record.items.length > 100) return null;
    items = [];
    for (const item of record.items) {
      if (!item || typeof item !== 'object' || 'items' in item) return null;
      const admitted = approvalPreviewProjection(item);
      if (!admitted) return null;
      totalCharacters += JSON.stringify(admitted.preview).length;
      if (totalCharacters > 256_000) return null;
      items.push(admitted.preview);
    }
  }
  // The card in Clem's words (approval-precheck): carried on every public
  // surface, or the live card and the reopened one both fall back to the
  // operation name.
  const line = (value: unknown, max: number): string | undefined => (
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
  );
  const does = line(record.does, 240);
  const ask = line(record.ask, 200);
  const why = line(record.why, 260);
  return { preview: { operation: record.operation, fields, ...(check ? { check } : {}), ...(items ? { items } : {}),
    ...(does ? { does } : {}), ...(ask ? { ask } : {}), ...(why ? { why } : {}) } };
}

export function publicPlanArtifactRef(value: unknown): PlanRevisionRef | undefined {
  try { return value === undefined ? undefined : parsePlanRevisionRef(value); } catch { return undefined; }
}

export function publicTaskMode(value: unknown): TaskMode | undefined {
  try { return parseTaskMode(value); } catch { return undefined; }
}

const PRIVATE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'connection_execution_checkpoint_unavailable',
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
  'workflow_parent_checkpoint',
  'workspace_read_preparation_started',
  'watch_read_preparation_started',
  'clem_message',
  'workflow_parent_continuation_requested',
  'turn_memory_primer',
  'guardrail_tripped',
  'stuck_detected',
  'learning_candidate_evaluated',
  'durable_memory_intake_receipt',
  'approved_action_completion_intent',
  'approved_action_completion_receipt',
  'approved_action_provider_bound',
]);

const DECISION_KEYS = new Set(['summary', 'reply', 'done', 'nextaction', 'reason']);
const RAW_TOOL_OR_REASONING_PROTOCOL_RE = /(?:<\/?(?:analysis|reasoning|invoke|tool_call)\b|\[tool\s*:|"tool_call"\s*:)/i;
const SAFE_TERMINAL_FALLBACK =
  'The final reply was not safe to display. I cannot confirm this request is complete. Check the activity log for available details.';
const LEGACY_MISSING_REPLY_FALLBACK =
  'I do not have a final reply to confirm this request is complete. Ask me to check what completed and what remains before continuing.';
/** The host could not seal a model request because its local vault has no
 *  seal key, so every model request fails before it starts. */
export const PUBLIC_VAULT_NOT_READY_TEXT = 'Clementine\'s local vault isn\'t ready, so no model request can start. Quit and reopen Clementine; if this keeps happening, the home folder needs repair.';
// The failure lines below are app status, not Clem's words: no first person.
// They serve the CLI, channels and model history; desktop and phone draw the
// notice published beside them instead (see publicRunFailureTerminal).
export const PUBLIC_RUN_FAILURE_TEXT = 'This request stopped on an error before it finished. The cause is not confirmed yet. Check what completed and what remains before retrying.';
export const PUBLIC_MODEL_EMPTY_COMPLETION_TEXT = 'The model returned no usable reply or next step, so this request is unfinished. Continue the unfinished work, or choose another model.';

export const PUBLIC_CODEX_AUTH_EXPIRED_TEXT = 'The Codex sign-in expired or was revoked, so this request is unfinished. Sign in again in Settings > Model accounts, then continue the unfinished work.';

/** The generic failure line as earlier releases stored it. Durable rows keep
 * their bytes, so readers that recognize the generic failure accept both. */
const LEGACY_PUBLIC_RUN_FAILURE_TEXT = 'I couldn\'t finish this request. The error\'s cause is not confirmed yet. Ask me to check what completed and what remains before retrying.';

/** Whether a stored terminal text is the generic failure line, current or as
 * an earlier release stored it. */
export function isPublicRunFailureText(text: string): boolean {
  return text === PUBLIC_RUN_FAILURE_TEXT || text === LEGACY_PUBLIC_RUN_FAILURE_TEXT;
}

export const PUBLIC_BLOCKED_NEXT_STEP_TEXT = 'The next step is blocked, so this request is still unfinished. Ask me to check the blocker and any completed work before continuing.';

/** A closed host-authored reason, carried independently of private error text.
 * A raw string or a provider object's similarly named property is not authority
 * to explain a failure as an empty completion or expired Codex sign-in. */
export type PublicRunFailureKind = 'model.empty_completion' | 'codex.auth_expired';

export function publicRunFailureKind(error: unknown): PublicRunFailureKind | undefined {
  return error instanceof BoundaryError && (error.kind === 'model.empty_completion' || error.kind === 'codex.auth_expired')
    ? error.kind
    : undefined;
}

export function publicRunFailureText(kind?: PublicRunFailureKind): string {
  return kind === 'model.empty_completion' ? PUBLIC_MODEL_EMPTY_COMPLETION_TEXT
    : kind === 'codex.auth_expired' ? PUBLIC_CODEX_AUTH_EXPIRED_TEXT
      : PUBLIC_RUN_FAILURE_TEXT;
}
/** A provider refusal for lack of credit or usage, read from the provider's
 * error text, with the words quotable only when they are one short plain
 * sentence (they usually name where to add more). */
function providerCapacityRefusal(error: unknown): { credit: boolean; providerSaid?: string } | null {
  const raw = typeof error === 'string' ? error.replace(/\s+/g, ' ').trim() : '';
  if (!raw) return null;
  const credit = isProviderCreditRefusal(undefined, raw);
  if (!credit && !isProviderCapacityExhausted(raw)) return null;
  const quotable = raw.length <= 240 && !/[{}[\]<>"]/.test(raw);
  return { credit, ...(quotable ? { providerSaid: raw } : {}) };
}

function providerCapacityLine(refusal: { credit: boolean; providerSaid?: string }): string {
  return [
    refusal.credit
      ? 'The model account this work runs on is out of credit, so this run stopped.'
      : 'The model account this work runs on has used up its usage, so this run stopped.',
    refusal.providerSaid ? `Its provider said: “${refusal.providerSaid}”` : '',
    refusal.credit
      ? 'Add credit on that account or choose a different model for this work, then resume or ask again.'
      : 'Add usage on that account (or wait for its limit to reset) or choose a different model for this work, then resume or ask again.',
    'The work done so far is saved.',
  ].filter(Boolean).join(' ');
}

/**
 * A model account that has used up its allowance or credit is not a mystery
 * failure: its owner can fix it, and trying again unchanged meets the same
 * refusal. Says so in app voice, and quotes the provider's own words when they
 * are one short plain sentence. Null for any other failure, which keeps the
 * generic text and its diagnostic private.
 */
export function publicProviderCapacityText(error: unknown): string | null {
  const refusal = providerCapacityRefusal(error);
  return refusal ? providerCapacityLine(refusal) : null;
}

/**
 * The failed terminal for a run: an app-voice line for the CLI, channels and
 * model history, and the notice desktop and phone draw as a status line with
 * its action. Closed facts only: a typed failure kind first, then a provider's
 * credit or usage refusal, else the generic failure. Private error text never
 * becomes the line; only a quotable provider refusal travels, as the
 * provider's words.
 */
export function publicRunFailureTerminal(input: {
  failureKind?: PublicRunFailureKind;
  /** Provider error text, read only for a credit or usage refusal. */
  error?: unknown;
}): { text: string; notice: TerminalNotice } {
  if (input.failureKind === 'codex.auth_expired') {
    return { text: PUBLIC_CODEX_AUTH_EXPIRED_TEXT, notice: { code: 'codex_sign_in_expired' } };
  }
  if (input.failureKind === 'model.empty_completion') {
    return { text: PUBLIC_MODEL_EMPTY_COMPLETION_TEXT, notice: { code: 'model_stalled' } };
  }
  const refusal = providerCapacityRefusal(input.error);
  if (refusal) {
    return {
      text: providerCapacityLine(refusal),
      notice: {
        code: refusal.credit ? 'provider_out_of_credit' : 'provider_quota',
        ...(refusal.providerSaid ? { providerSaid: refusal.providerSaid } : {}),
      },
    };
  }
  return { text: PUBLIC_RUN_FAILURE_TEXT, notice: { code: 'run_failed' } };
}
export const PUBLIC_MODEL_RUNTIME_UNAVAILABLE_TEXT =
  'No model runtime is connected, so this turn could not start. Open Settings > Models, connect a model, and try again.';

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

/** Legacy reason text identifies only a topic to check, not evidence of a
 * provider call, effects, retry safety, approval, or an armed recovery owner.
 * Keep those facts with typed authority and keep private details out of copy. */
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
  const lead = kind === 'uncertain'
    ? 'I cannot confirm the outcome, so this request is still unfinished.'
    : 'The next step is blocked, so this request is still unfinished.';
  const check = cause === 'account'
    ? 'the required account'
    : cause === 'schema' || cause === 'provider_identity'
      ? 'the capability details'
      : cause === 'observation'
        ? 'the missing observation'
        : cause === 'reconciliation' || cause === 'unsupported_write' || cause === 'settlement'
          ? 'the recorded execution state'
          : 'the blocker';
  return `${lead} Ask me to check ${check} and any completed work for this exact request before continuing.`;
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
/** What the owner's answer to an approval card reads as (the same words as
 *  @clem/chat-engine's APPROVAL_ANSWER_WORDS). The decision travels as
 *  `approve apr-…` for the parser; the owner's bubble never reads as that. */
export const APPROVAL_ANSWER_WORDS = {
  approve: 'Yes, go ahead.',
  reject: 'No, don’t do that.',
} as const;

export function publicUserInputText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const data = value as Record<string, unknown>;
  return text(data.displayText) || text(data.text ?? data.message);
}

/** Display metadata issued only after the owner's exact meeting choice was
 * verified. It is never input, an objective, or permission to run/replay work. */
export interface MeetingLookupOwnerPresentation {
  version: 1;
  kind: 'meeting_lookup';
  meetingId: string;
  offerId: string;
  offerDigest: string;
  sourceDigest: string;
  clientRequestId: string;
  privateOriginSessionId: string;
  inputHash: string;
  question: string;
}

function meetingLookupOwnerQuestion(value: unknown, sessionId?: string): string | null {
  if (!sessionId || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const candidate = data.meetingLookupPresentation;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || data.synthetic === true) return null;
  const shown = candidate as Record<string, unknown>;
  const keys = ['version', 'kind', 'meetingId', 'offerId', 'offerDigest', 'sourceDigest',
    'clientRequestId', 'privateOriginSessionId', 'inputHash', 'question'];
  if (Object.keys(shown).length !== keys.length || Object.keys(shown).some(key => !keys.includes(key))
    || shown.version !== 1 || shown.kind !== 'meeting_lookup'
    || typeof shown.meetingId !== 'string' || !shown.meetingId.trim() || shown.meetingId.length > 512
    || typeof shown.offerId !== 'string' || !shown.offerId.trim() || shown.offerId.length > 80
    || typeof shown.question !== 'string' || !shown.question.trim() || shown.question.length > 500 || shown.question.includes('\0')
    || !['offerDigest', 'sourceDigest', 'inputHash'].every(key => typeof shown[key] === 'string' && /^[a-f0-9]{64}$/.test(shown[key] as string))
    || typeof shown.clientRequestId !== 'string' || !/^meeting-lookup-[a-f0-9]{64}$/.test(shown.clientRequestId)
    || shown.privateOriginSessionId !== sessionId
    || data.requestId !== shown.clientRequestId || data.clientRequestId !== shown.clientRequestId
    || typeof data.displayText !== 'string' || data.displayText.length > 6_000) return null;
  const digest = (input: string) => createHash('sha256').update(input).digest('hex');
  if (shown.clientRequestId !== `meeting-lookup-${digest(JSON.stringify([shown.meetingId, shown.offerId, shown.offerDigest]))}`
    || sessionId !== `sess-desktop-${digest(shown.clientRequestId).slice(0, 24)}`
    // The private lookup front door excludes attachments, modes and bindings;
    // this is its existing canonical raw-input hash, not new work authority.
    || shown.inputHash !== digest(JSON.stringify({ input: data.displayText, attachmentIds: [] }))) return null;
  try {
    const packet = JSON.parse(data.displayText.slice(data.displayText.lastIndexOf('\n') + 1)) as Record<string, unknown>;
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)
      || packet.meetingId !== shown.meetingId || packet.offerId !== shown.offerId
      || packet.sourceDigest !== shown.sourceDigest || packet.question !== shown.question) return null;
  } catch { return null; }
  return shown.question;
}

/** A host-created private research source displays its question, while every
 * acceptance, replay and objective reader keeps the full evidence packet. */
function meetingResearchOwnerQuestion(value: unknown, sessionId?: string): string | null {
  if (!sessionId || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.source !== 'meeting_research' || data.synthetic === true || typeof data.text !== 'string'
    || data.text !== data.displayText || data.text.length > 100_000) return null;
  const reference = data.meetingResearchReference as Record<string, unknown> | undefined;
  const hash = (input: string) => createHash('sha256').update(input).digest('hex');
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)
    || Object.keys(reference).sort().join(',') !== 'grantDigest,grantRevision,jobId,meetingId'
    || typeof reference.meetingId !== 'string' || !reference.meetingId || reference.meetingId.length > 512
    || typeof reference.jobId !== 'string' || !/^[a-f0-9]{64}$/.test(reference.jobId)
    || typeof reference.grantDigest !== 'string' || !/^[a-f0-9]{64}$/.test(reference.grantDigest)
    || !Number.isSafeInteger(reference.grantRevision) || Number(reference.grantRevision) <= 0
    || data.clientRequestId !== `meeting-research-${reference.jobId}` || data.requestId !== data.clientRequestId
    || sessionId !== `sess-desktop-${hash(JSON.stringify(data.clientRequestId)).slice(0, 24)}`
    || data.meetingResearchInputDigest !== hash(data.text)) return null;
  try {
    const packet = JSON.parse(data.text.slice(data.text.lastIndexOf('\n') + 1)) as Record<string, unknown>;
    if (!packet || typeof packet !== 'object' || Array.isArray(packet) || packet.meetingId !== reference.meetingId
      || typeof packet.question !== 'string' || !packet.question.trim() || packet.question.length > 500) return null;
    return packet.question;
  } catch { return null; }
}

/** The owner's message as a reopened conversation shows it. Display only —
 *  replay and resume compare the recorded text through publicUserInputText.
 *  A card answer (a button, not written words) reads as the owner's answer;
 *  a written change keeps the owner's own words. */
export function ownerBubbleText(value: unknown, sessionId?: string): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const data = value as Record<string, unknown>;
    if (typeof data.approvalId === 'string' && data.changeRequested !== true) {
      if (data.decision === 'approve' || data.decision === 'approve_with_edits') return APPROVAL_ANSWER_WORDS.approve;
      if (data.decision === 'reject') return APPROVAL_ANSWER_WORDS.reject;
    }
  }
  return meetingLookupOwnerQuestion(value, sessionId) ?? meetingResearchOwnerQuestion(value, sessionId) ?? publicUserInputText(value);
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
  // A write tool's machine receipt (its marker, JSON facts and artifact
  // lines) is the host's evidence, never words for a person.
  const candidate = stripLeakedDecisionAssignment(withoutHostReceiptLines(text(value) ?? '').trim());
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

/** Text still being written can end mid-protocol, before the closing tag or
 *  brace the whole-reply checks above look for. Live answer text is refused
 *  on the same protocol shapes, including their unfinished openings. */
export function publicLiveTextUnsafe(value: string): boolean {
  return RAW_TOOL_OR_REASONING_PROTOCOL_RE.test(value)
    || looksLikeToolCallShape(value)
    || looksLikeToolCallShapeStreaming(value);
}

const PUBLIC_STREAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

/** A live answer frame: text placed at `offset` of one provisional draft, or
 *  that draft's retraction. Never persisted; see answer-stream.ts. The
 *  producer checks the whole draft before a frame exists; a fragment is not
 *  re-checked here, because line-anchored shapes misread mid-sentence text. */
function publicStreamTokenData(data: Record<string, unknown>): Record<string, unknown> | null {
  if (data.public !== true) return null;
  const streamId = typeof data.streamId === 'string' && PUBLIC_STREAM_ID_RE.test(data.streamId) ? data.streamId : '';
  if (!streamId) return null;
  const sourceUserSeq = Number.isSafeInteger(data.sourceUserSeq) && Number(data.sourceUserSeq) > 0
    ? { sourceUserSeq: Number(data.sourceUserSeq) }
    : {};
  if (data.reset === true) {
    const reason = typeof data.reason === 'string' && PUBLIC_STREAM_RESET_REASONS.has(data.reason) ? { reason: data.reason } : {};
    return { public: true, streamId, reset: true, ...reason, ...sourceUserSeq };
  }
  const offset = Number.isSafeInteger(data.offset) && Number(data.offset) >= 0 ? Number(data.offset) : -1;
  const delta = typeof data.delta === 'string' ? data.delta : '';
  const checking = data.checking === true ? { checking: true } : {};
  // A review marker on its own carries no text.
  if (offset < 0 && !delta && data.checking === true) return { public: true, streamId, checking: true, ...sourceUserSeq };
  if (offset < 0 || !delta) return null;
  return { public: true, streamId, offset, delta, ...checking, ...sourceUserSeq };
}

/** Why a draft was withdrawn: the answer stream's closed vocabulary. */
const PUBLIC_STREAM_RESET_REASONS: ReadonlySet<string> = new Set(['review', 'tool_call', 'writer', 'continuation']);

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
      ? 'Queued — waiting for the workflow to start. I’ll post the result here when it’s ready.'
      : `Queued ${runIds.length} workflows — waiting to start. I’ll post one combined result here when they’re ready.`,
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
    const missingReply = data.reply === undefined || data.reply === null
      || (typeof data.reply === 'string' && !data.reply.trim());
    if (typedPresentation) return publicPresentationText(typedPresentation);
    const reply = publicReplyText(data.reply, '');
    return parseRetainedWorkCheckpoint(reply).head
      || (missingReply && fallback === SAFE_TERMINAL_FALLBACK
        ? LEGACY_MISSING_REPLY_FALLBACK : fallback);
  } catch {
    // A row that claims the typed contract but contradicts it is not legacy.
    // Its duplicated reply/summary fields came from the same invalid write and
    // cannot be laundered into publication through the compatibility adapter.
    return fallback;
  }
}

/** Public transports and transcript readers must apply the same checkpoint
 * projection as SSE. The durable presentation retains redeemable evidence;
 * decoding its typed identity alone does not make that private tail chat copy.
 * Every status reads the authored words before the checkpoint and nothing
 * more: what was kept travels as `retained` data on the terminal, never as a
 * sentence written for Clem. The head may be empty. */
export function publicPresentationText(presentation: PresentationEvent): string {
  return parseRetainedWorkCheckpoint(presentation.text).head;
}

/** The durable terminal as the MODEL's history carries it: the authored
 * words plus the host's retained-work checkpoint, with its redeemable rh_
 * handles and landed writes. A successor that continues a stopped turn reads
 * this, so it knows what already happened; every public transport still
 * projects the head alone. Never publish this text. */
export function durableCompletionTextForModel(data: Record<string, unknown>): string {
  try {
    const typedPresentation = presentationEventFromCompletionData(data);
    return typedPresentation ? typedPresentation.text : publicReplyText(data.reply, '');
  } catch {
    return '';
  }
}

const PUBLIC_REVIEW_STATES: ReadonlySet<string> = new Set(['checked', 'unchecked', 'rejected', 'needs_recheck', 'checking']);
/** The rulings a review held for after delivery can settle on. */
const PUBLIC_SETTLED_REVIEW_STATES: ReadonlySet<string> = new Set(['checked', 'unchecked', 'rejected']);
const PUBLIC_REVIEW_NOTE_MAX_CHARS = 400;

/** The committer's review state for the exact published text. Only the
 * committer writes it (it is not caller metadata); an unknown value stays
 * private rather than being guessed into a chip. */
function publicTerminalReview(data: Record<string, unknown>): {
  review?: 'checked' | 'unchecked' | 'rejected' | 'needs_recheck' | 'checking';
  reviewNote?: string;
} {
  const review = typeof data.review === 'string' && PUBLIC_REVIEW_STATES.has(data.review)
    ? data.review as 'checked' | 'unchecked' | 'rejected' | 'needs_recheck' | 'checking'
    : undefined;
  if (!review) return {};
  const note = typeof data.reviewNote === 'string'
    ? data.reviewNote.replace(/\s+/g, ' ').trim().slice(0, PUBLIC_REVIEW_NOTE_MAX_CHARS)
    : '';
  return { review, ...(note ? { reviewNote: note } : {}) };
}

/** The later ruling on an answer published while `checking`: which source's
 * chip it settles, the ruling, and the reviewer's bounded finding. Written
 * only by review-after-delivery.ts; any other shape stays private. */
export function publicReviewSettledData(event: EventRow): Record<string, unknown> | null {
  const data = event.data ?? {};
  if (event.role !== 'system' || data.version !== 1
    || !Number.isSafeInteger(data.sourceUserSeq) || Number(data.sourceUserSeq) < 1
    || typeof data.review !== 'string' || !PUBLIC_SETTLED_REVIEW_STATES.has(data.review)) return null;
  const note = data.review === 'rejected' && typeof data.reviewNote === 'string'
    ? data.reviewNote.replace(/\s+/g, ' ').trim().slice(0, PUBLIC_REVIEW_NOTE_MAX_CHARS)
    : '';
  return { version: 1, sourceUserSeq: data.sourceUserSeq, review: data.review, ...(note ? { reviewNote: note } : {}) };
}

/** What the checkpoint kept, as counts. A needs-input terminal shows the
 * question alone, so its checkpoint stays private there. */
function publicTerminalRetained(
  textWithCheckpoint: string,
  waitingOnPerson: boolean,
): { retained?: { results: number; outsideChange: RetainedOutsideChange } } {
  if (waitingOnPerson) return {};
  const parsed = parseRetainedWorkCheckpoint(textWithCheckpoint);
  if (parsed.results <= 0 && parsed.outsideChange === 'none') return {};
  return { retained: { results: Math.max(0, parsed.results), outsideChange: parsed.outsideChange } };
}

/** An app status the clients render as chrome instead of a Clem bubble. Only
 * a known code passes; every string beside it is bounded again here. */
function publicTerminalNotice(data: Record<string, unknown>): { notice?: TerminalNotice } {
  const notice = normalizeTerminalNotice(data.hostNotice);
  // A card-only receipt needs an exact retained decision, not a copied notice.
  return notice && notice.code !== 'card_decision' ? { notice } : {};
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

/**
 * The typed facts a reopened reply needs to read as it did live: how it
 * ended, the review ruling and finding, what was kept, and any app notice.
 * Drawn from the same projection as live delivery, so a reopened reply shows
 * the same status line, pill and chip, never a sentence written for Clem.
 */
export function publicTerminalFacts(data: Record<string, unknown>, eventSessionId: string, event?: EventRow, acceptedSource?: EventRow): Record<string, unknown> {
  const projected = terminalData(data, eventSessionId);
  const approvalDecisionAck = event && event.sessionId === eventSessionId && isDeepStrictEqual(event.data, data)
    ? publicApprovalDecisionAck(event) : null;
  const presentation = projected.presentation && typeof projected.presentation === 'object'
    ? projected.presentation as Record<string, unknown> : {};
  const outcome = projected.turnOutcome && typeof projected.turnOutcome === 'object'
    ? projected.turnOutcome as Record<string, unknown> : null;
  const typed = validTypedCompletionPresentation(data, eventSessionId);
  const memoryReason = data.blockedReason === 'memory_consolidation_pending' || data.blockedReason === 'memory_work_unverified'
    ? data.blockedReason : undefined;
  const exactMemorySource = memoryReason && typed && event && event.type === 'conversation_completed'
    && event.sessionId === eventSessionId && isDeepStrictEqual(event.data, data)
    && acceptedSource?.type === 'user_input_received' && acceptedSource.role === 'user' && acceptedSource.data.synthetic !== true
    && acceptedSource.sessionId === eventSessionId && acceptedSource.seq === typed.identity.sourceUserSeq
    && event.seq > acceptedSource.seq;
  return {
    presentation: { status: presentation.status, kind: presentation.kind },
    ...(outcome ? { turnOutcome: selected(outcome, ['status', 'resumable', 'needs']) } : {}),
    ...selected(projected, ['review', 'reviewNote', 'retained', 'notice']),
    ...(exactMemorySource ? { sourceUserSeq: acceptedSource!.seq, blockedReason: memoryReason } : {}),
    ...(approvalDecisionAck ? { approvalDecisionAck, notice: { code: 'card_decision' },
      sourceUserSeq: approvalDecisionAck.sourceUserSeq, terminalSeq: event!.seq,
      presentation: projected.presentation, turnOutcome: projected.turnOutcome } : {}),
  };
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
  const reason = text(data.reason);
  const legacyNeedsInput = data.awaitingUser === true
    || reason === 'awaiting_user_input'
    || reason === 'awaiting_approval'
    || reason === 'awaiting_continue';
  // Every terminal reads as its authored words before the host's retained-work
  // checkpoint; the durable terminal keeps the checkpoint for the model. What
  // was kept and whether anything outside this machine changed travel as the
  // `retained` counts below, for clients to show as chrome — never as record
  // handles, tool names, or a sentence written for Clem.
  const waitingOnPerson = typedPresentation
    ? typedPresentation.status === 'needs_input'
    : legacyNeedsInput;
  const reply = parseRetainedWorkCheckpoint(publicCompletionText(data)).head;
  const retained = publicTerminalRetained(
    typedPresentation ? typedPresentation.text : publicReplyText(data.reply, ''),
    waitingOnPerson,
  );
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
    ...publicTerminalReview(data),
    ...retained,
    ...publicTerminalNotice(data),
    reply,
    // Compatibility for consumers that historically read summary first.
    summary: reply,
    ...(typedOutcome ? { turnOutcome: typedOutcome } : {}),
    presentation: typedPresentation
      ? { ...typedPresentation, text: publicPresentationText(typedPresentation) }
      : {
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

const DELEGATED_TASK_PHASES: ReadonlySet<string> = new Set([
  'dispatched', 'started', 'revised', 'needs_you', 'parked', 'finished', 'stopped', 'failed', 'check_in',
]);

/**
 * The state of a delegated task on the conversation that delegated it. Ids
 * and enums pass as they are; every piece of text is bounded again here. A
 * phase this surface does not know stays private.
 */
function publicDelegatedTaskState(data: Record<string, unknown>): Record<string, unknown> | null {
  const phase = typeof data.phase === 'string' ? data.phase : '';
  if (!DELEGATED_TASK_PHASES.has(phase) || typeof data.taskId !== 'string' || !data.taskId) return null;
  const text = (key: string, max: number) => {
    const value = shortString(data[key], max);
    return value ? { [key]: value } : {};
  };
  return {
    ...selected(data, ['taskId', 'phase', 'status', 'contractVersion', 'agentId', 'projectId',
      'sourceUserSeq', 'evidencePolicy', 'approvalId', 'followsTaskId']),
    ...text('title', 200),
    ...text('agentName', 64),
    ...text('projectName', 80),
    ...text('instruction', 400),
    ...text('artifactDestination', 200),
    ...text('reason', 400),
    ...text('question', 400),
    ...text('note', 600),
  };
}

/**
 * A delegated coding agent's live activity. Text was redacted when the
 * executor wrote it; this bounds it again and admits only the fields each
 * kind carries. An unknown kind stays private.
 */
function publicCodingRunActivity(data: Record<string, unknown>): Record<string, unknown> | null {
  const kind = typeof data.kind === 'string' ? data.kind : '';
  const base = selected(data, ['runId', 'agent', 'kind']);
  const textField = (max: number) => {
    const value = shortString(data.text, max);
    return value ? { text: value } : {};
  };
  switch (kind) {
    case 'status':
      return { ...base, ...selected(data, ['state', 'projectName', 'branch']), ...textField(400),
        ...(shortString(data.objective, 300) ? { objective: shortString(data.objective, 300) } : {}) };
    case 'clem_message':
    case 'agent_message':
      return { ...base, ...selected(data, ['nested']), ...textField(4_000) };
    case 'plan': {
      const items = Array.isArray(data.items)
        ? data.items.slice(0, 40).flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const row = item as { text?: unknown; status?: unknown };
          const itemText = shortString(row.text, 200);
          const status = row.status === 'completed' || row.status === 'in_progress' ? row.status : 'pending';
          return itemText ? [{ text: itemText, status }] : [];
        })
        : [];
      return { ...base, items };
    }
    case 'step_started':
      return { ...base, ...selected(data, ['stepId', 'tool', 'nested']),
        ...(shortString(data.detail, 300) ? { detail: shortString(data.detail, 300) } : {}) };
    case 'step_finished':
      return { ...base, ...selected(data, ['stepId', 'ok']),
        ...(shortString(data.output, 1_500) ? { output: shortString(data.output, 1_500) } : {}) };
    case 'permission':
      return { ...base, ...selected(data, ['stepId', 'tool', 'decision', 'effect']),
        ...(shortString(data.detail, 300) ? { detail: shortString(data.detail, 300) } : {}),
        ...(shortString(data.reason, 400) ? { reason: shortString(data.reason, 400) } : {}) };
    case 'review':
      return { ...base, ...selected(data, ['verdict', 'next', 'commitCount', 'filesChanged', 'testExitCode']),
        ...(shortString(data.reason, 600) ? { reason: shortString(data.reason, 600) } : {}) };
    default:
      return null;
  }
}

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

/** Hosted model ids are often `namespace/model`; that shape is a name, not a
 *  path, so one namespace segment is allowed. Anything else stays private. */
const PUBLIC_MODEL_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,95})?$/;

function publicModelIdentifier(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return PUBLIC_MODEL_IDENTIFIER_RE.test(candidate) ? candidate : '';
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
/** The workflow settings a saved-workflow card may name (closed set). */
const WORKFLOW_SAVED_SETTINGS: ReadonlySet<string> = new Set(['goal', 'schedule', 'description', 'inputs', 'tools', 'project', 'summary', 'sends']);

const PUBLIC_INNER_TOOL_RE = /^[a-z][a-z0-9_]{1,48}$/;
function publicInnerTool(data: Record<string, unknown>): string {
  const wrapper = firstString(data.tool, data.toolName, data.name);
  if (wrapper !== 'call_tool' && wrapper !== 'work_call') return '';
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
    // Historical card owners and card-set inquiries are not live executors.
    // Its exact-source question/terminal uses the ordinary presentation.
    if ((source.data.liveApprovalControl as Record<string, unknown>).mode !== undefined) return null;
    const control = source.data.liveApprovalControl as PublicLiveApprovalControl;
    const ownerSource = getRunAttemptSourceUserEvent({ sessionId: source.sessionId, attemptId: control.ownerAttemptId });
    if (!ownerSource || ownerSource.seq !== control.ownerSourceUserSeq || ownerSource.id !== source.parentEventId) return null;
    const claimed = event.data.liveApprovalControl as Partial<PublicLiveApprovalControl> | undefined;
    if (claimed && (claimed.version !== control.version || claimed.ownerAttemptId !== control.ownerAttemptId
      || claimed.ownerSourceUserSeq !== control.ownerSourceUserSeq)) return null;
    return { version: 1, ownerAttemptId: control.ownerAttemptId, ownerSourceUserSeq: control.ownerSourceUserSeq };
  } catch { return null; }
}

/** Presentation-only: derive the relationship from the retained source, never
 * from terminal metadata supplied by a model or client. It grants no authority
 * to finish, resume, approve or stop the foreground executor. */
function publicBackgroundOutcomeReport(event: EventRow): Record<string, unknown> | null {
  try {
    if (event.type !== 'conversation_completed' && !isBackgroundOutcomeSource(event)) return null;
    const retained = getEvent(event.id);
    if (!retained || retained.seq !== event.seq || retained.sessionId !== event.sessionId
      || retained.type !== event.type || retained.role !== event.role || retained.parentEventId !== event.parentEventId
      || !isDeepStrictEqual(retained.data, event.data)) return null;
    let source = retained;
    if (event.type === 'conversation_completed') {
      const presentation = validTypedCompletionPresentation(event.data, event.sessionId);
      if (!presentation) return null;
      const seq = presentation.identity.sourceUserSeq;
      const accepted = listEvents(event.sessionId, { types: ['user_input_received'], sinceSeq: seq - 1, limit: 1 })[0];
      if (!accepted || accepted.seq !== seq || accepted.seq >= event.seq
        || accepted.data.deliveryPhase !== 'report') return null;
      source = accepted;
    }
    if (!isBackgroundOutcomeSource(source)) return null;
    return { version: 1, sourceUserSeq: source.seq, sourceLabel: source.data.sourceLabel,
      sourceId: source.data.sourceId, phase: source.data.deliveryPhase };
  } catch { return null; }
}

/** A confirmation identifies a displayed card, never its payload or executor.
 * Reopen the accepted control and earlier card carrier so copied metadata
 * cannot attach a question to another source/card. A later card resolution
 * does not erase this historical presentation relationship. */
function publicApprovalConfirmation(event: EventRow): Record<string, unknown> | null {
  const data = event.data;
  const seq = data.sourceUserSeq;
  const approvalId = data.approvalId;
  const leaning = data.leaning;
  if (event.role !== 'Clem' || data.reason !== 'approval_confirmation_required'
    || !Number.isSafeInteger(seq) || Number(seq) <= 0 || Number(seq) >= event.seq
    || typeof approvalId !== 'string' || !approvalId.trim()
    || (leaning !== 'approves' && leaning !== 'declines' && leaning !== 'unread')
    || typeof data.question !== 'string' || !data.question.trim()) return null;
  try {
    const source = listEvents(event.sessionId, { types: ['user_input_received'], sinceSeq: Number(seq) - 1, limit: 1 })[0];
    if (!source || source.seq !== seq || source.turn !== event.turn || !isLiveApprovalAcknowledgement(source)
      || source.data.approvalId !== approvalId || source.data.confirm !== leaning) return null;
    const control = source.data.liveApprovalControl as Record<string, unknown>;
    if (control.mode !== undefined && (control.mode !== 'paused_card' || control.approvalId !== approvalId)) return null;
    const ownerSource = getRunAttemptSourceUserEvent({ sessionId: source.sessionId, attemptId: String(control.ownerAttemptId) });
    if (!ownerSource || ownerSource.seq !== control.ownerSourceUserSeq || ownerSource.id !== source.parentEventId) return null;
    const carriers = listEvents(event.sessionId, { types: ['approval_requested'] })
      .filter(row => row.seq < source.seq && row.data.approvalId === approvalId);
    if (!carriers.length || carriers.some(row => row.role !== 'Clem'
      || row.data.sourceUserSeq !== ownerSource.seq || row.seq <= ownerSource.seq)) return null;
    if (data.replyText !== undefined && (typeof data.replyText !== 'string' || data.replyText !== source.data.text)) return null;
    const replyText = data.replyText === undefined ? '' : publicUserInputText({ text: data.replyText });
    return { reason: 'approval_confirmation_required', approvalId, sourceUserSeq: seq, leaning,
      ...(replyText ? { replyText } : {}) };
  } catch { return null; }
}

function projectData(event: EventRow): Record<string, unknown> | null {
  const data = event.data ?? {};
  switch (event.type) {
    case 'stream_token':
      // Raw provider/model deltas are untrusted. Only the answer stream
      // (answer-stream.ts) marks a frame public, after its own reply-contract
      // and protocol checks; this projection re-checks the closed shape.
      return publicStreamTokenData(data);
    case 'user_input_received': {
      // An answer to a card is shown as the owner's words ("Yes, go ahead."),
      // read from the recorded decision; `text` stays exact for the parser.
      const answerWords = (input: string) => {
        const shown = ownerBubbleText(data, event.sessionId);
        return shown && shown !== input ? { displayText: shown } : {};
      };
      const liveApprovalControl = publicLiveApprovalControl(event);
      if (liveApprovalControl) {
        const input = publicUserInputText(data);
        return { text: input, ...answerWords(input), synthetic: true, liveApprovalControl };
      }
      // These are the owner's accepted words with a question of their own,
      // not a claim that any historical card executor is running. Keep the
      // private control/payload bindings out of the public replay plane.
      if (isLiveApprovalAcknowledgement(event)) {
        const mode = (data.liveApprovalControl as Record<string, unknown>).mode;
        if (mode === 'paused_card' || mode === 'card_inquiry') {
          const input = publicUserInputText(data);
          return input ? { text: input, ...answerWords(input) } : null;
        }
      }
      if (data.synthetic === true) {
        if (data.source !== 'outcome') return null;
        const backgroundOutcomeReport = publicBackgroundOutcomeReport(event);
        return { ...selected(data, ['synthetic', 'source', 'sourceId', 'sourceLabel', 'deliveryPhase']),
          ...(backgroundOutcomeReport ? { backgroundOutcomeReport } : {}) };
      }
      const input = meetingLookupOwnerQuestion(data, event.sessionId) ?? meetingResearchOwnerQuestion(data, event.sessionId) ?? publicUserInputText(data);
      const taskMode = publicTaskMode(data.taskMode);
      return input ? { text: input, ...answerWords(input), ...(taskMode ? { taskMode } : {}) } : null;
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
      const receipt = publicSteerReceipt(event);
      const clientRequestId = publicSteerRequestId(data.clientRequestId);
      const clientEchoId = publicSteerRequestId(data.clientEchoId);
      return text ? { text, ...(clientRequestId ? { clientRequestId } : {}), ...(clientEchoId ? { clientEchoId } : {}),
        ...(receipt ? { steerReceipt: receipt } : {}) } : null;
    }
    case 'turn_model_routed': {
      // Route identity is useful, but route diagnostics are not presentation:
      // expose only bounded provider/model names plus two closed transition
      // bits. Internal failure reasons, abandoned brains, transport, attempts,
      // and route topology stay in the audit ledger.
      const model = publicModelIdentifier(data.model);
      const provider = publicToolIdentifier(data.provider);
      if (!model && !provider) return null;
      // The saved agent the turn ran as is a name the owner chose; bounded,
      // never an id or a path.
      const agentName = typeof data.agentName === 'string' ? data.agentName.trim().slice(0, 64) : '';
      // The project the turn worked in, by the name the owner gave it.
      const projectName = typeof data.projectName === 'string' ? data.projectName.trim().slice(0, 80) : '';
      return {
        phase: 'model',
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
        ...(agentName ? { agentName } : {}),
        ...(projectName ? { projectName } : {}),
        fallover: data.fallover === true,
        preselected: data.preselected === true,
      };
    }
    case 'model_resilience_observed': {
      // Only a scheduled retry is public. The transport journal's timings,
      // attempt identity, diagnostics and account/model fields stay private.
      if (data.version !== 1 || data.phase !== 'retry_scheduled' || data.retired !== false
        || !Number.isSafeInteger(data.sourceUserSeq) || Number(data.sourceUserSeq) <= 0
        || !Number.isSafeInteger(data.nextAttempt) || Number(data.nextAttempt) < 2) return null;
      let reasonCode: 'connection' | 'busy' | 'auth' | 'empty' | 'request';
      if (data.reason === 'transient_failure' && data.failureKind === 'model.transport_timeout') reasonCode = 'connection';
      else if (data.reason === 'transient_failure'
        && (data.failureKind === 'model.rate_limited' || data.failureKind === 'model.overloaded'
          || data.failureKind === 'model.http_5xx')) reasonCode = 'busy';
      else if (data.reason === 'auth_refresh' && data.failureKind === 'model.auth_expired') reasonCode = 'auth';
      else if (data.reason === 'empty_completion' && data.failureKind === 'model.empty_completion') reasonCode = 'empty';
      else if (data.reason === 'effort_rejected' && data.failureKind === 'runtime.unknown') reasonCode = 'request';
      else if (data.reason === 'incomplete_stream' && data.failureKind === 'model.transport_timeout') reasonCode = 'connection';
      else return null;
      return { sourceUserSeq: data.sourceUserSeq, phase: 'retry', reasonCode };
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
      const backgroundOutcomeReport = publicBackgroundOutcomeReport(event);
      const approvalDecisionAck = publicApprovalDecisionAck(event);
      return { ...terminalData(data, event.sessionId), ...(liveApprovalControl ? { liveApprovalControl } : {}),
        ...(approvalDecisionAck ? { approvalDecisionAck, notice: { code: 'card_decision' } } : {}),
        ...(backgroundOutcomeReport ? { backgroundOutcomeReport } : {}) };
    }
    case 'completion_review_settled':
      return publicReviewSettledData(event);
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
      const confirmation = publicApprovalConfirmation(event);
      return {
        question,
        options: stringList(data.options, 8),
        ...selected(data, ['source', 'approvalId', 'pendingQuestionId', 'sourceId']),
        ...(confirmation ?? {}),
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
        ...(approvalPreviewProjection(data.preview) ?? {}),
        ...(consentCall && risk ? { consentCall: {
          ...selected(consentCall, ['effect', 'accountId']),
          risk: selected(risk, ['reversibility', 'consequence', 'destructive']),
        } } : {}),
      };
    }
    case 'approval_resolved':
      return selected(data, ['approvalId', 'decision', 'resolution', 'sourceId', 'changeRequested']);
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
    case 'workflow_saved': {
      // The saved workflow as a small graph. Every value is re-validated and
      // bounded here: ids and labels are short strings, effects are the closed
      // set the graph builder emits, and nothing else on the row passes.
      const name = firstString(data.name);
      const slug = firstString(data.slug);
      const op = data.op === 'created' || data.op === 'updated' ? data.op : null;
      if (!name || !slug || !op || name.length > 160 || slug.length > 160) return null;
      const ids = (value: unknown): string[] => (Array.isArray(value)
        ? value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 80).slice(0, 60)
        : []);
      const rawSteps = Array.isArray(data.steps) ? data.steps.slice(0, 60) : [];
      const steps = rawSteps.flatMap((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const step = raw as Record<string, unknown>;
        const id = firstString(step.id);
        if (!id || id.length > 80) return [];
        const effect = step.effect === 'read' || step.effect === 'write' || step.effect === 'send' ? step.effect : 'unknown';
        return [{
          id,
          label: (firstString(step.label) || id).slice(0, 120),
          effect,
          approval: step.approval === true,
          forEach: step.forEach === true,
          dependsOn: ids(step.dependsOn),
        }];
      });
      return {
        name,
        slug,
        op,
        enabled: data.enabled === true,
        steps,
        changedStepIds: ids(data.changedStepIds),
        addedStepIds: ids(data.addedStepIds),
        removedStepIds: ids(data.removedStepIds),
        ...(Array.isArray(data.changedSettings)
          ? { changedSettings: data.changedSettings.filter((key): key is string => typeof key === 'string' && WORKFLOW_SAVED_SETTINGS.has(key)) }
          : {}),
        ...(Number.isSafeInteger(data.sourceUserSeq) && Number(data.sourceUserSeq) > 0 ? { sourceUserSeq: Number(data.sourceUserSeq) } : {}),
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
      return selected(data, ['item', 'role', 'agent', 'model', 'provider', 'ok']);
    case 'worker_model_offer': {
      // The offer carries its own answer, so a replay never shows an offer
      // the owner already answered.
      const offerId = firstString(data.offerId);
      if (!offerId || !/^wmo-[a-f0-9]{16}$/.test(offerId)) return null;
      let resolved: string | null = null;
      try { resolved = workerModelOfferResolution(event.sessionId, offerId); } catch { resolved = null; }
      return {
        ...selected(data, ['offerId', 'intent', 'modelId', 'modelName']),
        ...(resolved ? { resolved } : {}),
      };
    }
    case 'worker_model_offer_resolved':
      return selected(data, ['offerId', 'action']);
    case 'coding_run_activity':
      return publicCodingRunActivity(data);
    case 'coding_run_settled':
      return {
        ...selected(data, ['runId', 'agent', 'outcome', 'branch', 'projectName', 'headCommit',
          'commitCount', 'filesChanged', 'insertions', 'deletions', 'testExitCode', 'verdict']),
        ...(shortString(data.reason, 600) ? { reason: shortString(data.reason, 600) } : {}),
      };
    case 'delegated_task_state':
      return publicDelegatedTaskState(data);
    case 'batch_started':
    case 'batch_progress':
    case 'batch_completed':
      return selected(data, ['batchId', 'items', 'done', 'total', 'failed', 'succeeded', 'halted', 'throttled', 'itemId', 'slug', 'tool', 'sideEffect']);
    case 'external_write':
    case 'external_write_succeeded':
    case 'external_write_failed':
    case 'external_write_orphaned': {
      // The app the write landed in, from the toolkit catalog — a name and
      // web address Composio publishes, never anything the model wrote.
      const action = firstString(data.shapeKey) || firstString(data.toolName) || firstString(data.tool);
      const app = action ? appForWriteAction(action) : null;
      return {
        ...selected(data, ['shapeKey', 'toolName', 'tool', 'callId', 'call_id', 'preDispatch']),
        targets: stringList(data.targets, 25),
        ...(app ? { app: app.name, ...(app.url ? { appUrl: app.url } : {}) } : {}),
        ...(data.observedEffect === 'none' ? { affirmsChange: false } : {}),
        // The consent classification the ledger recorded, so a surface's
        // receipt states what the consent card stated. Closed values only.
        ...(isInteractiveConsentReversibility(data.reversibility) ? { reversibility: data.reversibility } : {}),
        ...(isInteractiveConsentConsequence(data.consequence)
          ? {
              consequence: data.consequence,
              // Decided once, here: whether this write-classified call's own
              // classification affirmed a change, so no surface counts or
              // cards a clean return as one when it did not.
              affirmsChange: recordedConsentAffirmsChange(data),
            }
          : {}),
      };
    }
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
    case 'verdict_recorded': {
      // Which model actually ruled, so an answer can say who checked it. Only
      // a well-formed model id passes; anything else stays private.
      const judge = publicModelIdentifier(data.judgeModelId);
      return {
        ...selected(data, ['door', 'pass', 'failedOpen', 'selfJudge', 'criteriaMet', 'criteriaTotal']),
        ...(judge ? { judgeModelId: judge } : {}),
      };
    }
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
    // A retry row carries only its kind: the surface distinguishes a model
    // backend that did not respond from a reply that came back malformed,
    // while the model's discarded draft and transport details stay private.
    case 'stall_retry_attempted':
      return selected(data, ['kind']);
    case 'turn_started':
    case 'turn_ended':
    case 'plan_drafted':
    case 'plan_approved':
    case 'plan_revised':
    case 'plan_rejected':
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

/** Wire shape mirrored by the client parser; display-only, never authority. */
export interface PublicSteerReceipt {
  version: 1; sessionId: string; sourceUserSeq: number; noteSeq: number;
  clientRequestId?: string; clientEchoId?: string; state: 'accepted' | 'adopted' | 'unhandled'; changedAtSeq: number;
}

const STEER_RECEIPT_WINDOW = 512;
const publicSteerRequestId = (value: unknown): string | undefined => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value) ? value : undefined;

/** One bounded, source-owned read for a receipt batch. An incomplete window
 * proves no handling state: in particular it cannot turn missing adoption
 * evidence into an "unhandled" claim. No current-attempt/runtime inference. */
export function publicSteerReceiptsForSource(sessionId: string, sourceSeq: number, throughSeq = Number.MAX_SAFE_INTEGER): PublicSteerReceipt[] {
  try {
    const db = openEventLog();
    if (db.inTransaction || !Number.isSafeInteger(sourceSeq) || sourceSeq <= 0) return [];
    const source = listEvents(sessionId, { sinceSeq: sourceSeq - 1, throughSeq: sourceSeq, limit: 1 })[0];
    if (!source || source.type !== 'user_input_received' || source.role !== 'user' || source.data.synthetic === true
      || isLiveApprovalAcknowledgement(source)) return [];
    const following = db.prepare("SELECT seq FROM events WHERE session_id = ? AND type = 'user_input_received' AND seq > ? ORDER BY seq LIMIT 32")
      .all(sessionId, sourceSeq) as Array<{ seq: number }>;
    const next = following.find(row => {
      const source = listEvents(sessionId, { sinceSeq: row.seq - 1, throughSeq: row.seq, limit: 1 })[0];
      return source && !isLiveApprovalAcknowledgement(source) && !isBackgroundOutcomeSource(source);
    });
    if (!next && following.length === 32) return [];
    const rows = listEvents(sessionId, { sinceSeq: sourceSeq, throughSeq: Math.min(throughSeq, next ? next.seq - 1 : Number.MAX_SAFE_INTEGER),
      types: ['user_input_received', 'user_steer_note', 'user_steer_note_delivered', 'conversation_completed'],
      limit: STEER_RECEIPT_WINDOW + 1 });
    if (rows.length > STEER_RECEIPT_WINDOW) return [];
    const receipts = new Map<number, PublicSteerReceipt>();
    let terminalSeq: number | undefined;
    for (const row of rows) {
      if (row.type === 'user_input_received' && !isLiveApprovalAcknowledgement(row) && !isBackgroundOutcomeSource(row)) break;
      if (row.type === 'user_steer_note' && row.role === 'user' && !terminalSeq) {
        const clientRequestId = publicSteerRequestId(row.data.clientRequestId);
        const clientEchoId = publicSteerRequestId(row.data.clientEchoId);
        receipts.set(row.seq, { version: 1, sessionId, sourceUserSeq: sourceSeq, noteSeq: row.seq,
          state: 'accepted', changedAtSeq: row.seq, ...(clientRequestId ? { clientRequestId } : {}), ...(clientEchoId ? { clientEchoId } : {}) });
      } else if (row.type === 'user_steer_note_delivered' && row.role === 'system' && !terminalSeq
        && row.data.sourceUserSeq === sourceSeq && Array.isArray(row.data.noteSeqs)) {
        // An oversized marker also makes handling unknown, never negative.
        if (row.data.noteSeqs.length > STEER_RECEIPT_WINDOW) return [];
        const delivered = new Set(row.data.noteSeqs.filter(seq => Number.isSafeInteger(seq) && seq > 0));
        for (const receipt of receipts.values()) {
          if (receipt.state === 'accepted' && delivered.has(receipt.noteSeq)) {
            receipt.state = 'adopted'; receipt.changedAtSeq = row.seq;
          }
        }
      } else if (row.type === 'conversation_completed'
        && validTypedCompletionPresentation(row.data, sessionId)?.identity.sourceUserSeq === sourceSeq) {
        terminalSeq ??= row.seq;
      }
    }
    if (terminalSeq) for (const receipt of receipts.values()) if (receipt.state === 'accepted') {
      receipt.state = 'unhandled'; receipt.changedAtSeq = terminalSeq;
    }
    return [...receipts.values()];
  } catch { return []; }
}

/** The note's canonical predecessor is the same source interval used by
 * adoptedSteerNotesForSource; live approval acknowledgements never replace it.
 * A later nonapproval accepted source closes the interval. */
export function publicSteerReceipt(note: EventRow, throughSeq?: number): PublicSteerReceipt | null {
  try {
    const db = openEventLog();
    if (db.inTransaction || note.type !== 'user_steer_note' || note.role !== 'user'
      || !Number.isSafeInteger(note.seq) || note.seq <= 0) return null;
    const retained = listEvents(note.sessionId, { sinceSeq: note.seq - 1, throughSeq: note.seq, limit: 1 })[0];
    if (!retained || retained.id !== note.id || retained.type !== note.type || retained.role !== note.role) return null;
    const candidates = db.prepare("SELECT seq FROM events WHERE session_id = ? AND type = 'user_input_received' AND seq < ? ORDER BY seq DESC LIMIT 32")
      .all(note.sessionId, note.seq) as Array<{ seq: number }>;
    for (const candidate of candidates) {
      const source = listEvents(note.sessionId, { sinceSeq: candidate.seq - 1, throughSeq: candidate.seq, limit: 1 })[0];
      if (!source || isLiveApprovalAcknowledgement(source) || isBackgroundOutcomeSource(source)) continue;
      return publicSteerReceiptsForSource(note.sessionId, source.seq, throughSeq).find(receipt => receipt.noteSeq === note.seq) ?? null;
    }
    return null;
  } catch { return null; }
}

function publicSteerReceiptsAt(event: EventRow): PublicSteerReceipt[] {
  if (event.type === 'user_steer_note_delivered' && event.role === 'system' && Array.isArray(event.data.noteSeqs)
    && Number.isSafeInteger(event.data.sourceUserSeq)) {
    return publicSteerReceiptsForSource(event.sessionId, Number(event.data.sourceUserSeq), event.seq)
      .filter(receipt => receipt.state === 'adopted' && receipt.changedAtSeq === event.seq).slice(0, 64);
  }
  if (event.type !== 'conversation_completed') return [];
  const source = validTypedCompletionPresentation(event.data, event.sessionId)?.identity.sourceUserSeq;
  return source ? publicSteerReceiptsForSource(event.sessionId, source, event.seq).slice(0, 64) : [];
}

/** Project one raw harness row into the public chat event plane. */
export function projectHarnessEventForPublic(event: EventRow): EventRow | null {
  // The raw control marker remains private. This separately named, bounded
  // acknowledgement carries only validated display identities and state.
  if (event.type === 'user_steer_note_delivered') {
    const receipts = publicSteerReceiptsAt(event);
    return receipts.length ? { ...event, type: 'user_steer_receipt' as EventRow['type'], parentEventId: null, data: { receipts } } : null;
  }
  if (PRIVATE_EVENT_TYPES.has(event.type)) return null;
  if (
    (event.type === 'tool_called' || event.type === 'tool_returned')
    && !isCanonicalTopLevelToolEvent(event)
  ) return null;
  let data: Record<string, unknown> | null;
  try { data = projectData(event); } catch { return null; }
  if (data === null) return null;
  if (event.type === 'conversation_completed') {
    const receipts = publicSteerReceiptsAt(event);
    if (receipts.length) data = { ...data, steerReceipts: receipts };
  }
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
