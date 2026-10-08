import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-approved-invocation-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });

const events = await import('./eventlog.js');
const pending = await import('./pending-actions.js');
const registry = await import('./approval-registry.js');
const { pendingActionApprovalView } = await import('./pending-action-view.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const { requireAcceptedTaskAuthority } = await import('./accepted-task-authority.js');
const { requireActionExpectedWorkActivation } = await import('./action-expected-work-boundary.js');
const { expectedTaskFor, ensureAcceptedTaskResolutionOpenInTransaction } = await import('./resolution-ledger.js');
const authority = await import('./accepted-turn-call-authority.js');
const leases = await import('./dispatch-lease.js');
const brackets = await import('./brackets.js');
const invocation = await import('./host-tool-invocation.js');
const { currentToolAbortSignal } = await import('../tool-abort-context.js');
const { dispatchBatchItemTool } = await import('../../tools/inner-dispatch.js');
const { tool: sdkTool } = await import('@openai/agents');
const { z } = await import('zod');

after(() => { events.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

function fixture(toolName = 'run_shell_command') {
  const session = events.createSession({ kind: 'chat' });
  const attempt = events.beginRunAttempt(session.id, { runId: `approved:${session.id}` });
  const action = pending.queuePendingAction({ title: 'Controlled file', kind: 'shell_command',
    toolName, payload: { command: 'printf controlled > /tmp/approved-fixture.txt', cwd: '/tmp', timeout_ms: 20000 },
    sessionId: session.id });
  const card = registry.register({ sessionId: session.id, subject: action.title, tool: 'request_approval',
    args: { pendingActionId: action.id, pendingAction: pendingActionApprovalView(action) } });
  assert.equal(registry.resolve(card.approvalId, 'approved', 'fixture').ok, true);
  const source = events.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user',
    data: { text: 'Create a text file with the approved content.', source: 'desktop_approval',
      approvalId: card.approvalId, decision: 'approve' } }, { armRunInFlight: true });
  assert.ok(recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 } }));
  requireAcceptedTaskAuthority({ sessionId: session.id, sourceUserSeq: source.seq });
  requireActionExpectedWorkActivation({ sessionId: session.id, sourceUserSeq: source.seq });
  const expected = expectedTaskFor(session.id, source.seq);
  assert.equal(expected.status, 'ok');
  if (expected.status !== 'ok') throw new Error(expected.reason);
  assert.equal(expected.graph.effectCeiling, 'local_write');
  const db = events.openEventLog();
  db.transaction(() => ensureAcceptedTaskResolutionOpenInTransaction(db, expected.expectation))();
  const claim = pending.claimPendingActionExecution(action.id, 'fixture', { expectedSessionId: session.id, requireResolvedHumanCard: true });
  assert.equal(claim.claimed, true);
  assert.ok(claim.claimToken);
  const capability = { pendingActionId: action.id, payloadHash: action.payloadHash,
    claimToken: claim.claimToken!, sourceUserSeq: source.seq };
  const parentLease = leases.activateDispatchLease({ sessionId: session.id,
    scopeId: `approved-fixture:${attempt.attemptId}`, runAttemptId: attempt.attemptId });
  const context: brackets.HarnessRunContext = { sessionId: session.id, sourceUserSeq: source.seq,
    runAttemptId: attempt.attemptId, turn: 1, counter: new brackets.ToolCallsCounter(1),
    pendingActionExecution: capability, dispatchLease: parentLease };
  const input = { identity: { sessionId: session.id, sourceUserSeq: source.seq,
    modelCallId: pending.pendingActionResumeLogicalCallId(capability), toolName: action.toolName, args: action.payload, turn: 1 },
    parentLease, effect: 'local_write' as const, boundary: 'host_owned_local' as const,
    deadlineMs: 5000, pendingActionExecution: capability };
  return { session, attempt, source, action, capability, context, input };
}

test('an exact claimed graph action owns local physical evidence and passes its one signal through inner dispatch', async () => {
  const f = fixture();
  let bodySignal: AbortSignal | undefined;
  const tool = sdkTool({ name: 'run_shell_command', description: 'Controlled in-memory shell fixture',
    parameters: z.object({ command: z.string(), cwd: z.string(), timeout_ms: z.number() }),
    execute: async () => { bodySignal = currentToolAbortSignal(); return 'Written successfully.'; } });
  const result = await brackets.withHarnessRunContext(f.context, () => invocation.invokeHostToolCall({ ...f.input,
    invoke: ({ signal }) => dispatchBatchItemTool(f.action.toolName, f.action.payload, f.session.id,
      f.context.counter, { batchId: f.action.id, payloadHash: f.action.payloadHash },
      undefined, undefined, f.capability, false, tool as never).then(value => {
        assert.equal(bodySignal, signal); return value;
      }),
  }));
  assert.equal(result.settlement.outcome.kind, 'succeeded');
  const physical = events.openEventLog().prepare(`SELECT logical_tool_call_id, source_user_seq, state
    FROM physical_dispatches WHERE session_id = ?`).all(f.session.id) as Array<Record<string, unknown>>;
  assert.equal(physical.length, 1);
  assert.equal(physical[0].logical_tool_call_id, f.input.identity.modelCallId);
  assert.equal(physical[0].source_user_seq, f.source.seq);
  assert.equal(physical[0].state, 'returned');
});

