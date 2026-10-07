import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { AgentInputItem } from '@openai/agents';
import type { AcceptedModelBatchRef } from './accepted-model-batch-checkpoint.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-accepted-model-batch-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_EMBED_AT_WRITE = 'off';
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
const observations = await import('./tool-invocation-observation-context.js');
const protocol = await import('./conversation-protocol.js');
const protocolSession = await import('./conversation-protocol-session.js');
const hostResults = await import('./host-model-result-receipt.js');
const logicalResults = await import('./logical-model-result-projection-receipt.js');
const connectionCheckpoints = await import('./source-connection-checkpoints.js');
const plans = await import('./plan-artifacts.js');
const sessionStore = await import('./session.js');
const agentEnvelopes = await import('../../agents/capability-envelope.js');
const agentRebuild = await import('../../agents/agent-rebuild-context.js');
const mcpAuthority = await import('../mcp-tool-authority.js');
const sessionContext = await import('./source-session-context.js');
const sessionContextScope = await import('./source-session-context-scope.js');
const { rebuildSourceConnectionAgent } = await import('./connection-agent-rebuild.js');
const hostProgress = await import('./host-connection-progress.js');
const { readSourceConnectionHostRecovery } = await import('./connection-host-recovery.js');
const noProgress = await import('./no-progress-governor.js');
const connectionPause = await import('./connection-execution-pause.js');
const delivery = await import('./delivery-committer.js');
const outcomes = await import('./turn-outcome.js');
const connectionSetup = await import('./connection-setup.js');
const connectionActivation = await import('./connection-execution-activation.js');
const recoveryActivation = await import('./recovery-activation.js');
const connectionClosure = await import('./connection-execution-closure-proof.js');

test.after(async () => {
  (await import('../../memory/db.js')).closeMemoryDb();
  (await import('../../projects/project-record.js'))._closeProjectStoreForTests();
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
let serial = 0;

function fixture(text: string, mode: 'normal' | 'plan' | 'execute' = 'normal') {
  const session = eventlog.createSession({ id: `accepted-model-batch-${++serial}`, kind: 'chat', userId: 'checkpoint-owner' });
  let executeRef: import('./task-mode.js').PlanRevisionRef | undefined;
  if (mode === 'execute') {
    const planSource = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
      data: { text: 'Prepare the controlled task.', taskMode: { version: 1, kind: 'plan' } } });
    const artifact = plans.publishPlanRevision({ sessionId: session.id, principalId: 'checkpoint-owner',
      sourceUserSeq: planSource.seq, fullText: text, readiness: 'ready' });
    executeRef = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  }
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text, ...(mode !== 'normal' ? { taskMode: { version: 1, kind: mode, ...(executeRef ? { executeRef } : {}) } } : {}) },
  });
  if (executeRef) plans.claimPlanExecution({ sessionId: session.id, principalId: 'checkpoint-owner',
    sourceUserSeq: source.seq, executeRef });
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

async function connectionPauseFixture(beforeCheckpoint?: (task: Fixture) => void) {
  const task = fixture('Inspect the controlled CRM after connection.', 'execute');
  beforeCheckpoint?.(task);
  const batch = await settledConnectionBatch(task);
  const agent = connectionAgent(task);
  hostProgress.bindHostConnectionProgress(agent, recordedHostProgress(task, batch));
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent })!;
  const binding = connectionPause.prepareConnectionExecutionPause({ ...task, requestId: pause.requestId });
  assert.ok(binding);
  const identity = { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: 1 };
  const outcome: import('./turn-outcome.js').TurnOutcome = {
    version: 2, identity, id: outcomes.turnOutcomeId(identity), status: 'needs_input', resumable: true,
    needs: { kind: 'input' }, presentation: { kind: 'question', text: pause.text },
  };
  return { task, batch, agent, pause, binding, outcome };
}

async function connectionActivationFixture(beforeCheckpoint?: (task: Fixture) => void) {
  const f = await connectionPauseFixture(beforeCheckpoint);
  const originalAttempt = eventlog.beginRunAttempt(f.task.sessionId, { runId: `original-${f.task.sourceUserSeq}` });
  eventlog.recordRunAttemptUserInput(originalAttempt, { turn: 1, role: 'user', data: { text: f.task.text } },
    { existingEventSeq: f.task.sourceUserSeq, armRunInFlight: true });
  delivery.commitTurnOutcome(f.outcome, { metadata: { connectionExecutionPause: f.binding } });
  const context = { sessionId: f.task.sessionId, connectionRequestId: f.pause.requestId };
  connectionSetup.recordConnectionSetupResult(context, { connectionId: 'ca_controlled_fixture_account' });
  const checked = await connectionSetup.verifyConnectionSetup(context, async () => ({ ok: true }));
  assert.equal(checked.connectionVerified, true);
  assert.ok(checked.verificationBinding && checked.request);
  const setup = connectionSetup.readConnectionSetup(f.task.sessionId)!;
  const text = setup.continueLabel;
  const identity = connectionSetup.connectionContinuationIdentity(context, text, setup.clientRequestId);
  const runId = `controlled-connection-${f.task.sourceUserSeq}`;
  eventlog.claimHarnessChatRequest({ ...identity, sessionId: f.task.sessionId, runId,
    sinceSeq: eventlog.listEvents(f.task.sessionId).at(-1)!.seq });
  const leaseOwner = 'controlled-desktop';
  const claim = eventlog.claimRunAttemptLease({ sessionId: f.task.sessionId, runId, ownerId: leaseOwner, leaseMs: 90000 });
  assert.equal(claim.claimed, true);
  assert.ok(claim.attempt);
  const input = { context, text, clientRequestId: setup.clientRequestId, runId,
    attemptId: claim.attempt.attemptId, leaseOwner,
    verified: { sourceUserSeq: f.task.sourceUserSeq, binding: checked.verificationBinding } };
  return { ...f, input, attempt: claim.attempt, originalAttempt };
}

function connectionTerminal(f: Awaited<ReturnType<typeof connectionActivationFixture>>,
  active: ReturnType<typeof connectionActivation.activateConnectionExecution>, status: 'done' | 'cancelled' | 'blocked' | 'failed' | 'uncertain' = 'done') {
  const identity = { sessionId: f.task.sessionId, sourceUserSeq: active.source.seq, turn: active.source.turn };
  const outcome = { version: 2, identity, id: outcomes.turnOutcomeId(identity), status,
    resumable: status === 'blocked' || status === 'uncertain',
    presentation: { kind: status === 'done' ? 'answer' : status === 'cancelled' ? 'stopped' : status === 'failed' ? 'error' : 'blocked',
      text: `Controlled continuation ${status}.` } } as import('./turn-outcome.js').TurnOutcome;
  return eventlog.appendTerminalEventOnce({ sessionId: identity.sessionId, turn: identity.turn, role: 'system',
    data: delivery.completionDataForTurnOutcome(outcome) }, outcome.id);
}

for (const status of ['done', 'cancelled', 'blocked', 'failed', 'uncertain'] as const) {
  test(`connection ${status} closes original execution once and replays both terminals after reopen`, async () => {
    const f = await connectionActivationFixture();
    const pauseBefore = connectionPause.readConnectionExecutionPause(f.task.sessionId, f.pause.requestId);
    const active = connectionActivation.activateConnectionExecution(f.input);
    const result = connectionTerminal(f, active, status);
    assert.equal(result.inserted, true);
    assert.equal(result.event.data.sourceUserSeq, active.source.seq, 'delivery belongs to its actual control');
    const root = authority.acceptedTurnCallAuthorityFor(f.task.sessionId, f.task.sourceUserSeq);
    assert.equal(root.status, status === 'failed' || status === 'uncertain' ? 'conflict' : 'ok');
    if (root.status === 'ok') assert.equal(root.authority.state, status === 'failed' || status === 'uncertain' ? 'conflict' : 'closed');
    assert.equal(eventlog.getLatestRunAttemptByRunId(f.task.sessionId, f.input.runId)?.finishedAt !== null, true);
    assert.equal(sessionStore.HarnessSession.load(f.task.sessionId)!.continuationOwnerState(active.owner), 'absent');
    assert.equal(connectionClosure.readConnectionExecutionClosure(eventlog.openEventLog(), {
      sessionId: f.task.sessionId, executionSourceUserSeq: f.task.sourceUserSeq })?.terminalEventId, result.event.id);
    eventlog.closeEventLog();
    assert.equal(connectionTerminal(f, active, status).inserted, false);
    assert.deepEqual(connectionPause.readConnectionExecutionPause(f.task.sessionId, f.pause.requestId), pauseBefore);
    assert.equal(delivery.commitTurnOutcome(f.outcome, { metadata: { connectionExecutionPause: f.binding } }).inserted, false);
    assert.equal(connectionActivation.activateConnectionExecution(f.input).kind, 'existing');
    assert.throws(() => connectionActivation.assertConnectionExecutionOwned({ sessionId: f.task.sessionId,
      deliverySourceUserSeq: active.source.seq, attemptId: f.attempt.attemptId, leaseOwner: f.input.leaseOwner }));
    assert.equal(eventlog.listEvents(f.task.sessionId, { types: ['conversation_completed'] }).length, 2);
    assert.equal(physicalRows(f.task, 'call:connection-search').length, 1);
    leases.revokeDispatchLease(f.task.parentLease);
  });
}

test('connection terminal closes the retained accepted-task owner rather than a fresh control authority', async () => {
  const f = await connectionActivationFixture();
  const shadow = await import('../graph/turn-graph-shadow.js');
  const taskAuthority = await import('./accepted-task-authority.js');
  assert.ok(shadow.recordTurnGraphShadow({ identity: { ...f.task, turn: 1 } }));
  assert.equal(taskAuthority.armAcceptedTaskAuthority(f.task).status, 'armed');
  const active = connectionActivation.activateConnectionExecution(f.input);
  assert.throws(() => connectionTerminal(f, active, 'done'), /no exact completion proof/);
  assert.equal(connectionClosure.readConnectionExecutionClosure(eventlog.openEventLog(), {
    sessionId: f.task.sessionId, executionSourceUserSeq: f.task.sourceUserSeq }), null);
  const terminal = connectionTerminal(f, active, 'blocked');
  const task = taskAuthority.loadAcceptedTaskAuthority(f.task.sessionId, f.task.sourceUserSeq);
  assert.equal(task.status, 'ok');
  if (task.status === 'ok') {
    assert.equal(task.authority.state, 'conflict');
    assert.equal(task.authority.terminalEventId, terminal.event.id);
  }
  assert.equal(taskAuthority.loadAcceptedTaskAuthority(f.task.sessionId, active.source.seq).status, 'legacy');
  assert.ok(connectionPause.readConnectionExecutionPause(f.task.sessionId, f.pause.requestId));
  leases.revokeDispatchLease(f.task.parentLease);
});

test('terminal cleanup failure rolls back the closure, original authorities, event and physical completion', async () => {
  const f = await connectionActivationFixture();
  const shadow = await import('../graph/turn-graph-shadow.js');
  const taskAuthority = await import('./accepted-task-authority.js');
  assert.ok(shadow.recordTurnGraphShadow({ identity: { ...f.task, turn: 1 } }));
  assert.equal(taskAuthority.armAcceptedTaskAuthority(f.task).status, 'armed');
  const readTask = () => taskAuthority.loadAcceptedTaskAuthority(f.task.sessionId, f.task.sourceUserSeq);
  const active = connectionActivation.activateConnectionExecution(f.input);
  const db = eventlog.openEventLog();
  const beforeTask = readTask();
  const beforeHost = authority.acceptedTurnCallAuthorityFor(f.task.sessionId, f.task.sourceUserSeq);
  db.exec(`CREATE TRIGGER fixture_connection_closure_failure BEFORE UPDATE ON sessions
    WHEN NEW.id = '${f.task.sessionId}' AND json_extract(OLD.metadata_json, '$.__continuation_owner') IS NOT NULL
      AND json_extract(NEW.metadata_json, '$.__continuation_owner') IS NULL
    BEGIN SELECT RAISE(ABORT, 'controlled terminal cleanup failure'); END`);
  try {
    assert.throws(() => connectionTerminal(f, active, 'blocked'), /controlled terminal cleanup failure/);
    assert.deepEqual(readTask(), beforeTask);
    assert.deepEqual(authority.acceptedTurnCallAuthorityFor(f.task.sessionId, f.task.sourceUserSeq), beforeHost);
    assert.equal(connectionClosure.readConnectionExecutionClosure(db, { sessionId: f.task.sessionId,
      executionSourceUserSeq: f.task.sourceUserSeq }), null);
    assert.equal(eventlog.listEvents(f.task.sessionId, { types: ['conversation_completed'] }).length, 1);
    connectionActivation.assertConnectionExecutionOwned({ sessionId: f.task.sessionId, deliverySourceUserSeq: active.source.seq,
      attemptId: f.attempt.attemptId, leaseOwner: f.input.leaseOwner });
  } finally { db.exec('DROP TRIGGER fixture_connection_closure_failure'); }
  assert.equal(connectionTerminal(f, active, 'blocked').inserted, true);
  leases.revokeDispatchLease(f.task.parentLease);
});

