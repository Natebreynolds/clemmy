import assert from 'node:assert/strict';
import test from 'node:test';
import { addMeetingResearchDocument, getMeetingResearch, getMeetingResearchDocuments, meetingResearchJobLabel,
  meetingResearchNotice, meetingResearchRefsCurrent, parseMeetingResearchDocuments, parseMeetingResearchState,
  removeMeetingResearchDocument, setMeetingResearch, stopMeetingResearch, type MeetingResearchDocuments, type MeetingResearchState } from './meeting-research';

const meetingId = 'controlled/meeting';
const document = { id: 'meeting-doc-00000000-0000-4000-8000-000000000000', revision: 1, digest: 'a'.repeat(64),
  title: 'Controlled launch brief', charCount: 30, createdAt: '2026-10-17T12:00:00Z', updatedAt: '2026-10-17T12:00:00Z' };
const documents: MeetingResearchDocuments = { meetingId, captureDigest: 'b'.repeat(64), snapshotVersion: 3, documents: [document] };
const state: MeetingResearchState = { meetingId, version: 5, enabled: false, useMemory: false, maxLookups: 3,
  usedLookups: 0, status: 'disabled', documentRefs: [], jobs: [] };
const task = { sessionId: 'controlled-private-chat', sourceUserSeq: 123, attemptId: 'controlled-attempt', runId: 'controlled-run', clientRequestId: 'controlled-request' };

test('unfamiliar or incomplete research state cannot become displayed permission or success', () => {
  assert.deepEqual(parseMeetingResearchState(state, meetingId), state);
  for (const patch of [{ meetingId: 'other-meeting' }, { enabled: 'yes' }, { status: 'success' }, { status: null },
    { version: -1 }, { maxLookups: 0 }, { maxLookups: 9 }, { maxLookups: 1.5 }, { usedLookups: NaN },
    { documentRefs: null }, { jobs: null }]) {
    assert.throws(() => parseMeetingResearchState({ ...state, ...patch }, meetingId), /couldn’t refresh/);
  }
});

test('research status labels preserve server state and uncertain outcomes', () => {
  assert.match(meetingResearchNotice({ status: 'running' }), /Researching/);
  assert.match(meetingResearchNotice({ status: 'disabled' }), /off/);
  assert.match(meetingResearchNotice({ status: 'exhausted' }), /limit is reached/);
  assert.match(meetingResearchNotice({ status: 'unavailable' }), /paused/);
  assert.match(meetingResearchNotice({ status: 'unavailable', reason: 'documents_changed' }), /Choose the current notes/);
  assert.match(meetingResearchNotice({ status: 'unavailable', reason: 'meeting_not_recording' }), /meeting has ended/);
  assert.equal(meetingResearchJobLabel({ status: 'completed' }), 'Answer ready');
  assert.equal(meetingResearchJobLabel({ status: 'blocked' }), 'Needs attention');
  assert.equal(meetingResearchJobLabel({ status: 'running', outcomeUnknown: true }), 'Needs checking');
});

test('a private lookup link requires a complete accepted task binding, not a reserved chat id', () => {
  const job = { id: 'controlled-job', question: 'What is the approved plan?', status: 'running' };
  const parsed = parseMeetingResearchState({ ...state, jobs: [job] }, meetingId);
  assert.equal(parsed.jobs[0].task, undefined);
  assert.deepEqual(parseMeetingResearchState({ ...state, jobs: [{ ...job, task }] }, meetingId).jobs[0].task, task);
  for (const invalid of [{ sessionId: task.sessionId }, { ...task, sourceUserSeq: 0 }, { ...task, attemptId: '' }]) {
    assert.throws(() => parseMeetingResearchState({ ...state, jobs: [{ ...job, task: invalid }] }, meetingId), /couldn’t refresh/);
  }
  assert.throws(() => parseMeetingResearchState({ ...state, jobs: [{ ...job, status: 'probably_done' }] }, meetingId), /couldn’t refresh/);
  assert.throws(() => parseMeetingResearchState({ ...state, jobs: [job, job] }, meetingId), /couldn’t refresh/);
});

