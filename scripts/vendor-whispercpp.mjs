#!/usr/bin/env node
/**
 * Build the pinned whisper.cpp CLI for one Clementine desktop target.
 *
 * The source archive is addressed by a full signed-release commit and verified
 * before extraction. GGML_NATIVE is disabled so release binaries never inherit
 * instructions from the CI host CPU. Libraries (including Metal shaders) are
 * linked/embedded so the vendored directory contains one runtime executable.
 *
 * Usage:
 *   node scripts/vendor-whispercpp.mjs
 *   node scripts/vendor-whispercpp.mjs --target aarch64-apple-darwin
 *   node scripts/vendor-whispercpp.mjs --target x86_64-apple-darwin --force
 *   node scripts/vendor-whispercpp.mjs --target x86_64-pc-windows-msvc
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_SOURCE = path.join(ROOT, 'src', 'integrations', 'local-meetings', 'whisper-runtime.ts');
const VENDOR_ROOT = path.join(ROOT, 'vendor', 'whisper');

// SHA-256 of codeload.github.com/ggml-org/whisper.cpp/tar.gz/<pinned commit>.
// Bump only after verifying the new signed release and archive independently.
const SOURCE_ARCHIVE_SHA256 = '279af4ce60dbf397362868f3bacc75b56a4332ac2541cae155070093f6aaf0e3';
const UPSTREAM_LICENSE_FILE = 'LICENSE.whisper.cpp';
const UPSTREAM_LICENSE_SHA256 = '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d';
const SUPPORTED_TARGETS = new Set([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
]);

function readRuntimePin(name) {
  const source = readFileSync(RUNTIME_SOURCE, 'utf8');
  const match = source.match(new RegExp(`export const ${name} = '([^']+)'`));
  if (!match) throw new Error(`Could not read ${name} from ${path.relative(ROOT, RUNTIME_SOURCE)}`);
  return match[1];
}

const VERSION = readRuntimePin('WHISPER_CPP_VERSION');
const COMMIT = readRuntimePin('WHISPER_CPP_COMMIT');
const SOURCE_URL = `https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/${COMMIT}`;

function hostTarget() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin';
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-pc-windows-msvc';
  return undefined;
}

function requestedTarget() {
  const equals = process.argv.find((arg) => arg.startsWith('--target='));
  if (equals) return equals.slice('--target='.length);
  const index = process.argv.indexOf('--target');
  if (index >= 0) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--target requires a value.');
    return value;
  }
  return process.env.WHISPER_TARGET || hostTarget();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...options.env },
    shell: false,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout || ''}` : '';
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}.${detail}`);
  }
  return result;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function download(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 32 * 1024 * 1024) throw new Error(`Source archive unexpectedly exceeded 32 MiB (${bytes.length} bytes).`);
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delay = 1_000 * 2 ** (attempt - 1);
        console.log(`  retry ${attempt}/${attempts - 1} in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

function findFile(root, fileName) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === fileName) return full;
    }
  }
  return undefined;
}

function baseManifest(target) {
  return {
    schemaVersion: 1,
    target,
    whisperCppVersion: VERSION,
    whisperCppCommit: COMMIT,
    sourceArchiveSha256: SOURCE_ARCHIVE_SHA256,
    licenseFile: UPSTREAM_LICENSE_FILE,
    licenseSha256: UPSTREAM_LICENSE_SHA256,
    ggmlNative: false,
    ggmlBlas: false,
    staticLibraries: true,
    metalEmbedded: target.endsWith('apple-darwin'),
  };
}

function expectedManifest(target, binary) {
  return {
    ...baseManifest(target),
    binaryBytes: binary.bytes,
    binarySha256: binary.sha256,
  };
}

function binaryProvenance(binary) {
  return {
    bytes: statSync(binary).size,
    sha256: sha256(readFileSync(binary)),
  };
}

function assertPeX64(binary) {
  const bytes = readFileSync(binary);
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error(`Built ${binary} is not a PE executable.`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset > bytes.length - 6
    || bytes.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0'
    || bytes.readUInt16LE(peOffset + 4) !== 0x8664
  ) {
    throw new Error(`Built ${binary} is not an x86-64 PE executable.`);
  }
}

function canExecuteTarget(target) {
  if (target === 'aarch64-apple-darwin') return process.platform === 'darwin' && process.arch === 'arm64';
  if (target === 'x86_64-apple-darwin') return process.platform === 'darwin' && process.arch === 'x64';
  return target === 'x86_64-pc-windows-msvc' && process.platform === 'win32' && process.arch === 'x64';
}

function verifyBuiltVersion(binary, target, requireExecution = false) {
  if (!requireExecution && !canExecuteTarget(target)) return;
  const result = run(binary, ['--version'], { capture: true });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const expected = VERSION.replace(/^v/, '');
  if (!output.includes(`whisper.cpp version: ${expected}`)) {
    throw new Error(`Built ${binary} did not report whisper.cpp version ${expected}.`);
  }
}

function alreadyCurrent(target, requireVersion = false) {
  const destination = path.join(VENDOR_ROOT, target);
  const binary = path.join(destination, target.endsWith('windows-msvc') ? 'whisper-cli.exe' : 'whisper-cli');
  const manifestPath = path.join(destination, 'manifest.json');
  const licensePath = path.join(destination, UPSTREAM_LICENSE_FILE);
  if (!existsSync(binary) || !existsSync(manifestPath) || !existsSync(licensePath)) return false;
  try {
    const actual = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const expected = expectedManifest(target, binaryProvenance(binary));
    if (
      JSON.stringify(actual) !== JSON.stringify(expected)
      || sha256(readFileSync(licensePath)) !== UPSTREAM_LICENSE_SHA256
    ) return false;
    verifyBuiltArchitecture(binary, target);
    verifyBuiltVersion(binary, target, requireVersion);
    return true;
  } catch {
    return false;
  }
}

/**
 * One-time migration for unsigned local rehearsals built earlier in the same
 * checkout. A legacy manifest can gain binary hash/size fields only after the
 * executable itself proves its architecture and version. Production releases
 * never call this path; they force a clean source build.
 */
