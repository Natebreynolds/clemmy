/**
 * Run: npx tsx --test src/agents/surface-monitor-wiring.test.ts
 *
 * Lane E Phase 2 — the surface-decision scorer wired into the live monitors. The
 * validation gate: with CLEMMY_SURFACE_DECISION_V2 OFF, behavior is byte-identical
 * (legacy reasons.length); with it ON, the firehose is SUPPRESSED (promo/bulk/weak
 * stay silent) and TRUE POSITIVES surface (a direct ask, urgency, a calendar
 * conflict). Calibrated here, not intuited.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMessage, type UnreadMessage } from './inbox-monitor.js';
import { scoreEvent, type CalEvent } from './calendar-monitor.js';

function withV2<T>(on: boolean, fn: () => T): T {
  const prev = process.env.CLEMMY_SURFACE_DECISION_V2;
  process.env.CLEMMY_SURFACE_DECISION_V2 = on ? 'on' : 'off';
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.CLEMMY_SURFACE_DECISION_V2; else process.env.CLEMMY_SURFACE_DECISION_V2 = prev;
  }
}
const msg = (subject: string, preview: string, fromAddress = 'alice@acme.com', fromName = 'Alice'): UnreadMessage =>
  ({ id: 'm1', subject, fromName, fromAddress, receivedAt: '', preview });

// ── INBOX ────────────────────────────────────────────────────────────────────
test('V2 ON — TRUE POSITIVE: a direct ask surfaces (decision=ask/escalate)', () => {
  withV2(true, () => {
    const s = scoreMessage(msg('Q3 deck', 'Can you review the deck and let me know by Friday?'));
    assert.equal(s.needsYou, true);
    assert.ok(s.decision === 'ask' || s.decision === 'escalate', `got ${s.decision}`);
  });
});

test('V2 ON — TRUE POSITIVE: an urgent message surfaces', () => {
  withV2(true, () => {
    assert.equal(scoreMessage(msg('Action required', 'URGENT: response needed by EOD.')).needsYou, true);
  });
});

test('V2 ON — FIREHOSE SUPPRESSED: a weak no-signal message stays silent', () => {
  withV2(true, () => {
    const s = scoreMessage(msg('Lunch', 'Grabbing lunch at the new place tomorrow.'));
    assert.equal(s.needsYou, false, 'no strong signal → ignore/watch, not surfaced');
  });
});

test('V2 ON — promo + bulk are still hard-excluded (pre-scorer)', () => {
  withV2(true, () => {
    assert.equal(scoreMessage(msg('50% OFF', 'Huge sale — shop now! Unsubscribe anytime.')).needsYou, false);
    assert.equal(scoreMessage(msg('Receipt', 'Your order shipped', 'noreply@store.com', 'Store')).needsYou, false);
  });
});

test('V2 OFF — byte-identical legacy behavior (direct ask true, weak false)', () => {
  withV2(false, () => {
    assert.equal(scoreMessage(msg('Q3 deck', 'Can you review the deck?')).needsYou, true);
    assert.equal(scoreMessage(msg('Lunch', 'Grabbing lunch tomorrow.')).needsYou, false);
    assert.equal(scoreMessage(msg('Q3 deck', 'Can you review the deck?')).decision, undefined, 'no decision field when off');
  });
});

test('ANTI-FIREHOSE DELTA: a reply-thread-with-? surfaces under legacy but is WATCHed under V2', () => {
  const m = msg('Re: project', 'what do you think?');
  assert.equal(withV2(false, () => scoreMessage(m).needsYou), true, 'legacy: any reason surfaces');
  assert.equal(withV2(true, () => scoreMessage(m).needsYou), false, 'V2: a weak reply-question is watched, not surfaced');
});

// ── CALENDAR ─────────────────────────────────────────────────────────────────
const NOW = 1_000_000_000_000;
const ev = (o: Partial<CalEvent>): CalEvent =>
  ({ id: 'e1', subject: 'Meeting', startMs: NOW + 3_600_000, endMs: NOW + 7_200_000, isAllDay: false, isCancelled: false, showAs: 'busy', myResponse: 'accepted', attendeeCount: 2, ...o });

test('V2 ON — calendar TRUE POSITIVE: a double-book surfaces (conflict)', () => {
  withV2(true, () => {
    const a = ev({ id: 'a', startMs: NOW + 3_600_000, endMs: NOW + 7_200_000 });
    const b = ev({ id: 'b', startMs: NOW + 5_400_000, endMs: NOW + 9_000_000 });
    const s = scoreEvent(a, [a, b], NOW);
    assert.equal(s.needsYou, true);
    assert.ok(s.reasons.includes('overlaps another event'));
  });
});

test('V2 ON — calendar TRUE POSITIVE: an unanswered invite surfaces', () => {
  withV2(true, () => {
    const a = ev({ myResponse: 'notResponded', attendeeCount: 3 });
    assert.equal(scoreEvent(a, [a], NOW).needsYou, true);
  });
});

test('V2 ON — calendar: a solo accepted event with no signal stays silent', () => {
  withV2(true, () => {
    const a = ev({ myResponse: 'accepted', attendeeCount: 1, startMs: NOW + 86_400_000, endMs: NOW + 90_000_000 });
    assert.equal(scoreEvent(a, [a], NOW).needsYou, false);
  });
});
