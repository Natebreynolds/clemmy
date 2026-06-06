import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAudioExtension, isImageExtension, transcribeAudio, describeImage } from './transcribe.js';

test('isAudioExtension matches audio formats only', () => {
  for (const f of ['a.mp3', 'b.WAV', 'c.m4a', 'd.flac', 'e.ogg']) assert.equal(isAudioExtension(f), true, f);
  for (const f of ['x.pdf', 'y.png', 'z.txt', 'w.mp4']) assert.equal(isAudioExtension(f), false, f);
});

test('isImageExtension matches image formats only', () => {
  for (const f of ['a.png', 'b.JPG', 'c.jpeg', 'd.webp', 'e.gif']) assert.equal(isImageExtension(f), true, f);
  for (const f of ['x.pdf', 'y.mp3', 'z.txt']) assert.equal(isImageExtension(f), false, f);
});

test('transcribeAudio returns a structured error for a missing file (no network reached)', async () => {
  const r = await transcribeAudio('/no/such/clip-xyz.mp3');
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.error.length > 0);
});

test('describeImage returns a structured error for a missing file (no network reached)', async () => {
  const r = await describeImage('/no/such/image-xyz.png');
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.error.length > 0);
});
