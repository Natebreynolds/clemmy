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
