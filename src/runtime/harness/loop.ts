import type { Agent, AgentInputItem } from '@openai/agents';
import { Runner } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import { HarnessSession } from './session.js';
import { clearRunInFlightAfterTerminal } from './restart-recovery.js';
import { uncompensatedExternalWriteEvents } from './external-write-admission.js';
import {
  acceptUserInputForRun,
  appendAsyncWorkDispatchBatchClosedOnce,
  appendAsyncWorkDispatchedOnce,
  appendEvent,
  clearKill,
  getActiveRunAttempt,
  getLatestCanonicalTopLevelToolEvent,
  getLatestRunAttempt,
  getSession,
  isKillRequested,
  listEvents,
  listPendingAsyncWorkDispatchBatchClosedEvents,
  openEventLog,
  recentToolOutputs,
  resolveToolOutputsForAuthority,
  searchToolOutputs,
  type AppendEventInput,
  type EventRow,
  type KillRequestTarget,
  type SessionRow,
} from './eventlog.js';
import { destinationCardSuffix } from './destination-gate.js';
import {
  assertNotKilled,
  KillRequested,
  ToolTimeout,
  RecallBudget,
  ToolCallsCounter,
  ToolCallsLimitExceeded,
  ToolGuardrailEscalated,
  maxTurnsForRole,
  defaultToolCallsPerTurn,
  withHarnessRunContext,
  harnessRunContextStorage,
  harnessToolBracketsEnabled,
  startGate,
  type HarnessRunContext,
} from './brackets.js';
import {
  compactInFlightToolContext,
  compactSessionIfNeeded,
  compactionBudgetForModel,
  checkpointGoalStage,
} from './compaction.js';
import { windowScaleForModel } from './model-window-observations.js';
import {
  pullRecentTurnsForHarnessHistory,
  renderRecentActionsForHarnessHistory,
  renderTranscriptTurns,
} from './session-transcript.js';
import { selectReasoningEffort, dynamicReasoningEnabled, continuationClassifyEnabled } from './reasoning-effort.js';
import { buildCanonicalContextPack } from './canonical-context.js';
import { renderCapabilityResolutionForContext } from './capability-resolution.js';
import { recordPromptComposition, summarizePromptComposition } from './prompt-composition.js';
import {
  renderTurnOpennessForContext,
  resolveTurnOpenness,
  turnOpennessEnabled,
  turnOpennessWarranted,
} from './turn-openness.js';
import type { McpToolScope } from '../mcp-tool-scope.js';
import { boundAgentMcpToolScope } from '../mcp-tool-authority.js';
import { getHarnessBudgetSettings, getElevatedBudget } from './budget-settings.js';
import type { HarnessBudgetRuntime } from './budget-settings.js';
import {
  checkBudget,
  estimateMessagesTokens,
  estimateTokens,
  predictTurnCost,
} from './budget.js';
import { estimateInputTokens } from './token-estimator.js';
import { MODELS } from '../../config.js';
import { boundedAttemptResultIsTerminal, judgeObjectiveComplete, shouldRunObjectiveJudge, isPromiseShapedReply, isDirectionSeekingQuestion, composeJudgedObjective, type ObjectiveJudgeFn, type ObjectiveJudgeVerdict } from './objective-judge.js';
import { runWatcherJudge, shouldStartWatcherCheck, watcherCheckIntervalTools, watcherJudgeEnabled, MAX_WATCHER_INJECTIONS, MAX_WATCHER_CHECKS, type WatcherJudgeFn, type WatcherVerdict } from './watcher-judge.js';
import { verifyDelivered, verifyDeliveredEnabled, type DeliveryVerdict } from './verify-delivered.js';
import { synthesizeTurnReport } from './work-report.js';
import {
  PUBLIC_RUN_FAILURE_TEXT,
  publicAsyncWorkDispatchedData,
  publicReplyText,
} from './public-presentation.js';
import { commitTurnOutcome } from './delivery-committer.js';
import {
  turnOutcomeId,
  type PresentationEvent,
  type TurnIdentity,
  type TurnOutcome,
} from './turn-outcome.js';
import { CONVERGENCE_STEER, convergenceSteerEnabled, priorTurnEndedAwaitingClarification } from './convergence-steer.js';
import {
  getActiveGoalForSession,
  recordGoalValidation,
  satisfyGoal,
  touchGoalActivity,
  getCurrentGoalStage,
  advanceGoalStage,
  unparkGoal,
  GOAL_DEFAULT_MAX_ATTEMPTS,
  type PlanProposal,
} from '../../agents/plan-proposals.js';
import { validateGoal, toGoalEvidence, type GoalValidationResult, type ValidateGoalInput } from '../../execution/goal-validate.js';
import { recordVerdictEvent } from '../../execution/verdict.js';
import { gatherSessionSkills, summarizeToolCallsForJudge, skillExecutionShortfall } from './skill-execution.js';
import { isOutputGroundingGateEnabled, evaluateOutputGrounding, buildOutputGroundingChatRetry } from './output-grounding-gate.js';
import { classifyMessageIntent } from '../../assistant/message-intent.js';
import {
  attachEventLogHooks,
  extractSessionIdFromContext,
  unwrapEffectiveToolIdentity,
  type RunHooksLike,
} from './hooks.js';
import * as approvalRegistry from './approval-registry.js';
import { approvalAuthorityMatchesToolCall, exactApprovalAuthorityMatches } from './approval-authority.js';
import {
  pendingActionApprovalViewFromArgs,
  pendingActionIdFromArgs,
  type PendingActionApprovalView,
} from './pending-action-view.js';
import {
  isQueuedActionApprovalQuestion,
  materializeQueuedApprovals,
  queuedApprovalTransitionShouldMaterialize,
  queuedApprovalTransitionsForRequest,
} from './pending-action-transition.js';
import { actionBus } from '../action-bus.js';
import { addNotification } from '../notifications.js';
import { classifyCodexAuthError, markCodexAuthDead, isCodexAuthDead } from '../auth-store.js';
import { BoundaryError } from '../boundary-error.js';
import { classifyModelError } from './resilient-model.js';
import { getRuntimeEnv } from '../../config.js';
import { captureInteractionSignals } from '../../memory/auto-capture.js';
import {
  evaluateLearningCandidate,
  recordLearningDecision,
  type LearningReceipt,
} from '../../memory/learning-receipt.js';
import { refreshWorkingMemoryForSession } from '../../memory/working-memory.js';
import { isUserFacingSession } from '../../execution/scope.js';
import { handoffTransferForSource } from '../../execution/continuation-capsule.js';
import { primeTurnRecallVector, recordFactImpression, searchFactsByText } from '../../memory/facts.js';
import { appendFactRecallTrace } from '../../memory/recall-trace.js';
import { recordRecallRun } from '../../memory/recall-usage.js';
import { scheduleRecallShadow } from '../../memory/recall-shadow.js';
import {
  activateDispatchLease,
  captureDispatchRecoveryLedgerBaseline,
  checkDispatchRecoveryLedger,
  revokeDispatchLeaseBeforeRecovery,
  type DispatchLeaseRef,
} from './dispatch-lease.js';
import { listRecentEpisodicPointers } from '../../memory/reflection.js';
import { formatSearchHits, searchVault, searchVaultAsync } from '../../memory/search.js';
import { crossStoreBreadcrumbs } from '../../memory/unified-recall.js';
import { buildUnifiedTurnPrimer } from '../../memory/turn-primer.js';
import { extractFunctionCallArgTexts } from '../../memory/recall-auto-credit.js';
import { runPostTurnHooks } from './post-turn.js';
import {
  budgetLine,
  checkRunTokenWindow,
  formatTokens,
  openRunTokenWindow,
  recordRunTokenWindow,
  resolveRunTokenCeiling,
  runTokenBudgetEnforcementEnabled,
} from './run-token-budget.js';
import { ContentChantDetector, contentChantDetectionEnabled } from './content-chant-detector.js';
import { effectiveTurnObjective } from './turn-control.js';
import { recordTurnGraphShadow } from '../graph/turn-graph-shadow.js';
import { driveChatTurnSpine } from '../graph/chat-turn-spine.js';
import { getProactivityPolicySnapshot } from '../../agents/proactivity-policy.js';
import { claimGroundingNudge, extractDeliverablePointers, ungroundedPointers } from './claim-grounding.js';
import {
  getArtifactRootForSourceUserSeq,
  latestPendingArtifactRootForSession,
  listRunArtifacts,
  partitionSupersededPendingClaims,
  releaseClaimedArtifact,
  listUnverifiedRunArtifacts,
  resolveArtifactRunScopeId,
  type RunArtifact,
} from './artifact-ledger.js';
import {
  MISSING_REPLY_USER_FALLBACK,
  STRUCTURED_OUTPUT_RECOVERY_FALLBACK,
  STALL_OUTPUT_PATTERN,
  isPlainTextContractDirective,
  replyFulfillsVerbatimRequest,
  toOrchestratorDecision,
  evaluateStructuredDecisionStall,
  evaluateProgress,
  type StallInfo,
} from './turn-decision.js';
import {
  completionEvidenceToolName,
  eventBelongsToSourceUserSeq,
  freshExternalWriteEvidenceIsVerified,
  freshExternalWriteEvidenceStatus,
  hasMeaningfulSuccessfulToolNames,
  isAcceptedExecutionCompletionOutput,
  objectiveMayRequireMultipleResults,
  objectiveRequiresFreshExternalWrite,
  type FreshExternalWriteEvidenceStatus,
  toolOutputLooksSuccessful,
} from './tool-evidence.js';
import { summarizeWorkManifests } from './work-manifest.js';
// Turn-decision classification lives in turn-decision.ts (extracted 2026-07-08);
// re-export its public surface so existing importers of loop.js keep working.
export { isPlainTextContractDirective, toOrchestratorDecision, classifyTurnText } from './turn-decision.js';
import { looksLikeDispatchHandoffReply, steerTurnReplySalvage, textAwaitsUserMaterial, recoverySummaryReplyIsDeliverable } from './turn-decision.js';
import { judgeAmbiguousStallReply, stallIsJudgeAmbiguous } from './stall-judge.js';
export type { StallSignal, StallInfo } from './turn-decision.js';
import { peekStepResult, recordStepResultFromTranscript } from '../../tools/step-result-tool.js';
import { pairTransportMirrorToolCalls, projectCanonicalTopLevelToolEvents } from './tool-effect.js';
import {
  createWorkflowChatDispatchPreparedReceipt,
  createWorkflowOriginGroupCloseAuthority,
  createWorkflowOriginGroupClosedBatchReceipt,
  finalizeWorkflowOriginGroupClosedBatch,
  listWorkflowOriginGroupCloseIntents,
  readActiveWorkflowOriginGroup,
  reconcileActivatedWorkflowOriginGroups,
  recordWorkflowOriginGroupCloseIntent,
  recordWorkflowOriginGroupClosedBatch,
  withWorkflowOriginGroupAuthorityLock,
  workflowOriginSourceGroupId,
  type ActiveWorkflowOriginGroup,
  type WorkflowChatDispatchPreparationAuthority,
  type WorkflowChatDispatchPreparedReceipt,
  type WorkflowOriginGroupCloseAuthority,
  type WorkflowOriginGroupClosedBatchReceipt,
} from '../../execution/workflow-origin-group.js';
import { workflowOriginReplyTargetForSource } from '../workflow-origin-authority.js';
import {
  exactOriginDeliveryTargetDigest,
  sameExactOriginDeliveryTarget,
} from '../exact-origin-delivery.js';

/**
 * Wrap appendEvent so a transient SQLite write failure (lock, disk
 * full, etc.) inside the loop logs an error instead of unwinding the
 * whole turn and surfacing as an unhandled rejection. The event log
 * is observability, not load-bearing for the run's logical outcome —
 * losing one event entry is preferable to crashing the daemon.
 */
/** True when THIS turn placed a fire-and-forget background dispatch (a
 *  workflow_run call — direct, batch, or through the call_tool multiplexer).
 *  Effect-evidence for the dispatch-handoff reply salvage below; the tool
 *  result may still be a refusal, but a queued-or-refused dispatch is a REAL
 *  action either way — the reply narrates it, so it is never a zero-work punt. */
const DISPATCHING_TOOL_NAMES = new Set(['workflow_run', 'dispatch_background_task']);

function effectiveCalledToolName(data: Record<string, unknown>): string {
  const hasDurableIdentity = Object.prototype.hasOwnProperty.call(data, 'effectiveTool');
  const durableIdentity = typeof data.effectiveTool === 'string'
    ? data.effectiveTool.trim()
    : '';
  if (hasDurableIdentity) {
    return durableIdentity
      && data.accounting === 'top_level'
      && data.effect === 'read'
      ? durableIdentity
      : '';
  }
  const tool = typeof data.tool === 'string' ? data.tool : '';
  if (!tool) return '';
  return unwrapEffectiveToolIdentity(tool, data.arguments).toolName ?? '';
}

function turnDispatchedBackgroundRun(sessionId: string, turn?: number): boolean {
  try {
    const calls = listEvents(sessionId, { types: ['tool_called'], desc: true, limit: 200 })
      .filter((e) => turn === undefined || e.turn === turn);
    for (const e of calls) {
      if (DISPATCHING_TOOL_NAMES.has(effectiveCalledToolName(e.data))) return true;
    }
  } catch { /* evidence read is best-effort; absent = no salvage */ }
  return false;
}

function safeAppend(input: AppendEventInput): void {
  try {
    appendEvent(input);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[harness] failed to write event', {
      type: input.type,
      sessionId: input.sessionId,
      turn: input.turn,
      err: normalizeError(err),
    });
  }
}

interface StandardArtifactTerminalState {
  rootScopeId: string;
  artifacts: RunArtifact[];
  pending: RunArtifact[];
}

/** Read the exact durable artifact root owned by this accepted user event.
 * Candidate-only lineage is deliberately invisible: a normal read/chat turn
 * must not acquire an artifactRunScopeId merely because the loop resolved an
 * attempt scope. */
function standardArtifactTerminalState(
  sessionId: string,
  sourceUserSeq: number | undefined,
): StandardArtifactTerminalState | null {
  if (!Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) return null;
  const rootScopeId = getArtifactRootForSourceUserSeq(sessionId, sourceUserSeq as number);
  if (!rootScopeId) return null;
  const artifacts = listRunArtifacts(sessionId, rootScopeId);
  if (artifacts.length === 0) return null;
  return {
    rootScopeId,
    artifacts,
    pending: listUnverifiedRunArtifacts(sessionId, rootScopeId),
  };
}

function artifactVerificationProjection(state: StandardArtifactTerminalState): Record<string, unknown> {
  const pendingIds = new Set(state.pending.map((artifact) => artifact.id));
  return {
    artifactRunScopeId: state.rootScopeId,
    artifactVerification: {
      status: state.pending.length > 0 ? 'pending' : 'verified',
      total: state.artifacts.length,
      pending: state.pending.length,
      artifacts: state.artifacts.map((artifact) => ({
        artifactId: artifact.id,
        kind: artifact.kind,
        provider: artifact.provider,
        resourceId: artifact.resourceId,
        uri: artifact.uri,
        status: pendingIds.has(artifact.id) ? 'pending' : 'verified',
      })),
    },
  };
}

/** A standard-lane completion may not turn an unresolved provider create into
 * a green success. The Claude lane has a permission-bound exact-ID repair run;
 * this lane does not yet have an equally strict tool-only repair boundary, so
 * it parks honestly and asks for a retry instead of relying on prompt wording
 * that could accidentally create a replacement. */
/** Read-only view of the create claims that would park this request: still
 *  pending/uncertain, not superseded by a verified sibling, not bound. */
function trulyUnresolvedArtifactClaims(
  state: NonNullable<ReturnType<typeof standardArtifactTerminalState>>,
): typeof state.pending {
  const partition = partitionSupersededPendingClaims(state);
  const supersededIds = new Set(partition.superseded.map((a) => a.id));
  const stillPendingIds = new Set(partition.stillPending.map((a) => a.id));
  return state.pending.filter(
    (a) => stillPendingIds.has(a.id) && !supersededIds.has(a.id) && a.status !== 'bound',
  );
}

function standardTurnIdentity(input: {
  sessionId: string;
  turn: number;
  sourceUserSeq?: number;
}): TurnIdentity {
  const sourceUserSeq = Number.isSafeInteger(input.sourceUserSeq) && Number(input.sourceUserSeq) > 0
    ? Number(input.sourceUserSeq)
    : listEvents(input.sessionId, { types: ['user_input_received'], desc: true, limit: 1 })[0]?.seq;
  if (!sourceUserSeq) {
    throw new Error('Cannot commit a public turn outcome without an accepted user event.');
  }
  const accepted = listEvents(input.sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq === sourceUserSeq);
  if (!accepted) {
    throw new Error(`Accepted user event ${sourceUserSeq} is missing from session ${input.sessionId}.`);
  }
  // The logical turn identity is owned by the accepted user event, never by a
  // provider attempt or a later synthetic continuation. Two brains may finish
  // on different physical turns; both must still propose the same nested
  // identity for appendTerminalEventOnce's durable winner.
  return { sessionId: input.sessionId, turn: accepted.turn, sourceUserSeq };
}

function acceptedUserEvent(
  sessionId: string,
  sourceUserSeq: number,
): EventRow {
  const event = listEvents(sessionId, { types: ['user_input_received'] })
    .find((candidate) => candidate.seq === sourceUserSeq);
  if (!event) throw new Error(`Accepted user event ${sourceUserSeq} is missing from session ${sessionId}.`);
  return event;
}

function acceptExistingConversationInput(sessionId: string, sourceUserSeq: number): number {
  const accepted = acceptedUserEvent(sessionId, sourceUserSeq);
  return acceptUserInputForRun({
    sessionId,
    turn: accepted.turn,
    role: accepted.role,
    ...(accepted.parentEventId ? { parentEventId: accepted.parentEventId } : {}),
    data: accepted.data,
  }, { existingEventSeq: accepted.seq }).seq;
}

function acceptFreshConversationInput(options: RunConversationOptions): number {
  if (Number.isSafeInteger(options.sourceUserSeq) && (options.sourceUserSeq ?? 0) > 0) {
    return acceptExistingConversationInput(options.sessionId, Number(options.sourceUserSeq));
  }
  if (options.reuseRecordedUserInput) {
    const reused = listEvents(options.sessionId, { types: ['user_input_received'], desc: true, limit: 1 })[0];
    if (!reused) throw new Error('Cannot reuse a user input that was never durably accepted.');
    return acceptExistingConversationInput(options.sessionId, reused.seq);
  }
  const row = getSession(options.sessionId);
  if (!row) throw new Error(`unknown session: ${options.sessionId}`);
  return acceptUserInputForRun({
    sessionId: options.sessionId,
    turn: nextTurnNumber(row),
    role: 'user',
    data: { text: options.input },
  }).seq;
}

function approvalDecisionMatches(text: unknown, decision: 'approve' | 'reject' | 'approve_with_edits'): boolean {
  if (typeof text !== 'string') return false;
  const normalized = text.trim().toLowerCase();
  return decision === 'reject'
    ? /\b(?:reject|deny|decline|cancel|stop)\b/.test(normalized)
    : /\b(?:approve|approved|yes|confirm|go ahead|proceed)\b/.test(normalized);
}

function acceptResumeConversationInput(opts: {
  sessionId: string;
  sourceUserSeq?: number;
  approvalId?: string;
  decision: 'approve' | 'reject' | 'approve_with_edits';
}): number {
  const explicitApprovalId = opts.approvalId?.trim();
  if (explicitApprovalId) {
    const exact = listEvents(opts.sessionId, {
      types: ['user_input_received'],
      desc: true,
      limit: 200,
    }).filter((event) =>
      event.data.approvalId === explicitApprovalId
      && event.data.decision === opts.decision);
    if (exact.length > 1) {
      throw new Error(`Approval ${explicitApprovalId} has ambiguous accepted response ownership.`);
    }
    if (Number.isSafeInteger(opts.sourceUserSeq) && (opts.sourceUserSeq ?? 0) > 0) {
      const sourceUserSeq = Number(opts.sourceUserSeq);
      if (exact.length !== 1 || exact[0].seq !== sourceUserSeq) {
        throw new Error(`Accepted source ${sourceUserSeq} does not own approval ${explicitApprovalId}.`);
      }
      return acceptExistingConversationInput(opts.sessionId, sourceUserSeq);
    }
    if (exact.length === 1) return acceptExistingConversationInput(opts.sessionId, exact[0].seq);

    const row = getSession(opts.sessionId);
    if (!row) throw new Error(`unknown session: ${opts.sessionId}`);
    return acceptUserInputForRun({
      sessionId: opts.sessionId,
      turn: nextTurnNumber(row),
      role: 'user',
      data: {
        text: opts.decision === 'reject'
          ? `Reject ${explicitApprovalId}.`
          : `Approve ${explicitApprovalId}.`,
        displayText: opts.decision === 'reject'
          ? `Reject ${explicitApprovalId}`
          : `Approve ${explicitApprovalId}`,
        synthetic: true,
        source: 'approval_resume',
        decision: opts.decision,
        approvalId: explicitApprovalId,
      },
    }).seq;
  }
  if (Number.isSafeInteger(opts.sourceUserSeq) && (opts.sourceUserSeq ?? 0) > 0) {
    return acceptExistingConversationInput(opts.sessionId, Number(opts.sourceUserSeq));
  }
  const lastApprovalSeq = listEvents(opts.sessionId, { types: ['approval_requested'], desc: true, limit: 1 })[0]?.seq ?? 0;
  const attemptSource = (() => {
    try { return getLatestRunAttempt(opts.sessionId)?.sourceUserSeq; } catch { return undefined; }
  })();
  const candidates = listEvents(opts.sessionId, { types: ['user_input_received'], desc: true, limit: 20 });
  const alreadyAccepted = candidates.find((event) => {
    if (event.seq <= lastApprovalSeq) return false;
    if (attemptSource && event.seq === attemptSource) return true;
    const eventApprovalId = typeof event.data.approvalId === 'string' ? event.data.approvalId : undefined;
    if (opts.approvalId && eventApprovalId === opts.approvalId) return true;
    return approvalDecisionMatches(event.data.text, opts.decision);
  });
  if (alreadyAccepted) return acceptExistingConversationInput(opts.sessionId, alreadyAccepted.seq);

  const row = getSession(opts.sessionId);
  if (!row) throw new Error(`unknown session: ${opts.sessionId}`);
  // Button/notification resumes do not always arrive as chat text. Record the
  // accepted control edge explicitly so the resumed public terminal gets a new
  // durable idempotency key instead of overwriting the request that opened the
  // approval card. Synthetic keeps this control text out of the user transcript.
  return acceptUserInputForRun({
    sessionId: opts.sessionId,
    turn: nextTurnNumber(row),
    role: 'user',
    data: {
      text: opts.decision === 'reject' ? 'Reject the pending approval.' : 'Approve the pending action.',
      synthetic: true,
      source: 'approval_resume',
      decision: opts.decision,
      ...(opts.approvalId ? { approvalId: opts.approvalId } : {}),
    },
  }).seq;
}

/** Narrow test seam for exact approval-response source ownership. */
export const _acceptResumeConversationInputForTest = acceptResumeConversationInput;

function terminalQuestionText(result: RunConversationResult): string {
  const eventQuestion = (() => {
    try {
      const event = listEvents(result.sessionId, { types: ['awaiting_user_input'], desc: true, limit: 40 })
        .find((candidate) => candidate.turn === result.lastTurn);
      return event ? publicReplyText(event.data.question, '') : '';
    } catch { return ''; }
  })();
  return eventQuestion
    || publicReplyText(result.lastDecision?.reply, '')
    || publicReplyText(result.lastDecision?.summary, '')
    || 'I need your input before I can continue.';
}

function exactPendingApprovalForTerminal(input: {
  result: RunConversationResult;
  approvalIdHint?: string;
}): approvalRegistry.PendingApprovalRow | null {
  const candidateIds: string[] = [];
  if (input.approvalIdHint?.trim()) candidateIds.push(input.approvalIdHint.trim());
  try {
    for (const event of listEvents(input.result.sessionId, {
      types: ['approval_requested'],
      desc: true,
      limit: 80,
    })) {
      if (event.turn !== input.result.lastTurn) continue;
      const approvalId = typeof event.data.approvalId === 'string'
        ? event.data.approvalId.trim()
        : '';
      if (approvalId) candidateIds.push(approvalId);
    }
  } catch { /* no registry-backed event means question, never invented approval */ }

  const rows = [...new Set(candidateIds)]
    .map((approvalId) => approvalRegistry.get(approvalId))
    .filter((row): row is approvalRegistry.PendingApprovalRow => Boolean(
      row
      && row.sessionId === input.result.sessionId
      && approvalRegistry.isActionable(row),
    ));
  // A public approval outcome names one exact authority. Multiple candidates
  // need a choice question; selecting one implicitly would widen authority.
  return rows.length === 1 ? rows[0] : null;
}

function reduceStandardConversationTerminal(input: {
  result: RunConversationResult;
  sourceUserSeq: number;
  approvalIdHint?: string;
}): RunConversationResult {
  const { result, sourceUserSeq } = input;
  if (result.completedReason) return result;

  const identity = standardTurnIdentity({
    sessionId: result.sessionId,
    turn: result.lastTurn,
    sourceUserSeq,
  });
  if (result.publicPresentation) {
    const persisted = result.publicPresentation;
    if (
      persisted.identity.sessionId !== identity.sessionId
      || persisted.identity.turn !== identity.turn
      || persisted.identity.sourceUserSeq !== identity.sourceUserSeq
      || ('attemptId' in persisted.identity && Boolean(persisted.identity.attemptId))
      || persisted.identity.runId !== undefined
    ) {
      throw new Error('Persisted public presentation is not bound to the exact accepted standard turn.');
    }
    return result;
  }

  let outcome: TurnOutcome;
  let legacyReason: string;
  let transferredToTaskId: string | undefined;
  switch (result.status) {
    case 'dispatched':
      // A durable async edge is deliberately nonterminal. Callers must release
      // the foreground transport without manufacturing a TurnOutcome.
      throw new Error('An async dispatch cannot be reduced as a conversation terminal.');
    case 'completed': {
      let text = publicReplyText(result.lastDecision?.reply, '')
        || publicReplyText(result.lastDecision?.summary, '');
      if (!text) {
        try { text = synthesizeTurnReport(result.sessionId, sourceUserSeq) ?? ''; } catch { text = ''; }
      }
      outcome = {
        version: 2,
        id: turnOutcomeId(identity),
        identity,
        status: 'done',
        resumable: false,
        presentation: { kind: 'answer', text: text || MISSING_REPLY_USER_FALLBACK },
      };
      legacyReason = 'success';
      break;
    }
    case 'awaiting_approval': {
      const approval = exactPendingApprovalForTerminal({
        result,
        approvalIdHint: input.approvalIdHint,
      });
      const question = terminalQuestionText(result);
      if (approval) {
        const approvalText = publicReplyText(
          result.lastDecision?.reply,
          `Approval required for ${approval.subject}. Review ${approval.approvalId} to continue.`,
        );
        outcome = {
          version: 2,
          id: turnOutcomeId(identity),
          identity,
          status: 'needs_input',
          resumable: true,
          needs: { kind: 'approval' },
          presentation: { kind: 'approval', text: approvalText, approvalId: approval.approvalId },
        };
        legacyReason = 'awaiting_approval';
      } else {
        outcome = {
          version: 2,
          id: turnOutcomeId(identity),
          identity,
          status: 'needs_input',
          resumable: true,
          needs: { kind: 'input' },
          presentation: { kind: 'question', text: question },
        };
        legacyReason = 'awaiting_user_input';
      }
      break;
    }
    case 'awaiting_user_input':
      outcome = {
        version: 2,
        id: turnOutcomeId(identity),
        identity,
        status: 'needs_input',
        resumable: true,
        needs: { kind: 'input' },
        presentation: { kind: 'question', text: terminalQuestionText(result) },
      };
      legacyReason = 'awaiting_user_input';
      break;
    case 'limit_exceeded':
      outcome = {
        version: 2,
        id: turnOutcomeId(identity),
        identity,
        status: 'needs_input',
        resumable: true,
        needs: { kind: 'continue' },
        presentation: {
          kind: 'continue',
          text: 'This run reached its current budget with more work remaining. Reply `continue` to keep going.',
        },
      };
      legacyReason = 'awaiting_continue';
      break;
    case 'killed': {
      // A stop that handed this turn to a durable background owner is a
      // TRANSFER, not a cancellation: the work is still running elsewhere.
      const transfer = (() => {
        try { return handoffTransferForSource(result.sessionId, sourceUserSeq); } catch { return undefined; }
      })();
      outcome = transfer
        ? {
            version: 2,
            id: turnOutcomeId(identity),
            identity,
            status: 'transferred',
            resumable: false,
            presentation: { kind: 'transferred', text: transfer.text },
          }
        : {
            version: 2,
            id: turnOutcomeId(identity),
            identity,
            status: 'cancelled',
            resumable: false,
            presentation: {
              kind: 'stopped',
              text: 'Stopped — this turn was cancelled. Nothing further will execute.',
            },
          };
      legacyReason = transfer ? 'transferred' : 'cancelled';
      transferredToTaskId = transfer?.backgroundTaskId;
      break;
    }
    case 'failed':
      outcome = {
        version: 2,
        id: turnOutcomeId(identity),
        identity,
        status: 'failed',
        resumable: false,
        presentation: { kind: 'error', text: PUBLIC_RUN_FAILURE_TEXT },
      };
      legacyReason = 'failed';
      break;
  }

  const committed = commitTurnOutcome(outcome, {
    legacyReason,
    metadata: {
      steps: result.steps,
      ...(result.limitKind ? { limitKind: result.limitKind } : {}),
      ...(transferredToTaskId ? { transferredToTaskId } : {}),
    },
  });
  return { ...result, publicPresentation: committed.presentation };
}

function commitStandardNeedsInputTerminal(input: {
  sessionId: string;
  sourceUserSeq?: number;
  turn: number;
  text: string;
  need?: 'input' | 'continue';
  legacyReason?: string;
  metadata?: Record<string, unknown>;
}): PresentationEvent {
  const identity = standardTurnIdentity(input);
  const outcome: TurnOutcome = input.need === 'continue'
    ? {
        version: 2,
        id: turnOutcomeId(identity),
        identity,
        status: 'needs_input',
        resumable: true,
        needs: { kind: 'continue' },
        presentation: { kind: 'continue', text: input.text },
      }
    : {
        version: 2,
        id: turnOutcomeId(identity),
        identity,
        status: 'needs_input',
        resumable: true,
        needs: { kind: 'input' },
        presentation: { kind: 'question', text: input.text },
      };
  return commitTurnOutcome(outcome, {
    ...(input.legacyReason ? { legacyReason: input.legacyReason } : {}),
    metadata: input.metadata,
  }).presentation;
}

function commitStandardBlockedTerminal(input: {
  sessionId: string;
  sourceUserSeq?: number;
  turn: number;
  text: string;
  legacyReason?: string;
  metadata?: Record<string, unknown>;
}): PresentationEvent {
  const identity = standardTurnIdentity(input);
  return commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'blocked',
    resumable: true,
    presentation: { kind: 'blocked', text: input.text },
  }, {
    ...(input.legacyReason ? { legacyReason: input.legacyReason } : {}),
    metadata: input.metadata,
  }).presentation;
}

function commitStandardCancelledTerminal(input: {
  sessionId: string;
  sourceUserSeq?: number;
  turn: number;
  text: string;
  legacyReason?: string;
  metadata?: Record<string, unknown>;
}): PresentationEvent {
  const identity = standardTurnIdentity(input);
  return commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'cancelled',
    resumable: false,
    presentation: { kind: 'stopped', text: input.text },
  }, {
    ...(input.legacyReason ? { legacyReason: input.legacyReason } : {}),
    metadata: input.metadata,
  }).presentation;
}

function parkForPendingStandardArtifacts(input: {
  sessionId: string;
  sourceUserSeq?: number;
  turn: number;
  steps: number;
  summary: string;
  internalSummary?: string | null;
  reply?: string | null;
  lastDecision?: OrchestratorDecisionShape;
  lastTurn: number;
}): RunConversationResult | null {
  const state = standardArtifactTerminalState(input.sessionId, input.sourceUserSeq);
  if (!state || state.pending.length === 0) return null;
  // A dead mid-flight claim superseded by a VERIFIED same-kind sibling (the
  // sanctioned verification-retry re-create) is released instead of parking
  // the session forever — the verified sibling is the deliverable.
  const partition = partitionSupersededPendingClaims(state);
  const supersededIds = new Set(partition.superseded.map((a) => a.id));
  for (const dead of partition.superseded) {
    try { releaseClaimedArtifact(dead.id); } catch { /* stays pending fail-closed */ }
  }
  if (partition.stillPending.length === 0) return null;
  // BOUND claims are the deliverable (provider returned the resource — URI/ID
  // in hand); read-back verification pending is an ADVISORY the projection
  // already reports, never a completion wall. Only truly-unresolved claims
  // (pending/uncertain dispatch outcome — the double-create risk) park.
  const stillPendingIds = new Set(partition.stillPending.map((a) => a.id));
  const trulyUnresolved = state.pending.filter(
    (a) => stillPendingIds.has(a.id) && !supersededIds.has(a.id) && a.status !== 'bound',
  );
  if (trulyUnresolved.length === 0) return null;
  state.pending = trulyUnresolved;
  const exactResources = state.pending.map((artifact) => ({
    artifactId: artifact.id,
    kind: artifact.kind,
    provider: artifact.provider,
    resourceId: artifact.resourceId,
    uri: artifact.uri,
    status: artifact.status,
  }));
  const resourceLabel = state.pending.length === 1 ? 'artifact' : `${state.pending.length} artifacts`;
  const hasExactIds = state.pending.every((artifact) => Boolean(artifact.resourceId));
  const question = hasExactIds
    ? `The provider returned the ${resourceLabel}, but I could not independently read back the exact resource ID${state.pending.length === 1 ? '' : 's'} yet. Reply \"retry\" and I will verify the same resource ID${state.pending.length === 1 ? '' : 's'} without creating replacements.`
    : `The ${resourceLabel} create attempt is unresolved, so I cannot honestly confirm whether the provider created it. I will not create a replacement while that outcome is uncertain; reply \"retry\" to re-check the existing attempt or \"stop\" to leave it parked.`;
  const alreadyAsked = (() => {
    try {
      return listEvents(input.sessionId, { types: ['awaiting_user_input'] })
        .some((event) => event.turn === input.turn
          && (event.data as { source?: unknown }).source === 'artifact_verification_pending');
    } catch { return false; }
  })();
  if (!alreadyAsked) {
    safeAppend({
      sessionId: input.sessionId,
      turn: input.turn,
      role: 'Clem',
      type: 'awaiting_user_input',
      data: {
        question,
        options: ['Retry verification', 'Stop'],
        source: 'artifact_verification_pending',
        artifactRunScopeId: state.rootScopeId,
        pendingArtifacts: exactResources,
      },
    });
  }
  const publicPresentation = commitStandardNeedsInputTerminal({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    turn: input.turn,
    text: question,
    legacyReason: 'awaiting_user_input',
    metadata: {
      steps: input.steps,
      blockedReason: 'artifact_binding_verification_pending',
      ...artifactVerificationProjection(state),
    },
  });
  return {
    sessionId: input.sessionId,
    status: 'awaiting_user_input',
    steps: input.steps,
    lastDecision: input.lastDecision,
    lastTurn: input.lastTurn,
    publicPresentation,
  };
}

function finalizeStandardConversation(input: {
  sessionId: string;
  sourceUserSeq?: number;
  turn: number;
  eventData: Record<string, unknown>;
  result: RunConversationResult;
}): RunConversationResult {
  const summary = typeof input.eventData.summary === 'string'
    ? input.eventData.summary
    : 'The requested work is complete.';
  const parked = parkForPendingStandardArtifacts({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    turn: input.turn,
    steps: input.result.steps,
    summary,
    internalSummary: typeof input.eventData.internalSummary === 'string'
      ? input.eventData.internalSummary
      : null,
    reply: typeof input.eventData.reply === 'string' ? input.eventData.reply : null,
    lastDecision: input.result.lastDecision,
    lastTurn: input.result.lastTurn,
  });
  if (parked) return parked;
  const state = standardArtifactTerminalState(input.sessionId, input.sourceUserSeq);
  const dataOut: Record<string, unknown> = {
    ...input.eventData,
    ...(state ? artifactVerificationProjection(state) : {}),
  };
  // PLACEHOLDER EXTINCTION (live 2026-07-24): completions with nothing visible
  // rendered "(Done.)" / "(Finished without a written reply.)" in a real
  // conversation. A completion either reports its actual work (turn report) or
  // says something human — the client must never have to invent scaffolding.
  const hasVisibleText =
    (typeof dataOut.reply === 'string' && dataOut.reply.trim().length > 0) ||
    (typeof dataOut.summary === 'string' && dataOut.summary.trim().length > 0);
  if (!hasVisibleText) {
    let floor: string | null = null;
    try { floor = synthesizeTurnReport(input.sessionId, input.sourceUserSeq); } catch { floor = null; }
    dataOut.summary = (floor && floor.trim()) || MISSING_REPLY_USER_FALLBACK;
    dataOut.missingReply = true;
  }
  // Parse-exhaustion/stall results are recovery candidates, not public
  // outcomes. The bridge may safely transplant a write-free attempt to another
  // brain. Record the private execution state here; only the bridge's recovered
  // or blocked TurnOutcome may cross the public terminal boundary.
  if (input.result.completedReason) {
    safeAppend({
      sessionId: input.sessionId,
      turn: input.turn,
      role: 'system',
      type: 'conversation_recovery_candidate',
      data: {
        ...dataOut,
        reason: input.result.completedReason,
        sourceUserSeq: input.sourceUserSeq,
      },
    });
    return input.result;
  }
  const identity = standardTurnIdentity(input);
  const text = publicReplyText(dataOut.reply, '')
    || publicReplyText(dataOut.summary, '')
    || MISSING_REPLY_USER_FALLBACK;
  const legacyReason = typeof dataOut.reason === 'string'
    && /^[a-z0-9_]{1,80}$/.test(dataOut.reason)
    ? dataOut.reason
    : undefined;
  const committed = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text },
  }, {
    ...(legacyReason ? { legacyReason } : {}),
    metadata: dataOut,
  });
  return { ...input.result, publicPresentation: committed.presentation };
}

/** Pair an ordinary awaiting-user result with durable artifact lineage when
 * this turn owns artifacts. Calls with no artifacts remain byte-for-byte on
 * the existing event path (no extra terminal and no fake scope id). */
function commitStandardPauseTerminal(input: {
  sessionId: string;
  sourceUserSeq?: number;
  turn: number;
  steps: number;
  summary: string;
  reply?: string | null;
  delivered?: boolean;
}): void {
  const state = standardArtifactTerminalState(input.sessionId, input.sourceUserSeq);
  commitStandardNeedsInputTerminal({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    turn: input.turn,
    text: publicReplyText(input.reply, '') || publicReplyText(input.summary, '') || 'I need your input before I can continue.',
    legacyReason: 'awaiting_user_input',
    metadata: {
      steps: input.steps,
      ...(state ? artifactVerificationProjection(state) : {}),
    },
  });
}

function toolCallInput(data: Record<string, unknown>): unknown {
  const raw = data.args ?? data.arguments;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return undefined; }
}

function turnHasMeaningfulSuccessfulToolEvidence(
  sessionId: string,
  turn: number,
  objectiveText: string,
): boolean {
  try {
    const events = listEvents(sessionId).filter((event) => event.turn === turn);
    const returned = events.filter((event) => event.type === 'tool_returned');
    return events.some((event) => {
      if (event.type !== 'tool_called') return false;
      const tool = typeof event.data.tool === 'string' ? event.data.tool : '';
      if (!tool) return false;
      const callId = typeof event.data.callId === 'string' ? event.data.callId : '';
      const match = returned.find((candidate) => {
        const returnedId = typeof candidate.data.callId === 'string' ? candidate.data.callId : '';
        const returnedTool = typeof candidate.data.tool === 'string' ? candidate.data.tool : '';
        return callId ? returnedId === callId : returnedTool === tool;
      });
      if (!match) return false;
      if (!toolOutputLooksSuccessful(
        match.data.result ?? match.data.output,
        match.data.ok,
      )) return false;
      const evidenceName = completionEvidenceToolName(tool, toolCallInput(event.data));
      return hasMeaningfulSuccessfulToolNames([evidenceName], objectiveText);
    });
  } catch {
    return false;
  }
}

/** True only when the durable execution controller accepted completion after
 * the exact user-input row that owns this logical request. A prior turn's
 * completed execution cannot suppress verification for a new objective. */
function requestHasAcceptedExecutionCompletion(
  sessionId: string,
  sourceUserSeq: number | undefined,
): boolean {
  if (!Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) return false;
  try {
    return listEvents(sessionId, { types: ['tool_returned'] }).some((event) => {
      if (event.seq <= (sourceUserSeq as number)) return false;
      if (!eventBelongsToSourceUserSeq(event, sourceUserSeq as number)) return false;
      if ((event.data as { tool?: unknown } | undefined)?.tool !== 'execution_complete') return false;
      const data = event.data as { result?: unknown; output?: unknown; preview?: unknown };
      // Direct tools persist `result`; schema-on-demand call_tool dispatch
      // persists the exact inner execution as a transport-mirror event whose
      // accepted text is in `preview`. Both are the same controller verdict.
      return isAcceptedExecutionCompletionOutput(data.result ?? data.output ?? data.preview);
    });
  } catch {
    return false;
  }
}

function requestFreshExternalWriteStatus(
  sessionId: string,
  sourceUserSeq: number | undefined,
): FreshExternalWriteEvidenceStatus {
  try {
    return freshExternalWriteEvidenceStatus(
      listEvents(sessionId, {
        types: ['external_write', 'external_write_succeeded', 'external_write_failed', 'external_write_orphaned'],
      }),
      sourceUserSeq,
    );
  } catch {
    // External writes must never become a silent green when their durable
    // request-bound ledger is unavailable.
    return 'missing';
  }
}

const EXTERNAL_WRITE_LIFECYCLE_TYPES = [
  'external_write',
  'external_write_succeeded',
  'external_write_failed',
  'external_write_orphaned',
] as const;

/** True when events after this turn boundary prove or may imply an external
 * mutation. A reservation compensated by its exact proven-no-effect failure is
 * safe to retry on another brain; success, orphan, and unresolved reservation
 * evidence are not. Ledger read failure stays conservative. */
function externalWriteReplayRiskAfter(sessionId: string, boundarySeq: number): boolean {
  try {
    const events = listEvents(sessionId, {
      types: [...EXTERNAL_WRITE_LIFECYCLE_TYPES],
    }).filter((event) => event.seq > boundarySeq);
    if (events.some((event) =>
      event.type === 'external_write_succeeded' || event.type === 'external_write_orphaned')) {
      return true;
    }
    return uncompensatedExternalWriteEvents(
      events.filter((event) =>
        event.type === 'external_write' || event.type === 'external_write_failed'),
    ).length > 0;
  } catch {
    return true;
  }
}

function freshExternalWriteGapReason(status: Exclude<FreshExternalWriteEvidenceStatus, 'confirmed'>): string {
  if (status === 'ambiguous') {
    return 'this request has an ambiguous external-write outcome, so it must be reconciled read-only and must not be repeated or claimed complete';
  }
  if (status === 'failed') {
    return 'at least one external write required by this request failed; a successful receipt for a different action does not resolve that failure';
  }
  return 'there is no external-write receipt after the user event that owns this request; historical execution summaries and receipts do not count';
}

interface SelfReconciliationArtifactRequirement {
  id: string;
  slotKey: string;
  kind: RunArtifact['kind'];
  provider: string;
}

interface EffectArtifactSelfReconciliation {
  publicText: string | null;
  originalDecision: OrchestratorDecisionShape;
  originTurn: number;
  objective: string;
  artifactRequirements: SelfReconciliationArtifactRequirement[];
  ambiguousExternalWrite: boolean;
  externalWriteRequiredByObjective: boolean;
  completionVerdict: ObjectiveJudgeVerdict | null;
  skipDeliveryGate: boolean;
}

interface SelfReconciliationAssessment {
  status: 'settled' | 'ambiguous' | 'failed';
  reason: string;
  publicText: string;
  externalWriteStatus?: FreshExternalWriteEvidenceStatus;
}

/**
 * Decide from durable evidence only whether a self-reconciliation turn made
 * the ORIGINAL public candidate safe to release. The recovery model's prose
 * is deliberately absent from this contract: it may settle evidence, but it
 * cannot become a second author of the accepted turn's public answer.
 */
function assessEffectArtifactSelfReconciliation(input: {
  sessionId: string;
  sourceUserSeq: number | undefined;
  recovery: EffectArtifactSelfReconciliation;
}): SelfReconciliationAssessment {
  if (input.recovery.artifactRequirements.length > 0) {
    let state: StandardArtifactTerminalState | null = null;
    try { state = standardArtifactTerminalState(input.sessionId, input.sourceUserSeq); } catch { state = null; }
    if (!state) {
      return {
        status: 'failed',
        reason: 'artifact_reconciliation_has_no_bound_result',
        publicText: 'I could not confirm the artifact after read-only reconciliation. The original create claim is no longer enough to prove a deliverable exists, and no bound replacement is recorded, so I cannot call this complete.',
      };
    }
    for (const required of input.recovery.artifactRequirements) {
      const exact = state.artifacts.find((artifact) => artifact.id === required.id);
      const boundEquivalent = state.artifacts.find((artifact) =>
        artifact.slotKey === required.slotKey
        && artifact.kind === required.kind
        && artifact.provider === required.provider
        && artifact.status === 'bound');
      if (exact?.status === 'bound' || boundEquivalent) continue;
      if (exact || state.artifacts.some((artifact) =>
        artifact.slotKey === required.slotKey
        && artifact.kind === required.kind
        && artifact.provider === required.provider)) {
        return {
          status: 'ambiguous',
          reason: 'artifact_reconciliation_remains_unresolved',
          publicText: 'I cannot honestly confirm it was created yet — the attempt is still unresolved, and I did not create a duplicate. Say "check it" and I\'ll look at what actually happened, or if you can see it on your side, tell me and I\'ll continue from there.',
        };
      }
      return {
        status: 'failed',
        reason: 'artifact_reconciliation_found_no_deliverable',
        publicText: 'I could not confirm the artifact after read-only reconciliation. No bound artifact or verified replacement is recorded, so the original success answer cannot be published as complete.',
      };
    }
  }

  const externalWriteStatus = requestFreshExternalWriteStatus(
    input.sessionId,
    input.sourceUserSeq,
  );
  // Re-read the whole request ledger even for an artifact-only nudge: a
  // recovery turn that accidentally introduced a new maybe-landed write must
  // never become green merely because the original artifact was bound.
  if (
    externalWriteStatus === 'ambiguous'
    || (input.recovery.ambiguousExternalWrite && externalWriteStatus === 'missing')
  ) {
      return {
        status: 'ambiguous',
        reason: 'external_write_reconciliation_remains_ambiguous',
        publicText: 'I cannot honestly confirm that change went through — I checked without re-sending it, and the result is still unclear. I did not do it twice. Say "check it" and I\'ll verify what actually happened, or if you can see the result on your side, tell me and I\'ll continue from there.',
        externalWriteStatus,
      };
  }
  if (externalWriteStatus === 'failed' && input.recovery.externalWriteRequiredByObjective) {
    return {
      status: 'failed',
      reason: 'external_write_reconciliation_proved_incomplete',
      publicText: 'The reconciliation did not confirm the requested external write. It is recorded as absent or failed, so the original success answer cannot be published as complete.',
      externalWriteStatus,
    };
  }

  if (!input.recovery.publicText) {
    return {
      status: 'failed',
      reason: 'reconciliation_has_no_safe_public_candidate',
      publicText: 'The uncertainty was reconciled, but the original turn did not produce a safe user-facing answer. I will not expose the internal recovery response as the result.',
    };
  }
  return {
    status: 'settled',
    reason: 'effect_artifact_reconciliation_settled',
    publicText: input.recovery.publicText,
    ...(input.recovery.ambiguousExternalWrite || externalWriteStatus !== 'missing'
      ? { externalWriteStatus }
      : {}),
  };
}

/** An explicit user-memory candidate is persisted to the crash-safe intake
 * ledger before the model answers. That durable receipt is completion evidence
 * for a terse "Noted." even when the model correctly makes zero tool calls. */
function turnHasDurableMemoryCaptureEvidence(sessionId: string, turn: number): boolean {
  try {
    return listEvents(sessionId, { types: ['memory_signals_captured'] })
      .some((event) => event.turn === turn
        && Number((event.data as { queuedCandidateCount?: unknown }).queuedCandidateCount ?? 0) > 0);
  } catch {
    return false;
  }
}

/** Post-turn memory-credit hook: match this turn's recall runs (primer +
 *  tool-recorded) against what the turn actually produced and credit
 *  demonstrable use. Replaces the never-called memory_mark_used prompt rule
 *  with code. Best-effort — crediting must never fail the turn. */
function itemText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        if (typeof record.text === 'string') return record.text;
        if (typeof record.content === 'string') return record.content;
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

function normalizeReplaySearchText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function snapshotSearchText(items: AgentInputItem[]): string {
  return normalizeReplaySearchText(items.map((item) => {
    const record = item as { content?: unknown };
    const content = itemText(record.content);
    if (content.trim()) return content;
    try { return JSON.stringify(item); } catch { return ''; }
  }).filter(Boolean).join('\n'));
}

function snapshotIncludesTurn(snapshotText: string, turnText: string): boolean {
  const needle = normalizeReplaySearchText(turnText);
  if (!needle) return true;
  if (snapshotText.includes(needle)) return true;
  // Long assistant replies may be represented inside structured JSON or compacted
  // with suffixes stripped. A strong prefix match is enough to avoid duplicate
  // replay while still recovering genuinely missing Claude SDK turns.
  if (needle.length > 240 && snapshotText.includes(needle.slice(0, 240))) return true;
  return false;
}

function clipReplayFallback(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 30))}\n...[session history truncated]`;
}

function renderEventlogReplayFallback(sessionId: string, currentInput: string, snapshotItems: AgentInputItem[]): string {
  try {
    const db = openEventLog();
    const snapshotText = snapshotSearchText(snapshotItems);
    const actions = renderRecentActionsForHarnessHistory(db, sessionId);
    const turns = pullRecentTurnsForHarnessHistory(sessionId, 8);
    const current = currentInput.trim();
    const priorTurns = turns.length > 0 &&
      turns[turns.length - 1]?.who === 'user' &&
      turns[turns.length - 1]?.text.trim() === current
      ? turns.slice(0, -1)
      : turns;
    const missingTurns = priorTurns.filter((turn) => !snapshotIncludesTurn(snapshotText, turn.text));
    const parts = [
      actions,
      missingTurns.length > 0
        ? `Recent transcript missing from the persisted SDK snapshot for ${sessionId}:\n${renderTranscriptTurns(missingTurns)}`
        : '',
    ].filter(Boolean);
    return parts.length > 0 ? clipReplayFallback(parts.join('\n\n'), 8_000) : '';
  } catch {
    return '';
  }
}

/**
 * Adaptive prior estimator for the pre-flight budget gate.
 *
 * Scans the LAST N completed turns' tool_called + tool_returned events
 * to compute realistic priors for THIS session's tool behavior:
 *   - plannedToolCallCount: MAX tool calls seen in any single recent
 *     turn, with a safety factor. If a session ever fired 6 parallel
 *     calls, we assume the next turn might too.
 *   - avgToolReturnTokens: MAX avg-per-turn return size seen, also
 *     with safety factor. A session that returned 15K-per-call last
 *     turn won't surprise the gate next turn.
 *
 * Falls back to conservative static defaults when the session has no
 * tool history yet (first few turns of a fresh conversation). Bounded
 * lookback (last 3 turns) keeps the scan cheap — no full session walk.
 */
const PRIOR_LOOKBACK_TURNS = 3;
const PRIOR_MAX_EVENTS = 200; // safety cap on listEvents pull
export function inferTurnPriors(
  sessionId: string,
  currentTurn: number,
  opts: { fallbackToolCount: number; fallbackAvgReturn: number; safetyFactor: number },
): { plannedToolCallCount: number; avgToolReturnTokens: number } {
  try {
    // Pull recent events from this session. Most-recent-first ordering
    // would be ideal but listEvents returns ascending by seq; we just
    // grab the tail by capping pull size.
    const events = listEvents(sessionId);
    if (events.length === 0) {
      return {
        plannedToolCallCount: opts.fallbackToolCount,
        avgToolReturnTokens: opts.fallbackAvgReturn,
      };
    }
    // Bucket by turn number, then keep only the last PRIOR_LOOKBACK_TURNS.
    const minTurn = Math.max(0, currentTurn - PRIOR_LOOKBACK_TURNS);
    const recentEvents = projectCanonicalTopLevelToolEvents(events)
      .slice(-PRIOR_MAX_EVENTS)
      .filter((e) => typeof e.turn === 'number' && e.turn >= minTurn && e.turn < currentTurn);
    if (recentEvents.length === 0) {
      return {
        plannedToolCallCount: opts.fallbackToolCount,
        avgToolReturnTokens: opts.fallbackAvgReturn,
      };
    }
    const callsByTurn = new Map<number, number>();
    const returnSizesByTurn = new Map<number, number[]>();
    for (const ev of recentEvents) {
      const t = ev.turn ?? 0;
      if (ev.type === 'tool_called') {
        callsByTurn.set(t, (callsByTurn.get(t) ?? 0) + 1);
      } else if (ev.type === 'tool_returned') {
        const dataJson = JSON.stringify(ev.data ?? {});
        const tokens = estimateTokens(dataJson);
        const bucket = returnSizesByTurn.get(t) ?? [];
        bucket.push(tokens);
        returnSizesByTurn.set(t, bucket);
      }
    }
    let maxCalls = 0;
    for (const c of callsByTurn.values()) maxCalls = Math.max(maxCalls, c);
    let maxAvgReturn = 0;
    for (const sizes of returnSizesByTurn.values()) {
      if (sizes.length === 0) continue;
      const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
      maxAvgReturn = Math.max(maxAvgReturn, avg);
    }
    // Apply safety factor, fall back to defaults when no signal.
    const adaptiveCalls = maxCalls > 0
      ? Math.ceil(maxCalls * opts.safetyFactor)
      : opts.fallbackToolCount;
    const adaptiveAvgReturn = maxAvgReturn > 0
      ? Math.ceil(maxAvgReturn * opts.safetyFactor)
      : opts.fallbackAvgReturn;
    return {
      plannedToolCallCount: Math.max(adaptiveCalls, opts.fallbackToolCount),
      avgToolReturnTokens: Math.max(adaptiveAvgReturn, opts.fallbackAvgReturn),
    };
  } catch {
    // Adaptive estimation is best-effort. Any failure → static priors.
    return {
      plannedToolCallCount: opts.fallbackToolCount,
      avgToolReturnTokens: opts.fallbackAvgReturn,
    };
  }
}

/**
 * Register pending approvals in the approval-registry and emit the
 * `approval_requested` events with the approval ID inlined into the
 * event data. The two emit sites (runTurn at ~530, resumePendingApproval
 * at ~742) used to inline this; consolidated here so both surfaces stay
 * in sync. The registry write is best-effort — if it fails (e.g. table
 * missing on a pre-migration DB), the event still emits so the existing
 * "is paused?" check based on loadInterruptState keeps working.
 *
 * Returns the array of approval IDs (one per interruption) so the
 * caller can include them in the user-facing prompt body.
 */
/** A human-facing recipient-grounding warning for the approval card, built from
 *  the `recipient_set_omission_advisory` the recipient gate emitted for this
 *  send. The 2026-07-19 incident's card said only "1st Team Meet up! — 8
 *  attendees" and hid the dropped/fabricated recipients, so it was approved
 *  blind. This makes the omission impossible to miss at the moment of approval.
 *  Best-effort — never throws, never blocks an approval. */
export function recipientGroundingNote(sessionId: string, interruption: InterruptionInfo): string | null {
  try {
    const events = listEvents(sessionId, { types: ['guardrail_tripped'], desc: true, limit: 12 });
    const matches = events.filter((e) =>
      (e.data as { kind?: unknown })?.kind === 'recipient_set_omission_advisory'
      && ((e.data as { toolName?: unknown })?.toolName === interruption.toolName || !interruption.toolName));
    const advisory = matches[matches.length - 1];
    if (!advisory) return null;
    const omitted = Array.isArray(advisory.data?.omittedRecipients) ? advisory.data.omittedRecipients as string[] : [];
    const recipients = Array.isArray(advisory.data?.recipients) ? advisory.data.recipients as string[] : [];
    if (omitted.length === 0) return null;
    const total = recipients.length + omitted.length;
    const preview = omitted.slice(0, 5).join(', ') + (omitted.length > 5 ? ', …' : '');
    return `⚠ Recipients: sending to ${recipients.length} of ${total} on the roster — OMITS ${omitted.length} (${preview}). Confirm this is intentional before approving.`;
  } catch {
    return null;
  }
}

/**
 * Reuse only the card currently linked to this exact queued action. The
 * display fields on the pending-action record change when registration links
 * the card (queued → approval_requested, approvalId null → populated), so
 * regenerating the view before exact-args dedupe would mint a second card for
 * the same payload. The card's stored snapshot is the immutable authority;
 * id/session/tool/payloadHash must all still match the live record.
 */
function exactLinkedPendingActionApproval(
  sessionId: string,
  toolName: string,
  pendingActionId: string | null,
  current: PendingActionApprovalView | undefined,
): approvalRegistry.PendingApprovalRow | null {
  if (
    !pendingActionId
    || !current
    || current.id !== pendingActionId
    || typeof current.approvalId !== 'string'
    || !current.approvalId.trim()
  ) return null;

  try {
    const row = approvalRegistry.get(current.approvalId);
    const pinned = row?.args?.pendingAction;
    if (
      !row
      || !approvalRegistry.isActionable(row)
      || row.sessionId !== sessionId
      || row.tool !== toolName
      || row.approvalId !== current.approvalId
      || pendingActionIdFromArgs(row.args) !== pendingActionId
      || !pinned
      || typeof pinned !== 'object'
      || Array.isArray(pinned)
    ) return null;
    const snapshot = pinned as Record<string, unknown>;
    return snapshot.id === pendingActionId
      && snapshot.toolName === current.toolName
      && snapshot.payloadHash === current.payloadHash
      ? row
      : null;
  } catch {
    return null;
  }
}

function registerAndEmitApprovals(
  options: { sessionId: string; turn: number },
  session: HarnessSession,
  interruptions: InterruptionInfo[],
): string[] {
  const approvalIds: string[] = [];
  const channel = session.sessionRow.channel ?? null;
  const metadata = session.sessionRow.metadata ?? {};
  const channelId = typeof metadata.channelId === 'string'
    ? metadata.channelId
    : typeof metadata.discordChannelId === 'string'
      ? metadata.discordChannelId
      : null;
  const workflowName = typeof metadata.workflowName === 'string' ? metadata.workflowName : null;
  const stepId = typeof metadata.stepId === 'string' ? metadata.stepId : null;
  for (const interruption of interruptions) {
    const pendingActionId = pendingActionIdFromArgs(interruption.args);
    const pendingActionSnapshot = pendingActionId
      ? pendingActionApprovalViewFromArgs(interruption.args)
      : undefined;
    const linkedExactApproval = exactLinkedPendingActionApproval(
      options.sessionId,
      interruption.toolName,
      pendingActionId,
      pendingActionSnapshot,
    );
    // request_approval is an SDK interruption: its tool body never executes.
    // Enrich the raw model args here, before dedupe or persistence, so the
    // registry owns an independent immutable copy of the exact queued action.
    // The executor verifies this snapshot under the APPROVED→EXECUTING lock.
    const approvalArgs = linkedExactApproval?.args ?? (
      interruption.args && pendingActionSnapshot?.id === pendingActionId
        ? {
            ...interruption.args,
            pendingAction: pendingActionSnapshot,
          }
        : interruption.args
    );
    const baseSubject = extractApprovalSubject(interruption);
    const groundingNote = recipientGroundingNote(options.sessionId, interruption);
    const subject = groundingNote ? `${baseSubject}\n${groundingNote}` : baseSubject;
    let approvalId: string | null = null;
    try {
      const authority = {
        approvalId: '',
        sessionId: options.sessionId,
        tool: interruption.toolName,
        args: approvalArgs ?? null,
        resumeKey: null,
      };
      // A partial RunState resume can surface the still-unresolved sibling
      // interruption again. Reuse its exact pending card instead of minting a
      // duplicate; a changed payload intentionally receives a fresh card.
      const existingExact = linkedExactApproval ?? approvalRegistry.listPending({
        sessionId: options.sessionId,
        status: 'pending',
      }).find((candidate) => exactApprovalAuthorityMatches(candidate, authority));
      const row = existingExact ?? approvalRegistry.register({
        sessionId: options.sessionId,
        channel,
        channelId,
        subject,
        tool: interruption.toolName,
        args: approvalArgs ?? null,
      });
      approvalId = row.approvalId;
      // Fan out to the notification delivery queue so every enabled
      // destination (Discord DMs, web_push subscriptions on the mobile
      // PWA, generic webhooks) hears about the new approval. The
      // dedupe in addNotification keys on the stable approvalId
      // metadata so multiple harness turns registering the same
      // approval don't spam.
      if (!existingExact) {
        try {
          addNotification({
            id: `approval-${row.approvalId}`,
            kind: 'approval',
            title: 'Approval pending',
            body: subject || (interruption.toolName ? `${interruption.toolName} needs approval` : 'A tool call is paused waiting for your decision.'),
            createdAt: new Date().toISOString(),
            read: false,
            metadata: {
              approvalId: row.approvalId,
              tool: interruption.toolName,
              sessionId: options.sessionId,
              workflowName,
              stepId,
              // When this approval came from a live Discord conversation,
              // the Discord harness transport already attaches Approve/
              // Reject buttons INLINE on the conversational reply
              // (discord-harness.ts `approval_requested`). Flag the
              // notification so the notification-delivery queue does NOT
              // post a SECOND Discord approval card for the same id — that
              // duplicate is what produced "double approvals in Discord"
              // (desktop only renders the notification surface, so it never
              // doubled). Other destinations (web_push/PWA, dashboard) and
              // non-Discord channels are unaffected.
              discordInlineHandled: channel === 'discord' && Boolean(channelId),
            },
          });
        } catch (notifyErr) {
          // Notification failures must not break the approval pause —
          // the approval still lives in approvalRegistry and the
          // dashboard surfaces it.
          console.error('[harness] addNotification for approval failed', {
            approvalId: row.approvalId,
            error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
          });
        }
      }
    } catch (err) {
      // Best-effort. The hot-patch flow today exercises a DB where the
      // table may be missing if migrations didn't run yet; we don't
      // want to fail the whole approval pause on a registry write.
      console.error('[harness] approval-registry.register failed (continuing without ID)', {
        sessionId: options.sessionId,
        error: normalizeError(err),
      });
    }
    if (approvalId) approvalIds.push(approvalId);
    safeAppend({
      sessionId: options.sessionId,
      turn: options.turn,
      role: 'Clem',
      type: 'approval_requested',
      data: {
        tool: interruption.toolName,
        subject,
        args: approvalArgs,
        rawArgs: interruption.rawArgs,
        pendingAction: linkedExactApproval?.args?.pendingAction
          ?? pendingActionSnapshot
          ?? pendingActionApprovalViewFromArgs(approvalArgs),
        approvalId, // null when registry write failed; consumers fall
                    // back to old "single pending approval" routing.
      },
    });
  }
  return approvalIds;
}

/**
 * The harness loop — `runTurn(options)`.
 *
 * One call:
 *   1. Loads the session and computes the next turn number.
 *   2. Checks the kill switch (pre-flight).
 *   3. Records the user input as an event + HarnessSession update.
 *   4. Wires brackets (tool-calls counter, future token budget) and
 *      hooks (event-log writer) onto a Runner.
 *   5. Calls `runner.run(agent, items, opts)` with the replayed
 *      history and any `previousResponseId` for Responses-API state
 *      reuse.
 *   6. If the run completes: snapshots history + lastResponseId on
 *      the session, emits `run_completed`, marks status `completed`.
 *   7. If the run hits an interruption (approval): saves a serialized
 *      RunState to the session and returns `awaiting_approval`; the
 *      caller resumes via `resumeTurn` after the approval is resolved.
 *   8. If the run throws a bracket error (kill, tool cap): emits
 *      `guardrail_tripped`, marks status, returns the appropriate
 *      terminal kind.
 *
 * The Runner factory and the run executor are both injection points
 * so unit tests can drive the loop without spending tokens.
 */

export interface InterruptionInfo {
  /** Tool name the model wanted to call (e.g. `request_approval`). */
  toolName: string;
  /** Parsed arguments the model passed to the tool, when JSON-decodable. */
  args: Record<string, unknown> | null;
  /** Raw argument string, untouched. */
  rawArgs: string;
}

export interface RunOutcome {
  history: AgentInputItem[];
  lastResponseId: string | undefined;
  finalOutput: unknown;
  /** Raw SDK model responses. Used only for flag-only native Codex compaction research. */
  rawResponses?: unknown[];
  /** Serialized RunState for interrupt-resume; only set when paused. */
  serializedState?: string;
  /** True when the underlying RunResult had interruptions[]. */
  hasInterruptions?: boolean;
  /** Per-interruption details, extracted from RunToolApprovalItem.rawItem. */
  interruptions?: InterruptionInfo[];
}

export type RunRunnerFn = (
  runner: Runner,
  agent: Agent<any, any>,
  items: AgentInputItem[],
  opts: Record<string, unknown>,
) => Promise<RunOutcome>;

/** Keep a hallucinated or stale deferred tool name inside the model loop. The
 * SDK's default raises and kills the run; returning this correction lets the
 * model discover the current schema and dispatch through the bounded generic
 * carrier on its very next iteration. */
export function formatMissingToolForModel(input: {
  kind?: unknown;
  toolName?: unknown;
  defaultMessage?: unknown;
}): string | undefined {
  if (input.kind !== 'tool_not_found') return undefined;
  const name = typeof input.toolName === 'string' && input.toolName.trim()
    ? input.toolName.trim()
    : 'that tool';
  const fallback = typeof input.defaultMessage === 'string' && input.defaultMessage.trim()
    ? input.defaultMessage.trim()
    : `Tool '${name}' not found.`;
  return `${fallback} Do not retry ${name} directly. Use tool_search to retrieve the current schema, then invoke it through call_tool(name, args_json). If it is not returned by tool_search, choose an advertised tool instead.`;
}

interface NativeCompactionRewrite {
  history: AgentInputItem[];
  applied: boolean;
  previousItems: number;
  nextItems: number;
  compactionItemsSeen: number;
  latestCompactionId: string | null;
  latestCompactionBytes: number;
  preservedAssistantMessage: boolean;
}

function isHarnessNativeCodexCompactionEnabled(): boolean {
  const value = (process.env.CLEMMY_CODEX_NATIVE_COMPACTION ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on';
}

function getItemType(item: unknown): string | null {
  return item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string'
    ? (item as { type: string }).type
    : null;
}

function getNativeCompactionEncryptedContent(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const row = item as { encrypted_content?: unknown; encryptedContent?: unknown };
  if (typeof row.encrypted_content === 'string' && row.encrypted_content.length > 0) {
    return row.encrypted_content;
  }
  if (typeof row.encryptedContent === 'string' && row.encryptedContent.length > 0) {
    return row.encryptedContent;
  }
  return null;
}

function normalizeNativeCompactionItem(item: unknown): AgentInputItem | null {
  if (getItemType(item) !== 'compaction') return null;
  const encryptedContent = getNativeCompactionEncryptedContent(item);
  if (!encryptedContent) return null;
  const row = item as {
    id?: unknown;
    created_by?: unknown;
    createdBy?: unknown;
    providerData?: unknown;
  };
  return {
    type: 'compaction',
    id: typeof row.id === 'string' ? row.id : undefined,
    encrypted_content: encryptedContent,
    created_by:
      typeof row.created_by === 'string'
        ? row.created_by
        : typeof row.createdBy === 'string'
          ? row.createdBy
          : undefined,
    providerData: row.providerData && typeof row.providerData === 'object' ? row.providerData : undefined,
  } as unknown as AgentInputItem;
}

function extractNativeCompactionItems(rawResponses: unknown[] | undefined): AgentInputItem[] {
  if (!Array.isArray(rawResponses)) return [];
  const out: AgentInputItem[] = [];
  for (const response of rawResponses) {
    const output = response && typeof response === 'object'
      ? (response as { output?: unknown }).output
      : undefined;
    if (!Array.isArray(output)) continue;
    for (const item of output) {
      const compacted = normalizeNativeCompactionItem(item);
      if (compacted) out.push(compacted);
    }
  }
  return out;
}

function findLatestAssistantMessage(history: AgentInputItem[]): AgentInputItem | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i] as { type?: unknown; role?: unknown } | undefined;
    if (!item || typeof item !== 'object') continue;
    const type = typeof item.type === 'string' ? item.type : null;
    if ((type === 'message' || type == null) && item.role === 'assistant') {
      return history[i];
    }
  }
  return null;
}

function findLatestNewAssistantMessage(history: AgentInputItem[], previousItemCount: number): AgentInputItem | null {
  const start = Math.max(0, Math.min(previousItemCount, history.length));
  return findLatestAssistantMessage(history.slice(start));
}

export function rewriteHistoryWithNativeCompaction(
  history: AgentInputItem[],
  rawResponses: unknown[] | undefined,
): NativeCompactionRewrite {
  const previousItems = history.length;
  if (!isHarnessNativeCodexCompactionEnabled()) {
    return {
      history,
      applied: false,
      previousItems,
      nextItems: history.length,
      compactionItemsSeen: 0,
      latestCompactionId: null,
      latestCompactionBytes: 0,
      preservedAssistantMessage: false,
    };
  }

  const compactionItems = extractNativeCompactionItems(rawResponses);
  if (compactionItems.length === 0) {
    return {
      history,
      applied: false,
      previousItems,
      nextItems: history.length,
      compactionItemsSeen: 0,
      latestCompactionId: null,
      latestCompactionBytes: 0,
      preservedAssistantMessage: false,
    };
  }

  const latestCompaction = compactionItems[compactionItems.length - 1];
  const latestAssistant = findLatestAssistantMessage(history);
  const nextHistory = latestAssistant
    ? [latestCompaction, latestAssistant]
    : [latestCompaction];
  const latest = latestCompaction as { id?: unknown; encrypted_content?: unknown; encryptedContent?: unknown };
  const encryptedContent = getNativeCompactionEncryptedContent(latestCompaction) ?? '';
  return {
    history: nextHistory,
    applied: true,
    previousItems,
    nextItems: nextHistory.length,
    compactionItemsSeen: compactionItems.length,
    latestCompactionId: typeof latest.id === 'string' ? latest.id : null,
    latestCompactionBytes: Buffer.byteLength(encryptedContent, 'utf8'),
    preservedAssistantMessage: Boolean(latestAssistant),
  };
}

export interface RunTurnOptions {
  agent: Agent<any, any>;
  sessionId: string;
  input: string;
  /** The real user-authored text when `input` includes a harness directive.
   * Used for memory capture, semantic recall, correction detection, and durable
   * user history so internal steering can never become learned memory. */
  authoritativeUserInput?: string;
  maxTurns?: number;
  toolCallsPerTurn?: number;
  /** Test injection: build the Runner. Defaults to a fresh real Runner. */
  makeRunner?: () => Runner;
  /** Test injection: run the Runner. Defaults to a real runner.run(). */
  runRunner?: RunRunnerFn;
  /** @deprecated Raw executor deltas are private. Retained temporarily for API
   * compatibility; terminal delivery occurs through committed public events. */
  onChunk?: (delta: string) => void | Promise<void>;
  /** Set on continuation steps (step > 1) so auto-memory never learns from the
   *  harness's own synthetic re-prompts (judge/stall/grounding/YOLO). Only the
   *  first turn carries a real user message. (2026-06-23 fact-pollution fix.) */
  suppressMemoryCapture?: boolean;
  /** See RunConversationOptions.reuseRecordedUserInput. */
  reuseRecordedUserInput?: boolean;
  /** Exact accepted source event owned by this logical user request. */
  sourceUserSeq?: number;
  /** Durable outer request attempt. Internal provider retries remain children
   * of this identity and lose authority when it reaches a terminal state. */
  runAttemptId?: string;
  /** W1a: when true, a TRANSIENT model/codex error returns `infraTransientKind`
   *  WITHOUT writing the infra-recovery ask, so runConversation can attempt
   *  cross-brain fallover first. Off (default) = today's behavior verbatim. */
  deferInfraAsk?: boolean;
  /** Exact external MCP authority for this run. When omitted, the agent's
   * construction-time binding wins, then the canonical turn scope. */
  mcpToolScope?: McpToolScope | null;
}

export type RunTurnStatus = 'completed' | 'awaiting_approval' | 'awaiting_user_input' | 'killed' | 'limit_exceeded' | 'failed';

export interface RunTurnResult {
  sessionId: string;
  turn: number;
  status: RunTurnStatus;
  finalOutput?: unknown;
  error?: string;
  /** How many tool/handoff calls fired during this turn. Used by the
   *  outer loop to detect sub-agent stalls (zero tools + short generic
   *  output = the model punted on the directive). */
  toolCalls?: number;
  /** W1a chat step-boundary fallover: set to the BoundaryError kind when the turn
   *  failed on a TRANSIENT model/codex error AND the caller asked to defer the
   *  infra ask (deferInfraAsk) so it can try cross-brain fallover first. The ask
   *  event is NOT written in this case — runConversation decides switch-vs-ask. */
  infraTransientKind?: string;
  /** The deferred ask's user-facing message, so the exhausted-fallover path emits
   *  the byte-identical ask the direct path would have. */
  infraTransientUserMessage?: string;
  /** UNATTENDED self-heal (workflow/background): an infra error that would ask an
   *  absent human instead auto-retries. The outer loop re-runs the SAME step with
   *  `directive` (bounded by decideInfraRecovery). Never written for attended runs. */
  infraAutoRetry?: { kind: string; directive: string };
}

// ---------- runConversation ----------
//
// One call to runTurn() ends when the Orchestrator emits its
// structured output. For a multi-step workflow ("find 20 accounts,
// scrape, sheet, schedule emails") that single turn isn't enough —
// the Orchestrator's job is to decide the NEXT step, hand off, and
// only mark itself done when the whole user request is fulfilled.
//
// runConversation() wraps runTurn() in an auto-continuation loop:
//
//   - First call uses the user's input.
//   - Each subsequent call uses a continuation nudge so the
//     Orchestrator picks the next step from the persisted history.
//   - The loop stops when:
//       (a) OrchestratorDecision.done === true → completed
//       (b) nextAction asks for user/approval → paused
//       (c) maxSteps exceeded → limit_exceeded
//       (d) wall-clock budget exceeded → limit_exceeded
//       (e) any turn returned non-completed status (failed/killed
//           /awaiting_approval) → propagate
//
// Each step boundary records a `conversation_step` event so the
// SSE stream can show the user "step 2 of plan: scrape accounts"
// in real time.

export interface OrchestratorDecisionShape {
  summary: string;
  /** Natural-language reply to show the user this turn. Null when the
   *  Orchestrator is handing off or otherwise not producing the
   *  user-visible text itself. When present and non-empty, this is
   *  what the chat/Discord surface renders — not `summary`. */
  reply?: string | null;
  done: boolean;
  nextAction:
    | 'awaiting_user_input'
    | 'awaiting_approval'
    | 'awaiting_handoff_result'
    | 'completed'
    | 'abandoned';
  reason?: string | null;
}

export type RunConversationStatus =
  | 'completed'
  | 'dispatched'
  | 'awaiting_user_input'
  | 'awaiting_approval'
  | 'killed'
  | 'limit_exceeded'
  | 'failed';

export interface RunConversationOptions {
  /** Pre-built agent. Optional when `buildAgent` is supplied — the spine's
   *  capability_resolve node then owns construction (Clem 4, capability
   *  interior). Exactly one of `agent`/`buildAgent` is required. */
  agent?: Agent<any, any>;
  /** Build the agent AT the capability_resolve node instead of before the
   *  turn — tool/capability assembly becomes graph work with a real trace
   *  step. Invoked exactly once per turn, before any model call. */
  buildAgent?: () => Promise<Agent<any, any>>;
  sessionId: string;
  input: string;
  /** Max auto-continuation hops. Defaults to 12. */
  maxSteps?: number;
  /** Wall-clock budget across all hops. Defaults to 30 minutes. */
  maxWallClockMs?: number;
  /** Forwarded to each underlying runTurn(). */
  maxTurns?: number;
  /** Forwarded to each underlying runTurn(). */
  toolCallsPerTurn?: number;
  /** Exact external MCP authority, forwarded to every continuation turn. */
  mcpToolScope?: McpToolScope | null;
  /**
   * Opt-in for closed decision lanes whose requested deliverable is a strict
   * JSON object, not a tool effect. A matching result bypasses only the generic
   * zero-tool stall recovery; its caller must validate the payload and execute
   * any allowed transitions itself.
   */
  acceptStructuredNoToolResult?: boolean;
  /**
   * Opt-in: gate the orchestrator's self-declared completion with an
   * INDEPENDENT objective-completion judge (Hermes-style). Only interactive
   * chat callers set this; workflow-step executions (which also use
   * runConversation) leave it off so step contracts own their own completion.
   * Even when true, the judge only fires for multi-step ACTION objectives.
   */
  judgeCompletion?: boolean;
  /** Test injection for the objective judge (defaults to judgeObjectiveComplete). */
  judgeFn?: ObjectiveJudgeFn;
  /** Test injection for the trajectory watcher (defaults to runWatcherJudge). */
  watcherJudge?: WatcherJudgeFn;
  /** Test injection for goal-contract validation (defaults to validateGoal). */
  goalValidator?: (input: ValidateGoalInput) => Promise<GoalValidationResult>;
  /** Test injection. */
  makeRunner?: () => Runner;
  /** Test injection. */
  runRunner?: RunRunnerFn;
  /** @deprecated Raw executor deltas are private. Retained temporarily for API
   * compatibility; terminal delivery occurs through committed public events. */
  onChunk?: (delta: string) => void | Promise<void>;
  /**
   * Internal bridge path: an earlier first-byte provider attempt already wrote
   * the user_input_received row for this exact message, and no model/tool work
   * committed. Reuse that row instead of duplicating it on the fallback lane.
   */
  reuseRecordedUserInput?: boolean;
  /** Exact accepted source event owned by this logical user request. */
  sourceUserSeq?: number;
  /** Durable outer request attempt, forwarded through every continuation and
   * cross-brain retry. */
  runAttemptId?: string;
  /**
   * W1a chat step-boundary brain fallover. When BOTH are provided, a turn that
   * fails on a TRANSIENT model/codex error (and has NOT written externally this
   * turn) is re-attempted on the next brain instead of immediately asking the
   * user. `falloverModelIds` is the ordered list of next-brain model ids (the
   * caller computes it via falloverBrainModelIds); `rebuildAgentForBrain` rebuilds
   * the orchestrator agent bound to a given model. Absent → today's ask behavior.
   * The caller (respond-bridge, chat surfaces only) owns the CLEMMY_BRAIN_FALLOVER
   * gate by choosing whether to pass these.
   */
  falloverModelIds?: string[];
  rebuildAgentForBrain?: (modelId: string) => Promise<Agent<any, any>>;
  /** Stage 4 — aggregate run token budget. Explicit ceiling override in
   *  UNCACHED tokens (0 = unlimited); absent ⇒ preset/env default. */
  maxRunTokens?: number;
  /** Stage 4 — durable window baseline captured by the caller (the background
   *  drain passes the counter value at its iteration start so the budget
   *  aggregates across the whole auto-continue chain); absent ⇒ the loop
   *  self-baselines at entry (fresh window per user turn — a long-lived chat
   *  session never parks on its own history). */
  runTokenBaseline?: number;
}

export interface RunConversationResult {
  sessionId: string;
  status: RunConversationStatus;
  steps: number;
  lastDecision?: OrchestratorDecisionShape;
  lastTurn: number;
  error?: string;
  /** Set when a 'completed' status is actually a DEAD turn (parse retries
   *  exhausted / stall give-up) — the respond bridge uses it to re-run the
   *  turn ONCE on the next brain instead of shipping the apology. */
  completedReason?: 'no_structured_output' | 'sub_agent_stalled';
  /** Durable user projection returned by the single delivery committer. */
  publicPresentation?: PresentationEvent;
  /** Which ceiling produced a 'limit_exceeded' status — the bridge maps
   *  'token_budget' to its own distinct stoppedReason so the background
   *  drain parks instead of misclassifying the run (Stage 4). */
  limitKind?: 'wall_clock' | 'max_steps' | 'token_budget';
}

/**
 * Recover the exact JSON object emitted by a closed decision lane.
 *
 * Most providers wrap the requested JSON in the ordinary orchestrator
 * `reply`; a structured-output provider may hand back the decision object
 * directly. Do not repair, extract fenced snippets, accept arrays, or treat an
 * orchestrator envelope containing ordinary prose as this contract. That
 * keeps the capability narrower than the generic zero-tool detector it
 * bypasses; the outer caller still owns the domain schema validation.
 */
function strictStructuredNoToolResultText(value: unknown): string | null {
  const hasClosedDecisionShape = (candidate: unknown): candidate is Record<string, unknown> =>
    Boolean(
      candidate
      && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && typeof (candidate as Record<string, unknown>).summary === 'string'
      && Array.isArray((candidate as Record<string, unknown>).commitments)
      && Array.isArray((candidate as Record<string, unknown>).actions),
    );

  const parseExactDecisionObject = (candidate: unknown): string | null => {
    if (typeof candidate !== 'string') return null;
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return hasClosedDecisionShape(parsed) ? trimmed : null;
    } catch {
      return null;
    }
  };

  const direct = parseExactDecisionObject(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const obj = value as Record<string, unknown>;
  const reply = parseExactDecisionObject(obj.reply);
  if (reply) return reply;
  const summary = parseExactDecisionObject(obj.summary);
  if (summary) return summary;

  // A structured-output provider can return the requested decision object
  // rather than a JSON string. Require the summary + commitments + actions
  // container fields that distinguish this closed action contract from the
  // harness's own ordinary `{summary, done, nextAction}` envelope. Field-level
  // validity remains the outer autonomy layer's responsibility.
  if (hasClosedDecisionShape(obj)) {
    try { return JSON.stringify(obj); } catch { return null; }
  }
  return null;
}

export const _testOnly_strictStructuredNoToolResultText = strictStructuredNoToolResultText;
export const _testOnly_recallBudgetDefaults = { recallBudgetMaxCalls, recallBudgetMaxBytes };

function positiveIntEnv(key: string, fallback: number): number {
  const parsed = Number.parseInt(getRuntimeEnv(key, String(fallback)), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const DEFAULT_MAX_CONVERSATION_STEPS = positiveIntEnv('HARNESS_MAX_CONVERSATION_STEPS', 40);
export const DEFAULT_MAX_CONVERSATION_WALL_MS = positiveIntEnv(
  'HARNESS_MAX_CONVERSATION_WALL_MS',
  positiveIntEnv('HARNESS_MAX_CONVERSATION_WALL_MINUTES', 120) * 60 * 1000,
);

/** Resolve the ceiling for one in-memory conversation activation.
 *
 * `autoContinueOnLimit` must never erase the configured boundary by silently
 * widening it to a million model hops. Durable callers may checkpoint and
 * re-enter after this activation parks; the explicit `unlimited` preset keeps
 * its operator-selected 1,000,000-step ceiling through
 * `maxConversationSteps` itself.
 */
export function resolveConversationStepCeiling(
  explicitMaxSteps: number | undefined,
  budget: Pick<HarnessBudgetRuntime, 'preset' | 'maxConversationSteps' | 'autoContinueOnLimit'>,
): number {
  return explicitMaxSteps ?? budget.maxConversationSteps;
}

function inFlightCompactionEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_INFLIGHT_COMPACTION', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

function estimateAgentToolPromptComponents(agent: Agent<any, any>): Record<string, number> {
  let firstClass = 0;
  let deferredIndex = 0;
  for (const rawTool of agent.tools ?? []) {
    const tool = rawTool as unknown as Record<string, unknown>;
    try {
      if (tool.deferLoading === true) {
        deferredIndex += estimateTokens(JSON.stringify({
          type: tool.type,
          name: tool.name,
          description: tool.description,
        }));
      } else {
        firstClass += estimateTokens(JSON.stringify({
          type: tool.type,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: tool.strict,
        }));
      }
    } catch {
      firstClass += 50;
    }
  }
  return {
    ...(firstClass > 0 ? { toolSchemas: firstClass } : {}),
    ...(deferredIndex > 0 ? { deferredToolIndex: deferredIndex } : {}),
  };
}

const CONTINUATION_INPUT =
  'Continue with the next step of your plan. If you have nothing left to do, set done=true and nextAction=completed.';

/** Exact authority projected from a trusted producer's durable graph event. */
export interface VerifiedWorkflowRunDispatchReceipt {
  sourceGroupId: string;
  sourceGroupDigest: string;
  runIds: string[];
  sourceUserSeq: number;
  turn: number;
  eventId: string;
  replyTargetDigest: string;
}

export interface FinalizedWorkflowRunDispatch {
  receipt: VerifiedWorkflowRunDispatchReceipt;
  event: EventRow;
  presentation: NonNullable<ReturnType<typeof publicAsyncWorkDispatchedData>>;
}

function preparedWorkflowDispatchReceipts(input: {
  sessionId: string;
  sourceUserSeq: number;
}): WorkflowChatDispatchPreparedReceipt[] {
  const source = listEvents(input.sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq === input.sourceUserSeq);
  const sourceTarget = workflowOriginReplyTargetForSource(input);
  if (!source || source.role !== 'user' || source.data.synthetic === true || !sourceTarget) return [];
  const receipts: WorkflowChatDispatchPreparedReceipt[] = [];
  const seen = new Set<string>();
  for (const event of listEvents(input.sessionId, { types: ['async_work_dispatch_prepared'] })) {
    if (
      event.role !== 'system'
      || event.turn !== source.turn
      || event.parentEventId !== source.id
      || event.data.originSessionId !== input.sessionId
      || event.data.sourceUserSeq !== input.sourceUserSeq
    ) continue;
    const receipt = createWorkflowChatDispatchPreparedReceipt(
      event.data as unknown as WorkflowChatDispatchPreparationAuthority,
      { eventId: event.id, eventSeq: event.seq, preparedAt: event.createdAt },
    );
    if (
      receipt.replyTargetDigest !== exactOriginDeliveryTargetDigest(sourceTarget)
      || !sameExactOriginDeliveryTarget(receipt.replyTarget, sourceTarget)
    ) {
      throw new Error('workflow dispatch preparation disagrees with its accepted source target');
    }
    if (seen.has(receipt.receiptDigest)) continue;
    seen.add(receipt.receiptDigest);
    receipts.push(receipt);
  }
  return receipts;
}

function activeDispatchMatchesProjection(
  active: ActiveWorkflowOriginGroup,
  dispatch: NonNullable<ReturnType<typeof publicAsyncWorkDispatchedData>>,
): boolean {
  const expected = active.publicDispatch;
  return dispatch.version === expected.version
    && dispatch.kind === expected.kind
    && dispatch.status === expected.status
    && dispatch.sourceUserSeq === expected.sourceUserSeq
    && dispatch.sourceGroupId === expected.sourceGroupId
    && dispatch.sourceGroupDigest === expected.sourceGroupDigest
    && dispatch.dispatchKey === expected.dispatchKey
    && dispatch.replyTargetDigest === expected.replyTargetDigest
    && dispatch.runIds.length === expected.runIds.length
    && dispatch.runIds.every((runId, index) => runId === expected.runIds[index]);
}

function persistActiveWorkflowDispatch(
  source: EventRow,
  active: ActiveWorkflowOriginGroup,
): EventRow {
  const event = appendAsyncWorkDispatchedOnce({
    sessionId: source.sessionId,
    turn: source.turn,
    sourceUserSeq: active.publicDispatch.sourceUserSeq,
    sourceGroupId: active.publicDispatch.sourceGroupId,
    data: {
      ...active.publicDispatch,
      // Private crash-recovery route; the public projector drops this field.
      replyTarget: active.sealed.replyTarget,
    },
  }).event;
  const dispatch = publicAsyncWorkDispatchedData(event.data);
  if (
    !dispatch
    || event.role !== 'system'
    || event.turn !== source.turn
    || event.parentEventId !== source.id
    || !activeDispatchMatchesProjection(active, dispatch)
  ) {
    throw new Error('active workflow source group did not persist its public dispatch');
  }
  return event;
}

function acceptedSourceForActiveWorkflowDispatch(
  active: ActiveWorkflowOriginGroup,
): EventRow {
  const sessionId = active.sealed.originSessionId;
  const sourceUserSeq = active.sealed.sourceUserSeq;
  const source = listEvents(sessionId, {
    sinceSeq: sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  })
    .find((event) => event.seq === sourceUserSeq);
  const sourceTarget = workflowOriginReplyTargetForSource({ sessionId, sourceUserSeq });
  if (
    !source
    || source.role !== 'user'
    || source.data.synthetic === true
    || !sourceTarget
    || active.publicDispatch.sourceUserSeq !== sourceUserSeq
    || active.publicDispatch.sourceGroupId !== active.sealed.sourceGroupId
    || active.publicDispatch.sourceGroupDigest !== active.sealed.sourceGroupDigest
    || active.publicDispatch.replyTargetDigest !== active.sealed.replyTargetDigest
    || !sameExactOriginDeliveryTarget(sourceTarget, active.sealed.replyTarget)
  ) {
    throw new Error('active workflow source group lost its exact accepted source authority');
  }
  return source;
}

function persistActiveWorkflowDispatchFromAuthority(
  active: ActiveWorkflowOriginGroup,
): EventRow {
  return persistActiveWorkflowDispatch(acceptedSourceForActiveWorkflowDispatch(active), active);
}

function materializeClosedWorkflowDispatchBatch(
  event: EventRow,
): {
  source: EventRow;
  receipt: WorkflowOriginGroupClosedBatchReceipt;
} {
  const authority = event.data as unknown as WorkflowOriginGroupCloseAuthority;
  const source = listEvents(event.sessionId, { types: ['user_input_received'] })
    .find((candidate) => candidate.seq === authority.sourceUserSeq);
  const sourceTarget = workflowOriginReplyTargetForSource({
    sessionId: event.sessionId,
    sourceUserSeq: authority.sourceUserSeq,
  });
  if (
    event.type !== 'async_work_dispatch_batch_closed'
    || event.role !== 'system'
    || !source
    || source.role !== 'user'
    || source.data.synthetic === true
    || event.turn !== source.turn
    || event.parentEventId !== source.id
    || event.seq <= source.seq
    || authority.originSessionId !== event.sessionId
    || !sourceTarget
    || authority.replyTargetDigest !== exactOriginDeliveryTargetDigest(sourceTarget)
    || !sameExactOriginDeliveryTarget(authority.replyTarget, sourceTarget)
  ) {
    throw new Error('workflow dispatch batch close is not bound to its exact accepted source');
  }
  const receipt = createWorkflowOriginGroupClosedBatchReceipt(authority, {
    eventId: event.id,
    eventSeq: event.seq,
    closedAt: event.createdAt,
  });
  if (receipt.members.some((member) => member.preparedEventSeq >= event.seq)) {
    throw new Error('workflow dispatch batch close contains a preparation outside its causal prefix');
  }
  const available = preparedWorkflowDispatchReceipts({
    sessionId: event.sessionId,
    sourceUserSeq: authority.sourceUserSeq,
  });
  const byDigest = new Map(available.map((prepared) => [prepared.receiptDigest, prepared]));
  const preparedReceipts = receipt.members.map((member) => {
    const prepared = byDigest.get(member.receiptDigest);
    if (
      !prepared
      || prepared.runId !== member.runId
      || prepared.preparedEventId !== member.preparedEventId
      || prepared.preparedEventSeq !== member.preparedEventSeq
    ) {
      throw new Error('workflow dispatch batch close lost one of its exact prepared events');
    }
    return prepared;
  });
  recordWorkflowOriginGroupClosedBatch({ receipt, preparedReceipts });
  return { source, receipt };
}

/**
 * Freeze every workflow prepared during one complete foreground SDK
 * invocation. This runs only after runTurn/resumePendingApproval returned, so
 * all model↔tool cycles in that invocation have ended. Outer judge/stall
 * continuations must not widen the source group after durable async ownership
 * transfers at this boundary.
 */
function closePreparedWorkflowDispatchBatch(
  sessionId: string,
  sourceUserSeq: number,
): { source: EventRow; receipt: WorkflowOriginGroupClosedBatchReceipt } | null {
  const source = listEvents(sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq === sourceUserSeq);
  if (!source || source.role !== 'user' || source.data.synthetic === true) return null;
  const sourceGroupId = workflowOriginSourceGroupId({ sessionId, sourceUserSeq });
  return withWorkflowOriginGroupAuthorityLock(sourceGroupId, () => {
    const existing = listEvents(sessionId, { types: ['async_work_dispatch_batch_closed'] })
      .filter((event) => event.data.sourceUserSeq === sourceUserSeq);
    if (existing.length > 1) {
      throw new Error('workflow source group has ambiguous durable close winners');
    }
    let closeEvent = existing[0];
    if (!closeEvent) {
      const prepared = preparedWorkflowDispatchReceipts({ sessionId, sourceUserSeq });
      if (prepared.length === 0) return null;
      const authority = createWorkflowOriginGroupCloseAuthority(prepared);
      // The create-only filesystem fence closes membership before SQLite is
      // touched. This lock remains held through the close event and closed
      // projection, so admission lands wholly before or wholly after it.
      recordWorkflowOriginGroupCloseIntent(authority);
      closeEvent = appendAsyncWorkDispatchBatchClosedOnce({
        sessionId,
        turn: source.turn,
        sourceUserSeq,
        data: { ...authority },
      }).event;
    }
    return materializeClosedWorkflowDispatchBatch(closeEvent);
  });
}

function recoverWorkflowOriginGroupCloseIntentEvent(
  authority: WorkflowOriginGroupCloseAuthority,
): void {
  withWorkflowOriginGroupAuthorityLock(authority.sourceGroupId, () => {
    const source = listEvents(authority.originSessionId, { types: ['user_input_received'] })
      .find((event) => event.seq === authority.sourceUserSeq);
    if (!source || source.role !== 'user' || source.data.synthetic === true) {
      throw new Error('workflow origin group close intent lost its accepted source');
    }
    const existing = listEvents(authority.originSessionId, {
      types: ['async_work_dispatch_batch_closed'],
    }).filter((event) => event.data.sourceUserSeq === authority.sourceUserSeq);
    if (existing.length > 1) {
      throw new Error('workflow source group has ambiguous durable close winners');
    }
    if (existing.length === 0) {
      appendAsyncWorkDispatchBatchClosedOnce({
        sessionId: authority.originSessionId,
        turn: source.turn,
        sourceUserSeq: authority.sourceUserSeq,
        data: { ...authority },
      });
    }
  });
}

function finalizePreparedWorkflowDispatches(
  sessionId: string,
  sourceUserSeq: number,
): VerifiedWorkflowRunDispatchReceipt[] {
  const source = listEvents(sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq === sourceUserSeq);
  if (!source || source.role !== 'user' || source.data.synthetic === true) return [];
  const alreadyActive = verifiedWorkflowRunDispatchReceipts(sessionId, source.turn, sourceUserSeq);
  if (alreadyActive.length > 0) return alreadyActive;
  const closed = closePreparedWorkflowDispatchBatch(sessionId, sourceUserSeq);
  if (!closed) return [];
  finalizeWorkflowOriginGroupClosedBatch(closed.receipt.sourceGroupId, {
    // Executability is downstream of presentation authority. The activation
    // receipt may win privately, but its members remain held unless this exact
    // public edge commits; a thrown append is replayed from the closed batch.
    beforeMemberRelease: (active) => {
      persistActiveWorkflowDispatch(source, active);
    },
  });
  const verified = verifiedWorkflowRunDispatchReceipts(sessionId, source.turn, sourceUserSeq);
  if (verified.length !== 1) {
    throw new Error('workflow source group activated without one exact public dispatch');
  }
  return verified;
}

/** Shared post-SDK reducer for every interactive brain lane. A provider run
 * may emit any narration or control shape after workflow_run, but the durable
 * prepared receipts own the transition: close the complete SDK invocation,
 * activate its immutable member set, and return the one nonterminal public
 * dispatch edge. No caller may manufacture a terminal from the model result
 * once this reducer succeeds. */
export function finalizePreparedWorkflowDispatchForSource(
  sessionId: string,
  sourceUserSeq: number,
): FinalizedWorkflowRunDispatch | null {
  const receipts = finalizePreparedWorkflowDispatches(sessionId, sourceUserSeq);
  if (receipts.length === 0) return null;
  if (receipts.length !== 1) {
    throw new Error('workflow source must resolve to exactly one immutable public dispatch');
  }
  const receipt = receipts[0];
  const event = listEvents(sessionId, { types: ['async_work_dispatched'] })
    .find((candidate) => candidate.id === receipt.eventId);
  const presentation = event ? publicAsyncWorkDispatchedData(event.data) : null;
  if (
    !event
    || !presentation
    || presentation.sourceUserSeq !== sourceUserSeq
    || presentation.sourceGroupId !== receipt.sourceGroupId
    || presentation.sourceGroupDigest !== receipt.sourceGroupDigest
    || presentation.replyTargetDigest !== receipt.replyTargetDigest
    || presentation.runIds.length !== receipt.runIds.length
    || !presentation.runIds.every((runId, index) => runId === receipt.runIds[index])
  ) {
    throw new Error('workflow source group lost its exact nonterminal public presentation');
  }
  return { receipt, event, presentation };
}

export interface ReconcileClosedWorkflowDispatchBatchesResult {
  examined: number;
  finalized: number;
  published: number;
  rejected: number;
}

/** Recover a crash after either the filesystem close fence or private close
 * node won but before activation/public dispatch. Unfenced prepared-only
 * groups remain deliberately absent and held. */
export function reconcileClosedWorkflowDispatchBatches(
  limit = 200,
): ReconcileClosedWorkflowDispatchBatchesResult {
  const result: ReconcileClosedWorkflowDispatchBatchesResult = {
    examined: 0,
    finalized: 0,
    published: 0,
    rejected: 0,
  };
  // A crash can occur after the membership fence fsync but before the SQLite
  // event append. Drive those bounded intents into the ordinary event-ledger
  // replay path first; already-closed/compacted groups are filtered by the
  // origin-group store and cannot starve this scan.
  try {
    for (const intent of listWorkflowOriginGroupCloseIntents(limit)) {
      try {
        recoverWorkflowOriginGroupCloseIntentEvent(intent);
      } catch {
        result.rejected += 1;
      }
    }
  } catch {
    result.rejected += 1;
  }
  for (const closeEvent of listPendingAsyncWorkDispatchBatchClosedEvents(limit)) {
    result.examined += 1;
    try {
      const closed = materializeClosedWorkflowDispatchBatch(closeEvent);
      const wasActive = readActiveWorkflowOriginGroup(closed.receipt.sourceGroupId) !== null;
      finalizeWorkflowOriginGroupClosedBatch(closed.receipt.sourceGroupId, {
        beforeMemberRelease: (active) => {
          persistActiveWorkflowDispatch(closed.source, active);
        },
      });
      if (!wasActive) result.finalized += 1;
      result.published += 1;
    } catch {
      result.rejected += 1;
    }
  }
  return result;
}

/** Recover an activation receipt that won before its held members were
 * released. The origin-group store owns the filesystem replay, while this
 * harness wrapper supplies the required cross-store publication barrier from
 * the immutable accepted source. A missing or conflicting public edge keeps
 * every member held and retryable. */
export function reconcileActivatedWorkflowDispatchGroups(): ReturnType<
  typeof reconcileActivatedWorkflowOriginGroups
> {
  return reconcileActivatedWorkflowOriginGroups({
    beforeMemberRelease: (active) => {
      persistActiveWorkflowDispatchFromAuthority(active);
    },
  });
}

/**
 * Resolve every workflow dispatch owned by one accepted logical source. The
 * trusted workflow_run producer writes this event only after durable queue
 * admission and exact-origin binding. Tool output and model prose are not part
 * of authority and may change freely without altering this graph edge.
 */
export function verifiedWorkflowRunDispatchReceipts(
  sessionId: string,
  turn: number,
  sourceUserSeq?: number,
): VerifiedWorkflowRunDispatchReceipt[] {
  try {
    const sources = listEvents(sessionId, { types: ['user_input_received'] });
    const isHumanSource = (event: EventRow): boolean => (
      event.role === 'user' && event.data.synthetic !== true
    );
    const exactSource = sourceUserSeq
      ? sources.find((event) => event.seq === sourceUserSeq)
      : null;
    if (sourceUserSeq && (!exactSource || !isHumanSource(exactSource))) return [];
    const dispatchEvents = listEvents(sessionId, { types: ['async_work_dispatched'] });
    const winnerCounts = new Map<number, number>();
    for (const event of dispatchEvents) {
      const claimedSourceSeq = event.data.sourceUserSeq;
      if (!Number.isSafeInteger(claimedSourceSeq) || Number(claimedSourceSeq) <= 0) continue;
      const source = sources.find((candidate) => candidate.seq === claimedSourceSeq);
      if (
        !source
        || !isHumanSource(source)
        || event.role !== 'system'
        || event.turn !== source.turn
        || event.parentEventId !== source.id
      ) continue;
      const count = (winnerCounts.get(Number(claimedSourceSeq)) ?? 0) + 1;
      winnerCounts.set(Number(claimedSourceSeq), count);
      if (count > 1) return [];
    }
    const receipts = new Map<string, VerifiedWorkflowRunDispatchReceipt>();
    for (const event of dispatchEvents) {
      if (event.role !== 'system') continue;
      const dispatch = publicAsyncWorkDispatchedData(event.data);
      if (!dispatch) continue;
      const source = exactSource
        ?? sources.find((candidate) => (
          candidate.seq === dispatch.sourceUserSeq && isHumanSource(candidate)
        ));
      if (!source || event.seq <= source.seq || event.turn !== source.turn) continue;
      if (sourceUserSeq && dispatch.sourceUserSeq !== sourceUserSeq) continue;
      if (!sourceUserSeq && event.turn !== turn) continue;
      if (event.parentEventId !== source.id) continue;
      const sourceTarget = workflowOriginReplyTargetForSource({
        sessionId,
        sourceUserSeq: dispatch.sourceUserSeq,
      });
      if (!sourceTarget || dispatch.replyTargetDigest !== exactOriginDeliveryTargetDigest(sourceTarget)) continue;
      const active = readActiveWorkflowOriginGroup(dispatch.sourceGroupId);
      if (
        !active
        || active.sealed.originSessionId !== sessionId
        || active.sealed.sourceUserSeq !== dispatch.sourceUserSeq
        || !sameExactOriginDeliveryTarget(active.sealed.replyTarget, sourceTarget)
        || !activeDispatchMatchesProjection(active, dispatch)
      ) continue;
      const key = dispatch.dispatchKey;
      if (receipts.has(key)) return [];
      receipts.set(key, {
        sourceGroupId: dispatch.sourceGroupId,
        sourceGroupDigest: dispatch.sourceGroupDigest,
        runIds: [...dispatch.runIds],
        sourceUserSeq: dispatch.sourceUserSeq,
        turn: event.turn,
        eventId: event.id,
        replyTargetDigest: dispatch.replyTargetDigest,
      });
    }
    return [...receipts.values()];
  } catch {
    return []; // missing or ambiguous authority preserves the legacy fail-closed path
  }
}

/** Back-compatible predicate for gates that only need to know if one exists. */
export function dispatchedBackgroundWorkflowRun(
  sessionId: string,
  turn: number,
  sourceUserSeq?: number,
): boolean {
  return verifiedWorkflowRunDispatchReceipts(sessionId, turn, sourceUserSeq).length > 0;
}

function recordAsyncWorkflowDispatch(input: {
  sessionId: string;
  sourceUserSeq: number;
  receipts: VerifiedWorkflowRunDispatchReceipt[];
  steps: number;
  lastDecision?: OrchestratorDecisionShape;
  lastTurn: number;
}): RunConversationResult {
  if (input.receipts.length === 0
    || input.receipts.some((receipt) => receipt.sourceUserSeq !== input.sourceUserSeq)) {
    throw new Error('Cannot release foreground without exact async dispatch authority.');
  }
  return {
    sessionId: input.sessionId,
    status: 'dispatched',
    steps: input.steps,
    lastDecision: input.lastDecision,
    lastTurn: input.lastTurn,
  };
}

function composeResumeDeliveryObjective(sessionId: string): string {
  try {
    const inputs = listEvents(sessionId, { types: ['user_input_received'] })
      .map((ev) => String((ev.data as { text?: string } | undefined)?.text ?? ''))
      .filter((t) => t.trim().length > 0);
    return composeJudgedObjective('', inputs);
  } catch {
    return '';
  }
}

/**
 * v0.5.19 F2 — find the most recent preflight_budget_check event for
 * this session at the given turn. Returns null if no preflight ran
 * (e.g. workflow session, or chat session with the gate off). Used by
 * the auto-elevate path in `runConversationCore` to read the verdict
 * the preflight just emitted from inside `runTurn`.
 */
function findLatestPreflightVerdict(
  sessionId: string,
  turn: number,
): { status: 'ok' | 'warn' | 'block'; fractionUsed: number; predictedTokens: number } | null {
  try {
    const events = listEvents(sessionId, { types: ['guardrail_tripped'] });
    // Walk newest-first; first preflight_budget_check entry wins.
    for (let i = events.length - 1; i >= 0; i--) {
      const evt = events[i];
      if (evt.turn !== turn) continue;
      const data = evt.data as Record<string, unknown> | undefined;
      if (data?.kind !== 'preflight_budget_check') continue;
      const status = data.status as 'ok' | 'warn' | 'block' | undefined;
      if (!status) continue;
      const fractionUsed = typeof data.fractionUsed === 'number' ? data.fractionUsed : 0;
      const predictedTokens = typeof data.predictedTokens === 'number' ? data.predictedTokens : 0;
      return { status, fractionUsed, predictedTokens };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Loop reconciliation for the YOLO "never stuck" guarantee. When this turn's
 * ask_user_question already AUTO-RESOLVED under YOLO standing approval, the tool
 * emitted a non-halting `autonomy_note` (NOT an `awaiting_user_input` event) and
 * returned "proceed". But the model may STILL set `decision.nextAction =
 * 'awaiting_user_input'` out of habit (the orchestrator instructs it to whenever
 * it calls ask_user_question), which would strand the run at the halt seams
 * below. That stray nextAction contradicts the already-resolved question, so we
 * ignore it and continue.
 *
 * Conservative by construction: returns true ONLY when this turn produced an
 * `autonomy_note` (the positive proof YOLO auto-resolved an approval ask) AND no
 * halting `awaiting_user_input` event (a genuine clarification this turn — which
 * MUST still halt). The autonomy_note's presence already encodes that YOLO + the
 * kill-switch were active when it was emitted, so no policy re-check is needed.
 */
function yoloAutoResolvedAskThisTurn(sessionId: string, turn: number): boolean {
  try {
    const events = listEvents(sessionId, { types: ['autonomy_note', 'awaiting_user_input'] });
    let hasAutonomyNote = false;
    let hasHaltingAsk = false;
    for (const evt of events) {
      if (evt.turn !== turn) continue;
      if (evt.type === 'awaiting_user_input') hasHaltingAsk = true;
      else if (evt.type === 'autonomy_note'
        && (evt.data as { autoResolved?: unknown } | undefined)?.autoResolved === 'yolo-standing-approval') {
        hasAutonomyNote = true;
      }
    }
    return hasAutonomyNote && !hasHaltingAsk;
  } catch {
    return false;
  }
}

/** A real ask_user_question event is authoritative at the turn boundary.
 * Some provider lanes return the tool's terminal text ("Question posted…
 * Awaiting user reply.") as an otherwise-completed finalOutput. If we parse
 * that text first, it can look like a completed decision and enter validation
 * or another model turn even though the task is already waiting on the human.
 * YOLO auto-resolved asks intentionally emit autonomy_note instead, so the
 * presence of this event is the conservative halt signal. */
function awaitingUserQuestionThisTurn(sessionId: string, turn: number): string | null {
  try {
    const event = listEvents(sessionId, { types: ['awaiting_user_input'] })
      .filter((candidate) => candidate.turn === turn)
      .at(-1);
    if (!event) return null;
    const question = String(
      (event.data as { question?: unknown } | undefined)?.question
        ?? 'Awaiting your input.',
    ).trim();
    return question || 'Awaiting your input.';
  } catch {
    return null;
  }
}

/** Give the goal contract the harness's durable coverage ledger instead of
 * forcing the model to re-quote every worker result in its final prose. This is
 * evidence, not an automatic pass: criteria outside the manifest (a publish,
 * external write, artifact, etc.) still have to validate normally. */
function renderWorkManifestEvidenceForGoal(sessionId: string): string {
  try {
    const manifests = summarizeWorkManifests(sessionId);
    if (manifests.length === 0) return '';
    const lines = [
      '[DURABLE WORK MANIFEST EVIDENCE — append-only harness ledger; authoritative for item/phase coverage only]',
    ];
    for (const manifest of manifests.slice(0, 4)) {
      lines.push(
        `Manifest ${manifest.manifestId} contract ${manifest.contractVersion}: ${manifest.completed}/${manifest.total} canonical items complete; ${manifest.remaining} remaining; ${manifest.evidenceCount} evidence refs; ${manifest.anomalies.length} anomalies; ${manifest.untrackedCheckpoints} untracked checkpoints.`,
      );
      if (manifest.objective) lines.push(`Manifest objective: ${manifest.objective.slice(0, 500)}`);
      for (const phase of manifest.phases) {
        lines.push(
          `Phase ${phase.id}: ${phase.succeeded}/${phase.total} succeeded; ${phase.failed} failed; ${phase.pending} pending; ${phase.running} running; ${phase.needsValidation} need validation; ${phase.invalidated} invalidated.`,
        );
      }
      lines.push(`Canonical items: ${manifest.items.map((item) => `${item.id.slice(0, 160)}=${item.complete ? 'complete' : 'open'}`).join(', ')}`);
      for (const item of manifest.items.slice(0, 64)) {
        const evidence = Object.entries(item.phases)
          .flatMap(([phaseId, state]) => state.evidence.map((ref) => (
            `${phaseId}:${ref.kind}:${(ref.summary?.trim() || ref.ref).slice(0, 240)}`
          )))
          .slice(0, 8);
        if (evidence.length > 0) lines.push(`${item.id.slice(0, 160)} evidence: ${evidence.join(' | ')}`);
      }
      if (manifest.items.length > 64) {
        lines.push(`Item evidence detail bounded at 64/${manifest.items.length}; the canonical coverage line above is complete.`);
      }
    }
    return lines.join('\n').slice(0, 30_000);
  } catch {
    return '';
  }
}

/** An approval card is OPEN for this session (THE-GRANT question-immunity:
 *  the completion judge never fires while the human's decision is pending).
 *  Fail-open to false — a registry read error must not suppress the judge. */
function hasOpenApprovalCard(sessionId: string): boolean {
  try {
    return approvalRegistry.listPending({ sessionId }).length > 0;
  } catch {
    return false;
  }
}

/**
 * v0.5.19 F1 — build the preflight-block system message that gets
 * injected when the gate at `runTurn` projects the next turn would
 * exceed budget. The v1 message named `propose_plan` and
 * `batch_external_calls`, neither of which were ever registered as
 * tools on Clem's surface — when the gate fired, the model was
 * instructed to call nothing tools and gave up. v2 names only:
 *   - `create_plan` — registered via MCP catalog (src/tools/plan-tools.ts:7)
 *   - `ask_user_question` — registered inline (src/agents/orchestrator.ts:171)
 *
 * Revert lever: `CLEMMY_PREFLIGHT_BLOCK_MESSAGE_V2=off` falls back to
 * the v1 wording. Removed entirely after v0.5.19 bakes.
 */
export function buildPreflightBlockMessage(input: {
  predictedTokens: number;
  blockFraction: number;
  effectiveLimit: number;
}): string {
  const { predictedTokens, blockFraction, effectiveLimit } = input;
  // ADVISORY, not an override. Guardrails inform the agent's decision;
  // they never make it. This message used to hard-instruct "do NOT fire
  // tool calls / you MUST propose_plan", which stopped Clem from doing
  // its actual job (live 2026-05-30: "I need plan mode to do batch
  // rates"). It now surfaces the cost as context and trusts the model to
  // drive — be economical, or split big work via create_plan, but keep
  // the task moving. (The CLEMMY_PREFLIGHT_LEGACY_BLOCK opt-in to the old
  // hard-stop was retired in the 2026-07-09 subtraction pass — the advisory
  // default has been the validated behavior since 2026-05-30.)
  const header =
    `[CONTEXT BUDGET NOTICE] This turn is projected at ~${predictedTokens.toLocaleString()} tokens, ` +
    `nearing ${(blockFraction * 100).toFixed(0)}% of the effective context limit ` +
    `(${effectiveLimit.toLocaleString()} tokens). `;
  return (
    header +
    `This is guidance, not a stop — proceed if the work is worth it. To stay within budget, prefer ` +
    `narrow tool calls (request only the fields you need) and avoid re-reading large outputs. ` +
    `If this is a big multi-step effort, you MAY outline it with \`create_plan\` so it survives ` +
    `context limits, but only if that genuinely helps — do not pause a task that you can finish now. ` +
    `Use your judgment and keep moving.`
  );
}

/**
 * Max times the conversation loop will silently retry after the stall
 * detector fires on a sub-agent turn. The detector at
 * `evaluateProgress()` is already the generic chokepoint for "model
 * produced prose but called no tool" — hooking the retry here means
 * every sub-agent and every tool surface inherits recovery for free.
 *
 * Retry shape: append a synthetic user message that names the failure
 * ("your previous response was prose, not an action") and, when the
 * most recent handoff input had a structured `toolCall` field, inlines
 * the exact slug + args so the model can call it directly. If the
 * retry ALSO stalls, the original `sub_agent_stalled` failure surfaces
 * to the user — same behavior as today.
 *
 * v0.5.19 F4 bumped the default from 1 → 2 with exponential backoff
 * between attempts (250ms, then 1s). On exhaustion the loop converts
 * the stall into a user-facing `ask_user_question` instead of
 * terminating silently with `sub_agent_stalled` (which strands the
 * user — they see "Continuing." with no recourse). The ask-user
 * fallback honors the "reports back without fail" north-star
 * property. Disable via `HARNESS_STALL_ASK_USER=off` to fall back to
 * the v0.5.18 terminate-on-stall behavior.
 * Configurable via env for ops tuning.
 */
const MAX_STALL_RETRIES = positiveIntEnv('HARNESS_MAX_STALL_RETRIES', 2);
const STALL_RETRY_BACKOFF_MS = [250, 1000];
const MAX_MISSING_REPLY_RETRIES = 1;
const TURN_MEMORY_PRIMER_TOP_K = positiveIntEnv('CLEMMY_TURN_MEMORY_PRIMER_TOP_K', 6);
const TURN_MEMORY_PRIMER_MAX_CHARS = positiveIntEnv('CLEMMY_TURN_MEMORY_PRIMER_MAX_CHARS', 1800);
const TURN_MEMORY_PRIMER_FACT_TOP_K = positiveIntEnv('CLEMMY_TURN_MEMORY_PRIMER_FACT_TOP_K', 5);
const TURN_MEMORY_PRIMER_EPISODIC_TOP_K = positiveIntEnv('CLEMMY_TURN_MEMORY_PRIMER_EPISODIC_TOP_K', 6);

/** Recent episodic breadcrumbs for THIS session — "I already pulled X". These
 *  pointers were written on every qualifying tool return but, until now, NEVER
 *  read back into any prompt (the table was write-only). Surfacing them lets a
 *  long-running turn recall_tool_result instead of re-fetching. Session-scoped
 *  and bounded; the block only appears when pointers exist. */
function episodicBlockForPrimer(sessionId: string): string {
  if (!sessionId) return '';
  try {
    const pointers = listRecentEpisodicPointers(sessionId, TURN_MEMORY_PRIMER_EPISODIC_TOP_K);
    if (pointers.length === 0) return '';
    const lines = pointers.map((p) => `- ${p.label} [${p.call_id}]${p.tool ? ` (via ${p.tool})` : ''}`);
    return [
      '[RECENTLY OBSERVED THIS SESSION — you already pulled these; recall_tool_result to re-read instead of re-fetching]',
      ...lines,
    ].join('\n');
  } catch {
    return '';
  }
}

/** Query-relevant durable facts for the per-turn primer (lexical → finds even
 *  a fact remembered seconds ago, before its embedding indexes). The primer's
 *  vault search never touched consolidated_facts, so a freshly-stated "remember
 *  X" was invisible to auto-context and the model would confabulate. */
export function factsBlockForPrimer(query: string, sessionId = ''): { text: string; recallId?: string } {
  try {
    const facts = searchFactsByText(query, TURN_MEMORY_PRIMER_FACT_TOP_K);
    if (facts.length === 0) return { text: '' };
    // Primer exposure is an impression, not proof that the memory helped.
    // Keeping this separate from utility prevents repeated auto-context from
    // making the same memories rank higher merely because they were shown.
    try { for (const f of facts) recordFactImpression(f.id); } catch { /* best effort */ }
    appendFactRecallTrace({
      surface: 'turn_memory_primer',
      query,
      facts: facts.map((fact) => ({ fact, reason: 'lexical-primer-match' })),
    });
    // The unified primer records a run; this timeout/error FALLBACK injected
    // the same class of facts with no run at all (recallId null, observed live
    // 2026-07-31), so anything it surfaced was credit-blind. Parity restored.
    let recallId: string | undefined;
    try {
      recallId = recordRecallRun({
        objective: query,
        surface: 'automatic_primer_fallback',
        answerability: 'partial',
        candidateRefs: facts.map((fact) => ({ type: 'fact', id: String(fact.id), snippet: fact.content })),
        sessionId: sessionId || undefined,
      }).id;
    } catch { /* attribution must never block the primer */ }
    const lines = facts.map((f) => `- ${f.content}`);
    return {
      text: ['[REMEMBERED FACTS — durable, user-stated or curated; treat as known]', ...lines].join('\n'),
      recallId,
    };
  } catch {
    return { text: '' };
  }
}
// 1500ms, raised from 800 (2026-07-31, measured): live unified-recall latency
// ran p50=658ms / p90=1370ms against the 800ms ceiling, so ~1 in 8 turns lost
// the ranked evidence-backed primer to a timeout and got the weaker lexical
// fallback — a silent memory downgrade whose downstream cost (mis-routes,
// extra tool calls) dwarfs the sub-second wait. It's a race, not a sleep:
// turns faster than the ceiling pay nothing. 1500 covers p90 and matches the
// Claude lane's CLEMMY_BRAIN_QUERY_RECALL_TIMEOUT_MS default — the two brains
// should not disagree on how long good memory is worth waiting for.
export const TURN_MEMORY_PRIMER_HYBRID_TIMEOUT_MS = positiveIntEnv('CLEMMY_TURN_MEMORY_PRIMER_HYBRID_TIMEOUT_MS', 1500);
// Wave 2 Move A: AUGMENT the turn primer with cross-store breadcrumbs (people/
// places/proven-tools) via the shared crossStoreBreadcrumbs helper — APPENDED to
// the existing facts+vault+episodic primer, sync-only (no latency). Same helper is
// used by the Claude SDK brain lane (claude-agent-brain.ts) so BOTH brains get it.

function isSyntheticStallRetryInput(text: string): boolean {
  return text.startsWith('Your previous response was prose, not an action.')
    || text.startsWith('Your previous response did not make progress on the directive.')
    || text.startsWith('Your previous response could not be parsed into the required structured decision');
}

function hasUserFacingReply(decision: OrchestratorDecisionShape | null | undefined): boolean {
  return Boolean(decision?.reply?.trim());
}

function isCompletedWithoutUserFacingReply(decision: OrchestratorDecisionShape | null | undefined): boolean {
  // L1 (v2.3.0): ANY final decision lacking a user-facing reply earns the one
  // self-retry — not just the 'completed' shape. Live 2026-07-22: a done-shaped
  // turn with a non-completed nextAction skipped the retry entirely and the
  // user got the fallback after repeatedly nudging the run. Non-final shapes
  // (awaiting_handoff_result, awaiting_user_input — the question IS the reply)
  // still never retry.
  if (!decision || hasUserFacingReply(decision)) return false;
  if (decision.nextAction === 'completed') return true;
  // 'abandoned' is the give-up shape — a final with no reply, exactly the case
  // to retry. Every awaiting_* action is a REAL pause (the question/approval
  // card IS the user-facing artifact) and must never be retried into noise.
  return Boolean(decision.done) && decision.nextAction === 'abandoned';
}

function hasCapturedWorkflowStepResult(sessionId: string): boolean {
  try {
    return peekStepResult(sessionId).found;
  } catch {
    return false;
  }
}

function captureWorkflowStepResultTranscript(opts: {
  sessionId: string;
  turn: number;
  output: unknown;
}): boolean {
  if (typeof opts.output !== 'string') return false;
  try {
    const captured = recordStepResultFromTranscript(opts.sessionId, opts.output);
    if (captured) {
      safeAppend({
        sessionId: opts.sessionId,
        turn: opts.turn,
        role: 'system',
        type: 'heartbeat',
        data: { kind: 'workflow_step_result_transcript_captured' },
      });
    }
    return captured;
  } catch {
    return false;
  }
}

function completeCapturedWorkflowStepResult(opts: {
  sessionId: string;
  sourceUserSeq?: number;
  turn: number;
  steps: number;
  decision?: OrchestratorDecisionShape | null;
}): RunConversationResult {
  safeAppend({
    sessionId: opts.sessionId,
    turn: opts.turn,
    role: 'Clem',
    type: 'conversation_step',
    data: {
      step: opts.steps,
      decision: userVisibleStepDecision(opts.decision ?? null),
    },
  });
  return finalizeStandardConversation({
    sessionId: opts.sessionId,
    sourceUserSeq: opts.sourceUserSeq,
    turn: opts.turn,
    eventData: {
      steps: opts.steps,
      reason: 'workflow_step_result_captured',
      summary: opts.decision?.summary ?? 'Workflow step emitted a structured result.',
      internalSummary: opts.decision?.summary ?? null,
      reply: opts.decision?.reply ?? null,
      delivered: true,
    },
    result: {
      sessionId: opts.sessionId,
      status: 'completed',
      steps: opts.steps,
      lastDecision: opts.decision ?? undefined,
      lastTurn: opts.turn,
    },
  });
}

function userVisibleStepDecision(
  decision: OrchestratorDecisionShape | null,
): OrchestratorDecisionShape | null {
  if (!decision || !isCompletedWithoutUserFacingReply(decision)) return decision;
  return {
    ...decision,
    summary: MISSING_REPLY_USER_FALLBACK,
    reply: null,
  };
}

/** Stall-recovery summary directive (2026-07-23). When stall retries exhaust,
 *  the user must NEVER see harness meta-language ("the model produced text
 *  without taking action — retry, switch approach, or stop?"). Before any
 *  user-facing fallback, spend ONE turn asking the model to write the reply
 *  the user should actually see. The "do not call another tool … reply to the
 *  user now" phrasing engages the plain-text-contract exemption, so a
 *  compliant zero-tool reply cannot re-trip the stall detector. */
function buildStallRecoverySummaryMessage(userInput: string): string {
  const anchor = userInput.trim().slice(0, 400);
  return [
    'Your previous turns did not produce a reply that could be delivered.',
    'Do not call another tool. Reply to the user now, in plain words:',
    'briefly say where you are with their request, share anything useful you already have,',
    'and if you genuinely need something from them, end with ONE concrete question.',
    'Never mention tools, retries, or internal errors.',
    anchor ? `Their message was: "${anchor}"` : '',
  ].filter(Boolean).join(' ');
}

/** The absolute floor when even the recovery summary failed: plain language,
 *  anchored to the user's ask, no tri-choice jargon. */
const STALL_FLOOR_QUESTION =
  "Something on my side kept that reply from coming together. Say “continue” and I'll pick it back up fresh — or rephrase what you'd like and I'll start from there.";
const STALL_FLOOR_OPTIONS = ['Continue', 'Start over'];

function buildMissingReplyRetryMessage(decision: OrchestratorDecisionShape, path: 'conversation' | 'resume'): string {
  const internal = JSON.stringify((decision.summary ?? '').slice(0, 700));
  return [
    'Your previous turn ended as completed but produced NO visible answer for the user.',
    'Do NOT expose this diagnostic text to the user.',
    `Internal note for context (${path} path): ${internal}.`,
    'Reply again with the actual answer as plain text — that text IS what the user reads (no JSON, no marker needed for a finished answer).',
    'If the latest user message was only a greeting or small talk, reply naturally and ask what they would like to work on.',
    'If real work was completed, state the actual result/evidence.',
  ].join(' ');
}

function latestHumanInputForStallRetry(sessionId: string): string | undefined {
  const events = listEvents(sessionId);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== 'user_input_received') continue;
    const text = (event.data as { text?: unknown })?.text;
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (!trimmed || isSyntheticStallRetryInput(trimmed)) continue;
    return trimmed;
  }
  return undefined;
}

function looksLikeExistingWorkReference(input: string): boolean {
  const text = input.toLowerCase();
  if (!text.trim()) return false;

  const action = /\b(work on|edit|edits|revise|revision|update|change|fix|finish|continue|resume|pick back up|go back|make more)\b/.test(text);
  const referencedObject = /\b(that|this|these|those|previous|earlier|last|current|existing|project|file|post|animation|video|draft|sheet|proposal|deck|transcript|meeting|workflow|report)\b/.test(text);
  const namedCreativeWork = /\b(gala|silent|silet|auction|acution|animation|post|reel|hyperframes?)\b/.test(text);

  return (action && referencedObject) || (action && namedCreativeWork);
}

function buildMemoryFirstStallRetryHint(sessionId: string): string {
  try {
    const input = latestHumanInputForStallRetry(sessionId);
    if (!input || !looksLikeExistingWorkReference(input)) return '';
    const query = input.replace(/\s+/g, ' ').slice(0, 500);
    return (
      ` The user's original request appears to reference existing work: ${JSON.stringify(query)}.` +
      ' Before calling ask_user_question, call focus_get. If focus_get does not identify the target,' +
      ' call memory_recall_all with that request or its key nouns. Only ask the user' +
      ' after focus and memory return no useful match.'
    );
  } catch {
    return '';
  }
}

interface TurnMemoryPrimer {
  enabled: boolean;
  query: string;
  hitCount: number;
  injectedBytes: number;
  source?: 'unified' | 'fts5' | 'hybrid' | 'fts5_hybrid_timeout' | 'fts5_hybrid_error';
  text?: string;
  skippedReason?: string;
  recallId?: string;
  answerability?: 'supported' | 'partial' | 'insufficient';
  candidateCount?: number;
  omittedCount?: number;
  stores?: string[];
  recallElapsedMs?: number;
}

function formatTurnMemoryPrimer(query: string, hits: ReturnType<typeof searchVault>, source: TurnMemoryPrimer['source'], sessionId = '', breadcrumbs = ''): TurnMemoryPrimer {
  const formatted = formatSearchHits(hits, TURN_MEMORY_PRIMER_MAX_CHARS);
  // Durable facts relevant to THIS message — the primer's vault search alone
  // never surfaced consolidated_facts, so a just-remembered fact was invisible.
  const { text: factsBlock, recallId } = factsBlockForPrimer(query, sessionId);
  // Recently-observed breadcrumbs for this session (was a write-only table).
  const episodicBlock = episodicBlockForPrimer(sessionId);
  if (!formatted && !factsBlock && !episodicBlock && !breadcrumbs) {
    return { enabled: true, query, hitCount: hits.length, injectedBytes: 0, source, skippedReason: 'no_hits' };
  }
  const sourceLabel = source === 'hybrid'
    ? 'local FTS5 plus semantic rerank'
    : 'local FTS5';
  const text = [
    '[MEMORY PRIMER]',
    `A ${sourceLabel} memory search ran for the latest user message before this model call.`,
    'Use these hits to steer the first response and tool choice. Treat snippets as candidate memory, not proof; before mutating external resources or creating source-backed artifacts, load the source with memory_read/read_file/recall_tool_result or call memory_recall_all for evidence-backed context.',
    ...(factsBlock ? ['', factsBlock] : []),
    ...(episodicBlock ? ['', episodicBlock] : []),
    ...(formatted ? ['', formatted] : []),
    // Wave 2 Move A: cross-store breadcrumbs (people/places/proven tools) — the
    // stores that had no per-turn auto-recall, appended so the existing blocks
    // above are never lost.
    ...(breadcrumbs ? ['', breadcrumbs] : []),
  ].join('\n');
  return { enabled: true, query, hitCount: hits.length, injectedBytes: text.length, source, text, recallId };
}

async function searchVaultAsyncWithTimeout(query: string): Promise<ReturnType<typeof searchVault> | null> {
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), TURN_MEMORY_PRIMER_HYBRID_TIMEOUT_MS);
  });
  return await Promise.race([
    searchVaultAsync(query, TURN_MEMORY_PRIMER_TOP_K),
    timeout,
  ]);
}

async function buildTurnMemoryPrimer(input: string, sessionId = ''): Promise<TurnMemoryPrimer> {
  const enabled = (getRuntimeEnv('CLEMMY_TURN_MEMORY_PRIMER', 'on') ?? 'on').toLowerCase() !== 'off';
  const hybridEnabled = (getRuntimeEnv('CLEMMY_TURN_MEMORY_PRIMER_HYBRID', 'on') ?? 'on').toLowerCase() !== 'off';
  const query = input.replace(/\s+/g, ' ').trim();
  if (!enabled) return { enabled: false, query, hitCount: 0, injectedBytes: 0, skippedReason: 'disabled' };
  if (!query) return { enabled: true, query, hitCount: 0, injectedBytes: 0, skippedReason: 'empty_input' };
  if (isSyntheticStallRetryInput(query)) {
    return { enabled: true, query, hitCount: 0, injectedBytes: 0, skippedReason: 'synthetic_retry' };
  }
  scheduleRecallShadow({ query, surface: 'automatic_primer', limit: TURN_MEMORY_PRIMER_FACT_TOP_K });

  try {
    // Primary path: the same complete evidence-backed retrieval used by
    // memory_recall_all. Session-local tool pointers remain additive working
    // memory; the archival stores no longer use four divergent rankers.
    const episodicBlock = episodicBlockForPrimer(sessionId);
    const unified = await buildUnifiedTurnPrimer({
      query,
      surface: 'automatic_primer',
      limit: Math.max(TURN_MEMORY_PRIMER_TOP_K, TURN_MEMORY_PRIMER_FACT_TOP_K),
      maxChars: Math.max(700, TURN_MEMORY_PRIMER_MAX_CHARS - episodicBlock.length - (episodicBlock ? 2 : 0)),
      timeoutMs: TURN_MEMORY_PRIMER_HYBRID_TIMEOUT_MS,
      sessionId,
    });
    if (unified.status === 'ok' || unified.status === 'empty') {
      const text = [unified.text, episodicBlock].filter(Boolean).join('\n\n');
      return {
        enabled: true,
        query,
        hitCount: unified.hitCount,
        injectedBytes: Buffer.byteLength(text, 'utf8'),
        source: 'unified',
        text: text || undefined,
        skippedReason: text ? undefined : 'no_hits',
        recallId: unified.recallId,
        answerability: unified.answerability,
        candidateCount: unified.diagnostics?.candidates,
        omittedCount: unified.omittedHitCount,
        stores: unified.diagnostics?.stores,
        recallElapsedMs: unified.diagnostics?.elapsedMs,
      };
    }

    // Wave 2 Move A: APPEND sync cross-store breadcrumbs (people/places/tools) to
    // the existing facts+vault+episodic primer — never replacing it. Self-gating +
    // computed once (sync stores → no latency), passed into every format path below.
    const breadcrumbs = await crossStoreBreadcrumbs(query);
    const ftsHits = searchVault(query, TURN_MEMORY_PRIMER_TOP_K);
    if (!hybridEnabled) {
      const legacy = formatTurnMemoryPrimer(query, ftsHits, 'fts5', sessionId, breadcrumbs);
      return unified.status === 'disabled' ? legacy : { ...legacy, skippedReason: `unified_${unified.status}_fallback` };
    }

    try {
      const hybridHits = await searchVaultAsyncWithTimeout(query);
      if (hybridHits && hybridHits.length > 0) {
        const legacy = formatTurnMemoryPrimer(query, hybridHits, 'hybrid', sessionId, breadcrumbs);
        return unified.status === 'disabled' ? legacy : { ...legacy, skippedReason: `unified_${unified.status}_fallback` };
      }
      if (hybridHits === null) {
        return {
          ...formatTurnMemoryPrimer(query, ftsHits, 'fts5_hybrid_timeout', sessionId, breadcrumbs),
          skippedReason: ftsHits.length > 0 ? `unified_${unified.status}_hybrid_timeout` : `unified_${unified.status}_hybrid_timeout_no_fts_hits`,
        };
      }
    } catch {
      return {
        ...formatTurnMemoryPrimer(query, ftsHits, 'fts5_hybrid_error', sessionId, breadcrumbs),
        skippedReason: ftsHits.length > 0 ? `unified_${unified.status}_hybrid_error` : `unified_${unified.status}_hybrid_error_no_fts_hits`,
      };
    }

    return formatTurnMemoryPrimer(query, ftsHits, 'fts5', sessionId, breadcrumbs);
  } catch (err) {
    return {
      enabled: true,
      query,
      hitCount: 0,
      injectedBytes: 0,
      skippedReason: err instanceof Error ? `error:${err.message}` : 'error',
    };
  }
}

/** Most recent stall-retry attempt that recorded the model's flagged output.
 *  Used by the consistent-reply salvage: if the post-retry output matches this,
 *  the model is repeating its answer, not stalling. */
function latestStallRetryRawOutput(sessionId: string): string | undefined {
  try {
    const recent = listEvents(sessionId, { types: ['stall_retry_attempted'], limit: 5, desc: true });
    for (const ev of recent) {
      const raw = (ev.data as { rawOutput?: unknown })?.rawOutput;
      if (typeof raw === 'string' && raw.trim()) return raw;
    }
  } catch { /* degraded eventlog — salvage simply won't fire */ }
  return undefined;
}

/**
 * Build the synthetic user message that drives the stall retry.
 *
 * Generic fallback first: name the failure, command an action, offer
 * ask_user_question as an escape hatch. Works for any sub-agent and
 * any tool surface.
 *
 * Opportunistic enrichment: scan recent `handoff` events for a
 * structured `toolCall.slug + args` — when present, inline both so the
 * model has the exact composio_execute_tool invocation it failed to
 * make the first time. This is the path that recovers the most common
 * failure shape (Orchestrator pre-resolved Composio action → Executor
 * announced instead of executing).
 *
 * Reads from the eventlog only; never imports the model or SDK, so
 * unit tests can exercise this with a stubbed runner.
 */
export function buildStallRetryMessage(sessionId: string, stall: StallInfo): string {
  // If the most recent tool result was a draft-only-skill block asking the model
  // to PRESENT the draft for approval, the stall nudge must NOT forbid text — a
  // user-facing reply IS the correct move. Steer to present-and-ask instead of
  // "call a tool, no text" (which is what sent the model hunting for tools and
  // thrashing on the acme email batch, 2026-06-17).
  try {
    const recent = listEvents(sessionId, { types: ['tool_returned'], limit: 3, desc: true });
    for (const ev of recent) {
      const result = (ev.data as { result?: unknown })?.result;
      if (typeof result === 'string' && result.includes('GOAL_FIDELITY_CHECK_FAILED') && /PRESENT the drafted/i.test(result)) {
        return [
          'Your previous send was held because the loaded skill drafts and presents — it does not itself send.',
          ' Do NOT call another tool. Reply to the user NOW with the drafted item(s) — per item show the To, Subject, and Body — then ask plainly "Good to send?" and end your turn.',
        ].join('');
      }
    }
  } catch { /* fall through to the generic nudge */ }

  const stallDetail = stall.detail as { fakeToolTranscript?: unknown; toolName?: unknown };
  if (stallDetail.fakeToolTranscript === true && stallDetail.toolName === 'workflow_step_result') {
    return [
      'Your previous response wrote a fake `workflow_step_result` call as text; no tool call occurred.',
      'Call the ACTUAL `workflow_step_result` tool exactly once now with the JSON payload requested by the workflow step.',
      'Do not write XML, markdown, `<function_calls>`, or prose before the tool call.',
    ].join(' ');
  }

  let toolCallHint = '';
  try {
    const events = listEvents(sessionId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type !== 'handoff') continue;
      const input = (event.data as { input?: unknown })?.input;
      if (!input || typeof input !== 'object') continue;
      const toolCall = (input as { toolCall?: unknown }).toolCall;
      if (!toolCall || typeof toolCall !== 'object') continue;
      const slug = (toolCall as { slug?: unknown }).slug;
      const args = (toolCall as { args?: unknown }).args;
      if (typeof slug !== 'string' || !slug) continue;
      if (typeof args !== 'string' || !args) continue;
      toolCallHint =
        ` The Orchestrator already resolved the action for you:` +
        ` call composio_execute_tool with { tool_slug: "${slug}", arguments: ${args} } —` +
        ` use those exact values, do not re-discover, do not modify the args.`;
      break;
    }
  } catch {
    // listEvents may throw in degraded states; the generic message
    // still works without the structured hint.
  }

  const stallShape = stall.signal === 'A_zero_tools'
    ? 'Your previous response was prose, not an action.'
    : 'Your previous response did not make progress on the directive.';
  const fallbackHint = toolCallHint
    || buildMemoryFirstStallRetryHint(sessionId)
    || ' If the directive is ambiguous and you cannot pick a tool, call ask_user_question instead of producing announcement text.';

  return [
    stallShape,
    'You MUST call a tool now to make progress — do not emit any text before the tool call.',
    fallbackHint,
  ].join('');
}

/**
 * Emit the terminal `runtime.completed` or `runtime.failed` action-bus
 * event for a finished `runConversation` call. The invariant
 * (T0.6 + T1.5): every runConversation invocation terminates with
 * EXACTLY ONE of these signals, so subscribers (Discord, dashboard
 * SSE, ops log) can distinguish "still in flight" from "died silently"
 * by construction. runtime.failed is reserved for genuine failures
 * (status='failed', the unhandled-exception branch in handleRunError);
 * status='awaiting_approval' / 'awaiting_user_input' / 'limit_exceeded'
 * / 'killed' all count as clean terminations and emit runtime.completed.
 */
function emitRuntimeTerminalEvent(sessionId: string, result: RunConversationResult): void {
  try {
    // Bake the judge corpus (Lane A) — harvest this run's advisory judge verdicts
    // (goal_alignment / output_grounding) into candidate gold-set cases for later
    // human labeling, so κ-calibration can grow from real verdicts. Fires on EVERY
    // run (verdicts occur on clean completions too), once per run (terminal), via a
    // dynamic import + fire-and-forget so it never touches the loop's hot path.
    // Reuses the corpus gate (CLEMMY_EVAL_AUTO_PROMOTE); judges stay advisory.
    if ((process.env.CLEMMY_EVAL_AUTO_PROMOTE ?? 'on').toLowerCase() !== 'off') {
      void import('../eval/eval-corpus-promote.js')
        .then((m) => { try { m.snapshotJudgeCandidates(sessionId); } catch { /* best-effort */ } })
        .catch(() => { /* best-effort */ });
    }
    if (result.status === 'failed') {
      const message = result.error ?? 'unknown error';
      const err = new BoundaryError({
        kind: 'runtime.unknown',
        retryable: false,
        userMessage: 'Clementine hit an unexpected error during this turn. Please try again; technical details are available in the activity log.',
        operatorMessage: `runConversation status=failed: ${message}`,
        context: {
          sessionId,
          steps: result.steps,
          error: message,
        },
      });
      actionBus.emit({
        kind: 'runtime.failed',
        sessionId,
        error: err,
        surface: 'both',
      });
      // Auto-promote the failed run into the eval corpus (Lane A Phase 4b) —
      // fire-and-forget, best-effort, gated on failure so clean runs pay nothing.
      // Dynamic import keeps the eval layer off loop.ts's module graph.
      if ((process.env.CLEMMY_EVAL_AUTO_PROMOTE ?? 'on').toLowerCase() !== 'off') {
        void import('../eval/eval-corpus-promote.js')
          .then((m) => { try { m.snapshotFailureTrajectory(sessionId); } catch { /* best-effort */ } })
          .catch(() => { /* best-effort */ });
      }
    } else {
      actionBus.emit({ kind: 'runtime.completed', sessionId });
    }
  } catch {
    // The action bus already swallows listener exceptions, but a
    // BoundaryError construction throw would still escape — wrap
    // just-in-case so a terminal-event emit failure never propagates
    // into the loop's return contract.
  }
}

/**
 * Pure: should a forward-progressing run auto-elevate its budget because it is
 * about to exhaust the STEP cap? Only fires on the capped `standard` preset with
 * no caller-pinned maxSteps. The configured ceiling stays authoritative after
 * the one standard → long promotion; a legacy auto-continue setting never
 * turns this activation into an unbounded loop. Exported for tests.
 */
export function shouldElevateOnStepProgress(opts: {
  alreadyElevated: boolean;
  preset: string;
  explicitMaxSteps: boolean;
  stepIndex: number;
  maxSteps: number;
}): boolean {
  if (opts.alreadyElevated) return false;
  if (opts.explicitMaxSteps) return false; // caller pinned the cap — respect it
  if (opts.preset !== 'standard') return false; // only the capped default preset
  return opts.stepIndex >= opts.maxSteps; // about to exit on the step cap
}

export async function runConversation(
  options: RunConversationOptions,
): Promise<RunConversationResult> {
  // Accept first: a marker with no accepted source has no logical turn to
  // recover. Once armed, clear it only after the typed terminal commits. A
  // reducer/SQLite failure must stay recoverable, and a completedReason
  // candidate remains armed while the bridge tries the next brain.
  const sourceUserSeq = acceptFreshConversationInput(options);
  const acceptedSource = acceptedUserEvent(options.sessionId, sourceUserSeq);
  recordTurnGraphShadow({
    identity: {
      sessionId: options.sessionId,
      turn: acceptedSource.turn,
      sourceUserSeq,
    },
    surface: 'direct',
  });
  let foregroundReleased = false;
  try {
    // G5b slice 1: the compiled turn graph DRIVES the spine instead of being
    // observed and discarded. The provider core remains one interim node
    // (charter Phase 2 — "keep the existing loops as temporary executor
    // nodes"); terminal reduction derives the outcome inside the core phase,
    // and the public commit happens only when the executor reaches the
    // publish node. An uncompilable turn runs the identical legacy order.
    type SpineCore =
      | { kind: 'dispatched'; result: Awaited<ReturnType<typeof runConversationCore>> }
      | { kind: 'reduced'; reduced: ReturnType<typeof reduceStandardConversationTerminal> };
    let activeAgent = options.agent;
    if (!activeAgent && !options.buildAgent) {
      throw new Error('runConversation requires either agent or buildAgent.');
    }
    const resolveCapability = options.buildAgent
      ? async () => { if (!options.agent) activeAgent = await options.buildAgent!(); }
      : undefined;
    const spine = await driveChatTurnSpine<SpineCore>({
      identity: { sessionId: options.sessionId, turn: acceptedSource.turn, sourceUserSeq },
      input: options.input,
      surface: 'direct',
      policy: getProactivityPolicySnapshot(),
      phases: {
        ...(resolveCapability ? { resolveCapability } : {}),
        runCore: async () => {
          if (!activeAgent) throw new Error('capability_resolve did not produce an agent before the core.');
          const result = await runConversationCore({
            ...options,
            agent: activeAgent,
            sourceUserSeq,
            reuseRecordedUserInput: true,
          });
          if (result.status === 'dispatched') return { kind: 'dispatched', result };
          return { kind: 'reduced', reduced: reduceStandardConversationTerminal({ result, sourceUserSeq }) };
        },
        shouldPublish: (core) => core.kind === 'reduced' && !core.reduced.completedReason,
        publish: (core) => {
          if (core.kind !== 'reduced') return;
          emitRuntimeTerminalEvent(options.sessionId, core.reduced);
          refreshTerminalWorkingMemory(options.sessionId);
        },
        // The REAL delivery verdict, phase 1b: a completed reduction delivered
        // its answer; awaiting_user_input (blocked verdict or clarifying
        // question) is the needs-input route; a dispatched turn's public edge
        // is its ACK, which counts as delivered for routing.
        delivered: (core) => core.kind === 'dispatched'
          || core.reduced.status === 'completed',
      },
    });
    if (spine.engine === 'legacy_order') {
      // eslint-disable-next-line no-console
      console.warn(
        `[harness] chat turn spine fell back to legacy order (session ${options.sessionId}, seq ${sourceUserSeq}): ${spine.compileError ?? 'unknown'} — the turn answered; the graph did not drive it`,
      );
    }
    const core = spine.core;
    if (core.kind === 'dispatched') {
      // The exact async_work_dispatched row remains the pending logical edge.
      // This releases only the coarse foreground marker; provider inbox rows
      // may become `replied` once their compact dispatch ACK is delivered.
      foregroundReleased = true;
      return core.result;
    }
    if (core.reduced.completedReason) return core.reduced;
    foregroundReleased = Boolean(core.reduced.publicPresentation);
    return core.reduced;
  } finally {
    if (foregroundReleased) {
      clearRunInFlightAfterTerminal(options.sessionId, options.runAttemptId, sourceUserSeq);
    }
  }
}

/** Refresh short-term memory only after the conversation terminal is durable.
 * The transcript reader is event-log-backed, so running this before completion
 * records a user-only snapshot that lags the assistant by one turn. End-of-turn
 * disk work is acceptable here (the public terminal is already committed), and
 * remains best-effort so memory observability can never fail a conversation. */
function refreshTerminalWorkingMemory(sessionId: string): void {
  try {
    const session = getSession(sessionId);
    if (session?.kind !== 'chat') return;
    const channel = session.channel ?? undefined;
    if (!isUserFacingSession(sessionId, channel)) return;
    refreshWorkingMemoryForSession(sessionId, channel);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('refreshWorkingMemory failed:', err instanceof Error ? err.message : err);
  }
}

async function runConversationCore(
  // The core demands a RESOLVED agent — capability resolution happened at the
  // spine's capability_resolve node (or the caller passed one pre-built).
  options: RunConversationOptions & { agent: Agent<any, any> },
): Promise<RunConversationResult> {
  // v0.5.19 F2 — `budget` is mutable so the elevate-on-warn path can
  // rebind it mid-conversation. The cached locals below pick up new
  // ceilings on the next loop iteration via the helper.
  let budget: HarnessBudgetRuntime = getHarnessBudgetSettings();
  let elevated = false;
  let maxSteps = resolveConversationStepCeiling(options.maxSteps, budget);
  let maxWallMs = options.maxWallClockMs ?? budget.maxConversationWallMs;
  let maxTurns = options.maxTurns ?? budget.maxTurns;
  let toolCallsPerTurn = options.toolCallsPerTurn ?? budget.toolCallsPerTurn;
  let checkInMs = Math.max(60_000, budget.checkInMinutes * 60 * 1000);
  const startedAt = Date.now();
  let lastCheckInAt = startedAt;
  // Stage 4 — aggregate run token budget: window opened at loop entry (or at
  // the caller's durable baseline), checked at the same boundary the
  // wall-clock uses. Enforcement is kill-switched and independent of the
  // configured step ceiling.
  const runTokenCeiling = resolveRunTokenCeiling({ override: options.maxRunTokens, budget });
  const tokenBudgetOn = runTokenBudgetEnforcementEnabled() && runTokenCeiling > 0;
  // Window (and its baseline SELECT) only exists when a ceiling can actually
  // fire — the unlimited preset / kill-switch pay zero per-boundary DB reads.
  const tokenWindow = tokenBudgetOn
    ? openRunTokenWindow({
        sessionId: options.sessionId,
        ceiling: runTokenCeiling,
        baseline: options.runTokenBaseline,
      })
    : null;
  // Durable window record: lets run_worker (any lane, any process) refuse to
  // spawn past this run's ceiling — the fan-out slice of the budget.
  if (tokenWindow) recordRunTokenWindow(tokenWindow);

  // A parked self-driving goal stops self-resumption; any turn that reaches
  // here is external re-engagement (a user reply or an outcome relay), which
  // unparks it so the goal heartbeats again. Self-resume turns never park a
  // goal first, so this is a no-op for them. Best-effort.
  try {
    const parkedGoal = safeActiveGoal(options.sessionId);
    if (parkedGoal?.parked && parkedGoal.selfDriving) unparkGoal(parkedGoal.id);
  } catch { /* unpark is best-effort */ }

  let stepIndex = 0;
  let nextInput = options.input;
  // CONVERGENCE (one beat, then execute): if Clem's previous turn ended by asking
  // a clarifying question and the user is now answering it, prepend an EXECUTE-now
  // directive so the model plans ONCE and acts — not another back-to-back question.
  // This standard harness lane serves Codex, OpenAI, and BYO models. Derive the
  // conversational state once and carry it through the run so prompt and code
  // rails agree. options.input is always the user's real message (continuations
  // re-assign nextInput inside the loop, never options.input).
  const resolvingClarification = convergenceSteerEnabled()
    && priorTurnEndedAwaitingClarification(options.sessionId);
  if (resolvingClarification) {
    nextInput = `${CONVERGENCE_STEER}\n\n${options.input}`;
  }
  // Artifact-park retry MUST verify (2026-07-22 Netlify incident): a session
  // parked on unresolved provider creates that receives a retry-shaped reply
  // used to run a plain turn — the model re-emitted the park message with ZERO
  // tool calls, an infinite retry loop. Rewrite the retry into a structured
  // verification directive carrying the exact pending claims, so the turn
  // CHECKS provider state (read-only) instead of re-narrating uncertainty.
  if (/^\/?\s*retry\s*\.?$/i.test(options.input.trim())) {
    // The parked claims live under a PRIOR turn's artifact root — the fresh
    // "retry" reply's own seq can never resolve them. Find the latest root
    // with unverified claims directly.
    const pendingRoot = latestPendingArtifactRootForSession(options.sessionId);
    const artifactState = pendingRoot
      ? standardArtifactTerminalState(options.sessionId, pendingRoot.sourceUserSeq)
      : null;
    if (artifactState && artifactState.pending.length > 0) {
      const claims = artifactState.pending.map((a) =>
        `- artifactId ${a.id}: ${a.kind} on ${a.provider}${a.resourceId ? ` (resourceId ${a.resourceId})` : ' (no resource id captured — the create may have died mid-flight)'}${a.uri ? ` uri=${a.uri}` : ''}`).join('\n');
      nextInput = [
        'ARTIFACT VERIFICATION RETRY — do not re-narrate the uncertainty; RESOLVE it with tools now.',
        `Unresolved provider create claim${artifactState.pending.length === 1 ? '' : 's'}:`,
        claims,
        'Using READ-ONLY tools (list/fetch on the provider — never a create):',
        '1. Check whether the resource actually exists (search by its intended name/id).',
        '2. If it EXISTS: report the exact resource id/URL and continue the original task from it — do NOT create a replacement.',
        '3. If it does NOT exist: say so explicitly with the evidence (e.g. the list result), then create it ONCE with the same intended parameters — the prior attempt provably never landed.',
        'After verifying, record the truth with the artifact_claim_resolve tool: resolution="bind" with the exact resourceId you read back when it exists, or resolution="absent" when a listing proves it was never created — THEN continue (bind → use the existing resource; absent → create once).',
        'If the provider cannot be read at all, say exactly which check failed so the user can verify manually.',
      ].join('\n');
    }
  }
  let lastDecision: OrchestratorDecisionShape | undefined;
  let lastTurn = 0;
  // Stall-retry counter (scoped to this conversation). Incremented each
  // time evaluateProgress() returns a stall AND we have retry budget
  // remaining. Reset implicitly because it's a local — a fresh
  // runConversation() call starts from zero.
  let stallRetriesUsed = 0;
  let missingReplyRetriesUsed = 0;
  // One-shot recovery-summary turn after stall retries exhaust (2026-07-23):
  // ask the model for the user-facing reply before ANY meta-failure fallback.
  let stallRecoverySummaryUsed = false;
  // True only for the single turn running the recovery directive — its reply
  // gets vetted (recoverySummaryReplyIsDeliverable) before contract delivery.
  let stallRecoveryTurnActive = false;

  // Independent objective-completion judge (Hermes-style). Only for interactive
  // chat callers (opt-in). The judge catches the model declaring "done" before
  // the artifact actually exists, and injects a continuation instead of
  // yielding. Bounded so a stubborn judge can't loop forever; fails open (judge
  // defaults to done) so it never wedges.
  //
  // A concrete tool-backed completion is structural evidence and must not be
  // bounced into repeating successful tools. The judge is reserved for
  // suspicious no-tool action claims and promise-shaped replies.
  const objectiveJudge = options.judgeFn ?? judgeObjectiveComplete;
  const objectiveJudgeOptIn = options.judgeCompletion === true;
  // On an approval/control turn ("go ahead"), keep every completion check
  // anchored to the consequential request that was actually aligned. The
  // objective lives in typed event state; no extra prompt block is injected.
  let objective = options.sourceUserSeq
    ? effectiveTurnObjective(options.sessionId, options.input, options.sourceUserSeq)
    : options.input;
  let objectiveJudgeActionIntent = classifyMessageIntent(objective).intent === 'action';
  // When a legacy/direct caller did not thread the accepted source row, the
  // first runTurn records it. Pin that exact row afterward so every synthetic
  // continuation and the artifact terminal refer to one logical user request.
  let activeSourceUserSeq = Number.isSafeInteger(options.sourceUserSeq) && (options.sourceUserSeq ?? 0) > 0
    ? options.sourceUserSeq
    : undefined;
  // Each NOT-DONE continuation is a full brain re-run (expensive). 3 was wasteful
  // for the common case; default to 2 (still room for a genuine multi-step finish)
  // and make it tunable — CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS (Phase 3 token).
  const MAX_OBJECTIVE_JUDGE_CONTINUATIONS = (() => {
    const raw = Number.parseInt(getRuntimeEnv('CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS', '2') ?? '2', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 2;
  })();
  // A turn that fired this many tool calls did real multi-step work, regardless
  // of how the request was phrased.
  const OBJECTIVE_JUDGE_WORK_THRESHOLD = 3;
  let objectiveJudgeContinuations = 0;
  let claimGroundingNudged = false;
  let selfResolveNudged = false;
  // Set only by the effect/artifact self-resolve node. The next model turn is
  // an evidence reconciler, not a new public-answer author; its durable
  // settlements decide whether this saved candidate may ship.
  let effectArtifactSelfReconciliation: EffectArtifactSelfReconciliation | null = null;
  let completionVerification: { failedOpen?: boolean; selfJudge?: boolean } | null = null;
  let totalToolCalls = 0;
  let meaningfulToolEvidence = false;
  // WATCHER judge (trajectory co-pilot, watcher-judge.ts). Spans the run for
  // opted-in action turns: every ~N tool calls a NON-BLOCKING background check
  // judges the trajectory against the GOAL; a confident drift verdict is
  // injected as a one-sentence steer at the NEXT continuation boundary — the
  // agent gets corrected mid-course instead of bounced by the completion judge
  // after the whole turn is burned. Never awaited on the critical path; ≤
  // MAX_WATCHER_INJECTIONS steers per run; silent on any judge failure.
  const watcherJudge = options.watcherJudge ?? runWatcherJudge;
  const watcherEnabled = watcherJudgeEnabled() && objectiveJudgeOptIn;
  const WATCHER_INTERVAL_TOOLS = watcherCheckIntervalTools();
  let watcherLastCheckedAt = 0;
  let watcherInjectionsUsed = 0;
  let watcherChecksUsed = 0;
  let watcherCheckInFlight = false;
  // Boxed: the background check assigns from inside a closure the loop body
  // reads on later iterations (a bare local narrows to `never` under TS CFA).
  const watcherSteerBox: { pending: WatcherVerdict | null } = { pending: null };

  // W1a chat step-boundary brain fallover state. `currentAgent` swaps to a
  // rebuilt agent on the next brain when a turn fails transiently; tried ids
  // prevent re-trying the same brain. Capability = caller passed both hooks.
  let currentAgent = options.agent;
  const triedFalloverModelIds = new Set<string>();
  const falloverCapable = !!options.rebuildAgentForBrain && (options.falloverModelIds?.length ?? 0) > 0;
  // True for the iteration immediately following a brain switch — the input for
  // this step was already recorded (and memory-captured) by the failed attempt,
  // so the re-attempt must not duplicate either.
  let falloverReattempt = false;

  // One-way budget elevation (standard → long). Shared by the token-fraction
  // trigger (preflight warn/block) and the step-progress trigger below. Rebinds
  // the cached ceilings so the next loop iteration picks them up. No-op when
  // getElevatedBudget declines (knob off / not standard).
  const applyElevation = (eventData: Record<string, unknown>): void => {
    const next = getElevatedBudget(budget);
    if (next === budget) return;
    const prev = { maxSteps, maxTurns, toolCallsPerTurn, maxWallMs };
    budget = next;
    maxSteps = options.maxSteps ?? Math.max(maxSteps, budget.maxConversationSteps);
    maxWallMs = options.maxWallClockMs ?? Math.max(maxWallMs, budget.maxConversationWallMs);
    maxTurns = options.maxTurns ?? Math.max(maxTurns, budget.maxTurns);
    toolCallsPerTurn = options.toolCallsPerTurn ?? Math.max(toolCallsPerTurn, budget.toolCallsPerTurn);
    checkInMs = Math.min(checkInMs, Math.max(60_000, budget.checkInMinutes * 60 * 1000));
    elevated = true;
    safeAppend({
      sessionId: options.sessionId,
      turn: lastTurn,
      role: 'system',
      type: 'budget_elevated',
      data: { ...eventData, from: prev, to: { maxSteps, maxTurns, toolCallsPerTurn, maxWallMs } },
    });
  };

  while (stepIndex < maxSteps) {
    stepIndex += 1;
    // A stall judge may rescue prose that the deterministic parser rejected,
    // but it only establishes "this is a reply", never "the objective is done".
    // Keep the origin for telemetry while the synthesized decision traverses
    // the same goal/objective/fresh-write/delivery doors as every other terminal.
    let stallJudgeDelivery: { signal: string; detail: Record<string, unknown> } | null = null;

    // True when THIS turn's input is a harness directive that forbids tool
    // calls and demands a plain-text reply (the draft-present stall retry).
    // The zero-tool stall detectors must not fire on a turn that complied.
    const plainTextContractTurn = isPlainTextContractDirective(nextInput);

    // Baseline for the canSwitch guard: if this turn lands or may have landed
    // an external write, we must NOT re-dispatch it to another brain. Exact
    // proven-no-effect failures remain eligible for useful fallover.
    const externalWriteBoundarySeq = falloverCapable
      ? (listEvents(options.sessionId, {
          types: [...EXTERNAL_WRITE_LIFECYCLE_TYPES],
        }).at(-1)?.seq ?? 0)
      : 0;
    const canStillFallover = falloverCapable
      && triedFalloverModelIds.size < (options.falloverModelIds?.length ?? 0);

    // Legacy/direct callers historically recorded harness continuation text as
    // a user_input_received audit row. Preserve that observability without
    // letting the synthetic row replace the exact accepted source authority
    // threaded into tool gates and artifact lineage.
    if (!options.sourceUserSeq && activeSourceUserSeq && stepIndex > 1 && !falloverReattempt) {
      try {
        const row = getSession(options.sessionId);
        if (row) {
          safeAppend({
            sessionId: options.sessionId,
            turn: nextTurnNumber(row),
            role: 'user',
            type: 'user_input_received',
            data: { text: nextInput, synthetic: true, sourceUserSeq: activeSourceUserSeq },
          });
        }
      } catch { /* synthetic audit compatibility must not block execution */ }
    }
    const turnResult = await runTurn({
      agent: currentAgent,
      sessionId: options.sessionId,
      input: nextInput,
      authoritativeUserInput: stepIndex === 1 ? options.input : undefined,
      // Only the first step carries the real user message; every later step is a
      // harness continuation (judge/stall/grounding re-prompt) → don't learn it.
      // A fallover re-attempt re-runs the SAME step → its input is already
      // recorded + captured, so suppress both regardless of stepIndex.
      suppressMemoryCapture: stepIndex > 1 || falloverReattempt,
      reuseRecordedUserInput: falloverReattempt
        ? true
        : (stepIndex === 1 ? options.reuseRecordedUserInput : false),
      // The entire self-continuation/fallover chain remains authorized by the
      // same accepted user event; a synthetic prompt never becomes authority.
      sourceUserSeq: activeSourceUserSeq,
      runAttemptId: options.runAttemptId,
      maxTurns,
      toolCallsPerTurn,
      makeRunner: options.makeRunner,
      runRunner: options.runRunner,
      // Defer the infra ask only while another brain is still available to try.
      deferInfraAsk: canStillFallover,
      mcpToolScope: options.mcpToolScope,
    });
    falloverReattempt = false;
    lastTurn = turnResult.turn;
    if (!activeSourceUserSeq) {
      try {
        activeSourceUserSeq = listEvents(options.sessionId, { types: ['user_input_received'] })
          .filter((event) => event.turn === turnResult.turn)
          .at(-1)?.seq;
      } catch { /* missing event authority leaves artifact completion fail-closed */ }
    }
    if (activeSourceUserSeq) {
      // Resolve the standard attempt even when this particular turn made no
      // create/read-back call. That is what lets an immediate reply to the
      // typed artifact-verification pause inherit the exact prior root. The
      // public source lookup below only exposes it if durable artifacts exist.
      resolveArtifactRunScopeId(
        options.sessionId,
        `${options.sessionId}::turn:${turnResult.turn}`,
        activeSourceUserSeq,
      );
      objective = effectiveTurnObjective(options.sessionId, options.input, activeSourceUserSeq);
      objectiveJudgeActionIntent = classifyMessageIntent(objective).intent === 'action';
    }
    totalToolCalls += turnResult.toolCalls ?? 0;
    meaningfulToolEvidence = meaningfulToolEvidence
      || turnHasMeaningfulSuccessfulToolEvidence(options.sessionId, turnResult.turn, objective);
    const durableMemoryCaptureEvidence = turnHasDurableMemoryCaptureEvidence(
      options.sessionId,
      turnResult.turn,
    );

    // A verified queue receipt transfers ownership to the durable workflow
    // graph. This check precedes model-status/prose handling on purpose: a
    // successful effect cannot be undone by a malformed handoff narration.
    if (activeSourceUserSeq) {
      const dispatch = finalizePreparedWorkflowDispatchForSource(
        options.sessionId,
        activeSourceUserSeq,
      );
      if (dispatch) {
        return recordAsyncWorkflowDispatch({
          sessionId: options.sessionId,
          sourceUserSeq: activeSourceUserSeq,
          receipts: [dispatch.receipt],
          steps: stepIndex,
          lastDecision,
          lastTurn,
        });
      }
    }

    // W1a — chat step-boundary brain fallover. A deferred transient model/codex
    // error (infraTransientKind set, ask NOT yet written) → re-attempt on the next
    // brain, guarded so a turn that already wrote externally is never re-run.
    if (turnResult.infraTransientKind && falloverCapable) {
      const canSwitch = !externalWriteReplayRiskAfter(
        options.sessionId,
        externalWriteBoundarySeq,
      );
      const nextModelId = canSwitch
        ? (options.falloverModelIds ?? []).find((m) => !triedFalloverModelIds.has(m))
        : undefined;
      if (nextModelId) {
        triedFalloverModelIds.add(nextModelId);
        let rebuilt: Agent<any, any> | null = null;
        try { rebuilt = await options.rebuildAgentForBrain!(nextModelId); } catch { rebuilt = null; }
        if (rebuilt) {
          currentAgent = rebuilt;
          safeAppend({
            sessionId: options.sessionId,
            turn: turnResult.turn,
            role: 'system',
            type: 'brain_fallover',
            data: { reason: 'chat_step_boundary', kind: turnResult.infraTransientKind, toModel: nextModelId, attempt: triedFalloverModelIds.size },
          });
          stepIndex -= 1; // re-attempt the SAME step on the next brain
          falloverReattempt = true; // its input is already recorded — don't duplicate
          continue;
        }
      }
      // Brains exhausted / external write already happened / rebuild failed. In an
      // UNATTENDED run there's no one to answer, so self-heal: auto-retry the same
      // step (bounded) or fail honestly — never strand it on an ask.
      const infraDecision = decideInfraRecovery(options.sessionId);
      if (infraDecision === 'auto_retry') {
        emitInfraAutoRecoverEvent(options.sessionId, turnResult.turn, turnResult.infraTransientKind, countInfraAutoRecover(options.sessionId) + 1);
        nextInput = buildInfraRetryDirective(turnResult.infraTransientKind);
        falloverReattempt = false;
        continue;
      }
      // The turn is ENDING here (ask/exhausted) — register any in-flight tool.
      recordOrphanedToolInFlight(options.sessionId, turnResult.turn);
      if (infraDecision === 'exhausted') {
        emitInfraUnrecovered(options.sessionId, turnResult.turn, turnResult.infraTransientKind, turnResult.error ?? '');
        return {
          sessionId: options.sessionId,
          status: 'failed',
          steps: stepIndex,
          lastDecision,
          lastTurn,
          error: turnResult.error,
        };
      }
      // Attended: emit the same infra-recovery ask the non-fallover path would have.
      emitInfraTransientAsk(
        options.sessionId,
        turnResult.turn,
        turnResult.infraTransientKind,
        turnResult.infraTransientUserMessage ?? '',
        undefined,
        turnResult.error ?? '',
      );
      return {
        sessionId: options.sessionId,
        status: 'awaiting_user_input',
        steps: stepIndex,
        lastDecision,
        lastTurn,
        error: turnResult.error,
      };
    }

    // UNATTENDED infra self-heal (handleRunError sites): a transient infra error /
    // tool-timeout in a workflow/background run comes back as an auto-retry
    // directive instead of an ask. Re-run the SAME step with it, recording the
    // self-heal in the trace. Bounded by decideInfraRecovery — once the budget is
    // spent handleRunError emits run_failed and returns 'failed' (no directive),
    // so this never loops forever.
    if (turnResult.infraAutoRetry) {
      emitInfraAutoRecoverEvent(options.sessionId, turnResult.turn, turnResult.infraAutoRetry.kind, countInfraAutoRecover(options.sessionId) + 1);
      nextInput = turnResult.infraAutoRetry.directive;
      falloverReattempt = false;
      continue;
    }

    // v0.5.19 F2 — elevate budget mid-conversation if the preflight
    // gate just emitted warn/block AND we're still on `standard`.
    // The 40/40/40 standard caps can be too small for a legitimate task.
    // One-way ratchet — once elevated this run stays elevated, but the long
    // preset's authored 160-step activation ceiling remains authoritative.
    // Honors CLEMMY_AUTOBUMP_BUDGET.
    if (!elevated && budget.preset === 'standard') {
      const recentPreflight = findLatestPreflightVerdict(options.sessionId, lastTurn);
      if (recentPreflight && (recentPreflight.status === 'warn' || recentPreflight.status === 'block')
          && recentPreflight.fractionUsed > 0.5) {
        applyElevation({
          reason: 'preflight_warn',
          preflightStatus: recentPreflight.status,
          fractionUsed: recentPreflight.fractionUsed,
        });
      }
    }

    // ask_user_question is a terminal tool contract even when a provider
    // reports the SDK turn itself as "completed". Honor the durable pause
    // before reconciliation, prose parsing, completion validation, or any
    // other terminal path.
    const completedTurnQuestion = turnResult.status === 'completed'
      ? awaitingUserQuestionThisTurn(options.sessionId, turnResult.turn)
      : null;
    if (completedTurnQuestion) {
      commitStandardPauseTerminal({
        sessionId: options.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        turn: turnResult.turn,
        steps: stepIndex,
        summary: completedTurnQuestion,
        reply: completedTurnQuestion,
      });
      return {
        sessionId: options.sessionId,
        status: 'awaiting_user_input',
        steps: stepIndex,
        lastDecision,
        lastTurn,
      };
    }

    // The one turn after the effect/artifact self-resolve nudge is a typed
    // reconciliation node. It may append read-back evidence and exact ledger
    // settlements, but its prose is private control output. Resolve the saved
    // public candidate from durable state before parsing that prose so compact
    // protocol (`done=true / nextAction=...`) can never replace the answer.
    if (turnResult.status === 'completed' && effectArtifactSelfReconciliation) {
      const recovery = effectArtifactSelfReconciliation;
      const assessment = assessEffectArtifactSelfReconciliation({
        sessionId: options.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        recovery,
      });
      if (assessment.status !== 'settled') {
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'system',
          type: 'guardrail_tripped',
          data: {
            kind: 'self_reconciliation_blocked',
            status: assessment.status,
            reason: assessment.reason,
            sourceUserSeq: activeSourceUserSeq ?? null,
            originTurn: recovery.originTurn,
            externalWriteStatus: assessment.externalWriteStatus ?? null,
          },
        });
        // Keep the established artifact retry contract: an exact unresolved
        // create parks as needs-input with its artifact IDs/options. External
        // write ambiguity has no equivalent safe retry, so it stays blocked.
        if (assessment.reason === 'artifact_reconciliation_remains_unresolved') {
          const parked = parkForPendingStandardArtifacts({
            sessionId: options.sessionId,
            sourceUserSeq: activeSourceUserSeq,
            turn: turnResult.turn,
            steps: stepIndex,
            summary: assessment.publicText,
            internalSummary: recovery.originalDecision.summary,
            reply: recovery.publicText,
            lastDecision: recovery.originalDecision,
            lastTurn,
          });
          if (parked) return parked;
        }
        const artifactState = standardArtifactTerminalState(options.sessionId, activeSourceUserSeq);
        const publicPresentation = commitStandardBlockedTerminal({
          sessionId: options.sessionId,
          sourceUserSeq: activeSourceUserSeq,
          turn: turnResult.turn,
          text: assessment.publicText,
          legacyReason: 'blocked',
          metadata: {
            steps: stepIndex,
            blockedReason: assessment.reason,
            reconciliationOriginTurn: recovery.originTurn,
            reconciliationStatus: assessment.status,
            ...(artifactState ? artifactVerificationProjection(artifactState) : {}),
          },
        });
        return {
          sessionId: options.sessionId,
          status: 'awaiting_user_input',
          steps: stepIndex,
          lastDecision: recovery.originalDecision,
          lastTurn,
          publicPresentation,
        };
      }

      const deliveryGateRan = verifyDeliveredEnabled()
        && !recovery.skipDeliveryGate
        && !dispatchedBackgroundWorkflowRun(options.sessionId, turnResult.turn);
      const delivery: DeliveryVerdict = deliveryGateRan
        ? await verifyDelivered(recovery.objective, assessment.publicText, {
          judgeFn: recovery.completionVerdict
            ? async () => recovery.completionVerdict as ObjectiveJudgeVerdict
            : objectiveJudge,
        })
        : { delivered: true, status: 'completed' };
      if (deliveryGateRan) {
        recordVerdictEvent(options.sessionId, turnResult.turn, {
          door: 'delivery',
          pass: delivery.delivered,
          reason: delivery.reason,
          failedOpen: delivery.verification?.failedOpen,
          selfJudge: delivery.verification?.selfJudge,
          ...(delivery.blockerType ? { detail: { blockerType: delivery.blockerType } } : {}),
        });
      }
      if (delivery.verification) completionVerification = delivery.verification;
      if (!delivery.delivered) {
        const artifactState = standardArtifactTerminalState(options.sessionId, activeSourceUserSeq);
        const publicPresentation = commitStandardBlockedTerminal({
          sessionId: options.sessionId,
          sourceUserSeq: activeSourceUserSeq,
          turn: turnResult.turn,
          text: assessment.publicText,
          legacyReason: 'blocked',
          metadata: {
            steps: stepIndex,
            blockedReason: delivery.reason ?? 'saved_public_candidate_not_delivered',
            reconciliationOriginTurn: recovery.originTurn,
            reconciliationStatus: assessment.status,
            ...(completionVerification ? { verification: completionVerification } : {}),
            ...(artifactState ? artifactVerificationProjection(artifactState) : {}),
          },
        });
        return {
          sessionId: options.sessionId,
          status: 'awaiting_user_input',
          steps: stepIndex,
          lastDecision: recovery.originalDecision,
          lastTurn,
          publicPresentation,
        };
      }

      return finalizeStandardConversation({
        sessionId: options.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        turn: turnResult.turn,
        eventData: {
          steps: stepIndex,
          reason: 'effect_artifact_reconciled',
          summary: assessment.publicText,
          reply: assessment.publicText,
          internalSummary: recovery.originalDecision.summary,
          internalReply: recovery.originalDecision.reply ?? null,
          delivered: true,
          reconciliationOriginTurn: recovery.originTurn,
          reconciliationStatus: assessment.status,
          ...(completionVerification ? { verification: completionVerification } : {}),
        },
        result: {
          sessionId: options.sessionId,
          status: 'completed',
          steps: stepIndex,
          lastDecision: recovery.originalDecision,
          lastTurn,
        },
      });
    }

    // Any non-completed status propagates immediately. The conversation
    // can't continue if the SDK paused for approval, the kill switch
    // tripped, the brackets blew, or an error fired.
    if (turnResult.status !== 'completed') {
      const status: RunConversationStatus = turnResult.status;
      if (status === 'awaiting_user_input') {
        const latestQuestion = awaitingUserQuestionThisTurn(options.sessionId, turnResult.turn)
          ?? 'Awaiting your input.';
        commitStandardPauseTerminal({
          sessionId: options.sessionId,
          sourceUserSeq: activeSourceUserSeq,
          turn: turnResult.turn,
          steps: stepIndex,
          summary: latestQuestion,
          reply: latestQuestion,
        });
      }
      return {
        sessionId: options.sessionId,
        status,
        steps: stepIndex,
        lastDecision,
        lastTurn,
        error: turnResult.error,
      };
    }

    // A completed turn MUST hand back an OrchestratorDecision-shaped
    // finalOutput. If it doesn't, treat the conversation as complete
    // (the Orchestrator chose to end without our structured shape).
    const structuredNoToolResult = options.acceptStructuredNoToolResult
      && (turnResult.toolCalls ?? 0) === 0
      ? strictStructuredNoToolResultText(turnResult.finalOutput)
      : null;
    let decision = structuredNoToolResult
      ? {
          summary: 'Structured decision returned for caller validation.',
          reply: structuredNoToolResult,
          done: true,
          nextAction: 'completed' as const,
          reason: 'structured_no_tool_result',
        }
      : toOrchestratorDecision(turnResult.finalOutput);
    // A terse completion acknowledgement after verified work is a valid
    // terminal reply, not an unparseable decision. `parseDecisionText` keeps
    // bare acknowledgements null so a true ZERO-work "Noted." / "Done." cannot
    // masquerade as progress. Once this run has durable successful-tool OR
    // crash-safe memory-intake evidence, retrying the acknowledgement repeats
    // completed work (live repro: memory_remember ran twice and burned three
    // model turns after the first write had already succeeded). Preserve the
    // strict zero-work stall behavior while letting evidence-backed
    // acknowledgements finish through the ordinary completion/delivery gates.
    if (
      !decision
      && (meaningfulToolEvidence || durableMemoryCaptureEvidence)
      && typeof turnResult.finalOutput === 'string'
    ) {
      const acknowledgement = turnResult.finalOutput.trim();
      if (/^(?:ok|okay|done|got it|understood|noted|yes|alright|certainly)\.?$/i.test(acknowledgement)) {
        decision = {
          summary: acknowledgement,
          reply: acknowledgement,
          done: true,
          nextAction: 'completed',
          reason: 'durable_work_acknowledged',
        };
      }
    }
    // Fire-and-forget dispatch handoff (live 2026-07-23): the turn queued a
    // background run (workflow_run) and replied exactly as the rubric mandates
    // ("running in the background — I'll report back"). The text-only
    // announcement heuristic nulls that REQUIRED reply as a punt, which sent a
    // FINISHED turn into D_decision_unparsed → A_zero_tools → a nonsense
    // "Should I retry?" ask. Both anchors must hold: a real dispatch tool call
    // THIS turn (effect) + the handoff phrasing (text). "I'll draft it next"
    // after partial work matches neither and still retries.
    if (
      !decision
      && (turnResult.toolCalls ?? 0) > 0
      && typeof turnResult.finalOutput === 'string'
      && looksLikeDispatchHandoffReply(turnResult.finalOutput)
      && turnDispatchedBackgroundRun(options.sessionId, turnResult.turn)
    ) {
      const handoffReply = turnResult.finalOutput.trim();
      decision = {
        summary: handoffReply.slice(0, 200),
        reply: handoffReply,
        done: true,
        nextAction: 'completed',
        reason: 'dispatch_handoff_reply',
      };
    }
    lastDecision = decision ?? lastDecision;

    captureWorkflowStepResultTranscript({
      sessionId: options.sessionId,
      turn: turnResult.turn,
      output: turnResult.finalOutput,
    });
    if (hasCapturedWorkflowStepResult(options.sessionId)) {
      return completeCapturedWorkflowStepResult({
        sessionId: options.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        turn: turnResult.turn,
        steps: stepIndex,
        decision,
      });
    }

    const missingReplyDecision = isCompletedWithoutUserFacingReply(decision) ? decision : null;
    if (
      missingReplyDecision
      && missingReplyRetriesUsed < MAX_MISSING_REPLY_RETRIES
      && stepIndex < maxSteps
    ) {
      missingReplyRetriesUsed += 1;
      safeAppend({
        sessionId: options.sessionId,
        turn: turnResult.turn,
        role: 'system',
        type: 'guardrail_tripped',
        data: {
          kind: 'completed_without_reply',
          attempt: missingReplyRetriesUsed,
          maxRetries: MAX_MISSING_REPLY_RETRIES,
          internalSummary: missingReplyDecision.summary,
          path: 'conversation',
        },
      });
      nextInput = buildMissingReplyRetryMessage(missingReplyDecision, 'conversation');
      continue;
    }

    safeAppend({
      sessionId: options.sessionId,
      turn: turnResult.turn,
      role: 'Clem',
      type: 'conversation_step',
      data: {
        step: stepIndex,
        decision: userVisibleStepDecision(decision),
      },
    });

    const structuredStallInfo = decision && !structuredNoToolResult
      ? evaluateStructuredDecisionStall({
          decision,
          toolCalls: turnResult.toolCalls ?? 0,
          sessionId: options.sessionId,
          turn: turnResult.turn,
        })
      : undefined;
    structuredStallResolution: if (structuredStallInfo) {
      // STALL JUDGE, structured-path twin (2026-07-24 robust-tool-call audit):
      // a structured tool-unavailable claim may be TRUE (a specific integration
      // genuinely unconnected) — honest-gap vs lie is semantic. Same
      // delivery-only authority and fallbacks as the unparsed site.
      if (
        stallRetriesUsed === 0 &&
        stallIsJudgeAmbiguous(structuredStallInfo, { userInput: String(options.input ?? '') })
      ) {
        const structuredReplyText = (decision?.reply ?? decision?.summary ?? '').trim();
        if (structuredReplyText.length >= 40) {
          const judgedStructured = await judgeAmbiguousStallReply({
            userInput: String(options.input ?? ''),
            replyText: structuredReplyText,
          });
          if (judgedStructured === 'deliver') {
            // The reply judge validates prose, not task completion. Preserve the
            // model's explicit structured state (especially awaiting_*); only an
            // unstructured salvage needs a synthesized terminal candidate.
            stallJudgeDelivery = {
              signal: structuredStallInfo.signal,
              detail: structuredStallInfo.detail,
            };
            break structuredStallResolution;
          }
        }
      }
      safeAppend({
        sessionId: options.sessionId,
        turn: turnResult.turn,
        role: 'system',
        type: 'stuck_detected',
        data: {
          signal: structuredStallInfo.signal,
          ...structuredStallInfo.detail,
        },
      });

      if (stallRetriesUsed < MAX_STALL_RETRIES) {
        stallRetriesUsed += 1;
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'system',
          type: 'stall_retry_attempted',
          data: {
            signal: structuredStallInfo.signal,
            attempt: stallRetriesUsed,
            maxRetries: MAX_STALL_RETRIES,
            rawOutput: structuredStallInfo.rawOutput,
          },
        });
        const backoffMs = STALL_RETRY_BACKOFF_MS[stallRetriesUsed - 1] ?? 1000;
        if (backoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
        nextInput = `${buildStallRetryMessage(options.sessionId, structuredStallInfo)} The tool surface is available in this run; do not ask the user to resend a tool-enabled message. Pick the needed local, shell, web, memory, or external-service tool and call it now.`;
        continue;
      }
      // Recovery-summary turn (2026-07-23): before ANY user-facing fallback,
      // spend one turn asking the model for the reply the user should see.
      // The contract phrasing makes a compliant zero-tool reply deliverable.
      if (!stallRecoverySummaryUsed) {
        stallRecoverySummaryUsed = true;
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'system',
          type: 'stall_retry_attempted',
          data: { signal: structuredStallInfo.signal, attempt: 'recovery_summary', maxRetries: MAX_STALL_RETRIES },
        });
        nextInput = buildStallRecoverySummaryMessage(String(options.input ?? ''));
        stallRecoveryTurnActive = true;
        continue;
      }
      const askUserEnabled =
        (getRuntimeEnv('HARNESS_STALL_ASK_USER', 'on') ?? 'on').toLowerCase() !== 'off';
      if (askUserEnabled) {
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'Clem',
          type: 'awaiting_user_input',
          data: {
            question: STALL_FLOOR_QUESTION,
            options: STALL_FLOOR_OPTIONS,
            source: 'stall_recovery',
            signal: structuredStallInfo.signal,
          },
        });
        commitStandardPauseTerminal({
          sessionId: options.sessionId,
          sourceUserSeq: activeSourceUserSeq,
          turn: turnResult.turn,
          steps: stepIndex,
          summary: STALL_FLOOR_QUESTION,
        });
        return {
          sessionId: options.sessionId,
          status: 'awaiting_user_input',
          steps: stepIndex,
          lastDecision,
          lastTurn,
        };
      }
    }

    unstructuredDecisionResolution: if (!decision) {
      // A real ask_user_question tool call is already the canonical terminal
      // decision. Some models follow it with ordinary prose ("Waiting on your
      // answer") instead of an ASK marker; treating that prose as unparseable
      // re-runs the brain and emits the same question twice. Trust the durable
      // current-turn pause event before any parse/stall recovery.
      const toolAskThisTurn = (() => {
        try {
          return listEvents(options.sessionId, { types: ['awaiting_user_input'] })
            .find((event) => event.turn === turnResult.turn);
        } catch {
          return undefined;
        }
      })();
      if (toolAskThisTurn) {
        const question = String((toolAskThisTurn.data as { question?: unknown }).question ?? 'Awaiting your input.');
        commitStandardPauseTerminal({
          sessionId: options.sessionId,
          sourceUserSeq: activeSourceUserSeq,
          turn: turnResult.turn,
          steps: stepIndex,
          summary: question,
          reply: question,
        });
        return {
          sessionId: options.sessionId,
          status: 'awaiting_user_input',
          steps: stepIndex,
          lastDecision,
          lastTurn,
        };
      }
      // PLAIN-TEXT-CONTRACT FULFILLMENT (2026-07-08). This turn's input was a
      // harness directive that said "do NOT call a tool — reply to the user
      // NOW" (the draft-present stall retry). A zero-tool text reply is exactly
      // what was demanded: deliver it. Without this, the reply falls through to
      // evaluateProgress, where STALL_ANNOUNCEMENT_PATTERN can match verbs
      // INSIDE the presented draft ("checking", "I'll") and flag compliance as
      // a stall — the harness then re-issues the same directive, gets the same
      // correct reply, and after MAX_STALL_RETRIES replaces the answer with the
      // "unable to make progress" banner. In the draft-present regression, the
      // correct reply was produced and discarded three times. A short generic ack ("OK.")
      // is NOT compliance — it still falls through to the stall machinery.
      // Consume the recovery-turn marker for THIS turn only (set when the
      // exhaustion path issued the recovery directive last iteration).
      const recoveryTurnNow = stallRecoveryTurnActive;
      stallRecoveryTurnActive = false;
      if (plainTextContractTurn && (turnResult.toolCalls ?? 0) === 0 && typeof turnResult.finalOutput === 'string') {
        const contractReply = turnResult.finalOutput.trim();
        // Recovery-turn vet (2026-07-23): a false action claim or detected-bad
        // shape must not launder through the recovery directive — it falls
        // through to the stall machinery and reaches the human floor instead.
        if (recoveryTurnNow && !recoverySummaryReplyIsDeliverable(contractReply, { sessionId: options.sessionId, turn: turnResult.turn })) {
          // fall through — no delivery
        } else if (contractReply && (contractReply.length > 60 || !STALL_OUTPUT_PATTERN.test(contractReply))) {
          // Synthesize the decision for the RETURN-VALUE lane (2026-07-13): every
          // salvage here completes with decision===null, so lastDecision was
          // undefined and respondViaHarness (respond-bridge.ts) built its reply
          // from lastDecision → shipped "(no reply produced)" on the API/Discord
          // surfaces while the event lane (desktop dock) showed the real reply —
          // a parity defect across the whole salvage CLASS. The event below stays
          // the source of truth; this mirrors it into the return value.
          lastDecision = { summary: contractReply, reply: contractReply, done: true, nextAction: 'completed', reason: null };
          return finalizeStandardConversation({
            sessionId: options.sessionId,
            sourceUserSeq: activeSourceUserSeq,
            turn: turnResult.turn,
            eventData: {
              steps: stepIndex,
              reason: 'plain_text_contract_fulfilled',
              summary: contractReply,
              reply: contractReply,
              delivered: true,
            },
            result: {
              sessionId: options.sessionId,
              status: 'completed',
              steps: stepIndex,
              lastDecision,
              lastTurn,
            },
          });
        }
      }
      // VERBATIM-ECHO FULFILLMENT (2026-07-13). The user's own directive explicitly
      // asked for an exact short reply ("Reply with just the word: ok") and the model
      // produced EXACTLY that with zero tools. parseDecisionText nulls it as a generic
      // ack (STALL_OUTPUT_PATTERN), so without this it falls to the stall steer ("you
      // MUST call a tool") and the model flails call_tool with varying args until the
      // budget cap — the F1 runaway. The requested literal is grammatically bound to a
      // reply verb / "the word <X>" construction AND the reply EQUALS it, so this is
      // fulfillment, not a punt. A lazy "OK." on an OPEN task has no bound literal equal
      // to "ok" and still falls through to the stall machinery below (the deliberate
      // ack-exclusion is untouched). Keyed on options.input — the code guarantees that
      // is ALWAYS the user's real message (continuations only ever re-assign nextInput,
      // and a convergence-steer prefix could push nextInput past the length gate), so
      // this reads the user's actual ask, not a harness directive. The EQUALITY gate is
      // the guard against re-firing: any turn whose reply is not exactly the literal
      // (a real tool turn, an announcement) simply doesn't match.
      if (
        (turnResult.toolCalls ?? 0) === 0 &&
        typeof turnResult.finalOutput === 'string' &&
        replyFulfillsVerbatimRequest(options.input, turnResult.finalOutput)
      ) {
        const verbatimReply = turnResult.finalOutput.trim();
        // Mirror the reply into the return value for the respond-bridge lane
        // (see the plain-text-contract salvage above — same class fix).
        lastDecision = { summary: verbatimReply, reply: verbatimReply, done: true, nextAction: 'completed', reason: null };
        return finalizeStandardConversation({
          sessionId: options.sessionId,
          sourceUserSeq: activeSourceUserSeq,
          turn: turnResult.turn,
          eventData: {
            steps: stepIndex,
            reason: 'verbatim_reply_fulfilled',
            summary: verbatimReply,
            reply: verbatimReply,
            delivered: true,
          },
          result: {
            sessionId: options.sessionId,
            status: 'completed',
            steps: stepIndex,
            lastDecision,
            lastTurn,
          },
        });
      }
      // Malformed/unparseable-decision RECOVERY. Sub-agents are TOOLS here (no
      // SDK handoffs — see orchestrator.ts), so a null decision means the
      // Orchestrator itself produced output that didn't fit the decision schema.
      // This is common on a COMPLEX task after real tool work — the model starts
      // emitting the deliverable (HTML, a long plan) inline and breaks the JSON
      // shape. The stall detectors below only catch the ZERO-tool / generic-ack
      // PUNT case (and own its specialized retry + awaiting_user_input ask), so
      // we scope THIS recovery to the did-work-then-malformed case (toolCalls>0)
      // to stay no-regression: a turn that took real action but emitted an
      // unparseable decision would otherwise die with "couldn't be structured"
      // and no recourse (observed live: a website build+deploy stopped after
      // loading skills + checking the env). Re-prompt for the structured
      // decision AND the next concrete action so the task actually finishes.
      // Zero-tool nulls fall through to evaluateProgress below, unchanged.
      // Reuses the bounded stall-retry budget.
      if ((turnResult.toolCalls ?? 0) > 0 && stallRetriesUsed < MAX_STALL_RETRIES) {
        stallRetriesUsed += 1;
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'system',
          type: 'stall_retry_attempted',
          data: { signal: 'D_decision_unparsed', attempt: stallRetriesUsed, maxRetries: MAX_STALL_RETRIES },
        });
        const backoffMs = STALL_RETRY_BACKOFF_MS[stallRetriesUsed - 1] ?? 1000;
        if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
        nextInput = 'Your previous response could not be parsed into the required structured decision. Re-issue your turn as PLAIN TEXT — no JSON: end with your answer for the user, or a leading `ASK: <question>` if you need me, or `CONTINUE: <why>` if you have more tool calls to make. Keep the reply concise and put any large deliverable in FILES via the file tools, never inline. If the task is NOT finished, take the next concrete action now (write the files, run the shell/CLI command, deploy) — do not stop at a plan; keep going until the actual deliverable exists.';
        continue;
      }
      // Retry budget exhausted, or genuinely nothing to recurse on. End cleanly.
      // (Historically this also covered a handoff target becoming the final
      // agent; sub-agents are tools now, but the fallback summary still gives
      // the UI something to render instead of just "complete".)
      let fallbackSummary = extractFallbackSummary(turnResult.finalOutput);
      // ALWAYS REPORT BACK: a structure-less / unparseable completion that still did
      // real work reports WHAT it did, not a blank "(Finished without a written
      // reply.)". Only fills a genuinely empty fallback, and only from THIS request's
      // external_write events.
      if (!fallbackSummary || !fallbackSummary.trim()) {
        try {
          const report = synthesizeTurnReport(options.sessionId, activeSourceUserSeq);
          if (report) fallbackSummary = report;
        } catch { /* fail-open to the original fallback */ }
      }

      // Stall detection: the sub-agent took zero tool calls AND emitted
      // a short generic acknowledgement ("Continuing.", "OK.", "Done.").
      // That means the model received the handoff and punted instead of
      // acting on the directive. Rendering "Continuing." as if it were
      // the bot's reply hides the failure — the user sees a non-answer
      // and assumes the agent is working when it actually gave up.
      // Override the summary so the failure is visible and actionable.
      const stallInfo = evaluateProgress({
        finalOutput: turnResult.finalOutput,
        toolCalls: turnResult.toolCalls ?? 0,
        sessionId: options.sessionId,
        turn: turnResult.turn,
      });

      // Emit a dedicated stuck_detected event so the dashboard
      // (Recent Errors panel, future Tier 3) can show stall patterns
      // distinct from generic conversation_completed.
      if (stallInfo) {
        // STEER-TURN salvage (live 2026-07-23): "always take this path ok?"
        // and "keep pushing through" (while this chat's dispatched background
        // run was in flight) both rode the stall machinery into "I've been
        // unable to make progress — retry, switch approach, or stop?". For an
        // ack/steer user turn, the model's substantive prose IS the answer —
        // deliver it; never the meta-failure ask. Detected-bad shapes and
        // real work asks fall through to the normal stall handling.
        const steerReply = steerTurnReplySalvage({
          userInput: String(options.input ?? ''),
          finalOutput: turnResult.finalOutput,
          hasActiveBackgroundWork: turnDispatchedBackgroundRun(options.sessionId),
        });
        if (steerReply) {
          lastDecision = { summary: steerReply.slice(0, 200), reply: steerReply, done: true, nextAction: 'completed', reason: 'steer_turn_reply' };
          return finalizeStandardConversation({
            sessionId: options.sessionId,
            sourceUserSeq: activeSourceUserSeq,
            turn: turnResult.turn,
            eventData: {
              steps: stepIndex,
              reason: 'steer_turn_reply',
              summary: steerReply.slice(0, 200),
              reply: steerReply,
              delivered: true,
            },
            result: {
              sessionId: options.sessionId,
              status: 'completed',
              steps: stepIndex,
              lastDecision,
              lastTurn,
            },
          });
        }
        // STALL JUDGE (2026-07-24, the verb-regex exit ramp): for the
        // AMBIGUOUS prose-shape stalls only (announcement/short-generic — the
        // guesses; detected-bad shapes stay deterministic), ask one
        // cross-family judge question on FIRST detection: real reply or punt?
        // "deliver" promotes the text into an ordinary terminal candidate;
        // "stall"/judge-failure proceeds through the unchanged retry →
        // recovery-turn → human-floor chain.
        if (
          stallRetriesUsed === 0 &&
          stallIsJudgeAmbiguous(stallInfo, { userInput: String(options.input ?? '') }) &&
          typeof turnResult.finalOutput === 'string' &&
          turnResult.finalOutput.trim().length >= 40
        ) {
          const judged = await judgeAmbiguousStallReply({
            userInput: String(options.input ?? ''),
            replyText: turnResult.finalOutput.trim(),
          });
          if (judged === 'deliver') {
            const judgeReply = turnResult.finalOutput.trim();
            decision = {
              summary: judgeReply.slice(0, 200),
              reply: judgeReply,
              done: true,
              nextAction: 'completed',
              reason: null,
            };
            lastDecision = decision;
            stallJudgeDelivery = {
              signal: stallInfo.signal,
              detail: stallInfo.detail,
            };
            break unstructuredDecisionResolution;
          }
        }
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'system',
          type: 'stuck_detected',
          data: {
            signal: stallInfo.signal,
            ...stallInfo.detail,
          },
        });

        // RETRY HOOK: before terminating the conversation, try ONCE
        // more with a synthetic "act now" message. The detector is
        // generic, so the retry inherits coverage across all sub-agents
        // and tool types — no per-tool or per-agent enforcement needed.
        // Opportunistic enrichment: when the most recent handoff input
        // carried a structured `toolCall.slug + args`, we inline those
        // values so the model has a single obvious action to take. The
        // generic prose still works when no structured handoff exists
        // (file writes, shell commands, non-Composio paths).
        if (stallRetriesUsed < MAX_STALL_RETRIES) {
          stallRetriesUsed += 1;
          safeAppend({
            sessionId: options.sessionId,
            turn: turnResult.turn,
            role: 'system',
            type: 'stall_retry_attempted',
            data: {
              signal: stallInfo.signal,
              attempt: stallRetriesUsed,
              maxRetries: MAX_STALL_RETRIES,
              rawOutput: stallInfo.rawOutput,
            },
          });
          // v0.5.19 F4 — exponential backoff between retries. The
          // first retry fires almost immediately; the second waits a
          // beat so a transient external-API blip has time to settle.
          const backoffMs = STALL_RETRY_BACKOFF_MS[stallRetriesUsed - 1] ?? 1000;
          if (backoffMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
          }
          nextInput = buildStallRetryMessage(options.sessionId, stallInfo);
          continue;
        }
        // Retry budget exhausted. v0.5.19 F4 — instead of terminating
        // with `sub_agent_stalled` (which strands the user with no
        // recourse), emit a synthetic `awaiting_user_input` event
        // mirroring the shape the registered `ask_user_question` tool
        // emits at orchestrator.ts:184. The chat surface listens for
        // this event and renders the question, so the user can
        // course-correct (retry / change approach / stop). Honors the
        // north-star "reports back without fail" property.
        //
        // SALVAGE FIRST (2026-06-15): the task may NOT be stuck — the model
        // produced a coherent answer that just failed the STRICT decision parse
        // (D_decision_json carries the model's own `reply` in userVisibleMessage,
        // with detail.hasReply). Deliver that answer rather than the confusing
        // "unable to make progress" prompt (the synthetic Casey email-find lost a real
        // "I didn't find any email from Casey" answer this way). Only the real
        // reply is delivered — a generic ack / announcement / empty-reply
        // sentinel (hasReply:false) is excluded and still asks the user.
        if (
          stallInfo.signal === 'D_decision_json' &&
          (stallInfo.detail as { hasReply?: boolean }).hasReply === true &&
          stallInfo.userVisibleMessage.trim()
        ) {
          // Mirror the reply into the return value for the respond-bridge lane
          // (see the plain-text-contract salvage above — same class fix).
          lastDecision = { summary: stallInfo.userVisibleMessage, reply: stallInfo.userVisibleMessage, done: true, nextAction: 'completed', reason: null };
          return finalizeStandardConversation({
            sessionId: options.sessionId,
            sourceUserSeq: activeSourceUserSeq,
            turn: turnResult.turn,
            eventData: {
              steps: stepIndex,
              reason: 'decision_json_salvaged',
              summary: stallInfo.userVisibleMessage,
              reply: stallInfo.userVisibleMessage,
              delivered: true,
              stallDetail: { signal: stallInfo.signal, ...stallInfo.detail },
            },
            result: {
              sessionId: options.sessionId,
              status: 'completed',
              steps: stepIndex,
              lastDecision,
              lastTurn,
            },
          });
        }
        // SALVAGE, shape 2 (2026-07-08): A_zero_tools false-positive on a REAL
        // answer. If the exhausted retry produced substantively the SAME text
        // the detector flagged on the previous attempt, the model is not
        // stalling — it is confidently repeating its answer because the prose
        // IS the deliverable (a draft, a report, a found-nothing explanation).
        // Deliver it instead of the "unable to make progress" banner. Guards:
        // substantive length (a repeated one-line announcement stays a stall)
        // and a whitespace-normalized prefix match against the prior attempt's
        // recorded rawOutput (so an answer that CHANGED between attempts —
        // i.e. the retry actually moved something — still asks the user).
        // SALVAGE, shape 3 (live 2026-07-23 on v2.5.5): the reply hands the
        // turn back to the user for material only THEY can provide ("send the
        // copy when you have it", "paste it here"). Retrying cannot succeed —
        // the promised work is gated on user input — so deliver the reply.
        // Belt to the detector-side suppression in evaluateProgress.
        if (stallInfo.signal === 'A_zero_tools') {
          const awaitText = typeof turnResult.finalOutput === 'string' ? turnResult.finalOutput.trim() : '';
          if (awaitText.length >= 40 && textAwaitsUserMaterial(awaitText)) {
            lastDecision = { summary: awaitText.slice(0, 200), reply: awaitText, done: true, nextAction: 'completed', reason: null };
            return finalizeStandardConversation({
              sessionId: options.sessionId,
              sourceUserSeq: activeSourceUserSeq,
              turn: turnResult.turn,
              eventData: {
                steps: stepIndex,
                reason: 'awaits_user_material_salvaged',
                summary: awaitText.slice(0, 200),
                reply: awaitText,
                delivered: true,
                stallDetail: { signal: stallInfo.signal, ...stallInfo.detail },
              },
              result: {
                sessionId: options.sessionId,
                status: 'completed',
                steps: stepIndex,
                lastDecision,
                lastTurn,
              },
            });
          }
        }
        if (stallInfo.signal === 'A_zero_tools') {
          const finalText = typeof turnResult.finalOutput === 'string' ? turnResult.finalOutput.trim() : '';
          const priorRaw = latestStallRetryRawOutput(options.sessionId);
          const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
          const priorProbe = priorRaw ? normalize(priorRaw).slice(0, 160) : '';
          if (finalText.length >= 200 && priorProbe.length >= 80 && normalize(finalText).startsWith(priorProbe)) {
            // Mirror the reply into the return value for the respond-bridge lane
            // (see the plain-text-contract salvage above — same class fix).
            lastDecision = { summary: finalText, reply: finalText, done: true, nextAction: 'completed', reason: null };
            return finalizeStandardConversation({
              sessionId: options.sessionId,
              sourceUserSeq: activeSourceUserSeq,
              turn: turnResult.turn,
              eventData: {
                steps: stepIndex,
                reason: 'stall_consistent_reply_salvaged',
                summary: finalText,
                reply: finalText,
                delivered: true,
                stallDetail: { signal: stallInfo.signal, ...stallInfo.detail },
              },
              result: {
                sessionId: options.sessionId,
                status: 'completed',
                steps: stepIndex,
                lastDecision,
                lastTurn,
              },
            });
          }
        }
        // Recovery-summary turn (2026-07-23): same contract as the structured
        // site — the user never sees harness meta-language while one model
        // turn can still produce the real reply.
        if (!stallRecoverySummaryUsed) {
          stallRecoverySummaryUsed = true;
          safeAppend({
            sessionId: options.sessionId,
            turn: turnResult.turn,
            role: 'system',
            type: 'stall_retry_attempted',
            data: { signal: stallInfo?.signal ?? null, attempt: 'recovery_summary', maxRetries: MAX_STALL_RETRIES },
          });
          nextInput = buildStallRecoverySummaryMessage(String(options.input ?? ''));
          stallRecoveryTurnActive = true;
          continue;
        }
        const askUserEnabled =
          (getRuntimeEnv('HARNESS_STALL_ASK_USER', 'on') ?? 'on').toLowerCase() !== 'off';
        if (askUserEnabled) {
          safeAppend({
            sessionId: options.sessionId,
            turn: turnResult.turn,
            role: 'Clem',
            type: 'awaiting_user_input',
            data: {
              question: STALL_FLOOR_QUESTION,
              options: STALL_FLOOR_OPTIONS,
              source: 'stall_recovery',
              signal: stallInfo?.signal ?? null,
            },
          });
          commitStandardPauseTerminal({
            sessionId: options.sessionId,
            sourceUserSeq: activeSourceUserSeq,
            turn: turnResult.turn,
            steps: stepIndex,
            summary: STALL_FLOOR_QUESTION,
          });
          return {
            sessionId: options.sessionId,
            status: 'awaiting_user_input',
            steps: stepIndex,
            lastDecision,
            lastTurn,
          };
        }
        // Knob=off — fall through to legacy terminate-on-stall.
      }

      // EMPTY/UNSTRUCTURED-OUTPUT RETRY (2026-06-15): a null decision with zero
      // tools that is NOT a recognized stall is typically a TRANSIENT empty or
      // malformed model response (turn_ended items:1, lastResponseId:null — a
      // synthetic "find email from Casey" turn came back empty and gave up on turn 1).
      // Surfacing "couldn't be structured. Please ask again." as the answer is a
      // dead-end non-answer; re-prompt for a structured decision (and the next
      // concrete action) while we have budget. The toolCalls>0 case is already
      // retried above; this is the symmetric zero-tool case. Bounded by
      // MAX_STALL_RETRIES → after exhaustion the fallback below stands.
      if (
        !stallInfo &&
        turnResult.finalOutput === STRUCTURED_OUTPUT_RECOVERY_FALLBACK &&
        stallRetriesUsed < MAX_STALL_RETRIES
      ) {
        stallRetriesUsed += 1;
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'system',
          type: 'stall_retry_attempted',
          data: { signal: 'D_decision_unparsed', attempt: stallRetriesUsed, maxRetries: MAX_STALL_RETRIES, emptyOutput: true },
        });
        const backoffMs = STALL_RETRY_BACKOFF_MS[stallRetriesUsed - 1] ?? 1000;
        if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
        nextInput = 'Your previous response could not be parsed into the required structured decision — it came back empty or malformed. Re-issue your turn as PLAIN TEXT (no JSON): end with your answer, or a leading `ASK: <question>` / `CONTINUE: <why>` marker. If the task is NOT finished, take the next concrete action — call the tool you need now.';
        continue;
      }

      return finalizeStandardConversation({
        sessionId: options.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        turn: turnResult.turn,
        eventData: {
          steps: stepIndex,
          reason: stallInfo ? 'sub_agent_stalled' : 'no_structured_output',
          summary: stallInfo ? stallInfo.userVisibleMessage : fallbackSummary,
          stallDetail: stallInfo
            ? {
                signal: stallInfo.signal,
                ...stallInfo.detail,
                toolCalls: turnResult.toolCalls ?? 0,
              }
            : undefined,
        },
        result: {
          sessionId: options.sessionId,
          status: 'completed',
          steps: stepIndex,
          lastDecision,
          lastTurn,
          completedReason: stallInfo ? 'sub_agent_stalled' : 'no_structured_output',
        },
      });
    }

    // ASK-FIRST invariant from the batch-approval regression. A completed-tagged turn
    // whose CLOSING move is a direction/authorization question to the user is a
    // conversational beat — the question IS the deliverable. Downgrade it to
    // awaiting_user_input BEFORE the completion judge can see it: the judge's
    // "only asked a follow-up question" bounce scolded the agent past its own
    // permission question and into 10 unapproved external sends. Deterministic,
    // code-level, monotonic (only ever downgrades completed → awaiting), same
    // conservative shape as the done-invariant below.
    // Scoped to exactly the turns the completion judge would audit (same gate
    // as shouldRunObjectiveJudge minus the budget): a casual conversational
    // question ("what would you like to work on?") keeps its completed status.
    // GOAL sessions are exempt (adversarial review, 2026-07-09): an approved
    // goal run already carries the user's authorization, and its stage reports
    // habitually end "shall I continue?" — parking an UNATTENDED resume on
    // that rhetorical question would regress approve-once-then-run. The goal
    // contract's own validation owns completion there.
    const askFirstEligible = objectiveJudgeOptIn
      && (objectiveJudgeActionIntent || totalToolCalls >= OBJECTIVE_JUDGE_WORK_THRESHOLD)
      && !safeActiveGoal(options.sessionId);
    if (
      askFirstEligible
      && decision.done
      && decision.nextAction === 'completed'
      && isDirectionSeekingQuestion(decision.reply || decision.summary)
    ) {
      safeAppend({
        sessionId: options.sessionId,
        turn: turnResult.turn,
        role: 'system',
        type: 'guardrail_tripped',
        data: {
          kind: 'ask_first_invariant',
          message: 'Completed-tagged reply closes with a direction/authorization question — honoring awaiting_user_input; the question is the deliverable.',
        },
      });
      decision.nextAction = 'awaiting_user_input';
    }
    const queuedApprovalTransitions = queuedApprovalTransitionsForRequest(
      options.sessionId,
      activeSourceUserSeq,
    );
    const approvalText = decision.reply || decision.summary;
    const approvalQuestion = isQueuedActionApprovalQuestion(approvalText)
      || (
        decision.nextAction === 'awaiting_approval'
        && !isDirectionSeekingQuestion(approvalText)
      );
    const eligibleQueuedApprovalTransitions = queuedApprovalTransitions.filter(
      (transition) => queuedApprovalTransitionShouldMaterialize(
        transition,
        approvalQuestion,
      ),
    );
    if (eligibleQueuedApprovalTransitions.length > 0 && activeSourceUserSeq) {
      const materialized = materializeQueuedApprovals(
        options.sessionId,
        turnResult.turn,
        activeSourceUserSeq,
        eligibleQueuedApprovalTransitions,
      );
      for (const item of materialized) {
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'system',
          type: 'heartbeat',
          data: {
            kind: 'pending_action_transition_materialized',
            pendingActionId: item.transition.record.id,
            approvalId: item.approval.approvalId,
            sourceEventSeq: item.transition.eventSeq,
            approvalIntent: item.transition.approvalIntent,
            autoMaterialize: item.transition.autoMaterialize,
            message: 'Materialized the exact queued-action approval edge without another model turn.',
          },
        });
      }
      if (materialized.length > 0) {
        decision.done = false;
        decision.nextAction = 'awaiting_approval';
      }
    }
    // Done-invariant guardrail (Done? node). `done` and `nextAction` are
    // INDEPENDENT schema fields, so the model can emit the contradiction
    // `done:true` + `nextAction:awaiting_*` — declaring finished while also
    // asking to wait. Banking that as completed masks a genuine needs-user
    // turn (a false-done). Honor the MORE CONSERVATIVE awaiting signal: a
    // done:true only STANDS when nextAction agrees (completed/abandoned).
    // Falls through to the awaiting_user_input / awaiting_approval handlers
    // below. Monotonic (only ever downgrades a contradictory completion).
    const doneStands = decision.done
      && decision.nextAction !== 'awaiting_user_input'
      && decision.nextAction !== 'awaiting_approval'
      && decision.nextAction !== 'awaiting_handoff_result';
    if (decision.done && !doneStands) {
      safeAppend({
        sessionId: options.sessionId,
        turn: turnResult.turn,
        role: 'system',
        type: 'guardrail_tripped',
        data: {
          kind: 'done_invariant',
          message: `Model emitted done:true with nextAction:${decision.nextAction} — honoring the awaiting state, not banking completed.`,
          nextAction: decision.nextAction,
        },
      });
    }
    if (doneStands) {
      // Goal contract (Phase 3): a session with an ACTIVE parked goal
      // validates self-declared completion against the PARKED criteria — the
      // model saying "done" is a trigger to validate, never the verdict.
      // Gated on observed work (tool calls or a promise-shaped reply) so a
      // casual Q&A turn inside a goal session never spins the loop. Replaces
      // the generic transcript judge for these sessions (never both). Bounded
      // by the goal's persistent attempt budget; a dead judge resolves
      // not-satisfied + escalates (it can never auto-satisfy a goal).
      let goalUnmetNote = '';
      // True when THIS turn's goal CONTRACT validated 'satisfied'. The honest-
      // completion verifyDelivered gate below must NOT override a contract-verified
      // completion just because the final reply is promise-shaped — the goal
      // contract (validator + strict judge over the PARKED criteria) is the
      // authoritative artifact verification; the promise-shaped heuristic is weaker.
      // Without this, a satisfied goal whose reply reads "I'll publish it shortly"
      // was flipped to awaiting_user_input (broke 4 goal-contract-loop tests; the
      // gate is default-on).
      let goalSatisfiedThisTurn = false;
      // Verdict from the independent objective judge IF it ran this iteration.
      // verifyDelivered below reuses it instead of placing a SECOND identical
      // judge call: both trigger on the same promise-shaped completed reply, so
      // on the non-goal path the same (objective, reply) pair was judged twice
      // back-to-back — one redundant serial model call blocking the reply. The
      // objective judge's verdict is the richer one (composed objective +
      // skill/tool-call evidence), so it is authoritative when present.
      let objectiveJudgeVerdictThisTurn: ObjectiveJudgeVerdict | null = null;
      // EAGER output-grounding: start the figure-verification judge NOW so it
      // races the goal-contract / objective judge below instead of running
      // serially after them (one full judge latency saved on completed action
      // turns with figures). deferCommit — if the completion judge bounces,
      // this verdict is DISCARDED and must not leak a failure-count bump
      // (brackets.ts pre-write gates pioneered this exact shape). Fail-open:
      // errors resolve to allow at the consume site.
      const eagerDeliverable = decision.reply && decision.reply.trim() ? decision.reply : decision.summary;
      const eagerOutputGroundingPromise = (
        isOutputGroundingGateEnabled()
        && decision.nextAction === 'completed'
        && objectiveJudgeContinuations < MAX_OBJECTIVE_JUDGE_CONTINUATIONS
        && eagerDeliverable && eagerDeliverable.trim()
      )
        ? startGate(evaluateOutputGrounding(options.sessionId, eagerDeliverable, { kind: 'chat', deferCommit: true }))
        : null;
      const activeGoal = safeActiveGoal(options.sessionId);
      const goalGate = Boolean(activeGoal)
        && (totalToolCalls >= 1 || isPromiseShapedReply(decision.reply || decision.summary));
      const acceptedExecutionEvidenceThisRequest = requestHasAcceptedExecutionCompletion(
        options.sessionId,
        activeSourceUserSeq,
      );
      // This floor belongs to the opted-in interactive completion contract.
      // Non-judged workflow/reporting lanes preserve their existing terminal
      // semantics; their execution controllers own request-bound validation.
      const freshExternalWriteRequired = objectiveJudgeOptIn
        && objectiveRequiresFreshExternalWrite(objective);
      const currentExternalWriteStatus = freshExternalWriteRequired
        ? requestFreshExternalWriteStatus(options.sessionId, activeSourceUserSeq)
        : 'confirmed';
      const freshExternalWriteVerified = !freshExternalWriteRequired
        || freshExternalWriteEvidenceIsVerified(
          currentExternalWriteStatus,
          acceptedExecutionEvidenceThisRequest,
        );
      if (activeGoal && goalGate && freshExternalWriteVerified) {
        const goalPlan = activeGoal.approvedPlan ?? activeGoal.plan;
        const evidenceText = (decision.reply?.trim() ? decision.reply : decision.summary) ?? '';
        const manifestEvidence = renderWorkManifestEvidenceForGoal(options.sessionId);
        const validationEvidenceText = manifestEvidence
          ? `${evidenceText}\n\n${manifestEvidence}`
          : evidenceText;
        // Staged goals validate ONE milestone at a time against that stage's
        // criteria; unstaged goals validate the full criteria exactly as
        // before. The current stage is the first pending one (null ⇒ unstaged
        // or every stage already done → fall through to full validation).
        const currentStage = getCurrentGoalStage(activeGoal);
        const fullCriteria = goalPlan.successCriteria ?? [];
        const validateCriteria = currentStage ? currentStage.criteria : fullCriteria;
        // Record this turn's work in the goal's progress ledger BEFORE
        // validation runs (validation may flip the goal to satisfied, after
        // which touchGoalActivity no-ops). This is the signal the A2
        // no-progress breaker and the D2 stage checkpoint read.
        safeAppendGoalLedger(activeGoal.id, 'turn', evidenceText);
        const goalValidator = options.goalValidator ?? validateGoal;
        const validation = await goalValidator({
          objective: goalPlan.objective,
          successCriteria: validateCriteria,
          evidenceText: validationEvidenceText,
        });
        // Verdict door (T3-B4): one canonical audit row per judge decision.
        recordVerdictEvent(options.sessionId, turnResult.turn, {
          door: 'goal_validation',
          pass: validation.pass,
          reason: validation.advice ?? (validation.pass ? 'all criteria met' : undefined),
          failedOpen: validation.judgeFailedOpen,
          criteriaMet: validation.criteriaMet,
          criteriaTotal: validation.criteriaTotal,
          ...(currentStage ? { detail: { stageId: currentStage.id } } : {}),
        });
        const updated = recordGoalValidation(
          activeGoal.id,
          toGoalEvidence(validation, (activeGoal.attempt ?? 0) + 1, new Date().toISOString())
            .map((e) => (currentStage ? { ...e, stageId: currentStage.id } : e)),
        );
        const attempt = updated?.attempt ?? (activeGoal.attempt ?? 0) + 1;
        const maxAttempts = activeGoal.maxAttempts ?? GOAL_DEFAULT_MAX_ATTEMPTS;
        const failures = validation.perCriterion.filter((c) => !c.pass);
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'system',
          type: 'goal_validation',
          data: {
            goalId: activeGoal.id,
            stageId: currentStage?.id,
            pass: validation.pass,
            attempt,
            maxAttempts,
            judgeFailedOpen: validation.judgeFailedOpen ?? false,
            manifestEvidenceAttached: Boolean(manifestEvidence),
            failures: failures.slice(0, 4).map((f) => ({ criterion: f.criterion.slice(0, 200), detail: f.detail?.slice(0, 200) })),
          },
        });
        if (validation.pass && currentStage) {
          // A milestone cleared. Mark it done (resets the attempt budget),
          // surface ONE check-in, and keep working — either on the next stage
          // or a final full-criteria pass. advanceGoalStage returns non-null
          // only on the pending→done transition, so the check-in fires once.
          const advanced = advanceGoalStage(activeGoal.id, currentStage.id);
          const stages = advanced?.stages ?? activeGoal.stages ?? [];
          const doneCount = stages.filter((s) => s.status === 'done').length;
          const total = stages.length;
          const nextStage = stages.find((s) => s.status === 'pending');
          if (advanced) {
            safeStageCheckin(options.sessionId, activeGoal.id, {
              title: currentStage.title,
              doneCount,
              total,
              evidence: evidenceText,
              nextTitle: nextStage?.title,
            });
            // D2 checkpoint: reset the context at the stage boundary so the next
            // milestone doesn't drag the whole prior-stage transcript. The goal's
            // objective + criteria + ledger re-inject fresh, so nothing is lost.
            try {
              const cpSession = HarnessSession.load(options.sessionId);
              if (cpSession) await checkpointGoalStage(cpSession);
            } catch { /* checkpoint is best-effort */ }
          }
          if (nextStage) {
            nextInput = [
              `Stage ${doneCount}/${total} ("${currentStage.title}") validated. Now do stage ${doneCount + 1}/${total}: ${nextStage.title}.`,
              'Success criteria for this stage:',
              ...nextStage.criteria.map((c, i) => `${i + 1}. ${c}`),
              'Do the real work and produce verifiable evidence, then mark this stage done. Do NOT redo earlier stages.',
            ].join('\n');
          } else {
            nextInput = [
              `All ${total} stages are validated. Do a final pass: verify EVERY overall success criterion still holds, produce any missing evidence, then mark the goal done.`,
              ...fullCriteria.map((c, i) => `${i + 1}. ${c}`),
            ].join('\n');
          }
          continue;
        } else if (validation.pass) {
          satisfyGoal(activeGoal.id, 'external validation passed');
          goalSatisfiedThisTurn = true;
          const learningManifests = summarizeWorkManifests(options.sessionId);
          const learningArtifactState = standardArtifactTerminalState(
            options.sessionId,
            activeSourceUserSeq,
          );
          const learningInput = {
            target: 'skill' as const,
            authority: 'goal_validation' as const,
            sessionId: options.sessionId,
            sourceId: activeGoal.id,
            terminalSuccess: true,
            independentValidation: validation.judgeFailedOpen !== true,
            failedOpen: validation.judgeFailedOpen === true,
            artifactVerificationPending: learningArtifactState?.pending.length ?? 0,
            ambiguousExternalWrites: currentExternalWriteStatus === 'ambiguous' ? 1 : 0,
            manifestRemaining: learningManifests.reduce((sum, manifest) => sum + manifest.remaining, 0),
            manifestAnomalies: learningManifests.reduce((sum, manifest) => sum + manifest.anomalies.length, 0),
            manifestUntrackedCheckpoints: learningManifests.reduce(
              (sum, manifest) => sum + manifest.untrackedCheckpoints,
              0,
            ),
            externalWriteRequired: freshExternalWriteRequired,
            externalWriteReceipts: freshExternalWriteEvidenceIsVerified(
              currentExternalWriteStatus,
              acceptedExecutionEvidenceThisRequest,
            )
              ? 1
              : 0,
          };
          const learningDecision = evaluateLearningCandidate(learningInput);
          recordLearningDecision(learningInput, learningDecision, {
            goalId: activeGoal.id,
            criteriaMet: validation.criteriaMet,
            criteriaTotal: validation.criteriaTotal,
          });
          // Capability compounding (C2): a satisfied goal that did real
          // discovery distills into a reusable draft skill only after the same
          // durable evidence boundary that satisfied the goal issues a receipt.
          // Fire-and-forget: learning never blocks completion.
          if (learningDecision.receipt) {
            void maybeDistillSkill(
              options.sessionId,
              goalPlan.objective,
              evidenceText,
              activeGoal.id,
              learningDecision.receipt,
            );
          }
        } else if (!validation.judgeFailedOpen && attempt < maxAttempts) {
          nextInput = [
            `You marked this done, but external validation of the session's pinned goal found unmet criteria (attempt ${attempt}/${maxAttempts}):`,
            ...failures.slice(0, 4).map((f) => `- ${f.criterion}${f.detail ? ` (${f.detail})` : ''}`),
            'Close these specific gaps and produce verifiable evidence (a URL, file path, or emitted result). If a criterion is genuinely impossible, say so explicitly with the concrete blocker instead of declaring done without it.',
          ].join('\n');
          continue;
        } else {
          goalUnmetNote = validation.judgeFailedOpen
            ? 'Note: the pinned goal could not be validated (completion judge unavailable). The goal stays pinned — say "continue" to retry, or /goal cancel to drop it.'
            : `Note: the pinned goal still has unmet criteria after ${attempt}/${maxAttempts} validation attempts: ${failures.slice(0, 3).map((f) => f.criterion).join('; ')}. The goal stays pinned — say "continue" to keep working, or /goal cancel to drop it.`;
        }
      } else if (
      // Independent completion gate (Hermes-style): the model just declared
      // itself done. For a multi-step action objective, verify with an
      // INDEPENDENT judge before yielding — LLMs over-declare completion
      // ("here's what I'd do", a promise instead of the artifact), which is
      // what turns the agent back into a chatbot you have to re-prompt. If the
      // judge sees no real evidence, inject a continuation and keep working.
      // Bounded + fail-open (judge defaults to done) so it can never wedge.
        shouldRunObjectiveJudge({
          optIn: objectiveJudgeOptIn,
          actionIntent: objectiveJudgeActionIntent || freshExternalWriteRequired,
          // A local mutation or bookkeeping tool cannot certify a requested
          // external write. Force the judge path until this exact request owns
          // a durable external receipt (or an accepted execution completion).
          meaningfulToolEvidence: meaningfulToolEvidence && freshExternalWriteVerified,
          multiResultObjective: objectiveMayRequireMultipleResults(objective),
          acceptedExecutionEvidence: acceptedExecutionEvidenceThisRequest,
          continuationsUsed: objectiveJudgeContinuations,
          maxContinuations: MAX_OBJECTIVE_JUDGE_CONTINUATIONS,
          nextAction: decision.nextAction,
          // Catch the "I'll do that next" turn that looks low-effort but promised
          // work and never produced it — the chatbot shape. The judge then forces
          // a real artifact or an honest blocker.
          promiseShaped: isPromiseShapedReply(decision.reply || decision.summary),
          // THE-GRANT Phase 1: never judge completion while the human's approval
          // card is open — the run is waiting on THEM, and a bounce here is what
          // escalated a parked ask into unapproved sends (Exhibit A).
          openApprovalCard: hasOpenApprovalCard(options.sessionId),
        })
        // "I'll report back when it finishes" after a real workflow_run
        // dispatch is NOT promise-shaped over-declaration — the report-back is
        // wired. See dispatchedBackgroundWorkflowRun.
        && !dispatchedBackgroundWorkflowRun(options.sessionId, turnResult.turn)
      ) {
        const responseText = decision.reply && decision.reply.trim() ? decision.reply : decision.summary;
        // Skill-execution rubric: if any skill was loaded this session, give the
        // judge the skill's own steps + tool-call evidence so it verifies the
        // skill was EXECUTED (deliverables produced), not just read. Fail-open:
        // gather helpers return [] on error, so the judge runs exactly as before.
        const loadedSkills = gatherSessionSkills(options.sessionId);
        // Always hand the judge the tool-call evidence — NOT only when a skill
        // loaded. A plain build/deploy/CLI run that loads no skill still did
        // real, verifiable work; judging ONLY decision.reply starved the judge
        // of that evidence, so it hallucinated a missing deliverable and
        // false-rejected genuinely-finished action turns ("Done — site live at
        // <url>"), stranding real completions into a false stuck loop (25 such
        // sessions in one week of eventlog). Fail-open: summarizeToolCallsForJudge
        // returns '' on error and the prompt builder only renders a real summary.
        const skillContext = {
          skills: loadedSkills,
          toolCallSummary: summarizeToolCallsForJudge(options.sessionId),
        };
        // A bare follow-up ("just mine please") judged in isolation is
        // inherently ambiguous → false NOT-finished retries (5 in the live
        // 2026-06-11 session). Compose the judged objective with the recent
        // REAL user messages (harness drips filtered) so the judge audits
        // what the user actually asked for. Fail-open to the raw input.
        let judgedObjective = objective;
        try {
          const priorInputs = listEvents(options.sessionId, { types: ['user_input_received'] })
            .map((ev) => String((ev.data as { text?: string } | undefined)?.text ?? ''))
            .filter((t) => t.trim().length > 0);
          // The current conversation's own input is the most recent entry — drop it.
          if (priorInputs.length > 0 && priorInputs[priorInputs.length - 1] === objective) priorInputs.pop();
          judgedObjective = composeJudgedObjective(objective, priorInputs);
        } catch { /* fail-open: judge the raw input */ }
        const rawVerdict = await objectiveJudge(judgedObjective, responseText ?? '', skillContext);
        const freshnessGap = rawVerdict.done
          && !rawVerdict.awaitingUser
          && !freshExternalWriteVerified;
        // Deterministic request-bound floor: a language-model judge cannot
        // promote historical receipts into evidence for a newly accepted
        // external action. Override its PASS before recording the verdict.
        const boundedAttemptTerminal = !rawVerdict.done
          && !freshExternalWriteRequired
          && boundedAttemptResultIsTerminal(
            judgedObjective,
            responseText ?? '',
            meaningfulToolEvidence,
          );
        const verdict: ObjectiveJudgeVerdict = freshnessGap
          ? {
              ...rawVerdict,
              done: false,
              reason: freshExternalWriteGapReason(
                currentExternalWriteStatus as Exclude<FreshExternalWriteEvidenceStatus, 'confirmed'>,
              ),
              failedOpen: false,
              selfJudge: false,
            }
          : boundedAttemptTerminal
            ? {
                ...rawVerdict,
                done: true,
                reason: 'The user-bounded attempt ran and the response honestly reported its verified empty/negative result; verification cannot authorize another attempt.',
                failedOpen: false,
                selfJudge: false,
              }
            : rawVerdict;
        objectiveJudgeVerdictThisTurn = verdict;
        // Verdict door (T3-B4): one canonical audit row per judge decision.
        recordVerdictEvent(options.sessionId, turnResult.turn, {
          door: 'completion',
          pass: verdict.done,
          reason: verdict.reason,
          failedOpen: verdict.failedOpen,
          selfJudge: verdict.selfJudge,
        });
        if (verdict.done && (verdict.failedOpen || verdict.selfJudge)) {
          completionVerification = { failedOpen: verdict.failedOpen, selfJudge: verdict.selfJudge };
        }
        // DETERMINISTIC skill-execution FLOOR. The LLM judge above can't be
        // trusted for the binary "did the skill's bundled script run" — on the
        // 2026-06-15 lunar-audit it HAD the evidence (no generate-html.js in the
        // tool-call summary) and still passed a hand-rolled HTML. So enforce it in
        // code: a loaded skill that prescribes bundled scripts but ran NONE of them
        // was not executed → NOT done, regardless of the judge. Kill-switch
        // HARNESS_SKILL_EXEC_GATE=off; fail-open (null → no gate). Conservative
        // zero-ran threshold never false-bounces a partial-but-real run.
        const skillGap = (getRuntimeEnv('HARNESS_SKILL_EXEC_GATE', 'on') ?? 'on').toLowerCase() !== 'off'
          ? skillExecutionShortfall(options.sessionId)
          : null;
        // AWAITING verdict: the judge ruled the reply's question/pause IS the
        // deliverable (backstop for shapes the deterministic ask-first invariant
        // can't classify, e.g. an honest partial-progress report). Yield to the
        // user — never continue past a question awaiting their call. Runs AFTER
        // the deterministic skill floor (a skill shortfall still bounces), and
        // synthesizes the awaiting_user_input event so ?-less pause replies are
        // DELIVERED verbatim on every surface instead of respond-bridge falling
        // back to a stale session-wide question (adversarial review 2026-07-09).
        if (verdict.awaitingUser && !skillGap) {
          const awaitingSummary = publicReplyText(decision.reply, '')
            || 'I need a little more information before I can continue safely. What would you like me to do next?';
          const artifactState = standardArtifactTerminalState(options.sessionId, activeSourceUserSeq);
          const askedThisTurn = (() => {
            try {
              return listEvents(options.sessionId, { types: ['awaiting_user_input'] })
                .some((e) => e.turn === turnResult.turn);
            } catch { return false; }
          })();
          if (!askedThisTurn) {
            safeAppend({
              sessionId: options.sessionId,
              turn: turnResult.turn,
              role: 'Clem',
              type: 'awaiting_user_input',
              data: { question: awaitingSummary, source: 'judge_awaiting_verdict' },
            });
          }
          const publicPresentation = commitStandardNeedsInputTerminal({
            sessionId: options.sessionId,
            sourceUserSeq: activeSourceUserSeq,
            turn: turnResult.turn,
            text: awaitingSummary,
            legacyReason: 'awaiting_user_input',
            metadata: {
              steps: stepIndex,
              ...(completionVerification ? { verification: completionVerification } : {}),
              ...(artifactState ? artifactVerificationProjection(artifactState) : {}),
            },
          });
          return {
            sessionId: options.sessionId,
            status: 'awaiting_user_input',
            steps: stepIndex,
            lastDecision: decision,
            lastTurn,
            publicPresentation,
          };
        }
        // A selfJudge NOT-DONE is the brain's own family grading its homework —
        // flagged lower-confidence BY CONTRACT (no cross-family judge available).
        // It gets ONE bounce (with the ask-permitting continuation text below),
        // never two: the second disagreement becomes advisory. Full-advisory
        // would disable the completion net for every single-provider install;
        // two hard self-bounces is what drove the ask-first regression into unapproved
        // sends. The delivery gate below still applies its deterministic
        // honesty checks either way.
        const selfJudgeAdvisory = !verdict.done && verdict.selfJudge === true && !skillGap
          && objectiveJudgeContinuations >= 1;
        if (selfJudgeAdvisory) {
          safeAppend({
            sessionId: options.sessionId,
            turn: turnResult.turn,
            role: 'system',
            type: 'heartbeat',
            data: {
              kind: 'self_judge_advisory',
              steps: stepIndex,
              message: 'Same-family completion judge disagreed — recorded as advisory, not bounced (no cross-family judge available).',
              reason: verdict.reason,
            },
          });
        }
        if ((!verdict.done && !selfJudgeAdvisory) || skillGap) {
          // A deterministic skill-execution shortfall overrides the LLM verdict
          // with a script-specific reason; otherwise use the judge's reason.
          const judgeReason = skillGap
            ? `the "${skillGap.skill}" skill was loaded but NONE of its prescribed scripts ran (${skillGap.prescribed.join(', ')}) — the deliverable was hand-rolled instead of built by the skill's own pipeline`
            : verdict.reason;
          // This is a corrective continuation, not a terminal skill failure.
          // Counting each "not done yet" bounce against a draft could quarantine
          // a sound procedure after two loop iterations even when the run later
          // succeeded. Keep the trajectory in the trace; procedural trust only
          // changes at an accepted terminal evidence boundary.
          objectiveJudgeContinuations += 1;
          safeAppend({
            sessionId: options.sessionId,
            turn: turnResult.turn,
            role: 'system',
            type: 'heartbeat',
            data: {
              kind: 'progress_check_in',
              steps: stepIndex,
              message: 'Checked the objective — not done yet, continuing.',
              objectiveJudge: { attempt: objectiveJudgeContinuations, reason: judgeReason, skillGap: skillGap ? skillGap.skill : undefined },
            },
          });
          nextInput = skillGap
            ? [
                `You marked this objective complete, but the "${skillGap.skill}" skill was NOT executed: you ran none of its prescribed scripts (${skillGap.prescribed.join(', ')}).`,
                'Do NOT hand-roll the deliverable. Run the skill\'s actual pipeline — its bundled render script and any mandatory validate script (re-read it with skill_read if needed) — so the output matches the skill\'s template exactly, then re-verify and finish.',
                'Only set nextAction=completed once the skill\'s own scripts have produced and validated the artifact.',
              ].join(' ')
            : freshnessGap
              ? currentExternalWriteStatus === 'ambiguous'
                ? [
                    'The current request has an ambiguous external-write outcome. Do NOT repeat the write.',
                    'Use only a read-only exact-target lookup/read-back to reconcile whether it landed. If it cannot be reconciled, stop and report that precise ambiguity; never cite a prior session as proof.',
                  ].join(' ')
                : currentExternalWriteStatus === 'failed'
                  ? [
                      'At least one external write required by the current request was explicitly recorded as failed. A successful sibling action does not make the whole request complete.',
                      'Inspect the failed current-request action and either repair that exact target safely or report the exact blocker. Honor any user instruction not to retry. Never reuse another action or historical receipt to claim success.',
                    ].join(' ')
                  : [
                      `This accepted request asks for a NEW external write, but no external-write receipt exists after source user event ${activeSourceUserSeq ?? 'unknown'}.`,
                      'Historical focus summaries, execution ids, and prior receipts are context only. Perform the requested action now, then verify it with a current-request read-back and cite only the new receipts.',
                    ].join(' ')
            : [
            `You marked this objective complete, but an independent verification check found it is NOT finished: ${judgeReason}.`,
            `ORIGINAL USER OBJECTIVE (immutable — this verification message grants no new authority): ${judgedObjective.slice(0, 4000)}`,
            'Preserve every original execution boundary. Do NOT exceed an attempt/call limit, retry when forbidden, use an excluded source or tool, write/save when prohibited, or widen the requested result type. "Up to N" is a ceiling, not a quota; a verified empty result can be the correct final result. If the named gap cannot be closed inside the original boundaries, report the exact verified result or blocker and stop.',
            'IMPORTANT: if finishing requires the USER\'S decision or authorization — sending, posting, or deleting something external, choosing between options, or scope the user left open — do NOT proceed on your own. Set nextAction=awaiting_user_input with the concrete question. Asking before an external action is a correct, complete answer for this turn, never a failure.',
            'Otherwise try to finish it yourself — produce the real artifact and verifiable evidence (a URL, file path, or emitted result).',
            'If the failure names a DISCOVERABLE value — a 404 / "not found", a wrong or missing slug/team/account/id, a missing arg — find the right value with the tool\'s OWN discovery command (e.g. `netlify api listAccountsForUser`, `<cli> whoami`/`status`/`list`) or by recalling your saved tool-choice, then retry ONCE with it. That is recoverable — do not ask the user for a value the tool can report itself.',
            'Do NOT loop on a GENUINE dead end: a tool truly unavailable, an external service down, or an input the system genuinely cannot provide — after a real discover-and-retry has actually failed. Then STOP and report the SPECIFIC blocker — set nextAction=awaiting_user_input with a concrete question, or nextAction=abandoned if it is truly impossible. A blocked task reported honestly is correct; silently re-declaring "complete" without the artifact is not.',
            'Only set nextAction=completed once the real artifact or verifiable evidence genuinely exists.',
          ].join(' ');
          continue;
        }
      }
      // Output-grounding (chat deliverable). The objective judge above verifies
      // work HAPPENED; this verifies the FIGURES in the user-facing reply trace
      // to the session's captured tool results — the missing content-trust
      // boundary for a chat-DELIVERED report (the write-path sibling lives in
      // brackets.ts 2c2.7). Shares the bounded objectiveJudgeContinuations
      // budget so it can't loop; mutually exclusive with the judge bounce above
      // (that path `continue`d). Contradiction → recompute + re-state; no-source
      // figure → ship with an advisory note. Fail-open: never wedge a completion.
      // The verdict was started EAGERLY (deferCommit) before the goal-contract /
      // objective judge, so it has been running CONCURRENTLY with them — the
      // await here is usually instant instead of a full serial judge call. The
      // failure bump is committed only when the bounce is actually surfaced
      // (a bounce verdict discarded by an earlier judge `continue` never leaks
      // a count — same integrity contract as the brackets pre-write gates).
      let outputGroundingNote = '';
      if (eagerOutputGroundingPromise) {
        try {
          {
            const og = await eagerOutputGroundingPromise;
            if (og.action === 'bounce') {
              og.commitFailure?.();
              try {
                safeAppend({
                  sessionId: options.sessionId, turn: turnResult.turn, role: 'system', type: 'guardrail_tripped',
                  data: { kind: 'output_grounding_blocked', source: 'chat', figures: og.figures.slice(0, 5), sources: og.sourceCallIds.slice(0, 5), reason: og.reason, failureCount: og.failureCount ?? 1 },
                });
              } catch { /* telemetry must never block */ }
              objectiveJudgeContinuations += 1;
              nextInput = buildOutputGroundingChatRetry(og);
              continue;
            } else if (og.action === 'advisory') {
              // FLOOR disclosure (allowed template class): fires only for figures
              // traceable to NEITHER this session's tool results NOR consolidated
              // memory — genuinely unverifiable, so honest uncertainty is owed.
              const figs = og.figures.slice(0, 4).join(', ');
              outputGroundingNote = `Heads up: I couldn't trace ${figs} back to anything I've pulled or remember, so treat ${og.figures.length > 1 ? 'those numbers' : 'that number'} as unverified.`;
              try {
                safeAppend({
                  sessionId: options.sessionId, turn: turnResult.turn, role: 'system', type: 'output_grounding_judged',
                  data: { source: 'chat', grounded: false, advisory: true, figures: og.figures.slice(0, 5), reason: og.reason },
                });
              } catch { /* telemetry must never block */ }
            }
          }
        } catch { /* fail-open: never wedge a completion */ }
      }
      // SELF-RESOLVE BEFORE ASKING (2026-07-31, owner directive: ambiguity is
      // CLEM'S problem to settle, never the user's — the "reply retry/stop"
      // park and the ambiguous-write confession both handed the user work the
      // model can do itself in one continuation). Two shapes, one nudge:
      //  (a) truly-unresolved create claims (the would-be artifact park);
      //  (b) an AMBIGUOUS external-write outcome on this request.
      // The nudge teaches the exact settlement verbs (weakest-model rule);
      // the park and the honesty floor remain as fallbacks when even the
      // verification read fails.
      if (
        !selfResolveNudged
        && decision.nextAction === 'completed'
        && objectiveJudgeContinuations < MAX_OBJECTIVE_JUDGE_CONTINUATIONS
      ) {
        const selfResolve = (() => {
          try {
            // Chat AND background/execution runs. This was chat-only at birth,
            // which inverted the intent for background tasks: the lane with
            // NOBODY watching skipped self-settlement, parked on an ambiguous
            // draft-write, and handed the user "keep working" homework from a
            // NEEDS-YOU card (live 2026-08-04). Workflow runs keep their own
            // judge machinery.
            const sessionKind = HarnessSession.load(options.sessionId)?.sessionRow.kind;
            if (sessionKind !== 'chat' && sessionKind !== 'execution') return null;
            const parts: string[] = [];
            let unresolved: ReturnType<typeof trulyUnresolvedArtifactClaims> = [];
            try {
              const state = standardArtifactTerminalState(options.sessionId, activeSourceUserSeq);
              unresolved = state ? trulyUnresolvedArtifactClaims(state) : [];
            } catch { unresolved = []; }
            if (unresolved.length > 0) {
              const listed = unresolved.slice(0, 3)
                .map((a) => `${a.provider} ${a.kind}${a.resourceId ? ` id ${a.resourceId}` : ''} (artifactId ${a.id})`)
                .join('; ');
              parts.push(
                `${unresolved.length === 1 ? 'A create attempt is' : `${unresolved.length} create attempts are`} UNRESOLVED: ${listed}. `
                + 'Verify YOURSELF now — read the provider back (a list/get/search for the exact title or id), then settle with artifact_claim_resolve: bind the found resource id, or mark it absent and create ONCE more.',
              );
            }
            let writeStatus: FreshExternalWriteEvidenceStatus = 'missing';
            try { writeStatus = requestFreshExternalWriteStatus(options.sessionId, activeSourceUserSeq); } catch { writeStatus = 'missing'; }
            if (writeStatus === 'ambiguous') {
              parts.push(
                'An external write from THIS request has an AMBIGUOUS outcome. Read the exact target back now, then settle it with execution_reconcile_write — verdict "present" if it landed (report it done), "absent" if not (one corrected retry is then authorized).',
              );
            }
            if (parts.length === 0) return null;
            return {
              directive: `[self-resolve] Do NOT hand this uncertainty to the user. ${parts.join(' ')} `
                + 'Only if the verification read itself fails should you stop — and then explain in your own words exactly what you checked and what remains unknown.',
              artifactRequirements: unresolved.map((artifact) => ({
                id: artifact.id,
                slotKey: artifact.slotKey,
                kind: artifact.kind,
                provider: artifact.provider,
              })),
              ambiguousExternalWrite: writeStatus === 'ambiguous',
            };
          } catch { return null; }
        })();
        if (selfResolve) {
          selfResolveNudged = true;
          objectiveJudgeContinuations += 1;
          let publicCandidate = publicReplyText(decision.reply, '')
            || publicReplyText(decision.summary, '');
          if (!publicCandidate) {
            try { publicCandidate = synthesizeTurnReport(options.sessionId, activeSourceUserSeq) ?? ''; } catch { publicCandidate = ''; }
          }
          const candidateNotes = [goalUnmetNote, outputGroundingNote]
            .filter((note) => note && note.trim());
          if (publicCandidate && candidateNotes.length > 0) {
            publicCandidate = `${publicCandidate}\n\n${candidateNotes.join('\n\n')}`;
          }
          effectArtifactSelfReconciliation = {
            publicText: publicCandidate || null,
            originalDecision: { ...decision },
            originTurn: turnResult.turn,
            objective,
            artifactRequirements: selfResolve.artifactRequirements,
            ambiguousExternalWrite: selfResolve.ambiguousExternalWrite,
            externalWriteRequiredByObjective: objectiveRequiresFreshExternalWrite(objective),
            completionVerdict: objectiveJudgeVerdictThisTurn,
            skipDeliveryGate: goalSatisfiedThisTurn,
          };
          try {
            safeAppend({
              sessionId: options.sessionId, turn: turnResult.turn, role: 'system', type: 'guardrail_tripped',
              data: { kind: 'self_resolve_nudge', reason: 'unresolved claim/ambiguous write settled by the model, not the user' },
            });
          } catch { /* telemetry must never block */ }
          nextInput = selfResolve.directive;
          continue;
        }
      }
      // CLAIM GROUNDING (2026-07-30, live 404 handoff): a completed reply that
      // hands the user a deliverable pointer (URL, file path) nothing in this
      // run ever OBSERVED gets ONE advisory bounce — verify it however fits,
      // or say plainly what's real. Structural only: no provider rules, no
      // verification recipes (owner directive — rigidity here is the old
      // rabbit hole). Evidence candidates come from the session's lossless
      // tool-output index, searched per-pointer so long sessions stay cheap;
      // only exact successful READ/COMPUTE occurrences may ground the claim.
      if (
        !claimGroundingNudged
        && decision.nextAction === 'completed'
        && objectiveJudgeContinuations < MAX_OBJECTIVE_JUDGE_CONTINUATIONS
      ) {
        const groundNudge = (() => {
          try {
            if (HarnessSession.load(options.sessionId)?.sessionRow.kind !== 'chat') return null;
            const replyText = (decision.reply && decision.reply.trim()) ? decision.reply : (decision.summary ?? '');
            const pointers = extractDeliverablePointers(replyText);
            if (pointers.length === 0) return null;
            // A session with NO captured observations has nothing to ground
            // against — "did you do any work at all" is the objective judge's
            // question, not this one's. Mirrors the figures judge's
            // no-captures allow.
            const recentCandidates = recentToolOutputs(options.sessionId, { limit: 10 });
            if (recentCandidates.length === 0) return null;
            const candidates: Array<{ callId: string }> = [];
            for (const pointer of pointers) {
              for (const row of searchToolOutputs(options.sessionId, [pointer.searchTerm], { limit: 4 })) {
                candidates.push(row);
              }
            }
            candidates.push(...recentCandidates);
            const evidence = resolveToolOutputsForAuthority(
              options.sessionId,
              candidates,
              { readOrComputeOnly: true },
            ).map((row) => row.output);
            return claimGroundingNudge(ungroundedPointers(pointers, evidence));
          } catch { return null; }
        })();
        if (groundNudge) {
          claimGroundingNudged = true;
          objectiveJudgeContinuations += 1;
          try {
            safeAppend({
              sessionId: options.sessionId, turn: turnResult.turn, role: 'system', type: 'guardrail_tripped',
              data: { kind: 'claim_grounding_nudge', reason: 'reply hands over pointers this run never observed' },
            });
          } catch { /* telemetry must never block */ }
          nextInput = groundNudge;
          continue;
        }
      }
      // Render priority on the chat surface: prefer `reply` (the
      // natural-language message intended for the user) over `summary`
      // (an internal log entry).
      // Empty completed replies are retried once above. If the retry budget is
      // exhausted, keep the diagnostic in telemetry and show a plain recovery
      // prompt instead of leaking the internal summary into the chat bubble.
      const hasReply = decision.reply && decision.reply.trim();
      const isCompletedAction = decision.nextAction === 'completed';
      // ALWAYS REPORT BACK: a completed turn with NO reply but real work done gets an
      // honest synthesized report of what happened (from this request's external_write
      // events) instead of the bare "(Finished without a written reply.)" fallback.
      const missingReplyWorkReport = (!hasReply && isCompletedAction)
        ? (() => { try { return synthesizeTurnReport(options.sessionId, activeSourceUserSeq); } catch { return null; } })()
        : null;
      const baseSummary = hasReply
        ? decision.reply!
        : missingReplyWorkReport
          ? missingReplyWorkReport
          : isCompletedAction
            ? MISSING_REPLY_USER_FALLBACK
            : decision.summary;
      // Goal contract: criteria still unmet after the attempt budget — the
      // user must SEE that, never a silent clean-looking completion. The
      // output-grounding advisory (an unverifiable figure) rides the same rail.
      const completionNotes = [goalUnmetNote, outputGroundingNote].filter((n) => n && n.trim());
      let userVisibleSummary = completionNotes.length ? `${baseSummary}\n\n${completionNotes.join('\n\n')}` : baseSummary;
      const terminalExternalWriteRequired = objectiveJudgeOptIn
        && objectiveRequiresFreshExternalWrite(objective);
      const terminalExternalWriteStatus = terminalExternalWriteRequired
        ? requestFreshExternalWriteStatus(options.sessionId, activeSourceUserSeq)
        : 'confirmed';
      const terminalExecutionAccepted = requestHasAcceptedExecutionCompletion(
        options.sessionId,
        activeSourceUserSeq,
      );
      const terminalFreshWriteGap = isCompletedAction
        && terminalExternalWriteRequired
        && !freshExternalWriteEvidenceIsVerified(
          terminalExternalWriteStatus,
          terminalExecutionAccepted,
        );
      const terminalFreshWriteReason = terminalFreshWriteGap
        ? freshExternalWriteGapReason(
            terminalExternalWriteStatus as Exclude<FreshExternalWriteEvidenceStatus, 'confirmed'>,
          )
        : '';
      if (terminalFreshWriteGap) {
        userVisibleSummary = terminalExternalWriteStatus === 'ambiguous'
          ? 'I cannot honestly confirm this change went through — the outcome is still ambiguous, and I did not run it twice or count an older receipt as proof. Say "check it" and I\'ll verify the live state before calling this complete.'
          : terminalExternalWriteStatus === 'failed'
            ? 'At least one external write required by this request was recorded as failed, so I cannot call the task complete or substitute another action’s receipt. That exact failure needs to be resolved before any full-success claim.'
            : 'I cannot honestly confirm the work went out for this request — I have no receipt of it landing after your message, and I did not count an older one as proof. If it still needs to go out, tell me and I\'ll do it properly.';
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'system',
          type: 'guardrail_tripped',
          data: {
            kind: 'request_bound_external_write_missing',
            status: terminalExternalWriteStatus,
            sourceUserSeq: activeSourceUserSeq ?? null,
            reason: terminalFreshWriteReason,
          },
        });
      }

      // Honest-completion backstop (Done? node). The objective judge above
      // handles opted-in ACTION objectives with bounded continuations. This
      // final pass is monotonic report-back honesty for every lane: explicit
      // blocked/error language and promise-shaped completions become an honest
      // awaiting_user_input instead of a false-green completion. It reuses the
      // shared verifyDelivered chokepoint used by gateway/daemon report-back.
      // A goal contract validated 'satisfied' this turn is the AUTHORITATIVE artifact
      // verification — skip the gate so its weaker promise-shaped heuristic can't
      // override a contract-verified completion into awaiting_user_input.
      const cachedObjectiveVerdict = objectiveJudgeVerdictThisTurn;
      const deliveryGateRan = verifyDeliveredEnabled() && !goalSatisfiedThisTurn && !dispatchedBackgroundWorkflowRun(options.sessionId, turnResult.turn);
      const delivery: DeliveryVerdict = terminalFreshWriteGap
        ? {
            delivered: false,
            status: 'blocked',
            reason: terminalFreshWriteReason,
            blockerType: 'unverified_completion',
          }
        : deliveryGateRan
          ? await verifyDelivered(objective, userVisibleSummary, {
            // Reuse the objective judge's verdict when it ran this iteration —
            // its audit covered this same reply with MORE context, so a second
            // identical model call adds latency, not information. The
            // deterministic blocked-text/stoppedReason checks inside
            // verifyDelivered still run first either way.
            judgeFn: cachedObjectiveVerdict ? async () => cachedObjectiveVerdict : objectiveJudge,
          })
          : { delivered: true as const, status: 'completed' as const };
      // Verdict door (T3-B4) — recorded only when the gate actually evaluated
      // (a skipped gate is not a verdict).
      if (deliveryGateRan) {
        recordVerdictEvent(options.sessionId, turnResult.turn, {
          door: 'delivery',
          pass: delivery.delivered,
          reason: delivery.reason,
          failedOpen: delivery.verification?.failedOpen,
          selfJudge: delivery.verification?.selfJudge,
          ...(delivery.blockerType ? { detail: { blockerType: delivery.blockerType } } : {}),
        });
      }
      if (delivery.verification) completionVerification = delivery.verification;
      if (!delivery.delivered) {
        const artifactState = standardArtifactTerminalState(options.sessionId, activeSourceUserSeq);
        const blockedText = terminalFreshWriteGap
          ? userVisibleSummary
          : hasReply
            ? publicReplyText(decision.reply, 'I could not finish this turn safely. Please tell me how you would like to proceed.')
            : missingReplyWorkReport
              ? missingReplyWorkReport
              : 'I could not finish this turn safely. Please tell me how you would like to proceed.';
        const publicPresentation = commitStandardBlockedTerminal({
          sessionId: options.sessionId,
          sourceUserSeq: activeSourceUserSeq,
          turn: turnResult.turn,
          text: blockedText,
          legacyReason: 'blocked',
          metadata: {
            steps: stepIndex,
            missingReply: isCompletedAction && !hasReply ? true : undefined,
            blockedReason: (delivery.reason ?? userVisibleSummary).slice(0, 400),
            ...(completionVerification ? { verification: completionVerification } : {}),
            ...(artifactState ? artifactVerificationProjection(artifactState) : {}),
          },
        });
        const goalForBlocked = safeActiveGoal(options.sessionId);
        if (goalForBlocked) {
          safeAppendGoalLedger(goalForBlocked.id, 'blocked', delivery.reason ?? userVisibleSummary);
        }
        return {
          sessionId: options.sessionId,
          status: 'awaiting_user_input',
          steps: stepIndex,
          lastDecision: decision,
          lastTurn,
          publicPresentation,
        };
      }

      return finalizeStandardConversation({
        sessionId: options.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        turn: turnResult.turn,
        eventData: {
          steps: stepIndex,
          summary: userVisibleSummary,
          internalSummary: decision.summary,
          // Goal/output-verification notes are part of the authorized public
          // answer. Do not hand the committer the pre-verification model reply
          // as a competing publication field or it will correctly prefer that
          // stale text and hide the verifier's honest qualification.
          reply: userVisibleSummary,
          internalReply: decision.reply ?? null,
          missingReply: isCompletedAction && !hasReply ? true : undefined,
          delivered: true,
          ...(stallJudgeDelivery
            ? {
                reason: 'stall_judge_delivered',
                stallDetail: { signal: stallJudgeDelivery.signal, ...stallJudgeDelivery.detail },
              }
            : {}),
          ...(completionVerification ? { verification: completionVerification } : {}),
        },
        result: {
          sessionId: options.sessionId,
          status: 'completed',
          steps: stepIndex,
          lastDecision: decision,
          lastTurn,
        },
      });
    }

    if (decision.nextAction === 'awaiting_user_input') {
      // Loop reconciliation: if this turn's ask already auto-resolved under YOLO
      // standing approval (autonomy_note, no halting event), a stray
      // nextAction:'awaiting_user_input' is a contradiction — don't strand the
      // run; continue. Conservative: only fires with positive autonomy_note
      // evidence this turn, so a genuine clarification still halts below.
      if (yoloAutoResolvedAskThisTurn(options.sessionId, turnResult.turn)) {
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'system',
          type: 'heartbeat',
          data: {
            kind: 'yolo_proceed_reconciled',
            message: 'Ignored a stray nextAction:awaiting_user_input — the approval question already auto-resolved under YOLO standing approval. Continuing.',
          },
        });
        nextInput = 'You already auto-resolved that approval question under YOLO standing approval — do NOT wait for the user. Proceed with your best default and keep going until the work is done, then report what you did.';
        continue;
      }
      // Self-serve-first (v2.2.2): a pointer-shaped ask against a connected
      // toolkit bounces ONCE with a derive-first steer (same gate as the
      // ask_user_question tool; shared one-shot state). Fail-open: any error
      // or a repeat ask delivers the question as before.
      try {
        const askText = decision.reply || decision.summary || '';
        const { maybeSelfServeBounce } = await import('../../agents/self-serve-gate.js');
        const { listUsableConnectedToolkits } = await import('../../integrations/composio/client.js');
        const bounceDecision = maybeSelfServeBounce({
          sessionId: options.sessionId,
          question: askText,
          connectedToolkitSlugs: (await listUsableConnectedToolkits()).map((c) => c.slug),
        });
        if (bounceDecision.bounce && bounceDecision.steer) {
          safeAppend({
            sessionId: options.sessionId,
            turn: turnResult.turn,
            role: 'system',
            type: 'heartbeat',
            data: { kind: 'self_serve_bounce', toolkit: bounceDecision.toolkit, message: 'Pointer-shaped ask bounced once with a derive-first steer.' },
          });
          nextInput = bounceDecision.steer;
          continue;
        }
      } catch { /* fail-open: deliver the ask */ }
      // DELIVER the question (review/live fix 2026-06-14). The model can ask a
      // clarifying question two ways: (a) call the ask_user_question TOOL — which
      // emits an awaiting_user_input EVENT every surface renders; or (b) just set
      // done:true + nextAction:awaiting_user_input in its DECISION with the
      // question in `reply` (no tool call). Path (b) emitted NO awaiting_user_input
      // event, so event-stream surfaces (Discord, desktop SSE) delivered nothing
      // and the user was STRANDED staring at a "thinking" state with no question
      // (observed live: a Discord "finalize the website" turn sat 20min). If no
      // awaiting_user_input event exists for this turn, synthesize one carrying
      // the decision's reply so every surface delivers the question.
      const askedThisTurn = (() => {
        try {
          return listEvents(options.sessionId, { types: ['awaiting_user_input'] })
            .some((e) => e.turn === turnResult.turn);
        } catch { return false; }
      })();
      if (!askedThisTurn) {
        const question = (decision.reply?.trim() ? decision.reply : decision.summary)
          ?? 'Could you clarify how you\'d like me to proceed?';
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'Clem',
          type: 'awaiting_user_input',
          data: { question, source: 'decision_awaiting' },
        });
      }
      // A goal session yielding for input is a check-in/blocker — record it so
      // the ledger reads as a real timeline and the breaker sees the state.
      const goalForAsk = safeActiveGoal(options.sessionId);
      if (goalForAsk) {
        safeAppendGoalLedger(
          goalForAsk.id,
          'blocked',
          (decision.reply?.trim() ? decision.reply : decision.summary) ?? 'awaiting user input',
        );
      }
      const awaitingSummary = (decision.reply?.trim() ? decision.reply : decision.summary)
        ?? 'Could you clarify how you\'d like me to proceed?';
      commitStandardPauseTerminal({
        sessionId: options.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        turn: turnResult.turn,
        steps: stepIndex,
        summary: awaitingSummary,
        reply: decision.reply ?? awaitingSummary,
      });
      return {
        sessionId: options.sessionId,
        status: 'awaiting_user_input',
        steps: stepIndex,
        lastDecision: decision,
        lastTurn,
      };
    }
    if (decision.nextAction === 'awaiting_approval') {
      // The SDK-level interrupt path normally handles this via turnResult.status
      // (it emits approval_requested, which every surface renders). If we end up
      // here, the Orchestrator self-reported awaiting_approval WITHOUT an SDK
      // interrupt — so no approval_requested event fired this turn and event-stream
      // surfaces (Discord, desktop SSE) would render NOTHING, stranding the user
      // (the symmetric awaiting_user_input hole fixed just above). Synthesize a
      // delivery event carrying the decision's reply so every surface shows the ask.
      const approvalEmittedThisTurn = (() => {
        try {
          return listEvents(options.sessionId, { types: ['approval_requested'] })
            .some((e) => e.turn === turnResult.turn);
        } catch { return false; }
      })();
      if (!approvalEmittedThisTurn) {
        const ask = (decision.reply?.trim() ? decision.reply : decision.summary)
          ?? 'I need your approval before the next step — approve to continue or tell me to stop.';
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'Clem',
          type: 'awaiting_user_input',
          data: { question: ask, source: 'decision_awaiting_approval' },
        });
        const goalForApproval = safeActiveGoal(options.sessionId);
        if (goalForApproval) {
          safeAppendGoalLedger(goalForApproval.id, 'blocked', ask);
        }
      }
      return {
        sessionId: options.sessionId,
        status: 'awaiting_approval',
        steps: stepIndex,
        lastDecision: decision,
        lastTurn,
      };
    }
    if (decision.nextAction === 'abandoned') {
      return finalizeStandardConversation({
        sessionId: options.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        turn: turnResult.turn,
        eventData: {
          steps: stepIndex,
          summary: decision.reply && decision.reply.trim() ? decision.reply : decision.summary,
          internalSummary: decision.summary,
          reply: decision.reply ?? null,
          reason: 'abandoned_by_orchestrator',
        },
        result: {
          sessionId: options.sessionId,
          status: 'completed',
          steps: stepIndex,
          lastDecision: decision,
          lastTurn,
        },
      });
    }

    // NEVER DEAD-END (gate-unification Step 2): a `done:true` turn whose
    // nextAction is `awaiting_handoff_result` is waiting on the retired
    // Orchestrator->Executor hand-off. The done-invariant downgrades it
    // (doneStands=false) but it matches NO terminal handler above, so it used to
    // fall through to the silent CONTINUATION_INPUT re-loop and hang until a
    // budget cap killed it — and the stall detectors MISS it (they only fire on
    // ZERO meaningful tools; the dangerous case has prior tool work). Give this
    // enum value the one reading it should have: surface the result and ask the
    // user, exactly like awaiting_user_input — so the run always has a forward
    // path instead of a silent hang. (done:false keeps looping as before.)
    if (
      decision.done &&
      decision.nextAction === 'awaiting_handoff_result'
    ) {
      const askedThisTurn = (() => {
        try {
          return listEvents(options.sessionId, { types: ['awaiting_user_input'] })
            .some((e) => e.turn === turnResult.turn);
        } catch { return false; }
      })();
      if (!askedThisTurn) {
        const question = (decision.reply?.trim() ? decision.reply : decision.summary)
          ?? 'I reached a point where I need your input to continue — how would you like me to proceed?';
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'Clem',
          type: 'awaiting_user_input',
          data: { question, source: 'decision_awaiting_handoff_terminal' },
        });
      }
      const goalForHandoff = safeActiveGoal(options.sessionId);
      if (goalForHandoff) {
        safeAppendGoalLedger(
          goalForHandoff.id,
          'blocked',
          (decision.reply?.trim() ? decision.reply : decision.summary) ?? 'awaiting a hand-off that no longer exists',
        );
      }
      const awaitingSummary = (decision.reply?.trim() ? decision.reply : decision.summary)
        ?? 'I reached a point where I need your input to continue — how would you like me to proceed?';
      commitStandardPauseTerminal({
        sessionId: options.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        turn: turnResult.turn,
        steps: stepIndex,
        summary: awaitingSummary,
        reply: decision.reply ?? awaitingSummary,
      });
      return {
        sessionId: options.sessionId,
        status: 'awaiting_user_input',
        steps: stepIndex,
        lastDecision: decision,
        lastTurn,
      };
    }

    // Wall-clock check before we kick off another turn.
    const tokenStatus = tokenWindow ? checkRunTokenWindow(tokenWindow) : null;
    if (Date.now() - lastCheckInAt >= checkInMs) {
      lastCheckInAt = Date.now();
      const budgetNote = tokenStatus ? budgetLine(tokenStatus) : null;
      safeAppend({
        sessionId: options.sessionId,
        turn: lastTurn,
        role: 'system',
        type: 'heartbeat',
        data: {
          kind: 'progress_check_in',
          steps: stepIndex,
          preset: budget.preset,
          unlimited: budget.unlimited,
          summary: lastDecision?.summary ?? null,
          ...(tokenStatus && tokenStatus.ceiling > 0
            ? { tokensUsedWindow: tokenStatus.usedWindow, tokenCeiling: tokenStatus.ceiling, budgetFraction: tokenStatus.fraction }
            : {}),
          message: `Still working (${stepIndex} step${stepIndex === 1 ? '' : 's'} completed${budgetNote ? `; ${budgetNote}` : ''}).`,
        },
      });
    }
    // Single-shot 50%/80% budget warnings — the "no silent ceiling" guarantee:
    // a budget park is always preceded by a durable warning event.
    if (tokenStatus?.crossedThreshold) {
      safeAppend({
        sessionId: options.sessionId,
        turn: lastTurn,
        role: 'system',
        type: 'heartbeat',
        data: {
          kind: 'budget_threshold',
          threshold: tokenStatus.crossedThreshold,
          tokensUsedWindow: tokenStatus.usedWindow,
          tokensUsedLifetime: tokenStatus.usedLifetime,
          tokenCeiling: tokenStatus.ceiling,
        },
      });
    }

    if (maxWallMs > 0 && Date.now() - startedAt > maxWallMs) {
      emitLimitExceededWithContinuePrompt({
        sessionId: options.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        turn: turnResult.turn,
        steps: stepIndex,
        reason: 'wall_clock',
        limitDetail: { maxWallClockMs: maxWallMs },
        lastDecision: decision ?? lastDecision,
      });
      return {
        sessionId: options.sessionId,
        status: 'limit_exceeded',
        limitKind: 'wall_clock',
        steps: stepIndex,
        lastDecision: decision,
        lastTurn,
      };
    }

    // Stage 4 — aggregate run token budget: checked AFTER wall-clock (a dual
    // breach reports wall_clock exactly as today; zero behavior change when
    // the budget is off or unlimited). Same honest-park template.
    if (tokenStatus?.exceeded) {
      emitLimitExceededWithContinuePrompt({
        sessionId: options.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        turn: turnResult.turn,
        steps: stepIndex,
        reason: 'token_budget',
        limitDetail: {
          tokensUsedWindow: tokenStatus.usedWindow,
          tokensUsedLifetime: tokenStatus.usedLifetime,
          tokenCeiling: tokenStatus.ceiling,
          baseline: tokenWindow?.baseline ?? 0,
        },
        lastDecision: decision ?? lastDecision,
      });
      return {
        sessionId: options.sessionId,
        status: 'limit_exceeded',
        limitKind: 'token_budget',
        steps: stepIndex,
        lastDecision: decision,
        lastTurn,
      };
    }

    // Surgical long-run: a forward-progressing run about to hit the STEP cap
    // auto-elevates ONCE (standard → long) instead of pausing for a manual
    // `continue`, so a genuinely long task finishes within its time budget.
    // Reaching here means the turn completed and the conversation is NOT done /
    // abandoned / stalled (those returned earlier) — i.e. real forward progress.
    // Long and unlimited presets already own their authored ceilings, so only
    // the standard preset can take this one-way standard → long promotion.
    if (shouldElevateOnStepProgress({
      alreadyElevated: elevated,
      preset: budget.preset,
      explicitMaxSteps: options.maxSteps !== undefined,
      stepIndex,
      maxSteps,
    })) {
      applyElevation({ reason: 'step_progress', steps: stepIndex });
    }

    // 'awaiting_handoff_result' or any other non-terminal state → loop.
    // WATCHER: (a) inject a resolved drift steer from the check that ran in the
    // background during the last turn; (b) start the next check without
    // awaiting it (it races the coming turn — zero critical-path latency).
    let watcherSteerNote = '';
    if (watcherSteerBox.pending) {
      const steer = watcherSteerBox.pending;
      watcherSteerBox.pending = null;
      watcherInjectionsUsed += 1;
      safeAppend({
        sessionId: options.sessionId,
        turn: lastTurn,
        role: 'system',
        type: 'heartbeat',
        data: { kind: 'watcher_steer', miss: steer.miss, steer: steer.steer, injection: watcherInjectionsUsed },
      });
      watcherSteerNote = ` TRAJECTORY CHECK (an independent watcher compared your work so far against the goal): ${steer.miss}. ${steer.steer} Address this before finishing — or, if it is already handled or the watcher misread the goal, proceed and make the evidence explicit in your final reply.`;
    }
    if (
      shouldStartWatcherCheck({
        enabled: watcherEnabled,
        totalToolCalls,
        lastCheckedAtToolCalls: watcherLastCheckedAt,
        checkIntervalTools: WATCHER_INTERVAL_TOOLS,
        injectionsUsed: watcherInjectionsUsed,
        maxInjections: MAX_WATCHER_INJECTIONS,
        checksUsed: watcherChecksUsed,
        maxChecks: MAX_WATCHER_CHECKS,
        checkInFlight: watcherCheckInFlight,
      })
    ) {
      watcherCheckInFlight = true;
      watcherChecksUsed += 1;
      watcherLastCheckedAt = totalToolCalls;
      const latestAssistantNote = (lastDecision?.reply?.trim() ? lastDecision.reply : lastDecision?.summary) ?? '';
      const watcherToolCallCount = totalToolCalls;
      void (async () => {
        try {
          // Gather the digest inside the background task — the goal contract
          // read and tool-call summary cost nothing on the critical path here.
          let successCriteria: string[] | undefined;
          try {
            const goal = safeActiveGoal(options.sessionId);
            const criteria = (goal?.approvedPlan ?? goal?.plan)?.successCriteria;
            if (criteria?.length) successCriteria = criteria;
          } catch { /* goal-less runs watch the objective alone */ }
          const verdict = await watcherJudge({
            objective,
            ...(successCriteria ? { successCriteria } : {}),
            toolCallSummary: summarizeToolCallsForJudge(options.sessionId),
            latestAssistantNote,
            toolCallCount: watcherToolCallCount,
          });
          if (verdict && !verdict.onTrack) watcherSteerBox.pending = verdict;
        } catch { /* the watcher is silent on any failure */ }
        finally { watcherCheckInFlight = false; }
      })();
    }
    nextInput = CONTINUATION_INPUT + watcherSteerNote;
  }

  // Max steps without resolution.
  emitLimitExceededWithContinuePrompt({
    sessionId: options.sessionId,
    sourceUserSeq: activeSourceUserSeq,
    turn: lastTurn,
    steps: stepIndex,
    reason: 'max_steps',
    limitDetail: { maxSteps },
    lastDecision,
  });
  return {
    sessionId: options.sessionId,
    status: 'limit_exceeded',
    limitKind: 'max_steps',
    steps: stepIndex,
    lastDecision,
    lastTurn,
  };
}

/**
 * Emit BOTH the audit-trail `conversation_limit_exceeded` event AND a
 * user-facing `conversation_completed` event that carries a synthesized
 * reply asking the user whether to keep going.
 *
 * Before this helper, the loop emitted only the audit event, which
 * the chat surface had no good way to render — the user saw silence
 * or "Continuing." (the sub-agent stall pattern). The synthetic
 * conversation_completed flows through the existing chat-dock +
 * Discord rendering path, so the user sees: "I've been working on
 * this for N steps and there's more to do. Reply `continue` to keep
 * going, or break it into a smaller piece."
 *
 * When the user replies `continue`, the entry-point handlers
 * (discord-harness, console-routes /api/harness/chat) detect that
 * keyword and start a fresh runConversation on the SAME session with
 * the prior decision's summary prepended so the orchestrator picks
 * up where it left off.
 */
function emitLimitExceededWithContinuePrompt(opts: {
  sessionId: string;
  sourceUserSeq?: number;
  turn: number;
  steps: number;
  reason: 'wall_clock' | 'max_steps' | 'token_budget';
  limitDetail: Record<string, unknown>;
  lastDecision: OrchestratorDecisionShape | undefined;
}): void {
  safeAppend({
    sessionId: opts.sessionId,
    turn: opts.turn,
    role: 'system',
    type: 'conversation_limit_exceeded',
    data: { steps: opts.steps, reason: opts.reason, ...opts.limitDetail },
  });

  const continueReply = opts.reason === 'wall_clock'
    ? `I hit the time budget on this conversation after ${opts.steps} step${opts.steps === 1 ? '' : 's'} and there's more to do. Reply \`continue\` to keep going, or break it into a smaller piece.`
    : opts.reason === 'token_budget'
      ? `This run has used its token budget (${formatTokens(Number(opts.limitDetail.tokensUsedWindow ?? 0))} of ${formatTokens(Number(opts.limitDetail.tokenCeiling ?? 0))}) after ${opts.steps} step${opts.steps === 1 ? '' : 's'}, with more to do. Reply \`continue\` to authorize another budget window, or break it into a smaller piece.`
      : `I've been working on this for ${opts.steps} step${opts.steps === 1 ? '' : 's'} and hit the step budget — there's more to do. Reply \`continue\` to keep going, or break it into a smaller piece.`;
  const artifactState = standardArtifactTerminalState(opts.sessionId, opts.sourceUserSeq);
  commitStandardNeedsInputTerminal({
    sessionId: opts.sessionId,
    sourceUserSeq: opts.sourceUserSeq,
    turn: opts.turn,
    text: continueReply,
    need: 'continue',
    legacyReason: 'awaiting_continue',
    metadata: {
      steps: opts.steps,
      lastDecisionSummary: opts.lastDecision?.summary ?? null,
      limitKind: opts.reason,
      ...(artifactState ? artifactVerificationProjection(artifactState) : {}),
    },
  });
}

async function withActiveTurnHeartbeat<T>(
  opts: {
    sessionId: string;
    turn: number;
    budget: ReturnType<typeof getHarnessBudgetSettings>;
    checkInMs: number;
    stage: 'turn' | 'approval_resume';
  },
  work: () => Promise<T>,
): Promise<T> {
  const timer = setInterval(() => {
    safeAppend({
      sessionId: opts.sessionId,
      turn: opts.turn,
      role: 'system',
      type: 'heartbeat',
      data: {
        kind: 'active_turn_check_in',
        stage: opts.stage,
        preset: opts.budget.preset,
        unlimited: opts.budget.unlimited,
        message: `Still working inside turn ${opts.turn}.`,
      },
    });
  }, opts.checkInMs);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

// ---------- public API ----------

// ─── Goal contract (GOAL-CONTRACT-PLAN.md Phase 3) ──────────────────────────
// A session with an ACTIVE parked goal gets the goal re-injected fresh every
// turn (the model rents the goal; the store owns it), and self-declared
// completion triggers EXTERNAL validation against the parked criteria.
// Kill-switch: CLEMMY_GOAL_CONTRACT=off disables both injection + validation.

function goalContractEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_GOAL_CONTRACT', 'on') ?? 'on').toLowerCase() !== 'off';
}

/** Stream-inactivity threshold for the turn-stall watchdog. Default 5 min —
 *  observed first-byte on big prompts is ~35s, so 8x margin; every stream
 *  event (token, tool call) resets the timer, so long multi-tool turns are
 *  never cut while ANYTHING is happening. 0 disables. */
function modelStreamStallMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_MODEL_STREAM_STALL_MS', '300000') ?? '300000', 10);
  if (!Number.isFinite(raw)) return 300_000;
  return raw <= 0 ? 0 : raw;
}

/** Pre-content (first-byte) stall window. A model call that produces ZERO
 *  stream events for this long has not started — distinct from a long, ACTIVE
 *  tool turn (which keeps resetting the timer and is governed by the longer
 *  modelStreamStallMs ceiling). Shorter so a wedged/silent stream (the Claude
 *  tool-turn hang regression) fails fast and RETRIES instead of pinning the
 *  user for the full 5 min. 0 falls back to the stream-stall ceiling. */
function modelFirstByteStallMs(): number {
  const ceiling = modelStreamStallMs();
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_MODEL_FIRST_BYTE_STALL_MS', '75000') ?? '75000', 10);
  if (!Number.isFinite(raw) || raw <= 0) return ceiling;
  // Never exceed the stream-stall ceiling (so a tiny configured ceiling — e.g.
  // in tests — keeps the pre-content window tiny too).
  return ceiling > 0 ? Math.min(raw, ceiling) : raw;
}

/** How many times to retry a model call that stalled BEFORE producing any
 *  content (pre-content stall only — safe because zero events means zero tool
 *  side effects, so the run can be replayed cleanly). Default 3: Anthropic
 *  intermittently sends HTTP 200 then no body for >75s on a heavy first call
 *  (the retry hits the now-warm prompt cache and starts in ~12s), and a single
 *  retry isn't enough when the hang recurs within a turn. Replays are clean and
 *  cheap (cache reads), and Codex rarely reaches this backstop (its own
 *  dispatcher fails fast first), so a higher budget is safe for every brain.
 *  0 disables. */
function modelStreamStallRetries(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_MODEL_STREAM_STALL_RETRIES', '3') ?? '3', 10);
  if (!Number.isFinite(raw) || raw < 0) return 3;
  return raw;
}

/** Typed marker for a stalled model stream so the runner can distinguish a
 *  retryable pre-content stall from a real failure. */
class ModelStreamStalledError extends Error {
  constructor(public readonly seconds: number, public readonly preContent: boolean) {
    // User-facing message: name the REAL cause (the model provider/brain didn't
    // respond), not internal stream-watchdog env-var jargon. A pre-content hang
    // (no first byte) is almost always the provider being overloaded or a
    // transient network issue on their end — not the user's request.
    super(
      preContent
        ? `Your model provider didn't start responding within ${seconds}s, so the request timed out before any output. `
          + `This is almost always the provider being overloaded or a transient network hiccup on their end — not your request. Re-send to retry.`
        : `Your model provider stopped responding mid-answer (no output for ${seconds}s) and the call timed out. `
          + `This is usually a provider or network hiccup. Re-send to retry.`,
    );
    this.name = 'ModelStreamStalledError';
  }
}

/** Store read must never break a turn. */
function safeActiveGoal(sessionId: string): PlanProposal | null {
  if (!goalContractEnabled()) return null;
  try {
    return getActiveGoalForSession(sessionId);
  } catch {
    return null;
  }
}

/**
 * Append one compact "done so far" line to a goal's progress ledger and bump
 * its activity stamp. The ledger was previously dead (touchGoalActivity had no
 * production callers), so the no-progress breaker and stage checkpointing had
 * no real signal to read. Best-effort: a write failure never breaks the turn.
 * `kind` distinguishes a completed turn from a check-in/blocker so the ledger
 * reads as a real timeline.
 */
/** Fire-and-forget skill distillation on a satisfied goal. Dynamic import keeps
 *  the distiller (and its model client) off the hot completion path; all gating
 *  + error handling lives inside distillSkillFromSession. */
function maybeDistillSkill(
  sessionId: string,
  objective: string,
  evidence: string,
  goalId: string,
  learningReceipt: LearningReceipt,
): void {
  void (async () => {
    try {
      const { distillSkillFromSession, reinforceDraftSkills } = await import('../../memory/skill-distiller.js');
      // A satisfied goal is a validated success — reinforce any draft skills the
      // session leaned on (promotes a proven draft toward approved).
      try {
        const usedDrafts = gatherSessionSkills(sessionId).map((s) => s.name);
        if (usedDrafts.length > 0) {
          await reinforceDraftSkills(
            usedDrafts,
            'success',
            undefined,
            sessionId,
            learningReceipt,
          );
        }
      } catch { /* reinforcement is best-effort */ }
      await distillSkillFromSession(sessionId, {
        objective,
        evidence,
        origin: { kind: 'chat', sourceId: goalId },
        learningReceipt,
      });
    } catch { /* distillation never affects the run */ }
  })();
}

function safeAppendGoalLedger(goalId: string, kind: 'turn' | 'blocked', text: string): void {
  const body = (text ?? '').trim();
  if (!body) return;
  const prefix = kind === 'blocked' ? 'blocked: ' : '';
  try {
    touchGoalActivity(goalId, clip(`${prefix}${body}`, 140));
  } catch { /* ledger is best-effort */ }
}

/**
 * Surface ONE natural check-in when a goal stage clears: an inbox card the user
 * can glance at without re-reading the conversation. Called only on the
 * pending→done transition (advanceGoalStage's single-fire return), so it never
 * spams. Best-effort — a notification failure never affects the run. The
 * model's own reply on the next surfaced turn is the conversational half.
 */
function safeStageCheckin(
  sessionId: string,
  goalId: string,
  info: { title: string; doneCount: number; total: number; evidence: string; nextTitle?: string },
): void {
  try {
    const tail = info.nextTitle ? ` Continuing: ${info.nextTitle}.` : ' Final review next.';
    addNotification({
      id: `goal-stage-${goalId}-${info.doneCount}`,
      kind: 'system',
      title: `Goal progress: stage ${info.doneCount}/${info.total} done`,
      body: `${clip(info.title, 80)} ✓ — ${clip(info.evidence, 160)}.${tail}`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { sessionId, goalId, stageDone: info.doneCount, stageTotal: info.total },
    });
  } catch { /* check-in is best-effort */ }
}

function renderGoalContextBlock(goal: PlanProposal): string {
  const plan = goal.approvedPlan ?? goal.plan;
  const ledger = (goal.progressLedger ?? []).slice(-8);
  // Staged goals show ONLY the current milestone's criteria (the model works
  // one stage at a time) plus a "stage X/N" header; unstaged goals show the
  // full criteria exactly as before.
  const stages = goal.stages ?? [];
  const currentStage = getCurrentGoalStage(goal);
  const doneCount = stages.filter((s) => s.status === 'done').length;
  const shownCriteria = (
    currentStage ? currentStage.criteria : (plan.successCriteria ?? [])
  ).map((c) => c.trim()).filter(Boolean);
  const stageHeader = currentStage
    ? `Current stage ${doneCount + 1}/${stages.length}: ${currentStage.title}`
    : '';
  const criteriaLabel = currentStage ? 'Success criteria for THIS stage' : 'Success criteria';
  return [
    '[ACTIVE GOAL — parked outside this conversation. Completion is validated EXTERNALLY against the criteria below; declaring done triggers that validation, it does not decide it.]',
    `Objective: ${plan.objective}`,
    stageHeader,
    shownCriteria.length > 0 ? `${criteriaLabel}:\n${shownCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : '',
    ledger.length > 0 ? `Progress so far:\n${ledger.map((l) => `- ${l}`).join('\n')}` : '',
    `Validation attempts used: ${goal.attempt ?? 0}/${goal.maxAttempts ?? GOAL_DEFAULT_MAX_ATTEMPTS}.`,
    'If a criterion is genuinely impossible, say so explicitly with the concrete reason instead of declaring done without it.',
  ].filter(Boolean).join('\n');
}

/**
 * Build the complexity-classification input for a self-continuation turn from
 * the parked goal: the objective plus the criteria she is CURRENTLY working
 * (current stage on a staged goal, else the full success criteria). This is
 * what the deterministic classifier — and skill/workflow ranking — should judge
 * on a continuation turn (the real task), instead of the canned CONTINUATION
 * nudge, which always classifies 'simple' → reasoning effort 'none'. The criteria
 * carry the multi-domain / batch signal the regex classifier keys on, so a
 * multi-system build lands 'complex'/'moderate' and a trivial objective still
 * lands 'simple'. Null-safe: returns undefined when there is no usable objective,
 * so the caller falls back to the literal input (today's behavior).
 */
export function goalObjectiveString(goal: PlanProposal): string | undefined {
  const plan = goal.approvedPlan ?? goal.plan;
  const objective = (plan?.objective ?? '').trim();
  if (!objective) return undefined;
  const currentStage = getCurrentGoalStage(goal);
  const criteria = (currentStage ? currentStage.criteria : (plan?.successCriteria ?? []))
    .map((c) => c.trim())
    .filter(Boolean);
  return criteria.length > 0 ? `${objective}\n${criteria.join('\n')}` : objective;
}

export async function runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
  const row = getSession(options.sessionId);
  if (!row) throw new Error(`unknown session: ${options.sessionId}`);
  const session = HarnessSession.load(options.sessionId);
  if (!session) throw new Error(`unable to load session: ${options.sessionId}`);
  // Anchor for the post-turn recall-run sweep (cross-process credit recovery).
  const turnStartedAtIso = new Date().toISOString();

  const turn = nextTurnNumber(row);

  if (isKillBeforeStart(options.sessionId, turn, session, options.sourceUserSeq)) {
    return { sessionId: options.sessionId, turn, status: 'killed' };
  }

  safeAppend({
    sessionId: options.sessionId,
    turn,
    role: 'system',
    type: 'turn_started',
    data: { input: clip(options.input, 200) },
  });
  let sourceUserSeq = Number.isSafeInteger(options.sourceUserSeq) && (options.sourceUserSeq ?? 0) > 0
    ? options.sourceUserSeq
    : undefined;
  if (!options.reuseRecordedUserInput && !sourceUserSeq) {
    const recorded = session.recordUserInput(options.authoritativeUserInput ?? options.input, turn);
    sourceUserSeq ??= recorded.seq;
  } else if (!sourceUserSeq) {
    // Legacy callers can request reuse without threading attempt identity. Pin
    // the current latest input once at turn start; downstream tool calls never
    // re-read session-global latest-user state.
    sourceUserSeq = listEvents(options.sessionId, { types: ['user_input_received'] }).at(-1)?.seq;
  }

  // Memory writeback. The harness path was previously missing this —
  // every user message went into the conversation log but no durable
  // facts or profile patches were extracted. The recall side (loaded
  // into the orchestrator's persistent context via harnessInstructions)
  // therefore had nothing fresh to surface, even after months of use.
  // Wiring it here means: every Discord/dashboard turn updates the
  // user profile (preferred name, tone, formality) and consolidates
  // durable facts (requirements, connected-app usage, project goals)
  // *as they're said*. The next turn's persistent-context block then
  // includes them automatically. Errors swallowed — capture failure
  // must never block the conversation.
  // Auto-memory learns ONLY from a genuine first-turn user message in a chat
  // session. Continuation steps (suppressMemoryCapture) carry the harness's own
  // synthetic re-prompts, and workflow/execution/agent sessions carry machine
  // input — neither should become durable "user" facts (2026-06-23 pollution).
  // captureInteractionSignals also self-guards harness-injected text.
  // Deferred off the first-token path (perceived-latency). The durable intake
  // ledger is written before the model answers; semantic consolidation may
  // finish in time for this turn's primer or may feed a future turn. The event
  // records both proposed signals and durable queued receipts so completion can
  // distinguish a real memory write from a zero-work acknowledgement.
  // Schedule unconditionally at the top so it still fires exactly once per turn
  // on every exit path (the microtask is already queued before any early
  // return); it runs at the first await (compaction) instead of blocking it.
  const shouldCapture = !options.suppressMemoryCapture && row.kind === 'chat';
  if (shouldCapture) {
    queueMicrotask(() => {
      try {
        const captured = captureInteractionSignals({
          message: options.authoritativeUserInput ?? options.input,
          sessionId: options.sessionId,
          sourceEventId: `turn:${turn}`,
        });
        if (captured.candidates.length > 0 || captured.profilePatch) {
          safeAppend({
            sessionId: options.sessionId,
            turn,
            role: 'system',
            type: 'memory_signals_captured',
            data: {
              factCount: captured.candidates.length,
              queuedCandidateCount: captured.queuedCandidateIds?.length ?? 0,
              episodeId: captured.episodeId ?? null,
              profilePatch: captured.profilePatch ?? null,
              reasons: captured.candidates.map((c) => c.reason),
            },
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('captureInteractionSignals failed:', err instanceof Error ? err.message : err);
      }
    });
  }

  const toolCounter = new ToolCallsCounter(
    options.toolCallsPerTurn ?? defaultToolCallsPerTurn(),
  );
  const heartbeatBudget = getHarnessBudgetSettings();
  const heartbeatMs = Math.max(60_000, heartbeatBudget.checkInMinutes * 60 * 1000);

  const makeRunner =
    options.makeRunner ??
    (() =>
      new Runner({
        workflowName: 'clementine-harness',
        groupId: options.sessionId,
      }));
  const runner = makeRunner();

  const detachLogHooks = attachEventLogHooks(runner as unknown as RunHooksLike, {
    getSessionId: extractSessionIdFromContext,
    getTurn: () => turn,
  });
  const onToolStart = (): void => {
    toolCounter.increment();
  };
  // T2.1 — when HARNESS_TOOL_BRACKETS is on, wrapToolForHarness in
  // brackets.ts owns the counter (incrementing AT tool-entry, with a
  // pre-increment willExceed check that throws BEFORE side effects).
  // When the flag is off, fall back to the legacy post-hoc hook so
  // counting still works for any agent that didn't go through the
  // wrap factory yet.
  const useToolWrapper = harnessToolBracketsEnabled();
  if (!useToolWrapper) {
    (runner as unknown as RunHooksLike).on(
      'agent_tool_start',
      onToolStart as (...args: unknown[]) => void,
    );
  }

  // Perceived-latency: kick off the memory primer + semantic-recall query embed
  // NOW so they run concurrently with compaction below instead of serially after
  // it. Both depend ONLY on the user input text (via searchVault / embedQuery),
  // never on compaction's reshaped `items` — verified against buildTurnMemoryPrimer
  // (reads the vault by query string) and primeTurnRecallVector (embeds the query
  // string). Awaited at its original consumption site further down.
  // Turn-stall fix layer 2: the assembly stage keeps a HARD outer timeout. Both
  // arms have internal bounds, but a live incident once froze a turn at exactly
  // this stage with zero events — belt and braces: if assembly doesn't settle in
  // 15s, proceed with a degraded (no-primer) turn instead of hanging the user. The
  // race leaves the slow promise to settle in the background; it never blocks the
  // turn again. Starting the timeout from THIS launch (vs. from the await site)
  // bounds total assembly wall-clock — strictly tighter than before.
  const syntheticRetryOriginalInput = isSyntheticStallRetryInput(options.input)
    ? latestHumanInputForStallRetry(options.sessionId)
    : undefined;
  let semanticInput = syntheticRetryOriginalInput ?? options.authoritativeUserInput ?? options.input;
  // On a self-continuation the input is the canned nudge, so the memory primer
  // and tool-recall breadcrumbs were querying "Continue with the next step of
  // your plan…" on nearly EVERY step of a long unattended run — boilerplate
  // in, boilerplate out (2026-08-04 efficiency audit). Anchor the semantic
  // query to the real objective instead: the session goal when one exists,
  // else the last real human input (for an ad-hoc background task that is its
  // own composed task prompt). The classifier substitution ~300 lines below
  // already did this for the context packet; the primer needed it too.
  if (continuationClassifyEnabled() && semanticInput === CONTINUATION_INPUT) {
    let anchor = '';
    try {
      const goal = safeActiveGoal(options.sessionId);
      anchor = (goal ? goalObjectiveString(goal) : '') ?? '';
    } catch { anchor = ''; }
    if (!anchor) anchor = latestHumanInputForStallRetry(options.sessionId) ?? '';
    if (anchor) semanticInput = anchor;
  }
  // The recall-vector embed is FIRE-AND-FORGET, not awaited: it stashes into a
  // TTL'd slot that per-turn fact recall reads OPPORTUNISTICALLY (late arrival
  // still helps mid-turn recalls; absence just drops the relevance term). The
  // primer's hybrid race is bounded at 800ms, but the embed's OpenAI fetch is
  // 6s + retries — awaiting the PAIR let a slow embeddings endpoint gate every
  // turn's first token (live 2026-07-03: 9.9s pre-brain on a greeting, 3.8s on
  // the next ask, both from embed fetch timeouts while the primer had already
  // fallen back). primeTurnRecallVector never rejects; the catch is belt.
  void primeTurnRecallVector(semanticInput).catch(() => {});
  const assemblyPromise = Promise.race([
    buildTurnMemoryPrimer(semanticInput, options.sessionId),
    new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), 15_000);
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
  // Both arms are internally guarded and cannot reject today, but launching the
  // promise here (rather than at the await site) opens a window — the compaction
  // span below — where a rejection would have no attached handler and surface as
  // a Node unhandledRejection. Attach a no-op catch so that can never happen; the
  // real `await assemblyPromise` further down still observes any rejection, so
  // await semantics are unchanged.
  void assemblyPromise.catch(() => { /* handled at the await site */ });

  // Auto-compact pass (v0.5.10). Runs Layer 1 deterministic trim and
  // Layer 2 LLM summarization between turns BEFORE we serialize input
  // for codex. Persists the compacted snapshot via
  // updateConversationSnapshot — NOT recordTurnResult, because that
  // would emit a phantom turn_ended pre-turn. The natural end-of-turn
  // recordTurnResult call (downstream of runner.run) handles the real
  // turn_ended emission.
  const sessionItems = session.toInputItems();
  let compactedItems = sessionItems;
  let layer3WarningInjected = false;
  // Compaction budget from the ROUTED model's real context window (the fixed
  // 200K assumption overflowed small-window BYO models before Layer 3 could
  // fork, and clipped 1M-window models at 60K with huge headroom — see
  // compactionBudgetForModel). Same value scales the in-flight thresholds below.
  const routedModelIdForBudget = typeof (options.agent as { model?: unknown })?.model === 'string'
    ? (options.agent as { model: string }).model
    : undefined;
  const turnInputBudgetTokens = compactionBudgetForModel(routedModelIdForBudget);
  // Idle gap since the last turn (read BEFORE this turn writes back, so it's the
  // previous turn's completion → now). Feeds age/idle-aware compaction so a stale
  // thread summarizes its old turns instead of dragging the full transcript in.
  let idleMs: number | undefined;
  try {
    const last = Date.parse(session.lastActivityAt());
    if (Number.isFinite(last)) idleMs = Math.max(0, Date.now() - last);
  } catch { /* no idle signal → no idle trigger (byte-identical to before) */ }
  try {
    const { result, nextItems, forkRequest } = await compactSessionIfNeeded(session, sessionItems, { idleMs, inputBudgetTokens: turnInputBudgetTokens });
    compactedItems = nextItems;
    if (result.modified) {
      session.updateConversationSnapshot(compactedItems);
    }
    if (forkRequest) {
      // Layer 3 fire — inject a one-shot system message at the head of
      // the items so the model surfaces the capacity warning in its
      // reply. The condenser_applied event already fired (from
      // compactSessionIfNeeded) so Discord/dashboard see the red ctx
      // footer; this message ensures the user reads a clear "start a
      // /new session" recommendation in the model's reply itself.
      compactedItems = [
        {
          role: 'system',
          content: '[CAPACITY WARNING] This conversation has reached the auto-compact ceiling (90%+ of input budget). Layer 1 + Layer 2 have already shrunk earlier turns. Complete this turn if you can, then politely recommend the user start a fresh session ("/new" in Discord, or a new chat in the dashboard) to continue with full headroom. Earlier tool results remain recallable via recall_tool_result if you need a specific detail.',
        } as unknown as AgentInputItem,
        ...compactedItems,
      ];
      layer3WarningInjected = true;
    }
  } catch (err) {
    // Compaction must never block a turn. Log and proceed with the
    // un-compacted items — the turn will either succeed naturally or
    // fail with SSE-truncation; either way we have visibility.
    // eslint-disable-next-line no-console
    console.warn('[harness] compactSessionIfNeeded failed', err instanceof Error ? err.message : err);
  }

  // Layer 3 warning is one-shot per turn: not persisted into the
  // conversation snapshot — only inserted into the items we send to
  // codex for this turn. Drop a marker so the audit log knows.
  if (layer3WarningInjected) {
    safeAppend({
      sessionId: options.sessionId,
      turn,
      role: 'system',
      type: 'guardrail_tripped',
      data: { kind: 'auto_compact_capacity_warning', reason: 'layer3_fork_threshold' },
    });
  }

  // Cross-brain replay fallback: the Claude SDK brain writes canonical
  // user_input_received/conversation_completed rows, but it does not populate the
  // OpenAI SDK conversation snapshot. If a later turn for the same session falls
  // over to this standard harness lane, replay only the eventlog turns/actions
  // missing from the snapshot. That covers both a fully empty snapshot and a mixed
  // session with an older OpenAI snapshot plus newer Claude turns, without
  // duplicating normal harness history.
  const replay = renderEventlogReplayFallback(options.sessionId, options.input, compactedItems);
  if (replay) {
    compactedItems = [
      {
        role: 'system',
        content: `[SESSION REPLAY]\n${replay}`,
      } as AgentInputItem,
      ...compactedItems,
    ];
  }

  // Cross-session prefix injection. The seed function in discord-harness
  // writes a cross_session_prefix event when a fresh session opens with
  // prior same-channel context. Without injecting it into items here,
  // the agent only sees it if it explicitly calls session_history —
  // which it often skips. Prepending as a system message guarantees
  // the agent reads the continuation context BEFORE deciding what tool
  // to call. (Observed in the missing-focus regression: agent skipped
  // session_history, called memory_recall, picked the wrong sheet.)
  // Only on the FIRST turn — subsequent turns already have it in
  // compactedItems via session history replay.
  if (turn === 1 || compactedItems.length === 0) {
    try {
      const prefixEvents = listEvents(options.sessionId, { types: ['cross_session_prefix'] });
      if (prefixEvents.length > 0) {
        const prefixText = prefixEvents
          .map((e) => {
            const text = (e.data as { text?: unknown })?.text;
            return typeof text === 'string' ? text : '';
          })
          .filter(Boolean)
          .join('\n\n');
        if (prefixText) {
          compactedItems.unshift({ role: 'system', content: prefixText } as AgentInputItem);
        }
      }
    } catch { /* graceful — never block a turn on prefix injection */ }
  }

  const items: AgentInputItem[] = [
    ...compactedItems,
    { role: 'user', content: options.input },
  ];

  // v0.5.19 Bug H + callModelInputFilter adoption (replaces the manual
  // items.push approach). The retry-context inject is now defined
  // below as a closure passed into `opts.callModelInputFilter` (see
  // SDK's runner/types.d.ts CallModelInputFilter). The SDK invokes
  // it just before the LLM call, with full access to the items +
  // system instructions. Advantages over our previous in-line push:
  //   1. Runs inside the SDK's tracing scope (each injection visible
  //      in OpenAI's trace dashboard if tracing is enabled)
  //   2. The SDK distinguishes "modelInput" (what the model sees)
  //      from "persistedItems" (what gets committed to session
  //      history), so transient injections like retry-context don't
  //      pollute the conversation record on re-replay
  //   3. Single canonical mutation point — future injections (e.g.
  //      session-pinned-resources to fix the grounding-on-retry gap)
  //      go in the same place
  // The combined modelInputFilter is defined just before `opts` below.

  // Pre-flight budget gate — Capacity-Aware Clem v0.5.18 primitive 2a.
  // Estimates the post-turn token cost BEFORE we call the SDK. If
  // projected > block threshold, inject a system message redirecting
  // the orchestrator to plan-or-ask instead of executing a turn that
  // would blow upstream limits. Honors env flag CLEMMY_PREFLIGHT_GATE=off
  // for revert. Fail-open: if the gate itself throws, we proceed with
  // the un-gated turn rather than blocking work on a meta-failure.
  //
  // SCOPE: chat sessions only. Workflow turns are pre-approved upfront
  // via the workflow definition (the workflow IS the plan) and have no
  // user to consult mid-step. Workflows benefit from the broader
  // Capacity-Aware Clem primitives (tool-return guardrail, side-store
  // recall, Codex SSE resilience); v0.5.19 F3 extends this telemetry
  // leg to workflows + adds compaction enforcement.
  //
  // v0.5.19 F1: the block message references only tools that actually
  // exist on the orchestrator surface (create_plan via MCP catalog,
  // ask_user_question registered inline). The earlier message named
  // `propose_plan` and `batch_external_calls` which were never
  // registered — when the gate fired, the model was instructed to call
  // tools that don't exist, defeating the gate's purpose.
  // v0.5.19 F3 — telemetry leg runs for ALL session kinds (chat,
  // workflow, execution, agent). Enforcement leg branches:
  //   - chat → existing F1 block-message injection (create_plan /
  //     ask_user_question — tools the orchestrator can actually call).
  //   - workflow/execution/agent → emit `workflow_step_overbudget`
  //     event for dashboard visibility + run a second compaction pass
  //     in case the first one (upstream of the gate) didn't trim
  //     enough. Workflows can't pause for user input mid-step so the
  //     model is allowed to proceed — but we surface the risk loudly.
  //     Honors CLEMMY_PREFLIGHT_WORKFLOW=off to revert workflow leg.
  if ((process.env.CLEMMY_PREFLIGHT_GATE ?? 'on').toLowerCase() !== 'off') {
    try {
      const stateTokens = estimateMessagesTokens(
        compactedItems as ReadonlyArray<{ content?: unknown; role?: string }>,
      );
      const userInputTokens = estimateTokens(
        typeof options.input === 'string' ? options.input : JSON.stringify(options.input ?? ''),
      );
      // Adaptive priors — look at the prior 3 turns' actual tool
      // behavior to predict this turn's cost. A session that just
      // fired 6 parallel composio calls returning 15K each will see
      // those priors (not the 2x2000 static fallback) and the gate
      // will correctly project the next turn into block territory.
      // Falls back to conservative static defaults if no history.
      const STATIC_PLANNED_TOOL_CALLS = 2;
      const STATIC_AVG_TOOL_RETURN = 2_000;
      const EXPECTED_OUTPUT_PRIOR = 1_500;
      const ADAPTIVE_SAFETY_FACTOR = 1.2;
      const { plannedToolCallCount, avgToolReturnTokens } = inferTurnPriors(
        options.sessionId,
        turn,
        { fallbackToolCount: STATIC_PLANNED_TOOL_CALLS, fallbackAvgReturn: STATIC_AVG_TOOL_RETURN, safetyFactor: ADAPTIVE_SAFETY_FACTOR },
      );
      const modelId = typeof (options.agent as { model?: unknown })?.model === 'string'
        ? (options.agent as { model: string }).model
        : MODELS.primary;
      const predicted = predictTurnCost({
        currentStateTokens: stateTokens,
        userInputTokens,
        plannedToolCallCount,
        avgToolReturnTokens,
        expectedOutputTokens: EXPECTED_OUTPUT_PRIOR,
      });
      // "Inform, rarely block": raise the block ceiling well above the
      // 0.85 default so the gate only fires when a turn is genuinely
      // near the wall. Env-tunable for emergencies. warn stays at 0.75.
      const blockFractionEnv = Number.parseFloat(getRuntimeEnv('CLEMMY_PREFLIGHT_BLOCK_FRACTION', '0.92') ?? '0.92');
      const blockFraction = Number.isFinite(blockFractionEnv) && blockFractionEnv > 0.75 && blockFractionEnv < 1
        ? blockFractionEnv
        : 0.92;
      const verdict = checkBudget({ predictedTokens: predicted, modelId, blockFraction });
      const sessionKind = session.sessionRow.kind;
      // Only emit guardrail_tripped when the budget check actually detects a problem.
      // 'ok' status checks (6-7% usage, well under limits) are not worth logging; they
      // create noise (91 events/day) without actionable information. Only 'warn' and 'block'
      // statuses indicate something worth tracking.
      if (verdict.status !== 'ok') {
        safeAppend({
          sessionId: options.sessionId,
          turn,
          role: 'system',
          type: 'guardrail_tripped',
          data: {
            kind: 'preflight_budget_check',
            sessionKind,
            status: verdict.status,
            predictedTokens: verdict.predictedTokens,
            effectiveLimit: verdict.effectiveLimit,
            fractionUsed: Number(verdict.fractionUsed.toFixed(3)),
            plannedToolCallCount,
            avgToolReturnTokens,
            adaptive: plannedToolCallCount !== STATIC_PLANNED_TOOL_CALLS || avgToolReturnTokens !== STATIC_AVG_TOOL_RETURN,
            reason: verdict.reason,
          },
        });
      }
      if (verdict.status === 'block') {
        if (sessionKind === 'chat') {
          // Inject the F1-rewritten block message pointing at real tools.
          const blockMessage = buildPreflightBlockMessage({
            predictedTokens: verdict.predictedTokens,
            blockFraction: verdict.blockFraction,
            effectiveLimit: verdict.effectiveLimit,
          });
          items.unshift({
            role: 'system',
            content: blockMessage,
          } as AgentInputItem);
        } else if ((process.env.CLEMMY_PREFLIGHT_WORKFLOW ?? 'on').toLowerCase() !== 'off') {
          // Workflow / execution / agent path — no user to consult,
          // no propose_plan interlude available. Emit a loud event
          // so the dashboard surfaces the risk; the step proceeds
          // (the workflow runner reads this event for retry/abort
          // decisions if it wants to).
          safeAppend({
            sessionId: options.sessionId,
            turn,
            role: 'system',
            type: 'workflow_step_overbudget',
            data: {
              predictedTokens: verdict.predictedTokens,
              effectiveLimit: verdict.effectiveLimit,
              fractionUsed: Number(verdict.fractionUsed.toFixed(3)),
              plannedToolCallCount,
              avgToolReturnTokens,
              modelId,
              note: 'Workflow step projected over context budget. Compaction already ran upstream of this gate. Step proceeds; consider splitting workflow if this fires repeatedly.',
            },
          });
        }
      }
    } catch (err) {
      // Fail-open: a bug in the gate must not block the user's turn.
      // We log loudly so the failure is visible in supervisor.log.
      // eslint-disable-next-line no-console
      console.warn(
        '[harness] preflight budget gate threw (fail-open)',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // The memory primer + semantic-recall query embed were launched above so they
  // ran concurrently with compaction (neither depends on compaction's output).
  // Await the settled result here, at its original consumption site — the 15s
  // hard outer timeout was started at launch, so on timeout we proceed with a
  // degraded (no-primer) turn exactly as before.
  const assemblySettled = await assemblyPromise;
  const turnMemoryPrimer: TurnMemoryPrimer = assemblySettled
    ? assemblySettled
    : {
        enabled: true,
        query: semanticInput.replace(/\s+/g, ' ').trim().slice(0, 160),
        hitCount: 0,
        injectedBytes: 0,
        skippedReason: 'assembly_timeout',
      };
  // Goal contract: re-fetch the session's parked goal EVERY turn from the
  // store (never trusted to transcript memory) so the model always works
  // against the authoritative objective + criteria + progress ledger.
  const activeGoalForTurn = safeActiveGoal(options.sessionId);
  // CONTINUATION-AWARE CLASSIFICATION (CLEMMY_CONTINUATION_CLASSIFY, default on).
  // On a self-continuation, options.input is the canned CONTINUATION_INPUT nudge,
  // which always classifies 'simple' → reasoning effort 'none' even when the
  // parked goal is a multi-step build — so she runs the hardest turns at zero
  // budget and thrashes. Classify the packet against the real objective so
  // complexity / skill / workflow ranking reflect the TASK she is mid-flight on.
  // Fires ONLY on the exact continuation signal (not merely "a goal exists"), so
  // a real user message in a goal-bearing session is still judged on its own
  // text. Synthetic retry prompts classify against the last real human ask so
  // retry boilerplate cannot accidentally strip external tools.
  let classifierInput = semanticInput;
  if (continuationClassifyEnabled() && options.input === CONTINUATION_INPUT && activeGoalForTurn) {
    const objective = goalObjectiveString(activeGoalForTurn);
    if (objective) classifierInput = objective;
  }
  const canonicalContext = buildCanonicalContextPack({
    input: classifierInput,
    sessionId: options.sessionId,
    sessionKind: session.sessionRow.kind,
    // The confirm beat only ever evaluates a REAL user message: synthetic
    // continuation nudges (classified against the goal objective above) and
    // stall-retry boilerplate must not trip it mid-run (turn-control review).
    suppressConfirmBeat: options.input === CONTINUATION_INPUT || Boolean(syntheticRetryOriginalInput),
    sourceUserSeq,
    memory: {
      enabled: turnMemoryPrimer.enabled,
      hitCount: turnMemoryPrimer.hitCount,
      source: turnMemoryPrimer.source ?? null,
      injected: Boolean(turnMemoryPrimer.text),
      skippedReason: turnMemoryPrimer.skippedReason ?? null,
    },
  });
  const contextPacket = canonicalContext.turn;
  // WHAT IS STILL OPEN (parity with the Claude lane — one surface, both
  // brains). A separate cross-family pass over the readings of this request,
  // gated on the runtime's own resolved capabilities rather than on the
  // grammar of the sentence. Fail-open and time-boxed: it may inform this turn,
  // never delay or break it.
  let opennessBlock = '';
  if (
    session.sessionRow.kind === 'chat'
    && turnOpennessEnabled()
    && turnOpennessWarranted(contextPacket.capabilityResolution.entries)
  ) {
    try {
      opennessBlock = renderTurnOpennessForContext(await resolveTurnOpenness({
        message: classifierInput,
        capabilityBlock: renderCapabilityResolutionForContext(contextPacket.capabilityResolution),
        memoryBlock: turnMemoryPrimer.text ?? '',
      }));
    } catch { opennessBlock = ''; }
  }
  safeAppend({
    sessionId: options.sessionId,
    turn,
    role: 'system',
    type: 'turn_memory_primer',
    data: {
      enabled: turnMemoryPrimer.enabled,
      queryPreview: clip(turnMemoryPrimer.query, 160),
      hitCount: turnMemoryPrimer.hitCount,
      includedCount: turnMemoryPrimer.hitCount,
      injected: Boolean(turnMemoryPrimer.text),
      injectedBytes: turnMemoryPrimer.injectedBytes,
      source: turnMemoryPrimer.source ?? null,
      skippedReason: turnMemoryPrimer.skippedReason ?? null,
      recallId: turnMemoryPrimer.recallId ?? null,
      answerability: turnMemoryPrimer.answerability ?? null,
      candidateCount: turnMemoryPrimer.candidateCount ?? null,
      omittedCount: turnMemoryPrimer.omittedCount ?? null,
      stores: turnMemoryPrimer.stores ?? [],
      recallElapsedMs: turnMemoryPrimer.recallElapsedMs ?? null,
    },
  });
  safeAppend({
    sessionId: options.sessionId,
    turn,
    role: 'system',
    type: 'agent_context_packet',
    data: {
      inputPreview: contextPacket.inputPreview,
      complexity: contextPacket.complexity,
      memory: contextPacket.memory,
      prospective: contextPacket.prospective,
      skills: contextPacket.skills,
      workflows: contextPacket.workflows,
      toolScope: contextPacket.toolScope,
      mcp: contextPacket.mcp,
      healthWarnings: contextPacket.healthWarnings,
      agentSystem: contextPacket.agentSystem,
      multiItem: contextPacket.multiItem,
      contextPack: {
        version: canonicalContext.version,
        source: canonicalContext.source,
        diagnostics: canonicalContext.diagnostics,
      },
      injectedBytes: contextPacket.text.length,
    },
  });
  if (contextPacket.multiItem.detected) {
    const policy = contextPacket.agentSystem.policy;
    safeAppend({
      sessionId: options.sessionId,
      turn,
      role: 'system',
      type: 'fanout_policy_decision',
      data: {
        sourceUserSeq,
        inputPreview: contextPacket.inputPreview,
        sessionKind: session.sessionRow.kind,
        complexity: contextPacket.complexity,
        detected: contextPacket.multiItem.detected,
        itemCount: contextPacket.multiItem.itemCount,
        offered: contextPacket.multiItem.offered,
        blockedByPolicy: contextPacket.multiItem.blockedByPolicy,
        fanoutPosture: contextPacket.multiItem.fanoutPosture,
        recommendedWorkerWaveSize: contextPacket.multiItem.recommendedWorkerWaveSize,
        policyMode: policy?.mode ?? null,
        policyStatus: policy?.status ?? null,
        policyConfidence: policy?.confidence ?? null,
      },
    });
  }

  // v0.5.19 Bug H + callModelInputFilter adoption — build the closure
  // the SDK will invoke just before the LLM call. It appends transient
  // model-only context that should NOT persist into session history:
  // (1) a per-turn memory primer from local FTS/hybrid recall, and
  // (2) retry context for infra-error recovery. Honors
  // CLEMMY_TURN_MEMORY_PRIMER=off and CLEMMY_RETRY_CONTEXT_INJECT=off.
  let inFlightCompactionReported = false;
  const toolPromptComponents = estimateAgentToolPromptComponents(options.agent);
  const modelInputFilter = ((args: {
    modelData: { input: AgentInputItem[]; instructions?: string };
  }) => {
    let modelData = args.modelData;
    let promptComponents: Record<string, number> = {};
    const publishPromptComponents = <T extends { input: AgentInputItem[]; instructions?: string }>(value: T): T => {
      const harnessContext = harnessRunContextStorage.getStore();
      if (harnessContext) {
        harnessContext.promptComponents = Object.keys(promptComponents).length > 0
          ? { ...promptComponents }
          : {
              instructions: estimateTokens(value.instructions),
              history: estimateInputTokens(value.input),
              ...toolPromptComponents,
            };
      }
      // Composition as CACHEABILITY (parity with the Claude lane): per-step
      // prompt cost is paid once per step and ~100x per task, and the lever is
      // keeping the large part invariant rather than making everything small.
      // Observation only — this reads what is already being sent.
      recordPromptComposition(options.sessionId, 'codex', summarizePromptComposition({
        instructions: value.instructions ?? '',
        contextPacket: contextPacket.text,
        currentMessage: typeof options.input === 'string' ? options.input : '',
      }), sourceUserSeq);
      return value;
    };
    try {
      // The Runner may make dozens of model calls inside this ONE turn. Its
      // persisted history must remain lossless, but later model calls should
      // not re-send every raw result from the beginning of the turn. Once the
      // completed-result payload crosses the threshold, replace only the
      // model-facing old pairs with a recall ledger and retain a recent working
      // set. Every full output was durably parked by the tool-end hook first.
      if (inFlightCompactionEnabled()) {
        // Defaults scale with the routed model's window (32K/20K were tuned for
        // a 200K window; a 1M-window model was in-flight-compacting at 3% of its
        // real capacity). Never scaled DOWN below the tuned defaults — small
        // windows are protected by the between-turn budget above. Env overrides
        // still win untouched.
        const inFlightScale = Math.max(1, turnInputBudgetTokens / 200_000);
        const compacted = compactInFlightToolContext(modelData.input, options.sessionId, {
          resultTriggerTokens: positiveIntEnv('CLEMMY_INFLIGHT_RESULT_TRIGGER_TOKENS', Math.round(32_000 * inFlightScale)),
          retainedResultBudgetTokens: positiveIntEnv('CLEMMY_INFLIGHT_RESULT_BUDGET_TOKENS', Math.round(20_000 * inFlightScale)),
          minRetainPairs: positiveIntEnv('CLEMMY_INFLIGHT_MIN_RETAIN_PAIRS', 3),
          maxRetainPairs: positiveIntEnv('CLEMMY_INFLIGHT_MAX_RETAIN_PAIRS', 8),
        });
        if (compacted.applied) {
          modelData = {
            input: compacted.nextItems,
            instructions: modelData.instructions,
          };
          if (!inFlightCompactionReported) {
            inFlightCompactionReported = true;
            safeAppend({
              sessionId: options.sessionId,
              turn,
              role: 'system',
              type: 'condenser_applied',
              data: {
                inFlight: true,
                layer1: {
                  applied: true,
                  clipped: 0,
                  collapsedToolPairs: compacted.collapsed,
                },
                layer2: { applied: false },
                layer3: { applied: false },
                beforeTokens: compacted.beforeTokens,
                afterTokens: compacted.afterTokens,
                budgetTokens: compacted.triggerTokens,
                resultTokensBefore: compacted.resultTokensBefore,
                retainedToolPairs: compacted.retainedPairs,
              },
            });
          }
        }
      }

      promptComponents = {
        instructions: estimateTokens(modelData.instructions),
        history: estimateInputTokens(modelData.input),
        ...toolPromptComponents,
      };

      const contextPacketText = [contextPacket.text, opennessBlock].filter(Boolean).join('\n\n');
      if (contextPacketText) {
        promptComponents.contextPacket = estimateTokens(contextPacketText);
        modelData = {
          input: [
            ...modelData.input,
            { role: 'system', content: contextPacketText } as AgentInputItem,
          ],
          instructions: modelData.instructions,
        };
      }

      if (turnMemoryPrimer.text) {
        promptComponents.memoryPrimer = estimateTokens(turnMemoryPrimer.text);
        modelData = {
          input: [
            ...modelData.input,
            { role: 'system', content: turnMemoryPrimer.text } as AgentInputItem,
          ],
          instructions: modelData.instructions,
        };
      }

      // Goal contract: the parked goal block rides with the model-only
      // transient context (like the memory primer — never persisted into
      // session history, re-rendered fresh from the store each turn).
      if (activeGoalForTurn) {
        const goalContext = renderGoalContextBlock(activeGoalForTurn);
        promptComponents.goal = estimateTokens(goalContext);
        modelData = {
          input: [
            ...modelData.input,
            { role: 'system', content: goalContext } as AgentInputItem,
          ],
          instructions: modelData.instructions,
        };
      }

      if ((getRuntimeEnv('CLEMMY_RETRY_CONTEXT_INJECT', 'on') ?? 'on').toLowerCase() === 'off') {
        return publishPromptComponents(modelData);
      }
      const recentAwaiting = listEvents(options.sessionId, { types: ['awaiting_user_input'], limit: 1, desc: true });
      const last = recentAwaiting[recentAwaiting.length - 1];
      const lastData = last?.data as
        | { source?: string; retry_context?: Record<string, unknown> | null; boundaryKind?: string }
        | undefined;
      if (lastData?.source !== 'infra_error_recovery' || !lastData.retry_context) {
        return publishPromptComponents(modelData);
      }
      const userInputRaw = typeof options.input === 'string' ? options.input.trim() : '';
      if (!/^(retry|yes|continue|resume|go|try again)$/i.test(userInputRaw)) {
        return publishPromptComponents(modelData);
      }
      const ctx = lastData.retry_context as {
        failed_tool?: string;
        failed_args?: string | null;
        failed_call_id?: string | null;
      };
      const boundaryKind = lastData.boundaryKind ?? 'infra_error';
      const argsStr = ctx.failed_args ? ` with arguments: ${ctx.failed_args}` : '';
      const callIdNote = ctx.failed_call_id ? ` (prior call_id ${ctx.failed_call_id})` : '';
      const retryMsg = {
        role: 'system' as const,
        content:
          `[RETRY CONTEXT] Your previous turn was interrupted by ${boundaryKind} mid-call. ` +
          `The user replied "${userInputRaw}" — they mean: re-issue the SAME call that failed${callIdNote}. ` +
          `Failed tool: \`${ctx.failed_tool ?? 'unknown'}\`${argsStr}. ` +
          `Do NOT re-plan, do NOT re-discover the toolkit, do NOT switch to a different task or resource. ` +
          `If the same call is not the right move (e.g. the args genuinely need to change), call ` +
          `\`ask_user_question\` to clarify — do not silently change resources or scope.`,
      } as AgentInputItem;
      promptComponents.retryContext = estimateInputTokens([retryMsg]);
      return publishPromptComponents({
        input: [...modelData.input, retryMsg],
        instructions: modelData.instructions,
      });
    } catch {
      return publishPromptComponents(modelData); // best-effort
    }
  });

  const opts: Record<string, unknown> = {
    context: {
      sessionId: options.sessionId,
      turn,
      ...(sourceUserSeq ? { sourceUserSeq } : {}),
    },
    maxTurns: options.maxTurns ?? maxTurnsForRole('orchestrator'),
    callModelInputFilter: modelInputFilter,
    // v0.5.22 SDK 0.11.5 — cap parallel function-tool execution at 8.
    // Documented production incident pre-v0.5.20: the model emitted 50
    // parallel firecrawl_search calls and the resulting tool-result
    // payload (1MB+) crashed Codex SSE. With this cap the SDK paces
    // the same N tool calls in batches of 8 — same final result count
    // but fewer simultaneous network calls, lower peak memory, and
    // friendlier on external API rate limits. Does NOT change
    // provider-side parallelToolCalls (model still decides to parallelize).
    toolExecution: { maxFunctionToolConcurrency: 8 },
    toolNotFoundBehavior: 'return_error_to_model',
    toolErrorFormatter: formatMissingToolForModel,
  };
  // Provider deltas intentionally stay inside the execution plane. A model
  // token stream is neither a verified result nor publication authority; the
  // outer graph publishes only a committed TurnOutcome presentation.
  // DO NOT pass previousResponseId to the SDK when using the codex
  // backend. The SDK uses this flag to opt into a ServerConversationTracker
  // that only sends DELTAS to the model on each subsequent call —
  // assuming the server remembers prior items via the response chain.
  // Codex enforces `store: false`, so the server has no memory of past
  // responses. The delta-only mode then sends just the latest tool
  // output to the model, which codex correctly rejects with
  // "No tool call found for function call output ...".
  // The full history is already inlined into `items` above
  // (session.toInputItems() returns everything), so codex sees the
  // complete conversation on every call without needing server state.

  // Dynamic reasoning effort (per-turn). gpt-5.x reasons before emitting any
  // token, so reasoning depth is the dominant per-turn latency knob. gpt-5.5's
  // SDK default is effort:'none', so simple turns are already minimal — this
  // only RAISES effort, and only by the "is a human waiting?" axis: interactive
  // chat turns cap at 'medium' (never make a person wait on 'high'), background
  // turns (workflow/execution/goal-resume) may go 'high' where depth aids hard
  // multi-step work and latency is invisible. Reuses the context packet's
  // complexity (one classifier, no duplicate).
  //
  // The SDK only honors agent.modelSettings when it was set at CONSTRUCTION
  // (buildOrchestratorAgent seeds it when the feature is on — that's what flips
  // the SDK's explicit flag legitimately, no internal poking here). We just
  // mutate reasoning.effort on the public field. Kill-switch
  // CLEMMY_DYNAMIC_REASONING=off → orchestrator has no explicit modelSettings,
  // so this mutation is a no-op the SDK ignores and its default rides.
  if (dynamicReasoningEnabled()) {
    try {
      const { effort, reason } = selectReasoningEffort(contextPacket.complexity, {
        interactive: session.sessionRow.kind === 'chat',
      });
      const agentRef = options.agent as unknown as { modelSettings?: Record<string, unknown> };
      const prev = agentRef.modelSettings ?? {};
      agentRef.modelSettings = {
        ...prev,
        reasoning: { ...(prev.reasoning as object ?? {}), effort },
        text: { verbosity: 'low', ...(prev.text as object ?? {}) },
      };
      safeAppend({
        sessionId: options.sessionId,
        turn,
        role: 'system',
        type: 'reasoning_effort',
        data: { effort, reason, complexity: contextPacket.complexity, kind: session.sessionRow.kind },
      });
    } catch { /* effort selection must never break a turn */ }
  }

  try {
    const run = options.runRunner ?? defaultRunRunner;
    // Hoisted so the post-turn auto-credit hook can read the recall runs the
    // turn's tool handlers registered (turnRecallRunIds). Built lazily inside
    // the heartbeat callback where recallBudget exists.
    let harnessCtx: HarnessRunContext | undefined;
    // T2.1 — install the AsyncLocalStorage context so any wrapToolForHarness
    // wrapper inside the SDK's run() can read the per-turn counter +
    // sessionId without explicit threading. Pass-through when the
    // wrapper flag is off (no behavior change).
    const outcome = await withActiveTurnHeartbeat(
      {
        sessionId: options.sessionId,
        turn,
        budget: heartbeatBudget,
        checkInMs: heartbeatMs,
        stage: 'turn',
      },
      async () => {
        // Budget raised 3×60KB → 5×150KB via env (2026-07-08): the morning
        // prospect workflow's tracker sheet grew past 60KB and the step could
        // no longer page the full payload back in one turn — it punted with
        // accounts:[] and the contract checker (rightly) halted the run. Data
        // grows daily; a fixed 60KB budget is a cliff every long-lived source
        // eventually walks off. Still bounded per turn to protect compaction.
        // Defaults scale with the routed model's window (5/150KB were tuned
        // for a 200K window; a 1M-window brain paging a large parked payload
        // hit the cliff at 3 slices). Env overrides stay absolute.
        const recallBudget = new RecallBudget(
          recallBudgetMaxCalls(windowScaleForModel(routedModelIdForBudget)),
          recallBudgetMaxBytes(windowScaleForModel(routedModelIdForBudget)),
        );
        harnessCtx = {
          sessionId: options.sessionId,
          counter: toolCounter,
          sourceUserSeq,
          ...(options.runAttemptId ? { runAttemptId: options.runAttemptId } : {}),
          behaviorScopeId: `${options.sessionId}::turn:${turn}`,
          recallBudget,
          ...(routedModelIdForBudget ? { routedModelId: routedModelIdForBudget } : {}),
          mcpToolScope: options.mcpToolScope !== undefined
            ? options.mcpToolScope
            : (() => {
                const bound = boundAgentMcpToolScope(options.agent);
                return bound.bound ? bound.scope : contextPacket.toolScope;
              })(),
        };
        // With or without the tool-bracket wrapper, install the
        // AsyncLocalStorage context so recall_tool_result can resolve the
        // session id + per-turn budget.
        return await withHarnessRunContext(
          harnessCtx,
          () => run(runner, options.agent, items, opts),
        ) as RunOutcome;
      },
    );

    if (outcome.hasInterruptions && outcome.serializedState) {
      // The SDK pauses BEFORE invoking the tool's execute when
      // needsApproval=true, so we — not the tool body — must record
      // approval_requested. registerAndEmitApprovals registers each
      // interruption in the addressable approval registry AND emits
      // the audit-log event with the approval ID inlined.
      registerAndEmitApprovals(
        { sessionId: options.sessionId, turn },
        session,
        outcome.interruptions ?? [],
      );
      session.saveInterruptState(outcome.serializedState, {
        mcpToolScope: harnessCtx?.mcpToolScope,
      });
      bumpTurnNumber(options.sessionId, turn);
      return { sessionId: options.sessionId, turn, status: 'awaiting_approval' };
    }

    const compactionRewrite = rewriteHistoryWithNativeCompaction(outcome.history, outcome.rawResponses);
    if (compactionRewrite.applied) {
      safeAppend({
        sessionId: options.sessionId,
        turn,
        role: 'system',
        type: 'native_compaction_applied',
        data: {
          previousItems: compactionRewrite.previousItems,
          nextItems: compactionRewrite.nextItems,
          compactionItemsSeen: compactionRewrite.compactionItemsSeen,
          latestCompactionId: compactionRewrite.latestCompactionId,
          latestCompactionBytes: compactionRewrite.latestCompactionBytes,
          preservedAssistantMessage: compactionRewrite.preservedAssistantMessage,
        },
      });
    }

    session.recordTurnResult({
      history: compactionRewrite.history,
      lastResponseId: outcome.lastResponseId,
      turn,
    });
    safeAppend({
      sessionId: options.sessionId,
      turn,
      role: 'system',
      type: 'run_completed',
      data: {
        finalOutputPreview: previewOutput(outcome.finalOutput),
        toolCalls: toolCounter.currentCount,
      },
    });
    // Post-turn hooks (correction detection then auto-credit) via the ONE shared
    // spine — identical on every brain lane. New post-turn behavior wires there.
    runPostTurnHooks({
      sessionId: options.sessionId,
      turn,
      userInput: options.authoritativeUserInput ?? options.input,
      recallIds: [turnMemoryPrimer.recallId, ...(harnessCtx?.turnRecallRunIds ?? [])],
      turnStartedAt: turnStartedAtIso,
      replyText: typeof outcome.finalOutput === 'string'
        ? outcome.finalOutput
        : (() => { try { return JSON.stringify(outcome.finalOutput) ?? ''; } catch { return ''; } })(),
      // Defensive: stubbed/degraded runners can hand back a non-array history.
      toolArgTexts: extractFunctionCallArgTexts(Array.isArray(outcome.history) ? outcome.history.slice(items.length) : []),
    });
    // Chat sessions stay 'active' between turns (inherently multi-turn).
    // Workflow / execution / agent sessions normally flip to 'completed'
    // here BUT not if approvals are still pending — `markStatus('completed')`
    // mid-approval was the root cause behind reaper false-reaps + the
    // status-drift bug surfaced in P0-4. The reaper guards I shipped in
    // v0.5.2 (90s grace + interrupt-state check) are workarounds; this
    // is the actual fix. The conversation_completed event still fires
    // for both branches — that's how the chat dock learns the turn
    // ended; the session staying 'active' just keeps the door open for
    // the next user message or approval resolution.
    if (session.sessionRow.kind !== 'chat' && !approvalRegistry.hasPending(options.sessionId)) {
      session.markStatus('completed');
    }
    bumpTurnNumber(options.sessionId, turn);
    return {
      sessionId: options.sessionId,
      turn,
      status: 'completed',
      finalOutput: outcome.finalOutput,
      toolCalls: toolCounter.currentCount,
    };
  } catch (err) {
    return handleRunError(options.sessionId, turn, session, err, {
      deferInfraAsk: options.deferInfraAsk,
      sourceUserSeq,
    });
  } finally {
    detachLogHooks();
    (runner as unknown as RunHooksLike).off(
      'agent_tool_start',
      onToolStart as (...args: unknown[]) => void,
    );
  }
}

// ---------- resume after approval ----------

export interface ResumePendingApprovalOptions {
  agent: Agent<any, any>;
  sessionId: string;
  /** Durable outer request attempt. The resumed SDK state must retain the
   * same authority as the workflow/chat turn that originally parked it. */
  runAttemptId?: string;
  /** Exact accepted approval-control event for terminal identity. */
  sourceUserSeq?: number;
  /** Exact durable card the human acted on. When supplied, only the SDK
   * interruption whose tool and full payload match this row may inherit the
   * decision; every sibling interruption remains pending. */
  approvalId?: string;
  /**
   * 'approve'              — run the paused tool call with the args the
   *                          agent originally proposed.
   * 'reject'               — reject the call; agent sees rejection in
   *                          its tool result and decides what to do.
   * 'approve_with_edits'   — same as approve, BUT replace the tool
   *                          call's arguments with `modifiedArgs`
   *                          before running. Lets the user fix a slug
   *                          arg (calendar time, recipient, etc.)
   *                          inline instead of rejecting + asking the
   *                          agent to retry.
   */
  decision: 'approve' | 'reject' | 'approve_with_edits';
  /**
   * When `decision === 'approve_with_edits'`, the JSON-encoded args
   * object to substitute for the agent's original proposal. The shape
   * must match the tool's expected input schema — invalid JSON or
   * shape mismatches will surface as a normal tool error to the
   * agent, which will recover.
   */
  modifiedArgs?: string;
  /**
   * Audit source recorded when the durable approval row is resolved.
   * Callers pass the surface that accepted the approval; the harness
   * resolves the pre-resume row before continuing the SDK run so a
   * second approval requested by that run does not inherit the old
   * decision.
   */
  resolver?: string;
  maxTurns?: number;
  toolCallsPerTurn?: number;
  /** Stage 4 — run token ceiling override threaded through the resume family. */
  maxRunTokens?: number;
  /** Test injection. */
  makeRunner?: () => Runner;
  /** Test injection: drive the resume with a pre-built outcome. */
  runRunner?: RunRunnerFn;
  /** @deprecated Raw executor deltas are private. Retained temporarily for API
   * compatibility; terminal delivery occurs through committed public events. */
  onChunk?: (delta: string) => void | Promise<void>;
}

/**
 * Resume a session that was paused waiting for the user to approve a
 * tool call. Loads the persisted RunState, resolves each pending
 * interruption (approve or reject), continues the run with the SDK's
 * stateful runner, and persists the outcome the same way runTurn
 * does (recording approval_resolved + run_resumed events, handling
 * another interruption if it fires, handling the normal completion
 * path, etc.).
 *
 * Returns:
 *   - `awaiting_approval` if the resumed run requests another approval.
 *   - `completed` once the run finishes naturally.
 *   - The usual failure modes (killed, limit_exceeded, failed).
 *
 * If the session is not paused / has no saved RunState, returns
 * `completed` with no work done — callers can treat that as a no-op.
 */
export async function resumePendingApproval(
  options: ResumePendingApprovalOptions,
): Promise<RunTurnResult> {
  const row = getSession(options.sessionId);
  if (!row) throw new Error(`unknown session: ${options.sessionId}`);
  const session = HarnessSession.load(options.sessionId);
  if (!session) throw new Error(`unable to load session: ${options.sessionId}`);
  // Anchor for the post-turn recall-run sweep (cross-process credit recovery).
  const turnStartedAtIso = new Date().toISOString();

  const blob = session.loadInterruptState();
  if (!blob) {
    // Session isn't paused — no RunState to resume (typically a daemon restart
    // dropped the interrupt blob). Before degenerating to a fresh turn (which
    // would RE-COMPOSE the payload and mint a new approval — the approve→re-ask
    // treadmill), replay the session's approved unconsumed action verbatim and
    // stage the result so the next turn continues from it. Fail-open no-op when
    // there is nothing to replay.
    if (options.decision === 'approve' || options.decision === 'approve_with_edits') {
      try {
        const { replayApprovedActionForSession, renderApprovedReplayNote } = await import('../../execution/approval-replay.js');
        const replayOutcome = await replayApprovedActionForSession(options.sessionId);
        if (replayOutcome) {
          safeAppend({
            sessionId: options.sessionId,
            turn: 0,
            role: 'user',
            type: 'user_input_received',
            data: {
              text: renderApprovedReplayNote(replayOutcome),
              synthetic: true,
              source: 'approval-replay',
              approvalId: replayOutcome.approvalId,
            },
          });
        }
      } catch { /* replay is best-effort; the caller's fresh turn remains the fallback */ }
    }
    // Caller can decide to treat the prompt as a fresh user turn instead.
    return { sessionId: options.sessionId, turn: 0, status: 'completed' };
  }

  const turn = nextTurnNumber(row);

  const resumeSourceUserSeq = Number.isSafeInteger(options.sourceUserSeq) && (options.sourceUserSeq ?? 0) > 0
    ? options.sourceUserSeq
    : (() => {
        try { return getLatestRunAttempt(options.sessionId)?.sourceUserSeq ?? undefined; } catch { return undefined; }
      })();
  // Agent construction happens before RunState deserialization. Capture its
  // exact bound connector scope now so a second approval pause persists the
  // same authority even when tool brackets are disabled.
  const resumeAgentScopeBinding = boundAgentMcpToolScope(options.agent);

  if (isKillBeforeStart(options.sessionId, turn, session, resumeSourceUserSeq)) {
    return { sessionId: options.sessionId, turn, status: 'killed' };
  }

  // Deserialize the paused RunState. Lazy-imported so the SDK module
  // graph doesn't force-load on every loop import (RunState is heavy).
  const { RunState } = await import('@openai/agents');
  let state;
  try {
    state = await RunState.fromString(options.agent, blob);
  } catch (err) {
    const message = normalizeError(err);
    safeAppend({
      sessionId: options.sessionId,
      turn,
      role: 'system',
      type: 'run_failed',
      data: { error: `failed to deserialize RunState: ${clip(message, 300)}` },
    });
    session.markStatus('failed');
    session.clearInterruptState();
    bumpTurnNumber(options.sessionId, turn);
    return { sessionId: options.sessionId, turn, status: 'failed', error: message };
  }

  // Resolve each interruption. The SDK's RunState exposes pending
  // tool-approval items via getInterruptions() (a METHOD, not a
  // property — the property `interruptions` only exists on
  // RunResult/StreamedRunResult, not on RunState). My earlier code
  // read state.interruptions, got undefined → [], approved zero
  // items, and let the orchestrator re-emit the same approval call
  // on the next turn. Loop. Use the method.
  const stateApi = state as unknown as {
    getInterruptions(): unknown[];
    approve(i: unknown, opts?: { alwaysApprove?: boolean }): void;
    reject(i: unknown, opts?: { alwaysReject?: boolean }): void;
  };
  const pending: unknown[] = stateApi.getInterruptions() ?? [];
  const approvalRowsAtResume = pending.length > 0
    ? approvalRegistry.listPending({ sessionId: options.sessionId, status: 'pending' })
    : [];
  const wantedResolution: approvalRegistry.ApprovalResolution =
    options.decision === 'reject' ? 'rejected' : 'approved';
  const authorityRefusal = (reason: string): RunTurnResult => {
    safeAppend({
      sessionId: options.sessionId,
      turn,
      role: 'system',
      type: 'guardrail_tripped',
      data: {
        kind: 'approval_authority_mismatch',
        approvalId: options.approvalId ?? null,
        reason,
        pendingInterruptions: pending.length,
        pendingApprovalRows: approvalRowsAtResume.length,
      },
    });
    return {
      sessionId: options.sessionId,
      turn,
      status: 'awaiting_approval',
      error: reason,
    };
  };

  let selectedApproval: approvalRegistry.PendingApprovalRow | undefined;
  if (options.approvalId) {
    selectedApproval = approvalRegistry.get(options.approvalId);
    if (!selectedApproval || selectedApproval.sessionId !== options.sessionId) {
      return authorityRefusal('The selected approval card does not belong to this paused session.');
    }
  } else if (pending.length === 1 && approvalRowsAtResume.length === 1) {
    selectedApproval = approvalRowsAtResume[0];
  } else if (pending.length > 0) {
    return authorityRefusal('Multiple approval interruptions require one exact approval ID; no decision was applied.');
  }

  let selectedInterruption: unknown;
  if (pending.length > 0) {
    if (!selectedApproval) {
      return authorityRefusal('No durable approval card identifies the interrupted action.');
    }
    const matches = pending.filter((item) => {
      const raw = (item as {
        rawItem?: { name?: unknown; arguments?: unknown };
        toolName?: unknown;
      } | null)?.rawItem;
      const tool = raw?.name
        ?? (item as { toolName?: unknown } | null)?.toolName;
      return approvalAuthorityMatchesToolCall(selectedApproval!, tool, raw?.arguments);
    });
    if (matches.length !== 1) {
      return authorityRefusal(
        matches.length === 0
          ? 'The selected approval does not match any serialized tool payload.'
          : 'The selected approval ambiguously matches multiple serialized tool calls.',
      );
    }
    selectedInterruption = matches[0];
  }

  if (selectedApproval) {
    if (selectedApproval.status === 'pending') {
      if (!approvalRegistry.isActionable(selectedApproval)) {
        return authorityRefusal('The selected approval card has expired; no decision was applied.');
      }
      const resolved = approvalRegistry.resolve(
        selectedApproval.approvalId,
        wantedResolution,
        options.resolver ?? 'harness-resume',
      );
      if (!resolved.ok || !resolved.row) {
        const raced = resolved.row ?? approvalRegistry.get(selectedApproval.approvalId);
        if (raced?.status !== 'resolved' || raced.resolution !== wantedResolution) {
          return authorityRefusal('The selected approval card could not be resolved with this decision.');
        }
        selectedApproval = raced;
      } else {
        selectedApproval = resolved.row;
      }
    } else if (
      selectedApproval.status !== 'resolved'
      || selectedApproval.resolution !== wantedResolution
    ) {
      return authorityRefusal(
        `The selected approval is ${selectedApproval.resolution ?? selectedApproval.status}, not ${wantedResolution}.`,
      );
    }
  }

  const resolvedApprovals: Array<{ tool: string; approvalId: string | null }> = [];
  if (selectedInterruption) {
    const item = selectedInterruption;
    if (options.decision === 'approve' || options.decision === 'approve_with_edits') {
      // EDIT-AND-APPROVE: when the user supplied modifiedArgs (e.g.
      // changed the calendar time in the dashboard / Discord edit
      // modal), substitute those args on the interruption item's
      // rawItem BEFORE calling approve(). The SDK's rawItem.arguments
      // is a JSON string the tool will receive — mutating it here
      // means the tool sees the user's edited values, not the agent's
      // original proposal. Sticky approval is intentionally OFF when
      // edits are supplied: if the agent makes the same call again
      // later, we want it to pause again (the edited args were a
      // one-time correction, not a blanket policy change).
      //
      // For `composio_execute_tool` the user edits the INNER tool
      // payload (the actual Outlook/Salesforce/etc. fields), not the
      // outer { tool_slug, arguments, connected_account_id } wrapper.
      // We rebuild the wrapper around the user's edits so the SDK
      // sees a well-formed function-call payload.
      const editedArgs = options.decision === 'approve_with_edits' ? options.modifiedArgs : undefined;
      if (editedArgs !== undefined) {
        const rawItem = (item as { rawItem?: { name?: string; arguments?: unknown } } | null)?.rawItem;
        if (rawItem && typeof editedArgs === 'string') {
          let nextArgsJson = editedArgs;
          if (rawItem.name === 'composio_execute_tool' && typeof rawItem.arguments === 'string') {
            try {
              const outer = JSON.parse(rawItem.arguments) as Record<string, unknown>;
              // Validate that the inner edit parses as JSON (the UI/
              // dashboard already validated; this is belt-and-suspenders).
              JSON.parse(editedArgs);
              outer.arguments = editedArgs;
              nextArgsJson = JSON.stringify(outer);
            } catch {
              // Couldn't parse the outer envelope or the inner edit;
              // fall back to passing the edited JSON through verbatim.
              // The tool will return a normal validation error and the
              // agent will recover.
              nextArgsJson = editedArgs;
            }
          }
          (rawItem as { arguments: string }).arguments = nextArgsJson;
        }
      }
      // SDK `alwaysApprove` is keyed only by tool name. One exact card must
      // never authorize a sibling/future call with a different payload.
      stateApi.approve(item);
    } else {
      // A rejection is exact too: a later payload deserves its own decision.
      stateApi.reject(item);
    }
    const raw = (item as { rawItem?: { name?: string } } | null)?.rawItem;
    resolvedApprovals.push({
      tool: raw?.name ?? 'unknown',
      approvalId: selectedApproval?.approvalId ?? null,
    });
  }
  for (const resolvedApproval of resolvedApprovals) {
    safeAppend({
      sessionId: options.sessionId,
      turn,
      role: 'system',
      type: 'approval_resolved',
      data: {
        decision: options.decision,
        tool: resolvedApproval.tool,
        approvalId: resolvedApproval.approvalId,
        sticky: false,
        edited: options.decision === 'approve_with_edits',
      },
    });
  }
  safeAppend({
    sessionId: options.sessionId,
    turn,
    role: 'system',
    type: 'run_resumed',
    data: {
      pending: selectedInterruption ? 1 : 0,
      totalPending: pending.length,
      approvalId: selectedApproval?.approvalId ?? null,
      decision: options.decision,
    },
  });
  session.clearInterruptState({ emitEvent: false });

  const toolCounter = new ToolCallsCounter(
    options.toolCallsPerTurn ?? defaultToolCallsPerTurn(),
  );
  const heartbeatBudget = getHarnessBudgetSettings();
  const heartbeatMs = Math.max(60_000, heartbeatBudget.checkInMinutes * 60 * 1000);
  const makeRunner =
    options.makeRunner ??
    (() =>
      new Runner({
        workflowName: 'clementine-harness',
        groupId: options.sessionId,
      }));
  const runner = makeRunner();

  const detachLogHooks = attachEventLogHooks(runner as unknown as RunHooksLike, {
    getSessionId: extractSessionIdFromContext,
    getTurn: () => turn,
  });
  const onToolStart = (): void => {
    toolCounter.increment();
  };
  // T2.1 — see equivalent block in runTurn at the top of this file.
  const useToolWrapper = harnessToolBracketsEnabled();
  if (!useToolWrapper) {
    (runner as unknown as RunHooksLike).on(
      'agent_tool_start',
      onToolStart as (...args: unknown[]) => void,
    );
  }

  const opts: Record<string, unknown> = {
    context: {
      sessionId: options.sessionId,
      turn,
      ...(resumeSourceUserSeq ? { sourceUserSeq: resumeSourceUserSeq } : {}),
    },
    maxTurns: options.maxTurns ?? maxTurnsForRole('orchestrator'),
    // Match runTurn(): SDK 0.11.5 can execute many function tools in
    // parallel. Keep resumed approval runs on the same bounded local
    // concurrency path so a resumed batch cannot spike tool payloads.
    toolExecution: { maxFunctionToolConcurrency: 8 },
    toolNotFoundBehavior: 'return_error_to_model',
    toolErrorFormatter: formatMissingToolForModel,
    // The resumed RunState replays an already-APPROVED (often side-effecting)
    // tool as the run's first act — before any stream event flips yieldedContent.
    // A pre-content stall here must NOT trigger the clean-replay retry, or that
    // approved external write fires a SECOND time (integrity audit #2.1). Surface
    // the stall as an error (the user re-sends) instead of silently duplicating.
    disablePreContentRetry: true,
  };

  try {
    const run = options.runRunner ?? defaultRunRunner;
    // Hoisted so the post-turn auto-credit hook can read the recall runs the
    // resumed turn's tool handlers registered (turnRecallRunIds).
    let resumeCtx: HarnessRunContext | undefined;
    // The SDK's Runner.run accepts a RunState in place of input
    // items — it picks up the conversation from exactly where the
    // interrupt fired. We thread it through the same defaultRunRunner
    // so streaming + completion semantics match runTurn().
    const outcome = await withActiveTurnHeartbeat(
      {
        sessionId: options.sessionId,
        turn,
        budget: heartbeatBudget,
        checkInMs: heartbeatMs,
        stage: 'approval_resume',
      },
      async () => {
        if (useToolWrapper) {
          resumeCtx = {
            sessionId: options.sessionId,
            counter: toolCounter,
            ...(options.runAttemptId ? { runAttemptId: options.runAttemptId } : {}),
            ...(resumeAgentScopeBinding.bound ? { mcpToolScope: resumeAgentScopeBinding.scope } : {}),
            ...(resumeSourceUserSeq ? { sourceUserSeq: resumeSourceUserSeq } : {}),
          };
          return await withHarnessRunContext(
            resumeCtx,
            () => run(
              runner,
              options.agent,
              state as unknown as AgentInputItem[],
              { ...opts, stream: true },
            ),
          ) as RunOutcome;
        }
        return await run(
          runner,
          options.agent,
          state as unknown as AgentInputItem[],
          { ...opts, stream: true },
        );
      },
    );

    if (outcome.hasInterruptions && outcome.serializedState) {
      // Same registry + emit pattern as runTurn; consolidated in
      // registerAndEmitApprovals so both surfaces stay in sync.
      registerAndEmitApprovals(
        { sessionId: options.sessionId, turn },
        session,
        outcome.interruptions ?? [],
      );
      session.saveInterruptState(outcome.serializedState, {
        mcpToolScope: resumeAgentScopeBinding.bound ? resumeAgentScopeBinding.scope : undefined,
      });
      bumpTurnNumber(options.sessionId, turn);
      return { sessionId: options.sessionId, turn, status: 'awaiting_approval' };
    }

    const compactionRewrite = rewriteHistoryWithNativeCompaction(outcome.history, outcome.rawResponses);
    if (compactionRewrite.applied) {
      safeAppend({
        sessionId: options.sessionId,
        turn,
        role: 'system',
        type: 'native_compaction_applied',
        data: {
          previousItems: compactionRewrite.previousItems,
          nextItems: compactionRewrite.nextItems,
          compactionItemsSeen: compactionRewrite.compactionItemsSeen,
          latestCompactionId: compactionRewrite.latestCompactionId,
          latestCompactionBytes: compactionRewrite.latestCompactionBytes,
          preservedAssistantMessage: compactionRewrite.preservedAssistantMessage,
        },
      });
    }

    session.recordTurnResult({
      history: compactionRewrite.history,
      lastResponseId: outcome.lastResponseId,
      turn,
    });
    safeAppend({
      sessionId: options.sessionId,
      turn,
      role: 'system',
      type: 'run_completed',
      data: {
        finalOutputPreview: previewOutput(outcome.finalOutput),
        toolCalls: toolCounter.currentCount,
      },
    });
    // A resumed turn has no memory primer; credit only tool-recorded recall
    // runs. The resumed state's full history stands in for "this turn's"
    // items — any run credited here was recorded during the resume itself.
    // Through the SAME shared seam as the normal path, with correction detection
    // opted out (an approval-resume carries no new user message to correct the
    // prior answer) — so any future post-turn hook reaches the resume path too.
    runPostTurnHooks({
      sessionId: options.sessionId,
      turn,
      userInput: undefined,
      detectCorrection: false,
      recallIds: resumeCtx?.turnRecallRunIds ?? [],
      turnStartedAt: turnStartedAtIso,
      replyText: typeof outcome.finalOutput === 'string'
        ? outcome.finalOutput
        : (() => { try { return JSON.stringify(outcome.finalOutput) ?? ''; } catch { return ''; } })(),
      toolArgTexts: extractFunctionCallArgTexts(Array.isArray(outcome.history) ? outcome.history : []),
    });
    // Chat sessions stay 'active' between turns (inherently multi-turn).
    // Workflow / execution / agent sessions normally flip to 'completed'
    // here BUT not if approvals are still pending — `markStatus('completed')`
    // mid-approval was the root cause behind reaper false-reaps + the
    // status-drift bug surfaced in P0-4. The reaper guards I shipped in
    // v0.5.2 (90s grace + interrupt-state check) are workarounds; this
    // is the actual fix. The conversation_completed event still fires
    // for both branches — that's how the chat dock learns the turn
    // ended; the session staying 'active' just keeps the door open for
    // the next user message or approval resolution.
    if (session.sessionRow.kind !== 'chat' && !approvalRegistry.hasPending(options.sessionId)) {
      session.markStatus('completed');
    }
    bumpTurnNumber(options.sessionId, turn);
    return {
      sessionId: options.sessionId,
      turn,
      status: 'completed',
      finalOutput: outcome.finalOutput,
      toolCalls: toolCounter.currentCount,
    };
  } catch (err) {
    return handleRunError(options.sessionId, turn, session, err, { sourceUserSeq: resumeSourceUserSeq });
  } finally {
    detachLogHooks();
    (runner as unknown as RunHooksLike).off(
      'agent_tool_start',
      onToolStart as (...args: unknown[]) => void,
    );
  }
}

/**
 * Resume after approval AND drive the conversation to completion.
 *
 * resumePendingApproval runs exactly one turn — the SDK call that
 * was paused waiting for approval. That single turn is often not
 * the end: the Orchestrator's structured output typically says
 * `done: false, nextAction: "awaiting_handoff_result"`, meaning
 * "I told the user I have approval and I'm ready to hand off to
 * the Executor to actually do the work." runConversation's
 * auto-continuation loop is what normally drives the follow-up
 * turn(s), but the resume entry point bypassed that.
 *
 * This wrapper:
 *   1. Calls resumePendingApproval for the first turn.
 *   2. If that turn paused again / failed / errored → propagate.
 *   3. If it completed with a decision saying "not done", keep
 *      running runTurn() with the continuation prompt until done,
 *      budgets blow, or another pause fires.
 *
 * Returns RunConversationResult so the caller sees one unified
 * shape whether the resume was one-shot or multi-step.
 */
export async function runConversationFromResume(opts: {
  agent: Agent<any, any>;
  sessionId: string;
  /** Durable outer request attempt, retained across the resumed SDK state and
   * every synthetic continuation that follows it. */
  runAttemptId?: string;
  /** Exact accepted approval-control event when the caller already recorded it. */
  sourceUserSeq?: number;
  approvalId?: string;
  decision: 'approve' | 'reject' | 'approve_with_edits';
  /** Required when decision === 'approve_with_edits'. JSON-encoded args. */
  modifiedArgs?: string;
  resolver?: string;
  maxSteps?: number;
  maxWallClockMs?: number;
  maxTurns?: number;
  toolCallsPerTurn?: number;
  /** Stage 4 — run token ceiling override threaded through the resume family. */
  maxRunTokens?: number;
  makeRunner?: () => Runner;
  runRunner?: RunRunnerFn;
  /** Test injection for promise-shaped completion verification (defaults to judgeObjectiveComplete). */
  judgeFn?: ObjectiveJudgeFn;
  /** @deprecated Raw executor deltas are private. Retained temporarily for API
   * compatibility; terminal delivery occurs through committed public events. */
  onChunk?: (delta: string) => void | Promise<void>;
}): Promise<RunConversationResult> {
  const sourceUserSeq = acceptResumeConversationInput(opts);
  const acceptedSource = acceptedUserEvent(opts.sessionId, sourceUserSeq);
  recordTurnGraphShadow({
    identity: {
      sessionId: opts.sessionId,
      turn: acceptedSource.turn,
      sourceUserSeq,
    },
    surface: 'approval_resume',
  });
  let foregroundReleased = false;
  try {
    // G5b: the resume family rides the same executor-driven spine as fresh
    // turns — an approval resume was the one chat entry still running the
    // legacy order after 7068265d, found while writing the smoke runbook.
    // The compiled input is the decision verb, not user prose: deterministic,
    // content-free, and the shadow recorder above still hashes the real
    // accepted event for telemetry.
    type ResumeSpineCore =
      | { kind: 'dispatched'; result: Awaited<ReturnType<typeof runConversationFromResumeCore>> }
      | { kind: 'reduced'; reduced: ReturnType<typeof reduceStandardConversationTerminal> };
    const spine = await driveChatTurnSpine<ResumeSpineCore>({
      identity: { sessionId: opts.sessionId, turn: acceptedSource.turn, sourceUserSeq },
      input: `approval ${opts.decision}`,
      surface: 'approval_resume',
      policy: getProactivityPolicySnapshot(),
      phases: {
        runCore: async () => {
          const result = await runConversationFromResumeCore({ ...opts, sourceUserSeq });
          if (result.status === 'dispatched') return { kind: 'dispatched', result };
          return {
            kind: 'reduced',
            reduced: reduceStandardConversationTerminal({
              result,
              sourceUserSeq,
              approvalIdHint: opts.approvalId,
            }),
          };
        },
        shouldPublish: (core) => core.kind === 'reduced' && !core.reduced.completedReason,
        publish: (core) => {
          if (core.kind !== 'reduced') return;
          emitRuntimeTerminalEvent(opts.sessionId, core.reduced);
          refreshTerminalWorkingMemory(opts.sessionId);
        },
        delivered: (core) => core.kind === 'dispatched'
          || core.reduced.status === 'completed',
      },
    });
    if (spine.engine === 'legacy_order') {
      // eslint-disable-next-line no-console
      console.warn(
        `[harness] chat turn spine fell back to legacy order (session ${opts.sessionId}, seq ${sourceUserSeq}): ${spine.compileError ?? 'unknown'} — the turn answered; the graph did not drive it`,
      );
    }
    const core = spine.core;
    if (core.kind === 'dispatched') {
      foregroundReleased = true;
      return core.result;
    }
    if (core.reduced.completedReason) return core.reduced;
    foregroundReleased = Boolean(core.reduced.publicPresentation);
    return core.reduced;
  } finally {
    if (foregroundReleased) {
      clearRunInFlightAfterTerminal(opts.sessionId, opts.runAttemptId, sourceUserSeq);
    }
  }
}

async function runConversationFromResumeCore(opts: {
  agent: Agent<any, any>;
  sessionId: string;
  runAttemptId?: string;
  sourceUserSeq: number;
  approvalId?: string;
  decision: 'approve' | 'reject' | 'approve_with_edits';
  modifiedArgs?: string;
  resolver?: string;
  maxSteps?: number;
  maxWallClockMs?: number;
  maxTurns?: number;
  toolCallsPerTurn?: number;
  /** Stage 4 — run token ceiling override threaded through the resume family. */
  maxRunTokens?: number;
  makeRunner?: () => Runner;
  runRunner?: RunRunnerFn;
  judgeFn?: ObjectiveJudgeFn;
  onChunk?: (delta: string) => void | Promise<void>;
}): Promise<RunConversationResult> {
  let budget = getHarnessBudgetSettings();
  let elevated = false;
  let maxSteps = resolveConversationStepCeiling(opts.maxSteps, budget);
  let maxWallMs = opts.maxWallClockMs ?? budget.maxConversationWallMs;
  let maxTurns = opts.maxTurns ?? budget.maxTurns;
  let toolCallsPerTurn = opts.toolCallsPerTurn ?? budget.toolCallsPerTurn;
  let checkInMs = Math.max(60_000, budget.checkInMinutes * 60 * 1000);
  const startedAt = Date.now();
  const activeSourceUserSeq = Number.isSafeInteger(opts.sourceUserSeq) && opts.sourceUserSeq > 0
    ? opts.sourceUserSeq
    : (() => {
    try {
      const attemptSource = getLatestRunAttempt(opts.sessionId)?.sourceUserSeq;
      if (attemptSource && attemptSource > 0) return attemptSource;
      return listEvents(opts.sessionId, { types: ['user_input_received'] }).at(-1)?.seq;
    } catch { return undefined; }
      })();
  let lastCheckInAt = startedAt;
  // Stage 4 — resume-path twin of the primary loop's token-budget window
  // (self-baselined: an approval resume is a fresh user-consented window).
  // The per-run/per-task ceiling override is honored here too — the resume
  // twin dropping it produced 100x false parks/passes (Stage-4 review F3).
  const resumeTokenCeiling = resolveRunTokenCeiling({ override: opts.maxRunTokens, budget });
  const tokenBudgetOn = runTokenBudgetEnforcementEnabled() && resumeTokenCeiling > 0;
  const tokenWindow = tokenBudgetOn
    ? openRunTokenWindow({ sessionId: opts.sessionId, ceiling: resumeTokenCeiling })
    : null;
  // Same durable fan-out record as the primary loop (resume twin).
  if (tokenWindow) recordRunTokenWindow(tokenWindow);

  let lastDecision: OrchestratorDecisionShape | undefined;
  let lastTurn = 0;
  // Stall protection for the continuation loop. The main runConversation loop
  // runs evaluateStructuredDecisionStall after every turn (line ~1379); this
  // resume continuation loop is a SEPARATE execution path that historically had
  // NONE — so after an approval, a narration-deferral / zero-tool false-completion
  // turn was rewarded with a bland CONTINUATION_INPUT nudge instead of being
  // force-corrected (audit 2026-06-16). `resumeContinuationInput` is normally the
  // bland nudge but gets overridden with the stall-forcing message on a hit.
  let stallRetriesUsed = 0;
  let missingReplyRetriesUsed = 0;
  let resumeContinuationInput = CONTINUATION_INPUT;

  // Approval resumes are a second entry into the same conversation machine,
  // so they receive the same one-way standard → long promotion as fresh
  // turns. The long preset's authored 160-step ceiling remains authoritative;
  // this never reintroduces the removed million-hop auto-continue lift.
  const applyResumeElevation = (eventData: Record<string, unknown>): void => {
    const next = getElevatedBudget(budget);
    if (next === budget) return;
    const prev = { maxSteps, maxTurns, toolCallsPerTurn, maxWallMs };
    budget = next;
    maxSteps = opts.maxSteps ?? Math.max(maxSteps, budget.maxConversationSteps);
    maxWallMs = opts.maxWallClockMs ?? Math.max(maxWallMs, budget.maxConversationWallMs);
    maxTurns = opts.maxTurns ?? Math.max(maxTurns, budget.maxTurns);
    toolCallsPerTurn = opts.toolCallsPerTurn ?? Math.max(toolCallsPerTurn, budget.toolCallsPerTurn);
    checkInMs = Math.min(checkInMs, Math.max(60_000, budget.checkInMinutes * 60 * 1000));
    elevated = true;
    safeAppend({
      sessionId: opts.sessionId,
      turn: lastTurn,
      role: 'system',
      type: 'budget_elevated',
      data: {
        ...eventData,
        path: 'resume',
        from: prev,
        to: { maxSteps, maxTurns, toolCallsPerTurn, maxWallMs },
      },
    });
  };

  // Step 1: resume the paused approval.
  const firstResult = await resumePendingApproval({
    agent: opts.agent,
    sessionId: opts.sessionId,
    runAttemptId: opts.runAttemptId,
    sourceUserSeq: activeSourceUserSeq,
    approvalId: opts.approvalId,
    decision: opts.decision,
    modifiedArgs: opts.modifiedArgs,
    resolver: opts.resolver,
    maxTurns,
    toolCallsPerTurn,
    maxRunTokens: opts.maxRunTokens,
    makeRunner: opts.makeRunner,
    runRunner: opts.runRunner,
  });
  lastTurn = firstResult.turn;

  if (activeSourceUserSeq) {
    resolveArtifactRunScopeId(opts.sessionId, opts.sessionId, activeSourceUserSeq);
    const dispatch = finalizePreparedWorkflowDispatchForSource(
      opts.sessionId,
      activeSourceUserSeq,
    );
    if (dispatch) {
      return recordAsyncWorkflowDispatch({
        sessionId: opts.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        receipts: [dispatch.receipt],
        steps: 1,
        lastDecision,
        lastTurn,
      });
    }
  }

  const firstCompletedQuestion = firstResult.status === 'completed'
    ? awaitingUserQuestionThisTurn(opts.sessionId, firstResult.turn)
    : null;
  if (firstCompletedQuestion) {
    commitStandardPauseTerminal({
      sessionId: opts.sessionId,
      sourceUserSeq: activeSourceUserSeq,
      turn: firstResult.turn,
      steps: 1,
      summary: firstCompletedQuestion,
      reply: firstCompletedQuestion,
    });
    return {
      sessionId: opts.sessionId,
      status: 'awaiting_user_input',
      steps: 1,
      lastDecision,
      lastTurn,
    };
  }

  if (firstResult.status !== 'completed') {
    return {
      sessionId: opts.sessionId,
      status: firstResult.status,
      steps: 1,
      lastDecision,
      lastTurn,
      error: firstResult.error,
    };
  }

  let decision = toOrchestratorDecision(firstResult.finalOutput);
  lastDecision = decision ?? lastDecision;

  // If reject was the decision, treat it as "done — we cancelled
  // the action" regardless of what the orchestrator says next.
  if (opts.decision === 'reject') {
    const artifactState = standardArtifactTerminalState(opts.sessionId, activeSourceUserSeq);
    const rejectionReply = 'Okay — I rejected that action. Nothing else was approved.';
    const publicPresentation = commitStandardCancelledTerminal({
      sessionId: opts.sessionId,
      sourceUserSeq: activeSourceUserSeq,
      turn: lastTurn,
      text: rejectionReply,
      legacyReason: 'rejected_by_user',
      metadata: {
        steps: 1,
        ...(artifactState ? artifactVerificationProjection(artifactState) : {}),
      },
    });
    return {
      sessionId: opts.sessionId,
      status: 'completed',
      steps: 1,
      lastDecision: decision ?? undefined,
      lastTurn,
      publicPresentation,
    };
  }

  captureWorkflowStepResultTranscript({
    sessionId: opts.sessionId,
    turn: lastTurn,
    output: firstResult.finalOutput,
  });
  if (hasCapturedWorkflowStepResult(opts.sessionId)) {
    return completeCapturedWorkflowStepResult({
      sessionId: opts.sessionId,
      sourceUserSeq: activeSourceUserSeq,
      turn: lastTurn,
      steps: 1,
      decision,
    });
  }

  // Steps 2..N: same loop semantics as runConversation, but starting
  // from step 2 since the resume covered step 1.
  let stepIndex = 1;
  while (stepIndex < maxSteps) {
    // Done-invariant (resume variant): mirror runConversation — a done:true with
    // a contradictory awaiting_* nextAction must honor the conservative awaiting
    // state, not bank completed. A null decision (unparseable output) still
    // gracefully resolves done.
    let doneStands = !decision || (decision.done
      && decision.nextAction !== 'awaiting_user_input'
      && decision.nextAction !== 'awaiting_approval'
      && decision.nextAction !== 'awaiting_handoff_result');
    if (decision && decision.done && !doneStands) {
      safeAppend({
        sessionId: opts.sessionId,
        turn: lastTurn,
        role: 'system',
        type: 'guardrail_tripped',
        data: {
          kind: 'done_invariant',
          message: `Model emitted done:true with nextAction:${decision.nextAction} — honoring the awaiting state, not banking completed.`,
          nextAction: decision.nextAction,
        },
      });
    }
    if (doneStands) {
      const missingReplyDecision = isCompletedWithoutUserFacingReply(decision) ? decision : null;
      if (
        missingReplyDecision
        && missingReplyRetriesUsed < MAX_MISSING_REPLY_RETRIES
        && stepIndex < maxSteps
      ) {
        missingReplyRetriesUsed += 1;
        safeAppend({
          sessionId: opts.sessionId,
          turn: lastTurn,
          role: 'system',
          type: 'guardrail_tripped',
          data: {
            kind: 'completed_without_reply',
            attempt: missingReplyRetriesUsed,
            maxRetries: MAX_MISSING_REPLY_RETRIES,
            internalSummary: missingReplyDecision.summary,
            path: 'resume',
          },
        });
        resumeContinuationInput = buildMissingReplyRetryMessage(missingReplyDecision, 'resume');
        decision = { ...missingReplyDecision, done: false, nextAction: 'awaiting_handoff_result' };
        doneStands = false;
      }
    }
    if (doneStands) {
      // Render priority on the chat surface: prefer `reply` (user-facing)
      // over `summary` (internal META log). Mirrors the equivalent path
      // in runConversation at line ~286 — without this the resume path
      // leaks the META summary into Discord so the user sees "Resumed
      // the stale-account workflow context, recognized…" instead of the
      // actual reply the model produced.
      const hasReply = decision?.reply && decision.reply.trim();
      const isCompletedAction = decision?.nextAction === 'completed';
      // ALWAYS REPORT BACK (resume variant): a completed turn with no reply but real
      // work done reports what it did instead of the bare fallback.
      const resumeWorkReport = (!hasReply && isCompletedAction)
        ? (() => { try { return synthesizeTurnReport(opts.sessionId, activeSourceUserSeq); } catch { return null; } })()
        : null;
      // The generic floor tells the user to "send that again" — on an
      // approval resume that advice is WRONG (re-sending re-approves, and the
      // registry will answer "already resolved"). Say what actually happened
      // to the decision and give a next step that is safe to take. Live
      // 2026-08-04 (desktop): "approve apr-kmaw" → this floor verbatim.
      const resumeFloor = opts.approvalId
        ? `Your approval of ${opts.approvalId} was applied and the run continued, but I don't have a clean summary of that step. Ask "status" and I'll check the current state — no need to approve again.`
        : MISSING_REPLY_USER_FALLBACK;
      const userVisibleSummary = hasReply
        ? decision!.reply!
        : resumeWorkReport
          ? resumeWorkReport
          : isCompletedAction
            ? resumeFloor
            : decision?.summary;

      // Honest-completion backstop (resume variant): a blocked/error-stub or
      // promise-shaped final reply converts to the honest awaiting_user_input.
      const deliveryObjective = composeResumeDeliveryObjective(opts.sessionId);
      const objectiveJudge = opts.judgeFn ?? judgeObjectiveComplete;
      const delivery: DeliveryVerdict = verifyDeliveredEnabled()
        && !dispatchedBackgroundWorkflowRun(opts.sessionId, lastTurn)
        ? await verifyDelivered(deliveryObjective, userVisibleSummary ?? '', { judgeFn: objectiveJudge })
        : { delivered: true as const, status: 'completed' as const };
      if (!delivery.delivered) {
        const artifactState = standardArtifactTerminalState(opts.sessionId, activeSourceUserSeq);
        const blockedText = publicReplyText(decision?.reply, '')
          || resumeWorkReport
          || 'I could not finish this turn safely. Please tell me how you would like to proceed.';
        const publicPresentation = commitStandardBlockedTerminal({
          sessionId: opts.sessionId,
          sourceUserSeq: activeSourceUserSeq,
          turn: lastTurn,
          text: blockedText,
          legacyReason: 'blocked',
          metadata: {
            steps: stepIndex,
            missingReply: isCompletedAction && !hasReply ? true : undefined,
            blockedReason: (delivery.reason ?? userVisibleSummary ?? '').slice(0, 400),
            ...(delivery.verification ? { verification: delivery.verification } : {}),
            ...(artifactState ? artifactVerificationProjection(artifactState) : {}),
          },
        });
        const goalForBlocked = safeActiveGoal(opts.sessionId);
        if (goalForBlocked) safeAppendGoalLedger(goalForBlocked.id, 'blocked', delivery.reason ?? userVisibleSummary ?? '');
        return {
          sessionId: opts.sessionId,
          status: 'awaiting_user_input',
          steps: stepIndex,
          lastDecision: decision ?? undefined,
          lastTurn,
          publicPresentation,
        };
      }

      return finalizeStandardConversation({
        sessionId: opts.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        turn: lastTurn,
        eventData: {
          steps: stepIndex,
          summary: userVisibleSummary,
          internalSummary: decision?.summary,
          reply: decision?.reply ?? null,
          missingReply: isCompletedAction && !hasReply ? true : undefined,
          delivered: true,
          ...(delivery.verification ? { verification: delivery.verification } : {}),
        },
        result: {
          sessionId: opts.sessionId,
          status: 'completed',
          steps: stepIndex,
          lastDecision: decision ?? undefined,
          lastTurn,
        },
      });
    }
    // Unreachable in practice: a null decision makes doneStands true and returns
    // above. The guard restores TS's non-null narrowing for the handlers below.
    if (!decision) break;
    if (decision.nextAction === 'awaiting_user_input') {
      // Self-serve-first bounce (resume-path twin of the runConversation gate;
      // shared one-shot state, fail-open). See the primary site for rationale.
      try {
        const askText = decision.reply || decision.summary || '';
        const { maybeSelfServeBounce } = await import('../../agents/self-serve-gate.js');
        const { listUsableConnectedToolkits } = await import('../../integrations/composio/client.js');
        const bounceDecision = maybeSelfServeBounce({
          sessionId: opts.sessionId,
          question: askText,
          connectedToolkitSlugs: (await listUsableConnectedToolkits()).map((c) => c.slug),
        });
        if (bounceDecision.bounce && bounceDecision.steer) {
          resumeContinuationInput = bounceDecision.steer;
          lastDecision = decision;
          continue;
        }
      } catch { /* fail-open: deliver the ask */ }
      // Loop reconciliation (resume variant): same YOLO "never stuck" guard as
      // runConversation. If this turn's ask auto-resolved under YOLO standing
      // approval (autonomy_note, no halting event), fall through to run the next
      // turn instead of stranding. Conservative: only when the note exists.
      if (!yoloAutoResolvedAskThisTurn(opts.sessionId, lastTurn)) {
        // Deliver the question on the resume path too (see the runConversation
        // handler): a decision-level awaiting (done:true + awaiting, no
        // ask_user_question tool) emits no awaiting_user_input event, so surfaces
        // can't render the question. Synthesize one if none exists this turn.
        const askedThisTurn = (() => {
          try {
            return listEvents(opts.sessionId, { types: ['awaiting_user_input'] })
              .some((e) => e.turn === lastTurn);
          } catch { return false; }
        })();
        if (!askedThisTurn) {
          const question = (decision.reply?.trim() ? decision.reply : decision.summary)
            ?? 'Could you clarify how you\'d like me to proceed?';
          safeAppend({
            sessionId: opts.sessionId,
            turn: lastTurn,
            role: 'Clem',
            type: 'awaiting_user_input',
            data: { question, source: 'decision_awaiting' },
          });
        }
        const awaitingSummary = (decision.reply?.trim() ? decision.reply : decision.summary)
          ?? 'Could you clarify how you\'d like me to proceed?';
        commitStandardPauseTerminal({
          sessionId: opts.sessionId,
          sourceUserSeq: activeSourceUserSeq,
          turn: lastTurn,
          steps: stepIndex,
          summary: awaitingSummary,
          reply: decision.reply ?? awaitingSummary,
        });
        return {
          sessionId: opts.sessionId,
          status: 'awaiting_user_input',
          steps: stepIndex,
          lastDecision: decision,
          lastTurn,
        };
      }
      safeAppend({
        sessionId: opts.sessionId,
        turn: lastTurn,
        role: 'system',
        type: 'heartbeat',
        data: {
          kind: 'yolo_proceed_reconciled',
          message: 'Ignored a stray nextAction:awaiting_user_input — the approval question already auto-resolved under YOLO standing approval. Continuing.',
        },
      });
      // fall through to the next-turn runTurn below.
    } else if (decision.nextAction === 'awaiting_approval') {
      // Resume-path twin of the runConversationCore fix: a self-reported
      // awaiting_approval with no SDK interrupt emits no approval_requested event,
      // so surfaces render nothing. Synthesize a delivery event if none fired.
      const approvalEmittedThisTurn = (() => {
        try {
          return listEvents(opts.sessionId, { types: ['approval_requested'] })
            .some((e) => e.turn === lastTurn);
        } catch { return false; }
      })();
      if (!approvalEmittedThisTurn) {
        const ask = (decision.reply?.trim() ? decision.reply : decision.summary)
          ?? 'I need your approval before the next step — approve to continue or tell me to stop.';
        safeAppend({
          sessionId: opts.sessionId,
          turn: lastTurn,
          role: 'Clem',
          type: 'awaiting_user_input',
          data: { question: ask, source: 'decision_awaiting_approval' },
        });
      }
      return {
        sessionId: opts.sessionId,
        status: 'awaiting_approval',
        steps: stepIndex,
        lastDecision: decision,
        lastTurn,
      };
    }
    const tokenStatus = tokenWindow ? checkRunTokenWindow(tokenWindow) : null;
    // Single-shot 50%/80% budget warnings — the resume lane keeps the
    // "no silent ceiling" invariant too (Stage-4 review F7).
    if (tokenStatus?.crossedThreshold) {
      safeAppend({
        sessionId: opts.sessionId,
        turn: lastTurn,
        role: 'system',
        type: 'heartbeat',
        data: {
          kind: 'budget_threshold',
          threshold: tokenStatus.crossedThreshold,
          tokensUsedWindow: tokenStatus.usedWindow,
          tokensUsedLifetime: tokenStatus.usedLifetime,
          tokenCeiling: tokenStatus.ceiling,
        },
      });
    }
    if (Date.now() - lastCheckInAt >= checkInMs) {
      lastCheckInAt = Date.now();
      const budgetNote = tokenStatus ? budgetLine(tokenStatus) : null;
      safeAppend({
        sessionId: opts.sessionId,
        turn: lastTurn,
        role: 'system',
        type: 'heartbeat',
        data: {
          kind: 'progress_check_in',
          steps: stepIndex,
          preset: budget.preset,
          unlimited: budget.unlimited,
          summary: lastDecision?.summary ?? null,
          ...(tokenStatus && tokenStatus.ceiling > 0
            ? { tokensUsedWindow: tokenStatus.usedWindow, tokenCeiling: tokenStatus.ceiling, budgetFraction: tokenStatus.fraction }
            : {}),
          message: `Still working (${stepIndex} step${stepIndex === 1 ? '' : 's'} completed${budgetNote ? `; ${budgetNote}` : ''}).`,
        },
      });
    }

    if (maxWallMs > 0 && Date.now() - startedAt > maxWallMs) {
      // Resume path must be SYMMETRIC with the primary loop (2312): emit BOTH the
      // audit event AND the paired conversation_completed(reason='awaiting_continue').
      // The chat dock / console SSE / Discord all treat a bare
      // conversation_limit_exceeded as NON-terminal (they wait for the pair), so a
      // bare emit on a resumed budget-limited turn hangs the surface until its idle/
      // safety timeout. emitLimitExceededWithContinuePrompt restores the pairing.
      emitLimitExceededWithContinuePrompt({
        sessionId: opts.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        turn: lastTurn,
        steps: stepIndex,
        reason: 'wall_clock',
        limitDetail: { maxWallClockMs: maxWallMs },
        lastDecision: decision,
      });
      return {
        sessionId: opts.sessionId,
        status: 'limit_exceeded',
        limitKind: 'wall_clock',
        steps: stepIndex,
        lastDecision: decision,
        lastTurn,
      };
    }

    // Stage 4 — token-budget twin (after wall-clock, same precedence as the
    // primary loop; same paired-event park template).
    if (tokenStatus?.exceeded) {
      emitLimitExceededWithContinuePrompt({
        sessionId: opts.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        turn: lastTurn,
        steps: stepIndex,
        reason: 'token_budget',
        limitDetail: {
          tokensUsedWindow: tokenStatus.usedWindow,
          tokensUsedLifetime: tokenStatus.usedLifetime,
          tokenCeiling: tokenStatus.ceiling,
          baseline: tokenWindow?.baseline ?? 0,
        },
        lastDecision: decision,
      });
      return {
        sessionId: opts.sessionId,
        status: 'limit_exceeded',
        limitKind: 'token_budget',
        steps: stepIndex,
        lastDecision: decision,
        lastTurn,
      };
    }

    stepIndex += 1;
    const turnResult = await runTurn({
      agent: opts.agent,
      sessionId: opts.sessionId,
      input: resumeContinuationInput,
      // Resume continuations are always harness-synthetic, never a user message.
      suppressMemoryCapture: true,
      sourceUserSeq: activeSourceUserSeq,
      runAttemptId: opts.runAttemptId,
      maxTurns,
      toolCallsPerTurn,
      makeRunner: opts.makeRunner,
      runRunner: opts.runRunner,
    });
    lastTurn = turnResult.turn;
    if (activeSourceUserSeq) {
      resolveArtifactRunScopeId(
        opts.sessionId,
        `${opts.sessionId}::turn:${turnResult.turn}`,
        activeSourceUserSeq,
      );
      const dispatch = finalizePreparedWorkflowDispatchForSource(
        opts.sessionId,
        activeSourceUserSeq,
      );
      if (dispatch) {
        return recordAsyncWorkflowDispatch({
          sessionId: opts.sessionId,
          sourceUserSeq: activeSourceUserSeq,
          receipts: [dispatch.receipt],
          steps: stepIndex,
          lastDecision,
          lastTurn,
        });
      }
    }
    // UNATTENDED infra self-heal (parity with runConversation): a transient infra
    // error / tool-timeout on this resumed workflow/background step auto-retries
    // instead of asking an absent human. Budget-bounded in handleRunError.
    if (turnResult.infraAutoRetry) {
      emitInfraAutoRecoverEvent(opts.sessionId, turnResult.turn, turnResult.infraAutoRetry.kind, countInfraAutoRecover(opts.sessionId) + 1);
      resumeContinuationInput = turnResult.infraAutoRetry.directive;
      continue;
    }
    const completedTurnQuestion = turnResult.status === 'completed'
      ? awaitingUserQuestionThisTurn(opts.sessionId, turnResult.turn)
      : null;
    if (completedTurnQuestion) {
      commitStandardPauseTerminal({
        sessionId: opts.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        turn: turnResult.turn,
        steps: stepIndex,
        summary: completedTurnQuestion,
        reply: completedTurnQuestion,
      });
      return {
        sessionId: opts.sessionId,
        status: 'awaiting_user_input',
        steps: stepIndex,
        lastDecision,
        lastTurn,
      };
    }
    if (turnResult.status !== 'completed') {
      return {
        sessionId: opts.sessionId,
        status: turnResult.status,
        steps: stepIndex,
        lastDecision,
        lastTurn,
        error: turnResult.error,
      };
    }
    decision = toOrchestratorDecision(turnResult.finalOutput);
    lastDecision = decision ?? lastDecision;

    captureWorkflowStepResultTranscript({
      sessionId: opts.sessionId,
      turn: turnResult.turn,
      output: turnResult.finalOutput,
    });
    if (hasCapturedWorkflowStepResult(opts.sessionId)) {
      return completeCapturedWorkflowStepResult({
        sessionId: opts.sessionId,
        sourceUserSeq: activeSourceUserSeq,
        turn: turnResult.turn,
        steps: stepIndex,
        decision,
      });
    }

    const missingReplyDecision = isCompletedWithoutUserFacingReply(decision) ? decision : null;
    if (
      missingReplyDecision
      && missingReplyRetriesUsed < MAX_MISSING_REPLY_RETRIES
      && stepIndex < maxSteps
    ) {
      missingReplyRetriesUsed += 1;
      safeAppend({
        sessionId: opts.sessionId,
        turn: turnResult.turn,
        role: 'system',
        type: 'guardrail_tripped',
        data: {
          kind: 'completed_without_reply',
          attempt: missingReplyRetriesUsed,
          maxRetries: MAX_MISSING_REPLY_RETRIES,
          internalSummary: missingReplyDecision.summary,
          path: 'resume',
        },
      });
      resumeContinuationInput = buildMissingReplyRetryMessage(missingReplyDecision, 'resume');
      continue;
    }

    safeAppend({
      sessionId: opts.sessionId,
      turn: turnResult.turn,
      role: 'Clem',
      type: 'conversation_step',
      data: { step: stepIndex, decision: userVisibleStepDecision(decision) },
    });
    // Stall detection for the resume continuation (parity with the main loop at
    // ~1379). A narration-deferral / zero-tool false-completion turn must be
    // force-corrected, not rewarded with the bland nudge. The detected decision
    // is non-terminal (a terminal done/awaiting decision is handled at the top of
    // the next iteration and returns before reaching runTurn), so overriding the
    // NEXT continuation input is what reaches the model.
    const resumeStall = decision
      ? evaluateStructuredDecisionStall({
          decision,
          toolCalls: turnResult.toolCalls ?? 0,
          sessionId: opts.sessionId,
          turn: turnResult.turn,
        })
      : undefined;
    if (resumeStall && stallRetriesUsed < MAX_STALL_RETRIES) {
      stallRetriesUsed += 1;
      safeAppend({
        sessionId: opts.sessionId,
        turn: turnResult.turn,
        role: 'system',
        type: 'stuck_detected',
        data: { signal: resumeStall.signal, ...resumeStall.detail },
      });
      safeAppend({
        sessionId: opts.sessionId,
        turn: turnResult.turn,
        role: 'system',
        type: 'stall_retry_attempted',
        data: {
          signal: resumeStall.signal,
          attempt: stallRetriesUsed,
          maxRetries: MAX_STALL_RETRIES,
          rawOutput: resumeStall.rawOutput,
          path: 'resume',
        },
      });
      const backoffMs = STALL_RETRY_BACKOFF_MS[stallRetriesUsed - 1] ?? 1000;
      if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
      resumeContinuationInput =
        `${buildStallRetryMessage(opts.sessionId, resumeStall)} The tool surface is available in this run; do not ask the user to resend a tool-enabled message. Pick the needed local, shell, web, memory, or external-service tool and call it now.`;
    } else {
      resumeContinuationInput = CONTINUATION_INPUT;
    }

    if (shouldElevateOnStepProgress({
      alreadyElevated: elevated,
      preset: budget.preset,
      explicitMaxSteps: opts.maxSteps !== undefined,
      stepIndex,
      maxSteps,
    })) {
      applyResumeElevation({ reason: 'step_progress', steps: stepIndex });
    }
  }

  // Resume path max-steps exit: same symmetry fix as the wall_clock exit above and
  // the primary loop (2353) — emit the paired conversation_completed so the chat
  // dock / console SSE / Discord settle instead of hanging on a bare limit event.
  emitLimitExceededWithContinuePrompt({
    sessionId: opts.sessionId,
    sourceUserSeq: activeSourceUserSeq,
    turn: lastTurn,
    steps: stepIndex,
    reason: 'max_steps',
    limitDetail: { maxSteps },
    lastDecision,
  });
  return {
    sessionId: opts.sessionId,
    status: 'limit_exceeded',
    limitKind: 'max_steps',
    steps: stepIndex,
    lastDecision,
    lastTurn,
  };
}

// ---------- helpers ----------

/** Consume only the stop this physical turn observed. Exact attempt/run
 * latches are cleared first. A remaining matching latch can only be the
 * legacy session-wide fallback (used by direct runTurn callers that do not
 * own a run-attempt record), so consume that separately without touching
 * another attempt's scoped stop. */
function consumeObservedKill(sessionId: string, target?: KillRequestTarget): void {
  try { clearKill(sessionId, target); } catch { /* best effort */ }
  try {
    if (isKillRequested(sessionId, target)) clearKill(sessionId);
  } catch { /* best effort */ }
}

function isKillBeforeStart(
  sessionId: string,
  turn: number,
  session: HarnessSession,
  sourceUserSeq?: number,
): boolean {
  const target: KillRequestTarget | undefined = sourceUserSeq
    ? { sourceUserSeq }
    : getActiveRunAttempt(sessionId) ?? undefined;
  try {
    assertNotKilled(sessionId, target);
    return false;
  } catch (err) {
    if (!(err instanceof KillRequested)) throw err;
    safeAppend({
      sessionId,
      turn,
      role: 'system',
      type: 'kill_requested',
      data: { reason: 'pre-flight check' },
    });
    session.markStatus('cancelled');
    // The kill has been honored — a kill_switches row is a one-shot "stop
    // what's running", not a permanent session curse. Only respond-bridge
    // surfaces cleared it before (line 104 there); on direct-runConversation
    // surfaces (desktop console, Discord harness) the stale row killed every
    // subsequent message on the session (observed live 2026-06-12).
    consumeObservedKill(sessionId, target);
    return true;
  }
}

/** A Codex OAuth revocation/expiry (HTTP 401 token_revoked) surfaced from the
 *  model call. The token can't recover by retrying — the user must re-auth — so
 *  we surface a clear instruction instead of the raw provider JSON. */
export function isCodexAuthRevoked(err: unknown, message: string): boolean {
  // Auth is genuinely dead only when the refresh token itself was rejected
  // (which latches DEAD inside refreshStoredNativeOAuth) or the error carries a
  // real revoke marker (token_revoked / invalid_grant / refresh_token_reused).
  // A bare model-call 401 is NOT a revoke: streamCodex already force-refreshed
  // and retried it, so reaching here with a marker-less 401 means a transient
  // failure — classify it 'model' so it falls through to normal retryable-error
  // handling instead of permanently bricking auth on a one-off blip.
  //
  // The DEAD latch is a fact about CODEX auth, not about this error: while it
  // is set, every brain's every failure reaches here, and an unconditional
  // short-circuit rebrands unrelated errors (a BYO Together 402, a GLM 5xx) as
  // "Codex sign-in expired" — terminal, real cause masked (observed live
  // 2026-07-07: GLM run hard-failed with the Codex re-auth message while the
  // actual error was a Together credit-limit 402). Only let the latch decide
  // when the error itself is auth-shaped; anything else falls through to
  // normal classification and stays recoverable.
  const status = (err as { status?: number } | null)?.status;
  const authShaped =
    status === 401
    || status === 403
    || /codex|token_revoked|invalid_grant|refresh_token|oauth/i.test(message);
  if (isCodexAuthDead() && authShaped) return true;
  return classifyCodexAuthError({ message, status, source: 'model' }) === 'terminal';
}

// Transient model/codex error kinds where switching to a DIFFERENT brain can
// actually recover (overload / 5xx / timeout / rate-limit on a different provider).
// NOT mcp.* (a down MCP server isn't fixed by changing brain).
const TRANSIENT_FALLOVER_KINDS = new Set<string>([
  'model.overloaded', 'model.rate_limited', 'model.http_5xx', 'model.transport_timeout',
  'codex.http_5xx', 'codex.sse_truncated', 'codex.wall_clock', 'codex.transport_timeout',
  // An unclassified terminal failure: try SWITCHING brains before dead-ending — a different
  // brain often succeeds where this one hit an unexpected error (brain-switching-when-needed).
  'model.unknown',
]);

// ── Unattended infra self-heal ────────────────────────────────────────────────
// A workflow step or background task runs with NO human present, so an infra
// "retry/switch/stop" ask can strand it forever. In an unattended run we
// AUTO-RETRY the same failed
// call a bounded number of times, then FAIL honestly — never awaiting_user_input,
// never fake success. Interactive chat/Discord/console keep the ask verbatim.
// Kill-switch CLEMMY_UNATTENDED_AUTO_RECOVER=off restores the ask everywhere.
const MAX_INFRA_AUTO_RECOVER = 2;
// Attended lanes (interactive chat/Discord/console) get ONE silent auto-retry
// before the "Retry/Switch/Stop" ask — a 30s transport blip mid-flow should not
// interrupt the user (live 2026-07-08). A second failure still asks (a human IS
// here). Unattended keeps its 2 auto-retries then fails honestly.
const ATTENDED_QUIET_RETRY_BUDGET = 1;

function unattendedAutoRecoverEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_UNATTENDED_AUTO_RECOVER', 'on') ?? 'on').toLowerCase() !== 'off';
}

/** An unattended run has no human to answer an infra ask. Signalled by the run
 *  session id prefix (`workflow:` / `background:`) — the robust allocation-time
 *  signal — with an execution-kind fallback. Interactive sessions are attended,
 *  UNLESS the turn currently failing was daemon-driven: a synthetic directive
 *  (a proactive report-back relay) runs ON the chat session, and asking the
 *  user "retry / switch / stop?" about a turn they never sent is pure noise —
 *  the passive outcome staging already guarantees the content (live
 *  2026-08-04: a blocked task's report relay hit a transient model error and
 *  handed the user an infra question). Fail quiet; the deferred-report queue
 *  and the passive turn remain the floor. */
function isUnattendedSession(sessionId: string): boolean {
  if (sessionId.startsWith('workflow:') || sessionId.startsWith('background:')) return true;
  try {
    if (getSession(sessionId)?.kind === 'execution') return true;
  } catch { return false; }
  try {
    const lastInput = listEvents(sessionId, { types: ['user_input_received'], desc: true, limit: 1 })[0];
    return (lastInput?.data as { synthetic?: boolean } | undefined)?.synthetic === true;
  } catch { return false; }
}

function countInfraAutoRecover(sessionId: string): number {
  try { return listEvents(sessionId, { types: ['infra_auto_recover'] }).length; } catch { return 0; }
}

type InfraRecoveryDecision = 'ask' | 'auto_retry' | 'exhausted';

/**
 * For an infra error about to prompt "retry/switch/stop":
 *  - UNATTENDED (workflow/background): AUTO_RETRY up to MAX_INFRA_AUTO_RECOVER,
 *    then EXHAUSTED (fail honestly — no human to ask).
 *  - ATTENDED (interactive): ONE silent AUTO_RETRY, then ASK (a human is here).
 *  The unattended lane's auto-retry is gated by its own kill-switch.
 */
function decideInfraRecovery(sessionId: string): InfraRecoveryDecision {
  if (isUnattendedSession(sessionId)) {
    if (!unattendedAutoRecoverEnabled()) return 'ask';
    return countInfraAutoRecover(sessionId) < MAX_INFRA_AUTO_RECOVER ? 'auto_retry' : 'exhausted';
  }
  // Attended: quiet-retry once, then ask — never 'exhausted' (the user answers).
  return countInfraAutoRecover(sessionId) < ATTENDED_QUIET_RETRY_BUDGET ? 'auto_retry' : 'ask';
}

/** The self-heal directive fed back into the loop — synthesizes what a human
 *  typing "Retry" produces (re-issue the failed call via retry_context). Works
 *  for both lanes: an attended quiet-retry and an unattended auto-recovery. */
function buildInfraRetryDirective(kind: string): string {
  return [
    `The previous step hit a transient backend error (${kind}). Recover automatically — retry the SAME failed call now.`,
    'Re-issue it exactly as before, using your retry_context (the last tool_called before the error). Do NOT ask the user, do NOT restart from the plan top, do NOT switch objective.',
    'If it fails again I will surface the choice.',
  ].join(' ');
}

// ── Stranded-tool reunification ───────────────────────────────────────────────
// A turn can DIE on an infra error (transport timeout) while a long tool call is
// still IN FLIGHT — live 2026-07-08: a Discord turn died on model.transport_timeout
// while its run_batch executed 20+ min under provider throttle; the batch finished
// 7/8 but the dead turn never reported it ("only 1 email sent" confusion). We
// register the in-flight call at death and, once it completes, fire a follow-up
// report turn so the session self-reports — attended and unattended.

/** An orphan whose tool completed after its turn died — max age before we give up
 *  waiting (a never-completing tool must not linger forever). */
const ORPHAN_TOOL_MAX_AGE_MS = 30 * 60_000;

/**
 * Register any tool call left IN FLIGHT (a `tool_called` this turn with no matching
 * `tool_returned`) when the turn dies on an infra error. Idempotent: an already-
 * registered callId is not re-recorded, and a surviving turn never calls this — so
 * there is no double-fire. Best-effort; never throws into the death path.
 */
export function recordOrphanedToolInFlight(sessionId: string, turn: number): void {
  try {
    const events = listEvents(sessionId);
    const returned = new Set<string>();
    const alreadyRepresented = new Set<string>();
    for (const e of events) {
      if (e.type === 'tool_returned') {
        const cid = String((e.data as { callId?: unknown } | undefined)?.callId ?? '');
        if (cid) returned.add(cid);
      } else if (e.type === 'orphaned_tool_inflight' || e.type === 'orphaned_tool_reported') {
        const cid = String((e.data as { callId?: unknown } | undefined)?.callId ?? '');
        if (cid) alreadyRepresented.add(cid);
      }
    }
    const turnCalls = events.filter((e) => e.type === 'tool_called' && e.turn === turn);
    // For native SDK gateway calls, the provider-level event and the inner MCP
    // transport event describe one execution but have different call IDs. If
    // the outer stream dies, only the transport callback is guaranteed to emit
    // its eventual return, so prefer one in-flight mirror per matching unresolved
    // canonical call. Pairing only unresolved canonicals is important when an
    // earlier identical call already returned before a later live call started.
    const unresolvedPairs = pairTransportMirrorToolCalls(turnCalls, returned);
    const allPairs = pairTransportMirrorToolCalls(turnCalls);
    for (const e of turnCalls) {
      const data = (e.data ?? {}) as { accounting?: unknown; callId?: unknown; tool?: unknown };
      const callId = String(data.callId ?? '');
      const tool = String(data.tool ?? '');
      if (!callId || returned.has(callId) || alreadyRepresented.has(callId)) continue;

      if (data.accounting === 'top_level' && unresolvedPairs.canonicalToMirrorCallId.has(callId)) {
        continue;
      }
      if (data.accounting === 'transport_mirror') {
        const unresolvedCanonicalId = unresolvedPairs.mirrorToCanonicalCallId.get(callId);
        const canonicalId = unresolvedCanonicalId ?? allPairs.mirrorToCanonicalCallId.get(callId);
        // A late mirror must not create a second marker after the canonical was
        // already registered/reported, nor resurrect a call the canonical return
        // already resolved.
        if (
          canonicalId
          && (alreadyRepresented.has(canonicalId) || (!unresolvedCanonicalId && returned.has(canonicalId)))
        ) continue;
      }
      safeAppend({
        sessionId, turn, role: 'system', type: 'orphaned_tool_inflight',
        data: { callId, toolName: tool, at: new Date().toISOString() },
      });
      alreadyRepresented.add(callId);
    }
  } catch { /* best-effort — a death path must never throw */ }
}

/** Latest logical provider-level tool call for exact retry context. The eventlog
 * query excludes mirrors before LIMIT, so no volume of later audit rows can hide
 * the provider arguments recovery needs. */
function latestCanonicalToolCall(sessionId: string): EventRow | undefined {
  return getLatestCanonicalTopLevelToolEvent(sessionId);
}

export interface OrphanedToolReport {
  callId: string;
  toolName: string;
  /** The follow-up system-turn directive: "your <tool> completed — report it now". */
  directive: string;
}

/**
 * A non-destructive view of completed stranded tools. The caller must first
 * durably retain `reports`, then call `acknowledge`. Passing a subset lets a
 * restarted outbox acknowledge only the exact logical calls it owns, without
 * consuming newer completions from the same session.
 */
export interface OrphanedToolCompletionClaim {
  reports: OrphanedToolReport[];
  sourceCallIds: string[];
  expiredCallIds: string[];
  acknowledge: (logicalCallIds?: readonly string[]) => void;
}

/** One-line result summary for the report directive — a run_batch's ledger counts
 *  or a plain tool_returned preview. */
function summarizeOrphanCompletion(toolName: string, returnedData: unknown, batchData: unknown): string {
  if (batchData && typeof batchData === 'object') {
    const b = batchData as { total?: number; succeeded?: number; failed?: number; halted?: boolean; batchId?: string };
    return `${b.succeeded ?? 0}/${b.total ?? 0} succeeded${b.failed ? `, ${b.failed} failed` : ''}${b.halted ? ' (HALTED)' : ''}${b.batchId ? ` — ledger ${b.batchId}` : ''}`;
  }
  const d = (returnedData ?? {}) as { preview?: unknown; result?: unknown; error?: unknown };
  const text = typeof d.preview === 'string'
    ? d.preview
    : typeof d.result === 'string'
      ? d.result
      : typeof d.error === 'string'
        ? d.error
        : '';
  return text ? text.slice(0, 400) : `${toolName} completed`;
}

function buildOrphanReportDirective(toolName: string, resultSummary: string): string {
  return [
    `Your \`${toolName}\` call from an earlier turn — interrupted by a transient error before it could report — has now COMPLETED.`,
    `Result: ${resultSummary}`,
    'Report the actual outcome to the user NOW (what really happened — how many items succeeded/failed), since the interrupted turn never posted it. Do not re-run the call.',
  ].join('\n');
}

/**
 * Inspect completed stranded tools without consuming their source evidence.
 * `acknowledge` is idempotent and writes the existing
 * `orphaned_tool_reported` marker only after the caller has durably accepted
 * ownership. This closes the crash gap between event-log discovery and the
 * report outbox.
 */
export function claimOrphanedToolCompletions(sessionId: string): OrphanedToolCompletionClaim {
  const reports: OrphanedToolReport[] = [];
  const sourceCallIds: string[] = [];
  const expiredCallIds: string[] = [];
  let events: EventRow[];
  try { events = listEvents(sessionId); } catch {
    return {
      reports,
      sourceCallIds,
      expiredCallIds,
      acknowledge: () => {},
    };
  }
  const pairs = pairTransportMirrorToolCalls(events);
  const reported = new Set(
    events.filter((e) => e.type === 'orphaned_tool_reported')
      .map((e) => String((e.data as { callId?: unknown } | undefined)?.callId ?? '')),
  );
  const returnByCallId = new Map<string, EventRow>();
  for (const event of events) {
    if (event.type !== 'tool_returned') continue;
    const callId = String((event.data as { callId?: unknown } | undefined)?.callId ?? '');
    if (callId) returnByCallId.set(callId, event);
  }
  const orphanMarkers = events
    .filter((e) => e.type === 'orphaned_tool_inflight')
    .map((e) => ({
      callId: String((e.data as { callId?: unknown } | undefined)?.callId ?? ''),
      toolName: String((e.data as { toolName?: unknown } | undefined)?.toolName ?? ''),
      atMs: Date.parse(e.createdAt),
      turn: e.turn,
    }))
    .filter((o) => o.callId);
  const groups = new Map<string, { logicalCallId: string; markers: typeof orphanMarkers }>();
  for (const marker of orphanMarkers) {
    const logicalCallId = pairs.mirrorToCanonicalCallId.get(marker.callId) ?? marker.callId;
    const group = groups.get(logicalCallId) ?? { logicalCallId, markers: [] };
    group.markers.push(marker);
    groups.set(logicalCallId, group);
  }

  for (const group of groups.values()) {
    const mirrorCallId = pairs.canonicalToMirrorCallId.get(group.logicalCallId);
    const linkedCallIds = new Set([
      group.logicalCallId,
      ...(mirrorCallId ? [mirrorCallId] : []),
      ...group.markers.map((marker) => marker.callId),
    ]);
    // A canonical marker and a late transport marker are one logical orphan.
    // If any identity in the group was reported, never fire it again.
    if ([...linkedCallIds].some((callId) => reported.has(callId))) continue;

    const orphan = group.markers[0];
    const atMs = Math.min(...group.markers.map((marker) => marker.atMs).filter(Number.isFinite));
    const returnCandidates = [
      ...(mirrorCallId ? [mirrorCallId] : []),
      ...group.markers.map((marker) => marker.callId),
      group.logicalCallId,
    ];
    const returnedEvent = returnCandidates
      .map((callId) => returnByCallId.get(callId))
      .find((event): event is EventRow => Boolean(event));
    const batchDone = orphan.toolName === 'run_batch'
      ? events.filter((e) => e.type === 'batch_completed' && Date.parse(e.createdAt) >= atMs).slice(-1)[0]
      : undefined;
    if (returnedEvent || batchDone) {
      const summary = summarizeOrphanCompletion(orphan.toolName, returnedEvent?.data, batchDone?.data);
      reports.push({ callId: group.logicalCallId, toolName: orphan.toolName, directive: buildOrphanReportDirective(orphan.toolName, summary) });
      sourceCallIds.push(group.logicalCallId);
      continue;
    }
    if (Number.isFinite(atMs) && Date.now() - atMs > ORPHAN_TOOL_MAX_AGE_MS) {
      expiredCallIds.push(group.logicalCallId);
    }
  }

  return {
    reports,
    sourceCallIds,
    expiredCallIds,
    acknowledge: (logicalCallIds = [...sourceCallIds, ...expiredCallIds]) => {
      const selected = new Set(logicalCallIds);
      if (selected.size === 0) return;
      // Re-read at acknowledgement time so a retry after a partial write or a
      // concurrent acknowledgement never appends a second marker.
      const currentReported = new Set(
        listEvents(sessionId, { types: ['orphaned_tool_reported'] })
          .map((event) => String((event.data as { callId?: unknown } | undefined)?.callId ?? '')),
      );
      for (const group of groups.values()) {
        if (!selected.has(group.logicalCallId)) continue;
        const mirrorCallId = pairs.canonicalToMirrorCallId.get(group.logicalCallId);
        const linkedCallIds = new Set([
          group.logicalCallId,
          ...(mirrorCallId ? [mirrorCallId] : []),
          ...group.markers.map((marker) => marker.callId),
        ]);
        if ([...linkedCallIds].some((callId) => currentReported.has(callId))) continue;
        const expired = expiredCallIds.includes(group.logicalCallId);
        for (const marker of group.markers) {
          appendEvent({
            sessionId,
            turn: marker.turn,
            role: 'system',
            type: 'orphaned_tool_reported',
            data: {
              callId: marker.callId,
              logicalCallId: group.logicalCallId,
              toolName: marker.toolName,
              ...(expired ? { expired: true } : {}),
            },
          });
          currentReported.add(marker.callId);
        }
      }
    },
  };
}

/**
 * Legacy consuming facade. New production handoffs should use
 * `claimOrphanedToolCompletions`, durably store the reports, then acknowledge.
 * Keeping this export avoids changing direct callers that already own their
 * own durability boundary.
 */
export function drainOrphanedToolCompletions(sessionId: string): OrphanedToolReport[] {
  const claim = claimOrphanedToolCompletions(sessionId);
  claim.acknowledge();
  return claim.reports;
}

/** Record the self-heal in the trace (attempt is 1-based). Emitted by the loop
 *  when the retry actually re-enters, so the count reflects real retries. */
function emitInfraAutoRecoverEvent(sessionId: string, turn: number, kind: string, attempt: number): void {
  safeAppend({
    sessionId, turn, role: 'system', type: 'infra_auto_recover',
    data: { kind, attempt, max: MAX_INFRA_AUTO_RECOVER, source: 'infra_auto_recover' },
  });
}

/** Honest terminal failure for an unattended run whose auto-recovery budget is
 *  spent. The workflow runner's step-failed retry/repair machinery escalates from
 *  this run_failed — never an ask, never a fake completion. */
function emitInfraUnrecovered(sessionId: string, turn: number, kind: string, error: string): void {
  safeAppend({
    sessionId, turn, role: 'system', type: 'run_failed',
    data: { error: error || `Unrecovered transient backend error (${kind}).`, reason: 'infra_transient_unrecovered', kind },
  });
}

/**
 * Emit the infra-error "retry / switch / stop" ask (the F4-twin recovery). Single
 * source of truth so both the direct path (handleRunError) and the
 * fallover-exhausted path (runConversation) produce the byte-identical ask with
 * the same retry_context capture.
 */
function emitInfraTransientAsk(
  sessionId: string,
  turn: number,
  kind: string,
  userMessage: string,
  operatorMessage: string | undefined,
  rawMessage: string,
): void {
  const userMsg = userMessage || 'A backend error interrupted this turn.';
  let retryContext: Record<string, unknown> | null = null;
  try {
    const tc = latestCanonicalToolCall(sessionId);
    if (tc) {
      const tcData = tc.data as { tool?: string; arguments?: string; callId?: string } | undefined;
      if (tcData?.tool) {
        retryContext = {
          failed_tool: tcData.tool,
          failed_args: tcData.arguments ?? null,
          failed_call_id: tcData.callId ?? null,
          failed_turn: tc.turn ?? turn,
        };
      }
    }
  } catch { /* best-effort */ }
  safeAppend({
    sessionId,
    turn,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question: `${userMsg} Should I retry the same call, switch approach, or stop here?`,
      options: ['Retry', 'Switch approach', 'Stop'],
      source: 'infra_error_recovery',
      boundaryKind: kind,
      operatorMessage: clip(operatorMessage ?? rawMessage, 400),
      retry_context: retryContext,
    },
  });
}

function handleRunError(
  sessionId: string,
  turn: number,
  session: HarnessSession,
  err: unknown,
  opts: { deferInfraAsk?: boolean; sourceUserSeq?: number } = {},
): RunTurnResult {
  // A kill that lands while a tool call is in flight throws KillRequested
  // INSIDE the SDK's tool execution, and the SDK re-wraps it as a plain
  // Error: "Failed to run function tools: KillRequested: session X has a
  // pending kill request" — the same wrapping that hid ToolTimeout
  // (v0.5.21.1) and ToolGuardrailEscalated (2026-06-01). A bare instanceof
  // misses it and the raw string got dumped at the user with "Didn't
  // finish" instead of a clean Stopped (observed live 2026-06-12,
  // stale-event regression). Match the wrapped form too.
  const wrappedKill =
    !(err instanceof KillRequested)
    && err instanceof Error
    && /KillRequested: session \S+ has a pending kill request/.test(err.message);
  if (err instanceof KillRequested || wrappedKill) {
    safeAppend({
      sessionId,
      turn,
      role: 'system',
      type: 'kill_requested',
      data: { reason: 'during run' },
    });
    session.markStatus('cancelled');
    // One-shot: the kill stopped this run; clear the latch so the user's
    // next message on the session isn't assassinated by the stale row.
    const target: KillRequestTarget | undefined = opts.sourceUserSeq
      ? { sourceUserSeq: opts.sourceUserSeq }
      : getActiveRunAttempt(sessionId) ?? undefined;
    consumeObservedKill(sessionId, target);
    bumpTurnNumber(sessionId, turn);
    return { sessionId, turn, status: 'killed' };
  }
  if (err instanceof ToolCallsLimitExceeded) {
    safeAppend({
      sessionId,
      turn,
      role: 'system',
      type: 'guardrail_tripped',
      data: { kind: 'tool_calls_limit', limit: err.limit },
    });
    session.markStatus('failed');
    bumpTurnNumber(sessionId, turn);
    return { sessionId, turn, status: 'limit_exceeded', error: err.message };
  }
  // The OpenAI/Codex Agents Runner throws MaxTurnsExceededError when a turn hits
  // its maxTurns budget. That escaped to the generic terminal run_failed below —
  // a dead-end that strands the session with no recourse. Treat it as a graceful
  // CAP (like ToolCallsLimitExceeded and the Claude-SDK limitHit path): a soft
  // limit_exceeded the caller can offer "continue" on. Match the class by name
  // AND the wrapped message (the SDK re-wraps thrown errors). Kill-switch =off.
  const maxTurnsHit =
    (err instanceof Error && err.name === 'MaxTurnsExceededError')
    || (err instanceof Error && /max turns \(\d+\) exceeded|maximum number of turns/i.test(err.message));
  if (maxTurnsHit && (getRuntimeEnv('CLEMMY_MAX_TURNS_CONTINUE', 'on') ?? 'on').toLowerCase() !== 'off') {
    safeAppend({ sessionId, turn, role: 'system', type: 'guardrail_tripped', data: { kind: 'max_turns' } });
    session.markStatus('failed');
    bumpTurnNumber(sessionId, turn);
    return {
      sessionId,
      turn,
      status: 'limit_exceeded',
      error: 'Reached the per-turn step budget before finishing — say "continue" to pick up where it left off.',
    };
  }
  // A mutating tool was called with byte-identical args past the escalate
  // threshold — an unrecoverable loop. End the turn cleanly instead of
  // letting the model spin (the 84×/3-min workflow_run hang). The SDK
  // RE-WRAPS our throw as "Failed to run function tools: ToolGuardrailEscalated:
  // …", which slips past a bare `instanceof` check and dumped the raw
  // exception at the user (observed live 2026-06-01). Match the wrapped form
  // too, and surface a plain-language, actionable message — never the raw
  // "Failed to run function tools" string.
  const escalated =
    err instanceof ToolGuardrailEscalated
      ? err
      : err instanceof Error
          && /ToolGuardrailEscalated|tool-call guardrail escalated/.test(err.message)
        ? err
        : null;
  if (escalated) {
    const decision = escalated instanceof ToolGuardrailEscalated ? escalated.decision : undefined;
    const loopedTool =
      decision?.toolName
      ?? escalated.message.match(/([a-z_]+) called \d+× with IDENTICAL/i)?.[1]
      ?? 'a tool';
    if (decision) {
      safeAppend({
        sessionId,
        turn,
        role: 'system',
        type: 'guardrail_tripped',
        data: {
          kind: 'tool_call_guardrail',
          action: 'escalate',
          rule: decision.rule,
          toolName: decision.toolName,
          count: decision.count,
          reason: decision.reason,
        },
      });
    }
    session.markStatus('failed');
    bumpTurnNumber(sessionId, turn);
    const friendly =
      `I stopped because I kept calling \`${loopedTool}\` with the same arguments and wasn't making progress — `
      + `repeating it identically won't change the result, so I cut it off rather than spin. `
      + `Tell me how you'd like to adjust (different parameters, a different tool/approach, or any detail I was missing) and I'll pick it back up.`;
    return { sessionId, turn, status: 'limit_exceeded', error: friendly };
  }

  // v0.5.20 Bug I — route ToolTimeout through the same F4 ask-user
  // pattern as BoundaryError infra-kinds. Observed in the stream-timeout regression:
  // run_worker (parent's sub-agent fan-out for parallel LinkedIn
  // lookups) hit 60s default timeout because the worker did
  // firecrawl_search + scrape — easily >60s. Without this branch,
  // ToolTimeout bubbled all the way to run_failed and killed the
  // session. With it, the user sees "tool X timed out — retry?"
  // and can choose to retry (with v0.5.20 Bug I increased timeouts)
  // or stop. Same retry_context capture as Bug C so the model gets
  // the failed call args back on the next turn.
  // v0.5.21.1 — also catch the SDK-wrapped envelope. The SDK
  // re-throws our ToolTimeout inside a UserError with the message:
  //   "Failed to run function tools: ToolTimeout: tool X timed out after Yms"
  // The instanceof check fails on that wrapping. Verified 2026-05-25
  // Plan-timeout regression: draft_plan timed out → run_failed instead of the
  // Retry card. Match by message pattern as a second-class catch.
  const wrappedToolTimeoutMatch = (!(err instanceof ToolTimeout) && err instanceof Error)
    ? err.message.match(/ToolTimeout: tool (\S+) timed out after (\d+)ms/)
    : null;
  if (err instanceof ToolTimeout || wrappedToolTimeoutMatch) {
    const toolMatch = err instanceof ToolTimeout
      ? err.message.match(/tool (\S+) timed out after (\d+)ms/)
      : wrappedToolTimeoutMatch;
    const toolName = toolMatch?.[1] ?? 'unknown';
    const timeoutMs = toolMatch?.[2] ?? '?';
    let retryContext: Record<string, unknown> | null = null;
    try {
      const tc = latestCanonicalToolCall(sessionId);
      if (tc) {
        const tcData = tc.data as { tool?: string; arguments?: string; callId?: string } | undefined;
        if (tcData?.tool) {
          retryContext = {
            failed_tool: tcData.tool,
            failed_args: tcData.arguments ?? null,
            failed_call_id: tcData.callId ?? null,
            failed_turn: tc.turn ?? turn,
          };
        }
      }
    } catch { /* best-effort */ }
    // UNATTENDED self-heal: retry the timed-out call (bounded) or fail honestly
    // instead of asking a human who isn't there.
    const infraDecision = decideInfraRecovery(sessionId);
    if (infraDecision === 'auto_retry') {
      bumpTurnNumber(sessionId, turn);
      return { sessionId, turn, status: 'failed', error: normalizeError(err), infraAutoRetry: { kind: 'tool.timeout', directive: buildInfraRetryDirective('tool.timeout') } };
    }
    recordOrphanedToolInFlight(sessionId, turn);
    if (infraDecision === 'exhausted') {
      emitInfraUnrecovered(sessionId, turn, 'tool.timeout', normalizeError(err));
      session.markStatus('failed');
      bumpTurnNumber(sessionId, turn);
      return { sessionId, turn, status: 'failed', error: normalizeError(err) };
    }
    safeAppend({
      sessionId,
      turn,
      role: 'Clem',
      type: 'awaiting_user_input',
      data: {
        question:
          `The \`${toolName}\` tool timed out after ${timeoutMs}ms. Should I retry (the same call), switch approach, or stop here?`,
        options: ['Retry', 'Switch approach', 'Stop'],
        source: 'infra_error_recovery',
        boundaryKind: 'tool.timeout',
        operatorMessage: clip(normalizeError(err), 400),
        retry_context: retryContext,
      },
    });
    bumpTurnNumber(sessionId, turn);
    return { sessionId, turn, status: 'awaiting_user_input', error: normalizeError(err) };
  }

  const message = normalizeError(err);

  // A raw provider error thrown LATE in a model stream (after content was
  // committed, so resilient-model re-throws it raw) arrives here as a plain
  // object — NOT a BoundaryError — and used to dead-end at the terminal
  // run_failed below ("Something went wrong: [object Object]"). If it classifies
  // as a transient infra failure (429/529/5xx/timeout), wrap it as a BoundaryError
  // so the SAME ask-user "retry / switch / stop" recovery fires — turning a
  // crash into a recoverable prompt. Best-effort; a non-transient/unknown error
  // falls through to the normalized (now readable) terminal run_failed.
  if (!(err instanceof BoundaryError)) {
    try {
      const cls = classifyModelError(err);
      const transientModelKinds = new Set(['model.overloaded', 'model.rate_limited', 'model.http_5xx', 'model.transport_timeout']);
      if (cls.retryable && transientModelKinds.has(cls.kind)) {
        err = BoundaryError.from(err, {
          kind: cls.kind,
          retryable: true,
          userMessage: 'The model runtime is temporarily unavailable.',
        });
      } else if (typeof cls.status === 'number' && !cls.isAuth && !isCodexAuthRevoked(err, message)) {
        // A2#3 — an unhandled MODEL-BACKEND HTTP error (a non-401/403/429/5xx status the
        // classifier didn't recognize, e.g. a 4xx quota/policy code) would otherwise dead-end
        // at the terminal run_failed below (a hard crash the user can't recover from without
        // re-typing). Wrap it as recoverable model.unknown so the SAME path fires: on a
        // fallover-capable surface the brain is SWITCHED first (model.unknown is in
        // TRANSIENT_FALLOVER_KINDS), and if every brain is exhausted the user gets the
        // "retry / switch / stop" ask with the session left ACTIVE. Scoped to errors that
        // carry an HTTP status (genuine backend failures) so a non-model code bug still
        // fails honestly. NOT auth — that keeps its own re-auth path below.
        err = BoundaryError.from(err, {
          kind: 'model.unknown',
          retryable: true,
          userMessage: 'The model runtime returned an unexpected error.',
        });
      }
    } catch { /* classification is best-effort — fall through to normal handling */ }
  }

  // v0.5.19 Bug C fix — Codex 5xx / SSE truncation / MCP unavailable
  // surfaced as silent `run_failed`. The session died and the user
  // saw "Session failed" with no recourse — couldn't retry without
  // re-typing the whole prompt. F4 covers MODEL stalls (prose+no
  // tools); this is the infra-error twin: a transient backend failure
  // is exactly when "ask the user what to do" is the right answer.
  if (err instanceof BoundaryError) {
    const askUserKinds = new Set<string>([
      'codex.http_5xx',
      'codex.sse_truncated',
      'codex.wall_clock',
      'codex.transport_timeout',
      'mcp.server_unavailable',
      // Provider-agnostic model boundary (Claude / BYO) transient failures —
      // the late-stream-throw class that produced the [object Object] dead-end.
      'model.overloaded',
      'model.rate_limited',
      'model.http_5xx',
      'model.transport_timeout',
      // Unclassified terminal failure — recoverable ask (retry/switch/stop) instead of a
      // dead session; brain-switch is tried first via the deferInfraAsk path below.
      'model.unknown',
    ]);
    if (askUserKinds.has(err.kind)) {
      // W1a chat step-boundary fallover: if the caller can fall over to another
      // brain AND this is a transient kind that switching can fix, DEFER the ask —
      // return the kind so runConversation tries the next brain first and only
      // emits the ask if every brain is exhausted. Otherwise: today's behavior
      // verbatim (emit the F4-twin "retry/switch/stop" ask, session stays active).
      if (opts.deferInfraAsk && TRANSIENT_FALLOVER_KINDS.has(err.kind)) {
        bumpTurnNumber(sessionId, turn);
        return {
          sessionId, turn, status: 'awaiting_user_input', error: message,
          infraTransientKind: err.kind, infraTransientUserMessage: err.userMessage ?? '',
        };
      }
      // UNATTENDED self-heal: a workflow/background run can't answer an ask, so
      // auto-retry the same call (bounded) or fail honestly instead of stranding.
      const infraDecision = decideInfraRecovery(sessionId);
      if (infraDecision === 'auto_retry') {
        bumpTurnNumber(sessionId, turn);
        return { sessionId, turn, status: 'failed', error: message, infraAutoRetry: { kind: err.kind, directive: buildInfraRetryDirective(err.kind) } };
      }
      // The turn is ENDING (ask/exhausted) — register any tool still in flight so
      // its eventual result is reunified into a report turn (never orphaned).
      recordOrphanedToolInFlight(sessionId, turn);
      if (infraDecision === 'exhausted') {
        emitInfraUnrecovered(sessionId, turn, err.kind, message);
        session.markStatus('failed');
        bumpTurnNumber(sessionId, turn);
        return { sessionId, turn, status: 'failed', error: message };
      }
      emitInfraTransientAsk(sessionId, turn, err.kind, err.userMessage ?? '', err.operatorMessage, message);
      bumpTurnNumber(sessionId, turn);
      // Session stays active so the next user message resumes it; do
      // NOT mark failed. Status returned to caller is
      // 'awaiting_user_input' so runConversation surfaces the same
      // shape as F4 stall recovery.
      return { sessionId, turn, status: 'awaiting_user_input', error: message };
    }
  }

  // Codex OAuth revoked/expired: the raw `Codex /responses returned 401 …
  // token_revoked` JSON is useless to the user, and retrying a revoked token
  // never recovers. Surface a clear re-auth instruction + one deduped
  // notification (so they know even if they're not watching), then end cleanly.
  if (isCodexAuthRevoked(err, message)) {
    // Latch auth DEAD so background loops (execution controller, cron, autonomy)
    // stop replaying the revoked token and park until a re-auth clears it.
    markCodexAuthDead(message);
    const friendly =
      'Your Codex sign-in expired or was revoked, so I can’t reach the model right now. '
      + 'Re-authenticate in Settings → Credentials → RE-AUTHENTICATE '
      + '(or run `clementine auth login-native`), then try again.';
    safeAppend({
      sessionId,
      turn,
      role: 'system',
      type: 'run_failed',
      data: { error: friendly, reason: 'codex_auth_revoked' },
    });
    try {
      addNotification({
        id: 'codex-auth-revoked', // stable → one alert per revocation, not per failed turn
        kind: 'system',
        title: 'Codex sign-in expired — re-authenticate',
        body: friendly,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { reason: 'codex_auth_revoked' },
      });
    } catch { /* notification is best-effort */ }
    session.markStatus('failed');
    bumpTurnNumber(sessionId, turn);
    return { sessionId, turn, status: 'failed', error: friendly };
  }

  safeAppend({
    sessionId,
    turn,
    role: 'system',
    type: 'run_failed',
    data: { error: clip(message, 400) },
  });
  session.markStatus('failed');
  bumpTurnNumber(sessionId, turn);
  return { sessionId, turn, status: 'failed', error: message };
}

function bumpTurnNumber(sessionId: string, turn: number): void {
  // Atomic update via SQLite's JSON1 json_set — avoids the
  // read-modify-write race the previous getSession + updateSession
  // path had when two runTurn() calls land on the same session
  // (e.g. UI double-submit). One UPDATE statement, one transaction,
  // no lost increments.
  const db = openEventLog();
  db.prepare(
    `UPDATE sessions
       SET metadata_json = json_set(metadata_json, '$.__turn', ?),
           updated_at    = ?
       WHERE id = ?`,
  ).run(turn, new Date().toISOString(), sessionId);
}

function nextTurnNumber(row: SessionRow): number {
  const t = (row.metadata as { __turn?: unknown }).__turn;
  return (typeof t === 'number' ? t : 0) + 1;
}

/** Turn ANY thrown value into a readable message. The codebase historically did
 *  `normalizeError(err)` at every error→string
 *  boundary, which renders a NON-Error object — e.g. a raw provider error
 *  envelope ({statusCode:529}) thrown late in a model stream — as the useless
 *  literal "[object Object]". That string got persisted into the run_failed event
 *  and shown to the user verbatim ("Something went wrong: [object Object]").
 *  Extract a message from a plain object before falling back to String(). Single
 *  helper so every boundary (and the workflow-runner twin) shares one fix. */
export function normalizeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || 'Error';
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const m = o.message ?? o.error ?? o.reason ?? o.detail ?? o.statusText;
    if (typeof m === 'string' && m.trim()) return m;
    const status = o.statusCode ?? o.status ?? o.code;
    if (status != null) return `error (status ${String(status)})`;
    try {
      const j = JSON.stringify(err);
      if (j && j !== '{}' && j !== 'null') return j;
    } catch { /* circular → fall through */ }
    // An object with nothing readable — return a safe fallback, NEVER String(err)
    // (which is the "[object Object]" we're here to eliminate).
    return 'unknown error';
  }
  return String(err);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[+${text.length - max} chars]`;
}

function previewOutput(out: unknown): string {
  if (typeof out === 'string') return out.slice(0, 200);
  try {
    return JSON.stringify(out).slice(0, 200);
  } catch {
    return String(out).slice(0, 200);
  }
}

/**
 * When the Orchestrator hands off to a sub-agent, that sub-agent
 * becomes the final agent on the run — the Orchestrator's structured
 * outputType doesn't apply, so the loop sees `decision: null`. The
 * sub-agent's raw final output is still the actual user-facing
 * answer. Surface it as a fallback summary so the chat UI renders the
 * answer instead of a bare "complete" status.
 *
 * Returns undefined when no usable text exists (the conversation_completed
 * event then omits the summary field entirely).
 */
function extractFallbackSummary(out: unknown): string | undefined {
  if (typeof out === 'string') {
    const trimmed = out.trim();
    if (!trimmed) return undefined;
    // Sub-agents (especially the Executor) sometimes emit a JSON-shaped
    // OrchestratorDecision string because they saw the schema in their
    // context and over-conformed. If we render the raw string, the user
    // sees literal '{"summary":"...","reply":"","done":false,...}' braces
    // in Discord — observed on 0.4.x SEO enrichment turn 11:16. Detect the
    // shape and pull out the user-facing field instead.
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
        if (reply) return reply;
        const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
        if (summary) {
          const wasIntent = parsed.done === false || parsed.nextAction === 'in_progress';
          return wasIntent
            ? `${summary}\n\n_(The agent described an intent but did not perform the tool calls. Ask it to run the actual tools.)_`
            : summary;
        }
      } catch { /* not valid JSON — fall through */ }
    }
    return trimmed;
  }
  if (out && typeof out === 'object') {
    try {
      const obj = out as Record<string, unknown>;
      const reply = typeof obj.reply === 'string' ? obj.reply.trim() : '';
      if (reply) return reply;
      const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
      if (summary) return summary;
      return JSON.stringify(obj);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ---------- default Runner adapter ----------

// The codex backend (the OAuth-bridged endpoint used by the harness)
// enforces stream:true. Non-streaming requests 400 with
// "Stream must be set to true". Both RunResult and StreamedRunResult
// expose identical `history` / `lastResponseId` / `finalOutput` /
// `interruptions` / `state` getters via RunResultBase, so streaming
// is a pure superset: drain the stream, then read the same fields.
/** True when an error is an `outputType` parse/validation failure — a JSON
 *  `SyntaxError` (the model returned non-JSON) or a `ZodError` (JSON parsed
 *  but the shape is wrong) — rather than a transport/auth/SSE error. A BYO
 *  OpenAI-compatible backend (MiniMax/DeepSeek) can emit either. Only these
 *  are recoverable; everything else must propagate. */
export function isStructuredOutputError(err: unknown): boolean {
  if (err instanceof SyntaxError) return true;
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; issues?: unknown; message?: unknown };
    if (e.name === 'ZodError') return true;
    if (Array.isArray(e.issues)) return true;
    // The Agents SDK wraps an output JSON.parse / Zod failure in a
    // ModelBehaviorError whose message starts "Invalid output type: …"
    // (agents-core runner/turnResolution.js). Heavy reasoning models
    // (MiniMax M3) trip this by emitting <think> text or truncated JSON.
    // Match the message so the run recovers cleanly — without swallowing
    // other ModelBehaviorErrors (e.g. invalid tool input).
    if (typeof e.message === 'string'
        && /invalid output type|failed schema validation|is not valid json/i.test(e.message)) {
      return true;
    }
  }
  return false;
}

/** Best-effort plain text from an assistant history item (string content or
 *  an array of text parts). Never throws. */
export function assistantItemText(item: AgentInputItem | null): string | null {
  try {
    if (!item) return null;
    const content = (item as { content?: unknown }).content;
    if (typeof content === 'string') return content.trim() || null;
    if (Array.isArray(content)) {
      const text = content
        .map((p) => (typeof p === 'string' ? p : (p as { text?: unknown } | null)?.text))
        .filter((t): t is string => typeof t === 'string')
        .join('')
        .trim();
      return text || null;
    }
  } catch {
    // best effort — recovery must never throw
  }
  return null;
}

function streamedTextFallback(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed || undefined;
}

function structuredOutputRecoveryText(
  history: AgentInputItem[],
  inputItemCount: number,
  streamedText: string,
): string {
  return assistantItemText(findLatestNewAssistantMessage(history, inputItemCount))
    ?? streamedTextFallback(streamedText)
    ?? STRUCTURED_OUTPUT_RECOVERY_FALLBACK;
}

/**
 * Fusion emits synthetic keepalives while its private draft/checker work is
 * pending so clients can keep showing a live run. They are visibility only:
 * treating them as semantic model progress lets a wedged Fusion branch evade
 * the ordinary stream-stall watchdog forever.
 */
function isFusionVisibilityHeartbeat(event: unknown): boolean {
  const ev = event as {
    type?: unknown;
    data?: { type?: unknown; event?: { type?: unknown } };
  };
  return ev.type === 'raw_model_stream_event'
    && ev.data?.type === 'model'
    && ev.data.event?.type === 'debate.keepalive';
}

const defaultRunRunner: RunRunnerFn = async (runner, agent, items, opts) => {
  type StreamedResultLike = {
    history: AgentInputItem[];
    lastResponseId: string | undefined;
    finalOutput: unknown;
    interruptions?: unknown[];
    rawResponses?: unknown[];
    state?: { toString(): string };
    completed: Promise<void>;
    [Symbol.asyncIterator](): AsyncIterator<unknown>;
  };
  type RunMethod = (
    a: typeof agent,
    i: typeof items,
    o: typeof opts,
  ) => Promise<StreamedResultLike>;
  const run = runner.run.bind(runner) as unknown as RunMethod;
  // ALWAYS stream (matches the pre-streaming production behavior): with
  // stream: true, a structured-output (agent.outputType) parse/validation
  // failure surfaces at `result.completed` / the finalOutput read INSIDE the
  // recovery try/catch below. A non-streamed run would reject `run()` itself,
  // bypassing the recovery path — so do not make `stream` conditional.
  // Stream-inactivity watchdog (turn-stall fix, 2026-06-11; pre-content
  // retry, 2026-06-15): two live incidents wedged a turn forever with ZERO
  // events because nothing bounds a silent model stream. Drain the stream with
  // a stall timer that resets on EVERY stream event (tool activity keeps long
  // turns alive). The window is TWO-tiered: until the model produces content,
  // a SHORTER pre-content window applies (modelFirstByteStallMs) and a stall
  // there is RETRYABLE — a wedged/silent stream (the Claude tool-turn hang,
  // tool-turn hang regression) re-runs cleanly because zero events means zero tool side
  // effects, so the user self-heals in seconds instead of hanging 5 min. Once
  // content has flowed, the longer modelStreamStallMs ceiling governs and a
  // stall is a hard failure (no replay — content was already emitted).
  const streamMs = modelStreamStallMs();
  const firstByteMs = modelFirstByteStallMs();
  // The pre-content retry REPLAYS the run input. On the approval-resume path that
  // input is a RunState whose first act is an already-APPROVED, often
  // side-effecting tool — so a replay would fire that external write a SECOND
  // time. resumePendingApproval threads disablePreContentRetry to force 0 retries
  // there (the stall surfaces as an error → the user re-sends), while FRESH turns
  // keep the self-heal. (integrity audit #2.1)
  const disablePreContentRetry =
    (opts as unknown as { disablePreContentRetry?: boolean })?.disablePreContentRetry === true;
  const maxStallRetries = disablePreContentRetry ? 0 : modelStreamStallRetries();
  // result is reassigned per attempt; the post-drain code reads the winner.
  let result!: Awaited<ReturnType<typeof run>>;
  let structuredOutputFailed = false;
  let recoveryStreamText = '';
  // The id of the ACTIVE attempt. After a pre-content stall + retry, the
  // abandoned stream keeps draining for a beat (its cancel isn't instant).
  // Its late tokens must not contaminate the winning attempt's private recovery
  // buffer. Gating accumulation on this id keeps a superseded stream inert.
  let activeAttempt = 0;
  const parentHarnessContext = harnessRunContextStorage.getStore();
  // One scope per defaultRunRunner invocation, with a new generation for each
  // internal pre-content retry. A unique child scope avoids unrelated parallel
  // workers under the same turn rotating one another.
  const runnerDispatchScopeId = parentHarnessContext
    ? `${parentHarnessContext.dispatchLease?.scopeId
      ?? parentHarnessContext.behaviorScopeId
      ?? parentHarnessContext.sessionId}::runner:${randomUUID()}`
    : undefined;
  for (let attempt = 0; ; attempt += 1) {
    activeAttempt = attempt;
    const dispatchLease: DispatchLeaseRef | undefined =
      parentHarnessContext && runnerDispatchScopeId && getSession(parentHarnessContext.sessionId)
        ? activateDispatchLease({
            sessionId: parentHarnessContext.sessionId,
            scopeId: runnerDispatchScopeId,
            runAttemptId: parentHarnessContext.runAttemptId,
          })
        : undefined;
    const dispatchRecoveryBaseline = dispatchLease
      ? captureDispatchRecoveryLedgerBaseline(dispatchLease.sessionId)
      : undefined;
    const physicalAttemptContext = parentHarnessContext && dispatchLease
      ? { ...parentHarnessContext, dispatchLease }
      : parentHarnessContext;
    try {
      result = physicalAttemptContext
        ? await withHarnessRunContext(
            physicalAttemptContext,
            () => run(agent, items, { ...opts, stream: true }),
          )
        : await run(agent, items, { ...opts, stream: true });
    } catch (err) {
      await revokeDispatchLeaseBeforeRecovery(dispatchLease);
      throw err;
    }
    const myResult = result;
    const myAttempt = attempt;
    const iterable = Symbol.asyncIterator in (myResult as unknown as Record<symbol, unknown>);
    let lastEventAt = Date.now();
    let yieldedContent = false;
    let attemptStreamText = '';
    // Content-chanting advisory (2026-07-20): the one runaway class nothing
    // else here sees — same text repeating with no tool calls (grind ladder
    // blind) while still streaming (stall watchdog blind). Advisory ONLY.
    const chantDetector = contentChantDetectionEnabled() ? new ContentChantDetector() : null;
    const chantSessionId = (opts as unknown as { context?: { sessionId?: string } })?.context?.sessionId;
    const feedChantDetector = (delta: string): void => {
      const trip = chantDetector?.feed(delta);
      if (!trip || !chantSessionId) return;
      try {
        appendEvent({
          sessionId: chantSessionId,
          turn: 0,
          role: 'system',
          type: 'guardrail_tripped',
          data: { kind: 'content_chanting', action: 'advisory', repeats: trip.repeats, chunkPreview: trip.chunk.slice(0, 50) },
        });
      } catch { /* advisory telemetry must never break the stream */ }
      console.warn(`[harness] content chanting detected (advisory): a ${trip.chunk.length}-char chunk repeated ${trip.repeats}x`);
    };
    const drainWork = async (): Promise<void> => {
      if (iterable) {
        for await (const event of myResult as unknown as AsyncIterable<unknown>) {
          // Every real Runner/model/tool event remains activity. Fusion's
          // synthetic UI heartbeat alone must not extend the liveness window.
          if (!isFusionVisibilityHeartbeat(event)) lastEventAt = Date.now();
          const ev = event as { type?: string; data?: { type?: string; delta?: string } };
          // Content or tool activity flips us past the pre-content window.
          if (ev.type === 'run_item_stream_event' || (ev.type === 'raw_model_stream_event' && ev.data?.type === 'output_text_delta')) {
            yieldedContent = true;
          }
          if (myAttempt === activeAttempt && ev.type === 'raw_model_stream_event' && ev.data?.type === 'output_text_delta' && typeof ev.data.delta === 'string') {
            attemptStreamText += ev.data.delta;
            feedChantDetector(ev.data.delta);
          }
        }
      }
      await myResult.completed;
    };
    const drain = physicalAttemptContext
      ? withHarnessRunContext(physicalAttemptContext, drainWork) as Promise<void>
      : drainWork();
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      if (!iterable || streamMs <= 0) return; // mocks / kill-switch: no watchdog
      const tickMs = Math.min(15_000, Math.max(250, Math.floor(Math.min(firstByteMs, streamMs) / 4)));
      stallTimer = setInterval(() => {
        const win = yieldedContent ? streamMs : firstByteMs;
        // The fallback boundary buffers provider-private reasoning until an
        // actionable text/tool item appears, so those raw frames cannot safely
        // enter Runner history and then be replayed on another brain. It records
        // a private activity timestamp in the run context instead; count that as
        // liveness without counting it as committed content. If reasoning stops,
        // the ordinary first-byte window still expires from its final timestamp.
        const privateActivityAt =
          physicalAttemptContext?.privateModelActivityAt
          ?? harnessRunContextStorage.getStore()?.privateModelActivityAt
          ?? 0;
        const observedActivityAt = Math.max(lastEventAt, privateActivityAt);
        if (Date.now() - observedActivityAt > win) {
          if (stallTimer) clearInterval(stallTimer);
          // Revoke authority BEFORE transport cancellation or recovery. A late
          // cancel callback/tool frame can now only observe the stale lease.
          void revokeDispatchLeaseBeforeRecovery(dispatchLease).then(
            () => {
              // Best-effort: release the underlying stream so the dangling
              // request doesn't pin sockets after we abandon the turn.
              try { (myResult as unknown as { cancel?: () => void }).cancel?.(); } catch { /* best-effort */ }
              reject(new ModelStreamStalledError(Math.round(win / 1000), !yieldedContent));
            },
            reject,
          );
        }
      }, tickMs);
      // Deliberately NOT unref'd: while a turn is in flight the watchdog IS
      // pending work — an unref'd timer could let a bare process exit before
      // the stall fires. It self-clears on drain completion or stall.
    });
    // Mid-stream kill responsiveness (2026-07-20 control-plane audit G4): the
    // kill switch was observed only pre-turn, at tool entry, and at step
    // boundaries — a long TOOL-LESS reasoning stretch ignored it until the next
    // boundary (the Claude SDK lane polls per stream message; this lane did
    // not). Poll the switch while the stream drains; on kill, release the
    // stream (the stall watchdog's proven cancel path — never a sync abort
    // mid-iteration, which is how Gemini CLI's loop detector crashed their CLI)
    // and reject with KillRequested so handleRunError lands the existing clean
    // 'killed' status. Cleanup rides the same drain lifecycle as the stall
    // timer. Best-effort: a poll failure must never break a healthy stream.
    let killTimer: ReturnType<typeof setInterval> | undefined;
    const killWatch = new Promise<never>((_, reject) => {
      const killSessionId = (opts as unknown as { context?: { sessionId?: string } })?.context?.sessionId;
      if (!iterable || !killSessionId) return;
      killTimer = setInterval(() => {
        try {
          const target = getActiveRunAttempt(killSessionId) ?? undefined;
          if (isKillRequested(killSessionId, target)) {
            if (killTimer) clearInterval(killTimer);
            void revokeDispatchLeaseBeforeRecovery(dispatchLease).then(
              () => {
                try { (myResult as unknown as { cancel?: () => void }).cancel?.(); } catch { /* best-effort */ }
                reject(new KillRequested(killSessionId));
              },
              reject,
            );
          }
        } catch { /* kill poll is best-effort */ }
      }, 1000);
    });
    void drain.finally(() => {
      if (stallTimer) clearInterval(stallTimer);
      if (killTimer) clearInterval(killTimer);
    }).catch(() => { /* surfaced via race */ });
    try {
      await Promise.race([drain, watchdog, killWatch]);
      await revokeDispatchLeaseBeforeRecovery(dispatchLease);
      recoveryStreamText = attemptStreamText;
      break; // turn drained successfully
    } catch (err) {
      // Exact-generation revoke is idempotent. It must finish before any retry
      // can acquire the next generation.
      await revokeDispatchLeaseBeforeRecovery(dispatchLease);
      // A pre-content stall is retryable: nothing streamed, so no tool ran and
      // no partial reply reached the user — re-run cleanly before giving up.
      if (err instanceof ModelStreamStalledError && err.preContent && attempt < maxStallRetries) {
        const recoveryCheck = dispatchLease
          ? checkDispatchRecoveryLedger(dispatchLease.sessionId, dispatchRecoveryBaseline)
          : { safeToReplay: true as const, evidence: [] };
        if (!recoveryCheck.safeToReplay) {
          try {
            appendEvent({
              sessionId: dispatchLease!.sessionId,
              turn: 0,
              role: 'system',
              type: 'guardrail_tripped',
              data: {
                kind: 'physical_attempt_retry_blocked',
                reason: recoveryCheck.reason,
                recordedExternalWrites: recoveryCheck.evidence.filter(
                  (event) => event.type === 'external_write',
                ).length,
              },
            });
          } catch { /* recovery remains fail-closed without telemetry */ }
          throw err;
        }
        console.warn(`[harness] model stream stalled pre-content after ${err.seconds}s — retrying (attempt ${attempt + 1}/${maxStallRetries})`);
        continue;
      }
      if (!isStructuredOutputError(err)) throw err;
      structuredOutputFailed = true;
      recoveryStreamText = attemptStreamText;
      console.warn('[harness] structured output failed to parse/validate — ending turn with raw text',
        err instanceof Error ? err.message : err);
      break;
    }
  }

  let history: AgentInputItem[] = [];
  try { history = result.history; } catch { history = []; }

  let finalOutput: unknown;
  if (structuredOutputFailed) {
    finalOutput = structuredOutputRecoveryText(history, items.length, recoveryStreamText);
  } else {
    try {
      finalOutput = result.finalOutput;
    } catch (err) {
      if (!isStructuredOutputError(err)) throw err;
      structuredOutputFailed = true;
      console.warn('[harness] finalOutput failed to parse/validate — ending turn with raw text',
        err instanceof Error ? err.message : err);
      finalOutput = structuredOutputRecoveryText(history, items.length, recoveryStreamText);
    }
  }

  // A failed-parse turn has no valid interruption state to resume from.
  const hasInterruptions = !structuredOutputFailed
    && Array.isArray(result.interruptions) && result.interruptions.length > 0;
  return {
    history,
    lastResponseId: result.lastResponseId,
    finalOutput,
    rawResponses: result.rawResponses,
    hasInterruptions,
    interruptions: hasInterruptions ? extractInterruptionInfo(result.interruptions ?? []) : undefined,
    serializedState: hasInterruptions ? result.state?.toString() : undefined,
  };
};

export { defaultRunRunner as __defaultRunRunner };

/**
 * Walk RunResult.interruptions and extract each tool call's name and
 * parsed arguments. The SDK shapes these as RunToolApprovalItem with
 * a rawItem of FunctionCallItem ({ name, arguments: string }).
 */
function extractInterruptionInfo(items: unknown[]): InterruptionInfo[] {
  const out: InterruptionInfo[] = [];
  for (const item of items) {
    const raw = (item as { rawItem?: { name?: string; arguments?: string } } | null)?.rawItem;
    if (!raw) continue;
    const toolName = typeof raw.name === 'string' ? raw.name : '';
    const rawArgs = typeof raw.arguments === 'string' ? raw.arguments : '';
    let args: Record<string, unknown> | null = null;
    if (rawArgs) {
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = null;
      }
    }
    out.push({ toolName, args, rawArgs });
  }
  return out;
}

/**
 * Pull a human-readable subject out of the tool args. The dashboard
 * and Discord both render this in the approval card, so the more
 * specific the better — "Create Outlook calendar event: 'Follow up
 * with Marlowe Rary'" reads better than "composio_execute_tool".
 *
 * Recognized shapes:
 *   composio_execute_tool({ tool_slug, arguments: <json string> })
 *       → "<Toolkit Verb>: <subject from inner args>"
 *   run_shell_command({ command })
 *       → "Shell: <first 80 chars of command>"
 *   write_file({ path, contents? })
 *       → "Write file: <path>"
 *   any other tool with args.subject / .title / .name / .command
 *       → "<toolName>: <that field>"
 *   fallback
 *       → toolName
 */
function extractApprovalSubject(info: InterruptionInfo): string {
  const args = (info.args ?? {}) as Record<string, unknown>;

  // composio_execute_tool: unwrap the inner args JSON.
  if (info.toolName === 'composio_execute_tool') {
    const slug = typeof args.tool_slug === 'string' ? args.tool_slug : '';
    const innerRaw = typeof args.arguments === 'string' ? args.arguments : '';
    let innerSubject = '';
    if (innerRaw) {
      try {
        const inner = JSON.parse(innerRaw) as Record<string, unknown>;
        innerSubject =
          (typeof inner.subject === 'string' && inner.subject)
          || (typeof inner.title === 'string' && inner.title)
          || (typeof inner.name === 'string' && inner.name)
          || (typeof inner.text === 'string' && inner.text)
          || (typeof inner.message === 'string' && inner.message)
          || (typeof inner.body === 'string' && (inner.body as string).slice(0, 80))
          || '';
      } catch {
        // Inner args weren't JSON — fall through to slug-only label.
      }
    }
    const verb = humanizeComposioSlug(slug);
    if (innerSubject) return `${verb}: ${truncate(innerSubject, 100)}`;
    return verb || info.toolName;
  }

  // run_batch: the plan carries everything a human needs — side effect, item
  // count, target tool, objective. The generic branch used to render the
  // literal "run_batch: propose", which is how a user got a naked Approve
  // button for 10 outbound emails in the ask-first batch regression.
  if (info.toolName === 'run_batch') {
    const plan = (args.plan ?? null) as { sideEffect?: string; items?: unknown[]; composioSlug?: string; tool?: string; objective?: string } | null;
    if (plan && typeof plan === 'object') {
      const count = Array.isArray(plan.items) ? plan.items.length : 0;
      const sideEffect = typeof plan.sideEffect === 'string' ? plan.sideEffect : 'write';
      const target = (typeof plan.composioSlug === 'string' && plan.composioSlug ? humanizeComposioSlug(plan.composioSlug) : plan.tool) || 'batch';
      const objective = typeof plan.objective === 'string' ? plan.objective : '';
      return truncate(`Batch ${sideEffect} · ${count} × ${target}${objective ? ` — ${objective}` : ''}`, 140);
    }
    return 'run_batch plan';
  }

  // run_shell_command: show the command itself, truncated. Append a
  // "⚠ implicit target" suffix when it's an irreversible publish whose
  // destination is ambient (deploy/publish with no --site/--project/…) so
  // the human approves with eyes open — the 2026-06-13 wrong-site class.
  if (info.toolName === 'run_shell_command') {
    const cmd = typeof args.command === 'string' ? args.command : '';
    if (cmd) return `Shell: ${truncate(cmd, 100)}${destinationCardSuffix(cmd)}`;
    return 'Shell command';
  }

  // write_file: show path + body length.
  if (info.toolName === 'write_file') {
    const p = typeof args.path === 'string' ? args.path : '';
    if (p) return `Write file: ${p}`;
    return 'Write file';
  }

  // request_approval is itself an "ask for approval on X" tool — the
  // subject IS the human label, so prefixing with the tool name
  // ("request_approval: deploy to prod") is double-named noise. Mirror
  // the special-case already in approval-summary.ts:previewToolCall.
  if (info.toolName === 'request_approval') {
    const subject =
      (typeof args.subject === 'string' && args.subject)
      || (typeof args.reason === 'string' && args.reason)
      || '';
    if (subject) return truncate(subject, 100);
    return info.toolName;
  }

  // Generic: pull a meaningful field out of args.
  for (const key of ['subject', 'title', 'name', 'action', 'command', 'message', 'directive']) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) {
      return `${info.toolName}: ${truncate(v, 100)}`;
    }
  }
  return info.toolName;
}

/**
 * Turn a Composio slug like `OUTLOOK_CALENDAR_CREATE_EVENT` into a
 * human phrase: "Create Outlook calendar event".
 *
 * Heuristic: known toolkit prefixes are capitalized; known verbs are
 * moved to the front; the rest is title-cased.
 */
function humanizeComposioSlug(slug: string): string {
  if (!slug) return '';
  const parts = slug.split('_').filter(Boolean).map((p) => p.toLowerCase());
  if (parts.length === 0) return '';

  const TOOLKITS: Record<string, string> = {
    outlook: 'Outlook', gmail: 'Gmail', slack: 'Slack', instagram: 'Instagram',
    salesforce: 'Salesforce', github: 'GitHub', linear: 'Linear', notion: 'Notion',
    trello: 'Trello', supabase: 'Supabase', stripe: 'Stripe', composio: 'Composio',
    discord: 'Discord', google: 'Google', drive: 'Drive', calendar: 'Calendar',
    sheets: 'Sheets', figma: 'Figma',
  };
  const VERBS = new Set([
    'create', 'list', 'get', 'search', 'update', 'delete', 'send', 'post',
    'fetch', 'read', 'write', 'add', 'remove', 'find', 'query', 'sync',
    'invite', 'cancel', 'archive', 'star', 'unstar', 'reply',
  ]);

  const toolkit = parts[0];
  const toolkitLabel = TOOLKITS[toolkit] ?? toolkit[0].toUpperCase() + toolkit.slice(1);

  // Find the first verb in the slug; treat everything after as the object.
  let verbIndex = -1;
  for (let i = 1; i < parts.length; i += 1) {
    if (VERBS.has(parts[i])) { verbIndex = i; break; }
  }
  if (verbIndex === -1) {
    return [toolkitLabel, ...parts.slice(1)].join(' ');
  }
  const verb = parts[verbIndex][0].toUpperCase() + parts[verbIndex].slice(1);
  const object = parts.slice(1, verbIndex).concat(parts.slice(verbIndex + 1)).join(' ');
  return object ? `${verb} ${toolkitLabel} ${object}` : `${verb} ${toolkitLabel}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
/** Per-turn recall_tool_result budget — env-tunable so grown data sources
 *  (a daily-append tracker sheet) don't hit a hard cliff. Defaults sized to
 *  page a ~150KB payload in one turn while still bounding re-inflation. */
function recallBudgetMaxCalls(windowScale = 1): number {
  const fallback = Math.round(5 * windowScale);
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_RECALL_MAX_CALLS', String(fallback)) ?? String(fallback), 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : fallback;
}
function recallBudgetMaxBytes(windowScale = 1): number {
  const fallback = Math.round(150_000 * windowScale);
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_RECALL_MAX_BYTES', String(fallback)) ?? String(fallback), 10);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : fallback;
}
