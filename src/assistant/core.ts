import { randomUUID } from 'node:crypto';
import { MODELS } from '../config.js';
import { analyzeExecutionIntent, buildExecutionPromptBlock, parseExecutionResponse } from '../execution/intake.js';
import { ExecutionStore } from '../execution/store.js';
import { assemblePromptContextAsync } from '../memory/context.js';
import { refreshSessionBrief } from '../memory/session-briefs.js';
import { SessionStore } from '../memory/session-store.js';
import type { AssistantRequest, AssistantResponse, RunResult } from '../types.js';
import { PlanStore } from '../planning/plan-store.js';
import { refreshWorkingMemory, reconcileActiveTask } from '../memory/working-memory.js';
import { captureInteractionSignals } from '../memory/auto-capture.js';
import { refineActivePlanFromMessage } from '../planning/refinement.js';
import { buildAssistantInstructions, buildTurnContextBlock } from './instructions.js';
import { AgentRuntimeCancelledError, ASSISTANT_PAUSED_PLACEHOLDER, type AgentRuntime } from '../runtime/provider.js';
import { addRunEvent } from '../runtime/run-events.js';
import { isUserFacingSession, looksLikeInternalPrompt } from '../execution/scope.js';
import { classifyMessageIntent } from './message-intent.js';

/**
 * v0.5.21 Phase 2 — default wall-clock budget for chat turns.
 *
 * Workflows and controller decisions both pass an explicit
 * maxWallClockMs (`WORKFLOW_STEP_WALL_CLOCK_MS`,
 * `CONTROLLER_DECISION_WALL_CLOCK_MS`). Chat callers (Discord DM,
 * dashboard) historically passed nothing, so a hung Codex SSE stream
 * had no end-to-end budget and a stalled call could sit indefinitely
 * (verified 2026-05-25 — sess-mplfm14j-f0985a98 hung 3+ minutes).
 *
 * 120s is the backstop AFTER the codex-dispatcher transport timeouts
 * (15s headers / 30s body). Most chat-side hangs surface in 15-30s
 * via undici; this wall-clock only fires for an exotic "slow drip"
 * where small bytes flow steadily but the turn exceeds 2 minutes.
 *
 * Discord's deferReply interaction window is 15 minutes, so 2 minutes
 * leaves plenty of room for legitimate long-thinking responses while
 * still aborting indefinite stalls.
 */
export const CHAT_WALL_CLOCK_MS = 120_000;

/**
 * P0-B — per-call wall-clock for NON-interactive turns. The 120s chat budget
 * above is a Discord slow-drip backstop; applied to a background/execution
 * synthesis turn it guillotines a legitimate >2-min generation (the 2026-06-04
 * email-audit abort). Non-interactive channels get real headroom, mirroring the
 * workflow step budget. Env-tunable; floored at 60s. An explicit caller
 * override (`request.maxWallClockMs`) always wins over this default.
 */
const NON_INTERACTIVE_WALL_CLOCK_MS = (() => {
  const raw = parseInt(process.env.CLEMENTINE_BACKGROUND_STEP_WALL_MS || '', 10);
  return Number.isNaN(raw) ? 10 * 60_000 : Math.max(60_000, raw);
})();

// 'agent' is the channel the autonomy loop actually uses (autonomy.ts); the
// earlier 'autonomy' entry was dead. background/workflow pass an explicit
// maxWallClockMs that always wins, so they're here only as a defensive default
// for any caller that forgets one. The load-bearing entries are 'cron' + 'agent'.
const NON_INTERACTIVE_CHANNELS = new Set([
  'background', 'workflow', 'execution', 'controller', 'cron', 'agent',
]);

/** P0-B — pick the per-call wall-clock default by channel: snappy 120s for
 *  interactive chat/discord/dashboard, real headroom for non-interactive
 *  autonomous channels. Defense-in-depth for callers that don't pass an
 *  explicit `maxWallClockMs` (background-tasks does; the execution controller
 *  / cron / autonomy paths may not). */
function defaultWallClockForChannel(channel?: string): number {
  return channel && NON_INTERACTIVE_CHANNELS.has(channel)
    ? NON_INTERACTIVE_WALL_CLOCK_MS
    : CHAT_WALL_CLOCK_MS;
}

function shouldUseExecutionTracking(request: AssistantRequest): boolean {
  return isUserFacingSession(request.sessionId, request.channel) &&
    !looksLikeInternalPrompt(request.message);
}

