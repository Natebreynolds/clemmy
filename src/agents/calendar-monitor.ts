/**
 * C2 — Ambient calendar watch (general, read-only). Sibling of inbox-monitor.
 *
 * Watches the user's connected calendar(s) and surfaces only the upcoming events
 * that genuinely need them — double-bookings, unanswered invites, and imminent
 * meetings with other people — as needs-you cards. Like the inbox monitor:
 *  - GENERAL (binding: feedback_global_not_user_specific): calendar connections
 *    are discovered at runtime; readable ones are watched; each item is labeled
 *    by account. Stale connections that return hard Composio auth errors are
 *    backed off by connection id.
 *  - SURFACE-ONLY BY CONSTRUCTION: only ever calls a READ action
 *    (OUTLOOK_GET_CALENDAR_VIEW / GOOGLECALENDAR_EVENTS_LIST) + addNotification —
 *    it can never create/cancel/respond to an event.
 *  - Gated: proactivity policy (enabled + quiet hours) + own cadence + per-scan
 *    cap + dedup. Default ON; kill-switch CLEMMY_CALENDAR_MONITOR=off. Surfaces
 *    dashboard-only (silent).
 *
 * v2 (deferred): external-attendee detection (needs the account domain), prep
 * summaries, configurable look-ahead, digest mode.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR, getRuntimeEnv } from '../config.js';
import { executeComposioTool, listConnectedToolkits } from '../integrations/composio/client.js';
import { addNotification, type NotificationRecord } from '../runtime/notifications.js';
import {
  clearConnectionSuppression,
  isConnectionSuppressed,
  pruneConnectionSuppressions,
  suppressConnectionAfterHardAuthFailure,
  type ComposioConnectionSuppression,
} from './composio-connection-suppression.js';
import { getProactivityPolicySnapshot, loadProactivityPolicy } from './proactivity-policy.js';
import { decideSurface, shouldSurface, type SurfaceDecision } from './surface-decision.js';

const logger = pino({ name: 'clementine-next.calendar-monitor' });

const STATE_FILE = path.join(BASE_DIR, 'state', 'calendar-monitor.json');
const SURFACED_IDS_CAP = 500;
const LOOKAHEAD_MS = 24 * 60 * 60 * 1000; // how far ahead to scan
const SOON_MS = 45 * 60 * 1000;           // "starting soon" threshold (> default 30m cadence so a scan reliably lands in it)

export interface CalEvent {
  id: string;
  subject: string;
  startMs: number;
  endMs: number;
  isAllDay: boolean;
  isCancelled: boolean;
  showAs: string;       // free | tentative | busy | oof | ...
  myResponse: string;   // organizer | accepted | tentativelyAccepted | declined | notResponded | none
  attendeeCount: number;
}

interface CalProvider {
  slug: string;
  args: (startIso: string, endIso: string, top: number) => Record<string, unknown>;
  parse: (resp: unknown) => CalEvent[];
}

interface CalendarMonitorState {
  lastScanAt?: string;
  surfacedIds: string[];
  suppressedConnections?: Record<string, ComposioConnectionSuppression>;
}

export interface CalendarMonitorConfig {
  enabled: boolean;
  intervalMs: number;
  maxPerScan: number;
  fetchTop: number;
}

export interface CalendarMonitorDeps {
  listConnections: typeof listConnectedToolkits;
  executeTool: typeof executeComposioTool;
  notify: (n: NotificationRecord) => void;
  config: () => CalendarMonitorConfig;
  proactiveWorkAllowed: () => boolean;
  now: () => number;
  loadState: () => CalendarMonitorState;
  saveState: (s: CalendarMonitorState) => void;
}

// ── config (user-editable via the proactivity policy) ────────────────────────
function realConfig(): CalendarMonitorConfig {
  const policy = loadProactivityPolicy();
  const killed = (getRuntimeEnv('CLEMMY_CALENDAR_MONITOR', 'on') || 'on').toLowerCase() === 'off';
  const fetchOverride = Number.parseInt(getRuntimeEnv('CLEMMY_CALENDAR_MONITOR_FETCH', '50') || '50', 10);
  return {
    enabled: policy.calendarWatchEnabled !== false && !killed,
    intervalMs: Math.max(1, policy.calendarWatchMinutes) * 60_000,
    maxPerScan: Math.max(1, policy.calendarWatchMax),
    fetchTop: Number.isFinite(fetchOverride) && fetchOverride >= 1 ? fetchOverride : 50,
  };
}

// ── response parsing (defensive) ─────────────────────────────────────────────
function asArray(x: unknown): unknown[] { return Array.isArray(x) ? x : []; }
function pick(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === 'object' && k in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
}
function locateEvents(resp: unknown): unknown[] {
  return asArray(
    pick(resp, 'data', 'value') ??
    pick(resp, 'data', 'events') ??
    pick(resp, 'data', 'items') ??
    pick(resp, 'data', 'response_data', 'value') ??
    pick(resp, 'value') ??
    pick(resp, 'items') ??
    [],
  );
}
function str(x: unknown): string { return typeof x === 'string' ? x : ''; }
/** Graph datetimes come back without an offset but in UTC (default) — treat a
 *  bare datetime as UTC so comparisons are correct regardless of server TZ. */
