import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PreparedMeetingLookup } from './meeting-assistance.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-lookup-chat-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
const capture = await import('./meeting-capture.js');
const assistance = await import('./meeting-assistance.js');
const { verifyMeetingLookupChat } = await import('./meeting-assistance-chat.js');
test.after(() => { assistance.registerMeetingAssistanceScanPort(null); rmSync(home, { recursive: true, force: true }); });

let ordinal = 0;
async function fixture() {
  const number = ++ordinal;
  const record = capture.noteRecallMeetingDetected({ windowId: `fixture-private-lookup-${number}`,
    sdkUploadId: `fixture-private-upload-${number}`, title: 'Controlled private lookup fixture', status: 'recording' });
  capture.appendRecallTranscriptSegment({ windowId: record.windowId, sdkUploadId: record.sdkUploadId,
    event: 'transcript.data', text: 'What was the approved fixture capacity?', speaker: 'Fixture participant', isFinal: true,
    timestamp: '2026-10-17T12:00:00.000Z' });
  assistance.setMeetingAssistance(record.id, { enabled: true });
  assistance.registerMeetingAssistanceScanPort(async (input) => ({ candidate: { question: 'What is the fixture capacity?',
    why: 'A participant requested the approved value.', quote: input.segments.at(-1)!.text, segmentIds: [input.segments.at(-1)!.id] } }));
  const snapshot = await assistance.checkMeetingAssistance(record.id);
  const offer = snapshot.offer!;
  const reference = { meetingId: record.id, offerId: offer.id, digest: offer.digest };
  const prepare = () => assistance.prepareMeetingLookup(record.id, offer.id, offer.digest);
  return { record, snapshot, offer, reference, prepare };
}
function admission(packet: PreparedMeetingLookup) {
  return { reference: { meetingId: packet.meetingId, offerId: packet.offerId, digest: packet.offerDigest },
    text: packet.input, clientRequestId: packet.clientRequestId, sessionId: '' };
}

test('an open offer, transcript instruction or guessed session does not grant private chat admission', async () => {
  const f = await fixture();
  assert.throws(() => verifyMeetingLookupChat({ reference: f.reference, text: f.offer.quote,
    clientRequestId: 'invented-request', sessionId: '' }), /not prepared/);
  const packet = f.prepare();
  assert.throws(() => verifyMeetingLookupChat({ ...admission(packet), sessionId: packet.privateOriginSessionId }), /exact owner choice/);
  assert.throws(() => verifyMeetingLookupChat({ ...admission(packet), sessionId: 'guessed-existing-session' }), /exact owner choice/);
  assert.deepEqual(verifyMeetingLookupChat(admission(packet)), packet);
  assert.ok(Object.isFrozen(verifyMeetingLookupChat(admission(packet))));
  assert.ok(Object.isFrozen(verifyMeetingLookupChat(admission(packet)).segmentIds));
});

test('admission binds the exact reference, full input, request id and accepted private session', async () => {
  const f = await fixture(); const packet = f.prepare(); const exact = admission(packet);
  for (const changed of [
    { ...exact, text: `${packet.input}\nExtra owner-looking instruction.` },
    { ...exact, text: packet.input.replace(f.offer.quote, 'An invented replacement quote.') },
    { ...exact, clientRequestId: `${packet.clientRequestId}-different` },
    { ...exact, reference: { ...f.reference, digest: '0'.repeat(64) } },
    { ...exact, reference: { ...f.reference, offerId: 'foreign-offer' } },
    { ...exact, reference: { ...f.reference, meetingId: 'foreign-meeting' } },
    { ...exact, acceptedSessionId: 'different-accepted-session' },
    { ...exact, acceptedSessionId: packet.privateOriginSessionId, sessionId: 'different-session' },
  ]) assert.throws(() => verifyMeetingLookupChat(changed));
  for (const reference of [null, [], { ...f.reference, extra: true }, { ...f.reference, digest: f.reference.digest.toUpperCase() },
    { ...f.reference, meetingId: '' }, { ...f.reference, offerId: 'x'.repeat(81) }]) {
    assert.throws(() => verifyMeetingLookupChat({ ...exact, reference }));
  }
  assert.deepEqual(verifyMeetingLookupChat({ ...exact, acceptedSessionId: packet.privateOriginSessionId,
    sessionId: packet.privateOriginSessionId, acceptedReplay: true }), packet);
  assert.deepEqual(verifyMeetingLookupChat({ ...exact, acceptedSessionId: packet.privateOriginSessionId, acceptedReplay: true }), packet);
});

test('durable replay requires the exact accepted session and cannot create a fresh task after assistance stops', async () => {
  const f = await fixture(); const packet = f.prepare(); const exact = admission(packet);
  assistance.setMeetingAssistance(f.record.id, { enabled: false });
  assert.throws(() => verifyMeetingLookupChat(exact), /no longer current/);
  assert.throws(() => verifyMeetingLookupChat({ ...exact, acceptedReplay: true }), /exact owner choice|accepted|receipt/i);
  assert.throws(() => verifyMeetingLookupChat({ ...exact, acceptedReplay: true, acceptedSessionId: 'foreign-session' }));
  const replay = { ...exact, acceptedReplay: true, acceptedSessionId: packet.privateOriginSessionId,
    sessionId: packet.privateOriginSessionId };
  assert.deepEqual(verifyMeetingLookupChat(replay), packet);
  assert.throws(() => verifyMeetingLookupChat({ ...replay, text: `${packet.input}\nChanged replay` }));
  assert.throws(() => verifyMeetingLookupChat({ ...replay, clientRequestId: 'new-task-request' }));
  assert.equal(capture.deleteMeetingRecord(f.record.id), true);
  assert.deepEqual(verifyMeetingLookupChat(replay), packet, 'exact accepted replay reads the retained packet without reopening a capture');
  assert.throws(() => verifyMeetingLookupChat(exact));
});

