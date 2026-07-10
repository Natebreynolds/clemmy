import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeMacUpdateFeeds, parseMacUpdateFeed } from './merge-mac-update-feeds.mjs';

function feed(version, files) {
  return {
    version,
    files: files.map((url, index) => ({ url, sha512: `hash-${index}`, size: 100 + index })),
    path: files[0],
    sha512: 'legacy-hash',
    releaseDate: '2026-07-10T00:00:00.000Z',
  };
}

test('mergeMacUpdateFeeds preserves both architectures and the x64 legacy fallback', () => {
  const merged = mergeMacUpdateFeeds(
    feed('1.4.4', ['Clementine-1.4.4-arm64-mac.zip', 'Clementine-1.4.4-arm64.dmg']),
    feed('1.4.4', ['Clementine-1.4.4-mac.zip', 'Clementine-1.4.4.dmg']),
  );

  assert.deepEqual(merged.files.map((file) => file.url), [
    'Clementine-1.4.4-arm64-mac.zip',
    'Clementine-1.4.4-arm64.dmg',
    'Clementine-1.4.4-mac.zip',
    'Clementine-1.4.4.dmg',
  ]);
  assert.equal(merged.path, 'Clementine-1.4.4-mac.zip');
  assert.equal(merged.sha512, 'hash-0');
});

test('mergeMacUpdateFeeds rejects version drift and a missing architecture artifact', () => {
  assert.throws(
    () => mergeMacUpdateFeeds(
      feed('1.4.4', ['Clementine-1.4.4-arm64-mac.zip', 'Clementine-1.4.4-arm64.dmg']),
      feed('1.4.3', ['Clementine-1.4.3-mac.zip', 'Clementine-1.4.3.dmg']),
    ),
    /feed versions differ/,
  );
  assert.throws(
    () => mergeMacUpdateFeeds(
      feed('1.4.4', ['Clementine-1.4.4-arm64-mac.zip']),
      feed('1.4.4', ['Clementine-1.4.4-mac.zip', 'Clementine-1.4.4.dmg']),
    ),
    /arm64 DMG must contain exactly one matching file/,
  );
});

test('parseMacUpdateFeed uses a YAML parser and validates the document shape', () => {
  const parsed = parseMacUpdateFeed([
    'version: 1.4.4',
    'files:',
    '  - url: Clementine-1.4.4-mac.zip',
    '    sha512: abc=',
    '    size: 10',
  ].join('\n'));
  assert.equal(parsed.version, '1.4.4');
  assert.equal(parsed.files[0].url, 'Clementine-1.4.4-mac.zip');
  assert.throws(() => parseMacUpdateFeed('[]'), /YAML object/);
});
