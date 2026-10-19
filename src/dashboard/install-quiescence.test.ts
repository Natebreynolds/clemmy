import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-install-quiescence-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true' });
mkdirSync(path.join(home, 'state'), { recursive: true });
const events = await import('../runtime/harness/eventlog.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const { readInstallQuiescence } = await import('./install-quiescence.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { _resetWorkflowRunInventoryForTests } = await import('../execution/workflow-run-inventory.js');
const { HostRecoveryState } = await import('../runtime/harness/host-turn-runner.js');
const { commitTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
const { turnOutcomeId } = await import('../runtime/harness/turn-outcome.js');
const shadow = await import('../runtime/graph/turn-graph-shadow.js');
const ledger = await import('../runtime/harness/dispatch-ledger.js');
const leases = await import('../runtime/harness/dispatch-lease.js');
const contracts = await import('../runtime/harness/logical-call-contract.js');
const effects = await import('../runtime/harness/tool-effect.js');
const backgroundDir = path.join(home, 'state', 'background-tasks');
const codingDir = path.join(home, 'state', 'coding-runs');
const machineIdFile = path.join(home, 'state', 'machine-id');
const codingFile = path.join(codingDir, 'controlled-machine', 'coding-runs.db');

beforeEach(() => {
  events.resetEventLog();
  for (const dir of [WORKFLOW_RUNS_DIR, backgroundDir]) { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }
  rmSync(codingDir, { recursive: true, force: true });
  writeFileSync(machineIdFile, 'controlled-machine\n');
  _resetWorkflowRunInventoryForTests();
});
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

function attempt(kind: 'chat' | 'workflow' | 'execution' | 'agent' = 'chat') {
  const session = events.createSession({ kind });
  const run = events.beginRunAttempt(session.id, { runId: `quiescence:${session.id}` });
  const source = events.recordRunAttemptUserInput(run, { turn: 1, role: 'user', data: { text: 'Controlled install fixture.' } });
  return { session, run, source };
}
function workflow(id: string, status: string) {
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${id}.json`), JSON.stringify({ id, workflow: 'controlled-workflow', status,
    createdAt: new Date().toISOString(), ...(status === 'completed' ? { finishedAt: new Date().toISOString() } : {}) }));
}

test('hundreds of historical active or paused sessions do not become current work', () => {
  for (let index = 0; index < 302; index++) {
    const session = events.createSession({ kind: index % 3 ? 'workflow' : 'agent',
      metadata: { workflowRunId: `historical-${index}`, stepId: 'old-step', workflowName: 'old-workflow' } });
    if (index % 2 === 0) events.updateSession(session.id, { status: 'paused' });
  }
  const snapshot = readInstallQuiescence();
  assert.equal(snapshot.total, 0);
  assert.equal(snapshot.quiescence.state, 'quiescent');
  assert.deepEqual(snapshot.currentWork.items, []);
  assert.equal(events.listSessions({ limit: 500 }).length, 302, 'observation never repairs or deletes history');
});

test('a newly executing chat is protected immediately and all other attempt kinds count', () => {
  const chat = attempt();
  events.openEventLog().prepare('UPDATE run_attempts SET lease_owner = ?, lease_expires_at = ? WHERE attempt_id = ?')
    .run('controlled-owner', new Date(Date.now() + 60_000).toISOString(), chat.run.attemptId);
  assert.equal(readInstallQuiescence().currentWork.items[0]?.state, 'running');
  for (const kind of ['workflow', 'execution', 'agent'] as const) attempt(kind);
  const snapshot = readInstallQuiescence();
  assert.equal(snapshot.total, 4);
  assert.equal(snapshot.quiescence.state, 'work_pending');
});

test('a parked decision and an exact unfinished checkpoint remain protected without a live attempt', () => {
  const pending = events.createSession({ kind: 'chat' });
  approvals.register({ sessionId: pending.id, subject: 'Controlled approval' });
  const checkpoint = events.createSession({ kind: 'chat' });
  const source = events.appendEvent({ sessionId: checkpoint.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Controlled retained objective.' } });
  const state = new HostRecoveryState(checkpoint.id, source.seq, 'continue', [], [], [], undefined, undefined,
    'host_v1', undefined, 0, { sessionId: checkpoint.id, sourceUserSeq: source.seq,
      acceptedTaskId: `task:${checkpoint.id}#${source.seq}`, batchOrdinal: 1, batchId: 'a'.repeat(64), authorityDigest: 'b'.repeat(64) });
  events.openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run(JSON.stringify({
    __host_recovery_state: state.toString(),
    __continuation_owner: { sourceUserSeq: source.seq },
  }), checkpoint.id);
  const snapshot = readInstallQuiescence();
  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.quiescence.state, 'work_pending');
  assert.ok(snapshot.currentWork.items.some(owner => owner.kind === 'checkpoint'));
  assert.ok(snapshot.currentWork.items.some(owner => owner.approvalIds.length === 1));
});

