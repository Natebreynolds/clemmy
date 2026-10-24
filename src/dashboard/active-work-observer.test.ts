/** Actual read-only workers over disposable fixtures; no provider or live-home calls. */
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { buildSync } from 'esbuild';
import { ACTIVE_WORK_OBSERVER_LIMITS as observerLimits, observationIdentityDigest, observationFailureIssue,
  policyMapDigest, type ObservationIdentity, type ObserverToMain } from './active-work-observer-protocol.js';
import { HARNESS_SCHEMA_VERSION } from '../runtime/harness/schema-version.js';
import { HostRecoveryState } from '../runtime/harness/host-checkpoint-state.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-active-work-worker-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true' });
mkdirSync(path.join(home, 'state'), { recursive: true });
const events = await import('../runtime/harness/eventlog.js');
const { createActiveWorkObserver, resolveActiveWorkWorkerEntry } = await import('./active-work-observer.js');
const { readInstallQuiescence } = await import('./install-quiescence.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const shadow = await import('../runtime/graph/turn-graph-shadow.js');
const ledger = await import('../runtime/harness/dispatch-ledger.js');
const leases = await import('../runtime/harness/dispatch-lease.js');
const contracts = await import('../runtime/harness/logical-call-contract.js');
const effects = await import('../runtime/harness/tool-effect.js');
const { auditAcceptedSourceSettlementTruth } = await import('../runtime/harness/accepted-source-settlement-audit.js');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const workerEntry = new URL('./active-work-observer.worker.ts', import.meta.url);
const codingBase = path.join(home, 'state', 'coding-runs');
const machineFile = path.join(home, 'state', 'machine-id');
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const observer = () => createActiveWorkObserver({ baseDir: home, workflowDir: WORKFLOW_RUNS_DIR, schema: HARNESS_SCHEMA_VERSION });
beforeEach(() => {
  events.resetEventLog();
  events.openEventLog(); // Initialize this disposable fixture, never in the read-only worker.
  rmSync(codingBase, { recursive: true, force: true }); rmSync(machineFile, { force: true });
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true }); mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
});
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

test('closed identity digest ignores key order but rejects changed nonce/artifact and extra fields', () => {
  const identity: ObservationIdentity = { nonce: 'controlled', epoch: 'epoch', build: 'build', baseDir: '/controlled/home',
    workflowDir: '/controlled/home/runs', schema: 97, requestedAt: 1, deadline: 2,
    artifacts: [{ file: '/controlled/worker.js', generation: '1:2:3:4:5', digest: 'a'.repeat(64) }] };
  const shuffled = Object.fromEntries(Object.entries(identity).reverse()) as unknown as ObservationIdentity;
  shuffled.artifacts = [Object.fromEntries(Object.entries(identity.artifacts[0]).reverse()) as unknown as ObservationIdentity['artifacts'][number]];
  assert.equal(observationIdentityDigest(shuffled), observationIdentityDigest(identity));
  assert.notEqual(observationIdentityDigest({ ...identity, nonce: 'foreign' }), observationIdentityDigest(identity));
  assert.notEqual(observationIdentityDigest({ ...identity, artifacts: [{ ...identity.artifacts[0], digest: 'b'.repeat(64) }] }), observationIdentityDigest(identity));
  assert.throws(() => observationIdentityDigest({ ...identity, unknown: true } as ObservationIdentity), /observation_identity/);
  assert.throws(() => observationIdentityDigest({ ...identity, artifacts: [{ ...identity.artifacts[0], unknown: true }] } as ObservationIdentity), /observation_identity/);
});

test('actual RO worker preserves current owners and302 historical compatibility rows without writing the DB', async () => {
  for (let index = 0; index < 302; index++) events.createSession({ kind: 'workflow', metadata: {
    workflowRunId: `historical-${index}`, workflowName: 'controlled-history', stepId: 'old-step' } });
  const session = events.createSession({ kind: 'chat' });
  const attempt = events.beginRunAttempt(session.id, { runId: 'controlled-current-owner' });
  events.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'Controlled worker inventory.' } });
  const canonical = readInstallQuiescence();
  const file = path.join(home, 'state', 'harness.db'); const before = digest(file);
  const result = await observer().read();
  assert.equal(result.quiescence.state, 'work_pending');
  assert.deepEqual(result.currentWork, canonical.currentWork);
  assert.equal(result.activeSessions, 302);
  assert.equal(result.items.length, 302);
  assert.equal(digest(file), before, 'the worker does not initialize, migrate or repair this database');
});

