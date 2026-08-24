import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-logical-settlement-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-logical-settlement\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const dispatch = await import('./dispatch-ledger.js');
const identities = await import('./attempt-identity.js');
const outcomes = await import('./attempt-outcome.js');
const store = await import('./logical-call-settlement-store.js');
const contracts = await import('./logical-call-contract.js');
const crossingAuthority = await import('./settlement-crossing-authority.js');
const governorModule = await import('./discovery-governor.js');
const resultHandles = await import('./result-handle.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function accept(text = 'Find the current alpha records.') {
  const session = eventlog.createSession({ id: `logical-settlement-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

function admitProviderCall(input: {
  task: ReturnType<typeof accept>;
  logicalToolCallId: string;
  physicalDispatchId: string;
  tool?: string;
  args?: unknown;
}) {
  const tool = input.tool ?? 'alpha_records_search';
  const args = input.args ?? { query: 'alpha' };
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      ...input.task,
      logicalToolCallId: input.logicalToolCallId,
      physicalDispatchId: input.physicalDispatchId,
      ordinal: 0,
    },
    tool,
    args,
  });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
  const settled = dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool,
    outcome: 'returned',
  });
  assert.equal(settled.status, 'inserted');
  return { tool, args, identity: started.identity };
}

function successInput(input: {
  task: ReturnType<typeof accept>;
  logicalToolCallId: string;
  tool: string;
  args: unknown;
  lane?: store.LogicalCallSettlementLane;
  callId?: string;
  progressIdentity?: string;
  governorEvidence?: store.CommitLogicalCallSettlementInput['recovery']['governorEvidence'];
}): store.CommitLogicalCallSettlementInput {
  return {
    identity: {
      sessionId: input.task.sessionId,
      sourceUserSeq: input.task.sourceUserSeq,
      acceptedTaskId: input.task.acceptedTaskId,
      logicalToolCallId: input.logicalToolCallId,
    },
    contract: { toolName: input.tool, args: input.args },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: true, data: { records: [{ id: 'alpha-1' }] } } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: {
      businessCall: true,
      mutating: false,
      ...(input.progressIdentity ? { progressIdentity: input.progressIdentity } : {}),
      ...(input.governorEvidence ? { governorEvidence: input.governorEvidence } : {}),
    },
    observer: {
      lane: input.lane ?? 'composio',
      ...(input.callId ? { callId: input.callId } : {}),
      turn: input.task.turn,
    },
  };
}

test('outer call_tool and Composio carriers share the paid inner contract', () => {
  const taskId = 'task:contract-parity#1';
  const args = { spreadsheet_id: 'sheet-1', range: 'A1:B2' };
  const callTool = contracts.durableLogicalCallContract(taskId, 'call_tool', {
    name: 'GOOGLESHEETS_BATCH_GET',
    args_json: JSON.stringify(args),
  });
  const composioGateway = contracts.durableLogicalCallContract(taskId, 'composio_execute_tool', {
    tool_slug: 'GOOGLESHEETS_BATCH_GET',
    arguments: JSON.stringify(args),
  });
  const paidInner = contracts.durableLogicalCallContract(
    taskId,
    'GOOGLESHEETS_BATCH_GET',
    args,
  );
  assert.ok(callTool, 'the call_tool carrier must compile to a durable contract');
  assert.ok(composioGateway, 'the Composio carrier must compile to a durable contract');
  assert.ok(paidInner, 'the paid inner call must compile to a durable contract');
  assert.deepEqual(callTool, paidInner);
  assert.deepEqual(composioGateway, paidInner);
});

test('ordinary payload fields cannot rename a trusted non-carrier tool', () => {
  const taskId = 'task:contract-payload#1';
  const ordinaryPayload = {
    tool_slug: 'GMAIL_SEND_EMAIL',
    arguments: { to: 'not-a-carrier@example.com' },
    name: 'also ordinary business data',
  };
  const ordinary = contracts.durableLogicalCallContract(
    taskId,
    'custom_report_tool',
    ordinaryPayload,
  );
  const renamed = contracts.durableLogicalCallContract(
    taskId,
    'GMAIL_SEND_EMAIL',
    ordinaryPayload.arguments,
  );
  assert.equal(ordinary?.toolName, 'custom_report_tool');
  assert.notEqual(ordinary?.argumentDigest, renamed?.argumentDigest);
});

test('one transaction freezes exact paid crossings, mirrors once, closes by CAS, and exactly replays', () => {
  const task = accept();
  const secret = 'raw-provider-value-must-not-persist';
  const call = admitProviderCall({
    task,
    logicalToolCallId: 'logical:exact-replay',
    physicalDispatchId: 'dispatch:exact-replay',
    args: { query: secret },
  });
  const input = successInput({
    task,
    logicalToolCallId: call.identity.logicalToolCallId,
    tool: call.tool,
    args: call.args,
    callId: 'carrier:first',
    progressIdentity: 'alpha-records-complete',
  });
  const first = store.commitLogicalCallSettlement(input);
  assert.equal(first.status, 'committed');
  if (first.status !== 'committed') return;
  assert.equal(first.settlement.crossings.length, 1);
  assert.equal(first.settlement.crossings[0]?.physicalDispatchId, 'dispatch:exact-replay');
  assert.equal(first.settlement.recovery.progressClaimed, true);
  assert.ok(first.settlement.resultHandleId, 'successful provider settlement owns a durable result handle');

  const replay = store.commitLogicalCallSettlement({
    ...input,
    // Carrier observers are mirrors, not semantic authority.
    observer: { lane: 'native_mcp', callId: 'carrier:mirror', turn: 99 },
  });
  assert.equal(replay.status, 'replayed');
  if (replay.status !== 'replayed') return;
  assert.equal(replay.settlement.settlementEventId, first.settlement.settlementEventId);
  assert.equal(replay.settlement.observer.lane, 'composio');

  const db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT state, settlement_event_id, outcome_kind
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, call.identity.logicalToolCallId), {
    state: 'settled',
    settlement_event_id: first.settlement.settlementEventId,
    outcome_kind: 'succeeded',
  });
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['tool_attempt_settled'] }).length,
    1,
  );
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['tool_attempt_settled'] })[0]?.data.resultHandleId,
    first.settlement.resultHandleId,
    'the mirror exposes only the durable handle id, not raw provider bytes',
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM logical_call_settlement_crossings').get() as { n: number }).n,
    1,
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM accepted_task_operations
      WHERE session_id = ? AND source_user_seq = ?`).get(task.sessionId, task.sourceUserSeq) as { n: number }).n,
    1,
    'the successful business operation is observed in the settlement transaction',
  );
  const resultRow = db.prepare(`
    SELECT raw_location FROM durable_result_handles WHERE handle_id = ?
  `).get(first.settlement.resultHandleId) as { raw_location: string };
  eventlog.closeEventLog();
  assert.deepEqual(resultHandles.redeemRawResult(resultRow.raw_location, {
    ...task,
    logicalToolCallId: call.identity.logicalToolCallId,
    physicalDispatchId: call.identity.physicalDispatchId,
    toolName: call.tool,
    args: call.args,
  }), { status: 'ok', value: input.result?.payload });
  const reopened = eventlog.openEventLog();
  assert.equal(
    JSON.stringify({
      events: eventlog.listEvents(task.sessionId),
      settlement: reopened.prepare('SELECT * FROM logical_call_settlements').all(),
      crossings: reopened.prepare('SELECT * FROM logical_call_settlement_crossings').all(),
    }).includes(secret),
    false,
  );
});

