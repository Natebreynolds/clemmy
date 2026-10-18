import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMeetingResearchController } from './meeting-research-controller.js';
import type { MeetingAssistanceOffer, MeetingAssistanceSnapshot } from './meeting-assistance.js';
import type { MeetingResearchJob, MeetingResearchQuestion, MeetingResearchSnapshot } from './meeting-research.js';

const hash = (letter: string) => letter.repeat(64);
function offer(index = 1): MeetingAssistanceOffer {
  return { id: `controlled-offer-${index}`, digest: hash(index === 1 ? 'a' : 'b'), sourceDigest: hash('c'),
    question: `What is the approved controlled value ${index}?`, why: 'A controlled question was asked.', quote: `Controlled question ${index}.`,
    segmentIds: [`controlled-final-${index}`], createdAt: 100, expiresAt: 200, state: 'open' };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const id = 'controlled-meeting';
  const scheduled: Array<() => void> = [];
  const calls: string[] = [];
  const questions: MeetingResearchQuestion[] = [];
  let state: MeetingResearchSnapshot = { meetingId: id, version: 1, enabled: true, useMemory: false,
    maxLookups: 3, usedLookups: 0, status: 'ready', documentRefs: [], jobs: [] };
  let assistance: MeetingAssistanceSnapshot = { meetingId: id, enabled: true, version: 1, checking: false, status: 'offer', offer: offer(),
    recentOffers: [], keptOffers: [], retainedOfferCount: 1, omittedOfferCount: 0, heldOfferCount: 0, skippedFinalSegments: 0, finalSegmentCount: 1 };
  let active = 0; let maximumActive = 0;
  let getError = false; let enqueueError = false; let markError = false; let staleMark = false; let stopCount = 0; let pauseCount = 0;
  let drain: () => Promise<MeetingResearchSnapshot> = async () => structuredClone(state);
  const controller = createMeetingResearchController({
    research: {
      get: () => { calls.push('research.get'); if (getError) throw new Error('Controlled corrupt state.'); return structuredClone(state); },
      enqueue: (_id, question) => {
        calls.push('research.enqueue'); if (enqueueError) throw new Error('Controlled expired, stale or exhausted grant.');
        questions.push(structuredClone(question)); state.usedLookups++;
        return {} as MeetingResearchJob; // The bridge never consumes execution or task fields.
      },
      drain: async () => { calls.push('research.drain'); active++; maximumActive = Math.max(maximumActive, active);
        try { return await drain(); } finally { active--; } },
      stop: () => { calls.push('research.stop'); stopCount++; state = { ...state, enabled: false, status: 'disabled' }; return structuredClone(state); },
    },
    assistance: {
      get: () => { calls.push('assistance.get'); return structuredClone(assistance); },
      markQueued: (_id, offerId, digest) => {
        calls.push('assistance.markQueued'); if (markError) throw new Error('Controlled stale offer.');
        assert.equal(offerId, assistance.offer!.id); assert.equal(digest, assistance.offer!.digest);
        if (!staleMark) { const { offer: _offer, ...rest } = assistance; assistance = { ...rest, status: 'watching' }; }
      },
      set: (_id, value) => { calls.push('assistance.set'); assert.deepEqual(value, { enabled: false }); pauseCount++;
        assistance = { ...assistance, enabled: false, status: 'disabled' }; },
    },
    schedule: callback => { scheduled.push(callback); },
  });
  const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
  const runOne = async () => { assert.ok(scheduled.length); scheduled.shift()!(); await tick(); };
  return { controller, id, calls, questions, scheduled, runOne, tick,
    state: () => structuredClone(state), setState: (patch: Partial<MeetingResearchSnapshot>) => { state = { ...state, ...patch }; },
    setAssistance: (patch: Partial<MeetingAssistanceSnapshot>) => { assistance = { ...assistance, ...patch }; },
    setDrain: (value: typeof drain) => { drain = value; }, errors: (options: { get?: boolean; enqueue?: boolean; mark?: boolean; staleMark?: boolean }) => {
      getError = options.get ?? false; enqueueError = options.enqueue ?? false; markError = options.mark ?? false; staleMark = options.staleMark ?? false;
    }, maxActive: () => maximumActive, stops: () => stopCount, pauses: () => pauseCount };
}

test('construction is passive; a disabled permission wake is detached and starts no scan or execution', async () => {
  const f = fixture(); f.setState({ enabled: false, status: 'disabled' });
  assert.deepEqual(f.calls, []); assert.equal(f.scheduled.length, 0);
  assert.equal(f.controller.request(f.id), undefined); assert.deepEqual(f.calls, []);
  await f.runOne(); assert.deepEqual(f.calls, ['research.get']); assert.equal(f.scheduled.length, 0);
});

