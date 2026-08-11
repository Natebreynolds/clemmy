/** Exact durable authority required before a warm read may approach a provider. */
import {
  getActiveRunAttempt,
  getRunAttemptSourceUserEvent,
  isKillRequested,
  type EventRow,
  type RunAttemptRef,
} from '../harness/eventlog.js';

export interface AcceptedReadAuthority {
  source: EventRow;
  attempt: RunAttemptRef;
}

/**
 * Resolve the current active attempt only when it is already bound to the
 * caller's exact accepted `user_input_received` event. This function creates
 * no session, event, or attempt and therefore grants no authority by itself.
 */
export function currentAcceptedReadAuthority(
  sessionId: string,
  sourceUserSeq: number | undefined,
  runId?: string,
  expectedExecutionInput?: string,
): AcceptedReadAuthority | null {
  if (!sessionId || !Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) return null;
  try {
    const attempt = getActiveRunAttempt(sessionId);
    if (!attempt) return null;
    const correlation = runId?.trim();
    if (correlation && attempt.runId !== correlation && attempt.attemptId !== correlation) return null;
    if (isKillRequested(sessionId, {
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      sourceUserSeq,
    })) return null;
    const source = getRunAttemptSourceUserEvent(attempt);
    if (!source || source.seq !== sourceUserSeq || source.sessionId !== sessionId) return null;
    if (expectedExecutionInput !== undefined
      && (typeof source.data.text !== 'string' || source.data.text !== expectedExecutionInput)) return null;
    return { source, attempt };
  } catch {
    return null;
  }
}
