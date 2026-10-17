import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TurnSemanticModelPort } from '../runtime/semantic-boundary/turn-semantic-model-port.js';
import type { AssistantRequest } from '../types.js';

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
const stateFile = path.join(home, 'state', 'noticing.json');
let sequence = 0;

test.afterEach(() => { runtime.bindNoticingRespond(null); ports.installTurnSemanticModelPort(null); });
test.after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

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
