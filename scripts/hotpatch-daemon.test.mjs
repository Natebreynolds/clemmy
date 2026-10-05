import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  SEALED_SHELL_PARTS,
  assertMutableInstallTarget,
  installBundledAssetDirectory,
  installDaemonPatch,
  resolveInstalledAppBundle,
  updaterStagingPaths,
  verifyGuardedSealedPatch,
} from './hotpatch-daemon.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDist = path.join(root, 'build');
  const targetDist = path.join(root, 'installed/dist');
  fs.mkdirSync(path.join(sourceDist, 'runtime'), { recursive: true });
  fs.mkdirSync(targetDist, { recursive: true });
  fs.writeFileSync(path.join(sourceDist, 'index.js'), 'new daemon');
  fs.writeFileSync(path.join(sourceDist, 'runtime/build-stamp.json'), JSON.stringify({ gitSha: 'a'.repeat(40), sourceFingerprint: 'b'.repeat(64) }));
  fs.writeFileSync(path.join(targetDist, 'index.js'), 'old daemon');
  fs.writeFileSync(path.join(root, 'installed/ui.html'), 'untouched UI');
  return { root, sourceDist, targetDist };
}

test('patch installs verified bytes, retains rollback, and leaves UI alone', t => {
  const f = fixture(t);
  const patched = installDaemonPatch(f);
  assert.equal(fs.readFileSync(path.join(f.targetDist, 'index.js'), 'utf8'), 'new daemon');
  assert.equal(fs.readFileSync(path.join(patched.backup, 'index.js'), 'utf8'), 'old daemon');
  assert.equal(fs.readFileSync(path.join(f.root, 'installed/ui.html'), 'utf8'), 'untouched UI');
});

test('copy refusal leaves the working installation in place', t => {
  const f = fixture(t);
  assert.throws(() => installDaemonPatch(f, { ...fs, cpSync() { throw new Error('copy denied'); } }), /copy denied/);
  assert.equal(fs.readFileSync(path.join(f.targetDist, 'index.js'), 'utf8'), 'old daemon');
});

test('incomplete staging never moves the working installation', t => {
  const f = fixture(t);
  assert.throws(() => installDaemonPatch(f, { ...fs, cpSync(source, dest, options) {
    fs.cpSync(source, dest, options);
    fs.writeFileSync(path.join(dest, 'index.js'), 'incomplete');
  } }), /incomplete/);
  assert.equal(fs.readFileSync(path.join(f.targetDist, 'index.js'), 'utf8'), 'old daemon');
});

test('a failed final rename restores the prior installation', t => {
  const f = fixture(t);
  let renames = 0;
  assert.throws(() => installDaemonPatch(f, { ...fs, renameSync(from, to) {
    renames += 1;
    if (renames === 2) throw new Error('swap denied');
    fs.renameSync(from, to);
  } }), /swap denied/);
  assert.equal(fs.readFileSync(path.join(f.targetDist, 'index.js'), 'utf8'), 'old daemon');
});

test('invalid source is rejected before staging', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.sourceDist, 'runtime/build-stamp.json'), '{}');
  assert.throws(() => installDaemonPatch(f), /stamp/);
  assert.equal(fs.readFileSync(path.join(f.targetDist, 'index.js'), 'utf8'), 'old daemon');
});

test('the newest existing bundle is patched, not a hardcoded /Applications path', () => {
  const versions = { '/Applications/Clementine.app': '3.18.6', '/Users/o/Applications/Clementine.app': '3.18.7' };
  const read = (bundle) => { if (!(bundle in versions)) throw new Error('missing'); return versions[bundle]; };
  assert.deepEqual(
    resolveInstalledAppBundle(['/Applications/Clementine.app', '/Users/o/Applications/Clementine.app', '/nowhere/Clementine.app'], read),
    { bundle: '/Users/o/Applications/Clementine.app', version: '3.18.7' },
  );
  assert.deepEqual(resolveInstalledAppBundle(['/Applications/Clementine.app'], read), { bundle: '/Applications/Clementine.app', version: '3.18.6' });
  assert.throws(() => resolveInstalledAppBundle(['/nowhere/Clementine.app'], read), /No installed Clementine bundle/);
});

