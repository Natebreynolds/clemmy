import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-historical-reconcile-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const resolution = await import('./resolution-ledger.js');
const authority = await import('./accepted-turn-call-authority.js');
const identities = await import('./attempt-identity.js');
const delivery = await import('./delivery-committer.js');
const turnOutcomes = await import('./turn-outcome.js');
const reconciler = await import('./historical-state-reconciler.js');
const dispatch = await import('./dispatch-ledger.js');
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');
const contracts = await import('./logical-call-contract.js');
const approvals = await import('./approval-registry.js');
const externalOwners = await import('../../execution/historical-session-external-ownership.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

type TerminalKind = 'done' | 'failed' | 'uncertain' | 'cancelled' | 'needs_input';

function graphTask(text = 'Read the durable records.') {
  const session = eventlog.createSession({
    id: `historical-reconcile-${++serial}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
  }));
  const expected = resolution.expectedTaskFor(session.id, source.seq);
  assert.equal(expected.status, 'ok');
  if (expected.status !== 'ok') throw new Error(expected.reason);
  const db = eventlog.openEventLog();
  assert.equal(db.transaction(() => (
    resolution.ensureAcceptedTaskResolutionOpenInTransaction(db, expected.expectation)
  )).immediate(), true);
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    sourceEventId: source.id,
    turn: source.turn,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    expected: expected.expectation,
  };
}

function rawTerminal(
  task: ReturnType<typeof graphTask>,
  kind: TerminalKind = 'done',
  approvalId?: string,
): { eventId: string; createdAt: string; data: Record<string, unknown> } {
  const identity = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
  };
  const id = turnOutcomes.turnOutcomeId(identity);
  const outcome: turnOutcomes.TurnOutcome = kind === 'done'
    ? {
        version: 2,
        id,
        identity,
        status: 'done',
        resumable: false,
        presentation: { kind: 'answer', text: 'The durable work is complete.' },
      }
    : kind === 'failed'
      ? {
          version: 2,
          id,
          identity,
          status: 'failed',
          resumable: false,
          presentation: { kind: 'error', text: 'The durable work failed safely.' },
        }
      : kind === 'uncertain'
        ? {
            version: 2,
            id,
            identity,
            status: 'uncertain',
            resumable: true,
            presentation: { kind: 'blocked', text: 'The durable result is uncertain.' },
          }
        : kind === 'cancelled'
          ? {
              version: 2,
              id,
              identity,
              status: 'cancelled',
              resumable: false,
              presentation: { kind: 'stopped', text: 'The durable work was stopped.' },
            }
          : {
              version: 2,
              id,
              identity,
              status: 'needs_input',
              resumable: true,
              needs: { kind: 'approval' },
              presentation: {
                kind: 'approval',
                text: 'Approve the next durable action.',
                approvalId: approvalId ?? 'apr-historical',
              },
            };
  const data = delivery.completionDataForTurnOutcome(outcome);
  const eventId = `historical-terminal-${++serial}`;
  const createdAt = new Date(Date.UTC(2026, 7, 22, 12, 0, serial)).toISOString();
  eventlog.openEventLog().prepare(`
    INSERT INTO events
      (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES (?, ?, ?, 'system', 'conversation_completed', NULL, ?, ?)
  `).run(eventId, task.sessionId, task.turn, JSON.stringify(data), createdAt);
  return { eventId, createdAt, data };
}

function rootRow(task: ReturnType<typeof graphTask>) {
  return eventlog.openEventLog().prepare(`
    SELECT state, revision, closed_at, close_reason
      FROM accepted_turn_call_authorities
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as {
    state: string;
    revision: number;
    closed_at: string | null;
    close_reason: string | null;
  };
}

function resolutionBytes(task: ReturnType<typeof graphTask>): string {
  return JSON.stringify(eventlog.openEventLog().prepare(`
    SELECT * FROM accepted_task_resolutions
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq));
}

function markTerminalSession(task: ReturnType<typeof graphTask>): void {
  eventlog.updateSession(task.sessionId, {
    status: 'completed',
    metadata: {
      keep: 'byte-stable-value',
      __interrupt_state: { version: 1, pending: true },
      __interrupt_mcp_scope: { server: 'fixture' },
    },
  });
}

function settleExactProviderChild(task: ReturnType<typeof graphTask>, suffix: string) {
  const tool = 'historical_records_search';
  const args = { query: suffix };
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId: `historical-settled-child-${suffix}`,
      physicalDispatchId: `historical-settled-crossing-${suffix}`,
      ordinal: 0,
      turn: task.turn,
    },
    tool,
    args,
  });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') throw new Error('fixture crossing was not admitted');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool,
    outcome: 'returned',
  }).status, 'inserted');
  const committed = settlements.commitLogicalCallSettlement({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId: started.identity.logicalToolCallId,
    },
    contract: { toolName: tool, args },
    execution: { kind: 'provider_execution' },
    result: { payload: { ok: true } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: false, mutating: false },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(committed.status, 'committed');
  return started.identity;
}

test('clean historical terminal closes only the call root, remains readable, and boot is idempotent', () => {
  const task = graphTask();
  const terminal = rawTerminal(task, 'done');
  const beforeResolution = resolutionBytes(task);
  const beforeEventCount = eventlog.listEvents(task.sessionId).length;
  const first = reconciler.reconcileHistoricalHarnessStateOnBoot({
    pageSize: 16,
    inspectExternalOwnership: () => ({ status: 'clear' }),
  });
  assert.equal(first.roots.closed, 1);
  assert.deepEqual(rootRow(task), {
    state: 'closed',
    revision: 1,
    closed_at: terminal.createdAt,
    close_reason: 'historical_terminal_complete',
  });
  assert.equal(resolutionBytes(task), beforeResolution, 'open resolution bytes are never fabricated or finalized');
  assert.equal(eventlog.listEvents(task.sessionId).length, beforeEventCount, 'maintenance appends no event');
  const read = authority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(read.status, 'ok');
  if (read.status === 'ok') assert.equal(read.authority.state, 'closed');
  const db = eventlog.openEventLog();
  assert.throws(() => db.transaction(() => (
    resolution.ensureAcceptedTaskResolutionOpenInTransaction(db, task.expected)
  )).immediate(), /state does not match its exact resolution/);

  const second = reconciler.reconcileHistoricalHarnessStateOnBoot({
    pageSize: 16,
    inspectExternalOwnership: () => ({ status: 'clear' }),
  });
  assert.equal(second.roots.closed, 0);
  assert.equal(second.roots.conflicted, 0);
  assert.equal(resolutionBytes(task), beforeResolution);
});

test('failed, uncertain, and open-child historical sources poison instead of replaying', () => {
  const failed = graphTask('Fail this historical task safely.');
  rawTerminal(failed, 'failed');
  const uncertain = graphTask('Keep uncertainty explicit.');
  rawTerminal(uncertain, 'uncertain');
  const openChild = graphTask('Do not mistake an open child for completion.');
  rawTerminal(openChild, 'done');
  const contract = contracts.durableLogicalCallContract(
    openChild.acceptedTaskId,
    'session_history',
    {},
  );
  assert.ok(contract);
  eventlog.openEventLog().prepare(`
    INSERT INTO logical_tool_calls
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       tool_name, argument_digest, raw_argument_digest, state, opened_at)
    VALUES (?, ?, ?, 'historical-open-child', ?, ?, ?, 'open', ?)
  `).run(
    openChild.sessionId,
    openChild.sourceUserSeq,
    openChild.acceptedTaskId,
    contract!.toolName,
    contract!.argumentDigest,
    contract!.argumentDigest,
    new Date().toISOString(),
  );

  const beforePhysical = (eventlog.openEventLog().prepare(
    'SELECT COUNT(*) AS count FROM physical_dispatches',
  ).get() as { count: number }).count;
  const result = reconciler.reconcileHistoricalHarnessStateOnBoot({
    pageSize: 32,
    inspectExternalOwnership: () => ({ status: 'clear' }),
  });
  assert.equal(result.roots.conflicted, 3);
  for (const task of [failed, uncertain, openChild]) {
    assert.equal(rootRow(task).state, 'conflict');
    assert.match(rootRow(task).close_reason ?? '', /^historical_terminal_conflict:/);
  }
  assert.equal(
    (eventlog.openEventLog().prepare('SELECT COUNT(*) AS count FROM physical_dispatches').get() as { count: number }).count,
    beforePhysical,
    'maintenance performs zero dispatches',
  );
});

test('timed-out and unknown physical crossings can only poison a historical root', () => {
  for (const state of ['timed_out', 'unknown'] as const) {
    const task = graphTask(`Keep ${state} crossing uncertainty explicit.`);
    const child = settleExactProviderChild(task, state);
    eventlog.openEventLog().prepare(`
      UPDATE physical_dispatches SET state = ?
       WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
    `).run(state, task.sessionId, task.sourceUserSeq, child.physicalDispatchId);
    rawTerminal(task, 'done');
    const result = reconciler.reconcileHistoricalCallAuthorityRootPage({ pageSize: 64 });
    assert.ok(result.conflicted >= 1);
    assert.equal(rootRow(task).state, 'conflict');
    assert.match(rootRow(task).close_reason ?? '', /physical_crossing/);
  }
});

test('an active attempt and an exact pending approval preserve their open roots', () => {
  const active = graphTask('This source still has a live attempt.');
  rawTerminal(active, 'done');
  const attempt = eventlog.beginRunAttempt(active.sessionId, { attemptId: `active-${serial}` });
  eventlog.openEventLog().prepare(`
    UPDATE run_attempts SET source_user_seq = ? WHERE attempt_id = ?
  `).run(active.sourceUserSeq, attempt.attemptId);

  const approvalTask = graphTask('Wait for exact human approval.');
  const approval = approvals.register({
    sessionId: approvalTask.sessionId,
    subject: 'Approve historical fixture',
  });
  rawTerminal(approvalTask, 'needs_input', approval.approvalId);
  const result = reconciler.reconcileHistoricalCallAuthorityRootPage({ pageSize: 32 });
  assert.ok(result.held >= 2);
  assert.equal(result.heldReasons.active_attempt, 1);
  assert.equal(result.heldReasons.pending_approval, 1);
  assert.equal(rootRow(active).state, 'open');
  assert.equal(rootRow(approvalTask).state, 'open');
});

test('terminal session clears stale interrupt bytes only after database and external ownership are empty', () => {
  const clean = graphTask('Complete and remove the stale interrupt projection.');
  rawTerminal(clean, 'done');
  markTerminalSession(clean);
  reconciler.reconcileHistoricalCallAuthorityRootPage({ pageSize: 64 });
  const first = reconciler.reconcileHistoricalInterruptPage({
    pageSize: 64,
    inspectExternalOwnership: () => ({ status: 'clear' }),
  });
  assert.equal(first.cleared, 1);
  const metadata = eventlog.getSession(clean.sessionId)?.metadata ?? {};
  assert.equal(metadata.keep, 'byte-stable-value');
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, '__interrupt_state'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, '__interrupt_mcp_scope'), false);

  const pending = graphTask('Keep the blob while an approval owns the session.');
  rawTerminal(pending, 'done');
  markTerminalSession(pending);
  reconciler.reconcileHistoricalCallAuthorityRootPage({ pageSize: 64 });
  approvals.register({ sessionId: pending.sessionId, subject: 'Still pending' });
  const held = reconciler.reconcileHistoricalInterruptPage({
    pageSize: 64,
    inspectExternalOwnership: () => ({ status: 'clear' }),
  });
  assert.ok(held.held >= 1);
  assert.equal(held.heldReasons.pending_approval, 1);
  assert.ok(eventlog.getSession(pending.sessionId)?.metadata.__interrupt_state);

  const unknown = graphTask('Keep the blob when an external store cannot be read.');
  rawTerminal(unknown, 'done');
  markTerminalSession(unknown);
  reconciler.reconcileHistoricalCallAuthorityRootPage({ pageSize: 64 });
  const externalHeld = reconciler.reconcileHistoricalInterruptPage({
    pageSize: 64,
    inspectExternalOwnership: (sessionId) => sessionId === unknown.sessionId
      ? { status: 'unknown', reason: 'fixture store read failed' }
      : { status: 'clear' },
  });
  assert.equal(externalHeld.heldReasons.external_owner_unavailable, 1);
  assert.ok(eventlog.getSession(unknown.sessionId)?.metadata.__interrupt_state);

  const uncertainChild = graphTask('Keep the blob while a child crossing is uncertain.');
  const child = settleExactProviderChild(uncertainChild, 'interrupt-uncertain');
  eventlog.openEventLog().prepare(`
    UPDATE physical_dispatches SET state = 'timed_out'
     WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
  `).run(
    uncertainChild.sessionId,
    uncertainChild.sourceUserSeq,
    child.physicalDispatchId,
  );
  rawTerminal(uncertainChild, 'done');
  markTerminalSession(uncertainChild);
  reconciler.reconcileHistoricalCallAuthorityRootPage({ pageSize: 64 });
  const childHeld = reconciler.reconcileHistoricalInterruptPage({
    pageSize: 64,
    inspectExternalOwnership: () => ({ status: 'clear' }),
  });
  assert.ok(childHeld.held >= 1);
  assert.ok(eventlog.getSession(uncertainChild.sessionId)?.metadata.__interrupt_state);
});

test('root and interrupt scans expose bounded keyset continuation', () => {
  const roots = [graphTask('Page one.'), graphTask('Page two.'), graphTask('Page three.')];
  for (const task of roots) rawTerminal(task, 'cancelled');
  const pageOne = reconciler.reconcileHistoricalCallAuthorityRootPage({ pageSize: 1 });
  assert.equal(pageOne.inspected, 1);
  assert.ok(pageOne.nextCursor);
  const pageTwo = reconciler.reconcileHistoricalCallAuthorityRootPage({
    pageSize: 1,
    cursor: pageOne.nextCursor,
  });
  assert.equal(pageTwo.inspected, 1);
  assert.ok(pageTwo.nextCursor);
  const capped = reconciler.reconcileHistoricalHarnessStateOnBoot({
    pageSize: 1,
    maxRootPages: 1,
    maxInterruptPages: 1,
    inspectExternalOwnership: () => ({ status: 'clear' }),
  });
  assert.ok(capped.roots.inspected <= 1);
  assert.equal(capped.rootPageLimitReached, true);
});

test('strict external ownership reads fail closed on live, corrupt, and over-cap stores', () => {
  const backgroundDir = path.join(TMP_HOME, 'owner-fixture', 'background');
  const workflowDir = path.join(TMP_HOME, 'owner-fixture', 'workflows');
  mkdirSync(backgroundDir, { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(path.join(backgroundDir, 'bg-live.json'), JSON.stringify({
    id: 'bg-live',
    status: 'running',
    originSessionId: 'origin-session',
  }));
  assert.deepEqual(externalOwners.inspectHistoricalSessionExternalOwnership('origin-session', {
    backgroundTaskDir: backgroundDir,
    workflowRunsDir: workflowDir,
  }), { status: 'owned', ownerKind: 'background_task', ownerId: 'bg-live' });
  writeFileSync(path.join(backgroundDir, 'bg-live.json'), JSON.stringify({
    id: 'bg-live',
    status: 'done',
    originSessionId: 'origin-session',
  }));
  writeFileSync(path.join(workflowDir, 'wf-live.json'), JSON.stringify({
    id: 'wf-live',
    workflow: 'fixture',
    status: 'running',
    originSessionIds: ['origin-session'],
  }));
  assert.equal(externalOwners.inspectHistoricalSessionExternalOwnership('origin-session', {
    backgroundTaskDir: backgroundDir,
    workflowRunsDir: workflowDir,
  }).status, 'owned');
  writeFileSync(path.join(backgroundDir, 'bg-second.json'), JSON.stringify({
    id: 'bg-second',
    status: 'done',
  }));
  assert.equal(externalOwners.inspectHistoricalSessionExternalOwnership('origin-session', {
    backgroundTaskDir: backgroundDir,
    workflowRunsDir: workflowDir,
    maxFilesPerStore: 1,
  }).status, 'unknown');
  writeFileSync(path.join(workflowDir, 'wf-live.json'), '{broken');
  assert.equal(externalOwners.inspectHistoricalSessionExternalOwnership('origin-session', {
    backgroundTaskDir: backgroundDir,
    workflowRunsDir: workflowDir,
  }).status, 'unknown');
  assert.ok(readFileSync(path.join(workflowDir, 'wf-live.json'), 'utf8').startsWith('{broken'));
});

test('a published-v3.14 migration shape admits the bounded projection and exact replay', () => {
  const filePath = path.join(TMP_HOME, 'state', 'historical-v314-reconcile.db');
  const db = new Database(filePath);
  try {
    db.pragma('foreign_keys = ON');
    eventlog.applyHarnessMigrationsThroughVersionForTests(db, 20);
    eventlog.applyHarnessMigrations(db);
    const now = '2026-08-22T12:00:00.000Z';
    const sessionId = 'historical-v314-session';
    db.prepare(`
      INSERT INTO sessions
        (id, kind, created_at, updated_at, status, metadata_json)
      VALUES (?, 'chat', ?, ?, 'completed', '{}')
    `).run(sessionId, now, now);
    const sourceJson = JSON.stringify({ text: 'Read the migrated records.' });
    db.prepare(`
      INSERT INTO events
        (seq, id, session_id, turn, role, type, parent_event_id, data_json, created_at)
      VALUES
        (1, 'historical-v314-source', ?, 1, 'user', 'user_input_received', NULL, ?, ?),
        (2, 'historical-v314-graph', ?, 1, 'system', 'turn_graph_compiled', NULL, '{}', ?)
    `).run(sessionId, sourceJson, now, sessionId, now);
    const graphHash = digest('historical-v314-graph-hash');
    const acceptedTaskId = `task:${sessionId}#1`;
    const compilerVersion = 'historical-v314-compiler';
    db.prepare(`
      INSERT INTO accepted_task_resolutions
        (session_id, source_user_seq, accepted_task_id, graph_event_id, graph_id,
         graph_hash, compiler_version, route, work_node_id, work_kind,
         effect_ceiling, external_effect_requested, external_effect_kinds_json,
         state, revision, operation_count, opened_at)
      VALUES (?, 1, ?, 'historical-v314-graph', 'historical-v314-graph-id', ?, ?,
              'retrieve', NULL, 'retrieve', 'read', 0, '[]', 'open', 0, 0, ?)
    `).run(sessionId, acceptedTaskId, graphHash, compilerVersion, now);
    const sourceDigest = eventlog.acceptedTurnSourceEventDigest({
      id: 'historical-v314-source',
      sessionId,
      seq: 1,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      parentEventId: null,
      dataJson: sourceJson,
      createdAt: now,
    });
    const surfaceInput = {
      authorityKind: 'turn_graph' as const,
      engineVersion: compilerVersion,
      surfaceVersion: 'turn_graph_ir_v1',
      effectCeiling: 'read',
      effectBoundsJson: '[]',
      maxLogicalCalls: null,
      maxParallelCalls: null,
      catalogRevisionDigest: null,
      bindingRevisionDigest: graphHash,
      graphEventId: 'historical-v314-graph',
      graphHash,
    };
    const surfaceDigest = eventlog.acceptedTurnCallSurfaceDigest(surfaceInput);
    const authorityDigest = eventlog.acceptedTurnCallAuthorityDigest({
      authorityKind: 'turn_graph',
      sessionId,
      sourceUserSeq: 1,
      acceptedTaskId,
      sourceEventId: 'historical-v314-source',
      sourceEventDigest: sourceDigest,
      sourceTurn: 1,
      engineVersion: compilerVersion,
      surfaceVersion: 'turn_graph_ir_v1',
      surfaceDigest,
      effectCeiling: 'read',
      effectBoundsJson: '[]',
      maxLogicalCalls: null,
      maxParallelCalls: null,
      catalogRevisionDigest: null,
      bindingRevisionDigest: graphHash,
      graphEventId: 'historical-v314-graph',
      graphHash,
    });
    db.prepare(`
      INSERT INTO accepted_turn_call_authorities
        (session_id, source_user_seq, accepted_task_id, authority_protocol,
         authority_kind, source_event_id, source_event_digest, source_turn,
         engine_version, surface_version, surface_digest, effect_ceiling,
         effect_bounds_json, binding_revision_digest, graph_event_id, graph_hash,
         authority_digest, state, revision, opened_at)
      VALUES (?, 1, ?, 1, 'turn_graph', 'historical-v314-source', ?, 1,
              ?, 'turn_graph_ir_v1', ?, 'read', '[]', ?,
              'historical-v314-graph', ?, ?, 'open', 0, ?)
    `).run(
      sessionId,
      acceptedTaskId,
      sourceDigest,
      compilerVersion,
      surfaceDigest,
      graphHash,
      graphHash,
      authorityDigest,
      now,
    );
    const identity = { sessionId, sourceUserSeq: 1, turn: 1 };
    const outcome: turnOutcomes.TurnOutcome = {
      version: 2,
      id: turnOutcomes.turnOutcomeId(identity),
      identity,
      status: 'done',
      resumable: false,
      presentation: { kind: 'answer', text: 'The migrated work is complete.' },
    };
    const terminalAt = '2026-08-22T12:01:00.000Z';
    db.prepare(`
      INSERT INTO events
        (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
      VALUES ('historical-v314-terminal', ?, 1, 'system',
              'conversation_completed', NULL, ?, ?)
    `).run(sessionId, JSON.stringify(delivery.completionDataForTurnOutcome(outcome)), terminalAt);
    const beforeResolution = JSON.stringify(db.prepare(`
      SELECT * FROM accepted_task_resolutions WHERE session_id = ? AND source_user_seq = 1
    `).get(sessionId));
    const first = reconciler.reconcileHistoricalCallAuthorityRootPage({ db, pageSize: 4 });
    const second = reconciler.reconcileHistoricalCallAuthorityRootPage({ db, pageSize: 4 });
    assert.equal(first.closed, 1);
    assert.equal(second.closed, 0);
    assert.deepEqual(db.prepare(`
      SELECT state, close_reason, closed_at FROM accepted_turn_call_authorities
       WHERE session_id = ? AND source_user_seq = 1
    `).get(sessionId), {
      state: 'closed',
      close_reason: 'historical_terminal_complete',
      closed_at: terminalAt,
    });
    assert.equal(JSON.stringify(db.prepare(`
      SELECT * FROM accepted_task_resolutions WHERE session_id = ? AND source_user_seq = 1
    `).get(sessionId)), beforeResolution);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('post-close terminal and child tampering revoke the historical verifier exception', () => {
  const childTask = graphTask('Settle one exact child before historical close.');
  const started = settleExactProviderChild(childTask, 'post-close');
  rawTerminal(childTask, 'done');
  reconciler.reconcileHistoricalCallAuthorityRootPage({ pageSize: 64 });
  assert.equal(authority.acceptedTurnCallAuthorityFor(
    childTask.sessionId,
    childTask.sourceUserSeq,
  ).status, 'ok');

  eventlog.openEventLog().prepare(`
    UPDATE physical_dispatches SET state = 'unknown'
     WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
  `).run(childTask.sessionId, childTask.sourceUserSeq, started.physicalDispatchId);
  assert.equal(authority.acceptedTurnCallAuthorityFor(
    childTask.sessionId,
    childTask.sourceUserSeq,
  ).status, 'conflict');

  const terminalTask = graphTask('Detect terminal identity tampering.');
  const terminalRow = rawTerminal(terminalTask, 'done');
  reconciler.reconcileHistoricalCallAuthorityRootPage({ pageSize: 64 });
  const tampered = { ...terminalRow.data, sourceUserSeq: terminalTask.sourceUserSeq + 1 };
  eventlog.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?')
    .run(JSON.stringify(tampered), terminalRow.eventId);
  assert.equal(authority.acceptedTurnCallAuthorityFor(
    terminalTask.sessionId,
    terminalTask.sourceUserSeq,
  ).status, 'conflict');

  const reasonTask = graphTask('Detect close reason tampering.');
  rawTerminal(reasonTask, 'done');
  reconciler.reconcileHistoricalCallAuthorityRootPage({ pageSize: 64 });
  const db = eventlog.openEventLog();
  db.exec('DROP TRIGGER trg_accepted_turn_call_authority_state_machine');
  db.prepare(`
    UPDATE accepted_turn_call_authorities SET close_reason = 'historical_terminal_complete_tampered'
     WHERE session_id = ? AND source_user_seq = ?
  `).run(reasonTask.sessionId, reasonTask.sourceUserSeq);
  assert.equal(authority.readAcceptedTurnCallAuthorityInTransaction(
    db,
    reasonTask.sessionId,
    reasonTask.sourceUserSeq,
  ).status, 'conflict');
});
