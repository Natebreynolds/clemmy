/**
 * Run: npx tsx --test src/memory/db-reset-guard.test.ts
 *
 * resetMemoryDb DROPS the whole memory DB; against the real default home that
 * permanently wipes the user's facts (2026-06-28 incident). assertMemoryResetAllowed
 * is the guard: refuse the real default home unless explicitly forced, while
 * letting tests/sandboxes (which use a temp CLEMENTINE_HOME) through freely.
 * The guard is a PURE function (baseDir injected) so these never touch a real DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Isolate before importing db (so the module's own BASE_DIR is a sandbox).
process.env.CLEMENTINE_HOME = path.join(os.tmpdir(), 'clem-reset-guard-test');
const { assertMemoryResetAllowed } = await import('./db.js');

const REAL_HOME = path.join(os.homedir(), '.clementine-next');

test('blocks a reset of the real default home when not forced', () => {
  assert.throws(
    () => assertMemoryResetAllowed(REAL_HOME, false, REAL_HOME),
    /refused|PERMANENTLY WIPE/,
    'must refuse to wipe the live home without force',
  );
});

test('allows the real default home when force is explicitly passed', () => {
  assert.doesNotThrow(() => assertMemoryResetAllowed(REAL_HOME, true, REAL_HOME));
});

test('allows a sandbox / temp home (the test + smoke-script path) without force', () => {
  const temp = path.join(os.tmpdir(), 'clemmy-test-xyz');
  assert.doesNotThrow(() => assertMemoryResetAllowed(temp, false, REAL_HOME));
});

test('allows a custom (non-default) real home without force — the forgot-env case still hits the default and is blocked', () => {
  // A user with a custom CLEMENTINE_HOME: an explicit reset of it is intentional.
  const custom = path.join(os.tmpdir(), 'some-custom-home', '.clementine-next');
  assert.doesNotThrow(() => assertMemoryResetAllowed(custom, false, REAL_HOME));
});
