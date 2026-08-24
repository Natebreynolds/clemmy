import { renderCanonicalMemoryContext } from './canonical-context.js';
import { CLAUDE_BRAIN_RUBRIC } from '../../agents/clem-rubric.js';
import { batchShapeDirective } from '../../tools/batch-shape-directive.js';
import { getComposio } from '../../integrations/composio/client.js';
import { resolveToolJitDecision, selectToolsForTurn, recallPinnedBuiltinTools } from '../../agents/tool-jit.js';
import {
  renderCapabilityCandidateCard,
  resolveTurnCapabilityCandidates,
} from '../read-path/capability-candidates.js';
import { resolveHotSet } from '../../agents/tool-catalog.js';
import {
  composeSession,
  composeSessionFromStore,
  durableSessionKind,
  pinCompositionHotTools,
  pinCompositionTools,
  renderSessionMountPrimers,
} from './session-composition.js';
import { renderSessionToolIndex } from './session-tool-index.js';
import { getCoreToolsAsync } from '../../tools/registry.js';
import { getActiveAuthMode, getRuntimeEnv } from '../../config.js';
import { stableContextGeneration } from '../stable-context-generation.js';
import { isUnparseableToolCallError } from '../../execution/transient-error.js';
import { captureInteractionSignals } from '../../memory/auto-capture.js';
import {
  evaluateLearningCandidate,
  recordLearningDecision,
} from '../../memory/learning-receipt.js';
import { refreshWorkingMemoryForSession } from '../../memory/working-memory.js';
import { isUserFacingSession } from '../../execution/scope.js';
import { handoffTransferForAttempt } from '../../execution/continuation-capsule.js';
import { searchFactsHybrid } from '../../memory/facts.js';
import { recallMemory } from '../../memory/recall-memory.js';
import { isTemporalMeetingQuery } from '../../memory/recall.js';
import { crossStoreBreadcrumbs } from '../../memory/unified-recall.js';
import { recordRecallRun } from '../../memory/recall-usage.js';
import { scheduleRecallShadow } from '../../memory/recall-shadow.js';
import { _setUnifiedTurnPrimerRecallForTest, buildUnifiedTurnPrimer } from '../../memory/turn-primer.js';
import {
  EXPLICIT_MEMORY_RECALL_OPTOUT_REASON,
  explicitlyOptsOutOfAutomaticMemoryRecall,
} from '../../memory/automatic-recall-opt-out.js';
import { runPostTurnHooks } from './post-turn.js';
import { recordRunTokenWindow, resolveRunTokenCeiling, runTokenBudgetEnforcementEnabled } from './run-token-budget.js';
import { withModelUsageAttribution } from '../usage-log.js';
import { getHarnessBudgetSettings } from './budget-settings.js';
import {
  appendConversationPreambleOnce,
  conversationPreambleDeliveryRequest,
  beginRunAttempt,
  clearKill,
  createSession,
  findUserInputEventForRun,
  getRunAttemptSourceUserEvent,
  finishRunAttempt,
  getSession,
  getLatestEventSeq,
  getSessionTokensUsed,
  isKillRequested,
  listEvents,
  openEventLog,
  preserveCurrentKillAndClearStale,
  recordRunAttemptUserInput,
  updateSession,
  type RunAttemptRef,
} from './eventlog.js';
import { AgentRuntimeCancelledError } from '../provider.js';
import type { AssistantRequest, AssistantResponse } from '../../types.js';
import { enabledExternalServerNames } from '../mcp-servers.js';
import { appendEvent } from './eventlog.js';
// Lane wiring: the callable-surface oracle serves exact local schemas on this
// lane (guardrail mandates are constructible only from proof).
import '../../tools/callable-surface-registration.js';
import { CONVERGENCE_STEER, convergenceSteerEnabled, priorTurnEndedAwaitingClarification } from './convergence-steer.js';
import { enrichAcceptedRequestWithTaskContinuity } from './task-continuity-runtime.js';
import {
  durableMemoryReceiptAllowsConversationOnly,
  isSafeDurableMemoryReceiptPresentation,
} from './durable-memory-receipt.js';
import { prepareDurableMemoryIntakeHostCompletion } from './durable-memory-intake-receipt.js';
import {
  classifyTurnPreflight,
  effectiveTurnObjective,
  recordTurnPreflightDecision,
  standardAwareBeatText,
  type TurnPreflightDecision,
} from './turn-control.js';
import {
  createAgentsPreflightConversationPort,
  publishPreflightConversation,
  startSettledPreflightConversationAuthor,
  type PreflightConversationPort,
} from './preflight-conversation.js';
import {
  recordCapabilityResolution,
  renderCapabilityResolutionForContext,
  resolveTurnCapabilities,
} from './capability-resolution.js';
import {
  renderTurnOpennessForContext,
  resolveTurnOpenness,
  turnOpennessBrainFamily,
  turnOpennessEnabled,
  turnOpennessWarranted,
  type TurnOpenness,
} from './turn-openness.js';
import {
  pullRecentTurnsForSession,
  renderRecentActionsForHarnessHistory,
  renderCrossSessionPrefixesForModel,
  renderTranscriptTurns,
} from './session-transcript.js';
import { resolveWriteEvidence } from './work-report.js';
import { gatherSessionSkills, skillExecutionShortfall } from './skill-execution.js';
import { renderRelevantSkillsForPrompt, renderSkillDiscoveryPrompt } from '../../memory/skill-store.js';
import { renderProvenSkillForPrompt } from '../../memory/skill-choice-store.js';
import { detectMultiItemIntent, fanoutDirectiveLine, knownPitfallLineForInput, projectCommandsLineForInput } from './context-packet.js';
import { looksLikeToolCallShape } from './tool-narration-shapes.js';
import {
  PUBLIC_RUN_FAILURE_TEXT,
  heldExecutionTextForInternalReason,
  isHostAuthorityHeldReason,
  publicReplyText,
} from './public-presentation.js';
import { finalizePreparedWorkflowDispatchForSource } from './loop.js';
import {
  assessAcceptedSourceDelivery,
  commitTurnOutcome,
  deliveryMustHoldForHuman,
} from './delivery-committer.js';
import { auditAcceptedSourceSettlementTruth } from './accepted-source-settlement-audit.js';
import {
  evaluateTerminalDelivery,
  type TerminalDeliveryJudgePort,
} from './terminal-delivery-judge.js';
import {
  repairActionTerminalBeforeCommit,
  type PrecommitTerminalPresentationResult,
  type TerminalPresentationRepairPort,
} from './terminal-presentation-repair.js';
import { createAgentsTerminalPresentationRepairPort } from './terminal-presentation-repair-port.js';
import { getClaudeHeadlessModel } from './claude-headless-model.js';
import {
  PendingWorkflowChatDispatchOwnershipError,
  readPendingWorkflowChatDispatchOwnership,
} from '../../tools/workflow-run-queue.js';
import { turnOutcomeId, type TurnIdentity, type TurnOutcome } from './turn-outcome.js';
import {
  clearRunInFlightAfterTerminal,
  releaseRunInFlightAfterWorkflowTransfer,
} from './restart-recovery.js';
import { actionBus } from '../action-bus.js';
import {
  judgeObjectiveComplete,
  composeJudgedObjective,
  isPromiseShapedReply,
  isDirectionSeekingQuestion,
  type SkillExecutionContext,
  type ObjectiveJudgeFn,
} from './objective-judge.js';
import { resolveRoleModel } from './model-roles.js';
import {
  type ClaudeAgentSdkToolProfile,
  defaultClaudeAgentSdkAllowedLocalTools,
  claudeAgentSdkAdvertisableLocalTools,
  claudeToolSearchEnabled,
  runClaudeAgentSdk,
  ClaudeSdkProviderOverloadError,
  ClaudeSdkCapacityExhaustedError,
  ClaudeSdkContextOverflowError,
  type ClaudeAgentSdkRunOptions,
  type ClaudeAgentSdkRunResult,
} from './claude-agent-sdk.js';
import { resolveEffectiveToolNames, type ToolNamePolicyResult } from './tool-policy.js';
import {
  eventBelongsToSourceUserSeq,
  freshExternalWriteEvidenceIsVerified,
  freshExternalWriteEvidenceStatus,
  hasMeaningfulSuccessfulToolNames,
  isAcceptedExecutionCompletionOutput,
  objectiveMayRequireMultipleResults,
  objectiveRequiresFreshExternalWrite,
  singleSuccessfulCollectionReadCompletesObjective,
  type FreshExternalWriteEvidenceStatus,
} from './tool-evidence.js';
import { renderHarnessCapabilityHealthForContext } from './capability-health.js';
import { toolCallHint } from './tool-call-hint.js';
import { classifyRuntimeToolEffect } from './tool-effect.js';
import {
  mcpToolScopeAuthority,
  resolveMcpToolScopeWithRecall,
  type McpToolScope,
} from '../mcp-tool-scope.js';
import { pinnedCalendarRuleLabels } from './constraint-guard.js';
import {
  listRunArtifacts,
  listUnverifiedRunArtifacts,
  type RunArtifact,
} from './artifact-ledger.js';
import { summarizeWorkManifests } from './work-manifest.js';
import { recordVerdictEvent } from '../../execution/verdict.js';
import {
  createToolEconomyState,
  interactiveToolEconomyEnabled,
  interactiveToolEconomyPolicy,
  isComplexArtifactExecutionObjective,
} from './tool-economy.js';
import {
  buildProspectiveIntentionContext,
  prospectiveCaptureDirective,
} from '../prospective-intentions.js';
import {
  isQueuedActionApprovalQuestion,
  materializeQueuedApprovals,
  queuedApprovalTransitionShouldMaterialize,
  queuedApprovalTransitionsForRequest,
} from './pending-action-transition.js';
import * as approvalRegistry from './approval-registry.js';
import {
  activateDispatchLease,
  captureDispatchRecoveryLedgerBaseline,
  checkDispatchRecoveryLedger,
  revokeDispatchLeaseBeforeRecovery,
  type DispatchRecoveryLedgerCheck,
} from './dispatch-lease.js';
import { turnGraphFromShadowEvent } from '../graph/turn-graph-shadow.js';
import {
  commitUnadmittedSemanticTurn,
  recordAcceptedSourceGraph,
} from './record-accepted-source-graph.js';
import { dispatchAdmittedSource } from '../semantic-boundary/typed-source-dispatch.js';

import { requireAcceptedTaskAuthority } from './accepted-task-authority.js';
import { requireKnownExpectedWorkContract } from './expected-work-contract.js';
import {
  requireActionExpectedWorkActivation,
} from './action-expected-work-boundary.js';
import { resolveActionTaskState } from './action-task-state.js';
import { discoveryGovernor } from './discovery-governor.js';
import { buildAuthorizedToolSearchCandidateSources } from '../../tools/tool-search-provider-sources.js';
import { toolSearchBrokerCoverage } from '../../tools/tool-search-tool.js';
import {
  actionControlAdmittedForTaskState,
  actionControlContextFor,
} from '../../tools/tool-registry.js';

type ClaudeAgentSdkRunFn = (options: ClaudeAgentSdkRunOptions) => Promise<ClaudeAgentSdkRunResult>;
let runClaudeAgentSdkImpl: ClaudeAgentSdkRunFn = runClaudeAgentSdk;
let runPostTurnHooksImpl: typeof runPostTurnHooks = runPostTurnHooks;
let terminalPresentationRepairPortForTest: TerminalPresentationRepairPort | null = null;
let terminalDeliveryJudgePortForTest: TerminalDeliveryJudgePort | null = null;
let preflightConversationPortForTest: PreflightConversationPort | null = null;

export function setClaudeAgentSdkBrainRunForTest(fn: ClaudeAgentSdkRunFn | null): void {
  runClaudeAgentSdkImpl = fn ?? runClaudeAgentSdk;
}

export function setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest(
  port: TerminalPresentationRepairPort | null,
): void {
  terminalPresentationRepairPortForTest = port;
}

export function setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(
  port: TerminalDeliveryJudgePort | null,
): void {
  terminalDeliveryJudgePortForTest = port;
}

export function setClaudeAgentSdkBrainPreflightConversationPortForTest(
  port: PreflightConversationPort | null,
): void {
  preflightConversationPortForTest = port;
}

export function setClaudeAgentSdkBrainPostTurnHooksForTest(
  fn: typeof runPostTurnHooks | null,
): void {
  runPostTurnHooksImpl = fn ?? runPostTurnHooks;
}

let judgeImpl: ObjectiveJudgeFn = judgeObjectiveComplete;
export function setClaudeAgentSdkBrainJudgeForTest(fn: ObjectiveJudgeFn | null): void {
  judgeImpl = fn ?? judgeObjectiveComplete;
}

let searchFactsHybridImpl: typeof searchFactsHybrid = searchFactsHybrid;
export function setClaudeAgentSdkBrainSearchFactsHybridForTest(fn: typeof searchFactsHybrid | null): void {
  searchFactsHybridImpl = fn ?? searchFactsHybrid;
}

export function setClaudeAgentSdkBrainUnifiedPrimerForTest(
  fn: Parameters<typeof _setUnifiedTurnPrimerRecallForTest>[0],
): void {
  _setUnifiedTurnPrimerRecallForTest(fn);
}

/** Completion-judge kill-switch (default ON). Off ⇒ the SDK brain trusts its own
 *  "done" (legacy). On ⇒ parity with the harness loop's objective judge. */
function completionJudgeEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}
function sessionHistoryEnabled(): boolean {
  // Inject the session's prior turns into the Claude brain prompt so multi-turn
  // chat works (the SDK lane is stateless: persistSession:false). Kill-switch
  // CLEMMY_CLAUDE_SDK_SESSION_HISTORY=off → byte-identical bare-message prompt.
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_SESSION_HISTORY', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}
function contextSplitEnabled(): boolean {
  // Phase 3 #1 (token): keep the STABLE memory in the cacheable system append and
  // move the VOLATILE tail (Now / query-recall / focus / goals / held / working-
  // memory / this-session actions) into the user turn, so the big stable context
  // stops re-billing every turn (the Claude SDK lane re-billed ~5-15K tok/turn
  // because volatile fields led the append and busted the cached prefix). Kill-
  // switch CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT=off → old single-append behavior.
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}
/** Private query used by retrieval/routing for a verified continuation. The
 * provider prompt still receives request.message verbatim. */
function semanticTaskInput(request: AssistantRequest): string {
  return request.semanticTaskInput?.trim() || request.message;
}

function isDeclinedTaskContinuation(request: AssistantRequest): boolean {
  return request.taskContinuation?.disposition === 'declined';
}

function isDeclinedParentWithNewTask(request: AssistantRequest): boolean {
  return request.taskContinuation?.disposition === 'declined_with_new_task';
}

function taskContinuationDeclinesParent(request: AssistantRequest): boolean {
  return isDeclinedTaskContinuation(request) || isDeclinedParentWithNewTask(request);
}

/** Retrieval may use the private A/Q/B task for a positive continuation, but a
 * typed decline deliberately collapses back to literal B. The continuation
 * object and durable transcript still carry the conversation for the model. */
function retrievalTaskInput(request: AssistantRequest): string {
  if (isDeclinedParentWithNewTask(request)) {
    return request.taskContinuation?.activeTaskInput?.trim() || semanticTaskInput(request);
  }
  if (!isDeclinedTaskContinuation(request)) return semanticTaskInput(request);
  // `answer` is the bridge-validated text from the exact accepted B event. It
  // remains the retrieval/telemetry authority even if a caller supplied a
  // private model directive in `message`; the provider prompt itself is left
  // untouched and still receives request.message verbatim.
  return request.taskContinuation?.answer.trim() || request.message;
}
function queryRecallTimeoutMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_BRAIN_QUERY_RECALL_TIMEOUT_MS', '1500') ?? '1500', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1500;
}
function queryRecallEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_BRAIN_QUERY_RECALL', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function jitMonotonicEnabled(): boolean {
  // The cache lever: make the per-session advertised tool set MONOTONIC (only
  // grows) so once it converges the tools block is byte-identical turn-to-turn →
  // the SDK prompt cache holds for the rest of the run. The cache breakpoint sits
  // at the END of the system-prompt + tool-definitions layer, so a stable
  // system+tools prefix cache-HITS on turns 2+ EVEN as the user message varies;
  // per-turn JIT variance is the one thing that busts it (Anthropic docs, verified
  // 2026-06-29: code.claude.com/docs/en/prompt-caching · platform.claude.com/docs/
  // en/agents-and-tools/tool-use/tool-use-with-prompt-caching). This corrects the
  // earlier worry that "headless caching matches the full prompt" — it does not;
  // it matches the system+tools prefix. On a Claude subscription (this lane) the
  // cache TTL is automatically 1h, so the growth-phase cost amortizes over a long
  // window. DEFAULT ON: it is starvation-safe (the floor only GROWS, never drops
  // below the per-turn JIT selection; core/search tools are always present) and
  // never worse than the no-JIT baseline in steady state — a heavily-varied
  // session simply grows the floor until it advertises ALL tools, which the
  // jitDropped<=0 branch already detects and which is itself cache-stable. Only
  // the convergence transient (each growth busts once) is a cost. Kill-switch
  // CLEMMY_JIT_MONOTONIC=off → per-turn JIT (prior behavior).
  return (getRuntimeEnv('CLEMMY_JIT_MONOTONIC', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}
// Per-session growing tool FLOOR for monotonic JIT. Bounded so a long-lived daemon
// never accumulates unboundedly (oldest session evicted past the cap; each value
// is ≤|tools| short strings). Keyed by chat session id.
const SESSION_TOOL_FLOOR_MAX = 500;
const sessionToolFloor = new Map<string, Set<string>>();
export function bumpSessionToolFloor(sessionId: string, exposed: Iterable<string>): Set<string> {
  let floor = sessionToolFloor.get(sessionId);
  if (floor) sessionToolFloor.delete(sessionId); // re-insert to keep LRU recency
  else floor = new Set<string>();
  for (const t of exposed) floor.add(t);
  sessionToolFloor.set(sessionId, floor);
  if (sessionToolFloor.size > SESSION_TOOL_FLOOR_MAX) {
    const oldest = sessionToolFloor.keys().next().value;
    if (oldest !== undefined) sessionToolFloor.delete(oldest);
  }
  return floor;
}
function claudeSdkSalvageEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_SALVAGE', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

interface ClaudePreterminalDeliveryConcern {
  reason: string;
  missing?: string[];
  /** The replacement text already tells the user what could not be verified. */
  presentationAlreadyDiscloses?: boolean;
}

/** Private brain-to-terminal marker. It is stripped before the public result is
 * returned; its only purpose is to keep a committed provider ambiguity from
 * becoming a synthetic user question before the shared delivery gate runs. */
type ClaudeAgentSdkTerminalResult = ClaudeAgentSdkRunResult & {
  preterminalDeliveryConcern?: ClaudePreterminalDeliveryConcern;
};
/** SDK-named alias for the SHARED fallover classifier (transient-error.ts), so the
 *  chat lane and the workflow step-boundary fallover classify a parse-failure
 *  identically. The SDK's `query()` throws this — its own parse-retry already failed
 *  — when the model emits a tool call whose JSON can't be parsed. */
export const isClaudeSdkUnparseableToolCall = isUnparseableToolCallError;
/** When the SDK throws AFTER side effects already committed this turn, derive a
 *  private evidence summary from this turn's external_write ledger and carry a
 *  concrete terminal-delivery concern. A different-family judge authors the
 *  terminal when available; this summary is only failed-model fallback context.
 *  NEVER re-runs (that would double-act). Returns null when nothing committed. */
function salvageCommittedResult(sessionId: string, sinceSeq = 0): ClaudeAgentSdkTerminalResult | null {
  type WriteTruth = {
    seq: number;
    callId?: string;
    toolName?: string;
    shapeKey?: string;
    targets?: string[];
  };
  let landed: WriteTruth[] = [];
  let uncertain: WriteTruth[] = [];
  try {
    const events = listEvents(sessionId, {
      types: ['external_write', 'external_write_succeeded', 'external_write_failed', 'external_write_orphaned'],
      ...(sinceSeq > 0 ? { sinceSeq } : {}),
    });
    const resolved = resolveWriteEvidence(events);
    const mapWrite = (event: (typeof events)[number]): WriteTruth => ({
      seq: event.seq,
      ...(event.data as Omit<WriteTruth, 'seq'>),
    });
    landed = resolved.confirmed.map(mapWrite);
    uncertain = resolved.uncertain.map(mapWrite);
  } catch { return null; }
  if (landed.length === 0 && uncertain.length === 0) return null;
  const relevant = [...landed, ...uncertain];
  const targets = [...new Set(relevant.flatMap((w) => (w.targets ?? []).filter((t): t is string => typeof t === 'string')))];
  const allEmail = relevant.every((w) => /SEND_EMAIL|SEND_MAIL/i.test(w.shapeKey ?? ''));
  const noun = allEmail ? (relevant.length === 1 ? 'email' : 'emails') : (relevant.length === 1 ? 'action' : 'actions');
  const targetList = targets.length > 0 ? ` (${targets.slice(0, 8).join(', ')})` : '';
  if (uncertain.length > 0) {
    const completedPrefix = landed.length > 0 ? `${landed.length} completed; ` : '';
    const text = `⚠️ The model errored after external work started. ${completedPrefix}${uncertain.length} ${noun} may have gone through${targetList}, but its provider result was lost. I did not replay it because that could duplicate the action. Please verify the target; then tell me what remains.`;
    return {
      text,
      toolUses: relevant.map((w) => w.toolName ?? 'tool'),
      limitHit: false,
      sessionId,
      stoppedReason: 'awaiting-input',
      preterminalDeliveryConcern: {
        reason: 'an external write started but its provider result was not observed',
        missing: ['external_write_result_unresolved'],
        presentationAlreadyDiscloses: true,
      },
    };
  }
  // We know N writes LANDED, but NOT whether the task was fully complete. Keep
  // this ledger-derived account private as judge context whenever the judge is
  // available; it is public only as the fallback for the failed model call.
  const text = `⚠️ The model errored before it could confirm completion, but ${landed.length} ${noun} already went through${targetList} — nothing was duplicated. Please check these are what you intended; if anything's still missing, tell me and I'll finish it.`;
  return {
    text,
    toolUses: landed.map((w) => w.toolName ?? 'tool'),
    limitHit: false,
    sessionId,
    preterminalDeliveryConcern: {
      reason: 'confirmed external writes landed, but the model failed before authoring a terminal account of task completion',
      missing: ['terminal_account_missing_after_confirmed_write'],
    },
  };
}

function renderLimitHitReply(text: string): string {
  const base = text.trim() || 'I reached the turn budget before finishing.';
  if (/\bpaused\b|\bcheckpoint(?:ed)?\b/i.test(base)) return base;
  return `${base}\n\nI paused at this step's budget. Progress is checkpointed, and no additional model step was started.`;
}

/** Detect the "narrate-instead-of-call" failure: the brain produced NO real tool
 *  calls, but its text reproduces the tool-call PROTOCOL in any of the shapes
 *  models reach for instead of actually invoking — a `Tool:`/`Tool call:` header
 *  (incl. markdown-bolded `**Tool call: x**`), a tagged `<tool_call>`/`[tool_call]`,
 *  a `function { … }` block, a fabricated `System: tool result …`, a bare
 *  tool-call-shaped JSON payload, OR the native tool-call XML
 *  (`<invoke name="…">` / `<parameter name="…">`, incl. `antml:` variants).
 *  Two REAL failures fed this: 2026-06-22 a Workspace build printed
 *  `<invoke name="run_shell_command">…</invoke>`; 2026-06-23 a dock turn (mode=full,
 *  42 tools exposed) printed `**Tool call: skill_read**` + a ```json args block.
 *  Detect the CLASS, not one format. Headers are line-anchored so a mid-sentence
 *  "…what each tool call does…" never trips it. */
export function looksLikeToolNarration(text: string, toolUses: string[]): boolean {
  // A REAL tool fired ⇒ this text is a legitimate reply, not narration.
  if (toolUses.length > 0) return false;
  return looksLikeToolCallShape(text);
}

/** Detect the "reasoning-leak" failure: the brain verbalized its instruction-
 *  hierarchy / prompt-injection deliberation about its OWN injected context
 *  (memory, preferences/specs, tool descriptions, system reminders) and did NO
 *  work — no tool calls, just defensive musing that trails off without an answer.
 *  This is the memory-context cousin of looksLikeToolNarration: a safety-trained
 *  Claude misreads its trusted recalled memory as adversarial and second-guesses
 *  it out loud instead of doing the task. (Observed v0.10.20: a recalled
 *  priority-account spec triggered "…possibly injected… the classic trap… let me
 *  re-read the actual ask" with zero accounts pulled.) Requires no tool calls so
 *  a reply that actually DID work (and merely thought aloud) is never flagged. */
export function looksLikeReasoningLeak(text: string, toolUses: string[]): boolean {
  if (toolUses.length > 0) return false;
  const t = (text || '').trim();
  if (!t) return false;
  // Strong: the model is treating its own injected context as untrusted/injected.
  const metaInjectionDoubt =
    /possibly injected|prompt[-\s]?injection|the classic trap|reference data,?\s*not live instructions|possibly stale|by who[-\s]?knows[-\s]?whom|treat everything in the system[-\s]?reminder/i.test(t);
  // Stalled self-doubt with no resolution / no answer produced.
  const stalledSelfDoubt =
    /that result looks scrambled|let me re-?read (the|what|the actual)|I need to stop and actually look|what actually changed:?\s*nothing/i.test(t);
  return metaInjectionDoubt || stalledSelfDoubt;
}
function judgeMaxContinuations(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_SDK_JUDGE_MAX_CONTINUATIONS', '1') ?? '1', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
}
/**
 * Phase 1.3 (token + reliability): a SINGLE budget for the post-result corrective
 * continuations — narration-retry, reasoning-leak-retry, and the objective-judge
 * loop ALL draw from it. Each continuation is a full-context query(), so without a
 * shared cap they compound multiplicatively (narration + reasoning + judge×N =
 * up to 4-5 full re-runs of one turn). A healthy turn fires NONE; this only bounds
 * the pathological stack. Default 2; CLEMMY_CLAUDE_SDK_MAX_CONTINUATIONS=0 disables
 * all correctives, higher re-widens.
 */
function maxTurnContinuations(): number {
  // The standalone Claude lane is a bounded transport window, never a second
  // host loop. Corrective judges may classify or hold its result, but cannot
  // mint another query(). Durable continuation belongs to the host/workflow
  // owner on a later invocation.
  return 0;
}

/** DEFAULT ON. When the SDK brain hits its per-query turn budget (maxTurns) on a run
 *  that is STILL making forward progress, auto-continue instead of PARKING on "say
 *  continue" — a per-query turn cap must not stop an autonomous multi-item run (the
 *  2026-07-01 Sonnet 5 stress: 5-firm SEO parked at 2/5 on maxTurns=24). Mirrors the
 *  main loop's auto-continue-on-limit ratchet. Off (CLEMMY_CLAUDE_SDK_AUTO_CONTINUE=off)
 *  ⇒ the prior park-on-limit behavior. */
function sdkAutoContinueEnabled(): boolean {
  // Kept as a named policy seam while rolling-upgrade tests drain. The former
  // internal auto-continue chain was an SDK-owned loop hidden inside one host
  // invocation; it is now structurally disabled.
  return false;
}
/** Max auto-continues per run (each re-runs with a fresh turn budget). The per-query
 *  tool-ceiling + wall-clock remain the hard backstops. */
function maxSdkAutoContinues(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_SDK_AUTO_CONTINUE_MAX', '8') ?? '8', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 8;
}
/** Total wall-clock budget across all auto-continues (a hard stop against a run that
 *  keeps making token progress without ever finishing). Default 30 min. */
function sdkAutoContinueWallMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_SDK_AUTO_CONTINUE_WALL_MS', '1800000') ?? '1800000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_800_000;
}

