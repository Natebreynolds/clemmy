/**
 * Run: npx tsx --test src/agents/surface-monitor-wiring.test.ts
 *
 * Lane E — the surface-decision scorer wired into the live monitors, GRADUATED to
 * the default 2026-06-27 (CLEMMY_SURFACE_DECISION_V2 deleted). The behavior these
 * tests pin: the firehose is SUPPRESSED (promo/bulk/weak stay silent) and TRUE
 * POSITIVES surface (a direct ask, urgency, a calendar conflict). Calibrated here,
 * not intuited — risk=0.4 keeps inbox/calendar items at ask/escalate, never
 * autonomous 'act'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMessage, type UnreadMessage } from './inbox-monitor.js';
import { scoreEvent, type CalEvent } from './calendar-monitor.js';

const msg = (subject: string, preview: string, fromAddress = 'alice@acme.com', fromName = 'Alice'): UnreadMessage =>
  ({ id: 'm1', subject, fromName, fromAddress, receivedAt: '', preview });

// ── INBOX ────────────────────────────────────────────────────────────────────
test('TRUE POSITIVE: a direct ask surfaces (decision=ask/escalate)', () => {
  const s = scoreMessage(msg('Q3 deck', 'Can you review the deck and let me know by Friday?'));
  assert.equal(s.needsYou, true);
  assert.ok(s.decision === 'ask' || s.decision === 'escalate', `got ${s.decision}`);
});

test('TRUE POSITIVE: an urgent message surfaces', () => {
  assert.equal(scoreMessage(msg('Action required', 'URGENT: response needed by EOD.')).needsYou, true);
});

test('FIREHOSE SUPPRESSED: a weak no-signal message stays silent (watch/ignore)', () => {
  const s = scoreMessage(msg('Lunch', 'Grabbing lunch at the new place tomorrow.'));
  assert.equal(s.needsYou, false, 'no strong signal → ignore/watch, not surfaced');
});

test('FIREHOSE SUPPRESSED: a reply-thread-with-? is WATCHed, not surfaced', () => {
  // The classic over-eager signal: a "Re: …" with a bare "?" used to surface
  // under the legacy reasons.length scorer; the multi-axis scorer watches it.
  const s = scoreMessage(msg('Re: project', 'what do you think?'));
  assert.equal(s.needsYou, false, 'a weak reply-question is watched, not surfaced');
});

test('promo + bulk are still hard-excluded (pre-scorer)', () => {
  assert.equal(scoreMessage(msg('50% OFF', 'Huge sale — shop now! Unsubscribe anytime.')).needsYou, false);
  assert.equal(scoreMessage(msg('Receipt', 'Your order shipped', 'noreply@store.com', 'Store')).needsYou, false);
});

test('every scored message carries a triage decision now (no flag gate)', () => {
  assert.ok(scoreMessage(msg('Q3 deck', 'Can you review the deck?')).decision, 'decision is always set');
});

// ── CALENDAR ─────────────────────────────────────────────────────────────────
const NOW = 1_000_000_000_000;
const ev = (o: Partial<CalEvent>): CalEvent =>
  ({ id: 'e1', subject: 'Meeting', startMs: NOW + 3_600_000, endMs: NOW + 7_200_000, isAllDay: false, isCancelled: false, showAs: 'busy', myResponse: 'accepted', attendeeCount: 2, ...o });

test('calendar TRUE POSITIVE: a double-book surfaces (conflict)', () => {
  const a = ev({ id: 'a', startMs: NOW + 3_600_000, endMs: NOW + 7_200_000 });
  const b = ev({ id: 'b', startMs: NOW + 5_400_000, endMs: NOW + 9_000_000 });
  const s = scoreEvent(a, [a, b], NOW);
  assert.equal(s.needsYou, true);
  assert.ok(s.reasons.includes('overlaps another event'));
});

test('calendar TRUE POSITIVE: an unanswered invite surfaces', () => {
  const a = ev({ myResponse: 'notResponded', attendeeCount: 3 });
  assert.equal(scoreEvent(a, [a], NOW).needsYou, true);
});

test('calendar: a solo accepted event with no signal stays silent', () => {
  const a = ev({ myResponse: 'accepted', attendeeCount: 1, startMs: NOW + 86_400_000, endMs: NOW + 90_000_000 });
  assert.equal(scoreEvent(a, [a], NOW).needsYou, false);
});
