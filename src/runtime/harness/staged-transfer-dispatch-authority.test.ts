import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-staged-dispatch-v62-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_AUTHORITY_SEAL_KEY = '8'.repeat(64);
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-staged-dispatch-v62\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const expectedContracts = await import('./expected-work-contract.js');
const expectedAdmission = await import('./expected-work-admission.js');
const callAuthority = await import('./accepted-turn-call-authority.js');
const hostBindings = await import('./host-call-capability-binding.js');
const capabilityManifests = await import('./capability-manifest.js');
const capabilityManifestStore = await import('./capability-manifest-store.js');
const identities = await import('./attempt-identity.js');
const ledger = await import('./dispatch-ledger.js');
const logicalContracts = await import('./logical-call-contract.js');
const nested = await import('./nested-tool-approval-admission.js');
const staged = await import('./staged-transfer-authority.js');
const checkpoints = await import('./physical-return-checkpoint.js');
const leases = await import('./dispatch-lease.js');
const schemas = await import('../../tools/composio-schema-cache.js');
const composio = await import('../../integrations/composio/client.js');
const providerIdentity = await import('../../integrations/composio/provider-definition-identity.js');
const toolContracts = await import('../../tools/tool-contract-store.js');

test.after(() => {
  composio.__test__.setConnectedAccountsLoader(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

let serial = 0;

async function createPlan(label: string) {
  const n = ++serial;
  const session = eventlog.createSession({ id: `staged-v62-${n}-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Upload this prepared report to my Google Drive.' },
  });
  const catalogRevisionDigest = sha256(`catalog:${session.id}`);
  const bindingRevisionDigest = sha256(`binding:${session.id}`);
  const root = callAuthority.armHostCallAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    catalogRevisionDigest,
    bindingRevisionDigest,
    maxLogicalCalls: 32,
    maxParallelCalls: 8,
  });
  assert.equal(root.status, 'armed', JSON.stringify(root));
  const graphEvent = shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  });
  assert.ok(graphEvent);
  const graph = graphEvent.data.graph as import('../graph/turn-graph-ir.js').TurnGraphIR;
  const frozen = expectedContracts.freezeActionExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    graph,
    proposal: {
      version: 1,
      operations: [{
        id: 'upload_report',
        effect: 'external_write',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
  });
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
  const activated = expectedAdmission.activateActionExpectedWork({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));

  const acceptedTaskId = identities.acceptedTaskIdFor(session.id, source.seq);
  const logicalToolCallId = `logical:staged:${n}`;
  const operationId = 'GOOGLEDRIVE_UPLOAD_FILE';
  const operationVersion = `20260824_${String(n).padStart(2, '0')}`;
  const accountId = `connection-drive-${n}`;
  const ownerUserId = `owner-drive-${n}`;
  const invokePortId = 'composio:execute-one-shot';
  const args = { folder_id: 'root' };
  const inputSchema = {
    type: 'object',
    properties: {
      folder_id: { type: 'string' },
    },
    required: ['folder_id'],
    additionalProperties: false,
  };
  const outputSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      file: {
        type: 'object',
        file_downloadable: true,
        properties: {
          s3url: { type: 'string' },
          mimetype: { type: 'string' },
        },
        required: ['s3url'],
      },
      secondary_file: {
        type: 'object',
        file_downloadable: true,
        properties: {
          s3url: { type: 'string' },
          mimetype: { type: 'string' },
        },
        required: ['s3url'],
      },
    },
    required: ['id'],
    additionalProperties: false,
  };
  const observedAt = Date.now();
  schemas.rememberToolSchema(operationId, inputSchema, observedAt, operationVersion, outputSchema);
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: accountId,
    status: 'ACTIVE',
    user_id: ownerUserId,
    toolkit: { slug: 'googledrive' },
  }]);
  const connected = await composio.listConnectedToolkits({ requireFresh: true });
  assert.equal(connected.length, 1);
  assert.equal(connected[0]?.connectionId, accountId);

  const inputDigest = toolContracts.digestSchema(inputSchema);
  const outputDigest = toolContracts.digestSchema(outputSchema);
  const definitionFingerprint = providerIdentity.fingerprintComposioProviderDefinition({
    operationId,
    operationVersion,
    accountId,
    invokePortId,
    inputSchema,
    outputSchema,
  });
  assert.ok(definitionFingerprint);
  const hostManifest: import('./capability-manifest.js').CapabilityManifestV1 = {
    version: 1,
    manifestId: `manifest:composio:googledrive:${session.id}`,
    providerKind: 'composio',
    operationId,
    providerIdentity: 'composio-sdk',
    providerVersion: providerIdentity.COMPOSIO_PROVIDER_SURFACE_VERSION,
    operationVersion,
    definitionFingerprint: definitionFingerprint!,
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: inputDigest,
      providerOutputSchemaObserved: true,
      providerOutputSchemaDigest: outputDigest,
      semanticName: 'Upload file to Google Drive',
      behaviorHints: {
        readOnly: false,
        destructive: false,
        idempotent: null,
        openWorld: false,
      },
    },
    effect: 'external_write',
    accountId,
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'json' },
    purpose: 'Upload the prepared report to the selected Drive account.',
    acceptedInputKinds: ['file'],
    producedOutputKinds: ['provider_receipt'],
    applicableDeliverableKinds: ['file'],
    evidenceContract: { kinds: ['receipt'], readbackRequired: false },
    provenance: { issuer: 'staged-v62-test', issuedAt: new Date().toISOString(), trusted: true },
    lifecycle: { state: 'current' },
    argumentCompiler: { id: `compiler:${operationId}`, version: operationVersion },
    invokePortId,
    reconcilePortId: 'composio:reconcile-upload',
  };
  const installed = capabilityManifestStore.createCapabilityManifestStore([], { durable: true })
    .install(hostManifest);
  assert.equal(installed.ok, true, JSON.stringify(installed));
  if (!installed.ok) throw new Error('manifest install refused');
  assert.equal(installed.digest, capabilityManifests.capabilityManifestDigest(hostManifest));

  const contract = logicalContracts.durableLogicalCallContract(acceptedTaskId, operationId, args);
  assert.ok(contract);
  const rootState = callAuthority.acceptedTurnCallAuthorityFor(session.id, source.seq);
  assert.equal(rootState.status, 'ok');
  if (rootState.status !== 'ok') throw new Error(rootState.reason);
  const attestationBase = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    sourceEventId: rootState.authority.sourceEventId,
    sourceEventDigest: rootState.authority.sourceEventDigest,
    logicalToolCallId,
    toolName: contract!.toolName,
    argumentDigest: contract!.argumentDigest,
    effect: 'external_write' as const,
    bindingKind: 'catalog_manifest' as const,
    capabilityId: `composio:googledrive:upload-file:${n}`,
    providerInputSchemaDigest: inputDigest,
    schemaFingerprint: definitionFingerprint!,
    accountId,
    invokePortId,
    operationId,
    manifestId: hostManifest.manifestId,
    manifestDigest: installed.digest,
    engineVersion: rootState.authority.engineVersion,
    surfaceVersion: rootState.authority.surfaceVersion,
    authorityDigest: rootState.authority.authorityDigest,
    authorityRevision: rootState.authority.revision,
    surfaceDigest: rootState.authority.surfaceDigest,
    catalogRevisionDigest,
    bindingRevisionDigest,
  };
  const attestation = {
    ...attestationBase,
    bindingDigest: hostBindings.hostCallAttestationBindingDigest(attestationBase),
  };
  const logical = callAuthority.withHostCallAttestation(attestation, () => ledger.admitLogicalCall({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, acceptedTaskId, logicalToolCallId },
    tool: operationId,
    args,
  }));
  assert.equal(logical.status, 'inserted', JSON.stringify(logical));
  const work = expectedAdmission.admitExpectedWorkInvocation({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    logicalToolCallId,
    requirementId: 'upload_report',
    tool: operationId,
    args,
  });
  assert.ok(work.status === 'bound' || work.status === 'replayed', JSON.stringify(work));
  if (work.status !== 'bound' && work.status !== 'replayed') throw new Error('work binding refused');
  const host = callAuthority.withHostCallAttestation(attestation, () =>
    hostBindings.persistHostCallCapabilityBinding({
      db: eventlog.openEventLog(),
      attestation: callAuthority.currentHostCallAttestation(),
      sessionId: session.id,
      sourceUserSeq: source.seq,
      logicalToolCallId,
      acceptedTaskId,
      toolName: contract!.toolName,
      argumentDigest: contract!.argumentDigest,
      effect: 'external_write',
    }));
  assert.ok(host.status === 'bound' || host.status === 'replayed', JSON.stringify(host));
  if (host.status !== 'bound' && host.status !== 'replayed') throw new Error('host binding refused');

  const nestedAdmission = nested.issueNestedCallAdmission({
    hostCapabilityBinding: host.binding,
    workBinding: work.binding,
    targetName: operationId,
    targetArgs: args,
    effect: 'external_write',
    authorityDigest: rootState.authority.authorityDigest,
    consentBasis: 'exact_ordinary_work',
  });
  assert.ok(nestedAdmission);
  const preparedPlan = await callAuthority.withHostCallAttestation(attestation, () =>
    identities.withLogicalToolCall({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      tool: operationId,
      args,
      logicalToolCallId,
    }, async () => nested.withNestedCallAdmission(nestedAdmission!, async () => {
      assert.equal(nested.consumeNestedCallAdmission({
        sessionId: session.id,
        toolName: operationId,
        args,
      }), true);
      const parentAdmission = nested.issueStagedParentCallAdmission({
        sessionId: session.id,
        toolName: operationId,
        args,
      });
      assert.ok(parentAdmission);
      return staged.prepareStagedTransferPlan({ parentAdmission: parentAdmission!, providerArgs: args });
    })));
  assert.ok(preparedPlan.status === 'prepared' || preparedPlan.status === 'replayed', JSON.stringify(preparedPlan));
  if (preparedPlan.status !== 'prepared' && preparedPlan.status !== 'replayed') {
    throw new Error('staged plan refused');
  }
  const recovery = logicalContracts.durableLogicalCallRecoveryMaterial(acceptedTaskId, operationId, args);
  assert.ok(recovery);
  const parentLease = leases.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::parent`,
  });
  const callLease = leases.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::business`,
    parentLease,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    logicalToolCallId,
    recovery: {
      effect: 'external_write',
      businessCall: true,
      material: recovery!,
      turn: 1,
    },
  });
  return {
    session,
    source,
    acceptedTaskId,
    logicalToolCallId,
    operationId,
    operationVersion,
    accountId,
    args,
    outputSchema,
    callLease,
    preparedPlan,
  };
}

test('opaque staged authority is the sole physical owner and returned checkpoint commits one receipt', async () => {
  const fixture = await createPlan('returned');
  const prepared = staged.prepareStagedPhysicalDispatch({
    planAuthority: fixture.preparedPlan.authority,
    stageOrdinal: 1,
    parentDispatchLease: fixture.callLease,
  });
  assert.ok(prepared.status === 'prepared' || prepared.status === 'replayed', JSON.stringify(prepared));
  if (prepared.status !== 'prepared' && prepared.status !== 'replayed') throw new Error('stage refused');
  const visible = staged.inspectStagedPhysicalDispatchAuthority(prepared.authority);
  assert.ok(visible);

  const forged = ledger.beginPhysicalDispatch({
    identity: {
      sessionId: visible!.sessionId,
      sourceUserSeq: visible!.sourceUserSeq,
      acceptedTaskId: visible!.acceptedTaskId,
      logicalToolCallId: visible!.logicalToolCallId,
      physicalDispatchId: visible!.physicalDispatchId,
      ordinal: 1,
    },
    tool: visible!.toolName,
    relation: 'primary',
    dispatchLease: visible!.lease,
  });
  assert.equal(forged.status, 'conflict', JSON.stringify(forged));
  assert.equal((eventlog.openEventLog().prepare(`SELECT COUNT(*) AS n FROM physical_dispatches
    WHERE session_id = ? AND source_user_seq = ?`).get(
      fixture.session.id,
      fixture.source.seq,
    ) as { n: number }).n, 0);

  const started = ledger.beginStagedPhysicalDispatch({ authority: prepared.authority });
  assert.equal(started.status, 'inserted', JSON.stringify(started));
  let bodyCount = 0;
  composio.__test__.setComposioApiKeyOverride('test-api-key');
  composio.__test__.setComposioClient({
    getClient: () => ({
      withOptions: () => ({
        tools: {
          execute: async () => {
            bodyCount += 1;
            return {
              successful: true,
              error: null,
              // Provider-envelope metadata is outside the exact operation
              // output schema and must never become download authority.
              s3url: 'https://objects.example/top-level-adversarial?credential=never-authorized',
              data: {
                id: 'file-1',
                file: {
                  s3url: 'https://objects.example/private?credential=never-plaintext',
                  mimetype: 'application/pdf',
                },
                secondary_file: {
                  s3url: 'https://objects.example/secondary?credential=also-never-plaintext',
                  mimetype: 'text/plain',
                },
              },
            };
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
  const returned = await checkpoints.executeStagedPreparedComposioBody({
    authority: prepared.authority,
    preparedDispatch: oneShot,
  });
  assert.equal(returned.status, 'returned', JSON.stringify(returned));
  if (returned.status !== 'returned') throw new Error('body did not return');
  assert.equal(bodyCount, 1);
  assert.equal(ledger.settleStagedPhysicalDispatch({
    authority: prepared.authority,
    outcome: 'returned',
    returnCheckpoint: returned.checkpoint,
  }).status, 'inserted');
  assert.equal(ledger.beginStagedPhysicalDispatch({ authority: prepared.authority }).status, 'replayed');
  const secondOneShot = composio.prepareComposioOneShotDispatch({
    toolSlug: fixture.operationId,
    args: fixture.args,
    connectedAccountId: fixture.accountId,
    providerOperationVersion: fixture.operationVersion,
  });
  assert.equal((await checkpoints.executeStagedPreparedComposioBody({
    authority: prepared.authority,
    preparedDispatch: secondOneShot,
  })).status, 'conflict');
  assert.equal(bodyCount, 1);

  const row = eventlog.openEventLog().prepare(`
    SELECT physical.state, physical.staged_authority_digest,
           COUNT(receipt.stage_authority_id) AS receipts
      FROM physical_dispatches physical
      LEFT JOIN staged_transfer_stage_receipts receipt
        ON receipt.physical_dispatch_id = physical.physical_dispatch_id
     WHERE physical.session_id = ? AND physical.source_user_seq = ?
     GROUP BY physical.physical_dispatch_id
  `).get(fixture.session.id, fixture.source.seq) as {
    state: string;
    staged_authority_digest: string;
    receipts: number;
  };
  assert.equal(row.state, 'returned');
  assert.equal(row.staged_authority_digest, visible!.authorityDigest);
  assert.equal(row.receipts, 1);
  assert.equal((eventlog.openEventLog().prepare(`SELECT COUNT(*) AS n FROM logical_call_settlements
    WHERE session_id = ? AND source_user_seq = ?`).get(
      fixture.session.id,
      fixture.source.seq,
    ) as { n: number }).n, 0, 'physical checkpoint never mints logical success');
  const recovered = checkpoints.recoverCommittedStagedPhysicalReturn({ authority: prepared.authority });
  assert.equal(recovered.status, 'committed', JSON.stringify(recovered));
  if (recovered.status !== 'committed') throw new Error('return did not reopen');
  const downloads = checkpoints.planCommittedComposioDownloads({
    returned: recovered.returned,
    outputSchema: fixture.outputSchema,
  });
  assert.equal(downloads.status, 'planned', JSON.stringify(downloads));
  if (downloads.status !== 'planned') throw new Error('download did not plan');
  assert.deepEqual(downloads.nodes, [
    { pointer: '/file', annotation: 'file_downloadable' },
    { pointer: '/secondary_file', annotation: 'file_downloadable' },
  ]);
  const businessReceipt = eventlog.openEventLog().prepare(`
    SELECT result_digest FROM staged_transfer_stage_receipts
     WHERE stage_authority_id = ?
  `).get(visible!.stageAuthorityId) as { result_digest: string };
  assert.throws(() => eventlog.openEventLog().prepare(`
    INSERT INTO staged_transfer_download_topology_receipts
      (plan_id, business_stage_authority_id, business_result_digest,
       topology_digest, successor_stage_count, recorded_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(
    fixture.preparedPlan.planId,
    visible!.stageAuthorityId,
    businessReceipt.result_digest,
    '0'.repeat(64),
    new Date().toISOString(),
  ), /clementine_staged_topology_admitted_v1|exact business projection/,
  'copyable rows cannot skip a download-bearing result with a forged empty topology');
  const successors = staged.prepareStagedDownloadSuccessors({
    planAuthority: fixture.preparedPlan.authority,
  });
  assert.ok(successors.status === 'prepared' || successors.status === 'replayed', JSON.stringify(successors));
  if (successors.status !== 'prepared' && successors.status !== 'replayed') {
    throw new Error('download successor topology did not commit');
  }
  assert.equal(successors.stageIds.length, 4);
  const topologyRows = eventlog.openEventLog().prepare(`
    SELECT stage_kind, stage_ordinal, depends_on_stage_ordinal
      FROM staged_transfer_stages
     WHERE plan_id = ? AND stage_kind IN ('download_transfer','local_commit')
     ORDER BY stage_ordinal
  `).all(successors.planId);
  assert.deepEqual(topologyRows.map((row: any) => row.stage_kind), [
    'download_transfer', 'local_commit', 'download_transfer', 'local_commit',
  ]);
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT successor_stage_count FROM staged_transfer_download_topology_receipts
     WHERE plan_id = ?
  `).get(successors.planId) as { successor_stage_count: number }).successor_stage_count, 4);

  const downloadStage = staged.prepareStagedPhysicalDispatch({
    planAuthority: successors.authority,
    stageOrdinal: 2,
    parentDispatchLease: fixture.callLease,
  });
  assert.ok(downloadStage.status === 'prepared' || downloadStage.status === 'replayed', JSON.stringify(downloadStage));
  if (downloadStage.status !== 'prepared' && downloadStage.status !== 'replayed') {
    throw new Error('download stage did not prepare');
  }
  assert.equal(ledger.beginStagedPhysicalDispatch({ authority: downloadStage.authority }).status, 'inserted');
  const downloadCarrier = staged.prepareStagedDownloadBodyCarrier({ authority: downloadStage.authority });
  assert.ok(downloadCarrier.status === 'prepared' || downloadCarrier.status === 'replayed', JSON.stringify(downloadCarrier));
  if (downloadCarrier.status !== 'prepared' && downloadCarrier.status !== 'replayed') {
    throw new Error('download body carrier did not prepare');
  }
  const originalFetch = globalThis.fetch;
  const downloadedBytes = Buffer.from('one exact downloaded body\n', 'utf8');
  let fetchCount = 0;
  let observedRedirect: RequestRedirect | undefined;
  try {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCount += 1;
      observedRedirect = init?.redirect;
      return new Response(downloadedBytes, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }) as typeof fetch;
    const downloaded = await checkpoints.executeCommittedComposioDownloadBody({
      authority: downloadStage.authority,
      carrier: downloadCarrier.carrier,
    });
    assert.equal(downloaded.status, 'returned', JSON.stringify(downloaded));
    if (downloaded.status !== 'returned') throw new Error('download body did not return');
    assert.equal(fetchCount, 1, 'download body owns one exact provider request');
    assert.equal(observedRedirect, 'error');
    assert.equal(downloaded.byteCount, downloadedBytes.byteLength);
    assert.equal('blobPath' in downloaded, false);
    assert.equal(JSON.stringify(downloaded).includes('objects.example'), false);
    assert.equal((await checkpoints.executeCommittedComposioDownloadBody({
      authority: downloadStage.authority,
      carrier: downloadCarrier.carrier,
    })).status, 'conflict', 'opaque body carrier is consumed exactly once');
    assert.equal(fetchCount, 1);
    assert.equal(ledger.settleStagedPhysicalDispatch({
      authority: downloadStage.authority,
      outcome: 'returned',
      returnCheckpoint: downloaded.checkpoint,
    }).status, 'inserted');
    const downloadIdentity = staged.inspectStagedPhysicalDispatchAuthority(downloadStage.authority)!;
    assert.deepEqual(eventlog.openEventLog().prepare(`
      SELECT blob_sha256, blob_md5, blob_bytes
        FROM staged_transfer_blob_owners
       WHERE plan_id = ? AND stage_id = ?
    `).get(downloadIdentity.planId, downloadIdentity.stageId), {
      blob_sha256: downloaded.sha256,
      blob_md5: downloaded.md5,
      blob_bytes: downloaded.byteCount,
    }, 'download physical + checkpoint + receipt + blob owner commit atomically');
    assert.equal(staged.commitStagedDownloadBlobOwner({
      authority: downloadStage.authority,
      blob: downloaded.blob,
      sha256: downloaded.sha256,
      md5: downloaded.md5,
      byteCount: downloaded.byteCount,
      bodyDigest: downloaded.bodyDigest,
      resultDigest: downloaded.resultDigest,
    }).status, 'replayed');
    eventlog.closeEventLog();
    eventlog.openEventLog();
    const downloadReopenedPlan = staged.reopenStagedTransferPlanAuthority({
      sessionId: fixture.session.id,
      sourceUserSeq: fixture.source.seq,
      parentLogicalToolCallId: fixture.logicalToolCallId,
    });
    assert.equal(downloadReopenedPlan.status, 'ok', JSON.stringify(downloadReopenedPlan));
    if (downloadReopenedPlan.status !== 'ok') throw new Error('download plan did not reopen');
    const localCommit = staged.prepareStagedPhysicalDispatch({
      planAuthority: downloadReopenedPlan.authority,
      stageOrdinal: 3,
      parentDispatchLease: fixture.callLease,
    });
    assert.ok(localCommit.status === 'prepared' || localCommit.status === 'replayed', JSON.stringify(localCommit));
    if (localCommit.status !== 'prepared' && localCommit.status !== 'replayed') {
      throw new Error('local commit stage did not prepare');
    }
    assert.equal(ledger.beginStagedPhysicalDispatch({ authority: localCommit.authority }).status, 'inserted');
    const committed = staged.executeStagedLocalCommitBody({ authority: localCommit.authority });
    assert.equal(committed.status, 'returned', JSON.stringify(committed));
    if (committed.status !== 'returned') throw new Error('local commit body did not return');
    assert.equal(committed.byteCount, downloadedBytes.byteLength);
    assert.equal('blobPath' in committed, false);
    assert.equal(JSON.stringify(committed).includes(TMP_HOME), false);
    assert.equal(staged.executeStagedLocalCommitBody({
      authority: localCommit.authority,
    }).status, 'conflict', 'local commit body is one-shot per exact physical attempt');
    const commitCheckpoint = checkpoints.prepareStagedBlobBodyReturnCheckpoint({
      authority: localCommit.authority,
      result: committed.result,
      sha256: committed.sha256,
      md5: committed.md5,
      byteCount: committed.byteCount,
      bodyDigest: committed.bodyDigest,
      resultDigest: committed.resultDigest,
    });
    assert.equal(commitCheckpoint.status, 'prepared', JSON.stringify(commitCheckpoint));
    if (commitCheckpoint.status !== 'prepared') throw new Error('local commit checkpoint did not prepare');
    assert.equal(JSON.stringify(commitCheckpoint).includes(TMP_HOME), false);
    assert.equal(ledger.settleStagedPhysicalDispatch({
      authority: localCommit.authority,
      outcome: 'returned',
      returnCheckpoint: commitCheckpoint.checkpoint,
    }).status, 'inserted');
    const commitIdentity = staged.inspectStagedPhysicalDispatchAuthority(localCommit.authority)!;
    assert.equal(commitIdentity.terminalOnly, true, 'returned local commit reopens only for forensic verification');
    assert.deepEqual(eventlog.openEventLog().prepare(`
      SELECT blob_sha256, blob_md5, blob_bytes
        FROM staged_transfer_blob_owners
       WHERE plan_id = ? AND stage_id = ?
    `).get(commitIdentity.planId, commitIdentity.stageId), {
      blob_sha256: committed.sha256,
      blob_md5: committed.md5,
      blob_bytes: committed.byteCount,
    });
    assert.equal(staged.commitStagedBlobBodyResult({
      authority: localCommit.authority,
      result: committed.result,
    }).status, 'replayed');
    const durableCommitRows = JSON.stringify({
      checkpoint: eventlog.openEventLog().prepare(`
        SELECT * FROM physical_dispatch_return_checkpoints WHERE stage_authority_id = ?
      `).get(commitIdentity.stageAuthorityId),
      receipt: eventlog.openEventLog().prepare(`
        SELECT * FROM staged_transfer_stage_receipts WHERE stage_authority_id = ?
      `).get(commitIdentity.stageAuthorityId),
      owner: eventlog.openEventLog().prepare(`
        SELECT * FROM staged_transfer_blob_owners WHERE plan_id = ? AND stage_id = ?
      `).get(commitIdentity.planId, commitIdentity.stageId),
    });
    assert.equal(durableCommitRows.includes(TMP_HOME), false);
    assert.equal(durableCommitRows.includes('materialized'), false);
    eventlog.closeEventLog();
    eventlog.openEventLog();
    const materializedPlan = staged.reopenStagedTransferPlanAuthority({
      sessionId: fixture.session.id,
      sourceUserSeq: fixture.source.seq,
      parentLogicalToolCallId: fixture.logicalToolCallId,
    });
    assert.equal(materializedPlan.status, 'ok', JSON.stringify(materializedPlan));
    if (materializedPlan.status !== 'ok') throw new Error('materialized plan did not reopen');
    const materializedAttempt = staged.reopenStagedPhysicalDispatchAuthority({
      planAuthority: materializedPlan.authority,
      stageOrdinal: 3,
    });
    assert.equal(materializedAttempt.status, 'replayed', JSON.stringify(materializedAttempt));
    if (materializedAttempt.status !== 'replayed') throw new Error('materialized attempt did not reopen');
    assert.equal(checkpoints.recoverCommittedStagedPhysicalReturn({
      authority: materializedAttempt.authority,
    }).status, 'committed', 'restart verifies the deterministic materialized destination');

    const failedDownload = staged.prepareStagedPhysicalDispatch({
      planAuthority: downloadReopenedPlan.authority,
      stageOrdinal: 4,
      parentDispatchLease: fixture.callLease,
    });
    assert.ok(failedDownload.status === 'prepared' || failedDownload.status === 'replayed', JSON.stringify(failedDownload));
    if (failedDownload.status !== 'prepared' && failedDownload.status !== 'replayed') {
      throw new Error('second download stage did not prepare');
    }
    assert.equal(ledger.beginStagedPhysicalDispatch({ authority: failedDownload.authority }).status, 'inserted');
    const failedCarrier = staged.prepareStagedDownloadBodyCarrier({ authority: failedDownload.authority });
    assert.ok(failedCarrier.status === 'prepared' || failedCarrier.status === 'replayed', JSON.stringify(failedCarrier));
    if (failedCarrier.status !== 'prepared' && failedCarrier.status !== 'replayed') {
      throw new Error('second download carrier did not prepare');
    }
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response('transient provider failure', { status: 503 });
    }) as typeof fetch;
    const failedBody = await checkpoints.executeCommittedComposioDownloadBody({
      authority: failedDownload.authority,
      carrier: failedCarrier.carrier,
    });
    assert.deepEqual(failedBody, { status: 'threw', code: 'download_unavailable' });
    assert.equal(fetchCount, 2, 'a transient provider result is never retried inside one physical attempt');
    assert.equal(ledger.settleStagedPhysicalDispatch({
      authority: failedDownload.authority,
      outcome: 'threw',
    }).status, 'inserted');
    const failedIdentity = staged.inspectStagedPhysicalDispatchAuthority(failedDownload.authority)!;
    assert.equal((eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS count FROM staged_transfer_blob_owners
       WHERE plan_id = ? AND stage_id = ?
    `).get(failedIdentity.planId, failedIdentity.stageId) as { count: number }).count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const replayedSuccessors = staged.prepareStagedDownloadSuccessors({
    planAuthority: successors.authority,
  });
  assert.equal(replayedSuccessors.status, 'replayed', JSON.stringify(replayedSuccessors));
  const reopenedPlan = staged.reopenStagedTransferPlanAuthority({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    parentLogicalToolCallId: fixture.logicalToolCallId,
  });
  assert.equal(reopenedPlan.status, 'ok', JSON.stringify(reopenedPlan));
  const serializedRows = JSON.stringify(eventlog.openEventLog().prepare(`
    SELECT * FROM physical_dispatch_return_checkpoints
    UNION ALL SELECT * FROM physical_dispatch_return_checkpoints WHERE 0
  `).all());
  assert.equal(serializedRows.includes('credential=never-plaintext'), false);
  assert.equal(JSON.stringify(eventlog.openEventLog().prepare(`
    SELECT * FROM staged_transfer_stages
  `).all()).includes('objects.example'), false);
});

