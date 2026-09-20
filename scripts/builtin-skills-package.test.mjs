import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import afterPack from '../apps/desktop/build/after-pack.cjs';

const projectDir = path.resolve(import.meta.dirname, '../apps/desktop');
const packageJson = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));

test('desktop packaging includes the built-in instruction tree for every platform', () => {
  const entry = packageJson.build.extraResources.find(entry => entry.to === 'daemon/builtin-skills');
  assert(entry);
  assert.equal(path.resolve(projectDir, entry.from), path.resolve(projectDir, '../../builtin-skills'));
  assert.deepEqual(entry.filter, ['**/*']);
});

test('actual post-pack hook rejects missing or stale instruction bytes', async () => {
  // Package staging only: no daemon startup, home override, or runtime reset.
  const appOutDir = mkdtempSync(path.join(os.tmpdir(), 'clem-package-assets-'));
  const context = { appOutDir, electronPlatformName: 'win32', packager: { projectDir, appInfo: { productFilename: 'Clementine' } } };
  try {
    await assert.rejects(afterPack(context), /ENOENT/);
    const target = path.join(appOutDir, 'resources/daemon/builtin-skills');
    cpSync(path.resolve(projectDir, '../../builtin-skills'), target, { recursive: true });
    await afterPack(context);
    writeFileSync(path.join(target, 'workspace-builder/SKILL.md'), 'stale package');
    await assert.rejects(afterPack(context), /Packaged built-in skill differs/);
  } finally { rmSync(appOutDir, { recursive: true, force: true }); }
});
