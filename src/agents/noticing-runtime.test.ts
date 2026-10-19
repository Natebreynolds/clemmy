import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TurnSemanticModelPort } from '../runtime/semantic-boundary/turn-semantic-model-port.js';
import type { AssistantRequest } from '../types.js';
import { calendarPreparationEventsDigest, projectMeetingPreparationCandidates, calendarPreparationConnectionKey } from './meeting-preparation.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-noticing-handoff-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
const runtime = await import('./noticing-runtime.js');
const noticing = await import('./noticing.js');
const checkIns = await import('./check-ins.js');
const log = await import('../runtime/harness/eventlog.js');
const ports = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
const approved = await import('../runtime/harness/noticing-approved-task.js');
const contracts = await import('./heartbeat-contracts.js');
const { upsertGoalRecord } = await import('../memory/goals-list.js');
const accounting = await import('../runtime/usage-log.js');
const { listOperationalEvents } = await import('../runtime/operational-telemetry.js');
const connections = await import('../integrations/composio/client.js');
const manifests = await import('../runtime/harness/capability-manifest-store.js');
const calendarRuntime = await import('./calendar-watch-runtime.js');
const calendarState = await import('./calendar-watch.js');
const calendarRecipes = await import('./calendar-read-recipe.js');
const proactivity = await import('./proactivity-policy.js');
const meetingPolicy = await import('../integrations/recall/meeting-assistant-policy.js');
const stateFile = path.join(home, 'state', 'noticing.json');
let sequence = 0;

test('read-only Noticing snapshots distinguish absent and unreadable stores without repairing authority state', () => {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  rmSync(stateFile, { force: true });
  assert.deepEqual(runtime.readNoticingProposalSnapshot().coverage, { availability: 'complete', omitted: 0 });
  writeFileSync(stateFile, '{');
  assert.deepEqual(runtime.readNoticingProposalSnapshot().coverage, { availability: 'unavailable', omitted: 0 });
  assert.throws(() => runtime.readNoticingStateStrict(), 'the authority reader remains strict');
  assert.equal(readFileSync(stateFile, 'utf8'), '{');
  rmSync(stateFile, { force: true });
});

test.afterEach(() => { runtime.bindNoticingRespond(null); ports.installTurnSemanticModelPort(null); });
test.after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

const jobEvents = (jobId: string) => listOperationalEvents({ type: 'model_accounting_observed', limit: 1_000 })
  .filter(row => row.payload.usageJobId === jobId).map(row => row.payload);

test('a standalone answer invocation retains its exact job on the accepted answer receipt without importing a caller turn', async () => {
  const f = fixture('Not now. Keep the controlled draft unsent.');
  const bindings: NonNullable<ReturnType<typeof accounting.standaloneModelAccountingJobBinding>>[] = [];
  ports.installTurnSemanticModelPort({ readNoticingAnswer: async input => {
    const scope = accounting.modelUsageAttributionStorage.getStore()!;
    assert.equal(scope.sessionId, ''); assert.equal(scope.sourceUserSeq, 0);
    assert.equal(scope.attemptId, undefined); assert.equal(scope.usageParentTurn, undefined);
    bindings.push(accounting.standaloneModelAccountingJobBinding(scope.standaloneAccountingJob!)!);
    return { decision: 'not_now', evidenceDigest: input.evidenceDigest, modelIdentity: 'controlled-answer-reader',
      modelAccountingJobId: 'forged-model-supplied-job' };
  } } as TurnSemanticModelPort);
  await accounting.withModelUsageAttribution({ sessionId: 'foreign-answer-caller', sourceUserSeq: 3101,
    attemptId: 'attempt:foreign-answer' }, () => runtime.settleNoticingAnswers());
  assert.equal(bindings.length, 1);
  const own = bindings[0]!;
  assert.equal(own.operation, 'noticing_answer'); assert.equal(own.operationId, f.checkIn.id);
  assert.equal(own.revisionDigest, createHash('sha256').update(JSON.stringify({ proposalId: f.id,
    checkInId: f.checkIn.id, answer: f.answer, answeredAt: f.checkIn.answeredAt })).digest('hex'));
  assert.equal(f.record().answer?.modelAccountingJobId, own.usageJobId);
  const events = jobEvents(own.usageJobId);
  assert.deepEqual(events.map(row => row.phase).sort(), ['job_finished', 'job_started', 'operation_receipt']);
  const finished = events.find(row => row.phase === 'job_finished')!;
  assert.equal(finished.outcome, 'returned'); assert.equal(finished.usage, 'unknown');
  assert.equal(events.find(row => row.phase === 'operation_receipt')?.receiptDigest,
    createHash('sha256').update(JSON.stringify(f.record().answer)).digest('hex'));
  assert.doesNotMatch(JSON.stringify(events), /foreign-answer-caller|attempt:foreign|Keep the controlled draft|forged-model/);
  for (const row of events) for (const key of ['sourceUserSeq', 'logicalTurnId', 'runAttemptId']) assert.equal(Object.hasOwn(row, key), false);
  assert.equal(runtime.noticingStatus().recentlyRetired.find(row => row.id === f.id)?.answer?.modelAccountingJobId, undefined);
  await runtime.settleNoticingAnswers();
  assert.equal(bindings.length, 1, 'a settled answer does not mint a second accounting invocation');
});

