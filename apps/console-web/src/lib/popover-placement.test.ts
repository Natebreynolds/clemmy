import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placePopover } from './popover-placement.js';

const chip = (left: number, top: number, w = 120, h = 28) => ({ left, right: left + w, top, bottom: top + h });

test('a wide window keeps the design: 420px, above the chip, right-aligned', () => {
  const p = placePopover({ anchor: chip(1200, 800), viewport: { width: 1440, height: 900 }, preferredWidth: 420, contentHeight: 300 });
  assert.equal(p.side, 'above');
  assert.equal(p.width, 420);
  assert.equal(p.left, 1320 - 420);
  assert.equal(p.bottom, 900 - 800 + 8);
});

test('a chip near the left edge (the Space dock) pulls the popover inside the window', () => {
  // The dock is the leftmost 400px of the page; the chip ends ~376px in.
  const p = placePopover({ anchor: chip(260, 820, 116), viewport: { width: 1100, height: 900 }, preferredWidth: 420, contentHeight: 300 });
  assert.equal(p.left, 8, 'never left of the window edge');
  assert.equal(p.width, 420);
});

test('a window narrower than the design shrinks the popover to fit with margins', () => {
  const p = placePopover({ anchor: chip(200, 500), viewport: { width: 360, height: 700 }, preferredWidth: 420, contentHeight: 300 });
  assert.equal(p.width, 344);
  assert.equal(p.left, 8);
  assert.ok(p.left + p.width <= 360 - 8);
});

test('no room above: it opens below; no room either way: it scrolls in the larger side', () => {
  const below = placePopover({ anchor: chip(600, 60), viewport: { width: 1440, height: 900 }, preferredWidth: 420, contentHeight: 400 });
  assert.equal(below.side, 'below');
  assert.equal(below.top, 60 + 28 + 8);
  assert.equal(below.maxHeight, 900 - 88 - 8 - 8);

  const cramped = placePopover({ anchor: chip(600, 300), viewport: { width: 1440, height: 520 }, preferredWidth: 420, contentHeight: 600 });
  assert.equal(cramped.side, 'above');
  assert.equal(cramped.maxHeight, 300 - 8 - 8);
});

test('before the first measure (height 0) it still opens where the design asks', () => {
  const p = placePopover({ anchor: chip(1200, 800), viewport: { width: 1440, height: 900 }, preferredWidth: 420, contentHeight: 0 });
  assert.equal(p.side, 'above');
});
