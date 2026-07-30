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

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import pino from 'pino';
import { TIMERS_FILE } from '../tools/shared.js';
import { addNotification } from './notifications.js';
import { withFileLockSyncStrict } from './atomic-json.js';
import {
  claimProspectiveIntention,
  prospectiveIntentionId,
  recordProspectiveCue,
  recordProspectiveOutcome,
} from './prospective-intentions.js';

const logger = pino({ name: 'clementine.timers' });

export interface TimerEntry {
  id: string;
  message: string;
  fireAt: number;
  createdAt: number;
  /** Durable routing snapshot captured when the reminder is authored. */
  metadata?: {
    originSessionId?: string;
    discordUserId?: string;
    discordChannelId?: string;
    slackUserId?: string;
    slackChannelId?: string;
    slackThreadTs?: string;
  };
}

/** A fire more than this late gets the honest "delayed" annotation. */
const LATE_ANNOTATION_MS = 2 * 60_000;
const MAX_TIMER_AHEAD_MS = 24 * 60 * 60_000;

export type TimerFireAtInput = {
  minutes?: number | null;
  fireAt?: string | null;
};

export type TimerFireAtResolution =
  | { ok: true; fireAt: number; confirmationTarget: string }
  | { ok: false; error: string };

/**
 * Resolve the model's already-interpreted reminder time without doing natural
 * language parsing in the harness. Exact wall-clock reminders use an ISO 8601
 * timestamp with an explicit offset; relative reminders retain the original
 * `minutes` contract.
 */
export function resolveTimerFireAt(
  input: TimerFireAtInput,
  now: number = Date.now(),
): TimerFireAtResolution {
  const hasMinutes = typeof input.minutes === 'number' && Number.isFinite(input.minutes);
  const exact = typeof input.fireAt === 'string' ? input.fireAt.trim() : '';
  const hasExact = exact.length > 0;

  if (hasMinutes === hasExact) {
    return {
      ok: false,
      error: 'Provide exactly one of minutes or fire_at.',
    };
  }

  if (hasMinutes) {
    const minutes = input.minutes!;
    if (minutes < 1 || minutes > 1440) {
      return { ok: false, error: 'minutes must be between 1 and 1440.' };
    }
    return {
      ok: true,
      fireAt: now + minutes * 60_000,
      confirmationTarget: `${minutes} minute${minutes === 1 ? '' : 's'} from now`,
    };
  }

  // Requiring an explicit offset keeps "10 PM" tied to the wall clock the
  // model showed the user instead of silently interpreting it in the daemon's
  // process timezone.
  if (!/T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(exact)) {
    return {
      ok: false,
      error: 'fire_at must be an ISO 8601 timestamp with an explicit UTC offset (for example 2026-07-30T22:00:00-07:00).',
    };
  }
  const fireAt = Date.parse(exact);
  if (!Number.isFinite(fireAt)) {
    return { ok: false, error: 'fire_at is not a valid timestamp.' };
  }
  if (fireAt <= now) {
    return { ok: false, error: 'fire_at must be in the future.' };
  }
  if (fireAt - now > MAX_TIMER_AHEAD_MS) {
    return {
      ok: false,
      error: 'fire_at must be within the next 24 hours; use a scheduled workflow for a later reminder.',
    };
  }
  return { ok: true, fireAt, confirmationTarget: exact };
}

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

function writeTimersUnlocked(timers: TimerEntry[]): void {
  const tempFile = `${TIMERS_FILE}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(tempFile, JSON.stringify(timers, null, 2), 'utf-8');
    renameSync(tempFile, TIMERS_FILE);
  } catch (err) {
    try { rmSync(tempFile, { force: true }); } catch { /* best-effort temp cleanup */ }
    throw err;
  }
}

export function writeTimers(timers: TimerEntry[]): void {
  withFileLockSyncStrict(TIMERS_FILE, () => writeTimersUnlocked(timers));
}

/** Atomic read-append-write used by set_timer so simultaneous chat turns or a
 * daemon fire pass cannot overwrite one another's reminder records. */
export function appendTimer(timer: TimerEntry): void {
  withFileLockSyncStrict(TIMERS_FILE, () => {
    const timers = readTimers();
    if (!timers.some((entry) => entry.id === timer.id)) timers.push(timer);
    writeTimersUnlocked(timers);
  });
}

/** One daemon-tick firing pass. Returns how many timers fired. Never throws. */
export function fireDueTimers(now: number = Date.now()): number {
  try {
    return withFileLockSyncStrict(TIMERS_FILE, () => {
      const timers = readTimers();
      if (timers.length === 0) return 0;
      const due = timers.filter((t) => typeof t.fireAt === 'number' && t.fireAt <= now);
      if (due.length === 0) return 0;
      const remaining = timers.filter((t) => !(typeof t.fireAt === 'number' && t.fireAt <= now));
      let fired = 0;
      for (const timer of due) {
        const lateMs = now - timer.fireAt;
        const intentionId = prospectiveIntentionId('timer', timer.id);
        const cueKey = `time:${new Date(timer.fireAt).toISOString()}`;
        try {
          recordProspectiveCue(intentionId, cueKey, { timerId: timer.id, fireAt: timer.fireAt }, new Date(now));
          claimProspectiveIntention(intentionId, cueKey, 'timer-daemon', new Date(now));
        } catch { /* the timer file remains the execution authority */ }
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
            metadata: {
              timerId: timer.id,
              fireAt: timer.fireAt,
              lateMs,
              ...(timer.metadata ?? {}),
            },
          });
          fired += 1;
          try {
            recordProspectiveOutcome(
              intentionId,
              'completed',
              { notificationId: `timer-fired-${timer.id}`, fireAt: timer.fireAt, lateMs },
              new Date(now),
            );
          } catch { /* best-effort control-plane receipt */ }
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err), timerId: timer.id }, 'timer fire notification failed — keeping the timer for retry');
          remaining.push(timer); // do NOT drop a reminder whose delivery failed
          try {
            recordProspectiveOutcome(
              intentionId,
              'blocked',
              { reason: 'notification_delivery_failed', error: err instanceof Error ? err.message : String(err) },
              new Date(now),
            );
          } catch { /* best-effort control-plane receipt */ }
        }
      }
      writeTimersUnlocked(remaining);
      return fired;
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'timer firing pass failed');
    return 0;
  }
}
