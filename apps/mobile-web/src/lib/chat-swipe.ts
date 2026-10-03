/**
 * Swipe a conversation row left to reveal its actions, the way a phone's own
 * lists do. Pure, so the row and its test agree on where a drag lands.
 */
export const SWIPE_ACTIONS_WIDTH = 152;
/** Movement before a touch is read as a drag at all. */
export const SWIPE_INTENT_PX = 10;

/** Which way a touch is going once it has moved enough to say. */
export function swipeIntent(dx: number, dy: number): 'horizontal' | 'vertical' | null {
  if (Math.abs(dx) < SWIPE_INTENT_PX && Math.abs(dy) < SWIPE_INTENT_PX) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
}

/** Where the row sits under the finger: never right of rest, and only a
 *  little past its actions (a soft stop, not a wall). */
export function swipeOffset(base: number, dx: number, width = SWIPE_ACTIONS_WIDTH): number {
  return Math.max(-(width + 24), Math.min(0, base + dx));
}

/** Where it settles when the finger lifts: open past half its actions. */
export function swipeSettles(offset: number, width = SWIPE_ACTIONS_WIDTH): 'open' | 'closed' {
  return offset < -width / 2 ? 'open' : 'closed';
}
