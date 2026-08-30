import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-artifact-lineage-spill-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-artifact-lineage-spill\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const authority = await import('./accepted-task-authority.js');
const contracts = await import('./expected-work-contract.js');
const admission = await import('./expected-work-admission.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const ledger = await import('./artifact-ledger.js');
const payloadStorage = await import('./result-payload-storage.js');
const resultHandles = await import('./result-handle.js');
const admittedConstruct = await import('./admitted-construct-run.js');
const logicalContracts = await import('./logical-call-contract.js');
const sealedBindings = await import('./host-capability-catalog-factory.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const IDS = {
  lineage: 'transform_records',
  create: 'create_artifact',
  readback: 'readback_artifact',
} as const;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function binding(input: {
  nodeId: string;
  toolName: string;
  effect: 'host_only' | 'external_write' | 'read';
}) {
  const capabilityId = `fixture:${input.nodeId}`;
  const schemaVersion = 'fixture-v1';
  const schemaDigest = digest(`schema:${input.nodeId}`);
  const logicalToolName = logicalContracts.canonicalLogicalToolName(input.toolName);
  assert.ok(logicalToolName, `fixture tool ${input.toolName} must have one canonical identity`);
  const unsealed = {
    nodeId: input.nodeId,
    capabilityId,
    toolName: input.toolName,
    providerOperationId: input.toolName,
    logicalToolName: logicalToolName!,
    schemaVersion,
    schemaDigest,
    argumentDigest: digest(`arguments:${input.nodeId}`),
    account: 'account:artifact-lineage-spill',
    effect: input.effect,
  };
  return {
    ...unsealed,
    bindingDigest: sealedBindings.bindingDigestOf(unsealed),
  };
}

test('oversized settled lineage authorizes exact artifact binding and fails closed on missing or replaced spill bytes', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Transform these records, create one artifact, and verify it by exact id.' },
  });
  const graphEvent = shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  });
  assert.ok(graphEvent);
  assert.ok(['armed', 'existing'].includes(authority.armAcceptedTaskAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  }).status));
  const activated = admission.activateActionExpectedWork({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );

  const proposal: contracts.ExpectedWorkProposalV1 = {
    version: 1,
    operations: [
      {
        id: IDS.lineage,
        effect: 'read',
        coverage: 'single',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      },
      {
        id: IDS.create,
        effect: 'external_write',
        dependsOn: [IDS.lineage],
        dataFrom: [IDS.lineage],
        cardinality: { kind: 'once' },
      },
      {
        id: IDS.readback,
        effect: 'read',
        coverage: 'single',
        dependsOn: [IDS.create],
        dataFrom: [],
        cardinality: { kind: 'once' },
      },
    ],
    universes: [],
  };
  const prepared = contracts.prepareActionExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposal,
  });
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  if (prepared.status !== 'prepared') return;
  const frozen = eventlog.openEventLog().transaction(() => (
    contracts.freezePreparedExpectedWorkContractInTransaction(eventlog.openEventLog(), {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      contract: prepared.contract,
    })
  )).immediate();
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
  if (frozen.status !== 'fixed' && frozen.status !== 'replayed') return;

  const bindings = {
    lineage: binding({ nodeId: IDS.lineage, toolName: 'FIXTURE_LIST_RECORDS', effect: 'read' }),
    create: binding({ nodeId: IDS.create, toolName: 'fixture_create', effect: 'external_write' }),
    readback: binding({ nodeId: IDS.readback, toolName: 'fixture_readback', effect: 'read' }),
  };
  const db = eventlog.openEventLog();
  for (const sealed of Object.values(bindings)) {
    assert.equal(sealedBindings.persistSealedNodeBinding({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      binding: sealed,
    }), true);
    assert.deepEqual(
      sealedBindings.loadSealedNodeBinding(session.id, source.seq, sealed.nodeId),
      sealed,
      'fixture binding must survive the production canonical loader',
    );
  }

  const acceptedTaskId = identities.acceptedTaskIdFor(session.id, source.seq);
  const settle = (input: {
    nodeId: string;
    toolName: string;
    args: Record<string, unknown>;
    effect: 'read' | 'compute' | 'external_write';
    payload: unknown;
  }) => {
    const logicalToolCallId = `logical:${input.nodeId}`;
    const physicalDispatchId = `dispatch:${input.nodeId}`;
    const opened = dispatch.admitLogicalCall({
      identity: { sessionId: session.id, sourceUserSeq: source.seq, acceptedTaskId, logicalToolCallId },
      tool: input.toolName,
      args: input.args,
    });
    assert.ok(opened.status === 'inserted' || opened.status === 'replayed', JSON.stringify(opened));
    const admitted = admission.admitExpectedWorkInvocation({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      logicalToolCallId,
      requirementId: input.nodeId,
      tool: input.toolName,
      args: input.args,
      hostSealedEffect: input.effect,
    });
    assert.ok(admitted.status === 'bound' || admitted.status === 'replayed', JSON.stringify(admitted));
    const begun = dispatch.beginPhysicalDispatch({
      identity: {
        sessionId: session.id,
        sourceUserSeq: source.seq,
        acceptedTaskId,
        logicalToolCallId,
        physicalDispatchId,
        ordinal: 0,
      },
      tool: input.toolName,
      args: input.args,
      ...(input.effect === 'compute' ? { executionSite: 'host' as const } : {}),
    });
    assert.equal(begun.status, 'inserted', JSON.stringify(begun));
    if (begun.status !== 'inserted') return;
    assert.equal(dispatch.settlePhysicalDispatch({
      identity: begun.identity,
      tool: input.toolName,
      outcome: 'returned',
    }).status, 'inserted');
    const committed = settlements.commitLogicalCallSettlement({
      identity: { sessionId: session.id, sourceUserSeq: source.seq, acceptedTaskId, logicalToolCallId },
      contract: { toolName: input.toolName, args: input.args },
      execution: { kind: input.effect === 'compute' ? 'local_execution' : 'provider_execution' },
      result: { payload: input.payload },
      outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
      recovery: {
        businessCall: true,
        mutating: input.effect === 'external_write',
        requirementId: input.nodeId,
      },
      observer: { lane: 'agents_runner', turn: 1 },
    });
    assert.equal(committed.status, 'committed', JSON.stringify(committed));
  };

  // Cross the spill threshold with bounded production-shaped records; a
  // single multi-megabyte JSON scalar is rejected by canonical authority.
  const records = Array.from({ length: 12 }, (_, index) => ({
    id: `row-${index + 1}`,
    content: 'x'.repeat(700_000),
  }));
  const sourceEnvelope = { data: { records }, error: null, successful: true };
  const lineageArgs = {
    nodeId: IDS.lineage,
    capabilityId: bindings.lineage.capabilityId,
    schemaVersion: bindings.lineage.schemaVersion,
    schemaDigest: bindings.lineage.schemaDigest,
  };
  settle({
    nodeId: IDS.lineage,
    toolName: bindings.lineage.toolName,
    args: lineageArgs,
    effect: 'read',
    payload: sourceEnvelope,
  });

  const createArgs = {
    nodeId: IDS.create,
    capabilityId: bindings.create.capabilityId,
    schemaVersion: bindings.create.schemaVersion,
    schemaDigest: bindings.create.schemaDigest,
    records,
  };
  const resourceId = 'fixture-artifact-1';
  const contentDigest = ledger.hostArtifactContentDigest(records);
  const contentContract = ledger.createHostSealedArtifactContentContract({
    acceptedTaskId,
    graphId: frozen.contract.graphId,
    graphHash: frozen.contract.graphHash,
    lineageNodeId: IDS.lineage,
    createNodeId: IDS.create,
    readbackNodeId: IDS.readback,
    lineageContentDigest: contentDigest,
    intendedContentDigest: contentDigest,
    createBindingDigest: bindings.create.bindingDigest,
    readbackBindingDigest: bindings.readback.bindingDigest,
    createEffect: 'external_write',
    readbackEffect: 'read',
  });
  const runScopeId = ledger.resolveArtifactRunScopeId(session.id, 'fixture-run', source.seq);
  const intent = {
    kind: 'resource' as const,
    provider: 'fixture',
    slotKey: 'resource:primary',
    title: 'Fixture artifact',
    createShape: 'fixture_create',
  };
  assert.equal(ledger.claimArtifactSlot(
    session.id,
    intent,
    `logical:${IDS.create}`,
    runScopeId,
    contentContract,
  ).acquired, true);
  settle({
    nodeId: IDS.create,
    toolName: bindings.create.toolName,
    args: createArgs,
    effect: 'external_write',
    payload: { id: resourceId, handle: `fixture://${resourceId}`, receipt: 'receipt-fixture-1' },
  });
  ledger.bindArtifactSlot(
    session.id,
    intent.slotKey,
    { resourceId, uri: `fixture://${resourceId}` },
    `logical:${IDS.create}`,
    runScopeId,
  );

  const readArgs = {
    nodeId: IDS.readback,
    resourceId,
    capabilityId: bindings.readback.capabilityId,
    schemaVersion: bindings.readback.schemaVersion,
    schemaDigest: bindings.readback.schemaDigest,
  };
  const authorize = () => ledger.authorizeHostSealedArtifactReadback({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    contractId: frozen.contract.contractId,
    createLogicalToolCallId: `logical:${IDS.create}`,
    verificationRequirementId: IDS.readback,
    readToolName: bindings.readback.toolName,
    readArgs,
  });
  assert.equal(authorize().status, 'authorized', JSON.stringify(authorize()));

  const lineageRow = db.prepare(`
    SELECT raw_payload_json, raw_payload_sha256, raw_byte_count
      FROM durable_result_handles
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(session.id, source.seq, `logical:${IDS.lineage}`) as {
    raw_payload_json: string;
    raw_payload_sha256: string;
    raw_byte_count: number;
  };
  assert.equal(lineageRow.raw_payload_json, payloadStorage.RESULT_PAYLOAD_SPILL_SENTINEL);
  assert.ok(lineageRow.raw_byte_count > payloadStorage.RESULT_PAYLOAD_INLINE_MAX_BYTES);
  const spillPath = payloadStorage.resultPayloadFilePath(lineageRow.raw_payload_sha256);
  rmSync(spillPath);
  assert.equal(authorize().status, 'unavailable', 'a missing spill cannot authorize artifact lineage');
  writeFileSync(spillPath, '{"tampered":true}', { mode: 0o600 });
  assert.equal(authorize().status, 'unavailable', 'replacement bytes cannot inherit artifact lineage authority');
  writeFileSync(spillPath, JSON.stringify(sourceEnvelope), { mode: 0o600 });
  assert.equal(authorize().status, 'authorized', 'restoring the exact bytes restores only their existing authority');

  const hydrationLogicalToolCallId = `logical:${IDS.readback}`;
  const hydrationPhysicalDispatchId = 'dispatch:restart_hydration';
  const hydrationArgs = readArgs;
  const hydrationOpened = dispatch.admitLogicalCall({
    identity: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      acceptedTaskId,
      logicalToolCallId: hydrationLogicalToolCallId,
    },
    tool: bindings.readback.toolName,
    args: hydrationArgs,
  });
  assert.ok(
    hydrationOpened.status === 'inserted' || hydrationOpened.status === 'replayed',
    JSON.stringify(hydrationOpened),
  );
  if (hydrationOpened.status !== 'inserted' && hydrationOpened.status !== 'replayed') return;
  const hydrationAdmitted = admission.admitExpectedWorkInvocation({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    logicalToolCallId: hydrationLogicalToolCallId,
    requirementId: IDS.readback,
    tool: bindings.readback.toolName,
    args: hydrationArgs,
    hostSealedEffect: 'read',
  });
  assert.ok(
    hydrationAdmitted.status === 'bound' || hydrationAdmitted.status === 'replayed',
    JSON.stringify(hydrationAdmitted),
  );
  const hydrationBegun = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      acceptedTaskId,
      logicalToolCallId: hydrationLogicalToolCallId,
      physicalDispatchId: hydrationPhysicalDispatchId,
      ordinal: 0,
    },
    tool: bindings.readback.toolName,
    args: hydrationArgs,
  });
  assert.equal(hydrationBegun.status, 'inserted', JSON.stringify(hydrationBegun));
  if (hydrationBegun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: hydrationBegun.identity,
    tool: bindings.readback.toolName,
    outcome: 'returned',
  }).status, 'inserted');
  const hydrationPayload = { records: [{ id: 'restart-row', blob: 'r'.repeat(8_000_100) }] };
  const hydrationHandle = resultHandles.toResultHandle(hydrationPayload, {
    authority: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      acceptedTaskId,
      logicalToolCallId: hydrationLogicalToolCallId,
      physicalDispatchId: hydrationPhysicalDispatchId,
      toolName: bindings.readback.toolName,
      args: hydrationArgs,
    },
  });
  assert.ok(hydrationHandle.rawLocation);
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_artifact_records (
      ref TEXT PRIMARY KEY,
      record_json TEXT NOT NULL
    );
  `);
  assert.equal(db.prepare(
    'SELECT 1 FROM graph_artifact_records WHERE ref = ?',
  ).get(hydrationHandle.rawLocation), undefined);
  const hydrationRun = admittedConstruct.hydrateReturnedConstructArtifacts({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    graph: {
      compiler: { graphHash: frozen.contract.graphHash },
      nodes: [{ id: IDS.readback, capabilityRole: 'readback' }],
    },
  });
  const hydratedRecord = db.prepare(
    'SELECT record_json FROM graph_artifact_records WHERE ref = ?',
  ).get(hydrationHandle.rawLocation) as { record_json: string } | undefined;
  assert.ok(hydratedRecord, JSON.stringify({
    message: 'pre-settlement returned spill is hydrated into exact artifact lineage',
    hydrationRun,
  }));
  const hydratedRecordValue = JSON.parse(hydratedRecord.record_json) as {
    contentDigest: string;
    byteLength: number;
  };
  const hydrationRawJson = JSON.stringify(hydrationPayload);
  assert.deepEqual({
    contentDigest: hydratedRecordValue.contentDigest,
    byteLength: hydratedRecordValue.byteLength,
  }, {
    contentDigest: digest(hydrationRawJson),
    byteLength: Buffer.byteLength(hydrationRawJson, 'utf8'),
  });
  assert.ok(Object.keys(hydrationArgs).length > 0, 'the crash fixture carries nonempty exact arguments');
  assert.equal(resultHandles.redeemAuthoritativeResultPayload({
    kind: 'successful_settlement',
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    logicalToolCallId: hydrationLogicalToolCallId,
  }).status, 'missing', 'hydration does not promote a returned handle into settlement authority');

  const adopt = (overrides: Partial<Parameters<
    typeof admittedConstruct.adoptReturnedConstructResult
  >[0]> = {}) => admittedConstruct.adoptReturnedConstructResult({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    logicalToolCallId: hydrationLogicalToolCallId,
    physicalDispatchId: hydrationPhysicalDispatchId,
    rawLocation: hydrationHandle.rawLocation!,
    toolName: bindings.readback.toolName,
    args: hydrationArgs,
    canonicalArgumentDigest: hydrationOpened.identity.argumentDigest,
    executionKind: 'provider_execution',
    mutating: false,
    requirementId: IDS.readback,
    turn: 1,
    ...overrides,
  });
  const logicalState = () => (db.prepare(`
    SELECT state FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(session.id, source.seq, hydrationLogicalToolCallId) as { state: string }).state;
  assert.equal(adopt({
    args: { ...hydrationArgs, resourceId: 'different-artifact' },
  }).status, 'unavailable', 'changed recovery arguments fail closed');
  assert.equal(logicalState(), 'open');
  assert.equal(adopt({
    acceptedTaskId: `${acceptedTaskId}:different`,
  }).status, 'unavailable', 'a different accepted task cannot adopt the return');
  assert.equal(logicalState(), 'open');
  const plausibleOtherHandle = db.prepare(`
    SELECT raw_location FROM durable_result_handles
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(session.id, source.seq, `logical:${IDS.create}`) as { raw_location: string };
  assert.notEqual(plausibleOtherHandle.raw_location, hydrationHandle.rawLocation);
  assert.equal(adopt({
    rawLocation: plausibleOtherHandle.raw_location,
  }).status, 'unavailable', 'another valid handle from the same task cannot be named by recovery');
  assert.equal(logicalState(), 'open');

  const adopted = adopt();
  assert.equal(adopted.status, 'adopted', JSON.stringify(adopted));
  assert.equal(logicalState(), 'settled', 'the returned crossing is no longer stranded open');
  const adoptedTruth = db.prepare(`
    SELECT s.result_handle_id,
           (SELECT COUNT(*) FROM logical_call_settlements s2
             WHERE s2.session_id = s.session_id
               AND s2.source_user_seq = s.source_user_seq
               AND s2.logical_tool_call_id = s.logical_tool_call_id) AS settlement_count,
           (SELECT COUNT(*) FROM physical_dispatches p
             WHERE p.session_id = s.session_id
               AND p.source_user_seq = s.source_user_seq
               AND p.logical_tool_call_id = s.logical_tool_call_id) AS dispatch_count
      FROM logical_call_settlements s
     WHERE s.session_id = ? AND s.source_user_seq = ? AND s.logical_tool_call_id = ?
  `).get(session.id, source.seq, hydrationLogicalToolCallId) as {
    result_handle_id: string;
    settlement_count: number;
    dispatch_count: number;
  };
  assert.deepEqual(adoptedTruth, {
    result_handle_id: hydrationHandle.handle,
    settlement_count: 1,
    dispatch_count: 1,
  }, 'adoption names the exact pre-crash handle with zero redispatch');
  const settledExact = admittedConstruct.redeemSettledConstructResult({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    logicalToolCallId: hydrationLogicalToolCallId,
    toolName: bindings.readback.toolName,
    args: hydrationArgs,
  });
  assert.equal(settledExact.status, 'ok', JSON.stringify(settledExact));
  if (settledExact.status === 'ok') {
    assert.equal(settledExact.resultHandleId, hydrationHandle.handle);
    assert.equal(settledExact.rawLocation, hydrationHandle.rawLocation);
  }
  assert.equal(admittedConstruct.redeemSettledConstructResult({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    logicalToolCallId: hydrationLogicalToolCallId,
    toolName: bindings.readback.toolName,
    args: { ...hydrationArgs, resourceId: 'changed-after-settlement' },
  }).status, 'unavailable', 'settled replay refuses changed nonempty arguments');
  assert.equal(admittedConstruct.redeemSettledConstructResult({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: `${acceptedTaskId}:changed`,
    logicalToolCallId: hydrationLogicalToolCallId,
    toolName: bindings.readback.toolName,
    args: hydrationArgs,
  }).status, 'unavailable', 'settled replay refuses a changed accepted task');
  assert.equal(adopt().status, 'adopted', 'exact recovery replay is idempotent');
  assert.deepEqual(db.prepare(`
    SELECT COUNT(*) AS settlement_count,
           (SELECT COUNT(*) FROM physical_dispatches p
             WHERE p.session_id = ? AND p.source_user_seq = ?
               AND p.logical_tool_call_id = ?) AS dispatch_count
      FROM logical_call_settlements s
     WHERE s.session_id = ? AND s.source_user_seq = ? AND s.logical_tool_call_id = ?
  `).get(
    session.id,
    source.seq,
    hydrationLogicalToolCallId,
    session.id,
    source.seq,
    hydrationLogicalToolCallId,
  ), { settlement_count: 1, dispatch_count: 1 });
});
