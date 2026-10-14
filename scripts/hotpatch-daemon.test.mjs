import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import {
  SEALED_SHELL_PARTS,
  captureAppliedUpdateEvidence,
  captureNoActiveUpdateEvidence,
  isInstalledAppRunning,
  isUpdaterHelperRunning,
  assertMutableInstallTarget,
  installBundledAssetDirectory,
  installDaemonPatch,
  resolveInstalledAppBundle,
  updaterStagingPaths,
  verifyGuardedSealedPatch,
} from './hotpatch-daemon.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-patch-')));
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
    app, home, shellSnapshot: snapshot, isRunning: () => false, isUpdaterRunning: () => false, ...overrides,
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
      if (command === '/bin/ps') return '';
      throw new Error(`unexpected subprocess: ${command}`);
    },
  });
  await assert.rejects(result, /changed since the pre-quit snapshot/);
  assert.deepEqual([...new Set(commands)], ['/bin/ps'], 'only process checks run; no quit, no relaunch');
  assert.deepEqual(fs.readdirSync(path.join(g.app, 'Contents/Resources/daemon')).sort(), ['dist', 'package.json']);
  assert.equal(fs.readFileSync(path.join(g.daemonDist, 'index.js'), 'utf8'), 'old daemon');
});

// Stored synthetic ZIP entries exercise the real parser without an installer,
// an installed app, ZIP subprocesses, credentials, or the owner's home.
function nativeZip(g, entries = SEALED_SHELL_PARTS, compressed = false) {
  const local = []; const central = []; let offset = 0;
  for (const rel of entries) {
    const name = Buffer.from(`Fixture.app/${rel}`);
    const bytes = fs.readFileSync(path.join(g.app, rel));
    const stored = compressed ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(compressed ? 8 : 0, 8); header.writeUInt32LE(stored.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, stored);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE((3 << 8) | 20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(compressed ? 8 : 0, 10); directory.writeUInt32LE(stored.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + stored.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function appliedUpdateFixture(t) {
  const g = guardedFixture(t);
  fs.writeFileSync(path.join(g.app, 'Contents/Info.plist'), '<dict><key>CFBundleIdentifier</key><string>com.example.fixture</string><key>CFBundleShortVersionString</key><string>3.18.35</string></dict>');
  g.snapshot = Object.fromEntries(SEALED_SHELL_PARTS.map(rel => [rel, createHash('sha256').update(fs.readFileSync(path.join(g.app, rel))).digest('hex')]));
  g.cache = path.join(g.home, 'Library/Caches/@fixture-updater');
  g.shipIt = path.join(g.home, 'Library/Caches/com.example.fixture.ShipIt');
  g.archiveName = 'Fixture-3.18.35-arm64-mac.zip';
  g.writeArchives = (bytes = nativeZip(g), held = false) => {
    for (const suffix of held ? ['', '.held-latest'] : ['']) {
      const pending = path.join(g.cache, `pending${suffix}`);
      fs.mkdirSync(pending, { recursive: true });
      fs.writeFileSync(path.join(pending, g.archiveName), bytes);
      fs.writeFileSync(path.join(g.cache, `update.zip${suffix}`), bytes);
      fs.writeFileSync(path.join(pending, 'update-info.json'), JSON.stringify({ fileName: g.archiveName, sha512: createHash('sha512').update(bytes).digest('base64'), isAdminRightsRequired: false }));
    }
  };
  g.writeArchives();
  fs.mkdirSync(g.shipIt, { recursive: true });
  g.state = { launchAfterInstallation: true, updateBundleURL: pathToFileURL(path.join(g.shipIt, 'update.ABC123/Fixture.app')).href + '/', useUpdateBundleName: true, bundleIdentifier: 'com.example.fixture', targetBundleURL: pathToFileURL(g.app).href + '/' };
  g.statePath = path.join(g.shipIt, 'ShipItState.plist');
  fs.writeFileSync(g.statePath, JSON.stringify(g.state));
  g.capture = (commands = () => {}) => captureAppliedUpdateEvidence({ app: g.app, home: g.home }, fs, commands);
  g.proveApplied = (evidence, overrides = {}) => verifyGuardedSealedPatch({
    app: g.app, home: g.home, shellSnapshot: g.snapshot, appliedUpdateEvidence: evidence,
    isRunning: () => false, isUpdaterRunning: () => false, verifyNativeSignature: () => {}, ...overrides,
  });
  return g;
}

test('verified applied native update permits retained consumed state and active/held archives without changing them', t => {
  const g = appliedUpdateFixture(t); g.writeArchives(nativeZip(g, SEALED_SHELL_PARTS, true), true);
  fs.writeFileSync(path.join(g.cache, 'current.blockmap'), 'retained differential data');
  const signatureCommands = [];
  const evidence = g.capture((command, args) => signatureCommands.push([command, args]));
  assert.deepEqual(signatureCommands, [['/usr/bin/codesign', ['--verify', '--deep', '--strict', g.app]]]);
  let signatures = 0;
  const guarded = g.proveApplied(evidence, { verifyNativeSignature: () => { signatures += 1; } });
  const patched = installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded });
  assert.equal(fs.readFileSync(path.join(patched.backup, 'index.js'), 'utf8'), 'old daemon');
  assert.doesNotThrow(() => g.proveApplied(evidence, { priorProof: guarded, verifyNativeSignature: () => { throw new Error('post-patch full seal is intentionally changed'); } }));
  assert.equal(signatures, 1);
  assert.deepEqual(g.capture(), evidence, 'all cache, request and native bytes remain identical');
});

test('matching retained archives alone cannot bypass a failed complete native signature or forge a prior proof', t => {
  const g = appliedUpdateFixture(t); const evidence = g.capture();
  assert.throws(() => g.capture(() => { throw new Error('signature failed'); }), /signature failed/);
  assert.throws(() => g.proveApplied(evidence, { verifyNativeSignature: () => { throw new Error('signature failed'); } }), /signature failed/);
  assert.throws(() => g.proveApplied(evidence, { priorProof: { app: g.app, appliedEvidenceDigest: 'forged' } }), /no matching initial/);
});

test('every proof discovers newly queued installer state instead of reusing an earlier path list', async t => {
  for (const entry of ['update.NEW123', 'pending-update', 'unexpected']) await t.test(entry, t => {
    const g = appliedUpdateFixture(t); const evidence = g.capture(); const guarded = g.proveApplied(evidence);
    fs.mkdirSync(path.join(g.shipIt, entry));
    assert.throws(() => g.proveApplied(evidence, { priorProof: guarded, updaterStagingPaths: [] }), /unknown or unpacked installer/);
  });
  await t.test('same consumed staging path reappears', t => {
    const g = appliedUpdateFixture(t); const evidence = g.capture();
    fs.mkdirSync(path.join(g.shipIt, 'update.ABC123'), { recursive: true });
    assert.throws(() => g.proveApplied(evidence), /unknown or unpacked installer/);
  });
});

test('retained update classification rejects unknown, malformed, changed or linked evidence', async t => {
  const cases = [
    ['unknown cache file', g => fs.writeFileSync(path.join(g.cache, 'another.zip'), 'unknown')],
    ['unpaired held archive', g => fs.writeFileSync(path.join(g.cache, 'update.zip.held-latest'), nativeZip(g))],
    ['unexpected pending file', g => fs.writeFileSync(path.join(g.cache, 'pending/partial.tmp'), 'partial')],
    ['changed active archive', g => fs.appendFileSync(path.join(g.cache, 'update.zip'), 'changed')],
    ['malformed metadata', g => fs.writeFileSync(path.join(g.cache, 'pending/update-info.json'), '{}')],
    ['duplicate metadata key', g => { const p = path.join(g.cache, 'pending/update-info.json'); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('{', '{"fileName":"other.zip",')); }],
    ['unknown state key', g => fs.writeFileSync(g.statePath, JSON.stringify({ ...g.state, unexpected: true }))],
    ['different installer target', g => fs.writeFileSync(g.statePath, JSON.stringify({ ...g.state, targetBundleURL: pathToFileURL(path.join(g.root, 'Other.app')).href }))],
    ['different installer staging parent', g => fs.writeFileSync(g.statePath, JSON.stringify({ ...g.state, updateBundleURL: pathToFileURL(path.join(g.root, 'update.ABC123/Fixture.app')).href }))],
    ['remote installer URL', g => fs.writeFileSync(g.statePath, JSON.stringify({ ...g.state, targetBundleURL: 'file://remote/Fixture.app' }))],
    ['malformed JSON state', g => fs.writeFileSync(g.statePath, '{')],
    ['duplicate state key', g => fs.writeFileSync(g.statePath, JSON.stringify(g.state).replace('{', '{"bundleIdentifier":"com.other.bundle",'))],
    ['noncanonical state URL', g => fs.writeFileSync(g.statePath, JSON.stringify({ ...g.state, targetBundleURL: g.state.targetBundleURL.replace('/Fixture.app/', '/x/../Fixture.app/') }))],
    ['changed config', g => fs.appendFileSync(path.join(g.app, 'Contents/Resources/app-update.yml'), '# drift\n')],
    ['changed native bytes', g => fs.appendFileSync(path.join(g.app, 'Contents/Resources/app.asar'), 'changed')],
    ['symlinked state', g => { const moved = path.join(g.root, 'state-copy'); fs.renameSync(g.statePath, moved); fs.symlinkSync(moved, g.statePath); }],
    ['symlinked pending ancestor', g => { const pending = path.join(g.cache, 'pending'); const moved = path.join(g.root, 'pending-copy'); fs.renameSync(pending, moved); fs.symlinkSync(moved, pending); }],
  ];
  for (const [name, change] of cases) await t.test(name, t => {
    const g = appliedUpdateFixture(t); const evidence = g.capture(); change(g);
    assert.throws(() => g.proveApplied(evidence));
    assert.equal(fs.readFileSync(path.join(g.daemonDist, 'index.js'), 'utf8'), 'old daemon');
  });
});

test('held backup content, native ZIP paths and archived version must independently match the applied shell', async t => {
  await t.test('held backup mismatch', t => {
    const g = appliedUpdateFixture(t); g.writeArchives(nativeZip(g), true);
    fs.appendFileSync(path.join(g.cache, 'pending.held-latest', g.archiveName), 'drift');
    assert.throws(() => g.capture(), /checksum differs/);
  });
  for (const [name, entries] of [
    ['missing native entry', SEALED_SHELL_PARTS.slice(1)],
    ['duplicate native entry', [...SEALED_SHELL_PARTS, SEALED_SHELL_PARTS[0]]],
  ]) await t.test(name, t => {
    const g = appliedUpdateFixture(t); g.writeArchives(nativeZip(g, entries));
    assert.throws(() => g.capture(), /native entries missing|duplicate retained native/);
  });
  await t.test('older archive after newer applied shell', t => {
    const g = appliedUpdateFixture(t);
    fs.appendFileSync(path.join(g.app, 'Contents/Info.plist'), '<!-- native revision -->');
    assert.throws(() => g.capture(), /differs from applied native shell/);
  });
});

test('running helpers and unreadable process evidence refuse, including after an authentic initial proof', t => {
  const g = appliedUpdateFixture(t); const evidence = g.capture(); const guarded = g.proveApplied(evidence);
  assert.throws(() => g.proveApplied(evidence, { isUpdaterRunning: () => true }), /helper is still running/);
  assert.throws(() => g.proveApplied(evidence, { priorProof: guarded, isUpdaterRunning: () => true }), /helper is still running/);
  assert.throws(() => g.proveApplied(evidence, { isUpdaterRunning: () => { throw new Error('cannot inspect processes'); } }), /cannot inspect/);
  assert.equal(isUpdaterHelperRunning(() => '/path/Clementine.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt arg\n'), true);
  assert.equal(isUpdaterHelperRunning(() => '/path/ordinary-node helper\n'), false);
  assert.throws(() => isUpdaterHelperRunning(() => { throw new Error('ps denied'); }), /process_inventory_unavailable/);
});

test('a helper still refuses when staging was already consumed and no cached files remain', t => {
  const g = guardedFixture(t);
  assert.throws(() => g.prove({ isUpdaterRunning: () => true }), /helper is still running/);
});

test('native and externally launched daemon processes remain blockers with bundle paths containing spaces', () => {
  const app = '/Users/example/My Applications/Clementine.app';
  const entry = `${app}/Contents/Resources/daemon/dist/index.js`;
  assert.equal(isInstalledAppRunning(app, () => `${app}/Contents/MacOS/Clementine\n`), true);
  assert.equal(isInstalledAppRunning(app, () => `/usr/local/bin/node ${entry} daemon\n`), true);
  assert.equal(isInstalledAppRunning(app, () => `/bin/zsh -c inspect ${entry}\n`), false);
  assert.equal(isInstalledAppRunning(app, () => `/usr/local/bin/node /Other/Clementine.app/Contents/Resources/daemon/dist/index.js\n`), false);
  assert.throws(() => isInstalledAppRunning(app, () => { throw new Error('process inventory denied'); }), /process_inventory_unavailable/);
});

test('bounded private inventories retain full matching evidence beyond one MiB', () => {
  const app = '/Users/example/My Applications/Clementine.app';
  const entry = `${app}/Contents/Resources/daemon/dist/index.js`;
  const prefix = `/usr/bin/unrelated ${'x'.repeat(1024 * 1024)}\n`;
  const cases = [
    [commands => isInstalledAppRunning(app, commands), `${app}/Contents/MacOS/Clementine\n`, true],
    [commands => isInstalledAppRunning(app, commands), `/usr/local/bin/node ${entry} daemon\n`, true],
    [commands => isInstalledAppRunning(app, commands), `/bin/zsh -c inspect ${entry}\n`, false],
    [commands => isInstalledAppRunning(app, commands), '/usr/local/bin/node /Other/Clementine.app/Contents/Resources/daemon/dist/index.js\n', false],
    [isUpdaterHelperRunning, '/path/Frameworks/Squirrel.framework/Resources/ShipIt arg\n', true],
    [isUpdaterHelperRunning, '/path/Squirrel arg\n', true],
    [isUpdaterHelperRunning, '/path/ordinary-node helper\n', false],
  ];
  for (const [inspect, tail, expected] of cases) {
    let called = 0;
    assert.equal(inspect((command, args, options) => {
      called++;
      assert.equal(command, '/bin/ps');
      assert.deepEqual(args, ['-axo', 'command=']);
      assert.deepEqual(options, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      return prefix + tail;
    }), expected, 'matching at the end of the complete inventory retains existing predicate semantics');
    assert.equal(called, 1);
  }
});

test('private inventory errors expose only a fixed refusal, never captured argv or causes', () => {
  const sensitive = 'private-argv-and-output-marker';
  for (const inspect of [commands => isInstalledAppRunning('/Users/example/Clementine.app', commands), isUpdaterHelperRunning]) {
    for (const code of ['ENOBUFS', 'EACCES']) {
      const original = Object.assign(new Error(sensitive), { code, stdout: Buffer.from(sensitive), stderr: sensitive });
      assert.throws(() => inspect(() => { throw original; }), error => {
        assert.notEqual(error, original);
        assert.equal(error.message, 'Refusing a guarded patch: process_inventory_unavailable.');
        assert.equal(error.cause, undefined);
        assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ['message', 'stack']);
        assert.equal(error.stack.includes(sensitive), false);
        return true;
      });
    }
  }
});

test('unavailable private app or updater inventory refuses fresh proofs and staging without writes', async t => {
  for (const observer of ['app', 'updater']) for (const code of ['ENOBUFS', 'EACCES']) await t.test(`${observer} ${code}`, t => {
    const g = noActiveRepeatFixture(t);
    const sensitive = 'private-process-output-marker';
    let unavailable = false;
    const commands = () => {
      if (unavailable) throw Object.assign(new Error(sensitive), { code, stdout: sensitive, stderr: sensitive });
      return '';
    };
    const overrides = observer === 'app'
      ? { isRunning: () => isInstalledAppRunning(g.app, commands) }
      : { isUpdaterRunning: () => isUpdaterHelperRunning(commands) };
    const proof = g.proveNoActive(overrides);
    const before = fs.readFileSync(path.join(g.daemonDist, 'index.js'));
    const writes = [];
    const fileOps = { ...fs };
    for (const operation of ['cpSync', 'mkdirSync', 'renameSync', 'rmSync', 'writeFileSync']) fileOps[operation] = () => {
      writes.push(operation); throw new Error('unexpected write with unknown process inventory');
    };
    unavailable = true;
    assert.throws(() => g.proveNoActive(overrides, fileOps), /process_inventory_unavailable/);
    assert.throws(() => installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: proof }, fileOps),
      /process_inventory_unavailable/, 'an earlier authentic proof never bypasses a new observer failure');
    assert.deepEqual(writes, []);
    assert.deepEqual(fs.readFileSync(path.join(g.daemonDist, 'index.js')), before);
  });
});

