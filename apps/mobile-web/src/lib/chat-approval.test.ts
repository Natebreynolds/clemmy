/**
 * Run: node scripts/run-tests-isolated.mjs apps/mobile-web/src/lib/chat-approval.test.ts
 *
 * Owner report 2026-08-27: "In the mobile app I have no way to approve tasks
 * that are needed." The approval branch in the transcript rendered a banner
 * and early-returned with no controls (Chat.tsx), while the plan branch twenty
 * lines below rendered Approve/Reject.
 *
 * The subtle half is the reply TEXT. The server records the synthetic user
 * turn capitalised, and the chat engine de-duplicates its own echo by exact
 * text once the pending marker clears — so a lowercase reply classifies fine
 * and then shows the decision TWICE in the transcript. That is the bug these
 * pins exist to prevent, because it looks like a rendering glitch rather than
 * a string mismatch.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { chatApprovalReply, chatApprovalDecided } = await import('./chat-approval.js');

test('the reply matches the capitalisation the server records', () => {
  // mobile-routes.ts writes: `${decision === 'approve' ? 'Approve' : 'Reject'} ${id}`
  assert.equal(chatApprovalReply('approve', 'apr-70i3'), 'Approve apr-70i3');
  assert.equal(chatApprovalReply('reject', 'apr-70i3'), 'Reject apr-70i3');
});

test('a lowercase reply would desync the echo — pin the exact bytes', () => {
  const reply = chatApprovalReply('approve', 'apr-abc');
  assert.notEqual(reply, 'approve apr-abc',
    'lowercase still classifies (the regex is /i) but no longer matches the '
    + "server's displayText, so the engine appends a SECOND user row");
  assert.equal(reply, 'Approve apr-abc');
});

test('the form still satisfies the server classifier', () => {
  // classifyMobileTypedChatControl: /^(approve|reject)\s+(apr-[A-Za-z0-9-]+)$/i
  const pattern = /^(approve|reject)\s+(apr-[A-Za-z0-9-]+)$/i;
  for (const decision of ['approve', 'reject'] as const) {
    const reply = chatApprovalReply(decision, 'apr-Xy-9')!;
    assert.match(reply, pattern, `${reply} must classify as a host control`);
  }
});

test('an approval with no id cannot be acted on from the transcript', () => {
  for (const missing of [null, undefined, '', '   ']) {
    assert.equal(chatApprovalReply('approve', missing), null,
      'without an id there is nothing to send; the UI must fall back to Home');
  }
});

test('a decided approval hides the buttons', () => {
  const messages = [
    { role: 'assistant', text: 'Waiting on you' },
    { role: 'user', text: 'Approve apr-70i3' },
  ];
  assert.equal(chatApprovalDecided(messages, 'apr-70i3'), true);
});

test('a FAILED send brings the buttons back rather than stranding the user', () => {
  // The decision never reached the server. Treating this as decided would
  // leave an approval that can never be actioned from this screen again.
  const messages = [
    { role: 'user', text: 'Approve apr-70i3', pending: 'failed' },
  ];
  assert.equal(chatApprovalDecided(messages, 'apr-70i3'), false,
    'a failed decision is not a decision');
});

test('a decision on a DIFFERENT approval does not hide these buttons', () => {
  const messages = [{ role: 'user', text: 'Approve apr-other' }];
  assert.equal(chatApprovalDecided(messages, 'apr-70i3'), false);
});

test('an assistant message quoting the phrase is not a decision', () => {
  // The model narrating "Approve apr-70i3" must never count as the user acting.
  const messages = [{ role: 'assistant', text: 'Approve apr-70i3' }];
  assert.equal(chatApprovalDecided(messages, 'apr-70i3'), false,
    'only a USER turn decides');
});

test('no id means never decided, so the fallback copy always shows', () => {
  assert.equal(chatApprovalDecided([{ role: 'user', text: 'Approve ' }], null), false);
});
