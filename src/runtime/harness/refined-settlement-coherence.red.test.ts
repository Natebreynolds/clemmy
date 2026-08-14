/**
 * RED — the committed record of a raw-digest settlement must be COHERENT.
 *
 * Run: npx tsx --test src/runtime/harness/refined-settlement-coherence.red.test.ts
 *
 * Invariant under pin: a logical call owns exactly two authorized digests — the
 * immutable raw admission digest and the trusted refined/effective digest. A
 * settlement presented under EITHER digest is the same call settling, so the
 * durable record it commits must agree with itself everywhere it is read back:
 * an exact replay is `replayed` (never a conflict, never poison), host
 * redemption is `ok` (never corrupt), and a successful settlement's result
 * handle is redeemable. A genuinely foreign contract must still conflict.
 *
 * Today the settlement ENTRY accepts the raw digest, but the committed record
 * keeps the raw digest in its semantic digest and mirror while every reader
 * re-derives the refined digest from the logical row — so the record disagrees
 * with itself the moment anything reads it back (live 2026-08-11, platform-49
 * 23:00Z was the entry half of this same class).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-refined-settlement-coherence-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-refined-settlement\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const ledger = await import('./dispatch-ledger.js');
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');
const resultHandles = await import('./result-handle.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

/** The gateway carrier the live incident rode. Provider-shaped fixture data
 *  only; nothing asserted below branches on the provider. */
const TOOL = 'composio_execute_tool';
const RAW_ARGS = { tool_slug: 'SLACK_FETCH_CONVERSATION_HISTORY', arguments: { channel: 'C1' } };
const EFFECTIVE_ARGS = {
  tool_slug: 'SLACK_FETCH_CONVERSATION_HISTORY',
  arguments: { channel: 'C1', limit: 50 },
};

let serial = 0;

interface Task {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  acceptedTaskId: string;
}

