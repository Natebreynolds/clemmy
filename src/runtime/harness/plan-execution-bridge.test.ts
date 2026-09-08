import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-reviewed-bridge-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const log = await import('./eventlog.js');
const plans = await import('./plan-artifacts.js');
const { admitPlanExecutionBridgeSource } = await import('./plan-execution-bridge.js');
beforeEach(() => log.resetEventLog());
after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const session = log.createSession({ id: 'bridge-reviewed-owner', kind: 'chat', userId: 'owner' });
  const planSource = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Investigate the exact work.', taskMode: { version: 1, kind: 'plan' } } });
  const artifact = plans.publishPlanRevision({ sessionId: session.id, sourceUserSeq: planSource.seq, principalId: 'owner', fullText: 'Reviewed exact work.', readiness: 'ready' });
  const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  return { session, artifact, input: { sessionId: session.id, mode: { version: 1 as const, kind: 'execute' as const, executeRef: ref }, displayText: 'Execute this plan.', modelDirectiveApplied: false, surface: 'home' } };
}
test('direct Execute without a caller run ID binds one deterministic accepted-source run and reopens it', () => {
  const { input } = fixture();
  const first = admitPlanExecutionBridgeSource(input);
  assert.equal(first.kind, 'accepted'); if (first.kind !== 'accepted') throw new Error('not accepted');
  assert.match(first.attempt.runId!, /^run-plan-source-/);
  assert.equal(first.claim.executionRunId, first.attempt.runId);
  assert.deepEqual(first.claim.executionRunBinding, { kind: 'accepted_run_attempt', attemptId: first.attempt.attemptId });
  log.closeEventLog();
  const replay = admitPlanExecutionBridgeSource({ ...input, sourceUserSeq: first.source.seq });
  assert.equal(replay.kind, 'accepted'); if (replay.kind !== 'accepted') throw new Error('not accepted');
  assert.equal(replay.attempt.attemptId, first.attempt.attemptId);
  assert.equal(replay.attempt.runId, first.attempt.runId);
  assert.equal((log.openEventLog().prepare('SELECT COUNT(*) AS n FROM run_attempts').get() as { n: number }).n, 1);
});
test('different-source and source-less duplicate joins never create or supersede the live attempt', () => {
  const { input } = fixture();
  const first = admitPlanExecutionBridgeSource(input);
  assert.equal(first.kind, 'accepted'); if (first.kind !== 'accepted') throw new Error('not accepted');
  assert.equal(admitPlanExecutionBridgeSource({ ...input, runId: 'arbitrary-duplicate-run' }).kind, 'joined');
  const duplicate = log.appendEvent({ sessionId: input.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: input.displayText, taskMode: input.mode } });
  const joined = admitPlanExecutionBridgeSource({ ...input, sourceUserSeq: duplicate.seq, runId: 'must-not-supersede' });
  assert.equal(joined.kind, 'joined');
  assert.equal(log.getRunAttemptBySourceUserSeq(input.sessionId, first.source.seq)?.status, 'active');
  assert.equal((log.openEventLog().prepare('SELECT COUNT(*) AS n FROM run_attempts').get() as { n: number }).n, 1);
  assert.equal((log.openEventLog().prepare('SELECT COUNT(*) AS n FROM reviewed_plan_execution_observers_v1').get() as { n: number }).n, 2);
});
test('changed exact-source run, changed source mode, stale revision and wrong owner refuse before attempt mutation', () => {
  const { input, artifact } = fixture();
  const first = admitPlanExecutionBridgeSource(input);
  assert.equal(first.kind, 'accepted'); if (first.kind !== 'accepted') throw new Error('not accepted');
  assert.throws(() => admitPlanExecutionBridgeSource({ ...input, sourceUserSeq: first.source.seq, runId: 'different' }), /established run/);
  const normal = log.appendEvent({ sessionId: input.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'New ordinary work.' } });
  assert.throws(() => admitPlanExecutionBridgeSource({ ...input, sourceUserSeq: normal.seq }), /source mode/);
  const revisionSource = log.appendEvent({ sessionId: input.sessionId, turn: 3, role: 'user', type: 'user_input_received', data: { text: 'Revise the plan.', taskMode: { version: 1, kind: 'plan' } } });
  plans.publishPlanRevision({ sessionId: input.sessionId, sourceUserSeq: revisionSource.seq, principalId: 'owner', fullText: 'Revised work.', readiness: 'ready', base: input.mode.executeRef });
  assert.throws(() => admitPlanExecutionBridgeSource(input), /latest revision/);
  assert.equal(admitPlanExecutionBridgeSource({ ...input, sourceUserSeq: first.source.seq }).kind, 'accepted', 'exact old source still reopens its existing claim');
  log.createSession({ id: 'foreign-owner', kind: 'chat', userId: 'other' });
  assert.throws(() => admitPlanExecutionBridgeSource({ ...input, sessionId: 'foreign-owner' }), /owner|principal|conversation/i);
  assert.equal((log.openEventLog().prepare('SELECT COUNT(*) AS n FROM run_attempts').get() as { n: number }).n, 1);
  assert.equal(log.getRunAttemptBySourceUserSeq(input.sessionId, first.source.seq)?.status, 'active');
  assert.equal(artifact.revision, 1);
});

test('a terminal exact source joins its established execution without a retry attempt', () => {
  const { input } = fixture();
  const first = admitPlanExecutionBridgeSource(input);
  assert.equal(first.kind, 'accepted'); if (first.kind !== 'accepted') throw new Error('not accepted');
  log.finishRunAttempt(first.attempt, 'completed');
  log.appendEvent({ sessionId: input.sessionId, turn: first.source.turn, role: 'assistant', type: 'conversation_completed', data: { sourceUserSeq: first.source.seq, terminalKey: `turn:${first.source.seq}`, reason: 'completed', text: 'Existing execution is closed.' } });
  log.closeEventLog();
  assert.equal(admitPlanExecutionBridgeSource({ ...input, sourceUserSeq: first.source.seq }).kind, 'joined');
  assert.equal((log.openEventLog().prepare('SELECT COUNT(*) AS n FROM run_attempts').get() as { n: number }).n, 1);
  assert.equal(log.getRunAttemptBySourceUserSeq(input.sessionId, first.source.seq)?.status, 'completed');
});
