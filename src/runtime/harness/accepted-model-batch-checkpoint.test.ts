import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import type { AcceptedModelBatchRef } from './accepted-model-batch-checkpoint.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-accepted-model-batch-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-accepted-model-batch\n', 'utf8');

const eventlog = await import('./eventlog.js');
const authority = await import('./accepted-turn-call-authority.js');
const checkpoints = await import('./accepted-model-batch-checkpoint.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./logical-call-contract.js');
const hostBindings = await import('./host-call-capability-binding.js');
const leases = await import('./dispatch-lease.js');
const brackets = await import('./brackets.js');
const invocation = await import('./host-tool-invocation.js');
const protocol = await import('./conversation-protocol.js');
const protocolSession = await import('./conversation-protocol-session.js');
const hostResults = await import('./host-model-result-receipt.js');
const logicalResults = await import('./logical-model-result-projection-receipt.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
let serial = 0;

function fixture(text: string) {
  const session = eventlog.createSession({ id: `accepted-model-batch-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const armed = authority.armHostCallAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    catalogRevisionDigest: digest(`catalog:${session.id}`),
    bindingRevisionDigest: digest(`binding:${session.id}`),
    maxLogicalCalls: 8,
    maxParallelCalls: 4,
  });
  assert.equal(armed.status, 'armed');
  const parentLease = leases.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::host-parent`,
  });
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    text,
    parentLease,
    context: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      counter: new brackets.ToolCallsCounter(20),
      dispatchLease: parentLease,
    } satisfies brackets.HarnessRunContext,
  };
}

type Fixture = ReturnType<typeof fixture>;

function preHistory(task: Fixture): AgentInputItem[] {
  return [{ role: 'user', content: task.text } as AgentInputItem];
}

function openFrame(input: {
  callId: string;
  toolName: string;
  args: unknown;
}): AgentInputItem[] {
  return [{
    type: 'function_call',
    callId: input.callId,
    name: input.toolName,
    arguments: JSON.stringify(input.args),
    status: 'completed',
  } as AgentInputItem];
}

function productionAttestation(input: {
  task: Fixture;
  callId: string;
  toolName: string;
  args: unknown;
  effect: 'read' | 'external_write';
}): authority.HostCallAttestation {
  const root = authority.acceptedTurnCallAuthorityFor(
    input.task.sessionId,
    input.task.sourceUserSeq,
  );
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') throw new Error(root.reason);
  const contract = contracts.durableLogicalCallContract(
    input.task.acceptedTaskId,
    input.toolName,
    input.args,
  );
  assert.ok(contract);
  if (!contract) throw new Error('fixture contract is unsafe');
  const base = {
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    acceptedTaskId: input.task.acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: input.callId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect: input.effect,
    bindingKind: 'catalog_manifest' as const,
    capabilityId: `cap:${contract.toolName}`,
    schemaFingerprint: digest(`schema:${contract.toolName}`),
    accountId: 'conn-checkpoint-fixture',
    invokePortId: 'fixture:execute',
    operationId: contract.toolName.toUpperCase(),
    manifestId: `manifest:${contract.toolName}`,
    manifestDigest: digest(`manifest:${contract.toolName}`),
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest: root.authority.catalogRevisionDigest!,
    bindingRevisionDigest: root.authority.bindingRevisionDigest!,
  };
  return {
    ...base,
    bindingDigest: hostBindings.hostCallAttestationBindingDigest(base),
  };
}

function runCall<T>(input: {
  task: Fixture;
  callId: string;
  toolName: string;
  args: unknown;
  effect: 'read' | 'external_write';
  boundary?: 'host_owned_local' | 'host_owned_external';
  deadlineMs?: number;
  invoke: () => Promise<T>;
}) {
  const attestation = productionAttestation(input);
  return authority.withHostCallAttestation(attestation, () =>
    brackets.withHarnessRunContext(input.task.context, () => invocation.invokeHostToolCall({
      identity: {
        sessionId: input.task.sessionId,
        sourceUserSeq: input.task.sourceUserSeq,
        modelCallId: input.callId,
        toolName: input.toolName,
        args: input.args,
        turn: 1,
      },
      parentLease: input.task.parentLease,
      effect: input.effect,
      boundary: input.boundary ?? 'host_owned_external',
      deadlineMs: input.deadlineMs ?? 200,
      invoke: input.invoke,
    }))) as Promise<invocation.HostToolInvocationResult<T>>;
}

function physicalRows(task: Fixture, callId: string): Array<{
  physical_dispatch_id: string;
  state: string;
}> {
  return eventlog.openEventLog().prepare(`
    SELECT physical_dispatch_id, state
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
     ORDER BY ordinal
  `).all(task.sessionId, task.sourceUserSeq, callId) as Array<{
    physical_dispatch_id: string;
    state: string;
  }>;
}

