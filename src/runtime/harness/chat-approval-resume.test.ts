/**
 * Run: npx tsx --test src/runtime/harness/chat-approval-resume.test.ts
 * Fail-closed approval park, resume half (2026-07-20): a PARKED chat approval
 * that is later APPROVED re-drives the session exactly once; rejections,
 * non-parked approvals, and in-flight sessions never dispatch.
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-chat-approval-resume-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  appendEvent,
  createSession,
  finishRunAttempt,
  getActiveRunAttempt,
  getRunAttemptSourceUserEvent,
  getRunAttemptBySourceUserSeq,
  listEvents,
  openEventLog,
  beginRunAttempt,
  recordRunAttemptUserInput,
  requestKill,
  listActiveRunAttemptOwnership,
} = await import('./eventlog.js');
const approvalRegistry = await import('./approval-registry.js');
const {
  getPendingAction,
  markPendingActionApprovalResolved,
  queuePendingAction,
  PENDING_ACTIONS_DIR,
} = await import('./pending-actions.js');
const { installTurnSemanticModelPort } = await import('../semantic-boundary/turn-semantic-port-registry.js');
const { modelUsageAttributionStorage } = await import('../usage-log.js');
const { _setApprovedCallDispatchForTests } = await import('../../execution/pending-action-executor.js');
const { pendingActionApprovalView } = await import('./pending-action-view.js');
const { HarnessSession } = await import('./session.js');
const { writeWorkflow } = await import('../../memory/workflow-store.js');
const workflowQueue = await import('../../tools/workflow-run-queue.js');
const { finalizePreparedWorkflowDispatchForSource } = await import('./loop.js');
const { exactOriginDeliveryTargetDigest } = await import('../exact-origin-delivery.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { recordTurnGraphShadow, turnGraphFromShadowEvent } = await import('../graph/turn-graph-shadow.js');
const workContracts = await import('./expected-work-contract.js');
const workAdmission = await import('./expected-work-admission.js');
const dispatchLedger = await import('./dispatch-ledger.js');
const settlementStore = await import('./logical-call-settlement-store.js');
const { classifyAttemptOutcome } = await import('./attempt-outcome.js');
const { acceptedTaskIdFor } = await import('./attempt-identity.js');
const currentCapabilities = await import('./current-capability-manifest.fixture.js');
const {
  approvedActionRetainedWorkNeedsVerification,
  handleResolvedApprovalForChatResume,
  startChatApprovalResume,
  chatApprovalResumeDirective,
  _resetChatApprovalResumeForTest,
} = await import('./chat-approval-resume.js');

test.after(() => rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => {
  _resetChatApprovalResumeForTest();
  // Each test shares this one fixture DB. Retire older approved cards so the
  // boot-drain tests see only rows created by their own scenario.
  openEventLog().prepare(`
    UPDATE pending_approvals
       SET consumed_at = COALESCE(consumed_at, ?)
     WHERE status = 'resolved' AND resolution = 'approved'
  `).run(new Date().toISOString());
});

function parkApproval(sessionId: string, tool = 'run_shell_command'): approvalRegistry.PendingApprovalRow {
  const row = approvalRegistry.register({ sessionId, subject: 'push the release', tool, args: { command: 'git push' } });
  appendEvent({ sessionId, turn: 0, role: 'system', type: 'approval_parked', data: { approvalId: row.approvalId, tool, subject: 'push the release' } });
  return row;
}

test('an approved PARKED chat approval dispatches the resume directive exactly once', async () => {
  const sess = createSession({ kind: 'chat' });
  const row = parkApproval(sess.id);
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'test');
  assert.ok(resolved.ok && resolved.row);

  const dispatched: Array<{
    sessionId: string;
    directive: string;
    sourceUserSeq: number;
    displayMessage: string;
    runAttemptId: string;
    runId: string;
  }> = [];
  const dispatch = async (
    sessionId: string,
    directive: string,
    source: { sourceUserSeq: number; displayMessage: string; runAttemptId: string; runId: string },
  ): Promise<void> => {
    const active = getActiveRunAttempt(sessionId);
    assert.equal(active?.attemptId, source.runAttemptId, 'dispatch sees the pre-bound active attempt');
    assert.equal(
      getRunAttemptSourceUserEvent(active!)?.seq,
      source.sourceUserSeq,
      'dispatch sees that attempt bound to the exact approval source',
    );
    assert.ok(HarnessSession.load(sessionId)?.runInFlightSince(), 'dispatch sees restart ownership armed');
    assert.equal(
      beginRunAttempt(sessionId, { runId: source.runId }).attemptId,
      source.runAttemptId,
      'the daemon/brain reuses the pre-bound attempt through its stable run family',
    );
    dispatched.push({ sessionId, directive, ...source });
  };

  assert.equal(await handleResolvedApprovalForChatResume(resolved.row!, dispatch), true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].sessionId, sess.id);
  assert.match(dispatched[0].directive, /APPROVED/);
  assert.match(dispatched[0].directive, /exact same arguments/i, 'the directive routes through the one-shot claim');
  const accepted = listEvents(sess.id, { types: ['user_input_received'] });
  assert.equal(accepted.length, 1, 'button-like approval gets one explicit hidden accepted edge');
  assert.equal(dispatched[0].sourceUserSeq, accepted[0].seq);
  assert.equal(accepted[0].data.approvalId, row.approvalId);
  assert.equal(accepted[0].data.decision, 'approve');
  assert.equal(dispatched[0].displayMessage, `Approve ${row.approvalId}`);
  assert.match(dispatched[0].runAttemptId, /^attempt:approval-resume:/);
  assert.equal(dispatched[0].runId, `approval-resume:${row.approvalId}`);

  // One-shot: the same resolution never re-drives.
  assert.equal(await handleResolvedApprovalForChatResume(resolved.row!, dispatch), false);
  assert.equal(dispatched.length, 1);
});

test('a REJECTED parked approval never resumes; a non-parked approval never resumes', async () => {
  const sess = createSession({ kind: 'chat' });
  const rejected = parkApproval(sess.id);
  const rejectedRes = approvalRegistry.resolve(rejected.approvalId, 'rejected', 'test');
  const nonParked = approvalRegistry.register({ sessionId: sess.id, subject: 'other', tool: 'x', args: {} });
  const nonParkedRes = approvalRegistry.resolve(nonParked.approvalId, 'approved', 'test');

  let calls = 0;
  const dispatch = async (): Promise<void> => { calls += 1; };
  assert.equal(await handleResolvedApprovalForChatResume(rejectedRes.row!, dispatch), false, 'a declined action can never come back on its own');
  assert.equal(await handleResolvedApprovalForChatResume(nonParkedRes.row!, dispatch), false, 'a live wait loop owned this one');
  assert.equal(calls, 0);
  assert.equal(
    listEvents(sess.id, { types: ['user_input_received'] }).length,
    0,
    'live-wait approval keeps its original query owner and does not mint a parked re-drive source',
  );
});

test('parked resume reuses the exact visible approval-response source instead of a latest event', async () => {
  const sess = createSession({ kind: 'chat' });
  const row = parkApproval(sess.id);
  const accepted = appendEvent({
    sessionId: sess.id,
    turn: 7,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: `approve ${row.approvalId}`,
      displayText: `approve ${row.approvalId}`,
      approvalId: row.approvalId,
      decision: 'approve',
      source: 'desktop_approval',
    },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 8,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'newer unrelated message' },
  });
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
  let source: { sourceUserSeq: number; displayMessage: string } | undefined;

  assert.equal(await handleResolvedApprovalForChatResume(
    resolved,
    async (_sessionId, _directive, exactSource) => { source = exactSource; },
  ), true);
  assert.equal(source?.sourceUserSeq, accepted.seq);
  assert.equal(source?.displayMessage, `approve ${row.approvalId}`);
});

test('a session with a run IN FLIGHT is never double-driven', async () => {
  const sess = createSession({ kind: 'chat' });
  const row = parkApproval(sess.id);
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'test');
  const live = HarnessSession.load(sess.id);
  live?.setRunInFlight();
  let calls = 0;
  assert.equal(await handleResolvedApprovalForChatResume(resolved.row!, async () => { calls += 1; }), false);
  assert.equal(calls, 0, 'the running turn owns the resolution');
});

test('wired end-to-end: startChatApprovalResume fires through the registry hook', async () => {
  const sess = createSession({ kind: 'chat' });
  const row = parkApproval(sess.id);
  const dispatched: string[] = [];
  await startChatApprovalResume(async (sessionId) => { dispatched.push(sessionId); });
  approvalRegistry.resolve(row.approvalId, 'approved', 'test');
  // The hook dispatches on a microtask; give it a beat.
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(dispatched, [sess.id]);
});

test('a resolution committed before listener registration is drained from durable state', async () => {
  const sess = createSession({ kind: 'chat' });
  const row = parkApproval(sess.id);
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'button-before-boot');
  assert.ok(resolved.ok);
  const dispatched: Array<{ sourceUserSeq: number; runAttemptId: string }> = [];

  await startChatApprovalResume(async (_sessionId, _directive, source) => {
    dispatched.push(source);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(dispatched.length, 1, 'startup drains the missed live-only resolution hook');
  const accepted = listEvents(sess.id, { types: ['user_input_received'] });
  assert.equal(accepted.length, 1);
  assert.equal(dispatched[0]?.sourceUserSeq, accepted[0]?.seq);
  assert.equal(getActiveRunAttempt(sess.id)?.attemptId, dispatched[0]?.runAttemptId);
  assert.ok(HarnessSession.load(sess.id)?.runInFlightSince());
});

test('restart drain reuses the exact source after a crash before dispatch handoff', async () => {
  const sess = createSession({ kind: 'chat' });
  const row = parkApproval(sess.id);
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
  let firstSource = 0;
  let firstAttempt = '';

  assert.equal(await handleResolvedApprovalForChatResume(
    resolved,
    async (_sessionId, _directive, source) => {
      firstSource = source.sourceUserSeq;
      firstAttempt = source.runAttemptId;
      throw new Error('process died before daemon handoff');
    },
  ), false);
  finishRunAttempt({ sessionId: sess.id, attemptId: firstAttempt }, 'interrupted');

  _resetChatApprovalResumeForTest();
  const recovered: Array<{ sourceUserSeq: number; runAttemptId: string }> = [];
  await startChatApprovalResume(async (_sessionId, _directive, source) => {
    recovered.push(source);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.sourceUserSeq, firstSource, 'restart preserves the logical approval source');
  assert.notEqual(recovered[0]?.runAttemptId, firstAttempt, 'restart owns a fresh physical retry');
  assert.equal(
    listEvents(sess.id, { types: ['user_input_received'] }).length,
    1,
    'restart never appends a duplicate approval response',
  );
});

test('restart drain never re-dispatches an approval source with a confirmed external write', async () => {
  const sess = createSession({ kind: 'chat' });
  const row = parkApproval(sess.id);
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
  let interruptedAttempt = '';

  assert.equal(await handleResolvedApprovalForChatResume(
    resolved,
    async (_sessionId, _directive, source) => {
      interruptedAttempt = source.runAttemptId;
      appendEvent({
        sessionId: sess.id,
        turn: 1,
        role: 'system',
        type: 'external_write',
        data: {
          preDispatch: true,
          callId: 'approval-crash-write',
          sourceUserSeq: source.sourceUserSeq,
        },
      });
      appendEvent({
        sessionId: sess.id,
        turn: 1,
        role: 'system',
        type: 'external_write_succeeded',
        data: {
          callId: 'approval-crash-write',
          sourceUserSeq: source.sourceUserSeq,
        },
      });
      throw new Error('process died after provider success');
    },
  ), false);
  finishRunAttempt({ sessionId: sess.id, attemptId: interruptedAttempt }, 'interrupted');
  const markerBeforeRestart = HarnessSession.load(sess.id)?.runInFlightSince();

  _resetChatApprovalResumeForTest();
  let replayed = 0;
  await startChatApprovalResume(async () => { replayed += 1; });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(replayed, 0, 'confirmed mutation evidence is a no-replay boundary');
  assert.equal(
    HarnessSession.load(sess.id)?.runInFlightSince(),
    markerBeforeRestart,
    'the old marker remains for generic restart reconciliation/manual recovery',
  );
  assert.equal(approvalRegistry.get(row.approvalId)?.consumedAt, null);
});

test('sibling approvals resolved while the first resume is in flight are drained serially', async () => {
  const sess = createSession({ kind: 'chat' });
  const first = parkApproval(sess.id, 'proof_first');
  const second = parkApproval(sess.id, 'proof_second');
  const directives: string[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const dispatch = async (
    sessionId: string,
    directive: string,
    source: { runAttemptId: string },
  ) => {
    directives.push(directive);
    if (directives.length === 1) await firstHeld;
    finishRunAttempt({ sessionId, attemptId: source.runAttemptId });
    HarnessSession.load(sessionId)?.clearRunInFlight();
  };

  const resolvedAt = new Date().toISOString();
  openEventLog().prepare(`
    UPDATE pending_approvals
       SET status = 'resolved',
           resolution = 'approved',
           resolver = 'bulk-test',
           resolved_at = ?
     WHERE approval_id IN (?, ?)
  `).run(resolvedAt, first.approvalId, second.approvalId);
  const firstResolved = approvalRegistry.get(first.approvalId)!;
  const secondResolved = approvalRegistry.get(second.approvalId)!;
  const firstResume = handleResolvedApprovalForChatResume(firstResolved, dispatch);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    await handleResolvedApprovalForChatResume(secondResolved, dispatch),
    false,
    'the sibling is queued while the first resume owns the session',
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(directives.length, 1, 'the second approval does not double-drive the live session');

  releaseFirst();
  await firstResume;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(directives.length, 2, 'the approved sibling is resumed after the first turn releases the session');
  assert.match(directives[0], /proof_first/);
  assert.match(directives[1], /proof_second/);
});

/** The provider stand-in for an approved linked action: records what was
 * dispatched and answers as a provider would. */
