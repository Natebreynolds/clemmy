import { randomUUID } from 'node:crypto';
import { MODELS } from '../config.js';
import { analyzeExecutionIntent, buildExecutionPromptBlock, parseExecutionResponse } from '../execution/intake.js';
import { ExecutionStore } from '../execution/store.js';
import { assemblePromptContextAsync } from '../memory/context.js';
import { refreshSessionBrief } from '../memory/session-briefs.js';
import { SessionStore } from '../memory/session-store.js';
import type { AssistantRequest, AssistantResponse, RunResult } from '../types.js';
import { PlanStore } from '../planning/plan-store.js';
import { refreshWorkingMemory } from '../memory/working-memory.js';
import { captureInteractionSignals } from '../memory/auto-capture.js';
import { refineActivePlanFromMessage } from '../planning/refinement.js';
import { buildAssistantInstructions } from './instructions.js';
import { AgentRuntimeCancelledError, ASSISTANT_PAUSED_PLACEHOLDER, type AgentRuntime } from '../runtime/provider.js';
import { addRunEvent } from '../runtime/run-events.js';
import { isUserFacingSession, looksLikeInternalPrompt } from '../execution/scope.js';
import { classifyMessageIntent } from './message-intent.js';

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
      if (request.runId && (captured.facts.length > 0 || captured.profilePatch)) {
        addRunEvent(request.runId, {
          type: 'status',
          message: `Captured ${captured.facts.length} durable memory signal${captured.facts.length === 1 ? '' : 's'}${captured.profilePatch ? ' and updated profile preferences' : ''}.`,
          data: {
            factIds: captured.facts.map((fact) => fact.id),
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

    const messageIntent = classifyMessageIntent(request.message);
    const casualCheckIn = messageIntent.intent === 'casual';
    const lightContext = casualCheckIn || messageIntent.intent === 'meta_clarify';
    const transcriptDepth = casualCheckIn ? 1 : messageIntent.intent === 'meta_clarify' ? 3 : 12;
    const transcriptBeforeReply = this.sessions.recentTranscript(request.sessionId, transcriptDepth);
    const activeExecution = executionTrackingEnabled
      ? this.executions.getActiveForSession(request.sessionId)
      : undefined;
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
    const instructions = buildAssistantInstructions(memoryContext, request.channel, messageIntent.intent);

    const promptParts = [
      request.channel ? `Channel: ${request.channel}` : '',
      transcriptBeforeReply ? `Recent transcript:\n${transcriptBeforeReply}` : '',
      retrievalText ? `Relevant vault context:\n${retrievalText}` : '',
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
        maxWallClockMs: request.maxWallClockMs,
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