test('v2 provider crossing result redemption verifies terminal state and provider site', () => {
  const task = accept('Read the current provider records.');
  const call = admitProviderCall({
    task,
    logicalToolCallId: 'logical:v2-provider-redemption',
    physicalDispatchId: 'dispatch:v2-provider-redemption',
    args: { query: 'provider-v2' },
  });
  const committed = store.commitLogicalCallSettlement(successInput({
    task,
    logicalToolCallId: call.identity.logicalToolCallId,
    tool: call.tool,
    args: call.args,
  }));
  assert.equal(committed.status, 'committed');
  if (committed.status !== 'committed') return;
  assert.equal(committed.settlement.crossingAuthorityVersion, 2);
  assert.equal(committed.settlement.physicalCrossingCount, 1);
  assert.equal(committed.settlement.hostCrossingCount, 0);
  assert.deepEqual(committed.settlement.crossings.map((crossing) => ({
    terminalState: crossing.terminalState,
    executionSite: crossing.executionSite ?? null,
  })), [{ terminalState: 'returned', executionSite: null }]);

  const redeemed = resultHandles.redeemSuccessfulSettlementResultForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: call.identity.logicalToolCallId,
  });
  assert.equal(redeemed.status, 'ok', JSON.stringify(redeemed));
  if (redeemed.status === 'ok') assert.equal(redeemed.value.executionSite, 'provider');
});

