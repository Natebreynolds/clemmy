import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RecallMeetingRecord } from './meeting-capture.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-documents-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_LIVE_MODELS = 'off';
const { createMeetingDocumentStore, meetingDocumentCaptureDigest, MEETING_DOCUMENT_LIMITS } = await import('./meeting-documents.js');
const { withFileLock } = await import('../../runtime/atomic-json.js');
test.after(() => rmSync(home, { recursive: true, force: true }));
let ordinal = 0;
function fixture() {
  const directory = path.join(home, `case-${++ordinal}`);
  let time = Date.parse('2026-10-17T10:00:00.000Z');
  const record: RecallMeetingRecord = { id: `meeting-fixture-${ordinal}`, windowId: 'controlled-window',
    provider: 'recall', source: 'recall-desktop-sdk', sdkUploadId: `fixture-upload-${ordinal}`,
    startedAt: '2026-10-17T09:59:00.000Z', status: 'recording', segments: [] };
  const options = { directory, readMeeting: (id: string) => id === record.id ? structuredClone(record) : null, now: () => time };
  const store = createMeetingDocumentStore(options);
  const snapshot = () => store.getMeetingDocuments(record.id);
  const attach = (text = 'Controlled approved launch number: seven.', title = 'Controlled briefing') => {
    const current = snapshot();
    return store.attachMeetingDocument(record.id, { expectedVersion: current.snapshotVersion, captureDigest: current.captureDigest, title, text });
  };
  const file = () => path.join(directory, readdirSync(directory).find((entry) => entry.endsWith('.json'))!);
  const read = (maxChars?: number) => { const current = snapshot(); return store.readMeetingDocuments(record.id,
    { captureDigest: current.captureDigest, snapshotVersion: current.snapshotVersion,
      references: current.documents.map(({ id, revision, digest }) => ({ id, revision, digest })), ...(maxChars ? { maxChars } : {}) }); };
  return { store, record, directory, options, snapshot, attach, file, read, advance: () => { time += 1_000; } };
}

test('passive metadata reads do not create state or expose document text; documents survive restart and capture completion', () => {
  const f = fixture();
  assert.equal(f.snapshot().snapshotVersion, 0);
  assert.equal(existsSync(f.directory), false);
  const saved = f.attach();
  assert.equal(saved.snapshotVersion, 1);
  assert.equal('text' in saved.documents[0]!, false);
  assert.equal(saved.documents[0]!.revision, 1);
  assert.equal(saved.documents[0]!.digest, createHash('sha256').update('Controlled approved launch number: seven.').digest('hex'));
  f.record.status = 'completed';
  f.record.endedAt = '2026-10-17T11:00:00.000Z';
  const reopened = createMeetingDocumentStore(f.options);
  const after = reopened.getMeetingDocuments(f.record.id);
  assert.deepEqual(after, saved);
  assert.equal(f.read().documents[0]!.text, 'Controlled approved launch number: seven.');
});

test('capture binding matches assistance exactly and rejects a foreign meeting without filesystem creation', () => {
  const f = fixture();
  const expected = createHash('sha256').update(JSON.stringify([f.record.id, f.record.windowId, f.record.startedAt, 'recall', 'recall-desktop-sdk', f.record.sdkUploadId])).digest('hex');
  assert.equal(meetingDocumentCaptureDigest(f.record), expected);
  assert.throws(() => f.store.getMeetingDocuments('foreign-fixture'), /Exact meeting/);
  assert.throws(() => f.store.attachMeetingDocument(f.record.id, { expectedVersion: 0, captureDigest: '0'.repeat(64), title: 'Fixture', text: 'Fixture content.' }), /capture changed/);
  assert.equal(existsSync(f.directory), false);
});

test('an edited document gets a new revision, invalidates exact old references, and does not retain old text', () => {
  const f = fixture();
  const first = f.attach('Earlier controlled fact.');
  f.advance();
  const ref = first.documents[0]!;
  const second = f.store.attachMeetingDocument(f.record.id, { captureDigest: first.captureDigest, expectedVersion: first.snapshotVersion,
    id: ref.id, title: 'New fixture briefing', text: 'Corrected controlled fact.' });
  assert.equal(second.documents[0]!.id, ref.id);
  assert.equal(second.documents[0]!.revision, 2);
  assert.equal(second.documents[0]!.createdAt, ref.createdAt);
  assert.notEqual(second.documents[0]!.updatedAt, ref.updatedAt);
  assert.equal(readFileSync(f.file(), 'utf8').includes('Earlier controlled fact.'), false);
  assert.throws(() => f.store.readMeetingDocuments(f.record.id, { captureDigest: first.captureDigest, snapshotVersion: first.snapshotVersion,
    references: [{ id: ref.id, revision: ref.revision, digest: ref.digest }] }), /context changed/);
  assert.throws(() => f.store.readMeetingDocuments(f.record.id, { captureDigest: second.captureDigest, snapshotVersion: second.snapshotVersion,
    references: [{ id: ref.id, revision: ref.revision, digest: ref.digest }] }), /revision is unavailable/);
  assert.equal(f.read().documents[0]!.text, 'Corrected controlled fact.');
});

