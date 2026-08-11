import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-write-evidence-store-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-write-evidence-store\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./expected-work-contract.js');
const admission = await import('./expected-work-admission.js');
const dispatch = await import('./dispatch-ledger.js');
const attempts = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const resolution = await import('./resolution-ledger.js');
const manifests = await import('./obligation-manifest.js');
const authority = await import('./accepted-task-authority.js');
const writeEvidence = await import('./write-evidence-store.js');
const { ExecutionStore } = await import('../../execution/store.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;
const TOOL = 'alpha__send_report';
const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    destination: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['destination', 'body'],
  additionalProperties: false,
};

interface BoundFixture {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  tool: string;
  args: { destination: string; body: string };
  bindingId: string;
  graph: import('../graph/turn-graph-ir.js').TurnGraphIR;
}

function stageBoundWrite(label: string): BoundFixture {
  const id = ++serial;
  const session = eventlog.createSession({ id: `write-evidence-${label}-${id}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the final report to the customer.' },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  const graphEvent = shadow.recordTurnGraphShadow({ identity: task });
  assert.ok(graphEvent, 'fixture graph persisted');
  const graph = graphEvent.data.graph as import('../graph/turn-graph-ir.js').TurnGraphIR;
  const activated = admission.activateActionExpectedWork(task);
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
  const fixed = contracts.freezeActionExpectedWorkContract({
    ...task,
    proposal: {
      version: 1,
      operations: [{
        id: 'send',
        effect: 'external_write',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
  });
  assert.ok(fixed.status === 'fixed' || fixed.status === 'replayed', JSON.stringify(fixed));
  const acceptedTaskId = identities.acceptedTaskIdFor(session.id, source.seq);
  const logicalToolCallId = `logical:write-evidence:${label}:${id}`;
  const args = { destination: `customer-${id}@example.test`, body: `report ${id}` };
  const logical = dispatch.admitLogicalCall({
    identity: { ...task, acceptedTaskId, logicalToolCallId },
    tool: TOOL,
    args,
  });
  assert.equal(logical.status, 'inserted', JSON.stringify(logical));
  const bound = admission.admitExpectedWorkInvocation({
    ...task,
    logicalToolCallId,
    requirementId: 'send',
    tool: TOOL,
    args,
    inputSchema: INPUT_SCHEMA,
  });
  assert.equal(bound.status, 'bound', JSON.stringify(bound));
  const frozen = writeEvidence.freezeDurableWriteEvidenceBinding({
    ...task,
    logicalToolCallId,
    writeInput: args,
    inputSchema: INPUT_SCHEMA,
    targetArgumentPointers: ['/destination'],
    reversibility: 'irreversible',
    verification: { kind: 'irreversible_receipt_v1', receiptPointer: '/data/message_id' },
  });
  assert.equal(frozen.status, 'frozen', JSON.stringify(frozen));
  if (frozen.status !== 'frozen') throw new Error(frozen.reason);
  return {
    ...task,
    acceptedTaskId,
    logicalToolCallId,
    tool: TOOL,
    args,
    bindingId: frozen.binding.bindingId,
    graph,
  };
}

function settleSuccessfulWrite(fixture: BoundFixture) {
  const physicalDispatchId = `dispatch:${fixture.logicalToolCallId}`;
  const begun = dispatch.beginPhysicalDispatch({
    identity: { ...fixture, physicalDispatchId, ordinal: 0 },
    tool: fixture.tool,
    args: fixture.args,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error(begun.reason);
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: fixture.tool,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: fixture,
    contract: { toolName: fixture.tool, args: fixture.args },
    execution: { kind: 'provider_execution' },
    result: {
      payload: { successful: true, data: { message_id: `provider-${serial}` } },
    },
    outcome: attempts.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: true, requirementId: 'send' },
    observer: { lane: 'composio', turn: fixture.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  const finalized = resolution.finalizeResolutionAgainstExpectedWork(fixture);
  assert.equal(finalized.status, 'finalized', JSON.stringify(finalized));
  const compiled = manifests.compileObligationManifest({ graph: fixture.graph });
  assert.deepEqual(compiled.validation.errors, []);
  assert.equal(compiled.manifest.readiness, 'ready');
  const node = compiled.manifest.nodes.find((entry) => entry.operationId === 'send');
  assert.ok(node, 'manifest contains the exact observed write operation');
  assert.deepEqual(node.obligations, [
    'commit_effect',
    'verify_committed_receipt',
    'execution_terminal',
  ]);
  assert.equal(authority.manifestAcceptedTaskAuthority(compiled.manifest).status, 'manifested');
  const execution = new ExecutionStore().create({
    sessionId: fixture.sessionId,
    sourceUserSeq: fixture.sourceUserSeq,
    title: 'Send report',
    objective: 'Send the final report',
    reason: 'Accepted user request',
    startedFromMessage: 'Send the final report to the customer.',
    confidence: 1,
    reasons: ['accepted action'],
  });
  const completed = new ExecutionStore().update(execution.id, { status: 'completed' });
  assert.equal(completed?.status, 'completed');
  return { manifest: compiled.manifest, node: node!, physicalDispatchId };
}

async function childProof(input: { bindingId: string; manifestId: string; nodeId: string }) {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'src/runtime/harness/write-evidence-store.ts'),
  ).href;
  const script = `import(${JSON.stringify(moduleUrl)}).then((m) => {`
    + `const result=m.proveAndSatisfyDurableWriteEvidence(${JSON.stringify(input)});`
    + `process.stdout.write("\\nWRITE_EVIDENCE_RESULT:"+JSON.stringify(result)+"\\n");`
    + `}).catch((error)=>{console.error(error);process.exitCode=1;});`;
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], {
      cwd: process.cwd(),
      env: { ...process.env, CLEMENTINE_HOME: TMP_HOME, MCP_AUTO_IMPORT_ENABLED: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`child exited ${code}: ${stderr}`));
      else {
        const marker = 'WRITE_EVIDENCE_RESULT:';
        const line = stdout.split(/\r?\n/u).find((entry) => entry.startsWith(marker));
        if (!line) reject(new Error(`child emitted no proof result: ${stdout} ${stderr}`));
        else resolve(JSON.parse(line.slice(marker.length)) as Record<string, unknown>);
      }
    });
  });
}

test('predispatch binding is immutable, schema-bound, and survives restart without manifest circularity', () => {
  const fixture = stageBoundWrite('restart');
  const before = writeEvidence.loadDurableWriteEvidenceBinding(fixture.bindingId);
  assert.equal(before.status, 'ok');
  eventlog.closeEventLog();
  const after = writeEvidence.loadDurableWriteEvidenceBinding(fixture.bindingId);
  assert.equal(after.status, 'ok');
  assert.deepEqual(after.status === 'ok' && after.binding, before.status === 'ok' && before.binding);

  const db = eventlog.openEventLog();
  assert.throws(() => db.prepare(`
    UPDATE write_evidence_bindings SET input_schema_json = '{"type":"array"}'
     WHERE binding_id = ?
  `).run(fixture.bindingId), /immutable/);
});

test('central settlement keeps a bound predispatch refusal at zero crossings', () => {
  const fixture = stageBoundWrite('refusal');
  const settled = settlements.commitLogicalCallSettlement({
    identity: fixture,
    contract: { toolName: fixture.tool, args: fixture.args },
    execution: { kind: 'refused_pre_dispatch' },
    outcome: attempts.classifyAttemptOutcome({
      preDispatch: true,
      argumentValidationFailed: true,
      schemaAvailable: true,
    }),
    recovery: { businessCall: true, mutating: true, requirementId: 'send' },
    observer: { lane: 'composio', turn: fixture.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM write_evidence_dispatch_reservations WHERE binding_id = ?
  `).get(fixture.bindingId) as { n: number }).n, 0);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM write_evidence_dispatch_outcomes WHERE binding_id = ?
  `).get(fixture.bindingId) as { n: number }).n, 0);
});

test('successful write mints exact lifecycle rows and proof+obligation CAS once across processes', async () => {
  const fixture = stageBoundWrite('concurrent');
  const terminal = settleSuccessfulWrite(fixture);
  const db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT r.ordinal, o.kind
      FROM write_evidence_dispatch_reservations r
      JOIN write_evidence_dispatch_outcomes o ON o.reservation_id = r.reservation_id
     WHERE r.binding_id = ?
  `).all(fixture.bindingId), [{ ordinal: 1, kind: 'succeeded' }]);

  eventlog.closeEventLog();
  const request = {
    bindingId: fixture.bindingId,
    manifestId: terminal.manifest.manifestId,
    nodeId: terminal.node.nodeId,
  };
  const results = await Promise.all([childProof(request), childProof(request)]);
  assert.ok(results.every((result) => ['proved', 'replayed'].includes(String(result.status))), JSON.stringify(results));
  assert.ok(results.some((result) => result.status === 'proved'), JSON.stringify(results));

  const reopened = eventlog.openEventLog();
  const proofs = reopened.prepare(`
    SELECT proof_id, obligation FROM write_evidence_proofs WHERE binding_id = ? ORDER BY obligation
  `).all(fixture.bindingId) as Array<{ proof_id: string; obligation: string }>;
  assert.equal(proofs.length, 3);
  assert.equal((reopened.prepare(`
    SELECT COUNT(*) AS n FROM obligation_transitions WHERE manifest_id = ? AND node_id = ?
  `).get(terminal.manifest.manifestId, terminal.node.nodeId) as { n: number }).n, 3);
  for (const proof of proofs) {
    const redeemed = writeEvidence.redeemDurableWriteEvidenceProof({
      sessionId: fixture.sessionId,
      sourceUserSeq: fixture.sourceUserSeq,
      receiptId: proof.proof_id,
      manifestId: terminal.manifest.manifestId,
      nodeId: terminal.node.nodeId,
      obligation: proof.obligation,
    });
    assert.equal(redeemed.status, 'ok', JSON.stringify(redeemed));
  }
});

