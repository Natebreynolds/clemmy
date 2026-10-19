import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RecallMeetingRecord } from './meeting-capture.js';
import type { MeetingResearchBoundary, MeetingResearchDispatchResult, MeetingResearchQuestion } from './meeting-research.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-research-test-'));
process.env.CLEMENTINE_HOME = home;
const { createMeetingResearchCoordinator, meetingResearchCaptureDigest } = await import('./meeting-research.js');
test.after(() => rmSync(home, { recursive: true, force: true }));
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
let ordinal = 0;
function fixture() {
  const directory = path.join(home, `case-${++ordinal}`); let time = 100_000; let calls = 0;
  const record: RecallMeetingRecord = { id: `meeting-${ordinal}`, windowId: `window-${ordinal}`, provider: 'recall', source: 'recall-desktop-sdk',
    status: 'recording', startedAt: '2026-10-17T10:00:00.000Z', sdkUploadId: `upload-${ordinal}`,
    segments: [{ id: 'final-1', windowId: `window-${ordinal}`, text: 'What is the approved fixture launch date?', isFinal: true,
      timestamp: '2026-10-17T10:00:01Z', event: 'transcript.data' }] };
  let refs = [{ id: 'doc-a', revision: 1, digest: digest('doc-a-v1') }, { id: 'doc-b', revision: 1, digest: digest('doc-b-v1') }];
  let docsAvailable = true;
  let dispatch: (input: Parameters<Parameters<typeof createMeetingResearchCoordinator>[0]['dispatch']>[0]) => Promise<MeetingResearchDispatchResult>
    = async input => { input.verify(); return { status: 'completed', task: taskFor(input.job) }; };
  let observation: 'in_progress' | 'completed' | 'blocked' | 'cancelled' | 'unknown' = 'in_progress';
  const options = { directory, now: () => time, readMeeting: (id: string) => id === record.id ? structuredClone(record) : null,
    readDocumentRefs: () => { if (!docsAvailable) throw new Error('unavailable'); return structuredClone(refs); },
    dispatch: async (input: Parameters<typeof dispatch>[0]) => { calls++; return dispatch(input); },
    observe: async () => ({ status: observation }) };
  const coordinator = createMeetingResearchCoordinator(options);
  const enable = (changes: Partial<{ useMemory: boolean; maxLookups: number; documentRefs: typeof refs; expiresAt: number }> = {}) => coordinator.set(record.id,
    { enabled: true, useMemory: true, maxLookups: 3, documentRefs: [], expectedVersion: coordinator.get(record.id).version, ...changes });
  const question = (index = 1): MeetingResearchQuestion => ({ offerId: `offer-${index}`, offerDigest: digest(`offer-${index}`), sourceDigest: digest('source'),
    question: `What is the approved fixture launch date${index > 1 ? ` for phase ${index}` : ''}?`, quote: record.segments[0]!.text, segmentIds: ['final-1'] });
  const file = () => path.join(directory, readdirSync(directory).find(item => item.endsWith('.json'))!);
  return { directory, record, options, coordinator, enable, question, file, reopen: () => createMeetingResearchCoordinator(options),
    calls: () => calls, advance: (ms: number) => { time += ms; }, setRefs: (next: typeof refs) => { refs = next; }, refs: () => structuredClone(refs),
    setDocsAvailable: (value: boolean) => { docsAvailable = value; }, setDispatch: (next: typeof dispatch) => { dispatch = next; },
    setObservation: (next: typeof observation) => { observation = next; } };
}
function taskFor(job: { id: string; clientRequestId: string; privateOriginSessionId: string }) {
  return { sessionId: job.privateOriginSessionId, sourceUserSeq: 42, attemptId: `attempt-${job.id}`, runId: `run-${job.id}`, clientRequestId: job.clientRequestId };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('GET is passive, permission defaults off, exact selected sources and stale versions are enforced', () => {
  const f = fixture(); const state = f.coordinator.get(f.record.id);
  assert.equal(state.enabled, false); assert.equal(state.useMemory, false); assert.equal(state.status, 'disabled');
  assert.equal(existsSync(f.directory), false);
  assert.throws(() => f.coordinator.enqueue(f.record.id, f.question()), /disabled/);
  assert.throws(() => f.enable({ useMemory: false }), /select_a_research_source/);
  assert.throws(() => f.enable({ documentRefs: [{ id: 'foreign', revision: 1, digest: digest('other') }] }), /documents_changed/);
  const enabled = f.enable({ useMemory: false, documentRefs: [f.refs()[0]!] });
  assert.equal(enabled.status, 'ready'); assert.equal(enabled.documentRefs.length, 1);
  assert.throws(() => f.coordinator.set(f.record.id, { enabled: false, useMemory: false, maxLookups: 3, documentRefs: [], expectedVersion: 0 }), /permission_changed/);
  const bytes = readFileSync(f.file(), 'utf8'); f.coordinator.get(f.record.id); assert.equal(readFileSync(f.file(), 'utf8'), bytes);
  assert.equal(f.calls(), 0);
});

test('new model choice is frozen in reservation identity and duplicate/restarted work keeps the original pin', () => {
  const f = fixture(); f.enable();
  let chosen = 'controlled-live-a';
  const coordinator = createMeetingResearchCoordinator({ ...f.options, resolveModelPin: () => ({ version: 1,
    modelId: chosen, provider: 'byo', role: 'quick', profileRevision: 4, selection: 'explicit', fallback: 'none' }) });
  const original = coordinator.enqueue(f.record.id, f.question());
  assert.equal(original.modelPin?.modelId, 'controlled-live-a');
  assert.equal(original.captureDigest, meetingResearchCaptureDigest(f.record));
  chosen = 'controlled-live-b';
  assert.deepEqual(coordinator.enqueue(f.record.id, f.question()), original, 'a preference change cannot create a duplicate or reroute the reserved question');
  assert.deepEqual(f.reopen().enqueue(f.record.id, f.question()), original);
  const saved = JSON.parse(readFileSync(f.file(), 'utf8'));
  saved.jobs[0].modelPin.modelId = chosen; writeFileSync(f.file(), JSON.stringify(saved));
  assert.throws(() => coordinator.get(f.record.id), /state_corrupt/, 'a different retained selection does not inherit the old reservation identity');
});

test('postmeeting handoff is passive and preserves original capture ownership after permission changes', () => {
  const f = fixture(); f.enable(); const job = f.coordinator.enqueue(f.record.id, f.question());
  f.coordinator.stop(f.record.id); f.record.status = 'completed';
  const before = readFileSync(f.file(), 'utf8');
  const handoff = f.reopen().readHandoff(f.record.id);
  assert.equal(handoff.jobs[0]?.id, job.id); assert.equal(handoff.jobs[0]?.exactCapture, true);
  assert.equal(handoff.jobs[0]?.state, 'cancelled'); assert.equal(readFileSync(f.file(), 'utf8'), before);
  f.record.sdkUploadId = 'another-capture';
  assert.equal(f.reopen().readHandoff(f.record.id).jobs[0]?.exactCapture, false);
});

test('reservation is durable before dispatch, identity is stable and duplicate questions do not spend again', async () => {
  const f = fixture(); f.enable({ maxLookups: 1 });
  const job = f.coordinator.enqueue(f.record.id, f.question());
  assert.deepEqual(f.reopen().enqueue(f.record.id, f.question()), job);
  assert.equal(f.coordinator.get(f.record.id).usedLookups, 1);
  assert.throws(() => f.coordinator.enqueue(f.record.id, f.question(2)), /lookup_budget_exhausted/);
  let boundary: MeetingResearchBoundary | undefined;
  f.setDispatch(async input => {
    const raw = JSON.parse(readFileSync(f.file(), 'utf8'));
    assert.equal(raw.jobs[0].state, 'running'); assert.equal(raw.jobs[0].clientRequestId, job.clientRequestId);
    boundary = input.verify(); assert.ok(Object.isFrozen(boundary));
    assert.deepEqual(boundary.memoryScope, { projectId: null, agentKey: null, exact: true });
    return { status: 'completed', task: taskFor(input.job) };
  });
  const result = await f.coordinator.drain(f.record.id);
  assert.equal(result.jobs[0]!.status, 'completed'); assert.equal(f.calls(), 1);
  assert.equal('grantDigest' in result.jobs[0]!, false); assert.equal('quote' in result.jobs[0]!, false);
  assert.equal(JSON.stringify(result).includes('final-1'), false);
  await f.reopen().drain(f.record.id); assert.equal(f.calls(), 1);
  assert.throws(() => f.coordinator.verifyResearchBoundary(boundary!.reference), /research_authority_changed/);
});

test('same-process coordinators share one flight and owner pause aborts + revokes it without replay', async () => {
  const f = fixture(); f.enable(); f.coordinator.enqueue(f.record.id, f.question());
  const pending = deferred<MeetingResearchDispatchResult>(); let signal: AbortSignal | undefined; let verify!: () => MeetingResearchBoundary;
  f.setDispatch(async input => { signal = input.signal; verify = input.verify; return pending.promise; });
  const first = f.coordinator.drain(f.record.id); const second = f.reopen().drain(f.record.id);
  assert.equal(first, second); assert.equal(f.calls(), 1); assert.equal(verify().grant.enabled, true);
  f.coordinator.stop(f.record.id); assert.equal(signal!.aborted, true); assert.throws(verify, /disabled/);
  const raw = JSON.parse(readFileSync(f.file(), 'utf8')); pending.resolve({ status: 'completed', task: taskFor(raw.jobs[0]) });
  const final = await first; assert.equal(final.jobs[0]!.status, 'cancelled'); assert.equal(final.enabled, false);
  await f.reopen().drain(f.record.id); assert.equal(f.calls(), 1);
});

test('selected document changes revoke reads; unrelated additions do not expand or invalidate authority', async () => {
  const f = fixture(); const selected = f.refs()[0]!; f.enable({ useMemory: false, documentRefs: [selected] });
  f.coordinator.enqueue(f.record.id, f.question());
  f.setRefs([...f.refs(), { id: 'new-doc', revision: 1, digest: digest('new') }]);
  assert.deepEqual(f.coordinator.get(f.record.id).documentRefs, [selected]);
  f.setDispatch(async input => { assert.equal(input.verify().memoryScope, null); assert.deepEqual(input.verify().documentRefs, [selected]);
    f.setRefs([{ ...selected, revision: 2, digest: digest('changed') }]); assert.throws(input.verify, /documents_changed/);
    return { status: 'blocked', reason: 'documents_changed' }; });
  const result = await f.coordinator.drain(f.record.id);
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'documents_changed'); assert.equal(result.jobs[0]!.status, 'blocked');
  assert.equal(f.calls(), 1);
});

