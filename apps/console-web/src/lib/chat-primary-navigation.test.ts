import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOME_PREFERENCES, desktopHomePreferences, primaryHomeNavigation } from './home-prefs';
import { PRIMARY_NAV, resolveSidebarNav } from './nav';

test('Today is first and visible even when an older saved sidebar folded Home into More; Running is no longer primary', () => {
  const prefs = {
    ...DEFAULT_HOME_PREFERENCES,
    nav: { pinned: ['/chat', '/tasks'], shown: ['/connect'], more: ['/home', '/workspaces', '/memory'] },
  };
  const nav = resolveSidebarNav(prefs, { developerMode: false });
  assert.equal(PRIMARY_NAV[0]?.path, '/chat');
  assert.equal(PRIMARY_NAV[0]?.label, 'Today');
  assert.equal(PRIMARY_NAV.some(dest => dest.path === '/home' || dest.path === '/tasks'), false, 'Home merged into Today; Running folded into it');
  assert.deepEqual(nav.pinned.map(dest => dest.path), ['/chat']);
  assert.deepEqual(nav.shown.map(dest => dest.path), ['/projects', '/connect', '/memory', '/agents'], 'Memory and Agents leave More and stay visible; Projects, which this sidebar never placed, is shown');
  assert.equal(nav.more.some(dest => dest.path === '/home' || dest.path === '/chat' || dest.path === '/memory' || dest.path === '/agents'), false);
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

test('making Today primary folds a saved Home into it, preserves other groups, and is stable when normalized twice', () => {
  const nav = { pinned: ['/memory', '/home', '/chat'], shown: ['/tasks', '/home'], more: ['/connect', '/home'] };
  const result = primaryHomeNavigation(nav);
  assert.deepEqual(result, { pinned: ['/chat', '/memory'], shown: ['/projects', '/tasks', '/agents'], more: ['/connect'] }, 'a pinned Memory stays pinned; Agents is shown, never folded; an unplaced Projects is shown');
  assert.deepEqual(primaryHomeNavigation(result), result);
});

test('Memory and Agents are visible by default and cannot be folded into More', () => {
  assert.deepEqual(DEFAULT_HOME_PREFERENCES.nav.more.filter((p) => p === '/memory' || p === '/agents'), []);
  const folded = resolveSidebarNav({ ...DEFAULT_HOME_PREFERENCES, nav: { pinned: ['/chat'], shown: [], more: ['/memory', '/agents', '/goals'] } }, { developerMode: false });
  assert.deepEqual(folded.shown.map((d) => d.path), ['/projects', '/memory', '/agents']);
  assert.deepEqual(folded.more.map((d) => d.path).filter((p) => p === '/memory' || p === '/agents'), []);
});

test('Projects is a primary destination: pinned by default, shown on a sidebar saved before it existed, and where the owner puts it is kept', () => {
  const projects = PRIMARY_NAV.find((dest) => dest.path === '/projects');
  assert.equal(projects?.label, 'Projects');
  assert.ok(DEFAULT_HOME_PREFERENCES.nav.pinned.includes('/projects'), 'a fresh sidebar pins Projects');
  assert.deepEqual(
    resolveSidebarNav(DEFAULT_HOME_PREFERENCES, { developerMode: false }).pinned.map((d) => d.path),
    ['/chat', '/inbox', '/projects', '/workspaces'],
  );

  const savedBefore = { pinned: ['/chat', '/inbox', '/workspaces'], shown: ['/automate', '/connect', '/memory', '/agents'], more: ['/meetings', '/goals'] };
  const placed = resolveSidebarNav({ ...DEFAULT_HOME_PREFERENCES, nav: savedBefore }, { developerMode: false });
  assert.deepEqual(placed.pinned.map((d) => d.path), ['/chat', '/inbox', '/workspaces'], 'the pinned group the owner arranged is not touched');
  assert.equal(placed.shown[0]?.path, '/projects', 'shown first below the pinned group');
  assert.equal(placed.more.some((d) => d.path === '/projects'), false, 'never folded unseen into More');

  for (const group of ['pinned', 'shown', 'more'] as const) {
    const chosen = { pinned: ['/chat'], shown: ['/connect'], more: ['/goals'] };
    chosen[group] = [...chosen[group], '/projects'];
    const kept = primaryHomeNavigation(chosen);
    assert.ok(kept[group].includes('/projects'), `a Projects the owner put in ${group} stays where it was put`);
    assert.equal([...kept.pinned, ...kept.shown, ...kept.more].filter((path) => path === '/projects').length, 1);
    assert.deepEqual(primaryHomeNavigation(kept), kept, 'and placing it is stable');
  }
});