test('failed answer rereads have distinct job UUIDs and unknown local closure without an invented saved answer', async () => {
  const f = fixture('Yes, prepare only the controlled local draft.');
  const ids: string[] = [];
  ports.installTurnSemanticModelPort({ readNoticingAnswer: async () => {
    const scope = accounting.modelUsageAttributionStorage.getStore()!;
    ids.push(accounting.standaloneModelAccountingJobBinding(scope.standaloneAccountingJob!)!.usageJobId);
    throw new Error('private controlled provider diagnostic');
  } } as TurnSemanticModelPort);
  await runtime.settleNoticingAnswers();
  await runtime.settleNoticingAnswers();
  assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
  assert.equal(f.record().answer, undefined);
  for (const id of ids) {
    const events = jobEvents(id);
    assert.deepEqual(events.map(row => row.phase).sort(), ['job_finished', 'job_started']);
    const finished = events.find(row => row.phase === 'job_finished')!;
    assert.equal(finished.outcome, 'failed'); assert.equal(finished.usage, 'unknown');
    assert.equal(finished.operationId, f.checkIn.id);
    assert.doesNotMatch(JSON.stringify(events), /private controlled provider diagnostic|prepare only the controlled/);
  }
});

test('actual Noticing ticks retain host job receipts while quiet reuse and unavailable models mint no current job', async (t) => {
  rmSync(stateFile, { force: true });
  const created = upsertGoalRecord({ title: 'Controlled standalone Noticing goal', description: 'Prepare a controlled local draft only.' });
  assert.ok(created.ok);
  t.after(() => rmSync(path.join(home, 'goals', `${created.goal.id}.json`), { force: true }));
  const inputs: unknown[] = [];
  ports.installTurnSemanticModelPort({ noticing: async input => {
    inputs.push(input);
    return { answer: { proposal: null, setAside: [], evidenceDigest: input.evidenceDigest },
      modelIdentity: 'controlled-tick-reader', modelAccountingJobId: 'forged-model-job' };
  } } as TurnSemanticModelPort);
  const first = await runtime.runNoticingTickNow({ source: 'manual' });
  assert.ok(first.modelAccountingJobId);
  const retained = runtime.readNoticingStateStrict().state.thinking.find(row => row.tickId === first.tickId)!;
  assert.equal(retained.modelAccountingJobId, first.modelAccountingJobId);
  const events = jobEvents(first.modelAccountingJobId);
  assert.deepEqual(events.map(row => row.phase).sort(), ['job_finished', 'job_started', 'operation_receipt']);
  const started = events.find(row => row.phase === 'job_started')!;
  assert.equal(started.operation, 'noticing_proposal'); assert.equal(started.operationId, first.tickId);
  assert.equal(events.find(row => row.phase === 'operation_receipt')?.receiptDigest,
    createHash('sha256').update(JSON.stringify(retained)).digest('hex'));
  assert.equal(runtime.noticingStatus().thinking[0]?.modelAccountingJobId, undefined);
  assert.doesNotMatch(JSON.stringify(inputs), /noticing-job:|forged-model-job/);
  const again = await runtime.runNoticingTickNow({ source: 'manual' });
  assert.ok(again.modelAccountingJobId); assert.notEqual(again.modelAccountingJobId, first.modelAccountingJobId);
  const quiet = await runtime.runNoticingTickNow({ source: 'heartbeat' });
  assert.equal(quiet.modelCheck, 'recent_unchanged'); assert.equal(quiet.modelAccountingJobId, undefined);
  assert.equal(inputs.length, 2);
  ports.installTurnSemanticModelPort(null);
  const beforeNoModel = listOperationalEvents({ type: 'model_accounting_observed', limit: 1_000 }).map(row => row.eventId).sort();
  const noModel = await runtime.runNoticingTickNow({ source: 'manual' });
  assert.equal(noModel.modelAccountingJobId, undefined);
  assert.deepEqual(listOperationalEvents({ type: 'model_accounting_observed', limit: 1_000 }).map(row => row.eventId).sort(), beforeNoModel);
});

