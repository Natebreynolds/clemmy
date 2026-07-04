#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const isWindows = process.platform === 'win32';
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.resolve(desktopDir, '..', '..');
const requireFromDesktop = createRequire(path.join(desktopDir, 'package.json'));
const electronVersion = requireFromDesktop('electron/package.json').version;

function bin(name) {
  return path.join(desktopDir, 'node_modules', '.bin', isWindows ? `${name}.cmd` : name);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: isWindows });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
}

const passthrough = process.argv.slice(2);
run(bin('electron-rebuild'), [
  '--version',
  electronVersion,
  '--module-dir',
  rootDir,
  '--types',
  'prod',
  '--force',
  '--only',
  'better-sqlite3',
  ...passthrough,
], rootDir);