function recordingDispatch() {
  const dispatched: Array<{ tool: string; payload: unknown; sessionId: string }> = [];
  _setApprovedCallDispatchForTests(async (tool, payload, sessionId) => {
    dispatched.push({ tool, payload, sessionId });
    return { success: true, providerId: 'msg-proof-1' };
  });
  return dispatched;
}
test.afterEach(() => { _setApprovedCallDispatchForTests(null); _resetChatApprovalResumeForTest(); installTurnSemanticModelPort(null); });

let workflowFixtureNumber = 0;
function workflowHold(activate = true) {
  const name = `approval-owned-workflow-${++workflowFixtureNumber}`;
  writeWorkflow(name, { name, description: 'Controlled approval scheduling fixture.', enabled: true,
    trigger: { manual: true }, steps: [{ id: 'read', prompt: 'Perform the controlled read.', sideEffect: 'read' }] });
  const session = createSession({ kind: 'chat', channel: 'desktop' });
  const run = beginRunAttempt(session.id, { runId: `${name}:parent` });
  const originReplyTarget = { type: 'origin_chat' } as const;
  const source = recordRunAttemptUserInput(run, { turn: 1, role: 'user', data: {
    text: `Run the workflow named ${name}.`, originReplyTarget,
    originReplyTargetDigest: exactOriginDeliveryTargetDigest(originReplyTarget),
  } }, { armRunInFlight: true });
  const queued = workflowQueue.queueWorkflowRun(name, {}, { originSessionId: session.id,
    originObserver: { sessionId: session.id, sourceUserSeq: source.seq, replyTarget: originReplyTarget },
    prepareChatDispatch: authority => {
      const prepared = appendEvent({ sessionId: session.id, turn: source.turn, role: 'system',
        type: 'async_work_dispatch_prepared', parentEventId: source.id, data: { ...authority } });
      return workflowQueue.recordWorkflowChatDispatchPreparation(workflowQueue.createWorkflowChatDispatchPreparedReceipt(authority,
        { eventId: prepared.id, eventSeq: prepared.seq, preparedAt: prepared.createdAt }));
    } });
  assert.equal(queued.status, 'held');
  if (activate) assert.ok(finalizePreparedWorkflowDispatchForSource(session.id, source.seq));
  assert.equal(listActiveRunAttemptOwnership(session.id).find(owner => owner.attemptId === run.attemptId)?.workflowHandoff, activate);
  return { session, run, source };
}

function storedApproval(sessionId: string, sourceUserSeq: number | null) {
  const action = queuePendingAction({ title: 'Run the exact reviewed command', summary: 'Controlled exact stored action.',
    kind: 'shell_command', toolName: 'run_shell_command', payload: { command: 'echo approved', cwd: '/tmp' },
    sessionId, sourceUserSeq });
  const row = approvalRegistry.register({ sessionId, subject: action.title, tool: 'request_approval',
    args: { pendingActionId: action.id, pendingAction: pendingActionApprovalView(action) } });
  appendEvent({ sessionId, turn: 1, role: 'system', type: 'approval_parked',
    data: { approvalId: row.approvalId, tool: 'request_approval', pendingActionId: action.id } });
  return { action, row };
}

function parentMarkers(sessionId: string) {
  const metadata = HarnessSession.load(sessionId)!.sessionRow.metadata;
  return Object.fromEntries(['__run_in_flight', '__run_in_flight_owner', '__host_recovery_state', '__host_recovery_owner',
    '__continuation_owner', '__source_approval_checkpoints'].map(key => [key, metadata[key]]));
}