test('capture changes, completion and expiry refuse both dispatch and in-flight authority', async () => {
  for (const change of ['capture', 'completed', 'expiry'] as const) {
    const f = fixture(); f.enable(); f.coordinator.enqueue(f.record.id, f.question());
    f.setDispatch(async input => {
      input.verify();
      if (change === 'capture') f.record.sdkUploadId = 'different-upload';
      else if (change === 'completed') f.record.status = 'completed';
      else f.advance(2 * 60 * 60_000 + 1);
      assert.throws(input.verify, /capture_changed|meeting_not_recording|permission_expired/);
      return { status: 'blocked', reason: 'changed' };
    });
    const result = await f.coordinator.drain(f.record.id); assert.equal(result.status, 'unavailable'); assert.equal(f.calls(), 1);
  }
  const f = fixture(); assert.throws(() => f.enable({ expiresAt: 100_000 + 2 * 60 * 60_000 + 1 }), /invalid_expiry/);
  assert.equal(meetingResearchCaptureDigest(f.record), digest(JSON.stringify([f.record.id, f.record.windowId, f.record.startedAt, f.record.provider, f.record.source, f.record.sdkUploadId])));
});

test('unknown dispatch outcome stays blocked with its reservation consumed and never retries', async () => {
  const f = fixture(); f.enable({ maxLookups: 1 }); f.coordinator.enqueue(f.record.id, f.question());
  f.setDispatch(async () => { throw new Error('acknowledgement lost after canonical acceptance'); });
  const result = await f.coordinator.drain(f.record.id);
  assert.equal(result.jobs[0]!.status, 'blocked'); assert.equal(result.jobs[0]!.outcomeUnknown, true);
  assert.equal(result.jobs[0]!.reason, 'dispatch_outcome_unknown');
  await f.reopen().drain(f.record.id); assert.equal(f.calls(), 1); assert.equal(result.usedLookups, 1);
});