function controlledMetadataCheckpoint(bytes: number, index: number) {
  const session = events.createSession({ kind: 'execution', title: `Controlled metadata owner ${index}` });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Controlled retained metadata objective.' } });
  const state = new HostRecoveryState(session.id, source.seq, 'continue', [], [], [], undefined, undefined,
    'host_v1', undefined, 0, { sessionId: session.id, sourceUserSeq: source.seq,
      acceptedTaskId: `task:${session.id}#${source.seq}`, batchOrdinal: 1, batchId: 'a'.repeat(64), authorityDigest: 'b'.repeat(64) });
  events.openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run(JSON.stringify({
    __host_recovery_state: state.toString(), __continuation_owner: { sourceUserSeq: source.seq },
    controlledPrivateMetadata: 'x'.repeat(bytes),
  }), session.id);
  return session;
}

test('one observation reuses exact large session metadata across owners, recovery and compatibility display', async () => {
  for (let index = 0; index < 10; index++) controlledMetadataCheckpoint(650_000, index);
  const canonical = readInstallQuiescence();
  assert.equal(canonical.quiescence.state, 'work_pending'); assert.equal(canonical.currentWork.total, 10);
  const file = path.join(home, 'state', 'harness.db'); const before = digest(file);
  const result = await observer().read();
  assert.equal(result.quiescence.state, canonical.quiescence.state, JSON.stringify(result.quiescence.issues));
  assert.deepEqual(result.currentWork, canonical.currentWork);
  assert.deepEqual(result.quiescence.issues, canonical.quiescence.issues);
  assert.equal(result.activeSessions, 10); assert.equal(result.items.length, 10);
  assert.equal(JSON.stringify(result).includes('controlledPrivateMetadata'), false);
  assert.equal(digest(file), before, 'reuse does not mutate or normalize retained metadata');
});

test('unique required session metadata still exceeds the unchanged total byte bound', async () => {
  for (let index = 0; index < 30; index++) controlledMetadataCheckpoint(850_000, index);
  const result = await observer().read();
  assert.equal(result.quiescence.state, 'unverified'); assert.ok(result.total >= 1);
  assert.deepEqual(result.quiescence.issues, ['active_work_observation_total_bytes_bound']);
  assert.equal(result.activityAvailable, false); assert.deepEqual(result.currentWork.items, []);
});

test('metadata reuse preserves malformed holds and observes changed bytes on the next observation', async () => {
  const session = controlledMetadataCheckpoint(100_000, 0);
  const service = observer();
  const first = await service.read();
  assert.equal(first.quiescence.state, 'work_pending'); assert.equal(first.currentWork.total, 1);
  events.openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run('{controlled-private-malformed', session.id);
  const malformed = await service.read();
  assert.equal(malformed.quiescence.state, 'unverified'); assert.ok(malformed.total >= 1);
  assert.equal(JSON.stringify(malformed).includes('controlled-private-malformed'), false);
  events.openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run('{}', session.id);
  const cleared = await service.read();
  assert.equal(cleared.quiescence.state, 'quiescent'); assert.equal(cleared.currentWork.total, 0);
  assert.equal(cleared.activeSessions, 1, 'compatibility membership is independent of the former checkpoint');
});

for (const status of ['running', 'completed'] as const) test(`workflow display reuses large exact metadata for a ${status} parent`, async () => {
  const runId = 'controlled-large-workflow-parent';
  const outputs: Record<string, { ok: boolean }> = {};
  for (let index = 0; index < 10; index++) {
    const stepId = `read-${index}`; outputs[stepId] = { ok: true };
    const child = events.createSession({ kind: 'workflow', metadata: { workflowRunId: runId,
      workflowName: 'controlled-large-workflow', stepId, controlledPrivateMetadata: 'x'.repeat(1_300_000) } });
    events.appendEvent({ sessionId: child.id, turn: 1, role: 'tool', type: 'tool_returned',
      data: { tool: 'read_file', ok: true } });
  }
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({ id: runId,
    workflow: 'controlled-large-workflow', status, finishedAt: new Date().toISOString(), stepOutputs: outputs }));
  const canonical = readInstallQuiescence();
  assert.equal(canonical.quiescence.state, status === 'running' ? 'work_pending' : 'quiescent');
  const file = path.join(home, 'state', 'harness.db'); const before = digest(file);
  const result = await observer().read();
  assert.equal(result.quiescence.state, canonical.quiescence.state, JSON.stringify(result.quiescence.issues));
  assert.deepEqual(result.currentWork, canonical.currentWork);
  assert.deepEqual(result.quiescence.issues, canonical.quiescence.issues);
  assert.equal(result.activeSessions, status === 'running' ? 10 : 0);
  assert.equal(result.items.length, result.activeSessions);
  assert.equal(JSON.stringify(result).includes('controlledPrivateMetadata'), false);
  assert.equal(digest(file), before);
});