function fixture(answer = 'Yes, do it — use the existing account.\nDraft only; do not send.') {
  rmSync(stateFile, { force: true });
  const id = `proposal-${++sequence}`;
  const checkIn = checkIns.createCheckIn({ agentSlug: 'clementine', question: 'May I prepare the fixture report?',
    contextSummary: `noticing:${id}` });
  checkIns.answerCheckIn(checkIn.id, answer);
  const state = noticing.emptyNoticingState();
  state.proposals[id] = { id, shapeKey: id, createdAt: new Date().toISOString(), status: 'open',
    title: 'Prepare the fixture report', action: 'Read the named fixture and prepare a draft report in its existing folder.',
    why: 'The goal is due; an earlier source disagrees, so preserve both accounts.',
    evidence: ['fixture source A', 'contrary source B: amount is not verified'], goalId: null, confidence: 0.9,
    checkInId: checkIn.id };
  runtime.saveNoticingState(state);
  return { id, checkIn: checkIns.getCheckIn(checkIn.id)!, answer,
    record: () => runtime.loadNoticingState().proposals[id]!, state };
}
function installReader(decision: 'do_it' | 'not_now' | 'never' | 'unclear', wait?: Promise<void>) {
  const calls: unknown[] = [];
  ports.installTurnSemanticModelPort({ readNoticingAnswer: async input => {
    calls.push(input); await wait;
    return { decision, evidenceDigest: input.evidenceDigest, modelIdentity: 'fixture-reader',
      ...(decision === 'do_it' ? { instruction: 'Draft only, with the current account.' } : {}) };
  } } as TurnSemanticModelPort);
  return calls;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function bindAttempt(request: AssistantRequest) {
  assert.ok(request.sourceUserSeq);
  const attempt = log.beginRunAttempt(request.sessionId, { runId: request.runId });
  const source = log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: request.message } },
    { existingEventSeq: request.sourceUserSeq });
  return { attempt, source };
}

test('a stale calendar preparation answer cannot accept a task or turn the same answer into replay permission', async () => {
  const f = fixture('Do it. Prepare only a private controlled brief.');
  const now = Date.now();
  const calendarEvent = { id: 'controlled-calendar-occurrence', subject: 'Controlled meeting', startMs: now + 60 * 60_000, endMs: now + 90 * 60_000,
    isAllDay: false, isCancelled: false, showAs: 'busy', myResponse: 'accepted', attendeeCount: 2 };
  const fingerprint = createHash('sha256').update('controlled-calendar').digest('hex');
  const snapshot = { [calendarEvent.id]: calendarEvent };
  const candidates = projectMeetingPreparationCandidates({ enabled: true, now,
    connected: new Set([calendarPreparationConnectionKey('controlled_calendar_read', 'controlled-calendar-account', fingerprint)]),
    state: { snapshot: { 'controlled-calendar-account': snapshot }, snapshotEvidence: { 'controlled-calendar-account': {
      version: 1, operationId: 'controlled_calendar_read', accountId: 'controlled-calendar-account', tickId: 'controlled-tick',
      observedAt: new Date(now).toISOString(), windowStartMs: now, windowEndMs: now + 24 * 60 * 60_000,
      activationId: 'controlled-activation', authorityRootId: 'controlled-root', invocationPlanDigest: fingerprint, bindingSnapshotDigest: fingerprint,
      definitionFingerprint: fingerprint, resultRef: 'controlled-result', resultKind: 'single_read', eventsDigest: calendarPreparationEventsDigest(snapshot),
    } } } });
  const candidate = candidates[0]!; assert.ok(candidate);
  const state = runtime.loadNoticingState();
  state.proposals[f.id]!.meetingPreparation = { candidateId: candidate.candidateId, revision: candidate.revision };
  state.proposals[f.id]!.calendarPreparation = candidate;
  runtime.saveNoticingState(state);
  const calls = installReader('do_it');
  const requests: AssistantRequest[] = [];
  runtime.bindNoticingRespond(async request => { requests.push(request); });
  await runtime.settleNoticingAnswers();
  await runtime.settleNoticingAnswers();
  assert.equal(requests.length, 0); assert.equal(calls.length, 1);
  const retained = f.record();
  assert.equal(retained.handoff?.state, 'needs_attention'); assert.equal(retained.handoff?.sourceUserSeq, undefined);
  assert.equal(retained.answer?.text, f.answer);
  assert.equal(log.getHarnessChatRequestReceipt(`noticing-answer:${retained.handoff?.answerDigest}`), null);
  assert.equal(runtime.meetingPreparationReadiness().state, 'suggestions_off');
});