test('mutated payload, foreign source, changed effect, and host_v1 roots cannot borrow a pending-action claim', async () => {
  for (const mutation of ['payload', 'source', 'effect', 'host_v1'] as const) {
    const f = fixture();
    let invoked = 0;
    const input = { ...f.input, identity: { ...f.input.identity },
      pendingActionExecution: { ...f.capability }, effect: f.input.effect as invocation.InvokeHostToolCallInput<unknown>['effect'] };
    if (mutation === 'payload') input.identity.args = { ...f.action.payload as object, command: 'printf changed > /tmp/approved-fixture.txt' };
    if (mutation === 'source') input.pendingActionExecution.sourceUserSeq += 1;
    if (mutation === 'effect') input.effect = 'compute';
    if (mutation === 'host_v1') {
      const session = events.createSession({ kind: 'chat' });
      const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Controlled host call' } });
      const digest = createHash('sha256').update(session.id).digest('hex');
      assert.equal(authority.armHostCallAuthority({ sessionId: session.id, sourceUserSeq: source.seq,
        catalogRevisionDigest: digest, bindingRevisionDigest: digest, maxLogicalCalls: 1, maxParallelCalls: 1 }).status, 'armed');
      input.identity.sessionId = session.id; input.identity.sourceUserSeq = source.seq;
      input.pendingActionExecution.sourceUserSeq = source.seq;
      input.parentLease = leases.activateDispatchLease({ sessionId: session.id, scopeId: `host-negative:${session.id}` });
    }
    await assert.rejects(() => invocation.invokeHostToolCall({ ...input,
      invoke: () => { invoked++; return 'Must not execute'; } }), invocation.HostToolInvocationAuthorityError, mutation);
    assert.equal(invoked, 0, mutation);
    assert.equal((events.openEventLog().prepare(`SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?`).get(f.session.id) as { n: number }).n, 0);
  }
});

test('a valid claim cannot classify an unknown actual operation as harmless work', async () => {
  const f = fixture('OPAQUE_FIXTURE_OPERATION');
  let invoked = 0;
  assert.equal(pending.verifyPendingActionExecutionCapability({ capability: f.capability,
    sessionId: f.session.id, toolName: f.action.toolName, payload: f.action.payload }), true);
  await assert.rejects(() => invocation.invokeHostToolCall({ ...f.input,
    invoke: () => { invoked++; return 'Must not execute'; } }), invocation.HostToolInvocationAuthorityError);
  assert.equal(invoked, 0);
});

test('jointly retargeting a claim and invocation to another same-session action source is refused', async () => {
  const f = fixture();
  const foreign = events.appendEvent({ sessionId: f.session.id, turn: 2, role: 'user',
    type: 'user_input_received', data: { text: 'Create another text file with separate content.' } });
  assert.ok(recordTurnGraphShadow({ identity: { sessionId: f.session.id, sourceUserSeq: foreign.seq, turn: 2 } }));
  requireAcceptedTaskAuthority({ sessionId: f.session.id, sourceUserSeq: foreign.seq });
  requireActionExpectedWorkActivation({ sessionId: f.session.id, sourceUserSeq: foreign.seq });
  const expected = expectedTaskFor(f.session.id, foreign.seq);
  assert.equal(expected.status, 'ok');
  if (expected.status !== 'ok') throw new Error(expected.reason);
  const db = events.openEventLog();
  db.transaction(() => ensureAcceptedTaskResolutionOpenInTransaction(db, expected.expectation)).immediate();
  const capability = { ...f.capability, sourceUserSeq: foreign.seq };
  let invoked = 0;
  await assert.rejects(() => invocation.invokeHostToolCall({ ...f.input,
    identity: { ...f.input.identity, sourceUserSeq: foreign.seq, modelCallId: pending.pendingActionResumeLogicalCallId(capability) },
    pendingActionExecution: capability, invoke: () => { invoked++; return 'Must not execute'; } }), invocation.HostToolInvocationAuthorityError);
  assert.equal(invoked, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?`).get(f.session.id) as { n: number }).n, 0);
});

test('exact Stop fences a claimed mutating action and a late successful body cannot overwrite uncertainty', async () => {
  const f = fixture();
  let release!: (value: string) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const body = new Promise<string>(resolve => { release = resolve; });
  let signal: AbortSignal | undefined;
  const flight = brackets.withHarnessRunContext(f.context, () => invocation.invokeHostToolCall({ ...f.input,
    // The approved action kernel derives this exact durable Stop owner even
    // when a caller does not supply its own latch callback.
    killPollMs: 5,
    invoke: context => { signal = context.signal; started(); return body; },
  })) as Promise<unknown>;
  // Observe an early authority rejection as well as entry, without allowing a
  // rejected setup to become an unhandled promise or leave this test waiting.
  const rejected = flight.then(() => { throw new Error('Expected Stop rejection'); }, error => { throw error; });
  rejected.catch(() => {});
  await Promise.race([entered, rejected]);
  for (const modelCallId of [`${f.input.identity.modelCallId}:changed`, f.input.identity.modelCallId]) {
    await assert.rejects(() => invocation.invokeHostToolCall({ ...f.input,
      identity: { ...f.input.identity, modelCallId }, invoke: () => 'Duplicate must not run' }), invocation.HostToolInvocationAuthorityError);
  }
  assert.equal((events.openEventLog().prepare(`SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?`).get(f.session.id) as { n: number }).n, 1);
  events.requestKill(f.session.id, 'Controlled Stop', { attemptId: f.attempt.attemptId });
  await assert.rejects(() => flight, invocation.HostToolInvocationUncertainError);
  assert.equal(signal?.aborted, true);
  const before = events.openEventLog().prepare(`SELECT state FROM physical_dispatches WHERE session_id = ?`).get(f.session.id);
  assert.deepEqual(before, { state: 'unknown' });
  release('Late success must be ignored');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.openEventLog().prepare(`SELECT state FROM physical_dispatches WHERE session_id = ?`).get(f.session.id), before);
});
