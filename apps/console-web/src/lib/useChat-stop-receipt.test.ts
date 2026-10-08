import assert from 'node:assert/strict';
import test from 'node:test';
import { applyChatStopReceipt, applyChatStopping, applyPendingChatStopReceipt, type ChatMessage } from './useChat';
import { terminalCompletionPresentation } from '@clem/chat-engine';

const owner = { assistantId: 'reply', sessionId: 'stop-fixture', sourceUserSeq: 10 };
const running = (): ChatMessage => ({ id: owner.assistantId, role: 'assistant', status: 'thinking', text: '',
  acceptedSource: { sessionId: owner.sessionId, sourceUserSeq: owner.sourceUserSeq, turn: 1 } });
const complete = (message: ChatMessage, status = 'done'): ChatMessage => ({ ...message,
  ...terminalCompletionPresentation({ sourceUserSeq: 10, reply: 'The exact result is saved.',
    presentation: { status, kind: 'answer', resumable: false } }, message.text, message.status) });

test('delayed exact Stop receipts preserve a canonical normal terminal for either acknowledgement', async () => {
  for (const confirmed of [true, false]) {
    let release!: () => void;
    let message = applyChatStopping(running(), owner);
    const receipt = new Promise<void>(resolve => { release = resolve; }).then(() => {
      message = applyChatStopReceipt(message, { confirmed }, owner);
    });
    message = complete(message);
    const terminal = message;
    release(); await receipt;
    assert.equal(message, terminal);
    assert.equal(applyChatStopping(message, owner), terminal, 'Stop cannot reopen an already settled result');
  }
});

test('pending request-key Stop preserves a terminal that wins before acceptance is observed', async () => {
  const pendingOwner = { assistantId: owner.assistantId, sessionId: null };
  for (const confirmed of [true, false]) {
    let release!: () => void;
    let message = applyChatStopping({ id: owner.assistantId, role: 'assistant', status: 'thinking', text: '' }, pendingOwner);
    const receipt = new Promise<void>(resolve => { release = resolve; }).then(() => {
      message = applyPendingChatStopReceipt(message, confirmed, pendingOwner);
    });
    message = complete({ ...message, acceptedSource: running().acceptedSource });
    const terminal = message;
    release(); await receipt;
    assert.equal(message, terminal);
  }
});

test('real in-flight Stop feedback survives, while foreign source/session and bubble receipts do nothing', () => {
  const message = running();
  const stopping = applyChatStopping(message, owner);
  assert.equal(stopping.status, 'thinking');
  assert.equal(stopping.progress, 'Stopping…');
  assert.equal(applyChatStopReceipt(stopping, { confirmed: true }, owner).status, 'stopped');
  const refused = applyPendingChatStopReceipt(stopping, false, owner);
  assert.equal(refused.status, 'failed');
  assert.match(refused.text, /could not record.*Open Run Environment/);
  assert.match(applyChatStopReceipt({ ...stopping, status: 'stopped' }, { confirmed: false }, owner).text,
    /did not confirm.*exact run attempt/);
  for (const foreign of [{ ...owner, sourceUserSeq: 11 }, { ...owner, sessionId: 'other' }, { ...owner, assistantId: 'other' }]) {
    assert.equal(applyChatStopping(message, foreign), message);
    assert.equal(applyChatStopReceipt(message, { confirmed: true }, foreign), message);
    assert.equal(applyPendingChatStopReceipt(message, false, foreign), message);
  }
  assert.deepEqual(message, running(), 'updaters do not mutate the captured message');
});

test('canonical cancellation, uncertainty and legacy settled replies retain their result and evidence', () => {
  for (const status of ['cancelled', 'uncertain', 'blocked', 'failed', 'needs_input']) {
    const terminal = complete(running(), status);
    assert.equal(applyChatStopReceipt(terminal, { confirmed: false }, owner), terminal);
    assert.equal(applyPendingChatStopReceipt(terminal, true, owner), terminal);
  }
  for (const status of ['complete', 'failed', 'awaiting-reply', 'awaiting-plan', 'awaiting-approval'] as const) {
    const terminal = { ...running(), status, text: 'The delivered result.' };
    assert.equal(applyChatStopReceipt(terminal, { confirmed: false }, owner), terminal);
  }
});
