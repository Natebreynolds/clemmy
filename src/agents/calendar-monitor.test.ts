/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-cal-mon npx tsx --test src/agents/calendar-monitor.test.ts
 *
 * C2 ambient calendar monitor — general (any user, any connected calendar),
 * read-only, surface-only. Deps + config injected → deterministic + offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cal-mon-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

import type { CalendarMonitorDeps, CalEvent } from './calendar-monitor.js';
const { processCalendarMonitor, scoreEvent } = await import('./calendar-monitor.js');

const NOW = Date.parse('2026-06-16T12:00:00Z');
// Outlook Graph event fixture; dateTime in UTC without offset (as Graph returns).
const gEv = (o: { id: string; subject?: string; start: string; end: string; isAllDay?: boolean; isCancelled?: boolean; showAs?: string; resp?: string; att?: number }): any => ({
  id: o.id,
  subject: o.subject ?? 'Meeting',
  start: { dateTime: o.start, timeZone: 'UTC' },
  end: { dateTime: o.end, timeZone: 'UTC' },
  isAllDay: o.isAllDay ?? false,
  isCancelled: o.isCancelled ?? false,
  showAs: o.showAs ?? 'busy',
  responseStatus: { response: o.resp ?? 'accepted' },
  attendees: Array.from({ length: o.att ?? 2 }, (_, i) => ({ emailAddress: { address: `a${i}@x.com` } })),
  webLink: 'https://outlook/e',
});
const calResp = (evs: any[]): unknown => ({ data: { value: evs } });

// Parse a fixture into the internal CalEvent for direct scoreEvent tests.
const toCalEvent = (o: Parameters<typeof gEv>[0]): CalEvent => ({
  id: o.id, subject: o.subject ?? 'Meeting',
  startMs: Date.parse(o.start + 'Z'), endMs: Date.parse(o.end + 'Z'),
  isAllDay: o.isAllDay ?? false, isCancelled: o.isCancelled ?? false,
  showAs: o.showAs ?? 'busy', myResponse: o.resp ?? 'accepted', attendeeCount: o.att ?? 2,
});

function makeDeps(over: Partial<CalendarMonitorDeps> & {
  connections?: Array<{ slug: string; connectionId: string; status: string; accountEmail?: string }>;
  resp?: unknown; enabled?: boolean; intervalMs?: number; maxPerScan?: number; state?: any;
} = {}): { deps: CalendarMonitorDeps; notified: any[]; toolCalls: any[]; saved: any[] } {
  const notified: any[] = [];
  const toolCalls: any[] = [];
  const saved: any[] = [];
  let state = over.state ?? ({ surfacedIds: [] as string[] } as any);
  const deps: CalendarMonitorDeps = {
    listConnections: over.listConnections ?? (async () => (over.connections ?? [
      { slug: 'outlook', connectionId: 'ca_1', status: 'ACTIVE', accountEmail: 'nate@corp.com' },
    ]) as any),
    executeTool: over.executeTool ?? (async (slug: string, args: any, conn?: string) => {
      toolCalls.push({ slug, args, conn });
      return over.resp ?? calResp([]);
    }),
    notify: over.notify ?? ((n: any) => notified.push(n)),
    config: over.config ?? (() => ({ enabled: over.enabled ?? true, intervalMs: over.intervalMs ?? 30 * 60_000, maxPerScan: over.maxPerScan ?? 5, fetchTop: 50 })),
    proactiveWorkAllowed: over.proactiveWorkAllowed ?? (() => true),
    now: over.now ?? (() => NOW),
    loadState: over.loadState ?? (() => state),
    saveState: over.saveState ?? ((s: any) => { state = s; saved.push(s); }),
  };
  return { deps, notified, toolCalls, saved };
}