test('returned uncertain write retains one forensic raw handle without becoming success authority', () => {
  const task = accept('Create one Sheet, but do not repeat an ambiguous provider return.');
  const tool = 'GOOGLESHEETS_SHEET_FROM_JSON';
  const args = { title: 'Restaurants', sheet_json: '[{"name":"A"}]' };
  const call = admitProviderCall({
    task,
    logicalToolCallId: 'logical:uncertain-returned',
    physicalDispatchId: 'dispatch:uncertain-returned',
    tool,
    args,
  });
  const payload = { successful: true, message: 'created', opaque: { token: 'raw-return-7' } };
  const input: store.CommitLogicalCallSettlementInput = {
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId: call.identity.logicalToolCallId,
    },
    contract: { toolName: tool, args },
    execution: { kind: 'provider_execution' },
    result: { payload },
    outcome: outcomes.classifyAttemptOutcome({ mutating: true, acknowledged: false }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'composio', turn: task.turn },
  };
  const committed = store.commitLogicalCallSettlement(input);
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  if (committed.status !== 'committed') return;
  assert.equal(committed.settlement.outcome.kind, 'uncertain_write');
  assert.equal(committed.settlement.outcome.directive.retrySameCandidate, false);
  assert.equal(committed.settlement.resultHandleId, undefined);
  assert.equal(committed.settlement.physicalCrossingCount, 1);
  assert.equal(committed.settlement.hostCrossingCount, 0);

  const db = eventlog.openEventLog();
  const row = db.prepare(`
    SELECT h.handle_id, h.raw_location, h.raw_payload_json, h.raw_payload_sha256,
           h.raw_byte_count, s.result_handle_id
      FROM durable_result_handles h
      JOIN logical_call_settlements s
        ON s.session_id = h.session_id
       AND s.source_user_seq = h.source_user_seq
       AND s.logical_tool_call_id = h.logical_tool_call_id
     WHERE h.session_id = ? AND h.source_user_seq = ?
       AND h.logical_tool_call_id = ? AND h.physical_dispatch_id = ?
  `).get(
    task.sessionId,
    task.sourceUserSeq,
    call.identity.logicalToolCallId,
    call.identity.physicalDispatchId,
  ) as {
    handle_id: string;
    raw_location: string;
    raw_payload_json: string;
    raw_payload_sha256: string;
    raw_byte_count: number;
    result_handle_id: string | null;
  };
  const rawJson = JSON.stringify(payload);
  const canonicalToolName = contracts.durableLogicalCallContract(task.acceptedTaskId, tool, args)?.toolName;
  assert.ok(canonicalToolName);
  assert.deepEqual({
    settlementHandle: row.result_handle_id,
    rawJson: row.raw_payload_json,
    rawDigest: row.raw_payload_sha256,
    rawBytes: row.raw_byte_count,
  }, {
    settlementHandle: null,
    rawJson,
    rawDigest: createHash('sha256').update(rawJson).digest('hex'),
    rawBytes: Buffer.byteLength(rawJson, 'utf8'),
  });
  const mirror = eventlog.listEvents(task.sessionId, { types: ['tool_attempt_settled'] })[0];
  assert.equal(mirror?.data.resultHandleId, undefined,
    'uncertain forensic bytes are never advertised as settlement success authority');
  assert.equal(resultHandles.redeemSuccessfulSettlementResultForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: call.identity.logicalToolCallId,
  }).status, 'missing');

  eventlog.closeEventLog();
  const exactAuthority: resultHandles.ResultHandleAuthority = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: call.identity.logicalToolCallId,
    physicalDispatchId: call.identity.physicalDispatchId,
    toolName: tool,
    args,
  };
  assert.deepEqual(resultHandles.redeemAuthoritativeResultPayload({
    kind: 'returned_handle',
    rawLocation: row.raw_location,
    authority: exactAuthority,
  }), {
    status: 'ok',
    value: {
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId: call.identity.logicalToolCallId,
      physicalDispatchId: call.identity.physicalDispatchId,
      resultHandleId: row.handle_id,
      toolName: canonicalToolName,
      rawLocation: row.raw_location,
      rawPayload: payload,
      rawPayloadJson: rawJson,
      rawPayloadSha256: row.raw_payload_sha256,
      rawByteCount: row.raw_byte_count,
    },
  });
  for (const changed of [
    { ...exactAuthority, acceptedTaskId: 'task:other' },
    { ...exactAuthority, logicalToolCallId: 'logical:other' },
    { ...exactAuthority, physicalDispatchId: 'dispatch:other' },
    { ...exactAuthority, toolName: 'GOOGLESHEETS_SHEET_FROM_JSON_LOOKALIKE' },
    { ...exactAuthority, args: { ...args, title: 'Other' } },
  ]) {
    assert.notEqual(resultHandles.redeemAuthoritativeResultPayload({
      kind: 'returned_handle',
      rawLocation: row.raw_location,
      authority: changed,
    }).status, 'ok');
  }

  const replay = store.commitLogicalCallSettlement(input);
  assert.equal(replay.status, 'replayed');
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM durable_result_handles
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, call.identity.logicalToolCallId) as { n: number }).n, 1);
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, call.identity.logicalToolCallId) as { n: number }).n, 1);

  const conflicting = store.commitLogicalCallSettlement({
    ...input,
    result: { payload: { ...payload, opaque: { token: 'different-return' } } },
  });
  assert.equal(conflicting.status, 'conflict');
});

