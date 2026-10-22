import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleViewportBounds } from './visible-viewport';

test('without a visual viewport floating surfaces use the full available height', () => {
  assert.deepEqual(visibleViewportBounds(667, null), { top: 0, height: 667, bottomInset: 0 });
});
test('a keyboard-sized reduction bounds a sheet and lifts existing composer geometry once', () => {
  assert.deepEqual(visibleViewportBounds(844, { height: 510, offsetTop: 0 }), { top: 0, height: 510, bottomInset: 334 });
});
test('a panned visual viewport keeps its top offset instead of counting it as keyboard coverage', () => {
  assert.deepEqual(visibleViewportBounds(844, { height: 410, offsetTop: 100 }), { top: 100, height: 410, bottomInset: 334 });
});
test('a resized layout viewport does not apply the keyboard reduction twice', () => {
  assert.deepEqual(visibleViewportBounds(410, { height: 410, offsetTop: 0 }), { top: 0, height: 410, bottomInset: 0 });
});
test('transient invalid or overscrolled viewport measurements cannot produce negative bounds', () => {
  assert.deepEqual(visibleViewportBounds(320, { height: Number.NaN, offsetTop: 0 }), { top: 0, height: 320, bottomInset: 0 });
  assert.deepEqual(visibleViewportBounds(320, { height: 500, offsetTop: -10 }), { top: 0, height: 320, bottomInset: 0 });
  const panned = visibleViewportBounds(320, { height: 100, offsetTop: 340 });
  assert.deepEqual(panned, { top: 340, height: 100, bottomInset: 0 });
});

// Recorded WKWebView first focus: document874, innerHeight471, pan403.
test('a focus pan and resized innerHeight keep independent visible origin and height', () => {
  assert.deepEqual(visibleViewportBounds(471, { height: 471, offsetTop: 403 }),
    { top: 403, height: 471, bottomInset: 0 });
  assert.deepEqual(visibleViewportBounds(320, { height: 280, offsetTop: 100 }),
    { top: 100, height: 280, bottomInset: 0 });
});
