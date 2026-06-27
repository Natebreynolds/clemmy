/**
 * Run: npx tsx --test src/runtime/dev-flags.test.ts
 *
 * Developer feature-flags store: the curated snapshot, the live+persisted
 * set/clear round-trip (through process.env so getRuntimeEnv picks it up), the
 * CLEMMY_*-only safety allowlist, the escape-hatch "custom" surface, and the
 * dev-mode master toggle. Writes go to a throwaway CLEMENTINE_HOME/.env.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-dev-flags-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildDevFlagsSnapshot, setDevFlag, clearDevFlag, isSafeDevFlagKey,
  setDevMode, isDevModeEnabled, DEV_FLAG_REGISTRY,
} = await import('./dev-flags.js');

const TOUCHED = ['CLEMMY_DEV_FLAG_TEST_XYZ', 'CLEMMY_DEBATE_MODE', 'CLEMMY_DEV_MODE'];
afterEach(() => { for (const k of TOUCHED) delete process.env[k]; });

test('isSafeDevFlagKey: CLEMMY_* only, never dev-mode or secrets, case-sensitive', () => {
  assert.ok(isSafeDevFlagKey('CLEMMY_CODE_MODE'));
  assert.ok(!isSafeDevFlagKey('CLEMMY_DEV_MODE'), 'dev-mode has its own setter');
  assert.ok(!isSafeDevFlagKey('OPENAI_API_KEY'), 'never a secret/auth key');
  assert.ok(!isSafeDevFlagKey('WEBHOOK_PORT'));
  assert.ok(!isSafeDevFlagKey('clemmy_code_mode'), 'case-sensitive');
});

test('set then clear a curated flag is live (process.env) + reflected in the snapshot', () => {
  setDevFlag('CLEMMY_DEBATE_MODE', 'on');
  assert.equal(process.env.CLEMMY_DEBATE_MODE, 'on', 'mirrored to live process.env');
  const f = buildDevFlagsSnapshot().flags.find((x) => x.key === 'CLEMMY_DEBATE_MODE');
  assert.ok(f);
  assert.equal(f!.value, 'on');
  assert.equal(f!.overridden, true);

  clearDevFlag('CLEMMY_DEBATE_MODE');
  assert.equal(process.env.CLEMMY_DEBATE_MODE, undefined, 'override removed from live env');
});

test('escape-hatch (non-curated) key surfaces under custom + clears', () => {
  setDevFlag('CLEMMY_DEV_FLAG_TEST_XYZ', '3000');
  const snap = buildDevFlagsSnapshot();
  assert.ok(snap.custom.some((c) => c.key === 'CLEMMY_DEV_FLAG_TEST_XYZ' && c.value === '3000'));
  assert.ok(!snap.flags.some((f) => f.key === 'CLEMMY_DEV_FLAG_TEST_XYZ'), 'not in the curated list');

  clearDevFlag('CLEMMY_DEV_FLAG_TEST_XYZ');
  assert.ok(!buildDevFlagsSnapshot().custom.some((c) => c.key === 'CLEMMY_DEV_FLAG_TEST_XYZ'));
});

test('set/clear reject non-CLEMMY keys (and the dev-mode key)', () => {
  assert.throws(() => setDevFlag('OPENAI_API_KEY', 'x'));
  assert.throws(() => setDevFlag('CLEMMY_DEV_MODE', 'on'));
  assert.throws(() => clearDevFlag('AUTH_MODE'));
});

test('dev-mode master toggle round-trips', () => {
  setDevMode(true);
  assert.equal(isDevModeEnabled(), true);
  assert.equal(buildDevFlagsSnapshot().devMode, true);
  setDevMode(false);
  assert.equal(isDevModeEnabled(), false);
});

test('registry is well-formed: unique CLEMMY_* keys, boolean defaults are on/off', () => {
  const keys = DEV_FLAG_REGISTRY.map((d) => d.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate keys');
  assert.ok(keys.every((k) => /^CLEMMY_[A-Z0-9_]+$/.test(k)), 'all keys are CLEMMY_*');
  for (const d of DEV_FLAG_REGISTRY) {
    if (d.type === 'boolean') assert.ok(d.default === 'on' || d.default === 'off', `${d.key} default must be on/off`);
  }
});
