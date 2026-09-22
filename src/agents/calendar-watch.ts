/**
 * Calendar watch — a heartbeat on a contract.
 *
 * The old ambient calendar monitor scored every upcoming event on every scan
 * and emitted one card per qualifying event id; it also read the provider
 * directly and so was never scheduled once reads required accepted authority.
 * This module is its replacement and works differently by construction:
 *
 *  1. DETERMINISTIC CHANGE DETECTION BEFORE ANY MODEL CALL. Each tick keeps a
 *     snapshot of the upcoming window per account and diffs it against the
 *     previous tick. A tick with no change is quiet: no model call, no
 *     notification, nothing but a counter.
 *  2. ONE ITEM PER MEANINGFUL CHANGE. A change is keyed by (account, event,
 *     kind[, version]); the key persists with the item, so a restart, a
 *     re-read or a second device never produces the same item twice.
 *  3. JEV DECIDES "DOES THIS CHANGE MATTER?" — only for low-signal classes
 *     (a moved meeting). Cancellations, new double-bookings and unanswered
 *     invites always surface; a Jev failure fails open to the deterministic
 *     rule. The model is spent only on the ambiguous cases.
 *  4. ITEMS RETIRE THEMSELVES when the underlying state resolves (the invite
 *     is answered, the overlap is gone, the event has passed) and the
 *     notification is marked read, so "Needs you" tracks reality.
 *  5. MEASURED BY USEFUL ACTIONS, not notifications: ticks, quiet ticks,
 *     model calls, items produced, items acknowledged, items retired by
 *     resolution, duplicates suppressed.
 *
 * Pure and deps-injected: reading, judging, notifying and persistence are
 * ports so the contract pins offline. The production ports live in
 * calendar-watch-runtime.ts, which reads through the prepared workflow read
 * path (never the raw provider client).
 */
import { createHash } from 'node:crypto';
import type { NotificationRecord } from '../runtime/notifications.js';

export interface CalEvent {
  id: string;
  subject: string;
  startMs: number;
  endMs: number;
  isAllDay: boolean;
  isCancelled: boolean;
  /** free | tentative | busy | oof | ... */
  showAs: string;
  /** organizer | accepted | tentativelyAccepted | declined | notResponded | none | needsAction | '' */
  myResponse: string;
  attendeeCount: number;
  organizer?: string;
  location?: string;
}

export interface CalendarWatchAccountRead {
  operationId: string;
  accountId: string;
  accountLabel: string;
  events: CalEvent[];
}

export interface CalendarWatchReadFailure {
  operationId: string;
  accountId?: string;
  reason: string;
}

export type CalendarWatchChangeKind =
  | 'cancelled'
  | 'removed'
  | 'conflict'
  | 'invite_unanswered'
  | 'moved'
  | 'starting_soon';

/** High-signal classes always surface; low-signal classes may be vetoed by Jev. */
export type CalendarWatchSignal = 'high' | 'low';

export interface CalendarWatchChange {
  kind: CalendarWatchChangeKind;
  signal: CalendarWatchSignal;
  itemKey: string;
  eventKey: string;
  operationId: string;
  accountId: string;
  accountLabel: string;
  event: CalEvent;
  other?: CalEvent;
  previous?: { startMs: number; endMs: number };
  reasons: string[];
}

export interface CalendarWatchItem {
  key: string;
  /** Account-independent identity of the change: the same mailbox connected
   * twice reports the same event ids, and must yield ONE item. */
  eventKey?: string;
  kind: CalendarWatchChangeKind;
  signal: CalendarWatchSignal;
  accountId: string;
  eventId: string;
  otherEventId?: string;
  subject: string;
  eventStartMs: number;
  eventEndMs: number;
  notificationId?: string;
  createdAt: string;
  tickId: string;
  acknowledgedAt?: string;
  retiredAt?: string;
  retiredReason?: 'event_passed' | 'event_cancelled' | 'invite_answered' | 'overlap_gone' | 'event_started' | 'jev_veto' | 'superseded' | 'duplicate_account';
}

export interface CalendarWatchMetrics {
  ticks: number;
  quietTicks: number;
  changedTicks: number;
  reads: number;
  readFailures: number;
  modelCalls: number;
  modelVetoes: number;
  modelFailures: number;
  itemsProduced: number;
  itemsAcknowledged: number;
  itemsRetired: number;
  duplicatesSuppressed: number;
}

export interface CalendarWatchFinding {
  tickId: string;
  at: string;
  source: string;
  durationMs: number;
  accounts: number;
  events: number;
  changes: number;
  produced: number;
  vetoed: number;
  retired: number;
  quiet: boolean;
  readFailures: number;
  /** Short human line for the status card. */
  summary: string;
}