export class ClementineAssistant {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly sessions = new SessionStore(),
    private readonly plans = new PlanStore(),
    private readonly executions = new ExecutionStore(),
  ) {}

  getRuntime(): AgentRuntime {
    return this.runtime;
  }

  createSessionId(): string {
    return randomUUID();
  }

  async respond(request: AssistantRequest): Promise<AssistantResponse> {
    const sessionBeforeReply = this.sessions.appendTurn(
      request.sessionId,
      {
        role: 'user',
        text: request.message,
        createdAt: new Date().toISOString(),
      },
      request.userId,
      request.channel,
    );
    refineActivePlanFromMessage(request.sessionId, request.message);
    const executionTrackingEnabled = shouldUseExecutionTracking(request);
    if (executionTrackingEnabled) {
      const captured = captureInteractionSignals({
        message: request.message,
        sessionId: request.sessionId,
      });
      if (request.runId && (captured.candidates.length > 0 || captured.profilePatch)) {
        // Facts are consolidated asynchronously through the Mem0 resolver
        // now, so committed row ids aren't known here — report the
        // captured candidate signals instead.
        addRunEvent(request.runId, {
          type: 'status',
          message: `Captured ${captured.candidates.length} durable memory signal${captured.candidates.length === 1 ? '' : 's'}${captured.profilePatch ? ' and updated profile preferences' : ''}.`,
          data: {
            profilePatch: captured.profilePatch,
            reasons: captured.candidates.map((candidate) => candidate.reason),
          },
        });
      }
    }
    const activeExecutionBeforeReply = executionTrackingEnabled
      ? this.executions.getActiveForSession(request.sessionId)
      : undefined;
    if (activeExecutionBeforeReply?.planId) {
      const plan = this.plans.get(activeExecutionBeforeReply.planId);
      if (plan) {
        this.executions.syncWithPlan(activeExecutionBeforeReply.id, plan);
      }
    }
    refreshSessionBrief(sessionBeforeReply);

    if (executionTrackingEnabled) {
      // Pin a stated action constraint (recipient list / count / "only these")
      // synchronously, BEFORE context assembly reads working memory below, so the
      // binding spec is visible on THIS turn and survives the conversation. No
      // queueMicrotask — it must be on disk before assemblePromptContextAsync.
      reconcileActiveTask(request.sessionId, request.message);
    }

    const messageIntent = classifyMessageIntent(request.message);
    const casualCheckIn = messageIntent.intent === 'casual';
    const lightContext = casualCheckIn || messageIntent.intent === 'meta_clarify';
    // Hoisted above transcriptDepth: a mid-task "ok"/"perfect"/"got it"
    // classifies casual, but collapsing the transcript to 1 turn drops the
    // thread it's confirming. Floor the depth when there's in-flight tracked
    // work so a confirmation keeps continuity; a true standalone greeting (no
    // active execution) stays at the cheap depth — byte-identical to before.
    const activeExecution = executionTrackingEnabled
      ? this.executions.getActiveForSession(request.sessionId)
      : undefined;
    const hasInflight = Boolean(activeExecution);
    const transcriptDepth = casualCheckIn
      ? (hasInflight ? 6 : 1)
      : messageIntent.intent === 'meta_clarify'
        ? (hasInflight ? 6 : 3)
        : 12;
    const transcriptBeforeReply = this.sessions.recentTranscript(request.sessionId, transcriptDepth);
    // ExecutionIntent only matters when the user is asking for action
    // or continuing tracked work. Skip the keyword scoring entirely
    // for casual / lookup / meta turns — saves a scan and avoids
    // false-positive execution wrapping.
    const shouldAnalyzeExecution = executionTrackingEnabled
      && !lightContext
      && (messageIntent.intent === 'action' || messageIntent.intent === 'tool_intent' || activeExecution);
    const executionIntent = shouldAnalyzeExecution
      ? analyzeExecutionIntent(request.message, activeExecution)
      : undefined;
    const executionPrompt = executionIntent ? buildExecutionPromptBlock(executionIntent, activeExecution) : '';
    const { memoryContext, retrievalText } = await assemblePromptContextAsync(request.sessionId, request.message, transcriptBeforeReply);
    const instructions = buildAssistantInstructions(memoryContext, request.channel, messageIntent.intent, request.message);
    // Tiered context (flag on): the dynamic per-turn blocks (facts, tool-choices,
    // working-memory, …) ride the per-turn input tail instead of the cached
    // system prompt. '' when the flag is off → promptParts byte-identical to legacy.
    const turnContext = buildTurnContextBlock(memoryContext, messageIntent.intent, request.message);

    const promptParts = [
      request.channel ? `Channel: ${request.channel}` : '',
      transcriptBeforeReply ? `Recent transcript:\n${transcriptBeforeReply}` : '',
      retrievalText ? `Relevant vault context:\n${retrievalText}` : '',
      turnContext,
      executionPrompt,
      `Latest user message:\n${request.message}`,
    ].filter(Boolean);

    // Finalizer contract: respond() always resolves with non-empty
    // text and a typed stoppedReason. The runtime substitutes the
    // ASSISTANT_PAUSED_PLACEHOLDER on empty success internally; this
    // block also catches thrown errors and any empty-text slip-through
    // so channel adapters never have to handle '' or rethrow. Zero
    // extra model tokens — pure local plumbing.
    let result: RunResult;
    try {
      result = await this.runtime.run({
        instructions,
        model: request.model ?? MODELS.primary,
        prompt: promptParts.join('\n\n'),
        sessionId: request.sessionId,
        userId: request.userId,
        channel: request.channel,
        maxWallClockMs: request.maxWallClockMs ?? defaultWallClockForChannel(request.channel),
        excludeToolNames: request.excludeToolNames,
      }, {
        shouldCancel: request.shouldCancel,
        onToolActivity: async (activity) => {
          if (request.runId) {
            addRunEvent(request.runId, {
              type: 'tool_started',
              message: `Using tool: ${activity.toolName}`,
              data: {
                toolName: activity.toolName,
                input: activity.input,
              },
            });
          }
          await request.onToolActivity?.(activity);
        },
        onChunk: request.onChunk ? async (delta) => {
          // Forward streaming deltas to the caller. Don't capture them
          // into run events — the deltas accumulate, and the final text
          // is already recorded after the run returns.
          await request.onChunk?.(delta);
        } : undefined,
        onReasoning: async (text) => {
          // Reasoning is captured into the run timeline regardless of
          // whether the caller subscribed — it's the observability hook.
          if (request.runId) {
            addRunEvent(request.runId, {
              type: 'status',
              message: `Reasoning: ${text.slice(0, 200)}`,
              data: { reasoningChars: text.length, preview: text.slice(0, 1000) },
            });
          }
          await request.onReasoning?.(text);
        },
        onText: async () => {
          // Final text is recorded by the gateway/background task after the run returns.
        },
      });
    } catch (err) {
      // A runtime throw used to surface as channel-side silence — the
      // caller would catch and either retry, send a generic "internal
      // error", or in the worst case crash mid-reply. Convert to a
      // typed RunResult so the contract holds.
      const cancelled = err instanceof AgentRuntimeCancelledError;
      const message = err instanceof Error ? err.message : String(err);
      if (request.runId) {
        addRunEvent(request.runId, {
          type: 'status',
          message: cancelled ? 'Run cancelled mid-turn.' : `Runtime error: ${message.slice(0, 200)}`,
        });
      }
      result = {
        text: cancelled
          ? 'Run cancelled before I could finish — ask again to resume.'
          : `I hit a runtime error and couldn't finish the reply: ${message.slice(0, 400)}`,
        stoppedReason: cancelled ? 'cancelled' : 'error',
      };
    }

    if (!result.text || result.text.trim() === '') {
      // Defense-in-depth. The two production runtimes already
      // substitute the placeholder, but a future runtime or plugin
      // could slip an empty string through. Channels (Discord
      // especially) reject empty messages, so guarantee a body.
      result = { ...result, text: ASSISTANT_PAUSED_PLACEHOLDER, stoppedReason: result.stoppedReason ?? 'error' };
    }

    if (executionPrompt && executionIntent) {
      const parsed = parseExecutionResponse(result.text);
      const shouldPersistExecution = executionIntent.shouldTrack && parsed.steps.length >= 3;
      let execution = activeExecution;
      let plan = execution?.planId ? this.plans.get(execution.planId) : undefined;

      if (!plan && shouldPersistExecution) {
        plan = this.plans.create(
          parsed.objective ?? executionIntent.title,
          parsed.steps,
          { sessionId: request.sessionId, source: 'execution' },
        );
      }

      if (!execution && shouldPersistExecution) {
        execution = this.executions.create({
          sessionId: request.sessionId,
          userId: request.userId,
          channel: request.channel,
          title: executionIntent.title,
          objective: parsed.objective ?? request.message,
          reason: parsed.reason ?? (executionIntent.reasons.join('; ') || 'Promoted from conversation into tracked execution.'),
          startedFromMessage: request.message,
          confidence: executionIntent.confidence,
          reasons: executionIntent.reasons,
          planId: plan?.id,
          nextStep: parsed.nextStep ?? plan?.steps.find((step) => step.status === 'in_progress')?.text,
          successCriteria: parsed.successCriteria,
          lastAssistantSummary: parsed.summary ?? result.text.slice(0, 400),
          nextReviewAt: new Date().toISOString(),
        });
      } else if (execution) {
        execution = this.executions.update(execution.id, {
          title: execution.title,
          objective: parsed.objective ?? execution.objective,
          reason: parsed.reason ?? execution.reason,
          planId: plan?.id ?? execution.planId,
          nextStep: parsed.nextStep ?? execution.nextStep,
          successCriteria: parsed.successCriteria ?? execution.successCriteria,
          lastAssistantSummary: parsed.summary ?? result.text.slice(0, 400),
          nextReviewAt: new Date().toISOString(),
          confidence: executionIntent.confidence,
          reasons: executionIntent.reasons.length > 0 ? executionIntent.reasons : execution.reasons,
        });
      }

      if (execution && plan) {
        this.executions.syncWithPlan(execution.id, plan);
      }
    }

    const updatedSession = this.sessions.appendTurn(request.sessionId, {
      role: 'assistant',
      text: result.text,
      createdAt: new Date().toISOString(),
    });
    refreshSessionBrief(updatedSession);
    refreshWorkingMemory(updatedSession);

    return {
      text: result.text,
      sessionId: request.sessionId,
      pendingApprovalId: result.pendingApprovalId,
      // Bubble the runtime's typed terminal state up to channels so
      // they can render appropriate affordances (Continue button on
      // 'max-turns-with-grace', etc.).
      stoppedReason: result.stoppedReason,
      turnsUsed: result.turnsUsed,
    };
  }
}
