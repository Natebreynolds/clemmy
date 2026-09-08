import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOME_PREFERENCES, desktopHomePreferences, primaryChatNavigation } from './home-prefs';
import { PRIMARY_NAV, resolveSidebarNav } from './nav';

test('Chat is first and visible even when an older saved sidebar folded it into More', () => {
  const prefs = {
    ...DEFAULT_HOME_PREFERENCES,
    nav: { pinned: ['/home', '/tasks'], shown: ['/connect'], more: ['/chat', '/workspaces', '/memory'] },
  };
  const nav = resolveSidebarNav(prefs, { developerMode: false });
  assert.equal(PRIMARY_NAV[0]?.path, '/chat');
  assert.deepEqual(nav.pinned.map(dest => dest.path), ['/chat', '/home', '/tasks']);
  assert.deepEqual(nav.shown.map(dest => dest.path), ['/connect']);
  assert.equal(nav.more.some(dest => dest.path === '/chat'), false);
  assert.deepEqual(prefs.nav.more, ['/chat', '/workspaces', '/memory'], 'rendering must not mutate the shared saved preferences');
});

test('only untouched server defaults change their desktop landing; explicit Home and project choices survive', () => {
  const untouched = desktopHomePreferences({ ...DEFAULT_HOME_PREFERENCES, landing: 'home', updatedAt: '1970-01-01T00:00:00.000Z' });
  assert.equal(untouched.landing, 'last_conversation');
  for (const landing of ['home', 'current_project', 'last_conversation'] as const) {
    assert.equal(desktopHomePreferences({ ...DEFAULT_HOME_PREFERENCES, landing, updatedAt: '2026-09-07T10:00:00.000Z' }).landing, landing);
    assert.equal(desktopHomePreferences({ ...DEFAULT_HOME_PREFERENCES, landing }).landing, landing, 'unknown older provenance must not be mistaken for untouched defaults');
  }
});

test('making Chat primary preserves other groups and is stable when preferences are normalized twice', () => {
  const nav = { pinned: ['/memory', '/chat', '/home'], shown: ['/tasks', '/chat'], more: ['/connect', '/chat'] };
  const result = primaryChatNavigation(nav);
  assert.deepEqual(result, { pinned: ['/chat', '/memory', '/home'], shown: ['/tasks'], more: ['/connect'] });
  assert.deepEqual(primaryChatNavigation(result), result);
});