// Full signed-reference fixtures bind every entry, including official internal
// framework links. The mocked codesign boundary never touches a real bundle.
function fullBundleZip(root, extraRecords = []) {
  const records = [];
  const visit = rel => {
    const absolute = path.join(root, rel); const stat = fs.lstatSync(absolute);
    const directory = stat.isDirectory(); const link = stat.isSymbolicLink();
    records.push({ name: `${path.basename(root)}/${rel}${directory && rel ? '/' : ''}`, mode: stat.mode, content: directory ? Buffer.alloc(0) : link ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute) });
    if (directory) for (const name of fs.readdirSync(absolute).sort()) visit(rel ? `${rel}/${name}` : name);
  };
  visit(''); records.push(...extraRecords);
  const locals = []; const central = []; let offset = 0;
  for (const { name: text, mode, content } of records) {
    const name = Buffer.from(text); const bytes = deflateRawSync(content);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(content.length, 22); header.writeUInt16LE(name.length, 26);
    locals.push(header, name, bytes);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE((3 << 8) | 20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(content.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE((mode << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, name); offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function assetDigestForFixture(root) {
  const hash = createHash('sha256');
  const visit = rel => {
    const absolute = path.join(root, rel);
    if (fs.lstatSync(absolute).isDirectory()) for (const name of fs.readdirSync(absolute).sort()) visit(path.join(rel, name));
    else { hash.update(rel); hash.update(fs.readFileSync(absolute)); }
  };
  visit(''); return hash.digest('hex');
}

function repeatedUpdateFixture(t) {
  const g = appliedUpdateFixture(t);
  g.parts = {
    daemon: 'Contents/Resources/daemon/dist',
    'builtin-skills': 'Contents/Resources/daemon/builtin-skills',
    'console-web': 'Contents/Resources/daemon/apps/console-web/dist',
    'mobile-web': 'Contents/Resources/daemon/apps/mobile-web/dist',
  };
  for (const relative of Object.values(g.parts)) {
    fs.mkdirSync(path.join(g.app, relative), { recursive: true });
    fs.writeFileSync(path.join(g.app, relative, 'official.txt'), 'original signed release');
  }
  const framework = path.join(g.app, 'Contents/Frameworks/Test.framework');
  fs.mkdirSync(path.join(framework, 'Versions/A'), { recursive: true });
  fs.writeFileSync(path.join(framework, 'Versions/A/Test'), 'signed framework');
  fs.symlinkSync('A', path.join(framework, 'Versions/Current'));
  fs.symlinkSync('Versions/Current/Test', path.join(framework, 'Test'));
  g.reference = path.join(g.root, 'official-reference/Fixture.app');
  fs.cpSync(g.app, g.reference, { recursive: true, verbatimSymlinks: true });
  g.writeArchives(fullBundleZip(g.reference), true);
  g.evidence = g.capture();
  g.receipt = { bundle: g.app, wasVersion: '3.18.35', sourceFingerprint: 'b'.repeat(64), parts: {} };
  for (const [name, relative] of Object.entries(g.parts)) {
    const target = path.join(g.app, relative); const backup = `${target}.backup-Historical${name.replace(/-/g, '')}`;
    fs.renameSync(target, backup);
    fs.cpSync(g.sourceDist, target, { recursive: true });
    const digest = name === 'daemon' ? inspectDaemonBuildForFixture(target) : assetDigestForFixture(target);
    g.receipt.parts[name] = { ...(name === 'daemon' ? { digest } : { built: digest }), served: digest, backup, match: true };
  }
  g.receiptPath = path.join(g.root, 'authorized-prior.json');
  const writeReceipt = () => fs.writeFileSync(g.receiptPath, JSON.stringify(g.receipt));
  writeReceipt();
  g.repeat = { referenceBundle: g.reference, authorizedReceipt: g.receiptPath, authorizedReceiptSha256: createHash('sha256').update(fs.readFileSync(g.receiptPath)).digest('hex'), expectedPriorFingerprint: 'b'.repeat(64), expectedReferenceCdHash: 'c'.repeat(40) };
  g.repinReceipt = () => { writeReceipt(); g.repeat.authorizedReceiptSha256 = createHash('sha256').update(fs.readFileSync(g.receiptPath)).digest('hex'); };
  g.signatures = [];
  g.proveRepeat = (overrides = {}) => g.proveApplied(g.evidence, {
    repeatedReference: g.repeat,
    verifyNativeSignature: bundle => { g.signatures.push(bundle); assert.equal(bundle, g.reference, 'verify the pristine full seal, never claim the patched installed seal passes'); },
    readReferenceCodeIdentity: () => ({ bundleId: 'com.example.fixture', team: '4AR3Y8XD72', cdHash: 'c'.repeat(40) }),
    ...overrides,
  });
  return g;
}

function inspectDaemonBuildForFixture(root) {
  const hash = createHash('sha256');
  const visit = rel => {
    const absolute = path.join(root, rel); const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) for (const name of fs.readdirSync(absolute).sort()) visit(path.join(rel, name));
    else { hash.update(JSON.stringify([rel, stat.size])); hash.update(fs.readFileSync(absolute)); }
  };
  visit(''); return hash.digest('hex');
}

/** Ordered installed rounds with distinct runtime bytes and exact retained
 * siblings. No fixture uses a real application, updater or model. */
function receiptChainFixture(t, rounds = 3) {
  const g = repeatedUpdateFixture(t);
  g.chain = [{ path: g.receiptPath, receipt: g.receipt }];
  for (let round = 2; round <= rounds; round += 1) {
    const fingerprint = round < 10 ? String(round).repeat(64) : round.toString(16).padStart(64, '0');
    const receipt = { bundle: g.app, wasVersion: '3.18.35', sourceFingerprint: fingerprint, parts: {} };
    for (const [name, relative] of Object.entries(g.parts)) {
      const target = path.join(g.app, relative); const backup = `${target}.backup-Round${round}${name.replace(/-/g, '')}`;
      fs.renameSync(target, backup);
      fs.cpSync(g.sourceDist, target, { recursive: true });
      fs.writeFileSync(path.join(target, 'index.js'), `runtime round ${round} ${name}`);
      fs.writeFileSync(path.join(target, 'runtime/build-stamp.json'), JSON.stringify({ gitSha: 'a'.repeat(40), sourceFingerprint: fingerprint }));
      const digest = name === 'daemon' ? inspectDaemonBuildForFixture(target) : assetDigestForFixture(target);
      receipt.parts[name] = { ...(name === 'daemon' ? { digest } : { built: digest }), served: digest, backup, match: true };
    }
    const receiptPath = path.join(g.root, `authorized-round-${round}.json`);
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    g.chain.push({ path: receiptPath, receipt });
  }
  g.manifestPath = path.join(g.root, 'authorized-ancestors.json');
  g.manifest = { version: 1, receipts: g.chain.slice(0, -1).map(item => ({ path: item.path, sha256: createHash('sha256').update(fs.readFileSync(item.path)).digest('hex') })) };
  const latest = g.chain.at(-1);
  g.repeat.authorizedReceipt = latest.path;
  g.repeat.authorizedReceiptSha256 = createHash('sha256').update(fs.readFileSync(latest.path)).digest('hex');
  g.repeat.expectedPriorFingerprint = latest.receipt.sourceFingerprint;
  g.repeat.authorizedAncestorManifest = g.manifestPath;
  g.repinManifest = () => {
    fs.writeFileSync(g.manifestPath, JSON.stringify(g.manifest));
    g.repeat.authorizedAncestorManifestSha256 = createHash('sha256').update(fs.readFileSync(g.manifestPath)).digest('hex');
  };
  g.repinChainReceipt = index => {
    const item = g.chain[index]; fs.writeFileSync(item.path, JSON.stringify(item.receipt));
    const sha256 = createHash('sha256').update(fs.readFileSync(item.path)).digest('hex');
    if (index === g.chain.length - 1) g.repeat.authorizedReceiptSha256 = sha256;
    else g.manifest.receipts.find(pin => pin.path === item.path).sha256 = sha256;
    g.repinManifest();
  };
  g.repinManifest();
  return g;
}

test('bounded ordered receipt chain proves three installed rounds and privately retains the fourth rollback set', t => {
  const g = receiptChainFixture(t); const proof = g.proveRepeat();
  assert.deepEqual(g.signatures, [g.reference]);
  fs.writeFileSync(path.join(g.sourceDist, 'index.js'), 'runtime fourth round');
  fs.writeFileSync(path.join(g.sourceDist, 'runtime/build-stamp.json'), JSON.stringify({ gitSha: 'a'.repeat(40), sourceFingerprint: '4'.repeat(64) }));
  const newBackups = [];
  for (const [name, relative] of Object.entries(g.parts)) {
    const target = path.join(g.app, relative);
    const result = name === 'daemon'
      ? installDaemonPatch({ sourceDist: g.sourceDist, targetDist: target, guarded: proof })
      : installBundledAssetDirectory({ sourceDir: g.sourceDist, targetDir: target, guarded: proof });
    newBackups.push(result.backup);
    assert.equal(fs.readFileSync(path.join(result.backup, 'index.js'), 'utf8'), `runtime round 3 ${name}`);
    assert.doesNotThrow(() => g.proveRepeat({ priorProof: proof }));
  }
  for (const item of g.chain) for (const part of Object.values(item.receipt.parts)) assert.ok(fs.existsSync(part.backup), 'every exact historical rollback remains');
  assert.equal(new Set(newBackups).size, 4);
  assert.throws(() => assertMutableInstallTarget(`${g.daemonDist}.backup-Unknown`, proof), /four exact runtime roots/);
  fs.appendFileSync(path.join(newBackups[2], 'index.js'), 'tampered');
  assert.throws(() => g.proveRepeat({ priorProof: proof }), /retained rollback footprint/);
});

for (const ancestors of [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]) test(`exact ${ancestors}-ancestor no-active chain retains every rollback through four replacements`, t => {
  const g = noActiveRepeatFixture(t, ancestors + 1);
  assert.equal(g.manifest.receipts.length, ancestors);
  assert.equal(new Set(g.chain.map(item => item.receipt.sourceFingerprint)).size, ancestors + 1);
  const receiptsBefore = g.chain.map(item => [item.path, fs.readFileSync(item.path)]);
  const manifestBefore = fs.readFileSync(g.manifestPath);
  const nativeBefore = SEALED_SHELL_PARTS.map(relative => [relative, fs.readFileSync(path.join(g.app, relative))]);
  const backupsBefore = g.chain.flatMap(item => Object.entries(item.receipt.parts).map(([name, part]) =>
    [part.backup, name === 'daemon' ? inspectDaemonBuildForFixture(part.backup) : assetDigestForFixture(part.backup), name]));
  assert.equal(backupsBefore.length, (ancestors + 1) * 4);
  const proof = g.proveNoActive();
  assert.deepEqual(g.signatures, [g.reference], 'the pristine signed reference is still required');
  fs.writeFileSync(path.join(g.sourceDist, 'index.js'), `next runtime after ${ancestors} ancestors`);
  fs.writeFileSync(path.join(g.sourceDist, 'runtime/build-stamp.json'), JSON.stringify({
    gitSha: 'a'.repeat(40), sourceFingerprint: createHash('sha256').update(`next-${ancestors}`).digest('hex'),
  }));
  const newBackups = [];
  for (const [name, relative] of Object.entries(g.parts)) {
    const target = path.join(g.app, relative);
    const result = name === 'daemon'
      ? installDaemonPatch({ sourceDist: g.sourceDist, targetDist: target, guarded: proof })
      : installBundledAssetDirectory({ sourceDir: g.sourceDist, targetDir: target, guarded: proof });
    newBackups.push(result.backup);
    assert.equal(fs.readFileSync(path.join(result.backup, 'index.js'), 'utf8'), `runtime round ${ancestors + 1} ${name}`);
    assert.doesNotThrow(() => g.proveNoActive({ priorProof: proof }), 'every replacement still refreshes the full private proof');
  }
  assert.equal(new Set(newBackups).size, 4);
  for (const [backup, digest, name] of backupsBefore) assert.equal(
    name === 'daemon' ? inspectDaemonBuildForFixture(backup) : assetDigestForFixture(backup), digest,
    'no historical rollback is removed or rewritten');
  for (const [receipt, bytes] of receiptsBefore) assert.deepEqual(fs.readFileSync(receipt), bytes);
  assert.deepEqual(fs.readFileSync(g.manifestPath), manifestBefore);
  for (const [relative, bytes] of nativeBefore) assert.deepEqual(fs.readFileSync(path.join(g.app, relative)), bytes);
  assert.deepEqual(captureNoActiveUpdateEvidence({ app: g.app, home: g.home }), g.noActive);
  if (ancestors >= 17) {
    fs.appendFileSync(path.join(g.chain[8].receipt.parts['console-web'].backup, 'index.js'), 'changed');
    assert.throws(() => g.proveNoActive({ priorProof: proof }), /retained rollback footprint/,
      'the extended bound never exempts a middle historical rollback');
  }
});

test('27 unique complete ancestors refuse at the bound before any write', t => {
  const g = noActiveRepeatFixture(t, 28);
  assert.equal(g.manifest.receipts.length, 27);
  assert.equal(new Set(g.manifest.receipts.map(item => item.sha256)).size, 27);
  const namesBefore = Object.values(g.parts).map(relative => [path.dirname(path.join(g.app, relative)),
    fs.readdirSync(path.dirname(path.join(g.app, relative))).sort()]);
  const writes = [];
  const fileOps = { ...fs };
  for (const operation of ['cpSync', 'mkdirSync', 'renameSync', 'rmSync', 'writeFileSync']) fileOps[operation] = () => {
    writes.push(operation); throw new Error('unexpected write during rejected proof');
  };
  assert.throws(() => g.proveNoActive({}, fileOps), /unsupported bounded ancestor manifest/);
  assert.deepEqual(writes, []);
  assert.deepEqual(g.signatures, [], 'the over-bound manifest is refused before signed-reference work');
  for (const [directory, names] of namesBefore) assert.deepEqual(fs.readdirSync(directory).sort(), names);
});

test('receipt ancestry refuses skipped, reordered, extra, aliased and unpinned evidence', async t => {
  for (const [name, change] of [
    ['missing manifest pair', g => { delete g.repeat.authorizedAncestorManifestSha256; }],
    ['wrong manifest pin', g => { g.repeat.authorizedAncestorManifestSha256 = '0'.repeat(64); }],
    ['wrong ancestor pin', g => { g.manifest.receipts[0].sha256 = '0'.repeat(64); g.repinManifest(); }],
    ['skipped oldest', g => { g.manifest.receipts.shift(); g.repinManifest(); }],
    ['skipped middle', g => { g.manifest.receipts.pop(); g.repinManifest(); }],
    ['reordered ancestors', g => { g.manifest.receipts.reverse(); g.repinManifest(); }],
    ['duplicated ancestor', g => { g.manifest.receipts.push(g.manifest.receipts[0]); g.repinManifest(); }],
    ['latest in ancestors', g => { g.manifest.receipts.push({ path: g.repeat.authorizedReceipt, sha256: g.repeat.authorizedReceiptSha256 }); g.repinManifest(); }],
    ['relative receipt path', g => { g.manifest.receipts[0].path = './relative.json'; g.repinManifest(); }],
    ['ancestor symlink', g => { const item = g.chain[0]; fs.renameSync(item.path, `${item.path}.real`); fs.symlinkSync(`${item.path}.real`, item.path); }],
    ['ancestor hardlink', g => { fs.linkSync(g.chain[0].path, path.join(g.root, 'receipt-alias.json')); }],
    ['extra ancestor keys', g => { g.manifest.receipts[0].trusted = true; g.repinManifest(); }],
    ['extra manifest keys', g => { g.manifest.success = true; g.repinManifest(); }],
    ['unsupported manifest version', g => { g.manifest.version = 2; g.repinManifest(); }],
    ['unbounded ancestors', g => { g.manifest.receipts = Array.from({ length: 27 }, () => g.manifest.receipts[0]); g.repinManifest(); }],
    ['empty manifest', g => { g.manifest.receipts = []; g.repinManifest(); }],
    ['omitted manifest', g => { delete g.repeat.authorizedAncestorManifest; delete g.repeat.authorizedAncestorManifestSha256; }],
  ]) await t.test(name, t => { const g = receiptChainFixture(t); change(g); assert.throws(() => g.proveRepeat()); });
});

test('every ancestor identity, four digests, daemon fingerprint and distinct rollback sibling is required', async t => {
  for (const [name, change] of [
    ['ancestor bundle', g => { g.chain[0].receipt.bundle = '/Other.app'; g.repinChainReceipt(0); }],
    ['ancestor native version', g => { g.chain[1].receipt.wasVersion = '3.18.34'; g.repinChainReceipt(1); }],
    ['ancestor fingerprint', g => { g.chain[0].receipt.sourceFingerprint = '0'.repeat(64); g.repinChainReceipt(0); }],
    ['ancestor daemon digest', g => { g.chain[0].receipt.parts.daemon.digest = '0'.repeat(64); g.chain[0].receipt.parts.daemon.served = '0'.repeat(64); g.repinChainReceipt(0); }],
    ['ancestor web digest', g => { g.chain[1].receipt.parts['mobile-web'].built = '0'.repeat(64); g.chain[1].receipt.parts['mobile-web'].served = '0'.repeat(64); g.repinChainReceipt(1); }],
    ['ancestor served mismatch', g => { g.chain[0].receipt.parts['console-web'].served = '0'.repeat(64); g.repinChainReceipt(0); }],
    ['missing ancestor part', g => { delete g.chain[0].receipt.parts['console-web']; g.repinChainReceipt(0); }],
    ['extra ancestor part', g => { g.chain[1].receipt.parts.other = g.chain[1].receipt.parts.daemon; g.repinChainReceipt(1); }],
    ['colliding older backup', g => { g.chain[1].receipt.parts.daemon.backup = g.chain[0].receipt.parts.daemon.backup; g.repinChainReceipt(1); }],
    ['aliased older backup', g => { g.chain[1].receipt.parts.daemon.backup = g.chain[0].receipt.parts.daemon.backup.toUpperCase(); g.repinChainReceipt(1); }],
    ['wrong part sibling', g => { g.chain[1].receipt.parts.daemon.backup = g.chain[1].receipt.parts['mobile-web'].backup; g.repinChainReceipt(1); }],
    ['missing older backup', g => { fs.rmSync(g.chain[0].receipt.parts['console-web'].backup, { recursive: true }); }],
    ['undeclared additional backup', g => { fs.mkdirSync(`${g.daemonDist}.backup-Extra`); }],
    ['oldest backup bytes', g => { fs.appendFileSync(path.join(g.chain[0].receipt.parts.daemon.backup, 'official.txt'), 'changed'); }],
    ['middle backup bytes', g => { fs.appendFileSync(path.join(g.chain[1].receipt.parts.daemon.backup, 'index.js'), 'changed'); }],
    ['middle backup mode', g => { fs.chmodSync(g.chain[1].receipt.parts.daemon.backup, 0o700); }],
    ['middle backup symlink', g => { fs.symlinkSync('index.js', path.join(g.chain[1].receipt.parts.daemon.backup, 'linked')); }],
    ['immutable resource', g => { fs.appendFileSync(path.join(g.app, 'Contents/Frameworks/Test.framework/Versions/A/Test'), 'changed'); }],
    ['native resource', g => { fs.appendFileSync(path.join(g.app, 'Contents/Resources/app.asar'), 'changed'); }],
  ]) await t.test(name, t => { const g = receiptChainFixture(t); change(g); assert.throws(() => g.proveRepeat()); });
});

test('chain JSON cannot hide duplicate keys behind valid pinned bytes', async t => {
  for (const target of ['manifest', 'receipt']) await t.test(target, t => {
    const g = receiptChainFixture(t);
    if (target === 'manifest') {
      fs.writeFileSync(g.manifestPath, JSON.stringify(g.manifest).replace('"version":1', '"version":0,"version":1'));
      g.repeat.authorizedAncestorManifestSha256 = createHash('sha256').update(fs.readFileSync(g.manifestPath)).digest('hex');
    } else {
      const item = g.chain[0];
      fs.writeFileSync(item.path, JSON.stringify(item.receipt).replace('"served":', '"served":"ignored","served":'));
      g.manifest.receipts[0].sha256 = createHash('sha256').update(fs.readFileSync(item.path)).digest('hex'); g.repinManifest();
    }
    assert.throws(() => g.proveRepeat(), /duplicate receipt\/manifest JSON keys/);
  });
});

test('every chained proof rechecks all receipt bytes, manifest and rollback sets and cannot switch authority context', async t => {
  for (const [name, change, overrides] of [
    ['oldest receipt bytes', g => fs.appendFileSync(g.chain[0].path, ' ')],
    ['middle receipt bytes', g => fs.appendFileSync(g.chain[1].path, ' ')],
    ['latest receipt bytes', g => fs.appendFileSync(g.chain[2].path, ' ')],
    ['manifest bytes', g => fs.appendFileSync(g.manifestPath, ' ')],
    ['oldest rollback', g => fs.appendFileSync(path.join(g.chain[0].receipt.parts.daemon.backup, 'official.txt'), 'changed')],
    ['middle rollback', g => fs.appendFileSync(path.join(g.chain[1].receipt.parts['console-web'].backup, 'index.js'), 'changed')],
    ['latest rollback', g => fs.appendFileSync(path.join(g.chain[2].receipt.parts['mobile-web'].backup, 'index.js'), 'changed')],
    ['manifest pin changed', g => { g.repeat.authorizedAncestorManifestSha256 = '0'.repeat(64); }],
    ['manifest context omitted', () => {}, g => ({ repeatedReference: { ...g.repeat, authorizedAncestorManifest: undefined, authorizedAncestorManifestSha256: undefined } })],
    ['latest receipt context changed', () => {}, g => ({ repeatedReference: { ...g.repeat, authorizedReceipt: g.chain[0].path, authorizedReceiptSha256: g.manifest.receipts[0].sha256 } })],
    ['serialized proof', () => {}, (_g, proof) => ({ priorProof: JSON.parse(JSON.stringify(proof)) })],
  ]) await t.test(name, t => {
    const g = receiptChainFixture(t); const proof = g.proveRepeat(); change(g);
    assert.throws(() => g.proveRepeat({ priorProof: proof, ...(overrides?.(g, proof) ?? {}) }));
  });
});

test('repeat admission proves pristine full seal, exact archive/immutable tree and all historical runtime/rollback roots', t => {
  const g = repeatedUpdateFixture(t); const proof = g.proveRepeat();
  assert.deepEqual(g.signatures, [g.reference]);
  assert.doesNotThrow(() => g.proveRepeat({ priorProof: proof }));
  const withImplicitLedger = g.proveRepeat({ priorProof: proof, repeatedReference: undefined });
  assert.throws(() => assertMutableInstallTarget(path.join(g.app, 'Contents/Resources/daemon/unknown'), withImplicitLedger), /four exact runtime roots/);
  assert.deepEqual(g.signatures, [g.reference], 'later proof rehashes signed bytes and identity instead of asserting installed seal validity');
  assert.throws(() => g.proveRepeat({ priorProof: JSON.parse(JSON.stringify(proof)) }), /no matching initial/);
  assert.throws(() => assertMutableInstallTarget(path.join(g.app, 'Contents/Resources/daemon/apps/unknown/dist'), proof), /four exact runtime roots/);
  assert.throws(() => assertMutableInstallTarget(path.join(g.daemonDist, 'nested'), proof), /four exact runtime roots/);
});

test('repeat admission refuses missing or incorrect pins and cannot use receipt success booleans as authority', async t => {
  for (const [name, change] of [
    ['wrong receipt hash', g => { g.repeat.authorizedReceiptSha256 = '0'.repeat(64); }],
    ['wrong previous fingerprint', g => { g.repeat.expectedPriorFingerprint = '0'.repeat(64); }],
    ['wrong CDHash', g => { g.repeat.expectedReferenceCdHash = '0'.repeat(40); }],
    ['missing reference pin', g => { delete g.repeat.expectedReferenceCdHash; }],
    ['wrong receipt runtime', g => { g.receipt.parts.daemon.digest = '0'.repeat(64); g.receipt.parts.daemon.match = true; g.repinReceipt(); }],
    ['arbitrary rollback path', g => { g.receipt.parts.daemon.backup = g.reference; g.repinReceipt(); }],
    ['missing rollback root', g => { fs.rmSync(g.receipt.parts['mobile-web'].backup, { recursive: true }); }],
    ['extra receipt part', g => { g.receipt.parts.other = g.receipt.parts.daemon; g.repinReceipt(); }],
  ]) await t.test(name, t => {
    const g = repeatedUpdateFixture(t); change(g); assert.throws(() => g.proveRepeat());
    assert.equal(fs.readFileSync(path.join(g.daemonDist, 'index.js'), 'utf8'), 'new daemon');
  });
});

test('repeat reference requires official publisher, full strict signature and stable bytes through the signature boundary', async t => {
  await t.test('different valid signer', t => {
    const g = repeatedUpdateFixture(t);
    assert.throws(() => g.proveRepeat({ readReferenceCodeIdentity: () => ({ bundleId: 'com.example.fixture', team: 'ANOTHERSIGNER', cdHash: 'c'.repeat(40) }) }), /publisher\/identity/);
  });
  await t.test('invalid full signature', t => {
    const g = repeatedUpdateFixture(t); assert.throws(() => g.proveRepeat({ verifyNativeSignature: () => { throw new Error('full strict signature failure'); } }), /full strict signature failure/);
  });
  await t.test('signature boundary mutates a reference resource', t => {
    const g = repeatedUpdateFixture(t);
    assert.throws(() => g.proveRepeat({ verifyNativeSignature: () => fs.appendFileSync(path.join(g.reference, 'Contents/Frameworks/Test.framework/Versions/A/Test'), 'changed') }), /verified reference footprint/);
  });
});

test('repeat typed evidence rejects undeclared immutable, rollback, runtime or framework changes', async t => {
  for (const [name, change] of [
    ['immutable extra file', g => fs.writeFileSync(path.join(g.app, 'Contents/Resources/extra.txt'), 'unaccounted')],
    ['immutable mode', g => fs.chmodSync(path.join(g.app, 'Contents/MacOS'), 0o700)],
    ['immutable changed bytes', g => fs.appendFileSync(path.join(g.app, 'Contents/Frameworks/Test.framework/Versions/A/Test'), 'changed')],
    ['official link target changed', g => { const p = path.join(g.app, 'Contents/Frameworks/Test.framework/Test'); fs.unlinkSync(p); fs.symlinkSync('Versions/A/Test', p); }],
    ['unknown backup wildcard', g => fs.mkdirSync(`${g.daemonDist}.backup-Unknown`)],
    ['historical rollback bytes', g => fs.appendFileSync(path.join(g.receipt.parts.daemon.backup, 'official.txt'), 'changed')],
    ['historical rollback root mode', g => fs.chmodSync(g.receipt.parts.daemon.backup, 0o700)],
    ['runtime root mode', g => fs.chmodSync(g.daemonDist, 0o700)],
    ['runtime file mode', g => fs.chmodSync(path.join(g.daemonDist, 'index.js'), 0o755)],
    ['runtime changed bytes', g => fs.appendFileSync(path.join(g.daemonDist, 'index.js'), 'changed')],
    ['runtime symlink', g => fs.symlinkSync('index.js', path.join(g.daemonDist, 'alias'))],
    ['runtime hardlink', g => fs.linkSync(path.join(g.daemonDist, 'index.js'), path.join(g.daemonDist, 'alias'))],
    ['runtime case alias', g => fs.writeFileSync(path.join(g.daemonDist, 'INDEX.js'), 'alias')],
    ['reference extra file', g => fs.writeFileSync(path.join(g.reference, 'Contents/Resources/extra.txt'), 'changed')],
    ['reference directory mode', g => fs.chmodSync(path.join(g.reference, 'Contents/Resources'), 0o700)],
    ['reference linked root', g => { fs.renameSync(g.reference, g.reference + '.original'); fs.symlinkSync(g.reference + '.original', g.reference); }],
  ]) await t.test(name, t => { const g = repeatedUpdateFixture(t); change(g); assert.throws(() => g.proveRepeat()); });
});

test('every repeat proof refreshes private immutable/runtime/rollback and process/updater evidence', async t => {
  for (const [name, change, overrides] of [
    ['native changed', g => fs.appendFileSync(path.join(g.app, 'Contents/Resources/app.asar'), 'changed')],
    ['runtime changed', g => fs.appendFileSync(path.join(g.daemonDist, 'index.js'), 'changed')],
    ['receipt changed', g => fs.appendFileSync(g.receiptPath, ' ')],
    ['reference changed', g => fs.appendFileSync(path.join(g.reference, 'Contents/Frameworks/Test.framework/Versions/A/Test'), 'changed')],
    ['old backup changed', g => fs.appendFileSync(path.join(g.receipt.parts.daemon.backup, 'official.txt'), 'changed')],
    ['new queued update', g => fs.mkdirSync(path.join(g.shipIt, 'update.NEW'))],
    ['helper running', () => {}, { isUpdaterRunning: () => true }],
    ['app running', () => {}, { isRunning: () => true }],
  ]) await t.test(name, t => { const g = repeatedUpdateFixture(t); const proof = g.proveRepeat(); change(g); assert.throws(() => g.proveRepeat({ priorProof: proof, ...overrides })); });
});

test('private repeat ledger carries all four replacements and exact new rollback paths through fresh proofs', t => {
  const g = repeatedUpdateFixture(t); const original = g.proveRepeat();
  fs.writeFileSync(path.join(g.sourceDist, 'index.js'), 'next daemon');
  const daemon = installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: original });
  assert.equal(fs.readFileSync(path.join(daemon.backup, 'index.js'), 'utf8'), 'new daemon');
  const fresh = g.proveRepeat({ priorProof: original });
  for (const [name, relative] of Object.entries(g.parts).filter(([name]) => name !== 'daemon')) {
    const target = path.join(g.app, relative);
    const result = installBundledAssetDirectory({ sourceDir: g.sourceDist, targetDir: target, guarded: original });
    assert.equal(fs.readFileSync(path.join(result.backup, 'index.js'), 'utf8'), 'new daemon');
    assert.doesNotThrow(() => g.proveRepeat({ priorProof: fresh }), name);
  }
  assert.doesNotThrow(() => g.proveRepeat({ priorProof: original }));
  assert.throws(() => installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: original }), /fresh exact runtime root/);
  fs.appendFileSync(path.join(daemon.backup, 'index.js'), 'tampered');
  assert.throws(() => g.proveRepeat({ priorProof: fresh }), /retained rollback footprint/);
});

