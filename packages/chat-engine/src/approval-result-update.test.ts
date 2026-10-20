import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalResultUpdateGate, approvalResultUpdateLookup, normalizeApprovalResultUpdatedEvent, approvalResultUpdateMatchesRecord } from './approval-result-update.js';
import type { PendingActionResultRecord } from './pending-action-result.js';
const binding = { sessionId: 'card-owner', approvalId: 'apr-fixture', pendingActionId: 'pa-fixture', payloadHash: 'hash-fixture', recordUpdatedAt: '2026-10-20T01:00:00.000Z' };
const event = { ...binding, kind: 'approval.result_updated' as const, projectionId: 'projection-fixture' };
const record: PendingActionResultRecord = { id: binding.pendingActionId, approvalId: binding.approvalId, payloadHash: binding.payloadHash, updatedAt: binding.recordUpdatedAt,
  status: 'executed', resultSummary: 'Raw retained result.' };

test('only an exact visible-card update may request one bounded read; foreign identities cost no slot', () => {
  const gate = new ApprovalResultUpdateGate();
  for (const altered of [ { sessionId: 'execution-successor' }, { approvalId: 'other-card' }, { pendingActionId: 'other-action' },
    { payloadHash: 'changed' }, { recordUpdatedAt: '2026-10-20T01:00:01.000Z' }, { recordUpdatedAt: 'invalid' } ]) {
    assert.equal(gate.admit({ ...event, ...altered }, binding, record), null);
  }
  assert.deepEqual(gate.admit(event, binding, record), event);
  assert.equal(gate.admit(event, binding, record), null);
  assert.equal(gate.admit({ ...event, projectionId: 'replacement-projection' }, binding, record), null);
  assert.equal(approvalResultUpdateLookup(event, null), null);
  assert.equal(new ApprovalResultUpdateGate().admit(event, binding, { ...record, status: 'failed' }), null);
});

test('event readback must be the signaled authored projection of the exact immutable execution', () => {
  const authored: PendingActionResultRecord = { ...record, publicResult: { version: 1, pendingActionId: record.id, approvalId: record.approvalId, payloadHash: record.payloadHash,
    recordUpdatedAt: record.updatedAt, status: 'executed', source: 'authored_projection', text: 'The approved action completed.',
    terminal: { eventId: 'canonical-terminal', sourceUserSeq: 42 }, projection: { id: event.projectionId, revision: 1, evidenceDigest: 'a'.repeat(64), textDigest: 'b'.repeat(64), publishedAt: record.updatedAt } } };
  assert.equal(approvalResultUpdateMatchesRecord(event, authored), true);
  for (const altered of [{ ...authored, updatedAt: '2026-10-20T01:00:01.000Z' }, { ...authored, status: 'failed' }, record,
    { ...authored, publicResult: { ...authored.publicResult!, projection: { ...authored.publicResult!.projection!, id: 'other-projection' } } }]) {
    assert.equal(approvalResultUpdateMatchesRecord(event, altered), false);
  }
  assert.equal(new ApprovalResultUpdateGate().admit(event, binding, authored), null, 'an already displayed projection needs no new read');
  assert.equal(normalizeApprovalResultUpdatedEvent({ ...event, projectionId: 'bad id' }), null);
});
