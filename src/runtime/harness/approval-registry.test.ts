/**
 * Run: npx tsx --test src/runtime/harness/approval-registry.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-approval-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NewConversationalApprovalPresentation } from './approval-registry.js';

const reg = await import('./approval-registry.js');
const pending = await import('./pending-actions.js');
const { appendEvent, createSession, closeEventLog, openEventLog } = await import('./eventlog.js');
const { addNotification, listNotifications } = await import('../notifications.js');
const { exactOriginDeliveryTargetDigest } = await import('../exact-origin-delivery.js');
const { pendingActionApprovalView } = await import('./pending-action-view.js');

function conversationalPresentation(
  sourceUserSeq: number,
  overrides: Partial<NewConversationalApprovalPresentation> = {},
): NewConversationalApprovalPresentation {
  const originReplyTarget = { type: 'discord_channel' as const, channelId: 'consent-channel' };
  return {
    version: 1,
    kind: 'autonomous_send_consent',
    question: 'The sheet is ready. Send the exact email to proof@example.com with subject **Proof**?',
    actionLabel: 'email',
    target: 'proof@example.com',
    subject: 'Proof',
    bodyPreview: 'Here is the finished sheet: https://docs.google.com/spreadsheets/d/proof',
    resultUrl: 'https://docs.google.com/spreadsheets/d/proof',
    sourceUserSeq,
    originReplyTarget,
    originReplyTargetDigest: exactOriginDeliveryTargetDigest(originReplyTarget),
    conversationKey: 'discord:consent-channel',
    audienceUserId: 'human-proof',
    ...overrides,
  };
}

function bindConsentPrompt(input: {
  sessionId: string;
  approvalId: string;
  question: string;
}): ReturnType<typeof appendEvent> {
  const prompt = appendEvent({
    sessionId: input.sessionId,
    turn: 1,
    role: 'Clem',
    type: 'approval_requested',
    data: {
      approvalId: input.approvalId,
      approvalPresentation: 'conversation',
      question: input.question,
    },
  });
  reg.bindConversationalApprovalPrompt({
    approvalId: input.approvalId,
    promptEventId: prompt.id,
    promptEventSeq: prompt.seq,
  });
  return prompt;
}

test.beforeEach(() => {
  // Tests share one DB across the file; wipe the registry rows so each
  // test starts from a known state instead of inheriting leftovers from
  // prior tests. The sessions stay (cheap, FK target for the registry).
  const db = openEventLog();
  db.prepare('DELETE FROM pending_approvals').run();
  rmSync(path.join(TMP_HOME, 'pending-actions'), { recursive: true, force: true });
});

test.after(() => {
  try { closeEventLog(); } catch { /* best effort */ }
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('register returns a row with an apr- prefixed id and pending status', () => {
  const session = createSession({ kind: 'chat' });
  const row = reg.register({
    sessionId: session.id,
    subject: 'Save Salesforce CLI rule to memory',
    tool: 'request_approval',
    args: { destructive: false },
    channel: 'discord',
    channelId: 'C1',
  });
  assert.match(row.approvalId, /^apr-[a-z0-9]{4}$/);
  assert.equal(row.sessionId, session.id);
  assert.equal(row.subject, 'Save Salesforce CLI rule to memory');
  assert.equal(row.status, 'pending');
  assert.equal(row.channel, 'discord');
  assert.equal(row.channelId, 'C1');
  assert.deepEqual(row.args, { destructive: false });
});

test('get returns the registered row by id', () => {
  const session = createSession({ kind: 'chat' });
  const registered = reg.register({ sessionId: session.id, subject: 'test' });
  const fetched = reg.get(registered.approvalId);
  assert.ok(fetched);
  assert.equal(fetched.approvalId, registered.approvalId);
  assert.equal(fetched.subject, 'test');
});

test('listPending filters by session and channel', () => {
  const sA = createSession({ kind: 'chat' });
  const sB = createSession({ kind: 'chat' });
  reg.register({ sessionId: sA.id, subject: 'one', channelId: 'C1' });
  reg.register({ sessionId: sA.id, subject: 'two', channelId: 'C2' });
  reg.register({ sessionId: sB.id, subject: 'three', channelId: 'C1' });

  const bySessionA = reg.listPending({ sessionId: sA.id });
  assert.equal(bySessionA.length, 2);

  const byChannelC1 = reg.listPending({ channelId: 'C1' });
  // Includes rows from both sessions, only the C1 ones.
  assert.equal(byChannelC1.length, 2);
  assert.ok(byChannelC1.every((row) => row.channelId === 'C1'));
});

