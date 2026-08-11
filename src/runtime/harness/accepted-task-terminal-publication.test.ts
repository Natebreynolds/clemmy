import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-terminal-publication-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-terminal-publication\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const resolution = await import('./resolution-ledger.js');
const manifests = await import('./obligation-manifest.js');
const authority = await import('./accepted-task-authority.js');
const contracts = await import('./expected-work-contract.js');
const delivery = await import('./delivery-committer.js');
const outcomes = await import('./turn-outcome.js');
const attempts = await import('./attempt-outcome.js');
const identities = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const settlements = await import('./logical-call-settlement-store.js');
const receipts = await import('./evidence-receipts.js');
const obligations = await import('./obligation-store.js');
type TurnOutcome = import('./turn-outcome.js').TurnOutcome;
type TurnOutcomeStatus = import('./turn-outcome.js').TurnOutcomeStatus;

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function accept(text = 'Hello, how are you?') {
  const session = eventlog.createSession({
    id: `terminal-publication-${process.pid}-${++serial}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
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

function stageContract(text = 'Hello, how are you?') {
  const task = acceptWithGraph(text);
  const fixed = contracts.freezeDeterministicExpectedWorkContract(task);
  assert.equal(fixed.status, 'fixed');
  if (fixed.status !== 'fixed') throw new Error(fixed.reason);
  return { ...task, contract: fixed.contract };
}

function stageManifested() {
  const task = stageContract();
  assert.equal(resolution.finalizeResolution(task), true);
  const compiled = manifests.compileObligationManifest({ graph: task.expected.graph });
  assert.deepEqual(compiled.validation.errors, []);
  assert.equal(compiled.manifest.readiness, 'ready');
  const manifested = authority.manifestAcceptedTaskAuthority(compiled.manifest);
  assert.equal(manifested.status, 'manifested');
  if (manifested.status !== 'manifested') throw new Error(manifested.reason);
  return { ...task, manifest: compiled.manifest };
}

function stageManifestedRead(options: { satisfy?: boolean } = {}) {
  const task = stageContract('Find every current alpha record.');
  const logicalToolCallId = `logical:terminal-read:${serial}`;
  const tool = 'alpha_records_search';
  const args = { query: 'alpha' };
  const acceptedTaskId = identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq);
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      acceptedTaskId,
      logicalToolCallId,
      physicalDispatchId: `dispatch:terminal-read:${serial}`,
      ordinal: 0,
    },
    tool,
    args,
  });
  assert.equal(begun.status, 'inserted');
  if (begun.status !== 'inserted') throw new Error(begun.reason);
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, acceptedTaskId, logicalToolCallId },
    contract: { toolName: tool, args },
    execution: { kind: 'provider_execution' },
    result: {
      payload: {
        successful: true,
        data: { records: [{ id: 'r1' }, { id: 'r2' }] },
        meta: { complete: true },
      },
    },
    outcome: attempts.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(settled.status, 'committed');
  if (settled.status !== 'committed') throw new Error(JSON.stringify(settled));
  assert.equal(resolution.finalizeResolution(task), true);
  const compiled = manifests.compileObligationManifest({ graph: task.expected.graph });
  assert.deepEqual(compiled.validation.errors, []);
  assert.equal(compiled.manifest.readiness, 'ready');
  assert.equal(compiled.manifest.nodes.length, 1);
  assert.equal(authority.manifestAcceptedTaskAuthority(compiled.manifest).status, 'manifested');
  const node = compiled.manifest.nodes[0]!;
  const issued = receipts.issueHostReadEvidenceForManifestNode({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    manifestId: compiled.manifest.manifestId,
    nodeId: node.nodeId,
  });
  assert.equal(issued.status, 'issued');
  if (issued.status !== 'issued') throw new Error(issued.reason);
  if (options.satisfy) {
    const satisfied = obligations.satisfyDeclaredObligation({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      manifestId: compiled.manifest.manifestId,
      nodeId: node.nodeId,
      obligation: issued.receipt.obligation,
      receiptId: issued.receipt.receiptId,
      physicalAttemptId: issued.receipt.physicalDispatchId,
    });
    assert.deepEqual(satisfied, { ok: true });
  }
  return {
    ...task,
    acceptedTaskId,
    manifest: compiled.manifest,
    receipt: issued.receipt,
    logicalToolCallId,
  };
}

function outcomeFor(
  task: ReturnType<typeof accept>,
  status: TurnOutcomeStatus,
  text = `${status} response`,
): TurnOutcome {
  const identity = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
  };
  const common = {
    version: 2 as const,
    id: outcomes.turnOutcomeId(identity),
    identity,
  };
  if (status === 'done') {
    return {
      ...common,
      status,
      resumable: false,
      presentation: { kind: 'answer', text },
    };
  }
  if (status === 'needs_input') {
    return {
      ...common,
      status,
      resumable: true,
      needs: { kind: 'input' },
      presentation: { kind: 'question', text },
    };
  }
  if (status === 'blocked') {
    return {
      ...common,
      status,
      resumable: true,
      presentation: { kind: 'blocked', text },
    };
  }
  throw new Error(`unsupported fixture status: ${status}`);
}

function appendOutcome(task: ReturnType<typeof accept>, status: TurnOutcomeStatus) {
  const outcome = outcomeFor(task, status);
  return eventlog.appendTerminalEventOnce({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'system',
    data: delivery.completionDataForTurnOutcome(outcome),
  }, outcome.id);
}

function readAuthority(task: ReturnType<typeof accept>) {
  const loaded = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status, 'ok');
  if (loaded.status !== 'ok') throw new Error('fixture authority is missing');
  return loaded.authority;
}

function recreatePhysicalDispatchImmutableTrigger(): void {
  eventlog.openEventLog().exec(`
    CREATE TRIGGER IF NOT EXISTS trg_physical_dispatch_identity_immutable
    BEFORE UPDATE OF accepted_task_id, logical_tool_call_id,
                     physical_dispatch_id, ordinal, relation, retry_of,
                     tool_name, argument_digest
    ON physical_dispatches
    WHEN OLD.accepted_task_id IS NOT NEW.accepted_task_id
      OR OLD.logical_tool_call_id IS NOT NEW.logical_tool_call_id
      OR OLD.physical_dispatch_id IS NOT NEW.physical_dispatch_id
      OR OLD.ordinal IS NOT NEW.ordinal
      OR OLD.relation IS NOT NEW.relation
      OR OLD.retry_of IS NOT NEW.retry_of
      OR OLD.tool_name IS NOT NEW.tool_name
      OR OLD.argument_digest IS NOT NEW.argument_digest
    BEGIN
      SELECT RAISE(ABORT, 'physical dispatch identity is immutable');
    END;
  `);
}

function recreateDurableResultImmutableTrigger(): void {
  eventlog.openEventLog().exec(`
    CREATE TRIGGER IF NOT EXISTS trg_durable_result_identity_immutable
    BEFORE UPDATE ON durable_result_handles
    BEGIN
      SELECT RAISE(ABORT, 'durable result handles are immutable');
    END;
  `);
}

test('staged done atomically publishes one event and advances exact authority to that event', () => {
  const task = stageManifested();
  const terminal = appendOutcome(task, 'done');
  assert.equal(terminal.inserted, true);
  const published = readAuthority(task);
  assert.equal(published.state, 'terminal');
  assert.equal(published.terminalEventId, terminal.event.id);
  assert.equal(published.workContractId, task.contract.contractId);
  assert.equal(published.manifestId, task.manifest.manifestId);
  const read = eventlog.readAcceptedTaskTerminalPublication(task.sessionId, task.sourceUserSeq);
  assert.equal(read.status, 'published');
  assert.equal(read.status === 'published' && read.event.id, terminal.event.id);
});

test('a manifested read cannot publish done until its declared receipt is exactly transitioned', () => {
  const unsatisfied = stageManifestedRead();
  assert.throws(
    () => appendOutcome(unsatisfied, 'done'),
    (error: unknown) => {
      assert.ok(error instanceof eventlog.AcceptedTaskTerminalPublicationError);
      assert.equal(error.status, 'not_ready');
      assert.match(error.reason, /unsatisfied|transition|proof/i);
      return true;
    },
  );
  assert.equal(
    eventlog.listEvents(unsatisfied.sessionId, { types: ['conversation_completed'] }).length,
    0,
  );
  assert.equal(readAuthority(unsatisfied).state, 'manifested_verifying');

  const satisfied = stageManifestedRead({ satisfy: true });
  const terminal = appendOutcome(satisfied, 'done');
  assert.equal(terminal.inserted, true);
  assert.equal(readAuthority(satisfied).terminalEventId, terminal.event.id);
});

test('terminal proof recomputes the frozen crossing digest instead of trusting its count', () => {
  const task = stageManifestedRead({ satisfy: true });
  eventlog.openEventLog().prepare(`
    UPDATE logical_call_settlement_crossings
       SET tool_name = tool_name || '_forged'
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).run(task.sessionId, task.sourceUserSeq, task.logicalToolCallId);
  assert.throws(
    () => appendOutcome(task, 'done'),
    (error: unknown) => {
      assert.ok(error instanceof eventlog.AcceptedTaskTerminalPublicationError);
      assert.equal(error.status, 'conflict');
      assert.match(error.reason, /crossing/i);
      return true;
    },
  );
  assert.equal(readAuthority(task).state, 'manifested_verifying');
});