export type ClaudeAgentBrainSurface = 'webhook' | 'cron' | 'cli' | 'dashboard' | 'home' | 'discord' | 'slack' | 'background';
export type ClaudeAgentBrainMode = 'read_only' | 'local_authoring' | 'full';

function configuredMode(): ClaudeAgentBrainMode | null {
  // Claude chat and unattended execution surfaces use the tool-capable Agent
  // SDK lane by default.
  // The standard `claude -p` transport is intentionally text-only. Full-mode
  // writes still pass through Clementine's approval and tool-boundary gates.
  const raw = (getRuntimeEnv('CLEMMY_CLAUDE_AGENT_SDK_BRAIN', 'full') ?? 'full').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return null;
  if (raw === 'read_only' || raw === 'readonly') return 'read_only';
  // Full agentic: Claude executes gated tools (shell/composio/sends) under the
  // approval gate.
  if (raw === 'full' || raw === 'agentic' || raw === 'all') return 'full';
  if (
    raw === 'on'
    || raw === '1'
    || raw === 'true'
    || raw === 'yes'
    || raw === 'local'
    || raw === 'local_authoring'
    || raw === 'authoring'
    || raw === 'write'
    || raw === 'writes'
  ) return 'local_authoring';
  return null;
}

export function claudeAgentSdkBrainMode(): ClaudeAgentBrainMode | null {
  return configuredMode();
}

export function isClaudeAgentBrainSurface(surface: string): surface is ClaudeAgentBrainSurface {
  return surface === 'webhook' || surface === 'cron' || surface === 'cli' || surface === 'dashboard' || surface === 'home' || surface === 'discord' || surface === 'slack' || surface === 'background';
}

export function claudeAgentSdkBrainEnabled(surface: string): surface is ClaudeAgentBrainSurface {
  if (configuredMode() === null || getActiveAuthMode() !== 'claude_oauth' || !isClaudeAgentBrainSurface(surface)) return false;
  try {
    return resolveRoleModel('brain').provider === 'claude';
  } catch {
    return false;
  }
}

export { durableMemoryReceiptAllowsConversationOnly };

export function resolveClaudeAgentBrainMaxTurns(
  objective: string,
  recentUserInputs: readonly string[] = [],
): number {
  // One host invocation gets one flat SDK transport window. Objective size or
  // prior prose cannot widen it; larger work earns durable host/workflow
  // re-entry, not a larger provider-owned loop.
  void objective;
  void recentUserInputs;
  const configured = (getRuntimeEnv('CLEMMY_CLAUDE_AGENT_SDK_BRAIN_MAX_TURNS', '') ?? '').trim();
  if (configured) {
    const raw = Number.parseInt(configured, 10);
    return Number.isFinite(raw) && raw >= 1 && raw <= 12 ? raw : 12;
  }
  return 12;
}

/** The SDK brain's final reply was SHAPED like a printed tool call with zero
 *  real tool uses and the retry corrective didn't fix it — a dead turn unless
 *  another brain takes it. Zero side effects by definition ⇒ safe to re-run.
 *  message carries the graceful user-facing fallback copy. */
export class ClaudeSdkNarrationGiveUpError extends Error {
  readonly narrationGiveUp = true;
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeSdkNarrationGiveUpError';
  }
}

/** A2 reduced-context retry: drop the query-recall block from a turn context.
 *  Recall is re-derivable (the model can search memory); constraints, session
 *  actions (the double-send guard) and continuation context are NOT — keep them. */
function stripRecallFromTurnContext(turnContext: string | undefined): string | undefined {
  if (!turnContext) return turnContext;
  return turnContext
    .split('\n\n')
    .filter((block) => !block.startsWith('[MEMORY PRIMER]') && !block.startsWith('## Relevant To Your Request'))
    .join('\n\n');
}

function toolProfileForMode(mode: ClaudeAgentBrainMode): ClaudeAgentSdkToolProfile {
  if (mode === 'full') return 'full';
  if (mode === 'local_authoring') return 'local_authoring';
  return 'read_only';
}

function toolPolicyForRequest(request: AssistantRequest, mode: ClaudeAgentBrainMode): ToolNamePolicyResult {
  return resolveEffectiveToolNames({
    surface: 'claude_agent_sdk_brain',
    lane: mode,
    toolNames: defaultClaudeAgentSdkAllowedLocalTools(toolProfileForMode(mode)),
    allowedToolNames: request.allowedToolNames,
    excludeToolNames: request.excludeToolNames,
    reason: 'claude-agent-sdk allowed local MCP tools',
  });
}

/**
 * In full/agentic mode the SDK permission profile is only the fast-allow set.
 * The local MCP server intentionally advertises the broader catalog so tools
 * outside that profile can still reach canUseTool and the shared taxonomy gate.
 * JIT must preserve that distinction instead of turning permission into reachability.
 */
export function claudeAgentSdkAdvertisedToolUniverse(
  mode: ClaudeAgentBrainMode,
  fastAllowNames: readonly string[],
  excludeNames: readonly string[] = [],
  explicitAuthority = false,
): string[] {
  const excluded = new Set(excludeNames);
  const names = mode === 'full' && !explicitAuthority
    // The MCP server directly registers most capabilities. Four computer reads
    // (workspace_roots/list_files/read_file/git_status) are implemented only as
    // local-runtime tools, but the schema-on-demand call_tool bridge can invoke
    // them with the same inner harness gates. Keep the permission profile in the
    // authority union so discovery does not silently erase those capabilities.
    ? [...claudeAgentSdkAdvertisableLocalTools(), ...fastAllowNames]
    : [...fastAllowNames];
  return [...new Set(names)].filter((name) => !excluded.has(name));
}

/** Provider-neutral projection shared with Codex's registry class. Fresh
 * accepted work cannot search or dispatch prior-task archaeology, and neither
 * fresh nor continued work may acquire a second action owner. */
export function projectClaudeAcceptedActionSurface(
  names: readonly string[],
  acceptedAction: boolean,
  taskState: 'fresh' | 'continuation',
): string[] {
  if (!acceptedAction) return [...names];
  return names.filter((name) => actionControlAdmittedForTaskState(name, taskState));
}

export function partitionClaudeAgentSdkJitSurface(
  fastAllowNames: readonly string[],
  advertisedUniverse: readonly string[],
  exposed: ReadonlySet<string>,
): { fastAllowNames: string[]; advertisedNames: string[] } {
  return {
    fastAllowNames: fastAllowNames.filter((name) => exposed.has(name)),
    advertisedNames: advertisedUniverse.filter((name) => exposed.has(name)),
  };
}

function modeCanAuthorOrExecute(mode: ClaudeAgentBrainMode): boolean {
  return mode === 'local_authoring' || mode === 'full';
}

const ACTION_REQUEST_RE =
  /\b(?:create|build|make|set up|schedule|save|write|draft|send|email|update|post|publish|deploy|run|execute|install|configure|generate|add|change|edit|refresh|pull)\b/i;
const COMPLETION_CLAIM_RE =
  /\b(?:pass|verified|done|completed|finished|created|built|made|set up|scheduled|saved|wrote|written|drafted|sent|emailed|posted|updated|published|deployed|ran|executed|installed|configured|generated|added|changed|edited|refreshed|pulled)\b/i;

function looksLikeActionCompletionClaim(requestText: string, replyText: string): boolean {
  return ACTION_REQUEST_RE.test(requestText || '') && COMPLETION_CLAIM_RE.test(replyText || '');
}

/** The completion judge is a recovery path for suspicious text, not a tax on
 * successful tool execution. Concrete tool-backed runs already carry durable
 * tool/result evidence; bouncing them through another full model run adds
 * latency and can repeat side effects. A promise remains suspicious even when a
 * partial tool call happened, while a zero-tool action claim still needs proof. */
export function shouldJudgeClaudeCompletion(
  requestText: string,
  replyText: string,
  successfulToolUses: string[],
): boolean {
  const concreteSingleCollectionRead = singleSuccessfulCollectionReadCompletesObjective(
    requestText,
    successfulToolUses,
  );
  return isPromiseShapedReply(replyText)
    || ((!hasMeaningfulSuccessfulToolNames(successfulToolUses, requestText)
      || (objectiveMayRequireMultipleResults(requestText) && !concreteSingleCollectionRead))
      && looksLikeActionCompletionClaim(requestText, replyText));
}

function claudeRequestFreshExternalWriteStatus(
  sessionId: string,
  sourceUserSeq: number,
): FreshExternalWriteEvidenceStatus {
  try {
    return freshExternalWriteEvidenceStatus(
      listEvents(sessionId, {
        types: ['external_write', 'external_write_succeeded', 'external_write_failed', 'external_write_orphaned'],
      }),
      sourceUserSeq,
    );
  } catch {
    return 'missing';
  }
}

function claudeRequestHasAcceptedExecutionCompletion(
  sessionId: string,
  sourceUserSeq: number,
): boolean {
  try {
    return listEvents(sessionId, { types: ['tool_returned'] }).some((event) => {
      if (event.seq <= sourceUserSeq || event.data.tool !== 'execution_complete') return false;
      if (!eventBelongsToSourceUserSeq(event, sourceUserSeq)) return false;
      return isAcceptedExecutionCompletionOutput(event.data.result ?? event.data.output);
    });
  } catch {
    return false;
  }
}

function claudeFreshWriteVerified(sessionId: string, sourceUserSeq: number): boolean {
  return freshExternalWriteEvidenceIsVerified(
    claudeRequestFreshExternalWriteStatus(sessionId, sourceUserSeq),
    claudeRequestHasAcceptedExecutionCompletion(sessionId, sourceUserSeq),
  );
}

function claudeFreshWriteGapReason(status: Exclude<FreshExternalWriteEvidenceStatus, 'confirmed'>): string {
  if (status === 'ambiguous') {
    return 'the current request has an ambiguous external-write outcome; reconcile the exact target read-only and do not repeat the write';
  }
  if (status === 'failed') {
    return 'at least one external write required by the current request failed; a successful receipt for a different action does not resolve that failure';
  }
  return 'no external-write receipt exists after the current user request; historical focus summaries and prior execution receipts are not evidence';
}

function mergeClaudeRunEvidence(
  previous: ClaudeAgentSdkRunResult,
  next: ClaudeAgentSdkRunResult,
): ClaudeAgentSdkRunResult {
  const hasSuccessfulEvidence = previous.successfulToolUses !== undefined
    || next.successfulToolUses !== undefined;
  return {
    ...next,
    toolUses: [...previous.toolUses, ...next.toolUses],
    artifactRunScopeId: next.artifactRunScopeId ?? previous.artifactRunScopeId,
    ...(hasSuccessfulEvidence
      ? { successfulToolUses: [...(previous.successfulToolUses ?? []), ...(next.successfulToolUses ?? [])] }
      : {}),
  };
}

/** One deterministic repair query for resources whose create response yielded
 * an id but whose exact provider binding has not yet been read back. This text
 * is deliberately generated from ledger state—not from the model's prose. */
function renderArtifactVerificationPrompt(artifacts: readonly RunArtifact[]): string {
  const rows = artifacts.map((artifact) => {
    if (artifact.kind === 'google_doc') {
      return `- Google Doc document_id=${artifact.resourceId}: call GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT (or the connected exact get-document-by-id equivalent) with exactly that document_id.`;
    }
    if (artifact.kind === 'resource' && artifact.provider === 'googlesheets') {
      return `- Google Sheet spreadsheet_id=${artifact.resourceId}: call GOOGLESHEETS_BATCH_GET (or the connected exact spreadsheet/range getter equivalent) with exactly that spreadsheet_id, the exact constructor range covering its header and rows, and valueRenderOption=UNFORMATTED_VALUE.`;
    }
    return `- Netlify site_id=${artifact.resourceId}: call run_shell_command once with netlify api getSite --data '{"site_id":"${artifact.resourceId}"}'.`;
  });
  return [
    'Before reporting success, independently read back the exact resource pointer(s) created in this run.',
    'Do NOT create, deploy, publish, search, or list anything. Do NOT substitute a title match. Make at most one exact-ID getter call per row:',
    ...rows,
    'Then report only whether those exact bindings were readable. Reuse the existing resource; never create a replacement.',
  ].join('\n');
}

// JIT tool-RAG helpers (Claude-brain port).
// Tool descriptions are static (code-defined), so build the name→description map
// ONCE per daemon lifetime instead of rebuilding every zod tool object each JIT turn.
let coreToolDescCache: Map<string, string> | null = null;
async function coreToolDescriptions(): Promise<Map<string, string>> {
  if (coreToolDescCache) return coreToolDescCache;
  const core = await getCoreToolsAsync({ includeDynamicComposioTools: false });
  coreToolDescCache = new Map(
    core.map((t) => [(t as { name?: string }).name ?? '', (t as { description?: string }).description ?? '']),
  );
  return coreToolDescCache;
}

// Recent prior user messages in this session, newest-first (excluding the current).
// Folded into the JIT ranking query so a bare follow-up ("do it", "make it weekly")
// inherits the intent the conversation built toward — parity with the Codex lane's
// recentPriorUserInputsForScope. Minimal (this session only); best-effort.
function recentPriorBrainInputs(sessionId: string, current: string, limit = 3): string[] {
  const cur = (current ?? '').trim();
  const seen = new Set<string>();
  const out: string[] = [];
  try {
    const rows = listEvents(sessionId, { types: ['user_input_received'], desc: true, limit: 8 });
    for (const ev of [...rows].reverse()) {
      const text = typeof (ev.data as { text?: unknown })?.text === 'string'
        ? ((ev.data as { text?: string }).text ?? '').trim()
        : '';
      if (!text || text === cur || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
      if (out.length >= limit) break;
    }
  } catch { /* best effort */ }
  return out;
}

function summarizeClaudeSdkToolUsesForJudge(toolUses: string[]): string {
  const counts = new Map<string, number>();
  for (const raw of toolUses) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    const bare = name.split('__').at(-1) ?? name;
    counts.set(bare, (counts.get(bare) ?? 0) + 1);
  }
  if (counts.size === 0) return '(no tool calls made)';
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
    .join(', ');
}

function renderCapabilityBoundary(mode: ClaudeAgentBrainMode): string {
  if (mode === 'read_only') {
    return [
      'IMPORTANT CURRENT CAPABILITY BOUNDARY:',
      '- This Claude Agent SDK brain lane is currently READ-ONLY/local-context only.',
      '- You may use exposed Clementine MCP tools for memory, profile, session, skill, workspace, status, and read-only file/context lookup.',
      '- Do not claim you created workflows, wrote files, ran shell commands, sent messages, updated external systems, or performed any mutation unless a tool result in this run proves it.',
      '- If the user asks for a mutation or full workflow execution, answer with the best design/analysis you can and say that the mutating execution should run through the guarded Codex harness until Claude SDK local-authoring mode is enabled.',
      '- For design/report/writing guidance, use memory and skills when relevant, then produce the user-facing output directly.',
    ].join('\n');
  }
  if (mode === 'full') {
    return [
      'CAPABILITY — you are the AGENTIC Clementine brain on the user\'s Claude subscription. You CAN execute tools to complete the request: run shell commands (run_shell_command), discover + execute Composio actions (composio_search_tools → composio_execute_tool), write files, and chain multi-step work — exactly like the Codex harness.',
      '- Every tool call runs through Clementine\'s safety gates (grounding, goal-fidelity, execution-wrap, destination, duplicate-write, loop-guard). Irreversible/external actions (sends, batch external writes) PAUSE for the user\'s approval BEFORE they run. Do the work — the gates + approval protect it; you do not need to ask permission in prose first.',
      '- SURFACE NOTE: the intent-matched native vendor MCP servers for THIS turn (e.g. a native dataforseo/firecrawl/supabase MCP) ARE attached on this lane — their tool schemas load on demand via tool search (surfaced by name, fetched when you call them). When a skill or instruction says "use the <X> MCP", use that native server/tool directly. Fall back to composio_search_tools → composio_execute_tool (e.g. a DATAFORSEO_* slug) or run_shell_command (the vendor CLI) only when no native server is attached for the need. Use ONE surface per capability — do not pull the same data from two surfaces in the same run.',
      '- Execute accepted external work through work_call. Its exact host-frozen binding authorizes admitted writes, so do not call execution_list or execution_create merely to wrap them. Certified batches and approved pending actions carry their own exact authority; only follow EXECUTION_WRAP_REQUIRED for a direct legacy mutation when execution_create is actually exposed.',
      `- A large tool result may be clipped with a \`[digest: …]\` footer naming a call id — pull the stored records with ${toolCallHint('tool_output_query', { call_id: '<call id>', fields: ['<field>'] })} or the raw payload with ${toolCallHint('recall_tool_result', { call_id: '<call id>' })}. Never report stored data as unavailable.`,
      '- Do NOT claim you ran a command, sent a message, or wrote a file unless a tool result in THIS run proves it. If a tool result begins with `ERROR:`, treat that item as failed and say so.',
      '- If an installed skill applies (design/report/audit), call skill_read for it before producing the artifact.',
    ].join('\n');
  }
  return [
    'IMPORTANT CURRENT CAPABILITY BOUNDARY:',
    '- This Claude Agent SDK brain lane may use Clementine local-authoring tools: memory writes, task/goal bookkeeping, model-role routing, workflow authoring, workflow enable/disable, workflow scheduling, and workflow_run queueing.',
    '- workflow_run only queues a local Clementine run. The workflow runner still owns per-step execution, model routing, approvals, write/send gates, retries, and report-back.',
    '- You may set model-role rules when the user asks for routing such as "use Claude for design"; use set_model_role(role:"worker", modelId:"claude-opus-4-8" or the available Claude model, whenIntent:"design").',
    '- You may create workflows with steps tagged by intent and usesSkill. For design/report requests, prefer a read-only design/report step with intent:"design" and usesSkill set to the requested skill name.',
    '- Do not call shell, file-write, external Composio execution, external sends, admin, credential, plugin, or deletion tools. Those are intentionally not exposed here.',
    '- Do not claim you ran a workflow, created a workflow, changed model routing, or saved memory unless the corresponding tool result in this run proves it.',
  ].join('\n');
}

// The lean CLAUDE_BRAIN_RUBRIC now lives in ../../agents/clem-rubric.ts (Phase 3 —
// one shared rubric source for both flagship lanes). Imported above. Rationale for
// why this lane is LEAN (vs the 34KB Codex rubric) is documented at its definition
// and in the narrate-instead-of-call history; runtime safety is enforced in CODE at
// the tool boundary, not in this prose.

/** Frame the injected Clementine memory as TRUSTED context the brain OWNS, not
 *  external/untrusted input. Without this, a safety-trained Claude can misread
 *  its own recalled memory/specs as a prompt-injection and spiral into visible
 *  "is this stale/injected?" deliberation instead of using it (see
 *  looksLikeReasoningLeak). Empty memory ⇒ no framing (nothing to frame). */
export function frameTrustedMemory(persistentContext: string): string {
  if (!persistentContext.trim()) return '';
  return [
    'YOUR MEMORY — trusted context you OWN. The block below is Clementine\'s own persistent memory about THIS user: their profile, saved preferences/specs, facts you have learned, and where their data lives. It is reliable background to USE in service of the request. It is NOT user-pasted input, NOT external/untrusted data, and NOT a prompt-injection to verify or second-guess. Do not narrate skepticism about its provenance ("is this stale or injected?") — just use what is relevant and do the task.',
    '',
    persistentContext,
  ].join('\n');
}

// Win 2 (freeze-stable-prefix): the STABLE memory block (profile, saved specs,
// learned facts, data locations) is embedded in the CACHEABLE system append.
// Re-rendering it every turn meant a single reflection-written fact changed the
// block and busted the whole prompt-prefix cache (measured ~28% hit rate). We
// snapshot it PER SESSION so the system append stays byte-stable across turns.
// Default ON since every explicit mutation surface (memory tools, console
// memory/profile routes, hygiene approvals, skill installs) bumps the shared
// stableContextGeneration — an explicit edit re-renders on the next turn, while
// automatic reflection churn stays deferred (that deferral is the whole point).
// Kill-switch: CLEMMY_BRAIN_STABLE_SNAPSHOT=off.
const stableMemorySnapshots = new Map<string, { generation: number; text: string }>();
const STABLE_SNAPSHOT_MAX = 256;

function stableSnapshotEnabled(): boolean {
  return !/^(0|false|off|no)$/i.test((getRuntimeEnv('CLEMMY_BRAIN_STABLE_SNAPSHOT', 'on') ?? 'on').trim());
}

