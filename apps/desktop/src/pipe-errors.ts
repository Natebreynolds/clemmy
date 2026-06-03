/**
 * Benign-pipe-error detection for the Electron main process's global error
 * handlers.
 *
 * A broken pipe to an OPTIONAL child helper — most notably the Recall.ai
 * meeting-recorder's native process (`@recallai/desktop-sdk`), which writes to
 * its child's stdin via flushPendingStdinWrites/enqueueStdinWrite — is
 * recoverable and must NEVER take down the whole app. Before v0.5.64 the global
 * `uncaughtException` handler treated ANY error as a fatal boot failure, so a
 * single `write EPIPE` from the recorder crash-looped the app on startup
 * (observed 300+ times in one user's log). These are logged, not fatal.
 */
export function isBenignPipeError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EPIPE' || code === 'ECONNRESET') return true;
  // The error may arrive wrapped (e.g. an AggregateError or a re-thrown Error
  // whose .code was lost) — fall back to a message check for the EPIPE marker.
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /\bEPIPE\b/.test(message);
}