test('hasPending is true while there is at least one pending row for the session', () => {
  const session = createSession({ kind: 'chat' });
  assert.equal(reg.hasPending(session.id), false);

  const r = reg.register({ sessionId: session.id, subject: 'pending check' });
  assert.equal(reg.hasPending(session.id), true);

  reg.resolve(r.approvalId, 'approved', 'unit-test');
  assert.equal(reg.hasPending(session.id), false);
});

test('resolve is atomic — only one of two racing resolves wins', () => {
  const session = createSession({ kind: 'chat' });
  const r = reg.register({ sessionId: session.id, subject: 'race' });

  const first = reg.resolve(r.approvalId, 'approved', 'user-A');
  const second = reg.resolve(r.approvalId, 'rejected', 'user-B');

  assert.equal(first.ok, true);
  assert.equal(first.row?.resolution, 'approved');
  assert.equal(first.row?.resolver, 'user-A');

  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already_resolved');
  // Second's row reflects the winning resolution.
  assert.equal(second.row?.resolution, 'approved');
});

test('system cleanup has a truthful terminal resolution while historical user cancellation remains readable', () => {
  const systemSession = createSession({ kind: 'chat' });
  const action = pending.queuePendingAction({
    title: 'System-owned cleanup',
    summary: 'This action belongs to a dead session.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'proof@example.com' } },
    sessionId: systemSession.id,
  });
  const systemRow = reg.register({
    sessionId: systemSession.id,
    subject: 'System cleanup card',
    args: { pendingActionId: action.id },
  });
  const systemResult = reg.resolve(
    systemRow.approvalId,
    'cancelled_by_system',
    'reaper-dead-session',
  );
  assert.equal(systemResult.ok, true);
  assert.equal(systemResult.row?.status, 'cancelled');
  assert.equal(systemResult.row?.resolution, 'cancelled_by_system');
  assert.equal(systemResult.row?.resolver, 'reaper-dead-session');
  assert.equal(pending.getPendingAction(action.id)?.status, 'cancelled');

  const historicalSession = createSession({ kind: 'chat' });
  const historicalRow = reg.register({
    sessionId: historicalSession.id,
    subject: 'User cancelled this card',
  });
  const historicalResult = reg.resolve(
    historicalRow.approvalId,
    'cancelled_by_user',
    'discord-user',
  );
  assert.equal(historicalResult.ok, true);
  assert.equal(historicalResult.row?.status, 'resolved', 'old persisted status semantics remain readable');
  assert.equal(historicalResult.row?.resolution, 'cancelled_by_user');
});

test('resolve atomically expires an overdue approve or reject attempt', () => {
  for (const attempted of ['approved', 'rejected'] as const) {
    const session = createSession({ kind: 'chat' });
    const row = reg.register({ sessionId: session.id, subject: `late ${attempted}` });
    openEventLog().prepare(
      'UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?',
    ).run(new Date(Date.now() - 1_000).toISOString(), row.approvalId);

    const result = reg.resolve(row.approvalId, attempted, 'late-human');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'expired');
    assert.equal(result.row?.status, 'expired');
    assert.equal(result.row?.resolution, 'expired');
    assert.equal(result.row?.consumedAt, null);

    const replay = reg.resolve(row.approvalId, attempted, 'later-human');
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, 'already_resolved');
    assert.equal(replay.row?.resolution, 'expired');
  }
});

test('resolving a superseded card cannot overwrite the pending action owned by its replacement', () => {
  const session = createSession({ kind: 'chat' });
  const action = pending.queuePendingAction({
    title: 'Send exact email',
    summary: 'Waiting for the current card.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'proof@example.com' } },
    sessionId: session.id,
  });
  const oldCard = reg.register({
    sessionId: session.id,
    subject: 'Old card',
    tool: 'composio_execute_tool',
    args: { pendingActionId: action.id },
  });
  const replacement = reg.register({
    sessionId: session.id,
    subject: 'Replacement card',
    tool: 'composio_execute_tool',
    args: { pendingActionId: action.id },
  });
  assert.equal(pending.getPendingAction(action.id)?.approvalId, replacement.approvalId);

  assert.equal(reg.resolve(oldCard.approvalId, 'rejected', 'late-old-card').ok, true);
  const after = pending.getPendingAction(action.id);
  assert.equal(after?.approvalId, replacement.approvalId);
  assert.equal(after?.status, 'approval_requested', 'old-card resolution is audit-only for the superseded action link');
});

