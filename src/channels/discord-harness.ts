/**
 * Discord ↔ 0.3 harness bridge.
 *
 * When DISCORD_HARNESS_ENABLED=true, incoming Discord messages are
 * routed through this handler instead of the v0.2 gateway. Live
 * progress is rendered by editing the bot's reply message as
 * actionBus emits fail-closed harness.public_event projections for the session.
 *
 * Why in-process actionBus instead of the SSE endpoint:
 *   The Discord bot is already inside the daemon process. Round-
 *   tripping through HTTP/SSE adds latency and a moving part for no
 *   gain. We subscribe to actionBus directly and filter by session.
 *
 * Discord edit-rate caveat:
 *   Discord's rate limit on message.edit is ~5/5s per channel. We
 *   debounce edits to ~1 every 2 seconds so a chatty turn (many
 *   tool_called events) never trips the limit. The last edit always
 *   wins regardless of how many events fired during the debounce.
 */
import type { Message } from 'discord.js';
import { completionReviewEnabled } from '../runtime/harness/respond-bridge.js';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { actionBus } from '../runtime/action-bus.js';
import {
  PUBLIC_CHANNEL_FAILURE_TEXT,
  PUBLIC_MODEL_RUNTIME_UNAVAILABLE_TEXT,
} from './public-failure.js';
import { configureHarnessRuntime } from '../runtime/harness/codex-client.js';
import {
  appendEvent as appendHarnessEvent,
  beginRunAttempt,
  createSession as createHarnessSession,
  finishRunAttempt,
  getActiveRunAttempt,
  getHarnessChatRequestReceipt,
  getLatestEventSeq,
  getLatestRunAttempt,
  getLatestRunAttemptByRunId,
  getSession as getHarnessSession,
  listEvents as listHarnessEvents,
  listSessions as listHarnessSessions,
  recordRunAttemptUserInput,
  requestKill,
  updateSession as updateHarnessSession,
  type EventRow,
  type RunAttemptRef,
  type SessionRow,
} from '../runtime/harness/eventlog.js';
import {
  runConversation,
  runConversationFromResume,
  verifiedWorkflowRunDispatchReceipts,
} from '../runtime/harness/loop.js';
import { queueBackgroundTaskApprovalResolution } from '../execution/background-tasks.js';
import { buildContinueInput } from '../runtime/harness/continue-directive.js';
import { respondPreferHarness } from '../runtime/harness/respond-bridge.js';
import {
  enqueueDurableChatTask,
  renderDurableTaskQueued,
  shouldPromoteToDurable,
  detectBackgroundItIntent,
  detachRunningTurnToBackground,
  isBackgroundHandoffApprovalBlocked,
} from '../execution/background-promote.js';
import {
  findSoleAwaitingContinueTaskForOrigin,
  findSoleAwaitingInputTaskForOrigin,
  listBackgroundTasks,
  queueBackgroundTaskContinue,
  queueBackgroundTaskInputResolution,
  type BackgroundTaskRecord,
} from '../execution/background-tasks.js';
import { classifyBackgroundInputReply } from '../execution/background-input-reply.js';
import { HarnessSession } from '../runtime/harness/session.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import {
  claimSessionForAcceptedSource,
  resolveAcceptedSourceIngressLineage,
  selectSessionForAcceptedSource,
} from '../runtime/harness/accepted-source-session-branch.js';
import { durablePayloadHash } from './durable-request.js';
import {
  pullRecentTurnsForSession,
  renderRelevantPriorWorkForModel,
  renderTranscriptTurns,
  type RelevantPriorWorkSource,
} from '../runtime/harness/session-transcript.js';
import {
  getActiveFocus as getActiveFocusForPrefix,
  createFocus as createFocusForPrefix,
  checkResourceMatchesFocus,
  extractResourceIdFromApprovalArgs,
  extractNamedResource,
} from '../memory/focus.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import {
  pendingActionApprovalViewFromArgs,
  pendingActionIdFromArgs,
  type PendingActionApprovalView,
} from '../runtime/harness/pending-action-view.js';
import {
  parseAutonomousSendConsentReply,
} from '../runtime/harness/autonomous-send-consent.js';
import { listActionableCheckIns } from '../execution/inbox-questions.js';
import { settleConversationalApprovalDecision } from '../runtime/harness/chat-approval-resume.js';
import { listPlanProposals, approvePlanProposal, rejectPlanProposal } from '../agents/plan-proposals.js';
import { previewToolCall } from '../runtime/approval-summary.js';
import { buildOrchestratorAgent, buildOrchestratorAgentForApprovalResume } from '../agents/orchestrator.js';
import { runPlanFirstPreflight, shouldUsePlanFirst } from '../runtime/harness/plan-first.js';
import { parseGoalCommand, handleGoalContractCommand } from '../agents/goal-commands.js';
import { createJsonFieldStreamer } from '../runtime/harness/stream-reply.js';
import { routeOpenQuestionPlan } from '../runtime/harness/plan-continuity.js';
import { loadProactivityPolicy } from '../agents/proactivity-policy.js';
import { isStatusCommand, buildBoardSummary, formatBoardSummaryText } from '../dashboard/board-summary.js';
import { commitTurnOutcome } from '../runtime/harness/delivery-committer.js';
import {
  assertPublicPresentationText,
  turnOutcomeId,
  type TurnIdentity,
} from '../runtime/harness/turn-outcome.js';
import { presentationEventFromCompletionData } from '../runtime/harness/turn-outcome.js';
import {
  publicAsyncWorkDispatchedData,
  publicConversationPreambleData,
  publicUserInputText,
} from '../runtime/harness/public-presentation.js';
import type {
  AssistantResponse,
  ConversationPreambleDeliveryCallback,
  ConversationPreambleDeliveryRequest,
  ConversationPreambleDeliveryResult,
} from '../types.js';
import type { RunConversationHold } from '../runtime/harness/run-conversation-disposition.js';
import { clearRunInFlightAfterTerminal } from '../runtime/harness/restart-recovery.js';
import { isCanonicalTopLevelToolEvent } from '../runtime/harness/tool-effect.js';
import {
  advanceTransportProgress,
  settleTransportProgress,
  shouldPaintChannelBody,
  type TransportProgressAction,
  type TransportProgressState,
} from './transport-progress.js';
import { projectChatAttemptActivity } from '../dashboard/activity-projection.js';
import type {
  SurfaceActivityLabel,
  SurfaceLifecycle,
  SurfaceTerminal,
} from '../runtime/graph/surface-projection.js';
import { composeRunProgressLine, runPlanCounters } from '../runtime/harness/run-progress.js';
import {
  exactOriginDeliveryTargetDigest,
  exactOriginDeliveryTargetFromSessionSnapshot,
} from '../runtime/exact-origin-delivery.js';

const EDIT_DEBOUNCE_MS = 2_000;
const SAFETY_TIMEOUT_MS = 35 * 60_000;
const MAX_DISCORD_MESSAGE = 1_900;

// v0.5.19 F8 — after a Discord interaction token expires (at minute 15),
// the existing flush() returns silently because intermediate edits go
// nowhere. For 80+ tool-call runs that span >15 min, the user sees
// nothing until the very end. POST_EXPIRY_CHECKIN_MS spaces out
// "still working" follow-ups via sendFollowup so the user knows the
// bot didn't die. 5 minutes balances "I see progress" against
// "Discord channel noise."
export const POST_EXPIRY_CHECKIN_MS = 5 * 60_000;

/**
 * Public progress is a request-scoped presentation choice, not a runtime
 * feature gate. The audit event stream remains complete in both modes.
 */
export type ProgressPresentation = 'quiet' | 'compact';

export function progressPresentationForPrompt(input: string): ProgressPresentation {
  const text = input.trim();
  if (!text) return 'compact';

  // An explicit request for updates wins when a prompt contains conflicting
  // language. We only infer quiet mode from direct presentation instructions;
  // safety wording such as "do not guess" must not silence progress.
  const asksForProgress = /\b(?:keep\s+me\s+updated|show\s+(?:me\s+)?(?:your\s+)?progress|progress\s+updates?)\b/i.test(text);
  if (asksForProgress) return 'compact';

  const rejectsNarration = /\b(?:do\s+not|don['’]t|without)\s+(?:narrat(?:e|ing)|describ(?:e|ing)|explain(?:ing)?|show(?:ing)?|report(?:ing)?)\b[\s\S]{0,120}\b(?:plans?|progress|steps?|tool(?:\s+calls?)?)\b/i.test(text);
  const asksForOnlyResult = /\b(?:return|respond|reply|give\s+me)\s+only\b[\s\S]{0,160}\b(?:answers?|results?|evidence|blockers?)\b/i.test(text);
  return rejectsNarration || asksForOnlyResult ? 'quiet' : 'compact';
}

function progressPresentationForSession(sessionId: string): ProgressPresentation {
  const inputs = listHarnessEvents(sessionId, { types: ['user_input_received'], desc: true });
  for (const input of inputs) {
    const stored = input.data.progressPresentation;
    if (stored === 'quiet' || stored === 'compact') return stored;
    // Old sessions do not have the typed field. Reconstruct it only from the
    // latest real request; approval-control messages must inherit past it.
    if (input.data.source === 'channel_approval_resume') continue;
    const displayText = typeof input.data.displayText === 'string'
      ? input.data.displayText
      : typeof input.data.text === 'string'
        ? input.data.text
        : '';
    return progressPresentationForPrompt(displayText);
  }
  return 'compact';
}

function commitDiscordTerminal(input: {
  source: EventRow;
  text: string;
  status: 'done' | 'needs_input' | 'failed';
  reason: string;
  metadata?: Record<string, unknown>;
}): ReturnType<typeof commitTurnOutcome> {
  const identity: TurnIdentity = {
    sessionId: input.source.sessionId,
    turn: input.source.turn,
    sourceUserSeq: input.source.seq,
  };
  const common = { version: 2 as const, id: turnOutcomeId(identity), identity };
  const outcome = input.status === 'failed'
    ? {
        ...common,
        status: 'failed' as const,
        resumable: false as const,
        presentation: { kind: 'error' as const, text: input.text },
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
        status: 'done' as const,
        resumable: false as const,
        presentation: { kind: 'answer' as const, text: input.text },
      };
  return commitTurnOutcome(outcome, {
    legacyReason: input.reason,
    metadata: input.metadata,
  });
}

function commitDiscordAnswer(input: {
  source: EventRow;
  text: string;
  reason: string;
  metadata?: Record<string, unknown>;
}): ReturnType<typeof commitTurnOutcome> {
  return commitDiscordTerminal({ ...input, status: 'done' });
}

/** A late terminal from superseded A must not erase newer B's marker. */
function clearChannelRunMarkerIfIdle(sessionId: string, ownerAttemptId?: string): void {
  clearRunInFlightAfterTerminal(sessionId, ownerAttemptId);
}

function exactChannelReplyAuthority(channel: string, channelId: string): {
  originReplyTarget: NonNullable<ReturnType<typeof exactOriginDeliveryTargetFromSessionSnapshot>>;
  originReplyTargetDigest: string;
} {
  const originReplyTarget = exactOriginDeliveryTargetFromSessionSnapshot({
    channel,
    metadata: { channelId },
  });
  if (!originReplyTarget) {
    throw new Error(`channel ${channel}:${channelId} has no exact reply target`);
  }
  return {
    originReplyTarget,
    originReplyTargetDigest: exactOriginDeliveryTargetDigest(originReplyTarget),
  };
}

function recordActiveChannelUserInput(
  attempt: ActiveDiscordHarnessRun,
  modelText: string,
  displayText: string,
  progressPresentation: ProgressPresentation = progressPresentationForPrompt(displayText),
): EventRow {
  const replyAuthority = exactChannelReplyAuthority(attempt.channel, attempt.channelId);
  return recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: {
      text: modelText,
      displayText,
      progressPresentation,
      userId: attempt.userId,
      conversationKey: `${attempt.channel}:${attempt.channelId}`,
      attemptId: attempt.attemptId,
      source: `channel:${attempt.channel}`,
      ...replyAuthority,
    },
  }, { armRunInFlight: true });
}

/**
 * v0.5.19 F8 — exported predicate so the verify-long-running smoke
 * can exercise the throttle logic without spinning up the full Discord
 * harness closure. Returns true iff we should post a "still working"
 * follow-up RIGHT NOW.
 */
export function shouldPostExpiryCheckIn(input: {
  tokenExpired: boolean;
  stateDone: boolean;
  lastCheckInAt: number;
  now: number;
  hasSendFollowup: boolean;
}): boolean {
  if (!input.tokenExpired) return false;
  if (input.stateDone) return false;
  if (!input.hasSendFollowup) return false;
  return input.now - input.lastCheckInAt >= POST_EXPIRY_CHECKIN_MS;
}

export function shouldStreamLiveTextToMessage(channel: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (channel !== 'discord') return true;
  // Default ON (COMPOUNDING wave): the brain streams exactly ONE opening
  // sentence per turn now — her own "on it" reaching the user as she says it
  // was the felt-latency ask. The env stays as the kill-switch.
  const raw = (env.CLEMMY_DISCORD_LIVE_TEXT_STREAMING ?? 'on').trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes';
}

// Structured logger for Discord edit failures. The previous
// `catch { }` blocks at the edit sites swallowed errors silently —
// rate limits, token expiry (Discord interaction tokens die at 15
// min), network blips — all invisible to the dev + user. With this
// logger, every edit failure lands in ~/.clementine-next/logs/daemon.log
// so long-running workflows that go quiet on Discord can be
// diagnosed instead of guessed at. Pure observability — no behavior
// change.
const logger = pino({ name: 'clementine-next.discord-harness' });

/**
 * Discord interaction tokens issued at the start of a /command or
 * button interaction are valid for ~15 minutes. After that, calls to
 * the webhook (which is what `handle.edit()` ultimately hits) fail
 * with one of:
 *   - HTTP 401 "Invalid Webhook Token" (Discord error code 50027)
 *   - HTTP 404 "Unknown Webhook" (Discord error code 10015)
 *   - Discord.js DiscordAPIError with the same codes attached
 *
 * This helper recognizes all the shapes I've seen in the wild without
 * blindly trusting any single field. False positives are cheap (we
 * just stop trying to edit and use followups, which is the right
 * behavior for any persistent edit failure anyway). False negatives
 * mean we keep logging the same error every flush — annoying but not
 * broken, and the structured-logging shipped in v0.5.3 makes it
 * obvious in daemon.log when it happens.
 */
function isDiscordTokenExpired(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; status?: unknown; httpStatus?: unknown; message?: unknown };
  const codeNum = typeof e.code === 'number'
    ? e.code
    : typeof e.code === 'string' && /^\d+$/.test(e.code) ? parseInt(e.code, 10) : NaN;
  if (codeNum === 50027 || codeNum === 10015) return true;
  const status = typeof e.status === 'number' ? e.status : (typeof e.httpStatus === 'number' ? e.httpStatus : NaN);
  if (status === 401 || status === 404) return true;
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return msg.includes('invalid webhook token')
    || msg.includes('unknown webhook')
    || msg.includes('interaction has expired')
    || msg.includes('interaction expired');
}

/**
 * Per-channel harness session continuity. Without this, every DM
 * spawns a brand-new session and the orchestrator has zero memory
 * of the previous turn — the agent looks broken (asks a clarifying
 * question, the user answers, and the next "session" has no idea
 * what file/topic was just discussed).
 *
 * Channel → most-recent session id + last-used timestamp. Sessions
 * older than CONTINUITY_WINDOW_MS are treated as stale and a fresh
 * session is created on the next DM, so a user coming back the next
 * day doesn't end up resuming a long-cold thread.
 */
interface ChannelSessionEntry {
  sessionId: string;
  lastUsedAt: number;
}
const channelSessions = new Map<string, ChannelSessionEntry>();
const audienceChannelSessions = new Map<string, ChannelSessionEntry>();
const CONTINUITY_WINDOW_MS = 30 * 60_000;

interface ChannelAudienceIdentity {
  channel: string;
  channelId: string;
  userId: string;
  guildId: string | null;
}

function channelAudienceKey(input: ChannelAudienceIdentity): string {
  return JSON.stringify([
    input.channel.trim().toLowerCase(),
    input.guildId?.trim() ?? '',
    input.channelId.trim(),
    input.userId.trim(),
  ]);
}

export interface ActiveDiscordHarnessRun {
  channel: string;
  channelId: string;
  userId: string;
  guildId: string | null;
  sessionId: string;
  attemptId: string;
  runId: string | null;
  startedAt: string;
}

export interface DurableChannelRequest {
  runId: string;
  /** Stable transport receipt identity and the hash of the complete accepted
   * provider payload. Ordinary ingress supplies both so session occupancy and
   * receipt ownership commit before the user edge. */
  requestId?: string;
  inputHash?: string;
  /** Session chosen on first acceptance and recovered from the provider inbox
   *  on replay. It overrides continuity heuristics. */
  sessionId?: string;
  userId?: string;
  scopeId?: string | null;
  onSourceAccepted?: (source: EventRow) => void;
}

function exactDiscordTerminal(source: EventRow): { event: EventRow; text: string } | null {
  for (const event of listHarnessEvents(source.sessionId, { types: ['conversation_completed'], desc: true })) {
    if (event.data.sourceUserSeq !== source.seq && event.data.terminalKey !== `turn:${source.seq}`) continue;
    try {
      const presentation = presentationEventFromCompletionData(event.data);
      if (presentation?.identity.sourceUserSeq === source.seq) return { event, text: presentation.text };
    } catch {
      return null;
    }
  }
  return null;
}

function exactDiscordAsyncDispatch(source: EventRow): {
  event: EventRow;
  text: string;
  runIds: string[];
  sourceGroupId: string;
} | null {
  const verifiedEventIds = new Set(
    verifiedWorkflowRunDispatchReceipts(source.sessionId, source.turn, source.seq)
      .map((receipt) => receipt.eventId),
  );
  for (const event of listHarnessEvents(source.sessionId, { types: ['async_work_dispatched'], desc: true })) {
    const dispatch = publicAsyncWorkDispatchedData(event.data);
    if (!dispatch || !verifiedEventIds.has(event.id) || dispatch.sourceUserSeq !== source.seq) continue;
    return {
      event,
      text: dispatch.text,
      runIds: [...dispatch.runIds],
      sourceGroupId: dispatch.sourceGroupId,
    };
  }
  return null;
}

type AcceptedChannelOutcome =
  | { kind: 'terminal'; event: EventRow; text: string }
  | { kind: 'dispatched'; event: EventRow; text: string; runIds: string[]; sourceGroupId: string };

function acceptedChannelOutcome(source: EventRow): AcceptedChannelOutcome | null {
  const terminal = exactDiscordTerminal(source);
  if (terminal) return { kind: 'terminal', ...terminal };
  const dispatched = exactDiscordAsyncDispatch(source);
  return dispatched ? { kind: 'dispatched', ...dispatched } : null;
}

function acceptedSourceForDurableRun(input: {
  sessionId: string;
  runId: string;
  displayText: string;
}): { source: EventRow; attempt: RunAttemptRef | null } | null {
  const previous = getLatestRunAttemptByRunId(input.sessionId, input.runId);
  if (!previous?.sourceUserSeq) return null;
  const source = listHarnessEvents(input.sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq === previous.sourceUserSeq);
  if (!source) throw new Error(`durable channel source ${previous.sourceUserSeq} is missing`);
  if (publicUserInputText(source.data) !== input.displayText.trim()) {
    throw new Error(`durable channel run ${input.runId} is already bound to different input`);
  }
  return {
    source,
    attempt: previous.finishedAt ? null : {
      sessionId: previous.sessionId,
      attemptId: previous.attemptId,
      runId: previous.runId,
      startedAt: previous.startedAt,
    },
  };
}

function acceptDurableApprovalControl(input: {
  durableRequest: DurableChannelRequest | undefined;
  sessionId: string;
  displayText: string;
  approvalId?: string;
  candidateApprovalIds?: string[];
  decision: 'approve' | 'reject';
  userId?: string;
  scopeId?: string | null;
  conversationKey?: string;
  source?: 'channel_approval_control' | 'channel_send_consent';
  preserveUnsettledReplay?: boolean;
}): { source: EventRow; attempt: RunAttemptRef | null; replayText?: string } | null {
  if (!input.durableRequest) return null;
  if (input.durableRequest.sessionId && input.durableRequest.sessionId !== input.sessionId) {
    throw new Error(`durable approval run ${input.durableRequest.runId} is bound to another session`);
  }
  const prior = acceptedSourceForDurableRun({
    sessionId: input.sessionId,
    runId: input.durableRequest.runId,
    displayText: input.displayText,
  });
  if (prior) {
    input.durableRequest.onSourceAccepted?.(prior.source);
    const sourceCandidates = Array.isArray(prior.source.data.candidateApprovalIds)
      ? prior.source.data.candidateApprovalIds.filter((value): value is string => typeof value === 'string')
      : [];
    const expectedCandidates = input.candidateApprovalIds ?? [];
    if (
      prior.source.data.approvalId !== input.approvalId
      || prior.source.data.decision !== input.decision
      || JSON.stringify(sourceCandidates) !== JSON.stringify(expectedCandidates)
      || (input.userId !== undefined && prior.source.data.userId !== input.userId)
      || (input.conversationKey !== undefined && prior.source.data.conversationKey !== input.conversationKey)
      || prior.source.data.source !== (input.source ?? 'channel_approval_control')
    ) {
      throw new Error(`durable approval run ${input.durableRequest.runId} is bound to a different decision`);
    }
    const outcome = acceptedChannelOutcome(prior.source);
    if (outcome) {
      if (prior.attempt) {
        try { finishRunAttempt(prior.attempt, 'completed'); } catch { /* durable outcome wins */ }
        clearChannelRunMarkerIfIdle(input.sessionId, prior.attempt.attemptId);
      }
      return { ...prior, replayText: outcome.text };
    }
    // The exact consent-resume owner, not this ingress retry, must finish a
    // source that may already be across the provider boundary. Preserve the
    // active attempt for in-process adoption or boot recovery.
    if (input.preserveUnsettledReplay) return prior;
    const failed = commitDiscordTerminal({
      source: prior.source,
      text: PUBLIC_CHANNEL_FAILURE_TEXT,
      status: 'failed',
      reason: 'approval_transport_replay_unsettled',
      metadata: { uncertainPriorExecution: true, approvalId: input.approvalId, decision: input.decision },
    });
    if (prior.attempt) {
      try { finishRunAttempt(prior.attempt, 'failed'); } catch { /* typed terminal wins */ }
      clearChannelRunMarkerIfIdle(input.sessionId, prior.attempt.attemptId);
    }
    return { ...prior, replayText: failed.presentation.text };
  }
  const attempt = beginRunAttempt(input.sessionId, { runId: input.durableRequest.runId });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 0,
    role: 'user',
    data: {
      text: input.displayText,
      displayText: input.displayText,
      source: input.source ?? 'channel_approval_control',
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      ...(input.candidateApprovalIds && input.candidateApprovalIds.length > 0
        ? { candidateApprovalIds: input.candidateApprovalIds }
        : {}),
      decision: input.decision,
      attemptId: attempt.attemptId,
      runId: input.durableRequest.runId,
    },
  }, { armRunInFlight: true });
  input.durableRequest.onSourceAccepted?.(source);
  return { source, attempt };
}

function settleDurableApprovalControl(
  accepted: { source: EventRow; attempt: RunAttemptRef | null } | null,
  text: string,
  status: 'done' | 'needs_input' | 'failed' = 'done',
): string {
  if (!accepted) return text;
  const committed = commitDiscordTerminal({
    source: accepted.source,
    text,
    status,
    reason: 'approval_control_resolved',
    metadata: {
      approvalId: accepted.source.data.approvalId,
      decision: accepted.source.data.decision,
    },
  });
  if (accepted.attempt) {
    try { finishRunAttempt(accepted.attempt, status === 'failed' ? 'failed' : 'completed'); } catch { /* terminal wins */ }
    clearChannelRunMarkerIfIdle(accepted.source.sessionId, accepted.attempt.attemptId);
  }
  return committed.presentation.text;
}

/** Accept an ordinary send-consent answer without replacing the physical run
 * that may currently be paused inside the SDK permission hook. A generic
 * beginRunAttempt would supersede that executor before its exact resumable
 * claim can continue. The provider inbox already supplies the stable runId;
 * this event is its durable one-shot source and is later adopted by a parked
 * approval resume only when the original run no longer owns execution. */
function acceptDurableConversationalControl(input: {
  durableRequest: DurableChannelRequest;
  sessionId: string;
  displayText: string;
  approvalId: string;
  decision: 'approve' | 'reject';
  userId: string;
  conversationKey: string;
}): { source: EventRow; attempt: RunAttemptRef | null; replayText?: string } {
  if (input.durableRequest.sessionId && input.durableRequest.sessionId !== input.sessionId) {
    throw new Error(`durable consent run ${input.durableRequest.runId} is bound to another session`);
  }
  const priorMatches = listHarnessEvents(input.sessionId, {
    types: ['user_input_received'],
  }).filter((event) => (
    event.data.source === 'channel_send_consent'
    && event.data.runId === input.durableRequest.runId
  ));
  if (priorMatches.length > 1) throw new Error('durable consent run has ambiguous accepted sources');
  if (priorMatches.length === 1) {
    const source = priorMatches[0];
    if (
      publicUserInputText(source.data) !== input.displayText.trim()
      || source.data.approvalId !== input.approvalId
      || source.data.decision !== input.decision
      || source.data.userId !== input.userId
      || source.data.conversationKey !== input.conversationKey
    ) throw new Error('durable consent run is already bound to a different answer');
    input.durableRequest.onSourceAccepted?.(source);
    const previous = getLatestRunAttemptByRunId(input.sessionId, input.durableRequest.runId);
    return { source, attempt: previous ?? null, replayText: acceptedChannelOutcome(source)?.text };
  }
  // The native SDK call was parked before provider dispatch and ownership now
  // belongs to the host PendingAction machine. Give this exact reply its own
  // durable physical attempt so provider execution and the terminal are both
  // settled against B, never against the earlier request or a fresh model turn.
  const attempt = beginRunAttempt(input.sessionId, { runId: input.durableRequest.runId });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 0,
    role: 'user',
    data: {
      text: input.displayText,
      displayText: input.displayText,
      source: 'channel_send_consent',
      approvalId: input.approvalId,
      decision: input.decision,
      userId: input.userId,
      conversationKey: input.conversationKey,
      runId: input.durableRequest.runId,
    },
  }, { armRunInFlight: true });
  input.durableRequest.onSourceAccepted?.(source);
  return { source, attempt };
}

export class UnboundDurableApprovalReplyError extends Error {
  constructor() {
    super('durable approval reply has no provable conversation session');
    this.name = 'UnboundDurableApprovalReplyError';
  }
}

function stableApprovalReplySession(input: {
  durableRequest?: DurableChannelRequest;
  channelId: string;
  channel: string;
  userId?: string;
  scopeId?: string | null;
  candidateRows?: approvalRegistry.PendingApprovalRow[];
}): string | null {
  if (input.durableRequest?.sessionId && getHarnessSession(input.durableRequest.sessionId)) {
    return input.durableRequest.sessionId;
  }
  const principalUserId = input.userId ?? input.durableRequest?.userId;
  const principalScopeId = input.scopeId ?? input.durableRequest?.scopeId ?? null;
  const bound = principalUserId
    ? getOrHydrateAudienceSession({
      channel: input.channel,
      channelId: input.channelId,
      userId: principalUserId,
      guildId: principalScopeId,
    })
    : null;
  if (bound && getHarnessSession(bound.sessionId)) return bound.sessionId;
  const rows = input.candidateRows ?? [];
  const candidateSessions = [...new Set(rows.map((row) => row.sessionId))];
  return candidateSessions.length === 1 && getHarnessSession(candidateSessions[0])
    ? candidateSessions[0]
    : null;
}

