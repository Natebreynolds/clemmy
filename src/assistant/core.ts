import { randomUUID } from 'node:crypto';
import { MODELS } from '../config.js';
import { assemblePromptContext } from '../memory/context.js';
import { SessionStore } from '../memory/session-store.js';
import type { AssistantRequest, AssistantResponse } from '../types.js';
import { refreshWorkingMemory } from '../memory/working-memory.js';
import { refineActivePlanFromMessage } from '../planning/refinement.js';
import { buildAssistantInstructions } from './instructions.js';
import type { AgentRuntime } from '../runtime/provider.js';

export class ClementineAssistant {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly sessions = new SessionStore(),
  ) {}

  getRuntime(): AgentRuntime {
    return this.runtime;
  }

  createSessionId(): string {
    return randomUUID();
  }

  async respond(request: AssistantRequest): Promise<AssistantResponse> {
    this.sessions.appendTurn(
      request.sessionId,
      {
        role: 'user',
        text: request.message,
        createdAt: new Date().toISOString(),
      },
      request.userId,
      request.channel,
    );
    refineActivePlanFromMessage(request.message);

    const transcriptBeforeReply = this.sessions.recentTranscript(request.sessionId);
    const { memoryContext, retrievalText } = assemblePromptContext(request.message, transcriptBeforeReply);
    const instructions = buildAssistantInstructions(memoryContext);

    const promptParts = [
      request.channel ? `Channel: ${request.channel}` : '',
      transcriptBeforeReply ? `Recent transcript:\n${transcriptBeforeReply}` : '',
      retrievalText ? `Relevant vault context:\n${retrievalText}` : '',
      `Latest user message:\n${request.message}`,
    ].filter(Boolean);

    const result = await this.runtime.run({
      instructions,
      model: request.model ?? MODELS.primary,
      prompt: promptParts.join('\n\n'),
      sessionId: request.sessionId,
      userId: request.userId,
      channel: request.channel,
    });

    const updatedSession = this.sessions.appendTurn(request.sessionId, {
      role: 'assistant',
      text: result.text,
      createdAt: new Date().toISOString(),
    });
    refreshWorkingMemory(updatedSession);

    return {
      text: result.text,
      sessionId: request.sessionId,
      pendingApprovalId: result.pendingApprovalId,
    };
  }
}
