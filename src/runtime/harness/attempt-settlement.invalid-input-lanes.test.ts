/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/attempt-settlement.invalid-input-lanes.test.ts
 *
 * Metamorphic pin for the invalid-local-input class (live 2026-08-31
 * end-of-day wrap_up: task_list {priority:"null"} — the SDK's schema layer
 * refused before the handler, the local errorFunction returned a plain string,
 * and lane 'byo' settled it succeeded/host_execution with a result handle).
 *
 * The fix is at the PRODUCER: the local errorFunction returns the nominal
 * InvalidArgumentsPreDispatchResult. This file proves the other half of the
 * contract — that the settlement kernel already treats that one carrier
 * identically on every lane, with zero crossings and no result handle, so no
 * lane-specific prose gate is needed anywhere. The negative control keeps the
 * bare string settling succeeded on byo: the kernel never reads prose
 * (attempt-settlement.semantic-truth.red.test.ts 'forward-only' pin), which is
 * exactly why the carrier must be minted where the truth is known.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-invalid-input-lanes-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-invalid-input-lanes\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identity = await import('./attempt-identity.js');
const ledger = await import('./dispatch-ledger.js');
const settlement = await import('./attempt-settlement.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const LANES = ['byo', 'agents_runner', 'native_mcp', 'claude_sdk', 'composio'] as const;

/** The exact live arguments (event 102340). */
const LIVE_ARGS = { status: 'completed', since: 'today', priority: 'null', project: 'null', limit: 50 };

/** The exact bytes the local errorFunction produces for them (event 102344). */
const LIVE_TEXT = [
  'An error occurred while running the tool. Please try again. Error: InvalidToolInputError: Invalid JSON input for tool',
  'The arguments for task_list did not match its schema — priority: Invalid option: expected one of "high"|"medium"|"low". '
  + 'Call tool_search with the exact query "task_list" to get the full input schema, then retry once with corrected arguments.',
].join('\n');

let serial = 0;

function accept(label: string) {
  const session = eventlog.createSession({ id: `invalid-input-lanes-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Wrap up the day (${label}).` },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identity.acceptedTaskIdFor(session.id, source.seq),
  };
}

/** Every lane admits its logical call before dispatch; the fixture does too.
 * No physical crossing is opened: validation refused before any body. */
function admit(task: ReturnType<typeof accept>, callId: string): void {
  const admitted = ledger.admitLogicalCall({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId: callId,
    },
    tool: 'task_list',
    args: LIVE_ARGS,
  });
  assert.ok(
    admitted.status === 'inserted',
    `fixture admitted the logical call (${admitted.status}${'reason' in admitted ? `: ${admitted.reason}` : ''})`,
  );
}

function durableRow(task: ReturnType<typeof accept>, callId: string) {
  return eventlog.openEventLog().prepare(`
    SELECT execution_kind, outcome_kind, outcome_evidence, recovery_action,
           physical_crossing_count, host_crossing_count, result_handle_id,
           observer_lane, business_call, credited_progress
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, callId) as {
    execution_kind: string;
    outcome_kind: string;
    outcome_evidence: string;
    recovery_action: string;
    physical_crossing_count: number;
    host_crossing_count: number | null;
    result_handle_id: string | null;
    observer_lane: string;
    business_call: number;
    credited_progress: number;
  } | undefined;
}

function successHandleCount(task: ReturnType<typeof accept>): number {
  const row = eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM durable_result_handles
     WHERE session_id = ? AND source_user_seq = ? AND success = 1
  `).get(task.sessionId, task.sourceUserSeq) as { n: number };
  return row.n;
}