async function settleApprovalRoutingReply(input: {
  durableRequest?: DurableChannelRequest;
  channelId: string;
  channel: string;
  userId?: string;
  scopeId?: string | null;
  prompt: string;
  decision: 'approve' | 'reject';
  transport: DiscordHarnessTransport;
  text: string;
  status: 'needs_input' | 'failed';
  approvalId?: string;
  candidateRows?: approvalRegistry.PendingApprovalRow[];
}): Promise<void> {
  if (!input.durableRequest) {
    await input.transport.sendError(input.text);
    return;
  }
  const sessionId = stableApprovalReplySession(input);
  if (!sessionId) throw new UnboundDurableApprovalReplyError();
  const candidateApprovalIds = input.candidateRows?.map((row) => row.approvalId).sort() ?? [];
  const accepted = acceptDurableApprovalControl({
    durableRequest: input.durableRequest,
    sessionId,
    displayText: input.prompt,
    approvalId: input.approvalId,
    candidateApprovalIds,
    decision: input.decision,
  });
  const text = accepted?.replayText
    ?? settleDurableApprovalControl(accepted, input.text, input.status);
  await input.transport.sendInitial(text);
}

// The continuity map answers "which conversation is bound here?"; this map
// answers the narrower control-plane question "which run is executing here
// right now?". Keeping those concepts separate prevents a stop command from
// latching onto an idle/reusable chat session.
const activeChannelRuns = new Map<string, Map<string, ActiveDiscordHarnessRun>>();

function activeChannelRunKey(channel: string, channelId: string): string {
  return `${channel}:${channelId}`;
}

function registerActiveChannelRun(input: {
  channel: string;
  channelId: string;
  userId: string;
  guildId: string | null;
  sessionId: string;
  runId?: string;
}): ActiveDiscordHarnessRun {
  const attempt = beginRunAttempt(input.sessionId, { runId: input.runId });
  const { runId: _requestedRunId, ...channelInput } = input;
  const active: ActiveDiscordHarnessRun = { ...channelInput, ...attempt };
  const key = activeChannelRunKey(input.channel, input.channelId);
  const runs = activeChannelRuns.get(key) ?? new Map<string, ActiveDiscordHarnessRun>();
  runs.set(active.attemptId, active);
  activeChannelRuns.set(key, runs);
  return active;
}

function unregisterActiveChannelRun(active: ActiveDiscordHarnessRun, status: 'completed' | 'cancelled' | 'failed' = 'completed'): void {
  const key = activeChannelRunKey(active.channel, active.channelId);
  const runs = activeChannelRuns.get(key);
  runs?.delete(active.attemptId);
  if (runs?.size === 0) activeChannelRuns.delete(key);
  try { finishRunAttempt(active, status); } catch { /* control telemetry is best-effort */ }
}

/** A held bridge response means this transport invocation is only an observer:
 * the durable attempt is still owned by a peer/recovery activation. Release
 * the local channel registration without settling that exact shared owner. */
function releaseHeldChannelObserver(active: ActiveDiscordHarnessRun): void {
  const key = activeChannelRunKey(active.channel, active.channelId);
  const runs = activeChannelRuns.get(key);
  runs?.delete(active.attemptId);
  if (runs?.size === 0) activeChannelRuns.delete(key);
}

export function resolveActiveDiscordHarnessRuns(input: {
  channelId: string;
  userId?: string | null;
  guildId?: string | null;
  channel?: string;
}): ActiveDiscordHarnessRun[] {
  const channel = input.channel ?? 'discord';
  const runs = activeChannelRuns.get(activeChannelRunKey(channel, input.channelId));
  if (!runs) return [];
  return [...runs.values()]
    .filter((run) => !input.userId || run.userId === input.userId)
    .filter((run) => input.guildId == null || run.guildId === input.guildId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

async function tryHandleBackgroundItControl(input: {
  message: string;
  channelId: string;
  userId: string;
  guildId: string | null;
  channel: string;
  channelLabel: string;
  transport: DiscordHarnessTransport;
}): Promise<boolean> {
  if (!detectBackgroundItIntent(input.message)) return false;
  const candidates = resolveActiveDiscordHarnessRuns(input);
  if (candidates.length !== 1) {
    await input.transport.sendInitial(candidates.length === 0
      ? '🍊 I could not find a running turn here to move to the background.'
      : '🍊 More than one turn is active here, so I did not guess which one to move. Stop or finish one, then try again.');
    return true;
  }
  const foreground = candidates[0];
  if (isBackgroundHandoffApprovalBlocked(foreground.sessionId)) {
    await input.transport.sendInitial('🍊 This turn is waiting on an approval. Approve or reject that action first; I did not move or restart it.');
    return true;
  }
  const detached = detachRunningTurnToBackground(
    foreground.sessionId,
    foreground,
    {
      source: input.channel as 'discord' | 'slack',
      channel: input.channelLabel,
      userId: input.userId,
    },
  );
  await input.transport.sendInitial(detached
    ? detached.text
    : '🍊 That turn changed or finished before I could move it, so I left the current work alone.');
  return true;
}

/** Bound origin session for finding background work dispatched by this chat. */
export function getBoundDiscordHarnessSessionId(
  channelId: string,
  channel: string = 'discord',
  userId?: string,
  guildId: string | null = null,
): string | null {
  const identity = userId ? { channel, channelId, userId, guildId } : null;
  const recent = identity
    ? getOrHydrateAudienceSession(identity)
    : getOrHydrateChannelSession(channelId, channel);
  if (recent) return recent.sessionId;

  // A live attempt can legitimately outlast the conversational continuity
  // window. Stop is a control-plane operation, so never make it depend on a
  // warm process-local map (or on the user having spoken in the last 30m).
  // Rehydrate the durable channel binding when SQLite still says that exact
  // session owns an active attempt.
  const durable = identity
    ? findMostRecentAudienceSession(identity)
    : findMostRecentChannelSession(channelId, channel);
  if (!durable || !getActiveRunAttempt(durable.sessionId)) return null;
  if (identity) {
    audienceChannelSessions.set(channelAudienceKey(identity), {
      sessionId: durable.sessionId,
      lastUsedAt: durable.updatedAt,
    });
  } else {
    channelSessions.set(channelId, { sessionId: durable.sessionId, lastUsedAt: durable.updatedAt });
  }
  return durable.sessionId;
}

export interface BoundChannelRunAttempt {
  sessionId: string;
  attempt: RunAttemptRef;
}

/**
 * Resolve the exact SQLite attempt currently owned by a channel's durable
 * conversation binding. Both Discord and Slack use this control-plane lookup,
 * so a daemon restart cannot turn a user's Stop message into a fresh model
 * turn merely because the in-memory active-run map was lost.
 */
export function resolveBoundChannelRunAttempt(input: {
  channelId: string;
  channel?: string;
  userId?: string;
  guildId?: string | null;
}): BoundChannelRunAttempt | null {
  const sessionId = getBoundDiscordHarnessSessionId(
    input.channelId,
    input.channel ?? 'discord',
    input.userId,
    input.guildId ?? null,
  );
  if (!sessionId) return null;
  const attempt = getActiveRunAttempt(sessionId);
  return attempt ? { sessionId, attempt } : null;
}

/** Exact-stop the bound attempt; never creates a session-wide/stale latch. */
export function requestBoundChannelRunStop(input: {
  channelId: string;
  channel?: string;
  userId?: string;
  guildId?: string | null;
  reason: string;
}): BoundChannelRunAttempt | null {
  const target = resolveBoundChannelRunAttempt(input);
  if (!target) return null;
  requestKill(target.sessionId, input.reason, target.attempt);
  return target;
}

/**
 * Look up the most recent harness session for a Discord channel in
 * SQLite. Used to rehydrate the in-memory channelSessions map after
 * a daemon restart so a session that was paused-for-approval before
 * the restart can still be resumed by typing "approve" — the
 * approval state lives in the durable event log, but the channel-id
 * → session-id mapping was process-local.
 */
function findMostRecentChannelSession(channelId: string, channel: string = 'discord'): { sessionId: string; updatedAt: number } | null {
  try {
    const db = openEventLog();
    const row = db
      .prepare(
        `SELECT id, updated_at FROM sessions
           WHERE (
             (channel = ? AND json_extract(metadata_json, '$.channelId') = ?)
             OR json_extract(metadata_json, '$.source') = ?
                AND json_extract(metadata_json, '$.channelId') = ?
             OR (channel = ? OR json_extract(metadata_json, '$.source') = ?)
                AND json_extract(metadata_json, '$.discordChannelId') = ?
           )
           ORDER BY updated_at DESC
           LIMIT 1`,
      )
      .get(channel, channelId, channel, channelId, channel, channel, channelId) as { id?: string; updated_at?: string } | undefined;
    if (!row?.id || !row.updated_at) return null;
    return { sessionId: row.id, updatedAt: new Date(row.updated_at).getTime() };
  } catch {
    return null;
  }
}

/**
 * Look up the channel's session, hydrating from SQLite if it's not
 * already in the in-memory map. Returns null if no recent session
 * exists OR the most recent one is past the continuity window.
 */
function getOrHydrateChannelSession(channelId: string, channel: string = 'discord'): ChannelSessionEntry | null {
  const now = Date.now();
  const existing = channelSessions.get(channelId);
  if (existing && now - existing.lastUsedAt < CONTINUITY_WINDOW_MS) {
    const row = getHarnessSession(existing.sessionId);
    if (row) return existing;
    channelSessions.delete(channelId);
  }
  const recent = findMostRecentChannelSession(channelId, channel);
  if (!recent) return null;
  if (now - recent.updatedAt > CONTINUITY_WINDOW_MS) return null;
  const entry: ChannelSessionEntry = { sessionId: recent.sessionId, lastUsedAt: recent.updatedAt };
  channelSessions.set(channelId, entry);
  return entry;
}

/** Ordinary chat continuity is a closed provider principal, never a
 * channel-wide guess. The channel-only map above remains for explicit control
 * discovery; it cannot select an ordinary accepted source. */
function findMostRecentAudienceSession(
  identity: ChannelAudienceIdentity,
): { sessionId: string; updatedAt: number } | null {
  try {
    const row = openEventLog().prepare(`
      SELECT id, updated_at FROM sessions
       WHERE lower(COALESCE(json_extract(metadata_json, '$.source'), channel, '')) = ?
         AND COALESCE(
           json_extract(metadata_json, '$.channelId'),
           json_extract(metadata_json, '$.discordChannelId'),
           json_extract(metadata_json, '$.slackChannelId'),
           ''
         ) = ?
         AND COALESCE(
           user_id,
           json_extract(metadata_json, '$.userId'),
           json_extract(metadata_json, '$.discordUserId'),
           json_extract(metadata_json, '$.slackUserId'),
           ''
         ) = ?
         AND COALESCE(
           json_extract(metadata_json, '$.guildId'),
           json_extract(metadata_json, '$.discordGuildId'),
           json_extract(metadata_json, '$.slackTeamId'),
           ''
         ) = ?
       ORDER BY updated_at DESC
       LIMIT 1
    `).get(
      identity.channel.trim().toLowerCase(),
      identity.channelId,
      identity.userId,
      identity.guildId ?? '',
    ) as { id?: string; updated_at?: string } | undefined;
    if (!row?.id || !row.updated_at) return null;
    return { sessionId: row.id, updatedAt: Date.parse(row.updated_at) };
  } catch {
    return null;
  }
}

function getOrHydrateAudienceSession(identity: ChannelAudienceIdentity): ChannelSessionEntry | null {
  const key = channelAudienceKey(identity);
  const now = Date.now();
  const existing = audienceChannelSessions.get(key);
  if (existing && now - existing.lastUsedAt < CONTINUITY_WINDOW_MS) {
    if (getHarnessSession(existing.sessionId)) return existing;
    audienceChannelSessions.delete(key);
  }
  const recent = findMostRecentAudienceSession(identity);
  if (!recent || !Number.isFinite(recent.updatedAt) || now - recent.updatedAt > CONTINUITY_WINDOW_MS) {
    return null;
  }
  const entry = { sessionId: recent.sessionId, lastUsedAt: recent.updatedAt };
  audienceChannelSessions.set(key, entry);
  return entry;
}

/**
 * Per-channel staleness window. If the user's last interaction with
 * the channel-cached session was longer ago than this AND a fresh
 * non-approval message arrives, open a NEW session instead of
 * grafting. Prevents the failure mode where a 6-hour-old paused
 * session captures unrelated chat as a "continuation."
 *
 * Bumped 5 min → 30 min on 2026-05-24. The 5-minute default was set
 * for workflow-approval-era usage. Real chat conversations routinely
 * gap 5-15 minutes (bathroom, quick call, reading a long agent
 * reply). A 5:31-second gap fragmented one coherent "score the leads
 * via firecrawl to fill the Keep/Drop dropdowns" thread into 5
 * separate harness sessions, with the last message ("first 10 please")
 * arriving in a fresh session that had no idea what "first 10" meant.
 * 30 min is wide enough to absorb normal interruptions, tight enough
 * that "this morning's conversation" doesn't bleed into "this evening's
 * unrelated topic."
 */
const STALE_SESSION_MS = 30 * 60 * 1000;

async function resolveOrCreateSession(opts: {
  channelId: string;
  userId: string;
  guildId: string | null;
  prompt: string;
  /** Exact human-authored objective for conservative prior-work matching. */
  priorWorkObjective?: string;
  /** Channel kind for the harness session (default 'discord'). Slack passes
   *  'slack' so sessions/continuity/activity stay correctly attributed. */
  channel?: string;
  /** Stable provider message/run identity, selected before source acceptance. */
  durableSourceId: string;
  /** Present for real provider ingress. Selection, source occupancy, and the
   * durable receipt then commit atomically before run/source acceptance. */
  receipt?: { requestId: string; runId: string; inputHash: string };
}): Promise<{ id: string; isContinuation: boolean }> {
  const channel = opts.channel ?? 'discord';
  const now = Date.now();
  const identity: ChannelAudienceIdentity = {
    channel,
    channelId: opts.channelId,
    userId: opts.userId,
    guildId: opts.guildId,
  };
  const audienceKey = channelAudienceKey(identity);
  let existing = getOrHydrateAudienceSession(identity);
  if (existing) {
    // Continuation is intentional ONLY when the channel was actively
    // engaged recently. After STALE_SESSION_MS without traffic, fresh
    // messages open a new session — the prior one keeps its history
    // and (if paused) stays reachable via apr-xxxx. Without this, a
    // paused session that sat 6 hours would silently absorb the next
    // unrelated message as if it were continuing the same workflow.
    const elapsed = now - existing.lastUsedAt;
    if (elapsed <= STALE_SESSION_MS) {
      existing.lastUsedAt = now;
    } else {
      audienceChannelSessions.delete(audienceKey);
      existing = null;
    }
  }
  // A transport retry may arrive after process restart, when the warm audience
  // map is empty. Its immutable receipt is the owner and must win before we
  // create even a blank candidate root.
  const priorReceipt = opts.receipt
    ? getHarnessChatRequestReceipt(opts.receipt.requestId)
    : null;
  const entrySessionId = priorReceipt?.sessionId ?? existing?.sessionId ?? createHarnessSession({
      kind: 'chat',
      channel,
      userId: opts.userId,
      title: opts.prompt.length > 60 ? `${opts.prompt.slice(0, 57)}...` : opts.prompt,
      metadata: {
        source: channel,
        channelId: opts.channelId,
        userId: opts.userId,
        guildId: opts.guildId,
      },
    }).id;
  const selectionInput = {
    kind: 'ordinary',
    entrySessionId,
    durableSourceId: opts.durableSourceId,
    continuity: {
      provider: channel,
      scopeId: opts.guildId,
      conversationId: opts.channelId,
      audienceId: opts.userId,
    },
  } as const;
  const selected = opts.receipt
    ? claimSessionForAcceptedSource({
        ...selectionInput,
        receipt: opts.receipt,
      }).selection
    : selectSessionForAcceptedSource(selectionInput);
  if (!getHarnessSession(selected.sessionId)) {
    throw new Error(`accepted-source selector returned missing session ${selected.sessionId}`);
  }
  bindDiscordHarnessSession({
    channelId: opts.channelId,
    sessionId: selected.sessionId,
    userId: opts.userId,
    guildId: opts.guildId,
    channel,
  });
  return {
    id: selected.sessionId,
    isContinuation: Boolean(existing) && selected.disposition === 'reused',
  };
}

const CROSS_SESSION_PREFIX_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

// Generous lookback so multi-turn back-references ("first 10 please" →
// referring to a 25/batch decision made 2 turns ago) carry across the
// session boundary. The user's principle: missing context is fatal,
// extra context is fine. Pulls from the most recent N prior sessions
// (not just the immediately previous one) so a workflow that spanned
// e.g. five 5-minute sessions still surfaces its full arc.
const PREFIX_LOOKBACK_SESSIONS = 4;
const PREFIX_MAX_TURNS_PER_SESSION = 6;
const HISTORICAL_PRIOR_WORK_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;
const HISTORICAL_PRIOR_WORK_SOURCE_LIMIT = 24;

function historicalPriorWorkSources(
  db: ReturnType<typeof openEventLog>,
  input: {
    newSessionId: string;
    channelId: string;
    userId: string;
    channel: string;
    now: number;
  },
): RelevantPriorWorkSource[] {
  const upperBound = new Date(input.now).toISOString();
  const lowerBound = new Date(input.now - HISTORICAL_PRIOR_WORK_WINDOW_MS).toISOString();
  return (db.prepare(
    `SELECT e.session_id AS sourceSessionId, e.seq AS sourceUserSeq
       FROM events e
       JOIN sessions s ON s.id = e.session_id
      WHERE e.type = 'user_input_received'
        AND e.role = 'user'
        AND COALESCE(json_extract(e.data_json, '$.synthetic'), 0) != 1
        AND e.session_id != ?
        AND s.channel = ?
        AND COALESCE(s.user_id, json_extract(s.metadata_json, '$.userId')) = ?
        AND json_extract(s.metadata_json, '$.channelId') = ?
        AND e.created_at >= ?
        AND e.created_at <= ?
      ORDER BY e.seq DESC
      LIMIT ?`,
  ).all(
    input.newSessionId,
    input.channel,
    input.userId,
    input.channelId,
    lowerBound,
    upperBound,
    HISTORICAL_PRIOR_WORK_SOURCE_LIMIT,
  ) as Array<{ sourceSessionId: string; sourceUserSeq: number }>).map((row) => ({
    sourceSessionId: row.sourceSessionId,
    sourceUserSeq: row.sourceUserSeq,
  }));
}

async function seedCrossSessionPrefix(
  newSessionId: string,
  channelId: string,
  userId: string,
  now: number,
  newMessage?: string,
  channel: string = 'discord',
  priorWorkObjective: string = newMessage ?? '',
): Promise<void> {
  const db = openEventLog();
  // Find the most recent N prior sessions for this channel (exclude
  // the newly-created one). We walk multiple sessions because the
  // arc may have been fragmented across several short sessions
  // before STALE_SESSION_MS got bumped — and a "first 10" back-ref
  // can land 30+ minutes after the planning turn it points to.
  const priorRows = db.prepare(
    `SELECT id, updated_at FROM sessions
       WHERE channel = ?
         AND id != ?
         AND json_extract(metadata_json, '$.channelId') = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
  ).all(channel, newSessionId, channelId, PREFIX_LOOKBACK_SESSIONS) as Array<{ id: string; updated_at: string }>;

  // Filter to those still inside the prefix window.
  const inWindow = priorRows.filter((r) => {
    const ms = Date.parse(r.updated_at);
    return Number.isFinite(ms) && now - ms <= CROSS_SESSION_PREFIX_WINDOW_MS;
  });

  // Spend the char budget NEWEST-first (inWindow is updated_at DESC) so a
  // back-reference keeps the most-relevant recent sessions; the old code
  // iterated oldest-first and so dropped the NEWEST sessions on overflow. We
  // reverse the KEPT blocks afterward so the text still reads chronologically.
  const sectionBlocks: string[] = [];
  let totalChars = 0;
  const MAX_TOTAL_CHARS = 8_000; // generous, but bounded
  for (const session of inWindow) {
    const turns = pullRecentTurnsForSession(db, session.id, PREFIX_MAX_TURNS_PER_SESSION);
    if (turns.length === 0) continue;
    const elapsedMin = Math.round((now - Date.parse(session.updated_at)) / 60_000);
    const block = `--- Prior session ${session.id} (ended ~${elapsedMin} min ago) ---\n${renderTranscriptTurns(turns)}`;
    if (totalChars + block.length > MAX_TOTAL_CHARS) break;
    sectionBlocks.push(block);
    totalChars += block.length;
  }
  sectionBlocks.reverse(); // chronological (oldest → newest) for reading

  // Historical candidates are deliberately broader than continuation: same
  // human + channel, at most 24 accepted sources over 14 days. Exact source
  // refs retain provenance while semantic ranking remains non-authoritative.
  const priorWorkSources = historicalPriorWorkSources(db, {
    newSessionId,
    channelId,
    userId,
    channel,
    now,
  });
  const priorWork = await renderRelevantPriorWorkForModel(db, {
    currentObjective: priorWorkObjective,
    priorSources: priorWorkSources,
  });

  // Surface active focus state too — if a focus is pinned, the new
  // session should treat it as authoritative context.
  let focusBlock = '';
  try {
    let active = getActiveFocusForPrefix();
    // Auto-pin a focus when (a) no active focus exists, AND (b) the
    // prior sessions had a clear "currently working on" resource we
    // can extract from their tool calls. This is the automation that
    // prevents the "agent re-discovers and picks the WRONG sheet"
    // missing-focus failure mode: without a focus
    // anchor, memory_recall surfaced a similarly-named workflow
    // SKILL.md whose sheet_id was different from the one the user
    // had actually been editing across 5 prior sessions.
    if (!active) {
      const autoPinned = autoPinFocusFromPriorSessions(db, inWindow.map((r) => r.id), newMessage);
      if (autoPinned) {
        active = autoPinned;
      }
    }
    if (active) {
      focusBlock = `Active focus (cross-channel): #${active.id} "${active.title}" — ${active.summary}\nResource: ${active.resource_ref}`;
    }
  } catch { /* ignore */ }

  if (sectionBlocks.length === 0 && priorWork.count === 0) return;

  const continuationLines: string[] = [];
  if (sectionBlocks.length > 0) {
    continuationLines.push(
      '[CONTINUATION CONTEXT — the user\'s message in this fresh session likely refers back to the recent conversation thread below. Treat this as authoritative context; do NOT ask the user to repeat decisions already made.]',
    );
    if (focusBlock) continuationLines.push('', focusBlock);
    continuationLines.push(
      '',
      ...sectionBlocks,
      '',
      '[End of continuation context. The user\'s next message follows.]',
    );
  }

  appendHarnessEvent({
    sessionId: newSessionId,
    turn: 0,
    role: 'system',
    type: 'cross_session_prefix',
    data: {
      priorSessionIds: inWindow.map((r) => r.id),
      sessionsIncluded: sectionBlocks.length,
      totalChars,
      ...(priorWork.count > 0 ? {
        priorWork: {
          version: 2,
          match: 'historical_candidates',
          queryHash: priorWork.queryHash,
          count: priorWork.count,
          items: priorWork.items,
        },
      } : {}),
      text: [
        ...(priorWork.text ? [priorWork.text, ''] : []),
        ...continuationLines,
      ].join('\n').trim(),
    },
  });
}

/**
 * Heuristic auto-pin: scan the most recent prior-session events for
 * a stable resource reference (Google Sheets id, Google Doc id, full
 * URL). If found, pin it as the active focus so the new session
 * inherits a hard anchor — the agent's resource-fingerprint check
 * has something concrete to compare future tool calls against.
 *
 * Conservative: only fires when no active focus exists AND the prior
 * session produced ≥ 2 composio_execute_tool calls against the same
 * resource (signal that it was real work, not exploratory peeking).
 * Returns the newly-created focus row, or null when nothing pinnable.
 */
function autoPinFocusFromPriorSessions(
  db: ReturnType<typeof openEventLog>,
  priorSessionIds: string[],
  newMessage?: string,
): ReturnType<typeof getActiveFocusForPrefix> | null {
  if (priorSessionIds.length === 0) return null;
  const counts = new Map<string, { kind: string; count: number; sessionId: string }>();

  for (const sid of priorSessionIds) {
    const rows = db.prepare(
      `SELECT data_json FROM events
         WHERE session_id = ? AND type = 'tool_called'
         ORDER BY seq DESC LIMIT 30`,
    ).all(sid) as Array<{ data_json: string }>;
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data_json) as { tool?: string; arguments?: string };
        if (data.tool !== 'composio_execute_tool' || typeof data.arguments !== 'string') continue;
        const inner = JSON.parse(data.arguments) as { tool_slug?: string; arguments?: string };
        const slug = inner.tool_slug ?? '';
        const argText = typeof inner.arguments === 'string' ? inner.arguments : JSON.stringify(inner.arguments ?? {});
        // Google Sheets / Docs id pattern: long alphanumeric + dashes/underscores.
        const sheetMatch = argText.match(/"spreadsheet_id"\s*:\s*"([A-Za-z0-9_-]{20,})"/);
        const docMatch = argText.match(/"document_id"\s*:\s*"([A-Za-z0-9_-]{20,})"/);
        const id = sheetMatch?.[1] ?? docMatch?.[1] ?? null;
        if (!id) continue;
        const kind = slug.toLowerCase().startsWith('googlesheets') ? 'sheet'
          : slug.toLowerCase().startsWith('googledocs') ? 'doc'
          : 'resource';
        const ref = kind === 'sheet'
          ? `https://docs.google.com/spreadsheets/d/${id}`
          : kind === 'doc'
            ? `https://docs.google.com/document/d/${id}`
            : id;
        const existing = counts.get(ref);
        if (existing) {
          existing.count += 1;
        } else {
          counts.set(ref, { kind, count: 1, sessionId: sid });
        }
      } catch { /* skip */ }
    }
  }

  // Need at least 2 hits on the same resource for it to count as
  // "real work" worth auto-pinning. Picks the most-mentioned resource.
  let best: { ref: string; kind: string; count: number; sessionId: string } | null = null;
  for (const [ref, info] of counts.entries()) {
    if (info.count < 2) continue;
    if (!best || info.count > best.count) best = { ref, ...info };
  }
  if (!best) return null;

  // Cross-session guard: don't let a stale prior-session anchor shadow a
  // resource the user's CURRENT message explicitly names. If they name a
  // DIFFERENT resource, decline to auto-pin (let the live message win, fact
  // scope stays global). If they name the SAME one, the pin is confirmed and
  // authoritative. If they name NOTHING, the pin is a guess from prior tool
  // calls — born stale (needsConfirm) so the model verifies before relying.
  const namedId = extractNamedResource(newMessage);
  const bestId = extractNamedResource(best.ref) ?? best.ref;
  if (namedId && namedId !== bestId) return null;
  const bornStale = !namedId;

  // Derive a title from the prior session's session title (which is
  // the first ~60 chars of the user's first prompt) and a summary
  // from the prior session's last conversation_completed summary.
  const sessionRow = db.prepare(
    `SELECT title FROM sessions WHERE id = ?`,
  ).get(best.sessionId) as { title?: string } | undefined;
  const lastSummaryRow = db.prepare(
    `SELECT data_json FROM events
       WHERE session_id = ? AND type = 'conversation_completed'
       ORDER BY seq DESC LIMIT 1`,
  ).get(best.sessionId) as { data_json?: string } | undefined;
  let lastSummary = '';
  try { lastSummary = String(JSON.parse(lastSummaryRow?.data_json ?? '{}')?.summary ?? '').slice(0, 300); } catch { /* ignore */ }

  const title = (sessionRow?.title ?? `Work on ${best.kind}`).slice(0, 100);
  const summary = lastSummary
    || `Continuing work on this ${best.kind} from a prior session — auto-pinned because no focus was set.`;

  try {
    return createFocusForPrefix({
      resourceRef: best.ref,
      title: `${title}`,
      summary,
      resourceKind: best.kind,
      relatedSessionId: best.sessionId,
      staleOnCreate: bornStale,
    });
  } catch {
    return null;
  }
}

