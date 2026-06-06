import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_ATTACHMENT_BYTES,
  extractYouTubeUrls,
  foldAttachmentsIntoMessage,
  ingestAttachment,
  loadInboxAttachment,
  sanitizeAttachmentName,
  saveIngestedToInbox,
  unsupportedReason,
} from './attachments.js';

test('sanitizeAttachmentName strips paths and unsafe chars', () => {
  assert.equal(sanitizeAttachmentName('/etc/passwd'), 'passwd');
  assert.equal(sanitizeAttachmentName('../../secret.pdf'), 'secret.pdf');
  assert.equal(sanitizeAttachmentName('my report (final).docx'), 'my report (final).docx'.replace(/[()]/g, '_'));
  assert.equal(sanitizeAttachmentName(''), 'attachment');
});

test('extractYouTubeUrls finds watch / youtu.be / shorts links and dedupes', () => {
  const text = 'see https://www.youtube.com/watch?v=abc123 and https://youtu.be/abc123 plus https://youtube.com/shorts/Xy_9z';
  const urls = extractYouTubeUrls(text);
  assert.ok(urls.includes('https://www.youtube.com/watch?v=abc123'));
  assert.ok(urls.includes('https://youtu.be/abc123'));
  assert.ok(urls.some((u) => u.includes('/shorts/Xy_9z')));
});

test('extractYouTubeUrls returns empty for non-youtube text', () => {
  assert.deepEqual(extractYouTubeUrls('just a https://example.com/page link'), []);
});

test('foldAttachmentsIntoMessage leaves message unchanged when no attachments', () => {
  assert.equal(foldAttachmentsIntoMessage('hello', []), 'hello');
});

test('foldAttachmentsIntoMessage inlines converted markdown under the message', () => {
  const folded = foldAttachmentsIntoMessage('summarize this', [{ name: 'a.pdf', markdown: '# Title\nbody' }]);
  assert.match(folded, /summarize this/);
  assert.match(folded, /### Attachment: a\.pdf/);
  assert.match(folded, /# Title/);
});

test('foldAttachmentsIntoMessage surfaces errors inline (never silently drops)', () => {
  const folded = foldAttachmentsIntoMessage('', [{ name: 'broken.pdf', error: 'pdf dep missing' }]);
  assert.match(folded, /Could not read this file: pdf dep missing/);
  assert.match(folded, /attached the following file/i);
});

test('inbox round-trips an ingested attachment by id', () => {
  const id = saveIngestedToInbox({ name: 'doc.pdf', markdown: 'converted text' });
  const loaded = loadInboxAttachment(id);
  assert.ok(loaded);
  assert.equal(loaded.name, 'doc.pdf');
  assert.equal(loaded.markdown, 'converted text');
});

test('loadInboxAttachment rejects path-traversal ids and unknown ids', () => {
  assert.equal(loadInboxAttachment('../../etc/passwd'), null);
  assert.equal(loadInboxAttachment('not-a-real-id-00000'), null);
});

test('unsupportedReason flags video + executables, allows real docs', () => {
  assert.match(unsupportedReason('clip.mp4') || '', /video is not supported/i);
  assert.match(unsupportedReason('movie.MOV') || '', /video is not supported/i);
  assert.match(unsupportedReason('installer.exe') || '', /executable/i);
  assert.equal(unsupportedReason('report.pdf'), null);
  assert.equal(unsupportedReason('photo.png'), null);
});

test('ingestAttachment: video file returns a clean message, never breaks (no conversion)', async () => {
  const r = await ingestAttachment({ name: 'demo.mp4', bytes: Buffer.from([0, 1, 2, 3]) });
  assert.equal(r.markdown, undefined);
  assert.match(r.error || '', /video is not supported/i);
});

test('ingestAttachment: empty file is reported, not converted', async () => {
  const r = await ingestAttachment({ name: 'blank.pdf', bytes: Buffer.alloc(0) });
  assert.match(r.error || '', /empty/i);
});

test('ingestAttachment: oversize bytes are rejected before any conversion', async () => {
  const r = await ingestAttachment({ name: 'huge.pdf', bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) });
  assert.match(r.error || '', /too large/i);
});

test('ingestAttachment: binary blob with unknown ext → clean message, not garbage', async () => {
  const r = await ingestAttachment({ name: 'mystery.dat', bytes: Buffer.from([0x00, 0x42, 0x00, 0x7f]) });
  assert.equal(r.markdown, undefined);
  assert.match(r.error || '', /binary/i);
});

test('ingestAttachment: plain-text file with unknown ext is read directly', async () => {
  const r = await ingestAttachment({ name: 'server.log', bytes: Buffer.from('INFO ready\nWARN slow') });
  assert.equal(r.error, undefined);
  assert.match(r.markdown || '', /INFO ready/);
});