export interface CalendarWatchState {
  version: 1;
  lastTickAt?: string;
  lastTickId?: string;
  snapshotAt?: string;
  /** accountId → eventId → event, for the last successfully read window. */
  snapshot: Record<string, Record<string, CalEvent>>;
  items: Record<string, CalendarWatchItem>;
  metrics: CalendarWatchMetrics;
  lastFinding?: CalendarWatchFinding;
  lastError?: { at: string; reason: string };
}

export interface CalendarWatchConfig {
  lookaheadMs: number;
  /** A start/end shift smaller than this is not a "move". */
  movedThresholdMs: number;
  soonMs: number;
  /** Off by default: a meeting starting is a clock event, not a calendar change. */
  startingSoonEnabled: boolean;
  maxJudgeCallsPerTick: number;
  maxItemsPerTick: number;
  fetchTop: number;
}

export interface CalendarWatchJudgeVerdict {
  surface: boolean;
  confidence: number;
  model: string;
  durationMs: number;
}

export interface CalendarWatchTickResult extends CalendarWatchFinding {
  items: CalendarWatchItem[];
  changesByKind: Partial<Record<CalendarWatchChangeKind, number>>;
  judged: number;
  duplicatesSuppressed: number;
  acknowledged: number;
  failures: CalendarWatchReadFailure[];
  /** The normalized events seen this tick, for measurement replays. */
  seenEvents: Array<CalEvent & { accountId: string }>;
}

export interface CalendarWatchDeps {
  now: () => number;
  tickId: string;
  source: string;
  timezone: string;
  config: CalendarWatchConfig;
  readAccounts: (window: { startIso: string; endIso: string; top: number; timezone: string }) => Promise<{
    reads: CalendarWatchAccountRead[];
    failures: CalendarWatchReadFailure[];
  }>;
  /** Jev "does this change matter?" port. Null = unavailable → fail open. */
  judgeChange?: (change: CalendarWatchChange, context: { timezone: string; nowMs: number }) => Promise<CalendarWatchJudgeVerdict | null>;
  notify: (n: NotificationRecord) => void;
  isNotificationRead: (id: string) => boolean;
  markNotificationRead: (id: string) => void;
  loadState: () => CalendarWatchState;
  saveState: (s: CalendarWatchState) => void;
}

export const DEFAULT_CALENDAR_WATCH_CONFIG: CalendarWatchConfig = {
  lookaheadMs: 24 * 60 * 60 * 1000,
  movedThresholdMs: 15 * 60 * 1000,
  soonMs: 45 * 60 * 1000,
  startingSoonEnabled: false,
  maxJudgeCallsPerTick: 5,
  maxItemsPerTick: 8,
  fetchTop: 50,
};

export const JEV_WATCH_VETO_CONFIDENCE_MIN = 0.6;

export function emptyCalendarWatchState(): CalendarWatchState {
  return {
    version: 1,
    snapshot: {},
    items: {},
    metrics: {
      ticks: 0,
      quietTicks: 0,
      changedTicks: 0,
      reads: 0,
      readFailures: 0,
      modelCalls: 0,
      modelVetoes: 0,
      modelFailures: 0,
      itemsProduced: 0,
      itemsAcknowledged: 0,
      itemsRetired: 0,
      duplicatesSuppressed: 0,
    },
  };
}

// ── provider payload parsing (defensive; shared with the old monitor) ────────
function asArray(x: unknown): unknown[] { return Array.isArray(x) ? x : []; }
function pick(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === 'object' && k in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
}
function str(x: unknown): string { return typeof x === 'string' ? x : ''; }
function parseMs(dt: string): number {
  if (!dt) return NaN;
  const hasZone = dt.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(dt);
  return Date.parse(hasZone ? dt : `${dt}Z`);
}

