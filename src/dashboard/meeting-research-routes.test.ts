import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import type { MeetingDocumentSnapshot } from '../integrations/recall/meeting-documents.js';
import type { MeetingResearchSnapshot } from '../integrations/recall/meeting-research.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-research-routes-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
const capture = await import('../integrations/recall/meeting-capture.js');
const assistance = await import('../integrations/recall/meeting-assistance.js');
const { meetingDocuments } = await import('../integrations/recall/meeting-documents.js');
const { meetingResearch, createMeetingResearchTaskDispatch } = await import('../integrations/recall/meeting-research-service.js');
const { createMeetingResearchCoordinator } = await import('../integrations/recall/meeting-research.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const { registerMeetingResearchRoutes } = await import('./meeting-research-routes.js');
assistance.registerMeetingAssistanceScanPort(null);

// Hold only the companion's debounce callback. HTTP, filesystem and canonical
// route/service code stay real; no model scan port or answer executor is used.
const realSetTimeout = globalThis.setTimeout;
const heldTimers = new Set<ReturnType<typeof setTimeout>>();
let scheduledScans = 0;
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
  if (delay === 1500 && new Error().stack?.includes('meeting-assistance.')) {
    scheduledScans++;
    const held = realSetTimeout(() => {}, 2_147_483_647); held.unref(); heldTimers.add(held); return held;
  }
  return realSetTimeout(callback, delay, ...args);
}) as typeof setTimeout;
test.after(async () => {
  await settle(); assistance.registerMeetingAssistanceScanPort(null);
  for (const timer of heldTimers) clearTimeout(timer);
  globalThis.setTimeout = realSetTimeout;
  eventlog.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});

let ordinal = 0;
function fixture() {
  const number = ++ordinal;
  const record = capture.noteRecallMeetingDetected({ windowId: `controlled-research-routes-${number}`,
    sdkUploadId: `controlled-research-upload-${number}`, title: 'Controlled private meeting research', status: 'recording' });
  return { record, route: `/api/console/meetings/${encodeURIComponent(record.id)}` };
}
function snapshotFiles(directory = home): Record<string, string> {
  if (!existsSync(directory)) return {};
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(snapshotFiles(filename))
      : [[path.relative(home, filename), createHash('sha256').update(readFileSync(filename)).digest('hex')]];
  }));
}
function json(method: string, body?: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
async function boot(authorized = { value: true }) {
  const app = express(); app.use(express.json({ strict: false }));
  registerMeetingResearchRoutes(app, () => authorized.value);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    }) };
}
async function readResearch(url: string): Promise<MeetingResearchSnapshot> {
  const response = await fetch(`${url}/research`); assert.equal(response.status, 200);
  return response.json() as Promise<MeetingResearchSnapshot>;
}
async function readDocuments(url: string): Promise<MeetingDocumentSnapshot> {
  const response = await fetch(`${url}/documents`); assert.equal(response.status, 200);
  return response.json() as Promise<MeetingDocumentSnapshot>;
}
const settings = (version: number, overrides: Record<string, unknown> = {}) => ({ expectedVersion: version,
  enabled: true, useMemory: true, maxLookups: 3, documentRefs: [], ...overrides });

test('all six research/context routes authenticate before reads, validation, mutations or scheduling', async () => {
  const f = fixture(); const documents = meetingDocuments.getMeetingDocuments(f.record.id);
  const saved = meetingDocuments.attachMeetingDocument(f.record.id, { expectedVersion: documents.snapshotVersion,
    captureDigest: documents.captureDigest, title: 'Controlled note', text: 'A private controlled source sentinel.' });
  const document = saved.documents[0]!;
  const harness = await boot({ value: false }); const before = snapshotFiles(); const scans = scheduledScans;
  try {
    for (const base of [f.route, '/api/console/meetings/unknown-meeting']) {
      for (const [suffix, init] of [
        ['/research', undefined], ['/research', json('PATCH', settings(0))],
        ['/research', json('PATCH', { invalid: 'still unauthorized' })], ['/research/stop', json('POST', {})],
        ['/documents', undefined], ['/documents', json('POST', { expectedVersion: saved.snapshotVersion,
          captureDigest: saved.captureDigest, title: 'Unauthorized context', text: 'Must not be stored.' })],
        [`/documents/${document.id}`, json('DELETE', { expectedVersion: saved.snapshotVersion,
          captureDigest: saved.captureDigest, revision: document.revision })],
      ] as const) {
        const response = await fetch(`${harness.url}${base}${suffix}`, init);
        assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'unauthorized' });
      }
    }
    await settle(); assert.equal(scheduledScans, scans); assert.deepEqual(snapshotFiles(), before);
    assert.equal(meetingResearch.get(f.record.id).enabled, false);
    assert.deepEqual(meetingResearch.get(f.record.id).jobs, []);
  } finally { await harness.close(); }
});

