/**
 * Chat approval auto-resume (2026-07-20) — the resume half of the fail-closed
 * approval park.
 *
 * The chat/worker WAIT gate (claude-agent-approval.ts) parks after its hold
 * ceiling: the turn ends honestly ("waiting on your approval") and the durable
 * exact-payload card stays pending + resumable. Without this module the user's
 * later approval would resolve the card into a void — nothing is awaiting it
 * anymore, so the approved action would silently never run (the trust break:
 * "I approved it and nothing happened").
 *
 * This listener closes the loop: when a PARKED chat approval resolves
 * APPROVED, it re-drives the session through the normal respond spine with a
 * resume directive. The model re-issues the same tool call; the gate's
 * one-shot resumable claim lets that exact payload through without re-asking.
 *
 * Safety properties:
 *  - Only fires for approvals that durably recorded an `approval_parked`
 *    event (a live wait loop — user answered in time — never parked, so the
 *    in-flight run owns the resolution and this listener stays out).
 *  - Never dispatches into a session with a run in flight (runInFlightSince):
 *    the running turn will see the resolution itself. The one exception is an
 *    exact stored action beside a verified idle workflow/approval owner; it
 *    runs without touching that owner's marker.
 *  - Approval is the ONLY resolution that re-drives. A rejection/expiry stops
 *    quietly — the reaper and the gate's deny message already tell the user —
 *    so a declined action can never come back on its own.
 *  - One-shot per approval per process; the registry's atomic consume is the
 *    durable guard across restarts.
 *
 * Started from the daemon bootstrap next to startApprovalReaper, with the
 * dispatcher injected (respondPreferHarness) — the same shape as
 * restart-recovery's auto-resume, so no import cycle into respond-bridge.
 */

import pino from 'pino';
import { createHash } from 'node:crypto';
import * as approvalRegistry from './approval-registry.js';
import {
  beginRunAttempt,
  finishRunAttempt,
  getActiveRunAttempt,
  getRunAttemptSourceUserEvent,
  getRunAttemptBySourceUserSeq,
  getUserInputEventAtSequence,
  isKillRequested,
  listActiveRunAttemptOwnership,
  listEvents,
  openEventLog,
  recordRunAttemptUserInput,
  withEventPublicationTransaction,
  afterEventPublicationCommit,
  type EventRow,
  type RunAttemptRef,
} from './eventlog.js';
import { HarnessSession } from './session.js';
import { getPendingAction, listPendingActions, pendingActionPayloadHash, recordPendingActionResult, type PendingActionRecord } from './pending-actions.js';
import { pendingActionResultApprovalMatches, pendingActionResultBinding } from './pending-action-public-result.js';
import { prepareApprovedActionHostCompletion } from './approved-action-completion-receipt.js';
import { enqueueApprovedActionResultProjectionInTransaction, kickApprovedActionResultProjectionDrain } from './approved-action-result-projection.js';
import { approvedActionDecisionWasStoppedInTransaction } from './approved-action-completion-proof.js';
import { BoundaryError } from '../boundary-error.js';
import { pendingActionIdFromArgs } from './pending-action-view.js';
import { publicAsyncWorkDispatchedData, publicUserInputText } from './public-presentation.js';
import { approvalCardAsk } from './approval-card-voice.js';
import { freshExternalWriteEvidenceStatus } from './tool-evidence.js';
import { PENDING_ACTION_DISPATCH_UNCERTAIN, PENDING_ACTION_PRE_DISPATCH_REFUSAL, PENDING_ACTION_TOOL_REFUSAL, executeApprovedPendingActionCall } from '../../execution/pending-action-executor.js';
import { recordAcceptedSourceGraph } from './record-accepted-source-graph.js';
import { peekTurnSemanticModelPort } from '../semantic-boundary/turn-semantic-port-registry.js';
import { CLEM_VOICE_PURPOSE } from '../semantic-boundary/turn-semantic-model-port.js';
import { modelUsageAttributionStorage, withOwnModelRequestAttribution } from '../usage-log.js';
import { commitTurnOutcome } from './delivery-committer.js';
import { turnOutcomeId, type TurnIdentity } from './turn-outcome.js';
import { resolveExactTerminalForAcceptedSource } from './accepted-source-terminal.js';
import { readActiveWorkflowOriginGroup, workflowOriginSourceGroupId } from '../../tools/workflow-run-queue.js';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { reprojectUndeliveredConversationalApproval } from './claude-agent-approval.js';
import { requireAcceptedTaskAuthority } from './accepted-task-authority.js';
import { requireActionExpectedWorkActivation } from './action-expected-work-boundary.js';
import { harnessRunContextStorage, ToolCallsCounter, withHarnessRunContext } from './brackets.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { expectedWorkPlanLines } from './expected-work-admission.js';
import { OWNER_STOP_RESULTS_KEPT_TERMINAL_TEXT, type TerminalNotice } from './terminal-notice.js';
import { runOwnedHostStopNarration } from './host-stop-narration-lifecycle.js';

const logger = pino({ name: 'clementine.chat-approval-resume' });

const handledApprovalIds = new Set<string>();
const activeResumeSessions = new Set<string>();
const queuedApprovalResumes = new Map<string, {
  row: approvalRegistry.PendingApprovalRow;
  dispatch: ChatApprovalResumeDispatch;
}>();
const resumeDrainTimers = new Map<string, ReturnType<typeof setTimeout>>();
const conversationalDecisionFlights = new Map<string, Promise<boolean>>();
const conversationalDecisionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const conversationalDecisionRetryAttempts = new Map<string, number>();
const conversationalPromptDeliveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const RESUME_DRAIN_DELAY_MS = 25;
const CONVERSATIONAL_TRANSITION_RETRY_MS = [25, 50, 100, 200] as const;

function waitForConversationalTransition(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearConversationalDecisionRetry(approvalId: string): void {
  const timer = conversationalDecisionRetryTimers.get(approvalId);
  if (timer) clearTimeout(timer);
  conversationalDecisionRetryTimers.delete(approvalId);
  conversationalDecisionRetryAttempts.delete(approvalId);
}

function scheduleConversationalDecisionRetry(
  row: approvalRegistry.PendingApprovalRow,
  reason: string,
): void {
  if (conversationalDecisionRetryTimers.has(row.approvalId)) return;
  const attempt = conversationalDecisionRetryAttempts.get(row.approvalId) ?? 0;
  conversationalDecisionRetryAttempts.set(row.approvalId, attempt + 1);
  const delayMs = Math.min(30_000, 250 * (2 ** Math.min(attempt, 7)));
  const timer = setTimeout(() => {
    conversationalDecisionRetryTimers.delete(row.approvalId);
    const current = approvalRegistry.get(row.approvalId);
    if (!current?.presentation || current.status === 'pending' || !current.resolution) {
      clearConversationalDecisionRetry(row.approvalId);
      return;
    }
    void settleConversationalApprovalDecision(current).catch((err) => {
      logger.warn({
        approvalId: row.approvalId,
        reason,
        err: err instanceof Error ? err.message : String(err),
      }, 'conversational approval retry failed; keeping exact decision open');
      scheduleConversationalDecisionRetry(current, reason);
    });
  }, delayMs);
  timer.unref?.();
  conversationalDecisionRetryTimers.set(row.approvalId, timer);
}

export interface ChatApprovalResumeSource {
  sourceUserSeq: number;
  displayMessage: string;
  /** Physical executor already bound to sourceUserSeq and restart ownership. */
  runAttemptId: string;
  /** Stable run family used by downstream beginRunAttempt idempotency. */
  runId: string;
}

export type ChatApprovalResumeDispatch = (
  sessionId: string,
  directive: string,
  source: ChatApprovalResumeSource,
) => Promise<void>;

function slackConversationTarget(
  presentation: approvalRegistry.ConversationalApprovalPresentation,
): { channelId: string; threadTs?: string } | null {
  if (!presentation.conversationKey.startsWith('slack:')) return null;
  const encoded = presentation.conversationKey.slice('slack:'.length);
  const separator = encoded.indexOf(':');
  const channelId = (separator < 0 ? encoded : encoded.slice(0, separator)).trim();
  const threadTs = separator < 0 ? '' : encoded.slice(separator + 1).trim();
  if (!/^[CDG][A-Z0-9]+$/.test(channelId)) return null;
  if (threadTs && !/^\d{10,16}\.\d{6}$/.test(threadTs)) return null;
  return { channelId, ...(threadTs ? { threadTs } : {}) };
}

/** Deliver a bound-but-unpresented ordinary question after restart. Provider
 * idempotency (Discord nonce / Slack exact-delivery metadata) closes the crash
 * between transport success and the SQLite presentedAt receipt. The retry is
 * intentionally unref'ed and remains answer-ineligible until a send succeeds. */
async function deliverUndeliveredConversationalPrompt(
  approvalId: string,
  attempt = 0,
): Promise<void> {
  conversationalPromptDeliveryTimers.delete(approvalId);
  const row = approvalRegistry.get(approvalId);
  const presentation = row?.presentation;
  if (
    !row
    || row.status !== 'pending'
    || !presentation
    || presentation.presentedAt
    || !presentation.promptEventId
    || !presentation.promptEventSeq
  ) return;
  try {
    const transportTarget = presentation.transportTarget;
    const target = presentation.originReplyTarget;
    if (transportTarget?.provider === 'discord') {
      const { editDiscordChannelMessage } = await import('../../channels/discord.js');
      await editDiscordChannelMessage(
        transportTarget.channelId,
        transportTarget.messageId,
        presentation.question,
      );
    } else if (transportTarget?.provider === 'slack') {
      const { editSlackChannelMessage } = await import('../../channels/slack.js');
      await editSlackChannelMessage(
        transportTarget.channelId,
        transportTarget.messageTs,
        presentation.question,
      );
    } else if (target.type === 'discord_channel') {
      const { sendDiscordChannelMessage } = await import('../../channels/discord.js');
      await sendDiscordChannelMessage(target.channelId, presentation.question, {
        nonce: approvalRegistry.conversationalApprovalDeliveryKey(approvalId).slice(0, 25),
        enforceNonce: true,
      });
    } else if (target.type === 'slack_channel') {
      const exactConversation = slackConversationTarget(presentation);
      if (!exactConversation) throw new Error('stored Slack consent conversation is invalid');
      const { sendSlackChannelMessage } = await import('../../channels/slack.js');
      await sendSlackChannelMessage(exactConversation.channelId, presentation.question, {
        ...(exactConversation.threadTs ? { threadTs: exactConversation.threadTs } : {}),
        exactDelivery: {
          key: createHash('sha256').update(approvalRegistry.conversationalApprovalDeliveryKey(approvalId)).digest('hex').slice(0, 32),
          oldestTs: String(Math.floor(Date.parse(row.requestedAt) / 1000)),
        },
      });
    } else if (target.type === 'slack_user') {
      const { sendSlackDirectMessage } = await import('../../channels/slack.js');
      await sendSlackDirectMessage(target.userId, presentation.question, {
        exactDelivery: {
          key: createHash('sha256').update(approvalRegistry.conversationalApprovalDeliveryKey(approvalId)).digest('hex').slice(0, 32),
          oldestTs: String(Math.floor(Date.parse(row.requestedAt) / 1000)),
        },
      });
    } else {
      // Local transcript clients mark delivery when they actually project the
      // event. A boot scan must never invent that receipt.
      return;
    }
    approvalRegistry.markConversationalApprovalPresented({
      approvalId,
      promptEventId: presentation.promptEventId,
      promptEventSeq: presentation.promptEventSeq,
    });
  } catch (err) {
    if (attempt === 0 || (attempt & (attempt - 1)) === 0) {
      logger.warn({
        approvalId,
        attempt,
        err: err instanceof Error ? err.message : String(err),
      }, 'ordinary send-consent question delivery is pending; will retry');
    }
    const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(attempt, 5)));
    const timer = setTimeout(() => {
      void deliverUndeliveredConversationalPrompt(approvalId, attempt + 1);
    }, delayMs);
    timer.unref?.();
    conversationalPromptDeliveryTimers.set(approvalId, timer);
  }
}

