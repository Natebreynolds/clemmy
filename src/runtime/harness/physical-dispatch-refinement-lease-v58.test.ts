import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-v58-refined-lease-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-v58-refined-lease\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const ledger = await import('./dispatch-ledger.js');
const leases = await import('./dispatch-lease.js');
const contracts = await import('./logical-call-contract.js');
const effects = await import('./tool-effect.js');
const schema = await import('./schema-version.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function fixture(suffix: string) {
  const session = eventlog.createSession({
    id: `v58-refined-lease-${++serial}-${suffix}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the exact accepted record.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    turn: 1,
    parentLease: leases.activateDispatchLease({
      sessionId: session.id,
      scopeId: `${session.id}::parent`,
    }),
  };
}

function preparedCall(suffix: string) {
  const task = fixture(suffix);
  const tool = 'alpha__records_create';
  const rawArgs = { account_alias: 'ops', value: 'raw' };
  const effectiveArgs = { value: 'materialized', optional: null };
  const logicalToolCallId = `logical:${suffix}`;
  const identity = { ...task, logicalToolCallId };
  assert.equal(ledger.admitLogicalCall({ identity, tool, args: rawArgs }).status, 'inserted');
  const recovery = contracts.durableLogicalCallRecoveryMaterial(
    task.acceptedTaskId,
    tool,
    rawArgs,
  );
  assert.ok(recovery);
  const childLease = leases.activateDispatchLease({
    sessionId: task.sessionId,
    scopeId: `${task.sessionId}::call`,
    parentLease: task.parentLease,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId,
    recovery: {
      effect: effects.classifyRuntimeToolEffect(tool, rawArgs).effect,
      businessCall: true,
      material: recovery!,
      turn: task.turn,
    },
  });
  assert.equal(ledger.refineLogicalCallContract({
    identity,
    tool,
    effectiveArgs,
  }).status, 'refined');
  return { task, tool, rawArgs, effectiveArgs, logicalToolCallId, identity, childLease };
}

function crossingCount(input: ReturnType<typeof preparedCall>): number {
  return (eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    input.task.sessionId,
    input.task.sourceUserSeq,
    input.logicalToolCallId,
  ) as { n: number }).n;
}

test('schema v58 admits only the exact call-lease raw-to-effective chain', () => {
  assert.ok(schema.HARNESS_SCHEMA_VERSION >= 58);
  const trigger = eventlog.openEventLog().prepare(`
    SELECT sql FROM sqlite_master
     WHERE type = 'trigger' AND name = 'trg_physical_dispatch_lease_owner'
  `).get() as { sql: string } | undefined;
  assert.ok(trigger?.sql.includes('call.raw_argument_digest = lease.recovery_argument_digest'));
  assert.ok(trigger?.sql.includes('NEW.argument_digest = call.effective_argument_digest'));

  const input = preparedCall('positive');
  const raw = contracts.durableLogicalCallContract(
    input.task.acceptedTaskId,
    input.tool,
    input.rawArgs,
  );
  const effective = contracts.durableLogicalCallContract(
    input.task.acceptedTaskId,
    input.tool,
    input.effectiveArgs,
  );
  assert.ok(raw && effective && raw.argumentDigest !== effective.argumentDigest);

  const admitted = ledger.beginPhysicalDispatch({
    identity: {
      ...input.identity,
      physicalDispatchId: 'dispatch:positive',
      ordinal: 0,
    },
    tool: input.tool,
    args: input.effectiveArgs,
    executionSite: 'host',
    dispatchLease: input.childLease,
  });
  assert.equal(admitted.status, 'inserted');
  assert.equal(crossingCount(input), 1);
  const row = eventlog.openEventLog().prepare(`
    SELECT argument_digest, lease_scope_id, lease_id
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    input.task.sessionId,
    input.task.sourceUserSeq,
    input.logicalToolCallId,
  ) as { argument_digest: string; lease_scope_id: string; lease_id: string };
  assert.deepEqual(row, {
    argument_digest: effective!.argumentDigest,
    lease_scope_id: input.childLease.scopeId,
    lease_id: input.childLease.leaseId,
  });
});

test('unrelated digest, tool, call, and stale lease cannot use the refinement proof', () => {
  const unrelated = preparedCall('unrelated-digest');
  assert.notEqual(ledger.beginPhysicalDispatch({
    identity: { ...unrelated.identity, physicalDispatchId: 'dispatch:unrelated', ordinal: 0 },
    tool: unrelated.tool,
    args: { value: 'different', optional: null },
    executionSite: 'host',
    dispatchLease: unrelated.childLease,
  }).status, 'inserted');
  assert.equal(crossingCount(unrelated), 0);

  const wrongTool = preparedCall('wrong-tool');
  assert.notEqual(ledger.beginPhysicalDispatch({
    identity: { ...wrongTool.identity, physicalDispatchId: 'dispatch:wrong-tool', ordinal: 0 },
    tool: 'alpha__records_delete',
    args: wrongTool.effectiveArgs,
    executionSite: 'host',
    dispatchLease: wrongTool.childLease,
  }).status, 'inserted');
  assert.equal(crossingCount(wrongTool), 0);

  const wrongCall = preparedCall('wrong-call');
  const siblingIdentity = {
    ...wrongCall.task,
    logicalToolCallId: 'logical:sibling',
  };
  assert.equal(ledger.admitLogicalCall({
    identity: siblingIdentity,
    tool: wrongCall.tool,
    args: wrongCall.effectiveArgs,
  }).status, 'inserted');
  assert.equal(ledger.beginPhysicalDispatch({
    identity: { ...siblingIdentity, physicalDispatchId: 'dispatch:wrong-call', ordinal: 0 },
    tool: wrongCall.tool,
    args: wrongCall.effectiveArgs,
    executionSite: 'host',
    dispatchLease: wrongCall.childLease,
  }).status, 'conflict');
  assert.equal(crossingCount(wrongCall), 0);

  const stale = preparedCall('stale-lease');
  const changedLease = {
    ...stale.childLease,
    leaseId: `${stale.childLease.leaseId}-changed`,
  };
  assert.equal(ledger.beginPhysicalDispatch({
    identity: { ...stale.identity, physicalDispatchId: 'dispatch:stale', ordinal: 0 },
    tool: stale.tool,
    args: stale.effectiveArgs,
    executionSite: 'host',
    dispatchLease: changedLease,
  }).status, 'closed');
  assert.equal(crossingCount(stale), 0);
});

test('a second distinct refinement still conflicts before any physical row', () => {
  const input = preparedCall('second-refinement');
  assert.equal(ledger.refineLogicalCallContract({
    identity: input.identity,
    tool: input.tool,
    effectiveArgs: { value: 'second-materialization', optional: null },
  }).status, 'conflict');
  assert.equal(crossingCount(input), 0);
});