async function until(predicate: () => boolean) {
  const end = Date.now() + 15_000;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), 'controlled approval reached its expected state');
}

test('production approval ingress runs one stored action beside its retained workflow handoff without stealing the parent', async () => {
  const held = workflowHold();
  const { action, row } = storedApproval(held.session.id, held.source.seq);
  const markers = parentMarkers(held.session.id);
  const originalAuthority = openEventLog().prepare('SELECT * FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?').get(held.session.id,held.source.seq);
  const calls = recordingDispatch();
  let modelCalls = 0;
  await startChatApprovalResume(async () => { modelCalls += 1; });
  assert.equal(approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').ok, true);
  await until(() => getPendingAction(action.id)?.status === 'executed');
  const decision = listEvents(held.session.id, { types: ['user_input_received'] }).find(event => event.data.approvalId === row.approvalId);
  assert.ok(decision);
  await until(() => listEvents(held.session.id, { types: ['conversation_completed'] }).some(event => event.data.sourceUserSeq === decision.seq));
  assert.deepEqual(calls, [{ tool: action.toolName, payload: action.payload, sessionId: held.session.id }]);
  assert.equal(modelCalls, 0);
  assert.deepEqual(parentMarkers(held.session.id), markers);
  assert.deepEqual(openEventLog().prepare('SELECT * FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?').get(held.session.id,held.source.seq),originalAuthority,'B closure cannot alter A authority');
  assert.equal((openEventLog().prepare('SELECT state FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?').get(held.session.id,decision.seq) as {state:string}).state,'terminal');
  const parent = openEventLog().prepare('SELECT status, finished_at FROM run_attempts WHERE attempt_id = ?').get(held.run.attemptId);
  assert.deepEqual(parent, { status: 'active', finished_at: null });
  _resetChatApprovalResumeForTest();
  await startChatApprovalResume(async () => { modelCalls += 1; });
  assert.equal(calls.length, 1, 'startup replay cannot dispatch the settled action again');
  assert.equal(modelCalls, 0);
});

test('queued approval drain ignores only the retained workflow after the actual foreground finishes', async () => {
  const held = workflowHold();
  const { action, row } = storedApproval(held.session.id, held.source.seq);
  const foreground = beginRunAttempt(held.session.id, { runId: 'controlled-live-foreground' });
  const source = recordRunAttemptUserInput(foreground, { turn: 2, role: 'user', data: { text: 'Controlled foreground request.' } },
    { armRunInFlight: true });
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
  const calls = recordingDispatch();
  let modelCalls = 0;
  assert.equal(await handleResolvedApprovalForChatResume(resolved, async () => { modelCalls += 1; }), false);
  assert.equal(calls.length, 0);
  const identity = { sessionId: held.session.id, sourceUserSeq: source.seq, turn: source.turn,
    attemptId: foreground.attemptId, runId: foreground.runId ?? undefined };
  commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false,
    presentation: { kind: 'answer', text: 'The controlled foreground request is complete.' } });
  await until(() => getPendingAction(action.id)?.status === 'executed');
  assert.equal(calls.length, 1);
  assert.equal(modelCalls, 0);
  assert.equal(listActiveRunAttemptOwnership(held.session.id).find(owner => owner.attemptId === held.run.attemptId)?.workflowHandoff, true);
});

test('a foreground marker armed while approval cleanup yields keeps the approved action queued', async () => {
  const session = createSession({ kind: 'chat' });
  const original = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Run the exact controlled action.' } });
  const { action, row } = storedApproval(session.id, original.seq);
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
  const calls = recordingDispatch();
  const handling = handleResolvedApprovalForChatResume(resolved, async () => { throw new Error('No model handoff'); });
  // The handler has read its session and yielded to obsolete-action cleanup;
  // a real ingress may arm this marker before it creates its physical attempt.
  const current = HarnessSession.load(session.id)!;
  current.setRunInFlight('2026-10-19T23:30:00.000Z');
  const before = parentMarkers(session.id);
  assert.equal(getActiveRunAttempt(session.id), null, 'the foreground has not created its attempt yet');
  assert.equal(await handling, false);
  assert.equal(calls.length, 0);
  assert.equal(getPendingAction(action.id)?.status, 'approved');
  assert.deepEqual(parentMarkers(session.id), before);
  assert.equal(listEvents(session.id, { types: ['user_input_received'] }).length, 1, 'no approval source is minted');
});

test('prepared, parent-reacquired, stopped and unknown owners cannot use the workflow side-execution exemption', async () => {
  for (const mode of ['prepared', 'parent-lease', 'stopped', 'superseded', 'unknown', 'missing-action-source'] as const) {
    const held = workflowHold(mode !== 'prepared');
    const { action, row } = storedApproval(held.session.id, mode === 'missing-action-source' ? null : held.source.seq);
    if (mode === 'parent-lease') openEventLog().prepare('UPDATE run_attempts SET lease_owner = ?, lease_expires_at = ? WHERE attempt_id = ?')
      .run('workflow-parent:controlled', new Date(Date.now() + 60_000).toISOString(), held.run.attemptId);
    if (mode === 'stopped') requestKill(held.session.id, 'Controlled owner Stop.', { sourceUserSeq: held.source.seq });
    if (mode === 'superseded') finishRunAttempt(held.run, 'superseded');
    if (mode === 'unknown') openEventLog().prepare("UPDATE run_attempts SET status = 'interrupted' WHERE attempt_id = ?").run(held.run.attemptId);
    const before = parentMarkers(held.session.id);
    const sources = listEvents(held.session.id, { types: ['user_input_received'] }).length;
    const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
    const calls = recordingDispatch();
    const obsolete = mode === 'stopped' || mode === 'superseded';
    assert.equal(await handleResolvedApprovalForChatResume(resolved, async () => { throw new Error('No model handoff'); }), obsolete, mode);
    assert.equal(calls.length, 0, mode);
    assert.equal(getPendingAction(action.id)?.status, obsolete ? 'cancelled' : 'approved', mode);
    if (obsolete) {
      assert.match(getPendingAction(action.id)?.resultSummary ?? '', /Not run:/);
      assert.equal(await handleResolvedApprovalForChatResume(approvalRegistry.get(row.approvalId)!,
        async () => { throw new Error('No model handoff'); }), false);
    }
    assert.deepEqual(parentMarkers(held.session.id), before, mode);
    assert.equal(listEvents(held.session.id, { types: ['user_input_received'] }).length, sources, mode);
    _resetChatApprovalResumeForTest();
  }
});

