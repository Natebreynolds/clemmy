import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-turn-call-authority-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const authority = await import('./accepted-turn-call-authority.js');
const dispatch = await import('./dispatch-ledger.js');
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./logical-call-contract.js');
const delivery = await import('./delivery-committer.js');
const turnOutcomes = await import('./turn-outcome.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const resolution = await import('./resolution-ledger.js');
const approvals = await import('./approval-registry.js');
const effects = await import('./tool-effect.js');
const hostBindings = await import('./host-call-capability-binding.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function acceptedSource(text = 'Read the current records.', turn = 1) {
  const session = eventlog.createSession({ id: `host-call-authority-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

test('turn zero is a valid first source for both host authority modes', () => {
  const readOnly = acceptedSource('Read the first-turn records.', 0);
  const readOnlyArmed = armHost(readOnly);
  assert.equal(readOnlyArmed.status, 'armed');
  if (readOnlyArmed.status === 'armed') assert.equal(readOnlyArmed.authority.identity.sourceTurn, 0);
  assert.equal(authority.closeHostReadOnlyCallAuthority({
    sessionId: readOnly.sessionId,
    sourceUserSeq: readOnly.sourceUserSeq,
    outcome: 'completed',
  }).status, 'closed');

  const production = acceptedSource('Handle the first-turn request.', 0);
  const productionArmed = armProductionHost(production);
  assert.equal(productionArmed.status, 'armed');
  if (productionArmed.status === 'armed') assert.equal(productionArmed.authority.identity.sourceTurn, 0);
  assert.equal(authority.closeHostCallAuthority({
    sessionId: production.sessionId,
    sourceUserSeq: production.sourceUserSeq,
    outcome: 'completed',
  }).status, 'closed');
});

function armHost(
  task: ReturnType<typeof acceptedSource>,
  overrides: Partial<authority.ArmHostReadOnlyCallAuthorityInput> = {},
) {
  return authority.armHostReadOnlyCallAuthority({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    surfaceVersion: 'configured_harness_tools_v1',
    catalogRevisionDigest: digest(`catalog:${task.sessionId}`),
    bindingRevisionDigest: digest(`bindings:${task.sessionId}`),
    maxLogicalCalls: 8,
    maxParallelCalls: 4,
    ...overrides,
  });
}

function withHostAttestation<T>(
  task: ReturnType<typeof acceptedSource>,
  logicalToolCallId: string,
  tool: string,
  args: unknown,
  work: () => T,
  overrides: Partial<Parameters<typeof authority.withHostReadOnlyCallAttestation>[0]> = {},
): T {
  const loaded = authority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status, 'ok');
  if (loaded.status !== 'ok') throw new Error(loaded.reason);
  const contract = contracts.durableLogicalCallContract(task.acceptedTaskId, tool, args);
  assert.ok(contract);
  return authority.withHostReadOnlyCallAttestation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    sourceEventId: loaded.authority.sourceEventId,
    sourceEventDigest: loaded.authority.sourceEventDigest,
    logicalToolCallId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    engineVersion: loaded.authority.engineVersion,
    surfaceVersion: loaded.authority.surfaceVersion,
    authorityDigest: loaded.authority.authorityDigest,
    authorityRevision: loaded.authority.revision,
    surfaceDigest: loaded.authority.surfaceDigest,
    catalogRevisionDigest: loaded.authority.catalogRevisionDigest!,
    bindingRevisionDigest: loaded.authority.bindingRevisionDigest!,
    ...overrides,
  }, work);
}

function armProductionHost(task: ReturnType<typeof acceptedSource>) {
  return authority.armHostCallAuthority({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    catalogRevisionDigest: digest(`production-catalog:${task.sessionId}`),
    bindingRevisionDigest: digest(`production-bindings:${task.sessionId}`),
    maxLogicalCalls: 8,
    maxParallelCalls: 4,
  });
}

function withProductionHostAttestation<T>(
  task: ReturnType<typeof acceptedSource>,
  logicalToolCallId: string,
  tool: string,
  args: unknown,
  effect: authority.HostAdmissibleEffect,
  work: (attestation: authority.HostCallAttestation) => T,
): T {
  const loaded = authority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status, 'ok');
  if (loaded.status !== 'ok') throw new Error(loaded.reason);
  const contract = contracts.durableLogicalCallContract(task.acceptedTaskId, tool, args);
  assert.ok(contract);
  const schemaFingerprint = digest(`schema:${tool}`);
  const attestationBase = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    sourceEventId: loaded.authority.sourceEventId,
    sourceEventDigest: loaded.authority.sourceEventDigest,
    logicalToolCallId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect,
    bindingKind: 'local_envelope',
    capabilityId: tool,
    schemaFingerprint,
    accountId: '',
    invokePortId: `configured-wrapper:${schemaFingerprint}`,
    operationId: tool,
    manifestId: '',
    manifestDigest: '',
    engineVersion: loaded.authority.engineVersion,
    surfaceVersion: loaded.authority.surfaceVersion,
    authorityDigest: loaded.authority.authorityDigest,
    authorityRevision: loaded.authority.revision,
    surfaceDigest: loaded.authority.surfaceDigest,
    catalogRevisionDigest: loaded.authority.catalogRevisionDigest!,
    bindingRevisionDigest: loaded.authority.bindingRevisionDigest!,
  } as const;
  const attestation: authority.HostCallAttestation = {
    ...attestationBase,
    bindingDigest: hostBindings.hostCallAttestationBindingDigest(attestationBase),
  };
  return authority.withHostCallAttestation(attestation, () => work(attestation));
}

test('a corrupt persisted late approval cannot authorize a one-shot activation or body', () => {
  const session = eventlog.createSession({ id: `late-one-shot-${++serial}`, kind: 'workflow' });
  const registered = approvals.registerResumable({
    sessionId: session.id,
    subject: 'Authorize the exact background read once',
    tool: 'workflow_node_read',
    args: { page: 1 },
    resumeKey: `late-one-shot:${serial}`,
  });
  const requestedAt = new Date(Date.now() - 3_000).toISOString();
  const expiresAt = new Date(Date.now() - 2_000).toISOString();
  const resolvedAt = new Date(Date.now() - 1_000).toISOString();
  const db = eventlog.openEventLog();
  db.prepare(`
    UPDATE pending_approvals
       SET requested_at = ?, expires_at = ?, status = 'resolved',
           resolution = 'approved', resolver = 'historical-writer',
           resolved_at = ?, consumed_at = NULL
     WHERE approval_id = ?
  `).run(requestedAt, expiresAt, resolvedAt, registered.row.approvalId);
  const decisionDigest = authority.oneShotActivationAuthorizationDecisionDigest({
    approvalId: registered.row.approvalId,
    approvalSessionId: session.id,
    resumeKey: registered.row.resumeKey!,
    requestedAt,
    expiresAt,
    subject: registered.row.subject,
    tool: registered.row.tool,
    args: registered.row.args,
    resolver: 'historical-writer',
    resolvedAt,
  });
  let bodies = 0;
  const consumed = db.transaction(() => {
    const result = authority.consumeOneShotActivationAuthorizationInTransaction(db, {
      approvalId: registered.row.approvalId,
      resumeKey: registered.row.resumeKey!,
      decisionDigest,
    });
    if (result.ok) bodies += 1;
    return result;
  }).immediate();
  assert.deepEqual(consumed, {
    ok: false,
    reason: 'workflow activation one-shot authorization is not exact and approved',
  });
  assert.equal(bodies, 0, 'late approval never reaches the activation body');
  assert.equal(approvals.get(registered.row.approvalId)?.consumedAt, null);
});

test('host chat owns a bounded graphless read from arm through logical settlement and close', () => {
  const task = acceptedSource();
  const armed = armHost(task);
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;
  assert.equal(armed.authority.authorityKind, 'host_v1_read_only');
  assert.deepEqual(armed.authority.effectBounds, ['compute', 'host_only', 'read']);
  assert.equal(armed.authority.maxLogicalCalls, 8);
  assert.equal(armed.authority.maxParallelCalls, 4);
  assert.throws(() => eventlog.openEventLog().prepare(`
    INSERT INTO accepted_task_resolutions
      (session_id, source_user_seq, accepted_task_id, graph_event_id, graph_id,
       graph_hash, compiler_version, route, work_node_id, work_kind,
       effect_ceiling, external_effect_requested, external_effect_kinds_json,
       opened_at)
    VALUES (?, ?, ?, ?, 'graph:forged', ?, 'forged-v1', 'retrieve',
            'work:forged', 'retrieve', 'read', 0, '[]', ?)
  `).run(
    task.sessionId,
    task.sourceUserSeq,
    task.acceptedTaskId,
    armed.authority.sourceEventId,
    digest('forged-graph'),
    new Date().toISOString(),
  ), /graph resolution cannot replace non-graph call authority/);

  const logicalToolCallId = 'host-read-call-1';
  const args = { limit: 5 };
  const crossing = withHostAttestation(task, logicalToolCallId, 'session_history', args, () => {
    const logical = dispatch.admitLogicalCall({
      identity: { ...task, logicalToolCallId },
      tool: 'session_history',
      args,
    });
    assert.equal(logical.status, 'inserted');
    const admitted = dispatch.beginPhysicalDispatch({
      identity: {
        ...task,
        logicalToolCallId,
        physicalDispatchId: 'host-read-dispatch-1',
        ordinal: 0,
      },
      tool: 'session_history',
      args,
      executionSite: 'host',
    });
    assert.equal(admitted.status, 'inserted');
    return admitted;
  });
  if (crossing.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: crossing.identity,
    tool: 'session_history',
    outcome: 'returned',
  }).status, 'inserted');

  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName: 'session_history', args },
    execution: { kind: 'local_execution' },
    result: { payload: { records: [{ id: 'record-1' }] } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'agents_runner', callId: logicalToolCallId, turn: task.turn },
  });
  assert.equal(settled.status, 'committed');
  if (settled.status !== 'committed') return;
  assert.equal(settled.settlement.physicalCrossingCount, 0);
  assert.equal(settled.settlement.hostCrossingCount, 1);
  assert.equal(dispatch.logicalCallAuthorityState({ ...task, logicalToolCallId }).status, 'settled');

  assert.equal(authority.closeHostReadOnlyCallAuthority({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    outcome: 'not-an-outcome' as never,
  }).status, 'conflict');

  const closed = authority.closeHostReadOnlyCallAuthority({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    outcome: 'completed',
  });
  assert.equal(closed.status, 'closed');
  assert.equal(authority.closeHostReadOnlyCallAuthority({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    outcome: 'completed',
  }).status, 'replayed');

  const db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM accepted_task_resolutions
        WHERE session_id = ? AND source_user_seq = ?) AS resolutions,
      (SELECT COUNT(*) FROM events
        WHERE session_id = ? AND type = 'turn_graph_compiled') AS graphs,
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?) AS logical_calls,
      (SELECT COUNT(*) FROM logical_call_settlements
        WHERE session_id = ? AND source_user_seq = ?) AS settlements
  `).get(
    task.sessionId,
    task.sourceUserSeq,
    task.sessionId,
    task.sessionId,
    task.sourceUserSeq,
    task.sessionId,
    task.sourceUserSeq,
  ), { resolutions: 0, graphs: 0, logical_calls: 1, settlements: 1 });
});

