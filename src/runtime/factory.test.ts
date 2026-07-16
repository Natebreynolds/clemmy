/**
 * Run: npx tsx --test src/runtime/factory.test.ts
 *
 * Degraded-auth boot contract (live user report 2026-07-16): a selected OAuth
 * AUTH_MODE with NO persisted grant must construct a runtime and let the
 * daemon boot — never throw. The old throw crash-looped the whole daemon on a
 * new user's first relaunch when the setup OAuth dance hadn't persisted.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-factory-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.AUTH_MODE = 'codex_oauth';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createRuntimeFromConfig } = await import('./factory.js');
const { CodexNativeRuntime } = await import('./codex-native-runtime.js');
const { getAuthStatus } = await import('./auth-store.js');

test('AUTH_MODE=codex_oauth with NO grant boots degraded — constructs, never throws', () => {
  assert.equal(getAuthStatus().configured, false, 'precondition: no grant in the isolated home');
  const runtime = createRuntimeFromConfig();
  assert.ok(runtime instanceof CodexNativeRuntime, 'still the codex runtime — calls fail honestly, boot survives');
});

test('a persisted grant keeps the normal configured path', () => {
  writeFileSync(
    path.join(TMP_HOME, 'state', 'auth.json'),
    JSON.stringify({ source: 'native', codexOauth: { accessToken: 'at-test', refreshToken: 'rt-test' } }),
  );
  assert.equal(getAuthStatus().configured, true);
  assert.ok(createRuntimeFromConfig() instanceof CodexNativeRuntime);
});
