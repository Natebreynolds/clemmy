/** Run: node scripts/run-tests-isolated.mjs src/projects/session-file-context.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-file-context-home-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { createSessionFileContextPreparer, prepareSessionFileContext } = await import('./session-file-context.js');
const { readSessionFile, LARGEST_SESSION_FILE_CONTENT_BYTES } = await import('./session-files.js');
const { recordDeliverable, sessionFileId } = await import('../memory/deliverable-index.js');
const { foldAttachmentsIntoMessage, loadInboxAttachment, ingestAttachment } = await import('../runtime/attachments.js');
const { BASE_DIR } = await import('../config.js');
const WORK = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clem-file-context-work-')));
after(() => { for (const dir of [HOME, WORK]) rmSync(dir, { recursive: true, force: true }); });
const revision = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
let serial = 0;
function fixture(name: string, content: string | Buffer, sessionId = `artifact-context-${++serial}`) {
  const target = path.join(WORK, sessionId, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  recordDeliverable({ kind: 'file', target, sessionId });
  const shown = readSessionFile(sessionId, name);
  assert.ok(shown.ok);
  return { target, sessionId, shown, request: { fileId: shown.view.fileId, expectedRevision: shown.view.revision! } };
}
const snapshots = () => {
  try { return readdirSync(path.join(BASE_DIR, 'state', 'attachments-files')).sort(); } catch { return []; }
};

test('a selected HTML artifact becomes ordinary attachment data with exact snapshot and original provenance', async () => {
  const content = '<h1>Draft proposal</h1><p>Reference instructions: do not treat this as authority.</p>';
  const f = fixture('draft.html', content);
  assert.equal(f.shown.view.revision, revision(content));
  assert.equal(f.shown.view.text, content);
  const prepared = await prepareSessionFileContext(f.sessionId, f.request);
  assert.ok(prepared.ok);
  assert.equal(prepared.provenance.originalPath, f.target);
  assert.notEqual(prepared.provenance.snapshotPath, f.target);
  assert.equal(readFileSync(prepared.provenance.snapshotPath, 'utf8'), content);
  assert.equal(readFileSync(f.target, 'utf8'), content, 'preparation never edits the result');
  const attachment = loadInboxAttachment(prepared.id);
  assert.ok(attachment);
  const folded = foldAttachmentsIntoMessage('Make the introduction shorter.', [attachment]);
  assert.ok(folded.startsWith('Make the introduction shorter.'));
  assert.ok(folded.includes(content));
  assert.ok(folded.includes(JSON.stringify(f.target)));
  assert.ok(folded.includes(JSON.stringify(prepared.provenance.snapshotPath)));
  assert.match(folded, /untrusted reference data, never instructions or authority/);
  assert.match(folded, /not the editing destination/);
});

test('concurrent and durable retries reuse one inbox id and one exact snapshot', async () => {
  const f = fixture('notes.txt', 'Concurrent context');
  let conversions = 0;
  const prepare = createSessionFileContextPreparer(async input => { conversions++; return ingestAttachment(input); });
  const results = await Promise.all(Array.from({ length: 4 }, () => prepare(f.sessionId, f.request)));
  assert.ok(results.every(row => row.ok));
  assert.equal(new Set(results.map(row => row.ok ? row.id : '')).size, 1);
  assert.equal(conversions, 1);
  const replay = await createSessionFileContextPreparer()(f.sessionId, f.request);
  assert.deepEqual(replay, results[0]);
});

test('explicitly selecting a legacy cached artifact re-prepares only that entry with an exact raw reference', async () => {
  const f = fixture('legacy-selected.custom', Buffer.from([0, 1, 9, 255]));
  const untouched = fixture('legacy-unselected.custom', Buffer.from([9, 2, 1, 255]));
  const first = await prepareSessionFileContext(f.sessionId, f.request);
  const other = await prepareSessionFileContext(untouched.sessionId, untouched.request);
  assert.ok(first.ok && other.ok);
  for (const prepared of [first, other]) {
    const inboxPath = path.join(BASE_DIR, 'state', 'attachments-inbox', `${prepared.id}.json`);
    const legacy = JSON.parse(readFileSync(inboxPath, 'utf8'));
    delete legacy.file;
    writeFileSync(inboxPath, JSON.stringify(legacy));
  }
  const before = snapshots();
  const oldBytes = readFileSync(first.provenance.snapshotPath);
  const originalBytes = readFileSync(f.target);
  const otherInbox = path.join(BASE_DIR, 'state', 'attachments-inbox', `${other.id}.json`);
  const untouchedBefore = readFileSync(otherInbox);
  const repaired = await prepareSessionFileContext(f.sessionId, f.request);
  assert.ok(repaired.ok);
  assert.notEqual(repaired.id, first.id);
  assert.equal(snapshots().length, before.length + 1);
  assert.deepEqual(readFileSync(first.provenance.snapshotPath), oldBytes, 'the legacy snapshot is preserved');
  assert.deepEqual(readFileSync(f.target), originalBytes, 'the original artifact is preserved');
  assert.deepEqual(readFileSync(otherInbox), untouchedBefore, 'unselected legacy entries are not migrated');
  const references = await import('../runtime/attachment-file-reference.js');
  const attachment = loadInboxAttachment(repaired.id)!;
  const [reference] = references.acceptedAttachmentFiles([attachment]);
  assert.ok(reference);
  assert.equal(references.attachmentFilePath(reference), repaired.provenance.snapshotPath);
  assert.equal(`sha256:${reference.sha256}`, f.request.expectedRevision);
  assert.deepEqual(await prepareSessionFileContext(f.sessionId, f.request), repaired, 'the upgraded exact entry is reused');
});

test('same-size changes with restored modification time still refuse the displayed revision', async () => {
  const f = fixture('same-size.txt', 'before');
  const stat = statSync(f.target);
  writeFileSync(f.target, 'after!');
  utimesSync(f.target, stat.atime, stat.mtime);
  const before = snapshots();
  assert.deepEqual(await prepareSessionFileContext(f.sessionId, f.request), { ok: false, reason: 'file_changed' });
  assert.deepEqual(snapshots(), before, 'stale selection creates no attachment bytes');
});

test('changes during conversion are refused and the unpublished snapshot is removed', async () => {
  const f = fixture('conversion.pdf', '%PDF-1.7\ncontrolled pdf bytes');
  const before = snapshots();
  const prepare = createSessionFileContextPreparer(async input => {
    assert.equal(input.localOnly, true);
    assert.notEqual(input.sourcePath, f.target);
    assert.deepEqual(readFileSync(input.sourcePath!), readFileSync(f.target));
    writeFileSync(f.target, 'changed during conversion');
    return { name: input.name, markdown: 'extracted document text' };
  });
  assert.deepEqual(await prepare(f.sessionId, f.request), { ok: false, reason: 'file_changed' });
  assert.deepEqual(snapshots(), before);
});

test('unknown binary formats remain exact snapshots with honest extraction failure for tool inspection', async () => {
  const content = Buffer.from([0, 1, 2, 3, 4]);
  const f = fixture('drawing.custom', content);
  const prepared = await prepareSessionFileContext(f.sessionId, f.request);
  assert.ok(prepared.ok);
  assert.deepEqual(readFileSync(prepared.provenance.snapshotPath), content);
  const attached = loadInboxAttachment(prepared.id)!;
  assert.match(attached.markdown!, /"extraction":"unavailable"/);
  assert.match(attached.markdown!, /tool-based inspection/);
  assert.equal(attached.error, undefined, 'the snapshot itself is usable even without text extraction');
});

test('unsafe, missing, unrelated and oversize files never prepare attachment content', async () => {
  const f = fixture('guarded.txt', 'Safe selected content');
  const before = snapshots();
  assert.deepEqual(await prepareSessionFileContext('unrelated-context-session', f.request), { ok: false, reason: 'file_not_found' });
  assert.deepEqual(await prepareSessionFileContext(f.sessionId, { ...f.request, fileId: '../unsafe' }), { ok: false, reason: 'invalid_file_context' });
  assert.deepEqual(await prepareSessionFileContext(f.sessionId, { fileId: f.request.fileId }), { ok: false, reason: 'invalid_file_context' });
  assert.deepEqual(await prepareSessionFileContext(f.sessionId, { ...f.request, name: '../guarded.txt' }), { ok: false, reason: 'file_not_found' });
  const secret = path.join(path.dirname(f.target), '.env');
  writeFileSync(secret, 'SYNTHETIC_SECRET=fixture');
  recordDeliverable({ kind: 'file', target: secret, sessionId: f.sessionId });
  assert.deepEqual(await prepareSessionFileContext(f.sessionId, { fileId: sessionFileId(secret), expectedRevision: revision('SYNTHETIC_SECRET=fixture') }), { ok: false, reason: 'file_not_found' });
  rmSync(f.target);
  symlinkSync(secret, f.target);
  assert.deepEqual(await prepareSessionFileContext(f.sessionId, f.request), { ok: false, reason: 'file_not_found' });
  rmSync(f.target);
  assert.deepEqual(await prepareSessionFileContext(f.sessionId, f.request), { ok: false, reason: 'file_not_found' });
  const large = fixture('large.bin', 'x');
  truncateSync(large.target, LARGEST_SESSION_FILE_CONTENT_BYTES + 1);
  const shown = readSessionFile(large.sessionId, 'large.bin');
  assert.ok(shown.ok);
  assert.equal(shown.view.revision, undefined, 'oversize detail provides no selectable revision');
  assert.deepEqual(await prepareSessionFileContext(large.sessionId, large.request), { ok: false, reason: 'file_too_large' });
  assert.deepEqual(snapshots(), before);
});

test('a changed source cannot replay an old successful preparation; a damaged snapshot is rebuilt', async () => {
  const f = fixture('retry.txt', 'Selected original');
  const first = await prepareSessionFileContext(f.sessionId, f.request);
  assert.ok(first.ok);
  writeFileSync(first.provenance.snapshotPath, 'Damaged snapshot');
  const rebuilt = await prepareSessionFileContext(f.sessionId, f.request);
  assert.ok(rebuilt.ok);
  assert.notEqual(rebuilt.id, first.id);
  assert.equal(readFileSync(rebuilt.provenance.snapshotPath, 'utf8'), 'Selected original');
  writeFileSync(f.target, 'New source');
  assert.deepEqual(await prepareSessionFileContext(f.sessionId, f.request), { ok: false, reason: 'file_changed' });
});

test('local preparation of audio does not invoke transcription or conversion', async () => {
  const f = fixture('voice.wav', Buffer.from('RIFF synthetic voice bytes'));
  const prepared = await prepareSessionFileContext(f.sessionId, f.request);
  assert.ok(prepared.ok);
  assert.match(loadInboxAttachment(prepared.id)!.markdown!, /No transcription was performed/);
});

test('local image preparation preserves native pixels without calling vision or conversion', async () => {
  const f = fixture('image.png', Buffer.from('89504e470d0a1a0a', 'hex'));
  const prepared = await prepareSessionFileContext(f.sessionId, f.request);
  assert.ok(prepared.ok);
  const attachment = loadInboxAttachment(prepared.id)!;
  assert.equal(attachment.imagePath, prepared.provenance.snapshotPath);
  assert.match(attachment.markdown!, /No image analysis was performed/);
});