test('research and document GETs are passive before and after permission, without jobs, accepted tasks or scan scheduling', async () => {
  const f = fixture(); const harness = await boot(); const url = `${harness.url}${f.route}`;
  // A check needs a finished transcript line to look at; partial-only speech
  // owns no wakeup (d2c3479b7).
  capture.appendRecallTranscriptSegment({ windowId: f.record.windowId, sdkUploadId: f.record.sdkUploadId,
    event: 'transcript.data', text: 'What is the approved controlled version?', isFinal: true, timestamp: '2026-10-17T12:00:00.000Z' });
  try {
    const before = snapshotFiles(); const scans = scheduledScans;
    const initial = await readResearch(url); const sources = await readDocuments(url);
    assert.equal(initial.enabled, false); assert.equal(initial.useMemory, false); assert.equal(initial.status, 'disabled');
    assert.equal(initial.maxLookups, 3); assert.equal(initial.version, 0); assert.deepEqual(initial.jobs, []);
    assert.deepEqual(await readResearch(url), initial); assert.deepEqual(await readDocuments(url), sources);
    await settle(); assert.deepEqual(snapshotFiles(), before); assert.equal(scheduledScans, scans);
    const response = await fetch(`${url}/research`, json('PATCH', settings(initial.version)));
    assert.equal(response.status, 200); await response.json(); await settle();
    const enabled = await readResearch(url); assert.equal(enabled.enabled, true); assert.equal(enabled.useMemory, true);
    assert.equal(enabled.status, 'ready'); assert.deepEqual(enabled.jobs, []);
    assert.equal(scheduledScans, scans + 1, 'only explicit saved permission requests the tool-free suggestion check');
    const afterEnable = snapshotFiles(); const scansAfterEnable = scheduledScans;
    for (let index = 0; index < 3; index++) { assert.deepEqual(await readResearch(url), enabled); await readDocuments(url); }
    await settle(); assert.deepEqual(snapshotFiles(), afterEnable); assert.equal(scheduledScans, scansAfterEnable);
    assert.equal(enabled.jobs.some(job => job.task), false);
    assert.equal(Object.keys(afterEnable).some(filename => /eventlog|usage\.jsonl|model-transport/.test(filename)), false);
  } finally { await harness.close(); }
});

test('strict invalid research/Stop/context inputs cannot inject authority or change saved state', async () => {
  const f = fixture(); const harness = await boot(); const url = `${harness.url}${f.route}`;
  const before = snapshotFiles(); const scans = scheduledScans;
  try {
    for (const body of [{}, [], null, settings(-1), settings(0, { useMemory: 'yes' }), settings(0, { maxLookups: 9 }),
      settings(0, { maxLookups: 1.5 }), settings(0, { transcript: 'Injected transcript cannot grant permission.' }),
      settings(0, { accountId: 'unselected-account' }), settings(0, { toolNames: ['write_everything'] }),
      settings(0, { documentRefs: [{ id: 'invented-note', revision: 0, digest: 'a'.repeat(64) }] })]) {
      assert.equal((await fetch(`${url}/research`, json('PATCH', body))).status, 400, JSON.stringify(body));
    }
    for (const body of [[], null, false, { expectedVersion: 0 }, { transcript: 'not accepted' }]) {
      assert.equal((await fetch(`${url}/research/stop`, json('POST', body))).status, 400, JSON.stringify(body));
    }
    for (const body of [{}, [], null, { expectedVersion: 0, captureDigest: 'a'.repeat(64), title: 'Invalid path', path: '/private/file' },
      { expectedVersion: 0, captureDigest: 'a'.repeat(64), title: 'Invalid URL', text: 'Controlled text', url: 'https://example.invalid/doc' }]) {
      assert.equal((await fetch(`${url}/documents`, json('POST', body))).status, 409, JSON.stringify(body));
    }
    for (const body of [{}, [], null, { expectedVersion: -1, captureDigest: 'a'.repeat(64), revision: 1 },
      { expectedVersion: 0, captureDigest: 'a'.repeat(64), revision: 1, text: 'Delete request must not carry content.' }]) {
      assert.equal((await fetch(`${url}/documents/invented`, json('DELETE', body))).status, 400, JSON.stringify(body));
    }
    await settle(); assert.deepEqual(snapshotFiles(), before); assert.equal(scheduledScans, scans);
  } finally { await harness.close(); }
});