test('abandoned pre-ack reservation cannot dispatch on recovery; exact accepted tasks are observed only', async () => {
  const f = fixture(); f.enable(); f.coordinator.enqueue(f.record.id, f.question());
  const raw = JSON.parse(readFileSync(f.file(), 'utf8')); raw.jobs[0].state = 'running'; raw.jobs[0].startedAt = 99_000;
  writeFileSync(f.file(), JSON.stringify(raw));
  const recovered = await f.reopen().drain(f.record.id);
  assert.equal(recovered.jobs[0]!.status, 'blocked'); assert.equal(recovered.jobs[0]!.outcomeUnknown, true); assert.equal(f.calls(), 0);
  const g = fixture(); g.enable(); g.coordinator.enqueue(g.record.id, g.question());
  g.setDispatch(async input => ({ status: 'accepted', task: taskFor(input.job) }));
  assert.equal((await g.coordinator.drain(g.record.id)).jobs[0]!.status, 'running');
  assert.equal((await g.reopen().drain(g.record.id)).jobs[0]!.status, 'running');
  g.setObservation('completed'); assert.equal((await g.reopen().drain(g.record.id)).jobs[0]!.status, 'completed'); assert.equal(g.calls(), 1);
});

test('question evidence, accepted identity and corrupted state are fail closed', async () => {
  const f = fixture(); f.enable();
  assert.throws(() => f.coordinator.enqueue(f.record.id, { ...f.question(), quote: 'not in this meeting' }), /question_evidence_changed/);
  assert.throws(() => f.coordinator.enqueue(f.record.id, { ...f.question(), segmentIds: ['final-1', 'final-1'] }), /question_evidence_changed/);
  f.record.segments[0]!.isFinal = false; assert.throws(() => f.coordinator.enqueue(f.record.id, f.question()), /question_evidence_changed/);
  f.record.segments[0]!.isFinal = true;
  f.coordinator.enqueue(f.record.id, f.question());
  f.setDispatch(async input => ({ status: 'completed', task: { ...taskFor(input.job), sessionId: 'foreign-session' } }));
  const result = await f.coordinator.drain(f.record.id); assert.equal(result.jobs[0]!.status, 'blocked'); assert.equal(result.jobs[0]!.outcomeUnknown, true);
  const raw = JSON.parse(readFileSync(f.file(), 'utf8')); raw.jobs[0].question.question = 'tampered'; writeFileSync(f.file(), JSON.stringify(raw));
  assert.throws(() => f.reopen().get(f.record.id), /state_corrupt/); assert.equal(f.calls(), 1);
});

