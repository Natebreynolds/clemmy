import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-dispatch-ledger-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-dispatch-ledger\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const ledger = await import('./dispatch-ledger.js');
const resolution = await import('./resolution-ledger.js');
const identities = await import('./attempt-identity.js');
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;
function accept(text = 'Find the current alpha records.') {
  const session = eventlog.createSession({ id: `dispatch-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
}

test('one logical call records every paid crossing with database ordinals and no raw arguments', async () => {
  const task = accept();
  const secret = 'dispatch-secret-never-persist';
  const observed: string[] = [];
  await identities.withLogicalToolCall({
    ...task,
    tool: 'alpha_records_search',
    args: { query: secret },
  }, async () => {
    const first = await identities.withPhysicalDispatch({
      ...task,
      tool: 'alpha_records_search',
      args: { query: secret },
    }, async (crossing) => {
      observed.push(crossing.physicalDispatchId);
      return 'first';
    });
    assert.equal(first, 'first');
    const second = await identities.withPhysicalDispatch({
      ...task,
      tool: 'alpha_records_search',
      args: { query: secret },
      relation: 'retry',
      retryOf: observed[0],
    }, async (crossing) => {
      observed.push(crossing.physicalDispatchId);
      return 'second';
    });
    assert.equal(second, 'second');
  });

  const crossings = ledger.physicalCrossingsFor(task.sessionId, task.sourceUserSeq);
  assert.deepEqual(crossings.map((crossing) => ({
    ordinal: crossing.ordinal,
    relation: crossing.relation,
    retryOf: crossing.retryOf,
    outcome: crossing.outcome,
  })), [
    { ordinal: 1, relation: 'primary', retryOf: undefined, outcome: 'returned' },
    { ordinal: 2, relation: 'retry', retryOf: observed[0], outcome: 'returned' },
  ]);
  const durable = eventlog.openEventLog().prepare(`
    SELECT tool_name, argument_digest FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? ORDER BY ordinal
  `).all(task.sessionId, task.sourceUserSeq);
  assert.equal(JSON.stringify(durable).includes(secret), false);
  assert.equal(
    eventlog.listEvents(task.sessionId, {
      types: ['provider_dispatch_started', 'provider_dispatch_settled'],
    }).length,
    4,
  );
});

test('logical admission persists an exact open zero-crossing call and replays it idempotently', () => {
  const task = accept();
  const identity = {
    ...task,
    acceptedTaskId: identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq),
    logicalToolCallId: 'logical:predispatch-refusal',
  };
  const first = ledger.admitLogicalCall({
    identity,
    tool: 'alpha_records_search',
    args: { query: 'alpha' },
  });
  const replay = ledger.admitLogicalCall({
    identity,
    tool: 'alpha_records_search',
    args: { query: 'alpha' },
  });
  assert.equal(first.status, 'inserted');
  assert.equal(replay.status, 'replayed');
  if (first.status !== 'inserted' || replay.status !== 'replayed') return;
  assert.deepEqual(replay.identity, first.identity);

  const db = eventlog.openEventLog();
  const logical = db.prepare(`
    SELECT accepted_task_id, tool_name, argument_digest, state
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, identity.logicalToolCallId) as {
    accepted_task_id: string;
    tool_name: string;
    argument_digest: string;
    state: string;
  } | undefined;
  assert.deepEqual(logical, {
    accepted_task_id: identity.acceptedTaskId,
    tool_name: first.identity.toolName,
    argument_digest: first.identity.argumentDigest,
    state: 'open',
  });
  assert.deepEqual(ledger.physicalCrossingsFor(task.sessionId, task.sourceUserSeq), []);
});