test('repeat replacement refuses source/staging type or permission drift before moving old runtime', async t => {
  await t.test('source symlink', t => {
    const g = repeatedUpdateFixture(t); const proof = g.proveRepeat();
    fs.symlinkSync('index.js', path.join(g.sourceDist, 'alias'));
    assert.throws(() => installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: proof }), /runtime symlink/);
  });
  await t.test('staging directory permission drift', t => {
    const g = repeatedUpdateFixture(t); const proof = g.proveRepeat();
    assert.throws(() => installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: proof }, { ...fs, cpSync(source, target, options) { fs.cpSync(source, target, options); fs.chmodSync(target, 0o700); } }), /typed staging copy/);
    assert.doesNotThrow(() => g.proveRepeat({ priorProof: proof }));
  });
  await t.test('failed post-rename registration restores that part', t => {
    const g = repeatedUpdateFixture(t); const proof = g.proveRepeat(); let renames = 0;
    assert.throws(() => installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: proof }, { ...fs, renameSync(from, to) { fs.renameSync(from, to); if (++renames === 2) fs.chmodSync(to, 0o700); } }), /replacement footprint/);
    assert.doesNotThrow(() => g.proveRepeat({ priorProof: proof }));
    assert.equal(fs.readFileSync(path.join(g.daemonDist, 'index.js'), 'utf8'), 'new daemon');
  });
});