function zoneOffsetMs(zone: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(atMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(atMs / 1000) * 1000;
}

/**
 * Graph returns `start.dateTime` as a WALL-CLOCK time in `start.timeZone`:
 * UTC when nothing was asked for, the requested zone otherwise (the watch
 * asks for the owner's zone, so a 9:00 meeting comes back as "09:00" with
 * timeZone "America/Los_Angeles"). A bare datetime is therefore converted
 * from that zone; treating it as UTC put every item seven hours early
 * (live 2026-09-22, "Tue 2:00 AM" for a 9:00 AM meeting).
 */
export function wallClockToUtcMs(dt: string, zone: string | undefined): number {
  if (!dt) return NaN;
  const hasZone = dt.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(dt);
  if (hasZone) return Date.parse(dt);
  const asUtc = Date.parse(`${dt}Z`);
  if (!Number.isFinite(asUtc) || !zone || zone.toUpperCase() === 'UTC') return asUtc;
  try {
    // Two passes settle a DST edge: the offset at the guessed instant, then
    // the offset at the corrected instant.
    let instant = asUtc - zoneOffsetMs(zone, asUtc);
    instant = asUtc - zoneOffsetMs(zone, instant);
    return instant;
  } catch {
    return asUtc; // an unknown zone label: keep the bare reading rather than drop the event
  }
}
export function locateCalendarEvents(payload: unknown): unknown[] {
  return asArray(
    pick(payload, 'data', 'value')
    ?? pick(payload, 'data', 'events')
    ?? pick(payload, 'data', 'items')
    ?? pick(payload, 'data', 'response_data', 'value')
    ?? pick(payload, 'value')
    ?? pick(payload, 'items')
    ?? pick(payload, 'events')
    ?? pick(payload, 'records')
    ?? (Array.isArray(payload) ? payload : []),
  );
}

export interface CalendarReadOperation {
  operationId: string;
  args: (window: { startIso: string; endIso: string; top: number; timezone: string }) => Record<string, unknown>;
  /** `timezone` is the zone the read asked for; a provider that labels its
   * wall-clock times with an unknown zone is read in that one. */
  parse: (payload: unknown, context: { timezone: string }) => CalEvent[];
}

const OUTLOOK: CalendarReadOperation = {
  operationId: 'outlook_get_calendar_view',
  // The exact argument shape the host's proven strategy already dispatches.
  args: ({ startIso, endIso, top, timezone }) => ({
    start_datetime: startIso,
    end_datetime: endIso,
    timezone,
    top,
    orderby: 'start/dateTime asc',
  }),
  parse: (payload, context) => locateCalendarEvents(payload).map((e): CalEvent => ({
    id: str(pick(e, 'id')),
    subject: str(pick(e, 'subject')) || '(no title)',
    startMs: wallClockToUtcMs(str(pick(e, 'start', 'dateTime')), zoneLabel(str(pick(e, 'start', 'timeZone')), context.timezone)),
    endMs: wallClockToUtcMs(str(pick(e, 'end', 'dateTime')), zoneLabel(str(pick(e, 'end', 'timeZone')), context.timezone)),
    isAllDay: pick(e, 'isAllDay') === true,
    isCancelled: pick(e, 'isCancelled') === true || /^canceled:|^cancelled:/i.test(str(pick(e, 'subject'))),
    showAs: str(pick(e, 'showAs')),
    myResponse: str(pick(e, 'responseStatus', 'response')),
    attendeeCount: asArray(pick(e, 'attendees')).length,
    ...(str(pick(e, 'organizer', 'emailAddress', 'name')) || str(pick(e, 'organizer', 'emailAddress', 'address'))
      ? { organizer: str(pick(e, 'organizer', 'emailAddress', 'name')) || str(pick(e, 'organizer', 'emailAddress', 'address')) }
      : {}),
    ...(str(pick(e, 'location', 'displayName')) ? { location: str(pick(e, 'location', 'displayName')) } : {}),
  })).filter((e) => e.id && Number.isFinite(e.startMs)),
};

/** Graph labels the zone it converted to: 'UTC', an IANA name, or a Windows
 * display name when the caller asked with one. Only UTC and IANA names are
 * convertible here; anything else means "the zone we asked for". */
function zoneLabel(label: string, requested: string): string {
  const trimmed = label.trim();
  if (!trimmed) return 'UTC';
  if (trimmed.toUpperCase() === 'UTC') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return trimmed;
  } catch {
    return requested;
  }
}

const GOOGLE: CalendarReadOperation = {
  operationId: 'googlecalendar_events_list',
  args: ({ startIso, endIso, top }) => ({
    timeMin: startIso,
    timeMax: endIso,
    max_results: top,
    single_events: true,
    order_by: 'startTime',
  }),
  parse: (payload) => locateCalendarEvents(payload).map((e): CalEvent => {
    const startRaw = str(pick(e, 'start', 'dateTime')) || str(pick(e, 'start', 'date'));
    const endRaw = str(pick(e, 'end', 'dateTime')) || str(pick(e, 'end', 'date'));
    const attendees = asArray(pick(e, 'attendees'));
    const self = attendees.find((a) => pick(a, 'self') === true);
    return {
      id: str(pick(e, 'id')),
      subject: str(pick(e, 'summary')) || '(no title)',
      startMs: parseMs(startRaw),
      endMs: parseMs(endRaw),
      isAllDay: !str(pick(e, 'start', 'dateTime')),
      isCancelled: str(pick(e, 'status')) === 'cancelled',
      showAs: str(pick(e, 'transparency')) === 'transparent' ? 'free' : 'busy',
      myResponse: str(pick(self, 'responseStatus')),
      attendeeCount: attendees.length,
      ...(str(pick(e, 'organizer', 'displayName')) || str(pick(e, 'organizer', 'email'))
        ? { organizer: str(pick(e, 'organizer', 'displayName')) || str(pick(e, 'organizer', 'email')) }
        : {}),
      ...(str(pick(e, 'location')) ? { location: str(pick(e, 'location')) } : {}),
    };
  }).filter((e) => e.id && Number.isFinite(e.startMs)),
};