/** Focused crash/restart verifier. Production scheduling stays private; tests
 * may drive one deterministic delivery attempt without waiting on timers. */
export async function _deliverUndeliveredConversationalPromptForTest(
  approvalId: string,
): Promise<void> {
  await deliverUndeliveredConversationalPrompt(approvalId, 0);
}

function taggedApprovalResponse(row: approvalRegistry.PendingApprovalRow): EventRow | null {
  const sourceUserSeq = row.presentation?.responseSourceUserSeq;
  if (!row.presentation) {
    const legacy = listEvents(row.sessionId, { types: ['user_input_received'] })
      .filter((event) => event.data.approvalId === row.approvalId && event.data.decision === 'approve');
    return legacy.length === 1 ? legacy[0] : null;
  }
  if (!sourceUserSeq) return null;
  const event = listEvents(row.sessionId, { types: ['user_input_received'] })
    .find((candidate) => candidate.seq === sourceUserSeq);
  return event
    && event.data.source === 'channel_send_consent'
    && event.data.approvalId === row.approvalId
    && event.data.decision === (row.resolution === 'approved' ? 'approve' : 'reject')
    && event.data.userId === row.presentation?.responseUserId
    && event.data.conversationKey === row.presentation?.conversationKey
    ? event
    : null;
}

/**
 * One approval owns one deterministic physical run family. Retrying a failed
 * callback in-process reuses its still-active attempt. A daemon boot first
 * interrupts old active rows, so a crash recovery mints a fresh physical
 * attempt under the same run id while preserving the logical user source.
 */
function approvalResumeRunId(approvalId: string): string {
  return `approval-resume:${approvalId}`;
}

function activeAttemptOwnsApprovalResume(
  attempt: RunAttemptRef,
  row: approvalRegistry.PendingApprovalRow,
): boolean {
  if (attempt.runId === approvalResumeRunId(row.approvalId)) return true;
  const accepted = taggedApprovalResponse(row);
  const source = getRunAttemptSourceUserEvent(attempt);
  return Boolean(accepted && source?.seq === accepted.seq);
}

interface ApprovalResumeOccupancy { blocked: boolean; preserveMarker: boolean }

function verifiedWorkflowTransfer(sessionId: string, sourceUserSeq: number): boolean {
  const source = getUserInputEventAtSequence(sessionId, sourceUserSeq);
  if (!source || source.role !== 'user' || source.data.synthetic === true
    || resolveExactTerminalForAcceptedSource(source).kind !== 'absent') return false;
  const active = readActiveWorkflowOriginGroup(workflowOriginSourceGroupId({ sessionId, sourceUserSeq }));
  if (!active || active.sealed.originSessionId !== sessionId || active.sealed.sourceUserSeq !== sourceUserSeq) return false;
  const edges = listEvents(sessionId, { types: ['async_work_dispatched'] }).filter(event =>
    event.role === 'system' && event.parentEventId === source.id && event.turn === source.turn
    && event.data.sourceUserSeq === source.seq);
  if (edges.length !== 1 || edges[0]!.seq <= source.seq) return false;
  const projection = publicAsyncWorkDispatchedData(edges[0]!.data);
  if (!projection) return false;
  const { text: _displayText, ...identity } = projection;
  return closedCanonicalJson(identity) === closedCanonicalJson(active.publicDispatch);
}

function exactMarkerOwner(session: HarnessSession): { sourceUserSeq: number; attemptId: string } | null {
  const raw = session.sessionRow.metadata.__run_in_flight_owner as
    { sourceUserSeq?: unknown; attemptId?: unknown } | null | undefined;
  return raw && Number.isSafeInteger(raw.sourceUserSeq) && Number(raw.sourceUserSeq) > 0
    && typeof raw.attemptId === 'string' && raw.attemptId
    ? { sourceUserSeq: Number(raw.sourceUserSeq), attemptId: raw.attemptId } : null;
}

function originalActionAllowsSideExecution(sessionId: string, action: PendingActionRecord | null): boolean {
  if (!action || !Number.isSafeInteger(action.sourceUserSeq) || Number(action.sourceUserSeq) <= 0) return false;
  const original = getUserInputEventAtSequence(sessionId, action.sourceUserSeq!);
  const attempt = getRunAttemptBySourceUserSeq(sessionId, action.sourceUserSeq!);
  if (!original || original.role !== 'user' || isKillRequested(sessionId, { sourceUserSeq: action.sourceUserSeq! })
    || attempt?.status === 'cancelled' || attempt?.status === 'superseded') return false;
  const terminal = resolveExactTerminalForAcceptedSource(original);
  return terminal.kind === 'absent' || (terminal.kind === 'terminal'
    && terminal.presentation.status !== 'cancelled' && terminal.presentation.status !== 'uncertain');
}

/** An ended exact owner may leave bookkeeping behind. Unlike an uptime or
 * marker-only guess, its matching attempt and typed ending/activated handoff
 * prove that no foreground executor owns it. Preserve the marker, never clear
 * another source's retained checkpoint to make a decision callback run. */
function idleForeignMarkerOwner(
  session: HarnessSession,
  row: approvalRegistry.PendingApprovalRow,
): boolean {
  const owner = exactMarkerOwner(session);
  if (!owner || isKillRequested(row.sessionId, owner)) return false;
  const attempt = openEventLog().prepare(`SELECT status, finished_at FROM run_attempts
    WHERE session_id = ? AND attempt_id = ? AND source_user_seq = ?`)
    .get(row.sessionId, owner.attemptId, owner.sourceUserSeq) as { status: string; finished_at: string | null } | undefined;
  if (!attempt?.finished_at || !['completed', 'interrupted', 'failed'].includes(attempt.status)) return false;
  const source = getUserInputEventAtSequence(row.sessionId, owner.sourceUserSeq);
  if (!source) return false;
  const terminal = resolveExactTerminalForAcceptedSource(source);
  if (terminal.kind === 'terminal') return terminal.presentation.status === 'done'
    || (terminal.presentation.status === 'needs_input' && terminal.presentation.kind === 'approval'
      && terminal.presentation.approvalId === row.approvalId);
  return terminal.kind === 'absent' && verifiedWorkflowTransfer(row.sessionId, owner.sourceUserSeq);
}

/** A definitive owner Stop/supersession is not a wait condition. Reuse the
 * pending-action record's locked cancellation transition; an executing or
 * uncertain action cannot be overwritten by this pre-dispatch cleanup. */
async function retireObsoleteApprovedAction(
  row: approvalRegistry.PendingApprovalRow,
  action: PendingActionRecord | null,
): Promise<boolean> {
  if (!action || action.sessionId !== row.sessionId || action.approvalId !== row.approvalId
    || action.status !== 'approved' || action.approvedBy !== 'human' || action.toolName === 'run_batch') return false;
  const decision = taggedApprovalResponse(row);
  const obsolete = (source: number | null | undefined): 'stopped' | 'superseded' | null => {
    if (!Number.isSafeInteger(source) || Number(source) <= 0) return null;
    if (isKillRequested(row.sessionId, { sourceUserSeq: source! })) return 'stopped';
    const attempt = getRunAttemptBySourceUserSeq(row.sessionId, source!);
    if (attempt?.status === 'cancelled') return 'stopped';
    if (attempt?.status === 'superseded') return 'superseded';
    const accepted = getUserInputEventAtSequence(row.sessionId, source!);
    const terminal = accepted ? resolveExactTerminalForAcceptedSource(accepted) : null;
    return terminal?.kind === 'terminal' && terminal.presentation.status === 'cancelled' ? 'stopped' : null;
  };
  const reason = obsolete(decision?.seq) ?? obsolete(action.sourceUserSeq);
  if (!reason || !approvalSourceIsSafeToDispatch(row)) return false;
  const text = reason === 'stopped'
    ? 'Not run: you stopped the request. This stored action will not run on its own.'
    : 'Not run: a newer request replaced the original request. This stored action will not run on its own.';
  const cancelled = recordPendingActionResult(action.id, 'cancelled', text, 'chat-approval-resume');
  if (cancelled?.status !== 'cancelled') return false;
  queuedApprovalResumes.delete(row.approvalId);
  clearConversationalDecisionRetry(row.approvalId);
  handledApprovalIds.add(row.approvalId);
  if ([...queuedApprovalResumes.values()].some(queued => queued.row.sessionId === row.sessionId)) scheduleResumeDrain(row.sessionId);
  if (decision && !approvalSourceAlreadySettled(row)) await settleConversationalSource(row, decision, {
    status: 'cancelled', text, ...(reason === 'stopped' ? { hostNotice: { code: 'stopped' as const } } : {}),
  });
  return true;
}

/** Scheduling only. A public workflow handoff keeps its attempt unfinished,
 * but is not a foreground executor after its HTTP/parent lease is released.
 * The immutable group and its exact public edge must still agree. This never
 * grants call authority, retires the parent, or releases a prepared dispatch. */
