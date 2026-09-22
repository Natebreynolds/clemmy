/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/calendar-watch.test.ts
 *
 * The calendar watch contract: deterministic change detection before any
 * model call, one item per meaningful change, Jev vetoes only low-signal
 * classes and fails open, items retire when reality resolves, duplicates
 * never re-notify across a restart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-calendar-watch-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const {
  DEFAULT_CALENDAR_WATCH_CONFIG,
  calendarReadOperation,
  detectCalendarChanges,
  emptyCalendarWatchState,
  processCalendarWatchTick,
} = await import('./calendar-watch.js');
import type {
  CalEvent,
  CalendarWatchChange,
  CalendarWatchDeps,
  CalendarWatchJudgeVerdict,
  CalendarWatchState,
} from './calendar-watch.js';

const NOW = Date.parse('2026-09-22T15:00:00Z');
const H = 60 * 60 * 1000;
const M = 60 * 1000;

const ev = (o: Partial<CalEvent> & { id: string }): CalEvent => ({
  subject: 'Meeting',
  startMs: NOW + 2 * H,
  endMs: NOW + 3 * H,
  isAllDay: false,
  isCancelled: false,
  showAs: 'busy',
  myResponse: 'accepted',
  attendeeCount: 2,
  ...o,
});

const cfg = { ...DEFAULT_CALENDAR_WATCH_CONFIG };

function detect(previous: CalEvent[] | undefined, current: CalEvent[], nowMs = NOW): CalendarWatchChange[] {
  return detectCalendarChanges({
    operationId: 'outlook_get_calendar_view',
    accountId: 'ca_1',
    accountLabel: 'alex@corp.example',
    previous: previous ? Object.fromEntries(previous.map((e) => [e.id, e])) : undefined,
    current,
    nowMs,
    config: cfg,
  });
}

// ── deterministic detection ───────────────────────────────────────────────────

test('baseline (no previous snapshot) surfaces only what is actionable on its own', () => {
  const a = ev({ id: 'a' });
  const b = ev({ id: 'b', startMs: NOW + 2.5 * H, endMs: NOW + 3.5 * H });
  const invite = ev({ id: 'inv', myResponse: 'notResponded', attendeeCount: 3, startMs: NOW + 5 * H, endMs: NOW + 6 * H });
  const solo = ev({ id: 'solo', attendeeCount: 0, startMs: NOW + 8 * H, endMs: NOW + 9 * H });
  const changes = detect(undefined, [a, b, invite, solo]);
  assert.deepEqual(changes.map((c) => c.kind).sort(), ['conflict', 'invite_unanswered']);
  const conflict = changes.find((c) => c.kind === 'conflict')!;
  assert.equal(conflict.signal, 'high');
  assert.equal(conflict.itemKey, 'ca_1|conflict|a|b');
  assert.equal(changes.find((c) => c.kind === 'invite_unanswered')!.signal, 'high');
});

test('an unchanged window is quiet: zero changes', () => {
  const a = ev({ id: 'a' });
  const b = ev({ id: 'b', startMs: NOW + 5 * H, endMs: NOW + 6 * H });
  assert.deepEqual(detect([a, b], [a, b]), []);
});

test('a cancellation, a move, a removal and a NEW overlap are each one change with a stable key', () => {
  const a = ev({ id: 'a' });
  const b = ev({ id: 'b', startMs: NOW + 5 * H, endMs: NOW + 6 * H });
  const c = ev({ id: 'c', startMs: NOW + 8 * H, endMs: NOW + 9 * H });
  const d = ev({ id: 'd', startMs: NOW + 10 * H, endMs: NOW + 11 * H });
  const prev = [a, b, c, d];
  const cur = [
    { ...a, isCancelled: true },
    { ...b, startMs: NOW + 5.5 * H, endMs: NOW + 6.5 * H }, // moved 30 min
    // c removed
    d,
    ev({ id: 'e', startMs: NOW + 10.5 * H, endMs: NOW + 11.5 * H }), // new, overlaps d
  ];
  const changes = detect(prev, cur);
  const kinds = changes.map((ch) => ch.kind).sort();
  assert.deepEqual(kinds, ['cancelled', 'conflict', 'moved', 'removed']);
  const moved = changes.find((ch) => ch.kind === 'moved')!;
  assert.equal(moved.signal, 'low');
  assert.match(moved.itemKey, /^ca_1\|moved\|b\|[a-f0-9]{16}$/);
  assert.deepEqual(moved.previous, { startMs: b.startMs, endMs: b.endMs });
  assert.equal(changes.find((ch) => ch.kind === 'cancelled')!.signal, 'high');
  assert.equal(changes.find((ch) => ch.kind === 'removed')!.event.id, 'c');
  assert.equal(changes.find((ch) => ch.kind === 'conflict')!.itemKey, 'ca_1|conflict|d|e');
});