function resultText(history: readonly AgentInputItem[], callId: string): string | undefined {
  for (const item of history) {
    const record = item as unknown as Record<string, unknown>;
    if (record.type !== 'function_call_result' || record.callId !== callId) continue;
    const output = record.output as Record<string, unknown> | undefined;
    if (output?.type === 'text' && typeof output.text === 'string') return output.text;
  }
  return undefined;
}

function exactSettledResult(input: {
  task: Fixture;
  callId: string;
  history: readonly AgentInputItem[];
}): AgentInputItem {
  const evidence = protocolSession.durableConversationProtocolEvidenceForCall({
    sessionId: input.task.sessionId,
    history: input.history,
    callId: input.callId,
  });
  assert.equal(evidence?.kind, 'settled_result');
  if (!evidence || evidence.kind !== 'settled_result') {
    throw new Error('fixture has no exact settled model result');
  }
  return evidence.result;
}

function recordLogicalResult(
  admission: AcceptedModelBatchRef,
  resultItem: AgentInputItem,
): void {
  const recorded = logicalResults.recordLogicalModelResultProjectionReceipt({
    admission,
    resultItem,
  });
  assert.ok(
    recorded.status === 'recorded' || recorded.status === 'existing',
    `logical projection receipt was ${recorded.status}`,
  );
}

function projectedTextResult(input: {
  callId: string;
  toolName: string;
  value: unknown;
}): AgentInputItem {
  return {
    type: 'function_call_result',
    callId: input.callId,
    name: input.toolName,
    output: {
      type: 'text',
      text: typeof input.value === 'string'
        ? input.value
        : JSON.stringify(input.value),
    },
    status: 'completed',
  } as AgentInputItem;
}

test('an admitted batch with no logical start is balanced durably and chains only from its exact checkpoint', () => {
  const task = fixture('Inspect the available records and report what is present.');
  const firstFrame = openFrame({
    callId: 'call:read:1',
    toolName: 'records_read',
    args: { query: 'available' },
  });
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    preHistory: preHistory(task),
    frameHistory: firstFrame,
    providerResponseId: 'response:1',
  });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);

  const exactReplay = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    preHistory: preHistory(task),
    frameHistory: firstFrame,
    providerResponseId: 'response:1',
  });
  assert.equal(exactReplay.status, 'existing');

  const competing = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    preHistory: preHistory(task),
    frameHistory: openFrame({
      callId: 'call:other',
      toolName: 'records_read',
      args: { query: 'different' },
    }),
    providerResponseId: 'response:different',
  });
  assert.equal(competing.status, 'conflict');

  const noStartResult = hostResults.buildHostToolDispositionResult({
    callId: 'call:read:1',
    toolName: 'records_read',
    disposition: 'not_started',
    frameDigest: digest('frame:call:read:1'),
    frameIndex: 0,
    frameSize: 1,
  });
  hostResults.recordHostModelResultReceipts({
    admission: admitted.admission,
    resultItems: [noStartResult],
  });
  const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, {
    committedResultItems: [noStartResult],
  });
  assert.ok(finalized.status === 'committed' || finalized.status === 'existing');

  const recovered = checkpoints.recoverAcceptedModelBatchForRestart({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.equal(recovered.status, 'ready');
  if (recovered.status !== 'ready') throw new Error(recovered.reason);
  assert.equal(protocol.inspectConversationProtocol(recovered.checkpoint.history).status, 'valid');
  assert.match(resultText(recovered.checkpoint.history, 'call:read:1') ?? '', /"disposition":"not_started"/);
  assert.equal(physicalRows(task, 'call:read:1').length, 0);

  const second = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    preHistory: recovered.checkpoint.history,
    frameHistory: openFrame({
      callId: 'call:read:2',
      toolName: 'records_read',
      args: { query: 'available', page: 2 },
    }),
    previousResponseId: recovered.checkpoint.lastResponseId,
    providerResponseId: 'response:2',
  });
  assert.equal(second.status, 'admitted');
  if (second.status === 'admitted') assert.equal(second.admission.batchOrdinal, 2);
  leases.revokeDispatchLease(task.parentLease);
});