/** Exposed for tests / a future /new command — drop the channel's session. */
export function clearDiscordHarnessSession(
  channelId: string,
  identity?: { channel?: string; userId: string; guildId?: string | null },
): void {
  if (identity) {
    audienceChannelSessions.delete(channelAudienceKey({
      channel: identity.channel ?? 'discord',
      channelId,
      userId: identity.userId,
      guildId: identity.guildId ?? null,
    }));
    return;
  }
  // Legacy callers without a closed audience identity may only clear the
  // legacy compatibility pointer. Principal-aware ingress must never disturb
  // another user's exact continuity pointer in the same shared channel.
  channelSessions.delete(channelId);
}

export function bindDiscordHarnessSession(input: {
  channelId: string;
  sessionId: string;
  userId?: string | null;
  guildId?: string | null;
  channel?: string;
}): boolean {
  const row = getHarnessSession(input.sessionId);
  if (!row) return false;
  const now = Date.now();
  // Exact provider principals use the audience map exclusively. Mirroring
  // them into the legacy channel-only pointer lets the last user in a shared
  // channel overwrite another user's control target.
  if (!input.userId) {
    channelSessions.set(input.channelId, { sessionId: input.sessionId, lastUsedAt: now });
  }
  const channel = (input.channel ?? row.channel ?? String(row.metadata.source ?? 'discord')).trim().toLowerCase();
  if (input.userId) {
    audienceChannelSessions.set(channelAudienceKey({
      channel,
      channelId: input.channelId,
      userId: input.userId,
      guildId: input.guildId ?? null,
    }), { sessionId: input.sessionId, lastUsedAt: now });
  }
  try {
    updateHarnessSession(input.sessionId, {
      metadata: {
        ...row.metadata,
        source: channel,
        channelId: input.channelId,
        userId: input.userId ?? row.metadata.userId ?? row.userId ?? null,
        guildId: input.guildId ?? row.metadata.guildId ?? null,
        discordChannelId: input.channelId,
        discordUserId: input.userId ?? row.metadata.discordUserId ?? null,
        discordGuildId: input.guildId ?? row.metadata.discordGuildId ?? null,
        discordBoundAt: new Date(now).toISOString(),
      },
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), sessionId: input.sessionId, channelId: input.channelId },
      'failed to persist Discord harness session binding',
    );
  }
  return true;
}

/**
 * /cancel handler — abandon paused approvals on this channel, clear
 * the session's interrupt state, mark the session 'cancelled', and
 * confirm to the user. The paused approval rows are resolved with
 * 'cancelled_by_user' so the audit log distinguishes user-driven
 * abandonment from reaper-driven expiry.
 *
 * The session row stays in the DB (we don't delete history) — just
 * its status flips and its interrupt state is cleared so the next
 * message from the user starts fresh.
 */
export async function handleHarnessCancel(opts: {
  channelId: string;
  transport: DiscordHarnessTransport;
  channel?: string;
  userId?: string;
  guildId?: string | null;
}): Promise<void> {
  const channel = opts.channel ?? 'discord';
  const audienceIdentity = opts.userId
    ? { channel, channelId: opts.channelId, userId: opts.userId, guildId: opts.guildId ?? null }
    : null;
  const entry = audienceIdentity
    ? getOrHydrateAudienceSession(audienceIdentity)
    : getOrHydrateChannelSession(opts.channelId, channel);
  if (!entry) {
    await opts.transport.sendError('Nothing to cancel — no paused session on this channel.');
    return;
  }
  const session = HarnessSession.load(entry.sessionId);
  if (!session) {
    if (audienceIdentity) audienceChannelSessions.delete(channelAudienceKey(audienceIdentity));
    if (channelSessions.get(opts.channelId)?.sessionId === entry.sessionId) channelSessions.delete(opts.channelId);
    await opts.transport.sendError('Nothing to cancel — the session is no longer available.');
    return;
  }

  // Resolve any pending registry rows for this session as cancelled_by_user.
  let cancelledCount = 0;
  for (const row of approvalRegistry.listPending({ sessionId: session.id, status: 'pending' })) {
    const result = approvalRegistry.resolve(row.approvalId, 'cancelled_by_user', `${channel}-user`);
    if (result.ok) cancelledCount++;
  }
  // Clear interrupt state + mark session cancelled. The next message
  // resolveOrCreateSession will create a fresh session because the
  // staleness check sees this one as terminal.
  try {
    session.clearInterruptState();
    session.markStatus('cancelled');
  } catch {
    /* best effort — the user-facing confirmation still goes out */
  }
  if (audienceIdentity) audienceChannelSessions.delete(channelAudienceKey(audienceIdentity));
  if (channelSessions.get(opts.channelId)?.sessionId === entry.sessionId) channelSessions.delete(opts.channelId);

  // Emit a harness event so the audit log + dashboard see the cancel.
  try {
    appendHarnessEvent({
      sessionId: session.id,
      turn: 0,
      role: 'user',
      type: 'approval_resolved',
      data: {
        decision: 'cancelled_by_user',
        approvalsCancelled: cancelledCount,
      },
    });
  } catch {
    /* best effort */
  }

  const replyBody = cancelledCount > 0
    ? `🍊 Cancelled. Abandoned ${cancelledCount} pending approval${cancelledCount === 1 ? '' : 's'} on this channel. Send a new message to start fresh.`
    : '🍊 Cancelled. Session cleared. Send a new message to start fresh.';
  try {
    const handle = await opts.transport.sendInitial(replyBody);
    // sendInitial returns a handle but we don't need to edit it — the
    // body is the final message.
    void handle;
  } catch {
    /* transport already failed once; user can re-engage if needed */
  }
}

/**
 * /new handler — drop the channel's cached session so the next
 * message creates a fresh one. The paused session (if any) stays
 * in __interrupt_state and addressable via its apr-xxxx code, but
 * the channel no longer routes incoming messages to it.
 *
 * Distinct from /cancel: /new keeps the old session reachable (for
 * later `approve apr-xxxx`); /cancel actively abandons it.
 */
export async function handleHarnessNew(opts: {
  channelId: string;
  transport: DiscordHarnessTransport;
  channel?: string;
  userId?: string;
  guildId?: string | null;
}): Promise<void> {
  const channel = opts.channel ?? 'discord';
  const audienceIdentity = opts.userId
    ? { channel, channelId: opts.channelId, userId: opts.userId, guildId: opts.guildId ?? null }
    : null;
  const entry = audienceIdentity
    ? getOrHydrateAudienceSession(audienceIdentity)
    : getOrHydrateChannelSession(opts.channelId, channel);
  if (audienceIdentity) audienceChannelSessions.delete(channelAudienceKey(audienceIdentity));
  if (entry && channelSessions.get(opts.channelId)?.sessionId === entry.sessionId) {
    channelSessions.delete(opts.channelId);
  }
  if (audienceIdentity) {
    const fresh = createHarnessSession({
      kind: 'chat',
      channel,
      userId: audienceIdentity.userId,
      title: 'Fresh conversation',
      metadata: {
        source: channel,
        channelId: audienceIdentity.channelId,
        userId: audienceIdentity.userId,
        guildId: audienceIdentity.guildId,
      },
    });
    bindDiscordHarnessSession({
      channel,
      channelId: audienceIdentity.channelId,
      sessionId: fresh.id,
      userId: audienceIdentity.userId,
      guildId: audienceIdentity.guildId,
    });
  }

  if (entry) {
    const pending = approvalRegistry.listPending({ sessionId: entry.sessionId, status: 'pending' });
    // A conversational send answer is valid only in the exact question slot.
    // Starting a fresh session abandons that slot; never preserve it as an
    // addressable apr-id capability (that surface is intentionally disabled).
    for (const row of pending.filter((candidate) => !approvalRegistry.isFormalApprovalSurface(candidate))) {
      approvalRegistry.resolve(row.approvalId, 'cancelled_by_user', `${opts.channel ?? 'discord'}-new-session`);
    }
    const formal = pending.filter(approvalRegistry.isFormalApprovalSurface);
    const addressableHint = formal.length > 0
      ? ` The paused session is still reachable via \`approve ${formal[0].approvalId}\` (or \`reject\`).`
      : '';
    await opts.transport.sendInitial(`🍊 Fresh session ready. Send your first message.${addressableHint}`);
  } else {
    await opts.transport.sendInitial('🍊 Fresh session ready. Send your first message.');
  }
}

interface DiscordSessionOption {
  session: SessionRow;
  pendingApprovals: approvalRegistry.PendingApprovalRow[];
  isBound: boolean;
  rank: number;
}