function approvalResumeOccupancy(
  session: HarnessSession,
  row: approvalRegistry.PendingApprovalRow,
  action: PendingActionRecord | null,
  exactLinkedSingleAction: boolean,
): ApprovalResumeOccupancy {
  const blocked = { blocked: true, preserveMarker: false };
  try {
    // Obsolete-action cleanup can yield before this admission check. Refresh
    // the marker with the attempt inventory so a newly armed foreground
    // cannot disappear behind the caller's earlier session snapshot.
    session.refresh();
    const accepted = taggedApprovalResponse(row);
    if (accepted && isKillRequested(row.sessionId, { sourceUserSeq: accepted.seq })) return blocked;
    const owners = listActiveRunAttemptOwnership(row.sessionId);
    // The canonical list includes active rows. An unfinished row in another
    // state is unknown/cancelling, never free space. Read only this indexed
    // session's owners without imposing a new workflow admission limit.
    const attempts = openEventLog().prepare(`SELECT attempt_id, run_id, source_user_seq, started_at,
      status, lease_owner, lease_expires_at FROM run_attempts
      WHERE session_id = ? AND finished_at IS NULL`).all(row.sessionId) as Array<{
        attempt_id: string; run_id: string | null; source_user_seq: number | null; started_at: string;
        status: string; lease_owner: string | null; lease_expires_at: string | null;
      }>;
    if (owners.length !== attempts.length) return blocked;
    const transferred = [] as typeof owners;
    for (const attempt of attempts) {
      const owner = owners.find(candidate => candidate.attemptId === attempt.attempt_id);
      if (!owner || attempt.status !== 'active' || owner.sourceUserSeq !== attempt.source_user_seq
        || owner.runId !== attempt.run_id) return blocked;
      const ref = { sessionId: row.sessionId, attemptId: owner.attemptId,
        runId: owner.runId, startedAt: attempt.started_at };
      if (isKillRequested(row.sessionId, { attemptId: owner.attemptId, sourceUserSeq: owner.sourceUserSeq ?? undefined })) return blocked;
      if (activeAttemptOwnsApprovalResume(ref, row)) continue;
      if (!exactLinkedSingleAction || !owner.workflowHandoff || !owner.sourceUserSeq
        || attempt.lease_owner !== null || attempt.lease_expires_at !== null) return blocked;
      if (!verifiedWorkflowTransfer(row.sessionId, owner.sourceUserSeq)) return blocked;
      transferred.push(owner);
    }
    const marker = session.runInFlightSince();
    const markerOwner = marker ? exactMarkerOwner(session) : null;
    const ownMarker = markerOwner && accepted && markerOwner.sourceUserSeq === accepted.seq
      && Boolean(openEventLog().prepare(`SELECT 1 FROM run_attempts
        WHERE session_id = ? AND attempt_id = ? AND source_user_seq = ?`)
        .get(row.sessionId, markerOwner.attemptId, accepted.seq));
    if (transferred.length || (marker && !ownMarker)) {
      if (!exactLinkedSingleAction || !originalActionAllowsSideExecution(row.sessionId, action)) return blocked;
      if (marker && !ownMarker && (!markerOwner || (!transferred.some(candidate =>
        candidate.sourceUserSeq === markerOwner.sourceUserSeq && candidate.attemptId === markerOwner.attemptId)
        && !idleForeignMarkerOwner(session, row)))) return blocked;
      return { blocked: false, preserveMarker: true };
    }
    return { blocked: false, preserveMarker: false };
  } catch { return blocked; }
}

/** True when this logical approval-response source already has a public
 * terminal. A process crash after terminal commit but before registry consume
 * must reconcile, never execute the accepted turn again. */
function approvalSourceAlreadySettled(row: approvalRegistry.PendingApprovalRow): boolean {
  const accepted = taggedApprovalResponse(row);
  if (!accepted) return false;
  return listEvents(row.sessionId, { types: ['conversation_completed'] })
    .some((event) => {
      const presentation = event.data.presentation as {
        identity?: { sourceUserSeq?: unknown };
      } | undefined;
      return event.data.sourceUserSeq === accepted.seq
        || presentation?.identity?.sourceUserSeq === accepted.seq
        || event.data.terminalKey === `turn:${accepted.seq}`;
    });
}

/**
 * A resolved approval authorizes the intended action; it does not authorize a
 * blind replay after a provider may already have mutated external state. Only
 * no-write or exact proven-no-effect failure evidence can cross a crash.
 */
function approvalSourceIsSafeToDispatch(row: approvalRegistry.PendingApprovalRow): boolean {
  const accepted = taggedApprovalResponse(row);
  if (!accepted) return true; // first dispatch; no approval-resume source exists
  try {
    const status = freshExternalWriteEvidenceStatus(
      listEvents(row.sessionId, {
        types: [
          'external_write',
          'external_write_succeeded',
          'external_write_failed',
          'external_write_orphaned',
        ],
      }),
      accepted.seq,
    );
    return status === 'missing' || status === 'failed';
  } catch {
    return false;
  }
}

async function settleConversationalSource(
  row: approvalRegistry.PendingApprovalRow,
  source: EventRow,
  input: { text: string; status: 'done' | 'failed' | 'needs_input' | 'cancelled'; hostNotice?: TerminalNotice; endingGuard?: ApprovedActionEndingGuard },
): Promise<boolean> {
  const identity: TurnIdentity = {
    sessionId: source.sessionId,
    turn: source.turn,
    sourceUserSeq: source.seq,
  };
  try {
    await recordAcceptedSourceGraph({
      identity,
      surface: 'approval_resume',
      acceptedText: typeof source.data.text === 'string' ? source.data.text : '',
    });
    if (input.status === 'done') prepareApprovedActionHostCompletion({ sessionId: source.sessionId, sourceUserSeq: source.seq });
    // The async graph boundary is over. Hold the exact SQLite owner/Stop
    // check and terminal CAS in one managed publication transaction; no model
    // or executor work runs in this frame.
    const committed = withEventPublicationTransaction(() => {
      const ending = input.endingGuard ? readApprovedActionEndingOwner(input.endingGuard.owner) : null;
      if (ending?.kind === 'unavailable') return false;
      const stopped = ending?.kind === 'stopped' || approvedActionDecisionWasStoppedInTransaction(openEventLog(), {
        sessionId: source.sessionId, sourceUserSeq: source.seq,
      });
      if (!stopped && ending?.kind === 'current' && ending.actionDigest !== input.endingGuard!.actionDigest) return false;
      if (stopped) input = {
        ...input, status: 'cancelled',
        text: `${OWNER_STOP_RESULTS_KEPT_TERMINAL_TEXT} This action will not run again on its own.`,
        hostNotice: { code: 'stopped' },
      };
      const common = { version: 2 as const, id: turnOutcomeId(identity), identity: {
        ...identity, ...(input.endingGuard ? { attemptId: input.endingGuard.owner.attemptId,
          runId: input.endingGuard.owner.runId } : {}),
      } };
      const outcome = input.status === 'done'
        ? {
            ...common,
            status: 'done' as const,
            resumable: false as const,
            presentation: { kind: 'answer' as const, text: input.text },
          }
        : input.status === 'needs_input'
          ? {
              ...common,
              status: 'needs_input' as const,
              resumable: true as const,
              needs: { kind: 'input' as const },
              presentation: { kind: 'question' as const, text: input.text },
            }
          : input.status === 'cancelled'
            ? { ...common, status: 'cancelled' as const, resumable: false as const,
                presentation: { kind: 'stopped' as const, text: input.text } }
          : {
              ...common,
              status: 'failed' as const,
              resumable: false as const,
              presentation: { kind: 'error' as const, text: input.text },
            };
      const actionId = pendingActionIdFromArgs(row.args);
      // A narrated message and its metadata use the same re-read record.
      const action = ending?.kind === 'current' ? ending.action : actionId ? getPendingAction(actionId) : null;
      const resultBinding = action?.approvalId === row.approvalId
        ? pendingActionResultBinding(action, source) : null;
      const completed = commitTurnOutcome(outcome, {
        legacyReason: 'conversational_send_consent_resolved',
        metadata: {
          approvalId: row.approvalId,
          pendingActionId: actionId,
          ...(resultBinding ? { pendingActionResultBinding: resultBinding } : {}),
          ...(input.hostNotice ? { hostNotice: input.hostNotice } : {}),
        },
      });
      if (input.status === 'done' && action?.status === 'executed') {
        // Optional wording debt commits beside its already-complete B. No
        // model is awaited, and neither A nor the action is reopened.
        try {
          const queued = enqueueApprovedActionResultProjectionInTransaction(openEventLog(), {
            action, source, terminal: completed.event,
            retainedWorkNeedsVerification: approvedActionRetainedWorkNeedsVerification(row, action, source),
          });
          if (queued === 'queued') afterEventPublicationCommit(kickApprovedActionResultProjectionDrain);
          else logger.warn({ approvalId: row.approvalId, pendingActionId: action.id, queued }, 'approval result wording was not queued');
        } catch (err) {
          // Optional wording cannot roll back a successful action terminal.
          logger.warn({ approvalId: row.approvalId, pendingActionId: action.id, err: err instanceof Error ? err.message : String(err) },
            'approval result wording could not be queued');
        }
      }
      return true;
    });
    if (!committed) return false;
    const attempt = input.endingGuard ? {
      sessionId: row.sessionId, attemptId: input.endingGuard.owner.attemptId,
      runId: input.endingGuard.owner.runId, startedAt: input.endingGuard.owner.startedAt,
    } : getActiveRunAttempt(row.sessionId);
    if (attempt && getRunAttemptSourceUserEvent(attempt)?.seq === source.seq) {
      try { finishRunAttempt(attempt, input.status === 'cancelled' ? 'cancelled'
        : input.status === 'failed' ? 'failed' : 'completed'); } catch { /* terminal wins */ }
    }
    // commitTurnOutcome clears only its exact source/attempt-owned marker.
    // A successor accepted while this action was finishing must keep its own.
    return true;
  } catch (err) {
    logger.warn({ approvalId: row.approvalId, err: err instanceof Error ? err.message : String(err) },
      'could not settle conversational send decision source');
    return false;
  }
}

/** Host-owned exact decision recovery. Approved rows execute only the linked
 * immutable PendingAction; non-retryable PA states project their durable truth
 * onto B without another provider call. */
