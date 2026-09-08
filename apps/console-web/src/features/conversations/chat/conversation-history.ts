import { readTaskMode, readPlanRevisionRef } from '../../../lib/task-mode';
import { pendingActionFromEvent, type ChatMessage } from '../../../lib/useChat';
import type { Turn } from '../types';

let seedSeq = 0;

/** Project server-normalized turns into the exact live-card shapes used by
 * the chat UI. Durable plan and approval identities survive navigation; plain
 * assistant history remains terminal text. */
export function historyToMessages(turns: Turn[]): ChatMessage[] {
  return turns.map((turn) => {
    if (turn.role === 'assistant' && turn.planProposalId) {
      return {
        id: `h${++seedSeq}`,
        role: turn.role,
        text: turn.text,
        taskMode: readTaskMode(turn.taskMode),
        planArtifactRef: readPlanRevisionRef(turn.planArtifactRef),
        status: 'awaiting-plan' as const,
        planProposalId: turn.planProposalId,
      };
    }
    if (turn.role === 'assistant' && turn.approval) {
      return {
        id: `h${++seedSeq}`,
        role: turn.role,
        text: turn.text,
        taskMode: readTaskMode(turn.taskMode),
        planArtifactRef: readPlanRevisionRef(turn.planArtifactRef),
        status: 'awaiting-approval' as const,
        approval: {
          subject: turn.approval.subject,
          reason: turn.approval.reason,
          approvalId: turn.approval.approvalId,
          pendingAction: pendingActionFromEvent(turn.approval.pendingAction),
        },
      };
    }
    return {
      id: `h${++seedSeq}`,
      role: turn.role,
      text: turn.text,
        taskMode: readTaskMode(turn.taskMode),
        planArtifactRef: readPlanRevisionRef(turn.planArtifactRef),
      status: turn.role === 'assistant' ? ('complete' as const) : undefined,
    };
  });
}
