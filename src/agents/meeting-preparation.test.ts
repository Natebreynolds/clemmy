import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEFAULT_CALENDAR_WATCH_CONFIG, emptyCalendarWatchState, processCalendarWatchTick,
  type CalEvent, type CalendarWatchState, type CalendarWatchDeps } from './calendar-watch.js';
import { CalendarPreparationReadSchema, calendarPreparationConnectionKey, calendarPreparationEventsDigest,
  projectMeetingPreparationCandidates, resolveMeetingPreparation, meetingPreparationMaxObservationAgeMs,
  meetingPreparationWakeFingerprint, createMeetingPreparationWake,
  projectMeetingPreparationReadiness, meetingPreparationOpportunity,
  validMeetingPreparationOrigin,
  type CalendarPreparationRead, type MeetingPreparationCandidate } from './meeting-preparation.js';
import { DEFAULT_NOTICING_CONFIG, emptyNoticingState, runNoticingTick,
  type NoticingState, type NoticingObservation, type NoticingTickDeps } from './noticing.js';
import { renderNoticingApprovedTask } from '../runtime/harness/noticing-approved-task.js';

const NOW = Date.parse('2026-10-20T14:00:00Z');
const M = 60_000;
const hash = createHash('sha256').update('controlled-calendar-definition').digest('hex');
const event = (patch: Partial<CalEvent> = {}): CalEvent => ({ id: 'controlled-occurrence-1', subject: 'Controlled meeting',
  startMs: NOW + 60 * M, endMs: NOW + 90 * M, isAllDay: false, isCancelled: false,
  showAs: 'busy', myResponse: 'accepted', attendeeCount: 2, ...patch });
const proof = (accountId = 'controlled-account-1', patch: Partial<CalendarPreparationRead> = {}): CalendarPreparationRead => ({
  version: 1, operationId: 'controlled_calendar_list', accountId, tickId: 'controlled-tick',
  observedAt: new Date(NOW).toISOString(), windowStartMs: NOW, windowEndMs: NOW + 24 * 60 * M,
  activationId: 'controlled-activation', authorityRootId: 'controlled-authority', invocationPlanDigest: hash,
  bindingSnapshotDigest: hash, definitionFingerprint: hash, resultRef: 'controlled-result', resultKind: 'single_read', ...patch,
});
const connected = new Set([calendarPreparationConnectionKey('controlled_calendar_list', 'controlled-account-1', hash)]);
function stateFor(events: CalEvent[] = [event()], metadata = proof()): CalendarWatchState {
  const state = emptyCalendarWatchState();
  const snapshot = Object.fromEntries(events.map(row => [row.id, row]));
  state.snapshot[metadata.accountId] = snapshot;
  state.snapshotEvidence = { [metadata.accountId]: { ...metadata, eventsDigest: calendarPreparationEventsDigest(snapshot) } };
  return state;
}
const project = (state = stateFor(), now = NOW) => projectMeetingPreparationCandidates({ state, enabled: true, now, connected });

test('preparation requires its own successful account observation, not a refreshed global timestamp', async () => {
  const state = stateFor();
  const old = JSON.stringify(state.snapshot['controlled-account-1']);
  const other = event({ id: 'other', subject: 'Other controlled meeting' });
  const deps: CalendarWatchDeps = {
    now: () => NOW + M, tickId: 'next-controlled-tick', source: 'test', timezone: 'UTC', config: DEFAULT_CALENDAR_WATCH_CONFIG,
    readAccounts: async () => ({ reads: [{ operationId: 'controlled_calendar_list', accountId: 'controlled-account-2', accountLabel: 'Controlled account', events: [other],
      preparationEvidence: proof('controlled-account-2', { observedAt: new Date(NOW + M).toISOString() }) }],
      failures: [{ operationId: 'controlled_calendar_list', accountId: 'controlled-account-1', reason: 'Controlled read failure' },
        { operationId: 'calendar', reason: 'Unrelated controlled provider could not be learned' }] }),
    notify: () => {}, isNotificationRead: () => false, markNotificationRead: () => {}, loadState: () => state, saveState: () => {},
  };
  await processCalendarWatchTick(deps);
  assert.equal(JSON.stringify(state.snapshot['controlled-account-1']), old, 'ordinary watch history remains');
  assert.equal(state.snapshotAt, new Date(NOW + M).toISOString());
  assert.equal(state.snapshotEvidence?.['controlled-account-1'], undefined);
  assert.equal(project(state, NOW + M).length, 0, 'the other successful account cannot freshen this account');
  assert.equal(projectMeetingPreparationCandidates({ state, enabled: true, now: NOW + M,
    connected: new Set([calendarPreparationConnectionKey('controlled_calendar_list', 'controlled-account-2', hash)]) }).length, 1,
  'an unrelated unknown-account failure cannot negate this account’s fresh exact successful read');
});