test('resolve marks matching approval notifications read', () => {
  const session = createSession({ kind: 'chat' });
  const r = reg.register({ sessionId: session.id, subject: 'notify cleanup' });
  addNotification({
    id: `approval-${r.approvalId}`,
    kind: 'approval',
    title: 'Approval pending',
    body: 'waiting',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { approvalId: r.approvalId },
  });

  const result = reg.resolve(r.approvalId, 'approved', 'unit-test');
  assert.equal(result.ok, true);
  const notification = listNotifications(20).find((item) => item.id === `approval-${r.approvalId}`);
  assert.equal(notification?.read, true);
  assert.equal(notification?.metadata?.approvalResolution, 'approved');
});

test('register/resolve mirror pendingActionId status into the pending-action queue', () => {
  const session = createSession({ kind: 'chat' });
  const action = pending.queuePendingAction({
    title: 'Send queued proof',
    summary: 'Prepared proof email.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'proof@example.com' } },
    sessionId: session.id,
  });

  const row = reg.register({
    sessionId: session.id,
    subject: 'Send queued proof',
    tool: 'request_approval',
    args: { pendingActionId: action.id, destructive: false },
  });
  assert.equal(pending.getPendingAction(action.id)?.status, 'approval_requested');
  assert.equal(pending.getPendingAction(action.id)?.approvalId, row.approvalId);

  const result = reg.resolve(row.approvalId, 'approved', 'unit-test');
  assert.equal(result.ok, true);
  assert.equal(pending.getPendingAction(action.id)?.status, 'approved');
});

test('register cannot link a pending action owned by another session', () => {
  const owner = createSession({ kind: 'chat' });
  const attacker = createSession({ kind: 'chat' });
  const action = pending.queuePendingAction({
    title: 'Owner-only send',
    summary: 'This exact payload belongs to the owner session.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'owner@example.com' } },
    sessionId: owner.id,
  });

  assert.throws(
    () => reg.register({
      sessionId: attacker.id,
      subject: 'Forged cross-session card',
      tool: 'request_approval',
      args: { pendingActionId: action.id },
    }),
    /does not belong to this session/,
  );
  assert.equal(pending.getPendingAction(action.id)?.status, 'queued');
  assert.equal(pending.getPendingAction(action.id)?.approvalId, null);
  assert.equal(reg.listPending({ sessionId: attacker.id, status: 'pending' }).length, 0);
});

test('resolve reports not_found for unknown ids', () => {
  const result = reg.resolve('apr-xxxx', 'approved', 'whoever');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
});

test('expireStaleApprovals marks past-due rows expired and returns them', async () => {
  const session = createSession({ kind: 'chat' });
  // 5ms TTL — guaranteed expired on the next reaper tick.
  const r = reg.register({ sessionId: session.id, subject: 'will expire', ttlMs: 5 });

  // Wait for the TTL to elapse.
  await new Promise((res) => setTimeout(res, 20));

  const expired = reg.expireStaleApprovals(new Date());
  assert.ok(expired.some((row) => row.approvalId === r.approvalId));
  assert.equal(expired.find((row) => row.approvalId === r.approvalId)?.resolution, 'expired');
  assert.equal(expired.find((row) => row.approvalId === r.approvalId)?.status, 'expired');

  // hasPending now returns false.
  assert.equal(reg.hasPending(session.id), false);
});

test('expireStaleApprovals is idempotent — second call is a no-op', async () => {
  const session = createSession({ kind: 'chat' });
  reg.register({ sessionId: session.id, subject: 'expire me', ttlMs: 5 });
  await new Promise((res) => setTimeout(res, 20));

  const firstPass = reg.expireStaleApprovals();
  const secondPass = reg.expireStaleApprovals();
  assert.ok(firstPass.length >= 1);
  assert.equal(secondPass.length, 0);
});