test('generic settlement cannot close staged work and exact throw writes one terminal receipt', async () => {
  const fixture = await createPlan('throw');
  const prepared = staged.prepareStagedPhysicalDispatch({
    planAuthority: fixture.preparedPlan.authority,
    stageOrdinal: 1,
    parentDispatchLease: fixture.callLease,
  });
  assert.ok(prepared.status === 'prepared' || prepared.status === 'replayed', JSON.stringify(prepared));
  if (prepared.status !== 'prepared' && prepared.status !== 'replayed') throw new Error('stage refused');
  const visible = staged.inspectStagedPhysicalDispatchAuthority(prepared.authority)!;
  const started = ledger.beginStagedPhysicalDispatch({ authority: prepared.authority });
  assert.equal(started.status, 'inserted', JSON.stringify(started));
  assert.equal(ledger.settlePhysicalDispatch({
    identity: started.identity,
    tool: visible.toolName,
    outcome: 'threw',
    dispatchLease: visible.lease,
  }).status, 'conflict');
  composio.__test__.setComposioApiKeyOverride('test-api-key');
  composio.__test__.setComposioClient({
    getClient: () => ({
      withOptions: () => ({
        tools: { execute: async () => { throw new Error('provider failed'); } },
      }),
    }),
  });
  const oneShot = composio.prepareComposioOneShotDispatch({
    toolSlug: fixture.operationId,
    args: fixture.args,
    connectedAccountId: fixture.accountId,
    providerOperationVersion: fixture.operationVersion,
  });
  const body = await checkpoints.executeStagedPreparedComposioBody({
    authority: prepared.authority,
    preparedDispatch: oneShot,
  });
  assert.equal(body.status, 'threw');
  assert.equal(ledger.settleStagedPhysicalDispatch({
    authority: prepared.authority,
    outcome: 'threw',
  }).status, 'inserted');
  const receipt = eventlog.openEventLog().prepare(`
    SELECT terminal_state, result_digest FROM staged_transfer_stage_receipts
     WHERE stage_authority_id = ?
  `).get(visible.stageAuthorityId) as { terminal_state: string; result_digest: string | null };
  assert.deepEqual(receipt, { terminal_state: 'threw', result_digest: null });
});