test('a tagged decision can retry beside its exact retired workflow marker without clearing that owner', async () => {
  const held = workflowHold();
  finishRunAttempt(held.run, 'interrupted');
  const { action, row } = storedApproval(held.session.id, held.source.seq);
  const decision = appendEvent({ sessionId: held.session.id, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Approve the exact controlled card.', source: 'desktop_approval', approvalId: row.approvalId, decision: 'approve' } });
  const before = parentMarkers(held.session.id);
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
  const calls = recordingDispatch();
  assert.equal(await handleResolvedApprovalForChatResume(resolved, async () => { throw new Error('No model handoff'); }), true);
  assert.equal(calls.length, 1);
  assert.equal(getPendingAction(action.id)?.status, 'executed');
  assert.deepEqual(parentMarkers(held.session.id), before);
  assert.equal(listEvents(held.session.id, { types: ['user_input_received'] }).filter(event =>
    event.data.approvalId === row.approvalId).length, 1, 'the exact accepted decision is reused');
  assert.ok(listEvents(held.session.id, { types: ['conversation_completed'] }).some(event => event.data.sourceUserSeq === decision.seq));
});

test('Stop on an existing decision cancels its unexecuted action without stealing a workflow marker', async () => {
  const held = workflowHold();
  const { action, row } = storedApproval(held.session.id, held.source.seq);
  const decisionRun = beginRunAttempt(held.session.id, { runId: `approval-resume:${row.approvalId}` });
  const decision = recordRunAttemptUserInput(decisionRun, { turn: 2, role: 'user', data: {
    text: 'Approve the exact controlled card.', source: 'desktop_approval', approvalId: row.approvalId, decision: 'approve',
  } }, { armRunInFlight: false });
  requestKill(held.session.id, 'Controlled decision Stop.', { sourceUserSeq: decision.seq });
  const before = parentMarkers(held.session.id);
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
  const calls = recordingDispatch();
  assert.equal(await handleResolvedApprovalForChatResume(resolved, async () => { throw new Error('No model handoff'); }), true);
  assert.equal(calls.length, 0);
  assert.equal(getPendingAction(action.id)?.status, 'cancelled');
  assert.deepEqual(parentMarkers(held.session.id), before);
  assert.ok(listEvents(held.session.id, { types: ['conversation_completed'] }).some(event =>
    event.data.sourceUserSeq === decision.seq && (event.data.turnOutcome as { status?: string })?.status === 'cancelled'));
});

test('an uncertain one-dispatch action is not retried by card callbacks or startup beside a workflow owner', async () => {
  const held = workflowHold();
  const { action, row } = storedApproval(held.session.id, held.source.seq);
  const before = parentMarkers(held.session.id);
  let calls = 0;
  _setApprovedCallDispatchForTests(async () => { calls += 1; throw new Error('Controlled return was lost after dispatch.'); });
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
  await handleResolvedApprovalForChatResume(resolved, async () => { throw new Error('No model handoff'); });
  assert.equal(calls, 1);
  assert.equal(getPendingAction(action.id)?.status, 'failed');
  assert.deepEqual(parentMarkers(held.session.id), before);
  _resetChatApprovalResumeForTest();
  assert.equal(await handleResolvedApprovalForChatResume(approvalRegistry.get(row.approvalId)!,
    async () => { throw new Error('No model handoff'); }), false);
  await startChatApprovalResume(async () => { throw new Error('No model handoff'); });
  assert.equal(calls, 1);
  assert.equal(getPendingAction(action.id)?.status, 'failed');
});

test('an existing tagged approval retry never clears a foreign prepared or unknown marker', async () => {
  for (const mode of ['prepared', 'unknown'] as const) {
    const held = workflowHold(false);
    finishRunAttempt(held.run, 'interrupted');
    const { action, row } = storedApproval(held.session.id, held.source.seq);
    appendEvent({ sessionId: held.session.id, turn: 2, role: 'user', type: 'user_input_received',
      data: { text: 'Approve the exact controlled card.', source: 'desktop_approval', approvalId: row.approvalId, decision: 'approve' } });
    if (mode === 'unknown') {
      const metadata = HarnessSession.load(held.session.id)!.sessionRow.metadata;
      delete metadata.__run_in_flight_owner;
      openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), held.session.id);
    }
    const before = parentMarkers(held.session.id);
    const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
    const calls = recordingDispatch();
    assert.equal(await handleResolvedApprovalForChatResume(resolved, async () => { throw new Error('No model handoff'); }), false, mode);
    assert.equal(calls.length, 0, mode);
    assert.equal(getPendingAction(action.id)?.status, 'approved', mode);
    assert.deepEqual(parentMarkers(held.session.id), before, mode);
    _resetChatApprovalResumeForTest();
  }
});

test('retiring one stopped queued card does not strand its stopped sibling as approved forever', async () => {
  const held = workflowHold();
  const cards = [storedApproval(held.session.id, held.source.seq), storedApproval(held.session.id, held.source.seq)];
  const foreground = beginRunAttempt(held.session.id, { runId: 'controlled-foreground-before-stop' });
  recordRunAttemptUserInput(foreground, { turn: 2, role: 'user', data: { text: 'Controlled active foreground.' } },
    { armRunInFlight: false });
  const calls = recordingDispatch();
  for (const card of cards) {
    const resolved = approvalRegistry.resolve(card.row.approvalId, 'approved', 'desktop-chat-card').row!;
    assert.equal(await handleResolvedApprovalForChatResume(resolved, async () => { throw new Error('No model handoff'); }), false);
  }
  requestKill(held.session.id, 'Controlled owner Stop.', { sourceUserSeq: held.source.seq });
  finishRunAttempt(foreground, 'completed');
  await until(() => cards.every(card => getPendingAction(card.action.id)?.status === 'cancelled'));
  assert.equal(calls.length, 0);
  assert.ok(cards.every(card => /Not run:/.test(getPendingAction(card.action.id)?.resultSummary ?? '')));
});

test('a parked pending-action card runs its exact stored action on approval, with no model turn', async () => {
  const sess = createSession({ kind: 'chat' });
  const action = queuePendingAction({
    title: 'Send the reviewed proof',
    summary: 'Send one exact reviewed payload.',
    kind: 'shell_command',
    toolName: 'run_shell_command',
    payload: { command: 'git push origin main', cwd: '/tmp' },
    sessionId: sess.id,
  });
  const row = approvalRegistry.register({
    sessionId: sess.id,
    subject: 'Send the reviewed proof',
    tool: 'request_approval',
    args: { pendingActionId: action.id, pendingAction: pendingActionApprovalView(action) },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 0,
    role: 'system',
    type: 'approval_parked',
    data: { approvalId: row.approvalId, tool: 'request_approval', pendingActionId: action.id },
  });
  const resolvedRow = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
  const dispatched = recordingDispatch();
  const directives: string[] = [];

  assert.equal(
    await handleResolvedApprovalForChatResume(
      resolvedRow,
      async (_sessionId, directive) => { directives.push(directive); },
    ),
    true,
  );
  // The owner's decision is the whole instruction: the stored payload ran
  // once, the model was not asked to re-issue or reconstruct anything. The
  // outcome reports that action, without inventing a follow-up model turn.
  assert.equal(dispatched.length, 1, JSON.stringify(getPendingAction(action.id)));
  assert.equal(dispatched[0].tool, 'run_shell_command');
  assert.deepEqual(dispatched[0].payload, action.payload);
  assert.equal(getPendingAction(action.id)?.status, 'executed');
  assert.equal(directives.length, 0, 'no model turn: a brain cannot run under this source nor from a hidden one');
  const resumeSource = listEvents(sess.id, { types: ['user_input_received'] })
    .find((event) => event.data.source === 'approval_resume' && event.data.approvalId === row.approvalId);
  assert.ok(resumeSource, 'the approval minted its own hidden control source');
  const terminal = listEvents(sess.id, { types: ['conversation_completed'] })
    .find((event) => event.data.sourceUserSeq === resumeSource!.seq);
  assert.ok(terminal, 'that source settled with what landed');
  const { pendingActionResultBinding } = await import('./pending-action-public-result.js');
  assert.deepEqual(terminal!.data.pendingActionResultBinding, pendingActionResultBinding(getPendingAction(action.id)!, resumeSource!),
    'the trusted host binds clean presentation to the exact action, card, revision, raw result and B source');
  assert.match(String(terminal!.data.reply), /^Done — I ran it\. Here's what it printed:/, 'in Clem\'s words, not the executor\'s');
  assert.doesNotMatch(String(terminal!.data.reply), /run_shell_command|exit_code|pa-/, 'no tool names or ids reach the owner');
  assert.doesNotMatch(String(terminal!.data.reply), /continue|more to do|request.*complete/i,
    'a legacy action without exact original work evidence reports only its own result');
});

function retainedOriginalWork(sessionId: string, ids = ['first_job', 'second_job']) {
  const source = appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Update the approved remote records.' } });
  const identity = { sessionId, sourceUserSeq: source.seq, turn: source.turn };
  assert.ok(recordTurnGraphShadow({ identity }), 'the original request has its exact accepted graph');
  const activation = workAdmission.activateActionExpectedWork(identity);
  assert.ok(activation.status === 'activated' || activation.status === 'replayed', JSON.stringify(activation));
  const frozen = workContracts.freezeActionExpectedWorkContract({ ...identity, proposal: {
    version: 1,
    operations: ids.map((id, index) => ({ id, effect: 'external_write',
      dependsOn: index ? [ids[index - 1]!] : [], dataFrom: [], cardinality: { kind: 'once' } })),
    universes: [],
  } });
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
  return { source, identity, acceptedTaskId: acceptedTaskIdFor(sessionId, source.seq) };
}

async function approveStoredActionForOriginal(sessionId: string, sourceUserSeq: number | null) {
  const action = queuePendingAction({ title: 'Run the reviewed command', summary: 'One exact approved command.',
    kind: 'shell_command', toolName: 'run_shell_command', payload: { command: 'echo approved', cwd: '/tmp' },
    sessionId, sourceUserSeq });
  const row = approvalRegistry.register({ sessionId, subject: action.title, tool: 'request_approval',
    args: { pendingActionId: action.id, pendingAction: pendingActionApprovalView(action) } });
  appendEvent({ sessionId, turn: 1, role: 'system', type: 'approval_parked',
    data: { approvalId: row.approvalId, tool: 'request_approval', pendingActionId: action.id } });
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
  const calls = recordingDispatch();
  let modelCalls = 0;
  assert.equal(await handleResolvedApprovalForChatResume(resolved, async () => { modelCalls += 1; }), true);
  assert.equal(modelCalls, 0);
  assert.deepEqual(calls, [{ tool: action.toolName, payload: action.payload, sessionId }]);
  assert.equal(getPendingAction(action.id)?.status, 'executed');
  const decision = listEvents(sessionId, { types: ['user_input_received'] })
    .find((event) => event.data.source === 'approval_resume' && event.data.approvalId === row.approvalId)!;
  assert.ok(decision);
  const terminal = listEvents(sessionId, { types: ['conversation_completed'] })
    .find((event) => event.data.sourceUserSeq === decision.seq)!;
  assert.ok(terminal);
  assert.equal(terminal.data.turnOutcome?.status, 'done');
  assert.equal(terminal.data.turnOutcome?.resumable, false, 'reporting remaining A work does not reopen executor source B');
  _resetChatApprovalResumeForTest();
  assert.equal(await handleResolvedApprovalForChatResume(approvalRegistry.get(row.approvalId)!,
    async () => { throw new Error('must not dispatch a model'); }), false);
  assert.equal(calls.length, 1, 'replaying the card never repeats the approved effect');
  return { action, row, decision, terminal };
}

