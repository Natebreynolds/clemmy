import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installBundledAssetDirectory, installDaemonPatch, resolveInstalledAppBundle } from './hotpatch-daemon.mjs';

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
