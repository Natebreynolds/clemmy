import {
  listEvents,
  type EventRow,
} from './eventlog.js';
import {
  presentationEventFromCompletionData,
  type PresentationEvent,
} from './turn-outcome.js';

export interface AcceptedSourceTerminalOutcome {
  kind: 'terminal';
  event: EventRow;
  presentation: PresentationEvent;
}

/**
 * Resolve the exact typed terminal owned by one accepted source.
 *
 * This deliberately lives outside accepted-source-outcome.ts so callers that
 * only need a settled answer do not import the full conversation loop merely
 * to verify workflow-dispatch receipts. Store read errors propagate to the
 * caller; public replay reducers catch them and fail closed.
 */
export function exactTerminalForAcceptedSource(
  source: EventRow,
): AcceptedSourceTerminalOutcome | null {
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
      // authority. Never skip past it to an older terminal candidate.
      return null;
    }
  }
  return null;
}
