/**
 * Run: npx tsx --test src/lib/home-prefs.test.ts   (from apps/mobile-web)
 *
 * Pins for the phone's reading of the ONE home-preferences record: the pane
 * order honors the user, desktop-only panes pass through every write
 * untouched, and the title switcher can never lose "More".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HOME_PREFERENCES,
  panesFromPhoneRows,
  phonePaneRows,
  phoneSwitcherIds,
  phoneVisiblePanes,
  visiblePanes,
  type HomePreferences,
} from './home-prefs.js';

const KNOWN = ['home', 'inbox', 'chats', 'agents', 'spaces', 'workflows', 'memory', 'activity'];

test('visible panes honor the stored order, then default order, minus hidden', () => {
  const prefs: HomePreferences = {
    ...DEFAULT_HOME_PREFERENCES,
    panes: { order: ['running', 'needs_you'], hidden: ['quick_actions', 'workstate'] },
  };
  assert.deepEqual(visiblePanes(prefs), ['running', 'needs_you', 'while_away', 'made', 'projects']);
  assert.deepEqual(phoneVisiblePanes(prefs), ['running', 'needs_you', 'while_away', 'made', 'projects']);
});

test('the phone never renders or lists the desktop-only workstate pane, but preserves its setting', () => {
  const prefs: HomePreferences = {
    ...DEFAULT_HOME_PREFERENCES,
    panes: { order: ['workstate', 'needs_you', 'quick_actions'], hidden: [] },
  };
  assert.ok(!phoneVisiblePanes(prefs).includes('workstate'));
  const rows = phonePaneRows(prefs);
  assert.deepEqual(rows.map((row) => row.id), ['needs_you', 'quick_actions', 'running', 'while_away', 'made', 'projects']);
  assert.ok(rows.every((row) => row.on));
  // Hide one pane on the phone: workstate keeps its place in the stored order.
  const next = panesFromPhoneRows(prefs, rows.map((row) => (row.id === 'running' ? { ...row, on: false } : row)));
  assert.ok(next.order.includes('workstate'));
  assert.deepEqual(next.hidden, ['running']);
  // A desktop hide of workstate survives a phone write too.
  const hiddenOnDesktop: HomePreferences = { ...prefs, panes: { order: ['needs_you'], hidden: ['workstate'] } };
  const written = panesFromPhoneRows(hiddenOnDesktop, phonePaneRows(hiddenOnDesktop));
  assert.deepEqual(written.hidden, ['workstate']);
});

test('the switcher keeps the stored order, drops unknown ids, and always ends with More', () => {
  const prefs: HomePreferences = {
    ...DEFAULT_HOME_PREFERENCES,
    phoneSwitcher: ['inbox', 'home', '/tasks', 'inbox', 'more', 'spaces'],
  };
  assert.deepEqual(phoneSwitcherIds(prefs, KNOWN), ['inbox', 'home', 'spaces', 'more']);
  assert.deepEqual(phoneSwitcherIds({ ...prefs, phoneSwitcher: [] }, KNOWN), ['more']);
});

test('running work has a place in the phone navigation, without a tenth section', () => {
  const ids = phoneSwitcherIds(DEFAULT_HOME_PREFERENCES, KNOWN);
  assert.ok(ids.includes('activity'), 'the run surface is a destination, not only a tap-through');
  assert.equal(ids[ids.length - 1], 'more');
  assert.ok(ids.length <= 6, 'the switcher promotes what exists rather than growing');
  assert.equal(
    new Set(ids).size,
    ids.length,
    'no duplicate destinations',
  );
});