function sessionAgeLabel(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ${min % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function sessionTitle(row: SessionRow): string {
  const title = (row.title || row.objective || row.id).replace(/\s+/g, ' ').trim();
  return title.length > 72 ? `${title.slice(0, 69)}...` : title;
}

function collectDiscordSessionOptions(channelId: string, channel: string = 'discord'): DiscordSessionOption[] {
  const byId = new Map<string, DiscordSessionOption>();
  const pendingRows = approvalRegistry
    .listPending({ status: 'pending' })
    .filter((row) => approvalRegistry.isActionable(row))
    .filter(approvalRegistry.isFormalApprovalSurface);
  const pendingBySession = new Map<string, approvalRegistry.PendingApprovalRow[]>();
  for (const row of pendingRows) {
    const rows = pendingBySession.get(row.sessionId) ?? [];
    rows.push(row);
    pendingBySession.set(row.sessionId, rows);
  }

  const add = (session: SessionRow | null, rank: number, isBound = false): void => {
    if (!session) return;
    const existing = byId.get(session.id);
    const pendingApprovals = pendingBySession.get(session.id) ?? [];
    if (existing) {
      existing.rank = Math.min(existing.rank, rank);
      existing.isBound = existing.isBound || isBound;
      existing.pendingApprovals = pendingApprovals;
      return;
    }
    byId.set(session.id, { session, pendingApprovals, isBound, rank });
  };

  const memoryBound = channelSessions.get(channelId);
  if (memoryBound) add(getHarnessSession(memoryBound.sessionId), 0, true);
  const persistedBound = findMostRecentChannelSession(channelId, channel);
  if (persistedBound) add(getHarnessSession(persistedBound.sessionId), 1, true);

  for (const row of pendingRows) add(getHarnessSession(row.sessionId), 2, false);
  for (const row of listHarnessSessions({ status: ['active', 'paused'], limit: 30 })) add(row, 3, false);
  const recentCutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  for (const row of listHarnessSessions({ status: 'any', updatedAfter: recentCutoff, limit: 30 })) add(row, 4, false);

  return [...byId.values()]
    .sort((left, right) => {
      const isRecent = (option: DiscordSessionOption): boolean => {
        const ageMs = Date.now() - Date.parse(option.session.updatedAt);
        return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 4 * 60 * 60_000;
      };
      const priority = (option: DiscordSessionOption): number => {
        if (option.isBound && (isRecent(option) || option.pendingApprovals.length > 0)) return 0;
        if (option.session.kind === 'chat' && option.session.status === 'active' && isRecent(option)) return 1;
        if (option.pendingApprovals.length > 0) return 2;
        if (option.session.status === 'paused') return 3;
        if (option.isBound) return 4;
        return 5;
      };
      return (priority(left) - priority(right))
        || (left.rank - right.rank)
        || right.session.updatedAt.localeCompare(left.session.updatedAt);
    })
    .slice(0, 8);
}

function renderSessionPickerText(options: DiscordSessionOption[], channelId: string): string {
  if (options.length === 0) {
    return 'No active or recent Clementine sessions are available to attach here.';
  }
  const lines = [
    'Clementine sessions',
    'Tap **Resume here** to bind this Discord thread to the same live harness session the desktop app uses.',
    '',
  ];
  options.forEach((option, index) => {
    const approvals = option.pendingApprovals.length > 0
      ? ` · ${option.pendingApprovals.length} approval${option.pendingApprovals.length === 1 ? '' : 's'} waiting`
      : '';
    const bound = option.isBound ? ' · bound here' : '';
    const channel = option.session.channel ? ` · ${option.session.channel}` : '';
    lines.push(
      `${index + 1}. ${sessionTitle(option.session)}`
      + `\n   \`${option.session.id}\` · ${option.session.status}${channel} · ${sessionAgeLabel(option.session.updatedAt)}${approvals}${bound}`,
    );
  });
  lines.push('', `Channel: \`${channelId}\``);
  return lines.join('\n');
}

function sessionPickerComponents(options: DiscordSessionOption[]): unknown[] {
  return options.slice(0, 5).map((option, index) => {
    const components: Array<Record<string, unknown>> = [
      {
        type: 2,
        style: 1,
        label: `Resume ${index + 1}`,
        custom_id: `clementine:session-resume:${option.session.id}`,
      },
    ];
    const firstApproval = option.pendingApprovals[0];
    if (firstApproval) {
      components.push(
        { type: 2, style: 3, label: 'Approve', custom_id: `clementine:approve:${firstApproval.approvalId}` },
        { type: 2, style: 4, label: 'Reject', custom_id: `clementine:reject:${firstApproval.approvalId}` },
      );
    }
    return { type: 1, components };
  });
}

export async function handleHarnessSessions(opts: {
  channelId: string;
  userId?: string | null;
  guildId?: string | null;
  transport: DiscordHarnessTransport;
  channel?: string;
}): Promise<void> {
  const options = collectDiscordSessionOptions(opts.channelId, opts.channel ?? 'discord');
  const body = renderSessionPickerText(options, opts.channelId);
  const handle = await opts.transport.sendInitial(body);
  const components = sessionPickerComponents(options);
  if (components.length > 0) {
    await handle.edit(body, { components });
  }
}

/**
 * Detect approve / reject intent in a Discord prompt. Conservative —
 * only matches at the start of the message and only when a session
 * is actually awaiting approval. "Yes" mid-conversation when nothing
 * is pending should be treated as a regular new turn, not an approval.
 *
 * Returns `{ decision, approvalId? }` so callers can route an explicit
 * `approve apr-xy7q` (or `reject apr-xy7q`) at exactly the addressable
 * approval, instead of the legacy "most recent paused session" fallback
 * that today silently routes to the wrong session when multiple are
 * pending. The approval ID is the apr-<4 base36 chars> format minted
 * by approval-registry.ts.
 *
 * Matcher tightening (T1.2): the old permissive set (`yes|y|ok|okay`)
 * hijacked plenty of conversational messages — "yes please continue
 * the workflow" got routed as an approval. The new rule:
 *   - STRONG verbs (`approve`, `reject`, `proceed`, `go ahead`, `lgtm`,
 *     `do it`, `confirm`, `deny`, `abort`, `nevermind`, 👍/👎) match
 *     regardless of whether an apr-xxxx is present.
 *   - LOOSE verbs (`yes`, `y`, `ok`, `okay`, `no`, `n`, `sure`, etc.)
 *     ONLY match when paired with an explicit apr-xxxx code. A bare
 *     "yes" no longer reads as approval; "yes apr-26ba" does.
 *   - "cancel" is reserved for the /cancel command (parseHarnessCommand);
 *     it no longer counts as a reject so users can abandon the pause
 *     entirely instead of resolving it as rejected.
 */
export interface ParsedApprovalIntent {
  decision: 'approve' | 'reject';
  /** When the user typed `approve apr-xy7q` or `reject apr-xy7q`. */
  approvalId?: string;
}

// Strong verbs — unambiguous endorsement / rejection of an approval.
// Match at the start of the message ONLY so "I approve of that idea"
// doesn't fire when nothing is asking for approval.
//
// The emoji patterns are separate from the word patterns because
// JavaScript's `\b` (ASCII word boundary) doesn't fire around an
// emoji codepoint, so `^👍\b` never matches. Two patterns, OR'd at
// the caller, keeps each clean and well-tested.
const STRONG_APPROVE = /^(approve(d)?|proceed|go ahead|lgtm|do it|confirm(ed)?)\b/;
const STRONG_APPROVE_EMOJI = /^👍/;
const STRONG_REJECT = /^(reject(ed)?|deny|denied|abort|nevermind|never mind|not now|don'?t do (it|that))\b/;
const STRONG_REJECT_EMOJI = /^👎/;
// Loose verbs — require an apr-xxxx in the message to disambiguate
// from regular conversation. "yes apr-26ba" reads as approval; bare
// "yes" does not (it's just a conversational ack).
const LOOSE_APPROVE_WITH_ID = /^(yes|y|ok|okay|sure|sounds good|do this)\b/;
const LOOSE_REJECT_WITH_ID = /^(no|n|stop)\b/;
const APR_ID_PATTERN = /\bapr-([a-z0-9]{4})\b/;

export function parseApprovalIntent(prompt: string): ParsedApprovalIntent | null {
  const t = prompt.trim().toLowerCase();
  if (!t) return null;
  const idMatch = APR_ID_PATTERN.exec(t);
  const approvalId = idMatch ? `apr-${idMatch[1]}` : undefined;

  if (STRONG_APPROVE.test(t) || STRONG_APPROVE_EMOJI.test(t)) {
    return approvalId ? { decision: 'approve', approvalId } : { decision: 'approve' };
  }
  if (STRONG_REJECT.test(t) || STRONG_REJECT_EMOJI.test(t)) {
    return approvalId ? { decision: 'reject', approvalId } : { decision: 'reject' };
  }
  // Loose verbs only count when an apr-xxxx code is also present —
  // that's the explicit signal "yes I mean THIS approval".
  if (approvalId && LOOSE_APPROVE_WITH_ID.test(t)) {
    return { decision: 'approve', approvalId };
  }
  if (approvalId && LOOSE_REJECT_WITH_ID.test(t)) {
    return { decision: 'reject', approvalId };
  }
  return null;
}

/**
 * Slash-style command parser for harness-channel control. Distinct
 * from parseApprovalIntent so the two surfaces don't bleed into each
 * other — `cancel` used to count as a reject, which conflated
 * "abandon this whole session" with "say no to the specific tool the
 * bot asked permission for." Now `/cancel` is its own thing.
 *
 * Recognized:
 *   /cancel     — abandon the paused approval(s) on this channel,
 *                 clear the session's interrupt state, mark the
 *                 session 'cancelled'. Frees the channel for a fresh
 *                 turn.
 *   /new        — start a fresh session on this channel ignoring any
 *                 paused one. The paused session stays addressable
 *                 via its apr-xxxx code for later.
 *
 * Accepts both `/cancel` and bare `cancel` / `new` on a line by
 * itself, so the user doesn't need to know the prefix.
 */
export type HarnessCommand = 'cancel' | 'new' | 'continue' | 'sessions';
export function parseHarnessCommand(prompt: string): HarnessCommand | null {
  const t = prompt.trim().toLowerCase();
  if (t === '/cancel' || t === 'cancel') return 'cancel';
  if (t === '/new' || t === 'new') return 'new';
  if (t === '/sessions' || t === 'sessions' || t === '/session' || t === 'session') return 'sessions';
  // /continue (T1.3 graceful continue) — the loop emits a "Reply
  // `continue` to keep going" message when it hits a step or wall-clock
  // limit. Honor a bare `continue` or `keep going` so the user can
  // resume long-running work without re-typing the original request.
  if (/^\/?(?:continue|keep going)[.!?]*$/.test(t)) return 'continue';
  return null;
}

/**
 * Find the most recent `conversation_completed` event for a session.
 * Used by the /continue path to inspect whether the session ended on
 * a continue/limit completion and to extract the last orchestrator
 * summary as continuation context.
 */
export function readLastConversationCompletion(sessionId: string): {
  reason?: string;
  limitKind?: string;
  lastDecisionSummary?: string;
} | null {
  try {
    const db = openEventLog();
    const row = db
      .prepare(`SELECT data_json FROM events WHERE session_id = ? AND type = 'conversation_completed' ORDER BY seq DESC LIMIT 1`)
      .get(sessionId) as { data_json: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.data_json) as Record<string, unknown>;
    return {
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
      limitKind: typeof parsed.limitKind === 'string' ? parsed.limitKind : undefined,
      lastDecisionSummary: typeof parsed.lastDecisionSummary === 'string' ? parsed.lastDecisionSummary : undefined,
    };
  } catch {
    return null;
  }
}

// The continue directive is host infrastructure shared by the human resume
// path (here + console) and the never-resting auto-resume in the bridge; one
// author lives in continue-directive.ts. Re-exported for existing importers.
import { isContinueCompletionReason } from '../runtime/harness/continue-directive.js';
export { isContinueCompletionReason };

/**
 * True if the harness session for this channel is currently paused
 * awaiting approval. Hydrates from SQLite if the in-memory map was
 * cleared (e.g. by a daemon restart) so the durable interrupt state
 * stays addressable through "approve" / "reject" replies.
 */
export function isChannelSessionAwaitingApproval(
  channelId: string,
  channel: string = 'discord',
  userId?: string,
  guildId: string | null = null,
): boolean {
  const entry = userId
    ? getOrHydrateAudienceSession({ channel, channelId, userId, guildId })
    : getOrHydrateChannelSession(channelId, channel);
  if (!entry) return false;
  const sess = HarnessSession.load(entry.sessionId);
  return !!sess && !!sess.loadInterruptState();
}

// True when an approval row originated from the given chat channel. Slack
// approvals are tagged 'slack'/'slack-dm', Discord's 'discord'/'discord-dm'.
function isDiscordApproval(row: approvalRegistry.PendingApprovalRow, channel: string = 'discord'): boolean {
  return row.channel === channel || row.channel === `${channel}-dm`;
}

/** Gate-unification Step 5 kill-switch. Off ⇒ a typed "yes/approve" no longer
 *  resolves a surfaced PlanProposal (reverts to the button-only behavior). */
function typedPlanApprovalEnabled(): boolean {
  return (process.env.CLEMMY_TYPED_PLAN_APPROVAL ?? 'on').toLowerCase() !== 'off';
}

/**
 * Typed consent into the goal contract (gate-unification Step 5). A surfaced
 * PlanProposal could be approved ONLY via the button / dashboard — typing
 * "yes, go" after Clem surfaced a plan matched NOTHING (the approval router
 * resolves only apr- registry rows) and became a fresh chat turn. That was a
 * dead-end the user hit. If the user typed an approve/reject AND a plan is
 * pending for this channel's session, resolve it here.
 *
 * Registry (apr-) approvals are handled BEFORE this and a specific `apr-` id
 * never reaches here (we ignore an intent that carries an approvalId), so this
 * can never shadow a registry row. Returns 'approved' | 'rejected' | null
 * (no pending plan / not an approval phrase / disabled).
 */
export function maybeResolvePendingPlanProposal(
  channelId: string,
  prompt: string,
  channel: string = 'discord',
  userId?: string,
  guildId: string | null = null,
): 'approved' | 'rejected' | null {
  if (!typedPlanApprovalEnabled()) return null;
  const intent = parseApprovalIntent(prompt);
  // An intent carrying an apr- id is a registry approval, not a plan approval.
  if (!intent || intent.approvalId) return null;
  const entry = userId
    ? getOrHydrateAudienceSession({ channel, channelId, userId, guildId })
    : getOrHydrateChannelSession(channelId, channel);
  if (!entry) return null;
  let pending: ReturnType<typeof listPlanProposals>;
  try {
    pending = listPlanProposals({ sessionId: entry.sessionId, status: 'pending' })
      .filter((p) => (p.kind ?? 'plan') === 'plan');
  } catch {
    return null;
  }
  if (pending.length === 0) return null;
  const target = pending[0]; // newest-first
  try {
    if (intent.decision === 'approve') {
      return approvePlanProposal(target.id) ? 'approved' : null;
    }
    return rejectPlanProposal(target.id, 'rejected via chat') ? 'rejected' : null;
  } catch {
    return null;
  }
}

function approvalBelongsToDiscordChannel(
  row: approvalRegistry.PendingApprovalRow,
  channelId: string,
  channel: string = 'discord',
): boolean {
  if (!approvalRegistry.isActionable(row)) return false;
  return approvalOriginMatchesDiscordChannel(row, channelId, channel);
}

/**
 * Prove the chat origin independently from whether the approval is still
 * actionable. Explicit replies to expired/already-resolved cards still need a
 * durable needs-input terminal in the correct conversation, but they must
 * never borrow the session from a different channel.
 */
function approvalOriginMatchesDiscordChannel(
  row: approvalRegistry.PendingApprovalRow,
  channelId: string,
  channel: string = 'discord',
): boolean {
  if (!isDiscordApproval(row, channel)) return false;
  if (row.channelId) return row.channelId === channelId;

  // Legacy rows created before channel_id was populated may still be
  // valid, but only if they are the currently-hydrated paused session
  // for this channel. This keeps pre-migration approvals usable
  // without letting old approvals from another thread bleed in.
  const entry = getOrHydrateChannelSession(channelId, channel);
  return entry?.sessionId === row.sessionId;
}

/** Provider-originated approval discovery is private to the exact audience.
 * A channel id alone is not an authority boundary in a shared guild/thread.
 * Explicit IDs may still address an older detached session after `/new`, but
 * only when that target carries the same closed provider/scope/conversation/
 * audience identity. */
function approvalTargetMatchesAudience(input: {
  row: approvalRegistry.PendingApprovalRow;
  channelId: string;
  channel: string;
  userId: string;
  scopeId: string | null;
}): boolean {
  const lineage = resolveAcceptedSourceIngressLineage({
    sessionId: input.row.sessionId,
    provider: input.channel,
    scopeId: input.scopeId,
    audienceId: input.userId,
  });
  return lineage?.conversationId === input.channelId;
}

function pendingApprovalsForAudience(input: {
  channelId: string;
  channel: string;
  userId: string;
  scopeId: string | null;
}): approvalRegistry.PendingApprovalRow[] {
  return pendingDiscordApprovalsForChannel(input.channelId, input.channel)
    .filter((row) => approvalTargetMatchesAudience({ row, ...input }));
}

function pendingDiscordApprovalsForChannel(channelId: string, channel: string = 'discord'): approvalRegistry.PendingApprovalRow[] {
  return approvalRegistry
    .listPending({ status: 'pending' })
    .filter(approvalRegistry.isFormalApprovalSurface)
    .filter((row) => approvalBelongsToDiscordChannel(row, channelId, channel));
}

function approvalSessionTargetsChannel(
  row: approvalRegistry.PendingApprovalRow,
  channelId: string,
  channel: string,
): boolean {
  if (isDiscordApproval(row, channel)) {
    return approvalOriginMatchesDiscordChannel(row, channelId, channel);
  }
  const session = getHarnessSession(row.sessionId);
  const metadata = session?.metadata ?? {};
  if (channel === 'discord') {
    return metadata.channelId === channelId || metadata.discordChannelId === channelId;
  }
  if (channel === 'slack') {
    return metadata.channelId === channelId || metadata.slackChannelId === channelId;
  }
  return metadata.channelId === channelId;
}

/**
 * A bare conversational yes/no can authorize only one exact, frozen send in
 * this conversation. Search all durable rows related to the channel (including
 * direct Claude-SDK rows whose legacy channel columns are null), then require
 * a sole eligible row. Any sibling approval keeps the answer ambiguous and no
 * authority is selected.
 */
function soleAutonomousSendConsentApproval(
  channelId: string,
  channel: string,
  userId: string,
  conversationKey: string,
): approvalRegistry.PendingApprovalRow | null {
  const rows = approvalRegistry
    .listPending({ status: 'pending' })
    .filter((row) => approvalRegistry.isActionable(row))
    .filter((row) => approvalSessionTargetsChannel(row, channelId, channel));
  if (rows.length !== 1) return null;
  const row = rows[0];
  const presentation = row.presentation;
  if (
    !presentation
    || !presentation.presentedAt
    || !presentation.promptEventId
    || !presentation.promptEventSeq
    || presentation.responseSourceUserSeq !== null
    || presentation.responseUserId !== null
    || presentation.audienceUserId !== userId
    || presentation.conversationKey !== conversationKey
  ) return null;
  // A later visible question owns the next answer slot. Legacy check-ins do not
  // yet carry provider conversation identity, so fail closed only for ones
  // asked after this send question was actually delivered. Older/stale open
  // files (including a clarification already consumed by continuity) cannot
  // strand a newly-presented exact send consent.
  const presentedAt = Date.parse(presentation.presentedAt);
  if (listActionableCheckIns().some((checkIn) => {
    const askedAt = Date.parse(checkIn.askedAt);
    return !Number.isFinite(presentedAt) || !Number.isFinite(askedAt) || askedAt > presentedAt;
  })) return null;
  // Any later answer-slot event in this exact harness session supersedes P,
  // even if it came from background/clarification work before another user
  // input. Bare Yes must never answer an older send question still on disk.
  const promptEventSeq = presentation.promptEventSeq;
  const laterQuestion = listHarnessEvents(row.sessionId, {
    types: ['awaiting_user_input'],
    sinceSeq: promptEventSeq,
  }).some((event) => event.seq > promptEventSeq);
  if (laterQuestion) return null;
  // Only the immediate next accepted real input can own this slot. A prior
  // reply means the frozen version is stale even if it was not yes/no.
  const intervening = listHarnessEvents(row.sessionId, {
    types: ['user_input_received'],
    sinceSeq: promptEventSeq,
  }).some((event) => event.data.synthetic !== true);
  return intervening ? null : row;
}

function addressedAutonomousSendConsentApproval(
  channelId: string,
  channel: string,
  userId: string,
  conversationKey: string,
): approvalRegistry.PendingApprovalRow | null {
  const rows = approvalRegistry
    .listPending({ status: 'pending' })
    .filter((row) => approvalRegistry.isActionable(row))
    .filter((row) => approvalSessionTargetsChannel(row, channelId, channel));
  if (rows.length !== 1) return null;
  const presentation = rows[0].presentation;
  return presentation
    && presentation.presentedAt
    && presentation.promptEventId
    && presentation.promptEventSeq
    && presentation.responseSourceUserSeq === null
    && presentation.responseUserId === null
    && presentation.audienceUserId === userId
    && presentation.conversationKey === conversationKey
    ? rows[0]
    : null;
}

function recoverableAutonomousSendConsentApproval(input: {
  channelId: string;
  channel: string;
  userId: string;
  conversationKey: string;
  runId: string;
  decision: 'approve' | 'reject';
}): approvalRegistry.PendingApprovalRow | null {
  const matches = approvalRegistry.listPending({ status: 'pending' })
    .filter((row) => approvalRegistry.isActionable(row))
    .filter((row) => approvalSessionTargetsChannel(row, input.channelId, input.channel))
    .filter((row) => {
      const tagged = approvalRegistry.taggedConversationalApprovalReply(row);
      return tagged?.runId === input.runId
        && tagged.userId === input.userId
        && tagged.conversationKey === input.conversationKey
        && tagged.decision === input.decision;
    });
  return matches.length === 1 ? matches[0] : null;
}

async function handleAutonomousSendConsentReply(input: {
  row: approvalRegistry.PendingApprovalRow;
  decision: 'approve' | 'reject';
  prompt: string;
  userId: string;
  conversationKey: string;
  durableRequest: DurableChannelRequest;
  transport: DiscordHarnessTransport;
  channel: string;
}): Promise<boolean> {
  const accepted = acceptDurableConversationalControl({
    durableRequest: input.durableRequest,
    sessionId: input.row.sessionId,
    displayText: input.prompt,
    approvalId: input.row.approvalId,
    decision: input.decision,
    userId: input.userId,
    conversationKey: input.conversationKey,
  });
  if (accepted.replayText) {
    await input.transport.sendInitial(accepted.replayText);
    return true;
  }
  const resolved = approvalRegistry.resolveConversationalApprovalReply({
    approvalId: input.row.approvalId,
    sourceUserSeq: accepted.source.seq,
    userId: input.userId,
    conversationKey: input.conversationKey,
    decision: input.decision,
    resolver: `${input.channel}-conversation`,
  });
  if (!resolved.ok || !resolved.row) {
    const text = settleDurableApprovalControl(
      accepted,
      'I did not authorize that send because this reply no longer matches the exact question, person, or conversation. The prepared version remains unsent.',
      'needs_input',
    );
    await input.transport.sendInitial(text);
    return true;
  }

  if (input.decision === 'reject') {
    const text = settleDurableApprovalControl(
      accepted,
      `I left the exact ${resolved.row.presentation?.actionLabel ?? 'message'} unsent.`,
      'done',
    );
    await input.transport.sendInitial(text);
    return true;
  }

  // The shared host recovery machine owns execution and B's terminal. It also
  // projects executing/executed/failed crash states without redispatch.
  await settleConversationalApprovalDecision(resolved.row);
  const outcome = acceptedChannelOutcome(accepted.source);
  await input.transport.sendInitial(outcome?.text
    ?? 'I recorded your decision for that exact version. Its protected execution state is being reconciled; I will not dispatch a duplicate.');
  return true;
}

function exactBareApprovalCandidate(
  rows: approvalRegistry.PendingApprovalRow[],
): approvalRegistry.PendingApprovalRow | null {
  return rows.length === 1 ? rows[0] : null;
}

function globalApprovalRowsForDm(
  channelId: string,
  channel: string = 'discord',
  userId?: string,
  scopeId: string | null = null,
): approvalRegistry.PendingApprovalRow[] {
  const boundSessionId = userId
    ? getOrHydrateAudienceSession({ channelId, channel, userId, guildId: scopeId })?.sessionId ?? null
    : getOrHydrateChannelSession(channelId, channel)?.sessionId ?? null;
  const activeSessionIds = new Set(resolveActiveDiscordHarnessRuns({
    channelId,
    channel,
    userId,
    guildId: scopeId,
  }).map((run) => run.sessionId));
  if (boundSessionId) activeSessionIds.add(boundSessionId);
  return approvalRegistry
    .listPending({ status: 'pending' })
    .filter(approvalRegistry.isFormalApprovalSurface)
    .filter((row) => {
      if (!approvalRegistry.isActionable(row)) return false;
      if (isDiscordApproval(row, channel)) {
        return userId
          ? approvalTargetMatchesAudience({ row, channelId, channel, userId, scopeId })
          : approvalBelongsToDiscordChannel(row, channelId, channel);
      }
      if (activeSessionIds.has(row.sessionId)) return true;

      // A workflow/background approval is relevant only when its durable run is
      // linked back to this exact chat. The old `!isDiscordApproval => true`
      // rule let a lone approval from any other channel swallow a DM's "abort".
      const linkedTask = listBackgroundTasks().find((task) => {
        if (task.runSessionId !== row.sessionId) return false;
        if (boundSessionId && task.originSessionId === boundSessionId) return true;
        if (task.channel === `${channel}:${channelId}` || task.channel === `${channel}:dm:${channelId}`) return true;
        const target = task.reportBackTarget;
        if (channel === 'discord' && target?.type === 'discord_channel') return target.channelId === channelId;
        if (channel === 'slack' && target?.type === 'slack_channel') return target.channelId === channelId;
        return false;
      });
      if (linkedTask) return true;

      const session = getHarnessSession(row.sessionId);
      const metadata = session?.metadata ?? {};
      return metadata.channelId === channelId
        || metadata.discordChannelId === channelId
        || metadata.slackChannelId === channelId;
    });
}

function approvalPickerComponents(rows: approvalRegistry.PendingApprovalRow[]): unknown[] {
  return rows.slice(0, 5).map((row) => ({
    type: 1,
    components: [
      { type: 2, style: 3, label: `Approve ${row.approvalId}`, custom_id: `clementine:approve:${row.approvalId}` },
      { type: 2, style: 4, label: `Reject ${row.approvalId}`, custom_id: `clementine:reject:${row.approvalId}` },
    ],
  }));
}

function approvalPickerText(
  rows: approvalRegistry.PendingApprovalRow[],
  decision: 'approve' | 'reject',
): string {
  const verb = decision === 'approve' ? 'approve' : 'reject';
  return [
    `I found ${rows.length} pending approval${rows.length === 1 ? '' : 's'}. Pick the one you mean:`,
    '',
    ...rows.slice(0, 5).map((row) => `- \`${row.approvalId}\` — ${row.subject}`),
    ...(rows.length > 5 ? [`- +${rows.length - 5} more in the Approvals panel`] : []),
    '',
    `Tap a button below, or reply \`${verb} apr-xxxx\`.`,
  ].join('\n');
}

async function sendApprovalPicker(
  transport: DiscordHarnessTransport,
  rows: approvalRegistry.PendingApprovalRow[],
  decision: 'approve' | 'reject',
): Promise<void> {
  const body = approvalPickerText(rows, decision);
  const handle = await transport.sendInitial(body);
  const components = approvalPickerComponents(rows);
  if (components.length > 0) {
    await handle.edit(body, { components });
  }
}

export const __test__ = {
  resolveOrCreateSessionForTest: resolveOrCreateSession,
  createChannelConversationPreambleDelivery,
  approvalBelongsToDiscordChannel,
  approvalComponentsForState,
  approvalPickerComponents,
  approvalPickerText,
  collectDiscordSessionOptions,
  exactBareApprovalCandidate,
  findMostRecentChannelSession,
  globalApprovalRowsForDm,
  isDiscordTokenExpired,
  maybeRouteParkedBackgroundReply,
  shouldStreamLiveTextToMessage,
  createDiscordBridgeChunkStreamer,
  renderBody,
  renderFullBody,
  renderSessionPickerText,
  sessionPickerComponents,
  registerActiveChannelRunForTest: registerActiveChannelRun,
  unregisterActiveChannelRunForTest: unregisterActiveChannelRun,
  recordActiveChannelUserInputForTest: recordActiveChannelUserInput,
  progressPresentationForSessionForTest: progressPresentationForSession,
  commitDiscordAnswerForTest: commitDiscordAnswer,
  acceptedChannelOutcome,
  seedCrossSessionPrefixForTest(input: {
    newSessionId: string;
    channelId: string;
    userId: string;
    now: number;
    newMessage?: string;
    channel?: string;
    priorWorkObjective?: string;
  }): Promise<void> {
    return seedCrossSessionPrefix(
      input.newSessionId,
      input.channelId,
      input.userId,
      input.now,
      input.newMessage,
      input.channel ?? 'discord',
      input.priorWorkObjective ?? input.newMessage ?? '',
    );
  },
  historicalPriorWorkSourcesForTest(input: {
    newSessionId: string;
    channelId: string;
    userId: string;
    channel: string;
    now: number;
  }): RelevantPriorWorkSource[] {
    return historicalPriorWorkSources(openEventLog(), input);
  },
  applyEventToAcceptedChannelState,
  createChannelProgressLane,
  channelActivityForState,
  channelTerminalForState,
  tryHandleBackgroundItControl,
  /** Inject a fresh channel→session mapping (Step 5 typed-plan-approval tests). */
  setChannelSessionForTest(channelId: string, sessionId: string): void {
    channelSessions.set(channelId, { sessionId, lastUsedAt: Date.now() });
  },
};

/**
 * Discord-channel-side approval router. Called BEFORE the v0.2
 * `handleDiscordRestCommand` / `handleDiscordCommand` paths so the
 * v0.2 `resolveNaturalApproval` resolver doesn't intercept the
 * user's "approve" / "reject" — the v0.2 approval store knows
 * nothing about the harness's pending interruption and replies with
 * "No pending approval is waiting".
 *
 * Returns true if the prompt was an approval intent AND a harness
 * session was paused for this channel. In that case the resume has
 * been kicked off and the caller should NOT continue to the v0.2
 * gateway path.
 */
export async function tryHandleHarnessApprovalReply(opts: {
  channelId: string;
  prompt: string;
  transport: DiscordHarnessTransport;
  allowGlobalApprovalFallback?: boolean;
  /** Originating chat channel (default 'discord'). Slack passes 'slack' so
   *  approval matching + resume target the right channel's sessions. */
  channel?: string;
  durableRequest?: DurableChannelRequest;
  /** Synthetic stop→reject routing uses approval semantics only when a card
   *  actually exists; otherwise the caller must continue to its stop control. */
  onlyIfApprovalPending?: boolean;
  /** Exact provider human and conversation for ordinary-question consent.
   * Formal card/button routes intentionally do not depend on these fields. */
  userId?: string;
  scopeId?: string | null;
  conversationKey?: string;
}): Promise<boolean> {
  const channel = opts.channel ?? 'discord';
  const conversationalDecision = parseAutonomousSendConsentReply(opts.prompt);
  const addressedConversation = opts.userId && opts.conversationKey
    ? addressedAutonomousSendConsentApproval(
        opts.channelId,
        channel,
        opts.userId,
        opts.conversationKey,
      )
    : null;
  if (
    conversationalDecision
    && opts.userId
    && opts.conversationKey
    && opts.durableRequest
  ) {
    const row = recoverableAutonomousSendConsentApproval({
      channelId: opts.channelId,
      channel,
      userId: opts.userId,
      conversationKey: opts.conversationKey,
      runId: opts.durableRequest.runId,
      decision: conversationalDecision,
    }) ?? soleAutonomousSendConsentApproval(
      opts.channelId, channel, opts.userId, opts.conversationKey,
    );
    if (row) {
      return handleAutonomousSendConsentReply({
        row,
        decision: conversationalDecision,
        prompt: opts.prompt,
        userId: opts.userId,
        conversationKey: opts.conversationKey,
        durableRequest: opts.durableRequest,
        transport: opts.transport,
        channel,
      });
    }
  }
  // The first addressed reply consumes the slot even when it changes the
  // subject/body or answers another visible check-in. Cancel the old frozen
  // capability before the message falls through as an ordinary new task; a
  // later bare Yes can never send the stale version.
  if (addressedConversation) {
    approvalRegistry.resolve(
      addressedConversation.approvalId,
      'cancelled_by_user',
      `${channel}-conversation-changed`,
    );
  }
  let intent = parseApprovalIntent(opts.prompt);
  if (!intent) return false;
  // T-WF-1 addendum: when the user types `approve apr-xxxx`, the
  // approval may belong to a WORKFLOW session that isn't bound to
  // their current Discord channel (workflow sessions have channel
  // 'workflow', not the Discord channel id). The legacy gate
  // `isChannelSessionAwaitingApproval` returns false in that case
  // and the message falls through to a fresh turn — leaving the
  // workflow's polling loop never seeing the resolution.
  //
  // If the user supplied an approval ID AND the registry has it
  // pending, either resume the paused Discord session (interactive
  // harness chat) or resolve it directly (workflow/cron-style harness
  // sessions that are waiting in a polling loop).
  if (intent.approvalId) {
    const row = approvalRegistry.get(intent.approvalId);
    if (!row) {
      await settleApprovalRoutingReply({
        durableRequest: opts.durableRequest,
        channelId: opts.channelId,
        channel,
        prompt: opts.prompt,
        decision: intent.decision,
        approvalId: intent.approvalId,
        transport: opts.transport,
        text: `No pending approval matches \`${intent.approvalId}\`. It may have already been resolved or expired.`,
        status: 'needs_input',
      });
      return true;
    }
    if (
      opts.userId
      && isDiscordApproval(row, channel)
      && !approvalTargetMatchesAudience({
        row,
        channelId: opts.channelId,
        channel,
        userId: opts.userId,
        scopeId: opts.scopeId ?? null,
      })
    ) {
      await settleApprovalRoutingReply({
        durableRequest: opts.durableRequest,
        channelId: opts.channelId,
        channel,
        userId: opts.userId,
        scopeId: opts.scopeId ?? null,
        prompt: opts.prompt,
        decision: intent.decision,
        approvalId: row.approvalId,
        transport: opts.transport,
        text: `Approval \`${row.approvalId}\` belongs to a different or stale conversation.`,
        status: 'needs_input',
      });
      return true;
    }
    if (row.presentation) {
      await settleApprovalRoutingReply({
        durableRequest: opts.durableRequest,
        channelId: opts.channelId,
        channel,
        prompt: opts.prompt,
        decision: intent.decision,
        approvalId: row.approvalId,
        candidateRows: [row],
        transport: opts.transport,
        text: 'That protected send is not a formal approval card and cannot be authorized by ID or from another surface. Answer the ordinary question in its original conversation; if that reply slot changed, ask me to prepare the send again.',
        status: 'needs_input',
      });
      return true;
    }
    const matchesDiscordOrigin = approvalOriginMatchesDiscordChannel(row, opts.channelId, channel);
    const canResumeInDiscord = approvalBelongsToDiscordChannel(row, opts.channelId, channel);
    if (isDiscordApproval(row, channel) && !matchesDiscordOrigin) {
      await settleApprovalRoutingReply({
        durableRequest: opts.durableRequest,
        channelId: opts.channelId,
        channel,
        prompt: opts.prompt,
        decision: intent.decision,
        approvalId: row.approvalId,
        transport: opts.transport,
        text: `Approval \`${row.approvalId}\` belongs to a different or stale conversation.`,
        status: 'needs_input',
      });
      return true;
    }
    if (row.status !== 'pending') {
      await settleApprovalRoutingReply({
        durableRequest: opts.durableRequest,
        channelId: opts.channelId,
        channel,
        prompt: opts.prompt,
        decision: intent.decision,
        approvalId: row.approvalId,
        candidateRows: (!isDiscordApproval(row, channel) || approvalOriginMatchesDiscordChannel(row, opts.channelId, channel))
          ? [row]
          : undefined,
        transport: opts.transport,
        text: `Approval \`${row.approvalId}\` was already ${row.status}${row.resolution ? ` (${row.resolution})` : ''}.`,
        status: 'needs_input',
      });
      return true;
    }
    if (approvalRegistry.isExpired(row)) {
      const acceptedControl = acceptDurableApprovalControl({
        durableRequest: opts.durableRequest,
        sessionId: row.sessionId,
        displayText: opts.prompt,
        approvalId: row.approvalId,
        decision: intent.decision,
      });
      if (acceptedControl?.replayText) {
        await opts.transport.sendInitial(acceptedControl.replayText);
        return true;
      }
      approvalRegistry.resolve(row.approvalId, 'expired', `${channel}-user`);
      const text = settleDurableApprovalControl(
        acceptedControl,
        `Approval \`${row.approvalId}\` has expired. Re-ask and I'll redo that work.`,
        'needs_input',
      );
      await opts.transport.sendInitial(text);
      return true;
    }
    if (canResumeInDiscord && isChannelSessionAwaitingApproval(
      opts.channelId,
      channel,
      opts.userId,
      opts.scopeId ?? null,
    )) {
      await runDiscordHarnessResume({
        channelId: opts.channelId,
        decision: intent.decision,
        approvalId: intent.approvalId,
        userText: opts.prompt,
        transport: opts.transport,
        channel,
        durableRequest: opts.durableRequest,
        userId: opts.userId,
        guildId: opts.scopeId ?? null,
      });
      return true;
    }

    const detachedSession = HarnessSession.load(row.sessionId);
    if (row.channel !== 'workflow' && detachedSession?.loadInterruptState()) {
      await runDiscordHarnessResume({
        channelId: opts.channelId,
        decision: intent.decision,
        approvalId: intent.approvalId,
        userText: opts.prompt,
        transport: opts.transport,
        allowDetachedNonDiscord: true,
        channel,
        durableRequest: opts.durableRequest,
        userId: opts.userId,
        guildId: opts.scopeId ?? null,
      });
      return true;
    }

    // Background tasks park the SDK run and need a QUEUED continuation — a
    // direct registry resolve strands the task at awaiting_approval forever
    // (live 2026-07-23: the owner approved apr-cunr from Discord in 23s and
    // the 120-account run sat stranded for 10+ minutes). Same branch the
    // Tasks-board route has had since the P0 parking wave.
    const acceptedControl = acceptDurableApprovalControl({
      durableRequest: opts.durableRequest,
      sessionId: row.sessionId,
      displayText: opts.prompt,
      approvalId: row.approvalId,
      decision: intent.decision,
    });
    if (acceptedControl?.replayText) {
      await opts.transport.sendInitial(acceptedControl.replayText);
      return true;
    }
    const queuedTask = intent.decision === 'approve' || intent.decision === 'reject'
      ? queueBackgroundTaskApprovalResolution(row.approvalId, intent.decision === 'approve')
      : null;
    if (queuedTask) {
      const text = settleDurableApprovalControl(
        acceptedControl,
        `🍊 ${intent.decision === 'approve' ? 'approved' : 'rejected'} \`${row.approvalId}\` — ${row.subject}. Task ${queuedTask.id} resumes now and will report back when done.`,
      );
      try {
        await opts.transport.sendInitial(text);
      } catch { /* transport is best-effort */ }
      return true;
    }
    const resolution = intent.decision === 'approve' ? 'approved' : 'rejected';
    const result = approvalRegistry.resolve(row.approvalId, resolution, `${channel}-user`);
    const text = settleDurableApprovalControl(
      acceptedControl,
      result.ok
        ? `🍊 ${resolution === 'approved' ? 'approved' : 'rejected'} \`${row.approvalId}\` — ${row.subject}`
        : `Couldn't resolve \`${row.approvalId}\`: ${result.reason ?? 'unknown'}`,
    );
    try {
      await opts.transport.sendInitial(text);
    } catch { /* transport is best-effort */ }
    return true;
  }
  if (opts.allowGlobalApprovalFallback) {
    const rows = globalApprovalRowsForDm(
      opts.channelId,
      channel,
      opts.userId,
      opts.scopeId ?? null,
    );
    if (rows.length === 1) {
      const row = rows[0];
      const detachedSession = HarnessSession.load(row.sessionId);
      if (!isDiscordApproval(row, channel) && row.channel !== 'workflow' && detachedSession?.loadInterruptState()) {
        await runDiscordHarnessResume({
          channelId: opts.channelId,
          decision: intent.decision,
          approvalId: row.approvalId,
          userText: opts.prompt,
          transport: opts.transport,
          allowDetachedNonDiscord: true,
          channel,
          durableRequest: opts.durableRequest,
          userId: opts.userId,
          guildId: opts.scopeId ?? null,
        });
        return true;
      }
      // Background tasks park the SDK run and need a QUEUED continuation — a
      // direct registry resolve strands the task at awaiting_approval forever
      // (live 2026-07-23: the owner approved apr-cunr from Discord in 23s and
      // the 120-account run sat stranded for 10+ minutes). Same branch the
      // Tasks-board route has had since the P0 parking wave.
      const acceptedControl = acceptDurableApprovalControl({
        durableRequest: opts.durableRequest,
        sessionId: row.sessionId,
        displayText: opts.prompt,
        approvalId: row.approvalId,
        decision: intent.decision,
      });
      if (acceptedControl?.replayText) {
        await opts.transport.sendInitial(acceptedControl.replayText);
        return true;
      }
      const queuedTask = intent.decision === 'approve' || intent.decision === 'reject'
        ? queueBackgroundTaskApprovalResolution(row.approvalId, intent.decision === 'approve')
        : null;
      if (queuedTask) {
        const text = settleDurableApprovalControl(
          acceptedControl,
          `🍊 ${intent.decision === 'approve' ? 'approved' : 'rejected'} \`${row.approvalId}\` — ${row.subject}. Task ${queuedTask.id} resumes now and will report back when done.`,
        );
        try {
          await opts.transport.sendInitial(text);
        } catch { /* transport is best-effort */ }
        return true;
      }
      const resolution = intent.decision === 'approve' ? 'approved' : 'rejected';
      const result = approvalRegistry.resolve(row.approvalId, resolution, `${channel}-user`);
      const text = settleDurableApprovalControl(
        acceptedControl,
        result.ok
          ? `🍊 ${resolution === 'approved' ? 'approved' : 'rejected'} \`${row.approvalId}\` — ${row.subject}`
          : `Couldn't resolve \`${row.approvalId}\`: ${result.reason ?? 'unknown'}`,
      );
      try {
        await opts.transport.sendInitial(text);
      } catch { /* transport is best-effort */ }
      return true;
    }
    if (rows.length > 1) {
      if (opts.durableRequest) {
        await settleApprovalRoutingReply({
          durableRequest: opts.durableRequest,
          channelId: opts.channelId,
          channel,
          prompt: opts.prompt,
          decision: intent.decision,
          candidateRows: rows,
          transport: opts.transport,
          text: approvalPickerText(rows, intent.decision),
          status: 'needs_input',
        });
      } else {
        await sendApprovalPicker(opts.transport, rows, intent.decision);
      }
      return true;
    }
  }
  if (!isChannelSessionAwaitingApproval(
    opts.channelId,
    channel,
    opts.userId,
    opts.scopeId ?? null,
  )) {
    if (opts.onlyIfApprovalPending) return false;
    // NOTHING IS PENDING, SO THIS WAS NEVER AN APPROVAL. Without an explicit
    // apr-id, "go ahead" / "do it" / "proceed" is ordinary conversation —
    // overwhelmingly the user answering Clem's own question ("Reply 'go
    // ahead' and I'll run it"). Refusing it with "no pending approval is
    // waiting" answered a question nobody asked and dropped the real
    // instruction on the floor (live 2026-08-12, Discord). Fall through to
    // the normal turn: the approval router only owns messages that resolve
    // a card that actually exists.
    if (!intent.approvalId) return false;
    await settleApprovalRoutingReply({
      durableRequest: opts.durableRequest,
      channelId: opts.channelId,
      channel,
      prompt: opts.prompt,
      decision: intent.decision,
      approvalId: intent.approvalId,
      transport: opts.transport,
      text: `No pending approval matches \`${intent.approvalId}\` in this conversation.`,
      status: 'needs_input',
    });
    return true;
  }
  await runDiscordHarnessResume({
    channelId: opts.channelId,
    decision: intent.decision,
    approvalId: intent.approvalId,
    userText: opts.prompt,
    transport: opts.transport,
    channel,
    durableRequest: opts.durableRequest,
    userId: opts.userId,
    guildId: opts.scopeId ?? null,
  });
  return true;
}

/**
 * Abstraction over "where do we send the placeholder and where do we
 * edit it as progress arrives." The two Discord paths into the harness
 * need different transports:
 *
 *   - Gateway path: real Discord.js Message — uses message.reply +
 *     reply.edit. Used when the bot is connected to Discord's
 *     WebSocket gateway.
 *   - REST/DM polling path: no Message object — we POST a fresh
 *     message and PATCH it by id. Used when intents make DMs
 *     unavailable over the gateway and we poll DMs via REST.
 *
 * Both end up driving the same conversation flow; only the transport
 * differs. `runDiscordHarnessConversation` owns the state machine.
 */
export interface DiscordHarnessTransport {
  /** Send the initial placeholder. Returns a handle for subsequent edits. */
  sendInitial(content: string): Promise<DiscordHarnessReplyHandle>;
  /** Send a one-shot error message when we never get to start the run. */
  sendError(content: string): Promise<void>;
  /**
   * Post a follow-up message into the same conversation. Used to deliver
   * the tail of a reply that exceeds Discord's 2000-char per-message
   * cap, so the user sees the whole answer instead of `…obje…`.
   */
  sendFollowup?(content: string): Promise<void>;
  /**
   * Build the approval-button UI for the current display state, returning
   * the channel-native component payload (or null when no approval is
   * pending). When omitted, the runner falls back to Discord ActionRow
   * components (approvalComponentsForState). Slack supplies this to emit
   * Block Kit `actions` blocks instead. The returned array is passed
   * straight to handle.edit({ components }).
   */
  buildApprovalComponents?(state: DisplayState): unknown[] | null;
  /**
   * Optional progress sink, called on every flush with the live DisplayState.
   * The Slack AI-Assistant transport uses it to drive assistant.threads.setStatus
   * ("Clem is verifying numbers…") so the native pane shows real run activity.
   * Omitted by Discord (and the plain Slack transport) → no-op, behavior stays
   * byte-identical. Implementations must swallow their own errors.
   */
  onState?(state: DisplayState): void;
  /** Provider-specific exact delivery hook used only for the final autonomous
   * send question. Implementations must dedupe this stable key across live
   * edit and restart redelivery, then return only after provider success. */
  deliverConversationalApproval?(input: {
    approvalId: string;
    deliveryKey: string;
    content: string;
  }): Promise<void>;
  /** Idempotent edit of the exact placeholder already owned by this request.
   * The stable deliveryKey is transport correlation, never model authority. */
  deliverConversationPreamble?(input: ConversationPreambleDeliveryRequest & {
    content: string;
  }): Promise<{ target: string }>;
}

export interface DiscordHarnessReplyHandle {
  edit(content: string, options?: { components?: unknown[] }): Promise<void>;
}

export interface DisplayState {
  summary: string;
  status: string;
  done: boolean;
  /** Exact nonterminal owner returned by the shared host bridge. This is never
   * inferred from acknowledgement prose and never promoted to a terminal. */
  typedExecutionHold?: RunConversationHold;
  /** Foreground transport released; the logical user intent is still pending. */
  asyncWorkDispatched?: { sourceUserSeq: number; runIds: string[]; sourceGroupId: string };
  /** Complete audit events, but present only generic elapsed progress when quiet. */
  progressPresentation?: ProgressPresentation;
  // Visibility extensions — surfaced in the rolling message body so
  // the user can see what the agent is actually doing in real time.
  // Without these, long runs look identical to stuck runs.
  toolsCalled: string[];
  currentAgent?: string;
  toolCount: number;
  // When an approval_requested event fires, we stash the approvalId
  // here. The next flush attaches Approve/Reject buttons to the
  // message so the user clicks instead of typing "approve apr-xxxx".
  // Cleared on approval_resolved / awaiting_user_input / completion.
  pendingApprovalId?: string;
  pendingApprovalIds?: string[];
  /** Hidden durable approval whose only user surface is the ordinary question
   * in summary. Kept separate so no component/card projector can mistake it
   * for a formal approval. */
  pendingConversationApprovalId?: string;
  pendingConversationPromptEventId?: string;
  pendingConversationPromptEventSeq?: number;
  // Exact queued-action cards approve one immutable payload. Editing those
  // args would break the approval authority binding, so the UI hides Edit.
  // Undefined preserves the legacy editable behavior for ordinary approvals
  // until the registry row has been hydrated.
  pendingApprovalEditable?: boolean;
  // Wall-clock when the turn started, in ms. Set on the first
  // turn_started event. renderBody uses this to show an elapsed-time
  // counter so the user can tell "still working at 4m 12s" vs
  // "nothing happening." The heartbeat ticker also reads this so it
  // can decide whether to push a "still working" pulse.
  turnStartedAt?: number;
  // v0.5.10 auto-compact: percent of input budget the most recent
  // condenser_applied event reported. Used to render a small `[ctx
  // 42%]` footer so the user sees the context filling up before it
  // explodes. Only shown when > 30%.
  contextPct?: number;
  /**
   * The milestone line the SHARED activity projection asserts, refreshed at the
   * reducer's cadence rather than once per event. `status` remains the raw
   * event vocabulary the state machine writes; the rendered line prefers this
   * so every surface says the same thing about the same run.
   */
  activityLine?: string;
  /** Durable session behind this message. Lets the ticker project ledger
   * plan truth (composeRunProgressLine) instead of a generic working line. */
  sessionId?: string;
}

interface ChannelConversationPreambleDeliveryInput {
  progressPresentation: ProgressPresentation;
  state: DisplayState;
  handle: DiscordHarnessReplyHandle;
  transport: DiscordHarnessTransport;
  isFinalized: () => boolean;
  onPaint?: (body: string) => void;
  onTokenExpired?: () => void;
}

/** Build the one awaited transport acknowledgement used before work begins. */
function createChannelConversationPreambleDelivery(
  input: ChannelConversationPreambleDeliveryInput,
): ConversationPreambleDeliveryCallback {
  return async (request): Promise<ConversationPreambleDeliveryResult> => {
    let text: string;
    try { text = assertPublicPresentationText(request.text); } catch {
      return { status: 'failed', reason: 'delivery_failed' };
    }
    const receipt = (surface: 'channel_message' | 'not_applicable', target: string) => ({
      version: 1 as const,
      deliveryKey: request.deliveryKey,
      eventId: request.eventId,
      eventDigest: request.eventDigest,
      surface,
      target,
    });
    if (input.progressPresentation === 'quiet') {
      return {
        status: 'not_applicable',
        reason: 'quiet_presentation',
        receipt: receipt('not_applicable', 'quiet_presentation'),
      };
    }
    if (input.isFinalized()) return { status: 'failed', reason: 'transport_unavailable' };
    input.state.summary = text;
    input.state.done = false;
    if (input.state.toolCount === 0) input.state.status = 'starting';
    const body = renderBody(input.state);
    try {
      const delivered = input.transport.deliverConversationPreamble
        ? await input.transport.deliverConversationPreamble({ ...request, content: body })
        : (await input.handle.edit(body), { target: 'active_placeholder' });
      const target = delivered.target.replace(/\s+/g, ' ').trim().slice(0, 512);
      if (!target) return { status: 'failed', reason: 'delivery_failed' };
      input.onPaint?.(body);
      return { status: 'delivered', receipt: receipt('channel_message', target) };
    } catch (err) {
      if (isDiscordTokenExpired(err)) input.onTokenExpired?.();
      // A fresh follow-up is not idempotent across send-before-receipt crashes.
      // Leave the plan inactive so an exact placeholder edit can be retried.
      return { status: 'failed', reason: 'delivery_failed' };
    }
  };
}

/**
 * The channel message lane's link to the server activity projection.
 *
 * Both transports run through this one state machine, so this is where they
 * stop narrating from their own event handling: the display state says which
 * phase the turn is in, the durable attempt row says who owns it, and the
 * shared reducer decides whether that adds up to anything worth saying. Two
 * invariants come out of it — milestone text changes at the reducer's cadence
 * (never once per tool event) and the settled message is replaced exactly once.
 */
interface ChannelProgressLane {
  /** Progress only: kickoff, a rate-limited milestone edit, or silence. */
  milestone(state: DisplayState, nowMs: number): TransportProgressAction;
  /** The single final replacement. Emits 'final' once; later calls are 'none'. */
  settle(state: DisplayState, nowMs: number): TransportProgressAction;
  readonly finalized: boolean;
}

/**
 * Map the display state onto the projection's public vocabulary. Bounded
 * phases only: tool names, arguments, and targets stay out of the label because
 * they are not in the type the transport renders.
 */
function channelActivityForState(
  state: DisplayState,
): { lifecycle: SurfaceLifecycle; label: SurfaceActivityLabel } {
  if (state.pendingApprovalId) return { lifecycle: 'awaiting_approval', label: { phase: 'awaiting_approval' } };
  if (state.pendingConversationApprovalId) return { lifecycle: 'awaiting_input', label: { phase: 'awaiting_input' } };
  if (state.status === 'awaiting reply') return { lifecycle: 'awaiting_input', label: { phase: 'awaiting_input' } };
  if (state.asyncWorkDispatched) return { lifecycle: 'completing', label: { phase: 'delivering' } };
  if (state.toolCount > 0) return { lifecycle: 'using_tool', label: { phase: 'working_items' } };
  return { lifecycle: 'reasoning', label: { phase: 'thinking' } };
}

/**
 * The typed terminal for THIS message. A pause on a person is a settled
 * message, not a completed run, and neither is ever rendered as success.
 */
function channelTerminalForState(state: DisplayState): SurfaceTerminal | undefined {
  if (state.asyncWorkDispatched) {
    return { status: 'completed', kind: 'handed_off', text: state.summary || 'Started.', resumable: false };
  }
  if (!state.done) return undefined;
  const text = state.summary || 'Done.';
  if (state.pendingApprovalId) return { status: 'blocked', kind: 'awaiting_approval', text, resumable: true };
  const status = state.status ?? '';
  if (status === 'awaiting reply') return { status: 'blocked', kind: 'awaiting_input', text, resumable: true };
  if (status === 'rejected' || status.startsWith('stopped:')) {
    return { status: 'cancelled', kind: status, text, resumable: true };
  }
  if (status === 'abandoned' || status === 'stalled' || status.startsWith('timed out')) {
    return { status: 'failed', kind: status, text, resumable: true };
  }
  return { status: 'completed', kind: 'complete', text, resumable: false };
}

function createChannelProgressLane(input: {
  sessionId: string;
  attemptId: string;
  startedAt: string;
}): ChannelProgressLane {
  let progress: TransportProgressState = {};

  const project = (state: DisplayState, nowMs: number, withTerminal: boolean) => {
    // The durable attempt carries the ownership truth: quiet provider time
    // under a held lease is live, an expired one is stale, and an attempt that
    // never claimed a lease says nothing either way.
    let attempt = null as ReturnType<typeof getLatestRunAttempt>;
    try {
      const latest = getLatestRunAttempt(input.sessionId);
      attempt = latest && latest.attemptId === input.attemptId ? latest : null;
    } catch {
      attempt = null;
    }
    const activity = channelActivityForState(state);
    // Project plan truth into the ticker: "Working on 2 of 3" instead of an
    // unchanging "Working on the items" for a 16-minute run (live 2026-08-18).
    if (activity.label.phase === 'working_items') {
      const counters = runPlanCounters(input.sessionId);
      if (counters) {
        activity.label = { phase: 'working_items', completed: counters.completed, total: counters.total };
      }
    }
    const terminal = withTerminal ? channelTerminalForState(state) : undefined;
    return projectChatAttemptActivity({
      sessionId: input.sessionId,
      headline: 'Chat turn',
      attempt,
      observedAt: new Date(nowMs).toISOString(),
      revision: safeLatestEventSeq(input.sessionId),
      lifecycleHint: activity.lifecycle,
      activityLabel: activity.label,
      startedAt: input.startedAt,
      ...(terminal ? { terminalHint: terminal } : {}),
    });
  };

  return {
    get finalized(): boolean {
      return progress.finalized === true;
    },
    milestone(state, nowMs) {
      if (progress.finalized) return { action: 'none' };
      const entry = project(state, nowMs, false);
      // A settled run's message belongs to the final replacement, never to a
      // progress edit that happened to observe the terminal first.
      if (entry.terminal) return { action: 'none' };
      const advanced = advanceTransportProgress(entry, progress, nowMs);
      progress = advanced.state;
      return advanced.action;
    },
    settle(state, nowMs) {
      const terminal = channelTerminalForState(state);
      const advanced = settleTransportProgress(
        project(state, nowMs, true),
        progress,
        nowMs,
        terminal?.status === 'blocked' ? terminal : undefined,
      );
      progress = advanced.state;
      return advanced.action;
    },
  };
}

function safeLatestEventSeq(sessionId: string): number {
  try {
    return getLatestEventSeq(sessionId);
  } catch {
    return 0;
  }
}

async function sendParkedBackgroundAck(
  transport: DiscordHarnessTransport,
  message: string,
  meta: { sessionId: string; taskId: string },
): Promise<void> {
  try {
    await transport.sendInitial(message);
  } catch (err) {
    try { await transport.sendError(message); } catch { /* transport is best-effort */ }
    logger.warn(
      { err: err instanceof Error ? err.message : err, sessionId: meta.sessionId, taskId: meta.taskId },
      'failed to acknowledge parked background reply',
    );
  }
}

function taskBelongsToChatChannel(
  task: Pick<BackgroundTaskRecord, 'channel' | 'originSessionId'>,
  input: { channelLabel: string; channelId: string; channel: string },
): boolean {
  if (task.channel === input.channelLabel) return true;
  if (!task.originSessionId) return false;
  try {
    const origin = getHarnessSession(task.originSessionId);
    const metadata = origin?.metadata ?? {};
    if (origin?.channel === input.channel && metadata.channelId === input.channelId) return true;
    if (metadata.source === input.channel && metadata.channelId === input.channelId) return true;
    // Historical binding metadata kept the Discord-prefixed field name even
    // when Slack reused this harness module. Keep it as a compatibility path.
    const originMatchesChannel = origin?.channel === input.channel || metadata.source === input.channel;
    if (originMatchesChannel && metadata.discordChannelId === input.channelId) return true;
  } catch {
    return false;
  }
  return false;
}

function findSoleAwaitingInputTaskForChannel(input: { channelLabel: string; channelId: string; channel: string }): BackgroundTaskRecord | null {
  const parked = listBackgroundTasks({ status: 'awaiting_input' })
    .filter((task) => taskBelongsToChatChannel(task, input));
  return parked.length === 1 ? parked[0] : null;
}

function findSoleAwaitingContinueTaskForChannel(input: { channelLabel: string; channelId: string; channel: string }): BackgroundTaskRecord | null {
  const parked = listBackgroundTasks({ status: 'awaiting_continue' })
    .filter((task) => taskBelongsToChatChannel(task, input));
  return parked.length === 1 ? parked[0] : null;
}

/**
 * Route a reply back into a parked background task only when it binds to the
 * exact stored question. Commands are owned by the channel router; declines,
 * compound corrections, and unrelated asks fall through as fresh chat turns.
 */
async function maybeRouteParkedBackgroundReply(input: {
  sessionId?: string;
  channelLabel?: string;
  channelId?: string;
  channel?: string;
  message: string;
  transport: DiscordHarnessTransport;
}): Promise<boolean> {
  const answer = input.message.trim();
  const command = parseHarnessCommand(answer);
  if (command === 'cancel' || command === 'new' || command === 'sessions') return false;
  const channelLookup = !input.sessionId && input.channelLabel && input.channelId && input.channel
    ? { channelLabel: input.channelLabel, channelId: input.channelId, channel: input.channel }
    : null;
  const parkedTask = input.sessionId
    ? findSoleAwaitingInputTaskForOrigin(input.sessionId)
    : channelLookup
      ? findSoleAwaitingInputTaskForChannel(channelLookup)
      : null;
  if (parkedTask?.pendingQuestionId) {
    const replyDecision = classifyBackgroundInputReply({
      message: answer,
      question: parkedTask.pendingQuestion,
      options: parkedTask.pendingQuestionOptions,
    });
    if (replyDecision.kind !== 'resume') return false;
    const queued = queueBackgroundTaskInputResolution(parkedTask.pendingQuestionId, answer);
    if (!queued) return false;
    await sendParkedBackgroundAck(
      input.transport,
      `Answer sent to "${parkedTask.title}" — resuming now; the result lands here.`,
      { sessionId: queued.originSessionId ?? input.sessionId ?? input.channelLabel ?? 'unknown', taskId: queued.id },
    );
    return true;
  }

  if (/^\/?(continue|resume|keep going)$/i.test(answer)) {
    const continueTask = input.sessionId
      ? findSoleAwaitingContinueTaskForOrigin(input.sessionId)
      : channelLookup
        ? findSoleAwaitingContinueTaskForChannel(channelLookup)
        : null;
    if (continueTask) {
      queueBackgroundTaskContinue(continueTask.id);
      await sendParkedBackgroundAck(
        input.transport,
        `Continuing background task "${continueTask.title}". It will report back here when it's done.`,
        { sessionId: continueTask.originSessionId ?? input.sessionId ?? input.channelLabel ?? 'unknown', taskId: continueTask.id },
      );
      return true;
    }
  }

  return false;
}

/**
 * Build Discord button components for a pending approval, or null when
 * the state has no active approval. The components encode the same
 * custom-id format that the desktop's `buildApprovalActions` uses, so
 * the existing button interaction handler in discord.ts resolves the
 * apr-xxxx id and triggers `runDiscordHarnessResume`.
 */
export function approvalComponentsForState(state: DisplayState): unknown[] | null {
  const ids = state.pendingApprovalIds && state.pendingApprovalIds.length > 0
    ? state.pendingApprovalIds
    : state.pendingApprovalId
      ? [state.pendingApprovalId]
      : [];
  if (ids.length === 0) return null;
  if (ids.length > 1) {
    // Discord permits at most five action rows. Preserve exact authority per
    // sibling instead of presenting a false "Approve all" control whose custom
    // id can carry only one approval. The summary names the same numbered rows
    // and gives explicit typed commands for any overflow.
    return ids.slice(0, 5).map((id, index) => ({
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: `Approve ${index + 1}`,
          custom_id: `clementine:approve:${id}`,
        },
        {
          type: 2,
          style: 4,
          label: `Reject ${index + 1}`,
          custom_id: `clementine:reject:${id}`,
        },
      ],
    }));
  }
  const id = ids[0];
  const buttons: Array<Record<string, unknown>> = [
    { type: 2 /* Button */, style: 3 /* Success */, label: 'Approve', custom_id: `clementine:approve:${id}` },
  ];
  if (state.pendingApprovalEditable !== false) {
    buttons.push(
      // Edit opens a Discord modal pre-filled with the tool's args
      // JSON. User can change time, recipient, content, etc. before
      // approving. Cheaper than reject + ask the agent to retry.
      { type: 2, style: 1 /* Primary */, label: 'Edit', custom_id: `clementine:edit:${id}` },
    );
  }
  buttons.push({ type: 2, style: 4 /* Danger */, label: 'Reject', custom_id: `clementine:reject:${id}` });
  return [
    {
      type: 1, // ActionRow
      components: buttons,
    },
  ];
}

function trimDiscordText(input: string, max: number): string {
  const clean = input.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function describeRecipient(value: unknown): string {
  if (typeof value === 'string') return trimDiscordText(value, 110);
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const email = typeof record.email === 'string' ? record.email : '';
  const name = typeof record.name === 'string' ? record.name : '';
  if (name && email) return `${trimDiscordText(name, 40)} <${trimDiscordText(email, 70)}>`;
  return trimDiscordText(email || name, 110);
}

function pendingActionDetail(view: Partial<PendingActionApprovalView> | undefined): string {
  if (!view) return '';
  const target = typeof view.targetSummary === 'string' ? trimDiscordText(view.targetSummary, 160) : '';
  const risk = typeof view.risk === 'string' ? trimDiscordText(view.risk, 220) : '';
  const preview = typeof view.preview === 'string' ? trimDiscordText(view.preview, 320) : '';
  return [
    target ? `**Target:** ${target}` : '',
    risk ? `**Risk:** ${risk}` : '',
    preview ? `**Preview:** ${preview}` : '',
  ].filter(Boolean).join('\n');
}

function approvalRowDetail(row: approvalRegistry.PendingApprovalRow): string {
  const args = row.args ?? {};
  if (row.tool === 'composio_execute_tool') {
    const slug = typeof args.tool_slug === 'string' ? args.tool_slug : '';
    const inner = parseMaybeJson(args.arguments);
    if (inner && typeof inner === 'object') {
      const record = inner as Record<string, unknown>;
      const subject = typeof record.subject === 'string' ? trimDiscordText(record.subject, 90) : '';
      const recipients = Array.isArray(record.to_recipients) ? record.to_recipients : [];
      const to = recipients.length > 0 ? describeRecipient(recipients[0]) : '';
      return [slug, to ? `to ${to}` : '', subject && !row.subject.includes(subject) ? subject : '']
        .filter(Boolean)
        .join(' · ');
    }
    return slug;
  }
  if (row.tool === 'request_approval') {
    const pendingDetail = pendingActionDetail(pendingActionApprovalViewFromArgs(args));
    if (pendingDetail) return pendingDetail;
    const reason = typeof args.reason === 'string' ? trimDiscordText(args.reason, 140) : '';
    const preview = args.preview && typeof args.preview === 'object' ? args.preview as { count?: unknown } : null;
    const count = typeof preview?.count === 'number' ? `${preview.count} item${preview.count === 1 ? '' : 's'}` : '';
    return [count, reason].filter(Boolean).join(' · ');
  }
  if (row.tool === 'execution_create') {
    const objective = typeof args.objective === 'string' ? trimDiscordText(args.objective, 150) : '';
    return objective;
  }
  return previewToolCall(row.tool || 'approval', row.args);
}

/**
 * Rebuild the shared channel card after one exact decision. A channel message
 * may carry several independent approval ids; resolving one must not make the
 * remaining authorities disappear. The registry, rather than the old message,
 * is the source of truth for what is still actionable.
 */
export function remainingApprovalDisplayState(
  sessionId: string,
  decidedApprovalId: string,
  decision: 'approved' | 'rejected' | 'already-resolved',
): DisplayState | null {
  const rows = approvalRegistry
    .listPending({ sessionId, status: 'pending' })
    .filter((row) => approvalRegistry.isActionable(row))
    .filter(approvalRegistry.isFormalApprovalSurface);
  if (rows.length === 0) return null;

  const pendingApprovalIds = rows.map((row) => row.approvalId);
  const soleExactPendingAction = rows.length === 1
    ? pendingActionIdFromArgs(rows[0].args ?? null)
    : null;
  const decisionLabel = decision === 'approved'
    ? 'Approved'
    : decision === 'rejected'
      ? 'Rejected'
      : 'Already resolved';
  const decisionEmoji = decision === 'approved'
    ? '✅'
    : decision === 'rejected'
      ? '❌'
      : 'ℹ️';
  const lines = [
    `${decisionEmoji} **${decisionLabel}** \`${decidedApprovalId}\`.`,
    '',
    `${rows.length} independent action${rows.length === 1 ? '' : 's'} still need${rows.length === 1 ? 's' : ''} your decision:`,
  ];
  for (const [index, row] of rows.slice(0, 5).entries()) {
    const detail = approvalRowDetail(row);
    lines.push(`${index + 1}. ${row.subject}${detail ? ` — ${detail}` : ''} (\`${row.approvalId}\`)`);
  }
  if (rows.length > 5) {
    lines.push(`+${rows.length - 5} more — open Clementine → Inbox to review them individually.`);
  }
  lines.push('', 'Each numbered button applies only to its matching action.');

  return {
    summary: lines.join('\n'),
    status: 'awaiting independent approvals',
    done: true,
    toolsCalled: [],
    toolCount: 0,
    pendingApprovalId: pendingApprovalIds[0],
    pendingApprovalIds,
    pendingApprovalEditable: rows.length === 1 && !soleExactPendingAction,
  };
}

async function refreshPendingApprovalDisplay(state: DisplayState, sessionId: string): Promise<void> {
  if (
    !state.pendingConversationApprovalId
    && !state.pendingApprovalId
    && (!state.pendingApprovalIds || state.pendingApprovalIds.length === 0)
  ) return;
  // Approval interruptions can arrive as a burst of sibling events in
  // the same SDK pause. Give the registry a short tick so the Discord
  // card can summarize the whole batch instead of only the first row.
  await new Promise((resolve) => setTimeout(resolve, 75));
  const rows = approvalRegistry
    .listPending({ sessionId, status: 'pending' })
    .filter((row) => approvalRegistry.isActionable(row));
  if (rows.length === 0) return;
  const conversational = rows.length === 1 && rows[0].presentation
    ? rows[0]
    : null;
  if (conversational?.presentation) {
    state.pendingConversationApprovalId = conversational.approvalId;
    state.pendingApprovalId = undefined;
    state.pendingApprovalIds = undefined;
    state.pendingApprovalEditable = undefined;
    state.summary = conversational.presentation.question;
    state.status = 'awaiting reply';
    state.done = true;
    return;
  }
  // Registration demotes every conversational sibling in the same IMMEDIATE
  // transaction. A burst therefore becomes one coherent formal surface.
  state.pendingConversationApprovalId = undefined;
  state.pendingConversationPromptEventId = undefined;
  state.pendingConversationPromptEventSeq = undefined;
  state.pendingApprovalIds = rows.map((row) => row.approvalId);
  state.pendingApprovalId = state.pendingApprovalIds[0];
  const exactPendingActionId = rows.length === 1
    ? pendingActionIdFromArgs(rows[0].args ?? null)
    : null;
  state.pendingApprovalEditable = rows.length === 1 && !exactPendingActionId;
  const lines: string[] = [];
  if (rows.length === 1) {
    const row = rows[0];
    lines.push(`Approval required: ${row.subject}`);
    const detail = approvalRowDetail(row);
    if (detail) lines.push('', detail);
    const actions = state.pendingApprovalEditable
      ? '**Approve**, **Edit**, or **Reject**'
      : '**Approve** or **Reject**';
    lines.push('', `Tap ${actions} below — or type \`approve ${row.approvalId}\` / \`reject ${row.approvalId}\`.`);
  } else {
    lines.push(`Approval required for ${rows.length} actions:`);
    for (const [index, row] of rows.slice(0, 5).entries()) {
      const detail = approvalRowDetail(row);
      lines.push(`${index + 1}. ${row.subject}${detail ? ` — ${detail}` : ''} (\`${row.approvalId}\`)`);
    }
    if (rows.length > 5) lines.push(`• +${rows.length - 5} more`);
    lines.push(
      '',
      `Use the numbered **Approve** / **Reject** buttons below for the first ${Math.min(rows.length, 5)} action${Math.min(rows.length, 5) === 1 ? '' : 's'}. Each button applies only to its matching action.`,
    );
    if (rows.length > 5) {
      lines.push('Open Clementine → Inbox to review the remaining actions individually.');
    }
  }
  state.summary = lines.join('\n');
}

function markConversationApprovalDelivered(state: DisplayState): void {
  const approvalId = state.pendingConversationApprovalId;
  const promptEventId = state.pendingConversationPromptEventId;
  const promptEventSeq = state.pendingConversationPromptEventSeq;
  if (!approvalId || !promptEventId || !promptEventSeq) return;
  try {
    approvalRegistry.markConversationalApprovalPresented({
      approvalId,
      promptEventId,
      promptEventSeq,
    });
  } catch {
    // Delivery without a durable receipt stays intentionally unanswerable;
    // restart recovery may safely re-present the same exact question.
  }
}

async function deliverConversationApprovalExactly(
  state: DisplayState,
  transport: DiscordHarnessTransport,
): Promise<boolean> {
  const approvalId = state.pendingConversationApprovalId;
  if (!approvalId || !transport.deliverConversationalApproval) return false;
  await transport.deliverConversationalApproval({
    approvalId,
    deliveryKey: approvalRegistry.conversationalApprovalDeliveryKey(approvalId),
    content: renderBody(state),
  });
  markConversationApprovalDelivered(state);
  return true;
}

function renderBody(state: DisplayState): string {
  if (state.asyncWorkDispatched) {
    const body = state.summary || '_running in the background._';
    return body.length > MAX_DISCORD_MESSAGE ? body.slice(0, MAX_DISCORD_MESSAGE - 1) + '…' : body;
  }
  // Done states (final reply / approval / awaiting input) show ONLY
  // the summary — no progress noise. The summary already carries the
  // user-facing message, the approval prompt, or the awaiting-input
  // question.
  if (state.done) {
    const body = state.summary || '_done._';
    return body.length > MAX_DISCORD_MESSAGE ? body.slice(0, MAX_DISCORD_MESSAGE - 1) + '…' : body;
  }
  if (state.progressPresentation === 'quiet') {
    const elapsed = formatElapsedMs(state.turnStartedAt ? Date.now() - state.turnStartedAt : 0);
    const status = elapsed ? `_working… · ${elapsed}_` : '_working…_';
    return status.length > MAX_DISCORD_MESSAGE
      ? status.slice(0, MAX_DISCORD_MESSAGE - 1) + '…'
      : status;
  }
  // In-progress: a short status line PLUS an elapsed-time counter so
  // the user can tell "still working at 4m 12s" vs "nothing
  // happening." Tool count is included once 3+ tools have fired —
  // signals real progress, not churn. Still no full tool-call
  // history — that read as "the agent is confused" in earlier UX.
  // The milestone line is the shared projection's when the lane has asserted
  // one; the raw event status is the fallback for states it does not cover.
  // Project the ledger's composed plan line over GENERIC working copy only.
  // "Working on the items · N tools" for a 16-minute run reads as a stall
  // while the plan ledger knows "plan 1/3 steps underway · 25-item collection"
  // (live 2026-08-18 session-fixture-unprovisioned-catalog: 13 ledger heartbeats never reached the
  // Discord copy). Specific lines (approval waits, watcher steers) are kept;
  // composeRunProgressLine returns the fallback untouched when no plan exists.
  const rawLine = state.activityLine || state.status || 'working…';
  const line = state.sessionId && /^(?:working\b|still working\b|starting\b)/i.test(rawLine)
    ? composeRunProgressLine({ sessionId: state.sessionId, fallback: rawLine })
    : rawLine;
  const verb = state.currentAgent ? `${state.currentAgent} · ${line}` : line;
  const elapsed = formatElapsedMs(state.turnStartedAt ? Date.now() - state.turnStartedAt : 0);
  const counter = state.toolCount >= 3 ? ` · ${state.toolCount} tools` : '';
  // Context-window footer: surfaces when auto-compact has reported the
  // session at >30% of input budget. Lets the user see the meter climb
  // and decide to /new before Layer 3 forks.
  const ctx = typeof state.contextPct === 'number' && state.contextPct > 30
    ? ` · ctx ${Math.min(99, Math.round(state.contextPct))}%`
    : '';
  const status = elapsed
    ? `_${verb} · ${elapsed}${counter}${ctx}_`
    : `_${verb}${counter}${ctx}_`;
  // While the reply is streaming in (onChunk fills state.summary before the
  // turn is done), show a TAIL of it below the status line so the user
  // watches the answer form — mirrors how Slack's assistant pane streams.
  // Without this, every long run looked identical to a stuck one: just the
  // one-line "working…" status. The status line stays on top as the live
  // "still going" signal.
  const tail = streamingTail(state.summary);
  const body = tail ? `${status}\n\n${tail}` : status;
  return body.length > MAX_DISCORD_MESSAGE ? body.slice(0, MAX_DISCORD_MESSAGE - 1) + '…' : body;
}

// The most recent slice of the streaming reply, capped so status + tail stay
// comfortably under the per-message limit. Cuts at a word boundary and marks
// the dropped head with a leading ellipsis so it reads as "…forming reply".
const STREAM_TAIL_CHARS = 1_500;
function streamingTail(summary: string): string {
  const trimmed = (summary ?? '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= STREAM_TAIL_CHARS) return trimmed;
  const tail = trimmed.slice(trimmed.length - STREAM_TAIL_CHARS);
  const firstSpace = tail.indexOf(' ');
  const clean = firstSpace > 0 && firstSpace < 40 ? tail.slice(firstSpace + 1) : tail;
  return `…${clean}`;
}

/** Human-friendly "Ns" / "Nm Ms" / "Nh Mm" elapsed time. Returns
 *  empty for sub-5-second runs so brand-new turns don't blink "1s"
 *  on the very first flush. */
function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 5_000) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function humanHarnessText(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') {
    const obj = value as { reply?: unknown; summary?: unknown };
    const reply = typeof obj.reply === 'string' ? obj.reply.trim() : '';
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
    return reply || summary || fallback;
  }
  const text = String(value).trim();
  if (!text) return fallback;
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      const parsed = JSON.parse(text) as { reply?: unknown; summary?: unknown } | null;
      if (parsed && typeof parsed === 'object') {
        const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
        const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
        if (reply || summary) return reply || summary;
      }
    } catch {
      // Not JSON after all; use the raw text below.
    }
  }
  return text;
}