async function settleConversationalApprovalDecisionOnce(
  candidate: approvalRegistry.PendingApprovalRow,
): Promise<boolean> {
  const row = approvalRegistry.get(candidate.approvalId) ?? candidate;
  if (!row.presentation || row.status === 'pending' || !row.resolution) return false;
  const source = taggedApprovalResponse(row);
  if (!source) return false;
  if (approvalSourceAlreadySettled(row)) return true;
  const prepared = prepareApprovalResumeSource(row);
  if (!prepared || prepared.sourceUserSeq !== source.seq) return false;
  let resolutionReconciled = false;
  for (let attempt = 0; attempt <= CONVERSATIONAL_TRANSITION_RETRY_MS.length; attempt += 1) {
    resolutionReconciled = approvalRegistry.reconcileLinkedPendingActionResolution(row);
    if (resolutionReconciled) break;
    const delayMs = CONVERSATIONAL_TRANSITION_RETRY_MS[attempt];
    if (delayMs === undefined) break;
    await waitForConversationalTransition(delayMs);
  }
  if (row.resolution !== 'approved') {
    // SQLite owns the decision, but the frozen action file must observe the
    // same denial before B can terminalize. A transient file lock/crash leaves
    // B open so the listener/boot retry reconciles it; it never turns a durable
    // reject into a still-pending action record.
    if (!resolutionReconciled) {
      scheduleConversationalDecisionRetry(row, 'pending-action-denial-transition');
      return false;
    }
    return await settleConversationalSource(row, source, {
      status: 'done',
      text: `I left the exact ${row.presentation.actionLabel} unsent.`,
    });
  }
  const pendingActionId = pendingActionIdFromArgs(row.args);
  let pendingAction = pendingActionId ? getPendingAction(pendingActionId) : null;
  if (!pendingActionId || !pendingAction || pendingAction.approvalId !== row.approvalId) {
    return await settleConversationalSource(row, source, {
      status: 'failed',
      text: 'The frozen send record could not be verified. Nothing was dispatched.',
    });
  }
  if (pendingAction.status === 'approval_requested' && !resolutionReconciled) {
    // Registry→PA promotion lost a lock or crashed between stores. Do not
    // consume B with a misleading terminal; boot/ingress will retry the exact
    // immutable promotion, then this same state machine continues.
    scheduleConversationalDecisionRetry(row, 'pending-action-approval-transition');
    return false;
  }
  return await executeApprovedLinkedActionAndSettle(row, source, pendingAction, prepared);
}

/**
 * Run the one approved, immutable pending action for an accepted approval
 * source and settle that source with what landed. No model turn is spent:
 * the owner's decision is the whole instruction. Shared by a conversational
 * "yes" and by a card approved on a person surface, whose resume source is
 * the hidden control edge prepareApprovalResumeSource mints.
 */
async function executeApprovedLinkedActionAndSettle(
  row: approvalRegistry.PendingApprovalRow,
  source: EventRow,
  pendingActionInput: PendingActionRecord,
  prepared: ChatApprovalResumeSource,
): Promise<boolean> {
  let pendingAction: PendingActionRecord | null = pendingActionInput;
  if (pendingAction.status === 'approved') {
    const approvedPendingAction = pendingAction;
    await recordAcceptedSourceGraph({
      identity: { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.seq },
      surface: 'approval_resume',
      acceptedText: typeof source.data.text === 'string' ? source.data.text : '',
    });
    // The ordinary "Yes" is a typed control edge over the immutable pending
    // action, not a fresh conversational task. Rehydrate that exact action
    // graph and arm the same accepted-task/expected-work authority every other
    // provider lane must hold before the pending-action executor can cross.
    // If any part of the frozen consent lineage cannot be reproduced, these
    // boundaries fail closed before the action claim or provider dispatch.
    requireAcceptedTaskAuthority({
      sessionId: source.sessionId,
      sourceUserSeq: source.seq,
    });
    try {
      requireActionExpectedWorkActivation({
        sessionId: source.sessionId,
        sourceUserSeq: source.seq,
      });
    } catch (err) {
      // The persisted graph for this decision is immutable, so a refusal that
      // reads it as not-an-action is permanent: every boot re-drained the same
      // approved card, failed the same way and kept it "consumable" (live
      // 2026-10-06, two cards re-failing on each daemon start). Nothing ran
      // and nothing can; end the card visibly instead of spinning on it.
      if (!(err instanceof BoundaryError) || err.retryable) throw err;
      logger.warn({ approvalId: row.approvalId, pendingActionId: approvedPendingAction.id, err: err.operatorMessage },
        'approved card can never activate — retiring it as not run');
      recordPendingActionResult(
        approvedPendingAction.id,
        'cancelled',
        `Not run: the stored action could not be activated after approval (${err.operatorMessage}).`,
      );
      return await settleConversationalSource(row, source, {
        status: 'failed',
        text: `I couldn't run "${approvedPendingAction.title}" after you approved it: the action I had stored no longer lines up with that card, so nothing ran. Ask me again and I'll prepare a fresh one.`,
      });
    }
    for (let attempt = 0; attempt <= CONVERSATIONAL_TRANSITION_RETRY_MS.length; attempt += 1) {
      const execution = await withHarnessRunContext({
        sessionId: source.sessionId,
        turn: source.turn,
        sourceUserSeq: source.seq,
        runAttemptId: prepared.runAttemptId,
        behaviorScopeId: prepared.runId,
        counter: new ToolCallsCounter(1),
      }, () => executeApprovedPendingActionCall(approvedPendingAction.id, {
        sessionId: row.sessionId,
        sourceUserSeq: source.seq,
      }));
      if (!execution.retryable) break;
      const delayMs = CONVERSATIONAL_TRANSITION_RETRY_MS[attempt];
      if (delayMs === undefined) {
        scheduleConversationalDecisionRetry(row, 'pending-action-execution-transition');
        return false;
      }
      await waitForConversationalTransition(delayMs);
    }
    pendingAction = getPendingAction(approvedPendingAction.id);
  }
  if (!pendingAction) return false;
  const actionAttempt = getRunAttemptBySourceUserSeq(source.sessionId, source.seq);
  if (actionAttempt?.status === 'cancelled'
    || isKillRequested(source.sessionId, { sourceUserSeq: source.seq })) {
    // The owner's own Stop: an app-voice line (no first person) for the CLI,
    // channels and model history, and a notice the clients show as the pill.
    return await settleConversationalSource(row, source, {
      status: 'cancelled',
      text: `${OWNER_STOP_RESULTS_KEPT_TERMINAL_TEXT} This action will not run again on its own.`,
      hostNotice: { code: 'stopped' },
    });
  }
  if (pendingAction.status === 'executed') {
    // The stored action ran once with no model in the loop; the owner's
    // decision ends with what it did, in plain words. The rest of a longer
    // request is NOT continued here: a brain turn cannot run under this
    // source (it belongs to the action executor) and may not be rooted in a
    // hidden machine source (model-request provenance refuses synthetic
    // roots by design — live 2026-10-06, four layers deep). "Continue" from
    // the owner is an ordinary turn that sees the request, the card and this
    // result, and carries on.
    const result = pendingAction.resultSummary ?? `Executed the exact approved ${pendingAction.toolName} call.`;
    const stillOpen = approvedActionRetainedWorkNeedsVerification(row, pendingAction, source);
    // The owner approved this action together with others on one card: the
    // set ends once, in Clem's words, when its last member has settled. An
    // earlier member settles with the plain receipt and no narration (live
    // 2026-10-21: two checks approved on one card ended twice, the second
    // ending calling the first "still outstanding").
    let group = approvedActionGroupSiblings(row, pendingAction);
    if (group && !group.narrator) {
      return await settleConversationalSource(row, source, {
        status: 'done',
        text: approvedActionGroupMemberDoneText(pendingAction),
        hostNotice: { code: 'approved_action_completed' },
      });
    }
    if (group && group.unsettled > 0) {
      // The set's speaker gives its siblings a bounded moment to finish; a
      // sibling still running after that is reported as not finished, never
      // as done.
      const until = Date.now() + APPROVED_ACTION_SIBLING_WAIT_MS;
      while (group && group.unsettled > 0 && Date.now() < until) {
        await waitForConversationalTransition(APPROVED_ACTION_SIBLING_POLL_MS);
        group = approvedActionGroupSiblings(row, pendingAction) ?? group;
      }
    }
    // Clem says what landed herself, from the recorded result, and names
    // what the request still has left (owner 10-20, Windows tester: the app
    // line "The approved action completed. Open execution details…" read as
    // nothing happened; the wording job that should have replaced it was
    // rejected as unbound). The app line stands only when no brain answers.
    const guard = approvedActionEndingGuard(row, pendingAction, source, prepared);
    const said = guard ? await approvedActionEndingInClemsWords(row, pendingAction, source, guard, { stillOpen, ...(group ? { siblings: group.siblings } : {}) }) : null;
    const current = guard ? readApprovedActionEndingOwner(guard.owner) : null;
    const narrated = said && current?.kind === 'current' && current.actionDigest === guard!.actionDigest ? said : null;
    return await settleConversationalSource(row, source, {
      status: 'done',
      text: narrated ?? approvedActionRanText(pendingAction, result, stillOpen),
      hostNotice: { code: 'approved_action_completed' },
      ...(guard && narrated ? { endingGuard: guard } : {}),
    });
  }
  if (pendingAction.status === 'executing' || pendingAction.status === 'failed') {
    // The owner said yes and it did not land: they read what happened and
    // what to do next in Clem's words. The record keeps the machine text
    // for the model (live 2026-10-07: "Dispatch was refused locally … Error:
    // InvalidToolInputError … Call tool_search … then retry" reached the owner).
    // Clem says it herself, from the record: what happened, what she would
    // change, and whether to go ahead (owner 2026-10-09). The plain ending
    // stands when no brain answers in time.
    const guard = approvedActionEndingGuard(row, pendingAction, source, prepared);
    if (!guard) return false;
    const said = await approvedActionEndingInClemsWords(row, pendingAction, source, guard);
    const current = readApprovedActionEndingOwner(guard.owner);
    if (current.kind === 'unavailable') return false;
    if (current.kind === 'stopped') return await settleConversationalSource(row, source, {
      status: 'cancelled', text: OWNER_STOP_RESULTS_KEPT_TERMINAL_TEXT,
      hostNotice: { code: 'stopped' }, endingGuard: guard,
    });
    // A changed record gets its current app status, never old generated words
    // or another narrator/business retry. The terminal rechecks this snapshot.
    const freshGuard = { owner: guard.owner, actionDigest: current.actionDigest };
    if (current.action.status === 'executed') return await settleConversationalSource(row, source, {
      status: 'done', text: approvedActionRanText(current.action, current.action.resultSummary ?? '',
        approvedActionRetainedWorkNeedsVerification(row, current.action, source)), endingGuard: freshGuard,
      hostNotice: { code: 'approved_action_completed' },
    });
    if (current.action.status !== 'failed' && current.action.status !== 'executing') return await settleConversationalSource(row, source, {
      status: 'needs_input', text: `The stored action is ${current.action.status}. Its result is not confirmed; nothing will run again on its own.`,
      endingGuard: freshGuard,
    });
    return await settleConversationalSource(row, source, {
      status: 'failed',
      text: current.actionDigest === guard.actionDigest && said ? said : approvedActionFailedText(current.action),
      endingGuard: freshGuard,
    });
  }
  return await settleConversationalSource(row, source, {
    status: 'needs_input',
    text: `The frozen send is ${pendingAction.status} and was not dispatched. Please ask me to prepare a fresh version if you still want it sent.`,
  });
}