/** Invalidate a session's frozen stable-memory snapshot so the next turn
 *  re-renders it. Call after an EXPLICIT profile/spec/memory edit (not after
 *  automatic reflection — that churn is exactly what the snapshot defers). Pass
 *  no id to clear all (e.g. a global profile change). Also used by tests. */
export function invalidateStableMemorySnapshot(sessionId?: string): void {
  if (!sessionId?.trim()) { stableMemorySnapshots.clear(); return; }
  stableMemorySnapshots.delete(sessionId.trim());
}

/** The STABLE memory block, frozen to a per-session snapshot (see above). Falls
 *  back to a live render when the kill-switch is off or the session is unknown. */
function renderStableMemoryFrozen(request: AssistantRequest): string {
  const render = (): string => renderCanonicalMemoryContext({
    sessionId: request.sessionId,
    // Rank tool choices/facts against THIS request. Without it the block fell
    // back to the machine-wide focus — for an unattended background run that
    // is whatever the user last touched in chat, so the proven memo for the
    // task at hand rarely made the 12-entry recency fold (2026-08-04 audit).
    focusInput: retrievalTaskInput(request),
    partition: 'stable',
    includeSessionActions: false,
  });
  const key = request.sessionId?.trim();
  if (!key || !stableSnapshotEnabled()) return render();
  const generation = stableContextGeneration();
  const cached = stableMemorySnapshots.get(key);
  // A stale generation means an EXPLICIT memory/profile/skill mutation landed
  // since this snapshot froze — re-render so the edit is visible this session.
  if (cached !== undefined && cached.generation === generation) return cached.text;
  const fresh = render();
  // Bounded FIFO eviction so long-lived daemons don't leak snapshots.
  if (stableMemorySnapshots.size >= STABLE_SNAPSHOT_MAX && !stableMemorySnapshots.has(key)) {
    const oldest = stableMemorySnapshots.keys().next().value;
    if (oldest !== undefined) stableMemorySnapshots.delete(oldest);
  }
  stableMemorySnapshots.set(key, { generation, text: fresh });
  return fresh;
}

export function renderClaudeAgentBrainSystemAppend(
  surface: ClaudeAgentBrainSurface,
  request: AssistantRequest,
  mode: ClaudeAgentBrainMode = claudeAgentSdkBrainMode() ?? 'read_only',
): string {
  const split = contextSplitEnabled();
  // Split ON: the system append carries ONLY the STABLE memory (cacheable across
  // turns); the volatile tail + this-session actions move to the user turn (see
  // renderClaudeAgentBrainTurnContext). Split OFF: the old single-append behavior
  // (full context + query recall + sessionActions here) — byte-identical.
  // Split ON: the STABLE block is frozen to a per-session snapshot so the system
  // append stays byte-stable and the prompt-prefix cache hits (Win 2). Split OFF:
  // the old single-append render (full context + query recall) — byte-identical.
  const persistentContext = split
    ? renderStableMemoryFrozen(request)
    : renderCanonicalMemoryContext({
        sessionId: request.sessionId,
        query: retrievalTaskInput(request),
        partition: 'all',
        includeSessionActions: false,
      });
  const compositionPrimers = renderSessionMountPrimers(composeSession({ sessionId: request.sessionId }));
  // Visibility into THIS session's completed irreversible actions. The text
  // transcript doesn't carry tool results, so without this the brain is blind to
  // its own prior sends and can re-run them (the 2026-06-29 double-send). Gated by
  // the same session-history kill-switch. Split ON → this rides the user turn
  // instead (it grows each action, so it's volatile and must not bust the cache).
  let sessionActions = '';
  if (!split && sessionHistoryEnabled()) {
    try { sessionActions = renderRecentActionsForHarnessHistory(openEventLog(), request.sessionId); } catch { sessionActions = ''; }
  }
  return [
    'You are Clementine running as the main brain through the official Claude Agent SDK inside the Clementine harness.',
    'You are using the user\'s Claude subscription auth. Stay inside Clementine\'s product identity, memory, skills, workflows, and workspace expectations.',
    '',
    renderCapabilityBoundary(mode),
    '',
    // Full agentic parity with the Codex/BYO schema-on-demand lanes: names stay
    // in the stable prefix while schemas remain behind tool_search/call_tool.
    // The renderer is deterministic and performs no provider round-trip.
    mode === 'full' ? renderSessionToolIndex() : '',
    '',
    sessionActions,
    '',
    `Surface: ${surface}`,
    `Session: ${request.sessionId}`,
    `Claude brain mode: ${mode}`,
    '',
    // The turn's advisory candidate card is volatile. With the context split
    // enabled it rides the per-turn user context below so the system prefix is
    // byte-stable and remains cacheable. Split-off preserves the historical
    // single-append byte shape.
    split ? '' : renderCapabilityCandidateCard(request.turnCandidates),
    // Session composition (workspace contract, saved-bundle notes): identity
    // mount, not a job type. Chat mounts nothing extra here.
    compositionPrimers,
    '',
    frameTrustedMemory(persistentContext),
    '',
    // Canonical memory normally carries this compact discovery contract. Keep a
    // fallback only when that block is unavailable; never duplicate or enumerate
    // the installed catalog in the cacheable system prefix.
    renderClaudeBrainSkillsBlock(persistentContext),
    '',
    // BATCH-SHAPE RULE: the brain lane ground multi-fetch turns through discrete
    // calls (live: 6 discrete Outlook calls) without a steer. The base rule is a
    // constant and getComposio() is session-stable, so this stays in the
    // cacheable stable append. Fires whenever composio data tools are in scope
    // (the common chat case) — the per-turn fan-out sharpening stays in the
    // turn context. '' (dropped by filter) when composio isn't configured.
    // Same directive the workflow-step lane appends, so the lanes steer alike.
    batchShapeDirective({ composioInScope: getComposio() != null }),
    '',
    'How you operate here:',
    CLAUDE_BRAIN_RUBRIC,
  ].filter(Boolean).join('\n\n');
}

/** Fixed-size fallback for a missing canonical skill-discovery block. Installed
 * names/descriptions are selected against the current query in turn context. */
function renderClaudeBrainSkillsBlock(persistentContext: string): string {
  if (persistentContext.includes('## Skill Discovery')) return '';
  try {
    return `SKILL DISCOVERY:\n${renderSkillDiscoveryPrompt()}`;
  } catch {
    return '';
  }
}

/**
 * The VOLATILE per-turn context for the Claude SDK brain — the bits that change
 * turn-to-turn (current time, query recall, live focus/goals/held/working-memory)
 * plus THIS session's completed irreversible actions. Returned separately from
 * the (stable, cacheable) system append so the caller can inject it into the user
 * turn, where uncached content belongs. When context splitting is off, the
 * persistent/volatile blocks remain in the system append but unified recall
 * still rides here: a prompt-placement kill-switch must not change memory.
 */
interface ClaudeTurnMemoryPrimerTelemetry {
  enabled: boolean;
  hitCount: number;
  omittedCount: number;
  candidateCount: number;
  source: string | null;
  recallId: string | null;
  answerability: 'supported' | 'partial' | 'insufficient' | null;
  stores: string[];
  recallElapsedMs: number | null;
  skippedReason: string | null;
}

async function buildClaudeAgentBrainTurnContext(
  request: AssistantRequest,
  opts?: {
    sourceUserSeq?: number;
    sourceTurn?: number;
    /** Live execution only: start the SETTLED author beside openness. */
    prestartSettledConversation?: boolean;
    /** Frozen prior-turn text available only at the outer live caller. */
    conversationContext?: string;
  },
): Promise<{
  text: string;
  memoryPrimer: ClaudeTurnMemoryPrimerTelemetry;
  preflight: TurnPreflightDecision;
  preflightConversation?: {
    port: PreflightConversationPort;
    settledProceedAuthor?: Promise<string>;
  };
  alignmentContext: {
    conversationContext: string;
    memoryContext: string;
    capabilityContext: string;
    openness: TurnOpenness | null;
  };
}> {
  const declinedContinuation = isDeclinedTaskContinuation(request);
  const declinedParentWithNewTask = isDeclinedParentWithNewTask(request);
  const taskInput = retrievalTaskInput(request);
  // The provider still receives request.message byte-for-byte. This narrower
  // value governs only deterministic preflight and semantic acquisition after
  // an exact typed parent decline introduced separate new work.
  const authorityInput = declinedParentWithNewTask ? taskInput : request.message;
  const q = taskInput.replace(/\s+/g, ' ').trim();
  const splitContext = contextSplitEnabled();
  let relevantSkills = '';
  if (splitContext && q && !declinedContinuation) {
    try {
      // Proven standard first — same contract as the Codex lane (parity is a
      // hard requirement; a standard that binds on one brain and not the other
      // is exactly the two-lane trap).
      const rendered = [renderProvenSkillForPrompt(q), renderRelevantSkillsForPrompt(q)].filter(Boolean).join('\n\n');
      if (rendered) relevantSkills = `## Relevant Skills\n${rendered}`;
    } catch { relevantSkills = ''; }
  }
  // Render the volatile tail WITHOUT the query so its FTS-only recall block is
  // omitted — we replace it below with HYBRID recall (FTS ∪ semantic) so the
  // Claude lane stops knowledge-starving on paraphrased requests (Phase 4).
  const volatile = splitContext
    ? renderCanonicalMemoryContext({
        sessionId: request.sessionId,
        focusInput: taskInput,
        partition: 'volatile',
        includeSessionActions: false,
      })
    : '';
  let recall = '';
  let unifiedPrimerStatus: 'ok' | 'empty' | 'timeout' | 'error' | 'disabled' | null = null;
  const recallOn = queryRecallEnabled();
  const recallOptedOut = explicitlyOptsOutOfAutomaticMemoryRecall(q);
  let memoryPrimer: ClaudeTurnMemoryPrimerTelemetry = {
    enabled: recallOn,
    hitCount: 0,
    omittedCount: 0,
    candidateCount: 0,
    source: recallOn && !recallOptedOut && !declinedContinuation ? 'unified' : null,
    recallId: null,
    answerability: null,
    stores: [],
    recallElapsedMs: null,
    skippedReason: declinedContinuation
      ? 'declined_continuation'
      : !recallOn
      ? 'disabled'
      : !q
        ? 'empty_input'
        : recallOptedOut
          ? EXPLICIT_MEMORY_RECALL_OPTOUT_REASON
          : 'no_hits',
  };
  if (q && recallOn && !recallOptedOut && !declinedContinuation) {
    scheduleRecallShadow({ query: q, surface: 'claude_primer', limit: 6 });
    try {
      const timeoutMs = queryRecallTimeoutMs();
      const unified = await buildUnifiedTurnPrimer({
        query: q,
        surface: 'claude_primer',
        limit: 8,
        maxChars: 1_800,
        timeoutMs,
        sessionId: request.sessionId,
      });
      unifiedPrimerStatus = unified.status;
      memoryPrimer = {
        enabled: true,
        hitCount: unified.hitCount,
        omittedCount: unified.omittedHitCount,
        candidateCount: unified.diagnostics?.candidates ?? unified.retrievedHitCount,
        source: 'unified',
        recallId: unified.recallId ?? null,
        answerability: unified.answerability ?? null,
        stores: unified.diagnostics?.stores ?? [],
        recallElapsedMs: unified.diagnostics?.elapsedMs ?? null,
        skippedReason: unified.status === 'ok' ? null : unified.status === 'empty' ? 'no_hits' : unified.status,
      };
      if (unified.status === 'ok') {
        recall = unified.text ?? '';
      } else if (unified.status !== 'empty') {
        // Degraded fallback only: preserve the prior bounded fact/meeting path
        // when the unified ranker is killed, times out, or fails.
        const [hits, meetingRecall] = await Promise.all([
          withTimeout(searchFactsHybridImpl(q, 6), timeoutMs, []),
          isTemporalMeetingQuery(q)
            ? withTimeout(recallMemory(q, { stores: ['note'], graphDepth: 0, limit: 4 }), timeoutMs, null)
            : Promise.resolve(null),
        ]);
        const meetingBullets = (meetingRecall?.hits ?? []).map((hit) => {
          const source = hit.evidence[0]?.sourceUri;
          const content = String(hit.text ?? '').trim();
          const bounded = content.length <= 1000 ? content : `${content.slice(0, 1000)} …[truncated — load the source for the full meeting]`;
          return `- [RECORDED MEETING · ${hit.whyRecalled.join(', ')}] ${hit.title ?? 'Meeting'}: ${bounded}${source ? ` (source: ${source})` : ''}`;
        });
        const factBullets = hits
          .map((f) => {
            const content = String(f.content ?? '').trim();
            return `- ${content.length <= 1000 ? content : `${content.slice(0, 1000)} …[truncated — search memory for the full fact]`}`;
          })
          .filter((line) => line.length > 2);
        const bullets = [...meetingBullets, ...factBullets].join('\n');
        if (bullets) recall = `## Relevant To Your Request\n${bullets}`;
        // The fallback shows real facts, so it must record a real run — with
        // recallId null this surface was credit-blind: facts it put in front
        // of the model could never earn utility no matter how they were used.
        let fallbackRecallId: string | null = null;
        if (hits.length > 0) {
          try {
            fallbackRecallId = recordRecallRun({
              objective: q,
              surface: 'claude_primer_fallback',
              answerability: 'partial',
              candidateRefs: hits.map((f) => ({ type: 'fact' as const, id: String(f.id), snippet: String(f.content ?? '') })),
              sessionId: request.sessionId,
            }).id;
          } catch { /* attribution must never break primer rendering */ }
        }
        memoryPrimer = {
          ...memoryPrimer,
          hitCount: meetingBullets.length + factBullets.length,
          omittedCount: 0,
          candidateCount: meetingBullets.length + hits.length,
          source: `legacy_fallback_${unified.status}`,
          recallId: fallbackRecallId,
          answerability: recall ? 'partial' : 'insufficient',
          stores: [...new Set([
            ...(meetingBullets.length > 0 ? ['note'] : []),
            ...(factBullets.length > 0 ? ['fact'] : []),
          ])],
          skippedReason: recall ? null : `unified_${unified.status}_no_fallback_hits`,
        };
      }
    } catch {
      recall = '';
      unifiedPrimerStatus = 'error';
      memoryPrimer = { ...memoryPrimer, source: 'legacy_fallback_error', skippedReason: 'error' };
    }
  }
  let prospectiveContext = '';
  let prospectiveCapture = '';
  if (!declinedContinuation) {
    try {
      prospectiveContext = buildProspectiveIntentionContext({
        query: taskInput,
        sessionId: request.sessionId,
      }).text;
      prospectiveCapture = prospectiveCaptureDirective(authorityInput) ?? '';
    } catch {
      // Future-intention projection is advisory context, never turn authority.
    }
  }
  // Legacy cross-store breadcrumbs are retained only when the unified primer is
  // explicitly disabled or unavailable. The primary result already contains
  // entities, resources, episodes, policies, notes, facts, and procedures.
  let breadcrumbs = '';
  if (
    q
    && !declinedContinuation
    && !recallOptedOut
    && unifiedPrimerStatus !== 'ok'
    && unifiedPrimerStatus !== 'empty'
  ) {
    try { breadcrumbs = await crossStoreBreadcrumbs(q); } catch { breadcrumbs = ''; }
  }
  let sessionActions = '';
  if (sessionHistoryEnabled()) {
    try { sessionActions = renderRecentActionsForHarnessHistory(openEventLog(), request.sessionId); } catch { sessionActions = ''; }
  }
  let continuationContext = '';
  if (sessionHistoryEnabled()) {
    try { continuationContext = renderCrossSessionPrefixesForModel(openEventLog(), request.sessionId); } catch { continuationContext = ''; }
  }
  // Fan-out directive (parity with the Codex/orchestrator lane, which builds this in
  // buildAgentContextPacket). The Claude brain used to be BLIND to it — it hardcoded
  // multiItem detected=false and its rubric never mentioned run_worker — so a big same-shape
  // job ("scrape 100 accounts, analyze each") was ground through SEQUENTIALLY until it hit the
  // step cap and parked at ~item #15. Now a detected multi-item turn gets the loud
  // "do NOT serialize — run_worker in parallel waves" directive so she actually swarms.
  let fanoutDirective = '';
  // Confirm beat (parity with the context packet — this lane doesn't consume
  // the packet): a fresh execution-shaped chat request gets ONE conversational
  // alignment beat before autonomous execution. Continuations, questions,
  // pre-authorized hand-offs, and non-chat kinds stay silent.
  let confirmBeat = '';
  let preflight: TurnPreflightDecision = {
    phase: 'execute',
    consequential: false,
    reason: 'ordinary_execution',
  };
  const sourceBoundTurn = Number.isSafeInteger(opts?.sourceUserSeq)
    && Number(opts?.sourceUserSeq) > 0;
  let preflightSessionKind: NonNullable<ReturnType<typeof getSession>>['kind'] | undefined;
  try {
    preflightSessionKind = getSession(request.sessionId)?.kind;
  } catch (error) {
    // A source-bound dispatch whose durable session cannot be read cannot prove
    // whether confirm-first authority applies, so it must stop before the model.
    if (sourceBoundTurn) throw error;
  }
  try {
    // Private semantic continuation text is useful for recall and capability
    // ranking, but it is not the user's current authority. A reply such as
    // "No" must never inherit the parent request's action classification or
    // fan-out directive merely because A/Q/B are present in taskInput.
    const multi = detectMultiItemIntent(authorityInput);
    if (multi.isMultiItem) fanoutDirective = fanoutDirectiveLine(multi);
    preflight = classifyTurnPreflight({
      message: authorityInput,
      sessionId: request.sessionId,
      sessionKind: preflightSessionKind,
      isMultiItem: multi.isMultiItem,
      itemCount: multi.itemCount,
      sourceUserSeq: opts?.sourceUserSeq,
    });
    // Persist only for a real durable chat session. Render-only probes commonly
    // use display ids with no session row and stay pure; the live SDK path also
    // supplies the exact accepted source row before model/tool dispatch.
    if (preflightSessionKind === 'chat') {
      recordTurnPreflightDecision(request.sessionId, preflight, opts?.sourceUserSeq);
    }
    // Standard-aware on BOTH lanes — a beat that names the governing standard
    // on one brain and not the other is the two-lane trap in miniature.
    confirmBeat = (!request.semanticTaskInput || declinedParentWithNewTask)
      && preflight.phase === 'align'
      ? standardAwareBeatText(authorityInput)
      : '';
  } catch (error) {
    if (sourceBoundTurn && preflightSessionKind === 'chat') throw error;
    // Preflight state is directive/telemetry, not execution authority — a
    // classify/persist failure degrades to no beat, never a failed turn.
    // Consent enforcement lives in plan-scope/approvals.
    fanoutDirective = '';
    confirmBeat = '';
  }
  // Typed capability resolution (parity with the context packet — this lane
  // doesn't consume the packet): what THIS ask can already rely on, what has
  // failed before, what has no active connection. Runtime facts as DATA; the
  // model never has to rediscover — or silently trust — its own history.
  let capabilityResolution = '';
  let resolvedCapabilityEntries: ReadonlyArray<{ kind: string; identifier: string }> = [];
  if (!declinedContinuation) {
    try {
      const resolved = resolveTurnCapabilities(taskInput, { sessionId: request.sessionId });
      resolvedCapabilityEntries = resolved.entries;
      capabilityResolution = renderCapabilityResolutionForContext(resolved, { focusInput: taskInput });
      if (preflightSessionKind === 'chat') {
        recordCapabilityResolution(request.sessionId, resolved, opts?.sourceUserSeq);
      }
    } catch {
      capabilityResolution = '';
    }
  }
  const activeModelId = request.model && request.model.startsWith('claude-')
    ? request.model
    : resolveRoleModel('brain').modelId;
  let preflightConversation: {
    port: PreflightConversationPort;
    settledProceedAuthor?: Promise<string>;
  } | undefined;
  if (
    opts?.prestartSettledConversation === true
    && preflightSessionKind === 'chat'
    && preflight.phase === 'align'
    && Number.isSafeInteger(opts.sourceUserSeq)
    && Number(opts.sourceUserSeq) > 0
    && Number.isSafeInteger(opts.sourceTurn)
    && Number(opts.sourceTurn) >= 0
  ) {
    const port = preflightConversationPortForTest
      ?? createAgentsPreflightConversationPort({ model: getClaudeHeadlessModel(activeModelId) });
    const prepared = {
      identity: {
        sessionId: request.sessionId,
        turn: Number(opts.sourceTurn),
        sourceUserSeq: Number(opts.sourceUserSeq),
      },
      decision: preflight,
      conversationContext: [
        opts.conversationContext,
        continuationContext,
        sessionActions,
      ].filter(Boolean).join('\n\n'),
      memoryContext: [recall, breadcrumbs, volatile].filter(Boolean).join('\n\n'),
      capabilityContext: capabilityResolution,
      port,
    };
    preflightConversation = {
      port,
      settledProceedAuthor: startSettledPreflightConversationAuthor(prepared),
    };
  }
  // WHAT IS STILL OPEN. A separate, cross-family pass over the readings of this
  // request — the decision to ask cannot be made by the model that is trying to
  // finish the work, and it cannot be made from the request text alone. Gated
  // on the runtime's OWN facts rather than on grammar: a turn that resolved real
  // capabilities is a turn that is about to do something. Fail-open and
  // time-boxed, so it can inform a turn but never delay or break one.
  let turnOpenness: TurnOpenness | null = null;
  if (
    preflightSessionKind === 'chat'
    && request.taskContinuation?.disposition !== 'declined'
    && turnOpennessEnabled()
    // EITHER signal is enough, and the first one matters most (live 2026-08-07,
    // an hour after this shipped): gating on resolved capabilities ALONE made
    // the pass silent on exactly the requests that need it. Capability
    // resolution only produces entries when a PROVEN memo matches, so a novel
    // ask resolves to nothing — and a novel ask is the most ambiguous kind
    // there is. The live miss: "pull 5 stale accounts in salesforce and help me
    // draft some emails" resolved zero capabilities, so the pass never ran,
    // while the preflight had already typed the turn as consequential with an
    // unstated destination. The signal was sitting right there. Same shape as
    // the vocabulary bug this pass was built to replace: gate on something
    // frequently empty and you ship silence.
    && (Boolean(confirmBeat) || turnOpennessWarranted(resolvedCapabilityEntries))
  ) {
    try {
      turnOpenness = await resolveTurnOpenness({
        message: taskInput,
        brainFamily: turnOpennessBrainFamily(activeModelId),
        capabilityBlock: capabilityResolution,
        memoryBlock: recall,
      });
    } catch { turnOpenness = null; }
  }
  const opennessContext = renderTurnOpennessForContext(turnOpenness);
  // Pre-flight error library (parity with the context packet's Known-pitfalls
  // line — this lane doesn't consume the packet): the freshest distilled
  // lessons for the skills this turn will likely use, so a known failure mode
  // isn't repeated. Bounded to a couple of lines; empty for most turns.
  let pitfalls = '';
  if (!declinedContinuation) {
    try { pitfalls = knownPitfallLineForInput(taskInput) ?? ''; } catch { pitfalls = ''; }
  }
  // Project-command deliverable routes (parity with the context packet — this
  // lane doesn't consume the packet): when the ask matches a local project's
  // own slash command, steer to project_run instead of an in-loop rebuild.
  let projectRoutes = '';
  if (!declinedContinuation) {
    try { projectRoutes = projectCommandsLineForInput(taskInput) ?? ''; } catch { projectRoutes = ''; }
  }
  let harnessHealth = '';
  try { harnessHealth = renderHarnessCapabilityHealthForContext({ limit: 3 }); } catch { harnessHealth = ''; }
  // CONVERGENCE: carry the user's answer forward and forbid re-asking the
  // resolved point, without turning every exploratory reply into permission to
  // execute. Kill-switch CLEMMY_BRAIN_CONVERGE=off.
  let convergenceSteer = '';
  if (
    convergenceSteerEnabled()
    && (Boolean(request.taskContinuation)
      || (!request.taskContinuationResolved
        && !opts?.sourceUserSeq
        && priorTurnEndedAwaitingClarification(request.sessionId)))
  ) {
    convergenceSteer = CONVERGENCE_STEER;
  }
  const declinedParentPolicy = declinedParentWithNewTask
    ? 'Typed continuation result: the user declined the prior proposal and supplied separate new work. Keep the full reply conversationally intact, but treat only the fresh clause as active authority; do not revive, retrieve for, or prepare tools from the declined parent.'
    : '';
  const capabilityCandidateCard = splitContext
    ? renderCapabilityCandidateCard(request.turnCandidates)
    : '';
  return {
    text: [
      convergenceSteer,
      declinedParentPolicy,
      capabilityCandidateCard,
      volatile,
      relevantSkills,
      continuationContext,
      harnessHealth,
      recall,
      breadcrumbs,
      prospectiveContext,
      prospectiveCapture,
      sessionActions,
      fanoutDirective,
      confirmBeat,
      capabilityResolution,
      opennessContext,
      pitfalls,
      projectRoutes,
    ].filter(Boolean).join('\n\n'),
    memoryPrimer,
    preflight,
    ...(preflightConversation ? { preflightConversation } : {}),
    alignmentContext: {
      conversationContext: [continuationContext, sessionActions].filter(Boolean).join('\n\n'),
      memoryContext: [recall, breadcrumbs, volatile].filter(Boolean).join('\n\n'),
      capabilityContext: capabilityResolution,
      openness: turnOpenness,
    },
  };
}