// ── Discord markdown adaptation ────────────────────────────────────────────
// Discord's markdown is a SUBSET of the GitHub-flavored markdown the harness
// emits: it renders #/##/### headers, *italic*, **bold**, lists, and code
// blocks — but NOT pipe tables (they show as raw `| a | b |` lines), NOT
// #### and deeper headers (they render literally), and NOT `---` horizontal
// rules. This pass adapts those three shapes so a reply that leans on tables
// or deep headers reads clean instead of "like test output". Sibling of
// slack-harness.ts:toSlackMrkdwn. Pure + fail-open — any surprise returns the
// input untouched so a formatting quirk can never block a reply.
const DISCORD_TABLE_GUTTER = '  ';

function isTableSeparatorLine(line: string): boolean {
  const t = line.trim();
  if (!t.includes('-')) return false;
  // A GFM header/body divider: cells of dashes with optional alignment colons,
  // separated by pipes (outer pipes optional).
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t);
}

function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((cell) => cell.trim());
}

function renderAlignedTable(header: string[], rows: string[][]): string {
  const cols = Math.max(header.length, ...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = (header[c] ?? '').length;
    for (const r of rows) w = Math.max(w, (r[c] ?? '').length);
    widths[c] = w;
  }
  const padRow = (cells: string[]): string => {
    const parts: string[] = [];
    for (let c = 0; c < cols; c++) parts.push((cells[c] ?? '').padEnd(widths[c]));
    return parts.join(DISCORD_TABLE_GUTTER).trimEnd();
  };
  const out = [padRow(header), widths.map((w) => '-'.repeat(w)).join(DISCORD_TABLE_GUTTER)];
  for (const r of rows) out.push(padRow(r));
  // A fenced code block preserves the monospace alignment in Discord.
  return '```\n' + out.join('\n') + '\n```';
}