test('approved action B names verification only from the original A retained requirements', async () => {
  const session = createSession({ kind: 'chat' });
  const original = retainedOriginalWork(session.id);
  const db = openEventLog();
  const retained = {
    authority: db.prepare('SELECT * FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?').get(session.id, original.source.seq),
    contract: db.prepare('SELECT * FROM accepted_task_work_contracts WHERE session_id=? AND source_user_seq=?').get(session.id, original.source.seq),
    markers: parentMarkers(session.id),
  };
  assert.deepEqual(workAdmission.expectedWorkPlanLines(original.identity).map((line) => line.state),
    ['open', 'blocked_on_dependency']);
  const result = await approveStoredActionForOriginal(session.id, original.source.seq);
  assert.match(String(result.terminal.data.reply), /earlier request still has retained work to verify/);
  assert.match(String(result.terminal.data.reply), /Say "continue" to check the saved results and finish what remains/);
  assert.doesNotMatch(String(result.terminal.data.reply), /more to do after it|I'll pick it up from here|entire request.*complete/i);
  assert.equal(listEvents(session.id, { types: ['conversation_completed'] })
    .filter((event) => event.data.sourceUserSeq === original.source.seq).length, 0,
  'executing B does not claim or settle A complete');
  assert.deepEqual(workAdmission.expectedWorkPlanLines(original.identity).map((line) => line.settledInstances), [0, 0],
    'B success cannot discharge A requirements');
  assert.deepEqual(db.prepare('SELECT * FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?').get(session.id, original.source.seq),
    retained.authority, 'B canonical closure leaves the original A authority byte-for-byte unchanged');
  assert.deepEqual(db.prepare('SELECT * FROM accepted_task_work_contracts WHERE session_id=? AND source_user_seq=?').get(session.id, original.source.seq),
    retained.contract, 'the real two-operation A contract is retained unchanged');
  assert.deepEqual(parentMarkers(session.id), retained.markers);
  assert.equal(db.prepare('SELECT terminal_event_id FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?')
    .get(session.id, original.source.seq)?.terminal_event_id, null);
  const closedB = db.prepare('SELECT state,terminal_event_id FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?')
    .get(session.id, result.decision.seq) as {state:string;terminal_event_id:string};
  assert.deepEqual(closedB, {state:'terminal',terminal_event_id:result.terminal.id});
  assert.equal((await import('./eventlog.js')).readValidatedTerminalEvent(closedB.terminal_event_id,session.id,result.decision.seq).id,result.terminal.id);
});

test('unknown or corrupt original work never invents a Continue invitation despite sibling work', async () => {
  for (const variant of ['missing', 'corrupt'] as const) {
    const session = createSession({ kind: 'chat' });
    const original = variant === 'corrupt' ? retainedOriginalWork(session.id).source
      : appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
        data: { text: 'Run this approved command.' } });
    retainedOriginalWork(session.id);
    if (variant === 'corrupt') {
      const db = openEventLog();
      const trigger = db.prepare(`SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'trg_accepted_task_work_contracts_update_immutable'`)
        .get() as { sql: string };
      assert.ok(trigger?.sql);
      // Simulate unreadable historical/storage bytes only inside the isolated
      // fixture; restore the immutable boundary before executing approval B.
      db.exec('DROP TRIGGER trg_accepted_task_work_contracts_update_immutable');
      try {
        db.prepare(`UPDATE accepted_task_work_contracts
          SET contract_json = '{}' WHERE session_id = ? AND source_user_seq = ?`).run(session.id, original.seq);
      } finally { db.exec(trigger.sql); }
    }
    assert.equal(workContracts.loadExpectedWorkContract(session.id, original.seq).status, variant);
    const result = await approveStoredActionForOriginal(session.id, original.seq);
    assert.doesNotMatch(String(result.terminal.data.reply), /continue|retained work|request.*complete/i, variant);
  }
});

test('remaining-work presentation refuses wrong-session, wrong-source, synthetic and decision-owned evidence', () => {
  const session = createSession({ kind: 'chat' });
  const original = retainedOriginalWork(session.id);
  const sibling = retainedOriginalWork(session.id);
  const decision = appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Yes, run that action.', decision: 'approve' } });
  const row = { sessionId: session.id, presentation: null };
  const action = { sessionId: session.id, sourceUserSeq: original.source.seq };
  assert.equal(approvedActionRetainedWorkNeedsVerification(row, action, decision), true);
  assert.equal(approvedActionRetainedWorkNeedsVerification({ ...row,
    presentation: { sourceUserSeq: original.source.seq } }, action, decision), true);
  assert.equal(approvedActionRetainedWorkNeedsVerification({ ...row,
    presentation: { sourceUserSeq: sibling.source.seq } }, action, decision), false);
  assert.equal(approvedActionRetainedWorkNeedsVerification(row, { ...action, sessionId: 'another-session' }, decision), false);
  assert.equal(approvedActionRetainedWorkNeedsVerification(row, action, { ...decision, sessionId: 'another-session' }), false);
  assert.equal(approvedActionRetainedWorkNeedsVerification(row, { ...action, sourceUserSeq: null }, decision), false);
  assert.equal(approvedActionRetainedWorkNeedsVerification(row, { ...action, sourceUserSeq: decision.seq }, decision), false);
  assert.equal(approvedActionRetainedWorkNeedsVerification(row, { ...action, sourceUserSeq: 1.5 }, decision), false);
  openEventLog().prepare(`UPDATE events SET data_json = json_set(data_json, '$.synthetic', json('true')) WHERE seq = ?`)
    .run(original.source.seq);
  assert.equal(approvedActionRetainedWorkNeedsVerification(row, action, decision), false,
    'a synthetic original source cannot justify asking the owner for a new turn');
});

test('discharged original work reports only the approved action, using the canonical settlement oracle', async (t) => {
  const tool = 'FIXTURE_APPROVAL_REMOTE_JOB';
  const prior = currentCapabilities.installCurrentCapabilityManifestFixtures([{ operationId: tool,
    providerKind: 'native_mcp', effect: 'external_write', operationSemantics: { version: 1, reversibility: 'reversible' } }]);
  t.after(() => currentCapabilities.restoreCurrentCapabilityManifestFixtures(prior));
  const session = createSession({ kind: 'chat' });
  const original = retainedOriginalWork(session.id, ['first_job']);
  const identity = { ...original.identity, acceptedTaskId: original.acceptedTaskId,
    logicalToolCallId: 'logical:retained-first-job' };
  const args = { record_id: 'fixture-record-1', value: 'ready' };
  assert.equal(dispatchLedger.admitLogicalCall({ identity, tool, args }).status, 'inserted');
  const binding = workAdmission.admitExpectedWorkInvocation({ ...identity, requirementId: 'first_job', tool, args });
  assert.equal(binding.status, 'bound', JSON.stringify(binding));
  const crossing = dispatchLedger.beginPhysicalDispatch({ identity: { ...identity,
    physicalDispatchId: 'dispatch:retained-first-job', ordinal: 1 }, tool, args });
  assert.equal(crossing.status, 'inserted', JSON.stringify(crossing));
  if (crossing.status !== 'inserted') throw new Error('fixture crossing not admitted');
  assert.equal(dispatchLedger.settlePhysicalDispatch({ identity: crossing.identity, tool, outcome: 'returned' }).status, 'inserted');
  const settled = settlementStore.commitLogicalCallSettlement({ identity, contract: { toolName: tool, args },
    execution: { kind: 'provider_execution' }, result: { payload: { successful: true, id: 'fixture-record-1' } },
    outcome: classifyAttemptOutcome({ envelopeSuccessful: true, acknowledged: true, mutating: true }),
    recovery: { businessCall: true, mutating: true, requirementId: 'first_job' },
    observer: { lane: 'native_mcp', turn: original.identity.turn } });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  assert.deepEqual(workAdmission.expectedWorkPlanLines(original.identity).map((line) => ({ state: line.state,
    settled: line.settledInstances })), [{ state: 'satisfied', settled: 1 }]);
  retainedOriginalWork(session.id);
  const result = await approveStoredActionForOriginal(session.id, original.source.seq);
  assert.doesNotMatch(String(result.terminal.data.reply), /continue|retained work|request.*complete/i,
    'neither another open source nor B success changes the original satisfied evidence');
});

