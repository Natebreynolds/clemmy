import { randomUUID } from 'node:crypto';
import { MODELS } from '../config.js';
import { analyzeExecutionIntent, buildExecutionPromptBlock, parseExecutionResponse } from '../execution/intake.js';
import { ExecutionStore } from '../execution/store.js';
import { assemblePromptContextAsync } from '../memory/context.js';
import { refreshSessionBrief } from '../memory/session-briefs.js';
import { SessionStore } from '../memory/session-store.js';
import type { AssistantRequest, AssistantResponse } from '../types.js';
import { PlanStore } from '../planning/plan-store.js';
import { refreshWorkingMemory } from '../memory/working-memory.js';
import { refineActivePlanFromMessage } from '../planning/refinement.js';
import { buildAssistantInstructions } from './instructions.js';
import type { AgentRuntime } from '../runtime/provider.js';
import { addRunEvent } from '../runtime/run-events.js';

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
    const activeExecutionBeforeReply = this.executions.getActiveForSession(request.sessionId);
    if (activeExecutionBeforeReply?.planId) {
      const plan = this.plans.get(activeExecutionBeforeReply.planId);
      if (plan) {
        this.executions.syncWithPlan(activeExecutionBeforeReply.id, plan);
      }
    }
    refreshSessionBrief(sessionBeforeReply);

    const transcriptBeforeReply = this.sessions.recentTranscript(request.sessionId);
    const activeExecution = this.executions.getActiveForSession(request.sessionId);
    const executionIntent = analyzeExecutionIntent(request.message, activeExecution);
    const executionPrompt = buildExecutionPromptBlock(executionIntent, activeExecution);
    const { memoryContext, retrievalText } = await assemblePromptContextAsync(request.sessionId, request.message, transcriptBeforeReply);
    const instructions = buildAssistantInstructions(memoryContext);

    const promptParts = [
      request.channel ? `Channel: ${request.channel}` : '',
      transcriptBeforeReply ? `Recent transcript:\n${transcriptBeforeReply}` : '',
      retrievalText ? `Relevant vault context:\n${retrievalText}` : '',
      executionPrompt,
      `Latest user message:\n${request.message}`,
    ].filter(Boolean);

    const result = await this.runtime.run({
      instructions,
      model: request.model ?? MODELS.primary,
      prompt: promptParts.join('\n\n'),
      sessionId: request.sessionId,
      userId: request.userId,
      channel: request.channel,
    }, request.runId ? {
      onToolActivity: async (activity) => {
        addRunEvent(request.runId, {
          type: 'tool_started',
          message: `Using tool: ${activity.toolName}`,
          data: {
            toolName: activity.toolName,
            input: activity.input,
          },
        });
      },
      onText: async () => {
        // Final text is recorded by the gateway/background task after the run returns.
      },
    } : undefined);

    if (executionPrompt) {
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
    };
  }
}
