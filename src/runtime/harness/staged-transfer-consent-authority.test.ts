import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-staged-consent-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_AUTHORITY_SEAL_KEY = 'c'.repeat(64);
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-staged-consent\n', 'utf8');

const eventlog = await import('./eventlog.js');
const ledger = await import('./dispatch-ledger.js');
const staged = await import('./staged-transfer-authority.js');
const checkpoints = await import('./physical-return-checkpoint.js');
const composio = await import('../../integrations/composio/client.js');
const production = await import('./staged-transfer-production-fixture.js');

const originalFetch = globalThis.fetch;
let providerBodyCount = 0;
let networkBodyCount = 0;

test.after(() => {
  globalThis.fetch = originalFetch;
  composio.__test__.setConnectedAccountsLoader(null);
  composio.__test__.setComposioApiKeyOverride(null);
  composio.resetComposioClient();
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function count(sql: string, ...params: unknown[]): number {
  return (eventlog.openEventLog().prepare(sql).get(...params) as { count: number }).count;
}

function stagedWorkCounts(sessionId: string, sourceUserSeq: number) {
  return {
    plans: count(`
      SELECT COUNT(*) AS count FROM staged_transfer_plans
       WHERE session_id = ? AND source_user_seq = ?
    `, sessionId, sourceUserSeq),
    stages: count(`
      SELECT COUNT(*) AS count FROM staged_transfer_stages
       WHERE session_id = ? AND source_user_seq = ?
    `, sessionId, sourceUserSeq),
    authorities: count(`
      SELECT COUNT(*) AS count FROM staged_transfer_stage_authorities
       WHERE session_id = ? AND source_user_seq = ?
    `, sessionId, sourceUserSeq),
    stageLogicalCalls: count(`
      SELECT COUNT(*) AS count FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
         AND logical_tool_call_id GLOB 'call:staged:*'
    `, sessionId, sourceUserSeq),
    physical: count(`
      SELECT COUNT(*) AS count FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
         AND physical_dispatch_id GLOB 'dispatch:staged:*'
    `, sessionId, sourceUserSeq),
    checkpoints: count(`
      SELECT COUNT(*) AS count FROM physical_dispatch_return_checkpoints
       WHERE session_id = ? AND source_user_seq = ?
    `, sessionId, sourceUserSeq),
    receipts: count(`
      SELECT COUNT(*) AS count FROM staged_transfer_stage_receipts
       WHERE session_id = ? AND source_user_seq = ?
    `, sessionId, sourceUserSeq),
    blobOwners: count(`
      SELECT COUNT(*) AS count
        FROM staged_transfer_blob_owners owner
        JOIN staged_transfer_plans plan ON plan.plan_id = owner.plan_id
       WHERE plan.session_id = ? AND plan.source_user_seq = ?
    `, sessionId, sourceUserSeq),
    redemptions: count(`
      SELECT COUNT(*) AS count
        FROM staged_transfer_consent_redemptions redemption
        JOIN staged_transfer_plans plan ON plan.plan_id = redemption.plan_id
       WHERE plan.session_id = ? AND plan.source_user_seq = ?
    `, sessionId, sourceUserSeq),
  };
}

test('high-consequence staged attachment does zero work until its exact approval is redeemed', async () => {
  const sourcePath = path.join(TMP_HOME, 'approved-send-attachment.txt');
  writeFileSync(sourcePath, 'exact approved staged attachment\n', { encoding: 'utf8', mode: 0o600 });
  globalThis.fetch = (async () => {
    networkBodyCount += 1;
    throw new Error('consent test must not cross the network');
  }) as typeof fetch;
  composio.__test__.setComposioApiKeyOverride('consent-test-api-key');
  composio.__test__.setComposioClient({
    getClient: () => ({
      withOptions: () => ({
        tools: {
          execute: async () => {
            providerBodyCount += 1;
            throw new Error('consent test must not execute the provider');
          },
        },
      }),
    }),
  });

  for (const scenario of ['missing', 'wrong', 'rejected', 'expired', 'edited'] as const) {
    const refused = await production.createProductionStagedConsentFixture(`refused-${scenario}`, {
      uploadSourcePath: sourcePath,
      consentScenario: scenario,
    });
    assert.ok(
      refused.preparedPlan.status === 'preparation_required'
        || refused.preparedPlan.status === 'conflict',
      `${scenario}: ${JSON.stringify(refused.preparedPlan)}`,
    );
    assert.equal(refused.approvalEvidence?.matched ?? false, false, `${scenario} approval cannot mint authority`);
    assert.deepEqual(stagedWorkCounts(refused.session.id, refused.source.seq), {
      plans: 0,
      stages: 0,
      authorities: 0,
      stageLogicalCalls: 0,
      physical: 0,
      checkpoints: 0,
      receipts: 0,
      blobOwners: 0,
      redemptions: 0,
    }, `${scenario} grant must leave the whole staged body lane at zero`);
    assert.equal(providerBodyCount, 0);
    assert.equal(networkBodyCount, 0);
  }

  const faulted = await production.createProductionStagedConsentFixture('approved-plan-fault', {
    uploadSourcePath: sourcePath,
    consentScenario: 'approved',
    failPlanInsert: true,
  });
  assert.equal(faulted.preparedPlan.status, 'storage_error', JSON.stringify(faulted.preparedPlan));
  assert.equal(faulted.approvalEvidence?.matched, true);
  assert.ok(faulted.approvalEvidence?.approvalId);
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT consumed_at FROM pending_approvals WHERE approval_id = ?
  `).get(faulted.approvalEvidence!.approvalId!) as { consumed_at: string | null }).consumed_at, null,
  'the exact approval claim rolls back with a failed plan insert');
  assert.deepEqual(stagedWorkCounts(faulted.session.id, faulted.source.seq), {
    plans: 0,
    stages: 0,
    authorities: 0,
    stageLogicalCalls: 0,
    physical: 0,
    checkpoints: 0,
    receipts: 0,
    blobOwners: 0,
    redemptions: 0,
  }, 'plan persistence failure leaves no partial authority or consumed grant');
  assert.equal(providerBodyCount, 0);
  assert.equal(networkBodyCount, 0);

  const approved = await production.createProductionStagedConsentFixture('approved', {
    uploadSourcePath: sourcePath,
    consentScenario: 'approved',
  });
  assert.ok('preparedStage' in approved, JSON.stringify(approved.preparedPlan));
  if (!('preparedStage' in approved)) throw new Error('exact consent did not prepare its first stage');
  assert.equal(approved.approvalEvidence?.matched, true);
  assert.equal(approved.approvalEvidence?.claimState, 'approved');
  assert.equal(approved.preparedPlan.status === 'prepared' || approved.preparedPlan.status === 'replayed', true);

  const planRow = eventlog.openEventLog().prepare(`
    SELECT plan_id, consent_requirement, consent_subject_digest, plan_authority_digest
      FROM staged_transfer_plans
     WHERE session_id = ? AND source_user_seq = ?
  `).get(approved.session.id, approved.source.seq) as {
    plan_id: string;
    consent_requirement: string;
    consent_subject_digest: string;
    plan_authority_digest: string;
  };
  assert.equal(planRow.consent_requirement, 'exact_grant');
  assert.match(planRow.consent_subject_digest, /^[a-f0-9]{64}$/);
  const redemptionBeforeRestart = eventlog.openEventLog().prepare(`
    SELECT approval_id, consent_subject_digest, grant_digest
      FROM staged_transfer_consent_redemptions
     WHERE plan_id = ?
  `).get(planRow.plan_id);
  assert.deepEqual(stagedWorkCounts(approved.session.id, approved.source.seq), {
    plans: 1,
    stages: 4,
    authorities: 1,
    stageLogicalCalls: 1,
    physical: 1,
    checkpoints: 0,
    receipts: 0,
    blobOwners: 0,
    redemptions: 1,
  });

  const snapshot = staged.executeStagedLocalSnapshotBody({ authority: approved.preparedStage.authority });
  assert.equal(snapshot.status, 'returned', JSON.stringify(snapshot));
  if (snapshot.status !== 'returned') throw new Error('approved snapshot body did not return');
  assert.equal(staged.executeStagedLocalSnapshotBody({
    authority: approved.preparedStage.authority,
  }).status, 'conflict', 'one exact grant cannot execute the same body twice');
  const checkpoint = checkpoints.prepareStagedBlobBodyReturnCheckpoint({
    authority: approved.preparedStage.authority,
    result: snapshot.result,
    sha256: snapshot.sha256,
    md5: snapshot.md5,
    byteCount: snapshot.byteCount,
    bodyDigest: snapshot.bodyDigest,
    resultDigest: snapshot.resultDigest,
  });
  assert.equal(checkpoint.status, 'prepared', JSON.stringify(checkpoint));
  if (checkpoint.status !== 'prepared') throw new Error('approved snapshot checkpoint did not prepare');
  assert.equal(ledger.settleStagedPhysicalDispatch({
    authority: approved.preparedStage.authority,
    outcome: 'returned',
    returnCheckpoint: checkpoint.checkpoint,
  }).status, 'inserted');
  assert.equal(providerBodyCount, 0);
  assert.equal(networkBodyCount, 0);

  eventlog.closeEventLog();
  eventlog.openEventLog();
  const reopened = staged.reopenStagedTransferPlanAuthority({
    sessionId: approved.session.id,
    sourceUserSeq: approved.source.seq,
    parentLogicalToolCallId: approved.logicalToolCallId,
  });
  assert.equal(reopened.status, 'ok', JSON.stringify(reopened));
  if (reopened.status !== 'ok') throw new Error('exact consent plan did not reopen');
  assert.equal(staged.inspectStagedTransferPlanAuthority(reopened.authority)?.planAuthorityDigest,
    planRow.plan_authority_digest);
  assert.deepEqual(eventlog.openEventLog().prepare(`
    SELECT approval_id, consent_subject_digest, grant_digest
      FROM staged_transfer_consent_redemptions
     WHERE plan_id = ?
  `).get(planRow.plan_id), redemptionBeforeRestart, 'restart preserves the exact redeemed grant binding');

  const terminalSnapshot = staged.reopenStagedPhysicalDispatchAuthority({
    planAuthority: reopened.authority,
    stageOrdinal: 1,
  });
  assert.equal(terminalSnapshot.status, 'replayed', JSON.stringify(terminalSnapshot));
  if (terminalSnapshot.status !== 'replayed') throw new Error('snapshot attempt did not reopen');
  assert.equal(staged.inspectStagedPhysicalDispatchAuthority(terminalSnapshot.authority)?.terminalOnly, true);

  const presign = staged.prepareStagedPhysicalDispatch({
    planAuthority: reopened.authority,
    stageOrdinal: 2,
    parentDispatchLease: approved.callLease,
  });
  assert.ok(presign.status === 'prepared' || presign.status === 'replayed', JSON.stringify(presign));
  if (presign.status !== 'prepared' && presign.status !== 'replayed') throw new Error('presign did not prepare');
  assert.equal(ledger.beginStagedPhysicalDispatch({ authority: presign.authority }).status, 'inserted');
  assert.equal(staged.prepareStagedPhysicalDispatch({
    planAuthority: reopened.authority,
    stageOrdinal: 2,
    parentDispatchLease: approved.callLease,
  }).status, 'replayed', 'restart cannot mint a second presign physical crossing');
  assert.equal(providerBodyCount, 0, 'starting the next exact stage is not provider execution');
  assert.equal(networkBodyCount, 0);
  assert.deepEqual(stagedWorkCounts(approved.session.id, approved.source.seq), {
    plans: 1,
    stages: 4,
    authorities: 2,
    stageLogicalCalls: 2,
    physical: 2,
    checkpoints: 1,
    receipts: 1,
    blobOwners: 1,
    redemptions: 1,
  });
});
