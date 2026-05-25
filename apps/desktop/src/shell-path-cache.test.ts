/**
 * Unit tests for the shell-path cache + mergePaths helper.
 * Run with: npx tsx --test apps/desktop/src/shell-path-cache.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { readCache, writeCache, mergePaths } from './shell-path-cache.js';

function withTempHome<T>(fn: () => T): T {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'clemmy-shell-path-cache-'));
  const prior = process.env.CLEMENTINE_HOME;
  process.env.CLEMENTINE_HOME = path.join(tmp, '.clementine-next');
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.CLEMENTINE_HOME;
    else process.env.CLEMENTINE_HOME = prior;
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('mergePaths dedupes preserving first-occurrence order', () => {
  const merged = mergePaths(
    '/opt/homebrew/bin:/usr/local/bin',
    '/usr/local/bin:/Users/me/.nvm/versions/node/v22/bin',
    '/opt/homebrew/bin:/usr/bin',
  );
  assert.equal(
    merged,
    '/opt/homebrew/bin:/usr/local/bin:/Users/me/.nvm/versions/node/v22/bin:/usr/bin',
  );
});

test('mergePaths skips null and empty sources gracefully', () => {
  assert.equal(mergePaths(null, undefined, ''), '');
  assert.equal(mergePaths(null, '/usr/local/bin', null), '/usr/local/bin');
});

test('writeCache + readCache roundtrip preserves the path string', () => {
  withTempHome(() => {
    const samplePath = '/opt/homebrew/bin:/Users/me/.nvm/versions/node/v22.22.0/bin:/usr/local/bin';
    writeCache(samplePath);
    const got = readCache();
    assert.ok(got, 'expected cache to exist after write');
    assert.equal(got!.path, samplePath);
    assert.ok(got!.extractedAt, 'extractedAt should be set');
    assert.ok(!Number.isNaN(Date.parse(got!.extractedAt)), 'extractedAt parses as a date');
  });
});

test('readCache returns null when no cache file exists', () => {
  withTempHome(() => {
    assert.equal(readCache(), null);
  });
});

test('readCache returns null when cache is older than 7 days (stale)', () => {
  withTempHome(() => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    writeCache('/opt/homebrew/bin', eightDaysAgo);
    // Read with the real `now` — should be null because cache is stale.
    assert.equal(readCache(), null);
  });
});

test('readCache accepts cache within the 7-day TTL', () => {
  withTempHome(() => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    writeCache('/opt/homebrew/bin', sixDaysAgo);
    const got = readCache();
    assert.ok(got, 'expected cache to be accepted at 6 days old');
    assert.equal(got!.path, '/opt/homebrew/bin');
  });
});

test('readCache rejects corrupted JSON', () => {
  withTempHome(() => {
    const home = process.env.CLEMENTINE_HOME!;
    mkdirSync(path.join(home, 'state'), { recursive: true });
    writeFileSync(path.join(home, 'state', 'shell-path.json'), '{not valid json');
    assert.equal(readCache(), null);
  });
});

test('readCache rejects path missing required fields', () => {
  withTempHome(() => {
    const home = process.env.CLEMENTINE_HOME!;
    mkdirSync(path.join(home, 'state'), { recursive: true });
    writeFileSync(path.join(home, 'state', 'shell-path.json'), JSON.stringify({ path: 'no_slash_no_colon' }));
    assert.equal(readCache(), null, 'rejects path that does not look like a real PATH');
  });
});