export async function renderClaudeAgentBrainTurnContext(
  request: AssistantRequest,
  opts?: { sourceUserSeq?: number },
): Promise<string> {
  return (await buildClaudeAgentBrainTurnContext(request, opts)).text;
}

function emitClaudeAgentSdkBrainContextTelemetry(
  sessionId: string,
  request: AssistantRequest,
  turnContext: string,
  primer?: ClaudeTurnMemoryPrimerTelemetry,
): void {
  const declinedContinuation = isDeclinedTaskContinuation(request);
  const semanticEnrichmentSkippedReason = primer?.skippedReason === 'durable_memory_receipt_conversation_only'
    ? primer.skippedReason
    : declinedContinuation
      ? 'declined_continuation'
      : null;
  const query = retrievalTaskInput(request).replace(/\s+/g, ' ').trim();
  const recallBlocks = turnContext.split('\n\n').filter((block) =>
    block.startsWith('[MEMORY PRIMER]')
    || block.startsWith('## Relevant To Your Request')
    || block.startsWith('[ALSO IN MEMORY'),
  );
  const recallText = recallBlocks.join('\n\n');
  const injectedBytes = Buffer.byteLength(recallText, 'utf-8');
  const injected = injectedBytes > 0;
  const unified = recallBlocks.some((block) => block.startsWith('[MEMORY PRIMER]'));
  const refs = unified ? [...recallText.matchAll(/\[ref\s+(?:fact|note|entity|resource|episode|policy|procedure):[^\]]+\]/g)].length : null;
  const recallId = recallText.match(/recall:\s*([^;\]\s]+)/i)?.[1] ?? null;
  const answerability = recallText.match(/answerability:\s*(supported|partial|insufficient)/i)?.[1] ?? null;
  const includedCount = primer?.hitCount ?? refs ?? 0;
  const omittedCount = primer?.omittedCount ?? 0;
  const prospectiveBlock = turnContext.split('\n\n')
    .find((block) => block.startsWith('[RELEVANT FUTURE INTENTIONS')) ?? '';
  const prospectiveBytes = Buffer.byteLength(prospectiveBlock, 'utf-8');
  const prospectiveCount = prospectiveBlock
    ? prospectiveBlock.split('\n').filter((line) => line.startsWith('- [')).length
    : 0;
  const prospectiveCaptureSuggested = turnContext.includes('Prospective-intention signal:');
  try {
    appendEvent({
      sessionId,
      turn: 1,
      role: 'system',
      type: 'turn_memory_primer',
      data: {
        enabled: primer?.enabled ?? true,
        queryPreview: query.slice(0, 160),
        hitCount: includedCount,
        includedCount,
        omittedCount,
        candidateCount: primer?.candidateCount ?? includedCount + omittedCount,
        injected,
        injectedBytes,
        source: primer?.source ?? (unified ? 'unified' : injected ? 'legacy_fallback' : null),
        recallId: primer?.recallId ?? recallId,
        answerability: primer?.answerability ?? answerability,
        stores: primer?.stores ?? [],
        recallElapsedMs: primer?.recallElapsedMs ?? null,
        skippedReason: primer?.skippedReason ?? (injected ? null : 'no_hits'),
      },
    });
  } catch { /* telemetry must never block the turn */ }
  try {
    appendEvent({
      sessionId,
      turn: 1,
      role: 'system',
      type: 'agent_context_packet',
      data: {
        inputPreview: query.slice(0, 160),
        semanticEnrichmentSkippedReason,
        complexity: 'provider_managed',
        memory: {
          enabled: primer?.enabled ?? true,
          injected,
          source: primer?.source ?? (unified ? 'unified' : injected ? 'legacy_fallback' : null),
        },
        prospective: {
          injected: prospectiveCount > 0,
          count: prospectiveCount,
          bytes: prospectiveBytes,
          captureSuggested: prospectiveCaptureSuggested,
        },
        skills: { detected: false },
        workflows: { detected: false },
        toolScope: { lane: 'claude_agent_sdk_brain' },
        mcp: { lane: 'claude_agent_sdk_brain' },
        healthWarnings: [],
        agentSystem: { lane: 'claude_agent_sdk_brain' },
        multiItem: {
          detected: semanticEnrichmentSkippedReason
            ? false
            : (() => { try { return detectMultiItemIntent(retrievalTaskInput(request)).isMultiItem; } catch { return false; } })(),
        },
        injectedBytes,
      },
    });
  } catch { /* telemetry must never block the turn */ }
  try {
    appendEvent({
      sessionId,
      turn: 1,
      role: 'system',
      type: 'reasoning_effort',
      data: {
        effort: 'provider_default',
        reason: 'claude_agent_sdk_brain_provider_managed',
        kind: 'chat',
        transport: 'claude_agent_sdk_brain',
      },
    });
  } catch { /* telemetry must never block the turn */ }
}

function cancelledBrainResponse(
  sessionId: string,
  attempt: Pick<RunAttemptRef, 'attemptId' | 'runId'>,
  sourceUserSeq: number,
  sourceTurn: number,
  text = 'Stopped — you asked me to halt this run. Nothing further will execute; tell me how you\'d like to proceed.',
): AssistantResponse {
  try { clearKill(sessionId, attempt); } catch { /* one-shot latch cleanup */ }
  const identity: TurnIdentity = {
    sessionId,
    turn: sourceTurn,
    sourceUserSeq,
    attemptId: attempt.attemptId,
    ...(attempt.runId ? { runId: attempt.runId } : {}),
  };
  // A stop that handed this attempt to a durable background owner is a
  // TRANSFER, not a cancellation. Reporting it as cancelled tells the user
  // their work stopped while a worker is still running it.
  const transfer = (() => {
    try { return handoffTransferForAttempt(sessionId, attempt.attemptId); } catch { return undefined; }
  })();
  const terminal = commitTurnOutcome(transfer
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
        presentation: { kind: 'stopped', text },
      }, {
    legacyReason: transfer ? 'transferred' : 'cancelled',
    metadata: {
      transport: 'claude_agent_sdk_brain',
      ...(transfer ? { transferredToTaskId: transfer.backgroundTaskId } : {}),
    },
  });
  const committedText = terminal.presentation.text;
  // Only the process that won the durable terminal append may broadcast the
  // runtime terminal. This prevents the Tasks board/report-back from settling
  // twice when cancellation races the SDK's final stream message.
  if (terminal.inserted) {
    try { actionBus.emit({ kind: 'runtime.completed', sessionId }); } catch { /* best-effort */ }
  }
  try { updateSession(sessionId, { status: 'cancelled' }); } catch { /* observability metadata */ }
  clearRunInFlightAfterTerminal(sessionId, attempt.attemptId, sourceUserSeq);
  return {
    text: committedText,
    sessionId,
    stoppedReason: 'cancelled',
    turnsUsed: 0,
    raw: { transport: 'claude_agent_sdk_brain', cancelled: 'run_attempt' },
  };
}

/**
 * Run-attempt wrapper around the SDK brain. Interactive channels can
 * pre-register the same `request.runId` before dispatch; beginning it again is
 * idempotent. A stop aimed at that attempt survives startup, while a kill row
 * aimed at a superseded attempt is cleared before any model/tool work begins.
 */
export async function respondViaClaudeAgentSdkBrain(
  surface: ClaudeAgentBrainSurface,
  request: AssistantRequest,
): Promise<AssistantResponse> {
  const sessionId = request.sessionId;
  const displayMessage = request.displayMessage ?? request.message;
  const mode = claudeAgentSdkBrainMode() ?? 'read_only';
  if (!getSession(sessionId)) {
    const titleSeed = displayMessage.trim().replace(/\s+/g, ' ');
    createSession({
      id: sessionId,
      kind: durableSessionKind(composeSession({ sessionId }), { surface }),
      channel: request.channel,
      userId: request.userId,
      title: titleSeed.length > 80 ? `${titleSeed.slice(0, 77)}...` : titleSeed,
      metadata: { source: `claude-agent-sdk-brain:${surface}`, readOnly: mode === 'read_only', mode },
    });
  }

  let attempt = beginRunAttempt(sessionId, { runId: request.runId });
  const requestedSource = Number.isSafeInteger(request.sourceUserSeq) && Number(request.sourceUserSeq) > 0
    ? listEvents(sessionId, {
        sinceSeq: Number(request.sourceUserSeq) - 1,
        types: ['user_input_received'],
        limit: 1,
      }).find((event) => event.seq === Number(request.sourceUserSeq))
    : undefined;
  if (request.sourceUserSeq !== undefined && !requestedSource) {
    throw new Error(`Accepted user event ${request.sourceUserSeq} is missing from session ${sessionId}.`);
  }
  const routeAcceptedSource = requestedSource ?? (
    request.channel === 'desktop' && request.runId
      ? findUserInputEventForRun(sessionId, request.runId, displayMessage)
      : null
  );
  let acceptedSource;
  if (routeAcceptedSource) {
    const bound = getRunAttemptSourceUserEvent(attempt);
    if (bound && bound.seq !== routeAcceptedSource.seq) {
      try { finishRunAttempt(attempt, 'superseded'); } catch { /* best effort */ }
      attempt = beginRunAttempt(sessionId);
    }
    acceptedSource = recordRunAttemptUserInput(attempt, {
      turn: routeAcceptedSource.turn,
      role: 'user',
      data: {
        text: displayMessage,
        ...(request.runId ? { runId: request.runId } : {}),
      },
    }, { existingEventSeq: routeAcceptedSource.seq, armRunInFlight: true });
  } else {
    // Bind the physical attempt before any model work, including context
    // helpers and the post-response completion judge. The inner attempt reuses
    // this exact event, so direct SDK callers and pre-accepted desktop turns
    // share one source identity without appending a duplicate user row.
    acceptedSource = recordRunAttemptUserInput(attempt, {
      turn: 1,
      role: 'user',
      data: {
        text: displayMessage,
        ...(displayMessage !== request.message ? { modelDirectiveApplied: true } : {}),
        ...(request.runId ? { runId: request.runId } : {}),
      },
    }, { armRunInFlight: true });
  }
  preserveCurrentKillAndClearStale(sessionId, attempt);
  // Re-derive private continuation state from the exact accepted source. An
  // outer caller cannot widen retrieval/MCP scope by supplying semantic text.
  request = await enrichAcceptedRequestWithTaskContinuity(request, acceptedSource.seq);
  const callerShouldCancel = request.shouldCancel;
  const scopedRequest: AssistantRequest = {
    ...request,
    // Give no-run-id callers a stable attempt identity for terminal de-dupe.
    runId: request.runId ?? attempt.attemptId,
    shouldCancel: async () => {
      if (isKillRequested(sessionId, attempt)) return true;
      return callerShouldCancel ? Boolean(await callerShouldCancel()) : false;
    },
  };
  let status: 'completed' | 'cancelled' | 'failed' = 'failed';
  let preserveAttemptOwnership = false;
  try {
    const response = await withModelUsageAttribution({
      sessionId,
      sourceUserSeq: acceptedSource.seq,
      attemptId: attempt.attemptId,
    }, () => respondViaClaudeAgentSdkBrainAttempt(surface, scopedRequest, attempt));
    if (response.stoppedReason === 'in-progress') {
      preserveAttemptOwnership = true;
    } else {
      status = response.stoppedReason === 'cancelled' ? 'cancelled' : 'completed';
    }
    return response;
  } catch (err) {
    const acceptedSource = routeAcceptedSource ?? getRunAttemptSourceUserEvent(attempt);
    if (
      err instanceof PendingWorkflowChatDispatchOwnershipError
      && acceptedSource
      && err.ownership.originSessionId === acceptedSource.sessionId
      && err.ownership.sourceUserSeq === acceptedSource.seq
    ) {
      preserveAttemptOwnership = true;
    } else if (acceptedSource) {
      try {
        preserveAttemptOwnership = readPendingWorkflowChatDispatchOwnership({
          sessionId: acceptedSource.sessionId,
          sourceUserSeq: acceptedSource.seq,
        }) !== null;
      } catch {
        // The ownership ledger participates in the no-terminal proof. An
        // unreadable exact-source state cannot authorize this inner wrapper
        // to settle the attempt before the outer bridge/restart reconciler.
        preserveAttemptOwnership = true;
      }
    }
    throw err;
  } finally {
    if (!preserveAttemptOwnership) {
      try { finishRunAttempt(attempt, status); } catch { /* attempt telemetry must not mask the response */ }
    }
    if (status === 'cancelled') {
      try { clearKill(sessionId, attempt); } catch { /* best effort */ }
    }
  }
}

