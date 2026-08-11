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

test('candidate failure, discovery recovery, settlement, and mirror commit as one verdict', () => {
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
  assert.equal(first.settlement.recovery.governorOutcome, 'epoch_opened');
  assert.equal(first.settlement.recovery.openedDiscoveryEpoch, true);
  assert.equal(governor.getTaskState(task)?.policy.epoch, 1);

  const replay = store.commitLogicalCallSettlement(input);
  assert.equal(replay.status, 'replayed');
  assert.equal(governor.getTaskState(task)?.policy.epoch, 1, 'exact replay cannot mint another epoch');
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
