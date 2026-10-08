import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatEngine, foldTranscript } from './engine.js';
import type { HarnessEvent } from './types.js';
import type { StreamTransport } from './stream.js';

const sessionId = 'phone-confirmation-fixture';
const approvalId = 'apr-phone-exact';
const question = 'Just to be sure — should I make this controlled change?';
const ownerWords = 'Yes, please do that.';
const event = (seq: number, type: string, data: Record<string, unknown>): HarnessEvent =>
  ({ seq, type, sessionId, turn: 0, role: type === 'user_input_received' ? 'user' : 'Clem', data });
const history = [
  event(1, 'user_input_received', { text: 'Prepare a controlled change' }),
  event(2, 'approval_requested', { approvalId, subject: 'Controlled change' }),
];
// The backend public plane omits private paused-card owner/lease bindings.
const source = event(3, 'user_input_received', { text: ownerWords });
const ask = event(4, 'awaiting_user_input', { sourceUserSeq: 3, reason: 'approval_confirmation_required',
  approvalId, leaning: 'approves', replyText: ownerWords, question, options: ['Yes', 'No'] });
const terminal = (seq = 5, sourceUserSeq = 3, text = question, status = 'needs_input') =>
  event(seq, 'conversation_completed', { sourceUserSeq, reply: text,
    presentation: { identity: { sessionId, sourceUserSeq, turn: 0 }, status,
      kind: status === 'needs_input' ? 'question' : 'answer', text, resumable: status === 'needs_input' } });

function mounted(events: HarnessEvent[] = history) {
  let live: Parameters<StreamTransport['connect']>[0] | undefined;
  const transport: StreamTransport = {
    connect: async options => { live = options; return { close() {} }; },
    fetchRecent: async () => ({ events: [] }),
  };
  const engine = new ChatEngine({ sessionId, transport, observeWhileIdle: true, api: {
    send: async () => ({ sessionId, accepted: true }),
    loadSession: async () => ({ events, latestSeq: Math.max(0, ...events.map(row => row.seq)) }),
  } });
  return { engine, emit: (row: HarnessEvent) => live!.onEvent(row) };
}

test('phone exact confirmation stays once on its card through typed terminal, reopening and replay', async () => {
  const { engine, emit } = mounted();
  try {
    await engine.open();
    await engine.send(ownerWords);
    emit(source);
    emit(ask);
    const asked = engine.snapshot().messages.find(message => message.approval?.approvalId === approvalId);
    assert.equal(asked?.approval?.confirm?.question, question);
    assert.deepEqual(asked?.approval?.confirm?.source, { sessionId, sourceUserSeq: 3, awaitingSeq: 4 });
    assert.equal(engine.snapshot().messages.filter(message => message.role === 'assistant' && message.text === question).length, 0);
    emit(terminal());
    assert.equal(engine.snapshot().busy, false);
    assert.equal(engine.snapshot().cancelKey, null);
    assert.equal(engine.snapshot().messages.filter(message => message.role === 'assistant' && message.text === question).length, 0);
    assert.equal(engine.snapshot().messages.filter(message => message.role === 'user' && message.text === ownerWords).length, 1);
  } finally { engine.dispose(); }

  const persisted = [...history, source, ask, terminal()];
  const reopened = mounted(persisted).engine;
  try {
    await reopened.open();
    assert.equal(reopened.snapshot().busy, false);
    assert.equal(reopened.snapshot().messages.find(message => message.approval)?.approval?.confirm?.replyText, ownerWords);
    assert.equal(reopened.snapshot().messages.filter(message => message.text === question).length, 0);
    assert.equal(reopened.snapshot().messages.filter(message => message.role === 'user' && message.text === ownerWords).length, 1);
    assert.deepEqual(foldTranscript([...persisted, ask, terminal()], sessionId), foldTranscript(persisted, sessionId),
      'replayed question/terminal do not duplicate or change the confirmed card');
  } finally { reopened.dispose(); }
});