/** Cache ingress fixture only: no catalog authorization, provider dispatch or
 * real calendar read is claimed by these synthetic retained observations. */
function preparationFixture(t: { after: (fn: () => void) => void }, leadMinutes: number) {
  const files = ['state/proactivity-policy.json', 'state/meeting-capture/assistant-policy.json',
    'state/calendar-read-recipes.json', 'state/calendar-watch.json'].map(name => path.join(home, name));
  const before = files.map(file => existsSync(file) ? readFileSync(file) : null);
  const previousStore = manifests.peekCapabilityManifestStore();
  const previousConnections = connections.peekCurrentConnectedToolkits();
  t.after(() => {
    files.forEach((file, index) => {
      if (before[index]) writeFileSync(file, before[index]!); else rmSync(file, { force: true });
    });
    manifests.installCapabilityManifestStore(previousStore);
    connections._setConnectedToolkitsSnapshotForTests(previousConnections);
  });
  proactivity.saveProactivityPolicy({ noticingEnabled: true, calendarWatchEnabled: true, quietHoursEnabled: false });
  const policy = meetingPolicy.loadMeetingAssistantPolicy();
  meetingPolicy.saveMeetingAssistantPolicy({ expectedRevision: policy.revision, before: { calendarPrepSuggestions: true },
    during: { modelId: null }, after: { modelId: null } });
  const now = Date.now(), offeredAt = now - 6 * 60_000;
  const operationId = 'controlled_calendar_list', accountId = 'controlled-calendar-account';
  const fingerprint = createHash('sha256').update('controlled-calendar-cache').digest('hex');
  const event = { id: 'controlled-cached-occurrence', subject: 'Controlled meeting', startMs: now + leadMinutes * 60_000,
    endMs: now + (leadMinutes + 30) * 60_000, isAllDay: false, isCancelled: false, showAs: 'busy', myResponse: 'accepted', attendeeCount: 2 };
  const snapshot = { [event.id]: event };
  const state = { ...calendarState.emptyCalendarWatchState(), snapshot: { [accountId]: snapshot }, snapshotEvidence: { [accountId]: {
    version: 1 as const, operationId, accountId, tickId: 'controlled-calendar-cache-tick', observedAt: new Date(offeredAt).toISOString(),
    windowStartMs: offeredAt, windowEndMs: now + 24 * 60 * 60_000, activationId: 'controlled-activation', authorityRootId: 'controlled-root',
    invocationPlanDigest: fingerprint, bindingSnapshotDigest: fingerprint, definitionFingerprint: fingerprint,
    resultRef: 'controlled-result', resultKind: 'single_read' as const, eventsDigest: calendarPreparationEventsDigest(snapshot),
  } } };
  calendarRuntime.saveCalendarWatchState(state);
  calendarRecipes.rememberCalendarRead({ recipe: { version: 1, operationId,
    window: { start: 'from', end: 'to', limit: null, timezone: null, fixed: null },
    fields: { id: 'id', title: 'title', start: 'start', end: 'end', allDay: null, cancelled: null, showAs: null,
      myResponse: null, myResponseFromAttendee: null, attendees: null, organizer: null, location: null } },
    toolkit: 'controlledcalendar', definitionFingerprint: fingerprint, basis: { learnedAt: new Date(offeredAt).toISOString(), modelIdentity: 'controlled-cache' } });
  const store = manifests.createCapabilityManifestStore();
  store.list = () => [{ digest: fingerprint, manifest: { manifestId: 'controlled-calendar-manifest', operationId, accountId,
    definitionFingerprint: fingerprint, providerKind: 'composio', providerVersion: 'fixture', operationVersion: 'fixture', lifecycle: { state: 'current' } } }] as unknown as ReturnType<typeof store.list>;
  manifests.installCapabilityManifestStore(store);
  connections._setConnectedToolkitsSnapshotForTests([{ slug: 'controlledcalendar', connectionId: accountId, status: 'ACTIVE' }]);
  const candidate = projectMeetingPreparationCandidates({ state, enabled: true, now: offeredAt,
    connected: new Set([calendarPreparationConnectionKey(operationId, accountId, fingerprint)]) })[0]!;
  assert.ok(candidate);
  return { candidate, now: Date.now(), state, policyFile: files[0]! };
}
test('an unchanged offer made fifteen minutes before start is accepted nine minutes before start through the ordinary task path', async t => {
  const { candidate, now } = preparationFixture(t, 9);
  assert.equal(calendarRuntime.cachedMeetingPreparationCandidates(true, now).length, 0, 'no new offer below ten minutes');
  assert.equal(calendarRuntime.cachedMeetingPreparationCandidates(true, now, 'answer')[0]?.candidateId, candidate.candidateId);
  const f = fixture('Do it. Prepare only a private controlled brief.');
  const state = runtime.loadNoticingState();
  Object.assign(state.proposals[f.id]!, { meetingPreparation: { candidateId: candidate.candidateId, revision: candidate.revision }, calendarPreparation: candidate });
  runtime.saveNoticingState(state);
  const calls = installReader('do_it');
  const requests: AssistantRequest[] = [];
  runtime.bindNoticingRespond(async request => { requests.push(request); bindAttempt(request); });
  await runtime.settleNoticingAnswers();
  assert.equal(calls.length, 1); assert.equal(requests.length, 1);
  const request = requests[0]!;
  const accepted = approved.readAcceptedNoticingTask({ sessionId: request.sessionId, sourceUserSeq: request.sourceUserSeq! });
  assert.equal(accepted?.packet.proposal.calendarPreparation?.candidateId, candidate.candidateId);
  assert.equal(f.record().handoff?.state, 'dispatched');
  await runtime.settleNoticingAnswers();
  assert.equal(requests.length, 1, 'the same owner answer never starts a second task');
});