test('a shift under the move threshold, a tentative hold over a meeting, and an all-day block are not changes', () => {
  const a = ev({ id: 'a' });
  const hold = ev({ id: 'hold', showAs: 'tentative', startMs: NOW + 2 * H, endMs: NOW + 4 * H });
  const allDay = ev({ id: 'day', isAllDay: true, startMs: NOW, endMs: NOW + 24 * H, attendeeCount: 5, myResponse: 'notResponded' });
  const prev = [a, hold, allDay];
  const cur = [{ ...a, startMs: a.startMs + 5 * M, endMs: a.endMs + 5 * M }, hold, allDay];
  assert.deepEqual(detect(prev, cur), []);
});

test('an existing overlap does not re-fire; a self-created block is not an invite', () => {
  const a = ev({ id: 'a' });
  const b = ev({ id: 'b', startMs: NOW + 2.5 * H, endMs: NOW + 3.5 * H });
  const self = ev({ id: 'self', attendeeCount: 0, myResponse: 'none' });
  assert.deepEqual(detect([a, b, self], [a, b, self]), []);
});

test('the Outlook parser reads Graph shapes; the Google parser reads the self response', () => {
  const outlook = calendarReadOperation('OUTLOOK_GET_CALENDAR_VIEW')!;
  const parsed = outlook.parse({ data: { value: [{
    id: 'x', subject: 'Canceled: Nate 1:1', start: { dateTime: '2026-09-22T18:00:00.0000000' }, end: { dateTime: '2026-09-22T18:30:00.0000000' },
    isAllDay: false, isCancelled: false, showAs: 'free', responseStatus: { response: 'organizer' }, attendees: [{}], organizer: { emailAddress: { name: 'Tim' } },
  }] } });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.isCancelled, true, 'a "Canceled:" subject from Graph counts as cancelled');
  assert.equal(parsed[0]!.startMs, Date.parse('2026-09-22T18:00:00Z'), 'a bare Graph datetime is UTC');
  assert.equal(parsed[0]!.organizer, 'Tim');
  const args = outlook.args({ startIso: 's', endIso: 'e', top: 50, timezone: 'America/Los_Angeles' });
  assert.deepEqual(Object.keys(args).sort(), ['end_datetime', 'orderby', 'start_datetime', 'timezone', 'top']);

  const google = calendarReadOperation('googlecalendar_events_list')!;
  const g = google.parse({ items: [{ id: 'g1', summary: 'Sync', start: { dateTime: '2026-09-22T18:00:00Z' }, end: { dateTime: '2026-09-22T19:00:00Z' }, attendees: [{ self: true, responseStatus: 'needsAction' }, { email: 'b@x' }] }] });
  assert.equal(g[0]!.myResponse, 'needsAction');
  assert.equal(g[0]!.attendeeCount, 2);
});

// ── the tick ──────────────────────────────────────────────────────────────────

interface Harness {
  deps: CalendarWatchDeps;
  notified: Array<{ id: string; title: string; metadata?: Record<string, unknown> }>;
  read: Set<string>;
  judged: CalendarWatchChange[];
  state: () => CalendarWatchState;
}

function harness(over: {
  events: () => CalEvent[];
  verdict?: (change: CalendarWatchChange) => Promise<CalendarWatchJudgeVerdict | null>;
  noJudge?: boolean;
  state?: CalendarWatchState;
  now?: () => number;
  tickId?: string;
  failRead?: boolean;
} ): Harness {
  const notified: Harness['notified'] = [];
  const read = new Set<string>();
  const judged: CalendarWatchChange[] = [];
  let state = over.state ?? emptyCalendarWatchState();
  const deps: CalendarWatchDeps = {
    now: over.now ?? (() => NOW),
    tickId: over.tickId ?? 'tick-1',
    source: 'test',
    timezone: 'UTC',
    config: cfg,
    readAccounts: async () => over.failRead
      ? { reads: [], failures: [{ operationId: 'outlook_get_calendar_view', reason: 'provider down' }] }
      : { reads: [{ operationId: 'outlook_get_calendar_view', accountId: 'ca_1', accountLabel: 'alex@corp.example', events: over.events() }], failures: [] },
    ...(over.noJudge ? {} : {
      judgeChange: async (change) => {
        judged.push(change);
        return over.verdict ? over.verdict(change) : null;
      },
    }),
    notify: (n) => { notified.push({ id: n.id, title: n.title, metadata: n.metadata }); },
    isNotificationRead: (id) => read.has(id),
    markNotificationRead: (id) => { read.add(id); },
    loadState: () => JSON.parse(JSON.stringify(state)) as CalendarWatchState,
    saveState: (s) => { state = s; },
  };
  return { deps, notified, read, judged, state: () => state };
}