test('new requests during an observation await a fresh followup and completed idle is never reused', async () => {
  const service = observer();
  const first = service.read();
  const acceptedAt = Date.now();
  const second = service.read(); const third = service.read();
  assert.equal(second, third, 'one coalesced followup, not one worker per concurrent request');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.quiescence.state, 'quiescent'); assert.equal(b.quiescence.state, 'quiescent');
  assert.ok(Date.parse(b.quiescence.observedAt) >= acceptedAt);
  assert.ok(Date.parse(b.quiescence.observedAt) > Date.parse(a.quiescence.observedAt));
  const laterAt = Date.now(); const later = await service.read();
  assert.ok(Date.parse(later.quiescence.observedAt) >= laterAt);
});

test('main event loop remains available during the whole filesystem inventory', async () => {
  for (let index = 0; index < 600; index++) writeFileSync(path.join(WORKFLOW_RUNS_DIR, `controlled-${index}.json`), JSON.stringify({
    id: `controlled-${index}`, workflow: 'controlled-workflow', status: 'completed', finishedAt: '2026-01-01T00:00:00Z',
    stepOutputs: { controlled: 'x'.repeat(2_000) } }));
  let ticks = 0; const timer = setInterval(() => { ticks++; }, 2);
  try {
    const result = await observer().read();
    assert.equal(result.quiescence.state, 'quiescent');
    assert.ok(ticks >= 3, 'filesystem+DB observation runs off the daemon event loop');
  } finally { clearInterval(timer); }
});

function controlledCrossing(args: Record<string, unknown>) {
  const session = events.createSession({ kind: 'chat' });
  const run = events.beginRunAttempt(session.id, { runId: 'controlled-filtered-event-owner' });
  const source = events.recordRunAttemptUserInput(run, { turn: 1, role: 'user', data: { text: 'Controlled retained effect.' } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq,
    acceptedTaskId: `task:${session.id}#${source.seq}`, logicalToolCallId: 'controlled-filtered-call' };
  assert.ok(shadow.recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn } }));
  const tool = 'alpha__records_create';
  assert.equal(ledger.admitLogicalCall({ identity, tool, args }).status, 'inserted');
  const material = contracts.durableLogicalCallRecoveryMaterial(identity.acceptedTaskId, tool, args); assert.ok(material);
  const parent = leases.activateDispatchLease({ sessionId: session.id, scopeId: session.id + ':parent' });
  const call = leases.activateDispatchLease({ sessionId: session.id, scopeId: session.id + ':call', parentLease: parent,
    sourceUserSeq: source.seq, acceptedTaskId: identity.acceptedTaskId, logicalToolCallId: identity.logicalToolCallId,
    recovery: { effect: effects.classifyRuntimeToolEffect(tool, args).effect, businessCall: true, material, turn: source.turn } });
  assert.equal(ledger.beginPhysicalDispatch({ identity: { ...identity, physicalDispatchId: 'controlled-filtered-crossing', ordinal: 0 },
    tool, args, executionSite: 'host', dispatchLease: call }).status, 'inserted');
  leases.revokeDispatchLease(call); leases.revokeDispatchLease(parent);
  events.appendEvent({ sessionId: session.id, turn: 1, role: 'assistant', type: 'tool_called',
    data: { tool, arguments: args, sourceUserSeq: source.seq, acceptedTaskId: identity.acceptedTaskId,
      canonicalCallId: identity.logicalToolCallId } });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

test('actual worker excludes oversized unrelated history and reuses the full required audit window', async () => {
  const source = controlledCrossing({ value: 'controlled required argument' });
  const db = events.openEventLog();
  const insert = db.prepare(`INSERT INTO events (id,session_id,turn,role,type,data_json,created_at)
    VALUES (?, ?, 1, 'assistant', ?, ?, '2026-01-01T00:00:00Z')`);
  const required = JSON.stringify({ accounting: 'top_level', sourceUserSeq: source.sourceUserSeq,
    successfulBusinessResult: true, result: 'controlled-required-result:' + 'x'.repeat(30_000) });
  assert.ok(Buffer.byteLength(required) * 450 > observerLimits.totalBytes / 2,
    'decoding this required window separately in preflight and audit would exceed the unchanged budget');
  db.transaction(() => {
    for (let index = 0; index < 450; index++) insert.run(`required-${index}`, source.sessionId, 'tool_returned', required);
  })();
  const originalAudit = auditAcceptedSourceSettlementTruth(source);
  assert.equal(originalAudit.status, 'in_flight'); assert.equal(originalAudit.facts.successfulSdkBusinessResults, 450);
  const originalInventory = readInstallQuiescence();
  assert.equal(originalInventory.quiescence.state, 'work_pending');
  const beforeHistory = await observer().read();
  assert.equal(beforeHistory.quiescence.state, 'work_pending');
  assert.deepEqual(beforeHistory.currentWork, originalInventory.currentWork);

  const unrelated = JSON.stringify({ text: 'controlled-private-unrelated-history:' + 'x'.repeat(64_000) });
  assert.ok(Buffer.byteLength(unrelated) * 400 > observerLimits.totalBytes);
  db.transaction(() => {
    for (let index = 0; index < 400; index++) insert.run(`unrelated-${index}`, source.sessionId, 'conversation_check_in', unrelated);
  })();
  assert.deepEqual(auditAcceptedSourceSettlementTruth(source), originalAudit,
    'unrelated presentation events do not change the canonical settlement audit');
  const canonical = readInstallQuiescence();
  assert.deepEqual(canonical.currentWork, originalInventory.currentWork);
  const file = path.join(home, 'state', 'harness.db'); const before = digest(file);
  const result = await observer().read();
  assert.equal(result.quiescence.state, 'work_pending');
  assert.deepEqual(result.currentWork, canonical.currentWork);
  assert.equal(result.total, canonical.total); assert.deepEqual(result.quiescence.issues, canonical.quiescence.issues);
  assert.deepEqual(result.items, beforeHistory.items);
  assert.equal(JSON.stringify(result).includes('controlled-private-unrelated-history'), false);
  assert.equal(digest(file), before);
});