test('an old exact confirmation terminal preserves a resolved card and a newer live source', async () => {
  const { engine, emit } = mounted();
  try {
    await engine.open();
    await engine.send(ownerWords);
    emit(source); emit(ask);
    emit(event(6, 'approval_resolved', { approvalId, decision: 'approve' }));
    await engine.send('Another controlled question');
    emit(event(7, 'user_input_received', { text: 'Another controlled question' }));
    emit(event(0, 'stream_token', { sourceUserSeq: 7, delta: 'Newer candidate draft' }));
    const before = engine.snapshot();
    emit(terminal());
    assert.equal(engine.snapshot().busy, true);
    assert.equal(engine.snapshot().activeSourceUserSeq, 7);
    assert.deepEqual(engine.snapshot().messages, before.messages);
    assert.equal(engine.snapshot().messages.find(message => message.approval)?.approval?.resolution, 'approved');
  } finally { engine.dispose(); }
  const resolution = event(6, 'approval_resolved', { approvalId, decision: 'approve' });
  const laterSource = event(7, 'user_input_received', { text: 'Another controlled question' });
  const laterResult = terminal(8, 7, 'Newer canonical result', 'done');
  const rows = foldTranscript([...history, source, ask, resolution, laterSource, laterResult, terminal()], sessionId);
  assert.equal(rows.find(message => message.approval)?.approval?.resolution, 'approved');
  assert.equal(rows.at(-1)?.text, 'Newer canonical result');
  assert.equal(rows.filter(message => message.text === question).length, 0);
});

test('a multi-card inquiry remains a standalone question and keeps both cards unchanged', async () => {
  const second = event(2, 'approval_requested', { approvalId: 'apr-phone-other', subject: 'Other controlled change' });
  const inquiry = event(4, 'awaiting_user_input', { sourceUserSeq: 3, reason: 'approval_choice_required',
    question: 'Which exact card?', options: [`approve ${approvalId}`, 'approve apr-phone-other'] });
  const { engine, emit } = mounted([...history, second]);
  try {
    await engine.open(); await engine.send('Yes.');
    emit(event(3, 'user_input_received', { text: 'Yes.' })); emit(inquiry);
    const response = engine.snapshot().messages.find(message => message.text === 'Which exact card?');
    assert.equal(response?.status, 'awaiting-reply');
    assert.deepEqual(response?.options, [`approve ${approvalId}`, 'approve apr-phone-other']);
    assert.ok(engine.snapshot().messages.filter(message => message.approval).every(message => !message.approval?.confirm && !message.approval?.resolution));
  } finally { engine.dispose(); }
  const rows = foldTranscript([...history, second, source, inquiry, terminal(5, 3, 'Which exact card?')], sessionId);
  assert.equal(rows.filter(message => message.text === 'Which exact card?').length, 1);
  assert.ok(rows.filter(message => message.approval).every(message => !message.approval?.confirm && !message.approval?.resolution));
});

test('confirmation suppression never hides a different question, final result, foreign source or malformed binding', () => {
  for (const changed of [terminal(5, 9), terminal(5, 3, 'A different question'), terminal(5, 3, 'The final result', 'done'),
    { ...terminal(), sessionId: 'other-session' }]) {
    const rows = foldTranscript([...history, source, ask, changed], sessionId);
    assert.ok(rows.some(message => message.role === 'assistant' && message.text === String(changed.data?.reply)));
  }
  for (const changedAsk of [
    { ...ask, sessionId: 'other-session' },
    { ...ask, data: { ...ask.data, sourceUserSeq: 0 } },
    { ...ask, role: 'system' },
    { ...ask, data: { ...ask.data, approvalId: 'apr-missing' } },
  ]) {
    const rows = foldTranscript([...history, source, changedAsk, terminal()], sessionId);
    assert.equal(rows.find(message => message.approval)?.approval?.confirm, undefined);
    assert.ok(rows.some(message => message.text === question), 'an unbound question keeps the ordinary fallback');
  }
});