test('repeat proof cannot change home, applied evidence or native snapshot to leave the private ledger behind', async t => {
  for (const [name, overrides] of [
    ['different home', g => ({ home: path.join(g.root, 'other-home') })],
    ['omitted retained evidence', () => ({ appliedUpdateEvidence: undefined })],
    ['different native snapshot', g => ({ shellSnapshot: { ...g.snapshot, 'Contents/Resources/app.asar': '0'.repeat(64) } })],
  ]) await t.test(name, t => {
    const g = repeatedUpdateFixture(t); const proof = g.proveRepeat();
    assert.throws(() => g.proveRepeat({ priorProof: proof, ...overrides(g) }), /private repeat/);
  });
});

test('full archive admission rejects unsafe links, aliases and special entry types even with matching download checksum', async t => {
  for (const [name, change] of [
    ['escaping official link', g => fs.symlinkSync('../../../../outside', path.join(g.reference, 'Contents/Frameworks/escape'))],
    ['aliased official file', () => {}],
    ['special central-directory entry', () => {}],
  ]) await t.test(name, t => {
    const g = repeatedUpdateFixture(t); change(g); let bytes = fullBundleZip(g.reference);
    if (name === 'aliased official file') bytes = fullBundleZip(g.reference, [{ name: 'Fixture.app/Contents/Frameworks/Test.framework/Versions/A/TEST', mode: 0o100644, content: Buffer.from('signed framework') }]);
    if (name === 'special central-directory entry') {
      bytes = Buffer.from(bytes); const centralOffset = bytes.readUInt32LE(bytes.length - 22 + 16);
      bytes.writeUInt32LE((0o010755 << 16) >>> 0, centralOffset + 38);
    }
    g.writeArchives(bytes, true); g.evidence = g.capture();
    assert.throws(() => g.proveRepeat());
  });
});

