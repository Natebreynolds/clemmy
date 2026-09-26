import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentKind, attachmentLabel, attachmentsSummary } from './attachments.js';

test('a camera photo is an image whatever its extension; a document keeps its name', () => {
  assert.equal(attachmentKind('IMG_0421.HEIC', 'image/heic'), 'image');
  assert.equal(attachmentKind('shot.png', null), 'image');
  assert.equal(attachmentKind('Q3 plan.pdf', 'application/pdf'), 'file');
  assert.equal(attachmentLabel({ name: 'IMG_0421.HEIC', kind: 'image' }), 'IMG_0421');
  assert.equal(attachmentLabel({ name: 'Q3 plan.pdf', kind: 'file' }), 'Q3 plan.pdf');
  assert.equal(attachmentLabel({ name: '', kind: 'image' }), 'Photo');
});

test('the summary under a bubble counts in words', () => {
  assert.equal(attachmentsSummary([{ kind: 'image' }, { kind: 'image' }]), '2 photos');
  assert.equal(attachmentsSummary([{ kind: 'image' }, { kind: 'file' }]), '1 photo, 1 file');
  assert.equal(attachmentsSummary([]), '');
});
