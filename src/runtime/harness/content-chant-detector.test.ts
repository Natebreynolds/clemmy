/**
 * Run: npx tsx --test src/runtime/harness/content-chant-detector.test.ts
 * Content-chanting advisory (2026-07-20): repeated-text detection with the
 * false-positive guards that keep it safe to run advisory on every stream.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ContentChantDetector, contentChantDetectionEnabled } from './content-chant-detector.js';

afterEach(() => { delete process.env.CLEMMY_CONTENT_CHANT; });

const CHANT = 'I will now proceed to send the email to the customer right away. ';

test('a genuinely chanting stream trips once, and only once', () => {
  const d = new ContentChantDetector();
  let trips = 0;
  let firstTrip: { chunk: string; repeats: number } | null = null;
  for (let i = 0; i < 40; i++) {
    const trip = d.feed(CHANT);
    if (trip) { trips += 1; firstTrip = firstTrip ?? trip; }
  }
  assert.equal(trips, 1, 'single-shot per turn');
  assert.ok(firstTrip && firstTrip.repeats >= 10);
  assert.ok(d.hasTripped);
});

test('normal prose never trips', () => {
  const d = new ContentChantDetector();
  for (let i = 0; i < 100; i++) {
    // varied content — the honest stream shape
    assert.equal(d.feed(`Paragraph ${i}: the analysis of item ${i} shows ${i * 7} results with unique details ${Math.sin(i)}. `), null);
  }
  assert.equal(d.hasTripped, false);
});

test('low-diversity repetition never counts: markdown table rules, separators, indentation', () => {
  const d = new ContentChantDetector();
  for (let i = 0; i < 200; i++) {
    assert.equal(d.feed('| --- | --- | --- | --- |\n'), null, 'table rules are legitimate repetition');
    assert.equal(d.feed('    \n    \n'), null, 'whitespace runs are legitimate');
    assert.equal(d.feed('================\n'), null);
  }
  assert.equal(d.hasTripped, false);
});

test('chunk-boundary independence: the chant is caught regardless of delta sizes', () => {
  const d = new ContentChantDetector();
  const stream = CHANT.repeat(30);
  let tripped = false;
  // feed in ragged deltas (1..17 chars) — the way models actually stream
  let i = 0;
  let size = 1;
  while (i < stream.length) {
    if (d.feed(stream.slice(i, i + size))) tripped = true;
    i += size;
    size = (size % 17) + 1;
  }
  assert.equal(tripped, true);
});

test('kill-switch + feed safety', () => {
  process.env.CLEMMY_CONTENT_CHANT = 'off';
  assert.equal(contentChantDetectionEnabled(), false);
  delete process.env.CLEMMY_CONTENT_CHANT;
  assert.equal(contentChantDetectionEnabled(), true);
  const d = new ContentChantDetector();
  assert.equal(d.feed(''), null);
  assert.equal(d.feed(null as unknown as string), null, 'junk input never throws');
});
