import {
  listEvents,
  type EventRow,
} from './eventlog.js';
import { verifiedWorkflowRunDispatchReceipts } from './loop.js';
import {
  publicAsyncWorkDispatchedData,
  type PublicAsyncWorkDispatchedData,
} from './public-presentation.js';
import {
  presentationEventFromCompletionData,
  type PresentationEvent,
} from './turn-outcome.js';

export type AcceptedSourceOutcome =
  | {
      kind: 'terminal';
      event: EventRow;
      presentation: PresentationEvent;
    }
  | {
      kind: 'dispatched';
      event: EventRow;
      presentation: PublicAsyncWorkDispatchedData;
    };

function exactTerminalForAcceptedSource(
  source: EventRow,
): Extract<AcceptedSourceOutcome, { kind: 'terminal' }> | null {
  const terminalKey = `turn:${source.seq}`;
  for (const event of listEvents(source.sessionId, {
    types: ['conversation_completed'],
    desc: true,
  })) {
    if (
      event.data.terminalKey !== terminalKey
      && event.data.sourceUserSeq !== source.seq
      && (event.data.presentation as { identity?: { sourceUserSeq?: unknown } } | undefined)
        ?.identity?.sourceUserSeq !== source.seq
    ) continue;
    try {
      const presentation = presentationEventFromCompletionData(event.data);
      if (
        !presentation
        || event.sessionId !== source.sessionId
        || event.turn !== source.turn
        || presentation.identity.sessionId !== source.sessionId
        || presentation.identity.turn !== source.turn
        || presentation.identity.sourceUserSeq !== source.seq
      ) return null;
      return { kind: 'terminal', event, presentation };
    } catch {
      // A typed row claiming this source but failing its projection is corrupt
      // authority. Never skip past it to a weaker candidate.
      return null;
    }
  }
  return null;
}

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