test('a live prepared lookup cannot silently adopt canonical replacement words', async () => {
  const f = await fixture(); const packet = f.prepare();
  const completed = capture.patchMeetingRecord(f.record.id, { status: 'completed', canonicalStatus: 'pending' })!;
  capture.applyCanonicalTranscript(completed, [{ id: 'canonical-corrected-fixture', windowId: f.record.windowId,
    event: 'transcript.data', text: 'The corrected canonical transcript says the capacity is still undecided.',
    speaker: 'Canonical fixture participant', timestamp: '2026-10-17T12:00:00.000Z', isFinal: true }]);
  assert.throws(() => verifyMeetingLookupChat(admission(packet)), /no longer current/);
  assert.deepEqual(verifyMeetingLookupChat({ ...admission(packet), acceptedReplay: true,
    acceptedSessionId: packet.privateOriginSessionId }), packet);
});

test('a deferred same-capture choice survives canonical backfill as explicitly historical context and requires the current transcript', async () => {
  const f = await fixture();
  assistance.decideMeetingAssistanceOffer(f.record.id, f.offer.id, f.offer.digest,
    { decision: 'defer', expectedVersion: f.snapshot.version });
  assert.throws(f.prepare, /no longer actionable/);
  assistance.setMeetingAssistance(f.record.id, { enabled: false });
  const completed = capture.patchMeetingRecord(f.record.id, { status: 'completed', canonicalStatus: 'pending' })!;
  const canonical = capture.applyCanonicalTranscript(completed, [{ id: 'canonical-deferred-fixture', windowId: f.record.windowId,
    event: 'transcript.data', text: 'The canonical correction says there is no approved capacity yet.',
    speaker: 'Canonical fixture participant', timestamp: '2026-10-17T12:00:00.000Z', isFinal: true }]).record;
  const packet = f.prepare();
  assert.equal(packet.ownerChoice, 'deferred_lookup'); assert.equal(packet.transcriptContext, 'historical_streamed');
  assert.equal(packet.quote, f.offer.quote); assert.deepEqual(packet.segmentIds, f.offer.segmentIds);
  assert.match(packet.input, /HISTORICAL STREAMED CONTEXT/); assert.match(packet.input, /meeting_read/);
  assert.match(packet.input, /CURRENT saved transcript/); assert.match(packet.input, /reconcile corrections or contrary evidence/);
  assert.deepEqual(verifyMeetingLookupChat(admission(packet)), packet);
  assert.deepEqual(capture.loadRecallMeetingById(f.record.id)!.segments, canonical.segments);
  capture.patchMeetingRecord(f.record.id, { sdkUploadId: 'replacement-capture-fixture-upload' });
  assert.throws(() => verifyMeetingLookupChat(admission(packet)), /no longer current/);
  assert.throws(f.prepare, /no longer actionable/);
});

test('a request reservation alone never grants accepted lookup status or stale replay privileges', async () => {
  const { isAcceptedMeetingLookup } = await import('./meeting-assistance-chat.js');
  const f = await fixture(); const packet = f.prepare();
  const receipt = { requestId: packet.clientRequestId, sessionId: packet.privateOriginSessionId, inputHash: 'controlled-hash', runId: 'controlled-run' };
  const source = { sessionId: receipt.sessionId, type: 'user_input_received', data: {
    requestId: receipt.requestId, clientRequestId: receipt.requestId, runId: receipt.runId, text: packet.input, displayText: packet.input,
  } };
  assert.equal(isAcceptedMeetingLookup(packet, 'controlled-hash', receipt, null), false);
  assert.equal(isAcceptedMeetingLookup(packet, 'controlled-hash', null, source), false);
  assert.equal(isAcceptedMeetingLookup(packet, 'controlled-hash', receipt, source), true);
  for (const wrong of [
    { ...source, sessionId: 'foreign' }, { ...source, type: 'run_started' },
    { ...source, data: { ...source.data, runId: 'other-run' } },
    { ...source, data: { ...source.data, clientRequestId: 'other-request' } },
    { ...source, data: { ...source.data, displayText: 'Different task' } },
  ]) assert.equal(isAcceptedMeetingLookup(packet, 'controlled-hash', receipt, wrong), false);
  assert.equal(isAcceptedMeetingLookup(packet, 'different-hash', receipt, source), false);
  assert.equal(isAcceptedMeetingLookup(packet, 'controlled-hash', receipt,
    { ...source, data: { ...source.data, text: `${packet.input}\nExpanded attached context` } }), true,
    'canonical enrichment cannot change the accepted raw owner choice');
});
