/**
 * One clock per session for the pre-model ceremony.
 *
 * Every row the ceremony writes already carries a timestamp; what nothing
 * recorded is what ran BETWEEN rows. Live 2026-09-15 the gap from the
 * daemon's engine selection to the first model call was 8.9 s and 7.1 s on
 * consecutive turns (recall itself reported 2.1 s) and no row named the rest.
 * Stages mark themselves here as offsets from the engine-selection instant;
 * the context-packet row takes the whole record, so one row answers "where
 * did the pre-model time go" without adding events to the ledger.
 *
 * Keyed by session (one live turn per session). A turn that never reaches the
 * packet row leaves its clock behind; the map is bounded so that costs nothing.
 */
const MAX_CLOCKS = 256;
const clocks = new Map<string, { startedAt: number; marks: Array<[string, number]> }>();

export function startTurnClock(sessionId: string | undefined | null): void {
  if (!sessionId) return;
  clocks.delete(sessionId);
  if (clocks.size >= MAX_CLOCKS) {
    const oldest = clocks.keys().next().value;
    if (oldest !== undefined) clocks.delete(oldest);
  }
  clocks.set(sessionId, { startedAt: Date.now(), marks: [] });
}

/** Record that `stage` is reached now. A session with no running clock is a
 *  no-op, so callers never need to know whether they are on a fresh turn. */
export function markTurnClock(sessionId: string | undefined | null, stage: string): void {
  const clock = sessionId ? clocks.get(sessionId) : undefined;
  if (!clock) return;
  clock.marks.push([stage, Date.now() - clock.startedAt]);
}

/** Take (and clear) the session's record: each stage's offset in ms from the
 *  clock start, plus `totalMs` at the moment of taking. Null when no clock ran. */
export function takeTurnClock(sessionId: string | undefined | null): Record<string, number> | null {
  const clock = sessionId ? clocks.get(sessionId) : undefined;
  if (!clock || !sessionId) return null;
  clocks.delete(sessionId);
  const stages: Record<string, number> = {};
  for (const [stage, offset] of clock.marks) stages[stage] = offset;
  stages.totalMs = Date.now() - clock.startedAt;
  return stages;
}

/** Test-only. */
export function _resetTurnClocksForTests(): void {
  clocks.clear();
}
