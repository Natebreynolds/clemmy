import assert from 'node:assert/strict';
import test from 'node:test';
import { isDefaultExploration, quietExplorationIntroductions, type ExplorationSnapshot } from './exploration-home';

const nowMs = 1_800_000_000_000;
const empty: ExplorationSnapshot = Object.freeze({ state: 'loaded', count: 0, updatedAt: nowMs });
const explore = { onboardingEntry: { version: 1, intent: 'explore', stamp: 123 } };
const freshPrefs = { updatedAt: '1970-01-01T00:00:00.000Z' };
const sources = Object.freeze({ eligible: true, nowMs, made: empty, projects: empty, spaces: empty, watching: empty });
const retained = { made: false, projects: false, spaces: false, watching: false };

test('only the explicit explore entry with confirmed untouched preferences can quiet introductions', () => {
  assert.equal(isDefaultExploration('/chat', explore, freshPrefs, true), true);
  for (const [path, state, prefs, confirmed] of [
    ['/chat', null, freshPrefs, true],
    ['/chat', { onboardingEntry: { ...explore.onboardingEntry, intent: 'ready' } }, freshPrefs, true],
    ['/chat', { onboardingEntry: { intent: 'explore', stamp: 123 } }, freshPrefs, true],
    ['/home', explore, freshPrefs, true],
    ['/chat', explore, { updatedAt: '2026-10-29T00:00:00.000Z' }, true],
    ['/chat', explore, undefined, true],
    ['/chat', explore, freshPrefs, false],
  ] as const) assert.equal(isDefaultExploration(path, state, prefs, confirmed), false);
});

test('four confirmed fresh empty sources yield independently without changing source records', () => {
  assert.deepEqual(quietExplorationIntroductions(sources), { made: true, projects: true, spaces: true, watching: true });
  assert.deepEqual(empty, { state: 'loaded', count: 0, updatedAt: nowMs });
  assert.deepEqual(quietExplorationIntroductions({ ...sources, eligible: false }), retained);
});

for (const pane of ['made', 'projects', 'spaces', 'watching'] as const) test(`${pane} retains content, recovery and uncertain snapshots`, () => {
  for (const snapshot of [
    { ...empty, count: 1 }, { ...empty, count: undefined },
    { ...empty, state: 'loading' }, { ...empty, state: 'error' }, { ...empty, state: 'unconfirmed' },
    { ...empty, updatedAt: nowMs - 90_001 }, { ...empty, updatedAt: 0 },
    { ...empty, updatedAt: nowMs + 1 }, { ...empty, updatedAt: Number.NaN },
  ] satisfies ExplorationSnapshot[]) {
    const result = quietExplorationIntroductions({ ...sources, [pane]: snapshot });
    assert.equal(result[pane], false);
    for (const other of ['made', 'projects', 'spaces', 'watching'] as const) if (other !== pane) assert.equal(result[other], true);
  }
});
