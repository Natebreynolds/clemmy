import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-recovery-activation-'));
process.env.CLEMENTINE_HOME = home;
const events = await import('./eventlog.js');
const approvals = await import('./approval-registry.js');
const { HarnessSession } = await import('./session.js');
const { withRecoveryActivation, recoveryActivationOwner, readApprovalRecoveryActivation, assertRecoveryActivationOwned } = await import('./recovery-activation.js');
const { exactCheckpointReentryKey } = await import('./exact-checkpoint-reentry.js');
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });
let ordinal = 0;
function fixture() {
  const id = `recovery-owner-${++ordinal}`;
  events.createSession({ id, kind: 'chat' });
  const request = events.appendEvent({ sessionId: id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Prepare an exact action.' } });
  const card = approvals.register({ sessionId: id, subject: 'exact action', tool: 'fixture_send', args: { target: 'test' } });
  assert.equal(approvals.resolve(card.approvalId, 'approved', 'test').ok, true);
  const control = events.appendEvent({ sessionId: id, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Approved.', approvalId: card.approvalId, decision: 'approve' } });
  const owner = { sourceUserSeq: control.seq, approvalContinuation: {
    requestSourceUserSeq: request.seq, approvalId: card.approvalId, decision: 'approve' as const,
  } };
  // This fixture checks ownership validation only. The production integration
  // pin reopens a real checkpoint and proves exact batch/result authority.
  const blob = JSON.stringify({ __clemHostRecovery: 1, sessionId: id, sourceUserSeq: request.seq });
  const session = HarnessSession.load(id)!;
  withRecoveryActivation(id, owner, () => {
    assert.equal(session.saveRecoveryState(blob, { owner: { sourceUserSeq: request.seq } }).installed, true);
    assert.equal(session.claimContinuationOwner({ sourceUserSeq: request.seq }), true);
  });
  return { id, request, control, card, owner, session, blob };
}

test('approval continuation owns recovery while the business source remains in the checkpoint', () => {
  const f = fixture();
  assert.equal(f.session.recoveryOwnedByActivation({ sourceUserSeq: f.control.seq }), true);
  assert.equal(f.session.recoveryOwnedByActivation({ sourceUserSeq: f.request.seq }), false);
  assert.equal(f.session.continuationOwnerState({ sourceUserSeq: f.control.seq }), 'ours');
  assert.deepEqual(readApprovalRecoveryActivation(f.id), f.owner);
  assert.equal(JSON.parse(f.session.loadRecoveryState()!).sourceUserSeq, f.request.seq);
  withRecoveryActivation(f.id, f.owner, () => {
    assert.deepEqual(recoveryActivationOwner('another-session', { sourceUserSeq: f.request.seq }), { sourceUserSeq: f.request.seq });
    assert.deepEqual(recoveryActivationOwner(f.id, { sourceUserSeq: f.control.seq + 99 }), { sourceUserSeq: f.control.seq + 99 });
  });
  assert.deepEqual(recoveryActivationOwner(f.id, { sourceUserSeq: f.request.seq }), { sourceUserSeq: f.request.seq }, 'scope cannot escape the resumed activation');
});

for (const defect of ['foreign-card', 'foreign-control', 'wrong-decision', 'wrong-business-source', 'malformed-link'] as const) {
  test(`a checkpoint with ${defect} cannot masquerade as a fresh request`, () => {
    const f = fixture();
    const metadata = structuredClone(events.getSession(f.id)!.metadata);
    const owner = metadata.__host_recovery_owner as typeof f.owner;
    if (defect === 'foreign-card') owner.approvalContinuation.approvalId = fixture().card.approvalId;
    if (defect === 'foreign-control') owner.sourceUserSeq = fixture().control.seq;
    if (defect === 'wrong-decision') owner.approvalContinuation.decision = 'reject' as 'approve';
    if (defect === 'wrong-business-source') owner.approvalContinuation.requestSourceUserSeq = f.control.seq;
    if (defect === 'malformed-link') metadata.__host_recovery_owner = { sourceUserSeq: f.control.seq, approvalContinuation: {} };
    events.openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), f.id);
    assert.throws(() => readApprovalRecoveryActivation(f.id), /does not match its durable owner/);
    assert.equal(HarnessSession.load(f.id)!.loadRecoveryState(), f.blob, 'validation cannot discard or rewrite checkpoint evidence');
  });
}

test('boot and in-process recovery debit the same execution-frame reentry budget', () => {
  const frame = { sourceUserSeq: 7, phase: 'finalize', frameCallIds: ['settled-call'] };
  assert.equal(exactCheckpointReentryKey('s', frame), exactCheckpointReentryKey('s', { ...frame, sourceUserSeq: 19, executionSourceUserSeq: 7 }));
  assert.notEqual(exactCheckpointReentryKey('s', frame), exactCheckpointReentryKey('s', { ...frame, sourceUserSeq: 19 }));
});

test('the live recovery guard follows async execution and cannot escape into another task', async () => {
  let owned = true;
  await withRecoveryActivation('guarded', { sourceUserSeq: 1 }, async () => {
    assert.doesNotThrow(assertRecoveryActivationOwned);
    await Promise.resolve();
    owned = false;
    assert.throws(assertRecoveryActivationOwned, /lost owner/);
    await withRecoveryActivation('ordinary', { sourceUserSeq: 2 }, async () => {
      await Promise.resolve();
      assert.doesNotThrow(assertRecoveryActivationOwned);
    });
    assert.throws(assertRecoveryActivationOwned, /lost owner/);
  }, () => { if (!owned) throw new Error('lost owner'); });
  assert.doesNotThrow(assertRecoveryActivationOwned);
});
