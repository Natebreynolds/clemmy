/**
 * Production persist seam: the atomic host admit/compile, then the shadow row.
 */
import pino from 'pino';
import { admitAndCompileAcceptedSource } from '../semantic-boundary/admit-and-compile-accepted-source.js';
import {
  blockedPresentationForSemanticRecord,
  readPersistedSemanticInterpretation,
} from '../semantic-boundary/interpret-accepted-source.js';
import type { TurnGraphSurface } from '../graph/turn-graph-ir.js';
import { turnOutcomeId, type TurnIdentity } from './turn-outcome.js';
import { commitTurnOutcome } from './delivery-committer.js';
import type { TaskContinuationContext } from '../../types.js';
import type { EventRow } from './eventlog.js';

const logger = pino({ name: 'clementine.accepted-source-graph' });

export async function recordAcceptedSourceGraph(input: {
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>;
  surface: TurnGraphSurface;
  acceptedText?: string;
  allowedToolNames?: readonly string[];
  excludedToolNames?: readonly string[];
  verifiedTaskContinuation?: TaskContinuationContext;
}): Promise<EventRow | null> {
  const result = await admitAndCompileAcceptedSource({
    identity: input.identity,
    surface: input.surface,
    allowedToolNames: input.allowedToolNames,
    excludedToolNames: input.excludedToolNames,
    verifiedTaskContinuation: input.verifiedTaskContinuation,
  });
  if (!result.ok) {
    logger.warn({
      sessionId: input.identity.sessionId,
      sourceUserSeq: input.identity.sourceUserSeq,
      reason: result.reason,
    }, 'accepted source could not be admitted');
    // The compiler already owns the one compatibility case: when no semantic
    // port participated it returns a validated shadow graph as an `ok` result.
    // Once a semantic port participated, refusal is the durable route decision.
    // Rebuilding an identity-only graph here would open a second, tool-bearing
    // executor after that decision.
    return null;
  }
  return result.event;
}

/** Durable blocked/recoverable terminal when a participating semantic port refused. */
export function commitUnadmittedSemanticTurn(identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>): {
  text: string;
} {
  const record = readPersistedSemanticInterpretation(identity.sessionId, identity.sourceUserSeq);
  const text = blockedPresentationForSemanticRecord(record);
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity: {
      sessionId: identity.sessionId,
      turn: identity.turn,
      sourceUserSeq: identity.sourceUserSeq,
    },
    status: 'blocked',
    resumable: true,
    presentation: { kind: 'blocked', text },
  });
  return { text };
}

/**
 * A participating semantic path may only enter an executor that consumes its
 * admitted graph. Unsupported typed operation families stop here; they never
 * regain authority by falling through to the compatibility tool loop.
 */
export function commitUnsupportedTypedExecutionTurn(
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>,
): { text: string } {
  const text = 'This plan is not supported by the typed executor yet, so I stopped before using any tools.';
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity: {
      sessionId: identity.sessionId,
      turn: identity.turn,
      sourceUserSeq: identity.sourceUserSeq,
    },
    status: 'blocked',
    resumable: true,
    presentation: { kind: 'blocked', text },
  });
  return { text };
}