test('removal deletes retained text and invalidates references and attempted id reuse', () => {
  const f = fixture();
  const saved = f.attach('Fixture text to remove.');
  const ref = saved.documents[0]!;
  const removed = f.store.removeMeetingDocument(f.record.id, { captureDigest: saved.captureDigest, expectedVersion: saved.snapshotVersion, id: ref.id, revision: ref.revision });
  assert.equal(removed.documents.length, 0);
  assert.equal(readFileSync(f.file(), 'utf8').includes('Fixture text to remove.'), false);
  assert.throws(() => f.store.readMeetingDocuments(f.record.id, { captureDigest: removed.captureDigest, snapshotVersion: removed.snapshotVersion,
    references: [{ id: ref.id, revision: ref.revision, digest: ref.digest }] }), /unavailable/);
  assert.throws(() => f.store.attachMeetingDocument(f.record.id, { captureDigest: removed.captureDigest, expectedVersion: removed.snapshotVersion,
    id: ref.id, title: 'Fixture', text: 'New text cannot resurrect removed identity.' }), /unavailable/);
});

test('compare-and-swap prevents stale attach/remove from overwriting a newer document', () => {
  const f = fixture();
  const before = f.snapshot();
  const saved = f.attach();
  const bytes = readFileSync(f.file(), 'utf8');
  assert.throws(() => f.store.attachMeetingDocument(f.record.id, { captureDigest: before.captureDigest, expectedVersion: before.snapshotVersion, title: 'Stale fixture', text: 'Stale text.' }), /Reload/);
  assert.throws(() => f.store.removeMeetingDocument(f.record.id, { captureDigest: saved.captureDigest, expectedVersion: before.snapshotVersion, id: saved.documents[0]!.id, revision: 1 }), /Reload/);
  assert.throws(() => f.store.removeMeetingDocument(f.record.id, { captureDigest: saved.captureDigest, expectedVersion: saved.snapshotVersion, id: saved.documents[0]!.id, revision: 2 }), /changed or is unavailable/);
  assert.equal(readFileSync(f.file(), 'utf8'), bytes);
});

test('reused native window, upload identity, provider and source never borrow prior documents', () => {
  for (const field of ['windowId', 'startedAt', 'sdkUploadId', 'provider', 'source'] as const) {
    const f = fixture(); const saved = f.attach(); const bytes = readFileSync(f.file(), 'utf8');
    if (field === 'startedAt') f.record.startedAt = '2026-10-17T10:02:00.000Z';
    else if (field === 'provider') f.record.provider = 'local';
    else if (field === 'source') f.record.source = 'local-audio';
    else f.record[field] = 'changed-fixture-identity';
    assert.throws(() => f.snapshot(), /capture changed/);
    assert.throws(() => f.store.attachMeetingDocument(f.record.id, { captureDigest: saved.captureDigest, expectedVersion: saved.snapshotVersion, title: 'Fixture', text: 'Foreign capture.' }), /capture changed/);
    assert.equal(readFileSync(f.file(), 'utf8'), bytes);
  }
});

test('the reader rejects cross-meeting, changed hash and duplicate document references', () => {
  const one = fixture(); const two = fixture();
  const a = one.attach(); const b = two.attach();
  const ref = a.documents[0]!;
  assert.throws(() => two.store.readMeetingDocuments(two.record.id, { captureDigest: b.captureDigest, snapshotVersion: b.snapshotVersion,
    references: [{ id: ref.id, revision: ref.revision, digest: ref.digest }] }), /unavailable/);
  assert.throws(() => one.store.readMeetingDocuments(one.record.id, { captureDigest: a.captureDigest, snapshotVersion: a.snapshotVersion,
    references: [{ id: ref.id, revision: ref.revision, digest: '0'.repeat(64) }] }), /unavailable/);
  const exact = { id: ref.id, revision: ref.revision, digest: ref.digest };
  assert.throws(() => one.store.readMeetingDocuments(one.record.id, { captureDigest: a.captureDigest, snapshotVersion: a.snapshotVersion,
    references: [exact, exact] }), /Duplicate/);
});

test('document reads honor one shared character budget and expose stable citations and truncation', () => {
  const f = fixture(); f.attach('Alpha😀Omega', 'Fixture first'); f.attach('Second fixture passage', 'Fixture second');
  const bounded = f.read(6);
  assert.equal(bounded.documents.reduce((total, document) => total + document.text.length, 0), 6);
  assert.equal(bounded.documents[0]!.text, 'Alpha');
  assert.equal(bounded.documents[1]!.text, 'S');
  assert.equal(bounded.documents.every((document) => document.truncated), true);
  for (const document of bounded.documents) assert.equal(Buffer.from(document.text, 'utf8').toString('utf8'), document.text);
  assert.equal(bounded.documents[0]!.citation, f.read().documents[0]!.citation);
  assert.match(bounded.documents[0]!.citation, /:r1:sha256:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(bounded.documents), true);
});