test('thrown or timed-out uncertain writes retain no result handle', () => {
  for (const terminalState of ['threw', 'timed_out'] as const) {
    const task = accept(`Do not fabricate bytes for a ${terminalState} write.`);
    const tool = 'GOOGLESHEETS_SHEET_FROM_JSON';
    const args = { title: terminalState };
    const logicalToolCallId = `logical:uncertain-${terminalState}`;
    const started = dispatch.beginPhysicalDispatch({
      identity: {
        ...task,
        logicalToolCallId,
        physicalDispatchId: `dispatch:uncertain-${terminalState}`,
        ordinal: 0,
      },
      tool,
      args,
    });
    assert.equal(started.status, 'inserted');
    if (started.status !== 'inserted') continue;
    assert.equal(dispatch.settlePhysicalDispatch({
      identity: started.identity,
      tool,
      outcome: terminalState,
    }).status, 'inserted');
    const committed = store.commitLogicalCallSettlement({
      identity: {
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        acceptedTaskId: task.acceptedTaskId,
        logicalToolCallId,
      },
      contract: { toolName: tool, args },
      execution: { kind: 'provider_execution' },
      outcome: outcomes.classifyAttemptOutcome({ mutating: true, acknowledged: false }),
      recovery: { businessCall: true, mutating: true },
      observer: { lane: 'composio', turn: task.turn },
    });
    assert.equal(committed.status, 'committed', JSON.stringify(committed));
    if (committed.status !== 'committed') continue;
    assert.equal(committed.settlement.resultHandleId, undefined);
    assert.equal((eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM durable_result_handles
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(task.sessionId, task.sourceUserSeq, logicalToolCallId) as { n: number }).n, 0);
  }
});

test('a returned uncertain write with no actual provider payload retains no handle', () => {
  const task = accept('Do not fabricate reconciliation bytes when the adapter has no returned payload.');
  const tool = 'GOOGLESHEETS_SHEET_FROM_JSON';
  const args = { title: 'No payload' };
  const call = admitProviderCall({
    task,
    logicalToolCallId: 'logical:uncertain-returned-without-payload',
    physicalDispatchId: 'dispatch:uncertain-returned-without-payload',
    tool,
    args,
  });
  const committed = store.commitLogicalCallSettlement({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId: call.identity.logicalToolCallId,
    },
    contract: { toolName: tool, args },
    execution: { kind: 'provider_execution' },
    result: { payload: undefined },
    outcome: outcomes.classifyAttemptOutcome({ mutating: true, acknowledged: false }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  if (committed.status !== 'committed') return;
  assert.equal(committed.settlement.outcome.kind, 'uncertain_write');
  assert.equal(committed.settlement.resultHandleId, undefined);
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM durable_result_handles
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, call.identity.logicalToolCallId) as { n: number }).n, 0);
});

