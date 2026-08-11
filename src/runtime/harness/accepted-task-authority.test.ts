import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-accepted-authority-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-accepted-authority\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const resolution = await import('./resolution-ledger.js');
const manifests = await import('./obligation-manifest.js');
const authority = await import('./accepted-task-authority.js');
const workAdmission = await import('./expected-work-admission.js');
const workContracts = await import('./expected-work-contract.js');
const dispatch = await import('./dispatch-ledger.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function accept(text = 'Hello, how are you?') {
  const session = eventlog.createSession({ id: `accepted-authority-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
}

function acceptWithGraph(text = 'Hello, how are you?') {
  const task = accept(text);
  const graphEvent = shadow.recordTurnGraphShadow({ identity: task });
  assert.ok(graphEvent, 'fixture graph persisted');
  const expected = resolution.expectedTaskFor(task.sessionId, task.sourceUserSeq);
  assert.equal(expected.status, 'ok');
  if (expected.status !== 'ok') throw new Error(expected.reason);
  return { ...task, graphEvent, expected };
}

function readyConversationManifest(task: ReturnType<typeof acceptWithGraph>) {
  assert.equal(task.expected.expectation.workKind, 'conversation');
  assert.equal(resolution.finalizeResolution(task), true);
  const compiled = manifests.compileObligationManifest({ graph: task.expected.graph });
  assert.deepEqual(compiled.validation.errors, []);
  assert.equal(compiled.manifest.readiness, 'ready');
  assert.equal(compiled.manifest.nodes.length, 0);
  return compiled.manifest;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function selfAddressManifest(
  body: Omit<manifests.ObligationManifest, 'manifestId'>,
): manifests.ObligationManifest {
  const digest = createHash('sha256').update(canonical({
    version: body.version,
    mode: body.mode,
    readiness: body.readiness,
    identity: body.identity,
    graphId: body.graphId,
    graphHash: body.graphHash,
    nodes: body.nodes,
    edges: body.edges,
  })).digest('hex');
  return { ...body, manifestId: `manifest:v1:${digest}` };
}

test('a current source cannot arm without its exact persisted graph', () => {
  const task = accept('No graph was persisted for this source.');
  assert.deepEqual(authority.armAcceptedTaskAuthority(task), {
    status: 'missing',
    reason: 'no persisted turn graph for accepted task',
  });
  assert.deepEqual(authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq), {
    status: 'legacy',
  });
});

test('arming is exact, durable, idempotent, and emits one bounded mirror', () => {
  const task = acceptWithGraph();
  const first = authority.armAcceptedTaskAuthority(task);
  assert.equal(first.status, 'armed');
  if (first.status !== 'armed') return;
  assert.equal(first.authority.state, 'armed');
  assert.equal(first.authority.graphEventId, task.graphEvent.id);
  assert.equal(first.authority.graphHash, task.expected.expectation.graphHash);

  const replay = authority.armAcceptedTaskAuthority(task);
  assert.equal(replay.status, 'existing');
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['accepted_task_authority_armed'] }).length,
    1,
  );
  eventlog.closeEventLog();
  const restarted = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(restarted.status, 'ok');
  assert.equal(restarted.status === 'ok' && restarted.authority.state, 'armed');
});

test('a conflicting pre-existing marker poisons the source instead of becoming legacy', () => {
  const task = acceptWithGraph();
  const now = new Date().toISOString();
  eventlog.openEventLog().prepare(`
    INSERT INTO accepted_task_authority
      (session_id, source_user_seq, accepted_task_id, authority_protocol,
       graph_event_id, graph_id, graph_hash, state, revision,
       repair_grants_used, repair_grant_status, armed_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, 'armed', 0, 0, 'none', ?, ?)
  `).run(
    task.sessionId,
    task.sourceUserSeq,
    'task:wrong-owner#1',
    task.graphEvent.id,
    task.expected.expectation.graphId,
    task.expected.expectation.graphHash,
    now,
    now,
  );
  const result = authority.armAcceptedTaskAuthority(task);
  assert.equal(result.status, 'conflict');
  const loaded = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status === 'ok' && loaded.authority.state, 'conflict');
});

test('manifest event and armed-to-verifying CAS roll back together on storage failure', () => {
  const task = acceptWithGraph();
  assert.equal(authority.armAcceptedTaskAuthority(task).status, 'armed');
  const manifest = readyConversationManifest(task);
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER force_manifest_marker_failure
    BEFORE UPDATE OF state ON accepted_task_authority
    WHEN NEW.state = 'manifested_verifying'
    BEGIN
      SELECT RAISE(ABORT, 'forced manifest marker failure');
    END;
  `);
  const failed = authority.manifestAcceptedTaskAuthority(manifest);
  db.exec('DROP TRIGGER force_manifest_marker_failure');
  assert.equal(failed.status, 'storage_error');
  assert.match(failed.status === 'storage_error' ? failed.reason : '', /forced manifest marker failure/);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['obligation_manifest'] }).length, 0);
  const stillArmed = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(stillArmed.status === 'ok' && stillArmed.authority.state, 'armed');

  const committed = authority.manifestAcceptedTaskAuthority(manifest);
  assert.equal(committed.status, 'manifested');
  const replay = authority.manifestAcceptedTaskAuthority(manifest);
  assert.equal(replay.status, 'replayed');
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['obligation_manifest'] }).length, 1);
});

