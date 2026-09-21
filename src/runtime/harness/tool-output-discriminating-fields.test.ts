import assert from 'node:assert/strict';
import test from 'node:test';
import { compactStructuredJsonToolOutput } from './tool-output-digest.js';

/**
 * A record projection must spend its budget on the fields that answer, not on
 * the cheapest ones.
 *
 * Live 2026-09-21, source 276961, "whats on my calendar today": five events
 * arrived as 21 key names each with 127 keys and 56 values omitted — and the
 * omitted ones were subject, start, end and location. What survived was
 * `categories: []`, `importance: "normal"`, `onlineMeeting: null`. The brain
 * could not answer, so it spent a second round on tool_output_query asking for
 * exactly those fields, which returned 5,428 bytes against the 2,948 it already
 * held.
 *
 * Two causes, both structural rather than Outlook-specific: projectionKeyPriority
 * names news/web-scrape fields, so every calendar key tied at lowest priority
 * and survived on object order; and allocateJsonBudgets water-fills equally, so
 * a 5-char boolean fit its ~28-char share and a 44-char subject did not.
 */

/** Shaped like the live payload: constant low-value fields, one huge varying
 *  blob, and the small varying fields that actually answer the question. */
function calendarish(n: number): string {
  const events = Array.from({ length: n }, (_, i) => ({
    categories: [],
    importance: 'normal',
    isAllDay: false,
    isCancelled: false,
    onlineMeeting: null,
    recurrence: null,
    sensitivity: 'normal',
    subject: `Event number ${i} with a real distinguishing title`,
    start: { dateTime: `2026-09-21T${String(9 + i).padStart(2, '0')}:00:00`, timeZone: 'UTC' },
    end: { dateTime: `2026-09-21T${String(10 + i).padStart(2, '0')}:00:00`, timeZone: 'UTC' },
    attendees: Array.from({ length: 12 }, (_, a) => ({
      emailAddress: { address: `person${a}.of.event${i}@example.com`, name: `Person ${a} Of Event ${i}` },
      status: { response: 'none', time: '0001-01-01T00:00:00Z' },
      type: 'required',
    })),
  }));
  return JSON.stringify({ data: { value: events } });
}

test('a tight budget buys the answering fields, not the constant ones', () => {
  const out = compactStructuredJsonToolOutput(calendarish(5), {
    maxChars: 2000,
    exactOutputReceipt: '[receipt]',
  } as never);
  const text = typeof out === 'string' ? out : JSON.stringify(out);

  assert.ok(text.includes('distinguishing title'), `subject values must survive: ${text.slice(0, 300)}`);
  assert.ok(text.includes('dateTime'), 'start/end values must survive');
  // The 3KB attendees blob varies across records too, so information alone would
  // rank it high. Information PER BYTE is what keeps it out of a tight budget.
  assert.ok(!text.includes('person0.of.event0@example.com'),
    'the largest varying field must not consume a tight budget ahead of cheap answering fields');
});

test('fields identical across every record are demoted, however cheap', () => {
  const out = compactStructuredJsonToolOutput(calendarish(5), {
    maxChars: 1200,
    exactOutputReceipt: '[receipt]',
  } as never);
  const text = typeof out === 'string' ? out : JSON.stringify(out);
  // "normal"/null/[] are identical in all five records, so they distinguish
  // nothing — a reader learns strictly less from them than from one subject.
  assert.ok(text.includes('distinguishing title'),
    'an answering field outranks a constant one even when the constant is smaller');
});

test('a single record keeps the existing order, having nothing to compare against', () => {
  const one = JSON.stringify({ data: { value: [{ zeta: 'z', alpha: 'a' }] } });
  const out = compactStructuredJsonToolOutput(one, { maxChars: 4000, exactOutputReceipt: '[r]' } as never);
  const text = typeof out === 'string' ? out : JSON.stringify(out);
  assert.ok(text.includes('zeta') && text.includes('alpha'),
    'with one record there is no spread signal; both fields fit and both are kept');
});

test('a generous budget is unchanged — nothing is dropped that used to fit', () => {
  const payload = calendarish(2);
  const out = compactStructuredJsonToolOutput(payload, {
    maxChars: 100_000,
    exactOutputReceipt: '[receipt]',
  } as never);
  const text = typeof out === 'string' ? out : JSON.stringify(out);
  assert.ok(text.includes('person0.of.event0@example.com'),
    'when everything fits, ranking must not elide anything');
  assert.ok(text.includes('"omittedValues":0'), `nothing omitted at a generous budget: ${text.slice(-160)}`);
});
