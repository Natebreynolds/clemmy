/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-tool-invocation.local-invalid-input.test.ts
 *
 * The invalid-local-input class on the HOST lane (live 2026-08-31 end-of-day
 * wrap_up: task_list {priority:"null"} settled succeeded/host_execution with a
 * host crossing and a result handle on lane byo, event 102343).
 *
 * Twin of host-tool-invocation.test.ts 'typed provider-argument repair refuses
 * before crossing…' for a HOST-OWNED LOCAL tool. Two shapes:
 *   1. the live one — the tool's own return is the nominal carrier (what the
 *      local errorFunction now produces); the host settles it invalid_arguments
 *      with zero provider crossings and no result handle;
 *   2. the literal twin — the carrier arrives from beforePhysicalPreparation
 *      on the host_owned_local boundary; zero rows of any kind.
 * Then the production-shaped proof: the REAL task_list tool, wrapped for the
 * harness, with the exact live arguments.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-local-invalid-input-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-host-local-invalid-input\n', 'utf8');

const eventlog = await import('./eventlog.js');
const leases = await import('./dispatch-lease.js');
const identities = await import('./attempt-identity.js');
const attemptSettlements = await import('./attempt-settlement.js');
const brackets = await import('./brackets.js');
const invocation = await import('./host-tool-invocation.js');
const callAuthority = await import('./accepted-turn-call-authority.js');
const logicalContracts = await import('./logical-call-contract.js');
const hostBindings = await import('./host-call-capability-binding.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const { getLocalRuntimeTools } = await import('../../tools/local-runtime-tools.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The exact live arguments (event 102340). */
const LIVE_ARGS = { status: 'completed', since: 'today', priority: 'null', project: 'null', limit: 50 };

/** The exact bytes the local errorFunction produces for them (event 102344). */
const LIVE_TEXT = [
  'An error occurred while running the tool. Please try again. Error: InvalidToolInputError: Invalid JSON input for tool',
  'The arguments for task_list did not match its schema — priority: Invalid option: expected one of "high"|"medium"|"low". '
  + 'Call tool_search with the exact query "task_list" to get the full input schema, then retry once with corrected arguments.',
].join('\n');

function fixture(text: string) {
  const session = eventlog.createSession({ id: `host-local-invalid-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const armed = callAuthority.armHostCallAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    catalogRevisionDigest: digest(`host-surface-catalog:${session.id}`),
    bindingRevisionDigest: digest(`host-surface-binding:${session.id}`),
    maxLogicalCalls: 20,
    maxParallelCalls: 20,
  });
  assert.equal(armed.status, 'armed');
  const parentLease = leases.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::host-parent`,
  });
  const context: brackets.HarnessRunContext = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(20),
    dispatchLease: parentLease,
  };
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    parentLease,
    context,
  };
}

function runCall<T>(
  task: ReturnType<typeof fixture>,
  options: {
    callId: string;
    beforePhysicalPreparation?: invocation.InvokeHostToolCallInput<T>['beforePhysicalPreparation'];
    invoke: invocation.InvokeHostToolCallInput<T>['invoke'];
  },
) {
  const toolName = 'task_list';
  const args = LIVE_ARGS;
  const root = callAuthority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') throw new Error(root.reason);
  const contract = logicalContracts.durableLogicalCallContract(task.acceptedTaskId, toolName, args);
  assert.ok(contract);
  if (!contract) throw new Error('fixture call contract is unsafe');
  const attestationBase = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: options.callId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect: 'read' as const,
    bindingKind: 'catalog_manifest' as const,
    capabilityId: `cap:${contract.toolName}`,
    schemaFingerprint: digest(`manifest-schema:${contract.toolName}`),
    accountId: 'conn-provider',
    invokePortId: 'fixture:invoke',
    operationId: contract.toolName,
    manifestId: `cap:${contract.toolName}`,
    manifestDigest: digest(`manifest:${contract.toolName}`),
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest: digest(`host-surface-catalog:${task.sessionId}`),
    bindingRevisionDigest: digest(`host-surface-binding:${task.sessionId}`),
  };
  const attestation = {
    ...attestationBase,
    bindingDigest: hostBindings.hostCallAttestationBindingDigest(attestationBase),
  };
  return callAuthority.withHostCallAttestation(attestation, () =>
    brackets.withHarnessRunContext(task.context, () => invocation.invokeHostToolCall({
      identity: {
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        modelCallId: options.callId,
        toolName,
        args,
        turn: 1,
      },
      parentLease: task.parentLease,
      effect: 'read',
      businessCall: true,
      boundary: 'host_owned_local',
      deadlineMs: 200,
      killPollMs: 5,
      beforePhysicalPreparation: options.beforePhysicalPreparation,
      invoke: options.invoke,
    }))) as Promise<invocation.HostToolInvocationResult<T>>;
}