test('exact cache-root archive selection also supports pending download filename update.zip', t => {
  const g = repeatedUpdateFixture(t);
  for (const suffix of ['', '.held-latest']) {
    const pending = path.join(g.cache, `pending${suffix}`);
    fs.rmSync(pending, { recursive: true });
  }
  g.archiveName = 'update.zip'; g.writeArchives(fullBundleZip(g.reference), true); g.evidence = g.capture();
  assert.doesNotThrow(() => g.proveRepeat());
});

test('repeat installer CLI rejects incomplete, duplicate or unknown authority flags before subprocesses or mutation', async t => {
  const moduleUrl = new URL('./hotpatch-installed-tree.mjs', import.meta.url);
  const body = fs.readFileSync(moduleUrl, 'utf8').replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*$/gm, '').replaceAll('import.meta.url', JSON.stringify(moduleUrl.href));
  const helpers = await import('./hotpatch-daemon.mjs'); const { Script } = await import('node:vm'); const { fileURLToPath } = await import('node:url');
  const repeatArgs = ['--guarded-shell-snapshot', '/snapshot', '--signed-reference-bundle', '/reference.app', '--authorized-prior-receipt', '/receipt', '--authorized-prior-receipt-sha256', 'a'.repeat(64), '--expected-prior-fingerprint', 'b'.repeat(64), '--expected-reference-cdhash', 'c'.repeat(40)];
  for (const args of [
    ['--signed-reference-bundle', '/reference.app'],
    ['--signed-reference-bundle', '--no-relaunch'],
    ['--signed-reference-bundle', '/reference.app', '--signed-reference-bundle', '/another.app'],
    ['--guarded-shell-snapshot', '/snapshot', '--guarded-shell-snapshot', '/other'],
    ['--skip-signature'],
    ['--authorized-ancestor-manifest', '/manifest'],
    ['--authorized-ancestor-manifest-sha256', 'a'.repeat(64)],
    ['--authorized-ancestor-manifest', '/manifest', '--authorized-ancestor-manifest', '/other'],
    [...repeatArgs, '--authorized-ancestor-manifest', '/manifest'],
    [...repeatArgs, '--authorized-ancestor-manifest-sha256', 'a'.repeat(64)],
  ]) await t.test(args[0], async () => {
    const commands = [];
    const result = new Script(`(async () => { ${body}\n})()`).runInNewContext({
      ...helpers, fs, path, createHash, fileURLToPath,
      process: { argv: ['node', moduleUrl.pathname, ...args], env: {} },
      console: { log() {}, error() {} }, execFileSync(command) { commands.push(command); throw new Error('unexpected subprocess'); },
    });
    await assert.rejects(result, /requires|Duplicate|Unknown/); assert.deepEqual(commands, []);
  });
  for (const args of [repeatArgs, [...repeatArgs, '--authorized-ancestor-manifest', '/manifest', '--authorized-ancestor-manifest-sha256', 'd'.repeat(64)]]) await t.test(args.length === repeatArgs.length ? 'legacy complete pins parse' : 'complete ancestor pins parse', async () => {
    const result = new Script(`(async () => { ${body}\n})()`).runInNewContext({
      ...helpers, fs, path, createHash, fileURLToPath,
      resolveInstalledAppBundle() { throw new Error('validated arguments reached bundle selection'); },
      process: { argv: ['node', moduleUrl.pathname, ...args], env: {} },
      console: { log() {}, error() {} }, execFileSync() { throw new Error('unexpected subprocess'); },
    });
    await assert.rejects(result, /validated arguments reached bundle selection/);
  });
});

