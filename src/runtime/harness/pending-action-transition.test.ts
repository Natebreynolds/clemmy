/**
 * Deterministic graph edge proof:
 * queue -> one linked card -> human approval -> exact-once stored execution.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-pending-transition-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  appendEvent,
  closeEventLog,
  createSession,
  listEvents,
  openEventLog,
} = await import('./eventlog.js');
const approvalRegistry = await import('./approval-registry.js');
const {
  getPendingAction,
  queuePendingAction,
} = await import('./pending-actions.js');
const {
  pendingActionApprovalView,
} = await import('./pending-action-view.js');
const {
  isQueuedActionApprovalQuestion,
  materializeQueuedApprovals,
  queuedApprovalTransitionsForRequest,
} = await import('./pending-action-transition.js');
const {
  handleResolvedApprovalForChatResume,
  _resetChatApprovalResumeForTest,
} = await import('./chat-approval-resume.js');
const {
  executeApprovedPendingActionCall,
} = await import('../../execution/pending-action-executor.js');

test.beforeEach(() => {
  _resetChatApprovalResumeForTest();
  openEventLog().prepare('DELETE FROM pending_approvals').run();
  rmSync(path.join(TMP_HOME, 'pending-actions'), { recursive: true, force: true });
});

test.after(() => {
  try { closeEventLog(); } catch { /* best effort */ }
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function queueRequestOwnedSend() {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the reviewed launch update.' },
  });
  const record = queuePendingAction({
    title: 'Send the reviewed launch update',
    summary: 'Send one approved message to the exact reviewed recipient.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: {
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: {
        to: 'launch-proof@example.com',
        subject: 'Launch update',
        body: 'The reviewed release update.',
      },
    },
    sessionId: session.id,
  });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Clem',
    type: 'autonomy_note',
    data: {
      kind: 'pending_action_queued',
      pendingActionId: record.id,
      actionKind: record.kind,
      approvalRequired: true,
      payloadHash: record.payloadHash,
      sourceUserSeq: source.seq,
      runScopeId: 'proof-run',
      callId: 'proof-queue',
    },
  });
  return { session, source, record };
}

test('approval-edge question detection distinguishes authorization from missing payload details', () => {
  for (const positive of [
    'The exact email is queued. Should I send it?',
    'Should I execute the exact queued action now?',
    'Do you approve this execution?',
    'Would you like me to publish the reviewed post?',
    'Should I proceed?',
    'Would you like me to proceed?',
    'Ready to send 12 emails — approve to proceed or tell me to stop?',
    'Can I go ahead?',
  ]) {
    assert.equal(isQueuedActionApprovalQuestion(positive), true, positive);
  }
  for (const negative of [
    'Which account should I use?',
    'Which message should I send?',
    'Who should I send this to?',
    'What should I publish?',
    'When should I send it?',
    'Should I send these to the full list or just the top 10?',
    'Should I send this to Alice or Bob?',
    'Should I continue from the recorded state?',
    'Continue?',
    'Would you like me to continue?',
    'Should I proceed with the blue material?',
    'Should I proceed with the blue or green material?',
    'Can I go ahead with the green version?',
    'Can I go ahead with one account or the other?',
  ]) {
    assert.equal(isQueuedActionApprovalQuestion(negative), false, negative);
  }
});

test('queue -> one card -> approve -> resume -> exact payload dispatches once', async () => {
  const { session, source, record } = queueRequestOwnedSend();
  const transitions = queuedApprovalTransitionsForRequest(session.id, source.seq);
  assert.equal(transitions.length, 1);

  const materialized = materializeQueuedApprovals(
    session.id,
    1,
    source.seq,
    transitions,
  )[0];
  assert.ok(materialized?.created);
  assert.equal(getPendingAction(record.id)?.approvalId, materialized.approval.approvalId);
  assert.equal(getPendingAction(record.id)?.status, 'approval_requested');
  assert.equal(approvalRegistry.listPending({ sessionId: session.id }).length, 1);
  assert.equal(listEvents(session.id, { types: ['approval_requested'] }).length, 1);
  assert.equal(listEvents(session.id, { types: ['approval_parked'] }).length, 1);

  assert.equal(
    materializeQueuedApprovals(session.id, 1, source.seq, transitions).length,
    0,
    'the linked record cannot mint a second card',
  );
  assert.equal(approvalRegistry.listPending({ sessionId: session.id }).length, 1);

  const resolved = approvalRegistry.resolve(
    materialized.approval.approvalId,
    'approved',
    'human-proof',
  );
  assert.ok(resolved.ok && resolved.row);
  assert.equal(getPendingAction(record.id)?.status, 'approved');
  assert.equal(getPendingAction(record.id)?.approvedBy, 'human');

  const directives: string[] = [];
  assert.equal(
    await handleResolvedApprovalForChatResume(
      resolved.row!,
      async (_sessionId, directive) => { directives.push(directive); },
    ),
    true,
  );
  assert.equal(directives.length, 1);
  assert.match(directives[0], new RegExp(record.id));
  assert.match(directives[0], /pending_action_execute once/);
  assert.match(directives[0], /Do not .*reconstruct the underlying call/i);

  const dispatched: Array<{ tool: string; payload: unknown; sessionId: string }> = [];
  const executed = await executeApprovedPendingActionCall(record.id, {
    sessionId: session.id,
    dispatch: async (tool, payload, ownerSessionId) => {
      dispatched.push({ tool, payload, sessionId: ownerSessionId });
      return { success: true, providerId: 'msg-proof-1' };
    },
  });
  assert.equal(executed.status, 'executed');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].tool, record.toolName);
  assert.deepEqual(dispatched[0].payload, record.payload);
  assert.equal(dispatched[0].sessionId, session.id);
  assert.equal(getPendingAction(record.id)?.status, 'executed');

  const retry = await executeApprovedPendingActionCall(record.id, {
    sessionId: session.id,
    dispatch: async () => {
      throw new Error('a consumed grant must never dispatch twice');
    },
  });
  assert.equal(retry.status, 'skipped');
  assert.equal(dispatched.length, 1);
});

