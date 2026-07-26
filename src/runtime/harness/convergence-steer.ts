import { listEvents } from './eventlog.js';
import { getRuntimeEnv } from '../../config.js';

/**
 * CONVERGENCE — carry an answer forward without imposing an execution timer.
 *
 * The old steer treated every answer as "you now have enough: EXECUTE". That
 * stopped redundant clarification, but it also collapsed collaborative
 * exploration into a one-question command flow. This transient now carries
 * only the useful invariant: honor the answer and never re-ask the resolved
 * point. The model still owns whether the conversation is exploring or ready
 * to execute. Provider-agnostic: applied by the standard and Claude SDK lanes.
 */
export const CONVERGENCE_STEER =
  'CONVERGE — your previous turn asked the user a question. If their new message answers it, treat that answer as authoritative and never re-ask the resolved point. Preserve exact identifiers, labels, paths, quantities, and requested casing; do not normalize a literal value into a synonym. If the user has now committed or the request is execution-ready, act autonomously with sensible non-blocking defaults. If they are still comparing, brainstorming, shaping, or deciding, continue that conversation naturally — an answer is not automatic permission for external writes or durable execution. Ask again only for a genuinely blocking, unguessable fact, bundling any remaining execution-critical choices. Do not stack a background-routing question unless work is now committed and truly long. If the user changed topics, handle the new request normally.';

export function convergenceSteerEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_BRAIN_CONVERGE', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/**
 * Only ordinary direction questions qualify. Background offers, approval
 * pauses, and recovery menus are different state transitions even though they
 * share the `awaiting_user_input` transport event.
 */
const NON_CLARIFICATION_SOURCES = new Set([
  // LEGACY SOURCE TAG: the offer_background TOOL was stripped 2026-07-22, but
  // historical awaiting events carry this source and a background-routing
  // choice must never be misread as a clarification answer.
  'offer_background',
  'stall_recovery',
  'infra_error_recovery',
  'decision_awaiting_approval',
  'decision_awaiting_handoff_terminal',
]);

function isClarificationAwaiting(data: Record<string, unknown> | undefined): boolean {
  const source = typeof data?.source === 'string' ? data.source : '';
  return !source || !NON_CLARIFICATION_SOURCES.has(source);
}

/** A background/hold/now choice is offered at most once per session. This is
 * separate from clarification convergence: answering the routing choice must
 * suppress another offer, but must not receive the EXECUTE-now clarification
 * steer because "hold" and "background" are valid terminal routes. */
export function sessionHasBackgroundOffer(sessionId?: string): boolean {
  if (!sessionId) return false;
  try {
    return listEvents(sessionId, { types: ['awaiting_user_input'] })
      .some((event) => event.data.source === 'offer_background') /* legacy events only — tool stripped 2026-07-22 */;
  } catch {
    return false;
  }
}

export function priorTurnEndedAwaitingClarification(sessionId?: string): boolean {
  if (!sessionId) return false;
  try {
    // `desc:true` selects the newest window, then listEvents restores
    // chronological order. The final element is therefore the latest outcome.
    const outcomes = listEvents(sessionId, {
      types: ['awaiting_user_input', 'conversation_completed', 'external_write', 'approval_requested'],
      desc: true,
      limit: 40,
    });
    const last = outcomes.at(-1);
    if (!last) return false;
    if (last.type === 'awaiting_user_input') return isClarificationAwaiting(last.data);
    if (last.type === 'conversation_completed') {
      if (!Boolean(last.data.awaitingUser)) return false;
      const pairedAwaiting = outcomes
        .slice(0, -1)
        .reverse()
        .find((event) => event.type === 'awaiting_user_input' && event.turn === last.turn);
      return pairedAwaiting ? isClarificationAwaiting(pairedAwaiting.data) : true;
    }
    return false;
  } catch {
    return false;
  }
}
