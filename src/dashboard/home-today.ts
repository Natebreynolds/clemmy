/**
 * Today, for Home: the next day of the owner's calendar as the calendar watch
 * last read it. No provider call and no model call — the watch already reads
 * every connected calendar on its heartbeat and keeps that read
 * (`CalendarWatchState.snapshot`); this only projects it, and says how old it
 * is so a quiet watch is never shown as a live calendar.
 */
import { isUnansweredInvite, type CalendarWatchState } from '../agents/calendar-watch.js';

export interface HomeTodayEvent {
  key: string;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  /** Invited, and no answer given yet. */
  needsReply: boolean;
  attendeeCount: number;
  location?: string;
}

export interface HomeToday {
  /** At least one calendar is connected to the watch. */
  connected: boolean;
  /** When the events below were read; null if they never were. */
  asOf: string | null;
  /** When the watch reads again, if it is scheduled. */
  nextCheckAt: string | null;
  /** The last read failed; the events below are the read before it. */
  lastError: string | null;
  events: HomeTodayEvent[];
}

const MAX_EVENTS = 8;

export function projectHomeToday(input: {
  state: Pick<CalendarWatchState, 'snapshot' | 'snapshotAt' | 'lastError'>;
  connectedOperations: readonly string[];
  nextTickAt?: string;
  nowMs: number;
}): HomeToday {
  const seen = new Set<string>();
  const events: HomeTodayEvent[] = [];
  const all = Object.values(input.state.snapshot ?? {}).flatMap((byId) => Object.values(byId ?? {}));
  all.sort((a, b) => a.startMs - b.startMs);
  for (const event of all) {
    // Cancelled, over, or declined: not part of the day ahead.
    if (event.isCancelled || event.endMs <= input.nowMs || event.myResponse === 'declined') continue;
    // The same mailbox connected twice reports the same id; one meeting on two
    // calendars reports different ids with the same title and start.
    const byId = `id:${event.id}`;
    const bySlot = `slot:${event.subject.trim().toLowerCase()}|${event.startMs}`;
    if (seen.has(byId) || seen.has(bySlot)) continue;
    seen.add(byId);
    seen.add(bySlot);
    events.push({
      key: event.id,
      title: event.subject.trim() || 'Untitled event',
      startMs: event.startMs,
      endMs: event.endMs,
      allDay: event.isAllDay,
      needsReply: isUnansweredInvite(event),
      attendeeCount: event.attendeeCount,
      ...(event.location ? { location: event.location } : {}),
    });
    if (events.length >= MAX_EVENTS) break;
  }
  return {
    connected: input.connectedOperations.length > 0 || Object.keys(input.state.snapshot ?? {}).length > 0,
    asOf: input.state.snapshotAt ?? null,
    nextCheckAt: input.nextTickAt ?? null,
    lastError: input.state.lastError?.reason ?? null,
    events,
  };
}
