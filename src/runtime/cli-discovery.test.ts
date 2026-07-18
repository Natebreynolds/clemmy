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
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalClementineHome = process.env.CLEMENTINE_HOME;
const testHome = mkdtempSync(path.join(os.tmpdir(), 'clementine-cli-discovery-test-'));
process.env.CLEMENTINE_HOME = testHome;

const {
  resolveSafeCliProbe,
  _resetCltDetectionCache,
  fullScan,
  isDeveloperToolchainInstalled,
  probe,
} = await import('./cli-discovery.js');

after(() => {
  if (originalClementineHome === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = originalClementineHome;
  rmSync(testHome, { recursive: true, force: true });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function writeExecutable(file: string, body: string): void {
  writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`, 'utf-8');
  chmodSync(file, 0o755);
}

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

test('fullScan inventories PATH executables without running them', async () => {
  const binDir = path.join(testHome, 'stat-only-bin');
  const executionMarker = path.join(testHome, 'full-scan-executed');
  mkdirSync(binDir, { recursive: true });
  writeExecutable(
    path.join(binDir, 'side-effect-cli'),
    `printf 'executed' > ${shellQuote(executionMarker)}\nprintf 'side-effect-cli 1.0\\n'`,
  );

  const originalPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    const result = await fullScan({ concurrency: 1 });
    const entry = result.clis.find((cli) => cli.command === 'side-effect-cli');

    assert.equal(existsSync(executionMarker), false, 'a full scan must not execute PATH binaries');
    assert.ok(entry, 'stat-only executable should remain visible in the CLI inventory');
    assert.equal(entry.isLikelyCli, true);
    assert.equal(entry.probedAt, undefined);
    assert.equal(entry.version, undefined);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test('explicit probe runs in private scratch cwd, never process.cwd()', async () => {
  const fixtureDir = path.join(testHome, 'probe-fixture');
  const observationFile = path.join(testHome, 'probe-observation');
  const sentinelName = `relative-probe-sentinel-${process.pid}`;
  const processCwdSentinel = path.join(process.cwd(), sentinelName);
  const executable = path.join(fixtureDir, 'relative-writer-cli');
  mkdirSync(fixtureDir, { recursive: true });
  rmSync(processCwdSentinel, { force: true });

  writeExecutable(executable, [
    `printf 'sentinel' > ${shellQuote(sentinelName)}`,
    `{ printf '%s\\n' \"$PWD\"; test -f ${shellQuote(sentinelName)} && printf 'sentinel-present\\n'; } > ${shellQuote(observationFile)}`,
    `printf 'relative-writer-cli 1.0\\n'`,
  ].join('\n'));

  const originalPath = process.env.PATH;
  process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ''}`;
  const entry = await (async () => {
    try {
      return await probe('relative-writer-cli');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  })();
  const [probeCwd, sentinelState] = readFileSync(observationFile, 'utf-8').trim().split(/\r?\n/);

  assert.equal(entry?.version, 'relative-writer-cli 1.0');
  assert.equal(sentinelState, 'sentinel-present', 'fixture must observe its relative sentinel during execution');
  assert.notEqual(probeCwd, process.cwd());
  assert.match(path.basename(probeCwd), /^clementine-cli-probe-/);
  assert.equal(existsSync(processCwdSentinel), false, 'probe must not write relative files in daemon cwd');
  assert.equal(existsSync(probeCwd), false, 'probe scratch directory should be removed after execution');
});

test('discovery and probe share the version-manager environment under a minimal GUI PATH', async () => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'clementine-cli-vm-home-'));
  const vmBin = path.join(fakeHome, '.nvm', 'versions', 'node', 'v99.1.0', 'bin');
  const executable = path.join(vmBin, 'vm-only-cli');
  mkdirSync(vmBin, { recursive: true });
  writeExecutable(executable, `printf 'vm-only-cli 9.1.0\n'`);

  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  try {
    process.env.HOME = fakeHome;
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    const entry = await probe('vm-only-cli');
    assert.equal(entry?.path, executable, 'metadata discovery resolves the NVM executable');
    assert.equal(entry?.version, 'vm-only-cli 9.1.0', 'the same resolved executable launches successfully');
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
