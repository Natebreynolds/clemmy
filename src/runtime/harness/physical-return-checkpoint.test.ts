import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-physical-return-v62-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_AUTHORITY_SEAL_KEY = '7'.repeat(64);
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-physical-return-v62\n', 'utf8');

const eventlog = await import('./eventlog.js');
const ledger = await import('./dispatch-ledger.js');
const staged = await import('./staged-transfer-authority.js');
const checkpoints = await import('./physical-return-checkpoint.js');
const composio = await import('../../integrations/composio/client.js');
const fixtureSupport = await import('./staged-transfer-production-fixture.js');

test.after(() => {
  composio.__test__.setConnectedAccountsLoader(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

type Fixture = Awaited<ReturnType<typeof fixtureSupport.createProductionStagedBusinessFixture>>;

async function returnedCheckpoint(fixture: Fixture, result: unknown) {
  composio.__test__.setComposioApiKeyOverride('test-api-key');
  let bodyCount = 0;
  composio.__test__.setComposioClient({
    getClient: () => ({
      withOptions: () => ({
        tools: {
          execute: async () => {
            bodyCount += 1;
            return result;
          },
        },
      }),
    }),
  });
  const oneShot = composio.prepareComposioOneShotDispatch({
    toolSlug: fixture.operationId,
    args: fixture.args,
    connectedAccountId: fixture.accountId,
    providerOperationVersion: fixture.operationVersion,
  });
  const executed = await checkpoints.executeStagedPreparedComposioBody({
    authority: fixture.preparedStage.authority,
    preparedDispatch: oneShot,
  });
  assert.equal(executed.status, 'returned', JSON.stringify(executed));
  if (executed.status !== 'returned') throw new Error('provider body did not return');
  assert.equal(bodyCount, 1);
  return { checkpoint: executed.checkpoint, bodyCount: () => bodyCount };
}

async function startedUploadTransfer(label: string, sourceBytes: Buffer) {
  const uploadDirectory = path.join(TMP_HOME, 'uploads');
  mkdirSync(uploadDirectory, { recursive: true });
  const sourcePath = path.join(uploadDirectory, `${label}.txt`);
  writeFileSync(sourcePath, sourceBytes, { mode: 0o600 });
  const fixture = await fixtureSupport.createProductionStagedBusinessFixture(label, {
    uploadSourcePath: sourcePath,
  });
  const snapshot = staged.executeStagedLocalSnapshotBody({ authority: fixture.preparedStage.authority });
  assert.equal(snapshot.status, 'returned', JSON.stringify(snapshot));
  if (snapshot.status !== 'returned') throw new Error('snapshot setup did not return');
  const snapshotCheckpoint = checkpoints.prepareStagedBlobBodyReturnCheckpoint({
    authority: fixture.preparedStage.authority,
    result: snapshot.result,
    sha256: snapshot.sha256,
    md5: snapshot.md5,
    byteCount: snapshot.byteCount,
    bodyDigest: snapshot.bodyDigest,
    resultDigest: snapshot.resultDigest,
  });
  assert.equal(snapshotCheckpoint.status, 'prepared', JSON.stringify(snapshotCheckpoint));
  if (snapshotCheckpoint.status !== 'prepared') throw new Error('snapshot checkpoint setup refused');
  assert.equal(ledger.settleStagedPhysicalDispatch({
    authority: fixture.preparedStage.authority,
    outcome: 'returned',
    returnCheckpoint: snapshotCheckpoint.checkpoint,
  }).status, 'inserted');
  eventlog.closeEventLog();
  eventlog.openEventLog();
  const afterSnapshot = staged.reopenStagedTransferPlanAuthority({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    parentLogicalToolCallId: fixture.logicalToolCallId,
  });
  assert.equal(afterSnapshot.status, 'ok', JSON.stringify(afterSnapshot));
  if (afterSnapshot.status !== 'ok') throw new Error('snapshot setup plan did not reopen');
  const presignStage = staged.prepareStagedPhysicalDispatch({
    planAuthority: afterSnapshot.authority,
    stageOrdinal: 2,
    parentDispatchLease: fixture.callLease,
  });
  assert.ok(presignStage.status === 'prepared' || presignStage.status === 'replayed', JSON.stringify(presignStage));
  if (presignStage.status !== 'prepared' && presignStage.status !== 'replayed') {
    throw new Error('presign setup did not prepare');
  }
  assert.equal(ledger.beginStagedPhysicalDispatch({ authority: presignStage.authority }).status, 'inserted');
  composio.__test__.setComposioApiKeyOverride('test-api-key');
  const signedUrl = `https://storage.example/private/${label}.txt?token=never-plaintext`;
  let presignCount = 0;
  composio.__test__.setComposioClient({
    getClient: () => ({
      withOptions: () => ({
        files: {
          createPresignedURL: async () => {
            presignCount += 1;
            return {
              key: `staged/private/${label}.txt`,
              new_presigned_url: signedUrl,
              metadata: { storage_backend: 's3' },
            };
          },
        },
      }),
    }),
  });
  const preparedPresign = staged.prepareStagedComposioPresignBody({ authority: presignStage.authority });
  assert.ok(
    preparedPresign.status === 'prepared' || preparedPresign.status === 'replayed',
    JSON.stringify(preparedPresign),
  );
  if (preparedPresign.status !== 'prepared' && preparedPresign.status !== 'replayed') {
    throw new Error('presign setup one-shot refused');
  }
  const presign = await checkpoints.executeStagedPreparedComposioPresignBody({
    authority: presignStage.authority,
    preparedPresign: preparedPresign.preparedPresign,
  });
  assert.equal(presign.status, 'returned', JSON.stringify(presign));
  if (presign.status !== 'returned') throw new Error('presign setup body did not return');
  assert.equal(ledger.settleStagedPhysicalDispatch({
    authority: presignStage.authority,
    outcome: 'returned',
    returnCheckpoint: presign.checkpoint,
  }).status, 'inserted');
  assert.equal(presignCount, 1);
  eventlog.closeEventLog();
  eventlog.openEventLog();
  const afterPresign = staged.reopenStagedTransferPlanAuthority({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    parentLogicalToolCallId: fixture.logicalToolCallId,
  });
  assert.equal(afterPresign.status, 'ok', JSON.stringify(afterPresign));
  if (afterPresign.status !== 'ok') throw new Error('presign setup plan did not reopen');
  const uploadStage = staged.prepareStagedPhysicalDispatch({
    planAuthority: afterPresign.authority,
    stageOrdinal: 3,
    parentDispatchLease: fixture.callLease,
  });
  assert.ok(uploadStage.status === 'prepared' || uploadStage.status === 'replayed', JSON.stringify(uploadStage));
  if (uploadStage.status !== 'prepared' && uploadStage.status !== 'replayed') {
    throw new Error('upload setup did not prepare');
  }
  assert.equal(ledger.beginStagedPhysicalDispatch({ authority: uploadStage.authority }).status, 'inserted');
  return { fixture, uploadStage, sourceBytes, sourcePath, signedUrl };
}

test('returned physical row, encrypted checkpoint, and receipt commit atomically without logical success', async () => {
  const fixture = await fixtureSupport.createProductionStagedBusinessFixture('atomic-success');
  const signedUrl = 'https://storage.example/private?X-Amz-Credential=never-plaintext';
  const returned = await returnedCheckpoint(fixture, {
    successful: true,
    error: null,
    data: { id: 'file-1', file: { s3url: signedUrl, mimetype: 'application/pdf' } },
  });
  assert.equal(ledger.settleStagedPhysicalDispatch({
    authority: fixture.preparedStage.authority,
    outcome: 'returned',
    returnCheckpoint: returned.checkpoint,
  }).status, 'inserted');
  assert.equal(returned.bodyCount(), 1);

  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`SELECT state FROM physical_dispatches
    WHERE physical_dispatch_id = ?`).get(fixture.preparedStage.physicalDispatchId) as {
    state: string;
  }).state, 'returned');
  const stored = db.prepare(`
    SELECT checkpoint.*, receipt.terminal_state, receipt.result_digest
      FROM physical_dispatch_return_checkpoints checkpoint
      JOIN staged_transfer_stage_receipts receipt
        ON receipt.stage_authority_id = checkpoint.stage_authority_id
     WHERE checkpoint.stage_authority_id = ?
  `).get(fixture.preparedStage.stageAuthorityId) as Record<string, unknown>;
  assert.equal(stored.terminal_state, 'returned');
  assert.equal(stored.result_digest, stored.payload_plaintext_sha256);
  assert.equal(JSON.stringify(stored).includes(signedUrl), false);
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM logical_call_settlements
    WHERE session_id = ? AND source_user_seq = ?`).get(
      fixture.session.id,
      fixture.source.seq,
    ) as { count: number }).count, 0);

  eventlog.closeEventLog();
  eventlog.openEventLog();
  const reopenedPlan = staged.reopenStagedTransferPlanAuthority({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    parentLogicalToolCallId: fixture.logicalToolCallId,
  });
  assert.equal(reopenedPlan.status, 'ok', JSON.stringify(reopenedPlan));
  if (reopenedPlan.status !== 'ok') throw new Error('plan did not reopen');
  const reopenedAttempt = staged.reopenStagedPhysicalDispatchAuthority({
    planAuthority: reopenedPlan.authority,
    stageOrdinal: 1,
  });
  assert.equal(reopenedAttempt.status, 'replayed', JSON.stringify(reopenedAttempt));
  if (reopenedAttempt.status !== 'replayed') throw new Error('attempt did not reopen');
  const recovered = checkpoints.recoverCommittedStagedPhysicalReturn({
    authority: reopenedAttempt.authority,
  });
  assert.equal(recovered.status, 'committed', JSON.stringify(recovered));
  if (recovered.status !== 'committed') throw new Error('checkpoint did not recover');
  assert.equal(checkpoints.committedStagedPhysicalReturnOwns(
    recovered.returned,
    reopenedAttempt.authority,
  ), true);
  assert.equal('rawPayloadBytes' in recovered, false);
});

test('checkpoint INSERT fault rolls back returned state and mirror, then exact retry commits once', async () => {
  const fixture = await fixtureSupport.createProductionStagedBusinessFixture('atomic-fault');
  const returned = await returnedCheckpoint(fixture, {
    successful: true,
    error: null,
    data: { id: 'file-fault' },
  });
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER force_physical_return_checkpoint_fault
    BEFORE INSERT ON physical_dispatch_return_checkpoints
    BEGIN SELECT RAISE(ABORT, 'forced checkpoint insert fault'); END;
  `);
  const beforeSettles = eventlog.listEvents(fixture.session.id, {
    types: ['provider_dispatch_settled'],
  }).length;
  assert.equal(ledger.settleStagedPhysicalDispatch({
    authority: fixture.preparedStage.authority,
    outcome: 'returned',
    returnCheckpoint: returned.checkpoint,
  }).status, 'storage_error');
  assert.equal((db.prepare(`SELECT state FROM physical_dispatches
    WHERE physical_dispatch_id = ?`).get(fixture.preparedStage.physicalDispatchId) as {
    state: string;
  }).state, 'started');
  assert.equal(eventlog.listEvents(fixture.session.id, {
    types: ['provider_dispatch_settled'],
  }).length, beforeSettles);
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM physical_dispatch_return_checkpoints
    WHERE stage_authority_id = ?`).get(fixture.preparedStage.stageAuthorityId) as {
    count: number;
  }).count, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM staged_transfer_stage_receipts
    WHERE stage_authority_id = ?`).get(fixture.preparedStage.stageAuthorityId) as {
    count: number;
  }).count, 0);

  db.exec('DROP TRIGGER force_physical_return_checkpoint_fault');
  assert.equal(ledger.settleStagedPhysicalDispatch({
    authority: fixture.preparedStage.authority,
    outcome: 'returned',
    returnCheckpoint: returned.checkpoint,
  }).status, 'inserted');
  assert.equal(returned.bodyCount(), 1, 'settlement retry never re-enters provider body');
});