test('a preexisting exact resumable row is relinked and surfaced after a crash window', () => {
  const { session, source, record } = queueRequestOwnedSend();
  const approvalId = 'apr-rpr1';
  const resumeKey = `pending-action-approval-v1:${session.id}:${record.id}:${record.payloadHash}`;
  const now = new Date();
  const args = {
    subject: record.title,
    reason: record.summary,
    destructive: false,
    preview: null,
    pendingActionId: record.id,
    pendingAction: pendingActionApprovalView(record),
  };
  openEventLog().prepare(`
    INSERT INTO pending_approvals
      (approval_id, session_id, channel, channel_id, requested_at,
       expires_at, subject, tool, args_json, status, resume_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    approvalId,
    session.id,
    'discord',
    null,
    now.toISOString(),
    new Date(now.getTime() + 60_000).toISOString(),
    record.title,
    'request_approval',
    JSON.stringify(args),
    resumeKey,
  );
  assert.equal(getPendingAction(record.id)?.approvalId, null, 'simulated crash happened before file linkage');

  const transitions = queuedApprovalTransitionsForRequest(session.id, source.seq);
  assert.equal(transitions.length, 1);
  const repaired = materializeQueuedApprovals(session.id, 1, source.seq, transitions)[0];
  assert.ok(repaired);
  assert.equal(repaired!.approval.approvalId, approvalId);
  assert.equal(repaired!.created, true, 'this caller owns the previously missing surface events');
  assert.equal(getPendingAction(record.id)?.approvalId, approvalId);
  assert.equal(getPendingAction(record.id)?.status, 'approval_requested');
  assert.equal(listEvents(session.id, { types: ['approval_requested'] }).length, 1);
  assert.equal(listEvents(session.id, { types: ['approval_parked'] }).length, 1);

  assert.equal(
    materializeQueuedApprovals(session.id, 1, source.seq, transitions).length,
    0,
    'repair remains idempotent after the record is linked',
  );
  assert.equal(listEvents(session.id, { types: ['approval_requested'] }).length, 1);
  assert.equal(listEvents(session.id, { types: ['approval_parked'] }).length, 1);
});

test('an already-linked row is surfaced after a crash between linkage and card events', () => {
  const { session, source, record } = queueRequestOwnedSend();
  const args = {
    subject: record.title,
    reason: record.summary,
    destructive: false,
    preview: null,
    pendingActionId: record.id,
    pendingAction: pendingActionApprovalView(record),
  };
  const registered = approvalRegistry.registerResumable({
    sessionId: session.id,
    channel: 'discord',
    subject: record.title,
    tool: 'request_approval',
    args,
    resumeKey: `pending-action-approval-v1:${session.id}:${record.id}:${record.payloadHash}`,
  });
  assert.equal(getPendingAction(record.id)?.status, 'approval_requested');
  assert.equal(getPendingAction(record.id)?.approvalId, registered.row.approvalId);
  assert.equal(listEvents(session.id, { types: ['approval_requested'] }).length, 0);
  assert.equal(listEvents(session.id, { types: ['approval_parked'] }).length, 0);

  const transitions = queuedApprovalTransitionsForRequest(session.id, source.seq);
  assert.equal(transitions.length, 1, 'the exact linked row remains reconcilable');
  const repaired = materializeQueuedApprovals(session.id, 1, source.seq, transitions)[0];
  assert.ok(repaired);
  assert.equal(repaired!.approval.approvalId, registered.row.approvalId);
  assert.equal(listEvents(session.id, { types: ['approval_requested'] }).length, 1);
  assert.equal(listEvents(session.id, { types: ['approval_parked'] }).length, 1);
});

test('rejecting the one linked card never resumes or dispatches the queued action', async () => {
  const { session, source, record } = queueRequestOwnedSend();
  const transitions = queuedApprovalTransitionsForRequest(session.id, source.seq);
  assert.equal(transitions.length, 1);
  const materialized = materializeQueuedApprovals(session.id, 1, source.seq, transitions)[0];
  assert.ok(materialized);

  const resolved = approvalRegistry.resolve(
    materialized!.approval.approvalId,
    'rejected',
    'human-proof',
  );
  assert.ok(resolved.ok && resolved.row);
  assert.equal(getPendingAction(record.id)?.status, 'rejected');

  let resumed = false;
  assert.equal(
    await handleResolvedApprovalForChatResume(
      resolved.row!,
      async () => { resumed = true; },
    ),
    false,
  );
  let dispatched = false;
  const result = await executeApprovedPendingActionCall(record.id, {
    sessionId: session.id,
    dispatch: async () => { dispatched = true; return 'must never happen'; },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(resumed, false);
  assert.equal(dispatched, false);
});

test('one request gets one card per distinct payload hash and collapses same-payload retries', () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Add the launch review to Calendar and Airtable.' },
  });
  const calendarInput = {
    title: 'Create launch review calendar event',
    summary: 'Create the exact reviewed launch event.',
    kind: 'external_write' as const,
    toolName: 'composio_execute_tool',
    payload: {
      tool_slug: 'GOOGLECALENDAR_CREATE_EVENT',
      arguments: { title: 'Launch review', start: '2026-08-01T09:00:00-07:00' },
    },
    sessionId: session.id,
  };
  const calendar = queuePendingAction(calendarInput);
  const calendarRetry = queuePendingAction({
    ...calendarInput,
    title: 'Duplicate retry of launch review calendar event',
  });
  const airtable = queuePendingAction({
    title: 'Create launch review Airtable record',
    summary: 'Create the exact reviewed launch record.',
    kind: 'external_write',
    toolName: 'composio_execute_tool',
    payload: {
      tool_slug: 'AIRTABLE_CREATE_RECORD',
      arguments: { table: 'Content Calendar', title: 'Launch review', status: 'Planned' },
    },
    sessionId: session.id,
  });
  for (const [index, record] of [calendar, calendarRetry, airtable].entries()) {
    appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'Clem',
      type: 'autonomy_note',
      data: {
        kind: 'pending_action_queued',
        pendingActionId: record.id,
        actionKind: record.kind,
        approvalRequired: true,
        payloadHash: record.payloadHash,
        sourceUserSeq: source.seq,
        callId: `queue-${index + 1}`,
        autoMaterialize: record.id === calendarRetry.id,
      },
    });
  }

  const transitions = queuedApprovalTransitionsForRequest(session.id, source.seq);
  assert.equal(transitions.length, 2, 'Calendar and Airtable are distinct exact authorities');
  const calendarTransition = transitions.find((entry) => entry.record.payloadHash === calendar.payloadHash);
  const airtableTransition = transitions.find((entry) => entry.record.payloadHash === airtable.payloadHash);
  assert.equal(calendarTransition?.record.id, calendar.id, 'first exact Calendar record is canonical');
  assert.deepEqual(calendarTransition?.duplicateRecordIds, [calendarRetry.id]);
  assert.equal(calendarTransition?.autoMaterialize, true, 'same-hash edge metadata survives dedupe');
  assert.equal(airtableTransition?.record.id, airtable.id);
  assert.deepEqual(airtableTransition?.duplicateRecordIds, []);
  assert.equal(airtableTransition?.autoMaterialize, false);

  const materialized = materializeQueuedApprovals(
    session.id,
    1,
    source.seq,
    transitions,
  );
  assert.equal(materialized.length, 2);
  assert.equal(approvalRegistry.listPending({ sessionId: session.id, status: 'pending' }).length, 2);
  assert.equal(listEvents(session.id, { types: ['approval_requested'] }).length, 2);
  assert.equal(listEvents(session.id, { types: ['approval_parked'] }).length, 2);
  assert.equal(getPendingAction(calendar.id)?.status, 'approval_requested');
  assert.equal(getPendingAction(calendarRetry.id)?.status, 'cancelled');
  assert.equal(getPendingAction(airtable.id)?.status, 'approval_requested');
  const linkedIds = new Set(
    approvalRegistry.listPending({ sessionId: session.id, status: 'pending' })
      .map((row) => row.args?.pendingActionId),
  );
  assert.deepEqual(linkedIds, new Set([calendar.id, airtable.id]));

  assert.equal(
    materializeQueuedApprovals(
      session.id,
      1,
      source.seq,
      queuedApprovalTransitionsForRequest(session.id, source.seq),
    ).length,
    0,
    'reconciliation remains idempotent after both cards are surfaced',
  );
});