test('physical admission reuses a prior logical admission instead of creating parallel authority', () => {
  const task = accept();
  const identity = {
    ...task,
    acceptedTaskId: identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq),
    logicalToolCallId: 'logical:shared-admission',
  };
  assert.equal(ledger.admitLogicalCall({
    identity,
    tool: 'alpha_records_search',
    args: { query: 'alpha' },
  }).status, 'inserted');

  const crossing = ledger.beginPhysicalDispatch({
    identity: {
      ...identity,
      physicalDispatchId: 'dispatch:shared-admission',
      ordinal: 0,
    },
    tool: 'alpha_records_search',
    args: { query: 'alpha' },
  });
  assert.equal(crossing.status, 'inserted');
  const counts = eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?) AS logical_count,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?) AS crossing_count
  `).get(
    task.sessionId,
    task.sourceUserSeq,
    task.sessionId,
    task.sourceUserSeq,
  ) as { logical_count: number; crossing_count: number };
  assert.deepEqual(counts, { logical_count: 1, crossing_count: 1 });
});

test('reusing a logical id with a conflicting contract poisons task authority', () => {
  const task = accept();
  const identity = {
    ...task,
    acceptedTaskId: identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq),
    logicalToolCallId: 'logical:equivocation',
  };
  assert.equal(ledger.admitLogicalCall({
    identity,
    tool: 'alpha_records_search',
    args: { query: 'alpha' },
  }).status, 'inserted');
  const conflict = ledger.admitLogicalCall({
    identity,
    tool: 'alpha_records_search',
    args: { query: 'beta' },
  });
  assert.equal(conflict.status, 'conflict');

  const db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT r.state AS resolution_state, l.state AS logical_state
      FROM accepted_task_resolutions r
      JOIN logical_tool_calls l
        ON l.session_id = r.session_id AND l.source_user_seq = r.source_user_seq
     WHERE r.session_id = ? AND r.source_user_seq = ? AND l.logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, identity.logicalToolCallId), {
    resolution_state: 'legacy_ambiguous',
    logical_state: 'conflict',
  });
  assert.equal(resolution.finalizeResolution(task), false);
});

test('logical admission rejects a different accepted-task id and poisons the exact source', () => {
  const task = accept();
  const conflict = ledger.admitLogicalCall({
    identity: {
      ...task,
      acceptedTaskId: 'task:some-other-source#99',
      logicalToolCallId: 'logical:wrong-owner',
    },
    tool: 'alpha_records_search',
    args: {},
  });
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(eventlog.openEventLog().prepare(`
    SELECT accepted_task_id, state FROM accepted_task_resolutions
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq), {
    accepted_task_id: identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq),
    state: 'legacy_ambiguous',
  });
});

test('logical admission distinguishes a closed resolution from a missing accepted task', () => {
  const closedTask = accept();
  assert.equal(resolution.finalizeResolution(closedTask), true);
  const closed = ledger.admitLogicalCall({
    identity: {
      ...closedTask,
      acceptedTaskId: identities.acceptedTaskIdFor(closedTask.sessionId, closedTask.sourceUserSeq),
      logicalToolCallId: 'logical:too-late',
    },
    tool: 'alpha_records_search',
    args: {},
  });
  assert.equal(closed.status, 'closed');

  const session = eventlog.createSession({ id: `dispatch-missing-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'No graph was persisted.' },
  });
  const missing = ledger.admitLogicalCall({
    identity: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
      logicalToolCallId: 'logical:no-graph',
    },
    tool: 'alpha_records_search',
    args: {},
  });
  assert.equal(missing.status, 'missing');
});

test('logical admission reports storage failure and rolls back resolution authority', () => {
  const task = accept();
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER force_logical_admission_failure
    BEFORE INSERT ON logical_tool_calls
    BEGIN
      SELECT RAISE(ABORT, 'forced logical admission failure');
    END;
  `);
  let result: ReturnType<typeof ledger.admitLogicalCall>;
  try {
    result = ledger.admitLogicalCall({
      identity: {
        ...task,
        acceptedTaskId: identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq),
        logicalToolCallId: 'logical:storage-failure',
      },
      tool: 'alpha_records_search',
      args: {},
    });
  } finally {
    db.exec('DROP TRIGGER IF EXISTS force_logical_admission_failure');
  }
  assert.equal(result.status, 'storage_error');
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count FROM accepted_task_resolutions
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as { count: number }).count, 0);
});