test('oversized settlement binds off-row digest, byte count, location, and crossing authority across restart', () => {
  const task = accept('Read the one authoritative oversized provider result.');
  const call = admitProviderCall({
    task,
    logicalToolCallId: 'logical:oversized-settlement-redemption',
    physicalDispatchId: 'dispatch:oversized-settlement-redemption',
    args: { query: 'oversized-settlement' },
  });
  const tail = 'SETTLEMENT_RAW_TAIL_EXACT';
  const payload = {
    successful: true,
    data: {
      records: [{
        id: 'oversized-settlement-row',
        blob: `${'s'.repeat(resultHandles.RESULT_RAW_MAX_BYTES + 1)}${tail}`,
      }],
    },
    meta: { complete: true },
  };
  const rawJson = JSON.stringify(payload);
  const input = {
    ...successInput({
      task,
      logicalToolCallId: call.identity.logicalToolCallId,
      tool: call.tool,
      args: call.args,
    }),
    result: { payload },
  } satisfies store.CommitLogicalCallSettlementInput;
  const committed = store.commitLogicalCallSettlement(input);
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  if (committed.status !== 'committed') return;

  const row = eventlog.openEventLog().prepare(`
    SELECT h.raw_location, h.raw_payload_json, h.raw_payload_sha256,
           h.raw_byte_count, h.rejection_reason,
           s.result_handle_id, s.crossing_authority_version
      FROM logical_call_settlements s
      JOIN durable_result_handles h ON h.handle_id = s.result_handle_id
     WHERE s.session_id = ? AND s.source_user_seq = ? AND s.logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, call.identity.logicalToolCallId) as {
    raw_location: string;
    raw_payload_json: string;
    raw_payload_sha256: string;
    raw_byte_count: number;
    rejection_reason: string | null;
    result_handle_id: string;
    crossing_authority_version: number;
  };
  assert.deepEqual({
    location: row.raw_location,
    sentinel: row.raw_payload_json,
    digest: row.raw_payload_sha256,
    bytes: row.raw_byte_count,
    rejection: row.rejection_reason,
    handle: row.result_handle_id,
    authorityVersion: row.crossing_authority_version,
  }, {
    location: `tool_output:${row.result_handle_id}`,
    sentinel: '',
    digest: createHash('sha256').update(rawJson).digest('hex'),
    bytes: Buffer.byteLength(rawJson, 'utf8'),
    rejection: null,
    handle: committed.settlement.resultHandleId,
    authorityVersion: 2,
  });

  eventlog.closeEventLog();
  const redeemed = resultHandles.redeemAuthoritativeResultPayload({
    kind: 'successful_settlement',
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: call.identity.logicalToolCallId,
  });
  assert.equal(redeemed.status, 'ok', JSON.stringify(redeemed));
  if (redeemed.status === 'ok') {
    assert.equal((redeemed.value.rawPayload as typeof payload).data.records[0]?.blob.endsWith(tail), true);
    assert.equal(redeemed.value.rawPayloadJson, rawJson);
    assert.equal(redeemed.value.rawPayloadSha256, row.raw_payload_sha256);
    assert.equal(redeemed.value.rawByteCount, row.raw_byte_count);
  }
});

test('v2 host crossing result redemption verifies terminal state and host site', () => {
  const task = accept('Read the current local records.');
  const tool = 'workspace_roots';
  const args = {};
  const logicalToolCallId = 'logical:v2-host-redemption';
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId,
      physicalDispatchId: 'dispatch:v2-host-redemption',
      ordinal: 0,
    },
    tool,
    args,
    executionSite: 'host',
  });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool,
    outcome: 'returned',
  }).status, 'inserted');
  const committed = store.commitLogicalCallSettlement({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId,
    },
    contract: { toolName: tool, args },
    execution: { kind: 'local_execution' },
    result: { payload: { successful: true, data: { roots: ['/workspace'] } } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'byo', turn: task.turn },
  });
  assert.equal(committed.status, 'committed');
  if (committed.status !== 'committed') return;
  assert.equal(committed.settlement.crossingAuthorityVersion, 2);
  assert.equal(committed.settlement.physicalCrossingCount, 0);
  assert.equal(committed.settlement.hostCrossingCount, 1);
  assert.deepEqual(committed.settlement.crossings.map((crossing) => ({
    terminalState: crossing.terminalState,
    executionSite: crossing.executionSite ?? null,
  })), [{ terminalState: 'returned', executionSite: 'host' }]);

  const redeemed = resultHandles.redeemSuccessfulSettlementResultForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId,
  });
  assert.equal(redeemed.status, 'ok', JSON.stringify(redeemed));
  if (redeemed.status === 'ok') assert.equal(redeemed.value.executionSite, 'host');
});

test('historical v1 provider crossing result redemption remains exact after v53 migration', () => {
  const task = accept('Read the historical provider records.');
  const call = admitProviderCall({
    task,
    logicalToolCallId: 'logical:v1-provider-redemption',
    physicalDispatchId: 'dispatch:v1-provider-redemption',
    args: { query: 'provider-v1' },
  });
  const committed = store.commitLogicalCallSettlement(successInput({
    task,
    logicalToolCallId: call.identity.logicalToolCallId,
    tool: call.tool,
    args: call.args,
  }));
  assert.equal(committed.status, 'committed');
  if (committed.status !== 'committed') return;
  const v1Digest = crossingAuthority.settlementCrossingAuthorityDigest(
    committed.settlement.crossings,
    1,
  );
  const db = eventlog.openEventLog();
  db.exec('DROP TRIGGER trg_logical_call_settlement_row_immutable');
  try {
    db.prepare(`
      UPDATE logical_call_settlements
         SET crossing_authority_version = 1, physical_crossings_digest = ?
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).run(v1Digest, task.sessionId, task.sourceUserSeq, call.identity.logicalToolCallId);
  } finally {
    db.exec(`
      CREATE TRIGGER trg_logical_call_settlement_row_immutable
      BEFORE UPDATE ON logical_call_settlements
      BEGIN
        SELECT RAISE(ABORT, 'logical call settlements are immutable');
      END;
    `);
  }
  const mirror = db.prepare('SELECT data_json FROM events WHERE id = ?').get(
    committed.settlement.settlementEventId,
  ) as { data_json: string };
  const mirrorData = JSON.parse(mirror.data_json) as Record<string, unknown>;
  delete mirrorData.crossingAuthorityVersion;
  mirrorData.physicalCrossingsDigest = v1Digest;
  db.prepare('UPDATE events SET data_json = ? WHERE id = ?').run(
    JSON.stringify(mirrorData),
    committed.settlement.settlementEventId,
  );

  const redeemed = resultHandles.redeemSuccessfulSettlementResultForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: call.identity.logicalToolCallId,
  });
  assert.equal(redeemed.status, 'ok', JSON.stringify(redeemed));
  if (redeemed.status === 'ok') assert.equal(redeemed.value.executionSite, 'provider');
});

