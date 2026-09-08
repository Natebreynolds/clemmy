import {
  listEvents,
  openEventLog,
  type EventRow,
} from './eventlog.js';
import { verifiedWorkflowRunDispatchReceipts } from './loop.js';
import {
  exactTerminalForAcceptedSource,
  type AcceptedSourceTerminalOutcome,
} from './accepted-source-terminal.js';
import {
  publicAsyncWorkDispatchedData,
  type PublicAsyncWorkDispatchedData,
} from './public-presentation.js';

export type AcceptedSourceOutcome =
  | AcceptedSourceTerminalOutcome
  | {
      kind: 'dispatched';
      event: EventRow;
      presentation: PublicAsyncWorkDispatchedData;
    };

function exactDispatchForAcceptedSource(
  source: EventRow,
): Extract<AcceptedSourceOutcome, { kind: 'dispatched' }> | null {
  const receipts = verifiedWorkflowRunDispatchReceipts(
    source.sessionId,
    source.turn,
    source.seq,
  );
  if (receipts.length !== 1) return null;
  const receipt = receipts[0];
  const event = listEvents(source.sessionId, { types: ['async_work_dispatched'] })
    .find((candidate) => candidate.id === receipt.eventId);
  const presentation = event ? publicAsyncWorkDispatchedData(event.data) : null;
  if (
    !event
    || !presentation
    || event.sessionId !== source.sessionId
    || event.turn !== source.turn
    || event.parentEventId !== source.id
    || presentation.sourceUserSeq !== source.seq
    || presentation.sourceGroupId !== receipt.sourceGroupId
    || presentation.sourceGroupDigest !== receipt.sourceGroupDigest
    || presentation.replyTargetDigest !== receipt.replyTargetDigest
    || presentation.runIds.length !== receipt.runIds.length
    || !presentation.runIds.every((runId, index) => runId === receipt.runIds[index])
  ) return null;
  return { kind: 'dispatched', event, presentation };
}

/**
 * Resolve the one public edge currently owned by an accepted human source.
 *
 * A terminal wins once one exists. Until then, a verified workflow dispatch is
 * deliberately nonterminal: transports may close their foreground request and
 * replay its compact acknowledgement, while the workflow reducer retains sole
 * authority to publish the later conversation terminal.
 */
export function acceptedSourceOutcome(source: EventRow): AcceptedSourceOutcome | null {
  if (
    source.type !== 'user_input_received'
    || source.role !== 'user'
    || source.data.synthetic === true
  ) return null;
  // A source-claiming legacy/corrupt terminal is projected conservatively as
  // blocked. Only a proven absence reaches the dispatch lookup below.
  return exactTerminalForAcceptedSource(source)
    ?? exactDispatchForAcceptedSource(source);
}

/** The boot sweeper must distinguish dead foreground executors from logical
 * sources already handed to a durable workflow owner. Only complete existing
 * cross-store dispatch authority preserves an unfinished row; neither a NULL
 * lease nor an event's unverified claim is sufficient. This grants no new call. */
export function workflowOwnedUnfinishedAttemptIds(): string[] {
  const candidates = openEventLog().prepare(`SELECT session_id, attempt_id, source_user_seq
    FROM run_attempts WHERE finished_at IS NULL AND status = 'active'
      AND source_user_seq IS NOT NULL`).all() as Array<{
        session_id: string; attempt_id: string; source_user_seq: number;
      }>;
  const preserved: string[] = [];
  for (const candidate of candidates) {
    const source = listEvents(candidate.session_id, {
      types: ['user_input_received'], sinceSeq: candidate.source_user_seq - 1, limit: 1,
    })[0];
    if (source?.seq === candidate.source_user_seq && acceptedSourceOutcome(source)?.kind === 'dispatched') {
      preserved.push(candidate.attempt_id);
    }
  }
  return preserved;
}
