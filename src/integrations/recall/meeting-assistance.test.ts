import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RecallMeetingRecord } from './meeting-capture.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-assistance-test-'));
process.env.CLEMENTINE_HOME = home;
const { createMeetingAssistanceCoordinator } = await import('./meeting-assistance.js');
type ScanInput = import('./meeting-assistance.js').MeetingAssistanceScanInput;
type ScanResult = import('./meeting-assistance.js').MeetingAssistanceScanResult;
test.after(() => rmSync(home, { recursive: true, force: true }));

let ordinal = 0;
function fixture() {
  const directory = path.join(home, `case-${++ordinal}`);
  let time = 100_000;
  let timerId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const record: RecallMeetingRecord = { id: `meeting-${ordinal}`, windowId: 'reused-window', provider: 'recall', source: 'recall-desktop-sdk',
    status: 'recording', startedAt: '2026-10-17T10:00:00.000Z', sdkUploadId: `upload-${ordinal}`, segments: [] };
  const options = { directory, readMeeting: (id: string) => id === record.id ? structuredClone(record) : null,
    now: () => time,
    schedule: (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { at: time + delay, callback }); return id as unknown as ReturnType<typeof setTimeout>; },
    cancelSchedule: (id: ReturnType<typeof setTimeout>) => { timers.delete(id as unknown as number); } };
  const coordinator = createMeetingAssistanceCoordinator(options);
  const append = (text: string, isFinal = true) => {
    const id = `segment-${record.segments.length + 1}`;
    record.segments.push({ id, windowId: record.windowId, text, isFinal, timestamp: new Date(time).toISOString(), event: isFinal ? 'transcript.data' : 'transcript.partial', speaker: 'Fixture speaker' });
    return id;
  };
  const advance = (ms: number) => { time += ms; };
  const runDueTimers = () => { for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); } };
  const reopen = () => createMeetingAssistanceCoordinator(options);
  const statePath = () => path.join(directory, readdirSync(directory).find((name) => name.endsWith('.json'))!);
  return { coordinator, record, directory, append, advance, runDueTimers, timers, reopen, statePath };
}
const responseFor = (input: ScanInput): ScanResult => ({ candidate: {
  question: 'What is the approved fixture number?', why: 'A participant asked for the current number.',
  segmentIds: [input.segments.at(-1)!.id], quote: input.segments.at(-1)!.text,
}, modelIdentity: 'controlled-test-model', modelAccountingJobId: 'private-accounting-job' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('assistance GET is passive, opt-in is exact per meeting, and partial or unknown-final text never calls the scan port', async () => {
  const f = fixture();
  let calls = 0;
  f.coordinator.registerMeetingAssistanceScanPort(async (input) => { calls++; return responseFor(input); });
  assert.equal(f.coordinator.getMeetingAssistance(f.record.id).status, 'disabled');
  assert.equal(f.coordinator.getMeetingAssistance(f.record.id).checking, false);
  assert.equal(existsSync(f.directory), false);
  assert.throws(() => f.coordinator.getMeetingAssistance('foreign-meeting'), /Exact meeting/);
  f.append('Partial question?', false);
  const unknown = f.append('Legacy final status unknown');
  delete f.record.segments.find((segment) => segment.id === unknown)!.isFinal;
  f.coordinator.setMeetingAssistance(f.record.id, { enabled: true });
  await f.coordinator.checkMeetingAssistance(f.record.id);
  assert.equal(calls, 0);
  assert.equal(f.coordinator.getMeetingAssistance(f.record.id).status, 'watching');
  assert.equal(f.coordinator.getMeetingAssistance(f.record.id).finalSegmentCount, 0);
  const bytes = readFileSync(f.statePath(), 'utf8');
  f.coordinator.getMeetingAssistance(f.record.id);
  assert.equal(readFileSync(f.statePath(), 'utf8'), bytes);
});

test('final windows debounce, coalesce one flight, retain cursor across reopen, and honor durable model-call spacing', async () => {
  const f = fixture();
  f.coordinator.setMeetingAssistance(f.record.id, { enabled: true });
  let calls = 0;
  const pending = deferred<ScanResult>();
  f.coordinator.registerMeetingAssistanceScanPort(async () => { calls++; return pending.promise; });
  f.append('First finalized fixture sentence.');
  f.coordinator.requestMeetingAssistanceCheck(f.record.id);
  f.advance(1_000);
  f.append('Second finalized fixture sentence.');
  f.coordinator.requestMeetingAssistanceCheck(f.record.id);
  f.advance(1_499); f.runDueTimers(); assert.equal(calls, 0);
  f.advance(1); f.runDueTimers(); assert.equal(calls, 1);
  assert.equal(f.coordinator.getMeetingAssistance(f.record.id).checking, true);
  const same = f.coordinator.checkMeetingAssistance(f.record.id);
  const again = f.coordinator.checkMeetingAssistance(f.record.id);
  assert.equal(same, again);
  const reopened = f.reopen();
  reopened.registerMeetingAssistanceScanPort(async () => { calls++; return { candidate: null }; });
  await reopened.checkMeetingAssistance(f.record.id);
  assert.equal(calls, 1, 'a second coordinator cannot overlap the durable live claim');
  f.append('Third finalized fixture sentence.');
  f.coordinator.requestMeetingAssistanceCheck(f.record.id);
  pending.resolve({ candidate: null }); await same;
  assert.equal(f.coordinator.getMeetingAssistance(f.record.id).checking, false);
  await reopened.checkMeetingAssistance(f.record.id); assert.equal(calls, 1);
  f.advance(20_000);
  await reopened.checkMeetingAssistance(f.record.id); assert.equal(calls, 2);
  f.advance(20_000);
  await reopened.checkMeetingAssistance(f.record.id); assert.equal(calls, 2, 'same retained cursor is not scanned again');
});

test('published offer has exact source quote and stable private lookup packet; public reads omit private accounting and raw input', async () => {
  const f = fixture();
  f.append('Could you find the approved fixture number?');
  f.coordinator.setMeetingAssistance(f.record.id, { enabled: true });
  f.coordinator.registerMeetingAssistanceScanPort(async (input) => responseFor(input));
  const snapshot = await f.coordinator.checkMeetingAssistance(f.record.id);
  assert.equal(snapshot.status, 'offer');
  const offer = snapshot.offer!;
  assert.equal(snapshot.finalSegmentCount, 1);
  assert.equal(offer.quote, f.record.segments[0].text);
  assert.equal(JSON.stringify(snapshot).includes('private-accounting-job'), false);
  assert.equal(JSON.stringify(snapshot).includes('controlled-test-model'), false);
  assert.equal('evidence' in offer, false);
  assert.throws(() => f.coordinator.readPreparedMeetingLookup(f.record.id, offer.id, offer.digest), /not prepared/);
  assert.throws(() => f.coordinator.prepareMeetingLookup(f.record.id, offer.id, '0'.repeat(64)), /changed/);
  assert.throws(() => f.coordinator.prepareMeetingLookup(f.record.id, offer.id, offer.digest, { expectedVersion: snapshot.version - 1 }), /changed/);
  assert.throws(() => f.coordinator.readPreparedMeetingLookup(f.record.id, offer.id, offer.digest), /not prepared/);
  const packet = f.coordinator.prepareMeetingLookup(f.record.id, offer.id, offer.digest, { expectedVersion: snapshot.version });
  assert.match(packet.input, /untrusted source DATA/);
  assert.match(packet.input, /memory and read-only tools/);
  assert.match(packet.input, /Do not write, send, schedule/);
  assert.equal(packet.privateOriginSessionId, `sess-desktop-${createHash('sha256').update(packet.clientRequestId).digest('hex').slice(0, 24)}`);
  assert.ok(Object.isFrozen(packet)); assert.ok(Object.isFrozen(packet.segmentIds));
  const reopened = f.reopen();
  assert.deepEqual(reopened.prepareMeetingLookup(f.record.id, offer.id, offer.digest, { expectedVersion: snapshot.version - 1 }), packet);
  assert.deepEqual(reopened.readPreparedMeetingLookup(f.record.id, offer.id, offer.digest), packet);
  const publicRead = reopened.getMeetingAssistance(f.record.id);
  assert.equal(JSON.stringify(publicRead).includes(packet.input), false);
  assert.deepEqual(publicRead.recentOffers[0].lookup, { sessionId: packet.privateOriginSessionId, clientRequestId: packet.clientRequestId });
  assert.equal(publicRead.recentOffers[0].state, 'lookup_prepared');
  f.advance(180_001);
  assert.throws(() => reopened.readPreparedMeetingLookup(f.record.id, offer.id, offer.digest), /no longer current/);
  assert.throws(() => reopened.prepareMeetingLookup(f.record.id, offer.id, offer.digest), /no longer actionable/);
  assert.deepEqual(reopened.readPreparedMeetingLookup(f.record.id, offer.id, offer.digest, { acceptedReplay: true }), packet);
});

test('wrong versions, invented quotes, foreign or duplicate segment refs cannot yield an actionable offer', async () => {
  for (const change of [
    (candidate: NonNullable<ScanResult['candidate']>) => { candidate.quote = 'Invented phrase not said.'; },
    (candidate: NonNullable<ScanResult['candidate']>) => { candidate.segmentIds = ['foreign-segment']; },
    (candidate: NonNullable<ScanResult['candidate']>) => { candidate.segmentIds.push(candidate.segmentIds[0]); },
  ]) {
    const f = fixture(); f.append('Actual retained fixture question?');
    f.coordinator.setMeetingAssistance(f.record.id, { enabled: true });
    f.coordinator.registerMeetingAssistanceScanPort(async (input) => { const response = responseFor(input); change(response.candidate!); return response; });
    const result = await f.coordinator.checkMeetingAssistance(f.record.id);
    assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'scan_invalid_evidence'); assert.equal(result.offer, undefined);
  }
  const f = fixture(); f.append('Actual retained fixture question?');
  f.coordinator.setMeetingAssistance(f.record.id, { enabled: true });
  f.coordinator.registerMeetingAssistanceScanPort(async (input) => responseFor(input));
  const result = await f.coordinator.checkMeetingAssistance(f.record.id);
  assert.throws(() => f.coordinator.decideMeetingAssistanceOffer(f.record.id, result.offer!.id, result.offer!.digest,
    { decision: 'dismiss', expectedVersion: result.version - 1 }), /changed/);
  assert.equal(f.coordinator.getMeetingAssistance(f.record.id).offer?.id, result.offer!.id);
});

test('source growth is allowed but edited finals, new capture, disable, or completion during the scan suppress publication', async () => {
  for (const mode of ['grow', 'edit', 'capture', 'disable', 'complete'] as const) {
    const f = fixture(); f.append('Can you find the approved fixture number?');
    f.coordinator.setMeetingAssistance(f.record.id, { enabled: true });
    const pending = deferred<ScanResult>(); let input!: ScanInput;
    f.coordinator.registerMeetingAssistanceScanPort(async (value) => { input = value; return pending.promise; });
    const checking = f.coordinator.checkMeetingAssistance(f.record.id);
    if (mode === 'grow') f.append('New finalized context after the question.');
    if (mode === 'edit') f.record.segments[0].text = 'Canonical replacement changed the words.';
    if (mode === 'capture') f.record.sdkUploadId = 'different-capture';
    if (mode === 'disable') { f.coordinator.setMeetingAssistance(f.record.id, { enabled: false }); assert.equal(input.signal.aborted, true); }
    if (mode === 'complete') f.record.status = 'completed';
    pending.resolve(responseFor(input));
    const result = await checking;
    assert.equal(result.status === 'offer', mode === 'grow', mode);
    if (mode !== 'grow') assert.equal(result.offer, undefined, mode);
  }
});

test('dismissal, expiry and semantic duplicate guard survive reopen; deferred question needs a later explicit postmeeting choice', async () => {
  const f = fixture(); f.append('Could you find the approved fixture number?');
  f.coordinator.setMeetingAssistance(f.record.id, { enabled: true });
  let calls = 0;
  f.coordinator.registerMeetingAssistanceScanPort(async (input) => { calls++; return responseFor(input); });
  const first = await f.coordinator.checkMeetingAssistance(f.record.id);
  const dismissed = f.coordinator.decideMeetingAssistanceOffer(f.record.id, first.offer!.id, first.offer!.digest, { decision: 'dismiss', expectedVersion: first.version });
  assert.equal(dismissed.recentOffers[0].state, 'dismissed');
  const reopened = f.reopen();
  reopened.registerMeetingAssistanceScanPort(async (input) => { assert.equal(input.recentOffers[0].state, 'dismissed'); calls++; return responseFor(input); });
  f.append('Could you find the approved fixture number?'); f.advance(20_000);
  assert.equal((await reopened.checkMeetingAssistance(f.record.id)).offer, undefined);
  assert.equal(calls, 2);
  const g = fixture(); g.append('Can you retrieve the fixture capacity?');
  g.coordinator.setMeetingAssistance(g.record.id, { enabled: true });
  g.coordinator.registerMeetingAssistanceScanPort(async (input) => responseFor(input));
  const open = await g.coordinator.checkMeetingAssistance(g.record.id);
  const later = g.coordinator.decideMeetingAssistanceOffer(g.record.id, open.offer!.id, open.offer!.digest, { decision: 'defer', expectedVersion: open.version });
  assert.equal(later.recentOffers[0].state, 'deferred');
  assert.throws(() => g.coordinator.prepareMeetingLookup(g.record.id, open.offer!.id, open.offer!.digest), /no longer actionable/);
  g.record.status = 'completed'; g.advance(180_001);
  assert.equal(g.coordinator.getMeetingAssistance(g.record.id).status, 'completed');
  assert.equal(g.reopen().getMeetingAssistance(g.record.id).recentOffers[0].state, 'deferred');
  assert.ok(g.coordinator.prepareMeetingLookup(g.record.id, open.offer!.id, open.offer!.digest));
  assert.ok(g.coordinator.readPreparedMeetingLookup(g.record.id, open.offer!.id, open.offer!.digest), 'fresh explicit postmeeting choice has a fresh packet admission window');
  const h = fixture(); h.append('Can you retrieve the fixture capacity?');
  h.coordinator.setMeetingAssistance(h.record.id, { enabled: true }); h.coordinator.registerMeetingAssistanceScanPort(async (input) => responseFor(input));
  const expiring = await h.coordinator.checkMeetingAssistance(h.record.id); h.advance(180_001);
  assert.equal(h.coordinator.getMeetingAssistance(h.record.id).recentOffers[0].state, 'expired');
  assert.throws(() => h.coordinator.prepareMeetingLookup(h.record.id, expiring.offer!.id, expiring.offer!.digest), /no longer actionable/);
});

test('missing/failed scan port and bounded deadline are unavailable, never failed-open offers or raw provider errors', async () => {
  for (const mode of ['missing', 'throw', 'deadline'] as const) {
    const f = fixture(); f.append('Could you retrieve the approved number?');
    f.coordinator.setMeetingAssistance(f.record.id, { enabled: true });
    const late = deferred<ScanResult>(); let input!: ScanInput;
    if (mode === 'throw') f.coordinator.registerMeetingAssistanceScanPort(async () => { throw new Error('private-provider-error-sentinel'); });
    if (mode === 'deadline') f.coordinator.registerMeetingAssistanceScanPort(async (value) => { input = value; return late.promise; });
    const pending = f.coordinator.checkMeetingAssistance(f.record.id);
    if (mode === 'deadline') { f.advance(45_000); f.runDueTimers(); }
    const result = await pending;
    assert.equal(result.status, 'unavailable'); assert.equal(result.offer, undefined);
    assert.equal(JSON.stringify(result).includes('private-provider-error-sentinel'), false);
    if (mode === 'deadline') { assert.equal(input.signal.aborted, true); late.resolve(responseFor(input)); await Promise.resolve(); assert.equal(f.coordinator.getMeetingAssistance(f.record.id).offer, undefined); }
  }
});

test('strict corrupted or foreign stored state refuses read and mutation without resetting or losing retained bytes', () => {
  const f = fixture();
  f.coordinator.setMeetingAssistance(f.record.id, { enabled: true });
  const statePath = f.statePath();
  for (const raw of ['{broken', 'null', '[]', JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), meetingId: 'foreign-meeting' })]) {
    writeFileSync(statePath, raw);
    assert.throws(() => f.coordinator.getMeetingAssistance(f.record.id), /corrupt|mismatch/);
    assert.throws(() => f.coordinator.setMeetingAssistance(f.record.id, { enabled: false }), /corrupt|mismatch/);
    assert.equal(readFileSync(statePath, 'utf8'), raw);
  }
});

