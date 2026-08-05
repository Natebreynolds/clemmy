/**
 * The shared Slack/Discord progress reducer (E7.3).
 *
 * Both transports previously narrated from their own event handling, so
 * worker/batch lifecycle never reached them and every tool event risked
 * becoming a message. This module is the ONE reducer both consume, and it
 * reads the SERVER activity projection — the same durable truth the console
 * renders — so a transport can never invent a phase the server does not
 * assert.
 *
 * Output contract: one kickoff acknowledgement, rate-limited milestone
 * EDITS (never a message per event), and one final replacement. Labels are
 * the projection's privacy-safe text; raw args, targets, prompts, and
 * reasoning can never appear because they are not in the input type.
 */
import { renderActivityLabel, type SurfaceRunSnapshot } from '../runtime/graph/surface-projection.js';

export interface TransportProgressState {
  /** The last milestone text actually sent/edited. */
  lastText?: string;
  /** Monotonic clock ms of the last edit — rate limiting is time, not count. */
  lastEditAt?: number;
  kickedOff?: boolean;
  finalized?: boolean;
}

export type TransportProgressAction =
  | { action: 'kickoff'; text: string }
  | { action: 'edit'; text: string }
  | { action: 'final'; text: string }
  | { action: 'none' };

/** Minimum gap between milestone edits — a transport is not an event feed. */
export const MILESTONE_EDIT_INTERVAL_MS = 20_000;

/**
 * Reduce ONE projection snapshot into at most one transport action.
 * Deterministic and pure: same snapshot + state ⇒ same action.
 */
export function reduceTransportProgress(
  snapshot: SurfaceRunSnapshot,
  state: TransportProgressState,
  nowMs: number,
): TransportProgressAction {
  if (state.finalized) return { action: 'none' };

  // A committed typed terminal is the final replacement — always sent, never
  // rate limited, and always the projection's terminal (never inferred).
  if (snapshot.terminal) {
    return { action: 'final', text: snapshot.terminal.text };
  }

  const label = snapshot.activity
    ? snapshot.activity.text
    : renderActivityLabel({ phase: 'working_items' });
  const counts = snapshot.children
    ? `${snapshot.children.completed} of ${snapshot.children.total}`
    : snapshot.progress
      ? `${snapshot.progress.completed} of ${snapshot.progress.total}`
      : undefined;
  const text = counts ? `${label} (${counts})` : label;

  if (!state.kickedOff) return { action: 'kickoff', text };
  if (text === state.lastText) return { action: 'none' };
  if (state.lastEditAt !== undefined && nowMs - state.lastEditAt < MILESTONE_EDIT_INTERVAL_MS) {
    return { action: 'none' };
  }
  return { action: 'edit', text };
}

/**
 * Reduce and fold in one step — the ONE call a transport makes per flush.
 *
 * Both channel surfaces run through the same message state machine, so this is
 * their single decision point: whether to speak at all, what the milestone text
 * is, and whether the run has already been replaced by its final message.
 */
export function advanceTransportProgress(
  snapshot: SurfaceRunSnapshot,
  state: TransportProgressState,
  nowMs: number,
): { action: TransportProgressAction; state: TransportProgressState } {
  const action = reduceTransportProgress(snapshot, state, nowMs);
  return { action, state: applyTransportProgress(state, action, nowMs) };
}

/** Fold an emitted action back into the transport's durable-ish state. */
export function applyTransportProgress(
  state: TransportProgressState,
  action: TransportProgressAction,
  nowMs: number,
): TransportProgressState {
  switch (action.action) {
    case 'kickoff':
      return { ...state, kickedOff: true, lastText: action.text, lastEditAt: nowMs };
    case 'edit':
      return { ...state, lastText: action.text, lastEditAt: nowMs };
    case 'final':
      return { ...state, finalized: true, lastText: action.text, lastEditAt: nowMs };
    default:
      return state;
  }
}
