/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/view-image-access.test.ts
 *
 * view_image follows the owner's computer-access choice: chat attachments
 * always; an image anywhere in the owner's folders only with Full access, and
 * then through the same check every file leaving this computer passes.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-view-image-access-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CLEMENTINE_HOME = path.join(HOME, '.clementine-next');
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, '.clementine-next', 'state', 'attachments-files'), { recursive: true });

const { readImageForViewing } = await import('./attachments.js');
const access = await import('./computer-access.js');
after(() => rmSync(HOME, { recursive: true, force: true }));

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
function file(relative: string, content: Buffer | string = PNG): string {
  const full = path.join(HOME, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

test('without Full access, an image outside the attachments says where the owner turns it on', () => {
  const photo = file('Downloads/jonnie.png');
  const refused = readImageForViewing(photo, () => false);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /Settings → Computer access/);
  // The owner's stored choice is what the default reads: standard until chosen.
  assert.equal(readImageForViewing(photo).ok, false);
  access.setComputerAccessChoice('full');
  assert.equal(readImageForViewing(photo).ok, true, 'the stored Full access choice opens it');
  access.setComputerAccessChoice('standard');
});

test('with Full access, an image in the owner\'s folders is viewed, and the send check still refuses the rest', () => {
  const photo = readImageForViewing(file('Pictures/team/alex.png'), () => true);
  assert.equal(photo.ok, true);
  if (photo.ok) {
    assert.equal(photo.mimeType, 'image/png');
    assert.equal(photo.name, 'alex.png');
    assert.equal(Buffer.from(photo.base64, 'base64').length, PNG.length);
  }
  const ownStore = readImageForViewing(file('.clementine-next/state/screenshot.png'), () => true);
  assert.equal(ownStore.ok, false, 'Clem\'s own stores stay closed');
  const notImage = readImageForViewing(file('Documents/notes.txt', 'hello'), () => true);
  assert.equal(notImage.ok, false);
  const outside = mkdtempSync(path.join(os.tmpdir(), 'clem-view-outside-'));
  try {
    writeFileSync(path.join(outside, 'x.png'), PNG);
    const refused = readImageForViewing(path.join(outside, 'x.png'), () => true);
    assert.equal(refused.ok, false, 'outside the owner\'s folders stays closed');
    if (!refused.ok) assert.match(refused.error, /cannot be viewed/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  const big = readImageForViewing(file('Downloads/huge.png', Buffer.concat([PNG, Buffer.alloc(3_800_000)])), () => true);
  assert.equal(big.ok, false);
  if (!big.ok) assert.match(big.error, /viewing cap/);
});

test('a web address is answered with the reader that fetches it, whatever the access choice', () => {
  for (const full of [false, true]) {
    const refused = readImageForViewing('https://images.example.test/slide7.png?sz=1600', () => full);
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.match(refused.error, /http_read/);
      assert.doesNotMatch(refused.error, /Computer access|Full access/, 'access settings do not apply to a web address');
    }
  }
});
