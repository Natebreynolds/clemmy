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
} = await import('./eventlog.js');
const approvalRegistry = await import('./approval-registry.js');
const {
  markPendingActionApprovalResolved,
  queuePendingAction,
} = await import('./pending-actions.js');
const { HarnessSession } = await import('./session.js');
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
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'test').row!;
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
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'test').row!;
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
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'test').row!;
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

test('a parked pending-action card resumes through exact queued execution, not a reconstructed approval call', async () => {
  const sess = createSession({ kind: 'chat' });
  const action = queuePendingAction({
    title: 'Send the reviewed proof',
    summary: 'Send one exact reviewed payload.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'proof@example.com' } },
    sessionId: sess.id,
  });
  const row = approvalRegistry.register({
    sessionId: sess.id,
    subject: 'Send the reviewed proof',
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
  const resolvedRow = approvalRegistry.resolve(row.approvalId, 'approved', 'test').row!;
  const directives: string[] = [];

  assert.equal(
    await handleResolvedApprovalForChatResume(
      resolvedRow,
      async (_sessionId, directive) => { directives.push(directive); },
    ),
    true,
  );
  assert.equal(directives.length, 1);
  assert.match(directives[0], /pending_action_execute once/);
  assert.match(directives[0], new RegExp(action.id));
  assert.doesNotMatch(directives[0], /re-run the approved tool call/i);
});

test('an exact linked pending-action card resumes even if a crash lost approval_parked', async () => {
  const sess = createSession({ kind: 'chat' });
  const action = queuePendingAction({
    title: 'Crash-window send',
    summary: 'The exact linked card survives a missing park event.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'proof@example.com' } },
    sessionId: sess.id,
  });
  const row = approvalRegistry.register({
    sessionId: sess.id,
    subject: action.title,
    tool: 'request_approval',
    args: { pendingActionId: action.id },
  });
  const resolvedAt = new Date().toISOString();
  openEventLog().prepare(`
    UPDATE pending_approvals
       SET status = 'resolved',
           resolution = 'approved',
           resolver = 'crash-recovery-test',
           resolved_at = ?
     WHERE approval_id = ?
  `).run(resolvedAt, row.approvalId);
  markPendingActionApprovalResolved(action.id, 'approved', row.approvalId);
  const resolved = approvalRegistry.get(row.approvalId)!;
  assert.equal(listEvents(sess.id, { types: ['approval_parked'] }).length, 0);

  const directives: string[] = [];
  assert.equal(
    await handleResolvedApprovalForChatResume(
      resolved,
      async (_sessionId, directive) => { directives.push(directive); },
    ),
    true,
  );
  assert.equal(directives.length, 1);
  assert.match(directives[0], new RegExp(action.id));
  assert.match(directives[0], /pending_action_execute once/);
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
  const resolvedRow = approvalRegistry.resolve(row.approvalId, 'approved', 'test').row!;
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
