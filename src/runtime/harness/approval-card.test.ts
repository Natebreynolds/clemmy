import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-atomic-approval-card-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const cards = await import('./approval-card.js');
const approvals = await import('./approval-registry.js');
const eventlog = await import('./eventlog.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function request(sessionId: string, resumeKey: string) {
  return {
    sessionId,
    resumeKey,
    subject: 'Authorize one exact generated pilot',
    tool: 'generated_pilot_control',
    args: { revision: 3, digest: 'a'.repeat(64) },
    extra: { workflowRevision: 3, compilationDigest: 'b'.repeat(64) },
  };
}

test('approval row and visible card commit atomically and replay exactly', () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const first = cards.registerResumableApprovalCardAtomically(
    request(session.id, `pilot:${session.id}:3`),
  );
  assert.equal(first.approvalCreated, true);
  assert.equal(first.eventCreated, true);
  assert.equal(first.event.data.approvalId, first.row.approvalId);
  assert.equal(first.event.data.resumeKey, `pilot:${session.id}:3`);
  assert.equal(approvals.inspectResumableApproval(`pilot:${session.id}:3`).state, 'pending');

  const replay = cards.registerResumableApprovalCardAtomically(
    request(session.id, `pilot:${session.id}:3`),
  );
  assert.equal(replay.approvalCreated, false);
  assert.equal(replay.eventCreated, false);
  assert.equal(replay.row.approvalId, first.row.approvalId);
  assert.equal(replay.event.id, first.event.id);
  assert.equal(eventlog.listEvents(session.id, { types: ['approval_requested'] }).length, 1);
});

test('a historical pending row without a card is repaired without minting authority', () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const resumeKey = `pilot:${session.id}:repair`;
  const row = approvals.registerResumable(request(session.id, resumeKey));
  assert.equal(row.created, true);
  assert.equal(eventlog.listEvents(session.id, { types: ['approval_requested'] }).length, 0);

  const repaired = cards.registerResumableApprovalCardAtomically(request(session.id, resumeKey));
  assert.equal(repaired.approvalCreated, false);
  assert.equal(repaired.eventCreated, true);
  assert.equal(repaired.row.approvalId, row.row.approvalId);
  assert.equal(repaired.event.data.approvalId, row.row.approvalId);
});

test('event serialization failure rolls the approval row back with it', () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const resumeKey = `pilot:${session.id}:rollback`;
  assert.throws(
    () => cards.registerResumableApprovalCardAtomically({
      ...request(session.id, resumeKey),
      extra: { unsupported: 1n },
    }),
    /serialize|BigInt/i,
  );
  assert.equal(approvals.inspectResumableApproval(resumeKey).state, 'none');
  assert.equal(eventlog.listEvents(session.id, { types: ['approval_requested'] }).length, 0);
});

test('file-backed PendingActions stay on their reconciled transition seam', () => {
  const session = eventlog.createSession({ kind: 'chat' });
  assert.throws(
    () => cards.registerResumableApprovalCardAtomically({
      ...request(session.id, `pending:${session.id}`),
      args: { pendingActionId: 'pending-action-owned-elsewhere' },
    }),
    /does not own file-backed PendingAction linkage/i,
  );
  assert.equal(approvals.inspectResumableApproval(`pending:${session.id}`).state, 'none');
});

test('conversational approvals stay on the prompt-binding seam', () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const resumeKey = `conversation:${session.id}`;
  assert.throws(
    () => cards.registerResumableApprovalCardAtomically({
      ...request(session.id, resumeKey),
      presentation: {
        version: 1,
        kind: 'autonomous_send_consent',
        question: 'Proceed?',
        actionLabel: 'send',
        target: 'generated target',
        subject: null,
        bodyPreview: null,
        resultUrl: null,
        sourceUserSeq: 1,
        originReplyTarget: { type: 'origin_chat' },
        originReplyTargetDigest: 'c'.repeat(64),
        conversationKey: `console:${session.id}`,
        audienceUserId: 'generated-user',
      },
    }),
    /formal cards only/i,
  );
  assert.equal(approvals.inspectResumableApproval(resumeKey).state, 'none');
});