async function respondViaClaudeAgentSdkBrainAttempt(
  surface: ClaudeAgentBrainSurface,
  request: AssistantRequest,
  attempt: RunAttemptRef,
): Promise<AssistantResponse> {
  const sessionId = request.sessionId;
  const displayMessage = request.displayMessage ?? request.message;
  // A declined continuation keeps A/Q/B available to the conversational
  // context builder, but tool acquisition ranks only the literal decline. This
  // avoids paying for—or tempting the model with—the parent action surface.
  const declinedContinuation = isDeclinedTaskContinuation(request);
  const declinedParentWithNewTask = isDeclinedParentWithNewTask(request);
  const parentAuthorityDeclined = taskContinuationDeclinesParent(request);
  const taskInput = retrievalTaskInput(request);
  // Anchor for the post-turn recall-run sweep: this lane's memory tools run in
  // a separate MCP process, so their recall-run ids are recoverable only by
  // (session_id, created_at >= turn start) from the shared DB.
  const turnStartedAt = new Date().toISOString();
  const mode = claudeAgentSdkBrainMode() ?? 'read_only';
  const completionJudgeForSurface = surface !== 'background' && surface !== 'cron' && completionJudgeEnabled();
  const sessionMount = composeSessionFromStore(sessionId, { toolAllowlist: request.allowedToolNames });
  if (!getSession(sessionId)) {
    const titleSeed = displayMessage.trim().replace(/\s+/g, ' ');
    createSession({
      id: sessionId,
      kind: durableSessionKind(sessionMount, { surface }),
      channel: request.channel,
      userId: request.userId,
      title: titleSeed.length > 80 ? `${titleSeed.slice(0, 77)}...` : titleSeed,
      metadata: { source: `claude-agent-sdk-brain:${surface}`, readOnly: mode === 'read_only', mode },
    });
  }

  // Record the user's turn so the SDK brain is a proper session citizen: the
  // workflow-run boundary guard, session history, recall, and report-back all
  // read `user_input_received`. Without it the brain's tools (e.g. workflow_run)
  // can't see what the user actually asked for.
  // Multi-turn history: read the session's PRIOR turns BEFORE appending the
  // current one (so the current message isn't echoed as "prior"). Threaded into
  // runOptions below so every attempt (incl. retries/judge continuations) keeps
  // context. The SDK lane is stateless, so without this the brain sees only the
  // latest message — the "no chat history available" wrong-task bug.
  // The desktop may have durably recorded this input before selecting a brain.
  // Reuse only an exact, unsettled request match; background/workflow run ids
  // can intentionally span distinct messages and must never be a dedupe key.
  const requestedUserInput = Number.isSafeInteger(request.sourceUserSeq) && Number(request.sourceUserSeq) > 0
    ? listEvents(sessionId, {
        sinceSeq: Number(request.sourceUserSeq) - 1,
        types: ['user_input_received'],
        limit: 1,
      }).find((event) => event.seq === Number(request.sourceUserSeq))
    : undefined;
  if (request.sourceUserSeq !== undefined && !requestedUserInput) {
    throw new Error(`Accepted user event ${request.sourceUserSeq} is missing from session ${sessionId}.`);
  }
  const boundUserInput = getRunAttemptSourceUserEvent(attempt);
  const preRecordedUserInput = requestedUserInput ?? boundUserInput ?? (
    request.channel === 'desktop' && request.runId
      ? findUserInputEventForRun(sessionId, request.runId, request.message)
      : null
  );
  const preRecordedText = typeof preRecordedUserInput?.data.text === 'string'
    ? preRecordedUserInput.data.text
    : '';
  let priorTurns: Array<{ who: 'user' | 'assistant'; text: string }> = [];
  if (sessionHistoryEnabled()) {
    try {
      priorTurns = pullRecentTurnsForSession(openEventLog(), sessionId, 6).map((t) => ({ who: t.who, text: t.text }));
      if (
        preRecordedUserInput
        && priorTurns.at(-1)?.who === 'user'
        && priorTurns.at(-1)?.text === preRecordedText
      ) {
        priorTurns.pop();
      }
    } catch { priorTurns = []; }
  }

  // Source identity is execution-critical, not best-effort telemetry. Insert
  // and bind in one transaction (or consume the route's existing binding)
  // before any agentic tool can dispatch.
  const userInputEvent = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: {
      text: displayMessage,
      ...(displayMessage !== request.message ? { modelDirectiveApplied: true } : {}),
      ...(request.runId ? { runId: request.runId } : {}),
    },
  }, { existingEventSeq: preRecordedUserInput?.seq, armRunInFlight: true });
  const graphEvent = await recordAcceptedSourceGraph({
    identity: {
      sessionId,
      turn: userInputEvent.turn,
      sourceUserSeq: userInputEvent.seq,
    },
    surface,
    acceptedText: displayMessage,
    allowedToolNames: request.allowedToolNames,
    excludedToolNames: request.excludeToolNames,
    verifiedTaskContinuation: request.taskContinuation,
  });
  const compiledGraph = turnGraphFromShadowEvent(graphEvent);
  if (!compiledGraph) {
    const refused = commitUnadmittedSemanticTurn({
      sessionId,
      turn: userInputEvent.turn,
      sourceUserSeq: userInputEvent.seq,
    });
    return {
      sessionId,
      text: refused.text,
      stoppedReason: 'blocked',
    };
  }
  // Match the standard harness seam: no provider/model/tool work begins until
  // this exact source's hash-validated graph has durable cutover authority.
  // Re-entry from the bridge or a brain fallover observes the existing marker;
  // it never arms an independent task.
  let providerCapabilityRoute = compiledGraph.classification.route ?? 'direct_reply';
  {
    requireAcceptedTaskAuthority({
      sessionId,
      sourceUserSeq: userInputEvent.seq,
    });
    const dispatched = await dispatchAdmittedSource({
      sessionId,
      turn: userInputEvent.turn,
      sourceUserSeq: userInputEvent.seq,
    });
    if (dispatched.kind === 'blocked') {
      return {
        sessionId,
        text: dispatched.text,
        stoppedReason: 'blocked',
      };
    }
    if (dispatched.kind === 'needs_input') {
      return {
        sessionId,
        text: dispatched.text,
        stoppedReason: 'awaiting-input',
      };
    }
    if (dispatched.kind === 'held') {
      return {
        sessionId,
        text: 'This exact task is still owned by Clem\'s recovery system. I did not start a duplicate attempt; the existing work will continue from its durable checkpoint.',
        stoppedReason: 'in-progress',
        raw: { transport: 'claude_agent_sdk_brain', typedExecution: dispatched.hold },
      };
    }
    if (dispatched.kind === 'typed') {
      const ran = dispatched.result;
      if (ran.status !== 'success' || !ran.artifactHandle) {
        const raw = ran.error ?? 'Typed construct failed closed before publish.';
        return {
          sessionId,
          text: isHostAuthorityHeldReason(raw)
            ? heldExecutionTextForInternalReason(raw, ran.status === 'uncertain' ? 'uncertain' : 'blocked')
            : raw,
          stoppedReason: 'blocked',
        };
      }
      return { sessionId, text: ran.artifactHandle, stoppedReason: 'success' };
    }
    providerCapabilityRoute = dispatched.capabilityRoute;
    requireKnownExpectedWorkContract({
      sessionId,
      sourceUserSeq: userInputEvent.seq,
    });
    if (providerCapabilityRoute === 'act') {
      requireActionExpectedWorkActivation({
        sessionId,
        sourceUserSeq: userInputEvent.seq,
      });
    }
  }
  // The shared dispatcher owns the provider-facing route. An accepted action
  // retains its expected-work carrier; callers may not downgrade it to the
  // generic conversation dispatcher to keep tools mounted.
  const acceptedActionSurface = providerCapabilityRoute === 'act';
  // The standard lane receives this provider-neutral requirement projection at
  // its capability-resolve node. Claude diverges before that node, so derive
  // the same bounded advisory projection here when the caller did not already
  // carry one. It grants no tool authority; it only supplies the immutable role
  // membership used by discovery admission and the candidate card.
  if (
    acceptedActionSurface
    && !declinedContinuation
    && request.turnCandidates === undefined
  ) {
    try {
      request = {
        ...request,
        turnCandidates: await resolveTurnCapabilityCandidates({ userInput: taskInput }),
      };
    } catch {
      // Missing projection is a compatibility state, never an all-resolved
      // claim. initializeRoles below therefore keeps the legacy task-wide slot.
    }
  }
  // Source binding and restart ownership committed atomically above. Any crash
  // during context, memory, tool-surface, or provider setup is recoverable.
  try {
    // Working signal: a turn_started lights the existing elapsed-time/pulse so a
    // long turn never reads as frozen (the Codex lane emits this; the SDK lane
    // didn't). role:'system' → no spurious agent label.
    appendEvent({ sessionId, turn: 1, role: 'system', type: 'turn_started', data: {} });
  } catch { /* best effort — never block the turn */ }

  // Memory writeback parity with the main harness loop. The Claude Agent SDK
  // brain can truthfully answer a "remember this" turn without calling
  // memory_remember, so run the same deterministic auto-capture fallback here
  // for real chat turns. Errors are swallowed: memory capture must not block the
  // model turn, but the trace records candidate signals when it does engage.
  let durableMemoryConversationOnly = false;
  try {
    const session = getSession(sessionId);
    // Capture the exact accepted user source on every delivery. Durable intake
    // de-duplicates by this stable source identity, so a daemon restart can
    // safely retry without losing or duplicating the user's memory. For a
    // compound decline, only the independent fresh clause is active memory
    // authority; the parent cancellation remains conversational transcript.
    const acceptedDisplayText = typeof userInputEvent.data.displayText === 'string'
      ? userInputEvent.data.displayText
      : typeof userInputEvent.data.text === 'string'
        ? userInputEvent.data.text
        : displayMessage;
    const captureMessage = declinedParentWithNewTask ? taskInput : acceptedDisplayText;
    const shouldCapture = session?.kind === 'chat';
    const captured = shouldCapture
      ? captureInteractionSignals({
          message: captureMessage,
          sessionId,
          sourceEventId: `user-source:${userInputEvent.seq}`,
          occurredAt: userInputEvent.createdAt,
        })
      : { candidates: [], facts: [], queuedCandidateIds: [], profilePatch: undefined, profile: undefined };
    const queuedCandidateCount = captured.queuedCandidateIds?.length ?? 0;
    // The caller tuple and conversationOnly telemetry are never completion
    // authority. Re-read the accepted source plus the exact memory episode and
    // candidate rows, then bind one content-addressed host receipt. The explicit
    // caller allowlist still keeps the ordinary model/tool presentation path,
    // but it cannot mint or weaken the receipt itself.
    const hostCompletion = shouldCapture
      ? prepareDurableMemoryIntakeHostCompletion({
          sessionId,
          sourceUserSeq: userInputEvent.seq,
        })
      : { status: 'missing' as const, reason: 'not a chat source' };
    durableMemoryConversationOnly = (request.allowedToolNames === undefined || request.allowedToolNames.length === 0)
      && hostCompletion.status === 'redeemed';
    if (captured.candidates.length > 0 || captured.profilePatch) {
      appendEvent({
        sessionId,
        turn: 1,
        role: 'system',
        type: 'memory_signals_captured',
        data: {
          factCount: captured.candidates.length,
          queuedCandidateCount,
          episodeId: captured.episodeId ?? null,
          profilePatch: captured.profilePatch ?? null,
          reasons: captured.candidates.map((candidate) => candidate.reason),
          sourceUserSeq: userInputEvent.seq,
          conversationOnly: durableMemoryConversationOnly,
          hostReceiptId: hostCompletion.status === 'redeemed'
            ? hostCompletion.receiptId
            : null,
        },
      });
    }
  } catch { /* auto-capture is opportunistic and must never block a turn */ }

  if (request.shouldCancel && await request.shouldCancel()) {
    try {
      appendEvent({ sessionId, turn: 0, role: 'system', type: 'kill_requested', data: { reason: 'before model dispatch', attemptId: attempt.attemptId } });
    } catch { /* telemetry best-effort */ }
    return cancelledBrainResponse(
      sessionId,
      attempt,
      userInputEvent.seq,
      userInputEvent.turn,
      'Stopped — the run was cancelled before model dispatch. Nothing executed.',
    );
  }

  const modelId = request.model && request.model.startsWith('claude-')
    ? request.model
    : resolveRoleModel('brain').modelId;

  // Resolve memory, cross-session continuity, capability facts, openness, and
  // the typed preflight before assembling any ordinary tool surface. An align
  // source takes the sealed no-tool conversation path below and never reaches
  // Claude's tool-capable SDK run.
  const renderedTurnContext = durableMemoryConversationOnly
    ? {
        text: '',
        memoryPrimer: {
          enabled: queryRecallEnabled(),
          hitCount: 0,
          omittedCount: 0,
          candidateCount: 0,
          source: null,
          recallId: null,
          answerability: null,
          stores: [],
          recallElapsedMs: null,
          skippedReason: 'durable_memory_receipt_conversation_only',
        } satisfies ClaudeTurnMemoryPrimerTelemetry,
        preflight: {
          phase: 'execute',
          consequential: false,
          reason: 'ordinary_execution',
        } satisfies TurnPreflightDecision,
        preflightConversation: undefined,
        alignmentContext: {
          conversationContext: '',
          memoryContext: '',
          capabilityContext: '',
          openness: null,
        },
      }
    : await buildClaudeAgentBrainTurnContext(request, {
        sourceUserSeq: userInputEvent.seq,
        sourceTurn: userInputEvent.turn,
        prestartSettledConversation: true,
        conversationContext: renderTranscriptTurns(priorTurns),
      });
  const durableMemoryReceiptDirective = durableMemoryConversationOnly
    ? [
        '[durable-memory-receipt]',
        'This exact memory instruction is already durably queued. The user requested acknowledgement only.',
        'The literal latest user message is authoritative and supersedes any older conflicting value in persistent context.',
        'Do not mention internal machinery. Acknowledge it naturally in your own voice without searching for or calling tools.',
      ].join('\n')
    : '';
  let turnContext = durableMemoryReceiptDirective
    ? [renderedTurnContext.text, durableMemoryReceiptDirective].filter(Boolean).join('\n\n')
    : renderedTurnContext.text;
  emitClaudeAgentSdkBrainContextTelemetry(sessionId, request, turnContext, renderedTurnContext.memoryPrimer);

  if (renderedTurnContext.preflight.phase === 'align') {
    const disposition = await publishPreflightConversation({
      identity: {
        sessionId,
        turn: userInputEvent.turn,
        sourceUserSeq: userInputEvent.seq,
      },
      decision: renderedTurnContext.preflight,
      conversationContext: [
        renderTranscriptTurns(priorTurns),
        renderedTurnContext.alignmentContext.conversationContext,
      ].filter(Boolean).join('\n\n'),
      memoryContext: renderedTurnContext.alignmentContext.memoryContext,
      capabilityContext: renderedTurnContext.alignmentContext.capabilityContext,
      openness: renderedTurnContext.alignmentContext.openness,
      port: renderedTurnContext.preflightConversation?.port
        ?? preflightConversationPortForTest
        ?? createAgentsPreflightConversationPort({ model: getClaudeHeadlessModel(modelId) }),
      ...(renderedTurnContext.preflightConversation?.settledProceedAuthor
        ? { settledProceedAuthor: renderedTurnContext.preflightConversation.settledProceedAuthor }
        : {}),
      transport: 'claude_agent_sdk_brain',
    });
    if (disposition.kind === 'ask') {
      try { actionBus.emit({ kind: 'runtime.completed', sessionId }); } catch { /* best-effort */ }
      clearRunInFlightAfterTerminal(sessionId, attempt.attemptId, userInputEvent.seq);
      return {
        text: disposition.presentation.text,
        sessionId,
        stoppedReason: 'awaiting-input',
        turnsUsed: 1,
        raw: {
          transport: 'claude_agent_sdk_brain',
          mode,
          model: modelId,
          toolUses: [],
          preflightPhase: 'align',
        },
      };
    }
    if (disposition.preamble) {
      const persisted = appendConversationPreambleOnce({
        source: userInputEvent,
        text: disposition.preamble,
        ...(renderedTurnContext.preflight.intentKey
          ? { intentKey: renderedTurnContext.preflight.intentKey }
          : {}),
      });
      const persistedText = typeof persisted.event.data.text === 'string'
        ? persisted.event.data.text
        : disposition.preamble;
      if (request.onConversationPreamble) {
        const delivered = await request.onConversationPreamble(
          conversationPreambleDeliveryRequest(persisted.event),
        );
        if (delivered.status === 'failed') {
          const identity: TurnIdentity = {
            sessionId,
            turn: userInputEvent.turn,
            sourceUserSeq: userInputEvent.seq,
          };
          const terminal = commitTurnOutcome({
            version: 2,
            id: turnOutcomeId(identity),
            identity,
            status: 'failed',
            resumable: false,
            presentation: { kind: 'error', text: PUBLIC_RUN_FAILURE_TEXT },
          }, {
            legacyReason: 'pre_execution_presentation_failed',
            metadata: {
              transport: 'claude_agent_sdk_brain',
              failureStage: 'pre_execution_presentation',
              failureDetail: delivered.reason,
            },
          }).presentation;
          try { actionBus.emit({ kind: 'runtime.completed', sessionId }); } catch { /* best-effort */ }
          clearRunInFlightAfterTerminal(sessionId, attempt.attemptId, userInputEvent.seq);
          return {
            text: terminal.text,
            sessionId,
            stoppedReason: 'error',
            turnsUsed: 1,
            raw: {
              transport: 'claude_agent_sdk_brain',
              mode,
              model: modelId,
              toolUses: [],
              preflightPhase: 'align',
              preambleDelivery: delivered.reason,
            },
          };
        }
      }
      turnContext = [
        turnContext,
        '[pre-execution opening already delivered for this exact request]',
        persistedText,
        'Continue the requested work now; do not repeat this opening or ask for generic permission.',
      ].filter(Boolean).join('\n\n');
    }
  }

  // Tool acquisition for the Claude Agent SDK brain. In full/agentic mode, keep
  // the ENTIRE permission surface same-turn reachable while registering only a
  // tiny hot set plus tool_search/call_tool. Unlike native MCP deferral, omitted
  // definitions never enter provider accounting. This is an acquisition
  // mechanism, not permission pruning. If disabled, fall back to the legacy
  // semantic JIT behavior byte-for-byte.
  // An admitted direct reply is conversation, not an agent surface. Give the
  // provider no local or external tool authority and do no acquisition/ranking
  // work. Retrieve retains its read carrier; act retains work_call. A pure,
  // runtime-typed decline and a host-completed memory receipt are sealed by the
  // same zero-tool boundary.
  const conversationOnlyToolBoundary = providerCapabilityRoute === 'direct_reply'
    || declinedContinuation
    || durableMemoryConversationOnly;
  const explicitToolAuthority = request.allowedToolNames !== undefined || conversationOnlyToolBoundary;
  const fullToolPolicy = toolPolicyForRequest(
    conversationOnlyToolBoundary ? { ...request, allowedToolNames: [] } : request,
    mode,
  );
  const actionTaskState = acceptedActionSurface
    ? resolveActionTaskState({
        sessionId,
        userInput: request.message,
        taskContinuation: request.taskContinuation,
      })
    : { kind: 'fresh' as const };
  const fullAllowed = projectClaudeAcceptedActionSurface(
    fullToolPolicy.names,
    acceptedActionSurface,
    actionTaskState.kind,
  );
  const advertisedUniverse = projectClaudeAcceptedActionSurface(
    claudeAgentSdkAdvertisedToolUniverse(
    mode,
    fullAllowed,
    request.excludeToolNames,
    explicitToolAuthority,
    ),
    acceptedActionSurface,
    actionTaskState.kind,
  );
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'tool_policy_resolved',
      data: {
        ...fullToolPolicy.diagnostics,
        ...(conversationOnlyToolBoundary
          ? {
              shortCircuitReason: declinedContinuation
                ? 'declined_continuation'
                : durableMemoryConversationOnly
                  ? 'durable_memory_receipt_conversation_only'
                  : 'direct_reply_conversation_only',
              semanticAcquisitionSkipped: true,
              schemaWarmSkipped: true,
              advertisedSchemaCount: 0,
              catalogCount: 0,
            }
          : {}),
      },
    });
  } catch { /* tool policy telemetry must never block the turn */ }
  const jitDecision = resolveToolJitDecision({ allowLane: true, sessionId });
  let jitAllowed = fullAllowed;
  let jitAdvertised = advertisedUniverse;
  // `undefined` means the normal/default surface; an explicit empty array is a
  // real zero-authority boundary and must survive every layer unchanged.
  let mcpToolAllowlist: string[] | undefined = explicitToolAuthority
    ? [...advertisedUniverse]
    : undefined;
  let jitDropped = 0;
  let jitReason = jitDecision.active ? 'jit-active-no-reduction' : 'jit-inactive';
  // The acquisition bridge itself is extra authority. Exact per-call
  // allowlists therefore remain first-class and never gain tool_search or
  // call_tool implicitly.
  const schemaOnDemandAcquisition =
    !conversationOnlyToolBoundary
    && mode === 'full'
    && !explicitToolAuthority
    && claudeToolSearchEnabled();
  const priorBrainInputs = parentAuthorityDeclined
    ? []
    : [
        request.taskContinuation?.parentInput ?? '',
        ...recentPriorBrainInputs(sessionId, request.message),
      ].filter((value, index, all) => value.trim() && all.indexOf(value) === index);
  const jitQuery = [taskInput, ...priorBrainInputs]
    .filter((s) => s.trim().length > 0)
    .join('\n');
  if (schemaOnDemandAcquisition) {
    try {
      const firstClassCapable = new Set(claudeAgentSdkAdvertisableLocalTools());
      const hot = resolveHotSet(sessionId, jitQuery, {
        allowedNames: new Set(advertisedUniverse),
      });
      // A dock chat IS editing a Workspace. Keep only its common read/targeted-
      // edit kernel first-class; every runner/publish/revert/save schema remains
      // same-turn reachable through tool_search → call_tool. Pinning the entire
      // feature group here defeated schema-on-demand specifically in Workspace
      // chats—the surface where the prompt is already carrying a living brief.
      pinCompositionHotTools(hot, sessionMount, advertisedUniverse);
      // MONOTONIC FLOOR — the cache lever, which this branch was missing.
      //
      // The hot set is recomputed per turn from the tools the user happened to
      // name plus a recent-use tail, so the advertised set moved turn to turn:
      // live sessions show 4 → 5 → 8 → 10, and one that went 8 → 7. Changing a
      // tool DEFINITION invalidates the tools block AND the system prompt AND
      // the entire message history — tools sit first in the cache hierarchy, so
      // touching them resets everything behind them. That meant most turns of
      // most conversations rebuilt the whole prompt cache and re-paid the
      // persona, the tools, and all prior messages at ten times the cached rate,
      // with the latency to match. Measured hit ratio sat around 0.88 with dips
      // to 0.74 at exactly those turn boundaries.
      //
      // The floor only ever GROWS, so the tools block converges to byte-identical
      // and then holds for the rest of the session. Filtering the stable
      // advertised array (rather than iterating the set) keeps the ORDER
      // deterministic too — non-deterministic tool ordering is a documented way
      // to break the same cache. Same kill-switch and starvation-safety argument
      // as the sibling branch: the floor never drops below the per-turn
      // selection, so nothing becomes unreachable.
      const hotFloor = (jitMonotonicEnabled() && sessionId) ? bumpSessionToolFloor(sessionId, hot) : hot;
      // A local-runtime-only tool cannot become a first-class MCP schema. Leave
      // it deferred even when explicitly named; tool_search → call_tool remains
      // the truthful, gated route.
      jitAdvertised = advertisedUniverse.filter((name) => (
        hotFloor.has(name)
        && firstClassCapable.has(name)
        // Recovery/history remains behind the one bounded
        // tool_search→call_tool route even on a continuation; it never also
        // becomes a direct first-class schema.
        && (!acceptedActionSurface || actionControlContextFor(name) !== 'task_recovery')
      ));
      // Permissions remain fullAllowed. mcpToolAllowlist is the tiny first-class
      // schema set; the SDK omits every other schema and keeps it reachable via
      // tool_search → call_tool.
      jitAllowed = fullAllowed;
      mcpToolAllowlist = jitAdvertised;
      jitDropped = advertisedUniverse.length - jitAdvertised.length;
      jitReason = 'schema-on-demand-dispatch';
    } catch {
      jitAllowed = fullAllowed;
      jitAdvertised = advertisedUniverse;
      mcpToolAllowlist = undefined;
      jitDropped = 0;
      jitReason = 'schema-on-demand-selection-fellback';
    }
  } else if (!conversationOnlyToolBoundary && jitDecision.active && taskInput.trim()) {
    try {
      const descByName = await coreToolDescriptions();
      // Fold recent prior-turn messages into the ranking query so bare follow-ups
      // inherit the conversation's intent (parity with the Codex lane).
      const selection = await selectToolsForTurn({
        userInput: jitQuery,
        tools: advertisedUniverse.map((name) => ({ name, description: descByName.get(name) ?? '' })),
        recallPinned: [
          ...recallPinnedBuiltinTools(jitQuery),
          // Candidates resolved for the accepted turn ride the REQUEST — the
          // same delivery the Codex lane gets, so both brains see one surface.
          ...(request.turnCandidates?.pinnedTools ?? []),
        ],
      });
      pinCompositionTools(selection.exposed, sessionMount, fullAllowed);
      jitReason = selection.reason;
      if (selection.reduced) {
        // Monotonic JIT (cache lever): union this turn's selection into the
        // session's growing floor so the advertised set stabilizes and the SDK
        // prompt cache stops busting on per-turn tool variance.
        const exposed = (jitMonotonicEnabled() && sessionId)
          ? bumpSessionToolFloor(sessionId, selection.exposed)
          : selection.exposed;
        const partitioned = partitionClaudeAgentSdkJitSurface(fullAllowed, advertisedUniverse, exposed);
        jitAllowed = partitioned.fastAllowNames;
        jitAdvertised = partitioned.advertisedNames;
        mcpToolAllowlist = jitAdvertised;
        jitDropped = advertisedUniverse.length - jitAdvertised.length;
        if (jitDropped <= 0) {
          // Floor converged to the whole surface — advertise all (still cache-stable).
          mcpToolAllowlist = undefined;
          jitReason = 'jit-monotonic-converged-full';
        }
      }
    } catch {
      jitAllowed = fullAllowed; jitAdvertised = advertisedUniverse; mcpToolAllowlist = undefined; jitReason = 'jit-error-fellback';
    }
  }
  // Telemetry — emit on a real reduction. Tagged lane:'claude_sdk' to distinguish
  // from the Codex orchestrator lane in the readout.
  if (sessionId && jitDropped > 0) {
    try {
      appendEvent({
        sessionId, turn: 0, role: 'system', type: 'tool_jit_scope',
        data: {
          lane: 'claude_sdk',
          jitActive: schemaOnDemandAcquisition || jitDecision.active,
          acquisition: schemaOnDemandAcquisition ? 'tool_search_call_tool' : 'semantic_jit',
          droppedCount: jitDropped,
          exposedCount: jitAdvertised.length,
          fastAllowCount: jitAllowed.length,
          reason: jitReason,
        },
      });
    } catch { /* JIT telemetry must never block the turn */ }
  }

  // Provider text remains private until the graph reduces the run to a typed
  // TurnOutcome. Long-running feedback comes from typed tool/progress events,
  // not speculative prose that a retry or completion judge may invalidate.
  const attemptTrackerScopeId = `${sessionId}::brain:${attempt.runId ?? attempt.attemptId}`;
  // POLICY AUTHORITY is intentionally separate from retrieval context. The
  // private semantic task is A + Clem's question + B; using it here made a
  // literal correction such as "No" still look like A's requested write to
  // completion gates and corrective prompts. Only the exact accepted B (or an
  // exact typed preflight acknowledgement recovered from durable state) may
  // authorize effects and define completion.
  const materialClarificationAnswer = request.taskContinuation
    && (
      request.taskContinuation.disposition === 'selected'
      || request.taskContinuation.disposition === 'provided'
    )
    ? request.taskContinuation.answer.trim()
    : '';
  const turnObjective = declinedParentWithNewTask
    ? taskInput
    : materialClarificationAnswer || effectiveTurnObjective(
        sessionId,
        request.message,
        userInputEvent.seq,
      );
  // Keep the Claude-native external MCP surface observable with the same event
  // contract as the Codex lane. This is also the auditable proof that an
  // explicit local-only boundary resolved to zero external authority.
  const nativeMcpScope: McpToolScope = explicitToolAuthority
    ? {
        reason: 'Explicit local tool allowlist; native external MCP authority denied',
        authority: 'none',
        allowedServerSlugs: [],
        maxTools: 0,
      }
    : mode === 'full'
    ? resolveMcpToolScopeWithRecall({
        userInput: declinedParentWithNewTask ? taskInput : request.message,
        priorUserInputs: priorBrainInputs,
        pinnedCalendarLabels: pinnedCalendarRuleLabels(),
        configuredServerNames: enabledExternalServerNames(),
        ...(request.turnCandidates?.matches.length
          ? { learnedMatches: request.turnCandidates.matches }
          : {}),
        // An answer to Clem's own question keeps the scope the request earned,
        // however the user phrases the go-ahead. Same predicate the CONVERGE
        // steer already uses — the fact was known, just never consulted here.
        awaitingAnswer: Boolean(
          request.taskContinuation
          && request.taskContinuation.disposition !== 'declined'
          && request.taskContinuation.disposition !== 'declined_with_new_task'
        )
          || (!request.taskContinuationResolved
            && !request.sourceUserSeq
            && priorTurnEndedAwaitingClarification(sessionId)),
        ...(request.taskContinuation
          && request.taskContinuation.disposition !== 'declined_with_new_task'
          ? { answerDisposition: request.taskContinuation.disposition }
          : {}),
      })
    : {
        reason: `Claude SDK ${mode} mode does not attach native external MCP servers`,
        // A locked worker/workflow-step lane holds no external authority of its
        // own; its parent already bound whatever it is allowed to touch.
        authority: 'none',
        allowedServerSlugs: [],
        maxTools: 0,
      };
  // Arm role-scoped discovery only when the exact Claude surface can mount the
  // same two provider-neutral candidate adapters behind tool_search. Explicit
  // local allowlists and user-denied external authority retain builtins_only;
  // a missing requirement projection does too inside initializeRoles.
  const actionToolSearchCandidateSources = acceptedActionSurface
    && mode === 'full'
    && !explicitToolAuthority
    && mcpToolScopeAuthority(nativeMcpScope) !== 'none'
    ? buildAuthorizedToolSearchCandidateSources(nativeMcpScope)
    : undefined;
  if (acceptedActionSurface) {
    discoveryGovernor.initializeTask({
      sessionId,
      sourceUserSeq: userInputEvent.seq,
      knownCapability: false,
    });
    discoveryGovernor.initializeRoles({
      sessionId,
      sourceUserSeq: userInputEvent.seq,
      requirements: request.turnCandidates?.requirements ?? [],
      brokerCoverage: toolSearchBrokerCoverage(actionToolSearchCandidateSources),
    });
  }
  const nativeExternalInspectionAvailable = mode === 'full'
    && mcpToolScopeAuthority(nativeMcpScope) !== 'none';
  const localReadInspectionAvailable = !conversationOnlyToolBoundary
    && jitAllowed.some((toolName) => {
      try { return classifyRuntimeToolEffect(toolName, {}).effect === 'read'; } catch { return false; }
    });
  const continuationToolsAvailable = !conversationOnlyToolBoundary
    && (jitAllowed.length > 0 || nativeExternalInspectionAvailable);
  const continuationExternalStateInspectionAvailable = continuationToolsAvailable
    && (localReadInspectionAvailable || nativeExternalInspectionAvailable);
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'mcp_tool_scope',
      data: {
        reason: nativeMcpScope.reason,
        allowAll: !!nativeMcpScope.allowAll,
        allowedServerSlugs: nativeMcpScope.allowedServerSlugs ?? [],
        maxTools: nativeMcpScope.maxTools ?? null,
        lane: 'claude_sdk',
      },
    });
  } catch { /* scope telemetry must never block model dispatch */ }
  const freshExternalWriteRequired = objectiveRequiresFreshExternalWrite(turnObjective);
  const toolEconomyState = (() => {
    if (surface === 'background' || surface === 'cron' || !interactiveToolEconomyEnabled()) return undefined;
    let multiItem = false;
    try { multiItem = detectMultiItemIntent(turnObjective).isMultiItem; } catch { /* policy falls back to text shape */ }
    // The economy must respect the user's chosen budget preset: on long/
    // unlimited the hard stop lifts to the preset's per-turn tool budget
    // (a user who set 64 calls/turn must never be hard-stopped at 16).
    let economyBudget: { preset: 'standard' | 'long' | 'unlimited'; toolCallsPerTurn: number } | undefined;
    try {
      const budget = getHarnessBudgetSettings();
      economyBudget = { preset: budget.preset, toolCallsPerTurn: budget.toolCallsPerTurn };
    } catch { /* text-shape limits remain the fallback */ }
    return createToolEconomyState(interactiveToolEconomyPolicy({
      message: turnObjective,
      priorMessages: parentAuthorityDeclined
        ? []
        : priorTurns.filter((turn) => turn.who === 'user').map((turn) => turn.text),
      multiItem,
      budget: economyBudget,
    }));
  })();
  const sdkMaxTurns = resolveClaudeAgentBrainMaxTurns(turnObjective, priorBrainInputs);
  const runOptions = {
    sessionId,
    // Stable for the whole durable attempt: retries/continuations must share
    // one guardrail + artifact scope even though each retry appends another
    // user_input_received event.
    trackerScopeId: attemptTrackerScopeId,
    // Candidate attempt scope only. The SDK persists/resolves artifact lineage
    // lazily on the first create or exact-id verification.
    artifactRunScopeId: attemptTrackerScopeId,
    sourceUserSeq: userInputEvent.seq,
    artifactObjective: turnObjective,
    modelId,
    systemAppend: renderClaudeAgentBrainSystemAppend(surface, request, mode),
    turnContext,
    allowedLocalMcpTools: jitAllowed,
    mcpToolAllowlist,
    localMcpToolUniverse: explicitToolAuthority
      ? [...advertisedUniverse]
      : schemaOnDemandAcquisition
        ? advertisedUniverse
        : undefined,
    agentic: mode === 'full',
    // Mount the read-fanout block on native external MCP: the orchestrator brain
    // is the ONE lane with run_tool_program (the recovery), so serial native-MCP
    // reads here get refused + steered to a program; workers/steps opt out.
    readFanoutGuard: mode === 'full',
    directOrchestrator: mode === 'full',
    // TOOL-STARVATION GUARD (live 2026-07-01: the local MCP server's ~13s cold
    // boot intermittently missed the CLI's startup window under load — the brain
    // then ran with ONLY external MCP tools and narrated/refused local actions,
    // silently). If the local server didn't attach, these sentinels are absent
    // from the SDK init → typed ClaudeAgentSdkToolSurfaceError → the bridge's
    // cross-brain fallover completes the turn on Codex instead of a blind run.
    requiredLocalMcpTools: explicitToolAuthority
      ? []
      : schemaOnDemandAcquisition
        ? [
            'memory_recall_all',
            'tool_search',
            // An accepted action deliberately replaces the unbound generic
            // dispatcher with its one semantic business carrier. Requiring
            // call_tool here made the otherwise healthy work_call surface fail
            // the SDK init sentinel before the first model turn.
            acceptedActionSurface ? 'work_call' : 'call_tool',
          ]
        : ['memory_recall_all'],
    // Scope the native external MCP servers to THIS turn's intent (the user's message)
    // so the Claude brain reaches native capabilities (dataforseo, browsermcp, …) like
    // the Codex lane, without attaching all of them.
    nativeMcpScopeInput: declinedParentWithNewTask
      ? taskInput
      : request.taskContinuation
        ? renderedTurnContext.preflight.confirmedIntentKey
          ? turnObjective
          : request.message
        : turnObjective,
    nativeMcpToolScope: nativeMcpScope,
    maxTurns: sdkMaxTurns,
    maxWallClockMs: request.maxWallClockMs,
    shouldCancel: request.shouldCancel,
    // One object for the whole logical foreground run. Corrective retries and
    // max-turn continuations cannot reset the budget that the user experiences.
    toolEconomyState,
    priorTurns,
  };
  // Salvage authority is THIS logical attempt, never old session history. A
  // reusable chat can contain many prior sends; without this boundary a parse
  // failure on a later read-only turn could falsely report those old sends as
  // work that "just went through".
  const salvageSinceSeq = getLatestEventSeq(sessionId);
  // Salvage/recover wrapper for the SDK dispatch. On an unparseable-tool-call
  // throw (the SDK's own parse-retry already failed): (A) if side effects already
  // committed this turn → return a grounded SUCCESS confirmation (NEVER re-run —
  // would double-act, e.g. re-send emails); (B) if nothing committed → ONE fresh
  // retry (a fresh query() usually re-derives a clean tool call). Kill-switch
  // CLEMMY_CLAUDE_SDK_SALVAGE. Healthy turns are byte-identical.
  // Stage 4 — the SDK-brain lane's slice of the run token budget. An explicit
  // caller ceiling+baseline (the background drain) wins; with NO override the
  // ceiling falls back to the budget preset and the window self-baselines at
  // turn entry — the same semantics as the harness loop (loop.ts
  // resolveRunTokenCeiling + openRunTokenWindow). Before 2026-07-20 the
  // foreground DEFAULT brain had no fallback (ceiling 0 = unmetered) while
  // every other lane was bounded. An explicit 0 stays "unlimited" (the
  // workflow lane's advisory-only contract). Exhaustion stops the INTERNAL
  // auto-continue chain and surfaces as a budget park instead of silently
  // burning past the window (review F2).
  const budgetCeiling = ((): number => {
    try {
      return resolveRunTokenCeiling({ override: request.maxRunTokens, budget: getHarnessBudgetSettings() });
    } catch { return 0; }
  })();
  const budgetBaseline = ((): number => {
    try {
      if (typeof request.runTokenBaseline === 'number' && Number.isFinite(request.runTokenBaseline) && request.runTokenBaseline >= 0) {
        return request.runTokenBaseline;
      }
      // Self-baseline: only THIS turn's chain counts — a long-lived session
      // must never park on its own lifetime history.
      return getSessionTokensUsed(sessionId);
    } catch { return 0; }
  })();
  const budgetWindowExhausted = (): boolean => {
    try {
      if (!runTokenBudgetEnforcementEnabled()) return false;
      if (budgetCeiling <= 0) return false;
      return getSessionTokensUsed(sessionId) - budgetBaseline >= budgetCeiling;
    } catch { return false; }
  };
  // Durable window record: run_worker runs in the SDK-brain MCP child (a
  // separate process), so the fan-out slice of this ceiling is enforced via
  // the eventlog, not shared memory. No-op when unlimited/off.
  recordRunTokenWindow({ sessionId, baseline: budgetBaseline, ceiling: budgetCeiling, warned: new Set() });
  const sdkDispatchScopeId = `${attemptTrackerScopeId}::sdk-dispatch`;
  const physicalRecoveryChecks = new WeakMap<object, DispatchRecoveryLedgerCheck>();
  const recoveryCheckFor = (err: unknown): DispatchRecoveryLedgerCheck | undefined =>
    typeof err === 'object' && err !== null
      ? physicalRecoveryChecks.get(err)
      : undefined;
  const physicalAttemptMayReplay = (err: unknown): boolean =>
    recoveryCheckFor(err)?.safeToReplay === true;
  const runSdkPhysicalAttempt = async (
    opts: Parameters<typeof runClaudeAgentSdkImpl>[0],
  ): Promise<ClaudeAgentSdkRunResult> => {
    const recoveryBaseline = captureDispatchRecoveryLedgerBaseline(sessionId);
    const dispatchLease = activateDispatchLease({
      sessionId,
      scopeId: sdkDispatchScopeId,
      runAttemptId: attempt.attemptId,
    });
    let revokedAfterFailure = false;
    try {
      return await runClaudeAgentSdkImpl({ ...opts, dispatchLease });
    } catch (err) {
      await revokeDispatchLeaseBeforeRecovery(dispatchLease);
      revokedAfterFailure = true;
      if (typeof err === 'object' && err !== null) {
        physicalRecoveryChecks.set(
          err,
          checkDispatchRecoveryLedger(sessionId, recoveryBaseline),
        );
      }
      throw err;
    } finally {
      // The exact-generation revoke is idempotent. On failure the catch above
      // performs it before binding the replay check; healthy completion still
      // closes authority before any continuation can begin.
      if (!revokedAfterFailure) {
        await revokeDispatchLeaseBeforeRecovery(dispatchLease);
      }
    }
  };
  let preterminalDeliveryConcern: ClaudePreterminalDeliveryConcern | null = null;
  const notePreterminalDeliveryConcern = (concern: ClaudePreterminalDeliveryConcern): void => {
    if (!preterminalDeliveryConcern) {
      preterminalDeliveryConcern = {
        reason: concern.reason,
        ...(concern.missing?.length ? { missing: [...new Set(concern.missing)].slice(0, 16) } : {}),
        presentationAlreadyDiscloses: concern.presentationAlreadyDiscloses === true,
      };
      return;
    }
    preterminalDeliveryConcern = {
      reason: [...new Set([
        ...preterminalDeliveryConcern.reason.split('; '),
        concern.reason,
      ])].join('; ').slice(0, 800),
      missing: [...new Set([
        ...(preterminalDeliveryConcern.missing ?? []),
        ...(concern.missing ?? []),
      ])].slice(0, 16),
      // Suppress the committer's disclosure floor only when every accumulated
      // concern is already stated in the proposed presentation.
      presentationAlreadyDiscloses:
        preterminalDeliveryConcern.presentationAlreadyDiscloses === true
        && concern.presentationAlreadyDiscloses === true,
    };
  };
  const currentPreterminalDeliveryConcern = (): ClaudePreterminalDeliveryConcern | null =>
    preterminalDeliveryConcern;
  const runWithSalvage = async (opts: Parameters<typeof runClaudeAgentSdkImpl>[0]): Promise<ClaudeAgentSdkTerminalResult> => {
    try {
      return await runSdkPhysicalAttempt(opts);
    } catch (err) {
      // P4: a COMMITTED provider overload (the model hit 429/529 AFTER side effects
      // landed, 21-min-in) used to dead-end as a raw "overloaded" error. If writes
      // committed, salvage an HONEST partial from the ledger instead of the raw error
      // — the user gets "N actions went through, nothing duplicated, I hit capacity"
      // rather than a bare failure. NEVER re-runs (would double-act). An UNCOMMITTED
      // overload still propagates so the existing transplant to another brain runs.
      if (
        claudeSdkSalvageEnabled()
        && (err instanceof ClaudeSdkProviderOverloadError || err instanceof ClaudeSdkCapacityExhaustedError)
        && err.committed
      ) {
        const salvagedCapacity = salvageCommittedResult(sessionId, salvageSinceSeq);
        if (salvagedCapacity) {
          const reason = err instanceof ClaudeSdkCapacityExhaustedError
            ? 'provider_capacity_after_commit'
            : 'provider_overload_after_commit';
          try { appendEvent({ sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: { kind: 'claude_sdk_salvaged', reason } }); } catch { /* best-effort */ }
          return salvagedCapacity;
        }
        throw err; // committed but no external write to salvage — surface for the caller
      }
      // A2: context-window overflow (typed by the SDK wrapper). Committed ⇒
      // salvage an honest partial exactly like the overload branch (NEVER
      // re-run — would double-act). Uncommitted ⇒ ONE retry with reduced
      // context: recall dropped, prior turns halved to the last 2 — but the
      // session-actions block KEPT (it is the double-send guard).
      if (claudeSdkSalvageEnabled() && err instanceof ClaudeSdkContextOverflowError) {
        // err.committed counts ANY tool call (incl. reads) — but re-running is
        // only unsafe when external WRITES landed. Salvage when they did; when
        // the ledger shows none (read-heavy research run — the common overflow),
        // fall through to the reduced-context retry: re-running reads is safe.
        if (err.committed) {
          const salvagedOverflow = salvageCommittedResult(sessionId, salvageSinceSeq);
          if (salvagedOverflow) {
            try { appendEvent({ sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: { kind: 'claude_sdk_salvaged', reason: 'context_overflow_after_commit' } }); } catch { /* best-effort */ }
            return salvagedOverflow;
          }
        }
        if (!physicalAttemptMayReplay(err)) throw err;
        try { appendEvent({ sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: { kind: 'claude_sdk_overflow_retry', reason: 'context_overflow_reduced_retry' } }); } catch { /* best-effort */ }
        return await runSdkPhysicalAttempt({
          ...opts,
          priorTurns: opts.priorTurns?.slice(-2),
          turnContext: stripRecallFromTurnContext(opts.turnContext),
        });
      }
      if (!claudeSdkSalvageEnabled() || !isClaudeSdkUnparseableToolCall(err)) throw err;
      const salvaged = salvageCommittedResult(sessionId, salvageSinceSeq);
      if (salvaged) {
        try { appendEvent({ sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: { kind: 'claude_sdk_salvaged', reason: 'unparseable_tool_call_after_commit' } }); } catch { /* best-effort */ }
        return salvaged;
      }
      // Nothing committed yet — safe to retry once.
      if (!physicalAttemptMayReplay(err)) throw err;
      try {
        return await runSdkPhysicalAttempt(opts);
      } catch (err2) {
        if (isClaudeSdkUnparseableToolCall(err2)) {
          const s2 = salvageCommittedResult(sessionId, salvageSinceSeq); // the retry may have committed before failing
          if (s2) return s2;
        }
        throw err2;
      }
    }
  };
  // A best-effort CONTINUATION (narration/reasoning/judge retry) runs only after a
  // GOOD result. If it hits the same parse stumble, keep the prior good result
  // rather than turning a finished turn into a failure. Returns null ⇒ keep prior.
  const runContinuation = async (opts: Parameters<typeof runClaudeAgentSdkImpl>[0]): Promise<ClaudeAgentSdkRunResult | null> => {
    try {
      return await runSdkPhysicalAttempt(opts);
    } catch (err) {
      if (claudeSdkSalvageEnabled() && isClaudeSdkUnparseableToolCall(err)) return null;
      throw err;
    }
  };
  // Move 1 (report-back WITHOUT FAIL): the in-flight marker was armed directly
  // beside accepted-source binding above and remains around the WHOLE model-work
  // span (initial run + every corrective continuation). Final delivery clears it
  // only after conversation_completed is durable; an uncommitted exception leaves
  // it for the bridge/restart reducer rather than opening a silent-loss window.
  // Move 4 (defeat silent success): when the completion judge ACCEPTS a turn via
  // a degraded verification — it failed open (timed out / errored) or self-judged
  // (same-family, the model graded its own homework) — record that so the
  // completion is tagged "not independently verified", never a silent green check.
  let completionVerification: { failedOpen?: boolean; selfJudge?: boolean } | null = null;
  let completionIndependentlyVerified = false;
  let artifactVerificationPending: RunArtifact[] = [];
  let logicalRunScopeId: string | undefined;
  let graphApprovalId: string | undefined;
  const finalizedWorkflowDispatchResponse = (): AssistantResponse | null => {
    const dispatch = finalizePreparedWorkflowDispatchForSource(sessionId, userInputEvent.seq);
    if (!dispatch) return null;
    // The public dispatch row is deliberately nonterminal; the workflow reducer
    // owns the later exact terminal and provider delivery. Release only this
    // accepted foreground owner after its source group is durably activated.
    releaseRunInFlightAfterWorkflowTransfer(
      sessionId,
      attempt.attemptId,
      userInputEvent.seq,
    );
    return {
      text: dispatch.presentation.text,
      sessionId,
      stoppedReason: 'success',
      turnsUsed: 1,
      raw: {
        transport: 'claude_agent_sdk_brain',
        asyncWork: {
          status: dispatch.presentation.status,
          kind: dispatch.presentation.kind,
          runIds: [...dispatch.presentation.runIds],
          sourceGroupId: dispatch.presentation.sourceGroupId,
          sourceGroupDigest: dispatch.presentation.sourceGroupDigest,
          sourceUserSeq: dispatch.presentation.sourceUserSeq,
          dispatchKey: dispatch.presentation.dispatchKey,
        },
      },
    };
  };
  let result: ClaudeAgentSdkTerminalResult;
  // One physical continuation budget covers every post-result correction,
  // including terminal-delivery RESUME. Keeping the counter outside the
  // ordinary correction block lets the terminal judge see whether that edge
  // still exists instead of receiving a hard-coded promise.
  let continuationsUsed = 0;
  const continuationBudget = maxTurnContinuations();
  // Queue + an explicit execution question is already a complete graph state.
  // Keep this outside the ordinary correction block so the bounded terminal
  // judge continuation cannot strand or duplicate a newly queued approval.
  const reconcileQueuedApprovalEdge = (): boolean => {
    const approvalQuestion = isQueuedActionApprovalQuestion(result.text);
    const transitions = queuedApprovalTransitionsForRequest(sessionId, userInputEvent.seq)
      .filter((transition) => queuedApprovalTransitionShouldMaterialize(
        transition,
        approvalQuestion,
      ));
    if (transitions.length === 0) return false;
    const materialized = materializeQueuedApprovals(
      sessionId,
      0,
      userInputEvent.seq,
      transitions,
    );
    if (materialized.length > 0) {
      graphApprovalId ??= materialized[0].approval.approvalId;
      result = {
        ...result,
        limitHit: false,
        selfStopped: false,
        stoppedReason: 'pending-approval',
      };
      for (const item of materialized) {
        try {
          appendEvent({
            sessionId,
            turn: 0,
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
        } catch { /* transition state is already durable */ }
      }
      return true;
    }
    return false;
  };
  try {
    result = await runWithSalvage({ prompt: request.message, ...runOptions });
    const initialDispatch = finalizedWorkflowDispatchResponse();
    if (initialDispatch) return initialDispatch;
    logicalRunScopeId = result.artifactRunScopeId;
    const resultIsAwaitingInput = (): boolean =>
      result.stoppedReason === 'awaiting-input' || result.stoppedReason === 'pending-approval';

    const receiptAcknowledgementNeedsRepair = (): boolean => durableMemoryConversationOnly
      && (
        result.toolUses.length > 0
        || !isSafeDurableMemoryReceiptPresentation(result.text)
      );

    // A receipt-only turn is presentation work: the durable intake already
    // completed and tool authority is exactly zero. If the provider emits
    // machinery, internal deliberation, emptiness, or a new question, give it
    // one text-only chance in the same sealed surface. Never route this through
    // generic "invoke the tool" recovery, which would contradict the receipt.
    if (
      receiptAcknowledgementNeedsRepair()
      && continuationsUsed < continuationBudget
    ) {
      const repaired = await runContinuation({
        prompt: [
          'The durable memory intake for the user\'s request is already complete. No tool or additional work is needed.',
          `Original user message: ${JSON.stringify(request.message)}`,
          'Reply once with a brief, natural acknowledgement in your own voice. Do not mention internal machinery or tools, and do not ask a follow-up question.',
        ].join('\n'),
        ...runOptions,
      });
      continuationsUsed += 1;
      if (repaired) result = mergeClaudeRunEvidence(result, repaired);
    }
    if (receiptAcknowledgementNeedsRepair()) {
      try {
        appendEvent({
          sessionId,
          turn: 0,
          role: 'system',
          type: 'guardrail_tripped',
          data: { kind: 'durable_memory_receipt_presentation_fallback' },
        });
      } catch { /* the durable receipt remains authoritative */ }
      result = {
        ...result,
        text: 'Got it — I\'ll remember that.',
        limitHit: false,
        selfStopped: false,
        stoppedReason: 'success',
      };
    } else if (durableMemoryConversationOnly && result.limitHit) {
      // A valid acknowledgement is the complete presentation for this already
      // satisfied objective; a provider bookkeeping flag cannot turn it into a
      // false user-owned continuation horizon.
      result = {
        ...result,
        limitHit: false,
        selfStopped: false,
        stoppedReason: 'success',
      };
    }

    reconcileQueuedApprovalEdge();

    // Narrate-instead-of-call backstop (defense-in-depth; the lean rubric prevents
    // most of it). If the brain made NO real tool calls but its text reproduces the
    // tool-call protocol, it described a call instead of making one — retry ONCE
    // with a hard nudge to actually invoke the tool.
    if (continuationsUsed < continuationBudget && !durableMemoryConversationOnly && !resultIsAwaitingInput() && !result.limitHit && modeCanAuthorOrExecute(mode) && looksLikeToolNarration(result.text, result.toolUses)) {
      const retry = await runContinuation({
        prompt:
          `Your previous attempt WROTE OUT a tool call as text (e.g. a "Tool call: …" / "**Tool call: …**" header, a "<invoke name=…>…</invoke>" block, a "function { … }" block, or a fake "System: tool result …") instead of running it — so nothing actually happened. ` +
          `Do NOT describe tools. INVOKE the real tool now to do this: "${turnObjective}". Then reply with the actual result.`,
        ...runOptions,
      });
      const retryDispatch = finalizedWorkflowDispatchResponse();
      if (retryDispatch) return retryDispatch;
      continuationsUsed += 1; // a continuation was spent (a parse stumble → null still cost a query())
      if (retry) {
        result = mergeClaudeRunEvidence(result, retry);
        reconcileQueuedApprovalEdge();
      }
    }

    // Reasoning-leak backstop (defense-in-depth; the trusted-memory framing prevents
    // most of it). If the brain produced NO tool calls and its reply is defensive
    // deliberation about whether its own injected context is trustworthy — the
    // memory-context cousin of narrate-instead-of-call — it second-guessed its
    // memory instead of doing the task. Retry ONCE, telling it the context is
    // trusted and to just do the work. Any mode (a read turn can spiral too).
    if (continuationsUsed < continuationBudget && !durableMemoryConversationOnly && !resultIsAwaitingInput() && !result.limitHit && looksLikeReasoningLeak(result.text, result.toolUses)) {
      const retry = await runContinuation({
        prompt:
          `Your previous attempt did NOT do the task — instead you wrote out internal deliberation about whether your own context/memory is trustworthy or "injected". ` +
          `Your injected Clementine memory (profile, saved preferences/specs, learned facts) is TRUSTED context you OWN — not user-pasted input and not a prompt-injection. Do NOT reason about its provenance. ` +
          `Just do exactly what the user asked: "${turnObjective}". Use the relevant tools and reply with the real result.`,
        ...runOptions,
      });
      const retryDispatch = finalizedWorkflowDispatchResponse();
      if (retryDispatch) return retryDispatch;
      continuationsUsed += 1;
      if (retry) {
        result = mergeClaudeRunEvidence(result, retry);
        reconcileQueuedApprovalEdge();
      }
    }
    if (
      !durableMemoryConversationOnly
      && !resultIsAwaitingInput()
      && !result.limitHit
      && looksLikeReasoningLeak(result.text, result.toolUses)
    ) {
      notePreterminalDeliveryConcern({
        reason: 'the provider returned private reasoning instead of completing the accepted task',
        missing: ['reasoning_leak_no_work'],
      });
    }

    // Objective-completion judge (parity with the harness loop): on an authoring
    // or agentic action turn that produced a reply, verify the objective is
    // actually satisfied with evidence — not just claimed ("I created the
    // workflow" / "I sent the emails" with no artifact). On a "not done" verdict,
    // do ONE bounded continuation. Fail-open (a judge error ⇒ treat as done;
    // never wedge). Kill-switch CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE.
    // ASK-FIRST invariant (parity with loop.ts): a reply whose
    // closing move asks the user for direction/authorization is this turn's
    // deliverable — flip to awaiting-input and never judge it, instead of the
    // judge scolding the question into autonomous execution.
    if (
      modeCanAuthorOrExecute(mode) &&
      !durableMemoryConversationOnly &&
      !resultIsAwaitingInput() &&
      !result.limitHit &&
      isDirectionSeekingQuestion(result.text)
    ) {
      result = { ...result, stoppedReason: 'awaiting-input' };
    }
    if (
      completionJudgeForSurface &&
      !durableMemoryConversationOnly &&
      modeCanAuthorOrExecute(mode) &&
      !resultIsAwaitingInput() &&
      !result.limitHit &&
      (
        shouldJudgeClaudeCompletion(turnObjective, result.text, result.successfulToolUses ?? result.toolUses)
        || (
          freshExternalWriteRequired
          && !claudeFreshWriteVerified(sessionId, userInputEvent.seq)
          && looksLikeActionCompletionClaim(turnObjective, result.text)
        )
      )
    ) {
      const objective = composeJudgedObjective(
        turnObjective,
        parentAuthorityDeclined ? [] : recentPriorBrainInputs(sessionId, request.message),
      );
      const maxCont = judgeMaxContinuations();
      for (let i = 0; i < maxCont; i += 1) {
        let done = true;
        let reason = '';
        let freshnessGap = false;
        let freshnessStatus: FreshExternalWriteEvidenceStatus = 'confirmed';
        try {
          const skillContext: SkillExecutionContext = {
            skills: [],
            toolCallSummary: summarizeClaudeSdkToolUsesForJudge(result.toolUses),
          };
          const verdict = await judgeImpl(objective, result.text || '', skillContext);
          done = verdict.done;
          reason = verdict.reason;
          // AWAITING: the judge ruled the reply pauses for the user — flip to
          // awaiting-input and stop judging (parity with loop.ts).
          if (verdict.awaitingUser) {
            result = { ...result, stoppedReason: 'awaiting-input' };
            break;
          }
          freshnessStatus = freshExternalWriteRequired
            ? claudeRequestFreshExternalWriteStatus(sessionId, userInputEvent.seq)
            : 'confirmed';
          freshnessGap = done
            && freshExternalWriteRequired
            && !freshExternalWriteEvidenceIsVerified(
              freshnessStatus,
              claudeRequestHasAcceptedExecutionCompletion(sessionId, userInputEvent.seq),
            );
          if (freshnessGap) {
            done = false;
            reason = claudeFreshWriteGapReason(
              freshnessStatus as Exclude<FreshExternalWriteEvidenceStatus, 'confirmed'>,
            );
          }
          recordVerdictEvent(sessionId, 0, {
            door: 'completion',
            pass: done,
            reason,
            failedOpen: verdict.failedOpen,
            selfJudge: verdict.selfJudge,
            detail: { lane: 'claude_sdk', freshnessStatus },
          });
          // A selfJudge NOT-DONE (same family as the brain) gets ONE bounce,
          // never two — the second disagreement is accepted with the advisory
          // tag (parity with loop.ts; ask-first batch regression).
          if (!done && verdict.selfJudge && !freshnessGap && i >= 1) {
            completionVerification = { selfJudge: true };
            break;
          }
          // Tag the completion's verification confidence (only when accepting).
          if (verdict.done && (verdict.failedOpen || verdict.selfJudge)) {
            completionVerification = { failedOpen: verdict.failedOpen, selfJudge: verdict.selfJudge };
          }
          if (done && !verdict.failedOpen && !verdict.selfJudge) {
            completionIndependentlyVerified = true;
          }
        } catch {
          completionVerification = { failedOpen: true };
          recordVerdictEvent(sessionId, 0, {
            door: 'completion',
            pass: true,
            reason: 'completion judge unavailable; lane failed open',
            failedOpen: true,
            detail: { lane: 'claude_sdk' },
          });
          break;
        }
        if (done) break;
        // The cheap judge eval still runs/logs, but the EXPENSIVE full continuation
        // draws from the shared turn budget — so narration+reasoning+judge can't
        // stack into 4-5 full re-runs (Phase 1.3).
        if (continuationsUsed >= continuationBudget) break;
        const freshnessDirective = freshnessGap
          ? freshnessStatus === 'ambiguous'
            ? 'Do NOT repeat the external write. Reconcile the exact target with a read-only lookup/read-back; if it cannot be reconciled, report that precise ambiguity and stop.'
            : freshnessStatus === 'failed'
              ? 'The current write failed. Inspect that current-request failure and repair it only when safe and permitted; honor any instruction not to retry. Never substitute an older receipt.'
              : `No write receipt exists after source user event ${userInputEvent.seq}. Perform the requested external action now, then verify it with a current-request read-back. Never use a historical execution as proof.`
          : '';
        const contResult = await runContinuation({
          prompt:
            `Your previous attempt did NOT fully satisfy the request. Judge feedback: "${reason}". ` +
            `Original request: "${turnObjective}". ` +
            `${freshnessDirective ? `${freshnessDirective} ` : ''}` +
            `IMPORTANT: if finishing requires the USER'S decision or authorization — sending, posting, or deleting something external, or scope left open — do NOT proceed on your own; end your reply with the concrete question for the user. That is a correct, complete answer. ` +
            `Otherwise continue now and FINISH it — produce the concrete artifact/evidence (file, sheet row, message, link, real result); do not just describe or promise it.`,
          ...runOptions,
        });
        const continuationDispatch = finalizedWorkflowDispatchResponse();
        if (continuationDispatch) return continuationDispatch;
        continuationsUsed += 1;
        if (!contResult) break; // parse stumble on a continuation → keep the prior good result
        result = mergeClaudeRunEvidence(result, contResult);
        if (reconcileQueuedApprovalEdge()) break;
        if (contResult.limitHit) break;
      }
    }

    // F1 — auto-continue past a MAX-TURNS budget stop instead of PARKING on "say
    // continue". A per-query turn cap must not stop an autonomous run that is STILL
    // making forward progress (toolUses > 0). Each continuation re-runs with the
    // progress-so-far in the prompt + a fresh turn budget; the stateless SDK lane
    // (persistSession:false) tracks progress in its own reply, so we hand that back
    // and tell it to finish the REST without redoing. Bounded by count + total
    // wall-clock; the per-query tool-ceiling/wall-clock stay the hard backstops.
    if (result.limitHit && !result.selfStopped && sdkAutoContinueEnabled()) {
      // !selfStopped: an anti-thrash loop-stop must not auto-continue (re-running
      // it just re-loops — restores the guard the 33-shell-call incident added).
      const autoStart = Date.now();
      let autoContinues = 0;
      // Re-inject any SKILL bodies loaded this run into the continuation. The stateless
      // SDK lane rebuilds each query from the transcript, which EXCLUDES tool results —
      // so a `skill_read` from turn 1 is LOST on the continuation, and the model would
      // hand-roll the back half (then get bounced by the skill-execution gate → oscillate).
      // Carry the procedure forward so a skill-driven multi-tool run survives the turn cap.
      const reinjectedSkills = (() => {
        try {
          const skills = gatherSessionSkills(sessionId);
          if (skills.length === 0) return '';
          const bodies = skills.map((s) => `## Skill you already loaded: ${s.name} — KEEP FOLLOWING it\n${s.body.slice(0, 8000)}`).join('\n\n');
          return `\n\nThese are the skill procedure(s) you loaded earlier this run (their content is not in this fresh context) — FOLLOW them for the remaining work; you do NOT need to skill_read again:\n${bodies}\n`;
        } catch { return ''; }
      })();
      // A3 recall ledger: continuations run in FRESH context (tool RESULTS from
      // earlier segments are lost) — hand the model each earlier call's id so it
      // can tool_output_query the stored result instead of re-fetching.
      // Lossless-recall parity with the Codex lane's clip stubs.
      let continuationLedger = [...(result.toolCallLedger ?? [])];
      const renderLedger = (): string => {
        if (continuationLedger.length === 0) return '';
        const lines: string[] = [];
        let bytes = 0;
        for (const entry of continuationLedger) {
          const line = `- ${entry.name} [${entry.callId}] ${entry.argsPreview}`;
          bytes += line.length + 1;
          if (bytes > 4000) { lines.push(`- …(+${continuationLedger.length - lines.length} more calls)`); break; }
          lines.push(line);
        }
        return `\n\nTool calls you already made this run (their FULL results are stored — pull any of them with ${toolCallHint('tool_output_query', { call_id: '<call id>' })} instead of re-running the tool):\n${lines.join('\n')}\n`;
      };
      while (
        result.limitHit
        && !result.selfStopped // a continuation that anti-thrash loop-STOPPED must NOT be re-run (would re-loop)
        && result.toolUses.length > 0
        && autoContinues < maxSdkAutoContinues()
        && (Date.now() - autoStart) < sdkAutoContinueWallMs()
        && !budgetWindowExhausted() // Stage 4: never auto-continue past the token window
      ) {
        const progress = (result.text || '').trim().slice(0, 1500);
        const cont = await runContinuation({
          prompt:
            `You hit the per-turn tool budget but the task is NOT finished. Your progress so far:\n${progress}${reinjectedSkills}${renderLedger()}\n\n`
            + `Continue from where you left off and FINISH ALL remaining items from the original request: "${turnObjective}". `
            + 'Do NOT redo items already completed above — do the REMAINING ones. Produce the concrete results (data/artifact), and do not stop to ask.',
          ...runOptions,
        });
        const continuationDispatch = finalizedWorkflowDispatchResponse();
        if (continuationDispatch) return continuationDispatch;
        autoContinues += 1;
        if (!cont) break; // a parse stumble on a continuation → keep the prior partial
        continuationLedger = [...continuationLedger, ...(cont.toolCallLedger ?? [])];
        result = mergeClaudeRunEvidence(result, cont);
        if (reconcileQueuedApprovalEdge()) break;
        try {
          appendEvent({ sessionId, turn: 0, role: 'system', type: 'sdk_auto_continue', data: { attempt: autoContinues, stillLimited: Boolean(cont.limitHit) } });
        } catch { /* telemetry best-effort */ }
      }
    }

    // DETERMINISTIC skill-execution floor — parity with the loop lane, which has
    // enforced this since the 2026-06-15 lunar-audit (an LLM judge HAD the
    // evidence that no render script ran and still passed hand-rolled output).
    // This lane re-injected skill bodies but never verified EXECUTION, so a
    // skill that prescribes bundled scripts could be treated as reading
    // material — and a single-model user has no judge to catch it either. The
    // one-step lane records the shortfall as a terminal concern; it never mints
    // a corrective provider query.
    if (!durableMemoryConversationOnly && !result.limitHit && !resultIsAwaitingInput()
      && (getRuntimeEnv('HARNESS_SKILL_EXEC_GATE', 'on') ?? 'on').toLowerCase() !== 'off') {
      const skillGap = skillExecutionShortfall(sessionId);
      if (skillGap) {
        if (continuationsUsed >= continuationBudget) {
          notePreterminalDeliveryConcern({
            reason: `the required skill pipeline "${skillGap.skill}" was not executed`,
            missing: skillGap.prescribed.map((script) => `skill_execution:${skillGap.skill}:${script}`),
          });
        } else {
          try {
            appendEvent({
              sessionId,
              turn: 0,
              role: 'system',
              type: 'heartbeat',
              data: { kind: 'skill_execution_repair', skill: skillGap.skill, prescribed: skillGap.prescribed },
            });
          } catch { /* telemetry best-effort */ }
          const priorSkillResult = result;
          try {
            const repaired = await runContinuation({
              prompt: [
                `You treated this as finished, but the "${skillGap.skill}" skill was NOT executed: you ran none of its prescribed scripts (${skillGap.prescribed.join(', ')}).`,
                "Do NOT hand-roll the deliverable. Run the skill's actual pipeline — its bundled render script and any mandatory validate script (re-read it with skill_read if needed) — so the output matches the skill's template exactly, then finish.",
                "Only treat this as complete once the skill's own scripts have produced and validated the artifact.",
              ].join(' '),
              ...runOptions,
            });
            // A null continuation (cancelled / budget-exhausted) leaves the
            // original result intact rather than erasing completed work.
            result = repaired
              ? {
                  ...repaired,
                  toolUses: [...priorSkillResult.toolUses, ...repaired.toolUses],
                  text: repaired.text?.trim() ? repaired.text : priorSkillResult.text,
                }
              : priorSkillResult;
          } catch {
            // Repair is best-effort: a failed continuation must never swallow the
            // work already done.
            result = priorSkillResult;
          }
          const dispatch = finalizedWorkflowDispatchResponse();
          if (dispatch) return dispatch;
        }
      }
    }

    // A parsed create response is not enough to claim a document/site exists.
    // Unverified pointers always become a terminal concern. A legacy bounded
    // read-back remains behind the continuation budget while rolling-upgrade
    // state drains; the one-step policy leaves that budget at zero.
    if (!durableMemoryConversationOnly && !result.limitHit && !resultIsAwaitingInput()) {
      let unresolved = logicalRunScopeId
        ? listUnverifiedRunArtifacts(sessionId, logicalRunScopeId)
        : [];
      const repairable = unresolved.filter(
        (artifact) => artifact.status === 'bound'
          && Boolean(artifact.resourceId)
          && (
            artifact.kind === 'google_doc'
            || artifact.kind === 'site'
            || (artifact.kind === 'resource' && artifact.provider === 'googlesheets')
          ),
      );
      if (continuationsUsed < continuationBudget && repairable.length > 0) {
        try {
          appendEvent({
            sessionId,
            turn: 0,
            role: 'system',
            type: 'heartbeat',
            data: { kind: 'artifact_verification_repair', count: repairable.length },
          });
        } catch { /* telemetry best-effort */ }
        const priorResult = result;
        let verification: ClaudeAgentSdkRunResult | null = null;
        try {
          verification = await runContinuation({
            prompt: renderArtifactVerificationPrompt(repairable),
            ...runOptions,
            artifactVerificationOnly: repairable.flatMap((artifact) =>
              artifact.resourceId && (
                artifact.kind === 'google_doc'
                || artifact.kind === 'site'
                || (artifact.kind === 'resource' && artifact.provider === 'googlesheets')
              )
                ? [{ kind: artifact.kind, resourceId: artifact.resourceId }]
                : []),
          });
        } catch (error) {
          try {
            appendEvent({
              sessionId,
              turn: 0,
              role: 'system',
              type: 'guardrail_tripped',
              data: {
                kind: 'artifact_verification_unavailable',
                reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
              },
            });
          } catch { /* telemetry best-effort */ }
        }
        const verificationDispatch = finalizedWorkflowDispatchResponse();
        if (verificationDispatch) return verificationDispatch;
        if (verification) {
          const merged = mergeClaudeRunEvidence(priorResult, verification);
          // Verification is internal QA. Keep the original user-facing result
          // while retaining the getter's durable tool evidence.
          result = {
            ...merged,
            text: priorResult.text,
            limitHit: priorResult.limitHit,
            selfStopped: priorResult.selfStopped,
            stoppedReason: priorResult.stoppedReason,
          };
        }
        unresolved = logicalRunScopeId
          ? listUnverifiedRunArtifacts(sessionId, logicalRunScopeId)
          : [];
      }
      if (unresolved.length > 0) {
        artifactVerificationPending = unresolved;
        result = { ...result, stoppedReason: 'unverified' };
        notePreterminalDeliveryConcern({
          reason: 'one or more created artifacts could not be verified by exact-ID read-back',
          missing: unresolved.map((artifact) =>
            `artifact_readback:${artifact.kind}:${artifact.resourceId ?? artifact.slotKey}`),
        });
      }
    }
    // Final deterministic floor after the bounded judge continuations. A
    // stale PASS must not become a green terminal merely because the retry
    // budget ran out. Honest blockers/questions are left untouched.
    if (
      completionJudgeForSurface
      && freshExternalWriteRequired
      && !result.limitHit
      && !resultIsAwaitingInput()
      && !claudeFreshWriteVerified(sessionId, userInputEvent.seq)
    ) {
      const status = claudeRequestFreshExternalWriteStatus(sessionId, userInputEvent.seq);
      const reason = claudeFreshWriteGapReason(
        status as Exclude<FreshExternalWriteEvidenceStatus, 'confirmed'>,
      );
      notePreterminalDeliveryConcern({
        reason,
        missing: [`fresh_external_write:${status}`],
      });
      try {
        appendEvent({
          sessionId,
          turn: 0,
          role: 'system',
          type: 'guardrail_tripped',
          data: {
            kind: 'request_bound_external_write_missing',
            status,
            sourceUserSeq: userInputEvent.seq,
            reason,
            lane: 'claude_sdk',
          },
        });
      } catch { /* terminal honesty telemetry is best-effort */ }
    }
    // Snapshot unresolved artifact state for every terminal disposition. A
    // provider-backed resource can be created before the model asks a material
    // question; that pause must carry the binding forward rather than letting
    // the user's answer start a fresh root and create a duplicate. Verification
    // itself remains deferred while awaiting input.
    logicalRunScopeId = result.artifactRunScopeId ?? logicalRunScopeId;
    artifactVerificationPending = logicalRunScopeId
      ? listUnverifiedRunArtifacts(sessionId, logicalRunScopeId)
      : [];
    const finalDispatch = finalizedWorkflowDispatchResponse();
    if (finalDispatch) return finalDispatch;
  } catch (err) {
    // Keep the marker armed for propagated model-work failures. The bridge may
    // safely recover on another brain or reduce the error to a typed terminal;
    // only that durable publication boundary may clear restart recovery state.
    // TURN-CONTROL SPINE: a kill-switch cancellation is a USER action, not a
    // failure — return a clean stopped reply instead of a raw error bubbling
    // to the chat surface. Only when the kill row is actually set (a caller's
    // own shouldCancel keeps its existing propagation semantics).
    const committedDispatch = finalizedWorkflowDispatchResponse();
    if (committedDispatch) return committedDispatch;
    if (err instanceof AgentRuntimeCancelledError) {
      try {
        appendEvent({ sessionId, turn: 0, role: 'system', type: 'kill_requested', data: { reason: 'during run (sdk lane)', attemptId: attempt.attemptId } });
      } catch { /* telemetry best-effort */ }
      const stoppedText = 'Stopped — you asked me to halt this run. Nothing further will execute; tell me how you\'d like to proceed.';
      return {
        ...cancelledBrainResponse(
          sessionId,
          attempt,
          userInputEvent.seq,
          userInputEvent.turn,
          stoppedText,
        ),
        turnsUsed: 1,
      };
    }
    if (err instanceof PendingWorkflowChatDispatchOwnershipError) throw err;
    if (!durableMemoryConversationOnly) throw err;
    // The user's objective was completed at the synchronous durable intake
    // boundary. Replaying the original turn on another brain would add latency
    // and restore broad tool authority merely because presentation failed.
    // Publish a truthful acknowledgement while preserving the provider failure
    // in telemetry; cancellation and workflow ownership still propagate above.
    try {
      appendEvent({
        sessionId,
        turn: 0,
        role: 'system',
        type: 'guardrail_tripped',
        data: {
          kind: 'durable_memory_receipt_provider_failure_fallback',
          errorName: err instanceof Error ? err.name : typeof err,
          reason: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        },
      });
    } catch { /* the durable receipt remains authoritative */ }
    result = {
      text: 'Got it — I\'ll remember that.',
      sessionId,
      model: modelId,
      toolUses: [],
      limitHit: false,
      selfStopped: false,
      stoppedReason: 'success',
    };
  }

  // Salvage deliberately kept its historical awaiting-input marker while the
  // corrective-loop phase ran, because replaying an ambiguous committed write
  // is unsafe. At the terminal boundary it is not a genuine user question:
  // carry the uncertainty as a delivery concern and let the shared audit decide
  // whether it is an irreversible HOLD or a qualified DISCLOSE.
  if (result.preterminalDeliveryConcern) {
    notePreterminalDeliveryConcern(result.preterminalDeliveryConcern);
    const { preterminalDeliveryConcern: _privateConcern, ...publicResult } = result;
    result = { ...publicResult, stoppedReason: undefined };
  }

  const carryMissingReplyConcern = (): void => {
    if (
      result.limitHit
      || result.stoppedReason === 'awaiting-input'
      || result.stoppedReason === 'pending-approval'
      || result.stoppedReason === 'cancelled'
      || result.text.trim().length > 0
    ) return;
    notePreterminalDeliveryConcern({
      reason: 'the model did not produce a terminal reply',
      missing: ['missing_reply'],
    });
  };
  carryMissingReplyConcern();
  // A constant is permitted here only because the model call produced no
  // words. It is a failed-model fallback, not a successful terminal default;
  // the delivery concern below forces judge review or a conservative hold.
  const failedModelTerminalFallback = 'The model did not produce a usable final reply for this turn. No recorded work was repeated.';
  let text = result.limitHit
    ? renderLimitHitReply(result.text)
    : (result.text.trim() || failedModelTerminalFallback);
  const refreshTerminalText = (): void => {
    text = result.limitHit
      ? renderLimitHitReply(result.text)
      : (result.text.trim() || failedModelTerminalFallback);
  };
  // ROOT-CAUSE guard (2026-07-01 Acme-calendar): if the FINAL reply is itself SHAPED like
  // a printed tool call — the model narrated instead of invoking, and the retry corrective
  // didn't fix it (or `limitHit` short-circuited it) — do NOT show the user raw
  // `{"tool_call":…}`/`[Tool: X]` and, critically, do NOT persist it as the durable reply
  // (which would replay next turn as a `YOU:` exemplar and TEACH the model to keep narrating —
  // the self-reinforcing loop). Two dispositions, because what is SAFE differs by whether
  // work actually happened: zero tools fired ⇒ give up the whole reply and re-dispatch
  // (side-effect-safe); real tools fired ⇒ pause on the durable state. A mixed turn proves
  // only that SOME work ran, not that the objective finished, and re-running can duplicate
  // side effects.
  const carryMixedNarrationConcern = (): void => {
    if (
      result.limitHit
      || result.stoppedReason === 'awaiting-input'
      || result.stoppedReason === 'pending-approval'
      || result.stoppedReason === 'cancelled'
      || !looksLikeToolCallShape(text)
    ) return;
    if (result.toolUses.length === 0) {
      // SELF-HEAL, not apology (live 2026-07-01 Discord calendar): a narration
      // give-up means ZERO tools ran, so re-dispatching the whole turn on the
      // OTHER brain is side-effect-safe — throw a typed error so the bridge's
      // cross-brain fallover completes the ask for real. The bridge falls back
      // to this error's graceful message when fallover is off/unavailable.
      try {
        appendEvent({ sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: { kind: 'narration_giveup_fallover', preview: text.slice(0, 120) } });
      } catch { /* telemetry best-effort */ }
      throw new ClaudeSdkNarrationGiveUpError(
        'I could not execute the described action because no real tool call was made. No action was recorded.',
      );
    }
    // MIXED TURN (live 2026-07-24): real tools ran, then the model printed a
    // later call. Keep the model's bytes private but intact for the independent
    // judge; a harness-owned replacement would erase the only authored account
    // before RESUME / ASK / DELIVER gets to evaluate it.
    try {
      appendEvent({ sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: { kind: 'narration_mixed_turn_paused', toolUses: result.toolUses.length, preview: text.slice(0, 120) } });
    } catch { /* telemetry best-effort */ }
    notePreterminalDeliveryConcern({
      reason: 'a later narrated tool call was not executed after earlier real tool work',
      missing: ['narrated_tool_call_not_executed'],
    });
  };
  carryMixedNarrationConcern();
  // Durable tool-use summary for observability and model-loop diagnostics.
  // This is deliberately NOT terminal evidence: it contains calls regardless
  // of result, and the canonical `tool_returned` host verdict is the only SDK
  // event preparation/audit may treat as successful work.
  let recordedSdkToolUseCount = 0;
  const recordSdkToolUseEvidence = (): void => {
    const newlyRecorded = result.toolUses.slice(recordedSdkToolUseCount);
    recordedSdkToolUseCount = result.toolUses.length;
    if (newlyRecorded.length === 0) return;
    const recordedToolUses = newlyRecorded.map((name) => name.split('__').pop() ?? name);
    appendEvent({
      sessionId,
      turn: userInputEvent.turn,
      role: 'system',
      type: 'sdk_tool_use_recorded',
      data: { sourceUserSeq: userInputEvent.seq, tools: recordedToolUses.slice(0, 40) },
    });
  };
  try {
    // Keep all tool uses for diagnostics. Terminal authority does not read this
    // marker; only exact successful business/authoring return rows can close.
    recordSdkToolUseEvidence();
  } catch { /* evidence recording must never break the terminal */ }
  let terminalJudgeDisposition: 'deliver' | undefined;
  let terminalJudgeAlreadyDiscloses = false;
  let terminalJudgeAsked = false;
  let terminalJudgeMetadata: Record<string, unknown> = {};
  let terminalJudgeConcernForCommit: ClaudePreterminalDeliveryConcern | null = null;
  let terminalJudgeConsecutiveResumes: 0 | 1 = 0;

  const rebuildPreterminalConcernsAfterResume = (): void => {
    preterminalDeliveryConcern = null;
    logicalRunScopeId = result.artifactRunScopeId ?? logicalRunScopeId;
    artifactVerificationPending = logicalRunScopeId
      ? listUnverifiedRunArtifacts(sessionId, logicalRunScopeId)
      : [];
    if (artifactVerificationPending.length > 0) {
      notePreterminalDeliveryConcern({
        reason: 'one or more created artifacts could not be verified by exact-ID read-back',
        missing: artifactVerificationPending.map((artifact) =>
          `artifact_readback:${artifact.kind}:${artifact.resourceId ?? artifact.slotKey}`),
      });
    }
    if (
      completionJudgeForSurface
      && freshExternalWriteRequired
      && !result.limitHit
      && result.stoppedReason !== 'awaiting-input'
      && result.stoppedReason !== 'pending-approval'
      && !claudeFreshWriteVerified(sessionId, userInputEvent.seq)
    ) {
      const status = claudeRequestFreshExternalWriteStatus(sessionId, userInputEvent.seq);
      notePreterminalDeliveryConcern({
        reason: claudeFreshWriteGapReason(
          status as Exclude<FreshExternalWriteEvidenceStatus, 'confirmed'>,
        ),
        missing: [`fresh_external_write:${status}`],
      });
    }
    const settlementAudit = auditAcceptedSourceSettlementTruth({
      sessionId,
      sourceUserSeq: userInputEvent.seq,
    });
    if (settlementAudit.facts.uncertainWrites > 0) {
      notePreterminalDeliveryConcern({
        reason: 'an external write started but its provider result was not observed',
        missing: ['external_write_result_unresolved'],
      });
    }
    carryMissingReplyConcern();
    carryMixedNarrationConcern();
  };

  // One independent terminal policy gate. A completion candidate with a
  // concrete gap is judged before presentation repair or publication. RESUME
  // reopens the existing Claude SDK continuation once; evaluateTerminalDelivery
  // deterministically converts a second consecutive RESUME into ASK.
  if (
    !result.limitHit
    && result.stoppedReason !== 'awaiting-input'
    && result.stoppedReason !== 'pending-approval'
    && result.stoppedReason !== 'cancelled'
  ) {
    for (;;) {
      const concernAtAssessment = currentPreterminalDeliveryConcern();
      const assessment = assessAcceptedSourceDelivery({
        sessionId,
        sourceUserSeq: userInputEvent.seq,
        proposedReply: text,
        ...(concernAtAssessment
          ? {
              deliveryConcern: {
                reason: concernAtAssessment.reason,
                ...(concernAtAssessment.missing?.length
                  ? { missing: concernAtAssessment.missing }
                  : {}),
              },
            }
          : {}),
      });
      if (!assessment.deliveryGap) break;
      const concern: ClaudePreterminalDeliveryConcern = {
        reason: assessment.deliveryGap.reason ?? 'terminal evidence is incomplete',
        ...(assessment.deliveryGap.missing?.length
          ? { missing: [...assessment.deliveryGap.missing] }
          : {}),
      };
      const continuationCancelled = request.shouldCancel
        ? await Promise.resolve(request.shouldCancel()).catch(() => true)
        : false;
      const terminalDecision = await evaluateTerminalDelivery({
        objective: turnObjective,
        // The empty-reply fallback above is public safety copy, not authored
        // model output. Keep the judge evidence honest by passing the actual
        // terminal bytes (empty when the model emitted none).
        authoredText: result.text.trim(),
        deliveryConcern: concern,
        settlementAudit: assessment.settlementAudit,
        priorConsecutiveResumes: terminalJudgeConsecutiveResumes,
        recoveryCapability: {
          liveContinuation:
            continuationsUsed < continuationBudget
            && !budgetWindowExhausted()
            && !continuationCancelled,
          toolsAvailable: continuationToolsAvailable,
          externalStateInspection: continuationExternalStateInspectionAvailable,
        },
      }, {
        ...(terminalDeliveryJudgePortForTest
          ? { port: terminalDeliveryJudgePortForTest }
          : {}),
      });
      if (terminalDecision.status !== 'decided') break;
      terminalJudgeMetadata = {
        terminalJudgeDisposition: terminalDecision.verb,
        terminalJudgeReason: terminalDecision.reason,
        terminalJudgeFamily: terminalDecision.judge.judgeFamily,
        terminalJudgeResumeCount: terminalDecision.consecutiveResumeCount,
      };
      if (terminalDecision.verb === 'resume') {
        terminalJudgeConsecutiveResumes = 1;
        // The judge was shown a live edge, and this branch now consumes it.
        // Count the physical query even when it fails or returns no parseable
        // result so a provider stumble cannot silently mint another attempt.
        continuationsUsed += 1;
        try {
          appendEvent({
            sessionId,
            turn: userInputEvent.turn,
            role: 'system',
            type: 'heartbeat',
            data: {
              kind: 'terminal_delivery_resume',
              reason: terminalDecision.reason,
              attempt: terminalDecision.consecutiveResumeCount,
            },
          });
        } catch { /* terminal recovery telemetry is best-effort */ }
        let resumed: ClaudeAgentSdkRunResult | null = null;
        try {
          resumed = await runContinuation({
            prompt: [
              'TERMINAL DELIVERY RESUME — an independent different-family judge found one gap you can close now.',
              `Recovery instruction: ${terminalDecision.recoveryInstruction}`,
              `ORIGINAL USER OBJECTIVE (immutable): ${turnObjective.slice(0, 4000)}`,
              'Continue within the original authority. Do not repeat an irreversible action or widen the task. Return a newly authored final answer when the gap is resolved; if it cannot be resolved, state the exact blocker.',
            ].join('\n'),
            ...runOptions,
          });
        } catch (error) {
          if (error instanceof AgentRuntimeCancelledError) {
            result = {
              ...result,
              text: 'Stopped — you asked me to halt this run. Nothing further will execute; tell me how you\'d like to proceed.',
              limitHit: false,
              selfStopped: false,
              stoppedReason: 'cancelled',
            };
          } else {
            try {
              appendEvent({
                sessionId,
                turn: userInputEvent.turn,
                role: 'system',
                type: 'guardrail_tripped',
                data: {
                  kind: 'terminal_delivery_resume_failed',
                  reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
                },
              });
            } catch { /* recovery failure telemetry is best-effort */ }
          }
        }
        const resumedDispatch = finalizedWorkflowDispatchResponse();
        if (resumedDispatch) return resumedDispatch;
        if (resumed) {
          result = mergeClaudeRunEvidence(result, resumed);
          reconcileQueuedApprovalEdge();
          if (
            result.stoppedReason !== 'awaiting-input'
            && result.stoppedReason !== 'pending-approval'
            && modeCanAuthorOrExecute(mode)
            && isDirectionSeekingQuestion(result.text)
          ) {
            result = { ...result, stoppedReason: 'awaiting-input' };
          }
          refreshTerminalText();
          try { recordSdkToolUseEvidence(); } catch { /* evidence marker is best-effort */ }
          if (
            result.stoppedReason !== 'awaiting-input'
            && result.stoppedReason !== 'pending-approval'
            && result.stoppedReason !== 'cancelled'
            && !result.limitHit
          ) {
            rebuildPreterminalConcernsAfterResume();
          }
        }
        if (
          result.stoppedReason === 'awaiting-input'
          || result.stoppedReason === 'pending-approval'
          || result.stoppedReason === 'cancelled'
          || result.limitHit
        ) break;
        continue;
      }

      terminalJudgeConsecutiveResumes = 0;
      terminalJudgeConcernForCommit = concern;
      if (terminalDecision.verb === 'ask') {
        text = terminalDecision.publicText;
        terminalJudgeAsked = true;
        result = {
          ...result,
          text,
          limitHit: false,
          selfStopped: false,
          stoppedReason: 'awaiting-input',
        };
      } else {
        text = terminalDecision.publicText;
        terminalJudgeAlreadyDiscloses = true;
        terminalJudgeDisposition = 'deliver';
        result = {
          ...result,
          text,
          limitHit: false,
          selfStopped: false,
          stoppedReason: 'success',
        };
      }
      break;
    }
  }
  let terminalPresentationRepair: Exclude<
    PrecommitTerminalPresentationResult,
    { status: 'unchanged' }
  > | null = null;
  /** Whether the verification shortfall is one a human must actually look at. */
  let terminalRepairHolds = false;
  /** Whether the delivered reply is already the model's own account of the gap. */
  let terminalRepairDiscloses = false;
  if (
    !result.limitHit
    && result.stoppedReason !== 'awaiting-input'
    && result.stoppedReason !== 'pending-approval'
    && result.stoppedReason !== 'cancelled'
    && terminalJudgeDisposition !== 'deliver'
  ) {
    // The sealed repair boundary requires public-safe input. Raw narrated tool
    // protocol remains intact for the terminal judge above, but an unavailable
    // judge cannot make that protocol safe to feed through a public-text port.
    // The constant is used only as a failed-model fallback; a successful repair
    // still supplies newly model-authored terminal words.
    const terminalRepairCandidate = publicReplyText(text, failedModelTerminalFallback);
    const repaired = await repairActionTerminalBeforeCommit({
      sessionId,
      sourceUserSeq: userInputEvent.seq,
      proposedReply: terminalRepairCandidate,
      port: terminalPresentationRepairPortForTest
        ?? createAgentsTerminalPresentationRepairPort({ model: getClaudeHeadlessModel(modelId) }),
    });
    if (repaired.status !== 'unchanged') {
      terminalPresentationRepair = repaired;
      // THIS PATH IS A GATE TOO, AND IT SITS UPSTREAM OF THE COMMITTER'S.
      // It converts the turn to `blocked` before commitTurnOutcome is ever
      // called, so the single publish gate — which asks whether holding is the
      // honest act — never sees it. Live 2026-08-12: a background task pulled
      // its Apify data successfully and was still withheld here, downstream of
      // every gate fix that day. Ask the same question this lane, so one rule
      // governs delivery no matter which lane reached the terminal.
      const settlementAudit = auditAcceptedSourceSettlementTruth({
        sessionId,
        sourceUserSeq: userInputEvent.seq,
      });
      terminalRepairHolds = deliveryMustHoldForHuman(settlementAudit);
      if (terminalRepairHolds) {
        text = repaired.text;
        // NOT 'awaiting-input': nothing here asks the user anything. The turn
        // could not verify its own work, so a background run must park BLOCKED
        // (needs attention) instead of waiting forever on an answer to a
        // non-question — which is how a task sat 45 minutes on "I haven't been
        // able to verify the result yet" and then intercepted the next attempt
        // at the same work (live 2026-08-12).
        result = { ...result, stoppedReason: 'unverified' };
      } else if (repaired.status === 'blocked_repaired') {
        // The model wrote its own account of what it could not confirm. That is
        // a better disclosure than any sentence the harness owns, so it becomes
        // the delivered answer. A FALLBACK render is canned prose instead, so
        // the original reply is kept and the committer attaches its floor.
        text = repaired.text;
        terminalRepairDiscloses = true;
      }
    }
  }
  const preterminalConcernAtCommit = currentPreterminalDeliveryConcern();
  const concernAtCommit = terminalJudgeConcernForCommit ?? preterminalConcernAtCommit;
  const deliveryConcernForCommit = concernAtCommit
    ? {
        reason: concernAtCommit.reason,
        ...(concernAtCommit.missing?.length
          ? { missing: concernAtCommit.missing }
          : {}),
      }
    : undefined;

  // A transport-window ceiling is a typed rest, not permission for this lane
  // to re-enter itself and not a question the user must answer.
  const stoppedReason: AssistantResponse['stoppedReason'] =
    result.stoppedReason
    ?? (result.limitHit
      ? (budgetWindowExhausted() ? 'token-budget' : 'max-turns-with-grace')
      : 'success');
  const awaitingInput = stoppedReason === 'awaiting-input';
  const awaitingApproval = stoppedReason === 'pending-approval';
  // Re-read after every queued transition has materialized. Registering a
  // sibling atomically demotes conversational presentations to formal cards,
  // so the first materialization snapshot can be stale by this boundary.
  const graphApproval = awaitingApproval && graphApprovalId
    ? approvalRegistry.get(graphApprovalId)
    : undefined;
  const graphApprovalDependency = graphApproval
    ? approvalRegistry.projectPendingApprovalUserDependency(graphApproval)
    : null;
  const conversationalApprovalQuestion = graphApprovalDependency?.kind === 'input'
    ? graphApprovalDependency.question
    : null;
  const awaitingConversationalApproval = awaitingApproval
    && conversationalApprovalQuestion !== null;
  const publicStoppedReason: AssistantResponse['stoppedReason'] = awaitingConversationalApproval
    ? 'awaiting-input'
    : stoppedReason;
  // Report-back / observability parity (gap analysis): the harness loop emits
  // conversation_completed + runtime.completed on a clean terminal so the Tasks
  // board, report-back, and watchdog see the run. The Agent SDK lane runs its
  // own loop, so emit the same terminal events here. A turn-budget stop is NOT
  // a clean completion: emit limit telemetry first, then the user-facing
  // conversation_completed continue prompt, matching the main harness loop.
  if (result.limitHit) {
    try {
      appendEvent({
        sessionId,
        turn: 0,
        role: 'system',
        type: 'conversation_limit_exceeded',
        data: { reason: 'max_turns', maxTurns: sdkMaxTurns, transport: 'claude_agent_sdk_brain' },
      });
    } catch { /* limit telemetry is best-effort */ }
  }
  // `ask_user_question` normally records this inside the local tool itself,
  // but the SDK can also classify a direction-seeking plain-text reply as
  // awaiting input. Persist the canonical pause in either case so restart,
  // transcript replay, and the next-turn convergence steer all observe the
  // same state. Do not duplicate a tool-recorded ask from this user turn.
  if (awaitingInput) {
    try {
      const recent = listEvents(sessionId, {
        types: ['user_input_received', 'awaiting_user_input'],
        desc: true,
        limit: 40,
      });
      const latestUser = recent.filter((event) => event.type === 'user_input_received').at(-1);
      const latestAsk = recent.filter((event) => event.type === 'awaiting_user_input').at(-1);
      if (!latestAsk || (latestUser && latestAsk.seq < latestUser.seq)) {
        appendEvent({
          sessionId,
          turn: userInputEvent.turn,
          role: 'Clem',
          type: 'awaiting_user_input',
          data: {
            question: text,
            purpose: 'clarification',
            source: terminalJudgeAsked ? 'terminal_delivery_judge' : 'decision_awaiting',
            sourceUserSeq: userInputEvent.seq,
          },
        });
      }
    } catch { /* pause telemetry is best-effort; completion below remains authoritative */ }
  }
  // Reduce the provider-specific run to one typed public outcome. This is the
  // only foreground terminal write: raw model text, judge notes, and control
  // fields are not accepted by the committer. A narrated legacy envelope is a
  // compatibility input only; its explicit reply/question is projected before
  // the typed boundary.
  const publicText = conversationalApprovalQuestion ?? publicReplyText(
    text,
    result.limitHit
      ? 'I paused at this run\'s current budget. Progress is checkpointed.'
      : awaitingApproval
        ? 'I need your approval before I can continue.'
        : awaitingInput
          ? 'I need your input before I can continue.'
          : failedModelTerminalFallback,
  );
  const identity: TurnIdentity = {
    sessionId,
    turn: userInputEvent.turn,
    sourceUserSeq: userInputEvent.seq,
    attemptId: attempt.attemptId,
    ...(attempt.runId ? { runId: attempt.runId } : {}),
  };
  let outcome: TurnOutcome;
  if ((terminalPresentationRepair && terminalRepairHolds) || result.stoppedReason === 'unverified') {
    outcome = {
      version: 2,
      id: turnOutcomeId(identity),
      identity,
      status: 'blocked',
      resumable: true,
      presentation: { kind: 'blocked', text: publicText },
    };
  } else if (result.limitHit) {
    outcome = {
      version: 2,
      id: turnOutcomeId(identity),
      identity,
      status: 'blocked',
      resumable: true,
      presentation: { kind: 'blocked', text: publicText },
    };
  } else if (awaitingApproval && graphApprovalDependency?.kind === 'approval') {
    outcome = {
      version: 2,
      id: turnOutcomeId(identity),
      identity,
      status: 'needs_input',
      resumable: true,
      needs: { kind: 'approval' },
      presentation: {
        kind: 'approval',
        text: publicText,
        approvalId: graphApprovalDependency.approvalId,
      },
    };
  } else if (awaitingInput || awaitingApproval) {
    outcome = {
      version: 2,
      id: turnOutcomeId(identity),
      identity,
      status: 'needs_input',
      resumable: true,
      needs: { kind: 'input' },
      presentation: { kind: 'question', text: publicText },
    };
  } else {
    outcome = {
      version: 2,
      id: turnOutcomeId(identity),
      identity,
      status: 'done',
      resumable: false,
      presentation: { kind: 'answer', text: publicText },
    };
  }
  const terminal = commitTurnOutcome(outcome, {
    ...(
      terminalRepairDiscloses
      || terminalJudgeAlreadyDiscloses
      || preterminalConcernAtCommit?.presentationAlreadyDiscloses === true
        ? { presentationAlreadyDiscloses: true }
        : {}
    ),
    ...(deliveryConcernForCommit ? { deliveryConcern: deliveryConcernForCommit } : {}),
    ...(terminalJudgeDisposition ? { terminalJudgeDisposition } : {}),
    legacyReason: (terminalPresentationRepair && terminalRepairHolds) || result.stoppedReason === 'unverified'
      ? 'verification_required'
      : result.limitHit
      ? 'sdk_step_budget_parked'
      : awaitingInput || awaitingConversationalApproval
        ? 'awaiting_user_input'
        : awaitingApproval
          ? 'awaiting_approval'
          : 'claude_agent_sdk_brain',
    metadata: {
      ...(logicalRunScopeId ? { artifactRunScopeId: logicalRunScopeId } : {}),
      ...(artifactVerificationPending.length > 0
        ? {
            artifactVerification: {
              status: 'pending',
              count: artifactVerificationPending.length,
              resources: artifactVerificationPending.map((artifact) => ({
                kind: artifact.kind,
                provider: artifact.provider,
                resourceId: artifact.resourceId,
                uri: artifact.uri,
                state: artifact.status,
              })),
            },
          }
        : {}),
      ...(completionVerification ? { verification: completionVerification } : {}),
      ...terminalJudgeMetadata,
      ...(result.stoppedReason === 'unverified' && deliveryConcernForCommit
        ? {
            verificationDetail: deliveryConcernForCommit.reason,
            ...(deliveryConcernForCommit.missing?.length
              ? { verificationMissing: deliveryConcernForCommit.missing }
              : {}),
          }
        : {}),
      ...(((terminalPresentationRepair && terminalRepairHolds) || result.stoppedReason === 'unverified')
        ? { blockedReason: 'authoritative_terminal_verification_incomplete' }
        : {}),
      ...(result.limitHit ? { transport: 'claude_agent_sdk_brain', maxTurns: sdkMaxTurns } : {}),
    },
  });
  text = terminal.presentation.text;
  const terminalEventRecorded = true;
  const terminalEventInserted = terminal.inserted;
  const responseStoppedReason: AssistantResponse['stoppedReason'] =
    publicStoppedReason === 'success' && terminal.presentation.status === 'blocked'
      ? 'unverified'
      : publicStoppedReason;

  // The committed public event is the sole live-delivery signal. Emitting the
  // same text through request.onChunk after commit races the terminal event and
  // can leave a duplicate provisional bubble on mobile/Discord.
  if (terminalEventInserted) {
    try { actionBus.emit({ kind: 'runtime.completed', sessionId }); } catch { /* best-effort */ }
  }
  if (terminalEventRecorded) {
    clearRunInFlightAfterTerminal(sessionId, attempt.attemptId, userInputEvent.seq);
  }
  // The transcript reader consumes conversation_completed, so refresh only
  // after that terminal row is durable. The old pre-dispatch hook always wrote
  // a user-only snapshot and lagged the assistant by one turn. Keep this
  // per-session-only so the model-authored global scratchpad is never clobbered.
  if (terminalEventRecorded) {
    try {
      const wmSession = getSession(sessionId);
      const wmChannel = wmSession?.channel ?? undefined;
      if (wmSession?.kind === 'chat' && isUserFacingSession(sessionId, wmChannel)) {
        refreshWorkingMemoryForSession(sessionId, wmChannel);
      }
    } catch { /* working-memory observability must never affect delivery */ }
  }
  // Post-turn hooks (correction detection then auto-credit) via the ONE shared
  // spine — identical on every brain lane. New post-turn behavior wires there.
  try {
    runPostTurnHooksImpl({
      sessionId,
      turn: 0,
      userInput: declinedParentWithNewTask ? taskInput : request.message,
      recallIds: [renderedTurnContext.memoryPrimer.recallId],
      replyText: text,
      toolArgTexts: result.toolUses,
      // Recovers the MCP-process recall runs (memory_search_facts /
      // memory_recall_all) this lane could never see in memory — before this,
      // explicit tool recalls in the Claude lane earned zero utility credit.
      turnStartedAt,
    });
  } catch (err) {
    console.warn('[claude-agent-brain] post-turn hooks failed after terminal commit', err instanceof Error ? err.message : err);
  }
  // Autonomous learning parity: every brain reaches the same evidence-first
  // boundary. A clean independent judge, accepted execution controller, or
  // verified artifact read-back can issue a receipt; failed-open/self-judged,
  // paused, ambiguous, and incomplete runs remain useful traces but cannot
  // silently become procedural memory.
  try {
    if (responseStoppedReason === 'success' && result.toolUses.length >= 2 && getSession(sessionId)?.kind === 'chat') {
      const controllerVerified = claudeRequestHasAcceptedExecutionCompletion(
        sessionId,
        userInputEvent.seq,
      );
      const runArtifacts = logicalRunScopeId ? listRunArtifacts(sessionId, logicalRunScopeId) : [];
      const artifactReadbackVerified = runArtifacts.length > 0 && artifactVerificationPending.length === 0;
      const learningAuthority = completionIndependentlyVerified
        ? 'independent_completion_judge' as const
        : 'execution_controller' as const;
      const learningManifests = summarizeWorkManifests(sessionId);
      const learningExternalWriteStatus = freshExternalWriteRequired
        ? claudeRequestFreshExternalWriteStatus(sessionId, userInputEvent.seq)
        : 'confirmed';
      const learningSourceId = attempt.runId ?? attempt.attemptId;
      const learningInput = {
        target: 'skill' as const,
        authority: learningAuthority,
        sessionId,
        sourceId: learningSourceId,
        terminalSuccess: true,
        independentValidation: completionIndependentlyVerified,
        controllerValidation: controllerVerified || artifactReadbackVerified,
        failedOpen: completionVerification?.failedOpen === true,
        selfJudge: completionVerification?.selfJudge === true,
        artifactVerificationPending: artifactVerificationPending.length,
        ambiguousExternalWrites: learningExternalWriteStatus === 'ambiguous' ? 1 : 0,
        manifestRemaining: learningManifests.reduce((sum, manifest) => sum + manifest.remaining, 0),
        manifestAnomalies: learningManifests.reduce((sum, manifest) => sum + manifest.anomalies.length, 0),
        manifestUntrackedCheckpoints: learningManifests.reduce(
          (sum, manifest) => sum + manifest.untrackedCheckpoints,
          0,
        ),
        externalWriteRequired: freshExternalWriteRequired,
        externalWriteReceipts: freshExternalWriteEvidenceIsVerified(
          learningExternalWriteStatus,
          controllerVerified,
        ) ? 1 : 0,
      };
      const learningDecision = evaluateLearningCandidate(learningInput);
      recordLearningDecision(learningInput, learningDecision, {
        lane: 'claude_sdk',
        toolUses: result.toolUses.length,
        artifactCount: runArtifacts.length,
      });
      void (async () => {
        try {
          if (!learningDecision.receipt) return;
          const { distillSkillFromSession, reinforceDraftSkills } = await import('../../memory/skill-distiller.js');
          const usedDrafts = gatherSessionSkills(sessionId).map((skill) => skill.name);
          if (usedDrafts.length > 0) {
            await reinforceDraftSkills(
              usedDrafts,
              'success',
              undefined,
              sessionId,
              learningDecision.receipt,
            );
          }
          await distillSkillFromSession(sessionId, {
            objective: turnObjective,
            evidence: text.slice(0, 4000),
            origin: { kind: 'chat', sourceId: learningSourceId },
            learningReceipt: learningDecision.receipt,
          });
        } catch { /* self-evolving is best-effort — never affects the turn */ }
      })();
    }
  } catch (err) {
    // Terminal publication already succeeded. Learning and receipt bookkeeping
    // can be retried independently; they must never escape into whole-turn
    // recovery and execute the user's tools a second time.
    console.warn('[claude-agent-brain] learning failed after terminal commit', err instanceof Error ? err.message : err);
  }
  return {
    text,
    sessionId,
    ...(awaitingApproval && graphApprovalDependency?.kind === 'approval'
      ? { pendingApprovalId: graphApprovalDependency.approvalId }
      : {}),
    stoppedReason: responseStoppedReason,
    turnsUsed: result.toolUses.length > 0 ? result.toolUses.length : 1,
    raw: {
      transport: 'claude_agent_sdk_brain',
      mode,
      sessionId: result.sessionId,
      model: result.model,
      toolUses: result.toolUses,
      usage: result.usage,
      modelUsage: result.modelUsage,
      limitHit: result.limitHit ?? false,
      stoppedReason: responseStoppedReason,
      ...(logicalRunScopeId ? { artifactRunScopeId: logicalRunScopeId } : {}),
      ...(toolEconomyState
        ? {
            toolEconomy: {
              policy: toolEconomyState.policy.kind,
              softLimit: toolEconomyState.policy.softLimit,
              hardLimit: toolEconomyState.policy.hardLimit,
              attempts: toolEconomyState.attempts,
              allowed: toolEconomyState.allowed,
              completionReserveUsed: toolEconomyState.completionReserveUsed,
              finishPhase: toolEconomyState.finishPhase,
            },
          }
        : {}),
      ...(artifactVerificationPending.length > 0
        ? { artifactVerification: 'pending' }
        : {}),
    },
  };
}
