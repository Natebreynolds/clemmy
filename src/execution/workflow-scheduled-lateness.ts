/**
 * A scheduled workflow occurrence that Clementine evaluates after its minute
 * (the machine slept, the daemon restarted) RUNS — it is never parked for a
 * human Resume/Skip decision. What the model gets instead is the fact: how
 * late the run is and how many occurrences it stands for, so a time-sensitive
 * step can judge in its own words. Live 2026-09-01: the owner's 16:00 Slack
 * review sat "waiting for Resume/Skip" for an hour after the laptop slept
 * through 16:00, with nothing wrong except the tick that saw it at 16:03.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';

export interface ScheduledLatenessRecord {
  catchupFire?: unknown;
  catchupOccurrenceAtMs?: unknown;
  catchupMissedCount?: unknown;
}

/** The lead-in appended to a late scheduled step's prompt; empty for a live one. */
export function scheduledLatenessLeadIn(
  record: ScheduledLatenessRecord | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (!record || record.catchupFire !== true) return '';
  const due = record.catchupOccurrenceAtMs;
  if (typeof due !== 'number' || !Number.isSafeInteger(due) || due < 0) return '';
  const lateMinutes = Math.max(0, Math.round((nowMs - due) / 60_000));
  const missed = typeof record.catchupMissedCount === 'number'
    && Number.isSafeInteger(record.catchupMissedCount)
    && record.catchupMissedCount > 1
    ? record.catchupMissedCount
    : 1;
  const lateText = lateMinutes < 120
    ? `${lateMinutes} minute${lateMinutes === 1 ? '' : 's'}`
    : `${Math.round(lateMinutes / 60)} hours`;
  return `\n\nTiming: this scheduled occurrence was due at ${new Date(due).toISOString()} and is starting about ${lateText} late`
    + (missed > 1 ? ` (${missed} occurrences were missed; this run stands for all of them)` : '')
    + ' because Clementine was asleep or restarting. If the work is time-sensitive and no longer useful this late,'
    + ' say so plainly in your result instead of doing it; otherwise do it now.';
}

/** Same, read from the durable run record; never throws (an unreadable record
 * means no lead-in, never a stopped step). */
export function scheduledLatenessLeadInForRun(runId: string, nowMs: number = Date.now()): string {
  try {
    const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
    if (!existsSync(filePath)) return '';
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object'
      ? scheduledLatenessLeadIn(parsed as ScheduledLatenessRecord, nowMs)
      : '';
  } catch {
    return '';
  }
}