test('required tool arguments remain fully bounded when unrelated event types are excluded', async () => {
  controlledCrossing({ value: 'controlled-required-argument:' + 'x'.repeat(observerLimits.policyItemBytes + 1) });
  const result = await observer().read();
  assert.equal(result.quiescence.state, 'unverified'); assert.ok(result.total >= 1);
  assert.deepEqual(result.quiescence.issues, ['active_work_observation_policy_item_bytes_bound']);
  assert.equal(result.activityAvailable, false); assert.deepEqual(result.currentWork.items, []);
  assert.equal(JSON.stringify(result).includes('controlled-required-argument'), false);
});

function appendDistinctPolicyCalls(source: { sessionId: string; sourceUserSeq: number }) {
  const db = events.openEventLog();
  const insert = db.prepare(`INSERT INTO events (id,session_id,turn,role,type,data_json,created_at)
    VALUES (?, ?, 2, 'assistant', 'tool_called', ?, '2026-01-01T00:00:00Z')`);
  db.transaction(() => {
    for (let index = 0; index <= observerLimits.policyInputs; index++) insert.run(`controlled-policy-${index}`, source.sessionId,
      JSON.stringify({ tool: 'alpha__records_create', arguments: { value: `controlled-private-policy-${index}` },
        sourceUserSeq: source.sourceUserSeq, acceptedTaskId: `task:${source.sessionId}#${source.sourceUserSeq}` }));
  })();
}

