import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-reviewed-plans-'));
process.env.CLEMENTINE_HOME = fixtureHome;
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const store = await import('./plan-artifacts.js');
const log = await import('./eventlog.js');
const scopes = await import('../../agents/plan-scope.js');
const branches = await import('./accepted-source-session-branch.js');
type Ref = import('./task-mode.js').PlanRevisionRef;
type Mode = import('./task-mode.js').TaskMode;

test.beforeEach(() => log.resetEventLog());
test.after(() => { log.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

function session(id = 'plan-chat', principalId = 'fixture-owner') {
  log.createSession({ id, kind: 'chat', userId: principalId, channel: 'mobile',
    metadata: { source: 'mobile', channelId: 'fixture-conversation' } });
  return { sessionId: id, principalId };
}
function accepted(scope: ReturnType<typeof session>, mode: Mode, data: Record<string, unknown> = {}) {
  const event = log.appendEvent({ sessionId: scope.sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: mode.kind === 'execute' ? 'Execute the reviewed revision.' : 'Investigate and plan the requested work.',
      userId: scope.principalId, taskMode: mode, ...data } });
  return { ...scope, sourceUserSeq: event.seq };
}
function ref(artifact: Ref): Ref { return { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest }; }
function publish(scope = session(), overrides: Partial<Parameters<typeof store.publishPlanRevision>[0]> = {}) {
  const source = accepted(scope, { version: 1, kind: 'plan' });
  const input = { ...source, fullText: 'Inspect the exact target records, create three drafts once, and verify each provider acknowledgement.',
    readiness: 'ready' as const, authorModelId: 'configured-brain-fixture', ...overrides };
  return { scope, input, artifact: store.publishPlanRevision(input) };
}
function execute(scope: ReturnType<typeof session>, artifact: Ref) {
  return { ...accepted(scope, { version: 1, kind: 'execute', executeRef: ref(artifact) }), executeRef: ref(artifact) };
}
function count(table: string) {
  return (log.openEventLog().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function code(expected: string) {
  return (error: unknown) => error instanceof store.PlanArtifactError && error.code === expected;
}

test('full revision text and existing tool/schema/account/dataFrom/subagent/verification JSON survive reopen unchanged', () => {
  const fullText = `${'# Complete reviewed plan\n'.repeat(2_000)}Final decision: café — preserve this LF.\nEND-OF-FULL-PLAN\n`;
  const structuredPlan = {
    objective: 'Create exact drafts after research',
    steps: [
      { id: 'research', effect: 'read', dependencies: [], subagent: { role: 'researcher', output: 'selectedRows' } },
      { id: 'draft', dependencies: ['research'], capabilityRef: 'cap:fixture:draft', effect: 'write',
        schema: { digest: 'a'.repeat(64), fullSchema: { type: 'object', properties: { body: { type: 'string' } } } },
        account: { connectedAccountId: 'ca-fixture-owner', sourceEvidenceRef: 'fixture:account-route' },
        dataFrom: [{ producerNodeId: 'research', outputPath: '/selectedRows', targetPath: '/body' }],
        verification: { kind: 'provider_acknowledgement_v1', expectedResultFields: ['id', 'body'] } },
    ],
    successCriteria: ['Three exact draft bodies acknowledged; no sends'], missingPrerequisites: [],
  };
  const { scope, input, artifact } = publish(undefined, { fullText, structuredPlan });
  assert.equal(artifact.fullText, fullText);
  assert.deepEqual(artifact.structuredPlan, structuredPlan);
  assert.deepEqual(store.publishPlanRevision(input), artifact, 'replaying publication does not append a revision');
  assert.equal(count('reviewed_plan_revisions_v1'), 1);
  const event = log.listEvents(scope.sessionId, { types: ['plan_revision_published'] })[0]!;
  assert.deepEqual(event.data.planArtifactRef, ref(artifact));
  assert.equal(event.data.sourceUserSeq, input.sourceUserSeq);
  assert.equal(event.data.readiness, 'ready');
  log.closeEventLog();
  assert.deepEqual(store.getPlanRevision({ ...scope, ref: ref(artifact) }), artifact);
  assert.deepEqual(store.getLatestPlanRevision(scope), artifact);
});

test('revision append requires the exact current base; old artifacts remain readable and stale Execute never adopts latest', () => {
  const { scope, artifact: first } = publish();
  const nextSource = accepted(scope, { version: 1, kind: 'plan' });
  const second = store.publishPlanRevision({ ...nextSource, fullText: 'Revised scope and exact different payload.', readiness: 'ready', base: ref(first) });
  assert.equal(second.planId, first.planId);
  assert.equal(second.revision, 2);
  assert.notEqual(second.digest, first.digest);
  assert.equal(store.getPlanRevision({ ...scope, ref: ref(first) }).fullText, first.fullText);
  const stale = execute(scope, first);
  assert.throws(() => store.claimPlanExecution(stale), (error: unknown) => {
    assert.ok(error instanceof store.PlanArtifactError);
    assert.equal(error.code, 'stale');
    assert.deepEqual(error.latestRef, ref(second));
    return true;
  });
  const thirdSource = accepted(scope, { version: 1, kind: 'plan' });
  assert.throws(() => store.publishPlanRevision({ ...thirdSource, readiness: 'ready', fullText: 'Wrong base edit', base: ref(first) }), code('stale'));
  assert.equal(count('reviewed_plan_execution_claims_v1'), 0);
});

test('wrong principal, unrelated same-owner conversation, wrong source, synthetic and normal sources cannot publish or execute', () => {
  const { scope, input, artifact } = publish();
  const otherPrincipal = session('other-principal', 'another-owner');
  const unrelated = session('unrelated-same-owner');
  for (const rejected of [otherPrincipal, unrelated]) {
    assert.throws(() => store.getPlanRevision({ ...rejected, ref: ref(artifact) }), code('denied'));
    assert.throws(() => store.claimPlanExecution(execute(rejected, artifact)), code('denied'));
  }
  assert.throws(() => store.publishPlanRevision({ ...input, principalId: 'another-owner' }), code('denied'));
  assert.throws(() => store.publishPlanRevision({ ...input, sessionId: unrelated.sessionId }), code('denied'));
  for (const source of [accepted(scope, { version: 1, kind: 'normal' }),
    accepted(scope, { version: 1, kind: 'plan' }, { synthetic: true }),
    accepted(scope, { version: 1, kind: 'plan' }, { userId: 'another-owner' })]) {
    assert.throws(() => store.publishPlanRevision({ ...input, ...source }), code('denied'));
  }
  const normalSource = accepted(scope, { version: 1, kind: 'normal' });
  assert.throws(() => store.claimPlanExecution({ ...normalSource, executeRef: ref(artifact) }), code('denied'));
  assert.equal(count('reviewed_plan_execution_claims_v1'), 0);
});

test('validated same-conversation successor may review and Execute an ancestor plan; forged metadata grants no access', () => {
  const { scope, artifact } = publish();
  log.openEventLog().prepare("UPDATE sessions SET status = 'failed' WHERE id = ?").run(scope.sessionId);
  const selected = branches.selectSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: scope.sessionId,
    durableSourceId: 'plan-execute-successor', continuity: {
      provider: 'mobile', scopeId: null, conversationId: 'fixture-conversation', audienceId: scope.principalId,
    } });
  assert.equal(selected.disposition, 'branched');
  const child = { sessionId: selected.sessionId, principalId: scope.principalId };
  assert.deepEqual(branches.sameConversationAncestorSessionIds(child), [scope.sessionId]);
  assert.equal(store.getPlanRevision({ ...child, ref: ref(artifact) }).digest, artifact.digest);
  const claim = store.claimPlanExecution(execute(child, artifact));
  assert.equal(claim.claim.sessionId, child.sessionId);
  assert.equal(claim.artifact.sessionId, scope.sessionId);
  const unrelated = session('forged-conversation');
  const parentMetadata = log.getSession(selected.sessionId)!.metadata;
  log.openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run(
    JSON.stringify({ ...parentMetadata, channelId: 'different-conversation' }), unrelated.sessionId);
  assert.throws(() => store.getPlanRevision({ ...unrelated, ref: ref(artifact) }), code('denied'));
});

test('wrong revision, wrong digest, and mismatched accepted Execute reference are rejected exactly', () => {
  const { scope, artifact } = publish();
  const unknownRevision = { ...ref(artifact), revision: 2 };
  const wrongDigest = { ...ref(artifact), digest: 'f'.repeat(64) };
  assert.throws(() => store.claimPlanExecution(execute(scope, unknownRevision)), code('missing'));
  assert.throws(() => store.claimPlanExecution(execute(scope, wrongDigest)), code('conflict'));
  const exact = execute(scope, artifact);
  assert.throws(() => store.claimPlanExecution({ ...exact, executeRef: wrongDigest }), code('denied'));
  assert.equal(count('reviewed_plan_execution_claims_v1'), 0);
});

test('duplicate taps and restart rejoin one immutable execution/source reservation and no approval scope changes', async () => {
  const { scope, artifact } = publish();
  scopes.openPlanScope({ sessionId: 'unrelated-legacy', planProposalId: 'legacy-fixture',
    approvedPlanObjective: 'Preserve this existing native grant', allowedTools: ['write_file'] });
  const scopesPath = path.join(fixtureHome, 'state', 'plan-scopes.json');
  const beforeScopes = readFileSync(scopesPath, 'utf8');
  const firstSource = execute(scope, artifact);
  const secondSource = execute(scope, artifact);
  const [first, second] = await Promise.all([
    Promise.resolve().then(() => store.claimPlanExecution(firstSource)),
    Promise.resolve().then(() => store.claimPlanExecution(secondSource)),
  ]);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.joinedExistingSource, true);
  assert.deepEqual(second.claim, first.claim);
  assert.equal(first.claim.acceptedTaskId, `task:${scope.sessionId}#${firstSource.sourceUserSeq}`);
  assert.equal(count('reviewed_plan_execution_claims_v1'), 1);
  assert.equal(count('reviewed_plan_execution_observers_v1'), 2);
  assert.equal(log.listEvents(scope.sessionId, { types: ['plan_execution_claimed'] }).length, 1);
  log.closeEventLog();
  assert.deepEqual(store.claimPlanExecution(firstSource).claim, first.claim);
  assert.deepEqual(store.claimPlanExecution(secondSource).claim, first.claim);
  assert.deepEqual(store.getPlanExecutionClaim({ ...scope, ref: ref(artifact) }), first.claim);
  assert.equal(readFileSync(scopesPath, 'utf8'), beforeScopes);
  assert.equal(scopes.getPlanScope(scope.sessionId), null);
  assert.equal(count('run_attempts'), 0, 'a claim does not launch a business run or provider operation');
});