function parseMs(dt: string): number {
  if (!dt) return NaN;
  const hasZone = dt.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(dt);
  return Date.parse(hasZone ? dt : `${dt}Z`);
}

const OUTLOOK: CalProvider = {
  slug: 'OUTLOOK_GET_CALENDAR_VIEW',
  args: (startIso, endIso, top) => ({
    start_datetime: startIso,
    end_datetime: endIso,
    top,
    select: ['id', 'subject', 'start', 'end', 'isAllDay', 'isCancelled', 'showAs', 'responseStatus', 'attendees', 'webLink'],
  }),
  parse: (resp) => locateEvents(resp).map((e): CalEvent => ({
    id: str(pick(e, 'id')),
    subject: str(pick(e, 'subject')) || '(no title)',
    startMs: parseMs(str(pick(e, 'start', 'dateTime'))),
    endMs: parseMs(str(pick(e, 'end', 'dateTime'))),
    isAllDay: pick(e, 'isAllDay') === true,
    isCancelled: pick(e, 'isCancelled') === true,
    showAs: str(pick(e, 'showAs')),
    myResponse: str(pick(e, 'responseStatus', 'response')),
    attendeeCount: asArray(pick(e, 'attendees')).length,
  })).filter((e) => e.id && Number.isFinite(e.startMs)),
};

const GOOGLE: CalProvider = {
  slug: 'GOOGLECALENDAR_EVENTS_LIST',
  args: (startIso, endIso, top) => ({ timeMin: startIso, timeMax: endIso, max_results: top, single_events: true, order_by: 'startTime' }),
  parse: (resp) => locateEvents(resp).map((e): CalEvent => {
    const startRaw = str(pick(e, 'start', 'dateTime')) || str(pick(e, 'start', 'date'));
    const endRaw = str(pick(e, 'end', 'dateTime')) || str(pick(e, 'end', 'date'));
    const attendees = asArray(pick(e, 'attendees'));
    const self = attendees.find((a) => pick(a, 'self') === true);
    return {
      id: str(pick(e, 'id')),
      subject: str(pick(e, 'summary')) || '(no title)',
      startMs: parseMs(startRaw),
      endMs: parseMs(endRaw),
      isAllDay: !str(pick(e, 'start', 'dateTime')), // date-only = all-day
      isCancelled: str(pick(e, 'status')) === 'cancelled',
      showAs: str(pick(e, 'transparency')) === 'transparent' ? 'free' : 'busy',
      myResponse: str(pick(self, 'responseStatus')), // needsAction | declined | accepted | tentative
      attendeeCount: attendees.length,
    };
  }).filter((e) => e.id && Number.isFinite(e.startMs)),
};

const PROVIDERS: Record<string, CalProvider> = { outlook: OUTLOOK, googlecalendar: GOOGLE };

