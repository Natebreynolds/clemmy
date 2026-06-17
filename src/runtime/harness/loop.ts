import type { Agent, AgentInputItem } from '@openai/agents';
import { Runner } from '@openai/agents';
import { HarnessSession } from './session.js';
import {
  appendEvent,
  clearKill,
  getSession,
  getToolOutput,
  listEvents,
  openEventLog,
  type AppendEventInput,
  type EventRow,
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
  harnessToolBracketsEnabled,
} from './brackets.js';
import { compactSessionIfNeeded, checkpointGoalStage } from './compaction.js';
import { selectReasoningEffort, dynamicReasoningEnabled } from './reasoning-effort.js';
import { buildAgentContextPacket } from './context-packet.js';
import { getHarnessBudgetSettings, getElevatedBudget } from './budget-settings.js';
import type { HarnessBudgetRuntime } from './budget-settings.js';
import {
  checkBudget,
  estimateMessagesTokens,
  estimateTokens,
  predictTurnCost,
} from './budget.js';
import { MODELS } from '../../config.js';
import { judgeObjectiveComplete, shouldRunObjectiveJudge, isPromiseShapedReply, composeJudgedObjective, type ObjectiveJudgeFn } from './objective-judge.js';
import { verifyDeliveredEnabled, matchesBlockedText } from './verify-delivered.js';
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
import { gatherSessionSkills, summarizeToolCallsForJudge, skillExecutionShortfall } from './skill-execution.js';
import { classifyMessageIntent } from '../../assistant/message-intent.js';
import { attachEventLogHooks, extractSessionIdFromContext, type RunHooksLike } from './hooks.js';
import * as approvalRegistry from './approval-registry.js';
import { actionBus } from '../action-bus.js';
import { addNotification } from '../notifications.js';
import { classifyCodexAuthError, markCodexAuthDead, isCodexAuthDead } from '../auth-store.js';
import { BoundaryError } from '../boundary-error.js';
import { classifyModelError } from './resilient-model.js';
import { getRuntimeEnv } from '../../config.js';
import { captureInteractionSignals } from '../../memory/auto-capture.js';
import { primeTurnRecallVector, searchFactsByText } from '../../memory/facts.js';
import { formatSearchHits, searchVault, searchVaultAsync } from '../../memory/search.js';
import { maybeAutoFocusSession } from './auto-focus.js';
import { scrubInternalNarration } from './scrub-internal-narration.js';
import { getPlanScope, openPlanScope } from '../../agents/plan-scope.js';
import { classifyTool } from '../../agents/tool-taxonomy.js';

/**
 * Wrap appendEvent so a transient SQLite write failure (lock, disk
 * full, etc.) inside the loop logs an error instead of unwinding the
 * whole turn and surfacing as an unhandled rejection. The event log
 * is observability, not load-bearing for the run's logical outcome —
 * losing one event entry is preferable to crashing the daemon.
 */
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

function safeMaybeAutoFocus(sessionId: string, summaryHint?: unknown): void {
  try {
    maybeAutoFocusSession({ sessionId, summaryHint });
  } catch (err) {
    // Focus is a context aid, not a reason to fail the user's turn.
    console.warn('[harness] auto-focus failed', err instanceof Error ? err.message : err);
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
function inferTurnPriors(
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
    const recentEvents = events
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
    const subject = extractApprovalSubject(interruption);
    let approvalId: string | null = null;
    try {
      const row = approvalRegistry.register({
        sessionId: options.sessionId,
        channel,
        channelId,
        subject,
        tool: interruption.toolName,
        args: interruption.args ?? null,
      });
      approvalId = row.approvalId;
      // Fan out to the notification delivery queue so every enabled
      // destination (Discord DMs, web_push subscriptions on the mobile
      // PWA, generic webhooks) hears about the new approval. The
      // dedupe in addNotification keys on the stable approvalId
      // metadata so multiple harness turns registering the same
      // approval don't spam.
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
        args: interruption.args,
        rawArgs: interruption.rawArgs,
        approvalId, // null when registry write failed; consumers fall
                    // back to old "single pending approval" routing.
      },
    });
  }
  return approvalIds;
}

function extractComposioSlugFromApprovalArgs(args: Record<string, unknown> | null | undefined): string | null {
  if (!args || typeof args !== 'object') return null;
  const slug = args.tool_slug ?? args.toolSlug;
  return typeof slug === 'string' && slug.length > 0 ? slug : null;
}

function collectBatchScopeCandidate(row: approvalRegistry.PendingApprovalRow): {
  key: string;
  allowedTool: string;
  allowedComposioSlug?: string;
  label: string;
} | null {
  if (!row.tool) return null;
  const kind = classifyTool(row.tool, { args: row.args ?? undefined });
  if (kind !== 'send') return null;

  if (row.tool === 'composio_execute_tool') {
    const slug = extractComposioSlugFromApprovalArgs(row.args);
    if (!slug) return null;
    return {
      key: `composio:${slug}`,
      allowedTool: 'composio_execute_tool',
      allowedComposioSlug: slug,
      label: slug,
    };
  }

  return {
    key: `tool:${row.tool}`,
    allowedTool: row.tool,
    label: row.tool,
  };
}

function openScopedApprovalForApprovedBatch(
  rows: approvalRegistry.PendingApprovalRow[],
  decision: 'approve' | 'reject' | 'approve_with_edits',
): void {
  if (decision !== 'approve' || rows.length < 2) return;

  const counts = new Map<string, {
    count: number;
    allowedTool: string;
    allowedComposioSlug?: string;
    label: string;
  }>();
  const sessionId = rows[0]?.sessionId;
  if (!sessionId) return;

  for (const row of rows) {
    if (row.sessionId !== sessionId) continue;
    const candidate = collectBatchScopeCandidate(row);
    if (!candidate) continue;
    const existing = counts.get(candidate.key);
    counts.set(candidate.key, {
      count: (existing?.count ?? 0) + 1,
      allowedTool: candidate.allowedTool,
      allowedComposioSlug: candidate.allowedComposioSlug,
      label: candidate.label,
    });
  }

  const eligible = [...counts.values()].filter((candidate) => candidate.count >= 2);
  if (eligible.length === 0) return;

  const currentScope = getPlanScope(sessionId);
  const allowedTools = new Set(currentScope && !currentScope.closedAt ? currentScope.allowedTools : []);
  const allowedComposioSlugs = new Set(
    currentScope && !currentScope.closedAt ? currentScope.allowedComposioSlugs ?? [] : [],
  );
  const labels: string[] = [];
  for (const candidate of eligible) {
    allowedTools.add(candidate.allowedTool);
    if (candidate.allowedComposioSlug) allowedComposioSlugs.add(candidate.allowedComposioSlug);
    labels.push(candidate.label);
  }

  try {
    openPlanScope({
      sessionId,
      planProposalId: `tool_batch_approval:${Date.now()}`,
      approvedPlanObjective: `Approved batch of external mutations: ${labels.join(', ')}`,
      allowedTools: [...allowedTools],
      allowedComposioSlugs: allowedComposioSlugs.size > 0 ? [...allowedComposioSlugs] : undefined,
      ttlMs: 60 * 60 * 1000,
    });
  } catch (err) {
    console.error('[harness] failed to open scoped approval for approved batch', {
      sessionId,
      allowedTools: [...allowedTools],
      allowedComposioSlugs: [...allowedComposioSlugs],
      error: normalizeError(err),
    });
  }
}