test('listPending status:any includes resolved rows for history', () => {
  const session = createSession({ kind: 'chat' });
  const r = reg.register({ sessionId: session.id, subject: 'will resolve' });
  reg.resolve(r.approvalId, 'approved', 'tester');

  const pending = reg.listPending({ sessionId: session.id, status: 'pending' });
  assert.equal(pending.find((row) => row.approvalId === r.approvalId), undefined);

  const all = reg.listPending({ sessionId: session.id, status: 'any' });
  assert.ok(all.some((row) => row.approvalId === r.approvalId));
});

test('resumable approval registration dedupes and an approved grant is claimed exactly once across reopen', () => {
  const session = createSession({ kind: 'workflow' });
  const input = {
    sessionId: session.id,
    subject: 'Send exact message?',
    tool: 'composio_execute_tool',
    args: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'proof@example.com', body: 'exact' } },
    resumeKey: 'resume-exact-message-1',
  };

  const first = reg.registerResumable(input);
  const duplicate = reg.registerResumable(input);
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.row.approvalId, first.row.approvalId);
  assert.equal(reg.listPending({ sessionId: session.id }).length, 1);

  reg.resolve(first.row.approvalId, 'approved', 'unit-test-human');
  closeEventLog(); // simulate a daemon restart before the step reruns

  const claimed = reg.claimResumableApproval(input.resumeKey);
  assert.equal(claimed.state, 'approved');
  assert.equal(claimed.state === 'approved' && claimed.row.approvalId, first.row.approvalId);
  assert.ok(claimed.state === 'approved' && claimed.row.consumedAt, 'the one-shot grant is durably consumed');

  const replay = reg.claimResumableApproval(input.resumeKey);
  assert.equal(replay.state, 'consumed', 'the exact approved payload cannot reuse the grant twice');
});

test('a persisted late-approved resumable row cannot be consumed', () => {
  const session = createSession({ kind: 'workflow' });
  const registered = reg.registerResumable({
    sessionId: session.id,
    subject: 'Late historical grant',
    tool: 'fixture_read',
    args: { key: 'exact' },
    resumeKey: 'late-historical-resume',
  });
  const expiredAt = new Date(Date.now() - 2_000).toISOString();
  const lateResolvedAt = new Date(Date.now() - 1_000).toISOString();
  openEventLog().prepare(`
    UPDATE pending_approvals
       SET expires_at = ?, status = 'resolved', resolution = 'approved',
           resolver = 'historical-writer', resolved_at = ?, consumed_at = NULL
     WHERE approval_id = ?
  `).run(expiredAt, lateResolvedAt, registered.row.approvalId);

  const inspected = reg.inspectResumableApproval(registered.row.resumeKey!);
  assert.equal(inspected.state, 'expired');
  const claimed = reg.claimResumableApproval(
    registered.row.resumeKey!,
    registered.row.approvalId,
  );
  assert.equal(claimed.state, 'expired');
  assert.equal(reg.get(registered.row.approvalId)?.consumedAt, null);
});