export function settleConversationalApprovalDecision(
  candidate: approvalRegistry.PendingApprovalRow,
): Promise<boolean> {
  const existing = conversationalDecisionFlights.get(candidate.approvalId);
  if (existing) return existing;
  const flight = settleConversationalApprovalDecisionOnce(candidate)
    .catch((err) => {
      logger.warn({
        approvalId: candidate.approvalId,
        err: err instanceof Error ? err.message : String(err),
      }, 'conversational approval settlement hit a pre-provider fault; retry scheduled');
      scheduleConversationalDecisionRetry(candidate, 'settlement-pre-provider-fault');
      return false;
    })
    .then((settled) => {
      if (settled) clearConversationalDecisionRetry(candidate.approvalId);
      return settled;
    })
    .finally(() => {
      if (conversationalDecisionFlights.get(candidate.approvalId) === flight) {
        conversationalDecisionFlights.delete(candidate.approvalId);
      }
    });
  conversationalDecisionFlights.set(candidate.approvalId, flight);
  return flight;
}

function settleConversationalApprovalDecisionInBackground(
  row: approvalRegistry.PendingApprovalRow,
  owner: string,
): void {
  void settleConversationalApprovalDecision(row).then((settled) => {
    if (!settled) {
      logger.warn({ approvalId: row.approvalId, owner },
        'conversational approval settlement remains open after bounded retry');
    }
  }).catch((err) => {
    logger.error({
      approvalId: row.approvalId,
      owner,
      err: err instanceof Error ? err.message : String(err),
    }, 'conversational approval background settlement failed');
  });
}

/**
 * Bind the exact approval-response source and restart marker before execution.
 * Button/notification surfaces may not have a visible chat row, so the same
 * atomic primitive mints one hidden control edge. Chat surfaces supply an
 * already-visible accepted row, which is reused without creating a sibling.
 */
function prepareApprovalResumeSource(
  row: approvalRegistry.PendingApprovalRow,
  options: { armRunInFlight?: boolean } = {},
): ChatApprovalResumeSource | null {
  const runId = approvalResumeRunId(row.approvalId);
  const accepted = taggedApprovalResponse(row);
  if (!accepted) {
    const existingMatches = listEvents(row.sessionId, {
      types: ['user_input_received'],
    }).filter((event) => event.data.approvalId === row.approvalId);
    if (existingMatches.length > 0) return null;
  }
  const bound = accepted ? getRunAttemptBySourceUserSeq(row.sessionId, accepted.seq) : null;
  const active = bound?.status === 'active' && !bound.finishedAt ? bound : getActiveRunAttempt(row.sessionId);
  const activeSource = active ? getRunAttemptSourceUserEvent(active) : null;
  const attempt = active && accepted && activeSource?.seq === accepted.seq
    ? active
    : beginRunAttempt(row.sessionId, { runId });
  const source = recordRunAttemptUserInput(attempt, {
    turn: accepted?.turn ?? 0,
    role: 'user',
    data: accepted?.data ?? {
      text: `Approve ${row.approvalId}.`,
      displayText: `Approve ${row.approvalId}`,
      synthetic: true,
      source: 'approval_resume',
      approvalId: row.approvalId,
      decision: 'approve',
    },
  }, {
    ...(accepted ? { existingEventSeq: accepted.seq } : {}),
    armRunInFlight: options.armRunInFlight ?? true,
  });
  return {
    sourceUserSeq: source.seq,
    displayMessage: publicUserInputText(source.data) || `Approve ${row.approvalId}`,
    runAttemptId: attempt.attemptId,
    // A reused attempt (the desktop's own typed decision) keeps its run
    // family: the bridge correlates a resume by the attempt that owns the
    // source, and a foreign run id reads as an identity mismatch and refuses
    // the turn before any model (live 2026-10-06).
    runId: attempt.runId ?? runId,
  };
}

function scheduleResumeDrain(sessionId: string): void {
  if (resumeDrainTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    resumeDrainTimers.delete(sessionId);
    void drainQueuedApprovalResumes(sessionId);
  }, RESUME_DRAIN_DELAY_MS);
  timer.unref?.();
  resumeDrainTimers.set(sessionId, timer);
}

function enqueueApprovalResume(
  row: approvalRegistry.PendingApprovalRow,
  dispatch: ChatApprovalResumeDispatch,
): void {
  queuedApprovalResumes.set(row.approvalId, { row, dispatch });
  scheduleResumeDrain(row.sessionId);
}

function queuedResumeStillActionable(row: approvalRegistry.PendingApprovalRow): approvalRegistry.PendingApprovalRow | null {
  const current = approvalRegistry.get(row.approvalId);
  if (
    !current
    || current.status !== 'resolved'
    || current.resolution !== 'approved'
    || current.consumedAt
  ) return null;
  const pendingActionId = pendingActionIdFromArgs(current.args) ?? undefined;
  if (!pendingActionId) return current;
  const pendingAction = getPendingAction(pendingActionId);
  return pendingAction
    && pendingAction.sessionId === current.sessionId
    && pendingAction.approvalId === current.approvalId
    && pendingAction.status === 'approved'
    && pendingAction.approvedBy === 'human'
    ? current
    : null;
}

async function drainQueuedApprovalResumes(sessionId: string): Promise<void> {
  const session = HarnessSession.load(sessionId);
  if (!session || session.kind !== 'chat') {
    for (const [approvalId, queued] of queuedApprovalResumes) {
      if (queued.row.sessionId === sessionId) queuedApprovalResumes.delete(approvalId);
    }
    return;
  }
  if (activeResumeSessions.has(sessionId)) {
    scheduleResumeDrain(sessionId);
    return;
  }
  const next = [...queuedApprovalResumes.values()]
    .filter((queued) => queued.row.sessionId === sessionId)
    .sort((left, right) =>
      left.row.requestedAt.localeCompare(right.row.requestedAt)
      || left.row.approvalId.localeCompare(right.row.approvalId))[0];
  if (!next) return;
  const current = queuedResumeStillActionable(next.row);
  if (current) {
    const actionId = pendingActionIdFromArgs(current.args);
    const action = actionId ? getPendingAction(actionId) : null;
    if (await retireObsoleteApprovedAction(current, action)) return;
    if (approvalResumeOccupancy(session, current, action, Boolean(action && action.toolName !== 'run_batch'
      && action.sessionId === sessionId && action.approvalId === current.approvalId
      && action.status === 'approved' && action.approvedBy === 'human')).blocked) {
      scheduleResumeDrain(sessionId);
      return;
    }
  }
  queuedApprovalResumes.delete(next.row.approvalId);
  if (current) await handleResolvedApprovalForChatResume(current, next.dispatch);
  if ([...queuedApprovalResumes.values()].some((queued) => queued.row.sessionId === sessionId)) {
    scheduleResumeDrain(sessionId);
  }
}

/** Reporting only: the exact original request still has requirements the
 * admission oracle has not discharged. Approval source B completing one
 * action neither proves source A complete nor authorizes another effect.
 * Unknown/legacy evidence must not invent a Continue turn. */
export function approvedActionRetainedWorkNeedsVerification(
  row: { sessionId: string; presentation: Pick<approvalRegistry.ConversationalApprovalPresentation, 'sourceUserSeq'> | null },
  action: Pick<PendingActionRecord, 'sessionId' | 'sourceUserSeq'>,
  decisionSource: Pick<EventRow, 'sessionId' | 'seq'>,
): boolean {
  try {
    const sourceUserSeq = action.sourceUserSeq;
    if (action.sessionId !== row.sessionId || decisionSource.sessionId !== row.sessionId
      || sourceUserSeq === null || !Number.isSafeInteger(sourceUserSeq) || sourceUserSeq < 1
      || !Number.isSafeInteger(decisionSource.seq) || sourceUserSeq >= decisionSource.seq
      || (row.presentation && row.presentation.sourceUserSeq !== sourceUserSeq)) return false;
    const accepted = getUserInputEventAtSequence(row.sessionId, sourceUserSeq);
    if (!accepted || accepted.role !== 'user' || accepted.data.synthetic === true
      || !publicUserInputText(accepted.data).trim()) return false;
    const loaded = loadExpectedWorkContract(row.sessionId, sourceUserSeq);
    if (loaded.status !== 'ok' || loaded.contract.operations.length === 0) return false;
    const lines = expectedWorkPlanLines({ sessionId: row.sessionId, sourceUserSeq });
    const requirementIds = new Set(loaded.contract.operations.map((operation) => operation.id));
    if (lines.length !== requirementIds.size
      || new Set(lines.map((line) => line.requirementId)).size !== requirementIds.size
      || lines.some((line) => !requirementIds.has(line.requirementId))) return false;
    return lines.some((line) => line.state === 'open'
      || line.state === 'blocked_on_dependency' || line.state === 'data_in');
  } catch {
    // This optional projection may not obstruct exact action settlement or
    // reinterpret missing/unreadable evidence as whole-task completion.
    return false;
  }
}

/** The app's immediate execution status. Authored wording is a separate,
 * optional card projection; fixed host prose never impersonates Clem. */
export function approvedActionRanText(_action: Pick<PendingActionRecord, 'kind' | 'toolName'>, _result: string, retainedWorkNeedsVerification = false): string {
  const body = 'The approved action completed. Open execution details to see the recorded result.';
  return retainedWorkNeedsVerification
    ? `${body}\n\nYour earlier request still has retained work to verify. Ask Clem to check what completed and what remains before continuing.`
    : body;
}

const APPROVED_ACTION_ENDING_DEADLINE_MS = 20_000;
const APPROVED_ACTION_ENDING_FIELD_CHARS = 600;

function boundedEndingField(value: string, max = APPROVED_ACTION_ENDING_FIELD_CHARS): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What the record says happened to an approved action that did not land,
 * read from the executor's own markers, never from provider prose. */
export interface ApprovedActionEndingSibling {
  title: string;
  detail: string;
  happened: { verdict: 'never_started' | 'refused' | 'guard_refused' | 'uncertain' | 'executed'; reply: string };
}

/** The other members of the approval group this action was approved on, as
 * ending facts, how many of them have not settled yet, and whether this
 * member is the one that speaks for the set (the last one listed on the card:
 * fixed at card time, so concurrent members never both stay quiet). Undefined
 * when the action was approved on its own card. */