for (const candidate of [
  { effect: 'read' as const, toolName: 'read_file', callId: 'call:settled-read' },
  { effect: 'external_write' as const, toolName: 'space_publish', callId: 'call:settled-write' },
]) {
  test(`restart adopts one settled ${candidate.effect} without repeating its crossing or body`, async () => {
    const task = fixture(`Perform the exact ${candidate.effect} operation.`);
    const args = candidate.effect === 'read'
      ? { query: 'current records' }
      : { title: 'Release Readiness', rows: [{ status: 'ready' }] };
    const admitted = checkpoints.admitAcceptedModelBatch({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      preHistory: preHistory(task),
      frameHistory: openFrame({ ...candidate, args }),
      previousResponseId: 'response:prior',
      providerResponseId: `response:${candidate.callId}`,
    });
    assert.equal(admitted.status, 'admitted');
    if (admitted.status !== 'admitted') throw new Error(admitted.reason);

    let bodies = 0;
    const payload = { ok: true, callId: candidate.callId, durable: true };
    const first = await runCall({
      task,
      ...candidate,
      args,
      invoke: async () => {
        bodies += 1;
        return payload;
      },
    });
    assert.deepEqual(first.value, payload);
    assert.equal(bodies, 1);
    const crossing = physicalRows(task, candidate.callId);
    assert.equal(crossing.length, 1);

    const resultItem = exactSettledResult({
      task,
      callId: candidate.callId,
      history: [...preHistory(task), ...openFrame({ ...candidate, args })],
    });
    recordLogicalResult(admitted.admission, resultItem);
    const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, {
      committedResultItems: [resultItem],
    });
    assert.ok(finalized.status === 'committed' || finalized.status === 'existing');

    const recovered = checkpoints.recoverAcceptedModelBatchForRestart({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
    });
    assert.equal(recovered.status, 'ready');
    if (recovered.status !== 'ready') throw new Error(recovered.reason);
    assert.equal(resultText(recovered.checkpoint.history, candidate.callId), JSON.stringify(payload));
    assert.equal(recovered.checkpoint.lastResponseId, `response:${candidate.callId}`);
    assert.equal(physicalRows(task, candidate.callId).length, 1);

    const replay = await runCall({
      task,
      ...candidate,
      args,
      invoke: async () => {
        bodies += 1;
        return { ok: false, mustNotRun: true };
      },
    });
    assert.deepEqual(replay.value, payload);
    assert.equal(replay.settlement.duplicate, true);
    assert.equal(bodies, 1);
    assert.equal(physicalRows(task, candidate.callId).length, 1);

    const recoveredAgain = checkpoints.recoverAcceptedModelBatchForRestart({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
    });
    assert.equal(recoveredAgain.status, 'ready');
    if (recoveredAgain.status === 'ready') {
      assert.equal(recoveredAgain.checkpoint.historyDigest, recovered.checkpoint.historyDigest);
    }
    leases.revokeDispatchLease(task.parentLease);
  });
}

for (const candidate of [
  { label: 'local', boundary: 'host_owned_local' as const },
  { label: 'external read', boundary: 'host_owned_external' as const },
]) {
  test(`an exact ${candidate.label} non-success projection remains ordinary restart-safe model data`, async () => {
    const task = fixture(`Inspect one ${candidate.label} source and report its typed corrective.`);
    const callId = `call:typed-failure:${candidate.label.replace(/\s+/g, '-')}`;
    const toolName = 'read_file';
    const args = { path: `/fixture/${candidate.label.replace(/\s+/g, '-')}.txt` };
    const admitted = checkpoints.admitAcceptedModelBatch({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      preHistory: preHistory(task),
      frameHistory: openFrame({ callId, toolName, args }),
      providerResponseId: `response:${callId}`,
    });
    assert.equal(admitted.status, 'admitted');
    if (admitted.status !== 'admitted') throw new Error(admitted.reason);

    let bodies = 0;
    const payload = {
      ok: false,
      code: 'fixture_typed_corrective',
      detail: 'Use the returned corrective in the next model step.',
    };
    const invoked = await runCall({
      task,
      callId,
      toolName,
      args,
      effect: 'read',
      boundary: candidate.boundary,
      invoke: async () => {
        bodies += 1;
        return payload;
      },
    });
    assert.equal(invoked.settlement.outcome.kind, 'unknown');
    assert.equal(bodies, 1);

    const resultItem = projectedTextResult({ callId, toolName, value: payload });
    recordLogicalResult(admitted.admission, resultItem);
    const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, {
      committedResultItems: [resultItem],
    });
    assert.ok(finalized.status === 'committed' || finalized.status === 'existing');

    const recovered = checkpoints.recoverAcceptedModelBatchForRestart({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
    });
    assert.equal(recovered.status, 'ready');
    if (recovered.status !== 'ready') throw new Error(recovered.reason);
    assert.equal(resultText(recovered.checkpoint.history, callId), JSON.stringify(payload));
    assert.equal(physicalRows(task, callId).length, 1);
    assert.equal(bodies, 1, 'checkpoint recovery cannot repeat the body');
    leases.revokeDispatchLease(task.parentLease);
  });
}

