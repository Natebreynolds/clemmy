#!/usr/bin/env node
/**
 * Package the Linux AppImage. The desktop build config in package.json is
 * shared by every platform; entries that only exist on a Mac build machine
 * (vendored Apple binaries) are left out when their source is absent, and
 * everything else is passed to electron-builder unchanged.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(desktopDir, 'release');
const pkg = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
const build = { ...pkg.build };
const kept = [];
const dropped = [];
for (const entry of build.extraResources ?? []) {
  const from = typeof entry === 'string' ? entry : entry.from;
  if (existsSync(path.resolve(desktopDir, from))) kept.push(entry); else dropped.push(from);
}
build.extraResources = kept;
build.linux = { ...(build.linux ?? {}), target: ['AppImage'], category: 'Utility', artifactName: '${productName}-${version}-${arch}.${ext}' };
mkdirSync(releaseDir, { recursive: true });
const configFile = path.join(releaseDir, 'linux-builder.json');
writeFileSync(configFile, JSON.stringify(build, null, 2));
console.log(`linux config: ${kept.length} extra resources kept, ${dropped.length} absent on this machine${dropped.length ? ` (${dropped.join(', ')})` : ''}`);
const bin = path.join(desktopDir, 'node_modules', '.bin', 'electron-builder');
const result = spawnSync(bin, ['--linux', 'AppImage', '--config', configFile, '--publish', 'never'], { cwd: desktopDir, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const images = readdirSync(releaseDir).filter((name) => name.endsWith('.AppImage'));
if (images.length === 0) { console.error('no AppImage was produced'); process.exit(1); }
for (const name of images) console.log(`${name}  ${(statSync(path.join(releaseDir, name)).size / 1e6).toFixed(1)} MB`);