export function approvedActionGroupSiblings(
  row: approvalRegistry.PendingApprovalRow,
  action: PendingActionRecord,
): { siblings: ApprovedActionEndingSibling[]; unsettled: number; narrator: boolean } | undefined {
  try {
    const group = approvalRegistry.approvalGroupContaining(row.sessionId, row.approvalId);
    if (!group) return undefined;
    const members = approvalRegistry.approvalGroupMembers(group) ?? [];
    const memberIds = new Set(members.map((member) => member.approvalId));
    memberIds.delete(row.approvalId);
    if (memberIds.size === 0) return undefined;
    const narrator = members.at(-1)?.approvalId === row.approvalId;
    const records = listPendingActions({ sessionId: row.sessionId, status: 'all', limit: 100 })
      .filter((record) => record.id !== action.id && typeof record.approvalId === 'string' && memberIds.has(record.approvalId));
    const byApproval = new Map(records.map((record) => [record.approvalId, record] as const));
    const siblings: ApprovedActionEndingSibling[] = [];
    let unsettled = 0;
    for (const member of members) {
      if (member.approvalId === row.approvalId) continue;
      const record = byApproval.get(member.approvalId);
      const settled = record && (record.status === 'executed' || record.status === 'failed');
      if (!settled) unsettled += 1;
      const shell = record && (record.toolName === 'run_shell_command' || record.kind === 'shell_command');
      const payload = record?.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : {};
      const command = shell && typeof payload.command === 'string' ? payload.command : '';
      siblings.push({
        title: boundedEndingField(record?.title ?? member.subject ?? '', 200),
        detail: boundedEndingField(command || record?.title || member.subject || '', 400),
        happened: settled ? approvedActionEndingFacts(record) : { verdict: 'uncertain',
          reply: 'This one had not finished when this reply was written; its own result is not known yet.' },
      });
    }
    return { siblings, unsettled, narrator };
  } catch {
    return undefined;
  }
}

/** The one line the quiet members of an approved set leave; the set's reply
 * comes with its last member. */
export function approvedActionGroupMemberDoneText(action: Pick<PendingActionRecord, 'title'>): string {
  return `Done: ${boundedEndingField(action.title ?? 'the approved action', 200)}. One reply covers the whole approved set when its last action finishes.`;
}

const APPROVED_ACTION_SIBLING_WAIT_MS = 15_000;
const APPROVED_ACTION_SIBLING_POLL_MS = 500;

export function approvedActionEndingFacts(action: Pick<PendingActionRecord, 'status' | 'resultSummary'>): {
  verdict: 'never_started' | 'refused' | 'guard_refused' | 'uncertain' | 'executed';
  reply: string;
} {
  const summary = typeof action.resultSummary === 'string' ? action.resultSummary : '';
  const after = (marker: string) => summary.slice(summary.indexOf(marker) + marker.length).replace(/^[\s:;.-]+/, '');
  if (action.status === 'executed') return { verdict: 'executed', reply: boundedEndingField(summary) };
  if (action.status === 'failed' && summary.startsWith(PENDING_ACTION_PRE_DISPATCH_REFUSAL)) {
    return { verdict: 'never_started', reply: boundedEndingField(after(PENDING_ACTION_PRE_DISPATCH_REFUSAL)) };
  }
  if (action.status === 'failed' && summary.startsWith(PENDING_ACTION_TOOL_REFUSAL)) {
    const guard = /refused by harness|shell_policy_denial/i.test(summary);
    return { verdict: guard ? 'guard_refused' : 'refused', reply: boundedEndingField(toolRefusalWords(summary)) };
  }
  if (action.status === 'executing' || summary.startsWith(PENDING_ACTION_DISPATCH_UNCERTAIN)) {
    return { verdict: 'uncertain', reply: boundedEndingField(summary.startsWith(PENDING_ACTION_DISPATCH_UNCERTAIN) ? after(PENDING_ACTION_DISPATCH_UNCERTAIN) : '') };
  }
  return { verdict: 'refused', reply: boundedEndingField(summary) };
}

interface ApprovedActionEndingOwner {
  sessionId: string;
  sourceUserSeq: number;
  sourceDigest: string;
  approvalId: string;
  approvalDigest: string;
  pendingActionId: string;
  attemptId: string;
  runId: string;
  startedAt: string;
}
interface ApprovedActionEndingGuard { owner: ApprovedActionEndingOwner; actionDigest: string }
type ApprovedActionEndingOwnerRead = { kind: 'unavailable' } | { kind: 'stopped' }
  | { kind: 'current'; action: PendingActionRecord; actionDigest: string };
const endingDigest = (value: unknown): string => createHash('sha256').update(closedCanonicalJson(value)).digest('hex');
const endingApprovalDigest = (row: approvalRegistry.PendingApprovalRow): string => endingDigest({
  approvalId: row.approvalId, sessionId: row.sessionId, args: row.args,
  status: row.status, resolution: row.resolution, presentation: row.presentation ?? null,
});
const endingSourceDigest = (source: EventRow): string => endingDigest({
  id: source.id, sessionId: source.sessionId, seq: source.seq, turn: source.turn,
  role: source.role, type: source.type, data: source.data,
});

/** An exact decision can settle beside another foreground owner. Neither the
 * session's newest source nor its coarse foreground marker owns this read. */
function readApprovedActionEndingOwner(owner: ApprovedActionEndingOwner): ApprovedActionEndingOwnerRead {
  try {
    const source = getUserInputEventAtSequence(owner.sessionId, owner.sourceUserSeq);
    const row = approvalRegistry.get(owner.approvalId);
    if (!source || source.role !== 'user' || source.type !== 'user_input_received'
      || source.data.approvalId !== owner.approvalId || source.data.decision !== 'approve'
      || endingSourceDigest(source) !== owner.sourceDigest
      || !row || endingApprovalDigest(row) !== owner.approvalDigest
      || resolveExactTerminalForAcceptedSource(source).kind !== 'absent') return { kind: 'unavailable' };
    const attempt = openEventLog().prepare(`SELECT source_user_seq, run_id, started_at, status, finished_at
      FROM run_attempts WHERE session_id=? AND attempt_id=?`).get(owner.sessionId, owner.attemptId) as {
        source_user_seq: number | null; run_id: string | null; started_at: string; status: string; finished_at: string | null;
      } | undefined;
    if (!attempt || attempt.source_user_seq !== owner.sourceUserSeq || attempt.run_id !== owner.runId
      || attempt.started_at !== owner.startedAt) return { kind: 'unavailable' };
    if (approvedActionDecisionWasStoppedInTransaction(openEventLog(), owner)) return { kind: 'stopped' };
    if (attempt.status !== 'active' || attempt.finished_at !== null) return { kind: 'unavailable' };
    const action = getPendingAction(owner.pendingActionId);
    if (!action || !pendingActionResultApprovalMatches(action, row)
      || pendingActionPayloadHash(action.toolName, action.payload, action.executionAuthority ?? null) !== action.payloadHash) return { kind: 'unavailable' };
    return { kind: 'current', action, actionDigest: endingDigest(action) };
  } catch { return { kind: 'unavailable' }; }
}

function approvedActionEndingGuard(
  row: approvalRegistry.PendingApprovalRow,
  action: PendingActionRecord,
  source: EventRow,
  prepared: ChatApprovalResumeSource,
): ApprovedActionEndingGuard | null {
  try {
    if (source.sessionId !== row.sessionId || source.seq !== prepared.sourceUserSeq
      || pendingActionIdFromArgs(row.args) !== action.id || !pendingActionResultApprovalMatches(action, row)) return null;
    const attempt = openEventLog().prepare(`SELECT started_at FROM run_attempts
      WHERE session_id=? AND attempt_id=? AND source_user_seq=? AND run_id=?`)
      .get(row.sessionId, prepared.runAttemptId, source.seq, prepared.runId) as { started_at: string } | undefined;
    if (!attempt) return null;
    const owner: ApprovedActionEndingOwner = { sessionId: row.sessionId, sourceUserSeq: source.seq,
      sourceDigest: endingSourceDigest(source), approvalId: row.approvalId, approvalDigest: endingApprovalDigest(row),
      pendingActionId: action.id, attemptId: prepared.runAttemptId, runId: prepared.runId, startedAt: attempt.started_at };
    const current = readApprovedActionEndingOwner(owner);
    return current.kind === 'unavailable' ? null : { owner, actionDigest: endingDigest(action) };
  } catch { return null; }
}

/** The existing tool-free wording request owns only its exact result snapshot.
 * Cancellation never changes the action record or grants replay permission. */