test('the nominal invalid-input carrier settles identically on every lane: invalid_arguments, refused before dispatch, no handle', () => {
  const settled = LANES.map((lane) => {
    const task = accept(`lane ${lane}`);
    const callId = `logical:invalid-input:${lane}`;
    admit(task, callId);
    const result = settlement.settleToolAttempt({
      ...task,
      lane,
      toolName: 'task_list',
      callId,
      args: LIVE_ARGS,
      mutating: false,
      businessCall: true,
      result: new settlement.InvalidArgumentsPreDispatchResult(LIVE_TEXT),
    });
    return { lane, task, callId, result, row: durableRow(task, callId) };
  });

  for (const { lane, task, result, row } of settled) {
    assert.equal(result.outcome.kind, 'invalid_arguments', lane);
    assert.equal(result.outcome.evidence, 'nominal', `${lane}: the carrier, never the prose, is the evidence`);
    assert.equal(result.outcome.directive.action, 'repair_arguments', lane);
    assert.equal(result.outcome.directive.retrySameCandidate, true, `${lane}: a typo is not a dead capability`);
    assert.equal(result.outcome.directive.eliminatesCandidate, false, lane);
    assert.equal(result.creditedProgress, false, `${lane}: a refused object cannot complete business work`);
    assert.equal(result.resultHandleId, undefined, `${lane}: no durable result authority is minted`);
    assert.equal(result.duplicate, false, lane);
    assert.equal(successHandleCount(task), 0, lane);
    assert.deepEqual(row, {
      execution_kind: 'refused_pre_dispatch',
      outcome_kind: 'invalid_arguments',
      outcome_evidence: 'nominal',
      recovery_action: 'repair_arguments',
      physical_crossing_count: 0,
      host_crossing_count: 0,
      result_handle_id: null,
      observer_lane: lane,
      // task_list is a control-role read (live event 102340: topologyRole
      // control); the kernel derives that from the registry, not the caller.
      business_call: 0,
      credited_progress: 0,
    }, `${lane}: the durable row is the same verdict`);
  }

  // Metamorphic core: only the observer lane differs between rows/verdicts.
  const [reference, ...others] = settled;
  for (const other of others) {
    assert.deepEqual(
      other.result.outcome,
      reference.result.outcome,
      `${other.lane} settles the byte-identical outcome that ${reference.lane} does`,
    );
    assert.deepEqual(
      { ...other.row, observer_lane: undefined },
      { ...reference.row, observer_lane: undefined },
      `${other.lane} persists the identical row that ${reference.lane} does`,
    );
  }
});

test('a ProviderPreDispatchRefusalError thrown by the invoke adapter settles a MUTATION as refused before dispatch, never uncertain', () => {
  // Live 2026-09-01 (platform-49 run 23695e): the shipped adapter threw a
  // plain Error before any provider request; the mutating call settled
  // uncertain_write and the run was parked for a call that never left the
  // process. The class name is the nominal not-started marker.
  const task = accept('adapter pre-dispatch refusal');
  const callId = 'logical:adapter-refusal:byo';
  admit(task, callId);
  const thrown = new Error('generic external write requires current call authority');
  thrown.name = 'ProviderPreDispatchRefusalError';
  const result = settlement.settleToolAttempt({
    ...task,
    lane: 'byo',
    toolName: 'task_list',
    callId,
    args: LIVE_ARGS,
    mutating: true,
    businessCall: true,
    thrown,
  });
  assert.notEqual(result.outcome.kind, 'uncertain_write', 'nothing left the process');
  assert.equal(result.outcome.directive.action !== 'reconcile_then_decide', true);
  assert.equal(result.creditedProgress, false);
  assert.equal(result.resultHandleId, undefined);
  const row = durableRow(task, callId);
  assert.equal(row.execution_kind, 'refused_pre_dispatch');
  assert.equal(row.physical_crossing_count, 0);
});

test('NEGATIVE control: the same bytes as a bare string still settle succeeded on byo (why the fix is at the producer)', () => {
  const task = accept('bare string');
  const callId = 'logical:invalid-input:bare-string';
  admit(task, callId);
  const settled = settlement.settleToolAttempt({
    ...task,
    lane: 'byo',
    toolName: 'task_list',
    callId,
    args: LIVE_ARGS,
    mutating: false,
    businessCall: true,
    result: LIVE_TEXT,
  });
  // The kernel must not read byo prose: a local read can legitimately return
  // file/log bytes beginning with the same sentence. This is the live
  // laundering, kept on purpose so a producer regression is visible here.
  assert.equal(settled.outcome.kind, 'succeeded');
  assert.equal(settled.outcome.detail, 'host_execution');
  assert.equal(durableRow(task, callId)?.execution_kind, 'local_execution');
});