test('explicit note selection binds exact revisions; new notes do not expand permission and replaced notes require a new choice', async () => {
  const f = fixture(); const harness = await boot(); const url = `${harness.url}${f.route}`;
  try {
    const initial = await readResearch(url); const sources = await readDocuments(url);
    assert.equal((await fetch(`${url}/research`, json('PATCH', settings(initial.version, { useMemory: false })))).status, 409,
      'empty sources must not become broad implicit memory or account authority');
    const response = await fetch(`${url}/documents`, json('POST', { expectedVersion: sources.snapshotVersion,
      captureDigest: sources.captureDigest, title: 'Owner-selected brief', text: 'Controlled approval: version A.' }));
    assert.equal(response.status, 200); const saved = await response.json() as MeetingDocumentSnapshot;
    assert.equal(JSON.stringify(saved).includes('Controlled approval: version A.'), false, 'GET/mutation projection is metadata, not pasted content');
    const document = saved.documents[0]!; const ref = { id: document.id, revision: document.revision, digest: document.digest };
    const permission = await fetch(`${url}/research`, json('PATCH', settings(initial.version, { useMemory: false, documentRefs: [ref] })));
    assert.equal(permission.status, 200); await permission.json(); await settle();
    const enabled = await readResearch(url); assert.equal(enabled.enabled, true); assert.equal(enabled.useMemory, false);
    assert.deepEqual(enabled.documentRefs, [ref]); assert.deepEqual(enabled.jobs, []);
    const second = await fetch(`${url}/documents`, json('POST', { expectedVersion: saved.snapshotVersion,
      captureDigest: saved.captureDigest, title: 'Another note', text: 'This note is not included in the saved permission.' }));
    assert.equal(second.status, 200); const two = await second.json() as MeetingDocumentSnapshot; await settle();
    assert.deepEqual((await readResearch(url)).documentRefs, [ref]);
    const replacement = await fetch(`${url}/documents`, json('POST', { expectedVersion: two.snapshotVersion,
      captureDigest: two.captureDigest, id: document.id, title: document.title, text: 'Controlled approval: version B.' }));
    assert.equal(replacement.status, 200); const revised = await replacement.json() as MeetingDocumentSnapshot; await settle();
    const paused = await readResearch(url); assert.equal(paused.status, 'unavailable'); assert.equal(paused.reason, 'documents_changed');
    assert.deepEqual(paused.documentRefs, [ref], 'the old permission is not rewritten to authorize different text');
    const before = snapshotFiles();
    assert.equal((await fetch(`${url}/research`, json('PATCH', settings(paused.version, { useMemory: false, documentRefs: [ref] })))).status, 409);
    await settle(); assert.deepEqual(snapshotFiles(), before);
    const current = revised.documents.find(item => item.id === document.id)!;
    const renewed = await fetch(`${url}/research`, json('PATCH', settings(paused.version, { useMemory: false,
      documentRefs: [{ id: current.id, revision: current.revision, digest: current.digest }] })));
    assert.equal(renewed.status, 200); const body = await renewed.json() as MeetingResearchSnapshot;
    assert.equal(body.status, 'ready'); assert.equal(body.useMemory, false); assert.equal(body.documentRefs[0]!.revision, 2);
    assert.deepEqual(body.jobs, []);
  } finally { await harness.close(); }
});

