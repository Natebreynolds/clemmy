import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
};
const { sidebarCollapsedFor, writeSidebarCollapsed } = await import('./sidebar-collapsed.js');

test('a narrow window shows the rail; widening restores the owner\'s own choice', () => {
  store.clear();
  assert.equal(sidebarCollapsedFor(true), true, 'narrow (including a window loaded minimized or hidden) shows the rail');
  assert.equal(sidebarCollapsedFor(false), false, 'widening with no saved choice opens the menu again');
  writeSidebarCollapsed(true);
  assert.equal(sidebarCollapsedFor(false), true, 'an explicit collapse is kept');
  writeSidebarCollapsed(false);
  assert.equal(sidebarCollapsedFor(false), false);
  assert.equal(sidebarCollapsedFor(true), true, 'narrow still wins while it lasts');
});