function noActiveRepeatFixture(t, rounds = 3) {
  const g = receiptChainFixture(t, rounds);
  // Only disposable test fixtures are changed. Production capture never
  // removes, moves or recreates updater evidence.
  fs.rmSync(path.join(g.cache, 'pending'), { recursive: true });
  fs.rmSync(path.join(g.cache, 'update.zip'));
  fs.rmSync(g.statePath);
  fs.writeFileSync(path.join(g.cache, 'current.blockmap'), 'retained blockmap');
  fs.writeFileSync(path.join(g.shipIt, 'ShipIt_stdout.log'), 'historical updater log');
  g.noActive = captureNoActiveUpdateEvidence({ app: g.app, home: g.home });
  g.proveNoActive = (overrides = {}, fileOps = fs) => verifyGuardedSealedPatch({
    app: g.app, home: g.home, shellSnapshot: g.snapshot, noActiveUpdateEvidence: g.noActive,
    repeatedReference: g.repeat, isRunning: () => false, isUpdaterRunning: () => false,
    verifyNativeSignature: bundle => { g.signatures.push(bundle); assert.equal(bundle, g.reference); },
    readReferenceCodeIdentity: () => ({ bundleId: 'com.example.fixture', team: '4AR3Y8XD72', cdHash: 'c'.repeat(40) }),
    ...overrides,
  }, fileOps);
  return g;
}

test('explicit no-active repeat keeps signed-reference and all ancestor proofs through four replacements', t => {
  const g = noActiveRepeatFixture(t);
  const cacheBefore = JSON.stringify(g.noActive);
  assert.equal(g.noActive.mode, 'no-active-update');
  const proof = g.proveNoActive();
  assert.deepEqual(g.signatures, [g.reference]);
  assert.throws(() => assertMutableInstallTarget(path.join(g.app, 'Contents/Resources/other'), proof), /four exact runtime roots/);
  fs.writeFileSync(path.join(g.sourceDist, 'index.js'), 'next no-active daemon');
  fs.writeFileSync(path.join(g.sourceDist, 'runtime/build-stamp.json'), JSON.stringify({ gitSha: 'a'.repeat(40), sourceFingerprint: '4'.repeat(64) }));
  const installed = installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: proof });
  assert.equal(fs.readFileSync(path.join(installed.backup, 'index.js'), 'utf8'), 'runtime round 3 daemon');
  for (const [name, relative] of Object.entries(g.parts).filter(([name]) => name !== 'daemon')) {
    const installed = installBundledAssetDirectory({ sourceDir: g.sourceDist, targetDir: path.join(g.app, relative), guarded: proof });
    assert.equal(fs.readFileSync(path.join(installed.backup, 'index.js'), 'utf8'), `runtime round 3 ${name}`);
  }
  assert.doesNotThrow(() => g.proveNoActive({ priorProof: proof }));
  assert.equal(JSON.stringify(captureNoActiveUpdateEvidence({ app: g.app, home: g.home })), cacheBefore);
  assert.throws(() => g.proveNoActive({ priorProof: JSON.parse(JSON.stringify(proof)) }), /no matching private/);
  fs.appendFileSync(path.join(g.chain[0].receipt.parts.daemon.backup, 'official.txt'), 'changed');
  assert.throws(() => g.proveNoActive({ priorProof: proof }), /retained rollback footprint/);
});

