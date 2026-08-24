import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-staged-source-download-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_AUTHORITY_SEAL_KEY = '6'.repeat(64);
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-staged-source-download\n', 'utf8');

const eventlog = await import('./eventlog.js');
const ledger = await import('./dispatch-ledger.js');
const staged = await import('./staged-transfer-authority.js');
const checkpoints = await import('./physical-return-checkpoint.js');
const abortContext = await import('../tool-abort-context.js');
const composio = await import('../../integrations/composio/client.js');
const fixtureSupport = await import('./staged-transfer-production-fixture.js');

test.after(() => {
  composio.__test__.setConnectedAccountsLoader(null);
  composio.__test__.setComposioApiKeyOverride(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('remote upload source owns one private GET, atomic checkpoint/blob owner, and exact restart topology', async () => {
  const sourceUrl = 'https://source.example/private/report.txt?credential=never-plaintext';
  const sourceBytes = Buffer.from('one exact remote upload source\n', 'utf8');
  const fixture = await fixtureSupport.createProductionStagedBusinessFixture('remote-source', {
    uploadSourceUrl: sourceUrl,
  });
  const initialRows = eventlog.openEventLog().prepare(`
    SELECT stage_ordinal, stage_kind
      FROM staged_transfer_stages
     WHERE plan_id = ?
     ORDER BY stage_ordinal
  `).all(fixture.preparedPlan.planId) as Array<{ stage_ordinal: number; stage_kind: string }>;
  assert.deepEqual(initialRows, [
    { stage_ordinal: 1, stage_kind: 'source_download' },
    { stage_ordinal: 2, stage_kind: 'local_snapshot' },
    { stage_ordinal: 3, stage_kind: 'upload_presign' },
    { stage_ordinal: 4, stage_kind: 'upload_transfer' },
    { stage_ordinal: 5, stage_kind: 'business_execute' },
  ]);

  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  let putCount = 0;
  let uploadedBytes = Buffer.alloc(0);
  let observedUrl = '';
  let observedInit: RequestInit | undefined;
  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCount += 1;
      if (init?.method === 'GET') {
        observedUrl = String(url);
        observedInit = init;
        return new Response(sourceBytes, { status: 200 });
      }
      if (init?.method === 'PUT') {
        putCount += 1;
        const chunks: Buffer[] = [];
        for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk));
        }
        uploadedBytes = Buffer.concat(chunks);
        return new Response(null, { status: 200 });
      }
      throw new Error('unexpected staged source fixture request');
    }) as typeof fetch;
    const abortController = new AbortController();
    const downloaded = await abortContext.runWithToolAbortSignal(
      abortController.signal,
      () => staged.executeStagedSourceDownloadBody({
        authority: fixture.preparedStage.authority,
      }),
    );
    assert.equal(downloaded.status, 'returned', JSON.stringify(downloaded));
    if (downloaded.status !== 'returned') throw new Error('source download did not return');
    assert.equal(fetchCount, 1);
    assert.equal(observedUrl, sourceUrl);
    assert.equal(observedInit?.method, 'GET');
    assert.equal(observedInit?.redirect, 'error');
    assert.equal(observedInit?.signal, abortController.signal);
    assert.equal(downloaded.byteCount, sourceBytes.byteLength);
    assert.equal('blobPath' in downloaded, false);
    assert.equal('url' in downloaded, false);
    assert.equal(JSON.stringify(downloaded).includes(sourceUrl), false);
    assert.equal((await staged.executeStagedSourceDownloadBody({
      authority: fixture.preparedStage.authority,
    })).status, 'conflict');
    assert.equal(fetchCount, 1, 'one physical source body never performs a hidden retry');

    assert.equal(ledger.settleStagedPhysicalDispatch({
      authority: fixture.preparedStage.authority,
      outcome: 'returned',
      returnCheckpoint: downloaded.checkpoint,
    }).status, 'inserted');
    const identity = staged.inspectStagedPhysicalDispatchAuthority(fixture.preparedStage.authority);
    assert.ok(identity);
    assert.deepEqual(eventlog.openEventLog().prepare(`
      SELECT blob_sha256, blob_md5, blob_bytes
        FROM staged_transfer_blob_owners
       WHERE plan_id = ? AND stage_id = ?
    `).get(identity!.planId, identity!.stageId), {
      blob_sha256: downloaded.sha256,
      blob_md5: downloaded.md5,
      blob_bytes: downloaded.byteCount,
    });
    assert.equal(staged.commitStagedBlobBodyResult({
      authority: fixture.preparedStage.authority,
      result: downloaded.result,
    }).status, 'replayed');
    const durable = JSON.stringify({
      stages: eventlog.openEventLog().prepare(`
        SELECT * FROM staged_transfer_stages WHERE plan_id = ?
      `).all(identity!.planId),
      physical: eventlog.openEventLog().prepare(`
        SELECT * FROM physical_dispatches WHERE physical_dispatch_id = ?
      `).all(identity!.physicalDispatchId),
      checkpoint: eventlog.openEventLog().prepare(`
        SELECT * FROM physical_dispatch_return_checkpoints WHERE stage_authority_id = ?
      `).all(identity!.stageAuthorityId),
      owner: eventlog.openEventLog().prepare(`
        SELECT * FROM staged_transfer_blob_owners WHERE plan_id = ? AND stage_id = ?
      `).all(identity!.planId, identity!.stageId),
    });
    assert.equal(durable.includes(sourceUrl), false);
    assert.equal(durable.includes('never-plaintext'), false);
    assert.equal(durable.includes(TMP_HOME), false);

    eventlog.closeEventLog();
    eventlog.openEventLog();
    const reopenedPlan = staged.reopenStagedTransferPlanAuthority({
      sessionId: fixture.session.id,
      sourceUserSeq: fixture.source.seq,
      parentLogicalToolCallId: fixture.logicalToolCallId,
    });
    assert.equal(reopenedPlan.status, 'ok', JSON.stringify(reopenedPlan));
    if (reopenedPlan.status !== 'ok') throw new Error('remote-source plan did not reopen');
    const reopenedDownload = staged.reopenStagedPhysicalDispatchAuthority({
      planAuthority: reopenedPlan.authority,
      stageOrdinal: 1,
    });
    assert.equal(reopenedDownload.status, 'replayed', JSON.stringify(reopenedDownload));
    if (reopenedDownload.status !== 'replayed') throw new Error('source attempt did not reopen');
    assert.equal(checkpoints.recoverCommittedStagedPhysicalReturn({
      authority: reopenedDownload.authority,
    }).status, 'committed');

    const snapshotStage = staged.prepareStagedPhysicalDispatch({
      planAuthority: reopenedPlan.authority,
      stageOrdinal: 2,
      parentDispatchLease: fixture.callLease,
    });
    assert.ok(snapshotStage.status === 'prepared' || snapshotStage.status === 'replayed', JSON.stringify(snapshotStage));
    if (snapshotStage.status !== 'prepared' && snapshotStage.status !== 'replayed') {
      throw new Error('remote-source snapshot did not prepare');
    }
    assert.equal(ledger.beginStagedPhysicalDispatch({ authority: snapshotStage.authority }).status, 'inserted');
    const snapshot = staged.executeStagedLocalSnapshotBody({ authority: snapshotStage.authority });
    assert.equal(snapshot.status, 'returned', JSON.stringify(snapshot));
    if (snapshot.status !== 'returned') throw new Error('remote-source snapshot did not return');
    assert.deepEqual({ sha256: snapshot.sha256, md5: snapshot.md5, byteCount: snapshot.byteCount }, {
      sha256: downloaded.sha256,
      md5: downloaded.md5,
      byteCount: downloaded.byteCount,
    });
    assert.equal(fetchCount, 1, 'snapshot consumes the owned blob without a second network request');
    const snapshotCheckpoint = checkpoints.prepareStagedBlobBodyReturnCheckpoint({
      authority: snapshotStage.authority,
      result: snapshot.result,
      sha256: snapshot.sha256,
      md5: snapshot.md5,
      byteCount: snapshot.byteCount,
      bodyDigest: snapshot.bodyDigest,
      resultDigest: snapshot.resultDigest,
    });
    assert.equal(snapshotCheckpoint.status, 'prepared', JSON.stringify(snapshotCheckpoint));
    if (snapshotCheckpoint.status !== 'prepared') throw new Error('remote-source snapshot checkpoint refused');
    assert.equal(ledger.settleStagedPhysicalDispatch({
      authority: snapshotStage.authority,
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
    if (afterSnapshot.status !== 'ok') throw new Error('post-snapshot remote plan did not reopen');
    const presignStage = staged.prepareStagedPhysicalDispatch({
      planAuthority: afterSnapshot.authority,
      stageOrdinal: 3,
      parentDispatchLease: fixture.callLease,
    });
    assert.ok(presignStage.status === 'prepared' || presignStage.status === 'replayed', JSON.stringify(presignStage));
    if (presignStage.status !== 'prepared' && presignStage.status !== 'replayed') {
      throw new Error('remote-source presign did not prepare');
    }
    assert.equal(ledger.beginStagedPhysicalDispatch({ authority: presignStage.authority }).status, 'inserted');
    composio.__test__.setComposioApiKeyOverride('test-api-key');
    const signedUrl = 'https://storage.example/private/report.txt?token=never-plaintext';
    const signedKey = 'staged/private/report.txt';
    let presignCount = 0;
    let businessCount = 0;
    let businessSlug = '';
    let businessBody: Record<string, unknown> | null = null;
    composio.__test__.setComposioClient({
      getClient: () => ({
        withOptions: () => ({
          files: {
            createPresignedURL: async () => {
              presignCount += 1;
              return {
                key: signedKey,
                new_presigned_url: signedUrl,
                metadata: { storage_backend: 's3' },
              };
            },
          },
          tools: {
            execute: async (slug: string, body: Record<string, unknown>) => {
              businessCount += 1;
              businessSlug = slug;
              businessBody = structuredClone(body);
              return { successful: true, error: null, data: { id: 'remote-uploaded' } };
            },
          },
        }),
      }),
    });
    const presign = staged.prepareStagedComposioPresignBody({ authority: presignStage.authority });
    assert.ok(presign.status === 'prepared' || presign.status === 'replayed', JSON.stringify(presign));
    if (presign.status !== 'prepared' && presign.status !== 'replayed') throw new Error('presign body did not prepare');
    assert.equal(fetchCount, 1, 'advancing to presign does not re-enter the remote source body');
    const presignReturned = await checkpoints.executeStagedPreparedComposioPresignBody({
      authority: presignStage.authority,
      preparedPresign: presign.preparedPresign,
    });
    assert.equal(presignReturned.status, 'returned', JSON.stringify(presignReturned));
    if (presignReturned.status !== 'returned') throw new Error('remote-source presign did not return');
    assert.equal(presignCount, 1);
    assert.equal(JSON.stringify(presignReturned).includes(signedUrl), false);
    assert.equal(ledger.settleStagedPhysicalDispatch({
      authority: presignStage.authority,
      outcome: 'returned',
      returnCheckpoint: presignReturned.checkpoint,
    }).status, 'inserted');

    eventlog.closeEventLog();
    eventlog.openEventLog();
    const afterPresign = staged.reopenStagedTransferPlanAuthority({
      sessionId: fixture.session.id,
      sourceUserSeq: fixture.source.seq,
      parentLogicalToolCallId: fixture.logicalToolCallId,
    });
    assert.equal(afterPresign.status, 'ok', JSON.stringify(afterPresign));
    if (afterPresign.status !== 'ok') throw new Error('post-presign remote plan did not reopen');
    const uploadStage = staged.prepareStagedPhysicalDispatch({
      planAuthority: afterPresign.authority,
      stageOrdinal: 4,
      parentDispatchLease: fixture.callLease,
    });
    assert.ok(uploadStage.status === 'prepared' || uploadStage.status === 'replayed', JSON.stringify(uploadStage));
    if (uploadStage.status !== 'prepared' && uploadStage.status !== 'replayed') {
      throw new Error('remote-source upload did not prepare');
    }
    assert.equal(ledger.beginStagedPhysicalDispatch({ authority: uploadStage.authority }).status, 'inserted');
    const uploaded = await staged.executeStagedUploadTransferBody({ authority: uploadStage.authority });
    assert.equal(uploaded.status, 'returned', JSON.stringify(uploaded));
    if (uploaded.status !== 'returned') throw new Error('remote-source upload did not return');
    assert.equal(putCount, 1);
    assert.deepEqual(uploadedBytes, sourceBytes);
    assert.equal(ledger.settleStagedPhysicalDispatch({
      authority: uploadStage.authority,
      outcome: 'returned',
      returnCheckpoint: uploaded.checkpoint,
    }).status, 'inserted');

    eventlog.closeEventLog();
    eventlog.openEventLog();
    const afterUpload = staged.reopenStagedTransferPlanAuthority({
      sessionId: fixture.session.id,
      sourceUserSeq: fixture.source.seq,
      parentLogicalToolCallId: fixture.logicalToolCallId,
    });
    assert.equal(afterUpload.status, 'ok', JSON.stringify(afterUpload));
    if (afterUpload.status !== 'ok') throw new Error('post-upload remote plan did not reopen');
    const businessStage = staged.prepareStagedPhysicalDispatch({
      planAuthority: afterUpload.authority,
      stageOrdinal: 5,
      parentDispatchLease: fixture.callLease,
    });
    assert.ok(businessStage.status === 'prepared' || businessStage.status === 'replayed', JSON.stringify(businessStage));
    if (businessStage.status !== 'prepared' && businessStage.status !== 'replayed') {
      throw new Error('remote-source business did not prepare');
    }
    assert.equal(ledger.beginStagedPhysicalDispatch({ authority: businessStage.authority }).status, 'inserted');
    const business = staged.prepareStagedComposioBusinessBody({ authority: businessStage.authority });
    assert.equal(business.status, 'prepared', JSON.stringify(business));
    if (business.status !== 'prepared') throw new Error('business one-shot did not prepare');
    const businessReplay = staged.prepareStagedComposioBusinessBody({ authority: businessStage.authority });
    assert.equal(businessReplay.status, 'replayed', JSON.stringify(businessReplay));
    if (businessReplay.status !== 'replayed') throw new Error('business one-shot did not replay');
    assert.equal(businessReplay.preparedDispatch, business.preparedDispatch);
    assert.equal(JSON.stringify(business), '{"status":"prepared","preparedDispatch":{}}');
    assert.equal(JSON.stringify(business).includes(signedKey), false);
    assert.equal(JSON.stringify(business).includes(sourceUrl), false);
    const businessReturned = await checkpoints.executeStagedPreparedComposioBody({
      authority: businessStage.authority,
      preparedDispatch: business.preparedDispatch,
    });
    assert.equal(businessReturned.status, 'returned', JSON.stringify(businessReturned));
    assert.equal(businessCount, 1);
    assert.equal(businessSlug, fixture.operationId);
    assert.deepEqual(businessBody, {
      arguments: {
        folder_id: 'root',
        file: {
          name: 'report.txt',
          mimetype: 'application/octet-stream',
          s3key: signedKey,
        },
      },
      user_id: `owner-drive-fixture-${fixture.session.id.match(/^staged-production-(\d+)-/)?.[1]}`,
      version: fixture.operationVersion,
      connected_account_id: fixture.accountId,
    });
    assert.equal(staged.prepareStagedComposioBusinessBody({
      authority: businessStage.authority,
    }).status, 'conflict', 'consumed business one-shot cannot be reminted');
    assert.equal(businessCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('loopback, private, and link-local remote origins are refused before fetch', async () => {
  const refusedOrigins = [
    'https://127.0.0.1/private',
    'https://2130706433/private',
    'https://10.0.0.1/private',
    'https://172.16.0.1/private',
    'https://192.168.1.1/private',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/private',
    'https://subdomain.localhost/private',
    'https://[::1]/private',
    'https://[::ffff:127.0.0.1]/private',
    'https://[fd00::1]/private',
    'https://[fe80::1]/private',
  ];
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error('private origin crossed into fetch');
    }) as typeof fetch;
    for (const [index, uploadSourceUrl] of refusedOrigins.entries()) {
      const fixture = await fixtureSupport.createProductionStagedBusinessFixture(`private-source-${index}`, {
        uploadSourceUrl,
      });
      assert.deepEqual(await staged.executeStagedSourceDownloadBody({
        authority: fixture.preparedStage.authority,
      }), {
        status: 'preparation_required',
        reason: 'remote upload sources require a public HTTPS origin',
      });
    }
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('remote source failure is one request and yields no checkpoint or blob owner', async () => {
  const sourceUrl = 'https://source.example/private/unavailable.bin?credential=never-plaintext';
  const fixture = await fixtureSupport.createProductionStagedBusinessFixture('remote-source-failure', {
    uploadSourceUrl: sourceUrl,
  });
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response('transient source failure', { status: 503 });
    }) as typeof fetch;
    assert.deepEqual(await staged.executeStagedSourceDownloadBody({
      authority: fixture.preparedStage.authority,
    }), { status: 'threw', code: 'source_unavailable' });
    assert.equal((await staged.executeStagedSourceDownloadBody({
      authority: fixture.preparedStage.authority,
    })).status, 'conflict');
    assert.equal(fetchCount, 1);
    assert.equal(ledger.settleStagedPhysicalDispatch({
      authority: fixture.preparedStage.authority,
      outcome: 'threw',
    }).status, 'inserted');
    const identity = staged.inspectStagedPhysicalDispatchAuthority(fixture.preparedStage.authority)!;
    assert.equal((eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS count FROM physical_dispatch_return_checkpoints
       WHERE stage_authority_id = ?
    `).get(identity.stageAuthorityId) as { count: number }).count, 0);
    assert.equal((eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS count FROM staged_transfer_blob_owners
       WHERE plan_id = ? AND stage_id = ?
    `).get(identity.planId, identity.stageId) as { count: number }).count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
