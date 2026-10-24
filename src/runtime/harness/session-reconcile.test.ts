/**
 * Run: npx tsx --test src/runtime/harness/session-reconcile.test.ts
 *
 * Regression coverage for boot-time/dashboard reconciliation of non-chat
 * harness sessions. A row can be left status='active' after a restart even
 * though terminal events are already durable; those should stop counting as
 * active work. Parked states must remain visible.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-session-reconcile-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  appendEvent,
  beginRunAttempt,
  createSession,
  finishRunAttempt,
  getSession,
  listEvents,
  openEventLog,
  resetEventLog,
} = await import('./eventlog.js');
const { activateDispatchLease } = await import('./dispatch-lease.js');
const { WORKFLOW_RUNS_DIR } = await import('../../tools/shared.js');
const approvalRegistry = await import('./approval-registry.js');
const {
  isIgnorableActiveWorkSession,
  isDormantTerminalWorkSession,
  reconcileDormantTerminalWorkSessions,
  terminalStatusForWorkLifecycleEvent,
} = await import('./session-reconcile.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('terminal event evidence reconciles stale active non-chat sessions', () => {
  resetEventLog();
  const done = createSession({ id: 'workflow:done-stale:s1', kind: 'workflow', channel: 'workflow' });
  appendEvent({ sessionId: done.id, turn: 1, role: 'system', type: 'turn_started', data: {} });
  appendEvent({ sessionId: done.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'done' } });

  const failed = createSession({ id: 'execution:failed-stale', kind: 'execution', channel: 'background' });
  appendEvent({ sessionId: failed.id, turn: 1, role: 'system', type: 'run_failed', data: { error: 'provider failed' } });

  const chat = createSession({ id: 'chat-terminal-not-work', kind: 'chat', channel: 'desktop' });
  appendEvent({ sessionId: chat.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'done' } });

  assert.equal(isDormantTerminalWorkSession(done), true);
  assert.equal(isDormantTerminalWorkSession(failed), true);
  assert.equal(isDormantTerminalWorkSession(chat), false);

  const result = reconcileDormantTerminalWorkSessions();
  assert.deepEqual(new Set(result.ids), new Set([done.id, failed.id]));
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.equal(getSession(done.id)?.status, 'completed');
  assert.equal(getSession(failed.id)?.status, 'failed');
  assert.equal(getSession(chat.id)?.status, 'active');
});

test('boot reconciliation scans beyond a single active session page', () => {
  resetEventLog();
  for (let i = 0; i < 505; i += 1) {
    const session = createSession({ id: `workflow:many-terminal:${i}:s1`, kind: 'workflow', channel: 'workflow' });
    appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'turn_started', data: {} });
    appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'done' } });
  }

  const result = reconcileDormantTerminalWorkSessions();
  assert.equal(result.reconciled, 505);
  assert.equal(result.completed, 505);
  assert.equal(getSession('workflow:many-terminal:0:s1')?.status, 'completed');
  assert.equal(getSession('workflow:many-terminal:504:s1')?.status, 'completed');
});

test('parked awaiting states and pending approvals are not reconciled away', () => {
  resetEventLog();
  const awaitingInput = createSession({ id: 'workflow:awaiting-input:s1', kind: 'workflow', channel: 'workflow' });
  appendEvent({
    sessionId: awaitingInput.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reason: 'awaiting_user_input', reply: 'Which segment should I use?' },
  });

  const awaitingContinue = createSession({ id: 'execution:awaiting-continue', kind: 'execution', channel: 'background' });
  appendEvent({ sessionId: awaitingContinue.id, turn: 1, role: 'system', type: 'conversation_limit_exceeded', data: { reason: 'max_steps' } });
  appendEvent({
    sessionId: awaitingContinue.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reason: 'awaiting_continue', reply: 'Reply continue to keep going.' },
  });

  const pendingApproval = createSession({ id: 'workflow:pending-approval:s1', kind: 'workflow', channel: 'workflow' });
  approvalRegistry.register({
    sessionId: pendingApproval.id,
    subject: 'Approve send',
    tool: 'send_email',
  });
  appendEvent({ sessionId: pendingApproval.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'ready after approval' } });

  const result = reconcileDormantTerminalWorkSessions();
  assert.equal(result.reconciled, 0);
  assert.equal(getSession(awaitingInput.id)?.status, 'active');
  assert.equal(getSession(awaitingContinue.id)?.status, 'active');
  assert.equal(getSession(pendingApproval.id)?.status, 'active');
});

test('Claude SDK workflow-step route telemetry closes historical active step sessions', () => {
  resetEventLog();
  const sdkStep = createSession({ id: 'workflow:sdk-route-complete:step', kind: 'workflow', channel: 'workflow' });
  appendEvent({
    sessionId: sdkStep.id,
    turn: 0,
    role: 'system',
    type: 'worker_model_routed',
    data: {
      transport: 'claude_agent_sdk_workflow_step',
      modelId: 'claude-opus-4-8',
      sdkSessionId: 'sdk-session',
      toolUses: ['StructuredOutput'],
      structured: true,
    },
  });

  const genericRoute = createSession({ id: 'workflow:generic-route-active:step', kind: 'workflow', channel: 'workflow' });
  appendEvent({
    sessionId: genericRoute.id,
    turn: 0,
    role: 'system',
    type: 'worker_model_routed',
    data: { modelId: 'gpt-5.5', provider: 'openai' },
  });

  const result = reconcileDormantTerminalWorkSessions();
  assert.deepEqual(result.ids, [sdkStep.id]);
  assert.equal(getSession(sdkStep.id)?.status, 'completed');
  assert.equal(getSession(genericRoute.id)?.status, 'active');
});

test('active-work visibility ignores empty and stale orphan sessions without mutating them', () => {
  resetEventLog();
  const empty = createSession({ id: 'workflow:empty-orphan', kind: 'workflow', channel: 'workflow' });
  appendEvent({ sessionId: empty.id, turn: 0, role: 'system', type: 'session_started', data: {} });

  const pending = createSession({ id: 'workflow:empty-pending-approval', kind: 'workflow', channel: 'workflow' });
  approvalRegistry.register({ sessionId: pending.id, subject: 'Approve pending gate', tool: 'workflow_approval_gate' });

  const staleTool = createSession({ id: 'workflow:stale-tool-orphan', kind: 'workflow', channel: 'workflow' });
  appendEvent({ sessionId: staleTool.id, turn: 1, role: 'system', type: 'tool_returned', data: { tool: 'read_file', ok: true } });

  const pendingIds = new Set([pending.id]);
  assert.equal(isIgnorableActiveWorkSession(empty, { pendingSessionIds: pendingIds }), true);
  assert.equal(isIgnorableActiveWorkSession(pending, { pendingSessionIds: pendingIds }), false);
  assert.equal(isIgnorableActiveWorkSession(staleTool, { pendingSessionIds: pendingIds, nowMs: Date.now() + 10_000, staleMs: 1 }), true);
  assert.equal(getSession(empty.id)?.status, 'active', 'visibility filtering does not rewrite history');
  assert.equal(getSession(staleTool.id)?.status, 'active', 'stale orphan filtering does not rewrite history');
});

test('active-work display joins completed workflow children to their exact retained parent without closing history', () => {
  resetEventLog();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const now = Date.now() + 1_000;
  const runId = 'display-exact-completed-parent';
  const session = createSession({
    id: 'workflow:display-exact-completed-parent:read', kind: 'workflow', channel: 'workflow',
    metadata: { workflowRunId: runId, workflowName: 'display-fixture', stepId: 'read' },
  });
  appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'turn_started', data: {} });
  appendEvent({ sessionId: session.id, turn: 1, role: 'tool', type: 'tool_returned', data: { tool: 'read_file', ok: true } });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const record = { id: runId, workflow: 'display-fixture', status: 'completed', finishedAt: new Date(now).toISOString(), stepOutputs: { read: { ok: true } } };
  writeFileSync(runFile, JSON.stringify(record));
  const before = openEventLog().prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
  const eventsBefore = openEventLog().prepare('SELECT count(*) AS n FROM events WHERE session_id = ?').get(session.id);
  assert.equal(isIgnorableActiveWorkSession(session, { nowMs: now }), true);
  assert.deepEqual(openEventLog().prepare('SELECT * FROM sessions WHERE id = ?').get(session.id), before);
  assert.deepEqual(openEventLog().prepare('SELECT count(*) AS n FROM events WHERE session_id = ?').get(session.id), eventsBefore);

  // A changed existing record invalidates the shared inventory immediately.
  writeFileSync(runFile, JSON.stringify({ ...record, status: 'running' }));
  assert.equal(isIgnorableActiveWorkSession(session, { nowMs: now, staleMs: 0 }), false);
  writeFileSync(runFile, JSON.stringify(record));
  assert.equal(isIgnorableActiveWorkSession(session, { nowMs: now }), true);
  const attempt = beginRunAttempt(session.id, { attemptId: 'attempt:display-owner' });
  assert.equal(isIgnorableActiveWorkSession(session, { nowMs: now }), false, 'a live owner wins over terminal parent');
  finishRunAttempt(attempt, 'completed');
  assert.equal(isIgnorableActiveWorkSession(session, { nowMs: now }), true);
  approvalRegistry.register({ sessionId: session.id, subject: 'Fixture retained approval', tool: 'fixture_write' });
  assert.equal(isIgnorableActiveWorkSession(session, { nowMs: now }), false, 'database approval wins even without a caller-provided pending set');
});

test('workflow display retains unknown parents, newer activity and paused or recovery-owned children regardless of age', () => {
  resetEventLog();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const now = Date.now() + 10_000;
  const makeChild = (label: string, metadata: Record<string, unknown> = {}) => {
    const runId = `display-retained-${label}`;
    const child = createSession({
      id: `workflow:${runId}:read`, kind: 'workflow', channel: 'workflow',
      metadata: { workflowRunId: runId, workflowName: 'display-fixture', stepId: 'read', ...metadata },
    });
    appendEvent({ sessionId: child.id, turn: 1, role: 'system', type: 'turn_started', data: {} });
    return { child, runId, file: path.join(WORKFLOW_RUNS_DIR, `${runId}.json`) };
  };
  for (const [label, patch] of Object.entries({
    mismatched: { id: 'other-run' }, wrongWorkflow: { workflow: 'another-workflow' },
    wrongStep: { stepOutputs: { anotherStep: { ok: true } } },
    failed: { status: 'failed' }, running: { status: 'running' },
    missingFinish: { finishedAt: null }, invalidFinish: { finishedAt: 'not-a-time' },
    oldFinish: { finishedAt: '2020-01-01T00:00:00.000Z' },
    futureFinish: { finishedAt: new Date(now + 1).toISOString() },
  })) {
    const { child, runId, file } = makeChild(label);
    writeFileSync(file, JSON.stringify({ id: runId, workflow: 'display-fixture', status: 'completed', finishedAt: new Date(now).toISOString(), stepOutputs: { read: { ok: true } }, ...patch }));
    assert.equal(isIgnorableActiveWorkSession(child, { nowMs: now, staleMs: 0 }), false, label);
  }
  for (const label of ['missing', 'corrupt']) {
    const { child, file } = makeChild(label);
    if (label === 'corrupt') writeFileSync(file, '{');
    assert.equal(isIgnorableActiveWorkSession(child, { nowMs: now, staleMs: 0 }), false, label);
  }
  const { child: paused, runId, file } = makeChild('pause');
  writeFileSync(file, JSON.stringify({ id: runId, workflow: 'display-fixture', status: 'completed', finishedAt: new Date(now).toISOString(), stepOutputs: { read: { ok: true } } }));
  appendEvent({ sessionId: paused.id, turn: 1, role: 'system', type: 'run_paused', data: {} });
  assert.equal(isIgnorableActiveWorkSession(paused, { nowMs: now, staleMs: 0 }), false);
  for (const key of ['__run_in_flight', '__run_in_flight_owner', '__host_recovery_state', '__interrupt_state', '__source_approval_checkpoints', '__continuation_owner', '__host_recovery_owner']) {
    const { child, runId: ownedId, file: ownedFile } = makeChild(`metadata-${key}`, { [key]: 'retained' });
    writeFileSync(ownedFile, JSON.stringify({ id: ownedId, workflow: 'display-fixture', status: 'completed', finishedAt: new Date(now).toISOString(), stepOutputs: { read: { ok: true } } }));
    assert.equal(isIgnorableActiveWorkSession(child, { nowMs: now, staleMs: 0 }), false, key);
  }
});

test('default workflow display rereads changed, missing, paused and newly recovery-owned rows', () => {
  resetEventLog(); mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const now = Date.now() + 1_000;
  for (const change of ['missing', 'kind', 'paused', 'recovery'] as const) {
    const runId = `display-current-row-${change}`;
    const metadata = { workflowRunId: runId, workflowName: 'display-fixture', stepId: 'read' };
    const stale = createSession({ kind: 'workflow', metadata });
    appendEvent({ sessionId: stale.id, turn: 1, role: 'tool', type: 'tool_returned', data: { tool: 'read_file', ok: true } });
    writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({ id: runId, workflow: 'display-fixture',
      status: 'completed', finishedAt: new Date(now).toISOString(), stepOutputs: { read: { ok: true } } }));
    assert.equal(isIgnorableActiveWorkSession(stale, { nowMs: now }), true);
    const db = openEventLog();
    if (change === 'missing') db.prepare('DELETE FROM sessions WHERE id = ?').run(stale.id);
    else if (change === 'kind') db.prepare("UPDATE sessions SET kind = 'execution' WHERE id = ?").run(stale.id);
    else if (change === 'paused') db.prepare("UPDATE sessions SET status = 'paused' WHERE id = ?").run(stale.id);
    else db.prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run(JSON.stringify({
      ...metadata, __host_recovery_owner: { sourceUserSeq: 1 },
    }), stale.id);
    assert.equal(isIgnorableActiveWorkSession(stale, { nowMs: now }), false, change);
  }
});

/** Real isolated host call/settlement/reservation producers, with no provider.
 * Once their authority is closed, only the disposable session KIND is changed
 * to exercise the workflow DISPLAY classifier. This is not workflow execution
 * acceptance and does not bypass its expected-work binding requirement. */