test('finalization wins before dispatch means the provider callback never executes', async () => {
  const task = accept();
  assert.equal(resolution.finalizeResolution(task), true);
  let providerCalled = false;
  await assert.rejects(
    async () => identities.withLogicalToolCall({ ...task, tool: 'alpha_records_search', args: {} }, () => identities.withPhysicalDispatch({
      ...task,
      tool: 'alpha_records_search',
      args: {},
    }, async () => {
      providerCalled = true;
      return 'must not run';
    })),
    identities.LogicalCallPreDispatchAuthorityError,
  );
  assert.equal(providerCalled, false);
  assert.deepEqual(ledger.physicalCrossingsFor(task.sessionId, task.sourceUserSeq), []);
});

test('a durable dispatch-start write failure blocks provider I/O and rolls authority back', async () => {
  const task = accept();
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER force_dispatch_start_failure
    BEFORE INSERT ON physical_dispatches
    BEGIN
      SELECT RAISE(ABORT, 'forced dispatch admission failure');
    END;
  `);
  let providerCalled = false;
  try {
    await assert.rejects(
      identities.withLogicalToolCall({ ...task, tool: 'alpha_records_search', args: {} }, () => identities.withPhysicalDispatch({
        ...task,
        tool: 'alpha_records_search',
        args: {},
      }, async () => {
        providerCalled = true;
        return 'must not run';
      })),
      identities.PhysicalDispatchPreDispatchError,
    );
  } finally {
    db.exec('DROP TRIGGER IF EXISTS force_dispatch_start_failure');
  }
  assert.equal(providerCalled, false);
  assert.deepEqual(ledger.physicalCrossingsFor(task.sessionId, task.sourceUserSeq), []);
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['provider_dispatch_started'] }).length,
    0,
    'the mirror event rolls back with the rejected authority row',
  );
});

test('a mismatched physical settlement cannot close a crossing', () => {
  const task = accept();
  const acceptedTaskId = identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq);
  const started = ledger.beginPhysicalDispatch({
    identity: {
      ...task,
      acceptedTaskId,
      logicalToolCallId: 'logical:mismatch',
      physicalDispatchId: 'dispatch:mismatch',
      ordinal: 0,
    },
    tool: 'alpha_records_search',
    args: {},
  });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') return;
  const conflicting = ledger.settlePhysicalDispatch({
    identity: started.identity,
    tool: 'report_send',
    outcome: 'returned',
  });
  assert.equal(conflicting.status, 'conflict');
  assert.equal(ledger.physicalCrossingsFor(task.sessionId, task.sourceUserSeq)[0]?.settled, false);
  assert.equal(resolution.finalizeResolution(task), false);
});

test('a poisoned call records the FIRST cause on the dispatch path, and later readers report it', () => {
  // The OTHER poison path. poisonResolution flipped a call to 'conflict' and
  // recorded nothing, so every later reader — including the error that ended
  // the run — could only say the call was poisoned, never which check failed.
  // A live scheduled workflow died on exactly this for two days with its first
  // cause unrecoverable from the store (platform-49, 2026-08-11).
  const task = accept();
  const identity = {
    ...task,
    acceptedTaskId: identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq),
    logicalToolCallId: 'logical:first-cause',
  };
  assert.equal(ledger.admitLogicalCall({
    identity,
    tool: 'alpha_records_search',
    args: { query: 'alpha' },
  }).status, 'inserted');

  // Refining someone else's tool onto this call is the platform-49 check.
  const refused = ledger.refineLogicalCallContract({
    identity,
    tool: 'beta_records_write',
    effectiveArgs: { record: 'r1' },
  });
  assert.equal(refused.status, 'conflict');
  if (refused.status !== 'conflict') throw new Error('the fixture did not conflict');
  assert.match(refused.reason, /conflicts with its logical owner or tool/);

  const db = eventlog.openEventLog();
  const row = db.prepare(`
    SELECT state, conflict_reason FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, identity.logicalToolCallId) as {
    state: string;
    conflict_reason: string | null;
  };
  assert.equal(row.state, 'conflict');
  assert.equal(row.conflict_reason, refused.reason, 'the first cause is durable, not just returned');

  // Every later reader names that cause instead of the poisoning.
  const authority = ledger.logicalCallAuthorityState(identity);
  assert.equal(authority.status, 'conflict');
  assert.match(
    authority.status === 'conflict' ? authority.reason : '',
    /conflicts with its logical owner or tool/,
  );

  // A second poison must not overwrite the first cause.
  ledger.admitLogicalCall({ identity, tool: 'alpha_records_search', args: { query: 'gamma' } });
  const after = db.prepare(`
    SELECT conflict_reason FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, identity.logicalToolCallId) as {
    conflict_reason: string | null;
  };
  assert.equal(after.conflict_reason, row.conflict_reason, 'the FIRST cause survives later conflicts');
});

/**
 * Live 2026-08-14: one DENIED tool_search strangled two consecutive turns.
 *
 * A refusal settles the logical call before it ever crosses; the ordinary
 * post-tool accounting then admits the same provider call id again. That exact
 * re-admission used to be folded into the identity-conflict branch, so it
 * poisoned the whole accepted task and every later work_call was refused
 * "accepted task resolution is ambiguous" — until the row was edited by hand.
 *
 * Both directions are pinned deliberately. The benign case must not poison, and
 * a genuine mismatch must still poison, so the split cannot later be
 * "simplified" back into one branch.
 */
function settleAsRefusal(identity: {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
}, tool: string, args: unknown): void {
  const committed = settlements.commitLogicalCallSettlement({
    identity,
    contract: { toolName: tool, args },
    execution: { kind: 'refused_pre_dispatch' },
    outcome: outcomes.classifyAttemptOutcome({ preDispatch: true, policyRefused: true }),
    recovery: { businessCall: false, mutating: false },
    observer: { lane: 'agents_runner', turn: identity.turn },
  });
  assert.ok(
    committed.status === 'committed' || committed.status === 'replayed',
    `fixture settlement failed: ${JSON.stringify(committed)}`,
  );
}

test('an exact re-admission of a settled logical call is closed, never poisoned', () => {
  const task = accept();
  const identity = {
    ...task,
    acceptedTaskId: identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq),
    logicalToolCallId: 'logical:denied-discovery',
  };
  const tool = 'tool_search';
  const args = { query: 'coffee shops in san luis obispo' };
  assert.equal(ledger.admitLogicalCall({ identity, tool, args }).status, 'inserted');
  settleAsRefusal(identity, tool, args);

  const readmitted = ledger.admitLogicalCall({ identity, tool, args });
  assert.equal(readmitted.status, 'closed', JSON.stringify(readmitted));

  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT state FROM accepted_task_resolutions
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as { state: string }).state, 'open',
    'a benign duplicate admission must leave the accepted task usable');

  // The whole point: the task can still do its actual work afterwards.
  assert.equal(ledger.admitLogicalCall({
    identity: { ...identity, logicalToolCallId: 'logical:the-real-work' },
    tool: 'alpha_records_search',
    args: { query: 'coffee shops' },
  }).status, 'inserted', 'later work must still be dispatchable');
});

test('a settled logical call still poisons when the re-admission is a different contract', () => {
  const task = accept();
  const identity = {
    ...task,
    acceptedTaskId: identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq),
    logicalToolCallId: 'logical:settled-then-forged',
  };
  assert.equal(ledger.admitLogicalCall({
    identity,
    tool: 'alpha_records_search',
    args: { query: 'alpha' },
  }).status, 'inserted');
  settleAsRefusal(identity, 'alpha_records_search', { query: 'alpha' });

  // Same id, DIFFERENT arguments: an identity conflict, settled or not.
  const forged = ledger.admitLogicalCall({
    identity,
    tool: 'alpha_records_search',
    args: { query: 'beta' },
  });
  assert.equal(forged.status, 'conflict');
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT state FROM accepted_task_resolutions
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as { state: string }).state, 'legacy_ambiguous',
    'a forged identity must still poison even after the call settled');
});