test('a self-addressed caller manifest cannot replace the exact host compilation', () => {
  const task = acceptWithGraph();
  assert.equal(authority.armAcceptedTaskAuthority(task).status, 'armed');
  const honest = readyConversationManifest(task);
  const { manifestId: _honestId, ...body } = honest;
  const forged = selfAddressManifest({
    ...body,
    nodes: [{
      nodeId: 'caller-authored/read',
      effectKind: 'read',
      reversibility: 'reversible',
      resolvedTool: 'generic_records_search',
      operationId: 'caller-authored-call',
      operationMode: 'point_read',
      obligations: ['source_observed'],
    }],
  });
  assert.equal(manifests.manifestIdMatches(forged), true, 'the forgery is internally self-addressed');

  const refused = authority.manifestAcceptedTaskAuthority(forged);
  assert.equal(refused.status, 'conflict');
  assert.match(refused.status === 'conflict' ? refused.reason : '', /host-compiled manifest/);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['obligation_manifest'] }).length, 0);
  const loaded = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status === 'ok' && loaded.authority.state, 'armed');
});

test('one durable repair grant survives restart and cannot be minted twice', () => {
  const task = acceptWithGraph();
  authority.armAcceptedTaskAuthority(task);
  const manifest = readyConversationManifest(task);
  assert.equal(authority.manifestAcceptedTaskAuthority(manifest).status, 'manifested');

  const first = authority.claimTerminalRepairGrant({
    ...task,
    manifestId: manifest.manifestId,
    missing: ['source_completeness', 'source_completeness', 'execution_terminal'],
  });
  assert.equal(first.status, 'granted');
  if (first.status !== 'granted') return;
  assert.deepEqual(first.grant.missing, ['execution_terminal', 'source_completeness']);
  eventlog.closeEventLog();
  const second = authority.claimTerminalRepairGrant({
    ...task,
    manifestId: manifest.manifestId,
    missing: ['source_completeness'],
  });
  assert.equal(second.status, 'exhausted');

  const consumed = authority.consumeTerminalRepairGrant({
    ...task,
    grantId: first.grant.grantId,
  });
  assert.equal(consumed.status, 'consumed');
  assert.equal(authority.consumeTerminalRepairGrant({
    ...task,
    grantId: first.grant.grantId,
  }).status, 'replayed');
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['terminal_authority_repair_granted'] }).length,
    1,
  );
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['terminal_authority_repair_consumed'] }).length,
    1,
  );
});

function freezeActionContract(task: ReturnType<typeof acceptWithGraph>) {
  const activated = workAdmission.activateActionExpectedWork(task);
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    `action activation failed: ${JSON.stringify(activated)}`,
  );
  const frozen = workContracts.freezeActionExpectedWorkContract({
    ...task,
    proposal: {
      version: 1,
      operations: [{
        id: 'commit',
        effect: 'external_write',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
  });
  assert.ok(
    frozen.status === 'fixed' || frozen.status === 'replayed',
    `action contract freeze failed: ${JSON.stringify(frozen)}`,
  );
  if (frozen.status !== 'fixed' && frozen.status !== 'replayed') {
    throw new Error('action contract did not freeze');
  }
  return frozen.contract;
}

test('an armed action can claim its one presentation repair against the immutable work contract', () => {
  const task = acceptWithGraph('Send the final report to the customer.');
  const contract = freezeActionContract(task);

  const claimed = authority.claimTerminalRepairGrant({
    ...task,
    missing: ['verify_committed_receipt'],
  });
  assert.equal(claimed.status, 'granted', JSON.stringify(claimed));
  if (claimed.status !== 'granted') return;
  assert.equal(claimed.grant.anchorKind, 'work_contract');
  assert.equal(claimed.grant.anchorId, contract.contractId);
  assert.equal(claimed.grant.workContractId, contract.contractId);
  assert.equal(claimed.grant.manifestId, undefined);
  assert.match(claimed.grant.missingDigest, /^[a-f0-9]{64}$/);

  const event = eventlog.listEvents(task.sessionId, {
    types: ['terminal_authority_repair_granted'],
  })[0];
  assert.equal(event?.data.anchorKind, 'work_contract');
  assert.equal(event?.data.anchorId, contract.contractId);
  assert.equal(event?.data.missingDigest, claimed.grant.missingDigest);
});

test('presentation repair cannot run while the accepted action still owns an open logical call', () => {
  const task = acceptWithGraph('Send the final report to the customer.');
  const contract = freezeActionContract(task);
  const admitted = dispatch.admitLogicalCall({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.expected.expectation.acceptedTaskId,
      logicalToolCallId: 'call:still-open',
    },
    tool: 'alpha__send_report',
    args: { destination: 'customer' },
  });
  assert.equal(admitted.status, 'inserted');

  const refused = authority.claimTerminalRepairGrant({
    ...task,
    missing: ['commit_effect'],
  });
  assert.equal(refused.status, 'not_ready');
  assert.match(refused.status === 'not_ready' ? refused.reason : '', /unsettled execution work/);
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['terminal_authority_repair_granted'] }).length,
    0,
  );
  const loaded = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status === 'ok' && loaded.authority.workContractId, contract.contractId);
  assert.equal(loaded.status === 'ok' && loaded.authority.repairGrantsUsed, 0);
});
