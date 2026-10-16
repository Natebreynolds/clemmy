/**
 * Settled background results are deliveries, not foreground work. Exercise the
 * actual publication path while a human owns the chat; no models or tools run.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-background-delivery-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_CHAT_RESTART_RECOVERY = 'on';
process.env.CLEMMY_PROACTIVE_REPORT_DEFER = 'on';

const log = await import('./harness/eventlog.js');
const { HarnessSession } = await import('./harness/session.js');
const { readSourceApprovalCheckpoint } = await import('./harness/source-approval-checkpoints.js');
const { actionBus } = await import('./action-bus.js');
const { deliverOutcomeWithAcknowledgement, processDeferredProactiveReports } = await import('./outcome.js');
type Outcome = import('./outcome.js').Outcome;
type DeliverContext = import('./outcome.js').DeliverContext;

after(() => {
  log.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});

const events = (id: string) => log.listEvents(id);
const reports = (id: string) => events(id).filter(event => event.data.deliveryPhase === 'report');
const terminals = (id: string) => log.listEvents(id, { types: ['conversation_completed'] });
const passive = (id: string) => events(id).filter(event => event.data.deliveryPhase === 'passive');
const queued = (id: string): Array<{ source_event_id: string; session_id: string; created_at: string; attempts: number }> =>
  log.openEventLog().prepare('SELECT source_event_id, session_id, created_at, attempts FROM outcome_reports_pending_v1 WHERE session_id = ?').all(id) as
    Array<{ source_event_id: string; session_id: string; created_at: string; attempts: number }>;
const context = (id: string, sourceId: string): DeliverContext => ({
  originSessionId: id, sourceLabel: 'background task', sourceId, proactiveTurn: true,
});

function foreground(id: string) {
  log.createSession({ id, kind: 'chat', channel: 'desktop' });
  const attempt = log.beginRunAttempt(id, { attemptId: `attempt:${id}`, runId: `run:${id}` });
  const source = log.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text: 'Keep working on this foreground fixture.' },
  }, { armRunInFlight: true });
  return { id, attempt, source };
}

function assertNoWork(id: string) {
  assert.equal(events(id).some(event => event.type === 'tool_called'
    || event.type === 'model_request_started' || event.type === 'run_started'), false,
  'relaying a settled result starts no model, tool or execution turn');
}

test('a fresh active chat receives one settled result immediately without taking foreground ownership', () => {
  const task = foreground('background-active-chat');
  const before = log.getSession(task.id)!;
  const owner = before.metadata.__run_in_flight_owner;
  const publicEvents: unknown[] = [];
  const detach = actionBus.subscribe(event => {
    if (event.kind === 'harness.public_event' && event.sessionId === task.id
      && event.event.type === 'conversation_completed') publicEvents.push(event);
  });
  try {
    const outcome: Outcome = { status: 'done', detail: 'The separate fixture report is ready.' };
    const ctx = context(task.id, 'active-result');
    assert.equal(deliverOutcomeWithAcknowledgement(outcome, ctx).acknowledged, true);
    assert.equal(terminals(task.id).length, 1, 'delivery is visible before returning, not after sixty seconds');
    assert.equal(publicEvents.length, 1);
    assert.equal(terminals(task.id)[0]!.data.reply, outcome.detail);
    assert.equal(reports(task.id).length, 1);
    assert.equal(terminals(task.id)[0]!.data.sourceUserSeq, reports(task.id)[0]!.seq);
    assert.notEqual(reports(task.id)[0]!.seq, task.source.seq);
    assert.equal(log.getRunAttemptBySourceUserSeq(task.id, task.source.seq)?.status, 'active');
    assert.equal(log.getSession(task.id)!.status, before.status);
    assert.deepEqual(log.getSession(task.id)!.metadata.__run_in_flight_owner, owner);
    assert.equal(queued(task.id).length, 0);
    assert.equal(deliverOutcomeWithAcknowledgement(outcome, ctx).written, false);
    assert.equal(terminals(task.id).length, 1);
    assert.equal(publicEvents.length, 1);
    assertNoWork(task.id);
  } finally { detach(); }
});

test('foreground source can re-arm after background delivery without replacing its accepted identity', () => {
  const task = foreground('background-foreground-rearm');
  deliverOutcomeWithAcknowledgement({ status: 'done', detail: 'Independent fixture finished.' }, context(task.id, 'rearm-result'));
  const row = log.getSession(task.id)!;
  const { __run_in_flight: _running, __run_in_flight_owner: _owner, ...rest } = row.metadata;
  // A recovered executor must be able to establish its existing source owner
  // even though passive/report synthetic inputs have larger event sequences.
  log.updateSession(task.id, { metadata: rest });
  const reused = log.recordRunAttemptUserInput(task.attempt, {
    turn: task.source.turn, role: 'user', data: { text: task.source.data.text },
  }, { existingEventSeq: task.source.seq, armRunInFlight: true });
  assert.equal(reused.seq, task.source.seq);
  const owner = log.getSession(task.id)!.metadata.__run_in_flight_owner as Record<string, unknown> | undefined;
  assert.equal(owner?.sourceUserSeq, task.source.seq);
  assert.equal(owner?.attemptId, task.attempt.attemptId);
  assert.equal(log.getRunAttemptBySourceUserSeq(task.id, task.source.seq)?.status, 'active');
  assert.equal(terminals(task.id).length, 1);
  assertNoWork(task.id);
});

test('a delivered background question preserves a foreground approval checkpoint and exact Stop latch', () => {
  const task = foreground('background-approval-stop');
  const serialized = JSON.stringify({
    __clemHostInterrupt: 1,
    acceptedModelBatchRef: { sessionId: task.id, sourceUserSeq: task.source.seq },
    pending: [{ approvalId: 'approval:foreground-only', consentSubject: { sessionId: task.id, sourceUserSeq: task.source.seq } }],
  });
  HarnessSession.load(task.id)!.saveInterruptState(serialized);
  const approval = readSourceApprovalCheckpoint({ sessionId: task.id, sourceUserSeq: task.source.seq });
  log.requestKill(task.id, 'Stop only the foreground fixture.', task.attempt);
  const kill = log.getKillRequest(task.id, task.attempt);
  const owner = log.getSession(task.id)!.metadata.__run_in_flight_owner;
  const outcome: Outcome = { status: 'needs_input', detail: 'Which folder should the separate result use?', resumable: true };
  assert.equal(deliverOutcomeWithAcknowledgement(outcome, context(task.id, 'question-result')).acknowledged, true,
    JSON.stringify(terminals(task.id).map(event => event.data)));
  assert.equal(terminals(task.id).length, 1);
  assert.equal((terminals(task.id)[0]!.data.presentation as Record<string, unknown>).kind, 'question');
  assert.deepEqual(readSourceApprovalCheckpoint({ sessionId: task.id, sourceUserSeq: task.source.seq }), approval);
  assert.deepEqual(log.getKillRequest(task.id, task.attempt), kill);
  assert.deepEqual(log.getSession(task.id)!.metadata.__run_in_flight_owner, owner);
  assert.equal(log.getRunAttemptBySourceUserSeq(task.id, task.source.seq)?.status, 'active');
  const reloaded = HarnessSession.load(task.id)!;
  assert.equal(reloaded.loadInterruptState(), serialized);
  assert.equal(JSON.parse(readSourceApprovalCheckpoint({ sessionId: task.id, sourceUserSeq: task.source.seq }).checkpoint!.serialized)
    .pending[0].approvalId, 'approval:foreground-only');
  assertNoWork(task.id);
});

test('failed terminal publication retries the accepted stop report after reload without idle or age gates', async () => {
  const task = foreground('background-fault-retry');
  const ctx = { ...context(task.id, 'fault-result'), stopId: 'fixture-stop-one' };
  const accepted: Outcome = { status: 'blocked', detail: 'The fixture needs one connection.', resumable: true };
  const db = log.openEventLog();
  db.exec(`CREATE TRIGGER background_delivery_terminal_failure BEFORE INSERT ON events
    WHEN NEW.type = 'conversation_completed' AND NEW.session_id = 'background-fault-retry'
    BEGIN SELECT RAISE(ABORT, 'fixture background terminal failure'); END;`);
  try {
    assert.equal(deliverOutcomeWithAcknowledgement(accepted, ctx).acknowledged, false,
      'a passive write cannot acknowledge failed public delivery');
    assert.equal(passive(task.id).length, 1);
    assert.equal(reports(task.id).length, 1, 'the accepted public source survives the failed terminal');
    assert.equal(terminals(task.id).length, 0);
    assert.equal(queued(task.id).length, 1);
    assert.equal(queued(task.id)[0]!.source_event_id, passive(task.id)[0]!.id,
      'pending delivery is keyed by its immutable accepted passive event');
  } finally { db.exec('DROP TRIGGER background_delivery_terminal_failure'); }
  const reportSource = reports(task.id)[0]!.seq;
  db.prepare('UPDATE outcome_reports_pending_v1 SET created_at = ? WHERE session_id = ?')
    .run('2000-01-01T00:00:00.000Z', task.id);
  HarnessSession.load(task.id);
  // Fresh activity and a very old retry are not reasons to lose a settled result.
  log.appendEvent({ sessionId: task.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'A newer human fixture message.' } });
  await processDeferredProactiveReports();
  assert.equal(terminals(task.id).length, 1);
  assert.equal(terminals(task.id)[0]!.data.sourceUserSeq, reportSource);
  assert.equal(terminals(task.id)[0]!.data.reply, accepted.detail);
  assert.equal(queued(task.id).length, 0);
  assert.equal(deliverOutcomeWithAcknowledgement({ ...accepted, detail: 'Reworded retry must not replace accepted text.' }, ctx).acknowledged, true);
  assert.equal(terminals(task.id).length, 1);
  assert.equal(reports(task.id).length, 1);
  assert.equal(terminals(task.id)[0]!.data.reply, accepted.detail);
  assertNoWork(task.id);
});

test('durable delivery identity retains the first public report and rejects a conflicting destination or payload', () => {
  const task = foreground('background-delivery-id');
  const ctx = { ...context(task.id, 'durable-result'), deliveryId: 'fixture-background-delivery-one' };
  const accepted: Outcome = { status: 'done', detail: 'Accepted durable fixture result.' };
  assert.equal(deliverOutcomeWithAcknowledgement(accepted, ctx).acknowledged, true);
  assert.equal(terminals(task.id).length, 1);
  const source = reports(task.id)[0]!.seq;
  HarnessSession.load(task.id);
  assert.equal(deliverOutcomeWithAcknowledgement(accepted, ctx).acknowledged, true);
  assert.equal(reports(task.id)[0]!.seq, source);
  assert.equal(terminals(task.id)[0]!.data.reply, accepted.detail);
  assert.equal(deliverOutcomeWithAcknowledgement({ ...accepted, detail: 'Conflicting durable fixture text.' }, ctx).acknowledged, false);
  const other = foreground('background-delivery-other-chat');
  assert.equal(deliverOutcomeWithAcknowledgement(accepted, { ...ctx, originSessionId: other.id }).acknowledged, false);
  assert.equal(terminals(task.id).length, 1);
  assert.equal(terminals(other.id).length, 0);
  assertNoWork(task.id);
  assertNoWork(other.id);
});
