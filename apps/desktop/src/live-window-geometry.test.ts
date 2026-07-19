import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeClementineLiveGeometry,
  DEFAULT_CLEMENTINE_LIVE_SHORTCUT,
  normalizeClementineLiveSize,
  resolveClementineLiveShortcut,
} from './live-window-geometry.js';

test('anchors a centered panel envelope at the top edge of a likely MacBook notch display', () => {
  const result = computeClementineLiveGeometry({
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 38, width: 1512, height: 944 },
    requestedSize: { width: 326, height: 46 },
  });
  // A true notch hangs from the very top edge (y = bounds.y = 0) and grows down,
  // centered on the display where the physical notch sits. The window height
  // includes the notch inset plus a shadow envelope so the renderer can grow
  // out of the physical notch without clipping its finished panel.
  assert.deepEqual(result, {
    x: 577,
    y: 0,
    width: 358,
    height: 108,
    likelyNotched: true,
    topInset: 38,
  });
});

test('places the always-interactive dormant dog immediately left of the physical notch', () => {
  const result = computeClementineLiveGeometry({
    bounds: { x: 0, y: 0, width: 1470, height: 956 },
    workArea: { x: 0, y: 32, width: 1470, height: 924 },
    requestedSize: { width: 62, height: 48 },
    presentation: 'dormant',
  });
  assert.deepEqual(result, {
    x: 586,
    y: 0,
    width: 62,
    height: 48,
    likelyNotched: true,
    topInset: 32,
  });
});

test('still anchors at the top edge on a non-notch display', () => {
  const result = computeClementineLiveGeometry({
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 25, width: 1920, height: 1055 },
  });
  assert.equal(result.y, 0);
  assert.equal(result.likelyNotched, false);
});

test('supports auto-hidden menu bars and negative-coordinate displays', () => {
  const result = computeClementineLiveGeometry({
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
  });
  assert.equal(result.x, -1139);
  assert.equal(result.y, 0);
});

test('uses native safe-area geometry when an auto-hidden menu bar masks the notch inset', () => {
  const result = computeClementineLiveGeometry({
    bounds: { x: 0, y: 0, width: 1470, height: 956 },
    workArea: { x: 0, y: 0, width: 1470, height: 956 },
    requestedSize: { width: 360, height: 144 },
    presentation: 'panel',
    topInsetOverride: 32,
  });
  assert.equal(result.topInset, 32);
  assert.equal(result.height, 200, '144 content + 32 notch inset + 24 shadow margin');
  assert.equal(result.likelyNotched, true);
});

test('grows an expanded panel downward from the top edge, on-screen', () => {
  const result = computeClementineLiveGeometry({
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    workArea: { x: 0, y: 38, width: 1280, height: 682 },
    requestedSize: { width: 520, height: 684 },
  });
  assert.equal(result.y, 0);
  // 684 surface + 38 inset = 722, clamped to the work-area bottom (720).
  assert.equal(result.height, 720);
  assert.ok(result.y + result.height <= 720, 'stays within the display');
});

test('stops an expanded panel short of a bottom-docked work area', () => {
  const result = computeClementineLiveGeometry({
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    workArea: { x: 0, y: 25, width: 1280, height: 655 },
    requestedSize: { width: 520, height: 684 },
  });
  assert.equal(result.y, 0);
  // 664 surface + 25 inset = 689, clamped to the work-area bottom (680, above the Dock).
  assert.equal(result.height, 680);
  assert.ok(result.y + result.height <= 680, 'stays above the Dock');
});

test('normalizes unsafe or oversized renderer resize requests', () => {
  assert.deepEqual(normalizeClementineLiveSize({ width: Number.NaN, height: -20 }), {
    width: 326,
    height: 28,
  });
  assert.deepEqual(normalizeClementineLiveSize({ width: 9000, height: 9000 }, { width: 500, height: 300 }), {
    width: 484,
    height: 292,
  });
});

test('uses a stable default shortcut with a configurable override', () => {
  assert.equal(resolveClementineLiveShortcut(), DEFAULT_CLEMENTINE_LIVE_SHORTCUT);
  assert.equal(resolveClementineLiveShortcut('  Command+Option+L  '), 'Command+Option+L');
  assert.equal(resolveClementineLiveShortcut('   '), DEFAULT_CLEMENTINE_LIVE_SHORTCUT);
});