test('policy preflight scopes source A before later B inputs while retaining exact late A write evidence', async () => {
  const sourceA = controlledCrossing({ value: 'controlled source A argument' });
  const sourceB = events.appendEvent({ sessionId: sourceA.sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Controlled later source B.' } });
  const attribution = { sourceUserSeq: sourceA.sourceUserSeq, acceptedTaskId: `task:${sourceA.sessionId}#${sourceA.sourceUserSeq}`,
    canonicalCallId: 'controlled-filtered-call', shapeKey: 'UPDATE_RECORD', targets: ['controlled-record:A'] };
  const reservation = events.appendEvent({ sessionId: sourceA.sessionId, turn: 1, role: 'system', type: 'external_write',
    data: { ...attribution, preDispatch: true } });
  events.appendEvent({ sessionId: sourceA.sessionId, turn: 1, role: 'system', type: 'external_write_succeeded',
    parentEventId: reservation.id, data: attribution });
  const audit = auditAcceptedSourceSettlementTruth(sourceA);
  assert.equal(audit.status, 'in_flight'); assert.equal(audit.facts.confirmedWrites, 1);
  const canonical = readInstallQuiescence();
  assert.equal(canonical.quiescence.state, 'work_pending');
  const beforeLaterInputs = await observer().read();
  assert.deepEqual(beforeLaterInputs.currentWork, canonical.currentWork);
  assert.equal(beforeLaterInputs.quiescence.state, 'work_pending');
  appendDistinctPolicyCalls({ sessionId: sourceA.sessionId, sourceUserSeq: sourceB.seq });
  assert.deepEqual(auditAcceptedSourceSettlementTruth(sourceA), audit);
  assert.deepEqual(readInstallQuiescence().currentWork, canonical.currentWork);
  const file = path.join(home, 'state', 'harness.db'); const before = digest(file);
  const result = await observer().read();
  assert.deepEqual(result.quiescence.issues, canonical.quiescence.issues);
  assert.equal(result.quiescence.state, 'work_pending'); assert.equal(result.total, canonical.total);
  assert.deepEqual(result.currentWork, canonical.currentWork); assert.deepEqual(result.items, beforeLaterInputs.items);
  assert.equal(JSON.stringify(result).includes('controlled-private-policy'), false);
  assert.equal(digest(file), before);
});

test('excessive policy inputs required by the current accepted source still refuse verification', async () => {
  const source = controlledCrossing({ value: 'controlled current source' });
  appendDistinctPolicyCalls(source);
  const result = await observer().read();
  assert.equal(result.quiescence.state, 'unverified'); assert.ok(result.total >= 1);
  assert.deepEqual(result.quiescence.issues, ['active_work_observation_policy_inputs_bound']);
  assert.equal(result.activityAvailable, false); assert.deepEqual(result.currentWork.items, []);
});

test('non-user workflow source retains its typed owner hold without a chat-source failure', async () => {
  const source = controlledCrossing({ value: 'controlled workflow evidence' });
  // This disposable retained ledger is not workflow execution authority. Its
  // system activation must remain held by the canonical workflow-owner branch.
  events.openEventLog().prepare("UPDATE events SET role = 'system', type = 'workflow_node_invocation_activated' WHERE seq = ?")
    .run(source.sourceUserSeq);
  const canonical = readInstallQuiescence();
  assert.ok(canonical.quiescence.issues.includes('workflow_effect_owner_unverified'));
  const result = await observer().read();
  assert.equal(result.quiescence.state, 'unverified'); assert.ok(result.total >= 1);
  assert.deepEqual(result.currentWork, canonical.currentWork);
  assert.deepEqual(result.quiescence.issues, canonical.quiescence.issues);
  assert.ok(!result.quiescence.issues.includes('active_work_observation_unverified'));
  assert.ok(!result.quiescence.issues.includes('effect_evidence_unreadable'));
});

test('actual worker caps record bytes and all directory entries without returning idle', async () => {
  const dbFile = path.join(home, 'state', 'harness.db'); const before = digest(dbFile);
  for (let index = 0; index <= observerLimits.files; index++) writeFileSync(path.join(WORKFLOW_RUNS_DIR, `partial-${index}.json`), JSON.stringify({
    id: `partial-${index}`, workflow: 'controlled', status: 'running' }));
  const partial = await observer().read();
  assert.equal(partial.quiescence.state, 'unverified'); assert.ok(partial.total >= 1);
  assert.deepEqual(partial.quiescence.issues, ['active_work_observation_files_bound']);
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true }); mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'too-large.json'), 'x'.repeat(observerLimits.fileBytes + 1));
  const bytes = await observer().read();
  assert.equal(bytes.quiescence.state, 'unverified'); assert.ok(bytes.total >= 1);
  assert.deepEqual(bytes.quiescence.issues, ['active_work_observation_file_bytes_bound']);
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true }); mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  for (let index = 0; index <= observerLimits.files; index++) writeFileSync(path.join(WORKFLOW_RUNS_DIR, `entry-${index}.txt`), '');
  const entries = await observer().read();
  assert.equal(entries.quiescence.state, 'unverified'); assert.ok(entries.total >= 1);
  assert.deepEqual(entries.quiescence.issues, ['active_work_observation_files_bound']);
  assert.equal(digest(dbFile), before);
});

test('a byte bound swallowed by the canonical coding reader retains only its safe reason', async () => {
  const codingFile = path.join(codingBase, 'controlled-machine', 'coding-runs.db');
  mkdirSync(path.dirname(codingFile), { recursive: true }); writeFileSync(machineFile, 'controlled-machine\n');
  const coding = new Database(codingFile);
  coding.exec('CREATE TABLE coding_runs (run_id TEXT, session_id TEXT, state TEXT, lease_owner TEXT, lease_expires_at_ms INTEGER)');
  const insert = coding.prepare("INSERT INTO coding_runs VALUES (?, ?, 'running', NULL, NULL)");
  const privateMarker = 'controlled-private-owner-text';
  coding.transaction(() => {
    for (let index = 0; index < 1_600; index++) insert.run(`controlled-${index}`, privateMarker + 'x'.repeat(16_000));
  })();
  coding.close();
  const before = digest(codingFile);
  const result = await observer().read();
  assert.equal(result.quiescence.state, 'unverified'); assert.ok(result.total >= 1);
  assert.deepEqual(result.quiescence.issues, ['active_work_observation_total_bytes_bound']);
  assert.equal(result.activityAvailable, false); assert.deepEqual(result.currentWork.items, []);
  assert.equal(JSON.stringify(result).includes(privateMarker), false);
  assert.equal(digest(codingFile), before);
});