async function approvedActionEndingInClemsWords(
  row: approvalRegistry.PendingApprovalRow,
  action: PendingActionRecord,
  source: EventRow,
  guard: ApprovedActionEndingGuard,
  options: { stillOpen?: boolean; siblings?: ApprovedActionEndingSibling[] } = {},
): Promise<string | null> {
  const port = peekTurnSemanticModelPort();
  if (!port?.voiceApprovedActionEnding) return null;
  const ambient = harnessRunContextStorage.getStore();
  const usage = modelUsageAttributionStorage.getStore();
  // Own attribution preserves inherited ownership. Refuse a foreign inherited
  // frame instead of silently labelling this request as someone else's work.
  if ((ambient && (ambient.sessionId !== row.sessionId || ambient.sourceUserSeq !== source.seq
    || ambient.runAttemptId !== guard.owner.attemptId))
    || (usage && (usage.sessionId !== row.sessionId || usage.sourceUserSeq !== source.seq
      || (usage.attemptId !== undefined && usage.attemptId !== guard.owner.attemptId)
      || (usage.usageParentTurn !== undefined && (!usage.usageParentTurn || usage.usageParentTurn.sessionId !== row.sessionId
        || usage.usageParentTurn.sourceUserSeq !== source.seq
        || (usage.usageParentTurn.attemptId !== undefined && usage.usageParentTurn.attemptId !== guard.owner.attemptId)))
      // This direct result request has no autonomous/memory job binding.
      // Matching outer coordinates do not prove that an inherited job owns it.
      || usage.usageJobId !== undefined || usage.standaloneAccountingJob !== undefined
      || usage.memoryAccountingOrigin !== undefined || usage.waitForOwnModel === true
      || usage.channel?.trim().toLowerCase().startsWith('memory:')))) return null;
  const usageOwner = { ...usage, sessionId: row.sessionId, sourceUserSeq: source.seq, attemptId: guard.owner.attemptId };
  const deadlineAt = Date.now() + APPROVED_ACTION_ENDING_DEADLINE_MS;
  const assertOwned = () => {
    const current = readApprovedActionEndingOwner(guard.owner);
    if (current.kind !== 'current' || current.actionDigest !== guard.actionDigest)
      throw new Error('Approval result narration no longer owns this exact result.');
  };
  try {
    const shell = action.toolName === 'run_shell_command' || action.kind === 'shell_command';
    const payload = action.payload && typeof action.payload === 'object' ? action.payload as Record<string, unknown> : {};
    const command = shell && typeof payload.command === 'string' ? payload.command : '';
    let asked = '';
    if (typeof action.sourceUserSeq === 'number') {
      const accepted = getUserInputEventAtSequence(row.sessionId, action.sourceUserSeq);
      if (accepted && accepted.data.synthetic !== true) asked = publicUserInputText(accepted.data);
    }
    const evidenceDigest = endingDigest(guard);
    const result = await runOwnedHostStopNarration({
      signal: ambient?.callerCancelSignal, deadlineMs: Math.max(0, deadlineAt - Date.now()), assertOwned,
      isStopped: () => approvedActionDecisionWasStoppedInTransaction(openEventLog(), guard.owner),
      work: scope => modelUsageAttributionStorage.run(usageOwner, () => withOwnModelRequestAttribution({
        sessionId: row.sessionId, sourceUserSeq: source.seq,
      }, () => port.voiceApprovedActionEnding!({
      purpose: CLEM_VOICE_PURPOSE, signal: scope.signal, deadlineAt, checkActive: scope.assertCurrent,
      asked: boundedEndingField(asked),
      action: {
        title: boundedEndingField(action.title ?? '', 200),
        kind: shell ? 'command_on_this_computer' : 'connected_app_change',
        detail: boundedEndingField(command || action.title || '', 400),
      },
      happened: { ...approvedActionEndingFacts(action), ...(options.stillOpen ? { stillOpen: true } : {}) },
      ...(options.siblings && options.siblings.length > 0 ? { siblings: options.siblings } : {}), evidenceDigest,
    }))),
    });
    assertOwned();
    const message = result?.message?.trim();
    return result?.evidenceDigest === evidenceDigest && message && message.length <= 600 ? message : null;
  } catch {
    logger.warn({ pendingActionId: action.id }, 'approved action ending: no current narrated result; retained app status stands');
    return null;
  }
}

/** The owner's decision ended without the action landing. Two honest cases:
 * refused before anything started (nothing changed; ask again and Clem
 * rebuilds it), or stopped after it may have begun (no silent retry; Clem
 * checks on request). Never the executor's machine text. */
export function approvedActionFailedText(action: Pick<PendingActionRecord, 'kind' | 'toolName' | 'status' | 'resultSummary'>): string {
  const shell = action.toolName === 'run_shell_command' || action.kind === 'shell_command';
  const what = shell ? 'the command' : 'it';
  const summary = typeof action.resultSummary === 'string' ? action.resultSummary : '';
  // Four honest endings, read from the record by the executor's own markers:
  // refused before anything started (nothing changed); refused by the tool
  // itself in words after the attempt began (the words reach the owner, the
  // outcome stays uncertain); stopped after it may have begun (uncertain,
  // never retried on its own); or a plain terminal failure the provider
  // reported. Exceptions and provider envelopes never reach the owner as
  // text; a guard's refusal does, because its reason — a credential that
  // would leave the machine — is the owner's to hear (live 2026-10-07).
  if (action.status === 'failed' && summary.startsWith(PENDING_ACTION_PRE_DISPATCH_REFUSAL)) {
    return `I couldn't run ${what} — the stored call didn't fit the tool's shape, so it was stopped before it started. Nothing ran and nothing changed.\n\nAsk me again in your own words and I'll build it fresh.`;
  }
  if (action.status === 'failed' && summary.startsWith(PENDING_ACTION_TOOL_REFUSAL)) {
    const words = toolRefusalWords(summary);
    return `I didn't run ${what} — the tool refused it${words ? `: ${words}` : '.'}\n\nThe refusal came back after the attempt had started, so I can't fully prove nothing changed, and I won't retry it on my own. Say "check" and I'll look at what landed before doing anything else.`;
  }
  if (action.status === 'executing' || summary.startsWith(PENDING_ACTION_DISPATCH_UNCERTAIN)) {
    return `I tried, but I can't tell whether ${what} went through — it stopped partway and the answer never came back, so the outcome is uncertain. I won't retry it on my own.\n\nSay "check" and I'll look at what landed before doing anything else.`;
  }
  return `${shell ? 'The command' : 'It'} didn't go through — the provider reported a terminal failure, and nothing more will run on its own.\n\nAsk me again in your own words if you still want it, and I'll build it fresh.`;
}

/** A guard's refusal in its own words, without the executor's bookkeeping
 * or the harness prefix: one line, bounded, ending in a period. */
export function toolRefusalWords(summary: string): string {
  const marker = 'no retry is safe:';
  const at = summary.indexOf(marker);
  const words = (at >= 0 ? summary.slice(at + marker.length) : '')
    .replace(/^\s*(?:Tool call refused by harness|Refused|Error)\s*[:\-—]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return '';
  const bounded = words.length > 300 ? `${words.slice(0, 297)}…` : words;
  return /[.!?…]$/.test(bounded) ? bounded : `${bounded}.`;
}

/** The executor's summary wraps the command's own output in bookkeeping
 * ("Executed the approved run_shell_command call. exit_code: 0 stdout: …");
 * the owner gets the output. */
function shellOutputOnly(summary: string): string {
  // The executor writes "exit_code: 0 stdout: … stderr: …" on one line; the
  // owner gets what the command printed, not its stderr chatter or bookkeeping.
  const start = summary.search(/\bstdout:/i);
  if (start < 0) return '(no output was captured)';
  let out = summary.slice(start + 'stdout:'.length);
  const stderrAt = out.search(/\bstderr:/i);
  if (stderrAt >= 0) out = out.slice(0, stderrAt);
  return out.trim() || '(nothing printed)';
}

export function chatApprovalResumeDirective(
  subject: string,
  tool: string,
  pendingActionId?: string,
  pendingActionToolName?: string,
  context: { ask?: string; request?: string } = {},
): string {
  // The approval is the owner's yes to a question Clem asked for THEIR
  // request; it is never a task of its own. Live 10-20 (Mac fixture): the
  // resumed turn ran the approved delete, then reported "instead of approving
  // apr-… three unrelated drafts were deleted; the approvals were not
  // performed", judging itself against the approval message.
  const framing = !context.ask && !context.request ? '' : `${context.ask ? `The owner just said yes to: "${context.ask}". ` : ''}`
    + `${context.request ? `That answers their request: "${context.request}". ` : ''}`
    + 'Report what landed against their request, in your own words; never describe the approval itself as a task, and never say an approval was not performed. ';
  if (pendingActionId) {
    if (pendingActionToolName === 'run_batch') {
      return (
        `[approval-resume] The user just APPROVED the exact queued batch "${subject}" (${pendingActionId}). `
        + `Call run_batch once with action="execute" and pending_action_id="${pendingActionId}". `
        + 'It consumes the stored certified plan and records the per-item ledger. '
        + 'Do not re-propose it, reconstruct any item, or request another approval. Then report the authoritative ledger.'
      );
    }
    return (
      `[approval-resume] The user just APPROVED the exact queued action "${subject}" (${pendingActionId}). `
      + `Call pending_action_execute once with id "${pendingActionId}". It dispatches the byte-identical stored payload and records the provider result. `
      + 'Do not re-queue it, reconstruct the underlying call, or request another approval. Then report what landed.'
    );
  }
  return (
    `[approval-resume] The user just APPROVED the pending action "${subject}" (${tool}). ${framing}`
    + 'Resume the parked task now: re-run the approved tool call with the exact same arguments — '
    + 'the approval gate will let that exact payload through without asking again. '
    + 'If more actions of this same kind remain for the request, issue all of them in one step so the owner answers once for the set. '
    + 'Then finish any remaining work from the original request and report what landed.'
  );
}

/** The owner's own request that an approval card answered: the accepted
 * source the card was raised for, in the owner's words, bounded. */
function approvalRequestText(row: approvalRegistry.PendingApprovalRow): string | undefined {
  try {
    const seq = row.presentation?.sourceUserSeq;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return undefined;
    const source = getUserInputEventAtSequence(row.sessionId, seq);
    if (!source || source.role !== 'user' || source.data.synthetic === true) return undefined;
    const text = publicUserInputText(source.data).replace(/\s+/g, ' ').trim();
    return text ? (text.length > 600 ? `${text.slice(0, 599)}…` : text) : undefined;
  } catch { return undefined; }
}

/** Decide + dispatch for one resolved approval. Exported for tests.
 *  Returns true when a resume was dispatched. */
export async function handleResolvedApprovalForChatResume(
  row: approvalRegistry.PendingApprovalRow,
  dispatch: ChatApprovalResumeDispatch,
): Promise<boolean> {
  try {
    const durableRow = queuedResumeStillActionable(row);
    if (!durableRow) return false;
    row = durableRow;
    if (handledApprovalIds.has(row.approvalId)) return false;
    const pendingActionId = pendingActionIdFromArgs(row.args) ?? undefined;
    const pendingAction = pendingActionId ? getPendingAction(pendingActionId) : null;
    // An exact linked pending-action card is intrinsically resumable. This is
    // the crash-recovery twin of approval_parked: if the daemon died after
    // linking the row but before appending that event, approval still executes
    // only the stored payload instead of resolving into a void.
    const exactLinkedPendingAction = Boolean(
      pendingAction
      && pendingAction.sessionId === row.sessionId
      && pendingAction.approvalId === row.approvalId
      && pendingAction.status === 'approved'
      && pendingAction.approvedBy === 'human',
    );
    const parked = listEvents(row.sessionId, { types: ['approval_parked'] })
      .some((ev) => (ev.data as { approvalId?: string } | undefined)?.approvalId === row.approvalId);
    if (!parked && !exactLinkedPendingAction) return false;
    const session = HarnessSession.load(row.sessionId);
    if (!session || session.kind !== 'chat') return false;
    if (await retireObsoleteApprovedAction(row, pendingAction)) return true;
    if (approvalSourceAlreadySettled(row)) {
      handledApprovalIds.add(row.approvalId);
      return false;
    }
    if (!approvalSourceIsSafeToDispatch(row)) {
      logger.warn({ approvalId: row.approvalId, sessionId: row.sessionId },
        'parked approval resume withheld because the exact source has external-write risk');
      return false;
    }
    const activeAttempt = getActiveRunAttempt(row.sessionId);
    const occupancy = approvalResumeOccupancy(session, row, pendingAction,
      exactLinkedPendingAction && pendingAction?.toolName !== 'run_batch');
    const runsBesideMarker = occupancy.preserveMarker;
    if (
      activeResumeSessions.has(row.sessionId)
      || occupancy.blocked
    ) {
      // The current turn may own this resolution; if so its durable consume or
      // pending-action terminal state makes the queued row inert. Otherwise
      // (for example a second exact card in one bulk approval) drain it after
      // the session is free instead of silently losing the user's decision.
      enqueueApprovalResume(row, dispatch);
      return false;
    }
    if (!activeAttempt && !runsBesideMarker && taggedApprovalResponse(row) && session.runInFlightSince()) {
      // Boot already retired the dead physical attempt. Replace (rather than
      // inherit) its pre-boot coarse marker so generic restart recovery cannot
      // race this approval-specific reclaim. A crash in this small clear→bind
      // interval is still durable: the approved/unconsumed registry row is the
      // next boot's scan source, and no callback has begun yet.
      session.clearRunInFlight();
      if (session.runInFlightSince()) return false;
    }
    // Beside a marker this resume does not own, arming would take that owner
    // over and the settle would then clear it, erasing a workflow's hold.
    const source = prepareApprovalResumeSource(row, { armRunInFlight: !runsBesideMarker });
    if (!source) {
      logger.warn({ approvalId: row.approvalId, sessionId: row.sessionId },
        'parked approval resume has ambiguous accepted response ownership');
      return false;
    }
    activeResumeSessions.add(row.sessionId);
    // A card linked to one exact stored action needs no model to act on the
    // owner's approval: the harness runs that payload once and settles the
    // resume source with what landed. A model turn here cost tokens and, on
    // the host engine, never ran: its synthetic source was refused before
    // the model was reached. Only a card with no stored action still resumes
    // the model with a directive.
    if (exactLinkedPendingAction && pendingAction && pendingAction.toolName !== 'run_batch') {
      const sourceEvent = listEvents(row.sessionId, { types: ['user_input_received'] })
        .find((event) => event.seq === source.sourceUserSeq);
      if (sourceEvent) {
        logger.info({ approvalId: row.approvalId, sessionId: row.sessionId, subject: row.subject, pendingActionId },
          'card approved — running the exact stored action');
        try {
          const settled = await executeApprovedLinkedActionAndSettle(row, sourceEvent, pendingAction, source);
          if (settled) handledApprovalIds.add(row.approvalId);
          return settled;
        } finally {
          activeResumeSessions.delete(row.sessionId);
        }
      }
    }
    logger.info({ approvalId: row.approvalId, sessionId: row.sessionId, subject: row.subject },
      'parked approval approved — resuming the chat session');
    try {
      await dispatch(
        row.sessionId,
        chatApprovalResumeDirective(
          row.subject,
          row.tool ?? 'the approved tool',
          pendingActionId,
          pendingAction?.toolName,
          { ...(approvalCardAsk(row.sessionId, row.approvalId) ? { ask: approvalCardAsk(row.sessionId, row.approvalId)! } : {}),
            ...(approvalRequestText(row) ? { request: approvalRequestText(row)! } : {}) },
        ),
        source,
      );
      // Only a successful handoff consumes the in-process one-shot. If the
      // dispatcher is temporarily unavailable, retain the exact accepted
      // source and allow a later retry/manual continue to drive it.
      handledApprovalIds.add(row.approvalId);
      return true;
    } finally {
      activeResumeSessions.delete(row.sessionId);
      if ([...queuedApprovalResumes.values()].some((queued) => queued.row.sessionId === row.sessionId)) {
        scheduleResumeDrain(row.sessionId);
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), approvalId: row.approvalId },
      'chat approval resume failed — the approval stays consumable; the user can say "continue"');
    return false;
  }
}