test('shipped built-in skills are installed beside the daemon with a verified copy and a retained rollback', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotpatch-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'repo', 'builtin-skills');
  const target = path.join(root, 'daemon', 'builtin-skills');
  fs.mkdirSync(path.join(source, 'workspace-builder'), { recursive: true });
  fs.writeFileSync(path.join(source, 'workspace-builder', 'SKILL.md'), 'new skill');
  fs.mkdirSync(path.join(target, 'technical-content-marketing'), { recursive: true });
  fs.writeFileSync(path.join(target, 'technical-content-marketing', 'SKILL.md'), 'old skill');

  const result = installBundledAssetDirectory({ sourceDir: source, targetDir: target });
  assert.equal(fs.readFileSync(path.join(target, 'workspace-builder', 'SKILL.md'), 'utf8'), 'new skill');
  assert.equal(fs.existsSync(path.join(target, 'technical-content-marketing')), false, 'the installed set is exactly the shipped set');
  assert.ok(result.backup);
  assert.equal(fs.readFileSync(path.join(result.backup, 'technical-content-marketing', 'SKILL.md'), 'utf8'), 'old skill');
  assert.deepEqual(fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith('.assets-stage-')), []);

  const fresh = path.join(root, 'fresh-daemon', 'builtin-skills');
  fs.mkdirSync(path.dirname(fresh), { recursive: true });
  const first = installBundledAssetDirectory({ sourceDir: source, targetDir: fresh });
  assert.equal(first.backup, null, 'a bundle with no packaged skills yet has nothing to retain');
  assert.equal(fs.readFileSync(path.join(fresh, 'workspace-builder', 'SKILL.md'), 'utf8'), 'new skill');
});

// Only synthetic directories are used; subprocesses are forbidden in the CLI check.
const REFUSED_BUNDLE = /Refusing in-place installation inside an app bundle/;
const REFUSED_UNVERIFIABLE = /Cannot verify installation target/;

function forbiddenMutations() {
  const calls = [];
  const operations = { ...fs };
  for (const name of ['mkdtempSync', 'mkdirSync', 'cpSync', 'renameSync', 'rmSync', 'writeFileSync']) {
    operations[name] = () => { calls.push(name); throw new Error(`unexpected mutation: ${name}`); };
  }
  return { calls, operations };
}

function rejectsBothInstallers(f, target, expected = REFUSED_BUNDLE) {
  for (const install of [
    (ops) => installDaemonPatch({ sourceDist: f.sourceDist, targetDist: target }, ops),
    (ops) => installBundledAssetDirectory({ sourceDir: f.sourceDist, targetDir: target }, ops),
  ]) {
    const spy = forbiddenMutations();
    assert.throws(() => install(spy.operations), expected);
    assert.deepEqual(spy.calls, [], 'refusal must precede staging, copying, backup, and cleanup');
  }
}

test('both installers reject app resources regardless of seal health or presence', async t => {
  for (const seal of ['present', 'damaged', 'absent']) {
    await t.test(seal, t => {
      const f = fixture(t);
      const contents = path.join(f.root, 'Clementine.app', 'Contents');
      const target = path.join(contents, 'Resources', 'daemon', 'dist');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'index.js'), 'working app bytes');
      if (seal !== 'absent') {
        fs.mkdirSync(path.join(contents, '_CodeSignature'));
        fs.writeFileSync(path.join(contents, '_CodeSignature', 'CodeResources'), seal === 'present' ? 'synthetic seal marker' : 'invalid');
      }
      rejectsBothInstallers(f, target);
      assert.equal(fs.readFileSync(path.join(target, 'index.js'), 'utf8'), 'working app bytes');
      assert.deepEqual(fs.readdirSync(path.dirname(target)), ['dist']);
    });
  }
});