test('bounded scan passes whole exact segments only, with frozen source data and no transcript mutation', async () => {
  const f = fixture();
  for (let index = 0; index < 40; index++) f.append(`Final fixture ${index}: ${'x'.repeat(510)}`);
  const before = JSON.stringify(f.record);
  f.coordinator.setMeetingAssistance(f.record.id, { enabled: true });
  let captured!: ScanInput;
  f.coordinator.registerMeetingAssistanceScanPort(async (input) => { captured = input; return { candidate: null }; });
  await f.coordinator.checkMeetingAssistance(f.record.id);
  assert.ok(captured.segments.length <= 24);
  assert.ok(captured.segments.reduce((sum, segment) => sum + segment.text.length, 0) <= 12_000);
  assert.ok(Object.isFrozen(captured.segments));
  assert.ok(captured.segments.every((segment) => f.record.segments.some((original) => original.id === segment.id && original.text === segment.text)));
  assert.equal(JSON.stringify(f.record), before);
  assert.equal(f.coordinator.getMeetingAssistance(f.record.id).skippedFinalSegments, 16);
});

test('a long prior final never consumes the budget needed for a new final', async () => {
  const f = fixture(); f.append('a'.repeat(7_000));
  f.coordinator.setMeetingAssistance(f.record.id, { enabled: true });
  const windows: ScanInput[] = [];
  f.coordinator.registerMeetingAssistanceScanPort(async (input) => { windows.push(input); return { candidate: null }; });
  await f.coordinator.checkMeetingAssistance(f.record.id);
  const second = f.append('b'.repeat(6_000)); f.advance(20_000);
  await f.coordinator.checkMeetingAssistance(f.record.id);
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[1].segments.map((segment) => segment.id), [second]);
  const third = f.append('A short new final.'); f.advance(20_000);
  await f.coordinator.checkMeetingAssistance(f.record.id);
  assert.equal(windows.length, 3);
  assert.ok(windows[2].segments.some((segment) => segment.id === third));
  assert.ok(windows[2].segments.reduce((sum, segment) => sum + segment.text.length, 0) <= 12_000);
});

