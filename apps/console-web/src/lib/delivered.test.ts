import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactCountLabel, dayHeading, folderHref, groupArtifacts } from './delivered.js';

test('folder href is addressable by group id', () => {
  assert.equal(folderHref({ id: 42 }), '/made/42');
});

test('count labels drafts and files as such, otherwise items', () => {
  assert.equal(artifactCountLabel({ artifactCount: 8, artifacts: Array.from({ length: 8 }, () => ({ kind: 'draft', title: 'd', target: 'u', createdAt: '', openable: true })) }), '8 drafts');
  assert.equal(artifactCountLabel({ artifactCount: 1, artifacts: [{ kind: 'file', title: 'f', target: 'p', createdAt: '', openable: true }] }), '1 file');
  assert.equal(artifactCountLabel({ artifactCount: 3, artifacts: [
    { kind: 'draft', title: 'd', target: 'u', createdAt: '', openable: true },
    { kind: 'file', title: 'f', target: 'p', createdAt: '', openable: true },
    { kind: 'url', title: 'u', target: 'h', createdAt: '', openable: true },
  ] }), '3 items');
  assert.equal(artifactCountLabel({ artifactCount: 5, title: 'Email drafted' }), '5 drafts');
  assert.equal(artifactCountLabel({ artifactCount: 2, title: 'brief', createdAt: '', filePath: '/tmp/a.html' }), '2 files');
});

test('older daemons that omit artifacts still yield an openable row', () => {
  const fromUrl = groupArtifacts({
    artifactCount: 8,
    title: 'Email drafted',
    createdAt: '2026-09-09T12:00:00.000Z',
    url: 'https://mail.google.com/mail/#drafts/1',
  });
  assert.equal(fromUrl.length, 1);
  assert.equal(fromUrl[0]?.openable, true);
  assert.equal(fromUrl[0]?.target, 'https://mail.google.com/mail/#drafts/1');

  const gone = groupArtifacts({
    artifactCount: 1,
    title: 'brief',
    createdAt: '2026-09-09T12:00:00.000Z',
    filePath: '/tmp/moved.html',
    fileStillExists: false,
  });
  assert.equal(gone[0]?.openable, false);
  assert.equal(gone[0]?.stillExists, false);
});

test('day headings are Today, Yesterday, then a dated label', () => {
  const now = Date.now();
  const atNoon = (daysAgo: number) => {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString();
  };
  assert.equal(dayHeading(atNoon(0), now), 'Today');
  assert.equal(dayHeading(atNoon(1), now), 'Yesterday');
  assert.ok(dayHeading(atNoon(10), now).length > 0);
});
