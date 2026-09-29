import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSession, openEventLog } from './eventlog.js';
import * as registry from './approval-registry.js';

function fixture() {
  const session = createSession({ id: `approval-group-${randomUUID()}`, kind: 'chat' });
  const members = ['one', 'two'].map(name => registry.register({ sessionId: session.id,
    tool: 'fixture_write', subject: name, args: { recipient: name, body: `exact ${name}` },
    resumeKey: `source:fixture:${session.id}:${name}` }));
  const group = registry.registerApprovalGroup(members, { operation: 'Review actions', fields: [{ name: 'Actions', value: 'one, two' }] });
  return { session, members, group };
}

test('group resolves exact members atomically, exposes one card, and cannot authorize a later action', () => {
  const { session, members, group } = fixture();
  assert.deepEqual(registry.listPending({ sessionId: session.id }).map(row => row.approvalId), [group.approvalId]);
  const later = registry.register({ sessionId: session.id, tool: 'fixture_write', subject: 'later', args: { recipient: 'later' } });
  const observed: string[][] = [];
  registry.onApprovalResolved(row => {
    if (members.some(member => member.approvalId === row.approvalId)) observed.push(members.map(member => registry.get(member.approvalId)!.status));
  });
  assert.equal(registry.resolve(group.approvalId, 'approved', 'owner').ok, true);
  assert.deepEqual(observed, [['resolved', 'resolved'], ['resolved', 'resolved']]);
  assert.ok(members.every(member => registry.get(member.approvalId)?.resolution === 'approved'));
  assert.equal(registry.get(later.approvalId)?.status, 'pending');
  assert.equal(registry.resolve(group.approvalId, 'approved', 'double-click').ok, false);
  assert.equal(observed.length, 2);
});

test('changed payload or independently resolved member invalidates the whole group before any other member changes', () => {
  for (const kind of ['payload', 'resolved']) {
    const { members, group } = fixture();
    if (kind === 'payload') openEventLog().prepare('UPDATE pending_approvals SET args_json=? WHERE approval_id=?')
      .run(JSON.stringify({ recipient: 'different' }), members[1]!.approvalId);
    else openEventLog().prepare("UPDATE pending_approvals SET status='resolved', resolution='rejected' WHERE approval_id=?").run(members[1]!.approvalId);
    assert.equal(registry.resolve(group.approvalId, 'approved', 'owner').reason, 'group_changed');
    assert.equal(registry.get(members[0]!.approvalId)?.status, 'pending');
    assert.equal(registry.get(group.approvalId)?.status, 'pending');
  }
});

test('group acknowledgement rollback leaves every member pending and wakes nobody', () => {
  const { members, group } = fixture(); let wakes = 0;
  registry.onApprovalResolved(row => { if ([group, ...members].some(m => m.approvalId === row.approvalId)) wakes++; });
  assert.throws(() => registry.withApprovalControlCommit(resolve => {
    assert.equal(resolve(group.approvalId, 'approved', 'owner').ok, true);
    throw Error('ack failed');
  }), /ack failed/);
  assert.ok([group, ...members].every(row => registry.get(row.approvalId)?.status === 'pending'));
  assert.equal(wakes, 0);
  assert.equal(registry.resolve(group.approvalId, 'rejected', 'owner').ok, true);
  assert.ok([group, ...members].every(row => registry.get(row.approvalId)?.resolution === 'rejected'));
});

test('group rejects cross-session, duplicate, expired and nested members', () => {
  const a = fixture(); const b = fixture();
  const preview = { operation: 'Review', fields: [] };
  for (const members of [[a.members[0]!, b.members[0]!], [a.members[0]!, a.members[0]!], [a.group, ...a.members]]) {
    assert.throws(() => registry.registerApprovalGroup(members, preview));
  }
  openEventLog().prepare('UPDATE pending_approvals SET expires_at=? WHERE approval_id=?').run('2000-01-01T00:00:00Z', a.group.approvalId);
  assert.equal(registry.resolve(a.group.approvalId, 'approved', 'owner').reason, 'expired');
  assert.ok(a.members.every(member => registry.get(member.approvalId)?.status === 'pending'));
});

test('only the group is reminded and expiry retires parent and members', () => {
  const { session, members, group } = fixture();
  const reminders = registry.listPendingAwaitingReminder(new Date(Date.now() + 1000))
    .filter(row => row.sessionId === session.id);
  assert.deepEqual(reminders.map(row => row.approvalId), [group.approvalId]);
  for (const row of [group, ...members]) openEventLog().prepare('UPDATE pending_approvals SET expires_at=? WHERE approval_id=?')
    .run('2000-01-01T00:00:00Z', row.approvalId);
  registry.expireStaleApprovals();
  assert.ok([group, ...members].every(row => registry.get(row.approvalId)?.resolution === 'expired'));
  assert.equal(registry.listPending({ sessionId: session.id }).length, 0);
});


test('a grouped child cannot be decided separately or included in a second review', () => {
  const { session, members, group } = fixture();
  assert.equal(registry.resolve(members[0]!.approvalId, 'approved', 'stale client').reason, 'grouped_member');
  assert.equal(registry.resolve(members[0]!.approvalId, 'rejected', 'stale client').reason, 'grouped_member');
  const later = registry.register({ sessionId: session.id, tool: 'fixture_write', subject: 'later', args: {}, resumeKey: 'later' });
  const preview = { operation: 'Review', fields: [] };
  assert.throws(() => registry.registerApprovalGroup([members[0]!, later], preview), /already belongs/);
  assert.equal(registry.registerApprovalGroup(members, preview).approvalId, group.approvalId);
  assert.ok(members.every(row => registry.get(row.approvalId)?.status === 'pending'));
});