export const CALENDAR_READ_OPERATIONS: readonly CalendarReadOperation[] = [OUTLOOK, GOOGLE];

export function calendarReadOperation(operationId: string): CalendarReadOperation | undefined {
  const key = operationId.trim().toLowerCase();
  return CALENDAR_READ_OPERATIONS.find((op) => op.operationId === key);
}

// ── deterministic change detection ───────────────────────────────────────────
const UNANSWERED = new Set(['notResponded', 'none', 'needsAction']);

function overlaps(a: CalEvent, b: CalEvent): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}
function isCommitment(e: CalEvent): boolean {
  return !e.isCancelled && !e.isAllDay && e.showAs !== 'free' && e.myResponse !== 'declined';
}
function isFirm(e: CalEvent): boolean {
  return isCommitment(e) && e.showAs !== 'tentative';
}
function isUnansweredInvite(e: CalEvent): boolean {
  return isCommitment(e) && e.attendeeCount >= 1 && e.myResponse !== 'organizer' && UNANSWERED.has(e.myResponse);
}

function digest16(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

export function calendarWatchEventKey(input: {
  kind: CalendarWatchChangeKind;
  eventId: string;
  otherEventId?: string;
  version?: string;
}): string {
  const parts: string[] = [input.kind];
  if (input.kind === 'conflict' && input.otherEventId) {
    parts.push(...[input.eventId, input.otherEventId].sort());
  } else {
    parts.push(input.eventId);
  }
  if (input.version) parts.push(input.version);
  return parts.join('|');
}

export function calendarWatchItemKey(input: {
  accountId: string;
  kind: CalendarWatchChangeKind;
  eventId: string;
  otherEventId?: string;
  version?: string;
}): string {
  return `${input.accountId}|${calendarWatchEventKey(input)}`;
}

/**
 * Diff one account's previous window against its current one. `baseline`
 * (no previous snapshot) surfaces only what is actionable on its own —
 * existing double-bookings and unanswered invites — never "moved" or
 * "cancelled", which need a before.
 */
export function detectCalendarChanges(input: {
  operationId: string;
  accountId: string;
  accountLabel: string;
  previous: Record<string, CalEvent> | undefined;
  current: CalEvent[];
  nowMs: number;
  config: CalendarWatchConfig;
}): CalendarWatchChange[] {
  const { operationId, accountId, accountLabel, nowMs, config } = input;
  const baseline = !input.previous;
  const prev = input.previous ?? {};
  const cur = new Map(input.current.map((e) => [e.id, e]));
  const out: CalendarWatchChange[] = [];
  const push = (
    kind: CalendarWatchChangeKind,
    signal: CalendarWatchSignal,
    event: CalEvent,
    reasons: string[],
    extra: { other?: CalEvent; previous?: { startMs: number; endMs: number }; version?: string } = {},
  ): void => {
    const keyInput = {
      kind,
      eventId: event.id,
      ...(extra.other ? { otherEventId: extra.other.id } : {}),
      ...(extra.version ? { version: extra.version } : {}),
    };
    out.push({
      kind,
      signal,
      itemKey: calendarWatchItemKey({ accountId, ...keyInput }),
      eventKey: calendarWatchEventKey(keyInput),
      operationId,
      accountId,
      accountLabel,
      event,
      ...(extra.other ? { other: extra.other } : {}),
      ...(extra.previous ? { previous: extra.previous } : {}),
      reasons,
    });
  };

  const upcoming = input.current.filter((e) => Number.isFinite(e.endMs) && e.endMs > nowMs);
  for (const e of upcoming) {
    const p = prev[e.id];
    if (e.isCancelled) {
      if (p && !p.isCancelled) push('cancelled', 'high', e, ['the organizer cancelled it'], { previous: { startMs: p.startMs, endMs: p.endMs } });
      continue;
    }
    if (isUnansweredInvite(e) && (!p || !isUnansweredInvite(p))) {
      push('invite_unanswered', 'high', e, ['awaiting your response']);
    }
    if (p && !baseline && !p.isCancelled) {
      const startDelta = Math.abs(e.startMs - p.startMs);
      const endDelta = Math.abs(e.endMs - p.endMs);
      if (startDelta >= config.movedThresholdMs || endDelta >= config.movedThresholdMs) {
        push('moved', 'low', e, ['rescheduled'], {
          previous: { startMs: p.startMs, endMs: p.endMs },
          version: digest16(`${e.startMs}-${e.endMs}`),
        });
      }
    }
    if (isFirm(e)) {
      for (const o of upcoming) {
        if (o.id <= e.id || !isFirm(o) || !overlaps(e, o)) continue;
        const po = prev[o.id];
        const alreadyOverlapping = Boolean(p && po && !p.isCancelled && !po.isCancelled && isFirm(p) && isFirm(po) && overlaps(p, po));
        if (!alreadyOverlapping) push('conflict', 'high', e, ['overlaps another event'], { other: o });
      }
    }
    if (config.startingSoonEnabled && isCommitment(e) && e.attendeeCount >= 2) {
      const untilStart = e.startMs - nowMs;
      const wasSoon = p ? p.startMs - nowMs <= config.soonMs : false;
      if (untilStart > 0 && untilStart <= config.soonMs && !wasSoon) push('starting_soon', 'low', e, ['starts soon']);
    }
  }
  if (!baseline) {
    for (const p of Object.values(prev)) {
      if (p.isCancelled || p.startMs <= nowMs || cur.has(p.id)) continue;
      push('removed', 'high', p, ['no longer on your calendar'], { previous: { startMs: p.startMs, endMs: p.endMs } });
    }
  }
  return out;
}

// ── presentation ─────────────────────────────────────────────────────────────
export function formatWhen(ms: number, nowMs: number, timezone: string): string {
  const mins = Math.round((ms - nowMs) / 60_000);
  let clock: string;
  try {
    clock = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(ms));
  } catch {
    clock = new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }
  if (mins > 0 && mins < 60) return `${clock} (in ${mins} min)`;
  if (mins > 0 && mins < 24 * 60) return `${clock} (in ${Math.round(mins / 60)}h)`;
  return clock;
}