test('Stop withdraws permission despite view-version drift; a stale settings PATCH cannot', async () => {
  const f = fixture(); const harness = await boot(); const url = `${harness.url}${f.route}`;
  try {
    const initial = await readResearch(url);
    const first = await fetch(`${url}/research`, json('PATCH', settings(initial.version))); assert.equal(first.status, 200);
    const enabled = await first.json() as MeetingResearchSnapshot; await settle();
    const changed = await fetch(`${url}/research`, json('PATCH', settings(enabled.version, { maxLookups: 4 }))); assert.equal(changed.status, 200);
    const drifted = await changed.json() as MeetingResearchSnapshot; assert.ok(drifted.version > enabled.version); await settle();
    assert.equal((await fetch(`${url}/research`, json('PATCH', settings(enabled.version, { enabled: false })))).status, 409);
    assert.equal((await readResearch(url)).enabled, true);
    const stopped = await fetch(`${url}/research/stop`, json('POST', {})); assert.equal(stopped.status, 200);
    const body = await stopped.json() as MeetingResearchSnapshot;
    assert.equal(body.enabled, false); assert.equal(body.status, 'disabled'); assert.deepEqual(body.jobs, []);
    assert.ok(body.version > drifted.version);
    await settle(); assert.equal((await readResearch(url)).enabled, false);
  } finally { await harness.close(); }
});

test('context POST/DELETE require capture and snapshot/revision CAS, preserving state after rejected or unauthorized changes', async () => {
  const f = fixture(); const authorized = { value: true }; const harness = await boot(authorized); const url = `${harness.url}${f.route}`;
  try {
    const initial = await readDocuments(url);
    const input = { expectedVersion: initial.snapshotVersion, captureDigest: initial.captureDigest,
      title: 'Controlled revision', text: 'Private controlled source text.' };
    const savedResponse = await fetch(`${url}/documents`, json('POST', input)); assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json() as MeetingDocumentSnapshot; const document = saved.documents[0]!; await settle();
    const remove = { expectedVersion: saved.snapshotVersion, captureDigest: saved.captureDigest, revision: document.revision };
    const before = snapshotFiles();
    assert.equal((await fetch(`${url}/documents`, json('POST', input))).status, 409);
    assert.equal((await fetch(`${url}/documents`, json('POST', { ...input, expectedVersion: saved.snapshotVersion, captureDigest: 'f'.repeat(64) }))).status, 409);
    for (const patch of [{ expectedVersion: initial.snapshotVersion }, { revision: document.revision + 1 }, { captureDigest: 'f'.repeat(64) }]) {
      assert.equal((await fetch(`${url}/documents/${document.id}`, json('DELETE', { ...remove, ...patch }))).status, 409);
    }
    await settle(); assert.deepEqual(snapshotFiles(), before);
    authorized.value = false;
    assert.equal((await fetch(`${url}/documents`, json('POST', { ...input, expectedVersion: saved.snapshotVersion }))).status, 401);
    assert.equal((await fetch(`${url}/documents/${document.id}`, json('DELETE', remove))).status, 401);
    await settle(); assert.deepEqual(snapshotFiles(), before);
    authorized.value = true;
    const removed = await fetch(`${url}/documents/${document.id}`, json('DELETE', remove)); assert.equal(removed.status, 200);
    const result = await removed.json() as MeetingDocumentSnapshot;
    assert.deepEqual(result.documents, []); assert.equal(result.snapshotVersion, saved.snapshotVersion + 1);
  } finally { await harness.close(); }
});