test('unreadable selected docs fail closed, changing permission cancels old queue, no-op save does not reset budget', () => {
  const f = fixture(); f.enable({ maxLookups: 1, documentRefs: [f.refs()[0]!] }); const job = f.coordinator.enqueue(f.record.id, f.question());
  const unchanged = f.enable({ maxLookups: 1, documentRefs: [f.refs()[0]!] }); assert.equal(unchanged.usedLookups, 1);
  assert.equal(f.coordinator.enqueue(f.record.id, f.question()).id, job.id);
  f.setDocsAvailable(false); assert.equal(f.coordinator.get(f.record.id).reason, 'documents_unavailable');
  assert.throws(() => f.coordinator.enqueue(f.record.id, f.question(2)), /documents_unavailable/);
  f.setDocsAvailable(true); const changed = f.enable({ maxLookups: 2 }); assert.equal(changed.jobs[0]!.status, 'cancelled'); assert.equal(changed.usedLookups, 1);
});

test('bindTask retains canonical acceptance before awaiting execution; conflicting identities cannot replace it', async () => {
  const f = fixture(); f.enable(); const job = f.coordinator.enqueue(f.record.id, f.question());
  const pending = deferred<MeetingResearchDispatchResult>(); let bind!: (task: ReturnType<typeof taskFor>) => void;
  f.setDispatch(async input => { bind = input.bindTask; input.bindTask(taskFor(input.job)); return pending.promise; });
  const running = f.coordinator.drain(f.record.id);
  assert.deepEqual(f.coordinator.get(f.record.id).jobs[0]!.task, taskFor(job));
  assert.throws(() => bind({ ...taskFor(job), sourceUserSeq: 43 }), /accepted_task_mismatch/);
  f.reopen().stop(f.record.id);
  assert.deepEqual(f.coordinator.get(f.record.id).jobs[0]!.task, taskFor(job));
  pending.resolve({ status: 'completed', task: taskFor(job) });
  assert.equal((await running).jobs[0]!.status, 'cancelled');
});

