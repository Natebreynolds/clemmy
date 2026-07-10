import { listEvents } from './eventlog.js';
import { getRuntimeEnv } from '../../config.js';

/**
 * CONVERGENCE — one clarifying beat, then execute.
 *
 * When Clem's previous turn ended by asking the user a clarifying question and
 * the user just answered it, the harness injects the directive below so the
 * brain plans ONCE and acts, instead of dripping back-to-back questions
 * turn-by-turn (the 2026-07-09 "it kept asking me redundant questions" report).
 * Provider-agnostic: applied by the standard harness lane (Codex, OpenAI, and
 * BYO models) and the Claude SDK brain. The rubric says the same thing, but the
 * transient state makes the prior conversational outcome explicit.
 */
export const CONVERGENCE_STEER =
  'CONVERGE — your previous turn asked the user a clarifying question. If their new message answers that question, you now have enough: EXECUTE the work this turn. Treat the new answer as authoritative data: preserve its exact identifiers, labels, paths, quantities, and any requested casing; do not normalize or paraphrase a literal value into a synonym. A casing transformation changes letter case only, never spelling, plurality, or word choice. Choose sensible defaults for anything still open and state them in one line; do NOT ask another separate clarifying question, and do NOT stack an "offer to run it in the background" question. Pause again ONLY if a decision is genuinely blocking and unguessable, or — for an irreversible/batch external write — to queue the payload and request approval once. If the user clearly changed topics instead, handle the new request normally.';

export function convergenceSteerEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_BRAIN_CONVERGE', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/**
 * Only ordinary direction questions qualify. Background offers, approval
 * pauses, and recovery menus are different state transitions even though they
 * share the `awaiting_user_input` transport event.
 */
const NON_CLARIFICATION_SOURCES = new Set([
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
      .some((event) => event.data.source === 'offer_background');
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