test('legacy terminal background rows and empty optional metadata do not become permanent warnings', () => {
  for (const [index, metadata] of ['{}', ''].entries()) {
    const session = events.createSession({ kind: 'workflow' });
    events.openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run(metadata, session.id);
    writeFileSync(path.join(backgroundDir, `legacy-${index}.json`), JSON.stringify({ id: `legacy-${index}`,
      status: index ? 'awaiting_continue' : 'done', ...(index ? { archived: true } : {}) }));
  }
  assert.equal(readInstallQuiescence().total, 0);
});

test('a source-shaped malformed checkpoint is unverified, not promoted to current execution', () => {
  const session = events.createSession({ kind: 'chat' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Controlled checkpoint corruption.' } });
  events.openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run(JSON.stringify({
    __host_recovery_state: JSON.stringify({ sessionId: session.id, sourceUserSeq: source.seq, phase: 'continue' }),
    __continuation_owner: { sourceUserSeq: source.seq },
  }), session.id);
  const snapshot = readInstallQuiescence();
  assert.equal(snapshot.quiescence.state, 'unverified');
  assert.equal(snapshot.currentWork.total, 0);
  assert.ok(snapshot.quiescence.issues.includes('checkpoint_owner_unverified'));
});

test('indexed checkpoint corruption is not mistaken for an absent tombstone', () => {
  const session = events.createSession({ kind: 'chat' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Controlled indexed checkpoint.' } });
  const store = (index: unknown) => events.openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?')
    .run(JSON.stringify({ __source_approval_checkpoints: index }), session.id);
  for (const index of [{ [source.seq]: null }, { [source.seq]: false }, { [source.seq]: 0 },
    { [`00${source.seq}`]: { revision: 'controlled-revision', checkpoint: null } },
    { [source.seq]: { revision: 'controlled-revision' } }]) {
    store(index);
    const snapshot = readInstallQuiescence();
    assert.equal(snapshot.quiescence.state, 'unverified');
    assert.ok(snapshot.total > 0);
    assert.ok(snapshot.quiescence.issues.includes('checkpoint_owner_unverified'));
  }
  store({ [source.seq]: { revision: 'controlled-revision', checkpoint: null } });
  assert.equal(readInstallQuiescence().total, 0, 'only an explicit well-formed tombstone establishes absence');
});

test('a current workflow, child attempt and its approval are one proven work owner', () => {
  workflow('controlled-live-run', 'running');
  const child = events.createSession({ kind: 'workflow', metadata: { workflowRunId: 'controlled-live-run',
    workflowName: 'controlled-workflow', stepId: 'controlled-step' } });
  const run = events.beginRunAttempt(child.id, { runId: 'controlled-child' });
  approvals.register({ sessionId: child.id, subject: 'Controlled child approval' });
  const snapshot = readInstallQuiescence();
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.currentWork.items[0]?.key, 'workflow:controlled-live-run');
  assert.deepEqual(snapshot.currentWork.items[0]?.sessionIds, [child.id]);
  assert.equal(snapshot.currentWork.items[0]?.approvalIds.length, 1);
  assert.equal(events.getActiveRunAttempt(child.id)?.attemptId, run.attemptId);
});

test('canonical readiness, catch-up, pending and mutation waits are known protected workflow owners', () => {
  for (const status of ['blocked_readiness', 'awaiting_catchup_decision', 'pending', 'blocked_mutation']) workflow(`controlled-${status}`, status);
  const snapshot = readInstallQuiescence();
  assert.equal(snapshot.total, 4);
  assert.equal(snapshot.quiescence.state, 'work_pending');
  assert.ok(snapshot.currentWork.items.every(owner => owner.kind === 'workflow' && owner.state === 'waiting'));
  assert.deepEqual(snapshot.quiescence.issues, []);
});

test('a background owner, its attempt and its card are deduplicated', () => {
  const child = attempt('agent');
  const card = approvals.register({ sessionId: child.session.id, subject: 'Controlled background approval' });
  writeFileSync(path.join(backgroundDir, 'controlled-task.json'), JSON.stringify({ id: 'controlled-task',
    status: 'awaiting_approval', runSessionId: child.session.id, pendingApprovalId: card.approvalId }));
  const snapshot = readInstallQuiescence();
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.currentWork.items[0]?.kind, 'background');
});

test('a dispatch lease bound to a finished attempt and terminal workflow history do not warn', () => {
  const prior = attempt();
  events.finishRunAttempt(prior.run, 'completed');
  events.openEventLog().prepare(`INSERT INTO run_dispatch_leases
    (scope_id, session_id, lease_id, run_attempt_id, activated_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)`)
    .run('controlled-stale-scope', prior.session.id, 'controlled-stale-lease', prior.run.attemptId, new Date().toISOString());
  workflow('controlled-completed', 'completed');
  assert.equal(readInstallQuiescence().total, 0);
});

test('an older unbound lease needs its own exact later typed terminal to become history', () => {
  const prior = attempt();
  const activatedAt = new Date(Date.now() - 60_000).toISOString();
  const identity = { sessionId: prior.session.id, sourceUserSeq: prior.source.seq, turn: prior.source.turn,
    attemptId: prior.run.attemptId, runId: prior.run.runId ?? undefined };
  commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false,
    presentation: { kind: 'answer', text: 'The controlled fixture is complete.' } });
  const db = events.openEventLog();
  const prepare = db.prepare.bind(db);
  let source: number | null = prior.source.seq;
  // Retained pre-migration lease shape, injected only at the read boundary:
  // today's authority trigger correctly refuses manufacturing it as new work.
  db.prepare = ((sql: string) => sql.includes('FROM run_dispatch_leases lease LEFT JOIN run_attempts')
    ? { all: () => [{ session_id: prior.session.id, lease_id: 'controlled-legacy', attempt_id: null,
      source_user_seq: source, attempt_source_user_seq: null, activated_at: activatedAt }] }
    : prepare(sql)) as typeof db.prepare;
  try {
    assert.equal(readInstallQuiescence().total, 0);
    source = null;
    const unknown = readInstallQuiescence();
    assert.equal(unknown.quiescence.state, 'unverified', 'a latest-session terminal cannot settle an unbound lease');
    assert.ok(unknown.total > 0);
  } finally { db.prepare = prepare as typeof db.prepare; }
});