test('deferred and prepared packets never rebind to replacement transcript or another capture', async () => {
  for (const decision of ['defer', 'prepare'] as const) {
    const f = fixture(); f.append('Could you retrieve the fixture capacity?');
    f.coordinator.setMeetingAssistance(f.record.id, { enabled: true });
    f.coordinator.registerMeetingAssistanceScanPort(async (input) => responseFor(input));
    const snapshot = await f.coordinator.checkMeetingAssistance(f.record.id);
    const offer = snapshot.offer!;
    if (decision === 'defer') f.coordinator.decideMeetingAssistanceOffer(f.record.id, offer.id, offer.digest, { decision, expectedVersion: snapshot.version });
    else f.coordinator.prepareMeetingLookup(f.record.id, offer.id, offer.digest);
    f.record.status = 'completed';
    f.record.segments[0] = { ...f.record.segments[0], id: 'new-canonical-segment', text: 'The canonical transcript differs.' };
    assert.throws(() => f.reopen().prepareMeetingLookup(f.record.id, offer.id, offer.digest), /no longer actionable/);
    if (decision === 'prepare') {
      assert.throws(() => f.coordinator.readPreparedMeetingLookup(f.record.id, offer.id, offer.digest), /no longer current/);
      assert.equal(f.coordinator.readPreparedMeetingLookup(f.record.id, offer.id, offer.digest, { acceptedReplay: true }).offerDigest, offer.digest);
    }
  }
});

