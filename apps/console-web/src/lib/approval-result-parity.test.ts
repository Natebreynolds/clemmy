import test from 'node:test';
import assert from 'node:assert/strict';
import { historyToMessages } from '../features/conversations/chat/conversation-history';
import { appendLiveApprovalCard, pendingActionFromEvent, pendingActionNeedsPayloadHydration, mergePendingActionHydration, type ChatMessage } from './useChat';
import type { Turn } from '../features/conversations/types';
const owner = 'raw-parent-session';
const record = { id: 'pa-parity', approvalId: 'apr-parity', payloadHash: 'a'.repeat(16),
  updatedAt: '2026-10-19T12:00:00.000Z', status: 'executed', resultSummary: 'Raw retained output.' };
const result = { version: 1 as const, pendingActionId: record.id, approvalId: record.approvalId, payloadHash: record.payloadHash,
  recordUpdatedAt: record.updatedAt, status: 'executed' as const, source: 'terminal' as const,
  text: 'The approved fixture call completed.', terminal: { eventId: 'fixture-result', sourceUserSeq: 19 } };
const full = { ...record, publicResult: result, toolName: 'run_shell_command', title: 'Controlled fixture', summary: '', kind: 'shell_command',
  targetSummary: '', preview: '', risk: '', rollback: '', payload: {}, idempotencyKey: 'fixture', createdAt: record.updatedAt };

test('desktop event decoder keeps only a public result bound to the exact durable record', () => {
  assert.deepEqual(pendingActionFromEvent(full)?.publicResult, result);
  for (const bad of [ { ...result, pendingActionId: 'other' }, { ...result, approvalId: 'other' },
    { ...result, payloadHash: 'other' }, { ...result, recordUpdatedAt: '2026-10-19T12:00:01Z' },
    { ...result, status: 'failed' }, { ...result, terminal: { eventId: 'fixture-result', sourceUserSeq: 0 } } ]) {
    assert.equal(pendingActionFromEvent({ ...full, publicResult: bad })?.publicResult, undefined);
  }
});

test('reopened closed cards preserve raw owner, exact result relation and every canonical resolution', () => {
  for (const resolution of ['approved','declined','changed','expired','cancelled']) {
    const turn: Turn = { role: 'assistant', text: '', createdAt: record.updatedAt, approval: {
      subject: 'Controlled fixture', approvalId: record.approvalId, ownerSessionId: owner,
      pendingAction: { ...record, publicResult: result }, resolution,
    } };
    const row = historyToMessages([turn])[0]!;
    assert.equal(row.approval?.resolution, resolution);
    assert.equal(row.approval?.ownerSessionId, owner);
    assert.equal(row.approval?.resultRecord?.publicResult?.text, result.text);
    assert.equal(row.approval?.pendingActionId, record.id);
    assert.equal(row.approval?.pendingAction, undefined, 'minimal result is not an editable/executable action view');
    assert.equal(pendingActionNeedsPayloadHydration(row), false, 'opening closed history must not fetch every old payload');
  }
});

test('live exact event owner is retained and a current execution head is never substituted for a missing owner', () => {
  const row = appendLiveApprovalCard([], { seq: 3, turn: 1, role: 'assistant', type: 'approval_requested', sessionId: owner,
    data: { approvalId: record.approvalId, subject: 'Controlled fixture', pendingAction: { ...record, publicResult: result } } })[0]!;
  assert.equal(row.approval?.ownerSessionId, owner);
  assert.equal(row.approval?.resultRecord?.publicResult?.text, result.text);
  const noOwner = appendLiveApprovalCard([], { seq: 3, turn: 1, role: 'assistant', type: 'approval_requested', data: {
    approvalId: record.approvalId, subject: 'Controlled fixture', pendingAction: full,
  } })[0]!;
  assert.equal(noOwner.approval?.ownerSessionId, undefined);
});

test('late payload hydration cannot revive a closed, revised or foreign card', () => {
  const waiting: ChatMessage = { id: 'waiting', role: 'assistant', text: '', status: 'awaiting-approval', approval: {
    subject: 'Controlled fixture', approvalId: record.approvalId, pendingActionId: record.id,
    payloadHash: record.payloadHash, recordUpdatedAt: record.updatedAt,
  } };
  assert.equal(pendingActionNeedsPayloadHydration(waiting), true);
  const closed: ChatMessage = { ...waiting, id: 'closed', approval: { ...waiting.approval!, resolution: 'cancelled' } };
  const foreign: ChatMessage = { ...waiting, id: 'foreign', approval: { ...waiting.approval!, approvalId: 'apr-foreign' } };
  const revised: ChatMessage = { ...waiting, id: 'revised', approval: { ...waiting.approval!, payloadHash: 'b'.repeat(16) } };
  const read = pendingActionFromEvent(full)!;
  const rows = mergePendingActionHydration([waiting, closed, foreign, revised], record.id, read);
  assert.equal(rows[0]?.approval?.pendingAction, read);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i]?.approval?.pendingAction, undefined);
  const owned: ChatMessage = { ...waiting, approval: { ...waiting.approval!, resultRecord: { ...record, status: 'executing' } } };
  assert.equal(pendingActionNeedsPayloadHydration(owned), false, 'known acquired work does not trigger a new history payload read');
});
