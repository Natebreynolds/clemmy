import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-fanout-result-lineage-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-fanout-result-lineage\n');

const fanout = await import('./durable-fanout.js');
const tasks = await import('./background-tasks.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const shadow = await import('../runtime/graph/turn-graph-shadow.js');
const identities = await import('../runtime/harness/attempt-identity.js');
const dispatch = await import('../runtime/harness/dispatch-ledger.js');
const outcomes = await import('../runtime/harness/attempt-outcome.js');
const settlements = await import('../runtime/harness/logical-call-settlement-store.js');
const backgroundTaskTools = await import('../tools/background-task-tools.js');
const toolOutputContext = await import('../runtime/harness/tool-output-context.js');

test.after(() => {
  fanout.closeDurableFanoutForTests();
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function disposition(items: string[]) {
  return {
    kind: 'durable_manifest' as const,
    objective: 'Scrape the accounts and write them to the sheet',
    successCriteria: ['every source payload is retained', 'the sheet receives every account'],
    missingRequiredInputs: [],
    effectCeiling: 'write' as const,
    estimatedActivations: items.length * 2,
    manifest: {
      manifestId: `compound-${++serial}`,
      contractVersion: 'v1',
      canonicalItems: items.map((id) => ({ id, inputRef: `account:${id}` })),
      phases: [
        { id: 'scrape', dependsOn: [] as string[], runnerClass: 'worker', resultKind: 'data' as const },
        { id: 'sheet-write', dependsOn: ['scrape'], runnerClass: 'worker', resultKind: 'action' as const },
      ],
      reducer: {
        id: 'reduce',
        requiredPhases: ['scrape', 'sheet-write'],
        outputContract: 'sheet-delivery@1',
      },
    },
  };
}

function origin() {
  const session = eventlog.createSession({ id: `fanout-origin-${serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Scrape the accounts and put them in a sheet.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

function acceptedWorkerSource(runSessionId: string, label: string) {
  if (!eventlog.getSession(runSessionId)) {
    eventlog.createSession({ id: runSessionId, kind: 'execution', title: label });
  }
  const source = eventlog.appendEvent({
    sessionId: runSessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: label },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: runSessionId, sourceUserSeq: source.seq, turn: 1 },
    surface: 'background',
  }));
  return {
    sessionId: runSessionId,
    sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(runSessionId, source.seq),
    turn: 1,
  };
}

function successfulSourceCall(input: {
  task: ReturnType<typeof acceptedWorkerSource>;
  logicalToolCallId: string;
  payload: unknown;
  executionSite?: 'host';
  businessCall?: boolean;
  mutating?: boolean;
}) {
  const tool = input.executionSite === 'host' ? 'fixture_local_records' : 'fixture_accounts_scrape';
  const args = { account: input.logicalToolCallId };
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      ...input.task,
      logicalToolCallId: input.logicalToolCallId,
      physicalDispatchId: `physical-${input.logicalToolCallId}`,
      ordinal: 0,
    },
    tool,
    args,
    ...(input.executionSite ? { executionSite: input.executionSite } : {}),
  });
  assert.equal(started.status, 'inserted', JSON.stringify(started));
  if (started.status !== 'inserted') throw new Error('source fixture did not dispatch');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool,
    outcome: 'returned',
  }).status, 'inserted');
  const committed = settlements.commitLogicalCallSettlement({
    identity: {
      sessionId: input.task.sessionId,
      sourceUserSeq: input.task.sourceUserSeq,
      acceptedTaskId: input.task.acceptedTaskId,
      logicalToolCallId: input.logicalToolCallId,
    },
    contract: { toolName: tool, args },
    execution: { kind: input.executionSite === 'host' ? 'local_execution' : 'provider_execution' },
    result: { payload: input.payload },
    outcome: outcomes.classifyAttemptOutcome(input.mutating
      ? { mutating: true, acknowledged: true }
      : input.executionSite === 'host'
        ? { hostExecuted: true }
        : { envelopeSuccessful: true }),
    recovery: { businessCall: input.businessCall ?? true, mutating: input.mutating ?? false },
    observer: { lane: 'composio', turn: 1 },
  });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  if (committed.status !== 'committed' || (!input.mutating && !committed.settlement.resultHandleId)) {
    throw new Error('source fixture did not retain a successful result');
  }
  return {
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    acceptedTaskId: input.task.acceptedTaskId,
    logicalToolCallId: input.logicalToolCallId,
    resultHandleId: committed.settlement.resultHandleId ?? 'rh_mutation_is_not_data_authority',
  };
}

function unknownSourceCall(task: ReturnType<typeof acceptedWorkerSource>, logicalToolCallId: string) {
  const tool = 'fixture_unknown_read';
  const args = { query: logicalToolCallId };
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId,
      physicalDispatchId: `physical-${logicalToolCallId}`,
      ordinal: 0,
    },
    tool,
    args,
  });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') throw new Error('unknown fixture did not dispatch');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool,
    outcome: 'returned',
  }).status, 'inserted');
  const committed = settlements.commitLogicalCallSettlement({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId,
    },
    contract: { toolName: tool, args },
    execution: { kind: 'provider_execution' },
    result: { payload: { opaque: 'provider did not say whether this worked' } },
    outcome: outcomes.classifyAttemptOutcome({ text: 'maybe' }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'composio', turn: 1 },
  });
  assert.equal(committed.status, 'committed');
  return {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId,
    resultHandleId: 'rh_unknown_is_not_success_authority',
  };
}

function schedulerState(taskId: string): 'alive' | 'done' | 'failed' | 'missing' {
  const task = tasks.getBackgroundTask(taskId);
  if (!task) return 'missing';
  if (task.status === 'done') return 'done';
  if (['failed', 'blocked', 'aborted'].includes(task.status)) return 'failed';
  return 'alive';
}

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content?: Array<{ text?: string }>;
}>;

function registeredFanoutHandlers(schemas?: Map<string, Record<string, unknown>>): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  backgroundTaskTools.registerBackgroundTaskTools({
    tool(name: string, _description: string, schema: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
      if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
        schemas?.set(name, schema as Record<string, unknown>);
      }
    },
  } as never);
  return handlers;
}

async function invokeFanoutTool(
  handler: ToolHandler,
  sessionId: string,
  input: Record<string, unknown>,
  sourceUserSeq?: number,
): Promise<string> {
  const result = await toolOutputContext.withToolOutputContext({
    sessionId,
    ...(sourceUserSeq ? { sourceUserSeq } : {}),
  }, () => handler(input));
  return result.content?.[0]?.text ?? '';
}

test('one 100-record (>16KB) source survives crash and write failure without a second provider read', () => {
  const acceptedOrigin = origin();
  const admitted = fanout.admitDurableFanoutPlan(disposition(['accounts-batch']), {
    originSessionId: acceptedOrigin.sessionId,
    sourceUserSeq: acceptedOrigin.sourceUserSeq,
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  if (!admitted.ok) return;
  const planId = admitted.plan.planId;
  const firstTask = fanout.scheduleDurableFanout(planId)?.workerTasks[0];
  assert.ok(firstTask);

  let providerReads = 0;
  const accountRecords = Array.from({ length: 100 }, (_, index) => ({
    id: `acct-${String(index + 1).padStart(3, '0')}`,
    name: `Account ${index + 1}`,
    detail: `source-${index}-${'x'.repeat(220)}`,
  }));
  const payload = {
    successful: true,
    data: { records: accountRecords },
    meta: { complete: true },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') > 16_000,
    'the durable source fixture must exceed one ordinary compact result');
  providerReads += 1;
  const workerSource = acceptedWorkerSource(firstTask!.runSessionId, 'scrape the account batch');
  const sourceResult = successfulSourceCall({
    task: workerSource,
    logicalToolCallId: 'scrape-accounts-once',
    payload,
  });
  const bareReceipt = fanout.settleFanoutActivationAs({
    planId,
    itemId: 'accounts-batch',
    phaseId: 'scrape',
    status: 'done',
    receiptRef: '100 accounts scraped',
    callerRunSessionId: firstTask!.runSessionId,
  });
  assert.equal(bareReceipt.settled, false, 'prose receipt was accepted as source data');
  assert.match('reason' in bareReceipt ? bareReceipt.reason : '', /bare receipt is not data completion/i);
  assert.deepEqual(fanout.settleFanoutActivationAs({
    planId,
    itemId: 'accounts-batch',
    phaseId: 'scrape',
    status: 'done',
    dataResult: sourceResult,
    callerRunSessionId: firstTask!.runSessionId,
  }), { settled: true, alreadySettled: false });

  // Process dies after the read settlement but before the dependent write.
  assert.equal(tasks.markBackgroundTaskFailed(firstTask!.id, 'worker crashed before sheet write')?.status, 'failed');
  fanout.closeDurableFanoutForTests();
  eventlog.closeEventLog();

  const afterCrash = fanout.redeemFanoutSettlementData({
    planId,
    itemId: 'accounts-batch',
    phaseId: 'scrape',
  });
  assert.equal(afterCrash.status, 'ok', JSON.stringify(afterCrash));
  if (afterCrash.status !== 'ok') return;
  const rawJson = JSON.stringify(payload);
  assert.equal(afterCrash.rawPayloadJson, rawJson, 'restart did not return the exact retained source bytes');
  assert.equal(afterCrash.binding.rawPayloadSha256, createHash('sha256').update(rawJson).digest('hex'));
  assert.equal(afterCrash.binding.rawByteCount, Buffer.byteLength(rawJson));

  const firstRecovery = fanout.reconcileDurableFanout({ taskState: schedulerState });
  assert.ok(firstRecovery.rescheduled.includes(planId));
  const secondTask = fanout.listFanoutWindows(planId)[0];
  assert.ok(secondTask?.workerTaskId && secondTask.runSessionId);
  let sheetWrites = 0;
  sheetWrites += 1;
  assert.deepEqual(fanout.settleFanoutActivationAs({
    planId,
    itemId: 'accounts-batch',
    phaseId: 'sheet-write',
    status: 'failed',
    receiptRef: 'sheet provider returned 503',
    callerRunSessionId: secondTask!.runSessionId!,
  }), { settled: true, alreadySettled: false });
  const failedWrite = fanout.listFanoutActivations(planId)
    .find((row) => row.itemId === 'accounts-batch' && row.phaseId === 'sheet-write');
  assert.equal(failedWrite?.receiptRef, 'sheet provider returned 503', 'failed action receipt was lost');
  tasks.markBackgroundTaskFailed(secondTask!.workerTaskId!, 'sheet provider returned 503');

  fanout.closeDurableFanoutForTests();
  eventlog.closeEventLog();
  const secondRecovery = fanout.reconcileDurableFanout({ taskState: schedulerState });
  assert.ok(secondRecovery.rescheduled.includes(planId));
  const thirdTask = fanout.listFanoutWindows(planId)[0];
  assert.ok(thirdTask?.workerTaskId && thirdTask.runSessionId);
  const retainedForRetry = fanout.redeemFanoutSettlementData({
    planId,
    itemId: 'accounts-batch',
    phaseId: 'scrape',
  });
  assert.equal(retainedForRetry.status, 'ok');
  assert.equal(retainedForRetry.status === 'ok' ? retainedForRetry.rawPayloadJson : '', rawJson);
  sheetWrites += 1;
  assert.deepEqual(fanout.settleFanoutActivationAs({
    planId,
    itemId: 'accounts-batch',
    phaseId: 'sheet-write',
    status: 'done',
    receiptRef: 'sheet:accounts-100 range:A1:C101',
    callerRunSessionId: thirdTask!.runSessionId!,
  }), { settled: true, alreadySettled: false });
  tasks.markBackgroundTaskDone(thirdTask!.workerTaskId!, 'sheet write completed');
  fanout.reconcileDurableFanout({ taskState: schedulerState });

  assert.equal(providerReads, 1, 'resume re-ran the paid source/provider read');
  assert.equal(sheetWrites, 2, 'fixture did not exercise one failed and one successful write');
  const sourceRows = eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND tool_name = 'fixture_accounts_scrape'
  `).get(workerSource.sessionId, workerSource.sourceUserSeq) as { n: number };
  assert.equal(sourceRows.n, 1, 'restart created a second durable provider crossing');
  const handleRows = eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM durable_result_handles WHERE handle_id = ?
  `).get(sourceResult.resultHandleId) as { n: number };
  assert.equal(handleRows.n, 1, 'fan-out duplicated the retained provider payload instead of referencing it');
  assert.equal(fanout.fanoutReducerReady(planId).ready, true);
});

test('cross-worker, forged-handle, and reversed two-read bindings refuse or remain exact', () => {
  const acceptedOrigin = origin();
  const admitted = fanout.admitDurableFanoutPlan(disposition(['acct-a', 'acct-b']), {
    originSessionId: acceptedOrigin.sessionId,
    sourceUserSeq: acceptedOrigin.sourceUserSeq,
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  if (!admitted.ok) return;
  const planId = admitted.plan.planId;
  const task = fanout.scheduleDurableFanout(planId)?.workerTasks[0];
  assert.ok(task);
  const source = acceptedWorkerSource(task!.runSessionId, 'read two accounts');
  const localBlob = `local-${'z'.repeat(25_000)}-tail`;
  const resultA = successfulSourceCall({
    task: source,
    logicalToolCallId: 'read-account-a',
    payload: { successful: true, data: { records: [{ id: 'acct-a', marker: 'A', localBlob }] }, meta: { complete: true } },
    executionSite: 'host',
    businessCall: false,
  });
  const resultB = successfulSourceCall({
    task: source,
    logicalToolCallId: 'read-account-b',
    payload: { successful: true, data: { records: [{ id: 'acct-b', marker: 'B' }] }, meta: { complete: true } },
  });

  assert.equal(fanout.unboundFanoutDataResults({
    planId,
    callerRunSessionId: task!.runSessionId,
    sourceUserSeq: source.sourceUserSeq,
  }).length, 2, 'two reads became an unsafe implicit latest-result binding');
  const mutatingResult = successfulSourceCall({
    task: source,
    logicalToolCallId: 'write-shaped-result',
    payload: { successful: true, id: 'external-write-receipt' },
    mutating: true,
  });
  const mutationAsData = fanout.settleFanoutActivationAs({
    planId,
    itemId: 'acct-a',
    phaseId: 'scrape',
    status: 'done',
    dataResult: mutatingResult,
    callerRunSessionId: task!.runSessionId,
  });
  assert.equal(mutationAsData.settled, false, 'a mutation result was accepted as source data');
  const unknownResult = unknownSourceCall(source, 'unknown-read-result');
  const unknownAsData = fanout.settleFanoutActivationAs({
    planId,
    itemId: 'acct-a',
    phaseId: 'scrape',
    status: 'done',
    dataResult: unknownResult,
    callerRunSessionId: task!.runSessionId,
  });
  assert.equal(unknownAsData.settled, false, 'an unknown logical outcome was accepted as source data');
  const forged = fanout.settleFanoutActivationAs({
    planId,
    itemId: 'acct-b',
    phaseId: 'scrape',
    status: 'done',
    dataResult: { ...resultB, resultHandleId: resultA.resultHandleId },
    callerRunSessionId: task!.runSessionId,
  });
  assert.equal(forged.settled, false, 'a result handle from another logical call was accepted');

  const foreignSession = `foreign-worker-${serial}`;
  eventlog.createSession({ id: foreignSession, kind: 'execution' });
  const crossWorker = fanout.settleFanoutActivationAs({
    planId,
    itemId: 'acct-b',
    phaseId: 'scrape',
    status: 'done',
    dataResult: resultB,
    callerRunSessionId: foreignSession,
  });
  assert.equal(crossWorker.settled, false, 'a worker without this window settled its data');

  // Settle in reverse item order with explicit exact refs; payloads cannot swap.
  assert.equal(fanout.settleFanoutActivationAs({
    planId,
    itemId: 'acct-b',
    phaseId: 'scrape',
    status: 'done',
    dataResult: resultB,
    callerRunSessionId: task!.runSessionId,
  }).settled, true);
  assert.equal(fanout.settleFanoutActivationAs({
    planId,
    itemId: 'acct-a',
    phaseId: 'scrape',
    status: 'done',
    dataResult: resultA,
    callerRunSessionId: task!.runSessionId,
  }).settled, true);
  const redeemedA = fanout.redeemFanoutSettlementData({ planId, itemId: 'acct-a', phaseId: 'scrape' });
  const redeemedB = fanout.redeemFanoutSettlementData({ planId, itemId: 'acct-b', phaseId: 'scrape' });
  assert.equal(redeemedA.status, 'ok');
  assert.equal(redeemedB.status, 'ok');
  assert.equal(redeemedA.status === 'ok' ? (redeemedA.rawPayload as any).data.records[0].marker : '', 'A');
  assert.equal(redeemedB.status === 'ok' ? (redeemedB.rawPayload as any).data.records[0].marker : '', 'B');
  const pages: string[] = [];
  let offset = 0;
  for (;;) {
    const page = fanout.readFanoutSettlementDataPage({
      planId,
      itemId: 'acct-a',
      phaseId: 'scrape',
      offset,
      limit: 4_000,
    });
    assert.equal(page.status, 'ok', JSON.stringify(page));
    if (page.status !== 'ok') break;
    pages.push(page.text);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.equal(pages.join(''), redeemedA.status === 'ok' ? redeemedA.rawPayloadJson : '',
    'the dedicated activation reader did not reconstruct the exact >4KB local payload');
  assert.equal((redeemedA.status === 'ok' ? redeemedA.rawPayloadJson : '').endsWith('tail"}]},"meta":{"complete":true}}'), true);
});

test('model-facing settlement names only a logical source call while the host binds its opaque result handle', async () => {
  const schemas = new Map<string, Record<string, unknown>>();
  const handlers = registeredFanoutHandlers(schemas);
  const settleItem = handlers.get('fanout_settle_item');
  assert.ok(settleItem);
  assert.equal('source_result_handle' in (schemas.get('fanout_settle_item') ?? {}), false,
    'the model-facing schema still asks the worker to traffic an opaque rh_ handle');

  const acceptedOrigin = origin();
  const admitted = fanout.admitDurableFanoutPlan(disposition(['acct-call-a', 'acct-call-b']), {
    originSessionId: acceptedOrigin.sessionId,
    sourceUserSeq: acceptedOrigin.sourceUserSeq,
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  if (!admitted.ok) return;
  const planId = admitted.plan.planId;
  const task = fanout.scheduleDurableFanout(planId)?.workerTasks[0];
  assert.ok(task);
  const source = acceptedWorkerSource(task!.runSessionId, 'read two exact account sources');
  const resultA = successfulSourceCall({
    task: source,
    logicalToolCallId: 'model-call-account-a',
    payload: { successful: true, data: { records: [{ id: 'acct-call-a', marker: 'A' }] }, meta: { complete: true } },
  });
  const resultB = successfulSourceCall({
    task: source,
    logicalToolCallId: 'model-call-account-b',
    payload: { successful: true, data: { records: [{ id: 'acct-call-b', marker: 'B' }] }, meta: { complete: true } },
  });

  const ambiguous = await invokeFanoutTool(settleItem!, task!.runSessionId, {
    plan_id: planId,
    item_id: 'acct-call-a',
    phase_id: 'scrape',
    status: 'done',
    receipt: 'account A read',
    source_call_id: null,
  }, source.sourceUserSeq);
  assert.match(ambiguous, /auto-binding found 2/i);
  assert.match(ambiguous, /model-call-account-a/);
  assert.match(ambiguous, /model-call-account-b/);
  assert.doesNotMatch(ambiguous, /rh_[a-z0-9]+/i, 'an internal durable handle leaked into model repair');

  const forged = await invokeFanoutTool(settleItem!, task!.runSessionId, {
    plan_id: planId,
    item_id: 'acct-call-a',
    phase_id: 'scrape',
    status: 'done',
    receipt: 'forged source id',
    source_call_id: 'model-call-does-not-exist',
  }, source.sourceUserSeq);
  assert.match(forged, /not one unclaimed successful non-mutating result/i);

  // Settle in reverse order. The host resolves each logical id to the immutable
  // settlement-bound handle; the model never receives or resubmits either rh_.
  const settledB = await invokeFanoutTool(settleItem!, task!.runSessionId, {
    plan_id: planId,
    item_id: 'acct-call-b',
    phase_id: 'scrape',
    status: 'done',
    receipt: 'account B read',
    source_call_id: 'model-call-account-b',
  }, source.sourceUserSeq);
  assert.match(settledB, /^Settled acct-call-b × scrape/);
  const settledA = await invokeFanoutTool(settleItem!, task!.runSessionId, {
    plan_id: planId,
    item_id: 'acct-call-a',
    phase_id: 'scrape',
    status: 'done',
    receipt: 'account A read',
    source_call_id: 'model-call-account-a',
  }, source.sourceUserSeq);
  assert.match(settledA, /^Settled acct-call-a × scrape/);

  const activationA = fanout.listFanoutActivations(planId)
    .find((row) => row.itemId === 'acct-call-a' && row.phaseId === 'scrape');
  const activationB = fanout.listFanoutActivations(planId)
    .find((row) => row.itemId === 'acct-call-b' && row.phaseId === 'scrape');
  assert.equal(activationA?.dataResult?.logicalToolCallId, resultA.logicalToolCallId);
  assert.equal(activationA?.dataResult?.resultHandleId, resultA.resultHandleId);
  assert.equal(activationB?.dataResult?.logicalToolCallId, resultB.logicalToolCallId);
  assert.equal(activationB?.dataResult?.resultHandleId, resultB.resultHandleId);

  const foreignSource = acceptedWorkerSource('foreign-model-facing-worker', 'foreign worker source');
  successfulSourceCall({
    task: foreignSource,
    logicalToolCallId: 'foreign-account-call',
    payload: { successful: true, data: { records: [{ id: 'acct-call-a', marker: 'FOREIGN' }] } },
  });
  const crossWorker = await invokeFanoutTool(settleItem!, foreignSource.sessionId, {
    plan_id: planId,
    item_id: 'acct-call-a',
    phase_id: 'sheet-write',
    status: 'done',
    receipt: 'foreign write receipt',
    source_call_id: null,
  }, foreignSource.sourceUserSeq);
  assert.match(crossWorker, /owns no claimed window|does not own a live window/i);
});

test('model-facing fan-out reads are bounded to the exact worker window or current reducer', async () => {
  const handlers = registeredFanoutHandlers();
  const listOpen = handlers.get('fanout_list_open_items');
  const listSettlements = handlers.get('fanout_list_settlements');
  const readData = handlers.get('fanout_read_settlement_data');
  assert.ok(listOpen && listSettlements && readData);

  const acceptedOrigin = origin();
  const itemIds = Array.from({ length: 257 }, (_, index) => `bounded-${String(index).padStart(3, '0')}`);
  const admitted = fanout.admitDurableFanoutPlan(disposition(itemIds), {
    originSessionId: acceptedOrigin.sessionId,
    sourceUserSeq: acceptedOrigin.sourceUserSeq,
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  if (!admitted.ok) return;
  const planId = admitted.plan.planId;
  fanout.scheduleDurableFanout(planId);
  const windows = fanout.listFanoutWindows(planId);
  assert.equal(windows.length, 2, 'fixture must cross the durable window boundary');
  const firstWindow = windows[0]!;
  const secondWindow = windows[1]!;
  assert.ok(firstWindow.runSessionId && secondWindow.runSessionId);
  const firstItem = firstWindow.itemIds[0]!;
  const secondItem = secondWindow.itemIds[0]!;

  const ownOpen = await invokeFanoutTool(listOpen!, firstWindow.runSessionId!, {
    plan_id: planId,
    limit: 200,
  });
  assert.match(ownOpen, new RegExp(firstItem));
  assert.doesNotMatch(ownOpen, new RegExp(secondItem), 'worker saw another window through open-item listing');

  const firstSource = acceptedWorkerSource(firstWindow.runSessionId!, 'read the first bounded window');
  const firstResult = successfulSourceCall({
    task: firstSource,
    logicalToolCallId: 'bounded-first-read',
    payload: { successful: true, data: { marker: 'FIRST-WINDOW-SECRET' }, meta: { complete: true } },
  });
  const secondSource = acceptedWorkerSource(secondWindow.runSessionId!, 'read the second bounded window');
  const secondResult = successfulSourceCall({
    task: secondSource,
    logicalToolCallId: 'bounded-second-read',
    payload: { successful: true, data: { marker: 'SECOND-WINDOW-SECRET' }, meta: { complete: true } },
  });
  assert.equal(fanout.settleFanoutActivationAs({
    planId,
    itemId: firstItem,
    phaseId: 'scrape',
    status: 'done',
    dataResult: firstResult,
    callerRunSessionId: firstWindow.runSessionId!,
  }).settled, true);
  assert.equal(fanout.settleFanoutActivationAs({
    planId,
    itemId: secondItem,
    phaseId: 'scrape',
    status: 'done',
    dataResult: secondResult,
    callerRunSessionId: secondWindow.runSessionId!,
  }).settled, true);

  const ownSettlements = await invokeFanoutTool(listSettlements!, firstWindow.runSessionId!, {
    plan_id: planId,
    offset: 0,
    limit: 500,
  });
  assert.match(ownSettlements, new RegExp(firstItem));
  assert.doesNotMatch(ownSettlements, new RegExp(secondItem), 'worker saw another window settlement');
  const ownData = await invokeFanoutTool(readData!, firstWindow.runSessionId!, {
    plan_id: planId,
    item_id: firstItem,
    phase_id: 'scrape',
    offset: 0,
    limit: 16_000,
  });
  assert.match(ownData, /FIRST-WINDOW-SECRET/);

  const denied = 'Fan-out data is not available to this run.';
  assert.equal(await invokeFanoutTool(readData!, firstWindow.runSessionId!, {
    plan_id: planId,
    item_id: secondItem,
    phase_id: 'scrape',
    offset: 0,
    limit: 16_000,
  }), denied, 'worker read another window payload');
  assert.equal(await invokeFanoutTool(listSettlements!, 'foreign-fanout-session', {
    plan_id: planId,
    offset: 0,
    limit: 500,
  }), denied, 'foreign session listed settlements');
  assert.equal(await invokeFanoutTool(listOpen!, 'foreign-fanout-session', {
    plan_id: planId,
    limit: 200,
  }), denied, 'foreign session listed open item ids');

  // A real worker on another plan is still foreign: plan ids are not bearer
  // capabilities and the denial must reveal none of the named payload.
  const reducerOrigin = origin();
  const reducerAdmitted = fanout.admitDurableFanoutPlan(disposition(['reducer-item']), {
    originSessionId: reducerOrigin.sessionId,
    sourceUserSeq: reducerOrigin.sourceUserSeq,
  });
  assert.equal(reducerAdmitted.ok, true, JSON.stringify(reducerAdmitted));
  if (!reducerAdmitted.ok) return;
  const reducerPlanId = reducerAdmitted.plan.planId;
  const reducerWorker = fanout.scheduleDurableFanout(reducerPlanId)?.workerTasks[0];
  assert.ok(reducerWorker);
  assert.equal(await invokeFanoutTool(readData!, reducerWorker!.runSessionId, {
    plan_id: planId,
    item_id: firstItem,
    phase_id: 'scrape',
    offset: 0,
    limit: 16_000,
  }), denied, 'a worker used its authority on another plan');

  const reducerSource = acceptedWorkerSource(reducerWorker!.runSessionId, 'read reducer input once');
  const reducerResult = successfulSourceCall({
    task: reducerSource,
    logicalToolCallId: 'reducer-source-read',
    payload: { successful: true, data: { marker: 'REDUCER-ONLY-SECRET' }, meta: { complete: true } },
  });
  assert.equal(fanout.settleFanoutActivationAs({
    planId: reducerPlanId,
    itemId: 'reducer-item',
    phaseId: 'scrape',
    status: 'done',
    dataResult: reducerResult,
    callerRunSessionId: reducerWorker!.runSessionId,
  }).settled, true);
  assert.equal(fanout.settleFanoutActivationAs({
    planId: reducerPlanId,
    itemId: 'reducer-item',
    phaseId: 'sheet-write',
    status: 'done',
    receiptRef: 'sheet write verified',
    callerRunSessionId: reducerWorker!.runSessionId,
  }).settled, true);
  assert.equal(tasks.markBackgroundTaskDone(reducerWorker!.id, 'source retained')?.status, 'done');
  const reconciled = fanout.reconcileDurableFanout({ taskState: schedulerState });
  assert.equal(reconciled.reduced.includes(reducerPlanId), true, 'fixture did not admit its reducer');
  const reducerPlan = fanout.loadFanoutPlan(reducerPlanId);
  assert.equal(reducerPlan?.reducerState, 'admitted');
  const reducerTask = reducerPlan?.reducerTaskId ? tasks.getBackgroundTask(reducerPlan.reducerTaskId) : null;
  assert.ok(reducerTask);

  const reducerSettlements = await invokeFanoutTool(listSettlements!, reducerTask!.runSessionId, {
    plan_id: reducerPlanId,
    offset: 0,
    limit: 500,
  });
  assert.match(reducerSettlements, /reducer-item/);
  const reducerData = await invokeFanoutTool(readData!, reducerTask!.runSessionId, {
    plan_id: reducerPlanId,
    item_id: 'reducer-item',
    phase_id: 'scrape',
    offset: 0,
    limit: 16_000,
  });
  assert.match(reducerData, /REDUCER-ONLY-SECRET/);
  assert.equal(await invokeFanoutTool(listOpen!, reducerTask!.runSessionId, {
    plan_id: reducerPlanId,
    limit: 200,
  }), denied, 'reducer acquired worker-only open-item authority');

  assert.equal(fanout.recordFanoutReducerOutcome(reducerPlanId, {
    taskId: reducerTask!.id,
    outcome: 'failed',
  }), true);
  const staleRead = await invokeFanoutTool(readData!, reducerTask!.runSessionId, {
    plan_id: reducerPlanId,
    item_id: 'reducer-item',
    phase_id: 'scrape',
    offset: 0,
    limit: 16_000,
  });
  assert.equal(staleRead, denied, 'failed reducer retained read authority');
  assert.doesNotMatch(staleRead, /REDUCER-ONLY-SECRET/);
});