test('an explicit deferred postmeeting lookup survives canonical replacement as frozen historical evidence and paused suggestions', async () => {
  const f = fixture();
  f.append('Could you retrieve the original streamed fixture capacity?');
  f.coordinator.setMeetingAssistance(f.record.id, { enabled: true });
  f.coordinator.registerMeetingAssistanceScanPort(async (input) => responseFor(input));
  const snapshot = await f.coordinator.checkMeetingAssistance(f.record.id);
  const offer = snapshot.offer!;
  f.coordinator.decideMeetingAssistanceOffer(f.record.id, offer.id, offer.digest, { decision: 'defer', expectedVersion: snapshot.version });
  f.coordinator.setMeetingAssistance(f.record.id, { enabled: false });
  f.record.status = 'completed';
  f.record.canonicalStatus = 'ready';
  f.record.segments = [{ ...f.record.segments[0], id: 'canonical-new-id', text: 'Canonical correction: fixture capacity is not yet confirmed.' }];
  f.advance(180_001);
  const packet = f.reopen().prepareMeetingLookup(f.record.id, offer.id, offer.digest);
  assert.equal(packet.quote, offer.quote);
  assert.deepEqual(packet.segmentIds, offer.segmentIds);
  assert.equal(packet.sourceDigest, offer.sourceDigest);
  assert.equal(packet.offerDigest, offer.digest);
  assert.equal(packet.ownerChoice, 'deferred_lookup');
  assert.equal(packet.transcriptContext, 'historical_streamed');
  assert.match(packet.input, /HISTORICAL STREAMED CONTEXT/);
  assert.match(packet.input, /not a claim about the current canonical transcript/);
  assert.match(packet.input, /meeting_read.*CURRENT saved transcript/);
  assert.match(packet.input, /reconcile corrections or contrary evidence/);
  assert.match(packet.input, /If the current transcript is unavailable, say so/);
  assert.deepEqual(f.reopen().readPreparedMeetingLookup(f.record.id, offer.id, offer.digest), packet);
  assert.deepEqual(f.reopen().prepareMeetingLookup(f.record.id, offer.id, offer.digest), packet);
  assert.equal(f.coordinator.getMeetingAssistance(f.record.id).enabled, false);
  f.record.sdkUploadId = 'different-capture';
  assert.throws(() => f.reopen().prepareMeetingLookup(f.record.id, offer.id, offer.digest), /no longer actionable/);
  assert.throws(() => f.reopen().readPreparedMeetingLookup(f.record.id, offer.id, offer.digest), /no longer current/);
});

