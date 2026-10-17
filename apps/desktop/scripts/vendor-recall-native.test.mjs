import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertMachOArm64,
  assertPeX64,
  assertSafeArchiveEntry,
  RECALL_NATIVE_SPECS,
  RECALL_SDK_COMMIT,
  RECALL_SDK_VERSION,
  validatePackagedRecallNative,
  vendorRecallNative,
} from './vendor-recall-native.mjs';

test('Recall native release provenance stays exactly pinned', () => {
  assert.equal(RECALL_SDK_VERSION, '2.0.39');
  assert.equal(RECALL_SDK_COMMIT, '537d82df7142fd8a613616ba3f12e70c3c79f3ab');
  assert.deepEqual(
    {
      bytes: RECALL_NATIVE_SPECS.darwin.archiveBytes,
      sha256: RECALL_NATIVE_SPECS.darwin.archiveSha256,
    },
    {
      bytes: 52_689_730,
      sha256: 'b360882d13344f8406849cffa82e93bb0c14955428fc84374d5dadbb9c9b1d18',
    },
  );
  assert.deepEqual(
    {
      bytes: RECALL_NATIVE_SPECS.win32.archiveBytes,
      sha256: RECALL_NATIVE_SPECS.win32.archiveSha256,
    },
    {
      bytes: 41_431_019,
      sha256: 'c3d0ef6e3c2271622eeadc9a8ed5ec03c1805423526520ceacf789b32745d126',
    },
  );
});

test('Recall native vendoring refuses an old SDK or mismatched commit before downloading', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clementine-recall-provenance-test-'));
  try {
    for (const sdkPackage of [
      { version: '2.0.25', commit_sha: '90d670e842200a4d546cbe36cc0b9c48fbe6a204' },
      { version: RECALL_SDK_VERSION, commit_sha: '0000000000000000000000000000000000000000' },
    ]) {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify(sdkPackage));
      await assert.rejects(vendorRecallNative('darwin', { sdkRoot: root }), /Installed Recall SDK provenance mismatch/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packaged release validation rejects stale SDK, manifest drift and incompatible native architecture', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clementine-recall-packaged-test-'));
  const spec = RECALL_NATIVE_SPECS.darwin;
  const sdkPackage = { version: RECALL_SDK_VERSION, commit_sha: RECALL_SDK_COMMIT };
  const manifest = {
    schemaVersion: 1, sdkVersion: RECALL_SDK_VERSION, sdkCommit: RECALL_SDK_COMMIT, platform: 'darwin',
    archiveName: spec.archiveName, archiveBytes: spec.archiveBytes, archiveSha256: spec.archiveSha256,
    sourceUrl: `https://recallai-desktop-sdk-releases.s3.us-east-1.amazonaws.com/${RECALL_SDK_COMMIT}/${spec.archiveName}`,
  };
  const saveManifest = (value) => writeFileSync(path.join(root, 'clementine-native-manifest.json'), JSON.stringify(value));
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(sdkPackage));
    saveManifest(manifest);
    const macho = Buffer.alloc(8);
    macho.writeUInt32LE(0xfeedfacf, 0);
    macho.writeUInt32LE(0x0100000c, 4);
    for (const relative of spec.requiredPaths) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, macho);
    }
    assert.doesNotThrow(() => validatePackagedRecallNative(root, 'darwin'));
    for (const drift of [
      { schemaVersion: 2 }, { sdkVersion: '2.0.25' }, { sdkCommit: '0'.repeat(40) },
      { platform: 'win32' }, { archiveName: 'different.tar' }, { archiveBytes: spec.archiveBytes + 1 },
      { archiveSha256: '0'.repeat(64) }, { sourceUrl: 'https://example.invalid/native.tar' },
    ]) {
      saveManifest({ ...manifest, ...drift });
      assert.throws(() => validatePackagedRecallNative(root, 'darwin'), /manifest does not match/);
    }
    saveManifest(manifest);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...sdkPackage, version: '2.0.25' }));
    assert.throws(() => validatePackagedRecallNative(root, 'darwin'), /SDK provenance/);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(sdkPackage));
    macho.writeUInt32LE(0x01000007, 4);
    writeFileSync(path.join(root, 'desktop_sdk_macos_exe'), macho);
    assert.throws(() => validatePackagedRecallNative(root, 'darwin'), /not a thin arm64 Mach-O/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Recall tar validation accepts bounded framework links and rejects traversal or special files', () => {
  assert.equal(assertSafeArchiveEntry({
    path: './Frameworks/GStreamer.framework/GStreamer',
    type: 'SymbolicLink',
    linkpath: 'Versions/Current/GStreamer',
    mode: 0o777,
  }), 'Frameworks/GStreamer.framework/GStreamer');
  assert.throws(
    () => assertSafeArchiveEntry({ path: '../../escape', type: 'File', mode: 0o644 }),
    /escapes the extraction root/,
  );
  assert.throws(
    () => assertSafeArchiveEntry({ path: '/absolute', type: 'File', mode: 0o644 }),
    /must be relative/,
  );
  assert.throws(
    () => assertSafeArchiveEntry({ path: './hardlink', type: 'Link', linkpath: './target', mode: 0o644 }),
    /unsupported Link/,
  );
  assert.throws(
    () => assertSafeArchiveEntry({ path: './binary', type: 'File', mode: 0o4755 }),
    /setuid\/setgid/,
  );
});

test('Recall native architecture validators require arm64 Mach-O and x64 PE', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clementine-recall-arch-test-'));
  try {
    const macho = Buffer.alloc(8);
    macho.writeUInt32LE(0xfeedfacf, 0);
    macho.writeUInt32LE(0x0100000c, 4);
    const machoPath = path.join(root, 'arm64');
    writeFileSync(machoPath, macho);
    assert.doesNotThrow(() => assertMachOArm64(machoPath));
    macho.writeUInt32LE(0x01000007, 4);
    writeFileSync(machoPath, macho);
    assert.throws(() => assertMachOArm64(machoPath), /not a thin arm64 Mach-O/);

    const pe = Buffer.alloc(0x80);
    pe.write('MZ', 0, 'ascii');
    pe.writeUInt32LE(0x40, 0x3c);
    pe.write('PE\0\0', 0x40, 'binary');
    pe.writeUInt16LE(0x8664, 0x44);
    const pePath = path.join(root, 'x64.exe');
    writeFileSync(pePath, pe);
    assert.doesNotThrow(() => assertPeX64(pePath));
    pe.writeUInt16LE(0x014c, 0x44);
    writeFileSync(pePath, pe);
    assert.throws(() => assertPeX64(pePath), /not x86-64 PE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Recall native vendoring deliberately skips unsupported Linux packages', async () => {
  assert.deepEqual(await vendorRecallNative('linux'), { skipped: true, platform: 'linux' });
});