test('no-active observation cannot replace explicit signed-reference authority or revive old consumed state', t => {
  const g = noActiveRepeatFixture(t);
  assert.throws(() => g.proveNoActive({ repeatedReference: undefined }), /exact signed reference and receipt chain/);
  assert.throws(() => g.proveNoActive({ appliedUpdateEvidence: g.evidence }), /mutually exclusive/);
  assert.throws(() => g.proveRepeat(), /no longer has the captured retained state/);
  assert.throws(() => g.proveNoActive({ verifyNativeSignature() { throw new Error('invalid official seal'); } }), /invalid official seal/);
  assert.throws(() => g.proveNoActive({ readReferenceCodeIdentity: () => ({ bundleId: 'com.example.fixture', team: 'OTHER', cdHash: 'c'.repeat(40) }) }), /publisher\/identity/);
  const forged = { ...g.noActive, archive: { ...g.noActive.archive, path: path.join(g.root, 'different.zip') } };
  assert.throws(() => g.proveNoActive({ noActiveUpdateEvidence: forged }), /no-active updater evidence/);
});

test('no-active capture rejects active, unknown, linked or incomplete retained state', async t => {
  for (const [name, change] of [
    ['pending update', g => fs.mkdirSync(path.join(g.cache, 'pending'))],
    ['active archive', g => fs.writeFileSync(path.join(g.cache, 'update.zip'), 'queued')],
    ['installer request', g => fs.writeFileSync(g.statePath, JSON.stringify(g.state))],
    ['unpacked update', g => fs.mkdirSync(path.join(g.shipIt, 'update.NEW'))],
    ['unknown installer file', g => fs.writeFileSync(path.join(g.shipIt, 'unknown'), 'unknown')],
    ['unknown cache file', g => fs.writeFileSync(path.join(g.cache, 'unknown'), 'unknown')],
    ['missing held pair', g => fs.rmSync(path.join(g.cache, 'update.zip.held-latest'))],
    ['changed held zip', g => fs.appendFileSync(path.join(g.cache, 'update.zip.held-latest'), 'changed')],
    ['extra pending member', g => fs.writeFileSync(path.join(g.cache, 'pending.held-latest/extra'), 'extra')],
    ['linked log', g => { const p = path.join(g.shipIt, 'ShipIt_stdout.log'); const outside = path.join(g.root, 'outside-log'); fs.renameSync(p, outside); fs.symlinkSync(outside, p); }],
    ['hardlinked blockmap', g => { const p = path.join(g.cache, 'current.blockmap'); fs.linkSync(p, path.join(g.root, 'blockmap-alias')); }],
  ]) await t.test(name, t => {
    const g = noActiveRepeatFixture(t); change(g);
    assert.throws(() => captureNoActiveUpdateEvidence({ app: g.app, home: g.home }));
    assert.equal(fs.readFileSync(path.join(g.daemonDist, 'index.js'), 'utf8'), 'runtime round 3 daemon');
  });
});

test('every no-active proof rechecks complete updater inventory, receipts, runtime, native and process state', async t => {
  for (const [name, change, overrides] of [
    ['log changed', g => fs.appendFileSync(path.join(g.shipIt, 'ShipIt_stdout.log'), 'new')],
    ['blockmap changed', g => fs.appendFileSync(path.join(g.cache, 'current.blockmap'), 'new')],
    ['new queued update', g => fs.mkdirSync(path.join(g.cache, 'pending'))],
    ['receipt changed', g => fs.appendFileSync(g.repeat.authorizedReceipt, ' ')],
    ['old backup changed', g => fs.appendFileSync(path.join(g.chain[0].receipt.parts.daemon.backup, 'official.txt'), 'new')],
    ['native changed', g => fs.appendFileSync(path.join(g.app, 'Contents/Resources/app.asar'), 'new')],
    ['runtime changed', g => fs.appendFileSync(path.join(g.daemonDist, 'index.js'), 'new')],
    ['helper running', () => {}, { isUpdaterRunning: () => true }],
    ['app running', () => {}, { isRunning: () => true }],
  ]) await t.test(name, t => {
    const g = noActiveRepeatFixture(t); const proof = g.proveNoActive(); change(g);
    assert.throws(() => g.proveNoActive({ priorProof: proof, ...overrides }));
  });
  await t.test('changes during reference verification refuse before minting a proof', t => {
    const g = noActiveRepeatFixture(t);
    assert.throws(() => g.proveNoActive({ verifyNativeSignature() {
      fs.appendFileSync(path.join(g.shipIt, 'ShipIt_stdout.log'), 'during signature verification');
    } }), /no-active updater evidence after verification/);
  });
  await t.test('helper starts during reference verification', t => {
    const g = noActiveRepeatFixture(t); let helper = false;
    assert.throws(() => g.proveNoActive({ isUpdaterRunning: () => helper,
      verifyNativeSignature() { helper = true; } }), /started during no-active verification/);
  });
});


// Synthetic full official generations only: no installed bundle, subprocess,
// actual signature/keychain, updater cache or model/provider is used.
function mixedAppliedGenerationsFixture(t, { priorVersion = '3.18.37', oldRepeat = false } = {}) {
  const g = oldRepeat ? repeatedUpdateFixture(t) : appliedUpdateFixture(t);
  const setNative = (bundle, version) => {
    fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), `<dict><key>CFBundleIdentifier</key><string>com.example.fixture</string><key>CFBundleShortVersionString</key><string>${version}</string></dict>`);
    fs.writeFileSync(path.join(bundle, 'Contents/MacOS/Clementine'), `native launcher ${version}`);
    fs.writeFileSync(path.join(bundle, 'Contents/Resources/app.asar'), `packaged shell ${version}`);
    fs.writeFileSync(path.join(bundle, 'Contents/_CodeSignature/CodeResources'), `seal ${version}`);
  };
  const snapshot = () => Object.fromEntries(SEALED_SHELL_PARTS.map(rel => [rel,
    createHash('sha256').update(fs.readFileSync(path.join(g.app, rel))).digest('hex')]));
  setNative(g.app, priorVersion);
  if (oldRepeat) setNative(g.reference, priorVersion);
  else {
    const framework = path.join(g.app, 'Contents/Frameworks/Prior.framework');
    fs.mkdirSync(path.join(framework, 'Versions/A'), { recursive: true });
    fs.writeFileSync(path.join(framework, 'Versions/A/Prior'), 'complete old signed framework');
    fs.symlinkSync('A', path.join(framework, 'Versions/Current'));
    fs.symlinkSync('Versions/Current/Prior', path.join(framework, 'Prior'));
    g.reference = path.join(g.root, 'official-prior/Fixture.app');
    fs.cpSync(g.app, g.reference, { recursive: true, verbatimSymlinks: true });
  }
  for (const suffix of ['', '.held-latest']) fs.rmSync(path.join(g.cache, `pending${suffix}`), { recursive: true, force: true });
  g.archiveName = `Fixture-${priorVersion}-arm64-mac.zip`;
  g.writeArchives(fullBundleZip(g.reference), true);
  g.snapshot = snapshot();
  g.evidence = g.capture();
  assert.equal(g.evidence.version, 1, 'the prior generation is genuinely captured under the original same-version contract');
  if (oldRepeat) {
    g.receipt.wasVersion = priorVersion;
    g.repinReceipt();
    g.proveRepeat(); // The old repeat chain is valid before the native update.
  }
  const historical = { appliedUpdateEvidence: g.evidence, shellSnapshot: g.snapshot };
  g.historicalPath = path.join(g.root, 'prior-applied-snapshot.json');
  fs.writeFileSync(g.historicalPath, JSON.stringify(historical));
  g.retained = {
    referenceBundle: g.reference,
    historicalSnapshot: g.historicalPath,
    historicalSnapshotSha256: createHash('sha256').update(fs.readFileSync(g.historicalPath)).digest('hex'),
    expectedReferenceCdHash: 'c'.repeat(40),
  };
  g.priorNative = Object.fromEntries(SEALED_SHELL_PARTS.map(rel => [rel, fs.readFileSync(path.join(g.app, rel))]));
  g.heldArchive = path.join(g.cache, 'pending.held-latest', g.archiveName);
  g.heldPair = path.join(g.cache, 'update.zip.held-latest');
  g.heldMetadata = path.join(g.cache, 'pending.held-latest/update-info.json');
  setNative(g.app, '3.18.38');
  g.snapshot = snapshot();
  fs.rmSync(path.join(g.cache, 'pending'), { recursive: true });
  g.archiveName = 'Fixture-3.18.38-arm64-mac.zip';
  g.writeArchives(fullBundleZip(g.app));
  g.readIdentity = bundle => {
    assert.equal(bundle, g.reference, 'only the separately pinned prior reference supplies old publisher identity');
    return { bundleId: 'com.example.fixture', team: '4AR3Y8XD72', cdHash: 'c'.repeat(40) };
  };
  g.signatures = [];
  g.commands = (command, args) => {
    assert.equal(command, '/usr/bin/codesign');
    assert.deepEqual(args.slice(0, 3), ['--verify', '--deep', '--strict']);
    assert.ok([g.app, g.reference].includes(args[3]));
    assert.equal(args.length, 4);
    g.signatures.push(args[3]);
  };
  g.captureMixed = (options = {}, operations = fs, commands = g.commands, readIdentity = g.readIdentity) =>
    captureAppliedUpdateEvidence({ app: g.app, home: g.home, retainedArchiveReference: g.retained, ...options }, operations, commands, readIdentity);
  g.proveMixed = (evidence, overrides = {}, operations = fs) => verifyGuardedSealedPatch({
    app: g.app, home: g.home, shellSnapshot: g.snapshot, appliedUpdateEvidence: evidence,
    isRunning: () => false, isUpdaterRunning: () => false,
    verifyNativeSignature: bundle => { assert.ok([g.app, g.reference].includes(bundle)); g.signatures.push(bundle); },
    readReferenceCodeIdentity: g.readIdentity, ...overrides,
  }, operations);
  g.retainedBytes = () => [g.heldArchive, g.heldPair, g.heldMetadata, g.historicalPath]
    .map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
  return g;
}

