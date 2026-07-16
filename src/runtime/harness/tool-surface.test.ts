import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveToolSurface } from './tool-surface.js';

test('resolveToolSurface partitions the live lane into first-class, deferred, and hidden sets', () => {
  const result = resolveToolSurface({
    surface: 'test',
    lane: 'chat',
    availableNames: ['recall', 'search', 'archive', 'write', 'cli_only'],
    allowedNames: ['recall', 'search', 'archive', 'write'],
    excludeNames: ['write'],
    alwaysLoadedNames: ['recall'],
    promotedNames: ['search'],
    deferralEnabled: true,
  });

  assert.deepEqual(result.firstClass, ['recall', 'search']);
  assert.deepEqual(result.deferred, ['archive']);
  assert.deepEqual(result.hidden, ['write', 'cli_only']);
  assert.equal(result.diagnostics.firstClassCount, 2);
  assert.equal(result.diagnostics.deferredCount, 1);
  assert.equal(result.diagnostics.hiddenCount, 2);
});

test('resolveToolSurface keeps the complete allowed surface when acquisition is unavailable', () => {
  const result = resolveToolSurface({
    surface: 'test',
    lane: 'workflow',
    availableNames: ['read', 'write'],
    alwaysLoadedNames: [],
    deferralEnabled: false,
  });

  assert.deepEqual(result.firstClass, ['read', 'write']);
  assert.deepEqual(result.deferred, []);
  assert.deepEqual(result.hidden, []);
});

test('a promoted or always-loaded ghost can never enter the surface', () => {
  const result = resolveToolSurface({
    surface: 'test',
    lane: 'chat',
    availableNames: ['real'],
    alwaysLoadedNames: ['ghost_core'],
    promotedNames: ['ghost_recalled'],
    deferralEnabled: true,
  });

  assert.deepEqual(result.firstClass, []);
  assert.deepEqual(result.deferred, ['real']);
  assert.equal(result.entries.some((entry) => entry.name.startsWith('ghost_')), false);
});
