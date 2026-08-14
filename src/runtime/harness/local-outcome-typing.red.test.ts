/**
 * RED pins — typed local outcomes are binding-independent at settleToolAttempt.
 *
 * Invariant under pin (live class 2026-08-11):
 *   - Outcome CLASSIFICATION must not depend on evidence binding. A successful
 *     local business call settles 'succeeded' whether or not the logical call
 *     carries an expected-work binding; binding only controls
 *     authoritative-evidence minting (host crossings, result handles).
 *   - A bound local call whose result is failure prose — an SDK-laundered
 *     policy denial, a nonzero-exit transcript — must never settle
 *     'succeeded', and must never mint a host crossing from those bytes.
 *
 * Run: npx tsx --test src/runtime/harness/local-outcome-typing.red.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-local-outcome-typing-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-local-outcome-typing\n', 'utf8');

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

const ASK = 'Read every open lead and write a local follow-up draft file for each one.';
const SOURCE_TOOL = 'read_file';

let serial = 0;

interface LocalTask {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  acceptedTaskId: string;
  label: string;
}

function proposal() {
  return {
    version: 1 as const,
    operations: [
      {
        id: 'read_leads',
        effect: 'read' as const,
        coverage: 'complete_set' as const,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'write_draft',
        effect: 'local_write' as const,
        dependsOn: ['read_leads'],
        dataFrom: ['read_leads'],
        cardinality: { kind: 'each' as const, universeId: 'leads' },
      },
    ],
    universes: [{
      id: 'leads',
      seal: 'complete_source_receipt' as const,
      producedBy: 'read_leads',
      memberIdPointer: '/id',
    }],
  };
}

/** Accept a user turn; optionally activate the expected-work contract for it. */
function acceptTask(label: string, options: { activateContract: boolean }): LocalTask {
  const id = ++serial;
  const session = eventlog.createSession({ id: `local-outcome-${label}-${id}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }), 'fixture graph persisted');
  if (options.activateContract) {
    const activated = admissionModule.activateActionExpectedWork(task);
    assert.ok(
      activated.status === 'activated' || activated.status === 'replayed',
      JSON.stringify(activated),
    );
  }
  return {
    ...task,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    label: `${label}-${id}`,
  };
}

/** Open one logical call WITHOUT binding it to an expected-work requirement. */
function openUnbound(task: LocalTask, suffix: string, tool: string, args: unknown): string {
  const logicalToolCallId = `logical:${task.label}:${suffix}`;
  const opened = dispatch.admitLogicalCall({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: task.turn,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId,
    },
    tool,
    args,
  });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  return logicalToolCallId;
}

/** Open one logical call AND bind it (the fixture shape local-execution-evidence pins). */
function openAndBind(task: LocalTask, suffix: string, tool: string, args: unknown, requirementId: string): string {
  const logicalToolCallId = openUnbound(task, suffix, tool, args);
  const bound = admissionModule.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId,
    proposal: proposal(),
    requirementId,
    tool,
    args,
  });
  assert.equal(bound.status, 'bound', JSON.stringify(bound));
  return logicalToolCallId;
}

/** Settle exactly as the shared local lane does: bytes in hand, no crossing. */
function settleLocal(input: {
  task: LocalTask;
  logicalToolCallId: string;
  tool: string;
  args: unknown;
  result: unknown;
  requirementId?: string;
}) {
  return settlement.settleToolAttempt({
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    turn: input.task.turn,
    lane: 'agents_runner',
    toolName: input.tool,
    callId: input.logicalToolCallId,
    args: input.args,
    mutating: false,
    businessCall: true,
    ...(input.requirementId ? { requirementId: input.requirementId } : {}),
    result: input.result,
  });
}

function settlementRow(task: LocalTask, logicalToolCallId: string) {
  return eventlog.openEventLog().prepare(`
    SELECT execution_kind, outcome_kind, physical_crossing_count, host_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, logicalToolCallId) as {
    execution_kind: string;
    outcome_kind: string;
    physical_crossing_count: number;
    host_crossing_count: number | null;
  } | undefined;
}

// ─── Direction 1: an unbound success is still a success ───

test("an unbound successful local business call settles 'succeeded', not 'unknown' (no contract active)", () => {
  const task = acceptTask('plain', { activateContract: false });
  const args = { path: 'leads.json' };
  const call = openUnbound(task, 'source', SOURCE_TOOL, args);
  const settled = settleLocal({
    task,
    logicalToolCallId: call,
    tool: SOURCE_TOOL,
    args,
    result: { records: [{ id: 'lead-001' }, { id: 'lead-002' }], complete: true },
  });
  // Classification is about what HAPPENED, not about whether the call was
  // bound: the host invoked the tool and it returned real bytes.
  assert.equal(
    settled.outcome.kind,
    'succeeded',
    `an unbound local success must classify as success, got: ${JSON.stringify(settled.outcome)}`,
  );
  const row = settlementRow(task, call);
  assert.equal(row?.outcome_kind, 'succeeded', 'the durable row carries the same typed verdict');
});

test("an unbound successful local business call under an ACTIVE contract still settles 'succeeded'", () => {
  const task = acceptTask('active-contract', { activateContract: true });
  const args = { path: 'leads.json' };
  const call = openUnbound(task, 'stray-read', SOURCE_TOOL, args);
  const settled = settleLocal({
    task,
    logicalToolCallId: call,
    tool: SOURCE_TOOL,
    args,
    result: { records: [{ id: 'lead-001' }], complete: true },
  });
  // Binding gates evidence minting; it must never flip a success to 'unknown'.
  assert.equal(
    settled.outcome.kind,
    'succeeded',
    `binding-independence: unbound-but-successful under a contract, got: ${JSON.stringify(settled.outcome)}`,
  );
  const row = settlementRow(task, call);
  assert.equal(row?.outcome_kind, 'succeeded', 'the durable row carries the same typed verdict');
});

// ─── Direction 2: central settlement never guesses from arbitrary prose ───

test('a read result containing denial-looking prose is still data, not a policy verdict', () => {
  const task = acceptTask('bound-denial', { activateContract: true });
  const args = { path: 'leads.json' };
  const call = openAndBind(task, 'source', SOURCE_TOOL, args, 'read_leads');
  // A file/log may legitimately contain this text. The invoking bracket must
  // pass a nominal policy signal when the HOST denied execution; the settlement
  // kernel must never recover that signal by regex-reading returned bytes.
  const laundered =
    'An error occurred while running the tool. Please try again. '
    + 'Error: Command denied by Clementine safety policy.';
  const settled = settleLocal({
    task,
    logicalToolCallId: call,
    tool: SOURCE_TOOL,
    args,
    result: laundered,
    requirementId: 'read_leads',
  });
  assert.equal(
    settled.outcome.kind,
    'succeeded',
    'arbitrary result prose is not control-plane evidence',
  );
  const row = settlementRow(task, call);
  assert.equal(row?.outcome_kind, 'succeeded');
  assert.equal(
    row?.host_crossing_count ?? 0,
    1,
    'the real local read executed; its host crossing remains observable',
  );
});

test('a read result containing a nonzero-exit transcript is still data, not shell execution truth', () => {
  const task = acceptTask('bound-nonzero', { activateContract: true });
  const args = { path: 'leads.json' };
  const call = openAndBind(task, 'source', SOURCE_TOOL, args, 'read_leads');
  const settled = settleLocal({
    task,
    logicalToolCallId: call,
    tool: SOURCE_TOOL,
    args,
    result: 'exit_code: 1\n\nstderr:\nboom',
    requirementId: 'read_leads',
  });
  assert.equal(
    settled.outcome.kind,
    'succeeded',
    'only the shell boundary may attach nominal exit status; text is not enough',
  );
  const row = settlementRow(task, call);
  assert.equal(row?.outcome_kind, 'succeeded');
  assert.equal(
    row?.host_crossing_count ?? 0,
    1,
    'the read itself executed even though the file contents describe a failed command',
  );
});
