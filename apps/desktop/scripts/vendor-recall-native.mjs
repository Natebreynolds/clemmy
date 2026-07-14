#!/usr/bin/env node

/**
 * Install the native payload for the exactly pinned Recall Desktop SDK.
 *
 * Recall's npm package downloads a second, mutable S3 artifact from its install
 * script without verifying a checksum. Desktop releases use this preflight so
 * the native recorder is covered by an explicit size + SHA-256 allowlist before
 * electron-builder signs and packages it.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { t as listTar, x as extractTar } from 'tar';

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_ROOT = path.join(DESKTOP_DIR, 'node_modules', '@recallai', 'desktop-sdk');
const SDK_PACKAGE_FILES = [
  'CHANGELOG.md',
  'README.md',
  'index.d.ts',
  'index.js',
  'package.json',
  'setup.js',
];

export const RECALL_SDK_VERSION = '2.0.25';
export const RECALL_SDK_COMMIT = '90d670e842200a4d546cbe36cc0b9c48fbe6a204';
export const RECALL_NATIVE_MANIFEST = 'clementine-native-manifest.json';

const NATIVE_BASE_URL = 'https://recallai-desktop-sdk-releases.s3.us-east-1.amazonaws.com';
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1_000;
const DOWNLOAD_ATTEMPTS = 3;
const MAX_ARCHIVE_ENTRIES = 2_048;

export const RECALL_NATIVE_SPECS = Object.freeze({
  darwin: Object.freeze({
    platform: 'darwin',
    archiveName: 'desktop_sdk_macos.tar',
    archiveBytes: 50_971_984,
    archiveSha256: 'e3125c49cdf6d54593e6334024df2ecbed99e0c6b1d2e410a4187ab19421433b',
    maxExtractedBytes: 512 * 1024 * 1024,
    requiredPaths: [
      'desktop_sdk_macos_exe',
      'Frameworks/libui_recorder.dylib',
      'Frameworks/liblibbot_desktop_rs.dylib',
      'Frameworks/GStreamer.framework/GStreamer',
    ],
    architecturePaths: [
      'desktop_sdk_macos_exe',
      'Frameworks/libui_recorder.dylib',
      'Frameworks/liblibbot_desktop_rs.dylib',
    ],
  }),
  win32: Object.freeze({
    platform: 'win32',
    archiveName: 'desktop_sdk_win32.tar',
    archiveBytes: 39_218_499,
    archiveSha256: 'c761d9dd3c82ab77d7eaf3a3c303c354bc92dbe2946244bb54689bb53322b5ba',
    maxExtractedBytes: 384 * 1024 * 1024,
    requiredPaths: [
      'agent-windows.exe',
      'libbot_desktop_rs.dll',
      'gstreamer-1.0-0.dll',
      'gstreamer-1.0/gstcoreelements.dll',
    ],
    architecturePaths: [
      'agent-windows.exe',
      'libbot_desktop_rs.dll',
      'gstreamer-1.0-0.dll',
      'gstreamer-1.0/gstcoreelements.dll',
    ],
  }),
});

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function archiveUrl(spec) {
  return `${NATIVE_BASE_URL}/${RECALL_SDK_COMMIT}/${spec.archiveName}`;
}

function normalizedArchivePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) {
    throw new Error(`Unsafe Recall archive path: ${JSON.stringify(value)}`);
  }
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`Recall archive path must be relative: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Recall archive path escapes the extraction root: ${value}`);
  }
  return normalized;
}

export function assertSafeArchiveEntry(entry) {
  const normalized = normalizedArchivePath(entry.path);
  const allowedTypes = new Set(['Directory', 'File', 'SymbolicLink']);
  if (!allowedTypes.has(entry.type)) {
    throw new Error(`Recall archive contains unsupported ${entry.type} entry: ${entry.path}`);
  }
  if ((Number(entry.mode) & 0o6000) !== 0) {
    throw new Error(`Recall archive entry has setuid/setgid bits: ${entry.path}`);
  }
  if (entry.type === 'SymbolicLink') {
    const linkPath = normalizedArchivePath(entry.linkpath);
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(normalized), linkPath));
    if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
      throw new Error(`Recall archive symlink escapes the extraction root: ${entry.path} -> ${entry.linkpath}`);
    }
  }
  return normalized;
}

export function assertMachOArm64(filePath) {
  const bytes = readFileSync(filePath);
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) {
    throw new Error(`Recall native file is not a thin arm64 Mach-O: ${filePath}`);
  }
}

export function assertPeX64(filePath) {
  const bytes = readFileSync(filePath);
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error(`Native file is not a PE executable: ${filePath}`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset > bytes.length - 6
    || bytes.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0'
    || bytes.readUInt16LE(peOffset + 4) !== 0x8664
  ) {
    throw new Error(`Native file is not x86-64 PE: ${filePath}`);
  }
}

function assertPinnedSdkPackage(sdkRoot = SDK_ROOT) {
  const desktopPackage = readJson(path.join(DESKTOP_DIR, 'package.json'));
  const declared = desktopPackage.optionalDependencies?.['@recallai/desktop-sdk'];
  if (declared !== RECALL_SDK_VERSION) {
    throw new Error(`Desktop package must pin @recallai/desktop-sdk exactly to ${RECALL_SDK_VERSION}; received ${declared ?? '(missing)'}.`);
  }
  const sdkPackagePath = path.join(sdkRoot, 'package.json');
  if (!existsSync(sdkPackagePath)) {
    throw new Error(`Recall Desktop SDK is not installed at ${sdkRoot}; run npm ci in apps/desktop first.`);
  }
  const sdkPackage = readJson(sdkPackagePath);
  if (sdkPackage.version !== RECALL_SDK_VERSION || sdkPackage.commit_sha !== RECALL_SDK_COMMIT) {
    throw new Error(
      `Installed Recall SDK provenance mismatch: expected ${RECALL_SDK_VERSION}/${RECALL_SDK_COMMIT}, `
      + `received ${sdkPackage.version ?? '(missing)'}/${sdkPackage.commit_sha ?? '(missing)'}.`,
    );
  }
}

function assertRequiredFile(root, relativePath) {
  const candidate = path.join(root, ...relativePath.split('/'));
  const rootReal = realpathSync(root);
  const candidateReal = realpathSync(candidate);
  if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error(`Recall native path resolves outside the SDK: ${relativePath}`);
  }
  if (!statSync(candidateReal).isFile()) {
    throw new Error(`Recall native path is not a regular file: ${relativePath}`);
  }
  return candidateReal;
}

export function validateNativePayload(root, platform) {
  const spec = RECALL_NATIVE_SPECS[platform];
  if (!spec) throw new Error(`Recall native payload is unsupported on ${platform}.`);
  for (const relativePath of spec.requiredPaths) assertRequiredFile(root, relativePath);
  for (const relativePath of spec.architecturePaths) {
    const candidate = assertRequiredFile(root, relativePath);
    if (platform === 'darwin') assertMachOArm64(candidate);
    else assertPeX64(candidate);
  }
}

async function inspectArchive(archivePath, spec) {
  let entries = 0;
  let extractedBytes = 0;
  await listTar({
    file: archivePath,
    strict: true,
    onReadEntry(entry) {
      assertSafeArchiveEntry(entry);
      entries += 1;
      extractedBytes += Number(entry.size) || 0;
      if (entries > MAX_ARCHIVE_ENTRIES) throw new Error(`Recall archive exceeded ${MAX_ARCHIVE_ENTRIES} entries.`);
      if (extractedBytes > spec.maxExtractedBytes) {
        throw new Error(`Recall archive exceeded the ${spec.maxExtractedBytes}-byte extraction limit.`);
      }
      entry.resume();
    },
  });
  if (entries === 0) throw new Error('Recall native archive was empty.');
}

async function downloadOnce(url, destination, spec) {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await fetch(url, { redirect: 'follow', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  if (!response.body) throw new Error('Recall native download returned no body.');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== spec.archiveBytes) {
    throw new Error(`Recall archive size header mismatch: expected ${spec.archiveBytes}, received ${contentLength}.`);
  }

  const file = await open(destination, 'wx', 0o600);
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let bytesWritten = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value?.byteLength) continue;
      bytesWritten += chunk.value.byteLength;
      if (bytesWritten > spec.archiveBytes) {
        throw new Error(`Recall archive exceeded the ${spec.archiveBytes}-byte allowlist.`);
      }
      hash.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        const result = await file.write(chunk.value, offset, chunk.value.byteLength - offset);
        if (result.bytesWritten <= 0) throw new Error('Recall native download stopped making write progress.');
        offset += result.bytesWritten;
      }
    }
    await file.sync();
  } finally {
    await reader.cancel().catch(() => undefined);
    await file.close().catch(() => undefined);
  }
  if (bytesWritten !== spec.archiveBytes) {
    throw new Error(`Recall archive was incomplete: expected ${spec.archiveBytes} bytes, received ${bytesWritten}.`);
  }
  const digest = hash.digest('hex');
  if (digest !== spec.archiveSha256) {
    throw new Error(`Recall archive checksum mismatch: expected ${spec.archiveSha256}, received ${digest}.`);
  }
}

async function downloadPinnedArchive(destination, spec) {
  const url = archiveUrl(spec);
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    rmSync(destination, { force: true });
    try {
      await downloadOnce(url, destination, spec);
      return url;
    } catch (error) {
      lastError = error;
      rmSync(destination, { force: true });
      if (attempt < DOWNLOAD_ATTEMPTS) {
        const delay = 1_000 * 2 ** (attempt - 1);
        console.warn(`  Recall native download attempt ${attempt} failed; retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

function copySdkPackageFiles(sourceRoot, destinationRoot) {
  mkdirSync(destinationRoot, { recursive: true, mode: 0o755 });
  for (const relativePath of SDK_PACKAGE_FILES) {
    const source = path.join(sourceRoot, relativePath);
    if (!lstatSync(source).isFile()) throw new Error(`Recall SDK package file is missing or unsafe: ${source}`);
    copyFileSync(source, path.join(destinationRoot, relativePath));
  }
}

function installAtomically(stagedSdk, sdkRoot) {
  const backup = `${sdkRoot}.clementine-backup-${process.pid}-${randomUUID()}`;
  renameSync(sdkRoot, backup);
  try {
    renameSync(stagedSdk, sdkRoot);
  } catch (error) {
    renameSync(backup, sdkRoot);
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
}

export async function vendorRecallNative(platform = process.platform, options = {}) {
  if (platform === 'linux') {
    console.log('ℹ Recall Desktop SDK native capture is not packaged on Linux; skipping native vendoring.');
    return { skipped: true, platform };
  }
  const spec = RECALL_NATIVE_SPECS[platform];
  if (!spec) throw new Error(`Recall Desktop SDK native vendoring is unsupported on ${platform}.`);
  const sdkRoot = options.sdkRoot ? path.resolve(options.sdkRoot) : SDK_ROOT;
  assertPinnedSdkPackage(sdkRoot);

  const parent = path.dirname(sdkRoot);
  const stageRoot = mkdtempSync(path.join(parent, '.clementine-recall-native-'));
  const stagedSdk = path.join(stageRoot, 'package');
  const archivePath = path.join(stageRoot, spec.archiveName);
  try {
    copySdkPackageFiles(sdkRoot, stagedSdk);
    console.log(`↓ Recall Desktop SDK ${RECALL_SDK_VERSION} native payload (${platform})`);
    const url = await downloadPinnedArchive(archivePath, spec);
    await inspectArchive(archivePath, spec);
    await extractTar({
      file: archivePath,
      cwd: stagedSdk,
      strict: true,
      preservePaths: false,
      filter(_entryPath, entry) {
        assertSafeArchiveEntry(entry);
        return true;
      },
    });
    validateNativePayload(stagedSdk, platform);
    writeFileSync(path.join(stagedSdk, RECALL_NATIVE_MANIFEST), `${JSON.stringify({
      schemaVersion: 1,
      sdkVersion: RECALL_SDK_VERSION,
      sdkCommit: RECALL_SDK_COMMIT,
      platform,
      archiveName: spec.archiveName,
      archiveBytes: spec.archiveBytes,
      archiveSha256: spec.archiveSha256,
      sourceUrl: url,
    }, null, 2)}\n`, { mode: 0o644 });
    installAtomically(stagedSdk, sdkRoot);
    validateNativePayload(sdkRoot, platform);
    console.log(`✓ verified and installed Recall native payload for ${platform}`);
    return { skipped: false, platform, sdkRoot, archiveSha256: spec.archiveSha256 };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

function requestedPlatform() {
  const equals = process.argv.find((arg) => arg.startsWith('--platform='));
  if (equals) return equals.slice('--platform='.length);
  const index = process.argv.indexOf('--platform');
  if (index >= 0) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--platform requires a value.');
    return value;
  }
  return process.platform;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  vendorRecallNative(requestedPlatform()).catch((error) => {
    console.error(`vendor-recall-native failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
