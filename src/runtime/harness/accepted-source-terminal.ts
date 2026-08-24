import {
  listEvents,
  type EventRow,
} from './eventlog.js';
import {
  presentationEventFromCompletionData,
  turnOutcomeId,
  type PresentationEvent,
} from './turn-outcome.js';

export interface AcceptedSourceTerminalOutcome {
  kind: 'terminal';
  event: EventRow;
  presentation: PresentationEvent;
}

export type AcceptedSourceTerminalResolution =
  | { kind: 'absent' }
  | AcceptedSourceTerminalOutcome
  | { kind: 'legacy'; event: EventRow }
  | { kind: 'corrupt'; event: EventRow; error: unknown };

export const UNVERIFIABLE_ACCEPTED_SOURCE_TERMINAL_TEXT =
  'This request already has a terminal record that I cannot verify safely. I stopped before running any model or tool again.';

/**
 * Resolve the exact typed terminal owned by one accepted source.
 *
 * This deliberately lives outside accepted-source-outcome.ts so callers that
 * only need a settled answer do not import the full conversation loop merely
 * to verify workflow-dispatch receipts. Store read errors propagate to the
 * caller; exact-replay entry points must convert them into a non-retrying stop.
 */
export function resolveExactTerminalForAcceptedSource(
  source: EventRow,
): AcceptedSourceTerminalResolution {
  const terminalKey = `turn:${source.seq}`;
  for (const event of listEvents(source.sessionId, {
    types: ['conversation_completed'],
  })) {
    if (
      event.data.terminalKey !== terminalKey
      && event.data.sourceUserSeq !== source.seq
      && (event.data.presentation as { identity?: { sourceUserSeq?: unknown } } | undefined)
        ?.identity?.sourceUserSeq !== source.seq
    ) continue;
    const hasPresentation = Object.prototype.hasOwnProperty.call(event.data, 'presentation');
    const hasTurnOutcome = Object.prototype.hasOwnProperty.call(event.data, 'turnOutcome');
    if (!hasPresentation && !hasTurnOutcome) {
      return event.sessionId === source.sessionId && event.turn === source.turn
        ? { kind: 'legacy', event }
        : {
            kind: 'corrupt',
            event,
            error: new Error('Legacy terminal event envelope contradicts its accepted source.'),
          };
    }
    try {
      const presentation = presentationEventFromCompletionData(event.data);
      if (
        !presentation
        || event.sessionId !== source.sessionId
        || event.turn !== source.turn
        || presentation.identity.sessionId !== source.sessionId
        || presentation.identity.turn !== source.turn
        || presentation.identity.sourceUserSeq !== source.seq
      ) {
        return {
          kind: 'corrupt',
          event,
          error: new Error('Typed terminal projection contradicts its accepted source.'),
        };
      }
      return { kind: 'terminal', event, presentation };
    } catch (error) {
      // A typed row claiming this source but failing its projection is corrupt
      // authority. Never skip past it to an older terminal candidate.
      return { kind: 'corrupt', event, error };
    }
  }
  return { kind: 'absent' };
}

/**
 * Total compatibility projection for callers that understand terminal versus
 * proven absence. A source-claiming legacy/corrupt row becomes a conservative
 * blocked terminal; it is never collapsed into null, because null alone grants
 * a retry permission to admission/model/tool lanes.
 */
export function exactTerminalForAcceptedSource(
  source: EventRow,
): AcceptedSourceTerminalOutcome | null {
  const resolution = resolveExactTerminalForAcceptedSource(source);
  if (resolution.kind === 'absent') return null;
  if (resolution.kind === 'terminal') return resolution;
  const identity = {
    sessionId: source.sessionId,
    turn: source.turn,
    sourceUserSeq: source.seq,
  };
  const outcomeId = turnOutcomeId(identity);
  return {
    kind: 'terminal',
    event: resolution.event,
    presentation: {
      version: 1,
      id: `${outcomeId}:presentation`,
      outcomeId,
      audience: 'user',
      phase: 'final',
      identity,
      status: 'blocked',
      kind: 'blocked',
      text: UNVERIFIABLE_ACCEPTED_SOURCE_TERMINAL_TEXT,
      resumable: false,
    },
  };
}