// ── scoring ─────────────────────────────────────────────────────────────────
test('scoreEvent: an unanswered invite needs you', () => {
  const ev = toCalEvent({ id: '1', start: '2026-06-16T16:00:00', end: '2026-06-16T16:30:00', resp: 'notResponded' });
  const s = scoreEvent(ev, [ev], NOW);
  assert.equal(s.needsYou, true);
  assert.ok(s.reasons.includes('awaiting your response'));
});
test('scoreEvent: a double-booking needs you', () => {
  const a = toCalEvent({ id: 'a', start: '2026-06-16T14:00:00', end: '2026-06-16T15:00:00' });
  const b = toCalEvent({ id: 'b', start: '2026-06-16T14:30:00', end: '2026-06-16T15:30:00' });
  assert.equal(scoreEvent(a, [a, b], NOW).needsYou, true);
  assert.ok(scoreEvent(a, [a, b], NOW).reasons.includes('overlaps another event'));
});
test('scoreEvent: a meeting starting soon (with attendees) needs you', () => {
  const ev = toCalEvent({ id: '1', start: '2026-06-16T12:20:00', end: '2026-06-16T13:00:00', att: 3 });
  const s = scoreEvent(ev, [ev], NOW);
  assert.equal(s.needsYou, true);
  assert.ok(s.reasons.includes('starts soon'));
});
test('scoreEvent: all-day / free / cancelled / declined / past are ignored', () => {
  const base = { start: '2026-06-16T16:00:00', end: '2026-06-16T16:30:00', resp: 'notResponded' };
  assert.equal(scoreEvent(toCalEvent({ id: '1', ...base, isAllDay: true }), [], NOW).needsYou, false);
  assert.equal(scoreEvent(toCalEvent({ id: '2', ...base, showAs: 'free' }), [], NOW).needsYou, false);
  assert.equal(scoreEvent(toCalEvent({ id: '3', ...base, isCancelled: true }), [], NOW).needsYou, false);
  assert.equal(scoreEvent(toCalEvent({ id: '4', ...base, resp: 'declined' }), [], NOW).needsYou, false);
  assert.equal(scoreEvent(toCalEvent({ id: '5', start: '2026-06-16T09:00:00', end: '2026-06-16T09:30:00', resp: 'notResponded' }), [], NOW).needsYou, false); // past
});
test('scoreEvent: an answered solo-ish event with no conflict and not soon does NOT need you', () => {
  const ev = toCalEvent({ id: '1', start: '2026-06-16T18:00:00', end: '2026-06-16T18:30:00', resp: 'accepted', att: 1 });
  assert.equal(scoreEvent(ev, [ev], NOW).needsYou, false);
});
test('scoreEvent: a self-block with NO attendees is NOT an unanswered invite (major-fix)', () => {
  // Focus time / Lunch: future, busy, no guests, empty/absent response.
  const focus = toCalEvent({ id: '1', subject: 'Focus time', start: '2026-06-16T18:00:00', end: '2026-06-16T19:00:00', resp: '', att: 0 });
  assert.equal(scoreEvent(focus, [focus], NOW).needsYou, false, 'a zero-attendee block must not surface as an invite');
});
test('scoreEvent: a tentative hold does NOT create a false double-booking (major-fix)', () => {
  const meeting = toCalEvent({ id: 'm', start: '2026-06-16T18:00:00', end: '2026-06-16T19:00:00', resp: 'accepted', att: 2, showAs: 'busy' });
  const hold = toCalEvent({ id: 'h', start: '2026-06-16T18:30:00', end: '2026-06-16T19:30:00', resp: 'accepted', att: 0, showAs: 'tentative' });
  assert.equal(scoreEvent(meeting, [meeting, hold], NOW).needsYou, false, 'firm meeting overlapping only a tentative hold is not a conflict');
  assert.equal(scoreEvent(hold, [meeting, hold], NOW).needsYou, false, 'a tentative hold itself is not a conflict');
});

// ── processCalendarMonitor ────────────────────────────────────────────────
test('processCalendarMonitor: surfaces a needs-you card (read-only) labeled by calendar', async () => {
  const { deps, notified, toolCalls } = makeDeps({
    resp: calResp([
      gEv({ id: 'e1', subject: 'Client review', start: '2026-06-16T16:00:00', end: '2026-06-16T16:30:00', resp: 'notResponded' }),
      gEv({ id: 'e2', subject: 'Focus block', start: '2026-06-16T17:00:00', end: '2026-06-16T18:00:00', showAs: 'free', att: 0 }),
    ]),
  });
  const n = await processCalendarMonitor(deps);
  assert.equal(n, 1, 'only the unanswered invite surfaced (free focus block ignored)');
  const card = notified[0];
  assert.equal(card.metadata.needsAttention, true);
  assert.equal(card.metadata.source, 'calendar-monitor');
  assert.equal(card.metadata.account, 'nate@corp.com');
  assert.equal(card.silent, true);
  assert.match(card.title, /Client review/);
  assert.equal(toolCalls[0].slug, 'OUTLOOK_GET_CALENDAR_VIEW');
  assert.ok(!/CREATE|UPDATE|DELETE|CANCEL|ACCEPT|DECLINE|FORWARD/i.test(toolCalls[0].slug), 'never a mutate slug');
});