test('a quiet tick makes no model call and no notification, and counts as quiet', async () => {
  const a = ev({ id: 'a' });
  const h = harness({ events: () => [a] });
  const first = await processCalendarWatchTick(h.deps);
  assert.equal(first.produced, 0);
  assert.equal(first.quiet, true, 'baseline with nothing actionable is quiet');
  const second = await processCalendarWatchTick({ ...h.deps, tickId: 'tick-2' });
  assert.equal(second.quiet, true);
  assert.equal(second.judged, 0);
  assert.equal(h.notified.length, 0);
  assert.equal(h.state().metrics.ticks, 2);
  assert.equal(h.state().metrics.quietTicks, 2);
  assert.equal(h.state().metrics.modelCalls, 0);
});

test('high-signal changes never ask Jev; a low-signal change asks once and a confident skip vetoes it', async () => {
  let events = [ev({ id: 'a' }), ev({ id: 'b', startMs: NOW + 5 * H, endMs: NOW + 6 * H })];
  const h = harness({
    events: () => events,
    verdict: async () => ({ surface: false, confidence: 0.9, model: 'jev-test', durationMs: 120 }),
  });
  await processCalendarWatchTick(h.deps); // baseline
  events = [{ ...events[0]!, isCancelled: true }, { ...events[1]!, startMs: NOW + 5.5 * H, endMs: NOW + 6.5 * H }];
  const tick = await processCalendarWatchTick({ ...h.deps, tickId: 'tick-2' });
  assert.equal(tick.changes, 2);
  assert.equal(tick.judged, 1, 'only the moved meeting is judged');
  assert.equal(h.judged[0]!.kind, 'moved');
  assert.equal(tick.vetoed, 1);
  assert.equal(tick.produced, 1, 'the cancellation surfaces regardless of Jev');
  assert.match(h.notified[0]!.title, /Cancelled: Meeting/);
  assert.equal(h.notified[0]!.metadata?.needsAttention, true);
  assert.equal(h.notified[0]!.metadata?.source, 'calendar-watch');
  // The vetoed change is remembered so the next tick does not ask again.
  const again = await processCalendarWatchTick({ ...h.deps, tickId: 'tick-3' });
  assert.equal(again.judged, 0);
  assert.equal(again.produced, 0);
  assert.equal(h.state().metrics.modelCalls, 1);
});

test('Jev unavailable or unsure fails open to the rule: the move surfaces', async () => {
  let events = [ev({ id: 'b', startMs: NOW + 5 * H, endMs: NOW + 6 * H })];
  const unsure = harness({ events: () => events, verdict: async () => ({ surface: false, confidence: 0.3, model: 'jev-test', durationMs: 90 }) });
  await processCalendarWatchTick(unsure.deps);
  events = [{ ...events[0]!, startMs: NOW + 6 * H, endMs: NOW + 7 * H }];
  const tick = await processCalendarWatchTick({ ...unsure.deps, tickId: 'tick-2' });
  assert.equal(tick.judged, 1);
  assert.equal(tick.vetoed, 0);
  assert.equal(tick.produced, 1);
  assert.match(unsure.notified[0]!.title, /Moved: Meeting/);

  let events2 = [ev({ id: 'b', startMs: NOW + 5 * H, endMs: NOW + 6 * H })];
  const down = harness({ events: () => events2, verdict: async () => { throw new Error('jev down'); } });
  await processCalendarWatchTick(down.deps);
  events2 = [{ ...events2[0]!, startMs: NOW + 6 * H, endMs: NOW + 7 * H }];
  const tick2 = await processCalendarWatchTick({ ...down.deps, tickId: 'tick-2' });
  assert.equal(tick2.produced, 1);
  assert.equal(down.state().metrics.modelFailures, 1);
});