test('conversational send consent survives restart windows and grants its frozen payload exactly once', () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Make the sheet and prepare an email to proof@example.com.',
      userId: 'human-proof',
      conversationKey: 'discord:consent-channel',
    },
  });
  const input = {
    sessionId: session.id,
    subject: 'Send exact proof email?',
    tool: 'mcp__outlook__OUTLOOK_SEND_EMAIL',
    args: {
      to: 'proof@example.com',
      subject: 'Proof',
      body: 'Here is the finished sheet: https://docs.google.com/spreadsheets/d/proof',
    },
    resumeKey: 'direct-consent-restart-exact',
    presentation: conversationalPresentation(source.seq),
  };
  const registered = reg.registerResumable(input);
  const duplicateBeforePrompt = reg.registerResumable(input);
  assert.equal(duplicateBeforePrompt.created, false);
  assert.equal(duplicateBeforePrompt.row.approvalId, registered.row.approvalId);
  assert.equal(reg.listPending({ sessionId: session.id }).length, 1);

  const prompt = bindConsentPrompt({
    sessionId: session.id,
    approvalId: registered.row.approvalId,
    question: input.presentation.question,
  });
  const response = appendEvent({
    sessionId: session.id,
    turn: 0,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Yes',
      source: 'channel_send_consent',
      approvalId: registered.row.approvalId,
      decision: 'approve',
      userId: 'human-proof',
      conversationKey: 'discord:consent-channel',
    },
  });
  assert.equal(reg.claimConversationalApprovalReply({
    approvalId: registered.row.approvalId,
    sourceUserSeq: response.seq,
    userId: 'human-proof',
    conversationKey: 'discord:consent-channel',
    decision: 'approve',
  }), null, 'a persisted prompt event without a successful transport receipt grants nothing');

  reg.markConversationalApprovalPresented({
    approvalId: registered.row.approvalId,
    promptEventId: prompt.id,
    promptEventSeq: prompt.seq,
  });
  const claimedReply = reg.claimConversationalApprovalReply({
    approvalId: registered.row.approvalId,
    sourceUserSeq: response.seq,
    userId: 'human-proof',
    conversationKey: 'discord:consent-channel',
    decision: 'approve',
  });
  assert.equal(claimedReply?.presentation?.responseSourceUserSeq, response.seq);
  assert.equal(reg.claimConversationalApprovalReply({
    approvalId: registered.row.approvalId,
    sourceUserSeq: response.seq,
    userId: 'human-proof',
    conversationKey: 'discord:consent-channel',
    decision: 'approve',
  }), null, 'the durable reply CAS has one winner');

  assert.equal(reg.resolve(registered.row.approvalId, 'approved', 'discord-conversation').ok, true);
  closeEventLog(); // crash after resolution, before the frozen provider call claims authority
  const firstExecution = reg.claimResumableApproval(input.resumeKey, registered.row.approvalId);
  assert.equal(firstExecution.state, 'pending_action_owned');
  assert.equal(reg.claimResumableApproval(input.resumeKey, registered.row.approvalId).state, 'pending_action_owned');
  assert.equal(reg.get(registered.row.approvalId)?.consumedAt, null,
    'raw replay cannot consume host-owned pending-action authority');
});

test('conversational consent is exact-user, exact-thread, immediate-next and atomically demotes siblings', () => {
  const firstSession = createSession({ kind: 'chat', channel: 'discord' });
  const firstSource = appendEvent({
    sessionId: firstSession.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Prepare it.', userId: 'human-proof', conversationKey: 'discord:consent-channel' },
  });
  const first = reg.register({
    sessionId: firstSession.id,
    subject: 'First exact send?',
    tool: 'mcp__outlook__OUTLOOK_SEND_EMAIL',
    args: { to: 'proof@example.com', subject: 'Proof', body: 'Exact.' },
    presentation: conversationalPresentation(firstSource.seq),
  });
  const firstPrompt = bindConsentPrompt({
    sessionId: firstSession.id,
    approvalId: first.approvalId,
    question: first.presentation!.question,
  });
  reg.markConversationalApprovalPresented({
    approvalId: first.approvalId,
    promptEventId: firstPrompt.id,
    promptEventSeq: firstPrompt.seq,
  });

  const wrongPerson = appendEvent({
    sessionId: firstSession.id,
    turn: 0,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Yes', source: 'channel_send_consent', approvalId: first.approvalId,
      decision: 'approve', userId: 'other-human', conversationKey: 'discord:consent-channel',
    },
  });
  assert.equal(reg.claimConversationalApprovalReply({
    approvalId: first.approvalId,
    sourceUserSeq: wrongPerson.seq,
    userId: 'other-human',
    conversationKey: 'discord:consent-channel',
    decision: 'approve',
  }), null);
  const lateRightPerson = appendEvent({
    sessionId: firstSession.id,
    turn: 0,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Yes', source: 'channel_send_consent', approvalId: first.approvalId,
      decision: 'approve', userId: 'human-proof', conversationKey: 'discord:consent-channel',
    },
  });
  assert.equal(reg.claimConversationalApprovalReply({
    approvalId: first.approvalId,
    sourceUserSeq: lateRightPerson.seq,
    userId: 'human-proof',
    conversationKey: 'discord:consent-channel',
    decision: 'approve',
  }), null, 'a later Yes cannot reclaim a slot whose immediate reply came from another user');

  const secondSession = createSession({ kind: 'chat', channel: 'discord' });
  const secondSource = appendEvent({
    sessionId: secondSession.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Prepare another.', userId: 'human-proof', conversationKey: 'discord:consent-channel' },
  });
  const second = reg.register({
    sessionId: secondSession.id,
    subject: 'Second exact send?',
    tool: 'mcp__outlook__OUTLOOK_SEND_EMAIL',
    args: { to: 'proof@example.com', subject: 'Another', body: 'Exact second.' },
    presentation: conversationalPresentation(secondSource.seq),
  });
  assert.equal(reg.get(first.approvalId)?.presentation, null);
  assert.equal(second.presentation, null);
  assert.equal(reg.isFormalApprovalSurface(reg.get(first.approvalId)!), true);
  assert.equal(reg.isFormalApprovalSurface(reg.get(second.approvalId)!), true);
});