test('a closed root with a corrupted terminal cannot validate its earlier connection pause', async () => {
  const f = await connectionActivationFixture();
  const active = connectionActivation.activateConnectionExecution(f.input);
  const terminal = connectionTerminal(f, active);
  const db = eventlog.openEventLog();
  assert.throws(() => db.prepare("UPDATE source_connection_execution_closures_v1 SET terminal_digest = 'wrong' WHERE session_id = ?")
    .run(f.task.sessionId), /immutable/);
  db.prepare("UPDATE events SET data_json = json_set(data_json, '$.runId', 'another-run') WHERE id = ?").run(terminal.event.id);
  eventlog.closeEventLog();
  assert.throws(() => connectionPause.readConnectionExecutionPause(f.task.sessionId, f.pause.requestId), /terminal closure/);
  assert.throws(() => connectionTerminal(f, active), /terminal closure/);
  leases.revokeDispatchLease(f.task.parentLease);
});

test('connection closure schema is immutable during session life but permits the owning session cascade', async () => {
  const f = await connectionActivationFixture();
  const active = connectionActivation.activateConnectionExecution(f.input);
  connectionTerminal(f, active);
  // Exercise the actual installed DDL independently of older plan/context
  // retention constraints. This is a storage lifetime check, not execution proof.
  const ddl = eventlog.openEventLog().prepare(`SELECT sql FROM sqlite_master
    WHERE tbl_name = 'source_connection_execution_closures_v1' AND sql IS NOT NULL
    ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END`).all() as Array<{ sql: string }>;
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE events (id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE);`);
    for (const item of ddl) db.exec(item.sql);
    for (const id of ['expired', 'retained']) {
      db.prepare('INSERT INTO sessions VALUES (?)').run(id);
      for (const suffix of ['activation', 'terminal']) db.prepare('INSERT INTO events VALUES (?, ?)').run(`${id}-${suffix}`, id);
      db.prepare('INSERT INTO source_connection_execution_closures_v1 VALUES (?, 1, 2, ?, ?, ?)')
        .run(id, `${id}-activation`, `${id}-terminal`, 'controlled-storage-digest');
    }
    assert.throws(() => db.exec("DELETE FROM source_connection_execution_closures_v1 WHERE session_id = 'expired'"), /immutable/);
    assert.throws(() => db.exec("DELETE FROM events WHERE id = 'expired-terminal'"), /immutable/);
    db.exec("DELETE FROM sessions WHERE id = 'expired'");
    assert.deepEqual(db.prepare('SELECT session_id FROM source_connection_execution_closures_v1').all(), [{ session_id: 'retained' }]);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 2);
  } finally {
    db.close();
    leases.revokeDispatchLease(f.task.parentLease);
  }
});

for (const decision of ['approve', 'reject'] as const) {
  test(`connection then approval ${decision} retains the original task through final delivery and replay`, async () => {
    const f = await connectionActivationFixture();
    const shadow = await import('../graph/turn-graph-shadow.js');
    const taskAuthority = await import('./accepted-task-authority.js');
    const approvals = await import('./approval-registry.js');
    assert.ok(shadow.recordTurnGraphShadow({ identity: { ...f.task, turn: 1 } }));
    assert.equal(taskAuthority.armAcceptedTaskAuthority(f.task).status, 'armed');
    const active = connectionActivation.activateConnectionExecution(f.input);
    const card = approvals.register({ sessionId: f.task.sessionId, subject: 'Controlled write', tool: 'fixture_write', args: { value: 'test' } });
    const identity = { sessionId: f.task.sessionId, sourceUserSeq: active.source.seq, turn: active.source.turn };
    const pause: import('./turn-outcome.js').TurnOutcome = { version: 2, identity, id: outcomes.turnOutcomeId(identity),
      status: 'needs_input', resumable: true, needs: { kind: 'approval' },
      presentation: { kind: 'approval', approvalId: card.approvalId, text: 'Review the controlled write.' } };
    const beforeTask = taskAuthority.loadAcceptedTaskAuthority(f.task.sessionId, f.task.sourceUserSeq);
    const approvalPause = eventlog.appendTerminalEventOnce({ sessionId: f.task.sessionId, turn: identity.turn, role: 'system',
      data: delivery.completionDataForTurnOutcome(pause) }, pause.id);
    assert.deepEqual(taskAuthority.loadAcceptedTaskAuthority(f.task.sessionId, f.task.sourceUserSeq), beforeTask);
    assert.equal(connectionClosure.readConnectionExecutionClosure(eventlog.openEventLog(), { sessionId: f.task.sessionId,
      executionSourceUserSeq: f.task.sourceUserSeq }), null);
    assert.equal(approvals.resolve(card.approvalId, decision === 'approve' ? 'approved' : 'rejected', 'controlled-owner').ok, true);
    const attempt = eventlog.beginRunAttempt(f.task.sessionId, { runId: `approval-${f.task.sourceUserSeq}` });
    const control = eventlog.recordRunAttemptUserInput(attempt, { turn: 2, role: 'user', data: {
      text: decision, synthetic: true, approvalId: card.approvalId, decision,
    } }, { armRunInFlight: true });
    eventlog.appendEvent({ sessionId: f.task.sessionId, turn: 2, role: 'system', type: 'run_resumed', data: {
      reviewContinuationVersion: 1, approvalId: card.approvalId, decision,
      executionSourceUserSeq: f.task.sourceUserSeq, deliverySourceUserSeq: control.seq,
    } });
    const terminal = connectionTerminal(f, { ...active, source: control }, decision === 'reject' ? 'cancelled' : 'blocked');
    const loaded = taskAuthority.loadAcceptedTaskAuthority(f.task.sessionId, f.task.sourceUserSeq);
    assert.equal(loaded.status, 'ok');
    if (loaded.status === 'ok') assert.equal(loaded.authority.terminalEventId, terminal.event.id);
    eventlog.closeEventLog();
    assert.ok(connectionPause.readConnectionExecutionPause(f.task.sessionId, f.pause.requestId));
    assert.equal(eventlog.readValidatedTerminalEvent(approvalPause.event.id, f.task.sessionId, active.source.seq).id, approvalPause.event.id);
    assert.equal(eventlog.readValidatedTerminalEvent(terminal.event.id, f.task.sessionId, control.seq).id, terminal.event.id);
    assert.equal(eventlog.listEvents(f.task.sessionId, { types: ['conversation_completed'] }).length, 3);
    assert.equal(physicalRows(f.task, 'call:connection-search').length, 1);
    leases.revokeDispatchLease(f.task.parentLease);
  });
}

test('connection activation retains the exact task and canonical recovery behind one new control', async () => {
  const f = await connectionActivationFixture();
  const acceptedBefore = eventlog.listEvents(f.task.sessionId, { types: ['user_input_received'] }).length;
  const active = connectionActivation.activateConnectionExecution(f.input);
  assert.equal(active.kind, 'activated');
  connectionActivation.assertConnectionExecutionOwned({ sessionId: f.task.sessionId, deliverySourceUserSeq: active.source.seq,
    attemptId: f.attempt.attemptId, leaseOwner: f.input.leaseOwner });
  assert.notEqual(active.source.seq, f.task.sourceUserSeq);
  assert.equal(active.source.data.taskMode, undefined, 'setup continuation is not a new Execute request');
  assert.equal(active.activation.executionSourceUserSeq, f.task.sourceUserSeq);
  assert.equal(eventlog.listEvents(f.task.sessionId, { types: ['user_input_received'] }).length, acceptedBefore + 1);
  assert.equal(eventlog.listEvents(f.task.sessionId, { types: ['plan_execution_claimed'] }).length, 1);
  const session = sessionStore.HarnessSession.load(f.task.sessionId)!;
  assert.equal(session.recoveryOwnedByActivation({ sourceUserSeq: active.source.seq, attemptId: f.attempt.attemptId }), true);
  assert.equal(session.recoveryOwnedByActivation({ sourceUserSeq: f.task.sourceUserSeq, attemptId: f.attempt.attemptId }), false);
  const state = JSON.parse(session.loadRecoveryState()!);
  assert.equal(state.sourceUserSeq, f.task.sourceUserSeq);
  assert.equal(state.connectionProgress.activation.toolCalls.used, 2);
  assert.deepEqual(state.history, f.batch.history);
  assert.deepEqual(recoveryActivation.readConnectionRecoveryActivation(f.task.sessionId), active.owner);
  assert.deepEqual(recoveryActivation.completionEvidenceSource({ sessionId: f.task.sessionId, sourceUserSeq: active.source.seq }),
    { sessionId: f.task.sessionId, sourceUserSeq: f.task.sourceUserSeq });
  sessionContext.withAcceptedSourceSessionContext({ sessionId: f.task.sessionId, sourceUserSeq: active.source.seq }, execution => {
    assert.equal(execution.sourceUserSeq, f.task.sourceUserSeq);
    assert.equal(sessionContextScope.currentSourceSessionContext(f.task.sessionId)?.sourceUserSeq, f.task.sourceUserSeq);
  }, { newlyAccepted: true });
  assert.equal(sessionContext.readSourceSessionContext({ sessionId: f.task.sessionId, sourceUserSeq: active.source.seq }), null);
  assert.equal(connectionSetup.readConnectionSetup(f.task.sessionId)?.sourceUserSeq, f.task.sourceUserSeq);
  const { projectHarnessEventForPublic } = await import('./public-presentation.js');
  const marker = eventlog.listEvents(f.task.sessionId, { types: ['run_resumed'] })[0]!;
  assert.deepEqual(projectHarnessEventForPublic(marker)?.data, {}, 'recovery proof does not become card text or a brain prompt');
  assert.equal(physicalRows(f.task, 'call:connection-search').length, 1);
  leases.revokeDispatchLease(f.task.parentLease);
});

test('memory save after verified connection continuation uses the original scope through the SDK and host settlement', async () => {
  const agents = await import('../../agents/agent-record.js');
  const projects = await import('../../projects/project-record.js');
  const { setSessionAgent } = await import('../../agents/session-agent.js');
  const { setSessionProject } = await import('../../projects/session-project.js');
  const scopeBinding = await import('./memory-scope-binding.js');
  const memory = await import('../../memory/memory-scope.js');
  const facts = await import('../../memory/facts.js');
  const memoryDb = await import('../../memory/db.js');
  const { getLocalRuntimeTools } = await import('../../tools/local-runtime-tools.js');
  const { RunContext } = await import('@openai/agents');
  const remember = getLocalRuntimeTools().find(tool => tool.name === 'memory_remember');
  assert.ok(remember && remember.type === 'function');
  const a = projects.createProject({ name: 'Retained memory checkpoint A' });
  const b = projects.createProject({ name: 'Retained memory checkpoint B' });
  const agent = agents.createAgentRecord({ name: 'Retained memory checkpoint agent', instructions: 'Controlled fixture.', createdFrom: 'console' });
  assert.ok(a.ok && b.ok && agent.ok);
  if (!a.ok || !b.ok || !agent.ok) throw new Error('memory continuation fixture');
  const f = await connectionActivationFixture(task => {
    assert.ok(setSessionProject(task.sessionId, a.project.id, { by: 'owner' }).ok);
    assert.ok(setSessionAgent(task.sessionId, agent.agent.id, { by: 'owner' }).ok);
  });
  const original = sessionContext.readSourceSessionContext(f.task)!;
  assert.ok(original);
  const content = 'The retained checkpoint recurring report marker is SAPPHIRE CEDAR.';
  const prior = facts.rememberFact({ kind: 'user', content, sessionId: f.task.sessionId, scope: original.memoryScope });
  assert.ok(setSessionProject(f.task.sessionId, b.project.id, { by: 'owner' }).ok);
  assert.ok(setSessionAgent(f.task.sessionId, null, { by: 'owner' }).ok);
  scopeBinding._forgetPinnedMemoryScopesForTests(); scopeBinding.forgetSessionMemoryScope();
  memoryDb.closeMemoryDb(); eventlog.closeEventLog();
  const active = connectionActivation.activateConnectionExecution(f.input);
  const input = { kind: 'user', content, keepFor: 'here', sessionId: null, sourcePath: null, entities: null, relationships: null };
  const fetchBefore = globalThis.fetch;
  let networkCalls = 0;
  let invokes = 0;
  globalThis.fetch = (async () => { networkCalls += 1; throw new Error('memory continuation fixture forbids network'); }) as typeof fetch;
  try {
    const save = () => sessionContext.withAcceptedSourceSessionContext({ sessionId: f.task.sessionId, sourceUserSeq: active.source.seq }, execution => {
      assert.equal(execution.sourceUserSeq, f.task.sourceUserSeq);
      assert.deepEqual(memory.scopeOfSession(f.task.sessionId), original.memoryScope);
      return runCall({ task: f.task, callId: 'retained-memory-here', toolName: 'memory_remember', args: input,
        effect: 'host_only', localEnvelope: true, boundary: 'host_owned_local', businessCall: false, deadlineMs: 5_000,
        invoke: async () => { invokes += 1; return remember.invoke(new RunContext(execution), JSON.stringify(input)); } });
    });
    const first = await save();
    assert.equal(first.settlement.outcome.kind, 'succeeded');
    assert.equal(first.settlement.creditedProgress, false, 'a control save is not positive business or memory-fulfillment proof');
    const rows = memoryDb.openMemoryDb().prepare('SELECT id, active FROM consolidated_facts WHERE content = ?').all(content);
    assert.deepEqual(rows, [{ id: prior.id, active: 1 }]);
    assert.deepEqual(memory.memoryScopeOf('fact', prior.id), original.memoryScope);
    eventlog.closeEventLog();
    const replay = await save();
    assert.equal(replay.settlement.duplicate, true);
    assert.equal(invokes, 1, 'retained exact call is not saved again after reopen');
    assert.equal(networkCalls, 0);
    assert.equal(sessionContext.readSourceSessionContext({ sessionId: f.task.sessionId, sourceUserSeq: active.source.seq }), null,
      'the setup control cannot become a new memory owner');
    assert.equal(memory.scopeOfSession(f.task.sessionId)?.projectId, b.project.id, 'the changed UI selection is preserved');
  } finally { globalThis.fetch = fetchBefore; leases.revokeDispatchLease(f.task.parentLease); }
});

test('memory SDK scope and syntax refusals retain negative host settlement with no memory effects', async () => {
  const { getLocalRuntimeTools } = await import('../../tools/local-runtime-tools.js');
  const { RunContext } = await import('@openai/agents');
  const { HostLocalNonWriteResult, InvalidArgumentsPreDispatchResult } = await import('./attempt-settlement.js');
  const memoryDb = await import('../../memory/db.js');
  await import('./memory-scope-binding.js');
  const remember = getLocalRuntimeTools().find(tool => tool.name === 'memory_remember');
  assert.ok(remember && remember.type === 'function');
  const task = fixture('Remember the recurring report convention only here.');
  const content = 'The scope-refusal recurring report marker is SILVER WALNUT.';
  const input = { kind: 'user', content, keepFor: 'here', sessionId: 'foreign-memory-scope', sourcePath: null, entities: null, relationships: null };
  const snapshot = () => {
    const db = memoryDb.openMemoryDb();
    return ['consolidated_facts', 'memory_episodes', 'fact_evidence', 'fact_validity_intervals', 'memory_scopes',
      'entities', 'entity_observations', 'entity_aliases', 'entity_identifiers', 'fact_entities', 'entity_edges',
      'entity_edge_evidence', 'entity_edge_validity_intervals', 'memory_policies'].map(name => [name,
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
        ? db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() : null]);
  };
  const before = snapshot();
  const fetchBefore = globalThis.fetch;
  let networkCalls = 0;
  let invokes = 0;
  globalThis.fetch = (async () => { networkCalls += 1; throw new Error('memory refusal fixture forbids network'); }) as typeof fetch;
  try {
    for (const syntaxError of [false, true]) {
      const raw = syntaxError ? JSON.stringify(input).slice(0, -1) + ',"relationships":[{"subject":"broken' : JSON.stringify(input);
      const callId = `memory-refusal-${syntaxError ? 'syntax' : 'foreign-scope'}`;
      const invoke = () => runCall({ task, callId, toolName: 'memory_remember', args: syntaxError ? { raw } : input,
        effect: 'host_only', localEnvelope: true, boundary: 'host_owned_local', businessCall: false, deadlineMs: 5_000,
        invoke: async () => {
          invokes += 1;
          const value = await remember.invoke(new RunContext({ sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq }), raw);
          assert.ok(syntaxError ? value instanceof InvalidArgumentsPreDispatchResult : value instanceof HostLocalNonWriteResult);
          if (value instanceof HostLocalNonWriteResult) assert.equal(value.status, 'memory_session_mismatch');
          return value;
        } });
      const refused = await invoke();
      assert.equal(refused.settlement.outcome.kind, 'invalid_arguments');
      assert.equal(refused.settlement.outcome.directive.action, 'repair_arguments');
      assert.equal(refused.settlement.creditedProgress, false);
      assert.equal(refused.settlement.resultHandleId, undefined, 'a refusal does not create redeemable successful memory evidence');
      // The host reserves before entering the SDK. A returned refusal therefore
      // has a terminal HOST row, not provider traffic or proof of a mutation.
      const ledger = () => {
        const db = eventlog.openEventLog();
        const key = [task.sessionId, task.sourceUserSeq, callId];
        return {
          physical: db.prepare(`SELECT state, execution_site, tool_name FROM physical_dispatches
            WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ? ORDER BY ordinal`).all(...key),
          frozen: db.prepare(`SELECT terminal_state, execution_site, tool_name FROM logical_call_settlement_crossings
            WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ? ORDER BY ordinal`).all(...key),
          settlement: db.prepare(`SELECT execution_kind, outcome_kind, business_call, credited_progress,
            physical_crossing_count, host_crossing_count, result_handle_id FROM logical_call_settlements
            WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`).get(...key),
        };
      };
      const settledLedger = ledger();
      assert.deepEqual(settledLedger, {
        physical: [{ state: 'returned', execution_site: 'host', tool_name: 'memory_remember' }],
        frozen: [{ terminal_state: 'returned', execution_site: 'host', tool_name: 'memory_remember' }],
        settlement: { execution_kind: syntaxError ? 'refused_pre_dispatch' : 'local_execution',
          outcome_kind: 'invalid_arguments', business_call: 0, credited_progress: 0,
          physical_crossing_count: 0, host_crossing_count: 1, result_handle_id: null },
      });
      assert.deepEqual(snapshot(), before, 'facts, episodes, scopes, policies and graph must remain unchanged');
      const callsBeforeReplay = invokes;
      // Failed logical calls are not successful replayable results. Their
      // original identity fails closed; an authorized repair is a new call.
      await assert.rejects(invoke, /settled logical outcome invalid_arguments is not replayable/);
      assert.equal(invokes, callsBeforeReplay, 'exact refusal replay must not execute a lossy save');
      assert.deepEqual(ledger(), settledLedger, 'replay retains the same negative settlement and host reservation');
      assert.deepEqual(snapshot(), before);
    }
    assert.equal(networkCalls, 0);
  } finally { globalThis.fetch = fetchBefore; leases.revokeDispatchLease(task.parentLease); }
});

test('repeated device continuation and reopen do not install an old checkpoint after adoption', async () => {
  const f = await connectionActivationFixture();
  const active = connectionActivation.activateConnectionExecution(f.input);
  const session = sessionStore.HarnessSession.load(f.task.sessionId)!;
  assert.equal(session.adoptRecoveredConversation({ serializedState: session.loadRecoveryState()!, history: f.batch.history,
    lastResponseId: f.batch.lastResponseId }), true);
  assert.equal(session.loadRecoveryState(), null);
  eventlog.closeEventLog();
  const replay = connectionActivation.activateConnectionExecution({ ...f.input, leaseOwner: 'controlled-phone' });
  assert.equal(replay.kind, 'existing');
  assert.equal(replay.source.seq, active.source.seq);
  assert.equal(sessionStore.HarnessSession.load(f.task.sessionId)!.loadRecoveryState(), null);
  assert.deepEqual(recoveryActivation.readConnectionRecoveryActivation(f.task.sessionId), active.owner);
  sessionContext.withAcceptedSourceSessionContext({ sessionId: f.task.sessionId, sourceUserSeq: active.source.seq }, execution => {
    assert.equal(execution.sourceUserSeq, f.task.sourceUserSeq, 'adoption must not lose the original composition');
  });
  assert.equal(eventlog.listEvents(f.task.sessionId, { types: ['run_resumed'] }).length, 1);
  connectionActivation.assertConnectionExecutionOwned({ sessionId: f.task.sessionId, deliverySourceUserSeq: active.source.seq,
    attemptId: f.attempt.attemptId, leaseOwner: f.input.leaseOwner });
  leases.revokeDispatchLease(f.task.parentLease);
});

for (const defect of ['account-changed', 'request-stopped', 'newer-source', 'expired-lease', 'malformed-lease', 'foreign-lease', 'different-action', 'existing-recovery'] as const) {
  test(`connection activation refuses ${defect} before accepting another control`, async () => {
    const f = await connectionActivationFixture();
    if (defect === 'account-changed') connectionSetup.recordConnectionSetupResult(f.input.context, { connectionId: 'ca_different_account' });
    if (defect === 'request-stopped') eventlog.requestHarnessChatCancellation(f.input.clientRequestId);
    if (defect === 'newer-source') eventlog.appendEvent({ sessionId: f.task.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'A new task.' } });
    if (defect === 'expired-lease') eventlog.openEventLog().prepare('UPDATE run_attempts SET lease_expires_at = ? WHERE attempt_id = ?').run(new Date(0).toISOString(), f.attempt.attemptId);
    if (defect === 'malformed-lease') eventlog.openEventLog().prepare("UPDATE run_attempts SET lease_expires_at = 'invalid-date' WHERE attempt_id = ?").run(f.attempt.attemptId);
    if (defect === 'foreign-lease') f.input.leaseOwner = 'other-owner';
    if (defect === 'different-action') f.input.text = 'Do something different.';
    if (defect === 'existing-recovery') assert.equal(sessionStore.HarnessSession.load(f.task.sessionId)!.saveRecoveryState('retained-other-checkpoint').installed, true);
    const before = eventlog.listEvents(f.task.sessionId).length;
    assert.throws(() => connectionActivation.activateConnectionExecution(f.input));
    assert.equal(eventlog.listEvents(f.task.sessionId).length, before);
    assert.equal(eventlog.getLatestRunAttemptByRunId(f.task.sessionId, f.input.runId)?.sourceUserSeq, null);
    leases.revokeDispatchLease(f.task.parentLease);
  });
}

for (const adopted of [false, true]) {
  for (const defect of ['account-changed', 'request-stopped', 'original-stopped', 'delivery-stopped', 'newer-source',
    'expired-lease', 'malformed-lease', 'foreign-lease', 'lost-continuation-owner', 'lost-recovery-owner'] as const) {
    test(`connection preparation rechecks ${defect} after activation (adopted=${adopted})`, async () => {
      const f = await connectionActivationFixture();
      const active = connectionActivation.activateConnectionExecution(f.input);
      const session = sessionStore.HarnessSession.load(f.task.sessionId)!;
      if (adopted) assert.equal(session.adoptRecoveredConversation({ serializedState: session.loadRecoveryState()!,
        history: f.batch.history, lastResponseId: f.batch.lastResponseId }), true);
      const owner = { sessionId: f.task.sessionId, deliverySourceUserSeq: active.source.seq,
        attemptId: f.attempt.attemptId, leaseOwner: f.input.leaseOwner };
      connectionActivation.assertConnectionExecutionOwned(owner);
      if (defect === 'account-changed') connectionSetup.recordConnectionSetupResult(f.input.context, { connectionId: 'ca_replaced_during_prepare' });
      if (defect === 'request-stopped') eventlog.requestHarnessChatCancellation(f.input.clientRequestId);
      if (defect === 'original-stopped') eventlog.requestKill(f.task.sessionId, 'Owner stopped original task', f.originalAttempt);
      if (defect === 'delivery-stopped') eventlog.requestKill(f.task.sessionId, 'Owner stopped continuation', f.attempt);
      if (defect === 'newer-source') eventlog.appendEvent({ sessionId: f.task.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'A newer request.' } });
      if (defect === 'expired-lease' || defect === 'malformed-lease') eventlog.openEventLog().prepare('UPDATE run_attempts SET lease_expires_at = ? WHERE attempt_id = ?')
        .run(defect === 'expired-lease' ? new Date(0).toISOString() : 'invalid-date', f.attempt.attemptId);
      if (defect === 'foreign-lease') owner.leaseOwner = 'another-process';
      if (defect === 'lost-continuation-owner') assert.equal(session.releaseContinuationOwner({ sourceUserSeq: active.source.seq, attemptId: f.attempt.attemptId }), true);
      if (defect === 'lost-recovery-owner') eventlog.openEventLog().prepare("UPDATE sessions SET metadata_json = json_remove(metadata_json, '$.__host_recovery_owner') WHERE id = ?").run(f.task.sessionId);
      assert.throws(() => connectionActivation.assertConnectionExecutionOwned(owner));
      // A retry is allowed to retrieve its historical receipt, never to reset
      // the conversation, erase Stop, or authorize more model/tool work.
      assert.equal(connectionActivation.activateConnectionExecution(f.input).kind, 'existing');
      assert.throws(() => connectionActivation.assertConnectionExecutionOwned(owner));
      assert.equal(eventlog.listEvents(f.task.sessionId, { types: ['run_resumed'] }).length, 1);
      assert.equal(physicalRows(f.task, 'call:connection-search').length, 1);
      leases.revokeDispatchLease(f.task.parentLease);
    });
  }
}

test('satisfying the dependency does not retire the current connection execution owner', async () => {
  const f = await connectionActivationFixture();
  const active = connectionActivation.activateConnectionExecution(f.input);
  // Status alone is neither account verification nor callable authority. This
  // exercises the owner guard after the separate attestation writer succeeds.
  eventlog.openEventLog().prepare("UPDATE dependency_requests SET status = 'satisfied' WHERE request_id = ?").run(f.pause.requestId);
  assert.equal(connectionSetup.readConnectionSetup(f.task.sessionId), null);
  connectionActivation.assertConnectionExecutionOwned({ sessionId: f.task.sessionId, deliverySourceUserSeq: active.source.seq,
    attemptId: f.attempt.attemptId, leaseOwner: f.input.leaseOwner });
  leases.revokeDispatchLease(f.task.parentLease);
});

test('Stop during asynchronous connection rebuild prevents subsequent preparation and tool construction', async () => {
  const f = await connectionActivationFixture();
  const active = connectionActivation.activateConnectionExecution(f.input);
  let laterWork = 0;
  await assert.rejects(rebuildSourceConnectionAgent({ sessionId: f.task.sessionId, requestId: f.pause.requestId,
    assertOwned: () => connectionActivation.assertConnectionExecutionOwned({ sessionId: f.task.sessionId,
      deliverySourceUserSeq: active.source.seq, attemptId: f.attempt.attemptId, leaseOwner: f.input.leaseOwner }) }, {
    prime: async () => {
      await Promise.resolve();
      eventlog.requestKill(f.task.sessionId, 'Owner stopped during preparation', f.originalAttempt);
      return { ok: true, planning: {} } as never;
    },
    revalidate: async () => { laterWork++; },
    build: async () => { laterWork++; return f.agent as never; },
  }), /stopped/);
  assert.equal(laterWork, 0);
  assert.equal(physicalRows(f.task, 'call:connection-search').length, 1);
  leases.revokeDispatchLease(f.task.parentLease);
});

test('failed recovery installation rolls back its control, marker and live publications together', async () => {
  const f = await connectionActivationFixture();
  const db = eventlog.openEventLog();
  const { actionBus } = await import('../action-bus.js');
  const published: unknown[] = [];
  const unsubscribe = actionBus.subscribe(event => { if (event.kind === 'harness.event' && event.sessionId === f.task.sessionId) published.push(event); });
  const before = eventlog.listEvents(f.task.sessionId).length;
  db.exec(`CREATE TRIGGER fixture_connection_recovery_write_failure BEFORE UPDATE ON sessions
    WHEN NEW.id = '${f.task.sessionId}' AND json_extract(NEW.metadata_json, '$.__host_recovery_state') IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'controlled recovery install failure'); END`);
  try {
    assert.throws(() => connectionActivation.activateConnectionExecution(f.input), /could not retain/);
    assert.equal(eventlog.listEvents(f.task.sessionId).length, before);
    assert.equal(published.length, 0, 'rolled-back controls must not reach desktop/mobile subscribers');
    assert.equal(eventlog.getLatestRunAttemptByRunId(f.task.sessionId, f.input.runId)?.sourceUserSeq, null);
    assert.equal(sessionStore.HarnessSession.load(f.task.sessionId)!.loadRecoveryState(), null);
  } finally { db.exec('DROP TRIGGER fixture_connection_recovery_write_failure'); unsubscribe(); }
  assert.equal(connectionActivation.activateConnectionExecution(f.input).kind, 'activated', 'retry consumes one source after the failed transaction');
  leases.revokeDispatchLease(f.task.parentLease);
});

for (const defect of ['wrong-marker', 'wrong-root', 'foreign-attempt', 'both-kinds', 'wrong-blob-source'] as const) {
  test(`connection recovery refuses ${defect} instead of using current task context`, async () => {
    const f = await connectionActivationFixture();
    connectionActivation.activateConnectionExecution(f.input);
    const metadata = structuredClone(eventlog.getSession(f.task.sessionId)!.metadata);
    const owner = metadata.__host_recovery_owner as import('./recovery-activation.js').RecoveryActivationOwner;
    if (defect === 'wrong-marker') owner.connectionContinuation!.activationEventId = 'missing-marker';
    if (defect === 'wrong-root') owner.connectionContinuation!.requestSourceUserSeq = owner.sourceUserSeq;
    if (defect === 'foreign-attempt') owner.attemptId = 'unrelated-attempt';
    if (defect === 'both-kinds') owner.approvalContinuation = { requestSourceUserSeq: f.task.sourceUserSeq, approvalId: 'unrelated-approval', decision: 'approve' };
    if (defect === 'wrong-blob-source') metadata.__host_recovery_state = JSON.stringify({ ...JSON.parse(String(metadata.__host_recovery_state)), sourceUserSeq: owner.sourceUserSeq });
    eventlog.openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), f.task.sessionId);
    assert.throws(() => recoveryActivation.readRecoveryActivation(f.task.sessionId), /does not match/);
    leases.revokeDispatchLease(f.task.parentLease);
  });
}

test('a proven connection question retains its original open execution across publication, replay and reopen', async () => {
  const { task, pause, binding, outcome } = await connectionPauseFixture();
  const before = authority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  const committed = delivery.commitTurnOutcome(outcome, { metadata: { connectionExecutionPause: binding } });
  assert.equal(committed.presentation.status, 'needs_input');
  assert.deepEqual(authority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq), before);
  const terminal = eventlog.listEvents(task.sessionId, { types: ['conversation_completed'] })[0]!;
  assert.deepEqual(terminal.data.connectionExecutionPause, binding);
  const { projectHarnessEventForPublic } = await import('./public-presentation.js');
  assert.equal(JSON.stringify(projectHarnessEventForPublic(terminal)).includes(binding.checkpointDigest), false,
    'private execution proof is not a public card or prompt');
  const expected = { eventId: terminal.id, sourceUserSeq: task.sourceUserSeq, binding };
  assert.deepEqual(connectionPause.readConnectionExecutionPause(task.sessionId, pause.requestId), expected);
  eventlog.closeEventLog();
  // Historical delivery replay cannot depend on today's open dependency or
  // most recent chat. Neither change grants permission to execute again.
  eventlog.openEventLog().prepare("UPDATE dependency_requests SET status = 'cancelled' WHERE request_id = ?").run(pause.requestId);
  eventlog.appendEvent({ sessionId: task.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'A different task.' } });
  assert.deepEqual(connectionPause.readConnectionExecutionPause(task.sessionId, pause.requestId), expected);
  delivery.commitTurnOutcome(outcome, { metadata: { connectionExecutionPause: binding } });
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['conversation_completed'] }).length, 1);
  assert.equal(physicalRows(task, 'call:connection-search').length, 1);
  leases.revokeDispatchLease(task.parentLease);
});

test('connection publication retains the accepted-task owner as well as the host root', async () => {
  const { task, binding, outcome } = await connectionPauseFixture();
  const shadow = await import('../graph/turn-graph-shadow.js');
  const taskAuthority = await import('./accepted-task-authority.js');
  assert.ok(shadow.recordTurnGraphShadow({ identity: { ...task, turn: 1 } }));
  assert.equal(taskAuthority.armAcceptedTaskAuthority(task).status, 'armed');
  const read = () => eventlog.openEventLog().prepare('SELECT * FROM accepted_task_authority WHERE session_id = ? AND source_user_seq = ?')
    .get(task.sessionId, task.sourceUserSeq);
  const before = read();
  delivery.commitTurnOutcome(outcome, { metadata: { connectionExecutionPause: binding } });
  assert.deepEqual(read(), before, 'a connection question cannot poison the accepted task');
  eventlog.closeEventLog();
  delivery.commitTurnOutcome(outcome, { metadata: { connectionExecutionPause: binding } });
  assert.deepEqual(read(), before);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['conversation_completed'] }).length, 1);
  leases.revokeDispatchLease(task.parentLease);
});

for (const defect of ['digest', 'source', 'request', 'status', 'closed-root', 'cancelled-dependency', 'changed-subject', 'changed-claim', 'open-batch'] as const) {
  test(`connection publication rejects ${defect} atomically`, async () => {
    const { task, batch, pause, binding, outcome } = await connectionPauseFixture();
    const metadata = { ...binding };
    if (defect === 'digest') metadata.checkpointDigest = '0'.repeat(64);
    if (defect === 'source') metadata.executionSourceUserSeq += 1;
    if (defect === 'request') metadata.requestId = 'different-dependency';
    if (defect === 'status') Object.assign(outcome, { status: 'done', resumable: false, needs: undefined,
      presentation: { kind: 'answer', text: 'Incorrect completion' } });
    if (defect === 'closed-root') eventlog.openEventLog().prepare("UPDATE accepted_turn_call_authorities SET state = 'closed', revision = revision + 1, closed_at = ?, close_reason = 'host_needs_input' WHERE session_id = ?")
      .run(new Date().toISOString(), task.sessionId);
    if (defect === 'cancelled-dependency') eventlog.openEventLog().prepare("UPDATE dependency_requests SET status = 'cancelled' WHERE request_id = ?").run(pause.requestId);
    if (defect === 'changed-subject') eventlog.openEventLog().prepare('UPDATE dependency_requests SET subject_capability = ? WHERE request_id = ?').run('FIXTURECRM_DIFFERENT', pause.requestId);
    if (defect === 'changed-claim') eventlog.openEventLog().prepare("UPDATE events SET data_json = json_set(data_json, '$.claim.executionRunId', 'wrong-run') WHERE session_id = ? AND type = 'plan_execution_claimed'").run(task.sessionId);
    if (defect === 'open-batch') {
      const next = checkpoints.admitAcceptedModelBatch({ ...task, preHistory: batch.history, previousResponseId: batch.lastResponseId,
        frameHistory: openFrame({ callId: 'call:unfinished-after-pause', toolName: 'tool_search', args: {} }), providerResponseId: 'response:unfinished' });
      assert.equal(next.status, 'admitted');
    }
    const before = authority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
    assert.throws(() => delivery.commitTurnOutcome(outcome, { metadata: { connectionExecutionPause: metadata } }), /connection pause|checkpoint|authority/i);
    assert.equal(eventlog.listEvents(task.sessionId, { types: ['conversation_completed'] }).length, 0);
    assert.deepEqual(authority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq), before);
    leases.revokeDispatchLease(task.parentLease);
  });
}

test('an ordinary question cannot retain authority merely because an old connection checkpoint exists', async () => {
  const { task, outcome } = await connectionPauseFixture();
  delivery.commitTurnOutcome(outcome);
  const root = authority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(root.status, 'ok');
  if (root.status === 'ok') assert.equal(root.authority.state, 'closed');
  leases.revokeDispatchLease(task.parentLease);
});

test('an incomplete connection checkpoint cannot borrow current context to retain execution', async () => {
  const task = fixture('Inspect the controlled CRM.', 'execute');
  await settledConnectionBatch(task);
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent: connectionAgent(task) })!;
  assert.equal(connectionPause.prepareConnectionExecutionPause({ ...task, requestId: pause.requestId }), undefined);
  leases.revokeDispatchLease(task.parentLease);
});

for (const corruption of ['outcome', 'source', 'root-surface', 'dependency', 'claim'] as const) {
  test(`the connection proof reader rejects a corrupted ${corruption} just like terminal replay`, async () => {
    const { task, pause, binding, outcome } = await connectionPauseFixture();
    delivery.commitTurnOutcome(outcome, { metadata: { connectionExecutionPause: binding } });
    const event = eventlog.listEvents(task.sessionId, { types: ['conversation_completed'] })[0]!;
    const db = eventlog.openEventLog();
    let restoreRoot = () => {};
    if (corruption === 'root-surface') {
      // The normal writer rejects identity changes. Simulate damaged storage
      // in this disposable database to also pin defense on the proof read.
      const original = db.prepare('SELECT surface_digest FROM accepted_turn_call_authorities WHERE session_id = ?').get(task.sessionId) as { surface_digest: string };
      assert.throws(() => db.prepare('UPDATE accepted_turn_call_authorities SET surface_digest = ? WHERE session_id = ?').run('0'.repeat(64), task.sessionId), /immutable/);
      const trigger = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'accepted_turn_call_authorities' AND sql LIKE '%accepted-turn call authority identity is immutable%'").get() as { name: string; sql: string };
      assert.ok(trigger);
      db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
      db.prepare("UPDATE accepted_turn_call_authorities SET surface_digest = ? WHERE session_id = ?").run('0'.repeat(64), task.sessionId);
      restoreRoot = () => {
        db.prepare('UPDATE accepted_turn_call_authorities SET surface_digest = ? WHERE session_id = ?').run(original.surface_digest, task.sessionId);
        db.exec(trigger.sql);
      };
    } else if (corruption === 'dependency') {
      db.prepare('UPDATE dependency_requests SET subject_capability = ? WHERE request_id = ?').run('FIXTURECRM_DIFFERENT', pause.requestId);
    } else if (corruption === 'claim') {
      db.prepare("UPDATE events SET data_json = json_set(data_json, '$.claim.executionRunId', 'wrong-run') WHERE session_id = ? AND type = 'plan_execution_claimed'").run(task.sessionId);
    } else {
      const data = structuredClone(event.data);
      if (corruption === 'outcome') (data.turnOutcome as Record<string, unknown>).status = 'done';
      else data.sourceUserSeq = task.sourceUserSeq + 1;
      db.prepare('UPDATE events SET data_json = ? WHERE id = ?').run(JSON.stringify(data), event.id);
    }
    try {
      assert.throws(() => connectionPause.readConnectionExecutionPause(task.sessionId, pause.requestId), /projection|contradicts|authority|another execution/i);
      assert.throws(() => delivery.commitTurnOutcome(outcome, { metadata: { connectionExecutionPause: binding } }), /projection|contradicts|authority|another execution/i);
    } finally { restoreRoot(); }
    leases.revokeDispatchLease(task.parentLease);
  });
}

test('the normal terminal reducer keeps reviewed execution open while ending its physical attempt', async () => {
  const { task, agent, pause } = await connectionPauseFixture();
  const attempt = eventlog.beginRunAttempt(task.sessionId, { attemptId: `connection-pause-attempt-${task.sourceUserSeq}`, runId: `connection-pause-run-${task.sourceUserSeq}` });
  eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: task.text } },
    { existingEventSeq: task.sourceUserSeq, armRunInFlight: true });
  const { _testOnly_reduceStandardConversationTerminal } = await import('./loop.js');
  const result = _testOnly_reduceStandardConversationTerminal({ sourceUserSeq: task.sourceUserSeq, agent,
    result: { sessionId: task.sessionId, status: 'awaiting_user_input', steps: 2, lastTurn: 1,
      lastDecision: { summary: pause.text, reply: pause.text, done: false, nextAction: 'awaiting_user_input', reason: null } } });
  assert.equal(result.publicPresentation?.status, 'needs_input');
  assert.ok(connectionPause.readConnectionExecutionPause(task.sessionId, pause.requestId));
  assert.equal(eventlog.getLatestRunAttempt(task.sessionId)?.status, 'interrupted');
  assert.ok(eventlog.getLatestRunAttempt(task.sessionId)?.finishedAt);
  assert.equal(Object.hasOwn(eventlog.getSession(task.sessionId)?.metadata ?? {}, '__run_in_flight_owner'), false);
  const root = authority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(root.status, 'ok');
  if (root.status === 'ok') assert.equal(root.authority.state, 'open');
  leases.revokeDispatchLease(task.parentLease);
});

function connectionAgent(task: Fixture, mcpToolScope: import('../mcp-tool-scope.js').McpToolScope | null = {
  reason: 'original controlled task scope', authority: 'catalog', deniedServerSlugs: ['fixture-private'], maxTools: 2,
}, acceptedRoute?: import('../../agents/agent-rebuild-context.js').AgentRebuildContext['acceptedRoute']) {
  const agent = { model: 'fixture-original-brain', privateProviderState: 'must-not-be-saved', instructions: 'private agent instructions' };
  const sealed = agentEnvelopes.sealAgentCapabilityUniverse({ sessionId: task.sessionId,
    universeTools: [{ name: 'tool_search', description: 'Search controlled capability metadata', parameters: { type: 'object' } }],
    activeToolNames: ['tool_search'], policyHash: 'fixture-policy',
    budget: { maxUncachedTokens: 1000, maxModelCalls: 8, maxToolCalls: 8, maxElapsedMs: 30000 } });
  assert.ok(sealed.ok);
  if (!sealed.ok) throw new Error(sealed.errors.join('; '));
  agentEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  agentEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  agentRebuild.bindAgentRebuildContext(agent, { excludeToolNames: ['run_shell_command'], allowToolJit: true, acceptedRoute });
  mcpAuthority.bindAgentMcpToolScope(agent, mcpToolScope);
  sessionContextScope.withSourceSessionContext(sessionContext.captureFreshSourceSessionContext(task)!, () =>
    sessionContextScope.bindAgentSourceSessionContext(agent, task.sessionId));
  return agent;
}

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
  effect: authority.HostCallAttestation['effect'];
  localEnvelope?: boolean;
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
    bindingKind: input.localEnvelope ? 'local_envelope' as const : 'catalog_manifest' as const,
    capabilityId: `cap:${contract.toolName}`,
    schemaFingerprint: digest(`schema:${contract.toolName}`),
    accountId: input.localEnvelope ? '' : 'conn-checkpoint-fixture',
    invokePortId: 'fixture:execute',
    operationId: contract.toolName.toUpperCase(),
    manifestId: input.localEnvelope ? '' : `manifest:${contract.toolName}`,
    manifestDigest: input.localEnvelope ? '' : digest(`manifest:${contract.toolName}`),
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
  effect: authority.HostCallAttestation['effect'];
  localEnvelope?: boolean;
  businessCall?: boolean;
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
      ...(input.businessCall === undefined ? {} : { businessCall: input.businessCall }),
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

function connectionSearchEvidence(task: Fixture, callId = 'call:connection-search') {
  const value = { query: 'controlled CRM read', role_key: 'source', results: [],
    brokerCoverage: 'authorized_external_v1', unavailable: [{ source: 'authorized_composio', code: 'no_connections',
      reason: 'The fixture account is disconnected.', dependencySubject: {
        version: 1, kind: 'exact_capability_connection', source: 'authorized_composio',
        query: 'controlled CRM read', roleKey: 'source', toolkit: 'fixturecrm',
        capability: 'FIXTURECRM_READ', capabilityRef: 'cap:resolved:fixturecrm_read',
      } }] };
  const output = JSON.stringify(value);
  eventlog.writeToolOutput({ sessionId: task.sessionId, callId, tool: 'tool_search', output });
  eventlog.appendEvent({ sessionId: task.sessionId, turn: 1, role: 'Clem', type: 'tool_returned',
    data: { sourceUserSeq: task.sourceUserSeq, tool: 'tool_search', callId, accounting: 'top_level', topologyRole: 'control', result: output } });
  return value;
}

test('large model histories share immutable bytes across checkpoint and successor admission without losing restart context', async () => {
  const task = fixture('Keep this approved plan and later correction: café 日本語 🐕\n'.repeat(2_000));
  const batch = await settledConnectionBatch(task);
  const checkpoint = eventlog.openEventLog().prepare(`SELECT history_json, history_object_digest
    FROM accepted_model_batch_checkpoints WHERE session_id = ?`).get(task.sessionId) as { history_json: string; history_object_digest: string };
  assert.equal(checkpoint.history_json, '[]', 'inline slot is explicitly replaced, not a fake message');
  assert.ok(checkpoint.history_object_digest);
  eventlog.closeEventLog();
  const recovered = checkpoints.prepareAcceptedModelBatchRestart(task);
  assert.equal(recovered.status, 'ready');
  if (recovered.status !== 'ready') throw new Error('large checkpoint did not reopen');
  assert.deepEqual(recovered.checkpoint.history, batch.history);
  const next = checkpoints.admitAcceptedModelBatch({ ...task, preHistory: recovered.checkpoint.history,
    previousResponseId: batch.lastResponseId, providerResponseId: 'response:shared-history',
    frameHistory: openFrame({ callId: 'call:next-large', toolName: 'records_read', args: {} }) });
  assert.equal(next.status, 'admitted');
  const admission = eventlog.openEventLog().prepare(`SELECT pre_history_object_digest FROM accepted_model_batch_admissions
    WHERE session_id = ? ORDER BY batch_ordinal DESC LIMIT 1`).get(task.sessionId) as { pre_history_object_digest: string };
  assert.equal(admission.pre_history_object_digest, checkpoint.history_object_digest, 'successor references the exact same object');
  assert.deepEqual(eventlog.openEventLog().pragma('foreign_key_check'), []);
  leases.revokeDispatchLease(task.parentLease);
});

async function settledConnectionBatch(task: Fixture) {
  const frame = { callId: 'call:connection-search', toolName: 'tool_search', args: { query: 'controlled CRM read' } };
  const prior = checkpoints.prepareAcceptedModelBatchRestart(task);
  const history = prior.status === 'ready' ? prior.checkpoint.history : preHistory(task);
  const admitted = checkpoints.admitAcceptedModelBatch({ sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
    preHistory: history, frameHistory: openFrame(frame),
    ...(prior.status === 'ready' ? { previousResponseId: prior.checkpoint.lastResponseId } : {}),
    providerResponseId: 'response:connection-search' });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);
  const value = connectionSearchEvidence(task, frame.callId);
  await runCall({ task, ...frame, effect: 'read', boundary: 'host_owned_local', localEnvelope: true, invoke: async () => value });
  const resultItem = exactSettledResult({ task, callId: frame.callId, history: [...history, ...openFrame(frame)] });
  recordLogicalResult(admitted.admission, resultItem);
  const final = checkpoints.finalizeAcceptedModelBatch(admitted.admission, { committedResultItems: [resultItem] });
  assert.ok(final.status === 'committed' || final.status === 'existing');
  return final.checkpoint;
}

for (const shape of ['ask', 'decision'] as const) test(`connection pause after fallback retains the actual executing agent (${shape})`, async () => {
  const task = fixture('Inspect the controlled CRM after connection.', 'execute');
  await settledConnectionBatch(task);
  const original = connectionAgent(task, undefined, 'act');
  const replacement = connectionAgent(task, null, 'retrieve');
  replacement.model = 'fixture-fallback-brain';
  const { runConversation } = await import('./loop.js');
  const { BoundaryError } = await import('../boundary-error.js');
  let runs = 0;
  let rebuilds = 0;
  const result = await runConversation({
    sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, input: task.text,
    reuseRecordedUserInput: true, agent: original as never, judgeCompletion: false,
    suppressMemoryCapture: true, suppressAutomaticMemoryForRequest: true, maxSteps: 2,
    makeRunner: () => new EventEmitter() as never,
    runRunner: async (_runner, active, items) => {
      runs += 1;
      if (active === original) throw BoundaryError.from(new Error('Controlled transient model failure.'), {
        kind: 'model.overloaded', retryable: true, userMessage: 'Controlled transient failure.',
      });
      assert.equal(active, replacement);
      return { history: items, lastResponseId: undefined, finalOutput: shape === 'ask'
        ? 'ASK: Connect the fixture CRM to continue.'
        : { summary: 'Connect the fixture CRM to continue.', reply: 'Connect the fixture CRM to continue.',
          done: false, nextAction: 'awaiting_user_input', reason: null } } as never;
    },
    falloverModelIds: ['fixture-fallback-brain'],
    rebuildAgentForBrain: async () => { rebuilds += 1; return replacement as never; },
  });
  assert.equal(result.status, 'awaiting_user_input', JSON.stringify(result));
  assert.equal(runs, 2);
  assert.equal(rebuilds, 1);
  const { currentConnectionDependency } = await import('./dependency-request.js');
  const dependency = currentConnectionDependency(task.sessionId);
  assert.ok(dependency);
  const retained = connectionCheckpoints.readSourceConnectionCheckpoint({ sessionId: task.sessionId, requestId: dependency.requestId });
  assert.equal(retained?.agent?.modelId, replacement.model, 'original model must not replace the actual fallback at pause');
  assert.equal(retained.agent.mcpToolScope, null);
  assert.equal(retained.agent.rebuildContext.acceptedRoute, 'retrieve');
  leases.revokeDispatchLease(task.parentLease);
});

function recordedHostProgress(task: Fixture, batch: import('./accepted-model-batch-checkpoint.js').AcceptedModelBatchCheckpoint): import('./host-connection-progress.js').HostConnectionProgress {
  const initial = noProgress.initializeNoProgressGovernor({
    taskKey: batch.acceptedTaskId, authority: { operation: [], account: [], target: [], evidence: [], effect: [] },
  });
  const spent = noProgress.observeNoProgress(initial, {
    taskKey: initial.taskKey, attemptClass: 'dependency_lookup', authority: initial.authority,
  }).state;
  return {
    version: 1,
    batch: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, acceptedTaskId: batch.acceptedTaskId,
      authorityDigest: batch.authorityDigest, batchOrdinal: batch.batchOrdinal, batchId: batch.batchId },
    recovery: { turnEngine: 'host_v1', stepIndex: 3, objectiveJudgeContinuations: 1,
      noProgressCheckpoint: { state: spent, historyCursor: batch.history.length, recoveryOnly: true, recoveryDirectiveWritten: true },
      completionReviewFeedback: { version: 1, sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
        objective: 'Inspect the original account', objectiveDigest: digest('Inspect the original account'),
        reply: 'Draft before the connection pause', replyDigest: digest('Draft before the connection pause'), reason: 'Read the missing evidence.' } },
    activation: { maxTurns: 3, toolCalls: { used: 2, limit: 4 }, elapsedMs: 3210, judgeCompletion: true },
    continuations: { acceptedReadPlanUsed: true, acceptedUniqueWorkflowUsed: false, workflowStepResultUsed: 1,
      continueMarkerUsed: 1, planFinalPublishSpent: false, modelStallRetriesRemaining: 0, judgedBusinessCallsAtLastVerdict: 2 },
    watcher: { checksUsed: 2, injectionsUsed: 1, deliveredSteers: 1, unresolvedDrift: true,
      lastCheckedAt: 2, lastFailureSeq: 7, checkInFlight: true },
  };
}

test('connection progress survives reopen with spent judge, retry and step allowances and original evidence', async () => {
  const task = fixture('Inspect the controlled account after connection.', 'execute');
  const batch = await settledConnectionBatch(task);
  const agent = connectionAgent(task);
  const progress = recordedHostProgress(task, batch);
  hostProgress.bindHostConnectionProgress(agent, progress);
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent })!;
  const identity = { sessionId: task.sessionId, requestId: pause.requestId };
  // Neither mutation of the caller-owned object nor reuse/clear of the agent
  // may replenish an already-persisted request's counters.
  progress.recovery.objectiveJudgeContinuations = 0;
  hostProgress.clearHostConnectionProgress(agent);
  eventlog.closeEventLog();
  const reopened = readSourceConnectionHostRecovery(identity);
  assert.equal(reopened.hostState.objectiveJudgeContinuations, 1);
  assert.equal(reopened.hostState.stepIndex, reopened.progress.activation.maxTurns, 'an exhausted budget must remain exhausted');
  assert.equal(reopened.hostState.noProgressCheckpoint?.state.retriesRemaining, noProgress.NO_PROGRESS_RETRY_BUDGET - 1);
  assert.equal(reopened.hostState.noProgressCheckpoint?.historyCursor, batch.history.length);
  assert.deepEqual(reopened.hostState.history, batch.history);
  assert.equal(reopened.progress.continuations.modelStallRetriesRemaining, 0);
  assert.equal(reopened.progress.watcher.checkInFlight, true, 'unfinished review must not become a passed review');
  assert.equal(reopened.progress.activation.elapsedMs, 3210);
  assert.equal(reopened.hostState.completionReviewFeedback?.sourceUserSeq, task.sourceUserSeq);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['approval_requested'] }).length, 0);
  assert.equal(physicalRows(task, 'call:connection-search').length, 1);
  leases.revokeDispatchLease(task.parentLease);
});

for (const corruption of ['cursor', 'feedback-source', 'missing-progress'] as const) {
  test(`connection restore refuses ${corruption} instead of inventing fresh progress`, async () => {
    const task = fixture('Inspect the controlled account after connection.', 'execute');
    const batch = await settledConnectionBatch(task);
    const agent = connectionAgent(task);
    const progress = recordedHostProgress(task, batch);
    if (corruption === 'cursor') progress.recovery.noProgressCheckpoint!.historyCursor = batch.history.length + 1;
    if (corruption === 'feedback-source') progress.recovery.completionReviewFeedback!.sourceUserSeq += 1;
    if (corruption !== 'missing-progress') hostProgress.bindHostConnectionProgress(agent, progress);
    const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent })!;
    assert.throws(() => readSourceConnectionHostRecovery({ sessionId: task.sessionId, requestId: pause.requestId }),
      corruption === 'cursor' ? /invalid no-progress checkpoint/ : corruption === 'feedback-source'
        ? /review belongs to another/ : /no retained host progress/);
    assert.equal(physicalRows(task, 'call:connection-search').length, 1);
    leases.revokeDispatchLease(task.parentLease);
  });
}

test('an advanced canonical chain cannot borrow an older connection budget snapshot', async () => {
  const task = fixture('Inspect the controlled account after connection.', 'execute');
  const batch = await settledConnectionBatch(task);
  const agent = connectionAgent(task);
  hostProgress.bindHostConnectionProgress(agent, recordedHostProgress(task, batch));
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent })!;
  const extra = { callId: 'call:after-pause-inspection', toolName: 'tool_search', args: { query: 'extra inspection' } };
  const admitted = checkpoints.admitAcceptedModelBatch({ ...task, preHistory: batch.history,
    previousResponseId: batch.lastResponseId, frameHistory: openFrame(extra), providerResponseId: 'response:after-pause' });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);
  await runCall({ task, ...extra, effect: 'read', boundary: 'host_owned_local', localEnvelope: true,
    invoke: async () => ({ ok: true, rows: [] }) });
  const result = exactSettledResult({ task, callId: extra.callId, history: [...batch.history, ...openFrame(extra)] });
  recordLogicalResult(admitted.admission, result);
  assert.ok(['committed', 'existing'].includes(checkpoints.finalizeAcceptedModelBatch(admitted.admission, { committedResultItems: [result] }).status));
  const retained = connectionCheckpoints.readSourceConnectionCheckpoint({ sessionId: task.sessionId, requestId: pause.requestId })!;
  assert.equal(checkpoints.recoverAcceptedModelBatchFromToken(retained.restartToken).status, 'ready', 'ordinary restart still accepts a proven descendant');
  assert.throws(() => readSourceConnectionHostRecovery({ sessionId: task.sessionId, requestId: pause.requestId }), /advanced beyond retained progress/);
  leases.revokeDispatchLease(task.parentLease);
});

test('reviewed connection pause retains the exact batch across ASK, reopen and newer chat without replaying a settled write', async () => {
  const task = fixture('Create the fixture artifact once, then inspect the controlled CRM.', 'execute');
  const write = { callId: 'call:connection-prior-write', toolName: 'space_publish', args: { title: 'Checkpoint fixture' } };
  const admitted = checkpoints.admitAcceptedModelBatch({ ...task, preHistory: preHistory(task),
    frameHistory: openFrame(write), providerResponseId: 'response:connection-prior-write' });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);
  let writes = 0;
  const payload = { ok: true, id: 'fixture-artifact' };
  await runCall({ task, ...write, effect: 'external_write', invoke: async () => { writes += 1; return payload; } });
  const written = exactSettledResult({ task, callId: write.callId, history: [...preHistory(task), ...openFrame(write)] });
  recordLogicalResult(admitted.admission, written);
  assert.ok(['committed', 'existing'].includes(checkpoints.finalizeAcceptedModelBatch(admitted.admission,
    { committedResultItems: [written] }).status));
  const canonical = await settledConnectionBatch(task);
  const withQuestion = [...canonical.history, { role: 'assistant', content: 'ASK: Please connect the fixture CRM.' } as AgentInputItem];
  sessionStore.HarnessSession.load(task.sessionId)!.recordTurnResult({ history: withQuestion, turn: 1 });

  // Both ordinary ASK projection and an explicit awaiting-input terminal park
  // through this production seam, after their public question is determined.
  const agent = connectionAgent(task);
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent });
  assert.ok(pause);
  const identity = { sessionId: task.sessionId, requestId: pause.requestId };
  const retained = connectionCheckpoints.readSourceConnectionCheckpoint(identity)!;
  assert.ok(retained);
  assert.equal(retained.restartToken.resumeFromHistoryDigest, canonical.historyDigest);
  assert.equal(retained.restartToken.resumeFromBatchId, canonical.batchId);
  assert.equal(retained.sourceUserSeq, task.sourceUserSeq);
  assert.equal('history' in retained, false, 'retain a cursor, never a second full prompt');
  assert.equal(JSON.stringify(retained).includes('ASK:'), false);
  assert.equal(retained.agent?.modelId, 'fixture-original-brain');
  assert.deepEqual(retained.agent?.rebuildContext, { excludeToolNames: ['run_shell_command'], allowToolJit: true });
  assert.deepEqual(retained.agent?.mcpToolScope?.deniedServerSlugs, ['fixture-private']);
  assert.deepEqual(retained.agent?.bindingRevision?.bound, ['tool_search']);
  assert.equal(retained.agent?.envelope.envelopeDigest, agentEnvelopes.boundAgentCapabilityEnvelope(agent)?.envelopeDigest);
  assert.equal(JSON.stringify(retained).includes('must-not-be-saved'), false);
  assert.equal(JSON.stringify(retained).includes('private agent instructions'), false);
  agent.model = 'fixture-different-brain';
  mcpAuthority.bindAgentMcpToolScope(agent, { reason: 'later unrelated scope', authority: 'catalog', allowAll: true });
  agentRebuild.bindAgentRebuildContext(agent, { allowToolJit: false });
  assert.deepEqual(connectionCheckpoints.readSourceConnectionCheckpoint(identity), retained,
    'later mutations or builds cannot alter retained construction context');
  assert.deepEqual(connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1 }), pause);
  assert.throws(() => eventlog.openEventLog().prepare('UPDATE source_connection_checkpoints_v1 SET checkpoint_json = ? WHERE request_id = ?')
    .run('{}', pause.requestId), /immutable/);
  assert.equal(connectionCheckpoints.readSourceConnectionCheckpoint({ ...identity, sessionId: 'wrong-session' }), null);

  eventlog.closeEventLog();
  sessionStore.HarnessSession.load(task.sessionId)!.recordTurnResult({ history: [{ role: 'user', content: 'A different conversation.' } as AgentInputItem], turn: 2 });
  eventlog.appendEvent({ sessionId: task.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Work on something else.' } });
  assert.deepEqual(connectionCheckpoints.readSourceConnectionCheckpoint(identity), retained);
  const reopened = checkpoints.recoverAcceptedModelBatchFromToken(retained.restartToken);
  assert.equal(reopened.status, 'ready');
  if (reopened.status !== 'ready') throw new Error(reopened.reason);
  assert.deepEqual(reopened.checkpoint.history, canonical.history);
  assert.equal((await import('./dependency-request.js')).currentConnectionDependency(task.sessionId, pause.requestId), null,
    'retained context does not make a superseded task eligible to resume');

  const replay = await runCall({ task, ...write, effect: 'external_write', invoke: async () => { writes += 1; return payload; } });
  assert.equal(replay.settlement.duplicate, true);
  assert.equal(writes, 1);
  assert.equal(physicalRows(task, write.callId).length, 1);
  const nextFrame = openFrame({ callId: 'call:after-connection', toolName: 'records_read', args: {} });
  const wrong = checkpoints.admitAcceptedModelBatch({ ...task, preHistory: withQuestion, frameHistory: nextFrame,
    previousResponseId: canonical.lastResponseId, providerResponseId: 'response:wrong-history' });
  assert.equal(wrong.status, 'unavailable', 'the database chain constraint rejects the appended ASK frame');
  if (wrong.status === 'unavailable') assert.match(wrong.reason, /chain|checkpoint/i);
  const next = checkpoints.admitAcceptedModelBatch({ ...task, preHistory: reopened.checkpoint.history, frameHistory: nextFrame,
    previousResponseId: reopened.checkpoint.lastResponseId, providerResponseId: 'response:valid-chain' });
  assert.equal(next.status, 'admitted');
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) AS n FROM reviewed_plan_execution_claims_v1 WHERE session_id = ?')
    .get(task.sessionId) as { n: number }).n, 1);
  eventlog.openEventLog().prepare('UPDATE dependency_requests SET subject_capability = ? WHERE request_id = ?')
    .run('FIXTURECRM_DIFFERENT', pause.requestId);
  assert.throws(() => connectionCheckpoints.readSourceConnectionCheckpoint(identity), /lost its reviewed execution owner/);
  assert.equal(connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1 })?.requestId, pause.requestId,
    'invalid retained context cannot abort the public connection pause');
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['connection_execution_checkpoint_unavailable'] })[0]?.data.reason,
    'checkpoint_context_inconsistent');
  leases.revokeDispatchLease(task.parentLease);
});

test('a reviewed connection checkpoint preserves explicit MCP denial and never serializes an opaque model', async () => {
  const task = fixture('Inspect controlled connection metadata with no external MCP permission.', 'execute');
  await settledConnectionBatch(task);
  const agent = connectionAgent(task, null);
  Object.assign(agent, { model: { getResponse: () => { throw new Error('No model calls allowed.'); }, key: 'do-not-retain-provider-object' } });
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent });
  assert.ok(pause);
  const retained = connectionCheckpoints.readSourceConnectionCheckpoint({ sessionId: task.sessionId, requestId: pause.requestId });
  assert.ok(retained?.agent);
  assert.equal(retained.agent.mcpToolScope, null);
  assert.equal(Object.hasOwn(retained.agent, 'modelId'), false);
  assert.equal(JSON.stringify(retained).includes('do-not-retain-provider-object'), false);
  leases.revokeDispatchLease(task.parentLease);
});

test('agent-shaped public fields cannot manufacture private retained connection scope', async () => {
  const task = fixture('Read the controlled CRM once connected.', 'execute');
  await settledConnectionBatch(task);
  const agent = { model: 'pretend-model', mcpToolScope: { authority: 'catalog', allowAll: true },
    envelope: { envelopeDigest: 'pretend-envelope' }, rebuildContext: { allowToolJit: true } };
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent });
  assert.ok(pause);
  const retained = connectionCheckpoints.readSourceConnectionCheckpoint({ sessionId: task.sessionId, requestId: pause.requestId });
  assert.ok(retained);
  assert.equal(retained.agent, undefined, 'missing private bindings remain unknown, not unrestricted');
  await assert.rejects(rebuildSourceConnectionAgent({ sessionId: task.sessionId, requestId: pause.requestId,
    assertOwned: () => {} }, {
    prime: async () => { throw new Error('Missing context must stop before catalog construction.'); },
    revalidate: async () => { throw new Error('Missing context must stop before review.'); },
    build: async () => { throw new Error('Missing context must not build a default agent.'); },
  }), /no retained tool context and replayable model identity/);
  leases.revokeDispatchLease(task.parentLease);
});

for (const denyExternal of [false, true]) for (const route of [undefined, 'act'] as const)
  test(`connection rebuild restores original model and restrictions (external denial=${denyExternal}, route=${route})`, async () => {
  const task = fixture('Inspect the controlled CRM after restoring its exact reviewed connection.', 'execute');
  await settledConnectionBatch(task);
  const agent = connectionAgent(task, denyExternal ? null : undefined, route);
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent });
  assert.ok(pause);
  const identity = { sessionId: task.sessionId, requestId: pause.requestId };
  const retained = connectionCheckpoints.readSourceConnectionCheckpoint(identity)!;
  assert.ok(retained.agent);
  eventlog.closeEventLog();
  const order: string[] = [];
  const planning = { fixture: 'fresh original-source planning' } as never;
  const rebuilt = await rebuildSourceConnectionAgent({ ...identity, assertOwned: () => { order.push('owner'); } }, {
    prime: async input => {
      assert.deepEqual(input, { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq });
      order.push('prime'); return { ok: true, planning } as never;
    },
    revalidate: async input => { assert.equal(input, planning); order.push('revalidate'); },
    build: async options => {
      order.push('build');
      assert.equal(options.sourceUserSeq, task.sourceUserSeq);
      assert.equal(options.model, 'fixture-original-brain');
      assert.equal(options.allowToolJit, true);
      assert.equal(options.acceptedRoute, route);
      assert.deepEqual(options.excludeToolNames, ['run_shell_command']);
      assert.match(options.userInput!, /Execute reviewed|explicitly selected Execute/);
      assert.equal(options.hostFreshPlanning, planning);
      if (denyExternal) assert.equal(options.mcpToolScope?.authority, 'none');
      else assert.deepEqual(options.mcpToolScope, retained.agent!.mcpToolScope);
      // The current builder must seal its own output. Copying the old envelope
      // in the production rebuild helper would make the drift test below pass.
      const result = connectionAgent(task, options.mcpToolScope, options.acceptedRoute);
      return result as never;
    },
  });
  assert.equal(rebuilt.model, 'fixture-original-brain');
  assert.deepEqual(order.filter(x => x !== 'owner'), ['prime', 'revalidate', 'build']);
  assert.ok(order.slice(order.indexOf('prime') + 1, order.indexOf('revalidate')).includes('owner'));
  assert.ok(order.slice(order.indexOf('revalidate') + 1, order.indexOf('build')).includes('owner'));
  assert.equal(order.at(-1), 'owner');
  assert.deepEqual(connectionCheckpoints.readSourceConnectionCheckpoint(identity), retained);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['approval_requested', 'run_resumed'] }).length, 0,
    'building context neither grants consent nor starts a continuation');
  leases.revokeDispatchLease(task.parentLease);
});

for (const drift of ['reviewed-account', 'schema', 'scope', 'model', 'route', 'missing-route', 'construction', 'owner-after-prime', 'owner-after-build'] as const) {
  test(`connection rebuild refuses ${drift} drift without substituting retained authority`, async () => {
    const task = fixture('Continue using the original reviewed account and tools.', 'execute');
    await settledConnectionBatch(task);
    const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent: connectionAgent(task, undefined, 'act') });
    assert.ok(pause);
    let lost = false;
    let builds = 0;
    let validations = 0;
    const attempt = rebuildSourceConnectionAgent({ sessionId: task.sessionId, requestId: pause.requestId,
      assertOwned: () => { if (lost) throw new Error('original activation lost'); } }, {
      prime: async () => {
        if (drift === 'owner-after-prime') lost = true;
        return { ok: true, planning: {} } as never;
      },
      revalidate: async () => { validations += 1; if (drift === 'reviewed-account') throw new Error('Reviewed account changed.'); },
      build: async options => {
        builds += 1;
        const result = connectionAgent(task, options.mcpToolScope, options.acceptedRoute);
        if (drift === 'schema') {
          const changed = agentEnvelopes.sealAgentCapabilityUniverse({ sessionId: task.sessionId,
            universeTools: [{ name: 'tool_search', description: 'Changed callable contract', parameters: { type: 'object' } }],
            activeToolNames: ['tool_search'], policyHash: 'fixture-policy',
            budget: { maxUncachedTokens: 1000, maxModelCalls: 8, maxToolCalls: 8, maxElapsedMs: 30000 } });
          assert.ok(changed.ok);
          if (changed.ok) agentEnvelopes.bindAgentCapabilityEnvelope(result, changed.envelope);
        }
        if (drift === 'scope') mcpAuthority.bindAgentMcpToolScope(result, { reason: 'broader replacement', authority: 'catalog', allowAll: true });
        if (drift === 'model') result.model = 'unrequested-model';
        if (['route', 'missing-route', 'construction'].includes(drift)) agentRebuild.bindAgentRebuildContext(result, {
          excludeToolNames: ['run_shell_command'], allowToolJit: drift !== 'construction',
          acceptedRoute: drift === 'route' ? 'retrieve' : drift === 'missing-route' ? undefined : options.acceptedRoute,
        });
        if (drift === 'owner-after-build') lost = true;
        return result as never;
      },
    });
    const expected = drift === 'reviewed-account' ? /Reviewed account changed/
      : drift === 'schema' ? /definitions or policy changed/
      : drift === 'scope' ? /external tool scope/
      : drift === 'model' ? /selected model/
      : ['route', 'missing-route', 'construction'].includes(drift) ? /construction context or accepted route/ : /activation lost/;
    await assert.rejects(attempt, expected);
    assert.equal(builds, ['reviewed-account', 'owner-after-prime'].includes(drift) ? 0 : 1);
    assert.equal(validations, drift === 'owner-after-prime' ? 0 : 1);
    leases.revokeDispatchLease(task.parentLease);
  });
}

for (const synthetic of [false, true]) for (const stopped of ['execution', 'approval-delivery'] as const) {
  test(`approval-resumed Execute (synthetic=${synthetic}) retains its execution checkpoint and honors Stop on ${stopped}`, async () => {
    const task = fixture('Inspect the controlled CRM after the approved fixture action.', 'execute');
    const approvals = await import('./approval-registry.js');
    const dependencies = await import('./dependency-request.js');
    const setup = await import('./connection-setup.js');
    const card = approvals.register({ sessionId: task.sessionId, subject: 'Controlled fixture action', tool: 'fixture_send', args: { target: 'test' } });
    assert.equal(approvals.resolve(card.approvalId, 'approved', 'fixture-owner').ok, true);
    const control = eventlog.appendEvent({ sessionId: task.sessionId, turn: 2, role: 'user', type: 'user_input_received',
      data: { text: 'Approved.', synthetic, approvalId: card.approvalId, decision: 'approve' } });
    eventlog.appendEvent({ sessionId: task.sessionId, turn: 2, role: 'system', type: 'run_resumed',
      data: { approvalId: card.approvalId, decision: 'approve', reviewContinuationVersion: 1,
        executionSourceUserSeq: task.sourceUserSeq, deliverySourceUserSeq: control.seq } });
    await settledConnectionBatch(task);
    const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ sessionId: task.sessionId, sourceUserSeq: control.seq, turn: 2 });
    assert.ok(pause);
    assert.equal(pause.sourceUserSeq, task.sourceUserSeq);
    assert.equal(connectionCheckpoints.readSourceConnectionCheckpoint({ sessionId: task.sessionId, requestId: pause.requestId })?.sourceUserSeq, task.sourceUserSeq);
    assert.equal(dependencies.currentConnectionDependency(task.sessionId)?.requestId, pause.requestId,
      'the UI can find the pause under its validated approval delivery source');
    assert.equal(setup.connectionContinuationTaskMode({ sessionId: task.sessionId, connectionRequestId: pause.requestId })?.kind, 'execute');
    assert.ok(setup.readConnectionSetup(task.sessionId)?.continuationBlocker, 'retention still cannot enable Execute auto-resume');
    eventlog.appendEvent({ sessionId: task.sessionId, turn: 3, role: 'user', type: 'user_input_received',
      data: { text: 'An unrelated background report-back.', synthetic: true } });
    assert.equal(dependencies.currentConnectionDependency(task.sessionId)?.requestId, pause.requestId);
    const attempt = eventlog.beginRunAttempt(task.sessionId);
    const stoppedSource = stopped === 'execution' ? task.sourceUserSeq : control.seq;
    eventlog.recordRunAttemptUserInput(attempt, { turn: 2, role: 'user', data: { text: 'Fixture attempt' } }, { existingEventSeq: stoppedSource });
    eventlog.finishRunAttempt(attempt, 'cancelled');
    assert.equal(dependencies.currentConnectionDependency(task.sessionId), null);
    leases.revokeDispatchLease(task.parentLease);
  });
}

test('approval-looking user text without a host resume marker cannot select an older connection pause', async () => {
  const task = fixture('Inspect the controlled CRM.', 'execute');
  await settledConnectionBatch(task);
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1 });
  assert.ok(pause);
  const control = eventlog.appendEvent({ sessionId: task.sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Approved.', approvalId: 'unproven-card', decision: 'approve' } });
  assert.equal(connectionCheckpoints.parkObservedConnectionWithCheckpoint({ sessionId: task.sessionId, sourceUserSeq: control.seq, turn: 2 }), null);
  assert.equal((await import('./dependency-request.js')).currentConnectionDependency(task.sessionId), null);
  leases.revokeDispatchLease(task.parentLease);
});

test('connection pause cannot manufacture execution history from prose or missing batch evidence', async () => {
  const task = fixture('Inspect the disconnected controlled CRM.', 'execute');
  assert.equal(connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, text: 'Please connect the CRM.' }), null);
  connectionSearchEvidence(task);
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1 });
  assert.ok(pause);
  const identity = { sessionId: task.sessionId, requestId: pause.requestId };
  assert.equal(connectionCheckpoints.readSourceConnectionCheckpoint(identity), null);
  assert.deepEqual(connectionCheckpoints.captureSourceConnectionCheckpoint(identity), { status: 'unavailable', reason: 'missing' });
  connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1 });
  const diagnostics = eventlog.listEvents(task.sessionId, { types: ['connection_execution_checkpoint_unavailable'] });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.data.reason, 'missing');
  const { projectHarnessEventForPublic } = await import('./public-presentation.js');
  assert.equal(projectHarnessEventForPublic(diagnostics[0]!), null, 'recovery diagnostics are not chat content');
  leases.revokeDispatchLease(task.parentLease);
});

for (const mode of ['normal', 'plan'] as const) {
  test(`${mode} setup does not create a reviewed execution checkpoint`, () => {
    const task = fixture('Inspect the disconnected controlled CRM.', mode);
    connectionSearchEvidence(task);
    const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1 });
    assert.ok(pause);
    assert.equal(connectionCheckpoints.readSourceConnectionCheckpoint({ sessionId: task.sessionId, requestId: pause.requestId }), null);
    assert.equal(eventlog.listEvents(task.sessionId, { types: ['connection_execution_checkpoint_unavailable'] }).length, 0);
    leases.revokeDispatchLease(task.parentLease);
  });
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

for (const variant of ['local_control', 'business_local', 'external', 'admin', 'wrong_parent', 'wrong_source', 'no_failure', 'catalog_binding'] as const) {
  test(`a returned local write keeps its exact bytes; external, admin and catalog-bound writes still reconcile (${variant})`, async () => {
    const task = fixture(`Retain the exact ${variant} result, without replay or success.`);
    const callId = `call:coordinator-failure:${variant}`;
    const toolName = 'fixture_coordinator';
    const args = { items: ['item-1'] };
    const admitted = checkpoints.admitAcceptedModelBatch({
      sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
      preHistory: preHistory(task), frameHistory: openFrame({ callId, toolName, args }),
    });
    assert.equal(admitted.status, 'admitted');
    if (admitted.status !== 'admitted') throw new Error(admitted.reason);
    const payload = 'The item failed; retain this exact failure for the next step.';
    let bodies = 0;
    const invoked = await runCall({
      task, callId, toolName, args,
      effect: variant === 'external' ? 'external_write' : variant === 'admin' ? 'admin' : 'local_write',
      localEnvelope: variant !== 'catalog_binding',
      businessCall: variant === 'business_local',
      boundary: 'host_owned_local',
      invoke: async () => {
        bodies += 1;
        eventlog.appendEvent({ sessionId: task.sessionId, turn: 1, role: 'system', type: 'worker_result', data: {
          item: 'item-1', packetKey: 'exact-packet', ok: variant === 'no_failure',
          parentLogicalCallId: variant === 'wrong_parent' ? 'another-call' : callId,
          sourceUserSeq: variant === 'wrong_source' ? task.sourceUserSeq + 1 : task.sourceUserSeq,
        } });
        observations.noteHostToolInvocationObservation({ signals: { executionFailed: true } });
        return payload;
      },
    });
    assert.equal(invoked.settlement.outcome.kind, 'unknown');
    const resultItem = projectedTextResult({ callId, toolName, value: payload });
    recordLogicalResult(admitted.admission, resultItem);
    const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, { committedResultItems: [resultItem] });
    // The local envelope's own returned result is a known outcome, whichever
    // receipt the body wrote; only the effect class and binding decide.
    if (variant !== 'external' && variant !== 'admin' && variant !== 'catalog_binding') {
      assert.ok(finalized.status === 'committed' || finalized.status === 'existing');
      const recovered = checkpoints.recoverAcceptedModelBatchForRestart({ sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq });
      assert.equal(recovered.status, 'ready');
      if (recovered.status !== 'ready') throw new Error(recovered.reason);
      assert.equal(resultText(recovered.checkpoint.history, callId), payload);
    } else assert.equal(finalized.status, 'evidence_unavailable', 'external, admin and catalog-bound unknown mutations still need reconciliation');
    assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) AS n FROM durable_result_handles WHERE session_id = ?').get(task.sessionId) as { n: number }).n, 0);
    assert.equal(bodies, 1, 'failure projection never re-enters the body');
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

test('a local write whose own failure leaves its effect uncertain keeps the turn going; nothing replays it', async () => {
  // The runner shows the model a local write's own result even when its
  // effect is uncertain (reconciliation-stop.ts); the checkpoint accepts what
  // the runner showed. The external twin above stays closed.
  const task = fixture('Open one local browser tab whose effect is not acknowledged.');
  const callId = 'call:local-uncertain-write';
  const toolName = 'fixture_local_open';
  const args = { url: 'about:blank' };
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
    preHistory: preHistory(task), frameHistory: openFrame({ callId, toolName, args }),
  });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);
  const payload = { ok: false, error: 'The local browser did not answer.' };
  let bodies = 0;
  const invoked = await runCall({
    task, callId, toolName, args, effect: 'local_write', localEnvelope: true, boundary: 'host_owned_local',
    invoke: async () => { bodies += 1; return payload; },
  });
  assert.equal(invoked.settlement.outcome.kind, 'uncertain_write');
  const resultItem = projectedTextResult({ callId, toolName, value: payload });
  recordLogicalResult(admitted.admission, resultItem);
  const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, { committedResultItems: [resultItem] });
  assert.ok(finalized.status === 'committed' || finalized.status === 'existing', JSON.stringify(finalized));
  const recovered = checkpoints.recoverAcceptedModelBatchForRestart({ sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq });
  assert.equal(recovered.status, 'ready');
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) AS n FROM durable_result_handles WHERE session_id = ?').get(task.sessionId) as { n: number }).n, 0,
    'an uncertain write never gets a success handle');
  assert.equal(bodies, 1, 'and is never run again');
  leases.revokeDispatchLease(task.parentLease);
});

test('an external write the provider answered with its own refusal checkpoints ready: read back, never replayed, never a reconciliation stop', async () => {
  // Live 2026-10-07 (v3.18.32 candidate, wave 26): Slack answered a reminder
  // delete with `not_found`; the settlement no longer stops the turn, but the
  // checkpoint projected nothing for it and the turn ended "I could not
  // reopen the saved checkpoint".
  const task = fixture('Delete the exact Slack reminder once.', 'execute');
  const callId = 'call:answered-refusal-write';
  const toolName = 'slack_delete_reminder';
  const args = { reminder: 'Rm0FIXTURE' };
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
    preHistory: preHistory(task), frameHistory: openFrame({ callId, toolName, args }),
    providerResponseId: 'response:answered-refusal-write',
  });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);
  const payload = { successful: false, error: 'Slack API error: not_found', data: { ok: false, error: 'not_found' } };
  let bodies = 0;
  const invoked = await runCall({
    task, callId, toolName, args, effect: 'external_write', boundary: 'host_owned_local',
    invoke: async () => { bodies += 1; return payload; },
  });
  assert.equal(invoked.settlement.outcome.kind, 'uncertain_write');
  assert.equal(invoked.settlement.outcome.detail, 'provider_refused_envelope');
  assert.equal(invoked.settlement.outcome.directive.requiresReconciliation, false);
  const resultItem = projectedTextResult({ callId, toolName, value: payload });
  recordLogicalResult(admitted.admission, resultItem);
  const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, { committedResultItems: [resultItem] });
  assert.ok(finalized.status === 'committed' || finalized.status === 'existing', JSON.stringify(finalized));
  assert.equal(finalized.checkpoint.disposition, 'ready');
  const recovered = checkpoints.recoverAcceptedModelBatchForRestart({ sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq });
  assert.equal(recovered.status, 'ready');
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) AS n FROM durable_result_handles WHERE session_id = ?').get(task.sessionId) as { n: number }).n, 0,
    'an answered refusal never gets a success handle');
  assert.equal(bodies, 1, 'and is never run again');
  leases.revokeDispatchLease(task.parentLease);
});

test('an uncertain host-owned mutation with zero provider crossings checkpoints reconciliation', async () => {
  const task = fixture('Attempt one host-owned mutation whose effect is not acknowledged.', 'execute');
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
  connectionSearchEvidence(task);
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1 });
  assert.ok(pause);
  const identity = { sessionId: task.sessionId, requestId: pause.requestId };
  assert.deepEqual(connectionCheckpoints.captureSourceConnectionCheckpoint(identity),
    { status: 'unavailable', reason: 'reconciliation_required' });
  assert.equal(connectionCheckpoints.readSourceConnectionCheckpoint(identity), null,
    'a connection cannot clear an uncertain write or make it restart-ready');
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