test('canonical readiness never revives an unasked offer and corrupt deferred history cannot prepare', async () => {
  for (const mode of ['unasked', 'corrupt'] as const) {
    const f = fixture(); f.append('Could you retrieve the streamed fixture capacity?');
    f.coordinator.setMeetingAssistance(f.record.id, { enabled: true });
    f.coordinator.registerMeetingAssistanceScanPort(async (input) => responseFor(input));
    const snapshot = await f.coordinator.checkMeetingAssistance(f.record.id);
    const offer = snapshot.offer!;
    if (mode === 'corrupt') f.coordinator.decideMeetingAssistanceOffer(f.record.id, offer.id, offer.digest, { decision: 'defer', expectedVersion: snapshot.version });
    f.record.status = 'completed'; f.record.canonicalStatus = 'ready';
    f.record.segments = [{ ...f.record.segments[0], id: 'replacement-canonical-id', text: 'Current canonical fixture words.' }];
    if (mode === 'corrupt') {
      const state = JSON.parse(readFileSync(f.statePath(), 'utf8'));
      state.offers[0].quote = 'Altered retained quote without its immutable digest.';
      writeFileSync(f.statePath(), JSON.stringify(state));
      assert.throws(() => f.reopen().prepareMeetingLookup(f.record.id, offer.id, offer.digest), /corrupt/);
    } else assert.throws(() => f.coordinator.prepareMeetingLookup(f.record.id, offer.id, offer.digest), /no longer actionable/);
  }
});

