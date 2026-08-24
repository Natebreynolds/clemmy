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
 *    the running turn will see the resolution itself.
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
  listEvents,
  recordRunAttemptUserInput,
  type EventRow,
  type RunAttemptRef,
} from './eventlog.js';
import { HarnessSession } from './session.js';
import { getPendingAction } from './pending-actions.js';
import { pendingActionIdFromArgs } from './pending-action-view.js';
import { publicUserInputText } from './public-presentation.js';
import { freshExternalWriteEvidenceStatus } from './tool-evidence.js';
import { executeApprovedPendingActionCall } from '../../execution/pending-action-executor.js';
import { recordAcceptedSourceGraph } from './record-accepted-source-graph.js';
import { commitTurnOutcome } from './delivery-committer.js';
import { turnOutcomeId, type TurnIdentity } from './turn-outcome.js';
import { reprojectUndeliveredConversationalApproval } from './claude-agent-approval.js';
import { requireAcceptedTaskAuthority } from './accepted-task-authority.js';
import { requireActionExpectedWorkActivation } from './action-expected-work-boundary.js';
import { ToolCallsCounter, withHarnessRunContext } from './brackets.js';

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
  input: { text: string; status: 'done' | 'failed' | 'needs_input' },
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
    const common = { version: 2 as const, id: turnOutcomeId(identity), identity };
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
        : {
            ...common,
            status: 'failed' as const,
            resumable: false as const,
            presentation: { kind: 'error' as const, text: input.text },
          };
    commitTurnOutcome(outcome, {
      legacyReason: 'conversational_send_consent_resolved',
      metadata: { approvalId: row.approvalId, pendingActionId: pendingActionIdFromArgs(row.args) },
    });
    const attempt = getActiveRunAttempt(row.sessionId);
    if (attempt && getRunAttemptSourceUserEvent(attempt)?.seq === source.seq) {
      try { finishRunAttempt(attempt, input.status === 'failed' ? 'failed' : 'completed'); } catch { /* terminal wins */ }
    }
    HarnessSession.load(row.sessionId)?.clearRunInFlight();
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
    requireActionExpectedWorkActivation({
      sessionId: source.sessionId,
      sourceUserSeq: source.seq,
    });
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
  if (pendingAction.status === 'executed') {
    return await settleConversationalSource(row, source, {
      status: 'done',
      text: pendingAction.resultSummary ?? `Executed the exact approved ${pendingAction.toolName} call.`,
    });
  }
  if (pendingAction.status === 'executing') {
    return await settleConversationalSource(row, source, {
      status: 'failed',
      text: pendingAction.resultSummary
        ?? 'The send crossed into an execution attempt, but its outcome is uncertain. I will not retry it automatically.',
    });
  }
  if (pendingAction.status === 'failed') {
    return await settleConversationalSource(row, source, {
      status: 'failed',
      text: pendingAction.resultSummary ?? 'The exact approved send failed or became uncertain. I will not retry it automatically.',
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
): ChatApprovalResumeSource | null {
  const runId = approvalResumeRunId(row.approvalId);
  const accepted = taggedApprovalResponse(row);
  if (!accepted) {
    const existingMatches = listEvents(row.sessionId, {
      types: ['user_input_received'],
    }).filter((event) => event.data.approvalId === row.approvalId);
    if (existingMatches.length > 0) return null;
  }
  const active = getActiveRunAttempt(row.sessionId);
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
    armRunInFlight: true,
  });
  return {
    sourceUserSeq: source.seq,
    displayMessage: publicUserInputText(source.data) || `Approve ${row.approvalId}`,
    runAttemptId: attempt.attemptId,
    runId,
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
  if (activeResumeSessions.has(sessionId) || getActiveRunAttempt(sessionId) || session.runInFlightSince()) {
    scheduleResumeDrain(sessionId);
    return;
  }
  const next = [...queuedApprovalResumes.values()]
    .filter((queued) => queued.row.sessionId === sessionId)
    .sort((left, right) =>
      left.row.requestedAt.localeCompare(right.row.requestedAt)
      || left.row.approvalId.localeCompare(right.row.approvalId))[0];
  if (!next) return;
  queuedApprovalResumes.delete(next.row.approvalId);
  const current = queuedResumeStillActionable(next.row);
  if (current) await handleResolvedApprovalForChatResume(current, next.dispatch);
  if ([...queuedApprovalResumes.values()].some((queued) => queued.row.sessionId === sessionId)) {
    scheduleResumeDrain(sessionId);
  }
}

export function chatApprovalResumeDirective(
  subject: string,
  tool: string,
  pendingActionId?: string,
  pendingActionToolName?: string,
): string {
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
    `[approval-resume] The user just APPROVED the pending action "${subject}" (${tool}). `
    + 'Resume the parked task now: re-run the approved tool call with the exact same arguments — '
    + 'the approval gate will let that exact payload through without asking again. '
    + 'Then finish any remaining work from the original request and report what landed.'
  );
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
    if (
      activeResumeSessions.has(row.sessionId)
      || (activeAttempt && !activeAttemptOwnsApprovalResume(activeAttempt, row))
      // A pre-attempt legacy executor can still own the coarse marker. Once an
      // attempt-backed approval resume exists, that exact owner wins instead.
      || (!activeAttempt && session.runInFlightSince() && !taggedApprovalResponse(row))
    ) {
      // The current turn may own this resolution; if so its durable consume or
      // pending-action terminal state makes the queued row inert. Otherwise
      // (for example a second exact card in one bulk approval) drain it after
      // the session is free instead of silently losing the user's decision.
      enqueueApprovalResume(row, dispatch);
      return false;
    }
    if (!activeAttempt && taggedApprovalResponse(row) && session.runInFlightSince()) {
      // Boot already retired the dead physical attempt. Replace (rather than
      // inherit) its pre-boot coarse marker so generic restart recovery cannot
      // race this approval-specific reclaim. A crash in this small clear→bind
      // interval is still durable: the approved/unconsumed registry row is the
      // next boot's scan source, and no callback has begun yet.
      session.clearRunInFlight();
      if (session.runInFlightSince()) return false;
    }
    const source = prepareApprovalResumeSource(row);
    if (!source) {
      logger.warn({ approvalId: row.approvalId, sessionId: row.sessionId },
        'parked approval resume has ambiguous accepted response ownership');
      return false;
    }
    activeResumeSessions.add(row.sessionId);
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
const dispatchResolvedApproval = (row: approvalRegistry.PendingApprovalRow): void => {
  const dispatch = registeredDispatch;
  // Conversational consent has a live ingress owner. Let that owner atomically
  // resolve then await this resume, so the registry listener cannot race it and
  // queue behind the same active source. Boot recovery below still drains the
  // durable approved row after a crash.
  if (row.presentation) {
    settleConversationalApprovalDecisionInBackground(row, 'approval-resolution-listener');
  } else if (dispatch) {
    void handleResolvedApprovalForChatResume(row, dispatch);
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