function convertPipeTablesToCodeBlocks(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && isTableSeparatorLine(next)) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length; j++) {
        if (lines[j].trim() === '' || !lines[j].includes('|')) break;
        rows.push(splitTableRow(lines[j]));
      }
      out.push(renderAlignedTable(header, rows));
      i = j - 1;
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

export function toDiscordMarkdown(text: string): string {
  if (!text) return text;
  try {
    return convertPipeTablesToCodeBlocks(text)
      // #### heading (and deeper) → **bold** (Discord only renders #/##/###).
      .replace(/^#{4,6}\s+(.+)$/gm, '**$1**')
      // Horizontal rules (---, ***, ___ on their own line) → drop the line.
      .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '');
  } catch {
    return text;
  }
}

/**
 * Final-message renderer — no truncation. Used by finalFlush when the
 * conversation reaches a terminal state. The caller pairs this with
 * splitForLongReply to fan the body across multiple Discord messages
 * when it exceeds the 2000-char per-message cap.
 *
 * The activity block is only included when state.done is false, which
 * can happen if we're rendering a timed-out state (state.done=true was
 * set by the safety timer); in that case the status string carries the
 * useful info already, so we leave activity off and just show the
 * summary.
 */
function renderFullBody(state: DisplayState): string {
  if (state.asyncWorkDispatched) {
    return state.summary ? toDiscordMarkdown(state.summary) : '_running in the background._';
  }
  // Plain text, not a `> ` blockquote: Discord only blockquotes the FIRST
  // line, so a multi-line reply rendered as a quote looked broken (line 1
  // greyed, the rest normal). Run the reply through toDiscordMarkdown so
  // GFM tables / deep headers land in a shape Discord actually renders.
  const head = state.summary ? `${toDiscordMarkdown(state.summary)}\n\n` : '';
  let activity = '';
  if (!state.done) {
    const lines: string[] = [];
    if (state.currentAgent) lines.push(`**${state.currentAgent}** is working…`);
    if (state.toolCount > 0) {
      const recent = state.toolsCalled.slice(-4).join(', ');
      lines.push(`Tools used: ${state.toolCount} (${recent})`);
    }
    if (state.status) lines.push(`_${state.status}_`);
    activity = lines.join('\n');
  }
  return (head + activity).trim() || '_working…_';
}

/**
 * Split a Discord message body into chunks <= MAX_DISCORD_MESSAGE,
 * preferring paragraph then line then space boundaries. Mirrors the
 * splitForDiscord shape used by notification-delivery so the same
 * "your reply spilled into N parts" semantics apply across surfaces.
 */
function splitForLongReply(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [''];
  if (trimmed.length <= MAX_DISCORD_MESSAGE) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > MAX_DISCORD_MESSAGE) {
    const window = remaining.slice(0, MAX_DISCORD_MESSAGE);
    // Prefer a paragraph break, then a newline, then a space, then
    // hard-cut. The 400-char threshold avoids giving up the cap
    // entirely on a stubborn block of unbroken text.
    let cut = window.lastIndexOf('\n\n');
    if (cut < 400) cut = window.lastIndexOf('\n');
    if (cut < 400) cut = window.lastIndexOf(' ');
    if (cut < 400) cut = MAX_DISCORD_MESSAGE;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function createDiscordBridgeChunkStreamer(emit: (delta: string) => void): (chunk: string) => void {
  const jsonStreamer = createJsonFieldStreamer(['reply', 'objective', 'action'], emit);
  let mode: 'unknown' | 'json' | 'raw' = 'unknown';
  let pending = '';

  return (chunk: string): void => {
    if (!chunk) return;
    if (mode === 'json') {
      jsonStreamer(chunk);
      return;
    }
    if (mode === 'raw') {
      emit(chunk);
      return;
    }

    pending += chunk;
    const trimmed = pending.replace(/^\s+/, '');
    if (!trimmed) return;
    const first = trimmed[0];
    if (first === '{' || first === '[') {
      mode = 'json';
      jsonStreamer(pending);
      pending = '';
      return;
    }

    mode = 'raw';
    emit(pending);
    pending = '';
  };
}

/**
 * Transport-agnostic harness conversation runner. Subscribes to the
 * actionBus for the session's events, debounces edits, and resolves
 * once the conversation reaches a terminal state.
 */
export async function runDiscordHarnessConversation(opts: {
  prompt: string;
  channelId: string;
  userId: string;
  guildId: string | null;
  transport: DiscordHarnessTransport;
  /**
   * The user's RAW typed text, before attachment folding. Used only for the
   * durable-promotion intent decision so dropped-file contents can't trip it
   * (desktop↔Discord parity: desktop decides on raw `input` too). Falls back to
   * `prompt` when a caller doesn't fold attachments.
   */
  rawPrompt?: string;
  /**
   * Chat-channel kind for this conversation (default 'discord'). Slack passes
   * 'slack' so sessions, continuity, approvals, durable tasks, and the agentic
   * brain surface are all attributed to Slack. Defaults preserve byte-identical
   * Discord behavior.
   */
  channel?: string;
  /**
   * Routing label used for continuity/durable/plan-first channel keys
   * (default `discord:${channelId}`). Slack passes `slack:${channelId}`.
   */
  channelLabel?: string;
  /** Stable provider delivery identity. A replay with an accepted source but
   *  no terminal fails closed instead of dispatching tools a second time. */
  durableRequest?: DurableChannelRequest;
}): Promise<void> {
  const { channelId, userId, guildId, transport } = opts;
  const channel = opts.channel ?? 'discord';
  const channelLabel = opts.channelLabel ?? `${channel}:${channelId}`;
  // `prompt` is `let` (not destructured const) because the /continue
  // command path rewrites it from the bare "continue" the user typed
  // into a structured continuation directive the orchestrator can
  // act on. The rest of the function treats it as the user's input
  // verbatim.
  let prompt = opts.prompt;
  // Raw, pre-fold user text for the durable-intent decision only (parity with
  // the desktop dock, which decides on raw `input`).
  const rawPromptForIntent = opts.rawPrompt ?? opts.prompt;
  const progressPresentation = progressPresentationForPrompt(rawPromptForIntent);

  // Harness-control commands (/cancel, /new, /continue) — handled
  // BEFORE approval routing so a user-typed "cancel" abandons the
  // pause instead of counting as a reject (the old matcher conflated
  // the two and left the user with no way to back out without
  // "resolving" the action).
  const command = parseHarnessCommand(prompt);
  if (command === 'cancel') {
    await handleHarnessCancel({ channelId, transport, channel, userId, guildId });
    return;
  }
  if (command === 'new') {
    await handleHarnessNew({ channelId, transport, channel, userId, guildId });
    // Fall through is intentional — /new just clears the
    // channel-cached session; the rest of this function then creates
    // a fresh one. But the user's actual prompt was "/new", not
    // something the agent should reason about. Return so the user
    // sees the confirmation and can send their real first message.
    return;
  }
  if (command === 'sessions') {
    await handleHarnessSessions({ channelId, userId, guildId, transport, channel });
    return;
  }
  if (command === 'continue') {
    // /continue is only meaningful when the session's last
    // conversation_completed was a continue/limit completion. The
    // current loop emits awaiting_continue, while older stored sessions
    // may still carry limit_exceeded. Rewrite only those cases into a
    // structured continuation directive; otherwise leave `continue` as
    // a regular user message.
    const entry = getOrHydrateAudienceSession({ channel, channelId, userId, guildId });
    if (entry) {
      if (await maybeRouteParkedBackgroundReply({ sessionId: entry.sessionId, message: prompt, transport })) return;
      const lastCompletion = readLastConversationCompletion(entry.sessionId);
      if (lastCompletion && isContinueCompletionReason(lastCompletion.reason)) {
        prompt = buildContinueInput(lastCompletion.lastDecisionSummary);
      }
    }
  }

  // Approval-resume path: if the channel has a paused session and
  // the user typed an approve/reject phrase, resolve the pending
  // approval and continue THAT session instead of starting fresh.
  // Anything else while paused is treated as a regular new turn
  // (which will append on top of the existing session via continuity).
  if (isChannelSessionAwaitingApproval(channelId, channel, userId, guildId)) {
    const intent = parseApprovalIntent(prompt);
    if (intent) {
      await runDiscordHarnessResume({
        channelId,
        decision: intent.decision,
        approvalId: intent.approvalId,
        userText: rawPromptForIntent,
        transport,
        channel,
        userId,
        guildId,
        durableRequest: opts.durableRequest,
      });
      return;
    }
  }

  // This is a control for the run that was already active BEFORE this inbound
  // message. Handle it before resolving/creating a session or registering a new
  // attempt; otherwise the control attempt supersedes the work it meant to move
  // and the original foreground executor keeps running beside the new worker.
  if (await tryHandleBackgroundItControl({
    message: rawPromptForIntent,
    channelId,
    userId,
    guildId,
    channel,
    channelLabel,
    transport,
  })) return;

  const parkedEntry = getOrHydrateAudienceSession({ channel, channelId, userId, guildId });
  if (parkedEntry && await maybeRouteParkedBackgroundReply({ sessionId: parkedEntry.sessionId, message: prompt, transport })) {
    return;
  }

  // Typed consent into a surfaced plan (gate-unification Step 5). A PlanProposal
  // sets no interrupt state, so it doesn't hit the registry-resume path above —
  // typing "yes, go" used to fall through to a fresh turn that ignored the
  // pending plan. Resolve it, then re-engage the SAME turn with a clear
  // directive so Clem proceeds with the now-active goal (approvePlanProposal
  // activated it + opened its scope).
  const planConsent = maybeResolvePendingPlanProposal(channelId, prompt, channel, userId, guildId);
  if (planConsent === 'approved') {
    prompt = 'Plan approved — proceed with the plan now, and report back when done.';
  } else if (planConsent === 'rejected') {
    prompt = 'I rejected that plan. Do NOT proceed with it — ask me what to change.';
  }

  const auth = await configureHarnessRuntime();
  if (!auth.ok) {
    logger.warn({ reason: auth.reason }, 'Discord/Slack harness start blocked by unavailable model runtime');
    await transport.sendError(PUBLIC_MODEL_RUNTIME_UNAVAILABLE_TEXT);
    return;
  }

  const durableSession = opts.durableRequest?.sessionId
    ? getHarnessSession(opts.durableRequest.sessionId)
    : null;
  if (opts.durableRequest?.sessionId && !durableSession) {
    throw new Error(`durable channel session ${opts.durableRequest.sessionId} is missing`);
  }
  const session = durableSession
    ? { id: durableSession.id, isContinuation: true }
    : await resolveOrCreateSession({
      channelId,
      userId,
      guildId,
      prompt,
      channel,
      priorWorkObjective: rawPromptForIntent,
      durableSourceId: opts.durableRequest?.runId ?? `legacy:${channel}:${randomUUID()}`,
      ...(opts.durableRequest ? {
        receipt: {
          requestId: opts.durableRequest.requestId ?? opts.durableRequest.runId,
          runId: opts.durableRequest.runId,
          inputHash: opts.durableRequest.inputHash ?? durablePayloadHash({
            channel,
            channelId,
            guildId,
            userId,
            prompt: rawPromptForIntent,
          }),
        },
      } : {}),
    });
  // Receipt replay owns this delivery but intentionally does not move the
  // audience's ordinary pointer (for example an approval replay from a
  // pre-/new root).
  if (opts.durableRequest) {
    const prior = acceptedSourceForDurableRun({
      sessionId: session.id,
      runId: opts.durableRequest.runId,
      displayText: rawPromptForIntent,
    });
    if (prior) {
      opts.durableRequest.onSourceAccepted?.(prior.source);
      const outcome = acceptedChannelOutcome(prior.source);
      if (outcome) {
        if (prior.attempt) {
          try { finishRunAttempt(prior.attempt, 'completed'); } catch { /* durable outcome wins */ }
          clearChannelRunMarkerIfIdle(session.id, prior.attempt.attemptId);
        }
        await transport.sendInitial(outcome.text);
        return;
      }
      const failed = commitDiscordTerminal({
        source: prior.source,
        text: PUBLIC_CHANNEL_FAILURE_TEXT,
        status: 'failed',
        reason: 'transport_replay_unsettled',
        metadata: { uncertainPriorExecution: true },
      });
      if (prior.attempt) {
        try { finishRunAttempt(prior.attempt, 'failed'); } catch { /* typed terminal wins */ }
        clearChannelRunMarkerIfIdle(session.id, prior.attempt.attemptId);
      }
      await transport.sendInitial(failed.presentation.text);
      return;
    }
  }
  if (!getHarnessSession(session.id)) {
    throw new Error(`accepted Discord/Slack source has no selected session ${session.id}`);
  }
  // Register before the placeholder/preflight/model dispatch. A second Discord
  // message saying "stop" can now target this exact attempt even in the small
  // window before the SDK brain begins.
  const activeRun = registerActiveChannelRun({
    channel,
    channelId,
    userId,
    guildId,
    sessionId: session.id,
    runId: opts.durableRequest?.runId,
  });
  let acceptedUserInput: EventRow;
  try {
    // Accept and bind the human turn before any deterministic early outcome
    // (/goal, plan continuity, durable handoff) can publish a terminal. Looking
    // up the session's "latest" user event here is unsafe: on a fresh session
    // there is none, and on a continuation it belongs to the prior turn.
    acceptedUserInput = recordActiveChannelUserInput(
      activeRun,
      prompt,
      rawPromptForIntent,
      progressPresentation,
    );
    opts.durableRequest?.onSourceAccepted?.(acceptedUserInput);
  } catch (err) {
    unregisterActiveChannelRun(activeRun, 'failed');
    logger.error(
      { err: err instanceof Error ? err.message : String(err), sessionId: session.id },
      'failed to durably accept Discord/Slack harness turn',
    );
    await transport.sendError('I could not safely start that turn. Please try again.');
    return;
  }
  const autonomy = loadProactivityPolicy().autoApproveScope;
  const planFirst = shouldUsePlanFirst({ input: prompt, freshSession: !session.isContinuation, autonomy });

  let handle: DiscordHarnessReplyHandle;
  try {
    handle = await transport.sendInitial(
      progressPresentation === 'quiet' ? '🍊 working…' : '🍊 starting…',
    );
  } catch (err) {
    // Couldn't even post the placeholder — nothing we can do from
    // here live; persist private diagnostics plus one stable terminal so
    // reconnect/replay can still close the accepted turn safely.
    try {
      appendHarnessEvent({
        sessionId: session.id,
        turn: 0,
        role: 'system',
        type: 'run_failed',
        data: { error: err instanceof Error ? err.message : String(err), stage: 'initial_reply' },
      });
    } catch { /* private diagnostics are best-effort */ }
    let failureCommitted = false;
    try {
      commitDiscordTerminal({
        source: acceptedUserInput,
        text: PUBLIC_CHANNEL_FAILURE_TEXT,
        status: 'failed',
        reason: 'channel_initial_reply_failed',
      });
      failureCommitted = true;
    } catch (commitErr) {
      logger.error(
        { err: commitErr instanceof Error ? commitErr.message : String(commitErr), sessionId: session.id },
        'accepted Discord/Slack turn could not commit initial-reply failure',
      );
    }
    unregisterActiveChannelRun(activeRun, 'failed');
    if (failureCommitted) {
      clearChannelRunMarkerIfIdle(session.id, activeRun.attemptId);
    }
    return;
  }

  const state: DisplayState = {
    summary: '',
    status: progressPresentation === 'quiet' ? 'working…' : 'starting',
    done: false,
    progressPresentation,
    toolsCalled: [],
    toolCount: 0,
    sessionId: session.id,
  };
  // Every progress decision on this message — speak or stay quiet, what the
  // milestone says, whether the run is already settled — comes from the shared
  // reducer over the server activity projection, not from event handling here.
  const progressLane = createChannelProgressLane({
    sessionId: session.id,
    attemptId: activeRun.attemptId,
    startedAt: activeRun.startedAt,
  });
  let lastEditAt = 0;
  let pendingEdit: NodeJS.Timeout | null = null;
  // The body Discord/Slack is currently showing. An edit that would repaint it
  // byte-for-byte is not a progress update.
  let lastPaintedBody = '';
  // Track which approval the LAST flush attached buttons for, so a
  // subsequent flush after the approval resolves (or a new approval
  // arrives) clears/replaces them — passing components:[] drops them.
  let lastAttachedApprovalId: string | undefined;
  // Discord interaction tokens expire 15 min after the initial
  // interaction. Past that, `handle.edit()` throws (401 Invalid Webhook
  // Token / 10015 Unknown Webhook). Without the fallback below, a
  // multi-hour workflow would go SILENT on Discord after minute 15 —
  // intermediate progress disappears, the final reply never arrives,
  // and the user has no idea anything's still running. With this flag
  // set, intermediate progress edits go quietly (no spam — the user
  // wouldn't see them anyway since the token's gone) and the final
  // reply routes through transport.sendFollowup so the user DOES see
  // the answer as a fresh message in the same channel.
  let tokenExpired = false;
  // v0.5.19 F8 — track the last post-expiry "still working" follow-up
  // so we can throttle to one per POST_EXPIRY_CHECKIN_MS window.
  let lastExpiryCheckInAt = 0;
  // Token streaming: accumulate deltas here, flush periodically
  let streamBuffer = '';
  let pendingStreamFlush: NodeJS.Timeout | null = null;

  // Extract clean reply/plan text from the structured-output JSON stream
  // (raw deltas are JSON — see stream-reply.ts).
  const liveTextStreaming = progressPresentation !== 'quiet'
    && shouldStreamLiveTextToMessage(channel);
  const onChunk = createJsonFieldStreamer(['reply', 'objective', 'action'], (delta: string): void => {
    if (!liveTextStreaming) return;
    streamBuffer += delta;
    // Schedule a flush if not already pending. Use a faster debounce (1200ms)
    // than the event-based debounce (2000ms) so tokens appear sooner.
    if (pendingStreamFlush) return;
    pendingStreamFlush = setTimeout(() => {
      pendingStreamFlush = null;
      // If there's buffered text, update state.summary with accumulated text
      // and trigger a flush. This way streaming text appears in the message
      // as tokens arrive, without waiting for tool_called events.
      if (streamBuffer) {
        state.summary = streamBuffer;
        scheduleEdit();
      }
    }, 1200);
  });
  const bridgeOnChunk = createDiscordBridgeChunkStreamer((delta: string): void => {
    if (!liveTextStreaming) return;
    streamBuffer += delta;
    state.summary = streamBuffer;
    scheduleEdit();
  });

  const onConversationPreamble = createChannelConversationPreambleDelivery({
    progressPresentation,
    state,
    handle,
    transport,
    isFinalized: () => progressLane.finalized,
    onPaint: (body) => {
      lastPaintedBody = body;
      lastEditAt = Date.now();
    },
    onTokenExpired: () => { tokenExpired = true; },
  });

  const flush = async (): Promise<void> => {
    pendingEdit = null;
    lastEditAt = Date.now();
    // The settled message is never repainted by a straggling progress edit.
    if (progressLane.finalized) return;
    const milestone = progressLane.milestone(state, lastEditAt);
    if (milestone.action === 'kickoff' || milestone.action === 'edit') {
      state.activityLine = milestone.text;
    }
    // Progress sink (Slack AI-Assistant setStatus). Fires on every flush with the
    // live state, independent of message-edit token expiry. No-op for Discord.
    try { transport.onState?.(state); } catch { /* progress sink must never break the run */ }
    // If the interaction token already expired, intermediate progress
    // edits are silently dropped — the user wouldn't see them. But
    // v0.5.19 F8 keeps the user informed by posting one "still working"
    // follow-up per POST_EXPIRY_CHECKIN_MS window so an 80-call run
    // doesn't go dark past minute 15.
    if (tokenExpired) {
      if (shouldPostExpiryCheckIn({
        tokenExpired,
        stateDone: state.done,
        lastCheckInAt: lastExpiryCheckInAt,
        now: Date.now(),
        hasSendFollowup: !!transport.sendFollowup,
      })) {
        lastExpiryCheckInAt = Date.now();
        const tools = state.toolCount ?? 0;
        const headline = state.progressPresentation === 'quiet'
          ? '🍊 still working…'
          : `🍊 still working on this (${tools} tool${tools === 1 ? '' : 's'} so far)…`;
        try {
          await transport.sendFollowup!(headline);
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), sessionId: session.id, stage: 'expiry-checkin' },
            'discord post-expiry check-in failed',
          );
        }
      }
      return;
    }
    const components = transport.buildApprovalComponents?.(state) ?? approvalComponentsForState(state);
    const needsUpdate = state.pendingApprovalId !== lastAttachedApprovalId;
    const body = renderBody(state);
    if (!shouldPaintChannelBody({
      action: milestone.action,
      approvalChanged: needsUpdate,
      body,
      lastPaintedBody,
    })) return;
    try {
      if (components || needsUpdate) {
        // Pass components (or an empty array when we need to clear
        // previously-attached buttons).
        await handle.edit(body, { components: components ?? [] });
        lastAttachedApprovalId = state.pendingApprovalId;
      } else {
        await handle.edit(body);
      }
      lastPaintedBody = body;
      markConversationApprovalDelivered(state);
    } catch (err) {
      // Discord can transiently refuse edits (network blip, rate
      // limit, or — at minute 15+ — interaction-token expiry). The
      // next event will retry; nothing fatal. Log so long-workflow
      // failures are diagnosable instead of silent.
      if (isDiscordTokenExpired(err)) {
        tokenExpired = true;
        logger.warn(
          { sessionId: session.id, stage: 'flush-token-expired' },
          'discord interaction token expired — switching to sendFollowup for final reply',
        );
        return;
      }
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), sessionId: session.id, stage: 'flush' },
        'discord edit failed',
      );
    }
  };

  /**
   * Final flush on conversation completion. Unlike progress edits,
   * this one preserves the full reply: if the body exceeds Discord's
   * per-message cap, post the head into the existing message and the
   * tail as follow-up messages. The user sees the whole answer
   * instead of the previous `…obje…` truncation marker.
   *
   * Approval pauses are weird: the harness's approval_requested handler
   * sets state.done=true so the subscriber unsubscribes (the turn is
   * "done" from the harness POV — control belongs to the human now).
   * But that means we hit finalFlush instead of the regular flush, and
   * without attaching components here the Approve/Edit/Reject buttons
   * never render on the message — leaving the user with text-only
   * "approve apr-xxx" fallback (seen 2026-05-21 on workflow_schedule).
   * Attach them in finalFlush too when state still carries an approval.
   */
  const finalFlush = async (): Promise<void> => {
    pendingEdit = null;
    lastEditAt = Date.now();
    // Exactly one final replacement: a second settle (the safety timer racing
    // the terminal event) finds the lane already finalized and stays quiet.
    if (progressLane.finalized) return;
    // The lane is marked final only once the reply is actually DELIVERED — each
    // send path settles it for itself below. A send that threw left the user
    // looking at a placeholder, and a lane that called itself finished there
    // would lock the message against every retry.
    if (!state.asyncWorkDispatched) await refreshPendingApprovalDisplay(state, session.id);
    const fullBody = renderFullBody(state);
    const chunks = splitForLongReply(fullBody);
    const components = transport.buildApprovalComponents?.(state) ?? approvalComponentsForState(state);
    const needsComponentUpdate = state.pendingApprovalId !== lastAttachedApprovalId || !!components;

    if (state.pendingConversationApprovalId && transport.deliverConversationalApproval) {
      try {
        await deliverConversationApprovalExactly(state, transport);
        lastPaintedBody = chunks[0] ?? '';
        progressLane.settle(state, Date.now());
      } catch (err) {
        logger.warn({
          err: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
          stage: 'conversation-approval-exact-delivery',
        }, 'ordinary send-consent question exact delivery failed');
      }
      return;
    }

    // Token-expired path: skip handle.edit entirely and route the full
    // reply through sendFollowup as a fresh message in the channel.
    // Without this, runs that exceed 15 minutes go dark — the user
    // never sees the result.
    if (tokenExpired) {
      if (transport.sendFollowup) {
        try {
          for (const chunk of chunks) {
            await transport.sendFollowup(chunk);
          }
          markConversationApprovalDelivered(state);
          progressLane.settle(state, Date.now());
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), sessionId: session.id, stage: 'finalFlush-postExpiry' },
            'discord final followup failed after token expiry',
          );
        }
      }
      return;
    }

    try {
      if (needsComponentUpdate) {
        await handle.edit(chunks[0] ?? '_working…_', { components: components ?? [] });
        lastAttachedApprovalId = state.pendingApprovalId;
      } else {
        await handle.edit(chunks[0] ?? '_working…_');
      }
      if (chunks.length > 1 && transport.sendFollowup) {
        for (let i = 1; i < chunks.length; i++) {
          await transport.sendFollowup(chunks[i]);
        }
      }
      lastPaintedBody = chunks[0] ?? '';
      markConversationApprovalDelivered(state);
      progressLane.settle(state, Date.now());
    } catch (err) {
      // Token expired DURING the final flush (run was just at the 15-min
      // boundary). Try the whole thing via followup so the user still
      // gets the answer.
      if (isDiscordTokenExpired(err)) {
        tokenExpired = true;
        logger.warn(
          { sessionId: session.id, stage: 'finalFlush-token-expired' },
          'discord interaction token expired during final flush — falling back to sendFollowup',
        );
        if (transport.sendFollowup) {
          try {
            for (const chunk of chunks) {
              await transport.sendFollowup(chunk);
            }
            markConversationApprovalDelivered(state);
            progressLane.settle(state, Date.now());
          } catch (followupErr) {
            logger.warn(
              { err: followupErr instanceof Error ? followupErr.message : String(followupErr), sessionId: session.id, stage: 'finalFlush-fallback' },
              'discord followup fallback after token expiry also failed',
            );
          }
        }
        return;
      }
      // Edit can transiently fail. Don't crash settle — the user can
      // re-ping if they don't see the full reply. Log so long-workflow
      // settle failures are diagnosable instead of silent.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), sessionId: session.id, stage: 'finalFlush' },
        'discord final edit failed',
      );
    }
  };

  const scheduleEdit = (): void => {
    if (pendingEdit) return;
    const elapsed = Date.now() - lastEditAt;
    const wait = Math.max(0, EDIT_DEBOUNCE_MS - elapsed);
    pendingEdit = setTimeout(() => {
      void flush();
    }, wait);
  };

  // "Still working" pulse: every PROGRESS_PULSE_MS while the run is
  // active, force a flush so the elapsed-time counter in renderBody
  // ticks forward — even if no harness.event fires during that
  // window. Without this, a tool that takes 90 seconds (e.g. the
  // 84-second `draft_plan` seen in the planning-timeout regression) leaves the
  // Discord message frozen at its old timestamp, indistinguishable
  // from a stuck run.
  //
  // Suppressed when:
  //   - state.done (approval pause, awaiting input, completed) — the
  //     message is already terminal; no pulse needed
  //   - tokenExpired — Discord won't accept the edit anyway; the
  //     followup-on-finalFlush path delivers the final answer
  //
  // The pulse goes through scheduleEdit, which already debounces +
  // rate-limits, so EDIT_DEBOUNCE_MS still protects against burst
  // edits if a real event fires right before a pulse tick.
  const PROGRESS_PULSE_MS = 30_000;
  let progressPulse: NodeJS.Timeout | null = setInterval(() => {
    if (state.done) return;
    if (tokenExpired) return;
    if (!state.turnStartedAt) return;
    scheduleEdit();
  }, PROGRESS_PULSE_MS);
  progressPulse?.unref?.();

  let heldObserver = false;
  let settleHeldResponse!: (response: AssistantResponse) => Promise<void>;

  const finished: Promise<void> = new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let safetyTimer: NodeJS.Timeout | null = null;

    const settle = async (): Promise<void> => {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (safetyTimer) clearTimeout(safetyTimer);
      if (pendingEdit) {
        clearTimeout(pendingEdit);
        pendingEdit = null;
      }
      // Cancel any pending stream flush — without this, a token-stream
      // flush scheduled up to 1200ms ago can fire AFTER finalFlush and
      // overwrite the final reply with stale partial stream text.
      if (pendingStreamFlush) {
        clearTimeout(pendingStreamFlush);
        pendingStreamFlush = null;
      }
      if (progressPulse) {
        clearInterval(progressPulse);
        progressPulse = null;
      }
      await finalFlush();
      resolve();
    };

    settleHeldResponse = async (response): Promise<void> => {
      const raw = response.raw && typeof response.raw === 'object' && !Array.isArray(response.raw)
        ? response.raw as Record<string, unknown>
        : null;
      const candidate = raw?.typedExecution;
      const hold = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
      const typedHold: RunConversationHold | undefined = hold?.owner === 'host'
        && (hold.wake === 'peer' || hold.wake === 'recovery')
        && ((hold.wake === 'peer' && hold.reason === 'peer_in_progress')
          || (hold.wake === 'recovery' && hold.reason === 'recovery_pending'))
        ? hold as RunConversationHold
        : undefined;
      if (!typedHold) {
        logger.warn({ sessionId: session.id }, 'host bridge returned in-progress without a typed owner');
      }
      state.summary = response.text;
      state.status = 'held';
      state.typedExecutionHold = typedHold;
      // Slack's optional native status sink receives the same typed hold before
      // the message observer closes. Discord ignores this callback and receives
      // the canonical acknowledgement through the owned placeholder edit.
      try { transport.onState?.(state); } catch { /* status delivery is best-effort */ }
      await settle();
    };

    unsubscribe = actionBus.subscribe((bus) => {
      if (bus.kind !== 'harness.public_event') return;
      if (bus.sessionId !== session.id) return;
      if (!applyEventToAcceptedChannelState(bus.event, acceptedUserInput, state)) return;
      if (state.done || state.asyncWorkDispatched) {
        void settle();
        return;
      }
      scheduleEdit();
    });

    safetyTimer = setTimeout(() => {
      state.status = 'timed out waiting for completion';
      state.done = true;
      void settle();
    }, SAFETY_TIMEOUT_MS);
  });

  void (async () => {
    try {
      // ── plan-continuity routing (always on) ──
      // If a prior plan on this channel still awaits the user's answers,
      // classify this message against it BEFORE normal plan-first routing.
      // It runs inside this IIFE so re-entering runPlanFirstPreflight emits
      // its events into the same live-edit loop and `return` short-circuits
      // the orchestrator exactly like the existing planFirst block below.
      // /goal slash command (goal-contract P3): pin/inspect/cancel the
      // session's parked goal. Reply-only commands complete via the event
      // bus (the live-edit subscriber renders the reply and settles);
      // start/resume swap the run input so work begins immediately.
      const goalCmd = parseGoalCommand(prompt);
      let goalRunInput: string | null = null;
      if (goalCmd) {
        const outcome = handleGoalContractCommand({
          command: goalCmd,
          sessionId: session.id,
          channel: `discord:${channelId}`,
        });
        if (!outcome.runInput) {
          commitDiscordAnswer({
            source: acceptedUserInput,
            text: outcome.reply,
            reason: 'goal_command',
            metadata: { steps: 0 },
          });
          return;
        }
        goalRunInput = outcome.runInput;
      }
      {
        const channelKey = channelLabel;
        const continuity = await routeOpenQuestionPlan({
          channel: channelKey,
          input: prompt,
          sessionId: session.id,
          sourceUserSeq: acceptedUserInput.seq,
          autonomy,
          reuseRecordedUserInput: true,
          sendNote: transport.sendFollowup
            ? async (message) => {
                try { await transport.sendFollowup!(message); } catch { /* note is best-effort */ }
              }
            : undefined,
        });
        if (continuity.handled) return;
      }
      // Durable background promotion (gap C1) — desktop↔Discord parity. Explicit
      // durable asks AND high-confidence unattended data pipelines go to the
      // daemon's durable lane (board-visible, restart-recoverable, reports back
      // into THIS channel's session) instead of an ephemeral in-process run.
      // Plain asks fall through to the normal foreground run.
      // Decide on the RAW text (not folded attachments); enqueue the FULL
      // `prompt`. Skip when the session is paused on an approval so a stray
      // durable phrase can't orphan an in-flight gated workflow.
      const promoteToDurable = !goalRunInput
        && !isChannelSessionAwaitingApproval(channelId, channel, userId, guildId)
        && shouldPromoteToDurable(rawPromptForIntent);
      if (promoteToDurable) {
        const task = enqueueDurableChatTask({
          message: prompt,
          sessionId: session.id,
          channel: channelLabel,
          source: channel as 'discord' | 'slack',
        });
        const queuedReply = renderDurableTaskQueued(task);
        commitDiscordAnswer({
          source: acceptedUserInput,
          text: queuedReply,
          reason: 'queued_background',
          metadata: { steps: 0, queuedTaskId: task.id },
        });
        return;
      }
      if (planFirst && !goalRunInput) {
        const preflight = await runPlanFirstPreflight({
          input: prompt,
          sessionId: session.id,
          channel: channelLabel,
          freshSession: !session.isContinuation,
          autonomy,
          onChunk,
          reuseRecordedUserInput: true,
          sourceUserSeq: acceptedUserInput.seq,
        });
        if (preflight.surfaced) return;
      }
      const effectiveInput = goalRunInput ?? prompt;
      // Discord and Slack use the same host-owned model/tool loop for every
      // interactive brain. RouterModelProvider chooses the wire adapter, so a
      // Claude selection still bills its subscription OAuth token while its
      // tool calls, approvals, continuation, and terminal ownership stay on the
      // same harness path as Codex.
      const runSharedHarnessPath = async (): Promise<void> => {
        await runConversation({
          buildAgent: (identity) => buildOrchestratorAgent({
            userInput: effectiveInput,
            sessionId: session.id,
            sourceUserSeq: identity.sourceUserSeq,
            acceptedRoute: identity.route,
            allowToolJit: true,
          }),
          sessionId: session.id,
          input: effectiveInput,
          sourceUserSeq: acceptedUserInput.seq,
          runAttemptId: activeRun.attemptId,
          judgeCompletion: completionReviewEnabled(),
          onConversationPreamble,
          onChunk,
          reuseRecordedUserInput: true,
        });
      };
      const bridgeSurface: 'discord' | 'slack' = channel === 'slack' ? 'slack' : 'discord';
      const response = await respondPreferHarness(bridgeSurface, {
        message: effectiveInput,
        displayMessage: rawPromptForIntent,
        sourceUserSeq: acceptedUserInput.seq,
        sessionId: session.id,
        channel: channelLabel,
        userId,
        runId: activeRun.runId ?? activeRun.attemptId,
        // Auto-classify the first non-space character so Discord never flashes
        // a raw structured decision envelope while the shared harness streams.
        onChunk: bridgeOnChunk,
        onConversationPreamble,
      }, async () => {
        await runSharedHarnessPath();
        return { text: '', sessionId: session.id, stoppedReason: 'success' };
      });
      if (response.stoppedReason === 'in-progress') {
        // No public event will arrive for this exact source: a peer/recovery
        // activation still owns it. Close only this transport observer, render
        // the bridge's canonical acknowledgement, and leave both durable owner
        // ledgers active for that continuation.
        heldObserver = true;
        await settleHeldResponse(response);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      try {
        appendHarnessEvent({
          sessionId: session.id,
          turn: 0,
          role: 'system',
          type: 'run_failed',
          data: { error: errorMessage, stage: 'pre_first_turn' },
        });
      } catch {
        /* private diagnostics are best-effort */
      }
      try {
        commitDiscordTerminal({
          source: acceptedUserInput,
          text: PUBLIC_CHANNEL_FAILURE_TEXT,
          status: 'failed',
          reason: 'channel_turn_failed',
        });
      } catch (commitErr) {
        logger.error(
          { err: commitErr instanceof Error ? commitErr.message : String(commitErr), sessionId: session.id },
          'accepted Discord/Slack turn could not commit stable failure',
        );
      }
    }
  })();

  try {
    await finished;
  } finally {
    if (heldObserver) {
      releaseHeldChannelObserver(activeRun);
    } else {
      const outcome = acceptedChannelOutcome(acceptedUserInput);
      const finalStatus = getHarnessSession(session.id)?.status === 'cancelled'
        ? 'cancelled'
        : outcome
          ? 'completed'
          : 'failed';
      unregisterActiveChannelRun(activeRun, finalStatus);
      if (outcome) {
        // `completed` here closes the foreground provider attempt. For a
        // dispatch, async_work_dispatched remains the nonterminal logical edge;
        // the outer Slack/Discord inbox may mark its ACK `replied` without
        // claiming the workflow itself has completed.
        clearChannelRunMarkerIfIdle(session.id, activeRun.attemptId);
      }
    }
  }
}

