import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-plan-artifact-api-'));
process.env.CLEMENTINE_HOME = fixtureHome;
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const log = await import('../runtime/harness/eventlog.js');
const artifacts = await import('../runtime/harness/plan-artifacts.js');
const { planArtifactResponse } = await import('./plan-artifacts-api.js');
const { commitTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
const { turnOutcomeId } = await import('../runtime/harness/turn-outcome.js');
const { projectHarnessEventForPublic } = await import('../runtime/harness/public-presentation.js');
const { reconstructHarnessTranscript } = await import('../runtime/harness/transcript.js');
const { getUnifiedSessionDetail } = await import('./sessions-api.js');
const { closeMemoryDb } = await import('../memory/db.js');

test.beforeEach(() => log.resetEventLog());
test.after(() => { log.closeEventLog(); closeMemoryDb(); rmSync(fixtureHome, { recursive: true, force: true }); });

function fixture() {
  const sessionId = 'plan-api-chat';
  const principalId = 'paired-phone-fixture';
  log.createSession({ id: sessionId, userId: principalId, kind: 'chat', channel: 'desktop' });
  const source = log.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Plan the exact fixture work.', taskMode: { version: 1, kind: 'plan' }, userId: principalId } });
  const fullText = `${'Complete plan details.\n'.repeat(1_500)}Final clause: café — preserve this exact tail.\n`;
  const artifact = artifacts.publishPlanRevision({ sessionId, principalId, sourceUserSeq: source.seq,
    fullText, readiness: 'ready', structuredPlan: { steps: [], preparedBindings: [] } });
  const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  return { sessionId, principalId, source, artifact, ref, fullText };
}

test('authenticated artifact response keeps full bytes and requires exact revision, digest, principal and conversation', () => {
  const fixtureData = fixture();
  const { sessionId, principalId, ref, fullText } = fixtureData;
  const query = { ...ref, revision: String(ref.revision), sessionId,
    principal: { kind: 'mobile_device' as const, principalId } };
  const response = planArtifactResponse(query);
  assert.equal(response.status, 200);
  assert.equal((response.body.artifact as { fullText: string }).fullText, fullText);
  assert.deepEqual(response.body.latest, ref);
  assert.equal(response.body.execution, null);
  assert.equal(planArtifactResponse({ ...query, principal: { kind: 'local_owner' } }).status, 200);
  assert.equal(planArtifactResponse({ ...query, principal: { kind: 'mobile_device', principalId: 'unrelated-device' } }).status, 403);
  assert.equal(planArtifactResponse({ ...query, digest: '0'.repeat(64) }).status, 409);
  assert.equal(planArtifactResponse({ ...query, revision: '2' }).status, 404);
  assert.equal(planArtifactResponse({ ...query, revision: '1.0' }).status, 400);
  assert.equal(planArtifactResponse({ ...query, digest: undefined }).status, 400);
  log.createSession({ id: 'unrelated-conversation', userId: principalId, kind: 'chat' });
  assert.equal(planArtifactResponse({ ...query, sessionId: 'unrelated-conversation' }).status, 403);
  log.closeEventLog();
  assert.deepEqual(planArtifactResponse(query), response);
});

test('public publication and reopened active chat retain only an exact review ref while complete artifact remains fetchable', () => {
  const { sessionId, source, ref } = fixture();
  const publication = log.listEvents(sessionId, { types: ['plan_revision_published'] })[0]!;
  const publicEvent = projectHarnessEventForPublic(publication)!;
  assert.deepEqual(publicEvent.data, { planArtifactRef: ref, sourceUserSeq: source.seq, readiness: 'ready' });
  assert.ok(!JSON.stringify(publicEvent).includes('preparedBindings'));
  assert.deepEqual(projectHarnessEventForPublic(source)?.data.taskMode, { version: 1, kind: 'plan' });
  const turns = reconstructHarnessTranscript(sessionId);
  assert.deepEqual(turns[0]?.taskMode, { version: 1, kind: 'plan' });
  assert.deepEqual(turns[1]?.planArtifactRef, ref);
  assert.equal(log.listEvents(sessionId, { types: ['conversation_completed'] }).length, 0,
    'an inspectable active plan is not fabricated as a completed turn');
});

test('real terminal publication derives its plan ref from exact durable source, ignores forged metadata, and survives desktop reopen', () => {
  const { sessionId, source, ref } = fixture();
  const identity = { sessionId, turn: source.turn, sourceUserSeq: source.seq };
  const completed = commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity,
    status: 'done', resumable: false, presentation: { kind: 'answer', text: 'The complete plan is saved for your review.' } },
  { metadata: { planArtifactRef: { planId: 'forged-model-plan', revision: 9, digest: 'f'.repeat(64) } } });
  assert.deepEqual(completed.event.data.planArtifactRef, ref);
  assert.deepEqual(projectHarnessEventForPublic(completed.event)?.data.planArtifactRef, ref);
  log.closeEventLog();
  const detail = getUnifiedSessionDetail(`harness:${sessionId}`);
  assert.ok(detail);
  assert.deepEqual(detail.turns[0]?.taskMode, { version: 1, kind: 'plan' });
  assert.deepEqual(detail.turns[1]?.planArtifactRef, ref);
  assert.equal(detail.turns.filter(turn => turn.planArtifactRef).length, 1);
  const normal = log.appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'An ordinary reply.' } });
  const normalIdentity = { sessionId, turn: normal.turn, sourceUserSeq: normal.seq };
  const next = commitTurnOutcome({ version: 2, id: turnOutcomeId(normalIdentity), identity: normalIdentity,
    status: 'done', resumable: false, presentation: { kind: 'answer', text: 'Ordinary reply.' } }, { metadata: { planArtifactRef: ref } });
  assert.equal(next.event.data.planArtifactRef, undefined, 'an unrelated normal source cannot borrow the previous plan ref');
});

test('execution projection is explicitly a reservation linked to the original run and never completion', () => {
  const { sessionId, principalId, ref } = fixture();
  const source = log.appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Execute.', userId: principalId, taskMode: { version: 1, kind: 'execute', executeRef: ref } } });
  const claimed = artifacts.claimPlanExecution({ sessionId, principalId, sourceUserSeq: source.seq, executeRef: ref });
  const event = log.listEvents(sessionId, { types: ['plan_execution_claimed'] })[0]!;
  const projected = projectHarnessEventForPublic(event)!;
  assert.deepEqual(projected.data, { planArtifactRef: ref, sourceUserSeq: source.seq,
    executionRunId: claimed.claim.executionRunId, claimId: claimed.claim.claimId, executionReserved: true });
  assert.equal(log.listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
});