test('an opted-in profile with damaged proactivity gates cannot offer, wake or accept preparation work', async t => {
  const { candidate, policyFile } = preparationFixture(t, 60);
  assert.equal(runtime.meetingPreparationReadiness().state, 'ready');
  writeFileSync(policyFile, '{');
  assert.equal(runtime.meetingPreparationReadiness().state, 'unavailable');
  assert.throws(() => calendarRuntime.cachedMeetingPreparationCandidates(true), /policy is unavailable/);
  assert.equal((await runtime.observeForNoticing()).upcomingMeetings, undefined);
  const before = runtime.loadNoticingState().meetingPreparationWake;
  await assert.rejects(runtime.requestMeetingPreparationNoticingWake(), /policy is unavailable/);
  assert.deepEqual(runtime.loadNoticingState().meetingPreparationWake, before);
  const f = fixture('Do it. Prepare only a private controlled brief.');
  const state = runtime.loadNoticingState();
  Object.assign(state.proposals[f.id]!, { meetingPreparation: { candidateId: candidate.candidateId, revision: candidate.revision }, calendarPreparation: candidate });
  runtime.saveNoticingState(state);
  const calls = installReader('do_it');
  const requests: AssistantRequest[] = [];
  runtime.bindNoticingRespond(async request => { requests.push(request); });
  await runtime.settleNoticingAnswers(); await runtime.settleNoticingAnswers();
  assert.equal(calls.length, 1); assert.equal(requests.length, 0);
  assert.equal(f.record().handoff?.state, 'needs_attention');
  assert.equal(f.record().handoff?.sourceUserSeq, undefined);
  assert.equal(log.getHarnessChatRequestReceipt(`noticing-answer:${f.record().handoff?.answerDigest}`), null);
  assert.equal(readFileSync(policyFile, 'utf8'), '{', 'the strict path never rewrites owner settings');
});