test('coding work outliving its harness is read without initializing or changing its store', () => {
  mkdirSync(path.dirname(codingFile), { recursive: true });
  const db = new Database(codingFile);
  db.exec(`CREATE TABLE coding_runs (run_id TEXT PRIMARY KEY, session_id TEXT, state TEXT,
    lease_owner TEXT, lease_expires_at_ms INTEGER);
    INSERT INTO coding_runs VALUES ('controlled-running', 'coding-controlled', 'detached', NULL, NULL);
    INSERT INTO coding_runs VALUES ('controlled-settled', 'coding-settled', 'settled', 'old', 9999999999999);`);
  db.close();
  const bytes = readFileSync(codingFile);
  const mtime = statSync(codingFile).mtimeMs;
  const snapshot = readInstallQuiescence();
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.currentWork.items[0]?.kind, 'coding');
  assert.equal(snapshot.currentWork.items[0]?.state, 'unfinished');
  assert.deepEqual(readFileSync(codingFile), bytes);
  assert.equal(statSync(codingFile).mtimeMs, mtime);
});

test('corrupt coding storage or missing existing machine identity is unverified and never repaired', () => {
  mkdirSync(path.dirname(codingFile), { recursive: true });
  writeFileSync(codingFile, 'not a sqlite database');
  assert.equal(readInstallQuiescence().quiescence.state, 'unverified');
  rmSync(machineIdFile);
  const missing = readInstallQuiescence();
  assert.equal(missing.quiescence.state, 'unverified');
  assert.equal(existsSync(machineIdFile), false, 'the observational probe cannot initialize device identity');
});

test('a physically pending effect cannot disappear when the source audit has no qualifying evidence', () => {
  const session = events.createSession({ kind: 'chat' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { synthetic: true, text: 'Controlled legacy control source.' } });
  const db = events.openEventLog();
  const prepare = db.prepare.bind(db);
  // Deliberately incomplete retained inventory read: today's crossing trigger
  // correctly forbids creating this missing-logical-parent shape as new work.
  db.prepare = ((sql: string) => sql.includes("FROM physical_dispatches WHERE state IN ('started', 'unknown')")
    ? { all: () => [{ session_id: session.id, source_user_seq: source.seq }] }
    : prepare(sql)) as typeof db.prepare;
  try {
    const snapshot = readInstallQuiescence();
    assert.ok(snapshot.total > 0);
    assert.equal(snapshot.quiescence.state, 'unverified');
    assert.equal(snapshot.currentWork.items[0]?.state, 'uncertain');
  } finally { db.prepare = prepare as typeof db.prepare; }
});

