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

/**
 * Owner directive 2026-08-25: "more full screen. No buttons floating at the
 * bottom to navigate. Every menu item should be clean left hand side
 * collapsing menu like a premium iOS app." The six sections live in a left
 * slide-in drawer; the bottom dock is DELETED, not hidden, and content gets
 * the full height back.
 */
test('navigation is a left drawer — the bottom dock is gone from code and styles', () => {
  const app = read('../app.tsx');
  assert.doesNotMatch(app, /class="dock"|dock-icon|dock-label|dock-badge/,
    'the dock must be deleted, not hidden');
  const css = read('../styles.css');
  assert.doesNotMatch(css, /--dock-height|\.dock\b|\.dock-/,
    'dock styles and the reserved-height token must be deleted');
  // Full-screen content: the main scroll area clears only the safe area,
  // never a reserved dock band.
  assert.match(css, /\.app-main \{[\s\S]*?env\(safe-area-inset-bottom\)/);
});

test('the drawer is modal, focus-trapped, keyboard dismissible, and marks the current screen', () => {
  const app = read('../app.tsx');
  // Hamburger opens it from the header's left edge with a real touch target.
  assert.match(app, /class="menu-btn"[\s\S]*?aria-label="Open menu"/);
  assert.match(app, /aria-expanded=\{drawerOpen\}/);
  // Dialog semantics + Escape + scrim close.
  assert.match(app, /class=\{`drawer-layer\$\{drawerClosing \? \' closing\' : \'\'\}`\} role="dialog" aria-modal="true"/);
  assert.match(app, /event\.key === 'Escape'/);
  assert.match(app, /class="drawer-scrim"[\s\S]*?aria-label="Close menu"/);
  // The active section carries the page marker, accent-highlighted in CSS.
  assert.match(app, /aria-current=\{tab === t\.id \? 'page' : undefined\}/);
  const css = read('../styles.css');
  assert.match(css, /\.menu-btn \{[\s\S]*?width: 44px;[\s\S]*?height: 44px/);
  assert.match(css, /\.drawer \{[\s\S]*?width: min\(82vw, 320px\)/);
  assert.match(css, /\.drawer \{[\s\S]*?env\(safe-area-inset-left\)/);
  assert.match(css, /\.drawer-item \{[\s\S]*?min-height: 48px/);
  assert.match(css, /\.drawer-item\[aria-current='page'\] \{[\s\S]*?var\(--accent\)/);
});

/**
 * Owner mandates 2026-08-25: Settings rides the drawer (gear row at the
 * BOTTOM of the menu), the header sign-out moves into Settings > Devices &
 * security, and the Brain switcher is a routing choice over the daemon's
 * live catalog. Trust is minted at home on the Mac and only EXERCISED in
 * the pocket — so nothing key-shaped may ever render on the phone.
 */
test('Settings is reachable from the drawer bottom and the header sign-out is gone', () => {
  const app = read('../app.tsx');
  assert.match(app, /'settings'/, 'the settings tab exists');
  assert.match(app, /class="drawer-foot"[\s\S]*?Settings/,
    'Settings is a dedicated row at the bottom of the drawer menu');
  assert.doesNotMatch(app, /aria-label="Sign out"/,
    'the header sign-out moved into Settings > Devices & security');
});

test('Settings holds nothing key-shaped — routing choices only', () => {
  const settings = read('../screens/Settings.tsx');
  assert.doesNotMatch(settings, /<input/i,
    'no input fields at all: connecting accounts and minting trust happen on the Mac');
  assert.doesNotMatch(settings, /type="password"|autocomplete="current-password"/i);
});

test('the brain switcher renders from the live catalog, never a hardcoded roster', () => {
  const sheet = read('../components/BrainSheet.tsx');
  assert.match(sheet, /getModelSettings/,
    'the roster comes from the daemon catalog route');
  const settings = read('../screens/Settings.tsx');
  for (const literal of ['gpt-5', 'claude-opus', 'claude-sonnet', 'glm-', 'deepseek', 'minimax']) {
    const re = new RegExp(literal, 'i');
    assert.doesNotMatch(sheet, re, `model id "${literal}" must not be hardcoded in the sheet`);
    assert.doesNotMatch(settings, re, `model id "${literal}" must not be hardcoded in Settings`);
  }
});