test('repeated transcript events coalesce into one exact reservation, mark and drain flight', async () => {
  const f = fixture(); const pending = deferred<MeetingResearchSnapshot>(); f.setDrain(() => pending.promise);
  for (let index = 0; index < 20; index++) f.controller.request(f.id);
  assert.equal(f.scheduled.length, 1); await f.runOne();
  for (let index = 0; index < 20; index++) f.controller.request(f.id);
  assert.equal(f.scheduled.length, 0); assert.equal(f.questions.length, 1); assert.equal(f.maxActive(), 1);
  assert.deepEqual(f.questions[0], { offerId: offer().id, offerDigest: offer().digest, sourceDigest: offer().sourceDigest,
    question: offer().question, quote: offer().quote, segmentIds: offer().segmentIds });
  assert.ok(f.calls.indexOf('research.enqueue') < f.calls.indexOf('assistance.markQueued'));
  assert.ok(f.calls.indexOf('assistance.markQueued') < f.calls.indexOf('research.drain'));
  pending.resolve(f.state()); await f.tick(); assert.equal(f.scheduled.length, 0);
});

test('a different second question arriving during a busy task wakes once after settlement without overlapping it', async () => {
  const f = fixture(); const pending = deferred<MeetingResearchSnapshot>(); let drains = 0;
  f.setDrain(async () => { drains++; return drains === 1 ? pending.promise : f.state(); });
  f.controller.request(f.id); await f.runOne();
  f.setAssistance({ status: 'offer', offer: offer(2) });
  f.controller.request(f.id); f.controller.request(f.id); assert.equal(f.scheduled.length, 0);
  pending.resolve(f.state()); await f.tick(); assert.equal(f.scheduled.length, 1);
  await f.runOne(); assert.equal(f.questions.length, 2); assert.equal(drains, 2); assert.equal(f.maxActive(), 1);
  assert.equal(f.questions[1]!.offerId, offer(2).id); assert.equal(f.scheduled.length, 0);
});

test('an unchanged stale offer cannot turn a successful mark projection into a microtask loop', async () => {
  const f = fixture(); f.errors({ staleMark: true }); f.controller.request(f.id);
  await f.runOne(); await f.tick();
  assert.equal(f.questions.length, 1); assert.equal(f.calls.filter(call => call === 'research.drain').length, 1);
  assert.equal(f.scheduled.length, 0);
});

test('corrupt state, an expired/budget-refused grant and a failed drain never schedule automatic retries', async () => {
  for (const failure of ['corrupt', 'enqueue', 'drain'] as const) {
    const f = fixture();
    if (failure === 'corrupt') f.errors({ get: true });
    if (failure === 'enqueue') { f.setState({ status: 'unavailable', reason: 'permission_expired' }); f.errors({ enqueue: true }); }
    if (failure === 'drain') f.setDrain(async () => { f.setAssistance({ status: 'offer', offer: offer(2) }); throw new Error('Controlled failed drain.'); });
    f.controller.request(f.id); await f.runOne(); await f.tick();
    assert.equal(f.scheduled.length, 0, failure); assert.equal(f.maxActive() <= 1, true);
    if (failure !== 'drain') assert.equal(f.calls.includes('research.drain'), false);
  }
});

test('a durable reservation remains consumed if marking the offer fails, with no physical dispatch or retry', async () => {
  const f = fixture(); f.errors({ mark: true }); f.controller.request(f.id); await f.runOne();
  assert.equal(f.state().usedLookups, 1); assert.equal(f.questions.length, 1);
  assert.equal(f.calls.includes('assistance.markQueued'), true); assert.equal(f.calls.includes('research.drain'), false);
  assert.equal(f.scheduled.length, 0); assert.equal(f.maxActive(), 0);
});

test('spending the final lookup pauses Quick suggestions once and cannot wake a queued second offer', async () => {
  const f = fixture(); f.setDrain(async () => {
    f.setState({ status: 'exhausted', usedLookups: 3 }); f.setAssistance({ status: 'offer', offer: offer(2) }); return f.state();
  });
  f.controller.request(f.id); await f.runOne(); await f.tick();
  assert.equal(f.pauses(), 1); assert.equal(f.questions.length, 1); assert.equal(f.scheduled.length, 0);
  f.controller.request(f.id); await f.runOne();
  assert.equal(f.pauses(), 1); assert.equal(f.stops(), 1); assert.equal(f.questions.length, 1);
});

test('paused suggestions or a completed meeting stop owned research without reserving or dispatching more work', async () => {
  for (const condition of ['paused', 'completed'] as const) {
    const f = fixture(); f.setAssistance(condition === 'paused' ? { enabled: false, status: 'disabled' } : { status: 'completed' });
    f.controller.request(f.id); await f.runOne();
    assert.equal(f.stops(), 1); assert.equal(f.questions.length, 0); assert.equal(f.calls.includes('research.drain'), false);
    assert.equal(f.scheduled.length, 0); assert.equal(f.state().enabled, false);
  }
});