/** Wire the registry's resolution hook to the injected dispatcher. Idempotent
 *  per process (the registry appends listeners; guard our own double-start). */
let started = false;
let listenerRegistered = false;
let registeredDispatch: ChatApprovalResumeDispatch | null = null;
/** The resume in flight for each resolved card, so a surface that resolved
 * the card (a desktop button) can await the one execution instead of racing
 * it with its own. */
const resumeFlights = new Map<string, Promise<boolean>>();

function trackResumeFlight(approvalId: string, flight: Promise<boolean>): Promise<boolean> {
  resumeFlights.set(approvalId, flight);
  void flight.finally(() => {
    if (resumeFlights.get(approvalId) === flight) resumeFlights.delete(approvalId);
  });
  return flight;
}

/** The resume that the registry's resolution hook started for this card, or
 * null when none is in flight. */
export function approvalResumeInFlight(approvalId: string): Promise<boolean> | null {
  return resumeFlights.get(approvalId) ?? null;
}

/** True while this approved card's exact resume waits for a live run in its
 * chat to end; the drain runs it once that run lets go. */
export function approvalResumeQueued(approvalId: string): boolean {
  return queuedApprovalResumes.has(approvalId);
}

/** The resolver may return while its exact stored action is still running.
 * Keep the adopted attempt available to Stop; the resume's terminal owns its
 * finish. A different card/source must never retain an unrelated attempt. */
export function approvalResumeOwnsAttempt(approvalId: string, attempt: RunAttemptRef): boolean {
  if (!resumeFlights.has(approvalId) && !conversationalDecisionFlights.has(approvalId)) return false;
  const row = approvalRegistry.get(approvalId);
  if (!row || row.sessionId !== attempt.sessionId || row.resolution !== 'approved') return false;
  const source = taggedApprovalResponse(row);
  return Boolean(source && getRunAttemptSourceUserEvent(attempt)?.seq === source.seq);
}

const dispatchResolvedApproval = (row: approvalRegistry.PendingApprovalRow): void => {
  const dispatch = registeredDispatch;
  // Conversational consent has a live ingress owner. Let that owner atomically
  // resolve then await this resume, so the registry listener cannot race it and
  // queue behind the same active source. Boot recovery below still drains the
  // durable approved row after a crash.
  if (row.presentation) {
    settleConversationalApprovalDecisionInBackground(row, 'approval-resolution-listener');
  } else if (dispatch) {
    void trackResumeFlight(row.approvalId, handleResolvedApprovalForChatResume(row, dispatch));
  }
};

/** Resume one conversation-owned decision with the daemon's registered
 * dispatcher. The caller must keep the accepted source nonterminal until this
 * returns; this function adopts that exact active attempt. */
export async function resumeConversationalApproval(
  row: approvalRegistry.PendingApprovalRow,
): Promise<boolean> {
  const dispatch = registeredDispatch;
  if (!dispatch || !row.presentation) return false;
  return handleResolvedApprovalForChatResume(row, dispatch);
}
export function startChatApprovalResume(dispatch: ChatApprovalResumeDispatch): void {
  if (started) return;
  started = true;
  registeredDispatch = dispatch;
  // Keep one stable registry callback. Tests may reset/restart the subsystem;
  // appending closure listeners would leave old dispatchers live forever.
  if (!listenerRegistered) {
    approvalRegistry.onApprovalResolved(dispatchResolvedApproval);
    listenerRegistered = true;
  }

  // Resolution hooks are necessarily live-only. Drain the durable registry at
  // registration so a decision committed before listener installation (or a
  // hard process death after source binding) cannot orphan an approved card.
  // The normal handler owns all parked/exact-linked and terminal checks, so
  // rejected, expired, live-wait, consumed, and already-settled rows stay inert.
  const durableApproved = approvalRegistry.listPending({ status: 'resolved' })
    .filter((row) => !row.presentation && row.resolution === 'approved' && !row.consumedAt)
    .sort((left, right) =>
      (left.resolvedAt ?? left.requestedAt).localeCompare(right.resolvedAt ?? right.requestedAt)
      || left.approvalId.localeCompare(right.approvalId));
  for (const row of durableApproved) {
    // handleResolvedApprovalForChatResume runs synchronously through durable
    // source/attempt/marker binding before its first await. Do not block daemon
    // availability on model execution; the now-current marker and active
    // attempt own crash recovery while the callback runs.
    void handleResolvedApprovalForChatResume(row, dispatch);
  }

  // Reconcile every conversational decision, including PA states that must be
  // reported without dispatch (executing/failed/executed), and repair a
  // SQLite-resolved → file-backed approval_requested crash.
  for (const row of approvalRegistry.listPending({ status: 'resolved' })) {
    if (row.presentation) {
      settleConversationalApprovalDecisionInBackground(row, 'daemon-resolved-scan');
    }
  }

  // A process may die after provider ingress durably accepted B but before the
  // registry reply CAS. Adopt only the sole exact first tagged answer; a
  // duplicate or Yes/No race remains ambiguous and inert.
  for (const row of approvalRegistry.listPending({ status: 'pending' })) {
    const tagged = approvalRegistry.taggedConversationalApprovalReply(row);
    if (!tagged) continue;
    const resolved = approvalRegistry.resolveConversationalApprovalReply({
      approvalId: row.approvalId,
      sourceUserSeq: tagged.sourceUserSeq,
      userId: tagged.userId,
      conversationKey: tagged.conversationKey,
      decision: tagged.decision,
      resolver: 'daemon-conversation-recovery',
    });
    if (resolved.ok && resolved.row) {
      settleConversationalApprovalDecisionInBackground(resolved.row, 'daemon-tagged-reply-recovery');
    }
  }

  // Registration may have committed before its PA link or before the SDK
  // could publish the ordinary question. Repair the exact link, then re-emit
  // the same prompt event; a provider transport must still mark presentedAt
  // before any bare reply can claim it.
  for (const row of approvalRegistry.listPending({ status: 'pending' })) {
    if (!row.presentation || row.presentation.presentedAt) continue;
    const linked = approvalRegistry.reconcileLinkedPendingActionRegistration(row);
    if (linked) {
      reprojectUndeliveredConversationalApproval(linked);
      void deliverUndeliveredConversationalPrompt(linked.approvalId);
    }
  }
}

/** Test hook: clear the in-process one-shot memory. */
export function _resetChatApprovalResumeForTest(): void {
  handledApprovalIds.clear();
  activeResumeSessions.clear();
  queuedApprovalResumes.clear();
  for (const timer of resumeDrainTimers.values()) clearTimeout(timer);
  resumeDrainTimers.clear();
  conversationalDecisionFlights.clear();
  for (const timer of conversationalDecisionRetryTimers.values()) clearTimeout(timer);
  conversationalDecisionRetryTimers.clear();
  conversationalDecisionRetryAttempts.clear();
  for (const timer of conversationalPromptDeliveryTimers.values()) clearTimeout(timer);
  conversationalPromptDeliveryTimers.clear();
  started = false;
  registeredDispatch = null;
}
