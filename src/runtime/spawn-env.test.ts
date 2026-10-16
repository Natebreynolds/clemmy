/**
 * Run: npx tsx --test src/runtime/spawn-env.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync,
  statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { augmentPath, mergedSpawnEnv, userDeclaredCliEnv, userManagedExecutableDirs } from './spawn-env.js';
import { childEnvValue } from './child-env-layers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function withCliEnvFile(work: (file: string, home: string) => void): void {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-cli-env-generation-'));
  const previousHome = process.env.CLEMENTINE_HOME;
  process.env.CLEMENTINE_HOME = home;
  mkdirSync(path.join(home, 'state'), { recursive: true });
  try { work(path.join(home, 'state', 'cli-env.json'), home); }
  finally {
    if (previousHome === undefined) delete process.env.CLEMENTINE_HOME; else process.env.CLEMENTINE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

function replaceCliEnvPreservingMtime(file: string, text: string): void {
  const before = statSync(file);
  const replacement = file + '.replacement';
  writeFileSync(replacement, text);
  utimesSync(replacement, before.atime, before.mtime);
  renameSync(replacement, file);
}

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

test('user-managed NVM, Volta, fnm, asdf, and mise bins join the canonical PATH', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-spawn-env-home-'));
  const dirs = [
    path.join(home, '.nvm', 'versions', 'node', 'v22.12.0', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
  ];
  try {
    for (const dir of dirs) mkdirSync(dir, { recursive: true });
    const discovered = userManagedExecutableDirs(home);
    for (const dir of dirs) assert.ok(discovered.includes(dir), `missing ${dir}`);

    const previousHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const augmented = augmentPath('/usr/bin:/bin').split(path.delimiter);
      for (const dir of dirs) assert.ok(augmented.includes(dir), `${dir} absent from augmented PATH`);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('mergedSpawnEnv isolates npm materialization from a broken user ~/.npm cache', () => {
  const clementineHome = mkdtempSync(path.join(os.tmpdir(), 'clem-spawn-npm-cache-'));
  const previousHome = process.env.CLEMENTINE_HOME;
  const previousUpper = process.env.NPM_CONFIG_CACHE;
  const previousLower = process.env.npm_config_cache;
  try {
    process.env.CLEMENTINE_HOME = clementineHome;
    delete process.env.NPM_CONFIG_CACHE;
    delete process.env.npm_config_cache;
    const env = mergedSpawnEnv();
    assert.equal(env.NPM_CONFIG_CACHE, path.join(clementineHome, 'cache', 'npm'));
    assert.doesNotMatch(env.NPM_CONFIG_CACHE, /\/\.npm(?:\/|$)/);
  } finally {
    if (previousHome === undefined) delete process.env.CLEMENTINE_HOME;
    else process.env.CLEMENTINE_HOME = previousHome;
    if (previousUpper === undefined) delete process.env.NPM_CONFIG_CACHE;
    else process.env.NPM_CONFIG_CACHE = previousUpper;
    if (previousLower === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = previousLower;
    rmSync(clementineHome, { recursive: true, force: true });
  }
});

test('a spawned package runner writes only to the Clementine-owned cache when ~/.npm is unwritable', () => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'clem-broken-user-npm-'));
  const clementineHome = mkdtempSync(path.join(os.tmpdir(), 'clem-owned-npm-'));
  const brokenUserCache = path.join(fakeHome, '.npm');
  const runner = path.join(fakeHome, 'fake-npx');
  mkdirSync(brokenUserCache, { recursive: true });
  chmodSync(brokenUserCache, 0o000);
  writeFileSync(runner, [
    '#!/bin/sh',
    'set -eu',
    'test -n "$NPM_CONFIG_CACHE"',
    'printf materialized > "$NPM_CONFIG_CACHE/materialized.ok"',
  ].join('\n'), 'utf8');
  chmodSync(runner, 0o755);

  const previousHome = process.env.HOME;
  const previousClementineHome = process.env.CLEMENTINE_HOME;
  const previousUpper = process.env.NPM_CONFIG_CACHE;
  const previousLower = process.env.npm_config_cache;
  try {
    process.env.HOME = fakeHome;
    process.env.CLEMENTINE_HOME = clementineHome;
    delete process.env.NPM_CONFIG_CACHE;
    delete process.env.npm_config_cache;
    const env = mergedSpawnEnv();
    execFileSync(runner, { env, stdio: 'pipe' });
    assert.equal(existsSync(path.join(clementineHome, 'cache', 'npm', 'materialized.ok')), true);
    assert.equal(existsSync(path.join(brokenUserCache, 'materialized.ok')), false);
  } finally {
    chmodSync(brokenUserCache, 0o700);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousClementineHome === undefined) delete process.env.CLEMENTINE_HOME;
    else process.env.CLEMENTINE_HOME = previousClementineHome;
    if (previousUpper === undefined) delete process.env.NPM_CONFIG_CACHE;
    else process.env.NPM_CONFIG_CACHE = previousUpper;
    if (previousLower === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = previousLower;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(clementineHome, { recursive: true, force: true });
  }
});

test('mergedSpawnEnv honors explicit npm cache overrides', () => {
  const previousUpper = process.env.NPM_CONFIG_CACHE;
  const previousLower = process.env.npm_config_cache;
  try {
    delete process.env.NPM_CONFIG_CACHE;
    process.env.npm_config_cache = '/custom/npm-cache';
    assert.equal(mergedSpawnEnv().npm_config_cache, '/custom/npm-cache');
    assert.equal(mergedSpawnEnv().NPM_CONFIG_CACHE, undefined);
    assert.equal(mergedSpawnEnv({ NPM_CONFIG_CACHE: '/per-call/npm-cache' }).NPM_CONFIG_CACHE, '/per-call/npm-cache');
    delete process.env.npm_config_cache;
    const lowercaseExtra = mergedSpawnEnv({ npm_config_cache: '/per-call/lowercase-cache' });
    assert.equal(lowercaseExtra.npm_config_cache, '/per-call/lowercase-cache');
    assert.equal(lowercaseExtra.NPM_CONFIG_CACHE, undefined);
  } finally {
    if (previousUpper === undefined) delete process.env.NPM_CONFIG_CACHE;
    else process.env.NPM_CONFIG_CACHE = previousUpper;
    if (previousLower === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = previousLower;
  }
});

// ─── Carrier pin: one environment at EVERY CLI seam ──────────────────────────
//
// A capability gate must run a CLI in the same environment as the executor it
// gates. Discovery decided `sf` existed and the model could run it, but the
// workflow readiness probe spawned with a raw `process.env` — so on a packaged
// .app launch (minimal inherited PATH) the probe could resolve a different
// binary, or none, and report a reachable account as missing. The user is then
// sent to repair something that was never broken.
//
// Two categories, deliberately different:
//   * CREDENTIAL-BEARING seams (discovery, execution, readiness, dynamic tools)
//     must share mergedSpawnEnv so they agree on what is reachable.
//   * SANDBOXED COMPUTE probes (code certification) scrub the environment on
//     purpose — a syntax check on user-authored code must not inherit secrets.
//     They still need augmentPath so the interpreter itself resolves.
//
// This is a sweep, not a single-case regression: the class recurs whenever a
// NEW seam is added, so the rule is enforced against the tree.
test('every credential-bearing CLI seam spawns through mergedSpawnEnv', () => {
  const CREDENTIAL_SPAWN_SEAMS = [
    'src/tools/computer-tools.ts',
    'src/runtime/cli-discovery.ts',
  ];
  const offenders: string[] = [];
  for (const file of CREDENTIAL_SPAWN_SEAMS) {
    const absolute = path.join(HERE, '..', '..', file);
    if (!existsSync(absolute)) {
      offenders.push(`${file}: missing — update this pin if the seam moved`);
      continue;
    }
    const source = readFileSync(absolute, 'utf-8');
    if (!/mergedSpawnEnv\s*\(/.test(source)) {
      offenders.push(`${file}: spawns a CLI without mergedSpawnEnv()`);
      continue;
    }
    // A seam that still hands a child the ambient environment defeats the
    // shared PATH even when it imports the helper elsewhere in the file.
    if (/env:\s*\{\s*\.\.\.process\.env/.test(source)) {
      offenders.push(`${file}: still spreads raw process.env into a child`);
    }
  }
  assert.deepEqual(offenders, [], `CLI seams must share one spawn environment:\n${offenders.join('\n')}`);
});

test('inventory and workflow readiness seams remain process-free', () => {
  // These used to launch installed scripts and account-readiness probes. Both
  // execution paths were retired because neither owned exact logical/physical
  // call authority. Do not force an unused mergedSpawnEnv import merely to
  // satisfy the credential-spawn sweep; pin the stronger property instead.
  const PROCESS_FREE_SEAMS = [
    'src/tools/dynamic-tools.ts',
    'src/execution/workflow-run-readiness.ts',
  ];
  const offenders: string[] = [];
  for (const file of PROCESS_FREE_SEAMS) {
    const absolute = path.join(HERE, '..', '..', file);
    if (!existsSync(absolute)) {
      offenders.push(`${file}: missing — update this pin if the seam moved`);
      continue;
    }
    const source = readFileSync(absolute, 'utf-8');
    if (
      /from\s+['"]node:child_process['"]/.test(source)
      || /require\(\s*['"]node:child_process['"]\s*\)/.test(source)
      || /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/.test(source)
    ) {
      offenders.push(`${file}: inventory/readiness seam regained child-process execution`);
    }
  }
  assert.deepEqual(offenders, [], `process-free seams must not launch children:\n${offenders.join('\n')}`);
});

test('the sandboxed code-certification probe scrubs its env but still resolves via augmentPath', () => {
  const source = readFileSync(
    path.join(HERE, '..', 'execution', 'workflow-code-certification.ts'),
    'utf-8',
  );
  assert.match(source, /augmentPath\s*\(/, 'interpreter resolution must use the shared PATH augmentation');
  assert.match(source, /scrubbedChildEnv\s*\(/, 'a syntax check on user code must not inherit the ambient environment');
  assert.doesNotMatch(
    source,
    /mergedSpawnEnv\s*\(/,
    'certification must stay scrubbed — mergedSpawnEnv would hand user-authored code the full environment',
  );
});

// ─── User-declared CLI environment ───────────────────────────────────────────
//
// A global CLI's credentials often depend on environment (which profile, which
// config, which credential store), and Clem had no way to set any of it: the
// daemon's .env is read through getEnv() and never reaches process.env, so it
// never reached a child CLI. Handing children the whole daemon environment is
// not an option — it carries Clementine's own secrets — so the surface is
// explicit and separate.
test('user-declared cli-env reaches spawned CLIs, but never overrides PATH', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-cli-env-'));
  const previousHome = process.env.CLEMENTINE_HOME;
  process.env.CLEMENTINE_HOME = home;
  try {
    mkdirSync(path.join(home, 'state'), { recursive: true });
    writeFileSync(
      path.join(home, 'state', 'cli-env.json'),
      JSON.stringify({
        SOME_CLI_PROFILE: 'work',
        SOME_CLI_NUMERIC: 7,
        PATH: '/attacker/bin',
        'not a valid key': 'ignored',
      }),
      'utf-8',
    );
    const env = mergedSpawnEnv();
    assert.equal(env.SOME_CLI_PROFILE, 'work');
    assert.equal(env.SOME_CLI_NUMERIC, '7', 'scalars are coerced so config stays forgiving');
    assert.equal(env['not a valid key'], undefined);
    assert.doesNotMatch(
      env.PATH ?? '',
      /^\/attacker\/bin/,
      'PATH is refused here — every CLI seam depends on the augmentation',
    );
    // An explicit per-call override still wins over a user declaration.
    assert.equal(mergedSpawnEnv({ SOME_CLI_PROFILE: 'override' }).SOME_CLI_PROFILE, 'override');
  } finally {
    if (previousHome === undefined) delete process.env.CLEMENTINE_HOME;
    else process.env.CLEMENTINE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a malformed cli-env file is ignored rather than breaking every CLI spawn', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-cli-env-bad-'));
  const previousHome = process.env.CLEMENTINE_HOME;
  process.env.CLEMENTINE_HOME = home;
  try {
    mkdirSync(path.join(home, 'state'), { recursive: true });
    writeFileSync(path.join(home, 'state', 'cli-env.json'), '{ this is not json', 'utf-8');
    const env = mergedSpawnEnv();
    assert.ok(env.PATH, 'a broken config must not take the spawn environment down with it');
  } finally {
    if (previousHome === undefined) delete process.env.CLEMENTINE_HOME;
    else process.env.CLEMENTINE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('Windows CLI declarations and per-call layers win across casing before npm defaults', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-windows-env-layers-'));
  const previousHome = process.env.CLEMENTINE_HOME;
  process.env.CLEMENTINE_HOME = home;
  const inherited = Object.freeze({ PATH: 'inherited-path', CLI_PROFILE: 'inherited-profile',
    NPM_CONFIG_CACHE: 'inherited-cache' });
  try {
    mkdirSync(path.join(home, 'state'), { recursive: true });
    writeFileSync(path.join(home, 'state', 'cli-env.json'), JSON.stringify({
      cli_profile: 'declared-profile', npm_config_cache: '', Path: 'refused-user-path',
    }));
    const declared = mergedSpawnEnv({}, { inherited, platform: 'win32' });
    assert.equal(childEnvValue(declared, 'CLI_PROFILE', 'win32'), 'declared-profile');
    assert.equal(childEnvValue(declared, 'NPM_CONFIG_CACHE', 'win32'), '');
    assert.equal(declared.NPM_CONFIG_CACHE, undefined, 'no synthesized uppercase cache shadows an explicit blank');
    assert.notEqual(declared.PATH, 'refused-user-path');
    const extra = Object.freeze({ Cli_Profile: 'per-call-profile', pAtH: '', npm_CONFIG_CACHE: 'per-call-cache' });
    const effective = mergedSpawnEnv(extra, { inherited, platform: 'win32' });
    assert.equal(childEnvValue(effective, 'CLI_PROFILE', 'win32'), 'per-call-profile');
    assert.equal(childEnvValue(effective, 'NPM_CONFIG_CACHE', 'win32'), 'per-call-cache');
    assert.equal(effective.PATH, '', 'explicit empty PATH is kept verbatim');
    assert.equal(new Set(Object.keys(effective).map(key => key.toUpperCase())).size, Object.keys(effective).length);
    assert.equal(inherited.PATH, 'inherited-path');
    assert.equal(extra.pAtH, '');
  } finally {
    if (previousHome === undefined) delete process.env.CLEMENTINE_HOME; else process.env.CLEMENTINE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('an explicitly empty user npm cache setting receives no default on POSIX', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-empty-npm-env-'));
  const previousHome = process.env.CLEMENTINE_HOME;
  process.env.CLEMENTINE_HOME = home;
  try {
    mkdirSync(path.join(home, 'state'), { recursive: true });
    writeFileSync(path.join(home, 'state', 'cli-env.json'), JSON.stringify({ npm_config_cache: '' }));
    const env = mergedSpawnEnv({ PATH: 'literal-per-call-path' }, { inherited: {}, platform: 'linux' });
    assert.equal(env.npm_config_cache, '');
    assert.equal(env.NPM_CONFIG_CACHE, undefined);
    assert.equal(env.PATH, 'literal-per-call-path');
  } finally {
    if (previousHome === undefined) delete process.env.CLEMENTINE_HOME; else process.env.CLEMENTINE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI declarations refresh after same-sized atomic replacement preserving mtime', () => withCliEnvFile(file => {
  writeFileSync(file, JSON.stringify({ CLI_PROFILE: 'profile-a' }));
  const fixed = new Date('2026-10-16T01:00:00.000Z');
  utimesSync(file, fixed, fixed);
  const before = statSync(file);
  assert.deepEqual(userDeclaredCliEnv(), { CLI_PROFILE: 'profile-a' });
  replaceCliEnvPreservingMtime(file, JSON.stringify({ CLI_PROFILE: 'profile-b' }));
  assert.equal(statSync(file).size, before.size);
  assert.equal(statSync(file).mtimeMs, before.mtimeMs);
  assert.deepEqual(userDeclaredCliEnv(), { CLI_PROFILE: 'profile-b' });
  assert.equal(mergedSpawnEnv({}, { inherited: {}, platform: 'win32' }).CLI_PROFILE, 'profile-b');
}));

test('CLI declarations refresh after in-place edit with restored mtime', () => withCliEnvFile(file => {
  writeFileSync(file, JSON.stringify({ CLI_PROFILE: 'profile-a' }));
  const fixed = new Date('2026-10-16T01:00:00.000Z');
  utimesSync(file, fixed, fixed);
  const before = statSync(file);
  assert.equal(userDeclaredCliEnv().CLI_PROFILE, 'profile-a');
  writeFileSync(file, JSON.stringify({ CLI_PROFILE: 'profile-b' }));
  utimesSync(file, before.atime, before.mtime);
  assert.equal(statSync(file).size, before.size);
  assert.equal(statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(userDeclaredCliEnv().CLI_PROFILE, 'profile-b');
}));

test('CLI declaration warm cache returns isolated own-key copies without rereading bytes', t => withCliEnvFile(file => {
  writeFileSync(file, '{"CLI_PROFILE":"controlled","NUMBER":7,"BOOL":false,"__proto__":"literal",'
    + '"constructor":"literal-constructor","Path":"refused","nested":{},"bad key":"refused"}');
  const reads = t.mock.method(fs, 'readFileSync');
  syncBuiltinESMExports();
  try {
    const first = userDeclaredCliEnv();
    assert.equal(reads.mock.calls.length, 1);
    assert.equal(first.CLI_PROFILE, 'controlled');
    assert.equal(first.NUMBER, '7');
    assert.equal(first.BOOL, 'false');
    assert.equal(Object.getPrototypeOf(first), Object.prototype);
    assert.equal(Object.hasOwn(first, '__proto__'), true);
    assert.equal(first.__proto__, 'literal');
    assert.equal(first.constructor, 'literal-constructor');
    first.CLI_PROFILE = 'caller-mutation';
    first.Path = 'caller-path';
    delete first.NUMBER;
    const next = userDeclaredCliEnv();
    assert.notEqual(next, first);
    assert.equal(next.CLI_PROFILE, 'controlled');
    assert.equal(next.NUMBER, '7');
    assert.equal(next.Path, undefined);
    assert.equal(next.nested, undefined);
    assert.equal(next['bad key'], undefined);
    assert.equal(next.__proto__, 'literal');
    assert.equal(reads.mock.calls.length, 1, 'unchanged generation reuses sanitized data, not the caller object');
  } finally { reads.mock.restore(); syncBuiltinESMExports(); }
}));

test('CLI declarations discard corrupt or nonobject replacements and recover without old cached values', () => withCliEnvFile(file => {
  const first = JSON.stringify({ CLI_PROFILE: 'profile-a' });
  writeFileSync(file, first);
  const fixed = new Date('2026-10-16T01:00:00.000Z');
  utimesSync(file, fixed, fixed);
  assert.equal(userDeclaredCliEnv().CLI_PROFILE, 'profile-a');
  for (const invalid of ['{'.padEnd(first.length, ' '), '[]', 'null', 'false', '"not an env object"']) {
    replaceCliEnvPreservingMtime(file, invalid);
    assert.deepEqual(userDeclaredCliEnv(), {});
    replaceCliEnvPreservingMtime(file, JSON.stringify({ CLI_PROFILE: 'profile-b' }));
    assert.deepEqual(userDeclaredCliEnv(), { CLI_PROFILE: 'profile-b' });
  }
}));

test('CLI declaration failed read evicts prior settings and permits same-generation recovery', t => withCliEnvFile(file => {
  writeFileSync(file, JSON.stringify({ CLI_PROFILE: 'profile-a' }));
  assert.equal(userDeclaredCliEnv().CLI_PROFILE, 'profile-a');
  replaceCliEnvPreservingMtime(file, JSON.stringify({ CLI_PROFILE: 'profile-b' }));
  const originalRead = fs.readFileSync;
  let refused = false;
  const reads = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    if (!refused && (typeof args[0] === 'number' || args[0] === file)) {
      refused = true;
      throw Object.assign(new Error('controlled read refusal'), { code: 'EACCES' });
    }
    return Reflect.apply(originalRead, fs, args);
  });
  syncBuiltinESMExports();
  try { assert.deepEqual(userDeclaredCliEnv(), {}); assert.equal(refused, true); }
  finally { reads.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(userDeclaredCliEnv(), { CLI_PROFILE: 'profile-b' });
}));

test('CLI declaration absence, nonfile and stat failure evict cache and recover', t => withCliEnvFile(file => {
  writeFileSync(file, JSON.stringify({ CLI_PROFILE: 'profile-a' }));
  const fixed = new Date('2026-10-16T01:00:00.000Z');
  utimesSync(file, fixed, fixed);
  assert.equal(userDeclaredCliEnv().CLI_PROFILE, 'profile-a');
  unlinkSync(file);
  assert.deepEqual(userDeclaredCliEnv(), {});
  mkdirSync(file);
  utimesSync(file, fixed, fixed);
  assert.deepEqual(userDeclaredCliEnv(), {});
  rmSync(file, { recursive: true });
  writeFileSync(file, JSON.stringify({ CLI_PROFILE: 'profile-b' }));
  utimesSync(file, fixed, fixed);
  assert.equal(userDeclaredCliEnv().CLI_PROFILE, 'profile-b');
  const originalStat = fs.statSync;
  const stats = t.mock.method(fs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
    if (args[0] === file) throw Object.assign(new Error('controlled stat refusal'), { code: 'EACCES' });
    return Reflect.apply(originalStat, fs, args);
  });
  syncBuiltinESMExports();
  try { assert.deepEqual(userDeclaredCliEnv(), {}); }
  finally { stats.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(userDeclaredCliEnv(), { CLI_PROFILE: 'profile-b' });
}));

for (const phase of ['before-open', 'during-read'] as const) {
  test(`CLI declaration ${phase} replacement cannot publish bytes under another generation`, t => withCliEnvFile(file => {
    writeFileSync(file, JSON.stringify({ CLI_PROFILE: 'profile-a' }));
    let replaced = false;
    const originalStat = fs.statSync;
    const originalRead = fs.readFileSync;
    if (phase === 'before-open') t.mock.method(fs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
      const stat = Reflect.apply(originalStat, fs, args);
      if (!replaced && args[0] === file) {
        replaced = true;
        replaceCliEnvPreservingMtime(file, JSON.stringify({ CLI_PROFILE: 'profile-b' }));
      }
      return stat;
    });
    else t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      const text = Reflect.apply(originalRead, fs, args);
      if (!replaced && (typeof args[0] === 'number' || args[0] === file)) {
        replaced = true;
        replaceCliEnvPreservingMtime(file, JSON.stringify({ CLI_PROFILE: 'profile-b' }));
      }
      return text;
    });
    syncBuiltinESMExports();
    try { assert.deepEqual(userDeclaredCliEnv(), {}); assert.equal(replaced, true); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.deepEqual(userDeclaredCliEnv(), { CLI_PROFILE: 'profile-b' });
  }));
}

test('CLI declaration generations stay isolated when the Clementine home changes', () => withCliEnvFile((file, firstHome) => {
  writeFileSync(file, JSON.stringify({ CLI_PROFILE: 'profile-a' }));
  const fixed = new Date('2026-10-16T01:00:00.000Z');
  utimesSync(file, fixed, fixed);
  assert.equal(userDeclaredCliEnv().CLI_PROFILE, 'profile-a');
  const secondHome = mkdtempSync(path.join(os.tmpdir(), 'clem-cli-env-other-home-'));
  try {
    mkdirSync(path.join(secondHome, 'state'), { recursive: true });
    const secondFile = path.join(secondHome, 'state', 'cli-env.json');
    writeFileSync(secondFile, JSON.stringify({ CLI_PROFILE: 'profile-b' }));
    utimesSync(secondFile, fixed, fixed);
    process.env.CLEMENTINE_HOME = secondHome;
    assert.equal(userDeclaredCliEnv().CLI_PROFILE, 'profile-b');
    process.env.CLEMENTINE_HOME = firstHome;
    assert.equal(userDeclaredCliEnv().CLI_PROFILE, 'profile-a');
  } finally { process.env.CLEMENTINE_HOME = firstHome; rmSync(secondHome, { recursive: true, force: true }); }
}));

test('CLI declaration coherent reads preserve user symlink support', { skip: process.platform === 'win32' }, () => withCliEnvFile(file => {
  const target = file + '.target';
  writeFileSync(target, JSON.stringify({ CLI_PROFILE: 'profile-a' }));
  symlinkSync(target, file);
  assert.equal(userDeclaredCliEnv().CLI_PROFILE, 'profile-a');
  replaceCliEnvPreservingMtime(target, JSON.stringify({ CLI_PROFILE: 'profile-b' }));
  assert.equal(userDeclaredCliEnv().CLI_PROFILE, 'profile-b');
}));

test("nvm's default install leads, not the highest-numbered one", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-spawn-nvm-default-'));
  const v22 = path.join(home, '.nvm', 'versions', 'node', 'v22.12.0', 'bin');
  const v24 = path.join(home, '.nvm', 'versions', 'node', 'v24.5.0', 'bin');
  try {
    mkdirSync(v22, { recursive: true });
    mkdirSync(v24, { recursive: true });
    mkdirSync(path.join(home, '.nvm', 'alias', 'lts'), { recursive: true });
    // No default: newest first, as before.
    let found = userManagedExecutableDirs(home);
    assert.ok(found.indexOf(v24) < found.indexOf(v22));
    // A major-version default ("22") picks that install first; v24 stays reachable after it.
    writeFileSync(path.join(home, '.nvm', 'alias', 'default'), '22\n');
    found = userManagedExecutableDirs(home);
    assert.ok(found.indexOf(v22) < found.indexOf(v24), 'the default install leads');
    assert.ok(found.includes(v24));
    // An alias chain resolves too.
    writeFileSync(path.join(home, '.nvm', 'alias', 'default'), 'lts/iron\n');
    writeFileSync(path.join(home, '.nvm', 'alias', 'lts', 'iron'), 'v22.12.0\n');
    found = userManagedExecutableDirs(home);
    assert.ok(found.indexOf(v22) < found.indexOf(v24));
    // A default naming no installed version changes nothing.
    writeFileSync(path.join(home, '.nvm', 'alias', 'default'), '18\n');
    found = userManagedExecutableDirs(home);
    assert.ok(found.indexOf(v24) < found.indexOf(v22));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