test('approved noticing overlap owns one literal accepted source and the complete proposal context', async () => {
  const f = fixture();
  const goal = upsertGoalRecord({ title: 'Controlled report goal', description: 'Keep conflicting amounts unverified.', nextActions: ['Draft only'] });
  assert.equal(goal.ok, true);
  if (!goal.ok) return;
  runtime.saveNoticingState({ ...runtime.loadNoticingState(), proposals: {
    [f.id]: { ...f.record(), goalId: goal.goal.id },
  }, standingAnswers: [{ text: 'Never send fixture reports automatically.', about: 'fixture reports', at: new Date().toISOString() }] });
  contracts.addHeartbeatRule('noticing', 'Use existing resources; never create a new account.', 'owner');
  const read = deferred();
  const calls = installReader('do_it', read.promise);
  const requests: AssistantRequest[] = [];
  runtime.bindNoticingRespond(async request => { requests.push(request); bindAttempt(request); });
  const first = runtime.settleNoticingAnswers();
  const second = runtime.settleNoticingAnswers();
  assert.equal(first, second, 'all entry points share the in-progress answer settlement');
  read.resolve();
  await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.message, f.answer);
  assert.equal(request.userId, undefined, 'no owner identity is fabricated');
  assert.equal(log.listEvents(request.sessionId, { types: ['user_input_received'] }).length, 1);
  const retained = approved.readAcceptedNoticingTask({ sessionId: request.sessionId, sourceUserSeq: request.sourceUserSeq! });
  assert.ok(retained);
  assert.equal(retained.packet.checkIn.answer, f.answer);
  assert.match(retained.objective, /prepare a draft report/);
  assert.match(retained.objective, /do not send/);
  assert.match(retained.context, /contrary source B/);
  assert.match(retained.context, /Never send fixture reports automatically/);
  assert.match(retained.context, /never create a new account/);
  assert.equal(retained.packet.goal?.id, goal.goal.id);
  assert.equal(f.record().handoff?.state, 'dispatched');
  await runtime.settleNoticingAnswers();
  assert.equal(requests.length, 1);
  assert.equal(calls.length, 1);
});

test('approved noticing no runner fails before acceptance and later starts once without rereading the answer', async () => {
  const f = fixture();
  const calls = installReader('do_it');
  await runtime.settleNoticingAnswers();
  assert.equal(f.record().handoff?.state, 'not_started');
  assert.equal(f.record().handoff?.sessionId, undefined);
  const requests: AssistantRequest[] = [];
  runtime.bindNoticingRespond(async request => { requests.push(request); bindAttempt(request); });
  await runtime.settleNoticingAnswers();
  await runtime.settleNoticingAnswers();
  assert.equal(calls.length, 1);
  assert.equal(requests.length, 1);
});

test('approved noticing a stopped uncertain callback stays in its existing chat across reopen and lost projection', async () => {
  const f = fixture();
  const calls = installReader('do_it');
  let crossings = 0;
  let request!: AssistantRequest;
  runtime.bindNoticingRespond(async input => {
    request = input;
    const { attempt, source } = bindAttempt(input);
    crossings++;
    log.appendEvent({ sessionId: input.sessionId, turn: 1, role: 'system', type: 'external_write',
      data: { sourceUserSeq: source.seq, preDispatch: true, outcome: 'uncertain', toolName: 'fixture-only' } });
    log.requestKill(input.sessionId, 'fixture Stop', { attemptId: attempt.attemptId });
    log.finishRunAttempt(attempt, 'cancelled');
    throw new Error('fixture transport ended after acceptance');
  });
  await runtime.settleNoticingAnswers();
  assert.equal(f.record().handoff?.state, 'needs_attention');
  const sourceCount = () => log.listEvents(request.sessionId, { types: ['user_input_received'] }).length;
  assert.equal(sourceCount(), 1);
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  delete saved.proposals[f.id].handoff;
  writeFileSync(stateFile, JSON.stringify(saved));
  log.closeEventLog();
  await runtime.settleNoticingAnswers();
  await runtime.settleNoticingAnswers();
  assert.equal(crossings, 1, 'journal replay is not another automatic dispatch');
  assert.equal(calls.length, 1);
  assert.equal(sourceCount(), 1);
  assert.equal(f.record().handoff?.sessionId, request.sessionId);
  assert.equal(f.record().handoff?.sourceUserSeq, request.sourceUserSeq);
  assert.equal(f.record().handoff?.state, 'needs_attention');
  assert.match(f.record().handoff?.reason ?? '', /stopped/);
});