test('staged return without exact checkpoint stays started and alternate identity is denied', async () => {
  const fixture = await fixtureSupport.createProductionStagedBusinessFixture('missing-checkpoint');
  assert.equal(ledger.settleStagedPhysicalDispatch({
    authority: fixture.preparedStage.authority,
    outcome: 'returned',
  }).status, 'conflict');
  const visible = staged.inspectStagedPhysicalDispatchAuthority(fixture.preparedStage.authority)!;
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`SELECT state FROM physical_dispatches
    WHERE physical_dispatch_id = ?`).get(fixture.preparedStage.physicalDispatchId) as {
    state: string;
  }).state, 'started');
  assert.equal(ledger.beginPhysicalDispatch({
    identity: {
      sessionId: fixture.session.id,
      sourceUserSeq: fixture.source.seq,
      acceptedTaskId: fixture.acceptedTaskId,
      logicalToolCallId: fixture.logicalToolCallId,
      physicalDispatchId: `${fixture.preparedStage.physicalDispatchId}:alternate`,
      ordinal: 2,
    },
    tool: fixture.operationId,
    args: fixture.args,
    dispatchLease: visible.lease,
  }).status, 'conflict');
});

test('local snapshot has one body, opaque checkpoint, and exact non-forgeable blob ownership', async () => {
  const uploadDirectory = path.join(TMP_HOME, 'uploads');
  mkdirSync(uploadDirectory, { recursive: true });
  const sourcePath = path.join(uploadDirectory, 'report.txt');
  const sourceBytes = Buffer.from('exact local snapshot bytes\n', 'utf8');
  writeFileSync(sourcePath, sourceBytes, { mode: 0o600 });
  const fixture = await fixtureSupport.createProductionStagedBusinessFixture(
    'local-snapshot',
    { uploadSourcePath: sourcePath },
  );
  const visible = staged.inspectStagedPhysicalDispatchAuthority(fixture.preparedStage.authority)!;
  assert.equal(visible.stageKind, 'local_snapshot');
  const body = staged.executeStagedLocalSnapshotBody({ authority: fixture.preparedStage.authority });
  assert.equal(body.status, 'returned', JSON.stringify(body));
  if (body.status !== 'returned') throw new Error('local snapshot did not return');
  assert.equal(body.byteCount, sourceBytes.byteLength);
  assert.equal(staged.executeStagedLocalSnapshotBody({
    authority: fixture.preparedStage.authority,
  }).status, 'conflict', 'body token is consumed once');
  const checkpoint = checkpoints.prepareStagedBlobBodyReturnCheckpoint({
    authority: fixture.preparedStage.authority,
    result: body.result,
    sha256: body.sha256,
    md5: body.md5,
    byteCount: body.byteCount,
    bodyDigest: body.bodyDigest,
    resultDigest: body.resultDigest,
  });
  assert.equal(checkpoint.status, 'prepared', JSON.stringify(checkpoint));
  if (checkpoint.status !== 'prepared') throw new Error('blob checkpoint refused');
  const snapshotSettlement = ledger.settleStagedPhysicalDispatch({
    authority: fixture.preparedStage.authority,
    outcome: 'returned',
    returnCheckpoint: checkpoint.checkpoint,
  });
  assert.equal(snapshotSettlement.status, 'inserted', JSON.stringify(snapshotSettlement));
  let db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT blob_sha256, blob_md5, blob_bytes FROM staged_transfer_blob_owners
     WHERE plan_id = ? AND stage_id = ?
  `).get(visible.planId, visible.stageId), {
    blob_sha256: body.sha256,
    blob_md5: body.md5,
    blob_bytes: body.byteCount,
  }, 'returned physical + checkpoint + receipt + blob owner commit atomically');
  eventlog.closeEventLog();
  db = eventlog.openEventLog();
  const reopenedPlan = staged.reopenStagedTransferPlanAuthority({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    parentLogicalToolCallId: fixture.logicalToolCallId,
  });
  assert.equal(reopenedPlan.status, 'ok', JSON.stringify(reopenedPlan));
  if (reopenedPlan.status !== 'ok') throw new Error('staged upload plan did not reopen');
  const nextStage = staged.prepareStagedPhysicalDispatch({
    planAuthority: reopenedPlan.authority,
    stageOrdinal: 2,
    parentDispatchLease: fixture.callLease,
  });
  assert.ok(nextStage.status === 'prepared' || nextStage.status === 'replayed', JSON.stringify(nextStage));
  if (nextStage.status !== 'prepared' && nextStage.status !== 'replayed') {
    throw new Error('presign stage did not prepare');
  }
  assert.equal(ledger.beginStagedPhysicalDispatch({ authority: nextStage.authority }).status, 'inserted');
  composio.__test__.setComposioApiKeyOverride('test-api-key');
  const presignCalls: Array<{
    options: unknown;
    body: unknown;
    requestOptions: unknown;
  }> = [];
  composio.__test__.setComposioClient({
    getClient: () => ({
      withOptions: (options: unknown) => ({
        files: {
          createPresignedURL: async (presignBody: unknown, requestOptions: unknown) => {
            presignCalls.push({ options, body: presignBody, requestOptions });
            return {
              key: 'staged/private/report.txt',
              new_presigned_url: 'https://storage.example/private/report.txt?token=never-plaintext',
              metadata: { storage_backend: 's3' },
            };
          },
        },
      }),
    }),
  });
  const presignPrepared = staged.prepareStagedComposioPresignBody({
    authority: nextStage.authority,
  });
  assert.ok(
    presignPrepared.status === 'prepared' || presignPrepared.status === 'replayed',
    JSON.stringify(presignPrepared),
  );
  if (presignPrepared.status !== 'prepared' && presignPrepared.status !== 'replayed') {
    throw new Error('presign provider one-shot did not prepare');
  }
  const presignReturned = await checkpoints.executeStagedPreparedComposioPresignBody({
    authority: nextStage.authority,
    preparedPresign: presignPrepared.preparedPresign,
  });
  assert.equal(presignReturned.status, 'returned', JSON.stringify(presignReturned));
  if (presignReturned.status !== 'returned') throw new Error('presign provider body did not return');
  assert.equal(presignCalls.length, 1);
  assert.deepEqual(presignCalls[0]?.options, { maxRetries: 0 });
  assert.deepEqual(presignCalls[0]?.body, {
    filename: 'report.txt',
    mimetype: 'application/octet-stream',
    md5: body.md5,
    tool_slug: fixture.operationId,
    toolkit_slug: 'googledrive',
  });
  const signedUrl = 'https://storage.example/private/report.txt?token=never-plaintext';
  assert.equal(JSON.stringify(presignReturned).includes(signedUrl), false);
  const presignVisible = staged.inspectStagedPhysicalDispatchAuthority(nextStage.authority)!;
  assert.throws(() => db.prepare(`
    INSERT INTO staged_transfer_secret_payloads
      (payload_id, stage_authority_id, payload_kind, binding_digest,
       plaintext_sha256, plaintext_bytes, chunk_count, sealed_sha256,
       sealed_bytes, expires_at, created_at)
    VALUES (?, ?, 'staged_signed_url', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `forged-secret-${fixture.session.id}`,
    presignVisible.stageAuthorityId,
    'a'.repeat(64),
    'b'.repeat(64),
    1,
    1,
    'c'.repeat(64),
    1,
    new Date(Date.now() + 60_000).toISOString(),
    new Date().toISOString(),
  ), /clementine_staged_secret_admitted_v1|exact returned presign attempt/,
  'copyable rows cannot forge the encrypted presign secret owner');
  assert.equal(ledger.settleStagedPhysicalDispatch({
    authority: nextStage.authority,
    outcome: 'returned',
    returnCheckpoint: presignReturned.checkpoint,
  }).status, 'inserted');
  assert.equal(presignCalls.length, 1, 'settlement never re-enters the provider POST');
  assert.equal(staged.prepareStagedComposioPresignBody({
    authority: nextStage.authority,
  }).status, 'conflict', 'the exact presign body carrier cannot be reused');
  const secretOwner = db.prepare(`
    SELECT payload_kind, stage_authority_id, plaintext_sha256, expires_at
      FROM staged_transfer_secret_payloads
     WHERE stage_authority_id = ?
  `).get(presignVisible.stageAuthorityId) as Record<string, unknown>;
  assert.equal(secretOwner.payload_kind, 'staged_signed_url');
  assert.equal(secretOwner.stage_authority_id, presignVisible.stageAuthorityId);
  assert.equal(typeof secretOwner.plaintext_sha256, 'string');
  assert.ok(Date.parse(String(secretOwner.expires_at)) > Date.now());
  const presignDurableRows = JSON.stringify([
    ...db.prepare(`SELECT * FROM staged_transfer_secret_payloads WHERE stage_authority_id = ?`)
      .all(presignVisible.stageAuthorityId),
    ...db.prepare(`SELECT * FROM physical_dispatch_return_checkpoints WHERE stage_authority_id = ?`)
      .all(presignVisible.stageAuthorityId),
    ...db.prepare(`SELECT data_json FROM events WHERE session_id = ?`).all(fixture.session.id),
  ]);
  assert.equal(presignDurableRows.includes(signedUrl), false);

  eventlog.closeEventLog();
  db = eventlog.openEventLog();
  const postPresignPlan = staged.reopenStagedTransferPlanAuthority({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    parentLogicalToolCallId: fixture.logicalToolCallId,
  });
  assert.equal(postPresignPlan.status, 'ok', JSON.stringify(postPresignPlan));
  if (postPresignPlan.status !== 'ok') throw new Error('post-presign plan did not reopen');
  const uploadTransfer = staged.prepareStagedPhysicalDispatch({
    planAuthority: postPresignPlan.authority,
    stageOrdinal: 3,
    parentDispatchLease: fixture.callLease,
  });
  assert.ok(
    uploadTransfer.status === 'prepared' || uploadTransfer.status === 'replayed',
    JSON.stringify(uploadTransfer),
  );
  if (uploadTransfer.status !== 'prepared' && uploadTransfer.status !== 'replayed') {
    throw new Error('upload transfer stage did not prepare');
  }
  assert.equal(ledger.beginStagedPhysicalDispatch({ authority: uploadTransfer.authority }).status, 'inserted');
  const originalFetch = globalThis.fetch;
  let uploadRequestCount = 0;
  let uploadedBytes = Buffer.alloc(0);
  let uploadRedirect: RequestRedirect | undefined;
  let uploadMethod: string | undefined;
  let uploadHeaders: Headers | undefined;
  try {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      uploadRequestCount += 1;
      uploadRedirect = init?.redirect;
      uploadMethod = init?.method;
      uploadHeaders = new Headers(init?.headers);
      const chunks: Buffer[] = [];
      if (init?.body) {
        for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk));
        }
      }
      uploadedBytes = Buffer.concat(chunks);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const uploaded = await staged.executeStagedUploadTransferBody({
      authority: uploadTransfer.authority,
    });
    assert.equal(uploaded.status, 'returned', JSON.stringify(uploaded));
    if (uploaded.status !== 'returned') throw new Error('upload transfer body did not return');
    assert.equal(uploadRequestCount, 1, 'one stage owns exactly one object-store PUT');
    assert.equal(uploadMethod, 'PUT');
    assert.equal(uploadRedirect, 'error');
    assert.equal(uploadHeaders?.get('content-type'), 'application/octet-stream');
    assert.equal(uploadHeaders?.has('x-ms-blob-type'), false, 'S3 upload carries no Azure-only header');
    assert.deepEqual(uploadedBytes, sourceBytes);
    assert.equal(uploaded.byteCount, sourceBytes.byteLength);
    assert.equal(JSON.stringify(uploaded).includes(signedUrl), false);
    assert.equal(JSON.stringify(uploaded).includes(sourcePath), false);
    assert.equal((await staged.executeStagedUploadTransferBody({
      authority: uploadTransfer.authority,
    })).status, 'conflict', 'one opaque upload authority cannot enter a second PUT');
    assert.equal(uploadRequestCount, 1);
    assert.equal(ledger.settleStagedPhysicalDispatch({
      authority: uploadTransfer.authority,
      outcome: 'returned',
      returnCheckpoint: uploaded.checkpoint,
    }).status, 'inserted');
    assert.equal(uploadRequestCount, 1, 'settlement never re-enters the object-store PUT');
  } finally {
    globalThis.fetch = originalFetch;
  }
  eventlog.closeEventLog();
  db = eventlog.openEventLog();
  const postUploadPlan = staged.reopenStagedTransferPlanAuthority({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    parentLogicalToolCallId: fixture.logicalToolCallId,
  });
  assert.equal(postUploadPlan.status, 'ok', JSON.stringify(postUploadPlan));
  if (postUploadPlan.status !== 'ok') throw new Error('post-upload plan did not reopen');
  const businessStage = staged.prepareStagedPhysicalDispatch({
    planAuthority: postUploadPlan.authority,
    stageOrdinal: 4,
    parentDispatchLease: fixture.callLease,
  });
  assert.ok(
    businessStage.status === 'prepared' || businessStage.status === 'replayed',
    JSON.stringify(businessStage),
  );
  const uploadDurableRows = JSON.stringify([
    ...db.prepare(`SELECT * FROM staged_transfer_stages WHERE plan_id = ?`).all(visible.planId),
    ...db.prepare(`SELECT * FROM staged_transfer_stage_receipts WHERE plan_id = ?`).all(visible.planId),
    ...db.prepare(`SELECT * FROM physical_dispatch_return_checkpoints WHERE session_id = ?`)
      .all(fixture.session.id),
  ]);
  assert.equal(uploadDurableRows.includes(signedUrl), false);
  assert.equal(uploadDurableRows.includes(sourcePath), false);
  assert.throws(() => db.prepare(`
    INSERT INTO staged_transfer_blob_owners
      (plan_id, stage_id, blob_sha256, blob_md5, blob_bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    visible.planId,
    visible.stageId,
    body.sha256,
    body.md5,
    body.byteCount,
    new Date().toISOString(),
  ), /clementine_staged_blob_owner_admitted_v1|exact returned stage/,
  'copyable digest rows cannot forge blob ownership');
  assert.equal(staged.commitStagedBlobBodyResult({
    authority: fixture.preparedStage.authority,
    result: body.result,
  }).status, 'replayed');
  assert.equal(staged.commitStagedBlobBodyResult({
    authority: fixture.preparedStage.authority,
    result: body.result,
  }).status, 'replayed');
  assert.deepEqual(db.prepare(`
    SELECT blob_sha256, blob_md5, blob_bytes FROM staged_transfer_blob_owners
     WHERE plan_id = ? AND stage_id = ?
  `).get(visible.planId, visible.stageId), {
    blob_sha256: body.sha256,
    blob_md5: body.md5,
    blob_bytes: body.byteCount,
  });
  const durableRows = JSON.stringify([
    ...db.prepare(`SELECT * FROM staged_transfer_stages WHERE plan_id = ?`).all(visible.planId),
    ...db.prepare(`SELECT * FROM physical_dispatch_return_checkpoints WHERE stage_authority_id = ?`)
      .all(visible.stageAuthorityId),
  ]);
  assert.equal(durableRows.includes(sourcePath), false);
  assert.equal(durableRows.includes(sourceBytes.toString('utf8').trim()), false);
});

test('one non-2xx upload is ambiguous, never retried inline, and cannot replay without reconciliation', async () => {
  const setup = await startedUploadTransfer(
    'upload-transient',
    Buffer.from('one ambiguous upload body\n', 'utf8'),
  );
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  let requestBytes = Buffer.alloc(0);
  try {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestCount += 1;
      const chunks: Buffer[] = [];
      if (init?.body) {
        for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk));
        }
      }
      requestBytes = Buffer.concat(chunks);
      return new Response('transient object-store failure', { status: 503 });
    }) as typeof fetch;
    const result = await staged.executeStagedUploadTransferBody({
      authority: setup.uploadStage.authority,
    });
    assert.deepEqual(result, { status: 'threw', code: 'upload_ambiguous' });
    assert.equal(requestCount, 1, 'one physical attempt never hides a retry');
    assert.deepEqual(requestBytes, setup.sourceBytes);
    assert.equal((await staged.executeStagedUploadTransferBody({
      authority: setup.uploadStage.authority,
    })).status, 'conflict', 'ambiguous body authority is consumed once');
    assert.equal(requestCount, 1);
    assert.equal(ledger.settleStagedPhysicalDispatch({
      authority: setup.uploadStage.authority,
      outcome: 'unknown',
    }).status, 'inserted');
  } finally {
    globalThis.fetch = originalFetch;
  }
  const visible = staged.inspectStagedPhysicalDispatchAuthority(setup.uploadStage.authority)!;
  const db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT physical.state, receipt.terminal_state, receipt.result_digest
      FROM physical_dispatches physical
      JOIN staged_transfer_stage_receipts receipt
        ON receipt.physical_dispatch_id = physical.physical_dispatch_id
     WHERE physical.session_id = ? AND physical.source_user_seq = ?
       AND physical.physical_dispatch_id = ?
  `).get(
    setup.fixture.session.id,
    setup.fixture.source.seq,
    visible.physicalDispatchId,
  ), {
    state: 'unknown',
    terminal_state: 'unknown',
    result_digest: null,
  });
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count FROM physical_dispatch_return_checkpoints
     WHERE stage_authority_id = ?
  `).get(visible.stageAuthorityId) as { count: number }).count, 0);
  eventlog.closeEventLog();
  eventlog.openEventLog();
  const reopened = staged.reopenStagedTransferPlanAuthority({
    sessionId: setup.fixture.session.id,
    sourceUserSeq: setup.fixture.source.seq,
    parentLogicalToolCallId: setup.fixture.logicalToolCallId,
  });
  assert.equal(reopened.status, 'ok', JSON.stringify(reopened));
  if (reopened.status !== 'ok') throw new Error('ambiguous upload plan did not reopen');
  const retry = staged.prepareStagedPhysicalDispatch({
    planAuthority: reopened.authority,
    stageOrdinal: 3,
    parentDispatchLease: setup.fixture.callLease,
  });
  assert.equal(retry.status, 'replayed', JSON.stringify(retry));
  if (retry.status !== 'replayed') throw new Error('unknown attempt did not reopen for forensics');
  assert.equal(retry.physicalDispatchId, visible.physicalDispatchId);
  const retryVisible = staged.inspectStagedPhysicalDispatchAuthority(retry.authority)!;
  assert.equal(retryVisible.retryOfStageAuthorityId, undefined);
  assert.equal((await staged.executeStagedUploadTransferBody({
    authority: retry.authority,
  })).status, 'conflict', 'terminal unknown evidence cannot enter another PUT');
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS count FROM staged_transfer_stage_authorities
     WHERE plan_id = ? AND stage_id = ?
  `).get(visible.planId, visible.stageId) as { count: number }).count, 1,
  'no retry generation is minted without reconciliation');
  const durable = JSON.stringify([
    ...eventlog.openEventLog().prepare(`SELECT * FROM staged_transfer_stage_receipts WHERE plan_id = ?`)
      .all(visible.planId),
    ...eventlog.openEventLog().prepare(`SELECT * FROM physical_dispatches WHERE session_id = ?`)
      .all(setup.fixture.session.id),
  ]);
  assert.equal(durable.includes(setup.signedUrl), false);
  assert.equal(durable.includes(setup.sourcePath), false);
});

test('terminal session retention cascades exact staged authority while live sessions remain', async () => {
  const fixture = await fixtureSupport.createProductionStagedBusinessFixture('terminal-reap');
  const returned = await returnedCheckpoint(fixture, {
    successful: true,
    error: null,
    data: { id: 'file-reap' },
  });
  assert.equal(ledger.settleStagedPhysicalDispatch({
    authority: fixture.preparedStage.authority,
    outcome: 'returned',
    returnCheckpoint: returned.checkpoint,
  }).status, 'inserted');
  eventlog.updateSession(fixture.session.id, { status: 'completed' });
  const db = eventlog.openEventLog();
  db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`)
    .run('2020-01-01T00:00:00.000Z', fixture.session.id);
  assert.equal(eventlog.reapStaleSessions(1), 1);
  assert.equal(eventlog.getSession(fixture.session.id), null);
  for (const table of [
    'staged_transfer_plans',
    'staged_transfer_stages',
    'staged_transfer_stage_authorities',
    'physical_dispatch_return_checkpoints',
    'staged_transfer_stage_receipts',
  ]) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM ${table}
      WHERE session_id = ?`).get(fixture.session.id) as { count: number }).count, 0, `${table} cascades`);
  }
});