test('old caches, missing proof, disconnected/changed definitions and disabled suggestions cannot seed preparation', () => {
  const old = stateFor(); delete old.snapshotEvidence;
  assert.equal(project(old).length, 0);
  assert.equal(projectMeetingPreparationCandidates({ state: stateFor(), enabled: false, now: NOW, connected }).length, 0);
  assert.equal(projectMeetingPreparationCandidates({ state: stateFor(), enabled: true, now: NOW, connected: new Set() }).length, 0);
  const changed = new Set([calendarPreparationConnectionKey('controlled_calendar_list', 'controlled-account-1', 'other-definition')]);
  assert.equal(projectMeetingPreparationCandidates({ state: stateFor(), enabled: true, now: NOW, connected: changed }).length, 0);
  const invalid = stateFor(); invalid.snapshotEvidence!['controlled-account-1']!.accountId = 'foreign-account';
  assert.equal(project(invalid).length, 0);
  assert.equal(CalendarPreparationReadSchema.safeParse({ ...proof(), resultRef: undefined }).success, false);
});

test('passive readiness describes each missing gate without changing settings or claiming every meeting is prepared', () => {
  const ready = { optedIn: true, noticingEnabled: true, quietHours: false, watchEnabled: true,
    connection: 'present' as const, calendarReadKnown: true, candidates: 1 };
  assert.equal(projectMeetingPreparationReadiness(ready).state, 'ready');
  assert.equal(projectMeetingPreparationReadiness({ ...ready, optedIn: false }).state, 'suggestions_off');
  assert.equal(projectMeetingPreparationReadiness({ ...ready, noticingEnabled: false }).state, 'suggestions_off');
  assert.equal(projectMeetingPreparationReadiness({ ...ready, quietHours: true }).state, 'suggestions_off');
  assert.equal(projectMeetingPreparationReadiness({ ...ready, watchEnabled: false }).state, 'watch_off');
  assert.equal(projectMeetingPreparationReadiness({ ...ready, connection: 'none' }).state, 'calendar_needed');
  assert.equal(projectMeetingPreparationReadiness({ ...ready, connection: 'unknown' }).state, 'waiting_for_calendar');
  assert.equal(projectMeetingPreparationReadiness({ ...ready, candidates: 0 }).state, 'waiting_for_calendar');
  const modelView = meetingPreparationOpportunity(project()[0]!);
  assert.equal(Object.hasOwn(modelView, 'observation'), false, 'model selection context omits execution receipt metadata');
  assert.equal(JSON.stringify(ready), JSON.stringify({ optedIn: true, noticingEnabled: true, quietHours: false, watchEnabled: true,
    connection: 'present', calendarReadKnown: true, candidates: 1 }));
});