test('pending-action execution accepts typed conversation evidence only for the exact frozen action', () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const originReplyTarget = { type: 'discord_channel' as const, channelId: 'consent-channel' };
  const originReplyTargetDigest = exactOriginDeliveryTargetDigest(originReplyTarget);
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Build the sheet and prepare the exact proof email.',
      userId: 'human-proof',
      conversationKey: 'discord:consent-channel',
      originReplyTarget,
      originReplyTargetDigest,
    },
  });
  const action = pending.queuePendingAction({
    title: 'Send proof email',
    summary: 'The finished sheet is ready.',
    kind: 'external_send',
    toolName: 'mcp__outlook__OUTLOOK_SEND_EMAIL',
    payload: {
      to: 'proof@example.com',
      subject: 'Proof',
      body: 'Here is the finished sheet: https://docs.google.com/spreadsheets/d/proof',
    },
    targetSummary: 'proof@example.com',
    preview: 'Here is the finished sheet: https://docs.google.com/spreadsheets/d/proof',
    sessionId: session.id,
  });
  const row = reg.register({
    sessionId: session.id,
    subject: 'Send exact proof email?',
    tool: 'request_approval',
    args: {
      pendingActionId: action.id,
      pendingAction: pendingActionApprovalView(action),
    },
    presentation: conversationalPresentation(source.seq),
  });
  const prompt = bindConsentPrompt({
    sessionId: session.id,
    approvalId: row.approvalId,
    question: row.presentation!.question,
  });
  reg.markConversationalApprovalPresented({
    approvalId: row.approvalId,
    promptEventId: prompt.id,
    promptEventSeq: prompt.seq,
  });
  const response = appendEvent({
    sessionId: session.id,
    turn: 0,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Yes',
      source: 'channel_send_consent',
      approvalId: row.approvalId,
      decision: 'approve',
      userId: 'human-proof',
      conversationKey: 'discord:consent-channel',
    },
  });
  assert.ok(reg.claimConversationalApprovalReply({
    approvalId: row.approvalId,
    sourceUserSeq: response.seq,
    userId: 'human-proof',
    conversationKey: 'discord:consent-channel',
    decision: 'approve',
  }));
  assert.equal(reg.resolve(row.approvalId, 'approved', 'discord-conversation').ok, true);

  const approved = pending.getPendingAction(action.id);
  assert.equal(approved?.approvedBy, 'human');
  assert.equal(approved?.approvalEvidence?.kind, 'conversation');
  assert.notEqual(approved?.approvalEvidence?.kind, 'card');
  const execution = pending.claimPendingActionExecution(action.id, 'typed-consent-test', {
    expectedSessionId: session.id,
    requireResolvedHumanCard: true,
  });
  assert.equal(execution.claimed, true, execution.record?.resultSummary ?? execution.reason);
  assert.ok(execution.claimToken);
  assert.equal(
    pending.claimPendingActionExecution(action.id, 'duplicate-consent-test', {
      expectedSessionId: session.id,
      requireResolvedHumanCard: true,
    }).claimed,
    false,
    'the same conversational decision cannot dispatch the pending action twice',
  );
});