function acceptTurn(label: string): Task {
  const id = ++serial;
  const session = eventlog.createSession({ id: `refined-coherence-${label}-${id}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Summarize the channel history.' },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }), 'fixture graph persisted');
  return {
    ...task,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

interface RefinedCall {
  task: Task;
  identity: {
    sessionId: string;
    sourceUserSeq: number;
    acceptedTaskId: string;
    logicalToolCallId: string;
  };
}

/** Admit under the raw carrier, then refine to provider-ready args — the exact
 *  two-digest state every gateway call reaches before it settles. */
function admitAndRefine(label: string): RefinedCall {
  const task = acceptTurn(label);
  const identity = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: `call_${label}_${serial}`,
  };
  const admitted = ledger.admitLogicalCall({ identity, tool: TOOL, args: RAW_ARGS });
  assert.equal(admitted.status, 'inserted', 'fixture: raw admission holds');
  const refined = ledger.refineLogicalCallContract({
    identity,
    tool: TOOL,
    effectiveArgs: EFFECTIVE_ARGS,
    turn: task.turn,
  });
  assert.equal(refined.status, 'refined', 'fixture: the trusted resolver refined this call');
  return { task, identity };
}

/** The outer wrapper's settlement input: the RAW carrier bytes it still holds
 *  after the refined inner dispatch failed before reaching a provider. */
function rawRefusalInput(call: RefinedCall): settlements.CommitLogicalCallSettlementInput {
  return {
    identity: call.identity,
    contract: { toolName: TOOL, args: RAW_ARGS },
    execution: { kind: 'refused_pre_dispatch' },
    outcome: outcomes.classifyAttemptOutcome({ preDispatch: true, policyRefused: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'agents_runner', turn: call.task.turn },
  };
}

function logicalRow(call: RefinedCall): { state: string; conflict_reason: string | null } {
  return eventlog.openEventLog().prepare(`
    SELECT state, conflict_reason FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    call.identity.sessionId,
    call.identity.sourceUserSeq,
    call.identity.logicalToolCallId,
  ) as { state: string; conflict_reason: string | null };
}

test('an exact replay of a raw-digest settlement is replayed, never a conflict', () => {
  const call = admitAndRefine('replay');
  const input = rawRefusalInput(call);

  const first = settlements.commitLogicalCallSettlement(input);
  assert.equal(first.status, 'committed', `fixture: first raw-digest settlement commits: ${JSON.stringify(first)}`);

  // Byte-identical input, second delivery — a crash-recovery retry, a carrier
  // mirror, a restarted lane. Idempotence is the whole point of a settlement.
  const replay = settlements.commitLogicalCallSettlement(input);
  assert.equal(
    replay.status,
    'replayed',
    `the same settlement arriving twice is one settlement — got ${JSON.stringify(
      { status: replay.status, reason: 'reason' in replay ? replay.reason : undefined },
    )}`,
  );
});

test('a raw-digest settlement replay leaves the row settled, never poisoned', () => {
  const call = admitAndRefine('replaypoison');
  const input = rawRefusalInput(call);
  assert.equal(settlements.commitLogicalCallSettlement(input).status, 'committed', 'fixture: commit holds');

  // Whatever the replay reports, redelivering a settled verdict must never
  // destroy the verdict it redelivers.
  settlements.commitLogicalCallSettlement(input);

  const row = logicalRow(call);
  assert.equal(
    row.state,
    'settled',
    `a replayed settlement may not poison its own durable row — row is ${JSON.stringify(row)}`,
  );
  assert.equal(row.conflict_reason, null);
});

test('a committed raw-digest settlement redeems as host authority', () => {
  const call = admitAndRefine('redeem');
  assert.equal(
    settlements.commitLogicalCallSettlement(rawRefusalInput(call)).status,
    'committed',
    'fixture: commit holds',
  );

  // Terminal preparation and every downstream evidence reader rehydrate a
  // settlement through this exact door. A record the store itself just
  // committed must read back as authority, not corruption.
  const redeemed = settlements.redeemDurableLogicalCallSettlementForHost(call.identity);
  assert.equal(
    redeemed.status,
    'ok',
    `the store must redeem the settlement it committed — got ${JSON.stringify(redeemed)}`,
  );
});

test('a raw-args success after an effective crossing keeps its result redeemable', () => {
  const call = admitAndRefine('success');

  // One real crossing, dispatched under the refined provider-ready contract —
  // the only contract phase-'physical' admission accepts.
  const started = ledger.beginPhysicalDispatch({
    identity: {
      ...call.identity,
      physicalDispatchId: 'dispatch:raw-success-1',
      ordinal: 0,
    },
    tool: TOOL,
    args: EFFECTIVE_ARGS,
    turn: call.task.turn,
  });
  assert.equal(started.status, 'inserted', `fixture: effective crossing admitted: ${JSON.stringify(started)}`);
  if (started.status !== 'inserted') return;
  // Settle against the name the ledger actually stored — for a wrapped carrier
  // that is the normalized inner identity, exactly as the production host
  // crossing recorder resolves it before settling.
  const stored = eventlog.openEventLog().prepare(`
    SELECT tool_name FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
  `).get(
    call.identity.sessionId,
    call.identity.sourceUserSeq,
    started.identity.physicalDispatchId,
  ) as { tool_name: string };
  const crossed = ledger.settlePhysicalDispatch({
    identity: started.identity,
    tool: stored.tool_name,
    outcome: 'returned',
    turn: call.task.turn,
  });
  assert.equal(crossed.status, 'inserted', `fixture: crossing returned: ${JSON.stringify(crossed)}`);

  // The outer lane settles with the RAW bytes it still holds, carrying the
  // exact payload the provider returned. TARGET 1: this is the same call under
  // its own raw digest, so the success must COMMIT — today the raw-scoped
  // result handle cannot match the effective crossing and the whole settlement
  // dies as a storage error, stranding a paid, successful provider call.
  const payload = { successful: true, data: { messages: [{ ts: '1712.001', text: 'hello' }] } };
  const committed = settlements.commitLogicalCallSettlement({
    identity: call.identity,
    contract: { toolName: TOOL, args: RAW_ARGS },
    execution: { kind: 'provider_execution' },
    result: { payload },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'agents_runner', turn: call.task.turn },
  });
  assert.equal(
    committed.status,
    'committed',
    `a raw-args success of the call's own contract must settle — got ${JSON.stringify(committed)}`,
  );
  if (committed.status !== 'committed') return;
  assert.ok(committed.settlement.resultHandleId, 'the success minted a durable result handle');

  // The handle a settlement binds must be redeemable under that settlement's
  // own identity — a success whose evidence cannot be read back is a success
  // the task can never prove.
  const redeemed = resultHandles.redeemSuccessfulSettlementResultForHost(call.identity);
  assert.equal(
    redeemed.status,
    'ok',
    `the settlement's own bound result must redeem — got ${JSON.stringify(
      { status: redeemed.status, reason: 'reason' in redeemed ? redeemed.reason : undefined },
    )}`,
  );

  const durable = settlements.redeemDurableLogicalCallSettlementForHost(call.identity);
  assert.equal(
    durable.status,
    'ok',
    `the successful settlement itself must also redeem — got ${JSON.stringify(durable)}`,
  );
});