function rows(task: { sessionId: string; sourceUserSeq: number }, callId?: string) {
  return eventlog.openEventLog().prepare(`
    SELECT logical_tool_call_id, state, execution_site
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
       AND (? IS NULL OR logical_tool_call_id = ?)
     ORDER BY logical_tool_call_id, ordinal
  `).all(task.sessionId, task.sourceUserSeq, callId ?? null, callId ?? null) as Array<{
    logical_tool_call_id: string;
    state: string;
    execution_site: string | null;
  }>;
}

function settlementRow(task: { sessionId: string; sourceUserSeq: number }, callId?: string) {
  return eventlog.openEventLog().prepare(`
    SELECT execution_kind, outcome_kind, outcome_evidence, recovery_action,
           physical_crossing_count, host_crossing_count, result_handle_id, credited_progress
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
       AND (? IS NULL OR logical_tool_call_id = ?)
     ORDER BY settled_at DESC
     LIMIT 1
  `).get(task.sessionId, task.sourceUserSeq, callId ?? null, callId ?? null) as {
    execution_kind: string;
    outcome_kind: string;
    outcome_evidence: string;
    recovery_action: string;
    physical_crossing_count: number;
    host_crossing_count: number | null;
    result_handle_id: string | null;
    credited_progress: number;
  } | undefined;
}