/**
 * Approval-resume helper. Same live-edit loop as
 * runDiscordHarnessConversation, but bound to an existing paused
 * session and a yes/no decision instead of fresh user input. The
 * conversation continues from where the SDK paused — the orchestrator
 * sees the approval result on its next decision and proceeds (or
 * halts, on reject).
 */
async function runDiscordHarnessResume(opts: {
  channelId: string;
  decision: 'approve' | 'reject';
  /** When the user typed `approve apr-xy7q`, route to that specific
   *  pending approval (even if it belongs to a different session
   *  than the channel's most-recent). Without this, multi-session
   *  channels silently routed "approve" to the most-recent paused
   *  session, losing work on the older one (audit 2026-05-18). */
  approvalId?: string;
  /** Literal typed approval reply. Button/notification callers omit this and
   *  receive a hidden synthetic accepted control edge. */
  userText?: string;
  transport: DiscordHarnessTransport;
  allowDetachedNonDiscord?: boolean;
  channel?: string;
  durableRequest?: DurableChannelRequest;
  userId?: string;
  guildId?: string | null;
}): Promise<void> {
  const { channelId, decision, transport } = opts;
  let approvalId = opts.approvalId;
  const channel = opts.channel ?? 'discord';

  // ── Route the approval ────────────────────────────────────────
  // Three cases, in priority order:
  //   1. `approvalId` supplied → look it up in the registry. If it
  //      points to a session paused for the same channel, switch to
  //      that session (overrides the channelSessions "most recent"
  //      heuristic). If it's missing / already resolved / not on this
  //      channel, tell the user and bail.
  //   2. No `approvalId` AND exactly one session paused on this
  //      channel → continue with the channelSessions entry (today's
  //      behavior).
  //   3. No `approvalId` AND multiple distinct sessions paused on
  //      this channel → tell the user the list of apr-xxx codes and
  //      bail. Never silently route to the wrong session.
  let sessionId: string;
  if (approvalId) {
    const row = approvalRegistry.get(approvalId);
    if (!row) {
      await settleApprovalRoutingReply({
        durableRequest: opts.durableRequest,
        channelId,
        channel,
        prompt: opts.userText ?? `${decision} ${approvalId}`,
        decision,
        approvalId,
        transport,
        text: `No pending approval matches \`${approvalId}\`. It may have already been resolved or expired.`,
        status: 'needs_input',
      });
      return;
    }
    if (
      opts.userId
      && isDiscordApproval(row, channel)
      && !approvalTargetMatchesAudience({
        row,
        channelId,
        channel,
        userId: opts.userId,
        scopeId: opts.guildId ?? null,
      })
    ) {
      await settleApprovalRoutingReply({
        durableRequest: opts.durableRequest,
        channelId,
        channel,
        userId: opts.userId,
        scopeId: opts.guildId ?? null,
        prompt: opts.userText ?? `${decision} ${approvalId}`,
        decision,
        approvalId,
        transport,
        text: `Approval \`${approvalId}\` belongs to a different or stale conversation.`,
        status: 'needs_input',
      });
      return;
    }
    if (row.status !== 'pending') {
      await settleApprovalRoutingReply({
        durableRequest: opts.durableRequest,
        channelId,
        channel,
        prompt: opts.userText ?? `${decision} ${approvalId}`,
        decision,
        approvalId,
        candidateRows: (!isDiscordApproval(row, channel) || approvalOriginMatchesDiscordChannel(row, channelId, channel))
          ? [row]
          : undefined,
        transport,
        text: `Approval \`${approvalId}\` was already ${row.status}${row.resolution ? ` (${row.resolution})` : ''}.`,
        status: 'needs_input',
      });
      return;
    }
    if (!approvalOriginMatchesDiscordChannel(row, channelId, channel)) {
      if (opts.allowDetachedNonDiscord && !isDiscordApproval(row, channel) && row.channel !== 'workflow') {
        sessionId = row.sessionId;
      } else {
        // Cross-channel approvals are intentionally blocked for interactive
        // chat sessions. Workflow approvals are resolved by
        // tryHandleHarnessApprovalReply before this resume helper runs.
        await settleApprovalRoutingReply({
          durableRequest: opts.durableRequest,
          channelId,
          channel,
          prompt: opts.userText ?? `${decision} ${approvalId}`,
          decision,
          approvalId,
          transport,
          text: `Approval \`${approvalId}\` belongs to a different or stale conversation.`,
          status: 'needs_input',
        });
        return;
      }
    } else {
      sessionId = row.sessionId;
    }
    if (approvalRegistry.isExpired(row)) {
      const acceptedControl = acceptDurableApprovalControl({
        durableRequest: opts.durableRequest,
        sessionId,
        displayText: opts.userText ?? `${decision} ${approvalId}`,
        approvalId,
        decision,
      });
      if (acceptedControl?.replayText) {
        await transport.sendInitial(acceptedControl.replayText);
        return;
      }
      approvalRegistry.resolve(row.approvalId, 'expired', `${channel}-user`);
      const text = settleDurableApprovalControl(
        acceptedControl,
        `Approval \`${approvalId}\` has expired. Re-ask and I'll redo that work.`,
        'needs_input',
      );
      await transport.sendInitial(text);
      return;
    }
  } else {
    const pendingOnChannel = opts.userId
      ? pendingApprovalsForAudience({
        channelId,
        channel,
        userId: opts.userId,
        scopeId: opts.guildId ?? null,
      })
      : pendingDiscordApprovalsForChannel(channelId, channel);
    const distinctSessions = [...new Set(pendingOnChannel.map((r) => r.sessionId))];
    const fallback = opts.userId
      ? getOrHydrateAudienceSession({
        channel,
        channelId,
        userId: opts.userId,
        guildId: opts.guildId ?? null,
      })
      : channelSessions.get(channelId);
    if (distinctSessions.length > 1) {
      // Multiple paused sessions — make the user pick.
      const summary = distinctSessions.slice(0, 5).map((sid) => {
        const rows = pendingOnChannel.filter((r) => r.sessionId === sid);
        const first = rows[0];
        return `  • \`${first.approvalId}\` — ${first.subject}`;
      }).join('\n');
      await settleApprovalRoutingReply({
        durableRequest: opts.durableRequest,
        channelId,
        channel,
        prompt: opts.userText ?? decision,
        decision,
        candidateRows: pendingOnChannel,
        transport,
        text: `You have ${distinctSessions.length} paused approvals on this channel. Reply \`${decision} apr-xxxx\` for the one you mean:\n${summary}`,
        status: 'needs_input',
      });
      return;
    }
    // A session may contain multiple independent actionable cards. Selecting
    // only the session and letting runConversationFromResume guess by recency
    // can approve the wrong write. Bare approve/reject is authoritative only
    // when exactly one card is actionable; otherwise make the user name it.
    if (pendingOnChannel.length > 1) {
      if (opts.durableRequest) {
        await settleApprovalRoutingReply({
          durableRequest: opts.durableRequest,
          channelId,
          channel,
          prompt: opts.userText ?? decision,
          decision,
          candidateRows: pendingOnChannel,
          transport,
          text: approvalPickerText(pendingOnChannel, decision),
          status: 'needs_input',
        });
      } else {
        await sendApprovalPicker(transport, pendingOnChannel, decision);
      }
      return;
    }
    if (distinctSessions.length === 1) {
      sessionId = distinctSessions[0];
      approvalId = exactBareApprovalCandidate(pendingOnChannel)?.approvalId;
    } else if (fallback) {
      // Registry has nothing recorded (pre-migration session or a
      // race) — fall back to today's "most recent on channel" so we
      // don't regress sessions that paused before the registry
      // existed.
      sessionId = fallback.sessionId;
    } else {
      await settleApprovalRoutingReply({
        durableRequest: opts.durableRequest,
        channelId,
        channel,
        prompt: opts.userText ?? decision,
        decision,
        transport,
        text: 'No paused session to resume.',
        status: 'needs_input',
      });
      return;
    }
  }

  if (opts.durableRequest?.sessionId && opts.durableRequest.sessionId !== sessionId) {
    throw new Error(`durable approval run ${opts.durableRequest.runId} is bound to another session`);
  }
  if (opts.durableRequest && opts.userId) {
    const selectedControl = selectSessionForAcceptedSource({
      kind: 'bound_control',
      entrySessionId: sessionId,
      targetSessionId: sessionId,
      durableSourceId: opts.durableRequest.runId,
      continuity: {
        provider: channel,
        scopeId: opts.guildId ?? null,
        conversationId: channelId,
        audienceId: opts.userId,
      },
    });
    if (selectedControl.sessionId !== sessionId) {
      throw new Error('bound approval control selected a different target session');
    }
  }
  const entry = channelSessions.get(channelId);
  if (entry && entry.sessionId === sessionId) {
    entry.lastUsedAt = Date.now();
    bindDiscordHarnessSession({
      channelId,
      sessionId,
      channel,
      userId: opts.userId,
      guildId: opts.guildId ?? null,
    });
  } else {
    // The chosen session may not be the channel-cached one (when
    // routing by approvalId). Update the cache so subsequent
    // interactions in this channel target the now-active session.
    bindDiscordHarnessSession({
      channelId,
      sessionId,
      channel,
      userId: opts.userId,
      guildId: opts.guildId ?? null,
    });
  }
  const progressPresentation = progressPresentationForSession(sessionId);

  if (opts.durableRequest) {
    const displayText = opts.userText?.trim()
      || `${decision === 'approve' ? 'Approve' : 'Reject'}${approvalId ? ` ${approvalId}` : ''}`;
    const prior = acceptedSourceForDurableRun({
      sessionId,
      runId: opts.durableRequest.runId,
      displayText,
    });
    if (prior) {
      opts.durableRequest.onSourceAccepted?.(prior.source);
      const sourceApprovalId = typeof prior.source.data.approvalId === 'string'
        ? prior.source.data.approvalId
        : undefined;
      const sourceDecision = prior.source.data.decision;
      if (sourceApprovalId !== approvalId || sourceDecision !== decision) {
        throw new Error(`durable approval run ${opts.durableRequest.runId} is bound to a different decision`);
      }
      const outcome = acceptedChannelOutcome(prior.source);
      if (outcome) {
        if (prior.attempt) {
          try { finishRunAttempt(prior.attempt, 'completed'); } catch { /* durable outcome wins */ }
          clearChannelRunMarkerIfIdle(sessionId, prior.attempt.attemptId);
        }
        await transport.sendInitial(outcome.text);
        return;
      }
      const failed = commitDiscordTerminal({
        source: prior.source,
        text: PUBLIC_CHANNEL_FAILURE_TEXT,
        status: 'failed',
        reason: 'approval_transport_replay_unsettled',
        metadata: { uncertainPriorExecution: true, approvalId, decision },
      });
      if (prior.attempt) {
        try { finishRunAttempt(prior.attempt, 'failed'); } catch { /* typed terminal wins */ }
        clearChannelRunMarkerIfIdle(sessionId, prior.attempt.attemptId);
      }
      await transport.sendInitial(failed.presentation.text);
      return;
    }
  }

  const resumeAttempt = beginRunAttempt(sessionId, { runId: opts.durableRequest?.runId });
  let acceptedApprovalInput: EventRow;
  try {
    const displayText = opts.userText?.trim()
      || `${decision === 'approve' ? 'Approve' : 'Reject'}${approvalId ? ` ${approvalId}` : ''}`;
    const replyAuthority = exactChannelReplyAuthority(channel, channelId);
    acceptedApprovalInput = recordRunAttemptUserInput(resumeAttempt, {
      turn: 0,
      role: 'user',
      data: {
        text: displayText,
        displayText,
        progressPresentation,
        // A provider approval button is a human control edge even when its
        // display text is generated. Internal outcome relays remain synthetic
        // and cannot acquire this exact source authority.
        humanControl: opts.userText ? 'typed_approval' : 'provider_approval_action',
        source: 'channel_approval_resume',
        decision,
        ...(approvalId ? { approvalId } : {}),
        attemptId: resumeAttempt.attemptId,
        ...replyAuthority,
      },
    }, { armRunInFlight: true });
    opts.durableRequest?.onSourceAccepted?.(acceptedApprovalInput);
  } catch (err) {
    try { finishRunAttempt(resumeAttempt, 'failed'); } catch { /* best effort */ }
    clearChannelRunMarkerIfIdle(sessionId, resumeAttempt.attemptId);
    logger.error(
      { err: err instanceof Error ? err.message : String(err), sessionId },
      'failed to durably accept Discord/Slack approval response',
    );
    await transport.sendError(PUBLIC_CHANNEL_FAILURE_TEXT);
    return;
  }

  // Runtime readiness is checked only after the approval response owns an
  // exact source. Otherwise an unavailable model produced a public reply that
  // the provider inbox marked delivered with no graph terminal to replay.
  const auth = await configureHarnessRuntime();
  if (!auth.ok) {
    logger.warn({ reason: auth.reason }, 'Discord/Slack harness resume blocked by unavailable model runtime');
    const failed = commitDiscordTerminal({
      source: acceptedApprovalInput,
      text: PUBLIC_MODEL_RUNTIME_UNAVAILABLE_TEXT,
      status: 'failed',
      reason: 'approval_model_runtime_unavailable',
      metadata: { approvalId, decision },
    });
    try { finishRunAttempt(resumeAttempt, 'failed'); } catch { /* typed terminal wins */ }
    clearChannelRunMarkerIfIdle(sessionId, resumeAttempt.attemptId);
    await transport.sendInitial(failed.presentation.text);
    return;
  }

  let handle: DiscordHarnessReplyHandle;
  try {
    handle = await transport.sendInitial(
      progressPresentation === 'quiet'
        ? '🍊 working…'
        : decision === 'approve'
          ? '🍊 approved — resuming…'
          : '🍊 rejected — winding down…',
    );
  } catch (err) {
    try {
      appendHarnessEvent({
        sessionId,
        turn: 0,
        role: 'system',
        type: 'run_failed',
        data: {
          error: err instanceof Error ? err.message : String(err),
          stage: 'resume_initial_reply',
        },
      });
    } catch { /* private diagnostics are best-effort */ }
    try {
      commitDiscordTerminal({
        source: acceptedApprovalInput,
        text: PUBLIC_CHANNEL_FAILURE_TEXT,
        status: 'failed',
        reason: 'resume_initial_reply_failed',
      });
    } catch (commitErr) {
      logger.error(
        { err: commitErr instanceof Error ? commitErr.message : String(commitErr), sessionId },
        'accepted Discord/Slack approval response could not commit initial-reply failure',
      );
    }
    try { finishRunAttempt(resumeAttempt, 'failed'); } catch { /* best effort */ }
    clearChannelRunMarkerIfIdle(sessionId, resumeAttempt.attemptId);
    return;
  }

  const state: DisplayState = {
    summary: '',
    status: progressPresentation === 'quiet'
      ? 'working…'
      : decision === 'approve'
        ? 'resuming after approval'
        : 'cancelling',
    done: false,
    progressPresentation,
    toolsCalled: [],
    toolCount: 0,
    sessionId,
  };
  // The resumed turn narrates from the same shared reducer as the first turn —
  // a resume is not a second progress vocabulary.
  const progressLane = createChannelProgressLane({
    sessionId,
    attemptId: resumeAttempt.attemptId,
    startedAt: resumeAttempt.startedAt,
  });
  let lastEditAt = 0;
  let pendingEdit: NodeJS.Timeout | null = null;
  let lastAttachedApprovalId: string | undefined;
  // The body currently on screen; an identical repaint is not an update.
  let lastPaintedBody = '';
  // Token streaming: accumulate deltas here, flush periodically
  let streamBuffer = '';
  let pendingStreamFlush: NodeJS.Timeout | null = null;

  const liveTextStreaming = progressPresentation !== 'quiet'
    && shouldStreamLiveTextToMessage(channel);
  const onChunk = createJsonFieldStreamer(['reply', 'objective', 'action'], (delta: string): void => {
    if (!liveTextStreaming) return;
    streamBuffer += delta;
    if (pendingStreamFlush) return;
    pendingStreamFlush = setTimeout(() => {
      pendingStreamFlush = null;
      if (streamBuffer) {
        state.summary = streamBuffer;
        scheduleEdit();
      }
    }, 1200);
  });

  const flush = async (): Promise<void> => {
    pendingEdit = null;
    lastEditAt = Date.now();
    if (progressLane.finalized) return;
    const milestone = progressLane.milestone(state, lastEditAt);
    if (milestone.action === 'kickoff' || milestone.action === 'edit') {
      state.activityLine = milestone.text;
    }
    const components = transport.buildApprovalComponents?.(state) ?? approvalComponentsForState(state);
    const needsUpdate = state.pendingApprovalId !== lastAttachedApprovalId;
    const body = renderBody(state);
    if (!shouldPaintChannelBody({
      action: milestone.action,
      approvalChanged: needsUpdate,
      body,
      lastPaintedBody,
    })) return;
    try {
      if (components || needsUpdate) {
        await handle.edit(body, { components: components ?? [] });
        lastAttachedApprovalId = state.pendingApprovalId;
      } else {
        await handle.edit(body);
      }
      lastPaintedBody = body;
      markConversationApprovalDelivered(state);
    } catch {
      /* transient — next event retries */
    }
  };

  // See renderFullBody / splitForLongReply at the bottom of this file:
  // resume completions can also exceed Discord's 2000-char cap; mirror
  // the head-edit + tail-followup pattern from the main path.
  const finalFlush = async (): Promise<void> => {
    pendingEdit = null;
    lastEditAt = Date.now();
    if (progressLane.finalized) return;
    if (!state.asyncWorkDispatched) await refreshPendingApprovalDisplay(state, sessionId);
    const fullBody = renderFullBody(state);
    const chunks = splitForLongReply(fullBody);
    const components = transport.buildApprovalComponents?.(state) ?? approvalComponentsForState(state);
    const needsComponentUpdate = state.pendingApprovalId !== lastAttachedApprovalId || !!components;
    if (state.pendingConversationApprovalId && transport.deliverConversationalApproval) {
      try {
        await deliverConversationApprovalExactly(state, transport);
        lastPaintedBody = chunks[0] ?? '';
        progressLane.settle(state, Date.now());
      } catch {
        /* exact provider delivery remains retryable and unanswerable */
      }
      return;
    }
    try {
      if (needsComponentUpdate) {
        await handle.edit(chunks[0] ?? '_working…_', { components: components ?? [] });
        lastAttachedApprovalId = state.pendingApprovalId;
      } else {
        await handle.edit(chunks[0] ?? '_working…_');
      }
      if (chunks.length > 1 && transport.sendFollowup) {
        for (let i = 1; i < chunks.length; i++) {
          await transport.sendFollowup(chunks[i]);
        }
      }
      lastPaintedBody = chunks[0] ?? '';
      markConversationApprovalDelivered(state);
      // Final only after the reply actually landed — a failed send leaves the
      // lane open so the next attempt can still deliver.
      progressLane.settle(state, Date.now());
    } catch {
      /* transient — user can re-ping if they don't see the full reply */
    }
  };

  const scheduleEdit = (): void => {
    if (pendingEdit) return;
    const elapsed = Date.now() - lastEditAt;
    const wait = Math.max(0, EDIT_DEBOUNCE_MS - elapsed);
    pendingEdit = setTimeout(() => {
      void flush();
    }, wait);
  };

  const finished: Promise<void> = new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let safetyTimer: NodeJS.Timeout | null = null;

    const settle = async (): Promise<void> => {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (safetyTimer) clearTimeout(safetyTimer);
      if (pendingEdit) {
        clearTimeout(pendingEdit);
        pendingEdit = null;
      }
      // Cancel any pending stream flush so it can't overwrite the final
      // reply with stale partial stream text after finalFlush.
      if (pendingStreamFlush) {
        clearTimeout(pendingStreamFlush);
        pendingStreamFlush = null;
      }
      await finalFlush();
      resolve();
    };

    unsubscribe = actionBus.subscribe((bus) => {
      if (bus.kind !== 'harness.public_event') return;
      if (bus.sessionId !== sessionId) return;
      if (!applyEventToAcceptedChannelState(bus.event, acceptedApprovalInput, state)) return;
      if (state.done || state.asyncWorkDispatched) {
        void settle();
        return;
      }
      scheduleEdit();
    });

    safetyTimer = setTimeout(() => {
      state.status = 'timed out waiting for completion';
      state.done = true;
      void settle();
    }, SAFETY_TIMEOUT_MS);
  });

  void (async () => {
    try {
      const result = await runConversationFromResume({
        buildAgent: (identity) => buildOrchestratorAgentForApprovalResume({
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          acceptedRoute: identity.route,
          allowToolJit: true,
        }),
        sessionId,
        runAttemptId: resumeAttempt.attemptId,
        sourceUserSeq: acceptedApprovalInput.seq,
        approvalId,
        decision,
        resolver: 'discord-user',
        onChunk,
      });
      // If reject — the run pivoted to "no work to do" and the
      // conversation is effectively done. Force the UI into the
      // completed state so the placeholder updates with a final
      // message even when no run_completed event fires post-reject.
      if (decision === 'reject' && result.status === 'completed' && !state.done) {
        state.summary = state.summary || 'Action rejected. No work performed.';
        state.status = 'rejected';
        state.done = true;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      try {
        appendHarnessEvent({
          sessionId,
          turn: 0,
          role: 'system',
          type: 'run_failed',
          data: { error: errorMessage, stage: 'resume' },
        });
      } catch { /* private diagnostics are best-effort */ }
      try {
        commitDiscordTerminal({
          source: acceptedApprovalInput,
          text: PUBLIC_CHANNEL_FAILURE_TEXT,
          status: 'failed',
          reason: 'channel_resume_failed',
        });
      } catch (commitErr) {
        logger.error(
          { err: commitErr instanceof Error ? commitErr.message : String(commitErr), sessionId },
          'accepted Discord/Slack approval response could not commit stable failure',
        );
      }
    }
  })();

  await finished;
  const outcome = acceptedChannelOutcome(acceptedApprovalInput);
  try { finishRunAttempt(resumeAttempt, outcome ? 'completed' : 'failed'); } catch { /* best effort */ }
  if (outcome) {
    clearChannelRunMarkerIfIdle(sessionId, resumeAttempt.attemptId);
  }
}