async function workflowDisplayWriteFixture(label: string, answered: boolean) {
  const authorities = await import('./accepted-turn-call-authority.js');
  const bindings = await import('./host-call-capability-binding.js');
  const identities = await import('./attempt-identity.js');
  const contracts = await import('./logical-call-contract.js');
  const leases = await import('./dispatch-lease.js');
  const brackets = await import('./brackets.js');
  const invocation = await import('./host-tool-invocation.js');
  const projection = await import('./external-write-event-projection.js');
  const audit = await import('./accepted-source-settlement-audit.js');
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const runId = `display-uncertain-${label}`;
  const sessionId = `workflow:${runId}:write`;
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop',
    metadata: { workflowRunId: runId, workflowName: 'display-fixture', stepId: 'write' } });
  const source = appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Controlled display classification fixture' } });
  const armed = authorities.armHostCallAuthority({ sessionId, sourceUserSeq: source.seq,
    catalogRevisionDigest: digest(`catalog:${sessionId}`), bindingRevisionDigest: digest(`binding:${sessionId}`),
    maxLogicalCalls: 4, maxParallelCalls: 1 });
  assert.equal(armed.status, 'armed');
  const parentLease = leases.activateDispatchLease({ sessionId, scopeId: `${sessionId}::parent` });
  const root = authorities.acceptedTurnCallAuthorityFor(sessionId, source.seq);
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') throw new Error('controlled root unavailable');
  const logicalToolCallId = `controlled-write-${label}`;
  const toolName = 'controlled_write';
  const args = { record_id: label };
  const acceptedTaskId = identities.acceptedTaskIdFor(sessionId, source.seq);
  const contract = contracts.durableLogicalCallContract(acceptedTaskId, toolName, args)!;
  const base = {
    sessionId, sourceUserSeq: source.seq, acceptedTaskId, logicalToolCallId,
    sourceEventId: root.authority.sourceEventId, sourceEventDigest: root.authority.sourceEventDigest,
    toolName: contract.toolName, argumentDigest: contract.argumentDigest,
    effect: 'external_write' as const, bindingKind: 'catalog_manifest' as const,
    capabilityId: `cap:${toolName}`, schemaFingerprint: digest(`schema:${toolName}`),
    accountId: 'account:display-fixture', invokePortId: 'controlled:invoke', operationId: toolName,
    manifestId: `manifest:${toolName}`, manifestDigest: digest(`manifest:${toolName}`),
    engineVersion: root.authority.engineVersion, surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest, authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest, catalogRevisionDigest: root.authority.catalogRevisionDigest!,
    bindingRevisionDigest: root.authority.bindingRevisionDigest!,
  };
  const attestation = { ...base, bindingDigest: bindings.hostCallAttestationBindingDigest(base) };
  const execute = () => authorities.withHostCallAttestation(attestation, () => brackets.withHarnessRunContext({
    sessionId, sourceUserSeq: source.seq, turn: 1, counter: new brackets.ToolCallsCounter(4), dispatchLease: parentLease,
  }, () => invocation.invokeHostToolCall({
    identity: { sessionId, sourceUserSeq: source.seq, modelCallId: logicalToolCallId, toolName, args, turn: 1 },
    parentLease, effect: 'external_write', businessCall: true, boundary: 'host_owned_external', deadlineMs: 500,
    invoke: async () => { if (answered) return { successful: false, error: { code: 'not_found' } }; throw new Error('controlled missing acknowledgement'); },
  })));
  if (answered) await execute();
  else await assert.rejects(execute(), /controlled missing acknowledgement/);
  assert.equal(authorities.closeHostCallAuthority({ sessionId, sourceUserSeq: source.seq, outcome: 'blocked' }).status, 'closed');
  leases.revokeDispatchLease(parentLease);
  const db = openEventLog();
  // Synthetic classification only: no execution follows this change.
  db.prepare("UPDATE sessions SET kind = 'workflow', channel = 'workflow' WHERE id = ?").run(sessionId);
  const child = getSession(sessionId)!;
  const original = () => db.prepare(`SELECT outcome_kind, outcome_detail, requires_reconciliation
    FROM logical_call_settlements WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
    .get(sessionId, source.seq, logicalToolCallId);
  assert.deepEqual(original(), { outcome_kind: 'uncertain_write',
    outcome_detail: answered ? 'provider_refused_envelope' : 'unacknowledged_mutation', requires_reconciliation: 1 });
  const publishParent = () => {
    const now = Date.now() + 1_000;
    mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
    writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({ id: runId,
      workflow: 'display-fixture', status: 'completed', finishedAt: new Date(now).toISOString(), stepOutputs: { write: { ok: true } } }));
    return now;
  };
  const resolve = () => {
    const reservation = listEvents(sessionId, { types: ['external_write'] })
      .find(event => event.data.canonicalCallId === logicalToolCallId);
    assert.ok(reservation);
    const identity = projection.externalWriteProjectionIdentityFromReservation(reservation);
    assert.ok(identity);
    projection.projectExternalWriteTerminal({ sessionId, sourceUserSeq: source.seq, acceptedTaskId, ...identity,
      physicalDispatchId: String(reservation.data.physicalDispatchId), type: 'external_write_succeeded', reason: 'verified_fixture_resolution' });
  };
  return { child, sourceUserSeq: source.seq, original, publishParent, resolve,
    audit: () => audit.auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq: source.seq }) };
}

test('completed-parent display retains unresolved writes, then accepts exact resolution without rewriting the original uncertainty', async () => {
  resetEventLog();
  const fixture = await workflowDisplayWriteFixture('resolution', false);
  assert.equal(fixture.audit().status, 'uncertain_write');
  assert.equal(isIgnorableActiveWorkSession(fixture.child, { nowMs: fixture.publishParent(), staleMs: 0 }), false);
  appendEvent({ sessionId: fixture.child.id, turn: 1, role: 'system', type: 'external_write_succeeded',
    data: { canonicalCallId: 'unrelated-call', shapeKey: 'CONTROLLED_WRITE', targets: ['other-record'] } });
  assert.equal(fixture.audit().status, 'uncertain_write', 'an unrelated success is not reconciliation');
  assert.equal(isIgnorableActiveWorkSession(fixture.child, { nowMs: fixture.publishParent(), staleMs: 0 }), false);
  fixture.resolve();
  assert.equal(fixture.audit().status, 'clean');
  const original = fixture.original();
  const before = openEventLog().prepare('SELECT count(*) AS n FROM events WHERE session_id = ?').get(fixture.child.id);
  assert.equal(isIgnorableActiveWorkSession(fixture.child, { nowMs: fixture.publishParent(), staleMs: 0 }), true);
  assert.deepEqual(fixture.original(), original, 'display/reconciliation never clears the immutable uncertainty flag');
  assert.deepEqual(openEventLog().prepare('SELECT count(*) AS n FROM events WHERE session_id = ?').get(fixture.child.id), before);
  assert.equal(getSession(fixture.child.id)?.status, 'active', 'this projection does not rewrite session history');
});

test('completed-parent display accepts answered provider refusal while retaining its no-replay settlement', async () => {
  resetEventLog();
  const fixture = await workflowDisplayWriteFixture('answered', true);
  assert.equal(fixture.audit().status, 'clean');
  const original = fixture.original();
  assert.equal(isIgnorableActiveWorkSession(fixture.child, { nowMs: fixture.publishParent(), staleMs: 0 }), true);
  assert.deepEqual(fixture.original(), original);
});

test('retention-aged non-chat orphan is failed only after its durable attempt owner has finished', () => {
  resetEventLog();
  const db = openEventLog();
  const backdate = (id: string) => db.prepare(
    'UPDATE sessions SET updated_at = ? WHERE id = ?',
  ).run('2020-01-01T00:00:00.000Z', id);

  const orphan = createSession({
    id: 'workflow:retention-aged-interrupted:s1',
    kind: 'workflow',
    channel: 'workflow',
    metadata: {
      workflowRunId: 'retention-aged-interrupted-run',
      __run_in_flight: '2020-01-01T00:00:00.000Z',
      __run_in_flight_owner: {
        attemptId: 'attempt:retention-aged-interrupted',
        sourceUserSeq: 1,
        armedAt: '2020-01-01T00:00:00.000Z',
      },
    },
  });
  appendEvent({
    sessionId: orphan.id,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'read_file', ok: true },
  });
  const interrupted = beginRunAttempt(orphan.id, { attemptId: 'attempt:retention-aged-interrupted' });
  activateDispatchLease({
    sessionId: orphan.id,
    scopeId: `${orphan.id}::runner`,
    runAttemptId: interrupted.attemptId,
  });
  finishRunAttempt(interrupted, 'interrupted');
  backdate(orphan.id);

  const externalOwner = createSession({
    id: 'workflow:retention-aged-external-owner:s1',
    kind: 'workflow',
    channel: 'workflow',
    metadata: { workflowRunId: 'retention-aged-external-owner-run' },
  });
  appendEvent({
    sessionId: externalOwner.id,
    turn: 1,
    role: 'system',
    type: 'turn_started',
    data: {},
  });
  backdate(externalOwner.id);
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, 'retention-aged-external-owner-run.json'),
    JSON.stringify({
      id: 'retention-aged-external-owner-run',
      status: 'queued',
      workflowName: 'offline-owner',
    }),
    'utf8',
  );

  const owned = createSession({
    id: 'workflow:retention-aged-live-owner:s1',
    kind: 'workflow',
    channel: 'workflow',
    metadata: {
      __run_in_flight: '2020-01-01T00:00:00.000Z',
      __run_in_flight_owner: {
        attemptId: 'attempt:retention-aged-live-owner',
        sourceUserSeq: 1,
        armedAt: '2020-01-01T00:00:00.000Z',
      },
    },
  });
  appendEvent({
    sessionId: owned.id,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'read_file', ok: true },
  });
  beginRunAttempt(owned.id, { attemptId: 'attempt:retention-aged-live-owner' });
  backdate(owned.id);

  const fresh = createSession({
    id: 'workflow:fresh-ownerless:s1',
    kind: 'workflow',
    channel: 'workflow',
  });
  appendEvent({
    sessionId: fresh.id,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'read_file', ok: true },
  });

  const approvalOwned = createSession({
    id: 'workflow:retention-aged-pending-approval:s1',
    kind: 'workflow',
    channel: 'workflow',
  });
  appendEvent({
    sessionId: approvalOwned.id,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'draft_email', ok: true },
  });
  approvalRegistry.register({
    sessionId: approvalOwned.id,
    subject: 'Approve the draft send',
    tool: 'send_email',
  });
  backdate(approvalOwned.id);

  const awaitingInput = createSession({
    id: 'workflow:retention-aged-awaiting-input:s1',
    kind: 'workflow',
    channel: 'workflow',
  });
  appendEvent({
    sessionId: awaitingInput.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reason: 'awaiting_user_input', reply: 'Which account should I use?' },
  });
  backdate(awaitingInput.id);

  const reusableChat = createSession({
    id: 'chat:retention-aged-completed-turn',
    kind: 'chat',
    channel: 'desktop',
  });
  appendEvent({
    sessionId: reusableChat.id,
    turn: 1,
    role: 'assistant',
    type: 'conversation_completed',
    data: { reason: 'success', reply: 'Done.' },
  });
  backdate(reusableChat.id);

  const result = reconcileDormantTerminalWorkSessions();
  assert.ok(result.ids.includes(orphan.id), 'finished interrupted attempt is no longer a live owner');
  assert.equal(getSession(orphan.id)?.status, 'failed', 'aged ownerless work becomes retention-eligible');
  assert.equal(getSession(externalOwner.id)?.status, 'active',
    'a nonterminal canonical workflow record remains the durable resume owner');
  assert.equal(
    Object.prototype.hasOwnProperty.call(getSession(orphan.id)?.metadata ?? {}, '__run_in_flight'),
    false,
    'a crash-left marker bound to the finished attempt is cleared with the orphan',
  );
  assert.equal(
    (db.prepare('SELECT revoked_at FROM run_dispatch_leases WHERE scope_id = ?')
      .get(`${orphan.id}::runner`) as { revoked_at: string | null }).revoked_at,
    null,
    'generic retention does not own dispatch-lease quarantine',
  );
  assert.equal(getSession(owned.id)?.status, 'active', 'an unfinished attempt keeps resumable work active');
  assert.equal(
    Object.prototype.hasOwnProperty.call(getSession(owned.id)?.metadata ?? {}, '__run_in_flight'),
    true,
    'the matching live attempt retains its restart marker',
  );
  assert.equal(getSession(approvalOwned.id)?.status, 'active', 'a pending approval remains a durable owner');
  assert.equal(getSession(awaitingInput.id)?.status, 'active', 'explicit awaiting-input lifecycle remains resumable');
  assert.equal(getSession(reusableChat.id)?.status, 'active', 'chat turn completion does not close a reusable conversation');
  assert.equal(getSession(fresh.id)?.status, 'active', 'fresh ownerless work is not aged out');
});

test('terminal detector treats only plain completions and run terminal events as terminal', () => {
  assert.equal(
    terminalStatusForWorkLifecycleEvent({ type: 'conversation_completed', data: { reason: 'awaiting_continue' } }),
    null,
  );
  assert.equal(
    terminalStatusForWorkLifecycleEvent({ type: 'conversation_completed', data: { reason: 'awaiting_user_input' } }),
    null,
  );
  assert.equal(
    terminalStatusForWorkLifecycleEvent({ type: 'conversation_completed', data: { reason: 'claude_agent_sdk_brain' } }),
    'completed',
  );
  assert.equal(terminalStatusForWorkLifecycleEvent({ type: 'run_completed', data: {} }), 'completed');
  assert.equal(terminalStatusForWorkLifecycleEvent({ type: 'run_failed', data: {} }), 'failed');
  assert.equal(
    terminalStatusForWorkLifecycleEvent({ type: 'worker_model_routed', data: { transport: 'claude_agent_sdk_workflow_step' } }),
    'completed',
  );
  assert.equal(
    terminalStatusForWorkLifecycleEvent({ type: 'worker_model_routed', data: { transport: 'host_harness' } }),
    null,
  );
  assert.equal(terminalStatusForWorkLifecycleEvent({ type: 'awaiting_user_input', data: {} }), null);
});

// ── B7a regression pins (gauntlet 2026-08-26, sess-branch-1d43…): a branch
// session accepted user_input_received at 12:23:39Z, its attempt finished
// 'completed' 1.2s later with ZERO further events, and the session sat
// status='active' for 80+ minutes — a silent no-reply with no timeout, no
// reaper, no user-facing signal. The participation-ratchet class: lifecycle
// stamped at intent (acceptance), never at happening (a turn actually served).
// An accepted-input session with no turn start within its bound must get a
// DURABLE liveness terminal — surfaced, not silent.
test('an accepted-input session that never started a turn gets a durable liveness terminal after its bound', async () => {
  resetEventLog();
  const { reconcileSilentAcceptedInputSessions } = await import('./session-reconcile.js');
  const { listEvents, claimRunAttemptLease, finishRunAttempt: finishAttempt } = await import('./eventlog.js');

  // The zombie shape: accepted input recorded, attempt already finished, no
  // events after acceptance.
  const zombie = createSession({ id: 'sess-branch-zombie-1', kind: 'chat', channel: 'desktop' });
  const claim = claimRunAttemptLease({ sessionId: zombie.id, runId: 'desktop:zombie-run', ownerId: 'console-test', leaseMs: 60_000 });
  const accepted = appendEvent({ sessionId: zombie.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'continue' } });
  if (claim.attempt) finishAttempt(claim.attempt, 'completed');

  // A LIVE session (attempt lease unexpired) must never be terminalized.
  const live = createSession({ id: 'sess-live-turn-1', kind: 'chat', channel: 'desktop' });
  claimRunAttemptLease({ sessionId: live.id, runId: 'desktop:live-run', ownerId: 'console-test', leaseMs: 60 * 60_000 });
  appendEvent({ sessionId: live.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'working…' } });

  // A FRESH acceptance inside the bound must be left alone (checked with a
  // sweep clock still inside ITS bound, before the terminalizing sweep runs).
  const fresh = createSession({ id: 'sess-fresh-input-1', kind: 'chat', channel: 'desktop' });
  appendEvent({ sessionId: fresh.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'hi' } });
  const bound = 10 * 60_000;
  const early = reconcileSilentAcceptedInputSessions({ nowMs: Date.now() + bound - 60_000, boundMs: bound });
  assert.equal(early.ids.length, 0, 'no acceptance is terminalized inside its liveness bound');

  const later = Date.now() + bound + 60_000;
  // The fresh session is protected during the terminalizing sweep by a live lease.
  claimRunAttemptLease({ sessionId: fresh.id, runId: 'desktop:fresh-run', ownerId: 'console-test', leaseMs: bound + 2 * 60_000 });
  const sweep = reconcileSilentAcceptedInputSessions({ nowMs: later, boundMs: bound });

  assert.deepEqual(sweep.ids, [zombie.id], 'exactly the silent accepted-input session was terminalized');
  assert.equal(getSession(zombie.id)?.status, 'failed', 'the session ledger no longer lies "active"');
  const terminal = listEvents(zombie.id).filter((e) => e.type === 'conversation_completed');
  assert.equal(terminal.length, 1, 'a durable terminal event was published');
  const data = terminal[0].data as Record<string, unknown>;
  assert.equal(data.reason, 'accepted_input_never_started');
  assert.equal(data.sourceUserSeq, accepted.seq, 'the terminal names the exact accepted input it answers');

  assert.equal(getSession(live.id)?.status, 'active', 'a session with a live attempt lease is untouched');
  assert.equal(getSession(fresh.id)?.status, 'active', 'an acceptance inside the bound is untouched');

  // Idempotent: a second sweep neither duplicates the terminal nor re-reports.
  const again = reconcileSilentAcceptedInputSessions({ nowMs: later + 1000, boundMs: bound });
  assert.equal(again.ids.length, 0, 'already-terminalized sessions are not re-reported');
});

test('an accepted-input session whose unfinished attempt lease EXPIRED is terminalized (executor died mid-claim)', async () => {
  resetEventLog();
  const { reconcileSilentAcceptedInputSessions } = await import('./session-reconcile.js');
  const { listEvents, claimRunAttemptLease, getActiveRunAttempt } = await import('./eventlog.js');

  const wedged = createSession({ id: 'sess-wedged-lease-1', kind: 'chat', channel: 'desktop' });
  claimRunAttemptLease({ sessionId: wedged.id, runId: 'desktop:wedged-run', ownerId: 'console-test', leaseMs: 60_000 });
  appendEvent({ sessionId: wedged.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'do it' } });

  const bound = 10 * 60_000;
  const later = Date.now() + bound + 60_000; // lease (60s) long expired by then
  const sweep = reconcileSilentAcceptedInputSessions({ nowMs: later, boundMs: bound });

  assert.deepEqual(sweep.ids, [wedged.id]);
  assert.equal(getSession(wedged.id)?.status, 'failed');
  assert.equal(getActiveRunAttempt(wedged.id), null, 'the orphaned attempt was closed, not left claiming the session');
  assert.equal(listEvents(wedged.id).filter((e) => e.type === 'conversation_completed').length, 1);
});

// ── D4 regression pins (adversarial review 2026-08-26) ──────────────────────
// (1) RACE DIRECTION: the liveness sweep decides "stale" from a snapshot read.
// If the real owner publishes its terminal for that exact accepted input
// between the sweep's read and its own publication, appendTerminalEventOnce
// answers inserted:false — and the sweep must NOT stamp status='failed' over
// the owner's real outcome. The status write is only legal AFTER the insert is
// confirmed OURS.
test('a lost liveness race never clobbers a real owner outcome: no status write on inserted:false', async () => {
  resetEventLog();
  const { reconcileSilentAcceptedInputSessions } = await import('./session-reconcile.js');
  const { listEvents } = await import('./eventlog.js');

  const raced = createSession({ id: 'sess-liveness-race-1', kind: 'chat', channel: 'desktop' });
  // Deterministic reconstruction of the race's END STATE: the owner's terminal
  // for the accepted input already exists (its sourceUserSeq names the input),
  // while the session ledger still says 'active' (the owner has not finished
  // its own status write yet) and the input is the NEWEST event the sweep sees.
  const probe = appendEvent({ sessionId: raced.id, turn: 1, role: 'system', type: 'turn_started', data: {} });
  const predictedInputSeq = probe.seq + 2;
  appendEvent({
    sessionId: raced.id,
    turn: 1,
    role: 'assistant',
    type: 'conversation_completed',
    data: { sourceUserSeq: predictedInputSeq, status: 'completed', reply: 'the real answer' },
  });
  const input = appendEvent({ sessionId: raced.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'question' } });
  assert.equal(input.seq, predictedInputSeq, 'fixture: the owner terminal names exactly this accepted input');

  const bound = 10 * 60_000;
  const sweep = reconcileSilentAcceptedInputSessions({ nowMs: Date.now() + bound + 60_000, boundMs: bound });

  assert.equal(sweep.ids.includes(raced.id), false, 'a session whose owner already answered is not reported');
  assert.equal(getSession(raced.id)?.status, 'active',
    'the sweep must not stamp failed over a real owner outcome — the owner finishes its own status write');
  assert.equal(
    listEvents(raced.id).filter((e) => e.type === 'conversation_completed').length,
    1,
    'no duplicate terminal beside the owner one',
  );
});

// (2) KIND SCOPE: the measured silent-no-reply class is kind='chat'
// (sess-branch-1d43…). Work sessions (workflow/execution/agent) have their own
// reconcilers joined to their owner stores; this sweep must not fabricate
// failure authority for them from a stale accepted input alone.
test('the accepted-input liveness sweep is scoped to chat: a stale workflow acceptance is untouched', async () => {
  resetEventLog();
  const { reconcileSilentAcceptedInputSessions } = await import('./session-reconcile.js');

  const work = createSession({ id: 'workflow:stale-accepted:s1', kind: 'workflow', channel: 'workflow' });
  appendEvent({ sessionId: work.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'run it' } });
  const chat = createSession({ id: 'sess-scope-chat-1', kind: 'chat', channel: 'desktop' });
  appendEvent({ sessionId: chat.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'hello?' } });

  const bound = 10 * 60_000;
  const sweep = reconcileSilentAcceptedInputSessions({ nowMs: Date.now() + bound + 60_000, boundMs: bound });

  assert.deepEqual(sweep.ids, [chat.id], 'only the chat-kind silent acceptance is terminalized');
  assert.equal(getSession(work.id)?.status, 'active', 'work sessions are left to their own reconcilers');
  assert.equal(getSession(chat.id)?.status, 'failed');
});
