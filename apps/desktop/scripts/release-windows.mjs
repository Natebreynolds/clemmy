#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPeX64,
  RECALL_NATIVE_MANIFEST,
  RECALL_NATIVE_SPECS,
  RECALL_SDK_COMMIT,
  RECALL_SDK_VERSION,
} from './vendor-recall-native.mjs';

const isWindows = process.platform === 'win32';
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.resolve(desktopDir, '..', '..');
const releaseDir = path.join(desktopDir, 'release');
const resourcesDir = path.join(releaseDir, 'win-unpacked', 'resources');
const unpackedExecutable = path.join(releaseDir, 'win-unpacked', 'Clementine.exe');
const WHISPER_VERSION = 'v1.9.1';
const WHISPER_COMMIT = 'f049fff95a089aa9969deb009cdd4892b3e74916';
const WHISPER_SOURCE_SHA256 = '279af4ce60dbf397362868f3bacc75b56a4332ac2541cae155070093f6aaf0e3';
const WHISPER_LICENSE_SHA256 = '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d';

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

function capture(command, args, cwd, opts = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, ...opts.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}: ${result.stderr || result.stdout || ''}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is missing or invalid at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function verifyPackagedFile(relativePath, message) {
  const fullPath = path.join(resourcesDir, relativePath);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    throw new Error(`${message}: ${fullPath}`);
  }
  console.log(`   ok: ${fullPath}`);
  return fullPath;
}

function verifyPackagedPeX64(relativePath, message) {
  const fullPath = verifyPackagedFile(relativePath, message);
  assertPeX64(fullPath);
  return fullPath;
}

function verifyPackagedSha256(relativePath, expectedSha256, message) {
  const fullPath = verifyPackagedFile(relativePath, message);
  const actualSha256 = createHash('sha256').update(readFileSync(fullPath)).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${message}: expected ${expectedSha256}, received ${actualSha256}`);
  }
}

function verifyWhisperPackaged() {
  const root = path.join('daemon', 'vendor', 'whisper', 'x86_64-pc-windows-msvc');
  const executable = verifyPackagedPeX64(
    path.join(root, 'whisper-cli.exe'),
    'vendored Windows whisper.cpp is missing from the packaged app',
  );
  verifyPackagedSha256(
    path.join(root, 'LICENSE.whisper.cpp'),
    WHISPER_LICENSE_SHA256,
    'whisper.cpp MIT license notice is missing from the packaged app',
  );
  const manifestPath = verifyPackagedFile(path.join(root, 'manifest.json'), 'whisper.cpp provenance manifest is missing');
  const manifest = readJson(manifestPath, 'whisper.cpp provenance manifest');
  if (
    manifest.schemaVersion !== 1
    || manifest.target !== 'x86_64-pc-windows-msvc'
    || manifest.whisperCppVersion !== WHISPER_VERSION
    || manifest.whisperCppCommit !== WHISPER_COMMIT
    || manifest.sourceArchiveSha256 !== WHISPER_SOURCE_SHA256
    || manifest.licenseSha256 !== WHISPER_LICENSE_SHA256
    || !Number.isSafeInteger(manifest.binaryBytes)
    || manifest.binaryBytes <= 0
    || !/^[a-f0-9]{64}$/.test(manifest.binarySha256)
  ) {
    throw new Error(`packaged whisper.cpp provenance is invalid: ${JSON.stringify(manifest)}`);
  }
  const versionOutput = capture(executable, ['--version'], path.dirname(executable));
  if (!versionOutput.includes('whisper.cpp version: 1.9.1')) {
    throw new Error(`packaged whisper.cpp reported an unexpected version: ${versionOutput.trim()}`);
  }
  console.log('   whisper.cpp: v1.9.1 (x64 executable + provenance verified)');
}

function verifyRecallPackaged() {
  const recallRoot = path.join('app.asar.unpacked', 'node_modules', '@recallai', 'desktop-sdk');
  const packagePath = verifyPackagedFile(path.join(recallRoot, 'package.json'), 'Recall Desktop SDK package is missing');
  const sdkPackage = readJson(packagePath, 'Recall Desktop SDK package');
  if (sdkPackage.version !== RECALL_SDK_VERSION || sdkPackage.commit_sha !== RECALL_SDK_COMMIT) {
    throw new Error(`packaged Recall SDK provenance is invalid: ${sdkPackage.version}/${sdkPackage.commit_sha}`);
  }
  const manifestPath = verifyPackagedFile(path.join(recallRoot, RECALL_NATIVE_MANIFEST), 'Recall native provenance manifest is missing');
  const manifest = readJson(manifestPath, 'Recall native provenance manifest');
  const spec = RECALL_NATIVE_SPECS.win32;
  if (
    manifest.schemaVersion !== 1
    || manifest.sdkVersion !== RECALL_SDK_VERSION
    || manifest.sdkCommit !== RECALL_SDK_COMMIT
    || manifest.platform !== 'win32'
    || manifest.archiveName !== spec.archiveName
    || manifest.archiveBytes !== spec.archiveBytes
    || manifest.archiveSha256 !== spec.archiveSha256
  ) {
    throw new Error(`packaged Recall native provenance is invalid: ${JSON.stringify(manifest)}`);
  }
  for (const relativePath of spec.architecturePaths) {
    verifyPackagedPeX64(path.join(recallRoot, ...relativePath.split('/')), `Recall native x64 file is missing: ${relativePath}`);
  }
  const support = capture(
    unpackedExecutable,
    [
      '--input-type=module',
      '-e',
      "const m=await import('./app.asar/dist/recall-capture.js'); process.stdout.write(String(m.getRecallPlatformSupport().supported));",
    ],
    resourcesDir,
    { env: { ELECTRON_RUN_AS_NODE: '1' } },
  ).trim();
  if (support !== 'true') throw new Error(`packaged Windows runtime reports Recall support=${support}`);
  console.log(`   Recall SDK: ${sdkPackage.version} (${sdkPackage.commit_sha.slice(0, 12)}, x64 native capture verified)`);
}

try {
  if (!isWindows) throw new Error('release-windows.mjs must run on 64-bit Windows.');
  rmSync(releaseDir, { recursive: true, force: true });
  runNpm(['run', 'vendor:recall-native', '--', '--platform', 'win32'], desktopDir);
  runNpm(['run', 'build'], desktopDir);
  runNpm(['run', 'build'], rootDir);
  runNpm(['run', 'build:mobile-web'], rootDir);
  runNpm(['run', 'build:console-web'], rootDir);
  runNpm(['run', 'vendor:uv'], rootDir);
  runNpm(['run', 'vendor:whisper', '--', '--target', 'x86_64-pc-windows-msvc', '--force'], rootDir);

  run(process.execPath, [path.join(desktopDir, 'scripts', 'rebuild-daemon-natives.mjs'), '--arch', 'x64'], desktopDir);
  run(desktopBin('electron-builder'), ['--win', 'nsis', '--x64', '--publish', 'never'], desktopDir);

  verifyPackagedFile(
    path.join('daemon', 'vendor', 'uv', 'x86_64-pc-windows-msvc', 'uv.exe'),
    'vendored Windows uv is missing from the packaged app',
  );
  verifyWhisperPackaged();
  verifyRecallPackaged();
  verifyPackagedFile(
    path.join('daemon', 'apps', 'console-web', 'dist', 'index.html'),
    'console-web dist is missing from the packaged app',
  );
} finally {
  runNpm(['rebuild', 'better-sqlite3'], rootDir, { allowFailure: true });
}
