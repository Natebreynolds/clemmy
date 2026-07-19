import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseLatestMacYml, verifyDesktopReleaseAssets } from './verify-desktop-release-assets.mjs';

function withFixture(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-release-assets-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeAsset(dir, name, content = 'asset') {
  writeFileSync(path.join(dir, name), content);
  writeFileSync(path.join(dir, `${name}.blockmap`), 'blockmap');
  return Buffer.byteLength(content);
}

function writeFeed(dir, version, files, pathEntry = files[0]?.url ?? '', feedName = 'latest-mac.yml') {
  const body = [
    `version: ${version}`,
    'files:',
    ...files.flatMap((file) => [
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512 ?? (existsSync(path.join(dir, file.url))
        ? createHash('sha512').update(readFileSync(path.join(dir, file.url))).digest('base64')
        : 'abc=')}`,
      `    size: ${file.size}`,
    ]),
    `path: ${pathEntry}`,
    'sha512: abc=',
    "releaseDate: '2026-07-09T00:00:00.000Z'",
    '',
  ].join('\n');
  writeFileSync(path.join(dir, feedName), body);
}

test('parseLatestMacYml extracts version, path, and file entries', () => {
  const parsed = parseLatestMacYml([
    'version: 1.2.3',
    'files:',
    '  - url: Clementine-1.2.3-mac.zip',
    '    sha512: one=',
    '    size: 10',
    '  - url: Clementine-1.2.3.dmg',
    '    sha512: two=',
    '    size: 20',
    'path: Clementine-1.2.3-mac.zip',
  ].join('\n'));
  assert.equal(parsed.version, '1.2.3');
  assert.equal(parsed.path, 'Clementine-1.2.3-mac.zip');
  assert.deepEqual(parsed.files, [
    { url: 'Clementine-1.2.3-mac.zip', sha512: 'one=', size: 10 },
    { url: 'Clementine-1.2.3.dmg', sha512: 'two=', size: 20 },
  ]);
});

test('verifyDesktopReleaseAssets accepts a complete feed + artifacts fixture', () => {
  withFixture((dir) => {
    const armZipSize = writeAsset(dir, 'Clementine-1.2.3-arm64-mac.zip', 'arm zip payload');
    const armDmgSize = writeAsset(dir, 'Clementine-1.2.3-arm64.dmg', 'arm dmg payload');
    const zipSize = writeAsset(dir, 'Clementine-1.2.3-mac.zip', 'zip payload');
    const dmgSize = writeAsset(dir, 'Clementine-1.2.3.dmg', 'dmg payload');
    writeFeed(dir, '1.2.3', [
      { url: 'Clementine-1.2.3-arm64-mac.zip', size: armZipSize },
      { url: 'Clementine-1.2.3-arm64.dmg', size: armDmgSize },
      { url: 'Clementine-1.2.3-mac.zip', size: zipSize },
      { url: 'Clementine-1.2.3.dmg', size: dmgSize },
    ], 'Clementine-1.2.3-mac.zip');

    const result = verifyDesktopReleaseAssets({ dir, version: '1.2.3' });
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });
});

test('verifyDesktopReleaseAssets rejects an internally valid x64-only feed', () => {
  withFixture((dir) => {
    const zipSize = writeAsset(dir, 'Clementine-1.2.3-mac.zip', 'zip payload');
    const dmgSize = writeAsset(dir, 'Clementine-1.2.3.dmg', 'dmg payload');
    writeFeed(dir, '1.2.3', [
      { url: 'Clementine-1.2.3-mac.zip', size: zipSize },
      { url: 'Clementine-1.2.3.dmg', size: dmgSize },
    ]);

    const result = verifyDesktopReleaseAssets({ dir, version: '1.2.3' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /missing architecture artifact: Clementine-1\.2\.3-arm64-mac\.zip/);
    assert.match(result.errors.join('\n'), /missing architecture artifact: Clementine-1\.2\.3-arm64\.dmg/);
  });
});

test('verifyDesktopReleaseAssets fails missing latest-mac.yml', () => {
  withFixture((dir) => {
    const result = verifyDesktopReleaseAssets({ dir, version: '1.2.3' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /missing updater feed/);
  });
});

test('verifyDesktopReleaseAssets catches missing referenced artifact and stale versions', () => {
  withFixture((dir) => {
    const dmgSize = writeAsset(dir, 'Clementine-1.2.3.dmg', 'dmg payload');
    writeAsset(dir, 'Clementine-1.0.0.dmg', 'old payload');
    writeFeed(dir, '1.2.3', [
      { url: 'Clementine-1.2.3-mac.zip', size: 10 },
      { url: 'Clementine-1.2.3.dmg', size: dmgSize },
    ]);

    const result = verifyDesktopReleaseAssets({ dir, version: '1.2.3' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /missing artifact: Clementine-1\.2\.3-mac\.zip/);
    assert.match(result.errors.join('\n'), /stale Clementine artifacts/);
  });
});

test('verifyDesktopReleaseAssets catches size mismatches and missing blockmaps', () => {
  withFixture((dir) => {
    writeFileSync(path.join(dir, 'Clementine-1.2.3-mac.zip'), 'zip payload');
    const dmgSize = writeAsset(dir, 'Clementine-1.2.3.dmg', 'dmg payload');
    writeFeed(dir, '1.2.3', [
      { url: 'Clementine-1.2.3-mac.zip', size: 999 },
      { url: 'Clementine-1.2.3.dmg', size: dmgSize, sha512: 'stale=' },
    ]);

    const result = verifyDesktopReleaseAssets({ dir, version: '1.2.3' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /size mismatch/);
    assert.match(result.errors.join('\n'), /sha512 mismatch/);
    assert.match(result.errors.join('\n'), /missing blockmap/);
  });
});

test('verifyDesktopReleaseAssets accepts an updater-safe Windows installer fixture', () => {
  withFixture((dir) => {
    const installer = 'Clementine-Setup-1.2.3.exe';
    const installerSize = writeAsset(dir, installer, 'windows installer payload');
    writeFeed(dir, '1.2.3', [
      { url: installer, size: installerSize },
    ], installer, 'latest.yml');

    const result = verifyDesktopReleaseAssets({ dir, version: '1.2.3', platform: 'windows' });
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });
});

test('verifyDesktopReleaseAssets rejects electron-builder default Windows names that GitHub normalizes', () => {
  withFixture((dir) => {
    const unsafeInstaller = 'Clementine Setup 1.2.3.exe';
    const unsafeSize = writeAsset(dir, unsafeInstaller, 'windows installer payload');
    const expectedInstaller = 'Clementine-Setup-1.2.3.exe';
    writeFeed(dir, '1.2.3', [
      { url: expectedInstaller, size: unsafeSize },
    ], expectedInstaller, 'latest.yml');

    const result = verifyDesktopReleaseAssets({ dir, version: '1.2.3', platform: 'windows' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /feed references missing artifact: Clementine-Setup-1\.2\.3\.exe/);
    assert.match(result.errors.join('\n'), /updater-unsafe Windows installer names: Clementine Setup 1\.2\.3\.exe/);
  });
});