function successHandleCount(task: { sessionId: string; sourceUserSeq: number }): number {
  const row = eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM durable_result_handles
     WHERE session_id = ? AND source_user_seq = ? AND success = 1
  `).get(task.sessionId, task.sourceUserSeq) as { n: number };
  return row.n;
}

test('a host-owned local tool whose own return is the invalid-input carrier settles invalid_arguments: no provider crossing, no handle, no progress', async () => {
  const task = fixture('List the tasks completed today and wrap up.');
  const refusal = new attemptSettlements.InvalidArgumentsPreDispatchResult(LIVE_TEXT);
  let bodies = 0;
  const callId = 'model:task-list-invalid-input';
  const refused = await runCall(task, {
    callId,
    invoke: async () => {
      bodies += 1;
      return refusal;
    },
  });
  assert.equal(refused.value, refusal,
    'the value IS the refusal; the wrapper renders its .output to the model');
  assert.equal(String(refused.value), LIVE_TEXT, 'model-facing bytes are unchanged');
  assert.equal(refused.settlement.outcome.kind, 'invalid_arguments');
  assert.equal(refused.settlement.outcome.evidence, 'nominal');
  assert.equal(refused.settlement.outcome.directive.action, 'repair_arguments');
  assert.equal(refused.settlement.creditedProgress, false,
    'a malformed object cannot satisfy or consume business work');
  assert.equal(refused.settlement.resultHandleId, undefined);
  assert.equal(bodies, 1, 'the SDK body was entered; its schema layer refused before execute');
  assert.equal(successHandleCount(task), 0, 'no success-shaped durable result is minted');

  // The host's own crossing was opened before the body (host_owned_local
  // marks it execution_site 'host'); nothing left the machine.
  const crossings = rows(task, callId);
  assert.equal(crossings.filter((row) => row.execution_site !== 'host').length, 0,
    'no provider crossing exists for a refusal that happened inside the process');
  assert.ok(crossings.every((row) => row.state === 'returned'), JSON.stringify(crossings));
  assert.deepEqual(settlementRow(task, callId), {
    execution_kind: 'refused_pre_dispatch',
    outcome_kind: 'invalid_arguments',
    outcome_evidence: 'nominal',
    recovery_action: 'repair_arguments',
    physical_crossing_count: 0,
    host_crossing_count: crossings.length,
    result_handle_id: null,
    credited_progress: 0,
  });
  const rootAfterRefusal = callAuthority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(rootAfterRefusal.status === 'ok' && rootAfterRefusal.authority.state, 'open',
    'a correctable argument mismatch must not poison the accepted-source authority');
  leases.revokeDispatchLease(task.parentLease);
});

test('literal twin: the carrier from beforePhysicalPreparation on host_owned_local refuses with zero rows and the refusal as the value', async () => {
  const task = fixture('List the tasks completed today.');
  let bodies = 0;
  const callId = 'model:task-list-preparation-refused';
  const refused = await runCall(task, {
    callId,
    beforePhysicalPreparation: async () => (
      new attemptSettlements.InvalidArgumentsPreDispatchResult(LIVE_TEXT)
    ),
    invoke: async () => {
      bodies += 1;
      return 'must not run';
    },
  });
  assert.equal(refused.value, LIVE_TEXT);
  assert.equal(refused.settlement.outcome.kind, 'invalid_arguments');
  assert.equal(refused.settlement.outcome.directive.action, 'repair_arguments');
  assert.equal(bodies, 0);
  assert.equal(rows(task, callId).length, 0, 'no crossing of any kind is admitted');
  assert.deepEqual(settlementRow(task, callId), {
    execution_kind: 'refused_pre_dispatch',
    outcome_kind: 'invalid_arguments',
    outcome_evidence: 'nominal',
    recovery_action: 'repair_arguments',
    physical_crossing_count: 0,
    host_crossing_count: 0,
    result_handle_id: null,
    credited_progress: 0,
  });
  leases.revokeDispatchLease(task.parentLease);
});

test('production shape: the real task_list tool, wrapped for the harness, refuses the live arguments as invalid_arguments and the model gets the repair text', async () => {
  // The composio-direct precedent, on the local surface: the SDK wrapper's
  // errorFunction is the producer, the bracket wrapper derives the typed
  // signals from the returned instance, and settlement never reads prose.
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Wrap up the day: list what got done.' },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
  }));
  const accepted = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const taskList = getLocalRuntimeTools().find((candidate) => candidate.name === 'task_list');
  assert.ok(taskList, 'the production runtime exports task_list');
  const wrapped = brackets.wrapToolForHarness(taskList) as typeof taskList & {
    invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
  };
  const counter = new brackets.ToolCallsCounter(10);
  const callId = 'model:task-list-live-args';
  const output = await brackets.withHarnessRunContext({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.sourceUserSeq,
    turn: accepted.turn,
    behaviorScopeId: `${accepted.sessionId}::invalid-args`,
    counter,
  }, () => wrapped.invoke(
    { context: { sessionId: accepted.sessionId } },
    JSON.stringify(LIVE_ARGS),
    { toolCall: { callId } },
  ));

  assert.equal(typeof output, 'string', 'the model receives repair guidance, not the internal carrier');
  assert.match(String(output), /^An error occurred while running the tool/);
  assert.match(String(output), /priority: Invalid option/);
  assert.match(String(output), /tool_search/);
  assert.equal(counter.calls, 1, 'the refused attempt still consumes one tool-call unit');

  assert.deepEqual(settlementRow(accepted), {
    execution_kind: 'refused_pre_dispatch',
    outcome_kind: 'invalid_arguments',
    outcome_evidence: 'nominal',
    recovery_action: 'repair_arguments',
    physical_crossing_count: 0,
    host_crossing_count: 0,
    result_handle_id: null,
    credited_progress: 0,
  });
  assert.equal(rows(accepted).length, 0, 'no provider or host body crossing was admitted');
  assert.equal(successHandleCount(accepted), 0);
});
