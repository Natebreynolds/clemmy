/**
 * Short-term reminder timers (2026-07-20) — the FIRING half of `set_timer`.
 *
 * The attorney-bar schedules audit found `set_timer` was WRITE-ONLY: the tool
 * appended to `.timers.json` and told the user "Timer set", but no consumer
 * existed anywhere — every "remind me in 30 minutes" was silently, permanently
 * lost. This module owns the timer store and the daemon-tick firing pass.
 *
 * Reliability contract (mirrors the durable scheduler family, not the fragile
 * one): firing is a DUE-TIMESTAMP COMPARE (fireAt <= now), so a timer survives
 * restarts and laptop sleep — it fires on the first tick after wake, late but
 * never lost, and says so honestly when it is late. A corrupt store is
 * quarantined + surfaced, never silently treated as empty (the audit's
 * "corrupt file = all commitments vanish, zero signal" class).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import pino from 'pino';
import { TIMERS_FILE } from '../tools/shared.js';
import { addNotification } from './notifications.js';

const logger = pino({ name: 'clementine.timers' });

export interface TimerEntry {
  id: string;
  message: string;
  fireAt: number;
  createdAt: number;
}

/** A fire more than this late gets the honest "delayed" annotation. */
const LATE_ANNOTATION_MS = 2 * 60_000;

export function readTimers(): TimerEntry[] {
  if (!existsSync(TIMERS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(TIMERS_FILE, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as TimerEntry[]) : [];
  } catch (err) {
    // Never silently treat a corrupt store as empty: quarantine the file so
    // the bytes survive for repair, and tell the user their reminders are in
    // limbo instead of letting them evaporate.
    const quarantine = `${TIMERS_FILE}.corrupt-${Date.now()}`;
    try { renameSync(TIMERS_FILE, quarantine); } catch { /* keep the original if rename fails */ }
    logger.warn({ err: err instanceof Error ? err.message : String(err), quarantine }, 'timers store corrupt — quarantined');
    try {
      addNotification({
        id: `timers-corrupt-${Date.now()}`,
        kind: 'system',
        title: 'Reminder store was corrupt',
        body: `The reminder file could not be read, so pending reminders may not fire. The unreadable file was kept at ${quarantine}. Re-set any reminders you still need.`,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { quarantine },
      });
    } catch { /* notification is best-effort; the log line stands */ }
    return [];
  }
}

export function writeTimers(timers: TimerEntry[]): void {
  writeFileSync(TIMERS_FILE, JSON.stringify(timers, null, 2), 'utf-8');
}

/** One daemon-tick firing pass. Returns how many timers fired. Never throws. */
export function fireDueTimers(now: number = Date.now()): number {
  try {
    const timers = readTimers();
    if (timers.length === 0) return 0;
    const due = timers.filter((t) => typeof t.fireAt === 'number' && t.fireAt <= now);
    if (due.length === 0) return 0;
    const remaining = timers.filter((t) => !(typeof t.fireAt === 'number' && t.fireAt <= now));
    let fired = 0;
    for (const timer of due) {
      const lateMs = now - timer.fireAt;
      const lateNote = lateMs > LATE_ANNOTATION_MS
        ? ` (delayed ${Math.round(lateMs / 60_000)} min — the app was closed or your Mac was asleep when it was due)`
        : '';
      try {
        addNotification({
          id: `timer-fired-${timer.id}`,
          kind: 'system',
          title: 'Reminder',
          body: `${timer.message}${lateNote}`,
          createdAt: new Date(now).toISOString(),
          read: false,
          metadata: { timerId: timer.id, fireAt: timer.fireAt, lateMs },
        });
        fired += 1;
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), timerId: timer.id }, 'timer fire notification failed — keeping the timer for retry');
        remaining.push(timer); // do NOT drop a reminder whose delivery failed
      }
    }
    writeTimers(remaining);
    return fired;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'timer firing pass failed');
    return 0;
  }
}