test('a logical settlement cannot close over a paid crossing that is still in flight', () => {
  const task = accept();
  const tool = 'alpha_records_search';
  const args = { query: 'alpha' };
  const logicalToolCallId = 'logical:in-flight';
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId,
      physicalDispatchId: 'dispatch:in-flight',
      ordinal: 0,
    },
    tool,
    args,
  });
  assert.equal(started.status, 'inserted');

  const refused = store.commitLogicalCallSettlement(successInput({
    task,
    logicalToolCallId,
    tool,
    args,
  }));
  assert.deepEqual(refused, {
    status: 'closed',
    reason: 'a paid crossing is still in flight',
  });
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['tool_attempt_settled'] }).length, 0);
  assert.equal(
    (eventlog.openEventLog().prepare(`
      SELECT state FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(task.sessionId, task.sourceUserSeq, logicalToolCallId) as { state: string }).state,
    'open',
  );

  if (started.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool,
    outcome: 'returned',
  }).status, 'inserted');
  assert.equal(store.commitLogicalCallSettlement(successInput({
    task,
    logicalToolCallId,
    tool,
    args,
  })).status, 'committed');
});

test('candidate failure preserves an already-fresh discovery epoch in the settlement verdict', () => {
  const task = accept();
  const governor = new governorModule.DiscoveryGovernor();
  assert.equal(governor.initializeTask({ ...task, knownCapability: true }).status, 'initialized');
  const call = admitProviderCall({
    task,
    logicalToolCallId: 'logical:candidate-failure',
    physicalDispatchId: 'dispatch:candidate-failure',
  });
  const input: store.CommitLogicalCallSettlementInput = {
    ...successInput({
      task,
      logicalToolCallId: call.identity.logicalToolCallId,
      tool: call.tool,
      args: call.args,
      governorEvidence: {
        kind: 'candidate_unsupported',
        detail: 'alpha_records_search',
      },
    }),
    outcome: outcomes.classifyAttemptOutcome({ httpStatus: 404 }),
  };

  const first = store.commitLogicalCallSettlement(input);
  assert.equal(first.status, 'committed');
  if (first.status !== 'committed') return;
  assert.equal(first.settlement.recovery.governorEvidenceKind, 'candidate_unsupported');
  assert.equal(first.settlement.recovery.governorOutcome, 'epoch_already_fresh');
  assert.equal(first.settlement.recovery.openedDiscoveryEpoch, false);
  assert.equal(governor.getTaskState(task)?.policy.epoch, 0,
    'an unused bounded search slot is already the recovery authority');

  const replay = store.commitLogicalCallSettlement(input);
  assert.equal(replay.status, 'replayed');
  assert.equal(governor.getTaskState(task)?.policy.epoch, 0, 'exact replay cannot mint another epoch');
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['tool_attempt_settled'] }).length, 1);
});

test('a progress identity is claimed once across distinct successful logical calls', () => {
  const task = accept();
  const governor = new governorModule.DiscoveryGovernor();
  governor.initializeTask({ ...task, knownCapability: false });
  assert.equal(governor.admit({
    ...task,
    category: 'broad_discovery',
    callId: 'progress-search',
  }).admitted, true);
  const firstCall = admitProviderCall({
    task,
    logicalToolCallId: 'logical:progress-1',
    physicalDispatchId: 'dispatch:progress-1',
  });
  const first = store.commitLogicalCallSettlement(successInput({
    task,
    logicalToolCallId: firstCall.identity.logicalToolCallId,
    tool: firstCall.tool,
    args: firstCall.args,
    progressIdentity: 'same-completed-step',
    governorEvidence: { kind: 'capability_satisfied', onlyIfProgressClaimed: true },
  }));
  assert.equal(first.status, 'committed');
  assert.equal(first.status === 'committed' && first.settlement.recovery.progressClaimed, true);
  assert.equal(first.status === 'committed' && first.settlement.recovery.creditedProgress, true);
  assert.equal(first.status === 'committed' && first.settlement.recovery.governorOutcome, 'epoch_opened');

  const secondCall = admitProviderCall({
    task,
    logicalToolCallId: 'logical:progress-2',
    physicalDispatchId: 'dispatch:progress-2',
  });
  const second = store.commitLogicalCallSettlement(successInput({
    task,
    logicalToolCallId: secondCall.identity.logicalToolCallId,
    tool: secondCall.tool,
    args: secondCall.args,
    progressIdentity: 'same-completed-step',
    governorEvidence: { kind: 'capability_satisfied', onlyIfProgressClaimed: true },
  }));
  assert.equal(second.status, 'committed');
  assert.equal(second.status === 'committed' && second.settlement.recovery.progressClaimed, false);
  assert.equal(second.status === 'committed' && second.settlement.recovery.creditedProgress, false);
  assert.equal(
    second.status === 'committed' ? second.settlement.recovery.governorOutcome : 'not_committed',
    undefined,
  );
  assert.equal(governor.getTaskState(task)?.policy.epoch, 1, 'duplicate progress cannot advance recovery');
  assert.equal(
    (eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM logical_call_progress_claims
       WHERE session_id = ? AND source_user_seq = ?
    `).get(task.sessionId, task.sourceUserSeq) as { n: number }).n,
    1,
  );
  assert.equal(
    (eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM accepted_task_operations
       WHERE session_id = ? AND source_user_seq = ?
    `).get(task.sessionId, task.sourceUserSeq) as { n: number }).n,
    1,
    'repeating one completed step does not manufacture a second operation',
  );
});

test('a final-CAS storage fault rolls back event, settlement, links, progress, and logical close', () => {
  const task = accept();
  const governor = new governorModule.DiscoveryGovernor();
  governor.initializeTask({ ...task, knownCapability: true });
  const call = admitProviderCall({
    task,
    logicalToolCallId: 'logical:fault',
    physicalDispatchId: 'dispatch:fault',
  });
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER force_logical_close_failure
    BEFORE UPDATE OF state ON logical_tool_calls
    WHEN NEW.state = 'settled'
    BEGIN
      SELECT RAISE(ABORT, 'forced logical close failure');
    END;
  `);
  const result = store.commitLogicalCallSettlement(successInput({
    task,
    logicalToolCallId: call.identity.logicalToolCallId,
    tool: call.tool,
    args: call.args,
    progressIdentity: 'must-roll-back',
    governorEvidence: { kind: 'capability_satisfied', onlyIfProgressClaimed: true },
  }));
  db.exec('DROP TRIGGER force_logical_close_failure');
  assert.equal(result.status, 'storage_error');
  assert.match(result.status === 'storage_error' ? result.reason : '', /forced logical close failure/);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['tool_attempt_settled'] }).length, 0);
  assert.equal(governor.getTaskState(task)?.policy.epoch, 0, 'the recovery epoch rolls back too');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM logical_call_settlements WHERE session_id = ?').get(task.sessionId) as { n: number }).n,
    0,
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM logical_call_progress_claims WHERE session_id = ?').get(task.sessionId) as { n: number }).n,
    0,
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM logical_call_settlement_crossings WHERE session_id = ?').get(task.sessionId) as { n: number }).n,
    0,
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM durable_result_handles WHERE session_id = ?').get(task.sessionId) as { n: number }).n,
    0,
    'the raw result rolls back with the failed logical close',
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM accepted_task_operations WHERE session_id = ?').get(task.sessionId) as { n: number }).n,
    0,
    'operation observation rolls back with the failed logical close',
  );
  assert.equal(
    (db.prepare(`
      SELECT state FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(task.sessionId, task.sourceUserSeq, call.identity.logicalToolCallId) as { state: string }).state,
    'open',
  );
});

test('an unstoreable successful provider result leaves the logical call open and emits no authority', () => {
  const task = accept();
  const call = admitProviderCall({
    task,
    logicalToolCallId: 'logical:raw-storage-failure',
    physicalDispatchId: 'dispatch:raw-storage-failure',
  });
  const circular: Record<string, unknown> = { successful: true, records: [{ id: 'alpha' }] };
  circular.self = circular;
  const input = successInput({
    task,
    logicalToolCallId: call.identity.logicalToolCallId,
    tool: call.tool,
    args: call.args,
  });
  input.result = { payload: circular };
  const result = store.commitLogicalCallSettlement(input);
  assert.equal(result.status, 'storage_error');
  assert.match(result.status === 'storage_error' ? result.reason : '', /not durably storable/);
  const db = eventlog.openEventLog();
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM durable_result_handles WHERE session_id = ?')
      .get(task.sessionId) as { n: number }).n,
    0,
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM logical_call_settlements WHERE session_id = ?')
      .get(task.sessionId) as { n: number }).n,
    0,
  );
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['tool_attempt_settled'] }).length, 0);
  assert.equal(
    (db.prepare(`SELECT state FROM logical_tool_calls
      WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
      .get(task.sessionId, task.sourceUserSeq, call.identity.logicalToolCallId) as { state: string }).state,
    'open',
  );
});