test('unrecognized database and parse failures stay generic without private error text', async () => {
  const codingFile = path.join(codingBase, 'controlled-machine', 'coding-runs.db');
  mkdirSync(path.dirname(codingFile), { recursive: true }); writeFileSync(machineFile, 'controlled-machine\n');
  const coding = new Database(codingFile); coding.exec('CREATE TABLE controlled_private_table (value TEXT)'); coding.close();
  const before = digest(codingFile);
  const result = await observer().read();
  assert.equal(result.quiescence.state, 'unverified'); assert.ok(result.total >= 1);
  assert.deepEqual(result.quiescence.issues, ['active_work_observation_unverified']);
  assert.equal(result.activityAvailable, false);
  assert.equal(digest(codingFile), before);
  rmSync(codingBase, { recursive: true, force: true }); rmSync(machineFile);
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'controlled-private-path.json'), '{"controlled-private-text":');
  const malformed = await observer().read();
  assert.deepEqual(malformed.quiescence.issues, ['active_work_observation_unverified']);
  assert.equal(JSON.stringify(malformed).includes('controlled-private'), false);
  assert.equal(observationFailureIssue(new Error('active_work_observation_total_bytes_bound')), 'active_work_observation_unverified');
  assert.equal(observationFailureIssue({ issueCode: 'active_work_observation_total_bytes_bound' }), 'active_work_observation_unverified');
});