// ── scoring: "does this event need the user?" ───────────────────────────────
export interface EventScore { needsYou: boolean; reasons: string[]; score: number; decision?: SurfaceDecision }
function overlaps(a: CalEvent, b: CalEvent): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}
function isCommitment(e: CalEvent): boolean {
  // Worth considering at all: not cancelled, not all-day, not a free block, and
  // you haven't declined it. (Includes tentative — a tentative invite can still
  // be worth surfacing.)
  return !e.isCancelled && !e.isAllDay && e.showAs !== 'free'
    && e.myResponse !== 'declined';
}
function isFirm(e: CalEvent): boolean {
  // A FIRM time commitment for conflict detection — excludes tentative holds,
  // which routinely overlap real meetings on purpose and would create false
  // double-booking noise.
  return isCommitment(e) && e.showAs !== 'tentative';
}
// Unanswered states across providers. NOTE: '' is intentionally NOT here — an
// empty/absent responseStatus means "no invite" (e.g. a self-created block), not
// "awaiting your response"; the attendee gate below is the real guard.
const UNANSWERED = new Set(['notResponded', 'none', 'needsAction']);
export function scoreEvent(ev: CalEvent, all: CalEvent[], nowMs: number): EventScore {
  const reasons: string[] = [];
  if (!isCommitment(ev) || !Number.isFinite(ev.endMs) || ev.endMs <= nowMs) {
    return { needsYou: false, reasons, score: 0 };
  }
  // Unanswered INVITE — needs other people (a zero-attendee self-block is not an
  // invite, no matter what its response field says).
  if (ev.attendeeCount >= 1 && ev.myResponse !== 'organizer' && UNANSWERED.has(ev.myResponse)) {
    reasons.push('awaiting your response');
  }
  // Double-booked: a FIRM event overlapping another FIRM event (tentative holds
  // excluded so an intentional hold over a meeting isn't flagged).
  if (isFirm(ev) && all.some((o) => o.id !== ev.id && isFirm(o) && overlaps(ev, o))) {
    reasons.push('overlaps another event');
  }
  // Starting soon, with OTHER people (a real multi-person meeting heads-up).
  const untilStart = ev.startMs - nowMs;
  const soon = untilStart > 0 && untilStart <= SOON_MS && ev.attendeeCount >= 2;
  if (soon) reasons.push('starts soon');

  // Multi-axis surface decision (shared with the inbox monitor; graduated to the
  // default 2026-06-27). risk=0.4 → surface (ask/escalate) vs stay-silent
  // (watch/ignore), never autonomous 'act'.
  const awaiting = reasons.includes('awaiting your response');
  const overlap = reasons.includes('overlaps another event');
  const v = decideSurface({
    urgency: soon ? 0.8 : 0.2,
    impact: awaiting ? 0.6 : overlap ? 0.7 : 0.4,
    specificity: 0.7,        // calendar items are concrete
    novelty: 0.8,
    risk: 0.4,
    confidence: 0.7,
    conflict: overlap ? 0.9 : 0,
  });
  return { needsYou: shouldSurface(v.decision), reasons, score: reasons.length, decision: v.decision };
}

// ── state ───────────────────────────────────────────────────────────────────
function loadStateReal(): CalendarMonitorState {
  if (!existsSync(STATE_FILE)) return { surfacedIds: [] };
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as CalendarMonitorState;
    return { lastScanAt: s.lastScanAt, surfacedIds: Array.isArray(s.surfacedIds) ? s.surfacedIds : [] };
  } catch { return { surfacedIds: [] }; }
}
function saveStateReal(s: CalendarMonitorState): void {
  const dir = path.dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf-8');
}

const REAL_DEPS: CalendarMonitorDeps = {
  listConnections: listConnectedToolkits,
  executeTool: executeComposioTool,
  notify: addNotification,
  config: realConfig,
  proactiveWorkAllowed: () => getProactivityPolicySnapshot().proactiveWorkAllowed,
  now: () => Date.now(),
  loadState: loadStateReal,
  saveState: saveStateReal,
};

function accountLabel(conn: { accountEmail?: string; accountName?: string; slug: string }): string {
  return conn.accountEmail || conn.accountName || conn.slug;
}

/**
 * One ambient scan: for each readable connected calendar, read the upcoming
 * window, score, and surface the top needs-you events (capped, deduped,
 * dashboard-only). Connections with hard Composio auth failures are backed off
 * by connection id so stale accounts do not spam the logs. Returns the count
 * surfaced. Best-effort: never throws.
 */