test('processCalendarMonitor: no-op when disabled / quiet hours', async () => {
  const off = makeDeps({ enabled: false, resp: calResp([gEv({ id: 'e1', start: '2026-06-16T16:00:00', end: '2026-06-16T16:30:00', resp: 'notResponded' })]) });
  assert.equal(await processCalendarMonitor(off.deps), 0);
  assert.equal(off.toolCalls.length, 0, 'no calendar read when disabled');
  const quiet = makeDeps({ proactiveWorkAllowed: () => false, resp: calResp([gEv({ id: 'e1', start: '2026-06-16T16:00:00', end: '2026-06-16T16:30:00', resp: 'notResponded' })]) });
  assert.equal(await processCalendarMonitor(quiet.deps), 0);
});

test('processCalendarMonitor: dedups + respects the per-scan cap', async () => {
  const evs = Array.from({ length: 4 }, (_, i) => gEv({ id: `e${i}`, start: '2026-06-16T16:00:00', end: '2026-06-16T16:30:00', resp: 'notResponded' }));
  const capped = makeDeps({ maxPerScan: 2, resp: calResp(evs) });
  assert.equal(await processCalendarMonitor(capped.deps), 2, 'capped at 2');

  const deduped = makeDeps({ resp: calResp([gEv({ id: 'e0', start: '2026-06-16T16:00:00', end: '2026-06-16T16:30:00', resp: 'notResponded' })]) });
  (deduped.deps as any).loadState = () => ({ surfacedIds: ['ca_1:e0'] });
  assert.equal(await processCalendarMonitor(deduped.deps), 0, 'already-surfaced event not re-carded');
});

test('processCalendarMonitor: watches ALL calendars status-agnostically, labels each', async () => {
  const respByConn: Record<string, unknown> = {
    ca_a: calResp([gEv({ id: 'x', subject: 'A invite', start: '2026-06-16T16:00:00', end: '2026-06-16T16:30:00', resp: 'notResponded' })]),
    ca_b: calResp([gEv({ id: 'y', subject: 'B soon', start: '2026-06-16T12:15:00', end: '2026-06-16T12:45:00', att: 2 })]),
  };
  const { deps, notified } = makeDeps({
    connections: [
      { slug: 'outlook', connectionId: 'ca_a', status: 'ACTIVE', accountEmail: 'me@a.com' },
      { slug: 'outlook', connectionId: 'ca_b', status: 'EXPIRED', accountEmail: 'me@b.com' }, // works despite label
    ],
    executeTool: async (_slug: string, _args: any, conn?: string) => respByConn[conn ?? ''] ?? calResp([]),
  });
  const n = await processCalendarMonitor(deps);
  assert.equal(n, 2, 'each calendar surfaced regardless of status label');
  assert.deepEqual(notified.map((x) => x.metadata.account).sort(), ['me@a.com', 'me@b.com']);
});

test('processCalendarMonitor: suppresses hard Composio auth failures by connection id', async () => {
  let now = NOW;
  const calls: string[] = [];
  const { deps, saved } = makeDeps({
    now: () => now,
    intervalMs: 30 * 60_000,
    connections: [
      { slug: 'outlook', connectionId: 'ca_good', status: 'ACTIVE', accountEmail: 'good@example.com' },
      { slug: 'outlook', connectionId: 'ca_bad', status: 'EXPIRED', accountEmail: 'bad@example.com' },
    ],
    executeTool: async (_slug: string, _args: any, conn?: string) => {
      calls.push(conn ?? '');
      if (conn === 'ca_bad') {
        throw new Error('ConnectedAccountEntityIdMismatch: Connected account user ID does not match the provided user ID. code: 1812');
      }
      return calResp([]);
    },
  });

  assert.equal(await processCalendarMonitor(deps), 0);
  assert.deepEqual(calls, ['ca_good', 'ca_bad']);
  assert.equal(saved.at(-1)?.suppressedConnections?.ca_bad?.reason, 'entity-mismatch');

  calls.length = 0;
  now += 31 * 60_000;
  assert.equal(await processCalendarMonitor(deps), 0);
  assert.deepEqual(calls, ['ca_good'], 'the hard-failed stale connection is skipped on the next scan');
});