function short(subject: string, max = 80): string {
  return subject.length > max ? `${subject.slice(0, max - 3)}...` : subject;
}

/** One notification per item OCCURRENCE. The item key alone would reuse a
 * record from an earlier life of the same change (the store keeps ids
 * at-most-once), so a fresh item would inherit an old read or silent row
 * and never show; the creation instant makes each occurrence its own row. */
export function calendarWatchNotificationId(itemKey: string, kind: CalendarWatchChangeKind, createdAtIso: string): string {
  return `calendar-watch:${kind}:${digest16(`${itemKey}|${createdAtIso}`)}`;
}

export function buildCalendarWatchNotification(
  change: CalendarWatchChange,
  nowMs: number,
  timezone: string,
  tickId: string,
): NotificationRecord {
  const ev = change.event;
  const subject = short(ev.subject);
  const attendees = ev.attendeeCount > 0 ? `${ev.attendeeCount} attendee${ev.attendeeCount === 1 ? '' : 's'}` : '';
  let title: string;
  let lines: string[];
  switch (change.kind) {
    case 'cancelled':
      title = `Cancelled: ${subject}`;
      lines = [`Was ${formatWhen(ev.startMs, nowMs, timezone)}.`, attendees, 'The slot is free again; follow up with the organizer if you need the meeting.'];
      break;
    case 'removed':
      title = `Removed from your calendar: ${subject}`;
      lines = [`Was ${formatWhen(ev.startMs, nowMs, timezone)}.`, attendees, 'Check whether it was cancelled or moved outside the next 24 hours.'];
      break;
    case 'conflict': {
      const other = change.other!;
      title = `Double-booked: ${short(ev.subject, 50)} and ${short(other.subject, 50)}`;
      lines = [
        `${short(ev.subject, 60)} ${formatWhen(ev.startMs, nowMs, timezone)} overlaps ${short(other.subject, 60)} ${formatWhen(other.startMs, nowMs, timezone)}.`,
        'Decide which to keep, or move one.',
      ];
      break;
    }
    case 'invite_unanswered':
      title = `Reply needed: ${subject}`;
      lines = [
        `${formatWhen(ev.startMs, nowMs, timezone)}${attendees ? ` · ${attendees}` : ''}${ev.organizer ? ` · from ${ev.organizer}` : ''}.`,
        'Accept, decline, or propose a time.',
      ];
      break;
    case 'moved':
      title = `Moved: ${subject}`;
      lines = [
        `Now ${formatWhen(ev.startMs, nowMs, timezone)}${change.previous ? ` (was ${formatWhen(change.previous.startMs, nowMs, timezone)})` : ''}.`,
        attendees,
      ];
      break;
    case 'starting_soon':
      title = `Starting soon: ${subject}`;
      lines = [`${formatWhen(ev.startMs, nowMs, timezone)}${attendees ? ` · ${attendees}` : ''}${ev.location ? ` · ${ev.location}` : ''}.`];
      break;
  }
  // Name the calendar only when there is a name to give: the fallback label
  // is the connection id ("Calendar: ca_uDzrJqqniJFk" on the phone, 2026-09-22).
  if (change.accountLabel && change.accountLabel !== change.accountId) lines.push(`Calendar: ${change.accountLabel}`);
  return {
    id: calendarWatchNotificationId(change.itemKey, change.kind, new Date(nowMs).toISOString()),
    kind: 'execution',
    title,
    body: lines.filter(Boolean).join('\n'),
    createdAt: new Date(nowMs).toISOString(),
    read: false,
    // Visible on the desktop and mobile Needs-you feeds, never queued for
    // external delivery (a silent record is hidden from those feeds too).
    metadata: {
      needsAttention: true,
      inboxOnly: true,
      source: 'calendar-watch',
      watch: 'calendar',
      itemKey: change.itemKey,
      changeKind: change.kind,
      signal: change.signal,
      provider: change.operationId,
      account: change.accountLabel,
      connectionId: change.accountId,
      eventId: ev.id,
      ...(change.other ? { otherEventId: change.other.id } : {}),
      startsAt: new Date(ev.startMs).toISOString(),
      reasons: change.reasons,
      tickId,
    },
  };
}