test('approved noticing unknown accepted start without an attempt is held instead of redispatched', async () => {
  const f = fixture();
  installReader('do_it');
  let starts = 0;
  runtime.bindNoticingRespond(async () => { starts++; throw new Error('fixture pre-attempt crash'); });
  await runtime.settleNoticingAnswers();
  const first = f.record().handoff!;
  log.closeEventLog();
  await runtime.settleNoticingAnswers();
  assert.equal(starts, 1);
  assert.equal(f.record().handoff?.sessionId, first.sessionId);
  assert.equal(f.record().handoff?.sourceUserSeq, first.sourceUserSeq);
  assert.equal(f.record().handoff?.state, 'needs_attention');
  assert.match(f.record().handoff?.reason ?? '', /not confirmed/);
});

test('approved noticing unclear is read once and open/failed answers never start work', async () => {
  const f = fixture('Perhaps, I am not sure which report I mean.');
  const calls = installReader('unclear');
  let starts = 0;
  runtime.bindNoticingRespond(async () => { starts++; });
  await runtime.settleNoticingAnswers();
  await runtime.settleNoticingAnswers();
  assert.equal(calls.length, 1);
  assert.equal(starts, 0);
  assert.equal(f.record().handoff?.state, 'needs_attention');
  assert.equal(runtime.noticingStatus().openItems[0]?.id, f.id);
  assert.match(f.record().handoff?.reason ?? '', /no work was started/);
  const open = fixture();
  const persisted = JSON.parse(readFileSync(path.join(home, 'check-ins', `${open.checkIn.id}.json`), 'utf8'));
  persisted.status = 'open'; delete persisted.answer; delete persisted.answeredAt;
  writeFileSync(path.join(home, 'check-ins', `${open.checkIn.id}.json`), JSON.stringify(persisted));
  await runtime.settleNoticingAnswers();
  assert.equal(calls.length, 1);
  assert.equal(starts, 0);
});

test('approved noticing unavailable or wrong-digest reading is not an unclear consent and remains retryable', async () => {
  const f = fixture();
  await runtime.settleNoticingAnswers();
  assert.equal(f.record().answer, undefined);
  assert.equal(f.record().handoff?.state, 'not_started');
  ports.installTurnSemanticModelPort({ readNoticingAnswer: async () => ({ decision: 'do_it', evidenceDigest: 'foreign', modelIdentity: 'fixture' }) } as TurnSemanticModelPort);
  let starts = 0;
  runtime.bindNoticingRespond(async request => { starts++; bindAttempt(request); });
  await runtime.settleNoticingAnswers();
  assert.equal(starts, 0);
  assert.equal(f.record().answer, undefined);
  installReader('do_it');
  await runtime.settleNoticingAnswers();
  assert.equal(starts, 1);
});

test('approved noticing not-now and never stay settled without another model read', async () => {
  for (const decision of ['not_now', 'never'] as const) {
    const f = fixture(decision);
    const calls = installReader(decision);
    await runtime.settleNoticingAnswers();
    await runtime.settleNoticingAnswers();
    assert.equal(calls.length, 1);
    assert.equal(f.record().handoff?.state, 'settled');
    assert.equal(f.record().handoff?.sessionId, undefined);
  }
});