function refusesMixedBeforeInstall(g, acquire) {
  const spy = forbiddenMutations();
  assert.throws(() => {
    const guarded = acquire(spy.operations);
    installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded }, spy.operations);
  }, /Refusing a guarded patch|signature failure/);
  assert.deepEqual(spy.calls, [], 'refusal precedes target staging/copy/backup/cleanup');
  assert.equal(fs.readFileSync(path.join(g.daemonDist, 'index.js'), 'utf8'), 'old daemon');
}

test('mixed retained generations require the actual applied shell, not merely the newer active archive', t => {
  const g = mixedAppliedGenerationsFixture(t);
  assert.throws(() => g.capture(), /differs from applied native shell/, 'without explicit old-generation proof the original policy still refuses');
  for (const [rel, bytes] of Object.entries(g.priorNative)) fs.writeFileSync(path.join(g.app, rel), bytes);
  refusesMixedBeforeInstall(g, operations => g.proveMixed(g.captureMixed({}, operations), {}, operations));
});

test('mixed retained generations admit exact pinned older full reference and preserve it through a real temporary patch', t => {
  const g = mixedAppliedGenerationsFixture(t);
  const retainedBefore = g.retainedBytes();
  const currentNativeBefore = SEALED_SHELL_PARTS.map(rel => [rel, fs.readFileSync(path.join(g.app, rel))]);
  const evidence = g.captureMixed();
  assert.equal(evidence.version, 2);
  assert.equal(evidence.identity.version, '3.18.38');
  assert.equal(evidence.retainedArchive.identity.version, '3.18.37');
  assert.equal(evidence.retainedArchive.codeIdentity.cdHash, g.retained.expectedReferenceCdHash);
  assert.deepEqual(evidence.retainedArchiveReference, g.retained);
  assert.deepEqual(new Set(g.signatures), new Set([g.app, g.reference]), 'both complete seals are inspected at capture');
  const guarded = g.proveMixed(evidence);
  const installed = installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded });
  assert.equal(fs.readFileSync(path.join(g.daemonDist, 'index.js'), 'utf8'), 'new daemon');
  assert.equal(fs.readFileSync(path.join(installed.backup, 'index.js'), 'utf8'), 'old daemon');
  assert.deepEqual(g.retainedBytes(), retainedBefore, 'old archive pair, metadata and history are retained exactly');
  for (const [rel, bytes] of currentNativeBefore) assert.deepEqual(fs.readFileSync(path.join(g.app, rel)), bytes);
  assert.doesNotThrow(() => g.proveMixed(evidence, { priorProof: guarded,
    verifyNativeSignature: bundle => assert.notEqual(bundle, g.app, 'patched current app cannot claim a pristine full seal') }));
});

test('mixed retained generations refuse missing, unknown or inconsistent independent pins before writes', async t => {
  for (const [label, change] of [
    ['missing historical hash', g => { delete g.retained.historicalSnapshotSha256; }],
    ['unknown option', g => { g.retained.allowOlder = true; }],
    ['wrong history hash', g => { g.retained.historicalSnapshotSha256 = '0'.repeat(64); }],
    ['wrong CDHash pin', g => { g.retained.expectedReferenceCdHash = 'd'.repeat(40); }],
    ['missing CDHash', g => { delete g.retained.expectedReferenceCdHash; }],
    ['another historical home', g => {
      const old = JSON.parse(fs.readFileSync(g.historicalPath, 'utf8')); old.appliedUpdateEvidence.home = path.join(g.root, 'another-home');
      fs.writeFileSync(g.historicalPath, JSON.stringify(old));
      g.retained.historicalSnapshotSha256 = createHash('sha256').update(fs.readFileSync(g.historicalPath)).digest('hex');
    }],
  ]) await t.test(label, t => {
    const g = mixedAppliedGenerationsFixture(t); change(g);
    refusesMixedBeforeInstall(g, operations => g.proveMixed(g.captureMixed({}, operations), {}, operations));
  });
});

test('mixed retained generations require a strictly older publisher-verified complete official archive reference', async t => {
  await t.test('future full signed generation', t => {
    const g = mixedAppliedGenerationsFixture(t, { priorVersion: '3.18.39' });
    refusesMixedBeforeInstall(g, operations => g.proveMixed(g.captureMixed({}, operations), {}, operations));
  });
  await t.test('same version is not an older-generation exception', t => {
    const g = mixedAppliedGenerationsFixture(t, { priorVersion: '3.18.38' });
    refusesMixedBeforeInstall(g, operations => g.proveMixed(g.captureMixed({}, operations), {}, operations));
  });
  await t.test('archive tamper with two matching newly computed checksums', t => {
    const g = mixedAppliedGenerationsFixture(t); const bytes = Buffer.concat([fs.readFileSync(g.heldArchive), Buffer.from('tamper')]);
    fs.writeFileSync(g.heldArchive, bytes); fs.writeFileSync(g.heldPair, bytes);
    const metadata = JSON.parse(fs.readFileSync(g.heldMetadata, 'utf8')); metadata.sha512 = createHash('sha512').update(bytes).digest('base64');
    fs.writeFileSync(g.heldMetadata, JSON.stringify(metadata));
    refusesMixedBeforeInstall(g, operations => g.proveMixed(g.captureMixed({}, operations), {}, operations));
  });
  await t.test('reference non-native resource differs from its archive', t => {
    const g = mixedAppliedGenerationsFixture(t);
    fs.appendFileSync(path.join(g.reference, 'Contents/Frameworks/Prior.framework/Versions/A/Prior'), 'changed');
    refusesMixedBeforeInstall(g, operations => g.proveMixed(g.captureMixed({}, operations), {}, operations));
  });
  await t.test('valid signature from another publisher', t => {
    const g = mixedAppliedGenerationsFixture(t);
    refusesMixedBeforeInstall(g, operations => g.proveMixed(g.captureMixed({}, operations, g.commands,
      () => ({ bundleId: 'com.example.fixture', team: 'ANOTHERSIGNER', cdHash: 'c'.repeat(40) })), {}, operations));
  });
  await t.test('old full signature fails', t => {
    const g = mixedAppliedGenerationsFixture(t);
    refusesMixedBeforeInstall(g, operations => g.proveMixed(g.captureMixed({}, operations, (_command, args) => {
      if (args[3] === g.reference) throw new Error('signature failure');
    }), {}, operations));
  });
});

test('mixed retained generations recheck history, cache, full reference and app/helper races before proof or writes', async t => {
  for (const [label, mutate] of [
    ['held cache changed', g => fs.appendFileSync(g.heldPair, 'changed')],
    ['history changed', g => fs.appendFileSync(g.historicalPath, ' ')],
    ['old full reference changed', g => fs.appendFileSync(path.join(g.reference, 'Contents/Frameworks/Prior.framework/Versions/A/Prior'), 'changed')],
  ]) await t.test(label, t => {
    const g = mixedAppliedGenerationsFixture(t); const evidence = g.captureMixed(); mutate(g);
    refusesMixedBeforeInstall(g, operations => g.proveMixed(evidence, {}, operations));
  });
  await t.test('reference changes across capture signature inspection', t => {
    const g = mixedAppliedGenerationsFixture(t);
    refusesMixedBeforeInstall(g, operations => g.proveMixed(g.captureMixed({}, operations, (command, args) => {
      g.commands(command, args);
      if (args[3] === g.reference) fs.appendFileSync(path.join(g.reference, 'Contents/Frameworks/Prior.framework/Versions/A/Prior'), 'changed');
    }), {}, operations));
  });
  for (const actor of ['app', 'helper']) await t.test(`${actor} starts across verification`, t => {
    const g = mixedAppliedGenerationsFixture(t); const evidence = g.captureMixed(); let running = false;
    refusesMixedBeforeInstall(g, operations => g.proveMixed(evidence, {
      isRunning: () => actor === 'app' && running,
      isUpdaterRunning: () => actor === 'helper' && running,
      verifyNativeSignature: () => { running = true; },
    }, operations));
  });
});

test('mixed retained generations never promote an old valid repeat chain into current native authority', t => {
  const g = mixedAppliedGenerationsFixture(t, { oldRepeat: true });
  const evidence = g.captureMixed();
  const spy = forbiddenMutations();
  assert.throws(() => {
    const guarded = g.proveMixed(evidence, { repeatedReference: g.repeat }, spy.operations);
    installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded }, spy.operations);
  }, /Refusing a guarded patch/);
  assert.deepEqual(spy.calls, [], 'old chain was valid for37 but cannot authorize38 mutation');
});
