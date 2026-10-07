import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-stop-workflow-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'stop-workflow-fixture\n');
const log = await import('./eventlog.js');
const { stopExactHarnessAttempt } = await import('./stop-exact-attempt.js');
const groups = await import('../../execution/workflow-origin-group.js');
const { WORKFLOW_RUNS_DIR } = await import('../../tools/shared.js');
const cancellation = await import('../../execution/workflow-run-cancellation.js');
test.after(() => { log.closeEventLog(); rmSync(TMP_HOME, { recursive: true, force: true }); });
beforeEach(() => {
  cancellation._setWorkflowRunCancellationBeforeLockForTests();
  groups.registerWorkflowRunDrainKick(null);
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
});

let serial = 0;
function parent(sessionId = `stop-workflow-session-${++serial}`) {
  if (!log.getSession(sessionId)) log.createSession({ id: sessionId, kind: 'chat' });
  const attempt = log.beginRunAttempt(sessionId, { runId: `stop-workflow-parent-${++serial}` });
  const source = log.recordRunAttemptUserInput(attempt, {
    turn: ++serial, role: 'user', data: { text: 'Run this controlled local fixture.' },
  }, { armRunInFlight: true });
  const current = log.getRunAttemptBySourceUserSeq(sessionId, source.seq);
  assert.ok(current?.sourceUserSeq);
  return { sessionId, attempt: current, source,
    observer: { sessionId, sourceUserSeq: current.sourceUserSeq,
      replyTarget: { type: 'origin_chat' as const } } };
}
type Parent = ReturnType<typeof parent>;
function file(runId: string) { return path.join(WORKFLOW_RUNS_DIR, `${runId}.json`); }
function read(runId: string) { return JSON.parse(readFileSync(file(runId), 'utf8')); }
function write(runId: string, patch: Record<string, unknown> = {}) {
  writeFileSync(file(runId), JSON.stringify({ id: runId, workflow: `fixture-${runId}`, inputs: {},
    status: 'awaiting_chat_dispatch_seal', createdAt: new Date().toISOString(), ...patch }));
}
function prepared(p: Parent, runId: string, record = true) {
  if (record) write(runId);
  const authority = groups.createWorkflowChatDispatchPreparationAuthority({ runId, observer: p.observer,
    queueRequestDigest: groups.workflowChatDispatchQueueRequestDigest({
      workflowName: `fixture-${runId}`, normalizedInputs: {},
    }) });
  const event = log.appendEvent({ sessionId: p.sessionId, turn: p.source.turn, role: 'system',
    type: 'async_work_dispatch_prepared', data: { ...authority } });
  return groups.recordWorkflowChatDispatchPreparation(groups.createWorkflowChatDispatchPreparedReceipt(authority, {
    eventId: event.id, eventSeq: event.seq, preparedAt: event.createdAt,
  }));
}
function close(receipts: ReturnType<typeof prepared>[]) {
  const authority = groups.createWorkflowOriginGroupCloseAuthority(receipts);
  const event = log.appendEvent({ sessionId: authority.originSessionId, turn: 0, role: 'system',
    type: 'async_work_dispatch_batch_closed', data: { ...authority } });
  return groups.recordWorkflowOriginGroupClosedBatch({
    receipt: groups.createWorkflowOriginGroupClosedBatchReceipt(authority, {
      eventId: event.id, eventSeq: event.seq, closedAt: event.createdAt,
    }), preparedReceipts: receipts,
  });
}
function activate(receipts: ReturnType<typeof prepared>[]) {
  const closed = close(receipts);
  return groups.finalizeWorkflowOriginGroupClosedBatch(closed.receipt.sourceGroupId, { beforeMemberRelease: () => {} });
}
function stop(p: Parent) { return stopExactHarnessAttempt(p.sessionId, p.attempt, 'Stopped controlled fixture.', 'test'); }