test('case-insensitive app/Contents spelling and absent target suffixes cannot bypass refusal', t => {
  const f = fixture(t);
  const parent = path.join(f.root, 'Clementine.APP', 'cOnTeNtS');
  fs.mkdirSync(parent, { recursive: true });
  rejectsBothInstallers(f, path.join(parent, 'Resources', 'missing', 'dist'));
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('aliases into bundle resources are rejected for existing and missing targets', t => {
  const f = fixture(t);
  const contents = path.join(f.root, 'Clementine.app', 'Contents');
  fs.mkdirSync(path.join(contents, 'dist'), { recursive: true });
  const alias = path.join(f.root, 'ordinary-looking-alias');
  fs.symlinkSync(contents, alias, 'dir');
  rejectsBothInstallers(f, path.join(alias, 'dist'));
  rejectsBothInstallers(f, path.join(alias, 'not-yet-created', 'dist'));
  assert.deepEqual(fs.readdirSync(contents), ['dist']);
});

test('a symlink out of an app does not allow replacing the sealed symlink entry', t => {
  const f = fixture(t);
  const contents = path.join(f.root, 'Clementine.app', 'Contents');
  fs.mkdirSync(contents, { recursive: true });
  const target = path.join(contents, 'dist');
  fs.symlinkSync(f.targetDist, target, 'dir');
  rejectsBothInstallers(f, target);
  assert.ok(fs.lstatSync(target).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(f.targetDist, 'index.js'), 'utf8'), 'old daemon');
});

test('dangling or looping target ancestors fail closed without staging', t => {
  const f = fixture(t);
  const dangling = path.join(f.root, 'dangling');
  fs.symlinkSync(path.join(f.root, 'Missing.app', 'Contents'), dangling, 'dir');
  rejectsBothInstallers(f, path.join(dangling, 'dist'), REFUSED_UNVERIFIABLE);
  const loop = path.join(f.root, 'loop');
  fs.symlinkSync(loop, loop, 'dir');
  rejectsBothInstallers(f, path.join(loop, 'dist'), REFUSED_UNVERIFIABLE);
});

test('ordinary non-bundle aliases and similar directory names retain verified installation', t => {
  const f = fixture(t);
  const ordinary = path.join(f.root, 'project.app-assets', 'Contents');
  fs.mkdirSync(path.join(ordinary, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(ordinary, 'dist', 'index.js'), 'old alias daemon');
  const alias = path.join(f.root, 'ordinary-alias');
  fs.symlinkSync(ordinary, alias, 'dir');
  const patched = installDaemonPatch({ sourceDist: f.sourceDist, targetDist: path.join(alias, 'dist') });
  assert.equal(fs.readFileSync(path.join(ordinary, 'dist', 'index.js'), 'utf8'), 'new daemon');
  assert.equal(fs.readFileSync(path.join(patched.backup, 'index.js'), 'utf8'), 'old alias daemon');
  const assets = installBundledAssetDirectory({ sourceDir: f.sourceDist, targetDir: path.join(alias, 'assets') });
  assert.equal(assets.backup, null);
  assert.equal(fs.readFileSync(path.join(ordinary, 'assets', 'index.js'), 'utf8'), 'new daemon');
});

test('tree CLI rejects a synthetic app before process checks, quit, staging, or relaunch', async t => {
  const f = fixture(t);
  const bundle = path.join(f.root, 'Clementine.app');
  const daemon = path.join(bundle, 'Contents', 'Resources', 'daemon');
  fs.mkdirSync(daemon, { recursive: true });
  fs.writeFileSync(path.join(daemon, 'package.json'), JSON.stringify({ version: '0.0.0' }));
  const moduleUrl = new URL('./hotpatch-installed-tree.mjs', import.meta.url);
  const source = fs.readFileSync(moduleUrl, 'utf8');
  // Evaluate the actual CLI body with inert subprocess bindings. This never
  // invokes a real process inspector, AppleScript, runtime, or installed app.
  const body = source.replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*$/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(moduleUrl.href));
  const helpers = await import('./hotpatch-daemon.mjs');
  const { Script } = await import('node:vm');
  const { createHash } = await import('node:crypto');
  const { fileURLToPath } = await import('node:url');
  const commands = [];
  const result = new Script(`(async () => { ${body}\n})()`).runInNewContext({
    ...helpers, fs, path, createHash, fileURLToPath,
    process: { argv: ['node', moduleUrl.pathname], env: { HOME: f.root, CLEMENTINE_APP_PATH: bundle }, exit(code) { throw new Error(`unexpected exit ${code}`); } },
    console: { log() {}, error() {} },
    execFileSync(command) { commands.push(command); throw new Error(`unexpected subprocess: ${command}`); },
  });
  await assert.rejects(result, REFUSED_BUNDLE);
  assert.deepEqual(commands, []);
  assert.deepEqual(fs.readdirSync(daemon), ['package.json']);
});

// A synthetic bundle with every native part, an updater config, and a runtime.
function guardedFixture(t) {
  const f = fixture(t);
  const app = path.join(f.root, 'Fixture.app');
  const home = path.join(f.root, 'home');
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.writeFileSync(path.join(app, rel), text);
  };
  write('Contents/MacOS/Clementine', 'native launcher');
  write('Contents/Info.plist', '<dict>\n  <key>CFBundleIdentifier</key>\n  <string>com.example.fixture</string>\n</dict>');
  write('Contents/Resources/app.asar', 'packaged shell');
  write('Contents/_CodeSignature/CodeResources', 'seal');
  write('Contents/Resources/app-update.yml', "provider: github\nupdaterCacheDirName: '@fixture-updater'\n");
  write('Contents/Resources/daemon/dist/index.js', 'old daemon');
  fs.mkdirSync(path.join(home, 'Library', 'Caches'), { recursive: true });
  const snapshot = Object.fromEntries(SEALED_SHELL_PARTS.map((rel) => [
    rel, createHash('sha256').update(fs.readFileSync(path.join(app, rel))).digest('hex'),
  ]));
  const prove = (overrides = {}) => verifyGuardedSealedPatch({
    app, shellSnapshot: snapshot, updaterStagingPaths: updaterStagingPaths({ app, home }), isRunning: () => false, ...overrides,
  });
  return { ...f, app, home, snapshot, prove, daemonDist: path.join(app, 'Contents/Resources/daemon/dist') };
}

