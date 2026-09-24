import { getRunAttemptBySourceUserSeq, listEvents } from '../runtime/harness/eventlog.js';
import { presentationEventFromCompletionData } from '../runtime/harness/turn-outcome.js';

/** The parent may finish with different prose and executor identity than the
 * child's report. Accept only the exact canonical terminal of the attempt
 * which durably claimed this source group, never a matching text heuristic. */
export function isWorkflowParentTerminalIdentity(input: {
  sourceGroupId: string;
  sourceGroupDigest: string;
  terminal: { eventId: string; outcomeId: string; sessionId: string;
    sourceUserSeq: number; turn: number; runId: string };
}): boolean {
  const { terminal } = input;
  const event = listEvents(terminal.sessionId, { types: ['conversation_completed'] })
    .find(row => row.id === terminal.eventId);
  if (!event) return false;
  let presentation;
  try { presentation = presentationEventFromCompletionData(event.data); }
  catch { return false; }
  const attempt = getRunAttemptBySourceUserSeq(terminal.sessionId, terminal.sourceUserSeq);
  if (!presentation || !attempt || presentation.identity.attemptId !== attempt.attemptId
    || presentation.identity.sessionId !== terminal.sessionId
    || presentation.identity.sourceUserSeq !== terminal.sourceUserSeq
    || presentation.identity.turn !== terminal.turn
    || presentation.identity.runId !== terminal.runId
    || presentation.outcomeId !== terminal.outcomeId) return false;
  return listEvents(terminal.sessionId, { types: ['workflow_parent_continuation_requested'] })
    .some(request => request.role === 'system' && request.seq < event.seq
      && request.data.sourceUserSeq === terminal.sourceUserSeq
      && request.data.attemptId === attempt.attemptId
      && request.data.sourceGroupId === input.sourceGroupId
      && request.data.sourceGroupDigest === input.sourceGroupDigest);
}