test('annotated output with no concrete descriptor commits an exact zero-successor projection receipt', async () => {
  const fixture = await createPlan('zero-downloads');
  const prepared = staged.prepareStagedPhysicalDispatch({
    planAuthority: fixture.preparedPlan.authority,
    stageOrdinal: 1,
    parentDispatchLease: fixture.callLease,
  });
  assert.ok(prepared.status === 'prepared' || prepared.status === 'replayed', JSON.stringify(prepared));
  if (prepared.status !== 'prepared' && prepared.status !== 'replayed') throw new Error('stage refused');
  assert.equal(ledger.beginStagedPhysicalDispatch({ authority: prepared.authority }).status, 'inserted');
  composio.__test__.setComposioApiKeyOverride('test-api-key');
  composio.__test__.setComposioClient({
    getClient: () => ({
      withOptions: () => ({
        tools: {
          execute: async () => ({
            successful: true,
            error: null,
            data: { id: 'no-files' },
          }),
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
  const body = await checkpoints.executeStagedPreparedComposioBody({
    authority: prepared.authority,
    preparedDispatch: oneShot,
  });
  assert.equal(body.status, 'returned', JSON.stringify(body));
  if (body.status !== 'returned') throw new Error('body did not return');
  assert.equal(ledger.settleStagedPhysicalDispatch({
    authority: prepared.authority,
    outcome: 'returned',
    returnCheckpoint: body.checkpoint,
  }).status, 'inserted');
  const projected = staged.prepareStagedDownloadSuccessors({
    planAuthority: fixture.preparedPlan.authority,
  });
  assert.ok(projected.status === 'prepared' || projected.status === 'replayed', JSON.stringify(projected));
  if (projected.status !== 'prepared' && projected.status !== 'replayed') {
    throw new Error('zero topology did not commit');
  }
  assert.deepEqual(projected.stageIds, []);
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT successor_stage_count FROM staged_transfer_download_topology_receipts
     WHERE plan_id = ?
  `).get(projected.planId) as { successor_stage_count: number }).successor_stage_count, 0);
  assert.equal(staged.prepareStagedDownloadSuccessors({
    planAuthority: projected.authority,
  }).status, 'replayed');
  const recovered = checkpoints.recoverCommittedStagedPhysicalReturn({
    authority: prepared.authority,
  });
  assert.equal(recovered.status, 'committed', JSON.stringify(recovered));
  if (recovered.status !== 'committed') throw new Error('zero-download return did not reopen');
  const safeResult = checkpoints.projectCommittedComposioResult({
    returned: recovered.returned,
    outputSchema: fixture.outputSchema,
  });
  assert.deepEqual(safeResult, {
    status: 'projected',
    value: { successful: true, error: null, data: { id: 'no-files' } },
  });
  assert.equal(JSON.stringify(safeResult).includes(TMP_HOME), false);
  assert.equal(JSON.stringify(safeResult).includes('https://'), false);
});
