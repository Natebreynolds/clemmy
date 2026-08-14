/**
 * RED — the ONE lane settlement API must honor a refined call's raw identity.
 *
 * Run: npx tsx --test src/runtime/harness/refined-call-lane-settlement.red.test.ts
 *
 * Invariant under pin: `settleToolAttempt` is the single settlement door for
 * every lane. A logical call that was refined (raw admission digest rewritten
 * to a trusted provider-ready digest) is still ONE call, and a lane holding
 * only the pre-refinement bytes is settling THAT call — so a repeated identical
 * settlement is a duplicate (never an authority error), and the host's own
 * execution evidence for a bound local call must never poison the resolution
 * it is evidence for. (Entry half went live 2026-08-11, platform-49 23:00Z.)
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-refined-lane-settlement-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-refined-lane\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const ledger = await import('./dispatch-ledger.js');
const settlement = await import('./attempt-settlement.js');
const admissionModule = await import('./expected-work-admission.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const GATEWAY_TOOL = 'composio_execute_tool';
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
  label: string;
}

function acceptTurn(label: string, text = 'Summarize the channel history.'): Task {
  const id = ++serial;
  const session = eventlog.createSession({ id: `refined-lane-${label}-${id}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }), 'fixture graph persisted');
  return {
    ...task,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    label: `${label}-${id}`,
  };
}

function settleHere(task: Task, tool: string, args: unknown, result: unknown) {
  return settlement.settleToolAttempt({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    lane: 'agents_runner',
    toolName: tool,
    args,
    businessCall: true,
    mutating: false,
    result,
  });
}

function logicalRow(task: Task): { state: string; conflict_reason: string | null } | undefined {
  return eventlog.openEventLog().prepare(`
    SELECT state, conflict_reason FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as
    { state: string; conflict_reason: string | null } | undefined;
}

test('a second identical raw-args settlement is a duplicate, never an authority error', async () => {
  const task = acceptTurn('duplicate');
  let firstDuplicate: boolean | undefined;
  let second: settlement.SettledToolAttempt | undefined;
  let thrown: unknown;

  await identities.withLogicalToolCall(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      tool: GATEWAY_TOOL,
      args: RAW_ARGS,
      logicalToolCallId: `call_dup_${task.label}`,
    },
    async () => {
      const refined = identities.authorizeResolvedLogicalCallContract({
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        turn: task.turn,
        tool: GATEWAY_TOOL,
        effectiveArgs: EFFECTIVE_ARGS,
      });
      assert.ok(refined, 'fixture: the trusted resolver refined its own call');

      // The inner dispatch failed; the wrapper settles with the raw bytes it
      // still holds — once, and then once more (crash-recovery redelivery,
      // carrier mirror: the second arrival of the SAME verdict).
      const first = settleHere(task, GATEWAY_TOOL, RAW_ARGS, { successful: false, error: 'inner failed' });
      firstDuplicate = first.duplicate;
      try {
        second = settleHere(task, GATEWAY_TOOL, RAW_ARGS, { successful: false, error: 'inner failed' });
      } catch (error) {
        thrown = error;
      }
    },
  );

  assert.equal(firstDuplicate, false, 'fixture: the first settlement was the authoritative one');
  assert.equal(
    thrown,
    undefined,
    `redelivering the same settlement is a duplicate, not an authority failure — threw ${String(thrown)}`,
  );
  assert.equal(second?.duplicate, true, 'the second settlement reports itself as the duplicate it is');
  assert.deepEqual(
    logicalRow(task),
    { state: 'settled', conflict_reason: null },
    'and the settled row survives its own redelivery',
  );
});

test('a bound local call refined to effective args still settles under its raw identity', () => {
  // A local business call BOUND to a frozen requirement: the host records its
  // own execution as a crossing. That crossing is EVIDENCE for the settlement —
  // its admission must never poison the resolution the settlement serves, no
  // matter which of the call's own two digests the settling lane holds.
  const task = acceptTurn('boundlocal', 'Read every open lead and write a local follow-up draft file for each one.');
  const activated = admissionModule.activateActionExpectedWork({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
  });
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    `fixture: action expected-work active: ${JSON.stringify(activated)}`,
  );

  const tool = 'read_file';
  const rawArgs = { path: 'leads.json' };
  const effectiveArgs = { path: 'leads.json', encoding: 'utf8' };
  const logicalToolCallId = `call_bound_${task.label}`;
  const identity = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId,
  };

  const admitted = ledger.admitLogicalCall({ identity, tool, args: rawArgs });
  assert.equal(admitted.status, 'inserted', `fixture: raw admission holds: ${JSON.stringify(admitted)}`);
  const refined = ledger.refineLogicalCallContract({
    identity,
    tool,
    effectiveArgs,
    turn: task.turn,
  });
  assert.equal(refined.status, 'refined', `fixture: contract refined: ${JSON.stringify(refined)}`);

  // Production binds AFTER refinement, against the current (effective) digest.
  const bound = admissionModule.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId,
    proposal: {
      version: 1,
      operations: [
        {
          id: 'read_leads',
          effect: 'read',
          coverage: 'complete_set',
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' },
        },
        {
          id: 'write_draft',
          effect: 'local_write',
          dependsOn: ['read_leads'],
          dataFrom: ['read_leads'],
          cardinality: { kind: 'each', universeId: 'leads' },
        },
      ],
      universes: [{
        id: 'leads',
        seal: 'complete_source_receipt',
        producedBy: 'read_leads',
        memberIdPointer: '/id',
      }],
    },
    requirementId: 'read_leads',
    tool,
    args: effectiveArgs,
  });
  assert.equal(bound.status, 'bound', `fixture: requirement binding froze: ${JSON.stringify(bound)}`);

  // The lane settles with the raw bytes it holds and the successful local
  // result the host itself produced.
  let settled: settlement.SettledToolAttempt | undefined;
  let thrown: unknown;
  try {
    settled = settlement.settleToolAttempt({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: task.turn,
      lane: 'agents_runner',
      toolName: tool,
      callId: logicalToolCallId,
      args: rawArgs,
      mutating: false,
      businessCall: true,
      requirementId: 'read_leads',
      result: { records: [{ id: 'lead-001' }, { id: 'lead-002' }], complete: true },
    });
  } catch (error) {
    thrown = error;
  }

  assert.equal(
    thrown,
    undefined,
    `the host's own execution evidence must not take down the settlement it accompanies — threw ${String(thrown)}`,
  );
  assert.ok(settled, 'the bound local call settled');
  assert.deepEqual(
    logicalRow(task),
    { state: 'settled', conflict_reason: null },
    'the call settled instead of being poisoned by its own evidence crossing',
  );
  const resolution = eventlog.openEventLog().prepare(`
    SELECT state FROM accepted_task_resolutions
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as { state: string } | undefined;
  assert.notEqual(
    resolution?.state,
    'legacy_ambiguous',
    'the accepted task resolution stays usable',
  );
});