test('a guarded patch replaces only the proven app runtime and keeps rollback', t => {
  const g = guardedFixture(t);
  const guarded = g.prove();
  const patched = installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded });
  assert.equal(fs.readFileSync(path.join(g.daemonDist, 'index.js'), 'utf8'), 'new daemon');
  assert.equal(fs.readFileSync(path.join(patched.backup, 'index.js'), 'utf8'), 'old daemon');
  fs.mkdirSync(path.join(g.app, 'Contents/Resources/daemon/apps/web'), { recursive: true });
  const assets = installBundledAssetDirectory({ sourceDir: g.sourceDist, targetDir: path.join(g.app, 'Contents/Resources/daemon/apps/web/dist'), guarded });
  assert.equal(assets.backup, null);
  assert.doesNotThrow(() => g.prove(), 'native parts are still the snapshot after the patch');
});

test('without a proof the same runtime target is still refused', t => {
  const g = guardedFixture(t);
  rejectsBothInstallers(g, g.daemonDist);
  const forged = Object.freeze({ app: g.app });
  assert.throws(() => assertMutableInstallTarget(g.daemonDist, forged), REFUSED_BUNDLE, 'a look-alike object is not a proof');
  assert.equal(fs.readFileSync(path.join(g.daemonDist, 'index.js'), 'utf8'), 'old daemon');
});

test('a proof never reaches native parts, other resources, or another bundle', t => {
  const g = guardedFixture(t);
  const guarded = g.prove();
  for (const rel of ['Contents/MacOS', 'Contents/Resources/app.asar.unpacked/dist', 'Contents/_CodeSignature', 'Contents/Resources', 'Contents/Resources/daemon']) {
    assert.throws(() => assertMutableInstallTarget(path.join(g.app, rel), guarded), REFUSED_BUNDLE, rel);
  }
  assert.throws(() => assertMutableInstallTarget(path.join(g.app, 'Contents/Resources/daemon-other/dist'), guarded), REFUSED_BUNDLE);
  const other = path.join(g.root, 'Other.app', 'Contents', 'Resources', 'daemon', 'dist');
  fs.mkdirSync(other, { recursive: true });
  assert.throws(() => assertMutableInstallTarget(other, guarded), REFUSED_BUNDLE);
  const alias = path.join(g.app, 'Contents/Resources/daemon/escape');
  fs.symlinkSync(path.join(g.app, 'Contents/MacOS'), alias, 'dir');
  assert.throws(() => assertMutableInstallTarget(path.join(alias, 'dist'), guarded), REFUSED_BUNDLE, 'a link out of the runtime resolves to native parts');
});

