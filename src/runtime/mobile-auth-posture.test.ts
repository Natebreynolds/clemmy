/**
 * Run: npx tsx --test src/runtime/mobile-auth-posture.test.ts
 *
 * This module is now the QR gate. If it ever degrades into a constant `ok:true`,
 * the mobile surface is exposed by default — so these tests assert it actually
 * responds to runtime state in both directions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-posture-test-'));
process.env.CLEMENTINE_HOME = TMP_ROOT;
test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const { mobileAuthPosture } = await import('./mobile-auth-posture.js');

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prior: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    prior[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a stock daemon has sound posture with no PIN configured', () => {
  // Deliberate: pairing via QR is always available and is the stronger
  // credential, so requiring a PIN would add a setup step without adding
  // security. This is what makes one-tap setup possible.
  withEnv(
    { CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY: undefined },
    () => {
      const posture = mobileAuthPosture({ stateDir: path.join(TMP_ROOT, 'empty') });
      assert.equal(posture.ok, true);
      assert.deepEqual(posture.gaps, []);
    },
  );
});

test('disabling device binding is a BLOCKING gap', () => {
  withEnv({ CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY: 'false' }, () => {
    const posture = mobileAuthPosture({ stateDir: path.join(TMP_ROOT, 'empty') });
    assert.equal(posture.ok, false, 'without key binding a cookie alone would suffice again');
    const gap = posture.gaps.find((g) => g.code === 'DEVICE_BINDING_DISABLED');
    assert.ok(gap);
    assert.equal(gap!.blocking, true);
    assert.match(gap!.message, /CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY/);
  });
});

test('every gap message says what to do about it', () => {
  withEnv(
    { CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY: 'false' },
    () => {
      for (const gap of mobileAuthPosture({ stateDir: path.join(TMP_ROOT, 'empty') }).gaps) {
        assert.ok(gap.message.length > 40, `${gap.code} needs an actionable message`);
      }
    },
  );
});
