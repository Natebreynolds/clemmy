/**
 * Run: npx tsx --test src/runtime/harness/approval-expiry-card.test.ts
 *
 * An approval that expires unanswered must say so on its card and in the
 * Inbox. Before this, expiry wrote no event: an open chat kept live Approve
 * buttons, a chat replayed from its events drew them again, and a reopened
 * desktop chat dropped the card without a word. Each pin runs the real
 * reaper sweep and reads the result back the way each surface does.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-approval-expiry-card-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const reaper = await import('./reaper.js');
const reg = await import('./approval-registry.js');
const { appendEvent, createSession, closeEventLog, listEvents, openEventLog } = await import('./eventlog.js');
const { projectHarnessEventsForPublic } = await import('./public-presentation.js');
const { addNotification, listNotifications } = await import('../notifications.js');
const { getUnifiedSessionDetail } = await import('../../dashboard/sessions-api.js');
const { foldTranscript } = await import('../../../packages/chat-engine/src/engine.js');

test.after(() => {
  reaper.stopApprovalReaper();
  try { closeEventLog(); } catch { /* best effort */ }
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function raiseCard(title: string) {
  const session = createSession({ kind: 'chat', channel: 'desktop', title });
  appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'send the note' } });
  appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'conversation_completed', data: { reply: 'It needs your approval.' } });
  const row = reg.register({
    sessionId: session.id,
    subject: 'Send message',
    tool: 'send_message',
    args: { recipient: 'R-400', text: 'The review moved to 4:15.' },
    ttlMs: 24 * 60 * 60_000,
  });
  appendEvent({
    sessionId: session.id,
    turn: 0,
    role: 'Clem',
    type: 'approval_requested',
    data: {
      approvalId: row.approvalId,
      subject: 'Send message',
      tool: 'send_message',
      preview: { operation: 'Send message', fields: [{ name: 'text', value: 'The review moved to 4:15.' }] },
    },
  });
  addNotification({
    id: `approval-${row.approvalId}`,
    kind: 'approval',
    title: 'Approval pending',
    body: 'Send message',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { approvalId: row.approvalId, sessionId: session.id, tool: 'send_message' },
  });
  return { session, row };
}

test('an approval that expires unanswered settles its card as expired wherever the chat is read back', () => {
  const { session, row } = raiseCard('Expiry');
  openEventLog().prepare('UPDATE pending_approvals SET requested_at = ?, expires_at = ? WHERE approval_id = ?')
    .run(ago(25 * 60 * 60_000), ago(60 * 60_000), row.approvalId);

  reaper.reapOnce();
  assert.equal(reg.get(row.approvalId)?.status, 'expired', 'precondition: the sweep expired it');

  // The event log carries the card's outcome.
  const settled = listEvents(session.id, { types: ['approval_resolved'] });
  assert.equal(settled.length, 1);
  assert.equal(settled[0]!.data.approvalId, row.approvalId);
  assert.equal(settled[0]!.data.decision, 'expired');

  // A chat rebuilt from its public events (the phone, and any live view) shows
  // the card settled: no Approve button for a decision that no longer exists.
  const replayed = foldTranscript(projectHarnessEventsForPublic(listEvents(session.id)) as never);
  const card = replayed.find((message) => message.approval?.approvalId === row.approvalId);
  assert.ok(card, 'the card is still in the replayed chat');
  assert.equal(card.approval?.resolution, 'expired');

  // A reopened desktop chat keeps the card, marked expired, instead of ending
  // on the question with no sign of what happened.
  const detail = getUnifiedSessionDetail(`harness:${session.id}`);
  const cards = detail!.turns.filter((turn) => turn.approval);
  assert.equal(cards.length, 1, 'the expired card is still shown on reopen');
  assert.equal(cards[0]!.approval!.approvalId, row.approvalId);
  assert.equal(cards[0]!.approval!.resolution, 'expired');
  assert.equal(cards[0]!.approval!.preview?.fields[0]?.value, 'The review moved to 4:15.');

  // The Inbox: the ask is settled and one notice says plainly what happened.
  const notes = listNotifications(100).filter((item) => item.metadata?.approvalId === row.approvalId);
  assert.ok(notes.filter((item) => item.kind === 'approval').every((item) => item.read), 'the ask no longer waits');
  const expiredNote = notes.find((item) => item.title === 'Approval expired');
  assert.ok(expiredNote, 'one expiry notice');
  assert.match(expiredNote.body, /Send message\*\* expired without a reply/);
});

test('a decision that arrives after the card expired settles the card as expired too', () => {
  const { session, row } = raiseCard('Late decision');
  // The lifetime ran out before the sweep got to it; then the owner decides.
  openEventLog().prepare('UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?')
    .run(ago(60_000), row.approvalId);

  const late = reg.resolve(row.approvalId, 'approved', 'approval-expiry-card-test');
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'expired', 'precondition: the registry refuses the late decision as an expiry');

  const settled = listEvents(session.id, { types: ['approval_resolved'] });
  assert.equal(settled.length, 1);
  assert.equal(settled[0]!.data.decision, 'expired');
  const replayed = foldTranscript(projectHarnessEventsForPublic(listEvents(session.id)) as never);
  assert.equal(
    replayed.find((message) => message.approval?.approvalId === row.approvalId)?.approval?.resolution,
    'expired',
  );

  reaper.reapOnce();
  assert.equal(listEvents(session.id, { types: ['approval_resolved'] }).length, 1, 'the sweep adds no second mark');
});

test('an answered approval still leaves no card on reopen and no expiry mark', () => {
  const { session, row } = raiseCard('Answered');
  assert.equal(reg.resolve(row.approvalId, 'rejected', 'approval-expiry-card-test').ok, true);

  reaper.reapOnce();

  assert.equal(listEvents(session.id, { types: ['approval_resolved'] }).length, 0, 'the reaper wrote nothing');
  const detail = getUnifiedSessionDetail(`harness:${session.id}`);
  assert.equal(detail!.turns.filter((turn) => turn.approval).length, 0, 'an answered card renders nothing on reopen');
});
