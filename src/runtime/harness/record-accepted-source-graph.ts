/**
 * Production persist seam: the atomic host admit/compile, then the shadow row.
 */
import pino from 'pino';
import { admitAndCompileAcceptedSource } from '../semantic-boundary/admit-and-compile-accepted-source.js';
import { recordTurnGraphShadow } from '../graph/turn-graph-shadow.js';
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
    // ADVISORY-UNTIL-BINDABLE, AT THE SOURCE. A failed semantic admission is
    // a checker verdict; the disposition is already durably 'blocked', which
    // withholds TYPED authority everywhere. Returning null here was how a
    // checker verdict still ended the user's turn: every caller converts a
    // missing graph into a blocked terminal (live 2026-08-18 breaker 3:
    // "do it, but make it 5 firms" \u2192 invalid \u2192 "I could not admit
    // this turn's interpretation" \u2014 the SECOND door of the same class
    // fixed at typed-source-dispatch three days earlier). Degrade to the
    // identity-only shadow instead: the same regex-compiled graph every
    // non-semantic lane runs on, carrying tools and every effect gate.
    try {
      const fallback = recordTurnGraphShadow({
        identity: input.identity,
        surface: input.surface,
        ...(input.allowedToolNames ? { allowedToolNames: input.allowedToolNames } : {}),
        ...(input.excludedToolNames ? { excludedToolNames: input.excludedToolNames } : {}),
        ...(input.verifiedTaskContinuation
          ? { verifiedTaskContinuation: input.verifiedTaskContinuation }
          : {}),
      });
      if (fallback) {
        logger.warn({
          sessionId: input.identity.sessionId,
          sourceUserSeq: input.identity.sourceUserSeq,
        }, 'unadmitted source kept an identity-only graph; dispatch stays blocked');
        return fallback;
      }
    } catch { /* the terminal refusal below remains the last resort */ }
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