test('time, cancellation, participation and retained-event digest floors are enforced', () => {
  for (const patch of [ { isCancelled: true }, { isAllDay: true }, { myResponse: 'declined' }, { showAs: 'free' },
    { startMs: NOW + 9 * M }, { startMs: NOW - M }, { startMs: NOW + 25 * 60 * M }, { endMs: NOW + 30 * M } ]) {
    assert.equal(project(stateFor([event(patch)])).length, 0);
  }
  assert.equal(project(stateFor([event()], proof('controlled-account-1', { observedAt: new Date(NOW + M).toISOString() }))).length, 0);
  assert.equal(project(stateFor(), NOW + 21 * M).length, 0);
  const tampered = stateFor(); tampered.snapshot['controlled-account-1']!['controlled-occurrence-1']!.subject = 'Changed retained data';
  assert.equal(project(tampered).length, 0);
  assert.equal(meetingPreparationMaxObservationAgeMs(30), 65 * M);
  assert.equal(meetingPreparationMaxObservationAgeMs(120), 90 * M);
  assert.equal(meetingPreparationMaxObservationAgeMs(Number.NaN), 0);
  assert.equal(projectMeetingPreparationCandidates({ state: stateFor(), enabled: true, now: NOW + 25 * M, connected,
    maxObservationAgeMs: meetingPreparationMaxObservationAgeMs(30) }).length, 1);
});

test('same event reread keeps revision; moves, edits, starts and recurring occurrences never substitute by title', () => {
  const original = project()[0]!;
  const binding = { candidateId: original.candidateId, revision: original.revision };
  assert.equal(resolveMeetingPreparation(binding, [original]), original);
  assert.equal(validMeetingPreparationOrigin(original, binding), true);
  assert.equal(validMeetingPreparationOrigin({ ...original, accountId: 'wrong-account' }, binding), false);
  const reread = project(stateFor([event()], proof('controlled-account-1', { observedAt: new Date(NOW + M).toISOString(), tickId: 'later-tick', resultRef: 'later-result' })), NOW + M)[0]!;
  assert.equal(reread.candidateId, original.candidateId); assert.equal(reread.revision, original.revision);
  assert.equal(meetingPreparationWakeFingerprint([reread]), meetingPreparationWakeFingerprint([original]));
  const edited = project(stateFor([event({ subject: 'Changed controlled title' })]))[0]!;
  assert.equal(edited.candidateId, original.candidateId); assert.notEqual(edited.revision, original.revision);
  assert.equal(resolveMeetingPreparation(original, [edited]), null);
  const moved = project(stateFor([event({ startMs: NOW + 120 * M, endMs: NOW + 150 * M })]))[0]!;
  assert.notEqual(moved.candidateId, original.candidateId);
  assert.equal(resolveMeetingPreparation(original, [moved]), null);
  assert.equal(project(stateFor(), NOW + 55 * M).length, 0);
  const two = project(stateFor([event(), event({ id: 'controlled-occurrence-2', startMs: NOW + 180 * M, endMs: NOW + 210 * M })]));
  assert.equal(two.length, 2); assert.notEqual(two[0]!.candidateId, two[1]!.candidateId);
});

test('an existing offer stays answerable below the new-offer lead window, but never after start or changed evidence', async () => {
  const state = stateFor([event({ startMs: NOW + 15 * M, endMs: NOW + 45 * M })]);
  const original = project(state)[0]!; assert.ok(original);
  const binding = { candidateId: original.candidateId, revision: original.revision };
  const atAnswer = NOW + 6 * M;
  const answer = (snapshot = state, now = atAnswer) => projectMeetingPreparationCandidates({
    state: snapshot, enabled: true, now, connected, phase: 'answer' });
  assert.equal(project(state, atAnswer).length, 0, 'new offers still need ten minutes');
  assert.equal(resolveMeetingPreparation(binding, answer())?.revision, original.revision);
  assert.equal(answer(state, NOW + 15 * M).length, 0, 'a started meeting cannot be accepted');
  assert.equal(resolveMeetingPreparation(binding, answer(stateFor([event({ isCancelled: true })]))), null);
  assert.equal(resolveMeetingPreparation(binding, answer(stateFor([event({ startMs: NOW + 120 * M })]))), null);
  assert.equal(answer(state, NOW + 21 * M).length, 0);
  assert.equal(projectMeetingPreparationCandidates({ state, enabled: false, now: atAnswer, connected, phase: 'answer' }).length, 0);

  const h = noticingHarness(original);
  await runNoticingTick(h.deps);
  const phases: Array<'offer' | 'answer' | undefined> = [];
  h.deps.now = () => atAnswer;
  h.deps.propose = async () => null;
  h.deps.resolveMeetingPreparation = (binding, phase) => {
    phases.push(phase);
    return resolveMeetingPreparation(binding, phase === 'answer' ? answer() : project(state, atAnswer));
  };
  await runNoticingTick(h.deps);
  assert.equal(Object.values(h.state().proposals)[0]?.status, 'open', 'existing offers do not retire just for crossing ten minutes');
  assert.ok(phases.includes('answer'));
});

