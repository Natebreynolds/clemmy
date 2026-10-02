/**
 * Run: npx tsx --test apps/desktop/src/update-room.test.ts
 *
 * An update download waits for room on the volume: installing holds the zip,
 * Squirrel's copy of it and the unpacked app at once, and starting that on a
 * nearly full disk fills the disk under everything else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { freeDiskBytes, updateRoomShortfall, updateZipBytes } from './update-room.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

test('a 515 MB update waits on a volume with 2 GB free and goes ahead with 8 GB free', () => {
  const short = updateRoomShortfall(515 * MB, 2 * GB);
  assert.ok(short);
  assert.ok(short.neededBytes > 5 * GB && short.neededBytes < 6 * GB);
  assert.equal(short.freeBytes, 2 * GB);
  assert.equal(updateRoomShortfall(515 * MB, 8 * GB), null);
});

test('without a size in the release metadata it still asks for room', () => {
  assert.ok(updateRoomShortfall(undefined, 3 * GB));
  assert.ok(updateRoomShortfall(0, 3 * GB));
  assert.equal(updateRoomShortfall(undefined, 20 * GB), null);
});

test('the zip size is read from the release files, and free space from this volume', () => {
  assert.equal(updateZipBytes([
    { url: 'Clementine-3.18.25-arm64-mac.dmg', size: 1 },
    { url: 'Clementine-3.18.25-arm64-mac.zip', size: 515 * MB },
  ]), 515 * MB);
  assert.equal(updateZipBytes([{ url: 'x.dmg', size: 1 }]), undefined);
  assert.equal(updateZipBytes(undefined), undefined);
  const free = freeDiskBytes(os.tmpdir());
  assert.ok(free === null || free > 0);
});
