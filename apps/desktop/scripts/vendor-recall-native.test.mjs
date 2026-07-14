import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  vendorRecallNative,
} from './vendor-recall-native.mjs';

test('Recall native release provenance stays exactly pinned', () => {
  assert.equal(RECALL_SDK_VERSION, '2.0.25');
  assert.equal(RECALL_SDK_COMMIT, '90d670e842200a4d546cbe36cc0b9c48fbe6a204');
  assert.deepEqual(
    {
      bytes: RECALL_NATIVE_SPECS.darwin.archiveBytes,
      sha256: RECALL_NATIVE_SPECS.darwin.archiveSha256,
    },
    {
      bytes: 50_971_984,
      sha256: 'e3125c49cdf6d54593e6334024df2ecbed99e0c6b1d2e410a4187ab19421433b',
    },
  );
  assert.deepEqual(
    {
      bytes: RECALL_NATIVE_SPECS.win32.archiveBytes,
      sha256: RECALL_NATIVE_SPECS.win32.archiveSha256,
    },
    {
      bytes: 39_218_499,
      sha256: 'c761d9dd3c82ab77d7eaf3a3c303c354bc92dbe2946244bb54689bb53322b5ba',
    },
  );
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