test('ambiguous repeated provider event IDs keep ordinary watch data but no preparation proof', async () => {
  const state = emptyCalendarWatchState();
  await processCalendarWatchTick({ now: () => NOW, tickId: 'controlled-tick', source: 'test', timezone: 'UTC', config: DEFAULT_CALENDAR_WATCH_CONFIG,
    readAccounts: async () => ({ reads: [{ operationId: proof().operationId, accountId: proof().accountId, accountLabel: 'Controlled account',
      events: [event(), event({ startMs: NOW + 120 * M, endMs: NOW + 150 * M })], preparationEvidence: proof() }], failures: [] }),
    notify: () => {}, isNotificationRead: () => false, markNotificationRead: () => {}, loadState: () => state, saveState: () => {} });
  assert.equal(project(state).length, 0);
});

test('calendar wakes coalesce, dedupe across retained state, preserve failed opportunities and reject a stale finish', async () => {
  let now = NOW, enabled = true, fingerprint: string | null = 'controlled-revision', admittedFingerprint: string | undefined;
  let retryAt = 0, calls = 0, release!: (value: boolean) => void;
  const wake = createMeetingPreparationWake({ now: () => now,
    read: () => ({ enabled, fingerprint, admittedFingerprint, retryAt }),
    run: () => { calls++; return new Promise<boolean>(resolve => { release = resolve; }); },
    retain: value => { admittedFingerprint = value; } });
  const first = wake(), second = wake(); assert.equal(first, second); assert.equal(calls, 1);
  release(false); assert.equal(await first, false); assert.equal(admittedFingerprint, undefined);
  retryAt = now + M; assert.equal(await wake(), false); assert.equal(calls, 1);
  now += M; const admitted = wake(); release(true); assert.equal(await admitted, true); assert.equal(admittedFingerprint, fingerprint);
  assert.equal(await wake(), false); assert.equal(calls, 2);
  const restarted = createMeetingPreparationWake({ now: () => now, read: () => ({ enabled, fingerprint, admittedFingerprint }),
    run: async () => { calls++; return true; }, retain: value => { admittedFingerprint = value; } });
  assert.equal(await restarted(), false); assert.equal(calls, 2);
  fingerprint = 'changed-revision'; const stale = wake(); fingerprint = null; release(true); await stale;
  assert.equal(admittedFingerprint, 'controlled-revision');
  enabled = false; fingerprint = 'new-revision'; assert.equal(await wake(), false);
});

function noticingHarness(candidate: MeetingPreparationCandidate, state: NoticingState = emptyNoticingState()) {
  let current: MeetingPreparationCandidate | null = candidate;
  const asked: Array<NoticingState['proposals'][string]> = [];
  const observation: NoticingObservation = { at: new Date(NOW).toISOString(), goals: [], work: { runs: [], waits: [], drafts: [] },
    calendar: [], upcomingMeetings: [candidate], conversations: [], memories: [] };
  const deps: NoticingTickDeps = { now: () => NOW, tickId: 'controlled-noticing', source: 'test', config: { ...DEFAULT_NOTICING_CONFIG, dailyCap: 10 }, rules: [],
    observe: async () => observation, propose: async ({ evidenceDigest }) => ({ modelIdentity: 'controlled-brain', answer: {
      proposal: { title: 'Prepare for the controlled meeting', action: 'Prepare a private brief using available context; do not send it.',
        why: 'This exact meeting is coming up.', evidence: ['A current connected calendar observation'], goalId: null, confidence: 0.9,
        meetingPreparation: { candidateId: candidate.candidateId, revision: candidate.revision } }, setAside: [], evidenceDigest } }),
    ask: async record => { asked.push(record); return { checkInId: `controlled-check-in-${asked.length}` }; },
    isAnswered: () => ({ answered: false }), loadState: () => state, saveState: next => { state = next; },
    resolveMeetingPreparation: binding => current ? resolveMeetingPreparation(binding, [current]) : null };
  return { deps, asked, state: () => state, setCurrent: (value: MeetingPreparationCandidate | null) => { current = value; } };
}