test('existing accepted-source run identity is retained and independently revalidated after restart', () => {
  const { scope, artifact } = publish();
  const input = execute(scope, artifact);
  const attempt = log.beginRunAttempt(scope.sessionId, { runId: 'ingress-run-exact' });
  log.bindRunAttemptSourceUserEvent(attempt, input.sourceUserSeq);
  const first = store.claimPlanExecution(input);
  assert.equal(first.claim.executionRunId, 'ingress-run-exact');
  assert.deepEqual(first.claim.executionRunBinding, { kind: 'accepted_run_attempt', attemptId: attempt.attemptId });
  log.closeEventLog();
  assert.deepEqual(store.claimPlanExecution(input).claim, first.claim);
  assert.equal(count('run_attempts'), 1);
});

test('a crash-equivalent failure after inserting the claim rolls back its event and row together before retry', () => {
  const { scope, artifact } = publish();
  const input = execute(scope, artifact);
  const db = log.openEventLog();
  db.exec(`CREATE TRIGGER fail_claim_observer BEFORE INSERT ON reviewed_plan_execution_observers_v1
    BEGIN SELECT RAISE(ABORT, 'fixture crash before observer persistence'); END;`);
  assert.throws(() => store.claimPlanExecution(input), /fixture crash/);
  assert.equal(count('reviewed_plan_execution_claims_v1'), 0);
  assert.equal(log.listEvents(scope.sessionId, { types: ['plan_execution_claimed'] }).length, 0);
  db.exec('DROP TRIGGER fail_claim_observer');
  log.closeEventLog();
  assert.equal(store.claimPlanExecution(input).replayed, false);
  assert.equal(count('reviewed_plan_execution_claims_v1'), 1);
});

