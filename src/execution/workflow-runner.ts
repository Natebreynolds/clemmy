import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { augmentPath } from '../runtime/spawn-env.js';
import { isIrreversibleSendSlug } from '../runtime/harness/execution-gate.js';
import { classifyComposioSlugEffect } from '../integrations/composio/slug-effect.js';
import { describeWorkflowStepAction } from '../runtime/approval-summary.js';
import {
  interpreterFor, scrubbedChildEnv, electronNodeEnv, spawnSandboxedScript, DEFAULT_MAX_OUTPUT_BYTES,
} from '../runtime/sandboxed-script.js';
import pino from 'pino';
import type { ClementineAssistant } from '../assistant/core.js';
import { MODELS, getRuntimeEnv, getWorkerModel, getActiveAuthMode, getClaudeBrainModel, DEFAULT_CODEX_MODEL } from '../config.js';
import { resolveRoleModel, defaultForRole } from '../runtime/harness/model-roles.js';
import { falloverBrainModelIds, type BrainProviderClass } from '../runtime/harness/model-role-options.js';
import { resolveProvider } from '../runtime/harness/model-wire-registry.js';
import { resolveEffectiveProviderForModel } from '../runtime/harness/byo-providers.js';
import {
  appendEvent as appendHarnessEvent,
  beginRunAttempt,
  finishRunAttempt,
  getSession as getHarnessSession,
  isKillRequested,
  listEvents as listHarnessEvents,
  preserveCurrentKillAndClearStale,
  recordRunAttemptUserInput,
  requestKill,
  type RunAttemptRef,
} from '../runtime/harness/eventlog.js';
import { evidenceLooksFailedOrBlocked, peekToolChoice, rememberToolChoice, stripBakedConnectionId } from '../memory/tool-choice-store.js';
import { renderedComposioResultLooksFailed } from '../tools/composio-tools.js';
import { runBoundedPool } from './bounded-pool.js';
import { bindStepInputs, resolveFrom } from './step-binding.js';
import { addNotification, loadNotifications } from '../runtime/notifications.js';
import { addRunEvent, startRun, finishRun, getRun } from '../runtime/run-events.js';
import { WORKFLOW_RUNS_DIR, listWorkspaceProjects } from '../tools/shared.js';
import { WORKFLOWS_DIR } from '../memory/vault.js';
import {
  listWorkflows,
  readWorkflow,
  clampGoalMaxAttempts,
  type WorkflowDefinition,
  type WorkflowStepInput,
  type WorkflowStepOutputContract,
} from '../memory/workflow-store.js';
import { writeWorkflowAndSyncTriggers } from './workflow-write.js';
import { validateGoal, toGoalEvidence, type GoalValidationResult } from './goal-validate.js';
import {
  ensureWorkflowRunGoal,
  recordGoalValidation,
  satisfyGoal,
  expireGoal,
} from '../agents/plan-proposals.js';
import { loadSkill } from '../memory/skill-store.js';
import {
  anchorRunGoal,
  offloadContextValue,
  readReduceDigest,
  recordReduceDigest,
  recordStepOutput,
  reduceDigestArtifactRelPath,
  runWorkspaceDir,
  runWorkspaceOffloadEnabled,
  stepOutputArtifactRelPath,
  summarizeToolOutput,
  writeWorkspaceCheckerReport,
} from './workflow-run-workspace.js';
import { reduceShardMembers, reduceShardSize, reduceTierEnabled, shardFingerprint } from '../runtime/harness/fanout-reduce.js';
import { resolveRunTokenCeiling, runTokenBudgetEnforcementEnabled } from '../runtime/harness/run-token-budget.js';
import { sumSessionTokensUsedByPrefix } from '../runtime/harness/eventlog.js';
import { getHarnessBudgetSettings } from '../runtime/harness/budget-settings.js';
import { projectCanonicalTopLevelToolEvents } from '../runtime/harness/tool-effect.js';
import { checkerReportFromVerdict } from './workflow-run-checker.js';
import {
  appendWorkflowEvent,
  computeResumeState,
  listPendingRuns,
  readWorkflowEvents,
  type WorkflowEvent,
  type AttemptRecord,
} from './workflow-events.js';
import { sumUsageTokensForSource, sumUsageTokensForRun } from '../runtime/usage-log.js';
import { HarnessSession } from '../runtime/harness/session.js';
import {
  runConversation,
  runConversationFromResume,
  type RunConversationResult,
} from '../runtime/harness/loop.js';
import { respondPreferHarness } from '../runtime/harness/respond-bridge.js';
import { normalizeRouteDiagnostics, routeDiagnosticsFromResponse } from '../runtime/harness/response-route.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { emitApprovalRequestedCard } from '../runtime/harness/approval-card.js';
import { countDominantArray } from '../runtime/harness/tool-output-digest.js';
import { buildOrchestratorAgent } from '../agents/orchestrator.js';
import { buildWorkflowStepAgent } from '../agents/workflow-step-agent.js';
import {
  detectBlockedSteps,
  deepSelfReportedFailure,
  diagnoseWorkflowBlock,
  recordProposedFix,
  applyProposedFix,
  fixIsAutoApplicable,
  sanitizeOutputContract,
  recordWorkflowEditBackup,
  revertWorkflowFix,
  judgeHealCrossFamily,
  renderLegibleOutcome,
  renderSuccessBody,
  selfHealEnabled,
  type WorkflowDiagnosis,
  type ProposedFix,
  type BlockedStep,
} from './workflow-diagnosis.js';
import {
  readWorkflowRunOriginSessionIds,
  requeueWorkflowFromRun,
  WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
} from '../tools/workflow-run-queue.js';
import {
  cancelWorkflowRunAtBoundary,
  readWorkflowRunCancellation,
  workflowRunCancellationRequested,
} from './workflow-run-cancellation.js';
import {
  checkWorkflowForWrite,
  classifyStepSideEffect,
  prepareWorkflowForWrite,
  stepLooksLikeIrreversibleSend,
  stepLooksMutating,
  buildWorkflowMutationContractSnapshot,
  isWorkflowMutationContractSnapshot,
  workflowStepMutationReceiptContract,
  type WorkflowMutationContractSnapshot,
} from './workflow-enforce.js';
import { recordAndDeriveStableTightenings } from './workflow-contract-evidence-store.js';
import { preflightWorkflow, renderPreflightReport } from './workflow-preflight.js';
import { simulateWorkflowDryRun, renderWorkflowDryRunSimulation } from './workflow-dry-run-simulation.js';
import {
  clearWorkflowFailures,
  escalateThreshold,
  getConsecutiveFailures,
  recordWorkflowOutcome,
  shouldStopAutoHeal,
} from './workflow-failure-ledger.js';
import { clearStepContract, registerStepContract, takeStepResult } from '../tools/step-result-tool.js';
import { markItemsSeen, readSeenItemKeys } from './workflow-watermark-store.js';
import { fixSignature, recordPendingFix, confirmPendingFix, discardPendingFix, recallConfirmedFix } from './workflow-fix-memory-store.js';
import { configureHarnessRuntime } from '../runtime/harness/codex-client.js';
import { closePlanScope, openPlanScope } from '../agents/plan-scope.js';
import { missingWorkflowRunInputs, normalizeWorkflowRunInputs } from './workflow-inputs.js';
import { classifyContractProblems, coerceOutputForContract, isBlockedStepOutput, renderOutputContractSpec, verifyStepOutput, isEmptyValue } from './step-output-verify.js';
import { evaluateOutputGrounding, isOutputGroundingGateEnabled } from '../runtime/harness/output-grounding-gate.js';
import { buildWorkflowObjective, deriveLegacyWorkflowRunGoal, judgeWorkflowTarget, type WorkflowTargetVerdict } from './workflow-objective-judge.js';
import { runWatcherJudge, watcherJudgeEnabled, watcherWorkflowIntervalSteps, MAX_WATCHER_INJECTIONS, MAX_WATCHER_CHECKS, type WatcherJudgeFn } from '../runtime/harness/watcher-judge.js';
import { inferOutputContractFromPrompt } from './workflow-deliverable-hints.js';
import { judgeStepSkillExecution } from './workflow-step-judge.js';
import { skillBodyExecutionShortfall } from '../runtime/harness/skill-execution.js';
import { deliverOutcome } from '../runtime/outcome.js';
import { rewriteInClementineVoice } from './voice-rewrite.js';
import { AgentRuntimeCancelledError } from '../runtime/provider.js';
import { looksLikeToolUnavailableSelfReport } from '../runtime/harness/tool-unavailable-text.js';
import { reportedBackRunIdsFrom, terminalDashboardNotificationRunIdsFrom } from './workflow-watchdog.js';
import {
  attemptWorkflowRunReportBack,
  deliverWorkflowRunOutcome,
  recordAndAttemptWorkflowRunReportBack,
  workflowRunReportBackNeedsRetry,
  workflowRunReportBackRetryDue,
  type WorkflowRunReportBackEnvelope,
  type WorkflowRunReportBackRetryState,
} from './workflow-run-report-back.js';
import {
  readWorkflowRunRecord,
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
  writeWorkflowRunRecordDurablyUnlocked,
} from './workflow-run-record.js';
import {
  assessWorkflowRunMutationRequeue,
  executeWorkflowCallMutation,
  replayWorkflowCallMutationSlot,
  workflowCallMutationSlotHasLedger,
} from './workflow-call-receipts.js';
import {
  recallWorkflowPatterns,
  recordSuccessfulWorkflowPattern,
  recordFailedWorkflowPattern,
  renderWorkflowPatternHint,
} from '../memory/workflow-pattern-store.js';
import { compileWorkflowStepsToGraph } from './workflow-graph.js';
import { persistWorkflowGraphSnapshot } from './workflow-graph-store.js';
import {
  claudeAgentSdkWorkflowStepEnabled,
  runClaudeAgentSdkWorkflowStep,
} from '../runtime/harness/claude-agent-workflow-step.js';
import { ClaudeAgentSdkApprovalBoundaryError } from '../runtime/harness/claude-agent-sdk.js';
import { renderSessionHistoryForModel } from '../runtime/harness/session-transcript.js';
import type { AssistantRouteDiagnostics } from '../types.js';

const logger = pino({ name: 'clementine-next.workflow-runner' });

// Narrow test seams for the direct (non-SDK) workflow harness lane. Production
// always uses the real builders/loop; tests can hold a step on an approval or
// cancellation boundary without making a provider call.
let buildWorkflowOrchestratorAgentImpl: typeof buildOrchestratorAgent = buildOrchestratorAgent;
let runWorkflowConversationImpl: typeof runConversation = runConversation;
let resumeWorkflowConversationImpl: typeof runConversationFromResume = runConversationFromResume;

export function _setWorkflowHarnessLoopImplsForTests(input: {
  buildAgent?: typeof buildOrchestratorAgent;
  runConversation?: typeof runConversation;
  runConversationFromResume?: typeof runConversationFromResume;
} = {}): void {
  buildWorkflowOrchestratorAgentImpl = input.buildAgent ?? buildOrchestratorAgent;
  runWorkflowConversationImpl = input.runConversation ?? runConversation;
  resumeWorkflowConversationImpl = input.runConversationFromResume ?? runConversationFromResume;
}

/**
 * Decide whether the runner's SUCCESS completion notification should be
 * recorded dashboard-only (silent) instead of delivered. A self-notifying
 * workflow (a step that called notify_user) already surfaced a user-facing
 * message for this run; delivering the runner completion too would double-post
 * to Discord. Correlation is strictly by runId (race-safe across concurrent
 * drains). A needs-attention run ALWAYS delivers — reports-back is never silenced.
 */
export function shouldSilenceCompletionEcho(opts: {
  needsAttention: boolean;
  runId: string;
  notifications: Array<{ metadata?: Record<string, unknown> }>;
}): boolean {
  if (opts.needsAttention) return false;
  return opts.notifications.some(
    (n) =>
      n.metadata?.source === 'notify_user_tool' &&
      n.metadata?.workflowRunId === opts.runId,
  );
}

/**
 * Process queued workflow runs.
 *
 * This is the new execution path — replaces the inline runner that
 * used to live in src/daemon/runner.ts. It splits per-step work three
 * ways based on the step's shape:
 *
 *   1. **deterministic step** — `step.deterministic.runner` is set.
 *      Bypass the LLM and execute a named helper from this workflow's
 *      scripts/ directory with structured JSON on stdin. The runner is
 *      constrained to bundled scripts so imported frameworks can use
 *      deterministic helpers without opening a generic shell surface.
 *
 *   2. **forEach step** — `step.forEach` names an upstream output
 *      that resolved to an array. Iterate that array with bounded
 *      concurrency, calling the assistant once per item. Pattern from
 *      OpenAI's research_bot/manager.py (asyncio.gather over typed
 *      list + Semaphore for backpressure). Per-item events are
 *      written so resume can pick up where we crashed.
 *
 *   3. **plain LLM step** — the existing behavior: assistant.respond
 *      once with the rendered prompt.
 *
 * Resumability: every run has its own events.jsonl in
 * <workflow>/runs/<runId>/. On daemon restart we re-read those logs,
 * skip steps + items already marked completed, and continue.
 */

const RUNNER_CONCURRENCY = parseInt(process.env.CLEMENTINE_WORKFLOW_CONCURRENCY ?? '5', 10);

// Anti-choke batch size for a single forEach fan-out. The run drain is
// single-slot by default (runDrainConcurrency = 1), so one forEach over an
// unbounded upstream array (e.g. 10k scraped rows) still needs visible,
// resumable progress. This bounds each window without turning the cap into a
// hard ceiling: every pending item is attempted before the step completes.
function forEachMaxItems(): number {
  const raw = parseInt(process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS ?? '200', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 200;
}

// Per-step wall-clock budget. forEach items use the same per-call cap
// (each item is its own assistant call) and the surrounding step gets
// the cap multiplied by item count, capped by RUNNER_CONCURRENCY — but
// we just hand each invocation the same value and let the runtime
// abort individual stuck items. Synthesis sees a smaller cap because
// it should be a tight rollup, not exploration.
const WORKFLOW_STEP_WALL_CLOCK_MS = parseInt(process.env.CLEMENTINE_WORKFLOW_STEP_WALL_MS ?? `${15 * 60_000}`, 10);
const WORKFLOW_SYNTHESIS_WALL_CLOCK_MS = parseInt(process.env.CLEMENTINE_WORKFLOW_SYNTHESIS_WALL_MS ?? `${5 * 60_000}`, 10);
const WORKFLOW_DETERMINISTIC_TIMEOUT_MS = parseInt(process.env.CLEMENTINE_WORKFLOW_DETERMINISTIC_TIMEOUT_MS ?? `${5 * 60_000}`, 10);

// Workflow run heartbeats — same pattern as cron. A 30-min fan-out
// over 50 items shouldn't go silent between "started" and "completed".
const WORKFLOW_HEARTBEAT_FIRST_MS = 5 * 60_000;
const WORKFLOW_HEARTBEAT_INTERVAL_MS = 10 * 60_000;

/**
 * Module-level set of workflow run IDs that are currently parked on a
 * human approval. The deep approval loop in `runStepViaHarness`
 * adds the runId on entry and removes it on exit; the top-level
 * heartbeat checks this set each tick and stays silent while the run
 * is parked. Avoids prop-drilling state through 4 function layers
 * (runQueuedWorkflow → executeWorkflow → executeStep → runStepViaHarness).
 * Without this gate, a workflow waiting 20 min for a human to click
 * Approve fired "still running" notifications every 10 min — confusing
 * because the workflow wasn't running, it was parked (seen 2026-05-21
 * with daily-prospect-outreach).
 */
const runsParkedOnApproval = new Set<string>();

/**
 * Current-step tracker per active workflow run. The for-step loop in
 * executeWorkflow updates this before each executeStep call so the
 * heartbeat can say "step 5 of 9 · enrich_missing_seo_once" instead of
 * the previous generic "still running" — which left users staring at a
 * 5-minute-old message with no signal whether the workflow was making
 * progress or stuck. Cleared on workflow completion/failure.
 */
const runCurrentStep = new Map<string, { stepId: string; index: number; total: number }>();

export function setWorkflowRunCurrentStep(
  runId: string,
  step: { stepId: string; index: number; total: number },
): void {
  runCurrentStep.set(runId, step);
}

export function clearWorkflowRunCurrentStep(runId: string): void {
  runCurrentStep.delete(runId);
}

/**
 * forEach item-progress tracker, keyed by run AND step — two forEach steps in
 * the same dependsOn batch run concurrently (Promise.all), so a run-only key
 * would let them clobber each other's counters and the first to finish would
 * delete its sibling's progress. The fan-out loop updates it as items finish
 * so the heartbeat can say "12/50 items (2 failed)" instead of going silent
 * for the whole 30-minute fan-out; the heartbeat AGGREGATES across the run's
 * live fan-outs. Cleared per step when its fan-out finishes, and run-wide at
 * the end of the step loop.
 */
const runItemProgress = new Map<string, { completed: number; failed: number; total: number }>();

const itemProgressKey = (runId: string, stepId: string): string => `${runId}::${stepId}`;

export function setWorkflowRunItemProgress(
  runId: string,
  stepId: string,
  progress: { completed: number; failed: number; total: number },
): void {
  runItemProgress.set(itemProgressKey(runId, stepId), progress);
}

export function bumpWorkflowRunItemProgress(runId: string, stepId: string, outcome: 'completed' | 'failed'): void {
  const key = itemProgressKey(runId, stepId);
  const cur = runItemProgress.get(key);
  if (!cur) return;
  runItemProgress.set(key, { ...cur, [outcome]: cur[outcome] + 1 });
}

export function clearWorkflowRunItemProgress(runId: string, stepId?: string): void {
  if (stepId !== undefined) {
    runItemProgress.delete(itemProgressKey(runId, stepId));
    return;
  }
  const prefix = `${runId}::`;
  for (const key of runItemProgress.keys()) {
    if (key.startsWith(prefix)) runItemProgress.delete(key);
  }
}

/** Aggregate item progress across a run's live fan-outs (exported for tests). */
export function getWorkflowRunItemProgress(runId: string): { completed: number; failed: number; total: number } | null {
  const prefix = `${runId}::`;
  let completed = 0, failed = 0, total = 0, found = false;
  for (const [key, p] of runItemProgress) {
    if (!key.startsWith(prefix)) continue;
    found = true;
    completed += p.completed; failed += p.failed; total += p.total;
  }
  return found ? { completed, failed, total } : null;
}

export function markWorkflowRunPausedForApproval(runId: string): void {
  runsParkedOnApproval.add(runId);
}

export function clearWorkflowRunPausedForApproval(runId: string): void {
  runsParkedOnApproval.delete(runId);
}

function startWorkflowHeartbeat(
  workflowName: string,
  runId: string,
  startMs: number,
): () => void {
  let count = 0;
  const fire = () => {
    // Suppress heartbeat while parked on an approval. The workflow run
    // is *waiting* on a human, not doing work; "still running" is the
    // wrong status copy and conditions the user to ignore the channel.
    if (runsParkedOnApproval.has(runId)) return;
    count += 1;
    const elapsedMin = Math.max(1, Math.round((Date.now() - startMs) / 60_000));
    // v0.5.6: enrich the heartbeat with current step context so the
    // user knows what's happening, not just that something is. Falls
    // back to the old generic message when the step tracker is empty
    // (e.g. during the synthesis pass or post-step cleanup).
    const cur = runCurrentStep.get(runId);
    // forEach fan-out progress: "12/50 items (2 failed)" — a long fan-out
    // must never read as silent/stuck when it's actually chewing through
    // items. Aggregated across concurrent fan-outs in the same batch.
    const items = getWorkflowRunItemProgress(runId);
    const itemsDone = items ? items.completed + items.failed : 0;
    const itemLabel = items && items.total > 0
      ? ` · ${itemsDone}/${items.total} items${items.failed > 0 ? ` (${items.failed} failed)` : ''}`
      : '';
    const stepLabel = cur ? ` · step ${cur.index} of ${cur.total} · ${cur.stepId}${itemLabel}` : '';
    const stepBody = cur ? `Currently: \`${cur.stepId}\` (step ${cur.index}/${cur.total}${itemLabel}). ` : '';
    addNotification({
      id: `workflow-heartbeat-${runId}-${count}`,
      kind: 'workflow',
      title: `Workflow still running: ${workflowName}${stepLabel}`,
      body: `${stepBody}Run ${runId} has been working for ${elapsedMin} min. Will notify on completion or failure. Open Console → Activity for live status.`,
      createdAt: new Date().toISOString(),
      read: false,
      // Dashboard-only: "still running" heartbeats are live-status reassurance,
      // not report-backs. Delivering them spammed Discord every ~10 min during
      // long runs. The terminal completion/failure notification (and any
      // notify_user report) still delivers — this only stops the noise.
      silent: true,
      metadata: { workflow: workflowName, runId, heartbeat: true, elapsedMin },
    });
    // T4.1 (desktop↔channel parity): channels used to be COMPLETELY blind
    // between kickoff and the terminal report — every heartbeat was
    // dashboard-only. For genuinely long runs, a LOUD but heavily
    // rate-limited progress update now reaches Discord/Slack: first at
    // ~15 min, then every ~30 min (every 3rd beat). Deliberate markers:
    //  - id keeps the `workflow-heartbeat-` prefix and metadata.heartbeat
    //    stays true, so the watchdog's report-back ground-truth check still
    //    excludes it (a delivered update must never mask a lost terminal
    //    report);
    //  - NOT silent and titled "Workflow update:" so the bot delivery gate
    //    treats it as a real update, unlike the suppressed heartbeat noise.
    const loudBeat = count === 2 || (count > 2 && (count - 2) % 3 === 0);
    if (loudBeat) {
      addNotification({
        id: `workflow-heartbeat-loud-${runId}-${count}`,
        kind: 'workflow',
        title: `Workflow update: ${workflowName}${stepLabel}`,
        body: `${stepBody}Still working — ${elapsedMin} min in. I'll report the outcome here when it finishes.`,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { workflow: workflowName, runId, heartbeat: true, progressUpdate: true, elapsedMin },
      });
    }
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    fire();
    interval = setInterval(fire, WORKFLOW_HEARTBEAT_INTERVAL_MS);
    interval.unref?.();
  }, WORKFLOW_HEARTBEAT_FIRST_MS);
  first.unref?.();
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}

export interface QueuedRunRecord {
  id: string;
  workflow: string;
  inputs?: Record<string, string>;
  status?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  cancelledAt?: string;
  source?: string;
  /**
   * Gap E — chat re-entry. Set ONLY when a workflow run was triggered from a
   * chat/agent session that should hear the outcome in-context. On a terminal
   * state the runner appends a synthetic turn to this session (mirrors
   * background-task report-back). Absent for scheduled/cron/dashboard/webhook
   * runs → those stay notification-only (the global notification still fires
   * for ALL runs regardless).
   */
  originSessionId?: string;
  /** Additional chats that asked for the same queued/running work via duplicate
   *  queue detection. Report-backs fan out to each unique origin while execution
   *  lineage remains anchored to the primary originSessionId. */
  originSessionIds?: string[];
  stepOutputs?: Record<string, unknown>;
  output?: string;
  error?: string;
  /**
   * Single-step "try this" hint set by the dashboard's TRY button. When
   * present, the runner skips every other step and the synthesis pass;
   * the named step gets executed once with empty upstream context so
   * the user can see what it does in isolation.
   */
  targetStepId?: string;
  /**
   * Self-heal: a run can "complete" with steps that cleanly blocked. These
   * mark it as needing attention and link the proposed fix (if diagnosed).
   */
  needsAttention?: boolean;
  blockedSteps?: Array<{ stepId: string; reason: string }>;
  proposedFixId?: string | null;
  /**
   * Bounded autonomous self-heal: how many times this run has already been
   * auto-healed (a safe edit_step fix applied) + re-queued. Carried run→run via
   * requeueWorkflowFromRun so the runner can stop after
   * CLEMENTINE_WORKFLOW_SELF_HEAL_MAX_ATTEMPTS and escalate instead of looping.
   */
  selfHealAttempt?: number;
  /** T3.2: the reversible backup snapshotted when this run's heal was
   *  auto-applied. If THIS run (the healed re-run) still fails, the runner
   *  auto-reverts the fix — a heal that didn't stick must not survive. */
  selfHealBackupId?: string;
  /**
   * Run-goal lineage (pinned workflow goals): how many goal re-pursuits
   * already happened (absent/0 = the original run), and the prior attempt's
   * validation evidence — folded into every LLM step prompt of a re-pursuit
   * so attempt N+1 is targeted, not blind. Carried run→run via
   * requeueWorkflowFromRun, exactly like selfHealAttempt.
   */
  goalAttempt?: number;
  goalFeedback?: string;
  /** Terminal pinned-goal verdict for this run (satisfied | repursue |
   *  escalate | advisory) + the one-line reason — rendered by run_status. */
  goalOutcome?: string;
  goalReason?: string;
  /** Capability marker: this occurrence was admitted under the fsynced exact
   * structured-mutation receipt protocol. Legacy records omit it. */
  mutationReceiptProtocolVersion?: number;
  /** Immutable admission-time evidence of which mutating steps were protected
   * by structured exact-call receipts. Crash recovery must never infer this
   * authority from a later workflow definition. */
  mutationContractSnapshot?: unknown;
  /**
   * Failed-item retry lineage. A retry run inherits completed upstream step
   * outputs and completed forEach items from the source run, then leaves only
   * these item keys pending for the named forEach step.
   */
  retryFailedItemsFromRunId?: string;
  retryFailedItemsStepId?: string;
  retryFailedItemKeys?: string[];
  /**
   * P0 event-driven approval parking (flag WORKFLOW_APPROVAL_PARKING).
   * When a step pauses on a human approval, the runner records the
   * resume coordinates here, sets status='parked', and RETURNS — freeing
   * the bounded-pool slot instead of holding it through the (up-to-24h)
   * approval wait. `reapResolvedParkedRuns` flips status back to
   * 'running' once every watched approval clears; the next drain pass
   * resumes from the parked step (no completed step re-runs — resume is
   * driven by events.jsonl / computeResumeState).
   */
  parked?: ParkedRunState;
  /**
   * Report-back backstop (north star: REPORTS BACK WITHOUT FAIL). Set
   * once the terminal (completed/error) user notification has been
   * delivered. A terminal run that reaches its finishedAt but never gets
   * this marker — because the process crashed between the status write and
   * the notify, or addNotification threw — is surfaced by the watchdog so
   * the result never dies silently.
   */
  notifiedAt?: string;
  reportBackAcknowledgedAt?: string;
  /** Exact terminal origin report plus its durable per-origin acknowledgements.
   * The drain/watchdog retries it until every inline and late-observer origin
   * has the idempotent passive outcome turn. */
  reportBack?: WorkflowRunReportBackEnvelope;
  reportBackRetry?: WorkflowRunReportBackRetryState;
}

/**
 * A2 (v2.3.0): when a workflow run parks on approval, put the ACTIONABLE CARD
 * in the origin chat — not just prose. The chat surface folds
 * `approval_requested` events into the approve/execute card; without this
 * event the user got text telling them to hunt the approval down elsewhere
 * while sitting in the very conversation that asked for the work (live
 * 2026-07-23). Same stable data shape as the loop's canonical emit; the chat
 * patches one assistant turn per approvalId, so re-parks dedupe naturally.
 * Best-effort by contract: the prose needs_input turn remains the baseline.
 */
/** Discord/Slack render the approval NOTIFICATION CARD in the origin channel
 *  via the fan-out, so the park's proactive "reply approve apr-x" prose there
 *  is a duplicate (live 2026-07-23: two approval messages for one decision).
 *  Desktop keeps the relay — its card folds into the same conversation.
 *  Exported for tests. */
export function originChannelRendersOwnApprovalCard(originSessionId: string): boolean {
  try {
    const channel = getHarnessSession(originSessionId)?.channel ?? '';
    return channel === 'discord' || channel === 'slack';
  } catch {
    return false; // default: relay — a missing session must not silence the prose
  }
}

export function emitParkedApprovalCardToOriginChat(input: {
  originSessionId: string;
  approvalId: string | undefined;
  workflowName: string;
  runId: string;
}): boolean {
  return emitApprovalRequestedCard({
    sessionId: input.originSessionId,
    approvalId: input.approvalId,
    extra: { workflowName: input.workflowName, runId: input.runId },
  });
}

function workflowRunOriginSessionIds(run: Pick<QueuedRunRecord, 'id' | 'originSessionId' | 'originSessionIds'>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) add(item);
    }
  };
  add(run.originSessionId);
  add(run.originSessionIds);
  if (typeof run.id === 'string') {
    try { add(readWorkflowRunOriginSessionIds(run.id)); } catch { /* watchdog retries terminal delivery */ }
  }
  return out;
}

export interface ParkedStepRef {
  stepId: string;
  /** 'gate' = declarative requiresApproval gate; 'sdk' = per-tool SDK interrupt. */
  kind: 'gate' | 'sdk';
  /** Approval rows this parked step waits on (watched by the reaper scan). */
  approvalIds: string[];
  /** SDK-interrupt sessions key by the deterministic harness session id. */
  sessionId?: string;
}

interface ParkedRunState {
  parkedSteps: ParkedStepRef[];
  parkedAt: string;
}

function readRunRecord(filePath: string): QueuedRunRecord | null {
  try { return readWorkflowRunRecord<QueuedRunRecord>(filePath); }
  catch { return null; }
}

/** A run fired by the TIME-BASED scheduler (no human present to approve). The
 *  legacy cron path and the workflow scheduler both stamp these sources. A
 *  manual/chat/dashboard run is NOT unattended (a person is there to approve). */
function isUnattendedScheduledRun(runId: string): boolean {
  const rec = readRunRecord(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`));
  return rec?.source === 'schedule' || rec?.source === 'cron';
}

const TERMINAL_RUN_RECORD_STATUSES = new Set(['completed', 'completed_with_errors', 'error', 'failed', 'cancelled']);

function isTerminalRunRecord(record: Pick<QueuedRunRecord, 'status' | 'finishedAt'>): boolean {
  return TERMINAL_RUN_RECORD_STATUSES.has(record.status ?? '')
    || ((record.status === 'dry_run' || record.status === 'creation_test') && typeof record.finishedAt === 'string');
}

export type TerminalReportInput = Omit<WorkflowRunReportBackEnvelope, 'version' | 'acknowledgedOriginSessionIds'>;

function waitAfterTerminalPublishForTest(): void {
  const ready = process.env.CLEMENTINE_TEST_TERMINAL_PUBLISH_READY;
  const release = process.env.CLEMENTINE_TEST_TERMINAL_PUBLISH_RELEASE;
  if (!ready || !release) return;
  writeFileSync(ready, 'ready', 'utf-8');
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release)) Atomics.wait(wait, 0, 0, 10);
}

function terminalReportMatchesStatus(record: QueuedRunRecord, report: TerminalReportInput): boolean {
  if (record.status === 'cancelled') return report.outcome === 'failed';
  if (record.status === 'error' || record.status === 'failed') return report.outcome !== 'done';
  if (
    record.status === 'completed'
    || record.status === 'completed_with_errors'
    || ((record.status === 'dry_run' || record.status === 'creation_test') && typeof record.finishedAt === 'string')
  ) return report.outcome !== 'failed';
  return false;
}

function sameTerminalReport(envelope: WorkflowRunReportBackEnvelope, report: TerminalReportInput): boolean {
  return envelope.version === 1
    && envelope.workflowName === report.workflowName
    && envelope.outcome === report.outcome
    && envelope.detail === report.detail;
}

interface WorkflowRunRecordWriteResult {
  record: QueuedRunRecord;
  /** True only for the caller that made terminal truth visible in this locked
   * write. Seeing an already-terminal record (even the same envelope) is not
   * publication authority for ledger/activity/notification side effects. */
  publishedTerminal: boolean;
}

function writeRunRecord(
  filePath: string,
  record: QueuedRunRecord,
  terminalReport?: TerminalReportInput,
  admissionMutationContractSnapshot?: WorkflowMutationContractSnapshot,
): WorkflowRunRecordWriteResult {
  return withWorkflowRunRecordLock(filePath, () => {
    const current = readWorkflowRunRecordUnlocked<QueuedRunRecord>(filePath);
    const currentStatus = typeof current?.status === 'string' ? current.status : '';
    const requestedStatus = typeof record.status === 'string' ? record.status : '';
    // Once a terminal projection wins this lock, a stale running/error/cancel
    // writer cannot replace it. Same-status metadata merges remain allowed.
    if (current && isTerminalRunRecord(current)) {
      if (currentStatus === 'cancelled') {
        const receipt = readWorkflowRunCancellation(current.id);
        if (receipt && (
          current.cancelledAt !== receipt.requestedAt
          || current.finishedAt !== receipt.requestedAt
          || current.error !== receipt.reason
        )) {
          const canonical = {
            ...current,
            cancelledAt: receipt.requestedAt,
            finishedAt: receipt.requestedAt,
            error: receipt.reason,
          };
          writeWorkflowRunRecordDurablyUnlocked(filePath, canonical);
          return { record: canonical, publishedTerminal: false };
        }
      }
      // Business terminal projection is first-writer immutable, including a
      // same-status stale snapshot. Report acknowledgements/notifiedAt mutate
      // only through their dedicated locked coordinators.
      return { record: current, publishedTerminal: false };
    }

    // Report envelopes/acks have their own locked coordinator. Never let a
    // runner snapshot overwrite a newer acknowledgement generation.
    const {
      reportBack: _staleReportBack,
      reportBackRetry: _staleReportBackRetry,
      reportBackAcknowledgedAt: _staleReportBackAcknowledgedAt,
      notifiedAt: _staleNotifiedAt,
      mutationContractSnapshot: _staleMutationContractSnapshot,
      ...businessRecord
    } = record;
    let nextRecord: QueuedRunRecord = { ...(current ?? {} as QueuedRunRecord), ...businessRecord };
    // Admission evidence is first-transition immutable. A resumed/parked run
    // preserves even malformed or missing legacy evidence verbatim; it must
    // never gain authority from today's workflow definition. Only the process
    // that wins the queued -> running transition may stamp the current contract.
    if (current?.status === 'queued' && requestedStatus === 'running' && admissionMutationContractSnapshot) {
      nextRecord.mutationContractSnapshot = admissionMutationContractSnapshot;
    } else if (current && Object.prototype.hasOwnProperty.call(current, 'mutationContractSnapshot')) {
      nextRecord.mutationContractSnapshot = current.mutationContractSnapshot;
    } else {
      delete nextRecord.mutationContractSnapshot;
    }
    if (current?.reportBack !== undefined) nextRecord.reportBack = current.reportBack;
    else delete nextRecord.reportBack;
    if (current?.reportBackRetry !== undefined) nextRecord.reportBackRetry = current.reportBackRetry;
    else delete nextRecord.reportBackRetry;
    if (current?.reportBackAcknowledgedAt !== undefined) {
      nextRecord.reportBackAcknowledgedAt = current.reportBackAcknowledgedAt;
    } else delete nextRecord.reportBackAcknowledgedAt;
    if (current?.notifiedAt !== undefined) nextRecord.notifiedAt = current.notifiedAt;
    else delete nextRecord.notifiedAt;

    // The immutable first receipt owns cancellation diagnostics even for a
    // stale same-status writer. Always re-project it; never let later catch or
    // dashboard snapshots replace requestedAt/reason.
    const cancellation = readWorkflowRunCancellation(nextRecord.id);
    if (cancellation) {
      nextRecord = {
        ...nextRecord,
        status: 'cancelled',
        cancelledAt: cancellation.requestedAt,
        finishedAt: cancellation.requestedAt,
        error: cancellation.reason,
      };
      // A cancellation that wins a proposed success/error terminal write still
      // needs one exact durable report in the same commit as terminal visibility.
      terminalReport = {
        workflowName: nextRecord.workflow,
        outcome: 'failed',
        detail: cancellation.reason,
      };
    }
    if (terminalReport) {
      if (!isTerminalRunRecord(nextRecord) || !terminalReportMatchesStatus(nextRecord, terminalReport)) {
        throw new Error(`Terminal report does not match canonical workflow run status ${nextRecord.status ?? 'unknown'}.`);
      }
      if (current?.reportBack && !sameTerminalReport(current.reportBack, terminalReport)) {
        throw new Error('Workflow run already has a different immutable terminal report envelope.');
      }
      nextRecord.reportBack = current?.reportBack ?? {
        version: 1,
        ...terminalReport,
        acknowledgedOriginSessionIds: [],
      };
      if (!current?.reportBack) {
        delete nextRecord.notifiedAt;
        delete nextRecord.reportBackAcknowledgedAt;
        delete nextRecord.reportBackRetry;
      }
    }
    writeWorkflowRunRecordDurablyUnlocked(filePath, nextRecord);
    if (terminalReport && isTerminalRunRecord(nextRecord)) waitAfterTerminalPublishForTest();
    return {
      record: nextRecord,
      publishedTerminal: Boolean(terminalReport && isTerminalRunRecord(nextRecord)),
    };
  });
}

/** Crash-injection seam proving terminal projection + exact report envelope are
 * one durable record commit. Production code uses the same private writer. */
export function publishWorkflowRunTerminalForTest(
  filePath: string,
  record: QueuedRunRecord,
  report: TerminalReportInput,
): QueuedRunRecord {
  return writeRunRecord(filePath, record, report).record;
}

/**
 * Stamp `notifiedAt` on a terminal run AFTER its user notification has been
 * delivered. Call immediately after the terminal addNotification — if the
 * notify throws or the process dies before this runs, the marker stays unset
 * and the watchdog re-surfaces the run. Best-effort: a failed marker write is
 * the same failure mode the watchdog already covers, so never let it throw.
 */
function markRunNotified(filePath: string, notifiedAt: string = new Date().toISOString()): void {
  try {
    withWorkflowRunRecordLock(filePath, () => {
      const rec = readWorkflowRunRecordUnlocked<QueuedRunRecord>(filePath);
      if (rec && !rec.notifiedAt) {
        writeWorkflowRunRecordDurablyUnlocked(filePath, { ...rec, notifiedAt });
      }
    });
  } catch { /* best-effort; watchdog backstops an unmarked terminal run */ }
}

function stopAfterCancellationWonWrite(filePath: string, written: QueuedRunRecord): boolean {
  if (written.status !== 'cancelled') return false;
  if (!written.notifiedAt) notifyCancelledRunOnce(filePath, written);
  try {
    finishRun(written.id, {
      status: 'cancelled',
      message: written.error || 'Workflow run cancelled.',
      outputPreview: written.error || 'Workflow run cancelled.',
    });
  } catch { /* activity mirror is best-effort */ }
  return true;
}

function terminalPublicationMatches(
  filePath: string,
  written: WorkflowRunRecordWriteResult,
  expected: TerminalReportInput,
): boolean {
  if (stopAfterCancellationWonWrite(filePath, written.record)) return false;
  if (!written.publishedTerminal) {
    if (written.record.reportBack) attemptWorkflowRunReportBack(filePath);
    return false;
  }
  if (!written.record.reportBack || !sameTerminalReport(written.record.reportBack, expected)) {
    if (written.record.reportBack) attemptWorkflowRunReportBack(filePath);
    return false;
  }
  return true;
}

class WorkflowRunCancelledError extends Error {
  constructor() {
    super('Workflow run cancelled by user.');
    this.name = 'WorkflowRunCancelledError';
  }
}

/**
 * Thrown when a step pauses on a human approval and parking is enabled.
 * Unwinds cleanly up to `processOneRunFile`, which checkpoints the run as
 * 'parked' and returns (releasing the bounded-pool slot) instead of
 * treating it as a failure. Carries the resume coordinates the reaper
 * scan needs to know which approvals to watch.
 */
export class ParkRunSignal extends Error {
  readonly parkedSteps: ParkedStepRef[];
  constructor(parkedSteps: ParkedStepRef[]) {
    super('Workflow run parked on approval.');
    this.name = 'ParkRunSignal';
    this.parkedSteps = parkedSteps;
  }
}


/**
 * Event-driven approval parking (flag WORKFLOW_APPROVAL_PARKING). Default ON
 * (Wave 3 P1-7): a parked step RELEASES its drain slot and is resumed by the
 * reaper scan once the approval clears — so one unattended approval (e.g. a 7am
 * scheduled run with no human) can't hold the only drain slot and wedge the
 * whole workflow queue for up to 24h. The reaper + watchdog already expect this.
 * Kill-switch: WORKFLOW_APPROVAL_PARKING=off restores the in-place poll loop
 * (holds the worker until the approval resolves).
 */
function parkingEnabled(): boolean {
  const raw = (getRuntimeEnv('WORKFLOW_APPROVAL_PARKING', 'on') ?? 'on').toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no');
}

function isWorkflowRunCancelled(runId: string): boolean {
  if (workflowRunCancellationRequested(runId)) return true;
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const record = readRunRecord(filePath);
  if (record?.status === 'cancelled') return true;
  // The Tasks board owns the generic run mirror (`run-events.ts`), while the
  // workflow dashboard owns the durable run JSON above. Either surface is a
  // valid stop authority. Treating the mirror as an input here closes the seam
  // where cancelling `workflow:<runId>` only changed the card while the actual
  // model kept executing in `workflow:<runId>:<stepId>`.
  try {
    return getRun(runId)?.status === 'cancelled';
  } catch {
    return false;
  }
}

function throwIfWorkflowRunCancelled(runId: string): void {
  if (isWorkflowRunCancelled(runId)) throw new WorkflowRunCancelledError();
}

/**
 * Plain-language reason for a step that ended in any harness terminal status
 * OTHER than `completed`. A workflow step is only "done" when the harness
 * reports `completed`; every other terminal status means the step did NOT
 * finish its job and must be reported back honestly (north-star: reports back
 * without fail), never captured as prose-success. Exported for tests.
 */
export function describeStepNonCompletion(status: string, error?: string): string {
  if (error && error.trim()) return error.trim();
  switch (status) {
    case 'limit_exceeded':
      return 'the step hit a tool-call / loop guardrail or budget limit before finishing';
    case 'killed':
      return 'the step run was aborted before finishing';
    case 'awaiting_user_input':
      return 'the step is waiting for user input, which a background workflow cannot provide — make it a requiresApproval step or supply the value as an input';
    case 'failed':
      return 'the step failed with an unhandled error';
    default:
      return `the step ended in a non-completed state (${status})`;
  }
}

const WORKFLOW_STEP_RESULT_CHANNEL_UNAVAILABLE_PATTERN =
  /\b(?:workflow_step_result[\s\S]{0,180}(?:not\s+(?:available|exposed|accessible|callable)|unavailable|missing|cannot|can't|could\s+not|couldn't|unable|no\s+(?:live\s+)?tool|without\s+(?:live\s+)?tool)|(?:cannot|can't|could\s+not|couldn't|unable\s+to|not\s+able\s+to)[\s\S]{0,180}(?:workflow_step_result|step\s+result\s+tool|result\s+tool))\b/i;

const WORKFLOW_INTERRUPTED_TOOL_STATE_PATTERN =
  /\b(?:interrupted\s+tool\s+state|from\s+that\s+interrupted\s+tool\s+state|(?:rerun|re-run)\s+the\s+(?:workflow\s+)?step)\b/i;

/**
 * A workflow-step agent is not done when it writes prose explaining that tools
 * or the workflow_step_result result channel are unavailable. That is a
 * structural harness failure, not step data; the step boundary should retry or
 * fall over to another brain instead of feeding the prose into output contracts.
 */
export function looksLikeWorkflowStepStructuralResultMiss(output: unknown): boolean {
  if (typeof output !== 'string') return false;
  const text = output.replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return looksLikeToolUnavailableSelfReport(text)
    || WORKFLOW_STEP_RESULT_CHANNEL_UNAVAILABLE_PATTERN.test(text)
    || WORKFLOW_INTERRUPTED_TOOL_STATE_PATTERN.test(text);
}

export class WorkflowStepStructuralResultError extends Error {
  constructor(
    public readonly stepId: string,
    public readonly rawOutput: string,
  ) {
    const clipped = rawOutput.replace(/\s+/g, ' ').trim().slice(0, 280);
    super(
      `workflow step "${stepId}" completed without workflow_step_result and self-reported a missing tool/result channel: ${clipped}`,
    );
    this.name = 'WorkflowStepStructuralResultError';
  }
}

export function isWorkflowStepStructuralResultError(err: unknown): err is WorkflowStepStructuralResultError {
  return err instanceof WorkflowStepStructuralResultError
    || Boolean(err && typeof err === 'object' && (err as { name?: unknown }).name === 'WorkflowStepStructuralResultError');
}

/**
 * Cheap template renderer. Supports:
 *   {{date}}                  → today (UTC date)
 *   {{input.<key>}}           → run inputs (merged from workflow defaults + run overrides)
 *   {{steps.<id>.output}}     → upstream step's textual output
 *   {{item}}                  → current forEach item (raw)
 *   {{item.<path>}}           → nested lookup into the forEach item
 *
 * Intentionally not Handlebars / Liquid: the surface is small enough
 * that bringing in a template engine is dead weight and risks
 * sandbox-escape footguns.
 */
/**
 * When the step declares `usesSkill`, load the skill's SKILL.md body
 * and prepend it to the rendered prompt with explicit delimiters so the
 * model can distinguish HOW (the skill instructions) from WHAT (the
 * step task).
 *
 * FAIL LOUD (no silent downgrade): when a step declares `usesSkill` but the
 * skill isn't installed at run time, throw so the step fails with a clear
 * error and reports back — never run the raw prompt without the declared
 * instructions, which produces unpredictable output. Author/enable-time
 * `checkSkillReference` already blocks unknown skills at create/enable; this
 * closes the run-time window (skill removed or unsynced after authoring).
 */
export function applySkillToPrompt(step: WorkflowStepInput, rendered: string): string {
  const skillName = step.usesSkill?.trim();
  if (!skillName) return rendered;
  const skill = loadSkill(skillName);
  if (!skill) {
    logger.error({ stepId: step.id, usesSkill: skillName }, 'workflow step references skill that is not installed; failing step');
    throw new Error(
      `Step "${step.id}" declares usesSkill "${skillName}" but that skill is not installed `
      + '— refusing to run the step without its instructions. Install/sync the skill, or remove '
      + 'the usesSkill reference from the step.',
    );
  }
  const skillBody = (skill.body || '').trim();
  if (!skillBody) return rendered;
  return [
    `=== SKILL: ${skill.name} ===`,
    skill.frontmatter.description ? `Purpose: ${skill.frontmatter.description}` : '',
    '',
    skillBody,
    '=== END SKILL ===',
    '',
    // Same execution-contract framing skill_read applies in chat/workers, so a
    // workflow step that uses a skill RUNS it as a procedure rather than
    // treating it as background reading (global "run skills as designed" fix).
    'The skill above is a PROCEDURE to EXECUTE for this step — carry out every step it prescribes and produce every deliverable it specifies (the file, image, URL, record), not a description. Do not skip its phases. The step is complete only when the skill\'s deliverables actually exist.',
    '',
    '=== STEP TASK ===',
    rendered,
  ].filter(Boolean).join('\n');
}

/**
 * When a step declares an output contract, append an explicit instruction so
 * the step agent KNOWS the exact structured shape to emit — otherwise it
 * guesses and the deterministic verifier fails it after the fact (the live
 * "missing required output key" failure). Pairs with coerceOutputForContract
 * (parses a JSON-text emission) + verifyStepOutput (enforces it). No contract →
 * prompt unchanged. Exported for tests.
 */
export function applyContractToPrompt(step: WorkflowStepInput, rendered: string): string {
  const c = step.output;
  if (!c) return rendered;
  const keys = c.required_keys ?? [];
  if (keys.length === 0 && !c.verify && !c.type) return rendered;
  const lines: string[] = ['', '=== REQUIRED OUTPUT (this step is NOT complete until you return EXACTLY this) ==='];
  if (keys.length > 0) {
    lines.push(
      `Return your result as a JSON object with these EXACT top-level keys: ${keys.map((k) => `"${k}"`).join(', ')}.`,
      'Emit ONLY that JSON object as the step result (if a workflow_step_result tool is available, call it with this object) — no surrounding prose.',
    );
  } else if (c.type) {
    lines.push(`Return your result as type: ${c.type}.`);
  }
  if (c.verify?.url_present?.length) {
    lines.push(`These keys MUST hold a real, non-empty https:// URL (verified): ${c.verify.url_present.join(', ')}.`);
  }
  if (c.verify?.path_exists?.length) {
    lines.push(`These keys MUST hold a real, existing file path (verified): ${c.verify.path_exists.join(', ')}.`);
  }
  return [rendered, ...lines].join('\n');
}

/**
 * Run-goal re-pursuit: fold the prior attempt's external-validation evidence
 * into the step prompt so the re-run addresses the unmet criteria instead of
 * blindly repeating itself. No active feedback → prompt unchanged (the normal
 * first-attempt case stays byte-identical). Exported for tests.
 */
export function applyGoalFeedbackToPrompt(
  ctx: Pick<StepExecutionContext, 'goalFeedback'>,
  rendered: string,
): string {
  const feedback = ctx.goalFeedback?.trim();
  if (!feedback) return rendered;
  return [
    rendered,
    '',
    '=== PRIOR ATTEMPT FEEDBACK (this is a goal re-pursuit run) ===',
    'The previous run of this workflow completed but FAILED external goal validation:',
    feedback,
    'Address these gaps in this attempt — do not repeat the prior output unchanged.',
  ].join('\n');
}

/** Mid-run WATCHER steer (watcher-judge.ts): a trajectory check at the last
 *  step boundary found the run confidently drifting from its goal — surface
 *  the one-sentence correction to the NEXT step. Advisory: the step decides
 *  how it applies; absent steer → prompt byte-identical. Exported for tests. */
export function applyWatcherSteerToPrompt(
  ctx: Pick<StepExecutionContext, 'watcherSteer'>,
  rendered: string,
): string {
  const steer = ctx.watcherSteer?.trim();
  if (!steer) return rendered;
  return [
    rendered,
    '',
    '=== TRAJECTORY CHECK (an independent watcher compared the run so far against its goal) ===',
    steer,
    'Address this in this step if it applies to your work — the goal and step instructions above remain authoritative.',
  ].join('\n');
}

interface WorkflowStepProjectContext {
  requested: string;
  source: 'workflow' | 'step';
  name?: string;
  path?: string;
  type?: string;
}

function normalizeWorkflowProjectRef(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function slugifyWorkflowProjectRef(value: string): string {
  return normalizeWorkflowProjectRef(value).replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

function findWorkspaceProjectForRef(ref: string): { name: string; path: string; type?: string } | null {
  const wanted = normalizeWorkflowProjectRef(ref);
  const wantedSlug = slugifyWorkflowProjectRef(ref);
  try {
    return listWorkspaceProjects().find((project) => {
      const pathParts = project.path.split(/[\\/]/).filter(Boolean);
      const aliases = [project.name, project.path, pathParts[pathParts.length - 1]]
        .map((alias) => alias?.trim())
        .filter((alias): alias is string => Boolean(alias));
      return aliases.some((alias) => {
        const normalized = normalizeWorkflowProjectRef(alias);
        return normalized === wanted || slugifyWorkflowProjectRef(alias) === wantedSlug;
      });
    }) ?? null;
  } catch {
    return null;
  }
}

function resolveWorkflowStepProjectContext(
  step: Pick<WorkflowStepInput, 'project'>,
  workflow?: Pick<WorkflowDefinition, 'project'>,
): WorkflowStepProjectContext | undefined {
  const stepProject = step.project?.trim();
  const workflowProject = workflow?.project?.trim();
  const requested = stepProject || workflowProject;
  if (!requested) return undefined;
  const matched = findWorkspaceProjectForRef(requested);
  return {
    requested,
    source: stepProject ? 'step' : 'workflow',
    ...(matched ? { name: matched.name, path: matched.path, type: matched.type } : { name: requested }),
  };
}

function projectContextValue(project: WorkflowStepProjectContext | undefined, key: string): unknown {
  if (!project) return undefined;
  if (key === 'requested') return project.requested;
  if (key === 'source') return project.source;
  if (key === 'name') return project.name;
  if (key === 'path') return project.path;
  if (key === 'type') return project.type;
  return undefined;
}

function renderTemplate(
  template: string,
  inputs: Record<string, string>,
  stepOutputs: Record<string, unknown>,
  item?: unknown,
  project?: WorkflowStepProjectContext,
): string {
  return template
    .replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10))
    .replace(/\{\{project\.([a-zA-Z0-9_-]+)\}\}/g, (_m, key: string) => {
      const value = projectContextValue(project, key);
      return value === undefined || value === null ? '' : String(value);
    })
    .replace(/\{\{input\.([a-zA-Z0-9_-]+)\}\}/g, (_m, key: string) => inputs[key] ?? '')
    .replace(/\{\{steps\.([a-zA-Z0-9_-]+)\.output\}\}/g, (_m, key: string) => {
      const out = stepOutputs[key];
      if (out === undefined || out === null) return '';
      return typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    })
    .replace(/\{\{item\}\}/g, () => {
      if (item === undefined || item === null) return '';
      return typeof item === 'string' ? item : JSON.stringify(item);
    })
    .replace(/\{\{item\.([a-zA-Z0-9_.-]+)\}\}/g, (_m, pathStr: string) => {
      if (!item || typeof item !== 'object') return '';
      const parts = pathStr.split('.');
      let cursor: unknown = item;
      for (const p of parts) {
        if (!cursor || typeof cursor !== 'object') return '';
        cursor = (cursor as Record<string, unknown>)[p];
      }
      if (cursor === undefined || cursor === null) return '';
      return typeof cursor === 'string' ? cursor : JSON.stringify(cursor);
    });
}

// ── CALL-1: structured tool-call argument rendering ──────────────────────────
// A call arg value that is EXACTLY one template token resolves to the RAW
// upstream value (object/array preserved, so a whole step output can be handed
// to a tool). An embedded token ("prefix {{input.x}}") renders as a string.
const CALL_FULL_TOKEN_RE = /^\s*\{\{\s*(input\.[a-zA-Z0-9_-]+|steps\.[a-zA-Z0-9_-]+\.output(?:\.[a-zA-Z0-9_.-]+)?|item(?:\.[a-zA-Z0-9_.-]+)?|project\.[a-zA-Z0-9_-]+|date)\s*\}\}\s*$/;

function pathGet(value: unknown, dotted: string): unknown {
  if (!dotted) return value;
  let cursor = value;
  for (const part of dotted.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function resolveCallToken(token: string, inputs: Record<string, string>, stepOutputs: Record<string, unknown>, item: unknown, project?: WorkflowStepProjectContext): unknown {
  if (token === 'date') return new Date().toISOString().slice(0, 10);
  if (token.startsWith('project.')) return projectContextValue(project, token.slice(8));
  if (token.startsWith('input.')) return inputs[token.slice(6)];
  if (token === 'item') return item;
  if (token.startsWith('item.')) return pathGet(item, token.slice(5));
  const m = /^steps\.([a-zA-Z0-9_-]+)\.output(?:\.(.+))?$/.exec(token);
  if (m) return m[2] ? pathGet(stepOutputs[m[1]], m[2]) : stepOutputs[m[1]];
  return undefined;
}

export function renderCallArgValue(val: unknown, inputs: Record<string, string>, stepOutputs: Record<string, unknown>, item?: unknown, project?: WorkflowStepProjectContext): unknown {
  if (typeof val === 'string') {
    const full = CALL_FULL_TOKEN_RE.exec(val);
    if (full) {
      const raw = resolveCallToken(full[1], inputs, stepOutputs, item, project);
      return raw === undefined ? '' : raw; // preserve object/array; unresolved → ''
    }
    return renderTemplate(val, inputs, stepOutputs, item, project);
  }
  if (Array.isArray(val)) return val.map((v) => renderCallArgValue(v, inputs, stepOutputs, item, project));
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) out[k] = renderCallArgValue(v, inputs, stepOutputs, item, project);
    return out;
  }
  return val; // numbers/booleans/null pass through
}

export function renderCallArgs(args: Record<string, unknown> | undefined, inputs: Record<string, string>, stepOutputs: Record<string, unknown>, item?: unknown, project?: WorkflowStepProjectContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) out[k] = renderCallArgValue(v, inputs, stepOutputs, item, project);
  return out;
}

/** Execute a structured call node directly — zero LLM. v1: composio slug via
 *  the composio dispatch GATEWAY (same owner resolution, sender constraints,
 *  and typed blocks as chat/Space) — a workflow exact-call can never dispatch
 *  under an ambiguous or non-compliant account. Args are rendered against
 *  inputs/upstream/(item). */
async function executeWorkflowCallNode(
  step: WorkflowStepInput,
  ctx: StepExecutionContext,
  item?: unknown,
  mutationItemKey?: string,
): Promise<unknown> {
  const call = step.call!;
  const args = renderCallArgs(call.args, ctx.inputs, ctx.stepOutputs, item, resolveWorkflowStepProjectContext(step, ctx.workflow));
  const durableReplay = replayWorkflowCallMutationSlot({
    workflowSlug: ctx.workflowSlug,
    runId: ctx.runId,
    stepId: step.id,
    ...(mutationItemKey ? { itemKey: mutationItemKey } : {}),
  });
  if (durableReplay.replayed) return durableReplay.result;
  const {
    composioDispatchErrorProvesNoCommit,
    composioFailureProvesNoCommit,
    detectComposioFailure,
    dispatchComposioTool,
  } = await import('../tools/composio-tools.js');
  // The slug is an independent safety signal: an author-supplied `read` label
  // must not disable receipts for an obviously create/update/delete call.
  const mutatesExternally = structuredCallNeedsMutationReceipt(step);
  const outcome = await dispatchComposioTool(call.tool, args, {
    sessionId: `workflow:${ctx.runId}:${step.id}`,
    ...(mutatesExternally
      ? {
        dispatchBoundary: (resolved, dispatch) => {
          // The gateway already refused every auth-required-but-unconnected
          // route (`not-connected`/`identity-absent`/`ambiguous-account`/…) as a
          // typed block BEFORE this boundary is reached — dispatchComposioTool
          // only invokes the boundary on an `ok` resolution. An `ok` resolution
          // with no connectionId is a legitimate no-auth toolkit deferring to
          // composio's default entity; it must still record intent/started/
          // receipt (the ledger fingerprints a null account as the provider
          // default), not be permanently refused with no account to connect.
          return executeWorkflowCallMutation({
            workflowSlug: ctx.workflowSlug,
            runId: ctx.runId,
            stepId: step.id,
            ...(mutationItemKey ? { itemKey: mutationItemKey } : {}),
            tool: resolved.toolSlug,
            account: {
              ...(resolved.connectionId ? { connectionId: resolved.connectionId } : {}),
              ...(resolved.identity ? { identity: resolved.identity } : {}),
            },
            args: resolved.args,
          }, dispatch, {
            classifyFailure: (result) => {
              const failure = detectComposioFailure(result);
              return failure.failed
                ? {
                  summary: failure.summary || 'provider reported failure',
                  provenNoCommit: composioFailureProvesNoCommit(result),
                }
                : null;
            },
            classifyThrownFailure: (error) => (
              composioDispatchErrorProvesNoCommit(error)
                ? (error instanceof Error ? error.message : String(error))
                : null
            ),
          });
        },
      }
      : {}),
  });
  if (!outcome.ok) {
    // Typed gateway block → fail the step VISIBLY with the deterministic
    // corrective (which account / reconnect / fix args) instead of dispatching.
    throw new Error(`composio dispatch blocked (${outcome.reason}): ${outcome.message}`);
  }
  return outcome.result;
}

interface DeterministicStepPayload {
  workflow: string;
  workflowSlug: string;
  runId: string;
  stepId: string;
  inputs: Record<string, string>;
  stepOutputs: Record<string, unknown>;
  project?: WorkflowStepProjectContext;
}

function redactProcessOutput(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, (m) => `${m.slice(0, 11)}...REDACTED`)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)\S+/gi, '$1[REDACTED]');
}

function resolveDeterministicRunner(workflowSlug: string, runner: string): { command: string; args: string[]; cwd: string; target: string; isElectron: boolean } {
  const raw = runner.trim();
  if (!raw) throw new Error('deterministic runner is empty');
  if (/\s/.test(raw)) {
    throw new Error('deterministic runner must be a script path under scripts/ without inline arguments');
  }
  if (path.isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) {
    throw new Error('deterministic runner must stay inside the workflow scripts/ directory');
  }

  const workflowDir = path.resolve(WORKFLOWS_DIR, workflowSlug);
  const scriptsDir = path.resolve(workflowDir, 'scripts');
  const rel = raw.startsWith('scripts/') || raw.startsWith('scripts\\') ? raw : path.join('scripts', raw);
  const target = path.resolve(workflowDir, rel);
  if (target !== scriptsDir && !target.startsWith(`${scriptsDir}${path.sep}`)) {
    throw new Error('deterministic runner resolved outside scripts/');
  }
  if (!existsSync(target)) {
    throw new Error(`deterministic runner not found: ${rel}`);
  }

  // Shared interpreter resolution (the spaces-runner twin): adds .ts/tsx support
  // and resolves python3/bash to absolute paths on the augmented PATH so the
  // packaged .app finds them. isElectron drives ELECTRON_RUN_AS_NODE below.
  const interp = interpreterFor(target, augmentPath(process.env.PATH));
  if (!interp) {
    throw new Error(`unsupported deterministic runner extension for ${rel}; use .js, .mjs, .cjs, .ts, .py, .sh, or an executable file`);
  }
  return { command: interp.command, args: interp.args, cwd: workflowDir, target, isElectron: interp.isElectron };
}

export async function runDeterministicWorkflowStepForTest(
  runner: string,
  payload: DeterministicStepPayload,
): Promise<unknown> {
  return runDeterministicWorkflowStep(runner, payload);
}

/**
 * Turn a raw child-process spawn failure into an actionable message.
 * The important case: on the PACKAGED macOS app, child scripts spawned
 * by the Electron daemon get EPERM on uv_cwd (TCC sandbox) — a cryptic
 * failure that looks like a bug. Name it so the user knows the fix is
 * entitlements, not the workflow. Pure + exported for tests.
 */
export function explainDeterministicSpawnError(err: unknown, target: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  if (code === 'EPERM' || code === 'EACCES' || /\bEPERM\b|uv_cwd|operation not permitted/i.test(msg)) {
    return new Error(
      `deterministic runner could not launch (${code ?? 'permission denied'}): ${target}. ` +
      'On the packaged macOS app, child scripts are blocked by the app sandbox (TCC) until Clementine has ' +
      'filesystem entitlements / a launchd context. Run this workflow from the dev build, or grant the ' +
      `entitlement, then retry. (original: ${msg})`,
    );
  }
  if (code === 'ENOENT') {
    return new Error(
      `deterministic runner not launchable — interpreter or script missing for ${target}: ${msg}`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

async function runDeterministicWorkflowStep(
  runner: string,
  payload: DeterministicStepPayload,
): Promise<unknown> {
  const resolved = resolveDeterministicRunner(payload.workflowSlug, runner);
  const input = JSON.stringify(payload);
  const startedAt = Date.now();
  // Shared sandboxed-script substrate: scrubbed env (no daemon secrets) + the
  // two workflow-identity vars, hard timeout, output cap (no OOM), EPIPE guard.
  const env = scrubbedChildEnv({
    CLEMENTINE_WORKFLOW_RUN_ID: payload.runId,
    CLEMENTINE_WORKFLOW_STEP_ID: payload.stepId,
    ...electronNodeEnv(resolved.command, resolved.isElectron),
  });
  const outcome = await spawnSandboxedScript({
    command: resolved.command, args: resolved.args, cwd: resolved.cwd, env,
    stdinPayload: input, timeoutMs: WORKFLOW_DETERMINISTIC_TIMEOUT_MS,
  });
  if (outcome.launchError) throw explainDeterministicSpawnError(outcome.launchError, resolved.target);
  const cleanStdout = redactProcessOutput(outcome.stdout.trim());
  const cleanStderr = redactProcessOutput(outcome.stderr.trim());
  if (outcome.timedOut) {
    throw new Error(`deterministic runner timed out after ${WORKFLOW_DETERMINISTIC_TIMEOUT_MS}ms`);
  }
  if (outcome.overflowed) {
    throw new Error(`deterministic runner output exceeded ${DEFAULT_MAX_OUTPUT_BYTES} bytes (emit a single JSON document to stdout)`);
  }
  if (outcome.code !== 0) {
    throw new Error(`deterministic runner failed (${outcome.signal ?? `exit ${outcome.code}`}): ${cleanStderr || cleanStdout || 'no output'}`);
  }
  logger.info({
    workflow: payload.workflow,
    runId: payload.runId,
    stepId: payload.stepId,
    runner,
    durationMs: Date.now() - startedAt,
  }, 'deterministic workflow step completed');
  if (!cleanStdout) {
    return { ok: true, stdout: '', stderr: cleanStderr || undefined };
  }
  try {
    return JSON.parse(cleanStdout);
  } catch {
    return cleanStdout;
  }
}

/**
 * Try to coerce a step output into an iterable array for forEach.
 * Strategy, in order:
 *   1. Already an array → use it
 *   2. JSON-parseable string that parses to an array → use that
 *   3. Object with a single array property → use that (common LLM
 *      shape: `{ items: [...] }`)
 *   4. Otherwise → return null and let the caller decide
 */
function coerceToArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') {
        const arrayProps = Object.entries(parsed).filter(([, v]) => Array.isArray(v));
        if (arrayProps.length === 1) return arrayProps[0][1] as unknown[];
      }
    } catch { /* not JSON — fall through */ }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const arrayProps = Object.entries(value).filter(([, v]) => Array.isArray(v));
    if (arrayProps.length === 1) return arrayProps[0][1] as unknown[];
  }
  return null;
}

function forEachSourceStepId(expr: string | undefined): string | null {
  const raw = (expr ?? '').trim();
  if (!raw) return null;
  const templated = /^\{\{\s*steps\.([a-zA-Z0-9_-]+)\.output(?:\.[a-zA-Z0-9_.-]+)?\s*\}\}$/.exec(raw);
  if (templated) return templated[1];
  const directPath = /^steps\.([a-zA-Z0-9_-]+)\.output(?:\.[a-zA-Z0-9_.-]+)?$/.exec(raw);
  if (directPath) return directPath[1];
  return /^[a-zA-Z0-9_-]+$/.test(raw) ? raw : null;
}

function resolveForEachSource(expr: string, stepOutputs: Record<string, unknown>): { sourceId: string | null; value: unknown } {
  const raw = expr.trim();
  const sourceId = forEachSourceStepId(raw);
  if (!sourceId) return { sourceId: null, value: undefined };
  const templated = /^\{\{\s*(steps\.[a-zA-Z0-9_-]+\.output(?:\.[a-zA-Z0-9_.-]+)?)\s*\}\}$/.exec(raw);
  const directPath = /^(steps\.[a-zA-Z0-9_-]+\.output(?:\.[a-zA-Z0-9_.-]+)?)$/.exec(raw);
  const from = templated?.[1] ?? directPath?.[1] ?? `steps.${sourceId}.output`;
  return { sourceId, value: resolveFrom(from, {}, stepOutputs, undefined) };
}

function itemKey(item: unknown, index: number): string {
  if (item && typeof item === 'object') {
    const candidate = (item as Record<string, unknown>).id
      ?? (item as Record<string, unknown>).key
      ?? (item as Record<string, unknown>).slug;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    if (typeof candidate === 'number') return String(candidate);
  }
  if (typeof item === 'string' && item.length < 64) return item;
  return `idx-${index}`;
}

/**
 * Simple bounded-concurrency runner. Mirrors the research_bot pattern:
 * `asyncio.gather` over a list with a Semaphore. We don't need to
 * preserve insertion order in the result map (each call writes its
 * own per-item event), so we use Promise.allSettled and merge.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: string; reason: unknown }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: string; reason: unknown }> = new Array(items.length);
  let cursor = 0;
  let halted = false;
  const runners: Promise<void>[] = [];
  const N = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < N; i++) {
    runners.push((async () => {
      while (true) {
        if (halted) return;
        const idx = cursor++;
        if (idx >= items.length) return;
        try {
          const value = await worker(items[idx], idx);
          results[idx] = { ok: true, value };
        } catch (err) {
          results[idx] = { ok: false, error: err instanceof Error ? err.message : String(err), reason: err };
          // A human-approval park is a control signal, not an item failure to
          // fan past. Stop assigning new work; completed siblings are already
          // durable in events.jsonl and resume will skip them.
          if (err instanceof ParkRunSignal) halted = true;
        }
      }
    })());
  }
  await Promise.all(runners);
  return results;
}

interface StepExecutionContext {
  workflow: WorkflowDefinition;
  // Directory slug for the workflow on disk (e.g. "patch-validation-test").
  // Used as the key for per-run events.jsonl and resume state — the
  // display name in workflow.name may contain spaces or be renamed
  // later, but the slug stays stable for the life of the workflow.
  workflowSlug: string;
  runId: string;
  inputs: Record<string, string>;
  stepOutputs: Record<string, unknown>;
  assistant: ClementineAssistant;
  completedItems: Map<string, unknown>;
  // Shared accumulator for per-item forEach failures so the surrounding
  // workflow run can surface "completed with N/M failures" instead of
  // reporting an all-green success when fan-out items quietly errored.
  forEachFailures: Array<{ stepId: string; itemKey: string; error: string }>;
  // Shared accumulator for NON-FAILING quality advisories (skill-execution
  // judge misses, resume safety skips, target misses). These NEVER fail a step
  // or hide the delivered output. Some confident/review-required advisories
  // still mark the terminal run `needsAttention` so they cannot be counted as
  // clean success in the ledger.
  qualityAdvisories: WorkflowQualityAdvisory[];
  // DEFERRED advisory judges: detection-only per-item/per-step judge calls
  // (skill-execution, SDK-lane output grounding) are pushed here instead of
  // being awaited inline — an advisory that can't change the step's output
  // must not add judge latency (5–25s/call) to every fan-out item's critical
  // path. executeWorkflow awaits allSettled(pendingAdvisories) ONCE before
  // returning, so every advisory still lands before qualityAdvisories is read.
  // Absent (older ctx creations) ⇒ the call sites await inline as before.
  pendingAdvisories?: Array<Promise<void>>;
  // Mid-run WATCHER steer for THIS batch's steps: a step-boundary trajectory
  // check found the run drifting from its goal — the one-sentence correction
  // is appended to the batch's step prompts (applyWatcherSteerToPrompt) and
  // cleared for the next round. Advisory only; absent → prompts unchanged.
  watcherSteer?: string;
  // Creation-time test mode: read-only steps run for real but a forEach fans
  // out over only the FIRST item (bounded cost — we just need to confirm the
  // step returns data, not process the whole batch). No-op for normal runs.
  creationTest?: boolean;
  // Run-goal re-pursuit: the prior attempt's validation evidence. When set,
  // every LLM step prompt gets a PRIOR ATTEMPT FEEDBACK block so the re-run
  // addresses the unmet criteria instead of repeating the same output.
  goalFeedback?: string;
  // Procedural recall from prior clean workflow runs. Injected as a short
  // advisory into LLM steps only; deterministic helpers stay byte-identical.
  learnedPatternHint?: string;
  // Chat/session that queued this workflow. When present, model-run steps receive
  // a small authoritative lineage block so a different model/backend can preserve
  // the user's decisions and avoid repeating prior external writes.
  originSessionId?: string;
}

function applyWorkflowPatternHint(ctx: Pick<StepExecutionContext, 'learnedPatternHint'>, prompt: string): string {
  const hint = ctx.learnedPatternHint?.trim();
  if (!hint) return prompt;
  return `${prompt}\n\n${hint}`;
}

export function renderWorkflowOriginLineageBlock(originSessionId: string | undefined): string {
  if (!originSessionId) return '';
  let history = '';
  try { history = renderSessionHistoryForModel(originSessionId, 6, 3_500); } catch { history = ''; }
  return [
    '=== ORIGIN SESSION LINEAGE (authoritative) ===',
    `This workflow was started from session "${originSessionId}". Preserve the user's decisions, constraints, resource ids, and already-completed external actions from that session.`,
    'Do not repeat completed external writes unless the user explicitly asked to do them again. If you need more context before acting, call session_history with the origin session id.',
    history,
    '=== END ORIGIN SESSION LINEAGE ===',
  ].filter(Boolean).join('\n');
}

function applyWorkflowOriginLineage(ctx: Pick<StepExecutionContext, 'originSessionId'>, prompt: string): string {
  const lineage = renderWorkflowOriginLineageBlock(ctx.originSessionId);
  if (!lineage) return prompt;
  return `${lineage}\n\n=== WORKFLOW STEP REQUEST ===\n${prompt}`;
}

/** A non-blocking quality heads-up attached to a COMPLETED run. The deliverable
 *  is still produced + delivered; this only adds a "review this" note. */
export interface WorkflowQualityAdvisory {
  stepId: string;
  itemKey?: string;
  kind: 'skill_not_executed' | 'target_missed' | 'goal_validation_unavailable' | 'foreach_overflow' | 'idempotent_skip' | 'ungrounded_output' | 'inferred_output_contract' | 'synthesis_degraded';
  note: string;
}

export function workflowAdvisoryRequiresAttention(
  advisory: Pick<WorkflowQualityAdvisory, 'kind'>,
): boolean {
  switch (advisory.kind) {
    case 'target_missed':
    case 'foreach_overflow':
    case 'skill_not_executed':
    case 'idempotent_skip':
    case 'ungrounded_output':
    case 'inferred_output_contract':
      // A figure that contradicts the run's own captured tool results is the
      // trust-killer ("plausible fluff") — it must surface for review, never pass
      // as clean success.
      return true;
    case 'goal_validation_unavailable':
      // A dead judge is not proof the deliverable is bad. It is still delivered
      // loudly as a quality advisory, but it does not count as a workflow
      // failure or trigger chronic-failure accounting by itself.
      return false;
    case 'synthesis_degraded':
      // Every step already completed and verified — only the final prose
      // rollup fell back to the deterministic step-output format. Substance
      // is intact; surface it as an advisory, not a failed run.
      return false;
  }
}

export function workflowReportLaneForOutcome(opts: {
  needsAttention: boolean;
  advisories?: Array<Pick<WorkflowQualityAdvisory, 'kind'>>;
}): 'done' | 'blocked' {
  if (opts.needsAttention) return 'blocked';
  return opts.advisories?.some(workflowAdvisoryRequiresAttention) ? 'blocked' : 'done';
}

/**
 * T-WF-1/2: run a workflow step through the harness loop instead of
 * the legacy `assistant.respond()` path.
 *
 * Why this exists: the old path goes through `assistant.respond` →
 * `CodexNativeRuntime.run` → the OLD `ApprovalStore` (UUID-style ids,
 * not surfaced to the user). When a step needed approval (`sf` shell,
 * `composio_execute_tool`, anything with side effects), the runtime
 * paused, the step returned the ASSISTANT_PAUSED_PLACEHOLDER, and the
 * workflow runner happily moved on with the placeholder as the "step
 * output." Downstream steps got garbage. In the original regression, all five
 * steps "completed" but only the final
 * step generated any real work; the rest had no Salesforce data /
 * sheet writes / drafts.
 *
 * New path: every step is a full harness conversation. The harness
 * owns the addressable approval registry (apr-xxxx), runtime.failed
 * action-bus events, and the runConversationFromResume entry point.
 * When the step pauses on approval, the workflow runner waits — by
 * polling `pending_approvals` table — until the user approves OR the
 * approval expires (TTL is per-row, default 24h). On approve, the
 * runner calls runConversationFromResume; the next loop iteration
 * either completes or pauses again on the next interrupted tool.
 *
 * The harness is now the default workflow path. Set
 * WORKFLOW_USE_HARNESS=off or step.useHarness=false only for deliberate
 * legacy/simple text-only debugging.
 */
const WORKFLOW_HARNESS_POLL_MS = parseInt(
  process.env.CLEMENTINE_WORKFLOW_HARNESS_POLL_MS ?? '5000', 10,
);
// Workflow cancellation has two durable entry points (the workflow run JSON
// and the generic Tasks-board run mirror). Translate either into the exact
// active child attempt quickly enough that a long model/tool wait feels
// killable, without polling on every token ourselves.
const WORKFLOW_CANCEL_POLL_CONFIG = Number.parseInt(
  process.env.CLEMENTINE_WORKFLOW_CANCEL_POLL_MS ?? '500',
  10,
);
const WORKFLOW_CANCEL_POLL_MS = Number.isFinite(WORKFLOW_CANCEL_POLL_CONFIG)
  ? Math.max(100, WORKFLOW_CANCEL_POLL_CONFIG)
  : 500;

interface ActiveWorkflowStepAttempt {
  sessionId: string;
  attempt: RunAttemptRef;
}

// One cancellation watcher per WORKFLOW RUN, not per fan-out item. A 200-item
// step can have several child attempts live at once; polling the two durable
// run stores once and fanning an exact latch to each child keeps Stop responsive
// without multiplying filesystem reads by worker concurrency.
const activeWorkflowStepAttempts = new Map<string, Map<string, ActiveWorkflowStepAttempt>>();
const workflowCancellationPolls = new Map<string, ReturnType<typeof setInterval>>();
const observedWorkflowRunCancellations = new Set<string>();

function latchWorkflowRunCancellation(workflowRunId: string): boolean {
  if (!observedWorkflowRunCancellations.has(workflowRunId)) {
    if (!isWorkflowRunCancelled(workflowRunId)) return false;
    observedWorkflowRunCancellations.add(workflowRunId);
  }
  for (const { sessionId, attempt } of activeWorkflowStepAttempts.get(workflowRunId)?.values() ?? []) {
    try {
      requestKill(sessionId, 'Workflow run cancelled by user.', attempt);
    } catch {
      // The durable cancelled run record remains authoritative; ordinary step
      // boundaries still stop progress if the event log is temporarily busy.
    }
  }
  return true;
}

function registerActiveWorkflowStepAttempt(
  workflowRunId: string,
  sessionId: string,
  attempt: RunAttemptRef,
): () => void {
  const attempts = activeWorkflowStepAttempts.get(workflowRunId) ?? new Map<string, ActiveWorkflowStepAttempt>();
  attempts.set(attempt.attemptId, { sessionId, attempt });
  activeWorkflowStepAttempts.set(workflowRunId, attempts);
  if (!workflowCancellationPolls.has(workflowRunId)) {
    const poll = setInterval(() => latchWorkflowRunCancellation(workflowRunId), WORKFLOW_CANCEL_POLL_MS);
    poll.unref?.();
    workflowCancellationPolls.set(workflowRunId, poll);
  }
  return () => {
    const current = activeWorkflowStepAttempts.get(workflowRunId);
    current?.delete(attempt.attemptId);
    if (current && current.size > 0) return;
    activeWorkflowStepAttempts.delete(workflowRunId);
    observedWorkflowRunCancellations.delete(workflowRunId);
    const poll = workflowCancellationPolls.get(workflowRunId);
    if (poll) clearInterval(poll);
    workflowCancellationPolls.delete(workflowRunId);
  };
}
// 24h aligns with approval-registry's DEFAULT_APPROVAL_TTL_MS so the workflow
// step waits exactly as long as the approval itself is alive. The reaper will
// expire the approval at 24h; we time out the workflow step on the same beat.
const WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS = parseInt(
  process.env.CLEMENTINE_WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS ?? `${24 * 60 * 60_000}`, 10,
);

function workflowHarnessEnabled(step: WorkflowStepInput): boolean {
  if ((step as unknown as { useHarness?: boolean }).useHarness === false) return false;
  return process.env.WORKFLOW_USE_HARNESS !== 'off';
}

/** Intent-routed per-step model (default on). off ⇒ steps ignore step.intent and
 *  run on the brain/explicit model — byte-identical to before. */
function workerIntentRoutingEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_WORKER_INTENT_ROUTING', 'on') || 'on').trim().toLowerCase() !== 'off';
}

interface WorkflowStepModelRoute {
  model?: string;
  trace?: {
    seam: 'workflow';
    stepId: string;
    attemptedIntent: string;
    matchedIntent: string | null;
    modelId: string;
    provider: string;
    source: string;
  };
}

/** Kill-switch (default on) for running workflow steps on Claude's tool-capable,
 *  gated SDK lane. Applies WHEREVER a step resolves to a Claude model — both when
 *  Claude is the active brain (untagged steps default to Claude) AND when a
 *  Codex-brain workflow INJECTS a Claude step via intent routing (e.g. a
 *  `intent:"design"` step bound to Claude). The gate chain (grounding /
 *  goal-fidelity / confirm-first / async approval) enforces safety in both cases,
 *  so an injected Claude step is as capable as a Claude-brain one. Set =off to
 *  revert to the prior read-only/Codex behavior. */
function claudeWorkflowLaneFlagEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_CLAUDE_WORKFLOW_FULL_LANE', 'on') || 'on').trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no');
}

/** True only when Claude is the ACTIVE BRAIN (and the lane is enabled). Decides
 *  whether an UNTAGGED step DEFAULTS to Claude (vs MODELS.primary / Codex). The
 *  Codex-brain path stays byte-identical: untagged steps never silently move to
 *  Claude — only an intent-routed step the user explicitly bound to Claude does. */
function claudeIsActiveWorkflowBrain(): boolean {
  if (!claudeWorkflowLaneFlagEnabled()) return false;
  try {
    return resolveRoleModel('brain').provider === 'claude';
  } catch {
    return false;
  }
}

function resolveWorkflowStepModel(step: WorkflowStepInput): WorkflowStepModelRoute {
  const explicit = step.model || undefined;
  if (explicit) return { model: explicit };
  if (workerIntentRoutingEnabled() && step.intent) {
    const routed = resolveRoleModel('worker', step.intent);
    return {
      model: routed.modelId,
      trace: {
        seam: 'workflow',
        stepId: step.id,
        attemptedIntent: step.intent,
        matchedIntent: routed.matchedIntent ?? null,
        modelId: routed.modelId,
        provider: routed.provider,
        source: routed.source,
      },
    };
  }
  // Claude-as-the-brain: an untagged step otherwise resolves to NO model and
  // falls to MODELS.primary (gpt-*) → text-only headless under claude_oauth, so a
  // tool-using step has no tool-capable executor. Bind it to the Claude brain
  // model so the gated Claude Agent SDK workflow-step lane (tool-capable) engages.
  if (claudeIsActiveWorkflowBrain()) {
    const modelId = getClaudeBrainModel();
    return {
      model: modelId,
      trace: {
        seam: 'workflow',
        stepId: step.id,
        attemptedIntent: step.intent ?? '',
        matchedIntent: null,
        modelId,
        provider: 'claude',
        source: 'claude-brain-default',
      },
    };
  }
  // Untagged step: preserve the {} contract — the agent builder falls back to
  // MODELS.primary, and the claude_oauth full-lane + kill-switch semantics above
  // stay byte-identical. EXCEPT the one broken state: a Codex brain whose
  // OPENAI_MODEL_* slot was repurposed for a BYO model id (e.g. glm-5.2 → Z.ai).
  // There a {} → MODELS.primary fallback would route the step to the BYO endpoint
  // (the 2026-06-29 acme/Apify step silently ran on GLM for exactly this
  // reason), so steer it to the canonical Codex model. Only fires for codex_oauth
  // with a non-Codex primary; a healthy Codex setup still returns {}.
  if (getActiveAuthMode() === 'codex_oauth' && resolveProvider(MODELS.primary) !== 'codex') {
    return {
      model: DEFAULT_CODEX_MODEL,
      trace: {
        seam: 'workflow',
        stepId: step.id,
        attemptedIntent: step.intent ?? '',
        matchedIntent: null,
        modelId: DEFAULT_CODEX_MODEL,
        provider: 'codex',
        source: 'codex-safe-default',
      },
    };
  }
  return {};
}

// NOTE: both predicates below are consulted at the SDK-lane dispatch ONLY after
// the step model is confirmed to be a Claude id (claudeAgentSdkWorkflowStepEnabled).
// So they gate purely on the kill-switch — a Claude step is a Claude step whether
// Claude is the brain or a Codex-brain workflow injected it via intent routing.
function workflowStepCanRunOnClaudeAgentSdk(step: WorkflowStepInput): boolean {
  // executeStep awaits runner-owned declarative approval before dispatch reaches
  // this predicate. An approved step can use the gated, tool-capable SDK lane.
  // Full gated lane: write/send run through the harness gate chain (grounding /
  // goal-fidelity / confirm-first / async approval) on the SDK worker tool
  // profile, with the step's session carrying the workflow's auto-approval grants.
  if (claudeWorkflowLaneFlagEnabled()) return true;
  if (step.sideEffect === 'write' || step.sideEffect === 'send') return false;
  if (stepLooksMutating(step) || stepLooksLikeIrreversibleSend(step.prompt)) return false;
  return true;
}

/** Whether THIS step should run the SDK workflow-step lane in tool-capable
 *  (gated mutating) mode rather than the read-only profile. True under the lane
 *  flag — so even read steps that hit external read-only APIs (DataForSEO via
 *  composio) have the tools — and required for any write/send step. Applies to an
 *  injected Claude step (Codex brain) exactly as to a Claude-brain step. */
function workflowStepUsesFullClaudeLane(step: WorkflowStepInput): boolean {
  if (!claudeWorkflowLaneFlagEnabled()) return false;
  return true;
}

function workflowAutoApprovalTools(workflow: WorkflowDefinition, step: WorkflowStepInput): string[] {
  if (step.allowedTools && step.allowedTools.length > 0) {
    return step.allowedTools;
  }

  const allowed = (workflow.allowedTools ?? [])
    .flatMap((tool) => {
      if (typeof tool === 'string') return [tool];
      if (!tool || typeof tool.name !== 'string') return [];
      return tool.approval === 'required' ? [] : [tool.name];
    })
    .filter((tool) => tool.trim().length > 0);

  // Enabled workflows are already user-approved automation. A wildcard
  // plan scope removes per-tool approval churn while the shared taxonomy
  // still gates admin/destructive calls before plan-scope is consulted.
  return allowed.length > 0 ? [...new Set(allowed)] : ['*'];
}

function exactApprovedSendTools(workflow: WorkflowDefinition, step: WorkflowStepInput): string[] {
  const candidates = [
    ...(step.call?.tool ? [step.call.tool] : []),
    ...workflowAutoApprovalTools(workflow, step),
  ];
  return [...new Set(candidates.filter((tool) => tool !== '*' && isIrreversibleSendSlug(tool)))];
}

/** A generic model step cannot turn an early prose approval into permission for
 * an unknown future send payload. In that case the concrete tool card owns the
 * single pause. Exact call/native-send steps keep the declarative preview gate. */
function shouldUseDeclarativeStepApproval(
  workflow: WorkflowDefinition,
  step: WorkflowStepInput,
): boolean {
  if (!step.requiresApproval) return false;
  if (step.sideEffect !== 'send') return true;
  return exactApprovedSendTools(workflow, step).length > 0;
}

interface HarnessStepResult {
  /** Structured when the step emitted workflow_step_result; the agent's
   *  prose reply/summary otherwise (backward-compat fallback). */
  output: unknown;
  /** True if any pauses-and-resumes happened during the step. */
  hadApprovals: boolean;
  approvalIds: string[];
  /** True when `output` came from an explicit workflow_step_result call
   *  rather than the prose fallback (telemetry / migration signal). */
  usedStructuredResult?: boolean;
  /** The real harness session id the step ran in — used by the per-step
   *  skill-execution judge to read this step's tool-call evidence. */
  sessionId: string;
  /** Which lane actually ran. 'claude_sdk' = the Claude Agent SDK workflow-step
   *  lane (whose pure-text synthesis output bypasses the runConversation content
   *  grounding the Codex/harness lane gets); used to scope Move 3's per-item
   *  grounding advisory so it never double-applies. */
  lane?: 'claude_sdk' | 'harness';
  route?: AssistantRouteDiagnostics;
}

function workflowModelRouteMeta(route: AssistantRouteDiagnostics | undefined): Record<string, unknown> | undefined {
  const normalized = normalizeRouteDiagnostics(route);
  if (!normalized) return undefined;
  return {
    routeKind: normalized.routeKind,
    requestedModel: normalized.requestedModel,
    effectiveModel: normalized.effectiveModel,
    provider: normalized.provider,
    transport: normalized.transport,
    mode: normalized.mode,
    falloverFrom: normalized.falloverFrom,
  };
}

function workflowHarnessRoute(step: WorkflowStepInput, stepModel: string | undefined): AssistantRouteDiagnostics {
  const effectiveModel = stepModel ?? resolveRoleModel('brain').modelId;
  return {
    routeKind: 'harness',
    surface: 'workflow',
    requestedModel: step.model ?? stepModel,
    effectiveModel,
    provider: resolveEffectiveProviderForModel(effectiveModel),
    transport: 'openai_agents_harness',
  };
}

/** Every harness workflow step emits the same explicit route evidence, even
 * when model resolution returned no intent trace (the normal untagged
 * Codex/BYO path). Proofs must never infer provider/transport from absence. */
function workflowHarnessRouteMarker(
  step: WorkflowStepInput,
  stepModel: string | undefined,
  trace?: WorkflowStepModelRoute['trace'],
): Record<string, unknown> {
  const route = workflowHarnessRoute(step, stepModel);
  return {
    ...(trace ?? {
      seam: 'workflow',
      stepId: step.id,
      attemptedIntent: step.intent ?? '',
      matchedIntent: null,
      source: step.model ? 'step-model' : 'brain-default',
    }),
    modelId: route.effectiveModel,
    provider: route.provider,
    transport: route.transport,
    modelRoute: workflowModelRouteMeta(route),
  };
}

function workflowHarnessMetadataMatches(
  session: HarnessSession,
  workflowName: string,
  stepId: string,
): boolean {
  const metadata = session.sessionRow.metadata;
  return session.sessionRow.kind === 'workflow'
    && metadata.source === 'workflow'
    && metadata.workflowName === workflowName
    && metadata.stepId === stepId;
}

function findParkedWorkflowHarnessSession(
  workflowName: string,
  stepId: string,
  workflowRunId: string,
): HarnessSession | null {
  const pending = approvalRegistry.listPending({ status: 'pending' });
  let fallback: HarnessSession | null = null;

  for (const row of pending) {
    const session = HarnessSession.load(row.sessionId);
    if (!session || !workflowHarnessMetadataMatches(session, workflowName, stepId)) continue;

    const metadata = session.sessionRow.metadata;
    if (metadata.workflowRunId === workflowRunId) return session;

    // Sessions created before workflowRunId was persisted still need to
    // resume cleanly after a daemon restart. Pick the newest pending
    // legacy session as a fallback; listPending is ordered newest first.
    if (metadata.workflowRunId === undefined && fallback === null) {
      fallback = session;
    }
  }

  return fallback;
}

function getWorkflowHarnessSession(
  workflowName: string,
  stepId: string,
  workflowRunId: string,
  sessionIdSuffix: string,
): HarnessSession {
  const deterministicSessionId = `workflow:${sessionIdSuffix}`;
  const existing = HarnessSession.load(deterministicSessionId);
  if (existing) return existing;

  const parked = findParkedWorkflowHarnessSession(workflowName, stepId, workflowRunId);
  if (parked) return parked;

  return HarnessSession.create({
    id: deterministicSessionId,
    kind: 'workflow',
    channel: 'workflow',
    title: `${workflowName}::${stepId}`,
    metadata: {
      source: 'workflow',
      workflowName,
      workflowRunId,
      stepId,
      sessionIdSuffix,
    },
  });
}

function markWorkflowHarnessSessionTerminal(
  session: HarnessSession,
  status: Extract<import('../runtime/harness/eventlog.js').SessionStatus, 'completed' | 'failed'>,
): void {
  try {
    if (!approvalRegistry.hasPending(session.id)) session.markStatus(status);
  } catch {
    // Session status is observability/recovery metadata; never mask step output.
  }
}

export const workflowRunnerInternalsForTest = {
  findParkedWorkflowHarnessSession,
  getWorkflowHarnessSession,
  awaitDeclarativeStepApproval,
  bindStepContext,
  buildGoalEvidenceText,
  formatStepOutputs,
  renderStepContextBlock,
  renderWorkflowOriginLineageBlock,
  hasCompletedUpstreamMutation: (steps: WorkflowStepInput[], blockedStepId: string, completedStepIds: Set<string>) =>
    hasCompletedUpstreamMutation(steps, blockedStepId, completedStepIds),
  hasUngatedIrreversibleAction,
  tryAutoHealAndRequeue,
  selfHealAutoMaxAttempts,
  resolveWorkflowStepModel,
  workflowStepCanRunOnClaudeAgentSdk,
  workflowStepUsesFullClaudeLane,
  shouldUseDeclarativeStepApproval,
  exactApprovedSendTools,
  workflowHarnessRouteMarker,
  isWorkflowRunCancelled,
  sampleStepAttemptMetrics,
};

async function runStepViaHarness(
  step: WorkflowStepInput,
  sessionIdSuffix: string,
  promptBody: string,
  workflowName: string,
  allowedTools: string[],
  workflowRunId: string,
  stepContext?: { values: Record<string, unknown>; upstream: Record<string, unknown>; item?: unknown; project?: WorkflowStepProjectContext },
  // P0 parking: true only at call sites where a thrown ParkRunSignal can
  // unwind to processOneRunFile. Plain/synthesis propagate directly; forEach
  // preserves the typed reason through its bounded pool and then propagates.
  canPark = false,
  // Workflow contract review, defect A: forEach ITEM workers must NOT get the
  // step's AGGREGATE contract (registered or injected) — a single-item worker
  // submitting one object would be refused against an array-of-N contract.
  isItemInvocation = false,
): Promise<HarnessStepResult> {
  // T-WF-1 — configure the codex OAuth bridge BEFORE the SDK runner
  // touches the model. Discord + chat-dock paths do this at every
  // entry; the workflow runner is a fresh entry too and the codex
  // model provider is registered lazily — without this, the first
  // model call inside runConversation fails with "Missing credentials.
  // Please pass an `apiKey`".
  const auth = await configureHarnessRuntime();
  if (!auth.ok) {
    throw new Error(
      `Codex auth not configured for workflow step "${step.id}": ${auth.reason ?? 'unknown'}`,
    );
  }
  // Per-step harness sessions must be stable across daemon restarts.
  // If the prior process parked on approval, reusing the same session
  // is what prevents a second approval from being minted for the same
  // workflow step.
  const session = getWorkflowHarnessSession(
    workflowName,
    step.id,
    workflowRunId,
    sessionIdSuffix,
  );
  const realSessionId = session.id;
  // The workflow's durable run id and the model's harness session are
  // intentionally different: one workflow can fan out into many child step
  // sessions. Give this PHYSICAL invocation its own attempt so a stale stop for
  // retry A cannot jump to retry B (or to a sibling item). A stable runId keeps
  // correlation while the random attempt id keeps execution ownership exact.
  const stepAttempt: RunAttemptRef = beginRunAttempt(realSessionId, {
    runId: `workflow-step:${sessionIdSuffix}`,
    attemptId: `attempt:workflow:${workflowRunId}:${randomUUID().slice(0, 12)}`,
  });
  let stepAttemptStatus: 'completed' | 'cancelled' | 'failed' | 'interrupted' = 'failed';
  let unregisterActiveAttempt = (): void => {};
  const stepAttemptWasKilled = (): boolean => {
    try { return isKillRequested(realSessionId, stepAttempt); } catch { return false; }
  };
  try {
    preserveCurrentKillAndClearStale(realSessionId, stepAttempt);
    unregisterActiveAttempt = registerActiveWorkflowStepAttempt(
      workflowRunId,
      realSessionId,
      stepAttempt,
    );
    openPlanScope({
      sessionId: realSessionId,
      planProposalId: `workflow:${workflowName}:${sessionIdSuffix}`,
      approvedPlanObjective: `Approved workflow "${workflowName}" step "${step.id}"`,
      ttlMs: WORKFLOW_STEP_WALL_CLOCK_MS + 60_000,
      allowedTools,
      allowedSends: step.requiresApproval
        ? allowedTools.filter((tool) => tool !== '*' && isIrreversibleSendSlug(tool))
        : [],
    });

    // Self-heal move 2: arm submission-time contract validation for this step
    // session (workflow_step_result refuses a wrong-shape result with the exact
    // problems while the model is still alive to fix it).
    if (!isItemInvocation) registerStepContract(realSessionId, step.output);
    const approvalIds: string[] = [];
    let hadApprovals = false;
    const startedAt = Date.now();

    // Close the race where the board was cancelled after the caller's last
    // step-boundary check but before this child attempt was registered.
    if (latchWorkflowRunCancellation(workflowRunId)) throw new WorkflowRunCancelledError();
    // Build a fresh orchestrator each call so it picks up current memory
    // context + connected toolkit list.
    // Initial turn.
    // Self-heal move 1 (2026-07-14): the output contract rides IN the prompt,
    // rendered from the same object the reduce gate verifies — the authored
    // prose can no longer drift from what the gate demands.
    const contractSpec = !isItemInvocation && step.output ? `\n\n${renderOutputContractSpec(step.output)}` : '';
    // Fold 3: the step's learned tool pin (if healthy) rides in with the contract.
    const pinSpec = !isItemInvocation ? renderWorkflowToolPin(workflowName, step.id) : '';
    const proseMessage = `Workflow: ${workflowName}\nStep: ${step.id}\n\n${promptBody}${contractSpec}${pinSpec}`;
    // Typed-contract delivery (P1): when the step declared inputs and the
    // contract flag + step agent are on, append the BOUND inputs/upstream
    // as a structured block AFTER the prose (never replacing it). This is
    // authoritative data the step can use even if a template token typo
    // dropped a value from the prose — it cannot be falsely starved.
    const message = useWorkflowStepAgent() && stepContext
      ? `${proseMessage}\n\n${renderStepContextBlock(stepContext, { workflowName, runId: workflowRunId })}`
      : proseMessage;
    const sourceUserEvent = recordRunAttemptUserInput(stepAttempt, {
      turn: 1,
      role: 'user',
      data: {
        text: message,
        workflowName,
        workflowRunId,
        stepId: step.id,
        attemptId: stepAttempt.attemptId,
      },
    });
    // Flag-gated (WORKFLOW_STEP_AGENT): the constrained step agent emits
    // structured output via workflow_step_result and CANNOT re-trigger
    // workflows (no recursion). Default off → the full orchestrator +
    // prose capture, byte-identical to prior behavior.
    // Intent-routed per-step model (CLEMMY_WORKER_INTENT_ROUTING, default on):
    // a step tagged with a user category word ("design") runs on the model the
    // user bound for it (worker role), e.g. Claude Opus — while untagged steps
    // stay on the brain. An explicit step.model still wins. The registered
    // RouterModelProvider dispatches the resolved id to its provider.
    const modelRoute = resolveWorkflowStepModel(step);
    const stepModel = modelRoute.model;
    const appendWorkerRoute = (data: Record<string, unknown>) => {
      try {
        appendHarnessEvent({
          sessionId: realSessionId,
          turn: 0,
          role: 'system',
          type: 'worker_model_routed',
          data,
        });
      } catch { /* trace is best-effort */ }
    };
    if (stepModel && claudeAgentSdkWorkflowStepEnabled(stepModel) && workflowStepCanRunOnClaudeAgentSdk(step)) {
      const fullLane = workflowStepUsesFullClaudeLane(step);
      // Approved-payload replay (2026-07-21): a re-admitted parked step re-runs
      // the model, which RE-COMPOSES its payload — the exact-payload resume key
      // then never matches the grant and a fresh approval mints forever (the
      // approve→re-ask treadmill). Claim the session's approved unconsumed
      // action and execute the APPROVED bytes first; the model finishes the
      // step from the result instead of re-proposing the action. Fail-open:
      // with nothing to replay this is a no-op.
      let approvedReplayNote = '';
      try {
        const { replayApprovedActionForSession, renderApprovedReplayNote } = await import('./approval-replay.js');
        const replayOutcome = await replayApprovedActionForSession(realSessionId);
        if (replayOutcome) approvedReplayNote = `\n\n${renderApprovedReplayNote(replayOutcome)}`;
      } catch { /* replay is best-effort; worst case the step re-asks */ }
      let sdkResult;
      try {
        sdkResult = await runClaudeAgentSdkWorkflowStep({
          step,
          workflowName,
          runId: workflowRunId, // attribute this step's fan-out to the workflow run
          prompt: approvedReplayNote ? `${message}${approvedReplayNote}` : message,
          modelId: stepModel,
          // Every SDK profile receives the real child session + exact source,
          // including read-only steps. Kill observation is a control-plane
          // requirement, not a mutating-tool capability.
          sessionId: realSessionId,
          sourceUserSeq: sourceUserEvent.seq,
          // The one-per-run watcher performs the durable file reads. The SDK
          // calls this hook at every stream message, so keep this hot path an
          // in-memory point read instead of hammering the filesystem.
          shouldCancel: () => observedWorkflowRunCancellations.has(workflowRunId),
          fullLane,
          parkApprovals: canPark && parkingEnabled(),
        });
      } catch (err) {
        if (err instanceof ClaudeAgentSdkApprovalBoundaryError && err.boundary.state === 'pending') {
          markWorkflowRunPausedForApproval(workflowRunId);
          throw new ParkRunSignal([{
            stepId: step.id,
            kind: 'sdk',
            approvalIds: [err.boundary.approvalId],
            sessionId: realSessionId,
          }]);
        }
        if (err instanceof AgentRuntimeCancelledError || stepAttemptWasKilled()) {
          throw new WorkflowRunCancelledError();
        }
        markWorkflowHarnessSessionTerminal(session, 'failed');
        throw err;
      }
      const route = normalizeRouteDiagnostics({
        routeKind: 'claude_agent_sdk_workflow_step',
        surface: 'workflow',
        requestedModel: step.model ?? stepModel,
        effectiveModel: sdkResult.model ?? stepModel,
        provider: 'claude',
        transport: 'claude_agent_sdk_workflow_step',
      });
      appendWorkerRoute({
        ...(modelRoute.trace ?? {
          seam: 'workflow',
          stepId: step.id,
          attemptedIntent: step.intent ?? null,
          matchedIntent: null,
          modelId: stepModel,
          provider: 'claude',
          source: step.model ? 'step-model' : 'default',
        }),
        modelId: stepModel,
        provider: 'claude',
        transport: 'claude_agent_sdk_workflow_step',
        sdkSessionId: sdkResult.sdkSessionId ?? null,
        sdkModel: sdkResult.model ?? null,
        toolUses: sdkResult.toolUses,
        structured: sdkResult.structured,
        modelRoute: workflowModelRouteMeta(route),
      });
      // Phantom-completion guard (#2): a send/write step that called no real tool
      // didn't actually act — surface it as blocked instead of a silent success.
      let sdkOutput = sdkResult.output;
      if (isPhantomStepCompletion(step, sdkResult.toolUses, sdkOutput)) {
        sdkOutput = phantomBlockedOutput(step);
      }
      stepAttemptStatus = 'completed';
      markWorkflowHarnessSessionTerminal(session, 'completed');
      return {
        output: sdkOutput,
        hadApprovals: false,
        approvalIds: [],
        usedStructuredResult: sdkResult.structured,
        sessionId: realSessionId,
        lane: 'claude_sdk',
        route,
      };
    }
    const route = workflowHarnessRoute(step, stepModel);
    appendWorkerRoute(workflowHarnessRouteMarker(step, stepModel, modelRoute.trace));
    const agent = useWorkflowStepAgent()
      ? await buildWorkflowStepAgent({ userInput: message, sessionId: realSessionId, lockTools: step.allowedTools, model: stepModel })
      : await buildWorkflowOrchestratorAgentImpl({ userInput: message, sessionId: realSessionId, model: stepModel });
    let result: RunConversationResult;
    if (session.loadInterruptState() || approvalRegistry.hasPending(realSessionId)) {
      result = {
        sessionId: realSessionId,
        status: 'awaiting_approval',
        steps: 0,
        lastTurn: 0,
      };
    } else {
      result = await runWorkflowConversationImpl({
        agent,
        sessionId: realSessionId,
        input: message,
        sourceUserSeq: sourceUserEvent.seq,
        reuseRecordedUserInput: true,
        // P2-10: bound the step on the harness path too. The legacy path passes
        // this (see below); without it a harness step fell back to the 120-min
        // chat budget, so a hung/runaway step wasn't bounded at the intended
        // 15 min. Env-tunable via CLEMENTINE_WORKFLOW_STEP_WALL_MS.
        maxWallClockMs: WORKFLOW_STEP_WALL_CLOCK_MS,
        // Stage 4: the WORKFLOW lane's token budget is the RUN-level advisory
        // — a per-step park here has no continue affordance and would fail the
        // step hard (a legit heavy fan-out step can exceed the chat preset).
        maxRunTokens: 0,
      });
    }

    // Loop until terminal (completed / failed / awaiting_user_input).
    while (result.status === 'awaiting_approval') {
      hadApprovals = true;
      // Tell the heartbeat we're parked — it'll suppress "still running"
      // notifications until we clear the flag below.
      markWorkflowRunPausedForApproval(workflowRunId);
      if (Date.now() - startedAt > WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS) {
        throw new Error(
          `workflow step "${step.id}" timed out waiting for approval after ${WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS / 1000}s`,
        );
      }

      // Find the pending registry row(s) for this session and surface a
      // user notification. The harness already registered the approval
      // via registerAndEmitApprovals on the SDK interrupt; here we
      // re-post a Discord-friendly nudge so the user sees the apr-xxxx
      // code from their main channel, not just the audit log.
      const pending = approvalRegistry.listPending({ sessionId: realSessionId, status: 'pending' });
      for (const row of pending) {
        if (!approvalIds.includes(row.approvalId)) {
          approvalIds.push(row.approvalId);
          try {
            addNotification({
              // Same stable ID as the harness approval notification.
              // addNotification dedupes by id, so workflow parking
              // enriches the dashboard/runtime state without creating
              // a second Discord/mobile card for the same decision.
              id: `approval-${row.approvalId}`,
              kind: 'approval',
              title: `Workflow ${workflowName} · ${step.id} needs approval`,
              body: `**${row.subject}**\n\nTap **Approve**, **Edit**, or **Reject** below — or reply \`approve ${row.approvalId}\` / \`reject ${row.approvalId}\` if you prefer. The workflow is parked on step \`${step.id}\` until you respond.`,
              createdAt: new Date().toISOString(),
              read: false,
              metadata: {
                approvalId: row.approvalId,
                sessionId: realSessionId,
                subject: row.subject,
                tool: row.tool,
                workflowName,
                stepId: step.id,
              },
            });
          } catch {
            /* notification is best-effort; the apr-xxxx is still
               discoverable via the dashboard + sessions table */
          }
        }
      }

      // P0 parking (flag on + parkable call site): if approvals are still
      // pending, release the slot instead of polling — unwind via
      // ParkRunSignal; `reapResolvedParkedRuns` resumes this run once they
      // clear. On re-entry after resume the pending set is empty, so we
      // skip the poll and fall through to the decision + resume below.
      // Flag-off (or a non-parkable forEach item) keeps the in-place poll
      // byte-identical to today.
      const stillPendingNow = approvalRegistry.listPending({ sessionId: realSessionId, status: 'pending' });
      if (parkingEnabled() && canPark && stillPendingNow.length > 0) {
        throw new ParkRunSignal([{ stepId: step.id, kind: 'sdk', approvalIds: [...approvalIds], sessionId: realSessionId }]);
      }
      if (stillPendingNow.length > 0) {
        // Poll for resolution. The reaper might expire stale rows; the
        // user might approve/reject; or all pending rows might clear via
        // a /cancel command. Loop until the session has no more pending.
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, WORKFLOW_HARNESS_POLL_MS));
          if (latchWorkflowRunCancellation(workflowRunId)) throw new WorkflowRunCancelledError();
          const stillPending = approvalRegistry.listPending({ sessionId: realSessionId, status: 'pending' });
          if (stillPending.length === 0) break;
          if (Date.now() - startedAt > WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS) {
            throw new Error(
              `workflow step "${step.id}" exceeded approval wait budget (${WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS}ms)`,
            );
          }
        }
      }

      // At this point at least one approval has been resolved. The most
      // recent resolution defines whether we approve or reject the SDK
      // interrupt — if any was rejected/cancelled, we reject; otherwise
      // approve. Mirror the same channel-side logic from
      // tryHandleHarnessApprovalReply.
      const resolved = approvalRegistry.listPending({ sessionId: realSessionId, status: 'any' });
      const anyRejected = resolved.some((r) => r.resolution === 'rejected' || r.resolution === 'cancelled_by_user');
      const anyExpired = resolved.some((r) => r.resolution === 'expired');
      const decision: 'approve' | 'reject' = (anyRejected || anyExpired) ? 'reject' : 'approve';

      result = await resumeWorkflowConversationImpl({
        agent,
        sessionId: realSessionId,
        decision,
        resolver: 'workflow-runner',
      });
      // Resume returned — the run is moving again. Clear the heartbeat
      // gate so the next "still running" interval can fire normally
      // (the loop will re-mark if another approval surfaces).
      clearWorkflowRunPausedForApproval(workflowRunId);
    }

    // `killed` has one meaning on this child: a user/control-plane stop. Never
    // let a previously captured partial result turn that stop into permission
    // for downstream workflow steps to continue.
    if (result.status === 'killed') {
      stepAttemptStatus = 'cancelled';
      throw new WorkflowRunCancelledError();
    }

    // Pull the user-visible output from the most recent
    // conversation_completed event for this session. The harness writes
    // `summary` (or `reply` when present) as the user-facing text.
    const { listEvents: listHarnessEvents } = await import('../runtime/harness/eventlog.js');
    const completed = listHarnessEvents(realSessionId, { types: ['conversation_completed'] });
    const lastCompletion = completed[completed.length - 1];
    const lastDecision = result.lastDecision;
    const prose = (lastDecision?.reply && lastDecision.reply.trim())
      || (lastDecision?.summary)
      || (lastCompletion?.data?.reply as string | undefined)
      || (lastCompletion?.data?.summary as string | undefined)
      || '';

    // The explicit structured result the step emitted via workflow_step_result
    // (captured full, unclipped, keyed by session). Taken once.
    const captured = takeStepResult(realSessionId);

    // Phantom-completion guard (#2), orchestrator-lane parity with the SDK
    // lane above: a send/write step that "completed" while calling ZERO real
    // tools never performed its action. The SDK lane gets tool evidence from
    // sdkResult.toolUses; here the equivalent ground truth is the step
    // session's tool_called events. workflow_step_result / StructuredOutput
    // are result emission, not action (inert set in isPhantomStepCompletion).
    const stepToolUses = listHarnessEvents(realSessionId, { types: ['tool_called'] })
      .map((e) => (typeof e.data?.tool === 'string' ? e.data.tool : ''))
      .filter((t) => t.length > 0);
    const guardPhantom = (output: unknown): unknown =>
      isPhantomStepCompletion(step, stepToolUses, output) ? phantomBlockedOutput(step) : output;

    // Fold 3 capture (best-effort, never blocks a step): remember the LAST
    // proven composio call of a step that emitted a real (non-blocked) result,
    // keyed workflow:<name>:<stepId> in the tool-choice store — the next run
    // of this step starts with the pin injected instead of re-discovering.
    if (!isItemInvocation && captured.found
      && !(captured.value && typeof captured.value === 'object' && (captured.value as { blocked?: unknown }).blocked === true)) {
      try {
        const returned = listHarnessEvents(realSessionId, { types: ['tool_returned'] })
          .filter((e) => e.data?.tool === 'composio_execute_tool'
            // Deterministic corrective-header check FIRST (review: prose-based
            // evidenceLooksFailedOrBlocked let every real composio failure
            // through — the step pinned a FAILED tool as proven).
            && !renderedComposioResultLooksFailed(typeof e.data?.result === 'string' ? e.data.result : undefined)
            && !evidenceLooksFailedOrBlocked(typeof e.data?.result === 'string' ? e.data.result : undefined));
        const lastOk = returned[returned.length - 1];
        const callId = lastOk?.data?.callId;
        if (callId) {
          const call = listHarnessEvents(realSessionId, { types: ['tool_called'] })
            .find((e) => e.data?.callId === callId);
          const rawArgs = typeof call?.data?.arguments === 'string' ? call.data.arguments : undefined;
          const parsed = rawArgs ? JSON.parse(rawArgs) as { tool_slug?: string; arguments?: string } : undefined;
          if (parsed?.tool_slug) {
            rememberToolChoice({
              intent: workflowStepPinIntent(workflowName, step.id),
              description: `Proven tool for workflow "${workflowName}" step "${step.id}"`,
              choice: {
                kind: 'composio',
                identifier: parsed.tool_slug,
                invocationTemplate: stripBakedConnectionId(parsed.arguments?.slice(0, 800)),
                testEvidence: `step completed with a non-blocked structured result (run session ${realSessionId.slice(0, 40)})`,
              },
            });
          }
        }
      } catch { /* pins are an optimization — never fail a step over them */ }
    }

    // A step is "done" only when the harness reports `completed`. The
    // awaiting_approval while-loop above guarantees a terminal status here.
    //   - `failed` = a real harness error → always throw (prior behavior).
    //   - A step that EXPLICITLY emitted its deliverable via
    //     workflow_step_result delivers it even on a SOFT non-completion
    //     (limit_exceeded / killed / awaiting_user_input): the step did its
    //     job and emitted the result before the limit/kill, so discarding that
    //     real partial would be a regression.
    //   - Otherwise (no explicit deliverable AND not `completed`) only the
    //     harness apology prose remains → throw so a guardrail-killed /
    //     limit-hit run can't masquerade as success. The throw unwinds to
    //     processOneRunFile, which classifies cancel-vs-error and reports back
    //     loudly (north-star: reports back without fail).
    if (result.status === 'failed') {
      throw new Error(
        `workflow step "${step.id}" failed via harness: ${result.error ?? describeStepNonCompletion('failed')}`,
      );
    }
    if (captured.found) {
      stepAttemptStatus = 'completed';
      return { output: guardPhantom(captured.value), hadApprovals, approvalIds, usedStructuredResult: true, sessionId: realSessionId, lane: 'harness', route };
    }
    if (result.status !== 'completed') {
      throw new Error(
        `workflow step "${step.id}" did not complete (status: ${result.status}): ${describeStepNonCompletion(result.status, result.error)}`,
      );
    }
    if (looksLikeWorkflowStepStructuralResultMiss(prose)) {
      throw new WorkflowStepStructuralResultError(step.id, prose);
    }
    stepAttemptStatus = 'completed';
    return { output: guardPhantom(prose), hadApprovals, approvalIds, usedStructuredResult: false, sessionId: realSessionId, lane: 'harness', route };
  } catch (err) {
    if (err instanceof ParkRunSignal) {
      stepAttemptStatus = 'interrupted';
    } else if (
      err instanceof WorkflowRunCancelledError
      || err instanceof AgentRuntimeCancelledError
      || isWorkflowRunCancelled(workflowRunId)
      || stepAttemptWasKilled()
    ) {
      stepAttemptStatus = 'cancelled';
      try { session.markStatus('cancelled'); } catch { /* run record remains canonical */ }
      if (!(err instanceof WorkflowRunCancelledError)) throw new WorkflowRunCancelledError();
    }
    throw err;
  } finally {
    unregisterActiveAttempt();
    try { finishRunAttempt(stepAttempt, stepAttemptStatus); } catch { /* control telemetry must not mask step outcome */ }
    // The submission-time contract dies with the step session (a later chat
    // turn on a reused session must never be gated).
    clearStepContract(realSessionId);
    // Belt + suspenders: clear the heartbeat gate in finally so a throw
    // mid-resume doesn't leave the heartbeat permanently suppressed
    // for the rest of the workflow run.
    clearWorkflowRunPausedForApproval(workflowRunId);
    closePlanScope(realSessionId, 'workflow-step-finished');
  }
}

/**
 * Run a single workflow step. Picks the right execution shape based
 * on the step's frontmatter hints (deterministic / forEach / plain).
 * Returns the step's output for downstream template rendering and the
 * final synthesis. Throws on irrecoverable errors.
 */
/**
 * Declarative approval gate (autonomous-by-default workflow model). The
 * runner — not the agent — owns the pause: it registers ONE approval for
 * (runId, stepId), surfaces a single notification, and polls until the
 * user resolves it. Resume-safe: the registry row is keyed by a stable
 * gate session id, so a daemon restart re-finds the pending/resolved
 * approval instead of re-prompting. Approved → return (step proceeds);
 * rejected/expired → throw (the run fails loudly and reports back).
 */
async function awaitDeclarativeStepApproval(
  ctx: StepExecutionContext,
  step: WorkflowStepInput,
): Promise<void> {
  const gateSessionId = `workflow-gate:${ctx.runId}:${step.id}`;
  const startedAt = Date.now();

  const settledResolution = (): string | undefined =>
    approvalRegistry
      .listPending({ sessionId: gateSessionId, status: 'any' })
      .find((r) => r.resolution)?.resolution ?? undefined;

  // Already resolved on a prior pass (resume) — honor it without re-prompting.
  const prior = settledResolution();
  if (prior) {
    if (prior === 'approved') return;
    throw new WorkflowStepNotApprovedError(`workflow step "${step.id}" was not approved (${prior})`);
  }

  // Unattended scheduled run: there is no human at 8am to click "approve".
  // For a scheduler-fired run of an ENABLED workflow, the human's consent WAS
  // the enable + the schedule, so a NON-SEND gate auto-approves (visibly —
  // the user is told the gate was bypassed and why). A SEND-class gate NEVER
  // auto-approves: the author put a human in front of an irreversible
  // outbound action, and "scheduled" doesn't revoke that — the run parks on
  // the durable approval and resumes whenever the user answers (the approval
  // card + watchdog make the wait loud, so this is a pause, not a deadlock).
  // Send-class includes the PROSE heuristic for undeclared steps — a
  // deliberate bias: the bad outcome of a false positive is "asked
  // permission unnecessarily"; the bad outcome of a false negative is an
  // unreviewed irreversible send (the wrong-mailbox incident class).
  // Manual/chat/dashboard runs (a person is present) always register the
  // gate and wait, exactly as before.
  if (
    ctx.workflow.enabled !== false
    && isUnattendedScheduledRun(ctx.runId)
    && stepSideEffectClass(step) !== 'send'
  ) {
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_started',
      stepId: step.id,
      meta: { gate: 'auto_approved_unattended', reason: 'enabled scheduled run — consent was enable + schedule' },
    });
    try {
      addNotification({
        id: `gate-autoapproved-${ctx.runId}-${step.id}`,
        kind: 'workflow',
        title: `Approval gate auto-approved: ${ctx.workflow.name} · ${step.id}`,
        body: `Scheduled run ${ctx.runId} reached the approval gate on step "${step.id}" with no one present, and the step is not a send — so it was auto-approved (your consent was enabling + scheduling the workflow). If this step should ALWAYS wait for you, declare \`sideEffect: send\` on it or remove the schedule.`,
        createdAt: new Date().toISOString(),
        read: false,
        silent: true,
        metadata: { workflow: ctx.workflow.name, runId: ctx.runId, stepId: step.id, gate: 'auto_approved_unattended' },
      });
    } catch { /* audit notification is best-effort */ }
    logger.info(
      { workflow: ctx.workflow.name, runId: ctx.runId, step: step.id },
      'declarative approval gate auto-approved for unattended scheduled run (enable was the consent; non-send step)',
    );
    return;
  }

  // Register the gate once (idempotent across resumes: only if none pending).
  const pending = approvalRegistry.listPending({ sessionId: gateSessionId, status: 'pending' });
  let row = pending[0];
  if (!row) {
    const subject = (step.approvalPreview && step.approvalPreview.trim())
      // Legibility (#1): show WHAT the step will do, not just its id — so the
      // approver (gated) or the audit stream (unattended/yolo) sees the real
      // action. Flows to the dashboard card, the notification, and Discord/Slack.
      || `Approve "${ctx.workflow.name}" step "${step.id}": ${describeWorkflowStepAction(step)}`;
    // The approvals table has `session_id REFERENCES sessions(id)` with
    // foreign_keys=ON, so a gate approval can only be registered once a
    // sessions row exists for the gate id. The declarative gate uses its
    // OWN synthetic session id (workflow-gate:<runId>:<stepId>) that no
    // other path creates — so ensure it here (load-or-create, idempotent
    // across resume) before register(), exactly as getWorkflowHarnessSession
    // does for the step session. Without this, register() throws
    // "FOREIGN KEY constraint failed" and the run fails before it can park.
    if (!HarnessSession.load(gateSessionId)) {
      HarnessSession.create({
        id: gateSessionId,
        kind: 'workflow',
        channel: 'workflow',
        title: `${ctx.workflow.name}::${step.id} (approval gate)`,
        metadata: {
          source: 'workflow',
          workflowName: ctx.workflow.name,
          workflowRunId: ctx.runId,
          stepId: step.id,
          gate: true,
        },
      });
    }
    row = approvalRegistry.register({
      sessionId: gateSessionId,
      subject,
      tool: 'workflow_approval_gate',
      ttlMs: WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS,
    });
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_started',
      stepId: step.id,
      meta: { gate: 'awaiting_approval', approvalId: row.approvalId },
    });
    try {
      addNotification({
        id: `approval-${row.approvalId}`,
        kind: 'approval',
        title: `Workflow ${ctx.workflow.name} · ${step.id} needs approval`,
        body: `**${subject}**\n\nApprove to let the workflow continue, or reject to stop it — reply \`approve ${row.approvalId}\` / \`reject ${row.approvalId}\`. The run is parked on \`${step.id}\` until you respond.`,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { approvalId: row.approvalId, workflowName: ctx.workflow.name, stepId: step.id, gate: true },
      });
    } catch { /* notification best-effort; apr id is in the dashboard */ }
  }

  // P0 parking (flag on): the gate is registered + the user notified, so
  // there is nothing left to do but wait on a human. Release the slot —
  // unwind via ParkRunSignal; `reapResolvedParkedRuns` resumes this run
  // once the approval clears, and the `prior` check at the top of this
  // function honors the resolution on re-entry. Flag-off keeps the
  // in-place poll below byte-identical to today.
  if (parkingEnabled()) {
    markWorkflowRunPausedForApproval(ctx.runId);
    throw new ParkRunSignal([{ stepId: step.id, kind: 'gate', approvalIds: [row.approvalId] }]);
  }

  markWorkflowRunPausedForApproval(ctx.runId);
  try {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, WORKFLOW_HARNESS_POLL_MS));
      throwIfWorkflowRunCancelled(ctx.runId);
      const resolution = settledResolution();
      if (resolution) {
        if (resolution === 'approved') return;
        throw new WorkflowStepNotApprovedError(`workflow step "${step.id}" was not approved (${resolution})`);
      }
      if (Date.now() - startedAt > WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS) {
        throw new WorkflowStepNotApprovedError(`workflow step "${step.id}" exceeded approval wait budget (${WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS}ms)`);
      }
    }
  } finally {
    clearWorkflowRunPausedForApproval(ctx.runId);
  }
}

/**
 * Bind a step's declared inputs plus dependency outputs. `dependsOn`
 * always carries upstream data into the structured step context; explicit
 * `inputs` remain the typed contract for named values and missing-required
 * fast-fail behavior.
 */
function bindStepContext(
  step: WorkflowStepInput,
  ctx: StepExecutionContext,
  item?: unknown,
): { values: Record<string, unknown>; upstream: Record<string, unknown>; item?: unknown; project?: WorkflowStepProjectContext } | undefined {
  const bound = bindStepInputs(step, ctx.inputs, ctx.stepOutputs, item);
  if (bound.missing.length > 0) {
    const message =
      `Step "${step.id}" missing required input(s): ${bound.missing.join(', ')}`
      + ` — expected from input.<key> or steps.<dep>.output. Fix the step's \`inputs\` bindings or the run inputs.`;
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_failed',
      stepId: step.id,
      error: message,
      meta: { reason: 'unbound_required_input', missing: bound.missing },
    });
    throw new Error(message);
  }
  const hasValues = Object.keys(bound.values).length > 0;
  const hasUpstream = Object.keys(bound.upstream).length > 0;
  const hasItem = item !== undefined;
  const project = resolveWorkflowStepProjectContext(step, ctx.workflow);
  if (!hasValues && !hasUpstream && !hasItem && !project) return undefined;
  return { values: bound.values, upstream: bound.upstream, item, ...(project ? { project } : {}) };
}

/**
 * Typed-contract EXIT half — now UNCONDITIONAL (the WORKFLOW_CONTRACT_OUTPUT
 * rollout flag was removed per feedback_no_rollout_flags; validated behavior
 * is the default). When a step declares an `output` contract, the runner
 * verifies the emitted value actually matches it (type / required_keys /
 * verify.path_exists / verify.url_present) BEFORE recording step_completed. A
 * contract failure is a real failure: emit step_failed + throw so the run
 * reports back loudly instead of feeding malformed or fabricated data
 * downstream (the missing-artifact "claimed success, no URL" class). A step with NO
 * declared contract is unverified — byte-identical to before — so existing
 * workflows are unaffected; the contract IS the per-step opt-in.
 *
 * Step retry is likewise unconditional (WORKFLOW_STEP_RETRY removed): a step
 * that fails with a TRANSIENT error (network blip, timeout, 5xx, rate-limit)
 * is retried up to its declared `retryBudget` with exponential backoff, so a
 * momentary hiccup doesn't halt a long-running workflow. Deterministic
 * failures (bad input, contract mismatch, approval rejection) are NEVER
 * retried. retryBudget defaults to 0 → no retry unless the step opts in.
 */
const RETRY_BACKOFF_BASE_MS = parseInt(
  process.env.CLEMENTINE_WORKFLOW_RETRY_BASE_MS ?? '2000', 10,
);

/**
 * Classify an error as transient (worth retrying) vs deterministic. Pure
 * + exported for tests. Conservative: only well-known transient signals
 * match; anything else is treated as deterministic so we never loop on a
 * real bug. ParkRunSignal / cancellation are handled by the caller before
 * this is consulted.
 */
// The transient-vs-deterministic classifier now lives in a pure leaf module
// (transient-error.ts) so low-level tool modules (composio-tools) can share it
// without importing this high-level runner. Imported for internal step-retry
// use + re-exported for back-compat with existing importers.
import { isAuthRecoverableError, isTransientStepError, isUnparseableToolCallError } from './transient-error.js';
export { isTransientStepError };

/**
 * Pure retry harness around an execution thunk. Retries on a transient
 * error up to `budget` times with exponential backoff. `isRetryable`
 * lets the caller veto (park/cancel signals must propagate immediately).
 * `onRetry` is the side-effect hook (event log). Exported for tests so
 * the loop logic is verified without the full step machinery.
 */
export async function runWithStepRetry<T>(
  run: () => Promise<T>,
  opts: {
    budget: number;
    backoffBaseMs: number;
    isRetryable: (err: unknown) => boolean;
    onRetry?: (info: { attempt: number; budget: number; delayMs: number; err: unknown }) => void;
    sleep?: (ms: number) => Promise<void>;
    afterBackoff?: () => void;
  },
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= opts.budget || !opts.isRetryable(err)) throw err;
      attempt += 1;
      const delayMs = opts.backoffBaseMs * 2 ** (attempt - 1);
      opts.onRetry?.({ attempt, budget: opts.budget, delayMs, err });
      await sleep(delayMs);
      opts.afterBackoff?.();
    }
  }
}

/** A TRANSIENT-only retry floor: even a step that declared no retryBudget gets
 *  this many automatic retries on a network/infra blip (the retry harness gates
 *  on isTransientStepError, so a real deterministic failure still fails on
 *  attempt 1). Default 2 (P1-6: was 1) so an unattended run survives a brief
 *  Codex/network 5xx window, not just a single blip — a live scheduled run died
 *  after one retry against a ~46s 503 outage. With exp backoff (2s, 4s) two
 *  retries span ~6s; a SUSTAINED outage still needs the run-level re-queue
 *  (follow-up). Set CLEMENTINE_WORKFLOW_TRANSIENT_RETRY_FLOOR=0 to restore the
 *  old fail-fast-on-transient behavior. */
function transientRetryFloor(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMENTINE_WORKFLOW_TRANSIENT_RETRY_FLOOR', '2') || '2', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
}

/**
 * Goal-contract Phase 2: is this step eligible to loopUntil its contract?
 * The SIDE-EFFECT LAW, enforced at runtime (belt) on top of the authoring
 * validator (braces):
 *  - declares loopUntil + an output contract (the contract IS the exit cond)
 *  - plain LLM step only (v1): not forEach, not deterministic
 *  - 'read' steps loop freely; 'write' requires the author's explicit
 *    loopSafe idempotency assertion; 'send' NEVER loops — re-running a send
 *    is re-sending (the park→approve→crash double-send lesson).
 * Pure + exported for tests.
 */
export function stepLoopUntilEnabled(step: WorkflowStepInput): boolean {
  if (!step.loopUntil) return false;
  // Exit condition: the step's own output contract, an external probe
  // (T2.3: deterministic scripts/ helper verified against `until`), or both.
  if (!step.output && !stepHasLoopProbe(step)) return false;
  if (step.forEach || step.deterministic) return false;
  if (structuredCallNeedsMutationReceipt(step)) return false;
  const cls = stepSideEffectClass(step);
  if (cls === 'send') return false;
  if (cls === 'write' && step.loopSafe !== true) return false;
  return true;
}

/** T2.3: does the step declare a complete external exit probe? */
export function stepHasLoopProbe(step: WorkflowStepInput): boolean {
  return Boolean(step.loopUntil?.probe?.runner?.trim() && step.loopUntil.until);
}

/** Clamped loopUntil attempt ceiling (default 3; contract loops 1–5, probe
 *  loops 1–10 — polling external state legitimately needs more passes). */
export function loopUntilMaxAttempts(step: WorkflowStepInput): number {
  const raw = step.loopUntil?.maxAttempts ?? 3;
  const ceiling = stepHasLoopProbe(step) ? 10 : 5;
  return Math.max(1, Math.min(ceiling, Math.floor(raw)));
}

/** Evidence note appended to a loopUntil retry's prompt so the next attempt
 *  fixes the SPECIFIC contract gap instead of re-rolling blind. */
export function renderLoopRetryEvidence(attempt: number, problems: string[]): string {
  return [
    '',
    `⚠ CONTRACT RETRY (attempt ${attempt + 1}): your previous attempt's output FAILED its declared contract:`,
    ...problems.slice(0, 6).map((p) => `- ${p}`),
    'Fix these specific gaps this attempt. Produce output that satisfies the declared contract — if the data genuinely is not available, return {"blocked": true, "reason": "<why>"} instead of an empty or malformed result.',
  ].join('\n');
}

/** Per-attempt records are ALWAYS emitted — the loopUntil STATE pillar and the
 *  self-improvement proposer's input signal. Graduated from CLEMMY_ATTEMPT_RECORDS
 *  2026-06-24: there was never a reason to turn this telemetry off. (Kept as a
 *  named predicate so call sites read clearly.) */
export function attemptRecordsEnabled(): boolean {
  return true;
}

/** Cumulative {tokens,toolCalls} snapshot for a step's session — the loop diffs
 *  before/after each attempt to attribute that attempt's cost. */
export interface AttemptMetricSample { tokens: number; toolCalls: number; }

/** Diff this attempt's contract problems against the prior attempt's so an
 *  attempt_record reads as "what changed", not just "still failing". Pure. */
export function summarizeAttemptChange(
  attempt: number,
  problems: string[],
  priorProblems: string[] | undefined,
): string {
  if (!priorProblems) return `attempt ${attempt}: ${problems.length} contract problem${problems.length === 1 ? '' : 's'}`;
  const prev = new Set(priorProblems);
  const curr = new Set(problems);
  const fixed = priorProblems.filter((p) => !curr.has(p)).length;
  const fresh = problems.filter((p) => !prev.has(p)).length;
  const persisting = problems.filter((p) => prev.has(p)).length;
  return `attempt ${attempt}: fixed ${fixed}, ${fresh} new, ${persisting} still failing`;
}

/**
 * Pure contract-loop harness (goal-contract Phase 2), shaped like
 * runWithStepRetry so the loop logic is testable without the step machinery.
 * Re-runs the thunk while it throws WorkflowContractViolationError, feeding
 * each retry an amended step whose prompt carries the failure evidence.
 * Anything that is NOT a contract violation propagates immediately.
 *
 * When `sampleMetrics` is supplied, the loop times each attempt and diffs the
 * cumulative snapshot before/after to attribute per-attempt tokens/toolCalls,
 * handing them to onLoopRetry for the STATE-pillar attempt_record. Stays pure:
 * the sampler is injected, so tests drive it without the step machinery.
 */
export async function runWithContractLoop<T>(
  run: (attemptStep: WorkflowStepInput) => Promise<T>,
  step: WorkflowStepInput,
  opts: {
    maxAttempts: number;
    sampleMetrics?: () => AttemptMetricSample;
    onLoopRetry?: (info: {
      attempt: number;
      maxAttempts: number;
      problems: string[];
      metrics: { durationMs: number; tokens?: number; toolCalls?: number };
    }) => void;
    beforeRetry?: () => void;
  },
): Promise<T> {
  let attemptStep = step;
  let attemptStartMs = Date.now();
  let startSample = opts.sampleMetrics?.();
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(attemptStep);
    } catch (err) {
      if (!(err instanceof WorkflowContractViolationError) || attempt >= opts.maxAttempts) throw err;
      const endSample = opts.sampleMetrics?.();
      const metrics = {
        durationMs: Date.now() - attemptStartMs,
        tokens: startSample && endSample ? Math.max(0, endSample.tokens - startSample.tokens) : undefined,
        toolCalls: startSample && endSample ? Math.max(0, endSample.toolCalls - startSample.toolCalls) : undefined,
      };
      opts.onLoopRetry?.({ attempt, maxAttempts: opts.maxAttempts, problems: err.problems, metrics });
      opts.beforeRetry?.();
      attemptStep = { ...step, prompt: `${step.prompt}\n${renderLoopRetryEvidence(attempt, err.problems)}` };
      attemptStartMs = Date.now();
      startSample = endSample;
    }
  }
}

/** Brain-fallover opt-in — shared with the harness's CLEMMY_BRAIN_FALLOVER.
 *  Default off: a step runs on its resolved brain only. */
function workflowBrainFalloverEnabled(): boolean {
  // Default ON (kill-switch CLEMMY_BRAIN_FALLOVER=off) — parity with the router +
  // chat lanes. A workflow step whose brain is expired/overloaded/hung re-runs on
  // the next connected brain (canSwitchBrainForStep still blocks re-running a step
  // that already recorded an external write, so a switch can never double-act).
  return (getRuntimeEnv('CLEMMY_BRAIN_FALLOVER', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/** Step-boundary cross-provider fallover. Runs the step on its resolved brain
 *  first (with the normal transient-retry budget); if that brain's PROVIDER is
 *  still failing transiently after retries, re-runs the WHOLE step on the next
 *  connected brain (Codex → Claude → BYO order, minus the current one). This is
 *  the only safe place to switch providers: a 529 thrown mid-stream (21 min into
 *  an agentic run) can't be transplanted to another model, but a fresh step
 *  attempt can. Guarded for write/send steps: never re-run a step that already
 *  recorded an external write (would double-act) — surface the original error.
 *  Healthy runs and read steps are unaffected; the extra attempts only fire on a
 *  post-retry transient (provider-overload) failure. */
/** Fold 3 (proposal-builder parity, 2026-07-14): workflow-step tool pins ride
 *  the EXISTING tool-choice store as intents named workflow:<name>:<stepId> —
 *  zero new storage. A successful step's last proven composio call is
 *  remembered with provenance; future runs get it INJECTED into the step
 *  prompt ("try this first"), like auto-brief's author-time pinning without
 *  the hand-authoring. Never mutates the user's SKILL.md. */
function workflowStepPinIntent(workflowName: string, stepId: string): string {
  return `workflow:${workflowName}:${stepId}`;
}

/** Render the learned pin for prompt injection, or '' when none/unhealthy. */
function renderWorkflowToolPin(workflowName: string, stepId: string): string {
  try {
    // EXACT lookup only (review: the fuzzy fallback matched unrelated generic
    // records and injected them with fabricated 'proven in a prior run' provenance).
    const record = peekToolChoice(workflowStepPinIntent(workflowName, stepId));
    const choice = record?.choice;
    if (!choice || choice.kind !== 'composio' || !choice.identifier) return '';
    // A pin that has failed more than it has worked is retired from injection —
    // the store keeps the track record; we just stop recommending it.
    if ((choice.failureCount ?? 0) > (choice.successCount ?? 0)) return '';
    const args = choice.invocationTemplate ? ` with args like: ${choice.invocationTemplate.slice(0, 600)}` : '';
    return `\n\nLEARNED TOOL PIN (proven in a prior run of this step, last validated ${choice.testedAt}${choice.successCount ? `, ${choice.successCount}x since` : ''}): call composio_execute_tool slug "${choice.identifier}"${args}. Try this FIRST; if it fails, adapt or rediscover rather than repeating it blindly.`;
  } catch { return ''; }
}

/** Approval rejection/expiry is a HUMAN decision or a hard gate — control
 *  flow, never a soft failure an optional step may gap past (fold-1 review
 *  the workflow retry review). Message text preserved for NON_RETRYABLE_RE + consumers. */
export class WorkflowStepNotApprovedError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkflowStepNotApprovedError'; }
}

async function executeStepVerified(
  step: WorkflowStepInput,
  ctx: StepExecutionContext,
): Promise<unknown> {
  try {
    return await executeStepVerifiedInner(step, ctx);
  } catch (err) {
    // Control-flow signals always propagate — a park/cancel/approval-rejection
    // is a decision, not a soft failure an optional step may gap past.
    if (err instanceof ParkRunSignal || err instanceof WorkflowRunCancelledError || err instanceof WorkflowStepNotApprovedError) throw err;
    if (step.optional !== true) throw err;
    // Only READ-class enrichment may gap (fold-1 review): a send/write step —
    // or any step whose session may already have recorded an external write —
    // must surface its error loudly; gapping it would put a false "produced no
    // data" claim in the manifest over a possibly-fired irreversible send.
    if (stepSideEffectClass(step) !== 'read' || !canSwitchBrainForStep(step, ctx)) throw err;
    // Fold 1 (proposal-builder parity, 2026-07-14): an OPTIONAL enrichment step
    // degrades to a DECLARED GAP instead of halting the run — "note it and
    // continue with available data". Downstream bindings and the synthesis see
    // {gap:true, reason} (the context block already forbids fabricating around
    // missing data), and the manifest records the soft failure honestly.
    const reason = err instanceof Error ? err.message : String(err);
    // Shape speaks the codebase's soft-failure vocabulary (fold-1 review):
    // ok:false + error makes detectBlockedSteps classify self_reported_failure
    // → needsAttention, failure ledger, pattern penalty — a permanently broken
    // optional step can never report clean success forever. blocked:true meta
    // emits workflow_node_blocked, not _completed.
    const errText = `Optional step "${step.id}" produced no data: ${reason.slice(0, 400)}`;
    const gap = { gap: true, ok: false, error: errText, reason: errText };
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_completed',
      stepId: step.id,
      output: gap,
      meta: { softFailed: true, optional: true, blocked: true, error: reason.slice(0, 500) },
    });
    try {
      recordStepOutput({ workflowName: ctx.workflowSlug, runId: ctx.runId, stepId: step.id, output: gap, nowIso: new Date().toISOString() });
    } catch { /* best-effort */ }
    logger.warn({ stepId: step.id, reason: reason.slice(0, 200) }, 'optional workflow step failed — continuing with a declared gap');
    return gap;
  }
}

/** Does this step failure justify re-running the step on a DIFFERENT connected
 *  brain? Yes for a transient provider failure (overload/5xx/timeout), an
 *  unparseable-tool-call (a flaky model stumble a different brain won't
 *  reproduce), a structural-result error, OR an AUTH-expired brain — all
 *  recoverable by switching. A real deterministic error (bad input, contract,
 *  non-auth 4xx) repeats identically on any model, so it fails fast. Auth-expiry
 *  is the case that reached this gate blind before 2026-07-20: an expired Claude
 *  token is a 401 that isTransientStepError classifies deterministic, so the whole
 *  step hard-failed instead of switching to the connected Codex/BYO brain the user
 *  configured — the exact "why didn't my fallback fire" bug. Named + exported so
 *  the decision is unit-tested, mirroring the chat lane's isChatBrainFalloverEligible. */
export function isWorkflowStepBrainFalloverEligible(err: unknown): boolean {
  return isTransientStepError(err)
    || isUnparseableToolCallError(err)
    || isWorkflowStepStructuralResultError(err)
    || isAuthRecoverableError(err);
}

async function executeStepVerifiedInner(
  step: WorkflowStepInput,
  ctx: StepExecutionContext,
): Promise<unknown> {
  if (!workflowBrainFalloverEnabled() || step.deterministic) {
    return runStepVerifiedAttempt(step, ctx);
  }
  const currentProvider = resolveEffectiveProviderForModel(
    resolveWorkflowStepModel(step).model ?? defaultForRole('brain'),
  ) as BrainProviderClass;
  const nextBrains = falloverBrainModelIds(currentProvider);
  if (nextBrains.length === 0) return runStepVerifiedAttempt(step, ctx);

  let lastErr: unknown;
  // Attempt 0 = the step's own brain; 1..N = each fallover brain.
  for (let i = 0; i <= nextBrains.length; i++) {
    const target = i === 0 ? null : nextBrains[i - 1];
    if (target) {
      // Side-effect guard (only matters once we're SWITCHING, i>0): a write/send
      // step that already claimed an external write must not re-run on a new
      // brain. Read steps re-run freely.
      if (!canSwitchBrainForStep(step, ctx)) {
        logger.warn({ stepId: step.id, to: target.provider }, 'workflow step failed on its brain but already wrote externally — not re-dispatching (would double-act)');
        break;
      }
      appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
        kind: 'step_advisory',
        stepId: step.id,
        meta: { reason: 'brain_fallover', from: currentProvider, to: target.provider, toModel: target.modelId },
      });
      logger.warn({ stepId: step.id, from: currentProvider, to: target.provider, model: target.modelId }, 'workflow step provider failing — switching brain at step boundary');
    }
    const attemptStep = target ? { ...step, model: target.modelId } : step;
    try {
      return await runStepVerifiedAttempt(attemptStep, ctx);
    } catch (err) {
      if (err instanceof ParkRunSignal || err instanceof WorkflowRunCancelledError) throw err;
      // A real deterministic error (bad input, contract, 4xx) repeats identically
      // on any model — fail fast, don't burn the whole chain.
      if (!isWorkflowStepBrainFalloverEligible(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Read steps (and steps that have not yet recorded an external write) are safe
 *  to re-run on another brain. A write/send step that ALREADY recorded an
 *  external_write under its deterministic session is NOT — re-running could
 *  double-send. Mirrors the forEach crash-resume reconciliation. */
function canSwitchBrainForStep(step: WorkflowStepInput, ctx: StepExecutionContext): boolean {
  if (stepSideEffectClass(step) === 'read') return true;
  try {
    const sid = getWorkflowHarnessSession(ctx.workflow.name, step.id, ctx.runId, `${ctx.runId}:${step.id}`).id;
    return listHarnessEvents(sid, { types: ['external_write'] }).length === 0;
  } catch {
    // If we can't prove it's clean, be conservative: don't re-run a mutating step.
    return false;
  }
}

async function runStepVerifiedAttempt(
  step: WorkflowStepInput,
  ctx: StepExecutionContext,
): Promise<unknown> {
  const declared = step.retryBudget && step.retryBudget > 0 ? step.retryBudget : 0;
  const budget = Math.max(declared, transientRetryFloor());
  // Transient-retry wraps EXECUTION only. Verification is deterministic and
  // never transient-retried. Park/cancel signals propagate immediately (they
  // are not "retryable").
  const runOnce = (attemptStep: WorkflowStepInput): Promise<unknown> =>
    runWithStepRetry(() => executeStep(attemptStep, ctx), {
      budget,
      backoffBaseMs: RETRY_BACKOFF_BASE_MS,
      isRetryable: (err) =>
        !(err instanceof ParkRunSignal) &&
        !(err instanceof WorkflowRunCancelledError) &&
        (isTransientStepError(err) || isWorkflowStepStructuralResultError(err)) &&
        // Bug #8: never transient-retry a step whose send already fired — a retry
        // re-prompts the session from turn 0 and re-issues the send. Surface the
        // error instead (mirrors the forEach itemSendAlreadyFired guard). #2.2
        !stepSendAlreadyFired(ctx.runId, step.id),
      onRetry: ({ attempt, budget: b, delayMs, err }) => {
        appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
          kind: 'step_retry',
          stepId: step.id,
          error: err instanceof Error ? err.message : String(err),
          meta: { attempt, budget: b, delayMs, reason: isWorkflowStepStructuralResultError(err) ? 'structural_result' : 'transient' },
        });
        logger.warn(
          { stepId: step.id, attempt, budget: b, delayMs, err: err instanceof Error ? err.message : String(err) },
          'workflow step failed with a retryable step-boundary error — retrying after backoff',
        );
      },
      afterBackoff: () => throwIfWorkflowRunCancelled(ctx.runId),
    });

  // Goal-contract Phase 2: contract loop wraps the transient-retry wrapper —
  // each contract attempt gets its own transient budget. Ineligible steps
  // (no loopUntil, no contract, forEach/deterministic, send, unsafe write)
  // run exactly once: byte-identical to the pre-loopUntil behavior.
  if (!stepLoopUntilEnabled(step)) return runOnce(step);
  // T2.3 (external exit): a declared probe runs AFTER each successful attempt —
  // a deterministic scripts/ helper whose output is verified against `until`.
  // Unsatisfied → throw a contract violation so the SAME loop machinery
  // re-runs the step with the probe's evidence folded into the prompt. This is
  // what makes "poll until the job reports done" / "page until nothing
  // unprocessed remains" authorable as typed code instead of prompt hopes.
  const runAttempt = !stepHasLoopProbe(step)
    ? runOnce
    : async (attemptStep: WorkflowStepInput): Promise<unknown> => {
        const output = await runOnce(attemptStep);
        const probe = step.loopUntil!.probe!;
        const probeOutput = await runDeterministicWorkflowStep(probe.runner, {
          workflow: ctx.workflow.name,
          workflowSlug: ctx.workflowSlug,
          runId: ctx.runId,
          stepId: `${step.id}#probe`,
          inputs: ctx.inputs,
          stepOutputs: { ...ctx.stepOutputs, [step.id]: output },
          project: resolveWorkflowStepProjectContext(step, ctx.workflow),
        });
        const verdict = verifyStepOutput(step.loopUntil!.until, probeOutput);
        if (!verdict.ok) {
          const problems = verdict.problems.map((p) => `loop probe (${probe.runner}): ${p}`);
          throw new WorkflowContractViolationError(
            `step "${step.id}" loop probe did not satisfy its until contract: ${problems.join('; ')}`,
            step.id,
            problems,
            'output_contract',
          );
        }
        return output;
      };
  const recordAttempts = attemptRecordsEnabled();
  // STATE pillar: closure tracks the prior attempt's problems so each record
  // reads as a delta. Only allocated when records are on (flag-off ⇒ no I/O).
  let priorProblems: string[] | undefined;
  return runWithContractLoop(runAttempt, step, {
    maxAttempts: loopUntilMaxAttempts(step),
    // Only sample when recording — the snapshot reads today's usage NDJSON +
    // the step's harness events, which we must not pay for when the flag is off.
    sampleMetrics: recordAttempts ? () => sampleStepAttemptMetrics(step, ctx) : undefined,
    onLoopRetry: ({ attempt, maxAttempts, problems, metrics }) => {
      appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
        kind: 'step_loop_retry',
        stepId: step.id,
        meta: { attempt, maxAttempts, problems: problems.slice(0, 6) },
      });
      if (recordAttempts) {
        const record: AttemptRecord = {
          attemptIndex: attempt,
          maxAttempts,
          failedProblems: problems.slice(0, 6),
          changeSummary: summarizeAttemptChange(attempt, problems, priorProblems),
          metrics,
        };
        appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
          kind: 'attempt_record',
          stepId: step.id,
          attempt: record,
        });
        priorProblems = problems;
      }
      logger.info(
        { stepId: step.id, attempt, maxAttempts, problems: problems.slice(0, 3) },
        'workflow step output failed its contract — loopUntil re-running with evidence',
      );
    },
    beforeRetry: () => throwIfWorkflowRunCancelled(ctx.runId),
  });
}

/** Best-effort cumulative {tokens,toolCalls} for a loopUntil step's deterministic
 *  session — tokens from today's usage NDJSON (source-keyed), toolCalls from the
 *  harness event log. runWithContractLoop diffs this before/after each attempt to
 *  attribute per-attempt cost. Never throws: an unreadable session yields zeros so
 *  the metric is simply absent rather than crashing a retry. */
function sampleStepAttemptMetrics(step: WorkflowStepInput, ctx: StepExecutionContext): AttemptMetricSample {
  try {
    const sid = getWorkflowHarnessSession(ctx.workflow.name, step.id, ctx.runId, `${ctx.runId}:${step.id}`).id;
    const toolCalls = projectCanonicalTopLevelToolEvents(
      listHarnessEvents(sid, { types: ['tool_called'] }),
      'tool_called',
    ).length;
    const tokens = sumUsageTokensForSource(sid);
    return { tokens, toolCalls };
  } catch {
    return { tokens: 0, toolCalls: 0 };
  }
}

/**
 * Single chokepoint for "this step finished with this output". Verifies the
 * output against its declared contract BEFORE recording step_completed, then
 * emits step_completed. Verifying first guarantees a contract-rejected output
 * is NEVER written as a completed step — otherwise computeResumeState (and any
 * re-queue) would treat the bad value as a valid done step and feed it
 * downstream. On contract failure: emit step_failed + throw (a deterministic
 * error, so the retry wrapper won't re-run it). Flag-off / no contract → a
 * straight step_completed emit, byte-identical to before. Every step shape
 * (deterministic / forEach / plain / synthesis) routes through this.
 */
/**
 * Contract BINDING: when a step declares an output contract but its agent
 * returned the result as a STRING (prose, or a fenced ```json block) instead of
 * a structured object, parse that string into the object so the contract can
 * bind to it. A step that emits the right JSON as text now satisfies the
 * contract, and downstream steps + forEach receive the real object (not a
 * string). Conservative + additive: only touches a STRING output when a
 * contract is declared; if nothing parses to an object/array the original is
 * returned and the verifier fails loudly exactly as before. Exported for tests.
 */
// coerceOutputForContract moved to step-output-verify.ts (one binding for BOTH gates);
// re-exported below so existing importers keep working.

/** Compact, safe description of an output's actual shape — for a contract
 *  failure message so we can see WHAT was produced vs what was required
 *  (e.g. "object with keys: reply, summary" when the contract wanted
 *  proposed_prospects). Never throws. */
export function describeOutputShape(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const t = value.trim();
    return `string (${t.length} chars)${t ? `: "${t.slice(0, 80)}${t.length > 80 ? '…' : ''}"` : ''}`;
  }
  if (Array.isArray(value)) return `array (${value.length} items)`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return `object with keys: ${keys.length ? keys.slice(0, 12).join(', ') : '(none)'}`;
  }
  return typeof value;
}

/**
 * Typed contract-violation error (goal-contract Phase 2) so the loopUntil
 * wrapper can recognize "the step ran but its output failed the contract"
 * without message-sniffing. Same message text as before — existing handling
 * (run error routing, findContractViolationStep via events) is unchanged.
 */
export class WorkflowContractViolationError extends Error {
  constructor(
    message: string,
    public readonly stepId: string,
    public readonly problems: string[],
    public readonly reason: 'output_contract' | 'empty_output',
  ) {
    super(message);
    this.name = 'WorkflowContractViolationError';
  }
}

// isBlockedStepOutput moved to step-output-verify.ts (one truth for both gates).
export { coerceOutputForContract } from './step-output-verify.js';

export function finalizeStepOutput(
  workflowSlug: string,
  runId: string,
  step: WorkflowStepInput,
  output: unknown,
  meta?: Record<string, unknown>,
): unknown {
  // Bind a JSON-text output to the declared contract shape BEFORE verifying, so
  // a step that emitted the right keys as text (not a structured object) passes
  // and downstream steps receive the real object. No contract → unchanged.
  const bound = step.output ? coerceOutputForContract(output, step.output) : output;
  // A step that legitimately BLOCKED (returns {blocked:true, reason}) is
  // signaling it couldn't produce its deliverable — surface that block + its
  // REASON via the success-path self-heal (detectBlockedSteps reports
  // "needs attention: <reason>") instead of MASKING it as a cryptic contract
  // failure ("missing required key X"). So skip contract verification for a
  // blocked output; it flows through as step_completed and the run reports the
  // real reason. (Live: add_to_airtable blocked "no prospects — Salesforce
  // expired" but the user saw "missing required output key created_records".)
  const isBlockedOutput = isBlockedStepOutput(bound);
  if (step.output && !isBlockedOutput) {
    const result = verifyStepOutput(step.output, bound);
    if (!result.ok) {
      const got = describeOutputShape(bound);
      // Wave 3 P1-9: an emptiness-only violation (non_empty / min_items) is a
      // DATA problem, not a definition bug — the upstream source returned
      // nothing. Give it a remediation-oriented message + a distinct meta
      // reason ('empty_output') so it surfaces as "produced no data" with a
      // likely cause, and is NOT routed to the Doctor (findContractViolationStep
      // matches only 'output_contract' — the Doctor can't fix "SF expired").
      // Both paths land on the error route, which sets needsAttention (Wave 1).
      // Classification extracted + fixed (2026-07-14): "is not an array" is a
      // SHAPE problem (Doctor-routable), not upstream emptiness — the old
      // filter told the user "the source returned nothing" over 197KB of real
      // data (live acme-facebook-trends misdiagnosis).
      const isEmptyOnly = classifyContractProblems(result.problems) === 'empty_output';
      const emptyProblems = result.problems.filter(
        (p) => p.startsWith('non_empty:') || p.startsWith('min_items:'),
      );
      // Include the ACTUAL produced shape so the failure is diagnosable (the
      // step ran but emitted the wrong shape — e.g. its decision object instead
      // of the contracted keys) instead of only "missing key X".
      const message = isEmptyOnly
        ? `Step "${step.id}" produced no usable data: ${emptyProblems.join('; ')}. This usually means the upstream source returned nothing — an empty result, an expired credential, or an over-strict filter. The run was halted instead of continuing with empty data; check the source, then re-run.`
        : `Step "${step.id}" output failed its contract: ${result.problems.join('; ')} — the step produced ${got}.`;
      appendWorkflowEvent(workflowSlug, runId, {
        kind: 'step_failed',
        stepId: step.id,
        error: message,
        meta: { reason: isEmptyOnly ? 'empty_output' : 'output_contract', problems: result.problems, got },
      });
      throw new WorkflowContractViolationError(
        message,
        step.id,
        result.problems,
        isEmptyOnly ? 'empty_output' : 'output_contract',
      );
    }
  }
  appendWorkflowEvent(workflowSlug, runId, {
    kind: 'step_completed',
    stepId: step.id,
    output: bound,
    // Tag a blocked-but-finalized step so telemetry emits workflow_node_blocked
    // instead of workflow_node_completed — a block is NOT a success (it was
    // counting as one, overstating reliability on the engine's central concept).
    ...(meta || isBlockedOutput ? { meta: { ...(meta ?? {}), ...(isBlockedOutput ? { blocked: true } : {}) } } : {}),
  });
  // Persist the step's work product to the shared run workspace so the manifest
  // is a complete, inspectable record of the run — what the live window shows
  // and a checker agent reads. Best-effort: never blocks a completed step.
  try {
    recordStepOutput({ workflowName: workflowSlug, runId, stepId: step.id, output: bound, nowIso: new Date().toISOString() });
  } catch { /* best-effort */ }
  return bound;
}

function collectStringLeaves(value: unknown, into: string[] = [], depth = 0): string[] {
  if (into.length >= 64 || depth > 6) return into;
  if (typeof value === 'string') {
    into.push(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, into, depth + 1);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStringLeaves(item, into, depth + 1);
  }
  return into;
}

function hasHttpUrl(value: unknown): boolean {
  const urls = new Set<string>();
  collectHttpUrls(value, urls, 0);
  return urls.size > 0;
}

function normalizePathCandidate(candidate: string): string {
  return candidate
    .trim()
    .replace(/^["'`([{<]+/, '')
    .replace(/["'`.,;:)\]}>]+$/, '');
}

function pathCandidateExists(candidate: string): boolean {
  const cleaned = normalizePathCandidate(candidate);
  if (!cleaned || /^https?:\/\//i.test(cleaned)) return false;
  const candidates = path.isAbsolute(cleaned)
    ? [cleaned]
    : [cleaned, path.resolve(process.cwd(), cleaned)];
  return candidates.some((p) => existsSync(p));
}

function hasExistingPath(value: unknown): boolean {
  const pathLike =
    /(?:\.{1,2}\/|\/|[A-Za-z0-9_.-]+\/)[^\s"'<>]+|[A-Za-z0-9_.-]+\.(?:html?|md|pdf|csv|tsx?|jsx?|json|txt|docx?|xlsx?|pptx?|png|jpe?g|webp|gif|zip)/gi;
  for (const text of collectStringLeaves(value)) {
    if (pathCandidateExists(text)) return true;
    for (const match of text.matchAll(pathLike)) {
      if (pathCandidateExists(match[0])) return true;
    }
  }
  return false;
}

function hasNonEmptyArrayDeep(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => hasNonEmptyArrayDeep(item, depth + 1));
  }
  return false;
}

function hasTextList(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  if (/^\s*(?:[-*]|\d+[.)])\s+\S+/m.test(text)) return true;
  if (/^\s*\|.+\|\s*$/m.test(text)) return true;
  return false;
}

function hasNonEmptyListEvidence(value: unknown): boolean {
  return hasNonEmptyArrayDeep(value) || collectStringLeaves(value).some(hasTextList);
}

/**
 * Legacy deliverable guard: workflows authored before explicit `output`
 * contracts can still promise "produce a URL/file/list" in prose. Infer that
 * concrete shape and surface a needs-attention advisory when the completed step
 * output has no matching evidence. This is intentionally softer than declared
 * contracts: it accepts legacy prose that contains a real URL, existing file
 * path, or text list instead of requiring an object shape the prompt never saw.
 */
export function inferredOutputContractAdvisory(step: WorkflowStepInput, output: unknown): string | null {
  if (step.output || step.deterministic || step.forEach) return null;
  const contract = inferOutputContractFromPrompt(step.prompt ?? '');
  if (!contract) return null;
  const bound = coerceOutputForContract(output, contract);
  if (isBlockedStepOutput(bound)) return null;
  if (verifyStepOutput(contract, bound).ok) return null;

  const problems: string[] = [];
  const expectedUrl = (contract.verify?.url_present?.length ?? 0) > 0 || (contract.required_keys ?? []).includes('url');
  const expectedPath = (contract.verify?.path_exists?.length ?? 0) > 0 || (contract.required_keys ?? []).includes('path');
  const expectedItems =
    Object.keys(contract.min_items ?? {}).length > 0 ||
    (contract.non_empty ?? []).includes('items') ||
    (contract.required_keys ?? []).includes('items');
  const expectedResult = (contract.required_keys ?? []).includes('result');

  if (expectedUrl && !hasHttpUrl(bound)) {
    problems.push('expected a URL deliverable, but no http(s) URL was found');
  }
  if (expectedPath && !hasExistingPath(bound)) {
    problems.push('expected a file deliverable, but no existing file path was found');
  }
  if (expectedItems && !hasNonEmptyListEvidence(bound)) {
    problems.push('expected a non-empty list/rows deliverable, but no non-empty list was found');
  }
  if (expectedResult && isEmptyValue(bound)) {
    problems.push('expected a non-empty deliverable result, but output was empty');
  }
  if (problems.length === 0) return null;

  return `step "${step.id}" looked like it should produce a concrete deliverable, but output did not satisfy inferred checks: ${problems.join('; ')} — produced ${describeOutputShape(bound)}. Add an explicit output contract to make this hard-enforced, or adjust the step/output.`;
}

function noteInferredOutputContractAdvisory(
  step: WorkflowStepInput,
  output: unknown,
  ctx: StepExecutionContext,
): void {
  const note = inferredOutputContractAdvisory(step, output);
  if (!note) return;
  ctx.qualityAdvisories.push({
    stepId: step.id,
    kind: 'inferred_output_contract',
    note,
  });
  appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
    kind: 'step_advisory',
    stepId: step.id,
    meta: { reason: 'inferred_output_contract', note },
  });
}

/**
 * Find the step that FAILED its declared output contract from a run's events
 * (most recent first). Contract violations THROW (vs the {blocked:true}
 * channel), so they land in the run's error path and never reach the
 * success-with-blocked diagnosis. The error path uses this to route the
 * violation into the Doctor for an approval-gated fix. Pure + exported for tests.
 */
export function findContractViolationStep(
  events: WorkflowEvent[],
): { stepId: string; problems: string[] } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== 'step_failed') continue;
    const meta = (e as { meta?: { reason?: unknown; problems?: unknown } }).meta;
    if (!meta || meta.reason !== 'output_contract') continue;
    const stepId = typeof e.stepId === 'string' ? e.stepId : undefined;
    if (!stepId) continue;
    const problems = Array.isArray(meta.problems)
      ? meta.problems.filter((p): p is string => typeof p === 'string')
      : [];
    return { stepId, problems };
  }
  return null;
}

/** T3.1: apply clean-run contract tightenings — additive-only, validated,
 *  backed up. CONSERVATIVE: only requires shape that has been INVARIANT across
 *  ≥3 clean runs (see workflow-contract-evidence-store), so a tightening can
 *  never fail a run that looks like the runs it learned from. Exported for
 *  tests. Returns applied step ids. */
export function tightenWorkflowContractsFromCleanRun(
  workflowSlug: string,
  def: WorkflowDefinition,
  stepOutputs: Record<string, unknown>,
  runId: string,
): string[] {
  const tightenings = recordAndDeriveStableTightenings(workflowSlug, def, stepOutputs, new Date().toISOString());
  if (tightenings.length === 0) return [];
  const current = readWorkflow(workflowSlug)?.data ?? def;
  const originalSteps = new Map(def.steps.map((step) => [step.id, step]));
  const currentSteps = new Map(current.steps.map((step) => [step.id, step]));
  const applicable = tightenings.filter((tightening) => {
    const original = originalSteps.get(tightening.stepId);
    const latest = currentSteps.get(tightening.stepId);
    if (!original || !latest) return false;
    if (latest.output && Object.keys(latest.output).length > 0) return false;
    if ((latest.prompt ?? '') !== (original.prompt ?? '')) return false;
    if ((latest.forEach ?? '') !== (original.forEach ?? '')) return false;
    return true;
  });
  if (applicable.length === 0) return [];
  const tightened: WorkflowDefinition = {
    ...current,
    steps: current.steps.map((s) => {
      const t = applicable.find((x) => x.stepId === s.id);
      return t ? { ...s, output: t.output } : s;
    }),
  };
  const check = checkWorkflowForWrite(tightened);
  if (!check.ok) {
    logger.warn({ workflow: workflowSlug, errors: check.errors.slice(0, 3) }, 'clean-run contract tightening did not validate — skipped');
    return [];
  }
  const backup = recordWorkflowEditBackup(
    workflowSlug,
    applicable[0].stepId,
    current,
    `clean-run contract tightening (run ${runId}): ${applicable.map((t) => `${t.stepId} ← ${t.evidence}`).join('; ')}`,
  );
  writeWorkflowAndSyncTriggers(workflowSlug, tightened);
  for (const t of applicable) {
    appendWorkflowEvent(workflowSlug, runId, {
      kind: 'step_advisory',
      stepId: t.stepId,
      meta: { reason: 'contract_tightened', evidence: t.evidence, backupId: backup?.id },
    });
  }
  logger.info(
    { workflow: workflowSlug, steps: applicable.map((t) => t.stepId), backupId: backup?.id },
    'clean run tightened output contracts (revert with `revert heal <id>` if it proves wrong)',
  );
  return applicable.map((t) => t.stepId);
}

export async function executeStep(
  step: WorkflowStepInput,
  ctx: StepExecutionContext,
): Promise<unknown> {
  // 0. Opt-in approval gate (autonomous-by-default model). When a step
  //    declares requiresApproval, the RUNNER surfaces ONE batch approval
  //    and holds the run here until the user resolves it — then the rest
  //    of the workflow proceeds autonomously. Declarative + runner-owned,
  //    so the constrained step agent never needs request_approval and a
  //    workflow pauses at most where it explicitly opts in.
  if (shouldUseDeclarativeStepApproval(ctx.workflow, step)) {
    await awaitDeclarativeStepApproval(ctx, step);
  }

  // 1. Deterministic helper — skip the LLM entirely and run a bundled
  //    script from this workflow's scripts/ directory. The runner
  //    receives structured JSON on stdin and emits stdout that is
  //    parsed as JSON when possible.
  if (step.deterministic?.runner) {
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_started',
      stepId: step.id,
      meta: { mode: 'deterministic', runner: step.deterministic.runner },
    });
    let detOutput: unknown;
    try {
      detOutput = await runDeterministicWorkflowStep(step.deterministic.runner, {
        workflow: ctx.workflow.name,
        workflowSlug: ctx.workflowSlug,
        runId: ctx.runId,
        stepId: step.id,
        inputs: ctx.inputs,
        stepOutputs: ctx.stepOutputs,
        project: resolveWorkflowStepProjectContext(step, ctx.workflow),
      });
    } catch (err) {
      appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
        kind: 'step_failed',
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
        meta: { mode: 'deterministic', runner: step.deterministic.runner },
      });
      throw err;
    }
    // Route through the SAME verification chokepoint as forEach/plain/synthesis
    // so a deterministic step's declared output contract is enforced BEFORE
    // step_completed is recorded — never silently bypassed. (finalizeStepOutput
    // emits step_failed + throws on a contract violation; the throw is a
    // deterministic error so the retry wrapper above won't re-run it.)
    return finalizeStepOutput(ctx.workflowSlug, ctx.runId, step, detOutput, {
      mode: 'deterministic',
      runner: step.deterministic.runner,
    });
  }

  // 1b. CALL-1 — structured tool call: execute the tool DIRECTLY, no LLM. The
  //     args are fixed in the contract (templated from inputs/upstream), so the
  //     call is deterministic and free. Routes through the SAME verification
  //     chokepoint as every other shape. The forEach branch below handles
  //     read-class call fan-out; validation still rejects call+deterministic and
  //     send/write-class call fan-out.
  if (step.call?.tool && !step.forEach) {
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_started',
      stepId: step.id,
      meta: { mode: 'call', tool: step.call.tool },
    });
    let callOutput: unknown;
    try {
      callOutput = await executeWorkflowCallNode(step, ctx);
    } catch (err) {
      appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
        kind: 'step_failed',
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
        meta: { mode: 'call', tool: step.call.tool },
      });
      throw err;
    }
    return finalizeStepOutput(ctx.workflowSlug, ctx.runId, step, callOutput, {
      mode: 'call',
      tool: step.call.tool,
    });
  }

  // 2. forEach — iterate an upstream output with bounded concurrency.
  if (step.forEach) {
    const forEachSource = resolveForEachSource(step.forEach, ctx.stepOutputs);
    const upstream = forEachSource.value;
    let items = coerceToArray(upstream);
    // Creation-test: fan out over only the first item (just confirm the per-item
    // work returns data; don't run the whole batch while authoring).
    if (items && ctx.creationTest && items.length > 1) items = items.slice(0, 1);
    if (!items || items.length === 0) {
      appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
        kind: 'step_skipped',
        stepId: step.id,
        output: [],
        meta: { reason: 'forEach-empty', source: step.forEach, sourceStepId: forEachSource.sourceId ?? undefined },
      });
      return [];
    }

    let keyedItems = items.map((item, index) => ({ item, index, key: itemKey(item, index) }));
    // T2.2 (cross-run watermark): forEachNewOnly skips items ANY prior run of
    // this workflow already completed — engine-level "only the new ones",
    // instead of an LLM prompt deciding what's new. The watermark advances
    // only on item COMPLETION (below), so failed items retry next run.
    let watermarkSkipped = 0;
    if (step.forEachNewOnly && !ctx.creationTest) {
      const seen = readSeenItemKeys(ctx.workflowSlug, step.id);
      if (seen.size > 0) {
        const fresh = keyedItems.filter((it) => !seen.has(it.key));
        watermarkSkipped = keyedItems.length - fresh.length;
        keyedItems = fresh;
      }
      if (keyedItems.length === 0) {
        appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
          kind: 'step_skipped',
          stepId: step.id,
          output: [],
          meta: { reason: 'forEach-no-new-items', source: step.forEach, seenSkipped: watermarkSkipped },
        });
        return [];
      }
    }
    const alreadyCompleted = keyedItems.filter((it) => ctx.completedItems.has(it.key));
    const pendingItems = keyedItems.filter((it) => !ctx.completedItems.has(it.key));

    // Anti-choke without a hard ceiling: process unbounded fan-out in windows
    // so progress stays visible and resume still skips completed items, but do
    // NOT declare the workflow "done" until every pending item was attempted.
    // Creation-test already sliced to 1 above, so this only shapes real runs
    // over a huge upstream.
    const maxItems = forEachMaxItems();
    if (pendingItems.length > maxItems) {
      appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
        kind: 'step_advisory',
        stepId: step.id,
        meta: {
          reason: 'foreach_batched',
          total: items.length,
          alreadyCompleted: alreadyCompleted.length,
          pending: pendingItems.length,
          batchSize: maxItems,
          batches: Math.ceil(pendingItems.length / maxItems),
          source: step.forEach,
        },
      });
    }

    const activeCount = alreadyCompleted.length + pendingItems.length;
    // Generic sends have no safe wildcard grant: serialize them so exactly ONE
    // concrete payload card is surfaced before the run parks. On each resume the
    // approved item completes, then the next exact payload may ask separately.
    const serializeConcreteSendApprovals = stepSideEffectClass(step) === 'send'
      && exactApprovedSendTools(ctx.workflow, step).length === 0;
    const concurrency = serializeConcreteSendApprovals
      ? 1
      : Math.max(1, Math.min(RUNNER_CONCURRENCY, Math.min(maxItems, pendingItems.length || 1)));
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_started',
      stepId: step.id,
      meta: {
        mode: 'forEach',
        source: step.forEach,
        count: activeCount,
        pending: pendingItems.length,
        alreadyCompleted: alreadyCompleted.length,
        concurrency,
        batchSize: maxItems,
        batches: Math.max(1, Math.ceil(pendingItems.length / maxItems)),
      },
    });
    // Heartbeat item progress: pre-completed (resumed) items count as done
    // from the start, then each finishing item bumps the live counter.
    setWorkflowRunItemProgress(ctx.runId, step.id, {
      completed: alreadyCompleted.length,
      failed: 0,
      total: activeCount,
    });

    interface ItemResult { itemKey: string; output: unknown; index: number }
    type SettledItemResult =
      | { ok: true; value: ItemResult }
      | { ok: false; error: string; itemKey: string; index: number };
    const runPendingWindow = async (windowItems: typeof pendingItems): Promise<SettledItemResult[]> => {
      const settled = await runWithConcurrency<typeof pendingItems[number], ItemResult>(
        windowItems,
        Math.max(1, Math.min(concurrency, windowItems.length || 1)),
        async (work) => {
          const { item, index: idx, key } = work;
          // Resume: skip items we already completed in a prior run pass.
          if (ctx.completedItems.has(key)) {
            return { itemKey: key, output: ctx.completedItems.get(key), index: idx };
          }
          // Bug #8 (Lane B): a mutating item whose external write already fired on a prior
          // pass (external_write under the item's deterministic session) but never
          // recorded completion (the crash window) must NOT be re-sent — re-running
          // would DOUBLE-SEND. Skip + reconcile + advise (favor no-duplicate, report
          // back). Only bites on resume: a fresh pass has no prior external_write.
          if (stepSideEffectClass(step) !== 'read'
            && itemSendAlreadyFired(ctx.runId, step.id, key)) {
            const skipNote = '[skipped on resume — a prior external mutation for this item already fired; not repeated to avoid a duplicate. Verify it landed.]';
            appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
              kind: 'item_completed',
              stepId: step.id,
              itemKey: key,
              output: skipNote,
            });
            bumpWorkflowRunItemProgress(ctx.runId, step.id, 'completed');
            ctx.qualityAdvisories.push({
              stepId: step.id,
              itemKey: key,
              kind: 'idempotent_skip',
              note: `forEach item "${key}" mutated externally on a prior attempt but the run crashed before recording completion — SKIPPED on resume to avoid a duplicate. Verify that mutation landed.`,
            });
            return { itemKey: key, output: skipNote, index: idx };
          }
          appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
            kind: 'item_started',
            stepId: step.id,
            itemKey: key,
          });
          try {
            // Bind this item's declared inputs + fast-fail on missing (no-op
            // when the step declares no `inputs`). `item` is in scope here.
            const itemContext = bindStepContext(step, ctx, item);
            const itemIntent = renderTemplate(step.prompt, ctx.inputs, ctx.stepOutputs, item, resolveWorkflowStepProjectContext(step, ctx.workflow));
            const prompt = applyWorkflowOriginLineage(
              ctx,
              applyWorkflowPatternHint(
                ctx,
                applyWatcherSteerToPrompt(ctx, applyGoalFeedbackToPrompt(ctx, applyContractToPrompt(step, applySkillToPrompt(step, itemIntent)))),
              ),
            );
            let output: unknown;
            let itemSessionId = `workflow:${ctx.runId}:${step.id}:${key}`;
            let itemLane: HarnessStepResult['lane'];
            let itemRoute: AssistantRouteDiagnostics | undefined;
            // W1b — run the item, retrying a TRANSIENT failure for THIS item only
            // (read items freely; write/send items NEVER re-run once they recorded
            // an external_write — the same double-act guard as crash-resume). Budget
            // 0 unless the flag is on → byte-identical to today by default.
            const runItemOnce = async (): Promise<void> => {
              // CALL-2b: a structured per-item call executes the tool DIRECTLY
              // with {{item}} templated into args — zero LLM per item. Validation
              // restricts this to read-class calls (idempotent → safe to retry/
              // resume), so no external-write double-act guard is needed here.
              if (step.call?.tool) {
                output = await executeWorkflowCallNode(step, ctx, item, key);
                // no lane: a direct call has no LLM output to ground (the
                // claude_sdk grounding advisory below is correctly skipped).
                return;
              }
              if (workflowHarnessEnabled(step)) {
                const r = await runStepViaHarness(
                  step,
                  `${ctx.runId}:${step.id}:${key}`,
                  `Item: ${key}\n\n${prompt}`,
                  ctx.workflow.name,
                  workflowAutoApprovalTools(ctx.workflow, step),
                  ctx.runId,
                  itemContext,
                  true, // approval parks propagate through runWithConcurrency
                  true, // isItemInvocation: never gate an item on the AGGREGATE contract
                );
                output = r.output;
                itemSessionId = r.sessionId;
                itemLane = r.lane;
                itemRoute = r.route;
              } else {
                // FORK collapse (staged): forEach item through the gated harness loop
                // (default-OFF `workflow` surface → byte-identical to legacy until
                // CLEMMY_HARNESS_WORKFLOW=on + a real workflow run validates chaining).
                const response = await respondPreferHarness('workflow', {
                  sessionId: `workflow:${ctx.runId}:${step.id}:${key}`,
                  channel: 'workflow',
                  runId: `workflow-step:${ctx.runId}:${step.id}:${key}`,
                  shouldCancel: () => isWorkflowRunCancelled(ctx.runId),
                  maxRunTokens: 0, // Stage 4: workflow budget = run-level advisory only
                  message: `Workflow: ${ctx.workflow.name}\nStep: ${step.id}\nItem: ${key}\n\n${prompt}`,
                  // ONE model resolution for every run/lane: explicit step.model →
                  // intent-routed worker → codex-safe brain. Resolving here (not raw
                  // getWorkerModel()) keeps this legacy lane identical to the harness
                  // lane so a single brain setting governs all runs. {} (untagged) →
                  // the codex-safe brain default.
                  model: resolveWorkflowStepModel(step).model ?? defaultForRole('brain'),
                  maxWallClockMs: WORKFLOW_STEP_WALL_CLOCK_MS,
                }, (r) => ctx.assistant.respond(r));
                output = response.text;
                itemRoute = routeDiagnosticsFromResponse(response);
              }
            };
            // W1b — per-item transient retry for forEach (same `transientRetryFloor`
            // budget as plain steps), guarded so an item that already recorded an
            // external_write is NEVER re-run (crash-resume idempotency check).
            await runWithStepRetry(runItemOnce, {
              budget: transientRetryFloor(),
              backoffBaseMs: RETRY_BACKOFF_BASE_MS,
              isRetryable: (err) =>
                !(err instanceof ParkRunSignal)
                && !(err instanceof WorkflowRunCancelledError)
                && (isTransientStepError(err) || isWorkflowStepStructuralResultError(err))
                // double-act guard: never re-run an item that already wrote externally.
                && !itemSendAlreadyFired(ctx.runId, step.id, key),
              onRetry: ({ attempt, budget, delayMs, err }) => {
                appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
                  kind: 'item_retry',
                  stepId: step.id,
                  itemKey: key,
                  error: err instanceof Error ? err.message : String(err),
                  meta: { attempt, budget, delayMs, reason: isWorkflowStepStructuralResultError(err) ? 'structural_result' : 'transient' },
                });
              },
              afterBackoff: () => throwIfWorkflowRunCancelled(ctx.runId),
            });
            // Per-item skill-execution check (forEach): advisory, DETECTION-ONLY —
            // a `usesSkill` item that couldn't be confirmed to produce the skill's
            // deliverables records a non-failing quality advisory. The item still
            // completes + contributes its output; it never becomes an item failure
            // on a judge verdict (a confident-but-wrong judge can't drop a good
            // item). The terminal run may still be marked needsAttention so the
            // advisory is not counted as clean success. Fail-open; no-op for items
            // without usesSkill. DEFERRED (ctx.pendingAdvisories): a verdict that
            // can't change this item's output must not add judge latency to the
            // item's critical path — the run joins all advisories once at the end.
            await deferAdvisory(ctx, noteStepSkillAdvisory(step, itemSessionId, output, itemIntent, ctx, key));
            // Move 3: the Claude SDK lane's pure-text output skips runConversation's
            // content grounding — verify its figures per item (detection-only).
            if (itemLane === 'claude_sdk') await deferAdvisory(ctx, noteStepOutputGroundingAdvisory(step, itemSessionId, output, ctx, key));
            appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
              kind: 'item_completed',
              stepId: step.id,
              itemKey: key,
              output,
              meta: { modelRoute: workflowModelRouteMeta(itemRoute) },
            });
            bumpWorkflowRunItemProgress(ctx.runId, step.id, 'completed');
            return { itemKey: key, output, index: idx };
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
              kind: 'item_failed',
              stepId: step.id,
              itemKey: key,
              error,
            });
            bumpWorkflowRunItemProgress(ctx.runId, step.id, 'failed');
            throw err;
          }
        },
      );
      const parkedSteps = settled.flatMap((result) =>
        result && !result.ok && result.reason instanceof ParkRunSignal
          ? result.reason.parkedSteps
          : []);
      if (parkedSteps.length > 0) throw new ParkRunSignal(parkedSteps);
      return settled.map((r, localIndex) => {
        if (r.ok) return r;
        const item = windowItems[localIndex];
        return {
          ok: false,
          error: r.error,
          itemKey: item?.key ?? `idx-${localIndex}`,
          index: item?.index ?? localIndex,
        };
      });
    };
    const itemResults: SettledItemResult[] = [];
    for (let offset = 0; offset < pendingItems.length; offset += maxItems) {
      const windowItems = pendingItems.slice(offset, offset + maxItems);
      if (windowItems.length === 0) continue;
      const windowResults = await runPendingWindow(windowItems);
      itemResults.push(...windowResults);
      // T2.2: advance the cross-run watermark per WINDOW (not at step end) so a
      // crash mid-fan-out doesn't lose earlier windows' completions. Only
      // completed items advance — failures retry on the next run.
      if (step.forEachNewOnly && !ctx.creationTest) {
        const completedKeys = windowResults
          .filter((r): r is { ok: true; value: ItemResult } => r.ok)
          .map((r) => r.value.itemKey);
        try { markItemsSeen(ctx.workflowSlug, step.id, completedKeys); } catch (err) {
          logger.warn({ stepId: step.id, err: err instanceof Error ? err.message : String(err) }, 'forEach watermark write failed (items will be re-seen next run)');
        }
      }
    }
    // Resumed items completed in a prior pass of THIS run — make sure they are
    // in the watermark too (idempotent; covers a crash between completion and
    // the original mark).
    if (step.forEachNewOnly && !ctx.creationTest && alreadyCompleted.length > 0) {
      try { markItemsSeen(ctx.workflowSlug, step.id, alreadyCompleted.map((it) => it.key)); } catch { /* best-effort */ }
    }

    const successes = itemResults.filter((r): r is { ok: true; value: ItemResult } => r.ok);
    const failed = itemResults.length - successes.length;
    const aggregate = [
      ...alreadyCompleted.map((it) => ({ itemKey: it.key, output: ctx.completedItems.get(it.key), index: it.index })),
      ...successes.map((r) => r.value),
    ]
      .sort((a, b) => a.index - b.index)
      .map(({ index: _index, ...rest }) => rest);
    // Record failures on the shared accumulator so the outer run
    // notification can flag partial-success runs that previously read
    // as "completed" with no hint that items dropped.
    for (let i = 0; i < itemResults.length; i++) {
      const r = itemResults[i];
      if (r.ok) continue;
      ctx.forEachFailures.push({ stepId: step.id, itemKey: r.itemKey, error: r.error });
    }
    clearWorkflowRunItemProgress(ctx.runId, step.id);
    // Stage 3 (reduce tier): shard-reduce a LARGE aggregate into a durable
    // digest artifact so the synthesis brain reads compressed content instead
    // of a content-free ref. Additive only — the step output passed downstream
    // is the full aggregate, unchanged. Best-effort: never fails the step.
    await maybeReduceForEachAggregate(ctx, step.id, aggregate);
    return finalizeStepOutput(ctx.workflowSlug, ctx.runId, step, aggregate, {
      mode: 'forEach',
      completed: aggregate.length,
      processed: successes.length,
      resumed: alreadyCompleted.length,
      failed,
    });
  }

  // 3. Plain LLM step. Two paths:
  //   - HARNESS path (T-WF-1/2): use runConversation, wait for any
  //     pending approvals, surface a Discord notification with the
  //     apr-xxxx code. Real tool outputs flow into stepOutputs.
  //   - LEGACY path: original assistant.respond — preserved for
  //     workflows authored before the harness existed.
  // Bind declared inputs + fast-fail on a missing required input (no-op
  // when the step declares no `inputs`).
  const stepContext = bindStepContext(step, ctx);
  appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
    kind: 'step_started',
    stepId: step.id,
  });
  const prompt = applyWatcherSteerToPrompt(
    ctx,
    applyGoalFeedbackToPrompt(
      ctx,
      applyContractToPrompt(step, applySkillToPrompt(step, renderTemplate(step.prompt, ctx.inputs, ctx.stepOutputs, undefined, resolveWorkflowStepProjectContext(step, ctx.workflow)))),
    ),
  );
  const promptedWithPatterns = applyWorkflowOriginLineage(ctx, applyWorkflowPatternHint(ctx, prompt));
  let output: unknown;
  let stepSessionId = `workflow:${ctx.runId}:${step.id}`;
  let stepRoute: AssistantRouteDiagnostics | undefined;
  if (workflowHarnessEnabled(step)) {
    try {
      const result = await runStepViaHarness(
        step,
        `${ctx.runId}:${step.id}`,
        promptedWithPatterns,
        ctx.workflow.name,
        workflowAutoApprovalTools(ctx.workflow, step),
        ctx.runId,
        stepContext,
        true, // canPark: plain step unwinds cleanly to processOneRunFile
      );
      output = result.output;
      stepSessionId = result.sessionId;
      stepRoute = result.route;
      if (result.hadApprovals) {
        logger.info(
          { stepId: step.id, approvalIds: result.approvalIds, count: result.approvalIds.length },
          'workflow step paused on approvals and resumed',
        );
      }
    } catch (err) {
      // B (v2.3.0): a park is logged as step_failed BY CONTRACT (the reaper's
      // re-admission path depends on the durable event kind — "a logged
      // failure means 'parked', not 'crashed'"). Tag WHY so the UI can render
      // it as "waiting for your approval" instead of a red FAILED row.
      appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
        kind: 'step_failed',
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof ParkRunSignal ? { meta: { reason: 'parked_on_approval' } } : {}),
      });
      throw err;
    }
  } else {
    // FORK collapse (staged): plain step through the gated harness loop
    // (default-OFF `workflow` surface → byte-identical to legacy until
    // CLEMMY_HARNESS_WORKFLOW=on + a real workflow run validates chaining).
    const response = await respondPreferHarness('workflow', {
      sessionId: `workflow:${ctx.runId}:${step.id}`,
      channel: 'workflow',
      runId: `workflow-step:${ctx.runId}:${step.id}`,
      shouldCancel: () => isWorkflowRunCancelled(ctx.runId),
      maxRunTokens: 0, // Stage 4: workflow budget = run-level advisory only
      message: `Workflow: ${ctx.workflow.name}\nStep: ${step.id}\n\n${promptedWithPatterns}`,
      // ONE model resolution for every run/lane: explicit step.model →
      // intent-routed worker → codex-safe brain. Resolving here (not raw
      // MODELS.primary) keeps this legacy lane identical to the harness lane so a
      // single brain setting governs all runs (and never silently runs on a BYO
      // id that leaked into the OPENAI_MODEL_* slot). {} (untagged) → the
      // codex-safe brain default.
      model: resolveWorkflowStepModel(step).model ?? defaultForRole('brain'),
      maxWallClockMs: WORKFLOW_STEP_WALL_CLOCK_MS,
    }, (r) => ctx.assistant.respond(r));
    output = response.text;
    stepRoute = routeDiagnosticsFromResponse(response);
  }

  // Skill-execution check (advisory, DETECTION-ONLY). Engages ONLY for
  // `usesSkill` steps; fail-open. A confident miss records a non-failing
  // quality advisory that rides along with the delivered output. It never
  // fails the step or hides the deliverable; terminal accounting may still mark
  // the run needsAttention so the miss is not treated as clean success.
  await deferAdvisory(ctx, noteStepSkillAdvisory(step, stepSessionId, output, renderTemplate(step.prompt, ctx.inputs, ctx.stepOutputs, undefined, resolveWorkflowStepProjectContext(step, ctx.workflow)), ctx));

  // DETERMINISTIC skill-execution FLOOR (hard). The advisory above is detection-
  // only; this HARD-fails a `usesSkill` step whose skill ships a RENDERER that
  // never ran — the deliverable was hand-rolled (the 2026-06-15 lunar workflow ran
  // the VALIDATOR on a hand-rolled file but never generate-html.js, and the
  // advisory judge waved it through). Closes the escape hatch where a chat-gate
  // bounce pushed the model to dispatch a background workflow with no enforcement.
  // Kill-switch HARNESS_SKILL_EXEC_GATE=off; fail-open (loader/detection error → no gate).
  if ((process.env.HARNESS_SKILL_EXEC_GATE ?? 'on').toLowerCase() !== 'off' && step.usesSkill?.trim()) {
    let skillGap: { skill: string; prescribed: string[] } | null = null;
    try {
      const skill = loadSkill(step.usesSkill.trim());
      skillGap = skill?.body ? skillBodyExecutionShortfall(step.usesSkill.trim(), skill.body, stepSessionId, skill.dir) : null;
    } catch { skillGap = null; }
    if (skillGap) {
      throw new Error(
        `Step "${step.id}" did not execute the "${skillGap.skill}" skill: its renderer (${skillGap.prescribed.join(', ')}) never ran — the deliverable was hand-rolled, not produced by the skill's own pipeline. Run the skill's render + validate scripts, then finish.`,
      );
    }
  }

  const finalized = finalizeStepOutput(ctx.workflowSlug, ctx.runId, step, output, {
    modelRoute: workflowModelRouteMeta(stepRoute),
  });
  noteInferredOutputContractAdvisory(step, finalized, ctx);
  return finalized;
}

/**
 * Run the per-step skill-execution judge and, on a confident miss, record a
 * NON-FAILING quality advisory (the step still completed + delivered its
 * output). DETECTION-ONLY: it never throws / never fails the step or hides the
 * deliverable — a confident-but-wrong judge can therefore never break a
 * workflow that actually succeeded. The final run can still be marked
 * needsAttention so the advisory is reviewed. No-op for steps without
 * `usesSkill`, and wholly fail-open (any error is swallowed). `itemKey` set for
 * forEach items.
 */
/** Test seam for the workflow watcher (same pattern as _setBatchSleepForTests):
 *  replaces the trajectory-check call so tests exercise steer injection and
 *  silence deterministically without a live judge. */
let workflowWatcherOverride: WatcherJudgeFn | null = null;
export function _setWorkflowWatcherForTests(fn: WatcherJudgeFn | null): void {
  workflowWatcherOverride = fn;
}

/** Compact trajectory digest for the workflow watcher: completed step outputs
 *  (clipped) + which steps REMAIN — the remaining list is load-bearing, it is
 *  what lets the watcher treat mid-run incompleteness as expected, not drift. */
export function renderWatcherWorkflowDigest(
  steps: Array<{ id?: string }>,
  stepOutputs: Record<string, unknown>,
): { summary: string; latest: string } {
  const clip = (v: unknown): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
    return (s ?? '').replace(/\s+/g, ' ').slice(0, 220);
  };
  const completed = steps.filter((s) => s.id && stepOutputs[s.id] !== undefined);
  const remaining = steps.filter((s) => s.id && stepOutputs[s.id] === undefined).map((s) => s.id);
  const lines = completed.map((s) => `step "${s.id}": ${clip(stepOutputs[s.id as string])}`);
  const summary = [
    `${completed.length} of ${steps.length} steps completed.`,
    ...lines,
    remaining.length ? `Steps still to run (NOT drift — they have not executed yet): ${remaining.join(', ')}` : 'All steps completed.',
  ].join('\n');
  const last = completed[completed.length - 1];
  const latest = last?.id ? `completed step "${last.id}": ${clip(stepOutputs[last.id])}` : '(no steps completed yet)';
  return { summary, latest };
}

/** Defer a detection-only advisory judge off the step/item critical path.
 *  With ctx.pendingAdvisories present the promise is parked (joined once by
 *  executeWorkflow before advisories are read); without it, awaited inline —
 *  byte-identical to the old behavior for ctx creations that don't opt in. */
async function deferAdvisory(ctx: StepExecutionContext, work: Promise<void>): Promise<void> {
  const safe = work.catch(() => { /* advisories are best-effort by contract */ });
  if (ctx.pendingAdvisories) {
    ctx.pendingAdvisories.push(safe);
    return;
  }
  await safe;
}

async function noteStepSkillAdvisory(
  step: WorkflowStepInput,
  sessionId: string,
  output: unknown,
  stepIntent: string,
  ctx: StepExecutionContext,
  itemKey?: string,
): Promise<void> {
  if (!step.usesSkill?.trim()) return;
  try {
    const verdict = await judgeStepSkillExecution({ step, sessionId, output, stepIntent });
    if (verdict.judged && !verdict.executed) {
      ctx.qualityAdvisories.push({
        stepId: step.id,
        itemKey,
        kind: 'skill_not_executed',
        note: `step "${step.id}"${itemKey ? ` · item ${itemKey}` : ''} used skill "${step.usesSkill}" — couldn't confirm it produced the skill's deliverables: ${verdict.reason}`,
      });
      appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
        kind: 'step_advisory',
        stepId: step.id,
        meta: { reason: 'skill_not_executed', skill: step.usesSkill, note: verdict.reason, itemKey },
      });
    }
  } catch {
    /* advisory is best-effort — a judge hiccup must never affect the step */
  }
}

/**
 * Move 3 — per-item CONTENT grounding for the Claude SDK fan-out lane. That lane's
 * pure-text synthesis output (no external write → no brackets-boundary numeric
 * gate) is the one place a FABRICATED figure can feed the aggregate of a
 * 100-subagent run. Run the SAME numeric-grounding the write boundary uses, but
 * DETECTION-ONLY (deferCommit → never bounces/escalates) + fail-open: the item
 * still completes; a contradicted figure only records a needsAttention advisory so
 * "plausible fluff" is visible instead of trusted. No-op unless the output is text
 * and the global grounding gate is on. Only called for lane==='claude_sdk'.
 */
async function noteStepOutputGroundingAdvisory(
  step: WorkflowStepInput,
  sessionId: string,
  output: unknown,
  ctx: StepExecutionContext,
  itemKey?: string,
): Promise<void> {
  if (!isOutputGroundingGateEnabled()) return;
  const text = typeof output === 'string' ? output : '';
  if (text.trim().length < 8) return; // structured outputs are gated at the write boundary
  try {
    const verdict = await evaluateOutputGrounding(sessionId, text, { kind: 'write', deferCommit: true });
    if (verdict.action === 'bounce') {
      const figs = verdict.figures.slice(0, 4).join(', ') || 'a figure';
      ctx.qualityAdvisories.push({
        stepId: step.id,
        itemKey,
        kind: 'ungrounded_output',
        note: `step "${step.id}"${itemKey ? ` · item ${itemKey}` : ''} (Claude lane): ${figs} in the output contradicts this item's own captured tool results — ${verdict.reason}`,
      });
      appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
        kind: 'step_advisory',
        stepId: step.id,
        meta: { reason: 'ungrounded_output', note: verdict.reason, figures: verdict.figures.slice(0, 8), itemKey },
      });
    }
  } catch {
    /* advisory is best-effort — a grounding hiccup must never affect the step */
  }
}

export function planWorkflowExecutionBatches(
  steps: WorkflowStepInput[],
  completedStepIds: Set<string> = new Set(),
): WorkflowStepInput[][] {
  const stepIds = new Set(steps.map((step) => step.id));
  const pending = new Map(steps
    .filter((step) => !completedStepIds.has(step.id))
    .map((step) => [step.id, step]));
  const batches: WorkflowStepInput[][] = [];
  const completed = new Set(completedStepIds);

  while (pending.size > 0) {
    const ready = Array.from(pending.values()).filter((step) =>
      (step.dependsOn ?? []).every((dep) => {
        if (!stepIds.has(dep)) {
          throw new Error(`Workflow step "${step.id}" depends on unknown step "${dep}".`);
        }
        return completed.has(dep);
      }));

    if (ready.length === 0) {
      const blocked = Array.from(pending.values())
        .map((step) => `${step.id} waits for ${(step.dependsOn ?? []).filter((dep) => !completed.has(dep)).join(', ') || '(unknown)'}`)
        .join('; ');
      throw new Error(`Workflow dependency graph is blocked or cyclic: ${blocked}`);
    }

    batches.push(ready);
    for (const step of ready) {
      pending.delete(step.id);
      completed.add(step.id);
    }
  }

  return batches;
}

export interface BatchSettlement {
  completions: Array<{ stepId: string; output: unknown }>;
  parkedSteps: ParkedStepRef[];
  failures: Array<{ stepId: string; message: string }>;
  /** continue = all fulfilled; park = at least one sibling parked (park WINS
   *  over a sibling failure — see below); fail = failures and no park. */
  action: 'continue' | 'park' | 'fail';
}

/** T1.3: merge a parallel batch's settled results into one decision. The rule
 *  that matters: a parked sibling is work awaiting a HUMAN decision, so a park
 *  outranks an unrelated sibling's failure — the run parks (failure recorded as
 *  an advisory) instead of going terminal and cancelling the user's pending
 *  approval card. The failed step never emitted step_completed, so the pass
 *  after the park resolves re-runs it; a repeat failure with no park then fails
 *  the run normally. Completed siblings are always kept (durable in
 *  events.jsonl either way). Pure + exported for tests. */
export function decideBatchSettlement(
  batch: WorkflowStepInput[],
  settled: PromiseSettledResult<{ step: WorkflowStepInput; output: unknown }>[],
): BatchSettlement {
  const completions: BatchSettlement['completions'] = [];
  const parkedSteps: ParkedStepRef[] = [];
  const failures: BatchSettlement['failures'] = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      completions.push({ stepId: result.value.step.id, output: result.value.output });
    } else if (result.reason instanceof ParkRunSignal) {
      parkedSteps.push(...result.reason.parkedSteps);
    } else {
      failures.push({
        stepId: batch[i]?.id ?? 'unknown',
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
  const action = parkedSteps.length > 0 ? 'park' : failures.length > 0 ? 'fail' : 'continue';
  return { completions, parkedSteps, failures, action };
}

function stringifyForPrompt(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Stage 3 (reduce tier) — shard-reduce a LARGE forEach aggregate into a
 * durable digest artifact the synthesis envelope inlines, so the one
 * synthesis brain call reads compressed content instead of a bare ref.
 *
 * Honesty is code-owned: the reducer only ever sees successful item outputs;
 * this step's failures are appended deterministically from the runner's own
 * accumulator. Fingerprint-idempotent (a resumed/re-pursued step with an
 * unchanged aggregate skips re-reducing). Best-effort: any failure inside
 * degrades per-shard (reduceShardMembers never throws) and a write failure
 * simply leaves synthesis with today's behavior.
 */
/** The member projection shared by the digest WRITE (maybeReduceForEachAggregate)
 *  and the staleness check at READ (stepOutputArtifactRefForPrompt) — both must
 *  fingerprint the aggregate identically or a stale digest slips through. */
function reduceMembersForAggregate(value: unknown): Array<{ itemKey: string; callId: string; text: string }> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const members: Array<{ itemKey: string; callId: string; text: string }> = [];
  for (const entry of value) {
    const itemKey = (entry as { itemKey?: unknown } | null)?.itemKey;
    if (typeof itemKey !== 'string') return null; // not a forEach aggregate shape
    members.push({
      itemKey,
      callId: `item:${itemKey}`,
      text: stringifyForPrompt((entry as { output?: unknown }).output),
    });
  }
  return members;
}

async function maybeReduceForEachAggregate(
  ctx: { workflowSlug: string; runId: string; forEachFailures: Array<{ stepId: string; itemKey: string; error: string }> },
  stepId: string,
  aggregate: Array<{ itemKey: string; output: unknown }>,
): Promise<void> {
  try {
    if (!reduceTierEnabled() || !runWorkspaceOffloadEnabled()) return;
    if (aggregate.length < 20 || serializedContextLength(aggregate) <= STEP_CONTEXT_VALUE_CLIP) return;
    const members = reduceMembersForAggregate(aggregate);
    if (!members) return;
    const fingerprint = shardFingerprint(members);
    const prior = readReduceDigest(ctx.workflowSlug, ctx.runId, stepId);
    if (prior && prior.fingerprint === fingerprint) return; // unchanged aggregate — reuse

    const shardSize = reduceShardSize();
    const slices: Array<Array<{ itemKey: string; callId: string; text: string }>> = [];
    for (let offset = 0; offset < members.length; offset += shardSize) {
      slices.push(members.slice(offset, offset + shardSize));
    }
    // Bounded parallelism: shard reduces are independent cheap calls; running
    // them 3-wide keeps a 100-item step from serializing ~9 model round-trips
    // in its completion path (review F10). Each call is timeout-bounded.
    const REDUCE_CONCURRENCY = 3;
    const reducedSlices: Array<{ degraded: boolean; items: Array<{ itemKey: string; gist: string }> }> = [];
    for (let at = 0; at < slices.length; at += REDUCE_CONCURRENCY) {
      const batch = await Promise.all(slices.slice(at, at + REDUCE_CONCURRENCY).map((s) => reduceShardMembers(s)));
      for (const reduced of batch) {
        reducedSlices.push({
          degraded: reduced.degraded,
          items: reduced.items.map(({ itemKey, gist }) => ({ itemKey, gist })),
        });
      }
    }
    const shards = reducedSlices.map((s, i) => ({ shardIndex: i, ...s }));
    const failures = ctx.forEachFailures.filter((f) => f.stepId === stepId);
    const digestLines = [
      `SHARD-REDUCED DIGEST of step "${stepId}" (${aggregate.length} items, ${shards.length} shards; machine-generated — exact rows via workspace_artifact_query on the step output artifact):`,
      ...shards.map((s) => s.items.map((i) => `- ${i.itemKey}: ${i.gist}`).join('\n')),
      // Deterministic, code-owned failure lines — the reducer never saw these.
      ...(failures.length > 0
        ? [`FAILED ITEMS (authoritative, from the runner): ${failures.map((f) => `${f.itemKey} (${f.error.split('\n')[0].slice(0, 120)})`).join('; ')}`]
        : []),
    ];
    recordReduceDigest({
      workflowName: ctx.workflowSlug,
      runId: ctx.runId,
      digest: {
        stepId,
        fingerprint,
        shards,
        digest: digestLines.join('\n'),
        createdAt: new Date().toISOString(),
      },
    });
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_advisory',
      stepId,
      meta: {
        reason: 'shard_reduce',
        items: aggregate.length,
        shards: shards.length,
        degradedShards: shards.filter((s) => s.degraded).length,
        failed: failures.length,
      },
    });
  } catch {
    // The reduce tier is additive; synthesis falls back to today's behavior.
  }
}

function stepOutputArtifactRefForPrompt(
  stepId: string,
  value: unknown,
  opts?: StepContextRenderOptions,
): unknown | null {
  if (!opts || !runWorkspaceOffloadEnabled() || serializedContextLength(value) <= STEP_CONTEXT_VALUE_CLIP) {
    return null;
  }

  const workspacePath = stepOutputArtifactRelPath(stepId);
  const absolutePath = path.join(runWorkspaceDir(opts.workflowName, opts.runId), workspacePath);
  if (existsSync(absolutePath)) {
    // Stage 3: when a shard-reduced digest exists for this step, inline it so
    // the consumer (synthesis especially) reads real compressed content
    // instead of flying blind on a shape summary + path. Bounded; the exact
    // rows remain one workspace_artifact_query away. STALENESS GUARD (review
    // F2): a digest from a prior pursuit only inlines when its fingerprint
    // matches the CURRENT value — a re-pursued step whose aggregate changed
    // (or fell under the reduce trigger) must never present the old digest.
    const reduce = readReduceDigest(opts.workflowName, opts.runId, stepId);
    const currentMembers = reduce ? reduceMembersForAggregate(value) : null;
    const digestFresh = Boolean(reduce && currentMembers && reduce.fingerprint === shardFingerprint(currentMembers));
    const reduceDigest = digestFresh && reduce?.digest ? reduce.digest.slice(0, 14_000) : undefined;
    return {
      __clementine_context_ref: true,
      present: true,
      summary: summarizeToolOutput(value),
      bytes: Buffer.byteLength(stringifyForPrompt(value), 'utf-8'),
      path: absolutePath,
      workspacePath,
      ...(reduceDigest ? { reduceDigest, reducePath: reduceDigestArtifactRelPath(stepId) } : {}),
      instruction: reduceDigest
        ? 'This completed step output is too large to inline; a shard-reduced digest is in reduceDigest. Synthesize from it, and call workspace_artifact_query on this path only for exact rows/fields/pages.'
        : 'This completed step output is present but too large to inline. Call workspace_artifact_query on this path for exact rows/fields/pages, or read_file for raw JSON.',
    };
  }

  return contextValueForPrompt(value, `step.${stepId}.output`, opts);
}

function stepOutputValueForPrompt(
  stepId: string,
  value: unknown,
  opts?: StepContextRenderOptions,
): unknown {
  return stepOutputArtifactRefForPrompt(stepId, value, opts) ?? clipForContext(value);
}

function formatStepOutputs(
  steps: WorkflowStepInput[],
  stepOutputs: Record<string, unknown>,
  opts?: StepContextRenderOptions,
): string {
  return steps
    .filter((step) => stepOutputs[step.id] !== undefined)
    .map((step) => {
      const out = stepOutputValueForPrompt(step.id, stepOutputs[step.id], opts);
      return `## ${step.id}\n${stringifyForPrompt(out)}`;
    })
    .join('\n\n');
}

function parallelStepLabel(steps: WorkflowStepInput[]): string {
  if (steps.length === 1) return steps[0].id;
  const labels = steps.map((step) => step.id);
  const preview = labels.slice(0, 3).join(' + ');
  return labels.length > 3 ? `parallel: ${preview} + ${labels.length - 3} more` : `parallel: ${preview}`;
}

function appendWorkflowNodeReadyBatch(
  workflowSlug: string,
  runId: string,
  readyBatch: WorkflowStepInput[],
  scheduledBatch: WorkflowStepInput[],
  round: number,
  concurrencyCap: number,
): void {
  const scheduledIndex = new Map(scheduledBatch.map((step, index) => [step.id, index]));
  readyBatch.forEach((step, index) => {
    const laneIndex = scheduledIndex.get(step.id);
    appendWorkflowEvent(workflowSlug, runId, {
      kind: 'workflow_node_ready',
      stepId: step.id,
      meta: {
        round,
        readyIndex: index,
        readyWidth: readyBatch.length,
        concurrencyCap,
        scheduled: laneIndex !== undefined,
        laneIndex: laneIndex ?? null,
        deferredByConcurrency: laneIndex === undefined,
        parallel: readyBatch.length > 1,
      },
    });
  });
}

/**
 * Run the full step DAG to completion. Steps whose dependencies are
 * already satisfied run in the same batch, capped by
 * CLEMENTINE_WORKFLOW_CONCURRENCY. This is what makes workflow
 * frameworks fast: normalize once, fan out independent research
 * branches, then aggregate when all parents complete.
 */
/** Wave 3 P0-3: a step's external side-effect class — the declared `sideEffect`
 *  field if set, else derived from the prose heuristic. Drives the crash-resume
 *  guard (don't blind-re-run a step that may have partially sent/written). */
export function stepSideEffectClass(step: WorkflowStepInput): 'read' | 'write' | 'send' {
  // Delegates to the canonical classifier (workflow-enforce) so the gate, the
  // dashboard graph, and the proof card never disagree. The gate needs a
  // decision, so an unclassifiable step defaults to the safe 'read' bucket.
  const cls = classifyStepSideEffect(step);
  return cls === 'unknown' ? 'read' : cls;
}

/** Derive a call node's side-effect class from the shared conservative
 * Composio classifier. Unknown actions are writes; only a proven read action
 * may bypass mutation receipts. Exported for tests. */
export function callToolSideEffectClass(tool: string): 'read' | 'write' | 'send' {
  // A canonical read decision wins before the broad irreversible-send
  // predicate sees object nouns such as POST in TWITTER_GET_POST.
  if (classifyComposioSlugEffect(tool) === 'read') return 'read';
  // Delegate the send determination to the ONE canonical predicate so the
  // runtime agrees with the validator + the unattended auto-approve carve-out
  // (2026-07-09 re-hunt: workflow call-node lane). The old regex missed
  // CALL/DIAL/OUTBOUND/MAKE+CALL/RESPOND+EVENT.
  if (isIrreversibleSendSlug(tool)) return 'send';
  return 'write';
}

/** Whether a structured call must cross the durable mutation receipt boundary.
 * Both the declared/canonical step class and the tool slug are considered so a
 * stale `sideEffect: read` annotation cannot downgrade an obvious mutation. */
export function structuredCallNeedsMutationReceipt(step: WorkflowStepInput): boolean {
  if (!step.call?.tool) return false;
  // Deliberately conservative and independent of the authoring/parking class:
  // an unfamiliar slug the author declared read is a non-mutating READ for the
  // approval gate and requeue contract (via stepSideEffectClass — fold
  // 2026-07-17 #4), yet still gets a cheap durable receipt here as insurance. A
  // receipt on a genuinely read call is a harmless no-op; a missing one on a
  // mislabeled mutation is not, so a stale `sideEffect: read` never disables it.
  return stepSideEffectClass(step) !== 'read'
    || callToolSideEffectClass(step.call.tool) !== 'read';
}

/** Phantom-completion guard (#2): the trust-critical correctness check for
 *  unattended/yolo autonomy. A SEND/WRITE step that "completes" while calling ZERO
 *  real tools never performed its action — it emitted output instead of acting
 *  (observed 2026-06-30: a notify step returned the message as output without
 *  calling notify_user; same family as a workflow "completing" without scraping).
 *  In yolo mode this is the killer: Clem reports done, you're away, nothing
 *  happened. Re-classify it as a BLOCKED step so the existing diagnosis/needs-
 *  attention path surfaces it honestly instead of a silent false success.
 *  Signal is deliberately narrow (zero real tools) to avoid false-positives:
 *  - deterministic runner steps don't call brain tools → excluded;
 *  - StructuredOutput is schema emission, not an action → ignored;
 *  - an already-{blocked} output is honest → left alone.
 *  Kill-switch CLEMMY_WORKFLOW_PHANTOM_GUARD (default on). */
const PHANTOM_GUARD_INERT_TOOLS: ReadonlySet<string> = new Set(['StructuredOutput', 'workflow_step_result']);
function phantomGuardEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_WORKFLOW_PHANTOM_GUARD', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}
/** The honest replacement output for a phantom completion — shared by the SDK
 *  and orchestrator lanes so both surface the identical blocked shape. */
export function phantomBlockedOutput(step: WorkflowStepInput): { blocked: true; reason: string } {
  const cls = stepSideEffectClass(step);
  return {
    blocked: true,
    reason: `Step "${step.id}" is a ${cls} step but completed without calling any tool — the ${cls === 'send' ? 'send' : 'write'} was not actually performed (it returned output instead of acting). Re-run the step or fix it to call its tool.`,
  };
}
export function isPhantomStepCompletion(step: WorkflowStepInput, toolUses: string[] | undefined, output: unknown): boolean {
  if (!phantomGuardEnabled()) return false;
  if (step.deterministic) return false;
  const cls = stepSideEffectClass(step);
  if (cls !== 'send' && cls !== 'write') return false;
  if (output && typeof output === 'object' && !Array.isArray(output) && (output as { blocked?: unknown }).blocked === true) return false;
  const realTools = (toolUses ?? [])
    .map((t) => (typeof t === 'string' ? (t.split('__').at(-1) ?? t) : ''))
    .filter((t) => t.length > 0 && !PHANTOM_GUARD_INERT_TOOLS.has(t));
  return realTools.length === 0;
}

/** Does `consumer` read `sourceId`'s output — via dependsOn, a forEach over it,
 *  or a {{steps.<sourceId>.output…}} reference in its prompt? Pure. */
export function stepConsumesOutput(consumer: WorkflowStepInput, sourceId: string): boolean {
  if ((consumer.dependsOn ?? []).includes(sourceId)) return true;
  if (forEachSourceStepId(consumer.forEach) === sourceId) return true;
  const escaped = sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\{\\{\\s*steps\\.${escaped}[.\\s}]`).test(consumer.prompt ?? '');
}

export interface EmptyDeliverableRead { stepId: string; consumerId: string; shape: string; }

/**
 * Wave 2.1 (substance gap): find READ steps that produced NO data yet feed a
 * downstream step — the silent-nothing MISS (e.g. a `find prospects` read returns
 * [] because a credential expired, then `forEach prospects → send email` does
 * nothing, and the run still reports "completed"). The run is flagged
 * needsAttention so it is surfaced for review instead of passing as clean success.
 *
 * Conservative, to avoid false positives:
 *  - only `read`-class steps (an empty write/send is not a "no data" problem);
 *  - only steps whose output is actually empty (isEmptyValue — the SAME
 *    definition the declared-contract path uses);
 *  - SKIP steps with a declared `non_empty`/`min_items` contract (that path
 *    already hard-enforces non-emptiness — don't double-flag);
 *  - only when a DIFFERENT step actually consumes the output (a terminal read
 *    whose emptiness IS the answer — "no overdue invoices" — is not flagged here).
 * Pure + exported for tests.
 */
export function detectEmptyDeliverableReads(
  steps: WorkflowStepInput[],
  rawOutputs: Record<string, unknown>,
): EmptyDeliverableRead[] {
  const found: EmptyDeliverableRead[] = [];
  for (const step of steps) {
    if (!(step.id in rawOutputs)) continue; // step didn't run (partial/skip)
    if (stepSideEffectClass(step) !== 'read') continue;
    if (step.output?.non_empty?.length || step.output?.min_items) continue; // contract enforces it
    const value = rawOutputs[step.id];
    if (!isEmptyValue(value)) continue;
    const consumer = steps.find((t) => t.id !== step.id && stepConsumesOutput(t, step.id));
    if (!consumer) continue; // terminal read — emptiness may be the legitimate answer
    found.push({ stepId: step.id, consumerId: consumer.id, shape: describeOutputShape(value) });
  }
  return found;
}

/** Resolve a dot-path (e.g. "result.url") against a value; "" / "." = the root. */
function resolveOutputPath(value: unknown, dotted: string): unknown {
  if (dotted === '' || dotted === '.') return value;
  let cursor: unknown = value;
  for (const part of dotted.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** Deep-scan a value for http(s) URLs (bounded breadth + depth). */
function collectHttpUrls(value: unknown, into: Set<string>, depth: number): void {
  if (into.size >= 8 || depth > 6) return;
  if (typeof value === 'string') {
    for (const m of value.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) { into.add(m[0]); if (into.size >= 8) return; }
    return;
  }
  if (Array.isArray(value)) { for (const v of value) collectHttpUrls(v, into, depth + 1); return; }
  if (value && typeof value === 'object') { for (const v of Object.values(value as Record<string, unknown>)) collectHttpUrls(v, into, depth + 1); }
}

/** The first row-collection in a value: the array itself, or the first
 *  array-valued top-level key (mirrors the spaces row-count heuristic). */
function arrayCountFor(value: unknown): { label: string; n: number } | null {
  if (Array.isArray(value)) return { label: '', n: value.length };
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '_meta') continue;
      if (Array.isArray(v)) return { label: k, n: v.length };
    }
  }
  return null;
}

export interface RunArtifacts { urls: string[]; files: string[]; counts: string[]; }

/**
 * Wave 2.2 (structured run summary): scan a run's step outputs for the concrete
 * artifacts it produced — published URLs, saved files (from each step's declared
 * verify.path_exists), and row counts (an array's length, or the first
 * array-valued key). Pure + exported for tests. Caps each list so a huge run
 * can't bloat the summary.
 */
export function summarizeRunArtifacts(steps: WorkflowStepInput[], rawOutputs: Record<string, unknown>): RunArtifacts {
  const urls = new Set<string>();
  const files = new Set<string>();
  const counts: string[] = [];
  for (const step of steps) {
    if (!(step.id in rawOutputs)) continue;
    const out = rawOutputs[step.id];
    collectHttpUrls(out, urls, 0);
    for (const p of step.output?.verify?.path_exists ?? []) {
      const resolved = resolveOutputPath(out, p);
      if (typeof resolved === 'string' && resolved.trim()) files.add(resolved.trim());
    }
    const c = arrayCountFor(out);
    if (c && c.n > 0) counts.push(`${c.label || step.id}: ${c.n}`);
  }
  return { urls: [...urls].slice(0, 6), files: [...files].slice(0, 6), counts: counts.slice(0, 8) };
}

/**
 * Wave 3 P0-3: should crash-resume HALT instead of blind-re-running the
 * in-flight step? Returns the offending step + its class when YES, else null.
 *
 * HALT only on a genuine SILENT crash: a step that emitted step_started, never
 * completed, and left no other trace — the process vanished mid-execution and a
 * side-effecting (write/send) step may have partially sent/written. Everything
 * that isn't a silent side-effect crash is exempt:
 *
 *  - completed already           → nothing to re-run.
 *  - in-flight step has a        → it PARKED on a runtime request_approval
 *    step_failed event             (ParkRunSignal is caught + logged as
 *                                   step_failed, then the reaper re-admits it).
 *                                   A truly errored step is terminal and never
 *                                   resumed, so within a resumable run a logged
 *                                   failure means "parked", not "crashed".
 *                                   Re-running just resumes from the approval.
 *  - requiresApproval (declar.)  → the gate emits step_started before the wait,
 *                                   so a parked gate legitimately shows in-flight.
 *  - read class                  → no external side effect to duplicate.
 *
 * Pure + exported so the predicate is unit-tested.
 */
// Completed forEach items are skipped on resume, but an interrupted item from a
// legacy build may have mutated externally before its completion event landed.
// Mutating fanout therefore parks unless exact per-item receipt evidence can be
// established by a future recovery coordinator.

/** PURE: did a forEach item's send already CLAIM (an external_write) without
 *  being netted by a failure compensation? More writes than failures ⇒ a send
 *  fired. Separated from the event read so it is deterministically testable. */
export function sendAlreadyClaimed(externalWriteCount: number, failedCount: number): boolean {
  return externalWriteCount > failedCount;
}

/** Bug #8 guard: on resume, has THIS forEach item's send already fired? Its
 *  external_write events live under the item's DETERMINISTIC session id
 *  (`workflow:<runId>:<stepId>:<itemKey>`), so we reconstruct it and net writes
 *  against failure compensations — no new threading. Fail-open (a read error
 *  must never block a legitimate re-run). */
function itemSendAlreadyFired(runId: string, stepId: string, itemKey: string): boolean {
  try {
    const sid = `workflow:${runId}:${stepId}:${itemKey}`;
    const writes = listHarnessEvents(sid, { types: ['external_write'] }).length;
    const fails = listHarnessEvents(sid, { types: ['external_write_failed'] }).length;
    return sendAlreadyClaimed(writes, fails);
  } catch {
    return false;
  }
}

/** Bug #8 guard for PLAIN (non-forEach) steps: has THIS step's send already
 *  fired? The forEach item retry already nets writes-vs-failures under the
 *  item's session id (itemSendAlreadyFired); a plain send/write step had NO such
 *  guard, so a transient model error (e.g. a 529 between the send's
 *  external_write and step_completed) re-ran executeStep → re-prompted the same
 *  session from turn 0 → re-issued the send (the double-send class the codebase
 *  was hardened against — integrity audit #2.2). Same deterministic session id
 *  as the plain step (`workflow:<runId>:<stepId>`, no itemKey). Fail-open. */
export function stepExternalWriteAlreadyClaimed(runId: string, stepId: string): boolean {
  try {
    const sid = `workflow:${runId}:${stepId}`;
    const writes = listHarnessEvents(sid, { types: ['external_write'] }).length;
    const fails = listHarnessEvents(sid, { types: ['external_write_failed'] }).length;
    return sendAlreadyClaimed(writes, fails);
  } catch {
    return false;
  }
}

export function stepSendAlreadyFired(runId: string, stepId: string): boolean {
  return stepExternalWriteAlreadyClaimed(runId, stepId);
}

function downstreamOfStep(steps: WorkflowStepInput[], rootStepId: string): Set<string> {
  const affected = new Set<string>([rootStepId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (affected.has(step.id)) continue;
      for (const id of affected) {
        if (stepConsumesOutput(step, id)) {
          affected.add(step.id);
          changed = true;
          break;
        }
      }
    }
  }
  return affected;
}

function failedItemRetrySeeded(workflowSlug: string, runId: string): boolean {
  return readWorkflowEvents(workflowSlug, runId).some((ev) =>
    ev.kind === 'step_advisory' && ev.meta?.reason === 'failed_item_retry_seeded');
}

export function seedFailedItemRetryRun(
  workflow: WorkflowDefinition,
  workflowSlug: string,
  runId: string,
  retry: { fromRunId: string; stepId: string; itemKeys: string[] },
): { inheritedSteps: number; inheritedItems: number; sentSkips: number } {
  if (failedItemRetrySeeded(workflowSlug, runId)) {
    return { inheritedSteps: 0, inheritedItems: 0, sentSkips: 0 };
  }
  const fromRunId = retry.fromRunId.trim();
  const stepId = retry.stepId.trim();
  const failedKeys = Array.from(new Set(retry.itemKeys.map((key) => key.trim()).filter(Boolean)));
  if (!fromRunId || !stepId || failedKeys.length === 0) {
    throw new Error('Failed-item retry is missing its source run, step, or item keys.');
  }
  const retryStep = workflow.steps.find((step) => step.id === stepId);
  if (!retryStep) throw new Error(`Failed-item retry step "${stepId}" does not exist in workflow "${workflow.name}".`);
  if (!retryStep.forEach) throw new Error(`Failed-item retry step "${stepId}" is not a forEach step.`);

  const mutationContract = workflowStepMutationReceiptContract(retryStep);
  if (mutationContract === 'unreceipted_mutation') {
    throw new Error(
      `Cannot retry failed items for "${stepId}" because it mutates external state without structured per-item receipts.`,
    );
  }
  if (mutationContract === 'structured_call_receipt') {
    const sourceRecord = readRunRecord(path.join(WORKFLOW_RUNS_DIR, `${fromRunId}.json`));
    const sourceSnapshot = isWorkflowMutationContractSnapshot(sourceRecord?.mutationContractSnapshot)
      ? sourceRecord.mutationContractSnapshot
      : undefined;
    if (sourceSnapshot?.steps[stepId] === 'unreceipted_mutation') {
      throw new Error(
        `Cannot retry failed items for "${stepId}" because source run "${fromRunId}" admitted that step as an unreceipted mutation.`,
      );
    }
    const sourceUsesProtocol = sourceRecord?.mutationReceiptProtocolVersion
      === WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION
      && sourceSnapshot?.steps[stepId] === 'structured_call_receipt';
    let assessment: ReturnType<typeof assessWorkflowRunMutationRequeue>;
    try {
      assessment = assessWorkflowRunMutationRequeue({ workflowSlug, runId: fromRunId });
    } catch (err) {
      throw new Error(
        `Cannot retry failed items for "${stepId}" because mutation receipt evidence is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const failedSet = new Set(failedKeys);
    const blocking = assessment.blocking.find((item) =>
      item.stepId === stepId && (item.itemKey === undefined || failedSet.has(item.itemKey)));
    if (blocking) {
      throw new Error(
        `Cannot retry failed item "${blocking.itemKey ?? '(unknown item)'}" for "${stepId}" because its prior mutation receipt is ${blocking.status}.`,
      );
    }
    if (!sourceUsesProtocol) {
      const uncovered = failedKeys.find((itemKey) => !workflowCallMutationSlotHasLedger({
        workflowSlug,
        runId: fromRunId,
        stepId,
        itemKey,
      }));
      if (uncovered) {
        throw new Error(
          `Cannot retry failed item "${uncovered}" for "${stepId}" because source run "${fromRunId}" predates durable mutation receipts and has no exact slot ledger.`,
        );
      }
    }
  }

  const source = computeResumeState(workflowSlug, fromRunId);
  if (!source.completedSteps.has(retryStep.forEach)) {
    throw new Error(
      `Cannot retry failed items for "${stepId}" because source run "${fromRunId}" did not complete upstream step "${retryStep.forEach}".`,
    );
  }

  const affectedSteps = downstreamOfStep(workflow.steps, stepId);
  let inheritedSteps = 0;
  for (const [completedStepId, output] of source.completedSteps) {
    if (affectedSteps.has(completedStepId)) continue;
    appendWorkflowEvent(workflowSlug, runId, {
      kind: 'step_completed',
      stepId: completedStepId,
      output,
      meta: { inheritedFromRunId: fromRunId, retryFailedItemsOnly: true },
    });
    inheritedSteps += 1;
  }

  const failedSet = new Set(failedKeys);
  let inheritedItems = 0;
  for (const [itemKey, output] of source.completedItems.get(stepId) ?? new Map<string, unknown>()) {
    if (failedSet.has(itemKey)) continue;
    appendWorkflowEvent(workflowSlug, runId, {
      kind: 'item_completed',
      stepId,
      itemKey,
      output,
      meta: { inheritedFromRunId: fromRunId, retryFailedItemsOnly: true },
    });
    inheritedItems += 1;
  }

  let sentSkips = 0;
  if (stepSideEffectClass(retryStep) !== 'read') {
    for (const itemKey of failedSet) {
      if (!itemSendAlreadyFired(fromRunId, stepId, itemKey)) continue;
      const skipNote = '[skipped on failed-item retry — a prior external mutation for this item already fired; not repeated to avoid a duplicate. Verify it landed.]';
      appendWorkflowEvent(workflowSlug, runId, {
        kind: 'item_completed',
        stepId,
        itemKey,
        output: skipNote,
        meta: { inheritedFromRunId: fromRunId, retryFailedItemsOnly: true, reason: 'prior_send_already_fired' },
      });
      appendWorkflowEvent(workflowSlug, runId, {
        kind: 'step_advisory',
        stepId,
        meta: {
          reason: 'idempotent_failed_item_retry_skip',
          fromRunId,
          itemKey,
          note: `Item "${itemKey}" was not repeated because the source run already recorded an external mutation for it.`,
        },
      });
      sentSkips += 1;
    }
  }

  appendWorkflowEvent(workflowSlug, runId, {
    kind: 'step_advisory',
    stepId,
    meta: {
      reason: 'failed_item_retry_seeded',
      fromRunId,
      failedItemKeys: failedKeys,
      inheritedSteps,
      inheritedItems,
      sentSkips,
    },
  });
  return { inheritedSteps, inheritedItems, sentSkips };
}

/** The set of not-yet-completed steps execution could have reached given what
 * already completed: a step whose `dependsOn` are all satisfied. A step with an
 * unsatisfied dependency provably never started, so a crash-resume guard must
 * not treat it as a possibly-dispatched mutation. Falls back to "every
 * incomplete step" if the dependency graph can't be planned (cyclic/unknown
 * dep) — the conservative direction. */
function reachableResumeFrontier(
  steps: WorkflowStepInput[],
  completedSteps: Map<string, unknown>,
): Set<string> {
  const completedIds = new Set(completedSteps.keys());
  try {
    const batches = planWorkflowExecutionBatches(steps, completedIds);
    return new Set((batches[0] ?? []).map((step) => step.id));
  } catch {
    return new Set(steps.filter((step) => !completedIds.has(step.id)).map((step) => step.id));
  }
}

export function shouldHaltResumeForSideEffect(
  workflow: WorkflowDefinition,
  resume: { inFlightStepId?: string; completedSteps: Map<string, unknown>; failedSteps?: Set<string> },
  _targetStepId?: string,
  evidence?: {
    claimedExternalWrite?: boolean;
    harnessEnabled?: boolean;
    /** The run record was already `running` when this process admitted it. */
    resumedRun?: boolean;
    /** Steps whose dispatch boundary is guarded by the fail-closed structured
     * mutation receipt protocol. With no receipt, prior dispatch is impossible. */
    durableMutationProtocolStepIds?: ReadonlySet<string>;
    /** Structured mutating calls have a stricter exact-call receipt ledger.
     * Defer their recovery decision to that ledger instead of the prose/harness
     * heuristic, which cannot replay a successful direct-call result. */
    mutationReceiptProtected?: boolean;
  },
): { stepId: string; cls: 'write' | 'send'; declared: boolean } | null {
  const id = resume.inFlightStepId;
  if (!id && evidence?.resumedRun) {
    // The lifecycle journal is best-effort. A lost/corrupt step_started event
    // must not turn a crash-resumed run into permission to repeat a plain or
    // harness mutation. Structured direct calls are the exception: their
    // fsynced receipt protocol proves that absence of a ledger means dispatch
    // never crossed its boundary.
    //
    // Only a step in the READY FRONTIER could have been the step whose
    // step_started event was lost: a step with an unsatisfied dependency
    // provably never ran, so it must not halt resume (a read step 1 crashing
    // must not park a downstream send step 3 that execution never reached —
    // 2026-07-17 final-wave review #3). A dependsOn-less workflow runs every
    // step in one batch, so all incomplete steps stay in the frontier and the
    // guard remains conservative there.
    const frontier = reachableResumeFrontier(workflow.steps, resume.completedSteps);
    const uncertain = workflow.steps.find((step) =>
      frontier.has(step.id)
      && !resume.failedSteps?.has(step.id)
      && step.requiresApproval !== true
      && stepSideEffectClass(step) !== 'read'
      && !evidence.durableMutationProtocolStepIds?.has(step.id));
    if (uncertain) {
      const cls = stepSideEffectClass(uncertain) as 'write' | 'send';
      return { stepId: uncertain.id, cls, declared: uncertain.sideEffect === cls };
    }
  }
  if (!id || resume.completedSteps.has(id) || resume.failedSteps?.has(id)) return null;
  const crashed = workflow.steps.find((s) => s.id === id);
  if (!crashed || crashed.requiresApproval === true) return null;
  const cls = stepSideEffectClass(crashed);
  // `declared` distinguishes an explicit sideEffect from a prose-heuristic
  // guess — the halt message uses it to teach the one-line fix when the
  // class was only inferred (inferred read-only steps parking on crash was
  // the acme-facebook-trends failure mode, 2026-06-11).
  if (cls === 'read') return null;
  if (evidence?.mutationReceiptProtected === true) return null;
  // Harness external_write telemetry is useful positive evidence, but its
  // writers are best-effort. Absence cannot prove that provider dispatch never
  // happened, so only the fail-closed structured receipt protocol may bypass
  // this crash guard.
  return { stepId: id, cls, declared: crashed.sideEffect === cls };
}

async function executeWorkflow(
  workflow: WorkflowDefinition,
  workflowSlug: string,
  runId: string,
  inputs: Record<string, string>,
  assistant: ClementineAssistant,
  targetStepId?: string,
  goalFeedback?: string,
  originSessionId?: string,
  crashResume = false,
  mutationReceiptProtocolVersion?: number,
  mutationContractSnapshot?: unknown,
): Promise<{ finalOutput: string; forEachFailures: Array<{ stepId: string; itemKey: string; error: string }>; qualityAdvisories: WorkflowQualityAdvisory[] }> {
  const resume = computeResumeState(workflowSlug, runId);
  const stepOutputs: Record<string, unknown> = Object.fromEntries(resume.completedSteps);
  const forEachFailures: Array<{ stepId: string; itemKey: string; error: string }> = [];
  const qualityAdvisories: WorkflowQualityAdvisory[] = [];
  // Detection-only advisory judges run OFF the step/item critical path and are
  // joined once before this function returns (see deferAdvisory).
  const pendingAdvisories: Array<Promise<void>> = [];

  // WATCHER (workflow mount) state — see the step-boundary check below.
  // Disabled for partial single-step TRY runs (no full trajectory to judge).
  const watcherEnabled = watcherJudgeEnabled() && !targetStepId;
  const WATCHER_STEP_INTERVAL = watcherWorkflowIntervalSteps();
  const workflowWatcherFn = workflowWatcherOverride ?? runWatcherJudge;
  const watcherObjective = buildWorkflowObjective(workflow, inputs);
  const watcherCriteria = workflow.goal?.successCriteria?.length ? workflow.goal.successCriteria : undefined;
  let watcherLastCheckedAtSteps = 0;
  let watcherInjections = 0;
  let watcherChecks = 0;
  let watcherSteer: string | undefined;

  // Anchor the shared run workspace on this run's goal — the objective + learned
  // success criteria every step/agent references, and the file the checker agent
  // and the live window read. Best-effort; a workspace hiccup never blocks a run.
  try {
    anchorRunGoal(workflowSlug, runId, {
      objective: workflow.goal?.objective?.trim() || workflow.description?.trim() || `Deliver "${workflow.name}"`,
      successCriteria: workflow.goal?.successCriteria,
    });
  } catch { /* best-effort */ }

  // Wave 3 P0-3: crash-resume idempotency guard. A step that started but never
  // completed (crash / daemon restart) and performs an external side effect
  // must NOT be blind-re-run — it may have already sent or written some items.
  // Halt + throw, which routes to the error path → needsAttention (Wave 1), so
  // a human confirms before any re-run. (See shouldHaltResumeForSideEffect for
  // the exemptions: approval-gated steps and the targeted single-step re-run.)
  const inFlightStep = resume.inFlightStepId
    ? workflow.steps.find((step) => step.id === resume.inFlightStepId)
    : undefined;
  const claimedExternalWrite = inFlightStep
    ? stepExternalWriteAlreadyClaimed(runId, inFlightStep.id)
    : undefined;
  const sourceUsesMutationReceiptProtocol =
    mutationReceiptProtocolVersion === WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION;
  const admittedMutationContracts = isWorkflowMutationContractSnapshot(mutationContractSnapshot)
    ? mutationContractSnapshot
    : undefined;
  const durableMutationProtocolStepIds = new Set<string>();
  for (const step of workflow.steps) {
    if (step.forEach || workflowStepMutationReceiptContract(step) !== 'structured_call_receipt') continue;
    if (
      sourceUsesMutationReceiptProtocol
      && admittedMutationContracts?.steps[step.id] === 'structured_call_receipt'
    ) {
      durableMutationProtocolStepIds.add(step.id);
      continue;
    }
    // Admission said this exact step used an agentic/unreceipted mutation
    // boundary. A ledger created by a later definition cannot retroactively
    // prove the original dispatch never committed.
    if (admittedMutationContracts?.steps[step.id] === 'unreceipted_mutation') continue;
    try {
      if (workflowCallMutationSlotHasLedger({ workflowSlug, runId, stepId: step.id })) {
        durableMutationProtocolStepIds.add(step.id);
      }
    } catch {
      // Unreadable legacy evidence cannot authorize an empty-ledger bypass.
    }
  }
  let mutationReceiptProtected = false;
  if (
    inFlightStep
    && !inFlightStep.forEach
    && workflowStepMutationReceiptContract(inFlightStep) === 'structured_call_receipt'
  ) {
    const admittedContract = admittedMutationContracts?.steps[inFlightStep.id];
    mutationReceiptProtected = sourceUsesMutationReceiptProtocol
      && admittedContract === 'structured_call_receipt';
    if (admittedContract !== 'unreceipted_mutation') {
      try {
        mutationReceiptProtected = mutationReceiptProtected || workflowCallMutationSlotHasLedger({
          workflowSlug,
          runId,
          stepId: inFlightStep.id,
        });
      } catch {
        // An unreadable ledger cannot authorize bypassing the legacy duplicate
        // guard. The exact-call path will surface corruption after manual review.
        // Keep valid admission-snapshot authority, but never infer legacy
        // authority from unreadable exact-ledger evidence.
      }
    }
  }
  const resumeHalt = shouldHaltResumeForSideEffect(
    workflow,
    resume,
    targetStepId,
    {
      resumedRun: crashResume,
      durableMutationProtocolStepIds,
      ...(inFlightStep
        ? {
            claimedExternalWrite,
            harnessEnabled: workflowHarnessEnabled(inFlightStep),
            mutationReceiptProtected,
          }
        : {}),
    },
  );
  if (resumeHalt) {
    throw new Error(
      `Step "${resumeHalt.stepId}" was interrupted mid-run on a prior attempt and may have already ` +
      `${resumeHalt.cls === 'send' ? 'sent or published' : 'written'} some items. It was NOT automatically ` +
      `re-run, to avoid duplicates. Review what it did, then re-run the workflow (or just that ` +
      `step) manually once you've confirmed it's safe. ` +
      `NOTE: this step's class was ${resumeHalt.declared ? `declared sideEffect: ${resumeHalt.cls}` : `INFERRED as "${resumeHalt.cls}" from its prose (no sideEffect declared)`}. ` +
      `If the step is actually read-only (scrape/fetch/query — safe to repeat), declare \`sideEffect: read\` on it ` +
      `in the workflow definition and it will auto-resume after interruptions instead of parking here.`,
    );
  }
  const learnedPatternMatches = targetStepId
    ? []
    : recallWorkflowPatterns(`${workflow.name} ${workflow.description ?? ''}`, 2);
  const learnedPatternHint = renderWorkflowPatternHint(learnedPatternMatches);
  if (learnedPatternMatches.length > 0) {
    appendWorkflowEvent(workflowSlug, runId, {
      kind: 'step_advisory',
      stepId: '(workflow)',
      meta: {
        reason: 'learned_pattern_recalled',
        patterns: learnedPatternMatches.map((match) => ({
          workflow: match.record.workflowName,
          score: match.score,
          successCount: match.record.successCount,
        })),
      },
    });
  }

  // Single-step "TRY" mode: execute only the named step. Upstream
  // references in the prompt resolve to empty strings — the user is
  // explicitly asking to see this step in isolation. Synthesis is
  // skipped too; the step output is the final output.
  const steps = targetStepId
    ? workflow.steps.filter((s) => s.id === targetStepId)
    : workflow.steps;

  if (targetStepId) {
    const step = steps[0];
    if (!step) {
      throw new Error(`Workflow step "${targetStepId}" not found.`);
    }
    throwIfWorkflowRunCancelled(runId);
    if (stepOutputs[step.id] !== undefined) {
      // Already completed in a prior pass — use the cached output.
    } else {
      setWorkflowRunCurrentStep(runId, {
        stepId: step.id,
        index: 1,
        total: 1,
      });
      const completedItems = resume.completedItems.get(step.id) ?? new Map();
      const output = await executeStepVerified(step, {
        workflow, workflowSlug, runId, inputs, stepOutputs, assistant, completedItems, forEachFailures, qualityAdvisories, pendingAdvisories, goalFeedback, learnedPatternHint, originSessionId,
      });
      throwIfWorkflowRunCancelled(runId);
      stepOutputs[step.id] = output;
    }
  } else {
    let completedStepIds = new Set(Object.keys(stepOutputs));
    let executionRound = 0;
    // Stage 4 — aggregate run token budget, WORKFLOW lane: advisory-only in
    // v1 (a park here has no approval for the reaper to watch — a forever-
    // strand would be a worse lie than a warning; see the Stage-4 design
    // spike). One durable advisory per run when the summed per-step spend
    // crosses the ceiling; per-step wall-clocks still bound runaway time.
    let runBudgetWarned = false;
    const runTokenCeiling = resolveRunTokenCeiling({ budget: getHarnessBudgetSettings() });
    const workflowRunHasBudgetAdvisory = (wf: string, run: string): boolean =>
      readWorkflowEvents(wf, run).some((e) =>
        e.kind === 'step_advisory'
        && (e as { meta?: { reason?: string } }).meta?.reason === 'run_token_budget_exceeded');
    const maybeWarnRunBudget = (): void => {
      if (runBudgetWarned || !runTokenBudgetEnforcementEnabled() || runTokenCeiling <= 0) return;
      try {
        const spent = sumSessionTokensUsedByPrefix(`workflow:${runId}:`);
        if (spent < runTokenCeiling) return;
        runBudgetWarned = true;
        // Durable idempotency: a resumed run must not re-emit the advisory
        // (the in-memory flag dies with the process).
        try {
          if (workflowRunHasBudgetAdvisory(workflowSlug, runId)) return;
        } catch { /* fall through — a duplicate advisory beats a missing one */ }
        appendWorkflowEvent(workflowSlug, runId, {
          kind: 'step_advisory',
          stepId: '(budget)',
          meta: { reason: 'run_token_budget_exceeded', tokensUsed: spent, tokenCeiling: runTokenCeiling, advisoryOnly: true },
        });
      } catch { /* the advisory must never fail a run */ }
    };
    while (completedStepIds.size < steps.length) {
      executionRound += 1;
      maybeWarnRunBudget();
      const readyBatch = planWorkflowExecutionBatches(steps, completedStepIds)[0] ?? [];
      const concurrencyCap = Math.max(1, RUNNER_CONCURRENCY);
      const batch = readyBatch.slice(0, concurrencyCap);
      appendWorkflowNodeReadyBatch(workflowSlug, runId, readyBatch, batch, executionRound, concurrencyCap);
      const batchIndex = completedStepIds.size + 1;
      setWorkflowRunCurrentStep(runId, {
        stepId: parallelStepLabel(batch),
        index: batchIndex,
        total: steps.length,
      });

      const settled = await Promise.allSettled(batch.map(async (step) => {
        throwIfWorkflowRunCancelled(runId);
        const completedItems = resume.completedItems.get(step.id) ?? new Map();
        const output = await executeStepVerified(step, {
          workflow, workflowSlug, runId, inputs, stepOutputs, assistant, completedItems, forEachFailures, qualityAdvisories, pendingAdvisories, goalFeedback, learnedPatternHint, originSessionId,
          ...(watcherSteer ? { watcherSteer } : {}),
        });
        return { step, output };
      }));
      // A steer applies to exactly ONE batch — consumed above, cleared here.
      watcherSteer = undefined;

      const decision = decideBatchSettlement(batch, settled);
      for (const done of decision.completions) {
        stepOutputs[done.stepId] = done.output;
        completedStepIds.add(done.stepId);
      }
      throwIfWorkflowRunCancelled(runId);
      if (decision.action === 'park') {
        for (const failure of decision.failures) {
          appendWorkflowEvent(workflowSlug, runId, {
            kind: 'step_advisory',
            stepId: failure.stepId,
            error: failure.message,
            meta: { reason: 'batch_sibling_failed_while_parked' },
          });
          logger.warn(
            { runId, stepId: failure.stepId, err: failure.message },
            'batch step failed while a sibling parked on approval — preserving the park; the failed step re-runs after the approval resolves',
          );
        }
        throw new ParkRunSignal(decision.parkedSteps);
      }
      if (decision.action === 'fail') {
        const messages = decision.failures.map((e) => e.message);
        throw new Error(messages.length === 1 ? messages[0] : `Workflow batch failed: ${messages.join('; ')}`);
      }
      completedStepIds = new Set(Object.keys(stepOutputs));

      // WATCHER (workflow mount): at a step boundary with steps still ahead,
      // one trajectory check judges the run so far against the workflow's goal
      // (watcher-judge.ts — the same core as the chat mount). BLOCKING here on
      // purpose, unlike chat: steps run for minutes, so a ~10s check between
      // steps is negligible while letting the steer land on the VERY NEXT
      // step's prompt instead of one step late. Fail-open + silent when
      // on-track/unsure; ≤ MAX_WATCHER_INJECTIONS steers per run.
      if (
        watcherEnabled
        && completedStepIds.size < steps.length
        && watcherInjections < MAX_WATCHER_INJECTIONS
        && watcherChecks < MAX_WATCHER_CHECKS
        && completedStepIds.size - watcherLastCheckedAtSteps >= WATCHER_STEP_INTERVAL
      ) {
        watcherChecks += 1;
        watcherLastCheckedAtSteps = completedStepIds.size;
        try {
          const digest = renderWatcherWorkflowDigest(steps, stepOutputs);
          const verdict = await workflowWatcherFn({
            objective: watcherObjective,
            ...(watcherCriteria ? { successCriteria: watcherCriteria } : {}),
            toolCallSummary: digest.summary,
            latestAssistantNote: digest.latest,
            toolCallCount: completedStepIds.size,
          });
          if (verdict && !verdict.onTrack) {
            watcherInjections += 1;
            watcherSteer = `${verdict.miss}. ${verdict.steer}`;
            appendWorkflowEvent(workflowSlug, runId, {
              kind: 'step_advisory',
              stepId: '(watcher)',
              meta: { reason: 'watcher_steer', miss: verdict.miss, steer: verdict.steer, injection: watcherInjections, afterSteps: completedStepIds.size },
            });
          }
        } catch { /* the watcher is silent on any failure */ }
      }
    }
    // Stage 4 — final-batch coverage: a ceiling crossed during the LAST round
    // would exit the while before the next round-start check (review F6).
    maybeWarnRunBudget();
  }
  // Clear the step tracker before the synthesis pass + final cleanup
  // so the heartbeat doesn't keep showing the LAST step name after
  // the per-step loop is done.
  clearWorkflowRunCurrentStep(runId);
  clearWorkflowRunItemProgress(runId);

  // Synthesis step (optional final pass over all step outputs). Skipped
  // when TRY is running a single step in isolation — the step's own
  // output is the user-facing result.
  let finalOutput: string;
  if (workflow.synthesis?.prompt && !targetStepId) {
    throwIfWorkflowRunCancelled(runId);
    appendWorkflowEvent(workflowSlug, runId, {
      kind: 'step_started',
      stepId: '__synthesis__',
    });
    const stepOutputsAsText = formatStepOutputs(workflow.steps, stepOutputs, { workflowName: workflowSlug, runId });
    const synthesisPrompt = renderTemplate(workflow.synthesis.prompt, inputs, stepOutputs, undefined, resolveWorkflowStepProjectContext({}, workflow));
    const synthesisStep: WorkflowStepInput = {
      id: '__synthesis__',
      prompt: synthesisPrompt,
      // Follow the active brain: under claude_oauth the synthesis pass runs on
      // Claude (via the SDK workflow-step lane) like every other step, instead of
      // hardcoding MODELS.primary (gpt-*) which routed synthesis to Codex — or to
      // text-only headless for a Claude-only user. Use defaultForRole('brain')
      // (not raw MODELS.primary) so the codex-safe guard applies — otherwise a BYO
      // id polluting the OPENAI_MODEL_* slot would run synthesis on the BYO
      // endpoint even after the brain was switched to Codex.
      model: claudeIsActiveWorkflowBrain() ? getClaudeBrainModel() : defaultForRole('brain'),
      maxTurns: 8,
    };
    const synthesisMessage = [
      'Workflow synthesis pass. Produce the final user-facing result from the completed step outputs.',
      'Do not start new external research or mutate external systems during synthesis unless the user explicitly asked for that in the workflow synthesis prompt.',
      '',
      synthesisPrompt,
      '',
      'Step outputs:',
      '',
      stepOutputsAsText,
    ].join('\n');
    // T1.2: synthesis used to be the one LLM call in a run with no transient
    // retry, no brain fallover, and no fallback — a provider blip at the finish
    // line failed a run whose every step had already completed and verified.
    // Protect it like a step (synthesis is read-only prose, so re-runs are
    // always safe), and on ultimate failure degrade to the deterministic
    // step-output rollup instead of failing the run.
    const synthesisAttempt = (attemptStep: WorkflowStepInput): Promise<{ output: unknown }> =>
      runWithStepRetry(
        () => runStepViaHarness(
          attemptStep,
          `${runId}:synthesis`,
          synthesisMessage,
          workflow.name,
          [],
          runId,
          undefined,
          true, // canPark: synthesis runs outside any batch/forEach
        ),
        {
          budget: transientRetryFloor(),
          backoffBaseMs: RETRY_BACKOFF_BASE_MS,
          isRetryable: (err) =>
            !(err instanceof ParkRunSignal) &&
            !(err instanceof WorkflowRunCancelledError) &&
            (isTransientStepError(err) || isWorkflowStepStructuralResultError(err)),
          onRetry: ({ attempt, budget: b, delayMs, err }) => {
            appendWorkflowEvent(workflowSlug, runId, {
              kind: 'step_retry',
              stepId: '__synthesis__',
              error: err instanceof Error ? err.message : String(err),
              meta: { attempt, budget: b, delayMs, reason: isWorkflowStepStructuralResultError(err) ? 'structural_result' : 'transient' },
            });
          },
          afterBackoff: () => throwIfWorkflowRunCancelled(runId),
        },
      );
    let synthesisOutput: unknown = null;
    try {
      synthesisOutput = (await synthesisAttempt(synthesisStep)).output;
    } catch (err) {
      if (err instanceof ParkRunSignal || err instanceof WorkflowRunCancelledError) throw err;
      let lastErr: unknown = err;
      // Step-boundary brain fallover, mirroring executeStepVerified. Synthesis
      // is read-only, so there is no external-write guard to respect.
      if (workflowBrainFalloverEnabled() && (isTransientStepError(err) || isUnparseableToolCallError(err) || isWorkflowStepStructuralResultError(err))) {
        const currentProvider = resolveEffectiveProviderForModel(
          synthesisStep.model ?? defaultForRole('brain'),
        ) as BrainProviderClass;
        for (const target of falloverBrainModelIds(currentProvider)) {
          appendWorkflowEvent(workflowSlug, runId, {
            kind: 'step_advisory',
            stepId: '__synthesis__',
            meta: { reason: 'brain_fallover', from: currentProvider, to: target.provider, toModel: target.modelId },
          });
          try {
            synthesisOutput = (await synthesisAttempt({ ...synthesisStep, model: target.modelId })).output;
            lastErr = null;
            break;
          } catch (nextErr) {
            if (nextErr instanceof ParkRunSignal || nextErr instanceof WorkflowRunCancelledError) throw nextErr;
            lastErr = nextErr;
            if (!isTransientStepError(nextErr) && !isUnparseableToolCallError(nextErr)) break;
          }
        }
      }
      if (lastErr != null) {
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
        logger.warn({ runId, err: msg }, 'synthesis pass failed after retry+fallover — degrading to the raw step-output rollup');
        qualityAdvisories.push({
          stepId: '__synthesis__',
          kind: 'synthesis_degraded',
          note: `Synthesis pass failed (${msg}) — the final report is the raw step-output rollup. All steps completed and verified; only the prose rollup is degraded.`,
        });
        appendWorkflowEvent(workflowSlug, runId, {
          kind: 'step_advisory',
          stepId: '__synthesis__',
          error: msg,
          meta: { reason: 'synthesis_degraded' },
        });
      }
    }
    // Synthesis output is the final user-facing report (a string). The
    // step result is `unknown` now, so coerce: keep strings as-is,
    // JSON-render an (unexpected) structured synthesis result.
    const synthesisText = typeof synthesisOutput === 'string'
      ? synthesisOutput
      : synthesisOutput != null
        ? JSON.stringify(synthesisOutput, null, 2)
        : '';
    finalOutput = synthesisText || formatStepOutputs(workflow.steps, stepOutputs, { workflowName: workflowSlug, runId });
    throwIfWorkflowRunCancelled(runId);
    finalizeStepOutput(workflowSlug, runId, synthesisStep, finalOutput);
  } else {
    finalOutput = formatStepOutputs(workflow.steps, stepOutputs, { workflowName: workflowSlug, runId });
  }

  // Join the deferred detection-only advisory judges (skill-execution,
  // SDK-lane grounding) so every advisory lands in qualityAdvisories before
  // callers read it. They ran concurrently with the steps that spawned them —
  // by now most have already settled, so this await is usually instant.
  if (pendingAdvisories.length > 0) await Promise.allSettled(pendingAdvisories);

  // Record string-coerced step outputs on the run record for the
  // dashboard's recent-runs display (which expects strings).
  return { finalOutput, forEachFailures, qualityAdvisories };
}

function stringifyOutputs(stepOutputs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(stepOutputs)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

/**
 * Main entry — drains the queued-runs directory. Replaces the inline
 * runner that used to live in src/daemon/runner.ts.
 */
// Single-flight guard. When the drain runs on its own daemon timer
// (CLEMMY_WORKFLOW_RUN_LANE), the interval can re-fire while a previous
// drain is still awaiting a long run. This boolean keeps exactly one
// drain pass in flight at a time so the same run file is never picked
// up twice concurrently. (True run-level parallelism — draining several
// runs at once — is a separate, test-gated change; see the work-scheduler
// follow-up.)
let workflowDrainInFlight = false;

export async function processWorkflowRuns(assistant: ClementineAssistant): Promise<void> {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return;
  if (workflowDrainInFlight) return;
  workflowDrainInFlight = true;
  try {
    await drainWorkflowRuns(assistant);
  } finally {
    workflowDrainInFlight = false;
  }
}

/**
 * P0 event-driven approval parking — the resolution scan. Runs on the
 * workflow-run lane tick (and on boot). For each run checkpointed as
 * 'parked', re-admit it (flip status -> 'running') once EVERY approval it
 * was waiting on has cleared (approved / rejected / expired / cancelled).
 * The two-phase flip guarantees a still-pending parked run is never
 * handed a bounded-pool slot. `processOneRunFile` sees status==='running'
 * and resumes from the parked step (run_resumed event + computeResumeState
 * skip of completed steps). No-op when the flag is off — under flag-off no
 * run is ever written as 'parked', so this scan finds nothing.
 */
export function reapResolvedParkedRuns(): void {
  if (!parkingEnabled()) return;
  if (!existsSync(WORKFLOW_RUNS_DIR)) return;
  let approvalsById: Map<string, approvalRegistry.PendingApprovalRow>;
  try {
    approvalsById = new Map(
      approvalRegistry.listPending({ status: 'any' }).map((row) => [row.approvalId, row]),
    );
  } catch {
    return; // registry unavailable this tick — try again next tick
  }
  for (const file of readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'))) {
    const filePath = path.join(WORKFLOW_RUNS_DIR, file);
    const run = readRunRecord(filePath);
    if (!run || run.status !== 'parked' || !run.parked) continue;
    const watched = run.parked.parkedSteps.flatMap((s) => s.approvalIds).filter((id) => id.trim().length > 0);
    // Orphaned-park terminalization (2026-07-21 break-scenario C / audit A4
    // hole 2): a parked run whose checkpoint is MALFORMED (no watched approval
    // ids) or whose approval registry row is GONE can never resolve — the
    // reaper used to skip it FOREVER, leaving it "parked" on the board with no
    // path to terminal and no report-back. It must never auto-APPROVE by
    // absence (that would cross the side-effect boundary on a lost row), but
    // after a generous grace past the 24h approval TTL it is provably dead:
    // terminalize it as failed at the shared boundary so the board reflects
    // reality and the origin chat gets an honest report. Fresh orphans (a
    // transient registry read miss) stay parked until the grace elapses.
    const parkedAtMs = Date.parse(run.parked.parkedAt ?? '');
    const orphanGraceMs = 26 * 60 * 60_000; // 24h TTL + 2h margin
    const parkedTooLong = Number.isFinite(parkedAtMs) && Date.now() - parkedAtMs > orphanGraceMs;
    if (watched.length === 0) {
      if (parkedTooLong) {
        try {
          cancelWorkflowRunAtBoundary({ runId: run.id, reason: 'Parked run had a malformed approval checkpoint and could never resume — closed as failed after the approval grace period.', source: 'orphaned-park-reaper' });
        } catch { /* best-effort; watchdog still surfaces it */ }
      }
      continue;
    }
    const rows = watched.map((id) => approvalsById.get(id));
    if (rows.some((row) => !row)) {
      // Lost registry row: never auto-approve by absence. Terminalize only
      // once the run is provably dead (past the grace) — never approve.
      if (parkedTooLong) {
        try {
          cancelWorkflowRunAtBoundary({ runId: run.id, reason: 'The approval this run was parked on no longer exists (expired/reaped) and could never resume — closed as failed after the grace period. The protected action was NOT performed.', source: 'orphaned-park-reaper' });
        } catch { /* best-effort */ }
      }
      continue;
    }
    if (rows.some((row) => row?.status === 'pending')) continue; // still waiting on a human

    // A non-approved decision is terminal for THIS workflow occurrence. The
    // old behavior re-admitted every resolved park (including reject/expire),
    // which restarted an agentic step. If that step rebuilt even a slightly
    // different payload, the exact-payload resume key changed and Clementine
    // minted a brand-new approval. One declined scheduled email could therefore
    // come back repeatedly from the same run. Approval is the only decision
    // that may cross the side-effect boundary; every other decision stops the
    // occurrence without disabling its recurring schedule.
    const stopped = rows.find((row) => row?.resolution !== 'approved');
    if (stopped) {
      const decision = stopped.resolution === 'rejected'
        ? 'declined by the user'
        : stopped.resolution === 'expired'
          ? 'not approved before it expired'
          : 'cancelled by the user';
      const reason = `Workflow occurrence stopped because its approval was ${decision}. The protected action was not performed; steps completed before the approval stand, and any remaining steps were skipped.`;

      // Approval rejection is a cancellation producer too. Publish through
      // the one shared cancellation boundary before mutating SDK/activity
      // mirrors, so a dashboard cancel or terminal completion that won first
      // remains authoritative in every downstream side effect.
      const cancellation = cancelWorkflowRunAtBoundary({
        runId: run.id,
        reason,
        source: `approval-${stopped.resolution ?? 'not-approved'}`,
      });
      if (cancellation.status !== 'cancelled' && cancellation.status !== 'already_cancelled') continue;
      const stoppedRecord = cancellation.run as QueuedRunRecord;
      const canonicalReason = cancellation.request?.reason
        ?? (typeof stoppedRecord.error === 'string' ? stoppedRecord.error : reason);
      clearWorkflowRunPausedForApproval(run.id);

      // Clear every parked SDK session for this occurrence so a later recovery
      // scan cannot revive the interrupted model state and ask again.
      for (const row of rows) {
        if (!row?.sessionId) continue;
        try {
          const session = HarnessSession.load(row.sessionId);
          session?.clearInterruptState();
          session?.markStatus('cancelled');
        } catch { /* terminal run record below remains the source of truth */ }
      }

      // Persist the exact stable terminal card and origin acknowledgements for
      // whichever cancellation reason won; only that successful card stamps
      // the dashboard-notified marker.
      notifyCancelledRunOnce(filePath, stoppedRecord);
      try {
        appendWorkflowEvent(run.workflow, run.id, { kind: 'run_cancelled', error: canonicalReason });
      } catch { /* workflow event history is best-effort */ }
      try {
        finishRun(run.id, {
          status: 'cancelled',
          message: canonicalReason,
          outputPreview: canonicalReason,
        });
      } catch { /* activity mirror is best-effort */ }
      logger.info(
        { workflow: run.workflow, runId: run.id, approvalId: stopped.approvalId, resolution: stopped.resolution },
        'Parked workflow occurrence stopped after non-approved decision',
      );
      continue;
    }

    // The run is about to resume, so it is no longer "parked on approval".
    // Clear the in-memory heartbeat-suppression flag here so an in-process
    // resume (approval resolved without a daemon restart) doesn't inherit a
    // stale flag that silences the resumed run's heartbeats. Covers every
    // park path (declarative gate throws before its own finally can clear).
    clearWorkflowRunPausedForApproval(run.id);
    const resumedRecord = writeRunRecord(filePath, { ...run, status: 'running' }).record;
    if (isTerminalRunRecord(resumedRecord)) continue;
    try {
      addRunEvent(run.id, {
        type: 'run_resumed',
        status: 'running',
        message: 'Workflow approval resolved. Resuming the run.',
        data: {
          workflow: run.workflow,
          parkedSteps: run.parked.parkedSteps.map((s) => s.stepId),
          approvalIds: watched,
        },
      });
    } catch { /* run-events is best-effort; never block resume */ }
    logger.info(
      { workflow: run.workflow, runId: run.id, parkedSteps: run.parked.parkedSteps.map((s) => s.stepId) },
      'Parked workflow run re-admitted — approval(s) resolved',
    );
  }
}

// Per-runId guard so the same run file is never processed by two
// concurrent slots (or two overlapping drain passes). Module-scoped so
// it persists across passes.
const inFlightRunIds = new Set<string>();

// How many queued runs may execute at once. Read at call time so it's
// runtime-configurable and testable. Default 1 = today's sequential
// behavior (forward-only: no behavior change until explicitly raised);
// set CLEMENTINE_WORKFLOW_RUN_CONCURRENCY=3 (etc.) to let independent
// runs progress in parallel once you've soaked it.
function runDrainConcurrency(): number {
  const raw = parseInt(getRuntimeEnv('CLEMENTINE_WORKFLOW_RUN_CONCURRENCY', '1') || '1', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

// Flag-gate for the constrained, structured-output step agent. Default
// OFF so this lands dark (no behavior change) until verified + soaked;
// flip to 'on' to make workflow steps deterministic units that emit
// structured results and cannot re-trigger their own workflow.
function useWorkflowStepAgent(): boolean {
  return (getRuntimeEnv('WORKFLOW_STEP_AGENT', 'on') ?? 'on').toLowerCase() === 'on';
}

// Render the bound inputs + upstream outputs as an authoritative
// structured block appended after the prose. Each value is clipped to
// keep the prompt within budget (token-efficiency north star). If a workflow
// needs a precise large subfield, declare an explicit `inputs.from` binding
// or split the upstream step output into smaller structured values.
const STEP_CONTEXT_VALUE_CLIP = 8000;

interface StepContextRenderOptions {
  workflowName: string;
  runId: string;
  nowIso?: string;
}

function serializedContextLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function clipForContext(value: unknown): unknown {
  let json: string;
  try { json = JSON.stringify(value); } catch { return '[unserializable]'; }
  if (json.length <= STEP_CONTEXT_VALUE_CLIP) return value;
  // Head+tail preview of the SERIALIZED value (not a bare placeholder): a
  // downstream step keyed on a big upstream output (50 enriched records, a
  // scraped page) used to see only "[clipped …]" and FALSELY self-block as if
  // the value were empty. The preview shows the SHAPE + sample rows; for the
  // precise full value the step declares an explicit inputs.from binding.
  const head = 6000, tail = 1500;
  return `[clipped to a head+tail preview of ${json.length} chars — declare an explicit inputs.from binding for the precise full value]\n${json.slice(0, head)}\n…[${json.length - head - tail} chars omitted from the middle]…\n${json.slice(json.length - tail)}`;
}

function contextValueForPrompt(
  value: unknown,
  key: string,
  opts?: StepContextRenderOptions,
): unknown {
  if (!opts || !runWorkspaceOffloadEnabled() || serializedContextLength(value) <= STEP_CONTEXT_VALUE_CLIP) {
    return clipForContext(value);
  }
  try {
    const offloaded = offloadContextValue({
      workflowName: opts.workflowName,
      runId: opts.runId,
      key,
      value,
      nowIso: opts.nowIso ?? new Date().toISOString(),
    });
    const absolutePath = path.join(runWorkspaceDir(opts.workflowName, opts.runId), offloaded.path);
    return {
      __clementine_context_ref: true,
      present: true,
      summary: offloaded.summary,
      bytes: offloaded.bytes,
      path: absolutePath,
      workspacePath: offloaded.path,
      instruction:
        'This value is present but too large to inline. Prefer workspace_artifact_query on this path to pull exact rows/fields/pages. Use read_file with max_chars 50000 only when you need raw JSON text.',
    };
  } catch {
    return clipForContext(value);
  }
}

function renderStepContextBlock(
  ctx: { values: Record<string, unknown>; upstream: Record<string, unknown>; item?: unknown; project?: WorkflowStepProjectContext },
  opts?: StepContextRenderOptions,
): string {
  const payload: Record<string, unknown> = {
    input: Object.fromEntries(Object.entries(ctx.values).map(([k, v]) => [k, contextValueForPrompt(v, `input.${k}`, opts)])),
    upstream: Object.fromEntries(Object.entries(ctx.upstream).map(([k, v]) => [k, contextValueForPrompt(v, `upstream.${k}`, opts)])),
  };
  if (ctx.project !== undefined) payload.project = ctx.project;
  if (ctx.item !== undefined) payload.item = contextValueForPrompt(ctx.item, 'item', opts);
  return [
    '=== STEP CONTEXT (structured, authoritative) ===',
    'This is real workflow data. `input` contains declared step inputs; `upstream` contains outputs from every completed dependsOn step; `project` is the required local workspace when present. Use it over prose. If a value is a __clementine_context_ref, it is present and offloaded; call workspace_artifact_query on its path for exact rows/fields/pages, or read_file for raw JSON. If a value you need is empty/absent here, call workflow_step_result({"blocked":true,"reason":"<what is missing>"}) instead of guessing or fabricating.',
    JSON.stringify(payload, null, 2),
    '=== END STEP CONTEXT ===',
  ].join('\n');
}

/**
 * A run cancelled while still queued (or a mid-flight cancel whose notification
 * was lost to a crash) is skipped by the drain status filter and would never
 * report back. Surface it ONCE — north-star: reports back without fail.
 * markRunNotified + the !notifiedAt guard make it idempotent; best-effort so a
 * notify hiccup never breaks the drain (the watchdog backstops an unmarked one).
 */
/**
 * Gap E — re-enter the origin chat on a terminal state. Mirrors
 * enqueueBackgroundTaskOutcomeTurn: appends ONE synthetic role:'user' turn to
 * the triggering chat session so Clementine continues in-context (read via
 * recentTranscript on the session's next turn). This is IN ADDITION to the
 * global notification — it never replaces it. No-op when the run carries no
 * originSessionId (scheduled/cron/dashboard/webhook → notification-only).
 * Idempotent (id-prefix scan survives drain retries / restarts) and fully
 * best-effort: a session-write hiccup can NEVER fail a completed run or its
 * notification.
 */
export function enqueueWorkflowOutcomeTurn(
  run: QueuedRunRecord,
  workflowName: string,
  outcome: 'done' | 'blocked' | 'failed',
  detail: string,
): boolean {
  // Unified report-back (Move 4): delegate to the shared deliverOutcome so the
  // desktop/Discord/mobile surfaces render the SAME structure as every other
  // lane. Preserves the `[workflow run <id> …]` prefix + the "needs attention"
  // wording for a soft-blocked workflow (idempotency + tests depend on it).
  return deliverWorkflowRunOutcome(run, workflowName, outcome, detail);
}

// A daemon restart drains EVERY run file, so the cancelled-notify path must not
// re-ping the backlog: skip a STALE cancel (older than this window) or one that
// already reported back, mirroring the watchdog's two guards. Matches
// DEFAULT_TERMINAL_UNNOTIFIED_MAX_MS so the drain path + watchdog agree.
const CANCEL_NOTIFY_MAX_AGE_MS = 12 * 60 * 60_000;

/** Pure: should the drain path post a cancelled-run notification? NO for a
 *  STALE cancel (older than the window — e.g. a backlog file swept on restart)
 *  or one that already reported back. Exported for tests. */
export function shouldNotifyCancelledRun(
  run: { id: string; finishedAt?: string; createdAt?: string },
  nowMs: number,
  reportedBackRunIds: Set<string>,
): boolean {
  const ts = Date.parse(run.finishedAt ?? run.createdAt ?? '');
  const stale = Number.isFinite(ts) && nowMs - ts > CANCEL_NOTIFY_MAX_AGE_MS;
  return !stale && !reportedBackRunIds.has(run.id);
}

function notifyCancelledRunOnce(filePath: string, run: QueuedRunRecord): void {
  try {
    let reported = new Set<string>();
    let dashboardNotified = new Set<string>();
    try {
      const notifications = loadNotifications();
      reported = reportedBackRunIdsFrom(notifications);
      dashboardNotified = terminalDashboardNotificationRunIdsFrom(notifications);
    } catch { /* best-effort: a bad notification log must not block the cancel notify */ }
    let notificationPersisted = reported.has(run.id) || dashboardNotified.has(run.id);
    if (shouldNotifyCancelledRun(run, Date.now(), reported)) {
      addNotification({
        // Stable id → addNotification id-dedup makes this at-most-once even if
        // the drain re-reads the file or the catch-handler also posts a cancel
        // card for the same run.
        id: `workflow-${run.id}-cancelled`,
        kind: 'workflow',
        title: `Workflow cancelled: ${run.workflow}`,
        body: run.error || 'This workflow run was cancelled.',
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { workflow: run.workflow, runId: run.id, status: 'cancelled' },
      });
      notificationPersisted = true;
      // A chat-fired run's cancellation re-enters the origin chat too —
      // the user who asked for it in conversation shouldn't have to find a
      // notification card to learn it stopped. No-op without originSessionId;
      // deliverOutcome's idempotency makes drain retries safe.
      if (run.reportBack) {
        attemptWorkflowRunReportBack(filePath);
      } else {
        recordAndAttemptWorkflowRunReportBack(filePath, {
          workflowName: run.workflow,
          outcome: 'failed',
          detail: run.error || 'This workflow run was cancelled.',
        });
      }
    }
    // `notifiedAt` proves a terminal dashboard/global card is durable. A stale
    // cancellation with no such evidence remains unmarked; the bounded
    // watchdog window prevents historical backlog alerts without inventing
    // notification truth.
    if (notificationPersisted) markRunNotified(filePath);
  } catch { /* best-effort; the watchdog backstops an unmarked terminal run */ }
}

async function drainWorkflowRuns(assistant: ClementineAssistant): Promise<void> {
  const workflows = listWorkflows();
  const eligible: Array<{ file: string; filePath: string; run: QueuedRunRecord }> = [];
  for (const file of readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'))) {
    const filePath = path.join(WORKFLOW_RUNS_DIR, file);
    let run = readRunRecord(filePath);
    if (!run) continue;
    // A terminal outcome is a durable delivery intent, not a one-shot side
    // effect. Retry failed origins and late observer sidecars every drain tick;
    // duplicate turns acknowledge successfully without being appended again.
    if (
      run.reportBack
      && workflowRunReportBackNeedsRetry(run)
      && workflowRunReportBackRetryDue(run)
    ) {
      attemptWorkflowRunReportBack(filePath);
      run = readRunRecord(filePath) ?? run;
    }
    // A cancelled run never enters processOneRunFile (skipped just below), so
    // notify it here once before dropping it — otherwise a queued-then-cancelled
    // run (or a mid-flight cancel whose notify was lost) goes silent.
    if (run.status === 'cancelled' && !run.notifiedAt) {
      notifyCancelledRunOnce(filePath, run);
    }
    // Pick up queued runs and runs marked as running but never
    // completed (resume after daemon restart). Also pick up a FRESH dry_run /
    // creation_test request — but not one already finished.
    if (run.status === 'dry_run' || run.status === 'creation_test') {
      if (run.finishedAt) continue;
    } else if (run.status && run.status !== 'queued' && run.status !== 'running') {
      continue;
    }
    if (inFlightRunIds.has(run.id)) continue; // already draining in another slot
    eligible.push({ file, filePath, run });
  }
  if (eligible.length === 0) return;

  await runBoundedPool(
    eligible,
    runDrainConcurrency(),
    async (item) => {
      if (inFlightRunIds.has(item.run.id)) return;
      inFlightRunIds.add(item.run.id);
      try {
        await processOneRunFile(item.file, item.filePath, item.run, workflows, assistant);
      } finally {
        inFlightRunIds.delete(item.run.id);
      }
    },
    (err, item) => logger.error({ err, file: item.file }, 'Workflow run drain task crashed'),
  );
}

// ── Bounded autonomous self-heal ────────────────────────────────────
//
// Owner directive: "on 1 failure workflows can run again until clem self heals
// them." When a step blocks with a diagnosable, AUTO-APPLICABLE prompt-rewrite
// fix, apply it and re-run automatically — bounded, side-effect-guarded, and
// reported every time. Reuses the EXACT path `apply fix` already runs (the
// user-approved Doctor flow): applyProposedFix → requeueWorkflowFromRun. So this
// introduces no new execution machinery and no side-effect class beyond what
// shipping `apply fix` already does — only it's automatic, counted, and capped.
// Gated by the existing WORKFLOW_SELF_HEAL switch (default on); no new flag.

function selfHealAutoMaxAttempts(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMENTINE_WORKFLOW_SELF_HEAL_MAX_ATTEMPTS', '2') || '2', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
}

/** Side-effect guard: a FRESH re-run re-executes every step, so it's only safe
 *  when no OTHER mutating step already completed before the blocked one — else
 *  the re-run could double an irreversible write. A step counts as mutating if
 *  it is classified as write/send by the same shared runtime classifier used
 *  for execution receipts (with approval gates retained as an independent
 *  author signal). Conservative: if any such step completed, escalate instead
 *  of creating a fresh run whose new run id cannot replay the old receipt. */
function hasCompletedUpstreamMutation(
  steps: WorkflowStepInput[],
  blockedStepId: string,
  completedStepIds: Set<string>,
): boolean {
  return steps.some((s) =>
    s.id !== blockedStepId
    && completedStepIds.has(s.id)
    && (s.requiresApproval === true
      || (s as { requires_approval?: boolean }).requires_approval === true
      || structuredCallNeedsMutationReceipt(s)
      || stepSideEffectClass(s) !== 'read'));
}

function stepRequiresApproval(step: WorkflowStepInput): boolean {
  return step.requiresApproval === true || (step as { requires_approval?: boolean }).requires_approval === true;
}

/**
 * Auto-heal rewrites the workflow prompt and queues a fresh full run. For
 * workflows that eventually post/send/publish, a model-authored fix must not be
 * allowed to silently continue into the external action. Let the workflow
 * self-heal only when that irreversible action is protected by a declarative
 * approval gate; otherwise surface the fix for human approval instead.
 */
function hasUngatedIrreversibleAction(steps: WorkflowStepInput[]): boolean {
  return steps.some((step) => {
    const cls = step.sideEffect === 'read' || step.sideEffect === 'write' || step.sideEffect === 'send'
      ? step.sideEffect
      : stepLooksLikeIrreversibleSend(step.prompt ?? '') ? 'send' : stepLooksMutating(step) ? 'write' : 'read';
    return cls === 'send' && !stepRequiresApproval(step);
  });
}

interface AutoHealOutcome { attempt: number; max: number; stepId: string; message: string; }

/**
 * Decide + perform an automatic heal for a run that just completed with a
 * diagnosable block. Returns the heal outcome (so the caller reports it +
 * suppresses the "apply this fix" offer) or null to fall through to today's
 * escalation (needs-attention + fix offer). Never throws.
 */
async function tryAutoHealAndRequeue(args: {
  run: QueuedRunRecord;
  workflowSlug: string;
  steps: WorkflowStepInput[];
  diagnosis: WorkflowDiagnosis | null;
  proposedFix: ProposedFix | null;
  completedStepIds: Set<string>;
  /** RSH-2: the just-completed run's RAW structured step outputs — lets the
   *  probe check a candidate contract fix against real data before re-running. */
  rawStepOutputs?: Record<string, unknown>;
}): Promise<AutoHealOutcome | null> {
  const { run, workflowSlug, steps, diagnosis, proposedFix, completedStepIds, rawStepOutputs } = args;
  if (!selfHealEnabled() || !diagnosis || !proposedFix) return null;
  // Cross-fire guard (#6): a workflow that has failed N times in a row is
  // clearly stuck — stop re-running the WHOLE thing to auto-heal (the
  // expensive multiplier) and let it escalate to the human instead.
  if (shouldStopAutoHeal(workflowSlug)) {
    logger.info(
      { runId: run.id, workflow: workflowSlug, consecutiveFailures: escalateThreshold() },
      'self-heal: workflow is chronically failing — auto-heal paused, escalating',
    );
    return null;
  }
  const fix = diagnosis.fix;
  // RSH-1: auto-apply the safe, structured fix kinds — a prompt rewrite
  // (edit_step) or an output-contract correction (edit_contract). Both are
  // re-validated + backed up + cross-family-judged + re-run-gated below;
  // everything else (reconnect/adjust_input/manual) still escalates to the human.
  if (!fixIsAutoApplicable(fix)) return null;
  const max = selfHealAutoMaxAttempts();
  const prior = run.selfHealAttempt ?? 0;
  if (max <= 0 || prior >= max) return null; // at cap → escalate (today's offer)
  if (hasUngatedIrreversibleAction(steps)) {
    logger.info(
      { runId: run.id, step: fix.stepId },
      'self-heal: workflow has an ungated irreversible action — escalating instead of auto re-running after a prompt edit',
    );
    return null;
  }
  if (hasCompletedUpstreamMutation(steps, fix.stepId, completedStepIds)) {
    logger.info(
      { runId: run.id, step: fix.stepId },
      'self-heal: an upstream mutating step already completed — escalating instead of auto re-running (avoids double side effects)',
    );
    return null;
  }
  // RSH-2 (probe-before-re-run): a contract fix claims the step's real data
  // should satisfy a loosened contract. We already HAVE that data (this run's
  // raw output). Verify it in-process — FREE, deterministic, zero model calls —
  // before applying the fix or paying for a full re-run. If even the data we
  // have fails the "fixed" contract, the fix is doomed: escalate to the human
  // now instead of applying + re-running into the same failure. Runs before the
  // model judge so a doomed fix skips that call too. Only gates edit_contract;
  // an edit_step probe needs re-execution (a later phase). Output unavailable →
  // skip the probe (the re-run + auto-revert remain the safety net).
  if (fix.kind === 'edit_contract' && rawStepOutputs && fix.stepId in rawStepOutputs) {
    const newContract = sanitizeOutputContract(fix.newOutputContractJson);
    const verdict = newContract ? verifyStepOutput(newContract, rawStepOutputs[fix.stepId]) : { ok: false, problems: ['unparseable contract'] };
    if (!verdict.ok) {
      appendWorkflowEvent(workflowSlug, run.id, {
        kind: 'step_advisory',
        stepId: fix.stepId,
        meta: { reason: 'heal_probe_failed', fixKind: 'edit_contract', problems: verdict.problems.slice(0, 4) },
      });
      logger.info(
        { runId: run.id, step: fix.stepId, problems: verdict.problems.slice(0, 3) },
        'self-heal: probe rejected the contract fix — the real output still fails the proposed contract, escalating without a re-run',
      );
      return null;
    }
  }
  // T3.2: never self-grade an auto-mutating action — a judge from a DIFFERENT
  // provider family re-grades the Doctor's fix before it auto-applies. Veto →
  // the fix is offered to the human instead (today's escalation). No
  // different-family judge available → fail-open (bounded + backed-up +
  // auto-reverted-on-non-stick already protect the blast radius).
  const stepPrompt = steps.find((s) => s.id === fix.stepId)?.prompt;
  const healJudge = await judgeHealCrossFamily(diagnosis, stepPrompt);
  if (healJudge.verdict === 'veto') {
    logger.info(
      { runId: run.id, step: fix.stepId, reason: healJudge.reason },
      'self-heal: cross-family judge vetoed the auto-fix — escalating to the human apply-fix offer',
    );
    return null;
  }
  let applied: { ok: boolean; message: string; backupId?: string };
  throwIfWorkflowRunCancelled(run.id);
  try {
    applied = applyProposedFix(proposedFix.id);
  } catch (err) {
    logger.warn({ runId: run.id, err: err instanceof Error ? err.message : err }, 'self-heal: applyProposedFix threw; escalating');
    return null;
  }
  if (!applied.ok) {
    logger.info({ runId: run.id, fixId: proposedFix.id, msg: applied.message }, 'self-heal: fix not auto-applicable; escalating');
    return null;
  }
  const attempt = prior + 1;
  try {
    appendWorkflowEvent(workflowSlug, run.id, { kind: 'step_retry', stepId: fix.stepId, meta: { selfHeal: true, attempt, backupId: applied.backupId, judge: healJudge.verdict } });
  } catch { /* heal log is best-effort */ }
  throwIfWorkflowRunCancelled(run.id);
  const requeued = requeueWorkflowFromRun(run.id, {
    originSessionIds: workflowRunOriginSessionIds(run),
    selfHealAttempt: attempt,
    selfHealBackupId: applied.backupId,
    sourceExecutionSettled: true,
  });
  if (requeued.status !== 'queued' && requeued.status !== 'duplicate') {
    // Fix is applied but we couldn't re-queue — report it so it's never silent.
    logger.warn({ runId: run.id, status: requeued.status, reason: requeued.message }, 'self-heal: applied fix but could not re-queue; surfacing for manual re-run');
    return { attempt, max, stepId: fix.stepId, message: `I auto-applied a fix to step "${fix.stepId}" (${fix.description}), but couldn't re-run automatically: ${requeued.message}` };
  }
  // RSH-5: remember this fix as PENDING, keyed by the healed re-run. If that run
  // completes clean the fix is PROMOTED to the confirmed store (it stuck); if it
  // fails/reverts it's discarded. A confirmed fix sharpens future diagnosis.
  try {
    if (requeued.id) {
      recordPendingFix(requeued.id, {
        workflowSlug,
        stepId: fix.stepId,
        signature: fixSignature(diagnosis.rootCause),
        fixKind: fix.kind,
        fixDescription: fix.description,
        fix: fix as unknown as Record<string, unknown>,
      });
    }
  } catch { /* fix memory is best-effort */ }
  logger.info({ runId: run.id, newRunId: requeued.id, step: fix.stepId, attempt, max }, 'self-heal: applied fix + re-queued a fresh run');
  return {
    attempt,
    max,
    stepId: fix.stepId,
    message: `Step "${fix.stepId}" blocked, so I auto-applied a fix (${fix.description}) and re-ran the workflow — attempt ${attempt} of ${max}. It's running in the background and will report back here when it finishes.`,
  };
}

// ── Run-level pinned goals (goal-contract, run scope) ────────────────
//
// A workflow can declare `goal:` — an objective + success criteria parked
// OUTSIDE the model. Every completed run is validated externally against the
// parked criteria (validateGoal: deterministic checks + strict judge that can
// NEVER auto-satisfy on infra failure). Unmet + safe + attempts left → the
// run re-queues itself with the validation evidence folded into every LLM
// step prompt, so attempt N+1 is targeted. Unmet + unsafe (an irreversible
// step already executed) or attempts exhausted → loud needs-attention with
// per-criterion evidence. This is the run-scope sibling of step `loopUntil`,
// reusing the SAME requeue machinery as bounded self-heal — no new loop
// drivers, no new stores (the contract row lives in plan-proposals with
// origin kind 'workflow').

/** Normalize the def's pinned goal; null when none declared. */
function workflowRunGoal(def: WorkflowDefinition): { objective: string; successCriteria: string[]; maxAttempts: number } | null {
  const g = def.goal;
  const objective = g?.objective?.trim() ?? '';
  if (objective.length < 4) return null;
  return {
    objective,
    successCriteria: (g?.successCriteria ?? []).map((c) => c.trim()).filter(Boolean),
    maxAttempts: clampGoalMaxAttempts(g?.maxAttempts),
  };
}

/**
 * Side-effect law at RUN scope: a goal re-pursuit re-executes EVERY step, so
 * it is only safe when no completed step could double an irreversible
 * external effect. Stricter than the self-heal guard: declared side-effect
 * classes count (send is always unsafe; write is unsafe unless the author
 * asserted `loopSafe: true`), approval-gated steps count (the author's own
 * "this mutates" signal), and the prose heuristic still backstops undeclared
 * steps. Returns the first offending step id, or null when safe. Exported
 * for tests.
 */
export function runUnsafeToRepursue(
  steps: WorkflowStepInput[],
  completedStepIds: Set<string>,
): string | null {
  for (const s of steps) {
    if (!completedStepIds.has(s.id)) continue;
    const cls = stepSideEffectClass(s);
    if (cls === 'send') return s.id;
    if (cls === 'write' && s.loopSafe !== true) return s.id;
    if (s.requiresApproval === true) return s.id;
  }
  return null;
}

export interface GoalRunDecision {
  action: 'satisfied' | 'repursue' | 'escalate' | 'advisory';
  reason: string;
}

/**
 * Pure decision: what happens to a completed run whose pinned goal was just
 * validated. Exported for tests — every branch is deterministic.
 */
export function decideGoalRunOutcome(args: {
  verdict: GoalValidationResult;
  /** Total run attempts allowed (original + re-pursuits), already clamped. */
  maxAttempts: number;
  /** run.goalAttempt ?? 0 — re-pursuits that already happened. */
  priorRepursuits: number;
  /** First completed step unsafe to re-run, from runUnsafeToRepursue. */
  unsafeStepId: string | null;
  chronicallyFailing: boolean;
}): GoalRunDecision {
  const attemptsUsed = args.priorRepursuits + 1;
  if (args.verdict.pass) return { action: 'satisfied', reason: 'all success criteria met' };
  // A dead judge makes the FUZZY criteria unverifiable — but a deterministic
  // criterion (a named artifact) that PROVABLY failed in the same verdict is
  // a real miss, not an unverifiable one. Only downgrade to advisory when
  // nothing provable failed; a proven miss proceeds to repursue/escalate.
  const provenMiss = args.verdict.perCriterion.some((c) => !c.pass && c.method === 'deterministic');
  if (args.verdict.judgeFailedOpen && !provenMiss) {
    return { action: 'advisory', reason: 'goal validation unavailable (judge error) — not re-running on an unverifiable verdict' };
  }
  if (attemptsUsed >= args.maxAttempts) {
    return { action: 'escalate', reason: `goal unmet after ${attemptsUsed}/${args.maxAttempts} attempts` };
  }
  if (args.unsafeStepId) {
    return { action: 'escalate', reason: `goal unmet, but step "${args.unsafeStepId}" performed an irreversible action this run — re-running could double it` };
  }
  if (args.chronicallyFailing) {
    return { action: 'escalate', reason: 'goal unmet and this workflow is chronically failing — escalating instead of burning more attempts' };
  }
  return { action: 'repursue', reason: `goal unmet (attempt ${attemptsUsed}/${args.maxAttempts})` };
}

function startWorkflowActivityRun(
  run: QueuedRunRecord,
  workflowName: string,
  message?: string,
): void {
  try {
    startRun({
      id: run.id,
      sessionId: `workflow:${run.id}`,
      channel: 'workflow',
      source: 'workflow',
      title: `Workflow: ${workflowName}`,
      message: message ?? `Running workflow "${workflowName}"${run.targetStepId ? ` · step ${run.targetStepId}` : ''}`,
    });
  } catch { /* run-events is best-effort; never block the workflow lane */ }
}

function finishWorkflowActivityRun(
  runId: string,
  input: Parameters<typeof finishRun>[1],
): void {
  try {
    finishRun(runId, input);
  } catch { /* run-events is best-effort; never block the workflow lane */ }
}

/** Evidence the validator judges: the final deliverable + a truncated
 *  per-step ledger (so a criterion about an intermediate step is checkable). */
function compactEvidencePreview(value: unknown, maxChars: number): string {
  const text = stringifyForPrompt(value).replace(/\s+/g, ' ').trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function formatStepOutputEvidence(
  stepId: string,
  output: unknown,
  opts?: StepContextRenderOptions,
): string {
  const preview = compactEvidencePreview(output, 700);
  const ref = stepOutputArtifactRefForPrompt(stepId, output, opts);
  if (ref && typeof ref === 'object') {
    const rec = ref as { path?: unknown; workspacePath?: unknown; summary?: unknown; bytes?: unknown };
    return [
      `${summarizeToolOutput(output)}.`,
      `Artifact: ${String(rec.path ?? rec.workspacePath ?? '(unavailable)')}.`,
      `Query with workspace_artifact_query for exact rows/fields/pages.`,
      `Preview: ${preview}`,
    ].join(' ');
  }
  return preview;
}

function buildGoalEvidenceText(
  finalOutput: string,
  stepOutputs: Record<string, unknown>,
  opts?: StepContextRenderOptions,
): string {
  const stepLines = Object.entries(stepOutputs)
    .slice(0, 20)
    .map(([id, out]) => `- ${id}: ${formatStepOutputEvidence(id, out, opts)}`);
  return [
    'FINAL OUTPUT:',
    (finalOutput || '(empty)').slice(0, 6000),
    '',
    'STEP RESULTS (truncated):',
    ...stepLines,
  ].join('\n');
}

/** Render the unmet criteria as feedback for the next attempt / the human.
 *  Leads with the numeric scorecard and concrete per-criterion FIX directives
 *  (so a deterministic file-miss becomes "create X" the next attempt can act on),
 *  falling back to the prose UNMET list when a verdict has no structured
 *  directives (e.g. a hand-built test fake). */
export function renderGoalFeedback(verdict: GoalValidationResult): string {
  const failed = verdict.perCriterion.filter((c) => !c.pass);
  const scoreLine =
    typeof verdict.successRatePercent === 'number' &&
    typeof verdict.criteriaMet === 'number' &&
    typeof verdict.criteriaTotal === 'number'
      ? `Goal score: ${verdict.successRatePercent}% (${verdict.criteriaMet}/${verdict.criteriaTotal} criteria met)`
      : '';
  const fixes = (verdict.failedDirectives ?? []).map((d) => `- FIX: ${d.fix}`);
  return [
    scoreLine,
    ...(fixes.length > 0
      ? fixes
      : failed.map((c) => `- UNMET: ${c.criterion}${c.detail ? ` (${c.detail})` : ''}`)),
    verdict.advice ? `Guidance: ${verdict.advice}` : '',
  ].filter(Boolean).join('\n');
}

// ── Creation-time test (Part B) ─────────────────────────────────────
//
// A REAL smoke test at creation: execute the workflow's READ-ONLY steps for
// real (in dependency order, forEach capped to the first item) and confirm they
// return data; PREVIEW (never execute) anything mutating. Catches the
// acme-class failure — a scrape step that returns nothing — at creation,
// before the workflow is trusted, instead of at 7:30am. Reuses executeStepVerified
// (retry + contract verify) per step; leaves the normal run engine untouched.

export interface CreationTestStepResult {
  stepId: string;
  status: 'ok' | 'empty' | 'failed' | 'previewed' | 'error';
  detail?: string;
}
export interface CreationTestResult {
  pass: boolean;
  steps: CreationTestStepResult[];
}

/** Verdict for a read-only step's output: did it actually return data? */
export function creationTestVerdict(stepId: string, out: unknown): CreationTestStepResult {
  // A read-only step that returns NOTHING is a creation-test failure (the
  // acme mode — a scrape/fetch that silently came back empty): null, an
  // empty/whitespace string, an empty array, or an empty object.
  const empty =
    out == null
    || (typeof out === 'string' && out.trim().length === 0)
    || (Array.isArray(out) && out.length === 0)
    || (typeof out === 'object' && !Array.isArray(out) && Object.keys(out as Record<string, unknown>).length === 0);
  if (empty) return { stepId, status: 'empty', detail: 'returned no data' };
  // An EMPTY dominant list is also "no data" even when wrapped in an object —
  // `{records:[]}`, `{data:{records:[]}}` (reuses the 44→4 dominant-list finder).
  const dom = countDominantArray(out);
  if (dom && dom.count === 0) return { stepId, status: 'empty', detail: `returned 0 ${dom.key}` };
  // Reuse the engine's CANONICAL failure detector — the SAME one the
  // run-completion path uses (detectBlockedSteps) — so the creation-test
  // verdict can never drift from how a real run judges a step. It catches
  // blocked:true, a "blocked …" prose string (the Part A "block with a reason
  // if it can't return data" directive, however the step phrases it), ok:false
  // / error / *status failure-vocab, and per-item forEach failures.
  const blocked = detectBlockedSteps({ [stepId]: out });
  if (blocked.length > 0) return { stepId, status: 'failed', detail: blocked[0].reason.slice(0, 200) };
  // Trust-gate strictness (creation test ONLY, not the runtime path): a step
  // that buried a self-reported failure one level deep — e.g. it wrapped an
  // error envelope to satisfy a contract key (`{records:{ok:false,error:…}}`,
  // caught live by the smoke) — never returned real data. Recurse for it.
  const deep = deepSelfReportedFailure(out);
  if (deep) return { stepId, status: 'failed', detail: deep.slice(0, 200) };
  return { stepId, status: 'ok' };
}

export async function runCreationTest(
  workflow: WorkflowDefinition,
  workflowSlug: string,
  runId: string,
  inputs: Record<string, string>,
  assistant: ClementineAssistant,
): Promise<CreationTestResult> {
  const stepOutputs: Record<string, unknown> = {};
  const forEachFailures: Array<{ stepId: string; itemKey: string; error: string }> = [];
  const qualityAdvisories: WorkflowQualityAdvisory[] = [];
  const steps = workflow.steps;
  const results: CreationTestStepResult[] = [];
  const completed = new Set<string>();
  let guard = 0;
  while (completed.size < steps.length && guard++ < steps.length + 2) {
    const batch = planWorkflowExecutionBatches(steps, completed)[0] ?? [];
    if (batch.length === 0) break;
    for (const step of batch) {
      throwIfWorkflowRunCancelled(runId);
      if (stepLooksMutating(step)) {
        // Never execute a send/write while authoring — preview it. Downstream
        // read-only steps still get a stub so they can run.
        stepOutputs[step.id] = { previewed: true, reason: 'mutating step — previewed, not executed in the creation test' };
        results.push({ stepId: step.id, status: 'previewed' });
      } else {
        try {
          const out = await executeStepVerified(step, {
            workflow, workflowSlug, runId, inputs, stepOutputs,
            assistant, completedItems: new Map(), forEachFailures, qualityAdvisories,
            creationTest: true,
          });
          stepOutputs[step.id] = out;
          results.push(creationTestVerdict(step.id, out));
        } catch (err) {
          stepOutputs[step.id] = { blocked: true, reason: 'creation-test error' };
          results.push({ stepId: step.id, status: 'error', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
        }
      }
      completed.add(step.id);
    }
  }
  const pass = forEachFailures.length === 0
    && results.every((r) => r.status === 'ok' || r.status === 'previewed');
  return { pass, steps: results };
}

async function processOneRunFile(
  file: string,
  filePath: string,
  run: QueuedRunRecord,
  workflows: ReturnType<typeof listWorkflows>,
  assistant: ClementineAssistant,
): Promise<void> {
    const cancellationAtAdmission = readWorkflowRunCancellation(run.id);
    if (cancellationAtAdmission) {
      const current = readRunRecord(filePath) ?? run;
      writeRunRecord(filePath, {
        ...current,
        status: 'cancelled',
        cancelledAt: cancellationAtAdmission.requestedAt,
        finishedAt: current.finishedAt ?? cancellationAtAdmission.requestedAt,
        error: cancellationAtAdmission.reason,
      }, { workflowName: current.workflow, outcome: 'failed', detail: cancellationAtAdmission.reason });
      const cancelledRecord = readRunRecord(filePath);
      if (cancelledRecord && !cancelledRecord.notifiedAt) notifyCancelledRunOnce(filePath, cancelledRecord);
      return;
    }
    const workflow = workflows.find((entry) => entry.data.name === run.workflow);
    if (!workflow) {
      const message = `Workflow not found: "${run.workflow}". It may have been renamed or deleted.`;
      const report = { workflowName: run.workflow, outcome: 'failed' as const, detail: message };
      const terminalRecord = writeRunRecord(filePath, {
        ...run,
        status: 'error',
        error: message,
        finishedAt: new Date().toISOString(),
      }, report);
      if (!terminalPublicationMatches(filePath, terminalRecord, report)) return;
      startWorkflowActivityRun(run, run.workflow, `Starting workflow "${run.workflow}"`);
      // Reports-back: a run that can't even resolve its workflow must not
      // die silently (the user queued it and is waiting).
      addNotification({
        id: `workflow-${run.id}-not-found`,
        kind: 'workflow',
        title: `Workflow failed before start: ${run.workflow}`,
        body: `${message} Check the workflow name in Console → Workflows, then re-run.`,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { workflow: run.workflow, runId: run.id },
      });
      markRunNotified(filePath);
      finishWorkflowActivityRun(run.id, {
        status: 'failed',
        message: `Workflow failed before start: ${message}`,
        error: message,
      });
      recordAndAttemptWorkflowRunReportBack(filePath, {
        workflowName: run.workflow,
        outcome: 'failed',
        detail: message,
      });
      return;
    }
    // DRY-RUN: a safe, side-effect-free runnability preflight (the dashboard
    // DRY-RUN button + auto-smoke-test on promotion). Works on a DISABLED
    // draft (it's exactly what you dry-run), executes NOTHING, and reports a
    // per-issue "would this run?" verdict, then finalizes the record.
    if (run.status === 'dry_run') {
      // Provable dry-run: trace the whole plan side-effect-free and enumerate
      // every external write/send BEFORE anything runs. The verdict mirrors what
      // the queue would actually refuse (structural preflight + authoritative
      // readiness blockers); plain-tool/contract advisories inform, not block.
      const sim = simulateWorkflowDryRun(workflow.data, {
        workflowSlug: workflow.name,
        inputs: run.inputs ?? {},
      });
      const report = renderWorkflowDryRunSimulation(sim);
      const terminalReport = {
        workflowName: workflow.data.name,
        outcome: sim.runnable ? 'done' as const : 'blocked' as const,
        detail: report,
      };
      const terminalRecord = writeRunRecord(filePath, {
        ...run,
        status: 'dry_run',
        finishedAt: new Date().toISOString(),
        output: sim.summary,
      }, terminalReport);
      if (!terminalPublicationMatches(filePath, terminalRecord, terminalReport)) return;
      startWorkflowActivityRun(run, workflow.data.name, `Dry-running workflow "${workflow.data.name}"`);
      addNotification({
        id: `workflow-${run.id}-dryrun`,
        kind: 'workflow',
        title: sim.runnable ? `Dry-run OK: ${workflow.data.name}` : `Dry-run found blockers: ${workflow.data.name}`,
        body: report,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: {
          workflow: workflow.data.name,
          runId: run.id,
          dryRun: true,
          preflightOk: sim.runnable,
          verdict: sim.verdict,
          sendCount: sim.effects.sends.length,
          writeCount: sim.effects.writes.length,
        },
      });
      markRunNotified(filePath);
      finishWorkflowActivityRun(run.id, {
        status: 'completed',
        message: sim.runnable ? 'Workflow dry-run passed' : 'Workflow dry-run found blockers',
        outputPreview: report,
        needsAttention: !sim.runnable,
      });
      recordAndAttemptWorkflowRunReportBack(filePath, {
        workflowName: workflow.data.name,
        outcome: sim.runnable ? 'done' : 'blocked',
        detail: report,
      });
      return;
    }
    // CREATION TEST (Part B): really run the read-only steps + preview mutating,
    // confirm they return data, then AUTO-ENABLE on a clean pass (or leave the
    // draft disabled + report what to fix). Works on a disabled draft, so it
    // sits before the enabled gate.
    if (run.status === 'creation_test') {
      const ctInputs = normalizeWorkflowRunInputs({
        ...Object.fromEntries(Object.entries(workflow.data.inputs ?? {}).map(([k, meta]) => [k, meta.default ?? ''])),
        ...(run.inputs ?? {}),
      });
      let result: CreationTestResult;
      try {
        result = await runCreationTest(workflow.data, workflow.name, run.id, ctInputs, assistant);
      } catch (err) {
        result = { pass: false, steps: [{ stepId: '(run)', status: 'error', detail: err instanceof Error ? err.message : String(err) }] };
      }
      const lines = result.steps.map((s) => {
        const icon = s.status === 'ok' ? '✅' : s.status === 'previewed' ? '⏭️ previewed (mutating — not run)' : '⚠️';
        return `- ${s.stepId}: ${s.status === 'ok' ? '✅ returned data' : s.status === 'previewed' ? '⏭️ previewed (mutating step — not run)' : `${icon} ${s.status}${s.detail ? ` — ${s.detail}` : ''}`}`;
      });
      const body = result.pass
        ? `✅ Creation test passed for "${workflow.data.name}" — read-only steps returned real data. I've ENABLED it.\n\n${lines.join('\n')}\n\nMutating steps were previewed (not run). It'll run on its schedule / when you trigger it.`
        : `⚠️ Creation test for "${workflow.data.name}" found issues — left DISABLED so it won't run broken.\n\n${lines.join('\n')}\n\nFix the flagged step(s) with workflow_update (e.g. bind the right tool), then re-test. To run it as-is anyway: workflow_set_enabled.`;
      const report = {
        workflowName: workflow.data.name,
        outcome: result.pass ? 'done' as const : 'blocked' as const,
        detail: body,
      };
      const terminalRecord = writeRunRecord(
        filePath,
        { ...run, status: 'creation_test', finishedAt: new Date().toISOString(), output: result.pass ? 'creation test passed' : 'creation test found issues' },
        report,
      );
      if (!terminalPublicationMatches(filePath, terminalRecord, report)) return;
      startWorkflowActivityRun(run, workflow.data.name, `Creation-testing workflow "${workflow.data.name}"`);
      // Only the process that published this creation-test terminal may enable
      // the draft or clear its failure history. A cancellation/other terminal
      // winner leaves workflow state untouched.
      if (result.pass) {
        try { writeWorkflowAndSyncTriggers(workflow.name, { ...workflow.data, enabled: true }); } catch { /* best-effort */ }
        try { clearWorkflowFailures(workflow.name); } catch { /* best-effort */ }
      }
      addNotification({
        id: `workflow-${run.id}-creationtest`,
        kind: 'workflow',
        title: result.pass ? `Workflow ready: ${workflow.data.name}` : `Workflow needs a fix: ${workflow.data.name}`,
        body,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { workflow: workflow.data.name, runId: run.id, creationTest: true, pass: result.pass },
      });
      markRunNotified(filePath);
      finishWorkflowActivityRun(run.id, {
        status: 'completed',
        message: result.pass ? 'Workflow creation test passed' : 'Workflow creation test found issues',
        outputPreview: body,
        needsAttention: !result.pass,
      });
      recordAndAttemptWorkflowRunReportBack(filePath, {
        workflowName: workflow.data.name,
        outcome: result.pass ? 'done' : 'blocked',
        detail: body,
      });
      return;
    }
    // TRY (single-step) runs bypass the workflow enabled gate — they're
    // explicit dashboard actions on a draft. Full runs still require
    // the workflow to be approved.
    if (!run.targetStepId && !workflow.data.enabled) {
      const message = `Workflow "${workflow.data.name}" is disabled — approve/enable it before it can run.`;
      const report = { workflowName: workflow.data.name, outcome: 'failed' as const, detail: message };
      const terminalRecord = writeRunRecord(filePath, {
        ...run,
        status: 'error',
        error: message,
        finishedAt: new Date().toISOString(),
      }, report);
      if (!terminalPublicationMatches(filePath, terminalRecord, report)) return;
      startWorkflowActivityRun(run, workflow.data.name, `Starting workflow "${workflow.data.name}"`);
      appendWorkflowEvent(workflow.name, run.id, { kind: 'run_failed', error: message });
      addNotification({
        id: `workflow-${run.id}-disabled`,
        kind: 'workflow',
        title: `Workflow not run: ${workflow.data.name}`,
        body: `${message} Enable it in Console → Workflows, then re-run.`,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { workflow: workflow.data.name, runId: run.id },
      });
      markRunNotified(filePath);
      finishWorkflowActivityRun(run.id, {
        status: 'failed',
        message: `Workflow failed before start: ${message}`,
        error: message,
      });
      recordAndAttemptWorkflowRunReportBack(filePath, {
        workflowName: workflow.data.name,
        outcome: 'failed',
        detail: message,
      });
      return;
    }

    if (!run.targetStepId) {
      const prep = prepareWorkflowForWrite(workflow.data);
      if (prep.ok && prep.repairs.length > 0) {
        let repairAuthorized = false;
        withWorkflowRunRecordLock(filePath, () => {
          const authoritative = readWorkflowRunRecordUnlocked<QueuedRunRecord>(filePath);
          if (!authoritative || isTerminalRunRecord(authoritative)) return;
          repairAuthorized = true;
          workflow.data = prep.def;
          try { writeWorkflowAndSyncTriggers(workflow.name, prep.def); } catch { /* best-effort: run with repaired in-memory definition */ }
          try {
            appendWorkflowEvent(workflow.name, run.id, {
              kind: 'step_advisory',
              stepId: '(preflight)',
              meta: { reason: 'pre_run_auto_repair', repairs: prep.repairs.slice(0, 8) },
            });
          } catch { /* best-effort */ }
        });
        if (!repairAuthorized) return;
        logger.info({ workflow: workflow.data.name, runId: run.id, repairs: prep.repairs }, 'workflow pre-run auto-repair applied');
      }
      const preflight = preflightWorkflow(workflow.data, run.inputs ?? {});
      if (!preflight.ok) {
        const message = `Workflow "${workflow.data.name}" needs edits before it can run. ${preflight.summary}`;
        const report = { workflowName: workflow.data.name, outcome: 'blocked' as const, detail: message };
        const terminalRecord = writeRunRecord(filePath, {
          ...run,
          status: 'error',
          error: message,
          finishedAt: new Date().toISOString(),
        }, report);
        if (!terminalPublicationMatches(filePath, terminalRecord, report)) return;
        startWorkflowActivityRun(run, workflow.data.name, `Starting workflow "${workflow.data.name}"`);
        appendWorkflowEvent(workflow.name, run.id, {
          kind: 'run_failed',
          error: message,
          meta: { preflightErrors: preflight.errors.slice(0, 8), editAdvisories: preflight.editAdvisories.slice(0, 8) },
        });
        addNotification({
          id: `workflow-${run.id}-preflight`,
          kind: 'workflow',
          title: `Workflow needs edits: ${workflow.data.name}`,
          body: renderPreflightReport(workflow.data.name, preflight),
          createdAt: new Date().toISOString(),
          read: false,
          metadata: { workflow: workflow.data.name, runId: run.id, status: 'error', preflight: true },
        });
        markRunNotified(filePath);
        finishWorkflowActivityRun(run.id, {
          status: 'failed',
          message,
          error: preflight.errors.join('\n'),
        });
        recordAndAttemptWorkflowRunReportBack(filePath, {
          workflowName: workflow.data.name,
          outcome: 'blocked',
          detail: message,
        });
        logger.warn(
          { workflow: workflow.data.name, runId: run.id, errors: preflight.errors },
          'Workflow run rejected before start: preflight failed',
        );
        return;
      }
      if (preflight.editAdvisories.length > 0) {
        try {
          appendWorkflowEvent(workflow.name, run.id, {
            kind: 'step_advisory',
            stepId: '(preflight)',
            meta: {
              reason: 'workflow_edit_recommended',
              editAdvisories: preflight.editAdvisories.slice(0, 8),
            },
          });
        } catch { /* best-effort */ }
        logger.info(
          { workflow: workflow.data.name, runId: run.id, editAdvisories: preflight.editAdvisories },
          'workflow preflight recommends edits before unattended reliance',
        );
      }
    }

    const inputs: Record<string, string> = normalizeWorkflowRunInputs({
      ...Object.fromEntries(Object.entries(workflow.data.inputs ?? {}).map(([key, meta]) => [key, meta.default ?? ''])),
      ...(run.inputs ?? {}),
    });
    const missingInputs = missingWorkflowRunInputs(workflow.data, inputs);
    if (missingInputs.length > 0) {
      const message = `Missing required workflow input${missingInputs.length === 1 ? '' : 's'}: ${missingInputs.join(', ')}`;
      const report = { workflowName: workflow.data.name, outcome: 'failed' as const, detail: message };
      const terminalRecord = writeRunRecord(filePath, {
        ...run,
        inputs,
        status: 'error',
        error: message,
        finishedAt: new Date().toISOString(),
      }, report);
      if (!terminalPublicationMatches(filePath, terminalRecord, report)) return;
      startWorkflowActivityRun(run, workflow.data.name, `Starting workflow "${workflow.data.name}"`);
      appendWorkflowEvent(workflow.name, run.id, { kind: 'run_failed', error: message });
      addNotification({
        id: `workflow-${run.id}-missing-inputs`,
        kind: 'workflow',
        title: `Workflow failed before start: ${workflow.data.name}`,
        body: `${message}. Re-run the workflow with the missing input values.`,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { workflow: workflow.data.name, runId: run.id, status: 'error' },
      });
      markRunNotified(filePath);
      finishWorkflowActivityRun(run.id, {
        status: 'failed',
        message: `Workflow failed before start: ${message}`,
        error: message,
      });
      recordAndAttemptWorkflowRunReportBack(filePath, {
        workflowName: workflow.data.name,
        outcome: 'failed',
        detail: message,
      });
      logger.warn({ workflow: workflow.data.name, runId: run.id, missingInputs }, 'Workflow run rejected before start: missing required inputs');
      return;
    }

    const isResume = run.status === 'running';
    const runningRecord = writeRunRecord(filePath, {
      ...run,
      status: 'running',
      startedAt: run.startedAt ?? new Date().toISOString(),
    }, undefined, buildWorkflowMutationContractSnapshot(workflow.data.steps)).record;
    if (isTerminalRunRecord(runningRecord)) {
      const cancelledRecord = readRunRecord(filePath);
      if (cancelledRecord?.status === 'cancelled' && !cancelledRecord.notifiedAt) {
        notifyCancelledRunOnce(filePath, cancelledRecord);
      }
      return;
    }
    appendWorkflowEvent(workflow.name, run.id, {
      kind: isResume ? 'run_resumed' : 'run_started',
      meta: { inputs, source: run.source, targetStepId: run.targetStepId ?? null },
    });
    if (!isResume) {
      try {
        const graph = compileWorkflowStepsToGraph(workflow.data.steps, {
          id: `${workflow.name}:${run.id}`,
          name: workflow.data.name,
          metadata: { workflowSlug: workflow.name, runId: run.id },
        });
        persistWorkflowGraphSnapshot({
          workflowName: workflow.name,
          runId: run.id,
          graph,
        });
        appendWorkflowEvent(workflow.name, run.id, {
          kind: 'workflow_graph_created',
          meta: {
            graph: {
              name: graph.name,
              entryNodeIds: graph.entryNodeIds,
              nodes: graph.nodes.map((node) => ({
                id: node.id,
                type: node.type,
                stepId: node.stepId,
                model: node.model,
                intent: node.intent,
                forEach: node.forEach,
                sideEffect: node.sideEffect,
                usesSkill: node.usesSkill,
                requiresApproval: node.requiresApproval,
                deterministic: Boolean(node.deterministic),
              })),
              edges: graph.edges,
            },
          },
        });
      } catch {
        // Best-effort telemetry only; graph snapshot failure must never block a run.
      }
    }
    // Reports-back: surface this workflow run in the unified Activity feed
    // (run-events / listRuns) so it shows alongside chat + background tasks,
    // not only on the Workflows page. startRun upserts (id = run.id), so any
    // trigger source (chat, scheduler, dashboard, API) lands here.
    startWorkflowActivityRun(
      run,
      workflow.data.name,
      `${isResume ? 'Resuming' : 'Running'} workflow "${workflow.data.name}"${run.targetStepId ? ` · step ${run.targetStepId}` : ''}`,
    );

    const stopHeartbeat = startWorkflowHeartbeat(workflow.data.name, run.id, Date.now());
    try {
      if (run.retryFailedItemsFromRunId && run.retryFailedItemsStepId && Array.isArray(run.retryFailedItemKeys)) {
        seedFailedItemRetryRun(workflow.data, workflow.name, run.id, {
          fromRunId: run.retryFailedItemsFromRunId,
          stepId: run.retryFailedItemsStepId,
          itemKeys: run.retryFailedItemKeys,
        });
      }
      const { finalOutput, forEachFailures, qualityAdvisories } = await executeWorkflow(
        workflow.data,
        workflow.name,
        run.id,
        inputs,
        assistant,
        run.targetStepId,
        run.goalFeedback,
        run.originSessionId,
        isResume,
        runningRecord.mutationReceiptProtocolVersion,
        runningRecord.mutationContractSnapshot,
      );
      throwIfWorkflowRunCancelled(run.id);
      const resume = computeResumeState(workflow.name, run.id);
      const rawStepOutputs = Object.fromEntries(resume.completedSteps);
      const stepOutputs = stringifyOutputs(rawStepOutputs);

      // Self-heal: a step that returned {blocked:true} ran cleanly but
      // could not finish its job. Today that still marks "completed" and
      // dumps raw JSON. Detect it, diagnose the root cause, and offer a
      // fix — instead of silently reporting a misleading success.
      const blockedSteps = detectBlockedSteps(stepOutputs, workflow.data.steps.map((s) => s.id));

      // Wave 2.1 (substance gap): a read step that produced NO data while a
      // downstream step depends on it — the canonical "forEach over an empty
      // upstream does nothing" shape. This is INFORM-ONLY: a clean empty result
      // is usually a routine no-op (incremental "find NEW since last run" returns
      // [] on a quiet day; a genuine failure like an expired credential ERRORS or
      // BLOCKS and is already caught), so flipping needsAttention here would fire
      // false "needs attention" pings on quiet runs and pollute the failure ledger.
      // Instead we record a VISIBLE run-detail advisory event (no needsAttention,
      // no ping, no ledger impact) and fold the note into the structured run
      // summary below — so when a user asks "why did this run do nothing?", the
      // answer is on the record. Skipped for partial single-step re-runs. Uses the
      // RAW outputs (stepOutputs above is stringified → "[]"/"{}" read as non-empty).
      const emptyDeliverableReads = run.targetStepId
        ? []
        : (() => { try { return detectEmptyDeliverableReads(workflow.data.steps, rawStepOutputs); } catch { return []; } })();
      for (const er of emptyDeliverableReads) {
        try {
          appendWorkflowEvent(workflow.name, run.id, {
            kind: 'step_advisory',
            stepId: er.stepId,
            meta: { reason: 'empty_deliverable_read', consumer: er.consumerId, shape: er.shape },
          });
        } catch { /* journal note is best-effort */ }
      }

      // Workflow-level "did we reach the target?" judge (fail-open,
      // conservative, DETECTION-ONLY, ADVISORY). A background workflow is only
      // valuable if its final deliverable is exactly what the user needs — so
      // audit the deliverable against the workflow's declared target + this
      // run's inputs. A CONFIDENT miss records a NON-FAILING quality advisory
      // that rides along with the delivered output: the run still completes and
      // DELIVERS its result, but honestly flags "couldn't confirm the target."
      // It NEVER fails the run, NEVER hides the deliverable, and NEVER re-runs
      // the workflow (a blind re-run could double irreversible side effects) —
      // so a confident-but-wrong verdict can never break a workflow that
      // actually succeeded. Skipped for partial single-step re-runs and runs
      // with no deliverable; fully fail-open.
      const baseSuccessBody = renderSuccessBody({
        steps: workflow.data.steps,
        stepOutputs,
        finalOutput,
        hasSynthesis: Boolean(workflow.data.synthesis?.prompt) && !run.targetStepId,
      });
      // A declared pinned goal REPLACES the fuzzy target judge for this run:
      // the parked criteria are stricter and produce per-criterion evidence,
      // so double-judging would only burn a second model call.
      const declaredRunGoal = workflowRunGoal(workflow.data);
      const legacyRunGoal = declaredRunGoal ? null : deriveLegacyWorkflowRunGoal(workflow.data, inputs);
      let targetVerdict: WorkflowTargetVerdict | null = null;
      if (!declaredRunGoal) {
        try {
          targetVerdict = await judgeWorkflowTarget({
            workflow: workflow.data,
            inputs,
            finalOutput,
            goal: legacyRunGoal ?? undefined,
            fallbackBody: baseSuccessBody,
            isPartialRun: Boolean(run.targetStepId),
          });
        } catch { /* fail-open: a target-judge error never affects a completed run */ }
        // Verdict door (T3-B4): one canonical audit row per judge decision —
        // recorded only when the judge actually evaluated (skips are not verdicts).
        if (targetVerdict?.judged) {
          appendWorkflowEvent(workflow.name, run.id, {
            kind: 'verdict_recorded',
            meta: { door: 'workflow_target', pass: targetVerdict.reached, reason: targetVerdict.gap.slice(0, 400) },
          });
        }
        if (targetVerdict && targetVerdict.judged && !targetVerdict.reached) {
          qualityAdvisories.push({
            stepId: '(workflow target)',
            kind: 'target_missed',
            note: `couldn't confirm this run reached the workflow's inferred legacy goal: ${targetVerdict.gap}`,
          });
          logger.info(
            {
              workflow: workflow.data.name,
              runId: run.id,
              gap: targetVerdict.gap,
              legacyGoal: legacyRunGoal
                ? { objective: legacyRunGoal.objective.slice(0, 240), criteria: legacyRunGoal.successCriteria.length }
                : null,
            },
            'Legacy workflow target check flagged a possible miss — surfacing as a non-failing advisory',
          );
        }
      }

      // ── Pinned run goal: validate EXTERNALLY, then decide. Skipped for
      // partial TRY runs (no full deliverable) and runs with blocked steps
      // (those route to diagnosis/self-heal first — validating a half-run
      // would always fail and burn a re-pursuit attempt for nothing).
      const runGoalContractEnabled = (getRuntimeEnv('CLEMMY_GOAL_CONTRACT', 'on') ?? 'on').toLowerCase() !== 'off';
      const runGoal = runGoalContractEnabled && declaredRunGoal && !run.targetStepId && blockedSteps.length === 0 ? declaredRunGoal : null;
      let goalVerdict: GoalValidationResult | null = null;
      let goalDecision: GoalRunDecision | null = null;
      let goalFeedbackNext = '';
      let goalRequeueId: string | undefined;
      if (runGoal) {
        goalVerdict = await validateGoal({
          objective: runGoal.objective,
          successCriteria: runGoal.successCriteria,
          evidenceText: buildGoalEvidenceText(finalOutput, rawStepOutputs, { workflowName: workflow.name, runId: run.id }),
        });
        // Verdict door (T3-B4): one canonical audit row per judge decision.
        appendWorkflowEvent(workflow.name, run.id, {
          kind: 'verdict_recorded',
          meta: {
            door: 'goal_validation',
            pass: goalVerdict.pass,
            reason: (goalVerdict.advice ?? (goalVerdict.pass ? 'all criteria met' : '')).slice(0, 400),
            failedOpen: goalVerdict.judgeFailedOpen ?? false,
            criteriaMet: goalVerdict.criteriaMet ?? null,
            criteriaTotal: goalVerdict.criteriaTotal ?? null,
          },
        });
        goalFeedbackNext = renderGoalFeedback(goalVerdict);
        // Auto-checker: reuse the verdict just computed (no second judge call)
        // and persist it to the shared workspace so the run window ALWAYS shows
        // the checker's read on this run — no click needed. Best-effort.
        try {
          writeWorkspaceCheckerReport(
            workflow.name, run.id,
            checkerReportFromVerdict(run.id, goalVerdict, Object.keys(stepOutputs), new Date().toISOString()),
          );
        } catch { /* best-effort — checker persistence never affects the run */ }
        // Contract row (plan-proposals, origin kind 'workflow'): the pinned
        // goal's external home — attempt lineage + per-criterion evidence
        // accumulate across re-pursuit runs, visible to /goal status. Pure
        // bookkeeping: a store hiccup never affects the run.
        let goalContractId: string | null = null;
        try {
          const contract = ensureWorkflowRunGoal({
            workflowName: workflow.data.name,
            runId: run.id,
            objective: runGoal.objective,
            successCriteria: runGoal.successCriteria,
            maxAttempts: runGoal.maxAttempts,
          });
          if (contract) {
            goalContractId = contract.id;
            recordGoalValidation(contract.id, toGoalEvidence(goalVerdict, (run.goalAttempt ?? 0) + 1, new Date().toISOString()));
          }
        } catch { /* contract bookkeeping is best-effort */ }
        // STATE pillar (run-scope sibling of step loopUntil): when a pinned-goal
        // run misses, record a comparable run-level attempt — what was unmet, the
        // numeric score, and what the whole attempt cost (via the S2 runId join) —
        // so re-pursuits are reviewable as a series, not just "it re-ran". Gated +
        // best-effort: a bookkeeping error never perturbs the run.
        if (!goalVerdict.pass && attemptRecordsEnabled()) {
          try {
            const attemptIndex = (run.goalAttempt ?? 0) + 1;
            const unmet = goalVerdict.perCriterion.filter((c) => !c.pass).map((c) => c.criterion);
            appendWorkflowEvent(workflow.name, run.id, {
              kind: 'attempt_record',
              attempt: {
                attemptIndex,
                maxAttempts: runGoal.maxAttempts,
                failedProblems: unmet.slice(0, 6),
                changeSummary: `run attempt ${attemptIndex}: ${goalVerdict.successRatePercent ?? 0}% (${goalVerdict.criteriaMet ?? 0}/${goalVerdict.criteriaTotal ?? unmet.length} criteria met)`,
                metrics: { tokens: sumUsageTokensForRun(run.id) },
              },
            });
          } catch { /* attempt record is best-effort */ }
        }
        goalDecision = decideGoalRunOutcome({
          verdict: goalVerdict,
          maxAttempts: runGoal.maxAttempts,
          priorRepursuits: run.goalAttempt ?? 0,
          unsafeStepId: runUnsafeToRepursue(workflow.data.steps, new Set(resume.completedSteps.keys())),
          chronicallyFailing: shouldStopAutoHeal(workflow.name),
        });
        if (goalDecision.action === 'repursue') {
          // ONLY a fresh 'queued' run counts as a re-pursuit. A 'duplicate'
          // (an identical run already queued — e.g. the next scheduled fire)
          // carries NO goalAttempt lineage and NO feedback, so treating it as
          // success would reset the attempt ceiling every cycle and lie to
          // the user about "re-running with feedback". Exception-safe: a
          // queue-write error must never turn this COMPLETED run into an
          // error-path run.
          let requeued: ReturnType<typeof requeueWorkflowFromRun> | null = null;
          try {
            throwIfWorkflowRunCancelled(run.id);
            requeued = requeueWorkflowFromRun(run.id, {
              originSessionIds: workflowRunOriginSessionIds(run),
              goalAttempt: (run.goalAttempt ?? 0) + 1,
              goalFeedback: goalFeedbackNext,
              sourceExecutionSettled: true,
            });
          } catch { requeued = null; }
          if (requeued?.status === 'queued') {
            goalRequeueId = requeued.id;
          } else {
            goalDecision = {
              action: 'escalate',
              reason: requeued?.status === 'duplicate'
                ? 'goal unmet, and an identical run is already queued — could not queue a feedback-carrying re-pursuit (the queued run will validate the goal again on its own)'
                : requeued?.status === 'blocked_readiness'
                  ? `goal unmet and the automatic re-run was blocked by workflow readiness: ${requeued.message}`
                  : 'goal unmet and the automatic re-run could not be queued — re-run manually',
            };
          }
        }
        if (goalDecision.action === 'advisory') {
          qualityAdvisories.push({ stepId: '(run goal)', kind: 'goal_validation_unavailable', note: goalDecision.reason });
        }
        try {
          if (goalContractId && goalDecision.action === 'satisfied') satisfyGoal(goalContractId, 'external validation passed');
          if (goalContractId && goalDecision.action === 'escalate') expireGoal(goalContractId, goalDecision.reason);
        } catch { /* best-effort */ }
	        try {
	          appendWorkflowEvent(workflow.name, run.id, {
	            kind: 'step_advisory',
	            stepId: '(run goal)',
	            meta: {
	              goal: goalDecision.action,
	              reason: goalDecision.reason,
	              attempt: (run.goalAttempt ?? 0) + 1,
	              max: runGoal.maxAttempts,
	              successRatePercent: goalVerdict.successRatePercent,
	              criteriaMet: goalVerdict.criteriaMet,
	              criteriaTotal: goalVerdict.criteriaTotal,
	              judgeFailedOpen: goalVerdict.judgeFailedOpen === true,
	              failedCriteria: goalVerdict.perCriterion.filter((criterion) => !criterion.pass).map((criterion) => criterion.criterion).slice(0, 6),
	              ...(goalRequeueId ? { requeueRunId: goalRequeueId } : {}),
	              ...(goalFeedbackNext ? { feedbackPreview: goalFeedbackNext.slice(0, 800) } : {}),
	            },
	          });
	        } catch { /* journal note is best-effort — a re-pursuit may already be queued, so this run must reach its terminal record write */ }
        logger.info(
          { workflow: workflow.data.name, runId: run.id, goal: goalDecision.action, reason: goalDecision.reason },
          'pinned run goal validated',
        );
      }
      const goalMissed = goalDecision?.action === 'escalate';
      const goalRepursuing = goalDecision?.action === 'repursue';

      // Only GENUINE blocks (explicit {blocked:true} / prose) are routed to the
      // Doctor — its remedies (rewrite the prompt, reconnect a service, fix an
      // input) presume a prompt/connection/input cause. A step that RAN but
      // self-reported a failure (validationStatus:"fail", ok:false — usually
      // missing data or an unprovisioned provider) is a real outcome, not a bad
      // prompt; diagnosing it would auto-propose a bogus prompt rewrite. Such
      // steps still mark the run needs-attention (reports-back), just without a
      // fix offer.
      const diagnosableBlocks = blockedSteps.filter((b) => b.kind === 'blocked');
      let diagnosis: WorkflowDiagnosis | null = null;
      let proposedFix: ProposedFix | null = null;
      if (diagnosableBlocks.length > 0 && selfHealEnabled()) {
        // RSH-5 (fix memory): if a fix PROVABLY resolved this same failure
        // signature before, hand it to the Doctor as a strong hint.
        let priorFix: { fixKind: string; fixDescription: string; fixJson?: string } | undefined;
        try {
          const root = diagnosableBlocks[0];
          const remembered = root
            ? recallConfirmedFix(workflow.name, root.stepId, fixSignature(root.reason))
            : null;
          if (remembered) priorFix = { fixKind: remembered.fixKind, fixDescription: remembered.fixDescription, fixJson: JSON.stringify(remembered.fix) };
        } catch { /* recall is best-effort */ }
        diagnosis = await diagnoseWorkflowBlock({
          workflow: workflow.data,
          blockedSteps: diagnosableBlocks,
          // The step's blocked reason usually carries the real tool error.
          toolErrors: diagnosableBlocks.map((b) => b.reason),
          // RSH-4: upstream reads that produced nothing but feed a downstream
          // step — so the Doctor can re-root a symptom block onto its real cause.
          upstreamEmptyProducers: detectEmptyDeliverableReads(workflow.data.steps, rawStepOutputs),
          priorFix,
        });
        if (diagnosis) {
          proposedFix = recordProposedFix(workflow.name, run.id, diagnosis);
        }
      }
      // Confident/review-required quality misses are promoted from silent
      // advisories to NON-BLOCKING needs-attention: the run still completed and
      // DELIVERS its output, but it is flagged for review instead of reported
      // as clean success. These have no diagnosable block, so they never route
      // to the Doctor; and tryAutoHealAndRequeue requires a proposedFix — so a
      // quality miss can NEVER trigger a blind re-run that doubles irreversible
      // side effects.
      const targetMissed = Boolean(targetVerdict && targetVerdict.judged && !targetVerdict.reached);
      const hasForEachFailures = forEachFailures.length > 0;
      const reviewRequiredAdvisory = qualityAdvisories.find(workflowAdvisoryRequiresAttention);
      const needsAttention = blockedSteps.length > 0 || targetMissed || hasForEachFailures || goalMissed || Boolean(reviewRequiredAdvisory);
      const attentionReason =
        blockedSteps[0]?.reason ??
        (hasForEachFailures
          ? `${forEachFailures.length} forEach item${forEachFailures.length === 1 ? '' : 's'} failed`
          : goalMissed
          ? `pinned goal not met — ${goalDecision?.reason ?? 'criteria unmet'}`
          : targetMissed
          ? `target not confirmed: ${targetVerdict?.gap ?? 'deliverable may not reach the workflow target'}`
          : reviewRequiredAdvisory
          ? reviewRequiredAdvisory.note
          : undefined);

      // Cross-fire failure ledger (#6): record this run's outcome so a
      // chronically-failing workflow stops auto-healing + escalates. A clean
      // run resets the streak. (Heal re-runs count too — a fire whose heals all
      // fail is genuinely stuck, and escalating then is correct. A goal-unmet
      // re-pursuit counts as a FAILURE so a workflow whose goal never passes
      // trips the chronic-failure breaker instead of burning attempts forever.)
      // Terminal-derived ledgers, learned patterns, and contract tightening are
      // authorized only by the worker that actually publishes terminal truth.
      // Compute the breaker preview without mutating it so report copy remains
      // deterministic before publication.
      const prospectiveConsecutiveFailures = !needsAttention && !goalRepursuing
        ? 0
        : getConsecutiveFailures(workflow.name) + 1;
      const recordPublishedOutcomeLearning = (): void => {
        recordWorkflowOutcome(
          workflow.name,
          !needsAttention && !goalRepursuing,
          needsAttention ? attentionReason : goalRepursuing ? 'pinned goal unmet — re-pursuing' : undefined,
        );
        if (!needsAttention && !goalRepursuing) {
          if ((run.selfHealAttempt ?? 0) > 0) {
            try { confirmPendingFix(run.id, new Date().toISOString()); } catch { /* best-effort */ }
          }
          void (async () => {
            try {
              const { distillSkillFromSessions } = await import('../memory/skill-distiller.js');
              const stepSessionIds = (workflow.data.steps ?? []).map((s) => `workflow:${run.id}:${s.id}`);
              await distillSkillFromSessions(stepSessionIds, {
                objective: workflow.data.description || workflow.data.name,
                evidence: typeof finalOutput === 'string' ? finalOutput : undefined,
                sourceId: run.id,
              });
            } catch { /* distillation never affects the run */ }
          })();
          if (!run.targetStepId) {
            try {
              recordSuccessfulWorkflowPattern({
                workflow: workflow.data,
                workflowSlug: workflow.name,
                runId: run.id,
                finalOutput,
              });
            } catch { /* pattern learning never affects the run */ }
            try {
              tightenWorkflowContractsFromCleanRun(workflow.name, workflow.data, stepOutputs, run.id);
            } catch (err) {
              logger.warn({ workflow: workflow.name, err: err instanceof Error ? err.message : String(err) }, 'clean-run contract tightening skipped');
            }
          }
        } else if (needsAttention && !run.targetStepId) {
          try { recordFailedWorkflowPattern({ workflow: workflow.data, workflowSlug: workflow.name }); } catch { /* best-effort */ }
        }
      };
      const autoHealPaused = needsAttention && prospectiveConsecutiveFailures >= escalateThreshold();
      const escalationBanner = autoHealPaused
        ? `⚠️ "${workflow.data.name}" has failed ${prospectiveConsecutiveFailures} runs in a row — auto-heal is PAUSED to stop wasting tokens. Review the blocked step(s) below; if a recent auto-fix caused this, revert it with \`revert heal <id>\`. It resumes automatically after one clean run, and (for a scheduled workflow) consider disabling it until fixed.\n\n`
        : '';

      throwIfWorkflowRunCancelled(run.id);
      const terminalProjection: QueuedRunRecord = {
        ...run,
        status: hasForEachFailures ? 'completed_with_errors' : 'completed',
        finishedAt: new Date().toISOString(),
        stepOutputs,
        output: finalOutput,
        ...(needsAttention
          ? { needsAttention: true, blockedSteps, proposedFixId: proposedFix?.id ?? null }
          : {}),
        ...(goalDecision ? { goalOutcome: goalDecision.action, goalReason: goalDecision.reason } : {}),
      };

      // Pinned-goal re-pursuit: the run completed mechanically but its goal is
      // unmet and a FRESH attempt is already queued (with the validation
      // evidence folded into its step prompts). Mirror self-heal's
      // report-and-stop: this run is terminal; the fresh run reports its own
      // outcome and re-enters the origin chat via the carried originSessionId.
      if (goalRepursuing) {
        const attemptNowRunning = (run.goalAttempt ?? 0) + 2;
        const goalRetryMsg =
          `🎯 "${workflow.data.name}" finished but its pinned goal isn't met yet:\n${goalFeedbackNext}\n\n`
          + `Re-running with this feedback — attempt ${attemptNowRunning} of ${runGoal?.maxAttempts ?? attemptNowRunning}`
          + `${goalRequeueId ? ` (run ${goalRequeueId})` : ''}. It will report back when it finishes.`;
        const report = { workflowName: workflow.data.name, outcome: 'blocked' as const, detail: goalRetryMsg };
        const terminalRecord = writeRunRecord(filePath, terminalProjection, report);
        if (!terminalPublicationMatches(filePath, terminalRecord, report)) return;
        appendWorkflowEvent(workflow.name, run.id, { kind: 'run_completed' });
        recordPublishedOutcomeLearning();
        attemptWorkflowRunReportBack(filePath);
        addNotification({
          id: `workflow-${run.id}-goalretry`,
          kind: 'workflow',
          title: `Goal re-pursuit: ${workflow.data.name}`,
          body: goalRetryMsg,
          createdAt: new Date().toISOString(),
          read: false,
          metadata: { workflow: workflow.data.name, runId: run.id, goalRepursuit: true, attempt: attemptNowRunning },
        });
        markRunNotified(filePath);
        try {
          finishRun(run.id, {
            status: 'completed',
            message: `Pinned goal unmet — re-pursuing (attempt ${attemptNowRunning}/${runGoal?.maxAttempts ?? attemptNowRunning})`,
            outputPreview: goalRetryMsg.slice(0, 800),
          });
        } catch { /* best-effort */ }
        logger.info(
          { workflow: workflow.data.name, runId: run.id, newRunId: goalRequeueId, attempt: attemptNowRunning },
          'pinned goal unmet — re-pursuit queued',
        );
        return;
      }

      // Bounded autonomous self-heal: a step blocked with an auto-applicable
      // prompt-rewrite fix → apply it and re-run automatically (bounded +
      // side-effect-guarded). When it fires, report the heal + re-run and STOP
      // here: the original run is terminal (above), and the FRESH re-run reports
      // its own outcome (and re-enters the origin chat via carried origin). We
      // skip the normal needs-attention notification/offer to avoid double-msging.
      if (needsAttention) {
        // T3.2 (auto-revert): this run IS a healed re-run and it STILL needs
        // attention — the auto-applied fix didn't stick. Restore the pre-heal
        // definition instead of leaving a bad rewrite in place (or stacking
        // another rewrite on top of it), and skip a fresh auto-heal this
        // cycle; the chronic-failure ledger still counts the failure.
        let healReverted = false;
        if ((run.selfHealAttempt ?? 0) > 0 && run.selfHealBackupId) {
          try {
            const reverted = revertWorkflowFix(run.selfHealBackupId);
            healReverted = reverted.ok;
            if (reverted.ok) {
              appendWorkflowEvent(workflow.name, run.id, {
                kind: 'step_advisory',
                stepId: blockedSteps[0]?.stepId ?? 'run',
                meta: { reason: 'self_heal_reverted', backupId: run.selfHealBackupId },
              });
              logger.info(
                { workflow: workflow.name, runId: run.id, backupId: run.selfHealBackupId },
                'self-heal: healed re-run still failed — auto-reverted the fix to the pre-heal definition',
              );
              // RSH-5: the fix did NOT stick — forget the unproven pending memory.
              try { discardPendingFix(run.id); } catch { /* best-effort */ }
            }
          } catch (err) {
            logger.warn({ runId: run.id, err: err instanceof Error ? err.message : String(err) }, 'self-heal auto-revert failed (backup may already be gone)');
          }
        }
        const healed = (healReverted || autoHealPaused) ? null : await tryAutoHealAndRequeue({
          run,
          workflowSlug: workflow.name,
          steps: workflow.data.steps,
          diagnosis,
          proposedFix,
          completedStepIds: new Set(resume.completedSteps.keys()),
          rawStepOutputs, // RSH-2: probe a contract fix against real output before re-running
        });
        if (healed) {
          const report = { workflowName: workflow.data.name, outcome: 'blocked' as const, detail: healed.message };
          const terminalRecord = writeRunRecord(filePath, terminalProjection, report);
          if (!terminalPublicationMatches(filePath, terminalRecord, report)) return;
          appendWorkflowEvent(workflow.name, run.id, { kind: 'run_completed' });
          recordPublishedOutcomeLearning();
          attemptWorkflowRunReportBack(filePath);
          addNotification({
            id: `workflow-${run.id}-selfheal`,
            kind: 'workflow',
            title: `Auto-healing workflow: ${workflow.data.name}`,
            body: `🔧 ${healed.message}`,
            createdAt: new Date().toISOString(),
            read: false,
            metadata: { workflow: workflow.data.name, runId: run.id, selfHeal: true, attempt: healed.attempt },
          });
          markRunNotified(filePath);
          try {
            finishRun(run.id, {
              status: 'completed',
              message: `Auto-healing — re-running (attempt ${healed.attempt}/${healed.max})`,
              outputPreview: healed.message.slice(0, 800),
            });
          } catch { /* best-effort */ }
          // Gap E: also tell the origin chat in-context that we're healing +
          // re-running (the fresh run carries originSessionId and will report its
          // own final outcome). No-op for scheduled/cron runs.
          logger.info({ workflow: workflow.data.name, runId: run.id, attempt: healed.attempt }, 'Workflow run auto-healed and re-queued');
          return;
        }
      }

      // Partial-success surfacing: if any forEach items errored, lift
      // them into the user-visible notification so a "completed" run
      // can't masquerade as all-green when items quietly dropped.
      const hasFailures = forEachFailures.length > 0;
      const failureSummary = hasFailures
        ? `\n\n⚠️ ${forEachFailures.length} item${forEachFailures.length === 1 ? '' : 's'} failed:\n${forEachFailures
            .slice(0, 5)
            .map((f) => `- ${f.stepId} · ${f.itemKey}: ${f.error.slice(0, 200)}`)
            .join('\n')}${forEachFailures.length > 5 ? `\n(+${forEachFailures.length - 5} more)` : ''}`
        : '';

      // Legible reporting: when steps blocked, say "needs attention" (not
      // "completed") and explain in plain language — with the diagnosis +
      // fix offer when self-heal produced one. Otherwise today's body.
      // Success body: human-readable (synthesis prose or humanized step
      // results), never a raw JSON dump of the step bookkeeping.
      // Pinned-goal verdict rides the body in both lanes: a satisfied goal is
      // a one-line confirmation; an escalated miss shows the per-criterion
      // evidence + what to do (the deliverable itself is never hidden).
      const goalSummary = goalDecision?.action === 'satisfied' && runGoal
        ? `\n\n🎯 Pinned goal validated — ${runGoal.successCriteria.length > 0 ? `all ${runGoal.successCriteria.length} criteria met` : 'objective met'}.`
        : goalMissed
          ? `\n\n🎯 PINNED GOAL NOT MET (${goalDecision?.reason ?? 'criteria unmet'}):\n${goalFeedbackNext || '(no per-criterion detail)'}\n\nThe run's output is above. Re-run the workflow once the gaps are addressed, or adjust the goal.`
          : '';
      // Wave 2.2 (structured run summary): emit "succeeded because X + artifacts
      // (files/URLs/counts)" at completion. The structured `run_summary` event is
      // a durable per-run record (persisted in events.jsonl for the run detail +
      // a future run-view consumer to render; it also carries the inform-only
      // empty-deliverable-read notes from 2.1). A concise "📦 Produced:" line is
      // appended to the human body ONLY when concrete artifacts exist — and a run
      // that produced artifacts is by definition NOT a routine no-op, so this can
      // never break the quiet-day no-op silencing.
      const runArtifacts = summarizeRunArtifacts(workflow.data.steps, rawStepOutputs);
      const succeededBecause = (runGoal && goalDecision?.action === 'satisfied')
        ? `goal met${typeof goalVerdict?.successRatePercent === 'number' ? ` (${goalVerdict.successRatePercent}%, ${goalVerdict.criteriaMet ?? '?'}/${goalVerdict.criteriaTotal ?? '?'} criteria)` : ''}`
        : (targetVerdict?.judged && targetVerdict.reached)
          ? 'reached the workflow target'
          : `completed ${workflow.data.steps.length} step${workflow.data.steps.length === 1 ? '' : 's'}`;
      const producedItems = [
        runArtifacts.counts.length ? runArtifacts.counts.join(', ') : '',
        ...runArtifacts.files,
        ...runArtifacts.urls,
      ].filter(Boolean);
      const producedLine = producedItems.length > 0 ? `\n\n📦 Produced: ${producedItems.join(' · ')}` : '';
      const successBody = `${baseSuccessBody}${producedLine}${failureSummary}${goalSummary}`;
      // Non-failing quality advisories (skill-execution misses + target-miss):
      // appended to whichever body we send so the deliverable is ALWAYS shown,
      // with a clear "review this" heads-up after it. Never replaces the body.
      const hasAdvisories = qualityAdvisories.length > 0;
      const advisorySummary = hasAdvisories
        ? `\n\n⚠️ Quality check (the result above is delivered — please review):\n${qualityAdvisories
            .slice(0, 5)
            .map((a) => `- ${a.note}`)
            .join('\n')}${qualityAdvisories.length > 5 ? `\n(+${qualityAdvisories.length - 5} more)` : ''}`
        : '';
      const outcome = renderLegibleOutcome({
        workflowName: workflow.data.name,
        blockedSteps,
        diagnosis,
        fixId: proposedFix?.id ?? null,
        fallbackBody: successBody,
      });
      // A self-notifying workflow (a step called notify_user) would otherwise
      // double-post to Discord: once from the step, once from this runner
      // completion. When the run SUCCEEDED and a step already surfaced a
      // user-facing notification for THIS run, make the runner's completion
      // dashboard-only (silent) to avoid the duplicate. A needs-attention run
      // ALWAYS delivers — reports-back must never be silenced.
      const stepAlreadyNotified = shouldSilenceCompletionEcho({
        needsAttention,
        runId: run.id,
        notifications: loadNotifications(),
      });
      // Single report body (escalation banner prepended when auto-heal is
      // paused), reused for the notification, dashboard preview, and chat re-entry.
      let reportBody = `${escalationBanner}${needsAttention ? outcome.body : successBody}${advisorySummary}`;
      // Warm the tone into Clementine's voice + let her flag a routine no-op.
      // Best-effort/fail-open: any hiccup returns the original text. We skip the
      // already-silenced echo (token-free). A no-op silences ONLY a clean,
      // scheduled (non-interactive) run — every guard below must be false.
      const interactive = Boolean(run.originSessionId);
      let runIsNoOp = false;
      if (!stepAlreadyNotified) {
        const lane = workflowReportLaneForOutcome({ needsAttention, advisories: qualityAdvisories });
        const voiced = await rewriteInClementineVoice(reportBody, { workflowName: workflow.data.name, lane });
        reportBody = voiced.message;
        runIsNoOp = voiced.nothingHappened
          && !needsAttention && !hasFailures && !hasAdvisories && !autoHealPaused && !interactive;
      }
      const terminalReport = {
        workflowName: workflow.data.name,
        outcome: workflowReportLaneForOutcome({ needsAttention, advisories: qualityAdvisories }),
        detail: reportBody,
      };
      const terminalRecord = writeRunRecord(filePath, terminalProjection, terminalReport);
      if (!terminalPublicationMatches(filePath, terminalRecord, terminalReport)) return;
      appendWorkflowEvent(workflow.name, run.id, { kind: 'run_completed' });
      recordPublishedOutcomeLearning();
      try {
        appendWorkflowEvent(workflow.name, run.id, {
          kind: 'run_summary',
          meta: {
            because: succeededBecause,
            needsAttention,
            artifacts: runArtifacts,
            emptyDeliverableReads: emptyDeliverableReads.map((e) => ({ stepId: e.stepId, consumer: e.consumerId })),
          },
        });
      } catch { /* summary event is best-effort */ }
      attemptWorkflowRunReportBack(filePath);
      addNotification({
        id: `workflow-${run.id}-completed`,
        kind: 'workflow',
        title: runIsNoOp
          ? `Nothing new — ${workflow.data.name}`
          : hasFailures && !needsAttention
            ? `Workflow completed with ${forEachFailures.length} failure${forEachFailures.length === 1 ? '' : 's'}: ${workflow.data.name}`
            // renderLegibleOutcome titles a no-blocked-step run "completed"; a
            // target-miss or goal-miss is needs-attention with no blocked step,
            // so title it honestly.
            : needsAttention && blockedSteps.length === 0
              ? `⚠️ Workflow needs attention: ${workflow.data.name}`
              : outcome.title,
        // Send the full body. Discord delivery splits long content into
        // multiple messages; previous 2000-char slice cut off workflow
        // results above that length with no continuation. Quality advisories
        // are appended to whichever body we send (never replace the deliverable).
        body: reportBody,
        createdAt: new Date().toISOString(),
        read: false,
        // Advisories must reach the user — never silence a run that has one.
        // A chronic-failure escalation must also always deliver. A routine
        // no-op goes dashboard-only (recorded + auditable, no Discord/push).
        silent: (stepAlreadyNotified || runIsNoOp) && !hasAdvisories && !autoHealPaused,
        metadata: {
          workflow: workflow.data.name,
          runId: run.id,
          forEachFailures: hasFailures ? forEachFailures : undefined,
          needsAttention: needsAttention || undefined,
          proposedFixId: proposedFix?.id,
          qualityAdvisories: hasAdvisories ? qualityAdvisories : undefined,
          ...(runIsNoOp ? { noOp: true, noOpReason: 'no new items' } : {}),
        },
      });
      markRunNotified(filePath);
      try {
        finishRun(run.id, {
          status: 'completed',
          message: needsAttention
            ? (blockedSteps.length > 0
                ? `Needs attention — ${blockedSteps.length} step${blockedSteps.length === 1 ? '' : 's'} blocked`
                : `Needs attention — ${attentionReason ?? 'target not confirmed'}`)
            : `Completed${hasFailures ? ` with ${forEachFailures.length} item failure${forEachFailures.length === 1 ? '' : 's'}` : ''}${hasAdvisories ? ` · ${qualityAdvisories.length} quality advisory${qualityAdvisories.length === 1 ? '' : 'ies'}` : ''}`,
          outputPreview: reportBody.slice(0, 800),
          needsAttention,
        });
      } catch { /* best-effort */ }
      // Gap E: re-enter the origin chat in-context (no-op for scheduled/cron).
      // Needs-attention OR a review-required advisory → 'blocked' so Clem knows
      // to review; informational advisories still ride the body on the done
      // lane. A routine no-op never wakes the chat.
      logger.info({ workflow: workflow.data.name, runId: run.id, partialFailures: forEachFailures.length, blockedSteps: blockedSteps.length, advisories: qualityAdvisories.length, diagnosed: !!diagnosis }, 'Workflow run completed');
    } catch (error) {
      // P0 parking: the run paused on a human approval. Checkpoint the
      // resume coordinates as status='parked' and RETURN — this is NOT a
      // failure. processOneRunFile returning frees the bounded-pool slot;
      // `reapResolvedParkedRuns` flips the run back to 'running' once every
      // watched approval clears, and the next drain resumes from the
      // parked step (events.jsonl drives resume, so completed steps are
      // never re-run). The heartbeat is torn down in the finally below.
      if (error instanceof ParkRunSignal) {
        const parkedAt = new Date().toISOString();
        const approvalIds = error.parkedSteps.flatMap((step) => step.approvalIds);
        const parkedRecord = writeRunRecord(filePath, {
          ...run,
          status: 'parked',
          startedAt: run.startedAt ?? new Date().toISOString(),
          parked: { parkedSteps: error.parkedSteps, parkedAt },
        }).record;
        // A dashboard cancellation or another terminal publisher may have won
        // the shared record lock after the step raised ParkRunSignal. Do not
        // emit approval cards / awaiting_approval activity / needs_input turns
        // from the stale park path after that authoritative transition.
        if (parkedRecord.status === 'cancelled') {
          stopAfterCancellationWonWrite(filePath, parkedRecord);
          return;
        }
        if (isTerminalRunRecord(parkedRecord)) return;
        // Belt-and-suspenders: the user-facing approval ask is normally posted
        // upstream in runStepViaHarness, but that post is gated + best-effort.
        // Re-emit it here with the SAME stable id `approval-<approvalId>` so
        // addNotification dedupes to a no-op when the upstream card landed, and
        // a RECOVERY post when it didn't — so a parked run never goes silent
        // until the 1h watchdog floor. (Not markRunNotified: parked isn't
        // terminal; the run resumes and reports back on completion.)
        for (const approvalId of approvalIds) {
          try {
            addNotification({
              id: `approval-${approvalId}`,
              kind: 'approval',
              title: `Workflow ${workflow.data.name} needs approval`,
              body: `This workflow is parked until you respond. Reply \`approve ${approvalId}\` or \`reject ${approvalId}\`.`,
              createdAt: new Date().toISOString(),
              read: false,
              metadata: { approvalId, runId: run.id, workflowName: workflow.data.name },
            });
          } catch { /* best-effort recovery card — never block parking */ }
        }
        try {
          finishRun(run.id, {
            status: 'awaiting_approval',
            message: `Workflow is waiting for approval: ${error.parkedSteps.map((step) => step.stepId).join(', ') || 'approval step'}`,
            pendingApprovalId: approvalIds[0],
            outputPreview: 'This workflow is parked until you approve or reject the pending approval.',
          });
        } catch {
          try {
            addRunEvent(run.id, {
              type: 'approval_required',
              status: 'awaiting_approval',
              message: 'Workflow is waiting for approval.',
              data: {
                workflow: workflow.data.name,
                parkedSteps: error.parkedSteps.map((step) => step.stepId),
                approvalIds,
              },
            });
          } catch { /* run-events is best-effort; never block parking */ }
        }
        // A chat-fired run that just parked tells its origin chat IMMEDIATELY
        // ("waiting on your approval apr-x"), instead of the user discovering
        // it hours later from a notification card or the 1h watchdog.
        // deliverOutcome directly (not enqueueWorkflowOutcomeTurn): the
        // idempotency prefix is `[workflow run <sourceId> ` and the run's
        // eventual COMPLETION turn must still land, so the park turn gets its
        // own sourceId (run id + gate) instead of sharing the run's. A run
        // that parks on several gates over its life gets one turn per gate.
        for (const originSessionId of workflowRunOriginSessionIds(run)) {
          const gateKey = approvalIds[0] ?? error.parkedSteps[0]?.stepId ?? 'gate';
          emitParkedApprovalCardToOriginChat({
            originSessionId,
            approvalId: approvalIds[0],
            workflowName: workflow.data.name,
            runId: run.id,
          });
          // Discord/Slack origins get the approval NOTIFICATION CARD in the
          // same channel via the fan-out above — firing the proactive
          // "reply approve apr-x" prose there too produced two approval
          // messages for one decision (live 2026-07-23). The prose relay is
          // for surfaces where the card folds into the SAME conversation
          // (desktop); channel origins keep the passive staging (context for
          // their next turn) + the channel card.
          const channelHasOwnApprovalCard = originChannelRendersOwnApprovalCard(originSessionId);
          deliverOutcome(
            {
              status: 'needs_input',
              detail:
                `The run is PARKED waiting on your approval (step ${error.parkedSteps.map((step) => step.stepId).join(', ') || 'approval gate'}). `
                + `Reply \`approve ${approvalIds[0] ?? ''}\` or \`reject ${approvalIds[0] ?? ''}\` — it resumes automatically after you decide.`,
            },
            {
              originSessionId,
              sourceLabel: 'workflow run',
              sourceId: `${run.id}#parked-${gateKey}`,
              title: workflow.data.name,
              statusHint: `workflow_run_status run_id="${run.id}"`,
              proactiveTurn: !channelHasOwnApprovalCard,
            },
          );
        }
        logger.info(
          { workflow: workflow.data.name, runId: run.id, parkedSteps: error.parkedSteps.map((p) => p.stepId) },
          'Workflow run parked on approval — bounded-pool slot released',
        );
        return;
      }
      let message = error instanceof Error ? error.message : String(error);
      let cancelled = error instanceof WorkflowRunCancelledError || isWorkflowRunCancelled(run.id);
      const requestedCancellation = cancelled;
      // Preview the post-failure count without mutating the advisory ledger.
      // The real update happens only after an error terminal state wins.
      const prospectiveFailureCount = cancelled ? 0 : getConsecutiveFailures(workflow.name) + 1;
      const errEscalationBanner = prospectiveFailureCount >= escalateThreshold()
        ? `⚠️ "${workflow.data.name}" has failed ${prospectiveFailureCount} runs in a row — please check it (and, for a scheduled workflow, consider disabling it until fixed). It resumes normal handling after one clean run.\n\n`
        : '';
      // Contract-aware self-heal: a step that FAILED its declared output
      // contract throws to here (contract failures throw, so they bypass the
      // success-with-blocked diagnosis above). Route it to the Doctor for an
      // approval-gated fix offer + a legible message. Additive + gated: only
      // when self-heal is on AND a real contract violation is found, so
      // non-contract / cancelled failures are byte-identical to before.
      let healTitle: string | undefined;
      let healBody: string | undefined;
      let healFixId: string | null = null;
      if (!cancelled && selfHealEnabled()) {
        try {
          const cv = findContractViolationStep(readWorkflowEvents(workflow.name, run.id));
          if (cv) {
            const blocked: BlockedStep[] = [{
              stepId: cv.stepId,
              reason: `output contract violation: ${cv.problems.join('; ') || message}`,
              kind: 'blocked',
            }];
            const diagnosis = await diagnoseWorkflowBlock({
              workflow: workflow.data,
              blockedSteps: blocked,
              toolErrors: cv.problems.length ? cv.problems : [message],
            });
            if (diagnosis) {
              healFixId = recordProposedFix(workflow.name, run.id, diagnosis)?.id ?? null;
              const outcome = renderLegibleOutcome({
                workflowName: run.workflow,
                blockedSteps: blocked,
                diagnosis,
                fixId: healFixId,
                fallbackBody: message,
              });
              healTitle = outcome.title;
              healBody = outcome.body;
            }
          }
        } catch (healErr) {
          logger.warn({ err: healErr, runId: run.id }, 'contract-violation self-heal failed (best-effort)');
        }
      }
      // Warm the failure tone too (fail-open, lane:'failed' so the rewrite can
      // never claim success or drop the `apply fix <id>` action). A user CANCEL
      // keeps the original text + is never rewritten. Failures are NEVER silenced.
      let failureBody = `${errEscalationBanner}${healBody ?? message}`;
      if (!cancelled) {
        failureBody = (await rewriteInClementineVoice(failureBody, { workflowName: run.workflow, lane: 'failed' })).message;
      }
      const requestedReport = { workflowName: run.workflow, outcome: 'failed' as const, detail: failureBody };
      const terminalRecord = writeRunRecord(filePath, {
        ...run,
        status: cancelled ? 'cancelled' : 'error',
        finishedAt: new Date().toISOString(),
        error: message,
        ...(cancelled ? {} : {
          needsAttention: true,
          blockedSteps: [{ stepId: '(run)', reason: message }],
          ...(healFixId ? { proposedFixId: healFixId } : {}),
        }),
      }, requestedReport);
      const canonicalTerminal = terminalRecord.record;
      if (!terminalRecord.publishedTerminal) {
        if (!stopAfterCancellationWonWrite(filePath, canonicalTerminal) && canonicalTerminal.reportBack) {
          attemptWorkflowRunReportBack(filePath);
        }
        return;
      }
      if (canonicalTerminal.status !== 'error' && canonicalTerminal.status !== 'cancelled') return;
      if (requestedCancellation && canonicalTerminal.status !== 'cancelled') return;
      cancelled = canonicalTerminal.status === 'cancelled';
      if (cancelled) {
        message = typeof canonicalTerminal.error === 'string' && canonicalTerminal.error
          ? canonicalTerminal.error
          : message;
        failureBody = canonicalTerminal.reportBack?.detail ?? message;
        healTitle = undefined;
        healFixId = null;
      } else if (!canonicalTerminal.reportBack || !sameTerminalReport(canonicalTerminal.reportBack, requestedReport)) {
        attemptWorkflowRunReportBack(filePath);
        return;
      }
      attemptWorkflowRunReportBack(filePath);
      if (!cancelled) recordWorkflowOutcome(workflow.name, false, message);
      logger[cancelled ? 'info' : 'error']({ err: error, file }, cancelled ? 'Workflow run cancelled' : 'Workflow run failed');
      appendWorkflowEvent(workflow.name, run.id, { kind: cancelled ? 'run_cancelled' : 'run_failed', error: message });
      addNotification({
        // Stable id (terminal state fires once per run): addNotification
        // id-dedup makes this at-most-once and shares the cancelled id with the
        // drain-path helper so the two can never double-post the same cancel.
        id: `workflow-${run.id}-${cancelled ? 'cancelled' : 'error'}`,
        kind: 'workflow',
        title: healTitle ?? (cancelled ? `Workflow cancelled: ${run.workflow}` : `Workflow failed: ${run.workflow}`),
        body: failureBody,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: {
          workflow: run.workflow,
          runId: run.id,
          status: cancelled ? 'cancelled' : 'error',
          ...(healFixId ? { proposedFixId: healFixId, needsAttention: true } : {}),
        },
      });
      markRunNotified(filePath);
      // Gap E: re-enter the origin chat on a genuine FAILURE (no-op for
      // scheduled/cron). Skip a user-initiated CANCEL — the user already knows
      // (mirrors background-tasks skipping aborted).
      try {
        finishRun(run.id, {
          status: cancelled ? 'cancelled' : 'failed',
          message: cancelled ? 'Workflow run cancelled' : `Workflow failed: ${message}`,
          error: cancelled ? undefined : message,
        });
      } catch { /* best-effort */ }
    } finally {
      stopHeartbeat();
    }
}

/**
 * Daemon-startup hook: surface workflow runs that were in-flight when
 * the daemon last shut down. The run records have status='running'
 * (set when the workflow started) and the per-run events.jsonl shows
 * no terminal event. processWorkflowRuns() will pick these up on the
 * next tick because we accept 'running' as resumable.
 *
 * This function logs the pending set so a desktop user can see at a
 * glance which workflows the daemon is resuming. It also reconciles
 * any in-progress run records whose queue file went missing (deleted
 * mid-run, etc.) — those get marked as 'interrupted' rather than
 * left dangling.
 */
export function reconcilePendingWorkflowRuns(): void {
  const pending = listPendingRuns();
  if (pending.length === 0) return;
  logger.info(
    { pending: pending.map((p) => ({ workflow: p.workflowName, runId: p.runId, at: p.lastEventAt })) },
    `Resuming ${pending.length} in-flight workflow run${pending.length === 1 ? '' : 's'}`,
  );
}