test('GUARD: a genuinely foreign contract still conflicts after refinement', () => {
  const call = admitAndRefine('foreign');
  // Same carrier, different inner action — not this call's raw digest, not its
  // effective digest. Widening to "either of this call's own digests" must not
  // widen to "anything".
  const foreign = settlements.commitLogicalCallSettlement({
    identity: call.identity,
    contract: {
      toolName: TOOL,
      args: { tool_slug: 'SLACK_SEND_MESSAGE', arguments: { channel: 'C9', text: 'nope' } },
    },
    execution: { kind: 'local_execution' },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'agents_runner', turn: call.task.turn },
  });
  assert.equal(foreign.status, 'conflict', 'a foreign contract may never settle this call');
  if (foreign.status !== 'conflict') return;
  assert.match(foreign.reason, /contract conflicts with its admission/);
});

test('GUARD: every physical crossing keeps its own distinct dispatch identity', async () => {
  const task = acceptTurn('crossings');
  // A direct provider action (no carrier), so the crossing settles under the
  // very name it was started with — the shape retries and polls actually take.
  const directTool = 'SLACK_FETCH_CONVERSATION_HISTORY';
  const directArgs = { channel: 'C1' };
  let first = '';
  let second = '';
  let logicalId = '';

  await identities.withLogicalToolCall(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      tool: directTool,
      args: directArgs,
      logicalToolCallId: `call_crossings_${serial}`,
    },
    async (logical) => {
      logicalId = logical.logicalToolCallId;
      await identities.withPhysicalDispatch(
        { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, tool: directTool, args: directArgs, turn: task.turn },
        async (crossing) => { first = crossing.physicalDispatchId; },
      );
      await identities.withPhysicalDispatch(
        {
          sessionId: task.sessionId,
          sourceUserSeq: task.sourceUserSeq,
          tool: directTool,
          args: directArgs,
          turn: task.turn,
          relation: 'retry',
          retryOf: first,
        },
        async (crossing) => { second = crossing.physicalDispatchId; },
      );
    },
  );

  assert.notEqual(first, second, 'a retry is its own paid crossing, never a reuse of the first');
  const rows = eventlog.openEventLog().prepare(`
    SELECT logical_tool_call_id, physical_dispatch_id, ordinal FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY ordinal
  `).all(task.sessionId, task.sourceUserSeq) as Array<{
    logical_tool_call_id: string;
    physical_dispatch_id: string;
    ordinal: number;
  }>;
  assert.deepEqual(
    rows.map((row) => ({ logical: row.logical_tool_call_id, ordinal: row.ordinal })),
    [{ logical: logicalId, ordinal: 1 }, { logical: logicalId, ordinal: 2 }],
    'both crossings belong to the ONE logical call with truthful ordinals',
  );
  assert.equal(new Set(rows.map((row) => row.physical_dispatch_id)).size, 2);
});
