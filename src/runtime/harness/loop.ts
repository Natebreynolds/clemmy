import type { Agent, AgentInputItem } from '@openai/agents';
import { Runner } from '@openai/agents';
import { HarnessSession } from './session.js';
import {
  appendEvent,
  getSession,
  listEvents,
  openEventLog,
  type AppendEventInput,
  type EventRow,
  type SessionRow,
} from './eventlog.js';
import {
  assertNotKilled,
  KillRequested,
  ToolCallsCounter,
  ToolCallsLimitExceeded,
  maxTurnsForRole,
  defaultToolCallsPerTurn,
  withHarnessRunContext,
} from './brackets.js';
import { getHarnessBudgetSettings } from './budget-settings.js';
import { attachEventLogHooks, extractSessionIdFromContext, type RunHooksLike } from './hooks.js';
import * as approvalRegistry from './approval-registry.js';
import { actionBus } from '../action-bus.js';
import { BoundaryError } from '../boundary-error.js';
import { getRuntimeEnv } from '../../config.js';

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
      err: err instanceof Error ? err.message : String(err),
    });
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
    } catch (err) {
      // Best-effort. The hot-patch flow today exercises a DB where the
      // table may be missing if migrations didn't run yet; we don't
      // want to fail the whole approval pause on a registry write.
      console.error('[harness] approval-registry.register failed (continuing without ID)', {
        sessionId: options.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (approvalId) approvalIds.push(approvalId);
    safeAppend({
      sessionId: options.sessionId,
      turn: options.turn,
      role: 'orchestrator',
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
}

export type RunTurnStatus = 'completed' | 'awaiting_approval' | 'killed' | 'limit_exceeded' | 'failed';

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
  /** Test injection. */
  makeRunner?: () => Runner;
  /** Test injection. */
  runRunner?: RunRunnerFn;
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

export async function runConversation(
  options: RunConversationOptions,
): Promise<RunConversationResult> {
  const result = await runConversationCore(options);
  emitRuntimeTerminalEvent(options.sessionId, result);
  return result;
}

async function runConversationCore(
  options: RunConversationOptions,
): Promise<RunConversationResult> {
  const budget = getHarnessBudgetSettings();
  let maxSteps = options.maxSteps ?? budget.maxConversationSteps;
  if (options.maxSteps === undefined && budget.autoContinueOnLimit) {
    maxSteps = Math.max(maxSteps, 1_000_000);
  }
  const maxWallMs = options.maxWallClockMs ?? budget.maxConversationWallMs;
  const maxTurns = options.maxTurns ?? budget.maxTurns;
  const toolCallsPerTurn = options.toolCallsPerTurn ?? budget.toolCallsPerTurn;
  const checkInMs = Math.max(60_000, budget.checkInMinutes * 60 * 1000);
  const startedAt = Date.now();
  let lastCheckInAt = startedAt;

  let stepIndex = 0;
  let nextInput = options.input;
  let lastDecision: OrchestratorDecisionShape | undefined;
  let lastTurn = 0;

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
    });
    lastTurn = turnResult.turn;

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
      role: 'orchestrator',
      type: 'conversation_step',
      data: {
        step: stepIndex,
        decision: decision ?? null,
      },
    });

    if (!decision) {
      // No structured decision = nothing to recurse on. End cleanly.
      // This usually means a handoff target (Executor/Researcher/etc.)
      // became the final agent on the run, so the Orchestrator's
      // outputType never applied. The sub-agent's raw final output IS
      // the user-facing answer — surface it as the summary so the UI
      // has something to render instead of just "complete".
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

    if (decision.done) {
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
      const userVisibleSummary = hasReply
        ? decision.reply!
        : isCompletedAction
          ? `(The model marked the turn complete without producing a user-facing reply. This is a bug. Internal log: ${decision.summary})`
          : decision.summary;
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
      return {
        sessionId: options.sessionId,
        status: 'awaiting_user_input',
        steps: stepIndex,
        lastDecision: decision,
        lastTurn,
      };
    }
    if (decision.nextAction === 'awaiting_approval') {
      // The SDK-level interrupt path normally handles this via
      // turnResult.status. If we end up here it means the Orchestrator
      // self-reported the state without triggering needsApproval. Honor
      // its declaration and stop.
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
  return {
    summary: v.summary,
    reply: typeof v.reply === 'string' && v.reply.trim() ? v.reply : null,
    done: v.done,
    nextAction: v.nextAction as OrchestratorDecisionShape['nextAction'],
    reason: typeof v.reason === 'string' ? v.reason : null,
  };
}

// ---------- public API ----------

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
  const useToolWrapper = process.env.HARNESS_TOOL_BRACKETS === 'on';
  if (!useToolWrapper) {
    (runner as unknown as RunHooksLike).on(
      'agent_tool_start',
      onToolStart as (...args: unknown[]) => void,
    );
  }

  const items: AgentInputItem[] = [
    ...session.toInputItems(),
    { role: 'user', content: options.input },
  ];

  const opts: Record<string, unknown> = {
    context: { sessionId: options.sessionId, turn },
    maxTurns: options.maxTurns ?? maxTurnsForRole('orchestrator'),
  };
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
        if (useToolWrapper) {
          return await withHarnessRunContext(
            { sessionId: options.sessionId, counter: toolCounter },
            () => run(runner, options.agent, items, opts),
          ) as RunOutcome;
        }
        return await run(runner, options.agent, items, opts);
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

    session.recordTurnResult({
      history: outcome.history,
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
    session.markStatus('completed');
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
  decision: 'approve' | 'reject';
  maxTurns?: number;
  toolCallsPerTurn?: number;
  /** Test injection. */
  makeRunner?: () => Runner;
  /** Test injection: drive the resume with a pre-built outcome. */
  runRunner?: RunRunnerFn;
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
    const message = err instanceof Error ? err.message : String(err);
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
  for (const item of pending) {
    if (options.decision === 'approve') {
      stateApi.approve(item);
    } else {
      stateApi.reject(item);
    }
    const raw = (item as { rawItem?: { name?: string } } | null)?.rawItem;
    safeAppend({
      sessionId: options.sessionId,
      turn,
      role: 'system',
      type: 'approval_resolved',
      data: { decision: options.decision, tool: raw?.name ?? 'unknown' },
    });
  }
  safeAppend({
    sessionId: options.sessionId,
    turn,
    role: 'system',
    type: 'run_resumed',
    data: { pending: pending.length, decision: options.decision },
  });
  session.clearInterruptState();

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
  const useToolWrapper = process.env.HARNESS_TOOL_BRACKETS === 'on';
  if (!useToolWrapper) {
    (runner as unknown as RunHooksLike).on(
      'agent_tool_start',
      onToolStart as (...args: unknown[]) => void,
    );
  }

  const opts: Record<string, unknown> = {
    context: { sessionId: options.sessionId, turn },
    maxTurns: options.maxTurns ?? maxTurnsForRole('orchestrator'),
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

    session.recordTurnResult({
      history: outcome.history,
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
    session.markStatus('completed');
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
  decision: 'approve' | 'reject';
  maxSteps?: number;
  maxWallClockMs?: number;
  maxTurns?: number;
  toolCallsPerTurn?: number;
  makeRunner?: () => Runner;
  runRunner?: RunRunnerFn;
}): Promise<RunConversationResult> {
  const result = await runConversationFromResumeCore(opts);
  emitRuntimeTerminalEvent(opts.sessionId, result);
  return result;
}

async function runConversationFromResumeCore(opts: {
  agent: Agent<any, any>;
  sessionId: string;
  decision: 'approve' | 'reject';
  maxSteps?: number;
  maxWallClockMs?: number;
  maxTurns?: number;
  toolCallsPerTurn?: number;
  makeRunner?: () => Runner;
  runRunner?: RunRunnerFn;
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

  // Step 1: resume the paused approval.
  const firstResult = await resumePendingApproval({
    agent: opts.agent,
    sessionId: opts.sessionId,
    decision: opts.decision,
    maxTurns,
    toolCallsPerTurn,
    makeRunner: opts.makeRunner,
    runRunner: opts.runRunner,
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
    if (!decision || decision.done) {
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
    if (decision.nextAction === 'awaiting_user_input') {
      return {
        sessionId: opts.sessionId,
        status: 'awaiting_user_input',
        steps: stepIndex,
        lastDecision: decision,
        lastTurn,
      };
    }
    if (decision.nextAction === 'awaiting_approval') {
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
      input: CONTINUATION_INPUT,
      maxTurns,
      toolCallsPerTurn,
      makeRunner: opts.makeRunner,
      runRunner: opts.runRunner,
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
      role: 'orchestrator',
      type: 'conversation_step',
      data: { step: stepIndex, decision: decision ?? null },
    });
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
    return true;
  }
}

function handleRunError(
  sessionId: string,
  turn: number,
  session: HarnessSession,
  err: unknown,
): RunTurnResult {
  if (err instanceof KillRequested) {
    safeAppend({
      sessionId,
      turn,
      role: 'system',
      type: 'kill_requested',
      data: { reason: 'during run' },
    });
    session.markStatus('cancelled');
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
  const message = err instanceof Error ? err.message : String(err);
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

// Verbose-announcement stall: the model produced future-tense
// language describing work it's about to do, but didn't actually call
// any tool to do it. Example: "Executing the Salesforce pull now —
// I'll fetch 15 contacts ..." with 0 tool calls. This is a louder
// version of "Continuing." and just as broken.
const STALL_ANNOUNCEMENT_PATTERN = /\b(I[' ]?ll\s|let me\s|executing\s|fetching\s|running\s|pulling\s|querying\s|about to\s|going to\s|on the way|in progress|kicking off|starting now)/i;

export type StallSignal = 'A_zero_tools' | 'B_repeated_tool' | 'C_handoff_pingpong' | 'D_decision_json';

interface StallInfo {
  signal: StallSignal;
  rawOutput?: string;
  userVisibleMessage: string;
  /** Structured detail for the stuck_detected event / dashboard panel. */
  detail: Record<string, unknown>;
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
}): StallInfo | undefined {
  // Signal A — zero tools + short generic reply (current behavior).
  if (opts.toolCalls === 0 && typeof opts.finalOutput === 'string') {
    const trimmed = opts.finalOutput.trim();
    if (trimmed && trimmed.length <= 60 && STALL_OUTPUT_PATTERN.test(trimmed)) {
      return {
        signal: 'A_zero_tools',
        rawOutput: trimmed,
        userVisibleMessage:
          `_(The sub-agent ended its turn without taking any action. The model said "${trimmed}" but made zero tool calls. ` +
          `Re-send your request with a more specific directive — e.g. name the toolkit, the field, or the file you want it to touch.)_`,
        detail: { rawOutput: trimmed, toolCalls: 0 },
      };
    }
    // Signal A' — verbose-announcement stall. The model spent a turn
    // describing what it WOULD do without actually doing it. Caught the
    // 2026-05-19 sf data query session (Executor said "Executing the
    // Salesforce pull now — I'll fetch 15 contacts ..." with 0 tool
    // calls). Any time the output is future-tense and zero tools fired,
    // treat it the same as the bare "Continuing." stall.
    if (trimmed && STALL_ANNOUNCEMENT_PATTERN.test(trimmed)) {
      return {
        signal: 'A_zero_tools',
        rawOutput: trimmed.slice(0, 220),
        userVisibleMessage:
          `_(The sub-agent announced work it was about to do but didn't actually call the tool. ` +
          `Output: "${trimmed.slice(0, 160)}…". Re-send your request — if it keeps stalling, name the exact tool you want it to use.)_`,
        detail: { rawOutput: trimmed.slice(0, 220), toolCalls: 0 },
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
const defaultRunRunner: RunRunnerFn = async (runner, agent, items, opts) => {
  type StreamedResultLike = {
    history: AgentInputItem[];
    lastResponseId: string | undefined;
    finalOutput: unknown;
    interruptions?: unknown[];
    state?: { toString(): string };
    completed: Promise<void>;
  };
  type RunMethod = (
    a: typeof agent,
    i: typeof items,
    o: typeof opts,
  ) => Promise<StreamedResultLike>;
  const run = runner.run.bind(runner) as unknown as RunMethod;
  const result = await run(agent, items, { ...opts, stream: true });
  // StreamedRunResult exposes a `completed` promise that resolves
  // once the SSE stream has been fully drained and the state machine
  // is settled. Without awaiting it, finalOutput/interruptions read
  // stale (undefined) values and the SDK logs a warning.
  await result.completed;
  const hasInterruptions = Array.isArray(result.interruptions) && result.interruptions.length > 0;
  return {
    history: result.history,
    lastResponseId: result.lastResponseId,
    finalOutput: result.finalOutput,
    hasInterruptions,
    interruptions: hasInterruptions ? extractInterruptionInfo(result.interruptions ?? []) : undefined,
    serializedState: hasInterruptions ? result.state?.toString() : undefined,
  };
};

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

/** Heuristic: pull a human-readable subject out of the tool args. */
function extractApprovalSubject(info: InterruptionInfo): string {
  const args = info.args ?? {};
  if (typeof args.subject === 'string') return args.subject;
  if (typeof args.title === 'string') return args.title;
  if (typeof args.action === 'string') return args.action;
  return info.toolName;
}
