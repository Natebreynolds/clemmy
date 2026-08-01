/**
 * Who is actually LOOKING at a session right now.
 *
 * Every in-app chat surface (desktop dock, mobile, the Workspace dock) renders a
 * run by holding open an SSE subscription to `/api/sessions/:id/events`. That
 * subscription is therefore the one honest signal for "the user is in the room":
 * it exists exactly while a client has the conversation on screen, and it drops
 * the moment they close it. Nothing else in the system knows this — a run's
 * result is written to the transcript whether anyone is there to read it or not.
 *
 * The terminal report-back (see terminal-report-back.ts) needs that signal to
 * decide whether a finished run still owes the user an out-of-band ping. So this
 * module keeps a tiny in-memory attach/detach ledger, plus the LAST time a
 * viewer was seen — because "did anyone see it" is a question about a window of
 * time, not about this instant. A user who watched the run land and then closed
 * the window has seen it; a user who left ten minutes before it finished has not.
 *
 * In-memory on purpose: a viewer is a live socket, so the fact does not outlive
 * the process that holds it. A restart correctly reports zero viewers.
 */

interface ViewerState {
  /** Currently-open subscriptions for this session. */
  count: number;
  /** Epoch ms of the most recent moment a viewer was attached. */
  lastSeenMs: number;
}

const viewers = new Map<string, ViewerState>();

function stateFor(sessionId: string): ViewerState {
  let state = viewers.get(sessionId);
  if (!state) {
    state = { count: 0, lastSeenMs: 0 };
    viewers.set(sessionId, state);
  }
  return state;
}

/**
 * Register an open live view of `sessionId`. Returns the detach function; it is
 * idempotent, so a surface that calls it from both `close` and `error` handlers
 * (every SSE route does) can never drive the count negative.
 */
export function attachSessionViewer(sessionId: string, now = Date.now()): (at?: number) => void {
  if (!sessionId) return () => {};
  pruneForgottenViewers(now);
  const state = stateFor(sessionId);
  state.count += 1;
  state.lastSeenMs = now;
  let detached = false;
  return (detachAt = Date.now()): void => {
    if (detached) return;
    detached = true;
    const current = viewers.get(sessionId);
    if (!current) return;
    current.count = Math.max(0, current.count - 1);
    current.lastSeenMs = detachAt;
  };
}

/** How long a departed viewer's "was here" timestamp stays interesting. */
const VIEWER_MEMORY_MS = 60 * 60_000;

/**
 * Drop entries for sessions nobody has watched in an hour, so a long-lived
 * daemon does not accumulate one row per conversation ever opened. Swept on
 * attach (the only path that grows the map) rather than on a timer.
 */
function pruneForgottenViewers(now: number): void {
  for (const [id, state] of viewers) {
    if (state.count === 0 && now - state.lastSeenMs > VIEWER_MEMORY_MS) viewers.delete(id);
  }
}

export function sessionViewerCount(sessionId: string): number {
  return viewers.get(sessionId)?.count ?? 0;
}

/**
 * Was a viewer present at any point at or after `sinceMs`? True while one is
 * attached right now, and true for one who has since left but was there during
 * the window. This is the question the report-back decision actually asks: not
 * "is someone watching" but "did this result reach a pair of eyes".
 */
export function sessionViewerSeenSince(sessionId: string, sinceMs: number): boolean {
  const state = viewers.get(sessionId);
  if (!state) return false;
  if (state.count > 0) return true;
  return state.lastSeenMs >= sinceMs;
}

/** Test-only reset; the ledger is process-global by design. */
export function resetSessionViewersForTest(): void {
  viewers.clear();
}
