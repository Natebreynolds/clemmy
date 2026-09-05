/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/harness/logical-model-result-projection-receipt.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import Database from 'better-sqlite3';
import type { LogicalModelResultProjectionReceiptRow } from './logical-model-result-projection-receipt.js';
import { HARNESS_SCHEMA_VERSION } from './schema-version.js';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-logical-projection-receipt-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-logical-projection-receipt\n');

const eventlog = await import('./eventlog.js');
const schema = await import('./eventlog-schema.js');
const authority = await import('./accepted-turn-call-authority.js');
const checkpoints = await import('./accepted-model-batch-checkpoint.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./logical-call-contract.js');
const dispatch = await import('./dispatch-ledger.js');
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');
const projections = await import('./logical-model-result-projection-receipt.js');
const hostResults = await import('./host-model-result-receipt.js');
const compaction = await import('./compaction.js');
const provenance = await import('./model-request-provenance.js');
const promptCache = await import('./prompt-cache-observation.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
let serial = 0;

interface AcceptedFixture {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  turn: number;
  text: string;
}

function accept(label: string, existingSessionId?: string): AcceptedFixture {
  const sessionId = existingSessionId ?? eventlog.createSession({
    id: `logical-projection-${++serial}-${label}`,
    kind: 'chat',
  }).id;
  const text = `Handle the exact ${label} request.`;
  const source = eventlog.appendEvent({
    sessionId,
    turn: serial + 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const armed = authority.armHostReadOnlyCallAuthority({
    sessionId,
    sourceUserSeq: source.seq,
    surfaceVersion: 'configured_harness_tools_v1',
    catalogRevisionDigest: digest(`catalog:${sessionId}:${source.seq}`),
    bindingRevisionDigest: digest(`bindings:${sessionId}:${source.seq}`),
    maxLogicalCalls: 8,
    maxParallelCalls: 4,
  });
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  return {
    sessionId,
    sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(sessionId, source.seq),
    turn: source.turn,
    text,
  };
}

function frame(input: {
  callId: string;
  toolName: string;
  args?: unknown;
  namespace?: string;
}): AgentInputItem[] {
  return [{
    type: 'function_call',
    callId: input.callId,
    name: input.toolName,
    ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
    arguments: JSON.stringify(input.args ?? {}),
    status: 'completed',
  } as AgentInputItem];
}

function admit(input: {
  task: AcceptedFixture;
  callId: string;
  toolName: string;
  args?: unknown;
  namespace?: string;
}) {
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    preHistory: [{ role: 'user', content: input.task.text } as AgentInputItem],
    frameHistory: frame(input),
    providerResponseId: `response:${input.callId}`,
  });
  assert.equal(admitted.status, 'admitted', JSON.stringify(admitted));
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);
  return admitted.admission;
}

function withReadAttestation<T>(input: {
  task: AcceptedFixture;
  logicalToolCallId: string;
  toolName: string;
  args: unknown;
  run: () => T;
}): T {
  const root = authority.acceptedTurnCallAuthorityFor(
    input.task.sessionId,
    input.task.sourceUserSeq,
  );
  assert.equal(root.status, 'ok', JSON.stringify(root));
  if (root.status !== 'ok') throw new Error(root.reason);
  const contract = contracts.durableLogicalCallContract(
    input.task.acceptedTaskId,
    input.toolName,
    input.args,
  );
  assert.ok(contract);
  if (!contract) throw new Error('fixture contract is unsafe');
  return authority.withHostReadOnlyCallAttestation({
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    acceptedTaskId: input.task.acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: input.logicalToolCallId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest: root.authority.catalogRevisionDigest!,
    bindingRevisionDigest: root.authority.bindingRevisionDigest!,
  }, input.run);
}

