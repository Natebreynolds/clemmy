/**
 * Run: npx tsx --test src/runtime/harness/compute-discharge-evidence-role.red.test.ts
 *
 * RED PIN — safety class is not an evidence role at the discharge gate.
 *
 * The invariant: a requirement whose effect class is 'compute' must not be
 * treated as DURABLY DISCHARGED on bare provider success. 'compute' is a
 * mutation-SAFETY verdict (a shell carrier that cannot be proven mutating);
 * it proves nothing about the SEMANTIC work the requirement named. Discharge
 * needs a role-backed basis — a typed evidence role (source_read | derivation
 * | committed_effect | verification) derived from registered/proven capability
 * metadata or an observed child settlement — never the safety class alone.
 *
 * Today expected-work-admission discharges a 'compute' binding on
 * outcome_kind === 'succeeded' with zero proof, so a dependent write opens on
 * the strength of an empty nominal envelope. These tests fail until discharge
 * demands the role-backed basis.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-compute-discharge-role-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-compute-discharge\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const admissionModule = await import('./expected-work-admission.js');
const dispatch = await import('./dispatch-ledger.js');
const settlement = await import('./attempt-settlement.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const ASK = 'Derive the open-lead id list locally, then write the summary file.';
let serial = 0;

interface ArmedTask {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  acceptedTaskId: string;
  label: string;
}

/** A compute producer feeding a local write — the weakest-evidence topology. */
function proposal() {
  return {
    version: 1 as const,
    operations: [
      {
        id: 'gather_ids',
        effect: 'compute' as const,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'write_summary',
        effect: 'local_write' as const,
        dependsOn: ['gather_ids'],
        dataFrom: ['gather_ids'],
        cardinality: { kind: 'once' as const },
      },
    ],
    universes: [],
  };
}

function armTask(label: string): ArmedTask {
  const id = ++serial;
  const session = eventlog.createSession({ id: `compute-role-${label}-${id}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }), 'fixture graph persisted');
  const activated = admissionModule.activateActionExpectedWork(task);
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
  return {
    ...task,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    label: `${label}-${id}`,
  };
}

function openAndBind(input: {
  task: ArmedTask;
  suffix: string;
  tool: string;
  args: unknown;
  requirementId: string;
  withProposal: boolean;
}): { logicalToolCallId: string; admission: ReturnType<typeof admissionModule.admitExpectedWorkInvocation> } {
  const logicalToolCallId = `logical:${input.task.label}:${input.suffix}`;
  const opened = dispatch.admitLogicalCall({
    identity: {
      sessionId: input.task.sessionId,
      sourceUserSeq: input.task.sourceUserSeq,
      turn: input.task.turn,
      acceptedTaskId: input.task.acceptedTaskId,
      logicalToolCallId,
    },
    tool: input.tool,
    args: input.args,
  });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  const admission = admissionModule.admitExpectedWorkInvocation({
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    logicalToolCallId,
    proposal: input.withProposal ? proposal() : null,
    requirementId: input.requirementId,
    tool: input.tool,
    args: input.args,
  });
  return { logicalToolCallId, admission };
}

/** The exact "bare provider success" shape: a nominal successful envelope with
 * no payload, no records, no derivation product — a claim, not evidence. */
function settleBareSuccess(
  task: ArmedTask,
  logicalToolCallId: string,
  tool: string,
  args: unknown,
  result: unknown = { successful: true },
) {
  return settlement.settleToolAttempt({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    lane: 'agents_runner',
    toolName: tool,
    callId: logicalToolCallId,
    args,
    mutating: false,
    businessCall: true,
    requirementId: 'gather_ids',
    result,
  });
}

const SHELL_ARGS = { command: 'jq -r ".[].id" leads.json' };

test('a compute requirement does not discharge on bare provider success with no role-backed evidence', () => {
  const task = armTask('bare-success');
  const producer = openAndBind({
    task,
    suffix: 'gather',
    tool: 'run_shell_command',
    args: SHELL_ARGS,
    requirementId: 'gather_ids',
    withProposal: true,
  });
  assert.equal(producer.admission.status, 'bound', JSON.stringify(producer.admission));

  const settled = settleBareSuccess(task, producer.logicalToolCallId, 'run_shell_command', SHELL_ARGS);
  assert.equal(settled.outcome.kind, 'succeeded', 'fixture: the provider envelope claims success');

  // No child settlement exists, no registered/proven capability metadata backs
  // a role for this shell carrier, no derivation receipt was issued. The
  // dependent write must stay closed until a role-backed basis exists.
  const dependent = openAndBind({
    task,
    suffix: 'write',
    tool: 'write_file',
    args: { path: 'summary.md', content: 'ids: ...' },
    requirementId: 'write_summary',
    withProposal: false,
  });
  assert.equal(
    dependent.admission.status,
    'refused',
    'bare compute success alone must not discharge the dependency and open the write lane',
  );
  if (dependent.admission.status === 'refused') {
    assert.equal(dependent.admission.kind, 'work_dependency_pending');
  }
});

test('a substantive compute result carries a redeemable result handle and discharges its dependency', () => {
  const task = armTask('durable-basis');
  const producer = openAndBind({
    task,
    suffix: 'gather',
    tool: 'run_shell_command',
    args: SHELL_ARGS,
    requirementId: 'gather_ids',
    withProposal: true,
  });
  assert.equal(producer.admission.status, 'bound', JSON.stringify(producer.admission));
  settleBareSuccess(
    task,
    producer.logicalToolCallId,
    'run_shell_command',
    SHELL_ARGS,
    { successful: true, data: { ids: ['lead-001', 'lead-002'] } },
  );

  // Compute does not pretend to be a read mode. Its durable basis is the exact
  // redeemable result handle on the normalized settlement.
  const row = eventlog.openEventLog().prepare(`
    SELECT b.evidence_mode, b.evidence_basis, s.result_handle_id
      FROM expected_work_call_bindings b
      JOIN logical_call_settlements s
        ON s.session_id = b.session_id AND s.source_user_seq = b.source_user_seq
       AND s.logical_tool_call_id = b.logical_tool_call_id
     WHERE b.session_id = ? AND b.source_user_seq = ? AND b.logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, producer.logicalToolCallId) as {
    evidence_mode: string | null;
    evidence_basis: string | null;
    result_handle_id: string | null;
  };
  assert.ok(row.result_handle_id, 'a discharged compute must own a redeemable result handle');
  assert.equal(row.evidence_mode, null, 'compute must not masquerade as read evidence');
  assert.equal(row.evidence_basis, null, 'compute must not fabricate a read-evidence basis');

  const dependent = openAndBind({
    task,
    suffix: 'write',
    tool: 'write_file',
    args: { path: 'summary.md', content: 'ids: lead-001, lead-002' },
    requirementId: 'write_summary',
    withProposal: false,
  });
  assert.equal(dependent.admission.status, 'bound');
});