test('a returned unknown mutation cannot use a projection receipt to bypass reconciliation', async () => {
  const task = fixture('Attempt one external mutation whose acknowledgement is negative.');
  const callId = 'call:returned-unknown-write';
  const toolName = 'space_publish';
  const args = { title: 'Unknown acknowledgement' };
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    preHistory: preHistory(task),
    frameHistory: openFrame({ callId, toolName, args }),
    providerResponseId: 'response:returned-unknown-write',
  });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);

  const payload = { ok: false, code: 'unknown_write_acknowledgement' };
  const invoked = await runCall({
    task,
    callId,
    toolName,
    args,
    effect: 'external_write',
    invoke: async () => payload,
  });
  assert.equal(invoked.settlement.outcome.kind, 'uncertain_write');
  const resultItem = projectedTextResult({ callId, toolName, value: payload });
  recordLogicalResult(admitted.admission, resultItem);
  const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, {
    committedResultItems: [resultItem],
  });
  assert.equal(finalized.status, 'evidence_unavailable');
  leases.revokeDispatchLease(task.parentLease);
});

test('an uncertain host-owned mutation with zero provider crossings checkpoints reconciliation', async () => {
  const task = fixture('Attempt one host-owned mutation whose effect is not acknowledged.');
  const callId = 'call:host-owned-unknown-write';
  const toolName = 'space_publish';
  const args = { title: 'Host-owned unknown acknowledgement' };
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    preHistory: preHistory(task),
    frameHistory: openFrame({ callId, toolName, args }),
    providerResponseId: 'response:host-owned-unknown-write',
  });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);

  await assert.rejects(runCall({
    task,
    callId,
    toolName,
    args,
    effect: 'external_write',
    boundary: 'host_owned_local',
    invoke: async () => { throw new Error('acknowledgement unavailable'); },
  }));
  const settlement = eventlog.openEventLog().prepare(`
    SELECT outcome_kind, physical_crossing_count, host_crossing_count,
           requires_reconciliation
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, callId);
  assert.deepEqual(settlement, {
    outcome_kind: 'uncertain_write',
    physical_crossing_count: 0,
    host_crossing_count: 1,
    requires_reconciliation: 1,
  });

  const effectUnknown = hostResults.buildHostToolDispositionResult({
    callId,
    toolName,
    disposition: 'effect_unknown',
    frameDigest: digest(`frame:${callId}`),
    frameIndex: 0,
    frameSize: 1,
  });
  recordLogicalResult(admitted.admission, effectUnknown);
  const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, {
    committedResultItems: [effectUnknown],
  });
  assert.ok(finalized.status === 'committed' || finalized.status === 'existing');
  assert.equal(finalized.checkpoint.disposition, 'reconciliation_required');

  const recovered = checkpoints.recoverAcceptedModelBatchForRestart({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.equal(recovered.status, 'reconciliation_required');
  assert.equal(physicalRows(task, callId).length, 1);
  leases.revokeDispatchLease(task.parentLease);
});

test('a timed-out external write remains reconciliation-only and is never blindly retried', async () => {
  const task = fixture('Create the exact external table once.');
  const callId = 'call:unknown-write';
  const toolName = 'space_publish';
  const args = { title: 'Restart Boundary', rows: [{ checkpoint: true }] };
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    preHistory: preHistory(task),
    frameHistory: openFrame({ callId, toolName, args }),
    providerResponseId: 'response:unknown-write',
  });
  assert.equal(admitted.status, 'admitted');

  let bodies = 0;
  await assert.rejects(runCall({
    task,
    callId,
    toolName,
    args,
    effect: 'external_write',
    deadlineMs: 15,
    invoke: async () => {
      bodies += 1;
      return await new Promise<string>(() => {});
    },
  }));
  assert.equal(bodies, 1);
  assert.equal(physicalRows(task, callId).length, 1);

  const effectUnknown = hostResults.buildHostToolDispositionResult({
    callId,
    toolName,
    disposition: 'effect_unknown',
    frameDigest: digest(`frame:${callId}`),
    frameIndex: 0,
    frameSize: 1,
  });
  if (admitted.status !== 'admitted') throw new Error('fixture admission failed');
  recordLogicalResult(admitted.admission, effectUnknown);
  const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, {
    committedResultItems: [effectUnknown],
  });
  assert.ok(finalized.status === 'committed' || finalized.status === 'existing');

  const recovered = checkpoints.recoverAcceptedModelBatchForRestart({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.equal(recovered.status, 'reconciliation_required');
  if (recovered.status !== 'reconciliation_required') throw new Error(recovered.reason);
  assert.match(resultText(recovered.checkpoint.history, callId) ?? '', /"retry":"do_not_retry"/);
  assert.equal(physicalRows(task, callId).length, 1);

  await assert.rejects(runCall({
    task,
    callId,
    toolName,
    args,
    effect: 'external_write',
    invoke: async () => {
      bodies += 1;
      return 'must-not-run';
    },
  }));
  assert.equal(bodies, 1);
  assert.equal(physicalRows(task, callId).length, 1);
  leases.revokeDispatchLease(task.parentLease);
});