test('a direct host-ledger bypass has zero body and crossing without the exact call attestation', () => {
  const logicalTask = acceptedSource('Inspect the current directory with a raw shell carrier.');
  assert.equal(armHost(logicalTask).status, 'armed');
  let bodies = 0;
  const direct = dispatch.admitLogicalCall({
    identity: { ...logicalTask, logicalToolCallId: 'direct-read-bypass' },
    tool: 'run_shell_command',
    args: { command: 'pwd' },
  });
  if (direct.status === 'inserted' || direct.status === 'replayed') bodies += 1;
  assert.equal(direct.status, 'conflict');
  assert.match('reason' in direct ? direct.reason : '', /lacks exact live capability attestation/);
  assert.equal(bodies, 0);

  const physicalTask = acceptedSource('Read another local file listing.');
  assert.equal(armHost(physicalTask).status, 'armed');
  const crossing = dispatch.beginPhysicalDispatch({
    identity: {
      ...physicalTask,
      logicalToolCallId: 'direct-crossing-bypass',
      physicalDispatchId: 'direct-crossing-bypass-1',
      ordinal: 0,
    },
    tool: 'list_files',
    args: { directory: null, limit: 1 },
    executionSite: 'host',
  });
  assert.equal(crossing.status, 'conflict');
  assert.match('reason' in crossing ? crossing.reason : '', /lacks exact live capability attestation/);

  const revisionTask = acceptedSource('Read with a stale root revision.');
  assert.equal(armHost(revisionTask).status, 'armed');
  const staleRevision = withHostAttestation(
    revisionTask,
    'stale-revision-bypass',
    'list_files',
    { directory: null, limit: 1 },
    () => dispatch.admitLogicalCall({
      identity: { ...revisionTask, logicalToolCallId: 'stale-revision-bypass' },
      tool: 'list_files',
      args: { directory: null, limit: 1 },
    }),
    { authorityRevision: 1 },
  );
  assert.equal(staleRevision.status, 'conflict');

  const sourceDigestTask = acceptedSource('Read with a foreign source digest.');
  assert.equal(armHost(sourceDigestTask).status, 'armed');
  const foreignSourceDigest = withHostAttestation(
    sourceDigestTask,
    'foreign-source-digest-bypass',
    'list_files',
    { directory: null, limit: 1 },
    () => dispatch.admitLogicalCall({
      identity: { ...sourceDigestTask, logicalToolCallId: 'foreign-source-digest-bypass' },
      tool: 'list_files',
      args: { directory: null, limit: 1 },
    }),
    { sourceEventDigest: digest('foreign accepted source') },
  );
  assert.equal(foreignSourceDigest.status, 'conflict');

  const db = eventlog.openEventLog();
  for (const task of [logicalTask, physicalTask, revisionTask, sourceDigestTask]) {
    assert.deepEqual(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM logical_tool_calls
          WHERE session_id = ? AND source_user_seq = ?) AS logical_calls,
        (SELECT COUNT(*) FROM physical_dispatches
          WHERE session_id = ? AND source_user_seq = ?) AS physical_crossings
    `).get(
      task.sessionId,
      task.sourceUserSeq,
      task.sessionId,
      task.sourceUserSeq,
    ), { logical_calls: 0, physical_crossings: 0 });
    const poisoned = authority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
    assert.equal(poisoned.status, 'conflict');
  }
});

test('host root checks writes, unsettled closure, and source drift without a queued or lifetime call cap', () => {
  const writeTask = acceptedSource('Update the workflow.');
  assert.equal(armHost(writeTask).status, 'armed');
  const write = dispatch.admitLogicalCall({
    identity: { ...writeTask, logicalToolCallId: 'host-write-call' },
    tool: 'workflow_update',
    args: { id: 'workflow-1' },
  });
  assert.equal(write.status, 'conflict');
  assert.equal(
    (eventlog.openEventLog().prepare(`SELECT COUNT(*) AS n FROM logical_tool_calls
      WHERE session_id = ? AND source_user_seq = ?`).get(
      writeTask.sessionId,
      writeTask.sourceUserSeq,
    ) as { n: number }).n,
    0,
  );

  const cappedTask = acceptedSource();
  assert.equal(armHost(cappedTask, { maxLogicalCalls: 2, maxParallelCalls: 1 }).status, 'armed');
  assert.equal(withHostAttestation(cappedTask, 'parallel-1', 'session_history', {}, () =>
    dispatch.admitLogicalCall({
      identity: { ...cappedTask, logicalToolCallId: 'parallel-1' },
      tool: 'session_history',
      args: {},
    })).status, 'inserted');
  const second = withHostAttestation(cappedTask, 'parallel-2', 'session_history', {}, () =>
    dispatch.admitLogicalCall({
      identity: { ...cappedTask, logicalToolCallId: 'parallel-2' },
      tool: 'session_history',
      args: {},
    }));
  assert.equal(second.status, 'inserted', 'prepared calls can wait for the host execution queue');
  const third = withHostAttestation(cappedTask, 'continued-3', 'session_history', {}, () =>
    dispatch.admitLogicalCall({ identity: { ...cappedTask, logicalToolCallId: 'continued-3' },
      tool: 'session_history', args: {} }));
  assert.equal(third.status, 'inserted', 'a source outlives its first activation budget');
  assert.equal(authority.closeHostReadOnlyCallAuthority({
    sessionId: cappedTask.sessionId,
    sourceUserSeq: cappedTask.sourceUserSeq,
    outcome: 'completed',
  }).status, 'not_ready');

  const driftTask = acceptedSource();
  assert.equal(armHost(driftTask).status, 'armed');
  const db = eventlog.openEventLog();
  const source = db.prepare('SELECT data_json FROM events WHERE seq = ?').get(
    driftTask.sourceUserSeq,
  ) as { data_json: string };
  db.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(
    JSON.stringify({ ...JSON.parse(source.data_json), text: 'tampered after arm' }),
    driftTask.sourceUserSeq,
  );
  assert.equal(
    authority.acceptedTurnCallAuthorityFor(driftTask.sessionId, driftTask.sourceUserSeq).status,
    'conflict',
  );
});

test('production host owns an approval-ready local write through the shared call kernel', () => {
  const task = acceptedSource('Create a generic background worker job.');
  const armed = armProductionHost(task);
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;
  assert.equal(armed.authority.authorityKind, 'host_v1');
  assert.deepEqual(armed.authority.effectBounds, [
    'admin', 'compute', 'external_write', 'host_only', 'local_write', 'read',
  ]);
  const args = { objective: 'summarize the accepted task', mode: 'background' };
  const logicalToolCallId = 'production-worker-call';
  const crossing = withProductionHostAttestation(
    task,
    logicalToolCallId,
    'run_worker',
    args,
    'local_write',
    () => {
      const admitted = dispatch.admitLogicalCall({
        identity: { ...task, logicalToolCallId },
        tool: 'run_worker',
        args,
      });
      assert.equal(admitted.status, 'inserted');
      return dispatch.beginPhysicalDispatch({
        identity: {
          ...task,
          logicalToolCallId,
          physicalDispatchId: 'production-worker-crossing',
          ordinal: 0,
        },
        tool: 'run_worker',
        args,
        executionSite: 'host',
      });
    },
  );
  assert.equal(crossing.status, 'inserted');
  if (crossing.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: crossing.identity,
    tool: 'run_worker',
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName: 'run_worker', args },
    execution: { kind: 'local_execution' },
    result: { payload: { status: 'queued' } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'agents_runner', callId: logicalToolCallId, turn: task.turn },
  });
  assert.equal(settled.status, 'committed');
  assert.equal(authority.closeHostCallAuthority({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    outcome: 'completed',
  }).status, 'closed');
});

test('resolved provider spelling cannot poison an exact no-op refinement of a durably bound read', () => {
  const task = acceptedSource('Read one exact value through the resolved provider operation.');
  assert.equal(armProductionHost(task).status, 'armed');
  const logicalToolCallId = 'opaque-provider-read-refinement';
  // This deliberately resembles the lowercase resolved carrier from live
  // source 127466. It has no spelling/registry taxonomy of its own; the exact
  // host capability binding is the effect authority.
  const tool = `opaque_provider_values_lookup_${serial}`;
  const rawArgs = '{"range":"Sheet1!V997","resource_id":"sheet-1"}';
  const effectiveArgs = { resource_id: 'sheet-1', range: 'Sheet1!V997' };
  assert.equal(effects.classifyRuntimeToolEffect(tool, effectiveArgs).effect, 'unknown');

  const result = withProductionHostAttestation(
    task,
    logicalToolCallId,
    tool,
    rawArgs,
    'read',
    (attestation) => {
      const admitted = dispatch.admitLogicalCall({
        identity: { ...task, logicalToolCallId },
        tool,
        args: rawArgs,
      });
      assert.equal(admitted.status, 'inserted');
      if (admitted.status !== 'inserted') throw new Error('fixture logical admission failed');
      const bound = hostBindings.persistHostCallCapabilityBinding({
        db: eventlog.openEventLog(),
        attestation,
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        logicalToolCallId,
        acceptedTaskId: task.acceptedTaskId,
        toolName: admitted.identity.toolName,
        argumentDigest: admitted.identity.argumentDigest,
        effect: 'read',
      });
      assert.equal(bound.status, 'bound');
      assert.deepEqual(eventlog.openEventLog().prepare(`
        SELECT effect, attested_argument_digest, logical_raw_argument_digest,
               bound_effective_argument_digest
          FROM host_call_capability_bindings
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(task.sessionId, task.sourceUserSeq, logicalToolCallId), {
        effect: 'read',
        attested_argument_digest: admitted.identity.argumentDigest,
        logical_raw_argument_digest: admitted.identity.argumentDigest,
        bound_effective_argument_digest: null,
      });
      return dispatch.refineLogicalCallContract({
        identity: { ...task, logicalToolCallId },
        tool,
        effectiveArgs,
      });
    },
  );

  assert.equal(result.status, 'replayed', 'canonical no-op reuses the sealed read effect');
  assert.deepEqual(eventlog.openEventLog().prepare(`
    SELECT state, argument_digest, raw_argument_digest, effective_argument_digest
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, logicalToolCallId), {
    state: 'open',
    argument_digest: result.status === 'replayed' ? result.identity.argumentDigest : '',
    raw_argument_digest: result.status === 'replayed' ? result.identity.rawArgumentDigest : '',
    effective_argument_digest: null,
  });
  const root = authority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(root.status, 'ok');
  if (root.status === 'ok') assert.equal(root.authority.state, 'open');
  assert.equal(dispatch.physicalCrossingsFor(task.sessionId, task.sourceUserSeq).length, 0);
});

test('the canonical failed terminal poisons one host root, finishes its attempt, and clears only its marker', () => {
  const session = eventlog.createSession({ id: `host-failed-terminal-${++serial}`, kind: 'chat' });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `host-failed-run-${serial}` });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Attempt one bounded read.' },
  }, { armRunInFlight: true });
  const task = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
  assert.equal(armHost(task).status, 'armed');
  const identity = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
  };
  const failed = {
    version: 2 as const,
    id: turnOutcomes.turnOutcomeId(identity),
    identity,
    status: 'failed' as const,
    resumable: false as const,
    presentation: { kind: 'error' as const, text: 'The bounded read failed safely.' },
  };
  const terminal = eventlog.appendTerminalEventOnce({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'system',
    data: {
      ...delivery.completionDataForTurnOutcome(failed),
      attemptId: attempt.attemptId,
      sourceUserSeq: task.sourceUserSeq,
    },
  }, failed.id);
  assert.equal(terminal.inserted, true);
  assert.equal(eventlog.appendTerminalEventOnce({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'system',
    data: {
      ...delivery.completionDataForTurnOutcome(failed),
      attemptId: attempt.attemptId,
      sourceUserSeq: task.sourceUserSeq,
    },
  }, failed.id).inserted, false);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['conversation_completed'] }).length, 1);
  const poisoned = authority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(poisoned.status, 'conflict');
  if (poisoned.status === 'conflict') assert.equal(poisoned.reason, 'host_failed');
  const finished = eventlog.getLatestRunAttempt(task.sessionId);
  assert.equal(finished?.attemptId, attempt.attemptId);
  assert.equal(finished?.status, 'failed');
  assert.ok(finished?.finishedAt);
  const metadata = eventlog.getSession(task.sessionId)?.metadata ?? {};
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, '__run_in_flight'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, '__run_in_flight_owner'), false);
});

test('graph calls get the shared root without losing graph resolution or expected-work closure', () => {
  const task = acceptedSource('Find the current records.');
  const graphEvent = shadow.recordTurnGraphShadow({
    identity: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: task.turn },
  });
  assert.ok(graphEvent);
  const expected = resolution.expectedTaskFor(task.sessionId, task.sourceUserSeq);
  assert.equal(expected.status, 'ok');
  if (expected.status !== 'ok' || !expected.expectation.workNodeId) return;
  assert.equal(resolution.recordResolvedOperation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    nodeId: expected.expectation.workNodeId,
    operationId: 'graph-read-operation',
    resolvedTool: 'session_history',
    logicalToolCallId: 'graph-read-logical',
    args: {},
    outcomeKind: 'succeeded',
    dispatchState: 'not_started',
  }), true);
  const open = authority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(open.status, 'ok');
  if (open.status !== 'ok') return;
  assert.equal(open.authority.authorityKind, 'turn_graph');
  assert.equal(open.authority.graphEventId, expected.expectation.graphEventId);
  assert.equal(open.authority.maxLogicalCalls, undefined);
  assert.equal(resolution.finalizeResolution(task), true);
  const closed = authority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(closed.status, 'ok');
  if (closed.status === 'ok') {
    assert.equal(closed.authority.state, 'closed');
    assert.equal(closed.authority.closeReason, 'graph_finalized');
  }
  assert.equal(
    (eventlog.openEventLog().prepare(`SELECT state FROM accepted_task_resolutions
      WHERE session_id = ? AND source_user_seq = ?`).get(
      task.sessionId,
      task.sourceUserSeq,
    ) as { state: string }).state,
    'finalized',
  );
});

test('schema v52 preserves graph/v51 roots and children; v53 refuses a sparse missing lease ledger', () => {
  const rehearsalPath = path.join(TMP_HOME, 'state', 'schema-v49-call-authority-rehearsal.db');
  const db = new Database(rehearsalPath);
  db.pragma('foreign_keys = ON');
  const graphHash = 'a'.repeat(64);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_version VALUES (49, '2026-08-21T00:00:00.000Z');
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    INSERT INTO sessions VALUES ('migration-session');
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn INTEGER NOT NULL,
      role TEXT NOT NULL,
      type TEXT NOT NULL,
      parent_event_id TEXT,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO events
      (seq,id,session_id,turn,role,type,parent_event_id,data_json,created_at)
    VALUES
      (1,'source-1','migration-session',0,'user','user_input_received',NULL,
       '{"text":"read records"}','2026-08-21T00:00:01.000Z'),
      (2,'graph-1','migration-session',1,'system','turn_graph_compiled',NULL,
       '{}','2026-08-21T00:00:02.000Z');
    CREATE TABLE accepted_task_resolutions (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_user_seq INTEGER NOT NULL,
      accepted_task_id TEXT NOT NULL UNIQUE,
      graph_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
      graph_id TEXT NOT NULL,
      graph_hash TEXT NOT NULL,
      compiler_version TEXT NOT NULL,
      route TEXT NOT NULL,
      work_node_id TEXT,
      work_kind TEXT NOT NULL,
      effect_ceiling TEXT NOT NULL,
      external_effect_requested INTEGER NOT NULL,
      external_effect_kinds_json TEXT NOT NULL,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL,
      operation_count INTEGER NOT NULL,
      operations_digest TEXT,
      expectations_satisfied INTEGER,
      opened_at TEXT NOT NULL,
      finalized_at TEXT,
      finalize_event_id TEXT,
      PRIMARY KEY (session_id, source_user_seq)
    );
    INSERT INTO accepted_task_resolutions VALUES
      ('migration-session',1,'task:migration-session#1','graph-1','graph:test',
       '${graphHash}','turn-graph-shadow-v2','retrieve','work-1','retrieve','read',
       0,'[]','open',0,0,NULL,NULL,'2026-08-21T00:00:03.000Z',NULL,NULL);
    CREATE TABLE logical_tool_calls (
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      accepted_task_id TEXT NOT NULL,
      logical_tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      argument_digest TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      opened_at TEXT NOT NULL,
      settled_at TEXT,
      settlement_event_id TEXT,
      outcome_kind TEXT,
      raw_argument_digest TEXT,
      effective_argument_digest TEXT,
      refined_at TEXT,
      refinement_event_id TEXT,
      conflict_reason TEXT,
      PRIMARY KEY (session_id, source_user_seq, logical_tool_call_id),
      FOREIGN KEY (session_id, source_user_seq)
        REFERENCES accepted_task_resolutions(session_id, source_user_seq) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX uq_rehearsal_logical_tool
      ON logical_tool_calls(session_id, source_user_seq, tool_name);
    CREATE TRIGGER trg_rehearsal_logical_immutable
      BEFORE UPDATE OF tool_name ON logical_tool_calls
      BEGIN SELECT RAISE(ABORT, 'tool identity immutable'); END;
    CREATE TRIGGER trg_logical_call_contract_refinement_once
      BEFORE UPDATE OF argument_digest ON logical_tool_calls
      BEGIN SELECT RAISE(ABORT, 'old refinement trigger'); END;
    INSERT INTO logical_tool_calls
      (session_id,source_user_seq,accepted_task_id,logical_tool_call_id,
       tool_name,argument_digest,state,opened_at,raw_argument_digest)
    VALUES
      ('migration-session',1,'task:migration-session#1','logical-1',
       'session_history','${'b'.repeat(64)}','open','2026-08-21T00:00:04.000Z','${'b'.repeat(64)}');
    CREATE TABLE physical_dispatches (
      session_id TEXT NOT NULL, source_user_seq INTEGER NOT NULL,
      logical_tool_call_id TEXT NOT NULL, physical_dispatch_id TEXT NOT NULL,
      PRIMARY KEY (session_id,source_user_seq,physical_dispatch_id),
      FOREIGN KEY (session_id,source_user_seq,logical_tool_call_id)
        REFERENCES logical_tool_calls(session_id,source_user_seq,logical_tool_call_id) ON DELETE CASCADE
    );
    INSERT INTO physical_dispatches VALUES ('migration-session',1,'logical-1','physical-1');
    CREATE TABLE logical_call_settlements (
      session_id TEXT NOT NULL, source_user_seq INTEGER NOT NULL,
      logical_tool_call_id TEXT NOT NULL,
      PRIMARY KEY (session_id,source_user_seq,logical_tool_call_id),
      FOREIGN KEY (session_id,source_user_seq,logical_tool_call_id)
        REFERENCES logical_tool_calls(session_id,source_user_seq,logical_tool_call_id) ON DELETE CASCADE
    );
    INSERT INTO logical_call_settlements VALUES ('migration-session',1,'logical-1');
    CREATE TABLE expected_work_call_bindings (
      session_id TEXT NOT NULL, source_user_seq INTEGER NOT NULL,
      logical_tool_call_id TEXT NOT NULL,
      PRIMARY KEY (session_id,source_user_seq,logical_tool_call_id),
      FOREIGN KEY (session_id,source_user_seq,logical_tool_call_id)
        REFERENCES logical_tool_calls(session_id,source_user_seq,logical_tool_call_id) ON DELETE CASCADE
    );
    INSERT INTO expected_work_call_bindings VALUES ('migration-session',1,'logical-1');
    CREATE TABLE write_evidence_dispatch_reservations (
      session_id TEXT NOT NULL, source_user_seq INTEGER NOT NULL,
      logical_tool_call_id TEXT NOT NULL,
      PRIMARY KEY (session_id,source_user_seq,logical_tool_call_id),
      FOREIGN KEY (session_id,source_user_seq,logical_tool_call_id)
        REFERENCES logical_tool_calls(session_id,source_user_seq,logical_tool_call_id) ON DELETE CASCADE
    );
    INSERT INTO write_evidence_dispatch_reservations VALUES ('migration-session',1,'logical-1');
  `);

  assert.throws(
    () => eventlog.applyHarnessMigrations(db),
    /schema v53 prerequisite missing: run_dispatch_leases/,
    'the host deadline migration cannot stamp a database that lacks its physical lease authority',
  );
  assert.equal(Number(db.pragma('foreign_keys', { simple: true })), 1);
  assert.equal(
    (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
    52,
  );
  assert.deepEqual(db.prepare(`
    SELECT authority_kind, accepted_task_id, graph_event_id, graph_hash, state
      FROM accepted_turn_call_authorities
  `).get(), {
    authority_kind: 'turn_graph',
    accepted_task_id: 'task:migration-session#1',
    graph_event_id: 'graph-1',
    graph_hash: graphHash,
    state: 'open',
  });
  const activationColumns = new Set((db.prepare(
    'PRAGMA table_info(workflow_node_invocation_activations)',
  ).all() as Array<{ name: string }>).map((column) => column.name));
  for (const column of [
    'activation_id',
    'invocation_plan_digest',
    'binding_snapshot_digest',
    'control_digest',
    'one_shot_authorization_approval_id',
    'one_shot_authorization_resume_key',
    'one_shot_authorization_decision_digest',
  ]) assert.ok(activationColumns.has(column), `workflow activation keeps ${column}`);
  for (const table of [
    'workflow_paginated_read_activations',
    'workflow_paginated_read_pages',
    'workflow_paginated_cursor_visits',
    'workflow_paginated_aggregate_receipts',
  ]) assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
  const rootSql = (db.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'accepted_turn_call_authorities'`).get() as { sql: string }).sql;
  assert.match(rootSql, /workflow_v2_paginated_read/);
  const logicalParent = (db.prepare('PRAGMA foreign_key_list(logical_tool_calls)').all() as Array<{
    table: string;
  }>).map((fk) => fk.table);
  assert.deepEqual(new Set(logicalParent), new Set(['accepted_turn_call_authorities']));
  for (const child of [
    'physical_dispatches',
    'logical_call_settlements',
    'expected_work_call_bindings',
    'write_evidence_dispatch_reservations',
  ]) {
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${child}`).get() as { n: number }).n,
      1,
      `${child} rows survive`,
    );
    assert.ok((db.prepare(`PRAGMA foreign_key_list(${child})`).all() as Array<{ table: string }>)
      .some((fk) => fk.table === 'logical_tool_calls'), `${child} still parents to logical calls`);
  }
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type = 'index' AND name = 'uq_rehearsal_logical_tool'`).get());
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type = 'trigger' AND name = 'trg_rehearsal_logical_immutable'`).get());
  const refinement = db.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'trigger' AND name = 'trg_logical_call_contract_refinement_once'`).get() as { sql: string };
  assert.match(refinement.sql, /accepted_turn_call_authorities/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  assert.throws(
    () => eventlog.applyHarnessMigrations(db),
    /schema v53 prerequisite missing: run_dispatch_leases/,
    'rehearsing again remains at the same fail-closed v53 boundary',
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM logical_tool_calls').get() as { n: number }).n, 1);
  db.close();
});

test('schema v53 to v54 preserves roots and children byte-for-byte and reruns idempotently', () => {
  const rehearsalPath = path.join(TMP_HOME, 'state', 'schema-v53-host-v1-rehearsal.db');
  const db = new Database(rehearsalPath);
  db.pragma('foreign_keys = ON');
  eventlog.applyHarnessMigrationsThroughVersionForTests(db, 53);
  const now = '2026-08-22T00:00:00.000Z';
  db.prepare(`INSERT INTO sessions (id,kind,created_at,updated_at,status)
    VALUES ('v54-rehearsal','chat',?,?,'active')`).run(now, now);
  db.prepare(`INSERT INTO events
    (id,session_id,turn,role,type,parent_event_id,data_json,created_at)
    VALUES ('v54-source','v54-rehearsal',1,'user','user_input_received',NULL,'{"text":"read"}',?)`).run(now);
  const source = db.prepare(`SELECT seq FROM events WHERE id = 'v54-source'`).get() as { seq: number };
  const sourceDigest = eventlog.acceptedTurnSourceEventDigest({
    id: 'v54-source',
    sessionId: 'v54-rehearsal',
    seq: source.seq,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    parentEventId: null,
    dataJson: '{"text":"read"}',
    createdAt: now,
  });
  const rootInput = {
    authorityKind: 'host_v1_read_only' as const,
    engineVersion: 'host_v1_read_only',
    surfaceVersion: 'configured_harness_tools_v1',
    effectCeiling: 'read_compute_host_only',
    effectBoundsJson: '["compute","host_only","read"]',
    maxLogicalCalls: 4,
    maxParallelCalls: 2,
    catalogRevisionDigest: digest('v53-catalog'),
    bindingRevisionDigest: digest('v53-binding'),
    graphEventId: null,
    graphHash: null,
  };
  const surfaceDigest = eventlog.acceptedTurnCallSurfaceDigest(rootInput);
  const acceptedTaskId = `task:v54-rehearsal#${source.seq}`;
  const authorityDigest = eventlog.acceptedTurnCallAuthorityDigest({
    ...rootInput,
    sessionId: 'v54-rehearsal',
    sourceUserSeq: source.seq,
    acceptedTaskId,
    sourceEventId: 'v54-source',
    sourceEventDigest: sourceDigest,
    sourceTurn: 1,
    surfaceDigest,
  });
  db.prepare(`INSERT INTO accepted_turn_call_authorities
    (session_id,source_user_seq,accepted_task_id,authority_protocol,authority_kind,
     source_event_id,source_event_digest,source_turn,engine_version,surface_version,
     surface_digest,effect_ceiling,effect_bounds_json,max_logical_calls,max_parallel_calls,
     catalog_revision_digest,binding_revision_digest,graph_event_id,graph_hash,
     authority_digest,state,revision,opened_at)
    VALUES ('v54-rehearsal',?,?,1,'host_v1_read_only','v54-source',?,1,
      'host_v1_read_only','configured_harness_tools_v1',?,'read_compute_host_only',
      '["compute","host_only","read"]',4,2,?,?,NULL,NULL,?,'open',0,?)`).run(
    source.seq,
    acceptedTaskId,
    sourceDigest,
    surfaceDigest,
    rootInput.catalogRevisionDigest,
    rootInput.bindingRevisionDigest,
    authorityDigest,
    now,
  );
  db.prepare(`INSERT INTO logical_tool_calls
    (session_id,source_user_seq,accepted_task_id,logical_tool_call_id,tool_name,
     argument_digest,raw_argument_digest,state,opened_at)
    VALUES ('v54-rehearsal',?,?, 'v53-call','session_history',?,?, 'open',?)`).run(
    source.seq,
    acceptedTaskId,
    digest('v53-args'),
    digest('v53-args'),
    now,
  );
  const beforeRoot = JSON.stringify(db.prepare(
    `SELECT * FROM accepted_turn_call_authorities ORDER BY session_id,source_user_seq`,
  ).all());
  const beforeLogical = JSON.stringify(db.prepare(
    `SELECT * FROM logical_tool_calls ORDER BY session_id,source_user_seq,logical_tool_call_id`,
  ).all());
  const beforeFks = JSON.stringify(db.prepare('PRAGMA foreign_key_list(logical_tool_calls)').all());

  eventlog.applyHarnessMigrationsThroughVersionForTests(db, 54);
  assert.equal((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v, 54);
  const rootSql = (db.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'accepted_turn_call_authorities'`).get() as { sql: string }).sql;
  assert.match(rootSql, /'host_v1'/);
  assert.equal(JSON.stringify(db.prepare(
    `SELECT * FROM accepted_turn_call_authorities ORDER BY session_id,source_user_seq`,
  ).all()), beforeRoot);
  assert.equal(JSON.stringify(db.prepare(
    `SELECT * FROM logical_tool_calls ORDER BY session_id,source_user_seq,logical_tool_call_id`,
  ).all()), beforeLogical);
  assert.equal(JSON.stringify(db.prepare('PRAGMA foreign_key_list(logical_tool_calls)').all()), beforeFks);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);

  const once = JSON.stringify(db.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all());
  eventlog.applyHarnessMigrationsThroughVersionForTests(db, 54);
  assert.equal(JSON.stringify(db.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all()), once);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 54').get() as { n: number }).n, 1);
  db.close();
});
