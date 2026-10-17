import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHomeContentLayout, type HomeContentBlock } from './home-content-layout.js';
import type { HomePaneId, HomeStyle } from '../../lib/home-prefs.js';

const panes = (...items: HomePaneId[]): HomeContentBlock => ({ kind: 'panes', panes: items });
const spaces: HomeContentBlock = { kind: 'spaces' };
const flattened = (blocks: readonly HomeContentBlock[]): HomePaneId[] => blocks.flatMap(block => block.kind === 'panes' ? block.panes : []);

test('dashboard places Spaces after only the first adjacent immediate group', () => {
  assert.deepEqual(buildHomeContentLayout(['today', 'needs_you', 'while_away', 'made'], 'dashboard'), [
    panes('today', 'needs_you', 'while_away'), spaces, panes('made'),
  ]);
  assert.deepEqual(buildHomeContentLayout(['projects', 'today', 'quick_actions', 'needs_you', 'while_away'], 'dashboard'), [
    panes('projects'), panes('today'), spaces, panes('quick_actions'), panes('needs_you', 'while_away'),
  ]);
});

test('briefing inserts Spaces exactly after needs-you without moving adjacent panes across it', () => {
  assert.deepEqual(buildHomeContentLayout(['today', 'needs_you', 'while_away', 'projects'], 'briefing'), [
    panes('today', 'needs_you'), spaces, panes('while_away'), panes('projects'),
  ]);
  assert.deepEqual(buildHomeContentLayout(['today', 'while_away', 'needs_you', 'today'], 'briefing'), [
    panes('today', 'while_away'), panes('needs_you'), spaces, panes('today'),
  ]);
});

test('quick actions keep their first, last or interleaved position in either style', () => {
  for (const style of ['dashboard', 'briefing'] as const) {
    for (const visible of [
      ['quick_actions', 'needs_you', 'today', 'made'],
      ['needs_you', 'today', 'made', 'quick_actions'],
      ['today', 'quick_actions', 'needs_you', 'while_away'],
    ] satisfies HomePaneId[][]) {
      const original = [...visible];
      const blocks = buildHomeContentLayout(Object.freeze(visible), style);
      assert.deepEqual(flattened(blocks), original);
      assert.equal(blocks.filter(block => block.kind === 'spaces').length, 1);
    }
  }
});

test('no immediate dashboard pane or no briefing needs-you puts Spaces before all panes', () => {
  assert.deepEqual(buildHomeContentLayout(['quick_actions', 'projects', 'made'], 'dashboard'), [
    spaces, panes('quick_actions'), panes('projects'), panes('made'),
  ]);
  assert.deepEqual(buildHomeContentLayout(['today', 'while_away', 'quick_actions'], 'briefing'), [
    spaces, panes('today', 'while_away'), panes('quick_actions'),
  ]);
});

test('an empty layout still has exactly one Spaces block', () => {
  for (const style of ['dashboard', 'briefing'] as const) assert.deepEqual(buildHomeContentLayout([], style), [spaces]);
});

test('all pane identities and their order survive mixed layouts, including retained legacy panes', () => {
  const all: HomePaneId[] = ['quick_actions', 'needs_you', 'today', 'running', 'while_away', 'made', 'projects', 'workstate'];
  for (const style of ['dashboard', 'briefing'] as const) {
    for (let offset = 0; offset < all.length; offset += 1) {
      const visible = [...all.slice(offset), ...all.slice(0, offset)];
      const before = [...visible];
      const blocks = buildHomeContentLayout(Object.freeze(visible), style);
      assert.deepEqual(flattened(blocks), before);
      assert.equal(blocks.filter(block => block.kind === 'spaces').length, 1);
      for (const block of blocks) {
        if (block.kind !== 'panes' || block.panes.length === 1) continue;
        assert.ok(block.panes.length <= (style === 'dashboard' ? 3 : 2));
        assert.ok(block.panes.every(pane => ['today', 'needs_you', 'while_away'].includes(pane)));
      }
    }
  }
});

test('long immediate sequences obey group bounds without losing repeated supplied positions', () => {
  const visible: HomePaneId[] = ['today', 'needs_you', 'while_away', 'today', 'needs_you', 'while_away'];
  for (const style of ['dashboard', 'briefing'] satisfies HomeStyle[]) {
    const blocks = buildHomeContentLayout(visible, style);
    assert.deepEqual(flattened(blocks), visible);
    assert.equal(blocks.filter(block => block.kind === 'spaces').length, 1);
    assert.ok(blocks.every(block => block.kind === 'spaces' || block.panes.length <= (style === 'dashboard' ? 3 : 2)));
  }
});