test('strict plaintext rejects binary controls, invalid Unicode, blanks and undeclared path or account fields', () => {
  const f = fixture(); const base = f.snapshot();
  for (const text of ['', '  ', '\u0000bytes', 'fixture\u0007', '\ud800']) {
    assert.throws(() => f.store.attachMeetingDocument(f.record.id, { captureDigest: base.captureDigest, expectedVersion: 0, title: 'Fixture', text }));
  }
  for (const extra of [{ path: '/not/read' }, { url: 'https://example.invalid' }, { accountId: 'foreign' }]) {
    assert.throws(() => f.store.attachMeetingDocument(f.record.id, { captureDigest: base.captureDigest, expectedVersion: 0, title: 'Fixture', text: 'Fixture.', ...extra }));
  }
  assert.equal(existsSync(f.directory), false);
  assert.equal(f.attach('Line one\nLine two\tfixture.').documents.length, 1);
});

test('document count and individual/total content bounds fail without changing stored bytes', () => {
  const f = fixture();
  for (let index = 0; index < MEETING_DOCUMENT_LIMITS.documents; index++) f.attach(`Fixture passage ${index}.`);
  const bytes = readFileSync(f.file(), 'utf8');
  assert.throws(() => f.attach(), /eight documents/);
  assert.equal(readFileSync(f.file(), 'utf8'), bytes);
  const total = fixture();
  total.attach('A'.repeat(32_000)); total.attach('B'.repeat(32_000)); total.attach('C'.repeat(32_000));
  const totalBefore = readFileSync(total.file(), 'utf8');
  assert.throws(() => total.attach('D'.repeat(4_001)), /total text limit/);
  assert.throws(() => total.attach('D'.repeat(32_001)));
  assert.equal(readFileSync(total.file(), 'utf8'), totalBefore);
  assert.equal(total.attach('D'.repeat(4_000)).documents.length, 4);
});

test('malformed JSON, tampered content/hash, duplicate ids, oversized files and unknown schema fail closed', () => {
  const corruptions = [
    () => '{broken',
    (value: any) => JSON.stringify({ ...value, documents: [{ ...value.documents[0], text: 'Tampered fixture.' }] }),
    (value: any) => JSON.stringify({ ...value, documents: [...value.documents, value.documents[0]] }),
    (value: any) => JSON.stringify({ ...value, ignoredPermission: true }),
    () => ' '.repeat(1_000_001),
  ];
  for (const corrupt of corruptions) {
    const f = fixture(); const saved = f.attach(); const file = f.file(); const state = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, corrupt(state)); const before = readFileSync(file);
    assert.throws(() => f.snapshot(), /corrupt|unreadable/);
    assert.throws(() => f.store.attachMeetingDocument(f.record.id, { captureDigest: saved.captureDigest, expectedVersion: saved.snapshotVersion, title: 'Fixture', text: 'New fixture.' }), /corrupt|unreadable/);
    assert.deepEqual(readFileSync(file), before);
  }
});

test('a copied foreign store and a symlink never become meeting context', () => {
  const a = fixture(); const b = fixture(); a.attach(); b.attach();
  writeFileSync(b.file(), readFileSync(a.file()));
  assert.throws(() => b.snapshot(), /capture changed/);
  const c = fixture(); c.attach(); const target = c.file(); const file = a.file();
  rmSync(file); symlinkSync(target, file);
  assert.throws(() => a.snapshot(), /unreadable/);
});

test('a busy strict lock never writes and returns immediately instead of stalling transcript work', async () => {
  const f = fixture(); const saved = f.attach(); const file = f.file(); const before = readFileSync(file, 'utf8');
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>((resolve) => { entered = resolve; });
  const locked = withFileLock(file, async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); });
  await held;
  try {
    assert.throws(() => f.store.attachMeetingDocument(f.record.id, { captureDigest: saved.captureDigest, expectedVersion: saved.snapshotVersion,
      title: 'Blocked fixture', text: 'Should not write.' }), /held by async|write lock|busy/i);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally { release(); await locked; }
  assert.equal(f.attach('Fixture after lock.').documents.length, 2);
});

test('capture change during preparation is caught before publication', () => {
  const f = fixture(); let reads = 0;
  const store = createMeetingDocumentStore({ ...f.options, readMeeting: (id) => {
    const record = f.options.readMeeting(id); reads++;
    if (record && reads >= 3) record.sdkUploadId = 'replaced-fixture-upload';
    return record;
  } });
  const captureDigest = meetingDocumentCaptureDigest(f.record);
  assert.throws(() => store.attachMeetingDocument(f.record.id, { captureDigest, expectedVersion: 0, title: 'Fixture', text: 'Capture-race fixture.' }), /capture changed/);
  assert.equal(readdirSync(f.directory).filter((entry) => entry.endsWith('.json')).length, 0);
});