test('resumable approval expected-id claim consumes the awaited row, not a newer same-key row', () => {
  const session = createSession({ kind: 'workflow' });
  const input = {
    sessionId: session.id,
    subject: 'Run exact action?',
    tool: 'm365__delete_item',
    args: { item_id: 'same-item' },
    resumeKey: 'resume-same-payload-race',
  };
  const awaited = reg.registerResumable(input).row;
  reg.resolve(awaited.approvalId, 'approved', 'unit-test-human');

  // Once the first card resolves, another identical attempt can create a newer
  // card with the same key before the original WAIT loop wakes up.
  const newer = reg.registerResumable(input).row;
  reg.resolve(newer.approvalId, 'approved', 'unit-test-human');

  const exact = reg.claimResumableApproval(input.resumeKey, awaited.approvalId);
  assert.equal(exact.state, 'approved');
  assert.equal(exact.state === 'approved' && exact.row.approvalId, awaited.approvalId);
  assert.ok(reg.get(awaited.approvalId)?.consumedAt);
  assert.equal(reg.get(newer.approvalId)?.consumedAt, null, 'the newer grant was not consumed by mistake');

  const newerClaim = reg.claimResumableApproval(input.resumeKey, newer.approvalId);
  assert.equal(newerClaim.state, 'approved');
});

test('resumable approval refuses a same-key row whose nested payload authority differs', () => {
  const session = createSession({ kind: 'workflow' });
  const first = reg.registerResumable({
    sessionId: session.id,
    subject: 'Send exact message?',
    tool: 'composio_execute_tool',
    args: {
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: { to: 'first@example.com', body: 'exact first body' },
    },
    resumeKey: 'resume-collision-proof',
  });
  assert.throws(
    () => reg.registerResumable({
      sessionId: session.id,
      subject: 'Send different message?',
      tool: 'composio_execute_tool',
      args: {
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: { to: 'second@example.com', body: 'different body' },
      },
      resumeKey: 'resume-collision-proof',
    }),
    /resume key collision across approval authority/,
  );
  const [remaining] = reg.listPending({ sessionId: session.id });
  assert.equal(remaining.approvalId, first.row.approvalId);
  assert.deepEqual(remaining.args, first.row.args, 'the original authority is never rewritten');
});

test('claimApprovedUnconsumedForSession: one-shot session claim for replay-supported tools only', () => {
  const session = createSession({ id: 'sess-session-claim', kind: 'workflow' });
  const row = reg.register({
    sessionId: session.id,
    subject: 'Run SLACK_SEND_MESSAGE?',
    tool: 'composio_execute_tool',
    args: { tool_slug: 'SLACK_SEND_MESSAGE', arguments: '{"channel":"C1","markdown_text":"hi"}' },
    resumeKey: 'claude-workflow-tool-v1:session-claim-a',
  });

  // Pending rows are never claimable — nothing may cross the boundary early.
  assert.equal(reg.claimApprovedUnconsumedForSession(session.id, { tools: ['composio_execute_tool'] }), null);

  reg.resolve(row.approvalId, 'approved', 'unit-test-human');

  // Tool filter: an unsupported tool list claims nothing.
  assert.equal(reg.claimApprovedUnconsumedForSession(session.id, { tools: ['run_shell_command'] }), null);

  const claimed = reg.claimApprovedUnconsumedForSession(session.id, { tools: ['composio_execute_tool'] });
  assert.ok(claimed, 'the approved row is claimable exactly once');
  assert.equal(claimed?.approvalId, row.approvalId);
  assert.ok(claimed?.consumedAt, 'the claim durably consumes the grant');

  // Second claim: nothing left (a racing duplicate re-admission cannot double-send).
  assert.equal(reg.claimApprovedUnconsumedForSession(session.id, { tools: ['composio_execute_tool'] }), null);
});

test('claimApprovedUnconsumedForSession: rejected rows stay terminal and unclaimed', () => {
  const session = createSession({ id: 'sess-session-claim-rej', kind: 'workflow' });
  const row = reg.register({
    sessionId: session.id,
    subject: 'Run SLACK_SEND_MESSAGE?',
    tool: 'composio_execute_tool',
    args: { tool_slug: 'SLACK_SEND_MESSAGE', arguments: '{}' },
  });
  reg.resolve(row.approvalId, 'rejected', 'unit-test-human');
  assert.equal(reg.claimApprovedUnconsumedForSession(session.id, { tools: ['composio_execute_tool'] }), null);
});

