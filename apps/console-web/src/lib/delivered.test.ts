import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactCountLabel, dayHeading, deliveredConversationId, deliveredFileRef, folderHref, groupArtifacts, latestDeliveredGroups, listDelivered, matchesDeliveredSearch, matchingDeliveredFile, type DeliveredGroup } from './delivered.js';

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

const work = (id: number, createdAt: string): DeliveredGroup => ({ id, createdAt, title: 'Quarterly plan', why: '', lane: null, sessionId: 'worker-1', artifactCount: 1, rerunnable: false });

test('local Open requires a server-resolved existing file, never a recorded path', () => {
  const artifact = { kind: 'file', title: 'Plan', target: '/tmp/plan.pdf', createdAt: '', openable: true };
  const ref = { sessionId: 'worker-1', name: 'plan.pdf', folder: 'reports', fileId: 'sf-one' };
  assert.equal(deliveredFileRef(artifact), null);
  assert.equal(deliveredFileRef({ ...artifact, fileRef: ref }), ref);
  assert.equal(deliveredFileRef({ ...artifact, fileRef: ref, stillExists: false }), null);
  assert.equal(deliveredFileRef({ ...artifact, fileRef: { ...ref, fileId: '' } }), null);
  assert.equal(deliveredFileRef({ ...artifact, kind: 'url', fileRef: ref }), null);
  assert.equal(groupArtifacts({ ...work(1, ''), filePath: artifact.target })[0]?.fileRef, undefined);
});

test('search finds work titles and real filenames with case-insensitive words', () => {
  const group = { ...work(1, ''), artifacts: [{ kind: 'file', title: 'Review copy', target: '/reports/October summary.pdf', createdAt: '', openable: true }] };
  assert.ok(matchesDeliveredSearch(group, 'quarterly OCTOBER'));
  assert.ok(matchesDeliveredSearch(group, 'summary.pdf'));
  assert.ok(matchesDeliveredSearch(group, '  '));
  assert.equal(matchesDeliveredSearch(group, 'invoice'), false);
});

test('a folder search opens its matching file, not a newer unrelated file', () => {
  const file = (name: string, day: number) => ({
    kind: 'file', title: name, target: `/reports/${name}`, createdAt: `2026-10-${day}T00:00:00Z`, openable: true,
    fileRef: { sessionId: 'worker-1', name, folder: 'reports', fileId: `sf-${day}` },
  });
  const notes = file('reading-notes.md', 10);
  const launch = file('harbor-launch.html', 11);
  const missing = { ...file('missing-brief.pdf', 12), stillExists: false };
  const external = { kind: 'url', title: 'external-result', target: 'https://example.com/report', createdAt: '', openable: true };
  const group = { ...work(1, ''), artifacts: [notes, launch, missing, external] };
  assert.equal(matchingDeliveredFile(group, 'reading-notes'), notes);
  assert.equal(matchingDeliveredFile(group, 'QUARTERLY reading-notes'), notes);
  assert.equal(matchingDeliveredFile(group, ''), launch);
  assert.ok(matchesDeliveredSearch(group, 'reading-notes harbor-launch'));
  assert.equal(matchingDeliveredFile(group, 'reading-notes harbor-launch'), undefined);
  assert.equal(matchingDeliveredFile(group, 'missing-brief'), undefined);
  assert.equal(matchingDeliveredFile(group, 'external-result'), undefined);
});

test('recent work uses actual recorded time and leaves the source order intact', () => {
  const groups = [work(1, '2026-10-01T00:00:00Z'), work(2, '2026-10-09T00:00:00Z'), work(3, 'invalid')];
  assert.deepEqual(latestDeliveredGroups(groups).map(group => group.id), [2, 1, 3]);
  assert.deepEqual(groups.map(group => group.id), [1, 2, 3]);
});

test('explicit unknown origin never becomes a worker conversation link', () => {
  const group = work(1, '');
  assert.equal(deliveredConversationId({ ...group, conversationSessionId: null }), null);
  assert.equal(deliveredConversationId({ ...group, conversationSessionId: 'chat-1' }), 'chat-1');
  const artifact = { kind: 'file', title: '', target: '', createdAt: '', openable: true, conversationSessionId: null };
  assert.equal(deliveredConversationId({ ...group, conversationSessionId: 'chat-1' }, artifact), null);
  assert.equal(deliveredConversationId(group), 'worker-1', 'legacy responses preserve their existing conversation link');
});

test('an empty project scope does not fall back to the global archive', async () => {
  assert.deepEqual(await listDelivered(24, { sessionIds: [] }), []);
});
