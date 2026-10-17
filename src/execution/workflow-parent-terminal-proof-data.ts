import { presentationEventFromCompletionData } from '../runtime/harness/turn-outcome.js';

export interface WorkflowParentTerminalIdentityInput {
  sourceGroupId: string;
  sourceGroupDigest: string;
  terminal: { eventId: string; outcomeId: string; sessionId: string;
    sourceUserSeq: number; turn: number; runId: string };
}
export interface WorkflowParentProofEvent {
  id: string;
  seq: number;
  turn: number;
  sessionId: string;
  type: string;
  role: string;
  data: Record<string, unknown>;
}
export interface WorkflowParentTerminalSnapshot {
  terminalEvent: WorkflowParentProofEvent | null;
  /** Chosen only within the exact source, using the durable runtime's
   * started_at DESC, rowid DESC ordering. Never the latest session attempt. */
  latestAttemptId: string | null;
  continuationRequests: readonly WorkflowParentProofEvent[];
}

/** Shared data-only proof for runtime and explicit-home accounting readers.
 * Full typed completion validation is intentionally reused. Matching nested
 * fields or terminal prose alone cannot stand in for this predicate. */
export function workflowParentTerminalIdentityFromSnapshot(input: WorkflowParentTerminalIdentityInput,
  snapshot: WorkflowParentTerminalSnapshot): boolean {
  const { terminal } = input;
  const event = snapshot.terminalEvent;
  if (!event || event.id !== terminal.eventId || event.sessionId !== terminal.sessionId
    || event.type !== 'conversation_completed' || event.turn !== terminal.turn) return false;
  let presentation;
  try { presentation = presentationEventFromCompletionData(event.data); }
  catch { return false; }
  const attemptId = snapshot.latestAttemptId;
  if (!presentation || !attemptId || presentation.identity.attemptId !== attemptId
    || presentation.identity.sessionId !== terminal.sessionId
    || presentation.identity.sourceUserSeq !== terminal.sourceUserSeq
    || presentation.identity.turn !== terminal.turn
    || presentation.identity.runId !== terminal.runId
    || presentation.outcomeId !== terminal.outcomeId) return false;
  return snapshot.continuationRequests.some(request => request.sessionId === terminal.sessionId
    && request.type === 'workflow_parent_continuation_requested'
    && request.role === 'system' && request.seq < event.seq
    && request.data.sourceUserSeq === terminal.sourceUserSeq
    && request.data.attemptId === attemptId
    && request.data.sourceGroupId === input.sourceGroupId
    && request.data.sourceGroupDigest === input.sourceGroupDigest);
}
