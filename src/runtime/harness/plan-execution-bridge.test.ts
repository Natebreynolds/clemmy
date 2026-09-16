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

test('a preflight refusal before admission leaves no source, attempt or claim, and the same revision then Executes', async () => {
  const { checkReviewedPlanPreparation } = await import('./reviewed-plan-runtime.js');
  const catalogs = await import('./host-capability-catalog-factory.js');
  const manifests = await import('./capability-manifest.js');
  const schemas = await import('../../tools/composio-schema-cache.js');
  const { providerInputSchemaDigestOf } = await import('./reviewed-provider-identity.js');
  const { createHash } = await import('node:crypto');
  const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const operationId = 'reviewed_cli_bridge_fixture';
  const manifest = manifests.attachSemanticContract({
    version: 1, manifestId: `cap:fixture:reviewed-cli:${operationId}`, providerKind: 'reviewed_cli', operationId,
    providerIdentity: '/usr/bin/fixture-cli', providerVersion: 'fixture-v1', operationVersion: '1',
    definitionFingerprint: sha256(`definition:${operationId}`), effect: 'read', accountId: 'reviewed_cli:host',
    idempotency: { required: false, policy: 'none' }, reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' }, evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: { issuer: 'host:test', issuedAt: '2026-09-01T00:00:00.000Z', trusted: true }, lifecycle: { state: 'current' },
  });
  const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
  schemas.rememberToolSchema(operationId, schema, Date.now());
  const cached = schemas.getCachedToolSchema(operationId)!;
  const entry = {
    capabilityId: manifest.manifestId, toolName: manifest.operationId, schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint, effect: manifest.effect, account: manifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(manifest), providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint, providerInputSchemaDigest: providerInputSchemaDigestOf(cached),
    manifest, invoke: async () => ({ records: [], has_more: false }),
  };
  const factory = catalogs.createHostCapabilityCatalogFactory();
  factory.register(entry);
  catalogs.installHostCapabilityCatalogFactory(factory);
  try {
    const session = log.createSession({ id: 'bridge-preflight-owner', kind: 'chat', userId: 'owner' });
    const planSource = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Plan the query.', taskMode: { version: 1, kind: 'plan' } } });
    const structuredPlan = {
      steps: [{ id: 'query', action: 'Run the reviewed query.', effect: 'read', capabilityRef: manifest.manifestId, staticArguments: { query: 'SELECT Id FROM Account' },
        dynamicBindings: [], dependsOn: [], subagentRole: null, verification: 'Rows returned.' }],
      successCriteria: ['Rows returned.'], subagents: [], executionDraft: null,
      preparedBindings: [{ stepId: 'query', capabilityRef: manifest.manifestId, identity: catalogs.canonicalCatalogIdentityOf(entry), inputSchema: cached,
        argumentValidation: 'static_schema_checked', source: { sessionId: session.id, sourceUserSeq: planSource.seq } }],
      preparationIssues: [],
    } as never;
    const artifact = plans.publishPlanRevision({ sessionId: session.id, sourceUserSeq: planSource.seq, principalId: 'owner', fullText: 'Run the reviewed query.', structuredPlan, readiness: 'ready' });
    const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
    const scope = { sessionId: session.id, principalId: 'owner', ref };
    // The capability is momentarily not current (evicted schema): the check
    // refuses BEFORE admission, so nothing is minted for this revision.
    factory.forget(entry.capabilityId);
    await assert.rejects(checkReviewedPlanPreparation(artifact, { sessionId: session.id }), /changed or is unavailable/);
    assert.equal(plans.getPlanExecutionClaim(scope), null, 'no claim was spent');
    assert.equal((log.openEventLog().prepare('SELECT COUNT(*) AS n FROM run_attempts').get() as { n: number }).n, 0, 'no attempt');
    assert.equal(log.listEvents(session.id, { types: ['user_input_received'] }).length, 1, 'no Execute source');
    // The capability is current again: the SAME revision Executes.
    factory.register(entry);
    await checkReviewedPlanPreparation(artifact, { sessionId: session.id });
    const admitted = admitPlanExecutionBridgeSource({ sessionId: session.id, mode: { version: 1, kind: 'execute', executeRef: ref }, displayText: 'Execute this plan.', modelDirectiveApplied: false, surface: 'home' });
    assert.equal(admitted.kind, 'accepted'); if (admitted.kind !== 'accepted') throw new Error('not accepted');
    assert.equal(admitted.claim.ref.revision, artifact.revision);
    assert.equal(plans.getPlanExecutionClaim(scope)?.executionRunId, admitted.attempt.runId);
  } finally {
    catalogs.installHostCapabilityCatalogFactory(null);
  }
});