test('an exact linked pending-action card resumes even if a crash lost approval_parked', async () => {
  const sess = createSession({ kind: 'chat' });
  const action = queuePendingAction({
    title: 'Crash-window send',
    summary: 'The exact linked card survives a missing park event.',
    kind: 'shell_command',
    toolName: 'run_shell_command',
    payload: { command: 'git push origin main', cwd: '/tmp' },
    sessionId: sess.id,
  });
  const row = approvalRegistry.register({
    sessionId: sess.id,
    subject: action.title,
    tool: 'request_approval',
    args: { pendingActionId: action.id, pendingAction: pendingActionApprovalView(action) },
  });
  const resolvedAt = new Date().toISOString();
  openEventLog().prepare(`
    UPDATE pending_approvals
       SET status = 'resolved',
           resolution = 'approved',
           resolver = 'desktop-chat-card',
           resolved_at = ?
     WHERE approval_id = ?
  `).run(resolvedAt, row.approvalId);
  markPendingActionApprovalResolved(action.id, 'approved', row.approvalId);
  const resolved = approvalRegistry.get(row.approvalId)!;
  assert.equal(listEvents(sess.id, { types: ['approval_parked'] }).length, 0);

  const dispatched = recordingDispatch();
  const directives: string[] = [];
  assert.equal(
    await handleResolvedApprovalForChatResume(
      resolved,
      async (_sessionId, directive) => { directives.push(directive); },
    ),
    true,
  );
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].payload, action.payload);
  assert.equal(getPendingAction(action.id)?.status, 'executed');
  assert.equal(directives.length, 0);
});

test('an approved run_batch card resumes through its deterministic batch executor', async () => {
  const sess = createSession({ kind: 'chat' });
  const action = queuePendingAction({
    title: 'Update the reviewed rows',
    summary: 'Run the exact certified batch after one approval.',
    kind: 'external_write',
    toolName: 'run_batch',
    payload: {
      tool: 'composio_execute_tool',
      composioSlug: 'GOOGLESHEETS_BATCH_UPDATE',
      sideEffect: 'write',
      objective: 'update the exact reviewed rows',
      items: [{ id: 'row-1', args: { spreadsheet_id: 'sheet-proof', range: 'A1' } }],
    },
    sessionId: sess.id,
  });
  const row = approvalRegistry.register({
    sessionId: sess.id,
    subject: action.title,
    tool: 'request_approval',
    args: { pendingActionId: action.id },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 0,
    role: 'system',
    type: 'approval_parked',
    data: { approvalId: row.approvalId, tool: 'request_approval', pendingActionId: action.id },
  });
  const resolvedRow = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
  const directives: string[] = [];

  assert.equal(
    await handleResolvedApprovalForChatResume(
      resolvedRow,
      async (_sessionId, directive) => { directives.push(directive); },
    ),
    true,
  );
  assert.equal(directives.length, 1);
  assert.match(directives[0], /Call run_batch once/);
  assert.match(directives[0], /action="execute"/);
  assert.match(directives[0], new RegExp(action.id));
  assert.doesNotMatch(directives[0], /pending_action_execute/);
});

test('a dispatch failure is swallowed (the grant stays consumable for a manual continue)', async () => {
  const sess = createSession({ kind: 'chat' });
  const row = parkApproval(sess.id);
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'test');
  const ok = await handleResolvedApprovalForChatResume(resolved.row!, async () => { throw new Error('daemon busy'); });
  assert.equal(ok, false, 'failure reported, never thrown');
  let retriedSource = 0;
  let retriedAttempt = '';
  const firstAttempt = getActiveRunAttempt(sess.id)?.attemptId;
  const retried = await handleResolvedApprovalForChatResume(
    resolved.row!,
    async (_sessionId, _directive, source) => {
      retriedSource = source.sourceUserSeq;
      retriedAttempt = source.runAttemptId;
    },
  );
  assert.equal(retried, true, 'a transient dispatch failure does not consume the resume edge');
  assert.equal(
    retriedSource,
    listEvents(sess.id, { types: ['user_input_received'] })[0].seq,
    'retry reuses the same accepted approval source',
  );
  assert.equal(retriedAttempt, firstAttempt, 'retry reuses the same pre-bound physical attempt');
  assert.match(chatApprovalResumeDirective('s', 't'), /approval-resume/);
});