test('queued jobs drain serially and an uncertain predecessor blocks fresh dispatch until exact observation settles it', async () => {
  const f = fixture(); f.enable(); f.coordinator.enqueue(f.record.id, f.question()); f.coordinator.enqueue(f.record.id, f.question(2));
  assert.deepEqual((await f.coordinator.drain(f.record.id)).jobs.map(job => job.status), ['completed', 'completed']); assert.equal(f.calls(), 2);
  const g = fixture(); g.enable(); g.coordinator.enqueue(g.record.id, g.question()); g.coordinator.enqueue(g.record.id, g.question(2));
  let first = true;
  g.setDispatch(async input => { if (first) { first = false; input.bindTask(taskFor(input.job)); throw new Error('ack lost'); }
    return { status: 'completed', task: taskFor(input.job) }; });
  const unknown = await g.coordinator.drain(g.record.id); assert.equal(unknown.reason, 'task_outcome_unknown'); assert.equal(g.calls(), 1);
  await g.reopen().drain(g.record.id); assert.equal(g.calls(), 1);
  g.setObservation('completed'); const settled = await g.reopen().drain(g.record.id);
  assert.deepEqual(settled.jobs.map(job => job.status), ['completed', 'completed']); assert.equal(g.calls(), 2);
});

test('corrected queued transcript is cancelled before dispatch; unrelated corrupt document store does not stop facts-only scope', async () => {
  const f = fixture(); f.enable(); f.coordinator.enqueue(f.record.id, f.question());
  f.record.segments[0]!.text = 'Corrected transcript line.';
  const result = await f.coordinator.drain(f.record.id); assert.equal(result.jobs[0]!.status, 'cancelled'); assert.equal(f.calls(), 0);
  const g = fixture(); g.setDocsAvailable(false); g.enable(); g.coordinator.enqueue(g.record.id, g.question());
  assert.equal((await g.coordinator.drain(g.record.id)).jobs[0]!.status, 'completed');
});