// Standing-consent graduation source (owner feedback, 2026-07-24): only
// HUMAN-approved sends graduate; rejections are one-shot and never poison
// future runs (live: the Slack team update died on a cleanup rejection).
test('approvedSendSlugsForSessions returns approved slugs only — rejections never graduate', () => {
  const sessA = createSession({ kind: 'workflow', title: 'wf::post_slack run 1' }).id;
  const sessB = createSession({ kind: 'workflow', title: 'wf::post_slack run 2' }).id;

  const ok = reg.register({
    sessionId: sessA, subject: 'Send Slack message', tool: 'composio_execute_tool',
    args: { tool_slug: 'SLACK_SEND_MESSAGE', arguments: '{"channel":"C1"}' },
  });
  reg.resolve(ok.approvalId, 'approved', 'discord-user');

  const no = reg.register({
    sessionId: sessB, subject: 'Send Slack message', tool: 'composio_execute_tool',
    args: { tool_slug: 'SLACK_SEND_MESSAGE', arguments: '{"channel":"C1"}' },
  });
  reg.resolve(no.approvalId, 'rejected', 'desktop-command-center');

  const slugs = reg.approvedSendSlugsForSessions([sessA, sessB]);
  assert.deepEqual(slugs, ['SLACK_SEND_MESSAGE'], 'approved run graduates');
  assert.deepEqual(reg.approvedSendSlugsForSessions([sessB]), [], 'a rejection alone graduates nothing');
  assert.deepEqual(reg.approvedSendSlugsForSessions([]), []);
});

test('provider-neutral resend consent is an explicit contract across an external broker transport', () => {
  const session = createSession({ kind: 'chat' });
  const target = 'provider-neutral@example.com';
  const row = reg.register({
    sessionId: session.id,
    subject: `Send a second email to ${target}`,
    tool: 'm365__callTool',
    args: {
      name: 'sendEmail',
      args_json: JSON.stringify({ to: target, subject: 'Approved follow-up' }),
    },
  });
  reg.resolve(row.approvalId, 'approved', 'provider-neutral-contract-test');

  const beforeApproval = '2020-01-01T00:00:00.000Z';
  assert.equal(
    reg.hasApprovedResendConsent(session.id, target, beforeApproval, 'email:reply'),
    false,
    'provider-neutral does not mean action-family neutral',
  );
  assert.equal(
    reg.hasApprovedResendConsent(session.id, target, beforeApproval, 'email:send'),
    true,
    'the semantic email-send approval is independent of its provider wrapper',
  );
  assert.equal(reg.claimApprovedResendConsent(session.id, target, beforeApproval, 'email:send'), true);
  assert.equal(
    reg.claimApprovedResendConsent(session.id, target, beforeApproval, 'email:send'),
    false,
    'provider-neutral resend consent remains one-shot',
  );
});

test('isApprovalStaleForHeader: 48h+ unanswered ages out; bound-to-work and fresh rows never do', () => {
  // Live 2026-08-09: two 90-day standing-grant asks rode the urgent header
  // for days. Aging is presentation-only — the row stays pending.
  const now = new Date('2026-08-11T12:00:00.000Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60_000).toISOString();
  assert.equal(reg.isApprovalStaleForHeader({ requestedAt: hoursAgo(1) }, { now }), false, 'fresh ask is urgent');
  assert.equal(reg.isApprovalStaleForHeader({ requestedAt: hoursAgo(47) }, { now }), false, 'inside the window stays urgent');
  assert.equal(reg.isApprovalStaleForHeader({ requestedAt: hoursAgo(49) }, { now }), true, 'unanswered 48h+ ages out');
  assert.equal(
    reg.isApprovalStaleForHeader({ requestedAt: hoursAgo(200) }, { now, boundToActiveWork: true }),
    false,
    'an approval something is actively parked on NEVER ages out of the header',
  );
  assert.equal(reg.isApprovalStaleForHeader({ requestedAt: 'garbage' }, { now }), false, 'unparseable timestamps stay urgent (fail-loud, not fail-hidden)');
});

test('the dashboard approvals endpoint consumes the header-staleness rule (who-calls-this pin)', async () => {
  const { readFileSync } = await import('node:fs');
  const routes = readFileSync(path.join(process.cwd(), 'src/dashboard/console-routes.ts'), 'utf-8');
  assert.match(routes, /isApprovalStaleForHeader/, 'staleness helper exists but the approvals endpoint never consults it');
  assert.match(routes, /urgentCount/, 'the endpoint must expose urgentCount so badges stop counting aged cards');
});
