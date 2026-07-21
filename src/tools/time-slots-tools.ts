/**
 * time_slots tool (2026-07-21) — mutual-availability computation
 * (capability audit missing-primitive #6: meeting scheduling with N
 * attendees was genuinely absent — nothing crossed free/busy windows).
 *
 * Division of labor: the CALENDARS are fetched via the normal Composio
 * free/busy actions (GOOGLECALENDAR free/busy, OUTLOOK get-schedule /
 * find-available-time — passthrough already works); THIS tool is the pure
 * interval algebra those results feed: merge every attendee's busy windows,
 * invert within the search window, clip to working hours, and return slots
 * long enough for the meeting. Deterministic — a scheduling suggestion must
 * never be a model's guess about time arithmetic.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult } from './shared.js';

export interface BusyInterval { start: number; end: number }

function parseIso(value: unknown, label: string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw new Error(`${label} is not a valid ISO datetime: ${String(value)}`);
  return ms;
}

/** Accepts {attendee: [{start,end}...]} or a flat [{start,end}...] array. */
export function parseBusy(json: string): BusyInterval[] {
  const parsed = JSON.parse(json) as unknown;
  const rawIntervals: Array<{ start?: unknown; end?: unknown }> = [];
  if (Array.isArray(parsed)) {
    rawIntervals.push(...(parsed as Array<{ start?: unknown; end?: unknown }>));
  } else if (parsed && typeof parsed === 'object') {
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) rawIntervals.push(...(value as Array<{ start?: unknown; end?: unknown }>));
    }
  } else {
    throw new Error('busy must be a JSON array of {start,end} or an object of attendee → intervals.');
  }
  return rawIntervals.map((interval, i) => ({
    start: parseIso(interval?.start, `busy[${i}].start`),
    end: parseIso(interval?.end, `busy[${i}].end`),
  })).filter((iv) => iv.end > iv.start);
}

export function mergeIntervals(intervals: BusyInterval[]): BusyInterval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: BusyInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** Free slots = window minus busy, clipped to working hours per LOCAL day,
 *  minimum `durationMs`, optionally weekdays only. */
export function computeFreeSlots(opts: {
  busy: BusyInterval[];
  windowStart: number;
  windowEnd: number;
  durationMs: number;
  workStartMinutes: number; // minutes past local midnight
  workEndMinutes: number;
  weekdaysOnly: boolean;
  maxSlots: number;
}): BusyInterval[] {
  const busy = mergeIntervals(opts.busy);
  const slots: BusyInterval[] = [];
  // Walk day by day in LOCAL time.
  const cursor = new Date(opts.windowStart);
  cursor.setHours(0, 0, 0, 0);
  for (let day = new Date(cursor); day.getTime() < opts.windowEnd && slots.length < opts.maxSlots; day.setDate(day.getDate() + 1)) {
    if (opts.weekdaysOnly && (day.getDay() === 0 || day.getDay() === 6)) continue;
    const dayStart = Math.max(opts.windowStart, day.getTime() + opts.workStartMinutes * 60_000);
    const dayEnd = Math.min(opts.windowEnd, day.getTime() + opts.workEndMinutes * 60_000);
    if (dayEnd <= dayStart) continue;
    let free = dayStart;
    for (const interval of busy) {
      if (interval.end <= free || interval.start >= dayEnd) continue;
      if (interval.start > free && interval.start - free >= opts.durationMs) {
        slots.push({ start: free, end: interval.start });
        if (slots.length >= opts.maxSlots) return slots;
      }
      free = Math.max(free, interval.end);
    }
    if (dayEnd > free && dayEnd - free >= opts.durationMs) {
      slots.push({ start: free, end: dayEnd });
    }
  }
  return slots.slice(0, opts.maxSlots);
}

function parseHhMm(value: string | undefined, fallbackMinutes: number, label: string): number {
  if (!value) return fallbackMinutes;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`${label} must be HH:MM (e.g. "09:00").`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function registerTimeSlotsTools(server: McpServer): void {
  server.tool(
    'time_slots',
    [
      'Compute MUTUAL free meeting slots from attendees\' busy intervals — exact interval algebra, never guessed time math.',
      'Workflow: fetch each attendee\'s busy windows first (Composio free/busy actions, e.g. Google Calendar FreeBusy / Outlook GetSchedule), then pass ALL of them here as `busy` — a JSON object {attendee: [{start,end}...]} or a flat array. Returns slots where EVERYONE is free.',
      'Constraints: window_start/window_end (ISO), duration_minutes, working hours (default 09:00–17:00 local), weekdays_only (default true).',
    ].join(' '),
    {
      busy: z.string().describe('JSON: {attendee: [{start,end}...], ...} or flat [{start,end}...]. ISO datetimes.'),
      window_start: z.string().describe('ISO start of the search window.'),
      window_end: z.string().describe('ISO end of the search window.'),
      duration_minutes: z.number().int().min(5).max(8 * 60),
      work_start: z.string().optional().describe('HH:MM local (default 09:00).'),
      work_end: z.string().optional().describe('HH:MM local (default 17:00).'),
      weekdays_only: z.boolean().optional(),
      max_slots: z.number().int().min(1).max(20).optional(),
    },
    async (args) => {
      try {
        const slots = computeFreeSlots({
          busy: parseBusy(args.busy),
          windowStart: parseIso(args.window_start, 'window_start'),
          windowEnd: parseIso(args.window_end, 'window_end'),
          durationMs: args.duration_minutes * 60_000,
          workStartMinutes: parseHhMm(args.work_start, 9 * 60, 'work_start'),
          workEndMinutes: parseHhMm(args.work_end, 17 * 60, 'work_end'),
          weekdaysOnly: args.weekdays_only !== false,
          maxSlots: args.max_slots ?? 8,
        });
        if (slots.length === 0) {
          return textResult(JSON.stringify({
            slots: [],
            note: 'No mutual slot fits. Widen the window, shorten the duration, relax working hours — or check that every attendee\'s busy data was actually fetched (missing data reads as fully free, so a suspiciously-open calendar may mean a failed fetch).',
          }));
        }
        return textResult(JSON.stringify({
          slots: slots.map((s) => ({
            start: new Date(s.start).toISOString(),
            end: new Date(s.end).toISOString(),
            fits_minutes: Math.floor((s.end - s.start) / 60_000),
          })),
          note: 'Every listed slot is free for ALL provided attendees. Propose from these; create the event with the normal calendar action.',
        }, null, 1));
      } catch (err) {
        return textResult(`ERROR: time_slots failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