test('a retained task can be observed without a new offer, but that observation never invents a question or tail wake', async () => {
  const f = fixture(); f.setAssistance({ status: 'watching', offer: undefined }); f.setDrain(async () => f.state());
  f.controller.request(f.id); await f.runOne();
  assert.equal(f.questions.length, 0); assert.equal(f.calls.filter(call => call === 'research.drain').length, 1);
  assert.equal(f.scheduled.length, 0); assert.equal(f.pauses(), 0);
});

test('authority revoked after drain starts prevents a tail wake even if the resolved snapshot looked ready', async () => {
  const f = fixture(); const pending = deferred<MeetingResearchSnapshot>(); f.setDrain(() => pending.promise);
  f.controller.request(f.id); await f.runOne();
  const staleReady = f.state(); f.setState({ enabled: false, status: 'disabled' }); f.setAssistance({ status: 'offer', offer: offer(2) });
  pending.resolve(staleReady); await f.tick();
  assert.equal(f.questions.length, 1); assert.equal(f.scheduled.length, 0);
});

test('two retained queued jobs finish after one ingress wake when each ready drain proves actual progress', async () => {
  const f = fixture(); f.setAssistance({ status: 'watching', offer: undefined });
  f.setState({ jobs: [{ id: 'retained-first', question: 'First controlled retained question.', status: 'queued' },
    { id: 'retained-second', question: 'Second controlled retained question.', status: 'queued' }] });
  let drains = 0;
  f.setDrain(async () => {
    drains++;
    const jobs = f.state().jobs.map((job, index) => index === drains - 1 ? { ...job, status: 'completed' as const } : job);
    f.setState({ jobs }); return f.state();
  });
  f.controller.request(f.id); await f.runOne(); assert.equal(f.scheduled.length, 1);
  await f.runOne(); assert.equal(f.scheduled.length, 0);
  assert.equal(drains, 2); assert.equal(f.maxActive(), 1); assert.equal(f.questions.length, 0);
  assert.equal(f.state().jobs.every(job => job.status === 'completed'), true);
});

test('a ready snapshot with unchanged queued jobs is not progress and cannot spin a wake chain', async () => {
  const f = fixture(); f.setAssistance({ status: 'watching', offer: undefined });
  f.setState({ jobs: [{ id: 'unchanged-queued', question: 'Controlled held question.', status: 'queued' }] });
  f.setDrain(async () => f.state()); f.controller.request(f.id); await f.runOne(); await f.tick();
  assert.equal(f.calls.filter(call => call === 'research.drain').length, 1);
  assert.equal(f.scheduled.length, 0); assert.equal(f.questions.length, 0); assert.equal(f.maxActive(), 1);
});

test('the last retained reservations drain even when all allowance is already reserved, then pause Quick scans', async () => {
  const f = fixture(); f.setAssistance({ status: 'watching', offer: undefined });
  f.setState({ status: 'exhausted', maxLookups: 2, usedLookups: 2,
    jobs: [{ id: 'reserved-first', question: 'First reserved question.', status: 'queued' },
      { id: 'reserved-second', question: 'Second reserved question.', status: 'queued' }] });
  let drains = 0;
  f.setDrain(async () => {
    drains++; f.setState({ jobs: f.state().jobs.map((job, index) => index === drains - 1 ? { ...job, status: 'completed' as const } : job) });
    return f.state();
  });
  f.controller.request(f.id); await f.runOne();
  assert.equal(f.pauses(), 0); assert.equal(f.scheduled.length, 1);
  await f.runOne(); assert.equal(f.pauses(), 1); assert.equal(drains, 2); assert.equal(f.questions.length, 0);
  assert.equal(f.scheduled.length, 0);
});

test('an already spent allowance pauses Quick scans before trying to reserve another offer', async () => {
  const f = fixture(); f.setState({ status: 'exhausted', usedLookups: 3 }); f.errors({ enqueue: true });
  f.controller.request(f.id); await f.runOne();
  assert.equal(f.pauses(), 1); assert.equal(f.calls.includes('research.enqueue'), false);
  assert.equal(f.calls.includes('research.drain'), false); assert.equal(f.scheduled.length, 0);
});

test('even falsely repeating progress cannot exceed eight drain cycles from one ingress wake', async () => {
  const f = fixture(); f.setAssistance({ status: 'watching', offer: undefined });
  f.setState({ jobs: [{ id: 'cycling-a', question: 'Controlled inconsistent retained state A.', status: 'queued' },
    { id: 'cycling-b', question: 'Controlled inconsistent retained state B.', status: 'completed' }] });
  f.setDrain(async () => {
    f.setState({ jobs: f.state().jobs.map(job => ({ ...job, status: job.status === 'queued' ? 'completed' as const : 'queued' as const })) });
    return f.state();
  });
  f.controller.request(f.id);
  for (let index = 0; index < 8; index++) { assert.equal(f.scheduled.length, 1); await f.runOne(); }
  assert.equal(f.scheduled.length, 0); assert.equal(f.calls.filter(call => call === 'research.drain').length, 8);
  assert.equal(f.maxActive(), 1); assert.equal(f.questions.length, 0);
});
