import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isToolMediaContent, toolMediaImageBlocks, toolMediaText } from './tool-media-content.js';

test('only text plus at least one well-formed inline image is media content', () => {
  const image = { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' };
  assert.equal(isToolMediaContent([{ type: 'text', text: 'caption' }, image]), true);
  assert.equal(isToolMediaContent([image]), true);
  assert.equal(isToolMediaContent([{ type: 'text', text: 'no image' }]), false, 'text alone stays text');
  assert.equal(isToolMediaContent([{ type: 'image', data: '', mimeType: 'image/png' }]), false, 'empty image data');
  assert.equal(isToolMediaContent([{ type: 'image', data: 'aW1hZ2U=', mimeType: 'text/html' }]), false, 'non-image media type');
  assert.equal(isToolMediaContent([image, { type: 'file', fileData: 'eA==' }]), false, 'unknown blocks are not guessed at');
  assert.equal(isToolMediaContent({ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }), false, 'a bare object is not content blocks');
  assert.equal(isToolMediaContent([{ ok: true, rows: [] }]), false, 'structured JSON answers are never media');
});

test('the text projection names each image and never carries its bytes', () => {
  const content = [{ type: 'text' as const, text: 'Preview of "Board"' }, { type: 'image' as const, data: 'c2VjcmV0LWJ5dGVz', mimeType: 'image/png' }];
  const text = toolMediaText(content);
  assert.equal(text, 'Preview of "Board"\n[image: image/png]');
  assert.ok(!text.includes('c2VjcmV0LWJ5dGVz'));
  assert.deepEqual(toolMediaImageBlocks([{ type: 'text', text: 'x' }, { type: 'image', data: 'eA==', mimeType: 'image/jpeg', extra: 1 }]), [
    { type: 'image', data: 'eA==', mimeType: 'image/jpeg' },
  ]);
});