test('idle drain and unchanged save write nothing; explicit save renews expired permission without client timestamps', async () => {
  const f = fixture(); f.enable(); const before = readFileSync(f.file(), 'utf8');
  await f.coordinator.drain(f.record.id); f.enable(); assert.equal(readFileSync(f.file(), 'utf8'), before);
  f.advance(2 * 60 * 60_000 + 1); assert.equal(f.coordinator.get(f.record.id).reason, 'permission_expired');
  const renewed = f.enable(); assert.equal(renewed.status, 'ready'); assert.ok(renewed.expiresAt! > JSON.parse(before).grant.expiresAt);
});

test('canonical Stop is cancelled and preserves its accepted task without spending another lookup', async () => {
  const f = fixture(); f.enable(); const job = f.coordinator.enqueue(f.record.id, f.question());
  f.setDispatch(async input => { input.bindTask(taskFor(input.job)); return { status: 'cancelled', reason: 'owner_stopped' }; });
  const stopped = await f.coordinator.drain(f.record.id);
  assert.equal(stopped.jobs[0]!.status, 'cancelled'); assert.equal(stopped.jobs[0]!.reason, 'owner_stopped');
  assert.deepEqual(stopped.jobs[0]!.task, taskFor(job)); assert.equal(stopped.jobs[0]!.outcomeUnknown, undefined);
  assert.equal(stopped.usedLookups, 1); await f.reopen().drain(f.record.id); assert.equal(f.calls(), 1);
  const g = fixture(); g.enable(); const second = g.coordinator.enqueue(g.record.id, g.question());
  g.setDispatch(async input => ({ status: 'cancelled', task: taskFor(input.job) }));
  assert.deepEqual((await g.coordinator.drain(g.record.id)).jobs[0]!.task, taskFor(second));
});

test('oversized retained research state refuses before parsing or dispatch', () => {
  const f = fixture(); f.enable(); truncateSync(f.file(), 4 * 1024 * 1024 + 1);
  assert.throws(() => f.coordinator.get(f.record.id), /state_unavailable/); assert.equal(f.calls(), 0);
});

test('meeting lookup budget survives pause, renewed consent, changed document revisions and cancelled reservations', () => {
  const f = fixture(); f.enable({ maxLookups: 1 }); f.coordinator.enqueue(f.record.id, f.question());
  f.coordinator.stop(f.record.id); assert.equal(f.coordinator.get(f.record.id).usedLookups, 1);
  f.enable({ maxLookups: 1 }); assert.equal(f.coordinator.get(f.record.id).status, 'exhausted');
  assert.throws(() => f.coordinator.enqueue(f.record.id, f.question(2)), /lookup_budget_exhausted/);
  f.enable({ maxLookups: 2, useMemory: false, documentRefs: [f.refs()[0]!] });
  f.coordinator.enqueue(f.record.id, f.question(2)); assert.equal(f.coordinator.get(f.record.id).usedLookups, 2);
  f.setRefs([{ id: 'doc-a', revision: 2, digest: digest('doc-a-v2') }]);
  f.enable({ maxLookups: 2, useMemory: false, documentRefs: f.refs() });
  assert.equal(f.coordinator.get(f.record.id).usedLookups, 2);
  assert.throws(() => f.coordinator.enqueue(f.record.id, f.question(3)), /lookup_budget_exhausted/);
  assert.equal(f.calls(), 0, 'even pre-dispatch cancellation retains the reserved allowance');
  const g = fixture(); g.enable({ maxLookups: 8 });
  for (let index = 1; index <= 8; index++) g.coordinator.enqueue(g.record.id, g.question(index));
  g.coordinator.stop(g.record.id); g.enable({ maxLookups: 8 });
  assert.equal(g.coordinator.get(g.record.id).usedLookups, 8);
  assert.throws(() => g.coordinator.enqueue(g.record.id, g.question(9)), /lookup_budget_exhausted/);
});
