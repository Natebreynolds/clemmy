/**
 * Run: npx tsx --test src/runtime/harness/chat-approval-resume.test.ts
 * Fail-closed approval park, resume half (2026-07-20): a PARKED chat approval
 * that is later APPROVED re-drives the session exactly once; rejections,
 * non-parked approvals, and in-flight sessions never dispatch.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
  listEvents,
  openEventLog,
  beginRunAttempt,
  recordRunAttemptUserInput,
} = await import('./eventlog.js');
const approvalRegistry = await import('./approval-registry.js');
const {
  getPendingAction,
  markPendingActionApprovalResolved,
  queuePendingAction,
} = await import('./pending-actions.js');
const { _setApprovedCallDispatchForTests } = await import('../../execution/pending-action-executor.js');
const { pendingActionApprovalView } = await import('./pending-action-view.js');
const { HarnessSession } = await import('./session.js');
const { recordTurnGraphShadow, turnGraphFromShadowEvent } = await import('../graph/turn-graph-shadow.js');
const {
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
test.afterEach(() => _setApprovedCallDispatchForTests(null));

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
  // brain is then handed the result to finish the rest of the request.
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
  assert.match(String(terminal!.data.reply), /^Done — "Send the reviewed proof" ran\./);
  assert.match(String(terminal!.data.reply), /Executed the approved run_shell_command call/);
  assert.match(String(terminal!.data.reply), /say "continue"/, 'the one next step is named');
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