// ── retirement: items follow reality ─────────────────────────────────────────
function retirementReason(
  item: CalendarWatchItem,
  current: Record<string, CalEvent> | undefined,
  nowMs: number,
): CalendarWatchItem['retiredReason'] | undefined {
  if (item.eventEndMs <= nowMs) return 'event_passed';
  if (!current) return undefined; // account not read this tick: keep
  const ev = current[item.eventId];
  switch (item.kind) {
    case 'invite_unanswered':
      if (!ev) return 'event_cancelled';
      if (ev.isCancelled) return 'event_cancelled';
      if (!isUnansweredInvite(ev)) return 'invite_answered';
      return undefined;
    case 'conflict': {
      const other = item.otherEventId ? current[item.otherEventId] : undefined;
      if (!ev || !other || ev.isCancelled || other.isCancelled) return 'overlap_gone';
      if (!isFirm(ev) || !isFirm(other) || !overlaps(ev, other)) return 'overlap_gone';
      return undefined;
    }
    case 'starting_soon':
      if (!ev || ev.isCancelled) return 'event_cancelled';
      if (ev.startMs <= nowMs) return 'event_started';
      return undefined;
    case 'moved':
      if (!ev || ev.isCancelled) return 'event_cancelled';
      if (ev.startMs <= nowMs) return 'event_started';
      return undefined;
    case 'cancelled':
    case 'removed':
      // Terminal facts: they retire when the slot has passed.
      return undefined;
  }
}

