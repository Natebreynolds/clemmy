/**
 * RED — a later successful source may reconcile an earlier workflow failure
 * only when durable requirement/logical-call identity says it repaired that work.
 * Chronology plus "some business call succeeded" is never recovery authority.
 *
 * Run:
 *   npx tsx --test src/execution/workflow-settlement-identity-recovery.red.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-settlement-identity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-workflow-settlement-identity\n', 'utf8');

const eventlog = await import('../runtime/harness/eventlog.js');
const identities = await import('../runtime/harness/attempt-identity.js');
const dispatch = await import('../runtime/harness/dispatch-ledger.js');
const outcomes = await import('../runtime/harness/attempt-outcome.js');
const settlements = await import('../runtime/harness/logical-call-settlement-store.js');
const shadow = await import('../runtime/graph/turn-graph-shadow.js');
const { auditWorkflowRunSettlementTruth } = await import('./workflow-runner.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function settleBusinessCall(input: {
  sessionId: string;
  turn: number;
  sourceText: string;
  logicalId: string;
  tool: string;
  args: Record<string, unknown>;
  success: boolean;
  requirementId?: string;
}): void {
  const source = eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    role: 'user',
    type: 'user_input_received',
    data: { text: input.sourceText },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: {
      sessionId: input.sessionId,
      turn: source.turn,
      sourceUserSeq: source.seq,
    },
  }));
  const acceptedTaskId = identities.acceptedTaskIdFor(input.sessionId, source.seq);
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: input.sessionId,
      sourceUserSeq: source.seq,
      turn: source.turn,
      acceptedTaskId,
      logicalToolCallId: input.logicalId,
      physicalDispatchId: `dispatch:${input.logicalId}`,
      ordinal: 0,
    },
    tool: input.tool,
    args: input.args,
  });
  assert.equal(begun.status, 'inserted', `fixture dispatch admission failed: ${JSON.stringify(begun)}`);
  if (begun.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: input.tool,
    outcome: 'returned',
  }).status, 'inserted');
  const committed = settlements.commitLogicalCallSettlement({
    identity: {
      sessionId: input.sessionId,
      sourceUserSeq: source.seq,
      acceptedTaskId,
      logicalToolCallId: input.logicalId,
    },
    contract: { toolName: input.tool, args: input.args },
    execution: { kind: 'provider_execution' },
    result: {
      payload: input.success
        ? { successful: true, data: [{ id: 'record-1' }] }
        : { successful: false, error: 'provider rejected this call' },
    },
    outcome: input.success
      ? outcomes.classifyAttemptOutcome({ envelopeSuccessful: true })
      : outcomes.classifyAttemptOutcome({ httpStatus: 501 }),
    recovery: {
      businessCall: true,
      mutating: false,
      ...(input.requirementId ? { requirementId: input.requirementId } : {}),
    },
    observer: { lane: 'composio', turn: source.turn },
  });
  assert.equal(committed.status, 'committed', `fixture settlement failed: ${JSON.stringify(committed)}`);
}

test('success for requirement B cannot erase failure for requirement A; exact A recovery can', () => {
  const runId = 'requirement-identity-recovery';
  const sessionId = `workflow:${runId}:sync_records`;
  eventlog.createSession({ id: sessionId, kind: 'workflow' });
  settleBusinessCall({
    sessionId,
    turn: 1,
    sourceText: 'Read the account source.',
    logicalId: 'logical:req-a-failed',
    tool: 'alpha_records_read',
    args: { source: 'accounts' },
    success: false,
    requirementId: 'requirement:source-accounts',
  });
  settleBusinessCall({
    sessionId,
    turn: 2,
    sourceText: 'Read the unrelated destination metadata.',
    logicalId: 'logical:req-b-success',
    tool: 'beta_sheet_metadata',
    args: { sheet: 'destination' },
    success: true,
    requirementId: 'requirement:destination-metadata',
  });

  const unrelated = auditWorkflowRunSettlementTruth(runId);
  assert.equal(unrelated.clean, false,
    `an unrelated requirement success hid the failed source requirement: ${JSON.stringify(unrelated)}`);

  settleBusinessCall({
    sessionId,
    turn: 3,
    sourceText: 'Retry the account source read.',
    logicalId: 'logical:req-a-success',
    tool: 'alpha_records_read',
    args: { source: 'accounts', retry: true },
    success: true,
    requirementId: 'requirement:source-accounts',
  });
  assert.deepEqual(auditWorkflowRunSettlementTruth(runId), { clean: true, reasons: [] },
    'an exact later success for the failed requirement did not reconcile it');
});

test('legacy unbound recovery requires the exact durable logical call identity, not any successful call', () => {
  const runId = 'call-contract-identity-recovery';
  const sessionId = `workflow:${runId}:read_record`;
  eventlog.createSession({ id: sessionId, kind: 'workflow' });
  settleBusinessCall({
    sessionId,
    turn: 1,
    sourceText: 'Read record alpha-1.',
    logicalId: 'logical:call-failed',
    tool: 'alpha_records_read',
    args: { id: 'alpha-1' },
    success: false,
  });
  settleBusinessCall({
    sessionId,
    turn: 2,
    sourceText: 'Read a different record.',
    logicalId: 'logical:other-call-success',
    tool: 'alpha_records_read',
    args: { id: 'alpha-2' },
    success: true,
  });

  const unrelated = auditWorkflowRunSettlementTruth(runId);
  assert.equal(unrelated.clean, false,
    `a different call contract hid the failed call: ${JSON.stringify(unrelated)}`);

  settleBusinessCall({
    sessionId,
    turn: 3,
    sourceText: 'Retry record alpha-1.',
    logicalId: 'logical:call-failed',
    tool: 'alpha_records_read',
    args: { id: 'alpha-1' },
    success: true,
  });
  assert.deepEqual(auditWorkflowRunSettlementTruth(runId), { clean: true, reasons: [] },
    'the exact durable logical-call recovery did not reconcile the legacy failure');
});