test('context metadata is capture-bound and does not carry pasted text into the display snapshot', () => {
  const parsed = parseMeetingResearchDocuments({ ...documents, documents: [{ ...document, text: 'This must not appear in metadata.' }] }, meetingId);
  assert.deepEqual(parsed, documents);
  assert.equal('text' in parsed.documents[0], false);
  for (const patch of [{ meetingId: 'different' }, { captureDigest: '' }, { captureDigest: 'not-a-digest' }, { snapshotVersion: -1 },
    { documents: [document, document] }, { documents: [{ ...document, revision: 0 }] },
    { documents: [{ ...document, charCount: 32_001 }] }, { documents: [{ ...document, updatedAt: 'invalid' }] }]) {
    assert.throws(() => parseMeetingResearchDocuments({ ...documents, ...patch }, meetingId), /couldn’t refresh/);
  }
});

test('new, changed and removed notes cannot silently widen the selected research scope', () => {
  const ref = { id: document.id, revision: document.revision, digest: document.digest };
  assert.equal(meetingResearchRefsCurrent([ref], [document]), true);
  assert.equal(meetingResearchRefsCurrent([ref], [{ ...document, revision: 2 }]), false);
  assert.equal(meetingResearchRefsCurrent([ref], [{ ...document, digest: 'c'.repeat(64) }]), false);
  assert.equal(meetingResearchRefsCurrent([ref], []), false);
  assert.equal(meetingResearchRefsCurrent([], [document]), true, 'a newly saved note is not selected by existing permission');
});

test('passive reads and owner changes use exact meeting, scope and revision bindings without source text in URLs', async () => {
  const previousFetch = globalThis.fetch; const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: { __CLEM_BOOTSTRAP__: { token: 'controlled-meeting-research-test', version: '', flags: {} } } });
  const calls: Array<{ url: string; method?: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url, init) => {
    const pathname = String(url).split('?')[0];
    calls.push({ url: pathname, method: init?.method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) });
    return new Response(JSON.stringify(pathname.endsWith('/research') || pathname.endsWith('/research/stop') ? state : documents), { status: 200 });
  }) as typeof fetch;
  try {
    await getMeetingResearch(meetingId); await getMeetingResearchDocuments(meetingId);
    const ref = { id: document.id, revision: document.revision, digest: document.digest };
    const settings = { expectedVersion: 5, enabled: true, useMemory: false, maxLookups: 3, documentRefs: [ref] };
    await setMeetingResearch(meetingId, settings);
    await addMeetingResearchDocument(meetingId, documents, 'Controlled title', 'Controlled private text');
    await removeMeetingResearchDocument(meetingId, documents, document);
    await stopMeetingResearch(meetingId);
    assert.equal(calls[0].url, '/api/console/meetings/controlled%2Fmeeting/research');
    assert.equal(calls[0].body, undefined); assert.equal(calls[1].body, undefined);
    assert.equal(calls[2].method, 'PATCH'); assert.deepEqual(calls[2].body, settings);
    assert.deepEqual(calls[3].body, { expectedVersion: 3, captureDigest: documents.captureDigest, title: 'Controlled title', text: 'Controlled private text' });
    assert.equal(calls[4].method, 'DELETE');
    assert.deepEqual(calls[4].body, { expectedVersion: 3, captureDigest: documents.captureDigest, revision: 1 });
    assert.equal(calls[5].url, '/api/console/meetings/controlled%2Fmeeting/research/stop');
    assert.equal(calls[5].method, 'POST'); assert.deepEqual(calls[5].body, {}, 'Stop must not depend on a stale settings version');
    assert.equal(calls.some(call => call.url.includes('Controlled') || call.url.includes(documents.captureDigest)), false);
  } finally { Object.assign(globalThis, { fetch: previousFetch, window: previousWindow }); }
});
