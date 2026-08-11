import {
  listEvents,
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
  try {
    return exactTerminalForAcceptedSource(source)
      ?? exactDispatchForAcceptedSource(source);
  } catch {
    // This reducer sits on provider replay/failure paths. An unreadable ledger
    // is never permission to replay work or publish an unverified proposal.
    return null;
  }
}