function adoptValidatedLegacyCache(target) {
  const destination = path.join(VENDOR_ROOT, target);
  const binary = path.join(destination, target.endsWith('windows-msvc') ? 'whisper-cli.exe' : 'whisper-cli');
  const manifestPath = path.join(destination, 'manifest.json');
  const licensePath = path.join(destination, UPSTREAM_LICENSE_FILE);
  if (!existsSync(binary) || !existsSync(manifestPath) || !existsSync(licensePath)) return false;
  try {
    const legacyManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (JSON.stringify(legacyManifest) !== JSON.stringify(baseManifest(target))) return false;
    if (sha256(readFileSync(licensePath)) !== UPSTREAM_LICENSE_SHA256) return false;
    verifyBuiltArchitecture(binary, target);
    // Adoption is intentionally stricter than ordinary cross-target cache
    // inspection: if this host cannot execute the binary, it must rebuild.
    verifyBuiltVersion(binary, target, true);
    const provenance = binaryProvenance(binary);
    if (
      !Number.isSafeInteger(provenance.bytes)
      || provenance.bytes < 1024 * 1024
      || provenance.bytes > 64 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(provenance.sha256)
    ) return false;
    const partPath = `${manifestPath}.${process.pid}.${randomUUID()}.part`;
    try {
      writeFileSync(partPath, `${JSON.stringify(expectedManifest(target, provenance), null, 2)}\n`, {
        mode: 0o644,
        flag: 'wx',
      });
      renameSync(partPath, manifestPath);
    } finally {
      rmSync(partPath, { force: true });
    }
    if (!alreadyCurrent(target, true)) throw new Error(`Whisper cache manifest migration did not validate for ${target}.`);
    console.log(`✓ adopted validated whisper.cpp ${VERSION} cache for unsigned rehearsal (${target})`);
    return true;
  } catch (error) {
    console.warn(`  cached whisper.cpp ${target} was not adoptable: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function assertBuildHost(target) {
  if (target.endsWith('apple-darwin') && process.platform !== 'darwin') {
    throw new Error(`${target} must be built on macOS.`);
  }
  if (target.endsWith('windows-msvc') && (process.platform !== 'win32' || process.arch !== 'x64')) {
    throw new Error(`${target} must be built on 64-bit Windows.`);
  }
}

function verifyBuiltArchitecture(binary, target) {
  if (target.endsWith('apple-darwin')) {
    const expected = target.startsWith('aarch64') ? 'arm64' : 'x86_64';
    const result = run('lipo', ['-archs', binary], { capture: true });
    const architectures = String(result.stdout || '').trim().split(/\s+/);
    if (!architectures.includes(expected)) {
      throw new Error(`Built ${binary} for ${architectures.join(', ') || 'unknown architecture'}, expected ${expected}.`);
    }
    return;
  }
  assertPeX64(binary);
}

async function vendor(target, force, adoptValidatedCache) {
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`Unsupported target "${target || '(none)'}". Choose one of: ${[...SUPPORTED_TARGETS].join(', ')}.`);
  }
  assertBuildHost(target);
  if (!force && alreadyCurrent(target, adoptValidatedCache)) {
    console.log(`✓ whisper.cpp ${VERSION} for ${target} is already vendored`);
    return;
  }
  if (!force && adoptValidatedCache && adoptValidatedLegacyCache(target)) return;

  run('cmake', ['--version'], { capture: true });
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clementine-whisper-build-'));
  const archivePath = path.join(temp, 'whisper.cpp.tar.gz');
  const sourceDir = path.join(temp, 'source');
  const buildDir = path.join(temp, 'build');
  try {
    console.log(`↓ whisper.cpp ${VERSION} source (${COMMIT.slice(0, 12)})`);
    const archive = await download(SOURCE_URL);
    const digest = sha256(archive);
    if (digest !== SOURCE_ARCHIVE_SHA256) {
      throw new Error(`Source archive checksum mismatch: expected ${SOURCE_ARCHIVE_SHA256}, received ${digest}.`);
    }
    writeFileSync(archivePath, archive, { mode: 0o600 });
    mkdirSync(sourceDir, { recursive: true });
    run('tar', ['-xzf', archivePath, '-C', sourceDir, '--strip-components=1']);
    const sourceLicense = path.join(sourceDir, 'LICENSE');
    if (!existsSync(sourceLicense) || sha256(readFileSync(sourceLicense)) !== UPSTREAM_LICENSE_SHA256) {
      throw new Error('Pinned whisper.cpp LICENSE is missing or has an unexpected checksum.');
    }

    const configureArgs = [
      '-S', sourceDir,
      '-B', buildDir,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DBUILD_SHARED_LIBS=OFF',
      '-DGGML_NATIVE=OFF',
      '-DGGML_BLAS=OFF',
      '-DGGML_OPENMP=OFF',
      '-DWHISPER_BUILD_TESTS=OFF',
      '-DWHISPER_BUILD_EXAMPLES=ON',
      '-DWHISPER_BUILD_SERVER=OFF',
      '-DWHISPER_SDL2=OFF',
    ];
    if (target.endsWith('apple-darwin')) {
      const architecture = target.startsWith('aarch64') ? 'arm64' : 'x86_64';
      configureArgs.push(
        `-DCMAKE_OSX_ARCHITECTURES=${architecture}`,
        '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0',
        '-DGGML_METAL=ON',
        '-DGGML_METAL_EMBED_LIBRARY=ON',
        '-DGGML_METAL_MACOSX_VERSION_MIN=12.0',
      );
    }

    console.log(`→ configuring ${target}`);
    run('cmake', configureArgs);
    console.log(`→ building whisper-cli for ${target}`);
    run('cmake', ['--build', buildDir, '--config', 'Release', '--target', 'whisper-cli', '--parallel']);

    const binaryName = target.endsWith('windows-msvc') ? 'whisper-cli.exe' : 'whisper-cli';
    const builtBinary = findFile(path.join(buildDir, 'bin'), binaryName);
    if (!builtBinary) throw new Error(`${binaryName} was not found under ${path.join(buildDir, 'bin')}.`);
    verifyBuiltArchitecture(builtBinary, target);

    const destination = path.join(VENDOR_ROOT, target);
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    const finalBinary = path.join(destination, binaryName);
    copyFileSync(builtBinary, finalBinary);
    if (!target.endsWith('windows-msvc')) chmodSync(finalBinary, 0o755);
    verifyBuiltArchitecture(finalBinary, target);
    verifyBuiltVersion(finalBinary, target);
    copyFileSync(sourceLicense, path.join(destination, UPSTREAM_LICENSE_FILE));
    writeFileSync(
      path.join(destination, 'manifest.json'),
      `${JSON.stringify(expectedManifest(target, binaryProvenance(finalBinary)), null, 2)}\n`,
      { mode: 0o644 },
    );
    console.log(`✓ vendored ${path.relative(ROOT, finalBinary)}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const target = requestedTarget();
if (!target) {
  console.error(`vendor-whispercpp: this host (${process.platform}/${process.arch}) has no default target; pass --target.`);
  process.exit(1);
}

vendor(
  target,
  process.argv.includes('--force'),
  process.argv.includes('--adopt-validated-cache'),
).catch((error) => {
  console.error(`vendor-whispercpp failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