test('capacity stops new offers explicitly and retains every held deferred question without growing model context', async () => {
  const f = fixture();
  f.coordinator.setMeetingAssistance(f.record.id, { enabled: true });
  let calls = 0;
  f.coordinator.registerMeetingAssistanceScanPort(async (input) => {
    assert.ok(input.recentOffers.length <= 12);
    calls++;
    return { candidate: { question: `Where is fixture value ${calls}?`, why: 'The fixture participant asked.',
      quote: input.segments.at(-1)!.text, segmentIds: [input.segments.at(-1)!.id] } };
  });
  for (let index = 0; index < 64; index++) {
    f.append(`Please retrieve fixture value ${index}.`); f.advance(20_000);
    const result = await f.coordinator.checkMeetingAssistance(f.record.id);
    assert.equal(result.status, 'offer');
    f.coordinator.decideMeetingAssistanceOffer(f.record.id, result.offer!.id, result.offer!.digest,
      { decision: 'defer', expectedVersion: result.version });
  }
  f.append('Please retrieve one more fixture value.'); f.advance(20_000);
  const capacity = await f.coordinator.checkMeetingAssistance(f.record.id);
  assert.equal(calls, 64);
  assert.equal(capacity.status, 'unavailable'); assert.equal(capacity.reason, 'offer_history_capacity');
  assert.equal(capacity.retainedOfferCount, 64); assert.equal(capacity.heldOfferCount, 64); assert.equal(capacity.omittedOfferCount, 52);
  assert.equal(capacity.recentOffers.length, 12);
  assert.equal(capacity.keptOffers.length, 64);
  assert.equal(capacity.keptOffers[0].question, 'Where is fixture value 1?');
  assert.equal(capacity.keptOffers[63].question, 'Where is fixture value 64?');
  assert.ok(capacity.keptOffers.every((offer) => !('evidence' in offer) && !('packet' in offer) && !('modelAccountingJobId' in offer)));
  const persisted = JSON.parse(readFileSync(f.statePath(), 'utf8'));
  assert.equal(persisted.offers.length, 64); assert.ok(persisted.offers.every((offer: { state: string }) => offer.state === 'deferred'));
  assert.equal(f.reopen().getMeetingAssistance(f.record.id).heldOfferCount, 64);
});