test('replay of an already claimed source keeps its original run after a revision; a new stale tap is refused', () => {
  const { scope, artifact } = publish();
  const input = execute(scope, artifact);
  const original = store.claimPlanExecution(input);
  const revisionSource = accepted(scope, { version: 1, kind: 'plan' });
  store.publishPlanRevision({ ...revisionSource, fullText: 'New revision for later work.', readiness: 'ready', base: ref(artifact) });
  log.closeEventLog();
  assert.deepEqual(store.claimPlanExecution(input).claim, original.claim);
  assert.throws(() => store.claimPlanExecution(execute(scope, artifact)), code('stale'));
});

test('unready, oversized, or non-JSON plans fail without storing a partial revision', () => {
  const { scope, artifact } = publish(undefined, { readiness: 'needs_input', missingPrerequisites: ['Exact target account is unresolved.'] });
  assert.throws(() => store.claimPlanExecution(execute(scope, artifact)), code('not_ready'));
  for (const overrides of [
    { fullText: 'Do something', readiness: 'ready' as const, missingPrerequisites: ['Missing account'] },
    { fullText: 'X'.repeat(store.MAX_PLAN_ARTIFACT_BYTES + 1) },
    { structuredPlan: { concealed: undefined } as never },
    { structuredPlan: { nonfinite: Number.NaN } },
  ]) {
    const source = accepted(scope, { version: 1, kind: 'plan' });
    assert.throws(() => store.publishPlanRevision({ ...source, fullText: 'A complete plan', readiness: 'ready', ...overrides }));
  }
  assert.equal(count('reviewed_plan_revisions_v1'), 1);
  assert.equal(count('reviewed_plan_execution_claims_v1'), 0);
});

test('immutable artifact/claim rows reject edits and corrupted mirror events cannot be redeemed', () => {
  const { scope, artifact } = publish();
  const input = execute(scope, artifact);
  store.claimPlanExecution(input);
  const db = log.openEventLog();
  assert.throws(() => db.prepare("UPDATE reviewed_plan_revisions_v1 SET digest = 'wrong'").run(), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM reviewed_plan_execution_claims_v1').run(), /immutable/);
  for (const eventType of ['plan_revision_published', 'plan_execution_claimed'] as const) {
    db.exec('SAVEPOINT corrupt_plan_mirror');
    try {
      const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events'").all() as Array<{ name: string }>;
      for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
      db.prepare("UPDATE events SET data_json = '{}' WHERE type = ?").run(eventType);
      assert.throws(() => store.getPlanExecutionClaim({ ...scope, ref: ref(artifact) }), code('corrupt'));
    } finally { db.exec('ROLLBACK TO corrupt_plan_mirror'); db.exec('RELEASE corrupt_plan_mirror'); }
  }
  assert.ok(store.getPlanExecutionClaim({ ...scope, ref: ref(artifact) }));
});
