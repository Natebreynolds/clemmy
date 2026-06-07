/**
 * Run: npx tsx --test src/runtime/spawn-env.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { augmentPath, mergedSpawnEnv } from './spawn-env.js';

test('augmentPath prepends Homebrew + the running node binary dir', () => {
  const out = augmentPath('/usr/bin:/bin');
  const parts = out.split(':');
  assert.ok(parts.includes('/opt/homebrew/bin'), 'missing /opt/homebrew/bin');
  assert.ok(parts.includes(path.dirname(process.execPath)), 'missing execPath dir');
  // Original entries survive.
  assert.ok(parts.includes('/usr/bin'));
  assert.ok(parts.includes('/bin'));
});

test('augmentPath is idempotent — no duplicate entries', () => {
  const once = augmentPath('/usr/bin');
  const twice = augmentPath(once);
  assert.equal(once, twice, 'second pass changed the result');
  const parts = twice.split(':');
  const unique = new Set(parts);
  assert.equal(parts.length, unique.size, 'duplicate PATH entries present');
});

test('augmentPath preserves existing entries AFTER the prepended dirs', () => {
  // A user-custom dir already on PATH must remain reachable, and the
  // prepends must come first (so packaged-app dirs win when a name is
  // otherwise unresolved) without reordering the user's own tail.
  const out = augmentPath('/Users/me/.custom/bin:/usr/bin');
  const parts = out.split(':');
  const customIdx = parts.indexOf('/Users/me/.custom/bin');
  const brewIdx = parts.indexOf('/opt/homebrew/bin');
  assert.ok(customIdx > brewIdx, 'prepended dirs should come before existing ones');
  assert.ok(customIdx >= 0, 'user-custom dir was dropped');
});

test('augmentPath tolerates an undefined/empty existing PATH', () => {
  for (const input of [undefined, '']) {
    const parts = augmentPath(input).split(':').filter(Boolean);
    assert.ok(parts.includes('/opt/homebrew/bin'));
    assert.ok(parts.every((p) => p.length > 0), 'empty PATH segment leaked');
  }
});

test('mergedSpawnEnv inherits parent env but augments PATH', () => {
  const prevA = process.env.CLEMMY_SPAWN_ENV_TEST;
  const prevPath = process.env.PATH;
  try {
    process.env.CLEMMY_SPAWN_ENV_TEST = 'inherited';
    process.env.PATH = '/usr/bin';
    const env = mergedSpawnEnv();
    assert.equal(env.CLEMMY_SPAWN_ENV_TEST, 'inherited');
    assert.ok(env.PATH.split(':').includes('/opt/homebrew/bin'), 'PATH not augmented');
  } finally {
    if (prevA === undefined) delete process.env.CLEMMY_SPAWN_ENV_TEST;
    else process.env.CLEMMY_SPAWN_ENV_TEST = prevA;
    process.env.PATH = prevPath;
  }
});

test('mergedSpawnEnv lets explicit extras override inherited values', () => {
  const env = mergedSpawnEnv({ FOO_BAR_OVERRIDE: 'extra' });
  assert.equal(env.FOO_BAR_OVERRIDE, 'extra');
});
