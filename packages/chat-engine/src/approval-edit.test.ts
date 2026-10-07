import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptedApprovalResumeSource, ApprovalDecisionGate, ApprovalReplyObserver, approvalWithCanonicalEdits, editableApprovalField } from './approval-edit.js';

test('a slow edit and competing original approval share one synchronous request latch', async () => {
  const gate = new ApprovalDecisionGate();
  let finish!: () => void;
  const slow = new Promise<void>(resolve => { finish = resolve; });
  const calls: string[] = [];
  const first = gate.run(async () => { calls.push('edited'); await slow; });
  assert.equal(await gate.run(async () => { calls.push('edited again'); }), false);
  assert.equal(await gate.run(async () => { calls.push('original'); }), false);
  assert.deepEqual(calls, ['edited']);
  finish();
  assert.equal(await first, true);
});

test('a rejected edit releases the guard without altering the supplied exact draft', async () => {
  const gate = new ApprovalDecisionGate();
  const fields = { body: 'A long exact draft\n' + '🙂'.repeat(10_000) };
  const before = structuredClone(fields);
  await assert.rejects(gate.run(async () => { throw new Error('The card changed elsewhere.'); }), /changed elsewhere/);
  let submitted: unknown;
  assert.equal(await gate.run(async () => { submitted = fields; }), true);
  assert.deepEqual(submitted, before);
});

test('both devices edit content rather than a longer labeled recipient id', () => {
  const body = { name: 'body', value: 'Hello' };
  const preview = { operation: 'Send fixture', fields: [
    { name: 'recipient', value: 'a-very-long-recipient-identifier', label: 'Fixture owner' }, body,
  ] };
  assert.equal(editableApprovalField(preview), body);
  assert.equal(editableApprovalField({ ...preview, items: [] }), null);
  assert.equal(editableApprovalField({ operation: 'Named target', fields: [preview.fields[0]!] }), null);
  assert.equal(editableApprovalField(undefined), null);
});

test('only a known card typed resume event can establish an assistant-only accepted source', () => {
  const event = { seq: 4, turn: 2, role: 'user', type: 'user_input_received', sessionId: 'fixture',
    data: { synthetic: true, source: 'approval_resume', approvalId: 'apr-fixture', decision: 'approve_with_edits' } };
  assert.deepEqual(acceptedApprovalResumeSource(event, 'fixture', 'apr-fixture'), { sessionId: 'fixture', sourceUserSeq: 4, turn: 2 });
  for (const invalid of [
    { ...event, sessionId: 'other' }, { ...event, role: 'Clem' }, { ...event, seq: 0 }, { ...event, turn: undefined },
    { ...event, data: { ...event.data, source: 'outcome' } }, { ...event, data: { ...event.data, decision: 'unclear' } },
    { ...event, data: { ...event.data, synthetic: false } },
  ]) assert.equal(acceptedApprovalResumeSource(invalid, 'fixture', 'apr-fixture'), undefined);
  assert.equal(acceptedApprovalResumeSource(event, 'fixture', undefined), undefined);
  assert.equal(acceptedApprovalResumeSource(event, 'fixture', 'apr-other'), undefined);
});

test('an edited card watch ignores a newer unrelated turn and stops only at its exact resumed source', () => {
  const observer = new ApprovalReplyObserver('fixture', 'apr-fixture');
  const terminal = { seq: 9, type: 'conversation_completed', data: { sourceUserSeq: 6, reply: 'Unrelated reply' } };
  assert.equal(observer.observe(terminal), false, 'a session alone is not reply ownership');
  assert.equal(observer.observe({ seq: 5, type: 'approval_resolved', data: { approvalId: 'apr-fixture', decision: 'approve_with_edits' } }), true);
  assert.equal(observer.observe({ seq: 4, turn: 2, role: 'user', type: 'user_input_received',
    data: { synthetic: true, source: 'approval_resume', approvalId: 'apr-fixture', decision: 'approve_with_edits' } }), true);
  assert.equal(observer.observe({ seq: 6, turn: 3, role: 'user', type: 'user_input_received', data: { text: 'Newer question' } }), false);
  assert.equal(observer.observe(terminal), false);
  assert.equal(observer.ownsSource(terminal), false, 'a newer terminal must not stop this watch');
  const ownTerminal = { ...terminal, data: { sourceUserSeq: 4, reply: 'Exact edited reply' } };
  assert.equal(observer.observe(ownTerminal), true);
  assert.equal(observer.ownsSource(ownTerminal), true);
  assert.equal(observer.observe({ ...ownTerminal, sessionId: 'another-chat' }), false);
});

test('only canonical edits on exact existing fields update the card and retain their before values', () => {
  const approval = { approvalId: 'apr-fixture', preview: { operation: 'Fixture send', fields: [
    { name: 'recipient', value: 'fixture-id', label: 'Fixture owner' }, { name: 'body', value: 'Before' },
  ] } };
  const exactLongValue = '🙂'.repeat(10_000);
  const data = { approvalId: 'apr-fixture', decision: 'approve_with_edits', edited: true, editedFields: { body: exactLongValue } };
  const edited = approvalWithCanonicalEdits(approval, data);
  assert.equal(edited.preview.fields[1]?.value, exactLongValue);
  assert.equal(edited.preview.fields[0], approval.preview.fields[0]);
  assert.equal(edited.revises?.fields?.[1]?.value, 'Before');
  assert.equal(approval.preview.fields[1]?.value, 'Before');
  assert.equal(approvalWithCanonicalEdits(edited, data), edited, 'a replay cannot overwrite the original before values');
  for (const invalid of [
    { ...data, approvalId: 'apr-other' }, { ...data, edited: false }, { ...data, decision: 'approve' },
    { ...data, editedFields: { body: 'Valid text', unknown: 'Not a card field' } },
    { ...data, editedFields: { body: 7 } }, { ...data, editedFields: { body: 'x'.repeat(20_001) } },
  ]) assert.equal(approvalWithCanonicalEdits(approval, invalid), approval);
});