test('worker failure envelopes accept only finite codes and never forward a supplied snapshot', async () => {
  const fixture = mkdtempSync(path.join(home, 'controlled-failure-worker-'));
  const workerFile = path.join(fixture, 'active-work-observer.worker.ts');
  // The fixture directory sits outside the package: without its own module
  // marker the fake worker loads as CommonJS and never runs, so every case
  // fell back to the generic code and only the bounded-code case failed.
  writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
  try {
    for (const issueCode of ['active_work_observation_rows_bound', 'controlled-private-exception', undefined]) {
      writeFileSync(workerFile, `import { parentPort, workerData } from 'node:worker_threads';
        const { tsxApi, entry, ...identity } = workerData;
        parentPort.postMessage({ type: 'result', identity, policyDigest: '', issueCode: ${JSON.stringify(issueCode) ?? 'undefined'},
          snapshot: { total: 0, quiescence: { state: 'quiescent' }, privateText: 'controlled-private-snapshot' } });
        parentPort.close();`);
      const result = await createActiveWorkObserver({ baseDir: home, workflowDir: WORKFLOW_RUNS_DIR,
        schema: HARNESS_SCHEMA_VERSION, moduleUrl: pathToFileURL(path.join(fixture, 'active-work-observer.ts')).href }).read();
      assert.equal(result.quiescence.state, 'unverified'); assert.ok(result.total >= 1);
      assert.deepEqual(result.quiescence.issues, [issueCode === 'active_work_observation_rows_bound'
        ? issueCode : 'active_work_observation_unverified']);
      assert.equal(result.activityAvailable, false); assert.deepEqual(result.currentWork.items, []); assert.deepEqual(result.items, []);
      assert.equal(JSON.stringify(result).includes('controlled-private'), false);
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('worker coding inventory shares canonical read-only owners and does not initialize a missing machine database', async () => {
  const codingFile = path.join(codingBase, 'controlled-machine', 'coding-runs.db');
  mkdirSync(path.dirname(codingFile), { recursive: true }); writeFileSync(machineFile, 'controlled-machine\n');
  const coding = new Database(codingFile);
  coding.exec(`CREATE TABLE coding_runs (run_id TEXT PRIMARY KEY, session_id TEXT, state TEXT,
    lease_owner TEXT, lease_expires_at_ms INTEGER);
    INSERT INTO coding_runs VALUES ('controlled-running', 'coding-controlled', 'detached', NULL, NULL);
    INSERT INTO coding_runs VALUES ('controlled-settled', 'coding-settled', 'settled', 'old', 9999999999999)`);
  coding.close();
  const before = digest(codingFile); const canonical = readInstallQuiescence();
  const active = await observer().read();
  assert.equal(active.quiescence.state, 'work_pending'); assert.deepEqual(active.currentWork, canonical.currentWork);
  assert.equal(active.currentWork.items[0]?.kind, 'coding'); assert.equal(digest(codingFile), before);
  rmSync(codingFile); const absent = await observer().read();
  assert.equal(absent.quiescence.state, 'quiescent'); assert.equal(existsSync(codingFile), false);
  writeFileSync(machineFile, 'x'.repeat(1_025)); const oversized = await observer().read();
  assert.equal(oversized.quiescence.state, 'unverified'); assert.ok(oversized.total >= 1);
  assert.deepEqual(oversized.quiescence.issues, ['active_work_observation_file_bytes_bound']);
  assert.equal(existsSync(codingFile), false);
});

test('missing DB, wrong schema and deadline stay200-compatible unverified/nonzero without initialization', async () => {
  const missing = path.join(home, 'missing');
  const a = await createActiveWorkObserver({ baseDir: missing, workflowDir: path.join(missing, 'runs'), schema: HARNESS_SCHEMA_VERSION }).read();
  assert.equal(a.quiescence.state, 'unverified'); assert.ok(a.total >= 1); assert.equal(existsSync(missing), false);
  const old = path.join(home, 'old-schema'); mkdirSync(path.join(old, 'state'), { recursive: true });
  const file = path.join(old, 'state', 'harness.db'); const db = new Database(file);
  db.exec('CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(1)'); db.close();
  const before = digest(file);
  const b = await createActiveWorkObserver({ baseDir: old, workflowDir: path.join(old, 'runs'), schema: HARNESS_SCHEMA_VERSION }).read();
  assert.equal(b.quiescence.state, 'unverified'); assert.ok(b.total >= 1); assert.equal(digest(file), before);
  const c = await createActiveWorkObserver({ baseDir: home, workflowDir: WORKFLOW_RUNS_DIR, schema: HARNESS_SCHEMA_VERSION, timeoutMs: 1 }).read();
  assert.equal(c.quiescence.state, 'unverified'); assert.ok(c.total >= 1);
  assert.deepEqual(c.quiescence.issues, ['active_work_observation_deadline_bound']);
});

for (const boundary of ['filesystem', 'database', 'foreign_nonce', 'missing_policy'] as const) test(`${boundary} change after preflight cannot certify the actual worker snapshot`, async () => {
  const file = path.join(WORKFLOW_RUNS_DIR, 'controlled.json');
  writeFileSync(file, JSON.stringify({ id: 'controlled', workflow: 'controlled', status: 'completed' }));
  if (boundary === 'missing_policy') {
    const session = events.createSession({ kind: 'chat' });
    const run = events.beginRunAttempt(session.id, { runId: 'controlled-policy-owner' });
    const source = events.recordRunAttemptUserInput(run, { turn: 1, role: 'user', data: { text: 'Controlled retained effect.' } });
    const identity = { sessionId: session.id, sourceUserSeq: source.seq,
      acceptedTaskId: `task:${session.id}#${source.seq}`, logicalToolCallId: 'controlled-policy-call' };
    assert.ok(shadow.recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn } }));
    const tool = 'alpha__records_create', args = { value: 'controlled policy fixture' };
    assert.equal(ledger.admitLogicalCall({ identity, tool, args }).status, 'inserted');
    const material = contracts.durableLogicalCallRecoveryMaterial(identity.acceptedTaskId, tool, args); assert.ok(material);
    const parent = leases.activateDispatchLease({ sessionId: session.id, scopeId: session.id + ':parent' });
    const call = leases.activateDispatchLease({ sessionId: session.id, scopeId: session.id + ':call', parentLease: parent,
      sourceUserSeq: source.seq, acceptedTaskId: identity.acceptedTaskId, logicalToolCallId: identity.logicalToolCallId,
      recovery: { effect: effects.classifyRuntimeToolEffect(tool, args).effect, businessCall: true, material, turn: source.turn } });
    assert.equal(ledger.beginPhysicalDispatch({ identity: { ...identity, physicalDispatchId: 'controlled-policy-crossing', ordinal: 0 },
      tool, args, executionSite: 'host', dispatchLease: call }).status, 'inserted');
    leases.revokeDispatchLease(call); leases.revokeDispatchLease(parent);
  }
  const identity: ObservationIdentity = { nonce: 'controlled-nonce', epoch: 'controlled-epoch', build: 'controlled-build',
    baseDir: realpathSync(home), workflowDir: realpathSync(WORKFLOW_RUNS_DIR), schema: HARNESS_SCHEMA_VERSION, requestedAt: Date.now(), deadline: Date.now() + 10_000, artifacts: [] };
  const worker = new Worker(`const {workerData}=require('node:worker_threads');
    import(workerData.tsxApi).then(({register})=>{register();return import(workerData.entry)});`, {
    eval: true, workerData: { ...identity, tsxApi: import.meta.resolve('tsx/esm/api'), entry: workerEntry.href },
  });
  let result: ObserverToMain | undefined; let policyRequests = 0, candidates = 0;
  const exit = new Promise<void>((resolve, reject) => { worker.once('error', reject); worker.once('exit', code => code ? reject(new Error(`worker exit ${code}`)) : resolve()); });
  worker.on('message', (message: ObserverToMain) => {
    if (message.type === 'policy') {
      policyRequests++;
      if (boundary === 'missing_policy') assert.ok(message.inputs.length > 0, 'actual retained crossing needs a nonempty canonical policy map');
      else assert.deepEqual(message.inputs, []);
      if (boundary === 'filesystem') writeFileSync(file, JSON.stringify({ id: 'controlled', workflow: 'controlled', status: 'running' }));
      if (boundary === 'database') events.createSession({ kind: 'chat', title: 'Controlled mid-snapshot arrival' });
      worker.postMessage({ type: 'policy', identity: boundary === 'foreign_nonce' ? { ...identity, nonce: 'foreign' } : identity,
        values: [], policyDigest: policyMapDigest(message.inputs, []) });
    } else if (message.type === 'candidate') { candidates++; worker.postMessage({ type: 'validate', identity, policyDigest: message.policyDigest }); }
    else result = message;
  });
  await exit;
  assert.equal(policyRequests, 1, 'the actual worker reached policy preflight before the intended rejection');
  assert.equal(candidates, boundary === 'filesystem' || boundary === 'database' ? 1 : 0, 'drift is checked after a real candidate; malformed policy is rejected before one');
  assert.equal(result?.type, 'result');
  if (result?.type === 'result') { assert.equal(result.snapshot.quiescence.state, 'unverified'); assert.ok(result.snapshot.total >= 1); }
});

test('actual bundled service resolves the built distributed worker, with no application imports in worker closure', async () => {
  const packed = mkdtempSync(path.join(os.tmpdir(), 'clem-active-work-packed-'));
  try {
    const dist = path.join(packed, 'dist'); const emitted = path.join(dist, 'runtime/harness/implementation-artifacts/emitted');
    mkdirSync(path.join(dist, 'dashboard'), { recursive: true }); mkdirSync(emitted, { recursive: true });
    writeFileSync(path.join(packed, 'package.json'), '{"type":"module"}');
    symlinkSync(path.join(repo, 'node_modules'), path.join(packed, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(path.join(dist, 'runtime/build-stamp.json'), JSON.stringify({ gitSha: 'controlled-package-fixture', gitDirty: false,
      sourceFingerprint: 'a'.repeat(64), expectedSchemaVersion: HARNESS_SCHEMA_VERSION }));
    const builtWorker = path.join(dist, 'dashboard/active-work-observer.worker.js');
    const graph = buildSync({ entryPoints: [fileURLToPath(workerEntry)], outfile: builtWorker, bundle: true,
      platform: 'node', format: 'esm', packages: 'external', metafile: true, logLevel: 'silent' });
    for (const input of Object.keys(graph.metafile!.inputs)) {
      assert.doesNotMatch(input.replaceAll('\\', '/'), /\/(?:config|eventlog|eventlog-schema|tool-effect|confirm-first-gate|grounding-gate|resolved-call-authority)\.ts$/);
      assert.doesNotMatch(input.replaceAll('\\', '/'), /\/(?:tools\/shared|execution\/background-tasks|runtime\/notifications)\.ts$/);
    }
    const service = path.join(emitted, 'controlled-observer.cjs');
    buildSync({ entryPoints: [fileURLToPath(new URL('./active-work-observer.ts', import.meta.url))], outfile: service,
      bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
      banner: { js: 'var import_meta_url=require("node:url").pathToFileURL(__filename).href;' }, define: { 'import.meta.url': 'import_meta_url' } });
    const loaded = createRequire(import.meta.url)(service) as typeof import('./active-work-observer.js');
    assert.equal(fileURLToPath(loaded.resolveActiveWorkWorkerEntry(pathToFileURL(service).href)), builtWorker);
    const result = await loaded.createActiveWorkObserver({ baseDir: home, workflowDir: WORKFLOW_RUNS_DIR, schema: HARNESS_SCHEMA_VERSION }).read();
    assert.equal(result.quiescence.state, 'quiescent', 'the actual emitted-location service starts the built JS worker');
  } finally { rmSync(packed, { recursive: true, force: true }); }
});

test('a directly selected home symlink is refused while a missing optional workflow directory remains observable', async () => {
  const linked = path.join(home, 'home-link');
  symlinkSync(home, linked, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const rejected = await createActiveWorkObserver({ baseDir: linked, workflowDir: WORKFLOW_RUNS_DIR, schema: HARNESS_SCHEMA_VERSION }).read();
    assert.equal(rejected.quiescence.state, 'unverified'); assert.ok(rejected.total >= 1);
    const absent = path.join(home, 'not-yet-created', 'runs');
    const accepted = await createActiveWorkObserver({ baseDir: home, workflowDir: absent, schema: HARNESS_SCHEMA_VERSION }).read();
    assert.equal(accepted.quiescence.state, 'quiescent'); assert.equal(existsSync(absent), false);
  } finally { rmSync(linked, { force: true }); }
});

test('unsupported packaged location cannot silently fall back to a development worker', () => {
  assert.throws(() => resolveActiveWorkWorkerEntry(pathToFileURL('/controlled/package/unknown.cjs').href), /entry_unavailable/);
});
