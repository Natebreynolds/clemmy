import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOME_PREFERENCES, desktopHomePreferences, primaryHomeNavigation } from './home-prefs';
import { PRIMARY_NAV, resolveSidebarNav } from './nav';

test('Home is first and visible even when an older saved sidebar folded it into More', () => {
  const prefs = {
    ...DEFAULT_HOME_PREFERENCES,
    nav: { pinned: ['/chat', '/tasks'], shown: ['/connect'], more: ['/home', '/workspaces', '/memory'] },
  };
  const nav = resolveSidebarNav(prefs, { developerMode: false });
  assert.equal(PRIMARY_NAV[0]?.path, '/home');
  assert.deepEqual(nav.pinned.map(dest => dest.path), ['/home', '/chat', '/tasks']);
  assert.deepEqual(nav.shown.map(dest => dest.path), ['/connect']);
  assert.equal(nav.more.some(dest => dest.path === '/home'), false);
  assert.deepEqual(prefs.nav.more, ['/home', '/workspaces', '/memory'], 'rendering must not mutate the shared saved preferences');
});

test('only untouched server defaults change their desktop landing; explicit Chat and project choices survive', () => {
  const untouched = desktopHomePreferences({ ...DEFAULT_HOME_PREFERENCES, landing: 'last_conversation', updatedAt: '1970-01-01T00:00:00.000Z' });
  assert.equal(untouched.landing, 'home');
  for (const landing of ['home', 'current_project', 'last_conversation'] as const) {
    assert.equal(desktopHomePreferences({ ...DEFAULT_HOME_PREFERENCES, landing, updatedAt: '2026-09-07T10:00:00.000Z' }).landing, landing);
    assert.equal(desktopHomePreferences({ ...DEFAULT_HOME_PREFERENCES, landing }).landing, landing, 'unknown older provenance must not be mistaken for untouched defaults');
  }
});

test('a shipped chips-first home record is re-expressed before the desktop reads it', () => {
  const chipsFirst = desktopHomePreferences({
    ...DEFAULT_HOME_PREFERENCES,
    panes: { order: ['quick_actions', 'needs_you', 'running', 'while_away', 'projects'], hidden: ['workstate'] },
  });
  assert.deepEqual(chipsFirst.panes.order, DEFAULT_HOME_PREFERENCES.panes.order);
});

test('making Home primary preserves other groups and is stable when preferences are normalized twice', () => {
  const nav = { pinned: ['/memory', '/home', '/chat'], shown: ['/tasks', '/home'], more: ['/connect', '/home'] };
  const result = primaryHomeNavigation(nav);
  assert.deepEqual(result, { pinned: ['/home', '/memory', '/chat'], shown: ['/tasks'], more: ['/connect'] });
  assert.deepEqual(primaryHomeNavigation(result), result);
});