/**
 * Gateway entry point — wraps Discord.js Message into the transport
 * abstraction and runs the conversation.
 */
export async function handleDiscordHarnessMessage(
  message: Message<boolean>,
  prompt: string,
  durableRequest?: DurableChannelRequest,
): Promise<void> {
  // Deterministic "status" command: a bare status-intent message is answered
  // directly from the board stores WITHOUT invoking the brain, so a channel user
  // can see everything in flight between kickoff and the terminal report-back.
  // Runs after the caller's inbox claim (dedup) and is fail-open — any error
  // falls through to the normal harness pipeline below.
  if (isStatusCommand(prompt)) {
    try {
      await message.reply(formatBoardSummaryText(buildBoardSummary()));
      return;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'status command failed; falling through to brain');
    }
  }
  // MID-RUN STEERING (desktop↔Discord parity, 2026-08-07): a message for a
  // channel whose bound session has a LIVE run becomes a steer note delivered
  // at the model's next tool-result boundary — starting a new conversation
  // here would supersede the attempt and kill the running work. Approval
  // replies and commands were already intercepted upstream; attachments keep
  // the normal path so files are never silently folded into a note.
  if (message.attachments.size === 0 && prompt.trim()) {
    try {
      const boundSessionId = getBoundDiscordHarnessSessionId(
        message.channelId,
        'discord',
        message.author.id,
        message.guildId ?? null,
      );
      const latest = boundSessionId ? getLatestRunAttempt(boundSessionId) : null;
      const leaseLive = Boolean(
        latest
        && !latest.finishedAt
        && latest.leaseExpiresAt
        && Date.parse(latest.leaseExpiresAt) > Date.now(),
      );
      if (boundSessionId && leaseLive) {
        const { appendSteerNote } = await import('../runtime/harness/steer-notes.js');
        appendSteerNote(boundSessionId, prompt);
        await message.reply('📝 Noted — she’s mid-run, and your message reaches her at the next step without restarting anything.');
        return;
      }
    } catch { /* fall through to the normal conversation path */ }
  }
  const transport: DiscordHarnessTransport = {
    async sendInitial(content) {
      const reply = (await message.reply(content)) as unknown as {
        edit(opts: { content: string; components?: unknown[] }): Promise<unknown>;
      };
      return {
        edit: async (next, options) => {
          const payload: { content: string; components?: unknown[] } = { content: next };
          if (options && Array.isArray(options.components)) {
            payload.components = options.components;
          }
          await reply.edit(payload);
        },
      };
    },
    async sendError(content) {
      await message.reply(content);
    },
    async sendFollowup(content) {
      // Post a new message in the same channel for the tail of a long
      // reply. message.reply() threads it to the original prompt so the
      // user sees it as a continuation of the same conversation.
      await message.reply(content);
    },
  };
  // Fold any files the user dropped in Discord into the prompt. Discord hosts
  // the bytes on its CDN, so we just hand the URL + filename to the shared
  // ingestion pipeline (fetch → convert to markdown). YouTube links pasted in
  // the message text are picked up too.
  let effectivePrompt = prompt;
  try {
    const { ingestAttachment, foldAttachmentsIntoMessage, extractYouTubeUrls } = await import('../runtime/attachments.js');
    const ingested = [];
    for (const att of message.attachments.values()) {
      ingested.push(await ingestAttachment({ name: att.name ?? 'attachment', url: att.url }));
    }
    for (const url of extractYouTubeUrls(prompt).slice(0, 3)) {
      ingested.push(await ingestAttachment({ name: url, url }));
    }
    if (ingested.length > 0) {
      effectivePrompt = foldAttachmentsIntoMessage(prompt, ingested);
    }
  } catch {
    // Attachment ingestion is best-effort; fall back to the plain prompt.
  }

  await runDiscordHarnessConversation({
    prompt: effectivePrompt,
    rawPrompt: prompt,
    channelId: message.channelId,
    userId: message.author.id,
    guildId: message.guildId ?? null,
    transport,
    durableRequest,
  });
}

/**
 * Translate one harness event into the Discord reply's display
 * state. Exported for unit tests; the Discord live-edit loop just
 * applies it and schedules a debounced flush.
 */
type AsyncDispatchAuthorityVerifier = (
  event: EventRow,
  acceptedSource: Pick<EventRow, 'sessionId' | 'seq' | 'turn'>,
) => boolean;

function asyncDispatchEventHasExactAuthority(
  event: EventRow,
  acceptedSource: Pick<EventRow, 'sessionId' | 'seq' | 'turn'>,
): boolean {
  return verifiedWorkflowRunDispatchReceipts(
    acceptedSource.sessionId,
    acceptedSource.turn,
    acceptedSource.seq,
  ).some((receipt) => receipt.eventId === event.id);
}

function applyEventToAcceptedChannelState(
  event: EventRow,
  acceptedSource: Pick<EventRow, 'sessionId' | 'seq' | 'turn'>,
  state: DisplayState,
  verifyAsyncDispatch: AsyncDispatchAuthorityVerifier = asyncDispatchEventHasExactAuthority,
): boolean {
  if (event.type === 'conversation_completed') {
    // A chat session is reusable and can have overlapping physical work. The
    // public projector retains the terminal's canonical logical owner; only
    // that exact source may settle this request's Discord/Slack placeholder.
    const ownsPlaceholder = event.sessionId === acceptedSource.sessionId
      && (event.data.sourceUserSeq === acceptedSource.seq
        || event.data.terminalKey === `turn:${acceptedSource.seq}`);
    if (!ownsPlaceholder) return false;
  } else if (event.type === 'conversation_preamble') {
    const preamble = publicConversationPreambleData(event.data);
    if (
      !preamble
      || event.sessionId !== acceptedSource.sessionId
      || event.turn !== acceptedSource.turn
      || preamble.sourceUserSeq !== acceptedSource.seq
    ) return false;
  } else if (event.type === 'async_work_dispatched') {
    const dispatch = publicAsyncWorkDispatchedData(event.data);
    if (
      !dispatch
      || event.sessionId !== acceptedSource.sessionId
      || dispatch.sourceUserSeq !== acceptedSource.seq
      || !verifyAsyncDispatch(event, acceptedSource)
    ) return false;
  }
  applyEventToState(event, state);
  return true;
}

export function applyEventToState(event: EventRow, state: DisplayState): void {
  const data = event.data ?? {};
  switch (event.type) {
    case 'conversation_preamble': {
      const preamble = publicConversationPreambleData(data);
      if (!preamble) return;
      state.summary = preamble.text;
      // A preamble is presentation, never settlement. Preserve a more useful
      // tool/running status if work has already begun; final completion remains
      // the only reducer event that sets done=true and replaces this prose.
      if (state.toolCount === 0) state.status = 'starting';
      state.done = false;
      return;
    }
    case 'async_work_dispatched': {
      const dispatch = publicAsyncWorkDispatchedData(data);
      if (!dispatch) return;
      state.summary = dispatch.text;
      state.status = 'running in background';
      state.asyncWorkDispatched = {
        sourceUserSeq: dispatch.sourceUserSeq,
        runIds: [...dispatch.runIds],
        sourceGroupId: dispatch.sourceGroupId,
      };
      state.pendingApprovalId = undefined;
      state.pendingApprovalIds = undefined;
      state.pendingApprovalEditable = undefined;
      state.done = false;
      return;
    }
    case 'turn_started': {
      if (!state.turnStartedAt) state.turnStartedAt = Date.now();
      if (state.progressPresentation === 'quiet') {
        state.currentAgent = undefined;
        state.status = 'working…';
        return;
      }
      // role on a turn_started event is the agent that's starting
      // (Orchestrator, Researcher, Executor, Writer, etc.). Surface it
      // so the user sees who's running.
      const role = typeof event.role === 'string' && event.role !== 'system' && event.role !== 'user'
        ? event.role
        : '';
      if (role) state.currentAgent = role;
      state.status = 'thinking…';
      return;
    }
    case 'tool_called': {
      // Inner gateway rows remain in the durable event stream for diagnostics,
      // but `accounting=transport_mirror` is explicitly not a second logical
      // user action. Discord and Slack share this state reducer, so filtering
      // at the presentation edge prevents both double-counting and wrapper
      // internals replacing useful progress copy.
      if (!isCanonicalTopLevelToolEvent(event, 'tool_called')) return;
      if (state.progressPresentation === 'quiet') return;
      const tool = String(data.tool ?? data.name ?? 'tool');
      // Richer status line: "running: pwd && ls -la" vs the bare
      // "using run_shell_command". During a skill execution the agent
      // can fire 7 sequential shell commands and "using
      // run_shell_command" 7 times in a row gives the Discord viewer
      // zero info. previewToolCall pulls the meaningful field from
      // the args (command for shell, slug for composio, path for
      // write_file) and renders one short label. When the helper
      // can't extract anything useful, it returns the bare tool name
      // — in that fallback case we still prepend "using " so the
      // user reads it as an in-progress action instead of a noun.
      const projectedProgress = typeof data.progress === 'string'
        ? data.progress.replace(/\s+/g, ' ').trim().slice(0, 110)
        : '';
      const preview = projectedProgress || previewToolCall(tool, data.arguments);
      state.status = preview === tool ? `using ${tool}` : preview;
      state.toolsCalled.push(tool);
      state.toolCount += 1;
      return;
    }
    case 'handoff': {
      if (state.progressPresentation === 'quiet') return;
      const to = String(data.to ?? data.target ?? 'sub-agent');
      state.status = `→ ${to}`;
      return;
    }
    case 'turn_ended': {
      if (state.progressPresentation === 'quiet') return;
      // Each agent turn's output lands here. For sub-agents
      // (Researcher / Writer / Executor / etc.) that don't define an
      // outputType, `output` is the agent's plain-text reply — which
      // becomes the final answer when the orchestrator doesn't take
      // another turn (the "no_structured_output" path in
      // runConversation). For the Orchestrator itself, `output` is
      // the OrchestratorDecision JSON — extract `.summary` so we
      // surface the human-readable line, not raw JSON.
      if (event.role === 'system') return;
      const output = String(data.output ?? '');
      if (!output) return;
      state.summary = humanHarnessText(output, output);
      return;
    }
    case 'conversation_step': {
      if (state.progressPresentation === 'quiet') return;
      const decision = (data.decision ?? null) as { summary?: string; reply?: string | null } | null;
      // Prefer reply (user-facing text) over summary (META log). Without
      // this, a step's META summary leaks into state.summary and survives
      // even when conversation_completed later carries a real reply.
      const stepText = humanHarnessText(decision?.reply && decision.reply.trim() ? decision.reply : decision?.summary);
      if (stepText) state.summary = stepText;
      const step = data.step ? `step ${String(data.step)}` : 'step';
      state.status = step;
      return;
    }
    case 'approval_requested': {
      const subject = String(data.subject ?? data.tool ?? 'action');
      const approvalId = typeof data.approvalId === 'string' ? data.approvalId : null;
      const pendingActionArgs = typeof data.pendingActionId === 'string'
        ? { pendingActionId: data.pendingActionId }
        : data.args;
      const pendingAction = data.pendingAction && typeof data.pendingAction === 'object'
        ? data.pendingAction as Partial<PendingActionApprovalView>
        : pendingActionApprovalViewFromArgs(pendingActionArgs);
      const exactPendingActionId = pendingActionIdFromArgs(pendingActionArgs)
        ?? (
          typeof pendingAction?.id === 'string' && pendingAction.id.trim()
            ? pendingAction.id.trim()
            : null
        );
      const conversationQuestion = data.approvalPresentation === 'conversation'
        && typeof data.question === 'string'
        && data.question.trim()
        ? data.question.trim()
        : null;
      if (approvalId && conversationQuestion) {
        // Autonomous mode presents one ordinary conversational decision while
        // retaining the same hidden approval id as frozen execution authority.
        // No pendingApprovalId reaches the component renderer, so Discord and
        // Slack attach no Approve/Edit/Reject card. A sole bare yes/no is later
        // rebound to this exact row by tryHandleHarnessApprovalReply.
        state.pendingApprovalId = undefined;
        state.pendingApprovalIds = undefined;
        state.pendingApprovalEditable = undefined;
        state.pendingConversationApprovalId = approvalId;
        state.pendingConversationPromptEventId = event.id;
        state.pendingConversationPromptEventSeq = event.seq;
        state.summary = conversationQuestion;
        state.status = 'awaiting reply';
        state.done = true;
        return;
      }
      // Stash the approval id so the next flush attaches Approve/Reject
      // buttons (rendered server-side by the Discord transport via the
      // standard buildApprovalActions helper). Text fallback stays in
      // the body for clients that ignore components or for users who
      // prefer to type — never required.
      if (approvalId) {
        state.pendingConversationApprovalId = undefined;
        state.pendingConversationPromptEventId = undefined;
        state.pendingConversationPromptEventSeq = undefined;
        const ids = state.pendingApprovalIds ?? [];
        if (!ids.includes(approvalId)) ids.push(approvalId);
        state.pendingApprovalIds = ids;
        state.pendingApprovalId = ids[0] ?? approvalId;
        if (ids.length === 1) state.pendingApprovalEditable = !exactPendingActionId;
      }

      // Resource-fingerprint warning: if the approval's args mention a
      // resource id that DOESN'T match the active focus, surface a
      // visible warning so the user can catch a wrong-sheet mutation
      // before approving. Catches the missing-focus failure mode
      // (2026-05-24) where the agent updated the wrong Google Sheet.
      let mismatchWarning = '';
      try {
        const resourceId = extractResourceIdFromApprovalArgs(data.args);
        const fp = checkResourceMatchesFocus(resourceId);
        if (fp.result === 'mismatch') {
          mismatchWarning = `\n\n⚠ **RESOURCE MISMATCH** — this would act on \`${resourceId}\`, but your active focus is **${fp.focusTitle}** (\`${fp.focusRef}\`). Verify before approving.`;
        }
      } catch { /* graceful */ }

      const detail = pendingActionDetail(pendingAction);
      const replyHint = approvalId
        ? `Tap **Approve** or **Reject** below — or type \`approve ${approvalId}\` / \`reject ${approvalId}\` if you prefer.`
        : 'Tap a button below — or reply **approve** / **reject**.';
      state.summary = [
        `Approval required: ${subject}${mismatchWarning}`,
        detail,
        replyHint,
      ].filter(Boolean).join('\n\n');
      state.status = 'approval required';
      state.done = true;
      return;
    }
    case 'approval_resolved': {
      const decision = String(data.decision ?? 'resolved');
      state.status = decision === 'approved' ? 'approved — continuing' : 'rejected — stopping';
      // Buttons are no longer relevant; clear so the next flush drops them.
      state.pendingApprovalId = undefined;
      state.pendingApprovalIds = undefined;
      state.pendingApprovalEditable = undefined;
      return;
    }
    case 'condenser_applied': {
      // v0.5.10 — surface the post-compaction context fill so the user
      // sees the meter, not just the result. afterTokens is the most
      // recent post-Layer-1 (and post-Layer-2 if applied) estimate.
      const after = Number(data.afterTokens);
      const budget = Number(data.budgetTokens);
      if (Number.isFinite(after) && Number.isFinite(budget) && budget > 0) {
        state.contextPct = Math.max(0, Math.min(100, (after / budget) * 100));
      }
      return;
    }
    case 'run_resumed': {
      state.status = state.progressPresentation === 'quiet' ? 'working…' : 'resuming';
      return;
    }
    case 'guardrail_tripped': {
      // Guardrails are internal safety telemetry. They should stay in
      // the event log, but never replace the public Discord progress
      // line with implementation language like "guardrail".
      return;
    }
    case 'awaiting_user_input': {
      const question = String(data.question ?? 'waiting for your reply');
      state.summary = question;
      state.status = 'awaiting reply';
      // This is a typed pause-control event. The immediately-following
      // conversation_completed presentation is the sole terminal authority;
      // waiting for it prevents an early unsubscribe from dropping the final
      // committed question.
      state.done = false;
      return;
    }
    case 'conversation_completed': {
      state.asyncWorkDispatched = undefined;
      // Render priority: explicit `reply` (the user-facing message) over
      // `summary` (which loop.ts now also stuffs the reply into when
      // present, but defense-in-depth — if a producer somewhere forgets
      // the fallback, reading reply first still wins).
      const reply = typeof data.reply === 'string' && data.reply.trim() ? data.reply : '';
      const summary = humanHarnessText(reply || data.summary, state.summary);
      if (summary) state.summary = summary;
      const reason = data.reason ? String(data.reason) : '';
      const limitKind = typeof data.limitKind === 'string' && data.limitKind.trim()
        ? data.limitKind.trim()
        : '';
      if (isContinueCompletionReason(reason)) {
        state.status = `stopped: ${limitKind || 'continue'}`;
      } else if (reason === 'abandoned_by_orchestrator') {
        state.status = 'abandoned';
      } else if (reason === 'sub_agent_stalled') {
        state.status = 'stalled';
      } else {
        state.status = 'complete';
      }
      state.done = true;
      return;
    }
    case 'run_failed': {
      // Raw failure rows are private diagnostics. A stable typed
      // conversation_completed error follows for accepted turns and is the
      // only event allowed to settle or replace Discord's visible copy.
      return;
    }
    case 'conversation_limit_exceeded': {
      const reason = String(data.reason ?? 'limit');
      state.status = `stopped: ${reason}`;
      // Budget-limit telemetry is followed by a user-facing
      // conversation_completed continue prompt. Keep the live subscription open
      // so Discord does not finalize the message before that reply arrives.
      state.done = false;
      return;
    }
  }
}
