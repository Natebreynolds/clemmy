import { listEvents } from './eventlog.js';
import { getRuntimeEnv } from '../../config.js';

/**
 * CONVERGENCE — one clarifying beat, then execute.
 *
 * When Clem's previous turn ended by asking the user a clarifying question and
 * the user just answered it, the harness injects the directive below so the
 * brain plans ONCE and acts, instead of dripping back-to-back questions
 * turn-by-turn (the 2026-07-09 "it kept asking me redundant questions" report).
 * Lane-agnostic: applied on BOTH the Codex/GPT loop lane and the Claude SDK brain
 * lane, because the user's brain model can be either. The rubric says the same
 * thing, but the code steer is the enforceable backstop (prompt rules rot).
 */
export const CONVERGENCE_STEER =
  'CONVERGE — your previous turn asked the user a clarifying question and they just answered it. You now have enough: EXECUTE the work this turn. Choose sensible defaults for anything still open and state them in one line; do NOT ask another separate clarifying question, and do NOT stack an "offer to run it in the background" question. Pause again ONLY if a decision is genuinely blocking and unguessable, or — for an irreversible/batch external write — to queue the payload and request approval once.';

export function convergenceSteerEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_BRAIN_CONVERGE', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/**
 * True when Clem's most recent turn OUTCOME was a clarifying question (awaiting
 * the user) with nothing executed since — so the incoming message is the answer.
 * Robust to both event shapes: the Codex lane records a bare `awaiting_user_input`;
 * the brain/loop awaiting path also appends `conversation_completed{awaitingUser:true}`.
 * An approval card (`approval_requested`) is NOT a clarifying question and never
 * trips this — that pause is legitimate. Execution / normal-completion markers
 * (external_write, or a non-awaiting conversation_completed) clear it.
 */
export function priorTurnEndedAwaitingClarification(sessionId?: string): boolean {
  if (!sessionId) return false;
  try {
    const last = listEvents(sessionId, {
      types: ['awaiting_user_input', 'conversation_completed', 'external_write'],
      desc: true,
      limit: 1,
    })[0];
    if (!last) return false;
    if (last.type === 'awaiting_user_input') return true;
    if (last.type === 'conversation_completed') {
      return Boolean((last.data as { awaitingUser?: boolean } | undefined)?.awaitingUser);
    }
    return false;
  } catch {
    return false;
  }
}