test('exact activated queued child stops before execution; another source in the same session survives', () => {
  const old = parent();
  activate([prepared(old, 'foreign')]);
  log.finishRunAttempt(old.attempt, 'completed');
  const p = parent(old.sessionId);
  activate([prepared(p, 'mine')]);
  const foreign = readFileSync(file('foreign'), 'utf8');
  const result = stop(p);
  assert.equal(result.cancelledTasks, 1);
  assert.equal(result.workflowStop?.status, 'complete');
  assert.deepEqual(result.workflowStop?.cancelledRunIds, ['mine']);
  assert.equal(read('mine').status, 'cancelled');
  assert.equal(read('mine').startedAt, undefined);
  assert.equal(read('mine').terminalOutcome, 'cancelled');
  assert.equal(readFileSync(file('foreign'), 'utf8'), foreign);
  assert.equal(log.getRunAttemptBySourceUserSeq(p.sessionId, p.attempt.sourceUserSeq!)?.status, 'active');
  assert.equal(log.listEvents(p.sessionId, { types: ['conversation_completed'] }).length, 0);
  assert.equal(log.isKillRequested(p.sessionId, p.attempt), true);
});

test('prepared held child remains cancelled after later close and activation; open membership stays partial', () => {
  const p = parent();
  const pin = prepared(p, 'prepared-held');
  const result = stop(p);
  assert.equal(result.workflowStop?.status, 'partial');
  assert.deepEqual(result.workflowStop?.failures, [{ code: 'membership_open' }]);
  assert.equal(result.cancelledTasks, 1);
  activate([pin]);
  assert.equal(read('prepared-held').status, 'cancelled');
  assert.equal(read('prepared-held').startedAt, undefined);
  assert.equal(cancellation.workflowRunCancellationRequested('prepared-held'), true);
});

test('closed but unactivated child remains stopped when recovery releases the group', () => {
  const p = parent();
  const pin = prepared(p, 'closed-held');
  const closed = close([pin]);
  const result = stop(p);
  assert.equal(result.workflowStop?.status, 'partial');
  assert.equal(result.workflowStop?.failures[0]?.code, 'membership_open');
  groups.finalizeWorkflowOriginGroupClosedBatch(closed.receipt.sourceGroupId, { beforeMemberRelease: () => {} });
  assert.equal(read('closed-held').status, 'cancelled');
  assert.equal(read('closed-held').startedAt, undefined);
});

test('a shared activated occurrence needs its own explicit run Stop; a private sibling still stops', () => {
  const p = parent();
  activate([prepared(p, 'shared'), prepared(p, 'private')]);
  const other = parent();
  activate([prepared(other, 'shared', false)]);
  const shared = readFileSync(file('shared'), 'utf8');
  const result = stop(p);
  assert.equal(result.cancelledTasks, 1);
  assert.equal(result.workflowStop?.status, 'partial');
  assert.deepEqual(result.workflowStop?.failures, [{ runId: 'shared', code: 'shared_child_requires_exact_run_stop' }]);
  assert.equal(readFileSync(file('shared'), 'utf8'), shared);
  assert.equal(read('private').status, 'cancelled');
  assert.equal(log.isKillRequested(other.sessionId, other.attempt), false);
});

test('a second source preparation also proves sharing before either group activates', () => {
  const p = parent();
  prepared(p, 'pending-shared');
  const other = parent();
  prepared(other, 'pending-shared', false);
  const original = readFileSync(file('pending-shared'), 'utf8');
  const result = stop(p);
  assert.equal(result.cancelledTasks, 0);
  assert.equal(result.workflowStop?.status, 'partial');
  assert.ok(result.workflowStop?.failures.some((failure) => failure.code === 'shared_child_requires_exact_run_stop'));
  assert.equal(readFileSync(file('pending-shared'), 'utf8'), original);
});

test('foreign private observer without a surviving preparation pin prevents exclusive Stop', () => {
  const p = parent();
  activate([prepared(p, 'private-marker')]);
  const other = parent();
  const authority = groups.createWorkflowChatDispatchPreparationAuthority({ runId: 'private-marker', observer: other.observer,
    queueRequestDigest: groups.workflowChatDispatchQueueRequestDigest({ workflowName: 'fixture-private-marker', normalizedInputs: {} }) });
  const dir = path.join(WORKFLOW_RUNS_DIR, '.run-origins', createHash('sha256').update('private-marker').digest('hex'));
  writeFileSync(path.join(dir, `${authority.observerId.slice('workflow-origin-v2:'.length)}.json`), JSON.stringify({
    ...authority, version: 2, sourceGroupDigest: 'a'.repeat(64), recordedAt: new Date().toISOString(),
  }));
  const result = stop(p);
  assert.equal(result.cancelledTasks, 0);
  assert.equal(result.workflowStop?.status, 'partial');
  assert.equal(result.workflowStop?.failures[0]?.code, 'shared_child_requires_exact_run_stop');
  assert.equal(read('private-marker').status, 'queued');
});

