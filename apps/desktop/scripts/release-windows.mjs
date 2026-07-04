#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.resolve(desktopDir, '..', '..');
const releaseDir = path.join(desktopDir, 'release');

function bin(name) {
  return isWindows ? `${name}.cmd` : name;
}

function desktopBin(name) {
  return path.join(desktopDir, 'node_modules', '.bin', isWindows ? `${name}.cmd` : name);
}

function run(command, args, cwd, opts = {}) {
  console.log(`-> ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: isWindows, env: { ...process.env, ...opts.env } });
  if (result.status !== 0) {
    if (opts.allowFailure) return result.status;
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
  return 0;
}

function runNpm(args, cwd, opts = {}) {
  return run(bin('npm'), args, cwd, opts);
}

function verifyPackagedFile(relativePath, message) {
  const fullPath = path.join(releaseDir, 'win-unpacked', 'resources', relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`${message}: ${fullPath}`);
  }
  console.log(`   ok: ${fullPath}`);
}

try {
  runNpm(['run', 'build'], desktopDir);
  runNpm(['run', 'build'], rootDir);
  runNpm(['run', 'build:mobile-web'], rootDir);
  runNpm(['run', 'build:console-web'], rootDir);
  runNpm(['run', 'vendor:uv'], rootDir);

  run(process.execPath, [path.join(desktopDir, 'scripts', 'rebuild-daemon-natives.mjs'), '--arch', 'x64'], desktopDir);
  run(desktopBin('electron-builder'), ['--win', 'nsis', '--x64', '--publish', 'never'], desktopDir);

  verifyPackagedFile(
    path.join('daemon', 'vendor', 'uv', 'x86_64-pc-windows-msvc', 'uv.exe'),
    'vendored Windows uv is missing from the packaged app',
  );
  verifyPackagedFile(
    path.join('daemon', 'apps', 'console-web', 'dist', 'index.html'),
    'console-web dist is missing from the packaged app',
  );
} finally {
  runNpm(['rebuild', 'better-sqlite3'], rootDir, { allowFailure: true });
}
