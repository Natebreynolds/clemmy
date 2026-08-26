/**
 * Run: npx tsx --test src/lib/mobile-shell.test.ts   (from apps/mobile-web)
 *
 * Pin: the PWA install/launch shell is "clementine in daylight". The
 * manifest and the host page must agree on the paper palette so an
 * installed app can never open through a dark splash or dark status bar
 * again — the regression becomes unrepresentable, not just unlikely.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAPER = '#fcf9f4';
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('manifest launches on the paper palette, never a dark shell', () => {
  const manifest = JSON.parse(read('../../public/manifest.webmanifest'));
  assert.equal(manifest.background_color, PAPER);
  assert.equal(manifest.theme_color, PAPER);
});

test('index.html status bar and theme-color match the light chrome', () => {
  const html = read('../../index.html');
  const statusBar = html.match(
    /name="apple-mobile-web-app-status-bar-style"\s+content="([^"]+)"/,
  );
  assert.equal(statusBar?.[1], 'default');
  const themeColor = html.match(/name="theme-color"\s+content="([^"]+)"/);
  assert.equal(themeColor?.[1], PAPER);
});