test('a guarded patch refuses a running app, a staged update, or a changed or missing snapshot', async t => {
  await t.test('running', t => {
    const g = guardedFixture(t);
    assert.throws(() => g.prove({ isRunning: () => true }), /still running/);
  });
  for (const [name, stage] of [
    ['downloaded update', (home) => fs.mkdirSync(path.join(home, 'Library/Caches/@fixture-updater/pending'), { recursive: true })],
    ['downloaded zip', (home) => { fs.mkdirSync(path.join(home, 'Library/Caches/@fixture-updater'), { recursive: true }); fs.writeFileSync(path.join(home, 'Library/Caches/@fixture-updater/update.zip'), 'zip'); }],
    ['installer state', (home) => { fs.mkdirSync(path.join(home, 'Library/Caches/com.example.fixture.ShipIt'), { recursive: true }); fs.writeFileSync(path.join(home, 'Library/Caches/com.example.fixture.ShipIt/ShipItState.plist'), 'state'); }],
    ['unpacked installer update', (home) => fs.mkdirSync(path.join(home, 'Library/Caches/com.example.fixture.ShipIt/update.abc123'), { recursive: true })],
  ]) {
    await t.test(name, t => {
      const g = guardedFixture(t);
      stage(g.home);
      assert.throws(() => g.prove(), /an update is staged to apply on quit/);
    });
  }
  for (const rel of SEALED_SHELL_PARTS) {
    await t.test(`changed ${rel}`, t => {
      const g = guardedFixture(t);
      fs.appendFileSync(path.join(g.app, rel), '\n<!-- replaced during quit -->');
      assert.throws(() => g.prove(), /changed since the pre-quit snapshot/);
    });
  }
  await t.test('incomplete snapshot', t => {
    const g = guardedFixture(t);
    const { ['Contents/Info.plist']: _omitted, ...partial } = g.snapshot;
    assert.throws(() => g.prove({ shellSnapshot: partial }), /no pre-quit snapshot of Contents\/Info\.plist/);
  });
  await t.test('unreadable updater config', t => {
    const g = guardedFixture(t);
    fs.rmSync(path.join(g.app, 'Contents/Resources/app-update.yml'));
    assert.throws(() => updaterStagingPaths({ app: g.app, home: g.home }), /no such file/);
    fs.writeFileSync(path.join(g.app, 'Contents/Resources/app-update.yml'), 'provider: github\n');
    assert.throws(() => updaterStagingPaths({ app: g.app, home: g.home }), /cannot read where/);
  });
});

test('tree CLI with a guarded snapshot refuses a changed shell before staging or relaunch', async t => {
  const g = guardedFixture(t);
  fs.writeFileSync(path.join(g.app, 'Contents/Resources/daemon/package.json'), JSON.stringify({ version: '0.0.0' }));
  const snapshotFile = path.join(g.root, 'native-before.json');
  fs.writeFileSync(snapshotFile, JSON.stringify({ ...g.snapshot, 'Contents/Resources/app.asar': '0'.repeat(64) }));
  const moduleUrl = new URL('./hotpatch-installed-tree.mjs', import.meta.url);
  const body = fs.readFileSync(moduleUrl, 'utf8').replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*$/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(moduleUrl.href));
  const helpers = await import('./hotpatch-daemon.mjs');
  const { Script } = await import('node:vm');
  const { fileURLToPath } = await import('node:url');
  const commands = [];
  const result = new Script(`(async () => { ${body}\n})()`).runInNewContext({
    ...helpers, fs, path, createHash, fileURLToPath,
    process: { argv: ['node', moduleUrl.pathname, '--no-relaunch', '--guarded-shell-snapshot', snapshotFile], env: { HOME: g.home, CLEMENTINE_APP_PATH: g.app }, exit(code) { throw new Error(`unexpected exit ${code}`); } },
    console: { log() {}, error() {} },
    execFileSync(command) {
      commands.push(command);
      if (command === 'pgrep') throw Object.assign(new Error('no match'), { status: 1 });
      throw new Error(`unexpected subprocess: ${command}`);
    },
  });
  await assert.rejects(result, /changed since the pre-quit snapshot/);
  assert.deepEqual([...new Set(commands)], ['pgrep'], 'only the process check runs; no quit, no relaunch');
  assert.deepEqual(fs.readdirSync(path.join(g.app, 'Contents/Resources/daemon')).sort(), ['dist', 'package.json']);
  assert.equal(fs.readFileSync(path.join(g.daemonDist, 'index.js'), 'utf8'), 'old daemon');
});
