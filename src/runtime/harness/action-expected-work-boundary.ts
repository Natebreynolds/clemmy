/**
 * Production boundary for action expected-work activation and carrier exposure.
 *
 * The accepted TurnGraph decides whether this boundary is entered. Once an
 * exact action source enters it, storage ambiguity is never interpreted as a
 * conversational/non-action turn: execution fails closed before a model or
 * tool surface can be constructed.
 */
import { BoundaryError } from '../boundary-error.js';
import {
  actionExpectedWorkState,
  activateActionExpectedWork,
} from './expected-work-admission.js';
import { expectedTaskFor } from './resolution-ledger.js';

export interface ActionExpectedWorkIdentity {
  sessionId: string;
  sourceUserSeq: number;
}

export type RequiredActionExpectedWork = {
  status: 'action_active';
  acceptedTaskId: string;
  contractId?: string;
};

function activationBoundaryError(
  input: ActionExpectedWorkIdentity,
  status: string,
  reason: string,
): BoundaryError {
  const stateConflict = status === 'not_action' || status === 'conflict';
  return new BoundaryError({
    kind: stateConflict ? 'state.read_corrupted' : 'state.write_failed',
    retryable: !stateConflict,
    userMessage: 'I could not safely start that action because its local work authority was unavailable. Please retry.',
    operatorMessage: `action expected-work activation ${status}: ${reason}`,
    context: {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      actionExpectedWorkStatus: status,
    },
  });
}

/** Activate one exact persisted action source before capability construction. */
export function requireActionExpectedWorkActivation(
  input: ActionExpectedWorkIdentity,
): RequiredActionExpectedWork {
  const result = activateActionExpectedWork(input);
  if (result.status === 'activated' || result.status === 'replayed') {
    return { status: 'action_active', acceptedTaskId: result.acceptedTaskId };
  }
  const failure = result as Exclude<typeof result, { status: 'activated' | 'replayed' }>;
  throw activationBoundaryError(input, failure.status, failure.reason);
}

/**
 * Select the carrier from durable authority, never from prompt wording. An
 * exact non-action source returns false; an action whose activation cannot be
 * proved throws before its model-facing surface is built.
 */
export function actionExpectedWorkCarrierSelection(
  input: ActionExpectedWorkIdentity,
): false | RequiredActionExpectedWork {
  const state = actionExpectedWorkState(input);
  if (state.status === 'not_action') return false;
  if (state.status === 'required') {
    return {
      status: 'action_active',
      acceptedTaskId: state.acceptedTaskId,
      ...(state.contractId ? { contractId: state.contractId } : {}),
    };
  }
  throw activationBoundaryError(input, state.status, state.reason);
}

/**
 * The one question every lane that can dispatch business work must ask.
 *
 * Identity may be absent (direct SDK, unit and test routes) and the persisted
 * graph may be non-action; both keep a lane's historical surface. Only an exact
 * accepted action turn binds the lane to its carrier.
 *
 * This exists because asking is not optional and the answer must not be
 * re-derived per lane. The fan-out worker lane never asked, so it built a
 * surface of first-class business tools that the admission wall then refused —
 * five workers died on one item set with no door to walk through (live
 * 2026-08-11, count-only-drafts).
 */
export function actionExpectedWorkCarrierRequired(input: {
  sessionId?: string | null;
  sourceUserSeq?: number | null;
}): false | RequiredActionExpectedWork {
  const sessionId = input.sessionId?.trim();
  const sourceUserSeq = input.sourceUserSeq;
  if (!sessionId || !Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) return false;
  const expected = expectedTaskFor(sessionId, sourceUserSeq as number);
  if (expected.status !== 'ok' || expected.graph.classification.route !== 'act') return false;
  return actionExpectedWorkCarrierSelection({
    sessionId,
    sourceUserSeq: sourceUserSeq as number,
  });
}
