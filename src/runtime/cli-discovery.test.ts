/**
 * Run: npx tsx --test src/runtime/cli-discovery.test.ts
 *
 * Regression test for the structural CLT-detection guard added in 0.4.32.
 * On a fresh macOS install with no Xcode/CLT, invoking any /usr/bin/<stub>
 * binary triggers Apple's "Install Command Line Developer Tools?" dialog —
 * which the user CAN'T dismiss programmatically. The 0.4.31 fix curated
 * a list of known stubs; 0.4.32 added a structural rule that skips ALL
 * /usr/bin/* probes when no toolchain backs them.
 *
 * This test asserts the structural rule fires regardless of whether a
 * binary is in the curated list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveSafeCliProbe, _resetCltDetectionCache, isDeveloperToolchainInstalled } = await import('./cli-discovery.js');

test('isDeveloperToolchainInstalled returns a boolean (file-stat only — never spawns)', () => {
  _resetCltDetectionCache();
  const result = isDeveloperToolchainInstalled();
  assert.equal(typeof result, 'boolean');
});

test('resolveSafeCliProbe with no CLT skips any /usr/bin path, even unknowns', (t) => {
  if (isDeveloperToolchainInstalled()) {
    // We can't simulate "no CLT" on a dev machine that has it. Skip
    // rather than flake — CI machines without Xcode/CLT exercise this.
    t.skip('CLT installed on this machine; structural skip path not exercised here');
    return;
  }
  // An unknown binary name that wouldn't be in either curated list.
  const result = resolveSafeCliProbe('definitely-not-a-real-cli-zzz', '/usr/bin/definitely-not-a-real-cli-zzz');
  assert.equal(result.skipped, true);
  if (result.skipped) {
    assert.match(result.reason, /Command Line Tools not installed|GUI or installer/i);
  }
});

test('resolveSafeCliProbe with CLT installed lets unknown /usr/bin paths through', (t) => {
  if (!isDeveloperToolchainInstalled()) {
    t.skip('CLT not installed on this machine; structural-allow path not exercised here');
    return;
  }
  // Same unknown name; with CLT present, /usr/bin probes are fine.
  const result = resolveSafeCliProbe('definitely-not-a-real-cli-zzz', '/usr/bin/definitely-not-a-real-cli-zzz');
  assert.equal(result.skipped, false);
});

test('resolveSafeCliProbe never skips paths outside /usr/bin regardless of CLT state', () => {
  // Homebrew-style paths must be probed even if /usr/bin stubs are blocked.
  for (const p of ['/opt/homebrew/bin/jq', '/usr/local/bin/git', '/Users/me/.local/bin/uv']) {
    const result = resolveSafeCliProbe('jq', p);
    assert.equal(result.skipped, false, `${p} should not be skipped`);
    if (!result.skipped) {
      assert.equal(result.path, p);
    }
  }
});

test('resolveSafeCliProbe skips wish even outside /usr/bin', () => {
  for (const [command, p] of [
    ['wish', '/opt/homebrew/bin/wish'],
    ['wish8.6', '/usr/local/bin/wish8.6'],
  ]) {
    const result = resolveSafeCliProbe(command, p);
    assert.equal(result.skipped, true, `${command} at ${p} should be skipped`);
    if (result.skipped) {
      assert.match(result.reason, /wish|GUI/i);
    }
  }
});

test('resolveSafeCliProbe skips known CLT stubs at /usr/bin', () => {
  // git is in the curated stub list. With or without CLT detection,
  // /usr/bin/git resolves to a backing path or returns {skipped: true}.
  // The result depends on whether CLT is installed; both outcomes are
  // valid as long as no spawn happens.
  const result = resolveSafeCliProbe('git', '/usr/bin/git');
  // Either:
  //   skipped=true (no CLT and no backing) OR
  //   skipped=false with path rewritten to the CLT backing dir.
  if (!result.skipped) {
    assert.match(result.path, /^\/(Library\/Developer\/CommandLineTools|Applications\/Xcode\.app)/);
  } else {
    assert.match(result.reason, /Command Line Tools|installer/i);
  }
});

test('SYSTEM_BINARIES set still catches wish at /usr/bin even when CLT installed', (t) => {
  // The 0.4.31 commit added `wish` to SYSTEM_BINARIES_THAT_LAUNCH_GUI_OR_INSTALLER
  // because Tcl/Tk's wish pops a GUI even without CLT. We want to keep
  // that guard active even on machines WITH CLT installed.
  if (!isDeveloperToolchainInstalled()) {
    // Structural rule already skips /usr/bin/wish. Specific guard not
    // exercised — that's fine, the symptom is still prevented.
    t.skip('Structural /usr/bin skip already covers this case on this machine');
    return;
  }
  const result = resolveSafeCliProbe('wish', '/usr/bin/wish');
  assert.equal(result.skipped, true);
});
