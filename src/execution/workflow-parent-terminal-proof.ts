import { getRunAttemptBySourceUserSeq, listEvents } from '../runtime/harness/eventlog.js';
import { workflowParentTerminalIdentityFromSnapshot,
  type WorkflowParentTerminalIdentityInput } from './workflow-parent-terminal-proof-data.js';

/** The parent may finish with different prose and executor identity than the
 * child's report. Accept only the exact canonical terminal of the attempt
 * which durably claimed this source group, never a matching text heuristic. */
export function isWorkflowParentTerminalIdentity(input: WorkflowParentTerminalIdentityInput): boolean {
  const { terminal } = input;
  const event = listEvents(terminal.sessionId, { types: ['conversation_completed'] })
    .find(row => row.id === terminal.eventId);
  if (!event) return false;
  const attempt = getRunAttemptBySourceUserSeq(terminal.sessionId, terminal.sourceUserSeq);
  if (!attempt) return false;
  return workflowParentTerminalIdentityFromSnapshot(input, { terminalEvent: event,
    latestAttemptId: attempt.attemptId,
    continuationRequests: listEvents(terminal.sessionId, { types: ['workflow_parent_continuation_requested'] }) });
}