test('a semantic replay conflict poisons the logical call and its accepted resolution', () => {
  const task = accept();
  const call = admitProviderCall({
    task,
    logicalToolCallId: 'logical:semantic-conflict',
    physicalDispatchId: 'dispatch:semantic-conflict',
  });
  const input = successInput({
    task,
    logicalToolCallId: call.identity.logicalToolCallId,
    tool: call.tool,
    args: call.args,
  });
  assert.equal(store.commitLogicalCallSettlement(input).status, 'committed');
  const conflicting = store.commitLogicalCallSettlement({
    ...input,
    outcome: outcomes.classifyAttemptOutcome({ httpStatus: 429 }),
  });
  assert.deepEqual(conflicting, {
    status: 'conflict',
    reason: 'logical settlement replay conflicts with durable authority',
    poisoned: true,
  });
  const db = eventlog.openEventLog();
  assert.equal(
    (db.prepare(`SELECT state FROM logical_tool_calls
      WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
      .get(task.sessionId, task.sourceUserSeq, call.identity.logicalToolCallId) as { state: string }).state,
    'conflict',
  );
  assert.equal(
    (db.prepare(`SELECT state FROM accepted_task_resolutions
      WHERE session_id = ? AND source_user_seq = ?`)
      .get(task.sessionId, task.sourceUserSeq) as { state: string }).state,
    'legacy_ambiguous',
  );
  assert.equal(
    (db.prepare(`SELECT outcome_kind FROM logical_call_settlements
      WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
      .get(task.sessionId, task.sourceUserSeq, call.identity.logicalToolCallId) as { outcome_kind: string }).outcome_kind,
    'succeeded',
    'the conflicting caller cannot overwrite the original settlement',
  );
});

test('a changed durable crossing set is a conflict, never an exact replay', () => {
  const task = accept();
  const call = admitProviderCall({
    task,
    logicalToolCallId: 'logical:crossing-conflict',
    physicalDispatchId: 'dispatch:crossing-conflict',
  });
  const input = successInput({
    task,
    logicalToolCallId: call.identity.logicalToolCallId,
    tool: call.tool,
    args: call.args,
  });
  assert.equal(store.commitLogicalCallSettlement(input).status, 'committed');

  const db = eventlog.openEventLog();
  const original = db.prepare(`
    SELECT * FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, call.identity.logicalToolCallId) as Record<string, unknown>;
  db.exec('DROP TRIGGER trg_physical_dispatch_requires_open_logical');
  db.prepare(`
    INSERT INTO physical_dispatches
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       physical_dispatch_id, ordinal, relation, retry_of, tool_name,
       argument_digest, state, started_at, settled_at, start_event_id, settle_event_id)
    VALUES (?, ?, ?, ?, ?, 2, 'child', NULL, ?, ?, 'returned', ?, ?, ?, ?)
  `).run(
    task.sessionId,
    task.sourceUserSeq,
    task.acceptedTaskId,
    call.identity.logicalToolCallId,
    'dispatch:late-corruption',
    original.tool_name,
    original.argument_digest,
    original.started_at,
    original.settled_at,
    original.start_event_id,
    original.settle_event_id,
  );
  db.exec(`
    CREATE TRIGGER trg_physical_dispatch_requires_open_logical
    BEFORE INSERT ON physical_dispatches
    WHEN NOT EXISTS (
      SELECT 1 FROM logical_tool_calls
       WHERE session_id = NEW.session_id
         AND source_user_seq = NEW.source_user_seq
         AND logical_tool_call_id = NEW.logical_tool_call_id
         AND accepted_task_id = NEW.accepted_task_id
         AND state = 'open'
    )
    BEGIN
      SELECT RAISE(ABORT, 'physical dispatch requires its exact open logical parent');
    END;
  `);

  const result = store.commitLogicalCallSettlement(input);
  assert.deepEqual(result, {
    status: 'conflict',
    reason: 'logical settlement replay conflicts with durable authority',
    poisoned: true,
  });
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM logical_call_settlement_crossings
      WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
      .get(task.sessionId, task.sourceUserSeq, call.identity.logicalToolCallId) as { n: number }).n,
    1,
    'the corrupt late crossing is not promoted into the frozen settlement',
  );
});

function runSettlementRaceChild(input: {
  script: string;
  payload: store.CommitLogicalCallSettlementInput;
  ready: string;
  barrier: string;
}): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', input.script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOGICAL_SETTLEMENT_PAYLOAD: JSON.stringify(input.payload),
        LOGICAL_SETTLEMENT_READY: input.ready,
        LOGICAL_SETTLEMENT_BARRIER: input.barrier,
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('concurrent exact committers serialize to one settlement and one replay', async () => {
  const task = accept();
  const call = admitProviderCall({
    task,
    logicalToolCallId: 'logical:concurrent',
    physicalDispatchId: 'dispatch:concurrent',
  });
  const payload = successInput({
    task,
    logicalToolCallId: call.identity.logicalToolCallId,
    tool: call.tool,
    args: call.args,
    progressIdentity: 'concurrent-completed-step',
  });
  const script = path.join(TMP_HOME, 'logical-settlement-race-child.mts');
  const barrier = path.join(TMP_HOME, 'logical-settlement-race.release');
  const readyOne = path.join(TMP_HOME, 'logical-settlement-race.one.ready');
  const readyTwo = path.join(TMP_HOME, 'logical-settlement-race.two.ready');
  const storePath = path.resolve('src/runtime/harness/logical-call-settlement-store.ts');
  writeFileSync(script, `
    import { existsSync, writeFileSync } from 'node:fs';
    const payload = JSON.parse(process.env.LOGICAL_SETTLEMENT_PAYLOAD || '{}');
    const ready = process.env.LOGICAL_SETTLEMENT_READY || '';
    const barrier = process.env.LOGICAL_SETTLEMENT_BARRIER || '';
    const store = await import(${JSON.stringify(storePath)});
    writeFileSync(ready, 'ready');
    while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 2));
    const result = store.commitLogicalCallSettlement(payload);
    console.log(JSON.stringify({ status: result.status }));
  `, 'utf8');
  const first = runSettlementRaceChild({ script, payload, ready: readyOne, barrier });
  const second = runSettlementRaceChild({ script, payload, ready: readyTwo, barrier });
  const deadline = Date.now() + 30_000;
  while ((!existsSync(readyOne) || !existsSync(readyTwo)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(existsSync(readyOne) && existsSync(readyTwo), 'both processes reached the same barrier');
  writeFileSync(barrier, 'release\n', 'utf8');
  const results = await Promise.all([first, second]);
  for (const result of results) assert.equal(result.code, 0, result.output);
  const statuses = results.map((result) => {
    const line = result.output.trim().split('\n')
      .findLast((entry) => entry.startsWith('{') && entry.includes('"status"'));
    return (JSON.parse(line ?? '{}') as { status?: string }).status;
  }).sort();
  assert.deepEqual(statuses, ['committed', 'replayed']);
  const db = eventlog.openEventLog();
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM logical_call_settlements
      WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
      .get(task.sessionId, task.sourceUserSeq, call.identity.logicalToolCallId) as { n: number }).n,
    1,
  );
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['tool_attempt_settled'] }).length, 1);
});