function resolveSnapshotApprovalsForResume(
  rows: approvalRegistry.PendingApprovalRow[],
  decision: 'approve' | 'reject' | 'approve_with_edits',
  resolver: string,
): void {
  const resolution: approvalRegistry.ApprovalResolution =
    decision === 'reject' ? 'rejected' : 'approved';
  for (const row of rows) {
    try {
      approvalRegistry.resolve(row.approvalId, resolution, resolver);
    } catch (err) {
      console.error('[harness] approval-registry.resolve failed during resume', {
        approvalId: row.approvalId,
        sessionId: row.sessionId,
        error: normalizeError(err),
      });
    }
  }
  openScopedApprovalForApprovedBatch(rows, decision);
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
  maxTurns?: number;
  toolCallsPerTurn?: number;
  /** Test injection: build the Runner. Defaults to a fresh real Runner. */
  makeRunner?: () => Runner;
  /** Test injection: run the Runner. Defaults to a real runner.run(). */
  runRunner?: RunRunnerFn;
  /** Opt-in: callback fired for each token delta (output_text_delta) emitted by the model. */
  onChunk?: (delta: string) => void | Promise<void>;
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
  | 'awaiting_user_input'
  | 'awaiting_approval'
  | 'killed'
  | 'limit_exceeded'
  | 'failed';

export interface RunConversationOptions {
  agent: Agent<any, any>;
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
  /** Test injection for goal-contract validation (defaults to validateGoal). */
  goalValidator?: (input: ValidateGoalInput) => Promise<GoalValidationResult>;
  /** Test injection. */
  makeRunner?: () => Runner;
  /** Test injection. */
  runRunner?: RunRunnerFn;
  /** Opt-in: callback fired for each token delta (output_text_delta) emitted by the model. Forwarded to each runTurn. */
  onChunk?: (delta: string) => void | Promise<void>;
}

export interface RunConversationResult {
  sessionId: string;
  status: RunConversationStatus;
  steps: number;
  lastDecision?: OrchestratorDecisionShape;
  lastTurn: number;
  error?: string;
}

function positiveIntEnv(key: string, fallback: number): number {
  const parsed = Number.parseInt(getRuntimeEnv(key, String(fallback)), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const DEFAULT_MAX_CONVERSATION_STEPS = positiveIntEnv('HARNESS_MAX_CONVERSATION_STEPS', 40);
export const DEFAULT_MAX_CONVERSATION_WALL_MS = positiveIntEnv(
  'HARNESS_MAX_CONVERSATION_WALL_MS',
  positiveIntEnv('HARNESS_MAX_CONVERSATION_WALL_MINUTES', 120) * 60 * 1000,
);

const CONTINUATION_INPUT =
  'Continue with the next step of your plan. If you have nothing left to do, set done=true and nextAction=completed.';

/**
 * Async-dispatch completion shape: a successful `workflow_run` dispatch this
 * turn IS the deliverable. The run executes in the daemon and re-enters this
 * chat with its outcome on completion (workflow_run's originSessionId
 * report-back), so judging the reply against the workflow's EVENTUAL artifact
 * can only produce a false NOT-finished — which forces pointless
 * workflow_run_status polling between dispatch and report-back (2026-06-12:
 * 6 junk "still running" turns on a 3-minute run). Detection is exact: the
 * queue tool's own success message, fetched from the tool-output store for a
 * workflow_run call made in THIS turn. Fail-closed to judging as before.
 */
export function dispatchedBackgroundWorkflowRun(sessionId: string, turn: number): boolean {
  try {
    const calls = listEvents(sessionId, { types: ['tool_called'] })
      .filter((ev) => ev.turn === turn
        && (ev.data as { tool?: unknown } | undefined)?.tool === 'workflow_run');
    for (const call of calls) {
      const callId = (call.data as { callId?: unknown } | undefined)?.callId;
      if (typeof callId !== 'string' || !callId) continue;
      const output = getToolOutput(sessionId, callId)?.output ?? '';
      if (/running in the BACKGROUND/i.test(output)) return true;
    }
  } catch { /* fail toward running the judge */ }
  return false;
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
  // the task moving. The opt-out env stays for parity with old behavior.
  const useLegacyBlock =
    (getRuntimeEnv('CLEMMY_PREFLIGHT_LEGACY_BLOCK', 'off') ?? 'off').toLowerCase() === 'on';
  const header =
    `[CONTEXT BUDGET NOTICE] This turn is projected at ~${predictedTokens.toLocaleString()} tokens, ` +
    `nearing ${(blockFraction * 100).toFixed(0)}% of the effective context limit ` +
    `(${effectiveLimit.toLocaleString()} tokens). `;
  if (!useLegacyBlock) {
    return (
      header +
      `This is guidance, not a stop — proceed if the work is worth it. To stay within budget, prefer ` +
      `narrow tool calls (request only the fields you need) and avoid re-reading large outputs. ` +
      `If this is a big multi-step effort, you MAY outline it with \`create_plan\` so it survives ` +
      `context limits, but only if that genuinely helps — do not pause a task that you can finish now. ` +
      `Use your judgment and keep moving.`
    );
  }
  return (
    header +
    `You MUST call \`propose_plan\` to outline the work for user approval BEFORE executing any tool calls. ` +
    `Do NOT fire external tool calls in this turn — the plan-mode interlude exists to keep this conversation alive. ` +
    `If propose_plan is unavailable, reply asking the user to type \`/new continue\` to start a fresh session ` +
    `(facts + focus carry over via the brain).`
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
const TURN_MEMORY_PRIMER_TOP_K = positiveIntEnv('CLEMMY_TURN_MEMORY_PRIMER_TOP_K', 6);
const TURN_MEMORY_PRIMER_MAX_CHARS = positiveIntEnv('CLEMMY_TURN_MEMORY_PRIMER_MAX_CHARS', 2600);
const TURN_MEMORY_PRIMER_FACT_TOP_K = positiveIntEnv('CLEMMY_TURN_MEMORY_PRIMER_FACT_TOP_K', 5);

/** Query-relevant durable facts for the per-turn primer (lexical → finds even
 *  a fact remembered seconds ago, before its embedding indexes). The primer's
 *  vault search never touched consolidated_facts, so a freshly-stated "remember
 *  X" was invisible to auto-context and the model would confabulate. */
function factsBlockForPrimer(query: string): string {
  try {
    const facts = searchFactsByText(query, TURN_MEMORY_PRIMER_FACT_TOP_K);
    if (facts.length === 0) return '';
    const lines = facts.map((f) => `- ${f.content}`);
    return ['[REMEMBERED FACTS — durable, user-stated or curated; treat as known]', ...lines].join('\n');
  } catch {
    return '';
  }
}
const TURN_MEMORY_PRIMER_HYBRID_TIMEOUT_MS = positiveIntEnv('CLEMMY_TURN_MEMORY_PRIMER_HYBRID_TIMEOUT_MS', 800);

function isSyntheticStallRetryInput(text: string): boolean {
  return text.startsWith('Your previous response was prose, not an action.')
    || text.startsWith('Your previous response did not make progress on the directive.');
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
      ' call memory_search or memory_recall with that request or its key nouns. Only ask the user' +
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
  source?: 'fts5' | 'hybrid' | 'fts5_hybrid_timeout' | 'fts5_hybrid_error';
  text?: string;
  skippedReason?: string;
}

function formatTurnMemoryPrimer(query: string, hits: ReturnType<typeof searchVault>, source: TurnMemoryPrimer['source']): TurnMemoryPrimer {
  const formatted = formatSearchHits(hits, TURN_MEMORY_PRIMER_MAX_CHARS);
  // Durable facts relevant to THIS message — the primer's vault search alone
  // never surfaced consolidated_facts, so a just-remembered fact was invisible.
  const factsBlock = factsBlockForPrimer(query);
  if (!formatted && !factsBlock) {
    return { enabled: true, query, hitCount: hits.length, injectedBytes: 0, source, skippedReason: 'no_hits' };
  }
  const sourceLabel = source === 'hybrid'
    ? 'local FTS5 plus semantic rerank'
    : 'local FTS5';
  const text = [
    '[MEMORY PRIMER]',
    `A ${sourceLabel} memory search ran for the latest user message before this model call.`,
    'Use these hits to steer the first response and tool choice. Treat snippets as candidate memory, not proof; before mutating external resources or creating source-backed artifacts, load the source with memory_read/read_file/recall_tool_result or call memory_recall for more context.',
    ...(factsBlock ? ['', factsBlock] : []),
    ...(formatted ? ['', formatted] : []),
  ].join('\n');
  return { enabled: true, query, hitCount: hits.length, injectedBytes: text.length, source, text };
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

async function buildTurnMemoryPrimer(input: string): Promise<TurnMemoryPrimer> {
  const enabled = (getRuntimeEnv('CLEMMY_TURN_MEMORY_PRIMER', 'on') ?? 'on').toLowerCase() !== 'off';
  const hybridEnabled = (getRuntimeEnv('CLEMMY_TURN_MEMORY_PRIMER_HYBRID', 'on') ?? 'on').toLowerCase() !== 'off';
  const query = input.replace(/\s+/g, ' ').trim();
  if (!enabled) return { enabled: false, query, hitCount: 0, injectedBytes: 0, skippedReason: 'disabled' };
  if (!query) return { enabled: true, query, hitCount: 0, injectedBytes: 0, skippedReason: 'empty_input' };
  if (isSyntheticStallRetryInput(query)) {
    return { enabled: true, query, hitCount: 0, injectedBytes: 0, skippedReason: 'synthetic_retry' };
  }

  try {
    const ftsHits = searchVault(query, TURN_MEMORY_PRIMER_TOP_K);
    if (!hybridEnabled) return formatTurnMemoryPrimer(query, ftsHits, 'fts5');

    try {
      const hybridHits = await searchVaultAsyncWithTimeout(query);
      if (hybridHits && hybridHits.length > 0) {
        return formatTurnMemoryPrimer(query, hybridHits, 'hybrid');
      }
      if (hybridHits === null) {
        return {
          ...formatTurnMemoryPrimer(query, ftsHits, 'fts5_hybrid_timeout'),
          skippedReason: ftsHits.length > 0 ? 'hybrid_timeout' : 'hybrid_timeout_no_fts_hits',
        };
      }
    } catch {
      return {
        ...formatTurnMemoryPrimer(query, ftsHits, 'fts5_hybrid_error'),
        skippedReason: ftsHits.length > 0 ? 'hybrid_error' : 'hybrid_error_no_fts_hits',
      };
    }

    return formatTurnMemoryPrimer(query, ftsHits, 'fts5');
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
function buildStallRetryMessage(sessionId: string, stall: StallInfo): string {
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
    if (result.status === 'failed') {
      const message = result.error ?? 'unknown error';
      const err = new BoundaryError({
        kind: 'runtime.unknown',
        retryable: false,
        userMessage: `Clementine hit an unexpected error during this turn. ${message.slice(0, 200)}`,
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

// Kill-switch (default ON). When a PROGRESSING run is about to hit the step
// cap, auto-elevate the budget instead of pausing for a manual `continue`, so a
// genuinely long task ("work through all of these") finishes within its time
// budget. No-op on an instance already configured for long runs (autoContinue
// on → maxSteps is already 1,000,000, so the cap is never approached).
function stepProgressElevateEnabled(): boolean {
  return (process.env.CLEMMY_STEP_PROGRESS_ELEVATE ?? 'on').toLowerCase() !== 'off';
}

/**
 * Pure: should a forward-progressing run auto-elevate its budget because it is
 * about to exhaust the STEP cap? Only fires on the capped `standard` preset with
 * no caller-pinned maxSteps and autoContinue OFF — i.e. exactly the default
 * install that would otherwise pause at 40 steps. Exported for tests.
 */
export function shouldElevateOnStepProgress(opts: {
  enabled: boolean;
  alreadyElevated: boolean;
  preset: string;
  autoContinueOnLimit: boolean;
  explicitMaxSteps: boolean;
  stepIndex: number;
  maxSteps: number;
}): boolean {
  if (!opts.enabled) return false;
  if (opts.alreadyElevated) return false;
  if (opts.explicitMaxSteps) return false; // caller pinned the cap — respect it
  if (opts.autoContinueOnLimit) return false; // already long-run capable (no-op for long/unlimited)
  if (opts.preset !== 'standard') return false; // only the capped default preset
  return opts.stepIndex >= opts.maxSteps; // about to exit on the step cap
}

// Restart-recovery: set/clear the in-flight marker on CHAT sessions only.
// Best-effort — a marker write must never affect the run. Flag-gated so it can
// be fully disabled. See restart-recovery.ts for the boot-time scan.
function markRunInFlight(sessionId: string, on: boolean): void {
  if ((process.env.CLEMMY_CHAT_RESTART_RECOVERY ?? 'on').toLowerCase() === 'off') return;
  try {
    const sess = HarnessSession.load(sessionId);
    if (!sess || sess.kind !== 'chat') return;
    if (on) sess.setRunInFlight();
    else sess.clearRunInFlight();
  } catch {
    /* best-effort — the recovery marker must never break a run */
  }
}

export async function runConversation(
  options: RunConversationOptions,
): Promise<RunConversationResult> {
  // In-flight marker set BEFORE the run and cleared in the finally on ANY exit
  // (return or throw). Only a hard process death between here and the finally
  // leaves it set — which is exactly the "killed mid-run" case the boot scan
  // surfaces so a long chat run never dies silently.
  markRunInFlight(options.sessionId, true);
  try {
    const result = await runConversationCore(options);
    emitRuntimeTerminalEvent(options.sessionId, result);
    return result;
  } finally {
    markRunInFlight(options.sessionId, false);
  }
}

async function runConversationCore(
  options: RunConversationOptions,
): Promise<RunConversationResult> {
  // v0.5.19 F2 — `budget` is mutable so the elevate-on-warn path can
  // rebind it mid-conversation. The cached locals below pick up new
  // ceilings on the next loop iteration via the helper.
  let budget: HarnessBudgetRuntime = getHarnessBudgetSettings();
  let elevated = false;
  let maxSteps = options.maxSteps ?? budget.maxConversationSteps;
  if (options.maxSteps === undefined && budget.autoContinueOnLimit) {
    maxSteps = Math.max(maxSteps, 1_000_000);
  }
  let maxWallMs = options.maxWallClockMs ?? budget.maxConversationWallMs;
  let maxTurns = options.maxTurns ?? budget.maxTurns;
  let toolCallsPerTurn = options.toolCallsPerTurn ?? budget.toolCallsPerTurn;
  let checkInMs = Math.max(60_000, budget.checkInMinutes * 60 * 1000);
  const startedAt = Date.now();
  let lastCheckInAt = startedAt;

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
  let lastDecision: OrchestratorDecisionShape | undefined;
  let lastTurn = 0;
  // Stall-retry counter (scoped to this conversation). Incremented each
  // time evaluateProgress() returns a stall AND we have retry budget
  // remaining. Reset implicitly because it's a local — a fresh
  // runConversation() call starts from zero.
  let stallRetriesUsed = 0;

  // Independent objective-completion judge (Hermes-style). Only for interactive
  // chat callers (opt-in). The judge catches the model declaring "done" before
  // the artifact actually exists, and injects a continuation instead of
  // yielding. Bounded so a stubborn judge can't loop forever; fails open (judge
  // defaults to done) so it never wedges.
  //
  // Gating is on OBSERVED WORK, not phrasing: a turn that ran several tool calls
  // did substantive multi-step work and is worth verifying — even when the
  // request reads as a "lookup" ("find me the accounts and drop them in a
  // sheet" classifies as lookup but is real multi-step action). The intent
  // branch keeps the cheap path: a clear ACTION objective is judged even if it
  // somehow finished with few tool calls. A trivial lookup ("what's on my
  // calendar") makes 1–2 tool calls and is below threshold → never judged.
  const objectiveJudge = options.judgeFn ?? judgeObjectiveComplete;
  const objectiveJudgeOptIn = options.judgeCompletion === true;
  const objectiveJudgeActionIntent = classifyMessageIntent(options.input).intent === 'action';
  const objective = options.input;
  const MAX_OBJECTIVE_JUDGE_CONTINUATIONS = 3;
  // A turn that fired this many tool calls did real multi-step work, regardless
  // of how the request was phrased.
  const OBJECTIVE_JUDGE_WORK_THRESHOLD = 3;
  let objectiveJudgeContinuations = 0;
  let totalToolCalls = 0;

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
    if (options.maxSteps === undefined && budget.autoContinueOnLimit) {
      maxSteps = Math.max(maxSteps, 1_000_000);
    }
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

    const turnResult = await runTurn({
      agent: options.agent,
      sessionId: options.sessionId,
      input: nextInput,
      maxTurns,
      toolCallsPerTurn,
      makeRunner: options.makeRunner,
      runRunner: options.runRunner,
      onChunk: options.onChunk,
    });
    lastTurn = turnResult.turn;
    totalToolCalls += turnResult.toolCalls ?? 0;

    // v0.5.19 F2 — elevate budget mid-conversation if the preflight
    // gate just emitted warn/block AND we're still on `standard`.
    // The 40/40/40 standard caps trap long-running tasks with no
    // recourse (autoContinueOnLimit=false). One-way ratchet — once
    // elevated this run stays elevated. Honors CLEMMY_AUTOBUMP_BUDGET.
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

    // Any non-completed status propagates immediately. The conversation
    // can't continue if the SDK paused for approval, the kill switch
    // tripped, the brackets blew, or an error fired.
    if (turnResult.status !== 'completed') {
      const status: RunConversationStatus = turnResult.status;
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
    const decision = toOrchestratorDecision(turnResult.finalOutput);
    lastDecision = decision ?? lastDecision;

    safeAppend({
      sessionId: options.sessionId,
      turn: turnResult.turn,
      role: 'Clem',
      type: 'conversation_step',
      data: {
        step: stepIndex,
        decision: decision ?? null,
      },
    });

    const structuredStallInfo = decision
      ? evaluateStructuredDecisionStall({
          decision,
          toolCalls: turnResult.toolCalls ?? 0,
          sessionId: options.sessionId,
          turn: turnResult.turn,
        })
      : undefined;
    if (structuredStallInfo) {
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
      const askUserEnabled =
        (getRuntimeEnv('HARNESS_STALL_ASK_USER', 'on') ?? 'on').toLowerCase() !== 'off';
      if (askUserEnabled) {
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'Clem',
          type: 'awaiting_user_input',
          data: {
            question:
              "I've been unable to make progress because the model claimed tools were unavailable instead of using them. Should I retry, switch approach, or stop here?",
            options: ['Retry', 'Switch approach', 'Stop'],
            source: 'stall_recovery',
            signal: structuredStallInfo.signal,
          },
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

    if (!decision) {
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
        nextInput = 'Your previous response could not be parsed into the required structured decision. Re-issue it now as the exact decision object (summary, reply, done, nextAction, reason) — keep the reply concise and put any large deliverable in FILES via the file tools, never inline in the reply. If the task is NOT finished, set done:false and take the next concrete action now (write the files, run the shell/CLI command, deploy) — do not stop at a plan; keep going until the actual deliverable exists.';
        continue;
      }
      // Retry budget exhausted, or genuinely nothing to recurse on. End cleanly.
      // (Historically this also covered a handoff target becoming the final
      // agent; sub-agents are tools now, but the fallback summary still gives
      // the UI something to render instead of just "complete".)
      const fallbackSummary = extractFallbackSummary(turnResult.finalOutput);

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
        // "unable to make progress" prompt (the Brooke email-find lost a real
        // "I didn't find any email from Brooke" answer this way). Only the real
        // reply is delivered — a generic ack / announcement / empty-reply
        // sentinel (hasReply:false) is excluded and still asks the user.
        // Kill-switch HARNESS_STALL_SALVAGE_REPLY=off.
        const salvageEnabled =
          (getRuntimeEnv('HARNESS_STALL_SALVAGE_REPLY', 'on') ?? 'on').toLowerCase() !== 'off';
        if (
          salvageEnabled &&
          stallInfo.signal === 'D_decision_json' &&
          (stallInfo.detail as { hasReply?: boolean }).hasReply === true &&
          stallInfo.userVisibleMessage.trim()
        ) {
          safeAppend({
            sessionId: options.sessionId,
            turn: turnResult.turn,
            role: 'system',
            type: 'conversation_completed',
            data: {
              steps: stepIndex,
              reason: 'decision_json_salvaged',
              summary: stallInfo.userVisibleMessage,
              reply: stallInfo.userVisibleMessage,
              delivered: true,
              stallDetail: { signal: stallInfo.signal, ...stallInfo.detail },
            },
          });
          return {
            sessionId: options.sessionId,
            status: 'completed',
            steps: stepIndex,
            lastDecision,
            lastTurn,
          };
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
              question:
                "I've been unable to make progress on this — the model produced text without taking action twice in a row. Should I retry, switch approach, or stop here?",
              options: ['Retry', 'Switch approach', 'Stop'],
              source: 'stall_recovery',
              signal: stallInfo?.signal ?? null,
            },
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
      // "find email from Brooke" turn came back empty and gave up on turn 1).
      // Surfacing "couldn't be structured. Please ask again." as the answer is a
      // dead-end non-answer; re-prompt for a structured decision (and the next
      // concrete action) while we have budget. The toolCalls>0 case is already
      // retried above; this is the symmetric zero-tool case. Bounded by
      // MAX_STALL_RETRIES → after exhaustion the fallback below stands.
      // Kill-switch HARNESS_STALL_RETRY_EMPTY=off.
      if (
        !stallInfo &&
        turnResult.finalOutput === STRUCTURED_OUTPUT_RECOVERY_FALLBACK &&
        stallRetriesUsed < MAX_STALL_RETRIES &&
        (getRuntimeEnv('HARNESS_STALL_RETRY_EMPTY', 'on') ?? 'on').toLowerCase() !== 'off'
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
        nextInput = 'Your previous response could not be parsed into the required structured decision — it came back empty or malformed. Re-issue it now as the exact decision object (summary, reply, done, nextAction, reason). If the task is NOT finished, set done:false and take the next concrete action — call the tool you need now.';
        continue;
      }

      safeAppend({
        sessionId: options.sessionId,
        turn: turnResult.turn,
        role: 'system',
        type: 'conversation_completed',
        data: {
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
      });
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: stepIndex,
        lastDecision,
        lastTurn,
      };
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
      const activeGoal = safeActiveGoal(options.sessionId);
      const goalGate = Boolean(activeGoal)
        && (totalToolCalls >= 1 || isPromiseShapedReply(decision.reply || decision.summary));
      if (activeGoal && goalGate) {
        const goalPlan = activeGoal.approvedPlan ?? activeGoal.plan;
        const evidenceText = (decision.reply?.trim() ? decision.reply : decision.summary) ?? '';
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
          evidenceText,
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
          // Capability compounding (C2): a satisfied goal that did real
          // discovery distills into a reusable draft skill. Fire-and-forget —
          // it gates on novelty internally and never blocks completion.
          void maybeDistillSkill(options.sessionId, goalPlan.objective, evidenceText, activeGoal.id);
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
          actionIntent: objectiveJudgeActionIntent,
          totalToolCalls,
          workThreshold: OBJECTIVE_JUDGE_WORK_THRESHOLD,
          continuationsUsed: objectiveJudgeContinuations,
          maxContinuations: MAX_OBJECTIVE_JUDGE_CONTINUATIONS,
          nextAction: decision.nextAction,
          // Catch the "I'll do that next" turn that looks low-effort but promised
          // work and never produced it — the chatbot shape. The judge then forces
          // a real artifact or an honest blocker.
          promiseShaped: isPromiseShapedReply(decision.reply || decision.summary),
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
        const verdict = await objectiveJudge(judgedObjective, responseText ?? '', skillContext);
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
        if (!verdict.done || skillGap) {
          // A deterministic skill-execution shortfall overrides the LLM verdict
          // with a script-specific reason; otherwise use the judge's reason.
          const judgeReason = skillGap
            ? `the "${skillGap.skill}" skill was loaded but NONE of its prescribed scripts ran (${skillGap.prescribed.join(', ')}) — the deliverable was hand-rolled instead of built by the skill's own pipeline`
            : verdict.reason;
          // Self-improvement (C4): a judged not-done where a DRAFT skill was
          // loaded counts against that draft (pitfall + failureCount; quarantine
          // at the threshold). Approved skills are never demoted. Best-effort.
          if (loadedSkills.length > 0) {
            void (async () => {
              try {
                const { reinforceDraftSkills } = await import('../../memory/skill-distiller.js');
                reinforceDraftSkills(loadedSkills.map((s) => s.name), 'failure', judgeReason);
              } catch { /* best-effort */ }
            })();
          }
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
            : [
            `You marked this objective complete, but an independent verification check found it is NOT finished: ${judgeReason}.`,
            'First try to finish it yourself — produce the real artifact and verifiable evidence (a URL, file path, or emitted result). Prefer doing the work over asking.',
            'But FIRST, if the failure names a DISCOVERABLE value — a 404 / "not found", a wrong or missing slug/team/account/id, a missing arg — find the right value with the tool\'s OWN discovery command (e.g. `netlify api listAccountsForUser`, `<cli> whoami`/`status`/`list`) or by recalling your saved tool-choice, then retry ONCE with it. That is recoverable, NOT a dead end: giving up on it — or asking the user for a value the tool can report itself — is a loop failure, not honesty.',
            'Only do NOT loop on a GENUINE dead end: a tool truly unavailable, an external service down, or an input the system genuinely cannot provide — after a real discover-and-retry has actually failed. Then STOP and report the SPECIFIC blocker — set nextAction=awaiting_user_input with a concrete question, or nextAction=abandoned if it is truly impossible. A blocked task reported honestly is correct; silently re-declaring "complete" without the artifact is not.',
            'Only set nextAction=completed once the real artifact or verifiable evidence genuinely exists.',
          ].join(' ');
          continue;
        }
      }
      // Render priority on the chat surface: prefer `reply` (the
      // natural-language message intended for the user) over `summary`
      // (an internal log entry).
      //
      // When the model marks the turn complete (done:true,
      // nextAction:completed) but provides NO reply, the previous
      // fallback leaked the META summary into the bubble — which the
      // user reads as if it were the bot's answer, e.g. "Drafted a
      // workflow and surfaced two decisions" instead of THE workflow
      // and THE decisions. Make this failure VISIBLE: emit an obvious
      // "model produced no user-facing reply" message so the bug is
      // diagnosable instead of masked by plausible-looking META text.
      const hasReply = decision.reply && decision.reply.trim();
      const isCompletedAction = decision.nextAction === 'completed';
      const baseSummary = hasReply
        ? decision.reply!
        : isCompletedAction
          ? `(The model marked the turn complete without producing a user-facing reply. This is a bug. Internal log: ${decision.summary})`
          : decision.summary;
      // Goal contract: criteria still unmet after the attempt budget — the
      // user must SEE that, never a silent clean-looking completion.
      const userVisibleSummary = goalUnmetNote ? `${baseSummary}\n\n${goalUnmetNote}` : baseSummary;

      // Honest-completion backstop (Done? node). The objective judge above only
      // runs for opted-in ACTION objectives, so a turn that ends with an
      // explicit blocked / "I can't proceed" / runtime-error stub — on a
      // workflow step, a casual session, or any non-opted-in lane — currently
      // banks as a clean "completed". That false green is the #1 trust-killer
      // on long runs. This guard is deterministic (no model call — the judge
      // already spent any call above), fail-open + monotonic (it can only
      // convert a FALSE completed into an honest awaiting_user_input, never
      // wedge a real completion), and kill-switched (CLEMMY_VERIFY_DELIVERED).
      // awaiting_user_input is the honest terminal: a blocked reply IS waiting
      // on the user/approval/credentials, and every downstream consumer already
      // treats it as a non-completion that needs attention.
      if (verifyDeliveredEnabled() && matchesBlockedText(userVisibleSummary)) {
        safeAppend({
          sessionId: options.sessionId,
          turn: turnResult.turn,
          role: 'system',
          type: 'conversation_completed',
          data: {
            steps: stepIndex,
            summary: userVisibleSummary,
            internalSummary: decision.summary,
            reply: decision.reply ?? null,
            delivered: false,
            blockedReason: userVisibleSummary.slice(0, 400),
          },
        });
        const goalForBlocked = safeActiveGoal(options.sessionId);
        if (goalForBlocked) {
          safeAppendGoalLedger(goalForBlocked.id, 'blocked', userVisibleSummary);
        }
        return {
          sessionId: options.sessionId,
          status: 'awaiting_user_input',
          steps: stepIndex,
          lastDecision: decision,
          lastTurn,
        };
      }

      safeAppend({
        sessionId: options.sessionId,
        turn: turnResult.turn,
        role: 'system',
        type: 'conversation_completed',
        data: {
          steps: stepIndex,
          summary: userVisibleSummary,
          internalSummary: decision.summary,
          reply: decision.reply ?? null,
          missingReply: isCompletedAction && !hasReply ? true : undefined,
          delivered: true,
        },
      });
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: stepIndex,
        lastDecision: decision,
        lastTurn,
      };
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
      safeAppend({
        sessionId: options.sessionId,
        turn: turnResult.turn,
        role: 'system',
        type: 'conversation_completed',
        data: {
          steps: stepIndex,
          summary: decision.reply && decision.reply.trim() ? decision.reply : decision.summary,
          internalSummary: decision.summary,
          reply: decision.reply ?? null,
          reason: 'abandoned_by_orchestrator',
        },
      });
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: stepIndex,
        lastDecision: decision,
        lastTurn,
      };
    }

    // Wall-clock check before we kick off another turn.
    if (Date.now() - lastCheckInAt >= checkInMs) {
      lastCheckInAt = Date.now();
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
          message: `Still working (${stepIndex} step${stepIndex === 1 ? '' : 's'} completed).`,
        },
      });
    }

    if (maxWallMs > 0 && Date.now() - startedAt > maxWallMs) {
      emitLimitExceededWithContinuePrompt({
        sessionId: options.sessionId,
        turn: turnResult.turn,
        steps: stepIndex,
        reason: 'wall_clock',
        limitDetail: { maxWallClockMs: maxWallMs },
        lastDecision: decision ?? lastDecision,
      });
      return {
        sessionId: options.sessionId,
        status: 'limit_exceeded',
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
    // No-op when autoContinue is already on (maxSteps is 1,000,000, so the cap
    // is never approached) → cannot regress a long/unlimited instance.
    if (shouldElevateOnStepProgress({
      enabled: stepProgressElevateEnabled(),
      alreadyElevated: elevated,
      preset: budget.preset,
      autoContinueOnLimit: budget.autoContinueOnLimit,
      explicitMaxSteps: options.maxSteps !== undefined,
      stepIndex,
      maxSteps,
    })) {
      applyElevation({ reason: 'step_progress', steps: stepIndex });
    }

    // 'awaiting_handoff_result' or any other non-terminal state → loop.
    nextInput = CONTINUATION_INPUT;
  }

  // Max steps without resolution.
  emitLimitExceededWithContinuePrompt({
    sessionId: options.sessionId,
    turn: lastTurn,
    steps: stepIndex,
    reason: 'max_steps',
    limitDetail: { maxSteps },
    lastDecision,
  });
  return {
    sessionId: options.sessionId,
    status: 'limit_exceeded',
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
  turn: number;
  steps: number;
  reason: 'wall_clock' | 'max_steps';
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
    : `I've been working on this for ${opts.steps} step${opts.steps === 1 ? '' : 's'} and hit the step budget — there's more to do. Reply \`continue\` to keep going, or break it into a smaller piece.`;
  const internalSummary = `Hit ${opts.reason === 'wall_clock' ? 'wall-clock' : 'max-steps'} limit at step ${opts.steps}; offered the user a \`continue\` prompt instead of silently failing.`;
  safeAppend({
    sessionId: opts.sessionId,
    turn: opts.turn,
    role: 'system',
    type: 'conversation_completed',
    data: {
      steps: opts.steps,
      reason: 'awaiting_continue',
      summary: continueReply,
      reply: continueReply,
      internalSummary,
      lastDecisionSummary: opts.lastDecision?.summary ?? null,
      limitKind: opts.reason,
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

function toOrchestratorDecision(value: unknown): OrchestratorDecisionShape | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.summary !== 'string') return null;
  if (typeof v.done !== 'boolean') return null;
  if (typeof v.nextAction !== 'string') return null;
  const validActions: ReadonlySet<string> = new Set([
    'awaiting_user_input',
    'awaiting_approval',
    'awaiting_handoff_result',
    'completed',
    'abandoned',
  ]);
  if (!validActions.has(v.nextAction)) return null;
  const rawReply = typeof v.reply === 'string' && v.reply.trim() ? v.reply : null;
  return {
    summary: v.summary,
    // Strip internal context/memory/focus bookkeeping the model sometimes
    // narrates INTO the user-facing reply (e.g. "I checked the active context…
    // not the stale Revill audit thread"). reply is the answer, not plumbing.
    reply: rawReply ? scrubInternalNarration(rawReply) : null,
    done: v.done,
    nextAction: v.nextAction as OrchestratorDecisionShape['nextAction'],
    reason: typeof v.reason === 'string' ? v.reason : null,
  };
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
 *  tool-turn hang, sess-mqg45an3) fails fast and RETRIES instead of pinning the
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
    super(
      `model stream stalled — no stream events for ${seconds}s; the model call timed out ` +
        `(CLEMMY_MODEL_STREAM_STALL_MS / CLEMMY_MODEL_FIRST_BYTE_STALL_MS to tune)`,
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
function maybeDistillSkill(sessionId: string, objective: string, evidence: string, goalId: string): void {
  void (async () => {
    try {
      const { distillSkillFromSession, reinforceDraftSkills } = await import('../../memory/skill-distiller.js');
      // A satisfied goal is a validated success — reinforce any draft skills the
      // session leaned on (promotes a proven draft toward approved).
      try {
        const usedDrafts = gatherSessionSkills(sessionId).map((s) => s.name);
        if (usedDrafts.length > 0) reinforceDraftSkills(usedDrafts, 'success');
      } catch { /* reinforcement is best-effort */ }
      await distillSkillFromSession(sessionId, {
        objective,
        evidence,
        origin: { kind: 'chat', sourceId: goalId },
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

export async function runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
  const row = getSession(options.sessionId);
  if (!row) throw new Error(`unknown session: ${options.sessionId}`);
  const session = HarnessSession.load(options.sessionId);
  if (!session) throw new Error(`unable to load session: ${options.sessionId}`);

  const turn = nextTurnNumber(row);

  if (isKillBeforeStart(options.sessionId, turn, session)) {
    return { sessionId: options.sessionId, turn, status: 'killed' };
  }

  safeAppend({
    sessionId: options.sessionId,
    turn,
    role: 'system',
    type: 'turn_started',
    data: { input: clip(options.input, 200) },
  });
  session.recordUserInput(options.input, turn);

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
  try {
    const captured = captureInteractionSignals({
      message: options.input,
      sessionId: options.sessionId,
    });
    if (captured.candidates.length > 0 || captured.profilePatch) {
      // Facts now consolidate asynchronously through the Mem0 resolver,
      // so committed row ids aren't known synchronously — record the
      // captured candidate signals instead.
      safeAppend({
        sessionId: options.sessionId,
        turn,
        role: 'system',
        type: 'memory_signals_captured',
        data: {
          factCount: captured.candidates.length,
          profilePatch: captured.profilePatch ?? null,
          reasons: captured.candidates.map((c) => c.reason),
        },
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('captureInteractionSignals failed:', err instanceof Error ? err.message : err);
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
  try {
    const { result, nextItems, forkRequest } = await compactSessionIfNeeded(session, sessionItems);
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

  // Cross-session prefix injection. The seed function in discord-harness
  // writes a cross_session_prefix event when a fresh session opens with
  // prior same-channel context. Without injecting it into items here,
  // the agent only sees it if it explicitly calls session_history —
  // which it often skips. Prepending as a system message guarantees
  // the agent reads the continuation context BEFORE deciding what tool
  // to call. (Observed 2026-05-24 in sess-mpjbmoez: agent skipped
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

  // Run the memory primer and the semantic-recall query embed concurrently —
  // the embed stashes the turn's query vector so the (sync) per-turn fact recall
  // can add a relevance term, at ~no added latency (both are network-bound and
  // overlap). primeTurnRecallVector never throws.
  // Turn-stall fix layer 2: the assembly stage gets a HARD outer timeout.
  // Both arms have internal bounds, but a live incident froze a turn at
  // exactly this stage with zero events — belt and braces: if assembly
  // doesn't settle in 15s, proceed with a degraded (no-primer) turn instead
  // of hanging the user. The race leaves the slow promise to settle in the
  // background; it never blocks the turn again.
  const assemblySettled = await Promise.race([
    Promise.all([
      buildTurnMemoryPrimer(options.input),
      primeTurnRecallVector(options.input),
    ]).then((r) => r as [TurnMemoryPrimer, void]),
    new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), 15_000);
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
  const turnMemoryPrimer: TurnMemoryPrimer = assemblySettled
    ? assemblySettled[0]
    : {
        enabled: true,
        query: options.input.replace(/\s+/g, ' ').trim().slice(0, 160),
        hitCount: 0,
        injectedBytes: 0,
        skippedReason: 'assembly_timeout',
      };
  // Goal contract: re-fetch the session's parked goal EVERY turn from the
  // store (never trusted to transcript memory) so the model always works
  // against the authoritative objective + criteria + progress ledger.
  const activeGoalForTurn = safeActiveGoal(options.sessionId);
  const contextPacket = buildAgentContextPacket(options.input, {
    enabled: turnMemoryPrimer.enabled,
    hitCount: turnMemoryPrimer.hitCount,
    source: turnMemoryPrimer.source ?? null,
    injected: Boolean(turnMemoryPrimer.text),
    skippedReason: turnMemoryPrimer.skippedReason ?? null,
  }, { sessionKind: session.sessionRow.kind, sessionId: options.sessionId });
  safeAppend({
    sessionId: options.sessionId,
    turn,
    role: 'system',
    type: 'turn_memory_primer',
    data: {
      enabled: turnMemoryPrimer.enabled,
      queryPreview: clip(turnMemoryPrimer.query, 160),
      hitCount: turnMemoryPrimer.hitCount,
      injected: Boolean(turnMemoryPrimer.text),
      injectedBytes: turnMemoryPrimer.injectedBytes,
      source: turnMemoryPrimer.source ?? null,
      skippedReason: turnMemoryPrimer.skippedReason ?? null,
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
      skills: contextPacket.skills,
      workflows: contextPacket.workflows,
      toolScope: contextPacket.toolScope,
      mcp: contextPacket.mcp,
      healthWarnings: contextPacket.healthWarnings,
      multiItem: contextPacket.multiItem,
      injectedBytes: contextPacket.text.length,
    },
  });

  // v0.5.19 Bug H + callModelInputFilter adoption — build the closure
  // the SDK will invoke just before the LLM call. It appends transient
  // model-only context that should NOT persist into session history:
  // (1) a per-turn memory primer from local FTS/hybrid recall, and
  // (2) retry context for infra-error recovery. Honors
  // CLEMMY_TURN_MEMORY_PRIMER=off and CLEMMY_RETRY_CONTEXT_INJECT=off.
  const modelInputFilter = ((args: {
    modelData: { input: AgentInputItem[]; instructions?: string };
  }) => {
    let modelData = args.modelData;
    try {
      if (contextPacket.text) {
        modelData = {
          input: [
            ...modelData.input,
            { role: 'system', content: contextPacket.text } as AgentInputItem,
          ],
          instructions: modelData.instructions,
        };
      }

      if (turnMemoryPrimer.text) {
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
        modelData = {
          input: [
            ...modelData.input,
            { role: 'system', content: renderGoalContextBlock(activeGoalForTurn) } as AgentInputItem,
          ],
          instructions: modelData.instructions,
        };
      }

      if ((getRuntimeEnv('CLEMMY_RETRY_CONTEXT_INJECT', 'on') ?? 'on').toLowerCase() === 'off') {
        return modelData;
      }
      const recentAwaiting = listEvents(options.sessionId, { types: ['awaiting_user_input'], limit: 1, desc: true });
      const last = recentAwaiting[recentAwaiting.length - 1];
      const lastData = last?.data as
        | { source?: string; retry_context?: Record<string, unknown> | null; boundaryKind?: string }
        | undefined;
      if (lastData?.source !== 'infra_error_recovery' || !lastData.retry_context) return modelData;
      const userInputRaw = typeof options.input === 'string' ? options.input.trim() : '';
      if (!/^(retry|yes|continue|resume|go|try again)$/i.test(userInputRaw)) return modelData;
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
      return {
        input: [...modelData.input, retryMsg],
        instructions: modelData.instructions,
      };
    } catch {
      return modelData; // best-effort
    }
  });

  const opts: Record<string, unknown> = {
    context: { sessionId: options.sessionId, turn },
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
  };
  if (options.onChunk) {
    (opts as unknown as { onChunk?: typeof options.onChunk }).onChunk = options.onChunk;
  }
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
        const recallBudget = new RecallBudget(3, 60_000);
        if (useToolWrapper) {
          return await withHarnessRunContext(
            { sessionId: options.sessionId, counter: toolCounter, recallBudget },
            () => run(runner, options.agent, items, opts),
          ) as RunOutcome;
        }
        // Even without the tool-bracket wrapper, install the AsyncLocalStorage
        // context so recall_tool_result can resolve the session id +
        // per-turn budget.
        return await withHarnessRunContext(
          { sessionId: options.sessionId, counter: toolCounter, recallBudget },
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
      session.saveInterruptState(outcome.serializedState);
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
    safeMaybeAutoFocus(options.sessionId, outcome.finalOutput);
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
    return handleRunError(options.sessionId, turn, session, err);
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
  /** Test injection. */
  makeRunner?: () => Runner;
  /** Test injection: drive the resume with a pre-built outcome. */
  runRunner?: RunRunnerFn;
  /** Opt-in: callback fired for each token delta (output_text_delta) emitted by the model. */
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

  const blob = session.loadInterruptState();
  if (!blob) {
    // Session isn't paused — nothing to resume. Caller can decide to
    // treat the prompt as a fresh user turn instead.
    return { sessionId: options.sessionId, turn: 0, status: 'completed' };
  }

  const turn = nextTurnNumber(row);

  if (isKillBeforeStart(options.sessionId, turn, session)) {
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
  const resolvedApprovals: Array<{ tool: string; }> = [];
  for (const item of pending) {
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
        stateApi.approve(item);
      } else {
        // STICKY APPROVAL: pass alwaysApprove so the SDK caches this
        // decision for the remainder of the run. If the same tool gets
        // invoked again later in the conversation (model retried, agent
        // recovered from a fabricated reply, etc.), the SDK auto-resolves
        // without re-prompting the user.
        stateApi.approve(item, { alwaysApprove: true });
      }
    } else {
      // Symmetric for rejections: future identical invocations stay
      // rejected without re-asking the user.
      stateApi.reject(item, { alwaysReject: true });
    }
    const raw = (item as { rawItem?: { name?: string } } | null)?.rawItem;
    resolvedApprovals.push({ tool: raw?.name ?? 'unknown' });
  }
  if (approvalRowsAtResume.length > 0) {
    resolveSnapshotApprovalsForResume(
      approvalRowsAtResume,
      options.decision,
      options.resolver ?? 'harness-resume',
    );
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
        sticky: options.decision !== 'approve_with_edits',
        edited: options.decision === 'approve_with_edits',
      },
    });
  }
  safeAppend({
    sessionId: options.sessionId,
    turn,
    role: 'system',
    type: 'run_resumed',
    data: { pending: pending.length, decision: options.decision },
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
    context: { sessionId: options.sessionId, turn },
    maxTurns: options.maxTurns ?? maxTurnsForRole('orchestrator'),
    // Match runTurn(): SDK 0.11.5 can execute many function tools in
    // parallel. Keep resumed approval runs on the same bounded local
    // concurrency path so a resumed batch cannot spike tool payloads.
    toolExecution: { maxFunctionToolConcurrency: 8 },
  };

  try {
    const run = options.runRunner ?? defaultRunRunner;
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
          return await withHarnessRunContext(
            { sessionId: options.sessionId, counter: toolCounter },
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
      session.saveInterruptState(outcome.serializedState);
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
    safeMaybeAutoFocus(options.sessionId, outcome.finalOutput);
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
    return handleRunError(options.sessionId, turn, session, err);
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
  decision: 'approve' | 'reject' | 'approve_with_edits';
  /** Required when decision === 'approve_with_edits'. JSON-encoded args. */
  modifiedArgs?: string;
  resolver?: string;
  maxSteps?: number;
  maxWallClockMs?: number;
  maxTurns?: number;
  toolCallsPerTurn?: number;
  makeRunner?: () => Runner;
  runRunner?: RunRunnerFn;
  /** Opt-in: callback fired for each token delta emitted by the model. */
  onChunk?: (delta: string) => void | Promise<void>;
}): Promise<RunConversationResult> {
  const result = await runConversationFromResumeCore(opts);
  emitRuntimeTerminalEvent(opts.sessionId, result);
  return result;
}

async function runConversationFromResumeCore(opts: {
  agent: Agent<any, any>;
  sessionId: string;
  decision: 'approve' | 'reject' | 'approve_with_edits';
  modifiedArgs?: string;
  resolver?: string;
  maxSteps?: number;
  maxWallClockMs?: number;
  maxTurns?: number;
  toolCallsPerTurn?: number;
  makeRunner?: () => Runner;
  runRunner?: RunRunnerFn;
  onChunk?: (delta: string) => void | Promise<void>;
}): Promise<RunConversationResult> {
  const budget = getHarnessBudgetSettings();
  let maxSteps = opts.maxSteps ?? budget.maxConversationSteps;
  if (opts.maxSteps === undefined && budget.autoContinueOnLimit) {
    maxSteps = Math.max(maxSteps, 1_000_000);
  }
  const maxWallMs = opts.maxWallClockMs ?? budget.maxConversationWallMs;
  const maxTurns = opts.maxTurns ?? budget.maxTurns;
  const toolCallsPerTurn = opts.toolCallsPerTurn ?? budget.toolCallsPerTurn;
  const checkInMs = Math.max(60_000, budget.checkInMinutes * 60 * 1000);
  const startedAt = Date.now();
  let lastCheckInAt = startedAt;

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
  let resumeContinuationInput = CONTINUATION_INPUT;

  // Step 1: resume the paused approval.
  const firstResult = await resumePendingApproval({
    agent: opts.agent,
    sessionId: opts.sessionId,
    decision: opts.decision,
    modifiedArgs: opts.modifiedArgs,
    resolver: opts.resolver,
    maxTurns,
    toolCallsPerTurn,
    makeRunner: opts.makeRunner,
    runRunner: opts.runRunner,
    onChunk: opts.onChunk,
  });
  lastTurn = firstResult.turn;

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
    const hasReply = decision?.reply && decision.reply.trim();
    safeAppend({
      sessionId: opts.sessionId,
      turn: lastTurn,
      role: 'system',
      type: 'conversation_completed',
      data: {
        steps: 1,
        reason: 'rejected_by_user',
        summary: hasReply ? decision!.reply! : decision?.summary,
        internalSummary: decision?.summary,
        reply: decision?.reply ?? null,
      },
    });
    return {
      sessionId: opts.sessionId,
      status: 'completed',
      steps: 1,
      lastDecision: decision ?? undefined,
      lastTurn,
    };
  }

  // Steps 2..N: same loop semantics as runConversation, but starting
  // from step 2 since the resume covered step 1.
  let stepIndex = 1;
  while (stepIndex < maxSteps) {
    // Done-invariant (resume variant): mirror runConversation — a done:true with
    // a contradictory awaiting_* nextAction must honor the conservative awaiting
    // state, not bank completed. A null decision (unparseable output) still
    // gracefully resolves done.
    const doneStands = !decision || (decision.done
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
      // Render priority on the chat surface: prefer `reply` (user-facing)
      // over `summary` (internal META log). Mirrors the equivalent path
      // in runConversation at line ~286 — without this the resume path
      // leaks the META summary into Discord so the user sees "Resumed
      // the stale-account workflow context, recognized…" instead of the
      // actual reply the model produced.
      const hasReply = decision?.reply && decision.reply.trim();
      const isCompletedAction = decision?.nextAction === 'completed';
      const userVisibleSummary = hasReply
        ? decision!.reply!
        : isCompletedAction
          ? `(The model marked the turn complete without producing a user-facing reply. This is a bug. Internal log: ${decision?.summary ?? '(none)'})`
          : decision?.summary;

      // Honest-completion backstop (resume variant): a blocked/error-stub final
      // reply converts to the honest awaiting_user_input. Ungated, deterministic,
      // fail-open + monotonic, kill-switched (CLEMMY_VERIFY_DELIVERED).
      if (verifyDeliveredEnabled() && matchesBlockedText(userVisibleSummary)) {
        safeAppend({
          sessionId: opts.sessionId,
          turn: lastTurn,
          role: 'system',
          type: 'conversation_completed',
          data: {
            steps: stepIndex,
            summary: userVisibleSummary,
            internalSummary: decision?.summary,
            reply: decision?.reply ?? null,
            delivered: false,
            blockedReason: (userVisibleSummary ?? '').slice(0, 400),
          },
        });
        const goalForBlocked = safeActiveGoal(opts.sessionId);
        if (goalForBlocked) safeAppendGoalLedger(goalForBlocked.id, 'blocked', userVisibleSummary ?? '');
        return {
          sessionId: opts.sessionId,
          status: 'awaiting_user_input',
          steps: stepIndex,
          lastDecision: decision ?? undefined,
          lastTurn,
        };
      }

      safeAppend({
        sessionId: opts.sessionId,
        turn: lastTurn,
        role: 'system',
        type: 'conversation_completed',
        data: {
          steps: stepIndex,
          summary: userVisibleSummary,
          internalSummary: decision?.summary,
          reply: decision?.reply ?? null,
          missingReply: isCompletedAction && !hasReply ? true : undefined,
          delivered: true,
        },
      });
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: stepIndex,
        lastDecision: decision ?? undefined,
        lastTurn,
      };
    }
    // Unreachable in practice: a null decision makes doneStands true and returns
    // above. The guard restores TS's non-null narrowing for the handlers below.
    if (!decision) break;
    if (decision.nextAction === 'awaiting_user_input') {
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
    if (Date.now() - lastCheckInAt >= checkInMs) {
      lastCheckInAt = Date.now();
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
          message: `Still working (${stepIndex} step${stepIndex === 1 ? '' : 's'} completed).`,
        },
      });
    }

    if (maxWallMs > 0 && Date.now() - startedAt > maxWallMs) {
      safeAppend({
        sessionId: opts.sessionId,
        turn: lastTurn,
        role: 'system',
        type: 'conversation_limit_exceeded',
        data: { steps: stepIndex, reason: 'wall_clock', maxWallClockMs: maxWallMs },
      });
      return {
        sessionId: opts.sessionId,
        status: 'limit_exceeded',
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
      maxTurns,
      toolCallsPerTurn,
      makeRunner: opts.makeRunner,
      runRunner: opts.runRunner,
      onChunk: opts.onChunk,
    });
    lastTurn = turnResult.turn;
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
    safeAppend({
      sessionId: opts.sessionId,
      turn: turnResult.turn,
      role: 'Clem',
      type: 'conversation_step',
      data: { step: stepIndex, decision: decision ?? null },
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
  }

  safeAppend({
    sessionId: opts.sessionId,
    turn: lastTurn,
    role: 'system',
    type: 'conversation_limit_exceeded',
    data: { steps: stepIndex, reason: 'max_steps', maxSteps },
  });
  return {
    sessionId: opts.sessionId,
    status: 'limit_exceeded',
    steps: stepIndex,
    lastDecision,
    lastTurn,
  };
}

// ---------- helpers ----------

function isKillBeforeStart(
  sessionId: string,
  turn: number,
  session: HarnessSession,
): boolean {
  try {
    assertNotKilled(sessionId);
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
    try { clearKill(sessionId); } catch { /* best effort */ }
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
  if (isCodexAuthDead()) return true;
  const status = (err as { status?: number } | null)?.status;
  return classifyCodexAuthError({ message, status, source: 'model' }) === 'terminal';
}

function handleRunError(
  sessionId: string,
  turn: number,
  session: HarnessSession,
  err: unknown,
): RunTurnResult {
  // A kill that lands while a tool call is in flight throws KillRequested
  // INSIDE the SDK's tool execution, and the SDK re-wraps it as a plain
  // Error: "Failed to run function tools: KillRequested: session X has a
  // pending kill request" — the same wrapping that hid ToolTimeout
  // (v0.5.21.1) and ToolGuardrailEscalated (2026-06-01). A bare instanceof
  // misses it and the raw string got dumped at the user with "Didn't
  // finish" instead of a clean Stopped (observed live 2026-06-12,
  // sess-mqbgayx6). Match the wrapped form too.
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
    try { clearKill(sessionId); } catch { /* best effort */ }
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
  // pattern as BoundaryError infra-kinds. Observed sess-mpktnbps:
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
  // sess-mplmvrqu: draft_plan timed out → run_failed instead of the
  // Retry card. Match by message pattern as a second-class catch.
  const wrappedToolTimeoutMatch = (!(err instanceof ToolTimeout) && err instanceof Error)
    ? err.message.match(/ToolTimeout: tool (\S+) timed out after (\d+)ms/)
    : null;
  if (err instanceof ToolTimeout || wrappedToolTimeoutMatch) {
    const askUserEnabled =
      (getRuntimeEnv('HARNESS_INFRA_ASK_USER', 'on') ?? 'on').toLowerCase() !== 'off';
    if (askUserEnabled) {
      const toolMatch = err instanceof ToolTimeout
        ? err.message.match(/tool (\S+) timed out after (\d+)ms/)
        : wrappedToolTimeoutMatch;
      const toolName = toolMatch?.[1] ?? 'unknown';
      const timeoutMs = toolMatch?.[2] ?? '?';
      let retryContext: Record<string, unknown> | null = null;
      try {
        const recentToolCalls = listEvents(sessionId, { types: ['tool_called'], limit: 1, desc: true });
        if (recentToolCalls.length > 0) {
          const tc = recentToolCalls[recentToolCalls.length - 1];
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
          userMessage: `The model backend hit a transient error (${cls.kind.replace('model.', '')}).`,
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
  // Honors HARNESS_INFRA_ASK_USER=off to revert.
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
    ]);
    const askUserEnabled =
      (getRuntimeEnv('HARNESS_INFRA_ASK_USER', 'on') ?? 'on').toLowerCase() !== 'off';
    if (askUserEnabled && askUserKinds.has(err.kind)) {
      const userMsg = err.userMessage || 'A backend error interrupted this turn.';
      // v0.5.19 Bug H — capture retry context: which call was in
      // flight when the infra error fired. The next turn (after the
      // user replies "Retry") will read this and inject the exact
      // failed call args as a system message, so the model can't
      // pivot to a different task. This is the fix for the Bug B
      // regression we saw on sess-mpkmiy4j: after a Codex 5xx the
      // model lost the LinkedIn task context and proposed work on
      // the wrong sheet entirely.
      let retryContext: Record<string, unknown> | null = null;
      try {
        // desc:true + limit:1 → the single most recent tool_called
        // event. Without desc, listEvents returns ASC oldest first
        // and we'd capture the wrong call.
        const recentToolCalls = listEvents(sessionId, { types: ['tool_called'], limit: 1, desc: true });
        if (recentToolCalls.length > 0) {
          const tc = recentToolCalls[recentToolCalls.length - 1];
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
      } catch {
        // best-effort
      }
      safeAppend({
        sessionId,
        turn,
        role: 'Clem',
        type: 'awaiting_user_input',
        data: {
          question:
            `${userMsg} Should I retry the same call, switch approach, or stop here?`,
          options: ['Retry', 'Switch approach', 'Stop'],
          source: 'infra_error_recovery',
          boundaryKind: err.kind,
          operatorMessage: clip(err.operatorMessage ?? message, 400),
          retry_context: retryContext,
        },
      });
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
 * Detect when a sub-agent received a handoff and then returned without
 * actually doing the work — a "stall". Observed pattern:
 *   - Orchestrator hands off to Executor with a clear directive.
 *   - Executor's turn ends with finalOutput "Continuing." (or "OK.",
 *     "Done.", "Working on it.") and ZERO tool calls.
 *   - The harness sees no_structured_output and renders the generic
 *     acknowledgement as if it were the bot's reply.
 *
 * The user sees "Continuing." and waits for action that never comes.
 * Surface the failure explicitly so they (and the chat UI) can tell
 * the difference between a real answer and a punt.
 *
 * Returns a stall descriptor when the pattern matches, undefined when
 * the output looks like real work. The check is intentionally narrow:
 * we don't want to flag a sub-agent that returned a short BUT real
 * answer ("Done — added 5 rows to the sheet"). Only the
 * acknowledgement-with-no-work pattern qualifies.
 */
const STALL_OUTPUT_PATTERN = /^(continuing|ok|okay|done|sure|got it|working on it|will do|on it|understood|noted|alright|certainly|yes)\.?$/i;

// Verbose-announcement / false-claim stall. Two shapes the detector
// catches; both end with zero tool calls in the sub-agent turn:
//
// (A) Future-tense announcement — "Executing the Salesforce pull
//     now — I'll fetch 15 contacts..." Original repro 2026-05-19.
//
// (B) Past-tense FALSE CLAIM — "Handed off the exact Outlook action
//     for execution with the required tool slug and arguments." or
//     "Searched Outlook and found nothing." The model lies that
//     work happened. Caught in sess-mper69si-1a163ec1 (2026-05-21)
//     after a retry escaped the original future-tense filter.
//     Strictly WORSE than (A) because the false claim looks like a
//     real reply and the user trusts it.
//
// Boundary anchors (\b) prevent substring matches; the Unicode-
// apostrophe class catches curly quotes models love to emit.
const STALL_ANNOUNCEMENT_PATTERN = /\b(I[\u2018\u2019\u02bc' ]?ll\s|let me\s|executing\s|fetching\s|running\s|pulling\s|querying\s|checking\s|retrieving\s|processing\s|attempting\s|trying\s|configuring\s|preparing\s|setting up\s|about to\s|going to\s|on the way|in progress|kicking off|starting now|handed off\s|handing off\s|completed the\s|sent the\s|updated the\s|searched\s|pulled the\s|posted the\s|created the\s|drafted the\s|saved the\s|loaded the\s|fetched\s|queried\s|ran the\s|transferred to\s|transferring to\s|routed to\s|routing to\s|dispatched the\s|dispatching the\s|delegated to\s|delegating to\s|kicked off\s|invoked the\s|invoking the\s|launched the\s|launching the\s|triggered the\s|triggering the\s|forwarded to\s|forwarding to\s)/i;
const STRUCTURED_TOOL_UNAVAILABLE_PATTERN = /\b(tool[- ]?enabled run|tool runtime|tool access|tool surface.{0,80}not available|tools? (?:were|was|are|is) (?:not )?available|no (?:commentary\/)?tool calls? (?:were|was|are|is) available|no executable tool results|no completed tool results|handoff summary|without tool access|resend ["“]?continue["”]?.*tool|please resend.*tool[- ]?enabled|cannot (?:create|read|write|search|execute|run).{0,80}(?:this turn|without tools?))\b/i;
// A zero-tool turn that AGREES with a correction, reflects on future behavior,
// or admits it isn't done is a legitimate CONVERSATIONAL reply — not a false
// "I did the work" claim. Without this guard, a stray "I'll …" in
// "you're right — going forward I'll treat SEO as raw metrics" trips
// STALL_ANNOUNCEMENT_PATTERN and the harness force-injects "prose, not an
// action — call a tool now", punishing exactly the converse-until-aligned
// behavior we want. Suppressing on these markers only ever removes FALSE
// positives: a real fake-completion ("Sent the email.", "Created the records.")
// contains none of them. Tool-agnostic — keys on the model's own wording.
const STALL_REFLECTION_SUPPRESS_PATTERN =
  /(you[‘’ʼ'` ]?re right|you are right|good catch|fair (?:point|enough)|my (?:mistake|bad)|i was wrong|i (?:got|had) (?:that|it) wrong|apolog|i should(?:n[‘’ʼ'`]?t)? have|going forward|for future|next time|in the future|that[‘’ʼ'` ]?s (?:right|fair|a (?:fair|good) point)|not (?:the|what)\b.{0,40}\byou asked\b)/i;
const TOOL_SURFACE_PROBE_TOOLS = new Set([
  'check_capability',
  'list_capabilities',
  'workspace_roots',
  'workspace_info',
  'workspace_list',
  'session_history',
  'memory_recall',
  'memory_search',
  'memory_list_facts',
  'skill_list',
  // Discovery-ritual tools: "which tool/command should I use" lookups — never the
  // deliverable itself. A turn that does ONLY these and then DEFERS (sets
  // nextAction:awaiting_handoff_result) has discovered-then-punted instead of
  // executing inline; the narration-deferral guard in evaluateStructuredDecisionStall
  // force-corrects it. A turn that does discovery AND a real tool call in the same
  // turn is NOT probe-only (it called a non-probe tool), so this never false-fires.
  'tool_choice_recall',
  'composio_search_tools',
  'local_cli_list',
]);

export type StallSignal = 'A_zero_tools' | 'B_repeated_tool' | 'C_handoff_pingpong' | 'D_decision_json';

interface StallInfo {
  signal: StallSignal;
  rawOutput?: string;
  userVisibleMessage: string;
  /** Structured detail for the stuck_detected event / dashboard panel. */
  detail: Record<string, unknown>;
}

function evaluateStructuredDecisionStall(opts: {
  decision: OrchestratorDecisionShape;
  toolCalls: number;
  sessionId?: string;
  turn?: number;
}): StallInfo | undefined {
  const { decision, toolCalls } = opts;
  const combined = [decision.reply, decision.summary, decision.reason]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n')
    .trim();
  const onlyProbeTools =
    toolCalls > 0 && opts.sessionId && opts.turn
      ? turnOnlyUsedToolSurfaceProbeTools(opts.sessionId, opts.turn)
      : false;
  const noMeaningfulTools = toolCalls === 0 || onlyProbeTools;
  // SILENT narration-deferral — caught BEFORE the empty-text early return below.
  // A turn with nextAction:awaiting_handoff_result, zero meaningful tools, and
  // reply/summary/reason ALL null-or-whitespace is still a defer to a hand-off
  // that no longer exists — just a wordless one. Without this, the empty-`combined`
  // guard lets it escape into a bland auto-continue (audit 2026-06-16). The
  // non-empty case is handled by the narration-deferral branch further down, which
  // stays AFTER the tool-unavailable branch so an explicit "tools unavailable"
  // claim keeps its own kind.
  if (!combined && noMeaningfulTools && decision.nextAction === 'awaiting_handoff_result') {
    return {
      signal: 'A_zero_tools',
      rawOutput: '',
      userVisibleMessage:
        `_(Clementine produced an empty turn that deferred to a hand-off that no longer ` +
        `exists, with zero tool calls. The harness will retry and force the actual tool action.)_`,
      detail: {
        kind: 'structured_narration_deferral',
        rawOutput: '',
        toolCalls,
        onlyProbeTools,
        nextAction: decision.nextAction,
        done: decision.done,
        summary: decision.summary,
        silent: true,
      },
    };
  }
  if (!combined) return undefined;
  if (
    noMeaningfulTools &&
    (
      decision.nextAction === 'awaiting_user_input' ||
      decision.nextAction === 'awaiting_handoff_result' ||
      decision.nextAction === 'abandoned'
    ) &&
    STRUCTURED_TOOL_UNAVAILABLE_PATTERN.test(combined)
  ) {
    return {
      signal: 'A_zero_tools',
      rawOutput: combined.slice(0, 220),
      userVisibleMessage:
        `_(Clementine claimed tool access was unavailable but made zero tool calls. ` +
        `The harness will retry and force an actual tool action.)_`,
      detail: {
        kind: 'structured_tool_unavailable',
        rawOutput: combined.slice(0, 220),
        toolCalls,
        onlyProbeTools,
        nextAction: decision.nextAction,
        done: decision.done,
        summary: decision.summary,
      },
    };
  }
  // NARRATION-DEFERRAL stall — the Claude-vs-Codex execution gap.
  // `awaiting_handoff_result` is a vestige of the retired Orchestrator→Executor
  // handoff: in today's single-agent model there is NO executor to hand off to.
  // So a turn that sets it while making ZERO meaningful tool calls (none, or only
  // discovery-ritual probes) has PROMISED imminent action ("On it — running the
  // pull now", "I'll pull 25") and deferred it to a phantom next agent. Left
  // alone, the loop REWARDS that by auto-continuing with a bland nudge, inviting
  // another narration turn — turning one CLI call into N slow model round-trips
  // (observed sess-mqhj058j: a 25-account Salesforce pull that is a single
  // `sf data query` burned a narration turn + a discover-then-defer turn before
  // executing). Codex acts inline; Claude reaches for the defer enum. Force the
  // real tool action THIS turn instead — reuses the zero-tool retry machinery.
  if (noMeaningfulTools && decision.nextAction === 'awaiting_handoff_result') {
    return {
      signal: 'A_zero_tools',
      rawOutput: combined.slice(0, 220),
      userVisibleMessage:
        `_(Clementine said it was acting but made zero tool calls and deferred to a ` +
        `hand-off that no longer exists. The harness will retry and force the actual tool action.)_`,
      detail: {
        kind: 'structured_narration_deferral',
        rawOutput: combined.slice(0, 220),
        toolCalls,
        onlyProbeTools,
        nextAction: decision.nextAction,
        done: decision.done,
        summary: decision.summary,
      },
    };
  }
  if (toolCalls !== 0) return undefined;
  if (
    // `abandoned` is included because a bare "Impossible — abandoning" + zero tools
    // otherwise banks as a clean terminal WITHOUT the objective judge (which only
    // runs on nextAction:'completed') or any blocked-text check — strictly worse
    // than a false `completed` claim (audit 2026-06-16). The same prior-work
    // suppression below still protects a genuine "searched, found nothing,
    // abandoning after real work" answer.
    (decision.nextAction === 'completed' || decision.nextAction === 'abandoned') &&
    STALL_ANNOUNCEMENT_PATTERN.test(combined) &&
    !STALL_REFLECTION_SUPPRESS_PATTERN.test(combined) &&
    // Not a false "zero-tool claim" when the model is REPORTING a genuine
    // completion (done:true) whose work was done in PRIOR turns — a
    // "searched, found nothing" answer makes no NEW tool call but isn't a lie.
    // The genuine target (claims done, did NO work this session) has no prior
    // substantive tool call, so it is NOT suppressed and still fires.
    !(decision.done === true && opts.sessionId && opts.turn !== undefined &&
      sessionDidSubstantiveToolWork(opts.sessionId, opts.turn))
  ) {
    return {
      signal: 'A_zero_tools',
      rawOutput: combined.slice(0, 220),
      userVisibleMessage:
        `_(Clementine claimed action was completed but made zero tool calls. ` +
        `The harness will retry and require the actual tools.)_`,
      detail: {
        kind: 'structured_zero_tool_claim',
        rawOutput: combined.slice(0, 220),
        toolCalls,
        nextAction: decision.nextAction,
        done: decision.done,
        summary: decision.summary,
      },
    };
  }

  return undefined;
}

function turnOnlyUsedToolSurfaceProbeTools(sessionId: string, turn: number): boolean {
  try {
    const toolNames = listEvents(sessionId)
      .filter((event) => event.turn === turn && event.type === 'tool_called')
      .map((event) => {
        const tool = event.data.tool;
        return typeof tool === 'string' ? tool : null;
      })
      .filter((tool): tool is string => Boolean(tool));
    if (toolNames.length === 0) return false;
    return toolNames.every((tool) => TOOL_SURFACE_PROBE_TOOLS.has(tool));
  } catch {
    return false;
  }
}

/**
 * True when the SESSION already did substantive (non-probe) tool work in a
 * STRICTLY-PRIOR turn (`event.turn < turn`). Used to suppress the
 * `structured_zero_tool_claim` stall on a genuine completion that reports the
 * result of earlier work (2026-06-15 Brooke email-find: real Outlook searches
 * in prior turns, then a `done:true` "found nothing" turn was falsely flagged a
 * zero-tool prose claim → 2.5-min thrash → false "unable to make progress").
 * Probe tools (memory/workspace/capability lookups) are EXCLUDED, so "only
 * looked at memory then claimed an external action" is not granted suppression.
 * Fail-OPEN to false — a degraded eventlog must never hide a real "claimed done,
 * did no work" lie. Kill-switch: HARNESS_STALL_PRIOR_WORK=off.
 */
function sessionDidSubstantiveToolWork(sessionId: string, turn: number): boolean {
  if ((getRuntimeEnv('HARNESS_STALL_PRIOR_WORK', 'on') ?? 'on').toLowerCase() === 'off') return false;
  try {
    return listEvents(sessionId, { types: ['tool_called'] }).some((event) => {
      if (typeof event.turn !== 'number' || event.turn >= turn) return false;
      const tool = event.data.tool;
      return typeof tool === 'string' && tool.length > 0 && !TOOL_SURFACE_PROBE_TOOLS.has(tool);
    });
  } catch {
    return false;
  }
}

function finalHandoffProgress(
  sessionId: string,
  turn: number | undefined,
): { from: string | null; to: string | null; toolCallsAfterHandoff: number } | undefined {
  if (!turn) return undefined;
  try {
    const turnEvents = listEvents(sessionId)
      .filter((event) => event.turn === turn);
    let lastHandoffIndex = -1;
    for (let index = turnEvents.length - 1; index >= 0; index -= 1) {
      if (turnEvents[index].type === 'handoff') {
        lastHandoffIndex = index;
        break;
      }
    }
    if (lastHandoffIndex < 0) return undefined;

    const handoff = turnEvents[lastHandoffIndex];
    const afterHandoff = turnEvents.slice(lastHandoffIndex + 1);
    return {
      from: typeof handoff.data.from === 'string' ? handoff.data.from : null,
      to: typeof handoff.data.to === 'string' ? handoff.data.to : null,
      toolCallsAfterHandoff: afterHandoff.filter((event) => event.type === 'tool_called').length,
    };
  } catch {
    return undefined;
  }
}

/**
 * T2.2 — Generalized stall detector. Four signals; first match wins.
 * Called from the no-structured-output branch of runConversation when
 * a sub-agent's turn ended without an OrchestratorDecision, but useful
 * for both the "punted on directive" and "stuck-in-loop" patterns.
 *
 *   Signal A — zero tools + short generic reply ("Continuing.", "OK.").
 *              The legacy detector; still the most common stall shape.
 *   Signal B — identical (toolName, hash(args)) ≥3 times in the last
 *              5 tool_called events for this session. The agent is
 *              re-running the same query expecting different results.
 *   Signal C — same from→to→from handoff pair fires ≥2 times within
 *              the last 8 handoff events. Orchestrator + sub-agent
 *              bouncing the directive back and forth.
 *   Signal D — final output is a stringified OrchestratorDecision
 *              JSON instead of a plain reply. Model over-conformed to
 *              the schema and the SDK exposed it raw.
 */
function evaluateProgress(opts: {
  finalOutput: unknown;
  toolCalls: number;
  sessionId: string;
  turn?: number;
}): StallInfo | undefined {
  const handoffProgress = finalHandoffProgress(opts.sessionId, opts.turn);
  const effectiveToolCalls = handoffProgress?.toolCallsAfterHandoff ?? opts.toolCalls;

  // Signal A — zero tools + short generic reply (current behavior).
  if (effectiveToolCalls === 0 && typeof opts.finalOutput === 'string') {
    const trimmed = opts.finalOutput.trim();
    if (trimmed && trimmed.length <= 60 && STALL_OUTPUT_PATTERN.test(trimmed)) {
      return {
        signal: 'A_zero_tools',
        rawOutput: trimmed,
        userVisibleMessage:
          `_(The sub-agent ended its turn without taking any action. The model said "${trimmed}" but made zero tool calls. ` +
          `Re-send your request with a more specific directive — e.g. name the toolkit, the field, or the file you want it to touch.)_`,
        detail: {
          rawOutput: trimmed,
          toolCalls: effectiveToolCalls,
          totalToolCalls: opts.toolCalls,
          afterHandoff: handoffProgress ?? null,
        },
      };
    }
    // Signal A' — verbose-announcement stall. The model spent a turn
    // describing what it WOULD do without actually doing it. Caught the
    // 2026-05-19 sf data query session (Executor said "Executing the
    // Salesforce pull now — I'll fetch 15 contacts ..." with 0 tool
    // calls). Any time the output is future-tense and zero tools fired,
    // treat it the same as the bare "Continuing." stall — EXCEPT when the
    // reply is a reflective/alignment turn ("you're right — going forward
    // I'll …"), which legitimately has zero tools. Same suppression the
    // structured-decision path already applies (evaluateStructuredDecisionStall);
    // without it, converse-until-aligned replies false-fire a stall retry.
    if (
      trimmed &&
      STALL_ANNOUNCEMENT_PATTERN.test(trimmed) &&
      !STALL_REFLECTION_SUPPRESS_PATTERN.test(trimmed)
    ) {
      return {
        signal: 'A_zero_tools',
        rawOutput: trimmed.slice(0, 220),
        userVisibleMessage:
          `_(The sub-agent announced work it was about to do but didn't actually call the tool. ` +
          `Output: "${trimmed.slice(0, 160)}…". Re-send your request — if it keeps stalling, name the exact tool you want it to use.)_`,
        detail: {
          rawOutput: trimmed.slice(0, 220),
          toolCalls: effectiveToolCalls,
          totalToolCalls: opts.toolCalls,
          afterHandoff: handoffProgress ?? null,
        },
      };
    }
  }

  // Signal D — stringified OrchestratorDecision JSON. Detect a `{...}`
  // shape with the schema's discriminating keys before we look up tool
  // history (cheap structural check first).
  if (typeof opts.finalOutput === 'string') {
    const trimmed = opts.finalOutput.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}') && trimmed.length > 40) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (
          typeof parsed.summary === 'string' &&
          typeof parsed.done === 'boolean' &&
          typeof parsed.nextAction === 'string'
        ) {
          const reply = typeof parsed.reply === 'string' ? parsed.reply : null;
          return {
            signal: 'D_decision_json',
            rawOutput: trimmed.slice(0, 200),
            userVisibleMessage:
              reply && reply.trim()
                ? reply
                : `_(The model produced a structured decision but no user-facing reply. Internal summary: "${(parsed.summary as string).slice(0, 160)}". Re-ask if you wanted a specific result.)_`,
            detail: {
              summary: parsed.summary,
              done: parsed.done,
              nextAction: parsed.nextAction,
              hasReply: !!(reply && reply.trim()),
            },
          };
        }
      } catch {
        /* not JSON-shaped after all — fall through */
      }
    }
  }

  // Signal B — repeated identical tool call. Look at the LAST 5
  // tool_called events for this session; if 3+ share (toolName, args
  // hash), the agent is looping on the same query.
  try {
    const recentToolCalls = listEvents(opts.sessionId, {
      types: ['tool_called'],
    }).slice(-5);
    if (recentToolCalls.length >= 3) {
      const counts = new Map<string, { count: number; toolName: string; argsExcerpt: string }>();
      for (const ev of recentToolCalls as EventRow[]) {
        const data = ev.data as { tool?: unknown; arguments?: unknown };
        const toolName = typeof data.tool === 'string' ? data.tool : 'unknown';
        const args = typeof data.arguments === 'string'
          ? data.arguments
          : data.arguments !== undefined ? JSON.stringify(data.arguments) : '';
        // Tight hash — collapses small whitespace differences but
        // preserves intent. A 60-char fingerprint catches "same query"
        // without false-positives on different keys.
        const key = `${toolName}::${args.slice(0, 200)}`;
        const existing = counts.get(key);
        if (existing) {
          existing.count++;
        } else {
          counts.set(key, { count: 1, toolName, argsExcerpt: args.slice(0, 120) });
        }
      }
      for (const [, info] of counts) {
        if (info.count >= 3) {
          return {
            signal: 'B_repeated_tool',
            userVisibleMessage:
              `_(I'm not making progress — I just re-ran \`${info.toolName}\` with the same arguments ${info.count} times in a row. ` +
              `What did you mean by the request? A different keyword, a specific record id, or a clarification will get past this.)_`,
            detail: {
              toolName: info.toolName,
              argsExcerpt: info.argsExcerpt,
              repeatCount: info.count,
              windowSize: recentToolCalls.length,
            },
          };
        }
      }
    }
  } catch {
    /* event-log query is best-effort */
  }

  // Signal C — handoff ping-pong. Pull the last 8 handoff events and
  // look for `from→to→from` patterns occurring twice or more.
  try {
    const recentHandoffs = listEvents(opts.sessionId, {
      types: ['handoff'],
    }).slice(-8);
    if (recentHandoffs.length >= 4) {
      const pairs = new Map<string, number>();
      // Build sequences of consecutive (from, to) pairs.
      const sequence: string[] = [];
      for (const ev of recentHandoffs as EventRow[]) {
        const d = ev.data as { from?: unknown; to?: unknown };
        const from = typeof d.from === 'string' ? d.from : null;
        const to = typeof d.to === 'string' ? d.to : null;
        if (from && to) sequence.push(`${from}→${to}`);
      }
      // Look for a triple ABA pattern occurring multiple times.
      for (let i = 0; i + 2 < sequence.length; i++) {
        const a = sequence[i];
        const b = sequence[i + 1];
        const c = sequence[i + 2];
        // ABA pattern: from→to→from (a's from === c's to AND a's to === c's from)
        const aFrom = a.split('→')[0]; const aTo = a.split('→')[1];
        const cFrom = c.split('→')[0]; const cTo = c.split('→')[1];
        if (aFrom === cTo && aTo === cFrom) {
          const key = `${aFrom}↔${aTo}`;
          pairs.set(key, (pairs.get(key) ?? 0) + 1);
        }
        // suppress unused warning
        void b;
      }
      for (const [pair, count] of pairs) {
        if (count >= 2) {
          return {
            signal: 'C_handoff_pingpong',
            userVisibleMessage:
              `_(${pair.replace('↔', ' and ')} are handing the work back and forth without making progress. ` +
              `The directive is probably ambiguous — clarify what you want and which agent should own it.)_`,
            detail: {
              agentPair: pair,
              repeatCount: count,
              windowSize: recentHandoffs.length,
            },
          };
        }
      }
    }
  } catch {
    /* best effort */
  }

  return undefined;
}

/**
 * Legacy alias — kept so existing call sites + tests don't break while
 * we migrate to evaluateProgress's discriminated signal output.
 */
function detectSubAgentStall(finalOutput: unknown, toolCalls: number, sessionId?: string): StallInfo | undefined {
  return evaluateProgress({
    finalOutput,
    toolCalls,
    sessionId: sessionId ?? '',
  });
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

const STRUCTURED_OUTPUT_RECOVERY_FALLBACK =
  "Clementine produced a response that couldn't be structured. Please ask again.";

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
  const onChunk = (opts as unknown as { onChunk?: (delta: string) => void | Promise<void> })?.onChunk;
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
  // sess-mqg45an3) re-runs cleanly because zero events means zero tool side
  // effects, so the user self-heals in seconds instead of hanging 5 min. Once
  // content has flowed, the longer modelStreamStallMs ceiling governs and a
  // stall is a hard failure (no replay — content was already emitted).
  const streamMs = modelStreamStallMs();
  const firstByteMs = modelFirstByteStallMs();
  const maxStallRetries = modelStreamStallRetries();
  // result is reassigned per attempt; the post-drain code reads the winner.
  let result!: Awaited<ReturnType<typeof run>>;
  let structuredOutputFailed = false;
  // The id of the ACTIVE attempt. After a pre-content stall + retry, the
  // abandoned stream keeps draining for a beat (its cancel isn't instant); if
  // its late tokens reach the shared onChunk they INTERLEAVE with the live
  // attempt's tokens in the user's SSE (observed as garbled output like
  // "importportance" on a recovered heavy turn). Gating onChunk on this id —
  // and capturing `result` per attempt — keeps a superseded stream silent.
  let activeAttempt = 0;
  for (let attempt = 0; ; attempt += 1) {
    activeAttempt = attempt;
    result = await run(agent, items, { ...opts, stream: true });
    const myResult = result;
    const myAttempt = attempt;
    const iterable = Symbol.asyncIterator in (myResult as unknown as Record<symbol, unknown>);
    let lastEventAt = Date.now();
    let yieldedContent = false;
    const drain = (async () => {
      if (iterable) {
        for await (const event of myResult as unknown as AsyncIterable<unknown>) {
          lastEventAt = Date.now();
          const ev = event as { type?: string; data?: { type?: string; delta?: string } };
          // Content or tool activity flips us past the pre-content window.
          if (ev.type === 'run_item_stream_event' || (ev.type === 'raw_model_stream_event' && ev.data?.type === 'output_text_delta')) {
            yieldedContent = true;
          }
          if (onChunk && myAttempt === activeAttempt && ev.type === 'raw_model_stream_event' && ev.data?.type === 'output_text_delta' && typeof ev.data.delta === 'string') {
            try {
              await onChunk(ev.data.delta);
            } catch {
              // never let consumer errors abort the stream
            }
          }
        }
      }
      await myResult.completed;
    })();
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      if (!iterable || streamMs <= 0) return; // mocks / kill-switch: no watchdog
      const tickMs = Math.min(15_000, Math.max(250, Math.floor(Math.min(firstByteMs, streamMs) / 4)));
      stallTimer = setInterval(() => {
        const win = yieldedContent ? streamMs : firstByteMs;
        if (Date.now() - lastEventAt > win) {
          if (stallTimer) clearInterval(stallTimer);
          // Best-effort: release the underlying stream so the dangling
          // request doesn't pin sockets after we abandon the turn.
          try { (myResult as unknown as { cancel?: () => void }).cancel?.(); } catch { /* best-effort */ }
          reject(new ModelStreamStalledError(Math.round(win / 1000), !yieldedContent));
        }
      }, tickMs);
      // Deliberately NOT unref'd: while a turn is in flight the watchdog IS
      // pending work — an unref'd timer could let a bare process exit before
      // the stall fires. It self-clears on drain completion or stall.
    });
    void drain.finally(() => { if (stallTimer) clearInterval(stallTimer); }).catch(() => { /* surfaced via race */ });
    try {
      await Promise.race([drain, watchdog]);
      break; // turn drained successfully
    } catch (err) {
      // A pre-content stall is retryable: nothing streamed, so no tool ran and
      // no partial reply reached the user — re-run cleanly before giving up.
      if (err instanceof ModelStreamStalledError && err.preContent && attempt < maxStallRetries) {
        console.warn(`[harness] model stream stalled pre-content after ${err.seconds}s — retrying (attempt ${attempt + 1}/${maxStallRetries})`);
        continue;
      }
      if (!isStructuredOutputError(err)) throw err;
      structuredOutputFailed = true;
      console.warn('[harness] structured output failed to parse/validate — ending turn with raw text',
        err instanceof Error ? err.message : err);
      break;
    }
  }

  let history: AgentInputItem[] = [];
  try { history = result.history; } catch { history = []; }

  let finalOutput: unknown;
  if (structuredOutputFailed) {
    finalOutput = assistantItemText(findLatestAssistantMessage(history)) ?? STRUCTURED_OUTPUT_RECOVERY_FALLBACK;
  } else {
    try {
      finalOutput = result.finalOutput;
    } catch (err) {
      if (!isStructuredOutputError(err)) throw err;
      structuredOutputFailed = true;
      console.warn('[harness] finalOutput failed to parse/validate — ending turn with raw text',
        err instanceof Error ? err.message : err);
      finalOutput = assistantItemText(findLatestAssistantMessage(history)) ?? STRUCTURED_OUTPUT_RECOVERY_FALLBACK;
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