function settleRead(input: {
  task: AcceptedFixture;
  logicalToolCallId: string;
  observerCallId?: string;
  toolName: string;
  args?: unknown;
  payload?: unknown;
}): settlements.DurableLogicalCallSettlement {
  const args = input.args ?? {};
  const physicalDispatchId = `dispatch:${input.logicalToolCallId}`;
  const started = withReadAttestation({
    task: input.task,
    logicalToolCallId: input.logicalToolCallId,
    toolName: input.toolName,
    args,
    run: () => {
      const logical = dispatch.admitLogicalCall({
        identity: {
          sessionId: input.task.sessionId,
          sourceUserSeq: input.task.sourceUserSeq,
          acceptedTaskId: input.task.acceptedTaskId,
          logicalToolCallId: input.logicalToolCallId,
        },
        tool: input.toolName,
        args,
      });
      assert.equal(logical.status, 'inserted', JSON.stringify(logical));
      return dispatch.beginPhysicalDispatch({
        identity: {
          sessionId: input.task.sessionId,
          sourceUserSeq: input.task.sourceUserSeq,
          acceptedTaskId: input.task.acceptedTaskId,
          logicalToolCallId: input.logicalToolCallId,
          physicalDispatchId,
          ordinal: 0,
        },
        tool: input.toolName,
        args,
        executionSite: 'host',
      });
    },
  });
  assert.equal(started.status, 'inserted', JSON.stringify(started));
  if (started.status !== 'inserted') throw new Error(started.reason);
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool: input.toolName,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: {
      sessionId: input.task.sessionId,
      sourceUserSeq: input.task.sourceUserSeq,
      acceptedTaskId: input.task.acceptedTaskId,
      logicalToolCallId: input.logicalToolCallId,
    },
    contract: { toolName: input.toolName, args },
    execution: { kind: 'local_execution' },
    result: { payload: input.payload ?? { ok: true } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: {
      lane: 'agents_runner',
      ...(input.observerCallId ? { callId: input.observerCallId } : {}),
      turn: input.task.turn,
    },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  if (settled.status !== 'committed') throw new Error(settled.reason);
  return settled.settlement;
}

function structuredResult(input: {
  callId: string;
  toolName: string;
  namespace?: string;
  marker?: string;
}): AgentInputItem {
  return {
    type: 'function_call_result',
    callId: input.callId,
    name: input.toolName,
    ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
    status: 'completed',
    output: {
      structuredContent: {
        marker: input.marker ?? 'exact-structured-result',
        records: [{ id: 'row-1', nested: { ready: true } }],
      },
      content: [{ type: 'text', text: 'one record' }],
    },
  } as AgentInputItem;
}

function textResult(input: {
  callId: string;
  toolName: string;
  text: string;
}): AgentInputItem {
  return {
    type: 'function_call_result',
    callId: input.callId,
    name: input.toolName,
    status: 'completed',
    output: { type: 'text', text: input.text },
  } as AgentInputItem;
}

function modelRequest(input: {
  task: AcceptedFixture;
  callId: string;
  toolName: string;
  result: AgentInputItem;
}) {
  return {
    systemInstructions: 'Stable host policy.',
    input: [
      { role: 'user', content: input.task.text } as AgentInputItem,
      ...frame({ callId: input.callId, toolName: input.toolName }),
      input.result,
    ],
    modelSettings: {},
    tools: [],
    toolsExplicitlyProvided: true,
    outputType: 'text',
    handoffs: [],
    tracing: false,
  };
}

function compactedProjectionFixture(
  label: string,
  eventMode: 'valid' | 'absent' | 'wrong_count' = 'valid',
) {
  const task = accept(label);
  const callId = `clipped-${serial}`;
  const toolName = 'session_history';
  const admission = admit({ task, callId, toolName });
  settleRead({ task, logicalToolCallId: callId, toolName });
  const originalText = `durable-${label}-result `.repeat(80);
  const original = textResult({ callId, toolName, text: originalText });
  const receipt = projections.recordLogicalModelResultProjectionReceipt({
    admission,
    resultItem: original,
  });
  assert.equal(receipt.status, 'recorded', JSON.stringify(receipt));
  eventlog.writeToolOutput({ sessionId: task.sessionId, callId, tool: toolName, output: originalText });

  const clipped = structuredClone(original) as AgentInputItem;
  const retainedSentinel = textResult({
    callId: `retain-${callId}`,
    toolName,
    text: 'small recent result',
  });
  const clippedAt = new Date().toISOString();
  assert.equal(compaction.clipOldToolResults(
    [clipped, retainedSentinel],
    1,
    { now: () => clippedAt },
  ), 1);
  assert.ok(compaction.describeCanonicalClippedToolResult(clipped));
  if (eventMode !== 'absent') {
    eventlog.appendEvent({
      sessionId: task.sessionId,
      turn: 0,
      role: 'system',
      type: 'condenser_applied',
      data: {
        layer1: {
          applied: true,
          clipped: eventMode === 'valid' ? 1 : 0,
          collapsedToolPairs: 0,
        },
        layer2: { applied: false, removedItems: 0, summaryItems: 0 },
        layer3: { applied: false, forkRequested: false },
      },
    });
  }
  return { task, callId, toolName, clipped, clippedAt, originalText };
}

test('logical projection receipts are exact, idempotent, immutable metadata with namespace lineage', () => {
  const task = accept('direct logical projection');
  const callId = 'logical-visible-call';
  const toolName = 'session_history';
  const namespace = 'records';
  const admission = admit({ task, callId, toolName, namespace });
  const settlement = settleRead({ task, logicalToolCallId: callId, toolName });
  const item = structuredResult({ callId, toolName, namespace });

  const first = projections.recordLogicalModelResultProjectionReceipt({
    admission,
    resultItem: item,
    now: () => '2026-08-29T20:00:00.000Z',
  });
  assert.equal(first.status, 'recorded', JSON.stringify(first));
  if (first.status !== 'recorded') return;
  assert.equal(first.receipt.settlementIdentityKind, 'logical');
  assert.equal(first.receipt.settlementLogicalToolCallId, callId);
  assert.equal(first.receipt.settlementEventId, settlement.settlementEventId);
  assert.equal(first.receipt.settlementSemanticDigest, settlement.semanticDigest);
  assert.equal(first.receipt.callNamespace, namespace);
  assert.equal(first.receipt.resultClass, 'structured');
  assert.equal(first.receipt.resultItemSha256, projections.logicalModelResultItemDigest(item));
  assert.equal(
    first.receipt.resultItemBytes,
    Buffer.byteLength(projections.canonicalLogicalModelResultItemBytes(item), 'utf8'),
  );
  assert.equal(projections.logicalModelResultProjectionReceiptMatchesItem(first.receipt, item), true);

  const replay = projections.recordLogicalModelResultProjectionReceipt({ admission, resultItem: item });
  assert.equal(replay.status, 'existing', JSON.stringify(replay));
  if (replay.status === 'existing') assert.equal(replay.receipt.receiptId, first.receipt.receiptId);

  const changed = projections.recordLogicalModelResultProjectionReceipt({
    admission,
    resultItem: structuredResult({ callId, toolName, namespace, marker: 'different bytes' }),
  });
  assert.equal(changed.status, 'conflict', JSON.stringify(changed));

  const namespaceMismatch = projections.recordLogicalModelResultProjectionReceipt({
    admission,
    resultItem: structuredResult({ callId, toolName, namespace: 'other-namespace' }),
  });
  assert.equal(namespaceMismatch.status, 'missing', JSON.stringify(namespaceMismatch));

  const db = eventlog.openEventLog();
  const columnRows = db.prepare(`PRAGMA table_info(logical_model_result_projection_receipts)`).all() as Array<{ name: string }>;
  const columns = columnRows.map((column) => column.name);
  assert.equal(columns.some((name) => /json|payload|output/i.test(name)), false,
    'the metadata receipt must not copy model/provider result bytes');
  assert.throws(
    () => db.prepare(`UPDATE logical_model_result_projection_receipts
      SET recorded_at = recorded_at WHERE receipt_id = ?`).run(first.receipt.receiptId),
    /immutable/,
  );
  assert.throws(
    () => db.prepare(`DELETE FROM logical_model_result_projection_receipts
      WHERE receipt_id = ?`).run(first.receipt.receiptId),
    /immutable/,
  );
});

test('trusted local compaction preserves settled lineage without accepting forged result bytes', () => {
  const valid = compactedProjectionFixture('trusted local compaction');
  // A later idempotent cache/recovery write may refresh this timestamp. The
  // immutable receipt match—not cache chronology—owns the original bytes.
  const refreshed = eventlog.openEventLog().prepare(`
    UPDATE tool_outputs SET created_at = ?
    WHERE session_id = ? AND call_id = ?
  `).run(
    new Date(Date.parse(valid.clippedAt) + 1_000).toISOString(),
    valid.task.sessionId,
    valid.callId,
  );
  assert.equal(refreshed.changes, 1);
  const request = modelRequest({ ...valid, result: valid.clipped });
  const recorded = provenance.recordModelRequestDispatchProvenance({
    sessionId: valid.task.sessionId,
    sourceUserSeq: valid.task.sourceUserSeq,
    request: request as never,
    hostProjection: promptCache.canonicalPromptCacheRequest(request as never),
  });
  assert.equal(recorded.removedOptionalLayer, null);
  assert.equal(provenance.projectModelRequestProvenance(recorded.record.recordId).status, 'ok');

  const tamperedText = structuredClone(valid.clipped) as AgentInputItem;
  const tamperedOutput = (tamperedText as unknown as {
    output: { text: string };
  }).output;
  tamperedOutput.text += ' forged';
  const tamperedTextRequest = modelRequest({ ...valid, result: tamperedText });
  assert.throws(
    () => provenance.recordModelRequestDispatchProvenance({
      sessionId: valid.task.sessionId,
      sourceUserSeq: valid.task.sourceUserSeq,
      request: tamperedTextRequest as never,
      hostProjection: promptCache.canonicalPromptCacheRequest(tamperedTextRequest as never),
    }),
    (error: unknown) => error instanceof provenance.ModelRequestProvenanceError
      && error.code === 'logical_result_projection_mismatch',
    'changing the compacted bytes must not inherit the immutable result receipt',
  );

  const forgedLength = structuredClone(valid.clipped) as AgentInputItem;
  const forgedRow = forgedLength as unknown as {
    callId: string;
    name: string;
    output: { text: string };
    __clippedMeta: { bytes: number; at: string };
  };
  forgedRow.__clippedMeta.bytes += 1;
  forgedRow.output.text = compaction.canonicalToolResultClipPlaceholder(
    forgedRow.name,
    forgedRow.__clippedMeta.bytes,
    forgedRow.callId,
    forgedRow.__clippedMeta.at,
  );
  const forgedLengthRequest = modelRequest({ ...valid, result: forgedLength });
  assert.throws(
    () => provenance.recordModelRequestDispatchProvenance({
      sessionId: valid.task.sessionId,
      sourceUserSeq: valid.task.sourceUserSeq,
      request: forgedLengthRequest as never,
      hostProjection: promptCache.canonicalPromptCacheRequest(forgedLengthRequest as never),
    }),
    (error: unknown) => error instanceof provenance.ModelRequestProvenanceError
      && error.code === 'logical_result_projection_mismatch',
    'a self-consistent stub still fails when its claimed size differs from the lossless output row',
  );

  for (const eventMode of ['absent', 'wrong_count'] as const) {
    const unowned = compactedProjectionFixture(`compaction event ${eventMode}`, eventMode);
    const unownedRequest = modelRequest({ ...unowned, result: unowned.clipped });
    assert.throws(
      () => provenance.recordModelRequestDispatchProvenance({
        sessionId: unowned.task.sessionId,
        sourceUserSeq: unowned.task.sourceUserSeq,
        request: unownedRequest as never,
        hostProjection: promptCache.canonicalPromptCacheRequest(unownedRequest as never),
      }),
      (error: unknown) => error instanceof provenance.ModelRequestProvenanceError
        && error.code === 'logical_result_projection_mismatch',
      `${eventMode} condenser evidence must not authorize altered result bytes`,
    );
  }
});

test('observer identity maps exactly while host-only and cross-source calls remain distinct', () => {
  const observerTask = accept('observer projection');
  const visibleCallId = 'carrier-visible-call';
  const logicalCallId = 'paid-inner-logical-call';
  const toolName = 'session_history';
  const admission = admit({ task: observerTask, callId: visibleCallId, toolName });
  const settlement = settleRead({
    task: observerTask,
    logicalToolCallId: logicalCallId,
    observerCallId: visibleCallId,
    toolName,
  });
  const recorded = projections.recordLogicalModelResultProjectionReceipt({
    admission,
    resultItem: structuredResult({ callId: visibleCallId, toolName }),
  });
  assert.equal(recorded.status, 'recorded', JSON.stringify(recorded));
  if (recorded.status === 'recorded') {
    assert.equal(recorded.receipt.settlementIdentityKind, 'observer');
    assert.equal(recorded.receipt.settlementLogicalToolCallId, logicalCallId);
    assert.equal(recorded.receipt.settlementObserverCallId, visibleCallId);
    assert.equal(recorded.receipt.settlementEventId, settlement.settlementEventId);
  }

  const hostOnlyTask = accept('host-only result');
  const hostOnlyAdmission = admit({
    task: hostOnlyTask,
    callId: 'host-only-call',
    toolName: 'unavailable_tool',
  });
  const hostOnly = projections.recordLogicalModelResultProjectionReceipt({
    admission: hostOnlyAdmission,
    resultItem: hostResults.buildHostToolDispositionResult({
      callId: 'host-only-call',
      toolName: 'unavailable_tool',
      disposition: 'refused_pre_dispatch',
      frameDigest: digest('host-only-frame'),
      frameIndex: 0,
      frameSize: 1,
    }),
  });
  assert.equal(hostOnly.status, 'not_applicable', JSON.stringify(hostOnly));

  const firstSource = accept('cross-source logical owner');
  settleRead({
    task: firstSource,
    logicalToolCallId: 'cross-source-visible-call',
    toolName,
  });
  assert.equal(authority.closeHostReadOnlyCallAuthority({
    sessionId: firstSource.sessionId,
    sourceUserSeq: firstSource.sourceUserSeq,
    outcome: 'completed',
  }).status, 'closed');
  const secondSource = accept('cross-source candidate', firstSource.sessionId);
  const secondAdmission = admit({
    task: secondSource,
    callId: 'cross-source-visible-call',
    toolName,
  });
  const crossSource = projections.recordLogicalModelResultProjectionReceipt({
    admission: secondAdmission,
    resultItem: structuredResult({ callId: 'cross-source-visible-call', toolName }),
  });
  assert.equal(crossSource.status, 'conflict', JSON.stringify(crossSource));
});

test('carrier projections require one exact same-source observer mapping when tool names differ', () => {
  const visibleToolName = 'work_call';
  const logicalToolName = 'session_history';

  const carrierTask = accept('same-id carrier observer projection');
  const carrierCallId = 'same-id-carrier-call';
  const carrierAdmission = admit({
    task: carrierTask,
    callId: carrierCallId,
    toolName: visibleToolName,
  });
  settleRead({
    task: carrierTask,
    logicalToolCallId: carrierCallId,
    observerCallId: carrierCallId,
    toolName: logicalToolName,
  });
  const carrier = projections.recordLogicalModelResultProjectionReceipt({
    admission: carrierAdmission,
    resultItem: structuredResult({ callId: carrierCallId, toolName: visibleToolName }),
  });
  assert.equal(carrier.status, 'recorded', JSON.stringify(carrier));
  if (carrier.status === 'recorded') {
    assert.equal(carrier.receipt.settlementIdentityKind, 'observer');
    assert.equal(carrier.receipt.settlementLogicalToolCallId, carrierCallId);
    assert.equal(carrier.receipt.settlementObserverCallId, carrierCallId);
  }

  const wrongToolTask = accept('wrong carrier tool without observer');
  const wrongToolCallId = 'wrong-tool-without-observer';
  const wrongToolAdmission = admit({
    task: wrongToolTask,
    callId: wrongToolCallId,
    toolName: visibleToolName,
  });
  settleRead({
    task: wrongToolTask,
    logicalToolCallId: wrongToolCallId,
    toolName: logicalToolName,
  });
  const wrongTool = projections.recordLogicalModelResultProjectionReceipt({
    admission: wrongToolAdmission,
    resultItem: structuredResult({ callId: wrongToolCallId, toolName: visibleToolName }),
  });
  assert.equal(wrongTool.status, 'conflict', JSON.stringify(wrongTool));

  const ambiguousTask = accept('ambiguous carrier observer');
  const ambiguousCallId = 'ambiguous-carrier-observer';
  const ambiguousAdmission = admit({
    task: ambiguousTask,
    callId: ambiguousCallId,
    toolName: visibleToolName,
  });
  settleRead({
    task: ambiguousTask,
    logicalToolCallId: 'ambiguous-inner-one',
    observerCallId: ambiguousCallId,
    toolName: logicalToolName,
  });
  settleRead({
    task: ambiguousTask,
    logicalToolCallId: 'ambiguous-inner-two',
    observerCallId: ambiguousCallId,
    toolName: logicalToolName,
  });
  const ambiguous = projections.recordLogicalModelResultProjectionReceipt({
    admission: ambiguousAdmission,
    resultItem: structuredResult({ callId: ambiguousCallId, toolName: visibleToolName }),
  });
  assert.equal(ambiguous.status, 'ambiguous', JSON.stringify(ambiguous));

  const priorSource = accept('cross-source carrier observer');
  const crossSourceCallId = 'cross-source-carrier-observer';
  settleRead({
    task: priorSource,
    logicalToolCallId: 'cross-source-carrier-inner',
    observerCallId: crossSourceCallId,
    toolName: logicalToolName,
  });
  assert.equal(authority.closeHostReadOnlyCallAuthority({
    sessionId: priorSource.sessionId,
    sourceUserSeq: priorSource.sourceUserSeq,
    outcome: 'completed',
  }).status, 'closed');
  const laterSource = accept('cross-source carrier candidate', priorSource.sessionId);
  const laterAdmission = admit({
    task: laterSource,
    callId: crossSourceCallId,
    toolName: visibleToolName,
  });
  const crossSource = projections.recordLogicalModelResultProjectionReceipt({
    admission: laterAdmission,
    resultItem: structuredResult({ callId: crossSourceCallId, toolName: visibleToolName }),
  });
  assert.equal(crossSource.status, 'conflict', JSON.stringify(crossSource));
});

test('v69 backfills exact ready structured projections without copying their payload', () => {
  const task = accept('v69 backfill');
  const callId = 'backfill-structured-call';
  const toolName = 'session_history';
  const namespace = 'records';
  const admission = admit({ task, callId, toolName, namespace });
  const settlement = settleRead({ task, logicalToolCallId: callId, toolName });
  const item = structuredResult({ callId, toolName, namespace, marker: 'backfill-secret-marker' });
  const initialReceipt = projections.recordLogicalModelResultProjectionReceipt({
    admission,
    resultItem: item,
    now: () => '2026-08-29T20:29:59.000Z',
  });
  assert.equal(initialReceipt.status, 'recorded', JSON.stringify(initialReceipt));
  const checkpoint = checkpoints.finalizeAcceptedModelBatch(admission, {
    committedResultItems: [item],
    now: () => '2026-08-29T20:30:00.000Z',
  });
  assert.equal(checkpoint.status, 'committed', JSON.stringify(checkpoint));
  if (checkpoint.status !== 'committed') return;

  eventlog.closeEventLog();
  const raw = new Database(eventlog.HARNESS_DB_PATH);
  try {
    raw.pragma('foreign_keys = ON');
    raw.exec(`DROP TABLE logical_model_result_projection_receipts`);
    raw.prepare(`DELETE FROM schema_version WHERE version >= 69`).run();
    const beforeCheckpoint = raw.prepare(`
      SELECT * FROM accepted_model_batch_checkpoints
       WHERE session_id = ? AND source_user_seq = ? AND batch_ordinal = ?
    `).get(task.sessionId, task.sourceUserSeq, admission.batchOrdinal);

    schema.applyHarnessMigrations(raw);

    assert.deepEqual(raw.prepare(`
      SELECT * FROM accepted_model_batch_checkpoints
       WHERE session_id = ? AND source_user_seq = ? AND batch_ordinal = ?
    `).get(task.sessionId, task.sourceUserSeq, admission.batchOrdinal), beforeCheckpoint);
    const row = raw.prepare(`
      SELECT * FROM logical_model_result_projection_receipts
       WHERE session_id = ? AND source_user_seq = ? AND call_id = ?
    `).get(task.sessionId, task.sourceUserSeq, callId) as LogicalModelResultProjectionReceiptRow;
    assert.ok(row);
    const receipt = projections.logicalModelResultProjectionReceiptFromRow(row);
    assert.equal(receipt.settlementIdentityKind, 'logical');
    assert.equal(receipt.settlementEventId, settlement.settlementEventId);
    assert.equal(receipt.callNamespace, namespace);
    assert.equal(receipt.resultClass, 'structured');
    assert.equal(receipt.resultItemSha256, projections.logicalModelResultItemDigest(item));
    assert.equal(receipt.resultItemBytes,
      Buffer.byteLength(projections.canonicalLogicalModelResultItemBytes(item), 'utf8'));
    assert.equal(JSON.stringify(row).includes('backfill-secret-marker'), false,
      'backfill copied projection payload into metadata');
    const version = raw.prepare(`SELECT MAX(version) AS version FROM schema_version`).get() as { version: number };
    assert.equal(version.version, HARNESS_SCHEMA_VERSION, 'the v69 replay continues through the current append-only tail');
    assert.deepEqual(raw.pragma('foreign_key_check'), []);
    assert.deepEqual(raw.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally {
    raw.close();
  }
});

test('trusted local compaction of a HOST-settled result keeps provenance, tampering still refuses', () => {
  // Live 2026-09-05: two refused work_call frames (host receipts, no logical
  // settlement) had been clipped by layer-1 compaction and the host-receipt
  // branch of provenance had no stub allowance — every resume of the parked
  // task died pre-dispatch. The host branch now reverses a clip exactly like
  // the logical branch. Compaction itself no longer clips a host disposition,
  // so the stub here is produced from a same-length placeholder: the stub only
  // carries tool, char count, call id and time — byte-identical to what a clip
  // of the real disposition would have written on the older bytes.
  const task = accept('host clip');
  const callId = `host-clipped-${Date.now()}`;
  const toolName = 'work_call';
  const admission = admit({ task, callId, toolName });
  const refusal = hostResults.buildHostToolDispositionResult({
    callId, toolName, disposition: 'refused_pre_dispatch', frameDigest: 'a'.repeat(64), frameIndex: 0, frameSize: 1,
    countsRefusal: true,
    diagnostic: JSON.stringify({ error: 'work_cardinality_mismatch', detail: 'selected argument members do not match the accepted universe instance '.repeat(6) }),
  });
  hostResults.recordHostModelResultReceipts({ admission, resultItems: [refusal] });
  assert.equal(hostResults.hostModelResultReceiptRowsForCall(eventlog.openEventLog(), task.sessionId, callId).length, 1,
    'exactly one host receipt and no logical settlement for this call');
  const refusalText = (refusal as unknown as { output: { text: string } }).output.text;
  assert.ok(refusalText.length >= 400, 'the disposition must be clip-eligible by size on the older bytes');
  eventlog.writeToolOutput({ sessionId: task.sessionId, callId, tool: toolName, output: refusalText });

  const placeholder = textResult({ callId, toolName, text: 'x'.repeat(refusalText.length) });
  const retainedSentinel = textResult({ callId: `retain-${callId}`, toolName, text: 'small recent result' });
  const clippedAt = new Date().toISOString();
  assert.equal(compaction.clipOldToolResults([placeholder, retainedSentinel], 1, { now: () => clippedAt }), 1);
  const clipped = placeholder;
  assert.ok(compaction.describeCanonicalClippedToolResult(clipped));
  eventlog.appendEvent({
    sessionId: task.sessionId, turn: 0, role: 'system', type: 'condenser_applied',
    data: {
      layer1: { applied: true, clipped: 1, collapsedToolPairs: 0 },
      layer2: { applied: false, removedItems: 0, summaryItems: 0 },
      layer3: { applied: false, forkRequested: false },
    },
  });

  const request = modelRequest({ task, callId, toolName, result: clipped });
  const recorded = provenance.recordModelRequestDispatchProvenance({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    request: request as never,
    hostProjection: promptCache.canonicalPromptCacheRequest(request as never),
  });
  const projection = provenance.projectModelRequestProvenance(recorded.record.recordId);
  assert.equal(projection.status, 'ok',
    `a Layer-1 stub of a host-settled result is a presentation of the receipt, not a new result: ${JSON.stringify(projection)}`);

  const forged = structuredClone(clipped) as AgentInputItem & { __clippedMeta: { bytes: number } };
  forged.__clippedMeta.bytes += 1;
  const forgedRequest = modelRequest({ task, callId, toolName, result: forged as AgentInputItem });
  assert.throws(
    () => provenance.recordModelRequestDispatchProvenance({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      request: forgedRequest as never,
      hostProjection: promptCache.canonicalPromptCacheRequest(forgedRequest as never),
    }),
    (error: unknown) => error instanceof provenance.ModelRequestProvenanceError
      && error.code === 'host_result_projection_mismatch',
    'a stub whose recall target no longer matches the receipt is still refused',
  );

  // Chronology leg (shared with the logical twin): a stub dated BEFORE its own
  // receipt cannot be a host clip of it, even when the bytes reverse exactly
  // and a later condenser event would account for it.
  const backdatedAt = new Date(Date.parse(clippedAt) - 3_600_000).toISOString();
  const backdated = textResult({ callId, toolName, text: 'x'.repeat(refusalText.length) });
  assert.equal(compaction.clipOldToolResults([backdated, retainedSentinel], 1, { now: () => backdatedAt }), 1);
  const backdatedRequest = modelRequest({ task, callId, toolName, result: backdated });
  assert.throws(
    () => provenance.recordModelRequestDispatchProvenance({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      request: backdatedRequest as never,
      hostProjection: promptCache.canonicalPromptCacheRequest(backdatedRequest as never),
    }),
    (error: unknown) => error instanceof provenance.ModelRequestProvenanceError
      && error.code === 'host_result_projection_mismatch',
    'a stub that predates the receipt it presents is refused',
  );
});