test('approved noticing proposal drift while reading prevents acceptance and a stale tick cannot erase a handoff', async () => {
  const f = fixture();
  const read = deferred();
  installReader('do_it', read.promise);
  let starts = 0;
  runtime.bindNoticingRespond(async request => { starts++; bindAttempt(request); });
  const pending = runtime.settleNoticingAnswers();
  const changed = runtime.loadNoticingState();
  changed.proposals[f.id]!.action = 'A different task is not the proposal answered.';
  runtime.saveNoticingState(changed);
  read.resolve(); await pending;
  assert.equal(starts, 0);
  assert.equal(f.record().answer, undefined);

  const second = fixture();
  const staleTick = structuredClone(runtime.loadNoticingState());
  installReader('do_it');
  await runtime.settleNoticingAnswers();
  const handoff = structuredClone(second.record().handoff);
  runtime.saveNoticingState(staleTick);
  assert.deepEqual(second.record().handoff, handoff);
  assert.equal(second.record().answer?.text, second.answer);
  assert.equal(runtime.loadNoticingState().metrics.doIt, 1);
});

test('approved noticing an old answered approval without a journal is not assumed unstarted', async () => {
  const f = fixture('do it');
  const state = runtime.loadNoticingState();
  noticing.recordNoticingAnswer(state, { proposalId: f.id, text: f.answer, decision: 'do_it', at: f.checkIn.answeredAt! });
  runtime.saveNoticingState(state);
  const calls = installReader('do_it');
  let starts = 0;
  runtime.bindNoticingRespond(async () => { starts++; });
  await runtime.settleNoticingAnswers(); await runtime.settleNoticingAnswers();
  assert.equal(calls.length, 0);
  assert.equal(starts, 0);
  assert.equal(f.record().handoff?.state, 'needs_attention');
  assert.match(f.record().handoff?.reason ?? '', /earlier approval/);
});

test('approved noticing a stale tick preserves a newly opened unanswered proposal and invalidates reuse', () => {
  const f = fixture();
  const stale = structuredClone(runtime.loadNoticingState());
  const latest = runtime.loadNoticingState();
  latest.proposals['new-open-question'] = { ...f.record(), id: 'new-open-question', shapeKey: 'new-open-question',
    checkInId: 'chk-new-open-question', status: 'open' };
  runtime.saveNoticingState(latest);
  stale.decisionReuse = { version: 1, fingerprint: 'old-generation', decidedAt: new Date().toISOString() };
  runtime.saveNoticingState(stale);
  assert.equal(runtime.loadNoticingState().proposals['new-open-question']?.status, 'open');
  assert.equal(runtime.loadNoticingState().decisionReuse, undefined);
});

test('approved noticing corrupt current state or rules cannot publish from an empty generation or overwrite newer bytes', async () => {
  for (const which of ['state', 'rules'] as const) {
    rmSync(stateFile, { force: true });
    runtime.saveNoticingState(noticing.emptyNoticingState());
    upsertGoalRecord({ title: `Controlled noticing generation ${which}`, description: 'Read-only fixture goal.' });
    const rulesFile = path.join(home, 'state', 'heartbeats.json');
    writeFileSync(rulesFile, JSON.stringify({ version: 1, contracts: {} }));
    const target = which === 'state' ? stateFile : rulesFile;
    let modelReads = 0;
    const questionsBefore = checkIns.listCheckIns({ status: 'all' }).length;
    ports.installTurnSemanticModelPort({ noticing: async input => {
      modelReads++;
      writeFileSync(target, '{incomplete fixture bytes');
      return { modelIdentity: 'fixture-noticer', answer: { proposal: {
        title: `Read controlled goal ${which}`, action: 'Read the named fixture only.',
        why: 'The local fixture goal is active.', evidence: ['controlled fixture goal'], goalId: null, confidence: 0.99,
      }, setAside: [], evidenceDigest: input.evidenceDigest } };
    } } as TurnSemanticModelPort);
    if (which === 'state') await assert.rejects(runtime.runNoticingTickNow({ source: 'manual' }));
    else {
      const result = await runtime.runNoticingTickNow({ source: 'manual' });
      assert.equal(result.produced, 0);
    }
    assert.equal(modelReads, 1);
    assert.equal(readFileSync(target, 'utf8'), '{incomplete fixture bytes', 'failed read cannot be overwritten as empty');
    assert.equal(checkIns.listCheckIns({ status: 'all' }).length, questionsBefore);
    assert.equal(runtime.loadNoticingState().decisionReuse, undefined);
    rmSync(stateFile, { force: true });
    writeFileSync(rulesFile, JSON.stringify({ version: 1, contracts: {} }));
  }
});