export async function processCalendarMonitor(deps: CalendarMonitorDeps = REAL_DEPS): Promise<number> {
  const cfg = deps.config();
  if (!cfg.enabled) return 0;
  if (!deps.proactiveWorkAllowed()) return 0;

  const nowMs = deps.now();
  const state = deps.loadState();
  if (state.lastScanAt && nowMs - Date.parse(state.lastScanAt) < cfg.intervalMs) return 0;

  let connections: Awaited<ReturnType<typeof listConnectedToolkits>>;
  try {
    connections = await deps.listConnections();
  } catch (err) {
    logger.warn({ err }, 'calendar-monitor: could not list connections');
    return 0;
  }
  // Status-agnostic because Composio status can lag; hard auth failures are
  // suppressed after the attempted read.
  const calendars = connections.filter((c) => PROVIDERS[c.slug]);
  if (calendars.length === 0) return 0;

  const startIso = new Date(nowMs).toISOString();
  const endIso = new Date(nowMs + LOOKAHEAD_MS).toISOString();
  const surfaced = new Set(state.surfacedIds);
  const seenKeys = new Set<string>();
  const candidates: Array<{ ev: CalEvent; score: EventScore; label: string; connectionId: string; slug: string }> = [];

  for (const cal of calendars) {
    if (isConnectionSuppressed(state, cal.connectionId, nowMs)) {
      logger.debug({ slug: cal.slug, connectionId: cal.connectionId }, 'calendar-monitor: skipping suppressed calendar');
      continue;
    }
    const provider = PROVIDERS[cal.slug];
    let resp: unknown;
    try {
      resp = await deps.executeTool(provider.slug, provider.args(startIso, endIso, cfg.fetchTop), cal.connectionId || undefined);
    } catch (err) {
      const suppression = suppressConnectionAfterHardAuthFailure(state, cal.connectionId, err, nowMs);
      if (suppression) {
        logger.warn({
          err,
          slug: cal.slug,
          connectionId: cal.connectionId,
          reason: suppression.reason,
          suppressUntil: suppression.suppressUntil,
        }, 'calendar-monitor: suppressing calendar after hard auth failure');
      } else {
        logger.warn({ err, slug: cal.slug }, 'calendar-monitor: read failed for a calendar');
      }
      continue;
    }
    clearConnectionSuppression(state, cal.connectionId);
    const events = provider.parse(resp);
    for (const ev of events) {
      const key = `${cal.connectionId}:${ev.id}`;
      seenKeys.add(key);
      if (surfaced.has(key)) continue;
      const score = scoreEvent(ev, events, nowMs);
      if (!score.needsYou) continue;
      candidates.push({ ev, score, label: accountLabel(cal), connectionId: cal.connectionId, slug: cal.slug });
    }
  }

  // Soonest-starting, highest-signal first.
  candidates.sort((a, b) => (b.score.score - a.score.score) || (a.ev.startMs - b.ev.startMs));
  const toSurface = candidates.slice(0, cfg.maxPerScan);
  for (const c of toSurface) {
    deps.notify(buildNeedsYouNotification(c.ev, c.score, c.label, c.connectionId, c.slug, nowMs));
    surfaced.add(`${c.connectionId}:${c.ev.id}`);
  }

  const persisted = [...surfaced].filter((k) => seenKeys.has(k)).slice(-SURFACED_IDS_CAP);
  deps.saveState({
    lastScanAt: new Date(nowMs).toISOString(),
    surfacedIds: persisted,
    suppressedConnections: pruneConnectionSuppressions(state, nowMs),
  });

  if (toSurface.length > 0) logger.info({ surfaced: toSurface.length, scanned: calendars.length }, 'calendar-monitor surfaced needs-you events');
  return toSurface.length;
}

function fmtWhen(startMs: number, nowMs: number): string {
  const mins = Math.round((startMs - nowMs) / 60000);
  if (mins < 60) return `in ${Math.max(0, mins)} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  return new Date(startMs).toLocaleString();
}

export function buildNeedsYouNotification(
  ev: CalEvent,
  score: EventScore,
  label: string,
  connectionId: string,
  slug: string,
  nowMs: number,
): NotificationRecord {
  const subject = ev.subject.length > 80 ? `${ev.subject.slice(0, 77)}...` : ev.subject;
  const body = [
    `${fmtWhen(ev.startMs, nowMs)}${ev.attendeeCount > 0 ? ` · ${ev.attendeeCount} attendee${ev.attendeeCount === 1 ? '' : 's'}` : ''}`,
    `Why it needs you: ${score.reasons.join(', ')}`,
    `Calendar: ${label}`,
  ].join('\n');
  return {
    id: `calendar-${connectionId}-${ev.id}`,
    kind: 'execution',
    title: `📅 ${subject}`,
    body,
    createdAt: new Date(nowMs).toISOString(),
    read: false,
    silent: true, // dashboard-only
    metadata: {
      needsAttention: true,
      source: 'calendar-monitor',
      account: label,
      provider: slug,
      connectionId,
      eventId: ev.id,
      startsAt: new Date(ev.startMs).toISOString(),
      reasons: score.reasons,
    },
  };
}