test('terminal proof compares the exact frozen and live physical crossing sets', () => {
  const task = stageManifestedRead({ satisfy: true });
  const db = eventlog.openEventLog();
  db.exec('DROP TRIGGER IF EXISTS trg_physical_dispatch_identity_immutable');
  try {
    db.prepare(`
      UPDATE physical_dispatches
         SET tool_name = tool_name || '_forged'
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).run(task.sessionId, task.sourceUserSeq, task.logicalToolCallId);
  } finally {
    recreatePhysicalDispatchImmutableTrigger();
  }
  assert.throws(
    () => appendOutcome(task, 'done'),
    (error: unknown) => {
      assert.ok(error instanceof eventlog.AcceptedTaskTerminalPublicationError);
      assert.equal(error.status, 'conflict');
      assert.match(error.reason, /crossing/i);
      return true;
    },
  );
  assert.equal(readAuthority(task).state, 'manifested_verifying');
});

test('terminal proof re-derives handle path, completeness, cursor, and repetition from raw bytes', () => {
  const corruptions = [
    `record_path = 'shadow.records'`,
    `completeness = 'partial'`,
    `continuation_ref = 'cont_forged', cursor_bytes = X'666F72676564',
       cursor_sha256 = '${'0'.repeat(64)}', cursor_repeated = 1`,
  ];
  for (const mutation of corruptions) {
    const task = stageManifestedRead({ satisfy: true });
    const db = eventlog.openEventLog();
    db.exec('DROP TRIGGER IF EXISTS trg_durable_result_identity_immutable');
    try {
      db.prepare(`
        UPDATE durable_result_handles SET ${mutation}
         WHERE handle_id = ?
      `).run(task.receipt.resultHandleId);
    } finally {
      recreateDurableResultImmutableTrigger();
    }
    assert.throws(
      () => appendOutcome(task, 'done'),
      (error: unknown) => {
        assert.ok(error instanceof eventlog.AcceptedTaskTerminalPublicationError);
        assert.equal(error.status, 'conflict');
        assert.match(error.reason, /raw payload|projection/i);
        return true;
      },
    );
    assert.equal(readAuthority(task).state, 'manifested_verifying');
  }
});

test('duplicate or extra obligation transitions cannot manufacture terminal proof', () => {
  for (const mode of ['duplicate', 'extra'] as const) {
    const task = stageManifestedRead({ satisfy: true });
    const db = eventlog.openEventLog();
    db.prepare(`
      INSERT INTO obligation_transitions
        (obligation_key, session_id, source_user_seq, manifest_id, node_id,
         obligation, receipt_id, physical_attempt_id, claimed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `terminal-${mode}:${task.sessionId}`,
      task.sessionId,
      task.sourceUserSeq,
      task.manifest.manifestId,
      mode === 'duplicate' ? task.manifest.nodes[0]!.nodeId : 'unexpected-node',
      mode === 'duplicate' ? task.receipt.obligation : 'source_observed',
      task.receipt.receiptId,
      task.receipt.physicalDispatchId,
      new Date().toISOString(),
    );
    assert.throws(
      () => appendOutcome(task, 'done'),
      (error: unknown) => {
        assert.ok(error instanceof eventlog.AcceptedTaskTerminalPublicationError);
        assert.equal(error.status, 'conflict');
        return true;
      },
    );
    assert.equal(readAuthority(task).state, 'manifested_verifying');
  }
});

test('content-address corruption in contract, manifest, or graph fails closed', () => {
  const corruptContract = stageManifested();
  const contractDb = eventlog.openEventLog();
  const contractRow = contractDb.prepare(`
    SELECT contract_json FROM accepted_task_work_contracts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(corruptContract.sessionId, corruptContract.sourceUserSeq) as { contract_json: string };
  contractDb.exec('DROP TRIGGER trg_accepted_task_work_contracts_update_immutable');
  try {
    const damaged = contractRow.contract_json.replace('"turn":1', '"turn":2');
    assert.equal(damaged.length, contractRow.contract_json.length, 'corruption preserves byte count');
    contractDb.prepare(`
      UPDATE accepted_task_work_contracts SET contract_json = ?
       WHERE session_id = ? AND source_user_seq = ?
    `).run(damaged, corruptContract.sessionId, corruptContract.sourceUserSeq);
  } finally {
    contractDb.exec(`
      CREATE TRIGGER trg_accepted_task_work_contracts_update_immutable
      BEFORE UPDATE ON accepted_task_work_contracts
      BEGIN
        SELECT RAISE(ABORT, 'accepted task work contracts are immutable');
      END;
    `);
  }
  assert.throws(
    () => appendOutcome(corruptContract, 'done'),
    (error: unknown) => error instanceof eventlog.AcceptedTaskTerminalPublicationError
      && error.status === 'conflict',
  );

  const corruptManifest = stageManifested();
  const manifestDb = eventlog.openEventLog();
  const manifestRow = manifestDb.prepare(`
    SELECT id, data_json FROM events
     WHERE session_id = ? AND type = 'obligation_manifest'
       AND json_extract(data_json, '$.sourceUserSeq') = ?
  `).get(corruptManifest.sessionId, corruptManifest.sourceUserSeq) as {
    id: string;
    data_json: string;
  };
  const manifestData = JSON.parse(manifestRow.data_json) as {
    manifest: { identity: { turn: number } };
  };
  manifestData.manifest.identity.turn += 1;
  manifestDb.prepare('UPDATE events SET data_json = ? WHERE id = ?')
    .run(JSON.stringify(manifestData), manifestRow.id);
  assert.throws(
    () => appendOutcome(corruptManifest, 'done'),
    (error: unknown) => error instanceof eventlog.AcceptedTaskTerminalPublicationError
      && error.status === 'conflict',
  );

  const corruptGraph = stageManifested();
  const graphDb = eventlog.openEventLog();
  const graphRow = graphDb.prepare('SELECT data_json FROM events WHERE id = ?')
    .get(corruptGraph.graphEvent.id) as { data_json: string };
  const graphData = JSON.parse(graphRow.data_json) as {
    graph: { classification: { confidence: number } };
  };
  graphData.graph.classification.confidence = 0.123456;
  graphDb.prepare('UPDATE events SET data_json = ? WHERE id = ?')
    .run(JSON.stringify(graphData), corruptGraph.graphEvent.id);
  assert.throws(
    () => appendOutcome(corruptGraph, 'done'),
    (error: unknown) => error instanceof eventlog.AcceptedTaskTerminalPublicationError
      && error.status === 'conflict',
  );
});

test('staged done fails closed while armed or conflicted and leaves no terminal row', () => {
  const armed = stageContract();
  assert.throws(
    () => appendOutcome(armed, 'done'),
    (error: unknown) => {
      assert.ok(error instanceof eventlog.AcceptedTaskTerminalPublicationError);
      assert.equal(error.status, 'not_ready');
      return true;
    },
  );
  assert.equal(eventlog.listEvents(armed.sessionId, { types: ['conversation_completed'] }).length, 0);
  assert.equal(readAuthority(armed).state, 'armed');

  const conflicted = stageContract();
  eventlog.openEventLog().prepare(`
    UPDATE accepted_task_authority
       SET state = 'conflict', revision = revision + 1, updated_at = ?
     WHERE session_id = ? AND source_user_seq = ?
  `).run(new Date().toISOString(), conflicted.sessionId, conflicted.sourceUserSeq);
  assert.throws(
    () => appendOutcome(conflicted, 'done'),
    (error: unknown) => {
      assert.ok(error instanceof eventlog.AcceptedTaskTerminalPublicationError);
      assert.equal(error.status, 'conflict');
      return true;
    },
  );
  assert.equal(eventlog.listEvents(conflicted.sessionId, { types: ['conversation_completed'] }).length, 0);
});

test('a dangling staged work-contract binding cannot publish done', () => {
  const task = stageManifested();
  eventlog.openEventLog().prepare(`
    DELETE FROM accepted_task_work_contracts
     WHERE session_id = ? AND source_user_seq = ?
  `).run(task.sessionId, task.sourceUserSeq);
  assert.throws(
    () => appendOutcome(task, 'done'),
    (error: unknown) => {
      assert.ok(error instanceof eventlog.AcceptedTaskTerminalPublicationError);
      assert.equal(error.status, 'conflict');
      return true;
    },
  );
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['conversation_completed'] }).length, 0);
  assert.equal(readAuthority(task).state, 'manifested_verifying');
  assert.equal(
    eventlog.readAcceptedTaskTerminalPublication(task.sessionId, task.sourceUserSeq).status,
    'conflict',
  );
});

test('blocked and needs-input terminals never advance manifested authority', () => {
  for (const status of ['blocked', 'needs_input'] as const) {
    const task = stageManifested();
    const terminal = appendOutcome(task, status);
    assert.equal(terminal.inserted, true);
    const pending = readAuthority(task);
    assert.equal(pending.state, 'manifested_verifying');
    assert.equal(pending.terminalEventId, undefined);
    const read = eventlog.readAcceptedTaskTerminalPublication(task.sessionId, task.sourceUserSeq);
    assert.equal(read.status, 'pending');
  }
});

test('legacy and unbound action-deferred sources retain their existing publication behavior', () => {
  const legacy = accept('A historical source with no graph authority.');
  assert.equal(appendOutcome(legacy, 'done').inserted, true);
  assert.equal(
    eventlog.readAcceptedTaskTerminalPublication(legacy.sessionId, legacy.sourceUserSeq).status,
    'legacy',
  );

  const deferred = acceptWithGraph('Email alex@example.com with the update.');
  const armed = authority.armAcceptedTaskAuthority(deferred);
  assert.equal(armed.status, 'armed');
  assert.equal(readAuthority(deferred).workContractId, undefined);
  assert.equal(appendOutcome(deferred, 'done').inserted, true);
  assert.equal(readAuthority(deferred).state, 'armed');
  assert.equal(
    eventlog.readAcceptedTaskTerminalPublication(deferred.sessionId, deferred.sourceUserSeq).status,
    'unstaged',
  );

  const failingLegacy = accept('A legacy source whose event store rejects the write.');
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER force_legacy_terminal_insert_failure
    BEFORE INSERT ON events
    WHEN NEW.type = 'conversation_completed'
      AND NEW.session_id = '${failingLegacy.sessionId}'
    BEGIN
      SELECT RAISE(ABORT, 'forced legacy terminal failure');
    END;
  `);
  try {
    assert.throws(
      () => appendOutcome(failingLegacy, 'done'),
      (error: unknown) => {
        assert.ok(!(error instanceof eventlog.AcceptedTaskTerminalPublicationError));
        assert.match(String(error), /forced legacy terminal failure/);
        return true;
      },
    );
  } finally {
    db.exec('DROP TRIGGER force_legacy_terminal_insert_failure');
  }
});

test('terminal authority update failure rolls back the event and an exact retry can win', () => {
  const task = stageManifested();
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER force_terminal_authority_failure
    BEFORE UPDATE OF state ON accepted_task_authority
    WHEN NEW.state = 'terminal'
    BEGIN
      SELECT RAISE(ABORT, 'forced terminal authority failure');
    END;
  `);
  try {
    assert.throws(
      () => appendOutcome(task, 'done'),
      (error: unknown) => {
        assert.ok(error instanceof eventlog.AcceptedTaskTerminalPublicationError);
        assert.equal(error.status, 'storage_error');
        assert.match(error.message, /forced terminal authority failure/);
        return true;
      },
    );
  } finally {
    db.exec('DROP TRIGGER force_terminal_authority_failure');
  }
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['conversation_completed'] }).length, 0);
  assert.equal(readAuthority(task).state, 'manifested_verifying');

  const retry = appendOutcome(task, 'done');
  assert.equal(retry.inserted, true);
  assert.equal(readAuthority(task).terminalEventId, retry.event.id);
});

test('an exact replay returns the one authority-linked winner', () => {
  const task = stageManifested();
  const first = appendOutcome(task, 'done');
  const replay = appendOutcome(task, 'done');
  assert.equal(first.inserted, true);
  assert.equal(replay.inserted, false);
  assert.equal(replay.event.id, first.event.id);
  assert.equal(readAuthority(task).terminalEventId, first.event.id);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['conversation_completed'] }).length, 1);
});

test('replay refuses a staged done row that never won the authority CAS', () => {
  const task = stageManifested();
  const outcome = outcomeFor(task, 'done');
  const data = {
    ...delivery.completionDataForTurnOutcome(outcome),
    terminalKey: outcome.id,
    logicalTerminalVersion: 1,
  };
  const id = `forged-terminal-${serial}`;
  eventlog.openEventLog().prepare(`
    INSERT INTO events
      (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES (?, ?, ?, 'system', 'conversation_completed', NULL, ?, ?)
  `).run(id, task.sessionId, task.turn, JSON.stringify(data), new Date().toISOString());
  assert.throws(
    () => appendOutcome(task, 'done'),
    (error: unknown) => {
      assert.ok(error instanceof eventlog.AcceptedTaskTerminalPublicationError);
      assert.equal(error.status, 'conflict');
      return true;
    },
  );
  assert.equal(readAuthority(task).state, 'manifested_verifying');
});

function runRaceChild(input: {
  script: string;
  payload: Record<string, unknown>;
  ready: string;
  barrier: string;
}): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', input.script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERMINAL_PUBLICATION_PAYLOAD: JSON.stringify(input.payload),
        TERMINAL_PUBLICATION_READY: input.ready,
        TERMINAL_PUBLICATION_BARRIER: input.barrier,
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('concurrent staged done publishers serialize to one event and one authority transition', async () => {
  const task = stageManifested();
  const outcome = outcomeFor(task, 'done');
  const payload = {
    input: {
      sessionId: task.sessionId,
      turn: task.turn,
      role: 'system',
      data: delivery.completionDataForTurnOutcome(outcome),
    },
    terminalKey: outcome.id,
  };
  const script = path.join(TMP_HOME, `terminal-publication-race-child-${serial}.mts`);
  const barrier = path.join(TMP_HOME, `terminal-publication-race-${serial}.release`);
  const readyOne = path.join(TMP_HOME, `terminal-publication-race-${serial}.one.ready`);
  const readyTwo = path.join(TMP_HOME, `terminal-publication-race-${serial}.two.ready`);
  const eventlogPath = path.resolve('src/runtime/harness/eventlog.ts');
  writeFileSync(script, `
    import { existsSync, writeFileSync } from 'node:fs';
    const eventlog = await import(${JSON.stringify(eventlogPath)});
    const payload = JSON.parse(process.env.TERMINAL_PUBLICATION_PAYLOAD || '{}');
    const ready = process.env.TERMINAL_PUBLICATION_READY || '';
    const barrier = process.env.TERMINAL_PUBLICATION_BARRIER || '';
    writeFileSync(ready, 'ready');
    while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 2));
    const result = eventlog.appendTerminalEventOnce(payload.input, payload.terminalKey);
    console.log(JSON.stringify({ inserted: result.inserted, eventId: result.event.id }));
  `, 'utf8');
  const first = runRaceChild({ script, payload, ready: readyOne, barrier });
  const second = runRaceChild({ script, payload, ready: readyTwo, barrier });
  const deadline = Date.now() + 30_000;
  while ((!existsSync(readyOne) || !existsSync(readyTwo)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(existsSync(readyOne) && existsSync(readyTwo), 'both processes reached the same barrier');
  writeFileSync(barrier, 'release\n', 'utf8');
  const results = await Promise.all([first, second]);
  for (const result of results) assert.equal(result.code, 0, result.output);
  const decoded = results.map((result) => {
    const line = result.output.trim().split('\n')
      .findLast((entry) => entry.startsWith('{') && entry.includes('"inserted"'));
    return JSON.parse(line ?? '{}') as { inserted?: boolean; eventId?: string };
  });
  assert.deepEqual(decoded.map((entry) => entry.inserted).sort(), [false, true]);
  assert.equal(new Set(decoded.map((entry) => entry.eventId)).size, 1);
  const published = readAuthority(task);
  assert.equal(published.state, 'terminal');
  assert.equal(published.terminalEventId, decoded[0]?.eventId);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['conversation_completed'] }).length, 1);
});
