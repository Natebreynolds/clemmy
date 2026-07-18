import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeClementineLiveGeometry,
  DEFAULT_CLEMENTINE_LIVE_SHORTCUT,
  normalizeClementineLiveSize,
  resolveClementineLiveShortcut,
} from './live-window-geometry.js';

test('centers below a likely MacBook notch safe area', () => {
  const result = computeClementineLiveGeometry({
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 38, width: 1512, height: 944 },
    requestedSize: { width: 326, height: 46 },
  });
  assert.deepEqual(result, {
    x: 593,
    y: 46,
    width: 326,
    height: 46,
    likelyNotched: true,
    topInset: 38,
  });
});

test('falls back below the menu bar on a non-notch display', () => {
  const result = computeClementineLiveGeometry({
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 25, width: 1920, height: 1055 },
  });
  assert.equal(result.y, 33);
  assert.equal(result.likelyNotched, false);
});

test('supports auto-hidden menu bars and negative-coordinate displays', () => {
  const result = computeClementineLiveGeometry({
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
  });
  assert.equal(result.x, -1123);
  assert.equal(result.y, 8);
});

test('keeps an expanded surface on-screen below a short notch safe area', () => {
  const result = computeClementineLiveGeometry({
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    workArea: { x: 0, y: 38, width: 1280, height: 682 },
    requestedSize: { width: 520, height: 684 },
  });
  assert.equal(result.y, 46);
  assert.equal(result.height, 666);
  assert.ok(result.y + result.height <= 712, 'preserves the eight-pixel bottom edge gap');
});

test('keeps an expanded surface above a bottom-docked work area', () => {
  const result = computeClementineLiveGeometry({
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    workArea: { x: 0, y: 25, width: 1280, height: 655 },
    requestedSize: { width: 520, height: 684 },
  });
  assert.equal(result.y, 33);
  assert.equal(result.height, 639);
  assert.ok(result.y + result.height <= 672, 'preserves the eight-pixel gap above the Dock');
});

test('normalizes unsafe or oversized renderer resize requests', () => {
  assert.deepEqual(normalizeClementineLiveSize({ width: Number.NaN, height: -20 }), {
    width: 326,
    height: 40,
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
