import type { BuildOrchestratorAgentOptions } from '../../agents/orchestrator.js';
import type { RunConversationOptions } from '../../runtime/harness/loop.js';
import { completionReviewEnabled } from '../../runtime/harness/completion-review-setting.js';
import type { MeetingResearchExecutionPort } from './meeting-research-service.js';

type ResearchAgent = Awaited<ReturnType<typeof import('../../agents/orchestrator.js').buildOrchestratorAgent>>;
export interface MeetingResearchExecutorPorts {
  runConversation(options: RunConversationOptions): Promise<unknown>;
  buildOrchestratorAgent(options: BuildOrchestratorAgentOptions): Promise<ResearchAgent>;
}

/** Inject only the canonical entry points for controlled option-wiring tests.
 * The default stays lazy; construction never starts a task or opens a store. */
export function createMeetingResearchExecutor(
  load: () => Promise<MeetingResearchExecutorPorts> = async () => {
    const [{ runConversation }, { buildOrchestratorAgent }] = await Promise.all([
      import('../../runtime/harness/loop.js'), import('../../agents/orchestrator.js'),
    ]);
    return { runConversation, buildOrchestratorAgent };
  },
): MeetingResearchExecutionPort {
  return async input => {
    const { runConversation, buildOrchestratorAgent } = await load();
    return runConversation({ ...input, sourceUserSeq: input.sourceUserSeq, reuseRecordedUserInput: true,
      learningPolicy: { version: 1, mode: 'exclude', reason: 'owner_opt_out' },
      suppressMemoryCapture: true, suppressAutomaticMemoryForRequest: true, mcpToolScope: null,
      maxSteps: 1, maxTurns: 2, maxWallClockMs: 90_000, maxRunTokens: 32_000, callerOwnsRecovery: true,
      judgeCompletion: completionReviewEnabled(),
      buildAgent: identity => buildOrchestratorAgent({ sessionId: input.sessionId, sourceUserSeq: identity.sourceUserSeq,
        userInput: input.input, allowedToolNames: [], allowToolJit: false }),
    });
  };
}