test('a restart (state reloaded from disk) never re-notifies an open item; the duplicate is counted', async () => {
  const invite = ev({ id: 'inv', myResponse: 'notResponded', attendeeCount: 3 });
  const h = harness({ events: () => [invite] });
  const first = await processCalendarWatchTick(h.deps);
  assert.equal(first.produced, 1);
  // "Restart": a fresh harness over the persisted state, same calendar.
  const restarted = harness({ events: () => [invite], state: JSON.parse(JSON.stringify(h.state())) as CalendarWatchState, tickId: 'tick-after-restart' });
  const second = await processCalendarWatchTick(restarted.deps);
  assert.equal(second.produced, 0);
  assert.equal(restarted.notified.length, 0);
  assert.equal(second.duplicatesSuppressed, 0, 'an unchanged unanswered invite is not a change at all, so nothing to suppress');
  // A re-read with NO previous snapshot for the account (baseline again) IS a
  // repeated change; the open item suppresses it.
  const baselineAgain = harness({ events: () => [invite], state: { ...(JSON.parse(JSON.stringify(h.state())) as CalendarWatchState), snapshot: {} }, tickId: 'tick-baseline-again' });
  const third = await processCalendarWatchTick(baselineAgain.deps);
  assert.equal(third.produced, 0);
  assert.equal(third.duplicatesSuppressed, 1);
  assert.equal(baselineAgain.notified.length, 0);
});

test('items retire when reality resolves and their notification is marked read; acknowledgements are counted', async () => {
  let events = [
    ev({ id: 'inv', myResponse: 'notResponded', attendeeCount: 3, startMs: NOW + 4 * H, endMs: NOW + 5 * H }),
    ev({ id: 'a' }),
    ev({ id: 'b', startMs: NOW + 2.5 * H, endMs: NOW + 3.5 * H }),
  ];
  const h = harness({ events: () => events, noJudge: true });
  const first = await processCalendarWatchTick(h.deps);
  assert.equal(first.produced, 2, 'invite + conflict');
  const conflictNotif = h.notified.find((n) => /Double-booked/.test(n.title))!;
  const inviteNotif = h.notified.find((n) => /Reply needed/.test(n.title))!;
  h.read.add(conflictNotif.id); // the owner opened the conflict card

  // The invite is answered and the overlap is moved away.
  events = [
    { ...events[0]!, myResponse: 'accepted' },
    events[1]!,
    { ...events[2]!, startMs: NOW + 6 * H, endMs: NOW + 7 * H },
  ];
  const second = await processCalendarWatchTick({ ...h.deps, tickId: 'tick-2' });
  assert.equal(second.retired, 2);
  assert.equal(second.acknowledged, 1);
  assert.ok(h.read.has(inviteNotif.id), 'the resolved invite item marks its notification read');
  const retiredItems = Object.values(h.state().items).filter((i) => i.retiredAt);
  assert.deepEqual(retiredItems.map((i) => i.retiredReason).sort(), ['invite_answered', 'overlap_gone']);
  assert.equal(h.state().metrics.itemsRetired, 2);
  assert.equal(h.state().metrics.itemsAcknowledged, 1);
  // The move of "b" produced a change too (low signal, no judge port → rule surfaces it).
  assert.equal(second.produced, 1);
  assert.equal(second.judged, 0);
});

test('a failed read keeps the snapshot, records the error, and is not a quiet tick', async () => {
  const a = ev({ id: 'a' });
  const h = harness({ events: () => [a] });
  await processCalendarWatchTick(h.deps);
  const before = JSON.stringify(h.state().snapshot);
  const failing = harness({ events: () => [], failRead: true, state: h.state(), tickId: 'tick-fail' });
  const tick = await processCalendarWatchTick(failing.deps);
  assert.equal(tick.quiet, false);
  assert.equal(tick.readFailures, 1);
  assert.equal(JSON.stringify(failing.state().snapshot), before, 'snapshot is untouched by a failed read');
  assert.match(failing.state().lastError?.reason ?? '', /provider down/);
  assert.match(tick.summary, /Read failed/);
});

test('the watch runtime never imports the raw provider client', () => {
  const source = readFileSync(new URL('./calendar-watch-runtime.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /integrations\/composio\/client|executeComposioTool/);
  assert.match(source, /executeWorkflowNodeRead/);
  assert.match(source, /compileLiveCatalogWorkflowCallPlan/);
});
