import test from 'node:test';
import assert from 'node:assert/strict';
import { composioApprovalDestinationLabel as label, type ApprovalDestinationEvidence } from './approval-destination-label.js';
const user: ApprovalDestinationEvidence = { operation: 'SLACK_FIND_USER_BY_EMAIL_ADDRESS', accountId: 'work', args: { email: 'sam@example.test' },
  result: { data: { ok: true, user: { id: 'U123', real_name: 'Sam Rivera', profile: { email: 'sam@example.test' } } } } };
const dm: ApprovalDestinationEvidence = { operation: 'SLACK_OPEN_DM', accountId: 'work', args: { users: 'U123' },
  result: { data: { ok: true, channel: { id: 'D456' }, already_open: true } } };
const resolve = (evidence: ApprovalDestinationEvidence[], accountId = 'work', value = 'D456') => label({ operation: 'SLACK_SEND_MESSAGE', accountId, value, evidence });
test('joins an exact DM request/result to its verified person without a model', () => {
  assert.equal(resolve([user, dm]), 'DM with Sam Rivera (sam@example.test)');
});
test('does not guess missing, foreign, group or conflicting destinations', () => {
  assert.equal(resolve([user]), undefined);
  assert.equal(resolve([dm]), undefined);
  assert.equal(resolve([user, dm], 'personal'), undefined);
  assert.equal(resolve([user, dm], 'work', 'Dother'), undefined);
  assert.equal(resolve([user, { ...dm, accountId: 'personal' }]), undefined);
  assert.equal(resolve([user, { ...dm, args: { users: 'U123,U999' } }]), undefined);
  assert.equal(resolve([user, { ...dm, args: { channel: 'D456' } }]), undefined);
  assert.equal(resolve([user, dm, { ...dm, args: { users: 'U999' } }]), undefined);
  assert.equal(resolve([user, { ...dm, result: { data: { ok: false, channel: { id: 'D456' } } } }]), undefined);
  assert.equal(resolve([user, dm, { ...user, result: { data: { ok: true, user: { id: 'U123', real_name: 'Other Person' } } } }]), undefined);
});