test('noticing binds only an observed current occurrence and preserves exact dedup across restart', async () => {
  const candidate = project()[0]!;
  const first = noticingHarness(candidate); assert.equal((await runNoticingTick(first.deps)).produced, 1);
  assert.deepEqual(first.asked[0]!.calendarPreparation, candidate);
  const restarted = noticingHarness(candidate, structuredClone(first.state()));
  assert.equal((await runNoticingTick(restarted.deps)).produced, 0);
  const next = project(stateFor([event({ id: 'controlled-occurrence-2', startMs: NOW + 180 * M, endMs: NOW + 210 * M })]))[0]!;
  const recurring = noticingHarness(next, structuredClone(first.state()));
  assert.equal((await runNoticingTick(recurring.deps)).produced, 1, 'same title is a different exact occurrence');
  const answered = structuredClone(first.state());
  const prior = Object.values(answered.proposals)[0]!;
  prior.status = 'answered'; prior.answer = { decision: 'do_it', text: 'Do it', at: new Date(NOW).toISOString() };
  const revised = project(stateFor([event({ location: 'Controlled revised agenda location' })]))[0]!;
  const changedAgenda = noticingHarness(revised, answered);
  assert.equal((await runNoticingTick(changedAgenda.deps)).produced, 1, 'an earlier accepted revision does not cover changed observed details');
  assert.equal(prior.calendarPreparation?.revision, candidate.revision, 'the historical accepted origin remains unchanged');
});

test('changed, cancelled or unqualified publication cannot ask; generic noticing remains ordinary', async () => {
  const h = noticingHarness(project()[0]!); h.setCurrent(null);
  assert.equal((await runNoticingTick(h.deps)).produced, 0); assert.equal(h.asked.length, 0);
  const missingHost = noticingHarness(project()[0]!); delete missingHost.deps.resolveMeetingPreparation;
  assert.equal((await runNoticingTick(missingHost.deps)).produced, 0);
  const generic = noticingHarness(project()[0]!);
  const propose = generic.deps.propose;
  generic.deps.propose = async input => {
    const reply = await propose(input); if (reply?.answer?.proposal) delete reply.answer.proposal.meetingPreparation; return reply;
  };
  generic.setCurrent(null);
  assert.equal((await runNoticingTick(generic.deps)).produced, 1);
  assert.equal(generic.asked[0]!.calendarPreparation, undefined);
});

test('approved preparation context retains exact calendar evidence without granting tools, accounts or effects', () => {
  const candidate = project()[0]!;
  const rendered = renderNoticingApprovedTask({ version: 1,
    proposal: { id: 'controlled-proposal', checkInId: 'controlled-check-in', title: 'Prepare', action: 'Prepare a private brief', why: 'Upcoming meeting',
      evidence: ['Controlled current calendar observation'], goalId: null, createdAt: new Date(NOW).toISOString(), calendarPreparation: candidate },
    checkIn: { id: 'controlled-check-in', question: 'Prepare?', answer: 'Do it', answeredAt: new Date(NOW).toISOString() },
    decision: { kind: 'do_it' }, constraints: { rules: [], standingAnswers: [] }, goal: null });
  assert.ok(rendered.includes(candidate.revision));
  assert.match(rendered, /does not grant tool\/account access, approve effects/);
  assert.match(rendered, /Evidence is historical/);
});