test('unknown observer entry closes negative ownership proof without touching the child', () => {
  const p = parent();
  activate([prepared(p, 'unknown-observer')]);
  const dir = path.join(WORKFLOW_RUNS_DIR, '.run-origins', createHash('sha256').update('unknown-observer').digest('hex'));
  writeFileSync(path.join(dir, 'unrecognized-entry'), 'private invalid metadata');
  const result = stop(p);
  assert.equal(result.cancelledTasks, 0);
  assert.equal(result.workflowStop?.status, 'partial');
  assert.deepEqual(result.workflowStop?.failures, [{ runId: 'unknown-observer', code: 'ownership_unavailable' }]);
  assert.equal(read('unknown-observer').status, 'queued');
  assert.equal(JSON.stringify(result).includes('private invalid'), false);
});

test('another source pre-callback admission proves sharing before its observer or preparation pin exists', () => {
  const p = parent();
  activate([prepared(p, 'admission-shared')]);
  const other = parent();
  const authority = groups.createWorkflowChatDispatchPreparationAuthority({ runId: 'admission-shared', observer: other.observer,
    queueRequestDigest: groups.workflowChatDispatchQueueRequestDigest({ workflowName: 'fixture-admission-shared', normalizedInputs: {} }) });
  groups.recordWorkflowChatDispatchAdmission(authority);
  const result = stop(p);
  assert.equal(result.cancelledTasks, 0);
  assert.equal(result.workflowStop?.status, 'partial');
  assert.equal(result.workflowStop?.failures[0]?.code, 'shared_child_requires_exact_run_stop');
  assert.equal(read('admission-shared').status, 'queued');
});