// ── the tick ─────────────────────────────────────────────────────────────────
export async function processCalendarWatchTick(deps: CalendarWatchDeps): Promise<CalendarWatchTickResult> {
  const startedAt = deps.now();
  const nowMs = startedAt;
  const state = deps.loadState();
  const cfg = deps.config;
  const window = {
    startIso: new Date(nowMs).toISOString(),
    endIso: new Date(nowMs + cfg.lookaheadMs).toISOString(),
    top: cfg.fetchTop,
    timezone: deps.timezone,
  };

  state.metrics.ticks += 1;
  state.lastTickAt = new Date(nowMs).toISOString();
  state.lastTickId = deps.tickId;

  let reads: CalendarWatchAccountRead[] = [];
  let failures: CalendarWatchReadFailure[] = [];
  try {
    const result = await deps.readAccounts(window);
    reads = result.reads;
    failures = result.failures;
  } catch (error) {
    failures = [{ operationId: 'calendar', reason: error instanceof Error ? error.message : String(error) }];
  }
  state.metrics.reads += reads.length;
  state.metrics.readFailures += failures.length;
  if (failures.length > 0) {
    state.lastError = { at: new Date(nowMs).toISOString(), reason: failures.map((f) => `${f.operationId}${f.accountId ? `/${f.accountId}` : ''}: ${f.reason}`).join('; ') };
  } else {
    delete state.lastError;
  }

  // 1. Deterministic diff per account that was read successfully.
  const changes: CalendarWatchChange[] = [];
  const currentByAccount: Record<string, Record<string, CalEvent>> = {};
  const eventsSeen: Array<CalEvent & { accountId: string }> = [];
  for (const read of reads) {
    const current: Record<string, CalEvent> = {};
    for (const ev of read.events) {
      current[ev.id] = ev;
      eventsSeen.push({ ...ev, accountId: read.accountId });
    }
    currentByAccount[read.accountId] = current;
    changes.push(...detectCalendarChanges({
      operationId: read.operationId,
      accountId: read.accountId,
      accountLabel: read.accountLabel,
      previous: state.snapshot[read.accountId],
      current: read.events,
      nowMs,
      config: cfg,
    }));
  }

  // 2a. Acknowledgements: an OPEN item whose notification the owner read.
  //     Counted before the watch itself marks anything read below.
  let retired = 0;
  let acknowledged = 0;
  for (const item of Object.values(state.items)) {
    if (item.retiredAt || !item.notificationId || item.acknowledgedAt) continue;
    if (deps.isNotificationRead(item.notificationId)) {
      item.acknowledgedAt = new Date(nowMs).toISOString();
      state.metrics.itemsAcknowledged += 1;
      acknowledged += 1;
    }
  }
  // 2b. Two open items for the same event under different accounts (one
  //     mailbox connected twice) collapse to the earliest; the other retires
  //     as a duplicate and its notification is marked read.
  let healedDuplicates = 0;
  const openByEventKey = new Map<string, CalendarWatchItem>();
  for (const item of Object.values(state.items).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (item.retiredAt) continue;
    const eventKey = item.eventKey ?? item.key.slice(item.accountId.length + 1);
    item.eventKey = eventKey;
    const kept = openByEventKey.get(eventKey);
    if (!kept) { openByEventKey.set(eventKey, item); continue; }
    item.retiredAt = new Date(nowMs).toISOString();
    item.retiredReason = 'duplicate_account';
    healedDuplicates += 1;
    if (item.notificationId && !deps.isNotificationRead(item.notificationId)) {
      try { deps.markNotificationRead(item.notificationId); } catch { /* retired either way */ }
    }
  }
  state.metrics.duplicatesSuppressed += healedDuplicates;
  // 2c. Retire items whose state resolved.
  for (const item of Object.values(state.items)) {
    if (item.retiredAt) continue;
    const reason = retirementReason(item, currentByAccount[item.accountId], nowMs);
    if (!reason) continue;
    item.retiredAt = new Date(nowMs).toISOString();
    item.retiredReason = reason;
    state.metrics.itemsRetired += 1;
    retired += 1;
    if (item.notificationId && !deps.isNotificationRead(item.notificationId)) {
      try { deps.markNotificationRead(item.notificationId); } catch { /* the item is retired either way */ }
    }
  }

  // 3. One item per change. Duplicates are suppressed by exact key (same
  //    account) and by event key (same event under another account), within
  //    the tick and against open items.
  let duplicatesSuppressed = healedDuplicates;
  const candidates: CalendarWatchChange[] = [];
  const seenEventKeys = new Set<string>();
  const vetoedEventKeys = new Set(
    Object.values(state.items)
      .filter((item) => item.retiredReason === 'jev_veto')
      .map((item) => item.eventKey ?? item.key.slice(item.accountId.length + 1)),
  );
  for (const change of changes) {
    const existing = state.items[change.itemKey];
    const openElsewhere = openByEventKey.get(change.eventKey);
    if ((existing && !existing.retiredAt) || (openElsewhere && !openElsewhere.retiredAt) || seenEventKeys.has(change.eventKey)) {
      duplicatesSuppressed += 1;
      continue;
    }
    if (existing?.retiredReason === 'jev_veto' || vetoedEventKeys.has(change.eventKey)) {
      duplicatesSuppressed += 1;
      continue;
    }
    seenEventKeys.add(change.eventKey);
    candidates.push(change);
  }
  state.metrics.duplicatesSuppressed += duplicatesSuppressed - healedDuplicates;

  // 4. Jev decides whether a LOW-signal change matters. High-signal never asks.
  let judged = 0;
  let vetoed = 0;
  const surfaced: CalendarWatchChange[] = [];
  const lowSignal = candidates.filter((c) => c.signal === 'low');
  const budget = deps.judgeChange ? Math.min(cfg.maxJudgeCallsPerTick, lowSignal.length) : 0;
  const verdicts = new Map<string, CalendarWatchJudgeVerdict | null>();
  if (budget > 0) {
    const toJudge = lowSignal.slice(0, budget);
    const results = await Promise.all(toJudge.map(async (change) => {
      try {
        return await deps.judgeChange!(change, { timezone: deps.timezone, nowMs });
      } catch {
        return null;
      }
    }));
    toJudge.forEach((change, index) => verdicts.set(change.itemKey, results[index] ?? null));
    judged = toJudge.length;
    state.metrics.modelCalls += judged;
  }
  for (const change of candidates) {
    if (change.signal === 'high') { surfaced.push(change); continue; }
    if (!verdicts.has(change.itemKey)) { surfaced.push(change); continue; } // over budget → rule decides
    const verdict = verdicts.get(change.itemKey);
    if (!verdict) { state.metrics.modelFailures += 1; surfaced.push(change); continue; } // fail open
    if (!verdict.surface && verdict.confidence >= JEV_WATCH_VETO_CONFIDENCE_MIN) {
      vetoed += 1;
      state.metrics.modelVetoes += 1;
      state.items[change.itemKey] = {
        key: change.itemKey,
        eventKey: change.eventKey,
        kind: change.kind,
        signal: change.signal,
        accountId: change.accountId,
        eventId: change.event.id,
        ...(change.other ? { otherEventId: change.other.id } : {}),
        subject: change.event.subject,
        eventStartMs: change.event.startMs,
        eventEndMs: change.event.endMs,
        createdAt: new Date(nowMs).toISOString(),
        tickId: deps.tickId,
        retiredAt: new Date(nowMs).toISOString(),
        retiredReason: 'jev_veto',
      };
      continue;
    }
    surfaced.push(change);
  }

  // 5. Surface, highest signal and soonest first, bounded per tick.
  const signalRank = (c: CalendarWatchChange): number => (c.signal === 'high' ? 0 : 1);
  surfaced.sort((a, b) => signalRank(a) - signalRank(b) || a.event.startMs - b.event.startMs);
  const produced: CalendarWatchItem[] = [];
  for (const change of surfaced.slice(0, cfg.maxItemsPerTick)) {
    const notification = buildCalendarWatchNotification(change, nowMs, deps.timezone, deps.tickId);
    try {
      deps.notify(notification);
    } catch {
      continue; // nothing recorded → the next tick can try again
    }
    const item: CalendarWatchItem = {
      key: change.itemKey,
      eventKey: change.eventKey,
      kind: change.kind,
      signal: change.signal,
      accountId: change.accountId,
      eventId: change.event.id,
      ...(change.other ? { otherEventId: change.other.id } : {}),
      subject: change.event.subject,
      eventStartMs: change.event.startMs,
      eventEndMs: change.event.endMs,
      notificationId: notification.id,
      createdAt: new Date(nowMs).toISOString(),
      tickId: deps.tickId,
    };
    state.items[change.itemKey] = item;
    produced.push(item);
  }
  state.metrics.itemsProduced += produced.length;

  // 6. Snapshot advances only for accounts read this tick; prune old items.
  for (const [accountId, current] of Object.entries(currentByAccount)) state.snapshot[accountId] = current;
  if (reads.length > 0) state.snapshotAt = new Date(nowMs).toISOString();
  const keepAfter = nowMs - 7 * 24 * 60 * 60 * 1000;
  for (const [key, item] of Object.entries(state.items)) {
    if (item.retiredAt && Date.parse(item.retiredAt) < keepAfter) delete state.items[key];
  }

  const quiet = changes.length === 0 && retired === 0 && failures.length === 0 && duplicatesSuppressed === 0;
  if (quiet) state.metrics.quietTicks += 1; else if (changes.length > 0) state.metrics.changedTicks += 1;

  const changesByKind: Partial<Record<CalendarWatchChangeKind, number>> = {};
  for (const c of changes) changesByKind[c.kind] = (changesByKind[c.kind] ?? 0) + 1;
  const durationMs = deps.now() - startedAt;
  const summary = failures.length > 0 && reads.length === 0
    ? `Read failed: ${failures[0]!.reason}`
    : quiet
      ? `No change across ${eventsSeen.length} upcoming event${eventsSeen.length === 1 ? '' : 's'}`
      : `${changes.length} change${changes.length === 1 ? '' : 's'}, ${produced.length} item${produced.length === 1 ? '' : 's'} for you${vetoed ? `, ${vetoed} judged routine` : ''}${retired ? `, ${retired} resolved` : ''}`;
  const finding: CalendarWatchFinding = {
    tickId: deps.tickId,
    at: new Date(nowMs).toISOString(),
    source: deps.source,
    durationMs,
    accounts: reads.length,
    events: eventsSeen.length,
    changes: changes.length,
    produced: produced.length,
    vetoed,
    retired,
    quiet,
    readFailures: failures.length,
    summary,
  };
  state.lastFinding = finding;
  deps.saveState(state);

  return {
    ...finding,
    items: produced,
    changesByKind,
    judged,
    duplicatesSuppressed,
    acknowledged,
    failures,
    seenEvents: eventsSeen,
  };
}