test('an approved card whose persisted graph can never activate is retired once, not re-drained on every boot', async () => {
  const sess = createSession({ kind: 'chat' });
  const action = queuePendingAction({
    title: 'Run ssh localhost echo hi',
    summary: 'Runs one remote command.',
    kind: 'shell_command',
    toolName: 'run_shell_command',
    payload: { command: 'ssh localhost echo hi', cwd: '/tmp' },
    sessionId: sess.id,
  });
  const row = approvalRegistry.register({
    sessionId: sess.id,
    subject: 'Run ssh localhost echo hi',
    tool: 'request_approval',
    args: { pendingActionId: action.id, pendingAction: pendingActionApprovalView(action) },
  });
  appendEvent({
    sessionId: sess.id, turn: 0, role: 'system', type: 'approval_parked',
    data: { approvalId: row.approvalId, tool: 'request_approval', pendingActionId: action.id },
  });
  // The owner's own words, stamped as the decision on this card — but the
  // graph persisted for them (by an older compile) is conversation, and a
  // persisted graph is immutable.
  const accepted = appendEvent({
    sessionId: sess.id, turn: 3, role: 'user', type: 'user_input_received',
    data: { text: 'Thanks, yes.', displayText: 'Thanks, yes.', approvalId: row.approvalId, decision: 'approve', source: 'desktop_approval' },
  });
  const stale = recordTurnGraphShadow({ identity: { sessionId: sess.id, turn: 3, sourceUserSeq: accepted.seq } });
  assert.ok(stale, 'a graph was persisted for the decision');
  assert.notEqual(turnGraphFromShadowEvent(stale!)?.classification.route, 'act', 'the fixture graph is not an action');
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
  const dispatched = recordingDispatch();
  const directives: string[] = [];

  assert.equal(
    await handleResolvedApprovalForChatResume(resolved, async (_sessionId, directive) => { directives.push(directive); }),
    true,
    'the card settled instead of staying consumable',
  );
  assert.equal(dispatched.length, 0, 'nothing ran');
  assert.equal(directives.length, 0, 'no model turn');
  assert.equal(getPendingAction(action.id)?.status, 'cancelled', 'the stored action is retired');
  const terminal = listEvents(sess.id, { types: ['conversation_completed'] })
    .find((event) => event.data.sourceUserSeq === accepted.seq);
  assert.ok(terminal, 'the decision has a visible ending');
  assert.match(String(terminal!.data.reply), /couldn't run "Run ssh localhost echo hi" after you approved it/);
  assert.equal(terminal!.data.turnOutcome?.status, 'failed');
  // A later boot drain finds nothing to redo.
  _resetChatApprovalResumeForTest();
  assert.equal(
    await handleResolvedApprovalForChatResume(approvalRegistry.get(row.approvalId)!, async () => { throw new Error('must not resume'); }),
    false,
  );
  assert.equal(dispatched.length, 0);
});

test('a resume on the desktop attempt that owns the typed decision keeps that attempt\'s run family', async () => {
  const sess = createSession({ kind: 'chat' });
  const row = parkApproval(sess.id);
  const attempt = beginRunAttempt(sess.id, { runId: `desktop:${sess.id}` });
  const accepted = recordRunAttemptUserInput(attempt, {
    turn: 7, role: 'user',
    data: { text: 'Yes, go ahead.', displayText: 'Yes, go ahead.', approvalId: row.approvalId, decision: 'approve', source: 'desktop_approval' },
  }, { armRunInFlight: true });
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
  let source: { sourceUserSeq: number; runId: string; runAttemptId: string } | undefined;
  assert.equal(await handleResolvedApprovalForChatResume(resolved, async (_sessionId, _directive, exact) => { source = exact; }), true);
  assert.equal(source?.sourceUserSeq, accepted.seq);
  assert.equal(source?.runAttemptId, attempt.attemptId, 'the owning attempt is reused');
  assert.equal(source?.runId, attempt.runId, 'and the hand-off names its run family, not a foreign one');
});

test('the ending after an approved shell action shows only what the command printed', async () => {
  const { approvedActionRanText } = await import('./chat-approval-resume.js');
  const text = approvedActionRanText(
    { kind: 'shell_command', toolName: 'run_shell_command' },
    'Executed the approved run_shell_command call. exit_code: 0 stdout: host localhost stderr: Pseudo-terminal will not be allocated because stdin is not a terminal.',
  );
  assert.match(text, /^Done — I ran it\. Here's what it printed:\n\n```\nhost localhost\n```/);
  assert.doesNotMatch(text, /stderr|exit_code|run_shell_command/);
  assert.doesNotMatch(text, /continue|more to do/i, 'action-only is the default');
  const quiet = approvedActionRanText({ kind: 'shell_command', toolName: 'run_shell_command' }, 'exit_code: 0 stdout:   stderr: ');
  assert.match(quiet, /\(nothing printed\)/);
  const sent = approvedActionRanText({ kind: 'external_send', toolName: 'composio_execute_tool' }, '{"id":"msg-1"}');
  assert.match(sent, /^Done — that went through\./);
  assert.doesNotMatch(sent, /msg-1/);
});

test('an approved action that did not land ends in Clem\'s words, never the executor\'s machine text', async () => {
  // Live 2026-10-07: "Dispatch was refused locally before the provider call
  // started: … Error: InvalidToolInputError … Call tool_search … then retry"
  // reached the owner as the ending of their yes.
  const { approvedActionFailedText } = await import('./chat-approval-resume.js');
  const { PENDING_ACTION_PRE_DISPATCH_REFUSAL } = await import('../../execution/pending-action-executor.js');
  const refused = approvedActionFailedText({ kind: 'shell_command', toolName: 'run_shell_command', status: 'failed',
    resultSummary: `${PENDING_ACTION_PRE_DISPATCH_REFUSAL}: An error occurred while running the tool. Error: InvalidToolInputError: cwd: expected string` });
  assert.match(refused, /^I couldn't run the command — the stored call didn't fit the tool's shape, so it was stopped before it started\. Nothing ran and nothing changed\./);
  assert.match(refused, /Ask me again in your own words and I'll build it fresh\./);
  assert.doesNotMatch(refused, /InvalidToolInputError|tool_search|Dispatch|run_shell_command/);
  const uncertain = approvedActionFailedText({ kind: 'external_send', toolName: 'composio_execute_tool', status: 'failed',
    resultSummary: 'Execution attempt failed or became uncertain after dispatch began: socket hang up. Do not retry automatically.' });
  assert.match(uncertain, /^I tried, but I can't tell whether it went through/);
  assert.match(uncertain, /I won't retry it on my own\./);
  assert.doesNotMatch(uncertain, /socket hang up|composio/);
  // A guard inside the tool that refused in words: the words reach the
  // owner (live 2026-10-07: a credential that would leave the machine), the
  // bookkeeping and the harness prefix do not, and the outcome stays uncertain.
  const { PENDING_ACTION_TOOL_REFUSAL } = await import('../../execution/pending-action-executor.js');
  const refusedByTool = approvedActionFailedText({ kind: 'shell_command', toolName: 'run_shell_command', status: 'failed',
    resultSummary: `${PENDING_ACTION_TOOL_REFUSAL}; provider outcome is uncertain and no retry is safe: Tool call refused by harness: this command would send a credential file off the machine` });
  assert.match(refusedByTool, /^I didn't run the command — the tool refused it: this command would send a credential file off the machine\./);
  assert.match(refusedByTool, /can't fully prove nothing changed.*won't retry it on my own/);
  assert.doesNotMatch(refusedByTool, /harness|Dispatch|execution claim|no retry is safe/);
  const stuck = approvedActionFailedText({ kind: 'external_send', toolName: 'composio_execute_tool', status: 'executing', resultSummary: null });
  assert.match(stuck, /can't tell whether it went through/);
  // A plain terminal failure the provider reported is neither "nothing ran" nor uncertain.
  const terminal = approvedActionFailedText({ kind: 'external_send', toolName: 'composio_execute_tool', status: 'failed',
    resultSummary: 'Provider returned a terminal failure before the daemon stopped.' });
  assert.match(terminal, /^It didn't go through — the provider reported a terminal failure/);
  assert.doesNotMatch(terminal, /can't tell|Nothing ran/);
});

test('the facts Clem is given about an approved action that did not land come from the executor\'s markers', async () => {
  const { approvedActionEndingFacts } = await import('./chat-approval-resume.js');
  const { PENDING_ACTION_PRE_DISPATCH_REFUSAL, PENDING_ACTION_TOOL_REFUSAL, PENDING_ACTION_DISPATCH_UNCERTAIN } = await import('../../execution/pending-action-executor.js');
  assert.deepEqual(approvedActionEndingFacts({ status: 'failed', resultSummary: `${PENDING_ACTION_PRE_DISPATCH_REFUSAL}: The command did not run: cwd does not exist: /x.` }),
    { verdict: 'never_started', reply: 'The command did not run: cwd does not exist: /x.' });
  assert.equal(approvedActionEndingFacts({ status: 'failed', resultSummary: `${PENDING_ACTION_TOOL_REFUSAL}; provider outcome is uncertain and no retry is safe: Invalid request data provided` }).verdict, 'refused');
  assert.match(approvedActionEndingFacts({ status: 'failed', resultSummary: `${PENDING_ACTION_TOOL_REFUSAL}; provider outcome is uncertain and no retry is safe: Tool call refused by harness: shell_policy_denial: reads a credential` }).verdict, /^guard_refused$/);
  assert.equal(approvedActionEndingFacts({ status: 'failed', resultSummary: `${PENDING_ACTION_DISPATCH_UNCERTAIN}: socket hang up. Do not retry automatically.` }).verdict, 'uncertain');
  assert.equal(approvedActionEndingFacts({ status: 'executing', resultSummary: null }).verdict, 'uncertain');
});


function endingBarrier<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function endingFixture(sideOwner = false) {
  const held = sideOwner ? workflowHold() : null;
  const session = held?.session ?? createSession({ kind: 'chat' });
  const { action, row } = storedApproval(session.id, held?.source.seq ?? null);
  let effects = 0;
  _setApprovedCallDispatchForTests(async () => { effects++; throw new Error('Controlled result was lost after the one dispatch.'); });
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
  const run = () => handleResolvedApprovalForChatResume(resolved, async () => { throw new Error('No model continuation'); });
  const source = () => listEvents(session.id, { types: ['user_input_received'] })
    .find(event => event.data.approvalId === row.approvalId && event.data.decision === 'approve')!;
  const terminal = () => listEvents(session.id, { types: ['conversation_completed'] })
    .find(event => event.data.sourceUserSeq === source()?.seq);
  return { session, action, row, run, source, terminal, effects: () => effects, held };
}
function endingPort(voice: NonNullable<import('../semantic-boundary/turn-semantic-model-port.js').TurnSemanticModelPort['voiceApprovedActionEnding']>) {
  installTurnSemanticModelPort({ interpret: async () => { throw new Error('No interpretation'); }, voiceApprovedActionEnding: voice });
}
const endingWords = 'I cannot confirm what landed. Shall I check the saved result before anything is repeated?';

for (const sideOwner of [false, true]) test(`approval result narrator binds its current exact result${sideOwner ? ' beside a different foreground owner' : ''}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = endingFixture(sideOwner); const markers = parentMarkers(f.session.id);
  let calls = 0; let signal!: AbortSignal;
  endingPort(async call => {
    calls++; signal = call.signal!; assert.equal(signal.aborted, false);
    const usage = modelUsageAttributionStorage.getStore();
    assert.equal(usage?.sessionId, f.session.id); assert.equal(usage?.sourceUserSeq, f.source().seq);
    assert.equal(usage?.attemptId, getRunAttemptBySourceUserSeq(f.session.id, f.source().seq)?.attemptId,
      'an ingress without inherited usage still records its exact prepared B attempt');
    assert.ok(call.deadlineAt! > Date.now()); assert.ok(call.deadlineAt! <= Date.now() + 20_000);
    call.checkActive!(); assert.equal(call.happened.verdict, 'uncertain');
    return { message: endingWords, modelIdentity: 'controlled-semantic-model', evidenceDigest: call.evidenceDigest };
  });
  assert.equal(await f.run(), true); assert.equal(calls, 1); assert.equal(f.effects(), 1);
  assert.equal(f.terminal()!.data.reply, endingWords);
  assert.equal(f.terminal()!.data.turnOutcome?.status, 'failed');
  assert.match(getPendingAction(f.action.id)!.resultSummary!, /uncertain/i);
  const { pendingActionResultBinding } = await import('./pending-action-public-result.js');
  assert.deepEqual(f.terminal()!.data.pendingActionResultBinding, pendingActionResultBinding(getPendingAction(f.action.id)!, f.source()));
  if (sideOwner) assert.deepEqual(parentMarkers(f.session.id), markers);
  t.mock.timers.tick(40_000); assert.equal(signal.aborted, false, 'completed narration leaves no deadline or watcher running');
  assert.equal(calls, 1); assert.equal(f.effects(), 1);
});

for (const mode of ['compatible_parent', 'foreign_source', 'foreign_parent', 'unproved_job'] as const) test(`approval result narrator accounting refuses borrowed ownership (${mode})`, async () => {
  const f = endingFixture();
  // Use the same real accepted-source producer as the approval-resume path,
  // so the inherited accounting coordinates can refer to its actual B.
  const attempt = beginRunAttempt(f.session.id, { runId: `approval-resume:${f.row.approvalId}` });
  const decision = recordRunAttemptUserInput(attempt, { turn: 0, role: 'user',
    data: { text: `Approve ${f.row.approvalId}.`, synthetic: true, source: 'approval_resume', approvalId: f.row.approvalId, decision: 'approve' } },
  { armRunInFlight: true });
  const foreign = createSession({ kind: 'chat' });
  const other = beginRunAttempt(foreign.id, { runId: `controlled-foreign-accounting:${mode}:${foreign.id}` });
  const otherSource = recordRunAttemptUserInput(other, { turn: 1, role: 'user', data: { text: 'Controlled unrelated request.' } });
  const parent = mode === 'foreign_parent'
    ? { sessionId: foreign.id, sourceUserSeq: otherSource.seq, attemptId: other.attemptId }
    : { sessionId: f.session.id, sourceUserSeq: decision.seq, attemptId: attempt.attemptId };
  const usage = { sessionId: mode === 'foreign_source' ? foreign.id : f.session.id,
    sourceUserSeq: mode === 'foreign_source' ? otherSource.seq : decision.seq,
    attemptId: mode === 'foreign_source' ? other.attemptId : attempt.attemptId,
    ...(mode === 'unproved_job' ? { usageJobId: 'controlled-unrelated-job' } : { usageParentTurn: parent }) };
  let calls = 0;
  endingPort(async call => {
    calls++; assert.equal(modelUsageAttributionStorage.getStore()?.attemptId, attempt.attemptId);
    assert.deepEqual(modelUsageAttributionStorage.getStore()?.usageParentTurn, parent);
    return { message: endingWords, evidenceDigest: call.evidenceDigest, modelIdentity: 'controlled' };
  });
  assert.equal(await modelUsageAttributionStorage.run(usage, f.run), true);
  assert.equal(calls, mode === 'compatible_parent' ? 1 : 0);
  assert.equal(f.effects(), 1, 'accounting refusal never repeats or changes the approved effect');
  if (mode !== 'compatible_parent') assert.doesNotMatch(String(f.terminal()!.data.reply), /Shall I/);
});

test('approval result narrator stops a pending ignoring adapter and never publishes late rejected or fulfilled words', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = endingFixture(); const started = endingBarrier<AbortSignal>(); const response = endingBarrier<never>();
  let calls = 0;
  endingPort(call => { calls++; started.resolve(call.signal!); return response.promise; });
  const pending = f.run(); const signal = await started.promise;
  requestKill(f.session.id, 'Controlled narrator Stop.', { sourceUserSeq: f.source().seq });
  t.mock.timers.tick(250);
  assert.equal(await pending, true); assert.equal(signal.aborted, true);
  assert.equal(f.terminal()!.data.turnOutcome?.status, 'cancelled');
  assert.equal(f.terminal()!.data.hostNotice?.code, 'stopped');
  assert.doesNotMatch(String(f.terminal()!.data.reply), /Shall I|confirm what landed/);
  const retained = getPendingAction(f.action.id)!;
  assert.equal(retained.status, 'failed'); assert.match(retained.resultSummary!, /uncertain/i);
  response.reject(new Error('Controlled late rejection after Stop.')); await Promise.resolve();
  assert.equal(calls, 1); assert.equal(f.effects(), 1);
  assert.equal(await f.run(), false, 'stopped terminal cannot start a new narrator or effect');
});

test('approval result narrator deadline aborts transport and a late answer cannot replace the retained app status', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = endingFixture(); const started = endingBarrier<AbortSignal>();
  const response = endingBarrier<import('../semantic-boundary/turn-semantic-model-port.js').ClemVoiceResult>();
  let digest = ''; let calls = 0;
  endingPort(call => { calls++; digest = call.evidenceDigest; started.resolve(call.signal!); return response.promise; });
  const pending = f.run(); const signal = await started.promise;
  t.mock.timers.tick(20_001);
  assert.equal(await pending, true); assert.equal(signal.aborted, true);
  assert.equal(f.terminal()!.data.turnOutcome?.status, 'failed');
  assert.doesNotMatch(String(f.terminal()!.data.reply), /Shall I/);
  const terminal = f.terminal()!;
  response.resolve({ message: endingWords, modelIdentity: 'controlled-late-model', evidenceDigest: digest });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.terminal()!.id, terminal.id); assert.equal(f.terminal()!.data.reply, terminal.data.reply);
  assert.equal(calls, 1); assert.equal(f.effects(), 1);
});

test('approval result narrator never starts after exact Stop', async () => {
  const f = endingFixture(); let calls = 0;
  endingPort(async call => { calls++; return { message: endingWords, evidenceDigest: call.evidenceDigest, modelIdentity: 'controlled' }; });
  _setApprovedCallDispatchForTests(async () => {
    requestKill(f.session.id, 'Controlled Stop at result.', { sourceUserSeq: f.source().seq });
    throw new Error('Controlled one dispatch stopped.');
  });
  assert.equal(await f.run(), true); assert.equal(calls, 0);
  assert.equal(f.terminal()!.data.turnOutcome?.status, 'cancelled');
});

for (const mode of ['finished_owner', 'changed_summary', 'changed_payload', 'wrong_digest'] as const) test(`approval result narrator rejects ${mode} evidence`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = endingFixture(); let calls = 0;
  endingPort(async call => {
    calls++;
    if (mode === 'finished_owner') finishRunAttempt(getActiveRunAttempt(f.session.id)!, 'superseded');
    if (mode === 'changed_summary' || mode === 'changed_payload') {
      const file = path.join(PENDING_ACTIONS_DIR, `${f.action.id}.json`);
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (mode === 'changed_summary') { record.resultSummary = 'Controlled later provider failure.'; record.updatedAt = new Date(Date.now() + 1).toISOString(); }
      else record.payload.command = 'echo different';
      writeFileSync(file, JSON.stringify(record));
    }
    return { message: endingWords, modelIdentity: 'controlled', evidenceDigest: mode === 'wrong_digest' ? '0'.repeat(64) : call.evidenceDigest };
  });
  const settled = await f.run(); assert.equal(calls, 1); assert.equal(f.effects(), 1);
  if (mode === 'finished_owner' || mode === 'changed_payload') {
    assert.equal(settled, false); assert.equal(f.terminal(), undefined, 'no borrowed owner or unbound payload publication');
  } else {
    assert.equal(settled, true); assert.doesNotMatch(String(f.terminal()!.data.reply), /Shall I/);
    const { pendingActionResultBinding } = await import('./pending-action-public-result.js');
    assert.deepEqual(f.terminal()!.data.pendingActionResultBinding, pendingActionResultBinding(getPendingAction(f.action.id)!, f.source()));
  }
});

test('approval result narrator Stop at the final managed publication check wins without changing uncertain effect truth', async () => {
  const f = endingFixture(); const db = openEventLog(); const prepare = db.prepare;
  let armed = false; let stopped = false;
  endingPort(async call => {
    armed = true; return { message: endingWords, modelIdentity: 'controlled', evidenceDigest: call.evidenceDigest };
  });
  db.prepare = function (sql: string) {
    if (armed && !stopped && db.inTransaction && sql.startsWith('SELECT source_user_seq, run_id, started_at, status, finished_at')) {
      stopped = true; requestKill(f.session.id, 'Controlled final-publication Stop.', { sourceUserSeq: f.source().seq });
    }
    return prepare.call(this, sql);
  } as typeof db.prepare;
  try {
    assert.equal(await f.run(), true); assert.equal(stopped, true);
    assert.equal(f.terminal()!.data.turnOutcome?.status, 'cancelled');
    assert.equal(f.terminal()!.data.hostNotice?.code, 'stopped');
    assert.doesNotMatch(String(f.terminal()!.data.reply), /Shall I/);
    assert.equal(getPendingAction(f.action.id)!.status, 'failed'); assert.equal(f.effects(), 1);
  } finally { db.prepare = prepare; }
});