test('tampered schema, omitted lifecycle, and duplicate reservation all fail closed', () => {
  const fixture = stageBoundWrite('tamper');
  const terminal = settleSuccessfulWrite(fixture);
  const proved = writeEvidence.proveAndSatisfyDurableWriteEvidence({
    bindingId: fixture.bindingId,
    manifestId: terminal.manifest.manifestId,
    nodeId: terminal.node.nodeId,
  });
  assert.equal(proved.status, 'proved', JSON.stringify(proved));
  const db = eventlog.openEventLog();
  const proof = db.prepare(`
    SELECT proof_id FROM write_evidence_proofs WHERE binding_id = ? AND obligation = 'commit_effect'
  `).get(fixture.bindingId) as { proof_id: string };

  db.exec('BEGIN IMMEDIATE; DROP TRIGGER trg_write_evidence_bindings_update_immutable;');
  db.prepare(`UPDATE write_evidence_bindings SET input_schema_json = '{"type":"array"}' WHERE binding_id = ?`)
    .run(fixture.bindingId);
  assert.equal(writeEvidence.loadDurableWriteEvidenceBinding(fixture.bindingId).status, 'corrupt');
  db.exec('ROLLBACK');

  db.exec('BEGIN IMMEDIATE; DROP TRIGGER trg_write_evidence_outcomes_delete_immutable;');
  db.prepare('DELETE FROM write_evidence_dispatch_outcomes WHERE binding_id = ?').run(fixture.bindingId);
  assert.equal(writeEvidence.redeemDurableWriteEvidenceProof({
    sessionId: fixture.sessionId,
    sourceUserSeq: fixture.sourceUserSeq,
    receiptId: proof.proof_id,
  }).status, 'corrupt');
  db.exec('ROLLBACK');

  assert.throws(() => db.prepare(`
    INSERT INTO write_evidence_dispatch_reservations
      (reservation_id, binding_id, session_id, source_user_seq, accepted_task_id,
       logical_tool_call_id, physical_dispatch_id, ordinal, target_digest,
       write_input_digest, reserved_at)
    SELECT ?, binding_id, session_id, source_user_seq, accepted_task_id,
           logical_tool_call_id, physical_dispatch_id, ordinal, target_digest,
           write_input_digest, reserved_at
      FROM write_evidence_dispatch_reservations WHERE binding_id = ?
  `).run(`write-reservation:v1:${'0'.repeat(64)}`, fixture.bindingId), /UNIQUE/);
});

test('an unacknowledged write is durably orphaned and cannot mint a proof', () => {
  const fixture = stageBoundWrite('uncertain');
  const physicalDispatchId = `dispatch:${fixture.logicalToolCallId}`;
  const begun = dispatch.beginPhysicalDispatch({
    identity: { ...fixture, physicalDispatchId, ordinal: 0 },
    tool: fixture.tool,
    args: fixture.args,
  });
  assert.equal(begun.status, 'inserted');
  if (begun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: fixture.tool,
    outcome: 'unknown',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: fixture,
    contract: { toolName: fixture.tool, args: fixture.args },
    execution: { kind: 'provider_execution' },
    outcome: attempts.classifyAttemptOutcome({ mutating: true, acknowledged: false }),
    recovery: { businessCall: true, mutating: true, requirementId: 'send' },
    observer: { lane: 'composio', turn: fixture.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  const db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT kind, result_handle_id FROM write_evidence_dispatch_outcomes WHERE binding_id = ?
  `).get(fixture.bindingId), { kind: 'orphaned', result_handle_id: null });
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM write_evidence_proofs WHERE binding_id = ?
  `).get(fixture.bindingId) as { n: number }).n, 0);
});
