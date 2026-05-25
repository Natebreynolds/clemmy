/**
 * Unit tests for the shell PATH extractor.
 * Run with: npx tsx --test apps/desktop/src/shell-path-extractor.test.ts
 *
 * We spawn a real zsh/bash and only assert on the shape of the result —
 * the actual PATH contents depend on the test machine's shell rc files.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { extractShellPath } from './shell-path-extractor.js';

test('extractShellPath returns a result envelope with path + shell + durationMs', async () => {
  const result = await extractShellPath();
  assert.equal(typeof result.durationMs, 'number');
  assert.ok(result.durationMs >= 0, 'durationMs >= 0');
  // On a normal dev machine zsh OR bash should be present.
  // If both are missing the failureReason should explain.
  if (result.path) {
    assert.ok(result.path.includes('/'), 'extracted PATH should contain at least one slash');
    assert.ok(result.shell === 'zsh' || result.shell === 'bash', 'shell field is the producing shell name');
    assert.equal(result.failureReason, undefined, 'failureReason absent on success');
  } else {
    assert.ok(
      result.failureReason === 'timeout' ||
        result.failureReason === 'nonzero_exit' ||
        result.failureReason === 'no_shell' ||
        result.failureReason === 'spawn_error',
      'failureReason is one of the expected literals',
    );
  }
});

test('extractShellPath respects the 5s timeout budget per shell (10s wall worst case)', async () => {
  // The extractor has a 5s internal timeout per shell + a fallback
  // from zsh to bash, so the wall-clock worst case is ~10s.
  const started = Date.now();
  await extractShellPath();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 11_000, `extractShellPath took ${elapsed}ms (expected < 11000ms)`);
});
