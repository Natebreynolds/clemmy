import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { load } from 'js-yaml';

import { refreshNotarizedDmgMetadata } from './refresh-notarized-dmg-metadata.mjs';

test('refreshNotarizedDmgMetadata replaces post-staple DMG metadata and blockmap', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-notarized-dmg-'));
  try {
    const feedPath = path.join(dir, 'latest-mac.yml');
    const dmgPath = path.join(dir, 'Clementine-1.2.3.dmg');
    writeFileSync(dmgPath, 'final stapled dmg bytes');
    writeFileSync(`${dmgPath}.blockmap`, 'stale blockmap');
    writeFileSync(feedPath, [
      'version: 1.2.3',
      'files:',
      '  - url: Clementine-1.2.3-mac.zip',
      '    sha512: zip-hash',
      '    size: 10',
      '  - url: Clementine-1.2.3.dmg',
      '    sha512: stale-dmg-hash',
      '    size: 9',
      'path: Clementine-1.2.3-mac.zip',
      'sha512: zip-hash',
      '',
    ].join('\n'));

    const calls = [];
    const result = await refreshNotarizedDmgMetadata({
      feedPath,
      buildBlockMap: async (input, compression, output) => {
        calls.push({ input, compression, output });
        writeFileSync(output, 'fresh blockmap');
        return { sha512: 'fresh-dmg-hash', size: 23 };
      },
    });

    assert.equal(result.count, 1);
    assert.deepEqual(calls, [{ input: dmgPath, compression: 'gzip', output: `${dmgPath}.blockmap` }]);
    const feed = load(readFileSync(feedPath, 'utf-8'));
    assert.deepEqual(feed.files[1], {
      url: 'Clementine-1.2.3.dmg',
      sha512: 'fresh-dmg-hash',
      size: 23,
    });
    assert.equal(feed.sha512, 'zip-hash', 'the top-level ZIP fallback stays unchanged');
    assert.equal(readFileSync(`${dmgPath}.blockmap`, 'utf-8'), 'fresh blockmap');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshNotarizedDmgMetadata rejects feed path traversal', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-notarized-dmg-'));
  try {
    const feedPath = path.join(dir, 'latest-mac.yml');
    writeFileSync(feedPath, [
      'version: 1.2.3',
      'files:',
      '  - url: ../Clementine-1.2.3.dmg',
      '    sha512: stale',
      '    size: 9',
      '',
    ].join('\n'));
    await assert.rejects(
      refreshNotarizedDmgMetadata({ feedPath, buildBlockMap: async () => ({}) }),
      /unsafe DMG feed path/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