test('unreadable or oversized admission metadata cannot qualify exclusive cancellation', () => {
  for (const oversized of [false, true]) {
    const p = parent(), runId = `unproved-admission-${oversized}`;
    activate([prepared(p, runId)]);
    const other = parent();
    const authority = groups.createWorkflowChatDispatchPreparationAuthority({ runId, observer: other.observer,
      queueRequestDigest: groups.workflowChatDispatchQueueRequestDigest({ workflowName: `fixture-${runId}`, normalizedInputs: {} }) });
    groups.recordWorkflowChatDispatchAdmission(authority);
    const dir = path.join(WORKFLOW_RUNS_DIR, '.origin-groups', createHash('sha256').update(authority.sourceGroupId).digest('hex'), 'admissions');
    writeFileSync(path.join(dir, `${authority.queueRequestDigest}.json`), oversized ? JSON.stringify({ ...authority, extra: 'x'.repeat(65_536) }) : '{');
    const result = stop(p);
    assert.equal(result.cancelledTasks, 0);
    assert.equal(result.workflowStop?.status, 'partial');
    assert.equal(result.workflowStop?.failures[0]?.code, 'ownership_unavailable');
    assert.equal(read(runId).status, 'queued');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settled child bytes and retained effect receipts are unchanged while unfinished sibling stops', () => {
  const p = parent();
  activate([prepared(p, 'settled'), prepared(p, 'unfinished')]);
  write('settled', { ...read('settled'), status: 'completed', finishedAt: new Date().toISOString(),
    output: { retained: 'controlled result' }, effectReceipts: [{ state: 'committed', effectId: 'fixture-effect' }],
    reportBack: { version: 1, workflowName: 'fixture-settled', outcome: 'done', detail: 'Controlled result.', acknowledgedOriginSessionIds: [] } });
  const before = readFileSync(file('settled'), 'utf8');
  const result = stop(p);
  assert.equal(result.cancelledTasks, 1);
  assert.equal(result.workflowStop?.status, 'complete');
  assert.deepEqual(result.workflowStop?.alreadyTerminalRunIds, ['settled']);
  assert.equal(readFileSync(file('settled'), 'utf8'), before);
  const replay = stop(p);
  assert.equal(replay.cancelledTasks, 0);
  assert.deepEqual(replay.workflowStop?.alreadyCancelledRunIds, ['unfinished']);
  assert.equal(readFileSync(file('settled'), 'utf8'), before);
});

test('registered superseded Stop cannot cascade into old or new workflow membership', () => {
  const old = parent();
  activate([prepared(old, 'old-child')]);
  log.finishRunAttempt(old.attempt, 'completed');
  const current = parent(old.sessionId);
  activate([prepared(current, 'new-child')]);
  const result = stop(old);
  assert.deepEqual(result, { cancelledApprovals: 0, cancelledTasks: 0 });
  assert.equal(read('old-child').status, 'queued');
  assert.equal(read('new-child').status, 'queued');
  assert.equal(log.isKillRequested(current.sessionId, current.attempt), false);
});

test('stopping an unresolved mutation retains its uncertainty and original effect receipt', () => {
  const p = parent();
  activate([prepared(p, 'unresolved')]);
  const effectReceipts = [{ state: 'uncertain', effectId: 'fixture-unresolved-effect' }];
  write('unresolved', { ...read('unresolved'), status: 'blocked_mutation',
    mutationBlock: { state: 'blocked', stepId: 'fixture-step', reconciliationRequired: true }, effectReceipts });
  const result = stop(p);
  const retained = read('unresolved');
  assert.equal(result.workflowStop?.status, 'complete');
  assert.equal(retained.status, 'cancelled');
  assert.deepEqual(retained.effectReceipts, effectReceipts);
  assert.equal(retained.mutationBlock.state, 'cancelled_unreconciled');
  assert.equal(retained.mutationBlock.reconciliationRequired, true);
  assert.match(retained.reportBack.detail, /external mutation remains unresolved/);
});

test('corrupt attributable child evidence leaves children inert and exposes only a closed partial failure', () => {
  const p = parent();
  activate([prepared(p, 'corrupt')]);
  writeFileSync(file('corrupt'), '{private-invalid-fixture');
  const result = stop(p);
  assert.equal(result.cancelledTasks, 0);
  assert.equal(result.workflowStop?.status, 'partial');
  assert.deepEqual(result.workflowStop?.failures, [{ runId: 'corrupt', code: 'child_stop_failed' }]);
  assert.equal(readFileSync(file('corrupt'), 'utf8'), '{private-invalid-fixture');
  assert.equal(JSON.stringify(result).includes('private-invalid'), false);
  assert.equal(log.isKillRequested(p.sessionId, p.attempt), true);
});

test('one failed child Stop preserves a successfully stopped sibling and reports partial without a parent terminal', () => {
  const p = parent();
  activate([prepared(p, 'stop-first'), prepared(p, 'stop-second')]);
  let calls = 0;
  cancellation._setWorkflowRunCancellationBeforeLockForTests(() => {
    if (++calls === 2) throw new Error('private failure path must not be exposed');
  });
  const result = stop(p);
  assert.equal(result.cancelledTasks, 1);
  assert.equal(result.workflowStop?.status, 'partial');
  assert.deepEqual(result.workflowStop?.failures, [{ runId: 'stop-second', code: 'child_stop_failed' }]);
  assert.equal(read('stop-first').status, 'cancelled');
  assert.equal(read('stop-second').status, 'queued');
  assert.equal(JSON.stringify(result).includes('private failure'), false);
  assert.equal(log.listEvents(p.sessionId, { types: ['conversation_completed'] }).length, 0);
});

test('a completion winning inside the cancellation seam retains its real result and is not cancelled', () => {
  const p = parent();
  activate([prepared(p, 'completion-race')]);
  let completedBytes = '';
  cancellation._setWorkflowRunCancellationBeforeLockForTests(() => {
    const current = read('completion-race');
    write('completion-race', { ...current, status: 'completed', finishedAt: new Date().toISOString(),
      effectReceipts: [{ state: 'committed', effectId: 'race-effect' }] });
    completedBytes = readFileSync(file('completion-race'), 'utf8');
  });
  const result = stop(p);
  assert.equal(result.cancelledTasks, 0);
  assert.deepEqual(result.workflowStop?.alreadyTerminalRunIds, ['completion-race']);
  assert.equal(readFileSync(file('completion-race'), 'utf8'), completedBytes);
  assert.equal(cancellation.workflowRunCancellationRequested('completion-race'), false);
});
