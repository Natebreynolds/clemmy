/**
 * Chat is the main feature and ships PINNED, not folded under More.
 *
 * Owner, 2026-09-07: "chat is one of the if not the main feature of
 * Clementine" — yet the shipped default folded /chat into More, and because a
 * stored sidebar is taken verbatim, changing the default alone would have left
 * every existing user (including the owner, whose file was a copy of the old
 * default) with Chat still hidden. So the normalizer migrates a sidebar that is
 * byte-identical to the LEGACY default, and leaves a shaped one exactly alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOME_PREFERENCES, normalizeHomePreferences } from './home-preferences.js';

const LEGACY = {
  pinned: ['/home', '/inbox', '/tasks', '/workspaces'],
  shown: ['/automate', '/connect'],
  more: ['/chat', '/memory', '/meetings', '/goals', '/agents'],
};

test('the default sidebar pins /chat and no longer folds it', () => {
  assert.ok(DEFAULT_HOME_PREFERENCES.nav.pinned.includes('/chat'), 'chat is pinned');
  assert.ok(!DEFAULT_HOME_PREFERENCES.nav.more.includes('/chat'), 'chat is not under More');
  assert.equal(DEFAULT_HOME_PREFERENCES.nav.pinned[1], '/chat', 'chat sits right after Home');
});

test('a stored sidebar identical to the legacy default follows the new default', () => {
  const prefs = normalizeHomePreferences({ nav: { ...LEGACY } });
  assert.deepEqual(prefs.nav, DEFAULT_HOME_PREFERENCES.nav);
});

test('a sidebar the user actually shaped is left exactly alone', () => {
  const shaped = {
    pinned: ['/home', '/tasks'],
    shown: ['/inbox'],
    more: ['/chat', '/workspaces', '/automate', '/connect', '/memory', '/meetings', '/goals', '/agents'],
  };
  const prefs = normalizeHomePreferences({ nav: { ...shaped } });
  assert.deepEqual(prefs.nav, shaped, 'customization must never be overwritten by a default change');
});

test('a partial stored nav still fills missing groups from the new default', () => {
  const prefs = normalizeHomePreferences({ nav: { pinned: ['/home'] } });
  assert.deepEqual(prefs.nav.pinned, ['/home']);
  assert.deepEqual(prefs.nav.more, DEFAULT_HOME_PREFERENCES.nav.more);
});

test('Home style, the live status header and per-Space views persist; anything else falls back', () => {
  const saved = normalizeHomePreferences({
    style: 'briefing',
    liveStatus: 'still',
    spaceViews: { 'my-day': 'full', 'platform-review': 'summary', broken: 'huge', '': 'full' },
    panes: { order: ['today', 'needs_you'], hidden: [] },
  });
  assert.equal(saved.style, 'briefing');
  assert.equal(saved.liveStatus, 'still');
  assert.deepEqual(saved.spaceViews, { 'my-day': 'full', 'platform-review': 'summary' });
  assert.deepEqual(saved.panes.order, ['today', 'needs_you']);

  const unknown = normalizeHomePreferences({ style: 'magazine', liveStatus: 'blinking', spaceViews: ['full'] });
  assert.equal(unknown.style, 'dashboard');
  assert.equal(unknown.liveStatus, 'animated');
  assert.deepEqual(unknown.spaceViews, {});

  // A record saved before these fields existed keeps every other choice.
  const older = normalizeHomePreferences({ landing: 'last_conversation', panes: { order: ['running', 'made'], hidden: ['projects'] } });
  assert.equal(older.landing, 'last_conversation');
  assert.deepEqual(older.panes, { order: ['running', 'made'], hidden: ['projects'] });
  assert.equal(older.style, 'dashboard');
});
