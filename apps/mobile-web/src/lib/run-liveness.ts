/**
 * Is this run alive RIGHT NOW — or is it a remembered copy that still says so?
 *
 * `status: 'running'` is a fact about the moment the answer was taken, not a
 * liveness certificate. The service worker keeps a stamped last-good copy of
 * /m/api/runs/:id (lib/last-good.ts), and a run that was running when the copy
 * was taken is still running IN THE COPY forever. Rendered naively that copy
 * pulses, counts a clock up from a start time that may be days old, and offers
 * a Stop button for a process this phone cannot reach — the most literal form
 * of showing stale data as live.
 *
 * So liveness is derived from BOTH halves: an active status AND a live read.
 * A stamped copy is never live, whatever it says about itself.
 */
import { isActiveRunStatus } from './api';

export function runIsLive(input: {
  status: string | null | undefined;
  /** The last-good stamp for the path this run came from; null = live read. */
  stampedAt: string | null;
}): boolean {
  if (!input.status) return false;
  // A remembered copy cannot be evidence of what is happening now.
  if (input.stampedAt) return false;
  return isActiveRunStatus(input.status);
}

/**
 * How long it has been going, or null when that cannot be known.
 *
 * A live run measures against the clock. A settled one measures against its
 * last event. A run that is NEITHER — a remembered copy of an active run, or
 * one with no event yet — has no honest end point, so it gets no number at
 * all rather than a clock ticking up from a start time in the past.
 */
export function runElapsedLabel(input: {
  startedAt: number | null;
  lastEventAt: number | null;
  live: boolean;
  nowMs: number;
}): string | null {
  if (input.startedAt === null || !Number.isFinite(input.startedAt)) return null;
  const end = input.live ? input.nowMs : input.lastEventAt;
  if (end === null || !Number.isFinite(end)) return null;
  const seconds = Math.max(0, Math.round((end - input.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