test('a retired attempt cannot hide a returned/failed physical crossing whose logical call is still open', () => {
  for (const state of ['returned', 'threw', 'timed_out', 'cancelled']) {
    const accepted = attempt();
    const identity = { sessionId: accepted.session.id, sourceUserSeq: accepted.source.seq,
      acceptedTaskId: `task:${accepted.session.id}#${accepted.source.seq}`, logicalToolCallId: `controlled-call:${state}` };
    assert.ok(shadow.recordTurnGraphShadow({ identity: { sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq, turn: accepted.source.turn } }));
    const tool = 'alpha__records_create';
    const args = { value: 'controlled fixture only' };
    assert.equal(ledger.admitLogicalCall({ identity, tool, args }).status, 'inserted');
    const material = contracts.durableLogicalCallRecoveryMaterial(identity.acceptedTaskId, tool, args);
    assert.ok(material);
    const parent = leases.activateDispatchLease({ sessionId: identity.sessionId, scopeId: `${identity.sessionId}:parent` });
    const call = leases.activateDispatchLease({ sessionId: identity.sessionId, scopeId: `${identity.sessionId}:call`,
      parentLease: parent, sourceUserSeq: identity.sourceUserSeq, acceptedTaskId: identity.acceptedTaskId,
      logicalToolCallId: identity.logicalToolCallId, recovery: { effect: effects.classifyRuntimeToolEffect(tool, args).effect,
        businessCall: true, material, turn: accepted.source.turn } });
    assert.equal(ledger.beginPhysicalDispatch({ identity: { ...identity, physicalDispatchId: `controlled-crossing:${state}`, ordinal: 0 },
      tool, args, executionSite: 'host', dispatchLease: call }).status, 'inserted');
    // Stop at the real crash window between physical return and logical
    // settlement. This is retained test state; no provider body is invoked.
    events.openEventLog().prepare('UPDATE physical_dispatches SET state = ? WHERE session_id = ?').run(state, identity.sessionId);
    leases.revokeDispatchLease(call); leases.revokeDispatchLease(parent);
    events.finishRunAttempt(accepted.run, 'interrupted');
    const snapshot = readInstallQuiescence();
    assert.ok(snapshot.total > 0, state);
    assert.ok(snapshot.currentWork.items.some(owner => owner.state === 'uncertain'
      && owner.sessionIds.includes(identity.sessionId)), state);
  }
});

test('a fresh timestamp-only in-flight marker is unknown work, never quiet zero', () => {
  events.createSession({ kind: 'chat', metadata: { __run_in_flight: new Date().toISOString() } });
  const snapshot = readInstallQuiescence();
  assert.equal(snapshot.quiescence.state, 'unverified');
  assert.ok(snapshot.quiescence.issues.includes('checkpoint_owner_unverified'));
  assert.equal(snapshot.currentWork.total, 0);
  assert.ok(snapshot.total > 0);
});

test('separate parked decisions in one chat are not deduplicated merely by session', () => {
  const session = events.createSession({ kind: 'chat' });
  approvals.register({ sessionId: session.id, subject: 'First controlled decision', tool: 'controlled-first', args: { key: 'first' } });
  approvals.register({ sessionId: session.id, subject: 'Second controlled decision', tool: 'controlled-second', args: { key: 'second' } });
  const snapshot = readInstallQuiescence();
  assert.equal(snapshot.currentWork.total, 2);
  assert.equal(new Set(snapshot.currentWork.items.map(item => item.key)).size, 2);
});

test('corrupt workflow/background records and malformed owner metadata are explicitly unverified', () => {
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'corrupt-run.json'), '{');
  writeFileSync(path.join(backgroundDir, 'corrupt-task.json'), '{');
  const session = events.createSession({ kind: 'agent' });
  events.openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run('{', session.id);
  const snapshot = readInstallQuiescence();
  assert.equal(snapshot.quiescence.state, 'unverified');
  assert.equal(snapshot.currentWork.total, 0, 'unknown evidence is not labeled an actual running owner');
  assert.equal(snapshot.total, 1, 'legacy native updater receives a conservative warning');
  assert.match(snapshot.summary, /could not be fully verified/);
  assert.ok(snapshot.quiescence.issues.includes('workflow_record_unreadable'));
  assert.ok(snapshot.quiescence.issues.includes('background_record_unreadable'));
  assert.ok(snapshot.quiescence.issues.includes('session_owner_metadata_unreadable'));
});

test('a partial bounded inventory and an unavailable ownership query never become quiet zero', () => {
  attempt(); attempt();
  const partial = readInstallQuiescence({ maxEntries: 1 });
  assert.equal(partial.quiescence.state, 'unverified');
  assert.ok(partial.quiescence.issues.includes('attempt_inventory_partial'));
  const db = events.openEventLog();
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    if (sql.includes('FROM run_attempts WHERE finished_at IS NULL')) throw new Error('controlled storage failure');
    return prepare(sql);
  }) as typeof db.prepare;
  try {
    const unavailable = readInstallQuiescence();
    assert.equal(unavailable.quiescence.state, 'unverified');
    assert.ok(unavailable.total > 0);
    assert.ok(unavailable.quiescence.issues.includes('execution_inventory_unreadable'));
  } finally { db.prepare = prepare as typeof db.prepare; }
});
