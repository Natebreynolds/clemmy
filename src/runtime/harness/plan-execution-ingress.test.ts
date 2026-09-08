import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-plan-ingress-'));
process.env.CLEMENTINE_HOME = fixtureHome;
const log = await import('./eventlog.js');
const plans = await import('./plan-artifacts.js');
const ingress = await import('./plan-execution-ingress.js');
test.beforeEach(() => log.resetEventLog());
test.after(() => { log.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

function fixture() {
  const scope = { sessionId: 'reviewed-chat', principalId: 'desktop' };
  log.createSession({ id: scope.sessionId, kind: 'chat', userId: scope.principalId });
  const source = log.appendEvent({ sessionId: scope.sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Plan a native Space.', taskMode: { version: 1, kind: 'plan' } } });
  const artifact = plans.publishPlanRevision({ ...scope, sourceUserSeq: source.seq, fullText: 'Create the reviewed static Space.', readiness: 'ready' });
  const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  const request = { ...scope, ref, requestId: 'tap-one', inputHash: 'exact-mode-and-input' };
  let created = 0;
  const create = () => {
    created++;
    return log.claimHarnessChatRequest({ requestId: request.requestId, sessionId: scope.sessionId,
      runId: 'one-execute-run', inputHash: request.inputHash, sinceSeq: source.seq });
  };
  return { scope, source, artifact, request, create, created: () => created };
}

test('different Execute tap keys reserve one run before any source exists; reopen preserves it', () => {
  const f = fixture();
  const first = ingress.claimPlanExecutionIngress(f.request, f.create);
  const second = ingress.claimPlanExecutionIngress({ ...f.request, requestId: 'tap-two' }, f.create);
  assert.equal(first.joined, false);
  assert.equal(second.joined, true);
  assert.equal(second.receipt.runId, first.receipt.runId);
  assert.equal(f.created(), 1);
  assert.equal(log.listEvents(f.scope.sessionId, { types: ['user_input_received'] }).length, 1);
  log.closeEventLog();
  const third = ingress.claimPlanExecutionIngress({ ...f.request, requestId: 'tap-three' }, f.create);
  assert.equal(third.joined, true);
  assert.equal(third.receipt.runId, first.receipt.runId);
  assert.equal(f.created(), 1);
});

test('late tap never creates or supersedes the accepted execution attempt', () => {
  const f = fixture();
  const first = ingress.claimPlanExecutionIngress(f.request, f.create);
  const attempt = log.beginRunAttempt(f.scope.sessionId, { runId: first.receipt.runId });
  const accepted = log.recordRunAttemptUserInput(attempt, { turn: 2, role: 'user', data: {
    text: 'Execute the reviewed plan.', taskMode: { version: 1, kind: 'execute', executeRef: f.request.ref }, runId: first.receipt.runId,
  } });
  const claim = plans.claimPlanExecution({ ...f.scope, sourceUserSeq: accepted.seq, executeRef: f.request.ref });
  const later = ingress.claimPlanExecutionIngress({ ...f.request, requestId: 'late-tap' }, f.create);
  assert.equal(later.receipt.runId, claim.claim.executionRunId);
  assert.equal(log.getActiveRunAttempt(f.scope.sessionId)?.attemptId, attempt.attemptId);
  assert.equal(f.created(), 1);
  assert.equal(log.listEvents(f.scope.sessionId, { types: ['user_input_received'] }).length, 2);
});

test('changed input, digest, owner and unrelated conversation cannot alias an execution', () => {
  const f = fixture(); ingress.claimPlanExecutionIngress(f.request, f.create);
  log.createSession({ id: 'unrelated', kind: 'chat', userId: f.scope.principalId });
  for (const request of [
    { ...f.request, inputHash: 'changed' },
    { ...f.request, requestId: 'new-key', inputHash: 'changed' },
    { ...f.request, ref: { ...f.request.ref, digest: '0'.repeat(64) } },
    { ...f.request, principalId: 'other-owner' },
    { ...f.request, sessionId: 'unrelated' },
  ]) assert.throws(() => ingress.claimPlanExecutionIngress(request, f.create));
  assert.equal(f.created(), 1);
});

test('new stale tap is refused while original request can rejoin its historical run', () => {
  const f = fixture(); ingress.claimPlanExecutionIngress(f.request, f.create);
  const source = log.appendEvent({ sessionId: f.scope.sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Revise the plan.', taskMode: { version: 1, kind: 'plan' } } });
  plans.publishPlanRevision({ ...f.scope, sourceUserSeq: source.seq, base: f.request.ref,
    fullText: 'Different reviewed Space.', readiness: 'ready' });
  assert.throws(() => ingress.claimPlanExecutionIngress({ ...f.request, requestId: 'stale-new-tap' }, f.create),
    (error: unknown) => error instanceof plans.PlanArtifactError && error.code === 'stale');
  assert.equal(ingress.claimPlanExecutionIngress(f.request, f.create).receipt.runId, 'one-execute-run');
  assert.equal(log.getHarnessChatRequestReceipt('stale-new-tap'), null);
});

test('failed receipt creation rolls back reservation and leaves no poisoned Execute key', () => {
  const f = fixture();
  assert.throws(() => ingress.claimPlanExecutionIngress(f.request, () => {
    f.create(); throw new Error('simulated pre-accept crash');
  }), /simulated/);
  assert.equal(log.getHarnessChatRequestReceipt(f.request.requestId), null);
  assert.equal(ingress.inspectPlanExecutionIngress(f.request), null);
  assert.equal(ingress.claimPlanExecutionIngress(f.request, f.create).joined, false);
});

test('Stop before acceptance survives reopen and prevents a fresh Execute key from reviving the reservation', () => {
  const f = fixture(); ingress.claimPlanExecutionIngress(f.request, f.create);
  log.requestHarnessChatCancellation(f.request.requestId, 'Stop before acceptance');
  log.closeEventLog();
  assert.throws(() => ingress.claimPlanExecutionIngress({ ...f.request, requestId: 'after-stop-tap' }, f.create), /stopped/);
  assert.equal(log.getHarnessChatRequestReceipt('after-stop-tap'), null);
  assert.equal(log.getActiveRunAttempt(f.scope.sessionId), null);
  assert.equal(f.created(), 1);
});

test('Stop through an existing alias cancels the canonical reservation and every other alias', () => {
  const f = fixture(); ingress.claimPlanExecutionIngress(f.request, f.create);
  ingress.claimPlanExecutionIngress({ ...f.request, requestId: 'stop-through-this-alias' }, f.create);
  ingress.claimPlanExecutionIngress({ ...f.request, requestId: 'other-existing-alias' }, f.create);
  log.requestHarnessChatCancellation('stop-through-this-alias', 'Stop after a lost response');
  log.closeEventLog();
  for (const requestId of [f.request.requestId, 'other-existing-alias']) {
    assert.ok(log.getHarnessChatCancellation(requestId));
    assert.throws(() => ingress.claimPlanExecutionIngress({ ...f.request, requestId }, f.create), /stopped/);
  }
  assert.throws(() => ingress.claimPlanExecutionIngress({ ...f.request, requestId: 'new-after-stop' }, f.create), /stopped/);
  assert.equal(f.created(), 1);
});