test('GET preserves a saved answer while honestly projecting reviewed, failed-open, owner-off and wrong-source review', async () => {
  const host = await import('../runtime/harness/host-turn-runner.js');
  const { completionDataForTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
  const { turnOutcomeId } = await import('../runtime/harness/turn-outcome.js');
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const answer = 'The controlled note records the approved version as seven.';
  const harness = await boot();
  try {
    for (const variant of ['reviewed', 'failed_open', 'owner_off', 'wrong_source'] as const) {
      const f = fixture(); const url = `${harness.url}${f.route}`;
      const question = 'What is the approved controlled version?';
      const record = capture.appendRecallTranscriptSegment({ windowId: f.record.windowId, sdkUploadId: f.record.sdkUploadId,
        event: 'transcript.data', text: question, isFinal: true, timestamp: '2026-10-17T12:00:00.000Z' });
      const before = meetingDocuments.getMeetingDocuments(record.id);
      const saved = meetingDocuments.attachMeetingDocument(record.id, { expectedVersion: before.snapshotVersion,
        captureDigest: before.captureDigest, title: 'Controlled source', text: answer });
      let executions = 0;
      const coordinator = createMeetingResearchCoordinator({ directory: path.join(home, 'state', 'meeting-capture', 'research'),
        readMeeting: capture.loadRecallMeetingById,
        readDocumentRefs: id => meetingDocuments.getMeetingDocuments(id).documents.map(({ id, revision, digest }) => ({ id, revision, digest })),
        dispatch: createMeetingResearchTaskDispatch(async input => {
          executions++;
          const source = eventlog.listEventsAtSequences(input.sessionId, [input.sourceUserSeq])[0]!;
          const identity = { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq, turn: source.turn,
            attemptId: input.runAttemptId, runId: source.data.runId as string };
          host.captureEffectiveCompletionPolicyOnce({ ...identity, enabled: variant !== 'owner_off', ownerEnabled: variant !== 'owner_off' });
          let metadata: Record<string, unknown>;
          if (variant === 'owner_off') metadata = { completionReview: { version: 1, disposition: 'disabled_by_owner', policyEvidence: 'captured' } };
          else {
            const objectiveDigest = sha(host.acceptedObjectiveForSource(identity)!); const replyDigest = sha(answer);
            const verdict = eventlog.appendEvent({ sessionId: input.sessionId, turn: 0, role: 'system', type: 'goal_alignment_judged', data: {
              lane: 'host_v1', kind: 'completion', sourceUserSeq: input.sourceUserSeq, fulfills: true,
              objectiveDigest, replyDigest, ...(variant === 'failed_open' ? { failedOpen: true } : {}),
            } });
            metadata = { completionVerdictRef: { version: 1, sourceUserSeq: input.sourceUserSeq + (variant === 'wrong_source' ? 1 : 0),
              eventId: String(verdict.id), seq: verdict.seq, verified: true, disposition: 'reviewed', policyEvidence: 'captured',
              deliveredTextIsJudgedText: true, replyMatches: true, objectiveMatches: true, artifactsMatch: true, objectiveDigest, replyDigest } };
          }
          const outcome = { version: 2 as const, id: turnOutcomeId(identity), identity, status: 'done' as const, resumable: false as const,
            presentation: { kind: 'answer' as const, text: answer } };
          eventlog.appendEvent({ sessionId: input.sessionId, turn: source.turn, role: 'Clem', type: 'conversation_completed',
            data: { ...completionDataForTurnOutcome(outcome), terminalKey: outcome.id, ...metadata } });
        }) });
      coordinator.set(record.id, { enabled: true, useMemory: false, maxLookups: 3, expectedVersion: 0,
        documentRefs: saved.documents.map(({ id, revision, digest }) => ({ id, revision, digest })) });
      coordinator.enqueue(record.id, { offerId: `route-review-${variant}`, offerDigest: sha(variant), sourceDigest: sha(question),
        question, quote: question, segmentIds: [record.segments[0]!.id] });
      const result = await coordinator.drain(record.id); assert.equal(result.jobs[0]!.status, 'completed');
      const eventCount = eventlog.listEvents(result.jobs[0]!.task!.sessionId).length;
      const state = await readResearch(url) as MeetingResearchSnapshot & { jobs: { reviewState: string; task: unknown }[] };
      assert.equal(state.jobs[0]!.reviewState, variant === 'reviewed' ? 'reviewed' : variant === 'owner_off' ? 'disabled_by_owner' : 'unverified');
      assert.deepEqual(state.jobs[0]!.task, result.jobs[0]!.task);
      // The saved private answer is shown with its review state (076cf2990).
      assert.equal((state.jobs[0] as { answer?: { text: string } }).answer?.text, answer);
      assert.deepEqual(await readResearch(url), state); assert.equal(executions, 1);
      assert.equal(eventlog.listEvents(result.jobs[0]!.task!.sessionId).length, eventCount, 'GET never adds a review or executor event');
    }
  } finally { await harness.close(); }
});
